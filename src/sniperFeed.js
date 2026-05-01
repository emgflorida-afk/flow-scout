// =============================================================================
// SNIPER FEED (May 1 2026)
//
// Pulls Sniper Trades #free-charts channel (1373875477420179476) — chart-
// analysis posts with embed titles like "TSLA — DESCENDING CHANNEL UPPER TEST".
// Different shape from John VIP picks (no specific entry/stop), just narrative
// analysis with key levels.
//
// Returns:
//   {
//     updatedAt,
//     posts: [
//       {
//         ticker, title, body, attachmentUrls, postedAt, author
//       }
//     ]
//   }
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HIST_DIR = path.join(DATA_ROOT, 'john_history');
var SOURCE_FILE = 'free-charts.raw.json';

var FRESHNESS_DAYS = parseInt(process.env.SNIPER_FRESHNESS_DAYS || '14');

function extractTickerFromTitle(title) {
  if (!title) return null;
  // Format: "TSLA — DESCENDING CHANNEL UPPER TEST" or "$AAPL bla bla"
  var m = title.match(/^([A-Z]{1,5})\s+[—–-]/) || title.match(/^\$([A-Z]{1,5})/) || title.match(/\b([A-Z]{2,5})\b/);
  return m ? m[1] : null;
}

function loadFeed(opts) {
  opts = opts || {};
  var fp = path.join(HIST_DIR, SOURCE_FILE);
  if (!fs.existsSync(fp)) return { posts: [], note: 'free-charts.raw.json missing' };

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
    var ts = m.timestamp;
    if (!ts) continue;
    var tsMs = new Date(ts).getTime();
    if (isNaN(tsMs) || tsMs < cutoffMs) continue;

    var embeds = m.embeds || [];
    var atts = m.attachments || [];

    // Build a normalized post
    var title = '';
    var body = '';
    var imageUrl = null;

    if (embeds.length) {
      title = (embeds[0].title || '').trim();
      body  = (embeds[0].description || '').trim();
      // Some embeds carry image url
      if (embeds[0].image && embeds[0].image.url) imageUrl = embeds[0].image.url;
      else if (embeds[0].thumbnail && embeds[0].thumbnail.url) imageUrl = embeds[0].thumbnail.url;
    }

    var attachmentUrls = atts.map(function(a) { return a.url; }).filter(Boolean);

    // Skip "empty" messages — must have a title OR an attachment OR a body
    if (!title && !body && !attachmentUrls.length) continue;

    var ticker = extractTickerFromTitle(title) || extractTickerFromTitle(body.slice(0, 100));

    posts.push({
      msgId:        m.id,
      ticker:       ticker,
      title:        title,
      body:         body.slice(0, 600),
      imageUrl:     imageUrl,
      attachmentUrls: attachmentUrls,
      postedAt:     ts,
      author:       (m.author || {}).username || null,
      hasChart:     attachmentUrls.length > 0 || !!imageUrl,
    });
  }

  // Sort newest first
  posts.sort(function(a, b) { return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(); });

  return {
    updatedAt:    new Date().toISOString(),
    historyDir:   HIST_DIR,
    freshnessDays: FRESHNESS_DAYS,
    totalPosts:   posts.length,
    posts:        posts.slice(0, opts.limit || 30),
  };
}

module.exports = {
  loadFeed: loadFeed,
};
