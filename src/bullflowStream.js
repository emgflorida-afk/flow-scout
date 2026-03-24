// bullflowStream.js — Stratum Flow Scout v5.9
// FIXED: Log ALL raw data from Bullflow stream
// Send ALL alerts to #flow-alerts — zero filter
// ─────────────────────────────────────────────────────────────────

const fetch    = require('node-fetch');
const resolver = require('./contractResolver');

const FLOW_WEBHOOK = process.env.DISCORD_FLOW_WEBHOOK_URL;

// ── LIVE AGGREGATOR ───────────────────────────────────────────────
const liveAggregator = {
  data:          {},
  alertLog:      [],
  lastResetDate: null,

  checkReset() {
    const now    = new Date();
    const today  = now.toISOString().slice(0, 10);
    const etHour = now.getUTCHours() - 4;
    const etMin  = now.getUTCMinutes();
    if ((etHour > 9 || (etHour === 9 && etMin >= 30)) && this.lastResetDate !== today) {
      this.data          = {};
      this.alertLog      = [];
      this.lastResetDate = today;
      console.log('[AGGREGATOR] Daily reset ✅');
    }
  },

  add(ticker, type, premium, orderType, alertName) {
    this.checkReset();
    const key = `${ticker}:${type}`;
    if (!this.data[key]) {
      this.data[key] = { ticker, type, total: 0, count: 0, sweeps: 0, firstSeen: new Date().toISOString() };
    }
    const e    = this.data[key];
    e.total   += parseFloat(premium || 0);
    e.count   += 1;
    e.lastSeen = new Date().toISOString();
    if ((orderType || '').toUpperCase() === 'SWEEP') e.sweeps++;
    this.alertLog.push({ ticker, type, premium, orderType, alertName, time: new Date().toISOString() });
    return e;
  },

  getSummary() {
    return { data: this.data, alertCount: this.alertLog.length, resetDate: this.lastResetDate };
  },
};

// ── SEND TO DISCORD ───────────────────────────────────────────────
async function sendFlowToDiscord(message) {
  if (!FLOW_WEBHOOK) { console.log('[FLOW] No webhook URL'); return; }
  try {
    await fetch(FLOW_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum Flow' }),
    });
    console.log('[FLOW] Sent to #flow-alerts ✅');
  } catch (err) { console.error('[FLOW] Discord error:', err.message); }
}

// ── PARSE OPRA ────────────────────────────────────────────────────
function parseOPRA(symbol) {
  try {
    const clean = (symbol || '').replace('O:', '');
    const match = clean.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, date, typeChar, strikePadded] = match;
    return {
      ticker,
      strike:  parseInt(strikePadded) / 1000,
      expiry:  `20${date.slice(0,2)}-${date.slice(2,4)}-${date.slice(4,6)}`,
      type:    typeChar === 'C' ? 'call' : 'put',
    };
  } catch { return null; }
}

// ── PROCESS ANY ALERT — no filter ────────────────────────────────
async function processAlert(raw) {
  // Log everything raw for debugging
  console.log('[BULLFLOW RAW]', JSON.stringify(raw));

  // Try multiple field name formats Bullflow might use
  const symbol      = raw.symbol      || raw.ticker       || raw.contract    || '';
  const alertName   = raw.alertName   || raw.alert_name   || raw.type        || raw.alertType || 'Flow Alert';
  const premium     = parseFloat(raw.alertPremium || raw.premium || raw.totalPremium || raw.size || 0);
  const orderType   = raw.orderType   || raw.order_type   || raw.flowType    || 'UNKNOWN';
  const expiry      = raw.expiry      || raw.expiration   || '';
  const strike      = raw.strike      || raw.strikePrice  || '';
  const optionType  = raw.optionType  || raw.putCall      || raw.side        || '';
  const underlying  = raw.underlying  || raw.underlyingSymbol || '';

  if (!symbol && !underlying) {
    console.log('[BULLFLOW] No symbol in alert — skipping');
    return;
  }

  const parsed   = parseOPRA(symbol);
  const ticker   = parsed?.ticker || underlying || symbol;
  const type     = parsed?.type   || (optionType?.toLowerCase().includes('put') ? 'put' : 'call');
  const strikeDisplay = parsed?.strike || strike || '?';
  const expiryDisplay = parsed?.expiry || expiry || '?';

  const direction  = type === 'call' ? '🟢 BULLISH' : '🔴 BEARISH';
  const typeLabel  = type === 'call' ? 'C' : 'P';
  const premiumFmt = premium >= 1000000 ? `$${(premium/1000000).toFixed(1)}M`
                   : premium >= 1000    ? `$${(premium/1000).toFixed(0)}K`
                   : premium > 0        ? `$${premium}`
                   : '—';

  const isSwept   = (orderType || alertName || '').toLowerCase().includes('sweep');
  const orderTag  = isSwept ? '⚡ SWEEP' : '■ BLOCK';

  // Accumulate
  liveAggregator.add(ticker, type, premium, orderType, alertName);

  // Get live price
  const price = await resolver.getPrice(ticker).catch(() => null);

  const lines = [
    `🌊 FLOW — ${ticker} ${type.toUpperCase()}`,
    `${ticker} $${strikeDisplay}${typeLabel} ${typeof expiryDisplay === 'string' ? expiryDisplay.slice(5).replace('-','/') : expiryDisplay} — ${direction}`,
    price ? `Stock   $${price} LIVE` : null,
    `═══════════════════════════════`,
    `Premium ${premiumFmt}`,
    `Type    ${orderTag}`,
    `Alert   ${alertName}`,
    `───────────────────────────────`,
    `👁️ Watch for Strat confirmation`,
    `⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
  ].filter(Boolean);

  await sendFlowToDiscord(lines.join('\n'));
}

// ── MAIN STREAM ───────────────────────────────────────────────────
async function startBullflowStream() {
  const apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) { console.error('[BULLFLOW] No API key'); return; }

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

      let buffer = '';

      res.body.on('data', async (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Log every raw SSE line
          console.log('[BULLFLOW SSE]', trimmed);

          if (!trimmed.startsWith('data: ')) continue;

          const raw = trimmed.slice(6).trim();
          if (!raw || raw === '{}') continue;

          try {
            const parsed = JSON.parse(raw);

            // Handle nested envelope formats
            const data = parsed?.data || parsed?.alert || parsed?.payload || parsed;

            // Skip heartbeats and init
            const event = parsed?.event || data?.event || '';
            if (event === 'heartbeat' || event === 'init') return;

            await processAlert(data);
          } catch (err) {
            console.log('[BULLFLOW] Parse error:', err.message, '| Raw:', raw.slice(0, 100));
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

module.exports = { startBullflowStream, liveAggregator };
