// =============================================================================
// BULLFLOW CUSTOM FILTER REGISTRY — what each of AB's saved alerts means.
//
// Bullflow's /v1/streaming/alerts emits alerts with data.alertType === 'custom'
// when a saved filter in AB's dashboard fires. The data.alertName is the
// human-readable name AB gave the filter.
//
// This module maps each known filter name → behavioral metadata so the rest
// of the pipeline can do filter-aware things:
//
//   1. Direction inference: "AB Bullish Flow" forces direction=long even
//      if OPRA parsing failed
//   2. Alignment check: filter says Bullish but OPRA is PUT → COUNTER-SIGNAL
//   3. Score weighting: 100k Sweep weighs more than Unusual Vol
//   4. Premium floor: filter's expected min premium for sanity-check
//   5. Auto-fire eligibility: only some filters should auto-fire SIM
//
// ADD NEW FILTERS: append to KNOWN_FILTERS or drop a JSON override file at
// /data/bullflow_custom_filters.json which merges over the defaults at load.
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var OVERRIDES_FILE = path.join(DATA_ROOT, 'bullflow_custom_filters.json');

// AB's saved Bullflow alerts (May 5 2026 — 6 total)
var KNOWN_FILTERS = {
  'repeat high sig': {
    direction: 'either',          // not directional on its own — OPRA C/P decides
    weight: 6,                    // high-confidence — Bullflow's repeat-flow algo
    premiumFloor: 50000,          // $50K+ typical
    autoFireEligible: true,
    description: 'Bullflow Repeat-Significance algo — same OPRA contract repeated by institutionals',
  },
  '100k aa, sweep': {
    direction: 'either',
    weight: 8,                    // very high — $100K + Above-Ask + Sweep = aggressive institutional
    premiumFloor: 100000,
    autoFireEligible: true,
    description: '$100K+ premium, Above-Ask, Sweep — aggressive institutional entry',
  },
  'ab bullish flow': {
    direction: 'long',            // directional — overrides OPRA if needed
    weight: 7,
    premiumFloor: 0,
    autoFireEligible: true,
    description: "AB's directional bull filter — flow only, calls + sweeps + Above-Ask",
  },
  '75k, aa, sweep': {
    direction: 'either',
    weight: 7,                    // high — $75K AA Sweep slightly less than 100K version
    premiumFloor: 75000,
    autoFireEligible: true,
    description: '$75K+ premium, Above-Ask, Sweep — institutional entry',
  },
  'ab bearish flow': {
    direction: 'short',
    weight: 7,
    premiumFloor: 0,
    autoFireEligible: true,
    description: "AB's directional bear filter — flow only, puts + sweeps + Above-Ask",
  },
  'unusual vol': {
    direction: 'either',
    weight: 5,                    // medium — vol/OI ratio anomaly, not always actionable
    premiumFloor: 0,
    autoFireEligible: false,      // require manual confirm — vol can be late OI rebalance
    description: 'Unusual volume (vol/OI ratio) — early signal, often noisy',
  },
};

// Lazy-load + merge overrides file
var _cache = null;
function loadFilters() {
  if (_cache) return _cache;
  _cache = Object.assign({}, KNOWN_FILTERS);
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      var overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
      Object.keys(overrides).forEach(function(k) {
        var key = k.toLowerCase().trim();
        _cache[key] = Object.assign({}, _cache[key] || {}, overrides[k]);
      });
    }
  } catch (e) {
    console.error('[BULLFLOW-FILTERS] override load error:', e.message);
  }
  return _cache;
}

// Look up filter metadata by name (case-insensitive). Returns null if unknown.
function getFilterMeta(name) {
  if (!name) return null;
  var key = String(name).toLowerCase().trim();
  var filters = loadFilters();
  if (filters[key]) return Object.assign({ name: name, key: key, known: true }, filters[key]);

  // Fuzzy fallback — match starting substring (e.g. "ab bull" matches "ab bullish flow")
  var keys = Object.keys(filters);
  var fuzzy = keys.find(function(k) {
    return key.indexOf(k) === 0 || k.indexOf(key) === 0;
  });
  if (fuzzy) return Object.assign({ name: name, key: fuzzy, known: true, fuzzy: true }, filters[fuzzy]);

  return { name: name, key: key, known: false, direction: 'either', weight: 5, autoFireEligible: false };
}

// Resolve final direction given filter name + OPRA-parsed direction.
// Returns { direction, alignment, source }.
//   - direction: long | short | unknown
//   - alignment: aligned | mismatch | filter-only | opra-only | unknown
//   - source: which decided
function resolveDirection(filterName, opraDirection) {
  var meta = getFilterMeta(filterName);
  var filterDir = meta ? meta.direction : 'either';

  // Filter is directional
  if (filterDir === 'long' || filterDir === 'short') {
    if (opraDirection === filterDir) {
      return { direction: filterDir, alignment: 'aligned', source: 'both', filterMeta: meta };
    }
    if (opraDirection === 'unknown' || !opraDirection) {
      return { direction: filterDir, alignment: 'filter-only', source: 'filter', filterMeta: meta };
    }
    // Filter says X, OPRA says Y → counter-signal
    return { direction: filterDir, alignment: 'mismatch', source: 'filter-overrides', filterMeta: meta, opraDirection: opraDirection };
  }

  // Filter is non-directional ("either") — OPRA decides
  if (opraDirection === 'long' || opraDirection === 'short') {
    return { direction: opraDirection, alignment: 'opra-only', source: 'opra', filterMeta: meta };
  }

  return { direction: 'unknown', alignment: 'unknown', source: 'none', filterMeta: meta };
}

// List all known filters (for /api/bullflow-filters endpoint)
function listFilters() {
  var filters = loadFilters();
  return Object.keys(filters).map(function(k) {
    return Object.assign({ key: k }, filters[k]);
  });
}

// Force reload (after overrides JSON is edited)
function reload() {
  _cache = null;
  return loadFilters();
}

module.exports = {
  getFilterMeta: getFilterMeta,
  resolveDirection: resolveDirection,
  listFilters: listFilters,
  reload: reload,
  KNOWN_FILTERS: KNOWN_FILTERS,
};
