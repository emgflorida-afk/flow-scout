// =============================================================================
// ALERT TIERS — Tier 1/2/3 classification + stack tracking.
//
// AB's pain point (May 4): I flip-flopped on 5m noise. The fix is
// hierarchical alerting: Tier 3 noise only triggers ACTION if Tier 1 + Tier 2
// have already fired today on the same ticker + direction.
//
// TIER 1 — PRIMARY SIGNAL (rare, A+ priority)
//   Daily/60m + multiple confirmations stacked. Fires 1-3× per ticker per week.
//   Reaction: HIGH priority Discord push, AB acts immediately.
//
// TIER 2 — CONFIRMATION (validates Tier 1)
//   60m/15m + single technical level. Fires 2-5× per day per ticker.
//   Reaction: Discord push ONLY if Tier 1 fired same day on same ticker/dir.
//
// TIER 3 — ENTRY TIMING (noise filter)
//   5m/15m + single bar. Fires 5-20× per day per ticker.
//   Reaction: SILENT unless Tier 1 + Tier 2 already fired today.
//
// STATE: /data/alert_tier_state.json
//   { 'ADBE:long': { tier1: '2026-05-04T20:00Z', tier2: null, tier3: [] }, ... }
//   (per ticker:direction, when each tier last fired today + cumulative tier3)
//
// PUBLIC API:
//   classifyAlert(payload) -> 1 | 2 | 3 | 0 (unknown)
//   recordAlert(ticker, direction, tier, meta)
//   shouldAct(ticker, direction, tier) -> { act: bool, reason: string }
//   getStackStatus(ticker, direction) -> { t1Fired, t2Fired, t3Count, ageMin }
//   resetDay() — called by 4:05 PM EOD cron
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'alert_tier_state.json');

// Tier classification rules — matches against TV alert message JSON
// Each TV alert paste includes a `tier` field directly, OR we infer from `tf`.
function classifyAlert(payload) {
  if (!payload) return 0;
  // Explicit tier field wins
  if ([1, 2, 3].indexOf(payload.tier) >= 0) return payload.tier;
  // Infer from timeframe
  var tf = String(payload.tf || payload.timeframe || '').toUpperCase();
  if (tf === 'D' || tf === '1D' || tf === 'DAILY' || tf === '1H' || tf === '60' || tf === '60M') {
    // Daily / 60m → check if multi-condition (stacked) for Tier 1
    if (payload.stacked === true || payload.confirmations >= 2) return 1;
    return 2;  // single-condition 60m = Tier 2
  }
  if (tf === '15' || tf === '15M' || tf === '5' || tf === '5M') return 3;
  return 0;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { dailyDate: todayET(), tickers: {} }; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[ALERT-TIERS] save fail:', e.message); }
}

function todayET() {
  var d = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, day, y] = d.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + day.padStart(2, '0');
}

function rolloverIfNewDay(state) {
  var today = todayET();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.tickers = {};
  }
  return state;
}

function key(ticker, direction) {
  return String(ticker || '').toUpperCase() + ':' + String(direction || 'long').toLowerCase();
}

function recordAlert(ticker, direction, tier, meta) {
  var state = loadState();
  state = rolloverIfNewDay(state);
  var k = key(ticker, direction);
  if (!state.tickers[k]) {
    state.tickers[k] = { tier1: null, tier2: null, tier3: [] };
  }
  var entry = state.tickers[k];
  var nowIso = new Date().toISOString();
  if (tier === 1) entry.tier1 = { firedAt: nowIso, meta: meta || {} };
  else if (tier === 2) entry.tier2 = { firedAt: nowIso, meta: meta || {} };
  else if (tier === 3) {
    entry.tier3.push({ firedAt: nowIso, meta: meta || {} });
    if (entry.tier3.length > 50) entry.tier3 = entry.tier3.slice(-50);  // cap memory
  }
  saveState(state);
  return { ok: true };
}

function shouldAct(ticker, direction, tier) {
  var state = loadState();
  state = rolloverIfNewDay(state);
  var entry = state.tickers[key(ticker, direction)] || { tier1: null, tier2: null, tier3: [] };

  if (tier === 1) {
    return { act: true, priority: 'HIGH', reason: 'Tier 1 = always act' };
  }
  if (tier === 2) {
    if (entry.tier1) {
      return { act: true, priority: 'MED', reason: 'Tier 2 confirms — Tier 1 fired ' + entry.tier1.firedAt };
    }
    return { act: false, priority: 'LOW', reason: 'Tier 2 alone — Tier 1 has not fired today on ' + ticker + ' ' + direction };
  }
  if (tier === 3) {
    if (entry.tier1 && entry.tier2) {
      return { act: true, priority: 'MED', reason: 'Tier 3 stack confirmed — Tier 1+2 already fired today' };
    }
    var missing = [];
    if (!entry.tier1) missing.push('Tier 1');
    if (!entry.tier2) missing.push('Tier 2');
    return { act: false, priority: 'NONE', reason: 'Tier 3 noise — missing ' + missing.join(' + ') + ' for stack' };
  }
  return { act: false, priority: 'NONE', reason: 'unknown tier ' + tier };
}

function getStackStatus(ticker, direction) {
  var state = loadState();
  state = rolloverIfNewDay(state);
  var entry = state.tickers[key(ticker, direction)] || { tier1: null, tier2: null, tier3: [] };
  return {
    ticker: ticker,
    direction: direction,
    t1Fired: !!entry.tier1,
    t1FiredAt: entry.tier1 ? entry.tier1.firedAt : null,
    t2Fired: !!entry.tier2,
    t2FiredAt: entry.tier2 ? entry.tier2.firedAt : null,
    t3Count: (entry.tier3 || []).length,
    fullStack: !!entry.tier1 && !!entry.tier2,
  };
}

function resetDay() {
  var state = { dailyDate: todayET(), tickers: {} };
  saveState(state);
  console.log('[ALERT-TIERS] day reset for ' + state.dailyDate);
  return state;
}

// Status snapshot for /api/alert-tiers/status
function getAllStacks() {
  var state = loadState();
  state = rolloverIfNewDay(state);
  var stacks = Object.keys(state.tickers || {}).map(function(k) {
    var [tk, dir] = k.split(':');
    return getStackStatus(tk, dir);
  });
  return {
    timestamp: new Date().toISOString(),
    dailyDate: state.dailyDate,
    stackCount: stacks.length,
    fullStackCount: stacks.filter(function(s) { return s.fullStack; }).length,
    stacks: stacks,
  };
}

module.exports = {
  classifyAlert: classifyAlert,
  recordAlert: recordAlert,
  shouldAct: shouldAct,
  getStackStatus: getStackStatus,
  getAllStacks: getAllStacks,
  resetDay: resetDay,
};
