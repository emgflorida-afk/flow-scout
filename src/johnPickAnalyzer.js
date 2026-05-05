// =============================================================================
// JOHN PICK ANALYZER (Phase 4.30A — May 5 2026 PM)
// =============================================================================
// AB ending John VIP subscription. We need to keep his edge by reverse-
// engineering his historical picks: WHAT THE CHART WAS DOING when he posted,
// and DID THE TRADE WORK after.
//
// For each historical pick (152 in option-trade-ideas + 97 in vip-flow):
//   1. Pull historical price data (5m / 60m / Daily) from TS API
//   2. Reverse-engineer the chart state at post time (trend, range position,
//      structural label, key-level proximity, tape state)
//   3. Compute outcome forward from post date (TP1/2/3 hits, stops, MFE/MAE)
//   4. Tag with structural label (BREAKOUT_LONG, PULLBACK_RETEST_LONG, etc.)
//   5. Save to /data/john_history/enriched_picks.json
//
// IDEMPOTENT — re-running skips picks already enriched (keyed on msg_id).
// BATCH SIZE 8 — TS API rate-limit safe. ~30s between batches.
// BEST-EFFORT — if TS data missing for old picks (>30 days), fall back to
// daily-only analysis. Never throws on a single pick failure.
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// =============================================================================
// PATHS
// =============================================================================
var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HISTORY_DIR = path.join(DATA_ROOT, 'john_history');
var ENRICHED_PATH = path.join(HISTORY_DIR, 'enriched_picks.json');

// Find local history dir if Railway /data doesn't have it (dev mode)
var LOCAL_HISTORY_DIR = path.join(__dirname, '..', 'data', 'john_history');
function getHistoryDir() {
  if (fs.existsSync(HISTORY_DIR)) return HISTORY_DIR;
  if (fs.existsSync(LOCAL_HISTORY_DIR)) return LOCAL_HISTORY_DIR;
  return null;
}

// =============================================================================
// LOAD ENRICHED — idempotent index
// =============================================================================
function loadEnriched() {
  try {
    if (!fs.existsSync(ENRICHED_PATH)) return [];
    return JSON.parse(fs.readFileSync(ENRICHED_PATH, 'utf8')) || [];
  } catch (e) { return []; }
}

function saveEnriched(arr) {
  try {
    fs.mkdirSync(path.dirname(ENRICHED_PATH), { recursive: true });
    fs.writeFileSync(ENRICHED_PATH, JSON.stringify(arr, null, 2));
    return true;
  } catch (e) {
    console.error('[JPA] save failed:', e.message);
    return false;
  }
}

// =============================================================================
// LOAD HISTORICAL PICKS
// =============================================================================
function loadAllPicks() {
  var dir = getHistoryDir();
  if (!dir) return [];
  var combined = [];
  var sources = [
    'option-trade-ideas.parsed.json',
    'vip-flow-options-alerts.parsed.json',
  ];
  sources.forEach(function(fname) {
    var p = path.join(dir, fname);
    if (!fs.existsSync(p)) return;
    try {
      var arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) {
        arr.forEach(function(entry) {
          if (entry && entry.msg_id && entry.posted_at && entry.trade) {
            combined.push(Object.assign({ _source: fname }, entry));
          }
        });
      }
    } catch (e) {
      console.error('[JPA] parse fail', fname, e.message);
    }
  });
  return combined;
}

// =============================================================================
// TS BARS FETCH — historical (lastdate-anchored)
// =============================================================================
async function fetchBars(ticker, params) {
  if (!ts || !ts.getAccessToken) return null;
  var token = await ts.getAccessToken();
  if (!token) return null;
  var unit = params.unit || 'Daily';
  var interval = params.interval || 1;
  var barsback = params.barsback || 30;
  var lastdate = params.lastdate || null;
  var sessiontemplate = params.sessiontemplate || null;

  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
    + '?unit=' + unit
    + '&interval=' + interval
    + '&barsback=' + barsback;
  if (lastdate) url += '&lastdate=' + encodeURIComponent(lastdate);
  if (sessiontemplate) url += '&sessiontemplate=' + sessiontemplate;

  try {
    var r = await fetchLib(url, {
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 12000,
    });
    if (!r.ok) return null;
    var data = await r.json();
    var bars = (data.Bars || data.bars || []).map(function(b) {
      return {
        TimeStamp: b.TimeStamp,
        Open: parseFloat(b.Open),
        High: parseFloat(b.High),
        Low: parseFloat(b.Low),
        Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || b.Volume || 0),
      };
    });
    return bars;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// REVERSE ENGINEERING
// =============================================================================
function ema(values, period) {
  if (!values || values.length < period) return null;
  var k = 2 / (period + 1);
  var emaArr = [values[0]];
  for (var i = 1; i < values.length; i++) {
    emaArr.push(values[i] * k + emaArr[i - 1] * (1 - k));
  }
  return emaArr;
}

function classifyTrend(bars) {
  if (!bars || bars.length < 22) return 'UNKNOWN';
  var closes = bars.map(function(b) { return b.Close; });
  var ema9 = ema(closes, 9);
  var ema21 = ema(closes, 21);
  if (!ema9 || !ema21) return 'UNKNOWN';
  var last9 = ema9[ema9.length - 1];
  var last21 = ema21[ema21.length - 1];
  var lastClose = closes[closes.length - 1];
  // Up: close > 9 > 21
  if (lastClose > last9 && last9 > last21) return 'UP';
  // Down: close < 9 < 21
  if (lastClose < last9 && last9 < last21) return 'DOWN';
  return 'RANGE';
}

function rangeSummary(bars, lookback) {
  lookback = lookback || 20;
  if (!bars || bars.length < 2) return null;
  var slice = bars.slice(-lookback);
  var hi = -Infinity, lo = Infinity;
  for (var i = 0; i < slice.length; i++) {
    if (slice[i].High > hi) hi = slice[i].High;
    if (slice[i].Low < lo) lo = slice[i].Low;
  }
  var lastClose = slice[slice.length - 1].Close;
  var pos = (hi - lo > 0) ? (lastClose - lo) / (hi - lo) : 0.5;
  return { high: hi, low: lo, position: Math.round(pos * 100) / 100, lastClose: lastClose };
}

function volumeContext(bars) {
  if (!bars || bars.length < 10) return null;
  var slice = bars.slice(-20);
  var sum = 0;
  for (var i = 0; i < slice.length - 1; i++) sum += slice[i].Volume;
  var avg = sum / (slice.length - 1);
  var recent = slice[slice.length - 1].Volume;
  return {
    avgVol: Math.round(avg),
    recentVol: Math.round(recent),
    ratio: avg > 0 ? Math.round((recent / avg) * 100) / 100 : null,
  };
}

// Detect if last bar is at HOD / LOD relative to recent range
function atKeyLevel(bars, direction) {
  if (!bars || bars.length < 5) return null;
  var rs = rangeSummary(bars, 20);
  if (!rs) return null;
  // Long pick: at resistance = top of range = position close to 1
  // Short pick: at support = bottom of range = position close to 0
  if (direction === 'long') {
    if (rs.position >= 0.85) {
      return { type: 'resistance', level: rs.high, distance: Math.round((rs.high - rs.lastClose) / rs.lastClose * 1000) / 10 };
    }
    if (rs.position <= 0.30) {
      return { type: 'support', level: rs.low, distance: Math.round((rs.lastClose - rs.low) / rs.lastClose * 1000) / 10 };
    }
  } else if (direction === 'short') {
    if (rs.position <= 0.15) {
      return { type: 'support', level: rs.low, distance: Math.round((rs.lastClose - rs.low) / rs.lastClose * 1000) / 10 };
    }
    if (rs.position >= 0.70) {
      return { type: 'resistance', level: rs.high, distance: Math.round((rs.high - rs.lastClose) / rs.lastClose * 1000) / 10 };
    }
  }
  return null;
}

// Recent bar pattern detection (last 3 bars)
function recentPattern(bars) {
  if (!bars || bars.length < 3) return 'UNKNOWN';
  var n = bars.length;
  var b1 = bars[n - 3], b2 = bars[n - 2], b3 = bars[n - 1];
  // Hammer: long lower wick, close near high
  var b3Range = b3.High - b3.Low;
  if (b3Range > 0) {
    var b3Body = Math.abs(b3.Close - b3.Open);
    var b3LowerWick = Math.min(b3.Open, b3.Close) - b3.Low;
    if (b3LowerWick > b3Body * 2 && b3.Close > b3.Open) return 'HAMMER';
    var b3UpperWick = b3.High - Math.max(b3.Open, b3.Close);
    if (b3UpperWick > b3Body * 2 && b3.Close < b3.Open) return 'SHOOTER';
  }
  // Failed-2D: broke prior low then closed back above
  if (b3.Low < b2.Low && b3.Close > b2.Low && b3.Close > b3.Open) return 'FAILED_2D';
  // Failed-2U: broke prior high then closed back below
  if (b3.High > b2.High && b3.Close < b2.High && b3.Close < b3.Open) return 'FAILED_2U';
  // Pullback (down bar in uptrend) — caller decides if uptrend
  if (b3.Close < b3.Open && b2.Close > b2.Open && b1.Close > b1.Open) return 'PULLBACK';
  // Continuation up (3 green) / down (3 red)
  if (b3.Close > b3.Open && b2.Close > b2.Open && b1.Close > b1.Open) return 'TREND_UP_3';
  if (b3.Close < b3.Open && b2.Close < b2.Open && b1.Close < b1.Open) return 'TREND_DOWN_3';
  return 'MIXED';
}

// Master structural label combining trend + range position + recent pattern
function classifyStructural(direction, dailyTrend, hourlyTrend, rangeSum, atKey, recentPat) {
  var dir = (direction || '').toLowerCase();
  if (dir === 'long' || dir === 'call') {
    // Pullback retest: trend UP + recent pullback or hammer
    if (dailyTrend === 'UP' && (recentPat === 'PULLBACK' || recentPat === 'HAMMER')) {
      return 'PULLBACK_RETEST_LONG';
    }
    // Breakout: at resistance (top of range)
    if (atKey && atKey.type === 'resistance' && (rangeSum && rangeSum.position >= 0.85)) {
      return 'BREAKOUT_LONG';
    }
    // V-bottom / Reversal: trend DOWN but bouncing (FAILED_2D, HAMMER at support)
    if ((dailyTrend === 'DOWN' || dailyTrend === 'RANGE') && (recentPat === 'FAILED_2D' || (atKey && atKey.type === 'support'))) {
      return 'REVERSAL_LONG';
    }
    // Continuation: trend UP + steady
    if (dailyTrend === 'UP') {
      return 'CONTINUATION_LONG';
    }
    return 'COUNTER_TREND_LONG';
  }
  if (dir === 'short' || dir === 'put') {
    // Failed 2U short
    if (recentPat === 'FAILED_2U' || recentPat === 'SHOOTER') {
      return 'FAILED_2U_SHORT';
    }
    // Breakdown: at support
    if (atKey && atKey.type === 'support' && (rangeSum && rangeSum.position <= 0.15)) {
      return 'BREAKDOWN_SHORT';
    }
    // Reversal: at resistance with trend up = ATH-short setup
    if (atKey && atKey.type === 'resistance' && dailyTrend === 'UP') {
      return 'REVERSAL_SHORT';
    }
    if (dailyTrend === 'DOWN') {
      return 'CONTINUATION_SHORT';
    }
    return 'COUNTER_TREND_SHORT';
  }
  return 'UNKNOWN';
}

// =============================================================================
// REVERSE ENGINEER — pull bars + classify
// =============================================================================
async function reverseEngineer(pick) {
  var ticker = pick.trade.ticker;
  var direction = (pick.trade.direction || '').toLowerCase();
  var postedAt = pick.posted_at;
  var lastdate = postedAt; // bars ENDING at post time

  var [daily, hourly] = await Promise.all([
    fetchBars(ticker, { unit: 'Daily', interval: 1, barsback: 30, lastdate: lastdate }),
    fetchBars(ticker, { unit: 'Minute', interval: 60, barsback: 40, lastdate: lastdate, sessiontemplate: 'USEQPreAndPost' }),
  ]);

  var dailyTrend = classifyTrend(daily);
  var hourlyTrend = classifyTrend(hourly);
  var rangeSum = rangeSummary(daily, 20);
  var volCtx = volumeContext(daily);
  var atKey = atKeyLevel(daily, direction === 'call' ? 'long' : direction === 'put' ? 'short' : direction);
  var recentPat = recentPattern(daily);

  var structural = classifyStructural(direction, dailyTrend, hourlyTrend, rangeSum, atKey, recentPat);

  return {
    trendDaily: dailyTrend,
    trend60m: hourlyTrend,
    structuralLabel: structural,
    recentPattern: recentPat,
    recentRange: rangeSum,
    volumeContext: volCtx,
    atKeyLevel: atKey,
    dataAvailable: !!(daily && daily.length > 0),
    barsAnalyzed: { daily: (daily || []).length, hourly: (hourly || []).length },
  };
}

// =============================================================================
// COMPUTE OUTCOME — forward from post date
// =============================================================================
async function computeOutcome(pick) {
  var ticker = pick.trade.ticker;
  var direction = (pick.trade.direction || '').toLowerCase();
  var triggerPrice = pick.trade.triggerPrice;
  var stopPct = pick.trade.stopPct || 25;
  var tpLevels = pick.trade.tpLevels || [25, 50, 100];
  var postedAt = pick.posted_at;
  var expiry = pick.trade.expiry;

  if (!triggerPrice) {
    return { computed: false, reason: 'no triggerPrice' };
  }

  // Forward window: post + 30 days OR until expiry, whichever comes first
  var postDate = new Date(postedAt);
  var endDate = expiry ? new Date(expiry + 'T20:00:00Z') : new Date(postDate.getTime() + 30 * 24 * 3600 * 1000);
  if (endDate < postDate) endDate = new Date(postDate.getTime() + 7 * 24 * 3600 * 1000);

  // Pull forward 5-min bars from post date for first 5 days, then daily for remainder
  // We use lastdate=endDate with enough barsback to cover the window
  var daysSpan = Math.min(60, Math.max(2, Math.ceil((endDate - postDate) / (24 * 3600 * 1000))));
  var lastdate = endDate.toISOString().slice(0, 19) + 'Z';

  var bars = await fetchBars(ticker, {
    unit: 'Daily',
    interval: 1,
    barsback: daysSpan + 2,
    lastdate: lastdate,
  });
  if (!bars || bars.length === 0) return { computed: false, reason: 'no forward bars' };

  // Filter to bars STRICTLY after postedAt
  var postMs = postDate.getTime();
  var fwd = bars.filter(function(b) {
    return new Date(b.TimeStamp).getTime() >= postMs;
  });
  if (fwd.length === 0) return { computed: false, reason: 'no bars after post' };

  // Approximate option premium move using delta = 0.5 (ATM) — simplified.
  // TP1 = +25% premium = +12.5% stock move (delta 0.5). TP2 = +50% = +25% stock.
  // For OTM picks the strike % OTM affects this. Use rough: assume entry has
  // delta ~0.4-0.5, so option_move ≈ 2x stock_move from trigger.
  var isLong = direction === 'call' || direction === 'long';

  // Trigger-based outcome: stock must FIRST hit triggerPrice, then move from there
  var triggerHit = false;
  var triggerHitTime = null;
  var entryStock = triggerPrice;
  var maxFavStockPct = 0;
  var maxAdvStockPct = 0;
  var tp1Hit = false, tp2Hit = false, tp3Hit = false, stopHit = false;
  var tp1Time = null, tp2Time = null, tp3Time = null, stopTime = null;

  // Stop = -25% premium ≈ -12.5% stock
  // TP1 = +25% premium ≈ +12.5% stock
  // TP2 = +50% ≈ +25% stock; TP3 = +100% ≈ +50% stock
  var stopMovePct = (stopPct || 25) / 2;  // option to stock conversion
  var tp1MovePct = (tpLevels[0] || 25) / 2;
  var tp2MovePct = (tpLevels[1] || 50) / 2;
  var tp3MovePct = (tpLevels[2] || 100) / 2;

  for (var i = 0; i < fwd.length; i++) {
    var bar = fwd[i];
    if (!triggerHit) {
      // Check trigger hit (long: high >= trigger, short: low <= trigger)
      if (isLong && bar.High >= triggerPrice) {
        triggerHit = true;
        triggerHitTime = bar.TimeStamp;
        entryStock = triggerPrice;
      } else if (!isLong && bar.Low <= triggerPrice) {
        triggerHit = true;
        triggerHitTime = bar.TimeStamp;
        entryStock = triggerPrice;
      }
      if (!triggerHit) continue;
    }

    // After trigger: track moves from entryStock
    var movePctHigh, movePctLow;
    if (isLong) {
      movePctHigh = ((bar.High - entryStock) / entryStock) * 100;
      movePctLow = ((bar.Low - entryStock) / entryStock) * 100;
    } else {
      movePctHigh = ((entryStock - bar.Low) / entryStock) * 100;  // favorable for shorts
      movePctLow = ((entryStock - bar.High) / entryStock) * 100;  // adverse for shorts
    }

    if (movePctHigh > maxFavStockPct) maxFavStockPct = movePctHigh;
    if (movePctLow < maxAdvStockPct) maxAdvStockPct = movePctLow;

    if (!tp1Hit && movePctHigh >= tp1MovePct) { tp1Hit = true; tp1Time = bar.TimeStamp; }
    if (!tp2Hit && movePctHigh >= tp2MovePct) { tp2Hit = true; tp2Time = bar.TimeStamp; }
    if (!tp3Hit && movePctHigh >= tp3MovePct) { tp3Hit = true; tp3Time = bar.TimeStamp; }
    if (!stopHit && movePctLow <= -stopMovePct) { stopHit = true; stopTime = bar.TimeStamp; }
    // Stop fires before TP if it happens first chronologically — we still log both,
    // but finalOutcome resolves below.
  }

  var finalOutcome;
  if (!triggerHit) finalOutcome = 'NO_TRIGGER';
  else if (tp3Hit) finalOutcome = 'WIN_TP3';
  else if (tp2Hit) finalOutcome = 'WIN_TP2';
  else if (tp1Hit) finalOutcome = 'WIN_TP1';
  else if (stopHit) finalOutcome = 'LOSS_STOP';
  else finalOutcome = 'TIMED_OUT';

  // Convert stock moves back to approximate option premium %
  var maxFavorablePremPct = Math.round(maxFavStockPct * 2 * 10) / 10;
  var maxAdversePremPct = Math.round(maxAdvStockPct * 2 * 10) / 10;

  return {
    computed: true,
    triggerHit: triggerHit,
    triggerHitTime: triggerHitTime,
    tp1Hit: tp1Hit, tp1Time: tp1Time,
    tp2Hit: tp2Hit, tp2Time: tp2Time,
    tp3Hit: tp3Hit, tp3Time: tp3Time,
    stopHit: stopHit, stopTime: stopTime,
    maxFavorableStockPct: Math.round(maxFavStockPct * 100) / 100,
    maxAdverseStockPct: Math.round(maxAdvStockPct * 100) / 100,
    maxFavorablePremPct: maxFavorablePremPct,
    maxAdversePremPct: maxAdversePremPct,
    finalOutcome: finalOutcome,
    barsForward: fwd.length,
  };
}

// =============================================================================
// ENRICH ONE PICK
// =============================================================================
async function enrichPick(pick) {
  try {
    var [revEng, outcome] = await Promise.all([
      reverseEngineer(pick),
      computeOutcome(pick),
    ]);
    return {
      msg_id: pick.msg_id,
      ticker: pick.trade.ticker,
      direction: pick.trade.direction,
      tradeType: pick.trade.tradeType || 'DAY',
      postedAt: pick.posted_at,
      triggerPrice: pick.trade.triggerPrice,
      strike: pick.trade.strike,
      expiry: pick.trade.expiry,
      dte: pick.trade.dte,
      stopPct: pick.trade.stopPct,
      tpLevels: pick.trade.tpLevels,
      _source: pick._source,
      reverseEngineering: revEng,
      outcome: outcome,
      enrichedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      msg_id: pick.msg_id,
      ticker: pick.trade.ticker,
      enrichError: e.message,
      enrichedAt: new Date().toISOString(),
    };
  }
}

// =============================================================================
// BATCH BACKFILL (the main entry point)
// =============================================================================
async function backfillAll(opts) {
  opts = opts || {};
  var batchSize = opts.batchSize || 8;
  var batchDelayMs = opts.batchDelayMs || 1500;
  var force = opts.force === true;
  var maxPicks = opts.maxPicks || null;

  var allPicks = loadAllPicks();
  console.log('[JPA] loaded', allPicks.length, 'historical picks');
  if (!allPicks.length) {
    return { ok: false, error: 'no picks found in history dir', dir: getHistoryDir() };
  }

  var enriched = loadEnriched();
  var enrichedMap = {};
  enriched.forEach(function(e) { enrichedMap[e.msg_id] = e; });

  // Filter: keep only picks that haven't been enriched yet (unless force)
  var todo = allPicks.filter(function(p) {
    if (force) return true;
    var existing = enrichedMap[p.msg_id];
    if (!existing) return true;
    // Re-enrich if previously failed or has no outcome computed
    if (existing.enrichError) return true;
    if (existing.outcome && existing.outcome.computed === false) return true;
    return false;
  });

  if (maxPicks && todo.length > maxPicks) {
    todo = todo.slice(0, maxPicks);
  }
  console.log('[JPA] enriching', todo.length, 'picks (already done:', enriched.length, ')');

  var enrichedNew = 0;
  var failedNew = 0;
  var outcomeComputedNew = 0;

  for (var batchStart = 0; batchStart < todo.length; batchStart += batchSize) {
    var batch = todo.slice(batchStart, batchStart + batchSize);
    console.log('[JPA] batch', batchStart, '-', batchStart + batch.length, 'of', todo.length);
    var results = await Promise.all(batch.map(function(p) { return enrichPick(p); }));
    results.forEach(function(r) {
      // Replace existing or push new
      var idx = enriched.findIndex(function(e) { return e.msg_id === r.msg_id; });
      if (idx >= 0) enriched[idx] = r;
      else enriched.push(r);
      if (r.enrichError) failedNew++;
      else {
        enrichedNew++;
        if (r.outcome && r.outcome.computed) outcomeComputedNew++;
      }
    });
    saveEnriched(enriched);  // persist after each batch (resume-safe)
    if (batchStart + batchSize < todo.length) {
      await new Promise(function(res) { setTimeout(res, batchDelayMs); });
    }
  }

  return {
    ok: true,
    totalPicks: allPicks.length,
    enrichedTotal: enriched.length,
    enrichedNew: enrichedNew,
    failedNew: failedNew,
    outcomeComputedNew: outcomeComputedNew,
    pathOut: ENRICHED_PATH,
  };
}

// =============================================================================
// STATS
// =============================================================================
function getStats() {
  var enriched = loadEnriched();
  var labels = {};
  var outcomes = {};
  enriched.forEach(function(e) {
    var lab = (e.reverseEngineering && e.reverseEngineering.structuralLabel) || 'UNKNOWN';
    labels[lab] = (labels[lab] || 0) + 1;
    var oc = (e.outcome && e.outcome.finalOutcome) || 'PENDING';
    outcomes[oc] = (outcomes[oc] || 0) + 1;
  });
  return {
    enrichedCount: enriched.length,
    byStructuralLabel: labels,
    byOutcome: outcomes,
    pathOut: ENRICHED_PATH,
    pathExists: fs.existsSync(ENRICHED_PATH),
  };
}

module.exports = {
  loadEnriched: loadEnriched,
  loadAllPicks: loadAllPicks,
  enrichPick: enrichPick,
  backfillAll: backfillAll,
  getStats: getStats,
  // expose for tests
  classifyStructural: classifyStructural,
  classifyTrend: classifyTrend,
  rangeSummary: rangeSummary,
  recentPattern: recentPattern,
};
