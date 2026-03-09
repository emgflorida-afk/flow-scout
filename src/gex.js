// ─── GEX ENGINE ────────────────────────────────────────────────────
const axios = require('axios');

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const BASE = 'https://api.polygon.io';
const gexCache = new Map();

function getCacheKey(ticker) {
  const today = new Date().toISOString().split('T')[0];
  return `${ticker}-${today}`;
}

async function getSpotPrice(ticker) {
  try {
    const res = await axios.get(`${BASE}/v2/last/trade/${ticker}`, {
      params: { apiKey: POLYGON_KEY }
    });
    return res.data?.results?.p || null;
  } catch {
    try {
      const res = await axios.get(`${BASE}/v2/aggs/ticker/${ticker}/prev`, {
        params: { apiKey: POLYGON_KEY }
      });
      return res.data?.results?.[0]?.c || null;
    } catch { return null; }
  }
}

async function getOptionsChain(ticker, spotPrice) {
  try {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 45);
    const expiryStr = expiry.toISOString().split('T')[0];

    const res = await axios.get(`${BASE}/v3/snapshot/options/${ticker}`, {
      params: {
        apiKey: POLYGON_KEY,
        expiration_date_lte: expiryStr,
        limit: 250,
        strike_price_gte: spotPrice * 0.85,
        strike_price_lte: spotPrice * 1.15,
      }
    });
    return res.data?.results || [];
  } catch (err) {
    console.error(`[GEX] Failed to fetch options chain for ${ticker}:`, err.message);
    return [];
  }
}

function calculateGEX(options, spotPrice) {
  const strikeMap = new Map();

  for (const opt of options) {
    const strike = opt.details?.strike_price;
    const gamma  = opt.greeks?.gamma;
    const oi     = opt.open_interest;
    const type   = opt.details?.contract_type;

    if (!strike || !gamma || !oi) continue;

    const gex = gamma * oi * 100 * Math.pow(spotPrice, 2) * 0.01;
    const signedGex = type === 'call' ? gex : -gex;

    if (!strikeMap.has(strike)) {
      strikeMap.set(strike, { strike, gex: 0, callGex: 0, putGex: 0 });
    }
    const entry = strikeMap.get(strike);
    entry.gex += signedGex;
    if (type === 'call') entry.callGex += gex;
    else entry.putGex += gex;
  }

  const strikes = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
  const totalNetGex = strikes.reduce((sum, s) => sum + s.gex, 0);

  let cumulativeGex = 0;
  let gammaFlip = null;
  for (const s of strikes) {
    const prevCum = cumulativeGex;
    cumulativeGex += s.gex;
    if ((prevCum < 0 && cumulativeGex >= 0) || (prevCum > 0 && cumulativeGex <= 0)) {
      gammaFlip = s.strike;
      break;
    }
  }

  const pinStrike = strikes.reduce((max, s) => s.gex > (max?.gex ?? -Infinity) ? s : max, null);
  const volZoneStrike = strikes.reduce((min, s) => s.gex < (min?.gex ?? Infinity) ? s : min, null);
  const sortedPositive = strikes.filter(s => s.gex > 0).sort((a, b) => b.gex - a.gex);

  return {
    totalNetGex, gammaFlip,
    pin: pinStrike?.strike || null,
    pinGex: pinStrike?.gex || 0,
    volZone: volZoneStrike?.strike || null,
    volZoneGex: volZoneStrike?.gex || 0,
    secondaryPin: sortedPositive[1]?.strike || null,
    strikes, spotPrice,
  };
}

function scoreGEX(gexData, contract) {
  if (!gexData) return { score: 0, reasons: [] };

  const { totalNetGex, gammaFlip, pin, volZone, spotPrice } = gexData;
  const { strike, type } = contract;

  let score = 0;
  const reasons = [];

  const absGex = Math.abs(totalNetGex);
  if (absGex > 500_000_000)      { score += 2;   reasons.push('Massive GEX (500M+)'); }
  else if (absGex > 200_000_000) { score += 1.5; reasons.push('Large GEX (200M+)'); }
  else if (absGex > 50_000_000)  { score += 1;   reasons.push('Moderate GEX (50M+)'); }
  else if (absGex > 10_000_000)  { score += 0.5; reasons.push('Low GEX (10M+)'); }

  if (gammaFlip) {
    const aboveFlip = spotPrice > gammaFlip;
    if ((type === 'CALL' && aboveFlip) || (type === 'PUT' && !aboveFlip)) {
      score += 2; reasons.push(`Flow aligns with gamma regime (flip @ $${gammaFlip})`);
    } else {
      score -= 1; reasons.push(`⚠️ Flow AGAINST gamma regime — counter-trend`);
    }
  }

  if (pin) {
    const distToPin = Math.abs(strike - pin) / spotPrice;
    if (distToPin < 0.02)      { score += 1;   reasons.push(`Within 2% of pin ($${pin})`); }
    else if (distToPin < 0.05) { score += 0.5; reasons.push(`Within 5% of pin ($${pin})`); }
  }

  if (volZone) {
    const distToVol = Math.abs(spotPrice - volZone) / spotPrice;
    if (distToVol > 0.05) { score += 1; reasons.push('Vol zone clear'); }
    else { reasons.push(`⚠️ Near vol zone ($${volZone})`); }
  }

  const finalScore = Math.min(6, Math.max(0, score));
  const stars = finalScore >= 5.5 ? 5 : finalScore >= 4.5 ? 4 : finalScore >= 3.0 ? 3 : finalScore >= 1.5 ? 2 : finalScore >= 0.5 ? 1 : 0;

  return { score: finalScore, stars, reasons, gexData };
}

async function getGEXScore(ticker, contract) {
  const cacheKey = getCacheKey(ticker);

  if (gexCache.has(cacheKey)) {
    return scoreGEX(gexCache.get(cacheKey), contract);
  }

  const spotPrice = await getSpotPrice(ticker);
  if (!spotPrice) return { score: 0, stars: 0, reasons: ['No spot price'], gexData: null };

  const options = await getOptionsChain(ticker, spotPrice);
  if (!options.length) return { score: 0, stars: 0, reasons: ['No options data'], gexData: null };

  const gexData = calculateGEX(options, spotPrice);
  gexCache.set(cacheKey, gexData);
  setTimeout(() => gexCache.delete(cacheKey), 30 * 60 * 1000);

  return scoreGEX(gexData, contract);
}

module.exports = { getGEXScore, getSpotPrice };
​​​​​​​​​​​​​​​​
