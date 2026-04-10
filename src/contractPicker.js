// contractPicker.js - Stratum Flow Scout v8.3
// SMART CONTRACT SELECTION
// Given a direction (CALLS/PUTS) and underlying price,
// picks the optimal option contract using TradeStation MCP data
//
// Called by Claude agent with pre-fetched option chain data
// Returns: strike, expiration, expected premium, delta, quality score
// -----------------------------------------------------------------

// ===================================================================
// PICK OPTIMAL CONTRACT
// Takes option chain data and returns the best contract
// ===================================================================
function pickContract(params) {
  // params:
  // {
  //   direction: 'CALLS' or 'PUTS',
  //   underlyingPrice: 680.00,
  //   expirations: [...],     // from get-option-expirations
  //   chain: [...],           // from get-option-chain-snapshot
  //   conviction: 'HIGH',     // from confluence scorer
  //   contracts: 5,           // how many we want to buy
  //   maxPremium: 5.00,       // max we'll pay per contract
  //   minDelta: 0.35,         // minimum delta
  //   maxDelta: 0.55,         // maximum delta
  // }

  var direction = params.direction || 'CALLS';
  var price = params.underlyingPrice || 0;
  var chain = params.chain || [];
  var conviction = params.conviction || 'MEDIUM';
  var numContracts = params.contracts || 3;
  var maxPremium = params.maxPremium || 5.00;
  var minDelta = params.minDelta || 0.35;
  var maxDelta = params.maxDelta || 0.55;

  if (chain.length === 0) {
    return { error: 'No chain data provided' };
  }

  // Filter candidates
  var candidates = chain.filter(function(opt) {
    var delta = Math.abs(parseFloat(opt.Delta || opt.delta || 0));
    var ask = parseFloat(opt.Ask || opt.ask || 999);
    var bid = parseFloat(opt.Bid || opt.bid || 0);
    var volume = parseInt(opt.Volume || opt.volume || 0);
    var oi = parseInt(opt.OpenInterest || opt.openInterest || 0);

    // Delta in range
    if (delta < minDelta || delta > maxDelta) return false;
    // Premium affordable
    if (ask > maxPremium) return false;
    // Has liquidity
    if (volume < 50 && oi < 100) return false;
    // Spread not too wide (< 15% of mid)
    var mid = (ask + bid) / 2;
    var spread = ask - bid;
    if (mid > 0 && spread / mid > 0.15) return false;

    return true;
  });

  if (candidates.length === 0) {
    return { error: 'No contracts meet criteria', filters: { minDelta, maxDelta, maxPremium } };
  }

  // Score each candidate
  var scored = candidates.map(function(opt) {
    var delta = Math.abs(parseFloat(opt.Delta || opt.delta || 0));
    var ask = parseFloat(opt.Ask || opt.ask || 0);
    var bid = parseFloat(opt.Bid || opt.bid || 0);
    var mid = (ask + bid) / 2;
    var spread = ask - bid;
    var volume = parseInt(opt.Volume || opt.volume || 0);
    var oi = parseInt(opt.OpenInterest || opt.openInterest || 0);
    var iv = parseFloat(opt.ImpliedVolatility || opt.iv || 0);
    var strike = parseFloat(opt.StrikePrice || opt.strike || 0);

    var score = 0;

    // Delta sweet spot (0.45 ideal for ATM)
    var deltaDist = Math.abs(delta - 0.45);
    score += (1 - deltaDist * 5) * 25; // max 25 pts

    // Tight spread (tighter = better fills)
    var spreadPct = mid > 0 ? spread / mid : 1;
    score += (1 - spreadPct) * 25; // max 25 pts

    // Volume (more = better liquidity)
    score += Math.min(volume / 1000, 1) * 15; // max 15 pts

    // Open interest (more = more liquid)
    score += Math.min(oi / 5000, 1) * 10; // max 10 pts

    // Premium in sweet spot ($1.00-$2.50 for affordability + room to move)
    if (mid >= 0.80 && mid <= 3.00) score += 15;
    else if (mid >= 0.50 && mid <= 5.00) score += 10;
    else score += 5;

    // IV not spiked (lower IV = cheaper premium, less crush risk)
    if (iv > 0 && iv < 0.40) score += 10;
    else if (iv < 0.60) score += 5;

    return {
      symbol: opt.Symbol || opt.symbol || (opt.Underlying + ' ' + opt.Expiration + (direction === 'CALLS' ? 'C' : 'P') + strike),
      strike: strike,
      delta: delta,
      bid: bid,
      ask: ask,
      mid: mid,
      spread: spread.toFixed(2),
      spreadPct: (spreadPct * 100).toFixed(1) + '%',
      volume: volume,
      openInterest: oi,
      iv: iv,
      score: Math.round(score),
      totalCost: (ask * numContracts * 100).toFixed(0),
    };
  });

  // Sort by score descending
  scored.sort(function(a, b) { return b.score - a.score; });

  var best = scored[0];
  var totalCost = parseFloat(best.ask) * numContracts * 100;

  return {
    recommended: best,
    alternatives: scored.slice(1, 3), // show top 2 alternatives
    summary: {
      symbol: best.symbol,
      strike: best.strike,
      direction: direction,
      delta: best.delta,
      entryPrice: best.ask,  // buy at ask for immediate fill
      limitPrice: best.mid.toFixed(2), // or limit at mid for better fill
      contracts: numContracts,
      totalCost: '$' + totalCost.toFixed(0),
      maxRisk: '$' + (totalCost * 0.40).toFixed(0) + ' (40% floor)',
      score: best.score + '/100',
      conviction: conviction,
    },
  };
}

// ===================================================================
// PICK EXPIRATION
// Given expirations list, picks the optimal one (5-8 DTE, weekly)
// ===================================================================
function pickExpiration(expirations, minDTE, maxDTE) {
  minDTE = minDTE || 5;
  maxDTE = maxDTE || 10;

  if (!expirations || expirations.length === 0) {
    return { error: 'No expirations provided' };
  }

  var now = new Date();
  var candidates = [];

  expirations.forEach(function(exp) {
    var expDate = new Date(exp.ExpirationDate || exp.date || exp);
    var dte = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));

    if (dte >= minDTE && dte <= maxDTE) {
      candidates.push({
        date: exp.ExpirationDate || exp.date || exp,
        dte: dte,
        type: exp.ExpirationType || 'Weekly',
      });
    }
  });

  if (candidates.length === 0) {
    // Fallback: pick nearest expiry >= minDTE
    var fallback = expirations
      .map(function(exp) {
        var expDate = new Date(exp.ExpirationDate || exp.date || exp);
        var dte = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
        return { date: exp.ExpirationDate || exp.date || exp, dte: dte };
      })
      .filter(function(e) { return e.dte >= minDTE; })
      .sort(function(a, b) { return a.dte - b.dte; });

    if (fallback.length > 0) return fallback[0];
    return { error: 'No expirations found with ' + minDTE + '+ DTE' };
  }

  // Prefer 7-8 DTE (sweet spot)
  candidates.sort(function(a, b) {
    var aIdeal = Math.abs(a.dte - 7);
    var bIdeal = Math.abs(b.dte - 7);
    return aIdeal - bIdeal;
  });

  return candidates[0];
}

module.exports = { pickContract, pickExpiration };
