// smartStop.js -- Stratum Flow Scout v7.3
// DYNAMIC STOP SYSTEM
// Automatically classifies every ticker and picks the right stop type:
//
// WIDE RANGE (ADX>30, ATR>2%, Beta>1.5) = STRUCTURAL stop
//   Calls -> prev day low
//   Puts  -> prev day high
//   Examples: NVDA, TSLA, COIN, MSTR
//
// TIGHT RANGE (ADX<20, ATR<1.5%, Beta<0.8) = FLAT 40% stop
//   Examples: DLTR, WMT, KO, PEP, XLF
//
// INDICES = PIVOT stop
//   (High + Low + Close) / 3 = pivot
//   Examples: SPY, QQQ, IWM, DIA
//
// MIXED = HYBRID stop (blend of structural + flat)
//   Everything in between

var fetch = require('node-fetch');

var PUBLIC_KEY = process.env.PUBLIC_API_KEY;

// ================================================================
// TICKER CLASSIFICATION
// ================================================================
var INDICES = ['SPY', 'QQQ', 'IWM', 'DIA', 'VXX', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'TNA', 'TZA'];

var WIDE_RANGE_TICKERS = [
  'NVDA', 'TSLA', 'MSTR', 'COIN', 'AMD', 'META', 'NFLX', 'SMCI',
  'PLTR', 'HOOD', 'RIVN', 'LCID', 'GME', 'AMC', 'DKNG', 'RBLX',
  'CRWD', 'SNOW', 'SHOP', 'SQ', 'ROKU', 'UBER', 'LYFT', 'ABNB',
  'CVNA', 'AFRM', 'UPST', 'SOFI', 'RIOT', 'MARA', 'HUT', 'CLSK'
];

var TIGHT_RANGE_TICKERS = [
  'DLTR', 'DG', 'WMT', 'TGT', 'KO', 'PEP', 'JNJ', 'PG', 'MCD',
  'XLF', 'XLE', 'XLU', 'XLV', 'XLK', 'XLB', 'XLRE', 'XLP',
  'VZ', 'T', 'SO', 'DUK', 'NEE', 'D', 'WEC', 'AEP',
  'LLY', 'ABBV', 'MRK', 'PFE', 'BMY', 'AMGN', 'GILD',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'USB', 'TFC'
];

function classifyTicker(ticker, adx, atrPct) {
  // Check indices first
  if (INDICES.includes(ticker.toUpperCase())) {
    return 'INDEX';
  }

  // Check known wide range tickers
  if (WIDE_RANGE_TICKERS.includes(ticker.toUpperCase())) {
    return 'WIDE';
  }

  // Check known tight range tickers
  if (TIGHT_RANGE_TICKERS.includes(ticker.toUpperCase())) {
    return 'TIGHT';
  }

  // Use ADX if available from Pine Script payload
  if (adx && atrPct) {
    if (adx > 30 && atrPct > 2.0) return 'WIDE';
    if (adx < 20 && atrPct < 1.5) return 'TIGHT';
    return 'HYBRID';
  }

  // Default to HYBRID if unknown
  return 'HYBRID';
}

// ================================================================
// GET PUBLIC.COM TOKEN
// ================================================================
async function getPublicToken() {
  try {
    var res = await fetch('https://api.public.com/auth/access-tokens', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + PUBLIC_KEY,
      },
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data.access_token || null;
  } catch(e) { return null; }
}

// ================================================================
// GET REAL-TIME QUOTE FROM PUBLIC.COM
// Returns: price, high, low, open, close, bid, ask
// ================================================================
async function getQuote(ticker) {
  try {
    var token = await getPublicToken();
    if (!token) return null;

    var accountId = process.env.PUBLIC_ACCOUNT_ID || '5OF64813';
    var url = 'https://api.public.com/userapigateway/market-data/' + accountId + '/quotes?symbols=' + ticker;
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return null;
    var data = await res.json();
    var q = data.quotes && data.quotes[0];
    if (!q) return null;

    var price = parseFloat(q.lastPrice || q.last || 0);
    var high  = parseFloat(q.high  || price);
    var low   = parseFloat(q.low   || price);
    var open  = parseFloat(q.open  || price);

    console.log('[SMARTSTOP] ' + ticker + ' quote: price=' + price + ' high=' + high + ' low=' + low);

    return { price, high, low, open };
  } catch(e) {
    console.log('[SMARTSTOP] Quote error for ' + ticker + ':', e.message);
    return null;
  }
}

// ================================================================
// CALCULATE STOP BASED ON TICKER CATEGORY
// ================================================================
function calcStop(category, type, premium, delta, price, high, low) {
  var pivot = ((high + low + price) / 3);
  var result = {};

  if (category === 'INDEX') {
    // PIVOT STOP -- indices respect pivot levels
    var structuralLevel = type === 'call' ? pivot - (price - pivot) : pivot + (pivot - price);
    structuralLevel = type === 'call' ? Math.min(pivot, low) : Math.max(pivot, high);
    var distance  = Math.abs(price - structuralLevel);
    var optionStop = Math.max(premium - (distance * delta), premium * 0.25);
    optionStop     = Math.min(optionStop, premium * 0.65);

    result = {
      stopType:        'PIVOT',
      structuralLevel: pivot.toFixed(2),
      underlyingStop:  structuralLevel.toFixed(2),
      optionStop:      optionStop.toFixed(2),
      stopPrice:       optionStop.toFixed(2),
      distance:        distance.toFixed(2),
      label:           'pivot $' + pivot.toFixed(2),
      why:             'INDEX -- respects pivot more than high/low',
    };

  } else if (category === 'WIDE') {
    // STRUCTURAL STOP -- wide range tickers need room to breathe
    var structuralLevel = type === 'call' ? low : high;
    var distance  = Math.abs(price - structuralLevel);
    var optionStop = Math.max(premium - (distance * delta), premium * 0.20);
    optionStop     = Math.min(optionStop, premium * 0.55);

    result = {
      stopType:        'STRUCTURAL',
      structuralLevel: structuralLevel.toFixed(2),
      underlyingStop:  structuralLevel.toFixed(2),
      optionStop:      optionStop.toFixed(2),
      stopPrice:       optionStop.toFixed(2),
      distance:        distance.toFixed(2),
      label:           type === 'call' ? 'day low $' + low.toFixed(2) : 'day high $' + high.toFixed(2),
      why:             'WIDE RANGE -- structural gives room for normal pullback',
    };

  } else if (category === 'TIGHT') {
    // FLAT 40% STOP -- tight range tickers, exit fast
    var optionStop = premium * 0.60;

    result = {
      stopType:        'FLAT',
      structuralLevel: null,
      underlyingStop:  null,
      optionStop:      optionStop.toFixed(2),
      stopPrice:       optionStop.toFixed(2),
      distance:        null,
      label:           'flat 40% -- tight range ticker',
      why:             'TIGHT RANGE -- flat stop exits before thesis fails',
    };

  } else {
    // HYBRID STOP -- blend structural + flat
    var structuralLevel = type === 'call' ? low : high;
    var distance  = Math.abs(price - structuralLevel);
    var structStop = Math.max(premium - (distance * delta), premium * 0.25);
    var flatStop   = premium * 0.60;
    // Blend: 60% structural, 40% flat
    var optionStop = (structStop * 0.60) + (flatStop * 0.40);
    optionStop     = Math.min(optionStop, premium * 0.65);
    optionStop     = Math.max(optionStop, premium * 0.25);

    result = {
      stopType:        'HYBRID',
      structuralLevel: structuralLevel.toFixed(2),
      underlyingStop:  structuralLevel.toFixed(2),
      optionStop:      optionStop.toFixed(2),
      stopPrice:       optionStop.toFixed(2),
      distance:        distance.toFixed(2),
      label:           'hybrid -- ' + (type === 'call' ? 'day low $' + low.toFixed(2) : 'day high $' + high.toFixed(2)),
      why:             'MIXED -- blend of structural and flat',
    };
  }

  // Add shared fields
  result.prevHigh  = high.toFixed(2);
  result.prevLow   = low.toFixed(2);
  result.pivot     = pivot.toFixed(2);
  result.bias      = type === 'call' ? 'BULL' : 'BEAR';
  result.maxLoss   = ((premium - parseFloat(result.optionStop)) * 100).toFixed(0);
  result.stopLoss  = result.maxLoss;
  result.category  = category;

  console.log('[SMARTSTOP] ' + category + ' stop -- ' + result.label + ' -- option stop $' + result.optionStop + ' max loss -$' + result.maxLoss);

  return result;
}

// ================================================================
// MAIN -- getSmartStop
// Called from alerter.js for every card
// ================================================================
async function getSmartStop(ticker, type, premium, delta, adx, atrPct) {
  console.log('[SMARTSTOP] Calculating ' + ticker + ' ' + type + ' premium=$' + premium);

  delta  = delta  || 0.40;
  adx    = adx    || null;
  atrPct = atrPct || null;

  // Classify this ticker
  var category = classifyTicker(ticker, adx, atrPct);
  console.log('[SMARTSTOP] ' + ticker + ' classified as: ' + category);

  // Get real-time quote from Public.com
  var quote = await getQuote(ticker);

  if (!quote || !quote.price) {
    console.log('[SMARTSTOP] No quote -- using flat 40% fallback');
    var flatStop = (premium * 0.60).toFixed(2);
    var flatLoss = ((premium - parseFloat(flatStop)) * 100).toFixed(0);
    return {
      stopType:        'FLAT',
      optionStop:      flatStop,
      stopPrice:       flatStop,
      stopLoss:        flatLoss,
      maxLoss:         flatLoss,
      structuralLevel: null,
      underlyingStop:  null,
      prevHigh:        null,
      prevLow:         null,
      pivot:           null,
      bias:            type === 'call' ? 'BULL' : 'BEAR',
      distance:        null,
      label:           'flat 40% (quote unavailable)',
      why:             'Public.com unavailable -- flat stop applied',
      category:        'FLAT',
    };
  }

  return calcStop(category, type, premium, delta, quote.price, quote.high, quote.low);
}

module.exports = { getSmartStop, getQuote, classifyTicker };
