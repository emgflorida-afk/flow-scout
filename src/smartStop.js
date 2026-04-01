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

var WIDE_RANGE = [
  'NVDA', 'TSLA', 'MSTR', 'COIN', 'AMD', 'META', 'NFLX', 'SMCI',
  'PLTR', 'HOOD', 'RIVN', 'LCID', 'GME', 'AMC', 'DKNG', 'RBLX',
  'CRWD', 'SNOW', 'SHOP', 'SQ', 'ROKU', 'UBER', 'LYFT', 'ABNB',
  'CVNA', 'AFRM', 'UPST', 'SOFI', 'RIOT', 'MARA', 'MRVL', 'AVGO',
  'GOOGL', 'AAPL', 'MSFT', 'AMZN', 'JPM', 'GS', 'MS',
  'LMT', 'RTX', 'NOC', 'GD', 'LDOS', 'DAL', 'UAL', 'LUV',
];

var TIGHT_RANGE = [
  'DLTR', 'DG', 'WMT', 'TGT', 'KO', 'PEP', 'JNJ', 'PG', 'MCD',
  'XLF', 'XLE', 'XLU', 'XLV', 'XLK', 'XLB', 'XLRE', 'XLP',
  'VZ', 'T', 'SO', 'DUK', 'NEE', 'D', 'WEC', 'AEP',
  'LLY', 'ABBV', 'MRK', 'PFE', 'BMY', 'AMGN', 'GILD',
  'WFC', 'BAC', 'C', 'USB', 'TFC',
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
    var optStop = premium * 0.60;
    return {
      stopType: 'FLAT', structuralLevel: null, underlyingStop: null,
      optionStop: optStop.toFixed(2), stopPrice: optStop.toFixed(2), distance: null,
      label: 'flat 40% -- tight range', why: 'TIGHT RANGE -- exit fast',
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

module.exports = { getSmartStop, classifyTicker, getTSBars, getPublicQuote };
