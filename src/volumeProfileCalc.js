// =============================================================================
// volumeProfileCalc.js  —  Phase 4.23 (May 5 PM)
// =============================================================================
// CUSTOM Volume Profile / POC implementation. Free alternative to TradingView
// paid Volume Profile add-on and Bookmap. Computes institutional-commitment
// levels (VPOC / VAH / VAL / HVN / LVN) directly from TS bar data — no paid
// services, no proprietary feeds, just the math.
//
// Algorithm (standard market-profile / TPO method):
//   1. For each bar, distribute its volume PROPORTIONALLY across the price
//      range from low to high (uniform-distribution assumption — simplest
//      defensible model when we don't have tick data).
//   2. Bucket prices by bucketWidth (auto-scales with stock price level).
//   3. Sum volume per bucket → histogram.
//   4. VPOC = bucket with max volume.
//   5. Walk outward from VPOC adding buckets in descending vol order until
//      we capture valueAreaPct (default 70%) of total. The min/max bucket
//      prices in that selected set = VAL / VAH.
//   6. HVN/LVN = local maxima/minima in histogram (3-window peak detection).
//
// Why uniform distribution: Without tick-level data, TPO assumes price spends
// equal time at every level the bar touched. This is the same simplification
// used by TV's free overlays, Sierra Chart's default profile, and most
// institutional desks before tick reconstruction. Good enough — VPOC error
// is typically < 0.5 buckets.
//
// AB rule (May 5): VPOC = magnet. Spot above VPOC = bullish "above value",
// below VPOC = bearish "below value". Trade returns to VPOC as support /
// resistance, breaks out of value area = momentum continuation.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// AUTO-SCALE BUCKET WIDTH BASED ON PRICE LEVEL
// AB spec: $0.10 for stocks <$50, $0.25 for $50-200, $0.50 for $200-500,
//          $1.00 for $500+
// Returns a sensible default if caller didn't pass one.
// -----------------------------------------------------------------------------
function autoBucketWidth(referencePrice) {
  var p = Number(referencePrice) || 100;
  if (p < 50)   return 0.10;
  if (p < 200)  return 0.25;
  if (p < 500)  return 0.50;
  return 1.00;
}

// Round price DOWN to the nearest bucket boundary so all bars share the same
// grid (otherwise floating-point bucket centers drift and we can't sum).
function priceToBucket(price, bucketWidth) {
  return Math.floor(price / bucketWidth) * bucketWidth;
}

// -----------------------------------------------------------------------------
// computeVolumeProfile(bars, opts)
//   bars: array of { open, high, low, close, volume }  (case-insensitive)
//   opts: { bucketWidth?: number, valueAreaPct?: number (0-1), lookback?: number }
//   returns: {
//     vpoc:   number   — price level (bucket center) with most volume
//     vah:    number   — value area high
//     val:    number   — value area low
//     hvn:    number[] — high-volume nodes (peaks), descending by volume
//     lvn:    number[] — low-volume nodes  (valleys), ascending by volume
//     histogram: { [bucketLowPrice]: volume }
//     totalVol: number
//     bucketWidth: number
//     barCount: number
//     priceMin, priceMax: number
//   }
// -----------------------------------------------------------------------------
function computeVolumeProfile(bars, opts) {
  opts = opts || {};
  if (!Array.isArray(bars) || bars.length === 0) {
    return { vpoc: null, vah: null, val: null, hvn: [], lvn: [], histogram: {}, totalVol: 0, bucketWidth: 0, barCount: 0, priceMin: null, priceMax: null };
  }

  // Normalise bars (TS returns capitalised keys; tests / callers may use lowercase).
  var norm = [];
  for (var i = 0; i < bars.length; i++) {
    var b = bars[i] || {};
    var hi = Number(b.High != null ? b.High : b.high);
    var lo = Number(b.Low  != null ? b.Low  : b.low);
    var cl = Number(b.Close != null ? b.Close : b.close);
    var vo = Number(b.Volume != null ? b.Volume : (b.TotalVolume != null ? b.TotalVolume : b.volume));
    if (!isFinite(hi) || !isFinite(lo) || !isFinite(cl) || !isFinite(vo) || vo <= 0) continue;
    if (hi < lo) { var t = hi; hi = lo; lo = t; }
    norm.push({ high: hi, low: lo, close: cl, volume: vo });
  }
  if (!norm.length) {
    return { vpoc: null, vah: null, val: null, hvn: [], lvn: [], histogram: {}, totalVol: 0, bucketWidth: 0, barCount: 0, priceMin: null, priceMax: null };
  }

  // Apply lookback (most-recent N bars) if provided.
  var lookback = Number(opts.lookback) || norm.length;
  if (lookback > 0 && lookback < norm.length) {
    norm = norm.slice(norm.length - lookback);
  }

  // Pick a reference price for auto bucket width if caller didn't override.
  var refPrice = norm[norm.length - 1].close;
  var bucketWidth = Number(opts.bucketWidth);
  if (!isFinite(bucketWidth) || bucketWidth <= 0) {
    bucketWidth = autoBucketWidth(refPrice);
  }
  var valueAreaPct = Number(opts.valueAreaPct);
  if (!isFinite(valueAreaPct) || valueAreaPct <= 0 || valueAreaPct > 1) valueAreaPct = 0.70;

  // -------------------------------------------------------------------------
  // STEP 1+2+3: Distribute each bar's volume uniformly across its [low,high]
  // range, bucketed by bucketWidth.
  // -------------------------------------------------------------------------
  var histogram = Object.create(null);
  var totalVol = 0;
  var priceMin = Infinity;
  var priceMax = -Infinity;

  for (var j = 0; j < norm.length; j++) {
    var bar = norm[j];
    if (bar.low < priceMin) priceMin = bar.low;
    if (bar.high > priceMax) priceMax = bar.high;

    // Find first and last bucket that bar [low, high] touches.
    var firstBucket = priceToBucket(bar.low, bucketWidth);
    var lastBucket  = priceToBucket(bar.high, bucketWidth);
    // # of buckets the bar covers (inclusive).
    var nBuckets = Math.round((lastBucket - firstBucket) / bucketWidth) + 1;
    if (nBuckets < 1) nBuckets = 1;
    var volPerBucket = bar.volume / nBuckets;

    for (var k = 0; k < nBuckets; k++) {
      var bp = firstBucket + k * bucketWidth;
      // Round to avoid float drift in keys.
      var key = bp.toFixed(4);
      histogram[key] = (histogram[key] || 0) + volPerBucket;
    }
    totalVol += bar.volume;
  }

  // -------------------------------------------------------------------------
  // STEP 4: VPOC — bucket with max volume.
  // -------------------------------------------------------------------------
  var entries = Object.keys(histogram).map(function(k) {
    return { price: parseFloat(k), vol: histogram[k] };
  });
  // Sort entries by price ascending — needed for HVN/LVN peak detection.
  entries.sort(function(a, b) { return a.price - b.price; });

  var vpocEntry = entries[0];
  for (var m = 1; m < entries.length; m++) {
    if (entries[m].vol > vpocEntry.vol) vpocEntry = entries[m];
  }
  var vpoc = +(vpocEntry.price + bucketWidth / 2).toFixed(4); // bucket center

  // -------------------------------------------------------------------------
  // STEP 5: Value Area — accumulate buckets in descending vol until we cover
  // valueAreaPct of total. VAH = max selected price, VAL = min selected price.
  // -------------------------------------------------------------------------
  var byVol = entries.slice().sort(function(a, b) { return b.vol - a.vol; });
  var target = totalVol * valueAreaPct;
  var accum = 0;
  var selectedPrices = [];
  for (var n = 0; n < byVol.length; n++) {
    accum += byVol[n].vol;
    selectedPrices.push(byVol[n].price);
    if (accum >= target) break;
  }
  var vah = -Infinity, val = Infinity;
  for (var p = 0; p < selectedPrices.length; p++) {
    if (selectedPrices[p] > vah) vah = selectedPrices[p];
    if (selectedPrices[p] < val) val = selectedPrices[p];
  }
  // Bucket-center adjust + shift VAH up by one bucket so the VA covers the
  // top edge of the highest selected bucket.
  vah = +(vah + bucketWidth).toFixed(4);
  val = +val.toFixed(4);

  // -------------------------------------------------------------------------
  // STEP 6: HVN / LVN peak detection (3-window).
  // A bucket is a HVN if its volume > both neighbors. LVN if < both.
  // We require the differential to exceed 5% of VPOC volume to avoid noise.
  // Result lists are price-sorted descending-by-vol (HVN) / ascending-by-vol (LVN)
  // so callers can easily grab "top 3 HVN" / "top 3 LVN".
  // -------------------------------------------------------------------------
  var noiseFloor = vpocEntry.vol * 0.05;
  var hvn = [], lvn = [];
  for (var q = 1; q < entries.length - 1; q++) {
    var prev = entries[q - 1].vol;
    var curr = entries[q].vol;
    var nxt  = entries[q + 1].vol;
    if (curr > prev && curr > nxt && (curr - Math.max(prev, nxt)) > noiseFloor) {
      hvn.push({ price: +(entries[q].price + bucketWidth / 2).toFixed(4), vol: curr });
    } else if (curr < prev && curr < nxt && (Math.min(prev, nxt) - curr) > noiseFloor) {
      lvn.push({ price: +(entries[q].price + bucketWidth / 2).toFixed(4), vol: curr });
    }
  }
  hvn.sort(function(a, b) { return b.vol - a.vol; });
  lvn.sort(function(a, b) { return a.vol - b.vol; });

  // Return only top-N peaks/valleys (5 each) as flat price arrays for the
  // shape AB asked for in the spec, plus the full structures for power users.
  var hvnPrices = hvn.slice(0, 5).map(function(x) { return x.price; });
  var lvnPrices = lvn.slice(0, 5).map(function(x) { return x.price; });

  return {
    vpoc: vpoc,
    vah: vah,
    val: val,
    hvn: hvnPrices,
    lvn: lvnPrices,
    hvnDetail: hvn.slice(0, 10),
    lvnDetail: lvn.slice(0, 10),
    histogram: histogram,
    totalVol: Math.round(totalVol),
    bucketWidth: bucketWidth,
    barCount: norm.length,
    priceMin: +priceMin.toFixed(4),
    priceMax: +priceMax.toFixed(4),
    valueAreaPct: valueAreaPct,
  };
}

// -----------------------------------------------------------------------------
// summariseProfile(vp, spot)
// One-line trade-relevant summary used by the scanner card pill builder and
// Discord cards. Returns:
//   { side: 'ABOVE' | 'BELOW' | 'AT' (within ±bucket of VPOC),
//     bias: 'bullish' | 'bearish' | 'neutral',
//     distVpoc: signed $ distance,
//     distVpocPct: signed % distance,
//     inValueArea: bool,
//     verdict: short string }
// -----------------------------------------------------------------------------
function summariseProfile(vp, spot) {
  if (!vp || vp.vpoc == null || !isFinite(spot)) {
    return { side: 'UNKNOWN', bias: 'neutral', distVpoc: null, distVpocPct: null, inValueArea: false, verdict: 'No profile' };
  }
  var dist = +(spot - vp.vpoc).toFixed(4);
  var pct = vp.vpoc !== 0 ? +((dist / vp.vpoc) * 100).toFixed(2) : 0;
  var bw = vp.bucketWidth || 0.5;
  var side, bias, verdict;
  if (Math.abs(dist) <= bw) {
    side = 'AT'; bias = 'neutral';
    verdict = 'AT VPOC — magnet level, expect chop or reaction';
  } else if (dist > 0) {
    side = 'ABOVE'; bias = 'bullish';
    verdict = 'Above VPOC — buyers in control';
  } else {
    side = 'BELOW'; bias = 'bearish';
    verdict = 'Below VPOC — sellers in control';
  }
  var inVA = (spot >= vp.val && spot <= vp.vah);
  if (!inVA) {
    if (spot > vp.vah) verdict += ' · OUTSIDE VAH (breakout zone)';
    else if (spot < vp.val) verdict += ' · OUTSIDE VAL (breakdown zone)';
  }
  return { side: side, bias: bias, distVpoc: dist, distVpocPct: pct, inValueArea: inVA, verdict: verdict };
}

module.exports = {
  computeVolumeProfile: computeVolumeProfile,
  summariseProfile: summariseProfile,
  autoBucketWidth: autoBucketWidth,
};
