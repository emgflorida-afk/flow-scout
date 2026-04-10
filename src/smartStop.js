// smartStop.js -- Stratum v7.4
// DYNAMIC STOP SYSTEM
// API Priority:
// 1. TradeStation -- prev day OHLC via get-bars (token now fixed)
// 2. Public.com   -- real-time price fallback
// 3. Flat 40%     -- if both APIs fail
//
// Stop types by ticker classification:
// WIDE RANGE  (NVDA, TSLA, COIN) = STRUCTURAL stop (prev day low/high)
// TIGHT RANGE (DLTR, WMT, XLF)  = FLAT 40% stop
// INDEX       (SPY, QQQ, IWM)   = PIVOT stop
// HYBRID      (everything else) = blend structural + flat

var fetch = require('node-fetch');

var PUBLIC_KEY = process.env.PUBLIC_API_KEY;
var TS_BASE    = 'https://api.tradestation.com/v3';

// ================================================================
// TICKER CLASSIFICATION
// ================================================================
var INDICES = ['SPY', 'QQQ', 'IWM', 'DIA', 'VXX', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'TNA', 'TZA'];

// PRIMARY WATCHLIST -- always use STRUCTURAL stops
// These are your 10 core tickers -- give them room to breathe
var WIDE_RANGE = [
  // Your core watchlist
  'NVDA', 'AAPL', 'AMZN', 'MSFT', 'GOOGL',
  'JPM', 'GS', 'TSLA', 'COIN', 'MRVL',
  // Extended high-vol names
  'TSLA', 'MSTR', 'AMD', 'META', 'NFLX', 'SMCI',
  'PLTR', 'CRWD', 'SNOW', 'SHOP', 'AVGO',
  'LMT', 'RTX', 'NOC', 'GD', 'LDOS', 'DAL', 'UAL', 'LUV',
  // Indices -- always structural
  'SPY', 'QQQ', 'IWM', 'SQQQ', 'TQQQ', 'SPXL', 'SPXS', 'TNA',
];

// TIGHT_RANGE -- slow movers only, never your core watchlist
// Even these now get hybrid structural stops instead of flat 40%
var TIGHT_RANGE = [
  'DLTR', 'DG', 'WMT', 'TGT', 'KO', 'PEP', 'JNJ', 'PG', 'MCD',
  'VZ', 'T', 'SO', 'DUK', 'NEE', 'D',
  'LLY', 'ABBV', 'MRK', 'PFE', 'BMY',
];

function classifyTicker(ticker, adx, atrPct) {
  var t = ticker.toUpperCase();
  if (INDICES.includes(t))     return 'INDEX';
  if (WIDE_RANGE.includes(t))  return 'WIDE';
  if (TIGHT_RANGE.includes(t)) return 'TIGHT';
  if (adx && atrPct) {
    if (adx > 30 && atrPct > 2.0) return 'WIDE';
    if (adx < 20 && atrPct < 1.5) return 'TIGHT';
  }
  return 'HYBRID';
}

// ================================================================
// STEP 1 -- TradeStation prev day OHLC (Priority #1)
// ================================================================
async function getTSBars(ticker) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;

    var url = TS_BASE + '/marketdata/barcharts/' + ticker +
      '?unit=Daily&interval=1&barsback=5&sessiontemplate=Default';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      console.log('[SMARTSTOP] TS bars failed:', res.status);
      return null;
    }
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return null;

    // Use yesterday's bar (bars sorted oldest to newest)
    var yesterday = bars[bars.length - 2];
    var today     = bars[bars.length - 1];

    console.log('[SMARTSTOP] TS bars OK -- ' + ticker +
      ' prevHigh=$' + yesterday.High + ' prevLow=$' + yesterday.Low);

    return {
      high:  parseFloat(yesterday.High  || 0),
      low:   parseFloat(yesterday.Low   || 0),
      open:  parseFloat(yesterday.Open  || 0),
      close: parseFloat(yesterday.Close || 0),
      todayHigh: parseFloat(today.High  || 0),
      todayLow:  parseFloat(today.Low   || 0),
      todayOpen: parseFloat(today.Open  || 0),
      source: 'TradeStation',
    };
  } catch(e) {
    console.log('[SMARTSTOP] TS bars error:', e.message);
    return null;
  }
}

// ================================================================
// STEP 2 -- Public.com real-time price (Priority #2 fallback)
// ================================================================
async function getPublicToken() {
  try {
    var res = await fetch('https://api.public.com/auth/access-tokens', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + PUBLIC_KEY },
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data.access_token || null;
  } catch(e) { return null; }
}

async function getPublicQuote(ticker) {
  try {
    var token = await getPublicToken();
    if (!token) return null;
    var accountId = process.env.PUBLIC_ACCOUNT_ID || '5OF64813';
    var res = await fetch(
      'https://api.public.com/userapigateway/market-data/' + accountId + '/quotes?symbols=' + ticker,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) return null;
    var data = await res.json();
    var q = data.quotes && data.quotes[0];
    if (!q) return null;
    return {
      price: parseFloat(q.lastPrice || q.last || 0),
      high:  parseFloat(q.high  || 0),
      low:   parseFloat(q.low   || 0),
      open:  parseFloat(q.open  || 0),
      source: 'Public.com',
    };
  } catch(e) { return null; }
}

// ================================================================
// STEP 3 -- Calculate stop based on category
// ================================================================
function calcStop(category, type, premium, delta, price, prevHigh, prevLow) {
  var pivot = ((prevHigh + prevLow + price) / 3);

  if (category === 'INDEX') {
    var structLevel = type === 'call' ? Math.min(pivot, prevLow) : Math.max(pivot, prevHigh);
    var distance    = Math.abs(price - structLevel);
    var optStop     = Math.max(premium - (distance * delta), premium * 0.25);
    optStop         = Math.min(optStop, premium * 0.65);
    return {
      stopType: 'PIVOT', structuralLevel: pivot.toFixed(2),
      underlyingStop: structLevel.toFixed(2), optionStop: optStop.toFixed(2),
      stopPrice: optStop.toFixed(2), distance: distance.toFixed(2),
      label: 'pivot $' + pivot.toFixed(2),
      why: 'INDEX -- pivot level',
    };
  }

  if (category === 'WIDE') {
    var structLevel = type === 'call' ? prevLow : prevHigh;
    var distance    = Math.abs(price - structLevel);
    var optStop     = Math.max(premium - (distance * delta), premium * 0.20);
    optStop         = Math.min(optStop, premium * 0.55);
    return {
      stopType: 'STRUCTURAL', structuralLevel: structLevel.toFixed(2),
      underlyingStop: structLevel.toFixed(2), optionStop: optStop.toFixed(2),
      stopPrice: optStop.toFixed(2), distance: distance.toFixed(2),
      label: type === 'call' ? 'prev low $' + prevLow.toFixed(2) : 'prev high $' + prevHigh.toFixed(2),
      why: 'WIDE RANGE -- structural gives room',
    };
  }

  if (category === 'TIGHT') {
    // DYNAMIC: Use structural level if available -- flat 40% gets stopped out too early
    if (prevHigh && prevLow && price) {
      var structLevel  = type === 'put' ? prevHigh : prevLow;
      var structDist   = Math.abs(price - structLevel);
      var structPct    = structDist / price;
      var hybridStop   = parseFloat(Math.max(premium * 0.50, premium - (structPct * premium * 2)).toFixed(2));
      hybridStop = Math.min(hybridStop, parseFloat((premium * 0.65).toFixed(2)));
      return {
        stopType: 'HYBRID', structuralLevel: structLevel.toFixed(2),
        underlyingStop: structLevel.toFixed(2),
        optionStop: hybridStop.toFixed(2), stopPrice: hybridStop.toFixed(2),
        distance: structDist.toFixed(2),
        label: 'hybrid -- tight range with structure (prev ' + (type === 'put' ? 'high' : 'low') + ' $' + structLevel.toFixed(2) + ')',
        why: 'TIGHT RANGE -- structural preferred, respects price structure',
        source: 'TradeStation',
      };
    }
    // Fallback flat stop if no structure data
    var optStop = premium * 0.60;
    return {
      stopType: 'FLAT', structuralLevel: null, underlyingStop: null,
      optionStop: optStop.toFixed(2), stopPrice: optStop.toFixed(2), distance: null,
      label: 'flat 40% -- tight range fallback', why: 'TIGHT RANGE -- no structure data available',
    };
  }

  // HYBRID
  var structLevel = type === 'call' ? prevLow : prevHigh;
  var distance    = Math.abs(price - structLevel);
  var structStop  = Math.max(premium - (distance * delta), premium * 0.25);
  var flatStop    = premium * 0.60;
  var optStop     = Math.min((structStop * 0.60) + (flatStop * 0.40), premium * 0.65);
  optStop         = Math.max(optStop, premium * 0.25);
  return {
    stopType: 'HYBRID', structuralLevel: structLevel.toFixed(2),
    underlyingStop: structLevel.toFixed(2), optionStop: optStop.toFixed(2),
    stopPrice: optStop.toFixed(2), distance: distance.toFixed(2),
    label: 'hybrid -- ' + (type === 'call' ? 'prev low $' + prevLow.toFixed(2) : 'prev high $' + prevHigh.toFixed(2)),
    why: 'MIXED -- blend structural + flat',
  };
}

// ================================================================
// MAIN -- getSmartStop
// ================================================================
async function getSmartStop(ticker, type, premium, delta, adx, atrPct) {
  console.log('[SMARTSTOP] ' + ticker + ' ' + type + ' premium=$' + premium);

  delta  = delta  || 0.40;
  adx    = adx    || null;
  atrPct = atrPct || null;

  var category = classifyTicker(ticker, adx, atrPct);
  console.log('[SMARTSTOP] ' + ticker + ' classified: ' + category);

  // Priority 1 -- TradeStation bars
  var bars = await getTSBars(ticker);

  // Priority 2 -- Public.com fallback
  var quote = await getPublicQuote(ticker);
  var price = quote ? quote.price : (bars ? bars.close : premium * 40);

  if (!bars) {
    // Use Public.com today high/low as fallback
    if (quote && quote.high && quote.low) {
      bars = { high: quote.high, low: quote.low, close: quote.price, source: 'Public.com (today)' };
    }
  }

  if (!bars || !price) {
    var flatStop = (premium * 0.60).toFixed(2);
    var flatLoss = ((premium - parseFloat(flatStop)) * 100).toFixed(0);
    console.log('[SMARTSTOP] No data -- flat 40% fallback');
    return {
      stopType: 'FLAT', optionStop: flatStop, stopPrice: flatStop,
      stopLoss: flatLoss, maxLoss: flatLoss, structuralLevel: null,
      underlyingStop: null, prevHigh: null, prevLow: null, pivot: null,
      bias: type === 'call' ? 'BULL' : 'BEAR', distance: null,
      label: 'flat 40% (no data)', why: 'API unavailable', category: 'FLAT',
    };
  }

  var result   = calcStop(category, type, premium, delta, price, bars.high, bars.low);
  var pivot    = ((bars.high + bars.low + price) / 3);
  result.prevHigh  = bars.high.toFixed(2);
  result.prevLow   = bars.low.toFixed(2);
  result.pivot     = pivot.toFixed(2);
  result.bias      = type === 'call' ? 'BULL' : 'BEAR';
  result.maxLoss   = ((premium - parseFloat(result.optionStop)) * 100).toFixed(0);
  result.stopLoss  = result.maxLoss;
  result.category  = category;
  result.source    = bars.source || 'TradeStation';

  console.log('[SMARTSTOP] ' + category + ' stop=$' + result.optionStop +
    ' (' + result.label + ') source=' + result.source);

  return result;
}

// ================================================================
// CASEY METHOD STOP -- Structure-based, NOT flat %
// Uses the retest level from confluence scorer as invalidation
// Stop goes below structure, not flat -25% on premium
// ================================================================
function calcCaseyStop(params) {
  // params:
  // {
  //   ticker: 'SPY',
  //   type: 'call' or 'put',
  //   premium: 2.50,          // option premium at entry
  //   delta: 0.45,            // option delta
  //   entryPrice: 549.30,     // underlying price at entry
  //   retestLevel: 549.25,    // the structural level being retested
  //   invalidationPrice: 548.80, // price where structure breaks
  //   atr: 0.35,              // 2-min ATR for buffer
  // }

  var type = params.type || 'call';
  var premium = params.premium || 1.00;
  var delta = params.delta || 0.40;
  var entryPrice = params.entryPrice || 0;
  var retestLevel = params.retestLevel || null;
  var invalidation = params.invalidationPrice || null;
  var atr = params.atr || 0.50;

  // If no structure data, fall back to smart stop
  if (!retestLevel || !invalidation || !entryPrice) {
    console.log('[SMARTSTOP] No Casey structure data -- using legacy stop');
    return null; // caller should fall back to getSmartStop()
  }

  // Buffer: half ATR below invalidation (absorbs wicks)
  var buffer = atr * 0.5;
  var underlyingStop = type === 'call'
    ? invalidation - buffer
    : invalidation + buffer;

  // Distance from entry to stop on the underlying
  var distance = Math.abs(entryPrice - underlyingStop);

  // Translate to option premium loss
  var optionLoss = distance * delta;
  var optionStop = premium - optionLoss;

  // FLOOR: never lose more than 40% on any trade
  optionStop = Math.max(optionStop, premium * 0.60);

  // CEILING: stop must be at least 10% below entry (give SOME room)
  optionStop = Math.min(optionStop, premium * 0.90);

  var stopPct = ((premium - optionStop) / premium * 100).toFixed(1);
  var maxLoss = ((premium - optionStop) * 100).toFixed(0);

  console.log('[SMARTSTOP] CASEY stop: underlying=$' + underlyingStop.toFixed(2) +
    ' option=$' + optionStop.toFixed(2) + ' (' + stopPct + '% risk)' +
    ' retest=$' + retestLevel.toFixed(2) + ' invalidation=$' + invalidation.toFixed(2));

  return {
    stopType: 'CASEY_STRUCTURE',
    structuralLevel: retestLevel.toFixed(2),
    invalidationLevel: invalidation.toFixed(2),
    underlyingStop: underlyingStop.toFixed(2),
    optionStop: optionStop.toFixed(2),
    stopPrice: optionStop.toFixed(2),
    distance: distance.toFixed(2),
    stopPct: stopPct,
    maxLoss: maxLoss,
    stopLoss: maxLoss,
    label: 'Casey structure -- ' + (type === 'call' ? 'below retest $' : 'above retest $') + retestLevel.toFixed(2),
    why: 'Structure-based stop at invalidation + ATR buffer. Holds through normal pullbacks.',
    category: 'CASEY',
    source: 'CaseyConfluence',
  };
}

// ================================================================
// CASEY TRAIL STOP -- Structure-based trailing
// Trails on STRUCTURE levels, not candle-by-candle
// ================================================================
function calcCaseyTrail(params) {
  // params:
  // {
  //   type: 'call' or 'put',
  //   currentPrice: 551.00,
  //   entryPrice: 549.30,
  //   currentPremium: 3.80,
  //   entryPremium: 2.50,
  //   delta: 0.45,
  //   atr: 0.35,
  //   retestLevel: 549.25,  // original structure
  //   health: 8,            // from position health scorer
  // }

  var type = params.type || 'call';
  var currentPrice = params.currentPrice || 0;
  var atr = params.atr || 0.50;
  var health = params.health || 5;
  var currentPremium = params.currentPremium || 1.00;
  var delta = params.delta || 0.40;

  // Trail width based on health score
  // Healthy trade = wide trail (let it ride)
  // Weak trade = tight trail (protect gains)
  var trailMultiplier;
  if (health >= 8) trailMultiplier = 2.0;      // 2x ATR -- let it ride
  else if (health >= 6) trailMultiplier = 1.5;  // 1.5x ATR -- standard
  else if (health >= 4) trailMultiplier = 0.75; // tight -- protect
  else trailMultiplier = 0.25;                  // very tight -- about to exit

  var trailDistance = atr * trailMultiplier;
  var underlyingTrail = type === 'call'
    ? currentPrice - trailDistance
    : currentPrice + trailDistance;

  // Translate to option premium
  var optionTrail = currentPremium - (trailDistance * delta);
  optionTrail = Math.max(optionTrail, currentPremium * 0.50); // never trail below 50% of current value

  return {
    underlyingTrail: underlyingTrail.toFixed(2),
    optionTrail: optionTrail.toFixed(2),
    trailMultiplier: trailMultiplier,
    trailDistance: trailDistance.toFixed(2),
    healthBased: true,
    reason: 'Health ' + health + '/10 → trail ' + trailMultiplier + 'x ATR ($' + trailDistance.toFixed(2) + ')',
  };
}

module.exports = { getSmartStop, classifyTicker, getTSBars, getPublicQuote, calcCaseyStop, calcCaseyTrail };
