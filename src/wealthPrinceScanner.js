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

// HAMMER — long lower wick + green close (100% win rate in 30-day data, n=10)
// Stronger than Failed-2D — requires explicit hammer geometry
function detectHammer(B, A) {
  if (!B || !A) return null;
  var range = B.h - B.l;
  var body = Math.abs(B.c - B.o);
  if (range <= 0) return null;
  var brokeBelow = B.l < A.l;
  var greenClose = B.c > B.o;
  var lowerWickRatio = (B.c - B.l) / range; // higher = more hammer
  var bodyToRange = body / range; // smaller body = more hammer
  // Hammer: closed in upper 60%, lower wick > 2x body, green close, broke prior low
  if (brokeBelow && greenClose && lowerWickRatio > 0.6 && body > 0 && (B.c - B.l) > 2 * body) {
    return {
      pattern: 'Hammer',
      lowWick: A.l - B.l,
      bodyToRange: bodyToRange,
      lowerWickRatio: lowerWickRatio,
    };
  }
  return null;
}

// SHOOTER — long upper wick + red close (bear pattern, less reliable per data)
function detectShooter(B, A) {
  if (!B || !A) return null;
  var range = B.h - B.l;
  var body = Math.abs(B.c - B.o);
  if (range <= 0) return null;
  var brokeAbove = B.h > A.h;
  var redClose = B.c < B.o;
  var upperWickRatio = (B.h - B.c) / range;
  if (brokeAbove && redClose && upperWickRatio > 0.6 && body > 0 && (B.h - B.c) > 2 * body) {
    return {
      pattern: 'Shooter',
      highWick: B.h - A.h,
      upperWickRatio: upperWickRatio,
    };
  }
  return null;
}

// 2-1-2 UP — 3-bar continuation (100% win rate in data, n=6)
// Bar Z = directional up (close > open)
// Bar A = inside Z (high <= Z.h, low >= Z.l)
// Bar B = breakout up (high > A.h, closed bullish)
function detect212Up(Z, A, B) {
  if (!Z || !A || !B) return null;
  var zUp = Z.c > Z.o;
  var aInsideZ = A.h <= Z.h && A.l >= Z.l;
  var bBrokeAHigh = B.h > A.h;
  var bGreenClose = B.c > B.o;
  if (zUp && aInsideZ && bBrokeAHigh && bGreenClose) {
    return {
      pattern: '2-1-2 Up',
      zRange: Z.h - Z.l,
      aRange: A.h - A.l,
      breakoutPct: (B.c - A.h) / A.h * 100,
    };
  }
  return null;
}

// 2-1-2 DOWN — 3-bar continuation (100% win rate, n=5)
function detect212Down(Z, A, B) {
  if (!Z || !A || !B) return null;
  var zDown = Z.c < Z.o;
  var aInsideZ = A.h <= Z.h && A.l >= Z.l;
  var bBrokeALow = B.l < A.l;
  var bRedClose = B.c < B.o;
  if (zDown && aInsideZ && bBrokeALow && bRedClose) {
    return {
      pattern: '2-1-2 Down',
      zRange: Z.h - Z.l,
      aRange: A.h - A.l,
      breakdownPct: (A.l - B.c) / A.l * 100,
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

// Pattern bonus from 30-day historical win rate data:
//   Hammer        100% (n=10)  → +3
//   2-1-2 Up      100% (n=6)   → +3
//   2-1-2 Down    100% (n=5)   → +3
//   Failed 2D     89%  (n=24)  → +2
//   Failed 2U     69%  (n=45)  → +1
//   Shooter       60%  (n=10)  → 0 (skip in scoring)
function patternBonus(patternName) {
  if (patternName === 'Hammer') return 3;
  if (patternName === '2-1-2 Up' || patternName === '2-1-2 Down') return 3;
  if (patternName === 'Failed 2D') return 2;
  if (patternName === 'Failed 2U') return 1;
  return 0;
}

// Sector tier from 30-day data (sector ETF mapped → win rate observed):
//   Tech/Fin/Energy/Industrial/Healthcare = preferred (75-100% wr)
//   Consumer Cyclical/Communication = neutral (66-67% wr)
//   Defensive (XLP)/Utilities (XLU) = AVOID (0% wr in 30 days, n=11 combined)
function sectorTier(etf) {
  if (etf === 'XLK' || etf === 'XLF' || etf === 'XLE' || etf === 'XLI' || etf === 'XLV') return 'preferred';
  if (etf === 'XLY' || etf === 'XLC' || etf === 'XLB') return 'neutral';
  if (etf === 'XLP' || etf === 'XLU') return 'avoid';
  return 'unknown';
}

function scoreSetup(failed, ema, momentum5d, isLong, sectorMomentum, sectorETF) {
  var score = 0;
  if (failed) {
    // Base + pattern-specific bonus from historical win rates
    score += 5 + patternBonus(failed.pattern);
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
  // Sector momentum (1d sector ETF direction):
  if (sectorMomentum !== null && sectorMomentum !== undefined) {
    var sm = isLong ? sectorMomentum : -sectorMomentum;
    if (sm > 1) score += 2;
    else if (sm > 0) score += 1;
    else if (sm < -1) score -= 2;
    else if (sm < 0) score -= 1;
  }
  // Sector TIER bonus/penalty (from historical data — defensive/utilities = 0% wr)
  var tier = sectorTier(sectorETF);
  if (tier === 'preferred') score += 1.5;
  else if (tier === 'avoid') score -= 5; // hard penalty — defensive/utilities killed every setup
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
      // Pull 8 daily bars so we have Z, A, B for 2-1-2 detection
      var dailyRaw = await fetchBars(t, 'Daily', 1, 8, token);
      var dailyBars = dailyRaw.map(normBar).filter(Boolean);
      if (dailyBars.length < 6) continue;

      var n = dailyBars.length;
      var B = dailyBars[n - 1];        // most recent completed daily
      var A = dailyBars[n - 2];        // bar before B
      var Z = dailyBars[n - 3];        // bar before A (for 2-1-2)

      var hr4Raw = await fetchBars(t, 'Minute', 240, 30, token);
      var hr4Bars = hr4Raw.map(normBar).filter(Boolean);
      var ema = check4HREMAHold(hr4Bars);
      var momentum5d = calc5dMomentum(dailyBars);
      var sector = SECTOR_MAP[t] || null;
      var sectorMom = sector ? (sectorMomentum[sector] || 0) : null;

      // Helper to push a result if score qualifies
      function tryPush(setup, isLong, dirCode, noteText) {
        var sc = scoreSetup(setup, ema, momentum5d, isLong, sectorMom, sector);
        if (sc >= minScore) {
          results.push({
            ticker: t, direction: dirCode, pattern: setup.pattern, spot: B.c,
            ema9: ema ? +ema.ema9.toFixed(2) : null,
            ema21: ema ? +ema.ema21.toFixed(2) : null,
            emaStackBull: ema ? ema.bullStack : null,
            emaNear21: ema ? ema.near21 : null,
            emaDistPct: ema ? +ema.distPct.toFixed(2) : null,
            momentum5d: +momentum5d.toFixed(2),
            priorLow: A.l, priorHigh: A.h, todayLow: B.l, todayHigh: B.h, todayClose: B.c,
            sector: sector, sectorMom: sectorMom !== null ? +sectorMom.toFixed(2) : null,
            sectorTier: sectorTier(sector),
            score: sc,
            note: noteText,
          });
        }
      }

      if (direction === 'long' || direction === 'both') {
        // Hammer (100% wr) — score first, highest priority
        var hammer = detectHammer(B, A);
        if (hammer) {
          tryPush(hammer, true, 'CALL', 'Hammer — long lower wick, green close, broke ' + A.l.toFixed(2));
          continue; // don't double-count if both hammer + failed2D
        }
        // 2-1-2 Up (100% wr)
        var p212Up = detect212Up(Z, A, B);
        if (p212Up) {
          tryPush(p212Up, true, 'CALL', '2-1-2 Up — directional Z, inside A, broke A high to ' + B.c.toFixed(2));
          continue;
        }
        // Failed-2D (89% wr)
        var failed2D = detectFailed2D(B, A);
        if (failed2D) {
          tryPush(failed2D, true, 'CALL', 'Failed-2D — broke ' + A.l.toFixed(2) + ', reclaimed to ' + B.c.toFixed(2));
        }
      }
      if (direction === 'short' || direction === 'both') {
        // 2-1-2 Down (100% wr)
        var p212Down = detect212Down(Z, A, B);
        if (p212Down) {
          tryPush(p212Down, false, 'PUT', '2-1-2 Down — directional Z, inside A, broke A low to ' + B.c.toFixed(2));
          continue;
        }
        // Failed-2U (69% wr) — kept but lower bonus
        var failed2U = detectFailed2U(B, A);
        if (failed2U) {
          tryPush(failed2U, false, 'PUT', 'Failed-2U — broke ' + A.h.toFixed(2) + ', reclaimed to ' + B.c.toFixed(2));
          continue;
        }
        // Shooter (60% wr) — ONLY include if very high score, since pattern weak
        var shooter = detectShooter(B, A);
        if (shooter) {
          tryPush(shooter, false, 'PUT', 'Shooter — long upper wick, red close, broke ' + A.h.toFixed(2));
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
