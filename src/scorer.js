// ─── CONFLUENCE SCORER ─────────────────────────────────────────────
const { WATCHLIST, ALERT_WEIGHTS, TIME_WEIGHTS } = require('../config/watchlist');

function scoreFlow(alert, contract) {
  let score = 0;
  const reasons = [];

  const alertWeight = ALERT_WEIGHTS[alert.alertName] ?? ALERT_WEIGHTS['default'];
  score += alertWeight * 1.5;
  reasons.push(`${alert.alertName} (weight: ${alertWeight})`);

  const watchlistEntry = WATCHLIST[contract.ticker];
  const minPremium = watchlistEntry?.minPremium ?? Number(process.env.MIN_PREMIUM ?? 50000);
  const premiumRatio = alert.alertPremium / minPremium;

  if (premiumRatio >= 5) {
    score += 1.5; reasons.push(`Premium ${formatPremium(alert.alertPremium)} — 5x+ threshold`);
  } else if (premiumRatio >= 3) {
    score += 1.0; reasons.push(`Premium ${formatPremium(alert.alertPremium)} — 3x+ threshold`);
  } else if (premiumRatio >= 1) {
    score += 0.5; reasons.push(`Premium ${formatPremium(alert.alertPremium)} — above threshold`);
  }

  return { score: Math.min(3, score), reasons };
}

function scoreTimeOfDay(timestamp) {
  const date = new Date(timestamp * 1000);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const windows = [
    { start: 10*60,    end: 11*60+30, weight: 1.0,  label: 'PRIMARY WINDOW'   },
    { start: 15*60,    end: 15*60+45, weight: 0.9,  label: 'POWER HOUR'       },
    { start: 13*60,    end: 15*60,    weight: 0.75, label: 'SECONDARY WINDOW' },
    { start: 9*60+30,  end: 10*60,    weight: 0.6,  label: 'OPENING RANGE'    },
    { start: 11*60+30, end: 13*60,    weight: 0.2,  label: 'LUNCH CHOP'       },
  ];

  for (const w of windows) {
    if (totalMinutes >= w.start && totalMinutes < w.end) {
      return { weight: w.weight, label: w.label };
    }
  }
  return { weight: 0, label: 'OUTSIDE MARKET HOURS' };
}

function scoreSetup(alert, contract, gexResult) {
  const flowResult = scoreFlow(alert, contract);
  const timeResult = scoreTimeOfDay(alert.timestamp);
  const gexNormalized = gexResult.score / 6;

  const confidence = (
    gexNormalized * 0.45 +
    (flowResult.score / 3) * 0.35 +
    timeResult.weight * 0.20
  );

  const dteMult = contract.is0DTE ? 1.1 : contract.isWeekly ? 1.05 : 1.0;
  const finalConfidence = Math.min(1, confidence * dteMult);
  const direction = contract.type === 'CALL' ? '📈 LONG' : '📉 SHORT';

  let entryWindow = 'Wait for 10:00 AM primary window';
  if (timeResult.label === 'PRIMARY WINDOW') entryWindow = 'IN PRIMARY WINDOW — act now';
  else if (timeResult.label === 'POWER HOUR') entryWindow = 'IN POWER HOUR — act now';
  else if (timeResult.label === 'OPENING RANGE') entryWindow = 'Wait for 10:00 AM — OR still forming';
  else if (timeResult.label === 'LUNCH CHOP') entryWindow = 'Wait for 1:00 PM secondary window';

  return {
    confidence: finalConfidence,
    confidencePct: Math.round(finalConfidence * 100),
    stars: gexResult.stars,
    direction,
    timeWindow: timeResult.label,
    entryWindow,
    flowScore: flowResult,
    gexScore: gexResult,
    timeScore: timeResult,
  };
}

function formatPremium(p) {
  if (p >= 1_000_000) return `$${(p/1_000_000).toFixed(1)}M`;
  if (p >= 1_000) return `$${(p/1_000).toFixed(0)}K`;
  return `$${p}`;
}

module.exports = { scoreSetup, scoreTimeOfDay };
