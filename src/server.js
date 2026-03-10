// ─── STRATUM FLOW SCOUT — MAIN SERVER ─────────────────────────────
// Connects to Bullflow SSE stream, processes alerts in real time,
// scores each alert against GEX + time of day, and sends SMS alerts
// for high-confidence setups.

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');

const { parseOPRA, formatPremium } = require('./parser');
const { getGEXScore, getSpotPrice } = require('./gex');
const { scoreSetup, scoreTimeOfDay, calculatePositionSize } = require('./scorer');
const { sendTradeAlert, sendMorningBrief, sendSystemMessage } = require('./alerter');
const { WATCHLIST } = require('../config/watchlist');

const app = express();
app.use(express.json());

// ─── STATE ─────────────────────────────────────────────────────────
let streamConnected = false;
let alertsProcessed = 0;
let alertsFired = 0;
let lastHeartbeat = null;
let recentAlerts = []; // Last 50 alerts for dashboard

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? 0.65);
const MIN_PREMIUM = parseInt(process.env.MIN_PREMIUM ?? 50000);

// ─── ALERT PROCESSOR ───────────────────────────────────────────────
async function processAlert(rawAlert) {
  alertsProcessed++;

  const { symbol, alertName, alertPremium, alertType, timestamp } = rawAlert;

  // 1. Parse OPRA symbol
  const contract = parseOPRA(symbol);
  if (!contract) {
    console.log(`[SKIP] Could not parse symbol: ${symbol}`);
    return;
  }

  // 2. Check watchlist
  const watchlistEntry = WATCHLIST[contract.ticker];
  if (!watchlistEntry) {
    console.log(`[SKIP] ${contract.ticker} not on watchlist`);
    return;
  }

  // 3. Check premium threshold (per-ticker minimum)
  const minPremium = watchlistEntry.minPremium ?? MIN_PREMIUM;
  if (alertPremium < minPremium) {
    console.log(`[SKIP] ${contract.ticker} premium $${alertPremium} below $${minPremium} threshold`);
    return;
  }

  console.log(`[CHECK] ${contract.ticker} ${contract.strike}${contract.type[0]} ${contract.dte}DTE — ${alertName} — ${formatPremium(alertPremium)}`);

  // 4. Get GEX score
  const gexResult = await getGEXScore(contract.ticker, contract);

  // 5. Score confluence
  const alert = { alertName, alertPremium, alertType, timestamp };
  const scoreResult = scoreSetup(alert, contract, gexResult);

  console.log(`[SCORE] ${contract.ticker}: ${scoreResult.confidencePct}% confidence, ${scoreResult.stars}★, window: ${scoreResult.timeWindow}`);

  // 6. Store in recent alerts for dashboard
  const alertRecord = {
    id: `${Date.now()}-${contract.ticker}`,
    ticker: contract.ticker,
    contract,
    alert,
    score: scoreResult,
    timestamp: new Date().toISOString(),
    fired: false,
  };

  recentAlerts.unshift(alertRecord);
  if (recentAlerts.length > 50) recentAlerts.pop();

  // 7. Fire SMS if above threshold
  if (scoreResult.confidence >= CONFIDENCE_THRESHOLD) {
    alertsFired++;
    alertRecord.fired = true;
    console.log(`[FIRE] 🚨 ${contract.ticker} ${contract.strike}${contract.type[0]} — ${scoreResult.confidencePct}% — SENDING SMS`);
    const optPremium = parseFloat(rawAlert.tradePrice || 1.00);
    await sendTradeAlert(alert, contract, scoreResult, optPremium);
  }
}

// ─── BULLFLOW SSE STREAM ───────────────────────────────────────────
async function connectStream() {
  const apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey || apiKey === 'your_bullflow_api_key_here') {
    console.log('[STREAM] No Bullflow API key configured — running in demo mode');
    streamConnected = false;
    return;
  }

  console.log('[STREAM] Connecting to Bullflow SSE stream...');

  try {
    const response = await fetch(
      `https://api.bullflow.io/v1/streaming/alerts?key=${apiKey}`,
      { headers: { 'Accept': 'text/event-stream' } }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    streamConnected = true;
    console.log('[STREAM] ✅ Connected to Bullflow');
    await sendSystemMessage('Flow Scout connected. Watching 20 tickers.');

    // Process SSE stream line by line
    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        try {
          const envelope = JSON.parse(line.slice(6));
          const message = envelope.data ?? envelope;
          const event = message.event;

          if (event === 'init') {
            console.log('[STREAM] Stream initialized, listening since:', message.since);
          } else if (event === 'heartbeat') {
            lastHeartbeat = new Date().toISOString();
          } else if (event === 'alert') {
            const alertData = message.data;
            if (alertData) {
              await processAlert(alertData);
            }
          } else if (event === 'cancelled' || event === 'error') {
            console.log('[STREAM] Stream closed:', message.message || 'unknown reason');
            streamConnected = false;
            break;
          }
        } catch (parseErr) {
          // Skip malformed lines
        }
      }
    }
  } catch (err) {
    console.error('[STREAM] Connection failed:', err.message);
    streamConnected = false;
  }

  // Auto-reconnect after 5 seconds
  console.log('[STREAM] Reconnecting in 5 seconds...');
  setTimeout(connectStream, 5000);
}

// ─── MORNING BRIEF (8:00 AM ET daily) ────────────────────────────
cron.schedule('0 8 * * 1-5', async () => {
  console.log('[CRON] Running morning brief...');
  const scores = [];

  for (const ticker of Object.keys(WATCHLIST)) {
    try {
      const spotPrice = await getSpotPrice(ticker);
      if (!spotPrice) continue;
      const gexResult = await getGEXScore(ticker, { ticker, type: 'CALL', strike: spotPrice });
      scores.push({ ticker, stars: gexResult.stars, gexData: gexResult.gexData });
    } catch (err) {
      console.error(`[CRON] Failed to score ${ticker}:`, err.message);
    }
  }

  await sendMorningBrief(scores);
}, { timezone: 'America/New_York' });

// ─── DASHBOARD API ─────────────────────────────────────────────────
// Simple web dashboard to monitor Flow Scout

app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Stratum Flow Scout</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="15">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'Courier New', monospace; padding: 20px; }
    h1 { color: #00cc66; font-size: 1.4rem; margin-bottom: 4px; }
    .status { display: flex; gap: 20px; margin: 12px 0; font-size: 0.85rem; }
    .badge { padding: 3px 10px; border-radius: 4px; font-weight: bold; }
    .live { background: #003322; color: #00cc66; border: 1px solid #00cc66; }
    .offline { background: #330000; color: #cc3300; border: 1px solid #cc3300; }
    .stats { display: flex; gap: 30px; margin: 16px 0; font-size: 0.85rem; color: #888; }
    .stat-val { color: #fff; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 16px; }
    th { background: #003366; color: #88aaff; padding: 8px 10px; text-align: left; }
    td { padding: 7px 10px; border-bottom: 1px solid #1a1a2e; }
    tr.fired { background: #0a1a0a; }
    tr:hover { background: #0f0f1a; }
    .stars { color: #ffcc00; }
    .conf-high { color: #00cc66; font-weight: bold; }
    .conf-med { color: #ffaa00; }
    .conf-low { color: #888; }
    .call { color: #00cc66; } .put { color: #ff4444; }
    .fired-badge { background: #003322; color: #00cc66; padding: 2px 6px; border-radius: 3px; font-size: 0.75rem; }
  </style>
</head>
<body>
  <h1>⚡ STRATUM FLOW SCOUT</h1>
  <p style="color:#666; font-size:0.8rem;">Auto-refreshes every 15 seconds</p>

  <div class="status">
    <span class="badge ${streamConnected ? 'live' : 'offline'}">${streamConnected ? '● LIVE' : '● OFFLINE'}</span>
    <span style="color:#666">Last heartbeat: ${lastHeartbeat ?? 'none'}</span>
  </div>

  <div class="stats">
    <div>Alerts processed: <span class="stat-val">${alertsProcessed}</span></div>
    <div>SMS sent today: <span class="stat-val">${alertsFired}</span></div>
    <div>Watchlist: <span class="stat-val">${Object.keys(WATCHLIST).length} tickers</span></div>
    <div>Threshold: <span class="stat-val">${Math.round(CONFIDENCE_THRESHOLD * 100)}%</span></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>TIME</th><th>TICKER</th><th>CONTRACT</th><th>ALERT</th>
        <th>PREMIUM</th><th>STARS</th><th>CONFIDENCE</th><th>WINDOW</th><th>SMS</th>
      </tr>
    </thead>
    <tbody>
      ${recentAlerts.slice(0, 30).map(a => {
        const c = a.contract;
        const s = a.score;
        const confClass = s.confidencePct >= 80 ? 'conf-high' : s.confidencePct >= 65 ? 'conf-med' : 'conf-low';
        const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `<tr class="${a.fired ? 'fired' : ''}">
          <td>${time}</td>
          <td><strong>${c.ticker}</strong></td>
          <td><span class="${c.type === 'CALL' ? 'call' : 'put'}">${c.strike}${c.type[0]}</span> ${c.dte}DTE</td>
          <td>${a.alert.alertName}</td>
          <td>${formatPremium(a.alert.alertPremium)}</td>
          <td class="stars">${'★'.repeat(s.stars)}${'☆'.repeat(5-s.stars)}</td>
          <td class="${confClass}">${s.confidencePct}%</td>
          <td style="font-size:0.75rem;color:#888">${s.timeWindow}</td>
          <td>${a.fired ? '<span class="fired-badge">SENT</span>' : ''}</td>
        </tr>`;
      }).join('')}
      ${recentAlerts.length === 0 ? '<tr><td colspan="9" style="color:#444;text-align:center;padding:30px">Waiting for flow alerts...</td></tr>' : ''}
    </tbody>
  </table>
</body>
</html>`;
  res.send(html);
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    stream: streamConnected,
    alertsProcessed,
    alertsFired,
    uptime: process.uptime(),
    lastHeartbeat,
  });
});

// ─── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚡ STRATUM FLOW SCOUT`);
  console.log(`   Server: http://localhost:${PORT}`);
  console.log(`   Watchlist: ${Object.keys(WATCHLIST).length} tickers`);
  console.log(`   Threshold: ${Math.round(CONFIDENCE_THRESHOLD * 100)}% confidence\n`);
  connectStream();
});
