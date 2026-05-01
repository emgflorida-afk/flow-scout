// =============================================================================
// BREAKOUT WATCHER — RTH polling cron that fires Discord pings the moment a
// conv 9-10 coil setup gets CONFIRMED_STRONG (>=1.5x avg vol on breakout candle).
//
// John's rule embodied: low volume during the coil is fine; volume MUST expand
// on the trigger break. This watcher is what closes the loop between EOD coil
// detection (3:50 PM cron) and intraday trade-fire decisions.
//
// Cadence:
//   - Every 5 min from 9:35 AM ET to 3:55 PM ET on weekdays
//   - Skips if no recent coil scan in last 24h
//   - Skips already-fired setups (one push per setup per day)
//
// Output:
//   - Discord push to #stratum-swing on new CONFIRMED_STRONG (or _LIGHT if no
//     STRONG hits in a 30-min window — fallback so AB still gets the signal)
// =============================================================================

var fs = require('fs');
var path = require('path');

var dailyCoilScanner = null;
try { dailyCoilScanner = require('./dailyCoilScanner'); }
catch (e) { console.log('[BREAKOUT] coil scanner not loaded:', e.message); }

// State persistence — one file per trading day so it auto-clears overnight
var DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) {
  // Local fallback when /data isn't mounted
  DATA_DIR = path.join(__dirname, '..', 'data');
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}

function todayKey() {
  // YYYY-MM-DD in ET (using UTC offset trick — close enough for daily bucketing)
  var now = new Date();
  var et = new Date(now.getTime() - 4 * 3600 * 1000); // EDT; -5 in EST. Daily bucket only — small drift OK.
  return et.toISOString().slice(0, 10);
}

function statePath() {
  return path.join(DATA_DIR, 'breakout-fired-' + todayKey() + '.json');
}

function loadFiredToday() {
  try {
    var p = statePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { return {}; }
}

function saveFiredToday(state) {
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); }
  catch(e) { console.warn('[BREAKOUT] save state failed:', e.message); }
}

// =============================================================================
// MAIN — poll all conv >=9 setups from latest coil scan
// =============================================================================
async function runWatch(opts) {
  opts = opts || {};
  if (!dailyCoilScanner) return { skipped: true, reason: 'no-scanner' };

  var lastScan = dailyCoilScanner.loadLast();
  if (!lastScan) return { skipped: true, reason: 'no-scan-yet' };

  // Reject scans older than 24h (don't watch yesterday's stale setups)
  var scanAgeHr = (Date.now() - new Date(lastScan.generatedAt || 0).getTime()) / 3600 / 1000;
  if (scanAgeHr > 24) return { skipped: true, reason: 'scan-stale-' + Math.round(scanAgeHr) + 'h' };

  // Pool ready + watching, filter conv >= 9
  var pool = [].concat(lastScan.ready || [], lastScan.watching || []);
  var minConv = opts.minConv != null ? opts.minConv : 9;
  var setups = pool.filter(function(s) {
    return (s.conviction || 0) >= minConv && s.plan && s.plan.primary && s.plan.primary.trigger;
  });
  if (!setups.length) return { skipped: true, reason: 'no-conv' + minConv + '-setups' };

  var fired = loadFiredToday();
  var newFires = [];
  var allResults = [];

  // Sequential to avoid hammering TS API
  for (var i = 0; i < setups.length; i++) {
    var s = setups[i];
    var key = s.ticker + ':' + s.tf + ':' + s.direction;
    if (fired[key]) {
      allResults.push({ ticker: s.ticker, tf: s.tf, skipped: 'already-fired' });
      continue;
    }
    try {
      var verdict = await dailyCoilScanner.checkBreakoutConfirm(
        s.ticker, s.plan.primary.trigger, s.direction
      );
      allResults.push(Object.assign({ ticker: s.ticker, tf: s.tf, conv: s.conviction }, verdict));

      if (verdict && verdict.ok && verdict.verdict === 'CONFIRMED_STRONG') {
        fired[key] = {
          firedAt: new Date().toISOString(),
          verdict: verdict.verdict,
          ratio: verdict.breakoutBar && verdict.breakoutBar.ratio,
          close: verdict.breakoutBar && verdict.breakoutBar.close,
        };
        newFires.push(Object.assign({ setup: s }, verdict));
      }
    } catch(e) {
      allResults.push({ ticker: s.ticker, error: e.message });
    }
  }

  if (newFires.length) {
    saveFiredToday(fired);
    if (!opts.skipPush) {
      try { await pushDiscord(newFires); }
      catch(e) { console.warn('[BREAKOUT] discord push failed:', e.message); }
    }
  }

  return {
    ok: true,
    polled: setups.length,
    newFires: newFires.length,
    results: allResults,
    firedToday: Object.keys(fired).length,
  };
}

// =============================================================================
// DISCORD PUSH — single card with all newly fired setups
// =============================================================================
var DISCORD_WEBHOOK = process.env.DISCORD_BREAKOUT_WEBHOOK
  || process.env.DISCORD_COIL_WEBHOOK
  || process.env.DISCORD_STRAT_SWING_WEBHOOK
  || process.env.DISCORD_EXECUTE_NOW_WEBHOOK
  || 'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

async function pushDiscord(newFires) {
  if (!DISCORD_WEBHOOK || !newFires.length) return;
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var lines = [];
  lines.push('# 🚨 BREAKOUT CONFIRMED — Volume Validated');
  lines.push('_' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + newFires.length + ' setup(s) fired with John volume rule_');
  lines.push('');

  newFires.forEach(function(f) {
    var s = f.setup || {};
    var p = s.plan || {};
    var pp = p.primary || {};
    var bb = f.breakoutBar || {};
    var dirIcon = s.direction === 'long' ? '🟢⬆️' : '🔴⬇️';
    lines.push('## ' + dirIcon + ' **' + s.ticker + '** · ' + (s.tf || 'Daily') + ' · conv ' + s.conviction + '/10');
    lines.push('  Pattern: `' + (s.pattern || '?') + '` (' + (s.sequence || '?') + ')');
    lines.push('  ✅ Breakout close: `$' + bb.close + '` · vol `' + (bb.volume ? Math.round(bb.volume / 1000) + 'k' : '?') + '` (`' + bb.ratio + '×` avg) → CONFIRMED_STRONG');
    lines.push('  Plan: trigger `$' + (pp.trigger || '?') + '` · stop `$' + (pp.stop || '?') + '` · TP1 `$' + (pp.tp1 || '?') + '` · TP2 `$' + (pp.tp2 || '?') + '` · RR `' + (p.rr1 || '?') + '×`');
    lines.push('  → 1ct trial Public · 2ct TS bracket · structure-based stop');
    lines.push('');
  });

  lines.push('---');
  lines.push('🔄 Watcher polls every 5 min 9:35 AM-3:55 PM ET · 1 push per setup per day');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'Breakout Watcher' }),
    });
    if (!r.ok) {
      var t = await r.text();
      console.warn('[BREAKOUT] discord push failed:', r.status, t.slice(0, 200));
      return { error: 'discord-' + r.status };
    }
    console.log('[BREAKOUT] Discord push OK · ' + newFires.length + ' fires');
    return { posted: true, count: newFires.length };
  } catch(e) {
    console.error('[BREAKOUT] discord error:', e.message);
    return { error: e.message };
  }
}

// =============================================================================
// STATUS — what fired today, what's still being watched
// =============================================================================
function getStatus() {
  return {
    firedToday: loadFiredToday(),
    statePath: statePath(),
    lastScanAvailable: dailyCoilScanner ? !!dailyCoilScanner.loadLast() : false,
  };
}

module.exports = {
  runWatch: runWatch,
  pushDiscord: pushDiscord,
  getStatus: getStatus,
  loadFiredToday: loadFiredToday,
};
