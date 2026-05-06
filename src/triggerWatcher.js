// =============================================================================
// TRIGGER WATCHER — semi-auto approval queue for ARMED setups across all scanners
//
// FILLS A GAP IN THE SYSTEM:
//   The autoFireEngine only fires on A++ tier (rare). The AYCE / JS / WP scans
//   populate dashboards but don't notify when setups HIT THEIR TRIGGER LIVE.
//
//   Result: AB sets manual TV alerts on 5-10 names, can't watch them all,
//           "sits hand" while triggers fire on tickers he wasn't watching.
//
// WHAT IT DOES:
//   1. Cron polls every 3 min during RTH (9:30 - 3:55 ET)
//   2. Cross-references AYCE armed + JS conv >= 8 + WP ready (conv >= 8) setups
//   3. Pulls live quote for each ticker
//   4. Detects if spot is AT or PAST trigger (with 0.3% tolerance)
//   5. Pushes Discord card with FIRE button URL for one-click execution
//   6. 15-min cooldown per ticker (avoid spam)
//
// THIS IS THE "approval queue" AB asked for — system surfaces setups that
// ARE ACTIVELY FIRING and AB clicks to approve/place via FIRE button.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var ayceScanner = null;
try { ayceScanner = require('./ayceScanner'); } catch (e) {}
var johnPatternScanner = null;
try { johnPatternScanner = require('./johnPatternScanner'); } catch (e) {}
var dailyCoilScanner = null;
try { dailyCoilScanner = require('./dailyCoilScanner'); } catch (e) {}
var wpScanner = null;
try { wpScanner = require('./wpScanner'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var COOLDOWN_FILE = path.join(DATA_ROOT, 'trigger_cooldown.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';
var COOLDOWN_MIN = 15;
var TRIGGER_TOLERANCE_PCT = 0.30;  // 0.30% from trigger = "near or past"

function loadCooldown() {
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveCooldown(map) {
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(map, null, 2)); } catch (e) {}
}

function isInCooldown(ticker, strategy) {
  var key = ticker + ':' + strategy;
  var map = loadCooldown();
  var last = map[key];
  if (!last) return false;
  var ageMin = (Date.now() - new Date(last).getTime()) / 60000;
  return ageMin < COOLDOWN_MIN;
}
function markCooldown(ticker, strategy) {
  var key = ticker + ':' + strategy;
  var map = loadCooldown();
  map[key] = new Date().toISOString();
  saveCooldown(map);
}

// Pull live quote via TS API
async function getLiveQuote(ticker, token) {
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

// Check if spot is AT or PAST trigger (within tolerance)
function isAtTrigger(spot, trigger, direction) {
  if (!spot || !trigger) return false;
  var diff = spot - trigger;
  var tolPct = trigger * (TRIGGER_TOLERANCE_PCT / 100);
  if (direction === 'long') {
    // For long: spot >= trigger (within tolerance) = fire zone
    return diff >= -tolPct;
  } else {
    // For short: spot <= trigger (within tolerance)
    return diff <= tolPct;
  }
}

// Aggregate all ARMED setups across scanners
async function collectArmedSetups() {
  var setups = [];

  // 1. AYCE strategies (Failed-9, Miyagi, etc.)
  if (ayceScanner) {
    try {
      var ayceData = ayceScanner.loadLast();
      var hits = (ayceData && ayceData.hits) || [];
      hits.forEach(function(h) {
        (h.strategies || []).forEach(function(s) {
          if (['armed', 'live-armed', 'live-fired'].indexOf(s.status) >= 0 &&
              s.trigger && s.direction && s.direction !== 'pending-sweep') {
            setups.push({
              ticker: h.ticker,
              source: 'AYCE-' + s.name,
              strategy: s.name,
              direction: s.direction,
              trigger: parseFloat(s.trigger),
              stop: parseFloat(s.stop),
              T1: parseFloat(s.T1),
              T2: parseFloat(s.T2),
              thesis: s.thesis,
            });
          }
        });
      });
    } catch (e) { console.log('[TRIGGER-WATCH] AYCE error:', e.message); }
  }

  // 2. JS scanner (Strat patterns conv >= 8)
  if (johnPatternScanner) {
    try {
      var jsData = johnPatternScanner.loadLast();
      var ready = (jsData && jsData.ready) || [];
      ready.forEach(function(r) {
        if ((r.conviction || 0) >= 8 && r.triggerPrice && r.direction) {
          setups.push({
            ticker: r.ticker,
            source: 'JS-' + (r.tf || '?'),
            strategy: r.pattern,
            direction: r.direction,
            trigger: parseFloat(r.triggerPrice),
            stop: parseFloat(r.stopPrice),
            T1: parseFloat(r.tp1),
            T2: parseFloat(r.tp2),
            thesis: 'JS ' + r.pattern + ' on ' + r.tf + ' conv ' + r.conviction,
          });
        }
      });
    } catch (e) { console.log('[TRIGGER-WATCH] JS error:', e.message); }
  }

  // 3. Coil scanner (daily coil patterns conv >= 8)
  if (dailyCoilScanner) {
    try {
      var coilData = dailyCoilScanner.loadLast();
      var coilReady = (coilData && coilData.ready) || [];
      coilReady.forEach(function(r) {
        if ((r.conviction || 0) >= 8 && r.triggerPrice && r.direction && r.direction !== 'neutral') {
          setups.push({
            ticker: r.ticker,
            source: 'COIL',
            strategy: r.pattern,
            direction: r.direction,
            trigger: parseFloat(r.triggerPrice),
            stop: parseFloat(r.stopPrice),
            T1: parseFloat(r.tp1),
            T2: parseFloat(r.tp2),
            thesis: 'COIL ' + r.pattern + ' conv ' + r.conviction,
          });
        }
      });
    } catch (e) { console.log('[TRIGGER-WATCH] COIL error:', e.message); }
  }

  return setups;
}

// Push Discord card with FIRE link
// PHASE 4.52 — uses unified discordCardBuilder.buildEntryCard so the trigger
// alert carries SIM/LIVE FIRE buttons just like MEGA cards.
async function pushTriggerAlert(setup, spot) {
  var card;
  try {
    var cb = require('./discordCardBuilder');
    card = cb.buildEntryCard({
      source: 'trigger',
      tier: 'scalp',
      ticker: setup.ticker,
      direction: setup.direction,
      stockSpot: spot,
      contract: setup.contract || null,
      bracket: {
        entry: setup.trigger,
        tp1: isFinite(setup.T1) ? setup.T1 : null,
        tp2: isFinite(setup.T2) ? setup.T2 : null,
        stop: isFinite(setup.stop) ? setup.stop : null,
        stopSource: 'trigger',
        holdRule: setup.thesis || setup.strategy || 'see card',
      },
      scannerSetup: setup.source + ' / ' + setup.strategy,
      ttlMin: 30,
    });
  } catch (e) {
    console.error('[TRIGGER-WATCH] cardBuilder failed, falling back:', e.message);
    var dirIcon = setup.direction === 'long' ? '🟢' : '🔴';
    card = {
      username: 'Flow Scout — Trigger Watch',
      embeds: [{
        title: dirIcon + ' ' + setup.ticker + ' — ' + setup.source + ' AT TRIGGER',
        description: '**' + setup.ticker + ' at $' + spot.toFixed(2) + '** trigger $' + setup.trigger.toFixed(2),
        color: setup.direction === 'long' ? 5763719 : 15158332,
        fields: [
          { name: '📊 Levels', value: '🎯 Trigger $' + setup.trigger.toFixed(2) + (isFinite(setup.stop) ? '\n🛑 Stop $' + setup.stop.toFixed(2) : '') + (isFinite(setup.T1) ? '\n✅ T1 $' + setup.T1.toFixed(2) : ''), inline: false },
          { name: '💡 Thesis', value: setup.thesis || 'see card', inline: false },
        ],
        footer: { text: 'Flow Scout | TRIGGER WATCH | fallback render' },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // Use shared discordPush helper — tracks heartbeat + retries + logs full errors
  var dp = require('./discordPush');
  var result = await dp.send('triggerWatcher', card, { webhook: DISCORD_WEBHOOK });
  if (result.ok) {
    console.log('[TRIGGER-WATCH] PUSHED: ' + setup.ticker + ' ' + setup.source + ' ' + setup.direction + ' (attempts ' + result.attempts + ')');
  } else {
    console.error('[TRIGGER-WATCH] PUSH FAILED for ' + setup.ticker + ' after ' + result.attempts + ' attempts: ' + (result.error || 'unknown'));
  }
  return result;
}

// Main scan-and-alert function
async function runWatch() {
  if (!ts || !ts.getAccessToken) { console.log('[TRIGGER-WATCH] No TS module'); return; }
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { console.log('[TRIGGER-WATCH] No token'); return; }
  if (!token) return;

  var setups = await collectArmedSetups();
  console.log('[TRIGGER-WATCH] ' + setups.length + ' armed setups to check');

  var alertsSent = 0;
  var checked = 0;

  for (var i = 0; i < setups.length; i++) {
    var s = setups[i];
    if (isInCooldown(s.ticker, s.source)) continue;
    var spot = await getLiveQuote(s.ticker, token);
    checked++;
    if (!spot) continue;
    if (isAtTrigger(spot, s.trigger, s.direction)) {
      await pushTriggerAlert(s, spot);
      markCooldown(s.ticker, s.source);
      alertsSent++;
    }
  }
  console.log('[TRIGGER-WATCH] Checked ' + checked + ' / ' + setups.length + ', alerts sent: ' + alertsSent);
  return { checked: checked, total: setups.length, alertsSent: alertsSent };
}

module.exports = {
  runWatch: runWatch,
  collectArmedSetups: collectArmedSetups,
  isAtTrigger: isAtTrigger,
};
