// =============================================================================
// JOHN PATTERN PROFILER (Phase 4.30B — May 5 2026 PM)
// =============================================================================
// Reads enriched_picks.json (built by johnPickAnalyzer.js) and clusters by
// structural label. Computes per-cluster stats: win rate, avg MFE, time to
// outcome, typical DTE / strike % OTM, common sectors, time-of-day.
//
// Output: /data/john_history/pattern_profiles.json
//   {
//     'BREAKOUT_LONG': {
//        sampleSize, winRate, avgMFE, avgTimeToTP1, typicalDTE, ...
//     },
//     ...
//   }
//
// Used by Phase 4.30C (live picker) to score candidates against John's
// historical baselines, and by Phase 4.30E (FIRE GRADE bonus) to grant +1
// or +2 grade points when a setup matches a high-win-rate John pattern.
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HISTORY_DIR = path.join(DATA_ROOT, 'john_history');
var LOCAL_HISTORY_DIR = path.join(__dirname, '..', 'data', 'john_history');

function getHistoryDir() {
  if (fs.existsSync(HISTORY_DIR)) return HISTORY_DIR;
  if (fs.existsSync(LOCAL_HISTORY_DIR)) return LOCAL_HISTORY_DIR;
  return null;
}

var ENRICHED_PATH_REMOTE = path.join(HISTORY_DIR, 'enriched_picks.json');
var ENRICHED_PATH_LOCAL = path.join(LOCAL_HISTORY_DIR, 'enriched_picks.json');
var PROFILES_PATH = path.join((getHistoryDir() || HISTORY_DIR), 'pattern_profiles.json');

function loadEnriched() {
  var paths = [ENRICHED_PATH_REMOTE, ENRICHED_PATH_LOCAL];
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        return JSON.parse(fs.readFileSync(paths[i], 'utf8')) || [];
      }
    } catch (e) {}
  }
  return [];
}

function pct(n, d) { if (!d) return 0; return Math.round((n / d) * 100) / 100; }

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
  var idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function median(arr) {
  return percentile(arr, 50);
}

function hourFromIso(iso) {
  if (!iso) return null;
  try {
    // Convert UTC to ET
    var d = new Date(iso);
    var etHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
    return etHour;
  } catch (e) { return null; }
}

function timeOfDay(hour) {
  if (hour == null) return 'UNKNOWN';
  if (hour < 9) return 'PRE_OPEN';
  if (hour < 12) return 'AM';
  if (hour < 14) return 'MIDDAY';
  if (hour < 17) return 'PM';
  return 'EOD';
}

function strikePctOTM(pick) {
  if (!pick.triggerPrice || !pick.strike) return null;
  var dir = (pick.direction || '').toLowerCase();
  if (dir === 'call') {
    return ((pick.strike - pick.triggerPrice) / pick.triggerPrice) * 100;
  }
  if (dir === 'put') {
    return ((pick.triggerPrice - pick.strike) / pick.triggerPrice) * 100;
  }
  return null;
}

function timeToOutcomeHours(pick) {
  if (!pick.outcome || !pick.outcome.computed) return null;
  var oc = pick.outcome;
  var endTime = oc.tp1Time || oc.stopTime;
  if (!endTime) return null;
  var startMs = new Date(pick.postedAt).getTime();
  var endMs = new Date(endTime).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return null;
  return (endMs - startMs) / (3600 * 1000);
}

function buildProfiles() {
  var enriched = loadEnriched();
  if (!enriched.length) return { ok: false, error: 'no enriched picks loaded', profiles: {} };

  var groups = {};
  enriched.forEach(function(e) {
    if (!e.reverseEngineering) return;
    var lab = e.reverseEngineering.structuralLabel || 'UNKNOWN';
    if (!groups[lab]) groups[lab] = [];
    groups[lab].push(e);
  });

  var profiles = {};
  Object.keys(groups).forEach(function(lab) {
    var items = groups[lab];
    var wins = items.filter(function(p) {
      var oc = p.outcome && p.outcome.finalOutcome;
      return oc === 'WIN_TP1' || oc === 'WIN_TP2' || oc === 'WIN_TP3';
    });
    var loss = items.filter(function(p) {
      return p.outcome && p.outcome.finalOutcome === 'LOSS_STOP';
    });
    var noTrigger = items.filter(function(p) {
      return p.outcome && p.outcome.finalOutcome === 'NO_TRIGGER';
    });
    var tp2Plus = items.filter(function(p) {
      var oc = p.outcome && p.outcome.finalOutcome;
      return oc === 'WIN_TP2' || oc === 'WIN_TP3';
    });
    var triggered = items.filter(function(p) { return p.outcome && p.outcome.triggerHit; });

    var mfes = items.map(function(p) { return p.outcome && p.outcome.maxFavorablePremPct; })
                    .filter(function(x) { return typeof x === 'number'; });
    var maes = items.map(function(p) { return p.outcome && p.outcome.maxAdversePremPct; })
                    .filter(function(x) { return typeof x === 'number'; });
    var dtes = items.map(function(p) { return p.dte; }).filter(function(x) { return typeof x === 'number'; });
    var otmPcts = items.map(strikePctOTM).filter(function(x) { return x !== null; });
    var hours = items.map(function(p) { return timeToOutcomeHours(p); }).filter(function(x) { return x !== null; });
    var postHours = items.map(function(p) { return hourFromIso(p.postedAt); }).filter(function(x) { return x !== null; });
    var tickers = items.map(function(p) { return p.ticker; });
    var tickerCounts = {};
    tickers.forEach(function(t) { tickerCounts[t] = (tickerCounts[t] || 0) + 1; });

    var todBuckets = {};
    postHours.forEach(function(h) {
      var b = timeOfDay(h);
      todBuckets[b] = (todBuckets[b] || 0) + 1;
    });
    var topTod = Object.keys(todBuckets).sort(function(a, b) {
      return todBuckets[b] - todBuckets[a];
    })[0] || 'UNKNOWN';

    profiles[lab] = {
      sampleSize: items.length,
      triggered: triggered.length,
      wins: wins.length,
      losses: loss.length,
      noTrigger: noTrigger.length,
      tp2Plus: tp2Plus.length,
      // Win rate based on TRIGGERED setups only (excludes no-trigger picks)
      winRate: triggered.length > 0 ? pct(wins.length, triggered.length) : 0,
      // Win rate over total sample (raw pickabiltiy)
      rawWinRate: pct(wins.length, items.length),
      lossRate: triggered.length > 0 ? pct(loss.length, triggered.length) : 0,
      avgMFE: mean(mfes) ? Math.round(mean(mfes) * 10) / 10 : null,
      medianMFE: median(mfes) ? Math.round(median(mfes) * 10) / 10 : null,
      avgMAE: mean(maes) ? Math.round(mean(maes) * 10) / 10 : null,
      avgTimeToTP1Hours: mean(hours) ? Math.round(mean(hours) * 10) / 10 : null,
      typicalDTE: {
        mean: mean(dtes) ? Math.round(mean(dtes) * 10) / 10 : null,
        median: median(dtes),
        p25: percentile(dtes, 25),
        p75: percentile(dtes, 75),
      },
      typicalStrikePctOTM: {
        mean: mean(otmPcts) ? Math.round(mean(otmPcts) * 10) / 10 : null,
        median: median(otmPcts) ? Math.round(median(otmPcts) * 10) / 10 : null,
        p25: percentile(otmPcts, 25) ? Math.round(percentile(otmPcts, 25) * 10) / 10 : null,
        p75: percentile(otmPcts, 75) ? Math.round(percentile(otmPcts, 75) * 10) / 10 : null,
      },
      timeOfDay: topTod,
      timeOfDayBuckets: todBuckets,
      typicalStopPct: 25,  // John's signature
      typicalTpLadder: [25, 50, 100],
      tickerVariety: Object.keys(tickerCounts).length,
      topTickers: Object.keys(tickerCounts).sort(function(a, b) {
        return tickerCounts[b] - tickerCounts[a];
      }).slice(0, 10).map(function(t) { return { ticker: t, count: tickerCounts[t] }; }),
    };
  });

  // Save
  try {
    var outPath = path.join(getHistoryDir() || HISTORY_DIR, 'pattern_profiles.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      enrichedCount: enriched.length,
      profiles: profiles,
    }, null, 2));
    return {
      ok: true,
      enrichedCount: enriched.length,
      labelCount: Object.keys(profiles).length,
      profiles: profiles,
      pathOut: outPath,
    };
  } catch (e) {
    return { ok: false, error: e.message, profiles: profiles };
  }
}

function loadProfiles() {
  var paths = [
    path.join(HISTORY_DIR, 'pattern_profiles.json'),
    path.join(LOCAL_HISTORY_DIR, 'pattern_profiles.json'),
  ];
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        return JSON.parse(fs.readFileSync(paths[i], 'utf8'));
      }
    } catch (e) {}
  }
  return null;
}

function getProfileForLabel(label) {
  var data = loadProfiles();
  if (!data || !data.profiles) return null;
  return data.profiles[label] || null;
}

function getTopProfiles(opts) {
  opts = opts || {};
  var minN = opts.minN || 3;
  var data = loadProfiles();
  if (!data || !data.profiles) return [];
  return Object.keys(data.profiles)
    .filter(function(lab) { return data.profiles[lab].sampleSize >= minN; })
    .sort(function(a, b) {
      return (data.profiles[b].winRate || 0) - (data.profiles[a].winRate || 0);
    })
    .map(function(lab) {
      var p = data.profiles[lab];
      return Object.assign({ label: lab }, p);
    });
}

module.exports = {
  buildProfiles: buildProfiles,
  loadProfiles: loadProfiles,
  getProfileForLabel: getProfileForLabel,
  getTopProfiles: getTopProfiles,
};
