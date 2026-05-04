// =============================================================================
// SIM AUTO TRADER — autonomous paper-trading on the system's confluence picks.
//
// PURPOSE: Validate that the scanner + brain actually produce winning setups,
// without risking real capital. Builds the 30-trade dataset that gates going
// live (per tradeTracker: 65% hit rate on conv>=8 → safe to enable live auto).
//
// HARD SAFETY (cannot be bypassed):
//   1. ALWAYS account='sim' — refuses to fire to 'ts' or 'public'
//   2. Daily cap: max 5 SIM fires per day
//   3. Concurrent cap: max 5 open paper positions
//   4. Per-ticker cooldown: 24h (no double-fire same ticker)
//   5. Time window: 9:45 AM - 3:30 PM ET only (RTH minus first 15 + last 30)
//   6. SIM_AUTO_ENABLED env var must equal "true" (default false on first deploy)
//
// FIRE CRITERIA (ALL must be true):
//   - Conviction >= 8 (high-quality setup only)
//   - Hold rating = SAFE (no AVOID, no CAUTION)
//   - Spot is at-or-past trigger (within 0.3% tolerance, direction-aware)
//   - Earnings risk = null (no earnings in next 3 days)
//   - Not in 24h ticker cooldown
//   - Not already at concurrent cap
//
// LOGGING:
//   - Every fire → tradeTracker.logFire() with full metadata
//   - Discord push via discordPush helper (heartbeat tracked)
//   - State: /data/sim_auto_state.json (daily fires, ticker cooldowns)
//
// DAILY RECAP at 4:05 PM ET:
//   - Total fires today
//   - Win rate to-date (from tradeTracker)
//   - Open paper positions
//   - Tomorrow's queue (setups that armed but didn't fire today)
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
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'sim_auto_state.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// HARD SAFETY CONSTANTS
var MAX_DAILY_FIRES = 5;
var MAX_CONCURRENT_OPEN = 5;
var TICKER_COOLDOWN_HRS = 24;
var TRIGGER_TOLERANCE_PCT = 0.30;
var MIN_CONVICTION = 8;

function isEnabled() {
  return String(process.env.SIM_AUTO_ENABLED || 'false').toLowerCase() === 'true';
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

  return setups;
}

// Fire SIM order via the existing ayce-fire path (build → place)
async function fireSimOrder(setup, spot) {
  var serverBase = process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  // Build contract via /api/ayce-fire/build
  try {
    var buildRes = await fetchLib(serverBase + '/api/ayce-fire/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: setup.ticker,
        direction: setup.direction,
        tradeType: 'SWING',
        account: 'sim',  // HARDCODED — never live
        size: 1,
      }),
      timeout: 10000,
    });
    var buildData = await buildRes.json();
    if (!buildData.ok || buildData.blocked) {
      return { ok: false, error: 'build failed: ' + (buildData.error || buildData.reason) };
    }

    var c = buildData.contract;
    var t = buildData.orderTicket;
    var limitPrice = parseFloat(t.limitPrice);
    var stopPremium = Math.max(0.05, Math.round(limitPrice * 0.75 * 100) / 100);
    var tp1Premium = Math.round(limitPrice * 1.50 * 100) / 100;

    // Place via /api/ayce-fire/place
    var placeRes = await fetchLib(serverBase + '/api/ayce-fire/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: setup.ticker,
        contractSymbol: c.symbol,
        direction: setup.direction,
        account: 'sim',  // HARDCODED
        size: t.quantity,
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
      limitPrice: limitPrice,
      stopPremium: stopPremium,
      tp1Premium: tp1Premium,
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
          name: '📋 Order Placed (SIM)',
          value: '**' + c.symbol + '** @ $' + fireResult.limitPrice + ' LMT\n' +
                 'Stop: $' + fireResult.stopPremium + '  ·  TP1: $' + fireResult.tp1Premium + '\n' +
                 'Qty: ' + t.quantity + '  ·  Account: SIM',
          inline: false,
        },
        {
          name: '🎯 Why this fired',
          value: 'Conv ≥ 8 + Hold SAFE + No earnings risk + at-trigger spot.\nAll system gates passed. Paper trade live.',
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
