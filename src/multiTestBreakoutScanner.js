// =============================================================================
// MULTI-TEST BREAKOUT RECOGNIZER — Phase 4.22 (May 5 PM)
//
// Built after May 5 PM ADBE lesson: my chart-vision agent flagged
// "third rejection at $255.91 = bear thesis activates" — that phrasing was
// INVERTED. Multi-test resistance breaking with volume = bullish accumulation
// completion (textbook Schabacker / Stan Weinstein). AB read it correctly,
// my system did not. He fired ADBE despite my VETO and the position is green.
//
// This module flags the textbook bullish breakout pattern as a GREEN signal:
//   - Resistance level touched 3+ times
//   - Current bar closes ABOVE the level on volume >= 1.5x avg of prior touches
//   - Next bar (1-per-bar rule) confirms the close above
// =============================================================================
//
// Verdict logic:
//   BREAKOUT       — touchCount>=3 + currentBarBroke + volMult>=1.5 + nextBarConfirmed
//   BREAK_PENDING  — touchCount>=3 + currentBarBroke + volMult>=1.5 + !nextBarConfirmed
//   TESTING        — touchCount>=3 + !currentBarBroke (at the level, watch for break)
//   NO_PATTERN     — touchCount<3
//
// Free-only: uses TS bar API via existing tradestation token pattern.
// Fail-open everywhere — never throws to caller.
// =============================================================================

var ts = null;
try { ts = require('./tradestation'); } catch (e) { /* fail open */ }

var fetchLib = require('node-fetch');

// ----- Configurable parameters -----
var DEFAULT_TOLERANCE_PCT = 0.0015;   // 0.15% = how close a high must be to count as a touch
var DEFAULT_MIN_TOUCHES = 3;          // 3+ tests of the level
var DEFAULT_VOLUME_MULTIPLE = 1.5;    // breakout vol must be >=1.5x avg prior-touch vol
var DEFAULT_LOOKBACK_5M = 30;         // last 30 5m bars (~2.5 hours)
var DEFAULT_LOOKBACK_60M = 10;        // last 10 60m bars (~10 hours)

// In-memory cache (30s per ticker)
var _cache = {};   // key: TICKER|TF  →  { ts, payload }
var CACHE_MS = 30 * 1000;

// Pull bars from TradeStation. Mirrors pattern in /api/ta-verify and
// /api/js-scan/debug — fail-open with structured error.
async function fetchBars(ticker, tf) {
  if (!ts || !ts.getAccessToken) {
    return { ok: false, error: 'tradestation module not loaded' };
  }
  var token;
  try {
    token = await ts.getAccessToken();
  } catch (e) {
    return { ok: false, error: 'TS auth failed: ' + e.message };
  }
  if (!token) return { ok: false, error: 'no TS token' };

  var spec;
  if (tf === '5m') {
    spec = { unit: 'Minute', interval: 5, barsback: DEFAULT_LOOKBACK_5M };
  } else if (tf === '60m' || tf === '1HR') {
    spec = { unit: 'Minute', interval: 60, barsback: DEFAULT_LOOKBACK_60M };
  } else {
    return { ok: false, error: 'unsupported tf: ' + tf + ' (use 5m or 60m)' };
  }

  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
    + '?interval=' + spec.interval + '&unit=' + spec.unit + '&barsback=' + spec.barsback;
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    if (!r.ok) return { ok: false, error: 'TS http ' + r.status };
    var data = await r.json();
    var bars = (data.Bars || data.bars || []).map(function (b) {
      return {
        TimeStamp: b.TimeStamp,
        Open: parseFloat(b.Open),
        High: parseFloat(b.High),
        Low: parseFloat(b.Low),
        Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || b.Volume || 0),
      };
    });
    return { ok: true, bars: bars };
  } catch (e) {
    return { ok: false, error: 'TS fetch error: ' + e.message };
  }
}

// Detect resistance level: a price level where 3+ bar highs cluster within
// `tolerance` (proportional). Walk every candidate level (each bar's high)
// and count how many other prior-bar highs sit within tolerance.
//
// We also require touch bars to "close below" the level — i.e. a true
// rejection — to avoid counting bars that simply printed above without
// closing back. The "current bar" is the LAST bar in the array; we exclude
// it from being a touch (it's the candidate breakout).
function findResistance(bars, tolerance) {
  if (!bars || bars.length < 4) return null;
  var lastIdx = bars.length - 1;

  // Candidates = highs of all bars except the last
  var candidates = [];
  for (var i = 0; i < lastIdx; i++) {
    candidates.push({ idx: i, level: bars[i].High });
  }

  // For each candidate level, count how many earlier-bar highs sit within
  // tolerance AND closed below the level (genuine rejections).
  var best = null;
  for (var k = 0; k < candidates.length; k++) {
    var lvl = candidates[k].level;
    if (!isFinite(lvl) || lvl <= 0) continue;
    var tol = lvl * tolerance;
    var touches = [];
    for (var j = 0; j < lastIdx; j++) {
      var b = bars[j];
      if (!b || !isFinite(b.High) || !isFinite(b.Close)) continue;
      // Touch = high within tolerance AND close back under level
      // (close must be at-or-below level to count as a rejection)
      if (Math.abs(b.High - lvl) <= tol && b.Close <= lvl + tol * 0.25) {
        touches.push(j);
      }
    }
    if (touches.length >= DEFAULT_MIN_TOUCHES) {
      // Pick the level with the most touches; tiebreak by highest level
      // (so when stacked, we use the firmest ceiling)
      if (!best || touches.length > best.touchCount
          || (touches.length === best.touchCount && lvl > best.level)) {
        best = {
          level: +lvl.toFixed(4),
          touchCount: touches.length,
          touchBars: touches,
        };
      }
    }
  }
  return best;
}

// Build verdict for given bars on given timeframe.
function evaluate(ticker, tf, bars, opts) {
  opts = opts || {};
  var tolerance = +opts.tolerance || DEFAULT_TOLERANCE_PCT;
  var volMultReq = +opts.volMultiple || DEFAULT_VOLUME_MULTIPLE;

  if (!bars || bars.length < 4) {
    return {
      ok: true,
      ticker: ticker,
      tf: tf,
      verdict: 'NO_PATTERN',
      confidence: 1,
      reasoning: 'not enough bars (' + (bars ? bars.length : 0) + ') for multi-test analysis',
      level: null,
      touchCount: 0,
      touchBars: [],
      currentBarBroke: false,
      currentBarVolume: null,
      avgTouchVolume: null,
      volumeMultiple: null,
      nextBarConfirmed: false,
    };
  }

  // The "current bar" = last bar in array
  var lastIdx = bars.length - 1;
  var current = bars[lastIdx];

  // To check the "next bar confirmation" rule we look at the last bar
  // (current) AND the previous bar. If the previous bar broke above and the
  // current bar ALSO closed above, that's confirmed.
  // So we evaluate two scenarios:
  //   (A) "current bar is the breakout" — uses bars[0..lastIdx-1] as touch
  //       window, current = bar that broke. nextBarConfirmed=false (we
  //       haven't seen the bar after).
  //   (B) "previous bar was the breakout, current bar confirms" — uses
  //       bars[0..lastIdx-2] as touch window, prev = breakout, current =
  //       confirm. nextBarConfirmed=true if current also closes above level.
  //
  // We pick whichever scenario yields the strongest signal.

  // --- Scenario B first (gives BREAKOUT verdict if conditions met) ---
  var resB = null;
  if (bars.length >= 5) {
    var barsForB = bars.slice(0, lastIdx);   // bars[0..lastIdx-1]
    resB = findResistance(barsForB, tolerance);
    if (resB) {
      var prev = bars[lastIdx - 1];
      var prevBroke = prev.Close > resB.level;
      var avgTouchVolB = (function () {
        var sum = 0; var n = 0;
        for (var i = 0; i < resB.touchBars.length; i++) {
          var idx = resB.touchBars[i];
          if (bars[idx] && isFinite(bars[idx].Volume) && bars[idx].Volume > 0) {
            sum += bars[idx].Volume; n++;
          }
        }
        return n > 0 ? sum / n : null;
      })();
      var prevVolMult = (avgTouchVolB && avgTouchVolB > 0) ? prev.Volume / avgTouchVolB : null;
      var currentConfirmed = current.Close > resB.level;
      if (prevBroke && prevVolMult != null && prevVolMult >= volMultReq && currentConfirmed) {
        // Full BREAKOUT confirmed
        var conf = 8;
        if (resB.touchCount >= 4) conf = 9;
        if (resB.touchCount >= 5 && prevVolMult >= 2) conf = 10;
        return {
          ok: true,
          ticker: ticker,
          tf: tf,
          verdict: 'BREAKOUT',
          confidence: conf,
          reasoning: ticker + ' broke $' + resB.level.toFixed(2) + ' after '
            + resB.touchCount + ' tests on ' + tf + ' (vol '
            + prevVolMult.toFixed(2) + 'x avg-touch). Bar 2 confirms close above. '
            + 'Textbook bullish accumulation completion (Schabacker pattern).',
          level: resB.level,
          touchCount: resB.touchCount,
          touchBars: resB.touchBars,
          currentBarBroke: true,
          currentBarVolume: prev.Volume,
          avgTouchVolume: avgTouchVolB ? +avgTouchVolB.toFixed(0) : null,
          volumeMultiple: +prevVolMult.toFixed(2),
          nextBarConfirmed: true,
          breakoutBarTimestamp: prev.TimeStamp,
          confirmBarTimestamp: current.TimeStamp,
        };
      }
    }
  }

  // --- Scenario A: current bar is the candidate breakout ---
  var barsForA = bars;
  var resA = findResistance(barsForA, tolerance);
  if (!resA) {
    return {
      ok: true,
      ticker: ticker,
      tf: tf,
      verdict: 'NO_PATTERN',
      confidence: 1,
      reasoning: 'no resistance level with >= ' + DEFAULT_MIN_TOUCHES + ' touches in lookback window on ' + tf,
      level: null,
      touchCount: 0,
      touchBars: [],
      currentBarBroke: false,
      currentBarVolume: current.Volume,
      avgTouchVolume: null,
      volumeMultiple: null,
      nextBarConfirmed: false,
    };
  }

  var avgTouchVolA = (function () {
    var sum = 0; var n = 0;
    for (var i = 0; i < resA.touchBars.length; i++) {
      var idx = resA.touchBars[i];
      if (bars[idx] && isFinite(bars[idx].Volume) && bars[idx].Volume > 0) {
        sum += bars[idx].Volume; n++;
      }
    }
    return n > 0 ? sum / n : null;
  })();
  var volMult = (avgTouchVolA && avgTouchVolA > 0) ? current.Volume / avgTouchVolA : null;
  var broke = current.Close > resA.level;

  if (broke && volMult != null && volMult >= volMultReq) {
    // BREAK_PENDING — current bar broke with vol but next bar (= bar after)
    // hasn't printed yet
    var confP = 7;
    if (resA.touchCount >= 4) confP = 8;
    if (resA.touchCount >= 5 && volMult >= 2) confP = 9;
    return {
      ok: true,
      ticker: ticker,
      tf: tf,
      verdict: 'BREAK_PENDING',
      confidence: confP,
      reasoning: ticker + ' just broke $' + resA.level.toFixed(2) + ' after '
        + resA.touchCount + ' tests on ' + tf + ' (vol '
        + volMult.toFixed(2) + 'x avg-touch). Wait for next-bar close > level to confirm.',
      level: resA.level,
      touchCount: resA.touchCount,
      touchBars: resA.touchBars,
      currentBarBroke: true,
      currentBarVolume: current.Volume,
      avgTouchVolume: avgTouchVolA ? +avgTouchVolA.toFixed(0) : null,
      volumeMultiple: +volMult.toFixed(2),
      nextBarConfirmed: false,
      breakoutBarTimestamp: current.TimeStamp,
    };
  }

  if (broke && (volMult == null || volMult < volMultReq)) {
    // Broke but on weak vol — call it BREAK_PENDING with low confidence
    return {
      ok: true,
      ticker: ticker,
      tf: tf,
      verdict: 'BREAK_PENDING',
      confidence: 4,
      reasoning: ticker + ' broke $' + resA.level.toFixed(2) + ' after '
        + resA.touchCount + ' tests on ' + tf + ' but vol only '
        + (volMult != null ? volMult.toFixed(2) + 'x' : 'unknown')
        + ' (need >= ' + volMultReq.toFixed(2) + 'x). Watch for vol confirmation.',
      level: resA.level,
      touchCount: resA.touchCount,
      touchBars: resA.touchBars,
      currentBarBroke: true,
      currentBarVolume: current.Volume,
      avgTouchVolume: avgTouchVolA ? +avgTouchVolA.toFixed(0) : null,
      volumeMultiple: volMult != null ? +volMult.toFixed(2) : null,
      nextBarConfirmed: false,
      breakoutBarTimestamp: current.TimeStamp,
    };
  }

  // Not broken — TESTING
  return {
    ok: true,
    ticker: ticker,
    tf: tf,
    verdict: 'TESTING',
    confidence: 5,
    reasoning: ticker + ' has ' + resA.touchCount + ' tests at $' + resA.level.toFixed(2)
      + ' on ' + tf + '. Watching for clean break with vol >= '
      + volMultReq.toFixed(1) + 'x avg-touch.',
    level: resA.level,
    touchCount: resA.touchCount,
    touchBars: resA.touchBars,
    currentBarBroke: false,
    currentBarVolume: current.Volume,
    avgTouchVolume: avgTouchVolA ? +avgTouchVolA.toFixed(0) : null,
    volumeMultiple: volMult != null ? +volMult.toFixed(2) : null,
    nextBarConfirmed: false,
  };
}

// Public: detect for a given ticker + TF. Cached 30s.
async function detect(ticker, tf, opts) {
  ticker = String(ticker || '').toUpperCase();
  tf = tf || '60m';
  if (!ticker) return { ok: false, error: 'ticker required' };

  var key = ticker + '|' + tf;
  var cached = _cache[key];
  if (cached && (Date.now() - cached.ts) < CACHE_MS) {
    return cached.payload;
  }

  var fetched = await fetchBars(ticker, tf);
  if (!fetched.ok) {
    var err = { ok: false, ticker: ticker, tf: tf, error: fetched.error,
      verdict: 'NO_PATTERN', confidence: 1, reasoning: 'bar fetch failed: ' + fetched.error };
    return err;
  }
  var verdict = evaluate(ticker, tf, fetched.bars, opts);
  verdict.barCount = fetched.bars.length;
  // Add last 6 OHLC for transparency on the diagnostic
  verdict.tailBars = fetched.bars.slice(-6).map(function (b) {
    return { t: b.TimeStamp, O: b.Open, H: b.High, L: b.Low, C: b.Close, V: b.Volume };
  });
  _cache[key] = { ts: Date.now(), payload: verdict };
  return verdict;
}

module.exports = {
  detect: detect,
  evaluate: evaluate,           // exposed for unit tests / backtest
  findResistance: findResistance,
  fetchBars: fetchBars,
  // constants
  DEFAULT_TOLERANCE_PCT: DEFAULT_TOLERANCE_PCT,
  DEFAULT_MIN_TOUCHES: DEFAULT_MIN_TOUCHES,
  DEFAULT_VOLUME_MULTIPLE: DEFAULT_VOLUME_MULTIPLE,
};
