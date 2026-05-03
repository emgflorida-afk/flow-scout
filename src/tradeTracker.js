// =============================================================================
// TRADE TRACKER — Phase 3 — paper-validation framework for auto-fire.
//
// Records EVERY decision (auto-fire proposal, manual execution, vision review,
// confluence score) along with outcomes N bars later. Builds the dataset
// needed to validate the system before going live with real broker auto-fire.
//
// HIT-RATE TRACKING:
// - Records confluence tier at fire time
// - Records direction + trigger + stop + targets
// - After 7 trading days OR explicit user-marked outcome:
//     compute win/loss/breakeven
//     compute R-multiple achieved
//     attribute to confluence tier for hit-rate stats
//
// DECISION GATE:
// - If A++ trades show >=65% win rate over 30 trades → safe to enable auto-fire
// - If <65% → tune scoring weights, retest
//
// DATA STORE: /data/trade_log.json (append-only)
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var LOG_FILE = path.join(DATA_ROOT, 'trade_log.json');

function load() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { return []; }
}

function save(records) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(records, null, 2)); } catch (e) {}
}

// Record a fire decision (called when auto-fire proposes OR when AB manually fires)
function logFire(record) {
  var records = load();
  var entry = {
    id: 'tt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    loggedAt: new Date().toISOString(),
    ticker: record.ticker,
    direction: record.direction,
    pattern: record.pattern || null,
    confluenceTier: record.confluenceTier || null,
    confluenceScore: record.confluenceScore || null,
    sourceTab: record.sourceTab || null,
    triggerPrice: record.triggerPrice,
    stopPrice: record.stopPrice,
    tp1: record.tp1,
    tp2: record.tp2,
    rr1: record.rr1 || null,
    spreadType: record.spreadType || null,
    longStrike: record.longStrike || null,
    shortStrike: record.shortStrike || null,
    expiry: record.expiry || null,
    contracts: record.contracts || 1,
    debit: record.debit || null,
    credit: record.credit || null,
    fireMethod: record.fireMethod || 'manual',  // 'manual' | 'autofire-proposed' | 'autofire-fired'
    visionVerdict: record.visionVerdict || null,
    researchVerdict: record.researchVerdict || null,
    notes: record.notes || null,
    outcome: null,  // populated later
    closedAt: null,
    closedPrice: null,
    rRealized: null,
    pnl: null,
    pnlPct: null,
  };
  records.push(entry);
  save(records);
  return entry;
}

// Mark a previously logged trade as closed with outcome
function markClosed(id, opts) {
  var records = load();
  var rec = records.find(function(r) { return r.id === id; });
  if (!rec) return { ok: false, error: 'trade id not found: ' + id };

  rec.closedAt = opts.closedAt || new Date().toISOString();
  rec.closedPrice = opts.closedPrice;
  rec.outcome = opts.outcome;  // 'win' | 'loss' | 'breakeven'
  rec.rRealized = opts.rRealized;  // R-multiple (e.g., +1.8R, -1R)
  rec.pnl = opts.pnl;
  rec.pnlPct = opts.pnlPct;
  rec.notes = (rec.notes || '') + (opts.closeNotes ? ' | ' + opts.closeNotes : '');

  save(records);
  return { ok: true, record: rec };
}

// Stats by confluence tier — the BIG question: does A++ actually win 65%+?
function getStatsByTier() {
  var records = load();
  var closed = records.filter(function(r) { return r.outcome !== null && r.outcome !== undefined; });

  var byTier = {};
  closed.forEach(function(r) {
    var tier = r.confluenceTier || 'unknown';
    if (!byTier[tier]) {
      byTier[tier] = {
        tier: tier,
        total: 0, wins: 0, losses: 0, breakevens: 0,
        sumR: 0, totalPnl: 0,
      };
    }
    var t = byTier[tier];
    t.total++;
    if (r.outcome === 'win') t.wins++;
    if (r.outcome === 'loss') t.losses++;
    if (r.outcome === 'breakeven') t.breakevens++;
    if (typeof r.rRealized === 'number') t.sumR += r.rRealized;
    if (typeof r.pnl === 'number') t.totalPnl += r.pnl;
  });

  Object.values(byTier).forEach(function(t) {
    t.winRate = t.total > 0 ? Math.round((t.wins / t.total) * 100) : 0;
    t.avgR = t.total > 0 ? Math.round((t.sumR / t.total) * 100) / 100 : 0;
    t.autoFireReady = (t.tier === 'A++') && t.winRate >= 65 && t.total >= 30;
  });

  return {
    totalRecords: records.length,
    closedRecords: closed.length,
    openRecords: records.length - closed.length,
    byTier: byTier,
    autoFireValidated: byTier['A++'] && byTier['A++'].autoFireReady,
    note: byTier['A++'] && !byTier['A++'].autoFireReady
      ? 'Need ' + Math.max(0, 30 - (byTier['A++'].total || 0)) + ' more A++ trades + ' +
        (byTier['A++'].winRate < 65 ? '65%+ win rate (currently ' + byTier['A++'].winRate + '%)' : 'continued performance')
      : null,
  };
}

// Stats by source tab (JS / COIL / WP) — which scanner has best edge?
function getStatsBySource() {
  var records = load();
  var closed = records.filter(function(r) { return r.outcome !== null && r.outcome !== undefined; });
  var bySource = {};
  closed.forEach(function(r) {
    var src = r.sourceTab || 'unknown';
    if (!bySource[src]) bySource[src] = { total: 0, wins: 0, sumR: 0 };
    bySource[src].total++;
    if (r.outcome === 'win') bySource[src].wins++;
    if (typeof r.rRealized === 'number') bySource[src].sumR += r.rRealized;
  });
  Object.values(bySource).forEach(function(s) {
    s.winRate = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    s.avgR = s.total > 0 ? Math.round((s.sumR / s.total) * 100) / 100 : 0;
  });
  return bySource;
}

function listOpen() {
  return load().filter(function(r) { return r.outcome === null || r.outcome === undefined; });
}

function listAll(opts) {
  opts = opts || {};
  var records = load();
  if (opts.ticker) records = records.filter(function(r) { return r.ticker === opts.ticker.toUpperCase(); });
  if (opts.tier) records = records.filter(function(r) { return r.confluenceTier === opts.tier; });
  if (opts.outcome) records = records.filter(function(r) { return r.outcome === opts.outcome; });
  return records;
}

module.exports = {
  logFire: logFire,
  markClosed: markClosed,
  getStatsByTier: getStatsByTier,
  getStatsBySource: getStatsBySource,
  listOpen: listOpen,
  listAll: listAll,
};
