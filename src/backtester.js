// backtester.js — replay a historical day from Bullflow /backtesting SSE,
// evaluate each algo alert against the live executeNow gates + sizing ladder,
// call /data/peakReturn on simulated entries, aggregate stats.
//
// ADDITIVE ONLY. Does not touch brain state, does not place orders, does not
// mutate any live file. Pure simulation.

const fetch = require('node-fetch');

const BULLFLOW_BASE = 'https://api.bullflow.io/v1';

async function runBacktest(opts) {
  var date = opts && opts.date;
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return { error: 'BULLFLOW_API_KEY missing' };
  if (!date) return { error: 'date required (YYYY-MM-DD)' };

  var executeNow = null;
  try { executeNow = require('./executeNow'); } catch(e) {}

  var stats = {
    date: date,
    eventsReceived: 0,
    algoAlerts: 0,
    customAlerts: 0,
    wouldExecute: 0,
    wouldBlock: 0,
    blockReasons: {},
    simulated: [],
  };

  // Probe candidate URL patterns since Bullflow didn't publish exact path.
  var candidates = [
    BULLFLOW_BASE + '/backtesting?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
    BULLFLOW_BASE + '/streaming/backtesting?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
    'https://api.bullflow.io/backtesting?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
    BULLFLOW_BASE + '/backtest?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
    BULLFLOW_BASE + '/streaming/backtest?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
    'https://api.bullflow.io/v1/replay?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date),
  ];

  var res = null;
  var winningUrl = null;
  var probe = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    var cu = candidates[ci];
    try {
      var r = await fetch(cu, { headers: { 'Accept': 'text/event-stream' } });
      probe.push({ url: cu.replace(apiKey, 'REDACTED'), status: r.status });
      if (r.ok) { res = r; winningUrl = cu; break; }
    } catch(e) {
      probe.push({ url: cu.replace(apiKey, 'REDACTED'), error: e.message });
    }
  }
  if (!res) return { error: 'no candidate URL returned 200', probe: probe };
  console.log('[BACKTEST] Winning URL: ' + winningUrl.replace(apiKey, 'REDACTED'));
  stats.winningUrl = winningUrl.replace(apiKey, 'REDACTED');

  // Read body as a stream with a soft timeout + terminal-event detection.
  // SSE stays open — we stop when we see event=end/complete/done or timeout.
  var raw = '';
  var SOFT_TIMEOUT_MS = (opts && opts.timeoutMs) || 90000;
  var startedAt = Date.now();
  try {
    await new Promise(function(resolve, reject) {
      var settled = false;
      function finish(reason) {
        if (settled) return; settled = true;
        stats.streamEndReason = reason;
        try { res.body.destroy(); } catch(e) {}
        resolve();
      }
      var timer = setTimeout(function() { finish('soft-timeout'); }, SOFT_TIMEOUT_MS);
      res.body.on('data', function(chunk) {
        raw += chunk.toString('utf8');
        // Peek for terminal markers
        if (/"event"\s*:\s*"(end|complete|done|finished)"/i.test(raw)) {
          clearTimeout(timer);
          finish('terminal-event');
        }
        // Hard cap raw buffer at 10MB to prevent runaway memory
        if (raw.length > 10 * 1024 * 1024) {
          clearTimeout(timer);
          finish('buffer-cap');
        }
      });
      res.body.on('end', function() { clearTimeout(timer); finish('stream-end'); });
      res.body.on('error', function(e) { clearTimeout(timer); finish('stream-error:' + e.message); });
    });
  } catch(e) { return { error: 'stream read failed: ' + e.message }; }
  stats.streamMs = Date.now() - startedAt;
  stats.rawBytes = raw.length;

  // Parse SSE envelope. Events look like: "data: {...}\n\n"
  stats.rawFirst500 = raw.slice(0, 500);
  stats.sampleEvents = [];
  var chunks = raw.split('\n\n');
  for (var i = 0; i < chunks.length; i++) {
    var line = chunks[i].trim();
    if (!line || !line.startsWith('data:')) continue;
    var payload = line.replace(/^data:\s*/, '');
    var evt;
    try { evt = JSON.parse(payload); } catch(e) { continue; }
    stats.eventsReceived++;
    if (stats.sampleEvents.length < 3) stats.sampleEvents.push(evt);

    // Event envelope: { event: "init"|"status"|"error"|"alert"|"algo"|"custom"|... }
    var etype = (evt.event || evt.type || '').toLowerCase();
    if (etype === 'init' || etype === 'status' || etype === 'error' || etype === 'heartbeat') continue;
    if (etype === 'custom' || etype === 'custom-alert' || evt.matchedCustomAlert) stats.customAlerts++;
    if (etype === 'algo' || etype === 'alert' || evt.alertType) stats.algoAlerts++;

    // Simulate execution gate
    if (!executeNow || !executeNow.shouldExecute) continue;
    var ticker = (evt.ticker || evt.symbol || '').toString().replace(/^O:/, '').match(/^[A-Z]+/);
    ticker = ticker ? ticker[0] : null;
    if (!ticker) continue;

    var direction = 'CALLS';
    var sym = (evt.symbol || evt.rawSymbol || '').toString();
    if (/P\d+$/.test(sym) || /put/i.test(evt.alertType || '')) direction = 'PUTS';

    var fakeSignal = {
      ticker: ticker,
      direction: direction,
      type: direction === 'PUTS' ? 'put' : 'call',
      source: evt.source || 'BACKTEST_ALGO',
      confluence: evt.confluence || '4/6',
      premium: evt.premium || 0,
      timestamp: evt.timestamp || null,
    };

    var decision;
    try { decision = executeNow.shouldExecute(fakeSignal, { backtest: true }); }
    catch(e) { decision = { execute: false, reason: 'gate error: ' + e.message }; }

    if (decision && decision.execute) {
      stats.wouldExecute++;
    } else {
      stats.wouldBlock++;
      var reason = (decision && decision.reason) || 'unknown';
      stats.blockReasons[reason] = (stats.blockReasons[reason] || 0) + 1;
    }

    if (stats.simulated.length < 200) {
      stats.simulated.push({
        ticker: ticker,
        direction: direction,
        ts: evt.timestamp,
        execute: !!(decision && decision.execute),
        reason: decision && decision.reason,
      });
    }
  }

  return { status: 'OK', stats: stats };
}

async function getPeakReturn(opts) {
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return { error: 'BULLFLOW_API_KEY missing' };
  if (!opts || !opts.symbol || !opts.timestamp) return { error: 'symbol and timestamp required' };

  var url = BULLFLOW_BASE + '/data/peakReturn?key=' + encodeURIComponent(apiKey) +
            '&symbol=' + encodeURIComponent(opts.symbol) +
            '&timestamp=' + encodeURIComponent(opts.timestamp);

  try {
    var res = await fetch(url);
    if (!res.ok) return { error: 'HTTP ' + res.status };
    return await res.json();
  } catch(e) {
    return { error: e.message };
  }
}

module.exports = { runBacktest: runBacktest, getPeakReturn: getPeakReturn };
