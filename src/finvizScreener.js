// finvizScreener.js - Stratum Flow Scout v7.2
var fetch = require('node-fetch');
function getWebhook() { return process.env.DISCORD_SCREENER_WEBHOOK; }
var SCREENER_TICKERS = ['SPY','QQQ','NVDA','TSLA','META','AAPL','AMZN','MSFT','GOOGL','JPM','BAC','WFC','GS','HD','CRM','ORCL','MRVL','DKNG','IWM','PLTR'];
async function postScreenerCard() {
  var webhook = getWebhook();
  if (!webhook) { console.log('[FINVIZ] No webhook'); return; }
  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  var lines = [
    'MORNING SCREENER -- ' + date,
    '===============================',
    'Watchlist: ' + SCREENER_TICKERS.slice(0,10).join(' | '),
    '          ' + SCREENER_TICKERS.slice(10).join(' | '),
    '-------------------------------',
    'Watch for high volume + Strat confluence',
    'Bias: Follow system -- A+ only',
    '-------------------------------',
    'Time: ' + time + ' ET',
  ];
  try {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + lines.join('\n') + '\n```', username: 'Stratum Screener' }) });
    console.log('[FINVIZ] Posted screener card');
  } catch(e) { console.error('[FINVIZ] Error:', e.message); }
}
module.exports = { postScreenerCard: postScreenerCard };