// smartStop.js -- Stratum Flow Scout v7.3
// Smart structural stop using:
// 1. Polygon prev day OHLC -- structural level (prev high/low)
// 2. Public.com snapshot -- real-time underlying price
// 3. Delta from contractResolver -- option stop calculation
// No TradeStation token needed

var fetch = require('node-fetch');

var PUBLIC_KEY  = process.env.PUBLIC_API_KEY;

// ================================================================
// STEP 1 -- Get today's HIGH and LOW from Public.com snapshot
// Used for structural stop level
// Calls  stop = today's LOW
// Puts   stop = today's HIGH
// ================================================================
async function getPrevDayOHLC(ticker) {
  try {
    var token = await getPublicToken();
    if (!token) return null;
    var accountId = process.env.PUBLIC_ACCOUNT_ID || '5OF64813';
    var url = 'https://api.public.com/userapigateway/market-data/' + accountId + '/quotes?symbols=' + ticker;
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      console.log('[SMARTSTOP] Public.com quote failed for ' + ticker + ': ' + res.status);
      return null;
    }
    var data = await res.json();
    var quote = data.quotes && data.quotes[0];
    if (!quote) return null;
    console.log('[SMARTSTOP] Public.com quote OK for ' + ticker + ' high=' + quote.high + ' low=' + quote.low);
    return {
      open:  parseFloat(quote.open  || quote.lastPrice || 0),
      high:  parseFloat(quote.high  || quote.lastPrice || 0),
      low:   parseFloat(quote.low   || quote.lastPrice || 0),
      close: parseFloat(quote.lastPrice || 0),
    };
  } catch(e) {
    console.log('[SMARTSTOP] Public.com OHLC error:', e.message);
    return null;
  }
}

// ================================================================
// STEP 2 -- Get real-time underlying price from Public.com
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

async function getRealTimePrice(ticker) {
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
    var quote = data.quotes && data.quotes[0];
    if (!quote) return null;
    return {
      price:  parseFloat(quote.lastPrice || quote.last || 0),
      bid:    parseFloat(quote.bid || 0),
      ask:    parseFloat(quote.ask || 0),
    };
  } catch(e) {
    console.log('[SMARTSTOP] Public.com error:', e.message);
    return null;
  }
}

// ================================================================
// STEP 3 -- Calculate smart structural stop
// ================================================================
function calcSmartStop(type, premium, delta, stockPrice, prevHigh, prevLow) {
  // Structural level
  var structuralStop = type === 'call' ? prevLow : prevHigh;

  // Distance from stock price to structural stop
  var distance = Math.abs(stockPrice - structuralStop);

  // Option stop = premium - (distance x delta)
  var optionStop = premium - (distance * delta);

  // Floor at 20% of premium -- never stop out too tight
  var minStop = premium * 0.20;

  // Ceiling at 50% of premium -- never risk more than 50%
  var maxStop = premium * 0.50;

  // Apply bounds
  optionStop = Math.max(optionStop, minStop);
  optionStop = Math.min(optionStop, maxStop);
  optionStop = Math.max(optionStop, 0.01);

  return {
    structuralLevel: structuralStop.toFixed(2),
    optionStop:      optionStop.toFixed(2),
    distance:        distance.toFixed(2),
    maxLoss:         ((premium - optionStop) * 100).toFixed(0),
    label:           type === 'call'
                       ? 'prev day low $' + prevLow.toFixed(2)
                       : 'prev day high $' + prevHigh.toFixed(2),
  };
}

// ================================================================
// MAIN -- Run smart stop analysis for a ticker
// Called from contractResolver.js or alerter.js
// ================================================================
async function getSmartStop(ticker, type, premium, delta) {
  console.log('[SMARTSTOP] Calculating smart stop for ' + ticker + ' ' + type);

  // Default delta if not provided
  delta = delta || 0.40;

  // Get prev day OHLC from Polygon
  var ohlc = await getPrevDayOHLC(ticker);
  if (!ohlc) {
    console.log('[SMARTSTOP] No OHLC -- using flat 40% stop');
    var flatStop = (premium * 0.60).toFixed(2);
    return {
      optionStop:      flatStop,
      structuralLevel: null,
      maxLoss:         ((premium - parseFloat(flatStop)) * 100).toFixed(0),
      label:           'flat 40% stop (Polygon unavailable)',
      source:          'flat',
    };
  }

  // Get real-time stock price from Public.com
  var quote = await getRealTimePrice(ticker);
  var stockPrice = quote ? quote.price : ohlc.close;

  // Calculate smart stop
  var result = calcSmartStop(type, premium, delta, stockPrice, ohlc.high, ohlc.low);
  result.stockPrice  = stockPrice.toFixed(2);
  result.prevHigh    = ohlc.high.toFixed(2);
  result.prevLow     = ohlc.low.toFixed(2);
  result.source      = 'structural';

  console.log('[SMARTSTOP] ' + ticker + ' ' + type.toUpperCase() +
    ' -- Stop: $' + result.optionStop +
    ' (' + result.label + ')' +
    ' -- Max loss: $' + result.maxLoss);

  return result;
}

module.exports = { getSmartStop, getPrevDayOHLC, getRealTimePrice };
