// =============================================================================
// DISCORD PUSH HELPER — shared push wrapper with proper error logging +
// heartbeat tracking. Replaces 50+ inline `try { fetch } catch (e) {}` patterns
// that silently swallowed errors and made cron failures invisible.
//
// USAGE:
//   var dp = require('./discordPush');
//   var result = await dp.send('powerHourBrief', embedPayload);
//   if (!result.ok) console.error('push failed:', result.error);
//
// HEARTBEAT FILE: /data/desk_heartbeats.json
//   Tracks last successful + failed push per desk for /api/desks/health.
//   Lets us see at a glance which desks are silently dying on Railway.
//
// RETRY LOGIC: 3 attempts with exponential backoff (1s, 2s, 4s) on 5xx + network errors.
//   Discord 4xx (bad webhook, malformed body) = no retry, log + return immediately.
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HEARTBEAT_FILE = path.join(DATA_ROOT, 'desk_heartbeats.json');

var DEFAULT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

function loadHeartbeats() {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveHeartbeats(map) {
  try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(map, null, 2)); } catch (e) {
    console.error('[DISCORD-PUSH] heartbeat save failed:', e.message);
  }
}

function recordHeartbeat(deskName, status, detail) {
  var map = loadHeartbeats();
  if (!map[deskName]) map[deskName] = {};
  var entry = map[deskName];
  var now = new Date().toISOString();
  if (status === 'success') {
    entry.lastSuccessAt = now;
    entry.lastSuccessDetail = detail || null;
    entry.consecutiveFailures = 0;
  } else {
    entry.lastFailureAt = now;
    entry.lastFailureDetail = detail || null;
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
  }
  entry.lastAttemptAt = now;
  entry.lastAttemptStatus = status;
  saveHeartbeats(map);
}

function sleep(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }

// Send Discord embed with retry + logging + heartbeat tracking
//
// deskName: string identifier for heartbeat tracking (e.g. 'powerHourBrief')
// payload: object — Discord webhook body (typically { embeds: [...], username: '...' })
// opts: { webhook: optional override, retries: optional (default 3), timeoutMs: optional (default 8000) }
//
// Returns: { ok: bool, attempts: number, error: string?, status: number? }
async function send(deskName, payload, opts) {
  opts = opts || {};
  var webhook = opts.webhook || DEFAULT_WEBHOOK;
  var maxRetries = opts.retries != null ? opts.retries : 3;
  var timeoutMs = opts.timeoutMs || 8000;

  if (!webhook) {
    var err = 'no webhook configured';
    console.error('[DISCORD-PUSH:' + deskName + '] FAIL: ' + err);
    recordHeartbeat(deskName, 'failure', err);
    return { ok: false, attempts: 0, error: err };
  }

  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var lastError = null;
  var lastStatus = null;
  var attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timeoutHandle = ctrl ? setTimeout(function() { ctrl.abort(); }, timeoutMs) : null;

      var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
      if (ctrl) fetchOpts.signal = ctrl.signal;

      var r = await fetchLib(webhook, fetchOpts);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      lastStatus = r.status;

      if (r.ok) {
        console.log('[DISCORD-PUSH:' + deskName + '] OK (status ' + r.status + ', attempt ' + attempt + ')');
        recordHeartbeat(deskName, 'success', { status: r.status, attempt: attempt });
        return { ok: true, attempts: attempt, status: r.status };
      }

      // Read body for diagnostics
      var bodyText = '';
      try { bodyText = (await r.text()).slice(0, 400); } catch (e) {}
      lastError = 'HTTP ' + r.status + ' ' + bodyText;

      // 4xx (bad payload / bad webhook) = don't retry
      if (r.status >= 400 && r.status < 500) {
        console.error('[DISCORD-PUSH:' + deskName + '] HARD FAIL ' + r.status + ': ' + bodyText);
        recordHeartbeat(deskName, 'failure', { status: r.status, body: bodyText });
        return { ok: false, attempts: attempt, status: r.status, error: lastError };
      }

      // 5xx — retry with backoff
      console.error('[DISCORD-PUSH:' + deskName + '] retryable ' + r.status + ' (attempt ' + attempt + '): ' + bodyText);
    } catch (e) {
      lastError = e.message || String(e);
      console.error('[DISCORD-PUSH:' + deskName + '] network error (attempt ' + attempt + '): ' + lastError);
    }

    if (attempt < maxRetries) {
      var backoffMs = Math.pow(2, attempt - 1) * 1000;
      await sleep(backoffMs);
    }
  }

  // All retries exhausted
  console.error('[DISCORD-PUSH:' + deskName + '] FINAL FAIL after ' + attempt + ' attempts: ' + lastError);
  recordHeartbeat(deskName, 'failure', { status: lastStatus, error: lastError, attempts: attempt });
  return { ok: false, attempts: attempt, status: lastStatus, error: lastError };
}

// Get all desk heartbeats for /api/desks/health
function getHealth() {
  var map = loadHeartbeats();
  var now = Date.now();
  var deskNames = Object.keys(map);
  var summary = deskNames.map(function(name) {
    var entry = map[name] || {};
    var lastSuccess = entry.lastSuccessAt ? new Date(entry.lastSuccessAt).getTime() : null;
    var ageMin = lastSuccess ? Math.round((now - lastSuccess) / 60000) : null;
    var status = 'unknown';
    if (entry.consecutiveFailures >= 3) status = 'failing';
    else if (lastSuccess && ageMin < 60) status = 'healthy';
    else if (lastSuccess && ageMin < 240) status = 'stale';
    else if (lastSuccess) status = 'old';
    return {
      desk: name,
      status: status,
      lastSuccessAt: entry.lastSuccessAt || null,
      lastSuccessAgeMin: ageMin,
      lastFailureAt: entry.lastFailureAt || null,
      lastFailureDetail: entry.lastFailureDetail || null,
      consecutiveFailures: entry.consecutiveFailures || 0,
      lastAttemptAt: entry.lastAttemptAt || null,
      lastAttemptStatus: entry.lastAttemptStatus || null,
    };
  });
  return {
    timestamp: new Date().toISOString(),
    deskCount: summary.length,
    desks: summary,
  };
}

module.exports = {
  send: send,
  getHealth: getHealth,
  recordHeartbeat: recordHeartbeat,  // exposed for tests
};
