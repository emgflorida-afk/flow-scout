// =============================================================================
// CANDLE RANGE THEORY (CRT) DETECTOR — closes the "ATH-short looks counter-trend" gap.
//
// THE PROBLEM:
// Chart-vision keeps VETO'ing setups like UNH/JPM Daily SHORT because price is
// "at all-time highs in an uptrend" — but that's exactly when smart money sweeps
// stops then reverses. Without a structural detector for the sweep, vision flags
// real opportunities as counter-trend trash.
//
// THE STRUCTURE (3-candle ICT pattern):
//   Candle 1 (Range):        establishes a high/low band — the prior consolidation
//   Candle 2 (Manipulation): sweeps liquidity above range high (SHORT) or below
//                            range low (LONG) — runs the obvious stops
//   Candle 3 (Distribution): closes BACK INSIDE the range = real direction confirmed
//
// SHORT example (UNH Daily 4/29 → 5/1):
//   4/29: H=370.84  L=365.01  C=370.74   ← RANGE
//   4/30: H=371.99  L=363     C=370.48   ← MANIPULATION (new high)
//   5/1:  H=372.90  L=367.02  C=368.78   ← DISTRIBUTION (newer high, closed inside Wed's body)
//
// USAGE:
//   var crt = require('./candleRangeTheory');
//   var bars = [...]; // OHLCV array, oldest → newest
//   var result = crt.detectCRT(bars, { direction: 'short' });
//   // → { detected: true, structure: {...}, score: 'high'|'medium'|'low', thesis: '...' }
//
// This is wired into confluenceScorer.js as Layer 12 (+2 points) so a confirmed
// CRT can pull a setup out of F-tier even when vision says VETO.
// =============================================================================

function lastN(bars, n) {
  if (!bars || bars.length < n) return null;
  return bars.slice(-n);
}

// Returns the "range top" = max high across the prior 1-2 candles before c2.
// Lets us treat a wider consolidation as the range, not just a single candle.
function rangeTop(bars, c1Idx) {
  var top = bars[c1Idx].H;
  if (c1Idx >= 1 && bars[c1Idx - 1] && typeof bars[c1Idx - 1].H === 'number') {
    top = Math.max(top, bars[c1Idx - 1].H);
  }
  return top;
}

function rangeBottom(bars, c1Idx) {
  var bot = bars[c1Idx].L;
  if (c1Idx >= 1 && bars[c1Idx - 1] && typeof bars[c1Idx - 1].L === 'number') {
    bot = Math.min(bot, bars[c1Idx - 1].L);
  }
  return bot;
}

// SHORT CRT: range → upward sweep → reversal close back into/near range
function detectShortCRT(bars) {
  var trio = lastN(bars, 3);
  if (!trio) return null;

  var c1Idx = bars.length - 3;
  var c1 = trio[0]; // Range
  var c2 = trio[1]; // Manipulation
  var c3 = trio[2]; // Distribution

  if ([c1, c2, c3].some(function(c) {
    return [c.O, c.H, c.L, c.C].some(function(v) { return typeof v !== 'number' || !isFinite(v); });
  })) return null;

  // Use prior 2-bar high as range top (wider context)
  var rTop = rangeTop(bars, c1Idx);
  var c1Range = c1.H - c1.L;
  var c1MidBody = (c1.O + c1.C) / 2;
  // Tolerance for "back inside range": max(0.5% of price, 0.25× c1 range)
  var tol = Math.max(c1.H * 0.005, c1Range * 0.25);

  // GATE 1: c2 sweeps ABOVE the range top
  var sweptAbove = c2.H > rTop;
  if (!sweptAbove) return null;
  var sweepDistance = c2.H - rTop;
  var sweepDistancePctRange = c1Range > 0 ? (sweepDistance / c1Range) * 100 : 0;

  // GATE 2: c3 shows REJECTION of the sweep — at least one of:
  //   (a) c3 is red AND closed below c2's close (faded the sweep)
  //   (b) c3 closed below the range top (came back inside)
  //   (c) c3 made a higher high (compound sweep) AND closed red
  var c3MadeNewHigh = c3.H > c2.H;
  var c3Red = c3.C < c3.O;
  var fadeSweep    = c3Red && c3.C < c2.C;
  var backInside   = c3.C < rTop;
  var compoundFail = c3MadeNewHigh && c3Red;
  var rejection = fadeSweep || backInside || compoundFail;
  if (!rejection) return null;

  // GATE 3: c3.close lands back inside (or within tolerance of) the range top
  var c3WithinRange = c3.C < (rTop + tol);
  if (!c3WithinRange) return null;
  var c3InsideRange = c3.C < rTop && c3.C > c1.L;
  var c3InsideBody  = c3.C < Math.max(c1.O, c1.C) && c3.C > Math.min(c1.O, c1.C);

  // SCORING
  var score = 'low';
  var reasons = [];
  if (sweepDistancePctRange >= 25) { score = 'medium'; reasons.push('strong sweep (' + sweepDistancePctRange.toFixed(0) + '% of c1 range)'); }
  if (compoundFail) { score = 'medium'; reasons.push('compound sweep — c3 made new high then closed red'); }
  if (c3InsideBody) { score = 'high'; reasons.push('c3 closed inside c1 body (full reversal into range)'); }
  if (c3InsideRange && compoundFail) { score = 'high'; reasons.push('aggressive reversal — compound sweep + close back inside range'); }
  if (c3Red) reasons.push('c3 is RED (distribution closed bearish)');
  if (fadeSweep) reasons.push('c3 closed below c2 close (faded the sweep)');

  var invalidation = c3MadeNewHigh ? c3.H : c2.H;
  return {
    detected: true,
    direction: 'short',
    score: score,
    structure: {
      range: { idx: c1.idx, t: c1.t, O: c1.O, H: c1.H, L: c1.L, C: c1.C, rangeTop: rTop },
      manipulation: { idx: c2.idx, t: c2.t, O: c2.O, H: c2.H, L: c2.L, C: c2.C, sweepAbove: sweepDistance.toFixed(2) },
      distribution: { idx: c3.idx, t: c3.t, O: c3.O, H: c3.H, L: c3.L, C: c3.C, compoundSweep: c3MadeNewHigh, closedInsideBody: c3InsideBody, closedInsideRange: c3InsideRange },
    },
    sweepLevel: Math.max(c2.H, c3.H),
    reversalLevel: rTop,
    invalidationLevel: invalidation,
    reasons: reasons,
    thesis:
      'CRT-Short: range top $' + rTop.toFixed(2) + ' swept to $' +
      Math.max(c2.H, c3.H).toFixed(2) + '. Distribution closed at $' + c3.C.toFixed(2) +
      ' — back inside (or within tolerance of) the range. Stops grabbed above, real direction = down. ' +
      'Invalidation: any close > $' + invalidation.toFixed(2) + '.',
  };
}

// LONG CRT: range → downward sweep → close back inside/near range
function detectLongCRT(bars) {
  var trio = lastN(bars, 3);
  if (!trio) return null;

  var c1Idx = bars.length - 3;
  var c1 = trio[0], c2 = trio[1], c3 = trio[2];

  if ([c1, c2, c3].some(function(c) {
    return [c.O, c.H, c.L, c.C].some(function(v) { return typeof v !== 'number' || !isFinite(v); });
  })) return null;

  var rBot = rangeBottom(bars, c1Idx);
  var c1Range = c1.H - c1.L;
  var c1MidBody = (c1.O + c1.C) / 2;
  var tol = Math.max(c1.L * 0.005, c1Range * 0.25);

  var sweptBelow = c2.L < rBot;
  if (!sweptBelow) return null;
  var sweepDistance = rBot - c2.L;
  var sweepDistancePctRange = c1Range > 0 ? (sweepDistance / c1Range) * 100 : 0;

  var c3MadeNewLow = c3.L < c2.L;
  var c3Green = c3.C > c3.O;
  var fadeSweep    = c3Green && c3.C > c2.C;
  var backInside   = c3.C > rBot;
  var compoundFail = c3MadeNewLow && c3Green;
  var rejection = fadeSweep || backInside || compoundFail;
  if (!rejection) return null;

  var c3WithinRange = c3.C > (rBot - tol);
  if (!c3WithinRange) return null;
  var c3InsideRange = c3.C > rBot && c3.C < c1.H;
  var c3InsideBody  = c3.C > Math.min(c1.O, c1.C) && c3.C < Math.max(c1.O, c1.C);

  var score = 'low';
  var reasons = [];
  if (sweepDistancePctRange >= 25) { score = 'medium'; reasons.push('strong sweep (' + sweepDistancePctRange.toFixed(0) + '% of c1 range)'); }
  if (compoundFail) { score = 'medium'; reasons.push('compound sweep — c3 made new low then closed green'); }
  if (c3InsideBody) { score = 'high'; reasons.push('c3 closed inside c1 body (full reversal into range)'); }
  if (c3InsideRange && compoundFail) { score = 'high'; reasons.push('aggressive reversal — compound sweep + close back inside range'); }
  if (c3Green) reasons.push('c3 is GREEN (distribution closed bullish)');
  if (fadeSweep) reasons.push('c3 closed above c2 close (faded the sweep)');

  var invalidation = c3MadeNewLow ? c3.L : c2.L;
  return {
    detected: true,
    direction: 'long',
    score: score,
    structure: {
      range: { idx: c1.idx, t: c1.t, O: c1.O, H: c1.H, L: c1.L, C: c1.C, rangeBottom: rBot },
      manipulation: { idx: c2.idx, t: c2.t, O: c2.O, H: c2.H, L: c2.L, C: c2.C, sweepBelow: sweepDistance.toFixed(2) },
      distribution: { idx: c3.idx, t: c3.t, O: c3.O, H: c3.H, L: c3.L, C: c3.C, compoundSweep: c3MadeNewLow, closedInsideBody: c3InsideBody, closedInsideRange: c3InsideRange },
    },
    sweepLevel: Math.min(c2.L, c3.L),
    reversalLevel: rBot,
    invalidationLevel: invalidation,
    reasons: reasons,
    thesis:
      'CRT-Long: range bottom $' + rBot.toFixed(2) + ' swept to $' +
      Math.min(c2.L, c3.L).toFixed(2) + '. Distribution closed at $' + c3.C.toFixed(2) +
      ' — back inside (or within tolerance of) the range. Stops grabbed below, real direction = up. ' +
      'Invalidation: any close < $' + invalidation.toFixed(2) + '.',
  };
}

// Public — detect either direction (or filter by direction param)
function detectCRT(bars, opts) {
  opts = opts || {};
  var dir = (opts.direction || '').toLowerCase();

  if (dir === 'short') return detectShortCRT(bars);
  if (dir === 'long')  return detectLongCRT(bars);

  // No direction specified — try both, return whichever fires
  var s = detectShortCRT(bars);
  if (s) return s;
  return detectLongCRT(bars);
}

// Pull daily bars from TS and run CRT detection. Same fetch pattern as the
// other layer modules (targetPrice / floorPivots) so the scorer can call this
// without owning bar-fetching itself.
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

async function crtFor(ticker, opts) {
  opts = opts || {};
  var direction = (opts.direction || '').toLowerCase();
  var tf = opts.tf || 'Daily';
  if (tf !== 'Daily') return { ok: false, error: 'CRT detector currently Daily-only' };

  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=Daily&interval=1&barsback=15';
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ok: false, error: 'TS-' + r.status };
    var data = await r.json();
    var raw = (data.Bars || data.bars || []);
    if (raw.length < 3) return { ok: false, error: 'not-enough-bars' };

    var bars = raw.map(function(b, i) {
      return {
        idx: i,
        t: b.TimeStamp,
        O: parseFloat(b.Open),
        H: parseFloat(b.High),
        L: parseFloat(b.Low),
        C: parseFloat(b.Close),
        V: parseFloat(b.TotalVolume || 0),
      };
    }).filter(function(b) { return isFinite(b.H) && isFinite(b.L) && isFinite(b.O) && isFinite(b.C); });

    var result = direction
      ? detectCRT(bars, { direction: direction })
      : (detectShortCRT(bars) || detectLongCRT(bars));

    return {
      ok: true,
      ticker: ticker,
      tf: tf,
      direction: direction || (result ? result.direction : null),
      barCount: bars.length,
      crt: result,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  detectCRT: detectCRT,
  detectShortCRT: detectShortCRT,
  detectLongCRT: detectLongCRT,
  crtFor: crtFor,
};
