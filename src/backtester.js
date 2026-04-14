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

  var url = BULLFLOW_BASE + '/backtesting?key=' + encodeURIComponent(apiKey) + '&date=' + encodeURIComponent(date);
  console.log('[BACKTEST] Fetching ' + url.replace(apiKey, 'REDACTED'));

  var res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'text/event-stream' } });
  } catch(e) {
    return { error: 'fetch failed: ' + e.message };
  }
  if (!res.ok) return { error: 'HTTP ' + res.status, body: await res.text().catch(function() { return ''; }) };

  // Read body as text (SSE stream as single shot — good enough for historical replay)
  var raw = '';
  try { raw = await res.text(); } catch(e) { return { error: 'body read failed: ' + e.message }; }

  // Parse SSE envelope. Events look like: "data: {...}\n\n"
  var chunks = raw.split('\n\n');
  for (var i = 0; i < chunks.length; i++) {
    var line = chunks[i].trim();
    if (!line || !line.startsWith('data:')) continue;
    var payload = line.replace(/^data:\s*/, '');
    var evt;
    try { evt = JSON.parse(payload); } catch(e) { continue; }
    stats.eventsReceived++;

    // Event shape guess: { type: 'algo'|'custom', symbol, ticker, alertType, premium, timestamp, ... }
    var etype = (evt.type || evt.event || '').toLowerCase();
    if (etype === 'custom' || evt.matchedCustomAlert) stats.customAlerts++;
    if (etype === 'algo' || evt.alertType) stats.algoAlerts++;

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
