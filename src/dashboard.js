// dashboard.js — Stratum Flow Scout v6.1
// "Should I Be Trading?" — Bloomberg Terminal Style Dashboard
// Data: Public.com primary, Polygon fallback
// AI: Claude Sonnet summary layer
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const POLY_BASE   = 'https://api.polygon.io';
const PUB_AUTH    = 'https://api.public.com/userapiauthservice/personal/access-tokens';
const PUB_GATEWAY = 'https://api.public.com/userapigateway';

function polyKey()   { return process.env.POLYGON_API_KEY; }
function accountId() { return process.env.PUBLIC_ACCOUNT_ID; }

// ── TOKEN ─────────────────────────────────────────────────────────
async function getPublicToken() {
  try {
    const secret = process.env.PUBLIC_API_KEY;
    if (!secret) return null;
    const res  = await fetch(PUB_AUTH, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body:    JSON.stringify({ secret, validityInMinutes: 30 }),
    });
    const data = await res.json();
    return data?.accessToken || null;
  } catch { return null; }
}

// ── GET PRICE — Public.com primary, Polygon fallback ─────────────
async function getPrice(ticker, token) {
  const aid = accountId();
  if (token && aid) {
    try {
      const res  = await fetch(`${PUB_GATEWAY}/marketdata/${aid}/quotes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
        body:    JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
      });
      const data  = await res.json();
      const quote = data?.quotes?.[0];
      if (quote?.last) return { price: parseFloat(quote.last), change: parseFloat(quote.changePercent || 0), source: 'public' };
    } catch { }
  }
  try {
    const res  = await fetch(`${POLY_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${polyKey()}`);
    const data = await res.json();
    const t    = data?.ticker;
    if (t?.lastTrade?.p) {
      const price  = t.lastTrade.p;
      const prev   = t.prevDay?.c || price;
      const change = parseFloat(((price - prev) / prev * 100).toFixed(2));
      return { price, change, source: 'polygon' };
    }
  } catch { }
  return null;
}

// ── SECTOR ETFs ───────────────────────────────────────────────────
const SECTORS = [
  { symbol: 'XLK', name: 'Tech' },
  { symbol: 'XLF', name: 'Finance' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLV', name: 'Health' },
  { symbol: 'XLI', name: 'Industrial' },
  { symbol: 'XLC', name: 'Comms' },
];

// ── SCORE ENGINE ──────────────────────────────────────────────────
// 5 weighted categories → raw score 0-100 → YES / CAUTION / NO

function scoreVolatility(vix) {
  // VIX proxy via UVXY price
  // Low VIX (<15)  = good for trading
  // Mid VIX (15-25) = caution
  // High VIX (>25)  = reduce / no
  if (!vix) return { score: 50, label: 'UNKNOWN', detail: 'VIX unavailable' };
  if (vix < 15)  return { score: 90, label: 'LOW',      detail: `VIX ~${vix.toFixed(1)} — ideal conditions` };
  if (vix < 20)  return { score: 70, label: 'NORMAL',   detail: `VIX ~${vix.toFixed(1)} — normal volatility` };
  if (vix < 25)  return { score: 50, label: 'ELEVATED', detail: `VIX ~${vix.toFixed(1)} — reduce size` };
  if (vix < 35)  return { score: 25, label: 'HIGH',     detail: `VIX ~${vix.toFixed(1)} — high risk, be careful` };
  return           { score: 5,  label: 'EXTREME',  detail: `VIX ~${vix.toFixed(1)} — stay out` };
}

function scoreMomentum(spyChange, qqqChange) {
  if (spyChange == null || qqqChange == null) return { score: 50, label: 'UNKNOWN', detail: 'No data' };
  const avg = (spyChange + qqqChange) / 2;
  const abs = Math.abs(avg);
  // Strong directional move = good momentum = tradeable
  if (abs > 1.5)  return { score: 85, label: 'STRONG',   detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}% QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%` };
  if (abs > 0.75) return { score: 65, label: 'MODERATE', detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}% QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%` };
  if (abs > 0.25) return { score: 45, label: 'WEAK',     detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}% QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}%` };
  return           { score: 20, label: 'CHOPPY',   detail: `SPY ${spyChange > 0 ? '+' : ''}${spyChange.toFixed(2)}% QQQ ${qqqChange > 0 ? '+' : ''}${qqqChange.toFixed(2)}% — flat/chop` };
}

function scoreTrend(spyChange, qqqChange) {
  if (spyChange == null || qqqChange == null) return { score: 50, label: 'UNKNOWN', detail: 'No data' };
  // Both aligned in same direction = clean trend
  const aligned = (spyChange > 0 && qqqChange > 0) || (spyChange < 0 && qqqChange < 0);
  const direction = spyChange > 0 ? 'BULLISH' : 'BEARISH';
  if (aligned && Math.abs(spyChange) > 0.5) return { score: 80, label: direction, detail: `SPY + QQQ aligned ${direction.toLowerCase()}` };
  if (aligned) return { score: 60, label: direction, detail: `Weak alignment — small moves` };
  return { score: 30, label: 'MIXED', detail: 'SPY and QQQ diverging — no clean trend' };
}

function scoreBreadth(sectors) {
  if (!sectors?.length) return { score: 50, label: 'UNKNOWN', detail: 'No sector data' };
  const advancing = sectors.filter(s => s.change > 0).length;
  const total     = sectors.length;
  const pct       = advancing / total;
  if (pct >= 0.80) return { score: 85, label: 'BROAD BULL',  detail: `${advancing}/${total} sectors advancing` };
  if (pct >= 0.60) return { score: 65, label: 'BULLISH',     detail: `${advancing}/${total} sectors advancing` };
  if (pct >= 0.40) return { score: 45, label: 'MIXED',       detail: `${advancing}/${total} sectors advancing` };
  if (pct >= 0.20) return { score: 25, label: 'BEARISH',     detail: `${advancing}/${total} sectors advancing` };
  return             { score: 10, label: 'BROAD BEAR',  detail: `${advancing}/${total} sectors advancing` };
}

function scoreMacro() {
  // Time-based macro score — market session quality
  const now    = new Date();
  const etHour = now.getUTCHours() - 4;
  const etMin  = now.getUTCMinutes();
  const etTime = etHour * 60 + etMin;

  const OPEN        = 9  * 60 + 30;
  const PRIME_START = 9  * 60 + 45;
  const PRIME_END   = 11 * 60 + 30;
  const LUNCH_END   = 14 * 60 + 0;
  const POWER_START = 15 * 60 + 0;
  const POWER_END   = 15 * 60 + 30;
  const CLOSE       = 16 * 60 + 0;

  if (etTime < OPEN)        return { score: 0,  label: 'CLOSED',     detail: 'Market not open yet' };
  if (etTime < PRIME_START) return { score: 30, label: 'OPENING',    detail: 'Wait for 9:45AM settle' };
  if (etTime < PRIME_END)   return { score: 95, label: 'PRIME',      detail: '9:45–11:30AM — best window' };
  if (etTime < LUNCH_END)   return { score: 50, label: 'MIDDAY',     detail: '11:30AM–2PM — choppy lunch' };
  if (etTime < POWER_START) return { score: 65, label: 'AFTERNOON',  detail: '2–3PM — building into close' };
  if (etTime < POWER_END)   return { score: 90, label: 'POWER HOUR', detail: '3–3:30PM — strong momentum' };
  if (etTime < CLOSE)       return { score: 15, label: 'LATE',       detail: 'After 3:30PM — no new entries' };
  return                           { score: 0,  label: 'CLOSED',     detail: 'Market closed' };
}

function buildDecision(totalScore, mode) {
  if (mode === 'DAY') {
    if (totalScore >= 70) return { verdict: 'YES',     color: 'green',  emoji: '✅' };
    if (totalScore >= 50) return { verdict: 'CAUTION', color: 'amber',  emoji: '⚠️' };
    return                       { verdict: 'NO',      color: 'red',    emoji: '🚫' };
  }
  // SWING mode — less sensitive to intraday time
  if (totalScore >= 60) return { verdict: 'YES',     color: 'green', emoji: '✅' };
  if (totalScore >= 40) return { verdict: 'CAUTION', color: 'amber', emoji: '⚠️' };
  return                       { verdict: 'NO',      color: 'red',   emoji: '🚫' };
}

// ── AI SUMMARY ────────────────────────────────────────────────────
async function getAISummary(marketData, scores, decision, mode) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 'AI summary unavailable — set ANTHROPIC_API_KEY';

    const prompt = `You are a professional options trader reviewing pre-market conditions. Be direct, concise, 2-3 sentences max.

Mode: ${mode} trading
Decision: ${decision.verdict}
Overall score: ${marketData.totalScore}/100

Market data:
- SPY: ${marketData.spy?.price ? `$${marketData.spy.price} (${marketData.spy.change > 0 ? '+' : ''}${marketData.spy.change?.toFixed(2)}%)` : 'unavailable'}
- QQQ: ${marketData.qqq?.price ? `$${marketData.qqq.price} (${marketData.qqq.change > 0 ? '+' : ''}${marketData.qqq.change?.toFixed(2)}%)` : 'unavailable'}
- VIX proxy (UVXY): ${marketData.uvxy?.price ? `$${marketData.uvxy.price}` : 'unavailable'}
- Volatility: ${scores.volatility.label} (${scores.volatility.score}/100)
- Momentum: ${scores.momentum.label} (${scores.momentum.score}/100)
- Trend: ${scores.trend.label} (${scores.trend.score}/100)
- Breadth: ${scores.breadth.label} (${scores.breadth.score}/100)
- Session: ${scores.macro.label} (${scores.macro.score}/100)

Give a sharp 2-sentence trading assessment. What's the key risk or opportunity right now? End with one specific action if YES, one specific warning if CAUTION or NO.`;

    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    return data?.content?.[0]?.text || 'AI summary unavailable';
  } catch (err) {
    console.error('[AI SUMMARY] Error:', err.message);
    return 'AI summary temporarily unavailable';
  }
}

// ── MAIN DATA FETCH ───────────────────────────────────────────────
async function getDashboardData(mode = 'DAY') {
  console.log(`[DASHBOARD] Fetching market data — mode: ${mode}`);
  const token = await getPublicToken();

  // Fetch core tickers in parallel
  const [spy, qqq, uvxy, iwm, ...sectorData] = await Promise.all([
    getPrice('SPY',  token),
    getPrice('QQQ',  token),
    getPrice('UVXY', token),
    getPrice('IWM',  token),
    ...SECTORS.map(s => getPrice(s.symbol, token)),
  ]);

  // Map sector data
  const sectors = SECTORS.map((s, i) => ({
    ...s,
    price:  sectorData[i]?.price  || null,
    change: sectorData[i]?.change || 0,
  }));

  // VIX estimate from UVXY (rough proxy — UVXY ~= 1.5x VIX)
  const vixEstimate = uvxy?.price ? uvxy.price / 1.5 : null;

  // ── SCORE EACH CATEGORY ───────────────────────────────────────
  const scores = {
    volatility: scoreVolatility(vixEstimate),     // 25%
    momentum:   scoreMomentum(spy?.change, qqq?.change), // 25%
    trend:      scoreTrend(spy?.change, qqq?.change),    // 20%
    breadth:    scoreBreadth(sectors),            // 20%
    macro:      scoreMacro(),                     // 10%
  };

  const WEIGHTS = { volatility: 0.25, momentum: 0.25, trend: 0.20, breadth: 0.20, macro: 0.10 };
  const totalScore = Math.round(
    scores.volatility.score * WEIGHTS.volatility +
    scores.momentum.score   * WEIGHTS.momentum   +
    scores.trend.score      * WEIGHTS.trend       +
    scores.breadth.score    * WEIGHTS.breadth     +
    scores.macro.score      * WEIGHTS.macro
  );

  const decision = buildDecision(totalScore, mode);

  const marketData = { spy, qqq, uvxy, iwm, vixEstimate, sectors, totalScore };

  // AI summary — runs in parallel to keep response fast
  const aiSummary = await getAISummary(marketData, scores, decision, mode);

  const result = {
    timestamp:  new Date().toISOString(),
    mode,
    decision,
    totalScore,
    scores,
    market: {
      spy,
      qqq,
      uvxy,
      iwm,
      vixEstimate: vixEstimate ? parseFloat(vixEstimate.toFixed(1)) : null,
      sectors,
    },
    aiSummary,
  };

  console.log(`[DASHBOARD] Score: ${totalScore}/100 — ${decision.verdict}`);
  return result;
}

module.exports = { getDashboardData };
