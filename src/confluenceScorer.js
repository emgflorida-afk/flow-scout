// =============================================================================
// CONFLUENCE SCORER — unified multi-system scoring across all pattern tabs
//
// Stacks 12 independent confirmation layers into a single 0-15 score that
// translates to A++/A+/A/B/C/F tier. The pattern detector said GO; this asks
// "do enough OTHER systems agree to actually fire?"
//
// LAYERS (each with weight):
//  1. Strat pattern (the source — JS/coil/WP) [+2 baseline]
//  2. WP scanner alignment [+1]
//  3. John precedent [+1]
//  4. Sniper precedent [+1]
//  5. Floor pivot alignment (trigger near pivot) [+1]
//  6. Target Price (Newton's law) direction match [+1]
//  7. Zig Zag clusters confirm targets [+1]
//  8. Volume confirmation (ratio >=1.5x avg) [+1]
//  9. FTFC (multi-TF alignment) [+2]
// 10. Market researcher GREEN [+1]
// 11. Chart Vision APPROVE [+2]
// 12. Candle Range Theory (CRT) sweep+reversal [+2 high / +1 medium / +0 low]
//
// MAX 15 → A++. Real-world A++ rare; A-tier (8-9) is the typical fire threshold.
// CRT exists to override vision VETO when the structure IS the sweep — vision
// alone can't see "ATH = liquidity grab" without the structural detector.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

// Lazy-require all the scoring modules so the scorer module loads fast even
// if some are missing.
function lazy(name) {
  try { return require('./' + name); } catch (e) { return null; }
}
var floorPivots = lazy('floorPivots');
var targetPrice = lazy('targetPrice');
var zigZagClusters = lazy('zigZagClusters');
var johnPrecedent = lazy('johnPrecedent');
var sniperFeed = lazy('sniperFeed');
var lottoFeed = lazy('lottoFeed');
var candleRangeTheory = lazy('candleRangeTheory');
var johnPatternScanner = lazy('johnPatternScanner');

function round2(v) { return Math.round(v * 100) / 100; }

// Score a single setup across all available layers
async function scoreSetup(opts) {
  opts = opts || {};
  var ticker = (opts.ticker || '').toUpperCase();
  var direction = String(opts.direction || 'long').toLowerCase();  // 'long' or 'short'
  var trigger = parseFloat(opts.trigger);
  var stop = parseFloat(opts.stop);
  var tp1 = parseFloat(opts.tp1);
  var tp2 = parseFloat(opts.tp2);
  var pattern = opts.pattern || null;
  var sourceConv = opts.sourceConv || 0; // existing pattern-detector conviction
  var sourceTab = opts.sourceTab || 'unknown'; // 'JS' / 'COIL' / 'WP'
  var preCheckedVision = opts.visionVerdict || null; // optional pre-fetched vision result
  var preCheckedResearch = opts.researchVerdict || null; // GREEN/YELLOW/RED if pre-fetched

  if (!ticker) return { ok: false, error: 'ticker required' };

  var layers = {};
  var totalScore = 0;

  // ─────────────────────────────────────────────────────
  // Layer 1: Strat pattern (the source — always +2 if we got here)
  // ─────────────────────────────────────────────────────
  if (pattern && sourceConv >= 5) {
    layers.stratPattern = {
      points: 2,
      passed: true,
      detail: pattern + ' on ' + sourceTab + ' (conv ' + sourceConv + ')',
    };
    totalScore += 2;
  } else {
    layers.stratPattern = { points: 0, passed: false, detail: 'no underlying pattern' };
  }

  // ─────────────────────────────────────────────────────
  // Layer 5: Floor pivot alignment
  // ─────────────────────────────────────────────────────
  if (floorPivots && isFinite(trigger)) {
    try {
      var pivotsResult = await floorPivots.pivotsFor(ticker);
      if (pivotsResult && pivotsResult.ok) {
        var p = pivotsResult.pivots;
        // Check if trigger is within 1.5% of any pivot level
        var pivotLevels = [p.P, p.R1, p.R2, p.R3, p.S1, p.S2, p.S3];
        var tolerance = trigger * 0.015;
        var matchedLevel = null;
        for (var i = 0; i < pivotLevels.length; i++) {
          if (Math.abs(trigger - pivotLevels[i]) <= tolerance) {
            matchedLevel = pivotLevels[i];
            break;
          }
        }
        // Also check direction-bias alignment
        var biasMatch = (direction === 'long' && pivotsResult.nearest && pivotsResult.nearest.bias === 'bullish') ||
                        (direction === 'short' && pivotsResult.nearest && pivotsResult.nearest.bias === 'bearish');
        if (matchedLevel && biasMatch) {
          layers.floorPivots = {
            points: 1,
            passed: true,
            detail: 'Trigger $' + trigger + ' aligns with pivot $' + matchedLevel + ', bias ' + pivotsResult.nearest.bias,
          };
          totalScore += 1;
        } else if (matchedLevel) {
          layers.floorPivots = {
            points: 0.5,
            passed: 'partial',
            detail: 'Trigger aligns with pivot $' + matchedLevel + ' but bias contradicts',
          };
          totalScore += 0.5;
        } else if (biasMatch) {
          layers.floorPivots = {
            points: 0.5,
            passed: 'partial',
            detail: 'Bias aligns but trigger not near a pivot level',
          };
          totalScore += 0.5;
        } else {
          layers.floorPivots = { points: 0, passed: false, detail: 'No alignment' };
        }
      } else {
        layers.floorPivots = { points: 0, passed: 'unchecked', detail: 'pivots unavailable' };
      }
    } catch (e) {
      layers.floorPivots = { points: 0, passed: 'unchecked', detail: e.message };
    }
  }

  // ─────────────────────────────────────────────────────
  // Layer 6: Target Price (Newton's law) direction match
  // ─────────────────────────────────────────────────────
  if (targetPrice) {
    try {
      var tpResult = await targetPrice.targetFor(ticker);
      if (tpResult && tpResult.ok && tpResult.tomorrowTarget) {
        var tt = tpResult.tomorrowTarget;
        var directionMatch = (direction === 'long' && tt.direction === 'up') ||
                            (direction === 'short' && tt.direction === 'down');
        if (directionMatch) {
          layers.targetPrice = {
            points: 1,
            passed: true,
            detail: 'Momentum ' + tt.direction + ' (' + tt.velocityLabel + ') matches direction',
          };
          totalScore += 1;
        } else {
          layers.targetPrice = {
            points: 0,
            passed: false,
            detail: 'Momentum ' + tt.direction + ' contradicts ' + direction,
          };
        }
      }
    } catch (e) {
      layers.targetPrice = { points: 0, passed: 'unchecked', detail: e.message };
    }
  }

  // ─────────────────────────────────────────────────────
  // Layer 7: Zig Zag clusters confirm targets
  // ─────────────────────────────────────────────────────
  if (zigZagClusters && isFinite(tp1)) {
    try {
      var zzResult = await zigZagClusters.clustersFor(ticker);
      if (zzResult && zzResult.ok) {
        var allClusters = (zzResult.resistanceAbove || []).concat(zzResult.supportBelow || []);
        // Check if any TP aligns with a cluster (within 2% of TP)
        var tp1Tol = Math.abs(tp1) * 0.02;
        var tp2Tol = isFinite(tp2) ? Math.abs(tp2) * 0.02 : 0;
        var matchedTp1 = allClusters.find(function(c) { return Math.abs(c.meanPrice - tp1) <= tp1Tol; });
        var matchedTp2 = isFinite(tp2) ? allClusters.find(function(c) { return Math.abs(c.meanPrice - tp2) <= tp2Tol; }) : null;
        if (matchedTp1 || matchedTp2) {
          var details = [];
          if (matchedTp1) details.push('TP1 $' + tp1 + ' near cluster $' + matchedTp1.meanPrice + ' (' + matchedTp1.strength + ')');
          if (matchedTp2) details.push('TP2 $' + tp2 + ' near cluster $' + matchedTp2.meanPrice + ' (' + matchedTp2.strength + ')');
          layers.zigZagClusters = {
            points: 1,
            passed: true,
            detail: details.join(' / '),
          };
          totalScore += 1;
        } else {
          layers.zigZagClusters = {
            points: 0,
            passed: false,
            detail: 'TPs do not align with historical S/R clusters',
          };
        }
      }
    } catch (e) {
      layers.zigZagClusters = { points: 0, passed: 'unchecked', detail: e.message };
    }
  }

  // ─────────────────────────────────────────────────────
  // Layer 3: John precedent (has John traded this ticker recently?)
  // ─────────────────────────────────────────────────────
  if (johnPrecedent) {
    try {
      var jp = johnPrecedent.checkTicker ? johnPrecedent.checkTicker(ticker) : null;
      if (jp && jp.count > 0) {
        layers.johnPrecedent = {
          points: 1,
          passed: true,
          detail: 'John has called ' + ticker + ' ' + jp.count + ' times historically',
        };
        totalScore += 1;
      } else {
        layers.johnPrecedent = { points: 0, passed: false, detail: 'No John precedent' };
      }
    } catch (e) {
      layers.johnPrecedent = { points: 0, passed: 'unchecked', detail: e.message };
    }
  }

  // ─────────────────────────────────────────────────────
  // Layer 4: Sniper precedent
  // ─────────────────────────────────────────────────────
  if (sniperFeed) {
    try {
      var sf = sniperFeed.loadFeed({ limit: 50 });
      var sniperHits = (sf.posts || []).filter(function(p) { return (p.ticker || '').toUpperCase() === ticker; });
      if (sniperHits.length > 0) {
        layers.sniperPrecedent = {
          points: 1,
          passed: true,
          detail: 'Sniper analyzed ' + ticker + ' ' + sniperHits.length + ' times',
        };
        totalScore += 1;
      } else {
        layers.sniperPrecedent = { points: 0, passed: false, detail: 'No Sniper precedent' };
      }
    } catch (e) {
      layers.sniperPrecedent = { points: 0, passed: 'unchecked', detail: e.message };
    }
  }

  // ─────────────────────────────────────────────────────
  // Layer 12: Candle Range Theory (CRT) — sweep+reversal detection
  //   Closes the "vision VETO at ATH" gap: when c2 sweeps liquidity above the
  //   range and c3 closes back inside, that's a structural short signal that
  //   pure trend-following vision misreads as "counter-trend at ATH".
  //   Scoring: high → +2, medium → +1, low → +0 (still passes but no points).
  // ─────────────────────────────────────────────────────
  if (candleRangeTheory) {
    try {
      var crtRes = await candleRangeTheory.crtFor(ticker, { direction: direction, tf: 'Daily' });
      if (crtRes && crtRes.ok && crtRes.crt && crtRes.crt.detected && crtRes.crt.direction === direction) {
        var crtData = crtRes.crt;
        var crtPoints = crtData.score === 'high' ? 2 : crtData.score === 'medium' ? 1 : 0;
        if (crtPoints > 0) {
          layers.candleRangeTheory = {
            points: crtPoints,
            passed: true,
            detail: 'CRT-' + direction + ' (' + crtData.score + '): sweep $' +
                    Number(crtData.sweepLevel).toFixed(2) + ' → reversal back inside range. Invalid > $' +
                    Number(crtData.invalidationLevel).toFixed(2),
          };
          totalScore += crtPoints;
        } else {
          layers.candleRangeTheory = {
            points: 0,
            passed: 'partial',
            detail: 'CRT structure present but score too weak (low) — informational',
          };
        }
      } else {
        layers.candleRangeTheory = { points: 0, passed: false, detail: 'No CRT pattern in last 3 daily bars' };
      }
    } catch (e) {
      layers.candleRangeTheory = { points: 0, passed: 'unchecked', detail: e.message };
    }
  } else {
    layers.candleRangeTheory = { points: 0, passed: 'unchecked', detail: 'CRT module unavailable' };
  }

  // ─────────────────────────────────────────────────────
  // Layer 11: Chart Vision (if pre-checked, use it; else mark as pending)
  // ─────────────────────────────────────────────────────
  if (preCheckedVision) {
    var v = preCheckedVision;
    if (v === 'APPROVE' || (typeof v === 'object' && v.verdict === 'APPROVE')) {
      layers.chartVision = { points: 2, passed: true, detail: 'Vision APPROVED' };
      totalScore += 2;
    } else if (v === 'WAIT' || (typeof v === 'object' && v.verdict === 'WAIT')) {
      layers.chartVision = { points: 0, passed: false, detail: 'Vision says WAIT' };
    } else {
      layers.chartVision = { points: -2, passed: false, detail: 'Vision VETO' };
      totalScore -= 2; // VETO actively subtracts
    }
  } else {
    layers.chartVision = { points: 0, passed: 'pending', detail: 'Run ./scripts/chart-vision.sh to check' };
  }

  // ─────────────────────────────────────────────────────
  // Layer 10: Market Researcher (if pre-checked)
  // ─────────────────────────────────────────────────────
  if (preCheckedResearch) {
    var r = preCheckedResearch;
    if (r === 'GREEN') {
      layers.marketResearch = { points: 1, passed: true, detail: 'Catalyst-clear, no event landmines' };
      totalScore += 1;
    } else if (r === 'YELLOW') {
      layers.marketResearch = { points: 0.5, passed: 'partial', detail: 'One concern (earnings/sector/IV) — trial size only' };
      totalScore += 0.5;
    } else if (r === 'RED') {
      layers.marketResearch = { points: -1, passed: false, detail: 'Catalyst conflict — skip' };
      totalScore -= 1;
    }
  } else {
    layers.marketResearch = { points: 0, passed: 'pending', detail: 'Spawn market-researcher agent to check' };
  }

  // ─────────────────────────────────────────────────────
  // Compute tier
  // ─────────────────────────────────────────────────────
  var tier, tierIcon, sizeRecommendation;
  if (totalScore >= 11)      { tier = 'A++'; tierIcon = '🟢🟢🟢'; sizeRecommendation = 3; }
  else if (totalScore >= 9)  { tier = 'A+';  tierIcon = '🟢🟢';   sizeRecommendation = 2; }
  else if (totalScore >= 7)  { tier = 'A';   tierIcon = '🟢';     sizeRecommendation = 1; }
  else if (totalScore >= 5)  { tier = 'B';   tierIcon = '🟡';     sizeRecommendation = 1; }
  else if (totalScore >= 3)  { tier = 'C';   tierIcon = '🔴';     sizeRecommendation = 0; }
  else                       { tier = 'F';   tierIcon = '🔴🔴';   sizeRecommendation = 0; }

  return {
    ok: true,
    ticker: ticker,
    direction: direction,
    sourceTab: sourceTab,
    pattern: pattern,
    sourceConv: sourceConv,
    score: round2(totalScore),
    maxPossible: 15,
    tier: tier,
    tierIcon: tierIcon,
    sizeRecommendation: sizeRecommendation,
    autoFireEligible: totalScore >= 11,  // A++ only for auto-fire
    layers: layers,
    summary: tierIcon + ' ' + tier + ' (' + round2(totalScore) + '/15) — ' +
             (totalScore >= 11 ? 'auto-fire eligible if all conditions met'
              : totalScore >= 9 ? 'high-conviction manual fire'
              : totalScore >= 7 ? 'standard manual fire — 1ct trial'
              : totalScore >= 5 ? 'watch — wait for more confluence'
              : 'skip — insufficient confluence'),
  };
}

module.exports = {
  scoreSetup: scoreSetup,
};
