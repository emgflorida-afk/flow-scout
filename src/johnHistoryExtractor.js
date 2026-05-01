// johnHistoryExtractor.js — backfill John VIP options ideas before subscription ends
//
// Pulls full message history from John's two trade-idea channels:
//   1. #vip-flow-options-alerts
//   2. #option-trade-ideas
//
// Discovers channel IDs by NAME (no need to copy IDs manually).
// Uses Discord REST API directly — no discord.js client overhead.
// Writes raw + parsed JSON to /Users/NinjaMon/Desktop/flow-scout/data/john_history/
//
// Usage: node src/johnHistoryExtractor.js
// Env required: DISCORD_BOT_TOKEN
// (GUILD_ID is the JSmithTrades server — hardcoded below since we know it)
//
// Note: bot must be a member of the JSmithTrades server with "Read Message History"
// permission on both target channels. If 403/404 errors, that's the issue.

// CLI mode: load .env from /tmp; cron mode: env already in process.env
try { require('dotenv').config({ path: '/tmp/john_extract.env' }); } catch (e) {}
var fs = require('fs');
var path = require('path');
var jsmithParser = require('./jsmithParser');

// Direct channel IDs (discovered from list — most reliable, skips fuzzy match issues)
var TARGET_CHANNELS_BY_ID = [
  { name: 'option-trade-ideas',     id: '1401666517292023940' },
  { name: 'vip-flow-options-alerts', id: '1417547885754712134' },
  { name: 'free-charts',              id: '1373875477420179476' },
  // CVO (different guild) — swings + leaps with chart analysis
  { name: 'cvo-swings-leaps',         id: '1437546513160212610' },
];

// OUT_DIR respects Railway /data volume; falls back to local repo data dir
var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var OUT_DIR = path.join(DATA_ROOT, 'john_history');
fs.mkdirSync(OUT_DIR, { recursive: true });

var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

function api(p) {
  return 'https://discord.com/api/v10' + p;
}

// Read token at call-time so cron mode (loaded after env is set) works
function getTokenInfo() {
  var userToken = process.env.DISCORD_USER_TOKEN;
  var botToken  = process.env.DISCORD_BOT_TOKEN;
  var token = userToken || botToken;
  return { token: token, isUserToken: !!userToken };
}

function authHeader() {
  var t = getTokenInfo();
  if (!t.token) throw new Error('No DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN in env');
  var auth = t.isUserToken ? t.token : ('Bot ' + t.token);
  return {
    'Authorization': auth,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };
}

async function listGuilds() {
  var r = await fetchLib(api('/users/@me/guilds'), { headers: authHeader() });
  if (!r.ok) throw new Error('list-guilds-' + r.status);
  return r.json();
}

async function listChannels(guildId) {
  var r = await fetchLib(api('/guilds/' + guildId + '/channels'), { headers: authHeader() });
  if (!r.ok) throw new Error('list-channels-' + r.status);
  return r.json();
}

async function fetchMessages(channelId, beforeId) {
  var url = api('/channels/' + channelId + '/messages?limit=100' + (beforeId ? '&before=' + beforeId : ''));
  var r = await fetchLib(url, { headers: authHeader() });
  if (!r.ok) throw new Error('fetch-messages-' + r.status + '-' + channelId);
  return r.json();
}

async function backfillChannel(channel, opts) {
  opts = opts || {};
  var incremental = opts.incremental === true;
  console.log('[EXTRACT] ' + (incremental ? 'incremental ' : 'full ') + '#' + channel.name + ' (' + channel.id + ')...');

  // Load existing raw.json so we can dedupe-merge
  var rawPath = path.join(OUT_DIR, channel.name + '.raw.json');
  var existing = [];
  if (fs.existsSync(rawPath)) {
    try { existing = JSON.parse(fs.readFileSync(rawPath, 'utf8')) || []; }
    catch (e) { console.warn('  existing raw parse fail: ' + e.message); existing = []; }
  }

  var allMessages = [];
  var beforeId = null;
  var page = 0;
  // Incremental: just fetch the most recent page (100 msgs) — cron runs every 15min
  // so 100 covers the gap with huge margin. Full mode = paginate to oldest.
  var maxPages = incremental ? 1 : 1000;
  while (page < maxPages) {
    page++;
    var batch;
    try {
      batch = await fetchMessages(channel.id, beforeId);
    } catch (e) {
      console.error('  page ' + page + ' fetch error:', e.message);
      break;
    }
    if (!batch || batch.length === 0) break;
    allMessages = allMessages.concat(batch);
    console.log('  page ' + page + ': +' + batch.length + ' messages, total=' + allMessages.length);
    beforeId = batch[batch.length - 1].id;
    await new Promise(function(r){ setTimeout(r, 250); });
    if (batch.length < 100) break;
  }

  // Merge with existing (existing wins on dupe — preserves edits/reactions)
  if (incremental && existing.length) {
    var existingIds = new Set(existing.map(function(m) { return m.id; }));
    var fresh = allMessages.filter(function(m) { return !existingIds.has(m.id); });
    allMessages = fresh.concat(existing);
    console.log('  merged: ' + fresh.length + ' new + ' + existing.length + ' existing');
  }

  // Save raw (rawPath was set at top of function)
  fs.writeFileSync(rawPath, JSON.stringify(allMessages, null, 2));
  console.log('  raw saved -> ' + rawPath + ' (' + allMessages.length + ' msgs)');

  // Parse each via jsmithParser.parseJohnFeed
  // Most John posts come from the "Option Trade Ideas" bot with content in embeds.
  var parsed = [];
  var parseFails = 0;
  for (var i = 0; i < allMessages.length; i++) {
    var msg = allMessages[i];
    var content = msg.content || '';
    // Always concat embed text for parsing — that's where the trade details live
    if (msg.embeds && msg.embeds.length) {
      var embedText = msg.embeds.map(function(e){
        return [e.title, e.description].filter(Boolean).join('\n');
      }).join('\n\n');
      content = (content + '\n' + embedText).trim();
    }
    if (!content || content.length < 30) continue;
    try {
      var trade = jsmithParser.parseJohnFeed(content);
      if (trade && (trade.ticker || trade.symbol)) {
        parsed.push({
          msg_id: msg.id,
          posted_at: msg.timestamp,
          author: msg.author && msg.author.username,
          channel: channel.name,
          raw: content,
          trade: trade,
        });
      }
    } catch (e) {
      parseFails++;
    }
  }
  var parsedPath = path.join(OUT_DIR, channel.name + '.parsed.json');
  fs.writeFileSync(parsedPath, JSON.stringify(parsed, null, 2));
  console.log('  parsed -> ' + parsedPath + ' (' + parsed.length + ' trades, ' + parseFails + ' parse-fails)');

  return { raw: allMessages.length, parsed: parsed.length };
}

// Track in-flight runs so cron can't double-fire
var _running = false;
var _lastRun = null;

async function runOnce(opts) {
  opts = opts || {};
  var incremental = opts.incremental === true;

  if (_running) {
    return { ok: false, error: 'extractor already running', skipped: true };
  }
  _running = true;
  var start = Date.now();

  try {
    var t = getTokenInfo();
    if (!t.token) {
      return { ok: false, error: 'No DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN in env' };
    }
    console.log('[EXTRACT] ' + (incremental ? 'incremental' : 'full') + ' run · using ' + (t.isUserToken ? 'USER token' : 'BOT token'));

    var targets = TARGET_CHANNELS_BY_ID.slice();

    var summary = {};
    var errors = [];
    for (var i = 0; i < targets.length; i++) {
      try {
        summary[targets[i].name] = await backfillChannel(targets[i], { incremental: incremental });
      } catch (e) {
        console.error('[EXTRACT] ' + targets[i].name + ' failed: ' + e.message);
        errors.push({ channel: targets[i].name, error: e.message });
        summary[targets[i].name] = { error: e.message };
      }
    }

    var tookMs = Date.now() - start;
    _lastRun = { startedAt: new Date(start).toISOString(), tookMs: tookMs, summary: summary, errors: errors, incremental: incremental };
    console.log('[EXTRACT] done in ' + tookMs + 'ms');
    return { ok: errors.length === 0, tookMs: tookMs, summary: summary, errors: errors };
  } finally {
    _running = false;
  }
}

function getStatus() {
  return { running: _running, lastRun: _lastRun, outDir: OUT_DIR };
}

module.exports = {
  runOnce: runOnce,
  getStatus: getStatus,
  TARGET_CHANNELS_BY_ID: TARGET_CHANNELS_BY_ID,
};

// CLI entry point: only run if invoked directly (node johnHistoryExtractor.js)
if (require.main === module) {
  var incremental = process.argv.indexOf('--incremental') !== -1;
  runOnce({ incremental: incremental })
    .then(function(r) {
      console.log('[EXTRACT] result:');
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch(function(e) {
      console.error('[EXTRACT] fatal:', e.message);
      console.error(e.stack);
      process.exit(1);
    });
}
