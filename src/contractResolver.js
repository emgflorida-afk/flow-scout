// contractResolver.js — Stratum Flow Scout v5.8
// TWO MODE SYSTEM: DAY (0-1DTE) and SWING (5-7DTE)
// Mode determined by tradeType field from Pine Script
// DAY:   premium $0.30–$1.50, 0-1DTE, tight sizing
// SWING: premium $0.50–$3.00, 5-7DTE, wider sizing
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const POLY_BASE   = 'https://api.polygon.io';
const PUB_AUTH    = 'https://api.public.com/userapiauthservice/personal/access-tokens';
const PUB_GATEWAY = 'https://api.public.com/userapigateway';

function polyKey() { return process.env.POLYGON_API_KEY; }

// ── TRADE MODE CONFIGS ────────────────────────────────────────────
const MODES = {
  DAY: {
    label:      'DAY TRADE',
    minPremium: 0.30,
    maxPremium: 1.50,
    minDTE:     0,
    maxDTE:     1,
    stopPct:    0.40,   // 40% stop — tighter
    t1Pct:      0.60,   // +60% target
    t2Pct:      1.20,   // +120% runner
    maxRisk:    120,    // $120 max loss
  },
  SWING: {
    label:      'SWING TRADE',
    minPremium: 0.50,
    maxPremium: 3.00,
    minDTE:     4,
    maxDTE:     14,
    stopPct:    0.40,   // 40% stop
    t1Pct:      0.60,   // +60% target
    t2Pct:      1.20,   // +120% runner
    maxRisk:    140,    // $140 max loss
  },
};

// Default exports for other files that reference these
const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 3.00;

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// ── TOKEN ─────────────────────────────────────────────────────────
async function getPublicToken() {
  try {
    const secret = process.env.PUBLIC_API_KEY;
    if (!secret) { console.log('[PUBLIC] No API key'); return null; }
    const res  = await fetch(PUB_AUTH, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body:    JSON.stringify({ secret, validityInMinutes: 30 }),
    });
    const data  = await res.json();
    const token = data?.accessToken || null;
    if (token) console.log('[PUBLIC] Token obtained ✅');
    else       console.log('[PUBLIC] Token failed:', JSON.stringify(data));
    return token;
  } catch (err) { console.error('[PUBLIC] Token error:', err.message); return null; }
}

// ── GET STOCK PRICE ───────────────────────────────────────────────
async function getPrice(ticker) {
  const accountId = process.env.PUBLIC_ACCOUNT_ID;

  try {
    const token = await getPublicToken();
    if (token && accountId) {
      const res  = await fetch(`${PUB_GATEWAY}/marketdata/${accountId}/quotes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
        body:    JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
      });
      const data  = await res.json();
      const quote = data?.quotes?.[0];
      if (quote?.last) {
        console.log(`[PRICE] ${ticker} $${quote.last} — Public.com ✅`);
        return parseFloat(quote.last);
      }
    }
  } catch (err) { console.error(`[PUBLIC] Price error:`, err.message); }

  try {
    const res  = await fetch(`${POLY_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${polyKey()}`);
    const data = await res.json();
    const price = data?.ticker?.lastTrade?.p || data?.ticker?.prevDay?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon ✅`); return price; }
  } catch { }

  try {
    const res  = await fetch(`${POLY_BASE}/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey()}`);
    const data = await res.json();
    const price = data?.results?.[0]?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon prev ✅`); return price; }
  } catch { }

  console.error(`[PRICE] No price for ${ticker}`);
  return null;
}

// ── GET OPTION EXPIRATIONS ────────────────────────────────────────
async function getPublicExpirations(ticker, token, accountId) {
  try {
    const res  = await fetch(`${PUB_GATEWAY}/marketdata/${accountId}/option-expirations`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
      body:    JSON.stringify({ instrument: { symbol: ticker, type: 'EQUITY' } }),
    });
    const data        = await res.json();
    const expirations = data?.expirations || [];
    if (expirations.length) console.log(`[PUBLIC] ${ticker} expirations: ${expirations.slice(0,4).join(', ')} ✅`);
    return expirations;
  } catch (err) { console.error(`[PUBLIC EXPIRY] Error:`, err.message); return []; }
}

// ── GET OPTION CHAIN ──────────────────────────────────────────────
async function getPublicOptionChain(ticker, expDate, type, token, accountId) {
  try {
    const res  = await fetch(`${PUB_GATEWAY}/marketdata/${accountId}/option-chain`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
      body:    JSON.stringify({ instrument: { symbol: ticker, type: 'EQUITY' }, expirationDate: expDate }),
    });
    const data  = await res.json();
    const chain = type === 'call' ? (data?.calls || []) : (data?.puts || []);
    console.log(`[PUBLIC CHAIN] ${ticker} ${type} ${expDate} — ${chain.length} contracts ✅`);
    return chain;
  } catch (err) { console.error(`[PUBLIC CHAIN] Error:`, err.message); return []; }
}

// ── CALCULATE DTE ─────────────────────────────────────────────────
function calcDTE(expDateStr) {
  const today  = new Date();
  const expiry = new Date(expDateStr + 'T16:00:00-04:00');
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}

// ── SELECT EXPIRY FOR MODE ────────────────────────────────────────
function selectExpiry(expirations, mode) {
  const today  = new Date().toISOString().slice(0, 10);
  const config = MODES[mode];

  const valid = expirations.filter(e => {
    const dte = calcDTE(e);
    return dte >= config.minDTE && dte <= config.maxDTE;
  });

  if (valid.length > 0) {
    console.log(`[EXPIRY] ${mode} mode — using ${valid[0]} (${calcDTE(valid[0])}DTE) ✅`);
    return valid[0];
  }

  // Fallback — closest valid date
  const future = expirations.filter(e => e > today);
  if (future.length > 0) {
    console.log(`[EXPIRY] ${mode} mode fallback — using ${future[0]}`);
    return future[0];
  }

  return null;
}

// ── RESOLVE CONTRACT — returns { symbol, mid, bid, ask, strike, expiry, mode } ──
async function resolveContract(ticker, type = 'call', tradeType = 'SWING') {
  // Determine mode from Pine Script tradeType field
  const mode   = (tradeType || '').toUpperCase().includes('DAY') ? 'DAY' : 'SWING';
  const config = MODES[mode];

  console.log(`[MODE] ${ticker} — ${mode} mode (${config.minDTE}-${config.maxDTE}DTE, $${config.minPremium}-$${config.maxPremium})`);

  const price     = await getPrice(ticker);
  if (!price) return null;

  const accountId = process.env.PUBLIC_ACCOUNT_ID;
  const token     = await getPublicToken();

  if (!token || !accountId) return null;

  const expirations = await getPublicExpirations(ticker, token, accountId);
  const expDate     = selectExpiry(expirations, mode);
  if (!expDate) { console.error(`[EXPIRY] No valid expiry for ${ticker} in ${mode} mode`); return null; }

  const chain = await getPublicOptionChain(ticker, expDate, type, token, accountId);
  if (!chain.length) return null;

  // Parse strikes and filter by mode premium range
  const withStrike = chain.map(c => {
    const sym    = c.instrument?.symbol || '';
    const match  = sym.match(/(\d{6})([CP])(\d{8})$/);
    const strike = match ? parseInt(match[3]) / 1000 : 0;
    const bid    = parseFloat(c.bid || 0);
    const ask    = parseFloat(c.ask || 0);
    const mid    = parseFloat(((bid + ask) / 2).toFixed(2));
    return { ...c, strike, mid, bid, ask, symbol: sym };
  }).filter(c =>
    c.mid >= config.minPremium &&
    c.mid <= config.maxPremium &&
    c.strike > 0
  );

  if (!withStrike.length) {
    console.log(`[OPRA] ${ticker} — no contracts in $${config.minPremium}–$${config.maxPremium} range for ${mode} mode on ${expDate}`);

    // Auto-fallback to other mode if nothing found
    const fallbackMode   = mode === 'DAY' ? 'SWING' : 'DAY';
    const fallbackConfig = MODES[fallbackMode];
    const fallbackExp    = selectExpiry(expirations, fallbackMode);

    if (fallbackExp) {
      console.log(`[OPRA] Trying ${fallbackMode} fallback on ${fallbackExp}`);
      const fallbackChain = await getPublicOptionChain(ticker, fallbackExp, type, token, accountId);
      const fallbackContracts = fallbackChain.map(c => {
        const sym    = c.instrument?.symbol || '';
        const match  = sym.match(/(\d{6})([CP])(\d{8})$/);
        const strike = match ? parseInt(match[3]) / 1000 : 0;
        const bid    = parseFloat(c.bid || 0);
        const ask    = parseFloat(c.ask || 0);
        const mid    = parseFloat(((bid + ask) / 2).toFixed(2));
        return { ...c, strike, mid, bid, ask, symbol: sym };
      }).filter(c =>
        c.mid >= fallbackConfig.minPremium &&
        c.mid <= fallbackConfig.maxPremium &&
        c.strike > 0
      );

      if (fallbackContracts.length) {
        const best = fallbackContracts.reduce((a, b) =>
          Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
        );
        console.log(`[OPRA] ${ticker} resolved via ${fallbackMode} fallback ✅ ${best.symbol} strike $${best.strike} mid $${best.mid}`);
        return { symbol: best.symbol, mid: best.mid, bid: best.bid, ask: best.ask, strike: best.strike, expiry: fallbackExp, mode: fallbackMode, dte: calcDTE(fallbackExp) };
      }
    }
    return null;
  }

  // Pick ATM contract
  const best = withStrike.reduce((a, b) =>
    Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
  );

  const dte = calcDTE(expDate);
  console.log(`[OPRA] ${ticker} resolved via Public ✅ ${best.symbol} strike $${best.strike} mid $${best.mid} ${dte}DTE [${mode}]`);

  return {
    symbol: best.symbol,
    mid:    best.mid,
    bid:    best.bid,
    ask:    best.ask,
    strike: best.strike,
    expiry: expDate,
    mode,
    dte,
    volume:       best.volume || 0,
    openInterest: best.openInterest || 0,
  };
}

// ── PARSE OPRA ────────────────────────────────────────────────────
function parseOPRA(opraSymbol) {
  try {
    const raw   = (opraSymbol || '').replace(/^O:/, '');
    const match = raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, dateStr, type, strikeRaw] = match;
    const expiry = `20${dateStr.slice(0,2)}-${dateStr.slice(2,4)}-${dateStr.slice(4,6)}`;
    return { ticker, expiry, type: type === 'C' ? 'call' : 'put', strike: parseInt(strikeRaw) / 1000 };
  } catch { return null; }
}

// ── GET OPTION SNAPSHOT — Polygon ────────────────────────────────
async function getOptionSnapshot(optionTicker) {
  try {
    const res    = await fetch(`${POLY_BASE}/v3/snapshot/options/${optionTicker}?apiKey=${polyKey()}`);
    const data   = await res.json();
    const result = data?.results;
    if (!result) return null;
    const details = result.details    || {};
    const greeks  = result.greeks     || {};
    const day     = result.day        || {};
    const quote   = result.last_quote || {};
    const bid = quote.bid  || day.close || 0;
    const ask = quote.ask  || day.close || 0;
    const mid = bid && ask ? parseFloat(((bid + ask) / 2).toFixed(2)) : 0;
    return {
      ticker: optionTicker,
      bid: parseFloat(bid.toFixed(2)), ask: parseFloat(ask.toFixed(2)), mid,
      volume: day.volume || 0, openInterest: result.open_interest || 0,
      delta: parseFloat((greeks.delta || 0).toFixed(4)),
      gamma: parseFloat((greeks.gamma || 0).toFixed(4)),
      theta: parseFloat((greeks.theta || 0).toFixed(4)),
      vega:  parseFloat((greeks.vega  || 0).toFixed(4)),
      iv:    parseFloat(((result.implied_volatility || 0) * 100).toFixed(1)),
      strike: details.strike_price || 0, expiry: details.expiration_date || '',
      contractType: details.contract_type || '',
    };
  } catch { return null; }
}

// ── FIND BEST CONTRACT — used by alerter.js ───────────────────────
async function findBestContract(opraSymbol) {
  const parsed = parseOPRA(opraSymbol);
  if (!parsed) return { error: 'Could not parse OPRA: ' + opraSymbol };
  const { ticker, expiry, type } = parsed;
  const price = await getPrice(ticker);
  if (!price) return { error: `No price for ${ticker}` };
  const lo = (price * 0.90).toFixed(0);
  const hi = (price * 1.10).toFixed(0);
  try {
    const res  = await fetch(`${POLY_BASE}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expiry}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${polyKey()}`);
    const data = await res.json();
    const contracts = data?.results || [];
    if (!contracts.length) return { error: `No contracts for ${ticker} ${type} ${expiry}` };
    let best = null;
    for (const c of contracts) {
      const snap    = await getOptionSnapshot(c.ticker);
      if (!snap) continue;
      const premium = snap.mid || snap.ask;
      if (premium < MIN_PREMIUM || premium > MAX_PREMIUM) continue;
      const score   = scoreContract(snap, price);
      if (!best || score.total > best.score.total) {
        best = {
          ticker, optionTicker: c.ticker,
          strike: snap.strike, expiry: snap.expiry,
          type, premium, bid: snap.bid, ask: snap.ask, mid: snap.mid,
          volume: snap.volume, openInterest: snap.openInterest,
          delta: snap.delta, gamma: snap.gamma, theta: snap.theta,
          vega: snap.vega, iv: snap.iv, price, score, isLive: true,
          volumeProfile: null, kingNodeLine: null,
        };
      }
    }
    if (!best) return { error: `No contracts in range` };
    return best;
  } catch (err) { return { error: err.message }; }
}

// ── SCORE CONTRACT ────────────────────────────────────────────────
function scoreContract(snap, underlyingPrice) {
  let total = 0;
  const warnings = [];
  const premium   = snap.mid || snap.ask;
  const spreadPct = snap.ask > 0 ? ((snap.ask - snap.bid) / snap.ask * 100) : 100;
  const absDelta  = Math.abs(snap.delta);
  const distPct   = Math.abs(snap.strike - underlyingPrice) / underlyingPrice * 100;
  if (premium <= MAX_PREMIUM)               { total += 2; } else { warnings.push('Premium over max'); }
  if (spreadPct < 10)                       { total += 1; } else { warnings.push(`Wide spread ${spreadPct.toFixed(1)}%`); }
  if (snap.volume >= 100)                   { total += 2; } else { warnings.push(`Low volume ${snap.volume}`); }
  if (absDelta >= 0.20 && absDelta <= 0.60) { total += 2; } else { warnings.push(`Delta ${absDelta.toFixed(2)}`); }
  if (snap.theta >= -0.10)                  { total += 1; } else { warnings.push(`High theta ${snap.theta}`); }
  if (distPct <= 10)                        { total += 2; } else { warnings.push(`Strike ${distPct.toFixed(1)}% from price`); }
  if (snap.openInterest >= 100)             { total += 1; } else { warnings.push(`Low OI ${snap.openInterest}`); }
  return { total, max: 11, warnings, profitProb: Math.round(absDelta * 100) };
}

// ── POSITION SIZING — mode aware ──────────────────────────────────
function calculatePositionSize(premium, mode = 'SWING', accountSize = 7000) {
  const config = MODES[mode] || MODES.SWING;

  if (!premium || premium <= 0)           return { viable: false, reason: 'No premium' };
  if (premium > config.maxPremium)        return { viable: false, reason: `Premium $${premium} over max $${config.maxPremium} for ${mode}` };
  if (premium < config.minPremium)        return { viable: false, reason: `Premium $${premium} under min $${config.minPremium} for ${mode}` };

  const costPerContract = premium * 100;
  const stopPrice       = parseFloat((premium * (1 - config.stopPct)).toFixed(2));
  const t1Price         = parseFloat((premium * (1 + config.t1Pct)).toFixed(2));
  const t2Price         = parseFloat((premium * (1 + config.t2Pct)).toFixed(2));
  const stopLossOne     = parseFloat((premium * config.stopPct * 100).toFixed(0));

  // Calculate max contracts within risk limit
  const maxContracts    = Math.floor(config.maxRisk / stopLossOne);
  const contracts       = Math.max(1, Math.min(maxContracts, premium <= 1.20 ? 2 : 1));
  const totalStop       = stopLossOne * contracts;
  const t1Profit        = parseFloat(((t1Price - premium) * 100 * contracts).toFixed(0));
  const riskPct         = parseFloat((totalStop / accountSize * 100).toFixed(1));

  return {
    viable: true, mode, contracts, premium,
    totalCost:  parseFloat((costPerContract * contracts).toFixed(0)),
    stopPrice,  t1Price, t2Price,
    stopLoss:   totalStop,
    t1Profit,   riskPct,
  };
}

module.exports = {
  parseOPRA, resolveContract, findBestContract,
  getOptionSnapshot, getPrice, scoreContract, calculatePositionSize,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM, MODES,
};

