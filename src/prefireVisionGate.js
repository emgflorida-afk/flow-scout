// =============================================================================
// PRE-FIRE VISION GATE — chart-vision check before any auto-fire.
//
// Per AB: 'use brain/vision to identify what's right.' Before icsTradeManager
// or simAutoTrader fires SIM, this gate runs:
//   1. Cache check (30 min freshness per ticker:direction)
//   2. If no cached result, request chart-img + vision review
//   3. Return APPROVE / WAIT / VETO / SKIP (vision unavailable)
//
// FAIL-OPEN POLICY: If vision is unavailable (no API key, no chart source,
// fetch error), this gate returns SKIP — auto-fire continues. Vision is an
// ENRICHMENT, not a hard gate. The structural-stop primary still applies.
//
// CACHE: /data/prefire_vision_cache.json
//   { 'TICKER:long': { result, reason, expiresAt, cachedAt } }
//
// CHART SOURCE — IMPLEMENTATION GAP (May 4 2026):
//   Vision requires an actual chart image. Tonight's scaffold returns SKIP
//   when no chart capture is available. Next session: integrate chart-img.com
//   API or headless TradingView screenshot to feed vision a real image.
//
//   For now this gate exists so simAutoTrader can call it without breaking,
//   and we have the cache + result-shape ready for when chart-img wires in.
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var CACHE_FILE = path.join(DATA_ROOT, 'prefire_vision_cache.json');

var CACHE_TTL_MIN = 30;

var chartVision = null;
try { chartVision = require('./chartVision'); } catch (e) {}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); }
  catch (e) { console.error('[VISION-GATE] cache save failed:', e.message); }
}

// Returns one of:
//   'APPROVE' — vision says structure clean, fire OK
//   'WAIT'    — vision says wait for more confirmation
//   'VETO'    — vision says skip
//   'SKIP'    — vision unavailable (default permissive)
async function checkBeforeFire(setup) {
  if (!setup || !setup.ticker || !setup.direction) {
    return { result: 'SKIP', reason: 'invalid setup', cached: false };
  }
  var key = setup.ticker + ':' + setup.direction;

  // Cache check
  var cache = loadCache();
  var entry = cache[key];
  if (entry && entry.expiresAt && new Date(entry.expiresAt).getTime() > Date.now()) {
    return Object.assign({ cached: true }, entry);
  }

  // No chart-img integration yet — return SKIP so fire isn't blocked.
  // When we wire chart-img.com or TradingView screenshot, this becomes:
  //   var chartImg = await fetchChartImage(setup.ticker, setup.tf);
  //   var review = await chartVision.reviewChart({ imageBase64: chartImg, ticker, direction });
  //   var result = review.verdict; // APPROVE / WAIT / VETO
  var result = {
    result: 'SKIP',
    reason: 'chart-img integration pending — vision check unavailable',
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CACHE_TTL_MIN * 60 * 1000).toISOString(),
    visionLoaded: !!chartVision,
  };
  cache[key] = result;
  saveCache(cache);
  return Object.assign({ cached: false }, result);
}

function getCacheStatus() {
  var cache = loadCache();
  var now = Date.now();
  return {
    timestamp: new Date().toISOString(),
    entries: Object.keys(cache).map(function(k) {
      var e = cache[k];
      return {
        key: k,
        result: e.result,
        cachedAt: e.cachedAt,
        expiresAt: e.expiresAt,
        ageMin: e.cachedAt ? Math.round((now - new Date(e.cachedAt).getTime()) / 60000) : null,
      };
    }),
  };
}

module.exports = {
  checkBeforeFire: checkBeforeFire,
  getCacheStatus: getCacheStatus,
};
