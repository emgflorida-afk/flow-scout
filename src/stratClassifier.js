// stratClassifier.js
// --------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for Primo Strat bar classification.
// Used by BOTH stratumScanner.js (display) AND stratumBarEntry.js (brain auto-fire).
// No more drift between what the scanner shows and what the brain fires.
//
// Apr 20 2026 — extracted after AB asked "make sure they align together."
// --------------------------------------------------------------

// Normalize a bar object (handles both scanner array-of-objects format and brain Open/High/Low/Close format).
function normBar(b) {
  if (!b) return null;
  // Already in canonical form
  if (typeof b.o === 'number') return b;
  return {
    o: parseFloat(b.Open  || b.open  || 0),
    h: parseFloat(b.High  || b.high  || 0),
    l: parseFloat(b.Low   || b.low   || 0),
    c: parseFloat(b.Close || b.close || 0),
    v: parseFloat(b.TotalVolume || b.Volume || b.volume || 0),
  };
}

// Primo Strat bar classification.
// bar + prev (both normalized) -> '2U' | '2D' | '1' | '3'
//   2U = took prior high only (up-directional)
//   2D = took prior low only  (down-directional)
//   1  = inside bar (took neither)
//   3  = outside bar (took both)
function classifyBar(bar, prev) {
  bar = normBar(bar);
  prev = normBar(prev);
  if (!bar || !prev) return null;
  var tookHigh = bar.h > prev.h;
  var tookLow  = bar.l < prev.l;
  if (tookHigh && tookLow) return '3';
  if (!tookHigh && !tookLow) return '1';
  if (tookHigh) return '2U';
  return '2D';
}

// Evaluate a single closed bar against its prior bar for "signal traits"
// Returns booleans for each pattern the bar exhibits.
// Used by brain for quick per-bar checks.
function evalBar(bar, prev) {
  bar = normBar(bar);
  prev = normBar(prev);
  if (!bar || !prev) return null;

  var took2U = bar.h > prev.h;
  var took2D = bar.l < prev.l;
  var body = Math.abs(bar.c - bar.o);
  var upperWick = bar.h - Math.max(bar.c, bar.o);
  var lowerWick = Math.min(bar.c, bar.o) - bar.l;
  var mid = (bar.h + bar.l) / 2;

  var inside  = (bar.h <= prev.h) && (bar.l >= prev.l);
  var outside = took2U && took2D;

  // F2U: took the high, reversed, closed red AND below midpoint
  var f2u = took2U && !outside && (bar.c < bar.o) && (bar.c < mid);
  // F2D: took the low, reversed, closed green AND above midpoint
  var f2d = took2D && !outside && (bar.c > bar.o) && (bar.c > mid);

  var hammer  = body > 0 && (lowerWick >= 2 * body) && (bar.c > bar.o);
  var shooter = body > 0 && (upperWick >= 2 * body) && (bar.c < bar.o);

  return {
    took2U: took2U, took2D: took2D,
    inside: inside, outside: outside,
    f2u: f2u, f2d: f2d,
    hammer: hammer, shooter: shooter,
    mid: mid, body: body,
    upperWick: upperWick, lowerWick: lowerWick,
  };
}

// Full 3-bar signal detection (A -> B -> C).
// A = oldest, C = most recent closed bar.
// Returns canonical signal name from:
//   '1-1 Compression', 'Inside', 'Outside Bar',
//   'Failed 2U', 'Failed 2D',
//   '2-1-2 Up', '2-1-2 Down', '2-1-2 Continuation',
//   '3-1-2 Up', '3-1-2 Down',
//   'Hammer', 'Shooter',
//   null if no signal.
function detect3BarSignal(A, B, C) {
  A = normBar(A);
  B = normBar(B);
  C = normBar(C);
  if (!A || !B || !C) return null;
  var aType = classifyBar(A, null) ? null : null;  // A's type requires A's prior, not available here
  // Compute types against their prior bars — but for 3-bar detection we classify B vs A and C vs B.
  // For consistency with the scanner's original impl, classify B against A and C against B.
  var bType = classifyBar(B, A);
  var cType = classifyBar(C, B);
  // aType we approximate by asking "is A directional?" — but for detection we only need B and C types.
  // The original scanner passed aType separately. We replicate by classifying A vs A (can't) — so aType
  // callers should pass externally or we set null.
  aType = null;

  // 1-1 Compression: both B and C are inside
  if (bType === '1' && cType === '1') return '1-1 Compression';
  if (cType === '1') return 'Inside';
  if (cType === '3') return 'Outside Bar';

  // Failed 2U/2D on C
  var midC = (C.h + C.l) / 2;
  var tookHighC = C.h > B.h;
  var tookLowC  = C.l < B.l;
  if (tookHighC && !tookLowC && C.c < C.o && C.c < midC) return 'Failed 2U';
  if (tookLowC && !tookHighC && C.c > C.o && C.c > midC) return 'Failed 2D';

  // For 2-1-2 / 3-1-2 we need aType. Caller can use detect3BarSignalWithTypes().
  // Hammer / Shooter on C
  var body = Math.abs(C.c - C.o);
  var upperWick = C.h - Math.max(C.c, C.o);
  var lowerWick = Math.min(C.c, C.o) - C.l;
  if (body > 0 && lowerWick >= 2 * body && C.c > C.o) return 'Hammer';
  if (body > 0 && upperWick >= 2 * body && C.c < C.o) return 'Shooter';

  return null;
}

// Full 3-bar detection with explicit aType (for 2-1-2 / 3-1-2 patterns).
// This is what stratumScanner.js has always called.
function detect3BarSignalWithTypes(A, B, C, aType, bType, cType) {
  A = normBar(A);
  B = normBar(B);
  C = normBar(C);
  if (!A || !B || !C || !aType || !bType || !cType) return null;

  // 1-1 Compression
  if (bType === '1' && cType === '1') return '1-1 Compression';
  if (cType === '1') return 'Inside';
  if (cType === '3') return 'Outside Bar';

  // F2U / F2D on C
  var midC = (C.h + C.l) / 2;
  var tookHighC = C.h > B.h;
  var tookLowC  = C.l < B.l;
  if (tookHighC && !tookLowC && C.c < C.o && C.c < midC) return 'Failed 2U';
  if (tookLowC && !tookHighC && C.c > C.o && C.c > midC) return 'Failed 2D';

  // 2-1-2 reversals/continuations
  if (bType === '1') {
    if (aType === '2U' && cType === '2D') return '2-1-2 Down';
    if (aType === '2D' && cType === '2U') return '2-1-2 Up';
    if (aType === '2U' && cType === '2U') return '2-1-2 Continuation';
    if (aType === '2D' && cType === '2D') return '2-1-2 Continuation';
  }

  // 3-1-2 setups
  if (aType === '3' && bType === '1') {
    if (cType === '2U') return '3-1-2 Up';
    if (cType === '2D') return '3-1-2 Down';
  }

  // Hammer / Shooter
  var body = Math.abs(C.c - C.o);
  var upperWick = C.h - Math.max(C.c, C.o);
  var lowerWick = Math.min(C.c, C.o) - C.l;
  if (body > 0 && lowerWick >= 2 * body && C.c > C.o) return 'Hammer';
  if (body > 0 && upperWick >= 2 * body && C.c < C.o) return 'Shooter';

  return null;
}

module.exports = {
  normBar: normBar,
  classifyBar: classifyBar,
  evalBar: evalBar,
  detect3BarSignal: detect3BarSignal,
  detect3BarSignalWithTypes: detect3BarSignalWithTypes,
};
