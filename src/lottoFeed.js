// =============================================================================
// LOTTO FEED (May 1 2026)
//
// Pulls John's latest VIP day-trade picks (the cheap-call lotto plays) and
// shapes them as cards for scanner-v2's 🎰 LOTTO tab. Reads the same parsed
// JSON files johnPatternMatcher uses (/data/john_history/*.parsed.json).
//
// Scope: last 7 days of posts, sorted newest first, deduped by ticker
// (only most recent pick per ticker).
//
// Returns:
//   {
//     updatedAt,
//     picks: [
//       {
//         ticker, direction, contract, optionEntry, stop, target,
//         postedAt, source, dollarRiskPerCt, why
//       }
//     ]
//   }
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HIST_DIR = path.join(DATA_ROOT, 'john_history');

var CHANNELS_PARSED = [
  'option-trade-ideas.parsed.json',
  'vip-flow-options-alerts.parsed.json',
];
// Also read RAW because the strict parser drops fresh "DAY TRADE" embed posts
var CHANNELS_RAW = [
  'option-trade-ideas.raw.json',
  'vip-flow-options-alerts.raw.json',
];

var FRESHNESS_DAYS = parseInt(process.env.LOTTO_FRESHNESS_DAYS || '7');

function parseEntry(entry) {
  var t = entry.trade || {};
  var raw = (entry.raw || '');
  // Try to extract option contract details from the raw text
  // Sample: "Contracts: 5C 5/1 Exp" or "Contracts: 264.65c 2/23 Exp"
  var contractMatch = raw.match(/Contracts:\s*(\d+(?:\.\d+)?)([cCpP])\s*(\d+\/\d+)/);
  var entryMatch    = raw.match(/Call Entry:\s*([\d.]+)/i) || raw.match(/Put Entry:\s*([\d.]+)/i) || raw.match(/Entry:\s*([\d.]+)/i);
  var stopMatch     = raw.match(/Stop Loss:\s*([\d.\-%]+)/i);

  var strike = contractMatch ? parseFloat(contractMatch[1]) : null;
  var cp     = contractMatch ? contractMatch[2].toUpperCase() : null;
  var exp    = contractMatch ? contractMatch[3] : null;
  var stockEntry = entryMatch ? parseFloat(entryMatch[1]) : null;
  var stopVal = stopMatch ? stopMatch[1] : null;
  var stopNum = (stopVal && /^[\d.]+$/.test(stopVal)) ? parseFloat(stopVal) : null;

  return {
    ticker:    t.ticker || (raw.match(/\$([A-Z]{1,5})/) || [])[1] || null,
    direction: cp === 'C' ? 'CALL' : cp === 'P' ? 'PUT' : null,
    strike:    strike,
    expiry:    exp,
    stockEntry: stockEntry,
    stockStop: stopNum,
    rawStop:   stopVal,
    contractDesc: contractMatch ? (strike + (cp || '') + ' ' + exp) : null,
  };
}

// Parse a raw Discord message — extract trade fields from embed bodies.
// John's bot posts the trade card as embeds[0].description with pipe-or-newline separators.
function parseRawMessage(msg, channelName) {
  var ts = msg.timestamp;
  var embeds = msg.embeds || [];
  // Find the first embed with a trade-card body
  var body = null;
  for (var i = 0; i < embeds.length; i++) {
    var b = (embeds[i].description || '');
    if (/Ticker:|Entry:|Contracts:/i.test(b)) { body = b; break; }
  }
  if (!body) return null;
  // Re-use parseEntry logic — wrap in a fake entry object with .raw set
  var fakeEntry = { raw: body, posted_at: ts, author: (msg.author || {}).username };
  var parsed = parseEntry(fakeEntry);
  if (!parsed.ticker) return null;
  return {
    ticker:        parsed.ticker,
    direction:     parsed.direction,
    contract:      parsed.contractDesc,
    strike:        parsed.strike,
    expiry:        parsed.expiry,
    stockEntry:    parsed.stockEntry,
    stockStop:     parsed.stockStop,
    rawStopText:   parsed.rawStop,
    source:        channelName.replace('.raw.json', ''),
    author:        fakeEntry.author,
    postedAt:      ts,
    rawText:       body.slice(0, 400),
    msgId:         msg.id,
  };
}

function loadFeed(opts) {
  opts = opts || {};
  if (!fs.existsSync(HIST_DIR)) return { picks: [], note: 'history dir missing: ' + HIST_DIR };

  var cutoffMs = Date.now() - FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  var all = [];
  var seenMsgIds = {};

  // Pass 1: parsed.json (best-shape entries, may be stale)
  for (var i = 0; i < CHANNELS_PARSED.length; i++) {
    var fp = path.join(HIST_DIR, CHANNELS_PARSED[i]);
    if (!fs.existsSync(fp)) continue;
    try {
      var arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var entry = arr[j];
        var ts = entry.posted_at || entry.timestamp;
        if (!ts) continue;
        var tsMs = new Date(ts).getTime();
        if (isNaN(tsMs) || tsMs < cutoffMs) continue;
        var parsed = parseEntry(entry);
        if (!parsed.ticker) continue;
        var mid = entry.msg_id;
        if (mid) seenMsgIds[mid] = true;
        all.push({
          ticker:        parsed.ticker,
          direction:     parsed.direction,
          contract:      parsed.contractDesc,
          strike:        parsed.strike,
          expiry:        parsed.expiry,
          stockEntry:    parsed.stockEntry,
          stockStop:     parsed.stockStop,
          rawStopText:   parsed.rawStop,
          source:        CHANNELS_PARSED[i].replace('.parsed.json', ''),
          author:        entry.author || null,
          postedAt:      ts,
          rawText:       (entry.raw || '').slice(0, 400),
          msgId:         mid,
        });
      }
    } catch(e) {
      console.error('[LOTTO] parsed-file error in', fp, e.message);
    }
  }

  // Pass 2: raw.json (catches fresh posts the strict parser dropped)
  for (var i = 0; i < CHANNELS_RAW.length; i++) {
    var fp = path.join(HIST_DIR, CHANNELS_RAW[i]);
    if (!fs.existsSync(fp)) continue;
    try {
      var raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(raw)) continue;
      for (var j = 0; j < raw.length; j++) {
        var msg = raw[j];
        if (msg.id && seenMsgIds[msg.id]) continue;
        var ts = msg.timestamp;
        if (!ts) continue;
        var tsMs = new Date(ts).getTime();
        if (isNaN(tsMs) || tsMs < cutoffMs) continue;
        var p = parseRawMessage(msg, CHANNELS_RAW[i]);
        if (!p) continue;
        all.push(p);
        if (p.msgId) seenMsgIds[p.msgId] = true;
      }
    } catch(e) {
      console.error('[LOTTO] raw-file error in', fp, e.message);
    }
  }

  // Sort newest first
  all.sort(function(a, b) { return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(); });

  // Dedup by ticker — keep latest only
  var seen = {};
  var deduped = [];
  for (var k = 0; k < all.length; k++) {
    var p = all[k];
    if (!seen[p.ticker]) {
      seen[p.ticker] = true;
      deduped.push(p);
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    historyDir: HIST_DIR,
    freshnessDays: FRESHNESS_DAYS,
    totalRecent: all.length,
    picks: deduped.slice(0, opts.limit || 30),
  };
}

module.exports = {
  loadFeed: loadFeed,
};
