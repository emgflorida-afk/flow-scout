// =============================================================================
// bullflowApi.js — Bullflow REST wrapper + A+ scorer (Phase 4.49)
// =============================================================================
// AB extracted the Bullflow Agent rubric into a 6-criteria A+ score. This
// module wraps the 5 endpoints we lean on and exposes scoreAPlus() that
// returns 0-6 + per-criterion breakdown.
//
// AB cancelled $129/mo subscription Apr 28 2026, but BULLFLOW_API_KEY may
// still be set on Railway for older snapshots. If absent, every wrapper
// returns { ok: false, error: 'no api key' } so callers degrade cleanly.
//
// 6 A+ criteria (order = weight in narrative):
//   c1: ≥1 unusual trade with premium ≥ $150K in last 60 min
//   c2: ≥1 sweep/multi-exchange trade in last 60 min
//   c3: ≥3 nearby strikes hit (within ±5% of each other)
//   c4: ≥2 unusual trades total in last 60 min (sustained interest)
//   c5: ≥70% of trades hit at-or-above ask (aggressive)
//   c6: avg sigScore ≥0.7 across last-60-min trades
// =============================================================================

'use strict';

var fetch = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

var BASE = 'https://api.bullflow.io/v1';

function key() {
  return process.env.BULLFLOW_API_KEY || null;
}

function haveKey() { return !!key(); }

function authQs(extra) {
  var qs = 'key=' + encodeURIComponent(key());
  if (extra) {
    Object.keys(extra).forEach(function(k) {
      var v = extra[k];
      if (v != null) qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(v));
    });
  }
  return qs;
}

async function get(path, params) {
  if (!haveKey()) return { ok: false, error: 'no BULLFLOW_API_KEY' };
  try {
    var url = BASE + path + '?' + authQs(params);
    var r = await fetch(url, { timeout: 12000 });
    var bodyText = await r.text();
    var parsed = null; try { parsed = JSON.parse(bodyText); } catch (e) {}
    if (!r.ok) return { ok: false, error: 'http ' + r.status, body: parsed || bodyText.slice(0, 400) };
    return { ok: true, data: parsed != null ? parsed : bodyText };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------------------------------------------------------
// 5 wrappers
// ----------------------------------------------------------------------------
async function getTickerSpread(ticker) {
  return get('/data/spread', { ticker: String(ticker || '').toUpperCase() });
}

async function getDarkPool(ticker) {
  return get('/data/darkPool', { ticker: String(ticker || '').toUpperCase() });
}

async function getInsiderTrades(ticker) {
  return get('/data/insiders', { ticker: String(ticker || '').toUpperCase() });
}

async function getNews(ticker, limit) {
  return get('/data/news', { ticker: String(ticker || '').toUpperCase(), limit: limit || 10 });
}

async function getUnusualTrades(ticker, sinceUnixMs) {
  // Bullflow expects unix-seconds; if not provided, default to last 24 hr
  var since = sinceUnixMs ? Math.floor(sinceUnixMs / 1000) : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  return get('/data/unusual', { ticker: String(ticker || '').toUpperCase(), since: since, limit: 200 });
}

// ----------------------------------------------------------------------------
// A+ SCORER — operates on an array of unusual-trade objects.
// Each trade is expected to have:
//   { ticker, premium, tradePrice, currentAsk, currentBid, tradeType,
//     strike, sigScore, unixTimestamp }
// Missing fields are treated conservatively (do-not-credit).
// ----------------------------------------------------------------------------
function countNearbyStrikes(trades) {
  // "Nearby" = strikes within ±5% of each other. Returns the largest cluster
  // size. e.g. NVDA $190 / $195 / $200 = 3 nearby; NVDA $50 / $200 = 1 nearby.
  if (!Array.isArray(trades) || trades.length === 0) return 0;
  var strikes = trades.map(function(t) { return Number(t.strike); }).filter(function(s) { return isFinite(s) && s > 0; });
  if (strikes.length === 0) return 0;
  var best = 1;
  for (var i = 0; i < strikes.length; i++) {
    var anchor = strikes[i];
    var n = 0;
    for (var j = 0; j < strikes.length; j++) {
      if (Math.abs(strikes[j] - anchor) / anchor <= 0.05) n++;
    }
    if (n > best) best = n;
  }
  return best;
}

function scoreAPlus(unusualTrades, opts) {
  opts = opts || {};
  var windowMs = opts.windowMs || 60 * 60 * 1000;        // last 1hr default
  var minPremium = opts.minPremium || 150000;             // c1
  var minTotal = opts.minTotal || 2;                      // c4
  var aggressivePct = opts.aggressivePct || 0.7;          // c5
  var avgSigMin = opts.avgSigMin || 0.7;                  // c6

  var nowMs = Date.now();
  var trades = (unusualTrades || []).filter(function(t) {
    var ts = t && t.unixTimestamp;
    if (!ts) return false;
    // accept seconds or ms
    var tms = ts > 1e12 ? ts : ts * 1000;
    return (nowMs - tms) <= windowMs;
  });

  if (trades.length === 0) {
    return {
      score: 0,
      breakdown: {
        c1_premium_150k: false, c2_sweep_multi: false, c3_strike_cluster: false,
        c4_count_2plus: false, c5_aggressive_70pct: false, c6_sigscore_avg_70: false,
      },
      meta: { tradesInWindow: 0, windowMin: Math.round(windowMs / 60000) },
    };
  }

  // c1
  var c1 = trades.some(function(t) { return Number(t.premium) >= minPremium; });
  // c2
  var c2 = trades.some(function(t) {
    var typ = String(t.tradeType || t.type || '').toLowerCase();
    return /sweep|multi/.test(typ);
  });
  // c3
  var c3 = countNearbyStrikes(trades) >= 3;
  // c4
  var c4 = trades.length >= minTotal;
  // c5
  var aggressive = trades.filter(function(t) {
    var px = Number(t.tradePrice); var ask = Number(t.currentAsk);
    if (!isFinite(px) || !isFinite(ask) || ask <= 0) return false;
    return px >= ask;
  }).length;
  var c5 = (aggressive / trades.length) >= aggressivePct;
  // c6
  var sigSum = 0, sigN = 0;
  trades.forEach(function(t) {
    var s = Number(t.sigScore);
    if (isFinite(s)) { sigSum += s; sigN++; }
  });
  var avgSig = sigN > 0 ? sigSum / sigN : 0;
  var c6 = avgSig >= avgSigMin;

  var score = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0) + (c5 ? 1 : 0) + (c6 ? 1 : 0);

  return {
    score: score,
    breakdown: {
      c1_premium_150k: c1,
      c2_sweep_multi: c2,
      c3_strike_cluster: c3,
      c4_count_2plus: c4,
      c5_aggressive_70pct: c5,
      c6_sigscore_avg_70: c6,
    },
    meta: {
      tradesInWindow: trades.length,
      aggressiveCount: aggressive,
      avgSigScore: +avgSig.toFixed(3),
      strikeClusterMax: countNearbyStrikes(trades),
      windowMin: Math.round(windowMs / 60000),
    },
  };
}

// Convenience: pull unusual trades + score in one call
async function checkAPlus(ticker, opts) {
  var resp = await getUnusualTrades(ticker);
  if (!resp.ok) {
    return { ok: false, ticker: ticker, error: resp.error, score: 0, breakdown: {}, meta: {} };
  }
  // Bullflow response shape varies — try .trades, .data, root array
  var arr = null;
  if (Array.isArray(resp.data)) arr = resp.data;
  else if (resp.data && Array.isArray(resp.data.trades)) arr = resp.data.trades;
  else if (resp.data && Array.isArray(resp.data.data)) arr = resp.data.data;
  if (!arr) return { ok: false, ticker: ticker, error: 'unexpected response shape', raw: resp.data, score: 0 };
  var verdict = scoreAPlus(arr, opts);
  return Object.assign({ ok: true, ticker: ticker.toUpperCase() }, verdict);
}

module.exports = {
  haveKey: haveKey,
  getTickerSpread: getTickerSpread,
  getDarkPool: getDarkPool,
  getInsiderTrades: getInsiderTrades,
  getNews: getNews,
  getUnusualTrades: getUnusualTrades,
  scoreAPlus: scoreAPlus,
  checkAPlus: checkAPlus,
  countNearbyStrikes: countNearbyStrikes,
};
