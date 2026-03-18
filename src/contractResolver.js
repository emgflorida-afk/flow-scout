// contractResolver.js — Stratum Flow Scout v5.8
// FIXED: Skip expired expirations — use next valid date
// All Public.com request formats verified against API docs
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const POLY_BASE   = 'https://api.polygon.io';
const PUB_AUTH    = 'https://api.public.com/userapiauthservice/personal/access-tokens';
const PUB_GATEWAY = 'https://api.public.com/userapigateway';

const MIN_PREMIUM = 0.10;
const MAX_PREMIUM = 5.00;

function polyKey() { return process.env.POLYGON_API_KEY; }

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
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent':    'stratum-flow-scout',
        },
        body: JSON.stringify({ instruments: [{ symbol: ticker, type: 'EQUITY' }] }),
      });
      const data  = await res.json();
      const quote = data?.quotes?.[0];
      if (quote?.last) {
        console.log(`[PRICE] ${ticker} $${quote.last} — Public.com ✅`);
        return parseFloat(quote.last);
      }
      console.log(`[PUBLIC] Quote raw:`, JSON.stringify(data));
    }
  } catch (err) { console.error(`[PUBLIC] Price error:`, err.message); }

  // Polygon snapshot fallback
  try {
    const res  = await fetch(`${POLY_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${polyKey()}`);
    const data = await res.json();
    const price = data?.ticker?.lastTrade?.p || data?.ticker?.prevDay?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon ✅`); return price; }
  } catch { }

  // Polygon prev close fallback
  try {
    const res  = await fetch(`${POLY_BASE}/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey()}`);
    const data = await res.json();
    const price = data?.results?.[0]?.c || null;
    if (price) { console.log(`[PRICE] ${ticker} $${price} — Polygon prev ✅`); return price; }
  } catch { }

  console.error(`[PRICE] No price for ${ticker}`);
  return null;
}

// ── OPTION EXPIRATIONS ────────────────────────────────────────────
async function getPublicExpirations(ticker, token, accountId) {
  try {
    const res  = await fetch(`${PUB_GATEWAY}/marketdata/${accountId}/option-expirations`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'stratum-flow-scout',
      },
      body: JSON.stringify({ instrument: { symbol: ticker, type: 'EQUITY' } }),
    });
    const data        = await res.json();
    const expirations = data?.expirations || [];
    if (expirations.length) console.log(`[PUBLIC] ${ticker} expirations: ${expirations.slice(0,3).join(', ')} ✅`);
    else console.log(`[PUBLIC] No expirations:`, JSON.stringify(data));
    return expirations;
  } catch (err) { console.error(`[PUBLIC EXPIRY] Error:`, err.message); return []; }
}

// ── OPTION CHAIN ──────────────────────────────────────────────────
async function getPublicOptionChain(ticker, expDate, type, token, accountId) {
  try {
    const res  = await fetch(`${PUB_GATEWAY}/marketdata/${accountId}/option-chain`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent':    'stratum-flow-scout',
      },
      body: JSON.stringify({
        instrument:     { symbol: ticker, type: 'EQUITY' },
        expirationDate: expDate,
      }),
    });
    const data  = await res.json();
    const chain = type === 'call' ? (data?.calls || []) : (data?.puts || []);
    console.log(`[PUBLIC CHAIN] ${ticker} ${type} ${expDate} — ${chain.length} contracts ✅`);
    return chain;
  } catch (err) { console.error(`[PUBLIC CHAIN] Error:`, err.message); return []; }
}

// ── NEXT FRIDAY FALLBACK ──────────────────────────────────────────
function getNextExpiry() {
  const now    = new Date();
  const day    = now.getDay();
  const daysTo = day <= 5 ? 5 - day : 6;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + (daysTo === 0 ? 7 : daysTo));
  return expiry.toISOString().slice(0, 10);
}

// ── RESOLVE CONTRACT ──────────────────────────────────────────────
async function resolveContract(ticker, type = 'call') {
  const price     = await getPrice(ticker);
  if (!price) return null;

  const accountId = process.env.PUBLIC_ACCOUNT_ID;
  const token     = await getPublicToken();
  let   expDate   = getNextExpiry();

  if (token && accountId) {
    const expirations = await getPublicExpirations(ticker, token, accountId);

    // FIXED: Skip today and past dates — only use future expirations
    const today    = new Date().toISOString().slice(0, 10);
    const validExp = expirations.filter(e => e > today);
    if (validExp.length > 0) {
      expDate = validExp[0];
      console.log(`[EXPIRY] ${ticker} using ${expDate} ✅`);
    } else {
      console.log(`[EXPIRY] ${ticker} no future expirations — using fallback ${expDate}`);
    }
  }

  if (token && accountId) {
    const chain = await getPublicOptionChain(ticker, expDate, type, token, accountId);

    if (chain.length > 0) {
      const candidates = chain.filter(c => {
        const mid = (parseFloat(c.bid || 0) + parseFloat(c.ask || 0)) / 2;
        return mid >= MIN_PREMIUM && mid <= MAX_PREMIUM;
      });

      if (candidates.length > 0) {
        const withStrike = candidates.map(c => {
          const sym    = c.instrument?.symbol || '';
          const match  = sym.match(/(\d{6})([CP])(\d{8})$/);
          const strike = match ? parseInt(match[3]) / 1000 : 0;
          const mid    = (parseFloat(c.bid || 0) + parseFloat(c.ask || 0)) / 2;
          return { ...c, strike, mid: parseFloat(mid.toFixed(2)), symbol: sym };
        });

        const best = withStrike.reduce((a, b) =>
          Math.abs(a.strike - price) < Math.abs(b.strike - price) ? a : b
        );

        if (best.symbol) {
          console.log(`[OPRA] ${ticker} resolved via Public ✅ ${best.symbol} strike $${best.strike} mid $${best.mid}`);
          return best.symbol;
        }
      } else {
        console.log(`[OPRA] ${ticker} — no contracts in $${MIN_PREMIUM}–$${MAX_PREMIUM} range`);
      }
    }
  }

  // Polygon fallback
  console.log(`[OPRA] Falling back to Polygon for ${ticker}`);
  const lo = (price * 0.90).toFixed(0);
  const hi = (price * 1.10).toFixed(0);

  try {
    let res  = await fetch(`${POLY_BASE}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${expDate}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${polyKey()}`);
    let data = await res.json();
    let contracts = data?.results || [];

    if (!contracts.length) {
      const next = new Date();
      next.setDate(next.getDate() + 7);
      res       = await fetch(`${POLY_BASE}/v3/reference/options/contracts?underlying_ticker=${ticker}&contract_type=${type}&expiration_date=${next.toISOString().slice(0,10)}&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=50&apiKey=${polyKey()}`);
      data      = await res.json();
      contracts = data?.results || [];
    }

    if (!contracts.length) { console.error(`[OPRA] No contracts for ${ticker}`); return null; }

    const best = contracts.reduce((a, b) =>
      Math.abs(a.strike_price - price) < Math.abs(b.strike_price - price) ? a : b
    );
    console.log(`[OPRA] ${ticker} via Polygon: ${best.ticker}`);
    return best.ticker;
  } catch (err) { console.error(`[OPRA] Polygon failed:`, err.message); return null; return null; }
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
    if (!best) return { error: `No contracts in $${MIN_PREMIUM}–$${MAX_PREMIUM} range` };
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
