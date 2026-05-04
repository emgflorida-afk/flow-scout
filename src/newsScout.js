// =============================================================================
// NEWS SCOUT — Hedge fund "News Desk." Pulls market headlines, flags material
// events, pushes Discord on keywords matching AB's watch terms.
//
// SOURCES (no API key needed):
//   • Yahoo Finance market headlines RSS
//   • CNBC top stories RSS
//   • MarketWatch top stories RSS
//   • Reuters business RSS (if available)
//
// MATERIAL KEYWORD CATEGORIES:
//   1. WAR / GEOPOLITICAL: Iran, war, escalation, Strait of Hormuz, attack, missile
//   2. MACRO / FED: Fed, FOMC, rate, inflation, CPI, NFP, PCE, jobs report
//   3. ENERGY: oil, OPEC, crude, Brent, gasoline, gas prices
//   4. CORPORATE EARNINGS: NVDA, AAPL, MSFT, AMZN, META, GOOGL, TSLA earnings
//   5. CRASH / VOL: crash, plunge, flash crash, circuit breaker, halt, panic
//
// PUSH RULES:
//   • Score each headline by keyword count + category weight
//   • Push if score >= 5 AND not seen in last 4 hours (cooldown by URL hash)
//   • Include sentiment hint (bullish/bearish/neutral) based on keywords
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var SEEN_FILE = path.join(DATA_ROOT, 'news_seen.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var FEEDS = [
  { name: 'Yahoo Finance', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI,^VIX&region=US&lang=en-US' },
  { name: 'CNBC Markets', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { name: 'CNBC Top', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch Top', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
];

var KEYWORDS = {
  war: { weight: 8, terms: ['iran', 'war', 'escalation', 'strait of hormuz', 'missile', 'attack', 'strike on', 'military', 'troops', 'israel', 'gaza', 'lebanon', 'hezbollah'] },
  macro: { weight: 7, terms: ['fed', 'fomc', 'rate cut', 'rate hike', 'jay powell', 'inflation', 'cpi report', 'pce', 'nfp', 'jobs report', 'unemployment', 'jolts', 'ism'] },
  energy: { weight: 5, terms: ['oil price', 'opec', 'crude', 'brent', 'gasoline', 'oil supply', 'oil disruption'] },
  earnings: { weight: 6, terms: ['nvda earnings', 'aapl earnings', 'msft earnings', 'amzn earnings', 'meta earnings', 'googl earnings', 'tsla earnings', 'beats earnings', 'misses earnings', 'guidance cut', 'guidance raise'] },
  panic: { weight: 9, terms: ['crash', 'plunge', 'flash crash', 'circuit breaker', 'trading halt', 'panic selling', 'sell-off', 'market rout', 'meltdown', 'capitulation'] },
  bull: { weight: 4, terms: ['rally', 'breakout', 'all-time high', 'record high', 'surge', 'soar', 'rebound', 'recovery'] },
};

var BEARISH_TERMS = ['crash', 'plunge', 'sell-off', 'rout', 'meltdown', 'panic', 'fear', 'recession', 'downgrade', 'misses', 'guidance cut', 'attack', 'escalation'];
var BULLISH_TERMS = ['rally', 'breakout', 'all-time high', 'beats', 'guidance raise', 'rebound', 'recovery', 'surge', 'optimism'];

// ─── HELPERS ──────────────────────────────────────────────────────────────
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveSeen(map) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(map, null, 2)); } catch (e) {}
}

function hashUrl(url) {
  return require('crypto').createHash('md5').update(url || '').digest('hex').slice(0, 16);
}

function isSeen(url) {
  var seen = loadSeen();
  var h = hashUrl(url);
  if (!seen[h]) return false;
  var ageHr = (Date.now() - new Date(seen[h]).getTime()) / 3600000;
  return ageHr < 4;  // 4-hour cooldown
}

function markSeen(url) {
  var seen = loadSeen();
  seen[hashUrl(url)] = new Date().toISOString();
  // Cleanup old (older than 24h)
  var now = Date.now();
  Object.keys(seen).forEach(function(k) {
    if (now - new Date(seen[k]).getTime() > 24 * 3600000) delete seen[k];
  });
  saveSeen(seen);
}

// Naive RSS parser — extracts <item><title>...</title><link>...</link></item>
function parseRSS(xml) {
  var items = [];
  var itemRegex = /<item[\s\S]*?<\/item>/g;
  var match;
  var matches = xml.match(itemRegex) || [];
  matches.forEach(function(itemXml) {
    var titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    var linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    var descMatch = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    var pubMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (titleMatch && linkMatch) {
      items.push({
        title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
        url: linkMatch[1].trim(),
        description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : '',
        pubDate: pubMatch ? pubMatch[1].trim() : '',
      });
    }
  });
  return items;
}

// Score a headline against keyword categories
function scoreHeadline(title, description) {
  var text = (title + ' ' + description).toLowerCase();
  var totalScore = 0;
  var categoriesHit = [];
  Object.keys(KEYWORDS).forEach(function(cat) {
    var spec = KEYWORDS[cat];
    var hits = 0;
    spec.terms.forEach(function(t) {
      if (text.includes(t)) hits++;
    });
    if (hits > 0) {
      totalScore += hits * spec.weight;
      categoriesHit.push(cat);
    }
  });

  var sentiment = 'neutral';
  var bearHits = BEARISH_TERMS.filter(function(t) { return text.includes(t); }).length;
  var bullHits = BULLISH_TERMS.filter(function(t) { return text.includes(t); }).length;
  if (bearHits > bullHits) sentiment = 'bearish';
  else if (bullHits > bearHits) sentiment = 'bullish';

  return { score: totalScore, categories: categoriesHit, sentiment: sentiment };
}

// ─── DISCORD PUSH ─────────────────────────────────────────────────────────
async function pushNewsAlert(headline, scoreData, source) {
  var sentimentEmoji = scoreData.sentiment === 'bearish' ? '🔴' : scoreData.sentiment === 'bullish' ? '🟢' : '🟡';
  var sentimentColor = scoreData.sentiment === 'bearish' ? 15158332 : scoreData.sentiment === 'bullish' ? 5763719 : 16753920;

  var embed = {
    username: 'Flow Scout — News Scout',
    embeds: [{
      title: sentimentEmoji + ' ' + headline.title.slice(0, 240),
      url: headline.url,
      description: headline.description ? headline.description.slice(0, 300) : '',
      color: sentimentColor,
      fields: [
        {
          name: '📊 Score / Categories',
          value: 'Score: **' + scoreData.score + '** (threshold 5)\nHits: ' + scoreData.categories.join(', '),
          inline: true,
        },
        {
          name: '🎯 Read',
          value: scoreData.sentiment.toUpperCase() + ' tilt' +
                 (scoreData.categories.includes('war') ? ' · Geo flag 🚨' : '') +
                 (scoreData.categories.includes('panic') ? ' · MARKET STRESS 🚨' : '') +
                 (scoreData.categories.includes('macro') ? ' · Macro 📊' : ''),
          inline: true,
        },
      ],
      footer: { text: 'Flow Scout | News Scout | source: ' + source },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    await fetchLib(DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(embed), timeout: 5000 });
    console.log('[NEWS-SCOUT] PUSH: ' + headline.title.slice(0, 60));
  } catch (e) { console.log('[NEWS-SCOUT] discord error:', e.message); }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function runScout() {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var alertsSent = 0;
  var totalParsed = 0;

  for (var i = 0; i < FEEDS.length; i++) {
    var feed = FEEDS[i];
    try {
      var r = await fetchLib(feed.url, { timeout: 8000, headers: { 'User-Agent': 'flow-scout-news-bot/1.0' } });
      if (!r.ok) continue;
      var xml = await r.text();
      var items = parseRSS(xml);
      totalParsed += items.length;

      for (var j = 0; j < items.length; j++) {
        var h = items[j];
        if (isSeen(h.url)) continue;
        var score = scoreHeadline(h.title, h.description);
        if (score.score >= 5) {
          await pushNewsAlert(h, score, feed.name);
          markSeen(h.url);
          alertsSent++;
          // Rate limit Discord
          await new Promise(function(res) { setTimeout(res, 1500); });
        } else {
          // Mark as seen even if low score so we don't reprocess every cron
          markSeen(h.url);
        }
      }
    } catch (e) { console.log('[NEWS-SCOUT] feed error ' + feed.name + ':', e.message); }
  }

  console.log('[NEWS-SCOUT] Parsed ' + totalParsed + ' headlines across ' + FEEDS.length + ' feeds, ' + alertsSent + ' alerts sent');
  return { totalParsed: totalParsed, alertsSent: alertsSent };
}

module.exports = {
  runScout: runScout,
  scoreHeadline: scoreHeadline,
};
