// =============================================================================
// JOHN REPEAT-PICK FLAGGER — flag tickers AB is considering that John has
// historically picked. AB's pain point May 5: NTAP was John's pick, hit
// profitably, but AB only got 2ct on Public because BP was tied up in
// system-pitched ABBV/SBUX (which both lost). Lesson: John's track record
// > new system pitches. Size accordingly.
//
// PURPOSE:
//   When a flow alert / scanner row surfaces a ticker, check if John has
//   previously picked the same ticker+direction in last N days. If yes,
//   flag the row with 🔁 REPEAT badge so AB knows this is a proven setup,
//   not a fresh untested pitch.
//
// PHASE-1 (THIS BUILD):
//   - Just FLAG repeats (date + count)
//   - No outcome data yet (johnPatternMatcher blocker — outcomes not stored)
//
// PHASE-2 (post-close):
//   - Hydrate peakReturn on each past pick → compute hit rate per ticker
//   - "🔁 NTAP — John picked 3x in 30d, 2 winners (avg +35%)"
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var JOHN_HISTORY_DIR = path.join(DATA_ROOT, 'john_history');

// In-memory cache so we don't re-read files on every action-radar poll
var _cache = { loadedAt: 0, picks: [] };
var CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min

function loadAllPicks() {
  if (Date.now() - _cache.loadedAt < CACHE_TTL_MS && _cache.picks.length > 0) {
    return _cache.picks;
  }

  var picks = [];
  try {
    if (!fs.existsSync(JOHN_HISTORY_DIR)) return [];
    var files = fs.readdirSync(JOHN_HISTORY_DIR).filter(function(f) {
      return f.endsWith('.parsed.json');
    });
    files.forEach(function(f) {
      try {
        var raw = fs.readFileSync(path.join(JOHN_HISTORY_DIR, f), 'utf8');
        var data = JSON.parse(raw);
        // File can be array of trades OR { trades: [...] }
        var trades = Array.isArray(data) ? data : (data.trades || []);
        trades.forEach(function(t) {
          var trade = t.trade || t;
          if (trade && trade.ticker) {
            picks.push({
              ticker: String(trade.ticker).toUpperCase(),
              direction: String(trade.direction || '').toLowerCase(),
              tradeType: trade.tradeType || 'unknown',
              triggerPrice: trade.triggerPrice,
              strike: trade.strike,
              expiry: trade.expiry,
              postedAt: t.posted_at || trade.postedAt,
              tier: trade.tier || 'NORMAL',
              channel: t.channel || f.replace('.parsed.json', ''),
              source: f,
            });
          }
        });
      } catch (e) {
        console.error('[JOHN-REPEAT] parse error in ' + f + ':', e.message);
      }
    });
  } catch (e) {
    console.error('[JOHN-REPEAT] load error:', e.message);
  }

  _cache = { loadedAt: Date.now(), picks: picks };
  return picks;
}

// Find John's prior picks on (ticker, direction) within last N days.
// Direction matches: 'long' ↔ 'call', 'short' ↔ 'put'.
function findRecentPicks(ticker, direction, daysBack) {
  daysBack = daysBack || 30;
  var picks = loadAllPicks();
  var cutoff = Date.now() - (daysBack * 24 * 3600 * 1000);
  var dirNorm = direction === 'long' ? 'call' : (direction === 'short' ? 'put' : direction);
  var matches = picks.filter(function(p) {
    var sameTicker = p.ticker === String(ticker).toUpperCase();
    var sameDir = p.direction === dirNorm || p.direction === direction;
    var ts = p.postedAt ? new Date(p.postedAt).getTime() : 0;
    return sameTicker && sameDir && ts >= cutoff;
  });
  matches.sort(function(a, b) {
    return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime();
  });
  return matches;
}

// Repeat-flag summary for UI badge
function getRepeatFlag(ticker, direction, daysBack) {
  var picks = findRecentPicks(ticker, direction, daysBack || 30);
  if (picks.length === 0) {
    return { isRepeat: false, count: 0, picks: [] };
  }
  var mostRecent = picks[0];
  return {
    isRepeat: true,
    count: picks.length,
    daysSinceMostRecent: Math.round((Date.now() - new Date(mostRecent.postedAt).getTime()) / (24 * 3600 * 1000)),
    mostRecentDate: mostRecent.postedAt,
    mostRecentContract: (mostRecent.strike ? '$' + mostRecent.strike : '') +
                        (mostRecent.direction === 'call' ? 'C' : 'P') +
                        (mostRecent.expiry ? ' ' + mostRecent.expiry : ''),
    tier: mostRecent.tier,
    picks: picks.slice(0, 5),  // last 5 most recent
  };
}

// Force cache refresh
function reload() {
  _cache = { loadedAt: 0, picks: [] };
  return loadAllPicks();
}

// Bulk flag — for action-radar / scanner cards. Returns map of ticker → flag.
function getBulkFlags(rows, daysBack) {
  var result = {};
  (rows || []).forEach(function(r) {
    if (!r.ticker || !r.direction) return;
    var key = r.ticker + ':' + r.direction;
    if (result[key]) return;
    result[key] = getRepeatFlag(r.ticker, r.direction, daysBack);
  });
  return result;
}

module.exports = {
  loadAllPicks: loadAllPicks,
  findRecentPicks: findRecentPicks,
  getRepeatFlag: getRepeatFlag,
  getBulkFlags: getBulkFlags,
  reload: reload,
};
