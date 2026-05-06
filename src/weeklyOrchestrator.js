// =============================================================================
// WEEKLY STRATEGY ORCHESTRATOR — Phase 4.40 (May 5 2026 PM build)
// -----------------------------------------------------------------------------
// AB's directive: turn his $1,500/week target into an executable Mon-Fri rhythm.
// Removes "what should I do today?" decision fatigue. Combines all the existing
// phases (spread builder 4.31, smart conditional 4.34, SIM journal 4.24,
// daily flow backtest 4.25, John replicator 4.30, fire grade 4.29) into one
// engine that knows: "It's Monday at 9:45 AM ET → fire put credit spreads on
// SPY/QQQ/IWM" automatically, then "It's Friday → close everything."
//
// THE WEEKLY PLAYBOOK (literal directive from AB):
//   MONDAY    — Income Setup    : SPY/QQQ/IWM 1.5%-OTM put credit spreads (5 DTE)
//   TUESDAY   — Debit Spread    : manage Mon spreads, fire 1-2 fresh debit spreads on Grade A
//   WEDNESDAY — Naked Direction : manage book, 1 high-conv naked if Grade A appears
//   THURSDAY  — Roll & Lotto    : roll profitable spreads + 1-2 weekend lottos
//   FRIDAY    — Close Everything: market close all open by 3:30 PM, push recap
//
// Target weekly mix: ~$1,130 realistic, $1,500 stretch
//   Income ($200) + Debit ($400) + Naked ($300) + CC ($30) + Lotto ($200)
//
// SAFETY:
//   - WEEKLY_ORCH_ENABLED=true (default) — set false to disable all auto-runs
//   - All actions go through existing /api/spread-builder + /api/smart-conditional
//     endpoints — never touches broker direct
//   - Friday hard rule: no new entries (newEntries: false)
//   - SIM-by-default; live action requires explicit override per call
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var dp = null;
try { dp = require('./discordPush'); } catch (e) {}

var simTradeJournal = null;
try { simTradeJournal = require('./simTradeJournal'); } catch (e) {}

var weeklyTracker = null;
try { weeklyTracker = require('./weeklyTracker'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'weekly_orchestrator_state.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// =============================================================================
// THE PLAYBOOK — Mon-Fri rhythm
// =============================================================================
var PLAYBOOK = {
  monday: {
    label: 'Income Setup Day',
    summary: 'Set up income spreads (SPY/QQQ/IWM put credits) — ~$150 credit',
    icon: '📊',
    targetCredit: 150,
    actions: [
      { type: 'BUILD_SPREAD', name: 'SPY put credit', strategy: 'BULL_PUT_CREDIT',
        ticker: 'SPY', otmPct: 1.5, width: 5, expiryDte: 5, qty: 1 },
      { type: 'BUILD_SPREAD', name: 'QQQ put credit', strategy: 'BULL_PUT_CREDIT',
        ticker: 'QQQ', otmPct: 1.5, width: 5, expiryDte: 5, qty: 1 },
      { type: 'BUILD_SPREAD', name: 'IWM put credit', strategy: 'BULL_PUT_CREDIT',
        ticker: 'IWM', otmPct: 1.5, width: 5, expiryDte: 5, qty: 1 },
    ],
  },
  tuesday: {
    label: 'Debit Spread Day',
    summary: 'Manage Mon spreads (close at 50% credit captured), fire 1-2 fresh debit spreads on Grade A',
    icon: '🎯',
    actions: [
      { type: 'MANAGE_OPEN_SPREADS', captureAt: 0.50 },
      { type: 'FIND_GRADE_A_DEBIT_SPREAD', maxFires: 2 },
    ],
  },
  wednesday: {
    label: 'Naked Directional Day',
    summary: 'Manage book + 1 high-conviction naked option if Grade A appears',
    icon: '🚀',
    actions: [
      { type: 'MANAGE_OPEN_SPREADS', captureAt: 0.50 },
      { type: 'FIND_GRADE_A_NAKED', maxFires: 1 },
    ],
  },
  thursday: {
    label: 'Roll & Lotto Day',
    summary: 'Roll profitable spreads to next week, fire 1-2 weekend lottos via John picks',
    icon: '🔁',
    actions: [
      { type: 'ROLL_PROFITABLE_SPREADS', minProfit: 0.50 },
      { type: 'FIND_WEEKEND_LOTTO', maxFires: 2 },
    ],
  },
  friday: {
    label: 'Close-All Day',
    summary: 'Close everything by 3:30 PM, no new positions, count P&L, push recap',
    icon: '🏁',
    newEntries: false,    // hard rule
    actions: [
      { type: 'CLOSE_ALL_BY_330' },
      { type: 'PUSH_WEEKLY_RECAP' },
    ],
  },
};

// Target P&L mix (weekly)
var WEEKLY_TARGETS = {
  income:    200,
  debit:     400,
  naked:     300,
  coveredCall: 30,
  lotto:     200,
  total:    1130,    // realistic
  stretch:  1500,    // AB stretch goal
};

// =============================================================================
// STATE / PERSISTENCE
// =============================================================================
function ensureDir() {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
}

function emptyState() {
  return {
    lastRunAt: null,
    runs: {},      // { 'YYYY-MM-DD': { day, actions, results, ts } }
    fires: [],     // [{ id, day, action, ticker, ticketId, result, ts }]
  };
}

function loadState() {
  try {
    var raw = fs.readFileSync(STATE_FILE, 'utf8');
    var s = JSON.parse(raw);
    if (!s.runs) s.runs = {};
    if (!s.fires) s.fires = [];
    return s;
  } catch (e) {
    return emptyState();
  }
}

function saveState(s) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('[WEEKLY-ORCH] save failed:', e.message); }
}

function isEnabled() {
  // Hard mute switch — set WEEKLY_ORCHESTRATOR=off to silence all auto-runs.
  // Default ON. Backwards-compat with WEEKLY_ORCH_ENABLED=false.
  if (process.env.WEEKLY_ORCHESTRATOR === 'off') return false;
  var v = process.env.WEEKLY_ORCH_ENABLED;
  if (v == null || v === '') return true;  // default ON
  return String(v).toLowerCase() !== 'false';
}

// =============================================================================
// TIME HELPERS
// =============================================================================
function todayET() {
  var now = new Date();
  var et = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var parts = et.split('/');
  var m = parts[0], d = parts[1], y = parts[2];
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function dayOfWeekET() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][et.getDay()];
}

// Returns the YYYY-MM-DD of Monday for the current week (or any date)
function weekStartMondayET(date) {
  date = date || todayET();
  var d = new Date(date + 'T12:00:00Z');
  var dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  var offset = dow === 0 ? -6 : (1 - dow);  // back to Mon
  d.setUTCDate(d.getUTCDate() + offset);
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

// Add N business days to a YYYY-MM-DD (skipping Sat/Sun)
function addBusinessDays(date, n) {
  var d = new Date(date + 'T12:00:00Z');
  var added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  var y = d.getUTCFullYear();
  var m = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

// =============================================================================
// SERVER BASE FOR SELF-CALLS
// =============================================================================
function serverBase() {
  return process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
}

function _fetchLib() {
  return (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
}

// Get current spot for a ticker via existing endpoint
async function getSpot(ticker) {
  try {
    var fl = _fetchLib();
    var r = await fl(serverBase() + '/api/ticker-quote?symbols=' + encodeURIComponent(ticker), { timeout: 5000 });
    if (!r.ok) return null;
    var data = await r.json();
    if (!data || !data.ok || !data.quotes || !data.quotes.length) return null;
    var q = data.quotes[0];
    return q.last != null ? parseFloat(q.last) : null;
  } catch (e) { return null; }
}

// =============================================================================
// ACTION EXECUTORS
// =============================================================================

// BUILD_SPREAD — calls /api/spread-builder/build with the spec, returns ticketId
async function executeBuildSpread(action) {
  var ticker = String(action.ticker || '').toUpperCase();
  if (!ticker) return { ok: false, action: 'BUILD_SPREAD', error: 'no ticker' };

  // Get current spot to compute strikes
  var spot = await getSpot(ticker);
  if (!spot) return { ok: false, action: 'BUILD_SPREAD', ticker: ticker, error: 'no spot' };

  // For BULL_PUT_CREDIT (the Monday default), short strike is otmPct% below spot
  var pct = parseFloat(action.otmPct || 1.5);
  var width = parseFloat(action.width || 5);
  var qty = parseInt(action.qty || 1, 10);
  var expiryDte = parseInt(action.expiryDte || 5, 10);

  var shortKRaw = spot * (1 - pct / 100);
  // Round to typical strike grid: SPY/QQQ use $1, IWM uses $0.50 sub-50 / $1 above
  var grid = (spot < 50) ? 0.5 : 1;
  var shortK = Math.round(shortKRaw / grid) * grid;
  var longK = shortK - width;

  // Compute expiry DTE business days out from today
  var expiry = addBusinessDays(todayET(), expiryDte);

  // POST to spread-builder
  var fl = _fetchLib();
  var spec = {
    ticker: ticker,
    type:   action.strategy || 'BULL_PUT_CREDIT',
    expiry: expiry,
    strikes: { short: shortK, long: longK },
    qty:    qty,
    // netLimit auto-estimated by server from chain mids
    account: 'ts-sim',
    brackets: { stopPct: 100, tp1Pct: 50 },  // close at 50% credit captured
  };

  try {
    var r = await fl(serverBase() + '/api/spread-builder/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
      timeout: 10000,
    });
    var data = await r.json();
    if (!r.ok || !data.ok) {
      return { ok: false, action: 'BUILD_SPREAD', ticker: ticker, error: (data && data.errors) || 'build failed' };
    }
    return {
      ok: true,
      action: 'BUILD_SPREAD',
      ticker: ticker,
      ticketId: data.ticketId,
      summary: data.summary,
      netLimit: data.netLimit,
      strikes: data.strikes,
      expiry: data.expiry,
      titanCard: data.summary && data.summary.titanCard,
    };
  } catch (e) {
    return { ok: false, action: 'BUILD_SPREAD', ticker: ticker, error: e.message };
  }
}

// MANAGE_OPEN_SPREADS — check journal for open spreads, mark close-eligible at 50%+ capture
async function executeManageOpenSpreads(action) {
  if (!simTradeJournal) {
    return { ok: false, action: 'MANAGE_OPEN_SPREADS', error: 'simTradeJournal not loaded' };
  }
  var captureAt = parseFloat(action.captureAt || 0.50);
  var actives = simTradeJournal.getActivePositions ? simTradeJournal.getActivePositions() : [];

  // Filter to spread positions (recognized via source or contractSymbol containing /)
  var spreads = actives.filter(function(p) {
    var src = String(p.source || '').toLowerCase();
    return src.includes('spread') || src.includes('credit') || src.includes('debit') ||
           (p.contractSymbol && p.contractSymbol.indexOf('/') >= 0);
  });

  var toClose = [];
  spreads.forEach(function(p) {
    var pnl = p.pnlPct;
    if (pnl == null) return;
    // Convert capture threshold to pnl% on debit (debit gain) vs credit (premium decay)
    // For credit spreads: positive captureAt% means premium decayed (we're up that %)
    // Keep simple: pnlPct >= captureAt*100 → close
    if (pnl >= captureAt * 100) {
      toClose.push({ contractSymbol: p.contractSymbol, ticker: p.ticker, pnlPct: pnl });
    }
  });

  return {
    ok: true,
    action: 'MANAGE_OPEN_SPREADS',
    spreadsOpen: spreads.length,
    eligibleClose: toClose,
    captureAt: captureAt,
  };
}

// FIND_GRADE_A_DEBIT_SPREAD — scan today's Grade A cards, pick top maxFires for debit spread builds
async function executeFindGradeADebitSpread(action) {
  var maxFires = parseInt(action.maxFires || 2, 10);
  var fl = _fetchLib();
  var picks = [];

  // Pull from /api/action-radar — unified ranked list
  try {
    var r = await fl(serverBase() + '/api/action-radar?minScore=10', { timeout: 12000 });
    if (r.ok) {
      var data = await r.json();
      var rows = (data && data.rows) || [];
      // Pick ACTIONABLE first, top maxFires
      var actionable = rows.filter(function(x) { return x.status === 'ACTIONABLE'; });
      picks = actionable.slice(0, maxFires);
    }
  } catch (e) {
    return { ok: false, action: 'FIND_GRADE_A_DEBIT_SPREAD', error: e.message };
  }

  if (!picks.length) {
    return { ok: true, action: 'FIND_GRADE_A_DEBIT_SPREAD', message: 'No Grade A actionable cards today', spreadsBuilt: 0 };
  }

  // For each pick, build a debit spread suggestion (don't auto-fire — present to AB)
  var built = [];
  for (var i = 0; i < picks.length; i++) {
    var p = picks[i];
    var dir = String(p.direction || p.bias || 'long').toLowerCase();
    var type = (dir.indexOf('short') >= 0 || dir.indexOf('bear') >= 0 || dir.indexOf('put') >= 0)
      ? 'BEAR_PUT_DEBIT' : 'BULL_CALL_DEBIT';
    var ticker = String(p.ticker || '').toUpperCase();
    if (!ticker) continue;
    var spot = await getSpot(ticker);
    if (!spot) continue;
    var grid = spot < 25 ? 0.5 : (spot < 100 ? 1 : (spot < 250 ? 2.5 : 5));
    var widePct = 0.02;  // 2% wide
    var longK, shortK;
    if (type === 'BULL_CALL_DEBIT') {
      longK = Math.round(spot / grid) * grid;
      shortK = Math.round((spot * (1 + widePct)) / grid) * grid;
    } else {
      longK = Math.round(spot / grid) * grid;
      shortK = Math.round((spot * (1 - widePct)) / grid) * grid;
    }
    var expiry = addBusinessDays(todayET(), 5);  // 5 DTE

    try {
      var spec = {
        ticker: ticker,
        type: type,
        expiry: expiry,
        strikes: { long: longK, short: shortK },
        qty: 1,
        account: 'ts-sim',
        brackets: { stopPct: 50, tp1Pct: 25 },
      };
      var r2 = await fl(serverBase() + '/api/spread-builder/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
        timeout: 10000,
      });
      var data2 = await r2.json();
      if (data2 && data2.ok) {
        built.push({
          ticker: ticker,
          type: type,
          ticketId: data2.ticketId,
          titanCard: data2.summary && data2.summary.titanCard,
        });
      }
    } catch (e) { /* skip on error */ }
  }

  return {
    ok: true,
    action: 'FIND_GRADE_A_DEBIT_SPREAD',
    candidatesFound: picks.length,
    spreadsBuilt: built.length,
    builds: built,
  };
}

// FIND_GRADE_A_NAKED — find top 1 Grade A card, propose smart conditional with naked option
async function executeFindGradeANaked(action) {
  var maxFires = parseInt(action.maxFires || 1, 10);
  var fl = _fetchLib();
  var picks = [];

  try {
    var r = await fl(serverBase() + '/api/action-radar?minScore=12', { timeout: 12000 });
    if (r.ok) {
      var data = await r.json();
      var rows = (data && data.rows) || [];
      var actionable = rows.filter(function(x) { return x.status === 'ACTIONABLE'; });
      picks = actionable.slice(0, maxFires);
    }
  } catch (e) {
    return { ok: false, action: 'FIND_GRADE_A_NAKED', error: e.message };
  }

  if (!picks.length) {
    return { ok: true, action: 'FIND_GRADE_A_NAKED', message: 'No high-conviction Grade A candidates', proposed: 0 };
  }

  // We do NOT auto-fire a naked here — we propose via Discord card / mark in state.
  // Smart conditional add would require contract resolution + entry price. Leave to AB
  // to click "🤖 SMART AUTO" on the card. Instead, surface the picks.
  var proposed = picks.map(function(p) {
    return {
      ticker: p.ticker,
      direction: p.direction || p.bias,
      maxScore: p.maxScore,
      reason: 'Wednesday naked candidate — review on ACTION tab and click 🤖 SMART AUTO',
    };
  });

  return {
    ok: true,
    action: 'FIND_GRADE_A_NAKED',
    proposed: proposed.length,
    candidates: proposed,
  };
}

// ROLL_PROFITABLE_SPREADS — close spreads that hit 50%+, build next-week version
async function executeRollProfitableSpreads(action) {
  if (!simTradeJournal) {
    return { ok: false, action: 'ROLL_PROFITABLE_SPREADS', error: 'simTradeJournal not loaded' };
  }
  var minProfit = parseFloat(action.minProfit || 0.50);
  var actives = simTradeJournal.getActivePositions ? simTradeJournal.getActivePositions() : [];
  var spreads = actives.filter(function(p) {
    var src = String(p.source || '').toLowerCase();
    return src.includes('spread') || src.includes('credit') || src.includes('debit');
  });

  var profitable = spreads.filter(function(p) {
    return p.pnlPct != null && p.pnlPct >= minProfit * 100;
  });

  // For each, identify it's a roll candidate but don't auto-fire close+open here.
  // Surface to AB for one-click execute.
  var rollCandidates = profitable.map(function(p) {
    return {
      contractSymbol: p.contractSymbol,
      ticker: p.ticker,
      pnlPct: Math.round(p.pnlPct * 10) / 10,
      action: 'CLOSE current + OPEN next-week version',
    };
  });

  return {
    ok: true,
    action: 'ROLL_PROFITABLE_SPREADS',
    spreadsOpen: spreads.length,
    rollEligible: rollCandidates.length,
    candidates: rollCandidates,
  };
}

// FIND_WEEKEND_LOTTO — pull John replicator picks for Friday-expiry contracts
async function executeFindWeekendLotto(action) {
  var maxFires = parseInt(action.maxFires || 2, 10);
  var fl = _fetchLib();
  var picks = [];

  // Try John replicator endpoint first
  try {
    var r = await fl(serverBase() + '/api/john-replicator/latest', { timeout: 8000 });
    if (r.ok) {
      var data = await r.json();
      if (data && data.candidates) {
        picks = data.candidates.slice(0, maxFires);
      }
    }
  } catch (e) {}

  // Fallback to lotto-feed
  if (!picks.length) {
    try {
      var r2 = await fl(serverBase() + '/api/lotto-feed', { timeout: 8000 });
      if (r2.ok) {
        var data2 = await r2.json();
        if (data2 && (data2.lotto || data2.candidates)) {
          picks = (data2.lotto || data2.candidates || []).slice(0, maxFires);
        }
      }
    } catch (e) {}
  }

  return {
    ok: true,
    action: 'FIND_WEEKEND_LOTTO',
    candidatesFound: picks.length,
    candidates: picks,
  };
}

// CLOSE_ALL_BY_330 — surface close intent for every active position
async function executeCloseAllBy330(action) {
  if (!simTradeJournal) {
    return { ok: false, action: 'CLOSE_ALL_BY_330', error: 'simTradeJournal not loaded' };
  }
  var actives = simTradeJournal.getActivePositions ? simTradeJournal.getActivePositions() : [];
  // Don't auto-close — push Discord embed alerting AB to manually close.
  // The Friday cron at 3:30 PM is the trigger; AB executes.
  var closeIntent = actives.map(function(p) {
    return {
      contractSymbol: p.contractSymbol,
      ticker: p.ticker,
      direction: p.direction,
      pnlPct: p.pnlPct,
      action: 'CLOSE BY 3:30 PM ET — Friday rule (no weekend hold)',
    };
  });

  return {
    ok: true,
    action: 'CLOSE_ALL_BY_330',
    positionsOpen: actives.length,
    closeIntent: closeIntent,
  };
}

// PUSH_WEEKLY_RECAP — fire Discord embed with WTD P&L summary
async function executePushWeeklyRecap(action) {
  var recap = computeWeeklyRecap();
  if (dp) {
    try {
      var embed = buildWeeklyRecapEmbed(recap);
      await dp.send('weeklyOrchRecap', embed, { webhook: DISCORD_WEBHOOK });
    } catch (e) {
      console.error('[WEEKLY-ORCH] recap push failed:', e.message);
    }
  }
  return { ok: true, action: 'PUSH_WEEKLY_RECAP', recap: recap };
}

// =============================================================================
// ACTION DISPATCHER
// =============================================================================
async function executeAction(action) {
  if (!action || !action.type) return { ok: false, error: 'no action type' };
  switch (action.type) {
    case 'BUILD_SPREAD':              return await executeBuildSpread(action);
    case 'MANAGE_OPEN_SPREADS':       return await executeManageOpenSpreads(action);
    case 'FIND_GRADE_A_DEBIT_SPREAD': return await executeFindGradeADebitSpread(action);
    case 'FIND_GRADE_A_NAKED':        return await executeFindGradeANaked(action);
    case 'ROLL_PROFITABLE_SPREADS':   return await executeRollProfitableSpreads(action);
    case 'FIND_WEEKEND_LOTTO':        return await executeFindWeekendLotto(action);
    case 'CLOSE_ALL_BY_330':          return await executeCloseAllBy330(action);
    case 'PUSH_WEEKLY_RECAP':         return await executePushWeeklyRecap(action);
    default:                          return { ok: false, error: 'unknown action: ' + action.type };
  }
}

// =============================================================================
// MAIN ENTRY: runDailyPlaybook
// =============================================================================
async function runDailyPlaybook(dayOfWeek) {
  if (!isEnabled()) {
    return { ok: true, skipped: 'WEEKLY_ORCH_ENABLED=false' };
  }
  var dayKey = String(dayOfWeek || dayOfWeekET()).toLowerCase();
  var day = PLAYBOOK[dayKey];
  if (!day) {
    return { ok: false, error: 'no playbook for ' + dayKey, validDays: Object.keys(PLAYBOOK) };
  }

  var results = [];
  for (var i = 0; i < day.actions.length; i++) {
    var action = day.actions[i];
    try {
      var out = await executeAction(action);
      results.push(out);
    } catch (e) {
      results.push({ ok: false, error: e.message, action: action.type });
    }
  }

  // Persist run state
  var state = loadState();
  var dateKey = todayET();
  state.runs[dateKey] = {
    day: dayKey,
    label: day.label,
    actions: day.actions,
    results: results,
    ts: new Date().toISOString(),
  };
  state.lastRunAt = new Date().toISOString();
  saveState(state);

  // Discord push: per-day playbook execution summary
  if (dp) {
    try {
      var embed = buildDailyPlaybookEmbed(dayKey, day, results);
      await dp.send('weeklyOrchDaily', embed, { webhook: DISCORD_WEBHOOK });
    } catch (e) {
      console.error('[WEEKLY-ORCH] daily push failed:', e.message);
    }
  }

  console.log('[WEEKLY-ORCH] runDailyPlaybook ' + dayKey + ' · ' + results.length + ' actions executed');
  return { ok: true, day: dayKey, label: day.label, results: results };
}

// =============================================================================
// WEEKLY RECAP COMPUTATION
// =============================================================================
function computeWeeklyRecap() {
  var weekStart = weekStartMondayET();
  var weekDates = [];
  for (var i = 0; i < 5; i++) {
    weekDates.push(addBusinessDays(weekStart, i === 0 ? 0 : 1).slice(0, 10));
  }
  // Recompute using simple offset
  weekDates = [
    weekStart,
    addBusinessDays(weekStart, 1),
    addBusinessDays(weekStart, 2),
    addBusinessDays(weekStart, 3),
    addBusinessDays(weekStart, 4),
  ];

  var byBucket = {
    income:      { realized: 0, count: 0, target: WEEKLY_TARGETS.income },
    debit:       { realized: 0, count: 0, target: WEEKLY_TARGETS.debit },
    naked:       { realized: 0, count: 0, target: WEEKLY_TARGETS.naked },
    coveredCall: { realized: 0, count: 0, target: WEEKLY_TARGETS.coveredCall },
    lotto:       { realized: 0, count: 0, target: WEEKLY_TARGETS.lotto },
  };

  var allClosed = [];
  if (simTradeJournal && simTradeJournal.getClosedPositions) {
    weekDates.forEach(function(date) {
      var closed = simTradeJournal.getClosedPositions(date) || [];
      closed.forEach(function(p) { allClosed.push(p); });
    });
  }

  // Bucket each closed position
  var wins = 0, losses = 0;
  var bestTrade = null, worstTrade = null;
  allClosed.forEach(function(p) {
    var bucket = classifyPositionBucket(p);
    var pnl = p.pnlDollar != null ? parseFloat(p.pnlDollar) : 0;
    if (byBucket[bucket]) {
      byBucket[bucket].realized += pnl;
      byBucket[bucket].count += 1;
    }
    if (p.outcome === 'win') wins++;
    else if (p.outcome === 'loss') losses++;
    if (!bestTrade || pnl > (bestTrade.pnl || -Infinity)) bestTrade = { ticker: p.ticker, pnl: pnl, pct: p.pnlPct };
    if (!worstTrade || pnl < (worstTrade.pnl || Infinity)) worstTrade = { ticker: p.ticker, pnl: pnl, pct: p.pnlPct };
  });

  var totalRealized = 0;
  Object.keys(byBucket).forEach(function(k) { totalRealized += byBucket[k].realized; });
  var pctOfTarget = WEEKLY_TARGETS.stretch > 0 ? Math.round(totalRealized / WEEKLY_TARGETS.stretch * 100) : 0;
  var pctOfRealistic = WEEKLY_TARGETS.total > 0 ? Math.round(totalRealized / WEEKLY_TARGETS.total * 100) : 0;
  var winRate = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;

  // Extrapolate to monthly pacing
  var monthlyPace = totalRealized * 4;

  return {
    weekStart: weekStart,
    weekDates: weekDates,
    targets: WEEKLY_TARGETS,
    byBucket: byBucket,
    totalRealized: Math.round(totalRealized),
    pctOfStretch: pctOfTarget,
    pctOfRealistic: pctOfRealistic,
    wins: wins,
    losses: losses,
    winRate: winRate,
    bestTrade: bestTrade,
    worstTrade: worstTrade,
    monthlyPace: Math.round(monthlyPace),
    closedTradesCount: allClosed.length,
  };
}

// Classify a position into one of the 5 buckets (income/debit/naked/coveredCall/lotto)
function classifyPositionBucket(p) {
  var src = String(p.source || '').toLowerCase();
  var sym = String(p.contractSymbol || '');
  var hasCredit = src.indexOf('credit') >= 0 || src.indexOf('income') >= 0;
  var hasDebit = src.indexOf('debit') >= 0 || src.indexOf('spread') >= 0;
  var hasCC = src.indexOf('covered') >= 0 || src.indexOf('cc') >= 0;
  var hasLotto = src.indexOf('lotto') >= 0 || src.indexOf('weekly') >= 0;

  if (hasCredit) return 'income';
  if (hasCC) return 'coveredCall';
  if (hasLotto) return 'lotto';
  if (hasDebit) return 'debit';
  // default = naked directional
  return 'naked';
}

function getTargetProgress() {
  var recap = computeWeeklyRecap();
  return {
    weekStart: recap.weekStart,
    totalRealized: recap.totalRealized,
    target: WEEKLY_TARGETS.stretch,
    realistic: WEEKLY_TARGETS.total,
    pctOfStretch: recap.pctOfStretch,
    pctOfRealistic: recap.pctOfRealistic,
    byBucket: recap.byBucket,
  };
}

// =============================================================================
// DISCORD EMBED BUILDERS
// =============================================================================
function buildDailyPlaybookEmbed(dayKey, day, results) {
  var fields = [];
  results.forEach(function(r) {
    var name = (r && r.action) || 'action';
    var value = '';
    if (!r.ok) {
      value = 'ERR: ' + (r.error || 'unknown');
    } else if (r.action === 'BUILD_SPREAD') {
      value = (r.titanCard || (r.ticker + ' built')) + (r.ticketId ? '\nticketId: `' + r.ticketId + '`' : '');
    } else if (r.action === 'MANAGE_OPEN_SPREADS') {
      value = r.spreadsOpen + ' open · ' + (r.eligibleClose ? r.eligibleClose.length : 0) + ' eligible to close';
    } else if (r.action === 'FIND_GRADE_A_DEBIT_SPREAD') {
      value = r.candidatesFound + ' candidates · ' + r.spreadsBuilt + ' debit spreads built';
      if (r.builds && r.builds.length) {
        value += '\n' + r.builds.map(function(b) { return '• ' + b.ticker + ' ' + b.type; }).join('\n');
      }
    } else if (r.action === 'FIND_GRADE_A_NAKED') {
      value = (r.proposed || 0) + ' candidates';
      if (r.candidates && r.candidates.length) {
        value += '\n' + r.candidates.map(function(c) { return '• ' + c.ticker + ' ' + (c.direction || ''); }).join('\n');
      } else if (r.message) value += ' — ' + r.message;
    } else if (r.action === 'ROLL_PROFITABLE_SPREADS') {
      value = r.spreadsOpen + ' open · ' + r.rollEligible + ' eligible to roll';
    } else if (r.action === 'FIND_WEEKEND_LOTTO') {
      value = (r.candidatesFound || 0) + ' weekend lotto candidates';
    } else if (r.action === 'CLOSE_ALL_BY_330') {
      value = r.positionsOpen + ' positions to close by 3:30 PM ET';
    } else if (r.action === 'PUSH_WEEKLY_RECAP') {
      value = 'recap pushed (see separate embed)';
    } else {
      value = JSON.stringify(r).slice(0, 200);
    }
    fields.push({ name: name, value: value || '—', inline: false });
  });

  return {
    username: 'Flow Scout — Weekly Orchestrator',
    embeds: [{
      title: (day.icon || '📅') + ' ' + dayKey.toUpperCase() + ' — ' + day.label,
      description: day.summary,
      color: 7506394,  // teal
      fields: fields,
      footer: { text: 'Phase 4.40 · /api/weekly-orchestrator/run-day?day=' + dayKey },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildWeeklyRecapEmbed(recap) {
  var lines = [];
  var bb = recap.byBucket;
  function row(name, b) {
    var pct = b.target > 0 ? Math.round(b.realized / b.target * 100) : 0;
    var marker = pct >= 100 ? ' ✅' : '';
    return name + ' '.repeat(Math.max(1, 24 - name.length)) +
      ' $' + Math.round(b.realized) + ' / $' + b.target + ' = ' + pct + '%' + marker;
  }
  lines.push('```');
  lines.push('Realized P&L this week:');
  lines.push('  ' + row('Income (credit)', bb.income));
  lines.push('  ' + row('Debit spreads',    bb.debit));
  lines.push('  ' + row('Naked directional', bb.naked));
  lines.push('  ' + row('Covered calls',     bb.coveredCall));
  lines.push('  ' + row('Lottos',            bb.lotto));
  lines.push('  ────────────────────');
  var totalPct = recap.pctOfStretch;
  lines.push('  TOTAL                  $' + recap.totalRealized + ' / $' + recap.targets.stretch +
             ' = ' + totalPct + '%');
  lines.push('');
  lines.push('Win rate: ' + recap.wins + 'W / ' + recap.losses + 'L = ' + recap.winRate + '%');
  if (recap.bestTrade && recap.bestTrade.ticker) {
    lines.push('Best:  ' + recap.bestTrade.ticker + ' $' + Math.round(recap.bestTrade.pnl || 0) +
               (recap.bestTrade.pct != null ? ' (' + Math.round(recap.bestTrade.pct) + '%)' : ''));
  }
  if (recap.worstTrade && recap.worstTrade.ticker) {
    lines.push('Worst: ' + recap.worstTrade.ticker + ' $' + Math.round(recap.worstTrade.pnl || 0) +
               (recap.worstTrade.pct != null ? ' (' + Math.round(recap.worstTrade.pct) + '%)' : ''));
  }
  lines.push('');
  lines.push('Monthly pace: ~$' + recap.monthlyPace + ' (target $6,000)');
  lines.push('```');

  return {
    username: 'Flow Scout — Weekly Orchestrator',
    embeds: [{
      title: '📊 WEEKLY RECAP — Week of ' + recap.weekStart,
      description: lines.join('\n'),
      color: 5763719,
      fields: [],
      footer: { text: 'Phase 4.40 · /api/weekly-orchestrator/recap' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// =============================================================================
// MANUAL: closeAllPositions / pushWeeklyRecap (called by Friday 3:30 cron)
// =============================================================================
async function closeAllPositions() {
  return await executeCloseAllBy330({ type: 'CLOSE_ALL_BY_330' });
}

async function pushWeeklyRecap() {
  return await executePushWeeklyRecap({ type: 'PUSH_WEEKLY_RECAP' });
}

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  PLAYBOOK: PLAYBOOK,
  WEEKLY_TARGETS: WEEKLY_TARGETS,
  runDailyPlaybook: runDailyPlaybook,
  executeAction: executeAction,
  computeWeeklyRecap: computeWeeklyRecap,
  getTargetProgress: getTargetProgress,
  closeAllPositions: closeAllPositions,
  pushWeeklyRecap: pushWeeklyRecap,
  buildDailyPlaybookEmbed: buildDailyPlaybookEmbed,
  buildWeeklyRecapEmbed: buildWeeklyRecapEmbed,
  loadState: loadState,
  saveState: saveState,
  isEnabled: isEnabled,
  todayET: todayET,
  dayOfWeekET: dayOfWeekET,
  weekStartMondayET: weekStartMondayET,
};
