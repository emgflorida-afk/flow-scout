// ideaIngestor.js -- Stratum v7.4
// TRADE IDEA VALIDATOR
// Accepts trade ideas from John or any source
// Validates trigger price -- CANDLE CLOSE only, not wick
// Pulls live bars from TradeStation to check if triggered
// Builds full card if valid and posts to #execute-now
// Solves: missing entries + false wick triggers

var fetch = require('node-fetch');

var TS_BASE          = 'https://api.tradestation.com/v3';
var EXECUTE_NOW_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
var STRAT_WEBHOOK    = process.env.DISCORD_WEBHOOK_URL;

// Active idea watchlist -- monitored every 5 minutes
var ideaWatchlist = {};

// ================================================================
// CANDLE CLOSE VALIDATION
// The most important function -- wick vs close
// ================================================================
function validateTrigger(bars, triggerPrice, triggerType) {
  if (!bars || bars.length < 2) return { triggered: false, reason: 'No bar data' };

  var latest  = bars[bars.length - 1];
  var close   = parseFloat(latest.Close || latest.close || 0);
  var high    = parseFloat(latest.High  || latest.high  || 0);
  var low     = parseFloat(latest.Low   || latest.low   || 0);
  var open    = parseFloat(latest.Open  || latest.open  || 0);

  var prev    = bars[bars.length - 2];
  var prevHigh = parseFloat(prev.High  || prev.high  || 0);
  var prevLow  = parseFloat(prev.Low   || prev.low   || 0);

  // Check for wick vs close
  var wickTouchedAbove = high >= triggerPrice && close < triggerPrice;
  var wickTouchedBelow = low <= triggerPrice && close > triggerPrice;
  var closedAbove      = close >= triggerPrice;
  var closedBelow      = close <= triggerPrice;

  if (triggerType === 'close_above' || triggerType === 'breakout') {
    if (closedAbove) {
      return {
        triggered:  true,
        reason:     'CANDLE CLOSED above $' + triggerPrice + ' -- VALID entry',
        close:      close,
        wick:       false,
      };
    }
    if (wickTouchedAbove) {
      return {
        triggered:  false,
        reason:     'WICK ONLY -- touched $' + triggerPrice + ' but closed at $' + close.toFixed(2) + ' -- SKIP',
        close:      close,
        wick:       true,
        warning:    'This is exactly the DLTR/NFLX pattern -- wick touched level but no candle close. DO NOT ENTER.',
      };
    }
    return {
      triggered:  false,
      reason:     'Not yet triggered -- price at $' + close.toFixed(2) + ' vs trigger $' + triggerPrice,
      close:      close,
      wick:       false,
      distance:   (triggerPrice - close).toFixed(2),
    };
  }

  if (triggerType === 'close_below' || triggerType === 'breakdown') {
    if (closedBelow) {
      return {
        triggered:  true,
        reason:     'CANDLE CLOSED below $' + triggerPrice + ' -- VALID entry',
        close:      close,
        wick:       false,
      };
    }
    if (wickTouchedBelow) {
      return {
        triggered:  false,
        reason:     'WICK ONLY -- touched $' + triggerPrice + ' but closed at $' + close.toFixed(2) + ' -- SKIP',
        close:      close,
        wick:       true,
        warning:    'Wick touched level but no candle close. DO NOT ENTER.',
      };
    }
    return {
      triggered:  false,
      reason:     'Not yet triggered -- price at $' + close.toFixed(2) + ' vs trigger $' + triggerPrice,
      close:      close,
      wick:       false,
      distance:   (close - triggerPrice).toFixed(2),
    };
  }

  // Pullback entry -- wait for retracement to level
  if (triggerType === 'pullback') {
    var pctFromHigh = ((high - close) / high * 100);
    if (pctFromHigh >= 12.5 && close >= triggerPrice * 0.97) {
      return {
        triggered:  true,
        reason:     'PULLBACK to trigger zone -- ' + pctFromHigh.toFixed(1) + '% from high -- VALID entry',
        close:      close,
        wick:       false,
      };
    }
    return {
      triggered:  false,
      reason:     'Waiting for pullback to $' + triggerPrice + ' -- current $' + close.toFixed(2),
      close:      close,
      wick:       false,
    };
  }

  return { triggered: false, reason: 'Unknown trigger type: ' + triggerType };
}

// ================================================================
// GET LIVE BARS FROM TRADESTATION
// ================================================================
async function getLiveBars(ticker, unit, interval, barsback) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;

    var url = TS_BASE + '/marketdata/barcharts/' + ticker +
      '?unit=' + (unit || 'Daily') +
      '&interval=' + (interval || '1') +
      '&barsback=' + (barsback || 5) +
      '&sessiontemplate=Default';

    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) {
    console.error('[IDEA] Bars error:', e.message);
    return null;
  }
}

// ================================================================
// GET ATM OPTION FROM TRADESTATION
// ================================================================
async function getATMOption(ticker, direction, expiry) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return null;

    // Get current price
    var quoteUrl = TS_BASE + '/marketdata/quotes/' + ticker;
    var qRes = await fetch(quoteUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!qRes.ok) return null;
    var qData = await qRes.json();
    var quotes = qData.Quotes || qData.quotes || [];
    var price = quotes[0] ? parseFloat(quotes[0].Last || quotes[0].last || 0) : 0;
    if (!price) return null;

    // Get option chain
    var chainUrl = TS_BASE + '/marketdata/options/chains/' + ticker +
      '?expiration=' + (expiry || '') +
      '&optionType=' + (direction === 'call' ? 'Call' : 'Put') +
      '&strikeProximity=3';

    var cRes = await fetch(chainUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (!cRes.ok) return null;
    var cData = await cRes.json();

    // Find ATM strike
    var options = cData.Expirations || cData.Options || [];
    if (!options.length) return null;

    return {
      price:   price,
      options: options.slice(0, 3),
    };
  } catch(e) {
    console.error('[IDEA] Option error:', e.message);
    return null;
  }
}

// ================================================================
// BUILD IDEA CARD
// ================================================================
function buildIdeaCard(idea, validation, bars) {
  var latest = bars && bars[bars.length - 1];
  var close  = latest ? parseFloat(latest.Close || 0) : 0;
  var high   = latest ? parseFloat(latest.High  || 0) : 0;
  var low    = latest ? parseFloat(latest.Low   || 0) : 0;

  // Calculate smart levels
  var premium  = idea.premium || null;
  var limit    = premium ? (premium * 0.875).toFixed(2) : 'TBD';
  var stop     = premium ? (premium * 0.60).toFixed(2)  : 'TBD';
  var t1       = premium ? (premium * 1.60).toFixed(2)  : 'TBD';
  var t2       = premium ? (premium * 2.20).toFixed(2)  : 'TBD';

  var lines = [];

  if (validation.triggered) {
    lines = [
      'IDEA VALIDATED -- EXECUTE NOW',
      idea.ticker + ' ' + (idea.direction || 'CALL').toUpperCase() + ' -- ' + (idea.source || 'External Idea'),
      '===============================',
      'Trigger:   $' + idea.triggerPrice + ' ' + idea.triggerType,
      'Status:    TRIGGERED -- ' + validation.reason,
      'Price now: $' + close.toFixed(2),
      '-------------------------------',
    ];

    if (premium) {
      lines.push('Entry   $' + premium + ' x' + (idea.contracts || 1));
      lines.push('Limit   $' + limit + ' (12.5% retrace)');
      lines.push('Stop    $' + stop + ' (structural)');
      lines.push('T1      $' + t1 + ' close here');
      lines.push('T2      $' + t2 + ' runner');
    } else {
      lines.push('Contract: pull ATM ' + (idea.direction || 'call'));
      lines.push('Entry:    ask x 0.875 (retracement)');
      lines.push('Stop:     40% of premium');
    }

    lines.push('-------------------------------');
    lines.push('Source:  ' + (idea.source || 'External'));
    lines.push('Note:    ' + (idea.note || ''));
    lines.push('Time:    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET');

  } else if (validation.wick) {
    lines = [
      'IDEA ALERT -- WICK ONLY -- SKIP',
      idea.ticker + ' $' + idea.triggerPrice + ' ' + idea.triggerType,
      '===============================',
      'WARNING:   ' + validation.reason,
      validation.warning || '',
      '-------------------------------',
      'Price now: $' + close.toFixed(2),
      'Day high:  $' + high.toFixed(2),
      'Day low:   $' + low.toFixed(2),
      '-------------------------------',
      'RULE: Wait for CANDLE CLOSE through $' + idea.triggerPrice,
      'Not a wick touch -- need full close',
      'This is the DLTR/NFLX pattern -- skip it',
    ];
  } else {
    lines = [
      'IDEA WATCHING -- NOT YET TRIGGERED',
      idea.ticker + ' $' + idea.triggerPrice + ' ' + idea.triggerType,
      '===============================',
      'Status:    WAITING -- ' + validation.reason,
      'Price now: $' + close.toFixed(2),
      'Distance:  $' + (validation.distance || 'N/A') + ' from trigger',
      '-------------------------------',
      'When triggered:',
      '  Candle must CLOSE ' + (idea.triggerType.includes('above') ? 'above' : 'below') + ' $' + idea.triggerPrice,
      '  Not a wick -- full candle close required',
      '  Agent will fire card to #execute-now automatically',
      '-------------------------------',
      'Source:  ' + (idea.source || 'External'),
      'Note:    ' + (idea.note || ''),
      'Added:   ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
    ];
  }

  return lines.filter(function(l) { return l !== ''; }).join('\n');
}

// ================================================================
// POST TO DISCORD
// ================================================================
async function postCard(card, triggered) {
  var webhook = triggered ? EXECUTE_NOW_WEBHOOK : STRAT_WEBHOOK;
  if (!webhook) return;
  try {
    var username = triggered ? 'Stratum Execute Now' : 'Stratum Idea Watch';
    await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + card + '\n```', username: username }),
    });
    console.log('[IDEA] Card posted -- triggered=' + triggered);
  } catch(e) {
    console.error('[IDEA] Post error:', e.message);
  }
}

// ================================================================
// MAIN -- INGEST IDEA
// Accepts: { ticker, direction, triggerPrice, triggerType, note, source, premium }
// triggerType: close_above, close_below, pullback, breakout, breakdown
// ================================================================
async function ingestIdea(idea) {
  if (!idea || !idea.ticker || !idea.triggerPrice) {
    return { error: 'Missing ticker or triggerPrice' };
  }

  idea.ticker       = idea.ticker.toUpperCase();
  idea.triggerPrice = parseFloat(idea.triggerPrice);
  idea.triggerType  = idea.triggerType || 'close_above';
  idea.direction    = idea.direction   || 'call';
  idea.source       = idea.source      || 'External';
  idea.addedAt      = new Date().toISOString();

  console.log('[IDEA] Ingesting:', idea.ticker, idea.triggerType, '$' + idea.triggerPrice);

  // Pull live 5-min bars for intraday check
  var bars5min = await getLiveBars(idea.ticker, 'Minute', '5', 12);
  // Pull daily bars for context
  var barsDaily = await getLiveBars(idea.ticker, 'Daily', '1', 5);

  // Validate trigger on 5-min bars first (intraday)
  var validation = validateTrigger(bars5min || barsDaily, idea.triggerPrice, idea.triggerType);

  // Build card
  var card = buildIdeaCard(idea, validation, bars5min || barsDaily);

  // Post to Discord
  await postCard(card, validation.triggered);

  // Add to watchlist if not triggered yet
  if (!validation.triggered) {
    ideaWatchlist[idea.ticker + '_' + idea.triggerPrice] = {
      idea:        idea,
      addedAt:     new Date(),
      checkCount:  0,
    };
    console.log('[IDEA] Added to watchlist:', idea.ticker, '$' + idea.triggerPrice);
  }

  return {
    status:     validation.triggered ? 'TRIGGERED' : validation.wick ? 'WICK_SKIP' : 'WATCHING',
    ticker:     idea.ticker,
    trigger:    idea.triggerPrice,
    type:       idea.triggerType,
    validation: validation,
    card:       card,
  };
}

// ================================================================
// MONITOR WATCHLIST -- runs every 5 minutes
// Checks all pending ideas for trigger
// ================================================================
async function monitorWatchlist() {
  var keys = Object.keys(ideaWatchlist);
  if (keys.length === 0) return;

  console.log('[IDEA] Monitoring ' + keys.length + ' ideas...');

  for (var i = 0; i < keys.length; i++) {
    var entry = ideaWatchlist[keys[i]];
    var idea  = entry.idea;

    // Remove ideas older than 2 days
    var age = (Date.now() - new Date(idea.addedAt).getTime()) / 1000 / 60 / 60;
    if (age > 48) {
      delete ideaWatchlist[keys[i]];
      console.log('[IDEA] Expired:', idea.ticker);
      continue;
    }

    var bars = await getLiveBars(idea.ticker, 'Minute', '5', 12);
    if (!bars) continue;

    var validation = validateTrigger(bars, idea.triggerPrice, idea.triggerType);
    entry.checkCount++;

    if (validation.triggered) {
      console.log('[IDEA] TRIGGERED:', idea.ticker, '$' + idea.triggerPrice);
      var card = buildIdeaCard(idea, validation, bars);
      await postCard(card, true);
      delete ideaWatchlist[keys[i]];
    } else if (validation.wick) {
      console.log('[IDEA] WICK detected:', idea.ticker, '-- posting warning');
      var card = buildIdeaCard(idea, validation, bars);
      await postCard(card, false);
    }
  }
}

// ================================================================
// GET WATCHLIST STATUS
// ================================================================
function getWatchlist() {
  return Object.values(ideaWatchlist).map(function(e) {
    return {
      ticker:      e.idea.ticker,
      trigger:     e.idea.triggerPrice,
      type:        e.idea.triggerType,
      direction:   e.idea.direction,
      source:      e.idea.source,
      note:        e.idea.note,
      addedAt:     e.addedAt,
      checkCount:  e.checkCount,
    };
  });
}

// ================================================================
// REMOVE FROM WATCHLIST
// ================================================================
function removeIdea(ticker, triggerPrice) {
  var key = ticker.toUpperCase() + '_' + triggerPrice;
  if (ideaWatchlist[key]) {
    delete ideaWatchlist[key];
    return true;
  }
  return false;
}

module.exports = { ingestIdea, monitorWatchlist, getWatchlist, removeIdea, validateTrigger };
