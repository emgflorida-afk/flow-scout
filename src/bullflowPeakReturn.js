// =============================================================================
// BULLFLOW PEAK RETURN — fetch max % gain for an option contract since a trade ts.
//
// API: GET /v1/data/peakReturn
//   ?key=APIKEY
//   &sym=O:SPY260408C00520000
//   &old_price=1.35
//   &trade_timestamp=1775669400
//
// Response: { peakPriceSinceTimestamp: "125.47", peakPercentReturnSinceTimestamp: 12.22 }
// Rate limit: 60 req/min per API key.
//
// USAGE (Phase 5.3):
//   1. Enrich every UOA log entry with peak return → Discord card carries
//      "this contract has already peaked +X% since the alert fired"
//   2. Per-filter hit-rate analytics → "AB Bullish Flow alerts peaked >25% in 47% of cases"
//   3. Backfill cron — every 5 min, hydrate last 24h of UOA log with current peak
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var CACHE_FILE = path.join(DATA_ROOT, 'peak_return_cache.json');

// In-memory cache to respect 60 req/min limit
var _memCache = {};
var _lastReqAt = 0;
var MIN_GAP_MS = 1100;  // ~55 req/min headroom

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveCache(cache) {
  try {
    var entries = Object.entries(cache);
    if (entries.length > 5000) {
      // Trim oldest 1000
      entries.sort(function(a, b) { return (a[1].fetchedAt || 0) - (b[1].fetchedAt || 0); });
      cache = Object.fromEntries(entries.slice(-4000));
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) { console.error('[PEAK-RETURN] cache save failed:', e.message); }
}

function getApiKey() {
  return process.env.BULLFLOW_API_KEY ||
    (function() {
      try {
        var keyFile = path.join(DATA_ROOT, 'bullflow_api_key.txt');
        if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
      } catch (e) {}
      return null;
    })();
}

// Throttle to respect 60 req/min
async function throttle() {
  var now = Date.now();
  var since = now - _lastReqAt;
  if (since < MIN_GAP_MS) {
    await new Promise(function(r) { setTimeout(r, MIN_GAP_MS - since); });
  }
  _lastReqAt = Date.now();
}

// Get peak return for an option contract.
// sym: OPRA-prefixed symbol e.g. "O:NVDA260515C00200000"
// oldPrice: entry price (number)
// tradeTimestamp: unix seconds
async function getPeakReturn(sym, oldPrice, tradeTimestamp) {
  if (!sym || !oldPrice || !tradeTimestamp) {
    return { ok: false, error: 'missing params' };
  }
  var key = sym + ':' + oldPrice + ':' + tradeTimestamp;

  // Mem cache
  if (_memCache[key] && Date.now() - _memCache[key].fetchedAt < 60000) {
    return _memCache[key].result;
  }

  // Disk cache (older entries OK to use)
  var cache = loadCache();
  if (cache[key] && Date.now() - cache[key].fetchedAt < 5 * 60 * 1000) {
    _memCache[key] = cache[key];
    return cache[key].result;
  }

  var apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'no API key configured' };

  await throttle();

  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://api.bullflow.io/v1/data/peakReturn'
      + '?key=' + encodeURIComponent(apiKey)
      + '&sym=' + encodeURIComponent(sym)
      + '&old_price=' + encodeURIComponent(oldPrice)
      + '&trade_timestamp=' + encodeURIComponent(tradeTimestamp);

    var r = await fetchLib(url, { timeout: 10000 });
    if (!r.ok) {
      var body = await r.text();
      return { ok: false, error: 'http ' + r.status + ': ' + body.slice(0, 200) };
    }
    var data = await r.json();
    var result = {
      ok: true,
      sym: sym,
      oldPrice: oldPrice,
      tradeTimestamp: tradeTimestamp,
      peakPrice: parseFloat(data.peakPriceSinceTimestamp || 0),
      peakPercent: parseFloat(data.peakPercentReturnSinceTimestamp || 0),
    };

    _memCache[key] = { result: result, fetchedAt: Date.now() };
    cache[key] = _memCache[key];
    saveCache(cache);

    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Enrich a UOA log entry with peak return info
async function enrichLogEntry(entry) {
  if (!entry || !entry.contract || !entry.timestamp) return entry;
  // Convert ISO timestamp to unix seconds
  var ts = Math.floor(new Date(entry.timestamp).getTime() / 1000);
  // Need an entry price. Use alertPremium / size if available, else skip.
  // For Bullflow alerts the trade price is per-contract — we'd need it stored.
  // For now use a heuristic: avg per-contract price = premium / (size * 100) for options
  var pricePerContract = null;
  if (entry.tradePrice) pricePerContract = entry.tradePrice;
  else if (entry.premium && entry.size) pricePerContract = entry.premium / (entry.size * 100);
  if (!pricePerContract) return entry;

  // Convert OPRA contract to Bullflow's O: prefix format
  // Our contractSymbol like "NTAP260515C00115000" → "O:NTAP260515C00115000"
  var sym = entry.contract.startsWith('O:') ? entry.contract : 'O:' + entry.contract;

  var pr = await getPeakReturn(sym, pricePerContract, ts);
  if (pr.ok) {
    entry.peakReturn = {
      peakPrice: pr.peakPrice,
      peakPercent: pr.peakPercent,
      enrichedAt: new Date().toISOString(),
    };
  }
  return entry;
}

// Backfill peak return on the last N hours of UOA log
async function backfillUoaLog(maxAgeHours) {
  var maxAge = maxAgeHours || 24;
  var cutoff = Date.now() - (maxAge * 3600 * 1000);
  var LOG_FILE = path.join(DATA_ROOT, 'uoa_log.json');
  var log;
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch (e) { return { ok: false, error: 'no UOA log' }; }

  var enriched = 0;
  var skipped = 0;
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (!e.timestamp || new Date(e.timestamp).getTime() < cutoff) continue;
    if (e.peakReturn && Date.now() - new Date(e.peakReturn.enrichedAt).getTime() < 5 * 60 * 1000) {
      skipped++;
      continue;
    }
    var updated = await enrichLogEntry(e);
    if (updated.peakReturn) enriched++;
  }
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); } catch (e) {}
  return { ok: true, enriched: enriched, skipped: skipped, totalScanned: log.length };
}

module.exports = {
  getPeakReturn: getPeakReturn,
  enrichLogEntry: enrichLogEntry,
  backfillUoaLog: backfillUoaLog,
};
