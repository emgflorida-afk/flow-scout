// =============================================================================
// V-BOTTOM SCANNER — catches reversal patterns in real-time
//
// AB's pain point May 5 PM: ADBE pulled from $256 → $248 → recovered to $253
// over 75 min. By the time UOA flow alert hit at 14:52, the move was 2/3 done.
// Live-movers tab favors HIGH % movers, so doesn't surface reversal candidates.
//
// PURPOSE: find tickers that had a hard pullback today AND are now climbing
// back, BEFORE the move is exhausted.
//
// PHASE 4.18 (May 5 PM) — TIER SYSTEM
// AB's complaint: AAPL surfaced at score 10.5 with rangePosition 70% — the
// scanner saw "down then up" but the bounce was already 70% done by the time
// the card appeared. Plain score isn't enough — we need bar-sequence context
// to distinguish "just turned" from "ride the bounce."
//
//   🔻 V_TURN     — bottom JUST printed (R-R-R-G or R-R-G-G + engulfing + vol
//                    1.5× + range pos < 30% + recovery ≤ 2%). FIRE candidate.
//                    Score boost +5 (max +27).
//   📈 V_FORMING  — V structure intact, range pos 30-50%, 1-2 green. WATCH.
//   📊 V_RECOVERED — late, range pos ≥ 50%. SKIP (will WHIPSAW).
//   ⛔ NO_V        — no clean V structure detected.
//
// SCORING (base):
//   recovery_pct (0-50% of day range)  → 0-5 points
//   green_bars_last_5                  → 0-5 points (1pt each)
//   pullback_depth_pct                 → 0-3 points (more pullback = more reversal potential)
//   uoa_alerts_last_30min              → 0-5 points (flow confluence)
//   above_vwap                         → 2 points
//   volume_increasing                  → 2 points
//   V_TURN tier bonus                  → +5 points (catches the ACTUAL bottom)
//
// Total: max 27. Discord push at score >= 12. V_TURN push at any score.
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var LOG_FILE = path.join(DATA_ROOT, 'v_bottom_log.json');

// Optional deps
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

// Universe of liquid names to scan (S&P 500 + popular ETFs/tech)
var SCAN_UNIVERSE = (process.env.V_BOTTOM_UNIVERSE ||
  'SPY,QQQ,IWM,DIA,XLE,XLF,XLK,XLV,XLI,XLP,XLY,XLB,XLU,XLRE,' +
  'AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,AMD,INTC,MU,CRM,ORCL,ADBE,NFLX,' +
  'JPM,BAC,GS,MS,WFC,C,V,MA,AXP,' +
  'UNH,JNJ,LLY,ABBV,MRK,PFE,TMO,DHL,' +
  'XOM,CVX,COP,SLB,EOG,OXY,' +
  'WMT,COST,HD,LOW,TGT,NKE,MCD,SBUX,DIS,' +
  'BA,CAT,DE,GE,HON,UNP,UPS,FDX,' +
  'AVGO,QCOM,TXN,MRVL,SMCI,SHOP,SNOW,PLTR,COIN,UBER,RBLX,HOOD,DOCU,' +
  'IBIT,GLD,TLT,VIX,USO,UNG'
).split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch (e) { return []; }
}

// Phase 4.18 — Detect V tier from bar sequence + range position.
// Returns { tier, isVTurn, sequence, reason }
function detectVTier(bars, rangePosition, recoveryPct, pullbackDepth) {
  if (!bars || bars.length < 6) {
    return { tier: 'INSUFFICIENT', isVTurn: false, sequence: '', reason: 'need 6+ bars' };
  }
  // Last 4 bars (oldest first): b4, b3, b2, b1 (b1 = current/most recent)
  var L = bars.length;
  var b4 = bars[L - 4], b3 = bars[L - 3], b2 = bars[L - 2], b1 = bars[L - 1];
  var isRed = function(b) { return b.close < b.open; };
  var isGreen = function(b) { return b.close >= b.open; };

  // Bar sequence string (oldest first)
  var seq = (isRed(b4) ? 'R' : 'G') + (isRed(b3) ? 'R' : 'G') + (isRed(b2) ? 'R' : 'G') + (isRed(b1) ? 'R' : 'G');

  // V_TURN patterns: bottom just printed
  var pattern_RRRG = (seq === 'RRRG');                                  // R-R-R-G — sharpest turn
  var pattern_RRGG = (seq === 'RRGG');                                  // R-R-G-G — turn confirmed
  var isTurnPattern = pattern_RRRG || pattern_RRGG;

  // Engulfing trigger: last green bar's close > prior bar's high
  var engulfing = isGreen(b1) && b1.close > b2.high;

  // Volume confirmation on the turn bar (last green)
  var greenVol = b1.volume;
  var redVolAvg = (b3.volume + (isRed(b2) ? b2.volume : b3.volume)) / 2;
  var volConfirmed = redVolAvg > 0 && greenVol > redVolAvg * 1.5;

  // Real V (not noise): pullback ≥ 3% from day high
  var realV = pullbackDepth >= 3.0;

  // Early entry zone: range pos < 30% AND recovery ≤ 2%
  var earlyEntry = rangePosition < 30 && recoveryPct <= 2.0;

  if (isTurnPattern && engulfing && volConfirmed && realV && earlyEntry) {
    return {
      tier: 'V_TURN',
      isVTurn: true,
      sequence: seq,
      reason: seq + ' + engulfing + vol ' + (greenVol/redVolAvg).toFixed(1) + 'x + range ' + rangePosition.toFixed(0) + '% < 30',
    };
  }

  // V_FORMING: V structure intact, recovery early, range 30-50%
  var formingTurn = (isGreen(b1) || isGreen(b2));
  if (realV && rangePosition >= 30 && rangePosition < 50 && formingTurn) {
    return {
      tier: 'V_FORMING',
      isVTurn: false,
      sequence: seq,
      reason: 'V intact, range ' + rangePosition.toFixed(0) + '% (30-50) — watch only',
    };
  }

  // V_RECOVERED: late, bounce 50%+ done
  if (realV && rangePosition >= 50) {
    return {
      tier: 'V_RECOVERED',
      isVTurn: false,
      sequence: seq,
      reason: 'late entry — range ' + rangePosition.toFixed(0) + '% (most of bounce done)',
    };
  }

  return {
    tier: 'NO_V',
    isVTurn: false,
    sequence: seq,
    reason: 'no clean V structure (pullback ' + pullbackDepth.toFixed(1) + '%, range ' + rangePosition.toFixed(0) + '%)',
  };
}

function saveLog(records) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(records.slice(-200), null, 2)); }
  catch (e) {}
}

// Pull bars + compute V-bottom score for a ticker
async function scanTicker(symbol, token) {
  var fetchLib = require('node-fetch');

  // Pull last 24 5m bars (~2 hours of action)
  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(symbol)
    + '?interval=5&unit=Minute&barsback=24';
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    if (!r.ok) return null;
    var data = await r.json();
    var bars = (data.Bars || []).map(function(b) {
      return {
        time: b.TimeStamp,
        open: parseFloat(b.Open),
        high: parseFloat(b.High),
        low: parseFloat(b.Low),
        close: parseFloat(b.Close),
        volume: parseInt(b.TotalVolume || 0, 10),
      };
    });
    if (bars.length < 8) return null;

    var current = bars[bars.length - 1];
    var dayLow = Math.min.apply(Math, bars.map(function(b){ return b.low; }));
    var dayHigh = Math.max.apply(Math, bars.map(function(b){ return b.high; }));
    var dayRange = dayHigh - dayLow;
    if (dayRange <= 0) return null;

    var spot = current.close;
    var rangePosition = (spot - dayLow) / dayRange;  // 0..1
    var recoveryPct = ((spot - dayLow) / dayLow) * 100;
    var pullbackDepth = ((dayHigh - dayLow) / dayHigh) * 100;

    // Last 5 bars: count green
    var last5 = bars.slice(-5);
    var greenLast5 = last5.filter(function(b){ return b.close >= b.open; }).length;

    // Volume trend: avg of last 3 vs avg of bars 4-6
    var last3VolAvg = bars.slice(-3).reduce(function(s,b){ return s + b.volume; }, 0) / 3;
    var prev3VolAvg = bars.slice(-6, -3).reduce(function(s,b){ return s + b.volume; }, 0) / 3;
    var volIncreasing = prev3VolAvg > 0 && last3VolAvg > prev3VolAvg;

    // VWAP-equivalent (typical price weighted by volume)
    var totalPV = bars.reduce(function(s,b){ return s + ((b.high+b.low+b.close)/3) * b.volume; }, 0);
    var totalV = bars.reduce(function(s,b){ return s + b.volume; }, 0);
    var vwap = totalV > 0 ? totalPV / totalV : spot;
    var aboveVwap = spot > vwap;

    // Score the V-bottom signal
    var score = 0;
    score += Math.min(5, Math.round(rangePosition * 10) / 2);   // up to 5 for >50% recovery
    score += greenLast5;                                          // up to 5 for all 5 green
    score += Math.min(3, Math.round(pullbackDepth));              // up to 3 for deep pullback
    if (aboveVwap) score += 2;
    if (volIncreasing) score += 2;

    // Phase 4.18 — V tier detection (catches the actual bottom vs late bounce)
    var vTier = detectVTier(bars, rangePosition * 100, recoveryPct, pullbackDepth);
    // V_TURN bonus: +5 for catching the actual bottom (R-R-R-G + engulf + vol)
    if (vTier.isVTurn) score += 5;

    return {
      ticker: symbol,
      score: +score.toFixed(1),
      spot: +spot.toFixed(2),
      dayLow: +dayLow.toFixed(2),
      dayHigh: +dayHigh.toFixed(2),
      pullbackDepth: +pullbackDepth.toFixed(2),
      recoveryPct: +recoveryPct.toFixed(2),
      rangePosition: +(rangePosition*100).toFixed(1),
      greenLast5: greenLast5,
      vwap: +vwap.toFixed(2),
      aboveVwap: aboveVwap,
      volIncreasing: volIncreasing,
      lastBarClose: current.close,
      // Phase 4.18 — tier classification
      tier: vTier.tier,                    // V_TURN | V_FORMING | V_RECOVERED | NO_V | INSUFFICIENT
      isVTurn: vTier.isVTurn,              // true only for V_TURN — fire-eligible
      barSequence: vTier.sequence,         // e.g. "RRRG"
      tierReason: vTier.reason,
      // Quality flag — V-bottom signal strength
      isStrong: score >= 12,
      isVeryStrong: score >= 15,
    };
  } catch (e) {
    return null;
  }
}

// Cross-reference UOA flow log for a ticker — bonus points for recent flow
function getRecentUoaBonus(ticker) {
  try {
    var uoaLogFile = path.join(DATA_ROOT, 'uoa_log.json');
    if (!fs.existsSync(uoaLogFile)) return 0;
    var log = JSON.parse(fs.readFileSync(uoaLogFile, 'utf8'));
    var cutoff = Date.now() - (30 * 60 * 1000);  // last 30 min
    var hits = log.filter(function(a) {
      return a.ticker === ticker
        && a.direction === 'long'
        && new Date(a.timestamp).getTime() >= cutoff;
    });
    if (hits.length === 0) return 0;
    // Bonus: 1 pt per alert, capped at 5
    return Math.min(5, hits.length);
  } catch (e) {
    return 0;
  }
}

// Run V-bottom scan across the universe
async function runScan(opts) {
  opts = opts || {};
  var minScore = opts.minScore || 0;
  if (!ts || !ts.getAccessToken) return { ok: false, error: 'TS not loaded' };
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { return { ok: false, error: 'no TS token' }; }
  if (!token) return { ok: false, error: 'no TS token' };

  var results = [];

  // Concurrency-limited fan-out (8 at a time)
  var CONCURRENCY = 8;
  var universe = opts.universe || SCAN_UNIVERSE;
  for (var i = 0; i < universe.length; i += CONCURRENCY) {
    var slice = universe.slice(i, i + CONCURRENCY);
    var batch = await Promise.all(slice.map(function(sym){ return scanTicker(sym, token); }));
    batch.forEach(function(r){
      if (r) {
        var bonus = getRecentUoaBonus(r.ticker);
        r.uoaBonus = bonus;
        r.totalScore = +(r.score + bonus).toFixed(1);
        if (r.totalScore >= minScore) results.push(r);
      }
    });
  }

  // Sort by total score
  results.sort(function(a, b){ return b.totalScore - a.totalScore; });

  // Persist top results to log
  var log = loadLog();
  var snapshot = {
    timestamp: new Date().toISOString(),
    topCandidates: results.slice(0, 10),
    universeSize: universe.length,
    qualifyingCount: results.length,
  };
  log.push(snapshot);
  saveLog(log);

  return {
    ok: true,
    timestamp: snapshot.timestamp,
    universeSize: universe.length,
    qualifyingCount: results.length,
    candidates: results,
  };
}

module.exports = {
  runScan: runScan,
  scanTicker: scanTicker,
  SCAN_UNIVERSE: SCAN_UNIVERSE,
};
