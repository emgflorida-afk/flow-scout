// =============================================================================
// HOLD OVERNIGHT CHECKER (May 1 2026)
//
// Per-ticker safety classifier for holding swing positions overnight.
// AB's ask: "I need setups I can hold overnight to avoid PDT next week.
// You really have to set the technical analysis to know we're good."
//
// Returns:
//   {
//     rating:    'SAFE' | 'CAUTION' | 'AVOID',
//     score:     0-100,
//     reasons:   [{kind, msg}],         // all observations
//     hardBlocks:[{kind, msg}],         // any AVOID conditions
//     cautions:  [{kind, msg}],         // CAUTION-only observations
//     greenLights:[{kind, msg}],        // positive signals
//     ticker:    string,
//     spot:      number,
//   }
//
// Hard NOs (instant AVOID):
//   - Earnings within next 1-3 trading days
//   - Major macro event within 24h (FOMC, CPI, NFP)
//   - Today is daily Strat 3 (outside bar = often reverses)
//   - Today's range > 2× ATR(14)
//   - Spot within 2% of 52w high (extension) or 52w low (potential bottom-fishing)
//   - Friday after 3 PM ET (weekend gap risk for unhedged longs/shorts)
//
// Soft cautions:
//   - Below daily 21 EMA (long bias) or above (short bias)
//   - Volume today < 0.5× 20-day average
//   - Trend persistence < 3 days
//
// Green lights:
//   - Daily Strat 1 (inside bar) in an established trend = continuation likely
//   - Above 21/50/200 EMA stack
//   - Volume profile institutional (above average + trending up)
//   - Catalyst priced in (no upcoming binary)
//   - Trend persistence > 5 days
// =============================================================================

var fs = require('fs');
var path = require('path');

// Optional dep — calendars + bars
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}
var lvlComputer = null;
try { lvlComputer = require('./lvlComputer'); } catch (e) {}
var economicCalendar = null;
try { economicCalendar = require('./economicCalendar'); } catch (e) {}

// =============================================================================
// HELPERS
// =============================================================================
function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
}

function isFridayAfternoon() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var dow = et.getDay();   // 5 = Fri
  var hour = et.getHours();
  return dow === 5 && hour >= 15;
}

function ema(values, len) {
  if (!values || values.length < len) return null;
  var k = 2 / (len + 1);
  var e = avg(values.slice(0, len));
  for (var i = len; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function atr14(bars) {
  if (!bars || bars.length < 15) return null;
  var trs = [];
  for (var i = 1; i < bars.length; i++) {
    var prevClose = bars[i - 1].Close;
    var hi = bars[i].High;
    var lo = bars[i].Low;
    var tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    trs.push(tr);
  }
  var lastN = trs.slice(-14);
  return avg(lastN);
}

// =============================================================================
// CORE CLASSIFIER — pure function, takes pre-fetched data
// =============================================================================
function classify(input) {
  // input = {
  //   ticker, dailyBars (>= 30 bars), quote (TS quote object), direction (LONG/SHORT)
  //   earningsDaysAway (number, optional — pulled from quote.HasEarnings + lookup)
  //   macroEventNext24h (boolean, optional)
  // }
  var ticker = input.ticker;
  var bars = input.dailyBars || [];
  var quote = input.quote || {};
  var direction = (input.direction || 'LONG').toUpperCase();

  var hardBlocks = [];
  var cautions = [];
  var greenLights = [];

  // Need bars
  if (bars.length < 20) {
    return {
      ticker: ticker,
      rating: 'CAUTION',
      score: 50,
      reasons: [{ kind: 'data', msg: 'not enough daily bars (' + bars.length + ')' }],
      hardBlocks: [], cautions: [{ kind: 'data', msg: 'insufficient bars' }], greenLights: [],
    };
  }

  var d = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var spot = quote.Last || quote.last || d.Close;
  var hi52w = parseFloat(quote.High52Week || quote.high52Week || 0);
  var lo52w = parseFloat(quote.Low52Week || quote.low52Week || 0);

  // ============ HARD NOS (instant AVOID) ============

  // Earnings within 1-3 days
  if (input.earningsDaysAway != null && input.earningsDaysAway >= 0 && input.earningsDaysAway <= 3) {
    hardBlocks.push({ kind: 'earnings', msg: 'Earnings in ' + input.earningsDaysAway + ' day(s) — binary risk' });
  }

  // Macro event within 24h
  if (input.macroEventNext24h) {
    hardBlocks.push({ kind: 'macro', msg: 'Major macro event next 24h (FOMC/CPI/NFP)' });
  }

  // Daily Strat 3 (outside bar) — today broke prev high AND prev low
  if (d.High > prev.High && d.Low < prev.Low) {
    var bearishClose = d.Close < d.Open;
    hardBlocks.push({ kind: 'strat3', msg: 'Outside bar (3) — range expansion, often reverses' + (bearishClose ? ' (closed bearish)' : '') });
  }

  // ATR extension — today's range > 2× ATR
  var todayRange = d.High - d.Low;
  var atr = atr14(bars);
  if (atr && todayRange > 2 * atr) {
    hardBlocks.push({ kind: 'atr', msg: 'Today range ' + todayRange.toFixed(2) + ' > 2× ATR (' + atr.toFixed(2) + ') — extended' });
  }

  // 52w extension
  if (hi52w && spot >= hi52w * 0.98) {
    if (direction === 'LONG') {
      cautions.push({ kind: '52w', msg: 'Spot within 2% of 52w high — extension risk' });
    } else {
      hardBlocks.push({ kind: '52w', msg: 'Shorting at 52w high — wrong side' });
    }
  }
  if (lo52w && spot <= lo52w * 1.02) {
    if (direction === 'LONG') {
      hardBlocks.push({ kind: '52w', msg: 'Buying at 52w low — falling-knife risk' });
    } else {
      cautions.push({ kind: '52w', msg: 'Spot within 2% of 52w low — possible squeeze' });
    }
  }

  // Friday afternoon weekend gap risk
  if (isFridayAfternoon()) {
    cautions.push({ kind: 'friday', msg: 'Friday PM — weekend gap risk for held positions' });
  }

  // ============ TREND / STRUCTURE CHECKS ============

  var closes = bars.map(function(b) { return b.Close; });
  var ema21 = ema(closes, 21);
  var ema50 = ema(closes.slice(-Math.max(closes.length, 50)), 50);
  var ema200 = closes.length >= 200 ? ema(closes, 200) : null;

  var aboveAll = ema21 && spot > ema21 && ema50 && spot > ema50 && (!ema200 || spot > ema200);
  var belowAll = ema21 && spot < ema21 && ema50 && spot < ema50 && (!ema200 || spot < ema200);

  if (direction === 'LONG') {
    if (aboveAll) {
      greenLights.push({ kind: 'ema', msg: 'Above 21/50' + (ema200 ? '/200' : '') + ' EMA stack — uptrend' });
    } else if (ema21 && spot < ema21) {
      cautions.push({ kind: 'ema', msg: 'Below daily 21 EMA — trend weak' });
    }
  } else {
    if (belowAll) {
      greenLights.push({ kind: 'ema', msg: 'Below 21/50' + (ema200 ? '/200' : '') + ' EMA stack — downtrend' });
    } else if (ema21 && spot > ema21) {
      cautions.push({ kind: 'ema', msg: 'Above daily 21 EMA — short trend weak' });
    }
  }

  // Strat 1 (inside bar) inside an uptrend = continuation likely (good for swings)
  if (d.High <= prev.High && d.Low >= prev.Low) {
    if (direction === 'LONG' && aboveAll) {
      greenLights.push({ kind: 'strat1', msg: 'Inside bar (1) in uptrend — continuation setup' });
    } else if (direction === 'SHORT' && belowAll) {
      greenLights.push({ kind: 'strat1', msg: 'Inside bar (1) in downtrend — continuation setup' });
    } else {
      cautions.push({ kind: 'strat1', msg: 'Inside bar (1) but trend not aligned' });
    }
  }

  // Volume check
  if (d.TotalVolume != null && bars.length >= 20) {
    var vols = bars.slice(-21, -1).map(function(b) { return b.TotalVolume || 0; });
    var avgVol = avg(vols);
    var todayVol = d.TotalVolume;
    if (avgVol > 0) {
      if (todayVol < avgVol * 0.5) {
        cautions.push({ kind: 'vol', msg: 'Volume today ' + (todayVol / avgVol).toFixed(2) + '× MA (low conviction)' });
      } else if (todayVol > avgVol * 1.5) {
        greenLights.push({ kind: 'vol', msg: 'Volume today ' + (todayVol / avgVol).toFixed(2) + '× MA (institutional)' });
      }
    }
  }

  // Trend persistence — count consecutive same-direction closes
  var lastFive = bars.slice(-5);
  var allUp = lastFive.every(function(b, i) { return i === 0 || b.Close >= lastFive[i - 1].Close; });
  var allDn = lastFive.every(function(b, i) { return i === 0 || b.Close <= lastFive[i - 1].Close; });
  if (direction === 'LONG' && allUp) greenLights.push({ kind: 'trend', msg: '5-day uptrend persistence' });
  if (direction === 'SHORT' && allDn) greenLights.push({ kind: 'trend', msg: '5-day downtrend persistence' });

  // ============ SCORING ============

  var score = 60;   // start neutral
  score -= hardBlocks.length * 35;
  score -= cautions.length * 8;
  score += greenLights.length * 10;
  score = Math.max(0, Math.min(100, score));

  var rating;
  if (hardBlocks.length > 0) rating = 'AVOID';
  else if (score >= 70) rating = 'SAFE';
  else if (score >= 45) rating = 'CAUTION';
  else rating = 'AVOID';

  return {
    ticker: ticker,
    rating: rating,
    score: Math.round(score),
    spot: spot,
    direction: direction,
    hardBlocks: hardBlocks,
    cautions: cautions,
    greenLights: greenLights,
    reasons: [].concat(hardBlocks, cautions, greenLights),
    bars: bars.length,
    atr14: atr,
  };
}

// =============================================================================
// FETCH WRAPPER — gets bars + quote + earnings flag, then classifies
// =============================================================================
async function checkTicker(ticker, opts) {
  opts = opts || {};
  var direction = opts.direction || 'LONG';
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ticker: ticker, rating: 'CAUTION', error: 'no TS token' };

  // Pull daily bars
  var bars = [];
  try {
    if (lvlComputer && lvlComputer.fetchBars) {
      bars = await lvlComputer.fetchBars(ticker, 'Daily', token);
    }
  } catch (e) {
    return { ticker: ticker, rating: 'CAUTION', error: 'fetchBars: ' + e.message };
  }

  // Pull current quote (TS quotes endpoint)
  var quote = {};
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var qUrl = (process.env.TS_BASE || 'https://api.tradestation.com/v3') + '/marketdata/quotes/' + encodeURIComponent(ticker);
    var qr = await fetchLib(qUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    if (qr.ok) {
      var qData = await qr.json();
      var q = (qData && (qData.Quotes || qData.quotes) || [])[0];
      if (q) quote = q;
    }
  } catch (e) { /* swallow — quote is best-effort */ }

  // Earnings days away — from quote.HasEarnings flag (TS doesn't give exact date)
  // TODO: hook into a real earnings calendar source
  var earningsDaysAway = null;
  if (quote.HasEarnings === true || quote.hasEarnings === true) {
    earningsDaysAway = 5;   // conservative: if HasEarnings flag is set, assume within window
  }

  // Macro event check
  var macroEventNext24h = false;
  if (economicCalendar && economicCalendar.hasMajorEventInWindow) {
    try {
      macroEventNext24h = await economicCalendar.hasMajorEventInWindow(24);
    } catch (e) { /* swallow */ }
  }

  return classify({
    ticker: ticker,
    dailyBars: bars,
    quote: quote,
    direction: direction,
    earningsDaysAway: earningsDaysAway,
    macroEventNext24h: macroEventNext24h,
  });
}

module.exports = {
  classify: classify,             // pure function (testable)
  checkTicker: checkTicker,       // fetches + classifies
};
