// =============================================================================
// TARGET PRICE — Newton's-law next-day price extrapolation
//
// Per Barchart "Day of Action" methodology (John Rowland): "an object in
// motion stays in motion with the same speed and in the same direction unless
// acted upon by an unbalanced force." Translated for traders:
//
//   Trend = motion. ATR = speed. Direction = sign of recent change.
//
// Target Price = projected next-day price IF current momentum continues.
//
// USE CASES:
// 1. PRICE TARGET — where to expect price tomorrow (entry/exit zones)
// 2. RISK MANAGEMENT — if today's close DIVERGES from prior target = "unbalanced
//    force" = potential reversal alert
// 3. CONFLUENCE — when target lines up with floor pivots = high-probability
//
// IMPORTANT (per video): valid for DAILY timeframe only. Do NOT use intraday.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

function round2(v) { return Math.round(v * 100) / 100; }

// 3-day momentum extrapolation
// Formula: momentum = (close[t] - close[t-3]) / 3 = avg daily change over 3 days
// Target = close[t] + momentum (projection forward 1 day)
function computeTargetPrice(bars) {
  if (!bars || bars.length < 4) return null;
  var lastIdx = bars.length - 1;
  var c0 = bars[lastIdx].Close;
  var c3 = bars[lastIdx - 3].Close;
  var momentum = (c0 - c3) / 3;
  var target = c0 + momentum;
  // Direction
  var direction = momentum > 0 ? 'up' : momentum < 0 ? 'down' : 'flat';
  // Velocity = abs momentum / ATR ratio (how much of avg daily range we move per day)
  var atr = computeATR(bars, 14);
  var velocity = atr ? Math.abs(momentum) / atr : null;
  return {
    targetPrice: round2(target),
    momentum: round2(momentum),
    momentumPct: c0 > 0 ? round2((momentum / c0) * 100) : null,
    direction: direction,
    velocity: velocity ? round2(velocity) : null,
    velocityLabel: velocity == null ? null
                 : velocity > 1.0 ? 'fast (likely reversal soon)'
                 : velocity > 0.5 ? 'moderate'
                 : velocity > 0.2 ? 'slow'
                 : 'stalling',
    sourceCloses: {
      lastClose: round2(c0),
      threeAgoClose: round2(c3),
    },
  };
}

// 14-period ATR helper (mirrors floorPivots.js)
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
  var recent = trs.slice(-period);
  return round2(recent.reduce(function(a,b) { return a+b; }, 0) / period);
}

// Compute "unbalanced force" — did actual close diverge from prior target?
// If yesterday we predicted today's target = $X and today's actual close = $Y,
// the magnitude of (Y - X) tells us if momentum stalled, reversed, or accelerated.
function detectUnbalancedForce(bars) {
  if (!bars || bars.length < 5) return null;
  var atr = computeATR(bars, 14);
  if (!atr) return null;

  // Predict yesterday's target FROM the data we'd have had at that point
  var historicalBars = bars.slice(0, -1); // exclude today
  var prediction = computeTargetPrice(historicalBars);
  if (!prediction) return null;

  var actualClose = bars[bars.length - 1].Close;
  var predicted = prediction.targetPrice;
  var divergence = actualClose - predicted;
  var divergenceAtr = atr > 0 ? Math.abs(divergence) / atr : 0;

  var verdict;
  if (divergenceAtr < 0.25) verdict = 'on-track'; // momentum continuing
  else if (divergenceAtr < 0.75) verdict = 'mild-divergence'; // slowing
  else if (divergenceAtr < 1.5) verdict = 'moderate-divergence'; // reversal forming
  else verdict = 'major-divergence'; // trend break

  // Sign tells us direction of force
  var force = (divergence > 0 && prediction.direction === 'down') ? 'bullish-reversal'
            : (divergence < 0 && prediction.direction === 'up') ? 'bearish-reversal'
            : (divergence > 0 && prediction.direction === 'up') ? 'bullish-acceleration'
            : (divergence < 0 && prediction.direction === 'down') ? 'bearish-acceleration'
            : 'on-track';

  return {
    verdict: verdict,
    force: force,
    predictedTarget: predicted,
    actualClose: round2(actualClose),
    divergence: round2(divergence),
    divergenceAtrMultiple: round2(divergenceAtr),
    interpretation: verdict === 'on-track' ? 'momentum continuing as expected — trend intact'
                  : verdict === 'mild-divergence' ? 'momentum slowing — watch for stall'
                  : verdict === 'moderate-divergence' ? 'reversal pressure forming — risk-management alert'
                  : 'trend break — major change in conditions, exit positions',
  };
}

// Pull daily bars from TS and compute target price + force detection
async function targetFor(ticker, opts) {
  opts = opts || {};
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  try {
    // Need 20+ daily bars for ATR + momentum
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=Daily&interval=1&barsback=25';
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ok: false, error: 'TS-' + r.status };
    var data = await r.json();
    var raw = (data.Bars || data.bars || []);
    if (raw.length < 5) return { ok: false, error: 'not-enough-bars' };

    var bars = raw.map(function(b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || 0),
        TimeStamp: b.TimeStamp,
      };
    }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });

    var prediction = computeTargetPrice(bars);
    var force = detectUnbalancedForce(bars);
    var atr = computeATR(bars, 14);

    return {
      ok: true,
      ticker: ticker,
      currentClose: round2(bars[bars.length - 1].Close),
      atr14: atr,
      tomorrowTarget: prediction,
      yesterdayPredictionVsToday: force,
      barCount: bars.length,
      newtonsLawNote: 'Object in motion stays in motion. Target = current close + (3-day avg daily change). Daily TF only — do not use intraday.',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  computeTargetPrice: computeTargetPrice,
  detectUnbalancedForce: detectUnbalancedForce,
  computeATR: computeATR,
  targetFor: targetFor,
};
