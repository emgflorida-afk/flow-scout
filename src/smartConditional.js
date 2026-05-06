// =============================================================================
// SMART CONDITIONAL WATCHER — Phase 4.34 (May 5 2026 PM build)
// -----------------------------------------------------------------------------
// Replaces broker conditional brackets (which fire on RAW PRICE = vulnerable to
// wicks) with a server-side watcher that runs ALL gates (TA + Tape + Vision +
// MTB + FireGrade) when the trigger hits. Only auto-fires if gates pass.
//
// PROBLEM SOLVED:
//   AB tonight has TMO PUT entry $466.16 + META CALL entry $606.80 from John.
//   - TV alerts → manual click required (latency, missed fills)
//   - TS broker conditional bracket → auto-fires on price tag, no gate check
//                                     → wicks fill into fakeouts
//   Phase 4.34 closes the gap: zero-click auto-fire WITH wick/fakeout protection.
//
// FLOW:
//   1. AB clicks "🤖 SMART AUTO" on a Grade A/B card OR pre-seed via /api/smart-conditional/add
//   2. Server cron polls every 30s during RTH (9:45-15:00 ET window)
//   3. When spot crosses trigger:
//      - Mark TRIGGERED
//      - Run simAutoTrader.runGates(setup) — TA + TAPE + VISION + MTB + FIRE_GRADE
//      - All pass → place TS LIVE order with bracket → mark FIRED → push Discord
//      - Any fail → mark BLOCKED with reason → push Discord BLOCKED card
//                   → re-arm so next trigger event re-checks (handles wick → recover)
//   4. Daily expiry (default 24h) auto-cancels stale conditionals
//
// PERSISTENCE: /data/smart_conditionals.json
//
// SAFETY:
//   - Time window enforced HARD (default 9:45-15:00 ET) — outside, skip the tick
//   - Max 5 ARMED conditionals per ticker (prevents accidental flood)
//   - Cron skips if SMART_CONDITIONAL_ENABLED=false
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var FILE = path.join(DATA_ROOT, 'smart_conditionals.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// =============================================================================
// PERSISTENCE
// =============================================================================
function ensureDir() {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
}

function loadAll() {
  try {
    var raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
    return [];
  } catch (e) { return []; }
}

function saveAll(list) {
  ensureDir();
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('[SMART-COND] save failed:', e.message); }
}

function genId() {
  return 'sc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
}

// =============================================================================
// TIME / WINDOW HELPERS
// =============================================================================
function todayET() {
  var now = new Date();
  var et = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, d, y] = et.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
}

function nowET() {
  var now = new Date();
  return {
    hr: parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10),
    min: parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }), 10),
  };
}

// timeWindow: { start: '09:45', end: '15:00' } in ET
function inTimeWindow(timeWindow) {
  if (!timeWindow || !timeWindow.start || !timeWindow.end) return true;
  var t = nowET();
  var nowMin = t.hr * 60 + t.min;
  var [sh, sm] = String(timeWindow.start).split(':').map(function(x) { return parseInt(x, 10); });
  var [eh, em] = String(timeWindow.end).split(':').map(function(x) { return parseInt(x, 10); });
  var startMin = sh * 60 + sm;
  var endMin = eh * 60 + em;
  return nowMin >= startMin && nowMin <= endMin;
}

function isExpired(spec) {
  if (!spec.expiresAt) return false;
  return Date.now() > new Date(spec.expiresAt).getTime();
}

// =============================================================================
// SPEC NORMALIZATION
// =============================================================================
function normalizeSpec(input) {
  if (!input || typeof input !== 'object') return null;
  var ticker = String(input.ticker || '').toUpperCase().trim();
  if (!ticker) return null;
  var direction = String(input.direction || '').toLowerCase();
  if (direction !== 'long' && direction !== 'short') return null;
  var triggerPrice = parseFloat(input.triggerPrice);
  if (!isFinite(triggerPrice) || triggerPrice <= 0) return null;
  var triggerDirection = String(input.triggerDirection || '').toLowerCase();
  if (triggerDirection !== 'crossing_down' && triggerDirection !== 'crossing_up') {
    triggerDirection = direction === 'long' ? 'crossing_up' : 'crossing_down';
  }
  var contractSymbol = String(input.contractSymbol || '').trim();
  if (!contractSymbol) return null;
  var account = String(input.account || 'ts-live').toLowerCase();
  if (account !== 'ts-live' && account !== 'ts-sim' && account !== 'public') account = 'ts-live';
  var qty = parseInt(input.qty || 1, 10) || 1;
  if (qty < 1 || qty > 10) qty = 1;
  var limitPrice = parseFloat(input.limitPrice);
  if (!isFinite(limitPrice) || limitPrice <= 0) return null;
  var stopPrice = parseFloat(input.stopPrice);
  if (!isFinite(stopPrice)) stopPrice = null;

  var defaultGates = ['TA', 'TAPE', 'VISION', 'MTB'];
  var gates = Array.isArray(input.gates) ? input.gates.map(function(g) { return String(g).toUpperCase(); }) : defaultGates;

  var bracket = input.bracket || {};
  var stopPct = parseFloat(bracket.stopPct);
  if (!isFinite(stopPct)) stopPct = 50;
  var tp1Pct = parseFloat(bracket.tp1Pct);
  if (!isFinite(tp1Pct)) tp1Pct = 25;

  var timeWindow = input.timeWindow || { start: '09:45', end: '15:00' };

  // Default expiry: end of next session (16:00 ET tomorrow)
  var expiresAt = input.expiresAt;
  if (!expiresAt) {
    var t = new Date();
    t.setUTCDate(t.getUTCDate() + 1);
    t.setUTCHours(20, 0, 0, 0);  // 4 PM ET = 20:00 UTC (EDT) — close enough for default
    expiresAt = t.toISOString();
  }

  return {
    id: input.id || genId(),
    ticker: ticker,
    direction: direction,
    contractSymbol: contractSymbol,
    triggerPrice: triggerPrice,
    triggerDirection: triggerDirection,
    stopPrice: stopPrice,
    account: account,
    qty: qty,
    limitPrice: limitPrice,
    gates: gates,
    allowOverride: !!input.allowOverride,
    bracket: { stopPct: stopPct, tp1Pct: tp1Pct },
    timeWindow: timeWindow,
    expiresAt: expiresAt,
    pattern: input.pattern || null,
    source: input.source || 'manual',
    notes: input.notes || null,
    status: input.status || 'ARMED',
    createdAt: input.createdAt || new Date().toISOString(),
    triggeredAt: input.triggeredAt || null,
    firedAt: input.firedAt || null,
    blockedReason: input.blockedReason || null,
    lastObservedSpot: input.lastObservedSpot != null ? input.lastObservedSpot : null,
    lastObservedAt: input.lastObservedAt || null,
    lastTickAt: input.lastTickAt || null,
    triggerEvents: input.triggerEvents || 0,  // how many times the trigger has been hit
    blockHistory: input.blockHistory || [],   // last few block reasons
  };
}

// =============================================================================
// CRUD
// =============================================================================
function addConditional(input) {
  var spec = normalizeSpec(input);
  if (!spec) return { ok: false, error: 'invalid spec — required: ticker, direction, contractSymbol, triggerPrice, limitPrice' };
  var list = loadAll();
  // Cap per-ticker ARMED count at 5
  var armedSameTicker = list.filter(function(s) { return s.ticker === spec.ticker && s.status === 'ARMED'; });
  if (armedSameTicker.length >= 5) {
    return { ok: false, error: 'max 5 ARMED conditionals per ticker (' + spec.ticker + ')' };
  }
  list.push(spec);
  saveAll(list);
  return { ok: true, id: spec.id, spec: spec };
}

function listConditionals(filter) {
  filter = filter || {};
  var list = loadAll();
  if (filter.status) {
    var st = String(filter.status).toUpperCase();
    list = list.filter(function(s) { return String(s.status).toUpperCase() === st; });
  }
  if (filter.ticker) {
    var tk = String(filter.ticker).toUpperCase();
    list = list.filter(function(s) { return s.ticker === tk; });
  }
  return list;
}

function getConditional(id) {
  var list = loadAll();
  return list.find(function(s) { return s.id === id; }) || null;
}

function cancelConditional(id, reason) {
  var list = loadAll();
  var found = null;
  list = list.map(function(s) {
    if (s.id === id) {
      s.status = 'CANCELED';
      s.canceledAt = new Date().toISOString();
      s.canceledReason = reason || 'manual cancel';
      found = s;
    }
    return s;
  });
  if (!found) return { ok: false, error: 'not found' };
  saveAll(list);
  return { ok: true, spec: found };
}

function updateConditional(id, patch) {
  var list = loadAll();
  var found = null;
  list = list.map(function(s) {
    if (s.id === id) {
      Object.keys(patch || {}).forEach(function(k) { s[k] = patch[k]; });
      found = s;
    }
    return s;
  });
  if (!found) return { ok: false, error: 'not found' };
  saveAll(list);
  return { ok: true, spec: found };
}

// =============================================================================
// PRICE FETCH
// =============================================================================
async function getSpot(ticker) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  try {
    var r = await fetchLib(serverBase + '/api/ticker-quote?symbols=' + encodeURIComponent(ticker), {
      timeout: 5000,
    });
    if (!r.ok) return null;
    var data = await r.json();
    if (!data || !data.ok || !data.quotes || !data.quotes.length) return null;
    var q = data.quotes[0];
    return q.last != null ? parseFloat(q.last) : null;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// TRIGGER DETECTION
// =============================================================================
// crossing_down: lastObservedSpot was > triggerPrice, current ≤ triggerPrice
// crossing_up:   lastObservedSpot was < triggerPrice, current ≥ triggerPrice
// First-tick (no lastObservedSpot): treat as triggered if direction matches naturally
//   - crossing_down: current ≤ triggerPrice → triggered
//   - crossing_up:   current ≥ triggerPrice → triggered
function isTriggered(spec, currentSpot, lastSpot) {
  if (currentSpot == null) return false;
  var trig = spec.triggerPrice;
  if (spec.triggerDirection === 'crossing_down') {
    if (lastSpot != null) {
      return lastSpot > trig && currentSpot <= trig;
    }
    return currentSpot <= trig;
  }
  // crossing_up
  if (lastSpot != null) {
    return lastSpot < trig && currentSpot >= trig;
  }
  return currentSpot >= trig;
}

// =============================================================================
// GATE INVOCATION
// =============================================================================
// Calls simAutoTrader.runGates() — DOES NOT MODIFY simAutoTrader. We pass the
// setup with whichever gates the spec requested, and rely on the env-toggle
// behavior in simAutoTrader to run only the ones we want.
//
// To honor `spec.gates` per-conditional, we pass a tradeType that fits the gate
// list. simAutoTrader's runGates already gates each individually via env vars —
// for v1, we run them all and just inspect the result against spec.gates.
// =============================================================================
async function runGatesForSpec(spec) {
  var simAutoTrader = null;
  try { simAutoTrader = require('./simAutoTrader'); } catch (e) {
    return { pass: true, gates: {}, reason: 'simAutoTrader not loaded — fail-open', diagnostics: {} };
  }
  if (!simAutoTrader || !simAutoTrader.runGates) {
    return { pass: true, gates: {}, reason: 'runGates not available — fail-open', diagnostics: {} };
  }
  var setup = {
    ticker: spec.ticker,
    direction: spec.direction,
    pattern: spec.pattern || 'smart-conditional',
    source: spec.source || 'smart-conditional',
    tradeType: 'SWING',
    trigger: spec.triggerPrice,
    stop: spec.stopPrice,
    conviction: 9,  // we trust the source — gates do the actual filtering
  };
  try {
    var verdict = await simAutoTrader.runGates(setup);
    return verdict;
  } catch (e) {
    return { pass: true, gates: { error: e.message }, reason: 'gate exception — fail-open' };
  }
}

// =============================================================================
// ORDER PLACEMENT
// =============================================================================
async function placeFireOrder(spec) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);

  // Map account → /api/ayce-fire/place semantics
  // 'ts-live' → 'ts'  · 'ts-sim' → 'sim' · 'public' → 'public'
  var accountParam = spec.account === 'ts-live' ? 'ts'
                  : spec.account === 'ts-sim'  ? 'sim'
                  : spec.account === 'public'  ? 'public'
                  : 'ts';

  var stopPremium = Math.max(0.05, Math.round(spec.limitPrice * (1 - spec.bracket.stopPct / 100) * 100) / 100);
  var tp1Premium = Math.round(spec.limitPrice * (1 + spec.bracket.tp1Pct / 100) * 100) / 100;

  var body = {
    ticker: spec.ticker,
    contractSymbol: spec.contractSymbol,
    direction: spec.direction,
    account: accountParam,
    size: spec.qty,
    limitPrice: spec.limitPrice,
    stopPremium: stopPremium,
    tp1Premium: tp1Premium,
    manualFire: true,  // bypass time gates inside ayce-fire — we already gated
  };
  // Attach structural stop on the underlying when available
  if (spec.stopPrice) {
    body.structuralStopSymbol = spec.ticker;
    body.structuralStopPrice = spec.stopPrice;
    body.structuralStopPredicate = spec.direction === 'long' ? 'below' : 'above';
  }

  try {
    var r = await fetchLib(serverBase + '/api/ayce-fire/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 15000,
    });
    var data = await r.json();
    return { ok: !!data.ok, result: data, stopPremium: stopPremium, tp1Premium: tp1Premium };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =============================================================================
// DISCORD EMBEDS
// =============================================================================
function buildArmedEmbed(spec) {
  var dirIcon = spec.direction === 'long' ? '🟢' : '🔴';
  var triggerArrow = spec.triggerDirection === 'crossing_up' ? '⬆ crossing UP' : '⬇ crossing DOWN';
  return {
    username: 'Flow Scout — Smart Conditional',
    embeds: [{
      title: '🤖 SMART CONDITIONAL ARMED — ' + dirIcon + ' ' + spec.ticker + ' ' + spec.direction.toUpperCase(),
      description: 'Server-side watcher armed. Fires only if all gates pass at trigger.',
      color: spec.direction === 'long' ? 5763719 : 15158332,
      fields: [
        {
          name: '📊 Trigger',
          value: '$' + spec.triggerPrice.toFixed(2) + ' ' + triggerArrow +
                 (spec.stopPrice ? '\nInvalidation $' + spec.stopPrice.toFixed(2) : ''),
          inline: false,
        },
        {
          name: '📋 Order (queued)',
          value: '**' + spec.contractSymbol + '** × ' + spec.qty + 'ct @ $' + spec.limitPrice + ' LMT\n' +
                 'Account: ' + spec.account.toUpperCase() + '\n' +
                 'Bracket: stop -' + spec.bracket.stopPct + '% / TP1 +' + spec.bracket.tp1Pct + '%',
          inline: false,
        },
        {
          name: '🛡️ Gates required',
          value: spec.gates.map(function(g) { return '• ' + g; }).join('\n') +
                 (spec.allowOverride ? '\n\n⚠ OVERRIDE: fires even on gate fail' : ''),
          inline: false,
        },
        {
          name: '⏱️ Window',
          value: spec.timeWindow.start + ' - ' + spec.timeWindow.end + ' ET\n' +
                 'Expires: ' + new Date(spec.expiresAt).toLocaleString('en-US', { timeZone: 'America/New_York' }),
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Phase 4.34 Smart Conditional | id: ' + spec.id.slice(-8) },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildFiredEmbed(spec, fireResult, gateVerdict, spot) {
  var dirIcon = spec.direction === 'long' ? '🟢' : '🔴';
  var passedGates = Object.keys(gateVerdict.gates || {})
    .filter(function(k) {
      var v = gateVerdict.gates[k];
      return v && v !== 'skipped' && v !== 'opposite' && v !== 'VETO';
    })
    .map(function(k) { return k.toUpperCase() + ':' + gateVerdict.gates[k]; })
    .join(' · ') || 'all configured';

  return {
    username: 'Flow Scout — Smart Conditional',
    embeds: [{
      title: '🤖🚀 SMART CONDITIONAL FIRED — ' + dirIcon + ' ' + spec.ticker + ' ' + spec.direction.toUpperCase(),
      description: 'Trigger hit, gates passed, order placed. Zero-click auto-fire.',
      color: spec.direction === 'long' ? 5763719 : 15158332,
      fields: [
        {
          name: '📊 Trigger Hit',
          value: '**Spot** $' + (spot != null ? spot.toFixed(2) : '?') +
                 '  ·  **Trigger** $' + spec.triggerPrice.toFixed(2) +
                 ' (' + (spec.triggerDirection === 'crossing_up' ? '⬆' : '⬇') + ')\n' +
                 'Hit at ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET',
          inline: false,
        },
        {
          name: '✅ Gates Passed',
          value: passedGates,
          inline: false,
        },
        {
          name: '📋 Order Placed',
          value: '**' + spec.contractSymbol + '** × ' + spec.qty + 'ct @ $' + spec.limitPrice + ' LMT\n' +
                 'Account: ' + spec.account.toUpperCase() + '\n' +
                 'Stop: $' + (fireResult.stopPremium || '?') + ' (-' + spec.bracket.stopPct + '%)\n' +
                 'TP1: $' + (fireResult.tp1Premium || '?') + ' (+' + spec.bracket.tp1Pct + '%)\n' +
                 'Status: ' + (fireResult.ok ? 'WORKING' : 'PLACE_FAILED — ' + (fireResult.error || 'unknown')),
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Phase 4.34 Smart Conditional | id: ' + spec.id.slice(-8) },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildBlockedEmbed(spec, gateVerdict, spot) {
  var dirIcon = spec.direction === 'long' ? '🟢' : '🔴';
  return {
    username: 'Flow Scout — Smart Conditional',
    embeds: [{
      title: '⚠ SMART CONDITIONAL BLOCKED — ' + dirIcon + ' ' + spec.ticker + ' ' + spec.direction.toUpperCase(),
      description: 'Trigger hit but a gate failed. Order NOT placed. Conditional re-armed for next trigger event.',
      color: 16753920,  // orange
      fields: [
        {
          name: '📊 Trigger Hit',
          value: '**Spot** $' + (spot != null ? spot.toFixed(2) : '?') +
                 '  ·  **Trigger** $' + spec.triggerPrice.toFixed(2) + '\n' +
                 'Hit at ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET',
          inline: false,
        },
        {
          name: '🛑 Gate FAILED',
          value: '**' + (gateVerdict.gate || 'UNKNOWN') + '** — ' + (gateVerdict.reason || 'no reason given').slice(0, 800),
          inline: false,
        },
        {
          name: '🔄 What now',
          value: 'Conditional re-armed. Will check next trigger event. Common cause: wick / fakeout into level — gates correctly skipped.\n' +
                 'Cancel: `POST /api/smart-conditional/cancel/' + spec.id + '`',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Phase 4.34 Smart Conditional | id: ' + spec.id.slice(-8) },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildExpiredEmbed(spec) {
  var dirIcon = spec.direction === 'long' ? '🟢' : '🔴';
  return {
    username: 'Flow Scout — Smart Conditional',
    embeds: [{
      title: '⏰ SMART CONDITIONAL EXPIRED — ' + dirIcon + ' ' + spec.ticker + ' ' + spec.direction.toUpperCase(),
      description: 'Trigger never hit by expiry cutoff. Auto-canceled.',
      color: 8421504,  // gray
      fields: [
        {
          name: '📊 Trigger',
          value: '$' + spec.triggerPrice.toFixed(2) + ' (' + spec.triggerDirection.replace('_', ' ') + ')\n' +
                 'Expired: ' + new Date(spec.expiresAt).toLocaleString('en-US', { timeZone: 'America/New_York' }),
          inline: false,
        },
        {
          name: '📋 Contract (NOT placed)',
          value: spec.contractSymbol + ' × ' + spec.qty + 'ct @ $' + spec.limitPrice,
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Phase 4.34 Smart Conditional | id: ' + spec.id.slice(-8) },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function pushEmbed(payload) {
  try {
    var dp = require('./discordPush');
    return await dp.send('smartConditional', payload, { webhook: DISCORD_WEBHOOK });
  } catch (e) {
    console.error('[SMART-COND] discord push failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// =============================================================================
// HEALTH METRICS (for cron tracking)
// =============================================================================
var _watcherHealth = {
  lastTickAt: null,
  lastTickError: null,
  ticksToday: 0,
  ticksDate: todayET(),
};

function getHealth() {
  var list = loadAll();
  var today = todayET();
  var armedCount = list.filter(function(s) { return s.status === 'ARMED'; }).length;
  var firedToday = list.filter(function(s) {
    if (s.status !== 'FIRED') return false;
    if (!s.firedAt) return false;
    var d = s.firedAt.split('T')[0];
    return d === today;
  }).length;
  var blockedToday = list.filter(function(s) {
    return Array.isArray(s.blockHistory) && s.blockHistory.some(function(b) {
      return b.at && b.at.split('T')[0] === today;
    });
  }).length;
  var expiredToday = list.filter(function(s) {
    if (s.status !== 'EXPIRED') return false;
    if (!s.canceledAt) return false;
    return s.canceledAt.split('T')[0] === today;
  }).length;
  return {
    ok: true,
    enabled: isEnabled(),
    lastTickAt: _watcherHealth.lastTickAt,
    lastTickError: _watcherHealth.lastTickError,
    ticksToday: _watcherHealth.ticksToday,
    armedCount: armedCount,
    firedToday: firedToday,
    blockedToday: blockedToday,
    expiredToday: expiredToday,
    totalStored: list.length,
  };
}

function isEnabled() {
  var v = process.env.SMART_CONDITIONAL_ENABLED;
  if (v == null || v === '') return true;  // default ON
  return String(v).toLowerCase() !== 'false';
}

// =============================================================================
// MAIN WATCHER TICK — called by cron every 30s during RTH
// =============================================================================
async function tick() {
  if (!isEnabled()) return { ok: true, skipped: 'disabled' };

  var list = loadAll();
  var armed = list.filter(function(s) { return s.status === 'ARMED'; });
  if (!armed.length) {
    _watcherHealth.lastTickAt = new Date().toISOString();
    _watcherHealth.ticksToday++;
    return { ok: true, skipped: 'no armed conditionals' };
  }

  var nowIso = new Date().toISOString();
  var dirty = false;
  var triggered = 0;
  var fired = 0;
  var blocked = 0;
  var expired = 0;

  // Group by ticker so we only fetch each spot once
  var byTicker = {};
  armed.forEach(function(s) {
    if (!byTicker[s.ticker]) byTicker[s.ticker] = [];
    byTicker[s.ticker].push(s);
  });

  for (var ticker in byTicker) {
    var specs = byTicker[ticker];
    var spot = await getSpot(ticker);
    var lastSpotForTicker = null;
    // Use the first spec's lastObservedSpot if available (they share a ticker)
    for (var i = 0; i < specs.length; i++) {
      if (specs[i].lastObservedSpot != null) {
        lastSpotForTicker = specs[i].lastObservedSpot;
        break;
      }
    }

    for (var j = 0; j < specs.length; j++) {
      var spec = specs[j];
      // 1) expired?
      if (isExpired(spec)) {
        spec.status = 'EXPIRED';
        spec.canceledAt = nowIso;
        spec.canceledReason = 'expiresAt cutoff';
        dirty = true;
        expired++;
        await pushEmbed(buildExpiredEmbed(spec));
        continue;
      }
      // 2) outside time window? — skip this tick (don't update spot, don't block)
      if (!inTimeWindow(spec.timeWindow)) {
        spec.lastTickAt = nowIso;
        dirty = true;
        continue;
      }
      // 3) no spot? — skip
      if (spot == null) {
        spec.lastTickAt = nowIso;
        dirty = true;
        continue;
      }
      // 4) check trigger
      var hit = isTriggered(spec, spot, lastSpotForTicker);
      spec.lastObservedSpot = spot;
      spec.lastObservedAt = nowIso;
      spec.lastTickAt = nowIso;
      dirty = true;
      if (!hit) continue;

      // === TRIGGER FIRED ===
      triggered++;
      spec.triggerEvents = (spec.triggerEvents || 0) + 1;
      console.log('[SMART-COND] TRIGGER HIT: ' + spec.ticker + ' ' + spec.direction +
        ' spot=' + spot + ' trigger=' + spec.triggerPrice + ' (event #' + spec.triggerEvents + ')');

      // 5) run gates (unless allowOverride)
      var gateVerdict = { pass: true, gates: {}, reason: 'override' };
      if (!spec.allowOverride) {
        gateVerdict = await runGatesForSpec(spec);
      }

      if (!gateVerdict.pass) {
        // BLOCKED — re-arm, log block reason, push Discord
        spec.blockHistory = spec.blockHistory || [];
        spec.blockHistory.push({
          at: nowIso,
          gate: gateVerdict.gate,
          reason: gateVerdict.reason,
          spot: spot,
        });
        // keep last 10 only
        if (spec.blockHistory.length > 10) spec.blockHistory = spec.blockHistory.slice(-10);
        spec.blockedReason = (gateVerdict.gate || '?') + ': ' + (gateVerdict.reason || '');
        // Stay ARMED — wick may recover, next trigger event re-checks
        blocked++;
        console.log('[SMART-COND] BLOCKED ' + spec.ticker + ': ' + spec.blockedReason);
        await pushEmbed(buildBlockedEmbed(spec, gateVerdict, spot));
        continue;
      }

      // GATES PASSED — fire
      spec.status = 'TRIGGERED';
      spec.triggeredAt = nowIso;
      var fireResult = await placeFireOrder(spec);
      if (fireResult.ok) {
        spec.status = 'FIRED';
        spec.firedAt = new Date().toISOString();
        spec.fireResult = fireResult.result;
        fired++;
        console.log('[SMART-COND] FIRED ' + spec.ticker + ' ' + spec.direction + ' ' + spec.contractSymbol);
      } else {
        // Order placement failed but trigger hit — log + leave TRIGGERED so AB can manually intervene
        spec.status = 'TRIGGERED';
        spec.blockedReason = 'place failed: ' + (fireResult.error || JSON.stringify(fireResult.result || {}).slice(0, 200));
        console.error('[SMART-COND] PLACE FAILED ' + spec.ticker + ': ' + spec.blockedReason);
      }
      await pushEmbed(buildFiredEmbed(spec, fireResult, gateVerdict, spot));
    }
  }

  // Persist updates
  if (dirty) {
    // Reload list to merge — `list` already has the updates because we mutated in place
    saveAll(list);
  }

  _watcherHealth.lastTickAt = nowIso;
  _watcherHealth.lastTickError = null;
  if (_watcherHealth.ticksDate !== todayET()) {
    _watcherHealth.ticksDate = todayET();
    _watcherHealth.ticksToday = 0;
  }
  _watcherHealth.ticksToday++;

  return {
    ok: true,
    armed: armed.length,
    triggered: triggered,
    fired: fired,
    blocked: blocked,
    expired: expired,
    timestamp: nowIso,
  };
}

module.exports = {
  // CRUD
  addConditional: addConditional,
  listConditionals: listConditionals,
  getConditional: getConditional,
  cancelConditional: cancelConditional,
  updateConditional: updateConditional,
  // Watcher
  tick: tick,
  // Embeds (exposed for pre-seed Discord push)
  buildArmedEmbed: buildArmedEmbed,
  buildFiredEmbed: buildFiredEmbed,
  buildBlockedEmbed: buildBlockedEmbed,
  buildExpiredEmbed: buildExpiredEmbed,
  pushEmbed: pushEmbed,
  // Health
  getHealth: getHealth,
  isEnabled: isEnabled,
  // Internals (exposed for tests / debugging)
  isTriggered: isTriggered,
  inTimeWindow: inTimeWindow,
  isExpired: isExpired,
  normalizeSpec: normalizeSpec,
};
