// =============================================================================
// WealthPrince Reversal Scanner
// Scans ~100 tickers for Failed-2D / Failed-2U + 4HR EMA pullback setups.
// Built Apr 28 2026 after AB missed UNH overnight swing — solving the
// "narrow watchlist" problem. Server-side scan = no manual ticker juggling.
// =============================================================================

var fetch = require('node-fetch');
var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

// Universe — mega-caps + healthcare + finance + volatile names
var UNIVERSE = [
  // Indices/ETFs
  'SPY','QQQ','IWM','DIA','XLE','XLF','XLV','XLK','XLI','XLY','XLP','XLU','XLRE','XLB','XLC',
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','CRM','ADBE','NFLX','AMD','INTC',
  // Healthcare giants
  'UNH','JNJ','LLY','MRK','PFE','ABBV','TMO','ABT','DHR','BMY','AMGN','GILD','MDT','ELV','CI',
  // Finance/banks
  'JPM','V','MA','BAC','WFC','GS','MS','BLK','SCHW','C','AXP','PNC','USB','COF',
  // Consumer
  'PG','HD','COST','PEP','KO','MCD','WMT','TGT','NKE','SBUX','LOW','TJX','DIS',
  // Industrial/energy
  'XOM','CVX','COP','BP','RTX','UPS','HON','CAT','BA','LMT','GE','MMM','UNP',
  // Volatile / high-beta
  'MU','SMCI','PLTR','COIN','RBLX','HOOD','SNAP','UBER','SHOP','SQ','PYPL','LYFT','SOFI',
  'BABA','BIDU','TSM','MRVL','ASML','AMAT','LRCX','KLAC','QCOM','ARM','MSTR',
  'F','GM','NIO','RIVN','LCID','SOUN','BBAI','IONQ','NOK','ASTS','TWLO','CSCO','CRWV','ROKU',
];
var unique = [];
var seen = {};
UNIVERSE.forEach(function(t) { if (!seen[t]) { seen[t] = 1; unique.push(t); } });

// Sector mapping — each ticker → its sector ETF
// Used as a confluence filter (skip Failed-2D longs if sector ETF is bleeding)
// Lesson from AVGO 4/28: hammer + fail-2 on AVGO failed because XLK was -2% while XLV was +1%.
var SECTOR_MAP = {
  // Healthcare (XLV)
  UNH:'XLV', JNJ:'XLV', LLY:'XLV', MRK:'XLV', PFE:'XLV', ABBV:'XLV', TMO:'XLV',
  ABT:'XLV', DHR:'XLV', BMY:'XLV', AMGN:'XLV', GILD:'XLV', MDT:'XLV', ELV:'XLV', CI:'XLV',
  // Tech (XLK)
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AVGO:'XLK', ORCL:'XLK', CRM:'XLK', ADBE:'XLK',
  AMD:'XLK', INTC:'XLK', MU:'XLK', SMCI:'XLK', PLTR:'XLK', AMAT:'XLK', LRCX:'XLK',
  KLAC:'XLK', QCOM:'XLK', ARM:'XLK', MRVL:'XLK', ASML:'XLK', TSM:'XLK', CSCO:'XLK',
  // Communication (XLC)
  GOOGL:'XLC', META:'XLC', NFLX:'XLC', DIS:'XLC', SNAP:'XLC', ROKU:'XLC', PARA:'XLC',
  WBD:'XLC', TWLO:'XLC', BIDU:'XLC',
  // Finance (XLF)
  JPM:'XLF', V:'XLF', MA:'XLF', BAC:'XLF', WFC:'XLF', GS:'XLF', MS:'XLF', BLK:'XLF',
  SCHW:'XLF', C:'XLF', AXP:'XLF', PNC:'XLF', USB:'XLF', COF:'XLF', SOFI:'XLF',
  HOOD:'XLF', COIN:'XLF', SQ:'XLF', PYPL:'XLF',
  // Consumer Discretionary (XLY)
  AMZN:'XLY', HD:'XLY', NKE:'XLY', SBUX:'XLY', LOW:'XLY', TJX:'XLY', TSLA:'XLY',
  F:'XLY', GM:'XLY', NIO:'XLY', RIVN:'XLY', LCID:'XLY', BABA:'XLY', RBLX:'XLY',
  UBER:'XLY', LYFT:'XLY', SHOP:'XLY',
  // Consumer Staples (XLP)
  PG:'XLP', COST:'XLP', PEP:'XLP', KO:'XLP', WMT:'XLP', TGT:'XLP', MCD:'XLP',
  // Energy (XLE)
  XOM:'XLE', CVX:'XLE', COP:'XLE', BP:'XLE',
  // Industrial (XLI)
  RTX:'XLI', UPS:'XLI', HON:'XLI', CAT:'XLI', BA:'XLI', LMT:'XLI', GE:'XLI',
  MMM:'XLI', UNP:'XLI', ASTS:'XLI',
  // Indexes/ETFs - no sector mapping
};

// -----------------------------------------------------------------
async function getToken() {
  if (!ts) return null;
  try { return await ts.getAccessToken(); } catch(e) { return null; }
}

async function fetchBars(ticker, unit, interval, barsback, token) {
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker) +
      '?interval=' + interval + '&unit=' + unit + '&barsback=' + barsback +
      (unit === 'Minute' ? '&sessiontemplate=Default' : '');
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) { return []; }
}

function normBar(b) {
  if (!b) return null;
  return {
    o: parseFloat(b.Open  || b.open  || 0),
    h: parseFloat(b.High  || b.high  || 0),
    l: parseFloat(b.Low   || b.low   || 0),
    c: parseFloat(b.Close || b.close || 0),
    v: parseFloat(b.TotalVolume || b.Volume || b.volume || 0),
  };
}

// -----------------------------------------------------------------
// FAILED 2D — Daily bar broke prior low BUT closed back above
//   Bar B (just completed) low < Bar A low (broke)
//   Bar B close >= Bar A low (reclaimed)
//   Bar B close in upper half of B's range (hammer-like) OR green close
// = setup for Reversal Up on next bar
function detectFailed2D(B, A) {
  if (!B || !A) return null;
  var brokeBelow = B.l < A.l;
  var reclaimed  = B.c >= A.l;
  var range = B.h - B.l;
  var hammerClose = range > 0 && B.c > B.l + range * 0.5;
  var bullClose = B.c > B.o;
  if (brokeBelow && reclaimed && (hammerClose || bullClose)) {
    return {
      pattern: 'Failed 2D',
      lowWick: A.l - B.l,
      reclaimedBy: B.c - A.l,
      closedInUpperHalf: hammerClose,
      greenClose: bullClose,
    };
  }
  return null;
}

// FAILED 2U — symmetric (bear setup)
function detectFailed2U(B, A) {
  if (!B || !A) return null;
  var brokeAbove = B.h > A.h;
  var reclaimed  = B.c <= A.h;
  var range = B.h - B.l;
  var hammerClose = range > 0 && B.c < B.l + range * 0.5;
  var bearClose = B.c < B.o;
  if (brokeAbove && reclaimed && (hammerClose || bearClose)) {
    return {
      pattern: 'Failed 2U',
      highWick: B.h - A.h,
      reclaimedBy: A.h - B.c,
      closedInLowerHalf: hammerClose,
      redClose: bearClose,
    };
  }
  return null;
}

// -----------------------------------------------------------------
// 4HR EMA helpers
function emaArr(values, length) {
  if (!values || values.length < 1) return [];
  var k = 2 / (length + 1);
  var out = [];
  var ema = values[0];
  out.push(ema);
  for (var i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function check4HREMAHold(bars4hr) {
  if (!bars4hr || bars4hr.length < 25) return null;
  var closes = bars4hr.map(function(b) { return b.c; });
  var ema9  = emaArr(closes, 9);
  var ema21 = emaArr(closes, 21);
  var lastClose = closes[closes.length - 1];
  var lastEma9  = ema9[ema9.length - 1];
  var lastEma21 = ema21[ema21.length - 1];
  var bullStack = lastEma9 > lastEma21;
  var distPct = lastEma21 > 0 ? Math.abs(lastClose - lastEma21) / lastEma21 * 100 : 999;
  var near = distPct < 2.0;
  return {
    bullStack: bullStack,
    near21: near,
    distPct: distPct,
    ema9: lastEma9,
    ema21: lastEma21,
    lastClose: lastClose,
  };
}

// -----------------------------------------------------------------
function calc5dMomentum(dailyBars) {
  if (!dailyBars || dailyBars.length < 6) return 0;
  var n = dailyBars.length;
  var fiveBack = dailyBars[n - 6].c;
  var current  = dailyBars[n - 1].c;
  if (!fiveBack) return 0;
  return (current - fiveBack) / fiveBack * 100;
}

function scoreSetup(failed, ema, momentum5d, isLong, sectorMomentum) {
  var score = 0;
  if (failed) {
    score += 5;
    if (isLong && failed.lowWick > 0) score += 1;
    if (!isLong && failed.highWick > 0) score += 1;
    if (failed.closedInUpperHalf || failed.closedInLowerHalf) score += 1;
  }
  if (ema) {
    var emaAligned = isLong ? ema.bullStack : !ema.bullStack;
    if (emaAligned && ema.near21) score += 3;
    else if (emaAligned) score += 1.5;
  }
  // Momentum: long wants positive 3-15%, short wants negative 3-15%
  var m = isLong ? momentum5d : -momentum5d;
  if (m >= 3 && m <= 15) score += 1.5;
  else if (m >= 1 && m < 3) score += 0.5;
  else if (m > 15) score -= 1;
  else if (m < -3) score -= 1;
  // SECTOR FILTER (added after AVGO false-signal Apr 28):
  // If sector ETF is moving WITH our direction = boost. Against us = penalty.
  if (sectorMomentum !== null && sectorMomentum !== undefined) {
    var sm = isLong ? sectorMomentum : -sectorMomentum;
    if (sm > 1) score += 2;       // sector tailwind
    else if (sm > 0) score += 1;
    else if (sm < -1) score -= 2; // sector headwind (AVGO killer)
    else if (sm < 0) score -= 1;
  }
  return Math.round(score * 10) / 10;
}

// -----------------------------------------------------------------
// Pre-scan: pull sector ETF momentum (1d %) so we can boost/penalize each candidate
async function preScanSectors(token) {
  var sectorETFs = ['XLV','XLK','XLC','XLF','XLY','XLP','XLE','XLI','XLU','XLRE','XLB'];
  var sectorMomentum = {};
  for (var i = 0; i < sectorETFs.length; i++) {
    var etf = sectorETFs[i];
    try {
      var raw = await fetchBars(etf, 'Daily', 1, 3, token);
      var bars = raw.map(normBar).filter(Boolean);
      if (bars.length >= 2) {
        var prev = bars[bars.length - 2].c;
        var curr = bars[bars.length - 1].c;
        sectorMomentum[etf] = prev > 0 ? (curr - prev) / prev * 100 : 0;
      }
    } catch(e) { sectorMomentum[etf] = 0; }
  }
  return sectorMomentum;
}

// -----------------------------------------------------------------
// MAIN SCAN — sequential to avoid TS rate limit; ~60s for full universe
async function scan(opts) {
  opts = opts || {};
  var direction = opts.direction || 'both';
  var minScore = opts.minScore || 5;
  var token = await getToken();
  if (!token) return { error: 'no TS token', candidates: [] };

  // Pull sector momentum first (1 round trip per sector ETF)
  var sectorMomentum = await preScanSectors(token);

  var results = [];
  for (var i = 0; i < unique.length; i++) {
    var t = unique[i];
    try {
      var dailyRaw = await fetchBars(t, 'Daily', 1, 7, token);
      var dailyBars = dailyRaw.map(normBar).filter(Boolean);
      if (dailyBars.length < 6) continue;

      var n = dailyBars.length;
      var B = dailyBars[n - 1];
      var A = dailyBars[n - 2];

      var hr4Raw = await fetchBars(t, 'Minute', 240, 30, token);
      var hr4Bars = hr4Raw.map(normBar).filter(Boolean);
      var ema = check4HREMAHold(hr4Bars);
      var momentum5d = calc5dMomentum(dailyBars);
      var sector = SECTOR_MAP[t] || null;
      var sectorMom = sector ? (sectorMomentum[sector] || 0) : null;

      if (direction === 'long' || direction === 'both') {
        var failed2D = detectFailed2D(B, A);
        if (failed2D) {
          var scoreL = scoreSetup(failed2D, ema, momentum5d, true, sectorMom);
          if (scoreL >= minScore) {
            results.push({
              ticker: t, direction: 'CALL', pattern: failed2D.pattern, spot: B.c,
              ema9: ema ? +ema.ema9.toFixed(2) : null,
              ema21: ema ? +ema.ema21.toFixed(2) : null,
              emaStackBull: ema ? ema.bullStack : null,
              emaNear21: ema ? ema.near21 : null,
              emaDistPct: ema ? +ema.distPct.toFixed(2) : null,
              momentum5d: +momentum5d.toFixed(2),
              priorLow: A.l, priorHigh: A.h, todayLow: B.l, todayHigh: B.h, todayClose: B.c,
              sector: sector, sectorMom: sectorMom !== null ? +sectorMom.toFixed(2) : null,
              score: scoreL,
              note: 'Failed-2D — broke ' + A.l.toFixed(2) + ', reclaimed to ' + B.c.toFixed(2),
            });
          }
        }
      }
      if (direction === 'short' || direction === 'both') {
        var failed2U = detectFailed2U(B, A);
        if (failed2U) {
          var scoreS = scoreSetup(failed2U, ema, momentum5d, false, sectorMom);
          if (scoreS >= minScore) {
            results.push({
              ticker: t, direction: 'PUT', pattern: failed2U.pattern, spot: B.c,
              ema9: ema ? +ema.ema9.toFixed(2) : null,
              ema21: ema ? +ema.ema21.toFixed(2) : null,
              emaStackBull: ema ? ema.bullStack : null,
              emaNear21: ema ? ema.near21 : null,
              emaDistPct: ema ? +ema.distPct.toFixed(2) : null,
              momentum5d: +momentum5d.toFixed(2),
              priorLow: A.l, priorHigh: A.h, todayLow: B.l, todayHigh: B.h, todayClose: B.c,
              sector: sector, sectorMom: sectorMom !== null ? +sectorMom.toFixed(2) : null,
              score: scoreS,
              note: 'Failed-2U — broke ' + A.h.toFixed(2) + ', reclaimed to ' + B.c.toFixed(2),
            });
          }
        }
      }
    } catch(e) { /* skip on error */ }
  }

  results.sort(function(a, b) { return b.score - a.score; });
  return {
    timestamp: new Date().toISOString(),
    universeSize: unique.length,
    scanned: unique.length,
    sectorMomentum: sectorMomentum,
    candidatesFound: results.length,
    candidates: results.slice(0, 15),
  };
}

module.exports = { scan: scan, UNIVERSE: unique };
