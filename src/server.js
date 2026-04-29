// server.js - Stratum Flow Scout v7.2
// Complete final -- all modules + AYCE scanner + smart stops + position offset analyzer

require('dotenv').config();
var express  = require('express');
var path     = require('path');
var cron     = require('node-cron');
var alerter  = require('./alerter');
var resolver = require('./contractResolver');
// Bullflow: AB cancelled $129/mo subscription Apr 28 2026. Module loads OK
// without API key (no-op stream), just don't render Bullflow UI in scanner.
var bullflow = require('./bullflowStream');
var dashboard     = require('./dashboard');
var ideaValidator = require('./ideaValidator');
var discordBot    = require('./discordBot');
var flowCluster   = require('./flowCluster');

var goalTracker      = null;
var weeklyTracker    = null;
var stopManager      = null;
var finviz           = null;
var capitol          = null;
var ts               = null;
var preMarketScanner = null;
var smartStops       = null;
var econCalendar     = null;
var preMarketReport  = null;
var positionOffset   = null;

try { goalTracker      = require('./goalTracker');      console.log('[GOAL] Loaded OK');    } catch(e) { console.log('[GOAL] Skipped:', e.message); }
try { weeklyTracker    = require('./weeklyTracker');    console.log('[WEEKLY] Loaded OK');  } catch(e) { console.log('[WEEKLY] Skipped:', e.message); }
try { stopManager      = require('./stopManager');      console.log('[STOPMGR] Loaded OK'); } catch(e) { console.log('[STOPMGR] Skipped:', e.message); }
try { finviz           = require('./finvizScreener');   console.log('[FINVIZ] Loaded OK');  } catch(e) { console.log('[FINVIZ] Skipped:', e.message); }
try { capitol          = require('./capitolTrades');    console.log('[CAPITOL] Loaded OK'); } catch(e) { console.log('[CAPITOL] Skipped:', e.message); }
try { ts               = require('./tradestation');     console.log('[TS] Loaded OK');      } catch(e) { console.log('[TS] Skipped:', e.message); }
try { preMarketScanner = require('./preMarketScanner'); console.log('[SCANNER] Loaded OK'); } catch(e) { console.log('[SCANNER] Skipped:', e.message); }
try { smartStops       = require('./smartStop');        console.log('[STOPS] Loaded OK');   } catch(e) { console.log('[STOPS] Skipped:', e.message); }
try { econCalendar     = require('./economicCalendar'); console.log('[CAL] Loaded OK');     } catch(e) { console.log('[CAL] Skipped:', e.message); }
try { preMarketReport  = require('./preMarketReport');  console.log('[PMR] Loaded OK');     } catch(e) { console.log('[PMR] Skipped:', e.message); }
try { positionOffset   = require('./positionOffset');   console.log('[OFFSET] Loaded OK');  } catch(e) { console.log('[OFFSET] Skipped:', e.message); }

var tradingJournal = null;
try { tradingJournal = require('./tradingJournal'); console.log('[JOURNAL] Loaded OK'); } catch(e) { console.log('[JOURNAL] Skipped:', e.message); }

var macroFilter = null;
try { macroFilter = require('./macroFilter'); console.log('[MACRO] Loaded OK'); } catch(e) { console.log('[MACRO] Skipped:', e.message); }

var executeNow = null;
try { executeNow = require('./executeNow'); console.log('[EXECUTE-NOW] Loaded OK'); } catch(e) { console.log('[EXECUTE-NOW] Skipped:', e.message); }

var holdLock = null;
try { holdLock = require('./holdLock'); console.log('[HOLD-LOCK] Loaded OK'); } catch(e) { console.log('[HOLD-LOCK] Skipped:', e.message); }

var autoMorning = null;
try { autoMorning = require('./autoMorning'); console.log('[AUTO-MORNING] Loaded OK'); } catch(e) { console.log('[AUTO-MORNING] Skipped:', e.message); }

var autoJournal = null;
try { autoJournal = require('./autoJournal'); console.log('[AUTO-JOURNAL] Loaded OK'); } catch(e) { console.log('[AUTO-JOURNAL] Skipped:', e.message); }

var winTracker = null;
try { winTracker = require('./winTracker'); console.log('[WIN-TRACKER] Loaded OK'); } catch(e) { console.log('[WIN-TRACKER] Skipped:', e.message); }

var ideaIngestor = null;
try { ideaIngestor = require('./ideaIngestor'); console.log('[IDEA] Loaded OK'); } catch(e) { console.log('[IDEA] Skipped:', e.message); }

var simMode = null;
try { simMode = require('./simMode'); console.log('[SIM-MODE] Loaded OK'); } catch(e) { console.log('[SIM-MODE] Skipped:', e.message); }

var orderExecutor = null;
try { orderExecutor = require('./orderExecutor'); console.log('[EXECUTOR] Loaded OK'); } catch(e) { console.log('[EXECUTOR] Skipped:', e.message); }

var creditSpreadEngine = null;
try { creditSpreadEngine = require('./creditSpreadEngine'); console.log('[SPREAD] Loaded OK'); } catch(e) { console.log('[SPREAD] Skipped:', e.message); }

var cancelManager = null;
try { cancelManager = require('./cancelManager'); console.log('[CANCEL-MGR] Loaded OK'); } catch(e) { console.log('[CANCEL-MGR] Skipped:', e.message); }

var dailyLossLimit = null;
try { dailyLossLimit = require('./dailyLossLimit'); console.log('[LOSS-LIMIT] Loaded OK'); } catch(e) { console.log('[LOSS-LIMIT] Skipped:', e.message); }

var dynamicBias = null;
try { dynamicBias = require('./dynamicBias'); console.log('[DYNAMIC-BIAS] Loaded OK'); } catch(e) { console.log('[DYNAMIC-BIAS] Skipped:', e.message); }

var gex = null;
try { gex = require('./gex'); console.log('[GEX] Loaded OK'); } catch(e) { console.log('[GEX] Skipped:', e.message); }

var signalTracker = null;
try { signalTracker = require('./signalTracker'); console.log('[SIGNAL-TRACKER] Loaded OK'); } catch(e) { console.log('[SIGNAL-TRACKER] Skipped:', e.message); }

var positionManager = null;
try { positionManager = require('./positionManager'); console.log('[POS-MGR] Loaded OK'); } catch(e) { console.log('[POS-MGR] Skipped:', e.message); }

// MASTER AUTONOMOUS AGENT -- the brain of the system
var stratumAgent = null;
try {
  stratumAgent = require('./stratumAgent');
  stratumAgent.startCrons(); // start all autonomous crons
  stratumAgent.refreshState(); // load initial state on startup
  console.log('[AGENT] Stratum Agent LIVE -- Claude autonomous trading enabled');
} catch(e) { console.log('[AGENT] Skipped:', e.message); }

var app  = express();
var PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.text());  // TradingView sends alerts as text/plain — parse into req.body string
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Apr 29 2026 - root now serves the glass scanner (was JSON status).
// JSON status moved to /status for healthchecks.
app.get('/', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'scanner-v2.html'));
});

app.get('/status', function(req, res) {
  res.json({ status: 'Stratum Flow Scout OK', version: '7.2', time: new Date().toISOString() });
});

app.get('/flow/summary',  function(req, res) { res.json(bullflow.liveAggregator.getSummary()); });
app.get('/flow/clusters', function(req, res) { res.json(flowCluster.getClusterSummary()); });

// Flow cards — fired one-sided clusters with resolved contract + confluence read.
// Display only; never auto-queues.
app.get('/api/flow-cards/active', function(req, res) {
  res.json({ ok: true, cards: flowCluster.getActiveCards() });
});
app.post('/api/flow-cards/clear', function(req, res) {
  flowCluster.clearCards();
  res.json({ ok: true });
});

app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'dashboard.html'));
});
app.get('/mobile', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'mobile.html'));
});
app.get('/scanner', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'scanner.html'));
});

// Glass-UI scanner (Apr 29 2026) - new polished design, same /api/wealthprince-scan data
app.get('/scanner-v2', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'scanner-v2.html'));
});
var stratumScanner = null;
try { stratumScanner = require('./stratumScanner'); console.log('[SERVER] stratumScanner loaded OK'); }
catch(e) { console.log('[SERVER] stratumScanner not loaded:', e.message); }

// WealthPrince Reversal Scanner (Failed-2D/2U + 4HR EMA + sector filter)
var wpScanner = null;
try { wpScanner = require('./wealthPrinceScanner'); console.log('[SERVER] wealthPrinceScanner loaded OK (' + wpScanner.UNIVERSE.length + ' tickers)'); }
catch(e) { console.log('[SERVER] wealthPrinceScanner not loaded:', e.message); }

// In-memory cache so we don't blast TS API on every UI refresh
var wpScanCache = null;
var wpScanCacheTime = 0;

// Wire scanner setup lookup into flowCluster so card.confluence is computed
// when a flow cluster fires. Looks up latest Daily scan, finds matching ticker,
// returns {direction, pattern} for the cluster builder.
if (stratumScanner) {
  flowCluster.setScannerSetupLookup(function(ticker) {
    try {
      var last = stratumScanner.getLastScan('Daily');
      if (!last || !last.rows) return null;
      var row = last.rows.find(function(r) { return r.ticker === ticker; });
      if (!row) return null;
      var dir = row.direction || row.signalDirection || row.bias || null;
      var pattern = row.signal || row.pattern || row.context || 'setup';
      return dir ? { direction: dir, pattern: pattern } : null;
    } catch(e) { return null; }
  });
  console.log('[SERVER] flowCluster scanner-setup lookup wired OK');
}
app.get('/api/stratum-scanner', async function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  try {
    var force = req.query && req.query.force === '1';
    var tf = (req.query && req.query.tf) || 'Daily';
    var data = await stratumScanner.scan({ force: force, tf: tf });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// AI Curator — Apr 22 2026 PM build
// Scores TV alerts via Claude API, pushes A+ verdicts to Discord.
// Silent-logs everything for transparency.
var aiCurator = null;
try { aiCurator = require('./aiCurator'); console.log('[SERVER] aiCurator loaded OK'); }
catch(e) { console.log('[SERVER] aiCurator not loaded:', e.message); }

// TradingView webhook receiver -- in TV alert, set Webhook URL to:
//   https://flow-scout-production.up.railway.app/api/tv-alert
// (The old -f021 domain points to a dead-twin `upbeat-flow` project with no
// env vars. Do NOT send TV alerts there.)
// And body to JSON like: {"ticker":"{{ticker}}","action":"buy","tf":"{{interval}}","price":{{close}},"message":"{{strategy.order.alert_message}}"}
//
// Flow on receipt:
//   1. Scanner ingests (persists tv alert for the TV Watch column)
//   2. AI Curator scores the setup against AB's doctrine
//   3. If score ≥ 8, Discord push fires
//   4. Silent log to curator_log.jsonl either way
app.post('/api/tv-alert', function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  try {
    var body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){} }
    var scanResult = stratumScanner.ingestTVAlert(body);
    console.log('[TV-ALERT]', JSON.stringify(body).slice(0, 200), '->', JSON.stringify(scanResult));

    // Fire curator async — don't block the response
    if (aiCurator && aiCurator.processTVAlert) {
      aiCurator.processTVAlert(body)
        .then(function(r) { console.log('[CURATOR]', body.ticker, '->', r && r.verdict && r.verdict.verdict); })
        .catch(function(e) { console.error('[CURATOR] error:', e.message); });
    }

    res.json({ ok: true, scanner: scanResult, curator: 'async' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Recent curator decisions (for scanner UI AI Curator tab)
app.get('/api/curator/decisions', function(req, res) {
  if (!aiCurator) return res.json({ decisions: [] });
  var limit = parseInt(req.query.limit, 10) || 50;
  res.json({ decisions: aiCurator.getRecentDecisions(limit) });
});

// Manual trigger (for testing or EOD)
app.post('/api/curator/score', function(req, res) {
  if (!aiCurator) return res.status(500).json({ error: 'aiCurator not loaded' });
  var body = req.body || {};
  aiCurator.scoreSetup(body)
    .then(function(verdict) { res.json({ ok: true, verdict: verdict }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Manual push — ship a pre-built card directly to Discord, no Claude scoring.
// Used for Claude-session-authored setup cards that are already vetted.
app.post('/api/curator/push', function(req, res) {
  try {
    var pushNotifier = require('./pushNotifier');
    var body = req.body || {};
    if (!body.ticker) return res.status(400).json({ error: 'ticker required' });
    pushNotifier.pushCuratorAlert(body)
      .then(function() { res.json({ ok: true, pushed: true }); })
      .catch(function(e) { res.status(500).json({ error: e.message }); });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Star / unstar a ticker
app.post('/api/stratum-scanner/star', function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  var body = req.body || {};
  var ticker = (body.ticker || req.query.ticker || '').toUpperCase();
  var starred = body.starred === undefined ? true : !!body.starred;
  res.json(stratumScanner.setStar(ticker, starred));
});
app.get('/api/stratum-scanner/stars', function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  res.json({ stars: stratumScanner.getStars() });
});

// ============================================================
// CARD DISPATCH QUEUE (Apr 21 2026 PM — Hybrid MCP button)
// Scanner ⚡FAST or 📨REVIEW button POSTs to /api/card-dispatch.
// Persisted to /data (survives redeploys). Active Claude session
// polls /api/card-dispatch/pending and processes via TS MCP.
//
// mode=fast   → Claude auto-executes via confirm-order + place-order
//               (ONLY for rows tagged conviction='high' by scanner)
// mode=review → Claude shows confirm-order preview, waits for AB "go"
//
// Per OPERATING_MODEL_apr21 — AB explicitly re-authorized fast-mode
// for high-conviction setups (Apr 21 PM session).
// ============================================================
var CARDS_FILE = (process.env.STATE_DIR || '/tmp') + '/pending_mcp_cards.json';
function loadCards() {
  try { return JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')); } catch(e) { return []; }
}
function saveCards(cards) {
  try { fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2)); } catch(e) { console.error('[CARDS] save error:', e.message); }
}
app.post('/api/card-dispatch', function(req, res) {
  var body = req.body || {};
  if (!body.ticker || !body.titanCard) return res.status(400).json({ ok: false, reason: 'missing ticker or titanCard' });
  var mode = body.mode === 'fast' ? 'fast' : 'review';
  // Fast mode requires high conviction per OPERATING_MODEL_apr21
  if (mode === 'fast' && body.conviction !== 'high') {
    return res.status(400).json({ ok: false, reason: 'FAST mode requires conviction=high (from scanner row tag)' });
  }
  var cards = loadCards();
  // Dedup: if same ticker+titanCard already pending, skip
  var existing = cards.find(function(c){ return c.status === 'pending' && c.ticker === body.ticker && c.titanCard === body.titanCard; });
  if (existing) return res.json({ ok: true, deduped: true, id: existing.id });
  var entry = {
    id: 'C_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    ticker: body.ticker,
    mode: mode,
    conviction: body.conviction || null,
    card: body.card || null,
    titanCard: body.titanCard,
    source: body.source || 'scanner',
    queuedAt: new Date().toISOString(),
    status: 'pending',
  };
  cards.push(entry);
  saveCards(cards);
  console.log('[CARDS] dispatched:', entry.id, entry.ticker, entry.mode);
  return res.json({ ok: true, id: entry.id, mode: mode });
});
app.get('/api/card-dispatch/pending', function(req, res) {
  var cards = loadCards();
  var pending = cards.filter(function(c){ return c.status === 'pending'; });
  return res.json({ count: pending.length, cards: pending });
});
app.get('/api/card-dispatch/all', function(req, res) {
  var cards = loadCards();
  return res.json({ count: cards.length, cards: cards });
});
app.post('/api/card-dispatch/:id/mark', function(req, res) {
  var id = req.params.id;
  var body = req.body || {};
  var status = body.status || 'processed';
  var note = body.note || null;
  var cards = loadCards();
  var found = false;
  cards = cards.map(function(c) {
    if (c.id === id) {
      c.status = status;
      c.processedAt = new Date().toISOString();
      if (note) c.note = note;
      found = true;
    }
    return c;
  });
  saveCards(cards);
  return res.json({ ok: found });
});

// Historical signals + W/L stats — optional tf filter (Daily/4HR/60m/30m)
app.get('/api/stratum-scanner/history', function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  var days = parseInt(req.query.days || '5', 10);
  var tf = req.query.tf || null;
  res.json(stratumScanner.getHistory(days, tf));
});

// Apr 24 2026 v1.5 — TIER 5: confluence-sliced breakdown
// GET /api/stratum-scanner/history/breakdown?ftfcAligned=true&gexRegime=POSITIVE&flow=BULL&tf=Daily&days=30
// Query-string keys become the filter map; reserved keys: tf, days
app.get('/api/stratum-scanner/history/breakdown', function(req, res) {
  if (!stratumScanner || !stratumScanner.getHistoryBreakdown) {
    return res.status(500).json({ error: 'getHistoryBreakdown not available' });
  }
  var tf = req.query.tf || null;
  var days = parseInt(req.query.days || '30', 10);
  var filters = {};
  Object.keys(req.query).forEach(function(k) {
    if (k === 'tf' || k === 'days') return;
    var v = req.query[k];
    // Coerce common values
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    else if (/^-?\d+\.\d+$/.test(v)) v = parseFloat(v);
    filters[k] = v;
  });
  res.json(stratumScanner.getHistoryBreakdown(filters, { tf: tf, days: days }));
});

// Manual live-score update (forces the cron logic on demand)
app.get('/api/stratum-scanner/history/live-update', async function(req, res) {
  if (!stratumScanner || !stratumScanner.updateLiveScores) {
    return res.status(500).json({ error: 'updateLiveScores not available' });
  }
  try {
    await stratumScanner.updateLiveScores();
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});
// Structural levels for a ticker (PDH/PDL/PWH/PWL/PMH/PML/52wH/52wL)
// Used by external integrations, Pine scripts that webhook for data, mobile apps.
app.get('/api/stratum-scanner/levels/:ticker', async function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  try {
    var ticker = (req.params.ticker || '').toUpperCase();
    var last = stratumScanner.getLastScan();
    if (last && last.groups) {
      var found = null;
      Object.keys(last.groups).forEach(function(k){
        last.groups[k].forEach(function(r){
          if (r.ticker === ticker) found = r;
        });
      });
      if (found) {
        return res.json({
          ticker: ticker,
          price: found.price,
          levels: found.dwmq && found.dwmq.levels || {},
          magnitude: found.magnitude,
          trigger: found.trigger,
          signal: found.signal,
        });
      }
    }
    res.status(404).json({ error: 'Ticker not in current scan. Force /api/stratum-scanner first.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Queue a trade from a scanner row
app.post('/api/stratum-scanner/queue', async function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  try {
    var body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){} }
    var result = await stratumScanner.queueFromRow(body);
    console.log('[SCANNER-QUEUE]', JSON.stringify(body).slice(0, 200), '->', JSON.stringify(result).slice(0, 200));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Diagnostic: fetch Finnhub stock/metric directly and return the raw field
// names that come back. Helps diagnose whether shortInterestSharesPercentFloat
// is a valid field on this Finnhub plan, or if we need a different field name.
app.get('/api/debug/finnhub-metric/:ticker', async function(req, res) {
  var key = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY;
  if (!key) return res.status(500).json({ error: 'no FINNHUB key' });
  var ticker = req.params.ticker.toUpperCase();
  try {
    var fetchLib = require('node-fetch');
    var r = await fetchLib('https://finnhub.io/api/v1/stock/metric?symbol=' + ticker + '&metric=all&token=' + key);
    var body = await r.json();
    // Return only the field names + any short-related values
    var m = (body && body.metric) || {};
    var shortFields = {};
    Object.keys(m).forEach(function(k) {
      if (/short|float|ratio/i.test(k)) shortFields[k] = m[k];
    });
    res.json({
      http: r.status,
      allMetricKeys: Object.keys(m).sort(),
      shortRelatedFields: shortFields,
      shortInterestSharesPercentFloat: m.shortInterestSharesPercentFloat,
      shortRatio: m.shortRatio,
      responseMetricType: body && body.metricType || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: env var presence probe. Reports which of a known set of Railway
// vars are visible to this process — no values echoed. If BULLFLOW_API_KEY
// is missing here but set in Railway UI, the service is either stale (needs
// redeploy) or pointing at a different project/env.
// Manually kick the Bullflow stream from inside an HTTP handler.
// Railway's lazy env injection apparently exposes BULLFLOW_API_KEY to
// request-bound code but not to module-load / setInterval paths. Calling
// startBullflowStream from here captures the request-context env.
app.get('/api/bullflow/status', function(req, res) {
  var fs = require('fs');
  var keyFile = (process.env.STATE_DIR || '/tmp') + '/bullflow_key.txt';
  var fileExists = false;
  var fileLen = 0;
  try {
    if (fs.existsSync(keyFile)) {
      fileExists = true;
      fileLen = fs.readFileSync(keyFile, 'utf8').trim().length;
    }
  } catch(e) {}
  res.json({
    keyFile: keyFile,
    fileExists: fileExists,
    fileKeyLength: fileLen,
    envKeyPresent: !!(process.env.BULLFLOW_API_KEY),
    envKeyLength: process.env.BULLFLOW_API_KEY ? process.env.BULLFLOW_API_KEY.length : 0,
    stateDir: process.env.STATE_DIR || null,
  });
});

// Apr 24 2026 — inspect live SSE connection state without tailing Railway logs
app.get('/api/bullflow/health', function(req, res) {
  try {
    var bf = require('./bullflowStream');
    var state = bf.getConnState ? bf.getConnState() : { state: 'unknown', note: 'getConnState not exported' };
    res.json({ ok: true, conn: state, now: new Date().toISOString() });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/bullflow/init', function(req, res) {
  console.log('[INIT-ENDPOINT] /api/bullflow/init called. pid=' + process.pid);
  try {
    var k = process.env.BULLFLOW_API_KEY;
    console.log('[INIT-ENDPOINT] process.env.BULLFLOW_API_KEY: ' + (k ? 'len=' + k.length : 'MISSING'));
    if (!k || k.length < 5) {
      return res.json({ ok: false, reason: 'BULLFLOW_API_KEY still not visible in request env' });
    }
    // Write to disk directly so we don't depend on startBullflowStream's internal logic
    var fs = require('fs');
    var keyFile = (process.env.STATE_DIR || '/tmp') + '/bullflow_key.txt';
    fs.writeFileSync(keyFile, k);
    console.log('[INIT-ENDPOINT] Wrote key to ' + keyFile);

    var bf = require('./bullflowStream');
    console.log('[INIT-ENDPOINT] bullflow module loaded, calling startBullflowStream...');
    bf.startBullflowStream(k);
    console.log('[INIT-ENDPOINT] startBullflowStream call returned');
    res.json({ ok: true, keyLength: k.length, keyStart: k.slice(0, 3) + '...', started: true, wroteDisk: true });
  } catch(e) {
    console.error('[INIT-ENDPOINT] ERROR:', e.message, e.stack);
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/env-probe', function(req, res) {
  var names = [
    'BULLFLOW_API_KEY', 'ANTHROPIC_API_KEY', 'ACCOUNT_SIZE', 'AGENT_MODE',
    'CONFIDENCE_THRESHOLD', 'DISCORD_BOT_TOKEN', 'FINNHUB_KEY', 'FINNHUB_API_KEY',
    'STATE_DIR', 'RAILWAY_SERVICE_NAME', 'RAILWAY_PROJECT_NAME',
    'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PUBLIC_DOMAIN', 'PORT'
  ];
  var out = {};
  names.forEach(function(n) {
    var v = process.env[n];
    out[n] = {
      present: typeof v === 'string' && v.length > 0,
      length: typeof v === 'string' ? v.length : null,
      startsWith: typeof v === 'string' && v.length > 0 ? v.slice(0, 3) + '...' : null,
      looksLikeTemplate: typeof v === 'string' && (v.indexOf('${{') >= 0 || v.indexOf('{{') >= 0),
    };
  });
  // also count bullflow-like var names in case it's typo'd
  var bullVariants = Object.keys(process.env).filter(function(k){ return /bull|bf/i.test(k); });
  // report the railway project/env so we can confirm we're hitting the right service
  res.json({
    presenceByName: out,
    bullflowVariantNames: bullVariants,
    totalEnvVarCount: Object.keys(process.env).length,
    railwayServiceName: process.env.RAILWAY_SERVICE_NAME || null,
    railwayProjectName: process.env.RAILWAY_PROJECT_NAME || null,
    railwayEnvName: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    railwayGitCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    pid: process.pid,
    startedAt: process.env.RAILWAY_DEPLOYMENT_STARTED_AT || null,
  });
});

// Diagnostic: report scanner eval config + live peakReturn test for one row.
// Helps confirm BULLFLOW_API_KEY is set and OCC symbol construction works.
// Usage: /api/stratum-scanner/debug-eval?ticker=NVDA&date=2026-04-17
app.get('/api/stratum-scanner/debug-eval', async function(req, res) {
  if (!stratumScanner) return res.status(500).json({ error: 'stratumScanner not loaded' });
  var ticker = (req.query.ticker || 'NVDA').toUpperCase();
  var date   = req.query.date || '2026-04-17';
  var haveKey = !!process.env.BULLFLOW_API_KEY;
  var history = null;
  try { history = await stratumScanner.getHistory(10); } catch(e) {}
  // Find the requested row
  var row = null, foundDate = null;
  if (history && history.days) {
    for (var d = 0; d < history.days.length; d++) {
      if (history.days[d].date !== date) continue;
      foundDate = history.days[d].date;
      (history.days[d].rows || []).forEach(function(r) { if (r.ticker === ticker) row = r; });
    }
  }
  // If no history row, build a minimal stand-in so we can still test
  if (!row) row = { ticker: ticker, dir: 'BULL', price: 200, signal: 'debug' };
  // Fire the live peakReturn with a synthetic contract and return the raw response
  var yymmdd = (function(fromDateStr, minDTE) {
    var base = new Date(fromDateStr + 'T12:00:00-05:00');
    var dd = new Date(base.getTime());
    var targetMs = base.getTime() + minDTE * 86400000;
    while (true) {
      dd = new Date(dd.getTime() + 86400000);
      if (dd.getDay() === 5 && dd.getTime() >= targetMs) break;
      if (dd.getTime() - base.getTime() > 45 * 86400000) break;
    }
    var yy = String(dd.getFullYear()).slice(-2);
    var mm = String(dd.getMonth() + 1).padStart(2, '0');
    var d2 = String(dd.getDate()).padStart(2, '0');
    return yy + mm + d2;
  })(date, 14);
  var cp = row.dir === 'BULL' ? 'C' : 'P';
  var strike = Math.round(row.price);
  var strikePad = String(strike * 1000).padStart(8, '0');
  var sym = 'O:' + ticker + yymmdd + cp + strikePad;
  var oldPrice = Math.max(0.05, +(row.price * 0.02).toFixed(2));
  var ts = Math.floor(new Date(date + 'T13:35:00Z').getTime() / 1000);
  var apiResult = { status: 'skipped — no api key' };
  if (haveKey) {
    try {
      var fetchLib = require('node-fetch');
      var url = 'https://api.bullflow.io/v1/data/peakReturn'
        + '?key=' + encodeURIComponent(process.env.BULLFLOW_API_KEY)
        + '&sym=' + encodeURIComponent(sym)
        + '&old_price=' + encodeURIComponent(oldPrice)
        + '&trade_timestamp=' + encodeURIComponent(ts);
      var r = await fetchLib(url, { timeout: 15000 });
      var bodyText = await r.text();
      var parsed = null; try { parsed = JSON.parse(bodyText); } catch(e) {}
      apiResult = { http: r.status, body: parsed || bodyText.slice(0, 400) };
    } catch(e) { apiResult = { error: e.message }; }
  }
  res.json({
    haveBullflowKey: haveKey,
    requestedTicker: ticker, requestedDate: date, foundInHistory: !!foundDate,
    row: row ? { ticker: row.ticker, dir: row.dir, price: row.price, signal: row.signal, outcome: row.outcome, peakPct: row.peakPct, evalMethod: row.evalMethod } : null,
    contract: sym, oldPrice: oldPrice, tradeTimestamp: ts,
    peakReturnResult: apiResult,
  });
});

app.get('/dashboard/data', async function(req, res) {
  try { var data = await dashboard.getDashboardData((req.query.mode || 'DAY').toUpperCase()); res.json(data); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/interactions', async function(req, res) {
  try { await discordBot.handleInteraction(req, res); }
  catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/webhook/idea', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    // John's trade ideas -- route to ideaIngestor
    if (ideaIngestor && req.body.ticker && secret === process.env.STRATUM_SECRET) {
      var idea   = req.body;
      var result = await ideaIngestor.ingestIdea(idea);
      return res.json({ status: 'OK', result });
    }
    // Fallback -- old text based validator
    var text = req.body.text || req.body.content || req.body.idea || '';
    if (!text) return res.status(400).json({ error: 'Missing text or ticker' });
    var webhookUrl = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
    ideaValidator.validateAndPost(text, webhookUrl).catch(console.error);
    res.json({ status: 'processing', text: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/tradingview', async function(req, res) {
  try {
    var body       = req.body;
    var ticker     = (body.ticker || '').toUpperCase().trim();
    var type       = (body.type   || 'call').toLowerCase().trim();
    var confluence = body.confluence || '0/6';
    var tradeType  = body.tradeType  || 'SWING';
    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
    var score = parseInt(String(confluence).split('/')[0]) || 0;
    if (score < 3) return res.json({ status: 'skipped', reason: 'Below 3/6' });
    // BRIDGE (early): push to brain BEFORE contract resolution so the brain
    // sees every Stratum alert even when the immediate resolver can't find a
    // clean contract. The brain's scanner loop will re-resolve on its own cycle.
    try {
      if (brainEngine && brainEngine.pushTVSignal) {
        brainEngine.pushTVSignal({
          ticker: ticker,
          direction: type === 'put' ? 'PUTS' : 'CALLS',
          source: 'STRATUM_' + (body.tf ? body.tf + 'M' : 'TV'),
          type: type,
          action: body.action || null,
          confluence: confluence,
          tradeType: tradeType,
          tf: body.tf || null,
          price: body.price != null ? parseFloat(body.price) : null,
          rsi: body.rsi != null ? parseFloat(body.rsi) : null,
          vwap: body.vwap != null ? parseFloat(body.vwap) : null,
          vwapBias: body.vwapBias != null ? String(body.vwapBias) : null,
          volRatio: body.volRatio != null ? parseFloat(body.volRatio) : null,
          momCount: body.momCount != null ? parseFloat(body.momCount) : null,
          sqzFiring: body.sqzFiring != null ? String(body.sqzFiring) : null,
          adx: body.adx != null ? parseFloat(body.adx) : null,
        });
      }
    } catch(bridgeErr) {
      console.error('[tradingview webhook] early brain bridge error:', bridgeErr && bridgeErr.message);
    }
    // AUTO-QUEUE: pre-market Stratum A+ (>=5/6) on liquid names auto-adds to daily queue.
    // Survives redeploys via brainEngine's /tmp persistence. User reviews at 8:30 AM.
    try {
      var AUTO_QUEUE_LIQUID = ['SPY','QQQ','IWM','DIA','NVDA','TSLA','AAPL','MSFT','META','AMZN','GOOGL','GOOG','AMD','NFLX','AVGO','COIN','PLTR','SMCI','MU','MRVL','CRM','ORCL','ADBE','UBER','COST','HD','LOW','JPM','BAC','GS','XOM','CVX'];
      var nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
      var etParts = nowET.match(/(\d{1,2}):(\d{2})/);
      var etMin = etParts ? (parseInt(etParts[1]) * 60 + parseInt(etParts[2])) : 0;
      var isPreMarket = etMin < (9 * 60 + 30);
      if (isPreMarket && score >= 5 && AUTO_QUEUE_LIQUID.indexOf(ticker) !== -1 && brainEngine && brainEngine.addQueuedTrade) {
        var existing = (brainEngine.getQueuedTrades ? brainEngine.getQueuedTrades() : [])
          .filter(function(q) { return q.ticker === ticker && q.status === 'PENDING' && q.source && q.source.indexOf('STRATUM_AUTO') === 0; });
        if (existing.length === 0) {
          var trigPrice = body.price != null ? parseFloat(body.price) : null;
          if (trigPrice) {
            brainEngine.addQueuedTrade({
              ticker: ticker,
              direction: type === 'put' ? 'PUTS' : 'CALLS',
              triggerPrice: trigPrice,
              contracts: score >= 6 ? 3 : 2,
              stopPct: -25,
              targets: [0.20, 0.50, 1.00],
              management: 'BILL_PAYING',
              source: 'STRATUM_AUTO_' + score + 'of6',
              tradeType: 'DAY',
              note: 'Pre-market Stratum ' + confluence + ' auto-queue. Review at 8:30 AM.',
            });
            console.log('[AUTO-QUEUE] ' + ticker + ' ' + type + ' @ $' + trigPrice + ' | ' + confluence + ' | Stratum pre-market');
          }
        }
      }
    } catch(autoQErr) {
      console.error('[tradingview webhook] auto-queue error:', autoQErr && autoQErr.message);
    }
    var resolved = await resolver.resolveContract(ticker, type, tradeType);
    if (!resolved) return res.json({ status: 'brain-queued', reason: 'No immediate contract, brain will retry', brainBridged: true });
    var tvBias = {
      source: 'STRATUM_' + (body.tf ? body.tf + 'M' : 'TV'),
      tf: body.tf || null,
      weekly: body.weekly || null, daily: body.daily || null,
      h4: body.h4 || null, h1: body.h1 || null, confluence: confluence,
      mid: resolved.mid, bid: resolved.bid, ask: resolved.ask,
      mode: resolved.mode, dte: resolved.dte,
      rsi: body.rsi != null ? parseFloat(body.rsi) : null,
      vwap: body.vwap != null ? parseFloat(body.vwap) : null,
      vwapBias: body.vwapBias || null,
      volRatio: body.volRatio != null ? parseFloat(body.volRatio) : null,
      bearFVGTop: body.bearFVGTop != null ? parseFloat(body.bearFVGTop) : null,
      bearFVGBottom: body.bearFVGBottom != null ? parseFloat(body.bearFVGBottom) : null,
      bullFVGTop: body.bullFVGTop != null ? parseFloat(body.bullFVGTop) : null,
      bullFVGBottom: body.bullFVGBottom != null ? parseFloat(body.bullFVGBottom) : null,
      fib125: body.fib125 != null ? parseFloat(body.fib125) : null,
      bullBOS: body.bullBOS || null, bearBOS: body.bearBOS || null,
      bullLiqGrab: body.bullLiqGrab || null, bearLiqGrab: body.bearLiqGrab || null,
      momCount: body.momCount != null ? parseFloat(body.momCount) : null,
      sqzFiring: body.sqzFiring || null,
      adx: body.adx != null ? parseFloat(body.adx) : null,
      debit: resolved.debit || null, maxProfit: resolved.maxProfit || null,
      breakeven: resolved.breakeven || null, sellStrike: resolved.sellStrike || null,
      spreadWidth: resolved.spreadWidth || null,
    };
    alerter.sendTradeAlert(resolved.symbol, tvBias, {}, true, resolved).catch(console.error);
    res.json({ status: 'processing', ticker: ticker, opra: resolved.symbol, brainBridged: !!(brainEngine && brainEngine.pushTVSignal) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------
// TRADINGVIEW BRAIN ALERT WEBHOOK
// Receives GO CALLS/GO PUTS from Brain indicator on TradingView
// Pushes signal into brain engine queue for immediate processing
// Alert message format: {"ticker":"SPY","direction":"CALLS","source":"GO_CALLS"}
// Or plain text: "GO CALLS SPY" / "GO PUTS QQQ"
// ---------------------------------------------------------------
app.post('/webhook/tv-brain', function(req, res) {
  try {
    var body = req.body || {};
    var text = typeof body === 'string' ? body : (body.message || body.text || '');
    var ticker = null;
    var direction = null;
    var source = 'TV_BRAIN';

    // Format 1: JSON {"ticker":"SPY","direction":"CALLS"}
    if (body.ticker && body.direction) {
      ticker = body.ticker.toUpperCase();
      direction = body.direction.toUpperCase();
      source = body.source || 'TV_BRAIN';
    }
    // Format 2: Plain text "GO CALLS SPY" or "GO PUTS QQQ"
    if (!ticker && text) {
      var callMatch = text.match(/GO\s*CALLS?\s+([A-Z]{1,5})/i);
      var putMatch = text.match(/GO\s*PUTS?\s+([A-Z]{1,5})/i);
      if (callMatch) { ticker = callMatch[1].toUpperCase(); direction = 'CALLS'; source = 'GO_CALLS'; }
      if (putMatch) { ticker = putMatch[1].toUpperCase(); direction = 'PUTS'; source = 'GO_PUTS'; }
    }
    // Format 3: TradingView alert format {{ticker}} {{strategy.order.action}}
    if (!ticker && body.ticker) {
      ticker = body.ticker.toUpperCase();
      if (/call|long|buy|bull/i.test(body.action || body.order || text)) direction = 'CALLS';
      if (/put|short|sell|bear/i.test(body.action || body.order || text)) direction = 'PUTS';
    }
    // Format 4: JSmith REVERSAL — "Bullish Setup" / "Bearish Setup" or "TRADE IDEA: 260 Calls"
    if (!ticker && text) {
      var bullSetup = text.match(/bullish\s*setup/i);
      var bearSetup = text.match(/bearish\s*setup/i);
      var tradeIdea = text.match(/TRADE\s*IDEA[:\s]*(\d+)\s*(calls?|puts?)/i);
      var jsTicker = (body.ticker || '').toUpperCase() || (text.match(/([A-Z]{1,5})/) || [])[1];
      if (bullSetup && jsTicker) { ticker = jsTicker; direction = 'CALLS'; source = 'JSMITH_REVERSAL'; }
      if (bearSetup && jsTicker) { ticker = jsTicker; direction = 'PUTS'; source = 'JSMITH_REVERSAL'; }
      if (!ticker && tradeIdea) { ticker = jsTicker || 'SPY'; direction = /call/i.test(tradeIdea[2]) ? 'CALLS' : 'PUTS'; source = 'JSMITH_REVERSAL'; }
    }
    // Format 5: GOLD indicator F2U/F2D — "GOLD Failed 2 Down (Closed above 50%)" with {{ticker}}
    // Also handles JSmith F2U/F2D alerts
    if (!ticker && text) {
      var f2u = text.match(/f2u|failed\s*2\s*(up|u)/i);
      var f2d = text.match(/f2d|failed\s*2\s*(down|d)/i);
      var fiftyPct = /50%/i.test(text);
      // Skip indicator name "GOLD" and common words — grab last uppercase word as ticker
      // TradingView appends {{ticker}} at end, e.g. "GOLD Failed 2 Down (Closed above 50%) RIOT"
      var f2Words = text.match(/\b([A-Z]{1,5})\b/g) || [];
      var skipWords = ['GOLD', 'FAILED', 'DOWN', 'UP', 'CLOSED', 'ABOVE', 'BELOW', 'PCT', 'STANDARD'];
      var f2Ticker = (typeof body === 'object' && body.ticker || '').toUpperCase() ||
        (f2Words.filter(function(w) { return skipWords.indexOf(w) === -1; })[0] || '');
      if (f2u && f2Ticker) { ticker = f2Ticker; direction = 'PUTS'; source = fiftyPct ? 'JSMITH_F2U_50PCT' : 'JSMITH_FAILED2'; }
      if (f2d && f2Ticker) { ticker = f2Ticker; direction = 'CALLS'; source = fiftyPct ? 'JSMITH_F2D_50PCT' : 'JSMITH_FAILED2'; }
    }

    if (!ticker || !direction) {
      console.log('[TV-BRAIN] 400 - Could not parse. Body type:', typeof body, 'Body:', JSON.stringify(body).slice(0, 200));
      return res.status(400).json({ error: 'Could not parse ticker/direction', received: body });
    }

    if (brainEngine) {
      brainEngine.pushTVSignal({
        ticker: ticker,
        direction: direction,
        source: source,
        momCount: body.momCount || null,
        sqzFiring: body.sqzFiring || null,
        vwap: body.vwap || null,
        confluence: body.confluence || null,
      });
    }

    console.log('[TV-BRAIN] Signal received: ' + ticker + ' ' + direction + ' from ' + source);
    res.json({ status: 'queued', ticker: ticker, direction: direction, source: source });
  } catch(e) {
    console.error('[TV-BRAIN] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhook/bullflow', async function(req, res) {
  try {
    var opra = req.body.opra || req.body.symbol || null;
    if (!opra) return res.status(400).json({ error: 'No OPRA' });
    alerter.sendTradeAlert(opra, {}, req.body, false).catch(console.error);
    res.json({ status: 'processing', opra: opra });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- CLAUDE MCP POSITIONS BRIDGE --------------------------------
// Claude chat pushes live positions here via MCP every 5 minutes
// alerter.js reads livePositions for conflict checking
var livePositions = {};
var livePositionsUpdated = null;

app.post('/webhook/positions', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    livePositions = req.body.positions || {};
    livePositionsUpdated = new Date().toISOString();
    console.log('[POSITIONS] Updated from Claude MCP -- ' + Object.keys(livePositions).length + ' tickers');
    res.json({ status: 'OK', tickers: Object.keys(livePositions), updated: livePositionsUpdated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook/positions', function(req, res) {
  res.json({ positions: livePositions, updated: livePositionsUpdated, tickers: Object.keys(livePositions) });
});

// Export so alerter.js can read live positions
module.exports.getLivePositions = function() { return livePositions; };
module.exports.getLivePositionsUpdated = function() { return livePositionsUpdated; };

app.get('/prices', async function(req, res) {
  var ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
  try {
    var price = await resolver.getPrice(ticker);
    if (!price) return res.status(404).json({ error: 'No price' });
    res.json({ ticker: ticker, price: price, live: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- GOAL TRACKER ------------------------------------------------
app.get('/goal', function(req, res) {
  if (!goalTracker) return res.json({ status: 'Goal tracker not loaded' });
  res.json(goalTracker.getState());
});
app.post('/goal/trade', function(req, res) {
  if (!goalTracker) return res.json({ status: 'Goal tracker not loaded' });
  var ticker = req.body.ticker;
  var pnl    = req.body.pnl;
  if (!ticker || pnl == null) return res.status(400).json({ error: 'Missing ticker or pnl' });
  goalTracker.recordTrade(ticker, parseFloat(pnl));
  goalTracker.postGoalUpdate().catch(console.error);
  if (weeklyTracker) {
    try { weeklyTracker.recordFill(ticker, parseFloat(pnl), req.body.source || 'manual'); }
    catch(e) { console.error('[WEEKLY] recordFill error:', e.message); }
  }
  res.json({ daily: goalTracker.getState(), weekly: weeklyTracker ? weeklyTracker.getState() : null });
});

// -- CLAUDE MCP GOAL BRIDGE ------------------------------------
// Claude pushes realized P&L here via MCP after each trade closes
app.post('/webhook/goal', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    var realizedPnL = req.body.realizedPnL || 0;
    var trades      = req.body.trades || [];
    if (!goalTracker) return res.json({ status: 'Goal tracker not loaded' });
    goalTracker.updateFromMCP(realizedPnL, trades);
    goalTracker.postGoalUpdate().catch(console.error);
    console.log('[GOAL] Updated from Claude MCP -- $' + realizedPnL);
    res.json({ status: 'OK', realizedPnL: realizedPnL, state: goalTracker.getState() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- WEEKLY TRACKER ---------------------------------------------
app.get('/api/weekly', function(req, res) {
  if (!weeklyTracker) return res.json({ status: 'Weekly tracker not loaded' });
  res.json(weeklyTracker.getState());
});
app.post('/api/weekly/fill', function(req, res) {
  if (!weeklyTracker) return res.json({ status: 'Weekly tracker not loaded' });
  var ticker = req.body.ticker;
  var pnl    = req.body.pnl;
  var source = req.body.source;
  if (!ticker || pnl == null) return res.status(400).json({ error: 'Missing ticker or pnl' });
  weeklyTracker.recordFill(ticker, parseFloat(pnl), source);
  res.json(weeklyTracker.getState());
});
// Seed weekly P&L -- one-shot loader for historical options realized.
// Body: { fills: [{ticker, pnl, source, date}], resetFirst: true }
app.post('/api/weekly/seed', function(req, res) {
  if (!weeklyTracker) return res.json({ status: 'Weekly tracker not loaded' });
  var fills = req.body.fills || [];
  if (!Array.isArray(fills)) return res.status(400).json({ error: 'fills must be array' });
  var results = [];
  fills.forEach(function(f) {
    if (!f || f.pnl == null) return;
    var r = weeklyTracker.recordFill(f.ticker || '?', parseFloat(f.pnl), f.source || 'seed');
    results.push({ ticker: f.ticker, pnl: f.pnl, weeklyAfter: r.totalPnL });
  });
  res.json({ status: 'seeded', count: results.length, state: weeklyTracker.getState() });
});
// -- STOP MANAGER -----------------------------------------------
app.post('/api/stops/prepare', function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  try { res.json(stopManager.prepareOrder(req.body || {})); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stops/attach', async function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  try {
    var r = await stopManager.attachStopAfterFill(req.body || {});
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stops/cancel/:orderId', async function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  try { res.json(await stopManager.cancelStop(req.params.orderId)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stops/trail/begin', async function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  try { res.json(await stopManager.beginStructuralTrail(req.body || {})); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stops/trail/step', async function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  try { res.json(await stopManager.trailStep(req.body.ticker, req.body.symbol)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/stops/trail/state', function(req, res) {
  if (!stopManager) return res.status(500).json({ error: 'Stop manager not loaded' });
  res.json(stopManager.getTrailState());
});

app.post('/api/weekly/post', function(req, res) {
  if (!weeklyTracker) return res.json({ status: 'Weekly tracker not loaded' });
  weeklyTracker.postWeeklySummary().catch(console.error);
  res.json({ status: 'posted' });
});

// -- SMART STOPS -------------------------------------------------
app.get('/stops/:ticker', async function(req, res) {
  if (!smartStops) return res.json({ status: 'Smart stops not loaded' });
  var ticker  = req.params.ticker.toUpperCase();
  var type    = (req.query.type    || 'call').toLowerCase();
  var premium = parseFloat(req.query.premium || '2.00');
  var delta   = parseFloat(req.query.delta   || '0.45');
  try {
    var result = await smartStops.getSmartStop(ticker, type, premium, delta);
    res.json(result || { error: 'No data available' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- POSITION OFFSET ---------------------------------------------
app.get('/test/offset', async function(req, res) {
  if (!positionOffset) return res.json({ status: 'not loaded' });
  try { await positionOffset.runOffsetAnalysis(); res.json({ status: 'OK' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// -- TRADESTATION AUTH ------------------------------------------
app.get('/ts-auth', function(req, res) {
  if (!ts) return res.send('<h2>TradeStation module not loaded</h2>');
  res.redirect(ts.getLoginUrl());
});
app.get('/ts-callback', async function(req, res) {
  if (!ts) return res.send('<h2>TradeStation module not loaded</h2>');
  var code = req.query.code;
  var overrideRedirect = req.query.redirect_uri || null;
  if (!code) return res.send('<h2>Error: No code received</h2>');
  try {
    var data = overrideRedirect
      ? await ts.exchangeCodeWithRedirect(code, overrideRedirect)
      : await ts.exchangeCode(code);
    if (data.refresh_token) {
      ts.setRefreshToken(data.refresh_token);
      res.send('<h2>TradeStation Connected!</h2><p>Add this as TS_REFRESH_TOKEN in Railway:</p><textarea rows=4 cols=80 onclick=this.select()>' + data.refresh_token + '</textarea>');
    } else {
      res.send('<h2>Auth Failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch(e) { res.send('<h2>Error: ' + e.message + '</h2>'); }
});

// -- TRADING JOURNAL --------------------------------------------
app.post('/webhook/journal', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!tradingJournal) return res.json({ status: 'Journal not loaded' });
    var data = req.body;
    var state = await tradingJournal.writeJournal(data);
    res.json({ status: 'OK', state });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/journal', function(req, res) {
  if (!tradingJournal) return res.json({ status: 'Journal not loaded' });
  res.json(tradingJournal.getState());
});

// -- MACRO FILTER WEBHOOK ---------------------------------------
app.post('/webhook/macro', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    var bias = req.body.bias;
    if (macroFilter && bias) {
      macroFilter.setManualBias(bias);
      console.log('[MACRO] Manual bias set to:', bias);
    }
    res.json({ status: 'OK', bias: bias });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- HOLD LOCK WEBHOOK -------------------------------------------
app.post('/webhook/hold', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    var { ticker, type, holdUntil, reason, override } = req.body;
    if (override && holdLock) {
      holdLock.overrideHold(ticker, type);
      return res.json({ status: 'OK', action: 'override', ticker, type });
    }
    if (holdLock && ticker && type && holdUntil) {
      holdLock.addHold(ticker, type, holdUntil, reason);
    }
    res.json({ status: 'OK', holds: holdLock ? holdLock.getActiveHolds() : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- EXECUTE NOW RESET -------------------------------------------
app.post('/webhook/reset-day', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (executeNow) executeNow.resetDailySetups();
    res.json({ status: 'OK', message: 'Daily setups reset' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- IDEA INGESTOR ENDPOINTS ------------------------------------
// POST /webhook/idea -- submit a trade idea for validation
// GET  /idea/watchlist -- see all ideas being monitored
// DELETE /idea/remove -- remove an idea from watchlist
app.post('/webhook/idea', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!ideaIngestor) return res.json({ status: 'ideaIngestor not loaded' });
    var idea   = req.body;
    var result = await ideaIngestor.ingestIdea(idea);
    res.json({ status: 'OK', result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/idea/watchlist', function(req, res) {
  if (ideaIngestor) {
    res.json({ status: 'OK', watchlist: ideaIngestor.getWatchlist() });
  } else {
    res.json({ status: 'ideaIngestor not loaded' });
  }
});

app.post('/idea/remove', function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (ideaIngestor) {
      var removed = ideaIngestor.removeIdea(req.body.ticker, req.body.triggerPrice);
      res.json({ status: 'OK', removed });
    } else {
      res.json({ status: 'ideaIngestor not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- WIN RATE ENDPOINT
app.get('/win-rate', async function(req, res) {
  if (winTracker) {
    res.json({ stats: winTracker.getStats(), winRate: winTracker.getWinRate(), report: winTracker.buildReport() });
  } else {
    res.json({ status: 'winTracker not loaded' });
  }
});

// -- TAKE-TRADE ENDPOINT (Apr 26 2026) ---------------------------
// POST /api/take-trade — manual 1-click fire from scanner UI
//
// Body: {
//   cardId: '<from flow-card buffer>'   OR provide bracket directly:
//   ticker, action ('BUYTOOPEN' for both calls/puts since it's an option),
//   symbol (OPRA), qty (1-10), entry, stop, tp1, tp2, tp3?,
//   live (bool, default false → SIM), confirmOver (bool, required if dollarRisk>$500),
//   source ('flow-card' | 'setup-card' | 'manual')
// }
//
// Behavior: fires N=qty SEPARATE 1-ct brackets, each with its own (stop, TP)
// bracket. TP ladder cycles: [TP1, TP2, TP3, TP1, TP2, ...].
// AB workflow: 1 click → N brackets → if TP1 hits, bracket1 closes, others
// keep running on stop. Avoids Titan's manual "modify TP, change qty" flow.
//
// Safety:
//   - Requires STRATUM_SECRET header
//   - Daily fire-count cap (5 by default, configurable via TAKE_TRADE_DAILY_CAP)
//   - Per-trade dollar-risk cap ($500 default; override with confirmOver=true)
//   - Logs every attempt to /data/take-trade-log.json + Discord audit webhook
var _takeTradeDailyState = { date: null, fires: 0 };
function _getTakeTradeETDate() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}
function _resetTakeTradeIfNewDay() {
  var d = _getTakeTradeETDate();
  if (_takeTradeDailyState.date !== d) {
    _takeTradeDailyState = { date: d, fires: 0 };
  }
}
async function _logTakeTrade(entry) {
  try {
    var logPath = (process.env.STATE_DIR || '/data') + '/take-trade-log.json';
    var prior = [];
    try { prior = JSON.parse(require('fs').readFileSync(logPath, 'utf8')); } catch(_) {}
    prior.unshift(entry);
    if (prior.length > 200) prior.length = 200;
    require('fs').writeFileSync(logPath, JSON.stringify(prior, null, 2));
  } catch(e) { console.error('[TAKE-TRADE] log error:', e.message); }
}
async function _postTakeTradeAudit(entry) {
  try {
    var url = process.env.DISCORD_STRATUMEXTERNAL_WEBHOOK || process.env.DISCORD_FLOW_WEBHOOK_URL;
    if (!url) return;
    var lines = [
      (entry.trigger ? '🎯 **CONDITIONAL BRACKET QUEUED**' : '⚡ **TAKE TRADE FIRED**') + ' — ' + entry.ticker + ' ' + entry.direction,
      '`' + entry.symbol + '`',
      'qty ' + entry.qty + ' · entry $' + entry.entry + ' · stop $' + entry.stop + ' · TPs ' + entry.tps.join('/'),
      (entry.trigger ? 'trigger: ' + entry.trigger.symbol + ' ' + entry.trigger.predicate + ' $' + entry.trigger.price : 'fires immediately'),
      'risk $' + entry.dollarRisk + ' · source ' + entry.source + ' · ' + (entry.live ? 'LIVE' : 'SIM'),
      'fires today: ' + entry.dailyFire + '/' + entry.dailyCap,
      entry.results.length + ' bracket(s) submitted: ' + entry.results.map(function(r){ return r.ok ? '✓' + (r.orderId || 'OK') : '✗' + (r.error || 'FAIL'); }).join(' '),
    ];
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n'), username: 'Take-Trade' }),
    });
  } catch(e) { console.error('[TAKE-TRADE] audit post error:', e.message); }
}
app.post('/api/take-trade', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderExecutor) return res.status(500).json({ error: 'orderExecutor not loaded' });

    var b = req.body || {};
    var qty = Math.max(1, Math.min(10, parseInt(b.qty) || 1));
    var live = b.live === true;

    // Resolve bracket: from cardId (look up flow-card buffer) or from explicit body.
    // v2 (Apr 28): Live Movers + Tomorrow setups carry an audit cardId but supply
    // their own bracket fields directly. Only do buffer lookup for actual flow cards.
    var card = null;
    var isFlowBufferCard = b.cardId && !b.cardId.startsWith('live-mover-') && !b.cardId.startsWith('tomorrow-') && b.entry === undefined;
    if (isFlowBufferCard) {
      var cards = flowCluster.getActiveCards();
      card = cards.find(function(c){ return c.id === b.cardId; });
      if (!card) return res.status(404).json({ error: 'cardId not found in active flow-card buffer (Bullflow disabled?). Pass entry/stop/tp1/tp2 directly in body.' });
      if (!card.contract || !card.bracket) return res.status(400).json({ error: 'card has no resolved contract or bracket — cannot fire' });
    }

    var ticker  = (card ? card.ticker  : b.ticker)  || null;
    var symbol  = (card ? (card.contract && card.contract.symbol) : b.symbol) || null;
    var entry   = parseFloat(card ? card.bracket.entry : b.entry);
    var stop    = parseFloat(card ? card.bracket.stop  : b.stop);
    var tp1     = parseFloat(card ? card.bracket.tp1   : b.tp1);
    var tp2     = parseFloat(card ? card.bracket.tp2   : b.tp2);
    var tp3     = b.tp3 ? parseFloat(b.tp3) : null;  // optional runner
    var direction = card ? card.direction : (b.direction || 'BULLISH');

    if (!symbol) return res.status(400).json({ error: 'symbol required (or cardId pointing to resolved contract)' });
    if (!entry || !tp1) return res.status(400).json({ error: 'entry and tp1 required' });
    // Either stop (option-premium StopLimit) or structuralStop (underlying activation) required
    if (!stop && !(b.structuralStop && b.structuralStop.symbol && b.structuralStop.price)) {
      return res.status(400).json({ error: 'either stop (option price) or structuralStop {symbol,predicate,price} required' });
    }
    // If only structuralStop given, use a sentinel option-price stop for risk estimation
    if (!stop) stop = entry * 0.7;

    // Build TP ladder for N brackets (cycle through tp1/tp2/tp3 as available)
    var tpLadder = [tp1, tp2 || tp1, tp3 || tp2 || tp1];
    var brackets = [];
    for (var i = 0; i < qty; i++) {
      brackets.push({ slot: i + 1, qty: 1, entry: entry, stop: stop, tp: tpLadder[i % tpLadder.length] });
    }

    // Dollar-risk cap (per-CLICK total = qty × per-contract risk × 100)
    var perCtRisk = Math.abs(entry - stop);
    var dollarRisk = Math.round(perCtRisk * 100 * qty);
    // Apr 27 2026 PM — cap raised $500 → $1500 to allow AVGO/CRWD 2-3ct sizing
    // (per-ct risk $260-280 means even 1ct on those names would have hit the
    // old cap with extra commission). Higher names like NVDA/META still need
    // the OVER override at extreme size.
    var DOLLAR_CAP = parseInt(process.env.TAKE_TRADE_DOLLAR_CAP || '1500');
    if (dollarRisk > DOLLAR_CAP && b.confirmOver !== true) {
      return res.status(412).json({ error: 'dollar_risk_over_cap', dollarRisk: dollarRisk, cap: DOLLAR_CAP, hint: 'resubmit with confirmOver:true to override' });
    }

    // Daily fire-count cap
    _resetTakeTradeIfNewDay();
    var DAILY_CAP = parseInt(process.env.TAKE_TRADE_DAILY_CAP || '5');
    if (_takeTradeDailyState.fires >= DAILY_CAP) {
      return res.status(429).json({ error: 'daily_cap_reached', fires: _takeTradeDailyState.fires, cap: DAILY_CAP, hint: 'use Titan directly for additional trades today' });
    }

    var account = live ? '11975462' : 'SIM3142118M';

    // Optional conditional trigger: queue the bracket at TS until underlying
    // crosses a price level. Apr 26 2026 — for setup-card click-through where
    // AB pre-queues brackets Sunday for Monday-open auto-fire.
    var trigger = null;
    if (b.trigger && b.trigger.symbol && b.trigger.price) {
      trigger = {
        symbol:    String(b.trigger.symbol).toUpperCase(),
        predicate: (b.trigger.predicate || 'above').toLowerCase(),
        price:     parseFloat(b.trigger.price),
      };
    }

    // Apr 26 PM — manualFire bypasses time-of-day gates in orderExecutor.
    // ALL fires through /api/take-trade are human-clicked, so by definition
    // manual. The dead-zone / first-15-min gates exist to stop AUTO-fire,
    // not to gate trader-driven entries the human has eyeballed.
    var manualFire = true;

    // Apr 26 PM — structuralStop attaches a MarketActivationRule on the
    // UNDERLYING ticker to the bracket's stop child. Stop fires on the
    // structural level breaking, NOT on option-price wicks. Tail-risk-event
    // proof. When present, takes precedence over the option-price stop.
    var structuralStop = null;
    if (b.structuralStop && b.structuralStop.symbol && b.structuralStop.price) {
      structuralStop = {
        symbol:    String(b.structuralStop.symbol).toUpperCase(),
        predicate: (b.structuralStop.predicate || 'below').toLowerCase(),
        price:     parseFloat(b.structuralStop.price),
      };
    }

    // Fire the N brackets sequentially. Each is a separate POST so they're
    // independent — AB's "1 click → N brackets, each with own TP" workflow.
    var results = [];
    for (var k = 0; k < brackets.length; k++) {
      var br = brackets[k];
      try {
        var r = await orderExecutor.placeOrder({
          account:  account,
          symbol:   symbol,
          action:   'BUYTOOPEN',
          qty:      br.qty,
          limit:    br.entry,
          stop:     br.stop,
          t1:       br.tp,
          duration: 'GTC',
          note:     'take-trade slot ' + br.slot + '/' + qty + ' (TP=' + br.tp + ') src=' + (b.source || 'manual') + (trigger ? ' trig=' + trigger.symbol + trigger.predicate + trigger.price : '') + (structuralStop ? ' structStop=' + structuralStop.symbol + structuralStop.predicate + structuralStop.price : ''),
          trigger:  trigger,                // null if no conditional entry, else fires on underlying cross
          manualFire: manualFire,           // human-click bypass for time-of-day gates
          structuralStop: structuralStop,   // null = use option-premium stop; else underlying activation
        });
        results.push(r && r.error
          ? { slot: br.slot, ok: false, error: r.error }
          : { slot: br.slot, ok: true, orderId: r && r.orderId, tp: br.tp });
      } catch(e) {
        results.push({ slot: br.slot, ok: false, error: e.message });
      }
    }

    // Apr 26 PM bug fix — only count SUCCESSFUL bracket placements against
    // the daily cap. Failed attempts (blacklist, TS reject, risk-cap, etc.)
    // should not burn a daily slot.
    var anySuccess = results.some(function(r){ return r.ok === true; });
    if (anySuccess) {
      _takeTradeDailyState.fires++;
    } else {
      console.log('[TAKE-TRADE] All ' + results.length + ' bracket(s) failed — daily counter NOT incremented (was ' + _takeTradeDailyState.fires + '/5)');
    }

    // Audit + log
    var auditEntry = {
      ts:         new Date().toISOString(),
      ticker:     ticker,
      symbol:     symbol,
      direction:  direction,
      qty:        qty,
      entry:      entry,
      stop:       stop,
      tps:        tpLadder.slice(0, qty),
      trigger:    trigger,
      structuralStop: structuralStop,
      dollarRisk: dollarRisk,
      live:       live,
      source:     b.source || 'manual',
      cardId:     b.cardId || null,
      dailyFire:  _takeTradeDailyState.fires,
      dailyCap:   DAILY_CAP,
      results:    results,
    };
    await _logTakeTrade(auditEntry);
    await _postTakeTradeAudit(auditEntry);

    res.json({
      status: 'OK',
      qty: qty,
      brackets: results,
      dollarRisk: dollarRisk,
      dailyFire: _takeTradeDailyState.fires,
      dailyCap: DAILY_CAP,
      live: live,
    });
  } catch(e) {
    console.error('[TAKE-TRADE] handler error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Read the full take-trade audit log (last 200 entries persisted on /data)
app.get('/api/take-trade/log', function(req, res) {
  try {
    var logPath = (process.env.STATE_DIR || '/data') + '/take-trade-log.json';
    var data = require('fs').readFileSync(logPath, 'utf8');
    var entries = JSON.parse(data);
    var limit = parseInt((req.query && req.query.limit) || '20', 10);
    res.json({ ok: true, count: entries.length, entries: entries.slice(0, limit) });
  } catch(e) { res.status(404).json({ ok: false, error: 'no log file yet — first take-trade fire will create it' }); }
});

// Manual reset of daily counter — guarded by STRATUM_SECRET. For testing
// when you've burned the SIM slots and need to validate the LIVE path before
// waiting for midnight ET. Logs a warning so the reset is visible in audit.
app.post('/api/take-trade/reset', function(req, res) {
  var secret = req.headers['x-stratum-secret'];
  if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  var prior = Object.assign({}, _takeTradeDailyState);
  _takeTradeDailyState = { date: _getTakeTradeETDate(), fires: 0 };
  console.log('[TAKE-TRADE] DAILY COUNTER RESET via /api/take-trade/reset — was ' + (prior.fires || 0) + '/5, now 0/5');
  res.json({ ok: true, prior: prior, current: _takeTradeDailyState });
});

// Read-only daily counter so the UI can warn before clicking
app.get('/api/take-trade/state', function(req, res) {
  _resetTakeTradeIfNewDay();
  res.json({
    date: _takeTradeDailyState.date,
    fires: _takeTradeDailyState.fires,
    cap: parseInt(process.env.TAKE_TRADE_DAILY_CAP || '5'),
    dollarCap: parseInt(process.env.TAKE_TRADE_DOLLAR_CAP || '1500'),
  });
});

// -- ORDER EXECUTION ENDPOINT -----------------------------------
// POST /webhook/execute -- place order directly via TS API
// Supports SIM and LIVE accounts
// Full bracket: entry + stop + T1 in one order
app.post('/webhook/execute', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderExecutor) return res.json({ status: 'orderExecutor not loaded' });

    var params = req.body;
    // Default to SIM unless live explicitly specified
    if (!params.account) {
      params.account = params.live ? '11975462' : 'SIM3142118M';
    }

    console.log('[EXECUTE] Incoming order:', JSON.stringify(params));
    var result = await orderExecutor.placeOrder(params);

    if (result.error) {
      console.error('[EXECUTE] Order failed:', result.error);
      return res.status(400).json({ status: 'ERROR', error: result.error });
    }

    res.json({ status: 'OK', result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /webhook/close -- close a position

// ---------------------------------------------------------------
// POST /api/protect-position -- attach stop + TP brackets to an EXISTING
// position (e.g. when AB had to open manually and needs sells wired up).
// Body: {
//   account: "11975462" | "SIM3142118M",
//   symbol: "HOOD 260501C86",
//   underlyingSymbol: "HOOD",
//   stopUnderlyingPrice: 82.50,         // structural stop on UNDERLYING
//   tps: [                              // partial-close limit legs
//     { qty: 2, limitPrice: 5.06 },
//     { qty: 2, limitPrice: 6.08 },
//     { qty: 1, limitPrice: 8.10 }
//   ],
//   totalQty: 5,                        // total contracts (used for stop size)
//   stopPredicate: "below"              // "below" for calls, "above" for puts
// }
// Fires N orders to TS API: 1 stop-on-underlying + N TP limits. Returns
// per-order results so AB can see which legs filled.
// ---------------------------------------------------------------
app.post('/api/protect-position', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    var b = req.body || {};
    var account     = String(b.account || '').trim();
    var symbol      = String(b.symbol || '').trim();
    var underlying  = String(b.underlyingSymbol || '').toUpperCase().trim();
    var stopPrice   = parseFloat(b.stopUnderlyingPrice);
    var stopPred    = (String(b.stopPredicate || 'below').toLowerCase() === 'above') ? 'Gt' : 'Lt';
    var totalQty    = parseInt(b.totalQty);
    var tps         = Array.isArray(b.tps) ? b.tps : [];
    var skipStop    = b.skipStop === true;
    var cancelOrderId = b.cancelOrderId ? String(b.cancelOrderId) : null;

    if (!account || !symbol || !underlying || !isFinite(totalQty) || totalQty <= 0) {
      return res.status(400).json({ error: 'missing or invalid: account, symbol, underlyingSymbol, totalQty' });
    }
    if (!skipStop && !isFinite(stopPrice)) {
      return res.status(400).json({ error: 'missing stopUnderlyingPrice (or set skipStop:true to fire only TPs)' });
    }

    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.status(500).json({ error: 'no TS token' });

    var fetch  = require('node-fetch');
    var isSim  = /^SIM/.test(account);
    var apiBase = isSim ? 'https://sim-api.tradestation.com/v3' : 'https://api.tradestation.com/v3';

    var ordersFired = [];

    // ORDER 0: Cancel existing order if cancelOrderId specified (for stop swaps)
    if (cancelOrderId) {
      try {
        var cancelRes = await fetch(apiBase + '/orderexecution/orders/' + cancelOrderId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var cancelData;
        try { cancelData = await cancelRes.json(); } catch(e) { cancelData = { status: cancelRes.status }; }
        ordersFired.push({ type: 'CANCEL', orderId: cancelOrderId, status: cancelRes.status, result: cancelData });
      } catch(e) { ordersFired.push({ type: 'CANCEL', orderId: cancelOrderId, error: e.message }); }
    }

    // ORDER 1: STOP on underlying — sells full position when UL crosses stop
    if (!skipStop) {
      var stopOrder = {
        AccountID: account,
        Symbol: symbol,
        Quantity: String(totalQty),
        OrderType: 'Market',
        TradeAction: 'SELLTOCLOSE',
        TimeInForce: { Duration: 'GTC' },
        AdvancedOptions: {
          MarketActivationRules: [{
            RuleType: 'Price',
            Symbol: underlying,
            Predicate: stopPred,
            TriggerKey: 'STT',
            Price: stopPrice.toFixed(2)
          }]
        }
      };
      try {
        var stopRes = await fetch(apiBase + '/orderexecution/orders', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(stopOrder)
        });
        var stopData = await stopRes.json();
        ordersFired.push({ type: 'STOP', symbol: symbol, qty: totalQty, trigger: underlying + ' ' + stopPred + ' ' + stopPrice.toFixed(2), status: stopRes.status, result: stopData });
      } catch(e) { ordersFired.push({ type: 'STOP', error: e.message }); }
    }

    // ORDERS 2..N: TP LIMIT legs
    for (var i = 0; i < tps.length; i++) {
      var leg = tps[i] || {};
      var legQty   = parseInt(leg.qty);
      var legPrice = parseFloat(leg.limitPrice);
      if (!isFinite(legQty) || legQty <= 0 || !isFinite(legPrice) || legPrice <= 0) {
        ordersFired.push({ type: 'TP', error: 'bad leg ' + JSON.stringify(leg) });
        continue;
      }
      var tpOrder = {
        AccountID: account,
        Symbol: symbol,
        Quantity: String(legQty),
        OrderType: 'Limit',
        TradeAction: 'SELLTOCLOSE',
        TimeInForce: { Duration: 'GTC' },
        LimitPrice: legPrice.toFixed(2)
      };
      try {
        var tpRes = await fetch(apiBase + '/orderexecution/orders', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(tpOrder)
        });
        var tpData = await tpRes.json();
        ordersFired.push({ type: 'TP' + (i + 1), symbol: symbol, qty: legQty, limit: legPrice.toFixed(2), status: tpRes.status, result: tpData });
      } catch(e) { ordersFired.push({ type: 'TP' + (i + 1), error: e.message }); }
    }

    var anyOK = ordersFired.some(function(o){ return o.status >= 200 && o.status < 300; });
    res.json({ ok: anyOK, account: account, symbol: symbol, totalQty: totalQty, ordersFired: ordersFired });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------
// GEXR WEBHOOK -- receives ATR Long/Short from TradingView
// GEXR Matrix indicator fires this when direction changes
// Stores direction for all signal filtering
// ---------------------------------------------------------------
app.post('/webhook/gexr', function(req, res) {
  try {
    var body = req.body || {};
    var text = typeof body === 'string' ? body : JSON.stringify(body);

    // Parse direction from multiple possible formats
    var direction = null;
    var level     = null;
    var ticker    = body.ticker || body.symbol || 'SPY';

    // Format 1: {"type":"gexr","direction":"above","ticker":"SPY"}
    if (body.direction) {
      direction = body.direction.toLowerCase();
    }
    // Format 2: {"action":"ATR Long"} or {"action":"ATR Short"}
    if (!direction && body.action) {
      if (/long/i.test(body.action))  direction = 'above';
      if (/short/i.test(body.action)) direction = 'below';
    }
    // Format 3: plain text "ATR Long" or "ATR Short"
    if (!direction && typeof body === 'string') {
      if (/long/i.test(body))  direction = 'above';
      if (/short/i.test(body)) direction = 'below';
    }
    // Format 4: message field
    if (!direction && body.message) {
      if (/long/i.test(body.message))  direction = 'above';
      if (/short/i.test(body.message)) direction = 'below';
    }

    if (!direction) {
      console.log('[GEXR] Could not parse direction from payload:', JSON.stringify(body));
      return res.json({ status: 'error', reason: 'Could not parse GEXR direction' });
    }

    level = body.level || body.price || null;

    // Store globally for all signal filtering
    global.gexrDirection = direction; // 'above' or 'below'
    global.gexrLevel     = level;
    global.gexrTicker    = ticker;
    global.gexrUpdatedAt = new Date().toISOString();

    console.log('[GEXR] Direction updated:', direction.toUpperCase(),
      level ? '| Level: $' + level : '',
      '| Ticker:', ticker);

    // Post to Discord indices-bias channel
    var indicesWebhook = process.env.DISCORD_INDICES_WEBHOOK;
    if (indicesWebhook) {
      var emoji     = direction === 'above' ? '\uD83D\uDFE2' : '\uD83D\uDD34';
      var sentiment = direction === 'above' ? 'BULLISH' : 'BEARISH';
      var callPut   = direction === 'above' ? 'CALLS ONLY' : 'PUTS ONLY';
      var lines = [
        emoji + ' GEXR UPDATE -- ' + sentiment,
        '========================================',
        'Direction:  ' + direction.toUpperCase() + ' GEXR line',
        'Bias:       ' + sentiment,
        'Trade:      ' + callPut,
        level ? 'Level:      $' + level : '',
        'Time:       ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET',
        '========================================',
        'All signals now filtered for ' + callPut,
      ].filter(Boolean).join('\n');

      fetch(indicesWebhook, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          content:  '```\n' + lines + '\n```',
          username: 'Stratum GEXR',
        }),
      }).catch(function(e) { console.error('[GEXR] Discord error:', e.message); });
    }

    res.json({
      status:    'ok',
      direction: direction,
      level:     level,
      ticker:    ticker,
      message:   'GEXR direction updated: ' + direction.toUpperCase() + ' -- ' + (direction === 'above' ? 'CALLS ONLY' : 'PUTS ONLY'),
    });

  } catch(e) {
    console.error('[GEXR] Error:', e.message);
    res.json({ status: 'error', reason: e.message });
  }
});

// GEXR status check
app.get('/webhook/gexr', function(req, res) {
  res.json({
    direction:   global.gexrDirection || 'unknown',
    level:       global.gexrLevel     || null,
    ticker:      global.gexrTicker    || 'SPY',
    updatedAt:   global.gexrUpdatedAt || null,
    callPut:     global.gexrDirection === 'above' ? 'CALLS ONLY' :
                 global.gexrDirection === 'below' ? 'PUTS ONLY'  : 'UNKNOWN',
  });
});

app.post('/webhook/close', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderExecutor) return res.json({ status: 'orderExecutor not loaded' });

    var { account, symbol, qty } = req.body;
    if (!account) account = 'SIM3142118M';
    var result = await orderExecutor.closePosition(account, symbol, qty || 1);
    res.json({ status: 'OK', result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /bias -- current dynamic bias
app.get('/bias', function(req, res) {
  if (!dynamicBias) return res.json({ status: 'not loaded' });
  res.json({ status: 'OK', bias: dynamicBias.getBias() });
});

// GET /loss-limit/status -- check if loss limit is triggered
app.get('/loss-limit/status', function(req, res) {
  if (!dailyLossLimit) return res.json({ status: 'not loaded' });
  res.json({
    live: { blocked: dailyLossLimit.isBlocked('11975462') },
    sim:  { blocked: dailyLossLimit.isBlocked('SIM3142118M') },
  });
});

// POST /loss-limit/override -- emergency override
app.post('/loss-limit/override', function(req, res) {
  var secret = req.headers['x-stratum-secret'];
  if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!dailyLossLimit) return res.json({ status: 'not loaded' });
  dailyLossLimit.override(req.body.account || '11975462');
  res.json({ status: 'OK', message: 'Loss limit override applied' });
});

// -- SIM MODE ENDPOINTS
app.post('/sim/enable', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (simMode) {
      var result = await simMode.enableSim();
      if (stratumAgent) stratumAgent.setManualBias('MIXED');
      res.json({ status: 'OK', message: 'SIM mode enabled -- trading on ' + simMode.SIM_ACCOUNT, result });
    } else {
      res.json({ status: 'simMode not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/sim/disable', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (simMode) {
      var result = await simMode.disableSim();
      res.json({ status: 'OK', message: 'SIM mode disabled -- back to live account', result });
    } else {
      res.json({ status: 'simMode not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/sim/status', async function(req, res) {
  try {
    if (simMode) {
      var card = await simMode.buildSimStatus();
      res.json({ status: 'OK', card });
    } else {
      res.json({ status: 'simMode not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- CATALYST SCANNER (upgrades/downgrades like primo's Stratalyst)
var catalystScanner = null;
try { catalystScanner = require('./catalystScanner'); console.log('[CATALYST] Loaded OK'); } catch(e) { console.log('[CATALYST] Skipped:', e.message); }

app.get('/api/catalysts', async function(req, res) {
  if (!catalystScanner) return res.json({ status: 'not loaded' });
  try {
    var data = await catalystScanner.scanCatalysts();
    res.json({ status: 'OK', data: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- EARNINGS CALENDAR -------------------------------------------
app.get('/api/earnings', async function(req, res) {
  if (!econCalendar || !econCalendar.getEarningsCalendar) return res.json({ status: 'not loaded' });
  try {
    var from = req.query.from || null;
    var to = req.query.to || null;
    var earnings = await econCalendar.getEarningsCalendar(from, to);
    res.json({ status: 'OK', count: earnings.length, earnings: earnings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- EARNINGS CHECK FOR SPECIFIC TICKER ---------------------------
app.get('/api/earnings/check/:ticker', async function(req, res) {
  var ticker = (req.params.ticker || '').toUpperCase();
  // Use brain's earnings cache if available
  var brain2 = null;
  try { brain2 = require('./brainEngine'); } catch(e) {}
  if (brain2 && brain2.tickerHasEarningsWithin3Days) {
    await brain2.refreshEarningsCache();
    var hasEarnings = brain2.tickerHasEarningsWithin3Days(ticker);
    var nextER = brain2.getNextEarningsDate(ticker);
    return res.json({
      ticker: ticker,
      earningsWithin3Days: hasEarnings,
      nextEarnings: nextER,
      warning: hasEarnings ? 'DO NOT SWING -- earnings within 3 days' : null,
    });
  }
  // Fallback to raw earnings calendar
  if (!econCalendar || !econCalendar.getEarningsCalendar) return res.json({ status: 'not loaded' });
  try {
    var d = new Date();
    var from = d.toISOString().slice(0, 10);
    d.setDate(d.getDate() + 5);
    var to = d.toISOString().slice(0, 10);
    var all = await econCalendar.getEarningsCalendar(from, to);
    var match = all.filter(function(e) { return e.symbol === ticker; });
    res.json({
      ticker: ticker,
      earningsWithin3Days: match.length > 0,
      nextEarnings: match.length > 0 ? match[0] : null,
      warning: match.length > 0 ? 'DO NOT SWING -- earnings within 3 days' : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- BOTTOM TICK SCANNER (@TheStrat method) ----------------------
var bottomTick = null;
try { bottomTick = require('./bottomTick'); console.log('[BOTTOM-TICK] Loaded OK'); } catch(e) { console.log('[BOTTOM-TICK] Skipped:', e.message); }

app.get('/api/scan', async function(req, res) {
  if (!bottomTick) return res.json({ status: 'not loaded' });
  try {
    var results = await bottomTick.scanAll();
    res.json({ status: 'OK', data: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/scan/:symbol', async function(req, res) {
  if (!bottomTick) return res.json({ status: 'not loaded' });
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.json({ status: 'no token' });
    var result = await bottomTick.scanTicker(req.params.symbol.toUpperCase(), token);
    res.json({ status: 'OK', data: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- LIVE POSITIONS FROM TRADESTATION ----------------------------
app.get('/api/positions/live', async function(req, res) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.json({ error: 'No TS token' });
    var account = '11975462';
    var r = await require('node-fetch')('https://api.tradestation.com/v3/brokerage/accounts/' + account + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await r.json();
    res.json({ status: 'OK', positions: data.Positions || data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/live', async function(req, res) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.json({ error: 'No TS token' });
    var account = '11975462';
    var r = await require('node-fetch')('https://api.tradestation.com/v3/brokerage/accounts/' + account + '/orders', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await r.json();
    res.json({ status: 'OK', orders: data.Orders || data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/balances', async function(req, res) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.json({ error: 'No TS token' });
    var account = '11975462';
    var r = await require('node-fetch')('https://api.tradestation.com/v3/brokerage/accounts/' + account + '/balances', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await r.json();
    res.json({ status: 'OK', balances: data.Balances || data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- RAW RECENT FLOW ENDPOINT ------------------------------------
// GET /api/flow/recent?symbol=NVDA&type=sweep&direction=call&minPremium=100000
app.get('/api/flow/recent', function(req, res) {
  var filters = {};
  if (req.query.symbol)     filters.symbol     = req.query.symbol;
  if (req.query.type)       filters.alertType   = req.query.type;
  if (req.query.direction)  filters.callPut     = req.query.direction;
  if (req.query.minPremium) filters.minPremium  = req.query.minPremium;
  var alerts = bullflow.getRecentFlow(filters);
  res.json({ status: 'OK', count: alerts.length, alerts: alerts });
});

// -- RECENT FLOW SUMMARY -----------------------------------------
// Returns: total alerts in last 30 min, top 5 tickers by premium,
//          call vs put ratio, top sweeps
app.get('/api/flow/recent/summary', function(req, res) {
  var allAlerts = bullflow.getRecentFlow();
  var now = Date.now();
  var thirtyMinAgo = now - (30 * 60 * 1000);

  // Alerts in last 30 minutes
  var recent30 = allAlerts.filter(function(a) {
    return new Date(a.timestamp).getTime() >= thirtyMinAgo;
  });

  // Top 5 tickers by total premium
  var tickerPremium = {};
  recent30.forEach(function(a) {
    if (!tickerPremium[a.ticker]) tickerPremium[a.ticker] = 0;
    tickerPremium[a.ticker] += a.premium;
  });
  var topTickers = Object.keys(tickerPremium)
    .map(function(t) { return { ticker: t, totalPremium: tickerPremium[t] }; })
    .sort(function(a, b) { return b.totalPremium - a.totalPremium; })
    .slice(0, 5);

  // Call vs Put ratio
  var calls = recent30.filter(function(a) { return a.callPut === 'CALL'; }).length;
  var puts  = recent30.filter(function(a) { return a.callPut === 'PUT'; }).length;
  var ratio = puts > 0 ? (calls / puts).toFixed(2) : calls > 0 ? 'ALL_CALLS' : 'N/A';

  // Top sweeps by premium
  var topSweeps = recent30
    .filter(function(a) { return a.alertType && a.alertType.includes('sweep'); })
    .sort(function(a, b) { return b.premium - a.premium; })
    .slice(0, 10);

  res.json({
    status: 'OK',
    totalAlertsLast30Min: recent30.length,
    totalAlertsStored: allAlerts.length,
    topTickersByPremium: topTickers,
    callPutRatio: { calls: calls, puts: puts, ratio: ratio },
    topSweeps: topSweeps,
  });
});

// -- BULLFLOW PER-TICKER QUERY -----------------------------------
app.get('/api/flow/:symbol', function(req, res) {
  var sym = req.params.symbol.toUpperCase();
  var summary = bullflow.liveAggregator.getSummary();
  var tickerFlow = summary[sym] || null;
  res.json({ status: 'OK', symbol: sym, flow: tickerFlow });
});

// -- MARKET DEPTH API (Level 2 / Matrix) -------------------------
var marketDepth = null;
try { marketDepth = require('./marketDepth'); console.log('[DEPTH] Loaded OK'); } catch(e) { console.log('[DEPTH] Skipped:', e.message); }

app.get('/api/depth/:symbol', async function(req, res) {
  if (!marketDepth) return res.json({ status: 'not loaded' });
  try {
    var depth = await marketDepth.fetchDepth(req.params.symbol.toUpperCase());
    if (!depth) return res.json({ status: 'no data', symbol: req.params.symbol });
    res.json({ status: 'OK', depth: depth });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- ALERTS API (for Claude Code to read strat alerts) -----------
app.get('/api/alerts', function(req, res) {
  var count = parseInt(req.query.count) || 20;
  var alerts = alerter.getRecentAlerts(count);
  res.json({ status: 'OK', count: alerts.length, alerts: alerts });
});

app.delete('/api/alerts', function(req, res) {
  var secret = req.headers['x-stratum-secret'];
  if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  alerter.clearAlerts();
  res.json({ status: 'OK', message: 'Alerts cleared' });
});

// -- AGENT STATE ENDPOINT
app.get('/agent/state', function(req, res) {
  if (stratumAgent) {
    res.json(stratumAgent.getState());
  } else {
    res.json({ status: 'agent not loaded' });
  }
});

// -- AUTONOMOUS TRIGGERS ----------------------------------------
app.post('/trigger/morning', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (autoMorning) {
      var result = await autoMorning.runAutoMorning();
      res.json({ status: 'OK', result });
    } else {
      res.json({ status: 'autoMorning not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/journal', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (autoJournal) {
      var card = await autoJournal.writeAutoJournal();
      res.json({ status: 'OK', card });
    } else {
      res.json({ status: 'autoJournal not loaded' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- TEST ROUTES ------------------------------------------------
app.get('/test/brief',    async function(req, res) { try { await alerter.sendMorningBrief(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/screener', async function(req, res) { if (!finviz) return res.json({ status: 'not loaded' }); try { await finviz.postScreenerCard(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/scanner',  async function(req, res) { if (!preMarketScanner) return res.json({ status: 'not loaded' }); try { await preMarketScanner.runPreMarketScan(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/322',      async function(req, res) { if (!preMarketScanner) return res.json({ status: 'not loaded' }); try { await preMarketScanner.run322Scan(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/bullflow', function(req, res) { res.json({ status: 'OK', version: '7.2' }); });
app.get('/test/premarketreport', async function(req, res) { if (!preMarketReport) return res.json({ status: 'not loaded' }); try { await preMarketReport.postPreMarketReport(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/calendar', async function(req, res) { if (!econCalendar) return res.json({ status: 'not loaded' }); try { await econCalendar.postDailyBrief(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/cal/status', function(req, res) { if (!econCalendar) return res.json({ status: 'not loaded' }); res.json(econCalendar.getState()); });

// -- CRONS ------------------------------------------------------
// Cancel manager -- every 5 min during RTH
cron.schedule('*/5 9-16 * * 1-5', async function() {
  try {
    if (cancelManager) await cancelManager.checkPendingOrders();
  } catch(e) { console.error('[CANCEL-MGR] Cron error:', e.message); }
}, { timezone: 'America/New_York' });

// TS TOKEN HEALTH CHECK -- every 30 min 24/7
// Proactively tests token before market opens
// If token fails = Discord alert fires immediately
cron.schedule('*/30 * * * *', async function() {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) {
      console.error('[TS-HEALTH] Token check FAILED -- no token available');
      // Alert already sent by tradestation.js
    } else {
      console.log('[TS-HEALTH] Token check OK');
    }
  } catch(e) { console.error('[TS-HEALTH] Health check error:', e.message); }
}, { timezone: 'America/New_York' });

// MORNING BIAS RESET -- 9:30AM ET every trading day
// Pulls fresh SPY bar and resets bias before first trade fires
cron.schedule('30 9 * * 1-5', async function() {
  try {
    if (!dynamicBias) return;
    console.log('[DYNAMIC-BIAS] 9:30AM reset -- pulling fresh SPY bias');
    await dynamicBias.updateBias();
    var state = dynamicBias.getBias();
    console.log('[DYNAMIC-BIAS] Morning bias set:', state.bias, state.strength, 'SPY $' + state.spyPrice);
    // Post morning bias to Discord
    var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
      'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
    var fetch = require('node-fetch');
    var msg = [
      'MORNING BIAS RESET -- 9:30AM',
      '==============================',
      'Bias:    ' + (state.bias || 'DETECTING...'),
      'Strength: ' + (state.strength || 'WEAK'),
      'SPY:     $' + (state.spyPrice || 'loading...'),
      'VWAP:    $' + (state.spyVwap || 'loading...'),
      'Bar:     ' + (state.barType || 'loading...'),
      state.bias === 'BEARISH' ? 'ACTION:  PUTS ONLY -- calls blocked' : 
      state.bias === 'BULLISH' ? 'ACTION:  CALLS ONLY -- puts blocked' : 
      'ACTION:  NEUTRAL -- watching',
    ].join('\n');
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + msg + '\n```', username: 'Stratum Morning Bias' }),
    });
  } catch(e) { console.error('[DYNAMIC-BIAS] Morning reset error:', e.message); }
}, { timezone: 'America/New_York' });

// MOVE STOPS TO BREAKEVEN -- every 5 min during RTH
cron.schedule('*/5 9-16 * * 1-5', async function() {
  try {
    if (!positionManager) return;
    var etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    var etParts = etNow.split(', ')[1].split(':');
    var etTime = parseInt(etParts[0]) * 60 + parseInt(etParts[1]);
    if (etTime < (9 * 60 + 45) || etTime > (15 * 60 + 30)) return;
    await positionManager.checkAndMoveStops('11975462');
  } catch(e) { console.error('[POS-MGR] Stop monitor error:', e.message); }
}, { timezone: 'America/New_York' });

// SIM PROMOTION CHECK -- every day at 4:30PM ET
cron.schedule('30 16 * * 1-5', async function() {
  try {
    if (!positionManager) return;
    await positionManager.checkSimPromotion();
  } catch(e) { console.error('[POS-MGR] SIM promotion error:', e.message); }
}, { timezone: 'America/New_York' });

// STOP MANAGER -- ratcheting trail step every 5 min during market hours
cron.schedule('*/5 9-15 * * 1-5', async function() {
  try {
    if (!stopManager) return;
    var st = stopManager.getTrailState();
    if (!st || !Object.keys(st).length) return;
    var results = await stopManager.trailAll();
    var changed = Object.keys(results).filter(function(k){ return results[k] && results[k].changed; });
    if (changed.length) console.log('[STOPMGR] Trail ratcheted:', changed.length, 'positions');
  } catch(e) { console.error('[STOPMGR] trail cron error:', e.message); }
}, { timezone: 'America/New_York' });

// WEEKLY TRACKER -- Friday 4:05 PM ET post summary
cron.schedule('5 16 * * 5', async function() {
  try {
    if (!weeklyTracker) return;
    await weeklyTracker.postWeeklySummary();
  } catch(e) { console.error('[WEEKLY] Friday post error:', e.message); }
}, { timezone: 'America/New_York' });

// EOD CLOSE ALL -- 3:45PM ET: try limit orders first
cron.schedule('45 15 * * 1-5', async function() {
  try {
    if (!positionManager) return;
    console.log('[POS-MGR] 3:45PM ET -- EOD limit close attempt');
    await positionManager.eodCloseAll('11975462');
  } catch(e) { console.error('[POS-MGR] EOD cron error:', e.message); }
}, { timezone: 'America/New_York' });

// EOD BACKUP -- 3:55PM ET: market orders for anything not filled
cron.schedule('55 15 * * 1-5', async function() {
  try {
    if (!positionManager) return;
    console.log('[POS-MGR] 3:55PM ET -- EOD market close backup');
    await positionManager.eodCloseAll('11975462');
  } catch(e) { console.error('[POS-MGR] EOD backup cron error:', e.message); }
}, { timezone: 'America/New_York' });

// ORPHAN ORDER SWEEP -- every 30 min during RTH
// Cancels ALL unfilled BUYTOOPEN orders older than 90 min
// Catches orders never tracked by cancelManager
cron.schedule('*/30 9-16 * * 1-5', async function() {
  try {
    if (!cancelManager || !cancelManager.sweepOrphanOrders) return;
    var etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    var etParts = etNow.split(', ')[1].split(':');
    var etTime = parseInt(etParts[0]) * 60 + parseInt(etParts[1]);
    if (etTime < (9 * 60 + 30) || etTime > (16 * 60)) return;
    await cancelManager.sweepOrphanOrders('SIM3142118M');
    await cancelManager.sweepOrphanOrders('11975462');
  } catch(e) { console.error('[CANCEL-MGR] Orphan sweep cron error:', e.message); }
}, { timezone: 'America/New_York' });

// DYNAMIC BIAS UPDATE -- every 5 min during RTH
cron.schedule('*/5 9-16 * * 1-5', async function() {
  try {
    if (!dynamicBias) return;
    var etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    var etParts = etNow.split(', ')[1].split(':');
    var etTime = parseInt(etParts[0]) * 60 + parseInt(etParts[1]);
    if (etTime < (9 * 60 + 30) || etTime > (16 * 60)) return;
    await dynamicBias.updateBias();
  } catch(e) { console.error('[DYNAMIC-BIAS] Cron error:', e.message); }
}, { timezone: 'America/New_York' });

// DAILY LOSS LIMIT CHECK -- every 5 min during RTH
cron.schedule('*/5 9-16 * * 1-5', async function() {
  try {
    if (!dailyLossLimit) return;
    var etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    var etParts = etNow.split(', ')[1].split(':');
    var etTime = parseInt(etParts[0]) * 60 + parseInt(etParts[1]);
    if (etTime < (9 * 60 + 30) || etTime > (16 * 60)) return;
    // Check both accounts
    await dailyLossLimit.checkDailyLoss('11975462');
    await dailyLossLimit.checkDailyLoss('SIM3142118M');
  } catch(e) { console.error('[LOSS-LIMIT] Cron error:', e.message); }
}, { timezone: 'America/New_York' });

// IDEA WATCHLIST CHECK -- every 5 min during RTH (9:00AM - 5PM ET)
// THIS IS THE CRITICAL CRON -- checks if John's ideas have triggered
cron.schedule('*/5 9-17 * * 1-5', async function() {
  try {
    if (!ideaIngestor) return;
    console.log('[IDEA] Checking watchlist -- ' + Object.keys(ideaIngestor.getWatchlist()).length + ' ideas');
    await ideaIngestor.checkWatchlist();
  } catch(e) { console.error('[IDEA] Watchlist cron error:', e.message); }
}, { timezone: 'America/New_York' });

// 12:00AM ET -- reset daily execute-now counter
cron.schedule('0 0 * * 1-5', function() {
  if (executeNow) executeNow.resetDailySetups();
  console.log('[EXECUTE-NOW] Daily reset at midnight');
}, { timezone: 'America/New_York' });

// Every 10 min -- cancel stale unfilled orders older than 30 min
cron.schedule('*/10 9-16 * * 1-5', function() {
  if (executeNow && executeNow.cancelStaleOrders) {
    executeNow.cancelStaleOrders().catch(function(e) { console.error('[CANCEL-STALE]', e.message); });
  }
}, { timezone: 'America/New_York' });

// ============================================================================
// MULTI-TF SCANNER HISTORY SNAPSHOTS — Apr 24 2026 v1.5
// Drive every timeframe's history accumulation via scheduled scans so we can
// measure win-rate per TF without relying on AB hitting the UI all day.
// ============================================================================

// 30m snapshot — 10:15 AM ET (first 30m bar closed), 12:15 PM (noon chop marker), 2:45 PM (PM session)
cron.schedule('15 10,12 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.scan) return;
  console.log('[HIST-CRON] 30m scan triggering history snapshot');
  stratumScanner.scan({ tf: '30m', force: true }).catch(function(e) { console.error('[HIST-CRON 30m]', e.message); });
}, { timezone: 'America/New_York' });
cron.schedule('45 14 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.scan) return;
  console.log('[HIST-CRON] 30m PM scan triggering history snapshot');
  stratumScanner.scan({ tf: '30m', force: true }).catch(function(e) { console.error('[HIST-CRON 30m PM]', e.message); });
}, { timezone: 'America/New_York' });

// 60m snapshot — 11:00 AM (first 60m bar closed), 3:00 PM (PM 60m)
cron.schedule('0 11,15 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.scan) return;
  console.log('[HIST-CRON] 60m scan triggering history snapshot');
  stratumScanner.scan({ tf: '60m', force: true }).catch(function(e) { console.error('[HIST-CRON 60m]', e.message); });
}, { timezone: 'America/New_York' });

// 4HR snapshot — 1:30 PM (first 4HR bar closed for US session)
cron.schedule('30 13 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.scan) return;
  console.log('[HIST-CRON] 4HR scan triggering history snapshot');
  stratumScanner.scan({ tf: '4HR', force: true }).catch(function(e) { console.error('[HIST-CRON 4HR]', e.message); });
}, { timezone: 'America/New_York' });

// Daily snapshot — 4:15 PM ET (after close; 4:00 bar finalized)
cron.schedule('15 16 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.scan) return;
  console.log('[HIST-CRON] Daily EOD scan triggering history snapshot');
  stratumScanner.scan({ tf: 'Daily', force: true }).catch(function(e) { console.error('[HIST-CRON Daily]', e.message); });
}, { timezone: 'America/New_York' });

// TIER 4 — live in-flight scoring every 15 min during market hours.
// Updates today's rows with liveMovePct/liveAdvPct/liveStatus so History tab
// shows partial progress before tomorrow's final eval.
cron.schedule('*/15 9-16 * * 1-5', function() {
  if (!stratumScanner || !stratumScanner.updateLiveScores) return;
  stratumScanner.updateLiveScores().catch(function(e) { console.error('[HIST-LIVE]', e.message); });
}, { timezone: 'America/New_York' });

// 3:30 PM ET (19:30 UTC) -- hard close all day trade positions
cron.schedule('30 15 * * 1-5', function() {
  if (executeNow && executeNow.hardCloseAllPositions) {
    console.log('[CRON] 3:30 PM -- hard close triggered');
    executeNow.hardCloseAllPositions().catch(function(e) { console.error('[HARD-CLOSE]', e.message); });
  }
}, { timezone: 'America/New_York' });

// SUNDAY 6:00PM ET -- Futures open, check /ES /NQ /CL for overnight gap bias
// Sets Monday morning direction before brain wakes up
cron.schedule('0 18 * * 0', async function() {
  console.log('[CRON] Sunday 6:00PM ET -- Futures open, checking overnight bias...');
  if (brainEngine && brainEngine.checkSundayFutures) {
    try { await brainEngine.checkSundayFutures(); } catch(e) { console.error('[FUTURES]', e.message); }
  }
}, { timezone: 'America/New_York' });

// SUNDAY 8:00PM ET -- Re-check futures after 2 hours of trading
cron.schedule('0 20 * * 0', async function() {
  console.log('[CRON] Sunday 8:00PM ET -- Futures re-check...');
  if (brainEngine && brainEngine.checkSundayFutures) {
    try { await brainEngine.checkSundayFutures(); } catch(e) { console.error('[FUTURES]', e.message); }
  }
}, { timezone: 'America/New_York' });

// MONDAY 4:00AM ET -- Pre-market futures check (gap confirmation)
cron.schedule('0 4 * * 1', async function() {
  console.log('[CRON] Monday 4:00AM ET -- Pre-market futures check...');
  if (brainEngine && brainEngine.checkSundayFutures) {
    try { await brainEngine.checkSundayFutures(); } catch(e) { console.error('[FUTURES]', e.message); }
  }
}, { timezone: 'America/New_York' });

// 4:00AM ET -- AYCE pre-market scan (catches overnight 12HR Miyagi setups)
cron.schedule('0 4 * * 1-5', async function() {
  console.log('[CRON] 4:00AM -- AYCE pre-market scan...');
  if (preMarketScanner) {
    try { await preMarketScanner.runPreMarketScan(); } catch(e) { console.error('[SCANNER]', e.message); }
  }
}, { timezone: 'America/New_York' });

// 7:30AM ET -- AUTONOMOUS MORNING ROUTINE
// Pulls live positions, sets 6HR bias, resets goal, posts brief
// Zero manual steps needed
cron.schedule('30 7 * * 1-5', async function() {
  console.log('[CRON] 7:30AM -- Auto morning routine...');
  if (autoMorning) {
    try { await autoMorning.runAutoMorning(); } catch(e) { console.error('[AUTO-MORNING]', e.message); }
  }
}, { timezone: 'America/New_York' });

// 8:00AM ET -- pre-market report
cron.schedule('0 8 * * 1-5', async function() {
  console.log('[CRON] 8:00AM -- pre-market report...');
  if (preMarketReport) { try { await preMarketReport.postPreMarketReport(); } catch(e) { console.error('[PMR]', e.message); } }
  if (econCalendar)    { try { await econCalendar.postDailyBrief();         } catch(e) { console.error('[CAL]', e.message); } }
}, { timezone: 'America/New_York' });

// 8:30AM ET -- CATALYST SCANNER (upgrades/downgrades/news before market open)
cron.schedule('30 8 * * 1-5', async function() {
  console.log('[CRON] 8:30AM -- catalyst scanner...');
  if (catalystScanner) { try { await catalystScanner.postCatalystBrief(); } catch(e) { console.error('[CATALYST]', e.message); } }
}, { timezone: 'America/New_York' });

// 9:15AM ET -- morning brief + screener + goal + capitol + AYCE scan + OFFSET ANALYZER
cron.schedule('15 9 * * 1-5', async function() {
  console.log('[CRON] 9:15AM -- morning brief + pre-market scan + offset analysis...');
  try { await alerter.sendMorningBrief(); } catch(e) { console.error('[BRIEF]', e.message); }
  if (positionOffset)   { try { await positionOffset.runOffsetAnalysis();      } catch(e) { console.error('[OFFSET]', e.message); } }
  if (finviz)           { try { await finviz.postScreenerCard();                } catch(e) { console.error('[FINVIZ]', e.message); } }
  if (goalTracker)      { try { await goalTracker.postGoalUpdate();             } catch(e) { console.error('[GOAL]', e.message); } }
  if (capitol)          { try { await capitol.fetchCongressTrades();            } catch(e) { console.error('[CAPITOL]', e.message); } }
  if (preMarketScanner) { try { await preMarketScanner.runPreMarketScan();      } catch(e) { console.error('[SCANNER]', e.message); } }
  if (econCalendar)     { try { await econCalendar.postDailyBrief();            } catch(e) { console.error('[CAL]', e.message); } }
}, { timezone: 'America/New_York' });

// 9:30AM ET -- market open goal post
cron.schedule('30 9 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
}, { timezone: 'America/New_York' });

// Every 30 min during market hours -- check for breaking geopolitical news
cron.schedule('*/30 9-16 * * 1-5', async function() {
  if (econCalendar) { try { await econCalendar.checkBreakingNews(); } catch(e) { console.error('[CAL]', e.message); } }
}, { timezone: 'America/New_York' });

// Every 30 min during market hours -- BOTTOM TICK SCANNER
// Scans 30min/2HR bars for Failed 2U/2D, 3-1, 2-1-2 setups
// Posts setups to Discord and stores for API access
cron.schedule('*/30 9-16 * * 1-5', async function() {
  if (!bottomTick) return;
  try {
    console.log('[CRON] Running bottom tick scanner...');
    var results = await bottomTick.scanAll();
    var withSetups = results.results || [];
    if (withSetups.length > 0) {
      // Post top setups to Discord
      var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
      if (webhook) {
        var lines = ['🔍 BOTTOM TICK SCAN -- ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET'];
        for (var i = 0; i < Math.min(withSetups.length, 5); i++) {
          var r = withSetups[i];
          for (var j = 0; j < r.setups.length; j++) {
            var s = r.setups[j];
            lines.push(r.symbol + ' | ' + s.timeframe + ' | ' + s.type + ' | ' + s.action + ' | Trigger $' + (s.trigger ? s.trigger.toFixed(2) : '?'));
          }
        }
        if (r && r.levels) {
          lines.push('---');
          lines.push('Levels: PDH $' + (r.levels.PDH || '?') + ' | PDL $' + (r.levels.PDL || '?') + ' | PWH $' + (r.levels.PWH || '?'));
        }
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '```\n' + lines.join('\n') + '\n```', username: 'Stratum Scanner' })
        }).catch(function(e) { console.error('[SCANNER-CRON] Discord error:', e.message); });
      }
      console.log('[CRON] Scanner found', withSetups.length, 'tickers with setups');
    }
  } catch(e) { console.error('[CRON] Scanner error:', e.message); }
}, { timezone: 'America/New_York' });

// 10:00AM ET -- 3-2-2 First Live scan
cron.schedule('0 10 * * 1-5', async function() {
  console.log('[CRON] 10:00AM -- 3-2-2 scan...');
  if (preMarketScanner) { try { await preMarketScanner.run322Scan(); } catch(e) { console.error('[322]', e.message); } }
}, { timezone: 'America/New_York' });

// 4:00PM ET -- AUTONOMOUS EOD JOURNAL
// Pulls live P&L, positions, orders from TradeStation
// Posts full journal to Discord -- zero manual steps
cron.schedule('0 16 * * 1-5', async function() {
  console.log('[CRON] 4:00PM -- Auto EOD journal...');
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
  if (autoJournal) {
    try { await autoJournal.writeAutoJournal(); } catch(e) { console.error('[AUTO-JOURNAL]', e.message); }
  } else if (tradingJournal) {
    try { await tradingJournal.writeJournal({}); } catch(e) { console.error('[JOURNAL]', e.message); }
  }
  // Auto-reconcile signal tracker — match closed TS positions to signals
  if (signalTracker) {
    try {
      var reconciled = await signalTracker.autoReconcile();
      console.log('[SIGNAL-TRACKER] 4PM reconcile:', JSON.stringify(reconciled));
    } catch(e) { console.error('[SIGNAL-TRACKER]', e.message); }
  }
}, { timezone: 'America/New_York' });

// -- SCALP MODE ENDPOINTS ----------------------------------------
app.get('/api/scalp/status', function(req, res) {
  if (!executeNow || !executeNow.getScalpMode) {
    return res.json({ status: 'executeNow not loaded or no scalp support' });
  }
  res.json({ status: 'OK', scalp: executeNow.getScalpMode() });
});

app.post('/api/scalp/toggle', function(req, res) {
  try {
    if (!executeNow || !executeNow.toggleScalpMode) {
      return res.json({ status: 'executeNow not loaded or no scalp support' });
    }
    var result = executeNow.toggleScalpMode();
    console.log('[SCALP] Toggled via API -- now:', result.enabled ? 'ON' : 'OFF');
    res.json({ status: 'OK', scalp: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- BRAIN ENGINE -----------------------------------------------
var brainEngine = null;
try { brainEngine = require('./brainEngine'); console.log('[BRAIN] Loaded OK'); } catch(e) { console.log('[BRAIN] Skipped:', e.message); }
var backtester = null;
try { backtester = require('./backtester'); console.log('[BACKTEST] Loaded OK'); } catch(e) { console.log('[BACKTEST] Skipped:', e.message); }
var flowConc = null;
try { flowConc = require('./flowConcentration'); console.log('[FLOW-CONC] Loaded OK'); } catch(e) { console.log('[FLOW-CONC] Skipped:', e.message); }

// GET /api/brain/flow-concentration?date=YYYY-MM-DD&queue=true&limit=5
// Pulls the day's Bullflow concentration, scores tickers, optionally
// auto-queues the top N into tomorrow's brain queue. Survives Railway
// redeploys via the existing /tmp/queued_trades.json persistence.
app.get('/api/brain/flow-concentration', async function(req, res) {
  try {
    if (!flowConc) return res.status(503).json({ error: 'flowConcentration not loaded' });
    var date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    var autoQueue = String(req.query.queue || '').toLowerCase() === 'true';
    var limit = parseInt(req.query.limit || '5', 10);
    var result = await flowConc.runConcentration({ date: date, autoQueue: autoQueue, limit: limit });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =================================================================
// NEXT-DAY WATCHLIST CRON (Apr 26 2026 PM build) — replaces auto-queue
// Daily 4:30 PM ET weekdays:
//  1. Run flowConcentration on today's tape
//  2. Filter out blacklisted tickers (orderExecutor blacklist)
//  3. Save top 15 to /data/next-day-watchlist.json (read by scanner UI tomorrow)
//  4. Post a formatted Discord card to flow webhook for night-time review
// AUTO-QUEUE IS OFF per Apr 21 operating model — display only, AB decides.
// =================================================================
var WATCHLIST_BLACKLIST = new Set([
  'TSLA','MSTR','COIN','MARA','RIOT','WULF','BMNR','CLSK','HUT','BITF','IREN','CIFR','HIVE','SOFI',
  'UPST','RKLB','LUNR','HOOD','AFRM','HIMS','APP','SNAP','RDDT','MRVL'
]);

async function _runNextDayWatchlist(opts) {
  var dateOverride = opts && opts.date;
  var postWebhook  = !(opts && opts.skipWebhook);
  if (!flowConc) return { error: 'flowConcentration not loaded' };
  var today = dateOverride || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log('[WATCHLIST-CRON] Running concentration for ' + today);

  // Pull top 30 unfiltered (we'll filter after — limit larger so blacklist doesn't starve it)
  var result = await flowConc.runConcentration({ date: today, autoQueue: false, limit: 30 });
  if (!result || !result.ranked) {
    console.log('[WATCHLIST-CRON] No ranked output:', result && result.error);
    return { error: result && result.error || 'no ranked output' };
  }

  // Filter blacklist + cap to top 15 visible
  var ranked = result.ranked.filter(function(r) { return !WATCHLIST_BLACKLIST.has(r.ticker); }).slice(0, 15);

  // Persist to /data so the scanner UI can read it tomorrow morning
  var watchlistFile = (process.env.STATE_DIR || '/data') + '/next-day-watchlist.json';
  var payload = {
    sourceDate:    today,
    forTradingDate: null,  // populated by tomorrow's open
    generatedAt:   new Date().toISOString(),
    eventsDrained: result.eventsDrained,
    alertsCounted: (result.customAlertsCounted || 0) + (result.algoAlertsCounted || 0),
    blacklisted:   result.ranked.length - ranked.length,
    ranked:        ranked,
  };
  try { require('fs').writeFileSync(watchlistFile, JSON.stringify(payload, null, 2)); }
  catch(e) { console.error('[WATCHLIST-CRON] write error:', e.message); }

  // Discord post — formatted as a readable night-time card
  if (postWebhook && process.env.DISCORD_FLOW_WEBHOOK_URL && ranked.length > 0) {
    var lines = [
      '📊 **NEXT-DAY WATCHLIST — built from ' + today + ' tape**',
      '_' + payload.alertsCounted + ' alerts ingested · top ' + ranked.length + ' (blacklist filtered ' + payload.blacklisted + ' names)_',
      '```',
      'TICKER   DIR   ALERTS  LEAN     PREMIUM      SCORE',
    ];
    ranked.forEach(function(r) {
      var t = (r.ticker + '       ').slice(0, 8);
      var d = (r.direction + '     ').slice(0, 6);
      var a = ('     ' + r.total).slice(-5);
      var lp = (r.leanPct.toFixed(1) + '%        ').slice(0, 7);
      var p = ('$' + (r.totalPremium/1e6).toFixed(1) + 'M           ').slice(0, 11);
      lines.push(t + d + a + '  ' + lp + p + r.score);
    });
    lines.push('```');
    lines.push('Open scanner & cross-reference against Daily Strat patterns tomorrow morning.');
    try {
      await fetch(process.env.DISCORD_FLOW_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: lines.join('\n'), username: 'Next-Day Watchlist' }),
      });
      console.log('[WATCHLIST-CRON] Discord post sent OK');
    } catch(e) { console.error('[WATCHLIST-CRON] Discord error:', e.message); }
  }

  console.log('[WATCHLIST-CRON] Done. Top 5: ' + ranked.slice(0,5).map(function(r){ return r.ticker + ' ' + r.direction; }).join(', '));
  return payload;
}

try {
  var cron = require('node-cron');
  // 4:30 PM ET weekdays — 25 min after close, gives Bullflow archive time to settle
  cron.schedule('30 16 * * 1-5', function() {
    _runNextDayWatchlist({}).catch(function(e){ console.error('[WATCHLIST-CRON] Exception:', e.message); });
  }, { timezone: 'America/New_York' });
  console.log('[WATCHLIST-CRON] Scheduled: 4:30 PM ET weekdays');
} catch(e) { console.log('[WATCHLIST-CRON] node-cron missing — manual trigger only'); }

// GET /api/watchlist/next-day — read the latest saved watchlist (display only)
app.get('/api/watchlist/next-day', function(req, res) {
  try {
    var watchlistFile = (process.env.STATE_DIR || '/data') + '/next-day-watchlist.json';
    var data = require('fs').readFileSync(watchlistFile, 'utf8');
    res.json(JSON.parse(data));
  } catch(e) { res.status(404).json({ error: 'no watchlist saved yet — wait for next 4:30 PM ET cron, or POST /api/watchlist/run' }); }
});

// POST /api/watchlist/run?date=YYYY-MM-DD — manual trigger (for testing or filling gaps)
app.post('/api/watchlist/run', async function(req, res) {
  try {
    var date = (req.body && req.body.date) || (req.query && req.query.date);
    var result = await _runNextDayWatchlist({ date: date, skipWebhook: req.query.silent === '1' });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/brain/backtest { date: "2026-04-11" }
// Replays a historical day from Bullflow /backtesting, runs every algo alert
// through the live executeNow gates, and returns simulated stats. Read-only —
// does not place orders or mutate brain state.
app.post('/api/brain/backtest', async function(req, res) {
  try {
    if (!backtester) return res.status(503).json({ error: 'backtester not loaded' });
    var date = (req.body && req.body.date) || (req.query && req.query.date);
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    var result = await backtester.runBacktest({ date: date });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/brain/peak-return?symbol=O:SPY...&timestamp=2026-04-11T14:30:00Z
app.get('/api/brain/peak-return', async function(req, res) {
  try {
    if (!backtester) return res.status(503).json({ error: 'backtester not loaded' });
    var result = await backtester.getPeakReturn({
      symbol: req.query.symbol,
      timestamp: req.query.timestamp,
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brain/status', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    res.json({ status: 'OK', brain: brainEngine.getBrainStatus(), brief: brainEngine.getDailyBrief() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/start', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var result = brainEngine.setBrainActive(true);
    res.json({ status: 'OK', active: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- CREDIT SPREAD ENGINE API ------------------------------------
app.get('/api/spreads/status', function(req, res) {
  if (!creditSpreadEngine) return res.json({ error: 'Spread engine not loaded' });
  res.json({ status: 'OK', spreads: creditSpreadEngine.getSpreadStatus() });
});

app.post('/api/spreads/evaluate', async function(req, res) {
  if (!creditSpreadEngine) return res.json({ error: 'Spread engine not loaded' });
  try {
    var result = await creditSpreadEngine.evaluateSpreadOpportunity();
    res.json({ status: 'OK', evaluation: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spreads/close-legacy', async function(req, res) {
  if (!creditSpreadEngine) return res.json({ error: 'Spread engine not loaded' });
  try {
    var shortSym = req.body.shortSymbol || 'SPX 260417P6700';
    var longSym = req.body.longSymbol || 'SPX 260417P6695';
    var qty = req.body.qty || 1;
    var result = await creditSpreadEngine.closeLegacySpread(shortSym, longSym, qty);
    res.json({ status: 'OK', result: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spreads/execute', async function(req, res) {
  if (!creditSpreadEngine) return res.json({ error: 'Spread engine not loaded' });
  try {
    var result = await creditSpreadEngine.executeFullFlow();
    res.json({ status: 'OK', result: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/stop', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var result = brainEngine.setBrainActive(false);
    res.json({ status: 'OK', active: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/reset', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    brainEngine.resetDaily();
    res.json({ status: 'OK', message: 'Daily state reset' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Refresh dynamic bias from live SPY data
app.post('/api/bias/refresh', async function(req, res) {
  try {
    if (!dynamicBias) return res.json({ error: 'Dynamic bias not loaded' });
    await dynamicBias.updateBias();
    var bias = dynamicBias.getBias();
    res.json({ status: 'OK', bias: bias });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Override bias manually (for when SPY bias conflicts with ticker direction)
app.post('/api/bias/override', function(req, res) {
  try {
    if (!dynamicBias) return res.json({ error: 'Dynamic bias not loaded' });
    var direction = req.body.bias || 'NEUTRAL';
    var strength = req.body.strength || 'WEAK';
    // Direct state override
    var state = dynamicBias.getBias();
    state.bias = direction.toUpperCase();
    state.strength = strength.toUpperCase();
    state.updatedAt = new Date().toISOString();
    res.json({ status: 'OK', bias: state, message: 'Bias overridden to ' + state.bias + ' (' + state.strength + ')' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update weekly pace tracker -- feed in daily P&L after redeploys wipe memory
app.post('/api/brain/pace', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var date = req.body.date; // 'YYYY-MM-DD'
    var pnl = parseFloat(req.body.pnl || 0);
    if (!date || isNaN(pnl)) return res.status(400).json({ error: 'Need date (YYYY-MM-DD) and pnl (number)' });
    brainEngine.recordDailyResult(date, pnl);
    var pace = brainEngine.getWeeklyPace();
    res.json({ status: 'OK', recorded: { date: date, pnl: pnl }, weeklyPace: pace });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set ticker cooldown manually -- prevents brain from re-entering after we override
app.post('/api/brain/cooldown', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var ticker = (req.body.ticker || '').toUpperCase();
    if (!ticker) return res.status(400).json({ error: 'Need ticker' });
    brainEngine.setCooldown(ticker);
    res.json({ status: 'OK', ticker: ticker, cooldownMinutes: 30 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// QUEUED TRADES — Pre-load JohnJSmith / Discord picks for auto-execution
app.post('/api/brain/queue', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var trade = req.body;
    if (!trade.ticker || !trade.triggerPrice || !trade.contractSymbol) {
      return res.status(400).json({ error: 'Need ticker, triggerPrice, and contractSymbol' });
    }
    var qt = brainEngine.addQueuedTrade(trade);
    res.json({ status: 'OK', queued: qt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brain/queue', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    res.json({ status: 'OK', queuedTrades: brainEngine.getQueuedTrades() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Review-only view of auto-queued Stratum pre-market picks. Use at 8:30 AM
// to kill anything you don't want before the 9:30 bell.
app.get('/api/brain/auto-queue', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var all = brainEngine.getQueuedTrades() || [];
    var auto = all.filter(function(q) {
      return q.source && String(q.source).indexOf('STRATUM_AUTO') === 0;
    });
    res.json({ status: 'OK', count: auto.length, autoQueued: auto });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/brain/queue/:id', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var cancelled = brainEngine.cancelQueuedTrade(req.params.id);
    res.json({ status: cancelled ? 'OK' : 'NOT_FOUND', id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually clear a phantom/stuck active position from brain state (e.g. HCA today).
// Does NOT close at broker -- only removes from tracking.
app.delete('/api/brain/position/:ticker', function(req, res) {
  try {
    if (!brainEngine || !brainEngine.removePosition) {
      return res.json({ error: 'Brain engine not loaded' });
    }
    var removed = brainEngine.removePosition(req.params.ticker);
    res.json({ status: removed > 0 ? 'OK' : 'NOT_FOUND', ticker: req.params.ticker, removed: removed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brain/positions', function(req, res) {
  try {
    if (!brainEngine || !brainEngine.getActivePositions) {
      return res.json({ error: 'Brain engine not loaded' });
    }
    res.json({ status: 'OK', positions: brainEngine.getActivePositions() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brain/watchlist', function(req, res) {
  try {
    if (!brainEngine || !brainEngine.getFullWatchlist) return res.json({ error: 'Brain engine not loaded' });
    res.json({
      status: 'OK',
      full: brainEngine.getFullWatchlist(),
      dynamic: brainEngine.getDynamicWatchlist ? brainEngine.getDynamicWatchlist() : [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/watchlist/add', function(req, res) {
  try {
    if (!brainEngine || !brainEngine.addDynamicTicker) return res.json({ error: 'Brain engine not loaded' });
    var ticker = (req.body.ticker || '').toUpperCase();
    var source = req.body.source || 'manual';
    if (!ticker) return res.status(400).json({ error: 'Need ticker' });
    var added = brainEngine.addDynamicTicker(ticker, source);
    res.json({ status: 'OK', added: added, ticker: ticker });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/grade', function(req, res) {
  try {
    if (!brainEngine || !brainEngine.gradeSetup) return res.json({ error: 'Brain engine not loaded' });
    var grade = brainEngine.gradeSetup(req.body || {});
    res.json({ status: 'OK', grade: grade });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/bypass', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var enabled = req.body.enabled !== undefined ? req.body.enabled : true;
    var result = brainEngine.setBypassMode(enabled);
    res.json({ status: 'OK', bypassMode: result, message: result ? 'LIVE AUTONOMOUS EXECUTION ENABLED' : 'Bypass mode disabled' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brain/bypass', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    res.json({ status: 'OK', bypassMode: brainEngine.getBypassMode() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// APPROVE TRADE -- tap the link from #go-mode to execute
app.get('/api/brain/approve/:id', async function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var result = await brainEngine.executeApproval(req.params.id);
    if (result.executed) {
      res.json({ status: 'EXECUTED', orderId: result.orderId, qty: result.qty, limit: result.limit });
    } else {
      res.json({ status: 'NOT EXECUTED', reason: result.reason });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// LIST PENDING APPROVALS
app.get('/api/brain/pending', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    res.json({ status: 'OK', pending: brainEngine.getPendingApprovals(), mode: brainEngine.getExecutionMode() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FUTURES CHECK -- trigger manually or check Sunday bias
app.get('/api/brain/futures', async function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var bias = brainEngine.getSundayBias();
    res.json({ status: 'OK', bias: bias });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain/futures', async function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var result = await brainEngine.checkSundayFutures();
    res.json({ status: 'OK', bias: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CONFLUENCE SCORING -- Claude sends TradingView data, gets scored
app.post('/api/brain/confluence', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var tvData = req.body;
    var result = brainEngine.scoreSetup(tvData);
    res.json({ status: 'OK', confluence: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POSITION HEALTH -- Claude sends live TV data for open position
app.post('/api/brain/health/:ticker', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var ticker = req.params.ticker.toUpperCase();
    var tvData = req.body;
    var result = brainEngine.checkPositionHealth(ticker, tvData);
    res.json({ status: 'OK', health: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET ENTRY CONTEXTS -- for debugging/monitoring
app.get('/api/brain/contexts', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    res.json({ status: 'OK', contexts: brainEngine.getPositionContexts() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SCANNER ALERT ENDPOINT — scanners call this to send Discord + Mac notification
app.post('/api/alert', async function(req, res) {
  try {
    var alerter = require('./alerter');
    var { title, message, tier } = req.body;
    await alerter.scannerAlert(title || 'Alert', message || '', tier || 'INFO');
    res.json({ status: 'OK', sent: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEBUG: Test contract resolver + raw chain access
app.get('/api/resolve/:ticker/:type', async function(req, res) {
  try {
    var r = require('./contractResolver');
    var ticker = req.params.ticker.toUpperCase();
    var type = req.params.type;

    // Step-by-step debug
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.json({ error: 'No TS token' });

    var fetch = require('node-fetch');
    // Get price
    var priceRes = await fetch('https://api.tradestation.com/v3/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var priceData = await priceRes.json();
    var price = priceData && priceData.Quotes ? parseFloat(priceData.Quotes[0].Last) : null;

    // Get expirations — return RAW response for debugging
    var expUrl = 'https://api.tradestation.com/v3/marketdata/options/expirations/' + ticker;
    var expRes = await fetch(expUrl, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var expStatus = expRes.status;
    var expRaw = await expRes.text();
    var expData = null;
    try { expData = JSON.parse(expRaw); } catch(e) { /* not json */ }
    var expirations = expData && expData.Expirations ? expData.Expirations.slice(0, 5) : [];

    // Try full resolve
    var result = await r.resolveContract(ticker, type, 'DAY', { confluence: 6 });

    res.json({
      status: 'OK',
      price: price,
      expUrl: expUrl,
      expStatus: expStatus,
      expRaw: expRaw ? expRaw.slice(0, 500) : null,
      expirations: expirations,
      contract: result,
      tokenOK: !!token,
    });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Brain Engine cron: every 60 seconds during market hours (weekdays)
cron.schedule('* 9-16 * * 1-5', function() {
  if (brainEngine) {
    brainEngine.runBrainCycle().catch(function(e) {
      console.error('[BRAIN] Cycle error:', e.message);
    });
  }
}, { timezone: 'America/New_York' });

// QUEUE CYCLE cron -- runs queued-trade scan INDEPENDENT of brainActive.
// You can pause the brain and still have night-queued setups fire.
cron.schedule('* 9-16 * * 1-5', function() {
  if (brainEngine && brainEngine.runQueueCycle) {
    brainEngine.runQueueCycle().catch(function(e) { console.error('[QUEUE-CRON]', e.message); });
  }
}, { timezone: 'America/New_York' });

// ================================================================
// QUICK-QUEUE — Lane 1: You find it, system executes it.
// POST /api/quick-queue { ticker, direction, trigger }
// System auto-picks contract, checks 3 gates (regime, IV, price),
// queues as SWING so it fires anytime. 3 taps and done.
// ================================================================
app.post('/api/quick-queue', async function(req, res) {
  try {
    var ticker = (req.body.ticker || '').toUpperCase().trim();
    var direction = (req.body.direction || 'CALLS').toUpperCase().trim();
    var trigger = parseFloat(req.body.trigger || 0);
    var maxPrice = parseFloat(req.body.maxPrice || 6.00);
    var contracts = parseInt(req.body.contracts || 3);
    var grade = req.body.grade || 'A';

    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    if (!trigger) return res.status(400).json({ error: 'trigger price required' });
    if (direction !== 'CALLS' && direction !== 'PUTS') {
      return res.status(400).json({ error: 'direction must be CALLS or PUTS' });
    }

    var type = direction === 'CALLS' ? 'call' : 'put';

    // GATE 1: Regime check (don't fight the trend)
    var regimeResult = null;
    try {
      var _rg = require('./regimeGate');
      var _ts = require('./tradestation');
      var _tok = await _ts.getAccessToken();
      regimeResult = await _rg.canEnter(ticker, direction, _tok);
      if (!regimeResult.allowed) {
        return res.json({
          status: 'BLOCKED',
          gate: 'REGIME',
          reason: regimeResult.reason,
          ticker: ticker,
          direction: direction,
        });
      }
    } catch(e) { /* regime gate unavailable, proceed */ }

    // AUTO-RESOLVE CONTRACT — picks best strike, expiration, delta
    var resolved = null;
    try {
      var _resolver = require('./contractResolver');
      resolved = await _resolver.resolveContract(ticker, type, 'SWING', {});
    } catch(e) {
      console.error('[QUICK-QUEUE] resolve error:', e.message);
    }

    if (!resolved) {
      return res.status(500).json({ error: 'Could not resolve contract for ' + ticker });
    }
    if (resolved.blocked) {
      return res.json({
        status: 'BLOCKED',
        gate: 'LEVEL_FILTER',
        reason: resolved.reason,
        ticker: ticker,
      });
    }

    // GATE 2: IV check (don't buy theta traps)
    var ivResult = null;
    try {
      var _iv = require('./ivFilter');
      var _ts2 = require('./tradestation');
      var _tok2 = await _ts2.getAccessToken();
      ivResult = await _iv.checkIV(ticker, _tok2, resolved.symbol);
      if (!ivResult.allowed) {
        return res.json({
          status: 'BLOCKED',
          gate: 'IV_FILTER',
          reason: ivResult.reason,
          iv: ivResult.iv,
          cap: ivResult.cap,
          ticker: ticker,
        });
      }
    } catch(e) { /* IV filter unavailable, proceed */ }

    // GATE 3: Max price check
    if (resolved.ask > maxPrice) {
      return res.json({
        status: 'BLOCKED',
        gate: 'PRICE',
        reason: ticker + ' option ask $' + resolved.ask.toFixed(2) + ' > max $' + maxPrice.toFixed(2),
        ticker: ticker,
        ask: resolved.ask,
      });
    }

    // BUILD AND QUEUE — minimal gates, maximum speed
    var trade = {
      ticker: ticker,
      direction: direction,
      triggerPrice: trigger,
      contractSymbol: resolved.symbol,
      strike: resolved.strike,
      expiration: resolved.expiry,
      contractType: direction === 'CALLS' ? 'Call' : 'Put',
      maxEntryPrice: maxPrice,
      stopPct: resolved.optionStopPct ? -(resolved.optionStopPct / 100) : -0.30,
      targets: [0.30, 0.75, 1.50],
      contracts: Math.max(3, contracts),
      management: 'CASEY',
      tradeType: 'SWING',  // ALWAYS swing so it fires anytime
      grade: grade,
      source: 'QUICK_QUEUE',
      note: 'Quick-queue Lane 1. ' + resolved.symbol + ' delta=' +
            (resolved.delta ? resolved.delta.toFixed(2) : '?') +
            ' iv=' + (resolved.iv ? (resolved.iv * 100).toFixed(0) + '%' : '?') +
            ' dte=' + (resolved.dte || '?'),
    };

    if (!brainEngine || !brainEngine.bulkAddQueuedTrades) {
      return res.status(500).json({ error: 'brainEngine not loaded' });
    }
    var result = brainEngine.bulkAddQueuedTrades([trade], { replaceAll: false });

    // Make sure queue is active
    if (brainEngine.setQueueActive) brainEngine.setQueueActive(true);

    res.json({
      status: 'QUEUED',
      ticker: ticker,
      direction: direction,
      trigger: trigger,
      contract: resolved.symbol,
      strike: resolved.strike,
      expiry: resolved.expiry,
      dte: resolved.dte,
      delta: resolved.delta,
      iv: resolved.iv,
      ask: resolved.ask,
      mid: resolved.mid,
      stopPct: trade.stopPct,
      contracts: trade.contracts,
      gates: {
        regime: regimeResult ? 'PASSED' : 'SKIPPED',
        iv: ivResult ? (ivResult.warning ? 'WARNING' : 'PASSED') : 'SKIPPED',
        price: 'PASSED',
      },
      queueResult: result,
    });

  } catch(e) {
    console.error('[QUICK-QUEUE] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk add — POST a full morning queue in one call
app.post('/api/queue/bulk', function(req, res) {
  if (!brainEngine || !brainEngine.bulkAddQueuedTrades) return res.status(500).json({ error: 'brainEngine not loaded' });
  var trades = req.body.trades || req.body || [];
  var replaceAll = req.body.replaceAll === true;
  var result = brainEngine.bulkAddQueuedTrades(trades, { replaceAll: replaceAll });
  res.json({ status: 'OK', result: result });
});

app.get('/api/queue/list', function(req, res) {
  if (!brainEngine || !brainEngine.getQueuedTrades) return res.status(500).json({ error: 'brainEngine not loaded' });
  res.json({
    active: brainEngine.getQueueActive ? brainEngine.getQueueActive() : null,
    trades: brainEngine.getQueuedTrades(),
  });
});

app.post('/api/queue/start', function(req, res) {
  if (!brainEngine || !brainEngine.setQueueActive) return res.status(500).json({ error: 'brainEngine not loaded' });
  var on = brainEngine.setQueueActive(true);
  res.json({ status: 'OK', queueActive: on });
});

app.post('/api/queue/stop', function(req, res) {
  if (!brainEngine || !brainEngine.setQueueActive) return res.status(500).json({ error: 'brainEngine not loaded' });
  var on = brainEngine.setQueueActive(false);
  res.json({ status: 'OK', queueActive: on });
});

app.post('/api/queue/cancel/:id', function(req, res) {
  if (!brainEngine || !brainEngine.cancelQueuedTrade) return res.status(500).json({ error: 'brainEngine not loaded' });
  var ok = brainEngine.cancelQueuedTrade(req.params.id);
  res.json({ status: ok ? 'OK' : 'NOT_FOUND' });
});

// NEWS CATALYST cron (Plan 01) -- poll SEC EDGAR + FINRA every 60s
// during RTH. Alert-only. Never auto-executes.
var newsScanner = null;
try { newsScanner = require('./newsScanner'); console.log('[SERVER] newsScanner loaded OK'); }
catch(e) { console.log('[SERVER] newsScanner not loaded:', e.message); }
cron.schedule('* 9-16 * * 1-5', function() {
  if (newsScanner) {
    newsScanner.scanAll().catch(function(e) { console.error('[NEWS]', e.message); });
  }
}, { timezone: 'America/New_York' });

app.get('/api/news/scan', async function(req, res) {
  if (!newsScanner) return res.status(500).json({ error: 'newsScanner not loaded' });
  try { res.json(await newsScanner.scanAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POSITION HEALTH cron (Plan 03) -- re-check open positions against 2HR/DAILY
// counter-signals every 5 min during RTH. Alert-only. Never auto-closes.
var positionHealth = null;
try { positionHealth = require('./positionHealth'); console.log('[SERVER] positionHealth loaded OK'); }
catch(e) { console.log('[SERVER] positionHealth not loaded:', e.message); }
cron.schedule('*/5 9-16 * * 1-5', function() {
  if (positionHealth) {
    positionHealth.checkAll().catch(function(e) { console.error('[HEALTH]', e.message); });
  }
}, { timezone: 'America/New_York' });

app.get('/api/health/check', async function(req, res) {
  if (!positionHealth) return res.status(500).json({ error: 'positionHealth not loaded' });
  try { res.json(await positionHealth.checkAll()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// MORNING BRIEF cron (v7.5) -- 6:00 AM ET Mon-Fri
// Generates a single watchlist + pulse + FTFC + queue summary and posts to Discord.
var morningBrief = null;
try { morningBrief = require('./morningBrief'); console.log('[SERVER] morningBrief loaded OK'); }
catch(e) { console.log('[SERVER] morningBrief not loaded:', e.message); }
cron.schedule('0 6 * * 1-5', function() {
  if (morningBrief) {
    morningBrief.generateAndPost().catch(function(e) { console.error('[BRIEF]', e.message); });
  }
}, { timezone: 'America/New_York' });

app.get('/api/brief/generate', async function(req, res) {
  if (!morningBrief) return res.status(500).json({ error: 'morningBrief not loaded' });
  try {
    var dry = req.query.dryRun === 'true';
    res.json(await morningBrief.generateAndPost({ dryRun: dry }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// JSMITH POLLER cron (v7.5) -- every 60s during 9 AM - 4 PM ET Mon-Fri
// Reads JSmithTrades.com VIP + Option Trade Ideas + CapitalFlow channels via
// Discord user token and auto-queues John's picks. No-op if DISCORD_USER_TOKEN
// is not set, so it is safe to deploy before the token is provided.
var jsmithPoller = null;
try { jsmithPoller = require('./stratumExternalPoller'); console.log('[SERVER] stratumExternalPoller loaded OK'); }
catch(e) { console.log('[SERVER] jsmithPoller not loaded:', e.message); }
cron.schedule('* 9-16 * * 1-5', function() {
  if (jsmithPoller) {
    jsmithPoller.runPollCycle().catch(function(e) { console.error('[JSMITH]', e.message); });
  }
}, { timezone: 'America/New_York' });

// Also poll outside market hours (8-9 AM and after 4 PM) on 5-min cadence
// so overnight/premarket John ideas land in the queue before the open.
cron.schedule('*/5 8,17,18,19,20,21,22 * * 1-5', function() {
  if (jsmithPoller) {
    jsmithPoller.runPollCycle().catch(function(e) { console.error('[JSMITH-OFFHOURS]', e.message); });
  }
}, { timezone: 'America/New_York' });

app.post('/api/jsmith/poll', async function(req, res) {
  if (!jsmithPoller) return res.status(500).json({ error: 'jsmithPoller not loaded' });
  try { res.json(await jsmithPoller.runPollCycle()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Peek at the latest messages in a JSmith channel WITHOUT touching dedup.
// Use to see what John just posted so Claude can evaluate against Strat + 9-gate.
// Channel keys: VIP_FLOW_OPTIONS | OPTION_TRADE_IDEAS | CAPITAL_FLOW
// Example: /api/jsmith/peek?channel=VIP_FLOW_OPTIONS&limit=5
app.get('/api/jsmith/peek', async function(req, res) {
  if (!jsmithPoller) return res.status(500).json({ error: 'jsmithPoller not loaded' });
  if (typeof jsmithPoller.peekLatest !== 'function') return res.status(501).json({ error: 'peekLatest not available in this build' });
  try {
    var channel = req.query.channel || 'VIP_FLOW_OPTIONS';
    var limit = parseInt(req.query.limit || '5', 10);
    var data = await jsmithPoller.peekLatest(channel, limit);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Quick option-mid lookup for a list of OSI option symbols.
// Example: /api/option-mids?symbols=KO%20260501C77,ET%20260501C19,BP%20260501C46,HOOD%20260501C86
app.get('/api/option-mids', async function(req, res) {
  try {
    var raw = (req.query.symbols || '').toString();
    if (!raw) return res.status(400).json({ error: 'symbols query param required (comma-separated OSI)' });
    var syms = raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.status(500).json({ error: 'no TS token' });
    var fetch = require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + syms.map(encodeURIComponent).join(',');
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await r.json();
    var out = [];
    if (data && data.Quotes) {
      data.Quotes.forEach(function(q){
        var bid = parseFloat(q.Bid);
        var ask = parseFloat(q.Ask);
        var last = parseFloat(q.Last);
        var mid = (isFinite(bid) && isFinite(ask) && bid > 0 && ask > 0) ? +((bid + ask) / 2).toFixed(2) : null;
        out.push({ symbol: q.Symbol, last: isFinite(last) ? last : null, bid: isFinite(bid) ? bid : null, ask: isFinite(ask) ? ask : null, mid: mid, volume: q.Volume, openInterest: q.DailyOpenInterest });
      });
    }
    res.json({ count: out.length, quotes: out, errors: data && data.Errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// WP REVERSAL SCANNER — Failed-2D/2U + 4HR EMA + sector filter
// Built Apr 28 2026 after AB missed UNH overnight 200% swing.
// Scans ~110 mega-caps + healthcare + finance + volatile names.
// Returns top 15 candidates ranked by setup score (0-12 scale).
// Cached 5 min to avoid TS rate limit on UI refresh.
// -----------------------------------------------------------------
app.get('/api/wealthprince-scan', async function(req, res) {
  if (!wpScanner) return res.status(500).json({ error: 'wpScanner not loaded' });
  try {
    var now = Date.now();
    var force = req.query.force === '1' || req.query.force === 'true';
    var direction = (req.query.direction || 'both').toLowerCase();
    var minScore = parseFloat(req.query.minScore) || 5;
    // Cache 5 min unless force
    if (!force && wpScanCache && (now - wpScanCacheTime < 5 * 60 * 1000) && wpScanCache.direction === direction) {
      return res.json(Object.assign({}, wpScanCache.data, { cached: true, cachedAtAge: Math.round((now - wpScanCacheTime) / 1000) + 's' }));
    }
    var data = await wpScanner.scan({ direction: direction, minScore: minScore });
    wpScanCache = { direction: direction, data: data };
    wpScanCacheTime = now;
    res.json(Object.assign({}, data, { cached: false }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------
// LIVE MOVERS AUTO-SCANNER — replaces handpicked TOMORROW watchlist
// Added 2026-04-27 after HOOD -$600 loss + GOOGL/AAPL/MSFT mega-cap
// rotation was missed because the handpicked board didn't cover them.
//
// Scans ~60 liquid optionable mega-caps + high-vol names every call,
// computes composite mover score, returns top 20 ranked.
// Cached 60s to avoid hammering TS API.
//
// Score = 50% pctMove + 30% volRatio + 20% rangeExpansion
// Direction: CALL if positive move, PUT if negative
// -----------------------------------------------------------------
var LIVE_MOVERS_UNIVERSE = [
  'SPY','QQQ','IWM',
  'AAPL','MSFT','GOOGL','GOOG','AMZN','META','NVDA','TSLA','AVGO','AMD','NFLX',
  'CRWD','PLTR','COIN','MSTR','MU','ORCL','ADBE','CRM','INTC','BABA',
  'JPM','BAC','WFC','GS','V','MA',
  'KO','PEP','JNJ','PFE','MRK','UNH',
  'XOM','CVX','OXY','BP','COP',
  'SHOP','NIO','RIVN','F','GM',
  'HOOD','RBLX','U','ROKU','SNAP','UBER','LYFT','ABNB',
  'DIS','NKE','BA','CAT','DE','MMM'
];

var _liveMoversCache = { time: 0, payload: null };
var _volMA30Cache = {}; // { ticker: { value, time } }  — 30-day vol avg cached 6h

async function getVolMA30(symbol, token) {
  var now = Date.now();
  var cached = _volMA30Cache[symbol];
  if (cached && (now - cached.time) < 6 * 60 * 60 * 1000) return cached.value;
  try {
    var fetchLib = require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(symbol)
      + '?interval=1&unit=Daily&barsback=31';
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    if (!r.ok) return null;
    var data = await r.json();
    var bars = (data && data.Bars) ? data.Bars : [];
    if (bars.length < 5) return null;
    // Use last 30 fully-closed daily bars (drop today's in-progress bar at end)
    var closed = bars.slice(0, Math.min(bars.length - 1, 30));
    if (closed.length < 5) closed = bars.slice(-30);
    var sum = 0, n = 0;
    closed.forEach(function(b){
      var v = parseFloat(b.TotalVolume || b.Volume || 0);
      if (isFinite(v) && v > 0) { sum += v; n++; }
    });
    var avg = n > 0 ? sum / n : null;
    _volMA30Cache[symbol] = { value: avg, time: now };
    return avg;
  } catch(e) {
    return null;
  }
}

function moverScore(d) {
  var pctMove = Math.abs(d.pctChange || 0);
  var volRatio = (d.volume || 0) / (d.volMA30 || 1);
  var rangePct = 0;
  if (d.high && d.low && d.prevClose) {
    rangePct = ((d.high - d.low) / d.prevClose) * 100;
  }
  // Cap volRatio at 5 to prevent thin-volume names from skewing
  var vr = Math.min(volRatio, 5);
  var score = (pctMove * 0.5) + (vr * 6) + (rangePct * 0.5);
  return { score: score, volRatio: volRatio, rangePct: rangePct };
}

// Pine autoStep — match the StratumLevels indicator strike-step convention.
// <$25 → 0.5, $25-100 → 1, $100-250 → 2.5, $250-500 → 5, >$500 → 10
function liveMoverAutoStep(spot) {
  if (!spot || !isFinite(spot)) return 1;
  if (spot >= 500) return 10;
  if (spot >= 250) return 5;
  if (spot >= 100) return 2.5;
  if (spot >= 25)  return 1;
  return 0.5;
}

function liveMoverAtmStrike(spot) {
  if (!spot || !isFinite(spot)) return null;
  var step = liveMoverAutoStep(spot);
  return Math.round(spot / step) * step;
}

// Returns YYMMDD for the next Friday at or after today (ET).
// Mirrors dailyPlanV4.nextFridayYYMMDD without importing it (server-side
// duplicate kept tiny + dependency-free for /api/live-movers hot path).
function liveMoverNextFridayYYMMDD() {
  var now = new Date();
  for (var i = 0; i <= 7; i++) {
    var trial = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    // ET weekday — use toLocaleString to coerce
    var wd = trial.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
    if (wd === 'Fri') {
      var parts = trial.toLocaleDateString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York',
      }).split('/');  // mm/dd/yyyy
      var mm = parts[0], dd = parts[1], yyyy = parts[2];
      return String(yyyy).slice(2) + mm + dd;
    }
  }
  return null;
}

// Build OSI: "TICKER YYMMDDC|Pstrike" (strip trailing .0/.00)
function liveMoverBuildOSI(ticker, expiryYYMMDD, side, strike) {
  var s = String(strike);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return ticker + ' ' + expiryYYMMDD + side + s;
}

// John's ladder applied to option mid: stop=0.75x, tp1=1.25x, tp2=1.5x, tp3=2.0x.
// Used on Live Movers cards so AB can fire directly without recomputing.
function liveMoverOptionLadder(mid) {
  if (!mid || !isFinite(mid) || mid <= 0) return null;
  return {
    entry: +mid.toFixed(2),
    stop:  +(mid * 0.75).toFixed(2),
    tp1:   +(mid * 1.25).toFixed(2),
    tp2:   +(mid * 1.50).toFixed(2),
    tp3:   +(mid * 2.00).toFixed(2),
  };
}

// Compute adaptive stock levels (12.5/25/50/75/87.5%) from today's high/low.
// Used to derive trigger + structural-stop + TP1/TP2 price-of-stock for the
// Live Movers card, matching the Pine StratumLevels framework.
function liveMoverStockLevels(low, high) {
  if (!isFinite(low) || !isFinite(high) || high <= low) return null;
  var range = high - low;
  return {
    level125: +(low + range * 0.125).toFixed(2),
    level25:  +(low + range * 0.25).toFixed(2),
    level50:  +(low + range * 0.50).toFixed(2),
    level75:  +(low + range * 0.75).toFixed(2),
    level875: +(low + range * 0.875).toFixed(2),
  };
}

app.get('/api/live-movers', async function(req, res) {
  try {
    var now = Date.now();
    if (_liveMoversCache.payload && (now - _liveMoversCache.time) < 60 * 1000) {
      return res.json(Object.assign({ cached: true }, _liveMoversCache.payload));
    }
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return res.status(500).json({ error: 'no TS token — visit /ts-auth' });
    var fetchLib = require('node-fetch');
    var symbols = LIVE_MOVERS_UNIVERSE.slice();
    // Bulk quote pull — TS supports comma-separated list
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + symbols.map(encodeURIComponent).join(',');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 12000 });
    if (!r.ok) return res.status(500).json({ error: 'TS quotes failed: ' + r.status });
    var data = await r.json();
    var quotes = (data && data.Quotes) ? data.Quotes : [];

    // Fan out vol-MA pulls in parallel (capped at 8 concurrent) to keep
    // total call time bounded. Cache hits are instant; cold-fetches happen
    // once per ticker every 6h.
    var tasks = quotes.map(function(q){
      return (async function(){
        var sym = q.Symbol;
        var last       = parseFloat(q.Last || q.Close || 0);
        var prevClose  = parseFloat(q.PreviousClose || q.Close || 0);
        var volume     = parseFloat(q.Volume || 0);
        var high       = parseFloat(q.High || 0);
        var low        = parseFloat(q.Low || 0);
        var open       = parseFloat(q.Open || 0);
        var pctChange  = (prevClose > 0 && isFinite(last)) ? ((last - prevClose) / prevClose) * 100 : 0;
        var volMA30    = await getVolMA30(sym, token);
        var d = {
          ticker:     sym,
          last:       isFinite(last) ? +last.toFixed(2) : null,
          prevClose:  isFinite(prevClose) ? +prevClose.toFixed(2) : null,
          open:       isFinite(open) ? +open.toFixed(2) : null,
          high:       isFinite(high) ? +high.toFixed(2) : null,
          low:        isFinite(low)  ? +low.toFixed(2)  : null,
          pctChange:  +pctChange.toFixed(2),
          volume:     isFinite(volume) ? volume : 0,
          volMA30:    volMA30 ? Math.round(volMA30) : null,
        };
        var ms = moverScore(d);
        d.volRatio = volMA30 ? +(volume / volMA30).toFixed(2) : null;
        d.rangePct = +ms.rangePct.toFixed(2);
        d.score    = +ms.score.toFixed(2);
        d.suggestedDirection = pctChange >= 0 ? 'CALL' : 'PUT';
        return d;
      })();
    });

    // Concurrency-limited execution
    var CONCURRENCY = 8;
    var results = [];
    for (var i = 0; i < tasks.length; i += CONCURRENCY) {
      var slice = tasks.slice(i, i + CONCURRENCY);
      var batch = await Promise.all(slice);
      results = results.concat(batch);
    }

    // Filter out broken rows (no last or no prevClose) then rank by abs score
    var clean = results.filter(function(d){ return d.last && d.prevClose; });
    clean.sort(function(a, b){ return b.score - a.score; });
    var top = clean.slice(0, 20);

    // -----------------------------------------------------------------
    // Per-mover bracket enrichment for FIRE NOW + QUEUE w/ TRIGGER UI.
    // For each top mover compute:
    //   - adaptive stock levels (12.5 / 25 / 50 / 75 / 87.5 % of today's range)
    //   - trigger price (last ± 0.10 buffer, side-dependent)
    //   - structural stop on the UNDERLYING (level125 long, level875 short)
    //   - TP1 / TP2 stock targets (level50 / level75 long, level50 / level25 short)
    //   - ATM strike via Pine autoStep, next-Friday OSI
    //   - John's ladder on the live option mid (entry/stop/tp1/tp2/tp3)
    // Option mids are fetched in one batch off the same TS endpoint
    // /api/option-mids uses, so we don't pay another HTTP hop.
    // -----------------------------------------------------------------
    var expiry = liveMoverNextFridayYYMMDD();
    top.forEach(function(d) {
      var lvls = liveMoverStockLevels(d.low, d.high);
      d.level25 = lvls ? lvls.level25 : null;
      d.level50 = lvls ? lvls.level50 : null;
      d.level75 = lvls ? lvls.level75 : null;
      var isCall = d.suggestedDirection === 'CALL';
      var BUF = 0.10;  // trigger buffer above/below current
      d.triggerPrice = isFinite(d.last) ? +(isCall ? d.last + BUF : d.last - BUF).toFixed(2) : null;
      d.triggerPredicate = isCall ? 'above' : 'below';
      if (lvls) {
        d.structuralStop = {
          symbol:    d.ticker,
          predicate: isCall ? 'below' : 'above',
          price:     isCall ? lvls.level125 : lvls.level875,
        };
        d.stockTp1 = isCall ? lvls.level50 : lvls.level50;
        d.stockTp2 = isCall ? lvls.level75 : lvls.level25;
      } else {
        d.structuralStop = null;
        d.stockTp1 = null;
        d.stockTp2 = null;
      }
      d.atmStrike = liveMoverAtmStrike(d.last);
      d.expiry    = expiry;
      d.optionSymbol = (d.atmStrike && expiry)
        ? liveMoverBuildOSI(d.ticker, expiry, isCall ? 'C' : 'P', d.atmStrike)
        : null;
    });

    // Single bulk option-mid pull for all top movers.
    var optionSymbols = top.map(function(d){ return d.optionSymbol; }).filter(Boolean);
    var midsByOSI = {};
    if (optionSymbols.length) {
      try {
        var midUrl = 'https://api.tradestation.com/v3/marketdata/quotes/' +
                     optionSymbols.map(encodeURIComponent).join(',');
        var mr = await fetchLib(midUrl, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 12000 });
        if (mr.ok) {
          var mdata = await mr.json();
          (mdata && mdata.Quotes ? mdata.Quotes : []).forEach(function(q){
            var bid = parseFloat(q.Bid);
            var ask = parseFloat(q.Ask);
            var mid = (isFinite(bid) && isFinite(ask) && bid > 0 && ask > 0)
                      ? +((bid + ask) / 2).toFixed(2) : null;
            midsByOSI[q.Symbol] = { mid: mid, bid: isFinite(bid) ? bid : null, ask: isFinite(ask) ? ask : null };
          });
        }
      } catch(e) {
        console.log('[LIVE-MOVERS] option-mid bulk fetch failed:', e.message);
      }
    }

    top.forEach(function(d){
      var q = d.optionSymbol ? midsByOSI[d.optionSymbol] : null;
      if (!q && d.optionSymbol) {
        // Fallback: TS sometimes echoes the symbol with trailing .0 stripped/added
        q = midsByOSI[d.optionSymbol.replace(/(\d)\.0$/, '$1')] ||
            midsByOSI[d.optionSymbol + '.0'];
      }
      d.optionMid  = q ? q.mid : null;
      d.optionBid  = q ? q.bid : null;
      d.optionAsk  = q ? q.ask : null;
      var ladder = liveMoverOptionLadder(d.optionMid);
      d.optionEntry = ladder ? ladder.entry : null;
      d.optionStop  = ladder ? ladder.stop  : null;
      d.optionTp1   = ladder ? ladder.tp1   : null;
      d.optionTp2   = ladder ? ladder.tp2   : null;
      d.optionTp3   = ladder ? ladder.tp3   : null;
    });

    var payload = {
      ok:       true,
      count:    top.length,
      universe: LIVE_MOVERS_UNIVERSE.length,
      ts:       new Date().toISOString(),
      movers:   top,
    };
    _liveMoversCache = { time: now, payload: payload };
    res.json(payload);
  } catch(e) {
    console.error('[LIVE-MOVERS]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jsmith/diag', function(req, res) {
  res.json({
    hasToken: !!process.env.DISCORD_USER_TOKEN,
    tokenLen: (process.env.DISCORD_USER_TOKEN || '').length,
    pollerLoaded: !!jsmithPoller,
    jsmithTest: process.env.JSMITH_TEST || null,
    envKeysWithDiscord: Object.keys(process.env).filter(function(k){return k.indexOf('DISCORD')>=0 || k.indexOf('JSMITH')>=0;}),
  });
});

// -----------------------------------------------------------------
// DAILY TRADE PLAN V4 — auto-discovered tomorrow board
// Built Apr 27 2026 after handpicked watchlist missed GOOGL/SNAP/MU
// rotation + AB lost $600 on HOOD. Replaces human curation with:
//   /api/live-movers + JSmith peek (4 channels) + composite scoring
// Cron: 4:30 PM ET Mon-Fri. Manual trigger: POST /api/tradeplan/build-v4
// -----------------------------------------------------------------
var dailyPlanV4 = null;
try { dailyPlanV4 = require('./dailyPlanV4'); console.log('[SERVER] dailyPlanV4 loaded OK'); }
catch(e) { console.log('[SERVER] dailyPlanV4 not loaded:', e.message); }

cron.schedule('30 16 * * 1-5', function() {
  if (!dailyPlanV4) return;
  dailyPlanV4.runDailyPlanCron().catch(function(e){ console.error('[V4-PLAN cron]', e.message); });
}, { timezone: 'America/New_York' });

app.post('/api/tradeplan/build-v4', async function(req, res) {
  try {
    var secret = req.headers['x-stratum-secret'];
    if (secret !== process.env.STRATUM_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!dailyPlanV4) return res.status(500).json({ error: 'dailyPlanV4 not loaded' });
    var target = (req.body && req.body.targetDate) ? req.body.targetDate : null;
    var post = req.body && req.body.postDiscord !== false;
    var out = await dailyPlanV4.generateV4Plan(target);
    var disc = null;
    if (post) {
      // Reuse the cron path so behavior matches scheduled runs.
      disc = await (async function() {
        var fetchLib = require('node-fetch');
        var hook = process.env.DISCORD_STRATUMSWING_WEBHOOK;
        if (!hook) return { skipped: 'no DISCORD_STRATUMSWING_WEBHOOK' };
        try {
          var r = await fetchLib(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: out.discordContent, username: 'Stratum Trade Plan v4' }),
            timeout: 8000,
          });
          return { status: r.status, ok: r.ok };
        } catch (e) { return { error: e.message }; }
      })();
    }
    res.json({
      ok:        true,
      targetISO: out.targetISO,
      expiry:    out.expiry,
      mdPath:    out.mdPath,
      pdfPath:   out.pdfPath,
      builtAtET: out.builtAtET,
      picks:     out.picks,
      discord:   disc,
      md:        out.md,
    });
  } catch(e) {
    console.error('[V4-PLAN endpoint]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------
// RE-ENTRY RADAR — 2nd-chance entry pattern detector
// Runs every 5 min during market hours. Monitors watchlist for
// pullback-and-reclaim patterns on tickers with registered triggers.
// Pushes Discord via pushCuratorAlert when pattern fires.
// -----------------------------------------------------------------
var reentryRadar = null;
try { reentryRadar = require('./reentryRadar'); console.log('[SERVER] reentryRadar loaded OK'); }
catch(e) { console.log('[SERVER] reentryRadar not loaded:', e.message); }

// Cron: every 5 min, 9 AM - 3:55 PM ET, Mon-Fri
cron.schedule('*/5 9-15 * * 1-5', function() {
  if (reentryRadar) {
    reentryRadar.runCycle().catch(function(e) { console.error('[RADAR]', e.message); });
  }
}, { timezone: 'America/New_York' });

// Register a ticker + trigger price + direction for monitoring.
// POST /api/radar/watch  { ticker, triggerPrice, direction: 'long'|'short' }
app.post('/api/radar/watch', function(req, res) {
  if (!reentryRadar) return res.status(500).json({ error: 'reentryRadar not loaded' });
  try {
    var b = req.body || {};
    if (!b.ticker || !b.triggerPrice || !b.direction) {
      return res.status(400).json({ error: 'required: ticker, triggerPrice, direction' });
    }
    if (b.direction !== 'long' && b.direction !== 'short') {
      return res.status(400).json({ error: 'direction must be long or short' });
    }
    var result = reentryRadar.registerWatch(b.ticker, b.triggerPrice, b.direction);
    res.json({ ok: true, watch: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Unregister a ticker
app.delete('/api/radar/watch/:ticker', function(req, res) {
  if (!reentryRadar) return res.status(500).json({ error: 'reentryRadar not loaded' });
  try { res.json(reentryRadar.unregisterWatch(req.params.ticker)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// List all registered watches
app.get('/api/radar/watches', function(req, res) {
  if (!reentryRadar) return res.status(500).json({ error: 'reentryRadar not loaded' });
  try { res.json(reentryRadar.listWatches()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual runCycle trigger (for testing + debug)
app.post('/api/radar/run', async function(req, res) {
  if (!reentryRadar) return res.status(500).json({ error: 'reentryRadar not loaded' });
  try { res.json(await reentryRadar.runCycle()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Tail the radar event log
app.get('/api/radar/log', function(req, res) {
  try {
    var fs = require('fs');
    var path = require('path');
    var STATE_DIR = process.env.STATE_DIR || '/tmp';
    var logPath = path.join(STATE_DIR, 'reentry_radar.jsonl');
    if (!fs.existsSync(logPath)) return res.json({ events: [] });
    var limit = parseInt(req.query.limit || '50', 10);
    var lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    var tail = lines.slice(-limit).map(function(l) { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
    res.json({ count: tail.length, events: tail });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// LIQUIDITY CHECK — Trading-Desk Grade Pre-Entry Verification
// Added 2026-04-24 after META session failure (stale pre-market quotes
// led to unexecutable contract). This endpoint MUST be called before
// ANY Titan card is proposed.
//
// Usage: GET /api/liquidity/check?symbols=META 260508C670,META 260515C670
// Returns liquidity score + pass/fail per contract + ranked "best"
// -----------------------------------------------------------------
var liquidityCheck = null;
try { liquidityCheck = require('./liquidityCheck'); console.log('[SERVER] liquidityCheck loaded OK'); }
catch(e) { console.log('[SERVER] liquidityCheck not loaded:', e.message); }

app.get('/api/liquidity/check', async function(req, res) {
  if (!liquidityCheck) return res.status(500).json({ error: 'liquidityCheck not loaded' });
  try {
    var raw = (req.query.symbols || '').trim();
    if (!raw) return res.status(400).json({ error: 'symbols query param required (comma-separated)' });
    var symbols = raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!symbols.length) return res.status(400).json({ error: 'no valid symbols' });
    if (symbols.length > 20) return res.status(400).json({ error: 'max 20 symbols per call' });
    var result = await liquidityCheck.checkMany(symbols);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// MORNING PLANNER — 6:00 AM ET cron pre-market routine
// Ranks top setups by confluence + runs liquidity check on top 3
// Pushes Discord brief with candidate contracts (pre-market, flagged DRAFT)
// -----------------------------------------------------------------
var morningPlanner = null;
try { morningPlanner = require('./morningPlanner'); console.log('[SERVER] morningPlanner loaded OK'); }
catch(e) { console.log('[SERVER] morningPlanner not loaded:', e.message); }

// Cron: 6:00 AM ET every weekday
cron.schedule('0 6 * * 1-5', async function() {
  if (morningPlanner) {
    try {
      var report = await morningPlanner.runMorningRoutine();
      console.log('[PLANNER-CRON] complete:', (report.cards || []).length, 'cards');
    } catch(e) { console.error('[PLANNER-CRON] error:', e.message); }
  }
}, { timezone: 'America/New_York' });

// Cron: 9:15 AM ET = LIVE RE-VERIFY (the one that would have saved 4/24)
cron.schedule('15 9 * * 1-5', async function() {
  if (morningPlanner) {
    try {
      var report = await morningPlanner.runMorningRoutine();
      console.log('[PLANNER-915] live re-verify complete');
    } catch(e) { console.error('[PLANNER-915] error:', e.message); }
  }
}, { timezone: 'America/New_York' });

app.post('/api/planner/run', async function(req, res) {
  if (!morningPlanner) return res.status(500).json({ error: 'morningPlanner not loaded' });
  try { res.json(await morningPlanner.runMorningRoutine()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/planner/latest', function(req, res) {
  if (!morningPlanner) return res.status(500).json({ error: 'morningPlanner not loaded' });
  var report = morningPlanner.getLatestReport();
  if (!report) return res.json({ error: 'no report yet — run /api/planner/run or wait for 6 AM cron' });
  res.json(report);
});

// -----------------------------------------------------------------
// CHART MARKUP QUEUE — local Claude reads this + runs TV MCP commands
// -----------------------------------------------------------------
var chartMarkup = null;
try { chartMarkup = require('./chartMarkup'); console.log('[SERVER] chartMarkup loaded OK'); }
catch(e) { console.log('[SERVER] chartMarkup not loaded:', e.message); }

app.post('/api/chart-markup/queue', function(req, res) {
  if (!chartMarkup) return res.status(500).json({ error: 'chartMarkup not loaded' });
  try {
    var b = req.body || {};
    if (!b.ticker || !b.trigger || !b.stop) {
      return res.status(400).json({ error: 'ticker, trigger, stop required' });
    }
    var job = chartMarkup.queueSetup(b);
    res.json({ ok: true, job: job });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chart-markup/pending', function(req, res) {
  if (!chartMarkup) return res.status(500).json({ error: 'chartMarkup not loaded' });
  var jobs = chartMarkup.getPendingJobs();
  // Include pre-generated draw commands for easy Claude execution
  var jobsWithCommands = jobs.map(function(j) {
    return { job: j, commands: chartMarkup.generateDrawCommands(j) };
  });
  res.json({ count: jobs.length, jobs: jobsWithCommands });
});

app.post('/api/chart-markup/complete/:id', function(req, res) {
  if (!chartMarkup) return res.status(500).json({ error: 'chartMarkup not loaded' });
  chartMarkup.markJobComplete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/chart-markup/clear', function(req, res) {
  if (!chartMarkup) return res.status(500).json({ error: 'chartMarkup not loaded' });
  chartMarkup.clearQueue();
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// SCOUT HEALTH TRACKER -- real-time heartbeat for the arm page
// -----------------------------------------------------------------
var scoutHealth = null;
try { scoutHealth = require('./scoutHealth'); console.log('[SERVER] scoutHealth loaded OK'); }
catch(e) { console.log('[SERVER] scoutHealth not loaded:', e.message); }

app.get('/api/health', async function(req, res) {
  if (!scoutHealth) return res.json({ status: 'NOT_LOADED' });
  // Quick token check on demand (cached result if recent)
  await scoutHealth.checkToken();
  res.json(scoutHealth.getHealth());
});

// GEX / GAMMA LEVELS API
// GET /api/gex/SPY  → returns gamma levels for SPY
// GET /api/gex/batch?tickers=SPY,QQQ,TSLA → batch gamma levels
app.get('/api/gex/batch', async function(req, res) {
  if (!gex) return res.status(500).json({ error: 'GEX module not loaded' });
  try {
    var tickers = (req.query.tickers || 'SPY,QQQ').split(',').map(function(t) { return t.trim().toUpperCase(); });
    var results = await gex.batchGammaLevels(tickers);
    res.json({ ok: true, results: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gex/:ticker', async function(req, res) {
  if (!gex) return res.status(500).json({ error: 'GEX module not loaded' });
  try {
    var ticker = req.params.ticker.toUpperCase();
    var levels = await gex.getGammaLevels(ticker);
    if (!levels) return res.status(404).json({ error: 'No GEX data for ' + ticker });
    res.json({ ok: true, levels: levels, discord: gex.formatGEXForDiscord(levels) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// OPTIONS CHAIN API (Apr 26 2026 PM) — strike-by-strike call/put with Greeks.
// GET /api/options-chain/:ticker?expiry=YYYY-MM-DD&priceCenter=425
//   - expiry default: next Friday
//   - priceCenter default: current quote
// Returns merged-by-strike chain + best-strike picks for the OPTIONS tab.
var optionsChain = null;
try { optionsChain = require('./optionsChain'); console.log('[SERVER] optionsChain loaded OK'); }
catch(e) { console.log('[SERVER] optionsChain not loaded:', e.message); }

function _nextFridayISO() {
  var d = new Date();
  var dow = d.getUTCDay();  // 0 = Sun, 5 = Fri
  var daysToFri = (5 - dow + 7) % 7;
  if (daysToFri === 0) daysToFri = 7;  // if today is Friday, return next Friday
  d.setUTCDate(d.getUTCDate() + daysToFri);
  return d.toISOString().slice(0, 10);
}

app.get('/api/options-chain/:ticker', async function(req, res) {
  if (!optionsChain) return res.status(500).json({ error: 'optionsChain module not loaded' });
  try {
    var ticker = String(req.params.ticker).toUpperCase();
    var expiry = req.query.expiry || _nextFridayISO();
    var priceCenter = req.query.priceCenter ? parseFloat(req.query.priceCenter) : null;

    // If no priceCenter passed, fetch live quote so the chain centers on ATM
    if (!priceCenter) {
      try {
        var ts = require('./tradestation');
        var token = await ts.getAccessToken();
        if (token) {
          var qr = await require('node-fetch')('https://api.tradestation.com/v3/marketdata/quotes/' + ticker, {
            headers: { 'Authorization': 'Bearer ' + token }
          });
          var qd = await qr.json();
          var q = (qd.Quotes && qd.Quotes[0]) || {};
          priceCenter = parseFloat(q.Last || q.Close || 0) || null;
        }
      } catch(_) { /* soft fail — chain will still work without priceCenter */ }
    }

    var data = await optionsChain.fetchChain(ticker, expiry, priceCenter);
    res.json({ ok: true, chain: data });
  } catch(e) {
    console.error('[OPTIONS-CHAIN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// SIGNAL PERFORMANCE TRACKER API
app.get('/api/signals/stats', function(req, res) {
  if (!signalTracker) return res.status(500).json({ error: 'Signal tracker not loaded' });
  var days = parseInt(req.query.days) || 30;
  var source = req.query.source || null;
  var grade = req.query.grade || null;
  res.json(signalTracker.getStats({ days: days, source: source, grade: grade }));
});

app.get('/api/signals/history', function(req, res) {
  if (!signalTracker) return res.status(500).json({ error: 'Signal tracker not loaded' });
  var limit = parseInt(req.query.limit) || 50;
  res.json(signalTracker.getHistory({ limit: limit }));
});

app.post('/api/signals/reconcile', async function(req, res) {
  if (!signalTracker) return res.status(500).json({ error: 'Signal tracker not loaded' });
  try { res.json(await signalTracker.autoReconcile()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// SPY HEDGE SCOUT cron -- every 60s during market hours Mon-Fri
// Watches SPY 5-min bars for FAILED resistance rejection or support break
// and auto-queues a SPY put hedge via brainEngine. See spyHedgeScout.js.
var spyHedgeScout = null;
try { spyHedgeScout = require('./spyHedgeScout'); console.log('[SERVER] spyHedgeScout loaded OK'); }
catch(e) { console.log('[SERVER] spyHedgeScout not loaded:', e.message); }
cron.schedule('* 9-15 * * 1-5', function() {
  if (spyHedgeScout) {
    spyHedgeScout.runCycle().then(function(r) {
      if (scoutHealth) scoutHealth.report('spyHedge', { ok: true, checked: 1, queued: (r && r.status && r.status.indexOf('FIRED') >= 0) ? 1 : 0, skipped: 0 });
      if (r && (r.status === 'FIRED_A' || r.status === 'FIRED_B' || r.status === 'ABORT' || r.status === 'signal_bar_flagged')) {
        console.log('[SPY-HEDGE]', r.status);
      }
    }).catch(function(e) {
      if (scoutHealth) scoutHealth.report('spyHedge', { ok: false, reason: e.message, checked: 0, queued: 0, skipped: 0 });
      console.error('[SPY-HEDGE]', e.message);
    });
  }
}, { timezone: 'America/New_York' });

app.post('/api/spy-hedge/run', async function(req, res) {
  if (!spyHedgeScout) return res.status(500).json({ error: 'spyHedgeScout not loaded' });
  try { res.json(await spyHedgeScout.runCycle()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/spy-hedge/state', function(req, res) {
  if (!spyHedgeScout) return res.status(500).json({ error: 'spyHedgeScout not loaded' });
  res.json({ config: spyHedgeScout.getConfig(), state: spyHedgeScout.getState() });
});
app.post('/api/spy-hedge/config', function(req, res) {
  if (!spyHedgeScout) return res.status(500).json({ error: 'spyHedgeScout not loaded' });
  res.json(spyHedgeScout.setConfig(req.body || {}));
});
app.post('/api/spy-hedge/reset', function(req, res) {
  if (!spyHedgeScout) return res.status(500).json({ error: 'spyHedgeScout not loaded' });
  res.json(spyHedgeScout.resetState());
});

// CASEY / WP / STRAT ENTRY SCOUTS -- auto-queue their own setups.
// Casey: PDH/PDL breakout + PMH/PML retest every 60s 9:30-11:30 ET.
// Strat: F2U/F2D/Inside/Hammer/Shooter on 60m + Daily, FTFC veto. Every 60s.
// WP:    4hr hammer/shooter off 9/21 EMA fan. Every 4h on the hour.
var caseyEntry = null, wpEntry = null, stratEntry = null;
try { caseyEntry = require('./stratumBreakEntry'); console.log('[SERVER] stratumBreakEntry loaded OK'); }
catch(e) { console.log('[SERVER] stratumBreakEntry not loaded:', e.message); }
try { wpEntry = require('./stratumSwingEntry'); console.log('[SERVER] stratumSwingEntry loaded OK'); }
catch(e) { console.log('[SERVER] stratumSwingEntry not loaded:', e.message); }
try { stratEntry = require('./stratumBarEntry'); console.log('[SERVER] stratumBarEntry loaded OK'); }
catch(e) { console.log('[SERVER] stratumBarEntry not loaded:', e.message); }

// Scout cron windows -- system watches the whole session, no hour gate.
// Apr 15 2026: AB removed the 9-11 morning-only gate. The scouts are
// disciplined enough to dedup their own signals; let them run all day.
cron.schedule('* 9-15 * * 1-5', function() {
  if (caseyEntry) caseyEntry.run().then(function(r) {
    if (scoutHealth) scoutHealth.report('casey', r);
  }).catch(function(e){
    if (scoutHealth) scoutHealth.report('casey', { ok: false, reason: e.message, checked: 0, queued: 0, skipped: 0 });
    console.error('[CASEY]', e.message);
  });
}, { timezone: 'America/New_York' });

cron.schedule('* 9-15 * * 1-5', function() {
  if (stratEntry) stratEntry.run().then(function(r) {
    if (scoutHealth) scoutHealth.report('strat', r);
  }).catch(function(e){
    if (scoutHealth) scoutHealth.report('strat', { ok: false, reason: e.message, checked: 0, queued: 0, skipped: 0 });
    console.error('[STRAT]', e.message);
  });
}, { timezone: 'America/New_York' });

cron.schedule('*/15 9-15 * * 1-5', function() {
  if (wpEntry) wpEntry.run().then(function(r) {
    if (scoutHealth) scoutHealth.report('wp', r);
  }).catch(function(e){
    if (scoutHealth) scoutHealth.report('wp', { ok: false, reason: e.message, checked: 0, queued: 0, skipped: 0 });
    console.error('[WP]', e.message);
  });
}, { timezone: 'America/New_York' });

app.post('/api/casey/run', async function(req, res) {
  if (!caseyEntry) return res.status(500).json({ error: 'caseyEntry not loaded' });
  try { res.json(await caseyEntry.run()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wp/run', async function(req, res) {
  if (!wpEntry) return res.status(500).json({ error: 'wpEntry not loaded' });
  try { res.json(await wpEntry.run()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/strat/run', async function(req, res) {
  if (!stratEntry) return res.status(500).json({ error: 'stratEntry not loaded' });
  try { res.json(await stratEntry.run()); } catch(e) { res.status(500).json({ error: e.message }); }
});

// AYCE + SPREAD scouts (Tier 3)
var ayceScout = null, spreadScout = null;
try { ayceScout = require('./stratumFailureScout'); console.log('[SERVER] stratumFailureScout loaded OK'); }
catch(e) { console.log('[SERVER] ayceScout not loaded:', e.message); }
try { spreadScout = require('./spreadScout'); console.log('[SERVER] spreadScout loaded OK'); }
catch(e) { console.log('[SERVER] spreadScout not loaded:', e.message); }

// ============================================================
// SCOUT KILL SWITCH (Apr 21 2026 — AB reduce-burn directive)
// Per OPERATING_MODEL_apr21: no auto-fire ever. Scouts were still running
// on their crons every minute burning TS API rate limit with 429 storms
// even though queue-cycle bug was fixed. When DISABLE_SCOUTS=true is set
// on Railway env, all scout module references are nulled so the existing
// `if (scoutVar) scoutVar.run()` cron guards silently no-op.
//
// To re-enable: unset the env var and redeploy. No code change needed.
// ============================================================
if (process.env.DISABLE_SCOUTS === 'true') {
  // Apr 21 2026 PM v4 — jsmithPoller is READ-ONLY (fetches John's Discord
  // messages, no auto-fire). Keep it alive even when scouts are disabled so
  // AB can pull John's VIP picks while the brain is locked down.
  // jsmithPoller  = null;  ← intentionally NOT nulled
  spyHedgeScout = null;
  caseyEntry    = null;
  wpEntry       = null;
  stratEntry    = null;
  ayceScout     = null;
  spreadScout   = null;
  console.log('[SERVER] 🔒 DISABLE_SCOUTS=true — all 7 scouts nulled, crons will no-op. TS API burn reduced.');
}

// AYCE fires opportunistically: 9:30-11:30 AM for Miyagi/4HR/Failed9/322,
// then every 5 min 11-15 ET for 7HR liquidity sweep.
// AYCE: every 2 min all session. Strategy-level gating lives inside the
// scout (Miyagi/Failed9 fire at 9:30, 322 at 10, 7HR sweep after 11).
cron.schedule('*/2 9-15 * * 1-5', function() {
  if (ayceScout) ayceScout.run().then(function(r) {
    if (scoutHealth) scoutHealth.report('ayce', r);
  }).catch(function(e){
    if (scoutHealth) scoutHealth.report('ayce', { ok: false, reason: e.message, checked: 0, queued: 0, skipped: 0 });
    console.error('[AYCE]', e.message);
  });
}, { timezone: 'America/New_York' });

// Spread: every 10 min during RTH. spreadScout self-blocks Friday 14:00+
// for pin risk, so no hour gate needed here.
cron.schedule('*/10 9-15 * * 1-5', function() {
  if (spreadScout) spreadScout.run().catch(function(e){ console.error('[SPREAD-SCOUT]', e.message); });
}, { timezone: 'America/New_York' });

app.post('/api/ayce/run', async function(req, res) {
  if (!ayceScout) return res.status(500).json({ error: 'ayceScout not loaded' });
  try { res.json(await ayceScout.run()); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/spread-scout/run', async function(req, res) {
  if (!spreadScout) return res.status(500).json({ error: 'spreadScout not loaded' });
  try { res.json(await spreadScout.run()); } catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// MORNING BRAIN BRIEF (enhanced) — 8:55 AM ET + 6:00 AM backtest pre-cache
// -----------------------------------------------------------------
var morningBrainBrief = null;
try { morningBrainBrief = require('./morningBrainBrief'); console.log('[SERVER] morningBrainBrief loaded OK'); }
catch(e) { console.log('[SERVER] morningBrainBrief not loaded:', e.message); }

// Pre-cache yesterday's backtest at 6:00 AM ET so the 8:55 brief reads it instantly
cron.schedule('0 6 * * 1-5', function() {
  if (morningBrainBrief && morningBrainBrief.preCacheBacktest) {
    morningBrainBrief.preCacheBacktest().catch(function(e) { console.error('[BRAIN-BRIEF] backtest pre-cache error:', e.message); });
  }
}, { timezone: 'America/New_York' });

// Generate and post the full brain brief at 8:55 AM ET
cron.schedule('55 8 * * 1-5', function() {
  if (morningBrainBrief) {
    morningBrainBrief.generateAndPost().catch(function(e) { console.error('[BRAIN-BRIEF] generate error:', e.message); });
  }
}, { timezone: 'America/New_York' });

app.post('/api/brain-brief/generate', async function(req, res) {
  if (!morningBrainBrief) return res.status(500).json({ error: 'morningBrainBrief not loaded' });
  try {
    var dry = req.query.dryRun === 'true';
    res.json(await morningBrainBrief.generateAndPost({ dryRun: dry }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/brain-brief/backtest-cache', async function(req, res) {
  if (!morningBrainBrief || !morningBrainBrief.preCacheBacktest) return res.status(500).json({ error: 'morningBrainBrief not loaded' });
  try { res.json(await morningBrainBrief.preCacheBacktest()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// GAP SCANNER — pre-market gapper ranking for priority entries
// -----------------------------------------------------------------
var gapScanner = null;
try { gapScanner = require('./gapScanner'); console.log('[SERVER] gapScanner loaded OK'); }
catch(e) { console.log('[SERVER] gapScanner not loaded:', e.message); }

// 9:25 AM ET — pre-market gap scan (before bell)
cron.schedule('25 9 * * 1-5', async function() {
  if (gapScanner) {
    console.log('[CRON] 9:25 AM — pre-market gap scan');
    await gapScanner.scan();
  }
}, { timezone: 'America/New_York' });

// 9:31 AM ET — re-scan with live opening prices
cron.schedule('31 9 * * 1-5', async function() {
  if (gapScanner) {
    console.log('[CRON] 9:31 AM — opening gap re-scan');
    await gapScanner.scan();
  }
}, { timezone: 'America/New_York' });

app.get('/api/gap', function(req, res) {
  if (!gapScanner) return res.status(500).json({ error: 'gapScanner not loaded' });
  res.json(gapScanner.getState());
});

app.post('/api/gap/scan', async function(req, res) {
  if (!gapScanner) return res.status(500).json({ error: 'gapScanner not loaded' });
  try { res.json(await gapScanner.scan()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------------------------------
// REGIME GATE — market regime diagnostics
// -----------------------------------------------------------------
var regimeGate = null;
try { regimeGate = require('./regimeGate'); console.log('[SERVER] regimeGate loaded OK'); }
catch(e) { console.log('[SERVER] regimeGate not loaded:', e.message); }

app.get('/api/regime', function(req, res) {
  if (!regimeGate) return res.status(500).json({ error: 'regimeGate not loaded' });
  res.json(regimeGate.getState());
});

app.get('/api/regime/check', async function(req, res) {
  if (!regimeGate) return res.status(500).json({ error: 'regimeGate not loaded' });
  var ticker = (req.query.ticker || 'SPY').toUpperCase();
  var direction = (req.query.direction || 'CALLS').toUpperCase();
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    var result = await regimeGate.canEnter(ticker, direction, token);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/regime/clear-cache', function(req, res) {
  if (!regimeGate) return res.status(500).json({ error: 'regimeGate not loaded' });
  regimeGate.clearCache();
  res.json({ ok: true, message: 'regime cache cleared' });
});

// -----------------------------------------------------------------
// IV FILTER — implied volatility gate diagnostics
// -----------------------------------------------------------------
var ivFilter = null;
try { ivFilter = require('./ivFilter'); console.log('[SERVER] ivFilter loaded OK'); }
catch(e) { console.log('[SERVER] ivFilter not loaded:', e.message); }

app.get('/api/iv', function(req, res) {
  if (!ivFilter) return res.status(500).json({ error: 'ivFilter not loaded' });
  res.json(ivFilter.getState());
});

app.get('/api/iv/check', async function(req, res) {
  if (!ivFilter) return res.status(500).json({ error: 'ivFilter not loaded' });
  var ticker = (req.query.ticker || 'SPY').toUpperCase();
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    var result = await ivFilter.checkIV(ticker, token, req.query.contract || null);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/iv/clear-cache', function(req, res) {
  if (!ivFilter) return res.status(500).json({ error: 'ivFilter not loaded' });
  ivFilter.clearCache();
  res.json({ ok: true, message: 'IV cache cleared' });
});

// -----------------------------------------------------------------
// RUNTIME CONFIG — hot-swap watchlists, liquid list, etc. without redeploy
// -----------------------------------------------------------------
var runtimeConfig = null;
try { runtimeConfig = require('./runtimeConfig'); console.log('[SERVER] runtimeConfig loaded OK'); }
catch(e) { console.log('[SERVER] runtimeConfig not loaded:', e.message); }

app.get('/api/config', function(req, res) {
  if (!runtimeConfig) return res.json({});
  res.json(runtimeConfig.getAll());
});
app.post('/api/config', function(req, res) {
  if (!runtimeConfig) return res.status(500).json({ error: 'runtimeConfig not loaded' });
  var body = req.body || {};
  if (body.key && body.value !== undefined) {
    res.json(runtimeConfig.set(body.key, body.value));
  } else if (typeof body === 'object' && !body.key) {
    // Bulk set: POST { CASEY_WATCHLIST: '...', STRAT_WATCHLIST: '...' }
    res.json(runtimeConfig.setMany(body));
  } else {
    res.status(400).json({ error: 'need {key, value} or {KEY: val, ...}' });
  }
});
app.post('/api/config/delete', function(req, res) {
  if (!runtimeConfig) return res.status(500).json({ error: 'runtimeConfig not loaded' });
  var body = req.body || {};
  if (body.key) { res.json(runtimeConfig.del(body.key)); }
  else { res.status(400).json({ error: 'need {key}' }); }
});

// -----------------------------------------------------------------
// /arm -- phone-native one-tap arm/kill page (save to home screen)
// -----------------------------------------------------------------
var armPage = null;
try { armPage = require('./armPage'); console.log('[SERVER] armPage loaded OK'); }
catch(e) { console.log('[SERVER] armPage not loaded:', e.message); }
if (armPage) {
  app.get('/arm', armPage.handler);
  app.get('/arm/', armPage.handler);
}

// -----------------------------------------------------------------
// AUTO-FIRE gate API -- the split-mode brain
// A+ setups auto-fire via this gate chain; A setups stage to queue
// for manual approval; B ignored entirely. Flagged OFF by default.
// -----------------------------------------------------------------
var autoFireGate = null;
try { autoFireGate = require('./autoFireGate'); console.log('[SERVER] autoFireGate loaded OK'); }
catch(e) { console.log('[SERVER] autoFireGate not loaded:', e.message); }

app.get('/api/autofire/status', function(req, res) {
  if (!autoFireGate) return res.json({ enabled: false, loaded: false });
  var s = autoFireGate.getState();
  s.loaded = true;
  // Include last FTFC string from spreadScout if available
  try {
    if (spreadScout && spreadScout.lastFtfc) s.ftfc = spreadScout.lastFtfc;
  } catch(e) {}
  res.json(s);
});

app.post('/api/autofire/toggle', function(req, res) {
  if (!autoFireGate) return res.status(500).json({ error: 'autoFireGate not loaded' });
  var on = !!(req.body && req.body.enabled);
  var result = autoFireGate.setEnabled(on);
  console.log('[AUTOFIRE] toggled ->', result);
  res.json({ enabled: result });
});

app.post('/api/autofire/config', function(req, res) {
  if (!autoFireGate) return res.status(500).json({ error: 'autoFireGate not loaded' });
  var body = req.body || {};
  if (Array.isArray(body.allowedGrades)) autoFireGate.setAllowedGrades(body.allowedGrades);
  if (isFinite(body.maxRiskPerTrade))    autoFireGate.setMaxRisk(body.maxRiskPerTrade);
  res.json(autoFireGate.getState());
});

// AUTO-ARM QUEUE cron (v7.5) -- flip queueActive=true at 9:29 AM ET Mon-Fri
// so queued trades fire automatically when the market opens, no manual step.
// Also flips queueActive=false at 4:01 PM to stop stale triggers overnight.
cron.schedule('29 9 * * 1-5', function() {
  if (brainEngine && brainEngine.setQueueActive) {
    brainEngine.setQueueActive(true);
    console.log('[QUEUE-AUTO-ARM] queueActive=true');
  }
}, { timezone: 'America/New_York' });

cron.schedule('1 16 * * 1-5', function() {
  if (brainEngine && brainEngine.setQueueActive) {
    brainEngine.setQueueActive(false);
    console.log('[QUEUE-AUTO-DISARM] queueActive=false');
  }
}, { timezone: 'America/New_York' });

// REMOVED: Legacy close cron that auto-closed SPX spread at open for a loss on Apr 13.
// LESSON: Never auto-close existing spreads at open. Let them run to profit target or expiry.
// The spread monitor (every 5 min) handles exits at 50% profit or 150% stop loss.

// CREDIT SPREAD CRON -- evaluate at 10:00AM ET, monitor every 5 min
cron.schedule('0 10 * * 1-5', async function() {
  console.log('[CRON] 10:00AM -- Credit spread evaluation...');
  if (creditSpreadEngine) {
    try { await creditSpreadEngine.executeFullFlow(); } catch(e) { console.error('[SPREAD]', e.message); }
  }
}, { timezone: 'America/New_York' });

// Monitor open spreads every 5 min during market hours
cron.schedule('*/5 9-16 * * 1-5', async function() {
  if (creditSpreadEngine) {
    try { await creditSpreadEngine.monitorSpreads(); } catch(e) { console.error('[SPREAD-MON]', e.message); }
  }
}, { timezone: 'America/New_York' });

app.post('/api/brain/exitmode', function(req, res) {
  try {
    if (!brainEngine) return res.json({ error: 'Brain engine not loaded' });
    var mode = req.query.mode || req.body.mode || 'STRENGTH';
    var result = brainEngine.setExitMode(mode);
    res.json({ status: 'OK', exitMode: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news', function(req, res) {
  try {
    if (!catalystScanner || !catalystScanner.scanBreakingNews) return res.json({ error: 'News scanner not loaded' });
    catalystScanner.scanBreakingNews().then(function(news) {
      res.json({ status: 'OK', count: news.length, news: news });
    }).catch(function(e) { res.status(500).json({ error: e.message }); });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

console.log('[BRAIN] Cron scheduled: every 60s, 9AM-4PM ET, weekdays');

// -- START ------------------------------------------------------
app.listen(PORT, function() {
  console.log('Flow Scout v8.2 running on port ' + PORT);
  bullflow.startBullflowStream();
  discordBot.startDiscordBot();
});
