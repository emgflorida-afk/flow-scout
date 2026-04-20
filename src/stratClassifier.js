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
//
// Apr 20 2026 updates (AB's rule set):
//   + 2-2 Reversal Up / Down   (two consecutive directional bars, flipped)
//   + 3-2U / 3-2D Broadening   (outside bar then directional)
//   + REVERSAL context flag    (returned separately as .isReversal)
function detect3BarSignalWithTypes(A, B, C, aType, bType, cType) {
  A = normBar(A);
  B = normBar(B);
  C = normBar(C);
  if (!A || !B || !C || !aType || !bType || !cType) return null;

  // 1-1 Compression
  if (bType === '1' && cType === '1') return '1-1 Compression';
  if (cType === '1') return 'Inside';

  // Outside Bar handling — check if this is a 3-2 Broadening setup first
  //   (outside bar followed by directional = vol-expansion continuation)
  //   Priority: 3-2 Broadening > Outside Bar standalone
  if (bType === '3' && cType === '2U') return '3-2U Broadening';
  if (bType === '3' && cType === '2D') return '3-2D Broadening';
  if (cType === '3') return 'Outside Bar';

  // F2U / F2D on C (strongest reversal signals)
  var midC = (C.h + C.l) / 2;
  var tookHighC = C.h > B.h;
  var tookLowC  = C.l < B.l;
  if (tookHighC && !tookLowC && C.c < C.o && C.c < midC) return 'Failed 2U';
  if (tookLowC && !tookHighC && C.c > C.o && C.c > midC) return 'Failed 2D';

  // 2-1-2 reversals/continuations (inside middle bar)
  if (bType === '1') {
    if (aType === '2U' && cType === '2D') return '2-1-2 Down';
    if (aType === '2D' && cType === '2U') return '2-1-2 Up';
    if (aType === '2U' && cType === '2U') return '2-1-2 Continuation';
    if (aType === '2D' && cType === '2D') return '2-1-2 Continuation';
  }

  // 2-2 Reversal / Continuation (two consecutive directional bars, no inside)
  //   B was 2U, C is 2D → reversal down (price rejected at highs)
  //   B was 2D, C is 2U → reversal up (price rejected at lows)
  //   B and C same direction = consecutive 2U or 2D = trending continuation (not novel)
  if (bType === '2U' && cType === '2D') return '2-2 Reversal Down';
  if (bType === '2D' && cType === '2U') return '2-2 Reversal Up';

  // 3-1-2 setups (outside, inside, directional)
  if (aType === '3' && bType === '1') {
    if (cType === '2U') return '3-1-2 Up';
    if (cType === '2D') return '3-1-2 Down';
  }

  // Hammer / Shooter (standalone wick-body ratio)
  var body = Math.abs(C.c - C.o);
  var upperWick = C.h - Math.max(C.c, C.o);
  var lowerWick = Math.min(C.c, C.o) - C.l;
  if (body > 0 && lowerWick >= 2 * body && C.c > C.o) return 'Hammer';
  if (body > 0 && upperWick >= 2 * body && C.c < C.o) return 'Shooter';

  return null;
}

// Context classifier — is this signal a REVERSAL setup (fading extremes)
// vs a CONTINUATION (trending with the tape)?
// Used for display badges and FTFC alignment expectations:
//   REVERSAL signals TYPICALLY work best against-FTFC (fade strength)
//   CONTINUATION signals TYPICALLY work best with-FTFC (ride the tape)
function classifySignalContext(signalName) {
  if (!signalName) return null;
  var reversals = {
    'Failed 2U': true,
    'Failed 2D': true,
    '2-1-2 Up': true,
    '2-1-2 Down': true,
    '2-2 Reversal Up': true,
    '2-2 Reversal Down': true,
    'Hammer': true,
    'Shooter': true,
  };
  var continuations = {
    '2-1-2 Continuation': true,
    '3-1-2 Up': true,
    '3-1-2 Down': true,
    '3-2U Broadening': true,
    '3-2D Broadening': true,
    'Continuation Up': true,
    'Continuation Down': true,
  };
  var compressions = {
    'Inside': true,
    '1-1 Compression': true,
    'Outside Bar': true,
  };
  if (reversals[signalName]) return 'REVERSAL';
  if (continuations[signalName]) return 'CONTINUATION';
  if (compressions[signalName]) return 'COMPRESSION';
  return null;
}

// Gap detection — today's open vs prior close.
// Returns { gapPct, gapDir, gapSize, gapFilled }.
//   gapPct:    decimal (0.025 = +2.5%)
//   gapDir:    'UP' | 'DOWN' | null (null if negligible)
//   gapSize:   'SMALL' (<1%) | 'NORMAL' (1-3%) | 'LARGE' (3-5%) | 'EXTREME' (>5%)
//   gapFilled: true if today's range touched the prior close (common setup trigger)
function computeGap(todayBar, priorBar) {
  if (!todayBar || !priorBar) return null;
  var today = normBar(todayBar);
  var prior = normBar(priorBar);
  if (!today.o || !prior.c) return null;

  var gapPct = (today.o - prior.c) / prior.c;
  var absGap = Math.abs(gapPct);

  var gapDir = null;
  if (absGap >= 0.001) gapDir = gapPct > 0 ? 'UP' : 'DOWN';

  var gapSize;
  if (absGap < 0.01) gapSize = 'SMALL';
  else if (absGap < 0.03) gapSize = 'NORMAL';
  else if (absGap < 0.05) gapSize = 'LARGE';
  else gapSize = 'EXTREME';

  // Gap fill = today's range crossed back to prior close
  var gapFilled = false;
  if (gapDir === 'UP')   gapFilled = today.l <= prior.c;
  if (gapDir === 'DOWN') gapFilled = today.h >= prior.c;

  return {
    gapPct: gapPct,
    gapDir: gapDir,
    gapSize: gapSize,
    gapFilled: gapFilled,
    priorClose: prior.c,
    todayOpen: today.o,
  };
}

// Direction from signal name (CALLS / PUTS / NEUTRAL)
function directionFromSignal(signalName) {
  if (!signalName) return null;
  var bullish = {
    'Failed 2D': true,
    '2-1-2 Up': true,
    '2-2 Reversal Up': true,
    '3-1-2 Up': true,
    '3-2U Broadening': true,
    'Hammer': true,
    'Continuation Up': true,
  };
  var bearish = {
    'Failed 2U': true,
    '2-1-2 Down': true,
    '2-2 Reversal Down': true,
    '3-1-2 Down': true,
    '3-2D Broadening': true,
    'Shooter': true,
    'Continuation Down': true,
  };
  if (bullish[signalName]) return 'CALLS';
  if (bearish[signalName]) return 'PUTS';
  return 'NEUTRAL';  // Inside, 1-1 Compression, Outside Bar, 2-1-2 Continuation
}

module.exports = {
  normBar: normBar,
  classifyBar: classifyBar,
  evalBar: evalBar,
  detect3BarSignal: detect3BarSignal,
  detect3BarSignalWithTypes: detect3BarSignalWithTypes,
  classifySignalContext: classifySignalContext,  // 'REVERSAL' | 'CONTINUATION' | 'COMPRESSION'
  directionFromSignal: directionFromSignal,       // 'CALLS' | 'PUTS' | 'NEUTRAL'
  computeGap: computeGap,                          // { gapPct, gapDir, gapSize, gapFilled }
};
