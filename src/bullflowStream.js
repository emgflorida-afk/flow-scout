// bullflowStream.js — Stratum Flow Scout v5.8
// FIXED: All flow goes to #flow-alerts
// Only high conviction goes to #conviction-trades
// ─────────────────────────────────────────────────────────────────

const fetch    = require('node-fetch');
const alerter  = require('./alerter');
const resolver = require('./contractResolver');

// ── ALL alerts fire to #flow-alerts ──────────────────────────────
// Only these fire the full card to #conviction-trades
const HIGH_CONVICTION_ALERTS = [
  'Urgent Repeater',
  'Sizable Sweep',
  'Whale Alert',
  'Large Block',
  'Unusual Sweep',
  'Giant Sweep',
  'Explosive',
];

function isHighConviction(alertName, alertPremium) {
  const nameMatch    = HIGH_CONVICTION_ALERTS.some(name =>
    (alertName || '').toLowerCase().includes(name.toLowerCase())
  );
  const premiumMatch = parseFloat(alertPremium || 0) >= 50000;
  return nameMatch || premiumMatch;
}

// ── LIVE FLOW AGGREGATOR ──────────────────────────────────────────
const liveAggregator = {
  data:          {},
  alertLog:      [],
  lastResetDate: null,

  checkReset() {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const etHour = now.getUTCHours() - 4;
    const etMin  = now.getUTCMinutes();
    const isAfterOpen = etHour > 9 || (etHour === 9 && etMin >= 30);
    if (isAfterOpen && this.lastResetDate !== today) {
      console.log('[AGGREGATOR] Daily reset');
      this.data          = {};
      this.alertLog      = [];
      this.lastResetDate = today;
    }
  },

  add(ticker, type, premium, orderType, alertName) {
    this.checkReset();
    const key = `${ticker}:${type}`;
    if (!this.data[key]) {
      this.data[key] = {
        ticker, type,
        total: 0, count: 0, sweeps: 0,
        firstSeen: new Date().toISOString(),
        lastSeen:  new Date().toISOString(),
        clusterThreshold: null,
      };
    }
    const e    = this.data[key];
    e.total   += parseFloat(premium || 0);
    e.count   += 1;
    e.lastSeen = new Date().toISOString();
    if ((orderType || '').toUpperCase() === 'SWEEP') e.sweeps++;
    this.alertLog.push({ ticker, type, premium, orderType, alertName, time: new Date().toISOString() });
    const thresholds = [500000, 1000000, 2000000];
    for (const t of thresholds) {
      if (e.total >= t) { e.clusterThreshold = t; }
    }
    return e;
  },

  getSummary() {
    return {
      data:       this.data,
      alertCount: this.alertLog.length,
      resetDate:  this.lastResetDate,
      asOf:       new Date().toISOString(),
    };
  },
};

// ── PARSE OPRA ────────────────────────────────────────────────────
function parseOPRA(symbol) {
  try {
    const clean = (symbol || '').replace('O:', '');
    const match = clean.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, date, typeChar, strikePadded] = match;
    const strike = parseInt(strikePadded) / 1000;
    const expiry = `20${date.slice(0,2)}-${date.slice(2,4)}-${date.slice(4,6)}`;
    const type   = typeChar === 'C' ? 'call' : 'put';
    return { ticker, expiry, type, strike };
  } catch { return null; }
}

// ── SEND FLOW DISCORD MESSAGE ─────────────────────────────────────
async function sendFlowDiscord(parsed, alertName, alertPremium, orderType, price) {
  const FLOW_WEBHOOK = process.env.DISCORD_FLOW_WEBHOOK_URL;
  if (!FLOW_WEBHOOK) return;

  const direction  = parsed.type === 'call' ? '🟢 BULLISH' : '🔴 BEARISH';
  const typeLabel  = parsed.type === 'call' ? 'C' : 'P';
  const premiumFmt = alertPremium >= 1000000
    ? `$${(alertPremium/1000000).toFixed(1)}M`
    : alertPremium >= 1000
    ? `$${(alertPremium/1000).toFixed(0)}K`
    : `$${alertPremium}`;

  const isSwept  = (orderType || '').toLowerCase().includes('sweep');
  const orderTag = isSwept ? '⚡ SWEEP' : '■ BLOCK';

  const lines = [
    `🌊 FLOW — ${parsed.ticker} ${parsed.type.toUpperCase()}`,
    `${parsed.ticker} $${parsed.strike}${typeLabel} ${parsed.expiry.slice(5).replace('-','/')} — ${direction}`,
    price ? `Stock   $${price} LIVE` : null,
    `═══════════════════════════════`,
    `Premium ${premiumFmt}`,
    `Type    ${orderTag}`,
    `Alert   ${alertName || 'Flow Alert'}`,
    `───────────────────────────────`,
    isHighConviction(alertName, alertPremium) ? `🔥 HIGH CONVICTION — watch for Strat signal` : `👁️ Watch for Strat confirmation`,
    `⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
  ].filter(Boolean);

  const fetch2 = require('node-fetch');
  await fetch2(FLOW_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content: '```\n' + lines.join('\n') + '\n```', username: 'Stratum Flow' }),
  });
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
            const envelope    = JSON.parse(line.slice(6));
            const message     = envelope?.data;
            const event       = message?.event;

            if (event === 'init') {
              console.log('[BULLFLOW] Stream initialized');
              return;
            }
            if (event === 'heartbeat') return;

            if (event === 'alert') {
              const alert = message?.data;
              if (!alert) return;

              const symbol       = alert.symbol       || '';
              const alertName    = alert.alertName    || '';
              const alertPremium = parseFloat(alert.alertPremium || 0);
              const alertType    = alert.alertType    || '';
              const orderType    = alertName.toLowerCase().includes('sweep') ? 'SWEEP' : 'BLOCK';

              console.log(`[BULLFLOW] ${symbol} — ${alertName} — $${alertPremium}`);

              const parsed = parseOPRA(symbol);
              if (!parsed) return;

              const { ticker, type } = parsed;

              // Always accumulate in aggregator
              liveAggregator.add(ticker, type, alertPremium, orderType, alertName);

              // Get live price
              const price = await resolver.getPrice(ticker).catch(() => null);

              // Send ALL alerts to #flow-alerts — no filter
              await sendFlowDiscord(parsed, alertName, alertPremium, orderType, price);
              console.log(`[FLOW] Sent to #flow-alerts: ${ticker} ${type} $${alertPremium}`);

              // High conviction — also resolve contract and send full card
              if (isHighConviction(alertName, alertPremium)) {
                console.log(`[BULLFLOW] HIGH CONVICTION — resolving contract: ${symbol}`);
                const flowData = {
                  sigScore:     alertType === 'algo' ? 0.85 : 0.5,
                  orderType,
                  totalPremium: alertPremium,
                  alertName,
                };
                alerter.sendTradeAlert(symbol, {}, flowData, false).catch(console.error);
              }
            }

            if (event === 'error' || event === 'cancelled') {
              console.error('[BULLFLOW] Stream error — reconnecting...');
              scheduleReconnect();
            }

          } catch { }
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

module.exports = { startBullflowStream, liveAggregator };
