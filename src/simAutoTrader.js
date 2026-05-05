// =============================================================================
// ICS — Intraday-Confirmed Swing — autonomous SIM auto-trader.
// (was simAutoTrader, evolved May 4 2026 after AB locked in ICS strategy)
//
// THE ONE STRATEGY (locked in with AB):
//   Setup detected EOD/overnight on JS/COIL/WP/AYCE scanners with conv>=8 + Hold SAFE.
//   Trigger fires INTRADAY when stock breaks past prior-day high (long) or low (short).
//   Hold 1-3 days. Trim TP1 same-day. Hold rest into next day. Trim or trail TP2.
//   2 PM next-day time stop if no profit. Both directions across universe. 65% win rate target.
//
// SIZING:
//   - 2ct base for any qualifier (conv 8 + Hold SAFE + TFC)
//   - 3ct top-tier (conv 9-10 + multi-system confluence)
//
// EXIT RULES:
//   - TP1 +50% premium → exit 1ct (locks bill money same-day, NO PDT issue in SIM)
//   - TP2 +100% premium → exit 2nd ct OR trail to entry
//   - Time stop: 2 PM next trading day if not in profit → exit all
//   - Hard kill: -25% premium OR structural invalidation 2-day daily close → exit all
//
// HARD SAFETY (cannot bypass):
//   1. ALWAYS account='sim' — refuses to fire to 'ts' or 'public'
//   2. Daily cap: max 8 ICS fires/day (was 5, raised for both-direction universe)
//   3. Concurrent cap: max 8 open positions (was 5)
//   4. 7-day per-ticker cooldown (was 24h — ICS holds 1-3 days, want a buffer)
//   5. Time window: 9:45 AM - 3:30 PM ET
//   6. SIM_AUTO_ENABLED env var must = 'true'
//   7. PDT-aware in live mode (counts day-trades in trailing 5d window)
//
// VALIDATION GATE:
//   30 trades → first read (±15% CI on win rate)
//   60 trades → solid signal (±12% CI)
//   90 trades → real validation (±10% CI) → safe to enable LIVE
// =============================================================================

var fs = require('fs');
var path = require('path');

// Optional dependencies — load best-effort
var ayceScanner = null;
try { ayceScanner = require('./ayceScanner'); } catch (e) {}
var johnPatternScanner = null;
try { johnPatternScanner = require('./johnPatternScanner'); } catch (e) {}
var dailyCoilScanner = null;
try { dailyCoilScanner = require('./dailyCoilScanner'); } catch (e) {}
var wpScanner = null;
try { wpScanner = require('./wpScanner'); } catch (e) {}
var tradeTracker = null;
try { tradeTracker = require('./tradeTracker'); } catch (e) {}
// EXTERNAL SETUPS — from AB's local Claude Code routine via POST /api/external-setups/import
var externalSetups = null;
try { externalSetups = require('./externalSetups'); } catch (e) {}
// PRE-FIRE VISION GATE — chart-vision check before fire (returns SKIP today, will gate later)
var prefireVisionGate = null;
try { prefireVisionGate = require('./prefireVisionGate'); } catch (e) {}
// MULTI-TEST BREAKOUT SCANNER — Phase 4.22 detector used as soft gate (Phase 4.27)
var multiTestBreakoutScanner = null;
try { multiTestBreakoutScanner = require('./multiTestBreakoutScanner'); } catch (e) {}
// PDT TRACKER — gates LIVE TS account fires (sim ignored)
var pdtTracker = null;
try { pdtTracker = require('./pdtTracker'); } catch (e) {}
// SIM TRADE JOURNAL — Phase 4.24, per-position lifecycle for win-rate stats
var simTradeJournal = null;
try { simTradeJournal = require('./simTradeJournal'); } catch (e) {}
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'sim_auto_state.json');
// Phase 4.27 — log of all SIM fires that were BLOCKED by gates so AB can audit
// what's getting filtered. /api/sim-auto/blocked-log surfaces this. Append-only,
// auto-trim to last 500 entries on each write.
var BLOCKED_LOG_FILE = path.join(DATA_ROOT, 'sim_blocked_log.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// HARD SAFETY CONSTANTS — ICS rules
var MAX_DAILY_FIRES = 8;          // both-direction universe needs more headroom
var MAX_CONCURRENT_OPEN = 8;      // 1-3 day holds × 2-3 fires/day
var TICKER_COOLDOWN_HRS = 168;    // 7 days — don't re-fire same ticker until prior cycle done
var TRIGGER_TOLERANCE_PCT = 0.20; // tightened — need clean break, not at-trigger
var MIN_CONVICTION = 8;
var TOP_TIER_CONVICTION = 9;      // 9-10 with multi-system → 3ct sizing
var BASE_SIZE = 2;                 // ct
var TOP_TIER_SIZE = 3;            // ct
var TP1_GAIN_PCT = 50;            // first half exits at +50% same-day
var TP2_GAIN_PCT = 100;           // second half exits at +100% next-day
// May 5 2026 — RAISED to -50% per AB rule. Flat -25% premium stop got
// whipsawed on ABBV during 9:30 opening volatility ($153 loss). The PRIMARY
// stop is structural (icsTradeManager polls underlying for setup.stop break);
// the premium stop is now ONLY a tail-risk catch for catastrophic gaps.
// Reference: feedback_stop_management.md + feedback_abbv_stop_lesson_may5.md
var STOP_LOSS_PCT = 50;           // -50% premium TAIL-RISK catch only (was -25, whipsaw zone)
var TIME_STOP_HOUR_ET = 14;       // 2 PM next-day time stop

function isEnabled() {
  // DEFAULT TRUE (AB-requested May 4 2026): SIM is paper-money, can't hit live.
  // Hard safety stays — account is hardcoded 'sim' inside fireSimOrder, so even
  // if env mistakenly flips, it CANNOT route to live broker. This unlock lets
  // AB get the full 6-week / 30-trade dataset without touching env vars.
  // To force-disable: set SIM_AUTO_ENABLED=false explicitly.
  var v = process.env.SIM_AUTO_ENABLED;
  if (v == null || v === '') return true;  // default on
  return String(v).toLowerCase() !== 'false';
}

function todayET() {
  var now = new Date();
  var et = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, d, y] = et.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
}

function inFireWindow() {
  var now = new Date();
  var etHr = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  var etMin = now.getMinutes();
  // 9:45 AM - 3:30 PM ET
  if (etHr === 9 && etMin >= 45) return true;
  if (etHr >= 10 && etHr < 15) return true;
  if (etHr === 15 && etMin <= 30) return true;
  return false;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) {
    return {
      currentDate: todayET(),
      dailyFires: [],
      tickerCooldowns: {},  // { ticker: ISO timestamp of last fire }
      openPositions: [],     // [{ ticker, fireId, openedAt, contractSymbol, ... }]
      totalLifetimeFires: 0,
    };
  }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {
    console.error('[SIM-AUTO] state save failed:', e.message);
  }
}

function rolloverDailyState(state) {
  var today = todayET();
  if (state.currentDate !== today) {
    // New day — archive yesterday's fires (for recap), reset daily counter
    state.previousDate = state.currentDate;
    state.previousDayFires = state.dailyFires || [];
    state.currentDate = today;
    state.dailyFires = [];
  }
  // Always cleanup ticker cooldowns older than 24h
  var cutoff = Date.now() - (TICKER_COOLDOWN_HRS * 3600 * 1000);
  Object.keys(state.tickerCooldowns || {}).forEach(function(t) {
    var ts = new Date(state.tickerCooldowns[t]).getTime();
    if (ts < cutoff) delete state.tickerCooldowns[t];
  });
  return state;
}

function isTickerInCooldown(state, ticker) {
  var cd = (state.tickerCooldowns || {})[ticker];
  if (!cd) return false;
  var ageHr = (Date.now() - new Date(cd).getTime()) / 3600000;
  return ageHr < TICKER_COOLDOWN_HRS;
}

// Pull live spot via TS API
async function getSpot(ticker, token) {
  if (!ts) return null;
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(ticker);
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000 });
    if (!r.ok) return null;
    var data = await r.json();
    var q = (data.Quotes || data.quotes || [])[0];
    if (!q) return null;
    return parseFloat(q.Last || q.Close || 0);
  } catch (e) { return null; }
}

function isAtTrigger(spot, trigger, direction) {
  if (!spot || !trigger) return false;
  var diff = spot - trigger;
  var tolPct = Math.abs(trigger) * (TRIGGER_TOLERANCE_PCT / 100);
  if (direction === 'long') return diff >= -tolPct;
  return diff <= tolPct;
}

// Aggregate qualifying setups across all scanners
function collectQualifyingSetups() {
  var setups = [];

  function addIfQualifies(s) {
    if ((s.conviction || 0) < MIN_CONVICTION) return;
    if (s.holdRating && s.holdRating !== 'SAFE') return;  // Only SAFE
    if (s.earningsRisk) return;  // Skip if earnings risk
    if (!s.trigger || !s.direction) return;
    if (s.direction !== 'long' && s.direction !== 'short') return;
    setups.push(s);
  }

  // AYCE armed strategies
  if (ayceScanner && ayceScanner.loadLast) {
    try {
      var ayce = ayceScanner.loadLast();
      ((ayce && ayce.hits) || []).forEach(function(h) {
        (h.strategies || []).forEach(function(strat) {
          if (['armed', 'live-armed', 'live-fired'].indexOf(strat.status) >= 0) {
            addIfQualifies({
              ticker: h.ticker,
              source: 'AYCE-' + strat.name,
              direction: strat.direction,
              trigger: parseFloat(strat.trigger),
              stop: parseFloat(strat.stop),
              tp1: parseFloat(strat.T1),
              tp2: parseFloat(strat.T2),
              conviction: strat.conviction || 8,
              holdRating: h.holdRating,
              earningsRisk: h.earningsRisk,
              pattern: strat.name,
            });
          }
        });
      });
    } catch (e) { console.error('[SIM-AUTO] ayce error:', e.message); }
  }

  // JS scanner ready (conv >= 8)
  if (johnPatternScanner && johnPatternScanner.loadLast) {
    try {
      var js = johnPatternScanner.loadLast();
      ((js && js.ready) || []).forEach(function(r) {
        addIfQualifies({
          ticker: r.ticker,
          source: 'JS-' + (r.tf || '?'),
          direction: r.direction,
          trigger: parseFloat(r.triggerPrice || (r.plan && r.plan.primary && r.plan.primary.trigger)),
          stop: parseFloat(r.stopPrice || (r.plan && r.plan.primary && r.plan.primary.stop)),
          tp1: parseFloat(r.tp1 || (r.plan && r.plan.primary && r.plan.primary.tp1)),
          tp2: parseFloat(r.tp2 || (r.plan && r.plan.primary && r.plan.primary.tp2)),
          conviction: r.conviction || 0,
          holdRating: r.holdRating,
          earningsRisk: r.earningsRisk,
          pattern: r.pattern,
        });
      });
    } catch (e) { console.error('[SIM-AUTO] js error:', e.message); }
  }

  // COIL scanner ready
  if (dailyCoilScanner && dailyCoilScanner.loadLast) {
    try {
      var coil = dailyCoilScanner.loadLast();
      ((coil && coil.ready) || []).forEach(function(r) {
        addIfQualifies({
          ticker: r.ticker,
          source: 'COIL',
          direction: r.direction,
          trigger: parseFloat(r.triggerPrice || (r.plan && r.plan.primary && r.plan.primary.trigger)),
          stop: parseFloat(r.stopPrice || (r.plan && r.plan.primary && r.plan.primary.stop)),
          tp1: parseFloat(r.plan && r.plan.primary && r.plan.primary.tp1),
          tp2: parseFloat(r.plan && r.plan.primary && r.plan.primary.tp2),
          conviction: r.conviction || 0,
          holdRating: r.holdRating,
          earningsRisk: r.earningsRisk,
          pattern: r.pattern,
        });
      });
    } catch (e) { console.error('[SIM-AUTO] coil error:', e.message); }
  }

  // WP scanner ready
  if (wpScanner && wpScanner.loadLast) {
    try {
      var wp = wpScanner.loadLast();
      ((wp && wp.ready) || []).forEach(function(r) {
        addIfQualifies({
          ticker: r.ticker,
          source: 'WP',
          direction: r.direction,
          trigger: parseFloat((r.plan && r.plan.entry) || r.triggerPrice),
          stop: parseFloat(r.plan && r.plan.stop),
          tp1: parseFloat(r.plan && r.plan.tp1),
          tp2: parseFloat(r.plan && r.plan.tp2),
          conviction: r.conviction || 0,
          holdRating: r.holdRating,
          earningsRisk: r.earningsRisk,
          pattern: r.signal,
        });
      });
    } catch (e) { console.error('[SIM-AUTO] wp error:', e.message); }
  }

  // EXTERNAL SETUPS — from AB's local Claude Code routines (POST /api/external-setups/import)
  // These get full priority because AB's local research is the source of truth for ICS.
  if (externalSetups && externalSetups.loadActiveSetups) {
    try {
      var ext = externalSetups.loadActiveSetups(24);  // 24h freshness window
      ext.forEach(function(s) {
        // External setups already have source/pattern/tf/holdRating/conviction normalized
        // by the import endpoint. Just route through addIfQualifies for filter consistency.
        addIfQualifies(s);
      });
      if (ext.length > 0) console.log('[SIM-AUTO] +' + ext.length + ' setups from external routines');
    } catch (e) { console.error('[SIM-AUTO] external setups error:', e.message); }
  }

  return setups;
}

// Determine ICS sizing — 2ct base, 3ct top-tier, or AB's preferredSize override
function pickSize(setup) {
  // External setups can specify preferredSize (AB's research-driven override)
  if (setup.preferredSize && setup.preferredSize >= 1 && setup.preferredSize <= 5) {
    return setup.preferredSize;
  }
  var topTier = (setup.conviction >= TOP_TIER_CONVICTION);
  var multiSystem = (setup.systems && setup.systems.length >= 2) || setup.multiSystem;
  if (topTier && multiSystem) return TOP_TIER_SIZE;
  return BASE_SIZE;
}

// =============================================================================
// PHASE 4.27 — GATE PIPELINE
// =============================================================================
// Runs server-side gates before any SIM fire. Mirrors the manual-fire gate
// pipeline used by scanner-v2.html (taGateOrAbort, chartVisionGateOrAbort,
// market-context check, multi-test breakout check) so SIM auto-fires honor
// the same edge filters AB applies on the manual side.
//
// Built May 5 2026 PM after SIM win rate hit 22% (2W/7L closed) — at least
// 3-4 of the losers (counter-tape INTC put, bearish-TA UNH call, vision-VETO
// XLE call, vision-VETO ADBE call) would have been blocked by gates that
// already exist in production for manual fires but were never wired to SIM.
//
// FAIL-OPEN POLICY:
//   - TA gate: if bars unavailable / TS error → ALLOW (don't block on infra)
//   - Tape gate: if market-context unavailable → ALLOW
//   - MTB gate: SOFT by default (just logs verdict); set SIM_MTB_GATE=on for hard
//   - Vision gate: FAIL-CLOSED on VETO, ALLOW on WAIT/SKIP/error
//
// ENV OVERRIDES (all optional):
//   SIM_TA_GATE=off      → skip TA gate (default ON)
//   SIM_TAPE_GATE=off    → skip tape gate (default ON)
//   SIM_VISION_GATE=on   → enable vision gate (default OFF — Railway has no Chrome)
//   SIM_MTB_GATE=on      → make MTB a hard gate for longs (default OFF — soft)
// =============================================================================

function gateEnabled(envName, defaultOn) {
  var v = process.env[envName];
  if (v == null || v === '') return !!defaultOn;
  v = String(v).toLowerCase();
  return v !== 'off' && v !== 'false' && v !== '0';
}

// SERVER-SIDE TA VERIFY — replicates /api/ta-verify logic without an HTTP hop.
// Pulls last 5 5m bars, returns alignment: 'aligned' | 'opposite' | 'mixed' | 'unknown'.
async function taVerifyServerSide(ticker, direction) {
  if (!ts || !ts.getAccessToken) return { alignment: 'unknown', reason: 'no TS module' };
  var token;
  try { token = await ts.getAccessToken(); } catch (e) { return { alignment: 'unknown', reason: 'no TS token' }; }
  if (!token) return { alignment: 'unknown', reason: 'no TS token' };
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?interval=5&unit=Minute&barsback=5';
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 6000 });
    if (!r.ok) return { alignment: 'unknown', reason: 'TS http ' + r.status };
    var data = await r.json();
    var bars = (data.Bars || []).map(function(b) {
      return { open: parseFloat(b.Open), close: parseFloat(b.Close) };
    });
    if (bars.length < 3) return { alignment: 'unknown', reason: 'not enough bars' };
    var greenCount = bars.filter(function(b){ return b.close >= b.open; }).length;
    var redCount = bars.length - greenCount;
    var trendUp = greenCount >= 3;
    var trendDown = redCount >= 3;
    var lastClose = bars[bars.length - 1].close;
    var firstOpen = bars[0].open;
    var pctMove = firstOpen > 0 ? ((lastClose - firstOpen) / firstOpen) * 100 : 0;

    var dirNorm = String(direction || '').toLowerCase();
    var isLong = (dirNorm === 'long' || dirNorm === 'bullish' || dirNorm === 'call');
    var alignment;
    var reason;
    if (isLong) {
      if (trendUp) { alignment = 'aligned'; reason = greenCount + '/' + bars.length + ' green +' + pctMove.toFixed(2) + '%'; }
      else if (trendDown) { alignment = 'opposite'; reason = redCount + '/' + bars.length + ' RED ' + pctMove.toFixed(2) + '% — dumping into LONG'; }
      else { alignment = 'mixed'; reason = greenCount + '/' + bars.length + ' green ' + pctMove.toFixed(2) + '%'; }
    } else {
      if (trendDown) { alignment = 'aligned'; reason = redCount + '/' + bars.length + ' RED ' + pctMove.toFixed(2) + '%'; }
      else if (trendUp) { alignment = 'opposite'; reason = greenCount + '/' + bars.length + ' GREEN +' + pctMove.toFixed(2) + '% — pumping into SHORT'; }
      else { alignment = 'mixed'; reason = redCount + '/' + bars.length + ' red ' + pctMove.toFixed(2) + '%'; }
    }
    return {
      alignment: alignment, reason: reason,
      greenCount: greenCount, redCount: redCount,
      pctMove5min: +pctMove.toFixed(2),
      barsChecked: bars.length,
    };
  } catch (e) {
    return { alignment: 'unknown', reason: 'TS fetch error: ' + e.message };
  }
}

// SERVER-SIDE MARKET CONTEXT (cached) — calls the local /api/market-context
// HTTP endpoint instead of duplicating the SPY/QQQ/IWM logic. The endpoint is
// already cached server-side (60s TTL), so this is cheap. Falls back to
// 'UNKNOWN' if endpoint unreachable.
var _gateMarketContextCache = { ts: 0, payload: null };
var GATE_MC_TTL_MS = 60 * 1000;

async function getMarketContextCached() {
  var now = Date.now();
  if (_gateMarketContextCache.payload && (now - _gateMarketContextCache.ts) < GATE_MC_TTL_MS) {
    return _gateMarketContextCache.payload;
  }
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  try {
    var r = await fetchLib(serverBase + '/api/market-context', { timeout: 5000 });
    if (!r.ok) return { tape: 'UNKNOWN', reason: 'http ' + r.status };
    var data = await r.json();
    if (data && data.ok) {
      _gateMarketContextCache = { ts: now, payload: data };
      return data;
    }
    return { tape: 'UNKNOWN', reason: 'no data' };
  } catch (e) {
    return { tape: 'UNKNOWN', reason: 'fetch error: ' + e.message };
  }
}

// SERVER-SIDE MULTI-TEST BREAKOUT — uses module directly, no HTTP hop.
// Only meaningful for LONG direction (looking for resistance break upward).
// Returns { verdict, confidence, level, touchCount } or { verdict: 'UNKNOWN' }.
async function multiTestBreakoutCheck(ticker, direction, tf) {
  if (!multiTestBreakoutScanner || !multiTestBreakoutScanner.detect) {
    return { verdict: 'UNKNOWN', reason: 'scanner not loaded' };
  }
  // Only longs use upside-resistance MTB; for shorts we just return UNKNOWN
  // (would need symmetric support-break detector to gate shorts the same way).
  if (String(direction).toLowerCase() !== 'long') {
    return { verdict: 'UNKNOWN', reason: 'MTB only applies to long direction' };
  }
  try {
    var out = await multiTestBreakoutScanner.detect(ticker, tf || '60m');
    return {
      verdict: out.verdict || 'NO_PATTERN',
      confidence: out.confidence,
      level: out.level,
      touchCount: out.touchCount,
      reason: out.reasoning,
    };
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: 'MTB error: ' + e.message };
  }
}

// SERVER-SIDE CHART VISION — calls local /api/chart-vision endpoint. On
// Railway this returns WAIT/'vision unavailable' because no Chrome CDP, which
// is why SIM_VISION_GATE defaults to off. On AB's local box this works.
async function chartVisionCheck(ticker, direction, tradeType) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  try {
    var r = await fetchLib(serverBase + '/api/chart-vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: ticker,
        direction: direction,
        tradeType: tradeType || 'SWING',
      }),
      timeout: 90000,
    });
    if (!r.ok) return { verdict: 'WAIT', reason: 'http ' + r.status, available: false };
    var data = await r.json();
    return {
      verdict: data.verdict || 'WAIT',
      confidence: data.confidence,
      summary: data.summary,
      higherTf: data.higherTf,
      lowerTf: data.lowerTf,
      available: !(data.summary && data.summary.indexOf('vision unavailable') >= 0),
    };
  } catch (e) {
    return { verdict: 'WAIT', reason: 'vision fetch error: ' + e.message, available: false };
  }
}

// MAIN GATE PIPELINE — runs all gates and returns a verdict object.
// On block, also writes to /data/sim_blocked_log.json so AB can audit later.
async function runGates(setup) {
  var gates = {
    ta: 'skipped', tape: 'skipped', mtb: 'skipped', vision: 'skipped',
  };
  var diagnostics = {};

  // ---- Gate 1: TA verify (5-bar alignment) ----
  if (gateEnabled('SIM_TA_GATE', true)) {
    var ta = await taVerifyServerSide(setup.ticker, setup.direction);
    diagnostics.ta = ta;
    gates.ta = ta.alignment;
    if (ta.alignment === 'opposite') {
      return {
        pass: false,
        gate: 'TA',
        reason: 'TA OPPOSITE — bars dumping into ' + setup.direction + ' (' + ta.reason + ')',
        gates: gates,
        diagnostics: diagnostics,
      };
    }
  }

  // ---- Gate 2: Tape alignment ----
  if (gateEnabled('SIM_TAPE_GATE', true)) {
    var tape = await getMarketContextCached();
    diagnostics.tape = { tape: tape.tape, summary: tape.summary };
    gates.tape = tape.tape || 'UNKNOWN';
    var dirNorm = String(setup.direction || '').toLowerCase();
    var isLong = (dirNorm === 'long' || dirNorm === 'bullish' || dirNorm === 'call');
    var isShort = (dirNorm === 'short' || dirNorm === 'bearish' || dirNorm === 'put');
    if (tape.tape === 'RISK_ON' && isShort) {
      return {
        pass: false,
        gate: 'TAPE',
        reason: 'COUNTER-TAPE — short on RISK_ON tape (' + (tape.summary || '') + ')',
        gates: gates,
        diagnostics: diagnostics,
      };
    }
    if (tape.tape === 'RISK_OFF' && isLong) {
      return {
        pass: false,
        gate: 'TAPE',
        reason: 'COUNTER-TAPE — long on RISK_OFF tape (' + (tape.summary || '') + ')',
        gates: gates,
        diagnostics: diagnostics,
      };
    }
  }

  // ---- Gate 3: Multi-test breakout (Phase 4.22) ----
  // SOFT by default — only blocks if SIM_MTB_GATE=on (and only for longs with NO_PATTERN).
  var mtb = await multiTestBreakoutCheck(setup.ticker, setup.direction);
  diagnostics.mtb = mtb;
  gates.mtb = mtb.verdict;
  setup._mtbVerdict = mtb.verdict;  // attach for journaling
  if (gateEnabled('SIM_MTB_GATE', false)) {
    var dirNorm2 = String(setup.direction || '').toLowerCase();
    var isLong2 = (dirNorm2 === 'long' || dirNorm2 === 'bullish' || dirNorm2 === 'call');
    if (isLong2 && (mtb.verdict === 'NO_PATTERN' || mtb.verdict === 'TESTING')) {
      return {
        pass: false,
        gate: 'MTB',
        reason: 'MTB ' + mtb.verdict + ' — no breakout confirmation on long (' + (mtb.reason || '') + ')',
        gates: gates,
        diagnostics: diagnostics,
      };
    }
  }

  // ---- Gate 4: Chart vision (Phase 4.21) ----
  // FAIL-CLOSED on VETO, fail-open on WAIT/MIXED/SKIP.
  if (gateEnabled('SIM_VISION_GATE', false)) {
    var tradeType = setup.tradeType || 'SWING';
    var vision = await chartVisionCheck(setup.ticker, setup.direction, tradeType);
    diagnostics.vision = vision;
    gates.vision = vision.verdict;
    if (vision.verdict === 'VETO') {
      return {
        pass: false,
        gate: 'VISION',
        reason: 'VISION VETO — ' + (vision.summary || ''),
        gates: gates,
        diagnostics: diagnostics,
      };
    }
  }

  return { pass: true, gates: gates, diagnostics: diagnostics };
}

// LOG a blocked fire to /data/sim_blocked_log.json (rolling, last 500).
function logBlockedFire(setup, gateResult, spot) {
  try {
    var existing = [];
    try { existing = JSON.parse(fs.readFileSync(BLOCKED_LOG_FILE, 'utf8')); } catch (e) {}
    if (!Array.isArray(existing)) existing = [];
    existing.push({
      timestamp: new Date().toISOString(),
      date: todayET(),
      ticker: setup.ticker,
      direction: setup.direction,
      source: setup.source,
      pattern: setup.pattern,
      conviction: setup.conviction,
      spot: spot,
      trigger: setup.trigger,
      stop: setup.stop,
      gate: gateResult.gate,
      reason: gateResult.reason,
      gates: gateResult.gates,
      diagnostics: gateResult.diagnostics,
    });
    // Trim to last 500
    if (existing.length > 500) existing = existing.slice(-500);
    fs.writeFileSync(BLOCKED_LOG_FILE, JSON.stringify(existing, null, 2));
  } catch (e) {
    console.error('[SIM-AUTO] blocked-log write failed:', e.message);
  }
}

// Read the blocked-log filtered to last N days. Used by /api/sim-auto/blocked-log.
function getBlockedLog(daysBack) {
  daysBack = parseInt(daysBack || 7, 10);
  try {
    var existing = JSON.parse(fs.readFileSync(BLOCKED_LOG_FILE, 'utf8'));
    if (!Array.isArray(existing)) existing = [];
    var cutoff = Date.now() - (daysBack * 24 * 3600 * 1000);
    var recent = existing.filter(function(e) {
      return e.timestamp && new Date(e.timestamp).getTime() >= cutoff;
    });
    // Per-gate breakdown
    var byGate = {};
    recent.forEach(function(e) {
      var g = e.gate || 'UNKNOWN';
      byGate[g] = (byGate[g] || 0) + 1;
    });
    return {
      ok: true,
      daysBack: daysBack,
      totalBlocked: recent.length,
      byGate: byGate,
      entries: recent.reverse(),  // newest first
    };
  } catch (e) {
    return { ok: true, daysBack: daysBack, totalBlocked: 0, byGate: {}, entries: [] };
  }
}

// RETRO REPLAY — runs gates against today's actual fires (or any specified
// list) using current market data. Used to answer "what would have been
// blocked if the gates were live?". Writes /data/sim_replay_<date>.json.
async function runRetroReplay(opts) {
  opts = opts || {};
  var fires;
  // Use provided fires, or fall back to today's dailyFires from sim_auto_state
  if (Array.isArray(opts.fires) && opts.fires.length) {
    fires = opts.fires;
  } else {
    var state = loadState();
    fires = (state.dailyFires || []).slice();
    // Optionally augment with previousDayFires + manually-passed tickers
    if (opts.includeYesterday && Array.isArray(state.previousDayFires)) {
      fires = state.previousDayFires.concat(fires);
    }
  }

  // Optionally augment from extra tickers (e.g. AB's reference list:
  // INTC, F, ADBE, RIVN, UNH for the May 5 retro)
  if (Array.isArray(opts.extraTickers) && opts.extraTickers.length) {
    opts.extraTickers.forEach(function(t) {
      // Only add if not already in fires
      if (!fires.some(function(f) { return f.ticker === t.ticker && f.direction === t.direction; })) {
        fires.push({
          ticker: t.ticker,
          direction: t.direction,
          source: t.source || 'retro-extra',
          conviction: t.conviction || 8,
        });
      }
    });
  }

  var results = [];
  var stats = { ta: 0, tape: 0, mtb: 0, vision: 0, passed: 0, total: fires.length };
  for (var i = 0; i < fires.length; i++) {
    var f = fires[i];
    var setup = {
      ticker: f.ticker,
      direction: f.direction,
      source: f.source,
      pattern: f.pattern,
      conviction: f.conviction,
      tradeType: f.tradeType || 'SWING',
    };
    try {
      var verdict = await runGates(setup);
      results.push({
        ticker: f.ticker,
        direction: f.direction,
        source: f.source,
        firedAt: f.firedAt || null,
        wouldHaveBlocked: !verdict.pass,
        gate: verdict.gate || null,
        reason: verdict.reason || null,
        gates: verdict.gates,
      });
      if (!verdict.pass) {
        var g = (verdict.gate || '').toLowerCase();
        if (stats[g] != null) stats[g]++;
      } else {
        stats.passed++;
      }
    } catch (e) {
      results.push({
        ticker: f.ticker,
        direction: f.direction,
        source: f.source,
        wouldHaveBlocked: false,
        gate: 'ERROR',
        reason: e.message,
      });
    }
  }

  // Write to file for the day
  try {
    var replayFile = path.join(DATA_ROOT, 'sim_replay_' + todayET() + '.json');
    fs.writeFileSync(replayFile, JSON.stringify({
      ok: true,
      generatedAt: new Date().toISOString(),
      date: todayET(),
      stats: stats,
      results: results,
    }, null, 2));
  } catch (e) { console.error('[SIM-AUTO] replay write failed:', e.message); }

  return { ok: true, date: todayET(), stats: stats, results: results };
}

// Push Discord summary of the retro replay (Phase 4.27 deliverable #6).
async function pushReplaySummary(replay) {
  var blockedCount = replay.stats.ta + replay.stats.tape + replay.stats.mtb + replay.stats.vision;
  var byGateLines = [];
  if (replay.stats.ta) byGateLines.push('TA: ' + replay.stats.ta);
  if (replay.stats.tape) byGateLines.push('TAPE: ' + replay.stats.tape);
  if (replay.stats.mtb) byGateLines.push('MTB: ' + replay.stats.mtb);
  if (replay.stats.vision) byGateLines.push('VISION: ' + replay.stats.vision);
  var detail = (replay.results || [])
    .filter(function(r) { return r.wouldHaveBlocked; })
    .map(function(r) { return '• ' + r.ticker + ' ' + r.direction + ' [' + r.gate + ']: ' + (r.reason || '').slice(0, 100); })
    .slice(0, 10).join('\n') || 'None blocked.';

  var embed = {
    username: 'Flow Scout — Phase 4.27 Retro',
    embeds: [{
      title: '🛡️ Phase 4.27 — Gate Retro Analysis (' + replay.date + ')',
      description: 'Replayed today\'s SIM fires through TA + Tape + MTB + Vision gates.\n' +
        '**' + blockedCount + ' of ' + replay.stats.total + '** would have been blocked.',
      color: blockedCount > 0 ? 15844367 : 5763719,
      fields: [
        { name: '📊 By Gate', value: byGateLines.length ? byGateLines.join(' · ') : 'None', inline: false },
        { name: '🚫 Blocked Fires', value: detail.slice(0, 1000), inline: false },
        { name: '⚙️ Live Status',
          value: 'TA gate: ' + (gateEnabled('SIM_TA_GATE', true) ? 'ON' : 'OFF') +
                 ' · Tape: ' + (gateEnabled('SIM_TAPE_GATE', true) ? 'ON' : 'OFF') +
                 ' · Vision: ' + (gateEnabled('SIM_VISION_GATE', false) ? 'ON' : 'OFF') +
                 ' · MTB hard: ' + (gateEnabled('SIM_MTB_GATE', false) ? 'ON' : 'OFF (soft)'),
          inline: false },
      ],
      footer: { text: 'Flow Scout | Phase 4.27 — SIM Gate Retro' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  return await dp.send('simAutoReplay', embed, { webhook: DISCORD_WEBHOOK });
}

// Fire ICS SIM order via the existing ayce-fire path (build → place)
// ICS rules: 2-3ct, TP1 +50% / TP2 +100%, -25% stop, structural override.
async function fireSimOrder(setup, spot) {
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var qty = pickSize(setup);

  // PREFERRED CONTRACT PATH — if AB's external setup specifies an exact contract
  // (researched via Bullflow / volume / OI / flow data), use that verbatim.
  // Otherwise fall through to /api/ayce-fire/build resolver.
  var c, t, limitPrice;
  try {
    if (setup.preferredContractSymbol && /\d{6}[CP]\d+(\.\d+)?$/.test(String(setup.preferredContractSymbol).replace(/\s/g, ''))) {
      console.log('[SIM-AUTO] Using PREFERRED contract from external setup: ' + setup.preferredContractSymbol);
      // Pull live mid for the preferred contract via TS quote
      var qResolve = await fetchLib(serverBase + '/api/quote-or-bars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: setup.preferredContractSymbol }),
        timeout: 8000,
      }).catch(function() { return null; });
      // Fall back to resolver if we can't get a live quote (rare)
      if (!qResolve || !qResolve.ok) {
        console.log('[SIM-AUTO] preferred contract quote failed — falling back to resolver');
      } else {
        var qData = await qResolve.json().catch(function() { return null; });
        var liveMid = qData && (qData.mid || qData.midPrice || qData.last);
        if (liveMid && liveMid > 0) {
          c = { symbol: setup.preferredContractSymbol, strike: setup.preferredStrike, expiry: setup.preferredExpiry };
          t = { quantity: qty, limitPrice: Math.round(liveMid * 1.05 * 100) / 100, timeInForce: 'GTC' };
          limitPrice = parseFloat(t.limitPrice);
        }
      }
    }

    // Standard build path (resolver picks contract) — used when no preferred contract
    if (!c) {
      var buildRes = await fetchLib(serverBase + '/api/ayce-fire/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: setup.ticker,
          direction: setup.direction,
          tradeType: 'SWING',
          account: 'sim',
          size: qty,
        }),
        timeout: 10000,
      });
      var buildData = await buildRes.json();
      if (!buildData.ok || buildData.blocked) {
        return { ok: false, error: 'build failed: ' + (buildData.error || buildData.reason) };
      }
      c = buildData.contract;
      t = buildData.orderTicket;
      limitPrice = parseFloat(t.limitPrice);
    }
    // ICS exit math: stop -25%, TP1 +50%, TP2 +100%
    var stopPremium = Math.max(0.05, Math.round(limitPrice * (1 - STOP_LOSS_PCT / 100) * 100) / 100);
    var tp1Premium = Math.round(limitPrice * (1 + TP1_GAIN_PCT / 100) * 100) / 100;
    var tp2Premium = Math.round(limitPrice * (1 + TP2_GAIN_PCT / 100) * 100) / 100;

    // Place via /api/ayce-fire/place — uses TP1 for primary bracket; TP2 + time stop
    // are managed by icsTradeManager (separate cron, not yet built — for v1 use TP1 + stop)
    var placeRes = await fetchLib(serverBase + '/api/ayce-fire/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: setup.ticker,
        contractSymbol: c.symbol,
        direction: setup.direction,
        account: 'sim',  // HARDCODED
        size: qty,        // ICS: 2 or 3 ct
        limitPrice: limitPrice,
        stopPremium: stopPremium,
        tp1Premium: tp1Premium,
        structuralStopSymbol: setup.ticker,
        structuralStopPrice: setup.stop,
        structuralStopPredicate: setup.direction === 'long' ? 'below' : 'above',
        manualFire: true,  // bypass time gates inside ayce-fire
      }),
      timeout: 15000,
    });
    var placeData = await placeRes.json();
    if (!placeData.ok) {
      return { ok: false, error: 'place failed: ' + (placeData.error || 'unknown') };
    }

    return {
      ok: true,
      contract: c,
      orderTicket: t,
      qty: qty,
      limitPrice: limitPrice,
      stopPremium: stopPremium,
      tp1Premium: tp1Premium,
      tp2Premium: tp2Premium,
      placeResult: placeData.result,
    };
  } catch (e) {
    return { ok: false, error: 'fire exception: ' + e.message };
  }
}

// Push Discord card for a SIM fire
async function pushSimFireCard(setup, spot, fireResult) {
  var dirIcon = setup.direction === 'long' ? '🟢' : '🔴';
  var c = fireResult.contract;
  var t = fireResult.orderTicket;

  var embed = {
    username: 'Flow Scout — SIM AUTO',
    embeds: [{
      title: '🤖 ' + dirIcon + ' SIM AUTO FIRED — ' + setup.ticker + ' ' + setup.direction.toUpperCase(),
      description: '**Source**: ' + setup.source + ' (' + setup.pattern + ')\n' +
                   '**Conviction**: ' + setup.conviction + '/10  ·  **Hold**: ' + (setup.holdRating || 'unknown'),
      color: setup.direction === 'long' ? 5763719 : 15158332,
      fields: [
        {
          name: '📊 Trigger Hit',
          value: '**Spot** $' + spot.toFixed(2) + '  ·  **Trigger** $' + setup.trigger.toFixed(2) +
                 (setup.stop ? '  ·  **Stop** $' + setup.stop.toFixed(2) : ''),
          inline: false,
        },
        {
          name: '📋 ICS Order Placed (SIM) · ' + (fireResult.qty || t.quantity) + 'ct',
          value: '**' + c.symbol + '** @ $' + fireResult.limitPrice + ' LMT\n' +
                 'Stop: $' + fireResult.stopPremium + ' (-25%)\n' +
                 'TP1: $' + fireResult.tp1Premium + ' (+50%) · exits 1ct same-day\n' +
                 'TP2: $' + fireResult.tp2Premium + ' (+100%) · exits rest next-day\n' +
                 'Account: SIM',
          inline: false,
        },
        {
          name: '🎯 Why this fired (ICS)',
          value: 'Conv ' + setup.conviction + ' + Hold SAFE + No earnings + spot past trigger.\nIntraday-Confirmed Swing — hold 1-3 days, trim aggressive.',
          inline: false,
        },
        {
          name: '⏱️ Exit checklist',
          value: '• TP1 hit → exit 1ct, lock bill money\n• Hold rest into next day\n• 2 PM next-day = time stop if no profit\n• Stock-trigger override: ' + (setup.stop ? '$' + setup.stop : 'see scanner'),
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | SIM AUTO Trader | Logged to Trade Tracker' },
      timestamp: new Date().toISOString(),
    }],
  };

  var dp = require('./discordPush');
  return await dp.send('simAutoTrader', embed, { webhook: DISCORD_WEBHOOK });
}

// Push Discord card for a setup that QUALIFIED but COULD NOT FIRE (capped, cooldown, etc.)
// Skipped this one for first iteration — only fires get pushed.

// MAIN — runs the SIM auto-trade scan
async function runSimAuto(opts) {
  opts = opts || {};
  var force = opts.force || false;

  // Hard safety: must be enabled
  if (!isEnabled() && !force) {
    return { ok: false, skipped: true, reason: 'SIM_AUTO_ENABLED=false' };
  }

  // Time window
  if (!inFireWindow() && !force) {
    return { ok: false, skipped: true, reason: 'outside fire window (9:45 AM - 3:30 PM ET)' };
  }

  // Need TS token for live spot pulls
  if (!ts || !ts.getAccessToken) {
    return { ok: false, error: 'no tradestation module' };
  }
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { return { ok: false, error: 'no token' }; }
  if (!token) return { ok: false, error: 'no token' };

  // Load state, rollover daily
  var state = loadState();
  state = rolloverDailyState(state);

  // Daily cap
  if ((state.dailyFires || []).length >= MAX_DAILY_FIRES) {
    saveState(state);
    return { ok: true, skipped: true, reason: 'daily cap reached (' + MAX_DAILY_FIRES + ')' };
  }

  // Concurrent cap
  if ((state.openPositions || []).length >= MAX_CONCURRENT_OPEN) {
    saveState(state);
    return { ok: true, skipped: true, reason: 'concurrent open cap reached (' + MAX_CONCURRENT_OPEN + ')' };
  }

  var qualifying = collectQualifyingSetups();
  console.log('[SIM-AUTO] ' + qualifying.length + ' qualifying setups found');

  var firesAttempted = 0;
  var firesSucceeded = 0;
  var skips = [];

  for (var i = 0; i < qualifying.length; i++) {
    var setup = qualifying[i];

    // Cooldown check
    if (isTickerInCooldown(state, setup.ticker)) {
      skips.push(setup.ticker + ' (cooldown)');
      continue;
    }

    // Daily/concurrent caps re-check (we may have just fired)
    if ((state.dailyFires || []).length >= MAX_DAILY_FIRES) break;
    if ((state.openPositions || []).length >= MAX_CONCURRENT_OPEN) break;

    // Live spot
    var spot = await getSpot(setup.ticker, token);
    if (!spot) {
      skips.push(setup.ticker + ' (no spot)');
      continue;
    }

    // At trigger?
    if (!isAtTrigger(spot, setup.trigger, setup.direction)) {
      skips.push(setup.ticker + ' (not at trigger: $' + spot.toFixed(2) + ' vs $' + setup.trigger + ')');
      continue;
    }

    firesAttempted++;

    // Phase 4.27 — UNIFIED GATE PIPELINE (TA + Tape + MTB + Vision).
    // Replaces the standalone prefireVisionGate call. Logs blocked fires to
    // /data/sim_blocked_log.json for audit. Gates fail-open on infra error.
    var gateResult;
    try {
      gateResult = await runGates(setup);
    } catch (e) {
      console.error('[SIM-AUTO] gate pipeline exception (continuing):', e.message);
      gateResult = { pass: true, gates: { error: e.message } };
    }
    if (!gateResult.pass) {
      console.log('[SIM-AUTO] BLOCKED ' + setup.ticker + ' ' + setup.direction + ' [' + gateResult.gate + ']: ' + gateResult.reason);
      skips.push(setup.ticker + ' (' + gateResult.gate + ': ' + (gateResult.reason || '').slice(0, 60) + ')');
      logBlockedFire(setup, gateResult, spot);
      continue;
    }
    console.log('[SIM-AUTO] gates passed for ' + setup.ticker + ' [TA:' + gateResult.gates.ta +
      ' TAPE:' + gateResult.gates.tape + ' MTB:' + gateResult.gates.mtb + ' VISION:' + gateResult.gates.vision + ']');

    console.log('[SIM-AUTO] FIRING ' + setup.ticker + ' ' + setup.direction + ' from ' + setup.source);
    var fireResult = await fireSimOrder(setup, spot);

    if (!fireResult.ok) {
      console.error('[SIM-AUTO] FIRE FAILED for ' + setup.ticker + ': ' + fireResult.error);
      continue;
    }

    firesSucceeded++;

    // Pre-seed icsTradeManager state with structural metadata so STAGE -1
    // (stock-level structural stop) can fire on this position. Without this,
    // the manager would only have option-premium info from TS positions API,
    // not the underlying ticker / invalidation level.
    try {
      var icsStateFile = path.join(DATA_ROOT, 'ics_position_state.json');
      var icsState = {};
      try { icsState = JSON.parse(fs.readFileSync(icsStateFile, 'utf8')); } catch (e) {}
      icsState[fireResult.contract.symbol] = {
        contractSymbol: fireResult.contract.symbol,
        ticker: setup.ticker,
        direction: setup.direction,
        structuralStopPrice: setup.stop,        // stock-level invalidation
        triggerPrice: setup.trigger,             // stock-level entry trigger
        entry: fireResult.limitPrice,            // option premium at fire
        originalSize: fireResult.qty || 1,
        currentSize: fireResult.qty || 1,
        highWaterPremium: fireResult.limitPrice,
        stage: 'STAGE_0',
        openedAt: new Date().toISOString(),
        source: setup.source,
        pattern: setup.pattern,
        tf: setup.tf,
      };
      fs.writeFileSync(icsStateFile, JSON.stringify(icsState, null, 2));
    } catch (e) { console.error('[SIM-AUTO] icsState seed failed:', e.message); }

    // Log to trade tracker
    if (tradeTracker && tradeTracker.logFire) {
      try {
        tradeTracker.logFire({
          ticker: setup.ticker,
          direction: setup.direction,
          pattern: setup.pattern,
          confluenceTier: 'SIM-AUTO',
          confluenceScore: setup.conviction,
          sourceTab: setup.source,
          triggerPrice: setup.trigger,
          stopPrice: setup.stop,
          tp1Price: setup.tp1,
          tp2Price: setup.tp2,
          contractSymbol: fireResult.contract.symbol,
          fireMode: 'sim-auto',
          firedAt: new Date().toISOString(),
        });
      } catch (e) { console.error('[SIM-AUTO] tracker log error:', e.message); }
    }

    // Update state — Phase 4.27 attaches gate verdicts so AB can audit which
    // setups passed each gate when reviewing journal alongside outcomes.
    state.dailyFires.push({
      ticker: setup.ticker,
      source: setup.source,
      direction: setup.direction,
      conviction: setup.conviction,
      firedAt: new Date().toISOString(),
      contractSymbol: fireResult.contract.symbol,
      limitPrice: fireResult.limitPrice,
      spotAtFire: spot,
      gates: gateResult.gates || {},
    });
    state.tickerCooldowns[setup.ticker] = new Date().toISOString();
    state.openPositions.push({
      ticker: setup.ticker,
      contractSymbol: fireResult.contract.symbol,
      openedAt: new Date().toISOString(),
      direction: setup.direction,
    });
    state.totalLifetimeFires = (state.totalLifetimeFires || 0) + 1;
    saveState(state);

    // Phase 4.24: log to SIM Trade Journal so exits get tracked + win-rate stats build up
    if (simTradeJournal && simTradeJournal.openPosition) {
      try {
        simTradeJournal.openPosition({
          ticker: setup.ticker,
          direction: setup.direction,
          contractSymbol: fireResult.contract.symbol,
          entryPrice: fireResult.limitPrice,
          entrySpot: spot,
          conviction: setup.conviction,
          source: setup.source,
          contracts: fireResult.qty || 1,
          structuralStop: setup.stop,
        });
      } catch (e) { console.error('[SIM-AUTO] journal openPosition failed:', e.message); }
    }

    // Push Discord
    await pushSimFireCard(setup, spot, fireResult);
  }

  saveState(state);

  return {
    ok: true,
    qualifying: qualifying.length,
    firesAttempted: firesAttempted,
    firesSucceeded: firesSucceeded,
    skips: skips.slice(0, 10),  // first 10 only for log brevity
    dailyFiresTotal: (state.dailyFires || []).length,
    concurrentOpen: (state.openPositions || []).length,
    timestamp: new Date().toISOString(),
  };
}

// Get status snapshot for /api/sim-auto/status
function getStatus() {
  var state = loadState();
  state = rolloverDailyState(state);
  return {
    enabled: isEnabled(),
    inFireWindow: inFireWindow(),
    currentDate: state.currentDate,
    dailyFires: state.dailyFires || [],
    dailyFireCount: (state.dailyFires || []).length,
    dailyFireCap: MAX_DAILY_FIRES,
    openPositions: state.openPositions || [],
    concurrentCap: MAX_CONCURRENT_OPEN,
    tickerCooldowns: state.tickerCooldowns || {},
    totalLifetimeFires: state.totalLifetimeFires || 0,
    config: {
      minConviction: MIN_CONVICTION,
      holdRequired: 'SAFE',
      tickerCooldownHrs: TICKER_COOLDOWN_HRS,
      triggerTolerancePct: TRIGGER_TOLERANCE_PCT,
    },
  };
}

// Manual position-close helper (called by user or by EOD reconciliation)
function markPositionClosed(ticker, outcome) {
  var state = loadState();
  state.openPositions = (state.openPositions || []).filter(function(p) { return p.ticker !== ticker; });
  // Outcome logged separately by tradeTracker's close API
  saveState(state);
  // Phase 4.24: also tear down journal entry. Caller should pass exitPrice/exitSpot via
  // closeJournalPosition when known. This function (legacy) just returns ticker count.
  return { ok: true, ticker: ticker, openPositions: state.openPositions.length };
}

// EOD recap — pushes Discord summary card at 4:05 PM ET
async function runEodRecap() {
  var state = loadState();
  state = rolloverDailyState(state);
  var fires = state.dailyFires || [];

  var winRateBlock = '';
  if (tradeTracker && tradeTracker.getStats) {
    try {
      var stats = tradeTracker.getStats();
      if (stats) {
        winRateBlock = 'Lifetime: ' + (stats.totalTrades || 0) + ' trades, ' +
                       'win rate ' + (stats.winRate ? (stats.winRate * 100).toFixed(0) : '?') + '% (' +
                       (stats.wins || 0) + 'W / ' + (stats.losses || 0) + 'L)\n' +
                       (stats.totalTrades >= 30 && stats.winRate >= 0.65
                         ? '✅ **65%+ on 30 trades — system PROVEN. Consider live.**'
                         : 'Need 30 trades @ 65%+ to validate live mode.');
      }
    } catch (e) {}
  }

  var firesBlock = fires.length === 0
    ? 'No SIM fires today.'
    : fires.map(function(f, i) {
        return (i + 1) + '. ' + (f.direction === 'long' ? '🟢' : '🔴') + ' ' + f.ticker +
               ' (' + f.source + ', conv ' + f.conviction + ') @ $' + (f.limitPrice || '?') +
               ' (spot $' + (f.spotAtFire ? f.spotAtFire.toFixed(2) : '?') + ')';
      }).join('\n');

  var openBlock = (state.openPositions || []).length === 0
    ? 'No open positions.'
    : (state.openPositions || []).map(function(p) {
        return '• ' + p.ticker + ' ' + p.direction + ' (opened ' + new Date(p.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ')';
      }).join('\n');

  var embed = {
    username: 'Flow Scout — SIM AUTO Recap',
    embeds: [{
      title: '📊 SIM AUTO — End-of-Day Recap (' + state.currentDate + ')',
      description: 'Daily summary of paper-trade auto-fires. Validating the system before going live.',
      color: 5763719,
      fields: [
        { name: '🤖 Today\'s Fires', value: firesBlock.slice(0, 1000), inline: false },
        { name: '📂 Open Positions', value: openBlock.slice(0, 500), inline: false },
        ...(winRateBlock ? [{ name: '📈 Track Record', value: winRateBlock, inline: false }] : []),
        { name: '⚙️ Status',
          value: 'Enabled: ' + isEnabled() + '\nDaily cap: ' + fires.length + '/' + MAX_DAILY_FIRES + '\nConcurrent: ' + (state.openPositions || []).length + '/' + MAX_CONCURRENT_OPEN,
          inline: false },
      ],
      footer: { text: 'Flow Scout | SIM AUTO Trader | Daily Recap 4:05 PM ET' },
      timestamp: new Date().toISOString(),
    }],
  };

  var dp = require('./discordPush');
  return await dp.send('simAutoRecap', embed, { webhook: DISCORD_WEBHOOK });
}

module.exports = {
  runSimAuto: runSimAuto,
  runEodRecap: runEodRecap,
  getStatus: getStatus,
  markPositionClosed: markPositionClosed,
  collectQualifyingSetups: collectQualifyingSetups,  // exposed for inspection
  isEnabled: isEnabled,
  inFireWindow: inFireWindow,
  // Phase 4.27 — gate pipeline + retro tools
  runGates: runGates,
  runRetroReplay: runRetroReplay,
  pushReplaySummary: pushReplaySummary,
  getBlockedLog: getBlockedLog,
  taVerifyServerSide: taVerifyServerSide,
  getMarketContextCached: getMarketContextCached,
  multiTestBreakoutCheck: multiTestBreakoutCheck,
  chartVisionCheck: chartVisionCheck,
  gateEnabled: gateEnabled,
};
