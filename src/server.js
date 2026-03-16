// server.js — Stratum Flow Scout
// Fixed: Real contracts, watchlist filter, premium filter, calendar
// Updated: Morning brief now self-contained in alerter.js
// Updated: buildFallbackOPRA now uses Polygon ATM contract lookup
// Updated: Bullflow SSE stream connected on startup
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express   = require('express');
const cron      = require('node-cron');
const fetch     = require('node-fetch');
const alerter   = require('./alerter');
const resolver  = require('./contractResolver');
const bullflow  = require('./bullflowStream');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'Stratum Flow Scout ✅',
    version: '5.3',
    time:    new Date().toISOString(),
  });
});

// ── TRADINGVIEW WEBHOOK ───────────────────────────────────────────
app.post('/webhook/tradingview', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WEBHOOK] Received:', JSON.stringify(body));

    const ticker  = (body.ticker  || '').toUpperCase().trim();
    const action  = (body.action  || '').toUpperCase().trim();
    const weekly  = body.weekly  || null;
    const daily   = body.daily   || null;
    const h4      = body.h4      || null;
    const opra    = body.opra    || null;

    if (!ticker) {
      return res.status(400).json({ error: 'Missing ticker' });
    }

    if (!resolver.WATCHLIST.has(ticker)) {
      console.log(`[WEBHOOK] ${ticker} not on watchlist — skipping`);
      return res.json({ status: 'skipped', reason: 'Not on watchlist' });
    }

    const opraSymbol = opra || await buildFallbackOPRA(ticker, action);

    if (!opraSymbol) {
      console.log(`[WEBHOOK] Could not resolve contract for ${ticker} — skipping`);
      return res.json({ status: 'skipped', reason: 'Could not resolve contract' });
    }

    const tvBias = { weekly, daily, h4 };
    alerter.sendTradeAlert(opraSymbol, tvBias).catch(console.error);

    res.json({ status: 'processing', ticker, opra: opraSymbol });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BULLFLOW WEBHOOK ──────────────────────────────────────────────
app.post('/webhook/bullflow', async (req, res) => {
  try {
    const body = req.body;
    console.log('[BULLFLOW] Received:', JSON.stringify(body));

    const opra   = body.opra   || body.symbol || null;
    const ticker = body.ticker || (opra ? resolver.parseOPRA(opra)?.ticker : null);

    if (!opra) {
      return res.status(400).json({ error: 'No OPRA symbol in payload' });
    }

    if (ticker && !resolver.WATCHLIST.has(ticker.toUpperCase())) {
      console.log(`[BULLFLOW] ${ticker} not on watchlist — skipping`);
      return res.json({ status: 'skipped', reason: 'Not on watchlist' });
    }

    alerter.sendTradeAlert(opra, {}).catch(console.error);
    res.json({ status: 'processing', opra });
  } catch (err) {
    console.error('[BULLFLOW] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FALLBACK OPRA BUILDER (Polygon ATM Lookup) ────────────────────
async function buildFallbackOPRA(ticker, action) {
  const type = (action === 'BUY') ? 'call' : 'put';

  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));
  const expDate = expiry.toISOString().slice(0, 10);

  try {
    // Step 1 — get current stock price
    const priceRes  = await fetch(
      `https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${process.env.POLYGON_API_KEY}`
    );
    const priceData = await priceRes.json();
    const price     = priceData?.results?.p;
    if (!price) throw new Error(`No price for ${ticker}`);
    console.log(`[OPRA] ${ticker} current price: $${price}`);

    // Step 2 — fetch ATM contracts from Polygon
    const chainRes  = await fetch(
      `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expDate}&limit=10&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const chainData = await chainRes.json();
    const contracts = chainData?.results || [];

    if (!contracts.length) throw new Error(`No ${type} contracts found for ${ticker} exp ${expDate}`);

    // Step 3 — pick closest strike to current price
    const best = contracts.reduce((a, b) =>
      Math.abs(a.strike_price - price) < Math.abs(b.strike_price - price) ? a : b
    );

    console.log(`[OPRA] Resolved: ${best.ticker} (strike $${best.strike_price})`);
    return best.ticker;

  } catch (err) {
    console.error('[OPRA] Fallback failed:', err.message);
    return null;
  }
}

// ── MORNING BRIEF CRON ────────────────────────────────────────────
// 9:15AM ET = 13:15 UTC
cron.schedule('15 13 * * 1-5', async () => {
  console.log('[CRON] Firing morning brief...');
  try {
    await alerter.sendMorningBrief();
  } catch (err) {
    console.error('[CRON] Morning brief failed:', err.message);
  }
});

// ── MANUAL TEST ENDPOINTS ─────────────────────────────────────────
app.get('/test/brief', async (req, res) => {
  try {
    await alerter.sendMorningBrief();
    res.json({ status: 'Morning brief sent ✅' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test/bullflow', async (req, res) => {
  res.json({
    status:  'Bullflow stream running ✅',
    ve
