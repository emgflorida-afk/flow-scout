// finvizScreener.js - Stratum Flow Scout v7.2
// Public.com quotes -- one ticker at a time, exact contractResolver pattern

var fetch = require('node-fetch');

var PUB_AUTH    = 'https://api.public.com/userapiauthservice/personal/access-tokens';
var PUB_GATEWAY = 'https://api.public.com/userapigateway';

function getWebhook()   { return process.env.DISCORD_SCREENER_WEBHOOK; }
function getPublicKey() { return process.env.PUBLIC_API_KEY; }
function getAccountId() { return process.env.PUBLIC_ACCOUNT_ID; }

var WATCHLIST = [
  'SPY','QQQ','IWM',
  'NVDA','TSLA','META','AAPL','AMZN','MSFT','GOOGL',
  'JPM','BAC','GS',
  'USO','XOM','OXY','XLE',
  'PLTR','CRM','MRVL',
];

async function getPublicToken() {
  try {
    var secret = getPublicKey();
    if (!secret) return null;
    var res = await fetch(PUB_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ secret: secret, validityInMinutes: 30 })
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data && data.accessToken ? data.accessToken : null;
  } catch(e) { return null; }
}

// Exact same pattern as contractResolver getPrice -- one ticker at a time
async function getPrice(ticker, token, accountId) {
  try {
    var res = await fetch(PUB_GATEWAY + '/marketdata/' + accountId + '/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] })
    });
    if (!res.ok) return null;
    var data  = await res.json();
    var q     = data && data.quotes && data.quotes[0] ? data.quotes[0] : null;
    if (!q) return null;
    // Log raw response for first ticker to debug field names
    if (ticker === 'SPY') console.log('[FINVIZ] SPY raw:', JSON.stringify(q).slice(0, 200));
    var price     = parseFloat(q.last || q.close || 0);
    var prevClose = q.prevDay && q.prevDay.close ? parseFloat(q.prevDay.close) : parseFloat(q.previousClose || price);
    var change    = parseFloat((price - prevClose).toFixed(2));
    var changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    var volume    = parseInt(q.volume || 0);
    return { ticker: ticker, price: price, change: change, changePct: changePct, volume: volume };
  } catch(e) { return null; }
}

function fmtVol(v) {
  if (v >= 1000000) return (v/1000000).toFixed(1)+'M';
  if (v >= 1000)    return (v/1000).toFixed(0)+'K';
  return v > 0 ? String(v) : '';
}

async function postScreenerCard() {
  var webhook   = getWebhook();
  var accountId = getAccountId();
  if (!webhook)   { console.log('[FINVIZ] No webhook'); return; }
  if (!accountId) { console.log('[FINVIZ] No PUBLIC_ACCOUNT_ID'); return; }

  var token = await getPublicToken();
  if (!token) { console.log('[FINVIZ] No token'); return; }

  // Fetch one at a time -- same as contractResolver
  var quotes = [];
  for (var i = 0; i < WATCHLIST.length; i++) {
    var q = await getPrice(WATCHLIST[i], token, accountId);
    if (q && q.price > 0) quotes.push(q);
  }

  console.log('[FINVIZ] Got ' + quotes.length + ' quotes');

  if (quotes.length === 0) {
    console.log('[FINVIZ] No quotes -- check Railway log for SPY raw response');
    return;
  }

  var sorted  = quotes.slice().sort(function(a,b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  var bullish = sorted.filter(function(q) { return q.changePct > 0; }).slice(0,5);
  var bearish = sorted.filter(function(q) { return q.changePct < 0; }).slice(0,5);
  var spy     = quotes.find(function(q) { return q.ticker === 'SPY'; });
  var qqq     = quotes.find(function(q) { return q.ticker === 'QQQ'; });

  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  var out = ['MORNING SCREENER -- ' + date, '==============================='];
  if (spy) out.push('SPY  $' + spy.price + '  ' + (spy.changePct >= 0 ? '+' : '') + spy.changePct + '%  Vol: ' + fmtVol(spy.volume));
  if (qqq) out.push('QQQ  $' + qqq.price + '  ' + (qqq.changePct >= 0 ? '+' : '') + qqq.changePct + '%  Vol: ' + fmtVol(qqq.volume));
  out.push('-------------------------------');
  if (bullish.length > 0) {
    out.push('BULLISH TOP MOVERS:');
    bullish.forEach(function(q) {
      out.push('  ' + q.ticker.padEnd(6) + ' $' + q.price + '  +' + q.changePct + '%  ' + fmtVol(q.volume));
    });
    out.push('-------------------------------');
  }
  if (bearish.length > 0) {
    out.push('BEARISH TOP MOVERS:');
    bearish.forEach(function(q) {
      out.push('  ' + q.ticker.padEnd(6) + ' $' + q.price + '  ' + q.changePct + '%  ' + fmtVol(q.volume));
    });
    out.push('-------------------------------');
  }
  out.push('Watch for A+ Strat setups on high movers');
  out.push('Time: ' + time + ' ET');

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + out.join('\n') + '\n```', username: 'Stratum Screener' })
    });
    console.log('[FINVIZ] Posted screener -- ' + quotes.length + ' quotes');
  } catch(e) { console.error('[FINVIZ] Post error:', e.message); }
}

module.exports = { postScreenerCard: postScreenerCard };