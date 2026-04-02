// optionChartReader.js -- Stratum v7.4
// Phase 1: Read option contract price action via TradeStation API
// Posts range position to Discord before trade execution
// Tells agent and trader: is this contract at a discount or top of range?
// ---------------------------------------------------------------

const fetch = require('node-fetch');

const TS_LIVE = 'https://api.tradestation.com/v3';
const TS_SIM  = 'https://sim-api.tradestation.com/v3';

const DISCORD_EXECUTE_WEBHOOK =
  process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// ---------------------------------------------------------------
// RANGE POSITION ENGINE
// Reads where the option is in its daily range
// Returns: DISCOUNT / MIDRANGE / EXTENDED / TOP
// ---------------------------------------------------------------
function classifyRangePosition(current, dayLow, dayHigh, dayOpen, volTrend, barCount) {
  if (!dayHigh || !dayLow || dayHigh === dayLow) return 'UNKNOWN';

  var range      = dayHigh - dayLow;
  var posInRange = (current - dayLow) / range;  // 0 = at low, 1 = at high
  var fromHigh   = ((dayHigh - current) / dayHigh * 100).toFixed(1);
  var fromOpen   = dayOpen > 0 ? ((current - dayOpen) / dayOpen * 100).toFixed(1) : null;
  var rangeUsed  = dayOpen > 0 ? ((dayHigh - dayLow) / dayOpen * 100).toFixed(1) : null;

  // CRITICAL CHECK: Is this a DEAD contract or a LIVE discount?
  // Dead contract = stock tanking = option losing value = near low because WORTHLESS
  // Live discount = contract pulled back from high = still has momentum potential

  // Signs of a DEAD contract (stock moving against the option):
  // 1. fromOpen is very negative (option down big from where it started)
  // 2. Volume is fading (nobody buying)
  // 3. Range is tiny (no movement = no interest)

  var isDead = false;
  var deadReason = '';

  // Contract is DOWN more than 40% from open price = underlying moving against it
  if (dayOpen > 0 && parseFloat(fromOpen) < -40) {
    isDead = true;
    deadReason = 'Contract down ' + Math.abs(parseFloat(fromOpen)).toFixed(0) + '% from open -- underlying moving against position';
  }

  // Volume fading AND near low = nobody wants it = dead
  if (volTrend === 'FADING' && posInRange <= 0.25) {
    isDead = true;
    deadReason = 'Near low with fading volume -- no buyer interest';
  }

  // Range too small = contract not moving = illiquid or dead
  if (rangeUsed && parseFloat(rangeUsed) < 5 && barCount > 20) {
    isDead = true;
    deadReason = 'Range only ' + rangeUsed + '% -- contract not moving, illiquid';
  }

  var position, emoji, action;

  if (isDead) {
    position = 'DEAD';
    emoji    = '\u26D4'; // no entry sign
    action   = 'SKIP -- ' + deadReason;
  } else if (posInRange <= 0.25) {
    // Near low BUT not dead = genuine pullback from earlier strength
    // This is only a discount if the contract was strong earlier
    if (dayHigh > dayOpen * 1.15) {
      // Contract ran 15%+ at some point today = genuine pullback = discount
      position = 'DISCOUNT';
      emoji    = '\uD83D\uDFE2';
      action   = 'Pulled back from earlier strength -- genuine discount entry';
    } else {
      // Never really ran = near low = weak contract
      position = 'WEAK';
      emoji    = '\uD83D\uDFE1';
      action   = 'Contract never gained strength -- wait for momentum';
    }
  } else if (posInRange <= 0.50) {
    position = 'LOWER HALF';
    emoji    = '\uD83D\uDFE1';
    action   = 'Lower half of range -- watch for continuation';
  } else if (posInRange <= 0.75) {
    position = 'UPPER HALF';
    emoji    = '\uD83D\uDFE0';
    action   = 'Upper half of range -- caution, may pull back';
  } else {
    position = 'EXTENDED';
    emoji    = '\uD83D\uDD34';
    action   = 'Near day high -- move may be over, wait for pullback';
  }

  return { position, emoji, action, posInRange: (posInRange * 100).toFixed(0), fromHigh, fromOpen, rangeUsed, isDead, deadReason };
}

// ---------------------------------------------------------------
// FETCH OPTION BARS (5-min) via TradeStation
// Returns open, high, low, close for today's session
// ---------------------------------------------------------------
async function getOptionBars(optionSymbol, token, isSim) {
  try {
    var base   = isSim ? TS_SIM : TS_LIVE;
    var sym    = encodeURIComponent(optionSymbol);
    var url    = base + '/marketdata/barcharts/' + sym +
                 '?interval=5&unit=Minute&barsback=78&sessiontemplate=Default';

    var res    = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data   = await res.json();
    var bars   = data.Bars || data.bars || [];

    if (!bars.length) return null;

    // Calculate today's session OHLCV from 5-min bars
    var dayOpen  = parseFloat(bars[0].Open  || bars[0].open  || 0);
    var dayClose = parseFloat(bars[bars.length - 1].Close || bars[bars.length - 1].close || 0);
    var dayHigh  = Math.max(...bars.map(b => parseFloat(b.High  || b.high  || 0)));
    var dayLow   = Math.min(...bars.map(b => parseFloat(b.Low   || b.low   || 0)).filter(v => v > 0));
    var totalVol = bars.reduce((s, b) => s + parseInt(b.TotalVolume || b.volume || 0), 0);

    // Volume trend -- compare first half vs second half
    var mid      = Math.floor(bars.length / 2);
    var vol1H    = bars.slice(0, mid).reduce((s, b) => s + parseInt(b.TotalVolume || b.volume || 0), 0);
    var vol2H    = bars.slice(mid).reduce((s, b) => s + parseInt(b.TotalVolume || b.volume || 0), 0);
    var volTrend = vol2H > vol1H * 1.2 ? 'ACCELERATING' : vol2H < vol1H * 0.8 ? 'FADING' : 'STEADY';

    return { dayOpen, dayHigh, dayLow, dayClose, totalVol, volTrend, barCount: bars.length };
  } catch(e) {
    console.error('[OPTION-CHART] Bar fetch error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// FETCH REAL-TIME QUOTE for option
// ---------------------------------------------------------------
async function getOptionQuote(optionSymbol, token, isSim) {
  try {
    var base = isSim ? TS_SIM : TS_LIVE;
    var sym  = encodeURIComponent(optionSymbol);
    var res  = await fetch(base + '/marketdata/quotes/' + sym, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data   = await res.json();
    var quotes = data.Quotes || data.quotes || [];
    if (!quotes.length) return null;
    var q = quotes[0];
    return {
      bid:     parseFloat(q.Bid    || q.bid    || 0),
      ask:     parseFloat(q.Ask    || q.ask    || 0),
      last:    parseFloat(q.Last   || q.last   || 0),
      mid:     parseFloat(q.Mid    || q.mid    || ((parseFloat(q.Bid || 0) + parseFloat(q.Ask || 0)) / 2)),
      volume:  parseInt(q.Volume   || q.volume || 0),
      dayHigh: parseFloat(q.High   || q.high   || 0),
      dayLow:  parseFloat(q.Low    || q.low    || 0),
      delta:   parseFloat(q.Delta  || q.delta  || 0),
    };
  } catch(e) {
    console.error('[OPTION-CHART] Quote error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// MAIN: analyzeOptionChart
// Call this before any trade decision
// Posts range position card to Discord
// Returns analysis object for agent to use
// ---------------------------------------------------------------
async function analyzeOptionChart(optionSymbol, underlyingTicker, direction, entryPrice) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) {
      console.error('[OPTION-CHART] No TS token');
      return null;
    }

    var isSim  = process.env.SIM_MODE === 'true';
    var quote  = await getOptionQuote(optionSymbol, token, isSim);
    var bars   = await getOptionBars(optionSymbol, token, isSim);

    if (!quote && !bars) {
      console.error('[OPTION-CHART] No data for', optionSymbol);
      return null;
    }

    var current  = quote ? quote.mid  : (bars ? bars.dayClose : 0);
    var dayHigh  = quote ? quote.dayHigh : (bars ? bars.dayHigh : 0);
    var dayLow   = quote ? quote.dayLow  : (bars ? bars.dayLow  : 0);
    var dayOpen  = bars  ? bars.dayOpen  : 0;
    var volume   = quote ? quote.volume  : (bars ? bars.totalVol : 0);
    var volTrend = bars  ? bars.volTrend : 'UNKNOWN';

    // Classify where contract is in its range
    var range    = classifyRangePosition(current, dayLow, dayHigh, dayOpen, volTrend, bars ? bars.barCount : 0);

    // Entry price check -- is proposed entry at a discount?
    var entryVsRange = null;
    if (entryPrice && dayHigh > 0) {
      var entryFromHigh = ((dayHigh - entryPrice) / dayHigh * 100).toFixed(1);
      entryVsRange = entryFromHigh > 15
        ? '\u2705 Entry $' + entryPrice + ' is ' + entryFromHigh + '% below day high -- DISCOUNT'
        : '\u26A0\uFE0F Entry $' + entryPrice + ' is only ' + entryFromHigh + '% below day high -- CLOSE TO TOP';
    }

    // Build recommendation
    var recommendation;
    if (range.position === 'DISCOUNT' || range.position === 'LOWER HALF') {
      recommendation = 'FAVORABLE -- contract at discount, good entry zone';
    } else if (range.position === 'UPPER HALF') {
      recommendation = 'CAUTION -- consider waiting for pullback to lower half';
    } else {
      recommendation = 'WAIT -- contract extended, high risk of reversal';
    }

    // Volume signal
    var volSignal = volTrend === 'ACCELERATING'
      ? '\uD83D\uDCC8 Volume accelerating -- momentum building'
      : volTrend === 'FADING'
      ? '\uD83D\uDCC9 Volume fading -- momentum may be exhausted'
      : '\u27A1\uFE0F Volume steady';

    // Build Discord card
    var dirEmoji = direction === 'call' ? '\uD83D\uDCC8' : '\uD83D\uDCC9';
    var lines = [
      '\uD83D\uDCCA OPTION CHART ANALYSIS -- ' + underlyingTicker.toUpperCase() + ' ' + direction.toUpperCase(),
      'Contract: ' + optionSymbol,
      '========================================',
      range.emoji + ' Range Position: ' + range.position + ' (' + range.posInRange + '% of range)',
      '\uD83D\uDCB0 Current:  $' + current.toFixed(2),
      '\uD83D\uDD3C Day High:  $' + dayHigh.toFixed(2) + ' (' + range.fromHigh + '% above current)',
      '\uD83D\uDD3D Day Low:   $' + dayLow.toFixed(2),
      '\uD83D\uDCCA Day Open:  $' + (dayOpen > 0 ? dayOpen.toFixed(2) : '?') + (range.fromOpen ? '  (now ' + (range.fromOpen > 0 ? '+' : '') + range.fromOpen + '% from open)' : ''),
      '\uD83D\uDCCA Volume:   ' + (volume || 0).toLocaleString() + ' contracts  ' + volSignal,
      '----------------------------------------',
      entryVsRange ? entryVsRange : '',
      '\uD83C\uDFAF ' + range.action,
      '\u2753 RECOMMENDATION: ' + recommendation,
      '========================================',
    ].filter(Boolean).join('\n');

    // Post to Discord
    try {
      await fetch(DISCORD_EXECUTE_WEBHOOK, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          content:  '```\n' + lines + '\n```',
          username: 'Stratum Option Chart',
        }),
      });
      console.log('[OPTION-CHART] Analysis posted for', optionSymbol, range.position);
    } catch(de) {
      console.error('[OPTION-CHART] Discord error:', de.message);
    }

    // Return analysis for agent to use in execution decision
    return {
      symbol:         optionSymbol,
      current,
      dayHigh,
      dayLow,
      dayOpen,
      volume,
      volTrend,
      rangePosition:  range.position,
      posInRange:     parseFloat(range.posInRange),
      fromHighPct:    parseFloat(range.fromHigh),
      recommendation,
      favorable:      range.position === 'DISCOUNT' || range.position === 'LOWER HALF',
      extended:       range.position === 'EXTENDED',
      dead:           range.position === 'DEAD' || range.position === 'WEAK',
      isDead:         range.isDead || false,
      deadReason:     range.deadReason || '',
    };

  } catch(e) {
    console.error('[OPTION-CHART] Analysis error:', e.message);
    return null;
  }
}

module.exports = { analyzeOptionChart, classifyRangePosition };
