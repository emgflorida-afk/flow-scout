// validateListener.js -- Stratum v7.4
// Listens to #validate Discord channel
// When you forward John's card there:
// = Parses ticker, direction, trigger, entry, stop, T1, T2
// = Arms the ideaIngestor watchlist automatically
// = Confirms back to Discord with armed status
// = Zero curl commands needed
// ---------------------------------------------------------------

const fetch = require('node-fetch');

const VALIDATE_CHANNEL_NAME = 'validate';
const EXECUTE_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
const RAILWAY_URL = process.env.RAILWAY_URL ||
  'https://flow-scout-production.up.railway.app';
const STRATUM_SECRET = process.env.STRATUM_SECRET || 'stratum2026';

// ---------------------------------------------------------------
// CARD PARSER
// Reads John's formatted card and extracts key fields
// Handles various formats John might use
// ---------------------------------------------------------------
function parseJohnCard(text) {
  var result = {
    ticker:       null,
    direction:    null,
    triggerPrice: null,
    entryPrice:   null,
    stopPrice:    null,
    t1:           null,
    t2:           null,
    contract:     null,
    note:         '',
    raw:          text,
  };

  var lines = text.split('\n').map(function(l) { return l.trim(); });
  var full  = text.toUpperCase();

  // TICKER -- look for common patterns
  // "BG CALL", "NVDA PUT", "$BG", "Ticker: BG"
  var tickerMatch = text.match(/(?:ticker[:\s]+)?([A-Z]{1,5})\s+(CALL|PUT|CALLS|PUTS)/i) ||
                    text.match(/\$([A-Z]{1,5})\b/) ||
                    text.match(/^([A-Z]{1,5})\s/m);
  if (tickerMatch) result.ticker = tickerMatch[1].toUpperCase();

  // DIRECTION
  if (/\b(call|calls|bullish|long)\b/i.test(text)) result.direction = 'call';
  if (/\b(put|puts|bearish|short)\b/i.test(text))  result.direction = 'put';

  // TRIGGER PRICE -- "trigger: 129.55", "above 129.55", "entry trigger 129.55"
  var trigMatch = text.match(/trigger[:\s]+\$?([\d.]+)/i) ||
                  text.match(/close\s+above\s+\$?([\d.]+)/i) ||
                  text.match(/break\s+above\s+\$?([\d.]+)/i) ||
                  text.match(/above\s+\$?([\d.]+)/i) ||
                  text.match(/trigger\s*[:\-]?\s*\$?([\d.]+)/i);
  if (trigMatch) result.triggerPrice = parseFloat(trigMatch[1]);

  // ENTRY PRICE -- "entry: 2.89", "limit: 2.89", "entry $2.89"
  var entryMatch = text.match(/(?:entry|limit|retracement)[:\s]+\$?([\d.]+)/i) ||
                   text.match(/entry\s*price[:\s]+\$?([\d.]+)/i) ||
                   text.match(/limit\s+order[:\s]+\$?([\d.]+)/i);
  if (entryMatch) result.entryPrice = parseFloat(entryMatch[1]);

  // STOP PRICE -- "stop: 127.14", "stop loss: 127.14", "SL: 127.14"
  var stopMatch = text.match(/(?:stop|stop\s*loss|sl)[:\s]+\$?([\d.]+)/i) ||
                  text.match(/stop\s+at\s+\$?([\d.]+)/i);
  if (stopMatch) result.stopPrice = parseFloat(stopMatch[1]);

  // T1 -- "T1: 135.22", "target 1: 135.22", "target: 135.22"
  var t1Match = text.match(/(?:t1|target\s*1|tp1|target)[:\s]+\$?([\d.]+)/i) ||
                text.match(/(?:first\s+target)[:\s]+\$?([\d.]+)/i);
  if (t1Match) result.t1 = parseFloat(t1Match[1]);

  // T2 -- "T2: 139.95", "target 2: 139.95", "tp2: 139.95"
  var t2Match = text.match(/(?:t2|target\s*2|tp2)[:\s]+\$?([\d.]+)/i) ||
                text.match(/(?:second\s+target)[:\s]+\$?([\d.]+)/i);
  if (t2Match) result.t2 = parseFloat(t2Match[1]);

  // CONTRACT -- "260417C130", "BG 260417C130"
  var contractMatch = text.match(/([A-Z]{1,5}\s+\d{6}[CP][\d.]+)/i) ||
                      text.match(/(\d{6}[CP][\d.]+)/i);
  if (contractMatch) result.contract = contractMatch[1].toUpperCase();

  // NOTE -- grab first meaningful line as note
  lines.forEach(function(l) {
    if (l.length > 10 && !result.note) {
      result.note = l.replace(/[*#_`]/g, '').trim();
    }
  });

  return result;
}

// ---------------------------------------------------------------
// ARM THE WATCHLIST via Railway webhook
// ---------------------------------------------------------------
async function armWatchlist(parsed) {
  try {
    var body = {
      ticker:       parsed.ticker,
      direction:    parsed.direction,
      triggerPrice: parsed.triggerPrice,
      triggerType:  'close_above',
      entryPrice:   parsed.entryPrice,
      stopPrice:    parsed.stopPrice,
      t1:           parsed.t1,
      t2:           parsed.t2,
      contract:     parsed.contract,
      contracts:    1,
      live:         true,
      source:       'John',
      note:         parsed.note || 'Forwarded from John Discord card',
    };

    var res = await fetch(RAILWAY_URL + '/webhook/idea', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-stratum-secret': STRATUM_SECRET,
      },
      body: JSON.stringify(body),
    });

    var data = await res.json().catch(function() { return {}; });
    return { ok: res.ok, status: res.status, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------
// POST CONFIRMATION to Discord validate channel
// ---------------------------------------------------------------
async function postConfirmation(parsed, armed, channelId, botToken) {
  try {
    var lines;
    if (armed.ok) {
      lines = [
        '\u2705 ARMED FOR MONDAY -- ' + (parsed.ticker || '?') + ' ' + (parsed.direction || '?').toUpperCase(),
        '========================================',
        'Ticker:   ' + (parsed.ticker || '?'),
        'Direction: ' + (parsed.direction || '?').toUpperCase(),
        'Trigger:  $' + (parsed.triggerPrice || '?'),
        'Entry:    $' + (parsed.entryPrice || '?'),
        'Stop:     $' + (parsed.stopPrice || '?'),
        'T1:       $' + (parsed.t1 || '?'),
        'T2:       $' + (parsed.t2 || '?'),
        'Contract: ' + (parsed.contract || 'auto-select'),
        '----------------------------------------',
        '\uD83E\uDD16 Watchlist armed -- system monitoring trigger',
        '\uD83D\uDCB0 Will execute on LIVE account when triggered',
        '\uD83D\uDED1 Max risk: 2% daily exposure limit active',
      ].join('\n');
    } else {
      lines = [
        '\u26A0\uFE0F PARSE WARNING -- check this card manually',
        '========================================',
        'Parsed:',
        'Ticker:   ' + (parsed.ticker || 'NOT FOUND'),
        'Direction: ' + (parsed.direction || 'NOT FOUND'),
        'Trigger:  ' + (parsed.triggerPrice || 'NOT FOUND'),
        'Entry:    ' + (parsed.entryPrice || 'NOT FOUND'),
        'Stop:     ' + (parsed.stopPrice || 'NOT FOUND'),
        '----------------------------------------',
        'Error: ' + (armed.error || 'Could not arm watchlist'),
        'Run curl manually or paste card again',
      ].join('\n');
    }

    // Post back to the validate channel
    await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method:  'POST',
      headers: {
        'Authorization': 'Bot ' + botToken,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ content: '```\n' + lines + '\n```' }),
    });
  } catch(e) {
    console.error('[VALIDATE] Confirmation post error:', e.message);
  }
}

// ---------------------------------------------------------------
// MAIN: setupValidateListener
// Call this from discordBot.js after client is ready
// ---------------------------------------------------------------
function setupValidateListener(client) {
  // Add GuildMessages intent handling
  client.on('messageCreate', async function(message) {
    try {
      // Only listen to #validate channel
      if (!message.channel || message.channel.name !== VALIDATE_CHANNEL_NAME) return;
      // Ignore bot messages
      if (message.author.bot) return;

      var text = message.content || '';

      // Must have some content to parse
      if (text.length < 10) return;

      console.log('[VALIDATE] Message received in #validate channel -- parsing...');

      // Parse John's card
      var parsed = parseJohnCard(text);

      // Validation -- must have at minimum ticker + direction
      if (!parsed.ticker || !parsed.direction) {
        console.log('[VALIDATE] Could not parse ticker or direction -- skipping');
        await fetch('https://discord.com/api/v10/channels/' + message.channel.id + '/messages', {
          method:  'POST',
          headers: {
            'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            content: '```\n\u26A0\uFE0F Could not parse ticker or direction\nMake sure the card has TICKER + CALL/PUT\nExample: "BG CALL trigger 129.55 entry 2.89 stop 127.14"\n```'
          }),
        });
        return;
      }

      // Arm the watchlist
      var armed = await armWatchlist(parsed);

      // Post confirmation
      await postConfirmation(parsed, armed, message.channel.id, process.env.DISCORD_BOT_TOKEN);

      console.log('[VALIDATE] Armed:', parsed.ticker, parsed.direction, 'trigger:', parsed.triggerPrice);

    } catch(e) {
      console.error('[VALIDATE] Message handler error:', e.message);
    }
  });

  console.log('[VALIDATE] Listening to #validate channel OK');
}

module.exports = { setupValidateListener, parseJohnCard };
