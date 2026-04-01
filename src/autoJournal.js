// autoJournal.js -- Stratum v7.4
// Fully autonomous journal -- pulls live data from TradeStation
// Posts complete journal to #trading-journal at 4PM daily
// Zero manual input needed

var fetch = require('node-fetch');

var JOURNAL_WEBHOOK = process.env.DISCORD_JOURNAL_WEBHOOK ||
  'https://discord.com/api/webhooks/1488702394551238778/u4xe8u7xLuh_4g6-IR1ZSEo41O8Q2QCLEKiC455y_WzXbCmSAiUfIHFMH4_7JljbuT43';

var TS_BASE    = 'https://api.tradestation.com/v3';
var ACCOUNT_ID = '11975462';

// ================================================================
// PULL LIVE DATA FROM TRADESTATION
// ================================================================
async function getLiveData() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;

    var headers = { Authorization: 'Bearer ' + token };

    // Pull balances
    var balRes = await fetch(TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/balances', { headers });
    var balData = balRes.ok ? await balRes.json() : null;
    var bal = balData && balData.Balances && balData.Balances[0];

    // Pull positions
    var posRes = await fetch(TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/positions', { headers });
    var posData = posRes.ok ? await posRes.json() : null;
    var positions = posData && posData.Positions ? posData.Positions : [];

    // Pull today's orders
    var today = new Date().toISOString().split('T')[0];
    var ordRes = await fetch(
      TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/historicalorders?since=' + today,
      { headers }
    );
    var ordData = ordRes.ok ? await ordRes.json() : null;
    var orders = ordData && ordData.Orders ? ordData.Orders : [];

    return { bal, positions, orders };
  } catch(e) {
    console.error('[AUTO-JOURNAL] Data pull error:', e.message);
    return null;
  }
}

// ================================================================
// GRADE THE DAY
// ================================================================
function gradeDay(realizedPnL, rulesBroken, goal) {
  goal = goal || 300;
  var pctOfGoal = realizedPnL / goal;
  var score = 0;

  if (pctOfGoal >= 1.0)      score += 50;
  else if (pctOfGoal >= 0.5) score += 35;
  else if (pctOfGoal >= 0.0) score += 20;
  else                        score += 0;

  var disciplineScore = 50 - (rulesBroken * 10);
  score += Math.max(0, disciplineScore);

  if (score >= 90) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

// ================================================================
// BUILD JOURNAL FROM LIVE DATA
// ================================================================
function buildJournal(data, bodEquity) {
  var bal       = data.bal;
  var positions = data.positions || [];
  var orders    = data.orders || [];

  var today     = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  var currentEquity  = bal ? parseFloat(bal.Equity || 0) : 0;
  var realizedPnL    = bal ? parseFloat(bal.RealizedProfitLoss || 0) : 0;
  var unrealizedPnL  = bal ? parseFloat(bal.UnrealizedProfitLoss || 0) : 0;
  var buyingPower    = bal ? parseFloat(bal.BuyingPower || 0) : 0;
  var dayChange      = currentEquity - (bodEquity || currentEquity);

  // Separate options from stocks
  var optPositions   = positions.filter(function(p) {
    return p.AssetType === 'OP' || (p.Symbol && p.Symbol.includes(' '));
  });

  // Calculate options P&L
  var optWinners = optPositions.filter(function(p) { return parseFloat(p.UnrealizedProfitLoss || 0) > 0; });
  var optLosers  = optPositions.filter(function(p) { return parseFloat(p.UnrealizedProfitLoss || 0) < 0; });

  // Filled orders today
  var filled = orders.filter(function(o) { return o.Status === 'FLL' || o.Status === 'DON'; });

  // Grade the day
  var grade = gradeDay(realizedPnL, 0, 300);

  var lines = [
    'TRADING JOURNAL -- ' + today,
    '===============================',
    'GRADE: ' + grade,
    '-------------------------------',
    'ACCOUNT',
    '  Equity:          $' + currentEquity.toFixed(2),
    '  Day change:       ' + (dayChange >= 0 ? '+' : '') + '$' + dayChange.toFixed(2),
    '  Realized P&L:    ' + (realizedPnL >= 0 ? '+' : '') + '$' + realizedPnL.toFixed(2),
    '  Unrealized P&L:  ' + (unrealizedPnL >= 0 ? '+' : '') + '$' + unrealizedPnL.toFixed(2),
    '  Buying power:    $' + buyingPower.toFixed(2),
    '-------------------------------',
  ];

  // Filled orders
  if (filled.length > 0) {
    lines.push('ORDERS FILLED TODAY: ' + filled.length);
    filled.forEach(function(o) {
      var sym    = o.Legs && o.Legs[0] ? o.Legs[0].Symbol : o.Symbol;
      var action = o.Legs && o.Legs[0] ? o.Legs[0].BuyOrSell : '';
      var price  = o.FilledPrice || o.LimitPrice || '';
      lines.push('  ' + action + ' ' + sym + ' @ $' + price);
    });
    lines.push('-------------------------------');
  }

  // Open options
  if (optPositions.length > 0) {
    lines.push('HOLDING OVERNIGHT: ' + optPositions.length + ' options');
    optPositions.forEach(function(p) {
      var pnl  = parseFloat(p.UnrealizedProfitLoss || 0);
      var icon = pnl >= 0 ? '+' : '';
      lines.push('  ' + p.Symbol + '  ' + icon + '$' + pnl.toFixed(0));
    });
    lines.push('-------------------------------');
  }

  // Winners and losers
  if (optWinners.length > 0) {
    lines.push('WINNING:');
    optWinners.forEach(function(p) {
      lines.push('  + ' + p.Symbol + '  +$' + parseFloat(p.UnrealizedProfitLoss).toFixed(0));
    });
  }
  if (optLosers.length > 0) {
    lines.push('LOSING:');
    optLosers.forEach(function(p) {
      lines.push('  - ' + p.Symbol + '  -$' + Math.abs(parseFloat(p.UnrealizedProfitLoss)).toFixed(0));
    });
    lines.push('-------------------------------');
  }

  lines.push('Posted: ' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  return lines.join('\n');
}

// ================================================================
// POST TO DISCORD
// ================================================================
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
    console.log('[AUTO-JOURNAL] Posted OK');
  } catch(e) {
    console.error('[AUTO-JOURNAL] Post error:', e.message);
  }
}

// ================================================================
// MAIN
// ================================================================
async function writeAutoJournal(bodEquity) {
  console.log('[AUTO-JOURNAL] Running...');
  var data = await getLiveData();
  if (!data) {
    console.log('[AUTO-JOURNAL] No TS data -- skipping');
    return;
  }
  var card = buildJournal(data, bodEquity);
  await postJournal(card);
  return card;
}

module.exports = { writeAutoJournal };
