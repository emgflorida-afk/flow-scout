// finvizScreener.js - Stratum Flow Scout v7.2
// Public.com for live price + TradeStation for prev close = accurate % change

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

// -- GET PUBLIC.COM TOKEN ------------------------------------
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

// -- GET LIVE PRICE FROM PUBLIC.COM --------------------------
async function getLivePrice(ticker, token, accountId) {
  try {
    var res = await fetch(PUB_GATEWAY + '/marketdata/' + accountId + '/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': 'stratum-flow-scout' },
      body: JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] })
    });
    if (!res.ok) return null;
    var data = await res.json();
    var q    = data && data.quotes && data.quotes[0] ? data.quotes[0] : null;
    if (!q || !q.last) return null;
    return { price: parseFloat(q.last), volume: parseInt(q.volume || 0) };
  } catch(e) { return null; }
}

// -- GET PREV CLOSE FROM TRADESTATION -----------------------
async function getPrevClose(ticker) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;
    var res = await fetch('https://api.tradestation.com/v3/marketdata/barcharts/' + ticker + '?interval=1&unit=Daily&barsback=2&sessiontemplate=Default', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return null;
    var data = await res.json();
    var bars = data && data.Bars ? data.Bars : [];
    if (bars.length < 1) return null;
    // Use second to last bar (yesterday) if market closed, else last bar
    var bar = bars.length >= 2 ? bars[bars.length - 2] : bars[bars.length - 1];
    return parseFloat(bar.Close);
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
  if (!accountId) { console.log('[FINVIZ] No accountId'); return; }

  var token = await getPublicToken();
  if (!token) { console.log('[FINVIZ] No token'); return; }

  var quotes = [];
  for (var i = 0; i < WATCHLIST.length; i++) {
    var ticker    = WATCHLIST[i];
    var live      = await getLivePrice(ticker, token, accountId);
    if (!live || !live.price) continue;
    var prevClose = await getPrevClose(ticker);
    var change    = prevClose ? parseFloat((live.price - prevClose).toFixed(2)) : 0;
    var changePct = prevClose && prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    quotes.push({ ticker: ticker, price: live.price, change: change, changePct: changePct, volume: live.volume });
  }

  console.log('[FINVIZ] Got ' + quotes.length + ' quotes');
  if (quotes.length === 0) return;

  var sorted  = quotes.slice().sort(function(a,b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  var bullish = sorted.filter(function(q) { return q.changePct > 0; }).slice(0,5);
  var bearish = sorted.filter(function(q) { return q.changePct < 0; }).slice(0,5);
  var spy     = quotes.find(function(q) { return q.ticker === 'SPY'; });
  var qqq     = quotes.find(function(q) { return q.ticker === 'QQQ'; });

  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  var out = ['MORNING SCREENER -- ' + date, '==============================='];
  if (spy) out.push('SPY   $' + spy.price + '  ' + (spy.changePct >= 0 ? '+' : '') + spy.changePct + '%  Vol: ' + fmtVol(spy.volume));
  if (qqq) out.push('QQQ   $' + qqq.price + '  ' + (qqq.changePct >= 0 ? '+' : '') + qqq.changePct + '%  Vol: ' + fmtVol(qqq.volume));
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