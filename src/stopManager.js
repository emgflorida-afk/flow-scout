// stopManager.js -- Stratum v7.6
// =================================================================
// ONE MODULE, ALL STOP LOGIC. Replaces smartStop for new scout flow.
//
// Built from Apr 14 audit finding: 63% win rate, losers 1.74x winners.
// 30-day realized -$128 comes entirely from asymmetric loss sizing.
// Structural stops + grade-scaled sizing + post-trim ratcheting trail
// fix the one real leak.
//
// STOP PROFILES
//   fastBurn    (JSmith)          -- 25% flat + 15min time stop
//   structural  (Casey/WP)        -- PDL/PDH/hammer low/shooter high
//   signalBar   (Strat F2U/F2D)   -- opposite side of signal bar
//
// TRIM PROFILES (by option premium at entry)
//   cheap    $1.50-$3    -> 30 / 60 / runner
//   standard $3-$6       -> 20 / 50 / 100
//   fat      >$6         -> 15 / 35 / 75
//
// GRADE-SCALED RISK
//   A+  $250 max risk per trade
//   A   $200
//   B   $150
//   C   rejected
//
// POST-TRIM TRAIL
//   After first trim -> begin structural trail.
//   Stop ratchets to the most recent 5-min swing low (calls) /
//   swing high (puts) on the UNDERLYING as new highs/lows print.
//   Never moves against the position. Only ratchets toward profit.
// =================================================================

var fetch = require('node-fetch');
var TS_BASE = 'https://api.tradestation.com/v3';

// -----------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------
var GRADE_RISK = {
  'A+': 250,
  'A':  200,
  'B':  150,
};

var DELTA_FLOOR = 0.35;
var PREMIUM_FLOOR = 1.50;           // below this = reject unless A+
var PREMIUM_FLOOR_APLUS = 0.75;     // A+ can reach cheaper
var DELTA_CEILING = 0.65;           // above = deep ITM, capital inefficient
var FASTBURN_TIME_STOP_MIN = 15;    // exit if JSmith not +10% in 15 min
var FASTBURN_FLAT_STOP_PCT = 0.25;  // 25% flat stop for JSmith

// -----------------------------------------------------------------
// TRIM PROFILES
// -----------------------------------------------------------------
var TRIM_PROFILES = {
  cheap:    { levels: [30, 60], runner: true, band: [1.50, 3.00] },
  standard: { levels: [20, 50, 100], runner: true, band: [3.00, 6.00] },
  fat:      { levels: [15, 35, 75], runner: true, band: [6.00, Infinity] },
};

function pickTrimProfile(premium) {
  premium = parseFloat(premium) || 0;
  if (premium < 3.00) return TRIM_PROFILES.cheap;
  if (premium < 6.00) return TRIM_PROFILES.standard;
  return TRIM_PROFILES.fat;
}

// -----------------------------------------------------------------
// STOP PROFILE PICKER
// -----------------------------------------------------------------
function pickStopProfile(source) {
  var s = (source || '').toUpperCase();
  if (s.indexOf('JSMITH') === 0) return 'fastBurn';
  if (s.indexOf('CASEY') === 0) return 'structural';
  if (s.indexOf('WP_') === 0 || s.indexOf('WEALTHPRINCE') === 0) return 'structural';
  if (s.indexOf('STRAT_') === 0) return 'signalBar';
  if (s.indexOf('SPREAD_') === 0) return 'spread';
  return 'structural';
}

// -----------------------------------------------------------------
// CALC STOP -- profile-driven
// ctx: { pdh, pdl, pmh, pml, signalBarHigh, signalBarLow, hammerLow, shooterHigh, direction }
// returns { stopPrice (UNDERLYING), reason, type }
// -----------------------------------------------------------------
function calcStop(profile, entry, direction, ctx) {
  entry = parseFloat(entry) || 0;
  direction = (direction || 'CALL').toUpperCase();
  ctx = ctx || {};
  var isCall = direction === 'CALL' || direction === 'CALLS';

  if (profile === 'fastBurn') {
    // Flat 25% on the OPTION premium, not underlying.
    // Caller applies this to premium value, not price.
    return {
      stopPrice: null,
      stopPct: FASTBURN_FLAT_STOP_PCT,
      timeStopMin: FASTBURN_TIME_STOP_MIN,
      reason: 'JSmith fast-burn: 25% flat + ' + FASTBURN_TIME_STOP_MIN + 'min time stop',
      type: 'fastBurn',
    };
  }

  if (profile === 'structural') {
    // Casey / WP: use PDL for CALLs, PDH for PUTs.
    // Or hammer low / shooter high if supplied.
    var level = null;
    var reason = '';
    if (isCall) {
      level = ctx.hammerLow || ctx.pdl || ctx.pml;
      reason = ctx.hammerLow ? 'below 4hr hammer low'
              : ctx.pdl ? 'PDL (prior day low)' : 'PML (pre-market low)';
    } else {
      level = ctx.shooterHigh || ctx.pdh || ctx.pmh;
      reason = ctx.shooterHigh ? 'above 4hr shooter high'
              : ctx.pdh ? 'PDH (prior day high)' : 'PMH (pre-market high)';
    }
    if (level == null) {
      // Structural level unavailable -> fallback to 2% of underlying
      var fallback = isCall ? entry * 0.98 : entry * 1.02;
      return {
        stopPrice: round2(fallback),
        reason: 'Fallback 2% (no structural level)',
        type: 'structural-fallback',
      };
    }
    // Apr 16 2026: Widened cushion from $0.05 to dynamic 0.15%-0.30% of price.
    // Previous $0.05 was getting hunted by algos — stops parked literally at
    // the hunt zone. Dynamic cushion scales with price so a $20 stock gets
    // ~$0.06 cushion and a $400 stock gets ~$1.20. Still reasonable stops
    // but not at the obvious $0.05-below-PDL level where algos sweep.
    //
    // Override: AGGRESSIVE_STOPS=true uses old $0.05 cushion for day trades
    // where tighter stops are required.
    var cushionPct = process.env.AGGRESSIVE_STOPS === 'true' ? 0.0 : 0.003; // 0.3% default
    var dynamicCushion = Math.max(0.15, level * cushionPct); // floor at $0.15
    var cushion = dynamicCushion;
    var stop = isCall ? level - cushion : level + cushion;
    return {
      stopPrice: round2(stop),
      reason: reason + ' - $' + cushion + ' cushion',
      type: 'structural',
    };
  }

  if (profile === 'signalBar') {
    // Strat: opposite side of signal bar
    var lvl = isCall ? ctx.signalBarLow : ctx.signalBarHigh;
    if (lvl == null) {
      var fb = isCall ? entry * 0.985 : entry * 1.015;
      return {
        stopPrice: round2(fb),
        reason: 'Fallback 1.5% (no signal bar)',
        type: 'signalBar-fallback',
      };
    }
    return {
      stopPrice: round2(isCall ? lvl - 0.05 : lvl + 0.05),
      reason: 'Strat signal bar ' + (isCall ? 'low' : 'high'),
      type: 'signalBar',
    };
  }

  // spread or unknown -- flat 2%
  return {
    stopPrice: round2(isCall ? entry * 0.98 : entry * 1.02),
    reason: 'Default 2%',
    type: 'default',
  };
}

// -----------------------------------------------------------------
// VALIDATE ENTRY -- delta/premium floors, grade gate
// -----------------------------------------------------------------
function validateEntry(params) {
  var premium = parseFloat(params.premium) || 0;
  var delta = parseFloat(params.delta) || 0;
  var grade = (params.grade || 'B').toUpperCase();

  if (!GRADE_RISK[grade]) {
    return { accept: false, reason: 'Grade ' + grade + ' below B cutoff' };
  }
  if (delta > 0 && delta < DELTA_FLOOR) {
    return { accept: false, reason: 'Delta ' + delta + ' below floor ' + DELTA_FLOOR + ' (no lottos)' };
  }
  if (delta > DELTA_CEILING) {
    return { accept: false, reason: 'Delta ' + delta + ' above ceiling ' + DELTA_CEILING + ' (too deep ITM)' };
  }
  var floor = grade === 'A+' ? PREMIUM_FLOOR_APLUS : PREMIUM_FLOOR;
  if (premium > 0 && premium < floor) {
    return { accept: false, reason: 'Premium $' + premium + ' below floor $' + floor + ' for grade ' + grade };
  }
  return { accept: true, reason: 'Passed entry gate (grade=' + grade + ' delta=' + delta + ' premium=$' + premium + ')' };
}

// -----------------------------------------------------------------
// SIZE BY GRADE -- risk-based contracts
// Returns contracts such that (premium - stopPremium) * 100 * contracts <= GRADE_RISK[grade]
// If caller doesn't know stopPremium, we estimate via flat profile.
// -----------------------------------------------------------------
function sizeByGrade(params) {
  var grade = (params.grade || 'B').toUpperCase();
  var premium = parseFloat(params.premium) || 0;
  var stopPremium = params.stopPremium;
  if (stopPremium == null || isNaN(stopPremium)) {
    // For fastBurn: 25% of premium
    // For structural: estimate 30% of premium (rough, caller should pass real)
    var pct = params.profile === 'fastBurn' ? FASTBURN_FLAT_STOP_PCT : 0.30;
    stopPremium = premium * (1 - pct);
  }
  var perContractRisk = Math.max(0.05, premium - stopPremium) * 100; // $ per contract
  var maxRisk = GRADE_RISK[grade] || GRADE_RISK['B'];
  var contracts = Math.floor(maxRisk / perContractRisk);
  contracts = Math.max(1, Math.min(5, contracts)); // cap 1-5
  // 1-contract floor rule: skip if premium < $3 and grade < A+
  if (contracts === 1 && premium < 3.00 && grade !== 'A+') {
    return { contracts: 0, reason: '1-contract forced + premium<$3 + grade<A+ -> skip', riskPerContract: perContractRisk };
  }
  return {
    contracts: contracts,
    reason: 'grade=' + grade + ' risk=$' + maxRisk + ' perContract=$' + perContractRisk.toFixed(0),
    riskPerContract: perContractRisk,
    maxRisk: maxRisk,
  };
}

// -----------------------------------------------------------------
// PREPARE ORDER -- master function for scouts to call before queueing
// Input:  {source, ticker, entry, premium, delta, grade, direction, ctx}
// Output: {accept, profile, stop, sizing, trim, reason}
// -----------------------------------------------------------------
function prepareOrder(input) {
  input = input || {};
  var val = validateEntry(input);
  if (!val.accept) return { accept: false, reason: val.reason };

  var profile = pickStopProfile(input.source);
  var stop = calcStop(profile, input.entry, input.direction, input.ctx || {});
  var trim = pickTrimProfile(input.premium);

  // For fastBurn, stopPremium is premium * (1-pct)
  // For structural, we need stopPremium from delta estimate
  var stopPremium;
  if (profile === 'fastBurn') {
    stopPremium = input.premium * (1 - FASTBURN_FLAT_STOP_PCT);
  } else if (stop.stopPrice != null && input.entry && input.delta) {
    // estimate option move: delta * (underlying move)
    var underlyingMove = Math.abs(input.entry - stop.stopPrice);
    var premiumLoss = underlyingMove * input.delta;
    stopPremium = Math.max(0.05, input.premium - premiumLoss);
  } else {
    stopPremium = input.premium * 0.70; // 30% loss fallback
  }

  var sizing = sizeByGrade({
    grade: input.grade,
    premium: input.premium,
    stopPremium: stopPremium,
    profile: profile,
  });

  if (sizing.contracts === 0) {
    return { accept: false, reason: sizing.reason };
  }

  return {
    accept: true,
    profile: profile,
    stop: stop,
    stopPremium: round2(stopPremium),
    sizing: sizing,
    trim: trim,
    reason: val.reason + ' | ' + (stop.reason || '') + ' | ' + sizing.reason,
  };
}

// -----------------------------------------------------------------
// STANDALONE STOP PLACEMENT (for manual fills or post-fill attach)
// -----------------------------------------------------------------
async function attachStopAfterFill(params) {
  // params: {account, symbol, qty, stopPremium, note}
  // Places a standalone StopMarket SELLTOCLOSE at stopPremium.
  // Returns {ok, orderId, error}
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { ok: false, error: 'No TS token' };

    var body = {
      AccountID: params.account,
      Symbol: params.symbol,
      Quantity: String(params.qty),
      OrderType: 'StopMarket',
      StopPrice: String(params.stopPremium),
      TradeAction: 'SELLTOCLOSE',
      TimeInForce: { Duration: 'GTC' },
      Route: 'Intelligent',
    };

    var res = await fetch(TS_BASE + '/orderexecution/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok || data.Errors) {
      return { ok: false, error: (data.Errors && JSON.stringify(data.Errors)) || 'TS error ' + res.status };
    }
    var orderId = (data.Orders && data.Orders[0] && data.Orders[0].OrderID) || null;
    console.log('[STOPMGR] Attached stop for ' + params.symbol + ' @ $' + params.stopPremium + ' id=' + orderId);
    return { ok: true, orderId: orderId, stopPremium: params.stopPremium };
  } catch(e) {
    console.error('[STOPMGR] attach error:', e.message);
    return { ok: false, error: e.message };
  }
}

async function cancelStop(orderId) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { ok: false, error: 'No TS token' };
    var res = await fetch(TS_BASE + '/orderexecution/orders/' + orderId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return { ok: false, error: 'TS error ' + res.status };
    console.log('[STOPMGR] Cancelled stop ' + orderId);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// -----------------------------------------------------------------
// STRUCTURAL TRAIL -- after first trim, ratchet stop to swing low/high
// Called every 5 min for trimmed positions.
// Fetches recent 5m bars for the UNDERLYING, finds most recent swing,
// moves stop up/down (toward profit only, never backward).
// -----------------------------------------------------------------
async function getRecentSwingLevel(ticker, direction, lookbackBars) {
  // Fetch last N 5-min bars for UNDERLYING and find the most recent swing
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;
    var bars = parseInt(lookbackBars || 20, 10);
    var url = TS_BASE + '/marketdata/barcharts/' + ticker +
      '?unit=Minute&interval=5&barsback=' + bars + '&sessiontemplate=USEQPre';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    var data = await res.json();
    var b = data.Bars || [];
    if (b.length < 5) return null;
    var isCall = (direction || 'CALL').toUpperCase().indexOf('C') === 0;
    // Find the most recent swing low (call) or swing high (put):
    // swing low = bar where low < prev bar low AND low < next bar low
    for (var i = b.length - 2; i >= 1; i--) {
      var prev = parseFloat(b[i - 1].Low);
      var cur  = parseFloat(b[i].Low);
      var next = parseFloat(b[i + 1].Low);
      var prevH = parseFloat(b[i - 1].High);
      var curH  = parseFloat(b[i].High);
      var nextH = parseFloat(b[i + 1].High);
      if (isCall && cur < prev && cur < next) {
        return { level: cur, barIdx: i, time: b[i].TimeStamp };
      }
      if (!isCall && curH > prevH && curH > nextH) {
        return { level: curH, barIdx: i, time: b[i].TimeStamp };
      }
    }
    return null;
  } catch(e) {
    console.error('[STOPMGR] swing fetch error:', e.message);
    return null;
  }
}

// In-memory trail state: { [positionKey]: {stopOrderId, currentStopUnderlying, direction, ticker, highWaterMark} }
var trailState = {};

function positionKey(ticker, symbol) {
  return ticker + '|' + symbol;
}

async function beginStructuralTrail(position) {
  // position: {ticker, symbol, direction, qty, entry, stopOrderId, account, delta, premium}
  var key = positionKey(position.ticker, position.symbol);
  trailState[key] = {
    stopOrderId: position.stopOrderId,
    currentStopUnderlying: position.entry, // start at BE on underlying
    direction: position.direction,
    ticker: position.ticker,
    symbol: position.symbol,
    account: position.account,
    qty: position.qty,
    delta: position.delta || 0.45,
    premium: position.premium,
    entry: position.entry,
    highWaterMark: position.entry,
  };
  console.log('[STOPMGR] Trail started for ' + key + ' @ entry $' + position.entry);
  return trailState[key];
}

async function trailStep(ticker, symbol) {
  var key = positionKey(ticker, symbol);
  var st = trailState[key];
  if (!st) return { ok: false, reason: 'No trail state for ' + key };

  // Get current underlying quote
  var ts = require('./tradestation');
  var token = await ts.getAccessToken();
  if (!token) return { ok: false, reason: 'No TS token' };

  var q = await fetch(TS_BASE + '/marketdata/quotes/' + ticker, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!q.ok) return { ok: false, reason: 'Quote fail' };
  var qd = await q.json();
  var last = parseFloat((qd.Quotes && qd.Quotes[0] && qd.Quotes[0].Last) || 0);
  if (!last) return { ok: false, reason: 'No price' };

  var isCall = st.direction.toUpperCase().indexOf('C') === 0;

  // Update high-water mark
  if (isCall && last > st.highWaterMark) st.highWaterMark = last;
  if (!isCall && last < st.highWaterMark) st.highWaterMark = last;

  // Find recent swing
  var swing = await getRecentSwingLevel(ticker, st.direction, 20);
  if (!swing) return { ok: false, reason: 'No swing found' };

  var newStopUnderlying;
  if (isCall) {
    // Only ratchet UP (never below current)
    newStopUnderlying = Math.max(st.currentStopUnderlying, swing.level - 0.05);
  } else {
    // Only ratchet DOWN
    newStopUnderlying = Math.min(st.currentStopUnderlying, swing.level + 0.05);
  }

  if (newStopUnderlying === st.currentStopUnderlying) {
    return { ok: true, changed: false, currentStop: st.currentStopUnderlying };
  }

  // Convert underlying stop -> option premium stop via delta
  var underlyingMove = isCall
    ? (newStopUnderlying - st.entry)
    : (st.entry - newStopUnderlying);
  var premiumAtStop = Math.max(0.05, st.premium + underlyingMove * st.delta);

  // Cancel old stop, place new one
  if (st.stopOrderId) {
    await cancelStop(st.stopOrderId);
  }
  var placed = await attachStopAfterFill({
    account: st.account,
    symbol: st.symbol,
    qty: st.qty,
    stopPremium: round2(premiumAtStop),
    note: 'Trail ratchet',
  });
  if (!placed.ok) return { ok: false, reason: placed.error };

  st.stopOrderId = placed.orderId;
  st.currentStopUnderlying = newStopUnderlying;

  console.log('[STOPMGR] Trail ratchet ' + ticker + ' underlying stop -> $' + newStopUnderlying + ' premium $' + premiumAtStop.toFixed(2));

  return {
    ok: true,
    changed: true,
    underlyingStop: newStopUnderlying,
    premiumStop: round2(premiumAtStop),
    swing: swing,
  };
}

async function trailAll() {
  var results = {};
  var keys = Object.keys(trailState);
  for (var i = 0; i < keys.length; i++) {
    var st = trailState[keys[i]];
    try {
      results[keys[i]] = await trailStep(st.ticker, st.symbol);
    } catch(e) {
      results[keys[i]] = { ok: false, error: e.message };
    }
  }
  return results;
}

// Called by position manager when first trim fills
function onFirstTrim(position) {
  return beginStructuralTrail(position);
}

// Called periodically for fastBurn positions
function timeStopCheck(position, openedAtMs, currentPremiumPct) {
  if (position.profile !== 'fastBurn') return { exit: false };
  var elapsedMin = (Date.now() - openedAtMs) / 60000;
  if (elapsedMin >= FASTBURN_TIME_STOP_MIN && (currentPremiumPct || 0) < 10) {
    return { exit: true, reason: 'Fast-burn stale (' + Math.round(elapsedMin) + 'min, +' + currentPremiumPct + '%)' };
  }
  return { exit: false };
}

// -----------------------------------------------------------------
// UTIL
// -----------------------------------------------------------------
function round2(n) {
  n = parseFloat(n) || 0;
  return Math.round(n * 100) / 100;
}

function getTrailState() {
  return trailState;
}
function clearTrailState(ticker, symbol) {
  if (ticker && symbol) delete trailState[positionKey(ticker, symbol)];
  else trailState = {};
}

module.exports = {
  // Pure logic
  pickStopProfile: pickStopProfile,
  pickTrimProfile: pickTrimProfile,
  calcStop: calcStop,
  validateEntry: validateEntry,
  sizeByGrade: sizeByGrade,
  prepareOrder: prepareOrder,
  // Order placement
  attachStopAfterFill: attachStopAfterFill,
  cancelStop: cancelStop,
  // Trail
  beginStructuralTrail: beginStructuralTrail,
  onFirstTrim: onFirstTrim,
  trailStep: trailStep,
  trailAll: trailAll,
  getRecentSwingLevel: getRecentSwingLevel,
  timeStopCheck: timeStopCheck,
  getTrailState: getTrailState,
  clearTrailState: clearTrailState,
  // Constants for tests/inspection
  GRADE_RISK: GRADE_RISK,
  TRIM_PROFILES: TRIM_PROFILES,
  DELTA_FLOOR: DELTA_FLOOR,
  PREMIUM_FLOOR: PREMIUM_FLOOR,
};
