// smartStops.js - Stratum Flow Scout v7.2
// Dynamic stop calculation based on structural levels
// Uses pivot, prev day high/low, and delta to calculate
// the correct option stop based on underlying invalidation
// Prevents stop hunts AND protects account from oversized risk

var fetch = require('node-fetch');

var ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || '7355');
var MAX_RISK_PCT  = 0.02; // 2% max risk per trade

function getMaxRisk() { return ACCOUNT_SIZE * MAX_RISK_PCT; }

// -- GET DAILY BARS VIA TRADESTATION ---------------------------
async function getDailyBars(ticker) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker
      + '?interval=1&unit=Daily&barsback=5&sessiontemplate=Default';
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return null;
    var data = await res.json();
    return data && data.Bars ? data.Bars : null;
  } catch(e) { console.error('[STOPS] getDailyBars error:', e.message); return null; }
}

// -- CALCULATE STRUCTURAL LEVELS --------------------------------
function calcLevels(bars) {
  if (!bars || bars.length < 2) return null;

  var prev = bars[bars.length - 2]; // previous day
  var curr = bars[bars.length - 1]; // most recent day

  var prevHigh  = parseFloat(prev.High);
  var prevLow   = parseFloat(prev.Low);
  var prevClose = parseFloat(prev.Close);
  var currClose = parseFloat(curr.Close);

  // Pivot = (High + Low + Close) / 3 of previous day
  var pivot = parseFloat(((prevHigh + prevLow + prevClose) / 3).toFixed(2));

  // R1 and S1 levels for context
  var r1 = parseFloat(((2 * pivot) - prevLow).toFixed(2));
  var s1 = parseFloat(((2 * pivot) - prevHigh).toFixed(2));

  // Bias -- is current price above or below pivot?
  var bias = currClose >= pivot ? 'BULL' : 'BEAR';

  return {
    pivot:     pivot,
    r1:        r1,
    s1:        s1,
    prevHigh:  prevHigh,
    prevLow:   prevLow,
    prevClose: prevClose,
    currClose: currClose,
    bias:      bias,
  };
}

// -- CALCULATE SMART STOP --------------------------------------
// Returns option stop, underlying stop, risk, and contract sizing
function calcSmartStop(type, premium, delta, levels) {
  if (!levels || !premium || !delta) return null;

  var isBull  = type === 'call';
  var absD    = Math.abs(delta);

  // Structural invalidation level
  // For calls: stop if price breaks BELOW prev low
  // For puts:  stop if price breaks ABOVE prev high
  var underlyingStop = isBull ? levels.s1 : levels.r1;
  var structuralStop = isBull ? levels.prevLow : levels.prevHigh;

  // Use the tighter of S1 or prev low for calls (conservative)
  // Use the tighter of R1 or prev high for puts
  if (isBull) {
    underlyingStop = Math.max(underlyingStop, structuralStop);
  } else {
    underlyingStop = Math.min(underlyingStop, structuralStop);
  }

  // Distance from current price to underlying stop
  var distance = Math.abs(levels.currClose - underlyingStop);

  // Option loss if underlying hits stop
  var optionLoss = parseFloat((distance * absD).toFixed(2));

  // Option stop price
  var optionStop = parseFloat((premium - optionLoss).toFixed(2));

  // Make sure stop is above zero
  if (optionStop <= 0.05) optionStop = 0.05;

  // Calculate max contracts that fit within 2% risk
  var maxRisk       = getMaxRisk();
  var riskPerContract = (premium - optionStop) * 100;
  var maxContracts  = riskPerContract > 0 ? Math.floor(maxRisk / riskPerContract) : 0;
  maxContracts      = Math.max(1, Math.min(maxContracts, 4));

  // Dollar risk at max contracts
  var dollarRisk    = parseFloat((maxContracts * riskPerContract).toFixed(2));
  var riskPct       = parseFloat(((dollarRisk / ACCOUNT_SIZE) * 100).toFixed(1));

  // Is setup approved? Risk must be under 2%
  var approved      = riskPct <= 2.0 && maxContracts >= 1;
  var skipReason    = null;

  if (riskPerContract <= 0) {
    approved   = false;
    skipReason = 'Stop too wide -- option already at stop level';
  } else if (riskPerContract * 1 > maxRisk) {
    approved   = false;
    skipReason = 'Stop too wide -- $' + riskPerContract.toFixed(0) + '/contract exceeds $' + maxRisk.toFixed(0) + ' max';
  }

  // Pivot bias check
  var pivotBiasOk = true;
  var pivotWarn   = null;
  if (isBull && levels.bias === 'BEAR') {
    pivotWarn = 'Price BELOW pivot $' + levels.pivot + ' -- calls against bias';
    pivotBiasOk = false;
  } else if (!isBull && levels.bias === 'BULL') {
    pivotWarn = 'Price ABOVE pivot $' + levels.pivot + ' -- puts against bias';
    pivotBiasOk = false;
  }

  return {
    underlyingStop:   parseFloat(underlyingStop.toFixed(2)),
    optionStop:       optionStop,
    optionLoss:       optionLoss,
    distance:         parseFloat(distance.toFixed(2)),
    maxContracts:     maxContracts,
    dollarRisk:       dollarRisk,
    riskPct:          riskPct,
    approved:         approved,
    skipReason:       skipReason,
    pivotBiasOk:      pivotBiasOk,
    pivotWarn:        pivotWarn,
    pivot:            levels.pivot,
    prevHigh:         levels.prevHigh,
    prevLow:          levels.prevLow,
    r1:               levels.r1,
    s1:               levels.s1,
    bias:             levels.bias,
  };
}

// -- MAIN FUNCTION -- called from alerter.js -------------------
async function getSmartStop(ticker, type, premium, delta) {
  try {
    var bars   = await getDailyBars(ticker);
    if (!bars) {
      console.log('[STOPS] No bars for ' + ticker + ' -- using flat stop');
      return null;
    }
    var levels = calcLevels(bars);
    if (!levels) return null;

    var result = calcSmartStop(type, premium, delta, levels);
    console.log('[STOPS] ' + ticker + ' ' + type.toUpperCase()
      + ' | Pivot: $' + levels.pivot
      + ' | Bias: ' + levels.bias
      + ' | UndStop: $' + result.underlyingStop
      + ' | OptStop: $' + result.optionStop
      + ' | Risk: $' + result.dollarRisk + ' (' + result.riskPct + '%)'
      + ' | Contracts: ' + result.maxContracts
      + ' | ' + (result.approved ? 'APPROVED' : 'BLOCKED: ' + result.skipReason)
    );
    return result;
  } catch(e) { console.error('[STOPS] Error:', e.message); return null; }
}

module.exports = { getSmartStop: getSmartStop, calcLevels: calcLevels, getMaxRisk: getMaxRisk };