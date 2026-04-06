// contractResolver.js - Stratum Flow Scout v7.1
// TRADESTATION ONLY -- no Public.com, no Polygon
// LVL Framework -- PDH/PDL structural levels
// Dynamic Stop -- underlying price based
// Smart Entry -- ORB/breakout vs retracement
// Smart Take Profit -- base hits over home runs
// -----------------------------------------------------------------

const fetch = require('node-fetch');

// -- TRADE MODE CONFIGS -------------------------------------------
const MODES = {
  DAY: {
    label: 'DAY TRADE', minPremium: 0.30, maxPremium: 1.50,
    minDTE: 0, maxDTE: 2, stopPct: 0.35, t1Pct: 0.25, maxRisk: 120,
  },
  SWING: {
    label: 'SWING TRADE', minPremium: 0.50, maxPremium: 2.40,
    minDTE: 4, maxDTE: 14, stopPct: 0.40, t1Pct: 0.30, maxRisk: 140,
  },
};

const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 2.40;

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// T1 targets by ticker volatility (% gain)
const T1_TARGETS = {
  TSLA: 0.50, COIN: 0.50, NVDA: 0.50, MRVL: 0.50,
  AAPL: 0.40, AMZN: 0.40, MSFT: 0.40, GOOGL: 0.40,
};
function getT1Target(ticker) {
  return T1_TARGETS[ticker] || 0.30; // 30% default = base hit
}

// -- TRADESTATION TOKEN -------------------------------------------
async function getTSToken() {
  try {
    var ts = require('./tradestation');
    return await ts.getAccessToken();
  } catch(e) {
    console.error('[TS] Token error:', e.message);
    return null;
  }
}

function getTSBase() {
  return process.env.SIM_MODE === 'true'
    ? 'https://sim-api.tradestation.com/v3'
    : 'https://api.tradestation.com/v3';
}

// -- GET STOCK PRICE ----------------------------------------------
async function getPrice(ticker) {
  try {
    var token = await getTSToken();
    if (!token) return null;
    var res = await fetch(getTSBase() + '/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var quotes = data.Quotes || data.quotes || (Array.isArray(data) ? data : [data]);
    var q = quotes[0];
    if (!q) return null;
    var price = parseFloat(q.Last || q.Bid || q.Ask || 0);
    if (price > 0) {
      console.log('[PRICE] ' + ticker + ' $' + price + ' - TradeStation');
      return price;
    }
    return null;
  } catch(e) { console.error('[PRICE] Error:', e.message); return null; }
}

// -- GET PDH/PDL (Previous Day High/Low) --------------------------
// This is the LVL Framework core
// PDH = resistance for calls, PDL = support for puts
async function getLVLs(ticker) {
  try {
    var token = await getTSToken();
    if (!token) return null;
    var res = await fetch(
      getTSBase() + '/marketdata/barcharts/' + ticker +
      '?unit=Daily&interval=1&barsback=3&sessiontemplate=Default',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return null;

    // Sort ascending by timestamp
    bars.sort(function(a, b) {
      return new Date(a.TimeStamp) - new Date(b.TimeStamp);
    });

    // Previous completed day = second to last bar
    var prev = bars[bars.length - 2];
    var curr = bars[bars.length - 1];

    var pdh = parseFloat(prev.High);
    var pdl = parseFloat(prev.Low);
    var pdc = parseFloat(prev.Close);
    var todayOpen = parseFloat(curr.Open);

    console.log('[LVL] ' + ticker + ' PDH:$' + pdh + ' PDL:$' + pdl + ' PDC:$' + pdc);

    return {
      pdh,     // Previous Day High -- key resistance / call target
      pdl,     // Previous Day Low  -- key support / put target
      pdc,     // Previous Day Close
      todayOpen,
      // Structural zones
      callEntry: pdh,  // Calls: enter near/above PDH breakout
      putEntry: pdl,   // Puts: enter near/below PDL breakdown
      // Dynamic stops based on underlying price
      callStop: pdl,   // Calls: exit if stock breaks back below PDL
      putStop: pdh,    // Puts: exit if stock breaks back above PDH
    };
  } catch(e) {
    console.error('[LVL] Error for', ticker, ':', e.message);
    return null;
  }
}

// -- GET EXPIRATIONS ----------------------------------------------
async function getExpirations(ticker) {
  try {
    var token = await getTSToken();
    if (!token) return [];
    var res = await fetch(
      getTSBase() + '/marketdata/options/expirations/' + ticker,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = await res.json();
    var exps = data.Expirations || data.expirations || [];
    return exps.map(function(e) {
      return {
        date: (e.Date || e.date || '').slice(0, 10),
        dte:  parseInt(e.DaysToExpiration || 0),
        type: e.Type || 'Weekly',
      };
    }).filter(function(e) { return e.date && e.dte >= 0; });
  } catch(e) { console.error('[EXPIRY] Error:', e.message); return []; }
}

// -- SELECT EXPIRY ------------------------------------------------
function selectExpiry(expirations, mode) {
  var config = MODES[mode] || MODES.SWING;
  var valid = expirations.filter(function(e) {
    return e.dte >= config.minDTE && e.dte <= config.maxDTE;
  });
  if (valid.length > 0) {
    console.log('[EXPIRY] ' + mode + ' - ' + valid[0].date + ' (' + valid[0].dte + 'DTE)');
    return valid[0];
  }
  var future = expirations.filter(function(e) { return e.dte > 0; });
  return future.length > 0 ? future[0] : null;
}

// -- FORMAT DATE FOR TS API (MM-DD-YYYY) --------------------------
function formatExpiry(dateStr) {
  if (!dateStr) return null;
  var p = dateStr.split('-');
  if (p.length !== 3) return dateStr;
  return p[1] + '-' + p[2] + '-' + p[0];
}

// -- GET OPTION CHAIN ---------------------------------------------
async function getOptionChain(ticker, expiry, type, price) {
  try {
    var token = await getTSToken();
    if (!token) return [];
    var optType = type === 'call' ? 'Call' : 'Put';
    var url = getTSBase() + '/marketdata/options/chains/' + ticker
      + '?expiration=' + formatExpiry(expiry)
      + '&optionType=' + optType
      + '&strikeProximity=6'
      + '&enableGreeks=true';
    if (price) url += '&priceCenter=' + Math.round(price);
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    var chain = data.ChainData || data.chainData || [];
    console.log('[CHAIN] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + chain.length + ' contracts');
    return chain;
  } catch(e) { console.error('[CHAIN] Error:', e.message); return []; }
}

// -- PARSE CONTRACT -----------------------------------------------
function parseContract(c, expiry, type) {
  try {
    var legs   = c.Legs || c.legs || [];
    var leg    = legs[0] || {};
    var symbol = leg.Symbol || leg.symbol || '';
    var strike = parseFloat(leg.StrikePrice || leg.strikePrice || 0);
    var bid    = parseFloat(c.Bid  || c.bid  || 0);
    var ask    = parseFloat(c.Ask  || c.ask  || 0);
    var mid    = parseFloat(c.Mid  || c.mid  || ((bid + ask) / 2));
    var volume = parseInt(c.Volume || c.volume || 0);
    var oi     = parseInt(c.DailyOpenInterest || 0);
    var delta  = parseFloat(c.Delta  || c.delta  || 0);
    var theta  = parseFloat(c.Theta  || c.theta  || 0);
    var iv     = parseFloat(c.ImpliedVolatility || 0);
    var probITM = parseFloat(c.ProbabilityITM || 0);

    if (!symbol || strike <= 0 || mid <= 0) return null;

    // Spread filter -- percentage based
    if (ask > 0) {
      var spreadAbs = ask - bid;
      var spreadPct = spreadAbs / ask;
      var threshold = ask < 0.50 ? 0.40 : ask < 1.50 ? 0.30 : 0.25;
      if (spreadPct > threshold) return null;
    }

    return {
      symbol, strike, bid, ask, mid,
      volume, openInterest: oi,
      delta, theta, iv, probITM, expiry, type,
      high: parseFloat(c.High || 0),
      low:  parseFloat(c.Low  || 0),
      open: parseFloat(c.Open || 0),
    };
  } catch(e) { return null; }
}

// -- DETERMINE ENTRY MODE -----------------------------------------
// Returns 'BREAKOUT' or 'RETRACEMENT' based on signal strength
function getEntryMode(confluence, strategy) {
  var score = parseInt((confluence || '0').split('/')[0]) || 0;
  var isORB = (strategy || '').toUpperCase().includes('ORB')
           || (strategy || '').toUpperCase().includes('3-2-2')
           || (strategy || '').toUpperCase().includes('322');
  // Strong breakout signal = enter at ask immediately
  if (score >= 5 || isORB) return 'BREAKOUT';
  // Mid-confidence = wait for retracement to structural level
  return 'RETRACEMENT';
}

// -- SELECT BEST CONTRACT -----------------------------------------
function selectBestContract(contracts, price, config, lvls, type) {
  if (!contracts || !contracts.length) return null;

  // Filter by premium range
  var candidates = contracts.filter(function(c) {
    if (!c) return false;
    if (c.mid < config.minPremium || c.mid > config.maxPremium) return false;
    if (Math.abs(c.delta) < 0.15) return false; // too far OTM
    return true;
  });

  if (!candidates.length) {
    candidates = contracts.filter(function(c) {
      return c && c.mid >= config.minPremium && c.mid <= config.maxPremium;
    });
  }

  if (!candidates.length) return null;

  // Score each contract
  var scored = candidates.map(function(c) {
    var score = 0;
    var absDelta = Math.abs(c.delta);
    var distPct  = Math.abs(c.strike - price) / price;

    // Delta sweet spot
    if (absDelta >= 0.35 && absDelta <= 0.55) score += 3;
    else if (absDelta >= 0.25) score += 1;

    // ATM proximity
    if (distPct < 0.01) score += 3;
    else if (distPct < 0.03) score += 2;
    else if (distPct < 0.05) score += 1;

    // Liquidity
    if (c.volume > 1000) score += 2;
    else if (c.volume > 500) score += 1;
    if (c.openInterest > 5000) score += 2;
    else if (c.openInterest > 1000) score += 1;

    // Tight spread
    if (c.ask > 0) {
      var sp = (c.ask - c.bid) / c.ask;
      if (sp < 0.05) score += 2;
      else if (sp < 0.10) score += 1;
    }

    // LVL alignment bonus
    // Calls: prefer strike at or just above PDH (breakout level)
    // Puts:  prefer strike at or just below PDL (breakdown level)
    if (lvls) {
      if (type === 'call' && Math.abs(c.strike - lvls.pdh) / lvls.pdh < 0.02) score += 2;
      if (type === 'put'  && Math.abs(c.strike - lvls.pdl) / lvls.pdl < 0.02) score += 2;
    }

    return { contract: c, score };
  });

  scored.sort(function(a, b) { return b.score - a.score; });
  var best = scored[0].contract;
  console.log('[SELECT] ' + best.symbol + ' strike:$' + best.strike
    + ' mid:$' + best.mid + ' delta:' + best.delta.toFixed(2)
    + ' score:' + scored[0].score);
  return best;
}

// -- CALCULATE DTE ------------------------------------------------
function calcDTE(dateStr) {
  if (!dateStr) return 0;
  return Math.max(0, Math.ceil(
    (new Date(dateStr + 'T16:00:00-04:00') - new Date()) / (1000 * 60 * 60 * 24)
  ));
}

// -- TIME CONTEXT -------------------------------------------------
function getTimeContext() {
  var now    = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  var etMin  = now.getUTCMinutes();
  var etTime = etHour * 60 + etMin;
  if (etTime < 9*60+30)  return { window: 'PREMARKET',   ok: false };
  if (etTime < 9*60+45)  return { window: 'EARLY',       ok: false };
  if (etTime >= 15*60+30) return { window: 'LATE',       ok: false };
  if (etTime >= 16*60)   return { window: 'CLOSED',      ok: false };
  return { window: 'OPEN', ok: true };
}

// -- RESOLVE CONTRACT (MAIN) --------------------------------------
async function resolveContract(ticker, type, tradeType, signalMeta) {
  type      = (type      || 'call').toLowerCase();
  tradeType = (tradeType || 'SWING').toUpperCase();
  signalMeta = signalMeta || {};

  var mode   = tradeType.includes('DAY') ? 'DAY' : 'SWING';
  var config = MODES[mode];

  console.log('[RESOLVE] ' + ticker + ' ' + type + ' ' + mode);

  // 1. Get live price
  var price = await getPrice(ticker);
  if (!price) { console.error('[RESOLVE] No price for', ticker); return null; }

  // 2. Get PDH/PDL levels (LVL Framework)
  var lvls = await getLVLs(ticker);

  // 3. Determine entry mode from signal strength
  var entryMode = getEntryMode(signalMeta.confluence, signalMeta.strategy);
  console.log('[ENTRY MODE] ' + entryMode + ' | confluence:' + (signalMeta.confluence || 'N/A'));

  // 4. LVL filter -- check if price is at actionable level
  var lvlValid = true;
  var lvlReason = '';
  if (lvls) {
    if (type === 'call') {
      // For calls: price should be at or above PDH (breakout) OR near PDH (retracement)
      var distFromPDH = (price - lvls.pdh) / lvls.pdh;
      if (distFromPDH < -0.03) {
        // Price more than 3% below PDH -- no breakout yet
        if (entryMode === 'BREAKOUT') {
          lvlValid = false;
          lvlReason = 'Price $' + price + ' is ' + (Math.abs(distFromPDH)*100).toFixed(1) + '% below PDH $' + lvls.pdh + ' -- no breakout yet';
        }
      }
      console.log('[LVL] CALL | Price:$' + price + ' PDH:$' + lvls.pdh + ' dist:' + (distFromPDH*100).toFixed(1) + '%');
    } else {
      // For puts: price should be at or below PDL (breakdown)
      var distFromPDL = (lvls.pdl - price) / lvls.pdl;
      if (distFromPDL < -0.03) {
        if (entryMode === 'BREAKOUT') {
          lvlValid = false;
          lvlReason = 'Price $' + price + ' is above PDL $' + lvls.pdl + ' -- no breakdown yet';
        }
      }
      console.log('[LVL] PUT | Price:$' + price + ' PDL:$' + lvls.pdl + ' dist:' + (distFromPDL*100).toFixed(1) + '%');
    }
  }

  if (!lvlValid) {
    console.log('[LVL] BLOCKED --', lvlReason);
    return { blocked: true, reason: lvlReason, lvls };
  }

  // 5. Get expirations and select
  var expirations = await getExpirations(ticker);
  if (!expirations.length) return null;
  var expiryObj = selectExpiry(expirations, mode);
  if (!expiryObj) {
    expiryObj = selectExpiry(expirations, 'SWING');
    if (!expiryObj) return null;
    mode = 'SWING'; config = MODES.SWING;
  }

  var expiry = expiryObj.date;
  var dte    = expiryObj.dte;

  // 6. Get option chain
  var rawChain = await getOptionChain(ticker, expiry, type, price);
  if (!rawChain.length) return null;

  // 7. Parse contracts
  var contracts = rawChain.map(function(c) {
    return parseContract(c, expiry, type);
  }).filter(Boolean);
  if (!contracts.length) return null;

  // 8. Select best contract (LVL-aware)
  var best = selectBestContract(contracts, price, config, lvls, type);
  if (!best) return null;

  // 9. Calculate entry prices
  var t1Pct     = getT1Target(ticker);  // smart T1 per ticker volatility
  var stopPct   = config.stopPct;

  // ENTRY PRICE based on mode
  var entryPrice;
  if (entryMode === 'BREAKOUT') {
    // Strong signal -- enter at ask (market-ish)
    entryPrice = best.ask;
  } else {
    // Retracement -- wait for 12.5% pullback from ask
    entryPrice = parseFloat((best.ask * 0.875).toFixed(2));
  }

  // STOPS -- dynamic based on underlying price levels
  // optionStop = premium loss based on structural invalidation distance
  var underlyingStop = null;
  var optionStopPct  = stopPct; // fallback to % if no LVL

  if (lvls) {
    underlyingStop = type === 'call' ? lvls.callStop : lvls.putStop;
    // Estimate option stop: if underlying breaks structure,
    // option loses ~delta × (underlying distance) per $1
    var structuralDist = Math.abs(price - underlyingStop);
    var estimatedLoss  = structuralDist * Math.abs(best.delta);
    var dynamicStopPct = estimatedLoss / best.mid;
    // Use dynamic stop but cap at 50% max, floor at 20%
    optionStopPct = Math.min(0.50, Math.max(0.20, dynamicStopPct));
    console.log('[DYNAMIC STOP] dist:$' + structuralDist.toFixed(2)
      + ' delta:' + best.delta.toFixed(2)
      + ' estLoss:$' + estimatedLoss.toFixed(2)
      + ' stopPct:' + (optionStopPct*100).toFixed(0) + '%');
  }

  var optionStop = parseFloat((best.mid * (1 - optionStopPct)).toFixed(2));
  var t1Price    = parseFloat((best.mid * (1 + t1Pct)).toFixed(2));

  // 10. Position sizing
  var qty = best.mid <= 1.20 ? 2 : 1;

  var timeCtx = getTimeContext();

  console.log('[OPRA] ' + ticker + ' ' + best.symbol
    + ' $' + best.strike + ' mid:$' + best.mid + ' ' + dte + 'DTE'
    + ' entry:' + entryMode + ' T1:+' + (t1Pct*100).toFixed(0) + '%');

  return {
    symbol:        best.symbol,
    mid:           best.mid,
    bid:           best.bid,
    ask:           best.ask,
    strike:        best.strike,
    expiry,
    mode,
    dte,
    price,
    // Greeks
    delta:         best.delta,
    theta:         best.theta,
    iv:            best.iv,
    probITM:       Math.round(best.probITM * 100),
    volume:        best.volume,
    openInterest:  best.openInterest,
    // LVL Framework
    lvls,
    underlyingStop,
    // Entry
    entryMode,
    entryPrice,
    // Exit
    optionStop,
    optionStopPct: Math.round(optionStopPct * 100),
    t1Price,
    t1Pct:         Math.round(t1Pct * 100),
    // Sizing
    qty,
    // Meta
    timeCtx,
    wideSpread: (best.ask - best.bid) / best.ask > 0.15,
  };
}

// -- RESOLVE WITH SPECIFIC EXPIRY ---------------------------------
async function resolveContractWithExpiry(ticker, type, expiry) {
  try {
    var price = await getPrice(ticker);
    if (!price) return null;
    var rawChain = await getOptionChain(ticker, expiry, type, price);
    if (!rawChain.length) return null;
    var contracts = rawChain.map(function(c) {
      return parseContract(c, expiry, type);
    }).filter(Boolean);
    if (!contracts.length) return null;
    var best = selectBestContract(contracts, price, MODES.SWING, null, type);
    if (!best) return null;
    return {
      symbol: best.symbol, mid: best.mid, bid: best.bid, ask: best.ask,
      strike: best.strike, expiry, mode: 'SWING', dte: calcDTE(expiry),
      price, delta: best.delta, probITM: Math.round(best.probITM * 100),
    };
  } catch(e) { console.error('[RESOLVE EXPIRY] Error:', e.message); return null; }
}

// -- PARSE OPRA ---------------------------------------------------
function parseOPRA(opraSymbol) {
  try {
    var raw = (opraSymbol || '').trim().replace(/^O:/, '');
    // TS format: "NVDA 260410C177.5"
    var tsMatch = raw.match(/^([A-Z]+)\s+(\d{6})([CP])(\d+(?:\.\d+)?)$/);
    if (tsMatch) {
      var ds = tsMatch[2];
      return {
        ticker: tsMatch[1],
        expiry: '20' + ds.slice(0,2) + '-' + ds.slice(2,4) + '-' + ds.slice(4,6),
        type:   tsMatch[3] === 'C' ? 'call' : 'put',
        strike: parseFloat(tsMatch[4]),
        symbol: raw,
      };
    }
    // OPRA format: "NVDA260410C00177500"
    var opraMatch = raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (opraMatch) {
      var ds2    = opraMatch[2];
      var whole  = parseInt(opraMatch[4].slice(0, 5), 10);
      var dec    = parseInt(opraMatch[4].slice(5), 10);
      var strike = dec === 0 ? whole : parseFloat(whole + '.' + String(dec).replace(/0+$/, ''));
      return {
        ticker: opraMatch[1],
        expiry: '20' + ds2.slice(0,2) + '-' + ds2.slice(2,4) + '-' + ds2.slice(4,6),
        type:   opraMatch[3] === 'C' ? 'call' : 'put',
        strike,
        symbol: opraMatch[1] + ' ' + ds2 + opraMatch[3] + strike,
      };
    }
    return null;
  } catch(e) { return null; }
}

// -- POSITION SIZING ----------------------------------------------
function calculatePositionSize(premium, mode, accountSize) {
  if (!mode)        mode        = 'SWING';
  if (!accountSize) accountSize = 6400;
  var config = MODES[mode] || MODES.SWING;
  if (!premium || premium <= 0) return { viable: false, reason: 'No premium' };
  if (premium > MAX_PREMIUM)    return { viable: false, reason: 'Over $2.40 max' };
  if (premium < config.minPremium) return { viable: false, reason: 'Under min' };

  var contracts = premium <= 1.20 ? 2 : 1;
  var t1Pct     = config.t1Pct;
  var stopPct   = config.stopPct;
  var stopPrice = parseFloat((premium * (1 - stopPct)).toFixed(2));
  var t1Price   = parseFloat((premium * (1 + t1Pct)).toFixed(2));
  var stopLoss  = parseFloat((premium * stopPct * 100 * contracts).toFixed(0));
  var t1Profit  = parseFloat(((t1Price - premium) * 100 * contracts).toFixed(0));
  var totalCost = parseFloat((premium * 100 * contracts).toFixed(0));
  var riskPct   = parseFloat((stopLoss / accountSize * 100).toFixed(1));

  return {
    viable: true, mode, contracts, premium, totalCost,
    stopPrice, t1Price, stopLoss, t1Profit, riskPct,
  };
}

// -- GET OPTION SNAPSHOT ------------------------------------------
async function getOptionSnapshot(tsSymbol) {
  try {
    var token = await getTSToken();
    if (!token) return null;
    var encoded = encodeURIComponent(tsSymbol);
    var res = await fetch(getTSBase() + '/marketdata/quotes/' + encoded, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data  = await res.json();
    var quotes = data.Quotes || data.quotes || (Array.isArray(data) ? data : [data]);
    var q = quotes[0];
    if (!q) return null;
    return {
      symbol: tsSymbol,
      bid: parseFloat(q.Bid || 0),
      ask: parseFloat(q.Ask || 0),
      mid: parseFloat(q.Last || ((parseFloat(q.Bid||0) + parseFloat(q.Ask||0)) / 2)),
      volume: parseInt(q.Volume || 0),
      openInterest: parseInt(q.DailyOpenInterest || 0),
    };
  } catch(e) { return null; }
}

module.exports = {
  parseOPRA,
  resolveContract,
  resolveContractWithExpiry,
  getOptionSnapshot,
  getPrice,
  getLVLs,
  getEntryMode,
  calculatePositionSize,
  getTimeContext,
  getT1Target,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM, MODES,
};
