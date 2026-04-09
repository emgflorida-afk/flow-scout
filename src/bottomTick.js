// bottomTick.js - Stratum Flow Scout v8.1
// @TheStrat method: Catalyst + Level + Strat Signal on 30min/2HR = Entry
// Scans for Failed 2U, Failed 2D, 3-1 setups on higher timeframes
// ONE trade, ONE catalyst, ONE level = 100-300% on 0DTE
// -----------------------------------------------------------------

var fetch = require('node-fetch');

var SCAN_TICKERS = ['SPY','QQQ','IWM','TSLA','NVDA','AMD','META','AAPL','AMZN','MSFT','GOOGL','HUM'];

// -- GET TOKEN ----------------------------------------------------
async function getToken() {
  try {
    var ts = require('./tradestation');
    return await ts.getAccessToken();
  } catch(e) { return null; }
}

function getTSBase() { return 'https://api.tradestation.com/v3'; }

// -- CALCULATE EMA -----------------------------------------------
// Standard Exponential Moving Average calculation
// bars = array of {Close: price} objects, period = 13, 48, or 200
// Returns array of EMA values (same length as bars, NaN for insufficient data)
function calculateEMA(bars, period) {
  if (!bars || bars.length === 0) return [];
  var emaValues = [];
  var multiplier = 2 / (period + 1);

  // First EMA value = SMA of first 'period' bars
  var sum = 0;
  for (var i = 0; i < bars.length; i++) {
    var close = parseFloat(bars[i].Close);
    if (i < period - 1) {
      sum += close;
      emaValues.push(NaN);
    } else if (i === period - 1) {
      sum += close;
      var sma = sum / period;
      emaValues.push(sma);
    } else {
      var prevEma = emaValues[i - 1];
      var ema = (close - prevEma) * multiplier + prevEma;
      emaValues.push(ema);
    }
  }
  console.log('[EMA] Calculated ' + period + ' EMA over ' + bars.length + ' bars, last value: ' + (emaValues.length > 0 ? emaValues[emaValues.length - 1] : 'N/A'));
  return emaValues;
}

// -- DETECT EMA CROSSOVERS & ALIGNMENT ----------------------------
function detectEMASignals(bars5min, currentPrice) {
  var result = {
    ema13: null,
    ema48: null,
    ema200: null,
    crossAbove: false,
    crossBelow: false,
    fanOut: false,
    bullishAligned: false,
    bearishAligned: false,
    priceAbove200: false,
  };

  if (!bars5min || bars5min.length < 50) {
    console.log('[EMA] Not enough 5min bars (' + (bars5min ? bars5min.length : 0) + '), need 50+');
    return result;
  }

  var ema13 = calculateEMA(bars5min, 13);
  var ema48 = calculateEMA(bars5min, 48);
  var ema200 = calculateEMA(bars5min, 200);

  var len = bars5min.length;
  var cur13 = ema13[len - 1];
  var cur48 = ema48[len - 1];
  var cur200 = ema200[len - 1];
  var prev13 = ema13[len - 2];
  var prev48 = ema48[len - 2];

  result.ema13 = cur13;
  result.ema48 = cur48;
  result.ema200 = cur200;

  // Crossover detection: 13 EMA vs 48 EMA
  if (!isNaN(cur13) && !isNaN(cur48) && !isNaN(prev13) && !isNaN(prev48)) {
    // 13 crosses ABOVE 48
    if (prev13 < prev48 && cur13 > cur48) {
      result.crossAbove = true;
      console.log('[EMA] 13 EMA crossed ABOVE 48 EMA! Bullish crossover detected');
    }
    // 13 crosses BELOW 48
    if (prev13 > prev48 && cur13 < cur48) {
      result.crossBelow = true;
      console.log('[EMA] 13 EMA crossed BELOW 48 EMA! Bearish crossover detected');
    }
  }

  // Fan out detection: spread between 13 and 48 increasing over last 3 bars
  if (len >= 3 && !isNaN(ema13[len - 3]) && !isNaN(ema48[len - 3])) {
    var spread1 = Math.abs(ema13[len - 3] - ema48[len - 3]);
    var spread2 = Math.abs(ema13[len - 2] - ema48[len - 2]);
    var spread3 = Math.abs(ema13[len - 1] - ema48[len - 1]);
    if (spread3 > spread2 && spread2 > spread1) {
      result.fanOut = true;
      console.log('[EMA] EMA fan out detected -- spread increasing: ' + spread1.toFixed(4) + ' -> ' + spread2.toFixed(4) + ' -> ' + spread3.toFixed(4));
    }
  }

  // Alignment detection
  if (!isNaN(cur13) && !isNaN(cur48) && !isNaN(cur200)) {
    if (cur13 > cur48 && cur48 > cur200) {
      result.bullishAligned = true;
      console.log('[EMA] BULLISH alignment: 13 > 48 > 200');
    }
    if (cur13 < cur48 && cur48 < cur200) {
      result.bearishAligned = true;
      console.log('[EMA] BEARISH alignment: 13 < 48 < 200');
    }
  }

  // Price vs 200 EMA
  if (currentPrice && !isNaN(cur200)) {
    result.priceAbove200 = currentPrice > cur200;
    console.log('[EMA] Price ($' + currentPrice.toFixed(2) + ') ' + (result.priceAbove200 ? 'ABOVE' : 'BELOW') + ' 200 EMA ($' + cur200.toFixed(2) + ')');
  }

  return result;
}

// -- DETECT PRE-MARKET HIGH/LOW (first 30 min = first 6 5min bars) --
function detectPremarketLevels(bars5min, currentPrice) {
  var result = {
    high: null,
    low: null,
    breakAbovePMH: false,
    breakBelowPML: false,
    retestPMH: false,
    retestPML: false,
  };

  if (!bars5min || bars5min.length < 10) {
    console.log('[EMA] Not enough bars for premarket detection');
    return result;
  }

  // Find bars from 9:30-10:00 AM ET (first 6 five-minute bars of session)
  // TradeStation timestamps include timezone info, parse them
  var openingBars = [];
  for (var i = 0; i < bars5min.length; i++) {
    var ts = bars5min[i].TimeStamp || bars5min[i].Timestamp || '';
    var d = new Date(ts);
    var etHour = ((d.getUTCHours() - 4) + 24) % 24;
    var etMin = d.getUTCMinutes();
    var etTime = etHour * 60 + etMin;
    // 9:30 AM = 570, 10:00 AM = 600
    if (etTime >= 570 && etTime < 600) {
      openingBars.push(bars5min[i]);
    }
  }

  // If we can't parse timestamps, fall back to first 6 bars
  if (openingBars.length === 0 && bars5min.length >= 6) {
    console.log('[EMA] Could not parse timestamps for PM levels, using first 6 bars');
    openingBars = bars5min.slice(0, 6);
  }

  if (openingBars.length === 0) {
    console.log('[EMA] No opening range bars found');
    return result;
  }

  // Calculate pre-market high and low from opening range
  var pmHigh = -Infinity;
  var pmLow = Infinity;
  for (var j = 0; j < openingBars.length; j++) {
    var h = parseFloat(openingBars[j].High);
    var l = parseFloat(openingBars[j].Low);
    if (h > pmHigh) pmHigh = h;
    if (l < pmLow) pmLow = l;
  }

  result.high = pmHigh;
  result.low = pmLow;
  console.log('[EMA] Pre-market levels: PMH=$' + pmHigh.toFixed(2) + ' PML=$' + pmLow.toFixed(2) + ' (' + openingBars.length + ' bars)');

  if (!currentPrice) return result;

  // Break above PMH: current price is above pre-market high
  result.breakAbovePMH = currentPrice > pmHigh;
  // Break below PML: current price is below pre-market low
  result.breakBelowPML = currentPrice < pmLow;

  // Retest detection: look at recent bars for break-and-return pattern
  var recentBars = bars5min.slice(-5); // last 5 bars
  if (recentBars.length >= 3) {
    // Retest PMH: price was above PMH, pulled back near it, now bouncing
    var wasAbovePMH = false;
    var touchedPMH = false;
    for (var k = 0; k < recentBars.length - 1; k++) {
      var barHigh = parseFloat(recentBars[k].High);
      var barLow = parseFloat(recentBars[k].Low);
      var barClose = parseFloat(recentBars[k].Close);
      if (barHigh > pmHigh) wasAbovePMH = true;
      // "Touch" = low came within 0.15% of PMH
      if (wasAbovePMH && Math.abs(barLow - pmHigh) / pmHigh < 0.0015) touchedPMH = true;
    }
    if (wasAbovePMH && touchedPMH && currentPrice > pmHigh) {
      result.retestPMH = true;
      console.log('[EMA] RETEST PMH detected: broke above, pulled back, bouncing -- CALL signal');
    }

    // Retest PML: price was below PML, pulled back near it, now rejecting
    var wasBelowPML = false;
    var touchedPML = false;
    for (var m = 0; m < recentBars.length - 1; m++) {
      var mBarHigh = parseFloat(recentBars[m].High);
      var mBarLow = parseFloat(recentBars[m].Low);
      if (mBarLow < pmLow) wasBelowPML = true;
      if (wasBelowPML && Math.abs(mBarHigh - pmLow) / pmLow < 0.0015) touchedPML = true;
    }
    if (wasBelowPML && touchedPML && currentPrice < pmLow) {
      result.retestPML = true;
      console.log('[EMA] RETEST PML detected: broke below, pulled back, rejecting -- PUT signal');
    }
  }

  return result;
}

// -- BUILD CASEY SIGNAL MESSAGE -----------------------------------
function buildCaseySignal(ticker, emaData, premarketData, price) {
  var lines = [];
  lines.push('\uD83C\uDFAF CASEY SIGNAL: ' + ticker);

  // EMA crossover
  if (emaData.crossAbove) lines.push('13 EMA crossed ABOVE 48 EMA \u2705');
  if (emaData.crossBelow) lines.push('13 EMA crossed BELOW 48 EMA \u2705');

  // Alignment
  if (emaData.bullishAligned) lines.push('EMAs aligned BULLISH (13 > 48 > 200) \u2705');
  if (emaData.bearishAligned) lines.push('EMAs aligned BEARISH (13 < 48 < 200) \u2705');

  // Fan out
  if (emaData.fanOut) lines.push('EMAs fanning out \u2705');

  // Price vs 200
  if (emaData.priceAbove200) lines.push('Price above 200 EMA \u2705');
  else lines.push('Price below 200 EMA \u274C');

  // Premarket levels
  if (premarketData.high) {
    lines.push('PMH: $' + premarketData.high.toFixed(2) + ' | PML: $' + premarketData.low.toFixed(2));
  }
  if (premarketData.breakAbovePMH) lines.push('Break above PMH \u2705');
  if (premarketData.breakBelowPML) lines.push('Break below PML \u2705');
  if (premarketData.retestPMH) lines.push('Break & retest of PMH ($' + premarketData.high.toFixed(2) + ') \u2705');
  if (premarketData.retestPML) lines.push('Break & retest of PML ($' + premarketData.low.toFixed(2) + ') \u2705');

  // Direction
  var direction = 'NEUTRAL';
  var entryTrigger = null;
  if (emaData.crossAbove || emaData.bullishAligned) {
    direction = 'CALLS';
    entryTrigger = premarketData.high ? premarketData.high + 0.05 : (price ? price + 0.10 : null);
  } else if (emaData.crossBelow || emaData.bearishAligned) {
    direction = 'PUTS';
    entryTrigger = premarketData.low ? premarketData.low - 0.05 : (price ? price - 0.10 : null);
  }

  lines.push('DIRECTION: ' + direction);
  if (entryTrigger) lines.push('Entry trigger: $' + entryTrigger.toFixed(2));

  return lines.join('\n');
}

// -- CLASSIFY BAR (The Strat) ------------------------------------
function classifyBar(current, previous) {
  if (!current || !previous) return { type: 0, label: 'UNKNOWN' };
  var cH = parseFloat(current.High), cL = parseFloat(current.Low);
  var pH = parseFloat(previous.High), pL = parseFloat(previous.Low);

  var tookHigh = cH > pH;
  var tookLow = cL < pL;

  if (tookHigh && tookLow) return { type: 3, label: 'OUTSIDE', tookHigh: true, tookLow: true };
  if (!tookHigh && !tookLow) return { type: 1, label: 'INSIDE', tookHigh: false, tookLow: false };
  if (tookHigh && !tookLow) return { type: 2, label: '2-UP', tookHigh: true, tookLow: false };
  if (!tookHigh && tookLow) return { type: 2, label: '2-DOWN', tookHigh: false, tookLow: true };
  return { type: 0, label: 'UNKNOWN' };
}

// -- DETECT SETUPS -----------------------------------------------
function detectSetups(bars) {
  if (!bars || bars.length < 4) return [];
  var setups = [];

  for (var i = 2; i < bars.length; i++) {
    var prev2 = bars[i-2];
    var prev1 = bars[i-1];
    var curr = bars[i];

    var bar1 = classifyBar(prev1, prev2);
    var bar2 = classifyBar(curr, prev1);

    var cH = parseFloat(curr.High), cL = parseFloat(curr.Low), cC = parseFloat(curr.Close);
    var p1H = parseFloat(prev1.High), p1L = parseFloat(prev1.Low);
    var p2H = parseFloat(prev2.High), p2L = parseFloat(prev2.Low);

    // FAILED 2-UP: price broke above prior high then CLOSED below it
    if (bar2.tookHigh && cC < p1H) {
      setups.push({
        type: 'FAILED_2U',
        direction: 'BEARISH',
        action: 'PUT',
        bar: i,
        timestamp: curr.TimeStamp,
        trigger: p1L, // break below prior low = entry
        stop: cH,     // above the failed high
        description: 'Failed 2-Up: broke high then reversed. PUT below $' + p1L.toFixed(2),
        close: cC,
        high: cH,
        low: cL,
      });
    }

    // FAILED 2-DOWN: price broke below prior low then CLOSED above it
    if (bar2.tookLow && cC > p1L) {
      setups.push({
        type: 'FAILED_2D',
        direction: 'BULLISH',
        action: 'CALL',
        bar: i,
        timestamp: curr.TimeStamp,
        trigger: p1H, // break above prior high = entry
        stop: cL,     // below the failed low
        description: 'Failed 2-Down: broke low then reversed. CALL above $' + p1H.toFixed(2),
        close: cC,
        high: cH,
        low: cL,
      });
    }

    // 3-1 SETUP: outside bar followed by inside bar
    if (bar1.type === 3 && bar2.type === 1) {
      // Direction based on where outside bar closed
      var outsideClose = parseFloat(prev1.Close);
      var outsideMid = (p1H + p1L) / 2;
      var direction = outsideClose > outsideMid ? 'BULLISH' : 'BEARISH';

      setups.push({
        type: '3-1',
        direction: direction,
        action: direction === 'BULLISH' ? 'CALL' : 'PUT',
        bar: i,
        timestamp: curr.TimeStamp,
        trigger: direction === 'BULLISH' ? cH : cL,
        stop: direction === 'BULLISH' ? cL : cH,
        description: '3-1 Setup: Outside bar + Inside bar. ' +
          (direction === 'BULLISH' ? 'CALL above $' + cH.toFixed(2) : 'PUT below $' + cL.toFixed(2)),
        close: cC,
        high: cH,
        low: cL,
        insideHigh: cH,
        insideLow: cL,
      });
    }

    // 2-1-2 SETUP: directional bar + inside bar + break
    if (bar1.type === 2 && bar2.type === 1) {
      var direction2 = bar1.label === '2-UP' ? 'BULLISH' : 'BEARISH';
      setups.push({
        type: '2-1-2',
        direction: direction2,
        action: direction2 === 'BULLISH' ? 'CALL' : 'PUT',
        bar: i,
        timestamp: curr.TimeStamp,
        trigger: direction2 === 'BULLISH' ? cH : cL,
        stop: direction2 === 'BULLISH' ? cL : cH,
        description: '2-1-2 ' + direction2 + ': ' + bar1.label + ' + Inside. ' +
          (direction2 === 'BULLISH' ? 'CALL above $' + cH.toFixed(2) : 'PUT below $' + cL.toFixed(2)),
        close: cC,
        high: cH,
        low: cL,
      });
    }
  }

  return setups;
}

// -- CALCULATE LEVELS (PWH, PDH, PDL, Gap Fills) -----------------
function calculateLevels(dailyBars, weeklyBars) {
  var levels = {};

  if (dailyBars && dailyBars.length >= 2) {
    var yesterday = dailyBars[dailyBars.length - 2];
    var today = dailyBars[dailyBars.length - 1];
    levels.PDH = parseFloat(yesterday.High);
    levels.PDL = parseFloat(yesterday.Low);
    levels.PDC = parseFloat(yesterday.Close);
    levels.todayOpen = parseFloat(today.Open);
    levels.todayHigh = parseFloat(today.High);
    levels.todayLow = parseFloat(today.Low);

    // Gap
    levels.gapUp = levels.todayOpen > levels.PDH;
    levels.gapDown = levels.todayOpen < levels.PDL;
    levels.gapSize = levels.gapUp ? levels.todayOpen - levels.PDH :
                     levels.gapDown ? levels.PDL - levels.todayOpen : 0;

    // Gap fill levels
    if (levels.gapUp) levels.gapFill = levels.PDH;
    if (levels.gapDown) levels.gapFill = levels.PDL;

    // Pivot
    levels.pivot = (levels.PDH + levels.PDL + levels.PDC) / 3;
    levels.R1 = 2 * levels.pivot - levels.PDL;
    levels.S1 = 2 * levels.pivot - levels.PDH;
  }

  if (weeklyBars && weeklyBars.length >= 2) {
    var prevWeek = weeklyBars[weeklyBars.length - 2];
    levels.PWH = parseFloat(prevWeek.High);
    levels.PWL = parseFloat(prevWeek.Low);
    levels.PWC = parseFloat(prevWeek.Close);
  }

  return levels;
}

// -- SCAN ONE TICKER ---------------------------------------------
async function scanTicker(symbol, token) {
  try {
    // Fetch 30min bars (using 5min with 6 bars = 30min equivalent)
    // Actually fetch proper 30min by getting enough 5min bars
    var url30 = getTSBase() + '/marketdata/barcharts/' + symbol +
      '?unit=Minute&interval=30&barsback=10&sessiontemplate=Default';
    var url2h = getTSBase() + '/marketdata/barcharts/' + symbol +
      '?unit=Minute&interval=120&barsback=8&sessiontemplate=Default';
    var urlDaily = getTSBase() + '/marketdata/barcharts/' + symbol +
      '?unit=Daily&interval=1&barsback=5&sessiontemplate=Default';
    var urlWeekly = getTSBase() + '/marketdata/barcharts/' + symbol +
      '?unit=Weekly&interval=1&barsback=3&sessiontemplate=Default';
    // Casey method: 5min bars for EMA crossover detection (need 60 bars for 48 EMA + buffer)
    var url5min = getTSBase() + '/marketdata/barcharts/' + symbol +
      '?unit=Minute&interval=5&barsback=60&sessiontemplate=Default';

    var headers = { 'Authorization': 'Bearer ' + token };

    var [res30, res2h, resDaily, resWeekly, res5min] = await Promise.all([
      fetch(url30, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(url2h, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(urlDaily, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(urlWeekly, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(url5min, { headers }).then(r => r.json()).catch(() => ({})),
    ]);

    var bars30 = (res30.Bars || res30.bars || []);
    var bars2h = (res2h.Bars || res2h.bars || []);
    var barsDaily = (resDaily.Bars || resDaily.bars || []);
    var barsWeekly = (resWeekly.Bars || resWeekly.bars || []);
    var bars5min = (res5min.Bars || res5min.bars || []);
    console.log('[EMA] ' + symbol + ': fetched ' + bars5min.length + ' 5min bars for EMA calculation');

    // Detect setups on each timeframe
    var setups30 = detectSetups(bars30).map(function(s) { s.timeframe = '30MIN'; s.symbol = symbol; return s; });
    var setups2h = detectSetups(bars2h).map(function(s) { s.timeframe = '2HR'; s.symbol = symbol; return s; });
    var setupsDaily = detectSetups(barsDaily).map(function(s) { s.timeframe = 'DAILY'; s.symbol = symbol; return s; });

    // Calculate levels
    var levels = calculateLevels(barsDaily, barsWeekly);

    // Get current price (prefer 5min close for most recent, fall back to daily)
    var price = bars5min.length > 0 ? parseFloat(bars5min[bars5min.length - 1].Close) :
                barsDaily.length > 0 ? parseFloat(barsDaily[barsDaily.length - 1].Close) : null;

    // Casey method: EMA crossover detection on 5min bars
    var emaData = detectEMASignals(bars5min, price);
    var premarketData = detectPremarketLevels(bars5min, price);

    // Build Casey signal message if we have a crossover or alignment signal
    var caseySignal = null;
    if (emaData.crossAbove || emaData.crossBelow || emaData.bullishAligned || emaData.bearishAligned) {
      caseySignal = buildCaseySignal(symbol, emaData, premarketData, price);
      console.log('[EMA] ' + symbol + ' Casey signal built:\n' + caseySignal);
    }

    // Check if price is near any key level
    var nearLevel = null;
    if (price && levels.PWH && Math.abs(price - levels.PWH) / levels.PWH < 0.005) nearLevel = 'PWH';
    if (price && levels.PDH && Math.abs(price - levels.PDH) / levels.PDH < 0.005) nearLevel = 'PDH';
    if (price && levels.PDL && Math.abs(price - levels.PDL) / levels.PDL < 0.005) nearLevel = 'PDL';
    if (price && levels.PWL && Math.abs(price - levels.PWL) / levels.PWL < 0.005) nearLevel = 'PWL';
    if (price && levels.pivot && Math.abs(price - levels.pivot) / levels.pivot < 0.005) nearLevel = 'PIVOT';

    var allSetups = setups30.concat(setups2h).concat(setupsDaily);

    // Only return most recent setup per timeframe
    var latestSetups = [];
    var seenTF = {};
    for (var i = allSetups.length - 1; i >= 0; i--) {
      if (!seenTF[allSetups[i].timeframe]) {
        seenTF[allSetups[i].timeframe] = true;
        latestSetups.push(allSetups[i]);
      }
    }

    return {
      symbol: symbol,
      price: price,
      levels: levels,
      nearLevel: nearLevel,
      setups: latestSetups,
      bars30count: bars30.length,
      bars2hcount: bars2h.length,
      bars5mincount: bars5min.length,
      ema: emaData,
      premarket: premarketData,
      caseySignal: caseySignal,
    };
  } catch(e) {
    console.error('[BOTTOM-TICK] Error scanning', symbol, ':', e.message);
    return { symbol: symbol, error: e.message, setups: [] };
  }
}

// -- SCAN ALL TICKERS --------------------------------------------
async function scanAll() {
  var token = await getToken();
  if (!token) return { error: 'No token', results: [] };

  var results = [];
  // Scan in batches of 3 to avoid rate limiting
  for (var i = 0; i < SCAN_TICKERS.length; i += 3) {
    var batch = SCAN_TICKERS.slice(i, i + 3);
    var batchResults = await Promise.all(batch.map(function(sym) {
      return scanTicker(sym, token);
    }));
    results = results.concat(batchResults);
    if (i + 3 < SCAN_TICKERS.length) {
      await new Promise(function(r) { setTimeout(r, 1000); }); // Rate limit
    }
  }

  // Filter to only tickers with setups
  var withSetups = results.filter(function(r) { return r.setups && r.setups.length > 0; });

  // Sort by priority: near level + setup > just setup
  withSetups.sort(function(a, b) {
    var aScore = (a.nearLevel ? 10 : 0) + a.setups.length;
    var bScore = (b.nearLevel ? 10 : 0) + b.setups.length;
    return bScore - aScore;
  });

  return {
    scanned: results.length,
    withSetups: withSetups.length,
    timestamp: new Date().toISOString(),
    results: withSetups,
    allResults: results,
  };
}

module.exports = { scanTicker, scanAll, detectSetups, classifyBar, calculateLevels, calculateEMA, detectEMASignals, detectPremarketLevels, buildCaseySignal, SCAN_TICKERS };
