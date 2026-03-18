// server.js — Stratum Flow Scout v5.7
// All tickers — no watchlist filter
// Fixed: Polygon snapshot + prev close for price lookup
// Fixed: Public.com token exchange for live prices
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

// ── PUBLIC.COM TOKEN EXCHANGE ─────────────────────────────────────
async function getPublicAccessToken() {
  try {
    const secret = process.env.PUBLIC_API_KEY;
    if (!secret) { console.log('[PUBLIC] No API key'); return null; }
    const res  = await fetch('https://api.public.com/userapiauthservice/personal/access-tokens', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ validityInMinutes: 30, secret }),
    });
    const data = await res.json();
    const token = data?.accessToken || null;
    if (token) console.log('[PUBLIC] Token obtained ✅');
    else console.log('[PUBLIC] Token failed:', JSON.stringify(data));
    return token;
  } catch (err) {
    console.error('[PUBLIC] Token error:', err.message);
    return null;
  }
}

// ── GET STOCK PRICE — Public first, Polygon fallback ─────────────
async function getStockPrice(ticker) {
  // Try Public.com first
  try {
    const token     = await getPublicAccessToken();
    const accountId = process.env.PUBLIC_ACCOUNT_ID;
    if (token && accountId) {
      const res  = await fetch(
        `https://api.public.com/userapigateway/marketdata/${accountId}/quotes`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body:    JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
        }
      );
      const data  = await res.json();
      const quote = data?.quotes?.[0];
      if (quote?.outcome === 'SUCCESS' && quote.last) {
        const price = parseFloat(quote.last);
        console.log(`[PRICE] ${ticker} $${price} via Public.com ✅`);
        return price;
      }
      console.log(`[PUBLIC] Quote failed for ${ticker}:`, JSON.stringify(quote));
    }
  } catch (err) {
    console.error(`[PUBLIC] Price error for ${ticker}:`, err.message);
  }

  // Try Polygon snapshot
  try {
    const snapRes  = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${process.env.POLYGON_API_KEY}`);
    const snapData = await snapRes.json();
    const price    = snapData?.ticker?.lastTrade?.p
                  || snapData?.ticker?.prevDay?.c
                  || snapData?.ticker?.day?.o
                  || null;
    if (price) {
      console.log(`[PRICE] ${ticker} $${price} via Polygon snapshot ✅`);
      return price;
    }
  } catch (err) {
    console.error(`[POLYGON SNAP] Error for ${ticker}:`, err.message);
  }

  // Try Polygon prev close
  try {
    const prevRes  = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${process.env.POLYGON_API_KEY}`);
    const prevData = await prevRes.json();
    const price    = prevData?.results?.[0]?.c || null;
    if (price) {
      console.log(`[PRICE] ${ticker} $${price} via Polygon prev close ✅`);
      return price;
    }
  } catch (err) {
    console.error(`[POLYGON PREV] Error for ${ticker}:`, err.message);
  }

  console.error(`[PRICE] No price found for ${ticker}`);
  return null;
}

// ── PRICES ENDPOINT ───────────────────────────────────────────────
app.get('/prices', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });
  try {
    const price = await getStockPrice(ticker);
    if (!price) return res.status(404).json({ error: 'No price data' });
    return res.json({ ticker, price, live: true });
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
    const price = await getStockPrice(ticker);
    if (!price) throw new Error(`No price for ${ticker}`);

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
  console.log(`   All tickers — no watchlist filter`);
  console.log(`   Premium range: $${resolver.MIN_PREMIUM}–$${resolver.MAX_PREMIUM}`);
  bullflow.startBullflowStream();
});
