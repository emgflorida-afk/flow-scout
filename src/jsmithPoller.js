// jsmithPoller.js -- Stratum v7.5
// -----------------------------------------------------------------
// Polls three JSmithTrades.com Discord channels via Discord REST API
// using a user token (stored as DISCORD_USER_TOKEN env var).
// Dedups by message ID, parses new posts via jsmithParser, converts
// John ideas into queue items, and POSTs them via bulkAddQueuedTrades.
// CapitalFlow events feed a confirmation store used for enrichment.
// -----------------------------------------------------------------
// NOTE: Using a user token (self-bot) is technically against Discord
// ToS. This poller is deliberately read-only, low-rate (60s cadence,
// 10 messages per channel), and touches only channels the user is
// already subscribed to. Risk is low but non-zero. Use with eyes open.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs = require('fs');
var parser = require('./jsmithParser');

// Channel IDs -- hardcoded but env-overridable
var CHAN = {
  VIP_FLOW_OPTIONS:   process.env.CHAN_VIP_FLOW_OPTIONS   || '1417547885754712134',
  OPTION_TRADE_IDEAS: process.env.CHAN_OPTION_TRADE_IDEAS || '1401666517292023940',
  CAPITAL_FLOW:       process.env.CHAN_CAPITAL_FLOW       || '1411518843964096684',
};

// Discord API base
var DISCORD_API = 'https://discord.com/api/v10';

// Dedup store -- last-seen message id per channel + set of seen ids
var SEEN_FILE = '/tmp/jsmith_seen.json';
var seen = { byChannel: {}, ids: {} };
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || seen;
      if (!seen.ids) seen.ids = {};
      if (!seen.byChannel) seen.byChannel = {};
    }
  } catch(e) { console.error('[JSMITH] seen load error:', e.message); }
}
function saveSeen() {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); }
  catch(e) { console.error('[JSMITH] seen save error:', e.message); }
}
loadSeen();

// CapitalFlow events ring buffer — last 200 events, used for enrichment
var flowEvents = [];
var FLOW_MAX = 200;
function recordFlowEvent(ev) {
  flowEvents.push({ ev: ev, at: Date.now() });
  if (flowEvents.length > FLOW_MAX) flowEvents.shift();
}
function flowEventsForTicker(ticker, direction, maxAgeMs) {
  var cutoff = Date.now() - (maxAgeMs || 24 * 60 * 60 * 1000);
  return flowEvents.filter(function(e) {
    return e.at >= cutoff &&
           e.ev.ticker === ticker &&
           e.ev.direction === direction;
  }).map(function(e){ return e.ev; });
}

// -----------------------------------------------------------------
// DISCORD API -- fetch latest messages from a channel
// -----------------------------------------------------------------
async function fetchMessages(channelId, limit, token) {
  limit = limit || 10;
  try {
    var url = DISCORD_API + '/channels/' + channelId + '/messages?limit=' + limit;
    var res = await fetch(url, {
      headers: {
        'Authorization': token, // user tokens have NO "Bearer" prefix
        'User-Agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Discord/Stratum-Brief',
      },
    });
    if (!res.ok) {
      console.error('[JSMITH] fetch ' + channelId + ' ' + res.status);
      return [];
    }
    return await res.json();
  } catch(e) {
    console.error('[JSMITH] fetch error:', e.message);
    return [];
  }
}

// -----------------------------------------------------------------
// Convert a parsed John idea into the queue schema.
// -----------------------------------------------------------------
function johnIdeaToQueueItem(idea) {
  if (!idea || !idea.ticker || !idea.strike || !idea.expiry) return null;

  // Build TradeStation contract symbol: "TICKER YYMMDDC<strike>"
  // idea.expiry is "2026-05-15"
  var yymmdd = idea.expiry.slice(2,4) + idea.expiry.slice(5,7) + idea.expiry.slice(8,10);
  var cp = idea.direction === 'call' ? 'C' : 'P';
  var strikeStr = Number.isInteger(idea.strike) ? String(idea.strike) : String(idea.strike);
  var contractSymbol = idea.ticker + ' ' + yymmdd + cp + strikeStr;

  // Max entry -- VIP gets a bit more headroom
  var maxEntry = idea.tier === 'VIP' ? 6.00 : 4.00;

  // tradeDate = tomorrow if posted after 5 PM ET, else today
  var now = new Date();
  var etHour = parseInt(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }), 10);
  var d = new Date();
  if (etHour >= 17) d.setDate(d.getDate() + 1);
  var tradeDate = d.toISOString().slice(0,10);

  return {
    ticker:         idea.ticker,
    direction:      idea.direction === 'call' ? 'CALLS' : 'PUTS',
    triggerPrice:   idea.triggerPrice,
    contractSymbol: contractSymbol,
    strike:         idea.strike,
    expiration:     idea.expiry.slice(5,7) + '-' + idea.expiry.slice(8,10) + '-' + idea.expiry.slice(0,4),
    contractType:   idea.direction === 'call' ? 'Call' : 'Put',
    maxEntryPrice:  maxEntry,
    stopPct:        -(idea.stopPct || 25),
    contracts:      idea.tier === 'VIP' ? 3 : 2, // VIP = bill-payer size, normal = 2
    tradeDate:      tradeDate,
    tradeType:      idea.tradeType || 'DAY',
    source:         'JSMITH_' + idea.tier + '_' + idea.ticker,
    note:           'Auto-parsed from Discord. Tier=' + idea.tier +
                    (idea.backupContract ? ' | Backup:' + idea.backupContract.strike + (idea.backupContract.label || '') : ''),
  };
}

// -----------------------------------------------------------------
// Send confirm alert to Discord webhook (user taps YES manually)
// -----------------------------------------------------------------
async function postConfirmAlert(item, idea, webhookUrl) {
  if (!webhookUrl) return;
  try {
    var tag = idea.tier === 'VIP' ? '💎 VIP' : '📘 NORMAL';
    var ftag = flowEventsForTicker(idea.ticker, idea.direction, 24*60*60*1000);
    var flowTag = ftag.length > 0 ? ' ✅ Flow AGREES (' + ftag.length + ')' : ' ⚪ No flow match';
    var lines = [
      tag + ' JSMITH — ' + idea.ticker + ' ' + idea.direction.toUpperCase() + flowTag,
      '────────────────────────────────',
      'Trigger:  ' + (idea.direction === 'call' ? '≥ ' : '≤ ') + '$' + idea.triggerPrice,
      'Contract: ' + item.contractSymbol + ' x' + item.contracts,
      'Max:      $' + item.maxEntryPrice.toFixed(2),
      'Stop:     -' + (idea.stopPct || 25) + '%',
      'TP:       ' + (idea.tpLevels || [25,50,100]).map(function(t){return t+'%';}).join(' / '),
      idea.backupContract ? 'Backup:   ' + idea.backupContract.strike + ' ' + idea.backupContract.expiry + ' (' + (idea.backupContract.label||'alt') + ')' : '',
      '────────────────────────────────',
      'Status: PENDING_CONFIRM — reply via /api/queue/confirm/' + idea.ticker,
    ].filter(Boolean).join('\n');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum JSmith Feed',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) {
    console.error('[JSMITH] postConfirmAlert error:', e.message);
  }
}

// -----------------------------------------------------------------
// POLL A SINGLE CHANNEL
// -----------------------------------------------------------------
async function pollChannel(channelId, token) {
  var messages = await fetchMessages(channelId, 10, token);
  if (!Array.isArray(messages) || !messages.length) return { parsed: 0 };

  // Discord returns newest first; reverse to process oldest-new-first
  messages.reverse();

  var parsed = 0;
  var newIdeas = [];

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!msg || !msg.id) continue;
    if (seen.ids[msg.id]) continue;

    var text = parser.flattenMessage(msg);
    var result = parser.parseByChannel(channelId, text);

    if (result) {
      parsed++;
      if (result.source === 'jsmith') {
        newIdeas.push(result);
      } else if (result.source === 'capitalflow') {
        recordFlowEvent(result);
      }
    }

    seen.ids[msg.id] = Date.now();
  }

  // Trim seen.ids to last 500 entries to prevent unbounded growth
  var idKeys = Object.keys(seen.ids);
  if (idKeys.length > 500) {
    idKeys.sort(function(a,b){ return seen.ids[a] - seen.ids[b]; });
    var toDelete = idKeys.slice(0, idKeys.length - 500);
    toDelete.forEach(function(k){ delete seen.ids[k]; });
  }
  saveSeen();

  return { parsed: parsed, newIdeas: newIdeas };
}

// -----------------------------------------------------------------
// MAIN CYCLE
// -----------------------------------------------------------------
var _cycleRunning = false;
async function runPollCycle(opts) {
  opts = opts || {};
  if (_cycleRunning) return { skipped: 'already running' };
  var token = opts.token || process.env.DISCORD_USER_TOKEN;
  if (!token) {
    // Silent bail -- poller is a no-op until token is set
    return { skipped: 'no DISCORD_USER_TOKEN' };
  }

  _cycleRunning = true;
  try {
    var webhookUrl = process.env.DISCORD_JSMITH_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;

    // Poll flow channel first so enrichment has fresh events before John ideas come in
    var flowResult = await pollChannel(CHAN.CAPITAL_FLOW, token);
    var vipResult  = await pollChannel(CHAN.VIP_FLOW_OPTIONS, token);
    var otiResult  = await pollChannel(CHAN.OPTION_TRADE_IDEAS, token);

    var allNew = []
      .concat(vipResult.newIdeas || [])
      .concat(otiResult.newIdeas || []);

    if (allNew.length === 0) {
      return { flow: flowResult.parsed, john: 0 };
    }

    // Convert to queue items
    var queueItems = [];
    for (var i = 0; i < allNew.length; i++) {
      var q = johnIdeaToQueueItem(allNew[i]);
      if (q) queueItems.push({ item: q, idea: allNew[i] });
    }

    // Push to brain queue
    if (queueItems.length > 0) {
      try {
        var be = require('./brainEngine');
        if (be && be.bulkAddQueuedTrades) {
          be.bulkAddQueuedTrades(queueItems.map(function(x){ return x.item; }), { replaceAll: false });
        }
      } catch(e) { console.error('[JSMITH] queue push error:', e.message); }

      // Post confirm alerts
      for (var j = 0; j < queueItems.length; j++) {
        await postConfirmAlert(queueItems[j].item, queueItems[j].idea, webhookUrl);
      }
    }

    return {
      flow:   flowResult.parsed,
      john:   allNew.length,
      queued: queueItems.length,
    };
  } catch(e) {
    console.error('[JSMITH] cycle error:', e.message);
    return { error: e.message };
  } finally {
    _cycleRunning = false;
  }
}

module.exports = {
  runPollCycle,
  pollChannel,
  johnIdeaToQueueItem,
  flowEventsForTicker,
  CHAN,
};
