// brainEngine.js - Stratum Flow Scout v8.2
// BRAIN ENGINE: Autonomous trading decision state machine
// Cycles through strategies to hit daily P&L target
// Tracks what's working, adapts, and posts decisions to Discord
// Does NOT auto-execute -- logs recommendations only (execution added later)
// -----------------------------------------------------------------

var fetch = require('node-fetch');

// -- LOAD DEPENDENT MODULES (safe require) -------------------------
var bottomTick = null;
var bullflow = null;
var catalystScanner = null;
var resolver = null;

try { bottomTick = require('./bottomTick'); } catch(e) { console.log('[BRAIN] bottomTick not loaded:', e.message); }
try { bullflow = require('./bullflowStream'); } catch(e) { console.log('[BRAIN] bullflowStream not loaded:', e.message); }
try { catalystScanner = require('./catalystScanner'); } catch(e) { console.log('[BRAIN] catalystScanner not loaded:', e.message); }
try { resolver = require('./contractResolver'); } catch(e) { console.log('[BRAIN] contractResolver not loaded:', e.message); }

// -- DISCORD WEBHOOK ------------------------------------------------
var BRAIN_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// -- WATCHLISTS (priority order) ------------------------------------
var CORE_WATCHLIST = ['SPY', 'QQQ', 'IWM']; // Casey method -- indices first
var FLOW_WATCHLIST = ['NVDA', 'AMZN', 'META', 'TSLA', 'AAPL', 'INTC', 'MRVL', 'AMD'];
var FULL_WATCHLIST = CORE_WATCHLIST.concat(FLOW_WATCHLIST);

// -- STATE MACHINE --------------------------------------------------
var STATE = 'PRE_MARKET';
var dailyPL = 0;
var dailyTarget = 500;
var minTarget = 300;
var maxDailyLoss = -200;
var tradesOpened = 0;
var maxTrades = 3;
var activePositions = [];
var contractSize = 3; // default 3 contracts per trade
var trimPlan = { first: 0.50, second: 1.00 }; // +50%, +100%
var strategies = ['SCANNER_BREAKOUT', 'FLOW_CONVICTION', 'SCALP'];
var currentStrategy = 0;

// -- BRAIN ACTIVE FLAG (must be started explicitly) -----------------
var brainActive = false;
var cycleCount = 0;
var lastCycleTime = null;
var todayCatalysts = null;
var brainLog = []; // rolling log of brain decisions (last 50)
var MAX_LOG = 50;

// ===================================================================
// UTILITY: Get current ET time info
// ===================================================================
function getETTime() {
  var now = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  var etMin = now.getUTCMinutes();
  var etTime = etHour * 60 + etMin;
  return { hour: etHour, min: etMin, total: etTime, now: now };
}

// ===================================================================
// UTILITY: Format time as ET string
// ===================================================================
function formatET() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' ET';
}

// ===================================================================
// UTILITY: Log a brain decision
// ===================================================================
function logBrain(msg) {
  var entry = '[' + formatET() + '] ' + msg;
  console.log('[BRAIN] ' + msg);
  brainLog.push(entry);
  if (brainLog.length > MAX_LOG) {
    brainLog = brainLog.slice(brainLog.length - MAX_LOG);
  }
}

// ===================================================================
// POST TO DISCORD
// ===================================================================
async function postToDiscord(message) {
  try {
    var webhook = BRAIN_WEBHOOK;
    if (!webhook) { console.log('[BRAIN] No webhook configured'); return; }
    var fullMsg = '\uD83E\uDDE0 BRAIN ENGINE\n' + message;
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + fullMsg + '\n```', username: 'Stratum Brain' }),
    });
  } catch(e) { console.error('[BRAIN] Discord post error:', e.message); }
}

// ===================================================================
// STATE TRANSITION
// ===================================================================
function transitionTo(newState, reason) {
  var oldState = STATE;
  STATE = newState;
  logBrain('STATE: ' + oldState + ' -> ' + newState + ' | ' + reason);
}

// ===================================================================
// EVALUATE SCANNER SIGNAL
// Pulls latest scan data from bottomTick scanner
// Checks for 2+ timeframe confluence on priority tickers
// ===================================================================
async function evaluateScannerSignal() {
  if (!bottomTick) {
    logBrain('Scanner not available -- bottomTick not loaded');
    return { triggered: false, reason: 'Scanner not loaded' };
  }

  try {
    logBrain('Scanning all tickers via bottomTick...');
    var scanResults = await bottomTick.scanAll();
    var results = scanResults.results || [];

    if (results.length === 0) {
      logBrain('Scanner: No setups found across ' + (scanResults.scanned || 0) + ' tickers');
      return { triggered: false, reason: 'No setups found' };
    }

    // Check priority tickers first (CORE then FLOW watchlist)
    for (var w = 0; w < FULL_WATCHLIST.length; w++) {
      var target = FULL_WATCHLIST[w];
      for (var r = 0; r < results.length; r++) {
        var result = results[r];
        if (result.symbol !== target) continue;
        if (!result.setups || result.setups.length === 0) continue;

        // Count unique timeframes with setups
        var timeframes = {};
        for (var s = 0; s < result.setups.length; s++) {
          timeframes[result.setups[s].timeframe] = result.setups[s];
        }
        var tfCount = Object.keys(timeframes).length;

        // Need 2+ timeframe confluence
        if (tfCount >= 2) {
          // Pick the highest timeframe setup as the primary signal
          var primary = timeframes['DAILY'] || timeframes['2HR'] || timeframes['30MIN'];
          if (!primary) primary = result.setups[0];

          var signal = {
            triggered: true,
            ticker: result.symbol,
            direction: primary.direction,
            action: primary.action,
            trigger: primary.trigger,
            stop: primary.stop,
            timeframes: Object.keys(timeframes),
            tfCount: tfCount,
            nearLevel: result.nearLevel,
            price: result.price,
            setupType: primary.type,
            description: primary.description,
          };
          logBrain('SCANNER SIGNAL: ' + signal.ticker + ' ' + signal.direction +
            ' | ' + signal.setupType + ' | ' + tfCount + ' TFs: ' + signal.timeframes.join(', ') +
            (signal.nearLevel ? ' | Near ' + signal.nearLevel : ''));
          return signal;
        }
      }
    }

    logBrain('Scanner: ' + results.length + ' tickers with setups, but none with 2+ TF confluence on watchlist');
    return { triggered: false, reason: 'No 2+ TF confluence on watchlist tickers' };

  } catch(e) {
    logBrain('Scanner error: ' + e.message);
    return { triggered: false, reason: 'Scanner error: ' + e.message };
  }
}

// ===================================================================
// EVALUATE FLOW SIGNAL
// Pulls from getRecentFlow() -- looks for one-sided flow or large sweeps
// ===================================================================
function evaluateFlowSignal() {
  if (!bullflow || !bullflow.getRecentFlow) {
    logBrain('Flow not available -- bullflowStream not loaded');
    return { triggered: false, reason: 'Flow not loaded' };
  }

  try {
    var allFlow = bullflow.getRecentFlow();
    if (!allFlow || allFlow.length === 0) {
      return { triggered: false, reason: 'No recent flow data' };
    }

    // Look at flow from last 15 minutes
    var now = Date.now();
    var fifteenMinAgo = now - (15 * 60 * 1000);
    var recentFlow = allFlow.filter(function(f) {
      return new Date(f.timestamp).getTime() >= fifteenMinAgo;
    });

    if (recentFlow.length === 0) {
      return { triggered: false, reason: 'No flow in last 15 min' };
    }

    // Group by ticker
    var byTicker = {};
    for (var i = 0; i < recentFlow.length; i++) {
      var f = recentFlow[i];
      if (!f.ticker) continue;
      if (!byTicker[f.ticker]) byTicker[f.ticker] = { calls: 0, puts: 0, totalPremium: 0, maxPremium: 0, alerts: [] };
      var bucket = byTicker[f.ticker];
      if (f.callPut === 'CALL') bucket.calls++;
      else if (f.callPut === 'PUT') bucket.puts++;
      bucket.totalPremium += (f.premium || 0);
      if ((f.premium || 0) > bucket.maxPremium) bucket.maxPremium = f.premium;
      bucket.alerts.push(f);
    }

    // Check watchlist tickers for conviction flow
    for (var w = 0; w < FULL_WATCHLIST.length; w++) {
      var ticker = FULL_WATCHLIST[w];
      var data = byTicker[ticker];
      if (!data) continue;

      var totalAlerts = data.calls + data.puts;
      if (totalAlerts < 2) continue; // Need at least 2 alerts

      // One-sided flow check (calls >> puts or puts >> calls)
      var callRatio = totalAlerts > 0 ? data.calls / totalAlerts : 0;
      var putRatio = totalAlerts > 0 ? data.puts / totalAlerts : 0;
      var oneSided = callRatio >= 0.75 || putRatio >= 0.75;

      // Large sweep check (single alert > $500K)
      var largeSweep = data.maxPremium >= 500000;

      // Conviction score
      var conviction = 0;
      if (oneSided) conviction += 2;
      if (largeSweep) conviction += 3;
      if (data.totalPremium >= 1000000) conviction += 2;
      else if (data.totalPremium >= 500000) conviction += 1;
      if (totalAlerts >= 5) conviction += 1;

      if (conviction >= 3 || largeSweep) {
        var direction = data.calls > data.puts ? 'BULLISH' : 'BEARISH';
        var signal = {
          triggered: true,
          ticker: ticker,
          direction: direction,
          conviction: conviction,
          premium: data.totalPremium,
          maxSinglePremium: data.maxPremium,
          calls: data.calls,
          puts: data.puts,
          totalAlerts: totalAlerts,
          oneSided: oneSided,
          largeSweep: largeSweep,
        };
        logBrain('FLOW SIGNAL: ' + ticker + ' ' + direction +
          ' | Conviction ' + conviction + '/8 | $' + Math.round(data.totalPremium / 1000) + 'K total' +
          ' | ' + data.calls + 'C/' + data.puts + 'P' +
          (largeSweep ? ' | LARGE SWEEP $' + Math.round(data.maxPremium / 1000) + 'K' : ''));
        return signal;
      }
    }

    return { triggered: false, reason: 'No conviction flow on watchlist' };

  } catch(e) {
    logBrain('Flow eval error: ' + e.message);
    return { triggered: false, reason: 'Flow error: ' + e.message };
  }
}

// ===================================================================
// EVALUATE ENTRY
// Takes a signal from scanner or flow, checks all conditions
// ===================================================================
function evaluateEntry(signal) {
  if (!signal || !signal.triggered) {
    return { approved: false, reason: 'No valid signal' };
  }

  var ticker = signal.ticker;
  var direction = signal.direction;

  // Check: is ticker in our watchlist?
  var onWatchlist = FULL_WATCHLIST.indexOf(ticker) !== -1;
  if (!onWatchlist) {
    logBrain('ENTRY REJECTED: ' + ticker + ' not on watchlist');
    return { approved: false, reason: ticker + ' not on watchlist' };
  }

  // Check: are we under max trades?
  if (tradesOpened >= maxTrades) {
    logBrain('ENTRY REJECTED: Max trades reached (' + tradesOpened + '/' + maxTrades + ')');
    return { approved: false, reason: 'Max trades reached (' + tradesOpened + '/' + maxTrades + ')' };
  }

  // Check: have we hit max daily loss?
  if (dailyPL <= maxDailyLoss) {
    logBrain('ENTRY REJECTED: Max daily loss hit ($' + dailyPL + ')');
    return { approved: false, reason: 'Max daily loss reached ($' + dailyPL + ')' };
  }

  // Check: already have position in this ticker?
  var alreadyIn = activePositions.some(function(p) { return p.ticker === ticker; });
  if (alreadyIn) {
    logBrain('ENTRY REJECTED: Already in ' + ticker);
    return { approved: false, reason: 'Already have position in ' + ticker };
  }

  // Check: direction aligned with SPY trend (from GEXR or dynamic bias)?
  var gexrDirection = global.gexrDirection || null;
  if (gexrDirection) {
    var gexrBullish = gexrDirection === 'above';
    var signalBullish = direction === 'BULLISH';
    if (gexrBullish && !signalBullish) {
      logBrain('ENTRY WARNING: Signal is BEARISH but GEXR is BULLISH -- proceed with caution');
    } else if (!gexrBullish && signalBullish) {
      logBrain('ENTRY WARNING: Signal is BULLISH but GEXR is BEARISH -- proceed with caution');
    }
  }

  // Determine contract type and parameters
  var type = direction === 'BULLISH' ? 'call' : 'put';
  var stop = signal.stop || null;
  var trigger = signal.trigger || signal.price || null;

  // Estimate entry, trim levels
  var entry = trigger;
  var trim1 = entry && entry > 0 ? parseFloat((entry * (1 + trimPlan.first)).toFixed(2)) : null;
  var trim2 = entry && entry > 0 ? parseFloat((entry * (1 + trimPlan.second)).toFixed(2)) : null;

  var result = {
    approved: true,
    ticker: ticker,
    direction: direction,
    type: type,
    contracts: contractSize,
    entry: entry,
    stop: stop,
    trim1: trim1,
    trim2: trim2,
    strategy: strategies[currentStrategy],
    source: signal.setupType ? 'SCANNER' : 'FLOW',
    signal: signal,
    reason: 'All checks passed -- ' + strategies[currentStrategy],
  };

  logBrain('ENTRY APPROVED: ' + ticker + ' ' + type.toUpperCase() +
    ' | ' + contractSize + ' contracts' +
    ' | Entry ~$' + (entry ? entry.toFixed(2) : '?') +
    ' | Stop ~$' + (stop ? stop.toFixed(2) : '?') +
    ' | T1 ~$' + (trim1 ? trim1.toFixed(2) : '?') +
    ' | T2 ~$' + (trim2 ? trim2.toFixed(2) : '?') +
    ' | Strategy: ' + strategies[currentStrategy]);

  return result;
}

// ===================================================================
// MANAGE POSITION
// Checks current price vs entry, decides trim/trail/stop
// ===================================================================
function managePosition(position) {
  if (!position) return { action: 'HOLD', reason: 'No position data' };

  var entry = position.entry || 0;
  var current = position.currentPrice || entry;
  var contracts = position.contracts || 1;

  if (entry <= 0) return { action: 'HOLD', reason: 'No entry price' };

  var pctChange = ((current - entry) / entry) * 100;

  // STOP OUT: -25% or below stop
  if (pctChange <= -25 || (position.stop && current <= position.stop)) {
    logBrain('STOP OUT: ' + position.ticker + ' at $' + current.toFixed(2) +
      ' (' + pctChange.toFixed(1) + '% from entry $' + entry.toFixed(2) + ')');
    return { action: 'STOP', reason: 'Hit -25% stop or structural stop', pctChange: pctChange };
  }

  // TRIM 1: at +50% and contracts > 2
  if (pctChange >= 50 && contracts > 2 && !position.trim1Done) {
    logBrain('TRIM 1: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 contract');
    return { action: 'TRIM', trimQty: 1, reason: '+50% hit -- trim 1 of ' + contracts, pctChange: pctChange };
  }

  // TRIM 2: at +100% and contracts > 1
  if (pctChange >= 100 && contracts > 1 && !position.trim2Done) {
    logBrain('TRIM 2: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 more contract');
    return { action: 'TRIM', trimQty: 1, reason: '+100% hit -- trim 1 more, runner left', pctChange: pctChange };
  }

  // TRAIL: runner with 15% minimum trail
  if (position.trim1Done && contracts <= 1) {
    var trailStop = current * 0.85; // never tighter than 15% below current
    if (position.trailStop && trailStop > position.trailStop) {
      logBrain('TRAIL: ' + position.ticker + ' trail stop moved up to $' + trailStop.toFixed(2));
      return { action: 'TRAIL', trailStop: trailStop, reason: 'Runner trailing at 15%', pctChange: pctChange };
    }
    return { action: 'HOLD', reason: 'Runner active, trail at $' + (position.trailStop || trailStop).toFixed(2), pctChange: pctChange };
  }

  // HOLD
  return { action: 'HOLD', reason: 'Position OK at ' + pctChange.toFixed(1) + '%', pctChange: pctChange };
}

// ===================================================================
// FALLBACK STRATEGY
// Called when first trade stops out -- switches to next strategy
// ===================================================================
function fallbackStrategy() {
  currentStrategy++;
  if (currentStrategy >= strategies.length) {
    logBrain('FALLBACK: All strategies exhausted -- STANDING DOWN');
    transitionTo('CLOSE_OUT', 'All strategies failed');
    return { standDown: true, reason: 'All strategies exhausted' };
  }

  var nextStrat = strategies[currentStrategy];
  logBrain('FALLBACK: Switching to strategy ' + (currentStrategy + 1) + '/' + strategies.length + ': ' + nextStrat);
  transitionTo('WATCHING', 'Fallback to ' + nextStrat);
  return { standDown: false, strategy: nextStrat, reason: 'Switched to ' + nextStrat };
}

// ===================================================================
// GET DAILY BRIEF
// Returns formatted string with current brain status
// ===================================================================
function getDailyBrief() {
  var et = getETTime();
  var positionSummary = activePositions.map(function(p) {
    return p.ticker + ' ' + (p.type || '?').toUpperCase() + ' x' + (p.contracts || 0) +
      ' @ $' + (p.entry ? p.entry.toFixed(2) : '?');
  }).join(' | ') || 'None';

  var lines = [
    'BRAIN ENGINE DAILY BRIEF',
    '================================',
    'State:      ' + STATE,
    'Active:     ' + (brainActive ? 'YES' : 'NO'),
    'Daily P&L:  $' + dailyPL.toFixed(2) + ' / $' + dailyTarget + ' target',
    'Min Target: $' + minTarget,
    'Max Loss:   $' + maxDailyLoss,
    'Trades:     ' + tradesOpened + '/' + maxTrades,
    'Strategy:   ' + strategies[currentStrategy] + ' (' + (currentStrategy + 1) + '/' + strategies.length + ')',
    'Positions:  ' + positionSummary,
    'Cycles:     ' + cycleCount,
    'Last Cycle: ' + (lastCycleTime ? lastCycleTime : 'Never'),
    'Time:       ' + formatET(),
    '================================',
  ];

  // Add last 5 log entries
  if (brainLog.length > 0) {
    lines.push('RECENT LOG:');
    var start = Math.max(0, brainLog.length - 5);
    for (var i = start; i < brainLog.length; i++) {
      lines.push('  ' + brainLog[i]);
    }
  }

  return lines.join('\n');
}

// ===================================================================
// GET BRAIN STATUS (JSON format for API)
// ===================================================================
function getBrainStatus() {
  return {
    state: STATE,
    active: brainActive,
    dailyPL: dailyPL,
    dailyTarget: dailyTarget,
    minTarget: minTarget,
    maxDailyLoss: maxDailyLoss,
    tradesOpened: tradesOpened,
    maxTrades: maxTrades,
    currentStrategy: strategies[currentStrategy],
    strategyIndex: currentStrategy,
    totalStrategies: strategies.length,
    activePositions: activePositions,
    contractSize: contractSize,
    cycleCount: cycleCount,
    lastCycleTime: lastCycleTime,
    recentLog: brainLog.slice(-10),
    time: formatET(),
  };
}

// ===================================================================
// GET STATE (simple string getter)
// ===================================================================
function getState() {
  return STATE;
}

// ===================================================================
// RESET DAILY STATE
// ===================================================================
function resetDaily() {
  logBrain('DAILY RESET -- clearing all state');
  STATE = 'PRE_MARKET';
  dailyPL = 0;
  tradesOpened = 0;
  activePositions = [];
  currentStrategy = 0;
  cycleCount = 0;
  lastCycleTime = null;
  todayCatalysts = null;
  brainLog = [];
  logBrain('Daily state reset complete');
}

// ===================================================================
// SET BRAIN ACTIVE/INACTIVE
// ===================================================================
function setBrainActive(active) {
  brainActive = !!active;
  logBrain('Brain ' + (brainActive ? 'ACTIVATED' : 'DEACTIVATED'));
  if (brainActive) {
    postToDiscord('Brain Engine ACTIVATED -- monitoring for signals\nState: ' + STATE + '\nTarget: $' + dailyTarget)
      .catch(function(e) { console.error('[BRAIN] Activation post error:', e.message); });
  } else {
    postToDiscord('Brain Engine DEACTIVATED -- standing down')
      .catch(function(e) { console.error('[BRAIN] Deactivation post error:', e.message); });
  }
  return brainActive;
}

// ===================================================================
// RUN BRAIN CYCLE -- Called every 60 seconds during market hours
// The main loop: checks state, evaluates conditions, transitions
// ===================================================================
async function runBrainCycle() {
  // Guard: must be active
  if (!brainActive) return;

  cycleCount++;
  lastCycleTime = formatET();
  var et = getETTime();
  var marketOpen = 9 * 60 + 30;   // 9:30 AM
  var amEnd = 11 * 60 + 30;       // 11:30 AM
  var powerHourStart = 14 * 60 + 30; // 2:30 PM
  var powerHourEnd = 15 * 60 + 30;   // 3:30 PM
  var marketClose = 16 * 60;          // 4:00 PM

  // Log every 10th cycle to avoid spam
  if (cycleCount % 10 === 0) {
    logBrain('Cycle #' + cycleCount + ' | State: ' + STATE + ' | P&L: $' + dailyPL.toFixed(2) + ' | Trades: ' + tradesOpened + '/' + maxTrades);
  }

  // ---- STATE: PRE_MARKET ----
  if (STATE === 'PRE_MARKET') {
    // Scan catalysts if we haven't yet today
    if (!todayCatalysts && catalystScanner) {
      try {
        logBrain('PRE_MARKET: Scanning catalysts...');
        todayCatalysts = await catalystScanner.scanCatalysts();
        var notable = todayCatalysts.upgrades ? todayCatalysts.upgrades.filter(function(u) { return u.notable; }) : [];
        logBrain('PRE_MARKET: ' + notable.length + ' notable catalysts found');
        if (notable.length > 0) {
          var catalystMsg = 'PRE-MARKET CATALYSTS:\n';
          for (var c = 0; c < Math.min(notable.length, 5); c++) {
            var cat = notable[c];
            catalystMsg += cat.symbol + ' | ' + cat.action + ' -> ' + cat.toGrade + ' | ' + cat.direction + '\n';
          }
          await postToDiscord(catalystMsg);
        }
      } catch(e) {
        logBrain('PRE_MARKET: Catalyst scan error: ' + e.message);
      }
    }

    // Transition to WATCHING at 9:30 AM ET
    if (et.total >= marketOpen) {
      transitionTo('WATCHING', 'Market open -- 9:30 AM');
      await postToDiscord(
        'Market OPEN -- Brain entering WATCHING state\n' +
        'Strategy: ' + strategies[currentStrategy] + '\n' +
        'Target: $' + dailyTarget + ' | Max Loss: $' + maxDailyLoss + '\n' +
        'Max Trades: ' + maxTrades + ' | Contracts: ' + contractSize
      );
    }
    return;
  }

  // ---- GLOBAL: Check for TARGET_HIT ----
  if (STATE !== 'TARGET_HIT' && STATE !== 'CLOSE_OUT' && dailyPL >= minTarget) {
    transitionTo('TARGET_HIT', 'Daily target hit! P&L: $' + dailyPL.toFixed(2));
    await postToDiscord(
      'TARGET HIT! Daily P&L: $' + dailyPL.toFixed(2) + '\n' +
      'Trades: ' + tradesOpened + ' | Strategy: ' + strategies[currentStrategy] + '\n' +
      'Standing down for the day.'
    );
    return;
  }

  // ---- GLOBAL: Check for max daily loss ----
  if (STATE !== 'CLOSE_OUT' && dailyPL <= maxDailyLoss) {
    transitionTo('CLOSE_OUT', 'Max daily loss hit: $' + dailyPL.toFixed(2));
    await postToDiscord(
      'MAX DAILY LOSS HIT: $' + dailyPL.toFixed(2) + '\n' +
      'Trades: ' + tradesOpened + ' | SHUTTING DOWN for the day.'
    );
    return;
  }

  // ---- GLOBAL: Time-based transitions ----
  if (STATE !== 'TARGET_HIT' && STATE !== 'CLOSE_OUT') {
    // POWER_HOUR at 2:30 PM
    if (et.total >= powerHourStart && et.total < powerHourEnd && STATE !== 'POWER_HOUR' && STATE !== 'POSITION_OPEN' && STATE !== 'TRIMMING' && STATE !== 'TRAILING') {
      transitionTo('POWER_HOUR', '2:30 PM -- Power Hour window');
      await postToDiscord('POWER HOUR ACTIVE -- 2:30-3:30 PM window\nP&L: $' + dailyPL.toFixed(2) + ' | Trades: ' + tradesOpened + '/' + maxTrades);
    }
    // CLOSE_OUT at 3:30 PM
    if (et.total >= powerHourEnd && STATE !== 'CLOSE_OUT') {
      transitionTo('CLOSE_OUT', '3:30 PM -- Closing time');
      await postToDiscord(
        'CLOSE OUT -- 3:30 PM\n' +
        'Closing all day trades.\n' +
        'Daily P&L: $' + dailyPL.toFixed(2) + ' | Trades: ' + tradesOpened
      );
    }
  }

  // ---- STATE: WATCHING (9:30-11:30 AM window) ----
  if (STATE === 'WATCHING') {
    // Only scan for new entries during AM window or POWER_HOUR
    if (et.total > amEnd && et.total < powerHourStart) {
      // Dead zone: 11:30 AM - 2:30 PM -- just monitor positions
      if (cycleCount % 30 === 0) {
        logBrain('WATCHING: In dead zone (11:30AM-2:30PM) -- monitoring only');
      }
      return;
    }

    // Try current strategy
    var signal = null;
    var strat = strategies[currentStrategy];

    if (strat === 'SCANNER_BREAKOUT') {
      signal = await evaluateScannerSignal();
    } else if (strat === 'FLOW_CONVICTION') {
      signal = evaluateFlowSignal();
    } else if (strat === 'SCALP') {
      // Scalp uses scanner but with lower bar
      signal = await evaluateScannerSignal();
    }

    if (signal && signal.triggered) {
      transitionTo('ENTRY_SIGNAL', strat + ' signal: ' + signal.ticker + ' ' + signal.direction);
      // Evaluate immediately
      var entry = evaluateEntry(signal);
      if (entry.approved) {
        // WOULD execute here -- for now just log and post
        var entryMsg = [
          'ENTRY SIGNAL -- ' + entry.strategy,
          '================================',
          'Ticker:    ' + entry.ticker,
          'Direction: ' + entry.direction,
          'Type:      ' + entry.type.toUpperCase(),
          'Contracts: ' + entry.contracts,
          'Entry:     ~$' + (entry.entry ? entry.entry.toFixed(2) : '?'),
          'Stop:      ~$' + (entry.stop ? entry.stop.toFixed(2) : '?'),
          'T1 (+50%): ~$' + (entry.trim1 ? entry.trim1.toFixed(2) : '?'),
          'T2 (+100%):~$' + (entry.trim2 ? entry.trim2.toFixed(2) : '?'),
          'Source:    ' + entry.source,
          '================================',
          'STATUS: RECOMMENDATION ONLY',
          'Auto-execution not enabled yet.',
        ].join('\n');

        await postToDiscord(entryMsg);

        // Simulate opening the position (tracking only)
        var newPos = {
          ticker: entry.ticker,
          type: entry.type,
          direction: entry.direction,
          contracts: entry.contracts,
          entry: entry.entry,
          stop: entry.stop,
          trim1Target: entry.trim1,
          trim2Target: entry.trim2,
          trim1Done: false,
          trim2Done: false,
          trailStop: null,
          openTime: new Date().toISOString(),
          currentPrice: entry.entry, // will be updated
          strategy: entry.strategy,
        };
        activePositions.push(newPos);
        tradesOpened++;
        transitionTo('POSITION_OPEN', 'Tracking ' + entry.ticker + ' ' + entry.type.toUpperCase());
      } else {
        logBrain('Entry rejected: ' + entry.reason);
        transitionTo('WATCHING', 'Entry rejected -- back to watching');
      }
    }
    return;
  }

  // ---- STATE: POWER_HOUR ----
  if (STATE === 'POWER_HOUR') {
    // Same as WATCHING but during 2:30-3:30 window
    if (tradesOpened < maxTrades) {
      var phSignal = null;
      var phStrat = strategies[currentStrategy];

      if (phStrat === 'SCANNER_BREAKOUT' || phStrat === 'SCALP') {
        phSignal = await evaluateScannerSignal();
      } else if (phStrat === 'FLOW_CONVICTION') {
        phSignal = evaluateFlowSignal();
      }

      if (phSignal && phSignal.triggered) {
        var phEntry = evaluateEntry(phSignal);
        if (phEntry.approved) {
          logBrain('POWER HOUR ENTRY: ' + phEntry.ticker + ' ' + phEntry.type.toUpperCase());
          await postToDiscord(
            'POWER HOUR ENTRY SIGNAL\n' +
            phEntry.ticker + ' ' + phEntry.type.toUpperCase() + ' x' + phEntry.contracts + '\n' +
            'Entry: ~$' + (phEntry.entry ? phEntry.entry.toFixed(2) : '?') + '\n' +
            'STATUS: RECOMMENDATION ONLY'
          );

          activePositions.push({
            ticker: phEntry.ticker,
            type: phEntry.type,
            direction: phEntry.direction,
            contracts: phEntry.contracts,
            entry: phEntry.entry,
            stop: phEntry.stop,
            trim1Target: phEntry.trim1,
            trim2Target: phEntry.trim2,
            trim1Done: false,
            trim2Done: false,
            trailStop: null,
            openTime: new Date().toISOString(),
            currentPrice: phEntry.entry,
            strategy: phEntry.strategy,
          });
          tradesOpened++;
          transitionTo('POSITION_OPEN', 'Power hour: ' + phEntry.ticker);
        }
      }
    }
    return;
  }

  // ---- STATE: POSITION_OPEN ----
  if (STATE === 'POSITION_OPEN') {
    // Manage all active positions
    for (var p = 0; p < activePositions.length; p++) {
      var pos = activePositions[p];
      var action = managePosition(pos);

      if (action.action === 'TRIM') {
        pos.contracts -= (action.trimQty || 1);
        if (!pos.trim1Done) pos.trim1Done = true;
        else if (!pos.trim2Done) pos.trim2Done = true;

        // Calculate simulated P&L from trim
        var trimPL = (action.pctChange / 100) * (pos.entry || 0) * (action.trimQty || 1) * 100;
        dailyPL += trimPL;

        logBrain('TRIM P&L: +$' + trimPL.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2));
        transitionTo('TRIMMING', pos.ticker + ' trimmed -- ' + pos.contracts + ' remaining');
        await postToDiscord(
          'TRIM: ' + pos.ticker + ' at +' + action.pctChange.toFixed(1) + '%\n' +
          'Sold 1 contract | ' + pos.contracts + ' remaining\n' +
          'Trim P&L: +$' + trimPL.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2)
        );
      } else if (action.action === 'TRAIL') {
        pos.trailStop = action.trailStop;
        transitionTo('TRAILING', pos.ticker + ' trailing at $' + action.trailStop.toFixed(2));
      } else if (action.action === 'STOP') {
        // Stopped out
        var stopLoss = (action.pctChange / 100) * (pos.entry || 0) * pos.contracts * 100;
        dailyPL += stopLoss; // stopLoss is negative

        logBrain('STOP LOSS: $' + stopLoss.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2));
        await postToDiscord(
          'STOPPED OUT: ' + pos.ticker + ' at ' + action.pctChange.toFixed(1) + '%\n' +
          'Loss: $' + stopLoss.toFixed(2) + ' | Daily P&L: $' + dailyPL.toFixed(2)
        );

        // Remove position
        activePositions.splice(p, 1);
        p--;

        // Go to FALLBACK
        transitionTo('FALLBACK', pos.ticker + ' stopped out');
        fallbackStrategy();
      }
    }

    // If no positions left, go back to watching
    if (activePositions.length === 0 && STATE === 'POSITION_OPEN') {
      transitionTo('WATCHING', 'All positions closed');
    }
    return;
  }

  // ---- STATE: TRIMMING ----
  if (STATE === 'TRIMMING') {
    // Check if runner is set, transition to TRAILING
    var hasRunner = activePositions.some(function(p) { return p.trim1Done && p.contracts >= 1; });
    if (hasRunner) {
      transitionTo('TRAILING', 'Runner set -- trailing');
    } else if (activePositions.length === 0) {
      transitionTo('WATCHING', 'All positions closed after trim');
    }
    return;
  }

  // ---- STATE: TRAILING ----
  if (STATE === 'TRAILING') {
    // Manage trailing positions
    for (var t = 0; t < activePositions.length; t++) {
      var trailPos = activePositions[t];
      var trailAction = managePosition(trailPos);

      if (trailAction.action === 'TRAIL') {
        trailPos.trailStop = trailAction.trailStop;
      } else if (trailAction.action === 'STOP') {
        var trailLoss = (trailAction.pctChange / 100) * (trailPos.entry || 0) * trailPos.contracts * 100;
        dailyPL += trailLoss;
        logBrain('TRAIL STOP: ' + trailPos.ticker + ' P&L: $' + trailLoss.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2));
        await postToDiscord(
          'TRAIL STOPPED: ' + trailPos.ticker + '\n' +
          'P&L: $' + trailLoss.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2)
        );
        activePositions.splice(t, 1);
        t--;
      }
    }

    if (activePositions.length === 0) {
      // Check if target hit
      if (dailyPL >= minTarget) {
        transitionTo('TARGET_HIT', 'Target hit after trailing: $' + dailyPL.toFixed(2));
      } else {
        transitionTo('FALLBACK', 'Trail stopped -- looking for plan B');
        fallbackStrategy();
      }
    }
    return;
  }

  // ---- STATE: FALLBACK ----
  if (STATE === 'FALLBACK') {
    // fallbackStrategy() already transitioned us -- this state is transient
    // If we're still here, go to watching
    if (STATE === 'FALLBACK') {
      transitionTo('WATCHING', 'Fallback -- resuming watch');
    }
    return;
  }

  // ---- STATE: TARGET_HIT ----
  if (STATE === 'TARGET_HIT') {
    // Done for the day -- just close any remaining at EOD
    if (et.total >= powerHourEnd) {
      transitionTo('CLOSE_OUT', 'Target hit + 3:30 PM -- closing remaining');
    }
    return;
  }

  // ---- STATE: CLOSE_OUT ----
  if (STATE === 'CLOSE_OUT') {
    // Close all remaining positions (recommendation only)
    if (activePositions.length > 0) {
      logBrain('CLOSE_OUT: ' + activePositions.length + ' positions to close');
      for (var cl = 0; cl < activePositions.length; cl++) {
        var closePos = activePositions[cl];
        await postToDiscord(
          'CLOSE OUT: ' + closePos.ticker + ' ' + closePos.type.toUpperCase() + ' x' + closePos.contracts + '\n' +
          'Entry: $' + (closePos.entry ? closePos.entry.toFixed(2) : '?') + '\n' +
          'STATUS: RECOMMENDATION -- close this position'
        );
      }
      // Clear positions (simulated close)
      activePositions = [];
    }

    // Post EOD summary
    if (cycleCount % 60 === 0) { // Once per hour after close
      await postToDiscord(
        'END OF DAY SUMMARY\n' +
        '================================\n' +
        'Daily P&L: $' + dailyPL.toFixed(2) + '\n' +
        'Trades: ' + tradesOpened + '\n' +
        'Strategy: ' + strategies[currentStrategy] + '\n' +
        'Target: $' + dailyTarget + ' | ' + (dailyPL >= minTarget ? 'HIT' : 'MISSED')
      );
    }
    return;
  }
}

// ===================================================================
// EXPORTS
// ===================================================================
module.exports = {
  runBrainCycle: runBrainCycle,
  getDailyBrief: getDailyBrief,
  getState: getState,
  resetDaily: resetDaily,
  setBrainActive: setBrainActive,
  getBrainStatus: getBrainStatus,
};
