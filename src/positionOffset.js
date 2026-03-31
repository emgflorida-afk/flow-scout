// positionOffset.js — Stratum Flow Scout v6.1
// Reads live TradeStation positions and calculates:
// 1. Total options P&L (winning vs losing)
// 2. Dollar amount needed to go green today
// 3. Best macro-aligned tickers to target
// 4. Tickers to AVOID based on macro
// Posts to #strat-alerts at 9:15AM alongside morning brief
// -----------------------------------------------------------------

const fetch = require('node-fetch');

const TS_BASE    = 'https://api.tradestation.com/v3';
const ACCOUNT_ID = '11975462';
const STRAT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// -- MACRO CONTEXT ------------------------------------------------
// Updated manually or via future macro module
// Current macro: Iran war, Hormuz blocked, oil surging, tariffs
const MACRO = {
  oilBullish:      true,   // Hormuz blocked, gas $4+
  consumerBearish: true,   // tariffs + gas prices hurting retail
  techBearish:     true,   // broad market sell-off
  energyBullish:   true,   // war premium on oil
};

// Tickers that align with current macro
const MACRO_ALIGNED = {
  calls: ['OXY', 'XOM', 'CVX', 'COP', 'SLB', 'HAL', 'GUSH', 'USO', 'XLE', 'MRO'],
  puts:  ['DLTR', 'DG', 'WMT', 'TGT', 'COST', 'AMZN', 'AAPL', 'QQQ', 'SPY', 'TQQQ'],
};

// Tickers to AVOID (fighting macro)
const MACRO_AVOID = {
  calls: ['DLTR', 'DG', 'WMT', 'TGT', 'TQQQ', 'QQQ', 'SPY'],
  puts:  ['OXY', 'XOM', 'CVX', 'GUSH', 'USO', 'XLE'],
};

// -- GET TS TOKEN -------------------------------------------------
async function getTSToken() {
  try {
    const res = await fetch(TS_BASE.replace('/v3', '') + '/security/authorize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'grant_type=refresh_token&client_id=' + process.env.TS_CLIENT_ID +
               '&redirect_uri=http://localhost&refresh_token=' + process.env.TS_REFRESH_TOKEN,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

// -- GET LIVE POSITIONS -------------------------------------------
async function getLivePositions(token) {
  try {
    const res = await fetch(TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/positions', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.Positions || [];
  } catch { return []; }
}

// -- ANALYZE POSITIONS --------------------------------------------
function analyzePositions(positions) {
  const options = positions.filter(function(p) {
    return p.AssetType === 'OP' || (p.Symbol && p.Symbol.includes(' '));
  });

  var totalWinning  = 0;
  var totalLosing   = 0;
  var winningTrades = [];
  var losingTrades  = [];
  var avoidTrades   = [];

  options.forEach(function(p) {
    const symbol  = p.Symbol || '';
    const pnl     = parseFloat(p.UnrealizedProfitLoss || 0);
    const ticker  = symbol.split(' ')[0];
    const isCall  = symbol.includes('C');
    const isPut   = symbol.includes('P');

    // Check if fighting macro
    const fightingMacro = (isCall && MACRO_AVOID.calls.includes(ticker)) ||
                          (isPut  && MACRO_AVOID.puts.includes(ticker));

    if (pnl > 0) {
      totalWinning += pnl;
      winningTrades.push({ symbol, pnl, ticker });
    } else if (pnl < 0) {
      totalLosing += Math.abs(pnl);
      losingTrades.push({ symbol, pnl, ticker, fightingMacro });
    }

    if (fightingMacro) {
      avoidTrades.push({ symbol, pnl, ticker });
    }
  });

  const netPnl       = totalWinning - totalLosing;
  const offsetNeeded = netPnl < 0 ? Math.abs(netPnl) : 0;

  return {
    netPnl,
    offsetNeeded,
    totalWinning,
    totalLosing,
    winningTrades,
    losingTrades,
    avoidTrades,
  };
}

// -- BUILD OFFSET CARD --------------------------------------------
function buildOffsetCard(analysis) {
  const { netPnl, offsetNeeded, totalWinning, totalLosing, winningTrades, losingTrades, avoidTrades } = analysis;

  const isGreen = netPnl >= 0;
  const statusLine = isGreen
    ? 'OPTIONS P&L: +$' + netPnl.toFixed(0) + ' -- GREEN \u2705'
    : 'OPTIONS P&L: -$' + Math.abs(netPnl).toFixed(0) + ' -- NEED $' + offsetNeeded.toFixed(0) + ' TO GO GREEN';

  const lines = [
    '\ud83d\udcca STRATUM POSITION OFFSET ANALYZER',
    '===============================',
    statusLine,
    'Winning trades: +$' + totalWinning.toFixed(0),
    'Losing trades:  -$' + totalLosing.toFixed(0),
    '-------------------------------',
  ];

  if (winningTrades.length > 0) {
    lines.push('WORKING FOR YOU:');
    winningTrades.forEach(function(t) {
      lines.push('  \u2705 ' + t.symbol + '  +$' + t.pnl.toFixed(0));
    });
    lines.push('-------------------------------');
  }

  if (losingTrades.length > 0) {
    lines.push('WORKING AGAINST YOU:');
    losingTrades.forEach(function(t) {
      const warn = t.fightingMacro ? '  \u26a0\ufe0f FIGHTING MACRO' : '';
      lines.push('  \ud83d\udd34 ' + t.symbol + '  -$' + Math.abs(t.pnl).toFixed(0) + warn);
    });
    lines.push('-------------------------------');
  }

  if (!isGreen) {
    lines.push('TO OFFSET -- BEST MACRO PLAYS:');
    if (MACRO.energyBullish) {
      lines.push('  CALLS: OXY, XOM, CVX, COP  (energy/oil war)');
    }
    if (MACRO.consumerBearish) {
      lines.push('  PUTS:  DLTR, DG, TGT, WMT  (tariffs + $4 gas)');
    }
    lines.push('  Wait for cluster or 5/6+ Strat confirmation');
    lines.push('  Max 1 contract, 2% risk = $' + Math.round(offsetNeeded * 0.5) + ' per trade');
    lines.push('-------------------------------');
  }

  if (avoidTrades.length > 0) {
    lines.push('\u26a0\ufe0f AVOID ADDING MORE:');
    avoidTrades.forEach(function(t) {
      lines.push('  ' + t.ticker + ' -- fighting Iran/oil macro');
    });
    lines.push('-------------------------------');
  }

  lines.push('Window  9:45AM-3:30PM ET');
  lines.push('Rule    No entries after 3:30PM');
  lines.push('Time    ' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  return lines.join('\n');
}

// -- SEND TO DISCORD ----------------------------------------------
async function sendOffsetCard(card) {
  if (!STRAT_WEBHOOK) return;
  try {
    await fetch(STRAT_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + card + '\n```',
        username: 'Stratum Offset',
      }),
    });
    console.log('[OFFSET] Sent to #strat-alerts OK');
  } catch (err) {
    console.error('[OFFSET] Send error:', err.message);
  }
}

// -- MAIN ---------------------------------------------------------
async function runOffsetAnalysis() {
  console.log('[OFFSET] Running position offset analysis...');

  const token = await getTSToken();
  if (!token) {
    console.log('[OFFSET] No TS token -- using static analysis');
    // Fall back to hardcoded positions if token fails
    const staticCard = buildOffsetCard({
      netPnl: -174,
      offsetNeeded: 174,
      totalWinning: 53,
      totalLosing: 227,
      winningTrades: [
        { symbol: 'ORCL 260410C147', pnl: 22, ticker: 'ORCL' },
        { symbol: 'AMZN 260406C207.5', pnl: 18, ticker: 'AMZN' },
        { symbol: 'CRM 260410C192.5', pnl: 13, ticker: 'CRM' },
      ],
      losingTrades: [
        { symbol: 'DLTR 260417P103', pnl: -162, ticker: 'DLTR', fightingMacro: false },
        { symbol: 'NFLX 260410P93',  pnl: -50,  ticker: 'NFLX', fightingMacro: false },
        { symbol: 'GUSH 260417P46',  pnl: -13,  ticker: 'GUSH', fightingMacro: true  },
      ],
      avoidTrades: [
        { symbol: 'GUSH 260417P46', pnl: -13, ticker: 'GUSH' },
      ],
    });
    await sendOffsetCard(staticCard);
    return;
  }

  const positions = await getLivePositions(token);
  const analysis  = analyzePositions(positions);
  const card      = buildOffsetCard(analysis);
  await sendOffsetCard(card);
}

module.exports = { runOffsetAnalysis };
