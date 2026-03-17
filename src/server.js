// server.js — Stratum Flow Scout v5.7
// 3 Discord channels — strat, flow, conviction
// Added: /prices endpoint — Public.com live, Polygon fallback
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
  res.json({ status: 'Stratum Flow Scout ✅', version: '5.7', time: new Date().toISOString() });
});

// ── FLOW SUMMARY ──────────────────────────────────────────────────
app.get('/flow/summary', (req, res) => {
  res.json(bullflow.liveAggregator.getSummary());
});

// ── PRICES — Public.com live, Polygon fallback ────────────────────
app.get('/prices', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

  try {
    const apiKey    = process.env.PUBLIC_API_KEY;
    const accountId = process.env.PUBLIC_ACCOUNT_ID;

    if (apiKey && accountId) {
      const pubRes  = await fetch(
        `https://api.public.com/userapigateway/marketdata/${accountId}/quotes`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body:    JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
        }
      );
      const pubData = await pubRes.json();
      const quote   = pubData?.quotes?.[0];
      if (quote && quote.outcome === 'SUCCESS') {
        const price = parseFloat(quote.last);
        const bid   = parseFloat(quote.bid || quote.last);
        const ask   = parseFloat(quote.ask || quote.last);
        return res.json({ ticker, price, bid, ask, live: true, source: 'public' });
      }
    }

    // Polygon fallback
    const prevRes  = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${process.env.POLYGON_API_KEY}`);
    const prevData = await prevRes.json();
    const prev     = prevData?.results?.[0]?.c;
    if (!prev) return res.status(404).json({ error: 'No price data' });

    return res.json({ ticker, price: prev, prevClose: prev, live: false, source: 'polygon' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRADINGVIEW WEBHOOK → #strat-alerts ──────────────────────────
app.post('/webhook/tradingview', async (req, res) => {
  try {
    const body   = req.body;
    console.log('[WEBHOOK] Received:', JSON.stringify(body));

    const ticker = (body.ticker || '').toUpperCase().trim();
    const action = (body.action || body.type || '').toUpperCase().trim();
    const weekly = body.weekly || null;
    const daily  = body.daily  || null;
    const h4     = body.h4     || null;
    const opra   = body.opra   || null;

    if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

    if (!resolver.WATCHLIST.has(ticker)) {
      console.log(`[WEBHOOK] ${ticker} not on watchlist — skipping`);
      return res.json({ status: 'skipped', reason: 'Not on watchlist' });
    }

    const opraSymbol = opra || await buildFallbackOPRA(ticker, action);
    if (!opraSymbol) {
      console.log(`[WEBHOOK] Could not resolve contract for ${ticker}`);
      return res.json({ status: 'skipped', reason: 'Could not resolve contract' });
    }

    const tvBias = { weekly, daily, h4 };
    alerter.sendTradeAlert(opraSymbol, tvBias, {}, true).catch(console.error);
    res.json({ status: 'processing', ticker, opra: opraSymbol });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BULLFLOW WEBHOOK → #flow-alerts ──────────────────────────────
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

// ── FALLBACK OPRA BUILDER ─────────────────────────────────────────
async function buildFallbackOPRA(ticker, action) {
  const type = (action === 'BUY' || action === 'CALL') ? 'call'
             : (action === 'SELL' || action === 'PUT') ? 'put'
             : 'call';

  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));
  const expDate = expiry.toISOString().slice(0, 10);

  try {
    const priceRes  = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${process.env.POLYGON_API_KEY}`);
    const priceData = await priceRes.json();
    const price     = priceData?.results?.[0]?.c;
    if (!price) throw new Error(`No price for ${ticker}`);
    console.log(`[OPRA] ${ticker} prev close: $${price}`);

    const lo = (price * 0.90).toFixed(0);
    const hi = (price * 1.10).toFixed(0);

    let chainRes  = await fetch(`https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${process.env.POLYGON_API_KEY}`);
    let chainData = await chainRes.json();
    let contracts = chainData?.results || [];

    if (!contracts.length) {
      const nextExpiry  = new Date(expiry);
      nextExpiry.setDate(nextExpiry.getDate() + 7);
      const nextExpDate = nextExpiry.toISOString().slice(0, 10);
      chainRes  = await fetch(`https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${nextExpDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${process.env.POLYGON_API_KEY}`);
      chainData = await chainRes.json();
      contracts = chainData?.results || [];
      if (!contracts.length) throw new Error(`No ATM ${type} contracts for ${ticker}`);
    }

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
  try { await alerter.sendMorningBrief(); }
  catch (err) { console.error('[CRON] Failed:', err.message); }
});

// ── TEST ENDPOINTS ────────────────────────────────────────────────
app.get('/test/brief', async (req, res) => {
  try { await alerter.sendMorningBrief(); res.json({ status: 'Morning brief sent ✅' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test/bullflow', async (req, res) => {
  res.json({ status: 'Bullflow stream running ✅', version: '5.7', time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Flow Scout v5.7 running on port ${PORT}`);
  console.log(`   Watchlist: ${[...resolver.WATCHLIST].join(', ')}`);
  console.log(`   Premium range: $${resolver.MIN_PREMIUM}–$${resolver.MAX_PREMIUM}`);
  bullflow.startBullflowStream();
});
