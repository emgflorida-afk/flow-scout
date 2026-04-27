// optionsChain.js — fetch full call+put options chain via TS streaming API,
// merge by strike, surface decision-support fields. Used by the scanner's
// "📊 OPTIONS" tab to help AB pick the right strike + expiry per setup.
//
// Apr 26 2026 — built to match KiLevels' Battle Station options chain panel:
// strike-by-strike call vs put volume, Greeks, "best strike" picker.

var fetch = require('node-fetch');
var ts    = require('./tradestation');

function getTSBase() { return 'https://api.tradestation.com/v3'; }

function formatExpiry(dateStr) {
  // TS expects MM-DD-YYYY
  var p = dateStr.split('-');
  if (p.length !== 3) return dateStr;
  if (p[0].length === 4) return p[1] + '-' + p[2] + '-' + p[0];
  return dateStr;
}

// One-side stream fetch (call OR put). Returns array of contract objects.
async function streamOneSide(ticker, expiry, optionType, priceCenter, token, timeoutMs) {
  var url = getTSBase() + '/marketdata/stream/options/chains/' + encodeURIComponent(ticker)
          + '?expiration=' + formatExpiry(expiry)
          + '&optionType=' + (optionType === 'put' ? 'Put' : 'Call')
          + '&strikeProximity=10&enableGreeks=true';
  if (priceCenter) url += '&priceCenter=' + Math.round(priceCenter);

  var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) throw new Error('TS chain HTTP ' + res.status);

  var contracts = [];
  var buffer = '';
  await new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; res.body.destroy(); resolve(); }
    }, timeoutMs || 6000);

    res.body.on('data', function(chunk) {
      buffer += chunk.toString();
      var parts = buffer.split('\n');
      buffer = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (!line || line[0] === ':') continue;
        if (line.indexOf('data:') === 0) line = line.slice(5).trim();
        if (!line) continue;
        try {
          var obj = JSON.parse(line);
          if (obj && (obj.Strike || obj.Legs || obj.Delta !== undefined)) {
            contracts.push(obj);
          }
        } catch(_) { /* skip non-JSON */ }
      }
    });
    res.body.on('end',   function(){ clearTimeout(timer); if (!done) { done = true; resolve(); } });
    res.body.on('error', function(){ clearTimeout(timer); if (!done) { done = true; resolve(); } });
  });
  return contracts;
}

// Normalize a single TS contract into clean fields.
function normalize(c) {
  // TS chain entries can have shape { Legs: [{ Strike, ...greeks }], Bid, Ask, Last, Volume, OpenInterest }
  // OR { Strike, Bid, Ask, Last, Volume, OpenInterest, Delta, Gamma, Theta, Vega, ImpliedVolatility }
  var leg = (c.Legs && c.Legs[0]) || c;
  var strike = parseFloat(leg.Strike || leg.StrikePrice || c.Strike || 0);
  var symbol = leg.Symbol || c.Symbol || null;
  return {
    strike: strike,
    symbol: symbol,
    last:   parseFloat(c.Last   || leg.Last   || 0) || 0,
    bid:    parseFloat(c.Bid    || leg.Bid    || 0) || 0,
    ask:    parseFloat(c.Ask    || leg.Ask    || 0) || 0,
    mid:    null,  // computed below
    spreadPct: null,  // computed below
    volume: parseInt(c.Volume       || leg.Volume       || 0) || 0,
    oi:     parseInt(c.OpenInterest || leg.OpenInterest || 0) || 0,
    delta:  parseFloat(c.Delta             || leg.Delta             || 0) || 0,
    gamma:  parseFloat(c.Gamma             || leg.Gamma             || 0) || 0,
    theta:  parseFloat(c.Theta             || leg.Theta             || 0) || 0,
    vega:   parseFloat(c.Vega              || leg.Vega              || 0) || 0,
    iv:     parseFloat(c.ImpliedVolatility || leg.ImpliedVolatility || 0) || 0,
  };
}

// Score a strike for "best to fire" — used by the decision picker.
// Higher score = better strike. Components:
//   • delta proximity to target (default 0.50)
//   • spread tightness (lower spread% = better)
//   • volume + OI (more = more liquid = better fills)
function scoreStrike(c, opts) {
  var targetDelta = opts && opts.targetDelta ? opts.targetDelta : 0.50;
  if (!c.bid || !c.ask) return 0;
  if (c.delta === 0) return 0;
  var deltaErr = Math.abs(Math.abs(c.delta) - targetDelta);  // 0 = perfect
  var deltaScore = Math.max(0, 1 - deltaErr * 4);            // 0..1
  var spreadScore = Math.max(0, 1 - (c.spreadPct || 1) / 0.10); // 0..1, penalize >10% spreads
  var liquidityScore = Math.min(1, (c.volume + c.oi / 4) / 1000); // 0..1, saturates ~1000 vol-equiv
  return Math.round(100 * (deltaScore * 0.5 + spreadScore * 0.3 + liquidityScore * 0.2));
}

// Fetch full chain (calls + puts) for a ticker/expiry, merged by strike.
// Returns clean structure for the scanner UI to render.
async function fetchChain(ticker, expiry, priceCenter) {
  var token = await ts.getAccessToken();
  if (!token) throw new Error('no TS access token');

  // Parallel fetch both sides
  var pair = await Promise.all([
    streamOneSide(ticker, expiry, 'call', priceCenter, token, 6000).catch(function(e){ console.error('[CHAIN] call err:', e.message); return []; }),
    streamOneSide(ticker, expiry, 'put',  priceCenter, token, 6000).catch(function(e){ console.error('[CHAIN] put err:',  e.message); return []; }),
  ]);
  var rawCalls = pair[0].map(normalize);
  var rawPuts  = pair[1].map(normalize);

  // Compute mid and spread% for each
  function enrich(c) {
    if (c.bid > 0 && c.ask > 0) {
      c.mid = +((c.bid + c.ask) / 2).toFixed(2);
      c.spreadPct = +((c.ask - c.bid) / c.mid).toFixed(4);
    }
    return c;
  }
  rawCalls.forEach(enrich);
  rawPuts.forEach(enrich);

  // Merge by strike
  var byStrike = {};
  rawCalls.forEach(function(c){ if (!byStrike[c.strike]) byStrike[c.strike] = { strike: c.strike }; byStrike[c.strike].call = c; });
  rawPuts .forEach(function(p){ if (!byStrike[p.strike]) byStrike[p.strike] = { strike: p.strike }; byStrike[p.strike].put  = p; });

  // Sorted descending (highest strike at top)
  var rows = Object.values(byStrike).sort(function(a, b){ return b.strike - a.strike; });

  // Score each side
  rows.forEach(function(r) {
    if (r.call) r.call.score = scoreStrike(r.call, { targetDelta: 0.50 });
    if (r.put)  r.put .score = scoreStrike(r.put,  { targetDelta: 0.50 });
  });

  // Volume totals (for color intensity)
  var totalCallVol = rawCalls.reduce(function(s, c){ return s + (c.volume || 0); }, 0);
  var totalPutVol  = rawPuts .reduce(function(s, p){ return s + (p.volume || 0); }, 0);
  var maxStrikeVol = 0;
  rows.forEach(function(r){
    var v = (r.call && r.call.volume || 0) + (r.put && r.put.volume || 0);
    if (v > maxStrikeVol) maxStrikeVol = v;
  });

  // Best-strike picker — top 1 call + top 1 put by score (both must have >0 score)
  var topCalls = rawCalls.filter(function(c){ return c.score > 0; }).sort(function(a, b){ return b.score - a.score; });
  var topPuts  = rawPuts .filter(function(p){ return p.score > 0; }).sort(function(a, b){ return b.score - a.score; });

  return {
    ticker:          ticker,
    expiry:          expiry,
    priceCenter:     priceCenter || null,
    fetchedAt:       new Date().toISOString(),
    rows:            rows,
    totalCallVol:    totalCallVol,
    totalPutVol:     totalPutVol,
    callPutRatio:    totalPutVol > 0 ? +(totalCallVol / totalPutVol).toFixed(2) : null,
    maxStrikeVol:    maxStrikeVol,
    bestCall:        topCalls[0] || null,
    bestPut:         topPuts[0]  || null,
  };
}

module.exports = { fetchChain: fetchChain, scoreStrike: scoreStrike };
