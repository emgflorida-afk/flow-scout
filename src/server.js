// server.js — Stratum Flow Scout v7.0
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// RSI(14) + VWAP + FVG parsed from webhook payload
// Dashboard: /dashboard
// Idea Validator: /webhook/idea
// Discord Bot: /interactions
// Flow Clusters: /flow/clusters
// Goal Tracker: /goal
// Finviz Screener: fires 9:15AM ET
// TradeStation Auth: /ts-auth
// —————————————————————–

require(‘dotenv’).config();
const express  = require(‘express’);
const path     = require(‘path’);
const cron     = require(‘node-cron’);
const alerter  = require(’./alerter’);
const resolver = require(’./contractResolver’);
const bullflow = require(’./bullflowStream’);
const dashboard     = require(’./dashboard’);
const ideaValidator = require(’./ideaValidator’);
const { startDiscordBot, handleInteraction } = require(’./discordBot’);
const { getClusterSummary } = require(’./flowCluster’);
const goalTracker = require(’./goalTracker’);
const finviz      = require(’./finvizScreener’);

// TradeStation loaded safely – won’t crash server if it fails
let ts = null;
try {
ts = require(’./tradestation’);
console.log(’[TS] tradestation.js loaded OK’);
} catch (err) {
console.log(’[TS] tradestation.js not available – skipping’);
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(function(req, res, next) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.sendStatus(200);
next();
});

app.get(’/’, function(req, res) {
res.json({ status: ‘Stratum Flow Scout OK’, version: ‘7.0’, time: new Date().toISOString() });
});

// – FLOW SUMMARY + CLUSTERS –––––––––––––––––––
app.get(’/flow/summary’, function(req, res) {
res.json(bullflow.liveAggregator.getSummary());
});

app.get(’/flow/clusters’, function(req, res) {
res.json(getClusterSummary());
});

// – DASHBOARD ––––––––––––––––––––––––––
app.get(’/dashboard’, function(req, res) {
res.sendFile(path.join(process.cwd(), ‘src’, ‘dashboard.html’));
});

app.get(’/dashboard/data’, async function(req, res) {
try {
const mode = (req.query.mode || ‘DAY’).toUpperCase();
const data = await dashboard.getDashboardData(mode);
res.json(data);
} catch (err) {
console.error(’[DASHBOARD] Error:’, err.message);
res.status(500).json({ error: err.message });
}
});

// – DISCORD INTERACTIONS —————————————–
app.post(’/interactions’, async function(req, res) {
try {
console.log(’[INTERACTIONS] Received type:’, req.body && req.body.type);
await handleInteraction(req, res);
} catch (err) {
console.error(’[INTERACTIONS] Error:’, err.message);
if (!res.headersSent) res.status(500).json({ error: err.message });
}
});

// – IDEA VALIDATOR ———————————————–
app.post(’/webhook/idea’, async function(req, res) {
try {
const body = req.body;
const text = body.text || body.content || body.idea || ‘’;
if (!text) return res.status(400).json({ error: ‘Missing text field’ });
const webhookUrl = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
if (!webhookUrl) return res.status(500).json({ error: ‘No conviction webhook configured’ });
console.log(’[IDEA] Received:’, text);
ideaValidator.validateAndPost(text, webhookUrl).catch(console.error);
res.json({ status: ‘processing’, text });
} catch (err) {
console.error(’[IDEA] Error:’, err.message);
res.status(500).json({ error: err.message });
}
});

// – TRADINGVIEW WEBHOOK ——————————————
app.post(’/webhook/tradingview’, async function(req, res) {
try {
const body       = req.body;
console.log(’[WEBHOOK] Received:’, JSON.stringify(body));
const ticker     = (body.ticker     || ‘’).toUpperCase().trim();
const type       = (body.type       || ‘call’).toLowerCase().trim();
const confluence = body.confluence  || ‘0/6’;
const tradeType  = body.tradeType   || ‘SWING’;
const weekly     = body.weekly      || null;
const daily      = body.daily       || null;
const h4         = body.h4          || null;
const h1         = body.h1          || null;
const rsi      = body.rsi      != null ? parseFloat(body.rsi)      : null;
const vwap     = body.vwap     != null ? parseFloat(body.vwap)     : null;
const vwapBias = body.vwapBias != null
? (parseFloat(body.vwapBias) === 1 || body.vwapBias === ‘above’ ? ‘above’ : ‘below’)
: null;
const bearFVGTop    = body.bearFVGTop    != null ? parseFloat(body.bearFVGTop)    : null;
const bearFVGBottom = body.bearFVGBottom != null ? parseFloat(body.bearFVGBottom) : null;
const bullFVGTop    = body.bullFVGTop    != null ? parseFloat(body.bullFVGTop)    : null;
const bullFVGBottom = body.bullFVGBottom != null ? parseFloat(body.bullFVGBottom) : null;

```
if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
const score = parseInt(confluence.split('/')[0]) || 0;
if (score < 5) {
  console.log('[WEBHOOK] ' + ticker + ' confluence ' + confluence + ' -- skipping');
  return res.json({ status: 'skipped', reason: 'Confluence ' + confluence + ' below 5/6' });
}
console.log('[WEBHOOK] ' + ticker + ' ' + confluence + ' ' + tradeType + ' -- PROCESSING OK');
const resolved = await resolver.resolveContract(ticker, type, tradeType);
if (!resolved) {
  console.log('[WEBHOOK] Could not resolve contract for ' + ticker);
  return res.json({ status: 'skipped', reason: 'No contract found' });
}
const tvBias = {
  weekly, daily, h4, h1, confluence,
  mid: resolved.mid, bid: resolved.bid, ask: resolved.ask,
  mode: resolved.mode, dte: resolved.dte,
  rsi, vwap, vwapBias,
  bearFVGTop, bearFVGBottom, bullFVGTop, bullFVGBottom,
  debit: resolved.debit || null, maxProfit: resolved.maxProfit || null,
  breakeven: resolved.breakeven || null, sellStrike: resolved.sellStrike || null,
  spreadWidth: resolved.spreadWidth || null,
};
alerter.sendTradeAlert(resolved.symbol, tvBias, {}, true, resolved).catch(console.error);
res.json({ status: 'processing', ticker, opra: resolved.symbol, mode: resolved.mode, mid: resolved.mid });
```

} catch (err) {
console.error(’[WEBHOOK] Error:’, err.message);
res.status(500).json({ error: err.message });
}
});

// – BULLFLOW WEBHOOK ———————————————
app.post(’/webhook/bullflow’, async function(req, res) {
try {
const body = req.body;
const opra = body.opra || body.symbol || null;
if (!opra) return res.status(400).json({ error: ‘No OPRA symbol’ });
alerter.sendTradeAlert(opra, {}, body, false).catch(console.error);
res.json({ status: ‘processing’, opra });
} catch (err) {
console.error(’[BULLFLOW] Error:’, err.message);
res.status(500).json({ error: err.message });
}
});

// – PRICES —————————————————––
app.get(’/prices’, async function(req, res) {
const ticker = (req.query.ticker || ‘’).toUpperCase().trim();
if (!ticker) return res.status(400).json({ error: ‘Missing ticker’ });
try {
const price = await resolver.getPrice(ticker);
if (!price) return res.status(404).json({ error: ‘No price data’ });
return res.json({ ticker, price, live: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// – FINVIZ SCREENER + MORNING BRIEF — 9:15AM ET ——————
cron.schedule(‘15 13 * * 1-5’, async function() {
console.log(’[CRON] Morning brief + screener…’);
try { await alerter.sendMorningBrief(); } catch (err) { console.error(’[BRIEF] Failed:’, err.message); }
try { await finviz.postScreenerCard(); }  catch (err) { console.error(’[SCREENER] Failed:’, err.message); }
});

app.get(’/test/brief’, async function(req, res) {
try { await alerter.sendMorningBrief(); res.json({ status: ‘Sent OK’ }); }
catch (err) { res.status(500).json({ error: err.message }); }
});

app.get(’/test/screener’, async function(req, res) {
try { await finviz.postScreenerCard(); res.json({ status: ‘Sent OK’ }); }
catch (err) { res.status(500).json({ error: err.message }); }
});

app.get(’/test/bullflow’, function(req, res) {
res.json({ status: ‘Bullflow stream running OK’, version: ‘7.0’ });
});

// – GOAL TRACKER ———————————————––
app.get(’/goal’, function(req, res) {
res.json(goalTracker.getState());
});

app.post(’/goal/trade’, function(req, res) {
const { ticker, pnl } = req.body;
if (!ticker || pnl == null) return res.status(400).json({ error: ‘Missing ticker or pnl’ });
goalTracker.recordTrade(ticker, parseFloat(pnl));
goalTracker.postGoalUpdate().catch(console.error);
res.json(goalTracker.getState());
});

app.get(’/goal/reset’, function(req, res) {
goalTracker.resetIfNewDay();
res.json({ status: ‘reset OK’, state: goalTracker.getState() });
});

cron.schedule(‘30 13 * * 1-5’, function() {
console.log(’[GOAL] Market open – posting daily goal’);
goalTracker.postGoalUpdate().catch(console.error);
});

cron.schedule(‘0 20 * * 1-5’, function() {
console.log(’[GOAL] Market close – posting final P&L’);
goalTracker.postGoalUpdate().catch(console.error);
});

// – TRADESTATION AUTH (only if ts loaded) ————————
app.get(’/ts-auth’, function(req, res) {
if (!ts) return res.send(’<h2>TradeStation module not loaded</h2>’);
res.redirect(ts.getLoginUrl());
});

app.get(’/ts-callback’, async function(req, res) {
if (!ts) return res.send(’<h2>TradeStation module not loaded</h2>’);
const code = req.query.code;
if (!code) return res.send(’<h2>Error: No code received</h2>’);
try {
const data = await ts.exchangeCode(code);
if (data.refresh_token) {
ts.setRefreshToken(data.refresh_token);
console.log(’[TS AUTH] Refresh token obtained OK ✅’);
res.send(
‘<h2>✅ TradeStation Connected!</h2>’ +
‘<p>Add this to Railway as <strong>TS_REFRESH_TOKEN</strong>:</p>’ +
‘<textarea rows="4" cols="80" onclick="this.select()">’ + data.refresh_token + ‘</textarea>’
);
} else {
res.send(’<h2>❌ Auth Failed</h2><pre>’ + JSON.stringify(data, null, 2) + ‘</pre>’);
}
} catch (err) {
res.send(’<h2>Error: ’ + err.message + ‘</h2>’);
}
});

// – START ––––––––––––––––––––––––––––
app.listen(PORT, function() {
console.log(‘Flow Scout v7.0 running on port ’ + PORT);
console.log(’   Bullflow stream + Discord bot + Goal tracker + Finviz screener’);
bullflow.startBullflowStream();
startDiscordBot();
});
startDiscordBot();
});
