// alerter.js — Stratum Flow Scout v7
// 3 Discord channels + Public.com live prices
// ─────────────────────────────────────────────────────────────────

const fetch      = require('node-fetch');
const resolver   = require('./contractResolver');
const calendar   = require('./economicCalendar');
const classifier = require('./tradeClassifier');

// ── DISCORD CHANNELS ──────────────────────────────────────────────
const WEBHOOKS = {
  strat:      process.env.DISCORD_WEBHOOK_URL,
  flow:       process.env.DISCORD_FLOW_WEBHOOK_URL,
  conviction: process.env.DISCORD_CONVICTION_WEBHOOK_URL,
};

async function sendToChannel(channel, message) {
  const webhookUrl = WEBHOOKS[channel];
  if (!webhookUrl) { console.log(`[DISCORD] No webhook for ${channel}`); return false; }
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + message + '\n```',
        username: 'Stratum Flow Scout',
      }),
    });
    if (res.ok) { console.log(`[DISCORD] Sent to #${channel} ✅`); return true; }
    console.error(`[DISCORD] Failed ${channel}:`, res.status);
    return false;
  } catch (err) {
    console.error(`[DISCORD] Error ${channel}:`, err.message);
    return false;
  }
}

async function sendDiscordRaw(message) {
  await sendToChannel('strat', message);
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

// ── PUBLIC.COM LIVE PRICE ─────────────────────────────────────────
async function getPublicQuote(ticker) {
  try {
    const apiKey    = process.env.PUBLIC_API_KEY;
    const accountId = process.env.PUBLIC_ACCOUNT_ID;
    if (!apiKey || !accountId) return null;

    const res  = await fetch(
      `https://api.public.com/userapigateway/marketdata/${accountId}/quotes`,
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          instruments: [{ symbol: ticker, type: 'EQUITY' }],
        }),
      }
    );
    const data  = await res.json();
    const quote = data?.quotes?.[0];
    if (!quote || quote.outcome !== 'SUCCESS') return null;
    return quote;
  } catch { return null; }
}

// ── POLYGON FALLBACK ──────────────────────────────────────────────
async function getTickerSnapshotPolygon(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;

    const prevRes   = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`);
    const prevData  = await prevRes.json();
    const prevClose = prevData?.results?.[0]?.c || null;

    const snapRes  = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`);
    const snapData = await snapRes.json();
    const snap     = snapData?.ticker;

    const price = snap?.lastTrade?.p || snap?.min?.c || snap?.day?.close
               || snap?.day?.open || snap?.prevDay?.c || prevClose || null;

    const base = prevClose || price;
    if (!price || !base) return null;

    const change    = (price - base).toFixed(2);
    const changePct = ((price - base) / base * 100).toFixed(2);
    const arrow     = parseFloat(change) >= 0 ? '▲' : '▼';

    return { ticker, price: parseFloat(price).toFixed(2), change, changePct, arrow, prevClose: parseFloat(base).toFixed(2) };
  } catch { return null; }
}

// ── MAIN TICKER SNAPSHOT — Public first, Polygon fallback ─────────
async function getTickerSnapshot(ticker) {
  try {
    const quote = await getPublicQuote(ticker);
    if (quote) {
      const price     = parseFloat(quote.last);
      const bid       = parseFloat(quote.bid  || quote.last);
      const ask       = parseFloat(quote.ask  || quote.last);
      const mid       = ((bid + ask) / 2);
      const change    = (price - mid).toFixed(2);
      const changePct = mid > 0 ? ((price - mid) / mid * 100).toFixed(2) : '0.00';
      const arrow     = parseFloat(change) >= 0 ? '▲' : '▼';
      console.log(`[PUBLIC] ${ticker} live: $${price}`);
      return { ticker, price: price.toFixed(2), change, changePct, arrow, prevClose: mid.toFixed(2), bid: bid.toFixed(2), ask: ask.toFixed(2), live: true };
    }
  } catch { }
  return getTickerSnapshotPolygon(ticker);
}

async function getSpyPremarket() {
  const snap = await getTickerSnapshot('SPY');
  if (!snap) return null;
  return { ...snap, label: `SPY $${snap.price} ${snap.arrow} ${snap.changePct}%` };
}

async function getVIX() {
  try {
    const snap = await getTickerSnapshot('UVXY');
    if (!snap) return null;
    const price  = parseFloat(snap.price);
    const change = snap.change;
    const arrow  = snap.arrow;
    const level  = price >= 30 ? 'EXTREME — reduce size 🚨'
                 : price >= 20 ? 'ELEVATED — be careful ⚠️'
                 : price >= 15 ? 'NORMAL ✅'
                 : 'LOW — watch for spike';
    return { price: snap.price, change, arrow, level };
  } catch { return null; }
}

async function getWatchlistSnapshots() {
  const tickers = [...resolver.WATCHLIST];
  const results = [];
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const snaps = await Promise.all(batch.map(t => getTickerSnapshot(t)));
    snaps.forEach(snap => { if (snap) results.push(snap); });
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ── FLOW SCORING — WIDE NET ───────────────────────────────────────
function scoreFlow(flowData = {}) {
  const flags     = [];
  let score       = 0;
  const orderType = (flowData.orderType || '').toUpperCase();
  const premium   = parseFloat(flowData.totalPremium || 0);
  const alertName = (flowData.alertName || '').toLowerCase();

  if (orderType === 'SWEEP')      { score += 2; flags.push('⚡ SWEEP'); }
  else if (orderType === 'BLOCK') { score += 1; flags.push('■ BLOCK'); }

  if (premium >= 1000000)         { score += 4; flags.push(`💰 $${(premium/1000000).toFixed(1)}M — WHALE`); }
  else if (premium >= 500000)     { score += 3; flags.push(`💰 $${(premium/1000).toFixed(0)}K — LARGE`); }
  else if (premium >= 100000)     { score += 2; flags.push(`💰 $${(premium/1000).toFixed(0)}K — institutional`); }
  else if (premium >= 25000)      { score += 1; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }

  if (alertName.includes('urgent') || alertName.includes('whale') || alertName.includes('giant')) {
    score += 2; flags.push(`🔥 ${flowData.alertName}`);
  } else if (alertName.includes('sweep') || alertName.includes('sizable') || alertName.includes('explosive')) {
    score += 1; flags.push(`📡 ${flowData.alertName}`);
  }

  const label = score >= 6 ? '🔥 MAXIMUM CONVICTION'
               : score >= 4 ? '✅ HIGH CONVICTION'
               : score >= 2 ? '📡 NOTABLE FLOW'
               : '📊 FLOW DETECTED';

  return { score, flags, label, isHighConviction: score >= 4 };
}

// ── CONVICTION TRACKING ───────────────────────────────────────────
const recentFlowTickers = new Map();
const recentStratTickers = new Map();

// ── BUILD ALERT CARD ──────────────────────────────────────────────
async function buildAlertCard(opraSymbol, tvData = {}, flowConviction = null, isStratSignal = false) {
  const contract = await resolver.findBestContract(opraSymbol);
  if (contract.error) { console.log('[ALERT]', contract.error); return null; }

  const sizing = resolver.calculatePositionSize(contract.premium);
  if (!sizing.viable) { console.log('[ALERT] Sizing:', sizing.reason); return null; }

  const dte = calcDTE(contract.expiry);

  const tfData = {
    monthly: tvData.monthly || null,
    weekly:  tvData.weekly  || null,
    daily:   tvData.daily   || null,
    h4:      tvData.h4      || null,
    h1:      tvData.h1      || null,
    m15:     tvData.m15     || null,
  };

  const tradeType  = classifier.classifyTrade(tfData, dte, contract.type);
  const confluence = classifier.getConfluenceScore(tfData, contract.type === 'put' ? 'bearish' : 'bullish');

  const { ticker, strike, type, expiry, premium, score } = contract;
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const grade     = score.total >= 9 ? '🔥 A+ EXECUTE'
                  : score.total >= 7 ? '✅ A  STRONG'
                  : score.total >= 5 ? '⚠️ B  CAUTION'
                  : '❌ C  SKIP';

  const tfLine      = Object.entries(tfData).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()}:${v}`).join('  ');
  const sweepAtKing = flowConviction?.flags?.some(f => f.includes('SWEEP')) && contract.volumeProfile?.nearKing;

  // Get live price from Public
  const liveSnap  = await getTickerSnapshot(ticker);
  const priceInfo = liveSnap?.live
    ? `$${liveSnap.price} LIVE (bid $${liveSnap.bid} / ask $${liveSnap.ask})`
    : liveSnap ? `$${liveSnap.price} (15min delay)`
    : 'price unavailable';

  const alertLabel = isStratSignal && flowConviction?.score > 0
    ? '👑 CONVICTION TRADE'
    : isStratSignal ? '📊 STRAT SIGNAL'
    : '🌊 FLOW ALERT';

  const lines = [
    `${alertLabel} — ${tradeType.label} [LIVE]`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction} — ${dte}DTE`,
    `Stock   ${priceInfo}`,
    sweepAtKing ? `👑⚡ SWEEP AT KING NODE — MAXIMUM CONVICTION` : null,
    `═══════════════════════════════`,
    `Score   ${scoreBar(score.total, score.max)}`,
    `Grade   ${grade}`,
    `Prob    ~${score.profitProb}% profit probability`,
    `───────────────────────────────`,
    flowConviction ? `Flow    ${flowConviction.label}` : null,
    ...(flowConviction?.flags || []).map(f => `        ${f}`),
    confluence.total > 0 ? `TF Conf ${confluence.label}` : null,
    tfLine ? `Bias    ${tfLine}` : null,
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
    contract.kingNodeLine || null,
    `───────────────────────────────`,
    `Hold    ${tradeType.holdRules}`,
    `Stop    ${tradeType.stopRule}`,
    score.warnings.length > 0 ? `───────────────────────────────` : null,
    ...score.warnings.map(w => `⚠️  ${w}`),
    `───────────────────────────────`,
    `⏰ Window: 9:30AM–4PM ET`,
  ].filter(l => l !== null && l !== undefined);

  return { card: lines.join('\n'), ticker, type, contract, tradeType };
}

// ── STRAT ALERT → #strat-alerts ──────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}) {
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', `⏸️ STRATUM BLOCKED\n${calCheck.reason}`);
    return false;
  }

  const result = await buildAlertCard(opraSymbol, tvData, null, true);
  if (!result) return false;

  await sendToChannel('strat', result.card);

  // Track for conviction matching
  const key = `${result.ticker}:${result.type}`;
  recentStratTickers.set(key, Date.now());
  setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);

  // Both signals aligned → conviction
  if (recentFlowTickers.has(key)) {
    const convCard = result.card.replace('📊 STRAT SIGNAL', '👑 CONVICTION TRADE');
    await sendToChannel('conviction', convCard);
    console.log(`[CONVICTION] Both signals on ${result.ticker} ✅`);
  }

  return true;
}

// ── FLOW ALERT → #flow-alerts ─────────────────────────────────────
async function sendFlowAlert(opraSymbol, flowData = {}) {
  console.log('[FLOW] Processing:', opraSymbol);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return false;

  const flowConviction = scoreFlow(flowData);

  // Track for conviction matching
  const key = `${parsed.ticker}:${parsed.type}`;
  recentFlowTickers.set(key, Date.now());
  setTimeout(() => recentFlowTickers.delete(key), 30 * 60 * 1000);

  // Get live price
  const liveSnap  = await getTickerSnapshot(parsed.ticker);
  const priceInfo = liveSnap?.live
    ? `$${liveSnap.price} LIVE`
    : liveSnap ? `$${liveSnap.price} (delayed)` : '—';

  const premium   = parseFloat(flowData.totalPremium || 0);
  const orderType = (flowData.orderType || 'UNKNOWN').toUpperCase();
  const alertName = flowData.alertName || '';

  const lines = [
    `🌊 FLOW ALERT — ${parsed.ticker} ${parsed.type.toUpperCase()}`,
    `${parsed.ticker} $${parsed.strike}${parsed.type === 'call' ? 'C' : 'P'} ${parsed.expiry.slice(5).replace('-', '/')}`,
    `Stock   ${priceInfo}`,
    `═══════════════════════════════`,
    `Flow    ${flowConviction.label}`,
    ...flowConviction.flags.map(f => `        ${f}`),
    `───────────────────────────────`,
    `Premium $${premium >= 1000000 ? (premium/1000000).toFixed(1)+'M' : (premium/1000).toFixed(0)+'K'}`,
    `Type    ${orderType}`,
    `Alert   ${alertName}`,
    `Strike  $${parsed.strike} ${parsed.type.toUpperCase()}`,
    `Expiry  ${parsed.expiry}`,
    `───────────────────────────────`,
    `👁️ Watch for Strat confirmation`,
    `⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
  ].filter(Boolean);

  await sendToChannel('flow', lines.join('\n'));

  // High conviction → full card
  if (flowConviction.isHighConviction) {
    const calCheck = await calendar.shouldBlockAlert();
    if (!calCheck.block) {
      const result = await buildAlertCard(opraSymbol, {}, flowConviction, false);
      if (result) {
        await sendToChannel('flow', result.card);
        // Both signals → conviction
        if (recentStratTickers.has(key)) {
          await sendToChannel('conviction', result.card.replace('🌊 FLOW ALERT', '👑 CONVICTION TRADE'));
          console.log(`[CONVICTION] Both signals on ${parsed.ticker} ✅`);
        }
      }
    }
  }

  return true;
}

// ── LEGACY WRAPPER ────────────────────────────────────────────────
async function sendTradeAlert(opraSymbol, tvData = {}, flowData = {}, isStratSignal = false) {
  if (isStratSignal) return sendStratAlert(opraSymbol, tvData);
  return sendFlowAlert(opraSymbol, flowData);
}

// ── MORNING BRIEF → #strat-alerts ────────────────────────────────
async function sendMorningBrief() {
  console.log('[BRIEF] Building morning brief...');

  const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });

  const [spy, vix, calBrief, watchlistSnaps] = await Promise.all([
    getSpyPremarket(), getVIX(), calendar.getCalendarBriefLine(), getWatchlistSnapshots(),
  ]);

  const spyLine = spy
    ? `SPY  $${spy.price} ${spy.live ? '🟢LIVE' : '⏱delay'} ${spy.arrow} ${spy.changePct}%`
    : 'SPY  — unavailable';
  const spyBias = spy && parseFloat(spy.changePct) <= -0.5 ? '🔴 Pre-mkt BEARISH — lean PUTS'
                : spy && parseFloat(spy.changePct) >= 0.5  ? '🟢 Pre-mkt BULLISH — lean CALLS'
                : '➡️  Flat — wait for 9:30AM open direction';
  const vixLine = vix
    ? `UVXY $${vix.price} ${vix.arrow} ${vix.change}  ${vix.level}`
    : 'VIX  — unavailable';

  const sorted  = [...watchlistSnaps].sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct));
  const gainers = sorted.filter(t => parseFloat(t.changePct) > 0).slice(0, 3);
  const losers  = sorted.filter(t => parseFloat(t.changePct) < 0).slice(-3).reverse();

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
    gainers.length ? `📈 TOP MOVERS:` : null,
    ...gainers.map(t => `   ${t.ticker.padEnd(5)} $${t.price}  ${t.arrow} ${t.changePct}%`),
    losers.length  ? `📉 WEAKEST:` : null,
    ...losers.map(t =>  `   ${t.ticker.padEnd(5)} $${t.price}  ${t.arrow} ${t.changePct}%`),
    `───────────────────────────────`,
    `💰 Max premium $2.40  |  Max loss $120`,
    `📏 ≤$1.20 = 2 contracts  |  $1.21–2.40 = 1`,
    `⏰ 9:30AM–4PM ET  |  👁️ 20 tickers + all flow`,
    `───────────────────────────────`,
    `📊 #strat-alerts      — Chart confirmations`,
    `🌊 #flow-alerts       — All unusual flow`,
    `👑 #conviction-trades — Both aligned = execute`,
  ].filter(l => l !== null);

  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', `ℹ️ STRATUM SYSTEM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };
