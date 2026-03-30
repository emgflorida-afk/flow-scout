// server.js - Stratum Flow Scout v7.2
// Complete final version with all modules + AYCE pre-market scanner

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

try { goalTracker      = require('./goalTracker');      console.log('[GOAL] Loaded OK');    } catch(e) { console.log('[GOAL] Skipped:', e.message); }
try { finviz           = require('./finvizScreener');   console.log('[FINVIZ] Loaded OK');  } catch(e) { console.log('[FINVIZ] Skipped:', e.message); }
try { capitol          = require('./capitolTrades');    console.log('[CAPITOL] Loaded OK'); } catch(e) { console.log('[CAPITOL] Skipped:', e.message); }
try { ts               = require('./tradestation');     console.log('[TS] Loaded OK');      } catch(e) { console.log('[TS] Skipped:', e.message); }
try { preMarketScanner = require('./preMarketScanner'); console.log('[SCANNER] Loaded OK'); } catch(e) { console.log('[SCANNER] Skipped:', e.message); }

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

// -- ROUTES -------------------------------------------------------

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
    var text = req.body.text || req.body.content || req.body.idea || '';
    if (!text) return res.status(400).json({ error: 'Missing text' });
    var webhookUrl = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
    ideaValidator.validateAndPost(text, webhookUrl).catch(console.error);
    res.json({ status: 'processing', text: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/tradingview', async function(req, res) {
  try {
    var body      = req.body;
    var ticker    = (body.ticker || '').toUpperCase().trim();
    var type      = (body.type   || 'call').toLowerCase().trim();
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

app.get('/prices', async function(req, res) {
  var ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
  try {
    var price = await resolver.getPrice(ticker);
    if (!price) return res.status(404).json({ error: 'No price' });
    res.json({ ticker: ticker, price: price, live: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- GOAL TRACKER -------------------------------------------------
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

// -- TRADESTATION AUTH --------------------------------------------
app.get('/ts-auth', function(req, res) {
  if (!ts) return res.send('<h2>TradeStation module not loaded. Upload tradestation.js to src/ folder.</h2>');
  console.log('[TS AUTH] Redirecting to TradeStation login...');
  res.redirect(ts.getLoginUrl());
});

app.get('/ts-callback', async function(req, res) {
  if (!ts) return res.send('<h2>TradeStation module not loaded</h2>');
  var code = req.query.code;
  if (!code) return res.send('<h2>Error: No code received from TradeStation</h2>');
  try {
    console.log('[TS AUTH] Exchanging code for tokens...');
    var data = await ts.exchangeCode(code);
    if (data.refresh_token) {
      ts.setRefreshToken(data.refresh_token);
      console.log('[TS AUTH] Success - refresh token obtained');
      res.send(
        '<h2>TradeStation Connected!</h2>' +
        '<p>Copy this refresh token and add to Railway as <strong>TS_REFRESH_TOKEN</strong>:</p>' +
        '<textarea rows=4 cols=80 onclick=this.select()>' + data.refresh_token + '</textarea>' +
        '<br><br><p>Done! Token auto-refreshes every 20 minutes.</p>'
      );
    } else {
      res.send('<h2>Auth Failed</h2><pre>' + JSON.stringify(data, null, 2) + '</pre>');
    }
  } catch(e) { res.send('<h2>Error: ' + e.message + '</h2>'); }
});

// -- TEST ROUTES --------------------------------------------------
app.get('/test/brief',    async function(req, res) { try { await alerter.sendMorningBrief(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/screener', async function(req, res) { if (!finviz) return res.json({ status: 'Finviz not loaded' }); try { await finviz.postScreenerCard(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/scanner',  async function(req, res) { if (!preMarketScanner) return res.json({ status: 'Scanner not loaded' }); try { await preMarketScanner.runPreMarketScan(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/322',      async function(req, res) { if (!preMarketScanner) return res.json({ status: 'Scanner not loaded' }); try { await preMarketScanner.run322Scan(); res.json({ status: 'OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/test/bullflow', function(req, res) { res.json({ status: 'Bullflow running OK', version: '7.2' }); });

// -- CRONS --------------------------------------------------------

// 9:15AM ET -- morning brief + screener + goal + capitol + AYCE pre-market scan
cron.schedule('15 13 * * 1-5', async function() {
  console.log('[CRON] 9:15AM -- morning brief + pre-market scan...');
  try { await alerter.sendMorningBrief(); } catch(e) { console.error('[BRIEF]', e.message); }
  if (finviz)           { try { await finviz.postScreenerCard();          } catch(e) { console.error('[FINVIZ]', e.message); } }
  if (goalTracker)      { try { await goalTracker.postGoalUpdate();        } catch(e) { console.error('[GOAL]', e.message); } }
  if (capitol)          { try { await capitol.fetchCongressTrades();       } catch(e) { console.error('[CAPITOL]', e.message); } }
  if (preMarketScanner) { try { await preMarketScanner.runPreMarketScan(); } catch(e) { console.error('[SCANNER]', e.message); } }
});

// 9:30AM ET -- market open goal post
cron.schedule('30 13 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
});

// 10:00AM ET -- 3-2-2 First Live scan (after 9AM candle closes)
cron.schedule('0 14 * * 1-5', async function() {
  console.log('[CRON] 10:00AM -- 3-2-2 scan...');
  if (preMarketScanner) { try { await preMarketScanner.run322Scan(); } catch(e) { console.error('[322]', e.message); } }
});

// 4:00PM ET -- end of day goal post
cron.schedule('0 20 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
});

// -- START --------------------------------------------------------
app.listen(PORT, function() {
  console.log('Flow Scout v7.2 running on port ' + PORT);
  bullflow.startBullflowStream();
  discordBot.startDiscordBot();
});