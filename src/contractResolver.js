// contractResolver.js — Stratum Flow Scout v5.8
// UPDATED: Public.com option chain for live contracts
// Polygon used only as fallback
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE_URL    = 'https://api.polygon.io';
const PUBLIC_BASE = 'https://api.public.com';
const MIN_PREMIUM = 0.10;
const MAX_PREMIUM = 5.00;

function apiKey() { return process.env.POLYGON_API_KEY; }

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// ── PUBLIC.COM TOKEN ──────────────────────────────────────────────
async function getPublicToken() {
  try {
    const secret = process.env.PUBLIC_API_KEY;
    if (!secret) return null;
    const res  = await fetch(`${PUBLIC_BASE}/userapiauthservice/personal/access-tokens`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'stratum-flow-scout' },
      body:    JSON.stringify({ validityInMinutes: 30, secret }),
    });
    const data = await res.json();
    return data?.accessToken || null;
  } catch { return null; }
}

// ── GET STOCK PRICE — Public first, Polygon fallback ─────────────
async function getPrice(ticker) {
  const accountId = process.env.PUBLIC_ACCOUNT_ID;

  // Public.com
  try {
    const token = await getPublicToken();
    if (token && accountId) {
      const res  = await fetch(
        `${PUBLIC_BASE}/userapigateway/marketdata/${accountId}/quotes`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
          body:    JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
        }
      );
      const data  = await res.json();
      const quote = data?.quotes?.[0];
      if (quote?.outcome === 'SUCCESS' && quote.last) {
        console.log(`[PRICE] ${ticker} $${quote.last} — Public.com ✅`);
        return parseFloat(quote.last);
      }
    }
  } catch { }

  // Polygon snapshot
  try {
    const res  = await fetch(`${BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey()}`);
    const data = await res.json();
    const price = data?.ticker?.lastTrade?.p || data?.ticker?.prevDay?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon ✅`); return price; }
  } catch { }

  // Polygon prev close
  try {
    const res  = await fetch(`${BASE_URL}/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey()}`);
    const data = await res.json();
    const price = data?.results?.[0]?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon prev ✅`); return price; }
  } catch { }

  console.error(`[PRICE] No price for ${ticker}`);
  return null;
}

// ── GET OPTION CHAIN — Public.com live ────────────────────────────
async function getPublicOptionChain(ticker, expDate, type) {
  const accountId = process.env.PUBLIC_ACCOUNT_ID;
  try {
    const token = await getPublicToken();
    if (!token || !accountId) return null;

    const res  = await fetch(
      `${PUBLIC_BASE}/userapigateway/marketdata/${accountId}/option-chain`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'stratum-flow-scout' },
        body:    JSON.stringify({
          instrument:     { symbol: ticker, type: 'EQUITY' },
          expirationDate: expDate,
        }),
      }
    );
    const data = await res.json();
    if (!data?.calls && !data?.puts) return null;

    const chain = type === 'call' ? (data.calls || []) : (data.puts || []);
    console.log(`[PUBLIC CHAIN] ${ticker} ${type} ${expDate} — ${chain.length} contracts ✅`);
    return chain;
  } catch (err) {
    console.error(`[PUBLIC CHAIN] Error:`, err.message);
    return null;
  }
}

// ── GET NEXT EXPIRY ───────────────────────────────────────────────
function getNextExpiry() {
  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));
  return expiry.toISOString().slice(0, 10);
}

// ── RESOLVE CONTRACT — main entry point ──────────────────────────
async function resolveContract(ticker, type = 'call') {
  const price   = await getPrice(ticker);
  if (!price) return null;

  const expDate = getNextExpiry();

  // Try Public.com option chain first
  const pubChain = await getPublicOptionChain(ticker, expDate, type);
  if (pubChain && pubChain.length > 0) {
    // Find ATM contract — closest strike to current price within premium range
    const candidates = pubChain.filter(c => {
      const mid = ((parseFloat(c.bid || 0) + parseFloat(c.ask || 0)) / 2);
      return mid >= MIN_PREMIUM && mid <= MAX_PREMIUM;
    });

    if (candidates.length > 0) {
      // Parse strike from symbol and find closest to price
      const best = candidates.reduce((a, b) => {
        const strikeA = parseFloat(a.instrument?.symbol?.match(/\d+\.?\d*[CP]/)?.[0] || 0);
        const strikeB = parseFloat(b.instrument?.symbol?.match(/\d+\.?\d*[CP]/)?.[0] || 0);
        return Math.abs(strikeA - price) < Math.abs(strikeB - price) ? a : b;
      });

      const symbol = best.instrument?.symbol;
      if (symbol) {
        console.log(`[OPRA] ${ticker} resolved via Public: ${symbol}`);
        return symbol;
      }
    }
  }

  // Polygon fallback
  const lo = (price * 0.90).toFixed(0);
  const hi = (price * 1.10).toFixed(0);

  try {
    let res  = await fetch(`${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${apiKey()}`);
    let data = await res.json();
    let contracts = data?.results || [];

    if (!contracts.length) {
      const next = new Date();
      next.setDate(next.getDate() + 7);
      res  = await fetch(`${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${next.toISOString().slice(0,10)}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${apiKey()}`);
      data = await res.json();
      contracts = data?.results || [];
    }

    if (!contracts.length) return null;

    const best = contracts.reduce((a, b) =>
      Math.abs(a.strike_price - price) < Math.abs(b.strike_price - price) ? a : b
    );

    console.log(`[OPRA] ${ticker} resolved via Polygon: ${best.ticker}`);
    return best.ticker;
  } catch { return null; }
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
    const res    = await fetch(`${BASE_URL}/v3/snapshot/options/${optionTicker}?apiKey=${apiKey()}`);
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
      ticker: optionTicker, bid: parseFloat(bid.toFixed(2)),
      ask: parseFloat(ask.toFixed(2)), mid,
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

  const res  = await fetch(`${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expiry}&strike_price_gte=${(price*0.90).toFixed(0)}&strike_price_lte=${(price*1.10).toFixed(0)}&limit=50&apiKey=${apiKey()}`);
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

  if (!best) return { error: `No contracts in $${MIN_PREMIUM}–$${MAX_PREMIUM} range` };
  return best;
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

// ── POSITION SIZING ───────────────────────────────────────────────
function calculatePositionSize(premium, accountSize = 7000) {
  const maxLoss            = accountSize * 0.02;
  const costPerContract    = premium * 100;
  const maxLossPerContract = costPerContract * 0.50;

  if (premium > MAX_PREMIUM) return { viable: false, reason: `Premium $${premium} over max` };
  if (premium < MIN_PREMIUM) return { viable: false, reason: `Premium $${premium} under min` };

  const contracts = premium <= 1.20 ? 2 : 1;
  const totalStop = maxLossPerContract * contracts;
  if (totalStop > maxLoss) return { viable: false, reason: `Stop $${totalStop.toFixed(0)} exceeds max $${maxLoss}` };

  return {
    viable: true, contracts, premium,
    totalCost: costPerContract * contracts,
    stopPrice: parseFloat((premium * 0.50).toFixed(2)),
    t1Price:   parseFloat((premium * 1.50).toFixed(2)),
    t2Price:   parseFloat((premium * 2.00).toFixed(2)),
    stopLoss:  parseFloat(totalStop.toFixed(0)),
    t1Profit:  parseFloat(((premium * 0.50) * 100 * contracts).toFixed(0)),
    riskPct:   parseFloat((totalStop / accountSize * 100).toFixed(1)),
  };
}

module.exports = {
  parseOPRA, resolveContract, findBestContract,
  getOptionSnapshot, getPrice, scoreContract, calculatePositionSize,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM,
};
