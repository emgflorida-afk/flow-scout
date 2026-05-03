// =============================================================================
// FLOOR TRADER PIVOTS — universal trader-watched S/R levels
//
// Per Barchart "Day of Action" methodology (John Rowland) — pivots calculated
// from prior day's H/L/C act as the fulcrum between bullish/bearish bias and
// provide 3 layers each of support and resistance. These are watched by every
// algorithmic and floor trader — high-probability inflection zones.
//
// FORMULAS (standard):
//   P  = (H + L + C) / 3
//   R1 = 2P - L     S1 = 2P - H
//   R2 = P + (H-L)  S2 = P - (H-L)
//   R3 = H + 2(P-L) S3 = L - 2(H-P)
//
// USAGE: above pivot = bullish bias / below pivot = bearish bias
// Confluence with structural setups (failed-2D, 3-1-2, etc.) = highest probability.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { /* optional */ }

function round2(v) { return Math.round(v * 100) / 100; }

// Compute classic floor trader pivots from prior bar's H/L/C
function computePivots(priorBar) {
  if (!priorBar || !isFinite(priorBar.High) || !isFinite(priorBar.Low) || !isFinite(priorBar.Close)) return null;
  var H = priorBar.High, L = priorBar.Low, C = priorBar.Close;
  var P = (H + L + C) / 3;
  var range = H - L;
  return {
    P:  round2(P),
    R1: round2(2 * P - L),
    R2: round2(P + range),
    R3: round2(H + 2 * (P - L)),
    S1: round2(2 * P - H),
    S2: round2(P - range),
    S3: round2(L - 2 * (H - P)),
    priorH: round2(H),
    priorL: round2(L),
    priorC: round2(C),
  };
}

// Find which pivot level the current price is closest to + bias label
function nearestPivot(spot, pivots) {
  if (!pivots || !isFinite(spot)) return null;
  var levels = [
    { name: 'R3', price: pivots.R3 },
    { name: 'R2', price: pivots.R2 },
    { name: 'R1', price: pivots.R1 },
    { name: 'P',  price: pivots.P  },
    { name: 'S1', price: pivots.S1 },
    { name: 'S2', price: pivots.S2 },
    { name: 'S3', price: pivots.S3 },
  ];
  var nearest = null, minDist = Infinity;
  levels.forEach(function(l) {
    var d = Math.abs(spot - l.price);
    if (d < minDist) { minDist = d; nearest = l; }
  });
  // Bias: above pivot point = bullish, below = bearish
  var bias = spot > pivots.P ? 'bullish' : spot < pivots.P ? 'bearish' : 'neutral';
  // % distance from nearest as ratio of total day range
  var distPct = pivots.priorH > pivots.priorL
    ? (minDist / (pivots.priorH - pivots.priorL)) * 100
    : 0;
  return {
    nearest: nearest,
    minDist: round2(minDist),
    distPctOfRange: round2(distPct),
    bias: bias,
    aboveLevels: levels.filter(function(l) { return l.price > spot; }).sort(function(a,b) { return a.price - b.price; }),
    belowLevels: levels.filter(function(l) { return l.price < spot; }).sort(function(a,b) { return b.price - a.price; }),
  };
}

// Pull prior day's H/L/C from TS API and compute pivots
async function pivotsFor(ticker, opts) {
  opts = opts || {};
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  try {
    // Pull last 3 daily bars — current (incomplete) + prior + 2-prior for safety
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=Daily&interval=1&barsback=3';
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ok: false, error: 'TS-' + r.status };
    var data = await r.json();
    var raw = (data.Bars || data.bars || []);
    if (raw.length < 2) return { ok: false, error: 'not-enough-bars-' + raw.length };

    var bars = raw.map(function(b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || 0),
        TimeStamp: b.TimeStamp,
      };
    }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });

    if (bars.length < 2) return { ok: false, error: 'invalid-bars' };

    // Use the SECOND-to-last bar (last fully-closed daily)
    // Last bar might be the current still-forming day if market open
    var priorBar = bars[bars.length - 2];
    // If current day already closed (volume present + it's after 4 PM ET), use latest
    // Heuristic: if both bars have volume, use the latest one. We're calling this
    // before market open or weekend — the API gives us the most recent CLOSED bar last.
    var lastBar = bars[bars.length - 1];
    if (lastBar.Volume > 1000) priorBar = lastBar;

    var pivots = computePivots(priorBar);
    if (!pivots) return { ok: false, error: 'pivot-calc-failed' };

    // Get current spot from last bar's close (best available without quote)
    var spot = lastBar.Close;
    var nearest = nearestPivot(spot, pivots);

    return {
      ok: true,
      ticker: ticker,
      spot: round2(spot),
      pivotSourceBar: {
        date: priorBar.TimeStamp,
        H: pivots.priorH,
        L: pivots.priorL,
        C: pivots.priorC,
      },
      pivots: pivots,
      nearest: nearest,
      bias: nearest && nearest.bias,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =============================================================================
// ATR — true range over N periods (default 14). Used for stop offset.
// =============================================================================
function computeATR(bars, period) {
  period = period || 14;
  if (!bars || bars.length < period + 1) return null;
  var trs = [];
  for (var i = 1; i < bars.length; i++) {
    var high = bars[i].High, low = bars[i].Low, prevClose = bars[i-1].Close;
    var tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  // Use the most recent N true ranges
  var recent = trs.slice(-period);
  var sum = recent.reduce(function(a,b) { return a+b; }, 0);
  return round2(sum / period);
}

// Apply 0.25 ATR offset to a stop level (anti-stop-hunt per Wallstreet Trapper)
// For long position: stop is BELOW entry → offset DOWN (away from price)
// For short position: stop is ABOVE entry → offset UP
function offsetStopForHuntProtection(structuralStop, atr, direction) {
  if (!isFinite(structuralStop) || !isFinite(atr) || atr <= 0) return structuralStop;
  var offset = atr * 0.25;
  return direction === 'long' ? round2(structuralStop - offset) : round2(structuralStop + offset);
}

module.exports = {
  computePivots: computePivots,
  nearestPivot: nearestPivot,
  pivotsFor: pivotsFor,
  computeATR: computeATR,
  offsetStopForHuntProtection: offsetStopForHuntProtection,
};
