// server.js - Stratum Flow Scout v7.0 EMERGENCY STABLE
// All new modules loaded safely - cannot crash server
// -----------------------------------------------------------------

require('dotenv').config();
const express  = require('express');
const path     = require('path');
const cron     = require('node-cron');
const alerter  = require('./alerter');
const resolver = require('./contractResolver');
const bullflow = require('./bullflowStream');
const dashboard     = require('./dashboard');
const ideaValidator = require('./ideaValidator');
const { startDiscordBot, handleInteraction } = require('./discordBot');
const { getClusterSummary } = require('./flowCluster');

// New modules loaded safely -- if any fail, server still runs
let goalTracker = null;
let finviz = null;
let capitol = null;
try { goalTracker = require('./goalTracker');    console.log('[GOAL] Loaded OK'); } catch(e) { console.log('[GOAL] Skipped:', e.message); }
try { finviz      = require('./finvizScreener'); console.log('[FINVIZ] Loaded OK'); } catch(e) { console.log('[FINVIZ] Skipped:', e.message); }
try { capitol     = require('./capitolTrades');  console.log('[CAPITOL] Loaded OK'); } catch(e) { console.log('[CAPITOL] Skipped:', e.message); }

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', function(req, res) {
  res.json({ status: 'Stratum Flow Scout OK', version: '7.0', time: new Date().toISOString() });
});

app.get('/flow/summary', function(req, res) {
  res.json(bullflow.liveAggregator.getSummary());
});

app.get('/flow/clusters', function(req, res) {
  res.json(getClusterSummary());
});

app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'src', 'dashboard.html'));
});

app.get('/dashboard/data', async function(req, res) {
  try {
    const mode = (req.query.mode || 'DAY').toUpperCase();
    const data = await dashboard.getDashboardData(mode);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/interactions', async function(req, res) {
  try {
    await handleInteraction(req, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/idea', async function(req, res) {
  try {
    const text = req.body.text || req.body.content || req.body.idea || '';
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const webhookUrl = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
    ideaValidator.validateAndPost(text, webhookUrl).catch(console.error);
    res.json({ status: 'processing', text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/tradingview', async function(req, res) {
  try {
    const body      = req.body;
    const ticker    = (body.ticker || '').toUpperCase().trim();
    const type      = (body.type   || 'call').toLowerCase().trim();
    const confluence = body.confluence || '0/6';
    const tradeType  = body.tradeType  || 'SWING';
    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
    const score = parseInt(confluence.split('/')[0]) || 0;
    if (score < 5) return res.json({ status: 'skipped', reason: 'Below 5/6' });
    const resolved = await resolver.resolveContract(ticker, type, tradeType);
    if (!resolved) return res.json({ status: 'skipped', reason: 'No contract' });
    const tvBias = {
      weekly: body.weekly || null, daily: body.daily || null,
      h4: body.h4 || null, h1: body.h1 || null, confluence,
      mid: resolved.mid, bid: resolved.bid, ask: resolved.ask,
      mode: resolved.mode, dte: resolved.dte,
      rsi: body.rsi != null ? parseFloat(body.rsi) : null,
      vwap: body.vwap != null ? parseFloat(body.vwap) : null,
      vwapBias: body.vwapBias || null,
      bearFVGTop: body.bearFVGTop != null ? parseFloat(body.bearFVGTop) : null,
      bearFVGBottom: body.bearFVGBottom != null ? parseFloat(body.bearFVGBottom) : null,
      bullFVGTop: body.bullFVGTop != null ? parseFloat(body.bullFVGTop) : null,
      bullFVGBottom: body.bullFVGBottom != null ? parseFloat(body.bullFVGBottom) : null,
      debit: resolved.debit || null, maxProfit: resolved.maxProfit || null,
      breakeven: resolved.breakeven || null, sellStrike: resolved.sellStrike || null,
      spreadWidth: resolved.spreadWidth || null,
    };
    alerter.sendTradeAlert(resolved.symbol, tvBias, {}, true, resolved).catch(console.error);
    res.json({ status: 'processing', ticker, opra: resolved.symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/bullflow', async function(req, res) {
  try {
    const opra = req.body.opra || req.body.symbol || null;
    if (!opra) return res.status(400).json({ error: 'No OPRA' });
    alerter.sendTradeAlert(opra, {}, req.body, false).catch(console.error);
    res.json({ status: 'processing', opra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/prices', async function(req, res) {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
  try {
    const price = await resolver.getPrice(ticker);
    if (!price) return res.status(404).json({ error: 'No price' });
    return res.json({ ticker, price, live: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Goal tracker endpoints (only if loaded)
app.get('/goal', function(req, res) {
  if (!goalTracker) return res.json({ status: 'Goal tracker not loaded' });
  res.json(goalTracker.getState());
});

app.post('/goal/trade', function(req, res) {
  if (!goalTracker) return res.json({ status: 'Goal tracker not loaded' });
  const { ticker, pnl } = req.body;
  if (!ticker || pnl == null) return res.status(400).json({ error: 'Missing ticker or pnl' });
  goalTracker.recordTrade(ticker, parseFloat(pnl));
  goalTracker.postGoalUpdate().catch(console.error);
  res.json(goalTracker.getState());
});

app.get('/test/screener', async function(req, res) {
  if (!finviz) return res.json({ status: 'Finviz not loaded' });
  try { await finviz.postScreenerCard(); res.json({ status: 'Sent OK' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Morning cron 9:15AM ET
cron.schedule('15 13 * * 1-5', async function() {
  try { await alerter.sendMorningBrief(); } catch(e) {}
  if (finviz)  { try { await finviz.postScreenerCard(); }   catch(e) {} }
  if (capitol) { try { await capitol.postCongressReport(); } catch(e) {} }
  if (goalTracker) { try { await goalTracker.postGoalUpdate(); } catch(e) {} }
});

// Goal at market open 9:30AM
cron.schedule('30 13 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
});

// Goal at market close 4PM
cron.schedule('0 20 * * 1-5', function() {
  if (goalTracker) goalTracker.postGoalUpdate().catch(console.error);
});

app.get('/test/brief', async function(req, res) {
  try { await alerter.sendMorningBrief(); res.json({ status: 'Sent OK' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test/bullflow', function(req, res) {
  res.json({ status: 'Bullflow running OK', version: '7.0' });
});

// START
app.listen(PORT, function() {
  console.log('Flow Scout v7.0 running on port ' + PORT);
  bullflow.startBullflowStream();
  startDiscordBot();
});
