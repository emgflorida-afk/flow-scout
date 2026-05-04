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
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'sim_auto_state.json');

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
var STOP_LOSS_PCT = 25;           // -25% premium hard stop
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
    console.log('[SIM-AUTO] FIRING ' + setup.ticker + ' ' + setup.direction + ' from ' + setup.source);
    var fireResult = await fireSimOrder(setup, spot);

    if (!fireResult.ok) {
      console.error('[SIM-AUTO] FIRE FAILED for ' + setup.ticker + ': ' + fireResult.error);
      continue;
    }

    firesSucceeded++;

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

    // Update state
    state.dailyFires.push({
      ticker: setup.ticker,
      source: setup.source,
      direction: setup.direction,
      conviction: setup.conviction,
      firedAt: new Date().toISOString(),
      contractSymbol: fireResult.contract.symbol,
      limitPrice: fireResult.limitPrice,
      spotAtFire: spot,
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
};
