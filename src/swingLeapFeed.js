// =============================================================================
// SWING/LEAP FEED (May 1 2026)
//
// Pulls #cvo-trades-swings-leaps channel (1437546513160212610) — chart-based
// swing/leap analysis posts from cvo_trades.
//
// Format observed:
//   - Author: cvo_trades (30/35 posts in initial backfill)
//   - Content: ticker + brief comment (e.g. "RGTI", "QMCO (no options)")
//   - Charts: 1-2 PNG attachments per post (the actual setup info)
//   - Occasional macro commentary posts (no chart)
//
// Returns:
//   {
//     updatedAt,
//     posts: [
//       {
//         msgId, ticker, body, attachmentUrls, chartCount, hasChart, postedAt, author
//       }
//     ]
//   }
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HIST_DIR = path.join(DATA_ROOT, 'john_history');
var SOURCE_FILE = 'cvo-swings-leaps.raw.json';

// Wider window than day-trade channels — these are swings/leaps held weeks-months
var FRESHNESS_DAYS = parseInt(process.env.SWING_LEAP_FRESHNESS_DAYS || '30');

// Only main analyst posts — filter out replies/chatter
var ALLOWED_AUTHORS = (process.env.SWING_LEAP_AUTHORS || 'cvo_trades').split(',');

function extractTicker(content) {
  if (!content) return null;
  var s = content.trim();
  // Patterns: "RGTI", "$RGTI", "RGTI (comment)", "RGTI - long setup"
  var m = s.match(/^\$?([A-Z]{1,5})\b/);
  if (!m) return null;
  // Filter common false positives (English words that look like tickers)
  var fp = ['NEW', 'THE', 'BUY', 'SELL', 'LONG', 'SHORT', 'UP', 'DOWN', 'OUT', 'IN',
            'TP', 'SL', 'ATM', 'OTM', 'ITM', 'DTE', 'ETA', 'PSA', 'OK', 'YES', 'NO',
            'A', 'I', 'IS', 'AS', 'TO', 'OF', 'AT', 'IF', 'ON', 'OR', 'BE', 'GO'];
  if (fp.indexOf(m[1]) !== -1) return null;
  if (m[1].length < 2) return null;
  return m[1];
}

function loadFeed(opts) {
  opts = opts || {};
  var fp = path.join(HIST_DIR, SOURCE_FILE);
  if (!fs.existsSync(fp)) {
    return {
      posts: [],
      note: SOURCE_FILE + ' missing — run johnHistoryExtractor.js to backfill',
      historyDir: HIST_DIR,
    };
  }

  var arr;
  try {
    arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return { posts: [], error: 'parse: ' + e.message };
  }
  if (!Array.isArray(arr)) return { posts: [], error: 'expected array' };

  var cutoffMs = Date.now() - FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  var posts = [];

  for (var i = 0; i < arr.length; i++) {
    var m = arr[i];
    var author = (m.author || {}).username || '';
    if (ALLOWED_AUTHORS.indexOf(author) === -1) continue;

    var ts = m.timestamp;
    if (!ts) continue;
    var tsMs = new Date(ts).getTime();
    if (isNaN(tsMs) || tsMs < cutoffMs) continue;

    var content = (m.content || '').trim();
    var atts = m.attachments || [];
    var attachmentUrls = atts.map(function(a) { return a.url; }).filter(Boolean);

    // Skip if no chart AND no useful content (filters meta posts under 20 chars w/o image)
    if (!attachmentUrls.length && content.length < 20) continue;

    var ticker = extractTicker(content);

    // Embed image fallback (rare for this channel but handle it)
    var embeds = m.embeds || [];
    if (embeds.length && embeds[0].image && embeds[0].image.url) {
      attachmentUrls.push(embeds[0].image.url);
    }

    posts.push({
      msgId:          m.id,
      ticker:         ticker,
      body:           content.slice(0, 600),
      attachmentUrls: attachmentUrls,
      chartCount:     attachmentUrls.length,
      hasChart:       attachmentUrls.length > 0,
      postedAt:       ts,
      author:         author,
      isCommentary:   !ticker && !attachmentUrls.length,  // macro posts
    });
  }

  // Sort newest first
  posts.sort(function(a, b) { return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(); });

  // Optional: filter to only chart-bearing picks (default false — show all)
  if (opts.onlyCharts) {
    posts = posts.filter(function(p) { return p.hasChart; });
  }

  return {
    updatedAt:     new Date().toISOString(),
    historyDir:    HIST_DIR,
    sourceFile:    SOURCE_FILE,
    freshnessDays: FRESHNESS_DAYS,
    totalPosts:    posts.length,
    posts:         posts.slice(0, opts.limit || 30),
  };
}

module.exports = {
  loadFeed: loadFeed,
  extractTicker: extractTicker,
};
