// =============================================================================
// LVL COMPUTER (Apr 29 2026)
//
// Pure server-side translation of the 25sense / LVL Framework math from
// StratumLVLAssist.pine v4.0. Given two consecutive HTF bars (Bar A = prior,
// Bar B = current) plus a current spot price, returns the same signal state
// the Pine indicator would render on the chart.
//
// Use this to scan the universe for live LVL setups across multiple TFs
// without needing to load each ticker's chart.
//
// Public API:
//   computeLvlState(prior, current, spot)
//   fetchBars(symbol, tfKey, token)
//   computeForTimeframe(symbol, tfKey, token)
//   computeMultiTF(symbol, tfKeys, token)
// =============================================================================

var TS_BASE = process.env.TS_BASE || 'https://api.tradestation.com/v3';

// Timeframe spec map - tfKey -> TS API barchart query params
var TF_SPECS = {
  'Daily': { unit: 'Daily',  interval: 1,  barsback: 3, sessiontemplate: null },
  '1H':    { unit: 'Minute', interval: 60, barsback: 4, sessiontemplate: 'Default' },
  '30m':   { unit: 'Minute', interval: 30, barsback: 6, sessiontemplate: 'Default' },
  '5m':    { unit: 'Minute', interval: 5,  barsback: 12, sessiontemplate: 'Default' },
};

// =============================================================================
// PURE MATH - mirrors StratumLVLAssist.pine 25sense logic
// =============================================================================
function computeLvlState(prior, current, spot) {
  if (!prior || !current || !isFinite(spot)) {
    return { ok: false, reason: 'missing-bars-or-spot' };
  }
  var A_h = prior.High,  A_l = prior.Low,  A_o = prior.Open, A_c = prior.Close;
  var B_h = current.High, B_l = current.Low, B_o = current.Open, B_c = current.Close;
  var range = A_h - A_l;
  if (range <= 0) return { ok: false, reason: 'flat-prior-bar' };

  var levels = {
    priorH: round2(A_h),
    priorL: round2(A_l),
    lvl875: round2(A_l + range * 0.875),
    lvl75:  round2(A_l + range * 0.75),
    lvl50:  round2(A_l + range * 0.50),
    lvl25:  round2(A_l + range * 0.25),
    lvl125: round2(A_l + range * 0.125),
  };

  var sweptLow  = B_l < A_l;
  var sweptHigh = B_h > A_h;
  var sweptBoth = sweptLow && sweptHigh;
  var hasLong   = (sweptLow  && !sweptHigh) || (sweptBoth && B_c > B_o);
  var hasShort  = (sweptHigh && !sweptLow ) || (sweptBoth && B_c < B_o);

  // Raw signal based on spot location
  var raw = 'NONE';
  if (hasLong  && spot >= levels.lvl25  && spot < levels.lvl50)  raw = 'LVL_LONG_25';
  else if (hasLong  && spot >= levels.lvl125 && spot < levels.lvl25) raw = 'EARLY_LONG';
  else if (hasShort && spot <= levels.lvl75  && spot > levels.lvl50)  raw = 'LVL_SHORT_75';
  else if (hasShort && spot <= levels.lvl875 && spot > levels.lvl75)  raw = 'EARLY_SHORT';
  else if (spot > A_h) raw = 'HIGH_BREAK';
  else if (spot < A_l) raw = 'LOW_BREAK';

  // Hit tracking - for the CURRENT bar only (B_h, B_l determine if TP1 or stop fired during the bar)
  var trigger = hasLong  ? levels.lvl25
              : hasShort ? levels.lvl75
              : null;
  var stopLevel = hasLong  ? levels.lvl125
              :   hasShort ? levels.lvl875
              :   null;

  var tp1Hit = false, stopHit = false;
  if (hasLong && trigger != null && stopLevel != null) {
    if (B_h >= levels.lvl50)   tp1Hit  = true;
    if (B_l <= stopLevel)      stopHit = true;
  } else if (hasShort && trigger != null && stopLevel != null) {
    if (B_l <= levels.lvl50)   tp1Hit  = true;
    if (B_h >= stopLevel)      stopHit = true;
  }

  // Final signal: hit-tracking overrides raw location signal
  var signal = stopHit ? 'STOP_HIT'
             : tp1Hit  ? 'TP1_HIT'
             : raw;

  // Plan
  var direction = hasLong  ? 'LONG'
                : hasShort ? 'SHORT'
                : 'NONE';

  var plan = {
    entry: hasLong  ? levels.lvl25  : hasShort ? levels.lvl75  : null,
    stop:  hasLong  ? levels.lvl125 : hasShort ? levels.lvl875 : null,
    tp1:   levels.lvl50,
    tp2:   hasLong  ? levels.priorH : hasShort ? levels.priorL : null,
  };

  return {
    ok: true,
    signal:    signal,
    rawSignal: raw,
    direction: direction,
    isLong:    hasLong,
    isShort:   hasShort,
    levels:    levels,
    plan:      plan,
    flags: {
      sweptLow:  sweptLow,
      sweptHigh: sweptHigh,
      sweptBoth: sweptBoth,
      tp1Hit:    tp1Hit,
      stopHit:   stopHit,
    },
    spot: round2(spot),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

// =============================================================================
// BAR FETCHING
// =============================================================================
async function fetchBars(symbol, tfKey, token) {
  var spec = TF_SPECS[tfKey];
  if (!spec) throw new Error('unknown-timeframe ' + tfKey);
  var url = TS_BASE + '/marketdata/barcharts/' + encodeURIComponent(symbol)
    + '?unit=' + spec.unit
    + '&interval=' + spec.interval
    + '&barsback=' + spec.barsback;
  if (spec.sessiontemplate) url += '&sessiontemplate=' + spec.sessiontemplate;

  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var headers = { 'Authorization': 'Bearer ' + token };
  var r = await fetchLib(url, { headers: headers });
  if (!r.ok) throw new Error('TS-bars-' + r.status + '-' + symbol);
  var data = await r.json();
  var bars = (data && (data.Bars || data.bars)) || [];
  // Normalize: ensure numeric H/L/O/C
  return bars.map(function(b) {
    return {
      High:  parseFloat(b.High),
      Low:   parseFloat(b.Low),
      Open:  parseFloat(b.Open),
      Close: parseFloat(b.Close),
      TimeStamp: b.TimeStamp,
    };
  }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });
}

// =============================================================================
// COMPUTE FOR ONE SYMBOL + TIMEFRAME
// =============================================================================
async function computeForTimeframe(symbol, tfKey, token, opts) {
  opts = opts || {};
  var bars = await fetchBars(symbol, tfKey, token);
  if (bars.length < 2) {
    return { ok: false, reason: 'not-enough-bars', tf: tfKey, symbol: symbol };
  }
  // Last bar = CURRENT (in-progress); second-to-last = PRIOR
  var current = bars[bars.length - 1];
  var prior   = bars[bars.length - 2];
  // Spot: prefer caller-provided live spot, else use current bar's close
  var spot = isFinite(opts.spot) ? opts.spot : current.Close;
  var state = computeLvlState(prior, current, spot);
  return Object.assign({ tf: tfKey, symbol: symbol }, state);
}

// =============================================================================
// COMPUTE ACROSS MULTIPLE TIMEFRAMES (e.g., D + 1H)
// =============================================================================
async function computeMultiTF(symbol, tfKeys, token, opts) {
  opts = opts || {};
  var tasks = tfKeys.map(function(tf) {
    return computeForTimeframe(symbol, tf, token, opts).catch(function(e) {
      return { ok: false, tf: tf, symbol: symbol, error: e.message };
    });
  });
  var results = await Promise.all(tasks);
  // Index by tf for easy access
  var byTf = {};
  results.forEach(function(r) { byTf[r.tf] = r; });
  return {
    symbol: symbol,
    tfs:    byTf,
  };
}

module.exports = {
  computeLvlState:    computeLvlState,
  computeForTimeframe: computeForTimeframe,
  computeMultiTF:     computeMultiTF,
  fetchBars:          fetchBars,
  TF_SPECS:           TF_SPECS,
};
