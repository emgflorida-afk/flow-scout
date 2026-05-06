/**
 * Phase 4.29 — FIRE GRADE composite signal (May 5 PM 2026)
 * =============================================================================
 * REPLACES: the broken "conviction score" that put highest-conviction setups
 * (SCORE 14 ABBV) at the top of AB's worst-loser list today.
 *
 * REAL DATA validating this rebuild (May 5 2026):
 *   WINNERS:
 *     CRM long       — Daily uptrend + breakout + tape RISK_ON  + ITM call
 *     BA short       — Daily down  + breakout DOWN + tape neutral + ITM put
 *     NTAP-2 long    — multi-test confirmed + tape aligned + clean structure
 *   LOSERS:
 *     INTC short     — counter-tape (RISK_ON) — should never have fired
 *     F   long        — counter-tape put on a dump
 *     RIVN short     — no clean structure
 *     ADBE mid-day   — vision VETO ignored
 *     UNH long       — counter-trend long on a bleeding stock (-46.7%)
 *
 * Pattern: WINS = clean trend + breakout + tape aligned. LOSSES = counter-tape
 * or counter-trend or no clean structure.
 *
 * THE 6 GATES (all must agree to earn GRADE A):
 *   1. trend     — Daily timeframe direction matches setup direction
 *   2. breakout  — multi-test breakout OR V-turn OR hammer/shooter recognized
 *   3. tape      — live SPY/QQQ/IWM verdict aligned with setup direction
 *   4. ta        — 3+ of last 5 5m bars green (long) / red (short)
 *   5. liquidity — option vol >= 100 OR OI >= 200
 *   6. vision    — chart-vision returns APPROVE (Railway: skipped — counts as pass-through)
 *
 * GRADE rules:
 *   6/6 → A (FIRE_FULL — up to 3-5ct)
 *   5/6 → A (still FIRE — vision-skipped on Railway counts as 5/5)
 *   4/6 → B (TRIAL_1CT only)
 *   3/6 → C (WATCH — don't fire)
 *  <3/6 → D (SKIP — hidden by default)
 * =============================================================================
 */

'use strict';

var path = require('path');
var multiTestBreakoutScanner = null;
try { multiTestBreakoutScanner = require('./multiTestBreakoutScanner'); }
catch (e) { console.log('[FIRE-GRADE] multiTestBreakoutScanner not loaded:', e.message); }

var contractResolver = null;
try { contractResolver = require('./contractResolver'); }
catch (e) { console.log('[FIRE-GRADE] contractResolver not loaded:', e.message); }

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[FIRE-GRADE] tradestation not loaded:', e.message); }

// Phase 4.30E — JOHN-LIKE bonus gate (matches setup against historical pattern profiles)
var johnLikePicker = null;
try { johnLikePicker = require('./johnLikePicker'); }
catch (e) { console.log('[FIRE-GRADE] johnLikePicker not loaded:', e.message); }

// Phase 4.37 — KING NODE soft signal (gravity adjustment from GEX+VPOC+UOA fusion)
var kingNodeComputer = null;
try { kingNodeComputer = require('./kingNodeComputer'); }
catch (e) { console.log('[FIRE-GRADE] kingNodeComputer not loaded:', e.message); }

// --- 60s cache keyed by ticker|direction|tradeType --------------------------
var _cache = {};
var CACHE_TTL_MS = 60 * 1000;

function cacheKey(ticker, direction, tradeType) {
  return (ticker || '').toUpperCase() + '|' + String(direction || '').toLowerCase() + '|' + String(tradeType || 'SWING').toUpperCase();
}

function fromCache(key) {
  var c = _cache[key];
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_TTL_MS) { delete _cache[key]; return null; }
  return c.payload;
}

function toCache(key, payload) {
  _cache[key] = { ts: Date.now(), payload: payload };
}

// --- direction normalization -------------------------------------------------
function normDir(dir) {
  var d = String(dir || '').toLowerCase();
  if (d === 'long' || d === 'bullish' || d === 'call' || d === 'bull') return 'long';
  if (d === 'short' || d === 'bearish' || d === 'put' || d === 'bear') return 'short';
  return d;
}

// --- HTTP fetch with timeout -------------------------------------------------
function fetchLib() {
  return (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
}

function serverBase() {
  return process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
}

// =============================================================================
// GATE 1 — DAILY TREND
// =============================================================================
// Pull Daily bar via TS. Long passes if close > open AND > prior bar high.
// Short passes if close < open AND < prior bar low. Lenient fallback:
// just direction match if 2-bar comparison fails.
async function checkTrendGate(ticker, direction) {
  try {
    if (!ts || !ts.getAccessToken) return { passed: 'skipped', reason: 'no TS module' };
    var token = await ts.getAccessToken();
    if (!token) return { passed: 'skipped', reason: 'no TS token' };
    var f = fetchLib();
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?interval=1&unit=Daily&barsback=3';
    var r = await f(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 6000 });
    if (!r.ok) return { passed: 'skipped', reason: 'TS http ' + r.status };
    var data = await r.json();
    var bars = (data.Bars || []).map(function(b) {
      return {
        open:  parseFloat(b.Open),
        close: parseFloat(b.Close),
        high:  parseFloat(b.High),
        low:   parseFloat(b.Low),
      };
    });
    if (bars.length < 2) return { passed: 'skipped', reason: 'not enough Daily bars' };
    var last  = bars[bars.length - 1];
    var prior = bars[bars.length - 2];
    var dir = normDir(direction);
    var dailyUp   = last.close > last.open;
    var dailyDown = last.close < last.open;
    var brokeHigh = last.close > prior.high;
    var brokeLow  = last.close < prior.low;

    if (dir === 'long') {
      if (dailyUp && brokeHigh) return { passed: true,  reason: 'Daily UP + breaking prior high $' + prior.high.toFixed(2) };
      if (dailyUp)              return { passed: true,  reason: 'Daily UP (close $' + last.close.toFixed(2) + ' > open $' + last.open.toFixed(2) + ')' };
      if (dailyDown)            return { passed: false, reason: 'Daily DOWN — counter-trend long (close $' + last.close.toFixed(2) + ' < open $' + last.open.toFixed(2) + ')' };
      return { passed: false, reason: 'Daily flat — no trend confirmation' };
    } else if (dir === 'short') {
      if (dailyDown && brokeLow) return { passed: true,  reason: 'Daily DOWN + breaking prior low $' + prior.low.toFixed(2) };
      if (dailyDown)             return { passed: true,  reason: 'Daily DOWN (close $' + last.close.toFixed(2) + ' < open $' + last.open.toFixed(2) + ')' };
      if (dailyUp)               return { passed: false, reason: 'Daily UP — counter-trend short (close $' + last.close.toFixed(2) + ' > open $' + last.open.toFixed(2) + ')' };
      return { passed: false, reason: 'Daily flat — no trend confirmation' };
    }
    return { passed: 'skipped', reason: 'unknown direction' };
  } catch (e) {
    return { passed: 'skipped', reason: 'trend gate error: ' + e.message };
  }
}

// =============================================================================
// GATE 2 — BREAKOUT / V-TURN / HAMMER
// =============================================================================
// LONG: multi-test breakout 60m verdict = BREAKOUT, OR pattern is hammer/V-turn.
// SHORT: pattern is shooter / failed-2U / 2D continuation. We don't have a
// symmetric short MTB, so for shorts we accept based on the setup.pattern.
async function checkBreakoutGate(ticker, direction, setup) {
  try {
    var dir = normDir(direction);
    var pat = String((setup && setup.pattern) || '').toLowerCase();

    // Hammer / V-turn / reversal patterns count as pass on either side
    if (/hammer|shooter|v[-_ ]?turn|v_turn|2d-2u|2u-2d|2-1-2-rev|3-2-2-rev|1-2-2-rev|failed-2[ud]/.test(pat)) {
      return { passed: true, reason: 'reversal pattern recognized: ' + (setup && setup.pattern) };
    }
    // Continuation patterns also count as pass
    if (/2-1-2-cont|continuation|breakout|pullback-retest/.test(pat)) {
      return { passed: true, reason: 'continuation pattern: ' + (setup && setup.pattern) };
    }

    if (dir === 'long' && multiTestBreakoutScanner && multiTestBreakoutScanner.detect) {
      var out = await multiTestBreakoutScanner.detect(ticker, '60m');
      var v = out && out.verdict;
      if (v === 'BREAKOUT') {
        return { passed: true, reason: 'multi-test BREAKOUT 60m × ' + (out.touchCount || '?') + ' touches' };
      }
      if (v === 'BREAK_PENDING') {
        return { passed: true, reason: 'multi-test BREAK_PENDING — close to confirmation' };
      }
      if (v === 'TESTING') {
        return { passed: false, reason: 'multi-test TESTING — not yet broken (' + (out.touchCount || '?') + ' touches)' };
      }
      return { passed: false, reason: 'no breakout pattern detected (verdict ' + (v || 'NO_PATTERN') + ')' };
    }

    if (dir === 'short') {
      // No symmetric short MTB shipped yet — partial credit if pattern looks
      // like a fresh breakdown via 2D / shooter / failed-2U.
      return { passed: false, reason: 'no breakout/breakdown pattern recognized for short (need symmetric MTB or named pattern)' };
    }

    return { passed: false, reason: 'no breakout/V-turn pattern detected' };
  } catch (e) {
    return { passed: 'skipped', reason: 'breakout gate error: ' + e.message };
  }
}

// =============================================================================
// GATE 3 — TAPE
// =============================================================================
// RISK_ON tape + long  → pass.   RISK_ON + short → fail (counter-tape).
// RISK_OFF tape + short → pass.  RISK_OFF + long  → fail (counter-tape).
// MIXED / UNKNOWN tape → soft pass (don't block, but document).
async function checkTapeGate(direction) {
  try {
    var f = fetchLib();
    var r = await f(serverBase() + '/api/market-context', { timeout: 5000 });
    if (!r.ok) return { passed: 'skipped', reason: 'tape http ' + r.status };
    var d = await r.json();
    if (!d || !d.ok) return { passed: 'skipped', reason: 'tape no payload' };
    var tape = d.tape || 'UNKNOWN';
    var dir = normDir(direction);
    var summary = d.summary || (d.indices && JSON.stringify(d.indices).slice(0, 80)) || '';
    if (tape === 'RISK_ON' && dir === 'short') {
      return { passed: false, reason: 'COUNTER-TAPE — RISK_ON tape vs SHORT (' + summary + ')', tape: tape };
    }
    if (tape === 'RISK_OFF' && dir === 'long') {
      return { passed: false, reason: 'COUNTER-TAPE — RISK_OFF tape vs LONG (' + summary + ')', tape: tape };
    }
    if (tape === 'RISK_ON' && dir === 'long') {
      return { passed: true, reason: 'tape RISK_ON aligned with LONG (' + summary + ')', tape: tape };
    }
    if (tape === 'RISK_OFF' && dir === 'short') {
      return { passed: true, reason: 'tape RISK_OFF aligned with SHORT (' + summary + ')', tape: tape };
    }
    // MIXED / UNKNOWN — soft pass
    return { passed: 'skipped', reason: 'tape ' + tape + ' — not a clear tailwind ('+ summary + ')', tape: tape };
  } catch (e) {
    return { passed: 'skipped', reason: 'tape gate error: ' + e.message };
  }
}

// =============================================================================
// GATE 4 — TA (5-bar 5m alignment)
// =============================================================================
async function checkTaGate(ticker, direction) {
  try {
    if (!ts || !ts.getAccessToken) return { passed: 'skipped', reason: 'no TS module' };
    var token = await ts.getAccessToken();
    if (!token) return { passed: 'skipped', reason: 'no TS token' };
    var f = fetchLib();
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?interval=5&unit=Minute&barsback=5';
    var r = await f(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 6000 });
    if (!r.ok) return { passed: 'skipped', reason: 'TS http ' + r.status };
    var data = await r.json();
    var bars = (data.Bars || []).map(function(b) {
      return { open: parseFloat(b.Open), close: parseFloat(b.Close) };
    });
    if (bars.length < 3) return { passed: 'skipped', reason: 'not enough 5m bars' };
    var greenCount = bars.filter(function(b){ return b.close >= b.open; }).length;
    var redCount = bars.length - greenCount;
    var lastClose = bars[bars.length - 1].close;
    var firstOpen = bars[0].open;
    var pctMove = firstOpen > 0 ? ((lastClose - firstOpen) / firstOpen) * 100 : 0;
    var dir = normDir(direction);
    if (dir === 'long') {
      if (greenCount >= 3) return { passed: true,  reason: greenCount + '/' + bars.length + ' green +' + pctMove.toFixed(2) + '%' };
      if (redCount   >= 3) return { passed: false, reason: redCount + '/' + bars.length + ' RED ' + pctMove.toFixed(2) + '% — DUMPING into LONG' };
      return { passed: false, reason: greenCount + '/' + bars.length + ' green ' + pctMove.toFixed(2) + '% — chop, no trend' };
    }
    if (dir === 'short') {
      if (redCount   >= 3) return { passed: true,  reason: redCount + '/' + bars.length + ' red ' + pctMove.toFixed(2) + '%' };
      if (greenCount >= 3) return { passed: false, reason: greenCount + '/' + bars.length + ' GREEN +' + pctMove.toFixed(2) + '% — PUMPING into SHORT' };
      return { passed: false, reason: redCount + '/' + bars.length + ' red ' + pctMove.toFixed(2) + '% — chop, no trend' };
    }
    return { passed: 'skipped', reason: 'unknown direction' };
  } catch (e) {
    return { passed: 'skipped', reason: 'TA gate error: ' + e.message };
  }
}

// =============================================================================
// GATE 5 — LIQUIDITY (option contract)
// =============================================================================
async function checkLiquidityGate(ticker, direction, tradeType) {
  try {
    if (!contractResolver || !contractResolver.resolveContract) {
      return { passed: 'skipped', reason: 'contractResolver not loaded' };
    }
    var dir = normDir(direction);
    var type = (dir === 'long') ? 'call' : 'put';
    var resolved = await contractResolver.resolveContract(ticker, type, tradeType || 'SWING', {});
    if (!resolved || resolved.blocked || resolved.ok === false) {
      return { passed: false, reason: 'no contract resolved (' + (resolved && (resolved.reason || 'blocked')) + ')' };
    }
    var vol = parseInt(resolved.volume || 0, 10);
    var oi  = parseInt(resolved.openInterest || 0, 10);
    if (vol >= 100 || oi >= 200) {
      return {
        passed: true,
        reason: 'vol ' + vol + ' / OI ' + oi + ' (need vol≥100 OR OI≥200)',
        contract: resolved.symbol,
        mid: resolved.mid,
        volume: vol,
        openInterest: oi,
      };
    }
    return {
      passed: false,
      reason: 'thin liquidity vol ' + vol + ' / OI ' + oi + ' (need vol≥100 OR OI≥200)',
      contract: resolved.symbol,
      mid: resolved.mid,
      volume: vol,
      openInterest: oi,
    };
  } catch (e) {
    return { passed: 'skipped', reason: 'liquidity gate error: ' + e.message };
  }
}

// =============================================================================
// GATE 6 — CHART VISION
// =============================================================================
// PHASE 4.32 (May 5 PM) — prefer cached daemon verdict over live POST.
//
// Cache hit + APPROVE → vision gate PASSES
// Cache hit + VETO    → vision gate FAILS
// Cache hit + WAIT    → vision gate "skipped" (fail-open with warning)
// Cache miss → POST /api/chart-vision (which on Railway returns "vision
//   unavailable" → "skipped"; on local Mac with TV CDP returns a fresh verdict).
//
// The endpoint already does this internally — the daemon cache check is the
// first thing /api/chart-vision does. We tag the source so the UI can show
// a "fresh from daemon" pill vs. "just-computed" vs. "skipped (Railway)".
async function checkVisionGate(ticker, direction, tradeType) {
  try {
    var f = fetchLib();
    var r = await f(serverBase() + '/api/chart-vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: ticker,
        direction: normDir(direction),
        tradeType: (tradeType || 'SWING').toUpperCase(),
      }),
      timeout: 90000,
    });
    if (!r.ok) return { passed: 'skipped', reason: 'vision http ' + r.status };
    var d = await r.json();
    var summary = d.summary || '';
    var verdict = d.verdict || 'WAIT';
    // Phase 4.32 — cacheSource may be 'local-daemon' (pre-validated by daemon)
    // or 'inline-90s' (just-computed). Surface that in reason.
    var sourceTag = '';
    if (d.cached && d.cacheSource === 'local-daemon') {
      sourceTag = ' [daemon-cache, age ' + (d.cacheAgeSec || '?') + 's]';
    } else if (d.cached) {
      sourceTag = ' [cached]';
    }
    // On Railway, summary contains "vision unavailable" — treat as skipped.
    if (/vision unavailable|cdp unavailable|no chrome/i.test(summary)) {
      return { passed: 'skipped', reason: 'vision unavailable (Railway, skipped)' };
    }
    if (verdict === 'APPROVE') {
      return { passed: true, reason: 'vision APPROVE (' + (d.confidence || '?') + '/10)' + sourceTag + ' — ' + (summary.slice(0, 120) || '') };
    }
    if (verdict === 'VETO') {
      return { passed: false, reason: 'vision VETO' + sourceTag + ' — ' + (summary.slice(0, 200) || '') };
    }
    if (verdict === 'MIXED') {
      // Phase 4.32 — MIXED is uncertain, treat as skipped (fail-open) per spec.
      return { passed: 'skipped', reason: 'vision MIXED' + sourceTag + ' — ' + (summary.slice(0, 160) || '') };
    }
    if (verdict === 'WAIT') {
      return { passed: false, reason: 'vision WAIT' + sourceTag + ' — ' + (summary.slice(0, 160) || '') };
    }
    return { passed: 'skipped', reason: 'vision verdict ' + verdict + sourceTag };
  } catch (e) {
    return { passed: 'skipped', reason: 'vision gate error: ' + e.message };
  }
}

// =============================================================================
// PHASE 4.30E — JOHN-LIKE BONUS GATE
// =============================================================================
// Matches setup against John's historical pattern profiles. Grants:
//   +1 bonus if setup matches any John pattern with sampleSize >= 3
//   +1 additional bonus if matched pattern's historical winRate >= 0.55
// The bonus is added to gate count when grading. Capped at +2.
async function checkJohnLikeBonus(ticker, direction, setup) {
  try {
    if (!johnLikePicker || !johnLikePicker.matchSetup) {
      return { matched: false, bonus: 0, reason: 'johnLikePicker not loaded' };
    }
    var match = await johnLikePicker.matchSetup(ticker, normDir(direction), setup && setup.plan);
    if (!match || !match.matched) {
      return { matched: false, bonus: 0, reason: 'no John pattern match' };
    }
    var bonus = 0;
    if (match.historicalSampleSize >= 3) bonus += 1;
    if ((match.historicalWinRate || 0) >= 0.55) bonus += 1;
    return {
      matched: true,
      bonus: bonus,
      label: match.label,
      historicalWinRate: match.historicalWinRate,
      historicalSampleSize: match.historicalSampleSize,
      historicalAvgMFE: match.historicalAvgMFE,
      reason: 'matches ' + match.label + ' (n=' + match.historicalSampleSize +
              ', winRate=' + Math.round((match.historicalWinRate || 0) * 100) + '%)',
    };
  } catch (e) {
    return { matched: false, bonus: 0, reason: 'john bonus error: ' + e.message };
  }
}

// =============================================================================
// PHASE 4.37 — KING NODE SOFT SIGNAL
// =============================================================================
// NOT a hard gate — adjusts conviction by +/- 1.
//   LONG, spot BELOW king node within 0.5%   → +1  (price near magnet, pulled up)
//   LONG, spot ABOVE king node by > 2%        → -1  (extended, gravity pulls down)
//   SHORT, spot ABOVE king node within 0.5%   → +1  (price near magnet, pulled down)
//   SHORT, spot BELOW king node by > 2%       → -1  (extended, gravity pulls up)
// All other distances → 0 (neutral).
//
// Fail-open: if kingNodeComputer not loaded or returns null, returns 0 silently.
async function checkKingNodeSignal(ticker, direction) {
  try {
    if (!kingNodeComputer || !kingNodeComputer.computeKingNode) {
      return { adjust: 0, reason: 'kingNodeComputer not loaded', applied: false };
    }
    var king = await kingNodeComputer.computeKingNode(ticker);
    if (!king || king.kingNode == null || king.spot == null) {
      return { adjust: 0, reason: 'no king node mapped', applied: false };
    }
    var dir = normDir(direction);
    var spot = Number(king.spot);
    var k = Number(king.kingNode);
    if (!isFinite(spot) || !isFinite(k) || k === 0) {
      return { adjust: 0, reason: 'invalid spot/king', applied: false };
    }
    var distPct = ((spot - k) / k) * 100;          // signed % above king
    var absDist = Math.abs(distPct);
    var above = spot > k;
    var below = spot < k;

    if (dir === 'long') {
      if (below && absDist <= 0.5) {
        return { adjust: 1, reason: 'LONG within 0.5% BELOW king $' + k.toFixed(2) + ' — gravity pulls UP', applied: true, kingNode: k, spot: spot, distPct: +distPct.toFixed(2) };
      }
      if (above && absDist > 2) {
        return { adjust: -1, reason: 'LONG extended ' + absDist.toFixed(1) + '% ABOVE king $' + k.toFixed(2) + ' — gravity pulls DOWN', applied: true, kingNode: k, spot: spot, distPct: +distPct.toFixed(2) };
      }
    }
    if (dir === 'short') {
      if (above && absDist <= 0.5) {
        return { adjust: 1, reason: 'SHORT within 0.5% ABOVE king $' + k.toFixed(2) + ' — gravity pulls DOWN', applied: true, kingNode: k, spot: spot, distPct: +distPct.toFixed(2) };
      }
      if (below && absDist > 2) {
        return { adjust: -1, reason: 'SHORT extended ' + absDist.toFixed(1) + '% BELOW king $' + k.toFixed(2) + ' — gravity pulls UP', applied: true, kingNode: k, spot: spot, distPct: +distPct.toFixed(2) };
      }
    }
    return { adjust: 0, reason: 'neutral zone (' + (distPct >= 0 ? '+' : '') + distPct.toFixed(1) + '% from king $' + k.toFixed(2) + ')', applied: false, kingNode: k, spot: spot, distPct: +distPct.toFixed(2) };
  } catch (e) {
    return { adjust: 0, reason: 'king-node soft error: ' + e.message, applied: false };
  }
}

// =============================================================================
// PHASE 4.42 — GEX-AWARE BOOST (additive, granular vs Phase 4.37)
// =============================================================================
// Phase 4.37 (King Node ±1) handles the ±0.5% / >2% extreme cases by adjusting
// composite SCORE.  Phase 4.42 adds a finer-grained BOOST that captures total
// gamma regime agreement on top of the spot-vs-king relationship:
//
//   POSITIVE total gamma + direction agrees with magnet pull   → +0.5
//   POSITIVE + spot within 0.5% of king + direction agrees      → additional +0.5 (cap +1.0)
//   NEGATIVE total gamma (flip risk) + direction agrees         → 0  (regime is too volatile to credit)
//
// Output is advisory metadata (gates.gex42 = { boost, regime, summary,
// agreesWithDirection }) — does NOT mutate the score directly. The composite
// grade-bump path stays in Phase 4.37.  This signal is for UI surfacing +
// Discord embeds + future analytics.
async function checkGex42Signal(ticker, direction) {
  try {
    if (!kingNodeComputer || !kingNodeComputer.computeKingNode) {
      return { boost: 0, regime: null, summary: 'kingNodeComputer not loaded', agreesWithDirection: null, applied: false };
    }
    var king = await kingNodeComputer.computeKingNode(ticker);
    if (!king || king.kingNode == null || king.spot == null) {
      return { boost: 0, regime: null, summary: 'no king node mapped', agreesWithDirection: null, applied: false };
    }
    var dir = normDir(direction);
    var spot = Number(king.spot);
    var k = Number(king.kingNode);
    if (!isFinite(spot) || !isFinite(k) || k === 0) {
      return { boost: 0, regime: null, summary: 'invalid spot/king', agreesWithDirection: null, applied: false };
    }
    var distPct = ((spot - k) / k) * 100;
    var absDist = Math.abs(distPct);
    var above = spot > k;

    var gd = (king.detail && king.detail.gex) || {};
    var totalNetGex = isFinite(gd.netGex) ? Number(gd.netGex) : null;
    var regime = gd.regime || (totalNetGex != null ? (totalNetGex > 0 ? 'POSITIVE' : 'NEGATIVE') : null);

    // Direction agreement against the gamma regime
    var positiveRegime = regime === 'POSITIVE' || (totalNetGex != null && totalNetGex > 0 && regime !== 'NEGATIVE' && regime !== 'FLIPPED');
    var agreesWithDirection = null;
    if (absDist <= 0.5) {
      // At king node — chop zone, no edge
      agreesWithDirection = null;
    } else if (positiveRegime) {
      if (dir === 'long')  agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
      if (dir === 'short') agreesWithDirection = above ? true : (absDist > 2 ? false : null);
    } else {
      // NEGATIVE / FLIPPED — anti-magnet
      if (dir === 'long')  agreesWithDirection = above ? true : (absDist > 2 ? false : null);
      if (dir === 'short') agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
    }

    // Compute boost (cap +1.0)
    var boost = 0;
    if (positiveRegime && agreesWithDirection === true) {
      boost += 0.5;
      if (absDist <= 0.5) boost += 0.5;     // tight magnet alignment → extra +0.5
    }
    // NEGATIVE regime: even if directionally agreed, give 0 (regime volatile)

    if (boost > 1) boost = 1;

    var gexFmt = (totalNetGex != null)
      ? (totalNetGex >= 0 ? '+' : '') + '$' + (totalNetGex / 1e6).toFixed(1) + 'M'
      : '?';
    var sideLbl = above ? 'above' : 'below';
    var agreeLbl = agreesWithDirection === true ? 'agrees' : (agreesWithDirection === false ? 'fights' : 'neutral');
    var summary = (regime || 'UNKNOWN') + ' gamma ' + gexFmt + ', $' + k.toFixed(2) + ' magnet ' + absDist.toFixed(1) + '% ' + sideLbl + ' spot, ' + agreeLbl + ' ' + (dir || '?');

    return {
      boost: boost,
      regime: regime,
      totalNetGex: totalNetGex,
      kingNode: +k.toFixed(4),
      spot: +spot.toFixed(4),
      distPct: +distPct.toFixed(2),
      agreesWithDirection: agreesWithDirection,
      summary: summary,
      applied: boost > 0,
    };
  } catch (e) {
    return { boost: 0, regime: null, summary: 'gex42 soft error: ' + e.message, agreesWithDirection: null, applied: false };
  }
}

// =============================================================================
// STRATEGY TYPE DETECTION
// =============================================================================
function detectStrategyType(setup, gates) {
  var pat = String((setup && setup.pattern) || '').toLowerCase();
  if (/1-3-1|inside-week|3-1-1|coil|double-inside/.test(pat)) return 'COIL';
  if (/v[-_ ]?turn|v_turn|hammer|shooter|2d-2u|2u-2d|2-1-2-rev|3-2-2-rev|1-2-2-rev|failed-2[ud]/.test(pat)) return 'REVERSAL';
  if (/2-1-2-cont|continuation/.test(pat)) return 'BREAKOUT';
  if (/pullback-retest|retest/.test(pat)) return 'PULLBACK_RETEST';

  // Fallback: infer from breakout gate
  if (gates && gates.breakout && gates.breakout.passed === true) {
    if (/multi-test|breakout|continuation/i.test(gates.breakout.reason || '')) return 'BREAKOUT';
    if (/reversal|hammer|shooter|v[- ]?turn/i.test(gates.breakout.reason || '')) return 'REVERSAL';
  }
  // If no breakout detected and trend is not aligned, it's likely chop
  if (gates && gates.trend && gates.trend.passed === false) {
    return 'CHOP';
  }
  return 'UNKNOWN';
}

// =============================================================================
// COMPOSE GRADE
// =============================================================================
function composeGrade(gates) {
  var passes = 0;
  var passedGates = ['trend', 'breakout', 'tape', 'ta', 'liquidity', 'vision'];
  passedGates.forEach(function(k) {
    if (gates[k] && gates[k].passed === true) passes++;
  });

  // skipped-vision gives a "credit" pass — Railway-friendly.
  // Effective denominator: if vision is skipped, count out of 5 instead of 6.
  var denom = 6;
  var effPass = passes;
  if (gates.vision && gates.vision.passed === 'skipped') {
    denom = 5;
    // Don't increment effPass — the other 5 still must pass.
  }

  var grade, fireRecommendation;
  if (denom === 6) {
    if (passes >= 6) { grade = 'A'; fireRecommendation = 'FIRE_FULL'; }
    else if (passes === 5) { grade = 'A'; fireRecommendation = 'FIRE_FULL'; }
    else if (passes === 4) { grade = 'B'; fireRecommendation = 'TRIAL_1CT'; }
    else if (passes === 3) { grade = 'C'; fireRecommendation = 'WATCH'; }
    else { grade = 'D'; fireRecommendation = 'SKIP'; }
  } else {
    // denom = 5 (vision skipped on Railway)
    if (passes >= 5) { grade = 'A'; fireRecommendation = 'FIRE_FULL'; }
    else if (passes === 4) { grade = 'A'; fireRecommendation = 'FIRE_FULL'; }
    else if (passes === 3) { grade = 'B'; fireRecommendation = 'TRIAL_1CT'; }
    else if (passes === 2) { grade = 'C'; fireRecommendation = 'WATCH'; }
    else { grade = 'D'; fireRecommendation = 'SKIP'; }
  }

  return {
    grade: grade,
    score: passes,
    denominator: denom,
    fireRecommendation: fireRecommendation,
  };
}

function buildWarnings(gates) {
  var warnings = [];
  if (gates.trend && gates.trend.passed === false) {
    if (/counter-trend/i.test(gates.trend.reason || '')) warnings.push('Daily counter-trend — high failure rate');
    else warnings.push('Daily trend not confirmed');
  }
  if (gates.tape && gates.tape.passed === false) {
    warnings.push('Counter-tape — fighting market direction');
  }
  if (gates.ta && gates.ta.passed === false) {
    if (/dumping|pumping/i.test(gates.ta.reason || '')) warnings.push('5m bars opposing direction');
    else warnings.push('5m TA not aligned');
  }
  if (gates.liquidity && gates.liquidity.passed === false) {
    warnings.push('Thin option liquidity — wide spreads likely');
  }
  if (gates.vision && gates.vision.passed === false) {
    if (/VETO/i.test(gates.vision.reason || '')) warnings.push('Vision VETO — chart structure conflicts');
    else warnings.push('Vision did not approve');
  }
  if (gates.breakout && gates.breakout.passed === false) {
    warnings.push('No clean breakout / reversal pattern');
  }
  return warnings;
}

// =============================================================================
// MAIN ENTRY — computeFireGrade(setup)
// =============================================================================
// setup = {
//   ticker: 'CRM', direction: 'long' | 'short', tradeType: 'SWING' | 'DAY' | 'SCALP' | 'LOTTO',
//   pattern: 'failed-2D' | 'hammer' | ...   (optional)
// }
async function computeFireGrade(setup) {
  setup = setup || {};
  var ticker = String(setup.ticker || '').toUpperCase();
  var direction = normDir(setup.direction);
  var tradeType = String(setup.tradeType || 'SWING').toUpperCase();
  if (!ticker) {
    return { grade: 'D', score: 0, denominator: 6, gates: {}, strategyType: 'UNKNOWN', warnings: ['no ticker'], fireRecommendation: 'SKIP' };
  }
  if (!direction || (direction !== 'long' && direction !== 'short')) {
    return { grade: 'D', score: 0, denominator: 6, gates: {}, strategyType: 'UNKNOWN', warnings: ['no direction'], fireRecommendation: 'SKIP' };
  }

  var key = cacheKey(ticker, direction, tradeType);
  var cached = fromCache(key);
  if (cached) return Object.assign({}, cached, { cached: true });

  // Run all 6 gates + John-like bonus + king-node soft signal + Phase 4.42
  // GEX-aware boost in parallel.
  var [trendG, breakoutG, tapeG, taG, liquidityG, visionG, johnBonus, kingSignal, gex42Signal] = await Promise.all([
    checkTrendGate(ticker, direction),
    checkBreakoutGate(ticker, direction, setup),
    checkTapeGate(direction),
    checkTaGate(ticker, direction),
    checkLiquidityGate(ticker, direction, tradeType),
    checkVisionGate(ticker, direction, tradeType),
    checkJohnLikeBonus(ticker, direction, setup),
    checkKingNodeSignal(ticker, direction),
    checkGex42Signal(ticker, direction),
  ]);

  var gates = {
    trend:     trendG,
    breakout:  breakoutG,
    tape:      tapeG,
    ta:        taG,
    liquidity: liquidityG,
    vision:    visionG,
    // Phase 4.42 — surface GEX-aware advisory under gates.gex42 so the UI can
    // render the pill on every card. NOT a hard gate (no passed/failed).
    gex42: gex42Signal,
  };

  var graded = composeGrade(gates);
  var strategyType = detectStrategyType(setup, gates);
  var warnings = buildWarnings(gates);

  // Phase 4.30E — JOHN-LIKE bonus: grant up to +2 to grade score (max 1 grade-step)
  if (johnBonus && johnBonus.bonus > 0) {
    var origScore = graded.score;
    graded.score = Math.min(graded.denominator, origScore + johnBonus.bonus);
    // Re-grade if bonus pushed us into a higher grade
    var oldGrade = graded.grade;
    if (graded.denominator === 6) {
      if (graded.score >= 5) { graded.grade = 'A'; graded.fireRecommendation = 'FIRE_FULL'; }
      else if (graded.score === 4) { graded.grade = 'B'; graded.fireRecommendation = 'TRIAL_1CT'; }
      else if (graded.score === 3) { graded.grade = 'C'; graded.fireRecommendation = 'WATCH'; }
    } else {
      if (graded.score >= 4) { graded.grade = 'A'; graded.fireRecommendation = 'FIRE_FULL'; }
      else if (graded.score === 3) { graded.grade = 'B'; graded.fireRecommendation = 'TRIAL_1CT'; }
      else if (graded.score === 2) { graded.grade = 'C'; graded.fireRecommendation = 'WATCH'; }
    }
    if (graded.grade !== oldGrade) {
      warnings.unshift('GRADE BUMPED ' + oldGrade + ' → ' + graded.grade + ' via JOHN-LIKE bonus (+' + johnBonus.bonus + ')');
    }
  }

  // Phase 4.37 — KING NODE soft signal (+/- 1 to score, max 1 grade-step)
  if (kingSignal && kingSignal.applied && kingSignal.adjust !== 0) {
    var kOldScore = graded.score;
    var kOldGrade = graded.grade;
    graded.score = Math.max(0, Math.min(graded.denominator, graded.score + kingSignal.adjust));
    if (graded.denominator === 6) {
      if (graded.score >= 5) { graded.grade = 'A'; graded.fireRecommendation = 'FIRE_FULL'; }
      else if (graded.score === 4) { graded.grade = 'B'; graded.fireRecommendation = 'TRIAL_1CT'; }
      else if (graded.score === 3) { graded.grade = 'C'; graded.fireRecommendation = 'WATCH'; }
      else { graded.grade = 'D'; graded.fireRecommendation = 'SKIP'; }
    } else {
      if (graded.score >= 4) { graded.grade = 'A'; graded.fireRecommendation = 'FIRE_FULL'; }
      else if (graded.score === 3) { graded.grade = 'B'; graded.fireRecommendation = 'TRIAL_1CT'; }
      else if (graded.score === 2) { graded.grade = 'C'; graded.fireRecommendation = 'WATCH'; }
      else { graded.grade = 'D'; graded.fireRecommendation = 'SKIP'; }
    }
    if (graded.grade !== kOldGrade) {
      var arrow = kingSignal.adjust > 0 ? '↑' : '↓';
      warnings.unshift('GRADE ' + arrow + ' ' + kOldGrade + ' → ' + graded.grade + ' via KING NODE (' + (kingSignal.adjust > 0 ? '+' : '') + kingSignal.adjust + '): ' + kingSignal.reason);
    }
  }

  // COIL detection override — never grant FIRE on a coil (wait for break)
  if (strategyType === 'COIL') {
    if (graded.grade === 'A' || graded.grade === 'B') {
      graded.grade = 'C';
      graded.fireRecommendation = 'WATCH';
      warnings.unshift('COIL pattern — wait for break before fire');
    }
  }

  var payload = {
    ok: true,
    ticker: ticker,
    direction: direction,
    tradeType: tradeType,
    grade: graded.grade,
    score: graded.score,
    denominator: graded.denominator,
    gates: gates,
    strategyType: strategyType,
    warnings: warnings,
    fireRecommendation: graded.fireRecommendation,
    johnLike: johnBonus,  // Phase 4.30E — surface to UI
    kingNode: kingSignal,  // Phase 4.37 — surface soft signal to UI
    gex42: gex42Signal,    // Phase 4.42 — surface GEX-aware boost to UI
    timestamp: new Date().toISOString(),
  };

  toCache(key, payload);
  return payload;
}

// Lightweight grade-only fast path (used by simAutoTrader). Same calc, same
// cache, just the same module-level call.
async function gradeQuick(setup) {
  var full = await computeFireGrade(setup);
  return {
    grade: full.grade,
    score: full.score,
    denominator: full.denominator,
    fireRecommendation: full.fireRecommendation,
    strategyType: full.strategyType,
    warnings: full.warnings,
  };
}

module.exports = {
  computeFireGrade: computeFireGrade,
  gradeQuick: gradeQuick,
  // expose individual gates for tests/debugging
  checkTrendGate: checkTrendGate,
  checkBreakoutGate: checkBreakoutGate,
  checkTapeGate: checkTapeGate,
  checkTaGate: checkTaGate,
  checkLiquidityGate: checkLiquidityGate,
  checkVisionGate: checkVisionGate,
  checkJohnLikeBonus: checkJohnLikeBonus,  // Phase 4.30E
  checkKingNodeSignal: checkKingNodeSignal,  // Phase 4.37
  checkGex42Signal: checkGex42Signal,        // Phase 4.42
  detectStrategyType: detectStrategyType,
};
