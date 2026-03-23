// alerter.js — Stratum Flow Scout v5.8
// FIXED: Live premium from resolveContract mid price
// Shows exact Entry, Stop, T1, T2 dollar amounts
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
  const url = WEBHOOKS[channel];
  if (!url) { console.log(`[DISCORD] No webhook for ${channel}`); return false; }
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum' }),
    });
    if (res.ok) { console.log(`[DISCORD] Sent to #${channel} ✅`); return true; }
    console.error(`[DISCORD] Failed ${channel}:`, res.status);
    return false;
  } catch (err) { console.error(`[DISCORD] Error:`, err.message); return false; }
}

async function sendDiscordRaw(msg) { await sendToChannel('strat', msg); }

function calcDTE(expiryDateStr) {
  const diff = Math.ceil((new Date(expiryDateStr + 'T16:00:00-04:00') - new Date()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

// ── FLOW SCORING ──────────────────────────────────────────────────
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
  else if (premium >= 100000)     { score += 2; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }
  else if (premium >= 25000)      { score += 1; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }

  if (alertName.includes('urgent') || alertName.includes('whale') || alertName.includes('giant')) {
    score += 2; flags.push(`🔥 ${flowData.alertName}`);
  } else if (alertName.includes('sweep') || alertName.includes('sizable')) {
    score += 1; flags.push(`📡 ${flowData.alertName}`);
  }

  const label = score >= 6 ? '🔥 MAXIMUM CONVICTION'
               : score >= 4 ? '✅ HIGH CONVICTION'
               : score >= 2 ? '📡 NOTABLE FLOW'
               : '📊 FLOW DETECTED';

  return { score, flags, label, isHighConviction: score >= 4 };
}

// ── CONVICTION TRACKING ───────────────────────────────────────────
const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// ── POSITION SIZING ───────────────────────────────────────────────
function calcSizing(premium, accountSize = 7000) {
  if (!premium || premium <= 0) return null;
  const maxLoss         = accountSize * 0.02;
  const costPerContract = premium * 100;
  const contracts       = premium <= 1.20 ? 2 : 1;
  const stopPrice       = parseFloat((premium * 0.50).toFixed(2));
  const t1Price         = parseFloat((premium * 1.50).toFixed(2));
  const t2Price         = parseFloat((premium * 2.00).toFixed(2));
  const stopLoss        = parseFloat((costPerContract * 0.50 * contracts).toFixed(0));
  const t1Profit        = parseFloat(((t1Price - premium) * 100 * contracts).toFixed(0));
  const riskPct         = parseFloat((stopLoss / accountSize * 100).toFixed(1));

  if (stopLoss > maxLoss) return null;

  return { contracts, premium, costPerContract, stopPrice, t1Price, t2Price, stopLoss, t1Profit, riskPct };
}

// ── BUILD STRAT ALERT CARD ────────────────────────────────────────
function buildStratCard(opraSymbol, tvData = {}) {
  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return null;

  const { ticker, expiry, type, strike } = parsed;
  const dte       = calcDTE(expiry);
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const dteLabel  = dte === 0 ? '0DTE' : dte === 1 ? '1DTE' : `${dte}DTE`;

  // Use mid price passed from resolveContract via tvData
  const premium = tvData.mid || null;
  const sizing  = premium ? calcSizing(premium) : null;

  const confluence = tvData.confluence || '';
  const tfLine = [
    tvData.weekly ? `WEEKLY:${tvData.weekly}` : null,
    tvData.daily  ? `DAILY:${tvData.daily}`   : null,
    tvData.h4     ? `H4:${tvData.h4}`         : null,
    tvData.h1     ? `H1:${tvData.h1}`         : null,
  ].filter(Boolean).join('  ');

  const livePrice = tvData.stockPrice || null;

  const lines = [
    `📊 STRAT SIGNAL — ${dteLabel}`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction}`,
    livePrice ? `Stock   $${livePrice} LIVE` : null,
    `═══════════════════════════════`,
    confluence ? `Confluence  ${confluence}` : null,
    tfLine     ? `Bias    ${tfLine}` : null,
    `───────────────────────────────`,
    `Strike  $${strike} — ATM via Public.com`,
    `Expiry  ${expiryFmt} (${dteLabel})`,
    sizing ? `Bid/Ask $${tvData.bid?.toFixed(2) || '—'} / $${tvData.ask?.toFixed(2) || '—'}` : null,
    `───────────────────────────────`,
    sizing ? `Entry   $${sizing.premium.toFixed(2)} x${sizing.contracts} = $${(sizing.costPerContract * sizing.contracts).toFixed(0)}` : '⚠️  Check live premium before entry',
    sizing ? `Stop    $${sizing.stopPrice} (loss -$${sizing.stopLoss})` : `Stop    50% of premium`,
    sizing ? `T1      $${sizing.t1Price} (profit +$${sizing.t1Profit})` : `T1      +50% of premium`,
    sizing ? `T2      $${sizing.t2Price} (runner)` : `T2      +100% of premium`,
    sizing ? `Risk    ${sizing.riskPct}% of $7K = $${sizing.stopLoss} max` : `Risk    2% of $7K = $140 max`,
    `───────────────────────────────`,
    `⏰ 9:30AM–4PM ET`,
  ].filter(l => l !== null);

  return lines.join('\n');
}

// ── STRAT ALERT → #strat-alerts ──────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}) {
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', `⏸️ BLOCKED\n${calCheck.reason}`);
    return false;
  }

  const card = buildStratCard(opraSymbol, tvData);
  if (!card) { console.log('[STRAT] Could not build card'); return false; }

  await sendToChannel('strat', card);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (parsed) {
    const key = `${parsed.ticker}:${parsed.type}`;
    recentStratTickers.set(key, Date.now());
    setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);
    if (recentFlowTickers.has(key)) {
      await sendToChannel('conviction', card.replace('📊 STRAT SIGNAL', '👑 CONVICTION TRADE'));
      console.log(`[CONVICTION] Both signals on ${parsed.ticker} ✅`);
    }
  }

  return true;
}

// ── FLOW ALERT → #flow-alerts ─────────────────────────────────────
async function sendFlowAlert(opraSymbol, flowData = {}) {
  console.log('[FLOW] Processing:', opraSymbol);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return false;

  const flowConviction = scoreFlow(flowData);
  const key = `${parsed.ticker}:${parsed.type}`;
  recentFlowTickers.set(key, Date.now());
  setTimeout(() => recentFlowTickers.delete(key), 30 * 60 * 1000);

  const price   = await resolver.getPrice(parsed.ticker);
  const premium = parseFloat(flowData.totalPremium || 0);

  const lines = [
    `🌊 FLOW ALERT — ${parsed.ticker} ${parsed.type.toUpperCase()}`,
    `${parsed.ticker} $${parsed.strike}${parsed.type === 'call' ? 'C' : 'P'} ${parsed.expiry.slice(5).replace('-','/')}`,
    price ? `Stock   $${price} LIVE` : null,
    `═══════════════════════════════`,
    `Flow    ${flowConviction.label}`,
    ...flowConviction.flags.map(f => `        ${f}`),
    `───────────────────────────────`,
    `Premium $${premium >= 1000000 ? (premium/1000000).toFixed(1)+'M' : (premium/1000).toFixed(0)+'K'}`,
    `Type    ${(flowData.orderType || 'UNKNOWN').toUpperCase()}`,
    flowData.alertName ? `Alert   ${flowData.alertName}` : null,
    `───────────────────────────────`,
    `👁️ Watch for Strat confirmation`,
    `⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
  ].filter(Boolean);

  await sendToChannel('flow', lines.join('\n'));

  if (flowConviction.isHighConviction) {
    const calCheck = await calendar.shouldBlockAlert();
    if (!calCheck.block) {
      const resolved = await resolver.resolveContract(parsed.ticker, parsed.type);
      if (resolved) {
        const card = buildStratCard(resolved.symbol, { mid: resolved.mid, bid: resolved.bid, ask: resolved.ask });
        if (card) {
          await sendToChannel('flow', card.replace('📊 STRAT SIGNAL', '🌊 FLOW — HIGH CONVICTION'));
          if (recentStratTickers.has(key)) {
            await sendToChannel('conviction', card.replace('📊 STRAT SIGNAL', '👑 CONVICTION TRADE'));
          }
        }
      }
    }
  }

  return true;
}

// ── MAIN WRAPPER ──────────────────────────────────────────────────
async function sendTradeAlert(opraSymbol, tvData = {}, flowData = {}, isStratSignal = false) {
  if (isStratSignal) return sendStratAlert(opraSymbol, tvData);
  return sendFlowAlert(opraSymbol, flowData);
}

// ── MORNING BRIEF ─────────────────────────────────────────────────
async function sendMorningBrief() {
  console.log('[BRIEF] Building morning brief...');

  const dateStr   = new Date().toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });
  const spyPrice  = await resolver.getPrice('SPY');
  const uvxyPrice = await resolver.getPrice('UVXY');

  const spyLine  = spyPrice  ? `SPY  $${spyPrice} LIVE` : 'SPY  — unavailable';
  const vixLevel = uvxyPrice
    ? parseFloat(uvxyPrice) >= 30 ? '🚨 EXTREME — reduce size'
    : parseFloat(uvxyPrice) >= 20 ? '⚠️ ELEVATED — be careful'
    : '✅ NORMAL'
    : '';
  const vixLine  = uvxyPrice ? `UVXY $${uvxyPrice} ${vixLevel}` : 'VIX  — unavailable';
  const spyBias  = spyPrice ? '➡️  Wait for 9:30AM open direction' : '➡️  Unavailable pre-market';

  const lines = [
    `📊 STRATUM MORNING BRIEF`,
    `${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `   ${spyBias}`,
    `───────────────────────────────`,
    `😨 ${vixLine}`,
    `───────────────────────────────`,
    `💰 Max premium $5.00  |  Max loss $140`,
    `📏 ≤$1.20 = 2 contracts  |  >$1.20 = 1`,
    `⏰ 9:30AM–4PM ET`,
    `───────────────────────────────`,
    `🎯 Only 5/6+ confluence fires alerts`,
    `📊 #strat-alerts      — Chart setups`,
    `🌊 #flow-alerts       — Unusual flow`,
    `👑 #conviction-trades — Execute`,
  ];

  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', `ℹ️ STRATUM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };
```

---

## 📋 3 Steps

**①** GitHub → `src/contractResolver.js` → select all → paste → **Commit**

**②** GitHub → `src/server.js` → select all → paste → **Commit**

**③** GitHub → `src/alerter.js` → select all → paste → **Commit**

Next alert will show exact dollar figures:
```
Entry   $0.83 x2 = $166
Stop    $0.42 (loss -$84)
T1      $1.25 (profit +$84)
T2      $1.66 (runner)
Risk    1.2% of $7K
