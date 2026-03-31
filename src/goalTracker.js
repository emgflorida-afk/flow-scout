// goalTracker.js - Stratum Flow Scout v7.2
var fetch = require('node-fetch');
var GOAL = 300;
var MAX_LOSS = -150;
var MAX_TRADES = 4;
function getWebhook() { return process.env.DISCORD_GOAL_WEBHOOK; }
var state = { date: '', trades: [], totalPnL: 0, status: 'WAIT', goalHit: false, stopHit: false };
function resetIfNewDay() {
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  if (state.date !== today) {
    state.date = today; state.trades = []; state.totalPnL = 0;
    state.status = 'WAIT'; state.goalHit = false; state.stopHit = false;
    console.log('[GOAL] New day reset');
  }
}
function recordTrade(ticker, pnl) {
  resetIfNewDay();
  var t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  state.trades.push({ ticker: ticker, pnl: pnl, time: t });
  state.totalPnL += pnl;
  if (state.totalPnL >= GOAL) { state.goalHit = true; state.status = 'GOAL HIT'; }
  else if (state.totalPnL <= MAX_LOSS) { state.stopHit = true; state.status = 'STOP TRADING'; }
  else if (state.trades.length >= MAX_TRADES) { state.status = 'MAX TRADES'; }
  else { state.status = 'IN TRADE'; }
}
function getState() { resetIfNewDay(); return state; }
async function postGoalUpdate() {
  resetIfNewDay();
  var webhook = getWebhook();
  if (!webhook) { console.log('[GOAL] No webhook'); return; }
  var pct = Math.min(100, Math.round((state.totalPnL / GOAL) * 100));
  var bar = '';
  for (var i = 0; i < 10; i++) { bar += (i < Math.round(pct / 10) ? '#' : '-'); }
  var lines = [
    'DAILY GOAL TRACKER',
    state.date,
    '===============================',
    'Goal      $' + GOAL + '/day',
    'P&L       $' + state.totalPnL.toFixed(2) + ' (' + pct + '%)',
    'Progress  [' + bar + '] ' + pct + '%',
    'Status    ' + state.status,
    'Trades    ' + state.trades.length + '/' + MAX_TRADES,
    '-------------------------------',
  ];
  if (state.trades.length > 0) {
    lines.push('TRADE LOG:');
    state.trades.forEach(function(t) {
      lines.push('  ' + t.time + '  ' + t.ticker + '  ' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2));
    });
    lines.push('-------------------------------');
  }
  if (state.goalHit) { lines.push('GOAL REACHED -- STOP TRADING'); }
  else if (state.stopHit) { lines.push('MAX LOSS HIT -- STOP TRADING'); }
  else { lines.push('Remaining: $' + Math.max(0, GOAL - state.totalPnL).toFixed(2)); }
  try {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + lines.join('\n') + '\n```', username: 'Stratum Goal Tracker' }) });
    console.log('[GOAL] Posted -- $' + state.totalPnL.toFixed(2));
  } catch(e) { console.error('[GOAL] Error:', e.message); }
}
module.exports = { recordTrade: recordTrade, getState: getState, postGoalUpdate: postGoalUpdate };