// =============================================================================
// JOHN PATTERN SCANNER (JS) — detects single/double-bar Strat reversal patterns
// that are John's actual most-used vocabulary (per the methodology miner data):
//
//   - Failed 2D    (68 hits in his archive — bullish reversal)
//   - Failed 2U    (27 hits — bearish reversal)
//   - 2D-2U        (26 hits — bullish 2-bar reversal combo)
//   - 2U-2D        (bearish 2-bar reversal combo)
//   - Inside Week  (31 hits on Weekly — single inside bar at higher TF)
//
// CRITICAL DIFFERENCE FROM `dailyCoilScanner` (which is multi-bar coil setups):
// these are single/double-bar REVERSAL patterns. Different category, different
// trade thesis. Coil = compression awaiting break; reversal = trend flip.
//
// AB's UNIQUE EDGE — custom 3-layer stop framework on every plan:
//   1. Hard stop  = MAX(-25% premium loss, structural invalidation level)
//   2. Time stop  = halve position if not in profit by 2 candle closes
//   3. Breakeven  = move stop to entry once TP1 hits
//
// John can survive averaging down with a big port. AB can't. Custom stops
// enforce discipline AB needs that John doesn't.
//
// MULTI-CANDLE CONFIRM (also AB-specific): require 2 consecutive candle closes
// past trigger before signaling to fire. John fires on first trigger; AB
// needs the extra confirmation given smaller account.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[JS] tradestation not loaded:', e.message); }

var holdOvernightChecker = null;
try { holdOvernightChecker = require('./holdOvernightChecker'); }
catch (e) { /* optional */ }

var lottoFeed = null;
try { lottoFeed = require('./lottoFeed'); } catch (e) {}
var swingLeapFeed = null;
try { swingLeapFeed = require('./swingLeapFeed'); } catch (e) {}
var sniperFeed = null;
try { sniperFeed = require('./sniperFeed'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var JS_FILE = path.join(DATA_ROOT, 'js_scan.json');
var CONFIRM_FILE = path.join(DATA_ROOT, 'js_confirm_state.json');

// Hardcoded fallback to #stratum-swing webhook (matches coil/wp pattern).
var DISCORD_WEBHOOK = process.env.DISCORD_JS_WEBHOOK
  || process.env.DISCORD_COIL_WEBHOOK
  || process.env.DISCORD_STRAT_SWING_WEBHOOK
  || 'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// =============================================================================
// MID-CAP UNIVERSE EXPANSION (Phase 4) — S&P 400 + active mid-caps John trades
// =============================================================================
// Curated list. Not the full S&P 400 (would be 400 names), just the most
// liquid + actively-traded names AB sees John reference. Covers ~120 names.
var MID_CAP_TICKERS = [
  // Consumer / Retail
  'YUM','CMG','DPZ','MCD','SBUX','LULU','NKE','RL','VFC','UAA','HD','LOW','TGT','COST','WMT','KR','GIS','K','HSY','MDLZ',
  // Tech mid/large
  'CRM','SHOP','SQ','PYPL','HOOD','COIN','ROKU','PINS','SNAP','TWLO','CRWD','PANW','ZS','OKTA','DDOG','MDB','SNOW','U','PLTR','PATH','AI','NET','UBER','LYFT','ABNB','DASH','CART','SOFI',
  // Semis (mid)
  'AVGO','QCOM','MU','LRCX','KLAC','AMAT','TSM','ASML','MRVL','ARM','SMCI','ALAB','ON','SWKS','MPWR','MCHP',
  // EV / Auto
  'TSLA','RIVN','LCID','F','GM','NIO','XPEV','LI',
  // Energy (small/mid)
  'OXY','DVN','CHRD','MRO','APA','HAL','SLB','OKE','ET','KMI','EOG','XOM','CVX',
  // Healthcare (mid)
  'JNJ','LLY','UNH','ABBV','PFE','MRK','BMY','GILD','BIIB','VRTX','REGN','MRNA','BNTX','HCA','CI','HUM',
  // Financials (mid)
  'SCHW','BAC','C','WFC','USB','MS','GS','JPM','PNC','TFC','COF','AXP','V','MA',
  // Industrials / Defense
  'BA','RTX','LMT','GD','NOC','LHX','GE','HON','CAT','DE','MMM','FDX','UPS','UNP','CSX','LUV','DAL','UAL','AAL',
  // Small-cap clean tech / specialty (John's playground)
  'FCEL','PLUG','OPEN','BBAI','SOUN','ASTS','RKLB','LUNR','SPCE','RGTI','IONQ','QBTS','QS','CHPT','BLNK','WBD','SIRI',
  // ETFs / Indices
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLY','XLP','XLI','XLV','XLB','XLU','XLRE','XLC',
  // Major media / comms
  'META','GOOGL','GOOG','AMZN','AAPL','MSFT','NVDA','NFLX','DIS','CMCSA','VZ','T','TMUS',
];

// =============================================================================
// BAR CLASSIFIERS
// =============================================================================
function stratNumber(bar, prev) {
  if (!bar || !prev) return null;
  var insideHigh = bar.High <= prev.High;
  var insideLow = bar.Low >= prev.Low;
  var outsideHigh = bar.High > prev.High;
  var outsideLow = bar.Low < prev.Low;
  if (insideHigh && insideLow) return '1';
  if (outsideHigh && outsideLow) return '3';
  if (outsideHigh && insideLow) return '2U';
  if (insideHigh && outsideLow) return '2D';
  if (bar.High > prev.High) return '2U';
  if (bar.Low < prev.Low) return '2D';
  return '1';
}

// Failed 2D: bar broke prior LOW (looked like 2D) but CLOSED back above prior LOW.
// MUST stay below prior high (else it's an outside bar 3, not a failed-2D).
// Bullish reversal — bear bait failed.
function isFailed2D(bar, prev) {
  if (!bar || !prev) return false;
  return bar.Low < prev.Low && bar.Close > prev.Low && bar.High <= prev.High;
}

// Failed 2U: bar broke prior HIGH (looked like 2U) but CLOSED back below prior HIGH.
// MUST stay above prior low (else it's an outside bar 3, not a failed-2U).
// Bearish reversal — bull bait failed.
function isFailed2U(bar, prev) {
  if (!bar || !prev) return false;
  return bar.High > prev.High && bar.Close < prev.High && bar.Low >= prev.Low;
}

// Hammer: bullish reversal candle. Long lower wick (>= 2x body), close in
// upper third of range. Often appears at swing lows / support tests.
function isHammer(bar) {
  if (!bar) return false;
  var body = Math.abs(bar.Close - bar.Open);
  var range = bar.High - bar.Low;
  if (range <= 0) return false;
  var lowerWick = Math.min(bar.Close, bar.Open) - bar.Low;
  var closePos = (bar.Close - bar.Low) / range;
  return lowerWick >= 2 * body && closePos >= 0.6 && body / range <= 0.4;
}

// Shooter (Shooting Star): bearish reversal candle. Long upper wick (>= 2x
// body), close in lower third of range. Often appears at swing highs / resistance tests.
function isShooter(bar) {
  if (!bar) return false;
  var body = Math.abs(bar.Close - bar.Open);
  var range = bar.High - bar.Low;
  if (range <= 0) return false;
  var upperWick = bar.High - Math.max(bar.Close, bar.Open);
  var closePos = (bar.High - bar.Close) / range;
  return upperWick >= 2 * body && closePos >= 0.6 && body / range <= 0.4;
}

// =============================================================================
// MULTI-BAR STRUCTURAL MEMORY (Phase 2 — NVDA setup detector)
// Scans the last N bars for a fired 3-1-2 pattern (the moment a prior 1-3-1
// or 3-1 setup actually triggered into a 2U/2D break). Returns the fire
// metadata: trigger price, structural floor, direction, peak/trough reached.
//
// This is the "structural memory" John uses on charts like NVDA where the
// 3-1-2 Rev arrows are 5-7 bars in the past — our single-bar detector misses
// it entirely without history.
// =============================================================================
function findRecentFiredTrigger(bars, maxLookback) {
  if (!bars || bars.length < 5) return null;
  // Widened default — NVDA-style retests can be 5-15 bars after fire
  var maxBack = Math.min(maxLookback || 20, bars.length - 3);
  // Scan from most recent (excluding current bar) back maxBack bars.
  // For each candidate `i` representing the FIRE bar:
  //   bars[i-2] = the parent (3 outside or directional 2U/2D)
  //   bars[i-1] = the inside bar (1)
  //   bars[i]   = the fire (2U breaking inside high = long, or 2D breaking inside low = short)
  for (var lookback = 1; lookback <= maxBack; lookback++) {
    var fireIdx = bars.length - 1 - lookback;
    if (fireIdx < 2) break;
    var fireBar = bars[fireIdx];
    var insideBar = bars[fireIdx - 1];
    var parentBar = bars[fireIdx - 2];

    var sParent = stratNumber(parentBar, fireIdx >= 3 ? bars[fireIdx - 3] : null);
    var sInside = stratNumber(insideBar, parentBar);
    var sFire = stratNumber(fireBar, insideBar);

    // Need: inside bar (1) sandwiched, then fire bar broke that inside bar's range
    if (sInside !== '1') continue;
    if (sParent !== '3' && sParent !== '2U' && sParent !== '2D') continue;

    if (sFire === '2U') {
      // Long fire — broke inside bar's HIGH
      var triggerPrice = round2(insideBar.High);
      var structuralFloor = round2(insideBar.Low);
      // Compute peak reached after fire (highest high in fireBar through bars[fireIdx + lookback - 1])
      var peakHigh = fireBar.High;
      for (var k = fireIdx + 1; k < bars.length - 1; k++) {
        if (bars[k].High > peakHigh) peakHigh = bars[k].High;
      }
      return {
        firedAtIdx: fireIdx,
        barsAgo: lookback,
        direction: 'long',
        triggerPrice: triggerPrice,
        structuralFloor: structuralFloor,
        peakReached: round2(peakHigh),
        parentPattern: sParent + '-1-2U',
      };
    }
    if (sFire === '2D') {
      // Short fire — broke inside bar's LOW
      var triggerPrice2 = round2(insideBar.Low);
      var structuralCeil = round2(insideBar.High);
      var troughLow = fireBar.Low;
      for (var m = fireIdx + 1; m < bars.length - 1; m++) {
        if (bars[m].Low < troughLow) troughLow = bars[m].Low;
      }
      return {
        firedAtIdx: fireIdx,
        barsAgo: lookback,
        direction: 'short',
        triggerPrice: triggerPrice2,
        structuralFloor: structuralCeil,  // For shorts this is the upper invalidation
        troughReached: round2(troughLow),
        parentPattern: sParent + '-1-2D',
      };
    }
  }
  return null;
}

// Check if current bar is in the "retest zone" of a fired trigger — meaning
// price has pulled back to within tolerance of the original trigger but
// hasn't broken the structural floor (long) / ceiling (short) that would
// invalidate the thesis.
function isInRetestZone(latestBar, fired) {
  if (!fired || !latestBar) return false;
  var tolerance = 0.04;  // 4% retest zone — NVDA at $198 testing $195 = 1.5%, well within
  if (fired.direction === 'long') {
    var inZoneL = latestBar.Low <= fired.triggerPrice * (1 + tolerance);
    var stillAboveStructural = latestBar.Close > fired.structuralFloor;
    var hasMoved = fired.peakReached > fired.triggerPrice * 1.03;  // Original fire actually went somewhere (>3%)
    return inZoneL && stillAboveStructural && hasMoved;
  }
  if (fired.direction === 'short') {
    var inZoneS = latestBar.High >= fired.triggerPrice * (1 - tolerance);
    var stillBelowStructural = latestBar.Close < fired.structuralFloor;
    var hasMoved2 = fired.troughReached < fired.triggerPrice * 0.97;
    return inZoneS && stillBelowStructural && hasMoved2;
  }
  return false;
}

// =============================================================================
// PATTERN DETECTION
// Examines the last 1-2 bars in context for John's actual reversal patterns.
// =============================================================================
function detectJSPattern(bars, tf) {
  if (!bars || bars.length < 3) return null;
  var last = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var prev2 = bars[bars.length - 3];

  // 0) Multi-bar structural memory: prior 3-1-2 fired + current bar in retest zone
  // (NVDA setup — AB's favorite). Higher conviction because the structure has
  // already proved itself by firing once. TF-aware lookback: more bars on
  // Daily/Weekly so swings 2-3 weeks back can still trigger.
  var lookback = tf === 'Daily' ? 20 : tf === 'Weekly' ? 16 : 14;
  var fired = findRecentFiredTrigger(bars, lookback);
  if (fired && isInRetestZone(last, fired)) {
    var thesisL = 'Prior ' + fired.parentPattern + ' fired ' + fired.barsAgo + ' bars ago at $' +
      fired.triggerPrice + ' (' + (fired.direction === 'long' ? 'peaked $' + fired.peakReached : 'troughed $' + fired.troughReached) +
      '). Current pullback retesting the trigger = second-chance entry at better price.';
    return {
      name: 'pullback-retest',
      direction: fired.direction,
      conviction: 9,
      thesis: thesisL,
      fired: fired,  // Pass to buildPlan for level-aware plan
    };
  }

  var sLast = stratNumber(last, prev);
  var sPrev = stratNumber(prev, prev2);
  var sPrev2 = bars.length >= 4 ? stratNumber(prev2, bars[bars.length - 4]) : null;

  // 1) 2-1-2 Reversal — directional, inside, OPPOSITE directional. Single most
  // common Strat 3-bar pattern (26 hits in John archive). Highest conviction.
  if (sPrev2 === '2D' && sPrev === '1' && sLast === '2U') {
    return {
      name: '2-1-2-Rev',
      direction: 'long',
      conviction: 9,
      thesis: 'Down bar, then inside compression, then up bar that broke inside high = bullish 3-bar Strat reversal.',
    };
  }
  if (sPrev2 === '2U' && sPrev === '1' && sLast === '2D') {
    return {
      name: '2-1-2-Rev',
      direction: 'short',
      conviction: 9,
      thesis: 'Up bar, then inside compression, then down bar that broke inside low = bearish 3-bar Strat reversal.',
    };
  }

  // 2) 2-1-2 Continuation — same-direction trend continuation through inside bar
  if (sPrev2 === '2U' && sPrev === '1' && sLast === '2U') {
    return {
      name: '2-1-2-Cont',
      direction: 'long',
      conviction: 8,
      thesis: 'Up bar, inside pause, up bar broke inside high = bullish trend continuation.',
    };
  }
  if (sPrev2 === '2D' && sPrev === '1' && sLast === '2D') {
    return {
      name: '2-1-2-Cont',
      direction: 'short',
      conviction: 8,
      thesis: 'Down bar, inside pause, down bar broke inside low = bearish trend continuation.',
    };
  }

  // 3) 3-2-2 Rev — outside bar, then 2 directional, then 2 opposite = reversal
  // out of expansion. Strong because it confirms the bigger structure change.
  if (sPrev2 === '3' && sPrev === '2D' && sLast === '2U') {
    return {
      name: '3-2-2-Rev',
      direction: 'long',
      conviction: 9,
      thesis: 'Outside bar, then down bar, then up bar that took out inside-bar high = bullish reversal from volatility expansion.',
    };
  }
  if (sPrev2 === '3' && sPrev === '2U' && sLast === '2D') {
    return {
      name: '3-2-2-Rev',
      direction: 'short',
      conviction: 9,
      thesis: 'Outside bar, then up bar, then down bar = bearish reversal from volatility expansion.',
    };
  }

  // 4) 1-2-2 RevStrat Rev — inside bar, then 2 directional, then 2 opposite
  // = reversal originating from compression. The "RevStrat" label is from
  // the Strat Teach indicator — this is a clean structural reversal pattern.
  if (sPrev2 === '1' && sPrev === '2D' && sLast === '2U') {
    return {
      name: '1-2-2-Rev',
      direction: 'long',
      conviction: 8,
      thesis: 'Inside compression, then down move that failed and reversed = bullish RevStrat.',
    };
  }
  if (sPrev2 === '1' && sPrev === '2U' && sLast === '2D') {
    return {
      name: '1-2-2-Rev',
      direction: 'short',
      conviction: 8,
      thesis: 'Inside compression, then up move that failed and reversed = bearish RevStrat.',
    };
  }

  // 5) Failed 2D on most recent bar = single-bar bullish reversal
  if (isFailed2D(last, prev)) {
    return {
      name: 'failed-2D',
      direction: 'long',
      conviction: 8,
      thesis: 'Bar broke prior low (' + round2(prev.Low) + ') then closed back above. Bear bait failed = bullish reversal.',
    };
  }

  // 6) Failed 2U on most recent bar = single-bar bearish reversal
  if (isFailed2U(last, prev)) {
    return {
      name: 'failed-2U',
      direction: 'short',
      conviction: 8,
      thesis: 'Bar broke prior high (' + round2(prev.High) + ') then closed back below. Bull bait failed = bearish reversal.',
    };
  }

  // 7) 2D-2U combo: prev bar 2D, current bar 2U = bullish 2-bar reversal
  if (sPrev === '2D' && sLast === '2U') {
    return {
      name: '2D-2U',
      direction: 'long',
      conviction: 7,
      thesis: 'Down bar then up bar that broke prior bar high = 2-bar bullish reversal.',
    };
  }

  // 8) 2U-2D combo: prev bar 2U, current bar 2D = bearish 2-bar reversal
  if (sPrev === '2U' && sLast === '2D') {
    return {
      name: '2U-2D',
      direction: 'short',
      conviction: 7,
      thesis: 'Up bar then down bar that broke prior bar low = 2-bar bearish reversal.',
    };
  }

  // 9) Hammer (single-bar bullish reversal candle) — long lower wick, close in upper third
  if (isHammer(last)) {
    return {
      name: 'hammer',
      direction: 'long',
      conviction: 7,
      thesis: 'Hammer reversal candle — long lower wick rejected, close near high. Buyers stepped in.',
    };
  }

  // 10) Shooter (Shooting Star) — long upper wick, close in lower third
  if (isShooter(last)) {
    return {
      name: 'shooter',
      direction: 'short',
      conviction: 7,
      thesis: 'Shooter reversal candle — long upper wick rejected, close near low. Sellers stepped in.',
    };
  }

  // 11) 3-1 prep: outside bar (3) followed by inside bar (1) = expansion then
  // compression. ALWAYS output (matches Strat Teach indicator "3-1-2 ▲
  // Actionable" behavior — it surfaces every 3-1 regardless of close position).
  // Direction priority:
  //   1. Inside bar body color (close > open = LONG bias, < = SHORT bias)
  //   2. If exact doji: close position in range (>= midpoint = LONG)
  //   3. Last resort: parent 3 close color
  if (sLast === '1' && sPrev === '3') {
    var insideRange = last.High - last.Low;
    var dir31 = 'neutral';
    var convAdjust = 0;
    if (last.Close > last.Open) {
      dir31 = 'long';  // Body is green
    } else if (last.Close < last.Open) {
      dir31 = 'short'; // Body is red
    } else if (insideRange > 0) {
      // Exact doji — fall back to close position in range
      var closePos = (last.Close - last.Low) / insideRange;
      dir31 = closePos >= 0.5 ? 'long' : 'short';
      convAdjust = -1; // Less conviction on doji
    } else {
      // Zero range bar — use parent close as last resort
      dir31 = prev.Close > prev.Open ? 'long' : 'short';
      convAdjust = -1;
    }
    var parentBias = prev.Close > prev.Open ? 'bullish' : prev.Close < prev.Open ? 'bearish' : 'doji';
    return {
      name: '3-1-prep',
      direction: dir31,
      conviction: 7 + convAdjust,
      thesis: 'Outside bar (3, ' + parentBias + ') then inside bar (1, ' +
              (last.Close > last.Open ? 'bullish' : last.Close < last.Open ? 'bearish' : 'doji') +
              ' body) = expansion-then-compression. Fire on break of inside bar ' +
              (dir31 === 'long' ? 'HIGH' : 'LOW') + '.',
    };
  }

  // 6) Inside Week (Weekly TF only) — single inside bar at higher TF = compression
  if (tf === 'Weekly' && sLast === '1') {
    var parent = stratNumber(prev, prev2);
    var dir = parent === '2U' ? 'long' : parent === '2D' ? 'short' : 'neutral';
    return {
      name: 'inside-week',
      direction: dir,
      conviction: 6,
      thesis: 'Inside week after directional ' + parent + ' = compression awaiting break of inside bar high/low.',
    };
  }

  return null;
}

function round2(v) { return Math.round(v * 100) / 100; }

// =============================================================================
// PLAN BUILDER — with AB's custom 3-layer stop framework
// =============================================================================
function buildPlan(pattern, bars, lastClose) {
  if (!bars || bars.length < 2) return null;
  var last = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var range = last.High - last.Low;
  if (range <= 0) return null;

  var direction = pattern.direction;
  var trigger, stop, structural, tp1, tp2;

  // Special case: pullback-retest pattern uses the ORIGINAL fired trigger's
  // levels rather than the latest bar's range — we want to re-enter the
  // proven structure, not trade the pullback bar itself.
  if (pattern.name === 'pullback-retest' && pattern.fired) {
    var f = pattern.fired;
    if (direction === 'long') {
      trigger = f.triggerPrice;            // Re-break original trigger
      stop = f.structuralFloor;             // Below original inside-bar low
      structural = f.structuralFloor;
      var fireMove = f.peakReached - f.triggerPrice;
      tp1 = round2(f.peakReached);          // First target = prior swing high
      tp2 = round2(f.triggerPrice + fireMove * 1.5);  // Extension beyond peak
    } else {
      trigger = f.triggerPrice;
      stop = f.structuralFloor;
      structural = f.structuralFloor;
      var fireMove2 = f.triggerPrice - f.troughReached;
      tp1 = round2(f.troughReached);        // First target = prior swing low
      tp2 = round2(f.triggerPrice - fireMove2 * 1.5);
    }
  }
  // Standard case: single/double-bar reversal — use latest bar's range
  else if (direction === 'long') {
    trigger = round2(last.High);
    structural = round2(last.Low);
    stop = structural;
    var moveSize = range > 0 ? range : (last.High * 0.01);
    tp1 = round2(trigger + moveSize);
    tp2 = round2(trigger + moveSize * 2);
  } else if (direction === 'short') {
    trigger = round2(last.Low);
    structural = round2(last.High);
    stop = structural;
    var moveSize2 = range > 0 ? range : (last.Low * 0.01);
    tp1 = round2(trigger - moveSize2);
    tp2 = round2(trigger - moveSize2 * 2);
  } else {
    return null;
  }

  var risk = direction === 'long' ? round2(trigger - stop) : round2(stop - trigger);
  var reward1 = direction === 'long' ? round2(tp1 - trigger) : round2(trigger - tp1);
  var reward2 = direction === 'long' ? round2(tp2 - trigger) : round2(trigger - tp2);

  // === AB's CUSTOM 3-LAYER STOP FRAMEWORK ===
  // Replaces John's flat % stops with a tighter, capital-aware framework.
  var customStops = {
    // Layer 1: Hard stop = the structural level (above) — same as standard `stop`
    hardStop: stop,
    hardStopReason: 'Structural invalidation: close ' + (direction === 'long' ? 'below' : 'above') + ' $' + structural + ' = pattern broken',
    // Layer 2: Premium hard cap (-25% on the option) — separate from price-structure
    premiumStopPct: 25,
    // Layer 3: Time stop — if not in profit after 2 candle closes, cut size in half
    timeStopBars: 2,
    timeStopAction: 'Halve position if not in profit by 2 candle closes',
    // Layer 4: Breakeven move at TP1
    breakevenAtTP1: true,
    breakevenAction: 'Move stop to entry once TP1 hits — never give back winners',
  };

  return {
    direction: direction,
    primary: {
      trigger: trigger, stop: stop, tp1: tp1, tp2: tp2,
      risk: risk, reward1: reward1, reward2: reward2,
    },
    structuralLevel: structural,
    rangeUsed: round2(range),
    rr1: risk > 0 ? round2(reward1 / risk) : null,
    rr2: risk > 0 ? round2(reward2 / risk) : null,
    customStops: customStops,
  };
}

// =============================================================================
// CONVICTION SCORING — TF-aware bump same as coil scanner
// =============================================================================
function adjustConviction(base, ticker, bars, holdRating, tf) {
  var conv = base;
  // TF tiers: Weekly is biggest structure (rarest); 6HR has best historical
  // win rate per AB live trading (the John sweet spot); Daily is baseline.
  if (tf === 'Weekly')      conv += 2;
  else if (tf === '6HR')    conv += 1;
  // Daily: no bump (baseline)
  if (holdRating === 'AVOID') conv -= 3;
  if (holdRating === 'CAUTION') conv -= 1;
  if (holdRating === 'SAFE') conv += 1;
  // Tight reversal bar (range < 1.5% of price) = high conviction
  if (bars && bars.length >= 1) {
    var lastBar = bars[bars.length - 1];
    var rangePct = lastBar.High > 0 ? ((lastBar.High - lastBar.Low) / lastBar.High) * 100 : 99;
    if (rangePct < 1.5) conv += 1;
    if (rangePct < 1.0) conv += 1;
  }
  return Math.max(1, Math.min(10, conv));
}

// =============================================================================
// ACTIONABLE FORECAST — replicates the Strat Teach indicator's "Actionable?"
// label. Given the last 1-2 bars, predicts what the NEXT bar would fire as
// if it breaks current bar's high (long fire) or low (short fire). This is
// the "3-1-2 ▲" / "2-1-2 ▼" output AB sees on his charts.
// =============================================================================
function buildActionableForecast(bars) {
  if (!bars || bars.length < 3) return null;
  var last = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var prev2 = bars[bars.length - 3];
  var sLast = stratNumber(last, prev);
  var sPrev = stratNumber(prev, prev2);

  var longTrigger = round2(last.High);
  var shortTrigger = round2(last.Low);
  var longPattern = null;
  var shortPattern = null;

  if (sLast === '1') {
    // Inside bar — next bar fire would complete an X-1-2 pattern
    if (sPrev === '3') {
      longPattern = '3-1-2 (Long Fire from outside)';
      shortPattern = '3-1-2 (Short Fire from outside)';
    } else if (sPrev === '2U') {
      longPattern = '2-1-2 Cont (bullish trend continuation)';
      shortPattern = '2-1-2 Rev (bullish-to-bearish reversal)';
    } else if (sPrev === '2D') {
      longPattern = '2-1-2 Rev (bearish-to-bullish reversal)';
      shortPattern = '2-1-2 Cont (bearish trend continuation)';
    } else if (sPrev === '1') {
      longPattern = '1-1-2 (double-inside fire long)';
      shortPattern = '1-1-2 (double-inside fire short)';
    }
  } else if (sLast === '2U' || sLast === '2D' || sLast === '3') {
    // Bar already directional — next bar would extend or reverse
    longPattern = sLast === '2D' ? 'Pivot Reversal Long' : 'Continuation Long';
    shortPattern = sLast === '2U' ? 'Pivot Reversal Short' : 'Continuation Short';
  }

  return {
    longTrigger: longTrigger,
    shortTrigger: shortTrigger,
    longPattern: longPattern,
    shortPattern: shortPattern,
    currentStrat: sLast,
    parentStrat: sPrev,
    triangleHint: longPattern && shortPattern ? '▲▼ both directions actionable on break' :
                   longPattern ? '▲ long fire potential' :
                   shortPattern ? '▼ short fire potential' : 'No clean fire forecast',
  };
}

// =============================================================================
// VOLUME CONTEXT — same logic as coil scanner (John volume rule applies)
// =============================================================================
function computeVolumeContext(bars) {
  if (!bars || bars.length < 4) return null;
  var lookback = Math.min(20, bars.length - 1);
  var ref = bars.slice(-1 - lookback, -1);
  var sum = 0, n = 0;
  for (var i = 0; i < ref.length; i++) {
    if (isFinite(ref[i].Volume) && ref[i].Volume > 0) { sum += ref[i].Volume; n++; }
  }
  if (n < 3) return null;
  var avg = sum / n;
  var bar0Vol = bars[bars.length - 1].Volume || 0;
  return {
    avgN: n,
    avgVolume: Math.round(avg),
    barVolume: Math.round(bar0Vol),
    barRatio: avg > 0 ? round2(bar0Vol / avg) : null,
    breakoutTarget: Math.round(avg * 1.5),
  };
}

// =============================================================================
// MULTI-CANDLE CONFIRM TRACKING
// AB's discipline rule: don't fire to Discord until 2 consecutive candle closes
// confirm the trigger. State persists in /data/js_confirm_state.json.
// =============================================================================
function loadConfirmState() {
  try { return JSON.parse(fs.readFileSync(CONFIRM_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveConfirmState(state) {
  try { fs.writeFileSync(CONFIRM_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { /* non-fatal */ }
}
function todayKey() {
  var et = new Date(Date.now() - 4 * 3600 * 1000);
  return et.toISOString().slice(0, 10);
}

// =============================================================================
// UNIVERSE BUILDER — merges static MID_CAP list + dynamic feeds
// =============================================================================
function buildUniverse() {
  var dynamic = [];
  try {
    if (lottoFeed) {
      var lf = lottoFeed.loadFeed({ limit: 50 });
      (lf.picks || []).forEach(function (p) { if (p.ticker) dynamic.push(p.ticker); });
    }
    if (swingLeapFeed) {
      var sf = swingLeapFeed.loadFeed({ limit: 30 });
      (sf.posts || []).forEach(function (p) { if (p.ticker) dynamic.push(p.ticker); });
    }
    if (sniperFeed) {
      var snf = sniperFeed.loadFeed({ limit: 30 });
      (snf.posts || []).forEach(function (p) { if (p.ticker) dynamic.push(p.ticker); });
    }
  } catch (e) { /* dynamic optional */ }

  var seen = {};
  var universe = [];
  MID_CAP_TICKERS.concat(dynamic).forEach(function (t) {
    var u = String(t).toUpperCase();
    if (!seen[u]) { seen[u] = true; universe.push(u); }
  });
  return universe;
}

// =============================================================================
// TIMEFRAME SPECS — same shape as coil scanner
// =============================================================================
// CRITICAL: TS API Minute unit only supports interval values 1/5/15/30/60.
// interval=360 silently falls back to 30-min bars. Solution: pull hourly bars
// (interval=60) and aggregate 6-at-a-time into real 6HR buckets in code.
// barsback=70 gives us ~10 trading days × 7 RTH hours = enough for 12 6HR bars.
var TF_SPECS = {
  'Daily':  { unit: 'Daily',  interval: 1,  barsback: 25, sessiontemplate: null,      label: 'Daily',  aggregateFactor: 1 },
  '6HR':    { unit: 'Minute', interval: 60, barsback: 80, sessiontemplate: 'Default', label: '6HR',    aggregateFactor: 6 },
  'Weekly': { unit: 'Weekly', interval: 1,  barsback: 12, sessiontemplate: null,      label: 'Weekly', aggregateFactor: 1 },
};

// Aggregate hourly bars into N-hour buckets aligned to bar list (most recent
// bucket may be partial — we drop it to avoid inside-bar false positives).
function aggregateBars(bars, factor) {
  if (!bars || factor <= 1) return bars || [];
  // Walk from start, group every `factor` bars
  var out = [];
  for (var i = 0; i < bars.length; i += factor) {
    var slice = bars.slice(i, i + factor);
    if (slice.length < factor) break;  // skip incomplete trailing bucket
    var hi = slice[0].High, lo = slice[0].Low, vol = 0;
    for (var k = 0; k < slice.length; k++) {
      if (slice[k].High > hi) hi = slice[k].High;
      if (slice[k].Low < lo) lo = slice[k].Low;
      vol += slice[k].Volume || 0;
    }
    out.push({
      Open: slice[0].Open,
      High: hi,
      Low: lo,
      Close: slice[slice.length - 1].Close,
      Volume: vol,
      TimeStamp: slice[0].TimeStamp,
    });
  }
  return out;
}

// =============================================================================
// SCAN ONE TICKER
// =============================================================================
async function scanTicker(ticker, token, opts) {
  opts = opts || {};
  var tf = opts.tf || 'Daily';
  var spec = TF_SPECS[tf];
  if (!spec) return { ticker: ticker, tf: tf, error: 'unknown-tf-' + tf };

  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=' + spec.unit + '&interval=' + spec.interval + '&barsback=' + spec.barsback;
    if (spec.sessiontemplate) url += '&sessiontemplate=' + spec.sessiontemplate;
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ticker: ticker, tf: tf, error: 'TS-bars-' + r.status };
    var data = await r.json();
    var raw = (data && (data.Bars || data.bars)) || [];
    if (raw.length < 4) return { ticker: ticker, tf: tf, error: 'not-enough-bars-' + raw.length };

    var rawBars = raw.map(function (b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || b.Volume || 0),
        TimeStamp: b.TimeStamp,
      };
    }).filter(function (b) { return isFinite(b.High) && isFinite(b.Low); });

    // Aggregate hourly bars to 6HR buckets when needed (TS API doesnt natively support 6HR)
    var bars = (spec.aggregateFactor && spec.aggregateFactor > 1)
      ? aggregateBars(rawBars, spec.aggregateFactor)
      : rawBars;

    var pattern = detectJSPattern(bars, tf);

    // WATCH-ONLY FALLBACK: when no concrete pattern fires but the structure
    // is forming an interesting setup (Strat Teach "Actionable" equivalent),
    // surface as low-conviction watch entry. Mirrors how the indicator shows
    // "3-1-2 ▲ Actionable" even when no clean pattern has fired yet.
    // Catches NVDA/CART-style setups our concrete detectors miss.
    if (!pattern || pattern.direction === 'neutral') {
      if (bars.length >= 3) {
        var watchLast = bars[bars.length - 1];
        var watchPrev = bars[bars.length - 2];
        var watchPrev2 = bars[bars.length - 3];
        var sL = stratNumber(watchLast, watchPrev);
        var sP = stratNumber(watchPrev, watchPrev2);
        // Only interesting structures:
        // - Inside bar after directional/outside parent (3-1, 2U-1, 2D-1, 1-1)
        // - Or recent directional bar (might be early on a fire we missed)
        // Any non-null current bar with a meaningful prior bar is interesting.
        // Includes outside bars (3) which fire patterns on their own. Still
        // skip null/undefined classifications.
        var interestingStructure = sL && sP &&
          (sL === '1' || sL === '2U' || sL === '2D' || sL === '3');
        if (interestingStructure) {
          // Direction: prefer body color, fallback to close position in range
          var bodyDir = watchLast.Close > watchLast.Open ? 'long'
                       : watchLast.Close < watchLast.Open ? 'short' : null;
          if (!bodyDir && watchLast.High > watchLast.Low) {
            var pos = (watchLast.Close - watchLast.Low) / (watchLast.High - watchLast.Low);
            bodyDir = pos >= 0.5 ? 'long' : 'short';
          }
          if (bodyDir) {
            pattern = {
              name: 'watch-actionable',
              direction: bodyDir,
              conviction: 4,
              thesis: 'Structure forming (' + (sP || '?') + '-' + (sL || '?') + '). No concrete pattern fired, but ' +
                      (bodyDir === 'long' ? 'bullish' : 'bearish') + ' bias on inside bar body — watch break of ' +
                      (bodyDir === 'long' ? 'HIGH for long fire' : 'LOW for short fire') + '.',
            };
          }
        }
      }
    }

    if (!pattern || pattern.direction === 'neutral') {
      return { ticker: ticker, tf: tf, pattern: null };
    }

    var lastClose = bars[bars.length - 1].Close;
    var plan = buildPlan(pattern, bars, lastClose);
    if (!plan) return { ticker: ticker, tf: tf, pattern: pattern.name, error: 'no-plan' };

    var holdRating = null;
    if (holdOvernightChecker) {
      try {
        var dir = pattern.direction === 'long' ? 'LONG' : 'SHORT';
        var hr = await holdOvernightChecker.checkTicker(ticker, { direction: dir });
        holdRating = hr && hr.rating;
      } catch (e) { /* optional */ }
    }
    var conviction = adjustConviction(pattern.conviction, ticker, bars, holdRating, tf);
    var volumeContext = computeVolumeContext(bars);
    var actionableForecast = buildActionableForecast(bars);

    return {
      ticker: ticker,
      tf: tf,
      pattern: pattern.name,
      direction: pattern.direction,
      thesis: pattern.thesis,
      conviction: conviction,
      lastClose: round2(lastClose),
      plan: plan,
      holdRating: holdRating || null,
      volumeContext: volumeContext,
      actionableForecast: actionableForecast,
      bars: bars.length,
      confirmRequired: 2,
    };
  } catch (e) {
    return { ticker: ticker, tf: tf, error: e.message };
  }
}

// =============================================================================
// MAIN SCAN
// =============================================================================
var _lastRun = null;
var _running = false;

async function runScan(opts) {
  opts = opts || {};
  if (_running && !opts.force) return { skipped: true, reason: 'already-running' };
  _running = true;
  var start = Date.now();
  try {
    var token = opts.token;
    if (!token && ts && ts.getAccessToken) {
      try { token = await ts.getAccessToken(); }
      catch (e) { return { error: 'TS auth: ' + e.message }; }
    }
    if (!token) return { error: 'no-token' };

    var universe = opts.tickers || buildUniverse();
    if (!universe.length) return { error: 'empty-universe' };

    var tfs = opts.tfs || ['Daily', '6HR'];
    if (typeof tfs === 'string') tfs = [tfs];

    console.log('[JS] scanning', universe.length, 'tickers across TFs:', tfs.join(','));

    var CONCURRENCY = 5;
    var results = [];

    for (var tfIdx = 0; tfIdx < tfs.length; tfIdx++) {
      var tf = tfs[tfIdx];
      var queue = universe.slice();
      var tfResults = [];
      while (queue.length) {
        var batch = queue.splice(0, CONCURRENCY);
        var batchResults = await Promise.all(batch.map(function (t) { return scanTicker(t, token, { tf: tf }); }));
        tfResults = tfResults.concat(batchResults);
      }
      results = results.concat(tfResults);
    }

    var matches = results.filter(function (r) { return r.pattern && !r.error; });
    var ready = matches.filter(function (r) { return r.conviction >= 7; });
    var watching = matches.filter(function (r) { return r.conviction === 6; });
    var prep = matches.filter(function (r) { return r.conviction >= 4 && r.conviction < 6; });

    // Sort by conviction desc, then by R:R desc
    var sortFn = function (a, b) {
      if (b.conviction !== a.conviction) return b.conviction - a.conviction;
      var rrA = (a.plan && a.plan.rr1) || 0;
      var rrB = (b.plan && b.plan.rr1) || 0;
      return rrB - rrA;
    };
    ready.sort(sortFn); watching.sort(sortFn); prep.sort(sortFn);

    var byTF = {};
    var byPattern = {};
    matches.forEach(function (r) {
      byTF[r.tf] = (byTF[r.tf] || 0) + 1;
      byPattern[r.pattern] = (byPattern[r.pattern] || 0) + 1;
    });

    var payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      timeframes: tfs,
      scanned: universe.length,
      matched: matches.length,
      byTF: byTF,
      byPattern: byPattern,
      ready: ready,
      watching: watching,
      prep: prep,
      universeSize: universe.length,
    };

    try { fs.writeFileSync(JS_FILE, JSON.stringify(payload, null, 2)); } catch (e) {}
    _lastRun = { startedAt: new Date(start).toISOString(), tookMs: payload.tookMs, matched: matches.length };

    if (opts.cron && (ready.length || watching.length)) {
      try {
        var pushResult = await pushToDiscord(payload);
        payload.discordPush = pushResult;
      } catch (e) {
        payload.discordPush = { error: e.message };
      }
    }

    return payload;
  } finally {
    _running = false;
  }
}

// =============================================================================
// PERSISTENCE
// =============================================================================
function loadLast() {
  try {
    if (!fs.existsSync(JS_FILE)) return null;
    return JSON.parse(fs.readFileSync(JS_FILE, 'utf8'));
  } catch (e) { return null; }
}
function getStatus() {
  return { running: _running, lastRun: _lastRun, file: JS_FILE };
}

// =============================================================================
// DISCORD PUSH
// =============================================================================
async function pushToDiscord(payload) {
  if (!DISCORD_WEBHOOK) {
    console.log('[JS] no DISCORD_JS_WEBHOOK set — skipping push');
    return { skipped: 'no webhook' };
  }
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var ready = (payload.ready || []).slice(0, 4);
  var watching = (payload.watching || []).slice(0, 3);
  if (!ready.length && !watching.length) {
    return { skipped: 'nothing actionable' };
  }

  var lines = [];
  var tfTag = (payload.timeframes || ['Daily']).join('+');
  lines.push('# 🎯 JS PATTERN SCAN — ' + tfTag);
  lines.push('_' + new Date(payload.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + payload.matched + ' patterns across ' + payload.scanned + '_');
  lines.push('_John\'s actual most-used patterns: failed-2D / failed-2U / 2D-2U / 2U-2D / inside-week_');
  lines.push('');

  if (ready.length) {
    lines.push('## 🔥 READY (conv ≥ 7)');
    ready.forEach(function (r) {
      var p = r.plan || {}; var pp = p.primary || {};
      var dirIcon = r.direction === 'long' ? '🟢⬆️' : '🔴⬇️';
      var holdIcon = r.holdRating === 'SAFE' ? '✅' : r.holdRating === 'CAUTION' ? '⚠️' : r.holdRating === 'AVOID' ? '🛑' : '';
      lines.push('**' + r.ticker + '** ' + dirIcon + ' `' + r.pattern + '` · ' + r.tf + ' · conv ' + r.conviction + '/10 ' + holdIcon);
      lines.push('  Trigger `$' + pp.trigger + '` · Stop `$' + pp.stop + '` · TP1 `$' + pp.tp1 + '` · TP2 `$' + pp.tp2 + '` · RR `' + (p.rr1 || '?') + '×`');
      lines.push('  ⚙️ AB stops: hard `$' + p.customStops.hardStop + '` · premium -25% · time `' + p.customStops.timeStopBars + ' bars` · BE@TP1');
      lines.push('  📋 *' + r.thesis + '*');
      lines.push('');
    });
  }
  if (watching.length) {
    lines.push('## 🟡 WATCHING (conv 6)');
    watching.forEach(function (r) {
      var pp = (r.plan && r.plan.primary) || {};
      var dirIcon = r.direction === 'long' ? '⬆️' : '⬇️';
      lines.push('**' + r.ticker + '** ' + dirIcon + ' `' + r.pattern + '` · ' + r.tf + ' · trig `$' + pp.trigger + '` · RR `' + (r.plan.rr1 || '?') + '×`');
    });
    lines.push('');
  }
  lines.push('---');
  lines.push('🛡️ Multi-candle rule: wait for 2 closes past trigger before firing · Custom stops enforced');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'JS Pattern Bot' }),
    });
    if (!r.ok) {
      var t = await r.text();
      console.warn('[JS] discord push failed:', r.status, t.slice(0, 200));
      return { error: 'discord-' + r.status };
    }
    console.log('[JS] discord push OK · ready=' + ready.length + ' watching=' + watching.length);
    return { posted: true, readyCount: ready.length, watchingCount: watching.length };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  runScan: runScan,
  scanTicker: scanTicker,
  loadLast: loadLast,
  getStatus: getStatus,
  pushToDiscord: pushToDiscord,
  buildUniverse: buildUniverse,
  // Exposed for testing
  detectJSPattern: detectJSPattern,
  isFailed2D: isFailed2D,
  isFailed2U: isFailed2U,
  stratNumber: stratNumber,
  buildPlan: buildPlan,
  aggregateBars: aggregateBars,
  MID_CAP_TICKERS: MID_CAP_TICKERS,
};
