// newsScanner.js  (Plan 01 — News Catalyst Feed)
// ---------------------------------------------------------------
// Free-tier news feed: SEC EDGAR 8-K filings + FINRA regulatory
// notices. Polled every 60s during market hours. Matches headlines
// against a watchlist and posts Discord alerts to the executeNow
// channel. NEVER auto-executes a trade — alert only.
//
// Triggering event: Apr 14 2026 — SEC Release 34-105226 (FINRA 4210
// amendment eliminating PDT rule). HOOD +8.8% in 90 min, brain had
// zero visibility. This module fills that gap.
//
// v1 sources (free):
//   - SEC EDGAR "current" 8-K atom feed
//   - FINRA regulatory notices atom feed
//   - SEC releases (34-* press releases)
// v2 (weekend): Benzinga API, X list scraper
// ---------------------------------------------------------------

var fetch = require('node-fetch');

var EXECUTE_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// Sources (all Atom / RSS — no API key required)
var SOURCES = [
  {
    id:   'SEC_8K',
    name: 'SEC EDGAR 8-K',
    url:  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom',
    kind: 'atom',
  },
  {
    id:   'SEC_RELEASE',
    name: 'SEC Press Releases',
    url:  'https://www.sec.gov/news/pressreleases.rss',
    kind: 'rss',
  },
  {
    id:   'FINRA',
    name: 'FINRA Notices',
    url:  'https://www.finra.org/rss/notices.xml',
    kind: 'rss',
  },
];

// Tickers we care about — matches the brain watchlist + majors
var WATCHLIST = [
  'SPY','QQQ','IWM','DIA','VIX',
  'NVDA','AAPL','MSFT','GOOGL','GOOG','AMZN','META','TSLA','NFLX','AMD','AVGO',
  'HOOD','COIN','MSTR','SCHW','IBKR','SOFI','PLTR','SMCI','ARM','MU',
  'JPM','BAC','WFC','GS','MS','C',
  'XOM','CVX','OXY','SLB',
  'BA','CAT','GE','LMT','RTX',
  'UNH','LLY','JNJ','PFE','MRK','ABBV','HCA',
  'WMT','COST','TGT','HD','LOW','CHWY','PPG','KO','PEP',
  'MRVL','ORCL','CRM','ADBE','INTC','QCOM','TXN',
];

// Keyword -> (sentiment, magnitude). Matches against headline text.
var KEYWORDS = [
  // Bullish
  { re: /approves?|approved|authoriz|upgrades?|beats? estimates|record (?:revenue|quarter|earnings)|acquires?|acquisition|merger|buyback|dividend increase|raises? guidance|outperform/i,
    sentiment: 'BULL', mag: 2 },
  { re: /breakthrough|FDA approval|landmark|settlement reached|contract awarded/i,
    sentiment: 'BULL', mag: 3 },
  // Bearish
  { re: /investigation|subpoena|lawsuit|fraud|recall|halts?|suspends?|delist|bankruptcy|misses? estimates|cuts? guidance|downgrade|going concern/i,
    sentiment: 'BEAR', mag: 3 },
  { re: /warning|breach|hack|layoffs|restructur|impair|writedown|delays/i,
    sentiment: 'BEAR', mag: 2 },
  // Rule changes / regulatory
  { re: /rule change|amendment|rescinds?|eliminates?|pattern day trader|PDT|margin requirement|circuit breaker/i,
    sentiment: 'NEUTRAL', mag: 2 },
];

// Seen cache — keyed by entry id/link, TTL 12 hours so we don't re-alert
var _seen = {};
var SEEN_TTL_MS = 12 * 60 * 60 * 1000;

function pruneSeen() {
  var now = Date.now();
  var keys = Object.keys(_seen);
  for (var i = 0; i < keys.length; i++) {
    if (now - _seen[keys[i]] > SEEN_TTL_MS) delete _seen[keys[i]];
  }
}

// ------------------------------------------------------------
// Minimal Atom/RSS parser — regex-based, no xml2js dep.
// Returns [{id, title, link, updated, summary}]
// ------------------------------------------------------------
function parseFeed(xml, kind) {
  if (!xml || typeof xml !== 'string') return [];
  var items = [];

  if (kind === 'atom') {
    var entryRe = /<entry[\s\S]*?<\/entry>/g;
    var entries = xml.match(entryRe) || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var title   = (e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      var link    = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      var updated = (e.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '';
      var id      = (e.match(/<id[^>]*>([\s\S]*?)<\/id>/) || [])[1] || link || title;
      var summary = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
      items.push({
        id:      stripTags(id).trim(),
        title:   stripTags(title).trim(),
        link:    link.trim(),
        updated: updated.trim(),
        summary: stripTags(summary).trim(),
      });
    }
  } else {
    // RSS 2.0
    var itemRe = /<item[\s\S]*?<\/item>/g;
    var rawItems = xml.match(itemRe) || [];
    for (var j = 0; j < rawItems.length; j++) {
      var it = rawItems[j];
      var t  = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      var l  = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
      var p  = (it.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      var g  = (it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || l || t;
      var d  = (it.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '';
      items.push({
        id:      stripTags(g).trim(),
        title:   stripTags(t).trim(),
        link:    stripTags(l).trim(),
        updated: p.trim(),
        summary: stripTags(d).trim(),
      });
    }
  }
  return items;
}

function stripTags(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

// ------------------------------------------------------------
// Extract tickers from a headline. Matches against WATCHLIST.
// Uses word-boundary for exact symbol match and also looks at
// the plain $TICKER convention.
// ------------------------------------------------------------
function extractTickers(text) {
  if (!text) return [];
  var up = text.toUpperCase();
  var found = {};
  for (var i = 0; i < WATCHLIST.length; i++) {
    var t = WATCHLIST[i];
    // Word-boundary match or "$TICKER"
    var re = new RegExp('(^|[^A-Z])' + t + '([^A-Z0-9]|$)');
    if (re.test(up)) found[t] = true;
  }
  return Object.keys(found);
}

// ------------------------------------------------------------
// Score a news item. Returns {sentiment, magnitude, matched[]}
// ------------------------------------------------------------
function scoreNews(item) {
  var text = (item.title || '') + ' ' + (item.summary || '');
  var best = { sentiment: 'NEUTRAL', mag: 0, matched: [] };
  for (var i = 0; i < KEYWORDS.length; i++) {
    var k = KEYWORDS[i];
    if (k.re.test(text)) {
      if (k.mag > best.mag) {
        best.sentiment = k.sentiment;
        best.mag       = k.mag;
      }
      best.matched.push(k.sentiment + ':' + k.mag);
    }
  }
  return best;
}

function ageMinutes(updatedStr) {
  if (!updatedStr) return null;
  var t = Date.parse(updatedStr);
  if (!isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

// ------------------------------------------------------------
// Discord alert.
// ------------------------------------------------------------
async function postAlert(source, item, tickers, score) {
  var ageMin = ageMinutes(item.updated);
  var ageStr = ageMin == null ? 'unknown' : (ageMin + ' min');
  var freshTag = ageMin != null && ageMin <= 10 ? 'FRESH' : 'STALE';

  var lines = [
    'NEWS CATALYST — ' + source.name,
    'Tickers: ' + tickers.join(', '),
    'Headline: ' + (item.title || '').slice(0, 180),
    'Sentiment: ' + score.sentiment + ' (mag ' + score.mag + '/3)',
    'Age: ' + ageStr + ' [' + freshTag + ']',
    'Link: ' + (item.link || 'n/a'),
    '---',
    freshTag === 'FRESH'
      ? 'WATCH — align with 2HR chart before entry. Never trade news alone.'
      : 'Already priced in. Informational only.',
  ];
  try {
    await fetch(EXECUTE_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + lines.join('\n') + '\n```',
        username: 'NewsScanner',
      }),
    });
    console.log('[NEWS] alert posted:', tickers.join(','), '|', item.title.slice(0, 80));
  } catch (e) {
    console.error('[NEWS] alert error:', e.message);
  }
}

// ------------------------------------------------------------
// Fetch + process one source.
// ------------------------------------------------------------
async function scanSource(source) {
  var alerts = 0;
  try {
    var res = await fetch(source.url, {
      headers: {
        // SEC requires a descriptive UA including contact
        'User-Agent': 'FlowScout Trading Research contact@flowscout.local',
        'Accept':     'application/atom+xml,application/rss+xml,application/xml,text/xml',
      },
      timeout: 15000,
    });
    if (!res.ok) {
      console.log('[NEWS]', source.id, 'HTTP', res.status);
      return 0;
    }
    var xml = await res.text();
    var items = parseFeed(xml, source.kind);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.id) continue;
      if (_seen[it.id]) continue;
      _seen[it.id] = Date.now();

      var tickers = extractTickers(it.title + ' ' + it.summary);
      if (!tickers.length) continue;

      var score = scoreNews(it);
      // Skip pure-neutral zero-magnitude noise
      if (score.sentiment === 'NEUTRAL' && score.mag === 0) continue;

      await postAlert(source, it, tickers, score);
      alerts++;
    }
  } catch (e) {
    console.error('[NEWS]', source.id, 'error:', e.message);
  }
  return alerts;
}

// ------------------------------------------------------------
// Main entry — poll every source once.
// ------------------------------------------------------------
async function scanAll() {
  pruneSeen();
  var t0 = Date.now();
  var totalAlerts = 0;
  for (var i = 0; i < SOURCES.length; i++) {
    totalAlerts += await scanSource(SOURCES[i]);
  }
  console.log('[NEWS] cycle done alerts:', totalAlerts, 'ms:', Date.now() - t0);
  return { alerts: totalAlerts };
}

// Query recent news for a ticker by scanning current seen cache summaries.
// v1 stub — real v2 would maintain a rolling store.
function getRecentNews(ticker, minutes) {
  return { ticker: ticker, minutes: minutes || 60, items: [] };
}

module.exports = {
  scanAll:        scanAll,
  scanSource:     scanSource,
  scoreNews:      scoreNews,
  extractTickers: extractTickers,
  parseFeed:      parseFeed,
  getRecentNews:  getRecentNews,
  WATCHLIST:      WATCHLIST,
  SOURCES:        SOURCES,
};
