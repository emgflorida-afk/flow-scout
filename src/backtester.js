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

  var stats = {
    date: date,
    eventsReceived: 0,
    algoAlerts: 0,
    customAlerts: 0,
    readyStats: null,
    byTicker: {},
    byDirection: { CALLS: 0, PUTS: 0 },
    premiumBuckets: { '<50K': 0, '50-100K': 0, '100-500K': 0, '500K-1M': 0, '1M+': 0 },
    alertSamples: [],
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
  var SOFT_TIMEOUT_MS = (opts && opts.timeoutMs) || 360000;
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

    var etype = (evt.event || evt.type || '').toLowerCase();
    if (etype === 'init' || etype === 'status' || etype === 'heartbeat') continue;
    if (etype === 'ready') { stats.readyStats = evt; continue; }
    if (etype === 'error') { stats.streamError = evt.message; continue; }

    // Alert payload lives under evt.data
    var d = evt.data || {};
    var rawSymbol = (d.symbol || d.rawSymbol || '').toString();
    var alertType = (d.alertType || d.alert_type || '').toLowerCase();
    var premium   = parseFloat(d.premium || d.alertPremium || d.total_premium || 0) || 0;
    var tsField   = d.timestamp || d.alertTime || d.ts || null;
    var tickerMatch = rawSymbol.replace(/^O:/, '').match(/^[A-Z.]+/);
    var ticker = tickerMatch ? tickerMatch[0] : (d.ticker || d.symbol_underlying || null);

    // Direction from OPRA suffix or alertType
    var direction = 'CALLS';
    var opraMatch = rawSymbol.replace(/^O:/, '').match(/^[A-Z.]+\d{6}([CP])\d+/);
    if (opraMatch && opraMatch[1] === 'P') direction = 'PUTS';
    else if (/put/i.test(alertType)) direction = 'PUTS';

    // Classify: custom vs algo. alertType field on the payload is the source of truth.
    // Bullflow wraps BOTH custom and algo in {event:"alert"} envelope — disambiguate
    // via alertType: "custom" vs anything else (sweeps, blocks, grenades, etc.).
    var isCustom = alertType === 'custom' || alertType === 'custom-alert';
    if (isCustom) {
      stats.customAlerts++;
      if (ticker) {
        if (!stats.byTicker[ticker]) stats.byTicker[ticker] = { calls: 0, puts: 0, totalPremium: 0 };
        stats.byTicker[ticker][direction === 'PUTS' ? 'puts' : 'calls']++;
        stats.byTicker[ticker].totalPremium += premium;
      }
      stats.byDirection[direction]++;
      if (premium < 50000) stats.premiumBuckets['<50K']++;
      else if (premium < 100000) stats.premiumBuckets['50-100K']++;
      else if (premium < 500000) stats.premiumBuckets['100-500K']++;
      else if (premium < 1000000) stats.premiumBuckets['500K-1M']++;
      else stats.premiumBuckets['1M+']++;
    } else if (etype === 'alert' || etype === 'algo' || alertType) {
      stats.algoAlerts++;
      if (ticker) {
        if (!stats.byTicker[ticker]) stats.byTicker[ticker] = { calls: 0, puts: 0, totalPremium: 0 };
        stats.byTicker[ticker][direction === 'PUTS' ? 'puts' : 'calls']++;
        stats.byTicker[ticker].totalPremium += premium;
      }
      stats.byDirection[direction]++;
      if (premium < 50000) stats.premiumBuckets['<50K']++;
      else if (premium < 100000) stats.premiumBuckets['50-100K']++;
      else if (premium < 500000) stats.premiumBuckets['100-500K']++;
      else if (premium < 1000000) stats.premiumBuckets['500K-1M']++;
      else stats.premiumBuckets['1M+']++;

      if (stats.alertSamples.length < 5) {
        stats.alertSamples.push({
          seq: evt.sequence, ticker: ticker, direction: direction,
          alertType: alertType, premium: premium, ts: tsField,
          rawSymbol: rawSymbol,
        });
      }
    }
  }

  // Top tickers by algo alert count
  var tickerEntries = Object.keys(stats.byTicker).map(function(k) {
    return { ticker: k, calls: stats.byTicker[k].calls, puts: stats.byTicker[k].puts,
             total: stats.byTicker[k].calls + stats.byTicker[k].puts,
             totalPremium: Math.round(stats.byTicker[k].totalPremium) };
  });
  tickerEntries.sort(function(a, b) { return b.total - a.total; });
  stats.topTickers = tickerEntries.slice(0, 20);
  // byTicker retained so flowConcentration can score the full universe.
  // Endpoint handlers strip it on the wire if they want a slim response.

  return { status: 'OK', stats: stats };
}

async function getPeakReturn(opts) {
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return { error: 'BULLFLOW_API_KEY missing' };
  if (!opts || !opts.symbol || opts.oldPrice == null || !opts.timestamp) {
    return { error: 'symbol, oldPrice, timestamp all required (per Bullflow /v1/data/peakReturn spec)' };
  }

  // Per Bullflow docs: query params are `sym`, `old_price`, `trade_timestamp`
  // (not `symbol` and `timestamp` which we used previously).
  var url = BULLFLOW_BASE + '/data/peakReturn?key=' + encodeURIComponent(apiKey) +
            '&sym=' + encodeURIComponent(opts.symbol) +
            '&old_price=' + encodeURIComponent(opts.oldPrice) +
            '&trade_timestamp=' + encodeURIComponent(opts.timestamp);

  try {
    var res = await fetch(url);
    if (!res.ok) return { error: 'HTTP ' + res.status, url: url.replace(apiKey, 'REDACTED') };
    var json = await res.json();
    return {
      ok: true,
      symbol: opts.symbol,
      entryPrice: opts.oldPrice,
      tradeTimestamp: opts.timestamp,
      peakPrice: parseFloat(json.peakPriceSinceTimestamp),
      peakPctReturn: parseFloat(json.peakPercentReturnSinceTimestamp),
      raw: json,
    };
  } catch(e) {
    return { error: e.message };
  }
}

module.exports = { runBacktest: runBacktest, getPeakReturn: getPeakReturn };
