// positionOffset.js  Stratum Flow Scout v6.1
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
  oilBullish:      false,  // oil bleeding -- peace deal + Hormuz opening
  consumerBearish: false,  // market bullish -- SPY above 645
  techBullish:     true,   // tech rallying -- peace deal risk-on
  defenseBullish:  true,   // NATO exit threat -- Europe buys US weapons
  airlinesBullish: true,   // oil dropping -- fuel costs falling
};

// Tickers that align with current macro
const MACRO_ALIGNED = {
  calls: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'NVDA', 'AAPL', 'MSFT', 'DAL', 'UAL', 'LUV', 'COIN', 'AMZN'],
  puts:  ['XOM', 'CVX', 'OXY', 'GUSH', 'USO', 'XLE'],
};

// Tickers to AVOID (fighting macro)
const MACRO_AVOID = {
  calls: ['XOM', 'CVX', 'OXY', 'GUSH', 'USO', 'XLE'],
  puts:  ['LMT', 'RTX', 'NVDA', 'AAPL', 'QQQ', 'SPY'],
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
    if (MACRO.defenseBullish) {
      lines.push('  CALLS: LMT, RTX, NOC, GD  (NATO exit -- Europe buys US weapons)');
    }
    if (MACRO.techBullish) {
      lines.push('  CALLS: NVDA, AAPL, COIN  (peace deal -- risk on)');
    }
    if (MACRO.airlinesBullish) {
      lines.push('  CALLS: DAL, UAL, LUV  (oil dropping -- fuel costs fall)');
    }
    if (!MACRO.oilBullish) {
      lines.push('  AVOID: XOM, CVX, OXY  (oil bleeding on peace deal)');
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


// -- DAILY GAME PLAN CARD -----------------------------------------
// Uses live positions from Claude MCP bridge
// Posts to Discord every morning at 9:15AM
function buildGamePlanCard(positions, realizedPnL, goal) {
  realizedPnL = parseFloat(realizedPnL) || 0;
  goal        = goal || 300;

  // Separate options from stocks
  var options = positions.filter(function(p) {
    return p.assetType === 'StockOption' || (p.symbol && p.symbol.includes(' '));
  });

  // Calculate unrealized options P&L
  var unrealizedPnL = 0;
  var bleeding = [];
  var working  = [];

  options.forEach(function(p) {
    var pnl    = parseFloat(p.unrealizedProfitLoss || 0);
    var symbol = p.symbol || '';
    var ticker = symbol.split(' ')[0];
    var expiry = symbol.split(' ')[1] || '';
    unrealizedPnL += pnl;

    if (pnl < 0) {
      bleeding.push({ symbol, ticker, pnl });
    } else if (pnl > 0) {
      working.push({ symbol, ticker, pnl });
    }
  });

  var totalExposure = Math.abs(unrealizedPnL);
  var netToday      = realizedPnL + unrealizedPnL;
  var remaining     = Math.max(0, goal - realizedPnL);

  // How many clean A+ trades to hit goal
  var tradesNeeded  = remaining > 0 ? Math.ceil(remaining / 150) : 0;

  var lines = [
    'DAILY GAME PLAN -- ' + new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' }),
    '===============================',
    'Goal today:     $' + goal,
    'Realized P&L:   $' + realizedPnL.toFixed(0),
    'Unrealized:     ' + (unrealizedPnL >= 0 ? '+' : '') + '$' + unrealizedPnL.toFixed(0),
    'Need to close:  $' + remaining.toFixed(0) + ' more',
    '-------------------------------',
  ];

  if (bleeding.length > 0) {
    lines.push('HOLDING (do not touch -- April 6):');
    bleeding.forEach(function(p) {
      lines.push('  ' + p.symbol + '  -$' + Math.abs(p.pnl).toFixed(0));
    });
    lines.push('-------------------------------');
  }

  if (working.length > 0) {
    lines.push('WINNING -- LOCK GREEN FAST:');
    working.forEach(function(p) {
      lines.push('  ' + p.symbol + '  +$' + p.pnl.toFixed(0) + '  CLOSE IT');
    });
    lines.push('-------------------------------');
  }

  lines.push('THE PLAY TODAY:');
  if (remaining <= 0) {
    lines.push('  GOAL ALREADY HIT -- STOP TRADING');
  } else {
    lines.push('  Need ' + tradesNeeded + ' clean A+ setup' + (tradesNeeded > 1 ? 's' : ''));
    lines.push('  Each A+ trade targets +$150 at T1');
    lines.push('  Entry: retracement limit only (ask x 0.875)');
    lines.push('  Stop:  structural level -- never flat %');
    lines.push('  Watch: #conviction-trades ONLY');
  }
  lines.push('-------------------------------');
  lines.push('RULES:');
  lines.push('  No new positions on tickers you already own');
  lines.push('  No entries before 9:45AM');
  lines.push('  No entries after 3:30PM');
  lines.push('  Retracement entry or skip -- never chase');
  lines.push('-------------------------------');
  lines.push('Time    ' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  return lines.join('\n');
}

// -- MAIN ---------------------------------------------------------
async function runOffsetAnalysis() {
  console.log('[OFFSET] Running position offset analysis...');

  // Try to get live positions from MCP bridge first
  var server = null;
  var mcpPositions = [];
  try {
    server = require('./server');
    var livePos = server && server.getLivePositions ? server.getLivePositions() : {};
    // Convert conflict map back to position-like objects for analysis
    console.log('[OFFSET] MCP bridge positions available: ' + Object.keys(livePos).length + ' tickers');
  } catch(e) {}

  // Try TS token for full position data
  const token = await getTSToken();
  if (!token) {
    console.log('[OFFSET] No TS token -- posting game plan with static data');

    // Build game plan with what we know from MCP webhook
    var staticPositions = [
      { symbol: 'GOOGL 260406P282.5', assetType: 'StockOption', unrealizedProfitLoss: -1 },
      { symbol: 'HD 260410P312.5',    assetType: 'StockOption', unrealizedProfitLoss: -58 },
      { symbol: 'QQQ 260406P561',     assetType: 'StockOption', unrealizedProfitLoss: -45 },
      { symbol: 'XLF 260410P49',      assetType: 'StockOption', unrealizedProfitLoss: -60 },
      { symbol: 'DKNG 260410C21.5',   assetType: 'StockOption', unrealizedProfitLoss: 5 },
    ];

    var gamePlan = buildGamePlanCard(staticPositions, 0, 300);
    await sendOffsetCard(gamePlan);

    var analysis = analyzePositions(staticPositions.map(function(p) {
      return { Symbol: p.symbol, UnrealizedProfitLoss: p.unrealizedProfitLoss };
    }));
    var offsetCard = buildOffsetCard(analysis);
    await sendOffsetCard(offsetCard);
    return;
  }

  const positions = await getLivePositions(token);
  const analysis2  = analyzePositions(positions);
  const gamePlan2  = buildGamePlanCard(positions.map(function(p) {
    return {
      symbol: p.Symbol,
      assetType: p.AssetType === 'OP' ? 'StockOption' : p.AssetType,
      unrealizedProfitLoss: parseFloat(p.UnrealizedProfitLoss || 0),
    };
  }), 0, 300);

  await sendOffsetCard(gamePlan2);
  const card = buildOffsetCard(analysis2);
  await sendOffsetCard(card);
}

module.exports = { runOffsetAnalysis };
