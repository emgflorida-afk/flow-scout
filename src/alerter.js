// SMS ALERTER v2
// Includes position sizing, stop $, T1, T2, account risk, flow bias

const twilio = require('twilio');
const { formatStrike, formatPremium } = require('./parser');
const { calculatePositionSize, getFlowBias } = require('./scorer');

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

// TRADE ALERT
async function sendTradeAlert(alert, contract, scoreResult, optionPremium) {
  const { gexScore, confidencePct, stars: starCount, direction, entryWindow, timeWindow, flowBias } = scoreResult;
  const gexData = gexScore.gexData;

  // Position sizing
  const sizing = calculatePositionSize(optionPremium || 1.00);

  if (!sizing.viable) {
    console.log('[SMS] Skipping alert — ' + sizing.reason);
    return false;
  }

  const ticker  = contract.ticker;
  const strike  = formatStrike(contract.strike);
  const type    = contract.type[0];
  const dte     = contract.is0DTE ? '0DTE' : contract.dte + 'DTE';
  const expiry  = contract.expiryLabel;
  const premium = formatPremium(alert.alertPremium);
  const dir     = direction === 'LONG' ? 'CALL' : 'PUT';

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

  const body = lines.join('\n');

  try {
    const client = getTwilioClient();
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: process.env.TRADER_PHONE_NUMBER,
    });
    console.log('[SMS] Alert sent: ' + ticker + ' ' + strike + type + ' ' + dte + ' — ' + confidencePct + '% | Entry $' + sizing.optionPremium + ' x' + sizing.contracts + ' | Stop $' + sizing.stopPrice);
    return true;
  } catch (err) {
    console.error('[SMS] Failed:', err.message);
    return false;
  }
}

// MORNING BRIEF
async function sendMorningBrief(watchlistScores) {
  const top5 = watchlistScores
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 5);

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  const lines = [
    'STRATUM MORNING BRIEF',
    dateStr,
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
    'Trade window: 10AM-11:30AM',
    'Flow Scout watching ' + watchlistScores.length + ' tickers.',
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

// SYSTEM MESSAGE
async function sendSystemMessage(message) {
  try {
    const client = getTwilioClient();
    await client.messages.create({
      body: 'STRATUM: ' + message,
      from: process.env.TWILIO_FROM_NUMBER,
      to: process.env.TRADER_PHONE_NUMBER,
    });
  } catch (err) {
    console.error('[SMS] System message failed:', err.message);
  }
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };
