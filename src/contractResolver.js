javascript// contractResolver.js — Stratum Flow Scout
// PURPOSE: Get REAL contracts from Massive (Polygon) API
// FIXED: API key now read at call time (not startup) — fixes undefined key bug
// UPDATED: King Node / Volume Profile detection via Polygon aggregates
// ─────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE_URL = 'https://api.polygon.io';

// ── HELPER — always fresh API key ────────────────────────────────
function apiKey() {
  return process.env.POLYGON_API_KEY;
}

// ── WATCHLIST FILTER ─────────────────────────────────────────────
const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// ── PREMIUM RULES ────────────────────────────────────────────────
const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 2.40;

// ── PARSE BULLFLOW OPRA SYMBOL ───────────────────────────────────
function parseOPRA(opraSymbol) {
  try {
    const raw   = opraSymbol.replace(/^O:/, '');
    const match = raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;

    const [, ticker, dateStr, type, strikeRaw] = match;
    const yy     = dateStr.slice(0, 2);
    const mm     = dateStr.slice(2, 4);
    const dd     = dateStr.slice(4, 6);
    const year   = parseInt(yy) >= 50 ? '19' + yy : '20' + yy;
    const expiry = `${year}-${mm}-${dd}`;
    const strike = parseInt(strikeRaw) / 1000;

    return { ticker, expiry, type: type === 'C' ? 'call' : 'put', strike };
  } catch {
    return null;
  }
}

// ── KING NODE / VOLUME PROFILE ───────────────────────────────────
// Pulls 30 days of daily bars from Polygon
// Buckets volume by price level ($0.50 increments)
// Returns: kingNode (POC), purpleNodes (low vol), currentLevel
async function getVolumeProfile(ticker) {
  try {
    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);

    const toStr   = to.toISOString().slice(0, 10);
    const fromStr = from.toISOString().slice(0, 10);

    const url  = `${BASE_URL}/v2/aggs/ticker/${ticker}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=50&apiKey=${apiKey()}`;
    const res  = await fetch(url);
    const data = await res.json();

    const bars = data?.results || [];
    if (bars.length === 0) return null;

    // Bucket volume by $0.50 price increments
    const buckets = {};
    for (const bar of bars) {
      const avgPrice  = (bar.h + bar.l) / 2;
      const bucket    = (Math.round(avgPrice / 0.50) * 0.50).toFixed(2);
      buckets[bucket] = (buckets[bucket] || 0) + bar.v;
    }

    // Find total volume for percentile calc
    const entries    = Object.entries(buckets).map(([price, vol]) => ({
      price: parseFloat(price),
      vol,
    }));
    const totalVol   = entries.reduce((sum, e) => sum + e.vol, 0);
    const avgVol     = totalVol / entries.length;

    // King Node = highest volume bucket (Point of Control)
    const kingNode   = entries.reduce((a, b) => b.vol > a.vol ? b : a);

    // Purple Nodes = buckets with less than 30% of average volume (fast drop zones)
    const purpleNodes = entries
      .filter(e => e.vol < avgVol * 0.30)
      .map(e => e.price)
      .sort((a, b) => a - b);

    // Current price level
    const lastBar     = bars[bars.length - 1];
    const currentPrice = lastBar.c;

    // Is current price near King Node? (within 1%)
    const nearKing = Math.abs(currentPrice - kingNode.price) / currentPrice <= 0.01;

    // Purple nodes below current price (fast drop zones)
    const purpleBelow = purpleNodes.filter(p => p < currentPrice).slice(-3);

    // Purple nodes above current price
    const purpleAbove = purpleNodes.filter(p => p > currentPrice).slice(0, 3);

    return {
      kingNode:     kingNode.price,
      kingVolume:   kingNode.vol,
      purpleBelow,
      purpleAbove,
      currentPrice,
      nearKing,
      totalBars:    bars.length,
    };
  } catch (err) {
    console.error('[VOLUME PROFILE] Failed:', err.message);
    return null;
  }
}

// ── FORMAT KING NODE ALERT LINE ──────────────────────────────────
function formatKingNodeLine(profile) {
  if (!profile) return null;

  const lines = [];

  if (profile.nearKing) {
    lines.push(`👑 AT KING NODE $${profile.kingNode} — HIGHEST CONVICTION 🔥`);
  } else {
    lines.push(`👑 King Node: $${profile.kingNode}`);
  }

  if (profile.purpleBelow.length > 0) {
    lines.push(`⚡ Fast drop zones below: $${profile.purpleBelow.join(', $')}`);
  }

  if (profile.purpleAbove.length > 0) {
    lines.push(`⚡ Fast move zones above: $${profile.purpleAbove.join(', $')}`);
  }

  return lines.join('\n');
}

// ── GET REAL OPTIONS CHAIN ───────────────────────────────────────
async function getRealChain(ticker, contractType, expiryDate) {
  try {
    const params = new URLSearchParams({
      underlying_ticker: ticker,
      contract_type:     contractType,
      expiration_date:   expiryDate,
      limit:             '250',
      order:             'asc',
      sort:              'strike_price',
      apiKey:            apiKey(),
    });

    const url  = `${BASE_URL}/v3/reference/options/contracts?${params}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.results || data.results.length === 0) return [];
    return data.results;
  } catch (err) {
    console.error('[CHAIN] Fetch failed:', err.message);
    return [];
  }
}

// ── GET OPTION SNAPSHOT ──────────────────────────────────────────
async function getOptionSnapshot(optionTicker) {
  try {
    const url  = `${BASE_URL}/v3/snapshot/options/${optionTicker}?apiKey=${apiKey()}`;
    const res  = await fetch(url);
    const data = await res.json();

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
      ticker:       optionTicker,
      bid:          parseFloat(bid.toFixed(2)),
      ask:          parseFloat(ask.toFixed(2)),
      mid,
      volume:       day.volume           || 0,
      openInterest: result.open_interest || 0,
      delta:        parseFloat((greeks.delta || 0).toFixed(4)),
      gamma:        parseFloat((greeks.gamma || 0).toFixed(4)),
      theta:        parseFloat((greeks.theta || 0).toFixed(4)),
      vega:         parseFloat((greeks.vega  || 0).toFixed(4)),
      iv:           parseFloat(((result.implied_volatility || 0) * 100).toFixed(1)),
      strike:       details.strike_price     || 0,
      expiry:       details.expiration_date  || '',
      contractType: details.contract_type    || '',
    };
  } catch (err) {
    console.error('[SNAPSHOT] Failed:', err.message);
    return null;
  }
}

// ── GET UNDERLYING PRICE ─────────────────────────────────────────
async function getUnderlyingPrice(ticker) {
  try {
    const url  = `${BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey()}`;
    const res  = await fetch(url);
    const data = await res.json();

    const price = data?.ticker?.lastTrade?.p
               || data?.ticker?.day?.c
               || data?.ticker?.day?.open
               || data?.ticker?.prevDay?.c
               || null;

    if (price) return price;

    const prevUrl  = `${BASE_URL}/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey()}`;
    const prevRes  = await fetch(prevUrl);
    const prevData = await prevRes.json();
    return prevData?.results?.[0]?.c || null;
  } catch {
    return null;
  }
}

// ── FIND BEST CONTRACT ───────────────────────────────────────────
async function findBestContract(opraSymbol) {
  const parsed = parseOPRA(opraSymbol);
  if (!parsed) return { error: 'Could not parse OPRA: ' + opraSymbol };

  const { ticker, expiry, type, strike: hintStrike } = parsed;

  if (!WATCHLIST.has(ticker)) return { error: `${ticker} not on watchlist` };

  const price = await getUnderlyingPrice(ticker);
  if (!price) return { error: `Could not get price for ${ticker}` };

  const chain = await getRealChain(ticker, type, expiry);
  if (chain.length === 0) return { error: `No contracts for ${ticker} ${type} ${expiry}` };

  const maxDist    = price * 0.03;
  const candidates = chain.filter(c => Math.abs(c.strike_price - price) <= maxDist);
  if (candidates.length === 0) return { error: `No strikes within 3% of $${price}` };

  let bestContract = null;

  for (const candidate of candidates) {
    const snap = await getOptionSnapshot(candidate.ticker);
    if (!snap) continue;

    const premium = snap.mid || snap.ask;
    if (premium < MIN_PREMIUM || premium > MAX_PREMIUM) continue;

    const score = scoreContract(snap, price);

    if (!bestContract || score.total > bestContract.score.total) {
      bestContract = {
        ticker, optionTicker: candidate.ticker,
        strike: snap.strike, expiry: snap.expiry,
        type, premium,
        bid: snap.bid, ask: snap.ask, mid: snap.mid,
        volume: snap.volume, openInterest: snap.openInterest,
        delta: snap.delta, gamma: snap.gamma,
        theta: snap.theta, vega: snap.vega,
        iv: snap.iv, price, score, isLive: true,
      };
    }
  }

  if (!bestContract) return { error: `No contracts in $${MIN_PREMIUM}–$${MAX_PREMIUM} range` };

  // ── ATTACH VOLUME PROFILE ──────────────────────────────────────
  const profile = await getVolumeProfile(bestContract.ticker);
  bestContract.volumeProfile    = profile;
  bestContract.kingNodeLine     = formatKingNodeLine(profile);

  return bestContract;
}

// ── CONTRACT SCORING (1–11) ──────────────────────────────────────
function scoreContract(snap, underlyingPrice) {
  let total = 0;
  const breakdown = {};
  const warnings  = [];

  const premium   = snap.mid || snap.ask;
  const spread    = snap.ask - snap.bid;
  const spreadPct = snap.ask > 0 ? (spread / snap.ask) * 100 : 100;
  const absDelta  = Math.abs(snap.delta);
  const distPct   = Math.abs(snap.strike - underlyingPrice) / underlyingPrice * 100;

  if (premium <= 2.40)                         { total += 2; breakdown.premium = '+2 ✅'; }
  else                                         { warnings.push('Premium over $2.40'); }

  if (spreadPct < 10)                          { total += 1; breakdown.spread = '+1 ✅'; }
  else                                         { warnings.push(`Wide spread ${spreadPct.toFixed(1)}%`); }

  if (snap.volume >= 500)                      { total += 2; breakdown.volume = '+2 ✅'; }
  else                                         { warnings.push(`Low volume ${snap.volume}`); }

  if (absDelta >= 0.30 && absDelta <= 0.50)   { total += 2; breakdown.delta = '+2 ✅'; }
  else if (absDelta > 0.50)                    { warnings.push('Delta too high — deep ITM'); }
  else                                         { warnings.push('Delta under 0.30 — far OTM'); }

  if (snap.theta >= -0.05)                     { total += 1; breakdown.theta = '+1 ✅'; }
  else                                         { warnings.push(`High theta ${snap.theta}`); }

  if (distPct <= 3)                            { total += 2; breakdown.strike = '+2 ✅'; }
  else                                         { warnings.push(`Strike ${distPct.toFixed(1)}% from price`); }

  if (snap.openInterest >= 1000)               { total += 1; breakdown.oi = '+1 ✅'; }
  else                                         { warnings.push(`Low OI ${snap.openInterest}`); }

  const profitProb = Math.round(absDelta * 100);
  return { total, max: 11, breakdown, warnings, profitProb };
}

// ── POSITION SIZING ──────────────────────────────────────────────
function calculatePositionSize(premium, accountSize = 6000) {
  const maxLoss            = accountSize * 0.02;
  const costPerContract    = premium * 100;
  const maxLossPerContract = costPerContract * 0.50;

  if (premium > MAX_PREMIUM) return { viable: false, reason: `Premium $${premium} over max` };
  if (premium < MIN_PREMIUM) return { viable: false, reason: `Premium $${premium} under min` };

  const contracts  = premium <= 1.20 ? 2 : 1;
  const totalStop  = maxLossPerContract * contracts;
  if (totalStop > maxLoss) return { viable: false, reason: `Stop $${totalStop} exceeds max $${maxLoss}` };

  const stopPrice = parseFloat((premium * 0.50).toFixed(2));
  const t1Price   = parseFloat((premium * 1.50).toFixed(2));
  const t2Price   = parseFloat((premium * 2.00).toFixed(2));
  const stopLoss  = parseFloat(totalStop.toFixed(0));
  const t1Profit  = parseFloat(((t1Price - premium) * 100 * contracts).toFixed(0));
  const riskPct   = parseFloat((totalStop / accountSize * 100).toFixed(1));

  return {
    viable: true, contracts, premium,
    totalCost: costPerContract * contracts,
    stopPrice, t1Price, t2Price,
    stopLoss, t1Profit, riskPct,
    hasRunner: contracts > 1,
  };
}

module.exports = {
  parseOPRA, findBestContract, getOptionSnapshot,
  getUnderlyingPrice, scoreContract, calculatePositionSize,
  getVolumeProfile, formatKingNodeLine,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM,
};
