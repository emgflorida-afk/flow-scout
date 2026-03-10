// ALERTER v3 — Discord + Email (replaces Twilio)
const fetch = require('node-fetch');
const { calculatePositionSize, getFlowBias } = require('./scorer');
const { formatStrike, formatPremium } = require('./parser');

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

// ─── DISCORD ───────────────────────────────────────────────────────
async function sendDiscord(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { console.log('[DISCORD] No webhook URL'); return false; }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '```\n' + message + '\n```',
        username: 'Stratum Flow Scout',
      }),
    });
    if (res.ok) { console.log('[DISCORD] Sent'); return true; }
    console.error('[DISCORD] Failed:', res.status);
    return false;
  } catch (err) {
    console.error('[DISCORD] Error:', err.message);
    return false;
  }
}

// ─── SEND ALERT ────────────────────────────────────────────────────
async function sendAlert(subject, message) {
  await sendDiscord(message);
}

// ─── TRADE ALERT ───────────────────────────────────────────────────
async function sendTradeAlert(alert, contract, scoreResult, optionPremium) {
  const { gexScore, confidencePct, stars: starCount, direction, entryWindow, timeWindow, flowBias } = scoreResult;
  const gexData = gexScore.gexData;

  const sizing = calculatePositionSize(optionPremium || 1.00);
  if (!sizing.viable) { console.log('[ALERT] Skipping — ' + sizing.reason); return false; }

  const ticker = contract.ticker;
  const strike = formatStrike(contract.strike);
  const type   = contract.type[0];
  const dte    = contract.is0DTE ? '0DTE' : contract.dte + 'DTE';
  const expiry = contract.expiryLabel;

  const lines = [
    'STRATUM ALERT ' + confidencePct + '%',
    ticker + ' ' + strike + type + ' ' + dte + ' ' + expiry,
    '---',
    'Entry:  ~$' + sizing.optionPremium.toFixed(2) + ' x' + sizing.contracts,
    'Stop:    $' + sizing.stopPrice + ' (loss $' + sizing.stopLoss + ')',
    'T1:      $' + sizing.t1Price + ' (profit $' + sizing.t1Profit + ')',
    sizing.hasRunner ? 'T2:      $' + sizing.t2Price + ' (runner)' : '',
    'Risk:    ' + sizing.riskPct + '% of account',
    '---',
    'GEX: ' + stars(starCount) + ' | ' + timeWindow,
    gexData && gexData.pin ? 'Pin: $' + gexData.pin : '',
    gexData && gexData.gammaFlip ? 'Flip: $' + gexData.gammaFlip : '',
    flowBias && flowBias.label !== 'NEUTRAL' ? 'Flow: ' + flowBias.label : '',
    '> ' + entryWindow,
  ].filter(Boolean);

  await sendAlert('STRATUM ' + ticker + ' ' + strike + type, lines.join('\n'));
  return true;
}

// ─── MORNING BRIEF ─────────────────────────────────────────────────
async function sendMorningBrief(watchlistScores) {
  if (!watchlistScores || watchlistScores.length === 0) return false;

  const top5    = watchlistScores.sort((a, b) => b.stars - a.stars).slice(0, 5);
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  const lines = [
    'STRATUM MORNING BRIEF — ' + dateStr,
    '',
    'TOP GEX SETUPS:',
    ...top5.map((t, i) => {
      const bias = getFlowBias(t.ticker);
      return (i+1) + '. ' + t.ticker + ' ' + stars(t.stars)
        + (t.gexData && t.gexData.pin ? ' Pin:$' + t.gexData.pin : '')
        + (t.gexData && t.gexData.gammaFlip ? ' Flip:$' + t.gexData.gammaFlip : '')
        + (bias.label !== 'NEUTRAL' ? ' [' + bias.label + ']' : '');
    }),
    '',
    'Max premium: $2.40 | Max loss: $120',
    'Trade window: 10AM-11:30AM & 3PM-3:45PM',
    'Watching ' + watchlistScores.length + ' tickers.',
  ];

  await sendAlert('STRATUM Morning Brief', lines.join('\n'));
  return true;
}

// ─── SYSTEM MESSAGE ────────────────────────────────────────────────
async function sendSystemMessage(message) {
  await sendAlert('STRATUM Alert', message);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };
