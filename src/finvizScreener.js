// finvizScreener.js - Stratum Flow Scout v7.2
// Uses Public.com for live pre-market quotes on watchlist tickers
// Posts top movers to #screener-watchlist at 9:15AM ET

var fetch = require('node-fetch');

function getWebhook() { return process.env.DISCORD_SCREENER_WEBHOOK; }
function getPublicKey() { return process.env.PUBLIC_API_KEY; }

var WATCHLIST = [
  'SPY','QQQ','IWM',
  'NVDA','TSLA','META','AAPL','AMZN','MSFT','GOOGL',
  'JPM','BAC','WFC','GS',
  'USO','XOM','OXY','CVX','XLE',
  'PLTR','CRM','DKNG','MRVL','ORCL',
];

// -- GET PUBLIC.COM ACCESS TOKEN --------------------------------
async function getPublicToken() {
  try {
    var secret = getPublicKey();
    if (!secret) return null;
    var res = await fetch('https://api.public.com/userapiauthservice/personal/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ secret: secret, validityInMinutes: 30 })
    });
    if (!res.ok) { console.error('[FINVIZ] Token error:', res.status); return null; }
    var data = await res.json();
    return data && data.accessToken ? data.accessToken : null;
  } catch(e) { console.error('[FINVIZ] Token error:', e.message); return null; }
}

// -- GET QUOTE FOR ONE TICKER ----------------------------------
async function getQuote(ticker, token) {
  try {
    var res = await fetch('https://api.public.com/userapigateway/market-data/tickers/' + ticker + '/quote', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return null;
    var data = await res.json();
    if (!data) return null;
    var price     = parseFloat(data.last || data.close || 0);
    var prevClose = parseFloat(data.prevClose || data.previousClose || price);
    var change    = parseFloat((price - prevClose).toFixed(2));
    var changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    var volume    = parseInt(data.volume || 0);
    var avgVol    = parseInt(data.averageVolume || data.avgVolume || 1);
    var relVol    = avgVol > 0 ? parseFloat((volume / avgVol).toFixed(1)) : 0;
    return { ticker: ticker, price: price, change: change, changePct: changePct,
             volume: volume, relVol: relVol };
  } catch(e) { return null; }
}

// -- FORMAT VOLUME ---------------------------------------------
function fmtVol(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(0) + 'K';
  return String(v);
}

// -- POST SCREENER CARD ----------------------------------------
async function postScreenerCard() {
  var webhook = getWebhook();
  if (!webhook) { console.log('[FINVIZ] No webhook'); return; }

  var token = await getPublicToken();
  if (!token) { console.log('[FINVIZ] No Public.com token'); return; }

  // Fetch all quotes
  var quotes = [];
  for (var i = 0; i < WATCHLIST.length; i++) {
    var q = await getQuote(WATCHLIST[i], token);
    if (q && q.price > 0) quotes.push(q);
  }

  if (quotes.length === 0) {
    console.log('[FINVIZ] No quotes returned');
    return;
  }

  // Sort by absolute % change
  var sorted = quotes.slice().sort(function(a, b) {
    return Math.abs(b.changePct) - Math.abs(a.changePct);
  });

  var bullish = sorted.filter(function(q) { return q.changePct > 0; }).slice(0, 5);
  var bearish = sorted.filter(function(q) { return q.changePct < 0; }).slice(0, 5);

  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  var lines2 = [
    'MORNING SCREENER -- ' + date,
    '===============================',
  ];

  // SPY and VIX context
  var spy = quotes.find(function(q) { return q.ticker === 'SPY'; });
  var qqq = quotes.find(function(q) { return q.ticker === 'QQQ'; });
  if (spy) lines2.push('SPY   $' + spy.price + '  ' + (spy.changePct >= 0 ? '+' : '') + spy.changePct + '%');
  if (qqq) lines2.push('QQQ   $' + qqq.price + '  ' + (qqq.changePct >= 0 ? '+' : '') + qqq.changePct + '%');
  lines2.push('-------------------------------');

  // Bullish movers
  if (bullish.length > 0) {
    lines2.push('BULLISH TOP MOVERS:');
    bullish.forEach(function(q) {
      var rv = q.relVol > 0 ? '  RelVol: ' + q.relVol + 'x' : '';
      lines2.push('  ' + q.ticker.padEnd(6) + ' $' + q.price + '  +' + q.changePct + '%  Vol: ' + fmtVol(q.volume) + rv);
    });
    lines2.push('-------------------------------');
  }

  // Bearish movers
  if (bearish.length > 0) {
    lines2.push('BEARISH TOP MOVERS:');
    bearish.forEach(function(q) {
      var rv = q.relVol > 0 ? '  RelVol: ' + q.relVol + 'x' : '';
      lines2.push('  ' + q.ticker.padEnd(6) + ' $' + q.price + '  ' + q.changePct + '%  Vol: ' + fmtVol(q.volume) + rv);
    });
    lines2.push('-------------------------------');
  }

  lines2.push('Watch for A+ Strat setups on high movers');
  lines2.push('Time: ' + time + ' ET');

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + lines2.join('\n') + '\n```', username: 'Stratum Screener' })
    });
    console.log('[FINVIZ] Posted screener -- ' + quotes.length + ' quotes');
  } catch(e) { console.error('[FINVIZ] Post error:', e.message); }
}

module.exports = { postScreenerCard: postScreenerCard };