// bullflowStream.js — Stratum Flow Scout v5.7
// Fixed: passes full flowData to sendFlowAlert for proper scoring
// Wide net — all tickers, no watchlist filter on flow
// ─────────────────────────────────────────────────────────────────

const fetch    = require('node-fetch');
const alerter  = require('./alerter');
const resolver = require('./contractResolver');

// ── LIVE AGGREGATOR — for /flow/summary endpoint ──────────────────
const liveAggregator = {
  data:          {},
  lastResetDate: null,

  checkReset() {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const etH   = now.getUTCHours() - 4;
    const etM   = now.getUTCMinutes();
    if ((etH > 9 || (etH === 9 && etM >= 30)) && this.lastResetDate !== today) {
      this.data          = {};
      this.lastResetDate = today;
      console.log('[AGGREGATOR] Daily reset');
    }
  },

  add(ticker, type, premium, alertName) {
    this.checkReset();
    const key = `${ticker}:${type}`;
    if (!this.data[key]) {
      this.data[key] = { ticker, type, total: 0, count: 0, sweeps: 0, firstSeen: new Date() };
    }
    const e    = this.data[key];
    e.total   += parseFloat(premium || 0);
    e.count   += 1;
    if ((alertName || '').toLowerCase().includes('sweep')) e.sweeps += 1;
    return e;
  },

  getSummary() {
    const entries  = Object.values(this.data);
    const calls    = entries.filter(e => e.type === 'call').reduce((s, e) => s + e.total, 0);
    const puts     = entries.filter(e => e.type === 'put').reduce((s, e) => s + e.total, 0);
    const total    = calls + puts;
    const clusters = entries.filter(e => e.total >= 500000).length;
    const alerts   = entries.reduce((s, e) => s + e.count, 0);

    const tickers = entries
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
      .map(e => ({
        ticker:    e.ticker,
        type:      e.type,
        total:     e.total,
        count:     e.count,
        sweeps:    e.sweeps,
        firstSeen: e.firstSeen,
      }));

    return {
      version:       '5.7',
      connected:     true,
      totalFlow:     total,
      callFlow:      calls,
      putFlow:       puts,
      clusterCount:  clusters,
      alertCount:    alerts,
      tickers,
      lastUpdate:    new Date().toISOString(),
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
    const yy     = date.slice(0, 2);
    const mm     = date.slice(2, 4);
    const dd     = date.slice(4, 6);
    const expiry = `20${yy}-${mm}-${dd}`;
    const type   = typeChar === 'C' ? 'call' : 'put';
    return { ticker, expiry, type, strike };
  } catch { return null; }
}

// ── MAIN STREAM ───────────────────────────────────────────────────
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
        console.error('[BULLFLOW] Connection failed:', res.status);
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

            if (event === 'heartbeat' || event === 'init') return;

            if (event === 'alert') {
              const alert = message?.data;
              if (!alert) return;

              const symbol       = alert.symbol       || '';
              const alertName    = alert.alertName    || '';
              const alertPremium = parseFloat(alert.alertPremium || 0);
              const alertType    = (alert.alertType   || '').toLowerCase();
              const side         = (alert.side        || '').toLowerCase();

              console.log(`[BULLFLOW] Alert: ${symbol} — ${alertName} — $${alertPremium}`);

              const parsed = parseOPRA(symbol);
              if (!parsed) {
                console.log('[BULLFLOW] Could not parse OPRA:', symbol);
                return;
              }

              const { ticker, type } = parsed;

              // ── ALWAYS ACCUMULATE ─────────────────────────────
              liveAggregator.add(ticker, type, alertPremium, alertName);

              // ── BUILD FULL FLOW DATA ──────────────────────────
              // This is what feeds scoreFlow() in alerter.js
              const flowData = {
                alertName,
                alertPremium,
                totalPremium: alertPremium,
                orderType:    alertName.toLowerCase().includes('sweep') ? 'SWEEP' : 'BLOCK',
                side,
                alertType,
                ticker,
                type,
                symbol,
              };

              // ── SEND TO FLOW ALERT — wide net, all tickers ────
              // No watchlist filter — cast wide
              alerter.sendTradeAlert(symbol, {}, flowData, false).catch(console.error);
            }

            if (event === 'error' || event === 'cancelled') {
              console.error('[BULLFLOW] Stream event:', event);
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
