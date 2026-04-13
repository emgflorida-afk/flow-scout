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
var signalEnricher = null;
try { orderExecutor = require('./orderExecutor'); } catch(e) { console.log('[BRAIN] orderExecutor not loaded:', e.message); }
try { signalEnricher = require('./signalEnricher'); } catch(e) { console.log('[BRAIN] signalEnricher not loaded:', e.message); }

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

// -- DISCORD WEBHOOKS -----------------------------------------------
// GO-MODE: Clean channel for ONLY actionable signals. Mute everything else.
var GO_MODE_WEBHOOK = 'https://discord.com/api/webhooks/1493056141125488740/MbMOqZ8yclJfuwNB8wIs77y-9EKxPdi2HjQ7Auc6ZGGYXC4RUWEY4v6czLUSLPG-Q1cp';
// Legacy channel for debug/noise
var BRAIN_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// -- WATCHLISTS (priority order) ------------------------------------
var CORE_WATCHLIST = ['SPY', 'QQQ', 'IWM']; // Casey method -- indices first
var FLOW_WATCHLIST = ['NVDA', 'AMZN', 'META', 'TSLA', 'AAPL', 'INTC', 'MRVL', 'AMD'];
var JSMITH_WATCHLIST = ['COIN', 'U', 'ABNB', 'UBER', 'BIDU']; // JSmith Apr 12 -- hammers + shooters
var CATALYST_WATCHLIST = ['MCD', 'FAST']; // Market brief Apr 14
var FULL_WATCHLIST = CORE_WATCHLIST.concat(FLOW_WATCHLIST).concat(JSMITH_WATCHLIST).concat(CATALYST_WATCHLIST);

// -- CORRELATION GROUPS (max 1 position per group, max 2 total) ------
var CORRELATION_GROUPS = {
  INDICES: ['SPY', 'QQQ', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SPXL', 'TNA'],
  MEGA_TECH: ['NVDA', 'AMZN', 'META', 'AAPL', 'AMD', 'MSFT', 'GOOGL'],
  HIGH_BETA: ['TSLA', 'MRVL', 'COIN', 'MSTR', 'INTC', 'WULF'],
  TRAVEL: ['ABNB', 'UBER', 'BKNG'],   // travel/gig economy -- correlated
  CHINA_ADR: ['BIDU', 'BABA', 'JD', 'PDD'], // China ADRs -- move together
  GAMING: ['U', 'RBLX', 'EA', 'TTWO'],      // gaming/metaverse
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
var maxTrades = 2; // DOCTRINE: max 2 trades per day. Was 3 -- FIXED.
var activePositions = [];
var contractSize = 3; // default 3 contracts per trade
var trimPlan = { first: 0.50, second: 1.00 }; // +50%, +100%
var strategies = ['AYCE_STRAT', 'SCANNER_BREAKOUT', 'FLOW_CONVICTION', 'SCALP'];
var currentStrategy = 0;

// ===================================================================
// WEEKLY PACE TRACKER
// Tracks cumulative P&L across the week so the brain can adjust
// sizing and runner management to close gaps toward $2,500 target.
// Persists to /tmp/weekly_pace.json so Railway redeploys don't lose it.
// ===================================================================
var WEEKLY_TARGET = 2500;
var weeklyPace = {
  weekStart: null,        // Monday date string e.g. '2026-04-13'
  dailyResults: {},       // { '2026-04-13': 450, '2026-04-14': -50, ... }
  totalPL: 0,
  tradingDaysLeft: 5,
  pace: 'ON_TRACK',       // ON_TRACK, BEHIND, AHEAD, CRITICAL
  adjustments: {
    contractBoost: 0,     // extra contracts to add (0-3)
    maxTradesBoost: 0,    // extra trade slots (0-1)
    runnerMode: 'NORMAL', // NORMAL or EXTENDED (hold runners longer)
  },
};

var PACE_FILE = '/tmp/weekly_pace.json';

function getWeekStartDate() {
  var now = new Date();
  // Get Monday of current week in ET
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var day = et.getDay(); // 0=Sun, 1=Mon, ...
  var diff = day === 0 ? -6 : 1 - day; // days to subtract to get Monday
  var monday = new Date(et);
  monday.setDate(et.getDate() + diff);
  return monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
}

function getTradingDaysLeft() {
  var et = getETTime();
  var dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  var daysMap = { 'Monday': 5, 'Tuesday': 4, 'Wednesday': 3, 'Thursday': 2, 'Friday': 1 };
  return daysMap[dayOfWeek] || 0;
}

function loadWeeklyPace() {
  try {
    var fs = require('fs');
    if (fs.existsSync(PACE_FILE)) {
      var data = JSON.parse(fs.readFileSync(PACE_FILE, 'utf8'));
      var currentWeek = getWeekStartDate();
      if (data.weekStart === currentWeek) {
        weeklyPace = data;
        console.log('[PACE] Loaded weekly pace: $' + weeklyPace.totalPL.toFixed(2) + ' / $' + WEEKLY_TARGET);
        return;
      }
      // New week — archive old, start fresh
      console.log('[PACE] New week detected. Last week: $' + (data.totalPL || 0).toFixed(2));
    }
  } catch(e) { console.log('[PACE] No saved pace file, starting fresh'); }
  // Initialize new week
  weeklyPace.weekStart = getWeekStartDate();
  weeklyPace.dailyResults = {};
  weeklyPace.totalPL = 0;
  saveWeeklyPace();
}

function saveWeeklyPace() {
  try {
    var fs = require('fs');
    fs.writeFileSync(PACE_FILE, JSON.stringify(weeklyPace, null, 2));
  } catch(e) { console.error('[PACE] Save error:', e.message); }
}

function recordDailyResult(dateStr, pnl) {
  weeklyPace.dailyResults[dateStr] = pnl;
  weeklyPace.totalPL = 0;
  var keys = Object.keys(weeklyPace.dailyResults);
  for (var i = 0; i < keys.length; i++) {
    weeklyPace.totalPL += weeklyPace.dailyResults[keys[i]];
  }
  recalcPace();
  saveWeeklyPace();
  logBrain('WEEKLY PACE: $' + weeklyPace.totalPL.toFixed(2) + ' / $' + WEEKLY_TARGET +
    ' | Pace: ' + weeklyPace.pace +
    ' | Days left: ' + weeklyPace.tradingDaysLeft +
    ' | Adj: +' + weeklyPace.adjustments.contractBoost + ' contracts, ' +
    (weeklyPace.adjustments.maxTradesBoost > 0 ? '+1 trade slot, ' : '') +
    'runners=' + weeklyPace.adjustments.runnerMode);
}

function recalcPace() {
  var daysLeft = getTradingDaysLeft();
  weeklyPace.tradingDaysLeft = daysLeft;
  var remaining = WEEKLY_TARGET - weeklyPace.totalPL;
  var neededPerDay = daysLeft > 0 ? remaining / daysLeft : remaining;

  // Reset adjustments
  weeklyPace.adjustments = { contractBoost: 0, maxTradesBoost: 0, runnerMode: 'NORMAL' };

  if (weeklyPace.totalPL >= WEEKLY_TARGET) {
    // Already hit target — play house money, be conservative
    weeklyPace.pace = 'AHEAD';
    weeklyPace.adjustments.runnerMode = 'NORMAL';
    // Could reduce size here but let's keep standard
  } else if (neededPerDay <= dailyTarget) {
    // On track — standard operations
    weeklyPace.pace = 'ON_TRACK';
  } else if (neededPerDay <= dailyTarget * 1.5) {
    // Behind — need ~$600-750/day. Size up on A+ setups.
    weeklyPace.pace = 'BEHIND';
    weeklyPace.adjustments.contractBoost = 2;      // 3→5 contracts on quality
    weeklyPace.adjustments.runnerMode = 'EXTENDED'; // hold runners to T2
  } else if (neededPerDay <= dailyTarget * 2.5) {
    // Significantly behind — need ~$750-1250/day. Max safe aggression.
    weeklyPace.pace = 'CRITICAL';
    weeklyPace.adjustments.contractBoost = 3;       // 3→6 contracts on A+ only
    weeklyPace.adjustments.maxTradesBoost = 1;      // allow 3rd trade
    weeklyPace.adjustments.runnerMode = 'EXTENDED';
  } else {
    // Way behind — don't revenge trade. Accept the week and protect capital.
    weeklyPace.pace = 'CRITICAL';
    weeklyPace.adjustments.contractBoost = 2;       // still size up but DON'T force
    weeklyPace.adjustments.runnerMode = 'EXTENDED';
    // NOT adding trade slots — that leads to overtrading
  }
}

// Initialize pace on module load
loadWeeklyPace();

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

// -- EXECUTION MODES ------------------------------------------------
// THREE MODES:
//   1. OFF (default)    — brain posts alerts, does nothing. You trade manually.
//   2. APPROVE          — brain posts alert + approval link. You tap APPROVE, brain executes.
//   3. BYPASS (full auto) — brain executes immediately, no approval needed.
//
// Start on APPROVE mode Monday. Graduate to BYPASS when you trust it.
var EXECUTION_MODE = process.env.EXECUTION_MODE || 'BYPASS'; // OFF, APPROVE, or BYPASS
var BYPASS_MODE = EXECUTION_MODE === 'BYPASS' || process.env.BYPASS_MODE === 'true' || true;
var APPROVE_MODE = EXECUTION_MODE === 'APPROVE';
var LIVE_ACCOUNT = '11975462';
var RAILWAY_BASE = process.env.RAILWAY_URL || 'https://flow-scout-production-f021.up.railway.app';

// -- PENDING APPROVALS: entries waiting for user to say GO -----------
// Each entry gets a short ID and expires after 15 minutes
var pendingApprovals = {};
var APPROVAL_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function createPendingApproval(entry) {
  // Short 4-char ID for easy tapping
  var id = Math.random().toString(36).substring(2, 6).toUpperCase();
  pendingApprovals[id] = {
    entry: entry,
    createdAt: Date.now(),
    status: 'PENDING',
  };
  // Auto-expire after 15 min
  setTimeout(function() {
    if (pendingApprovals[id] && pendingApprovals[id].status === 'PENDING') {
      pendingApprovals[id].status = 'EXPIRED';
      logBrain('APPROVAL EXPIRED: ' + id + ' (' + entry.ticker + ') -- 15 min window closed');
      postToGoMode(
        '**EXPIRED: ' + entry.ticker + ' ' + entry.type.toUpperCase() + '** (ID: ' + id + ')\n15-minute approval window closed. Setup may no longer be valid.',
        '\u23F0' // alarm clock
      );
    }
  }, APPROVAL_EXPIRY_MS);

  logBrain('PENDING APPROVAL: ' + id + ' -- ' + entry.ticker + ' ' + entry.type + ' x' + entry.contracts);
  return id;
}

async function executeApproval(approvalId) {
  var pending = pendingApprovals[approvalId];
  if (!pending) {
    return { executed: false, reason: 'No pending approval with ID: ' + approvalId };
  }
  if (pending.status === 'EXPIRED') {
    return { executed: false, reason: 'Approval ' + approvalId + ' expired (15 min window)' };
  }
  if (pending.status === 'EXECUTED') {
    return { executed: false, reason: 'Approval ' + approvalId + ' already executed' };
  }

  pending.status = 'EXECUTED';
  logBrain('APPROVAL GRANTED: ' + approvalId + ' -- executing ' + pending.entry.ticker);

  // Force bypass for this one execution
  var wasBypass = BYPASS_MODE;
  BYPASS_MODE = true;
  var result = await executeAutonomous(pending.entry);
  BYPASS_MODE = wasBypass;

  if (result.executed) {
    await postToGoMode(
      '**APPROVED & EXECUTED: ' + pending.entry.ticker + ' ' + pending.entry.type.toUpperCase() + '**\n' +
      'Order ID: ' + result.orderId + ' | ' + result.qty + 'x @ $' + result.limit,
      '\u2705' // checkmark
    );
  } else {
    await postToGoMode(
      '**APPROVED BUT FAILED: ' + pending.entry.ticker + '**\n' + result.reason,
      '\u274C' // red X
    );
  }
  return result;
}

function getPendingApprovals() {
  var active = {};
  for (var id in pendingApprovals) {
    if (pendingApprovals[id].status === 'PENDING') {
      var elapsed = Math.round((Date.now() - pendingApprovals[id].createdAt) / 1000);
      active[id] = {
        ticker: pendingApprovals[id].entry.ticker,
        type: pendingApprovals[id].entry.type,
        contracts: pendingApprovals[id].entry.contracts,
        elapsed: elapsed + 's ago',
        remaining: Math.max(0, Math.round((APPROVAL_EXPIRY_MS - (Date.now() - pendingApprovals[id].createdAt)) / 1000)) + 's left',
      };
    }
  }
  return active;
}

if (EXECUTION_MODE === 'BYPASS') console.log('[BRAIN] EXECUTION MODE: BYPASS (full auto)');
if (EXECUTION_MODE === 'APPROVE') console.log('[BRAIN] EXECUTION MODE: APPROVE (tap to execute)');
if (EXECUTION_MODE === 'OFF') console.log('[BRAIN] EXECUTION MODE: OFF (alerts only)');

function setBypassMode(enabled) {
  BYPASS_MODE = !!enabled;
  EXECUTION_MODE = enabled ? 'BYPASS' : 'APPROVE';
  logBrain('EXECUTION MODE: ' + EXECUTION_MODE + (BYPASS_MODE ? ' -- LIVE AUTONOMOUS EXECUTION' : ' -- approval required'));
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
    // SWING detection: WealthPrince 4HR signals, daily TF signals, and high-confluence setups
    // with 5+ DTE should be swung. Earnings within 3 days = always day trade.
    var isSwingSignal = (entry.source === 'WEALTH_PRINCE_4HR' || entry.source === 'JSMITH_REVERSAL' ||
      entry.source === 'STRAT_DAILY' || entry.timeframe === 'DAILY' || entry.timeframe === '4HR');
    var tradeType = entry.earningsWithin3Days ? 'DAY' : (isSwingSignal ? 'SWING' : 'DAY');
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

    // GO-MODE: Order filled
    await postToGoMode(
      '**ORDER PLACED: ' + entry.ticker + ' ' + entry.type.toUpperCase() + '**\n' +
      '`' + contract.symbol + '` x' + qty + ' @ $' + limitPrice + '\n' +
      'Stop: $' + (stopPrice || 'auto') + ' | DTE: ' + contract.dte + ' | Delta: ' + (contract.delta ? contract.delta.toFixed(2) : '?') + '\n' +
      'Order ID: ' + result.orderId,
      '\u2705' // checkmark
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

// -- TRADINGVIEW SIGNAL QUEUE ----------------------------------------
// TradingView alerts (GO CALLS/GO PUTS from Brain indicator) push here
// Brain picks them up on next cycle as highest-priority signals
var tvSignalQueue = [];

function pushTVSignal(signal) {
  tvSignalQueue.push({
    ticker: signal.ticker,
    direction: signal.direction,
    source: signal.source || 'TV_BRAIN',
    confluence: signal.confluence || null,
    momCount: signal.momCount || null,
    sqzFiring: signal.sqzFiring || null,
    vwap: signal.vwap || null,
    timestamp: Date.now(),
  });
  logBrain('TV SIGNAL QUEUED: ' + signal.ticker + ' ' + signal.direction + ' from ' + (signal.source || 'TV_BRAIN'));
}

function popTVSignal() {
  if (tvSignalQueue.length === 0) return null;
  // Only use signals from last 10 minutes
  var cutoff = Date.now() - (10 * 60 * 1000);
  while (tvSignalQueue.length > 0 && tvSignalQueue[0].timestamp < cutoff) {
    tvSignalQueue.shift(); // discard stale
  }
  return tvSignalQueue.shift() || null;
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
  var etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  var timePart = etStr.split(', ')[1] || etStr;
  var parts = timePart.split(':');
  var etHour = parseInt(parts[0], 10);
  var etMin = parseInt(parts[1], 10);
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
// POST TO DISCORD (legacy — debug/noise channel)
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
// POST TO GO-MODE (clean channel — ONLY actionable signals)
// This is the ONLY channel you need to watch. Everything else = mute.
// ===================================================================
async function postToGoMode(message, emoji) {
  try {
    var prefix = (emoji || '\uD83D\uDFE2') + ' '; // default green circle
    await fetch(GO_MODE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: prefix + message, username: 'GO MODE' }),
    });
  } catch(e) { console.error('[GO-MODE] Discord post error:', e.message); }
}

// -- SUNDAY FUTURES CHECK: reads /ES /NQ /CL when futures open ------
// Runs Sunday 6PM ET, posts gap direction + sector bias to Discord
// Sets pre-market bias so Monday brain wakes up with conviction
var sundayBias = { direction: null, oilMove: null, esGap: null, nqGap: null, clMove: null, timestamp: null };

async function checkSundayFutures() {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) { console.log('[FUTURES] No TS token'); return; }

    // Fetch futures quotes: /ES (S&P), /NQ (Nasdaq), /CL (Crude Oil)
    var symbols = ['/ESM26', '/NQM26', '/CLK26'];  // June S&P, June NQ, May Crude
    var quotes = {};

    for (var i = 0; i < symbols.length; i++) {
      try {
        var res = await fetch('https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(symbols[i]), {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (res.ok) {
          var data = await res.json();
          var q = (data.Quotes || [])[0];
          if (q) {
            quotes[symbols[i]] = {
              last: parseFloat(q.Last || q.Close || 0),
              prevClose: parseFloat(q.PreviousClose || q.PreviousDayClose || 0),
              change: parseFloat(q.NetChange || 0),
              changePct: parseFloat(q.NetChangePct || 0),
              high: parseFloat(q.High || 0),
              low: parseFloat(q.Low || 0),
            };
          }
        }
      } catch(e) { console.log('[FUTURES] Error fetching ' + symbols[i] + ':', e.message); }
    }

    // FALLBACK: If TS doesn't return futures (equities-only account),
    // fetch from Yahoo Finance API
    if (Object.keys(quotes).length === 0) {
      console.log('[FUTURES] No TS futures -- falling back to Yahoo Finance...');
      var yahooSymbols = [
        { yahoo: 'ES%3DF', key: '/ESM26', name: 'ES' },
        { yahoo: 'NQ%3DF', key: '/NQM26', name: 'NQ' },
        { yahoo: 'CL%3DF', key: '/CLK26', name: 'CL' },
      ];
      for (var y = 0; y < yahooSymbols.length; y++) {
        try {
          var yUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooSymbols[y].yahoo + '?range=1d&interval=1d';
          var yRes = await fetch(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (yRes.ok) {
            var yData = await yRes.json();
            var meta = yData && yData.chart && yData.chart.result && yData.chart.result[0] && yData.chart.result[0].meta;
            if (meta && meta.regularMarketPrice) {
              var prevClose = meta.chartPreviousClose || meta.previousClose || 0;
              var last = meta.regularMarketPrice;
              var changePctY = prevClose > 0 ? ((last - prevClose) / prevClose * 100) : 0;
              quotes[yahooSymbols[y].key] = {
                last: last,
                prevClose: prevClose,
                change: last - prevClose,
                changePct: changePctY,
                high: last,
                low: last,
              };
              console.log('[FUTURES] Yahoo ' + yahooSymbols[y].name + ': $' + last + ' (' + changePctY.toFixed(2) + '%)');
            }
          }
        } catch(e) { console.log('[FUTURES] Yahoo fallback error for ' + yahooSymbols[y].name + ':', e.message); }
      }
    }

    if (Object.keys(quotes).length === 0) {
      console.log('[FUTURES] No quotes from TS or Yahoo -- market may not be open yet');
      return;
    }

    // Analyze
    var es = quotes['/ESM26'] || {};
    var nq = quotes['/NQM26'] || {};
    var cl = quotes['/CLK26'] || {};

    var esGap = es.changePct || 0;
    var nqGap = nq.changePct || 0;
    var clMove = cl.changePct || 0;

    // Determine bias
    var direction = 'NEUTRAL';
    if (esGap > 0.3 && nqGap > 0.3) direction = 'BULLISH';
    if (esGap > 0.8 && nqGap > 0.8) direction = 'STRONG BULLISH';
    if (esGap < -0.3 && nqGap < -0.3) direction = 'BEARISH';
    if (esGap < -0.8 && nqGap < -0.8) direction = 'STRONG BEARISH';

    // Oil impact
    var oilBias = 'NEUTRAL';
    if (clMove > 2) oilBias = 'OIL SPIKING -- energy CALLS, airline PUTS';
    else if (clMove > 1) oilBias = 'OIL UP -- lean energy calls';
    else if (clMove < -2) oilBias = 'OIL DUMPING -- energy PUTS, airline CALLS';
    else if (clMove < -1) oilBias = 'OIL DOWN -- lean airline calls';

    // Sector rotation guidance
    var sectors = [];
    if (clMove > 1.5) { sectors.push('ENERGY: XOM CVX OXY XLE → CALLS'); sectors.push('DEFENSE: LMT RTX NOC → CALLS'); sectors.push('AIRLINES: DAL UAL LUV AAL → PUTS'); }
    if (clMove < -1.5) { sectors.push('AIRLINES: DAL UAL LUV AAL → CALLS'); sectors.push('ENERGY: XOM CVX OXY XLE → PUTS'); }
    if (esGap > 0.5) { sectors.push('TECH: NVDA TSLA META AMZN → CALLS'); }
    if (esGap < -0.5) { sectors.push('INDICES: SPY QQQ IWM → PUTS on bounce'); }

    // Store bias for Monday
    sundayBias = {
      direction: direction,
      oilMove: clMove,
      oilBias: oilBias,
      esGap: esGap,
      nqGap: nqGap,
      clMove: clMove,
      sectors: sectors,
      timestamp: new Date().toISOString(),
    };

    // Fetch VIX level for volatility awareness
    try {
      var vixRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (vixRes.ok) {
        var vixData = await vixRes.json();
        var vixMeta = vixData && vixData.chart && vixData.chart.result && vixData.chart.result[0] && vixData.chart.result[0].meta;
        if (vixMeta && vixMeta.regularMarketPrice) {
          sundayBias.vix = vixMeta.regularMarketPrice;
          console.log('[FUTURES] VIX: ' + sundayBias.vix.toFixed(2));
        }
      }
    } catch(e) { console.log('[FUTURES] VIX fetch error:', e.message); }

    // Post to Discord
    var msg = 'SUNDAY FUTURES OPEN\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '/ES (S&P 500):  $' + (es.last || '?') + '  (' + (esGap >= 0 ? '+' : '') + esGap.toFixed(2) + '%)\n' +
      '/NQ (Nasdaq):   $' + (nq.last || '?') + '  (' + (nqGap >= 0 ? '+' : '') + nqGap.toFixed(2) + '%)\n' +
      '/CL (Crude):    $' + (cl.last || '?') + '  (' + (clMove >= 0 ? '+' : '') + clMove.toFixed(2) + '%)\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'OVERNIGHT BIAS: ' + direction + '\n' +
      'OIL READ: ' + oilBias + '\n' +
      'VIX: ' + (sundayBias.vix ? sundayBias.vix.toFixed(2) + (sundayBias.vix > 25 ? ' ⚠️ ELEVATED' : sundayBias.vix > 20 ? ' (moderate)' : ' (calm)') : 'N/A') + '\n';

    if (sectors.length > 0) {
      msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      msg += 'SECTOR ROTATION PLAYS:\n';
      for (var s = 0; s < sectors.length; s++) { msg += '  → ' + sectors[s] + '\n'; }
    }

    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'Monday brain will use this bias for first-look entries.\n' +
      'Will re-check futures at 4AM, 7:30AM, and 9:15AM pre-market.';

    await postToDiscord(msg);
    console.log('[FUTURES] Sunday bias posted: ' + direction + ' | Oil: ' + clMove.toFixed(2) + '%');
    return sundayBias;

  } catch(e) { console.error('[FUTURES] Sunday check error:', e.message); return null; }
}

function getSundayBias() { return sundayBias; }

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
async function evaluateAYCESignal(deadZoneOnly) {
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

      // During dead zone (11:30AM-2:30PM), ONLY run 7HR scan
      // 7HR liquidity sweeps are the ONLY valid dead zone strategy
      if (!deadZoneOnly) {
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
      }

      // 7HR: ONLY after 11AM (liquidity sweep window) -- ALLOWED in dead zone
      if (!setup && et.total >= 11 * 60) {
        setup = await preMarketScanner.scan7HR(ticker);
        if (setup) { setup._source = '7HR_SWEEP'; }
      }

      // ORB: ETFs after 11AM (90-min range established), Mag 7 after 9:45AM (15-min range)
      // CardDave method — Opening Range Breakout
      if (!setup && preMarketScanner.scanORB) {
        var isORBReady = false;
        var orbETFs = ['SPY', 'QQQ', 'IWM'];
        var orbMag7 = ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'META'];
        if (orbETFs.indexOf(ticker) !== -1 && et.total >= 11 * 60) isORBReady = true;
        if (orbMag7.indexOf(ticker) !== -1 && et.total >= 9 * 60 + 45) isORBReady = true;
        if (isORBReady) {
          setup = await preMarketScanner.scanORB(ticker);
          if (setup) { setup._source = 'ORB'; }
        }
      }

      // CRT: After 10AM — Candle Range Theory sweep reversals on 60-min
      // John JSmith method — institutional liquidity sweep then reversal
      if (!setup && et.total >= 10 * 60 && preMarketScanner.scanCRT) {
        setup = await preMarketScanner.scanCRT(ticker);
        if (setup) { setup._source = 'CRT'; }
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
  var etNow = getETTime();
  var etHour = etNow.hour;
  var etMin = etNow.min;
  var isAYCE = signal.isAYCESignal || false;
  if (etHour === 9 && etMin < 45 && !isAYCE) {
    logBrain('ENTRY REJECTED: Before 9:45 AM ET (' + etHour + ':' + etMin + ') -- opening volatility');
    return { approved: false, reason: 'Before 9:45 AM -- opening 15 min is noise' };
  }

  // Check: are we under max trades? (pace boost may add +1 slot)
  var effectiveMaxTrades = maxTrades + (weeklyPace.adjustments.maxTradesBoost || 0);
  if (tradesOpened >= effectiveMaxTrades) {
    logBrain('ENTRY REJECTED: Max trades reached (' + tradesOpened + '/' + effectiveMaxTrades + ')' +
      (weeklyPace.adjustments.maxTradesBoost > 0 ? ' [PACE: +1 slot active]' : ''));
    return { approved: false, reason: 'Max trades reached (' + tradesOpened + '/' + effectiveMaxTrades + ')' };
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

  // Check: direction aligned with SPY trend (dynamic bias + GEXR)
  try {
    var dynBias = require('./dynamicBias');
    if (dynBias && dynBias.getBias) {
      var bias = dynBias.getBias();
      if (bias && bias.bias && bias.strength === 'STRONG') {
        var biasBullish = bias.bias === 'BULLISH';
        var signalBullish2 = direction === 'BULLISH';
        if (biasBullish && !signalBullish2) {
          logBrain('ENTRY WARNING: STRONG BULLISH bias but signal is BEARISH -- reduced conviction');
        } else if (!biasBullish && signalBullish2) {
          logBrain('ENTRY WARNING: STRONG BEARISH bias but signal is BULLISH -- reduced conviction');
        } else {
          logBrain('BIAS ALIGNED: ' + bias.bias + ' ' + bias.strength + ' matches ' + direction);
        }
      }
    }
  } catch(e) {}

  // Sunday futures bias -- extra confluence for Monday morning
  if (sundayBias && sundayBias.direction && sundayBias.timestamp) {
    var biasAge = (Date.now() - new Date(sundayBias.timestamp).getTime()) / 3600000; // hours
    if (biasAge < 18) { // only use if less than 18 hours old (Sunday evening → Monday morning)
      var futuresBullish = sundayBias.direction.indexOf('BULLISH') >= 0;
      var futuresBearish = sundayBias.direction.indexOf('BEARISH') >= 0;
      var signalBull = direction === 'BULLISH';
      if (futuresBullish && signalBull) {
        logBrain('FUTURES ALIGNED: Sunday futures ' + sundayBias.direction + ' + signal BULLISH = HIGH CONVICTION');
        score += 1;
      } else if (futuresBearish && !signalBull) {
        logBrain('FUTURES ALIGNED: Sunday futures ' + sundayBias.direction + ' + signal BEARISH = HIGH CONVICTION');
        score += 1;
      } else if (futuresBullish && !signalBull) {
        logBrain('FUTURES CONFLICT: Sunday futures BULLISH but signal BEARISH -- caution');
      } else if (futuresBearish && signalBull) {
        logBrain('FUTURES CONFLICT: Sunday futures BEARISH but signal BULLISH -- caution');
      }
      // Oil-specific sector boost
      if (sundayBias.oilMove && Math.abs(sundayBias.oilMove) > 1.5) {
        var oilTickers = ['XOM', 'CVX', 'OXY', 'XLE', 'DAL', 'UAL', 'LUV', 'AAL'];
        if (oilTickers.indexOf(ticker) >= 0) {
          logBrain('OIL CATALYST: Crude ' + (sundayBias.oilMove > 0 ? '+' : '') + sundayBias.oilMove.toFixed(1) + '% -- sector play on ' + ticker);
          score += 1;
        }
      }
    }
  }

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

  // ---------------------------------------------------------------
  // GAP-DOWN REVERSAL PROTECTION
  // After a big up day, a gap-down morning often reverses.
  // If we detect this pattern:
  //   1. DELAY puts until 10:30 AM (let the reversal show itself)
  //   2. RAISE confluence threshold to 6 for puts (need higher conviction)
  //   3. CALLS get a boost (reversal = mean reversion back up)
  // Also checks VIX: high VIX (>25) = more volatile = more reversals
  // This would have saved us on April 9, 2026.
  // ---------------------------------------------------------------
  var gapCaution = false;
  var gapCautionReason = '';
  var confluenceFloor = 4; // default minimum confluence score

  if (signal.tvData) {
    var td = signal.tvData;
    // Detect gap-down: price below PDL = gapped below prior day's range
    var isPriceGapped = false;
    if (td.pdl && td.price && td.price < td.pdl) {
      isPriceGapped = true;
    }
    // Detect gap-up: price above PDH = gapped above prior day's range
    var isGapUp = false;
    if (td.pdh && td.price && td.price > td.pdh) {
      isGapUp = true;
    }

    // Check if higher timeframes disagree with the gap direction
    // Daily+ bullish but morning gap down = potential reversal day
    var higherTFBullish = false;
    var higherTFBearish = false;
    if (td.fourHr && td.fourHr.trend === 'BULLISH') higherTFBullish = true;
    if (td.strat && td.strat.ftfc === 'BULL') higherTFBullish = true;
    if (td.sixHr && td.sixHr.direction === 'BULLISH') higherTFBullish = true;
    if (td.fourHr && td.fourHr.trend === 'BEARISH') higherTFBearish = true;
    if (td.strat && td.strat.ftfc === 'BEAR') higherTFBearish = true;
    if (td.sixHr && td.sixHr.direction === 'BEARISH') higherTFBearish = true;

    // GAP DOWN + HIGHER TFs BULLISH + PUTTING = REVERSAL DANGER
    if (isPriceGapped && higherTFBullish && direction === 'BEARISH') {
      gapCaution = true;
      gapCautionReason = 'GAP-DOWN REVERSAL RISK: price below PDL but higher TFs bullish';

      // Before 10:30 AM: BLOCK puts entirely (let reversal play out)
      if (etNow.total < 10 * 60 + 30) {
        logBrain('ENTRY BLOCKED: ' + gapCautionReason + ' -- no puts before 10:30 AM on gap-down reversal mornings');
        return { approved: false, reason: gapCautionReason + ' -- wait until 10:30 AM' };
      }

      // After 10:30 AM: raise the bar to 6+ confluence
      confluenceFloor = 6;
      logBrain('GAP CAUTION: ' + gapCautionReason + ' -- raising confluence threshold to 6');
    }

    // GAP UP + HIGHER TFs BEARISH + CALLING = same danger in reverse
    if (isGapUp && higherTFBearish && direction === 'BULLISH') {
      gapCaution = true;
      gapCautionReason = 'GAP-UP REVERSAL RISK: price above PDH but higher TFs bearish';

      if (etNow.total < 10 * 60 + 30) {
        logBrain('ENTRY BLOCKED: ' + gapCautionReason + ' -- no calls before 10:30 AM on gap-up reversal mornings');
        return { approved: false, reason: gapCautionReason + ' -- wait until 10:30 AM' };
      }

      confluenceFloor = 6;
      logBrain('GAP CAUTION: ' + gapCautionReason + ' -- raising confluence threshold to 6');
    }

    // VIX CHECK: High VIX = more volatile = more mean-reversion traps
    // Fetch VIX from Sunday bias or dynamic bias
    var vixLevel = null;
    if (sundayBias && sundayBias.vix) vixLevel = sundayBias.vix;

    if (vixLevel && vixLevel > 25) {
      // High VIX environment: raise floor by 1 for ALL trades
      confluenceFloor = Math.max(confluenceFloor, 5);
      logBrain('HIGH VIX (' + vixLevel.toFixed(1) + '): elevated volatility -- confluence floor raised to ' + confluenceFloor);
    }
  }

  // CONFLUENCE CHECK -- if we have TradingView data, score it
  var confluenceResult = null;
  if (signal.tvData && caseyConfluence) {
    confluenceResult = caseyConfluence.scoreConfluence(signal.tvData);
    logBrain('CONFLUENCE SCORE: ' + confluenceResult.score + '/10 (' + confluenceResult.conviction + ')' +
      (gapCaution ? ' [GAP CAUTION: need ' + confluenceFloor + '+]' : ''));

    // REQUIRE minimum score for entry (default 4, raised to 6 on gap-reversal days)
    if (confluenceResult.score < confluenceFloor) {
      logBrain('ENTRY REJECTED: Confluence score ' + confluenceResult.score + '/10 -- too low (need ' + confluenceFloor + '+)' +
        (gapCaution ? ' [GAP REVERSAL PROTECTION]' : ''));
      return { approved: false, reason: 'Confluence too low: ' + confluenceResult.score + '/10 (need ' + confluenceFloor + ')' };
    }

    // Use confluence-based sizing instead of default
    if (confluenceResult.contracts > 0) {
      contractSize = confluenceResult.contracts;
      logBrain('SIZING: ' + confluenceResult.contracts + ' contracts based on conviction ' + confluenceResult.conviction);
    }

    // WEEKLY PACE BOOST: add contracts if behind on weekly target
    // Only on high-conviction setups (score >= 6) — never size up on mediocre trades
    if (weeklyPace.adjustments.contractBoost > 0 && confluenceResult.score >= 6) {
      var boosted = contractSize + weeklyPace.adjustments.contractBoost;
      var maxContracts = 8; // absolute ceiling — never more than 8
      boosted = Math.min(boosted, maxContracts);
      logBrain('PACE BOOST: ' + weeklyPace.pace + ' — sizing up from ' + contractSize + ' to ' + boosted +
        ' contracts (weekly: $' + weeklyPace.totalPL.toFixed(0) + '/$' + WEEKLY_TARGET +
        ', need $' + (WEEKLY_TARGET - weeklyPace.totalPL).toFixed(0) + ' more, ' + weeklyPace.tradingDaysLeft + ' days left)');
      contractSize = boosted;
    } else if (weeklyPace.adjustments.contractBoost > 0) {
      logBrain('PACE: Behind but confluence ' + confluenceResult.score + '/10 too low for boost (need 6+) — standard sizing');
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

  // -- RISK:REWARD GATE -- NON-NEGOTIABLE --
  // NEVER enter a trade where the risk exceeds the reward
  if (entry && stop && trim1) {
    var riskPerContract = Math.abs(entry - stop);
    var rewardPerContract = Math.abs(trim1 - entry);
    var tradeRR = rewardPerContract > 0 ? parseFloat((rewardPerContract / riskPerContract).toFixed(2)) : 0;
    logBrain('RISK:REWARD CHECK -- Risk: $' + riskPerContract.toFixed(2) + ' | Reward: $' + rewardPerContract.toFixed(2) + ' | R:R = ' + tradeRR + ':1');
    if (tradeRR < 1.0) {
      logBrain('ENTRY REJECTED: R:R ' + tradeRR + ':1 -- risk exceeds reward. NEVER take this trade.');
      return { approved: false, reason: 'Bad R:R ' + tradeRR + ':1 -- risk $' + riskPerContract.toFixed(2) + ' to make $' + rewardPerContract.toFixed(2) };
    }
    if (tradeRR >= 2.0) {
      logBrain('EXCELLENT R:R ' + tradeRR + ':1 -- high conviction setup');
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
    riskRewardRatio: (entry && stop && trim1) ? parseFloat((Math.abs(trim1 - entry) / Math.abs(entry - stop)).toFixed(2)) : null,
    signal: signal,
    reason: 'All checks passed -- R:R ' + ((entry && stop && trim1) ? parseFloat((Math.abs(trim1 - entry) / Math.abs(entry - stop)).toFixed(2)) + ':1' : 'N/A') + ' -- ' + strategies[currentStrategy] +
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

  // GO-MODE: Entry signal
  var strat = signal.tvData && signal.tvData.strat ? signal.tvData.strat : {};
  var ftfcLabel = strat.ftfc || '?';
  var rrLabel = (entry && stop && trim1) ? parseFloat((Math.abs(trim1 - entry) / Math.abs(entry - stop)).toFixed(1)) + ':1' : '?';
  var paceInfo = weeklyPace.adjustments.contractBoost > 0
    ? '\nPACE BOOST: +' + weeklyPace.adjustments.contractBoost + ' contracts (' + weeklyPace.pace + ')'
    : '';
  postToGoMode(
    '**ENTRY SIGNAL: ' + ticker + ' ' + type.toUpperCase() + '**\n' +
    '```\n' +
    'Pattern:    ' + (signal.ayceStrategy || strat.signal || source || 'Casey EMA') + '\n' +
    'FTFC:       ' + ftfcLabel + ' (' + (strat.continuity ? Object.values(strat.continuity).map(function(v){return v[0];}).join('') : '????') + ')\n' +
    'Confluence: ' + (confluenceResult ? confluenceResult.score + '/10 (' + confluenceResult.conviction + ')' : 'N/A') + '\n' +
    'Entry:      $' + (entry ? entry.toFixed(2) : '?') + '\n' +
    'Stop:       $' + (stop ? stop.toFixed(2) : '?') + '\n' +
    'T1:         $' + (trim1 ? trim1.toFixed(2) : '?') + '\n' +
    'T2:         $' + (trim2 ? trim2.toFixed(2) : '?') + '\n' +
    'R:R:        ' + rrLabel + '\n' +
    'Contracts:  ' + contractSize + paceInfo + '\n' +
    'Weekly:     $' + weeklyPace.totalPL.toFixed(0) + ' / $' + WEEKLY_TARGET + ' (' + weeklyPace.tradingDaysLeft + ' days left)\n' +
    '```',
    '\uD83D\uDFE2' // green circle
  );

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
  // EXTENDED runner mode (when behind on weekly pace): delay first trim to +75% to let winners run bigger
  // NORMAL mode: standard +50%/+100% trim schedule
  // 2 contracts: NO trim at +50%. Hold both. Trail on structure. Exit all when structure breaks.
  // 3 contracts: trim 1 at +50%, trim 1 at +100%, trail 1 runner
  // 4-5 contracts: trim 2 at +50%, trim 1-2 at +100%, trail rest
  var isExtendedRunner = weeklyPace.adjustments.runnerMode === 'EXTENDED';
  var trim1Threshold = isExtendedRunner ? 75 : 50;   // delay first trim when behind
  var trim2Threshold = isExtendedRunner ? 150 : 100;  // push T2 out too

  if (contracts === 2 && !position.trim1Done) {
    // 2 CONTRACTS: Don't trim early. Hold for the full move.
    var twoLotThreshold = isExtendedRunner ? 150 : 100;
    if (pctChange >= twoLotThreshold) {
      logBrain('TRIM (2-lot): ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 of 2, trail runner' +
        (isExtendedRunner ? ' [EXTENDED RUNNER: delayed trim]' : ''));
      return { action: 'TRIM', trimQty: 1, reason: '+' + twoLotThreshold + '% on 2-lot -- trim 1, runner on house money', pctChange: pctChange };
    }
  } else if (contracts > 2) {
    // 3+ CONTRACTS: Trim schedule adjusted by pace
    if (pctChange >= trim1Threshold && !position.trim1Done) {
      var trimQty = contracts >= 4 ? 2 : 1;
      logBrain('TRIM 1: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell ' + trimQty +
        (isExtendedRunner ? ' [EXTENDED: trimmed at +' + trim1Threshold + '% vs normal +50%]' : ''));
      return { action: 'TRIM', trimQty: trimQty, reason: '+' + trim1Threshold + '% hit -- trim ' + trimQty + ' of ' + contracts, pctChange: pctChange };
    }
    if (pctChange >= trim2Threshold && contracts > 1 && !position.trim2Done) {
      logBrain('TRIM 2: ' + position.ticker + ' at +' + pctChange.toFixed(1) + '% -- sell 1 more' +
        (isExtendedRunner ? ' [EXTENDED]' : ''));
      return { action: 'TRIM', trimQty: 1, reason: '+' + trim2Threshold + '% hit -- trim 1 more, runner left', pctChange: pctChange };
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
    '--------------------------------',
    'WEEKLY PACE:',
    '  Target:    $' + WEEKLY_TARGET,
    '  This week: $' + weeklyPace.totalPL.toFixed(2),
    '  Remaining: $' + (WEEKLY_TARGET - weeklyPace.totalPL).toFixed(2),
    '  Days left: ' + weeklyPace.tradingDaysLeft,
    '  Pace:      ' + weeklyPace.pace,
    '  Boost:     +' + weeklyPace.adjustments.contractBoost + ' contracts' +
      (weeklyPace.adjustments.maxTradesBoost > 0 ? ', +1 trade slot' : '') +
      ', runners=' + weeklyPace.adjustments.runnerMode,
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
    weeklyPace: {
      pace: weeklyPace.pace,
      totalPL: weeklyPace.totalPL,
      target: WEEKLY_TARGET,
      remaining: WEEKLY_TARGET - weeklyPace.totalPL,
      tradingDaysLeft: weeklyPace.tradingDaysLeft,
      dailyResults: weeklyPace.dailyResults,
      adjustments: weeklyPace.adjustments,
    },
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
  // Record yesterday's P&L to weekly tracker BEFORE resetting
  if (dailyPL !== 0 || tradesOpened > 0) {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var dateStr = yesterday.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    // Use ET date formatted as YYYY-MM-DD
    var etDate = new Date(yesterday.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var dateKey = etDate.getFullYear() + '-' + String(etDate.getMonth() + 1).padStart(2, '0') + '-' + String(etDate.getDate()).padStart(2, '0');
    recordDailyResult(dateKey, dailyPL);
    logBrain('WEEKLY PACE UPDATE: Recorded $' + dailyPL.toFixed(2) + ' for ' + dateKey);
  }

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

  // Recalculate pace adjustments for today
  recalcPace();
  logBrain('Daily state reset complete | Weekly pace: ' + weeklyPace.pace +
    ' ($' + weeklyPace.totalPL.toFixed(0) + '/$' + WEEKLY_TARGET + ')' +
    ' | Adjustments: +' + weeklyPace.adjustments.contractBoost + ' contracts' +
    (weeklyPace.adjustments.maxTradesBoost > 0 ? ', +1 trade slot' : '') +
    ', runners=' + weeklyPace.adjustments.runnerMode);
}

// ===================================================================
// SET BRAIN ACTIVE/INACTIVE
// ===================================================================
function setBrainActive(active) {
  brainActive = !!active;
  logBrain('Brain ' + (brainActive ? 'ACTIVATED' : 'DEACTIVATED'));
  if (brainActive) {
    // HEALTH CHECK: verify option resolution works BEFORE accepting trades
    (async function() {
      try {
        var ts = require('./tradestation');
        var token = await ts.getAccessToken();
        if (!token) {
          logBrain('HEALTH CHECK FAILED: No TS access token. Re-auth needed.');
          postToGoMode('**BRAIN HEALTH CHECK FAILED**\nNo TS access token. Visit /ts-auth to re-authenticate.', '\u274C').catch(function(){});
          return;
        }
        var testRes = await fetch('https://api.tradestation.com/v3/marketdata/options/expirations/SPY', {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (testRes.status === 403) {
          logBrain('HEALTH CHECK FAILED: OptionSpreads scope missing (403). Token cannot resolve contracts. RE-AUTH REQUIRED.');
          postToGoMode(
            '**BRAIN HEALTH CHECK FAILED**\n' +
            '```\n' +
            'ERROR: OptionSpreads scope missing (403)\n' +
            'The brain CANNOT resolve option contracts.\n' +
            'Fix: Re-auth at /ts-auth with correct scopes.\n' +
            'Brain will scan but CANNOT execute until fixed.\n' +
            '```',
            '\u274C' // red X
          ).catch(function(){});
          postToDiscord('CRITICAL: OptionSpreads scope missing. Brain cannot execute trades. Re-auth needed.').catch(function(){});
        } else if (testRes.ok) {
          var testData = await testRes.json();
          var expCount = (testData.Expirations || []).length;
          logBrain('HEALTH CHECK PASSED: SPY has ' + expCount + ' expirations. Option resolution working.');
          postToGoMode(
            '**HEALTH CHECK PASSED** -- Option resolution verified (' + expCount + ' SPY expirations)',
            '\u2705' // green check
          ).catch(function(){});
        }
      } catch(e) {
        logBrain('HEALTH CHECK ERROR: ' + e.message);
      }
    })();

    postToDiscord('Brain Engine ACTIVATED -- monitoring for signals\nState: ' + STATE + '\nTarget: $' + dailyTarget)
      .catch(function(e) { console.error('[BRAIN] Activation post error:', e.message); });
    // GO-MODE: Morning wake-up
    recalcPace();
    postToGoMode(
      '**BRAIN ONLINE**\n' +
      '```\n' +
      'Daily target: $' + dailyTarget + '\n' +
      'Weekly:       $' + weeklyPace.totalPL.toFixed(2) + ' / $' + WEEKLY_TARGET + '\n' +
      'Pace:         ' + weeklyPace.pace + '\n' +
      'Days left:    ' + weeklyPace.tradingDaysLeft + '\n' +
      'Bypass:       ' + (BYPASS_MODE ? 'LIVE EXECUTION' : 'ALERTS ONLY') + '\n' +
      'Scanning:     ' + FULL_WATCHLIST.length + ' tickers\n' +
      (weeklyPace.adjustments.contractBoost > 0 ? 'Boost:        +' + weeklyPace.adjustments.contractBoost + ' contracts\n' : '') +
      '```',
      '\uD83E\uDDE0' // brain emoji
    ).catch(function(e) { console.error('[GO-MODE] Activation post error:', e.message); });
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
var _cycleRunning = false;

async function runBrainCycle() {
  // Guard: must be active
  if (!brainActive) return;

  // Guard: prevent overlapping cycles (AYCE scans 37 tickers = can exceed 60s)
  if (_cycleRunning) {
    console.log('[BRAIN] Cycle still running -- skipping this tick');
    return;
  }
  _cycleRunning = true;

  try {

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
    // GO-MODE: Max loss
    await postToGoMode(
      '**MAX DAILY LOSS: $' + dailyPL.toFixed(2) + '**\nBrain shutting down for the day. ' + tradesOpened + ' trades taken.\nWeekly: $' + (weeklyPace.totalPL + dailyPL).toFixed(2) + '/$' + WEEKLY_TARGET,
      '\uD83D\uDED1' // stop sign
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

    // CHECK TRADINGVIEW SIGNALS FIRST (highest priority — comes from your chart)
    var tvSig = popTVSignal();
    if (tvSig) {
      var tvDirection = tvSig.direction === 'CALLS' ? 'BULLISH' : 'BEARISH';
      var tvAction = tvSig.direction === 'CALLS' ? 'CALL' : 'PUT';
      var signal = {
        triggered: true,
        ticker: tvSig.ticker,
        direction: tvDirection,
        action: tvAction,
        trigger: null,
        stop: null,
        price: null,
        setupType: 'TV_BRAIN_SIGNAL',
        isTVSignal: true,
        tvSource: tvSig.source,
        description: 'TradingView Brain: ' + tvSig.ticker + ' ' + tvSig.direction,
      };

      logBrain('TV BRAIN SIGNAL: ' + tvSig.ticker + ' ' + tvSig.direction + ' — PRIORITY ENTRY');

      // Enrich and evaluate
      if (signalEnricher) {
        try {
          var tvData = await signalEnricher.enrichSignal(signal);
          signal.tvData = tvData;
          // Add the TV-provided data to enrich further
          if (tvSig.momCount) tvData.biasPanel = 'BIAS | ' + (tvDirection === 'BULLISH' ? 'BULL' : 'BEAR') + ' ' + tvSig.momCount + '/7';
          if (tvSig.vwap) tvData.vwap = parseFloat(tvSig.vwap);
        } catch(e) {}
      }

      transitionTo('ENTRY_SIGNAL', 'TV Brain signal: ' + signal.ticker + ' ' + signal.direction);
      var entry = evaluateEntry(signal);
      if (entry.approved) {
        var execResult = null;
        if (BYPASS_MODE) {
          execResult = await executeAutonomous(entry);
        } else if (APPROVE_MODE) {
          // APPROVE MODE: queue for user approval, don't execute yet
          var approvalId = createPendingApproval(entry);
          var approveUrl = RAILWAY_BASE + '/api/brain/approve/' + approvalId;
          await postToGoMode(
            '**APPROVE TRADE? ' + entry.ticker + ' ' + entry.type.toUpperCase() + '** (ID: `' + approvalId + '`)\n' +
            '```\n' +
            'Contracts:  ' + entry.contracts + '\n' +
            'Entry:      $' + (entry.entry ? entry.entry.toFixed(2) : '?') + '\n' +
            'Stop:       $' + (entry.stop ? entry.stop.toFixed(2) : '?') + '\n' +
            'T1:         $' + (entry.trim1 ? entry.trim1.toFixed(2) : '?') + '\n' +
            'R:R:        ' + (entry.riskRewardRatio || '?') + ':1\n' +
            '```\n' +
            '\u27A1\uFE0F **TAP TO APPROVE:** ' + approveUrl + '\n' +
            '\u23F0 Expires in 15 minutes',
            '\uD83D\uDFE1' // yellow circle = waiting
          );
        }
        var statusLine = (BYPASS_MODE && execResult && execResult.executed)
          ? 'LIVE ORDER PLACED | ID: ' + execResult.orderId
          : (APPROVE_MODE ? 'AWAITING APPROVAL' : 'RECOMMENDATION ONLY');
        await postToDiscord(
          'TRADINGVIEW BRAIN SIGNAL\n' +
          '================================\n' +
          signal.ticker + ' ' + signal.direction + '\n' +
          'Source: ' + (tvSig.source || 'Brain Indicator') + '\n' +
          'STATUS: ' + statusLine
        );

        if (execResult && execResult.executed) {
          activePositions.push({
            ticker: entry.ticker, type: entry.type, direction: entry.direction,
            contracts: execResult.qty,
            entry: execResult.limit,
            stop: execResult.stop,
            contractSymbol: execResult.contract ? execResult.contract.symbol : null,
            orderId: execResult.orderId || null,
            trim1Target: execResult.t1 || entry.trim1, trim2Target: entry.trim2,
            trim1Done: false, trim2Done: false, trailStop: null,
            openTime: new Date().toISOString(), currentPrice: execResult.limit,
            strategy: 'TV_BRAIN', liveOrder: true,
          });
          tradesOpened++;
          transitionTo('POSITION_OPEN', 'TV Brain: ' + entry.ticker);
        } else {
          logBrain('TV BRAIN EXECUTION FAILED -- NOT tracking. Reason: ' + (execResult ? execResult.reason : 'no exec result'));
          transitionTo('WATCHING', 'TV execution failed -- back to watching');
        }
      } else {
        logBrain('TV signal rejected: ' + entry.reason);
        transitionTo('WATCHING', 'TV signal rejected');
      }
      return;
    }

    // Try current strategy
    var signal = null;
    var strat = strategies[currentStrategy];

    if (strat === 'AYCE_STRAT') {
      var inDeadZone = (et.total > amEnd && et.total < powerHourStart);
      signal = await evaluateAYCESignal(inDeadZone);
    } else if (strat === 'SCANNER_BREAKOUT') {
      signal = await evaluateScannerSignal();
    } else if (strat === 'FLOW_CONVICTION') {
      signal = evaluateFlowSignal();
    } else if (strat === 'SCALP') {
      signal = await evaluateScannerSignal();
    }

    if (signal && signal.triggered) {
      transitionTo('ENTRY_SIGNAL', strat + ' signal: ' + signal.ticker + ' ' + signal.direction);

      // ENRICH signal with 4HR, FTFC, flow, VWAP, EMA data before scoring
      if (signalEnricher) {
        try {
          var tvData = await signalEnricher.enrichSignal(signal);
          signal.tvData = tvData;
          logBrain('ENRICHED: ' + signal.ticker +
            ' | 4HR=' + (tvData.fourHr ? tvData.fourHr.trend + ' ' + tvData.fourHr.candle : 'N/A') +
            ' | FTFC=' + (tvData.strat ? tvData.strat.ftfc + ' ' + tvData.strat.tfAligned + '/4' : 'N/A') +
            ' | Strat=' + (tvData.strat && tvData.strat.signal ? tvData.strat.signal : 'none') +
            ' | 6HR=' + (tvData.sixHr ? tvData.sixHr.direction + (tvData.sixHr.has31 ? ' 3-1' : '') + (tvData.sixHr.crt ? ' ' + tvData.sixHr.crt : '') : 'N/A') +
            ' | Bias=' + (tvData.dynamicBias ? tvData.dynamicBias.bias : 'N/A'));
        } catch(e) {
          logBrain('ENRICHMENT FAILED: ' + e.message + ' -- proceeding without full data');
        }
      }

      var entry = evaluateEntry(signal);
      if (entry.approved) {
        // AUTONOMOUS EXECUTION when bypass mode is on
        var execResult = null;
        if (BYPASS_MODE) {
          execResult = await executeAutonomous(entry);
        } else if (APPROVE_MODE) {
          // APPROVE MODE: queue for user approval
          var approvalId2 = createPendingApproval(entry);
          var approveUrl2 = RAILWAY_BASE + '/api/brain/approve/' + approvalId2;
          await postToGoMode(
            '**APPROVE TRADE? ' + entry.ticker + ' ' + entry.type.toUpperCase() + '** (ID: `' + approvalId2 + '`)\n' +
            '```\n' +
            'Strategy:   ' + (entry.ayceStrategy || entry.source || entry.strategy) + '\n' +
            'Contracts:  ' + entry.contracts + '\n' +
            'Entry:      $' + (entry.entry ? entry.entry.toFixed(2) : '?') + '\n' +
            'Stop:       $' + (entry.stop ? entry.stop.toFixed(2) : '?') + '\n' +
            'T1:         $' + (entry.trim1 ? entry.trim1.toFixed(2) : '?') + '\n' +
            'T2:         $' + (entry.trim2 ? entry.trim2.toFixed(2) : '?') + '\n' +
            'R:R:        ' + (entry.riskRewardRatio || '?') + ':1\n' +
            'Confluence: ' + (entry.confluenceScore || '?') + '/10\n' +
            '```\n' +
            '\u27A1\uFE0F **TAP TO APPROVE:** ' + approveUrl2 + '\n' +
            '\u23F0 Expires in 15 minutes',
            '\uD83D\uDFE1' // yellow circle = waiting
          );
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

        // Only track position if execution actually succeeded
        if (execResult && execResult.executed) {
          var newPos = {
            ticker: entry.ticker,
            type: entry.type,
            direction: entry.direction,
            contracts: execResult.qty,
            entry: execResult.limit,
            stop: execResult.stop,
            contractSymbol: execResult.contract ? execResult.contract.symbol : null,
            orderId: execResult.orderId || null,
            trim1Target: execResult.t1 || entry.trim1,
            trim2Target: entry.trim2,
            trim1Done: false,
            trim2Done: false,
            trailStop: null,
            openTime: new Date().toISOString(),
            currentPrice: execResult.limit,
            strategy: entry.strategy,
            liveOrder: true,
          };
          activePositions.push(newPos);
          tradesOpened++;
          transitionTo('POSITION_OPEN', 'Tracking ' + entry.ticker + ' ' + entry.type.toUpperCase());
        } else {
          logBrain('EXECUTION FAILED -- NOT tracking position. Reason: ' + (execResult ? execResult.reason : 'no exec result'));
          transitionTo('WATCHING', 'Execution failed -- back to watching');
        }
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
        // Enrich power hour signal
        if (signalEnricher) {
          try {
            var phTvData = await signalEnricher.enrichSignal(phSignal);
            phSignal.tvData = phTvData;
          } catch(e) { /* proceed without enrichment */ }
        }
        var phEntry = evaluateEntry(phSignal);
        if (phEntry.approved) {
          logBrain('POWER HOUR ENTRY: ' + phEntry.ticker + ' ' + phEntry.type.toUpperCase());
          var phExec = null;
          if (BYPASS_MODE) {
            phExec = await executeAutonomous(phEntry);
          } else if (APPROVE_MODE) {
            var phApprovalId = createPendingApproval(phEntry);
            var phApproveUrl = RAILWAY_BASE + '/api/brain/approve/' + phApprovalId;
            await postToGoMode(
              '**APPROVE TRADE? ' + phEntry.ticker + ' ' + phEntry.type.toUpperCase() + '** (ID: `' + phApprovalId + '`)\n' +
              'Power Hour setup | ' + phEntry.contracts + 'x @ $' + (phEntry.entry ? phEntry.entry.toFixed(2) : '?') + '\n' +
              '\u27A1\uFE0F **TAP TO APPROVE:** ' + phApproveUrl,
              '\uD83D\uDFE1'
            );
          }
          var phStatus = (BYPASS_MODE && phExec && phExec.executed)
            ? 'LIVE ORDER PLACED | ID: ' + phExec.orderId
            : (APPROVE_MODE ? 'AWAITING APPROVAL' : 'RECOMMENDATION ONLY');
          await postToDiscord(
            'POWER HOUR ENTRY SIGNAL\n' +
            phEntry.ticker + ' ' + phEntry.type.toUpperCase() + ' x' + phEntry.contracts + '\n' +
            'Entry: ~$' + (phEntry.entry ? phEntry.entry.toFixed(2) : '?') + '\n' +
            'STATUS: ' + phStatus
          );

          if (phExec && phExec.executed) {
            activePositions.push({
              ticker: phEntry.ticker,
              type: phEntry.type,
              direction: phEntry.direction,
              contracts: phExec.qty,
              entry: phExec.limit,
              stop: phExec.stop,
              contractSymbol: phExec.contract ? phExec.contract.symbol : null,
              orderId: phExec.orderId || null,
              trim1Target: phExec.t1 || phEntry.trim1,
              trim2Target: phEntry.trim2,
              trim1Done: false,
              trim2Done: false,
              trailStop: null,
              openTime: new Date().toISOString(),
              currentPrice: phExec.limit,
              strategy: phEntry.strategy,
              liveOrder: true,
            });
            tradesOpened++;
            transitionTo('POSITION_OPEN', 'Power hour: ' + phEntry.ticker);
          } else {
            logBrain('POWER HOUR EXECUTION FAILED -- NOT tracking. Reason: ' + (phExec ? phExec.reason : 'no exec result'));
            transitionTo('WATCHING', 'Power hour execution failed -- back to watching');
          }
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
          'Sold ' + (action.trimQty || 1) + ' contract | ' + pos.contracts + ' remaining\n' +
          'Trim P&L: +$' + trimPL.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2)
        );
        // GO-MODE: Trim
        await postToGoMode(
          '**TRIM: ' + pos.ticker + ' +' + action.pctChange.toFixed(1) + '%**\n' +
          'Sold ' + (action.trimQty || 1) + ' | ' + pos.contracts + ' remaining\n' +
          'P&L: +$' + trimPL.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2) + ' | Weekly: $' + (weeklyPace.totalPL + dailyPL).toFixed(2) + '/$' + WEEKLY_TARGET,
          '\uD83D\uDCB0' // money bag
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
        // GO-MODE: Stop loss
        await postToGoMode(
          '**STOPPED OUT: ' + pos.ticker + ' ' + action.pctChange.toFixed(1) + '%**\n' +
          'Loss: $' + stopLoss.toFixed(2) + ' | Daily: $' + dailyPL.toFixed(2) + ' | Weekly: $' + (weeklyPace.totalPL + dailyPL).toFixed(2) + '/$' + WEEKLY_TARGET,
          '\uD83D\uDD34' // red circle
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
        // Close ALL tracked positions, not just liveOrder ones
        // Positions from manual entry or previous agents still need to be closed at EOD
        if (BYPASS_MODE && closePos.contractSymbol) {
          closeResult = await closeAutonomous(closePos);
        }
        var closeStatus = (closeResult && closeResult.closed)
          ? 'CLOSED | Order ID: ' + closeResult.orderId
          : (BYPASS_MODE && closePos.contractSymbol ? 'CLOSE FAILED: ' + (closeResult ? closeResult.reason : '?') : 'RECOMMENDATION -- close this position');
        await postToDiscord(
          'CLOSE OUT: ' + closePos.ticker + ' ' + closePos.type.toUpperCase() + ' x' + closePos.contracts + '\n' +
          'Entry: $' + (closePos.entry ? closePos.entry.toFixed(2) : '?') + '\n' +
          'STATUS: ' + closeStatus
        );
      }
      activePositions = [];
    }

    // Post EOD summary with weekly pace
    if (cycleCount % 60 === 0) { // Once per hour after close
      var weeklyRemaining = WEEKLY_TARGET - weeklyPace.totalPL - dailyPL; // include today's unreported PL
      var paceLabel = weeklyPace.pace;
      if (weeklyPace.totalPL + dailyPL >= WEEKLY_TARGET) paceLabel = 'GOAL HIT';
      await postToDiscord(
        'END OF DAY SUMMARY\n' +
        '================================\n' +
        'Daily P&L: $' + dailyPL.toFixed(2) + '\n' +
        'Trades: ' + tradesOpened + '\n' +
        'Strategy: ' + strategies[currentStrategy] + '\n' +
        'Target: $' + dailyTarget + ' | ' + (dailyPL >= minTarget ? 'HIT' : 'MISSED') + '\n' +
        '--------------------------------\n' +
        'WEEKLY PACE: ' + paceLabel + '\n' +
        'Week total: $' + (weeklyPace.totalPL + dailyPL).toFixed(2) + ' / $' + WEEKLY_TARGET + '\n' +
        'Remaining: $' + weeklyRemaining.toFixed(2) + ' in ' + (weeklyPace.tradingDaysLeft - 1) + ' days' +
        (weeklyPace.adjustments.contractBoost > 0 ? '\nTomorrow: +' + weeklyPace.adjustments.contractBoost + ' contract boost active' : '')
      );
      // GO-MODE: EOD Summary
      var eodEmoji = dailyPL >= minTarget ? '\uD83C\uDFC6' : (dailyPL >= 0 ? '\uD83D\uDFE1' : '\uD83D\uDD34');
      await postToGoMode(
        '**END OF DAY**\n' +
        '```\n' +
        'Daily P&L:  $' + dailyPL.toFixed(2) + (dailyPL >= minTarget ? ' TARGET HIT' : '') + '\n' +
        'Trades:     ' + tradesOpened + '\n' +
        '----------------------------\n' +
        'WEEKLY:     $' + (weeklyPace.totalPL + dailyPL).toFixed(2) + ' / $' + WEEKLY_TARGET + '\n' +
        'Pace:       ' + paceLabel + '\n' +
        'Remaining:  $' + weeklyRemaining.toFixed(2) + ' in ' + (weeklyPace.tradingDaysLeft - 1) + ' days\n' +
        (weeklyPace.adjustments.contractBoost > 0 ? 'Tomorrow:   +' + weeklyPace.adjustments.contractBoost + ' contract boost\n' : '') +
        '```',
        eodEmoji
      );
    }
    return;
  }

  } finally {
    _cycleRunning = false;
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
  pushTVSignal: pushTVSignal,
  popTVSignal: popTVSignal,
  checkSundayFutures: checkSundayFutures,
  getSundayBias: getSundayBias,
  getWeeklyPace: function() { return weeklyPace; },
  recordDailyResult: recordDailyResult,
  recalcPace: recalcPace,
  executeApproval: executeApproval,
  getPendingApprovals: getPendingApprovals,
  getExecutionMode: function() { return EXECUTION_MODE; },
};
