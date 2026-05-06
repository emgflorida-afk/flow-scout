// =============================================================================
// unifiedSimAutoTrader.js — Phase 4.56
// =============================================================================
// One orchestrator that consumes ALL signal sources and fires SIM trades
// against a 6-per-day daily cap split across tiers:
//   scalp:     3/day max
//   day-trade: 2/day max
//   swing:     1/day max
//
// Sources pulled from /data/active_signals.json (the persistence layer used
// by every alert path: megaWatchAgent, johnLikePusher, triggerWatcher,
// xTradePoller). Quarantined signals are skipped — only graded sources fire.
//
// Sizing is per quickFire.computeQty (1.5/2.5/4% per tier).
// Account: SIM3142118M only. LIVE_AUTO_FIRE not consulted — this is SIM only.
//
// Logs every fire attempt (success or skipped) to /data/sim_fire_log.json
// (shared with the existing simAutoTrader fire log, structurally compatible).
//
// Integrates with the existing blocklist via orderExecutor.placeOrder gating.
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');
var qf = require('./quickFire');
var cb = require('./discordCardBuilder');
var dp = null;
try { dp = require('./discordPush'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var SLOT_FILE = path.join(DATA_ROOT, 'unified_sim_slots.json');
var FIRE_LOG = path.join(DATA_ROOT, 'unified_sim_fire_log.json');

// Hard caps per tier per day
var TIER_CAPS = {
  scalp: parseInt(process.env.SIM_CAP_SCALP    || '3', 10),
  'day-trade': parseInt(process.env.SIM_CAP_DAY  || '2', 10),
  swing: parseInt(process.env.SIM_CAP_SWING    || '1', 10),
};
var TOTAL_CAP = parseInt(process.env.SIM_FIRE_DAILY_CAP || '6', 10);

// Source allowlist — quarantined sources are skipped
var ALLOWED_SOURCES = (process.env.SIM_ALLOWED_SOURCES || 'mega,bar,john,jsmith,uoa,bullflow,trigger,external').split(',').map(function(s){ return s.trim().toLowerCase(); });

function todayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function loadSlots() {
  try {
    var d = JSON.parse(fs.readFileSync(SLOT_FILE, 'utf8'));
    if (d.date !== todayET()) return { date: todayET(), fires: [], byTier: {} };
    return d;
  } catch (e) { return { date: todayET(), fires: [], byTier: {} }; }
}

function saveSlots(s) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(SLOT_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('[USAT] slots save fail:', e.message); }
}

function loadLog() {
  try { return JSON.parse(fs.readFileSync(FIRE_LOG, 'utf8')); } catch (e) { return []; }
}

function appendLog(entry) {
  try {
    var log = loadLog();
    log.push(entry);
    if (log.length > 5000) log = log.slice(-5000);
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(FIRE_LOG, JSON.stringify(log, null, 2));
  } catch (e) { console.error('[USAT] log fail:', e.message); }
}

function inMarketHours() {
  var now = new Date();
  var et = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  var m = et.match(/,\s*(\d{1,2}):(\d{2})/);
  if (!m) return false;
  var total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  var dow = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dow === 'Sat' || dow === 'Sun') return false;
  return total >= 9 * 60 + 45 && total <= 15 * 60 + 30; // 9:45 - 15:30 ET
}

function tierForSignal(s) {
  // Honor explicit tier; otherwise default scalp
  var t = String(s.tier || '').toLowerCase();
  if (t === 'scalp' || t === 'day-trade' || t === 'swing') return t;
  if (s.contract && s.contract.expiry) {
    // Compute DTE
    var d = new Date(s.contract.expiry);
    var days = Math.round((d - Date.now()) / (24 * 3600 * 1000));
    if (days <= 1) return 'scalp';
    if (days <= 7) return 'day-trade';
    return 'swing';
  }
  return 'scalp';
}

// ----------------------------------------------------------------------------
// MAIN — pull signals, filter eligible, respect caps, fire each
// ----------------------------------------------------------------------------
async function tick(opts) {
  opts = opts || {};
  if (process.env.UNIFIED_SIM_AUTO_FIRE !== 'true' && !opts.force) {
    return { ok: true, skipped: 'UNIFIED_SIM_AUTO_FIRE not enabled (set env true to arm)' };
  }
  if (!opts.force && !inMarketHours()) {
    return { ok: true, skipped: 'outside RTH' };
  }

  var slots = loadSlots();
  if ((slots.fires || []).length >= TOTAL_CAP) {
    return { ok: true, skipped: 'daily cap (' + TOTAL_CAP + ') hit', firesToday: slots.fires.length };
  }

  // Pull active signals
  var map = cb.readSignals();
  var sigs = Object.keys(map).map(function(k){ return map[k]; });
  // Eligibility: not fired, not quarantined, allowed source, fresh, has contract.osi
  var nowMs = Date.now();
  sigs = sigs.filter(function(s) {
    if (!s) return false;
    if (s.fired) return false;
    if (s.quarantined) return false;
    if (!s.contract || !s.contract.osi) return false;
    if (!s.bracket) return false;
    var ageMin = (nowMs - new Date(s.createdAt).getTime()) / 60000;
    if (ageMin > 30) return false; // only act on fresh signals
    if (ALLOWED_SOURCES.indexOf((s.source || '').toLowerCase()) === -1) return false;
    return true;
  });

  // Sort: most recent first, but prioritize MEGA + uoa (institutional) over external
  var srcRank = { mega: 0, bar: 0, uoa: 1, bullflow: 1, john: 2, jsmith: 2, trigger: 3, external: 4 };
  sigs.sort(function(a, b) {
    var ra = srcRank[(a.source||'').toLowerCase()];
    var rb = srcRank[(b.source||'').toLowerCase()];
    if (ra == null) ra = 99; if (rb == null) rb = 99;
    if (ra !== rb) return ra - rb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  var attempts = [];
  for (var i = 0; i < sigs.length && (slots.fires || []).length < TOTAL_CAP; i++) {
    var s = sigs[i];
    var tier = tierForSignal(s);
    var caps = TIER_CAPS[tier] || 3;
    var firesInTier = (slots.byTier[tier] || 0);
    if (firesInTier >= caps) {
      attempts.push({ sid: s.id, ticker: s.ticker, tier: tier, skipped: 'tier cap (' + tier + ' ' + caps + ')' });
      continue;
    }

    var result;
    try {
      result = await qf.placeQuickFire({ signalId: s.id, account: 'sim' });
    } catch (e) {
      result = { ok: false, error: 'placeQuickFire threw: ' + e.message };
    }

    var entry = {
      sid: s.id,
      ticker: s.ticker,
      direction: s.direction,
      source: s.source,
      tier: tier,
      ok: result.ok,
      message: result.message,
      orderId: result.orderId,
      qty: result.qty,
      placedAt: new Date().toISOString(),
    };
    appendLog(entry);
    attempts.push(entry);

    if (result.ok) {
      slots.fires.push({ sid: s.id, tier: tier, ticker: s.ticker, source: s.source, placedAt: entry.placedAt });
      slots.byTier[tier] = (slots.byTier[tier] || 0) + 1;
      saveSlots(slots);

      // Confirmation push
      try {
        var hook = process.env.DISCORD_STRATUMSWING_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
        if (dp && hook) {
          await dp.send('unifiedSimAutoTrader', {
            username: 'Unified SIM Auto-Trader',
            embeds: [{
              title: '🟢 SIM Auto-Fire — ' + s.ticker + ' ' + (s.direction || '?').toUpperCase() + ' (' + tier + ')',
              color: 0x4caf50,
              fields: [
                { name: 'Source', value: s.source || '?', inline: true },
                { name: 'Account', value: result.account || 'SIM', inline: true },
                { name: 'Qty', value: String(result.qty || '?'), inline: true },
                { name: 'Tier slot', value: (slots.byTier[tier] || 0) + ' / ' + caps, inline: true },
                { name: 'Total today', value: slots.fires.length + ' / ' + TOTAL_CAP, inline: true },
                { name: 'Order', value: result.orderId ? 'id=' + result.orderId : 'no id returned', inline: false },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: 'Phase 4.56 unified · sid=' + (s.id || '?').slice(0, 12) },
            }],
          }, { webhook: hook });
        }
      } catch (pe) { console.error('[USAT] discord push fail:', pe.message); }
    }
  }

  return {
    ok: true,
    attempts: attempts,
    fires: (slots.fires || []).length,
    byTier: slots.byTier,
    cap: TOTAL_CAP,
  };
}

function getStatus() {
  var slots = loadSlots();
  return {
    date: slots.date,
    fires: slots.fires || [],
    byTier: slots.byTier || {},
    caps: { tier: TIER_CAPS, total: TOTAL_CAP },
    enabled: process.env.UNIFIED_SIM_AUTO_FIRE === 'true',
    inMarketHours: inMarketHours(),
    allowedSources: ALLOWED_SOURCES,
  };
}

function clearTodaySlots() {
  saveSlots({ date: todayET(), fires: [], byTier: {} });
  return { ok: true };
}

module.exports = {
  tick: tick,
  getStatus: getStatus,
  clearTodaySlots: clearTodaySlots,
  TIER_CAPS: TIER_CAPS,
  TOTAL_CAP: TOTAL_CAP,
};
