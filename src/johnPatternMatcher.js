// =============================================================================
// JOHN PATTERN MATCHER (Apr 30 2026 — v6 PM)
//
// Surfaces "John precedent" on each scanner card. Uses the 1,917 archived
// Discord messages we extracted Apr 29-30 (option-trade-ideas: 152 trades,
// vip-flow-options-alerts: 97 trades, free-charts/Sniper Trades: 1,264 raw msgs).
//
// API:
//   findPrecedent(ticker, direction, opts)
//     → returns { matches: [...], total, ticker, direction }
//     each match: { date, source, ticker, direction, contract, outcome }
//
//   summarize(ticker, direction)
//     → returns aggregate: { trades: N, sample: [...], lastSeenDays }
//
// AB ask: "Use the data extracted to train the brain. When a setup repeats,
// know the move." This first cut surfaces RAW historical mentions per ticker —
// useful for "John has played this 7 times in last 6 months" confluence.
//
// Future: combine with Bullflow archive + outcomes for real win-rate stats.
// =============================================================================

var fs = require('fs');
var path = require('path');

// Try local Desktop path first (where we extracted), fall back to Railway /data
var CANDIDATE_DIRS = [
  process.env.JOHN_HISTORY_DIR,
  path.join(__dirname, '..', 'data', 'john_history'),
  '/data/john_history',
  '/Users/NinjaMon/Desktop/flow-scout/data/john_history',
].filter(Boolean);

var CHANNELS = [
  { name: 'option-trade-ideas',     parsedFile: 'option-trade-ideas.parsed.json' },
  { name: 'vip-flow-options-alerts', parsedFile: 'vip-flow-options-alerts.parsed.json' },
  { name: 'free-charts',             parsedFile: 'free-charts.parsed.json',
                                      rawFile:    'free-charts.raw.json' },
];

// In-memory index: built once on first call, kept in process memory.
var INDEX = null;        // { ticker: { LONG: [...trades], SHORT: [...trades] } }
var INDEX_BUILD_AT = null;

function findHistoryDir() {
  for (var i = 0; i < CANDIDATE_DIRS.length; i++) {
    if (CANDIDATE_DIRS[i] && fs.existsSync(CANDIDATE_DIRS[i])) {
      return CANDIDATE_DIRS[i];
    }
  }
  return null;
}

// Direction inference from a parsed trade record.
// John data parser uses callPut field; if missing, infer from contract symbol.
function inferDir(trade) {
  var t = trade.trade || trade;
  if (!t) return null;
  if (t.callPut === 'C' || t.direction === 'CALL' || t.direction === 'LONG') return 'LONG';
  if (t.callPut === 'P' || t.direction === 'PUT'  || t.direction === 'SHORT') return 'SHORT';
  // Sniff from raw text
  var text = (t.raw || trade.raw || '').toLowerCase();
  if (/\bcall\b|\blong\b|\bbull/.test(text)) return 'LONG';
  if (/\bput\b|\bshort\b|\bbear/.test(text)) return 'SHORT';
  return null;
}

function inferTicker(trade) {
  var t = trade.trade || trade;
  if (!t) return null;
  if (t.ticker)  return t.ticker.toUpperCase();
  if (t.symbol)  return t.symbol.toUpperCase();
  // Sniff from raw text — first ticker-like token
  var text = (trade.raw || t.raw || '');
  var m = text.match(/\b([A-Z]{2,5})\b/);
  return m ? m[1] : null;
}

function buildIndex() {
  var dir = findHistoryDir();
  if (!dir) {
    INDEX = {};
    INDEX_BUILD_AT = Date.now();
    return { built: 0, dir: null, error: 'history dir not found' };
  }

  var idx = {};
  var totalLoaded = 0;

  for (var i = 0; i < CHANNELS.length; i++) {
    var ch = CHANNELS[i];
    var fp = path.join(dir, ch.parsedFile);
    if (!fs.existsSync(fp)) continue;
    try {
      var arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var entry = arr[j];
        var ticker = inferTicker(entry);
        var dir2 = inferDir(entry);
        if (!ticker) continue;
        if (!idx[ticker]) idx[ticker] = { LONG: [], SHORT: [], UNKNOWN: [] };
        var key = dir2 || 'UNKNOWN';
        idx[ticker][key].push({
          ticker:    ticker,
          direction: dir2,
          source:    ch.name,
          date:      entry.posted_at || entry.timestamp || null,
          author:    entry.author || null,
          contract:  (entry.trade && (entry.trade.contract || entry.trade.symbol)) || null,
          strike:    entry.trade && entry.trade.strike,
          expiry:    entry.trade && entry.trade.expiry,
          entry:     entry.trade && (entry.trade.entry || entry.trade.tradePrice),
          target:    entry.trade && (entry.trade.target || entry.trade.tp1),
          stop:      entry.trade && entry.trade.stop,
          rawText:   (entry.raw || '').slice(0, 280),
        });
        totalLoaded++;
      }
    } catch (e) {
      console.error('[JPM] parse error in', fp, e.message);
    }
  }

  INDEX = idx;
  INDEX_BUILD_AT = Date.now();
  console.log('[JPM] index built:', totalLoaded, 'trades across', Object.keys(idx).length, 'tickers');
  return { built: totalLoaded, tickers: Object.keys(idx).length, dir: dir };
}

function ensureIndex() {
  if (!INDEX || (Date.now() - (INDEX_BUILD_AT || 0)) > 1000 * 60 * 60) {
    return buildIndex();
  }
  return { built: -1, cached: true };
}

// ----- Public API -----
function findPrecedent(ticker, direction, opts) {
  opts = opts || {};
  ensureIndex();
  var t = (ticker || '').toUpperCase();
  var d = (direction || '').toUpperCase();
  var results = [];
  if (INDEX[t]) {
    if (d === 'LONG' || d === 'SHORT') {
      results = (INDEX[t][d] || []).slice();
      // Optionally include UNKNOWN-direction matches (raw mentions)
      if (opts.includeUnknown) {
        results = results.concat(INDEX[t].UNKNOWN || []);
      }
    } else {
      // No direction filter — return everything
      results = (INDEX[t].LONG || []).concat(INDEX[t].SHORT || [], INDEX[t].UNKNOWN || []);
    }
  }
  // Sort by date desc (most recent first)
  results.sort(function(a, b) {
    return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  });
  var limit = opts.limit || 10;
  return {
    ticker:    t,
    direction: d || 'ANY',
    total:     results.length,
    matches:   results.slice(0, limit),
  };
}

function summarize(ticker, direction) {
  var r = findPrecedent(ticker, direction, { limit: 5 });
  if (!r.total) {
    return { ticker: r.ticker, direction: r.direction, trades: 0, found: false };
  }
  // Rough "last seen" age in days
  var lastSeenDate = r.matches[0] && r.matches[0].date ? new Date(r.matches[0].date) : null;
  var lastSeenDays = lastSeenDate ? Math.round((Date.now() - lastSeenDate.getTime()) / (24 * 3600 * 1000)) : null;
  return {
    ticker: r.ticker,
    direction: r.direction,
    trades: r.total,
    found: true,
    lastSeenDays: lastSeenDays,
    sample: r.matches.map(function(m) {
      return {
        date: m.date ? m.date.slice(0, 10) : null,
        source: m.source,
        contract: m.contract,
      };
    }),
  };
}

function getStatus() {
  if (!INDEX) ensureIndex();
  var tickers = INDEX ? Object.keys(INDEX) : [];
  var totalTrades = 0;
  var topTickers = [];
  for (var i = 0; i < tickers.length; i++) {
    var t = tickers[i];
    var c = (INDEX[t].LONG.length + INDEX[t].SHORT.length + INDEX[t].UNKNOWN.length);
    totalTrades += c;
    topTickers.push({ ticker: t, count: c });
  }
  topTickers.sort(function(a, b) { return b.count - a.count; });
  return {
    indexBuiltAt: INDEX_BUILD_AT ? new Date(INDEX_BUILD_AT).toISOString() : null,
    historyDir: findHistoryDir(),
    totalTickers: tickers.length,
    totalTrades: totalTrades,
    topTickers: topTickers.slice(0, 20),
  };
}

module.exports = {
  findPrecedent: findPrecedent,
  summarize: summarize,
  getStatus: getStatus,
  buildIndex: buildIndex,    // exposed for forced rebuild
};
