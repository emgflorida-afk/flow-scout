// bullflowStream.js — Stratum Flow Scout
// Connects to Bullflow SSE stream and fires trade alerts
// on high conviction flow only (SigScore via alertName mapping)
// ─────────────────────────────────────────────────────────────────

const fetch   = require('node-fetch');
const alerter = require('./alerter');
const resolver = require('./contractResolver');

// ── ALERT NAME → CONVICTION MAPPING ──────────────────────────────
// Bullflow algo alert names and their conviction level
const HIGH_CONVICTION_ALERTS = [
  'Urgent Repeater',
  'Sizable Sweep',
  'Whale Alert',
  'Large Block',
  'Unusual Sweep',
  'Giant Sweep',
];

function isHighConviction(alertName, alertPremium) {
  const nameMatch = HIGH_CONVICTION_ALERTS.some(name =>
    (alertName || '').toLowerCase().includes(name.toLowerCase())
  );
  // Also pass if premium is $100K+ regardless of name
  const premiumMatch = parseFloat(alertPremium || 0) >= 100000;
  return nameMatch || premiumMatch;
}

// ── PARSE OPRA SYMBOL ─────────────────────────────────────────────
// O:AMD251205P00205000 → { ticker, expiry, type, strike }
function parseOPRA(symbol) {
  try {
    const clean = symbol.replace('O:', '');
    const match = clean.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, date, typeChar, strikePadded] = match;
    const strike = parseInt(strikePadded) / 1000;
    const yy = date.slice(0, 2);
    const mm = date.slice(2, 4);
    const dd = date.slice(4, 6);
    const expiry = `20${yy}-${mm}-${dd}`;
    const type   = typeChar === 'C' ? 'call' : 'put';
    return { ticker, expiry, type, strike };
  } catch { return null; }
}

// ── MAIN STREAM CONNECTION ────────────────────────────────────────
async function startBullflowStream() {
  const apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) {
    console.error('[BULLFLOW] No API key — stream not started');
    return;
  }

  console.log('[BULLFLOW] Connecting to stream...');

  const connect = async () => {
    try {
      const res = await fetch(
        `https://api.bullflow.io/v1/streaming/alerts?key=${apiKey}`,
        { headers: { Accept: 'text/event-stream' } }
      );

      if (!res.ok) {
        console.error('[BULLFLOW] Stream connection failed:', res.status);
        scheduleReconnect();
        return;
      }

      console.log('[BULLFLOW] Stream connected ✅');

      res.body.on('data', async (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const envelope = JSON.parse(line.slice(6));
            const message  = envelope?.data;
            const event    = message?.event;

            if (event === 'init') {
              console.log('[BULLFLOW] Stream initialized, listening from:', message?.since);
              return;
            }

            if (event === 'heartbeat') return;

            if (event === 'alert') {
              const alert = message?.data;
              if (!alert) return;

              const symbol      = alert.symbol      || '';
              const alertName   = alert.alertName   || '';
              const alertPremium = alert.alertPremium || 0;
              const alertType   = alert.alertType   || '';

              console.log(`[BULLFLOW] Alert: ${symbol} — ${alertName} — $${alertPremium}`);

              // Parse OPRA to get ticker
              const parsed = parseOPRA(symbol);
              if (!parsed) {
                console.log('[BULLFLOW] Could not parse OPRA:', symbol);
                return;
              }

              // Check watchlist
              if (!resolver.WATCHLIST.has(parsed.ticker)) {
                console.log(`[BULLFLOW] ${parsed.ticker} not on watchlist — skipping`);
                return;
              }

              // Check conviction
              if (!isHighConviction(alertName, alertPremium)) {
                console.log(`[BULLFLOW] Low conviction — skipping: ${alertName} $${alertPremium}`);
                return;
              }

              console.log(`[BULLFLOW] HIGH CONVICTION — firing alert: ${symbol}`);

              // Build flow data for conviction display in Discord
              const flowData = {
                sigScore:      alertType === 'algo' ? 0.85 : 0.5,
                orderType:     alertName.toLowerCase().includes('sweep') ? 'SWEEP' : 'BLOCK',
                totalPremium:  alertPremium,
              };

              // Fire trade alert
              alerter.sendTradeAlert(symbol, {}, flowData).catch(console.error);
            }

            if (event === 'error' || event === 'cancelled') {
              console.error('[BULLFLOW] Stream error/cancelled — reconnecting...');
              scheduleReconnect();
            }

          } catch (parseErr) {
            // Skip malformed lines
          }
        }
      });

      res.body.on('error', (err) => {
        console.error('[BULLFLOW] Stream error:', err.message);
        scheduleReconnect();
      });

      res.body.on('end', () => {
        console.log('[BULLFLOW] Stream ended — reconnecting...');
        scheduleReconnect();
      });

    } catch (err) {
      console.error('[BULLFLOW] Connection error:', err.message);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    console.log('[BULLFLOW] Reconnecting in 10 seconds...');
    setTimeout(connect, 10000);
  };

  connect();
}

module.exports = { startBullflowStream };
