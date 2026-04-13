// preMarketScanner.js - Stratum Flow Scout v7.2
// Scans for AYCE 3 strategies + oil tickers
// 12HR Miyagi, 4HR Re-Trigger, 3-2-2 First Live
// Posts setup cards to Discord #strat-alerts at 9:15AM ET

var fetch = require('node-fetch');

var STRAT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
var CONV_WEBHOOK  = process.env.DISCORD_CONVICTION_WEBHOOK_URL;

// -- SCAN TICKERS ------------------------------------------------
// Core indices + tech + oil tickers
var SCAN_TICKERS = [
  // Indices -- 1HR entry
  'SPY', 'QQQ', 'IWM',
  // Tech -- always moving
  'NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'META', 'MRVL', 'AVGO', 'COIN',
  // Finance
  'JPM', 'GS', 'MS', 'WFC',
  // Defense -- NATO news
  'LMT', 'RTX', 'NOC', 'GD', 'LDOS', 'BAH',
  // Airlines -- oil dropping
  'DAL', 'UAL', 'LUV', 'AAL',
  // Oil/Energy -- monitor direction
  'XOM', 'CVX', 'OXY', 'XLE',
  // JSmith Apr 12 -- daily hammers (CALLS) + weekly shooters (PUTS)
  'U', 'ABNB', 'UBER', 'BIDU',
  // Market brief Apr 14 -- earnings + catalysts
  'MCD', 'FAST',
];

// Pre-market flow threshold -- lower to catch setups early
var PRE_MARKET_MIN_FLOW = 50000;

// -- 6HR DIRECTION CHECK ----------------------------------------
// 6HR candles complete at: 4AM, 10AM, 4PM, 10PM ET
// Used to filter cards BEFORE they fire
function get6HRDirection(bars6HR) {
  if (!bars6HR || bars6HR.length < 2) return 'MIXED';
  var curr = bars6HR[bars6HR.length - 1];
  var prev = bars6HR[bars6HR.length - 2];
  var close = parseFloat(curr.Close || 0);
  var open  = parseFloat(curr.Open  || 0);
  var prevH = parseFloat(prev.High  || 0);
  var prevL = parseFloat(prev.Low   || 0);
  if (close > open && close > prevH) return 'BULLISH';
  if (close < open && close < prevL) return 'BEARISH';
  if (close > open) return 'BULLISH';
  if (close < open) return 'BEARISH';
  return 'MIXED';
}

// -- FTFC (Full Time Frame Continuity) PRE-FILTER ----------------
// Check monthly/weekly/daily/60m continuity before scanning.
// If FTFC is strongly directional, skip setups that fight it.
// Same logic as signalEnricher.getContinuity.
function getContinuity(bars) {
  if (!bars || bars.length < 2) return 'UNKNOWN';
  var current = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var close = parseFloat(current.Close);
  var prevClose = parseFloat(prev.Close);
  return close > prevClose ? 'BULL' : 'BEAR';
}

async function getFTFC(symbol) {
  try {
    var monthlyBars = await getBars(symbol, 'Monthly', '1', 3);
    var weeklyBars  = await getBars(symbol, 'Weekly', '1', 3);
    var dailyBars   = await getBars(symbol, 'Daily', '1', 3);
    var sixtyBars   = await getBars(symbol, 'Minute', '60', 3);

    var monthlyCont = getContinuity(monthlyBars);
    var weeklyCont  = getContinuity(weeklyBars);
    var dailyCont   = getContinuity(dailyBars);
    var sixtyCont   = getContinuity(sixtyBars);

    var tfs = [monthlyCont, weeklyCont, dailyCont, sixtyCont];
    var bullCount = tfs.filter(function(t) { return t === 'BULL'; }).length;
    var bearCount = tfs.filter(function(t) { return t === 'BEAR'; }).length;

    var ftfc = 'MIXED';
    if (bullCount === 4) ftfc = 'BULL';
    else if (bearCount === 4) ftfc = 'BEAR';
    else if (bullCount >= 3) ftfc = 'LEAN_BULL';
    else if (bearCount >= 3) ftfc = 'LEAN_BEAR';

    return {
      ftfc: ftfc,
      bullCount: bullCount,
      bearCount: bearCount,
      detail: monthlyCont[0] + weeklyCont[0] + dailyCont[0] + sixtyCont[0], // e.g. "BBBU"
    };
  } catch(e) {
    console.error('[SCANNER] FTFC error for ' + symbol + ':', e.message);
    return { ftfc: 'MIXED', bullCount: 0, bearCount: 0, detail: '????' };
  }
}

// Returns true if setup direction fights strong FTFC
function ftfcVetoes(ftfc, setupDirection) {
  // setupDirection: 'CALLS' or 'PUTS'
  if (ftfc === 'BULL' && setupDirection === 'PUTS') return true;
  if (ftfc === 'BEAR' && setupDirection === 'CALLS') return true;
  return false;
}

// -- CANDLE TYPE DETECTION ---------------------------------------
function getCandleType(candle, prev) {
  if (!candle || !prev) return 'unknown';
  var high = parseFloat(candle.High);
  var low  = parseFloat(candle.Low);
  var ph   = parseFloat(prev.High);
  var pl   = parseFloat(prev.Low);
  if (high > ph && low < pl)  return '3';
  if (high <= ph && low >= pl) return '1';
  if (high > ph && low >= pl) return '2U';
  if (low < pl && high <= ph)  return '2D';
  return 'unknown';
}

// -- GET BARS FROM TRADESTATION API -----------------------------
async function getBars(symbol, unit, interval, barsback) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) { console.log('[SCANNER] No TS token'); return []; }
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + symbol
      + '?interval=' + interval
      + '&unit=' + unit
      + '&barsback=' + (barsback || 10)
      + '&sessiontemplate=USEQPreAndPost';
    var res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    return (data && data.Bars) ? data.Bars : [];
  } catch(e) { console.error('[SCANNER] getBars error:', e.message); return []; }
}

// -- POST TO DISCORD -------------------------------------------
async function postCard(webhookUrl, message, username) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + message + '\n```', username: username || 'Stratum Scanner' })
    });
  } catch(e) { console.error('[SCANNER] Discord error:', e.message); }
}

// ================================================================
// STRATEGY 1: 12HR MIYAGI (1-3-1)
// ================================================================
async function scanMiyagi(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '720', 10);
    if (bars.length < 5) return null;
    var b4 = bars[bars.length - 1];
    var b3 = bars[bars.length - 2];
    var b2 = bars[bars.length - 3];
    var b1 = bars[bars.length - 4];
    var b0 = bars[bars.length - 5];
    var type1 = getCandleType(b1, b0);
    var type2 = getCandleType(b2, b1);
    var type3 = getCandleType(b3, b2);
    var type4 = getCandleType(b4, b3);
    if (type1 !== '1' || type2 !== '3' || type3 !== '1') return null;
    if (type4 !== '2U' && type4 !== '2D') return null;
    if (parseFloat(b4.High) > parseFloat(b3.High) && parseFloat(b4.Low) < parseFloat(b3.Low)) return null;
    var trigger   = parseFloat(((parseFloat(b3.High) + parseFloat(b3.Low)) / 2).toFixed(2));
    var t1        = type4 === '2D' ? parseFloat(b3.High).toFixed(2) : parseFloat(b3.Low).toFixed(2);
    var t2        = type4 === '2D' ? parseFloat(b2.High).toFixed(2) : parseFloat(b2.Low).toFixed(2);
    var direction = type4 === '2D' ? 'CALLS' : 'PUTS';
    return { strategy: '12HR MIYAGI', symbol: symbol, direction: direction,
             trigger: trigger, t1: t1, t2: t2, current: parseFloat(b4.Close), type4: type4, valid: true };
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 2: 4HR RE-TRIGGER (2-2 REV)
// ================================================================
async function scan4HRRetrigger(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '240', 10);
    if (bars.length < 3) return null;
    var bAM8  = bars[bars.length - 1];
    var bAM4  = bars[bars.length - 2];
    var bPrev = bars[bars.length - 3];
    var type4AM = getCandleType(bAM4, bPrev);
    var type8AM = getCandleType(bAM8, bAM4);
    if (type4AM === '2D' && type8AM === '2U') {
      var entry = parseFloat(bAM4.High).toFixed(2);
      var stop  = parseFloat(bAM4.Low).toFixed(2);
      if (parseFloat(bAM8.Close) > parseFloat(entry)) return null;
      return { strategy: '4HR RE-TRIGGER', symbol: symbol, direction: 'CALLS',
               entryLevel: entry, stopLevel: stop, current: parseFloat(bAM8.Close), valid: true };
    }
    if (type4AM === '2U' && type8AM === '2D') {
      var entry2 = parseFloat(bAM4.Low).toFixed(2);
      var stop2  = parseFloat(bAM4.High).toFixed(2);
      if (parseFloat(bAM8.Close) < parseFloat(entry2)) return null;
      return { strategy: '4HR RE-TRIGGER', symbol: symbol, direction: 'PUTS',
               entryLevel: entry2, stopLevel: stop2, current: parseFloat(bAM8.Close), valid: true };
    }
    return null;
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 3: 3-2-2 FIRST LIVE (1HR)
// ================================================================
async function scan322(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '60', 6);
    if (bars.length < 4) return null;
    var b10AM = bars[bars.length - 1];
    var b9AM  = bars[bars.length - 2];
    var b8AM  = bars[bars.length - 3];
    var bPrev = bars[bars.length - 4];
    var type8AM = getCandleType(b8AM, bPrev);
    var type9AM = getCandleType(b9AM, b8AM);
    if (type8AM !== '3') return null;
    if (type9AM === '2D') {
      return { strategy: '3-2-2 FIRST LIVE', symbol: symbol, direction: 'CALLS',
               entryLevel: parseFloat(b9AM.High).toFixed(2),
               stopLevel:  parseFloat(b9AM.Low).toFixed(2),
               target:     parseFloat(b8AM.High).toFixed(2),
               current:    parseFloat(b10AM.Close), valid: true };
    }
    if (type9AM === '2U') {
      return { strategy: '3-2-2 FIRST LIVE', symbol: symbol, direction: 'PUTS',
               entryLevel: parseFloat(b9AM.Low).toFixed(2),
               stopLevel:  parseFloat(b9AM.High).toFixed(2),
               target:     parseFloat(b8AM.Low).toFixed(2),
               current:    parseFloat(b10AM.Close), valid: true };
    }
    return null;
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 4: 7HR QQQ (1-3 directional + liquidity sweep)
// 7hr candles: 9PM, 4AM, 11AM, 6PM
// Setup: 9PM = 1 (inside), 4AM = 3 (outside)
// Mark 50% of the 3-bar. Wait until AFTER 11AM.
// Enter on liquidity sweep + retest on 5/15min TF
// ================================================================
async function scan7HR(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '420', 6);
    if (bars.length < 4) return null;
    var b11AM = bars[bars.length - 1];
    var b4AM  = bars[bars.length - 2];
    var b9PM  = bars[bars.length - 3];
    var bPrev = bars[bars.length - 4];
    var type9PM = getCandleType(b9PM, bPrev);
    var type4AM = getCandleType(b4AM, b9PM);
    if (type9PM !== '1') return null;
    if (type4AM !== '3') return null;
    var midpoint = parseFloat(((parseFloat(b4AM.High) + parseFloat(b4AM.Low)) / 2).toFixed(2));
    var high4AM = parseFloat(b4AM.High);
    var low4AM  = parseFloat(b4AM.Low);
    var current = parseFloat(b11AM.Close);
    var direction = current > midpoint ? 'PUTS' : 'CALLS';
    return {
      strategy: '7HR LIQUIDITY SWEEP', symbol: symbol, direction: direction,
      trigger: midpoint, high4AM: high4AM, low4AM: low4AM,
      current: current, valid: true,
      note: 'Wait for sweep of ' + (direction === 'CALLS' ? 'low' : 'high') + ' then retest on 5/15min'
    };
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 5: FAILED 9 (8AM/9AM manipulation reversal)
// 1HR candles: mark 8AM high/low/50%
// 9AM goes 2D or 2U before open
// After open, 9AM triggers 50% and reverses into outside 3
// Stop = 10AM 2-2 continuation (opposite of 9AM direction)
// ================================================================
async function scanFailed9(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '60', 5);
    if (bars.length < 4) return null;
    var b10AM = bars[bars.length - 1];
    var b9AM  = bars[bars.length - 2];
    var b8AM  = bars[bars.length - 3];
    var bPrev = bars[bars.length - 4];
    var type9AM = getCandleType(b9AM, b8AM);
    var type10AM = getCandleType(b10AM, b9AM);
    var mid8AM = parseFloat(((parseFloat(b8AM.High) + parseFloat(b8AM.Low)) / 2).toFixed(2));
    if (type9AM === '2U' && type10AM === '3') {
      var close10 = parseFloat(b10AM.Close);
      if (close10 < mid8AM) {
        return {
          strategy: 'FAILED 9', symbol: symbol, direction: 'PUTS',
          entryLevel: parseFloat(b9AM.Low).toFixed(2),
          stopLevel: parseFloat(b10AM.High).toFixed(2),
          target: parseFloat(b8AM.Low).toFixed(2),
          mid8AM: mid8AM, current: close10, valid: true
        };
      }
    }
    if (type9AM === '2D' && type10AM === '3') {
      var close10b = parseFloat(b10AM.Close);
      if (close10b > mid8AM) {
        return {
          strategy: 'FAILED 9', symbol: symbol, direction: 'CALLS',
          entryLevel: parseFloat(b9AM.High).toFixed(2),
          stopLevel: parseFloat(b10AM.Low).toFixed(2),
          target: parseFloat(b8AM.High).toFixed(2),
          mid8AM: mid8AM, current: close10b, valid: true
        };
      }
    }
    return null;
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 6: ORB (Opening Range Breakout) — CardDave method
// ETFs (SPY, QQQ, IWM): 90-min range (9:30-11:00AM) → breakout after 11AM
// Mag 7 stocks: 15-min range (9:30-9:45AM) → breakout after 9:45AM
// Entry on break of range high (CALLS) or low (PUTS) with volume
// Stop = opposite side of the range OR midpoint
// ================================================================
var ORB_ETFS = ['SPY', 'QQQ', 'IWM'];
var ORB_MAG7 = ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'META'];

async function scanORB(symbol) {
  try {
    var isETF = ORB_ETFS.indexOf(symbol) !== -1;
    var isMag7 = ORB_MAG7.indexOf(symbol) !== -1;
    if (!isETF && !isMag7) return null;

    // Fetch 5-min bars for today's session
    var barsNeeded = isETF ? 25 : 10; // extra bars for context
    var bars = await getBars(symbol, 'Minute', '5', barsNeeded);
    if (!bars || bars.length < 5) return null;

    // Find session open (9:30 AM ET) and calculate range bars
    var rangeBars = isETF ? 18 : 3; // 90min/5min = 18, 15min/5min = 3
    var rangeLabel = isETF ? '90-MIN' : '15-MIN';

    // Filter bars to only intraday (after 9:30 AM ET)
    var etTime = require('./etTime');
    var todayBars = [];
    for (var i = 0; i < bars.length; i++) {
      var barTime = new Date(bars[i].TimeStamp);
      var barET = barTime.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
      var timePart = (barET.split(', ')[1] || barET).split(':');
      var barHour = parseInt(timePart[0], 10);
      var barMin = parseInt(timePart[1], 10);
      var barTotal = barHour * 60 + barMin;
      if (barTotal >= 9 * 60 + 30) todayBars.push(bars[i]);
    }

    if (todayBars.length < rangeBars + 1) return null; // need range bars + at least 1 breakout bar

    // Calculate opening range (first N bars)
    var rangeHigh = -Infinity;
    var rangeLow = Infinity;
    var rangeVolume = 0;
    for (var j = 0; j < rangeBars && j < todayBars.length; j++) {
      var h = parseFloat(todayBars[j].High);
      var l = parseFloat(todayBars[j].Low);
      if (h > rangeHigh) rangeHigh = h;
      if (l < rangeLow) rangeLow = l;
      rangeVolume += parseFloat(todayBars[j].TotalVolume || todayBars[j].Volume || 0);
    }

    if (rangeHigh === -Infinity || rangeLow === Infinity) return null;

    // Get current bar (latest)
    var currentBar = todayBars[todayBars.length - 1];
    var current = parseFloat(currentBar.Close);
    var currentHigh = parseFloat(currentBar.High);
    var currentLow = parseFloat(currentBar.Low);
    var midpoint = parseFloat(((rangeHigh + rangeLow) / 2).toFixed(2));
    var rangeSize = rangeHigh - rangeLow;

    // Check for breakout — price must be OUTSIDE the range
    var direction = null;
    var trigger = null;
    var stop = null;

    if (currentHigh > rangeHigh && current > rangeHigh) {
      // Bullish breakout — closed above range high
      direction = 'CALLS';
      trigger = parseFloat(rangeHigh.toFixed(2));
      stop = parseFloat(midpoint.toFixed(2)); // stop at midpoint
    } else if (currentLow < rangeLow && current < rangeLow) {
      // Bearish breakout — closed below range low
      direction = 'PUTS';
      trigger = parseFloat(rangeLow.toFixed(2));
      stop = parseFloat(midpoint.toFixed(2));
    }

    if (!direction) return null;

    // Target = range size extension from breakout level
    var target = direction === 'CALLS'
      ? parseFloat((rangeHigh + rangeSize).toFixed(2))
      : parseFloat((rangeLow - rangeSize).toFixed(2));

    return {
      strategy: 'ORB ' + rangeLabel, symbol: symbol, direction: direction,
      entryLevel: trigger.toFixed(2),
      stopLevel: stop.toFixed(2),
      target: target.toFixed(2),
      rangeHigh: rangeHigh.toFixed(2),
      rangeLow: rangeLow.toFixed(2),
      midpoint: midpoint.toFixed(2),
      rangeSize: rangeSize.toFixed(2),
      current: current,
      valid: true,
      isETF: isETF,
      note: (isETF ? 'ETF 90-min ORB' : 'Mag 7 15-min ORB') + ' — CardDave method'
    };
  } catch(e) { return null; }
}

// ================================================================
// STRATEGY 7: CRT (Candle Range Theory) — John JSmith method
// Sweep of prior candle high/low then reversal close
// CRT_HIGH: swept prior high, closed back below → BEARISH
// CRT_LOW: swept prior low, closed back above → BULLISH
// Works on 60-min, 4HR, and daily timeframes
// ================================================================
async function scanCRT(symbol) {
  try {
    // Check 60-min bars for CRT
    var bars60 = await getBars(symbol, 'Minute', '60', 5);
    if (!bars60 || bars60.length < 3) return null;

    var curr = bars60[bars60.length - 1];
    var prev = bars60[bars60.length - 2];
    var prev2 = bars60[bars60.length - 3];

    var cH = parseFloat(curr.High), cL = parseFloat(curr.Low);
    var cO = parseFloat(curr.Open), cC = parseFloat(curr.Close);
    var pH = parseFloat(prev.High), pL = parseFloat(prev.Low);
    var pC = parseFloat(prev.Close);

    // CRT HIGH: current bar swept prior high (High > prevHigh)
    // but closed below prior high AND closed bearish (Close < Open)
    if (cH > pH && cC < pH && cC < cO) {
      return {
        strategy: 'CRT HIGH (60M)', symbol: symbol, direction: 'PUTS',
        entryLevel: pH.toFixed(2), // entry at prior high (now resistance)
        stopLevel: cH.toFixed(2),  // stop above the sweep high
        target: pL.toFixed(2),     // target prior low
        sweepHigh: cH.toFixed(2),
        priorHigh: pH.toFixed(2),
        current: cC,
        valid: true,
        crtType: 'HIGH',
        timeframe: '60M',
        note: 'Swept prior high, reversed. Classic CRT short setup.'
      };
    }

    // CRT LOW: current bar swept prior low (Low < prevLow)
    // but closed above prior low AND closed bullish (Close > Open)
    if (cL < pL && cC > pL && cC > cO) {
      return {
        strategy: 'CRT LOW (60M)', symbol: symbol, direction: 'CALLS',
        entryLevel: pL.toFixed(2), // entry at prior low (now support)
        stopLevel: cL.toFixed(2),  // stop below the sweep low
        target: pH.toFixed(2),     // target prior high
        sweepLow: cL.toFixed(2),
        priorLow: pL.toFixed(2),
        current: cC,
        valid: true,
        crtType: 'LOW',
        timeframe: '60M',
        note: 'Swept prior low, reversed. Classic CRT long setup.'
      };
    }

    return null;
  } catch(e) { return null; }
}

// ================================================================
// BUILD SETUP CARD
// ================================================================
function buildSetupCard(setup) {
  if (!setup || !setup.valid) return null;
  var time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  var lines2 = [];
  if (setup.strategy === '12HR MIYAGI') {
    lines2.push('12HR MIYAGI -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: 1-3-1 Confirmed');
    lines2.push('===============================');
    lines2.push('Trigger    $' + setup.trigger + '  <-- ENTRY (50% of Candle 3)');
    lines2.push('T1         $' + setup.t1 + '  (Candle 3 high/low)');
    lines2.push('T2         $' + setup.t2 + '  (Candle 2 outside bar)');
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push('Entry      Price hits trigger at open');
    lines2.push('Exit       60-min flip = immediate exit');
    lines2.push('Candle 4   ' + setup.type4 + ' confirmed');
  }
  if (setup.strategy === '4HR RE-TRIGGER') {
    lines2.push('4HR RE-TRIGGER -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: 2-2 Reversal Confirmed');
    lines2.push('===============================');
    lines2.push('Entry      $' + setup.entryLevel + '  <-- Break of 4AM candle');
    lines2.push('Stop       $' + setup.stopLevel);
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push('Be ready -- may trigger immediately at 9:30AM bell');
    lines2.push('Exit       60-min flip = immediate exit');
  }
  if (setup.strategy === '3-2-2 FIRST LIVE') {
    lines2.push('3-2-2 FIRST LIVE -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: 3-2-2 Reversal Confirmed');
    lines2.push('===============================');
    lines2.push('Entry      $' + setup.entryLevel + '  <-- Break of 9AM candle');
    lines2.push('Stop       $' + setup.stopLevel + '  (60-min flip)');
    lines2.push('Target     $' + setup.target + '  (8AM outside bar)');
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push('Execute at 10AM session');
    lines2.push('Exit       60-min flip = immediate exit');
  }
  if (setup.strategy === '7HR LIQUIDITY SWEEP') {
    lines2.push('7HR LIQUIDITY SWEEP -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: 1-3 Confirmed (Inside -> Outside)');
    lines2.push('===============================');
    lines2.push('50% Trigger $' + setup.trigger + '  <-- midpoint of 4AM 3-bar');
    lines2.push('4AM High    $' + setup.high4AM);
    lines2.push('4AM Low     $' + setup.low4AM);
    lines2.push('Current     $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push('WAIT until AFTER 11AM ET');
    lines2.push(setup.note || 'Enter on sweep + retest on 5/15min');
    lines2.push('Exit        60-min flip = immediate exit');
  }
  if (setup.strategy === 'FAILED 9') {
    lines2.push('FAILED 9 -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: 9AM Failed -> 10AM Outside 3');
    lines2.push('===============================');
    lines2.push('Entry      $' + setup.entryLevel);
    lines2.push('Stop       $' + setup.stopLevel);
    lines2.push('Target     $' + setup.target + '  (8AM bar extreme)');
    lines2.push('8AM 50%    $' + setup.mid8AM);
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push('Fast move -- usually first 5 min after open');
    lines2.push('Exit        60-min flip = immediate exit');
  }
  if (setup.strategy && setup.strategy.indexOf('ORB') === 0) {
    lines2.push(setup.strategy + ' -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: Opening Range Breakout');
    lines2.push('===============================');
    lines2.push('Range High  $' + setup.rangeHigh);
    lines2.push('Range Low   $' + setup.rangeLow);
    lines2.push('Midpoint    $' + setup.midpoint);
    lines2.push('Range Size  $' + setup.rangeSize);
    lines2.push('-------------------------------');
    lines2.push('Entry      $' + setup.entryLevel + '  <-- Range breakout');
    lines2.push('Stop       $' + setup.stopLevel + '  (midpoint of range)');
    lines2.push('Target     $' + setup.target + '  (1x range extension)');
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push(setup.note || 'ORB breakout');
    lines2.push('Exit       Failure to hold breakout = immediate exit');
  }
  if (setup.strategy && setup.strategy.indexOf('CRT') === 0) {
    lines2.push(setup.strategy + ' -- ' + setup.symbol + ' ' + setup.direction);
    lines2.push('Pattern: Candle Range Theory Sweep & Reverse');
    lines2.push('===============================');
    if (setup.crtType === 'HIGH') {
      lines2.push('Sweep High  $' + setup.sweepHigh + '  <-- swept prior high');
      lines2.push('Prior High  $' + setup.priorHigh + '  <-- now resistance');
    } else {
      lines2.push('Sweep Low   $' + setup.sweepLow + '  <-- swept prior low');
      lines2.push('Prior Low   $' + setup.priorLow + '  <-- now support');
    }
    lines2.push('Entry      $' + setup.entryLevel);
    lines2.push('Stop       $' + setup.stopLevel);
    lines2.push('Target     $' + setup.target);
    lines2.push('Current    $' + setup.current);
    lines2.push('-------------------------------');
    lines2.push(setup.note || 'CRT reversal');
    lines2.push('Timeframe  ' + (setup.timeframe || '60M'));
    lines2.push('Exit       60-min flip = immediate exit');
  }
  // -- FTFC badge on every card --
  if (setup.ftfc) {
    var ftfcLabel = setup.ftfc;
    if (ftfcLabel === 'BULL' || ftfcLabel === 'LEAN_BULL') ftfcLabel = 'BULLISH';
    if (ftfcLabel === 'BEAR' || ftfcLabel === 'LEAN_BEAR') ftfcLabel = 'BEARISH';
    lines2.push('FTFC       ' + ftfcLabel + ' (' + (setup.ftfcDetail || '????') + ')');
  }
  lines2.push('Time       ' + time + ' ET');
  return lines2.join('\n');
}

// ================================================================
// MAIN SCANNER -- runs at 9:15AM ET
// ================================================================
async function runPreMarketScan() {
  console.log('[SCANNER] Running pre-market scan for ' + SCAN_TICKERS.length + ' tickers...');
  var setups = [];
  var ftfcCache = {}; // cache FTFC per ticker so we don't re-fetch
  for (var i = 0; i < SCAN_TICKERS.length; i++) {
    var ticker  = SCAN_TICKERS[i];

    // -- FTFC PRE-FILTER: check continuity FIRST --
    var ftfcData = await getFTFC(ticker);
    ftfcCache[ticker] = ftfcData;
    console.log('[SCANNER] ' + ticker + ' FTFC=' + ftfcData.ftfc + ' (' + ftfcData.detail + ')');

    var miyagi  = await scanMiyagi(ticker);
    var retrig  = await scan4HRRetrigger(ticker);
    var sevenHR = await scan7HR(ticker);

    // Tag each setup with FTFC and filter those that fight full continuity
    var candidates = [miyagi, retrig, sevenHR].filter(Boolean);
    for (var c = 0; c < candidates.length; c++) {
      var setup = candidates[c];
      setup.ftfc = ftfcData.ftfc;
      setup.ftfcDetail = ftfcData.detail;
      if (ftfcVetoes(ftfcData.ftfc, setup.direction)) {
        console.log('[SCANNER] FTFC VETO: ' + ticker + ' ' + setup.strategy + ' ' + setup.direction + ' fights ' + ftfcData.ftfc + ' continuity — SKIPPED');
        continue;
      }
      setups.push(setup);
    }
  }
  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  if (setups.length === 0) {
    var msg = 'PRE-MARKET SCAN -- ' + date + '\n===============================\nNo AYCE setups detected today\nWatch for Strat alerts at open';
    await postCard(STRAT_WEBHOOK, msg, 'Stratum Scanner');
    console.log('[SCANNER] No setups found');
    return;
  }
  var header = 'PRE-MARKET SETUP REPORT -- ' + date + '\n' + setups.length + ' AYCE setup(s) detected';
  await postCard(STRAT_WEBHOOK, header, 'Stratum Scanner');
  for (var j = 0; j < setups.length; j++) {
    var card = buildSetupCard(setups[j]);
    if (card) {
      await postCard(STRAT_WEBHOOK, card, 'Stratum Scanner');
      if (setups[j].strategy === '12HR MIYAGI') {
        await postCard(CONV_WEBHOOK, card, 'Stratum Scanner');
      }
    }
  }
  console.log('[SCANNER] ' + setups.length + ' setup(s) posted');
}

// 3-2-2 scanner runs at 10AM after 9AM candle closes
async function run322Scan() {
  console.log('[322 SCAN] Running 10AM check (322 + Failed 9)...');
  for (var i = 0; i < SCAN_TICKERS.length; i++) {
    var ticker = SCAN_TICKERS[i];

    // -- FTFC PRE-FILTER --
    var ftfcData = await getFTFC(ticker);
    console.log('[322 SCAN] ' + ticker + ' FTFC=' + ftfcData.ftfc + ' (' + ftfcData.detail + ')');

    var setup = await scan322(ticker);
    if (setup) {
      setup.ftfc = ftfcData.ftfc;
      setup.ftfcDetail = ftfcData.detail;
      if (ftfcVetoes(ftfcData.ftfc, setup.direction)) {
        console.log('[322 SCAN] FTFC VETO: ' + ticker + ' ' + setup.strategy + ' ' + setup.direction + ' fights ' + ftfcData.ftfc + ' — SKIPPED');
      } else {
        var card = buildSetupCard(setup);
        if (card) await postCard(STRAT_WEBHOOK, card, 'Stratum Scanner');
      }
    }
    var f9 = await scanFailed9(ticker);
    if (f9) {
      f9.ftfc = ftfcData.ftfc;
      f9.ftfcDetail = ftfcData.detail;
      if (ftfcVetoes(ftfcData.ftfc, f9.direction)) {
        console.log('[322 SCAN] FTFC VETO: ' + ticker + ' Failed9 ' + f9.direction + ' fights ' + ftfcData.ftfc + ' — SKIPPED');
      } else {
        var f9card = buildSetupCard(f9);
        if (f9card) await postCard(STRAT_WEBHOOK, f9card, 'Stratum Scanner');
      }
    }
  }
}

module.exports = {
  runPreMarketScan: runPreMarketScan,
  run322Scan: run322Scan,
  scanMiyagi: scanMiyagi,
  scan4HRRetrigger: scan4HRRetrigger,
  scan322: scan322,
  scan7HR: scan7HR,
  scanFailed9: scanFailed9,
  scanORB: scanORB,
  scanCRT: scanCRT,
  getCandleType: getCandleType,
  getBars: getBars,
  buildSetupCard: buildSetupCard,
  getFTFC: getFTFC,
  ftfcVetoes: ftfcVetoes,
  SCAN_TICKERS: SCAN_TICKERS,
};