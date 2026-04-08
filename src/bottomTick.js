// bottomTick.js - Stratum Flow Scout v8.1
// @TheStrat method: Catalyst + Level + Strat Signal on 30min/2HR = Entry
// Scans for Failed 2U, Failed 2D, 3-1 setups on higher timeframes
// ONE trade, ONE catalyst, ONE level = 100-300% on 0DTE
// -----------------------------------------------------------------

var fetch = require('node-fetch');

var SCAN_TICKERS = ['SPY','QQQ','IWM','TSLA','NVDA','AMD','META','AAPL','AMZN','MSFT','GOOGL'];

// -- GET TOKEN ----------------------------------------------------
async function getToken() {
  try {
    var ts = require('./tradestation');
    return await ts.getAccessToken();
  } catch(e) { return null; }
}

function getTSBase() { return 'https://api.tradestation.com/v3'; }

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

    var headers = { 'Authorization': 'Bearer ' + token };

    var [res30, res2h, resDaily, resWeekly] = await Promise.all([
      fetch(url30, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(url2h, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(urlDaily, { headers }).then(r => r.json()).catch(() => ({})),
      fetch(urlWeekly, { headers }).then(r => r.json()).catch(() => ({})),
    ]);

    var bars30 = (res30.Bars || res30.bars || []);
    var bars2h = (res2h.Bars || res2h.bars || []);
    var barsDaily = (resDaily.Bars || resDaily.bars || []);
    var barsWeekly = (resWeekly.Bars || resWeekly.bars || []);

    // Detect setups on each timeframe
    var setups30 = detectSetups(bars30).map(function(s) { s.timeframe = '30MIN'; s.symbol = symbol; return s; });
    var setups2h = detectSetups(bars2h).map(function(s) { s.timeframe = '2HR'; s.symbol = symbol; return s; });
    var setupsDaily = detectSetups(barsDaily).map(function(s) { s.timeframe = 'DAILY'; s.symbol = symbol; return s; });

    // Calculate levels
    var levels = calculateLevels(barsDaily, barsWeekly);

    // Get current price
    var price = barsDaily.length > 0 ? parseFloat(barsDaily[barsDaily.length - 1].Close) : null;

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

module.exports = { scanTicker, scanAll, detectSetups, classifyBar, calculateLevels, SCAN_TICKERS };
