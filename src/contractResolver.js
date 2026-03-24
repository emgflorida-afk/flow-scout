// contractResolver.js — Stratum Flow Scout v5.9
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// DAY:    0-1DTE  $0.30–$1.50  naked option
// SWING:  5-7DTE  $0.50–$3.00  naked option
// SPREAD: 5-7DTE  $0.50–$1.50  vertical debit spread
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
    stopPct:    0.40,
    t1Pct:      0.60,
    t2Pct:      1.20,
    maxRisk:    120,
    spread:     false,
  },
  SWING: {
    label:      'SWING TRADE',
    minPremium: 0.50,
    maxPremium: 3.00,
    minDTE:     4,
    maxDTE:     14,
    stopPct:    0.40,
    t1Pct:      0.60,
    t2Pct:      1.20,
    maxRisk:    140,
    spread:     false,
  },
  SPREAD: {
    label:      'SPREAD TRADE',
    minPremium: 0.50,
    maxPremium: 1.50,
    minDTE:     4,
    maxDTE:     14,
    stopPct:    0.50,
    t1Pct:      1.00,
    t2Pct:      2.00,
    maxRisk:    150,
    spread:     true,
    spreadWidth: 5,   // $5 wide spread default — adjust per ticker
  },
};

const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 3.00;

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// Spread width per ticker — wider for expensive stocks
const SPREAD_WIDTHS = {
  SPY:  5,
  QQQ:  5,
  IWM:  3,
  NVDA: 10,
  TSLA: 10,
  META: 10,
  GOOGL:10,
  AMZN: 10,
  MSFT: 10,
  AMD:  5,
  JPM:  5,
  GS:   10,
  BAC:  2,
  WFC:  3,
};

function getSpreadWidth(ticker) {
  return SPREAD_WIDTHS[ticker] || 5;
}

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
  const expiry = new Date(expDateStr + 'T16:00:00-04:00');
  return Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
}

// ── SELECT EXPIRY FOR MODE ────────────────────────────────────────
function selectExpiry(expirations, mode) {
  const today  = new Date().toISOString().slice(0, 10);
  const config = MODES[mode];
  const valid  = expirations.filter(e => {
    const dte = calcDTE(e);
    return dte >= config.minDTE && dte <= config.maxDTE;
  });
  if (valid.length > 0) {
    console.log(`[EXPIRY] ${mode} mode — using ${valid[0]} (${calcDTE(valid[0])}DTE) ✅`);
    return valid[0];
  }
  const future = expirations.filter(e => e > today);
  if (future.length > 0) {
    console.log(`[EXPIRY] ${mode} fallback — using ${future[0]}`);
    return future[0];
  }
  return null;
}

// ── PARSE CONTRACT FROM CHAIN ─────────────────────────────────────
function parseChainContract(c) {
  const sym    = c.instrument?.symbol || '';
  const match  = sym.match(/(\d{6})([CP])(\d{8})$/);
  const strike = match ? parseInt(match[3]) / 1000 : 0;
  const bid    = parseFloat(c.bid || 0);
  const ask    = parseFloat(c.ask || 0);
  const mid    = parseFloat(((bid + ask) / 2).toFixed(2));
  return { ...c, strike, mid, bid, ask, symbol: sym };
}

// ── FIND SPREAD LEGS ──────────────────────────────────────────────
// Finds ATM buy leg and OTM sell leg for vertical debit spread
function findSpreadLegs(chain, price, type, ticker) {
  const width    = getSpreadWidth(ticker);
  const parsed   = chain.map(parseChainContract).filter(c => c.strike > 0);

  // Buy leg — ATM (closest to current price)
  const buyLeg   = parsed.reduce((a, b) =>
    Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
  );
  if (!buyLeg) return null;

  // Sell leg — OTM by spread width
  // For calls: sell strike = buy strike + width
  // For puts:  sell strike = buy strike - width
  const sellStrike = type === 'call'
    ? buyLeg.strike + width
    : buyLeg.strike - width;

  const sellLeg = parsed.reduce((a, b) =>
    Math.abs(a.strike - sellStrike) < Math.abs(b.strike - sellStrike) ? a : b
  );
  if (!sellLeg) return null;

  // Debit = buy mid - sell mid
  const debit      = parseFloat((buyLeg.mid - sellLeg.mid).toFixed(2));
  const maxProfit  = parseFloat((width - debit).toFixed(2));
  const breakeven  = type === 'call'
    ? parseFloat((buyLeg.strike + debit).toFixed(2))
    : parseFloat((buyLeg.strike - debit).toFixed(2));

  if (debit <= 0) return null;

  console.log(`[SPREAD] ${ticker} ${type} — Buy $${buyLeg.strike} / Sell $${sellLeg.strike} debit $${debit} max profit $${maxProfit}`);

  return {
    buyLeg:     buyLeg,
    sellLeg:    sellLeg,
    debit,
    maxProfit,
    breakeven,
    spreadWidth: width,
    type,
  };
}

// ── RESOLVE CONTRACT ──────────────────────────────────────────────
async function resolveContract(ticker, type = 'call', tradeType = 'SWING') {
  const mode   = (tradeType || '').toUpperCase().includes('DAY')    ? 'DAY'
               : (tradeType || '').toUpperCase().includes('SPREAD') ? 'SPREAD'
               : 'SWING';
  const config = MODES[mode];

  console.log(`[MODE] ${ticker} — ${mode} (${config.minDTE}-${config.maxDTE}DTE, $${config.minPremium}-$${config.maxPremium})`);

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

  const dte = calcDTE(expDate);

  // ── SPREAD MODE ───────────────────────────────────────────────
  if (mode === 'SPREAD') {
    const legs = findSpreadLegs(chain, price, type, ticker);
    if (!legs) {
      console.log(`[SPREAD] Could not build spread for ${ticker} — falling back to SWING`);
      return resolveContract(ticker, type, 'SWING');
    }

    if (legs.debit < config.minPremium || legs.debit > config.maxPremium) {
      console.log(`[SPREAD] Debit $${legs.debit} out of range — falling back to SWING`);
      return resolveContract(ticker, type, 'SWING');
    }

    return {
      symbol:      legs.buyLeg.symbol,
      sellSymbol:  legs.sellLeg.symbol,
      mid:         legs.debit,
      bid:         legs.buyLeg.bid,
      ask:         legs.buyLeg.ask,
      strike:      legs.buyLeg.strike,
      sellStrike:  legs.sellLeg.strike,
      expiry:      expDate,
      mode:        'SPREAD',
      dte,
      debit:       legs.debit,
      maxProfit:   legs.maxProfit,
      breakeven:   legs.breakeven,
      spreadWidth: legs.spreadWidth,
      volume:      legs.buyLeg.volume || 0,
    };
  }

  // ── DAY / SWING MODE ──────────────────────────────────────────
  const withStrike = chain.map(parseChainContract).filter(c =>
    c.mid >= config.minPremium &&
    c.mid <= config.maxPremium &&
    c.strike > 0
  );

  if (!withStrike.length) {
    const fallback = mode === 'DAY' ? 'SWING' : 'DAY';
    console.log(`[OPRA] ${ticker} — no contracts in range for ${mode} — trying ${fallback}`);
    const fallbackExp = selectExpiry(expirations, fallback);
    if (fallbackExp) {
      const fallbackChain = await getPublicOptionChain(ticker, fallbackExp, type, token, accountId);
      const fallbackConfig = MODES[fallback];
      const fallbackContracts = fallbackChain.map(parseChainContract).filter(c =>
        c.mid >= fallbackConfig.minPremium && c.mid <= fallbackConfig.maxPremium && c.strike > 0
      );
      if (fallbackContracts.length) {
        const best = fallbackContracts.reduce((a, b) =>
          Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
        );
        console.log(`[OPRA] ${ticker} via ${fallback} fallback ✅ ${best.symbol} strike $${best.strike} mid $${best.mid}`);
        return { symbol: best.symbol, mid: best.mid, bid: best.bid, ask: best.ask, strike: best.strike, expiry: fallbackExp, mode: fallback, dte: calcDTE(fallbackExp) };
      }
    }
    return null;
  }

  const best = withStrike.reduce((a, b) =>
    Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
  );

  console.log(`[OPRA] ${ticker} ✅ ${best.symbol} strike $${best.strike} mid $${best.mid} ${dte}DTE [${mode}]`);
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

// ── FIND BEST CONTRACT ────────────────────────────────────────────
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
    if (!contracts.length) return { error: `No contracts for ${ticker}` };
    let best = null;
    for (const c of contracts) {
      const snap    = await getOptionSnapshot(c.ticker);
      if (!snap) continue;
      const premium = snap.mid || snap.ask;
      if (premium < MIN_PREMIUM || premium > MAX_PREMIUM) continue;
      const score   = scoreContract(snap, price);
      if (!best || score.total > best.score.total) {
        best = { ticker, optionTicker: c.ticker, strike: snap.strike, expiry: snap.expiry, type, premium, bid: snap.bid, ask: snap.ask, mid: snap.mid, volume: snap.volume, openInterest: snap.openInterest, delta: snap.delta, gamma: snap.gamma, theta: snap.theta, vega: snap.vega, iv: snap.iv, price, score, isLive: true };
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
  if (spreadPct < 10)                       { total += 1; } else { warnings.push(`Wide spread`); }
  if (snap.volume >= 100)                   { total += 2; } else { warnings.push(`Low volume`); }
  if (absDelta >= 0.20 && absDelta <= 0.60) { total += 2; } else { warnings.push(`Delta ${absDelta.toFixed(2)}`); }
  if (snap.theta >= -0.10)                  { total += 1; } else { warnings.push(`High theta`); }
  if (distPct <= 10)                        { total += 2; } else { warnings.push(`Strike far`); }
  if (snap.openInterest >= 100)             { total += 1; } else { warnings.push(`Low OI`); }
  return { total, max: 11, warnings, profitProb: Math.round(absDelta * 100) };
}

// ── POSITION SIZING — mode aware ──────────────────────────────────
function calculatePositionSize(premium, mode = 'SWING', accountSize = 7000, spreadData = null) {
  const config = MODES[mode] || MODES.SWING;

  if (!premium || premium <= 0) return { viable: false, reason: 'No premium' };

  // SPREAD MODE sizing
  if (mode === 'SPREAD' && spreadData) {
    const debit      = spreadData.debit;
    const maxProfit  = spreadData.maxProfit;
    const stopPrice  = parseFloat((debit * 0.50).toFixed(2));
    const t1Price    = parseFloat((debit * 2.00).toFixed(2));
    const maxContracts = Math.floor(config.maxRisk / (debit * 100));
    const contracts  = Math.max(1, Math.min(maxContracts, 3));
    const totalCost  = parseFloat((debit * 100 * contracts).toFixed(0));
    const maxLoss    = totalCost;
    const maxGain    = parseFloat((maxProfit * 100 * contracts).toFixed(0));
    const riskPct    = parseFloat((maxLoss / accountSize * 100).toFixed(1));

    return {
      viable: true, mode: 'SPREAD', contracts,
      debit, maxProfit, stopPrice, t1Price,
      totalCost, maxLoss, maxGain, riskPct,
      breakeven: spreadData.breakeven,
    };
  }

  // DAY / SWING sizing
  if (premium > config.maxPremium) return { viable: false, reason: `Premium $${premium} over max $${config.maxPremium}` };
  if (premium < config.minPremium) return { viable: false, reason: `Premium $${premium} under min $${config.minPremium}` };

  const costPerContract = premium * 100;
  const stopPrice       = parseFloat((premium * (1 - config.stopPct)).toFixed(2));
  const t1Price         = parseFloat((premium * (1 + config.t1Pct)).toFixed(2));
  const t2Price         = parseFloat((premium * (1 + config.t2Pct)).toFixed(2));
  const stopLossOne     = parseFloat((premium * config.stopPct * 100).toFixed(0));
  const maxContracts    = Math.floor(config.maxRisk / stopLossOne);
  const contracts       = Math.max(1, Math.min(maxContracts, premium <= 1.20 ? 2 : 1));
  const totalStop       = stopLossOne * contracts;
  const t1Profit        = parseFloat(((t1Price - premium) * 100 * contracts).toFixed(0));
  const riskPct         = parseFloat((totalStop / accountSize * 100).toFixed(1));

  return {
    viable: true, mode, contracts, premium,
    totalCost:  parseFloat((costPerContract * contracts).toFixed(0)),
    stopPrice, t1Price, t2Price,
    stopLoss:   totalStop, t1Profit, riskPct,
  };
}

module.exports = {
  parseOPRA, resolveContract, findBestContract,
  getOptionSnapshot, getPrice, scoreContract,
  calculatePositionSize, findSpreadLegs,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM, MODES,
};

