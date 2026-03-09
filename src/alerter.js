// ─── SMS ALERTER ───────────────────────────────────────────────────
const twilio = require('twilio');
const { formatStrike, formatPremium } = require('./parser');

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

function starsText(stars) {
  return '★'.repeat(stars) + '☆'.repeat(5 - stars);
}

async function sendTradeAlert(alert, contract, scoreResult) {
  const { gexScore, confidencePct, stars, direction, entryWindow, timeWindow } = scoreResult;
  const gexData = gexScore.gexData;

  const ticker = contract.ticker;
  const strike = formatStrike(contract.strike);
  const type = contract.type;
  const expiry = contract.expiryLabel;
  const dte = contract.is0DTE ? '0DTE' : `${contract.dte}DTE`;
  const premium = formatPremium(alert.alertPremium);
  const alertName = alert.alertName;

  const lines = [
    `⚡ STRATUM ALERT`,
    `${ticker} ${strike}${type[0]} ${dte} ${expiry}`,
    `Flow: ${premium} — ${alertName}`,
    `GEX: ${starsText(stars)} ${confidencePct}%`,
    gexData?.pin ? `Pin: $${gexData.pin}` : '',
    gexData?.gammaFlip ? `Flip: $${gexData.gammaFlip}` : '',
    gexData?.volZone ? `Vol Zone: $${gexData.volZone} ⚠️` : '',
    `Direction: ${direction}`,
    `Window: ${timeWindow}`,
    `→ ${entryWindow}`,
  ].filter(Boolean);

  const body = lines.join('\n');

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: process.env.TRADER_PHONE_NUMBER,
    });
    console.log(`[SMS] Alert sent: ${ticker} ${strike}${type[0]} ${dte} — ${confidencePct}% confidence`);
    return true;
  } catch (err) {
    console.error('[SMS] Failed to send alert:', err.message);
    return false;
  }
}

async function sendMorningBrief(watchlistScores) {
  const top5 = watchlistScores.sort((a, b) => b.stars - a.stars).slice(0, 5);

  const lines = [
    `🌅 STRATUM MORNING BRIEF`,
    `${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
    ``,
    `TOP SETUPS TODAY:`,
    ...top5.map((t, i) =>
      `${i+1}. ${t.ticker} ${'★'.repeat(t.stars)}${'☆'.repeat(5-t.stars)}`
      + (t.gexData?.pin ? ` Pin:$${t.gexData.pin}` : '')
      + (t.gexData?.gammaFlip ? ` Flip:$${t.gexData.gammaFlip}` : '')
    ),
    ``,
    `Flow Scout active. Watching ${watchlistScores.length} tickers.`,
  ];

  const body = lines.join('\n');

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: process.env.TRADER_PHONE_NUMBER,
    });
    console.log('[SMS] Morning brief sent');
    return true;
  } catch (err) {
    console.error('[SMS] Morning brief failed:', err.message);
    return false;
  }
}

async function sendSystemMessage(message) {
  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: `🤖 STRATUM: ${message}`,
      from: process.env.TWILIO_FROM_NUMBER,
      to: process.env.TRADER_PHONE_NUMBER,
    });
  } catch (err) {
    console.error('[SMS] System message failed:', err.message);
  }
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };
