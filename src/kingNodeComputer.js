// =============================================================================
// kingNodeComputer.js — Phase 4.37 (May 5 PM 2026)
// =============================================================================
// THE KING NODE MAGNET — unified gravity level a stock is being pulled toward.
//
// Three independent magnet signals fused into one verdict:
//   1) GEX magnet  — strike with peak |netGex| (dealer-hedge gravity)
//   2) VPOC        — volume-by-price control (structural commitment)
//   3) UOA cluster — flow-by-strike concentration (smart-money positioning)
//
// Weighted average:
//   GEX  = 0.40   (strongest near-term magnet)
//   VPOC = 0.35   (structural)
//   UOA  = 0.25   (longer-term positioning)
//
// "Tightness" measures how close the 3 levels are to each other (% spread of
// candidates / weighted-avg). 3-source agreement < 1% = STRONG. 2-of-3 within
// ~1.5% (with 1 outlier) = MODERATE. Wide scatter = WEAK / SCATTERED.
//
// Fail-open: if any signal is missing, just use the others (degraded
// confidence). 5-min cache per ticker — king node doesn't move much intraday.
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[KING-NODE] tradestation not loaded:', e.message); }

var gexCalculator = null;
try { gexCalculator = require('./gexCalculator'); }
catch (e) { console.log('[KING-NODE] gexCalculator not loaded:', e.message); }

var volumeProfileCalc = null;
try { volumeProfileCalc = require('./volumeProfileCalc'); }
catch (e) { console.log('[KING-NODE] volumeProfileCalc not loaded:', e.message); }

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var UOA_LOG_PATH = path.join(DATA_ROOT, 'uoa_log.json');

// Per-ticker cache — 5 min TTL.
var _cache = {};
var CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(ticker) { return String(ticker || '').toUpperCase(); }

function fromCache(key) {
  var c = _cache[key];
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_TTL_MS) { delete _cache[key]; return null; }
  return Object.assign({}, c.payload, { cached: true, cacheAgeMs: Date.now() - c.ts });
}
function toCache(key, payload) {
  _cache[key] = { ts: Date.now(), payload: payload };
}

function fetchLib() {
  return (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
}

// =============================================================================
// SIGNAL 1 — GEX MAGNET
// Fetch fresh GEX for the ticker; pick the strike with peak |netGex| as the
// dealer-hedge magnet. Confidence scales with how concentrated the top king
// node is vs. the next strike (0.5..1.0).
// =============================================================================
async function getGexMagnet(ticker, token) {
  if (!gexCalculator) return { peak: null, conf: 0, reason: 'gexCalculator not loaded' };
  try {
    // Try cached first to keep it cheap
    var lastMap = null;
    try { lastMap = gexCalculator.loadLast(); } catch(e) {}
    var hit = null;
    if (lastMap && lastMap.maps) {
      hit = (lastMap.maps || []).find(function(m) { return (m.ticker || '').toUpperCase() === ticker.toUpperCase(); });
    }
    var ageOk = lastMap && lastMap.generatedAt && (Date.now() - new Date(lastMap.generatedAt).getTime()) < 6 * 60 * 60 * 1000;
    if (hit && !hit.error && ageOk) {
      return _gexMagnetFromMap(hit);
    }

    // Compute fresh
    if (!ts || !ts.getAccessToken) return { peak: null, conf: 0, reason: 'no TS' };
    var t = token || await ts.getAccessToken();
    if (!t) return { peak: null, conf: 0, reason: 'no token' };
    var fresh = await gexCalculator.computeForTicker(ticker, t);
    if (!fresh || fresh.error) return { peak: null, conf: 0, reason: 'gex: ' + ((fresh && fresh.error) || 'unknown') };
    return _gexMagnetFromMap(fresh);
  } catch (e) {
    return { peak: null, conf: 0, reason: 'gex error: ' + e.message };
  }
}

function _gexMagnetFromMap(m) {
  if (!m || !m.kingNodes || !m.kingNodes.length) return { peak: null, conf: 0, reason: 'no king nodes' };
  var sorted = m.kingNodes.slice().sort(function(a, b) { return Math.abs(b.netGex) - Math.abs(a.netGex); });
  var top = sorted[0];
  if (!top || !top.strike) return { peak: null, conf: 0, reason: 'no peak' };
  // Confidence: how dominant the top king node is vs. the second
  var second = sorted[1];
  var dominance = second ? Math.min(1, Math.abs(top.netGex) / Math.max(1, Math.abs(top.netGex) + Math.abs(second.netGex))) : 1;
  var conf = Math.max(0.5, Math.min(1, dominance));
  return {
    peak: top.strike,
    conf: conf,
    netGex: top.netGex,
    sign: top.netGex > 0 ? 'CALL' : 'PUT',
    spot: m.spot,
    callWall: m.callWall && m.callWall.strike,
    putWall: m.putWall && m.putWall.strike,
    zeroGamma: m.zeroGamma,
    regime: m.regime,
    reason: 'GEX peak @ $' + top.strike + ' (' + (top.netGex > 0 ? 'CALL' : 'PUT') + ' magnet)',
  };
}

// =============================================================================
// SIGNAL 2 — VPOC
// Pulls volume profile from existing /api/volume-profile semantics. We call
// volumeProfileCalc.computeVolumeProfile directly with TS bars (Daily / 20-bar
// lookback default — same defaults as the scanner pill). Confidence high (0.8)
// when totalVol > 0 and bucketWidth resolved.
// =============================================================================
async function getVolumeProfile(ticker, token, opts) {
  opts = opts || {};
  if (!volumeProfileCalc) return { vpoc: null, conf: 0, reason: 'volumeProfileCalc not loaded' };
  try {
    var t = token;
    if (!t && ts && ts.getAccessToken) t = await ts.getAccessToken();
    if (!t) return { vpoc: null, conf: 0, reason: 'no token' };

    var lookback = opts.lookback || 20;
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?interval=1&unit=Daily&barsback=' + Math.max(lookback, 25);
    var f = fetchLib();
    var r = await f(url, { headers: { 'Authorization': 'Bearer ' + t }, timeout: 8000 });
    if (!r.ok) return { vpoc: null, conf: 0, reason: 'TS http ' + r.status };
    var data = await r.json();
    var bars = (data.Bars || data.bars || []);
    if (!bars.length) return { vpoc: null, conf: 0, reason: 'no bars' };

    var spot = parseFloat(bars[bars.length - 1].Close);
    var vp = volumeProfileCalc.computeVolumeProfile(bars, { lookback: lookback });
    if (!vp || vp.vpoc == null) return { vpoc: null, conf: 0, reason: 'no vpoc' };

    return {
      vpoc: vp.vpoc,
      vah: vp.vah,
      val: vp.val,
      hvn: vp.hvn || [],
      lvn: vp.lvn || [],
      spot: spot,
      conf: 0.8,
      reason: 'VPOC @ $' + vp.vpoc.toFixed(2) + ' · VAH $' + (vp.vah || 0).toFixed(2) + ' · VAL $' + (vp.val || 0).toFixed(2),
    };
  } catch (e) {
    return { vpoc: null, conf: 0, reason: 'vpoc error: ' + e.message };
  }
}

// =============================================================================
// SIGNAL 3 — UOA FLOW CLUSTER
// Read /data/uoa_log.json over the last N days (default 30). Group alerts by
// ticker + strike (rounded to nearest dollar). The strike with the highest
// summed premium = institutional cluster.
//
// Strike extraction: from contract symbol pattern XYZ251205C00200000 we slice
// the last 8 digits and divide by 1000. Falls back to log entry's strike or
// strikeRounded when present.
// =============================================================================
function _extractStrikeFromContract(contract) {
  if (!contract) return null;
  // OCC-style: <TICKER><YYMMDD><C/P><STRIKEx1000 padded 8>
  var m = String(contract).match(/[CP](\d{8})$/);
  if (m) {
    var raw = parseFloat(m[1]) / 1000;
    if (isFinite(raw) && raw > 0) return raw;
  }
  return null;
}

function getUoaFlowCluster(ticker, daysBack) {
  daysBack = daysBack || 30;
  try {
    if (!fs.existsSync(UOA_LOG_PATH)) return { peakStrike: null, conf: 0, reason: 'no uoa log' };
    var raw = fs.readFileSync(UOA_LOG_PATH, 'utf8');
    var log = JSON.parse(raw || '[]');
    if (!Array.isArray(log) || !log.length) return { peakStrike: null, conf: 0, reason: 'empty uoa log' };

    var T = String(ticker || '').toUpperCase();
    var cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    var rows = log.filter(function(r) {
      if (!r) return false;
      if ((r.ticker || '').toUpperCase() !== T) return false;
      if (!r.timestamp) return true; // accept undated rows (rare)
      var t = new Date(r.timestamp).getTime();
      return isFinite(t) && t >= cutoff;
    });
    if (!rows.length) return { peakStrike: null, conf: 0, reason: 'no uoa rows for ' + T + ' in last ' + daysBack + 'd' };

    // Group by strike (rounded to nearest $1)
    var byStrike = {};
    var totalPremium = 0;
    var totalAlerts = 0;
    rows.forEach(function(r) {
      var strike = parseFloat(r.strike);
      if (!isFinite(strike) || strike <= 0) {
        strike = _extractStrikeFromContract(r.contract);
      }
      if (!isFinite(strike) || strike <= 0) return;
      var bucket = Math.round(strike); // $1 buckets
      if (!byStrike[bucket]) {
        byStrike[bucket] = { strike: bucket, premium: 0, alerts: 0, longPrem: 0, shortPrem: 0 };
      }
      var prem = parseFloat(r.premium || 0);
      if (!isFinite(prem)) prem = 0;
      byStrike[bucket].premium += prem;
      byStrike[bucket].alerts += 1;
      var dir = String(r.direction || '').toLowerCase();
      if (dir === 'long' || dir === 'bullish' || dir === 'call') byStrike[bucket].longPrem += prem;
      else if (dir === 'short' || dir === 'bearish' || dir === 'put') byStrike[bucket].shortPrem += prem;
      totalPremium += prem;
      totalAlerts += 1;
    });

    var strikes = Object.keys(byStrike).map(function(k) { return byStrike[k]; });
    if (!strikes.length) return { peakStrike: null, conf: 0, reason: 'no strike data' };

    strikes.sort(function(a, b) { return b.premium - a.premium; });
    var top = strikes[0];
    if (!top.premium || top.premium <= 0) return { peakStrike: null, conf: 0, reason: 'zero premium' };

    // Confidence: dominance of top strike's premium share + sample-size factor
    var share = totalPremium > 0 ? top.premium / totalPremium : 0;
    var sampleBoost = Math.min(1, totalAlerts / 10); // 10+ alerts = full boost
    var conf = Math.max(0.3, Math.min(1, share * 0.7 + sampleBoost * 0.3));

    return {
      peakStrike: top.strike,
      conf: conf,
      peakPremium: top.premium,
      peakAlerts: top.alerts,
      totalAlerts: totalAlerts,
      totalPremium: totalPremium,
      share: share,
      bias: top.longPrem > top.shortPrem ? 'CALL' : (top.shortPrem > top.longPrem ? 'PUT' : 'MIXED'),
      topStrikes: strikes.slice(0, 3),
      reason: 'UOA cluster $' + top.strike + ' · $' + (top.premium / 1000).toFixed(0) + 'K premium across ' + top.alerts + ' alerts (' + Math.round(share * 100) + '% share)',
    };
  } catch (e) {
    return { peakStrike: null, conf: 0, reason: 'uoa error: ' + e.message };
  }
}

// =============================================================================
// FUSION — weighted average + tightness measure
// =============================================================================
function computeTightness(candidates, weightedAvg) {
  // Spread of (level - weightedAvg) / weightedAvg in %.
  if (!candidates || !candidates.length || !weightedAvg) return 0;
  var maxDeviation = 0;
  for (var i = 0; i < candidates.length; i++) {
    var dev = Math.abs(candidates[i].level - weightedAvg) / weightedAvg;
    if (dev > maxDeviation) maxDeviation = dev;
  }
  // Tightness mapping:
  //   maxDeviation < 1%  → 1.0  (tight cluster)
  //   maxDeviation 1-2%  → 0.7
  //   maxDeviation 2-4%  → 0.4
  //   maxDeviation > 4%  → 0.1
  if (maxDeviation < 0.01) return 1.0;
  if (maxDeviation < 0.02) return 0.7;
  if (maxDeviation < 0.04) return 0.4;
  return 0.1;
}

// =============================================================================
// MAIN — computeKingNode(ticker, opts)
// =============================================================================
async function computeKingNode(ticker, opts) {
  opts = opts || {};
  var T = String(ticker || '').toUpperCase().trim();
  if (!T) return { kingNode: null, strength: null, sources: [], reason: 'no ticker' };

  // Cache check
  var key = cacheKey(T);
  if (!opts.force) {
    var cached = fromCache(key);
    if (cached) return cached;
  }

  // Acquire token once if available
  var token = null;
  if (ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); }
    catch (e) { /* fail open — endpoints will skip */ }
  }

  // Run all 3 in parallel
  var [gexRes, vpRes, uoaRes] = await Promise.all([
    getGexMagnet(T, token),
    getVolumeProfile(T, token, { lookback: opts.vpLookback || 20 }),
    Promise.resolve(getUoaFlowCluster(T, opts.uoaDaysBack || 30)),
  ]);

  // Spot determination — prefer GEX spot (live), fallback to VPOC spot
  var spot = (gexRes && gexRes.spot) || (vpRes && vpRes.spot) || null;

  // Build candidate list — only keep sources that produced a level
  var candidates = [];
  if (gexRes && gexRes.peak != null && isFinite(gexRes.peak)) {
    candidates.push({ source: 'GEX', level: gexRes.peak, weight: 0.40, conf: gexRes.conf || 0.5, detail: gexRes });
  }
  if (vpRes && vpRes.vpoc != null && isFinite(vpRes.vpoc)) {
    candidates.push({ source: 'VPOC', level: vpRes.vpoc, weight: 0.35, conf: vpRes.conf || 0.8, detail: vpRes });
  }
  if (uoaRes && uoaRes.peakStrike != null && isFinite(uoaRes.peakStrike)) {
    candidates.push({ source: 'UOA', level: uoaRes.peakStrike, weight: 0.25, conf: uoaRes.conf || 0.5, detail: uoaRes });
  }

  if (candidates.length === 0) {
    var emptyPayload = {
      ok: true,
      ticker: T,
      kingNode: null,
      strength: null,
      confidence: 0,
      sources: [],
      spot: spot,
      reason: 'no candidates: gex=' + (gexRes && gexRes.reason) + ' / vpoc=' + (vpRes && vpRes.reason) + ' / uoa=' + (uoaRes && uoaRes.reason),
      generatedAt: new Date().toISOString(),
    };
    toCache(key, emptyPayload);
    return emptyPayload;
  }

  // Weighted average — each candidate weighted by (weight × conf)
  var sumW = 0;
  var sumWL = 0;
  candidates.forEach(function(c) {
    var w = (c.weight || 0) * (c.conf || 0.5);
    sumW += w;
    sumWL += c.level * w;
  });
  var kingNode = sumW > 0 ? (sumWL / sumW) : candidates[0].level;
  kingNode = +kingNode.toFixed(4);

  // Tightness — how close are the candidates to the weighted average
  var tightness = computeTightness(candidates, kingNode);

  // Strength rating
  var strength;
  if (candidates.length === 3 && tightness >= 0.7) strength = 'STRONG';
  else if (candidates.length >= 2 && tightness >= 0.5) strength = 'MODERATE';
  else strength = 'WEAK';

  // Confidence 1-10 — fuses sources count + tightness + average source conf
  var avgConf = candidates.reduce(function(s, c) { return s + c.conf; }, 0) / candidates.length;
  var confidence = Math.round(
    (candidates.length / 3) * 4         // up to 4 pts for 3-source coverage
    + tightness * 3                      // up to 3 pts for tightness
    + avgConf * 3                        // up to 3 pts for source confidence
  );
  confidence = Math.max(1, Math.min(10, confidence));

  // Distance from spot
  var distanceFromSpot = (spot != null) ? +(spot - kingNode).toFixed(4) : null;
  var distancePct = (spot != null && spot !== 0) ? +((spot - kingNode) / spot * 100).toFixed(2) : null;

  // HVN above / below king node — secondary magnets pulled from VPOC
  var supportMagnets = [];
  var resistanceMagnets = [];
  if (vpRes && Array.isArray(vpRes.hvn)) {
    vpRes.hvn.forEach(function(h) {
      if (h < kingNode) supportMagnets.push(h);
      else if (h > kingNode) resistanceMagnets.push(h);
    });
    supportMagnets.sort(function(a, b) { return b - a; }); // closest first
    resistanceMagnets.sort(function(a, b) { return a - b; });
    supportMagnets = supportMagnets.slice(0, 3);
    resistanceMagnets = resistanceMagnets.slice(0, 3);
  }

  // Verdict — short string for tooltip / Discord card
  var verdict;
  var sourceLabel = candidates.map(function(c) { return c.source; }).join('+');
  if (spot != null && Math.abs(distancePct) <= 0.5) {
    verdict = 'AT KING NODE — tight magnet zone, expect chop / whip';
  } else if (spot != null && spot > kingNode) {
    verdict = 'spot ABOVE king — gravity pulls DOWN (short tailwind)';
  } else if (spot != null) {
    verdict = 'spot BELOW king — gravity pulls UP (long tailwind)';
  } else {
    verdict = 'king node mapped — no live spot';
  }

  var payload = {
    ok: true,
    ticker: T,
    spot: spot,
    kingNode: kingNode,
    strength: strength,
    confidence: confidence,
    tightness: +tightness.toFixed(2),
    sourceCount: candidates.length,
    sourceLabel: sourceLabel,
    sources: candidates.map(function(c) {
      return {
        source: c.source,
        level: +c.level.toFixed(4),
        weight: c.weight,
        conf: +(c.conf || 0).toFixed(2),
        reason: c.detail && c.detail.reason,
      };
    }),
    distanceFromSpot: distanceFromSpot,
    distancePct: distancePct,
    supportMagnets: supportMagnets,
    resistanceMagnets: resistanceMagnets,
    verdict: verdict,
    detail: {
      gex: gexRes,
      vpoc: vpRes,
      uoa: uoaRes,
    },
    generatedAt: new Date().toISOString(),
  };

  toCache(key, payload);
  return payload;
}

// =============================================================================
// HELPERS — for tests / external callers
// =============================================================================
function clearCache() { _cache = {}; }
function getCacheStats() {
  return { size: Object.keys(_cache).length, ttlMs: CACHE_TTL_MS };
}

module.exports = {
  computeKingNode: computeKingNode,
  // exposed for tests / direct probing
  getGexMagnet: getGexMagnet,
  getVolumeProfile: getVolumeProfile,
  getUoaFlowCluster: getUoaFlowCluster,
  computeTightness: computeTightness,
  clearCache: clearCache,
  getCacheStats: getCacheStats,
};
