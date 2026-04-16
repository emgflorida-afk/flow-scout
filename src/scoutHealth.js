// scoutHealth.js -- Stratum v7.5
// -----------------------------------------------------------------
// Centralized health tracker for all scouts.  Each scout reports its
// last run result via `report(name, result)`.  The arm page polls
// GET /api/health to render a real-time heartbeat strip.
// -----------------------------------------------------------------

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

// { scoutName: { lastRun, ok, checked, queued, skipped, error, ... } }
var _reports = {};

// Token health state
var _token = { ok: false, lastCheck: null, error: null };

/**
 * Called by each scout cron wrapper after pollOnce/run finishes.
 * @param {string} name   e.g. 'casey', 'strat', 'wp', 'ayce', 'spyHedge'
 * @param {object} result Whatever the scout returned
 */
function report(name, result) {
  _reports[name] = {
    lastRun:  new Date().toISOString(),
    ok:       !!(result && result.ok !== false),
    checked:  (result && result.checked) || 0,
    queued:   (result && result.queued)  || 0,
    skipped:  (result && result.skipped) || 0,
    error:    (result && result.reason)  || null,
    raw:      result || null,
  };
}

/**
 * Proactive token check — call from a cron or before reporting.
 * Updates internal token state.
 */
async function checkToken() {
  try {
    if (!ts) { _token = { ok: false, lastCheck: new Date().toISOString(), error: 'ts module not loaded' }; return _token; }
    var token = await ts.getAccessToken();
    _token = {
      ok:        !!token,
      lastCheck: new Date().toISOString(),
      error:     token ? null : 'no token',
    };
  } catch(e) {
    _token = { ok: false, lastCheck: new Date().toISOString(), error: e.message };
  }
  return _token;
}

/**
 * Returns full health snapshot for the API.
 */
function getHealth() {
  // Compute aggregate status
  var names = Object.keys(_reports);
  var allOk = _token.ok;
  var anyRecent = false;
  var now = Date.now();
  var STALE_MS = 5 * 60 * 1000; // 5 min = stale

  var scouts = {};
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    var r = _reports[n];
    var age = r.lastRun ? now - new Date(r.lastRun).getTime() : Infinity;
    var stale = age > STALE_MS;
    if (!stale) anyRecent = true;
    if (!r.ok) allOk = false;
    scouts[n] = {
      lastRun:  r.lastRun,
      ok:       r.ok,
      stale:    stale,
      ageMs:    Math.round(age),
      checked:  r.checked,
      queued:   r.queued,
      skipped:  r.skipped,
      error:    r.error,
    };
  }

  var status = 'UNKNOWN';
  if (!_token.ok) status = 'TOKEN_DOWN';
  else if (names.length === 0) status = 'NO_DATA';
  else if (allOk && anyRecent) status = 'HEALTHY';
  else if (anyRecent) status = 'DEGRADED';
  else status = 'STALE';

  return {
    status:    status,
    token:     _token,
    scouts:    scouts,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  report:     report,
  checkToken: checkToken,
  getHealth:  getHealth,
};
