// dynamicBias.js -- Stratum v7.4
// Dynamic intraday bias engine
// Monitors SPY every 5 min -- flips between BULLISH/BEARISH automatically
// Cancels unfilled orders when bias flips
// Posts flip alert to #execute-now Discord

var fetch = require('node-fetch');

// Current bias state
var state = {
  bias:      null,   // BULLISH, BEARISH, NEUTRAL
  strength:  null,   // STRONG, WEAK
  lastFlip:  null,   // timestamp of last flip
  spyPrice:  null,
  spyVwap:   null,
  barType:   null,   // 2UP, 2DOWN, 1, 3
  updatedAt: null,
};

var EXECUTE_NOW_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// ================================================================
// DETERMINE BAR TYPE
// ================================================================
function getBarType(bar, prevBar) {
  if (!bar || !prevBar) return 'UNKNOWN';
  var h  = parseFloat(bar.High);
  var l  = parseFloat(bar.Low);
  var ph = parseFloat(prevBar.High);
  var pl = parseFloat(prevBar.Low);

  if (h > ph && l > pl) return '2UP';
  if (h < ph && l < pl) return '2DOWN';
  if (h > ph && l < pl) return '3';    // outside bar
  if (h < ph && l > pl) return '1';    // inside bar
  return '1';
}

// ================================================================
// UPDATE BIAS -- called every 5 min
// ================================================================
async function updateBias() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return state;

    // Pull last 5 SPY 5-min bars
    var res  = await fetch('https://api.tradestation.com/v3/marketdata/barcharts/SPY?interval=5&unit=Minute&barsback=5&sessiontemplate=Default', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var bars = data.Bars || [];
    if (bars.length < 2) return state;

    var current  = bars[bars.length - 1];
    var previous = bars[bars.length - 2];
    var barType  = getBarType(current, previous);

    // Get VWAP from bars
    var vwap = 0;
    var totalVol = 0;
    bars.forEach(function(b) {
      var v   = parseFloat(b.TotalVolume || 1);
      var tp  = (parseFloat(b.High) + parseFloat(b.Low) + parseFloat(b.Close)) / 3;
      vwap   += tp * v;
      totalVol += v;
    });
    vwap = totalVol > 0 ? vwap / totalVol : parseFloat(current.Close);

    var close    = parseFloat(current.Close);
    var aboveVwap = close > vwap;

    // Determine new bias
    var newBias;
    var newStrength;

    if (barType === '2UP' && aboveVwap) {
      newBias     = 'BULLISH';
      newStrength = 'STRONG';
    } else if (barType === '2DOWN' && !aboveVwap) {
      newBias     = 'BEARISH';
      newStrength = 'STRONG';
    } else if (barType === '2UP' && !aboveVwap) {
      newBias     = 'BULLISH';
      newStrength = 'WEAK';
    } else if (barType === '2DOWN' && aboveVwap) {
      newBias     = 'BEARISH';
      newStrength = 'WEAK';
    } else if (barType === '3') {
      newBias     = 'NEUTRAL';
      newStrength = 'WEAK';
    } else {
      // Inside bar -- keep existing bias
      newBias     = state.bias || 'NEUTRAL';
      newStrength = 'WEAK';
    }

    var prevBias = state.bias;

    // Update state
    state.bias      = newBias;
    state.strength  = newStrength;
    state.spyPrice  = close;
    state.spyVwap   = parseFloat(vwap.toFixed(2));
    state.barType   = barType;
    state.updatedAt = new Date().toISOString();

    // BIAS FLIP DETECTED
    if (prevBias && prevBias !== newBias && newBias !== 'NEUTRAL') {
      state.lastFlip = Date.now();
      console.log('[DYNAMIC-BIAS] FLIP DETECTED:', prevBias, '->', newBias, '(' + newStrength + ')');
      await postFlipAlert(prevBias, newBias, newStrength, close, vwap, barType);
    } else {
      console.log('[DYNAMIC-BIAS] Bias:', newBias, newStrength, 'SPY $' + close, 'VWAP $' + vwap.toFixed(2), barType);
    }

    return state;

  } catch(e) {
    console.error('[DYNAMIC-BIAS] Error:', e.message);
    return state;
  }
}

// ================================================================
// POST FLIP ALERT TO DISCORD
// ================================================================
async function postFlipAlert(from, to, strength, price, vwap, barType) {
  try {
    var isBullish = to === 'BULLISH';
    var msg = [
      (isBullish ? 'BIAS FLIP -- NOW BULLISH' : 'BIAS FLIP -- NOW BEARISH'),
      '===============================',
      'From:      ' + from,
      'To:        ' + to + ' (' + strength + ')',
      'SPY:       $' + price,
      'VWAP:      $' + vwap.toFixed(2) + (price > vwap ? ' -- ABOVE' : ' -- BELOW'),
      'Bar Type:  ' + barType,
      '-------------------------------',
      isBullish
        ? 'ACTION: Switch to CALLS ONLY\n         Cancel unfilled put orders'
        : 'ACTION: Switch to PUTS ONLY\n         Cancel unfilled call orders',
      'Time: ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET',
    ].join('\n');

    await fetch(EXECUTE_NOW_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + msg + '\n```',
        username: 'Stratum Bias Engine',
      }),
    });
  } catch(e) {
    console.error('[DYNAMIC-BIAS] Discord post error:', e.message);
  }
}

// Get current bias state
function getBias() { return state; }

// Check if direction is allowed given current bias
// Apr 27 2026 PM — env var BIAS_BLOCK_DISABLED=1 bypasses the gate.
// Why: regime-flag is SPY-only and ignores per-ticker GEX confluence. AB
// blocked from firing HOOD bull setup (GEX-confirmed +6.10M @ $90 magnet)
// because SPY tape was BEARISH STRONG. Trader override needed when local
// Strat × Flow × GEX agree against the broader regime.
function isAllowed(direction) {
  if (process.env.BIAS_BLOCK_DISABLED === '1' || process.env.BIAS_BLOCK_DISABLED === 'true') return true;
  if (!state.bias || state.bias === 'NEUTRAL') return true;
  if (direction === 'call' && state.bias === 'BEARISH' && state.strength === 'STRONG') return false;
  if (direction === 'put'  && state.bias === 'BULLISH' && state.strength === 'STRONG') return false;
  return true;
}

module.exports = { updateBias, getBias, isAllowed };
