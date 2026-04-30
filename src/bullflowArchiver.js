// bullflowArchiver.js — Apr 30 2026
// One-shot Bullflow historical backfill. Captures EVERY alert (not just aggregates)
// from /v1/streaming/backtesting at speed=60 for any date range, persists to /data
// volume on Railway so files survive deploys.
//
// Full alert preservation (vs backtester.js which only stores aggregates).
// AB is canceling the API tier — this is our archival pass while access is live.
//
// Endpoints exposed via server.js:
//   POST /api/admin/bullflow-archive/start  { startDate, endDate, speed?, force? }
//   GET  /api/admin/bullflow-archive/status
//   GET  /api/admin/bullflow-archive/list
//   GET  /api/admin/bullflow-archive/download/:date

var fs = require('fs');
var path = require('path');
var fetch = require('node-fetch');

// On Railway use /data (persistent volume); locally fall back to flow-scout/data.
var DATA_ROOT = process.env.DATA_DIR || (
  fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data')
);
var ARCHIVE_DIR = path.join(DATA_ROOT, 'bullflow_archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

var BULLFLOW_URL = 'https://api.bullflow.io/v1/streaming/backtesting';

// In-memory job state. Single-job model — if a backfill is running, the start
// endpoint refuses a second one until done.
var jobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  startDate: null,
  endDate: null,
  speed: 60,
  totalDays: 0,
  daysDone: 0,
  daysSkipped: 0,
  daysErrored: 0,
  currentDate: null,
  currentEvents: 0,
  currentAlerts: 0,
  log: [],          // last 200 log lines
  lastError: null,
};

function logLine(msg) {
  var stamp = new Date().toISOString();
  var line = '[' + stamp + '] ' + msg;
  console.log('[ARCHIVER]', msg);
  jobState.log.push(line);
  if (jobState.log.length > 200) jobState.log.shift();
}

// ----- date helpers -----
function isWeekend(d) { return d.getUTCDay() === 0 || d.getUTCDay() === 6; }
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function parseDate(s) { return new Date(s + 'T00:00:00Z'); }
function tradingDaysBetween(startStr, endStr) {
  var days = [];
  var d = parseDate(startStr);
  var end = parseDate(endStr);
  while (d <= end) {
    if (!isWeekend(d)) days.push(fmtDate(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ----- single-day archival -----
async function archiveOneDay(date, speed, force) {
  var outFile = path.join(ARCHIVE_DIR, date + '.json');
  if (!force && fs.existsSync(outFile)) {
    var sz = fs.statSync(outFile).size;
    if (sz > 1000) return { date: date, skipped: 'exists', size: sz };
  }

  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return { date: date, error: 'BULLFLOW_API_KEY missing' };

  var url = BULLFLOW_URL + '?key=' + encodeURIComponent(apiKey)
                         + '&date=' + encodeURIComponent(date)
                         + '&speed=' + (speed || 60);

  jobState.currentDate = date;
  jobState.currentEvents = 0;
  jobState.currentAlerts = 0;

  var t0 = Date.now();
  var res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'text/event-stream' } });
  } catch (e) {
    return { date: date, error: 'fetch-failed:' + e.message };
  }
  if (!res.ok) {
    var bodyText = '';
    try { bodyText = (await res.text()).slice(0, 200); } catch(e) {}
    return { date: date, error: 'HTTP ' + res.status, body: bodyText };
  }

  var alerts = [];        // every alert event captured
  var heartbeats = [];    // sample of heartbeats for timing context
  var initEvent = null;
  var readyEvent = null;
  var completeEvent = null;
  var errorEvent = null;
  var rawBytes = 0;

  await new Promise(function(resolve, reject) {
    var settled = false;
    var buffer = '';
    function finish(reason) {
      if (settled) return; settled = true;
      try { res.body.destroy(); } catch(e) {}
      resolve(reason);
    }
    // Soft cap: 8 minutes per day (at speed=60 a normal day finishes in ~6 min)
    var timer = setTimeout(function() { finish('soft-timeout'); }, 8 * 60 * 1000);

    res.body.on('data', function(chunk) {
      rawBytes += chunk.length;
      buffer += chunk.toString('utf8');
      // SSE frames split by \n\n
      var frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (var i = 0; i < frames.length; i++) {
        var line = frames[i].trim();
        if (!line || !line.startsWith('data:')) continue;
        var payload = line.replace(/^data:\s*/, '');
        var evt;
        try { evt = JSON.parse(payload); } catch(e) { continue; }
        var etype = evt.event;
        if (etype === 'init') initEvent = evt;
        else if (etype === 'status') { /* one-time init message */ }
        else if (etype === 'ready') { readyEvent = evt; }
        else if (etype === 'heartbeat') {
          if (heartbeats.length < 50) heartbeats.push(evt.playbackTime);
        }
        else if (etype === 'alert') {
          alerts.push(evt.data);  // full alert payload preserved
          jobState.currentAlerts++;
        }
        else if (etype === 'complete') {
          completeEvent = evt;
          clearTimeout(timer);
          finish('complete');
          return;
        }
        else if (etype === 'error') {
          errorEvent = evt;
          clearTimeout(timer);
          finish('error-event');
          return;
        }
        jobState.currentEvents++;
      }
    });
    res.body.on('end', function() { clearTimeout(timer); finish('stream-end'); });
    res.body.on('error', function(e) { clearTimeout(timer); finish('stream-error:' + e.message); });
  });

  var elapsedSec = Math.round((Date.now() - t0) / 1000);

  if (errorEvent) {
    return { date: date, error: 'stream-error', errorEvent: errorEvent, elapsedSec: elapsedSec };
  }

  // Build the archive record — full preservation
  var record = {
    archiveVersion: 1,
    archivedAt: new Date().toISOString(),
    date: date,
    speed: speed,
    elapsedSec: elapsedSec,
    rawBytes: rawBytes,
    init: initEvent,
    ready: readyEvent,
    complete: completeEvent,
    counts: {
      alerts: alerts.length,
      heartbeatsSeen: heartbeats.length,
      events: jobState.currentEvents,
    },
    heartbeats: heartbeats,    // first 50 for timing context
    alerts: alerts,            // FULL alert array
  };

  fs.writeFileSync(outFile, JSON.stringify(record));   // dense, no pretty-print, 1 file/day

  return {
    date: date,
    ok: true,
    alerts: alerts.length,
    elapsedSec: elapsedSec,
    sizeKB: Math.round(fs.statSync(outFile).size / 1024),
  };
}

// ----- backfill orchestrator -----
async function runBackfill(opts) {
  if (jobState.running) {
    return { error: 'job already running', state: getStatus() };
  }
  var startDate = opts.startDate;
  var endDate   = opts.endDate;
  var speed     = parseInt(opts.speed || 60);
  var force     = !!opts.force;

  if (!startDate || !endDate) return { error: 'startDate and endDate required (YYYY-MM-DD)' };
  if (startDate < '2025-06-01') return { error: 'startDate must be >= 2025-06-01 (Bullflow data limit)' };

  var days = tradingDaysBetween(startDate, endDate);
  if (!days.length) return { error: 'no trading days in range' };

  // Reset state for new job
  jobState = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    startDate: startDate,
    endDate: endDate,
    speed: speed,
    totalDays: days.length,
    daysDone: 0,
    daysSkipped: 0,
    daysErrored: 0,
    currentDate: null,
    currentEvents: 0,
    currentAlerts: 0,
    log: [],
    lastError: null,
    results: [],
  };

  logLine('backfill starting: ' + startDate + ' → ' + endDate + ' (' + days.length + ' trading days, speed=' + speed + ', force=' + force + ')');

  // Run sequentially in background — return immediately to caller.
  setImmediate(async function() {
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      logLine((i + 1) + '/' + days.length + ' starting ' + d);
      try {
        var r = await archiveOneDay(d, speed, force);
        jobState.results.push(r);
        if (r.skipped) {
          jobState.daysSkipped++;
          logLine((i + 1) + '/' + days.length + ' SKIP ' + d + ' (already archived)');
        } else if (r.error) {
          jobState.daysErrored++;
          jobState.lastError = r.error;
          logLine((i + 1) + '/' + days.length + ' ERROR ' + d + ' : ' + r.error);
        } else {
          jobState.daysDone++;
          logLine((i + 1) + '/' + days.length + ' OK ' + d + ' (' + r.alerts + ' alerts, ' + r.elapsedSec + 's, ' + r.sizeKB + 'KB)');
        }
      } catch (e) {
        jobState.daysErrored++;
        jobState.lastError = e.message;
        logLine((i + 1) + '/' + days.length + ' EXCEPTION ' + d + ' : ' + e.message);
        jobState.results.push({ date: d, error: 'exception:' + e.message });
      }
      // Be polite — 1s pause between days
      await new Promise(function(res) { setTimeout(res, 1000); });
    }
    jobState.running = false;
    jobState.finishedAt = new Date().toISOString();
    jobState.currentDate = null;
    logLine('backfill DONE — done=' + jobState.daysDone + ' skipped=' + jobState.daysSkipped + ' errored=' + jobState.daysErrored);

    // Write summary
    fs.writeFileSync(path.join(ARCHIVE_DIR, '_SUMMARY.json'), JSON.stringify({
      finishedAt: jobState.finishedAt,
      startedAt: jobState.startedAt,
      startDate: startDate,
      endDate: endDate,
      speed: speed,
      counts: { done: jobState.daysDone, skipped: jobState.daysSkipped, errored: jobState.daysErrored },
      results: jobState.results,
    }, null, 2));
  });

  return { ok: true, message: 'backfill started in background', totalDays: days.length };
}

function getStatus() {
  return {
    running: jobState.running,
    startedAt: jobState.startedAt,
    finishedAt: jobState.finishedAt,
    startDate: jobState.startDate,
    endDate: jobState.endDate,
    speed: jobState.speed,
    progress: jobState.totalDays
      ? { done: jobState.daysDone, skipped: jobState.daysSkipped, errored: jobState.daysErrored, total: jobState.totalDays, pct: Math.round((jobState.daysDone + jobState.daysSkipped + jobState.daysErrored) / jobState.totalDays * 100) }
      : null,
    current: jobState.currentDate ? {
      date: jobState.currentDate,
      eventsSeen: jobState.currentEvents,
      alertsCaptured: jobState.currentAlerts,
    } : null,
    lastError: jobState.lastError,
    archiveDir: ARCHIVE_DIR,
    log: jobState.log.slice(-30),
  };
}

function listArchive() {
  try {
    var files = fs.readdirSync(ARCHIVE_DIR)
      .filter(function(f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); })
      .sort();
    return files.map(function(f) {
      var fp = path.join(ARCHIVE_DIR, f);
      var st = fs.statSync(fp);
      return { date: f.replace('.json', ''), sizeKB: Math.round(st.size / 1024), mtime: st.mtime };
    });
  } catch (e) {
    return { error: e.message };
  }
}

function readArchiveFile(date) {
  var fp = path.join(ARCHIVE_DIR, date + '.json');
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

// ============================================================
// PEAK-RETURN ENRICHMENT — second pass over already-archived days
// ============================================================
//
// Bullflow rate limits /v1/data/peakReturn to 60 req/min per key.
// We throttle to ~50/min to stay safe and run selectively (top-N
// alerts per day by premium) since 60 days × 500 alerts = 30K calls.
//
// Param contract per docs:
//   key, sym (OPRA, e.g. O:SPY260408C00520000), old_price (number),
//   trade_timestamp (Unix int)

var enrichState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  topN: 0,
  totalCalls: 0,
  callsDone: 0,
  callsErrored: 0,
  currentDate: null,
  lastError: null,
  log: [],
};

function enrichLog(msg) {
  var stamp = new Date().toISOString();
  console.log('[ENRICH]', msg);
  enrichState.log.push('[' + stamp + '] ' + msg);
  if (enrichState.log.length > 200) enrichState.log.shift();
}

async function getPeakReturn(sym, oldPrice, tradeTimestamp) {
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return { error: 'no api key' };
  var url = 'https://api.bullflow.io/v1/data/peakReturn'
    + '?key=' + encodeURIComponent(apiKey)
    + '&sym=' + encodeURIComponent(sym)
    + '&old_price=' + encodeURIComponent(oldPrice)
    + '&trade_timestamp=' + encodeURIComponent(tradeTimestamp);
  try {
    var res = await fetch(url, { timeout: 15000 });
    if (!res.ok) {
      var t = '';
      try { t = (await res.text()).slice(0, 120); } catch(e) {}
      return { error: 'HTTP ' + res.status, body: t };
    }
    return await res.json();
  } catch (e) {
    return { error: 'fetch:' + e.message };
  }
}

// Pick top N alerts per day by premium for enrichment
function pickTopAlerts(alerts, topN) {
  if (!alerts || !alerts.length) return [];
  // Sort by premium DESC, take top N. Skip if missing tradePrice/timestamp.
  return alerts
    .filter(function(a) { return a && a.symbol && a.tradePrice && a.timestamp; })
    .sort(function(a, b) { return (b.alertPremium || 0) - (a.alertPremium || 0); })
    .slice(0, topN);
}

async function enrichDay(date, topN) {
  var fp = path.join(ARCHIVE_DIR, date + '.json');
  if (!fs.existsSync(fp)) return { date: date, error: 'archive missing' };
  var record;
  try { record = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return { date: date, error: 'parse:' + e.message }; }

  var top = pickTopAlerts(record.alerts || [], topN);
  if (!top.length) return { date: date, enrichments: 0, note: 'no alerts to enrich' };

  // Throttle ~50 req/min = 1200ms per call
  var enrichments = [];
  for (var i = 0; i < top.length; i++) {
    var a = top[i];
    var pr = await getPeakReturn(a.symbol, a.tradePrice, a.timestamp);
    enrichments.push({
      symbol: a.symbol,
      alertName: a.alertName,
      alertType: a.alertType,
      alertPremium: a.alertPremium,
      tradePrice: a.tradePrice,
      timestamp: a.timestamp,
      estTimestamp: a.estTimestamp,
      peak: pr,
    });
    enrichState.callsDone++;
    if (pr.error) enrichState.callsErrored++;
    enrichState.totalCalls++;
    // 1200ms throttle
    await new Promise(function(r) { setTimeout(r, 1200); });
  }

  // Save enrichments alongside the daily file
  record.enrichments = {
    enrichedAt: new Date().toISOString(),
    topN: topN,
    items: enrichments,
  };
  fs.writeFileSync(fp, JSON.stringify(record));
  return { date: date, enrichments: enrichments.length };
}

async function runEnrichSweep(opts) {
  if (enrichState.running) return { error: 'enrich job already running' };
  if (jobState.running) return { error: 'backfill running, wait until done' };
  var topN = parseInt(opts.topN || 10);
  var startDate = opts.startDate;
  var endDate   = opts.endDate;

  // List archived days in range
  var files = listArchive();
  if (!Array.isArray(files)) return { error: 'no archive found' };
  var inRange = files.filter(function(f) {
    if (startDate && f.date < startDate) return false;
    if (endDate && f.date > endDate) return false;
    return true;
  }).map(function(f) { return f.date; });

  if (!inRange.length) return { error: 'no archived days in range' };

  enrichState = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    topN: topN,
    totalCalls: 0,
    callsDone: 0,
    callsErrored: 0,
    currentDate: null,
    lastError: null,
    log: [],
    daysDone: 0,
    totalDays: inRange.length,
  };

  enrichLog('enrich sweep starting: ' + inRange.length + ' days, topN=' + topN);

  setImmediate(async function() {
    for (var i = 0; i < inRange.length; i++) {
      var d = inRange[i];
      enrichState.currentDate = d;
      enrichLog((i + 1) + '/' + inRange.length + ' ' + d);
      try {
        var r = await enrichDay(d, topN);
        if (r.error) enrichLog('  error: ' + r.error);
        else enrichLog('  +' + r.enrichments + ' enrichments');
        enrichState.daysDone++;
      } catch (e) {
        enrichState.lastError = e.message;
        enrichLog('  exception: ' + e.message);
      }
    }
    enrichState.running = false;
    enrichState.finishedAt = new Date().toISOString();
    enrichState.currentDate = null;
    enrichLog('enrich sweep DONE — calls=' + enrichState.callsDone + ' errored=' + enrichState.callsErrored);
  });

  return { ok: true, message: 'enrich sweep started', totalDays: inRange.length };
}

function getEnrichStatus() {
  return {
    running: enrichState.running,
    startedAt: enrichState.startedAt,
    finishedAt: enrichState.finishedAt,
    topN: enrichState.topN,
    totalDays: enrichState.totalDays,
    daysDone: enrichState.daysDone,
    callsDone: enrichState.callsDone,
    callsErrored: enrichState.callsErrored,
    currentDate: enrichState.currentDate,
    log: (enrichState.log || []).slice(-30),
  };
}

module.exports = {
  // Backfill
  runBackfill: runBackfill,
  getStatus: getStatus,
  listArchive: listArchive,
  readArchiveFile: readArchiveFile,
  archiveOneDay: archiveOneDay,        // exposed for one-off test calls
  // Enrichment
  runEnrichSweep: runEnrichSweep,
  getEnrichStatus: getEnrichStatus,
  enrichDay: enrichDay,
  getPeakReturn: getPeakReturn,        // exposed for direct lookups
  // Constants
  ARCHIVE_DIR: ARCHIVE_DIR,
};
