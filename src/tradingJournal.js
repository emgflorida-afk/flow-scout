// tradingJournal.js - Stratum Flow Scout v7.2
// Daily trading journal -- posts to #trading-journal after market close
// Automatically called at 4PM ET every trading day

var fetch = require('node-fetch');

var JOURNAL_WEBHOOK = process.env.DISCORD_JOURNAL_WEBHOOK ||
  'https://discord.com/api/webhooks/1488702394551238778/u4xe8u7xLuh_4g6-IR1ZSEo41O8Q2QCLEKiC455y_WzXbCmSAiUfIHFMH4_7JljbuT43';

// -- JOURNAL STATE -----------------------------------------------
var journalState = {
  date: '',
  startEquity: 0,
  endEquity: 0,
  realizedPnL: 0,
  unrealizedPnL: 0,
  openPositions: [],
  closedTrades: [],
  systemFailures: [],
  lessonsLearned: [],
  rulesFollowed: [],
  rulesBroken: [],
  grade: '',
  notes: '',
};

function resetJournal(startEquity) {
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  journalState = {
    date: today,
    startEquity: startEquity || 0,
    endEquity: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    openPositions: [],
    closedTrades: [],
    systemFailures: [],
    lessonsLearned: [],
    rulesFollowed: [],
    rulesBroken: [],
    grade: '',
    notes: '',
  };
}

function updateJournal(data) {
  if (data.endEquity)      journalState.endEquity      = data.endEquity;
  if (data.realizedPnL)    journalState.realizedPnL    = data.realizedPnL;
  if (data.unrealizedPnL)  journalState.unrealizedPnL  = data.unrealizedPnL;
  if (data.openPositions)  journalState.openPositions  = data.openPositions;
  if (data.closedTrades)   journalState.closedTrades   = data.closedTrades;
  if (data.notes)          journalState.notes          = data.notes;
}

// -- GRADE THE DAY -----------------------------------------------
function gradeDay(realizedPnL, rulesFollowed, rulesBroken, goal) {
  goal = goal || 300;
  var pctOfGoal = realizedPnL / goal;
  var score = 0;

  // P&L score (50 points)
  if (pctOfGoal >= 1.0)      score += 50;
  else if (pctOfGoal >= 0.5) score += 35;
  else if (pctOfGoal >= 0.0) score += 20;
  else                        score += 0;

  // Discipline score (50 points)
  var disciplineScore = 50 - (rulesBroken * 10);
  score += Math.max(0, disciplineScore);

  if (score >= 90) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

// -- BUILD JOURNAL CARD ------------------------------------------
function buildJournalCard(state) {
  var dayGain = state.endEquity - state.startEquity;
  var grade   = gradeDay(state.realizedPnL, state.rulesFollowed.length, state.rulesBroken.length, 300);

  var lines = [
    '📓 TRADING JOURNAL -- ' + state.date,
    '===============================',
    'GRADE: ' + grade,
    '-------------------------------',
    'ACCOUNT',
    '  Start equity:   $' + (state.startEquity || 0).toFixed(0),
    '  End equity:     $' + (state.endEquity || 0).toFixed(0),
    '  Day gain:       ' + (dayGain >= 0 ? '+' : '') + '$' + dayGain.toFixed(0),
    '  Realized P&L:   ' + (state.realizedPnL >= 0 ? '+' : '') + '$' + (state.realizedPnL || 0).toFixed(0),
    '  Unrealized P&L: ' + (state.unrealizedPnL >= 0 ? '+' : '') + '$' + (state.unrealizedPnL || 0).toFixed(0),
    '-------------------------------',
  ];

  if (state.closedTrades && state.closedTrades.length > 0) {
    lines.push('TRADES CLOSED TODAY:');
    state.closedTrades.forEach(function(t) {
      var icon = t.pnl >= 0 ? '✅' : '❌';
      lines.push('  ' + icon + ' ' + t.symbol + '  ' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl + '  ' + (t.note || ''));
    });
    lines.push('-------------------------------');
  }

  if (state.openPositions && state.openPositions.length > 0) {
    lines.push('HOLDING OVERNIGHT:');
    state.openPositions.forEach(function(p) {
      lines.push('  ' + p.symbol + '  ' + (p.pnl >= 0 ? '+' : '') + '$' + p.pnl + '  ' + (p.note || ''));
    });
    lines.push('-------------------------------');
  }

  if (state.systemFailures && state.systemFailures.length > 0) {
    lines.push('SYSTEM FAILURES TODAY:');
    state.systemFailures.forEach(function(f) { lines.push('  ❌ ' + f); });
    lines.push('-------------------------------');
  }

  if (state.lessonsLearned && state.lessonsLearned.length > 0) {
    lines.push('LESSONS LEARNED:');
    state.lessonsLearned.forEach(function(l) { lines.push('  💡 ' + l); });
    lines.push('-------------------------------');
  }

  if (state.rulesBroken && state.rulesBroken.length > 0) {
    lines.push('RULES BROKEN:');
    state.rulesBroken.forEach(function(r) { lines.push('  ⚠️ ' + r); });
    lines.push('-------------------------------');
  }

  if (state.rulesFollowed && state.rulesFollowed.length > 0) {
    lines.push('RULES FOLLOWED:');
    state.rulesFollowed.forEach(function(r) { lines.push('  ✅ ' + r); });
    lines.push('-------------------------------');
  }

  if (state.notes) {
    lines.push('NOTES:');
    lines.push('  ' + state.notes);
    lines.push('-------------------------------');
  }

  lines.push('Time    ' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  return lines.join('\n');
}

// -- POST TO DISCORD ---------------------------------------------
async function postJournal(card) {
  try {
    await fetch(JOURNAL_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + card + '\n```',
        username: 'Stratum Journal',
      }),
    });
    console.log('[JOURNAL] Posted to #trading-journal OK');
  } catch(e) {
    console.error('[JOURNAL] Error:', e.message);
  }
}

// -- MAIN --------------------------------------------------------
async function writeJournal(data) {
  if (data) updateJournal(data);
  var card = buildJournalCard(journalState);
  await postJournal(card);
  return journalState;
}

module.exports = {
  resetJournal,
  updateJournal,
  writeJournal,
  getState: function() { return journalState; },
};
