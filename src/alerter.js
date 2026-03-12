// alerter.js — Stratum Flow Scout v6
// NEW: Trade classification (DAY/SWING/LOTTO), combo detection,
//      confluence scoring, strategy detection (322, 4HR, Failed9)
// UPDATED: Full morning brief — SPY pre-market, VIX, movers, calendar
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

// ── PRE-MARKET DATA ───────────────────────────────────────────────
async function getTickerSnapshot(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;
    const url  = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    const snap = data?.ticker;
    if (!snap) return null;

    // Pre-market price if available, fall back to day open, then prev close
    const price     = snap.min?.o || snap.day?.open || snap.lastTrade?.p || snap.prevDay?.c || null;
    if (!price) return null;
    const prevClose = snap.prevDay?.c || price;
    const change    = (price - prevClose).toFixed(2);
    const changePct = ((price - prevClose) / prevClose * 100).toFixed(2);
    const arrow     = parseFloat(change) >= 0 ? '▲' : '▼';
    return {
      ticker,
      price:     parseFloat(price).toFixed(2),
      change,
      changePct,
      arrow,
      prevClose: parseFloat(prevClose).toFixed(2),
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
    // Use UVXY as VIX proxy (Polygon doesn't serve $VIX directly on Starter)
    const url  = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/UVXY?apiKey=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    const snap = data?.ticker;
    if (!snap) return null;
    const price  = snap.day?.close || snap.lastTrade?.p || null;
    const prev   = snap.prevDay?.c || price;
    if (!price) return null;
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

  // Batch 5 at a time — avoid rate limits
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const snaps = await Promise.all(batch.map(t => getTickerSnapshot(t)));
    snaps.forEach((snap, idx) => {
      if (snap) results.push(snap);
    });
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
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
// Fires at 9:15AM ET every weekday
async function sendMorningBrief() {
  console.log('[BRIEF] Building morning brief...');

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });

  // Fetch everything in parallel
  const [spy, vix, calBrief, watchlistSnaps] = await Promise.all([
    getSpyPremarket(),
    getVIX(),
    calendar.getCalendarBriefLine(),
    getWatchlistSnapshots(),
  ]);

  // SPY
  const spyLine = spy
    ? `SPY  $${spy.price} ${spy.arrow} ${spy.changePct}%  (prev $${spy.prevClose})`
    : 'SPY  — unavailable';
  const spyBias = spy && parseFloat(spy.changePct) <= -0.5
    ? '🔴 Pre-mkt BEARISH — lean PUTS'
    : spy && parseFloat(spy.changePct) >= 0.5
    ? '🟢 Pre-mkt BULLISH — lean CALLS'
    : '➡️  Flat — wait for 10AM candle direction';

  // VIX / UVXY
  const vixLine = vix
    ? `UVXY $${vix.price} ${vix.arrow} ${vix.change}  ${vix.level}`
    : 'VIX  — unavailable';

  // Top movers from watchlist
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
    `⏰ 10AM–11:30AM  |  3PM–3:45PM ET`,
    `👁️  Watching ${resolver.WATCHLIST.size} tickers`,
    `───────────────────────────────`,
    `🎯 4AM candle = daily bias`,
    `   Real direction confirms at 10AM open`,
  ].filter(l => l !== null);

  await sendDiscord(lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendDiscord(`ℹ️ STRATUM SYSTEM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage };
