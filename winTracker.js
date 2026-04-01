// winTracker.js -- Stratum v7.4
// WIN RATE TRACKER
// Tracks every trade: entry, exit, grade, result
// Calculates running win rate toward 65% target
// Posts win rate report to Discord daily
// Powers SIM testing analysis

var fetch = require('node-fetch');

var JOURNAL_WEBHOOK = process.env.DISCORD_JOURNAL_WEBHOOK ||
  'https://discord.com/api/webhooks/1488702394551238778/u4xe8u7xLuh_4g6-IR1ZSEo41O8Q2QCLEKiC455y_WzXbCmSAiUfIHFMH4_7JljbuT43';

var WIN_RATE_TARGET = 0.65; // 65% win rate goal

// In-memory trade log -- persists during Railway session
// Resets on redeploy -- use daily journal for permanent record
var tradeLog = [];
var sessionStats = {
  totalTrades:  0,
  wins:         0,
  losses:       0,
  breakeven:    0,
  totalPnL:     0,
  byGrade:      { 'A+': { trades: 0, wins: 0, pnl: 0 }, 'A': { trades: 0, wins: 0, pnl: 0 }, 'B': { trades: 0, wins: 0, pnl: 0 } },
  byTicker:     {},
  byStrategy:   { STRAT: { trades: 0, wins: 0 }, FLOW: { trades: 0, wins: 0 }, BOTH: { trades: 0, wins: 0 } },
  simMode:      false,
};

// ================================================================
// LOG A TRADE ENTRY
// ================================================================
function logEntry(signal, decision, resolved) {
  var trade = {
    id:         Date.now(),
    ticker:     signal.ticker,
    type:       signal.type,
    grade:      decision.grade,
    contracts:  decision.contracts || 1,
    strategy:   signal.hasFlow ? 'BOTH' : (signal.strategy || 'STRAT'),
    entryPrice: resolved && resolved.limit ? parseFloat(resolved.limit) : null,
    entryTime:  new Date().toISOString(),
    exitPrice:  null,
    exitTime:   null,
    pnl:        null,
    result:     null, // WIN, LOSS, BREAKEVEN
    exitReason: null, // T1, T2, STOP, MANUAL
    h6Bias:     signal.h6bias || 'MIXED',
    simMode:    sessionStats.simMode,
  };

  tradeLog.push(trade);
  sessionStats.totalTrades++;

  if (!sessionStats.byTicker[signal.ticker]) {
    sessionStats.byTicker[signal.ticker] = { trades: 0, wins: 0, pnl: 0 };
  }
  sessionStats.byTicker[signal.ticker].trades++;

  console.log('[WIN-TRACKER] Entry logged:', signal.ticker, decision.grade, '#' + trade.id);
  return trade.id;
}

// ================================================================
// LOG A TRADE EXIT
// ================================================================
function logExit(tradeId, exitPrice, exitReason) {
  var trade = tradeLog.find(function(t) { return t.id === tradeId; });
  if (!trade) {
    console.log('[WIN-TRACKER] Trade not found:', tradeId);
    return;
  }

  trade.exitPrice  = exitPrice;
  trade.exitTime   = new Date().toISOString();
  trade.exitReason = exitReason || 'MANUAL';

  if (trade.entryPrice && exitPrice) {
    trade.pnl = (exitPrice - trade.entryPrice) * 100 * trade.contracts;
    if (trade.type === 'put') trade.pnl = (trade.entryPrice - exitPrice) * 100 * trade.contracts;
  }

  if (trade.pnl > 5)         { trade.result = 'WIN';       sessionStats.wins++; }
  else if (trade.pnl < -5)   { trade.result = 'LOSS';      sessionStats.losses++; }
  else                        { trade.result = 'BREAKEVEN'; sessionStats.breakeven++; }

  sessionStats.totalPnL += (trade.pnl || 0);

  // Update grade stats
  if (sessionStats.byGrade[trade.grade]) {
    sessionStats.byGrade[trade.grade].trades++;
    if (trade.result === 'WIN') sessionStats.byGrade[trade.grade].wins++;
    sessionStats.byGrade[trade.grade].pnl += (trade.pnl || 0);
  }

  // Update ticker stats
  if (sessionStats.byTicker[trade.ticker]) {
    if (trade.result === 'WIN') sessionStats.byTicker[trade.ticker].wins++;
    sessionStats.byTicker[trade.ticker].pnl += (trade.pnl || 0);
  }

  // Update strategy stats
  if (sessionStats.byStrategy[trade.strategy]) {
    sessionStats.byStrategy[trade.strategy].trades++;
    if (trade.result === 'WIN') sessionStats.byStrategy[trade.strategy].wins++;
  }

  console.log('[WIN-TRACKER] Exit logged:', trade.ticker, trade.result, '$' + (trade.pnl || 0).toFixed(0));
  return trade;
}

// ================================================================
// CALCULATE WIN RATE
// ================================================================
function getWinRate() {
  var decided = sessionStats.wins + sessionStats.losses;
  if (decided === 0) return 0;
  return sessionStats.wins / decided;
}

function getGradeWinRate(grade) {
  var g = sessionStats.byGrade[grade];
  if (!g || g.trades === 0) return 0;
  return g.wins / g.trades;
}

// ================================================================
// BUILD WIN RATE REPORT
// ================================================================
function buildReport() {
  var winRate  = getWinRate();
  var decided  = sessionStats.wins + sessionStats.losses;
  var target   = WIN_RATE_TARGET;
  var gap      = target - winRate;
  var onTrack  = winRate >= target;
  var mode     = sessionStats.simMode ? 'SIM' : 'LIVE';

  var lines = [
    'WIN RATE REPORT -- ' + mode + ' MODE',
    '===============================',
    'Overall Win Rate:  ' + (winRate * 100).toFixed(1) + '%',
    'Target:            ' + (target * 100).toFixed(0) + '%',
    'Status:            ' + (onTrack ? 'ON TRACK' : gap > 0 ? (gap * 100).toFixed(1) + '% below target' : 'ABOVE TARGET'),
    '-------------------------------',
    'Total trades:  ' + sessionStats.totalTrades,
    'Wins:          ' + sessionStats.wins,
    'Losses:        ' + sessionStats.losses,
    'Breakeven:     ' + sessionStats.breakeven,
    'Total P&L:     ' + (sessionStats.totalPnL >= 0 ? '+' : '') + '$' + sessionStats.totalPnL.toFixed(0),
    '-------------------------------',
    'BY GRADE:',
    '  A+  ' + (getGradeWinRate('A+') * 100).toFixed(0) + '% win  ' + sessionStats.byGrade['A+'].trades + ' trades  $' + sessionStats.byGrade['A+'].pnl.toFixed(0),
    '  A   ' + (getGradeWinRate('A') * 100).toFixed(0) + '% win  ' + sessionStats.byGrade['A'].trades + ' trades  $' + sessionStats.byGrade['A'].pnl.toFixed(0),
    '-------------------------------',
    'BY STRATEGY:',
    '  Strat+Flow  ' + (sessionStats.byStrategy.BOTH.trades > 0 ? ((sessionStats.byStrategy.BOTH.wins / sessionStats.byStrategy.BOTH.trades) * 100).toFixed(0) : '0') + '% win  ' + sessionStats.byStrategy.BOTH.trades + ' trades',
    '  Strat only  ' + (sessionStats.byStrategy.STRAT.trades > 0 ? ((sessionStats.byStrategy.STRAT.wins / sessionStats.byStrategy.STRAT.trades) * 100).toFixed(0) : '0') + '% win  ' + sessionStats.byStrategy.STRAT.trades + ' trades',
  ];

  // Top tickers by win rate
  var tickers = Object.keys(sessionStats.byTicker)
    .filter(function(t) { return sessionStats.byTicker[t].trades >= 2; })
    .sort(function(a, b) {
      var wa = sessionStats.byTicker[a].wins / sessionStats.byTicker[a].trades;
      var wb = sessionStats.byTicker[b].wins / sessionStats.byTicker[b].trades;
      return wb - wa;
    }).slice(0, 5);

  if (tickers.length > 0) {
    lines.push('-------------------------------');
    lines.push('TOP TICKERS:');
    tickers.forEach(function(t) {
      var stats = sessionStats.byTicker[t];
      var wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(0) : '0';
      lines.push('  ' + t + '  ' + wr + '% win  ' + stats.trades + ' trades  $' + stats.pnl.toFixed(0));
    });
  }

  // SIM vs Live recommendation
  if (sessionStats.simMode && decided >= 10) {
    lines.push('-------------------------------');
    if (winRate >= target) {
      lines.push('SIM RESULT: READY FOR LIVE TRADING');
      lines.push('Win rate ' + (winRate * 100).toFixed(1) + '% exceeds ' + (target * 100).toFixed(0) + '% target');
    } else {
      lines.push('SIM RESULT: CONTINUE TESTING');
      lines.push('Need ' + (target * 100).toFixed(0) + '% win rate -- currently at ' + (winRate * 100).toFixed(1) + '%');
      lines.push('Identify losing patterns and refine agent prompt');
    }
  }

  return lines.join('\n');
}

// ================================================================
// POST WIN RATE REPORT TO DISCORD
// ================================================================
async function postReport() {
  var card = buildReport();
  try {
    await fetch(JOURNAL_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + card + '\n```', username: 'Stratum Win Rate' }),
    });
    console.log('[WIN-TRACKER] Report posted OK');
  } catch(e) {
    console.error('[WIN-TRACKER] Post error:', e.message);
  }
  return card;
}

// ================================================================
// SIM MODE TOGGLE
// ================================================================
function setSimMode(enabled) {
  sessionStats.simMode = enabled;
  console.log('[WIN-TRACKER] SIM mode:', enabled ? 'ON' : 'OFF');
}

function resetStats() {
  tradeLog = [];
  sessionStats = {
    totalTrades: 0, wins: 0, losses: 0, breakeven: 0, totalPnL: 0,
    byGrade:    { 'A+': { trades: 0, wins: 0, pnl: 0 }, 'A': { trades: 0, wins: 0, pnl: 0 }, 'B': { trades: 0, wins: 0, pnl: 0 } },
    byTicker:   {},
    byStrategy: { STRAT: { trades: 0, wins: 0 }, BOTH: { trades: 0, wins: 0 } },
    simMode:    sessionStats.simMode,
  };
  console.log('[WIN-TRACKER] Stats reset');
}

module.exports = { logEntry, logExit, getWinRate, getGradeWinRate, buildReport, postReport, setSimMode, resetStats, getStats: function() { return sessionStats; } };
