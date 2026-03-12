// server.js — Stratum Flow Scout
// Fixed: Real contracts, watchlist filter, premium filter, calendar
// Updated: Morning brief now self-contained in alerter.js
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const fetch    = require('node-fetch');
const alerter  = require('./alerter');
const resolver = require('./contractResolver');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'Stratum Flow Scout ✅',
    version: '5.1',
    time:    new Date().toISOString(),
  });
});

// ── TRADINGVIEW WEBHOOK ───────────────────────────────────────────
// Pine Script sends alerts here
// Expected body: { ticker, action, weekly, daily, h4, opra }
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

    if (!opra && !ticker) {
      return res.status(400).json({ error: 'Missing opra or ticker' });
    }

    const opraSymbol = opra || buildFallbackOPRA(ticker, action);

    if (!resolver.WATCHLIST.has(ticker) && ticker) {
      console.log(`[WEBHOOK] ${ticker} not on watchlist — skipping`);
      return res.json({ status: 'skipped', reason: 'Not on watchlist' });
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

// ── FALLBACK OPRA BUILDER ─────────────────────────────────────────
function buildFallbackOPRA(ticker, action) {
  const type = action === 'BUY' ? 'C' : 'P';

  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));

  const yy = String(expiry.getFullYear()).slice(-2);
  const mm = String(expiry.getMonth() + 1).padStart(2, '0');
  const dd = String(expiry.getDate()).padStart(2, '0');
  const dateStr = `${yy}${mm}${dd}`;

  return `O:${ticker}${dateStr}${type}00000000`;
}

// ── MORNING BRIEF CRON ────────────────────────────────────────────
// 9:15AM ET = 13:15 UTC (Railway runs UTC)
cron.schedule('15 13 * * 1-5', async () => {
  console.log('[CRON] Firing morning brief...');
  try {
    await alerter.sendMorningBrief();
  } catch (err) {
    console.error('[CRON] Morning brief failed:', err.message);
  }
});

// ── MANUAL TRIGGER (for testing) ─────────────────────────────────
// Hit this endpoint to fire the morning brief on demand
// DELETE after testing if you want
app.get('/test/brief', async (req, res) => {
  try {
    await alerter.sendMorningBrief();
    res.json({ status: 'Morning brief sent ✅' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Flow Scout v5.1 running on port ${PORT}`);
  console.log(`   Watchlist: ${[...resolver.WATCHLIST].join(', ')}`);
  console.log(`   Premium range: $${resolver.MIN_PREMIUM}–$${resolver.MAX_PREMIUM}`);
});
