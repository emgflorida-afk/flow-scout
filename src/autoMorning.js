// autoMorning.js -- Stratum v7.4
// Fully autonomous morning routine
// Runs at 7:30AM ET every trading day
// Pulls live positions, sets macro bias, resets goal tracker
// Posts morning brief to Discord -- zero manual steps

var fetch = require('node-fetch');

var TS_BASE     = 'https://api.tradestation.com/v3';
var ACCOUNT_ID  = '11975462';
var STRAT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// ================================================================
// PULL LIVE POSITIONS FROM TRADESTATION
// ================================================================
async function getLivePositions() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return [];

    var res = await fetch(
      TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/positions',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) return [];
    var data = await res.json();
    return data.Positions || [];
  } catch(e) {
    console.error('[AUTO-MORNING] Positions error:', e.message);
    return [];
  }
}

// ================================================================
// GET SPY 6HR DIRECTION FROM TRADESTATION
// ================================================================
async function get6HRDirection() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return 'MIXED';

    var url = TS_BASE + '/marketdata/barcharts/SPY?unit=Daily&interval=1&barsback=5';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return 'MIXED';

    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return 'MIXED';

    var curr = bars[bars.length - 1];
    var prev = bars[bars.length - 2];

    var close = parseFloat(curr.Close || 0);
    var open  = parseFloat(curr.Open  || 0);
    var prevH = parseFloat(prev.High  || 0);
    var prevL = parseFloat(prev.Low   || 0);

    if (close > open && close > prevH) return 'BULLISH';
    if (close < open && close < prevL) return 'BEARISH';
    if (close > open) return 'BULLISH';
    if (close < open) return 'BEARISH';
    return 'MIXED';
  } catch(e) {
    console.error('[AUTO-MORNING] 6HR error:', e.message);
    return 'MIXED';
  }
}

// ================================================================
// BUILD CONFLICT MAP FROM POSITIONS
// ================================================================
function buildConflictMap(positions) {
  var map = {};
  positions.forEach(function(p) {
    var sym = p.Symbol || '';
    if (!sym.includes(' ')) return; // skip stocks
    var ticker = sym.split(' ')[0];
    var isCall = sym.includes('C');
    var isPut  = sym.includes('P');
    if (!map[ticker]) map[ticker] = [];
    if (isCall && !map[ticker].includes('call')) map[ticker].push('call');
    if (isPut  && !map[ticker].includes('put'))  map[ticker].push('put');
  });
  return map;
}

// ================================================================
// POST MORNING BRIEF TO DISCORD
// ================================================================
async function postMorningBrief(positions, h6Bias, conflictMap, buyingPower) {
  if (!STRAT_WEBHOOK) return;

  var today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric'
  });

  var optPositions = positions.filter(function(p) {
    return p.AssetType === 'OP' || (p.Symbol && p.Symbol.includes(' '));
  });

  var unrealizedPnL = 0;
  optPositions.forEach(function(p) { unrealizedPnL += parseFloat(p.UnrealizedProfitLoss || 0); });

  var conflictTickers = Object.keys(conflictMap);

  var lines = [
    'STRATUM MORNING BRIEF -- ' + today,
    '===============================',
    '6HR BIAS:  ' + h6Bias + ' <- the boss today',
    'DIRECTION: ' + (h6Bias === 'BULLISH' ? 'CALLS ONLY' : h6Bias === 'BEARISH' ? 'PUTS ONLY' : 'MIXED -- wait for clarity'),
    'BUYING PWR: $' + (buyingPower || 0).toFixed(0),
    '-------------------------------',
    'OPEN POSITIONS: ' + optPositions.length,
  ];

  optPositions.forEach(function(p) {
    var pnl  = parseFloat(p.UnrealizedProfitLoss || 0);
    var icon = pnl >= 0 ? '+' : '';
    lines.push('  ' + p.Symbol + '  ' + icon + '$' + pnl.toFixed(0));
  });

  lines.push('-------------------------------');
  lines.push('CONFLICT CHECK: ' + conflictTickers.join(', '));
  lines.push('-------------------------------');
  lines.push('TODAY\'S RULES:');
  lines.push('  Watch #execute-now ONLY');
  lines.push('  ' + (h6Bias === 'BULLISH' ? 'CALLS ONLY -- 6HR bullish' : h6Bias === 'BEARISH' ? 'PUTS ONLY -- 6HR bearish' : 'WAIT for 6HR clarity'));
  lines.push('  Prime time: 9:45AM - 11:00AM ET');
  lines.push('  Retracement entry only (ask x 0.875)');
  lines.push('  Max 5 setups -- stop after goal hit');
  lines.push('-------------------------------');
  lines.push('Time  ' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  var card = lines.join('\n');

  try {
    await fetch(STRAT_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + card + '\n```', username: 'Stratum Morning' }),
    });
    console.log('[AUTO-MORNING] Morning brief posted OK');
  } catch(e) {
    console.error('[AUTO-MORNING] Post error:', e.message);
  }
}

// ================================================================
// PUSH POSITIONS TO CONFLICT CHECK
// ================================================================
async function pushConflictCheck(conflictMap) {
  var RAILWAY_URL = process.env.RAILWAY_URL || 'https://flow-scout-production.up.railway.app';
  var SECRET      = process.env.STRATUM_SECRET || 'stratum2026';
  try {
    await fetch(RAILWAY_URL + '/webhook/positions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-stratum-secret': SECRET },
      body:    JSON.stringify({ positions: conflictMap }),
    });
    console.log('[AUTO-MORNING] Conflict map pushed OK -- ' + Object.keys(conflictMap).length + ' tickers');
  } catch(e) {
    console.error('[AUTO-MORNING] Conflict push error:', e.message);
  }
}

// ================================================================
// RESET GOAL TRACKER
// ================================================================
async function resetGoal() {
  var RAILWAY_URL = process.env.RAILWAY_URL || 'https://flow-scout-production.up.railway.app';
  var SECRET      = process.env.STRATUM_SECRET || 'stratum2026';
  try {
    await fetch(RAILWAY_URL + '/webhook/goal', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-stratum-secret': SECRET },
      body:    JSON.stringify({ realizedPnL: 0, trades: [] }),
    });
    console.log('[AUTO-MORNING] Goal tracker reset OK');
  } catch(e) {
    console.error('[AUTO-MORNING] Goal reset error:', e.message);
  }
}

// ================================================================
// MAIN -- Full autonomous morning routine
// ================================================================
async function runAutoMorning() {
  console.log('[AUTO-MORNING] Starting autonomous morning routine...');

  // Step 1 -- Pull live positions from TradeStation
  var positions    = await getLivePositions();
  var conflictMap  = buildConflictMap(positions);
  console.log('[AUTO-MORNING] Positions pulled: ' + positions.length);

  // Step 2 -- Get 6HR direction (the boss)
  var h6Bias = await get6HRDirection();
  console.log('[AUTO-MORNING] 6HR bias:', h6Bias);

  // Step 3 -- Set macro filter
  var macroFilter = null;
  try { macroFilter = require('./macroFilter'); } catch(e) {}
  if (macroFilter) macroFilter.setManualBias(h6Bias);

  // Step 4 -- Push conflict map to Railway
  await pushConflictCheck(conflictMap);

  // Step 5 -- Reset goal tracker
  await resetGoal();

  // Step 6 -- Get buying power for brief
  var buyingPower = 0;
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (token) {
      var res = await fetch(
        TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/balances',
        { headers: { Authorization: 'Bearer ' + token } }
      );
      if (res.ok) {
        var data = await res.json();
        var bal  = data.Balances && data.Balances[0];
        buyingPower = bal ? parseFloat(bal.BuyingPower || 0) : 0;
      }
    }
  } catch(e) {}

  // Step 7 -- Post morning brief to Discord
  await postMorningBrief(positions, h6Bias, conflictMap, buyingPower);

  console.log('[AUTO-MORNING] Complete. 6HR=' + h6Bias + ' Positions=' + positions.length);
  return { h6Bias, conflictMap, positions: positions.length };
}

module.exports = { runAutoMorning, getLivePositions, get6HRDirection };
