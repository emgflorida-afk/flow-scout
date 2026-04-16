// gex.js -- Stratum v7.5
// -----------------------------------------------------------------
// Gamma Exposure (GEX) calculator.  Uses CBOE free delayed quotes
// API (no key needed) to pull full options chains with greeks, then
// calculates dealer gamma exposure per strike to find:
//   - PIN   = highest positive GEX strike (price magnet)
//   - WALLS = top N gamma walls (resistance/support magnets)
//   - FLIP  = zero-gamma crossing (regime change level)
//   - VOL   = highest negative GEX (vol expansion zone)
//
// Primo's Stratalyst shows these as green bars on the chart.
// This gives us the same edge.
// -----------------------------------------------------------------

var fetch = require('node-fetch');

var CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

// Cache: ticker -> { data, ts }
var _cache = {};
var CACHE_TTL = 15 * 60 * 1000; // 15 min (CBOE data is 15-min delayed anyway)

// -----------------------------------------------------------------
// CBOE free API — returns full options chain with greeks
// No API key required.  15-min delayed.
// -----------------------------------------------------------------
async function fetchCBOEChain(ticker) {
  // CBOE uses special prefixes for indices
  var cboeSymbol = ticker;
  if (ticker === 'SPX' || ticker === 'SPY') cboeSymbol = ticker;
  if (ticker === 'NDX') cboeSymbol = ticker;

  var url = CBOE_BASE + '/' + cboeSymbol + '.json';
  console.log('[GEX] Fetching CBOE chain: ' + url);

  try {
    var res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 15000,
    });
    if (!res.ok) {
      console.error('[GEX] CBOE returned ' + res.status + ' for ' + ticker);
      return null;
    }
    var json = await res.json();
    return json;
  } catch (e) {
    console.error('[GEX] CBOE fetch error for ' + ticker + ': ' + e.message);
    return null;
  }
}

// -----------------------------------------------------------------
// Parse CBOE response into normalized options array
// -----------------------------------------------------------------
function parseCBOEOptions(json) {
  if (!json || !json.data) return { spot: null, options: [] };

  var spot = json.data.current_price || null;
  var optionsRaw = json.data.options || [];
  var options = [];

  for (var i = 0; i < optionsRaw.length; i++) {
    var opt = optionsRaw[i];
    var sym = opt.option || '';
    if (!sym) continue;

    // Parse CBOE OCC symbol: "SPY260415C00700000"
    // Format: TICKER + YYMMDD + C/P + 00STRIKE000 (strike * 1000, zero-padded to 8 digits)
    var cpIdx = -1;
    var type = null;
    for (var c = sym.length - 9; c >= 1; c--) {
      if (sym[c] === 'C' || sym[c] === 'P') {
        cpIdx = c;
        type = sym[c] === 'C' ? 'call' : 'put';
        break;
      }
    }
    if (!type || cpIdx < 0) continue;

    var strikeStr = sym.substring(cpIdx + 1);
    var strike = parseInt(strikeStr, 10) / 1000;
    if (!strike || strike <= 0) continue;

    var gamma = parseFloat(opt.gamma) || 0;
    var oi = parseInt(opt.open_interest) || 0;
    var delta = parseFloat(opt.delta) || 0;
    var iv = parseFloat(opt.iv) || 0;
    var volume = parseInt(opt.volume) || 0;

    options.push({
      strike: strike,
      type: type,
      gamma: gamma,
      oi: oi,
      delta: delta,
      iv: iv,
      volume: volume,
    });
  }

  return { spot: spot, options: options };
}

// -----------------------------------------------------------------
// Core GEX calculation
// Formula: GEX = spot^2 * gamma * OI * 100 * 0.01
// Calls = positive (dealer long gamma = dampening)
// Puts  = negative (dealer short gamma = amplifying)
// -----------------------------------------------------------------
function calculateGEX(options, spotPrice) {
  var strikeMap = {};

  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    if (!opt.gamma || !opt.oi) continue;

    // Only include near-money strikes (within 15% of spot)
    var dist = Math.abs(opt.strike - spotPrice) / spotPrice;
    if (dist > 0.15) continue;

    var gex = opt.gamma * opt.oi * 100 * spotPrice * spotPrice * 0.01;
    var signedGex = opt.type === 'call' ? gex : -gex;

    var key = opt.strike.toString();
    if (!strikeMap[key]) {
      strikeMap[key] = { strike: opt.strike, gex: 0, callGex: 0, putGex: 0, callOI: 0, putOI: 0 };
    }
    strikeMap[key].gex += signedGex;
    if (opt.type === 'call') {
      strikeMap[key].callGex += gex;
      strikeMap[key].callOI += opt.oi;
    } else {
      strikeMap[key].putGex += gex;
      strikeMap[key].putOI += opt.oi;
    }
  }

  // Convert to sorted array
  var strikes = [];
  var keys = Object.keys(strikeMap);
  for (var j = 0; j < keys.length; j++) {
    strikes.push(strikeMap[keys[j]]);
  }
  strikes.sort(function (a, b) { return a.strike - b.strike; });

  // Total net GEX
  var totalNetGex = 0;
  for (var k = 0; k < strikes.length; k++) {
    totalNetGex += strikes[k].gex;
  }

  // Find gamma flip (where cumulative GEX crosses zero)
  var cumulativeGex = 0;
  var gammaFlip = null;
  for (var m = 0; m < strikes.length; m++) {
    var prevCum = cumulativeGex;
    cumulativeGex += strikes[m].gex;
    if ((prevCum < 0 && cumulativeGex >= 0) || (prevCum > 0 && cumulativeGex <= 0)) {
      gammaFlip = strikes[m].strike;
      break;
    }
  }

  // Find PIN (highest positive GEX = price magnet)
  var pin = null;
  var pinGex = 0;
  for (var n = 0; n < strikes.length; n++) {
    if (strikes[n].gex > pinGex) {
      pinGex = strikes[n].gex;
      pin = strikes[n].strike;
    }
  }

  // Find VOL zone (most negative GEX = expansion zone)
  var volZone = null;
  var volGex = 0;
  for (var p = 0; p < strikes.length; p++) {
    if (strikes[p].gex < volGex) {
      volGex = strikes[p].gex;
      volZone = strikes[p].strike;
    }
  }

  // Top gamma walls (top 5 by absolute GEX)
  var sortedByAbs = strikes.slice().sort(function (a, b) {
    return Math.abs(b.gex) - Math.abs(a.gex);
  });
  var walls = [];
  for (var q = 0; q < Math.min(5, sortedByAbs.length); q++) {
    walls.push({
      strike: sortedByAbs[q].strike,
      gex: sortedByAbs[q].gex,
      type: sortedByAbs[q].gex > 0 ? 'CALL_WALL' : 'PUT_WALL',
      callOI: sortedByAbs[q].callOI,
      putOI: sortedByAbs[q].putOI,
    });
  }
  walls.sort(function (a, b) { return a.strike - b.strike; });

  return {
    spot: spotPrice,
    totalNetGex: totalNetGex,
    regime: totalNetGex > 0 ? 'POSITIVE' : 'NEGATIVE',
    gammaFlip: gammaFlip,
    pin: pin,
    pinGex: pinGex,
    volZone: volZone,
    volZoneGex: volGex,
    walls: walls,
    strikes: strikes,
  };
}

// -----------------------------------------------------------------
// Find ATM implied volatility from options chain
// Averages the IV of the nearest call and put to spot price.
// Used for Expected Move calculation.
// -----------------------------------------------------------------
function findATMImpliedVol(options, spot) {
  if (!options || !options.length || !spot) return null;
  var bestCall = null, bestPut = null;
  var bestCallDist = 999999, bestPutDist = 999999;
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    if (!o.iv || o.iv <= 0) continue;
    var dist = Math.abs(o.strike - spot);
    if (o.type === 'call' && dist < bestCallDist) { bestCall = o; bestCallDist = dist; }
    if (o.type === 'put' && dist < bestPutDist) { bestPut = o; bestPutDist = dist; }
  }
  if (bestCall && bestPut) return (bestCall.iv + bestPut.iv) / 2;
  if (bestCall) return bestCall.iv;
  if (bestPut) return bestPut.iv;
  return null;
}

// -----------------------------------------------------------------
// getGammaLevels(ticker)
// Returns the key gamma levels as price magnets.
// This is what Primo shows on his Stratalyst charts.
// -----------------------------------------------------------------
async function getGammaLevels(ticker) {
  // Check cache
  var cached = _cache[ticker];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  var raw = await fetchCBOEChain(ticker);
  if (!raw) return null;

  var parsed = parseCBOEOptions(raw);
  if (!parsed.spot || parsed.options.length === 0) {
    console.error('[GEX] No valid data for ' + ticker);
    return null;
  }

  var gex = calculateGEX(parsed.options, parsed.spot);

  // Calculate expected move from ATM IV
  // EM = spot * IV * sqrt(DTE/365)
  // For daily: EM = spot * IV * sqrt(1/365) ≈ spot * IV * 0.05234
  var expectedMove = null;
  var expectedHigh = null;
  var expectedLow = null;
  var atmIV = findATMImpliedVol(parsed.options, parsed.spot);
  if (atmIV && atmIV > 0) {
    expectedMove = parsed.spot * atmIV * Math.sqrt(1 / 365);
    expectedHigh = Math.round((parsed.spot + expectedMove) * 100) / 100;
    expectedLow = Math.round((parsed.spot - expectedMove) * 100) / 100;
    expectedMove = Math.round(expectedMove * 100) / 100;
  }

  var result = {
    ticker: ticker,
    spot: gex.spot,
    regime: gex.regime,
    gammaFlip: gex.gammaFlip,
    pin: gex.pin,
    walls: gex.walls,
    volZone: gex.volZone,
    totalNetGex: gex.totalNetGex,
    expectedMove: expectedMove,
    expectedHigh: expectedHigh,
    expectedLow: expectedLow,
    timestamp: new Date().toISOString(),
    source: 'CBOE_DELAYED',
  };

  // Cache it
  _cache[ticker] = { data: result, ts: Date.now() };
  console.log('[GEX] ' + ticker + ' @ $' + gex.spot + ' | PIN: $' + gex.pin +
    ' | Flip: $' + gex.gammaFlip + ' | Regime: ' + gex.regime +
    (expectedMove ? ' | EM: ±$' + expectedMove + ' [$' + expectedLow + '-$' + expectedHigh + ']' : '') +
    ' | Walls: ' + gex.walls.map(function (w) { return '$' + w.strike; }).join(', '));

  return result;
}

// -----------------------------------------------------------------
// getGEXScore(ticker, contract)
// Scoring function for confluence (existing API preserved)
// -----------------------------------------------------------------
async function getGEXScore(ticker, contract) {
  var levels = await getGammaLevels(ticker);
  if (!levels) return { score: 0, stars: 0, reasons: ['No GEX data'], gexData: null };

  var strike = contract && contract.strike;
  var type = contract && contract.type;
  var score = 0;
  var reasons = [];

  // 1. Regime alignment
  if (levels.regime === 'POSITIVE' && type === 'CALL') {
    score += 1; reasons.push('Positive gamma regime (dampening, mean-reverting)');
  } else if (levels.regime === 'NEGATIVE' && type === 'PUT') {
    score += 1; reasons.push('Negative gamma regime (amplifying, trending)');
  } else if (levels.regime === 'NEGATIVE' && type === 'CALL') {
    score += 0.5; reasons.push('Negative gamma = volatile, bigger moves possible');
  }

  // 2. Gamma flip alignment
  if (levels.gammaFlip) {
    var aboveFlip = levels.spot > levels.gammaFlip;
    if ((type === 'CALL' && aboveFlip) || (type === 'PUT' && !aboveFlip)) {
      score += 2; reasons.push('Price aligns with gamma flip at $' + levels.gammaFlip);
    } else {
      score -= 1; reasons.push('AGAINST gamma flip at $' + levels.gammaFlip);
    }
  }

  // 3. Proximity to pin (magnet)
  if (levels.pin && strike) {
    var distToPin = Math.abs(strike - levels.pin) / levels.spot;
    if (distToPin < 0.02) { score += 1; reasons.push('Near pin magnet $' + levels.pin); }
    else if (distToPin < 0.05) { score += 0.5; reasons.push('Within 5% of pin $' + levels.pin); }
  }

  // 4. Walls as targets
  for (var i = 0; i < levels.walls.length; i++) {
    var w = levels.walls[i];
    if (type === 'CALL' && w.strike > levels.spot && w.type === 'CALL_WALL') {
      reasons.push('Call wall target at $' + w.strike);
      break;
    }
    if (type === 'PUT' && w.strike < levels.spot && w.type === 'PUT_WALL') {
      reasons.push('Put wall target at $' + w.strike);
      break;
    }
  }

  var finalScore = Math.min(6, Math.max(0, score));
  var stars = finalScore >= 5.5 ? 5 : finalScore >= 4.5 ? 4 : finalScore >= 3.0 ? 3 : finalScore >= 1.5 ? 2 : finalScore >= 0.5 ? 1 : 0;

  return { score: finalScore, stars: stars, reasons: reasons, gexData: levels };
}

// -----------------------------------------------------------------
// formatGEXForDiscord(levels)
// Pretty-print for Discord alerts / morning brief
// -----------------------------------------------------------------
function formatGEXForDiscord(levels) {
  if (!levels) return 'No GEX data';

  var lines = [];
  lines.push('**' + levels.ticker + '** GEX Levels @ $' + levels.spot);
  lines.push('Regime: ' + (levels.regime === 'POSITIVE' ? 'POSITIVE (dampening)' : 'NEGATIVE (volatile)'));
  if (levels.pin) lines.push('PIN (magnet): **$' + levels.pin + '**');
  if (levels.gammaFlip) lines.push('Gamma Flip: **$' + levels.gammaFlip + '**');
  if (levels.volZone) lines.push('Vol Zone: $' + levels.volZone);

  if (levels.walls && levels.walls.length) {
    lines.push('Gamma Walls:');
    for (var i = 0; i < levels.walls.length; i++) {
      var w = levels.walls[i];
      var label = w.type === 'CALL_WALL' ? 'CALL' : 'PUT';
      var gexM = (Math.abs(w.gex) / 1000000).toFixed(1);
      lines.push('  ' + label + ' $' + w.strike + ' (' + gexM + 'M GEX)');
    }
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------
// batchGammaLevels(tickers)
// Get gamma levels for multiple tickers (with rate limiting)
// -----------------------------------------------------------------
async function batchGammaLevels(tickers) {
  var results = {};
  for (var i = 0; i < tickers.length; i++) {
    try {
      results[tickers[i]] = await getGammaLevels(tickers[i]);
    } catch (e) {
      console.error('[GEX] Error on ' + tickers[i] + ': ' + e.message);
      results[tickers[i]] = null;
    }
    // Small delay to be nice to CBOE
    if (i < tickers.length - 1) {
      await new Promise(function (r) { setTimeout(r, 500); });
    }
  }
  return results;
}

module.exports = {
  getGammaLevels: getGammaLevels,
  getGEXScore: getGEXScore,
  batchGammaLevels: batchGammaLevels,
  formatGEXForDiscord: formatGEXForDiscord,
};
