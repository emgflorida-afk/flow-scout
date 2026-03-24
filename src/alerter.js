// alerter.js — Stratum Flow Scout v5.9
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// Spread card shows both legs, debit, max profit, max loss, breakeven
// ─────────────────────────────────────────────────────────────────

const fetch      = require('node-fetch');
const resolver   = require('./contractResolver');
const calendar   = require('./economicCalendar');

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

  if (premium >= 1000000)     { score += 4; flags.push(`💰 $${(premium/1000000).toFixed(1)}M — WHALE`); }
  else if (premium >= 500000) { score += 3; flags.push(`💰 $${(premium/1000).toFixed(0)}K — LARGE`); }
  else if (premium >= 100000) { score += 2; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }
  else if (premium >= 25000)  { score += 1; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }

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

const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// ── BUILD SPREAD CARD ─────────────────────────────────────────────
function buildSpreadCard(resolved, tvData = {}) {
  const parsed    = resolver.parseOPRA(resolved.symbol);
  if (!parsed) return null;

  const { ticker, expiry, type } = parsed;
  const dte       = resolved.dte ?? calcDTE(expiry);
  const dteLabel  = `${dte}DTE`;
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const typeLabel = type === 'put' ? 'P' : 'C';

  const debit     = resolved.debit;
  const maxProfit = resolved.maxProfit;
  const breakeven = resolved.breakeven;
  const width     = resolved.spreadWidth;

  const sizing    = resolver.calculatePositionSize(debit, 'SPREAD', 7000, resolved);
  const s         = sizing?.viable ? sizing : null;

  const confluence = tvData.confluence || '';
  const tfLine = [
    tvData.weekly ? `WEEKLY:${tvData.weekly}` : null,
    tvData.daily  ? `DAILY:${tvData.daily}`   : null,
    tvData.h4     ? `H4:${tvData.h4}`         : null,
  ].filter(Boolean).join('  ');

  const lines = [
    `📊 SPREAD TRADE — ${dteLabel}`,
    `${ticker} $${resolved.strike}/$${resolved.sellStrike}${typeLabel} ${expiryFmt} — ${direction}`,
    `═══════════════════════════════`,
    confluence ? `Confluence  ${confluence}` : null,
    tfLine     ? `Bias    ${tfLine}` : null,
    `───────────────────────────────`,
    `BUY     ${ticker} $${resolved.strike}${typeLabel} ${expiryFmt}`,
    `SELL    ${ticker} $${resolved.sellStrike}${typeLabel} ${expiryFmt}`,
    `Width   $${width} spread`,
    `───────────────────────────────`,
    s ? `Debit   $${debit.toFixed(2)} x${s.contracts} = $${s.totalCost}` : `Debit   $${debit?.toFixed(2) || '—'}`,
    s ? `Max Loss    $${s.maxLoss} (debit paid)` : `Max Loss    $${(debit * 100).toFixed(0)}`,
    s ? `Max Profit  $${s.maxGain} ($${width} - debit)` : `Max Profit  $${(maxProfit * 100).toFixed(0)}`,
    `Breakeven   $${breakeven}`,
    `───────────────────────────────`,
    s ? `Stop    $${s.stopPrice} (50% of debit)` : `Stop    50% of debit`,
    s ? `T1      $${s.t1Price} (100% gain)` : `T1      +100% of debit`,
    s ? `Risk    ${s.riskPct}% of $7K = $${s.maxLoss}` : `Risk    defined`,
    `───────────────────────────────`,
    `Hold    1–3 days max`,
    `Window  9:30AM–4PM ET`,
    `⏰ ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
  ].filter(l => l !== null);

  return lines.join('\n');
}

// ── BUILD STRAT CARD ──────────────────────────────────────────────
function buildStratCard(opraSymbol, tvData = {}) {
  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return null;

  const { ticker, expiry, type, strike } = parsed;
  const dte       = tvData.dte ?? calcDTE(expiry);
  const direction = type === 'put' ? '🔴 BEARISH' : '🟢 BULLISH';
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const dteLabel  = dte === 0 ? '0DTE' : dte === 1 ? '1DTE' : `${dte}DTE`;

  const mode      = tvData.mode || 'SWING';
  const premium   = tvData.mid  || null;
  const sizing    = premium ? resolver.calculatePositionSize(premium, mode) : null;
  const s         = sizing?.viable ? sizing : null;

  const modeLabel = mode === 'DAY' ? '⚡ DAY TRADE' : '📈 SWING TRADE';

  const confluence = tvData.confluence || '';
  const tfLine = [
    tvData.weekly ? `WEEKLY:${tvData.weekly}` : null,
    tvData.daily  ? `DAILY:${tvData.daily}`   : null,
    tvData.h4     ? `H4:${tvData.h4}`         : null,
    tvData.h1     ? `H1:${tvData.h1}`         : null,
  ].filter(Boolean).join('  ');

  const lines = [
    `${modeLabel} — ${dteLabel}`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction}`,
    `═══════════════════════════════`,
    confluence ? `Confluence  ${confluence}` : null,
    tfLine     ? `Bias    ${tfLine}` : null,
    `───────────────────────────────`,
    `Strike  $${strike} — ATM via Public.com`,
    `Expiry  ${expiryFmt} (${dteLabel})`,
    tvData.bid && tvData.ask ? `Bid/Ask $${parseFloat(tvData.bid).toFixed(2)} / $${parseFloat(tvData.ask).toFixed(2)}` : null,
    `───────────────────────────────`,
    s ? `Entry   $${s.premium.toFixed(2)} x${s.contracts} = $${s.totalCost}` : '⚠️  Check live premium before entry',
    s ? `Stop    $${s.stopPrice} (loss -$${s.stopLoss})` : `Stop    40% of premium`,
    s ? `T1      $${s.t1Price} (profit +$${s.t1Profit})` : `T1      +60% of premium`,
    s ? `T2      $${s.t2Price} (runner)` : `T2      +120% of premium`,
    s ? `Risk    ${s.riskPct}% of $7K = $${s.stopLoss} max` : `Risk    2% of $7K max`,
    `───────────────────────────────`,
    mode === 'DAY' ? `Hold    Exit by 3:45PM ET same day` : `Hold    1–3 days max`,
    mode === 'DAY' ? `Window  10AM–11:30AM | 3PM–3:45PM` : `Window  9:30AM–4PM ET`,
    `⏰ ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
  ].filter(l => l !== null);

  return lines.join('\n');
}

// ── STRAT ALERT ───────────────────────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}, resolved = null) {
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', `⏸️ BLOCKED\n${calCheck.reason}`);
    return false;
  }

  // Use spread card if mode is SPREAD
  let card;
  if (tvData.mode === 'SPREAD' && resolved?.debit) {
    card = buildSpreadCard(resolved, tvData);
  } else {
    card = buildStratCard(opraSymbol, tvData);
  }

  if (!card) { console.log('[STRAT] Could not build card'); return false; }
  await sendToChannel('strat', card);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (parsed) {
    const key = `${parsed.ticker}:${parsed.type}`;
    recentStratTickers.set(key, Date.now());
    setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);
    if (recentFlowTickers.has(key)) {
      await sendToChannel('conviction', card
        .replace('📊 SPREAD TRADE', '👑 CONVICTION SPREAD')
        .replace('📈 SWING TRADE',  '👑 CONVICTION TRADE')
        .replace('⚡ DAY TRADE',    '👑 CONVICTION TRADE')
      );
      console.log(`[CONVICTION] Both signals on ${parsed.ticker} ✅`);
    }
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
      const resolved = await resolver.resolveContract(parsed.ticker, parsed.type, 'SWING');
      if (resolved) {
        const card = resolved.mode === 'SPREAD' && resolved.debit
          ? buildSpreadCard(resolved, {})
          : buildStratCard(resolved.symbol, { mid: resolved.mid, bid: resolved.bid, ask: resolved.ask, mode: resolved.mode, dte: resolved.dte });
        if (card) {
          await sendToChannel('flow', card.replace('📈 SWING TRADE', '🌊 FLOW — HIGH CONVICTION'));
          if (recentStratTickers.has(key)) {
            await sendToChannel('conviction', card.replace('📈 SWING TRADE', '👑 CONVICTION TRADE'));
          }
        }
      }
    }
  }
  return true;
}

// ── MAIN WRAPPER ──────────────────────────────────────────────────
async function sendTradeAlert(opraSymbol, tvData = {}, flowData = {}, isStratSignal = false, resolved = null) {
  if (isStratSignal) return sendStratAlert(opraSymbol, tvData, resolved);
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
  const vixLine = uvxyPrice ? `UVXY $${uvxyPrice} ${vixLevel}` : 'VIX  — unavailable';

  const lines = [
    `📊 STRATUM MORNING BRIEF`,
    `${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `   ➡️  Wait for 9:30AM open direction`,
    `───────────────────────────────`,
    `😨 ${vixLine}`,
    `───────────────────────────────`,
    `⚡ DAY    0-1DTE  $0.30–$1.50  risk $120`,
    `📈 SWING  5-7DTE  $0.50–$3.00  risk $140`,
    `📊 SPREAD 5-7DTE  $0.50–$1.50  risk $150`,
    `───────────────────────────────`,
    `🎯 Only 5/6+ confluence fires alerts`,
    `📊 #strat-alerts      — Chart setups`,
    `🌊 #flow-alerts       — Unusual flow`,
    `👑 #conviction-trades — Execute`,
    `───────────────────────────────`,
    `⏰ DAY:    10AM–11:30AM | 3PM–3:45PM`,
    `⏰ SWING:  9:30AM–4PM ET`,
    `⏰ SPREAD: 9:30AM–4PM ET`,
  ];

  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', `ℹ️ STRATUM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };


