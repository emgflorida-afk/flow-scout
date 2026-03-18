// alerter.js — Stratum Flow Scout v5.8
// 3 Discord channels + Public.com live prices
// Synced with contractResolver.js v5.8
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

function scoreBar(score, max) {
  const f = Math.round((score / max) * 10);
  return '█'.repeat(f) + '░'.repeat(10 - f) + ` ${score}/${max}`;
}

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
const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// ── BUILD ALERT CARD ──────────────────────────────────────────────
async function buildAlertCard(opraSymbol, tvData = {}, flowConviction = null, isStratSignal = false) {
  const contract = await resolver.findBestContract(opraSymbol);
  if (contract.error) { console.log('[ALERT]', contract.error); return null; }

  const sizing = resolver.calculatePositionSize(contract.premium);
  if (!sizing.viable) { console.log('[ALERT] Sizing:', sizing.reason); return null; }

  const dte    = calcDTE(contract.expiry);
  const tfData = {
    monthly: tvData.monthly || null, weekly: tvData.weekly || null,
    daily:   tvData.daily   || null, h4:     tvData.h4     || null,
    h1:      tvData.h1      || null, m15:    tvData.m15    || null,
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

  const tfLine      = Object.entries(tfData).filter(([,v]) => v).map(([k,v]) => `${k.toUpperCase()}:${v}`).join('  ');
  const sweepAtKing = flowConviction?.flags?.some(f => f.includes('SWEEP')) && contract.volumeProfile?.nearKing;
  const liveSnap    = await resolver.getPrice(ticker);
  const priceInfo   = liveSnap ? `$${liveSnap} LIVE` : 'unavailable';

  const alertLabel = isStratSignal && flowConviction?.score > 0 ? '👑 CONVICTION TRADE'
                   : isStratSignal ? '📊 STRAT SIGNAL'
                   : '🌊 FLOW ALERT';

  const confText = tvData.confluence ? `Confluence ${tvData.confluence}` : null;

  const lines = [
    `${alertLabel} — ${tradeType.label}`,
    `${ticker} $${strike}${typeLabel} ${expiryFmt} — ${direction} — ${dte}DTE`,
    `Stock   ${priceInfo}`,
    sweepAtKing ? `👑⚡ SWEEP AT KING NODE — MAXIMUM CONVICTION` : null,
    `═══════════════════════════════`,
    `Score   ${scoreBar(score.total, score.max)}`,
    `Grade   ${grade}`,
    `Prob    ~${score.profitProb}% profit probability`,
    `───────────────────────────────`,
    confText,
    flowConviction ? `Flow    ${flowConviction.label}` : null,
    ...(flowConviction?.flags || []).map(f => `        ${f}`),
    confluence.total > 0 ? `TF Conf ${confluence.label}` : null,
    tfLine ? `Bias    ${tfLine}` : null,
    `───────────────────────────────`,
    `Entry   ~$${premium.toFixed(2)} x${sizing.contracts} = $${(premium * sizing.contracts * 100).toFixed(0)}`,
    `Stop    $${sizing.stopPrice} (loss -$${sizing.stopLoss})`,
    `T1      $${sizing.t1Price} (profit +$${sizing.t1Profit})`,
    `T2      $${sizing.t2Price} (runner)`,
    `Risk    ${sizing.riskPct}% of $7K account`,
    `───────────────────────────────`,
    `Delta   ${contract.delta}    Theta  ${contract.theta}`,
    `IV      ${contract.iv}%     Vol    ${contract.volume}`,
    `OI      ${contract.openInterest}`,
    `───────────────────────────────`,
    `Hold    ${tradeType.holdRules}`,
    `Stop    ${tradeType.stopRule}`,
    score.warnings.length > 0 ? `───────────────────────────────` : null,
    ...score.warnings.map(w => `⚠️  ${w}`),
    `───────────────────────────────`,
    `⏰ 9:30AM–4PM ET`,
  ].filter(l => l !== null && l !== undefined);

  return { card: lines.join('\n'), ticker, type, contract, tradeType };
}

// ── STRAT ALERT → #strat-alerts ──────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}) {
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', `⏸️ BLOCKED\n${calCheck.reason}`);
    return false;
  }

  const result = await buildAlertCard(opraSymbol, tvData, null, true);
  if (!result) return false;

  await sendToChannel('strat', result.card);

  const key = `${result.ticker}:${result.type}`;
  recentStratTickers.set(key, Date.now());
  setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);

  if (recentFlowTickers.has(key)) {
    await sendToChannel('conviction', result.card.replace('📊 STRAT SIGNAL', '👑 CONVICTION TRADE'));
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

  if (flowConviction.isHighConviction) {
    const calCheck = await calendar.shouldBlockAlert();
    if (!calCheck.block) {
      const result = await buildAlertCard(opraSymbol, {}, flowConviction, false);
      if (result) {
        await sendToChannel('flow', result.card);
        if (recentStratTickers.has(key)) {
          await sendToChannel('conviction', result.card.replace('🌊 FLOW ALERT', '👑 CONVICTION TRADE'));
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

  const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });

  // Get SPY price
  const spyPrice = await resolver.getPrice('SPY');
  const uvxyPrice = await resolver.getPrice('UVXY');

  const spyLine  = spyPrice  ? `SPY  $${spyPrice} LIVE` : 'SPY  — unavailable';
  const vixLine  = uvxyPrice ? `UVXY $${uvxyPrice} ${parseFloat(uvxyPrice) >= 30 ? '🚨 EXTREME — reduce size' : parseFloat(uvxyPrice) >= 20 ? '⚠️ ELEVATED' : '✅ NORMAL'}` : 'VIX  — unavailable';

  const spyBias = spyPrice ? '➡️  Check 9:30AM open direction' : '➡️  Unavailable';

  const lines = [
    `📊 STRATUM MORNING BRIEF`,
    `${dateStr}`,
    `═══════════════════════════════`,
    `📈 ${spyLine}`,
    `   ${spyBias}`,
    `───────────────────────────────`,
    `😨 ${vixLine}`,
    `───────────────────────────────`,
    `📅 Check calendar for events`,
    `───────────────────────────────`,
    `💰 Max premium $5.00  |  Max loss $140`,
    `📏 ≤$1.20 = 2 contracts  |  >$1.20 = 1`,
    `⏰ 9:30AM–4PM ET`,
    `───────────────────────────────`,
    `🎯 Only 5/6+ confluence fires alerts`,
    `📊 #strat-alerts   — Chart setups`,
    `🌊 #flow-alerts    — Unusual flow`,
    `👑 #conviction-trades — Execute`,
  ].filter(Boolean);

  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent ✅');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', `ℹ️ STRATUM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };
