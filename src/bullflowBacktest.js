// =============================================================================
// BULLFLOW BACKTEST — replay historical day, compute per-filter hit rate.
//
// API: GET /v1/streaming/backtesting?key=...&date=YYYY-MM-DD&speed=N
// SSE events: init, status, ready, heartbeat, alert, complete, error
//
// PURPOSE:
//   Validate our 10 saved Bullflow filter weights against historical reality.
//   Right now Phase 4.2.2 weights (5M+ Whale=9, 100k AA Sweep=8, etc.) are
//   guesses. Backtest replays a day's flow, captures every alert that matched
//   AB's saved filters, then we cross-reference with peak-return endpoint to
//   compute: % of alerts that peaked >25% / >50% / >100% within 24h, per filter.
//
// USAGE:
//   POST /api/backtest/run { date: "2026-04-28", speed: 60 }
//   POST /api/backtest/range { startDate, endDate, speed: 60 } (multi-day)
//   GET  /api/backtest/results — last run aggregate
//   GET  /api/backtest/per-filter — hit rate breakdown by filter name
// =============================================================================

var fs = require('fs');
var path = require('path');
var https = require('https');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var RESULTS_FILE = path.join(DATA_ROOT, 'backtest_results.json');

var peakReturn = null;
try { peakReturn = require('./bullflowPeakReturn'); } catch (e) {}
var bullflowFilters = null;
try { bullflowFilters = require('./bullflowFilters'); } catch (e) {}

function getApiKey() {
  return process.env.BULLFLOW_API_KEY ||
    (function() {
      try {
        var keyFile = path.join(DATA_ROOT, 'bullflow_api_key.txt');
        if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
      } catch (e) {}
      return null;
    })();
}

function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); }
  catch (e) { return { runs: [], aggregates: {} }; }
}

function saveResults(data) {
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[BACKTEST] save error:', e.message); }
}

// Parse OPRA-style symbol "O:NVDA260515C00200000" or "NVDA260515C00200000"
// Returns { ticker, dateYYMMDD, callPut, strike }
function parseOpra(sym) {
  if (!sym) return null;
  var s = sym.replace(/^O:/, '');
  var m = s.match(/^([A-Z]{1,6})(\d{6})([CP])(\d+)$/);
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: m[2],
    callPut: m[3],
    strike: parseInt(m[4], 10) / 1000,
  };
}

// Run backtest for a single date. Returns { ok, alerts: [], summary: {...} }
function runBacktest(date, options) {
  options = options || {};
  var speed = options.speed || 60;
  var apiKey = getApiKey();
  if (!apiKey) return Promise.resolve({ ok: false, error: 'no API key' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Promise.resolve({ ok: false, error: 'date must be YYYY-MM-DD' });
  }

  return new Promise(function(resolve) {
    var collected = [];
    var status = { customAlertCount: 0, algoAlertCount: 0, replayDate: date };
    var startedAt = Date.now();
    var url = 'https://api.bullflow.io/v1/streaming/backtesting'
      + '?key=' + encodeURIComponent(apiKey)
      + '&date=' + encodeURIComponent(date)
      + '&speed=' + encodeURIComponent(speed);

    var req = https.get(url, { headers: { 'Accept': 'text/event-stream' } }, function(res) {
      if (res.statusCode !== 200) {
        var body = '';
        res.on('data', function(c) { body += c.toString(); });
        res.on('end', function() {
          resolve({ ok: false, error: 'http ' + res.statusCode + ': ' + body.slice(0, 300) });
        });
        return;
      }

      var buffer = '';
      res.on('data', function(chunk) {
        buffer += chunk.toString();
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function(line) {
          var trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          var raw = trimmed.slice(6).trim();
          if (!raw || raw === '{}') return;
          try {
            var msg = JSON.parse(raw);
            var event = msg.event || '';
            if (event === 'alert' && msg.data) {
              collected.push({
                sequence: msg.sequence,
                id: msg.id,
                alertType: msg.data.alertType,
                symbol: msg.data.symbol,
                alertName: msg.data.alertName,
                alertPremium: parseFloat(msg.data.alertPremium || 0),
                tradePrice: parseFloat(msg.data.tradePrice || 0),
                timestamp: msg.data.timestamp,
                estTimestamp: msg.data.estTimestamp,
              });
            } else if (event === 'ready') {
              status.totalTrades = msg.totalTrades;
              status.customAlerts = msg.customAlerts;
              status.algoAlerts = msg.algoAlerts;
              status.totalReplayAlerts = msg.totalReplayAlerts;
            } else if (event === 'complete') {
              status.alertsSent = msg.alertsSent;
              status.elapsedSeconds = msg.elapsedSeconds;
            } else if (event === 'error') {
              status.error = msg.message || msg.error || 'unknown';
            }
          } catch (e) {
            console.error('[BACKTEST] parse error:', e.message);
          }
        });
      });

      res.on('end', function() {
        status.collected = collected.length;
        status.elapsedMs = Date.now() - startedAt;
        resolve({ ok: true, date: date, alerts: collected, summary: status });
      });

      res.on('error', function(e) {
        resolve({ ok: false, error: e.message, partial: collected });
      });
    });

    req.on('error', function(e) {
      resolve({ ok: false, error: e.message });
    });
  });
}

// Aggregate alerts by filter name + compute peak-return stats per filter
async function analyzeWithPeakReturns(alerts, options) {
  options = options || {};
  var skipPeakReturn = options.skipPeakReturn || false;

  // Group by filter
  var byFilter = {};
  alerts.forEach(function(a) {
    var name = (a.alertName || 'unknown').toLowerCase();
    if (!byFilter[name]) {
      byFilter[name] = {
        name: a.alertName,
        alertType: a.alertType,
        count: 0,
        totalPremium: 0,
        peakReturns: [],
        knownFilter: bullflowFilters && bullflowFilters.getFilterMeta(name).known,
      };
    }
    byFilter[name].count++;
    byFilter[name].totalPremium += a.alertPremium;
  });

  // Hydrate peak return for each alert (rate-limit aware)
  var hydrated = 0;
  var failed = 0;
  if (peakReturn && !skipPeakReturn) {
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      if (!a.symbol || !a.tradePrice || !a.timestamp) continue;
      var pr = await peakReturn.getPeakReturn(a.symbol, a.tradePrice, a.timestamp);
      if (pr.ok) {
        var name = (a.alertName || 'unknown').toLowerCase();
        byFilter[name].peakReturns.push(pr.peakPercent);
        a.peakPercent = pr.peakPercent;
        hydrated++;
      } else {
        failed++;
      }
      // Don't hammer beyond ~50/min
      if (i > 0 && i % 50 === 0) await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }

  // Compute per-filter stats
  var filterStats = Object.keys(byFilter).map(function(key) {
    var f = byFilter[key];
    var prs = f.peakReturns;
    var stats = {
      filterName: f.name,
      alertType: f.alertType,
      count: f.count,
      knownFilter: f.knownFilter,
      avgPremium: Math.round(f.totalPremium / f.count),
      peakReturnSample: prs.length,
    };
    if (prs.length > 0) {
      var sorted = prs.slice().sort(function(a, b) { return a - b; });
      stats.median = sorted[Math.floor(sorted.length / 2)];
      stats.avg = prs.reduce(function(s, x) { return s + x; }, 0) / prs.length;
      stats.max = sorted[sorted.length - 1];
      stats.pctOver25 = (prs.filter(function(p) { return p >= 25; }).length / prs.length * 100);
      stats.pctOver50 = (prs.filter(function(p) { return p >= 50; }).length / prs.length * 100);
      stats.pctOver100 = (prs.filter(function(p) { return p >= 100; }).length / prs.length * 100);
    }
    return stats;
  }).sort(function(a, b) { return (b.avg || 0) - (a.avg || 0); });

  return {
    totalAlerts: alerts.length,
    hydratedCount: hydrated,
    failedHydrate: failed,
    filterStats: filterStats,
  };
}

// Run backtest + analyze + persist
async function runAndAnalyze(date, options) {
  options = options || {};
  var bt = await runBacktest(date, options);
  if (!bt.ok) return bt;

  var analysis = await analyzeWithPeakReturns(bt.alerts, options);

  var record = {
    date: date,
    runAt: new Date().toISOString(),
    summary: bt.summary,
    analysis: analysis,
  };

  var results = loadResults();
  results.runs.push(record);
  if (results.runs.length > 90) results.runs = results.runs.slice(-90);
  // Recompute aggregate across all runs
  results.aggregates = recomputeAggregate(results.runs);
  saveResults(results);

  return { ok: true, record: record };
}

// Aggregate stats across all runs
function recomputeAggregate(runs) {
  var byFilter = {};
  runs.forEach(function(r) {
    if (!r.analysis || !r.analysis.filterStats) return;
    r.analysis.filterStats.forEach(function(s) {
      var key = (s.filterName || 'unknown').toLowerCase();
      if (!byFilter[key]) {
        byFilter[key] = {
          filterName: s.filterName,
          alertType: s.alertType,
          totalCount: 0,
          totalPeakSamples: 0,
          weightedSumOver25: 0,
          weightedSumOver50: 0,
          weightedSumOver100: 0,
          weightedSumAvg: 0,
        };
      }
      var f = byFilter[key];
      f.totalCount += s.count;
      if (s.peakReturnSample > 0) {
        f.totalPeakSamples += s.peakReturnSample;
        f.weightedSumOver25 += (s.pctOver25 || 0) * s.peakReturnSample;
        f.weightedSumOver50 += (s.pctOver50 || 0) * s.peakReturnSample;
        f.weightedSumOver100 += (s.pctOver100 || 0) * s.peakReturnSample;
        f.weightedSumAvg += (s.avg || 0) * s.peakReturnSample;
      }
    });
  });

  return Object.keys(byFilter).map(function(k) {
    var f = byFilter[k];
    return {
      filterName: f.filterName,
      alertType: f.alertType,
      totalCount: f.totalCount,
      totalPeakSamples: f.totalPeakSamples,
      hitRate25: f.totalPeakSamples ? f.weightedSumOver25 / f.totalPeakSamples : 0,
      hitRate50: f.totalPeakSamples ? f.weightedSumOver50 / f.totalPeakSamples : 0,
      hitRate100: f.totalPeakSamples ? f.weightedSumOver100 / f.totalPeakSamples : 0,
      avgPeakReturn: f.totalPeakSamples ? f.weightedSumAvg / f.totalPeakSamples : 0,
    };
  }).sort(function(a, b) { return b.avgPeakReturn - a.avgPeakReturn; });
}

// Run multiple days back-to-back (rate-limit aware via peakReturn throttling)
async function runRange(startDate, endDate, options) {
  options = options || {};
  var dates = [];
  var cur = new Date(startDate + 'T00:00:00Z');
  var end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    var d = cur.toISOString().slice(0, 10);
    var dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d);  // skip weekends
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  var results = [];
  for (var i = 0; i < dates.length; i++) {
    console.log('[BACKTEST] running ' + dates[i] + ' (' + (i+1) + '/' + dates.length + ')');
    var r = await runAndAnalyze(dates[i], options);
    results.push({ date: dates[i], ok: r.ok, summary: r.record && r.record.summary });
    // Pause between runs to avoid rate-limit storm
    await new Promise(function(r) { setTimeout(r, 3000); });
  }
  return { ok: true, datesRun: dates.length, results: results };
}

module.exports = {
  runBacktest: runBacktest,
  runAndAnalyze: runAndAnalyze,
  runRange: runRange,
  loadResults: loadResults,
  parseOpra: parseOpra,
};
