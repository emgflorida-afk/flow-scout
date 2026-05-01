// =============================================================================
// TRIGGER ALERTER (Apr 30 2026 — v6 PM)
//
// Real-time entry-trigger alerter. Polls SETUP_RADAR every minute during RTH,
// pulls 5m bars per ticker, fires Discord pings when a CLOSED 5m bar crosses
// a setup's trigger price WITH volume confirmation.
//
// AB ask: "I want to get something of when to enter at that moment not after
// the fact." This module turns SETUP_RADAR.ready/forming entries into push
// notifications the second the trigger fires on a 5m bar close.
//
// Wires to existing infra:
//   - SETUP_RADAR.json on /data volume         (read each tick)
//   - tradestation auth token (env: TS_REFRESH_TOKEN, refresh handled elsewhere)
//   - Discord webhook DISCORD_TRIGGER_WEBHOOK   (or fallback to STRATUMLVL)
//   - State file /data/trigger_alerter_state.json (dedup so we don't re-fire)
//
// Public API:
//   runScan(opts)         - one-shot scan + post; returns { scanned, posted, skipped }
//   getStatus()           - last-run summary for /api/trigger-alerter/status
//
// Cron suggestion: "* 13-19 * * 1-5"   (every minute 9-15 ET via UTC, weekdays)
// =============================================================================

var fs = require('fs');
var path = require('path');
var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// ----- Config -----
var WEBHOOK_URL = process.env.DISCORD_TRIGGER_WEBHOOK
              || process.env.DISCORD_STRATUMLVL_WEBHOOK
              || '';
var TS_BASE = process.env.TS_BASE || 'https://api.tradestation.com/v3';
var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var SETUP_RADAR_FILE = path.join(DATA_ROOT, 'setup_radar.json');
var STATE_FILE       = path.join(DATA_ROOT, 'trigger_alerter_state.json');

// Volume confirmation threshold (vol > MA × this multiplier)
var VOL_CONFIRM_MULT = parseFloat(process.env.TRIGGER_VOL_MULT || '1.5');
// How long a bar's trigger event remains "fresh" — don't alert if we missed
// the initial fire by too many minutes (tabs were closed, etc.)
var STALE_BAR_MIN    = parseInt(process.env.TRIGGER_STALE_BAR_MIN || '10');
// Don't re-fire same ticker within this window
var DEDUP_WINDOW_MIN = parseInt(process.env.TRIGGER_DEDUP_MIN || '30');

// ----- Last-run snapshot for /status -----
var lastRun = {
  finishedAt: null,
  scanned: 0,
  posted: 0,
  skipped: 0,
  errors: 0,
  lastError: null,
  fires: [],     // last 20 fires
};

// ----- State helpers -----
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[TRIGGER] state load failed:', e.message);
    return {};
  }
}
function saveState(state) {
  try {
    var tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[TRIGGER] state save failed:', e.message);
  }
}

// ----- TS bar fetch (5m) -----
async function fetch5mBars(symbol, token) {
  // Pull last 25 5m bars for volume MA + recent close check
  var url = TS_BASE + '/marketdata/barcharts/' + encodeURIComponent(symbol)
          + '?unit=Minute&interval=5&barsback=25';
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('TS-bars-' + r.status + '-' + symbol);
  var data = await r.json();
  var raw = (data && (data.Bars || data.bars)) || [];
  return raw.map(function(b) {
    return {
      Open:        parseFloat(b.Open),
      High:        parseFloat(b.High),
      Low:         parseFloat(b.Low),
      Close:       parseFloat(b.Close),
      TotalVolume: parseInt(b.TotalVolume || 0),
      TimeStamp:   b.TimeStamp,
    };
  }).filter(function(b) { return isFinite(b.Close); });
}

// ----- Direction inference -----
// Setup-card schema doesn't always carry an explicit `direction`. Infer from
// stop vs target: stop < target = LONG (target above), stop > target = SHORT.
function inferDirection(setup) {
  var dir = (setup.direction || '').toUpperCase();
  if (dir === 'LONG' || dir === 'CALL')  return 'LONG';
  if (dir === 'SHORT' || dir === 'PUT')  return 'SHORT';
  var stop   = parseFloat(setup.stop);
  var target = parseFloat(setup.target);
  if (isFinite(stop) && isFinite(target)) {
    return target > stop ? 'LONG' : 'SHORT';
  }
  return null;
}

// ----- Trigger detection -----
// A trigger fires when the most-recently-CLOSED 5m bar's close crosses the
// trigger price in the right direction WITH volume > volMA × multiplier.
function detectTrigger(setup, bars) {
  if (!bars || bars.length < 6) return { fired: false, reason: 'not enough bars' };
  // Most-recently-closed bar = bars[-1] (TS returns oldest first, current is the newest CLOSED bar — TS doesn't include the in-progress bar in this endpoint by default)
  var closedBar = bars[bars.length - 1];
  if (!closedBar) return { fired: false, reason: 'no closed bar' };

  // Coerce trigger price (radar may store either a number or a description string)
  var triggerPx = parseFloat(setup.trigger);
  if (!isFinite(triggerPx)) {
    // Try alternate fields
    if (typeof setup.entry === 'number') triggerPx = setup.entry;
    else if (typeof setup.optionEntry === 'number') triggerPx = setup.optionEntry;
    else return { fired: false, reason: 'no parseable trigger price' };
  }

  var dir = inferDirection(setup);
  if (!dir) return { fired: false, reason: 'no direction' };

  // Volume MA over last 20 bars (excluding current closed)
  var sample = bars.slice(-21, -1);
  var sumVol = 0;
  for (var i = 0; i < sample.length; i++) sumVol += sample[i].TotalVolume;
  var volMA = sample.length > 0 ? sumVol / sample.length : 0;
  var volRatio = volMA > 0 ? closedBar.TotalVolume / volMA : 0;
  var volPass = volRatio >= VOL_CONFIRM_MULT;

  // Direction-aware close-through check
  var closedThrough = dir === 'LONG'
    ? closedBar.Close > triggerPx
    : closedBar.Close < triggerPx;

  if (!closedThrough) {
    return { fired: false, reason: 'no close-through', closedBar: closedBar, triggerPx: triggerPx, dir: dir, volRatio: volRatio };
  }
  if (!volPass) {
    return { fired: false, reason: 'no volume confirm', closedBar: closedBar, triggerPx: triggerPx, dir: dir, volRatio: volRatio };
  }

  return {
    fired: true,
    direction: dir,
    triggerPx: triggerPx,
    closedBar: closedBar,
    volRatio: volRatio,
    barTime: closedBar.TimeStamp,
  };
}

// ----- Discord post -----
function buildDiscordPayload(ticker, setup, fire) {
  var dirEmoji = fire.direction === 'LONG' ? '🟢' : '🔴';
  var dirArrow = fire.direction === 'LONG' ? '↑'  : '↓';
  var color    = fire.direction === 'LONG' ? 0x00d68f : 0xff3b3b;

  var triggerPx = fire.triggerPx;
  var stop      = setup.stop;
  var target    = setup.target;
  var contract  = setup.contract || '—';
  var optEntry  = setup.optionEntry != null ? '$' + setup.optionEntry.toFixed(2) : '—';
  var dollarRisk = setup.dollarRiskPerCt != null ? '$' + Math.round(setup.dollarRiskPerCt) : '—';
  var rr         = setup.rrRatio != null ? setup.rrRatio.toFixed(1) + ':1' : '—';

  var lines = [
    dirEmoji + ' **TRIGGER FIRED** — ' + ticker + ' ' + fire.direction,
    '',
    '**Bar close:** $' + fire.closedBar.Close.toFixed(2) + ' (5m)',
    dirArrow + ' **Crossed trigger:** $' + triggerPx.toFixed(2),
    '📊 **Volume:** ' + fire.volRatio.toFixed(2) + '× MA',
    '',
    '**Trade card:**',
    '`Contract:` ' + contract,
    '`Opt entry:` ' + optEntry,
    '`Stop:` $' + (stop != null ? stop.toFixed(2) : '—'),
    '`Target:` $' + (target != null ? target.toFixed(2) : '—'),
    '`R:R:` ' + rr,
    '`$risk/ct:` ' + dollarRisk,
  ];

  return {
    username: 'Trigger Alerter',
    embeds: [{
      title: dirEmoji + ' ' + ticker + ' ' + fire.direction + ' TRIGGER FIRED',
      description: lines.join('\n'),
      color: color,
      footer: { text: 'Stratum Trigger Alerter • bar ' + fire.barTime },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function postToDiscord(payload) {
  if (!WEBHOOK_URL) {
    console.log('[TRIGGER] no webhook configured — would post:', payload.embeds[0].title);
    return { ok: false, reason: 'no webhook' };
  }
  try {
    var r = await fetchLib(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return { ok: false, reason: 'discord-' + r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'fetch:' + e.message };
  }
}

// ----- Main scan -----
async function runScan(opts) {
  opts = opts || {};
  var token = opts.token || process.env.TS_ACCESS_TOKEN;
  if (!token) {
    // Try to obtain via the existing tradestation.js helper if available
    try {
      var ts = require('./tradestation');
      if (ts && ts.getAccessToken) token = await ts.getAccessToken();
    } catch (e) { /* swallow — return error below */ }
  }
  if (!token) {
    lastRun.lastError = 'no-ts-token';
    return { scanned: 0, posted: 0, skipped: 0, errors: 1, error: 'no TS access token' };
  }

  // Read radar
  if (!fs.existsSync(SETUP_RADAR_FILE)) {
    lastRun.lastError = 'no-radar';
    return { scanned: 0, posted: 0, skipped: 0, errors: 1, error: 'setup_radar.json missing' };
  }
  var radar;
  try {
    radar = JSON.parse(fs.readFileSync(SETUP_RADAR_FILE, 'utf8'));
  } catch (e) {
    lastRun.lastError = 'radar-parse:' + e.message;
    return { scanned: 0, posted: 0, skipped: 0, errors: 1, error: 'radar parse: ' + e.message };
  }

  // Combine ready + forming setups (both are candidates for trigger fires)
  var candidates = [].concat(radar.ready || [], radar.forming || []);
  if (!candidates.length) {
    return { scanned: 0, posted: 0, skipped: 0, errors: 0, message: 'no candidates' };
  }

  var state = loadState();
  var results = { scanned: 0, posted: 0, skipped: 0, errors: 0, fires: [] };

  for (var i = 0; i < candidates.length; i++) {
    var setup = candidates[i];
    var ticker = setup.ticker;
    if (!ticker) continue;
    results.scanned++;

    try {
      var bars = await fetch5mBars(ticker, token);
      var fire = detectTrigger(setup, bars);

      if (!fire.fired) {
        results.skipped++;
        continue;
      }

      // Dedup: don't fire on same bar timestamp twice, or within 30 min of last fire for same ticker
      var s = state[ticker] || {};
      if (s.lastBarFired === fire.barTime) {
        results.skipped++;
        continue;
      }
      var nowMs = Date.now();
      if (s.lastFireAt && (nowMs - s.lastFireAt) < DEDUP_WINDOW_MIN * 60 * 1000) {
        results.skipped++;
        continue;
      }
      // Staleness: if the bar timestamp is too old we missed the moment, skip
      var barAgeMin = (nowMs - new Date(fire.barTime).getTime()) / 60000;
      if (barAgeMin > STALE_BAR_MIN) {
        results.skipped++;
        continue;
      }

      var payload = buildDiscordPayload(ticker, setup, fire);
      var post = await postToDiscord(payload);
      if (post.ok) {
        results.posted++;
        results.fires.push({ ticker: ticker, dir: fire.direction, close: fire.closedBar.Close, trigger: fire.triggerPx, vol: fire.volRatio, ts: fire.barTime });
        state[ticker] = { lastBarFired: fire.barTime, lastFireAt: nowMs };
      } else {
        results.errors++;
        lastRun.lastError = 'discord-fail:' + post.reason;
      }
    } catch (e) {
      results.errors++;
      lastRun.lastError = 'scan:' + ticker + ':' + e.message;
      console.error('[TRIGGER] error on', ticker, e.message);
    }
  }

  saveState(state);

  // Update last-run snapshot
  lastRun.finishedAt = new Date().toISOString();
  lastRun.scanned    = results.scanned;
  lastRun.posted     = results.posted;
  lastRun.skipped    = results.skipped;
  lastRun.errors     = results.errors;
  lastRun.fires      = (results.fires.concat(lastRun.fires || [])).slice(0, 20);

  console.log('[TRIGGER] scan:', results.scanned, 'posted:', results.posted, 'skipped:', results.skipped, 'errors:', results.errors);
  return results;
}

function getStatus() {
  return {
    finishedAt: lastRun.finishedAt,
    scanned: lastRun.scanned,
    posted: lastRun.posted,
    skipped: lastRun.skipped,
    errors: lastRun.errors,
    lastError: lastRun.lastError,
    recentFires: lastRun.fires,
    config: {
      webhookConfigured: !!WEBHOOK_URL,
      volMult: VOL_CONFIRM_MULT,
      staleBarMin: STALE_BAR_MIN,
      dedupWindowMin: DEDUP_WINDOW_MIN,
      radarFile: SETUP_RADAR_FILE,
      stateFile: STATE_FILE,
    },
  };
}

module.exports = {
  runScan: runScan,
  getStatus: getStatus,
  detectTrigger: detectTrigger,
  buildDiscordPayload: buildDiscordPayload,
  inferDirection: inferDirection,
};
