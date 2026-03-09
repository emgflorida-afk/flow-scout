// ─── STRATUM FLOW SCOUT — MAIN SERVER ─────────────────────────────
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');

const { parseOPRA, formatPremium } = require('./parser');
const { getGEXScore, getSpotPrice } = require('./gex');
const { scoreSetup } = require('./scorer');
const { sendTradeAlert, sendMorningBrief, sendSystemMessage } = require('./alerter');
const { WATCHLIST } = require('../config/watchlist');

const app = express();
app.use(express.json());

let streamConnected = false;
let alertsProcessed = 0;
let alertsFired = 0;
let lastHeartbeat = null;
let recentAlerts = [];

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? 0.65);
const MIN_PREMIUM = parseInt(process.env.MIN_PREMIUM ?? 50000);

async function processAlert(rawAlert) {
  alertsProcessed++;
  const { symbol, alertName, alertPremium, alertType, timestamp } = rawAlert;

  const contract = parseOPRA(symbol);
  if (!contract) return;

  const watchlistEntry = WATCHLIST[contract.ticker];
  if (!watchlistEntry) return;

  const minPremium = watchlistEntry.minPremium ?? MIN_PREMIUM;
  if (alertPremium < minPremium) return;

  console.log(`[CHECK] ${contract.ticker} ${contract.strike}${contract.type[0]} ${contract.dte}DTE — ${alertName} — ${formatPremium(alertPremium)}`);

  const gexResult = await getGEXScore(contract.ticker, contract);
  const alert = { alertName, alertPremium, alertType, timestamp };
  const scoreResult = scoreSetup(alert, contract, gexResult);

  console.log(`[SCORE] ${contract.ticker}: ${scoreResult.confidencePct}% confidence, ${scoreResult.stars}★`);

  const alertRecord = {
    id: `${Date.now()}-${contract.ticker}`,
    ticker: contract.ticker,
    contract, alert, score: scoreResult,
    timestamp: new Date().toISOString(),
    fired: false,
  };

  recentAlerts.unshift(alertRecord);
  if (recentAlerts.length > 50) recentAlerts.pop();

  if (scoreResult.confidence >= CONFIDENCE_THRESHOLD) {
    alertsFired++;
    alertRecord.fired = true;
    console.log(`[FIRE] 🚨 ${contract.ticker} — ${scoreResult.confidencePct}% — SENDING SMS`);
    await sendTradeAlert(alert, contract, scoreResult);
  }
}

async function connectStream() {
  const apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey || apiKey === 'your_bullflow_api_key_here') {
    console.log('[STREAM] No Bullflow API key — running in demo mode');
    streamConnected = false;
    return;
  }

  console.log('[STREAM] Connecting to Bullflow...');
  try {
    const response = await fetch(
      `https://api.bullflow.io/v1/streaming/alerts?key=${apiKey}`,
      { headers: { 'Accept': 'text/event-stream' } }
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    streamConnected = true;
    console.log('[STREAM] ✅ Connected');
    await sendSystemMessage('Flow Scout connected. Watching 20 tickers.');

    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const envelope = JSON.parse(line.slice(6));
          const message = envelope.data ?? envelope;
          if (message.event === 'heartbeat') lastHeartbeat = new Date().toISOString();
          else if (message.event === 'alert' && message.data) await processAlert(message.data);
          else if (message.event === 'cancelled' || message.event === 'error') { streamConnected = false; break; }
        } catch {}
      }
    }
  } catch (err) {
    console.error('[STREAM] Failed:', err.message);
    streamConnected = false;
  }

  setTimeout(connectStream, 5000);
}

cron.schedule('0 8 * * 1-5', async () => {
  const scores = [];
  for (const ticker of Object.keys(WATCHLIST)) {
    try {
      const spotPrice = await getSpotPrice(ticker);
      if (!spotPrice) continue;
      const gexResult = await getGEXScore(ticker, { ticker, type: 'CALL', strike: spotPrice });
      scores.push({ ticker, stars: gexResult.stars, gexData: gexResult.gexData });
    } catch {}
  }
  await sendMorningBrief(scores);
}, { timezone: 'America/New_York' });

app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
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
    <div>Processed: <span class="stat-val">${alertsProcessed}</span></div>
    <div>SMS sent: <span class="stat-val">${alertsFired}</span></div>
    <div>Watchlist: <span class="stat-val">${Object.keys(WATCHLIST).length} tickers</span></div>
    <div>Threshold: <span class="stat-val">${Math.round(CONFIDENCE_THRESHOLD * 100)}%</span></div>
  </div>
  <table>
    <thead><tr>
      <th>TIME</th><th>TICKER</th><th>CONTRACT</th><th>ALERT</th>
      <th>PREMIUM</th><th>STARS</th><th>CONF</th><th>WINDOW</th><th>SMS</th>
    </tr></thead>
    <tbody>
      ${recentAlerts.slice(0, 30).map(a => {
        const c = a.contract, s = a.score;
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', stream: streamConnected, alertsProcessed, alertsFired, uptime: process.uptime(), lastHeartbeat });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⚡ STRATUM FLOW SCOUT`);
  console.log(`   Server: http://localhost:${PORT}`);
  console.log(`   Watchlist: ${Object.keys(WATCHLIST).length} tickers`);
  console.log(`   Threshold: ${Math.round(CONFIDENCE_THRESHOLD * 100)}%\n`);
  connectStream();
});
