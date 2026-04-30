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

require('dotenv').config({ path: '/tmp/john_extract.env' });
var fs = require('fs');
var path = require('path');
var jsmithParser = require('./jsmithParser');

// Prefer USER_TOKEN (reads JSmithTrades server you're a member of).
// Fallback to BOT_TOKEN (only works in Stratum where the bot was added).
var USER_TOKEN = process.env.DISCORD_USER_TOKEN;
var BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
var TOKEN = USER_TOKEN || BOT_TOKEN;
var IS_USER_TOKEN = !!USER_TOKEN;
// Direct channel IDs (discovered from list — most reliable, skips fuzzy match issues)
var TARGET_CHANNELS_BY_ID = [
  { name: 'option-trade-ideas',     id: '1401666517292023940' },
  { name: 'vip-flow-options-alerts', id: '1417547885754712134' },
  { name: 'free-charts',              id: '1373875477420179476' },
];

if (!TOKEN) {
  console.error('[EXTRACT] No DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN — aborting');
  process.exit(1);
}
console.log('[EXTRACT] using ' + (IS_USER_TOKEN ? 'USER token' : 'BOT token'));

var OUT_DIR = '/Users/NinjaMon/Desktop/flow-scout/data/john_history';
fs.mkdirSync(OUT_DIR, { recursive: true });

var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

function api(p) {
  return 'https://discord.com/api/v10' + p;
}

function authHeader() {
  // User tokens are bare; bot tokens require "Bot " prefix
  var auth = IS_USER_TOKEN ? TOKEN : ('Bot ' + TOKEN);
  return {
    'Authorization': auth,
    'Content-Type': 'application/json',
    // Some Discord routes require a User-Agent for user-token auth
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

async function backfillChannel(channel) {
  console.log('[EXTRACT] backfilling #' + channel.name + ' (' + channel.id + ')...');
  var allMessages = [];
  var beforeId = null;
  var page = 0;
  while (true) {
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
    // Discord rate limit: ~50 reqs / sec, but we throttle for safety
    await new Promise(function(r){ setTimeout(r, 250); });
    if (batch.length < 100) break;  // last page
  }

  // Save raw
  var rawPath = path.join(OUT_DIR, channel.name + '.raw.json');
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

async function main() {
  console.log('[EXTRACT] starting John history backfill');

  // Discover the JSmith server (or use hardcoded GUILD_ID)
  var jsmithGuildId = process.env.JSMITH_GUILD_ID;
  if (!jsmithGuildId) {
    var guilds = await listGuilds();
    var jsmith = guilds.find(function(g){
      return /jsmith|john.*smith|smith/i.test(g.name);
    });
    if (!jsmith) {
      console.error('[EXTRACT] could not find JSmithTrades guild. Available guilds:');
      guilds.forEach(function(g){ console.error('  - ' + g.name + ' (' + g.id + ')'); });
      process.exit(1);
    }
    jsmithGuildId = jsmith.id;
    console.log('[EXTRACT] found guild: ' + jsmith.name + ' (' + jsmith.id + ')');
  }

  // Use direct channel IDs — most reliable
  var targets = TARGET_CHANNELS_BY_ID.map(function(t){
    return { id: t.id, name: t.name };
  });

  console.log('[EXTRACT] targeting ' + targets.length + ' channels by ID:');
  targets.forEach(function(c){ console.log('  - #' + c.name + ' (' + c.id + ')'); });

  var summary = {};
  for (var i = 0; i < targets.length; i++) {
    summary[targets[i].name] = await backfillChannel(targets[i]);
  }

  console.log('[EXTRACT] DONE. Summary:');
  console.log(JSON.stringify(summary, null, 2));
  console.log('Files saved to: ' + OUT_DIR);
}

main().catch(function(e){
  console.error('[EXTRACT] fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});
