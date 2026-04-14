// jsmithParser.js -- Stratum v7.5
// Parses JSmithTrades.com Discord channel messages into structured trade objects.
//
// THREE FEEDS:
// 1. #vip-flow-options-alerts   -> John's VIP day/swing picks   (tier: VIP)
// 2. #option-trade-ideas        -> John's regular day/swing picks (tier: NORMAL)
// 3. #capital-flow-alerts       -> CapitalFlow bot raw UOA       (confirmation layer)
//
// John-feed format (identical in both #vip-flow-options-alerts and #option-trade-ideas):
// ---------------------------------------------------------------
// $PPG -- DAY TRADE IDEA - (4/14/26)
// WAIT TIME: 1 Trading Day(s)
// (Unless stop loss or profit targets hit; whichever comes first.)
// Ticker: PPG
// Call Entry: 110.39
// Contracts: 110 Calls 5/1 Exp
// Stop Loss: -25%
// Take Profit Levels: 25% * 50% * 100%+
// ---------------------------------------------------------------
//
// CapitalFlow format:
// ---------------------------------------------------------------
// Repeat Unusual Activity
// Contract: NVDA 180 CALL 05/15/26
// Premium:  ~$880,770
// Size:     505
// Avg Price: ~$17.46
// Alert Id: 7a9BiEV5iKGqv_LqDxGbd
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------

// Normalize unicode whitespace + zero-width chars Discord sometimes emits
function clean(str) {
  if (!str) return '';
  return String(str)
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '') // zero-width
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Parse a date like "5/1", "5/1/26", "05/15/26" into ISO YYYY-MM-DD
// Assumes current year if year omitted, handles 2-digit years as 20xx
function parseExpiry(str) {
  if (!str) return null;
  var m = String(str).trim().match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  var mo = parseInt(m[1], 10);
  var da = parseInt(m[2], 10);
  var yr;
  if (m[3]) {
    yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
  } else {
    yr = new Date().getFullYear();
  }
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return yr + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
}

// Days to expiry from today (ET-ish, we don't split hairs on tz here)
function dteFrom(isoDate) {
  if (!isoDate) return null;
  var exp = new Date(isoDate + 'T16:00:00-04:00');
  var now = new Date();
  return Math.round((exp - now) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------
// JOHN FEED PARSER (VIP + Option Trade Ideas)
// Handles both channels -- format is identical, only tier differs.
// ---------------------------------------------------------------
function parseJohnFeed(text, opts) {
  opts = opts || {};
  var tier = opts.tier || 'NORMAL'; // 'VIP' or 'NORMAL'
  var raw = clean(text);
  if (!raw) return null;

  // Must look like a John idea
  // Title line example: "$PPG -- DAY TRADE IDEA - (4/14/26)"
  var titleRx = /\$([A-Z]{1,6})\s*[-–—]{1,3}\s*(DAY TRADE IDEA|SWING TRADE IDEA|TRADE IDEA)/i;
  var titleM = raw.match(titleRx);
  if (!titleM) return null;

  var tickerFromTitle = titleM[1].toUpperCase();
  var tradeType = titleM[2].toUpperCase().indexOf('SWING') >= 0 ? 'SWING' : 'DAY';

  // Ticker line (confirm)
  var tickerM = raw.match(/Ticker:\s*\$?([A-Z]{1,6})/i);
  var ticker = tickerM ? tickerM[1].toUpperCase() : tickerFromTitle;

  // Direction + entry price
  // "Call Entry: 110.39" OR "Put Entry: 110.39"
  var entryM = raw.match(/(Call|Put)\s*Entry:\s*\$?([\d.]+)/i);
  if (!entryM) return null;
  var direction = entryM[1].toLowerCase() === 'call' ? 'call' : 'put';
  var triggerPrice = parseFloat(entryM[2]);
  if (!isFinite(triggerPrice) || triggerPrice <= 0) return null;

  // Contracts line -- primary strike + expiry, optional "(or ... )" backup
  // "Contracts: 110 Calls 5/1 Exp (or 108 Calls 5/1)"
  // "Contracts: 495 Calls 4/17 Exp (or 500 Calls 4/17)"
  var contractsM = raw.match(/Contracts:\s*([^\n]+)/i);
  var strike = null, expiry = null, backup = null;
  if (contractsM) {
    var cLine = contractsM[1];

    // Primary: "<strike> <Calls|Puts> <m/d[/yy]>"
    var primaryRx = /(\d+(?:\.\d+)?)\s*(Calls?|Puts?)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i;
    var pm = cLine.match(primaryRx);
    if (pm) {
      strike = parseFloat(pm[1]);
      expiry = parseExpiry(pm[3]);
    }

    // Backup format A: "(or <strike> <Calls|Puts> <m/d>)"
    var backupRxA = /\(\s*or\s+(\d+(?:\.\d+)?)\s*(Calls?|Puts?)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*\)/i;
    // Backup format B: "| <strike> <Calls|Puts> <m/d> (Safer Option)"
    //   or pipe followed by strike/side/date with any trailing label
    var backupRxB = /\|\s*(\d+(?:\.\d+)?)\s*(Calls?|Puts?)\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)(?:\s*\(([^)]+)\))?/i;
    var bm = cLine.match(backupRxA);
    var backupLabel = null;
    if (bm) {
      backup = {
        strike: parseFloat(bm[1]),
        expiry: parseExpiry(bm[3]),
        label:  'alternate',
      };
    } else {
      bm = cLine.match(backupRxB);
      if (bm) {
        backup = {
          strike: parseFloat(bm[1]),
          expiry: parseExpiry(bm[3]),
          label:  bm[4] ? bm[4].trim().toLowerCase() : 'alternate',
        };
      }
    }
  }

  // Stop loss -- John uses percent, e.g. "Stop Loss: -25%"
  var stopM = raw.match(/Stop\s*Loss:\s*(-?\d+(?:\.\d+)?)%/i);
  var stopPct = stopM ? Math.abs(parseFloat(stopM[1])) : 25;

  // Take profit ladder -- "Take Profit Levels: 25% * 50% * 100%+"
  var tpLine = raw.match(/Take\s*Profit\s*Levels:\s*([^\n]+)/i);
  var tpLevels = [];
  if (tpLine) {
    var tpNums = tpLine[1].match(/\d+(?:\.\d+)?/g);
    if (tpNums) tpLevels = tpNums.map(function(n){ return parseFloat(n); });
  }
  if (tpLevels.length === 0) tpLevels = [25, 50, 100];

  // Wait time -- "WAIT TIME: 1 Trading Day(s)"
  var waitM = raw.match(/WAIT\s*TIME:\s*(\d+)/i);
  var waitDays = waitM ? parseInt(waitM[1], 10) : 0;

  var dte = expiry ? dteFrom(expiry) : null;

  return {
    source:        'jsmith',
    tier:          tier,              // 'VIP' or 'NORMAL'
    ticker:        ticker,
    direction:     direction,          // 'call' | 'put'
    tradeType:     tradeType,          // 'DAY' | 'SWING'
    triggerPrice:  triggerPrice,       // stock price that triggers entry
    strike:        strike,             // option strike
    expiry:        expiry,             // YYYY-MM-DD
    dte:           dte,
    stopPct:       stopPct,            // percent (positive number)
    tpLevels:      tpLevels,           // [25, 50, 100]
    waitDays:      waitDays,
    backupContract: backup,            // {strike, expiry} or null
    rawText:       raw,
  };
}

// ---------------------------------------------------------------
// CAPITALFLOW PARSER
// ---------------------------------------------------------------
function parseCapitalFlow(text) {
  var raw = clean(text);
  if (!raw) return null;

  // Must have a Contract line
  // "Contract: NVDA 180 CALL 05/15/26"
  var contractM = raw.match(
    /Contract[:\s]+([A-Z]{1,6})\s+(\d+(?:\.\d+)?)\s+(CALL|PUT)\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i
  );
  if (!contractM) return null;

  var ticker    = contractM[1].toUpperCase();
  var strike    = parseFloat(contractM[2]);
  var direction = contractM[3].toUpperCase() === 'CALL' ? 'call' : 'put';
  var expiry    = parseExpiry(contractM[4]);

  // Premium: "~$880,770" or "$880,770"
  var premM = raw.match(/Premium[:\s]+~?\$?([\d,]+(?:\.\d+)?)/i);
  var premium = premM ? parseFloat(premM[1].replace(/,/g, '')) : null;

  // Size: "505"
  var sizeM = raw.match(/Size[:\s]+([\d,]+)/i);
  var size = sizeM ? parseInt(sizeM[1].replace(/,/g, ''), 10) : null;

  // Avg Price: "~$17.46"
  var avgM = raw.match(/Avg\s*Price[:\s]+~?\$?([\d.]+)/i);
  var avgPrice = avgM ? parseFloat(avgM[1]) : null;

  // Alert Id: unique dedup key
  var idM = raw.match(/Alert\s*Id[:\s]+([A-Za-z0-9_\-]+)/i);
  var alertId = idM ? idM[1] : null;

  // Activity type -- "Repeat Unusual Activity" | "Unusual Activity" | "Aggressive"
  var activityType = 'UOA';
  if (/Repeat\s*Unusual/i.test(raw))       activityType = 'REPEAT_UOA';
  else if (/Aggressive/i.test(raw))        activityType = 'AGGRESSIVE';
  else if (/Sweep/i.test(raw))             activityType = 'SWEEP';

  var dte = expiry ? dteFrom(expiry) : null;

  return {
    source:       'capitalflow',
    ticker:       ticker,
    direction:    direction,
    strike:       strike,
    expiry:       expiry,
    dte:          dte,
    premium:      premium,
    size:         size,
    avgPrice:     avgPrice,
    alertId:      alertId,
    activityType: activityType,
    rawText:      raw,
  };
}

// ---------------------------------------------------------------
// ROUTER -- pick the right parser based on channel ID
// ---------------------------------------------------------------
var CHANNELS = {
  VIP_FLOW_OPTIONS:   '1417547885754712134',
  OPTION_TRADE_IDEAS: '1401666517292023940',
  CAPITAL_FLOW:       '1411518843964096684',
};

function parseByChannel(channelId, text) {
  if (channelId === CHANNELS.VIP_FLOW_OPTIONS) {
    return parseJohnFeed(text, { tier: 'VIP' });
  }
  if (channelId === CHANNELS.OPTION_TRADE_IDEAS) {
    return parseJohnFeed(text, { tier: 'NORMAL' });
  }
  if (channelId === CHANNELS.CAPITAL_FLOW) {
    return parseCapitalFlow(text);
  }
  return null;
}

// ---------------------------------------------------------------
// DISCORD MESSAGE FLATTENER
// Discord messages come as {content, embeds:[{title, description, fields:[...]}]}.
// John's bot posts as an embed with fields. CapitalFlow same.
// Flatten everything into a single plain-text blob the parsers can read.
// ---------------------------------------------------------------
function flattenMessage(msg) {
  if (!msg) return '';
  var parts = [];
  if (msg.content) parts.push(msg.content);
  var embeds = msg.embeds || [];
  for (var i = 0; i < embeds.length; i++) {
    var e = embeds[i];
    if (e.title)       parts.push(e.title);
    if (e.description) parts.push(e.description);
    if (e.author && e.author.name) parts.push(e.author.name);
    var fields = e.fields || [];
    for (var j = 0; j < fields.length; j++) {
      parts.push((fields[j].name || '') + ': ' + (fields[j].value || ''));
    }
    if (e.footer && e.footer.text) parts.push(e.footer.text);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------
module.exports = {
  parseJohnFeed,
  parseCapitalFlow,
  parseByChannel,
  flattenMessage,
  CHANNELS,
  // helpers exposed for tests
  parseExpiry,
  clean,
};
