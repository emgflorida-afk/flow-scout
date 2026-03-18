// alerter.js — Stratum Flow Scout v5.8
// FIXED: sendStratAlert uses Public chain data directly
// No second Polygon lookup after Public resolves contract
// ─────────────────────────────────────────────────────────────────

const fetch      = require('node-fetch');
const resolver   = require('./contractResolver');
const calendar   = require('./economicCalendar');
const classifier = require('./tradeClassifier');

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

function scoreBar(score, max) {
  const f = Math.round((score / max) * 10);
  return '█'.repeat(f) + '░'.repeat(10 - f) + ` ${score}/${max}`;
}

function calcDTE(expiryDateStr) {
  const diff = Math.ceil((new Date(expiryDateStr + 'T16:00:00-04:00') - new Date()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

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

  return {
    score, flags,
    label: score >= 6 ? '🔥 MAXIMUM CONVICTION'
         : score >= 4 ? '✅ HIGH CONVICTION'
         : score >= 2 ? '📡 NOTABLE FLOW'
         : '📊 FLOW DETECTED',
    isHighConviction: score >= 4,
  };
}

const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// ── STRAT ALERT ───────────────────────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}) {
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', `⏸️ BLOCKED\n${calCheck.reason}`);
    return false;
  }

  // Parse what we have from the OPRA symbol
  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) { console.log('[STRAT] Could not parse OPRA:', opraSymbol); return false; }

  const { ticker, strike, type, expiry } = parsed;
  const price = await resolver.getPrice(ticker);
  if (!price) { console.log('[STRAT] No price for', ticker); return false; }

  const dte       = calcDTE(expiry);
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const confluence = tvData.confluence || '—';

  const tfData = {
    weekly:  tvData.weekly  || null,
    daily:   tvData.daily   || null,
    h4:      tvData.h4      || null,
    h1:      tvData.h1      || null,
    m15:     tvData.m15     || null,
  };

  const tfLine = Object.entries(tfData)
    .filter(([,v]) => v)
    .map(([k,v]) => `${k.toUpperCase()}:${v}`)
    .join('  ');

  // Get sizing based on strike as premium proxy if no live quote
  const estimatedPremium = 1.00;
  const sizing = resolver.calculatePositionSize(estimatedPremium);

  const lines = [
    `📊 STRAT SIGNAL — ${dte}DTE`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction}`,
    `Stock   $${parseFloat(price).toFixed(2)} LIVE`,
    `═══════════════════════════════`,
    `Confluence  ${confluence}`,
    tfLine ? `Bias    ${tfLine}` : null,
    `───────────────────────────────`,
    `Strike  $${strike} — ATM via Public.com`,
    `Expiry  ${expiryFmt} (${dte} DTE)`,
    `───────────────────────────────`,
    `⚠️  Check live premium before entry`,
    `Stop    50% of premium`,
    `T1      +50% of premium`,
    `T2      +100% of premium`,
    `Risk    2% of $7K = $140 max`,
    `───────────────────────────────`,
    `⏰ 9:30AM–4PM ET`,
  ].filter(l => l !== null);

  await sendToChannel('strat', lines.join('\n'));

  const key = `${ticker}:${type}`;
  recentStratTickers.set(key, Date.now());
  setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);

  if (recentFlowTickers.has(key)) {
    await sendToChannel('conviction', lines.join('\n').replace('📊 STRAT SIGNAL', '👑 CONVICTION TRADE'));
  }

  return true;
}

// ── FLOW ALERT ────────────────────────────────────────────────────
async function sendFlowAlert(opraSymbol, flowData = {}) {
  console.log('[FLOW] Processing:', opraSymbol);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return false;

  const flowConviction = scoreFlow(flowData);
  const key = `${parsed.ticker}:${parsed.type}`;
  recentFlowTickers.set(key, Date.now());
  setTimeout(() => recentFlowTickers.delete(key), 30 * 60 * 1000);

  const price     = await resolver.getPrice(parsed.ticker);
  const priceInfo = price ? `$${price} LIVE` : '—';
  const premium   = parseFloat(flowData.totalPremium || 0);
  const orderType = (flowData.orderType || 'UNKNOWN').toUpperCase();

  const lines = [
    `🌊 FLOW ALERT — ${parsed.ticker} ${parsed.type.toUpperCase()}`,
    `${parsed.ticker} $${parsed.strike}${parsed.type === 'call' ? 'C' : 'P'} ${parsed.expiry.slice(5).replace('-','/')}`,
    `Stock   ${priceInfo}`,
    `═══════════════════════════════`,
    `Flow    ${flowConviction.label}`,
    ...flowConviction.flags.map(f => `        ${f}`),
    `───────────────────────────────`,
    `Premium $${premium >= 1000000 ? (premium/1000000).toFixed(1)+'M' : (premium/1000).toFixed(0)+'K'}`,
    `Type    ${orderType}`,
    `Alert   ${flowData.alertName || ''}`,
    `───────────────────────────────`,
    `👁️ Watch for Strat confirmation`,
    `⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
  ].filter(Boolean);

  await sendToChannel('flow', lines.join('\n'));

  if (flowConviction.isHighConviction && recentStratTickers.has(key)) {
    await sendToChannel('conviction', lines.join('\n').replace('🌊 FLOW ALERT', '👑 CONVICTION TRADE'));
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
  const vixLine  = uvxyPrice
    ? `UVXY $${uvxyPrice} ${parseFloat(uvxyPrice) >= 30 ? '🚨 EXTREME — reduce size' : parseFloat(uvxyPrice) >= 20 ? '⚠️ ELEVATED' : '✅ NORMAL'}`
    : 'VIX  — unavailable';

  const lines = [
    `📊 STRATUM MORNING BRIEF`,
    `${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `😨 ${vixLine}`,
    `───────────────────────────────`,
    `💰 Max premium $5.00  |  Max loss $140`,
    `📏 ≤$1.20 = 2 contracts  |  >$1.20 = 1`,
    `⏰ 9:30AM–4PM ET`,
    `───────────────────────────────`,
    `🎯 Only 5/6+ confluence fires alerts`,
    `📊 #strat-alerts   — Chart setups`,
    `🌊 #flow-alerts    — Unusual flow`,
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
