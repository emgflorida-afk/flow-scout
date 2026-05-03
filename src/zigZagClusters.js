// =============================================================================
// ZIG ZAG CLUSTERING — find S/R zones where multiple swing reversals stack
//
// Per Barchart "Zig Zag Indicator Reveals What Matters" video (John Rowland):
// individual swings are noisy. The signal is in CLUSTERING — when 3+ swing
// reversals happen in the same price zone, that zone is high-probability S/R.
// Unlike floor pivots (universal but daily-reset), clusters identify
// historically significant levels that trade away from arbitrary daily math.
//
// Algorithm:
// 1. Detect swing highs/lows via percent-deviation threshold (2-3% typical)
// 2. Group swing points into price bands (1% of mean price tolerance)
// 3. Bands with 3+ swing points = strong S/R cluster
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

function round2(v) { return Math.round(v * 100) / 100; }

// Detect swing highs and lows via Zig Zag percent-deviation algorithm
// Returns: { swings: [{ index, price, type: 'high'|'low', date }] }
function detectSwings(bars, deviationPct) {
  if (!bars || bars.length < 3) return { swings: [] };
  deviationPct = deviationPct || 2.0; // default 2% deviation threshold

  var swings = [];
  var lookingFor = 'either'; // 'high', 'low', or 'either' (initial)
  var pendingExtreme = null; // { index, price }
  var initialBar = bars[0];

  // Bootstrap: first swing direction depends on second bar's move from first
  // Track running extremes
  for (var i = 0; i < bars.length; i++) {
    var bar = bars[i];
    var H = bar.High, L = bar.Low;

    if (lookingFor === 'either') {
      // Wait for first deviation
      if (!pendingExtreme) {
        pendingExtreme = { index: i, highPrice: H, lowPrice: L };
        continue;
      }
      // Update running extremes
      if (H > pendingExtreme.highPrice) pendingExtreme.highPrice = H;
      if (L < pendingExtreme.lowPrice) pendingExtreme.lowPrice = L;
      // Check for breakout from running range
      var pctFromHigh = ((pendingExtreme.highPrice - L) / pendingExtreme.highPrice) * 100;
      var pctFromLow = ((H - pendingExtreme.lowPrice) / pendingExtreme.lowPrice) * 100;

      if (pctFromHigh >= deviationPct) {
        // Started low after marking a high — confirm high
        swings.push({
          index: pendingExtreme.index,
          price: round2(pendingExtreme.highPrice),
          type: 'high',
          date: bars[pendingExtreme.index].TimeStamp,
        });
        pendingExtreme = { index: i, lowPrice: L };
        lookingFor = 'high';
      } else if (pctFromLow >= deviationPct) {
        // Confirm low
        swings.push({
          index: pendingExtreme.index,
          price: round2(pendingExtreme.lowPrice),
          type: 'low',
          date: bars[pendingExtreme.index].TimeStamp,
        });
        pendingExtreme = { index: i, highPrice: H };
        lookingFor = 'low';
      }
    } else if (lookingFor === 'high') {
      // Currently coming up from a confirmed low; track new high
      if (!pendingExtreme || H > (pendingExtreme.highPrice || 0)) {
        pendingExtreme = { index: i, highPrice: H };
      }
      // Reverse confirms when price drops X% from running high
      if (pendingExtreme && pendingExtreme.highPrice > 0) {
        var dropPct = ((pendingExtreme.highPrice - L) / pendingExtreme.highPrice) * 100;
        if (dropPct >= deviationPct) {
          swings.push({
            index: pendingExtreme.index,
            price: round2(pendingExtreme.highPrice),
            type: 'high',
            date: bars[pendingExtreme.index].TimeStamp,
          });
          pendingExtreme = { index: i, lowPrice: L };
          lookingFor = 'low';
        }
      }
    } else if (lookingFor === 'low') {
      if (!pendingExtreme || L < (pendingExtreme.lowPrice || Infinity)) {
        pendingExtreme = { index: i, lowPrice: L };
      }
      if (pendingExtreme && pendingExtreme.lowPrice < Infinity) {
        var risePct = ((H - pendingExtreme.lowPrice) / pendingExtreme.lowPrice) * 100;
        if (risePct >= deviationPct) {
          swings.push({
            index: pendingExtreme.index,
            price: round2(pendingExtreme.lowPrice),
            type: 'low',
            date: bars[pendingExtreme.index].TimeStamp,
          });
          pendingExtreme = { index: i, highPrice: H };
          lookingFor = 'high';
        }
      }
    }
  }

  return { swings: swings, deviationPct: deviationPct };
}

// Group swing points into price bands (cluster them) — swing points within
// `tolerancePct` of each other in price are grouped. Returns clusters sorted
// by swing count desc.
function clusterSwings(swings, tolerancePct) {
  if (!swings || !swings.length) return [];
  tolerancePct = tolerancePct || 1.0; // default 1% price band

  var clusters = [];
  var sorted = swings.slice().sort(function(a, b) { return a.price - b.price; });

  for (var i = 0; i < sorted.length; i++) {
    var pt = sorted[i];
    var added = false;
    for (var j = 0; j < clusters.length; j++) {
      var c = clusters[j];
      var meanPrice = c.points.reduce(function(s, p) { return s + p.price; }, 0) / c.points.length;
      var diffPct = (Math.abs(pt.price - meanPrice) / meanPrice) * 100;
      if (diffPct <= tolerancePct) {
        c.points.push(pt);
        added = true;
        break;
      }
    }
    if (!added) {
      clusters.push({ points: [pt] });
    }
  }

  // Annotate each cluster with summary stats
  return clusters.map(function(c) {
    var prices = c.points.map(function(p) { return p.price; });
    var highCount = c.points.filter(function(p) { return p.type === 'high'; }).length;
    var lowCount = c.points.filter(function(p) { return p.type === 'low'; }).length;
    var meanPrice = prices.reduce(function(s, p) { return s + p; }, 0) / prices.length;
    return {
      meanPrice: round2(meanPrice),
      minPrice: round2(Math.min.apply(null, prices)),
      maxPrice: round2(Math.max.apply(null, prices)),
      pointCount: c.points.length,
      highCount: highCount,
      lowCount: lowCount,
      // Type: pure resistance, pure support, or mixed (= pivot zone)
      clusterType: highCount > 0 && lowCount > 0 ? 'pivot-zone'
                  : highCount > lowCount ? 'resistance'
                  : 'support',
      strength: c.points.length >= 4 ? 'STRONG'
              : c.points.length === 3 ? 'MODERATE'
              : c.points.length === 2 ? 'WEAK'
              : 'SINGLE',
      points: c.points,
    };
  })
  .sort(function(a, b) { return b.pointCount - a.pointCount; }); // most-clustered first
}

// Pull bars and compute swings + clusters
async function clustersFor(ticker, opts) {
  opts = opts || {};
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  try {
    // Pull 60 daily bars (~3 months) — enough to find meaningful swings
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=Daily&interval=1&barsback=60';
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ok: false, error: 'TS-' + r.status };
    var data = await r.json();
    var raw = (data.Bars || data.bars || []);
    if (raw.length < 10) return { ok: false, error: 'not-enough-bars' };

    var bars = raw.map(function(b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        TimeStamp: b.TimeStamp,
      };
    }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });

    var deviationPct = opts.deviationPct || 2.0;
    var tolerancePct = opts.tolerancePct || 1.0;
    var swingResult = detectSwings(bars, deviationPct);
    var clusters = clusterSwings(swingResult.swings, tolerancePct);

    var lastClose = bars[bars.length - 1].Close;
    // Find clusters above and below current price
    var above = clusters.filter(function(c) { return c.meanPrice > lastClose; }).slice(0, 5);
    var below = clusters.filter(function(c) { return c.meanPrice < lastClose; }).slice(0, 5);
    // Rank "actionable" clusters = STRONG or MODERATE strength near current price
    var actionable = clusters.filter(function(c) {
      return c.pointCount >= 3 && Math.abs(c.meanPrice - lastClose) / lastClose <= 0.10;
    }).slice(0, 6);

    return {
      ok: true,
      ticker: ticker,
      currentClose: round2(lastClose),
      swingCount: swingResult.swings.length,
      clusterCount: clusters.length,
      params: { deviationPct: deviationPct, tolerancePct: tolerancePct, barsBack: bars.length },
      actionableClusters: actionable,
      resistanceAbove: above,
      supportBelow: below,
      allSwings: swingResult.swings,
      note: 'Clusters with 3+ swings = high-probability S/R. Trade entries near clusters with stops just past, targets at adjacent clusters.',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  detectSwings: detectSwings,
  clusterSwings: clusterSwings,
  clustersFor: clustersFor,
};
