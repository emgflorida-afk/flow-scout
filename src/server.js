// server.js - Stratum Flow Scout v7.2
// Complete final -- all modules + AYCE scanner + smart stops + position offset analyzer

require('dotenv').config();
var express  = require('express');
var path     = require('path');
var cron     = require('node-cron');
var alerter  = require('./alerter');
var resolver = require('./contractResolver');
var bullflow = require('./bullflowStream');
var dashboard     = require('./dashboard');
var ideaValidator = require('./ideaValidator');
var discordBot    = require('./discordBot');
var flowCluster   = require('./flowCluster');

var goalTracker      = null;
var finviz           = null;
var capitol          = null;
var ts               = null;
var preMarketScanner = null;
var smartStops       = null;
var econCalendar     = null;
var preMarketReport  = null;
var positionOffset   = null;

try { goalTracker      = require('./goalTracker');      console.log('[GOAL] Loaded OK');    } catch(e) { console.log('[GOAL] Skipped:', e.message); }
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

var cancelManager = null;
try { cancelManager = require('./cancelManager'); console.log('[CANCEL-MGR] Loaded OK'); } catch(e) { console.log('[CANCEL-MGR] Skipped:', e.message); }

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
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', function(req, res) {
  res.json({ status: 'Stratum Flow Scout OK', version: '7.2', time: new Date().toISOString() });
});

app.get('/flow/summary',  function(req, res) { res.json(bullflow.liveAggregator.getSummary()); });
app.get('/flow/clusters', function(req, res) { res.json(flowCluster.getClusterSummary()); });

app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'dashboard.html'));
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
    var score = parseInt(confluence.split('/')[0]) || 0;
    if (score < 3) return res.json({ status: 'skipped', reason: 'Below 3/6' });
    var resolved = await resolver.resolveContract(ticker, type, tradeType);
    if (!resolved) return res.json({ status: 'skipped', reason: 'No contract' });
    var tvBias = {
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
    res.json({ status: 'processing', ticker: ticker, opra: resolved.symbol });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  res.json(goalTracker.getState());
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
  if (!code) return res.send('<h2>Error: No code received</h2>');
  try {
    var data = await ts.exchangeCode(code);
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
});

// 12:00AM ET -- reset daily execute-now counter
cron.schedule('0 4 * * 1-5', function() {
  if (executeNow) executeNow.resetDailySetups();
  console.log('[EXECUTE-NOW] Daily reset at midnight');
});

// 4:00AM ET -- AYCE pre-market scan (catches overnight 12HR Miyagi setups)
cron.schedule('0 8 * * 1-5', async function() {
  console.log('[CRON] 4:00AM -- AYCE pre-market scan...');
  if (preMarketScanner) {
    try { await preMarketScanner.runPreMarketScan(); } catch(e) { console.error('[SCANNER]', e.message); }
  }
});

// 7:30AM ET -- AUTONOMOUS MORNING ROUTINE
// Pulls live positions, sets 6HR bias, resets goal, posts brief
// Zero manual steps needed
cron.schedule('30 11 * * 1-5', async function() {
  console.log('[CRON] 7:30AM -- Auto morning routine...');
  if (autoMorning) {
    try { await autoMorning.runAutoMorning(); } catch(e) { console.error('[AUTO-MORNING]', e.message); }
  }
});

// 8:00AM ET -- pre-market report
cron.schedule('0 12 * * 1-5', async function() {
  console.log('[CRON] 8:00AM -- pre-market report...');
  if (preMarketReport) { try { await preMarketReport.postPreMarketReport(); } catch(e) { console.error('[PMR]', e.message); } }
  if (econCalendar)    { try { await econCalendar.postDailyBrief();         } catch(e) { console.error('[CAL]', e.message); } }
});

// 9:15AM ET -- morning brief + screener + goal + capitol + AYCE scan + OFFSET ANALYZER
cron.schedule('15 13 * * 1-5', async function() {
  console.log('[CRON] 9:15AM -- morning brief + pre-market scan + offset analysis...');
  try { await alerter.sendMorningBrief(); } catch(e) { console.error('[BRIEF]', e.message); }
  if (positionOffset)   { try { await positionOffset.runOffsetAnalysis();      } catch(e) { console.error('[OFFSET]', e.message); } }
  if (finviz)           { try { await finviz.postScreenerCard();                } catch(e) { console.error('[FINVIZ]', e.message); } }
  if (goalTracker)      { try { await goalTracker.postGoalUpdate();             } catch(e) { console.error('[GOAL]', e.message); } }
  if (capitol)          { try { await capitol.fetchCongressTrades();            } catch(e) { console.error('[CAPITOL]', e.message); } }
  if (preMarketScanner) { try { await preMarketScanner.runPreMarketScan();      } catch(e) { console.error('[SCANNER]', e.message); } }
  if (econCalendar)     { try { await econCalendar.postDailyBrief();            } catch(e) { console.error('[CAL]', e.message); } }
});

// 9:30AM ET -- market open goal post
cron.schedule('30 13 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
});

// Every 30 min during market hours -- check for breaking geopolitical news
cron.schedule('*/30 13-20 * * 1-5', async function() {
  if (econCalendar) { try { await econCalendar.checkBreakingNews(); } catch(e) { console.error('[CAL]', e.message); } }
});

// 10:00AM ET -- 3-2-2 First Live scan
cron.schedule('0 14 * * 1-5', async function() {
  console.log('[CRON] 10:00AM -- 3-2-2 scan...');
  if (preMarketScanner) { try { await preMarketScanner.run322Scan(); } catch(e) { console.error('[322]', e.message); } }
});

// 4:00PM ET -- AUTONOMOUS EOD JOURNAL
// Pulls live P&L, positions, orders from TradeStation
// Posts full journal to Discord -- zero manual steps
cron.schedule('0 20 * * 1-5', async function() {
  console.log('[CRON] 4:00PM -- Auto EOD journal...');
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
  if (autoJournal) {
    try { await autoJournal.writeAutoJournal(); } catch(e) { console.error('[AUTO-JOURNAL]', e.message); }
  } else if (tradingJournal) {
    try { await tradingJournal.writeJournal({}); } catch(e) { console.error('[JOURNAL]', e.message); }
  }
});

// -- START ------------------------------------------------------
app.listen(PORT, function() {
  console.log('Flow Scout v7.2 running on port ' + PORT);
  bullflow.startBullflowStream();
  discordBot.startDiscordBot();
});
