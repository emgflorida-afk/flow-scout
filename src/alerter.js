// alerter.js — Stratum Flow Scout v6
// NEW: Trade classification (DAY/SWING/LOTTO), combo detection,
//      confluence scoring, strategy detection (322, 4HR, Failed9)
// UPDATED: Full morning brief — SPY pre-market, VIX, movers, calendar
// UPDATED: High conviction filter — SigScore 0.7+, Sweeps, Vol vs OI
// UPDATED: King Node / Volume Profile lines in Discord alert
// UPDATED: Trading window changed to 9:30AM–4PM ET
// UPDATED: getTickerSnapshot — aggressive pre-market fallback
// UPDATED: sendDiscordRaw added for Flow Aggregator cluster alerts
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

async function sendDiscordRaw(message) {
  await sendDiscord(message);
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

// ── HIGH CONVICTION FILTER ────────────────────────────────────────
function checkHighConviction(flowData = {}) {
  const reasons = [];
  const flags   = [];
  let score     = 0;

  const sigScore = parseFloat(flowData.sigScore || 0);
  if (sigScore >= 0.7) {
    score++;
    flags.push(`SigScore ${sigScore} ✅`);
  } else if (sigScore > 0) {
    reasons.push(`SigScore ${sigScore} below 0.7`);
  }

  const orderType = (flowData.orderType || '').toUpperCase();
  if (orderType === 'SWEEP') {
    score++;
    flags.push('SWEEP ✅ (aggressive entry)');
  } else if (orderType === 'BLOCK') {
    flags.push('BLOCK (institutional but less urgent)');
  }

  const volume = parseInt(flowData.volume || 0);
  const oi     = parseInt(flowData.openInterest || 0);
  if (volume > 0 && oi > 0) {
    const ratio = volume / oi;
    if (ratio >= 2) {
      score++;
      flags.push(`Vol/OI ${ratio.toFixed(1)}x ✅ (unusual activity)`);
    } else if (ratio >= 1) {
      flags.push(`Vol/OI ${ratio.toFixed(1)}x (moderate)`);
    } else {
      reasons.push(`Vol/OI ${ratio.toFixed(1)}x — low (likely closing position)`);
    }
  }

  const premium = parseFloat(flowData.totalPremium || 0);
  if (premium >= 100000) {
    score++;
    flags.push(`Premium $${(premium / 1000).toFixed(0)}K ✅ (institutional size)`);
  } else if (premium >= 25000) {
    flags.push(`Premium $${(premium / 1000).toFixed(0)}K (notable)`);
  }

  const hasFlowData = sigScore > 0 || orderType || volume > 0;
  if (!hasFlowData) {
    return { pass: true, label: 'No flow data — TradingView signal', flags: [], score: 0 };
  }

  const pass = score >= 2;
  return {
    pass,
    score,
    flags,
    reasons,
    label: pass
      ? `🔥 HIGH CONVICTION (${score}/4)`
      : `⚠️ LOW CONVICTION (${score}/4) — SKIP`,
  };
}

// ── PRE-MARKET DATA ───────────────────────────────────────────────
async function getTickerSnapshot(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;

    const prevRes   = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`
    );
    const prevData  = await prevRes.json();
    const prevClose = prevData?.results?.[0]?.c || null;

    const snapRes  = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`
    );
    const snapData = await snapRes.json();
    const snap     = snapData?.ticker;

    const price = snap?.lastTrade?.p
               || snap?.min?.c
               || snap?.day?.close
               || snap?.day?.open
               || snap?.prevDay?.c
               || prevClose
               || null;

    const base = prevClose || price;
    if (!price || !base) return null;

    const change    = (price - base).toFixed(2);
    const changePct = ((price - base) / base * 100).toFixed(2);
    const arrow     = parseFloat(change) >= 0 ? '▲' : '▼';

    return {
      ticker,
      price:     parseFloat(price).toFixed(2),
      change,
      changePct,
      arrow,
      prevClose: parseFloat(base).toFixed(2),
    };
  } catch { return null; }
}

async function getSpyPremarket() {
  const snap = await getTickerSnapshot('SPY');
  if (!snap) return null;
  return { ...snap, label: `SPY $${snap.price} ${snap.arrow} ${snap.changePct}%` };
}

async function getVIX() {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;

    const prevRes   = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/UVXY/prev?adjusted=true&apiKey=${apiKey}`
    );
    const prevData  = await prevRes.json();
    const prevClose = prevData?.results?.[0]?.c || null;

    const snapRes  = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/UVXY?apiKey=${apiKey}`
    );
    const snapData = await snapRes.json();
    const snap     = snapData?.ticker;

    const price = snap?.lastTrade?.p
               || snap?.min?.c
               || snap?.day?.close
               || snap?.prevDay?.c
               || prevClose
               || null;

    if (!price) return null;

    const prev   = prevClose || price;
    const change = (price - prev).toFixed(2);
    const arrow  = parseFloat(change) >= 0 ? '▲' : '▼';
    const level  = price >= 30 ? 'EXTREME — reduce size 🚨'
                 : price >= 20 ? 'ELEVATED — be careful ⚠️'
                 : price >= 15 ? 'NORMAL ✅'
                 : 'LOW — watch for spike';

    return { price: parseFloat(price).toFixed(2), change, arrow, level };
  } catch { return null; }
}

// ── WATCHLIST SNAPSHOTS ───────────────────────────────────────────
async function getWatchlistSnapshots() {
  const tickers = [...resolver.WATCHLIST];
  const results = [];

  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const snaps = await Promise.all(batch.map(t => getTickerSnapshot(t)));
    snaps.forEach((snap) => { if (snap) results.push(snap); });
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// ── MAIN TRADE ALERT ──────────────────────────────────────────────
async function sendTradeAlert(opraSymbol, tvData = {}, flowData = {}) {
  console.log('[ALERT] Processing:', opraSymbol);

  const conviction = checkHighConviction(flowData);
  if (!conviction.pass) {
    console.log(`[ALERT] Low conviction — skipping: ${conviction.reasons.join(', ')}`);
    return false;
  }

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendDiscord(`⏸️ STRATUM BLOCKED\n${calCheck.reason}\nResumes at 9:30AM ET`);
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

  const sweepAtKing = conviction.flags.some(f => f.includes('SWEEP')) &&
                      contract.volumeProfile?.nearKing;

  const lines = [
    `${tradeType.label} [LIVE]`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction} — ${dte}DTE`,
    sweepAtKing ? `👑⚡ SWEEP AT KING NODE — MAXIMUM CONVICTION` : null,
    `═══════════════════════════════`,
    `Score   ${scoreBar(score.total, score.max)}`,
    `Grade   ${grade}`,
    `Prob    ~${score.profitProb}% profit probability`,
    `───────────────────────────────`,
    conviction.score > 0 ? `Flow    ${conviction.label}` : null,
    ...conviction.flags.map(f => `        ${f}`),
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
    contract.kingNodeLine ? `───────────────────────────────` : null,
    contract.kingNodeLine ? contract.kingNodeLine : null,
    `───────────────────────────────`,
    `Hold    ${tradeType.holdRules}`,
    `Stop    ${tradeType.stopRule}`,
    tradeType.extraNote || null,
    score.warnings.length > 0 ? `───────────────────────────────` : null,
    ...score.warnings.map(w => `⚠️  ${w}`),
    calCheck.warning ? `⚠️  ${calCheck.warning}` : null,
    `───────────────────────────────`,
    `⏰ Window: 9:30AM–4PM ET`,
  ].filter(l => l !== null && l !== undefined);

  await sendDiscord(lines.join('\n'));
  return true;
}

// ── MORNING BRIEF ─────────────────────────────────────────────────
async function sendMorningBrief() {
  console.log('[BRIEF] Building morning brief...');

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });

  const [spy, vix, calBrief, watchlistSnaps] = await Promise.all([
    getSpyPremarket(),
    getVIX(),
    calendar.getCalendarBriefLine(),
    getWatchlistSnapshots(),
  ]);

  const spyLine = spy
    ? `SPY  $${spy.price} ${spy.arrow} ${spy.changePct}%  (prev $${spy.prevClose})`
    : 'SPY  — unavailable';
  const spyBias = spy && parseFloat(spy.changePct) <= -0.5
    ? '🔴 Pre-mkt BEARISH — lean PUTS'
    : spy && parseFloat(spy.changePct) >= 0.5
    ? '🟢 Pre-mkt BULLISH — lean CALLS'
    : '➡️  Flat — wait for 9:30AM open direction';

  const vixLine = vix
    ? `UVXY $${vix.price} ${vix.arrow} ${vix.change}  ${vix.level}`
    : 'VIX  — unavailable';

  const sorted  = [...watchlistSnaps].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct));
  const gainers = sorted.slice(0, 3);
  const losers  = sorted.slice(-3).reverse();

  const lines = [
    `📊 STRATUM MORNING BRIEF`,
    `${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `   ${spyBias}`,
    `───────────────────────────────`,
    `😨 ${vixLine}`,
    `───────────────────────────────`,
    calBrief.line,
    calBrief.hasHighImpact ? `🕐 ${calBrief.entryRule}` : null,
    `───────────────────────────────`,
    `📈 TOP MOVERS:`,
    ...gainers.map(t => `   ${t.ticker.padEnd(5)} $${t.price}  ${t.arrow} ${t.changePct}%`),
    `📉 WEAKEST:`,
    ...losers.map(t =>  `   ${t.ticker.padEnd(5)} $${t.price}  ${t.arrow} ${t.changePct}%`),
    `───────────────────────────────`,
    `💰 Max premium $2.40  |  Max loss $120`,
    `📏 ≤$1.20 = 2 contracts  |  $1.21–2.40 = 1`,
    `⏰ 9:30AM–4PM ET`,
    `👁️  Watching ${resolver.WATCHLIST.size} tickers`,
    `───────────────────────────────`,
    `🎯 4AM candle = daily bias`,
    `   Real direction confirms at 9:30AM open`,
    `───────────────────────────────`,
    `🔥 CONVICTION FILTER ACTIVE`,
    `   SigScore 0.7+ | Sweeps > Blocks`,
    `   Vol/OI 2x+ | Premium $100K+`,
    `   Need 2/4 signals to fire alert`,
    `───────────────────────────────`,
    `👑 KING NODE DETECTION ACTIVE`,
    `   Sweep at King Node = Maximum Conviction`,
    `───────────────────────────────`,
    `🌊 FLOW AGGREGATOR ACTIVE`,
    `   Cluster alerts at $500K, $1M, $2M`,
  ].filter(l => l !== null);

  await sendDiscord(lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendDiscord(`ℹ️ STRATUM SYSTEM\n${msg}`);
}

module.exports = {
  sendTradeAlert,
  sendMorningBrief,
  sendSystemMessage,
  checkHighConviction,
  sendDiscordRaw,
};
