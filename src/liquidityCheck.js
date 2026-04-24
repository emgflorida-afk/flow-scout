// liquidityCheck.js — Trading-Desk Grade Pre-Entry Verification
// -----------------------------------------------------------------
// Created 2026-04-24 after META session failure where stale pre-market
// option quotes were used as basis for Titan card. Contract had Volume
// of 3 at market open = unexecutable. AB's morning was burned.
//
// THIS MODULE IS MANDATORY BEFORE ANY TITAN CARD IS PROPOSED.
//
// 4 gates that MUST pass:
//   1. Daily volume ≥ 100
//   2. Open Interest ≥ 500
//   3. Bid/ask spread ≤ 5% of mid
//   4. Bid/ask spread absolute ≤ $1.00 (safety cap)
//
// Returns structured result. Any fail = card must not be built.
// -----------------------------------------------------------------

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

var MIN_VOLUME = 100;
var MIN_OI = 500;
var MAX_SPREAD_PCT = 0.05;     // 5%
var MAX_SPREAD_ABS = 1.00;     // $1 max absolute spread

// Score formula: (OI/500) + (Volume/100) - (Spread% × 0.2)
// ≥ 3.0 = excellent
// 1.5-3.0 = good
// 0.5-1.5 = marginal
// < 0.5 = SKIP
function computeLiquidityScore(vol, oi, spreadPct) {
  return (oi / 500) + (vol / 100) - (spreadPct * 100 * 0.2);
}

function scoreTier(score) {
  if (score >= 3.0) return 'excellent';
  if (score >= 1.5) return 'good';
  if (score >= 0.5) return 'marginal';
  return 'skip';
}

/**
 * Check liquidity for a single option contract.
 * @param {object} quote - TS MCP quote response (single symbol)
 * @returns {object} result with .passed (bool), .failures (arr), .score, .tier
 */
function checkContract(quote) {
  if (!quote || !quote.Symbol) {
    return { passed: false, failures: ['no_quote'], score: 0, tier: 'skip' };
  }

  var bid = parseFloat(quote.Bid || 0);
  var ask = parseFloat(quote.Ask || 0);
  var vol = parseInt(quote.Volume || 0, 10);
  var oi = parseInt(quote.DailyOpenInterest || 0, 10);
  var mid = (bid + ask) / 2;
  var spreadAbs = ask - bid;
  var spreadPct = mid > 0 ? spreadAbs / mid : 1;

  var failures = [];
  if (vol < MIN_VOLUME) failures.push({ gate: 'volume', actual: vol, required: MIN_VOLUME });
  if (oi < MIN_OI) failures.push({ gate: 'open_interest', actual: oi, required: MIN_OI });
  if (spreadPct > MAX_SPREAD_PCT) failures.push({ gate: 'spread_pct', actual: (spreadPct * 100).toFixed(1) + '%', required: (MAX_SPREAD_PCT * 100) + '%' });
  if (spreadAbs > MAX_SPREAD_ABS) failures.push({ gate: 'spread_abs', actual: '$' + spreadAbs.toFixed(2), required: '$' + MAX_SPREAD_ABS });
  if (bid <= 0 || ask <= 0) failures.push({ gate: 'has_quote', actual: 'zero_quote', required: 'nonzero' });

  var score = computeLiquidityScore(vol, oi, spreadPct);
  var tier = scoreTier(score);

  return {
    symbol: quote.Symbol,
    passed: failures.length === 0,
    failures: failures,
    bid: bid, ask: ask, mid: mid, spread: spreadAbs, spreadPct: spreadPct,
    volume: vol, openInterest: oi,
    score: score.toFixed(2),
    tier: tier,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check multiple contracts at once and rank by liquidity.
 * @param {string[]} symbols - array of option symbols in TS format
 * @returns {Promise<{ passed, failed, all, best }>}
 */
async function checkMany(symbols) {
  if (!ts || !ts.getToken) {
    return { error: 'tradestation module not loaded' };
  }
  var token = await ts.getToken();
  if (!token) return { error: 'no TS token' };

  var fetch = require('node-fetch');
  var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(symbols.join(','));
  var r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return { error: 'quote fetch failed: ' + r.status };
  var data = await r.json();
  var quotes = (data.Quotes || []);

  var results = quotes.map(checkContract);
  var passed = results.filter(function(x) { return x.passed; });
  var failed = results.filter(function(x) { return !x.passed; });

  // Rank passed by score (best first)
  passed.sort(function(a, b) { return parseFloat(b.score) - parseFloat(a.score); });

  return {
    passed: passed,
    failed: failed,
    all: results,
    best: passed[0] || null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Pre-market liquidity warning — flags contracts where pre-market quote
 * looks thin. Triggers the "verify live at 9:15 AM" rule.
 */
function isPremarketSuspect(quote) {
  var bid = parseFloat(quote.Bid || 0);
  var ask = parseFloat(quote.Ask || 0);
  var vol = parseInt(quote.Volume || 0, 10);
  var mid = (bid + ask) / 2;
  var spreadPct = mid > 0 ? (ask - bid) / mid : 1;

  // Pre-market red flags:
  // - Spread > 10% of mid (very wide)
  // - Volume 0 (no trading interest)
  // - Bid/ask both same (stale quote)
  return spreadPct > 0.10 || vol === 0 || bid === ask;
}

module.exports = {
  checkContract: checkContract,
  checkMany: checkMany,
  isPremarketSuspect: isPremarketSuspect,
  computeLiquidityScore: computeLiquidityScore,
  MIN_VOLUME: MIN_VOLUME,
  MIN_OI: MIN_OI,
  MAX_SPREAD_PCT: MAX_SPREAD_PCT,
  MAX_SPREAD_ABS: MAX_SPREAD_ABS,
};
