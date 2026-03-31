// preMarketReport.js - Stratum Flow Scout v7.2
// Runs at 8AM ET every trading day
// Pulls live pre-market data for all watchlist tickers
// Combines price action + oil watch + geo news into one card
// Posts to #strat-alerts so you know exactly what's happening before open

var fetch = require('node-fetch');

function getWebhook()    { return process.env.DISCORD_WEBHOOK_URL; }
function getPublicKey()  { return process.env.PUBLIC_API_KEY; }
function getPolygonKey() { return process.env.POLYGON_API_KEY; }

// Core pre-market tickers to watch
var INDEX_TICKERS = ['SPY', 'QQQ', 'IWM'];
var OIL_TICKERS   = ['USO', 'XOM', 'OXY', 'UCO', 'SCO'];
var TECH_TICKERS  = ['NVDA', 'TSLA', 'META', 'AAPL', 'AMZN', 'MSFT'];
var VIX_TICKER    = 'UVXY';

// -- GET PUBLIC.COM TOKEN ------------------------------------
async function getPublicToken() {
  try {
    var secret = getPublicKey();
    if (!secret) return null;
    var res = await fetch('https://api.public.com/userapiauthservice/personal/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ secret: secret, validityInMinutes: 30 })
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data && data.accessToken ? data.accessToken : null;
  } catch(e) { return null; }
}

// -- GET SINGLE QUOTE FROM PUBLIC.COM -----------------------
async function getQuote(ticker, token, accountId) {
  try {
    var res = await fetch('https://api.public.com/userapigateway/marketdata/' + accountId + '/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ tickers: [ticker] })
    });
    if (!res.ok) return null;
    var data = await res.json();
    var q = data && data.quotes && data.quotes[0] ? data.quotes[0] : null;
    if (!q) return null;
    var price     = parseFloat(q.last || q.close || 0);
    var prevClose = parseFloat(q.prevClose || q.previousClose || price);
    var change    = parseFloat((price - prevClose).toFixed(2));
    var changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    return { ticker: ticker, price: price, change: change, changePct: changePct };
  } catch(e) { return null; }
}

// -- GET QUOTES FOR GROUP OF TICKERS -----------------------
async function getGroupQuotes(tickers, token, accountId) {
  var results = [];
  for (var i = 0; i < tickers.length; i++) {
    var q = await getQuote(tickers[i], token, accountId);
    if (q && q.price > 0) results.push(q);
  }
  return results;
}

// -- FORMAT QUOTE LINE -------------------------------------
function fmtQuote(q, width) {
  if (!q) return null;
  var t   = (q.ticker || '').padEnd(width || 6);
  var p   = '$' + q.price;
  var c   = (q.changePct >= 0 ? '+' : '') + q.changePct + '%';
  var dir = q.changePct > 0 ? ' UP' : q.changePct < 0 ? ' DOWN' : ' FLAT';
  return t + ' ' + p.padEnd(10) + ' ' + c.padEnd(8) + dir;
}

// -- GET BREAKING GEO NEWS FROM POLYGON --------------------
async function getBreakingNews() {
  try {
    var key = getPolygonKey();
    if (!key) return [];
    var res = await fetch('https://api.polygon.io/v2/reference/news?ticker=SPY&limit=5&apiKey=' + key);
    if (!res.ok) return [];
    var data = await res.json();
    return (data && data.results) ? data.results.slice(0, 3) : [];
  } catch(e) { return []; }
}

// -- DETERMINE SPY BIAS ------------------------------------
function getSpyBias(spyQuote) {
  if (!spyQuote) return { bias: 'UNKNOWN', key: 637 };
  var price = spyQuote.price;
  var pct   = spyQuote.changePct;
  if (price > 645)       return { bias: 'BULLISH -- rip your face off rally risk', key: 645 };
  if (pct > 1.5)         return { bias: 'BULLISH BOUNCE -- calls favored', key: price };
  if (pct > 0.5)         return { bias: 'CAUTION -- bounce in progress, wait for direction', key: price };
  if (pct < -1.0)        return { bias: 'BEARISH -- puts favored', key: price };
  return { bias: 'NEUTRAL -- wait for 9:45AM confirmation', key: price };
}

// -- MAIN: POST PRE-MARKET REPORT --------------------------
async function postPreMarketReport() {
  var webhook   = getWebhook();
  if (!webhook) { console.log('[PMR] No webhook'); return; }

  var token     = await getPublicToken();
  var accountId = process.env.PUBLIC_ACCOUNT_ID;

  if (!token || !accountId) {
    console.log('[PMR] No Public.com token or accountId -- skipping');
    return;
  }

  // Fetch all quotes
  var indexQ = await getGroupQuotes(INDEX_TICKERS, token, accountId);
  var oilQ   = await getGroupQuotes(OIL_TICKERS, token, accountId);
  var techQ  = await getGroupQuotes(TECH_TICKERS, token, accountId);
  var vixQ   = await getQuote(VIX_TICKER, token, accountId);
  var news   = await getBreakingNews();

  var spy    = indexQ.find(function(q) { return q.ticker === 'SPY'; });
  var uso    = oilQ.find(function(q) { return q.ticker === 'USO'; });
  var biasInfo = getSpyBias(spy);

  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  var lines2 = [
    'PRE-MARKET REPORT -- ' + date,
    '===============================',
  ];

  // Indices
  lines2.push('INDICES:');
  indexQ.forEach(function(q) { var l = fmtQuote(q, 5); if (l) lines2.push('  ' + l); });
  if (vixQ) lines2.push('  ' + fmtQuote(vixQ, 5) + '  (fear gauge)');
  lines2.push('-------------------------------');

  // Oil watch
  lines2.push('OIL WATCH:');
  oilQ.forEach(function(q) { var l = fmtQuote(q, 5); if (l) lines2.push('  ' + l); });
  if (uso) {
    var oilDir = uso.changePct < -1 ? 'OIL RETRACING -- SCO calls / puts on XOM/OXY'
              : uso.changePct > 1  ? 'OIL SPIKING -- UCO calls / XOM calls'
              : 'OIL FLAT -- wait for direction';
    lines2.push('  Signal: ' + oilDir);
  }
  lines2.push('-------------------------------');

  // Tech movers
  var techSorted = techQ.slice().sort(function(a,b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  lines2.push('TOP TECH MOVERS:');
  techSorted.slice(0,4).forEach(function(q) { var l = fmtQuote(q, 6); if (l) lines2.push('  ' + l); });
  lines2.push('-------------------------------');

  // Breaking news
  if (news.length > 0) {
    lines2.push('BREAKING NEWS:');
    news.forEach(function(n) {
      lines2.push('  ' + (n.title || '').slice(0, 80));
    });
    lines2.push('-------------------------------');
  }

  // Bias and trade rules
  lines2.push('MACRO BIAS: ' + biasInfo.bias);
  lines2.push('');
  lines2.push('TRADE RULES TODAY:');
  if (spy && spy.price > 645) {
    lines2.push('SPY above $645 -- RIP YOUR FACE OFF RALLY RISK');
    lines2.push('CANCEL ALL PUT ORDERS IMMEDIATELY');
    lines2.push('Flip to calls if confirmed');
  } else if (spy && spy.changePct > 1.5) {
    lines2.push('Strong bounce -- wait for 9:45AM direction confirm');
    lines2.push('Calls only if SPY holds above open');
  } else if (spy && spy.changePct < -0.5) {
    lines2.push('Bearish bias confirmed -- puts favored');
    lines2.push('A+ grade = 4 contracts | A grade = 3 contracts');
  } else {
    lines2.push('Wait for 9:45AM -- let market show direction first');
    lines2.push('No trades before 9:45AM ET');
  }
  lines2.push('');
  lines2.push('Time: ' + time + ' ET');

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + lines2.join('\n') + '\n```', username: 'Stratum Pre-Market' })
    });
    console.log('[PMR] Pre-market report posted -- SPY ' + (spy ? spy.changePct + '%' : 'N/A'));
  } catch(e) { console.error('[PMR] Post error:', e.message); }
}

module.exports = { postPreMarketReport: postPreMarketReport };