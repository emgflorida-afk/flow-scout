// autoFireGate.js -- Stratum v7.5
// -----------------------------------------------------------------
// Auto-fire decision gate. Called by brainEngine.addQueuedTrade
// for every fresh scout signal. Returns:
//   { fire: true }                       -> brain arms the queue immediately
//   { fire: false, reason: '...' }       -> stages as PENDING, pings phone
//
// Default state: DISABLED. Flip via POST /api/autofire/toggle or env
// AUTO_FIRE_ENABLED=true. Even when enabled, the 9 gates below still
// block every item that doesn't meet A+ standards.
//
// DESIGN: additive only. This module NEVER modifies existing queue
// items or mutates brainEngine state beyond its own in-memory flag.
// Worst case if this file crashes, the system falls back to pure
// manual-arm exactly like today.
// -----------------------------------------------------------------

var fs = require('fs');

var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var STATE_FILE = STATE_DIR + '/autofire_state.json';
var FIRE_LOG   = STATE_DIR + '/autofire_fires.json';

// -----------------------------------------------------------------
// PERSISTENT STATE
// -----------------------------------------------------------------
var state = {
  enabled: (process.env.AUTO_FIRE_ENABLED === 'true'),
  maxRiskPerTrade: parseFloat(process.env.AUTO_FIRE_MAX_RISK || '200'),
  allowedGrades: ['A+'], // A+ only for week 1, open to 'A' after calibration
  lastFtfc: null,
  lastCheck: null,
  // TS-LOCK (Apr 29 2026): when TS rejects with "Day trading margin rules" we
  // freeze new fires until next 9:30 ET so we stop burning push attempts.
  tsLockedUntil: 0,        // unix ms; 0 = no lock
  tsLockReason: null,      // last rejection message that triggered the lock
  tsLockTriggeredAt: 0,    // when the lock was set
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof s.enabled === 'boolean') state.enabled = s.enabled;
      if (Array.isArray(s.allowedGrades)) state.allowedGrades = s.allowedGrades;
      if (isFinite(s.maxRiskPerTrade)) state.maxRiskPerTrade = s.maxRiskPerTrade;
      if (isFinite(s.tsLockedUntil))    state.tsLockedUntil = s.tsLockedUntil;
      if (typeof s.tsLockReason === 'string') state.tsLockReason = s.tsLockReason;
      if (isFinite(s.tsLockTriggeredAt)) state.tsLockTriggeredAt = s.tsLockTriggeredAt;
    }
  } catch(e) { console.error('[AUTOFIRE] state load:', e.message); }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({
    enabled: state.enabled,
    allowedGrades: state.allowedGrades,
    maxRiskPerTrade: state.maxRiskPerTrade,
    tsLockedUntil: state.tsLockedUntil,
    tsLockReason: state.tsLockReason,
    tsLockTriggeredAt: state.tsLockTriggeredAt,
  })); } catch(e) { console.error('[AUTOFIRE] state save:', e.message); }
}
loadState();

// -----------------------------------------------------------------
// TS-LOCK helpers (Apr 29 2026)
// Pattern matched against TS rejection messages. Conservative — only
// match phrases that clearly indicate day-trade-margin rejection,
// NOT generic "insufficient buying power" or "contract not found" etc.
// -----------------------------------------------------------------
var TS_LOCK_PATTERN = /day[- ]?trading margin|pattern day trader|day[- ]?trade buying power|day[- ]?trading buying power/i;

function nextMarketOpenET() {
  // Compute next 9:30 ET timestamp. If now is before 9:30 ET today and it's
  // a weekday → today 9:30 ET. Otherwise next business day 9:30 ET.
  var now = new Date();
  var etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  var etNow = new Date(etStr);

  var target = new Date(etNow);
  target.setHours(9, 30, 0, 0);

  // If now (in ET) is at/after 9:30 today, advance to next day
  if (etNow >= target) {
    target.setDate(target.getDate() + 1);
  }
  // Skip weekends — Saturday(6) → Monday, Sunday(0) → Monday
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

  // Convert ET wall-clock target back to UTC timestamp
  // toLocaleString gave us a Date that's been "offset-shifted" — compute the actual UTC ms
  var etOffsetMs = etNow.getTime() - now.getTime();   // delta between local and ET wall-clock
  var utcTargetMs = target.getTime() - etOffsetMs;
  return utcTargetMs;
}

function isTSLocked() {
  return state.tsLockedUntil > Date.now();
}

function getFires() {
  try {
    if (fs.existsSync(FIRE_LOG)) return JSON.parse(fs.readFileSync(FIRE_LOG,'utf8')) || [];
  } catch(e) {}
  return [];
}
function logFire(entry) {
  var all = getFires();
  all.push(entry);
  // Keep last 200
  if (all.length > 200) all = all.slice(-200);
  try { fs.writeFileSync(FIRE_LOG, JSON.stringify(all)); } catch(e) {}
}

// -----------------------------------------------------------------
// TIME HELPERS
// -----------------------------------------------------------------
function etTime() {
  var d = new Date();
  var etStr = d.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  });
  var parts = etStr.split(':');
  return { h: parseInt(parts[0],10), m: parseInt(parts[1],10), mins: parseInt(parts[0],10)*60 + parseInt(parts[1],10) };
}
function isDeadZone() {
  var t = etTime();
  return t.mins >= 11*60+30 && t.mins < 14*60;
}
function isRTH() {
  var t = etTime();
  return t.mins >= 9*60+30 && t.mins < 16*60;
}

// -----------------------------------------------------------------
// THE 9 GATES -- all must pass for auto-fire
// -----------------------------------------------------------------
function evaluateGates(item, ctx) {
  var reasons = [];

  // Gate 0: master switch
  if (!state.enabled) return { fire: false, reason: 'AUTO_FIRE_DISABLED', blocking: 'master' };

  // Gate 0.5 (Apr 29 2026): TS-LOCKED -- TS rejected with day-trade-margin earlier.
  // Block all new fires until next 9:30 ET to stop burning rejected pushes.
  if (isTSLocked()) {
    var unlockAt = new Date(state.tsLockedUntil).toLocaleString('en-US', { timeZone: 'America/New_York' });
    return { fire: false, reason: 'TS_LOCKED until ' + unlockAt + ' ET (last rej: ' + (state.tsLockReason || 'day-trade margin') + ')', blocking: 'ts_lock' };
  }

  // Gate 1: grade whitelist
  var grade = item.grade || 'B';
  if (state.allowedGrades.indexOf(grade) === -1) {
    return { fire: false, reason: 'GRADE_NOT_ALLOWED (' + grade + ' not in ' + state.allowedGrades.join(',') + ')', blocking: 'grade' };
  }

  // Gate 2: must be RTH and not dead zone (for DAY trades; SWING exempt)
  var isDay = (item.tradeType || 'DAY') === 'DAY';
  if (isDay) {
    if (!isRTH()) return { fire: false, reason: 'OUTSIDE_RTH', blocking: 'time' };
    if (isDeadZone() && (item.contractType === 'Call' || item.contractType === 'Put')) {
      // DEAD ZONE rule applies to 0-1DTE only
      var dte = ctx && ctx.dte || null;
      if (dte !== null && dte <= 1) {
        return { fire: false, reason: 'DEAD_ZONE_0DTE', blocking: 'time' };
      }
    }
  }

  // Gate 3: max risk per trade (contracts * stop-distance * 100)
  var price = (ctx && ctx.fillPrice) || item.maxEntryPrice || 0;
  var stopPctAbs = Math.abs(item.stopPct || -0.30);
  if (stopPctAbs > 1) stopPctAbs = stopPctAbs / 100;
  var dollarRisk = price * stopPctAbs * (item.contracts || 1) * 100;
  if (dollarRisk > state.maxRiskPerTrade) {
    return { fire: false, reason: 'RISK_OVER_CAP ($' + dollarRisk.toFixed(0) + ' > $' + state.maxRiskPerTrade + ')', blocking: 'risk' };
  }

  // Gate 4: liquidity (needs ctx.bid / ctx.ask)
  if (ctx && isFinite(ctx.bid) && isFinite(ctx.ask) && ctx.bid > 0) {
    var mid = (ctx.bid + ctx.ask) / 2;
    var spreadPct = (ctx.ask - ctx.bid) / mid;
    if (spreadPct > 0.10) {
      return { fire: false, reason: 'ILLIQUID (spread ' + (spreadPct*100).toFixed(1) + '%)', blocking: 'liquidity' };
    }
  }

  // Gate 5: contract price vs maxEntry cap
  if (ctx && isFinite(ctx.ask) && item.maxEntryPrice && ctx.ask > item.maxEntryPrice * 1.05) {
    return { fire: false, reason: 'PRICE_OVER_CAP (ask ' + ctx.ask + ' > max ' + item.maxEntryPrice + ')', blocking: 'price' };
  }

  // Gate 6: max concurrent positions (3 DAY)
  if (ctx && ctx.openDayCount >= 3 && isDay) {
    return { fire: false, reason: 'MAX_CONCURRENT_DAY (3)', blocking: 'concurrency' };
  }

  // Gate 7: ticker cooldown (1 fire per ticker per 2hr)
  var fires = getFires();
  var cutoff = Date.now() - 2 * 60 * 60 * 1000;
  var recent = fires.filter(function(f){ return f.ticker === item.ticker && f.ts > cutoff; });
  if (recent.length > 0) {
    return { fire: false, reason: 'TICKER_COOLDOWN_2H', blocking: 'cooldown' };
  }

  // Gate 8: daily realized P&L floor (-$500 hard stop)
  if (ctx && isFinite(ctx.dayRealizedPnL) && ctx.dayRealizedPnL <= -500) {
    return { fire: false, reason: 'DAILY_LOSS_STOP (-$500)', blocking: 'loss' };
  }

  // Gate 9: weekly tracker state
  if (ctx && ctx.weeklyState === 'STOP') {
    return { fire: false, reason: 'WEEKLY_STOP', blocking: 'weekly' };
  }

  // ALL GATES PASSED
  return { fire: true, reason: 'ALL_GATES_PASSED', dollarRisk: dollarRisk };
}

function recordFire(item, decision) {
  logFire({
    ts: Date.now(),
    ticker: item.ticker,
    direction: item.direction,
    grade: item.grade,
    contractSymbol: item.contractSymbol,
    source: item.source,
    fired: !!decision.fire,
    reason: decision.reason,
    dollarRisk: decision.dollarRisk || null,
  });
}

// -----------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------
module.exports = {
  evaluate: function(item, ctx) {
    try {
      var d = evaluateGates(item, ctx || {});
      recordFire(item, d);
      state.lastCheck = { ts: Date.now(), ticker: item.ticker, decision: d };
      return d;
    } catch(e) {
      console.error('[AUTOFIRE] evaluate error:', e.message);
      return { fire: false, reason: 'EVAL_ERROR: ' + e.message };
    }
  },
  getState: function() {
    return {
      enabled: state.enabled,
      allowedGrades: state.allowedGrades.slice(),
      maxRiskPerTrade: state.maxRiskPerTrade,
      lastFtfc: state.lastFtfc,
      lastCheck: state.lastCheck,
      recentFires: getFires().slice(-10),
    };
  },
  setEnabled: function(on) {
    state.enabled = !!on;
    saveState();
    return state.enabled;
  },
  setAllowedGrades: function(grades) {
    if (Array.isArray(grades)) state.allowedGrades = grades.slice();
    saveState();
    return state.allowedGrades;
  },
  setMaxRisk: function(n) {
    if (isFinite(n) && n > 0) state.maxRiskPerTrade = n;
    saveState();
    return state.maxRiskPerTrade;
  },
  setLastFtfc: function(ftfcString) {
    state.lastFtfc = ftfcString;
  },

  // -----------------------------------------------------------------
  // TS-LOCK API (Apr 29 2026)
  // -----------------------------------------------------------------
  // Call from orderExecutor when a TS rejection message matches the
  // day-trade-margin pattern. Lock holds until next 9:30 ET.
  triggerTSLock: function(rejectionMessage) {
    if (!rejectionMessage) return false;
    if (!TS_LOCK_PATTERN.test(rejectionMessage)) return false;
    state.tsLockedUntil    = nextMarketOpenET();
    state.tsLockReason     = String(rejectionMessage).slice(0, 200);
    state.tsLockTriggeredAt = Date.now();
    saveState();
    var unlockAt = new Date(state.tsLockedUntil).toLocaleString('en-US', { timeZone: 'America/New_York' });
    console.error('[AUTOFIRE] 🔒 TS-LOCK ENGAGED until ' + unlockAt + ' ET — reason:', rejectionMessage);
    return true;
  },

  // Manual override (use endpoint /api/auto-fire/ts-lock-clear)
  clearTSLock: function() {
    state.tsLockedUntil = 0;
    state.tsLockReason  = null;
    state.tsLockTriggeredAt = 0;
    saveState();
    console.log('[AUTOFIRE] TS-LOCK manually cleared');
    return true;
  },

  // Status (for /api/auto-fire/ts-lock-status)
  getTSLockStatus: function() {
    var locked = isTSLocked();
    return {
      locked: locked,
      lockedUntil: state.tsLockedUntil || null,
      lockedUntilET: locked ? new Date(state.tsLockedUntil).toLocaleString('en-US', { timeZone: 'America/New_York' }) : null,
      reason: state.tsLockReason,
      triggeredAt: state.tsLockTriggeredAt || null,
      triggeredAtET: state.tsLockTriggeredAt ? new Date(state.tsLockTriggeredAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : null,
    };
  },

  // Probe — useful for tests / manual triggers
  isTSLocked: isTSLocked,
};
