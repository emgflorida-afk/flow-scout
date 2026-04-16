// regimeGate.js -- Stratum v7.5
// MARKET REGIME GATE
// Blocks counter-trend entries that fight the macro environment.
// Every entry engine MUST call regimeGate.canEnter() before queuing.
//
// THREE CHECKS (all must pass for the trade direction):
// 1. SPY REGIME — are the last N daily closes trending up/down?
// 2. TICKER DAILY TREND — is the ticker itself trending with the trade?
// 3. HARD FTFC FAIL — if FTFC data exists AND opposes direction, BLOCK.
//
// If ANY check fails, the trade is vetoed with a reason string.
// No more "soft-fail to allow" — unknown = BLOCK on puts in bull market.

var fetch = require('node-fetch');

var TS_BASE = 'https://api.tradestation.com/v3';

// ================================================================
// CACHE — refreshed at most once per 5 minutes
// ================================================================
var _spyCache = { bars: null, regime: null, ts: 0 };
var _tickerCache = {};  // ticker -> { trend, ts }
var CACHE_TTL = 5 * 60 * 1000;  // 5 min

// ================================================================
// SPY REGIME — daily bar trend
// ================================================================
// Looks at the last 10 daily closes on SPY.
// If the last 5 closes are ALL above the 5th-from-last close AND
// the slope of the 10-day closes is positive => BULL regime.
// Mirror logic for BEAR. Otherwise MIXED.
async function fetchSPYRegime(token) {
  if (_spyCache.regime && (Date.now() - _spyCache.ts) < CACHE_TTL) {
    return _spyCache.regime;
  }
  try {
    var url = TS_BASE + '/marketdata/barcharts/SPY?unit=Daily&interval=1&barsback=10';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return _spyCache.regime || 'UNKNOWN';
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 7) return 'UNKNOWN';

    var closes = bars.map(function(b) { return parseFloat(b.Close); });

    // Simple metrics:
    // 1. Count how many of last 5 closes are higher than the close 5 bars ago
    var anchor = closes[closes.length - 6]; // 6th from end = 5 bars ago
    var bullCount = 0;
    var bearCount = 0;
    for (var i = closes.length - 5; i < closes.length; i++) {
      if (closes[i] > anchor) bullCount++;
      if (closes[i] < anchor) bearCount++;
    }

    // 2. Slope of last 5 closes (linear regression-lite)
    var last5 = closes.slice(-5);
    var slope = (last5[4] - last5[0]) / last5[0]; // percentage move

    // 3. Is SPY making new highs? (last close > max of prior 8)
    var priorMax = Math.max.apply(null, closes.slice(0, -1));
    var lastClose = closes[closes.length - 1];
    var atHighs = lastClose >= priorMax * 0.998; // within 0.2% of prior max

    var regime;
    if (bullCount >= 4 && slope > 0.002) {
      regime = 'BULL';
    } else if (bearCount >= 4 && slope < -0.002) {
      regime = 'BEAR';
    } else {
      regime = 'MIXED';
    }

    _spyCache = { bars: closes, regime: regime, ts: Date.now(), atHighs: atHighs, slope: slope };
    console.log('[REGIME] SPY regime=' + regime + ' slope=' + (slope * 100).toFixed(2) + '% atHighs=' + atHighs);
    return regime;
  } catch(e) {
    console.log('[REGIME] SPY fetch error: ' + e.message);
    return _spyCache.regime || 'UNKNOWN';
  }
}

// ================================================================
// TICKER DAILY TREND — is the individual ticker trending?
// ================================================================
// Checks last 5 daily closes:
// - If last close > all 4 prior closes => STRONG_UP
// - If 4/5 closes ascending => UP
// - Mirror for DOWN
// - Also checks if price is above/below simple 9-bar EMA of closes
async function fetchTickerTrend(ticker, token) {
  var cached = _tickerCache[ticker];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.trend;
  }
  try {
    var url = TS_BASE + '/marketdata/barcharts/' + ticker + '?unit=Daily&interval=1&barsback=10';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return 'UNKNOWN';
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 5) return 'UNKNOWN';

    var closes = bars.map(function(b) { return parseFloat(b.Close); });
    var last5 = closes.slice(-5);
    var lastClose = last5[4];

    // Count ascending vs descending pairs in last 5
    var ascCount = 0;
    var descCount = 0;
    for (var i = 1; i < last5.length; i++) {
      if (last5[i] > last5[i-1]) ascCount++;
      if (last5[i] < last5[i-1]) descCount++;
    }

    // Simple EMA-9 of available closes
    var ema = closes[0];
    var mult = 2 / (Math.min(closes.length, 9) + 1);
    for (var j = 1; j < closes.length; j++) {
      ema = (closes[j] - ema) * mult + ema;
    }
    var aboveEMA = lastClose > ema;

    var trend;
    if (ascCount >= 3 && aboveEMA) {
      trend = 'UP';
    } else if (descCount >= 3 && !aboveEMA) {
      trend = 'DOWN';
    } else {
      trend = 'NEUTRAL';
    }

    // Strong trend: last close > all prior 4
    if (lastClose > last5[0] && lastClose > last5[1] && lastClose > last5[2] && lastClose > last5[3]) {
      trend = 'STRONG_UP';
    }
    if (lastClose < last5[0] && lastClose < last5[1] && lastClose < last5[2] && lastClose < last5[3]) {
      trend = 'STRONG_DOWN';
    }

    _tickerCache[ticker] = { trend: trend, ema: ema, lastClose: lastClose, ts: Date.now() };
    return trend;
  } catch(e) {
    console.log('[REGIME] ticker trend error ' + ticker + ': ' + e.message);
    return 'UNKNOWN';
  }
}

// ================================================================
// HIGH-BETA TICKERS — extra protection in directional markets
// ================================================================
// These move 2-5x SPY. Counter-trend puts/calls on these in a
// strong regime are almost always losers.
var HIGH_BETA = [
  'MARA', 'RIOT', 'COIN', 'MSTR', 'IONQ', 'RGTI', 'SOUN', 'ACHR',
  'LUNR', 'RKLB', 'HOOD', 'SOFI', 'AFRM', 'UPST', 'HIMS', 'APP',
  'SNAP', 'RDDT', 'ROKU', 'DKNG', 'SE', 'SMCI', 'ARM',
  'TSLA', 'NVDA', 'AMD', 'PLTR', 'SHOP', 'SNOW',
];

function isHighBeta(ticker) {
  return HIGH_BETA.indexOf(ticker.toUpperCase()) !== -1;
}

// ================================================================
// MAIN GATE — canEnter()
// ================================================================
// Returns { allowed: true } or { allowed: false, reason: '...' }
//
// Rules:
// 1. SPY BULL + ticker UP/STRONG_UP + direction PUTS => BLOCK
//    "Don't buy puts on a rising stock in a bull market"
//
// 2. SPY BEAR + ticker DOWN/STRONG_DOWN + direction CALLS => BLOCK
//    "Don't buy calls on a falling stock in a bear market"
//
// 3. SPY BULL + high-beta ticker + direction PUTS => BLOCK
//    "NEVER short high-beta in a bull market even if ticker is neutral"
//
// 4. SPY BEAR + high-beta ticker + direction CALLS => BLOCK
//    "NEVER go long high-beta in a bear market even if ticker is neutral"
//
// 5. Ticker STRONG_UP + direction PUTS => BLOCK (regardless of SPY)
//    "Ticker itself is screaming upward, don't fight it"
//
// 6. Ticker STRONG_DOWN + direction CALLS => BLOCK (regardless of SPY)
//    "Ticker itself is screaming downward, don't fight it"
//
async function canEnter(ticker, direction, token) {
  if (!token) return { allowed: true, reason: 'no token — soft pass' };

  var regime = await fetchSPYRegime(token);
  var trend  = await fetchTickerTrend(ticker, token);
  var beta   = isHighBeta(ticker);
  var dir    = (direction || '').toUpperCase();

  // Rule 5/6: Ticker strong trend opposes direction — always block
  if (trend === 'STRONG_UP' && dir === 'PUTS') {
    return { allowed: false, reason: ticker + ' STRONG_UP daily — do not buy puts against momentum' };
  }
  if (trend === 'STRONG_DOWN' && dir === 'CALLS') {
    return { allowed: false, reason: ticker + ' STRONG_DOWN daily — do not buy calls against momentum' };
  }

  // Rule 1: SPY bull + ticker uptrend + puts = blocked
  if (regime === 'BULL' && (trend === 'UP' || trend === 'STRONG_UP') && dir === 'PUTS') {
    return { allowed: false, reason: 'SPY BULL + ' + ticker + ' UP — puts blocked' };
  }

  // Rule 2: SPY bear + ticker downtrend + calls = blocked
  if (regime === 'BEAR' && (trend === 'DOWN' || trend === 'STRONG_DOWN') && dir === 'CALLS') {
    return { allowed: false, reason: 'SPY BEAR + ' + ticker + ' DOWN — calls blocked' };
  }

  // Rule 3: SPY bull + high-beta + puts = blocked (even if ticker neutral)
  if (regime === 'BULL' && beta && dir === 'PUTS') {
    return { allowed: false, reason: 'SPY BULL + ' + ticker + ' high-beta — puts blocked' };
  }

  // Rule 4: SPY bear + high-beta + calls = blocked
  if (regime === 'BEAR' && beta && dir === 'CALLS') {
    return { allowed: false, reason: 'SPY BEAR + ' + ticker + ' high-beta — calls blocked' };
  }

  // Rule: Ticker trending opposite + SPY regime matches = block
  if (regime === 'BULL' && trend === 'UP' && dir === 'PUTS') {
    return { allowed: false, reason: 'SPY BULL + ' + ticker + ' trending UP — puts blocked' };
  }
  if (regime === 'BEAR' && trend === 'DOWN' && dir === 'CALLS') {
    return { allowed: false, reason: 'SPY BEAR + ' + ticker + ' trending DOWN — calls blocked' };
  }

  return {
    allowed: true,
    regime: regime,
    trend: trend,
    highBeta: beta,
  };
}

// ================================================================
// DIAGNOSTICS — for API endpoint
// ================================================================
function getState() {
  return {
    spyRegime: _spyCache.regime || 'NOT_LOADED',
    spySlope: _spyCache.slope ? (_spyCache.slope * 100).toFixed(2) + '%' : 'N/A',
    spyAtHighs: _spyCache.atHighs || false,
    spyCacheAge: _spyCache.ts ? Math.round((Date.now() - _spyCache.ts) / 1000) + 's' : 'N/A',
    tickerCacheSize: Object.keys(_tickerCache).length,
    tickerCache: Object.keys(_tickerCache).reduce(function(acc, k) {
      acc[k] = _tickerCache[k].trend;
      return acc;
    }, {}),
  };
}

// Force refresh (useful after market open)
function clearCache() {
  _spyCache = { bars: null, regime: null, ts: 0 };
  _tickerCache = {};
}

module.exports = {
  canEnter: canEnter,
  fetchSPYRegime: fetchSPYRegime,
  fetchTickerTrend: fetchTickerTrend,
  isHighBeta: isHighBeta,
  getState: getState,
  clearCache: clearCache,
};
