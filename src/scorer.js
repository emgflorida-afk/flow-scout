// CONFLUENCE SCORER v2
// Signals: Flow + GEX + Time + Position Sizing

const { WATCHLIST, ALERT_WEIGHTS, TIME_WEIGHTS } = require('../config/watchlist');

const ACCOUNT_SIZE    = Number(process.env.ACCOUNT_SIZE  ?? 6000);
const MAX_RISK_PCT    = Number(process.env.MAX_RISK_PCT   ?? 0.02);
const MAX_PREMIUM     = Number(process.env.MAX_PREMIUM    ?? 2.40);
const MAX_RISK_DOLLAR = ACCOUNT_SIZE * MAX_RISK_PCT; // $120

// Flow bias tracker
const flowBias = {};

function trackFlowBias(ticker, type, premium) {
  if (!flowBias[ticker]) flowBias[ticker] = { callPremium: 0, putPremium: 0, lastReset: Date.now() };
  const hoursSinceReset = (Date.now() - flowBias[ticker].lastReset) / 3600000;
  if (hoursSinceReset > 20) flowBias[ticker] = { callPremium: 0, putPremium: 0, lastReset: Date.now() };
  if (type === 'CALL') flowBias[ticker].callPremium += premium;
  else flowBias[ticker].putPremium += premium;
}

function getFlowBias(ticker) {
  const bias = flowBias[ticker];
  if (!bias) return { label: 'NEUTRAL', ratio: 1, callPremium: 0, putPremium: 0 };
  const total = bias.callPremium + bias.putPremium;
  if (total === 0) return { label: 'NEUTRAL', ratio: 1, callPremium: 0, putPremium: 0 };
  const ratio = bias.callPremium / (bias.putPremium || 1);
  const label = ratio > 1.5 ? 'BULLISH' : ratio < 0.67 ? 'BEARISH' : 'NEUTRAL';
  return { label, ratio: parseFloat(ratio.toFixed(2)), callPremium: bias.callPremium, putPremium: bias.putPremium };
}

// Position sizing
function calculatePositionSize(optionPremium) {
  const costPerContract = optionPremium * 100;
  let stopPct;
  if (optionPremium < 1.50)       stopPct = 0.50;
  else if (optionPremium <= 3.00) stopPct = 0.40;
  else                             stopPct = 0.30;

  const stopPerContract = costPerContract * stopPct;
  const maxContracts    = Math.floor(MAX_RISK_DOLLAR / stopPerContract);
  const contracts       = Math.max(0, Math.min(maxContracts, 2));

  if (contracts === 0 || optionPremium > MAX_PREMIUM) {
    return {
      viable: false,
      reason: optionPremium > MAX_PREMIUM
        ? 'Premium $' + optionPremium.toFixed(2) + ' exceeds max $' + MAX_PREMIUM + ' — SKIP'
        : 'Position too small for account',
      contracts: 0,
    };
  }

  const stopPrice  = parseFloat((optionPremium * (1 - stopPct)).toFixed(2));
  const t1Price    = parseFloat((optionPremium * 2).toFixed(2));
  const t2Price    = parseFloat((optionPremium * (contracts >= 2 ? 3 : 2)).toFixed(2));
  const totalStop  = parseFloat((stopPerContract * contracts).toFixed(2));
  const t1Profit   = parseFloat(((t1Price - optionPremium) * 100 * contracts).toFixed(2));
  const riskPct    = parseFloat(((totalStop / ACCOUNT_SIZE) * 100).toFixed(1));
  const hasRunner  = contracts >= 2;

  return {
    viable: true,
    contracts,
    optionPremium,
    costPerContract: parseFloat(costPerContract.toFixed(2)),
    totalCost: parseFloat((costPerContract * contracts).toFixed(2)),
    stopPct,
    stopPrice,
    stopLoss: totalStop,
    t1Price,
    t2Price,
    t1Profit,
    riskPct,
    hasRunner,
    exitPlan: hasRunner
      ? 'Sell 1 at T1 ($' + t1Price + '), move stop to breakeven on runner'
      : 'Full exit at T1 ($' + t1Price + ')',
  };
}

// Flow score (0-3)
function scoreFlow(alert, contract) {
  let score = 0;
  const reasons = [];
  const alertWeight = ALERT_WEIGHTS[alert.alertName] ?? ALERT_WEIGHTS['default'];
  score += alertWeight * 1.5;
  reasons.push(alert.alertName + ' (weight: ' + alertWeight + ')');

  const watchlistEntry = WATCHLIST[contract.ticker];
  const minPremium = watchlistEntry?.minPremium ?? Number(process.env.MIN_PREMIUM ?? 50000);
  const premiumRatio = alert.alertPremium / minPremium;

  if (premiumRatio >= 5)      { score += 1.5; reasons.push('Premium ' + formatPremium(alert.alertPremium) + ' — 5x+ threshold'); }
  else if (premiumRatio >= 3) { score += 1.0; reasons.push('Premium ' + formatPremium(alert.alertPremium) + ' — 3x+ threshold'); }
  else if (premiumRatio >= 1) { score += 0.5; reasons.push('Premium ' + formatPremium(alert.alertPremium) + ' — above threshold'); }

  const bias = getFlowBias(contract.ticker);
  const biasAligns = (contract.type === 'CALL' && bias.label === 'BULLISH') ||
                     (contract.type === 'PUT'  && bias.label === 'BEARISH');
  if (biasAligns) { score += 0.5; reasons.push('Day flow ' + bias.label + ' aligns with ' + contract.type); }

  return { score: Math.min(3, score), reasons };
}

// Time score
function scoreTimeOfDay(timestamp) {
  const date = new Date(timestamp * 1000);
  const totalMinutes = date.getHours() * 60 + date.getMinutes();
  const windows = [
    { start: 10*60,    end: 11*60+30, weight: 1.0,  label: 'PRIMARY WINDOW'   },
    { start: 15*60,    end: 15*60+45, weight: 0.9,  label: 'POWER HOUR'       },
    { start: 13*60,    end: 15*60,    weight: 0.75, label: 'SECONDARY WINDOW' },
    { start: 9*60+30,  end: 10*60,    weight: 0.6,  label: 'OPENING RANGE'    },
    { start: 11*60+30, end: 13*60,    weight: 0.2,  label: 'LUNCH CHOP'       },
  ];
  for (const w of windows) {
    if (totalMinutes >= w.start && totalMinutes < w.end) return { weight: w.weight, label: w.label };
  }
  return { weight: 0, label: 'OUTSIDE MARKET HOURS' };
}

// Master scorer
function scoreSetup(alert, contract, gexResult) {
  trackFlowBias(contract.ticker, contract.type, alert.alertPremium);

  const flowResult    = scoreFlow(alert, contract);
  const timeResult    = scoreTimeOfDay(alert.timestamp);
  const gexNormalized = gexResult.score / 6;

  const confidence = (
    gexNormalized          * 0.45 +
    (flowResult.score / 3) * 0.35 +
    timeResult.weight      * 0.20
  );

  const dteMult         = contract.is0DTE ? 1.1 : contract.isWeekly ? 1.05 : 1.0;
  const finalConfidence = Math.min(1, confidence * dteMult);
  const flowBiasData    = getFlowBias(contract.ticker);

  let entryWindow = 'Wait for 10:00 AM primary window';
  if (timeResult.label === 'PRIMARY WINDOW')    entryWindow = 'IN PRIMARY WINDOW — act now';
  else if (timeResult.label === 'POWER HOUR')   entryWindow = 'IN POWER HOUR — act now';
  else if (timeResult.label === 'OPENING RANGE') entryWindow = 'Wait for 10:00 AM — OR still forming';
  else if (timeResult.label === 'LUNCH CHOP')   entryWindow = 'Avoid — lunch chop';

  return {
    confidence: finalConfidence,
    confidencePct: Math.round(finalConfidence * 100),
    stars: gexResult.stars,
    direction: contract.type === 'CALL' ? 'LONG' : 'SHORT',
    timeWindow: timeResult.label,
    entryWindow,
    flowScore: flowResult,
    gexScore: gexResult,
    timeScore: timeResult,
    flowBias: flowBiasData,
  };
}

function formatPremium(p) {
  if (p >= 1_000_000) return '$' + (p/1_000_000).toFixed(1) + 'M';
  if (p >= 1_000)     return '$' + (p/1_000).toFixed(0) + 'K';
  return '$' + p;
}

module.exports = { scoreSetup, scoreTimeOfDay, calculatePositionSize, trackFlowBias, getFlowBias };
