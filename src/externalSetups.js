// =============================================================================
// EXTERNAL SETUPS — bridge from local Claude Code routines to Railway auto-trader.
//
// AB runs scanner routines locally that write .md output to his /memory/ directory.
// Those produce ABBV/UNH/XLE/NVDA/MRK type picks but don't auto-feed Railway's
// simAutoTrader. This module stores externally-pushed setups in /data/external_setups.json
// so collectQualifyingSetups() can read them alongside the server-side scanners.
//
// API:
//   POST /api/external-setups/import
//     headers: { 'X-Source-Token': '<token>' }
//     body: {
//       source: 'local-wp-routine',     // identifies the producer
//       scanType: 'WP',                 // WP / JS / COIL / AYCE / custom
//       generatedAt: '2026-05-04T22:00:00Z',
//       setups: [{
//         ticker, direction, trigger, stop, tp1, tp2, tp3,
//         conviction, pattern, tf, holdRating, earningsRisk, score, ...
//       }]
//     }
//
// STORAGE: /data/external_setups.json
//   {
//     'local-wp-routine:WP': {
//       generatedAt: '...',
//       setups: [...],
//       lastImportedAt: '...',
//     },
//     'local-js-routine:JS': { ... }
//   }
//
// FRESHNESS: setups older than 24h are filtered out at read time (loadActiveSetups()).
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var FILE = path.join(DATA_ROOT, 'external_setups.json');

// Optional shared-secret token. Set EXTERNAL_SETUPS_TOKEN on Railway to enforce auth.
// If unset, endpoint is open (acceptable for v1 since it only WRITES — it doesn't
// trigger fires by itself; simAutoTrader still applies all filters).
function expectedToken() {
  return process.env.EXTERNAL_SETUPS_TOKEN || null;
}

function ensureDir() {
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return {}; }
}

function save(map) {
  ensureDir();
  try { fs.writeFileSync(FILE, JSON.stringify(map, null, 2)); }
  catch (e) { console.error('[EXTERNAL-SETUPS] save failed:', e.message); }
}

// Validate + normalize a setup
function normalizeSetup(s) {
  if (!s || typeof s !== 'object') return null;
  if (!s.ticker || typeof s.ticker !== 'string') return null;
  var ticker = s.ticker.toUpperCase().trim();
  var direction = String(s.direction || '').toLowerCase();
  if (direction !== 'long' && direction !== 'short') return null;
  var trigger = parseFloat(s.trigger);
  if (!isFinite(trigger) || trigger <= 0) return null;
  return {
    ticker: ticker,
    direction: direction,
    source: s.source || null,             // overridden by caller; legacy field
    pattern: String(s.pattern || 'unknown').slice(0, 40),
    tf: String(s.tf || 'unknown').slice(0, 20),
    trigger: trigger,
    stop: isFinite(parseFloat(s.stop)) ? parseFloat(s.stop) : null,
    tp1: isFinite(parseFloat(s.tp1)) ? parseFloat(s.tp1) : null,
    tp2: isFinite(parseFloat(s.tp2)) ? parseFloat(s.tp2) : null,
    tp3: isFinite(parseFloat(s.tp3)) ? parseFloat(s.tp3) : null,
    conviction: parseInt(s.conviction || s.score || 0, 10) || 0,
    holdRating: s.holdRating || null,     // expected: 'SAFE' | 'CAUTION' | 'AVOID'
    earningsRisk: s.earningsRisk || null,
    spot: isFinite(parseFloat(s.spot)) ? parseFloat(s.spot) : null,
    notes: s.notes || null,
    // PREFERRED CONTRACT (May 4 2026): if AB's local routine has done the research
    // and identified the exact contract worth firing (volume, OI, flow validation),
    // it can specify here. Auto-trader uses this verbatim instead of running its
    // own contractResolver. Either provide the full OPRA symbol OR the parts.
    preferredContractSymbol: s.preferredContractSymbol || s.contractSymbol || null,  // 'ABBV 260619C210'
    preferredExpiry: s.preferredExpiry || s.expiry || null,        // '2026-06-19'
    preferredStrike: isFinite(parseFloat(s.preferredStrike || s.strike)) ? parseFloat(s.preferredStrike || s.strike) : null,
    preferredSize: parseInt(s.preferredSize || s.size || 0, 10) || null,  // override 2-3ct default
    flowNotes: s.flowNotes || null,        // 'Bullflow shows 4.2k call vol on this strike, OI 12k'
  };
}

// Import a batch of setups under a (source, scanType) key
function importSetups(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
  var source = String(payload.source || 'unknown').slice(0, 60);
  var scanType = String(payload.scanType || 'GENERIC').slice(0, 20).toUpperCase();
  var raw = Array.isArray(payload.setups) ? payload.setups : [];
  var generatedAt = payload.generatedAt || new Date().toISOString();

  var normalized = raw.map(normalizeSetup).filter(Boolean);
  // Stamp the source identifier on each setup so simAutoTrader can attribute fires
  normalized.forEach(function(s) { s.source = source + '/' + scanType; });

  var key = source + ':' + scanType;
  var map = load();
  map[key] = {
    source: source,
    scanType: scanType,
    generatedAt: generatedAt,
    lastImportedAt: new Date().toISOString(),
    setupCount: normalized.length,
    setups: normalized,
  };
  save(map);
  return {
    ok: true,
    key: key,
    accepted: normalized.length,
    rejected: raw.length - normalized.length,
    rejectedSample: raw.length > normalized.length
      ? raw.filter(function(r) { return !normalizeSetup(r); }).slice(0, 3)
      : [],
  };
}

// Return all setups across all imports, freshness-filtered (default 24h max age)
function loadActiveSetups(maxAgeHours) {
  var maxAge = maxAgeHours || 24;
  var cutoff = Date.now() - (maxAge * 3600 * 1000);
  var map = load();
  var out = [];
  Object.keys(map).forEach(function(key) {
    var entry = map[key];
    var ts = entry.generatedAt ? new Date(entry.generatedAt).getTime() : 0;
    if (ts < cutoff) return;
    (entry.setups || []).forEach(function(s) {
      out.push(s);
    });
  });
  return out;
}

// List all stored imports + meta (for /api/external-setups/list)
function listImports() {
  var map = load();
  return Object.keys(map).map(function(key) {
    var entry = map[key] || {};
    return {
      key: key,
      source: entry.source,
      scanType: entry.scanType,
      generatedAt: entry.generatedAt,
      lastImportedAt: entry.lastImportedAt,
      setupCount: entry.setupCount,
      ageHours: entry.generatedAt ? Math.round((Date.now() - new Date(entry.generatedAt).getTime()) / 3600000 * 10) / 10 : null,
    };
  });
}

// Verify token if EXTERNAL_SETUPS_TOKEN env is set
function verifyToken(headerToken) {
  var expected = expectedToken();
  if (!expected) return { ok: true, mode: 'open' };  // no auth configured
  if (!headerToken || headerToken !== expected) return { ok: false, error: 'invalid token' };
  return { ok: true, mode: 'authenticated' };
}

module.exports = {
  importSetups: importSetups,
  loadActiveSetups: loadActiveSetups,
  listImports: listImports,
  verifyToken: verifyToken,
};
