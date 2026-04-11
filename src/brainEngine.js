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

var caseyConfluence = null;
var smartStop = null;
var econCalendar = null;
var preMarketScanner = null;
try { caseyConfluence = require('./caseyConfluence'); } catch(e) { console.log('[BRAIN] caseyConfluence not loaded:', e.message); }
try { smartStop = require('./smartStop'); } catch(e) { console.log('[BRAIN] smartStop not loaded:', e.message); }
try { econCalendar = require('./economicCalendar'); } catch(e) { console.log('[BRAIN] economicCalendar not loaded:', e.message); }
var orderExecutor = null;
try { preMarketScanner = require('./preMarketScanner'); } catch(e) { console.log('[BRAIN] preMarketScanner not loaded:', e.message); }
try { orderExecutor = require('./orderExecutor'); } catch(e) { console.log('[BRAIN] orderExecutor not loaded:', e.message); }

// -- CONFLUENCE CONTEXT STORAGE ---------------------------------------
// Stores entry context for each position so health monitor can compare
var positionContexts = {};

// -- EARNINGS CACHE (refreshes daily) -----------------------------------
var earningsCache = { date: null, data: [] };

async function refreshEarningsCache() {
  if (!econCalendar || !econCalendar.getEarningsCalendar) return;
  var today = new Date().toISOString().slice(0, 10);
  if (earningsCache.date === today && earningsCache.data.length > 0) return; // already fresh
  try {
    var d = new Date();
    var from = d.toISOString().slice(0, 10);
    d.setDate(d.getDate() + 5); // check 5 days ahead
    var to = d.toISOString().slice(0, 10);
    var earnings = await econCalendar.getEarningsCalendar(from, to);
    earningsCache = { date: today, data: earnings };
    logBrain('EARNINGS CACHE: loaded ' + earnings.length + ' reports from ' + from + ' to ' + to);
  } catch(e) { console.error('[BRAIN] Earnings cache error:', e.message); }
}

function tickerHasEarningsWithin3Days(ticker) {
  if (!earningsCache.data || earningsCache.data.length === 0) return false;
  var now = new Date();
  var cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 3);
  var cutoffStr = cutoff.toISOString().slice(0, 10);
  var todayStr = now.toISOString().slice(0, 10);
  return earningsCache.data.some(function(e) {
    return e.symbol === ticker && e.date >= todayStr && e.date <= cutoffStr;
  });
}

function getNextEarningsDate(ticker) {
  if (!earningsCache.data || earningsCache.data.length === 0) return null;
  var match = earningsCache.data.find(function(e) { return e.symbol === ticker; });
  return match ? { date: match.date, hour: match.hour } : null;
}

// -- DISCORD WEBHOOK ------------------------------------------------
var BRAIN_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// -- WATCHLISTS (priority order) ------------------------------------
var CORE_WATCHLIST = ['SPY', 'QQQ', 'IWM']; // Casey method -- indices first
var FLOW_WATCHLIST = ['NVDA', 'AMZN', 'META', 'TSLA', 'AAPL', 'INTC', 'MRVL', 'AMD'];
var FULL_WATCHLIST = CORE_WATCHLIST.concat(FLOW_WATCHLIST);

// -- CORRELATION GROUPS (max 1 position per group, max 2 total) ------
var CORRELATION_GROUPS = {
  INDICES: ['SPY', 'QQQ', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SPXL', 'TNA'],
  MEGA_TECH: ['NVDA', 'AMZN', 'META', 'AAPL', 'AMD', 'MSFT', 'GOOGL'],
  HIGH_BETA: ['TSLA', 'MRVL', 'COIN', 'MSTR', 'INTC', 'WULF'],
};

function getCorrelationGroup(ticker) {
  for (var group in CORRELATION_GROUPS) {
    if (CORRELATION_GROUPS[group].indexOf(ticker.toUpperCase()) !== -1) return group;
  }
  return 'OTHER';
}

function isCorrelationAllowed(ticker) {
  var group = getCorrelationGroup(ticker);
  var activeGroups = {};
  var totalPositions = 0;
  activePositions.forEach(function(p) {
    var g = getCorrelationGroup(p.ticker);
    activeGroups[g] = true;
    totalPositions++;
  });
  // Max 2 positions total
  if (totalPositions >= 2) return { allowed: false, reason: 'Max 2 positions already open' };
  // Max 1 per correlation group
  if (activeGroups[group]) return { allowed: false, reason: 'Already have position in ' + group + ' group' };
  return { allowed: true };
}

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
var strategies = ['AYCE_STRAT', 'SCANNER_BREAKOUT', 'FLOW_CONVICTION', 'SCALP'];
var currentStrategy = 0;

// -- EXIT MODE: 'TRAIL' or 'STRENGTH' -------------------------------
// TRAIL = traditional trail stop (sell on pullback)
// STRENGTH = detect volume exhaustion and sell into the push
var exitMode = 'STRENGTH'; // default to selling at strength

// -- VOLUME EXHAUSTION DETECTION ------------------------------------
// Analyzes last N 5-min bars to detect if a move is peaking
// Returns { exhausted: true/false, reason: string, confidence: 0-100 }
function detectVolumeExhaustion(bars5min, direction) {
  if (!bars5min || bars5min.length < 5) return { exhausted: false, reason: 'Insufficient bars', confidence: 0 };

  var last5 = bars5min.slice(-5);
  var last3 = bars5min.slice(-3);
  var currentBar = last5[last5.length - 1];
  var prevBar = last5[last5.length - 2];
  var signals = 0;
  var reasons = [];

  // 1. Volume climax then drop: huge bar followed by smaller bars
  var avgVol3 = (last3[0].TotalVolume + last3[1].TotalVolume + last3[2].TotalVolume) / 3;
  var peakVol = Math.max(last5[0].TotalVolume, last5[1].TotalVolume, last5[2].TotalVolume);
  if (peakVol > avgVol3 * 1.5 && currentBar.TotalVolume < peakVol * 0.6) {
    signals += 2;
    reasons.push('Volume climax then drop-off');
  }

  // 2. Wick rejection: long upper wick on bullish, long lower wick on bearish
  var bodySize = Math.abs(parseFloat(currentBar.Close) - parseFloat(currentBar.Open));
  var totalRange = parseFloat(currentBar.High) - parseFloat(currentBar.Low);
  if (totalRange > 0) {
    var upperWick = parseFloat(currentBar.High) - Math.max(parseFloat(currentBar.Close), parseFloat(currentBar.Open));
    var lowerWick = Math.min(parseFloat(currentBar.Close), parseFloat(currentBar.Open)) - parseFloat(currentBar.Low);
    if (direction === 'BULLISH' && upperWick > bodySize * 1.5) {
      signals += 2;
      reasons.push('Upper wick rejection (sellers at high)');
    }
    if (direction === 'BEARISH' && lowerWick > bodySize * 1.5) {
      signals += 2;
      reasons.push('Lower wick rejection (buyers at low)');
    }
  }

  // 3. Shrinking candles: last 3 bars getting smaller (momentum fading)
  var size0 = parseFloat(last3[0].High) - parseFloat(last3[0].Low);
  var size1 = parseFloat(last3[1].High) - parseFloat(last3[1].Low);
  var size2 = parseFloat(last3[2].High) - parseFloat(last3[2].Low);
  if (size0 > size1 && size1 > size2) {
    signals += 1;
    reasons.push('Shrinking candles (momentum fading)');
  }

  // 4. HOD/LOD test and fail: touched high/low but closed away from it
  var allHighs = bars5min.slice(-20).map(function(b) { return parseFloat(b.High); });
  var dayHigh = Math.max.apply(null, allHighs);
  var close = parseFloat(currentBar.Close);
  var high = parseFloat(currentBar.High);
  if (direction === 'BULLISH' && high >= dayHigh * 0.999 && close < high - (totalRange * 0.3)) {
    signals += 2;
    reasons.push('HOD rejection (tested high, closed weak)');
  }

  // 5. Time exhaustion: after 11:00 AM, morning momentum fades
  var et = getETTime();
  if (et.total >= 11 * 60) {
    signals += 1;
    reasons.push('Post-11AM (morning momentum typically fades)');
  }

  // 6. Down volume exceeding up volume on latest bar (distribution)
  if (direction === 'BULLISH' && currentBar.DownVolume > currentBar.UpVolume) {
    signals += 1;
    reasons.push('Distribution (down volume > up volume)');
  }
  if (direction === 'BEARISH' && currentBar.UpVolume > currentBar.DownVolume) {
    signals += 1;
    reasons.push('Accumulation (up volume > down volume)');
  }

  var confidence = Math.min(100, signals * 15);
  var exhausted = signals >= 3; // need 3+ signals to call exhaustion

  if (exhausted) {
    logBrain('EXHAUSTION DETECTED (' + confidence + '%): ' + reasons.join(' | '));
  }

  return { exhausted: exhausted, reason: reasons.join(' | '), confidence: confidence, signals: signals };
}

// -- BYPASS MODE: FULL AUTONOMOUS EXECUTION -------------------------
// When true, brain places LIVE orders via orderExecutor instead of logging
// Account: 11975462 (LIVE TradeStation)
var BYPASS_MODE = false;
var LIVE_ACCOUNT = '11975462';

function setBypassMode(enabled) {
  BYPASS_MODE = !!enabled;
  logBrain('BYPASS MODE: ' + (BYPASS_MODE ? 'ENABLED -- LIVE AUTONOMOUS EXECUTION' : 'DISABLED -- recommendation only'));
  return BYPASS_MODE;
}

function getBypassMode() { return BYPASS_MODE; }

// -- AUTONOMOUS EXECUTION: resolve contract + place order -----------
async function executeAutonomous(entry) {
  if (!BYPASS_MODE) {
    logBrain('BYPASS OFF -- skipping execution for ' + entry.ticker);
    return { executed: false, reason: 'Bypass mode disabled' };
  }
  if (!orderExecutor) {
    logBrain('ORDER EXECUTOR NOT LOADED -- cannot execute');
    return { executed: false, reason: 'orderExecutor not loaded' };
  }
  if (!resolver) {
    logBrain('CONTRACT RESOLVER NOT LOADED -- cannot execute');
    return { executed: false, reason: 'contractResolver not loaded' };
  }

  try {
    // Step 1: Resolve the option contract
    var tradeType = entry.earningsWithin3Days ? 'DAY' : 'DAY'; // always day trade for now
    var contract = await resolver.resolveContract(
      entry.ticker,
      entry.type, // 'call' or 'put'
      tradeType,
      { confluence: entry.confluenceScore, strategy: entry.source }
    );

    if (!contract || contract.blocked) {
      var blockReason = contract ? contract.reason : 'No contract found';
      logBrain('EXECUTION BLOCKED: ' + entry.ticker + ' -- ' + blockReason);
      return { executed: false, reason: blockReason };
    }

    if (contract.wideSpread) {
      logBrain('WIDE SPREAD WARNING: ' + entry.ticker + ' ' + contract.symbol +
        ' bid:$' + contract.bid + ' ask:$' + contract.ask + ' -- proceeding with caution');
    }

    // Step 2: Determine sizing (contract resolver provides qty, but respect brain sizing)
    var qty = Math.min(entry.contracts || 3, contract.qty || 2);

    // Step 3: Use contract's calculated prices
    var limitPrice = contract.entryPrice || contract.ask;
    var stopPrice  = contract.optionStop || entry.stop || null;
    var t1Price    = contract.t1Price || null;

    logBrain('EXECUTING: ' + entry.ticker + ' ' + entry.type.toUpperCase() +
      ' | ' + contract.symbol + ' | ' + qty + 'x @ $' + limitPrice +
      ' | Stop $' + (stopPrice || '?') + ' | T1 $' + (t1Price || 'auto') +
      ' | ' + contract.dte + 'DTE | delta:' + (contract.delta || '?'));

    // Step 4: Place the order on LIVE account
    var result = await orderExecutor.placeOrder({
      account:    LIVE_ACCOUNT,
      symbol:     contract.symbol,
      action:     'BUYTOOPEN',
      qty:        qty,
      limit:      limitPrice,
      stop:       stopPrice,
      t1:         t1Price,
      duration:   'DAY',
      note:       'BRAIN AUTO: ' + entry.source + ' | ' + entry.ticker + ' ' + entry.type,
      liveBypass: true,
    });

    if (result.error) {
      logBrain('ORDER FAILED: ' + result.error);
      await postToDiscord(
        'ORDER FAILED: ' + entry.ticker + ' ' + entry.type.toUpperCase() + '\n' +
        'Error: ' + result.error
      );
      return { executed: false, reason: result.error };
    }

    logBrain('ORDER PLACED: ' + contract.symbol + ' x' + qty +
      ' @ $' + limitPrice + ' | ID: ' + result.orderId);

    await postToDiscord(
      'AUTONOMOUS ORDER PLACED\n' +
      '================================\n' +
      'Ticker:    ' + entry.ticker + '\n' +
      'Contract:  ' + contract.symbol + '\n' +
      'Direction: ' + entry.type.toUpperCase() + '\n' +
      'Qty:       ' + qty + '\n' +
      'Entry:     $' + limitPrice + '\n' +
      'Stop:      $' + (stopPrice || 'auto') + '\n' +
      'T1:        $' + (t1Price || 'auto') + '\n' +
      'DTE:       ' + contract.dte + '\n' +
      'Delta:     ' + (contract.delta ? contract.delta.toFixed(2) : '?') + '\n' +
      'Source:    ' + entry.source + '\n' +
      'Strategy:  ' + (entry.ayceStrategy || entry.strategy) + '\n' +
      'Order ID:  ' + result.orderId + '\n' +
      '================================\n' +
      'LIVE AUTONOMOUS EXECUTION'
    );

    return {
      executed: true,
      orderId: result.orderId,
      contract: contract,
      qty: qty,
      limit: limitPrice,
      stop: stopPrice,
      t1: t1Price,
    };

  } catch(e) {
    logBrain('EXECUTION ERROR: ' + e.message);
    return { executed: false, reason: e.message };
  }
}

// -- AUTONOMOUS CLOSE: market sell to close -------------------------
async function closeAutonomous(position) {
  if (!BYPASS_MODE || !orderExecutor) return { closed: false, reason: 'Bypass off or no executor' };
  try {
    var symbol = position.contractSymbol || position.symbol;
    if (!symbol) return { closed: false, reason: 'No contract symbol on position' };
    var result = await orderExecutor.closePosition(LIVE_ACCOUNT, symbol, position.contracts || 1);
    if (result.error) {
      logBrain('CLOSE FAILED: ' + symbol + ' -- ' + result.error);
      return { closed: false, reason: result.error };
    }
    logBrain('CLOSED: ' + symbol + ' x' + (position.contracts || 1) + ' | ID: ' + result.orderId);
    await postToDiscord(
      'POSITION CLOSED: ' + (position.ticker || symbol) + '\n' +
      'Contract: ' + symbol + ' x' + (position.contracts || 1) + '\n' +
      'Order ID: ' + result.orderId
    );
    return { closed: true, orderId: result.orderId };
  } catch(e) {
    logBrain('CLOSE ERROR: ' + e.message);
    return { closed: false, reason: e.message };
  }
}

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

    // ---- CASEY METHOD: Check for EMA crossover signals ----
    // Even without 2+ TF confluence, a Casey EMA signal is high conviction
    for (var c = 0; c < FULL_WATCHLIST.length; c++) {
      var caseyTicker = FULL_WATCHLIST[c];
      // Check all results (not just withSetups) for EMA signals
      var allResults = scanResults.allResults || results;
      for (var cr = 0; cr < allResults.length; cr++) {
        var caseyResult = allResults[cr];
        if (caseyResult.symbol !== caseyTicker) continue;
        if (!caseyResult.ema) continue;

        var ema = caseyResult.ema;
        var pm = caseyResult.premarket || {};

        // HIGH CONVICTION CASEY SIGNAL:
        // crossAbove + fanOut + (breakAbovePMH or retestPMH) = CALL
        // crossBelow + fanOut + (breakBelowPML or retestPML) = PUT
        var caseyBull = ema.crossAbove && ema.fanOut && (pm.breakAbovePMH || pm.retestPMH);
        var caseyBear = ema.crossBelow && ema.fanOut && (pm.breakBelowPML || pm.retestPML);

        // Also trigger on strong alignment + crossover even without premarket break
        var strongBull = ema.crossAbove && ema.bullishAligned && ema.priceAbove200;
        var strongBear = ema.crossBelow && ema.bearishAligned && !ema.priceAbove200;

        if (caseyBull || caseyBear || strongBull || strongBear) {
          var caseyDirection = (caseyBull || strongBull) ? 'BULLISH' : 'BEARISH';
          var caseyAction = caseyDirection === 'BULLISH' ? 'CALL' : 'PUT';
          var caseyTrigger = caseyDirection === 'BULLISH'
            ? (pm.high ? pm.high + 0.05 : caseyResult.price)
            : (pm.low ? pm.low - 0.05 : caseyResult.price);
          var caseyStop = caseyDirection === 'BULLISH'
            ? (pm.low || (caseyResult.price ? caseyResult.price * 0.995 : null))
            : (pm.high || (caseyResult.price ? caseyResult.price * 1.005 : null));

          var caseySignal = {
            triggered: true,
            ticker: caseyResult.symbol,
            direction: caseyDirection,
            action: caseyAction,
            trigger: caseyTrigger,
            stop: caseyStop,
            timeframes: ['5MIN-EMA'],
            tfCount: 1,
            nearLevel: caseyResult.nearLevel,
            price: caseyResult.price,
            setupType: 'CASEY_EMA',
            isCaseySignal: true,
            highConviction: caseyBull || caseyBear,
            caseyMessage: caseyResult.caseySignal,
            description: 'Casey EMA: 13/48 crossover' +
              (ema.fanOut ? ' + fan out' : '') +
              (pm.retestPMH ? ' + PMH retest' : '') +
              (pm.retestPML ? ' + PML retest' : '') +
              (ema.bullishAligned ? ' + bullish aligned' : '') +
              (ema.bearishAligned ? ' + bearish aligned' : '') +
              ' -> ' + caseyAction,
            ema: ema,
            premarket: pm,
          };

          logBrain('CASEY SIGNAL: ' + caseySignal.ticker + ' ' + caseyDirection +
            ' | EMA crossover' +
            (ema.fanOut ? ' + FAN OUT' : '') +
            (caseyBull ? ' + PMH break/retest' : '') +
            (caseyBear ? ' + PML break/retest' : '') +
            (caseySignal.highConviction ? ' | HIGH CONVICTION' : ' | STRONG'));

          return caseySignal;
        }

        // Lower conviction: just a crossover (still worth reporting)
        if (ema.crossAbove || ema.crossBelow) {
          var crossDir = ema.crossAbove ? 'BULLISH' : 'BEARISH';
          var crossAction = ema.crossAbove ? 'CALL' : 'PUT';
          logBrain('CASEY (low conviction): ' + caseyTicker + ' 13/48 EMA crossover ' + crossDir +
            ' -- watching for fan out and PM level break to confirm');
        }
      }
    }

    logBrain('Scanner: ' + results.length + ' tickers with setups, but none with 2+ TF confluence or Casey signal on watchlist');
    return { triggered: false, reason: 'No 2+ TF confluence or Casey EMA signal on watchlist tickers' };

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
// EVALUATE AYCE STRAT SIGNAL
// Runs all 5 AYCE strategies across watchlist tickers
// Time-aware: 4HR Re-Trigger at 9:30, 322+Failed9 at 10AM, 7HR after 11AM
// ===================================================================
async function evaluateAYCESignal() {
  if (!preMarketScanner) {
    logBrain('AYCE not available -- preMarketScanner not loaded');
    return { triggered: false, reason: 'preMarketScanner not loaded' };
  }

  var et = getETTime();
  var tickers = preMarketScanner.SCAN_TICKERS || FULL_WATCHLIST;

  try {
    for (var i = 0; i < tickers.length; i++) {
      var ticker = tickers[i];
      var setup = null;

      // 4HR Re-Trigger: fires at 9:30 bell (earliest AYCE signal)
      if (et.total >= 9 * 60 + 30) {
        setup = await preMarketScanner.scan4HRRetrigger(ticker);
        if (setup) { setup._source = '4HR_RETRIGGER'; }
      }

      // 12HR Miyagi: fires at open, setup detected pre-market
      if (!setup && et.total >= 9 * 60 + 30) {
        setup = await preMarketScanner.scanMiyagi(ticker);
        if (setup) { setup._source = 'MIYAGI'; }
      }

      // 322 + Failed 9: need 9AM candle closed (10AM+)
      if (!setup && et.total >= 10 * 60) {
        setup = await preMarketScanner.scan322(ticker);
        if (setup) { setup._source = '322_FIRST_LIVE'; }
      }
      if (!setup && et.total >= 10 * 60) {
        setup = await preMarketScanner.scanFailed9(ticker);
        if (setup) { setup._source = 'FAILED_9'; }
      }

      // 7HR: ONLY after 11AM (liquidity sweep window)
      if (!setup && et.total >= 11 * 60) {
        setup = await preMarketScanner.scan7HR(ticker);
        if (setup) { setup._source = '7HR_SWEEP'; }
      }

      if (setup && setup.valid) {
        var direction = setup.direction === 'CALLS' ? 'BULLISH' : 'BEARISH';
        var action = setup.direction === 'CALLS' ? 'CALL' : 'PUT';
        var entryLevel = parseFloat(setup.entryLevel || setup.trigger || setup.current);
        var stopLevel = parseFloat(setup.stopLevel || 0);

        // For strategies with targets, use them
        var target = parseFloat(setup.target || setup.t1 || 0);

        var signal = {
          triggered: true,
          ticker: ticker,
          direction: direction,
          action: action,
          trigger: entryLevel,
          stop: stopLevel,
          target: target,
          price: setup.current,
          setupType: 'AYCE_' + setup._source,
          isAYCESignal: true,
          ayceStrategy: setup.strategy,
          ayceSource: setup._source,
          description: setup.strategy + ': ' + ticker + ' ' + setup.direction +
            ' | Entry $' + entryLevel + (stopLevel ? ' | Stop $' + stopLevel : '') +
            (target ? ' | Target $' + target : ''),
        };

        logBrain('AYCE SIGNAL: ' + setup.strategy + ' | ' + ticker + ' ' + setup.direction +
          ' | Entry $' + entryLevel +
          (stopLevel ? ' | Stop $' + stopLevel : '') +
          (target ? ' | Target $' + target : ''));

        return signal;
      }
    }

    return { triggered: false, reason: 'No AYCE setups across ' + tickers.length + ' tickers' };

  } catch(e) {
    logBrain('AYCE eval error: ' + e.message);
    return { triggered: false, reason: 'AYCE error: ' + e.message };
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

  // Check: no entries before 9:45 AM ET (first 15 min = noise/false breakouts)
  // EXCEPTION: AYCE 4HR Re-Trigger fires at 9:30 -- structural pattern, not noise
  var etNow = getETTime ? getETTime() : new Date();
  var etHour = typeof etNow === 'object' ? etNow.getHours() : parseInt(String(etNow).split(':')[0]);
  var etMin = typeof etNow === 'object' ? etNow.getMinutes() : parseInt(String(etNow).split(':')[1]);
  var isAYCE = signal.isAYCESignal || false;
  if (etHour === 9 && etMin < 45 && !isAYCE) {
    logBrain('ENTRY REJECTED: Before 9:45 AM ET (' + etHour + ':' + etMin + ') -- opening volatility');
    return { approved: false, reason: 'Before 9:45 AM -- opening 15 min is noise' };
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

  // Check: correlation group limit (max 1 per group, max 2 total)
  var corrCheck = isCorrelationAllowed(ticker);
  if (!corrCheck.allowed) {
    logBrain('ENTRY REJECTED: ' + corrCheck.reason + ' (' + ticker + ' is ' + getCorrelationGroup(ticker) + ')');
    return { approved: false, reason: corrCheck.reason };
  }

  // Check: earnings proximity -- auto-enrich signal
  signal.earningsWithin3Days = tickerHasEarningsWithin3Days(ticker);
  if (signal.earningsWithin3Days) {
    var nextER = getNextEarningsDate(ticker);
    var erInfo = nextER ? nextER.date + ' (' + nextER.hour + ')' : 'soon';
    logBrain('EARNINGS ALERT: ' + ticker + ' reports ' + erInfo + ' -- forcing DAY TRADE, no swing');
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

  // Check earnings: if swing candidate, don't swing into earnings
  if (signal.tvData && signal.tvData.dte >= 5 && signal.earningsWithin3Days) {
    logBrain('EARNINGS WARNING: ' + ticker + ' has earnings within 3 days -- forcing DAY TRADE (no swing)');
    if (signal.tvData) signal.tvData.dte = 0; // force day trade classification
  }

  // Tag entry source
  var source = signal.isAYCESignal ? 'AYCE_STRAT' : (signal.isCaseySignal ? 'CASEY_EMA' : (signal.setupType ? 'SCANNER' : 'FLOW'));

  // CONFLUENCE CHECK -- if we have TradingView data, score it
  var confluenceResult = null;
  if (signal.tvData && caseyConfluence) {
    confluenceResult = caseyConfluence.scoreConfluence(signal.tvData);
    logBrain('CONFLUENCE SCORE: ' + confluenceResult.score + '/10 (' + confluenceResult.conviction + ')');

    // REQUIRE minimum score for entry (4+ = valid setup, even if only 2 contracts)
    if (confluenceResult.score < 4) {
      logBrain('ENTRY REJECTED: Confluence score ' + confluenceResult.score + '/10 -- too low (need 4+)');
      return { approved: false, reason: 'Confluence too low: ' + confluenceResult.score + '/10' };
    }

    // Use confluence-based sizing instead of default
    if (confluenceResult.contracts > 0) {
      contractSize = confluenceResult.contracts;
      logBrain('SIZING: ' + confluenceResult.contracts + ' contracts based on conviction ' + confluenceResult.conviction);
    }

    // Use Casey structure-based stop if available
    if (confluenceResult.retestLevel && smartStop) {
      var caseyStop = smartStop.calcCaseyStop({
        ticker: ticker,
        type: type,
        premium: entry || 1.00,
        delta: signal.delta || 0.40,
        entryPrice: signal.underlyingPrice || confluenceResult.entryPrice,
        retestLevel: confluenceResult.retestLevel,
        invalidationPrice: confluenceResult.invalidationPrice,
        atr: confluenceResult.atr || 0.50,
      });
      if (caseyStop) {
        stop = parseFloat(caseyStop.stopPrice);
        logBrain('CASEY STOP: $' + caseyStop.stopPrice + ' (structure at $' + caseyStop.structuralLevel + ')');
      }
    }
  }

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
    source: source,
    isCaseySignal: signal.isCaseySignal || false,
    isAYCESignal: signal.isAYCESignal || false,
    ayceStrategy: signal.ayceStrategy || null,
    ayceSource: signal.ayceSource || null,
    highConviction: signal.highConviction || false,
    caseyMessage: signal.caseyMessage || null,
    confluenceScore: confluenceResult ? confluenceResult.score : null,
    confluenceConviction: confluenceResult ? confluenceResult.conviction : null,
    confluenceChecklist: confluenceResult ? confluenceResult.checklist : null,
    retestLevel: confluenceResult ? confluenceResult.retestLevel : null,
    invalidationPrice: confluenceResult ? confluenceResult.invalidationPrice : null,
    signal: signal,
    reason: 'All checks passed -- ' + strategies[currentStrategy] +
      (signal.isCaseySignal ? ' (CASEY EMA SIGNAL)' : '') +
      (confluenceResult ? ' | Confluence ' + confluenceResult.score + '/10' : ''),
  };

  // Store context for position health monitor
  if (confluenceResult) {
    positionContexts[ticker] = confluenceResult;
    logBrain('Stored entry context for ' + ticker + ' health monitoring');
  }

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

  // HEALTH-BASED EXIT -- replaces flat -25% panic cut
  // If we have entry context + live TV data, use health scoring
  var entryContext = positionContexts[position.ticker] || null;
  if (entryContext && position.tvData && caseyConfluence) {
    var health = caseyConfluence.scorePositionHealth(position.tvData, entryContext);
    position.healthScore = health.health;
    position.healthAction = health.action;

    if (health.action === 'EXIT') {
      logBrain('HEALTH EXIT: ' + position.ticker + ' health=' + health.health +
        '/10 -- ' + health.reasons.join(', '));
      return { action: 'STOP', reason: 'Structure broken (health ' + health.health + '/10): ' +
        health.reasons.join(', '), pctChange: pctChange, healthScore: health.health };
    }

    if (health.action === 'TIGHTEN' && pctChange > 0) {
      logBrain('HEALTH TIGHTEN: ' + position.ticker + ' health=' + health.health +
        '/10 -- moving stop to breakeven');
      return { action: 'TIGHTEN', reason: 'Health dropping (' + health.health + '/10) -- tighten stop',
        pctChange: pctChange, healthScore: health.health };
    }

    if (health.action === 'RIDE') {
      logBrain('HEALTH RIDE: ' + position.ticker + ' health=' + health.health +
        '/10 -- structure strong, let it ride');
    }
  }

  // HARD FLOOR: -40% absolute max loss (no structure data or catastrophic move)
  if (pctChange <= -40) {
    logBrain('HARD STOP: ' + position.ticker + ' at $' + current.toFixed(2) +
      ' (' + pctChange.toFixed(1) + '% -- max loss floor)');
    return { action: 'STOP', reason: 'Hit -40% hard floor', pctChange: pctChange };
  }

  // STRUCTURAL STOP: below the stop price (set from Casey or legacy)
  if (position.stop && current <= position.stop) {
    logBrain('STRUCTURAL STOP: ' + position.ticker + ' at $' + current.toFixed(2) +
      ' (below stop $' + position.stop.toFixed(2) + ')');
    return { action: 'STOP', reason: 'Below structural stop $' + position.stop.toFixed(2), pctChange: pctChange };
  }

  // TRIM LOGIC — scales with position size
  // 2 contracts: NO trim at +50%. Hold both. Trail on structure. Exit all when structure breaks.
  // 3 contracts: trim 1 at +50%, trim 1 at +100%, trail 1 runner
  // 4-5 contracts: trim 2 at +50%, trim 1-2 at +100%, trail rest
  if (contracts === 2 && !position.trim1Done) {
    // 2 CONTRACTS: Don't trim early. Hold for the full move.
    // Only trim 1 at +100% to lock in breakeven, then trail the runner.
    if (pctChange >= 100) {
      logBrain('TRIM (2-lot): ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 of 2, trail runner');
      return { action: 'TRIM', trimQty: 1, reason: '+100% on 2-lot -- trim 1, runner on house money', pctChange: pctChange };
    }
  } else if (contracts > 2) {
    // 3+ CONTRACTS: Standard trim schedule
    if (pctChange >= 50 && !position.trim1Done) {
      var trimQty = contracts >= 4 ? 2 : 1;
      logBrain('TRIM 1: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell ' + trimQty);
      return { action: 'TRIM', trimQty: trimQty, reason: '+50% hit -- trim ' + trimQty + ' of ' + contracts, pctChange: pctChange };
    }
    if (pctChange >= 100 && contracts > 1 && !position.trim2Done) {
      logBrain('TRIM 2: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 more');
      return { action: 'TRIM', trimQty: 1, reason: '+100% hit -- trim 1 more, runner left', pctChange: pctChange };
    }
  }

  // EXIT AT STRENGTH: if exitMode is STRENGTH, check volume exhaustion on contracts 1 & 2
  if (exitMode === 'STRENGTH' && contracts >= 2 && pctChange >= 30) {
    // Only check exhaustion if we have 5-min bars cached for this ticker
    var cachedBars = position.recentBars || null;
    if (cachedBars) {
      var exhaustion = detectVolumeExhaustion(cachedBars, position.direction || 'BULLISH');
      if (exhaustion.exhausted) {
        logBrain('SELL AT STRENGTH: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% | ' + exhaustion.reason);
        return { action: 'SELL_STRENGTH', reason: 'Volume exhaustion at +' + pctChange.toFixed(1) + '% -- SELL NOW', pctChange: pctChange, exhaustion: exhaustion };
      }
    }
  }

  // TRAIL: runner with HEALTH-BASED trailing (not flat 15%)
  if (position.trim1Done && contracts <= 1) {
    var healthScore = position.healthScore || 5;

    // Use Casey trail if we have structure data
    if (entryContext && smartStop && smartStop.calcCaseyTrail) {
      var trailResult = smartStop.calcCaseyTrail({
        type: position.type || 'call',
        currentPrice: position.underlyingPrice || current,
        entryPrice: entry,
        currentPremium: current,
        entryPremium: entry,
        delta: position.delta || 0.40,
        atr: (entryContext && entryContext.atr) || 0.50,
        retestLevel: entryContext ? entryContext.retestLevel : null,
        health: healthScore,
      });
      var trailStop = parseFloat(trailResult.optionTrail);
      if (position.trailStop && trailStop > position.trailStop) {
        logBrain('CASEY TRAIL: ' + position.ticker + ' trail=$' + trailStop.toFixed(2) +
          ' | ' + trailResult.reason);
        return { action: 'TRAIL', trailStop: trailStop,
          reason: 'Casey trail: ' + trailResult.reason, pctChange: pctChange };
      }
      return { action: 'HOLD', reason: 'Runner active, trail at $' +
        (position.trailStop || trailStop).toFixed(2) + ' | health ' + healthScore + '/10',
        pctChange: pctChange };
    }

    // Fallback: flat 15% trail (legacy)
    var trailStop = current * 0.85;
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
    exitMode: exitMode,
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
// SET EXIT MODE: 'TRAIL' or 'STRENGTH'
// ===================================================================
function setExitMode(mode) {
  if (mode === 'TRAIL' || mode === 'STRENGTH') {
    exitMode = mode;
    logBrain('Exit mode set to: ' + exitMode);
    return exitMode;
  }
  return exitMode;
}

function getExitMode() { return exitMode; }

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

  // ---- EARNINGS CACHE: refresh once per day ----
  await refreshEarningsCache();

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
        'Max Trades: ' + maxTrades + ' | Contracts: ' + contractSize + '\n' +
        'BYPASS MODE: ' + (BYPASS_MODE ? 'ON -- LIVE AUTONOMOUS EXECUTION' : 'OFF -- recommendations only')
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
    // EXCEPTION: AYCE 7HR strategy fires AFTER 11AM (liquidity sweep window)
    if (et.total > amEnd && et.total < powerHourStart) {
      if (strategies[currentStrategy] === 'AYCE_STRAT') {
        // 7HR scans during dead zone -- this IS the strategy's window
        if (cycleCount % 30 === 0) {
          logBrain('WATCHING: Dead zone but AYCE 7HR active -- scanning for liquidity sweeps');
        }
      } else {
        // Dead zone: 11:30 AM - 2:30 PM -- just monitor positions
        if (cycleCount % 30 === 0) {
          logBrain('WATCHING: In dead zone (11:30AM-2:30PM) -- monitoring only');
        }
        return;
      }
    }

    // Try current strategy
    var signal = null;
    var strat = strategies[currentStrategy];

    if (strat === 'AYCE_STRAT') {
      signal = await evaluateAYCESignal();
    } else if (strat === 'SCANNER_BREAKOUT') {
      signal = await evaluateScannerSignal();
    } else if (strat === 'FLOW_CONVICTION') {
      signal = evaluateFlowSignal();
    } else if (strat === 'SCALP') {
      signal = await evaluateScannerSignal();
    }

    if (signal && signal.triggered) {
      transitionTo('ENTRY_SIGNAL', strat + ' signal: ' + signal.ticker + ' ' + signal.direction);
      // Evaluate immediately
      var entry = evaluateEntry(signal);
      if (entry.approved) {
        // AUTONOMOUS EXECUTION when bypass mode is on
        var execResult = null;
        if (BYPASS_MODE) {
          execResult = await executeAutonomous(entry);
        }

        var entryLines = [
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
        ];
        if (entry.isCaseySignal && entry.caseyMessage) {
          entryLines.push('================================');
          entryLines.push(entry.caseyMessage);
          if (entry.highConviction) {
            entryLines.push('\u26A1 HIGH CONVICTION CASEY SIGNAL \u26A1');
          }
        }
        if (entry.isAYCESignal) {
          entryLines.push('================================');
          entryLines.push('AYCE STRAT: ' + (entry.ayceStrategy || 'Unknown'));
          if (entry.signal && entry.signal.target) {
            entryLines.push('Target:    ~$' + entry.signal.target);
          }
          entryLines.push('\u26A1 STRAT PATTERN -- STRUCTURAL ENTRY \u26A1');
        }
        entryLines.push('================================');
        if (BYPASS_MODE && execResult && execResult.executed) {
          entryLines.push('STATUS: LIVE ORDER PLACED');
          entryLines.push('Order ID: ' + execResult.orderId);
          entryLines.push('Contract: ' + (execResult.contract ? execResult.contract.symbol : '?'));
        } else if (BYPASS_MODE && execResult && !execResult.executed) {
          entryLines.push('STATUS: EXECUTION FAILED');
          entryLines.push('Reason: ' + execResult.reason);
        } else {
          entryLines.push('STATUS: RECOMMENDATION ONLY');
          entryLines.push('Enable bypass mode for auto-execution.');
        }
        var entryMsg = entryLines.join('\n');
        await postToDiscord(entryMsg);

        // Track position (with contract info if executed)
        var newPos = {
          ticker: entry.ticker,
          type: entry.type,
          direction: entry.direction,
          contracts: execResult && execResult.executed ? execResult.qty : entry.contracts,
          entry: execResult && execResult.executed ? execResult.limit : entry.entry,
          stop: execResult && execResult.executed ? execResult.stop : entry.stop,
          contractSymbol: execResult && execResult.contract ? execResult.contract.symbol : null,
          orderId: execResult ? execResult.orderId : null,
          trim1Target: entry.trim1,
          trim2Target: entry.trim2,
          trim1Done: false,
          trim2Done: false,
          trailStop: null,
          openTime: new Date().toISOString(),
          currentPrice: entry.entry,
          strategy: entry.strategy,
          liveOrder: !!(execResult && execResult.executed),
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

      if (phStrat === 'AYCE_STRAT') {
        phSignal = await evaluateAYCESignal();
      } else if (phStrat === 'SCANNER_BREAKOUT' || phStrat === 'SCALP') {
        phSignal = await evaluateScannerSignal();
      } else if (phStrat === 'FLOW_CONVICTION') {
        phSignal = evaluateFlowSignal();
      }

      if (phSignal && phSignal.triggered) {
        var phEntry = evaluateEntry(phSignal);
        if (phEntry.approved) {
          logBrain('POWER HOUR ENTRY: ' + phEntry.ticker + ' ' + phEntry.type.toUpperCase());
          var phExec = null;
          if (BYPASS_MODE) {
            phExec = await executeAutonomous(phEntry);
          }
          var phStatus = (BYPASS_MODE && phExec && phExec.executed)
            ? 'LIVE ORDER PLACED | ID: ' + phExec.orderId
            : (BYPASS_MODE ? 'EXECUTION FAILED: ' + (phExec ? phExec.reason : '?') : 'RECOMMENDATION ONLY');
          await postToDiscord(
            'POWER HOUR ENTRY SIGNAL\n' +
            phEntry.ticker + ' ' + phEntry.type.toUpperCase() + ' x' + phEntry.contracts + '\n' +
            'Entry: ~$' + (phEntry.entry ? phEntry.entry.toFixed(2) : '?') + '\n' +
            'STATUS: ' + phStatus
          );

          activePositions.push({
            ticker: phEntry.ticker,
            type: phEntry.type,
            direction: phEntry.direction,
            contracts: (phExec && phExec.executed) ? phExec.qty : phEntry.contracts,
            entry: (phExec && phExec.executed) ? phExec.limit : phEntry.entry,
            stop: (phExec && phExec.executed) ? phExec.stop : phEntry.stop,
            contractSymbol: (phExec && phExec.contract) ? phExec.contract.symbol : null,
            orderId: phExec ? phExec.orderId : null,
            trim1Target: phEntry.trim1,
            trim2Target: phEntry.trim2,
            trim1Done: false,
            trim2Done: false,
            trailStop: null,
            openTime: new Date().toISOString(),
            currentPrice: phEntry.entry,
            strategy: phEntry.strategy,
            liveOrder: !!(phExec && phExec.executed),
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
        var closeResult = null;
        if (BYPASS_MODE && closePos.liveOrder && closePos.contractSymbol) {
          closeResult = await closeAutonomous(closePos);
        }
        var closeStatus = (closeResult && closeResult.closed)
          ? 'CLOSED | Order ID: ' + closeResult.orderId
          : (BYPASS_MODE && closePos.liveOrder ? 'CLOSE FAILED: ' + (closeResult ? closeResult.reason : '?') : 'RECOMMENDATION -- close this position');
        await postToDiscord(
          'CLOSE OUT: ' + closePos.ticker + ' ' + closePos.type.toUpperCase() + ' x' + closePos.contracts + '\n' +
          'Entry: $' + (closePos.entry ? closePos.entry.toFixed(2) : '?') + '\n' +
          'STATUS: ' + closeStatus
        );
      }
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
// ===================================================================
// CONFLUENCE API -- for Claude agent to score setups via TV data
// ===================================================================
function scoreSetup(tvData) {
  if (!caseyConfluence) return { error: 'caseyConfluence module not loaded' };
  return caseyConfluence.scoreConfluence(tvData);
}

function checkPositionHealth(ticker, tvData) {
  if (!caseyConfluence) return { error: 'caseyConfluence module not loaded' };
  var ctx = positionContexts[ticker];
  if (!ctx) return { error: 'No entry context for ' + ticker + ' -- was not entered via confluence' };
  return caseyConfluence.scorePositionHealth(tvData, ctx);
}

function getPositionContexts() {
  return positionContexts;
}

module.exports = {
  runBrainCycle: runBrainCycle,
  getDailyBrief: getDailyBrief,
  getState: getState,
  resetDaily: resetDaily,
  setBrainActive: setBrainActive,
  getBrainStatus: getBrainStatus,
  setExitMode: setExitMode,
  getExitMode: getExitMode,
  setBypassMode: setBypassMode,
  getBypassMode: getBypassMode,
  detectVolumeExhaustion: detectVolumeExhaustion,
  scoreSetup: scoreSetup,
  checkPositionHealth: checkPositionHealth,
  getPositionContexts: getPositionContexts,
  refreshEarningsCache: refreshEarningsCache,
  tickerHasEarningsWithin3Days: tickerHasEarningsWithin3Days,
  getNextEarningsDate: getNextEarningsDate,
  getEarningsCache: function() { return earningsCache; },
};
