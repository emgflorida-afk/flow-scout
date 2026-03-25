// alerter.js — Stratum Flow Scout v6.1
// FULL EDGE: Time guardrails, spread warning, GEX, Max Pain, OI nodes, IV context
// TECHNICALS: RSI(14) + VWAP from TradingView webhook payload
// CHART: Finviz daily chart auto-attached to every alert
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// ─────────────────────────────────────────────────────────────────

const fetch    = require(‘node-fetch’);
const resolver = require(’./contractResolver’);
const calendar = require(’./economicCalendar’);

const WEBHOOKS = {
strat:      process.env.DISCORD_WEBHOOK_URL,
flow:       process.env.DISCORD_FLOW_WEBHOOK_URL,
conviction: process.env.DISCORD_CONVICTION_WEBHOOK_URL,
};

// ── FINVIZ CHART ──────────────────────────────────────────────────
// Returns daily chart PNG buffer for a ticker
// p=d daily | p=w weekly | ty=c candlestick | ta=1 with technicals
async function getFinvizChart(ticker) {
try {
const url = `https://finviz.com/chart.ashx?t=${ticker}&ty=c&ta=1&p=d&s=l`;
const res = await fetch(url, {
headers: {
‘User-Agent’: ‘Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36’,
‘Referer’:    ‘https://finviz.com’,
},
});
if (!res.ok) { console.log(`[CHART] Finviz ${ticker} failed: ${res.status}`); return null; }
const buffer = await res.buffer();
console.log(`[CHART] ${ticker} chart fetched ✅`);
return buffer;
} catch (err) {
console.error(`[CHART] Error fetching ${ticker}:`, err.message);
return null;
}
}

// ── SEND TO CHANNEL WITH OPTIONAL CHART ──────────────────────────
// Sends text card first, then chart image as follow-up if available
async function sendToChannel(channel, message, ticker = null) {
const url = WEBHOOKS[channel];
if (!url) { console.log(`[DISCORD] No webhook for ${channel}`); return false; }

try {
// Send text card
const res = await fetch(url, {
method:  ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body:    JSON.stringify({ content: ‘`\n' + message + '\n`’, username: ‘Stratum’ }),
});
if (!res.ok) return false;
console.log(`[DISCORD] Sent to #${channel} ✅`);

```
// Attach chart if ticker provided
if (ticker) {
  const chart = await getFinvizChart(ticker);
  if (chart) {
    const { FormData, Blob } = require('node-fetch');
    const form = new FormData();
    form.append('file', new Blob([chart], { type: 'image/png' }), `${ticker}_chart.png`);
    form.append('payload_json', JSON.stringify({ username: 'Stratum' }));
    await fetch(url, { method: 'POST', body: form });
    console.log(`[CHART] ${ticker} chart sent to #${channel} ✅`);
  }
}
return true;
```

} catch (err) {
console.error(`[DISCORD] Error:`, err.message);
return false;
}
}

async function sendDiscordRaw(msg) { await sendToChannel(‘strat’, msg); }

function calcDTE(expiryDateStr) {
const diff = Math.ceil((new Date(expiryDateStr + ‘T16:00:00-04:00’) - new Date()) / (1000 * 60 * 60 * 24));
return Math.max(0, diff);
}

// ── RSI LABEL ─────────────────────────────────────────────────────
function getRsiLabel(rsi) {
if (rsi == null || isNaN(rsi)) return ‘—’;
if (rsi > 70) return ‘overbought ⚠️’;
if (rsi < 30) return ‘oversold ⚠️’;
if (rsi > 55) return ‘bullish momentum’;
if (rsi < 45) return ‘room to fall ✅’;
return ‘neutral’;
}

// ── BUILD TECHNICALS SECTION ──────────────────────────────────────
function buildTechnicalsSection(tvData = {}) {
const rsi      = tvData.rsi      != null ? parseFloat(tvData.rsi)      : null;
const vwap     = tvData.vwap     != null ? parseFloat(tvData.vwap)     : null;
const vwapBias = tvData.vwapBias || null;

if (rsi == null && vwap == null) return [];

const lines = [];
if (rsi != null && !isNaN(rsi)) {
lines.push(`RSI (14)    ${rsi.toFixed(0)} — ${getRsiLabel(rsi)}`);
}
if (vwap != null && !isNaN(vwap) && vwapBias) {
const biasIcon  = vwapBias === ‘above’ ? ‘🔼’ : ‘🔽’;
const biasLabel = vwapBias === ‘above’ ? ‘bullish’ : ‘bearish’;
lines.push(`VWAP        $${vwap.toFixed(2)} — price ${vwapBias.toUpperCase()} ${biasIcon} ${biasLabel} confirmed`);
}

return lines;
}

// ── FLOW SCORING ──────────────────────────────────────────────────
function scoreFlow(flowData = {}) {
const flags = []; let score = 0;
const orderType = (flowData.orderType || ‘’).toUpperCase();
const premium   = parseFloat(flowData.totalPremium || 0);
const alertName = (flowData.alertName || ‘’).toLowerCase();

if (orderType === ‘SWEEP’)      { score += 2; flags.push(‘⚡ SWEEP’); }
else if (orderType === ‘BLOCK’) { score += 1; flags.push(‘■ BLOCK’); }

if (premium >= 1000000)     { score += 4; flags.push(`💰 $${(premium/1000000).toFixed(1)}M — WHALE`); }
else if (premium >= 500000) { score += 3; flags.push(`💰 $${(premium/1000).toFixed(0)}K — LARGE`); }
else if (premium >= 100000) { score += 2; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }
else if (premium >= 25000)  { score += 1; flags.push(`💰 $${(premium/1000).toFixed(0)}K`); }

if (alertName.includes(‘urgent’) || alertName.includes(‘whale’) || alertName.includes(‘giant’) || alertName.includes(‘grenade’)) {
score += 2; flags.push(`🔥 ${flowData.alertName}`);
} else if (alertName.includes(‘sweep’) || alertName.includes(‘sizable’)) {
score += 1; flags.push(`📡 ${flowData.alertName}`);
}

const label = score >= 6 ? ‘🔥 MAXIMUM CONVICTION’
: score >= 4 ? ‘✅ HIGH CONVICTION’
: score >= 2 ? ‘📡 NOTABLE FLOW’
: ‘📊 FLOW DETECTED’;

return { score, flags, label, isHighConviction: score >= 4 };
}

const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// ── BUILD EDGE SECTION ────────────────────────────────────────────
function buildEdgeSection(resolved) {
const lines = [];
if (!resolved) return lines;

const { maxPain, gex, oiNodes, ivCtx, timeCtx, wideSpread, bid, ask } = resolved;

if (timeCtx?.warning) lines.push(timeCtx.warning);

if (wideSpread && bid && ask) {
const sw = parseFloat((ask - bid).toFixed(2));
lines.push(`⚠️ WIDE SPREAD — $${sw} wide — risky fill, limit at mid only`);
}

if (resolved.dte === 0) {
const now    = new Date();
const etHour = now.getUTCHours() - 4;
if (etHour >= 14) lines.push(`🚫 0DTE after 2PM — DO NOT ENTER`);
}

if (lines.length > 0) lines.push(`───────────────────────────────`);

if (maxPain) lines.push(`Max Pain    $${maxPain} — price magnet into expiry`);

if (gex) {
const gexM = (gex.netGEX / 1000000).toFixed(0);
lines.push(`GEX         ${gex.netGEX > 0 ? '+' : ''}$${gexM}M — ${gex.isPositive ? 'POSITIVE (range bound)' : 'NEGATIVE (trending)'} ${gex.source || ''}`);
if (gex.topGEXStrike) lines.push(`GEX Pin     $${gex.topGEXStrike} — highest dealer hedge zone`);
}

if (oiNodes?.length > 0) {
const top = oiNodes.slice(0, 2).map(n => `$${n.strike}(${n.bias})`).join(’ | ’);
lines.push(`OI Walls    ${top}`);
}

if (ivCtx) {
lines.push(`IV Regime   ${ivCtx.ivRegime}`);
lines.push(`Impl Move   ±${ivCtx.impliedMove}% | Daily ±${ivCtx.dailyMove}%`);
if (ivCtx.recommendSpreads) lines.push(`💡 High IV — consider spread instead of naked`);
}

return lines;
}

// ── BUILD SPREAD CARD ─────────────────────────────────────────────
function buildSpreadCard(resolved, tvData = {}) {
const parsed = resolver.parseOPRA(resolved.symbol);
if (!parsed) return null;

const { ticker, expiry, type } = parsed;
const dte       = resolved.dte ?? calcDTE(expiry);
const dteLabel  = `${dte}DTE`;
const expiryFmt = expiry.slice(5).replace(’-’, ‘/’);
const direction = type === ‘put’ ? ‘🔴 BEARISH’ : ‘🟢 BULLISH’;
const typeLabel = type === ‘put’ ? ‘P’ : ‘C’;

const sizing = resolver.calculatePositionSize(resolved.debit, ‘SPREAD’, 7000, resolved);
const s      = sizing?.viable ? sizing : null;

const confluence = tvData.confluence || ‘’;
const tfLine = [
tvData.weekly ? `WEEKLY:${tvData.weekly}` : null,
tvData.daily  ? `DAILY:${tvData.daily}`   : null,
tvData.h4     ? `H4:${tvData.h4}`         : null,
].filter(Boolean).join(’  ’);

const edgeLines       = buildEdgeSection(resolved);
const technicalsLines = buildTechnicalsSection(tvData);

const lines = [
`📊 SPREAD TRADE — ${dteLabel}`,
`${ticker} $${resolved.strike}/$${resolved.sellStrike}${typeLabel} ${expiryFmt} — ${direction}`,
`═══════════════════════════════`,
confluence ? `Confluence  ${confluence}` : null,
tfLine     ? `Bias    ${tfLine}` : null,
`───────────────────────────────`,
`BUY     ${ticker} $${resolved.strike}${typeLabel} ${expiryFmt}`,
`SELL    ${ticker} $${resolved.sellStrike}${typeLabel} ${expiryFmt}`,
`Width   $${resolved.spreadWidth} spread`,
`───────────────────────────────`,
s ? `Debit   $${s.debit.toFixed(2)} x${s.contracts} = $${s.totalCost}` : `Debit   $${resolved.debit?.toFixed(2)}`,
s ? `Max Loss    $${s.maxLoss}` : null,
s ? `Max Profit  $${s.maxGain}` : null,
`Breakeven   $${resolved.breakeven}`,
`───────────────────────────────`,
s ? `Stop    $${s.stopPrice} (50% of debit)` : `Stop    50% of debit`,
s ? `T1      $${s.t1Price} (100% gain)` : `T1      +100% of debit`,
s ? `Risk    ${s.riskPct}% of $7K = $${s.maxLoss}` : `Risk    defined`,
technicalsLines.length > 0 ? `───────────────────────────────` : null,
…technicalsLines,
edgeLines.length > 0 ? `───────────────────────────────` : null,
…edgeLines,
`───────────────────────────────`,
`Hold    1–3 days max`,
`⏰ ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
].filter(l => l !== null);

return { text: lines.join(’\n’), ticker };
}

// ── BUILD STRAT CARD ──────────────────────────────────────────────
function buildStratCard(opraSymbol, tvData = {}, resolved = null) {
const parsed = resolver.parseOPRA(opraSymbol);
if (!parsed) return null;

const { ticker, expiry, type, strike } = parsed;
const dte       = tvData.dte ?? calcDTE(expiry);
const direction = type === ‘put’ ? ‘🔴 BEARISH’ : ‘🟢 BULLISH’;
const typeLabel = type === ‘put’ ? ‘P’ : ‘C’;
const expiryFmt = expiry.slice(5).replace(’-’, ‘/’);
const dteLabel  = dte === 0 ? ‘0DTE’ : dte === 1 ? ‘1DTE’ : `${dte}DTE`;

const mode      = tvData.mode || ‘SWING’;
const premium   = tvData.mid  || null;
const sizing    = premium ? resolver.calculatePositionSize(premium, mode) : null;
const s         = sizing?.viable ? sizing : null;
const modeLabel = mode === ‘DAY’ ? ‘⚡ DAY TRADE’ : ‘📈 SWING TRADE’;

const confluence = tvData.confluence || ‘’;
const tfLine = [
tvData.weekly ? `WEEKLY:${tvData.weekly}` : null,
tvData.daily  ? `DAILY:${tvData.daily}`   : null,
tvData.h4     ? `H4:${tvData.h4}`         : null,
tvData.h1     ? `H1:${tvData.h1}`         : null,
].filter(Boolean).join(’  ’);

const edgeLines       = resolved ? buildEdgeSection(resolved) : [];
const technicalsLines = buildTechnicalsSection(tvData);

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
s ? `Entry   $${s.premium.toFixed(2)} x${s.contracts} = $${s.totalCost}` : ‘⚠️  Check live premium before entry’,
s ? `Stop    $${s.stopPrice} (loss -$${s.stopLoss})` : `Stop    ${mode === 'DAY' ? '35' : '40'}% of premium`,
s ? `T1      $${s.t1Price} (profit +$${s.t1Profit})` : `T1      +${mode === 'DAY' ? '35' : '60'}% of premium`,
s ? `T2      $${s.t2Price} (runner)` : `T2      +${mode === 'DAY' ? '70' : '120'}% of premium`,
s ? `Risk    ${s.riskPct}% of $7K = $${s.stopLoss} max` : `Risk    2% of $7K max`,
technicalsLines.length > 0 ? `───────────────────────────────` : null,
…technicalsLines,
edgeLines.length > 0 ? `───────────────────────────────` : null,
…edgeLines,
`───────────────────────────────`,
mode === ‘DAY’ ? `Hold    Exit same day by 3:30PM` : `Hold    1–3 days max`,
mode === ‘DAY’ ? `Window  10AM–11:30AM | 3PM–3:30PM` : `Window  9:45AM–3:30PM ET`,
`⏰ ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
].filter(l => l !== null);

return { text: lines.join(’\n’), ticker };
}

// ── STRAT ALERT ───────────────────────────────────────────────────
async function sendStratAlert(opraSymbol, tvData = {}, resolved = null) {
console.log(’[STRAT] Processing:’, opraSymbol);

const calCheck = await calendar.shouldBlockAlert();
if (calCheck.block) {
await sendToChannel(‘strat’, `⏸️ BLOCKED\n${calCheck.reason}`);
return false;
}

let card;
if (tvData.mode === ‘SPREAD’ && resolved?.debit) {
card = buildSpreadCard(resolved, tvData);
} else {
card = buildStratCard(opraSymbol, tvData, resolved);
}

if (!card) return false;
await sendToChannel(‘strat’, card.text, card.ticker);

const parsed = resolver.parseOPRA(opraSymbol);
if (parsed) {
const key = `${parsed.ticker}:${parsed.type}`;
recentStratTickers.set(key, Date.now());
setTimeout(() => recentStratTickers.delete(key), 30 * 60 * 1000);
if (recentFlowTickers.has(key)) {
await sendToChannel(‘conviction’,
card.text
.replace(‘📊 SPREAD TRADE’, ‘👑 CONVICTION SPREAD’)
.replace(‘📈 SWING TRADE’,  ‘👑 CONVICTION TRADE’)
.replace(‘⚡ DAY TRADE’,    ‘👑 CONVICTION TRADE’),
card.ticker
);
console.log(`[CONVICTION] Both signals on ${parsed.ticker} ✅`);
}
}
return true;
}

// ── FLOW ALERT ────────────────────────────────────────────────────
async function sendFlowAlert(opraSymbol, flowData = {}) {
console.log(’[FLOW] Processing:’, opraSymbol);
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
…flowConviction.flags.map(f => `        ${f}`),
`───────────────────────────────`,
`Premium $${premium >= 1000000 ? (premium/1000000).toFixed(1)+'M' : (premium/1000).toFixed(0)+'K'}`,
`Type    ${(flowData.orderType || 'UNKNOWN').toUpperCase()}`,
flowData.alertName ? `Alert   ${flowData.alertName}` : null,
`───────────────────────────────`,
`👁️ Watch for Strat confirmation`,
`⏰ ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'})} ET`,
].filter(Boolean);

// Flow alert also gets chart
await sendToChannel(‘flow’, lines.join(’\n’), parsed.ticker);

if (flowConviction.isHighConviction && recentStratTickers.has(key)) {
const resolved = await resolver.resolveContract(parsed.ticker, parsed.type, ‘SWING’);
if (resolved) {
const card = resolved.mode === ‘SPREAD’ && resolved.debit
? buildSpreadCard(resolved, {})
: buildStratCard(resolved.symbol, { mid: resolved.mid, bid: resolved.bid, ask: resolved.ask, mode: resolved.mode, dte: resolved.dte }, resolved);
if (card) {
await sendToChannel(‘conviction’,
card.text.replace(‘📈 SWING TRADE’, ‘👑 CONVICTION TRADE’),
card.ticker
);
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
console.log(’[BRIEF] Building morning brief…’);
const dateStr   = new Date().toLocaleDateString(‘en-US’, { weekday:‘long’, month:‘short’, day:‘numeric’ });
const spyPrice  = await resolver.getPrice(‘SPY’);
const uvxyPrice = await resolver.getPrice(‘UVXY’);
const spyLine   = spyPrice  ? `SPY  $${spyPrice} LIVE` : ‘SPY  — unavailable’;
const vixLevel  = uvxyPrice
? parseFloat(uvxyPrice) >= 30 ? ‘🚨 EXTREME — reduce size’
: parseFloat(uvxyPrice) >= 20 ? ‘⚠️ ELEVATED — be careful’
: ‘✅ NORMAL’ : ‘’;
const vixLine   = uvxyPrice ? `UVXY $${uvxyPrice} ${vixLevel}` : ‘VIX  — unavailable’;

const lines = [
`📊 STRATUM MORNING BRIEF v6.1`,
`${dateStr}`,
`═══════════════════════════════`,
`📈 ${spyLine}`,
`   ➡️  Wait for 9:45AM to settle`,
`───────────────────────────────`,
`😨 ${vixLine}`,
`───────────────────────────────`,
`⚡ DAY    0-1DTE  $0.30–$1.50  T1:+35%  risk $120`,
`📈 SWING  5-7DTE  $0.50–$3.00  T1:+60%  risk $140`,
`📊 SPREAD 5-7DTE  $0.50–$1.50  T1:+100% risk $150`,
`───────────────────────────────`,
`RULES:`,
`6/6 confluence → execute immediately`,
`5/6 confluence → wait for flow confirmation`,
`Flow high conviction → execute swing or spread card`,
`Flow + Strat same ticker → conviction trade`,
`───────────────────────────────`,
`⏰ Entry window: 9:45AM – 3:30PM ET`,
`🚫 No entries after 3:30PM`,
`🚫 No 0DTE entries after 2PM`,
`───────────────────────────────`,
`📊 #strat-alerts      — Chart setups`,
`🌊 #flow-alerts       — Unusual flow`,
`👑 #conviction-trades — Execute`,
];

await sendToChannel(‘strat’, lines.join(’\n’));
console.log(’[BRIEF] Sent ✅’);
return true;
}

async function sendSystemMessage(msg) {
await sendToChannel(‘strat’, `ℹ️ STRATUM\n${msg}`);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };


