// alerter.js — Stratum Flow Scout v6
// NEW: Trade classification (DAY/SWING/LOTTO), combo detection,
//      confluence scoring, strategy detection (322, 4HR, Failed9)
// ─────────────────────────────────────────────────────────────────

const fetch      = require('node-fetch');
const resolver   = require('./contractResolver');
const calendar   = require('./economicCalendar');
const classifier = require('./tradeClassifier');

// ── DISCORD ───────────────────────────────────────────────────────
async function sendDiscord(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { console.log('[DISCORD] No webhook URL'); return false; }
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + message + '\n```',
        username: 'Stratum Flow Scout',
      }),
    });
    if (res.ok) { console.log('[DISCORD] Sent ✅'); return true; }
    console.error('[DISCORD] Failed:', res.status);
    return false;
  } catch (err) {
    console.error('[DISCORD] Error:', err.message);
    return false;
  }
}

function scoreBar(score, max) {
  const filled = Math.round((score / max) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score}/${max}`;
}

function calcDTE(expiryDateStr) {
  const now    = new Date();
  const expiry = new Date(expiryDateStr + 'T16:00:00-04:00');
  const diff   = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

async function getSpyPremarket() {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;
    const url  = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/SPY?apiKey=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    const snap = data?.ticker;
    if (!snap) return null;
    const price     = snap.day?.open || snap.lastTrade?.p || snap.prevDay?.c || null;
    if (!price) return null;
    const prevClose = snap.prevDay?.c || price;
    const change    = (price - prevClose).toFixed(2);
    const changePct = ((price - prevClose) / prevClose * 100).toFixed(2);
    const arrow     = change >= 0 ? '▲' : '▼';
    return { price: parseFloat(price).toFixed(2), change, changePct, arrow,
             label: `SPY $${parseFloat(price).toFixed(2)} ${arrow} ${changePct}%` };
  } catch { return null; }
}

// ── MAIN TRADE ALERT ──────────────────────────────────────────────
async function sendTradeAlert(opraSymbol, tvData = {}) {
  console.log('[ALERT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendDiscord(`⏸️ STRATUM BLOCKED\n${calCheck.reason}\nResumes after 11AM ET`);
    return false;
  }

  const contract = await resolver.findBestContract(opraSymbol);
  if (contract.error) { console.log('[ALERT]', contract.error); return false; }

  const sizing = resolver.calculatePositionSize(contract.premium);
  if (!sizing.viable) { console.log('[ALERT] Sizing:', sizing.reason); return false; }

  const dte = calcDTE(contract.expiry);

  const tfData = {
    monthly: tvData.monthly || null,
    weekly:  tvData.weekly  || null,
    daily:   tvData.daily   || null,
    h4:      tvData.h4      || null,
    h1:      tvData.h1      || null,
    m30:     tvData.m30     || null,
    m15:     tvData.m15     || null,
  };

  const tradeType  = classifier.classifyTrade(tfData, dte, contract.type);
  const confluence = classifier.getConfluenceScore(
    tfData, contract.type === 'put' ? 'bearish' : 'bullish'
  );

  let comboInfo = null;
  if (tvData.bar1 && tvData.bar2) {
    comboInfo = classifier.identifyCombo(tvData.bar1, tvData.bar2, tvData.bar3 || null);
  }

  let strategyDetected = null;
  if (tvData.bar8am && tvData.bar9am) {
    strategyDetected =
      classifier.check322Setup(tvData.bar8am, tvData.bar9am) ||
      classifier.checkFailed9(tvData.bar8am, tvData.bar9am, tvData.priceVs50pct);
  }
  if (!strategyDetected && tvData.bar4am && tvData.bar8am) {
    strategyDetected = classifier.check4HRRetrigger(tvData.bar4am, tvData.bar8am);
  }

  const { ticker, strike, type, expiry, premium, score } = contract;
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const grade     = score.total >= 9 ? '🔥 A+ EXECUTE'
                  : score.total >= 7 ? '✅ A  STRONG'
                  : score.total >= 5 ? '⚠️ B  CAUTION'
                  : '❌ C  SKIP';

  const tfLine = Object.entries(tfData)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.toUpperCase()}:${v}`)
    .join('  ');

  const lines = [
    `${tradeType.label} [LIVE]`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction} — ${dte}DTE`,
    `═══════════════════════════════`,
    `Score   ${scoreBar(score.total, score.max)}`,
    `Grade   ${grade}`,
    `Prob    ~${score.profitProb}% profit probability`,
    `───────────────────────────────`,
    confluence.total > 0 ? `TF Conf ${confluence.label}` : null,
    tfLine                ? `Bias    ${tfLine}` : null,
    comboInfo             ? `Setup   ${comboInfo.name} (${comboInfo.strength})` : null,
    strategyDetected      ? `Strat   ${strategyDetected.strategy}` : null,
    strategyDetected      ? `Entry   ${strategyDetected.entry}` : null,
    `───────────────────────────────`,
    `Entry   ~$${premium.toFixed(2)} x${sizing.contracts} = $${(premium * sizing.contracts * 100).toFixed(0)}`,
    `Stop     $${sizing.stopPrice} (loss -$${sizing.stopLoss})`,
    `T1       $${sizing.t1Price} (profit +$${sizing.t1Profit})`,
    `T2       $${sizing.t2Price} (runner)`,
    `Risk     ${sizing.riskPct}% of $6K account`,
    `───────────────────────────────`,
    `Delta   ${contract.delta}    Theta  ${contract.theta}`,
    `IV      ${contract.iv}%     Vol    ${contract.volume}`,
    `OI      ${contract.openInterest}`,
    `───────────────────────────────`,
    `Hold    ${tradeType.holdRules}`,
    `Stop    ${tradeType.stopRule}`,
    tradeType.extraNote || null,
    score.warnings.length > 0 ? `───────────────────────────────` : null,
    ...score.warnings.map(w => `⚠️  ${w}`),
    calCheck.warning ? `⚠️  ${calCheck.warning}` : null,
    `───────────────────────────────`,
    `⏰ Window: 10AM–11:30AM  |  3PM–3:45PM ET`,
  ].filter(l => l !== null && l !== undefined);

  await sendDiscord(lines.join('\n'));
  return true;
}

// ── MORNING BRIEF ─────────────────────────────────────────────────
async function sendMorningBrief(watchlistData = []) {
  const dateStr   = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const spy       = await getSpyPremarket();
  const calBrief  = await calendar.getCalendarBriefLine();

  const spyLine  = spy
    ? `SPY $${spy.price} ${spy.arrow} ${spy.changePct}% — ${parseFloat(spy.changePct) < 0 ? 'BEAR 🔴' : 'BULL 🟢'}`
    : 'SPY — unavailable';

  const biasLine = spy && parseFloat(spy.changePct) < -0.5 ? '🔴 Favor PUTS today'
                 : spy && parseFloat(spy.changePct) > 0.5  ? '🟢 Favor CALLS today'
                 : '➡️  Wait for 10AM direction';

  const top5       = watchlistData.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
  const setupLines = top5.length > 0
    ? top5.map((t, i) =>
        `${i + 1}. ${t.ticker.padEnd(5)} ${t.tradeType || ''} Score:${t.score}/11`
      )
    : ['  No setups scored yet — awaiting signals'];

  const lines = [
    `📊 STRATUM MORNING BRIEF — ${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `   ${biasLine}`,
    `───────────────────────────────`,
    calBrief.line,
    calBrief.hasHighImpact ? `🕐 ${calBrief.entryRule}` : null,
    `───────────────────────────────`,
    `TOP SETUPS:`,
    ...setupLines,
    `───────────────────────────────`,
    `💰 Max premium: $2.40 | Max loss: $120`,
    `📏 ≤$1.20 = 2 contracts | $1.21–$2.40 = 1`,
    `⏰ 10AM–11:30AM  |  3PM–3:45PM ET`,
    `👁️  Watching ${resolver.WATCHLIST.size} tickers`,
  ].filter(l => l !== null);

  await sendDiscord(lines.join('\n'));
  return true;
}

async function sendSystemMessage(msg) {
  await sendDiscord(`ℹ️ STRATUM SYSTEM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };
