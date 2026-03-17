// server.js — Stratum Flow Scout v5.6
// Fixed: OPRA strike price filter — ATM only, no deep OTM strikes
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
  res.json({
    status:  'Stratum Flow Scout ✅',
    version: '5.6',
    time:    new Date().toISOString(),
  });
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

// ── FALLBACK OPRA BUILDER — ATM ONLY ─────────────────────────────
async function buildFallbackOPRA(ticker, action) {
  const type = (action === 'BUY') ? 'call' : 'put';

  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));
  const expDate = expiry.toISOString().slice(0, 10);

  try {
    // Step 1 — get price via prev close
    const priceRes  = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const priceData = await priceRes.json();
    const price     = priceData?.results?.[0]?.c;
    if (!price) throw new Error(`No price for ${ticker}`);
    console.log(`[OPRA] ${ticker} prev close: $${price}`);

    // Step 2 — fetch ATM contracts only (within 10% of price)
    const lo = (price * 0.90).toFixed(0);
    const hi = (price * 1.10).toFixed(0);

    const chainRes  = await fetch(
      `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const chainData = await chainRes.json();
    const contracts = chainData?.results || [];

    if (!contracts.length) {
      // Fallback — try next expiry if this week has nothing
      const nextExpiry = new Date(expiry);
      nextExpiry.setDate(nextExpiry.getDate() + 7);
      const nextExpDate = nextExpiry.toISOString().slice(0, 10);

      const chainRes2  = await fetch(
        `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${nextExpDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${process.env.POLYGON_API_KEY}`
      );
      const chainData2 = await chainRes2.json();
      const contracts2 = chainData2?.results || [];

      if (!contracts2.length) throw new Error(`No ATM ${type} contracts found for ${ticker}`);

      const best2 = contracts2.reduce((a, b) =>
        Math.abs(a.strike_price - price) < Math.abs(b.strike_price - price) ? a : b
      );
      console.log(`[OPRA] Resolved (next expiry): ${best2.ticker} (strike $${best2.strike_price})`);
      return best2.ticker;
    }

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
    version: '5.6',
    time:    new Date().toISOString(),
  });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Flow Scout v5.6 running on port ${PORT}`);
  console.log(`   Watchlist: ${[...resolver.WATCHLIST].join(', ')}`);
  console.log(`   Premium range: $${resolver.MIN_PREMIUM}–$${resolver.MAX_PREMIUM}`);
  bullflow.startBullflowStream();
});
```

---

## 📋 3 Steps

**①** GitHub → `src/server.js` → pencil ✏️ → select all → paste → **Commit**
**②** Watch Railway logs for:
```
✅ Flow Scout v5.6 running on port 8080
[OPRA] GUSH prev close: $37.46
[OPRA] Resolved: O:GUSH260320C00037000 (strike $37)
[DISCORD] Sent ✅
