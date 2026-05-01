// =============================================================================
// GEX CALCULATOR (May 1 2026)
//
// Replaces Bullflow's gamma layer at $0/mo. Pulls full options chain from
// TradeStation, computes per-strike Net GEX, identifies king nodes (price
// magnets), zero-gamma flip strike, and call/put walls.
//
// Math (simplified GEX model):
//   per_strike_GEX = (call_OI × call_gamma - put_OI × put_gamma) × 100 × spot
//   king_nodes     = top |GEX| strikes (price tends to magnetize toward these)
//   zero_gamma     = strike where cumulative Net GEX flips sign
//   call_wall      = highest single-strike positive GEX (ceiling magnet)
//   put_wall       = highest |GEX| on the put side (floor magnet)
//
// Output: /data/gex_map.json + Discord push at 8:30 AM ET daily
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[GEX] tradestation not loaded:', e.message); }

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var GEX_FILE = path.join(DATA_ROOT, 'gex_map.json');
var GEX_HISTORY_DIR = path.join(DATA_ROOT, 'gex_history');
try { fs.mkdirSync(GEX_HISTORY_DIR, { recursive: true }); } catch(e) {}

var DISCORD_WEBHOOK = process.env.DISCORD_GEX_WEBHOOK || process.env.DISCORD_GEX_WEBHOOK_LIVE || null;

// Default tickers to map daily — indices + AB's typical universe
var DEFAULT_TICKERS = (process.env.GEX_TICKERS || 'SPY,QQQ,IWM,DIA').split(',');

// Strike range: ±N strikes from ATM (TS streaming endpoint optimal ~12-20)
var STRIKE_PROXIMITY = parseInt(process.env.GEX_STRIKE_PROXIMITY || '20');
var STREAM_TIMEOUT_MS = parseInt(process.env.GEX_STREAM_TIMEOUT_MS || '7000');
var MAX_CONTRACTS_PER_SIDE = parseInt(process.env.GEX_MAX_CONTRACTS || '40');

// =============================================================================
// HELPERS
// =============================================================================
function formatExpiry(date) {
  if (typeof date === 'string') return date.slice(0, 10);
  if (date instanceof Date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return null;
}

function round2(v) { return Math.round(v * 100) / 100; }
function roundI(v) { return Math.round(v); }

// =============================================================================
// FETCH SPOT PRICE (for ATM centering)
// =============================================================================
async function getSpot(ticker, token) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(ticker);
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('quote-' + r.status);
  var data = await r.json();
  var q = (data && data.Quotes && data.Quotes[0]) || {};
  return parseFloat(q.Last || q.Close || q.Ask || 0);
}

// =============================================================================
// FETCH OPTION EXPIRATIONS
// =============================================================================
async function getExpirations(ticker, token) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var url = 'https://api.tradestation.com/v3/marketdata/options/expirations/' + encodeURIComponent(ticker);
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('expirations-' + r.status);
  var data = await r.json();
  var raw = (data && (data.Expirations || data.expirations)) || [];
  var today = Date.now();
  return raw.map(function(e) {
    var d = new Date(e.Date || e.date);
    return {
      date: formatExpiry(d),
      dte: Math.max(0, Math.round((d.getTime() - today) / (24 * 60 * 60 * 1000))),
    };
  }).filter(function(e) { return e.date && e.dte >= 0; });
}

// =============================================================================
// FETCH CHAIN — SSE streaming, full strike range, both calls AND puts
// =============================================================================
async function fetchChainSide(ticker, expiry, optType, spot, token) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var url = 'https://api.tradestation.com/v3/marketdata/stream/options/chains/' + ticker
    + '?expiration=' + formatExpiry(expiry)
    + '&optionType=' + optType   // 'Call' or 'Put'
    + '&strikeProximity=' + STRIKE_PROXIMITY
    + '&enableGreeks=true';
  if (spot) url += '&priceCenter=' + Math.round(spot);

  var res = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) {
    return { error: 'chain-' + res.status, contracts: [] };
  }

  var contracts = [];
  var buffer = '';

  await new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; try { res.body.destroy(); } catch(e) {} resolve(); }
    }, STREAM_TIMEOUT_MS);

    res.body.on('data', function(chunk) {
      buffer += chunk.toString();
      var parts = buffer.split('\n');
      buffer = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line) continue;
        try {
          var obj = JSON.parse(line);
          // Match contractResolver's permissive filter — accept any quote-like packet,
          // then derive strike from object directly OR from Legs[0]
          if (obj && (obj.Legs || obj.legs || obj.Delta !== undefined || obj.Gamma !== undefined || obj.Ask || obj.Bid)) {
            var strikeObj = obj;
            if (obj.Legs && obj.Legs[0]) strikeObj = Object.assign({}, obj.Legs[0], obj);  // merge top-level greeks if present
            if (strikeObj.Strike !== undefined) {
              contracts.push(strikeObj);
            }
          }
          if (contracts.length >= MAX_CONTRACTS_PER_SIDE) {
            clearTimeout(timer);
            if (!done) { done = true; try { res.body.destroy(); } catch(e) {} resolve(); }
          }
        } catch(e) { /* skip parse errors */ }
      }
    });
    res.body.on('end', function() {
      clearTimeout(timer);
      if (!done) { done = true; resolve(); }
    });
    res.body.on('error', function() {
      clearTimeout(timer);
      if (!done) { done = true; resolve(); }
    });
  });

  return { contracts: contracts };
}

// =============================================================================
// GEX MATH
// Per-strike Net GEX = (call_OI × call_gamma - put_OI × put_gamma) × 100 × spot
//   (positive = dealer-positive gamma, stabilizing magnetic effect at strike)
//   (negative = dealer-negative gamma, amplifying / repelling effect)
// =============================================================================
function computeGEX(callContracts, putContracts, spot) {
  var byStrike = {};

  callContracts.forEach(function(c) {
    var strike = parseFloat(c.Strike);
    if (!strike || !isFinite(strike)) return;
    var oi = parseFloat(c.OpenInterest || c.openInterest || 0);
    var gamma = parseFloat(c.Gamma || c.gamma || 0);
    var iv = parseFloat(c.ImpliedVolatility || c.iv || 0);
    if (!byStrike[strike]) byStrike[strike] = { strike: strike, callOI: 0, putOI: 0, callGamma: 0, putGamma: 0, callIV: 0, putIV: 0 };
    byStrike[strike].callOI = oi;
    byStrike[strike].callGamma = gamma;
    byStrike[strike].callIV = iv;
  });

  putContracts.forEach(function(c) {
    var strike = parseFloat(c.Strike);
    if (!strike || !isFinite(strike)) return;
    var oi = parseFloat(c.OpenInterest || c.openInterest || 0);
    var gamma = parseFloat(c.Gamma || c.gamma || 0);
    var iv = parseFloat(c.ImpliedVolatility || c.iv || 0);
    if (!byStrike[strike]) byStrike[strike] = { strike: strike, callOI: 0, putOI: 0, callGamma: 0, putGamma: 0, callIV: 0, putIV: 0 };
    byStrike[strike].putOI = oi;
    byStrike[strike].putGamma = gamma;
    byStrike[strike].putIV = iv;
  });

  // Compute per-strike GEX dollars
  var rows = Object.keys(byStrike).map(function(k) {
    var s = byStrike[k];
    var callGex = s.callOI * s.callGamma * 100 * spot;
    var putGex = -1 * s.putOI * s.putGamma * 100 * spot;
    var netGex = callGex + putGex;
    var totalOI = s.callOI + s.putOI;
    return Object.assign({}, s, {
      callGex: roundI(callGex),
      putGex: roundI(putGex),
      netGex: roundI(netGex),
      totalOI: totalOI,
    });
  }).sort(function(a, b) { return a.strike - b.strike; });

  return rows;
}

// =============================================================================
// FIND KING NODES & ZERO GAMMA
// =============================================================================
function findKingNodes(rows, n) {
  n = n || 3;
  // King nodes = top N |netGex| strikes overall
  var sorted = rows.slice().sort(function(a, b) { return Math.abs(b.netGex) - Math.abs(a.netGex); });
  return sorted.slice(0, n);
}

function findCallWall(rows) {
  // Highest positive call GEX strike
  var positive = rows.filter(function(r) { return r.callGex > 0; });
  positive.sort(function(a, b) { return b.callGex - a.callGex; });
  return positive[0] || null;
}

function findPutWall(rows) {
  // Highest absolute put GEX strike (most negative netGex from puts)
  var withPuts = rows.filter(function(r) { return r.putOI > 0; });
  withPuts.sort(function(a, b) { return Math.abs(b.putGex) - Math.abs(a.putGex); });
  return withPuts[0] || null;
}

function findZeroGamma(rows, spot) {
  // Cumulative GEX as we walk from low to high strike — flip strike where cumulative crosses zero
  // (Note: this is a SIMPLIFIED zero gamma; real model is per-spot calculation)
  var cum = 0;
  var rowsSorted = rows.slice().sort(function(a, b) { return a.strike - b.strike; });
  for (var i = 0; i < rowsSorted.length; i++) {
    var prevCum = cum;
    cum += rowsSorted[i].netGex;
    if ((prevCum < 0 && cum >= 0) || (prevCum > 0 && cum <= 0)) {
      return rowsSorted[i].strike;
    }
  }
  // Fallback: midpoint of largest call wall and largest put wall
  return null;
}

// =============================================================================
// COMPUTE FULL GEX MAP FOR ONE TICKER
// =============================================================================
async function computeForTicker(ticker, token, opts) {
  opts = opts || {};
  try {
    var spot = await getSpot(ticker, token);
    if (!spot) return { ticker: ticker, error: 'no-spot' };

    var expirations = await getExpirations(ticker, token);
    if (!expirations.length) return { ticker: ticker, error: 'no-expirations', spot: spot };

    // Use 0-30 DTE expirations (most relevant for daily gamma magnetism)
    var nearTerm = expirations.filter(function(e) { return e.dte >= 0 && e.dte <= 30; }).slice(0, 4);
    if (!nearTerm.length) {
      nearTerm = expirations.slice(0, 1);  // fall back to next available
    }

    // Pull chain for each expiration (call + put), aggregate
    var allCalls = [];
    var allPuts = [];
    for (var i = 0; i < nearTerm.length; i++) {
      var exp = nearTerm[i];
      try {
        var callRes = await fetchChainSide(ticker, exp.date, 'Call', spot, token);
        var putRes = await fetchChainSide(ticker, exp.date, 'Put', spot, token);
        allCalls = allCalls.concat(callRes.contracts || []);
        allPuts = allPuts.concat(putRes.contracts || []);
      } catch (e) {
        console.warn('[GEX] chain fetch fail for ' + ticker + ' ' + exp.date + ':', e.message);
      }
      // Light throttle between expirations
      if (i < nearTerm.length - 1) {
        await new Promise(function(r) { setTimeout(r, 200); });
      }
    }

    if (!allCalls.length && !allPuts.length) {
      return { ticker: ticker, spot: spot, error: 'no-chain-data' };
    }

    var rows = computeGEX(allCalls, allPuts, spot);

    var totalGEX = rows.reduce(function(acc, r) { return acc + r.netGex; }, 0);
    var regime = totalGEX > 0 ? 'POSITIVE' : 'NEGATIVE';
    var kingNodes = findKingNodes(rows, 5);
    var callWall = findCallWall(rows);
    var putWall = findPutWall(rows);
    var zeroGamma = findZeroGamma(rows, spot);

    // Filter for the dashboard view: only strikes with meaningful GEX
    var significant = rows.filter(function(r) {
      return Math.abs(r.netGex) >= Math.abs(totalGEX) * 0.01;  // ≥1% of total |GEX|
    });

    return {
      ticker: ticker,
      spot: round2(spot),
      computedAt: new Date().toISOString(),
      expirationsScanned: nearTerm.map(function(e) { return e.date; }),
      callContracts: allCalls.length,
      putContracts: allPuts.length,
      strikes: rows.length,
      totalGEX: roundI(totalGEX),
      regime: regime,
      kingNodes: kingNodes,
      callWall: callWall,
      putWall: putWall,
      zeroGamma: zeroGamma,
      significant: significant,
    };
  } catch (e) {
    return { ticker: ticker, error: e.message };
  }
}

// =============================================================================
// DAILY MAP — runs for default tickers + custom list
// =============================================================================
var _running = false;
var _lastRun = null;

async function runDailyMap(opts) {
  opts = opts || {};
  if (_running && !opts.force) return { skipped: true, reason: 'already-running' };
  _running = true;
  var start = Date.now();

  try {
    var token = opts.token;
    if (!token && ts && ts.getAccessToken) {
      try { token = await ts.getAccessToken(); }
      catch (e) { return { error: 'TS auth: ' + e.message }; }
    }
    if (!token) return { error: 'no-token' };

    var tickers = opts.tickers || DEFAULT_TICKERS.slice();
    tickers = tickers.map(function(t) { return String(t).toUpperCase().trim(); }).filter(Boolean);

    console.log('[GEX] computing daily map for', tickers.length, 'tickers');
    var results = [];
    for (var i = 0; i < tickers.length; i++) {
      var r = await computeForTicker(tickers[i], token);
      results.push(r);
      console.log('[GEX] ' + tickers[i] + ': ' + (r.error ? 'ERR ' + r.error : 'spot=$' + r.spot + ' regime=' + r.regime + ' strikes=' + r.strikes));
      if (i < tickers.length - 1) {
        await new Promise(function(r) { setTimeout(r, 500); });
      }
    }

    var payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      tickers: tickers,
      maps: results,
    };

    try {
      fs.writeFileSync(GEX_FILE, JSON.stringify(payload, null, 2));
      // Also archive daily snapshot for backtesting
      var dateStr = new Date().toISOString().slice(0, 10);
      var historyPath = path.join(GEX_HISTORY_DIR, 'gex_' + dateStr + '.json');
      fs.writeFileSync(historyPath, JSON.stringify(payload, null, 2));
    } catch (e) { console.warn('[GEX] write fail:', e.message); }

    _lastRun = { finishedAt: payload.generatedAt, tickers: tickers.length, errors: results.filter(function(r){ return r.error; }).length };
    console.log('[GEX] daily map complete in', payload.tookMs + 'ms');

    if (opts.pushDiscord !== false) {
      try {
        var pushResult = await pushToDiscord(payload);
        payload.discordPush = pushResult;
      } catch (e) { console.warn('[GEX] discord push fail:', e.message); }
    }

    return payload;
  } finally {
    _running = false;
  }
}

// =============================================================================
// DISCORD PUSH — formatted GEX map summary
// =============================================================================
async function pushToDiscord(payload) {
  if (!DISCORD_WEBHOOK) return { skipped: 'no webhook' };
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var validMaps = (payload.maps || []).filter(function(m) { return !m.error; });
  if (!validMaps.length) return { skipped: 'no valid maps' };

  var lines = [];
  lines.push('# 🎯 GEX MAP — ' + new Date(payload.generatedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }));
  lines.push('_Computed at ' + new Date(payload.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · sources: TS options chain (free)_');
  lines.push('');

  validMaps.forEach(function(m) {
    var spot = m.spot;
    var zg = m.zeroGamma;
    var regimeIcon = m.regime === 'POSITIVE' ? '🟢' : '🔴';
    lines.push('## ' + m.ticker + ' · spot `$' + spot + '` · ' + regimeIcon + ' ' + m.regime + ' GEX');

    // Format kings into table-ish lines
    if (m.kingNodes && m.kingNodes.length) {
      var sorted = m.kingNodes.slice().sort(function(a, b) { return b.strike - a.strike; });
      sorted.slice(0, 3).forEach(function(k) {
        var emoji = k.netGex > 0 ? '🟩' : '🟥';
        var label = k.netGex > 0 ? 'CALL magnet' : 'PUT magnet';
        var dist = ((k.strike - spot) / spot) * 100;
        var distStr = (dist >= 0 ? '+' : '') + dist.toFixed(1) + '%';
        lines.push('  ' + emoji + ' `$' + k.strike + '` ' + label + ' · `$' + (Math.abs(k.netGex) / 1e6).toFixed(1) + 'M` exposure · ' + distStr + ' from spot');
      });
    }
    if (zg) lines.push('  ⚪ Zero gamma flip: `$' + zg + '` — regime line');

    // Read paragraph
    if (m.regime === 'POSITIVE') {
      lines.push('  📖 Read: positive gamma = pinning behavior likely. Walls act as magnets. Range-bound day favored.');
    } else {
      lines.push('  📖 Read: negative gamma = volatility-amplifying. Breakouts run further. Watch zero gamma flip for regime change.');
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('💡 Use king nodes for trim/runner decisions. Don\'t chase between two adjacent magnets.');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'GEX Bot' }),
    });
    if (!r.ok) {
      var t = await r.text();
      return { error: 'discord-' + r.status + ' ' + t.slice(0, 100) };
    }
    return { posted: true, count: validMaps.length };
  } catch (e) { return { error: e.message }; }
}

// =============================================================================
// LOAD/STATUS
// =============================================================================
function loadLast() {
  if (!fs.existsSync(GEX_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(GEX_FILE, 'utf8')); }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

function getStatus() {
  return { running: _running, lastRun: _lastRun, file: GEX_FILE };
}

module.exports = {
  computeForTicker: computeForTicker,
  runDailyMap: runDailyMap,
  loadLast: loadLast,
  getStatus: getStatus,
  pushToDiscord: pushToDiscord,
  // Internal exposed for testing
  computeGEX: computeGEX,
  findKingNodes: findKingNodes,
  findCallWall: findCallWall,
  findPutWall: findPutWall,
  findZeroGamma: findZeroGamma,
};
