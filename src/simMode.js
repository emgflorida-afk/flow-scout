// simMode.js -- Stratum v7.4
// SIM TESTING MODE
// Switches agent to SIM account: SIM3142118M
// Runs identical agent logic on paper money
// Tracks win rate toward 65% target
// When 65%+ confirmed on 20+ trades = ready for live
// Switch back to live: bash stratum.sh sim off

var fetch = require('node-fetch');

var LIVE_ACCOUNT = '11975462';
var SIM_ACCOUNT  = 'SIM3142118M';
var TS_BASE      = 'https://api.tradestation.com/v3';

var simState = {
  enabled:      false,
  account:      LIVE_ACCOUNT,
  tradesPlaced: 0,
  startTime:    null,
};

// ================================================================
// TOGGLE SIM MODE
// ================================================================
async function enableSim() {
  simState.enabled   = true;
  simState.account   = SIM_ACCOUNT;
  simState.startTime = new Date();

  // Tell TradeStation MCP to use SIM
  try {
    var ts = require('./tradestation');
    if (ts.setEnvironment) ts.setEnvironment('sim');
  } catch(e) {}

  // Tell win tracker we are in SIM mode
  try {
    var winTracker = require('./winTracker');
    winTracker.setSimMode(true);
    winTracker.resetStats();
  } catch(e) {}

  console.log('[SIM-MODE] ENABLED -- account:', SIM_ACCOUNT);
  return { enabled: true, account: SIM_ACCOUNT };
}

async function disableSim() {
  // Get final SIM results before switching back
  var report = null;
  try {
    var winTracker = require('./winTracker');
    report = winTracker.buildReport();
    await winTracker.postReport();
    winTracker.setSimMode(false);
  } catch(e) {}

  simState.enabled = false;
  simState.account = LIVE_ACCOUNT;

  // Switch TradeStation back to live
  try {
    var ts = require('./tradestation');
    if (ts.setEnvironment) ts.setEnvironment('live');
  } catch(e) {}

  console.log('[SIM-MODE] DISABLED -- back to live account:', LIVE_ACCOUNT);
  return { enabled: false, account: LIVE_ACCOUNT, finalReport: report };
}

// ================================================================
// GET CURRENT ACCOUNT
// ================================================================
function getAccount() {
  return simState.enabled ? SIM_ACCOUNT : LIVE_ACCOUNT;
}

function isSimMode() {
  return simState.enabled;
}

// ================================================================
// SIM POSITION MONITOR
// Pulls SIM positions and compares to live
// Tracks which SIM trades would have worked on live
// ================================================================
async function getSimPositions() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return [];

    var res = await fetch(
      TS_BASE + '/brokerage/accounts/' + SIM_ACCOUNT + '/positions',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) return [];
    var data = await res.json();
    return data.Positions || [];
  } catch(e) {
    console.error('[SIM-MODE] Position error:', e.message);
    return [];
  }
}

async function getSimBalances() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;

    var res = await fetch(
      TS_BASE + '/brokerage/accounts/' + SIM_ACCOUNT + '/balances',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) return null;
    var data = await res.json();
    var b = data.Balances && data.Balances[0];
    if (!b) return null;
    return {
      equity:      parseFloat(b.Equity || 0),
      buyingPower: parseFloat(b.BuyingPower || 0),
      realizedPnL: parseFloat(b.RealizedProfitLoss || 0),
    };
  } catch(e) {
    console.error('[SIM-MODE] Balance error:', e.message);
    return null;
  }
}

// ================================================================
// BUILD SIM STATUS CARD
// ================================================================
async function buildSimStatus() {
  var positions = await getSimPositions();
  var balances  = await getSimBalances();

  var winTracker = null;
  try { winTracker = require('./winTracker'); } catch(e) {}
  var stats    = winTracker ? winTracker.getStats() : {};
  var winRate  = winTracker ? winTracker.getWinRate() : 0;
  var decided  = (stats.wins || 0) + (stats.losses || 0);

  var optPositions = positions.filter(function(p) {
    return p.Symbol && p.Symbol.includes(' ');
  });

  var lines = [
    'SIM TESTING STATUS',
    '===============================',
    'Account:     ' + SIM_ACCOUNT,
    'Mode:        ' + (simState.enabled ? 'ACTIVE' : 'INACTIVE'),
    'Started:     ' + (simState.startTime ? simState.startTime.toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A'),
    '-------------------------------',
  ];

  if (balances) {
    lines.push('SIM ACCOUNT:');
    lines.push('  Equity:      $' + balances.equity.toFixed(2));
    lines.push('  Buying power: $' + balances.buyingPower.toFixed(2));
    lines.push('  Realized P&L: ' + (balances.realizedPnL >= 0 ? '+' : '') + '$' + balances.realizedPnL.toFixed(2));
    lines.push('-------------------------------');
  }

  lines.push('WIN RATE PROGRESS:');
  lines.push('  Current:  ' + (winRate * 100).toFixed(1) + '%');
  lines.push('  Target:   65%');
  lines.push('  Trades:   ' + decided + ' (need 20+ for confidence)');
  lines.push('  Status:   ' + (decided < 20 ? 'TESTING -- need ' + (20 - decided) + ' more trades' :
                                winRate >= 0.65 ? 'READY FOR LIVE' : 'BELOW TARGET -- keep testing'));

  if (optPositions.length > 0) {
    lines.push('-------------------------------');
    lines.push('OPEN SIM POSITIONS: ' + optPositions.length);
    optPositions.forEach(function(p) {
      var pnl  = parseFloat(p.UnrealizedProfitLoss || 0);
      var icon = pnl >= 0 ? '+' : '';
      lines.push('  ' + p.Symbol + '  ' + icon + '$' + pnl.toFixed(0));
    });
  }

  return lines.join('\n');
}

module.exports = { enableSim, disableSim, getAccount, isSimMode, getSimPositions, getSimBalances, buildSimStatus, SIM_ACCOUNT, LIVE_ACCOUNT };
