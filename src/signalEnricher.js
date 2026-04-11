// signalEnricher.js - Stratum Flow Scout v8.3
// SIGNAL ENRICHMENT LAYER
// Fetches 4HR bars, calculates EMAs, detects patterns, checks FTFC,
// queries dynamicBias, and builds flow summary.
// Fills in the tvData object that caseyConfluence needs to score properly.

var fetch = require('node-fetch');

var preMarketScanner = null;
var dynamicBias = null;
var bullflow = null;

try { preMarketScanner = require('./preMarketScanner'); } catch(e) {}
try { dynamicBias = require('./dynamicBias'); } catch(e) {}
try { bullflow = require('./bullflowStream'); } catch(e) {}

// ================================================================
// SIMPLE EMA CALCULATOR
// ================================================================
function calcEMA(bars, period, field) {
  if (!bars || bars.length < period) return null;
  var k = 2 / (period + 1);
  var ema = parseFloat(bars[0][field || 'Close']);
  for (var i = 1; i < bars.length; i++) {
    ema = parseFloat(bars[i][field || 'Close']) * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(4));
}

// ================================================================
// CANDLE PATTERN DETECTOR
// ================================================================
function detectCandlePattern(bar) {
  if (!bar) return 'NORMAL';
  var o = parseFloat(bar.Open);
  var h = parseFloat(bar.High);
  var l = parseFloat(bar.Low);
  var c = parseFloat(bar.Close);
  var body = Math.abs(c - o);
  var range = h - l;
  if (range === 0) return 'DOJI';

  var upperWick = h - Math.max(o, c);
  var lowerWick = Math.min(o, c) - l;

  if (body < range * 0.1) return 'DOJI';
  if (lowerWick >= body * 2 && upperWick < body * 0.5 && c > o) return 'HAMMER';
  if (upperWick >= body * 2 && lowerWick < body * 0.5 && c < o) return 'SHOOTER';
  if (c < o && body > range * 0.6) return 'BEARISH_ENGULFING';
  if (c > o && body > range * 0.6) return 'BULLISH_ENGULFING';
  return 'NORMAL';
}

// ================================================================
// GET BARS FROM TRADESTATION
// ================================================================
async function getBars(symbol, unit, interval, barsback) {
  if (preMarketScanner && preMarketScanner.getBars) {
    return await preMarketScanner.getBars(symbol, unit, interval, barsback);
  }
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return [];
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + symbol
      + '?interval=' + interval + '&unit=' + unit + '&barsback=' + (barsback || 10)
      + '&sessiontemplate=USEQPreAndPost';
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    return (data && data.Bars) ? data.Bars : [];
  } catch(e) { return []; }
}

// ================================================================
// DETERMINE BAR TYPE (Strat number)
// ================================================================
function getBarType(bar, prev) {
  if (!bar || !prev) return 'UNKNOWN';
  var h = parseFloat(bar.High), l = parseFloat(bar.Low);
  var ph = parseFloat(prev.High), pl = parseFloat(prev.Low);
  if (h > ph && l < pl) return '3';
  if (h <= ph && l >= pl) return '1';
  if (h > ph && l >= pl) return '2U';
  if (l < pl && h <= ph) return '2D';
  return 'UNKNOWN';
}

// ================================================================
// DETERMINE CONTINUITY (bullish/bearish) for a timeframe
// Price above previous candle close = bullish continuity
// ================================================================
function getContinuity(bars) {
  if (!bars || bars.length < 2) return 'UNKNOWN';
  var current = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var close = parseFloat(current.Close);
  var prevClose = parseFloat(prev.Close);
  return close > prevClose ? 'BULL' : 'BEAR';
}

// ================================================================
// ENRICH SIGNAL WITH FULL TVDATA
// This is the main function. Takes a signal from brainEngine,
// fetches all the data caseyConfluence needs, and returns enriched tvData.
// ================================================================
async function enrichSignal(signal) {
  var ticker = signal.ticker;
  var direction = signal.direction; // BULLISH or BEARISH
  var isCalls = direction === 'BULLISH';
  var tvData = { direction: isCalls ? 'CALLS' : 'PUTS' };

  try {
    // -- 1. FOUR-HOUR DATA (WealthPrince method) --
    var bars4h = await getBars(ticker, 'Minute', '240', 30);
    if (bars4h.length >= 21) {
      var ema9 = calcEMA(bars4h.slice(-30), 9);
      var ema21 = calcEMA(bars4h.slice(-30), 21);
      var last4h = bars4h[bars4h.length - 1];
      var price4h = parseFloat(last4h.Close);
      var priceVsEma = 'BETWEEN';
      if (ema9 && ema21) {
        if (price4h > Math.max(ema9, ema21)) priceVsEma = 'ABOVE_BOTH';
        else if (price4h < Math.min(ema9, ema21)) priceVsEma = 'BELOW_BOTH';
      }
      var trend4h = (ema9 && ema21) ? (ema9 > ema21 ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
      var candle4h = detectCandlePattern(last4h);

      tvData.fourHr = {
        ema9: ema9,
        ema21: ema21,
        trend: trend4h,
        candle: candle4h,
        priceVsEma: priceVsEma,
      };
    }

    // -- 2. FTFC (Full Time Frame Continuity) --
    var monthlyBars = await getBars(ticker, 'Monthly', '1', 3);
    var weeklyBars = await getBars(ticker, 'Weekly', '1', 3);
    var dailyBars = await getBars(ticker, 'Daily', '1', 3);
    var bars60m = await getBars(ticker, 'Minute', '60', 5);

    var monthlyCont = getContinuity(monthlyBars);
    var weeklyCont = getContinuity(weeklyBars);
    var dailyCont = getContinuity(dailyBars);
    var sixtyCont = getContinuity(bars60m);

    var tfs = [monthlyCont, weeklyCont, dailyCont, sixtyCont];
    var bullCount = tfs.filter(function(t) { return t === 'BULL'; }).length;
    var bearCount = tfs.filter(function(t) { return t === 'BEAR'; }).length;
    var ftfc = 'MIXED';
    if (bullCount === 4) ftfc = 'BULL';
    else if (bearCount === 4) ftfc = 'BEAR';
    else if (bullCount >= 3) ftfc = 'BULL';
    else if (bearCount >= 3) ftfc = 'BEAR';

    var tfAligned = Math.max(bullCount, bearCount);

    // Detect actionable Strat signal on 60-min
    var stratSignal = null;
    var triggerLevel = null;
    var signalBarHigh = null;
    var signalBarLow = null;
    if (bars60m.length >= 3) {
      var curr60 = bars60m[bars60m.length - 1];
      var prev60 = bars60m[bars60m.length - 2];
      var prev260 = bars60m[bars60m.length - 3];
      var barType60 = getBarType(curr60, prev60);
      var prevBarType60 = getBarType(prev60, prev260);
      var candle60 = detectCandlePattern(curr60);

      // F2U: was 2U, reversed to close bearish
      if (prevBarType60 === '2U' && parseFloat(curr60.Close) < parseFloat(curr60.Open)) {
        stratSignal = 'F2U';
        triggerLevel = parseFloat(curr60.Low);
        signalBarHigh = parseFloat(curr60.High);
        signalBarLow = parseFloat(curr60.Low);
      }
      // F2D: was 2D, reversed to close bullish
      if (prevBarType60 === '2D' && parseFloat(curr60.Close) > parseFloat(curr60.Open)) {
        stratSignal = 'F2D';
        triggerLevel = parseFloat(curr60.High);
        signalBarHigh = parseFloat(curr60.High);
        signalBarLow = parseFloat(curr60.Low);
      }
      // Hammer
      if (candle60 === 'HAMMER') {
        stratSignal = 'HAMMER';
        triggerLevel = parseFloat(curr60.High);
        signalBarHigh = parseFloat(curr60.High);
        signalBarLow = parseFloat(curr60.Low);
      }
      // Shooter
      if (candle60 === 'SHOOTER') {
        stratSignal = 'SHOOTER';
        triggerLevel = parseFloat(curr60.Low);
        signalBarHigh = parseFloat(curr60.High);
        signalBarLow = parseFloat(curr60.Low);
      }
      // Inside bar
      if (barType60 === '1') {
        stratSignal = isCalls ? 'INSIDE_UP' : 'INSIDE_DOWN';
        triggerLevel = isCalls ? parseFloat(curr60.High) : parseFloat(curr60.Low);
        signalBarHigh = parseFloat(curr60.High);
        signalBarLow = parseFloat(curr60.Low);
      }
    }

    tvData.strat = {
      ftfc: ftfc,
      tfAligned: tfAligned,
      signal: stratSignal,
      triggerLevel: triggerLevel,
      signalBarHigh: signalBarHigh,
      signalBarLow: signalBarLow,
      insideBarHigh: signalBarHigh,
      insideBarLow: signalBarLow,
      continuity: { monthly: monthlyCont, weekly: weeklyCont, daily: dailyCont, sixty: sixtyCont },
    };

    // -- 3. CURRENT PRICE + VWAP --
    try {
      var ts = require('./tradestation');
      var token = await ts.getAccessToken();
      if (token) {
        var quoteRes = await fetch('https://api.tradestation.com/v3/marketdata/quotes/' + ticker, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (quoteRes.ok) {
          var quoteData = await quoteRes.json();
          var q = (quoteData.Quotes || [])[0] || {};
          tvData.price = parseFloat(q.Last || q.Close || signal.price || 0);
          tvData.volume = parseFloat(q.Volume || 0);
        }
      }
    } catch(e) {}

    // -- 4. 2-MIN EMA 13/48 (Casey entry timing) --
    var bars2m = await getBars(ticker, 'Minute', '2', 60);
    if (bars2m.length >= 48) {
      tvData.ema13 = calcEMA(bars2m.slice(-60), 13);
      tvData.ema48 = calcEMA(bars2m.slice(-60), 48);
    }

    // -- 5. DYNAMIC BIAS --
    if (dynamicBias) {
      var bias = dynamicBias.getBias();
      if (bias && bias.bias) {
        tvData.dynamicBias = bias;
      }
    }

    // -- 6. FLOW DATA --
    if (bullflow && bullflow.getRecentFlow) {
      var allFlow = bullflow.getRecentFlow();
      if (allFlow && allFlow.length > 0) {
        var now = Date.now();
        var thirtyMinAgo = now - (30 * 60 * 1000);
        var recent = allFlow.filter(function(f) {
          return f.ticker === ticker && new Date(f.timestamp).getTime() >= thirtyMinAgo;
        });
        if (recent.length > 0) {
          var calls = 0, puts = 0, totalVal = 0;
          recent.forEach(function(f) {
            if (f.callPut === 'CALL') calls++;
            else if (f.callPut === 'PUT') puts++;
            totalVal += (f.premium || 0);
          });
          var flowDir = calls > puts ? 'BULLISH' : (puts > calls ? 'BEARISH' : 'MIXED');
          var ratio = puts > 0 ? calls / puts : (calls > 0 ? 10 : 1);
          tvData.flow = {
            checklistScore: Math.min(7, recent.length), // approximate: more alerts = more conviction
            direction: flowDir,
            totalValue: totalVal,
            ratio: ratio,
          };
        }
      }
    }

    // -- 7. ATR (for stop calculation) --
    if (dailyBars && dailyBars.length >= 3) {
      var atrSum = 0;
      for (var i = Math.max(0, dailyBars.length - 14); i < dailyBars.length; i++) {
        atrSum += (parseFloat(dailyBars[i].High) - parseFloat(dailyBars[i].Low));
      }
      tvData.atr = parseFloat((atrSum / Math.min(14, dailyBars.length)).toFixed(4));
    }

    // -- 8. PDH/PDL/PMH/PML --
    if (dailyBars && dailyBars.length >= 2) {
      var prevDay = dailyBars[dailyBars.length - 2];
      tvData.pdh = parseFloat(prevDay.High);
      tvData.pdl = parseFloat(prevDay.Low);
    }

    // PMH/PML from pre-market (use first 30 min of today if available)
    var barsPremarket = await getBars(ticker, 'Minute', '5', 80);
    if (barsPremarket.length > 0) {
      var pmHigh = 0, pmLow = 999999;
      for (var p = 0; p < barsPremarket.length; p++) {
        var bTime = barsPremarket[p].TimeStamp || '';
        if (bTime) {
          var barDate = new Date(bTime);
          var barHourET = ((barDate.getUTCHours() - 4) + 24) % 24;
          if (barHourET >= 4 && barHourET < 9.5) {
            var bh = parseFloat(barsPremarket[p].High);
            var bl = parseFloat(barsPremarket[p].Low);
            if (bh > pmHigh) pmHigh = bh;
            if (bl < pmLow) pmLow = bl;
          }
        }
      }
      if (pmHigh > 0 && pmLow < 999999) {
        tvData.pmh = pmHigh;
        tvData.pml = pmLow;
      }
    }

    // -- 9. VWAP (approximate from intraday bars) --
    if (barsPremarket && barsPremarket.length > 0) {
      var vwapNum = 0, vwapDen = 0;
      for (var v = 0; v < barsPremarket.length; v++) {
        var typPrice = (parseFloat(barsPremarket[v].High) + parseFloat(barsPremarket[v].Low) + parseFloat(barsPremarket[v].Close)) / 3;
        var vol = parseFloat(barsPremarket[v].TotalVolume || barsPremarket[v].Volume || 0);
        vwapNum += typPrice * vol;
        vwapDen += vol;
      }
      if (vwapDen > 0) {
        tvData.vwap = parseFloat((vwapNum / vwapDen).toFixed(4));
      }
    }

    // -- 10. AVG VOLUME --
    if (dailyBars && dailyBars.length >= 3) {
      var volSum = 0;
      for (var dv = 0; dv < dailyBars.length; dv++) {
        volSum += parseFloat(dailyBars[dv].TotalVolume || dailyBars[dv].Volume || 0);
      }
      tvData.avgVolume = volSum / dailyBars.length;
    }

  } catch(e) {
    console.error('[ENRICHER] Error enriching ' + ticker + ':', e.message);
  }

  return tvData;
}

module.exports = { enrichSignal: enrichSignal, calcEMA: calcEMA, detectCandlePattern: detectCandlePattern };
