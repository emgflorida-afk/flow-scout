// macroFilter.js -- Stratum v7.4
// 6HR is the boss -- determines what cards fire today
// 6HR bullish = CALLS ONLY all day
// 6HR bearish = PUTS ONLY all day
// SPY/QQQ/IWM = 1HR entry timing
// Individual stocks = 15-min entry timing

var fetch = require('node-fetch');

var TS_BASE   = 'https://api.tradestation.com/v3';
var PUBLIC_KEY = process.env.PUBLIC_API_KEY;

// Cache macro bias so we don't hammer APIs
var macroBiasCache = {
  bias:      null,
  h6Bias:    null,
  spyPrice:  null,
  lastUpdate: 0,
  ttl:       5 * 60 * 1000, // 5 minute cache
};

// Get SPY current price from Public.com
async function getSPYPrice() {
  try {
    var res = await fetch('https://api.public.com/auth/access-tokens', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + PUBLIC_KEY },
    });
    if (!res.ok) return null;
    var data = await res.json();
    var token = data.access_token;
    if (!token) return null;

    var accountId = process.env.PUBLIC_ACCOUNT_ID || '5OF64813';
    var q = await fetch('https://api.public.com/userapigateway/market-data/' + accountId + '/quotes?symbols=SPY', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!q.ok) return null;
    var qdata = await q.json();
    var quote = qdata.quotes && qdata.quotes[0];
    return quote ? parseFloat(quote.lastPrice || 0) : null;
  } catch(e) {
    console.log('[MACRO] SPY price error:', e.message);
    return null;
  }
}

// Get direction using Daily bars from TradeStation
// TS MCP only supports 5-min intraday bars
// So we use Daily close vs prev close + prev day range
// Pine Script handles real 6HR/4HR on TradingView
// This gives us the same directional bias for the agent
async function get6HRBias(token) {
  try {
    if (!token) {
      // Try getting token ourselves
      var ts = require('./tradestation');
      token  = await ts.getAccessToken();
      if (!token) return null;
    }

    var url = TS_BASE + '/marketdata/barcharts/SPY?unit=Daily&interval=1&barsback=5&sessiontemplate=Default';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      console.log('[MACRO] Daily bars failed:', res.status);
      return null;
    }
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return null;

    var curr = bars[bars.length - 1];
    var prev = bars[bars.length - 2];

    var currClose = parseFloat(curr.Close || 0);
    var currOpen  = parseFloat(curr.Open  || 0);
    var prevHigh  = parseFloat(prev.High  || 0);
    var prevLow   = parseFloat(prev.Low   || 0);
    var prevClose = parseFloat(prev.Close || 0);

    // Primary: 2UP or 2DOWN vs prev day
    var is2U = currClose > prevHigh;    // above prev high = strong bullish
    var is2D = currClose < prevLow;     // below prev low  = strong bearish

    // Secondary: direction of current candle
    var bullCandle = currClose > currOpen && currClose > prevClose;
    var bearCandle = currClose < currOpen && currClose < prevClose;

    // SPY $645 threshold -- hard rule
    var spyAbove645 = currClose > 645;
    var spyBelow630 = currClose < 630;

    if (is2U || (spyAbove645 && bullCandle)) {
      console.log('[MACRO] 6HR proxy: BULLISH -- SPY $' + currClose + ' close>prevHigh=$' + prevHigh);
      return 'BULLISH';
    }
    if (is2D || (spyBelow630 && bearCandle)) {
      console.log('[MACRO] 6HR proxy: BEARISH -- SPY $' + currClose + ' close<prevLow=$' + prevLow);
      return 'BEARISH';
    }
    if (bullCandle) {
      console.log('[MACRO] 6HR proxy: BULLISH -- bull candle $' + currClose);
      return 'BULLISH';
    }
    if (bearCandle) {
      console.log('[MACRO] 6HR proxy: BEARISH -- bear candle $' + currClose);
      return 'BEARISH';
    }

    console.log('[MACRO] 6HR proxy: MIXED -- SPY $' + currClose);
    return 'MIXED';
  } catch(e) {
    console.log('[MACRO] 6HR bias error:', e.message);
    return null;
  }
}

// Main macro bias function -- called before every card
async function getMacroBias() {
  var now = Date.now();
  if (macroBiasCache.bias && (now - macroBiasCache.lastUpdate) < macroBiasCache.ttl) {
    return macroBiasCache;
  }

  var spyPrice = await getSPYPrice();
  var spyBias  = spyPrice ? (spyPrice > 645 ? 'BULLISH' : spyPrice < 630 ? 'BEARISH' : 'MIXED') : null;

  // Update cache
  macroBiasCache.bias      = spyBias || 'MIXED';
  macroBiasCache.spyPrice  = spyPrice;
  macroBiasCache.h6Bias    = spyBias; // fallback -- use TS bars when token works
  macroBiasCache.lastUpdate = now;

  console.log('[MACRO] SPY $' + spyPrice + ' bias=' + spyBias);
  return macroBiasCache;
}

// Should this card be blocked based on macro?
function shouldBlock(type, macro) {
  var bias = macro.h6Bias || macro.bias || 'MIXED';
  if (bias === 'BULLISH' && type === 'put')  return { block: true,  reason: '6HR BULLISH -- blocking put cards today' };
  if (bias === 'BEARISH' && type === 'call') return { block: true,  reason: '6HR BEARISH -- blocking call cards today' };
  return { block: false, reason: null };
}

// Force update the macro bias manually
function setManualBias(bias) {
  macroBiasCache.bias   = bias;
  macroBiasCache.h6Bias = bias;
  macroBiasCache.lastUpdate = Date.now();
  console.log('[MACRO] Manual bias set to:', bias);
}

module.exports = { getMacroBias, shouldBlock, setManualBias };
