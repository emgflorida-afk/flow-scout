// goalTracker.js - Stratum Flow Scout v7.2
// Daily $300 goal tracker -- posts to #goal-tracker channel
// Tracks trades, P&L, and system state (WAIT/IN TRADE/STOP)

var fetch = require('node-fetch');

var GOAL_AMOUNT = 300;
var MAX_LOSS    = -150;
var MAX_TRADES  = 4;

function getWebhook() { return process.env.DISCORD_GOAL_WEBHOOK; }

var state = {
  date:        '',
  trades:      [],
  totalPnL:    0,
  status:      'WAIT',
  goalHit:     false,
  stopHit:     false,
};

function resetIfNewDay() {
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  if (state.date !== today) {
    state.date     = today;
    state.trades   = [];
    state.totalPnL = 0;
    state.status   = 'WAIT';
    state.goalHit  = false;
    state.stopHit  = false;
    console.log('[GOAL] New day -- state reset');
  }
}

function recordTrade(ticker, pnl) {
  resetIfNewDay();
  state.trades.push({ ticker: ticker, pnl: pnl, time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) });
  state.totalPnL += pnl;
  if (state.totalPnL >= GOAL_AMOUNT) { state.goalHit = true; state.status = 'GOAL HIT'; }
  else if (state.totalPnL <= MAX_LOSS)  { state.stopHit = true; state.status = 'STOP TRADING'; }
  else if (state.trades.length >= MAX_TRADES) { state.status = 'MAX TRADES'; }
  else { state.status = 'IN TRADE'; }
  console.log('[GOAL] Trade recorded: ' + ticker + ' ' + (pnl >= 0 ? '+' : '') + pnl + ' | Total: ' + state.totalPnL);
}

function getState() { resetIfNewDay(); return state; }

async function postGoalUpdate() {
  resetIfNewDay();
  var webhook = getWebhook();
  if (!webhook) { console.log('[GOAL] No webhook configured'); return; }

  var pct     = Math.min(100, Math.round((state.totalPnL / GOAL_AMOUNT) * 100));
  var bar     = '';
  var filled  = Math.round(pct / 10);
  for (var i = 0; i < 10; i++) { bar += (i < filled ? '#' : '-'); }

  var statusEmoji = state.goalHit ? 'GOAL HIT' : state.stopHit ? 'STOP TRADING' : state.status === 'IN TRADE' ? 'IN TRADE' : 'WAIT';

  var lines2 = [
    'DAILY GOAL TRACKER',
    state.date,
    '===============================',
    'Goal      $' + GOAL_AMOUNT + '/day',
    'P&L       $' + state.totalPnL.toFixed(2) + ' (' + (pct) + '%)',
    'Progress  [' + bar + '] ' + pct + '%',
    'Status    ' + statusEmoji,
    'Trades    ' + state.trades.length + '/' + MAX_TRADES,
    '-------------------------------',
  ];

  if (state.trades.length > 0) {
    lines2.push('TRADE LOG:');
    state.trades.forEach(function(t) {
      lines2.push('  ' + t.time + '  ' + t.ticker + '  ' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2));
    });
    lines2.push('-------------------------------');
  }

  if (state.goalHit) {
    lines2.push('GOAL REACHED -- STOP TRADING');
    lines2.push('Protect your profits. No more trades today.');
  } else if (state.stopHit) {
    lines2.push('MAX LOSS HIT -- STOP TRADING');
    lines2.push('Walk away. Come back tomorrow.');
  } else {
    lines2.push('Remaining to goal: $' + Math.max(0, GOAL_AMOUNT - state.totalPnL).toFixed(2));
    lines2.push('Max loss remaining: $' + Math.abs(Math.max(0, state.totalPnL - MAX_LOSS)).toFixed(2));
  }

  var message = lines2.join('\n');

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum Goal Tracker' })
    });
    console.log('[GOAL] Posted goal update -- P&L: $' + state.totalPnL.toFixed(2));
  } catch(e) { console.error('[GOAL] Post error:', e.message); }
}

module.exports = { recordTrade: recordTrade, getState: getState, postGoalUpdate: postGoalUpdate };