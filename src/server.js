// server.js — Stratum Flow Scout v5.8
// TWO MODE SYSTEM: DAY and SWING
// tradeType from Pine Script determines mode
// All tickers — no watchlist filter — 5/6+ confluence only
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const fetch    = require('node-fetch');
const alerter  = require('./alerter');
const resolver = require('./contractResolver');
const bullflow = require('./bullflowStream');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Stratum Flow Scout ✅', version: '5.8', time: new Date().toISOString() });
});

// ── FLOW SUMMARY ──────────────────────────────────────────────────
app.get('/flow/summary', (req, res) => {
  res.json(bullflow.liveAggregator.getSummary());
});

// ── TRADINGVIEW WEBHOOK ───────────────────────────────────────────
app.post('/webhook/tradingview', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WEBHOOK] Received:', JSON.stringify(body));

    const ticker     = (body.ticker     || '').toUpperCase().trim();
    const type       = (body.type       || 'call').toLowerCase().trim();
    const confluence = body.confluence  || '0/6';
    const tradeType  = body.tradeType   || 'SWING';
    const weekly     = body.weekly      || null;
    const daily      = body.daily       || null;
    const h4         = body.h4          || null;
    const h1         = body.h1          || null;

    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

    // Only fire on 5/6 or 6/6
    const score = parseInt(confluence.split('/')[0]) || 0;
    if (score < 5) {
      console.log(`[WEBHOOK] ${ticker} confluence ${confluence} — skipping`);
      return res.json({ status: 'skipped', reason: `Confluence ${confluence} below 5/6` });
    }

    console.log(`[WEBHOOK] ${ticker} ${confluence} ${tradeType} — PROCESSING ✅`);

    // resolveContract uses tradeType to determine DAY vs SWING mode
    const resolved = await resolver.resolveContract(ticker, type, tradeType);
    if (!resolved) {
      console.log(`[WEBHOOK] Could not resolve contract for ${ticker}`);
      return res.json({ status: 'skipped', reason: 'No contract found' });
    }

    const tvBias = {
      weekly,
      daily,
      h4,
      h1,
      confluence,
      mid:   resolved.mid,
      bid:   resolved.bid,
      ask:   resolved.ask,
      mode:  resolved.mode,
      dte:   resolved.dte,
    };

    alerter.sendTradeAlert(resolved.symbol, tvBias, {}, true).catch(console.error);
    res.json({ status: 'processing', ticker, opra: resolved.symbol, mode: resolved.mode, mid: resolved.mid });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BULLFLOW WEBHOOK ──────────────────────────────────────────────
app.post('/webhook/bullflow', async (req, res) => {
  try {
    const body = req.body;
    const opra = body.opra || body.symbol || null;
    if (!opra) return res.status(400).json({ error: 'No OPRA symbol' });
    alerter.sendTradeAlert(opra, {}, body, false).catch(console.error);
    res.json({ status: 'processing', opra });
  } catch (err) {
    console.error('[BULLFLOW] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PRICES ENDPOINT ───────────────────────────────────────────────
app.get('/prices', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
  try {
    const price = await resolver.getPrice(ticker);
    if (!price) return res.status(404).json({ error: 'No price data' });
    return res.json({ ticker, price, live: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MORNING BRIEF CRON — 9:15AM ET ───────────────────────────────
cron.schedule('15 13 * * 1-5', async () => {
  console.log('[CRON] Firing morning brief...');
  try { await alerter.sendMorningBrief(); }
  catch (err) { console.error('[CRON] Failed:', err.message); }
});

// ── TEST ENDPOINTS ────────────────────────────────────────────────
app.get('/test/brief', async (req, res) => {
  try { await alerter.sendMorningBrief(); res.json({ status: 'Morning brief sent ✅' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test/bullflow', async (req, res) => {
  res.json({ status: 'Bullflow stream running ✅', version: '5.8', time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Flow Scout v5.8 running on port ${PORT}`);
  console.log(`   All tickers — no watchlist filter`);
  console.log(`   5/6+ confluence only`);
  console.log(`   DAY mode:   0-1DTE  $0.30–$1.50`);
  console.log(`   SWING mode: 5-7DTE  $0.50–$3.00`);
  bullflow.startBullflowStream();
});
