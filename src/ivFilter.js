// ivFilter.js -- Stratum v7.5
// IMPLIED VOLATILITY GATE
//
// Prevents entries on options where IV is so high that even a winning
// directional trade loses money to IV crush + theta. LUNR 119% IV
// taught us this lesson — stock up 6%, calls still red.
//
// Default cap: 80% IV. Configurable via IV_CAP env or runtimeConfig.
// High-beta names get a slightly higher cap (100%) since they naturally
// run hotter, but anything above that is a theta trap.
//
// Usage:
//   var ivFilter = require('./ivFilter');
//   var check = await ivFilter.checkIV(ticker, direction, token);
//   if (!check.allowed) { skip }

var fetch = require('node-fetch');

var TS_BASE = 'https://api.tradestation.com/v3';

// ================================================================
// CONFIG
// ================================================================
var DEFAULT_IV_CAP = 0.80;       // 80% — options above this are theta traps
// Apr 16 2026: Raised from 100% → 115% after Telegram MARA +283% case study.
// MARA was 102% IV and someone made +283% on it. Our cap at 100% would have
// blocked that winner. High-beta crypto miners/AI names run 100-115% IV
// normally. The REAL theta trap is LUNR at 119%. Keep cap above typical
// range but below the danger zone.
var HIGH_BETA_IV_CAP = 1.15;     // 115% — allows MARA/RIOT/COIN etc. to fire
var IV_WARNING_THRESHOLD = 0.65; // 65% — flag as elevated but allow

var HIGH_BETA = [
  'MARA','RIOT','COIN','MSTR','IONQ','RGTI','SOUN','ACHR','LUNR',
  'RKLB','HOOD','SOFI','AFRM','UPST','HIMS','APP','SNAP','RDDT',
  'ROKU','DKNG','SE','SMCI','ARM','TSLA','NVDA','AMD','PLTR','SHOP','SNOW',
];

function getIVCap(ticker) {
  // Check runtimeConfig first
  try {
    var rc = require('./runtimeConfig');
    var custom = rc.get('IV_CAP');
    if (custom) return parseFloat(custom);
  } catch(e) {}
  // Env override
  if (process.env.IV_CAP) return parseFloat(process.env.IV_CAP);
  // High-beta names get more room
  if (HIGH_BETA.indexOf(ticker.toUpperCase()) !== -1) return HIGH_BETA_IV_CAP;
  return DEFAULT_IV_CAP;
}

// ================================================================
// CACHE — avoid hammering option chain endpoint
// ================================================================
var _cache = {};
var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(ticker) {
  var entry = _cache[ticker];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete _cache[ticker]; return null; }
  return entry.data;
}

function setCache(ticker, data) {
  _cache[ticker] = { data: data, ts: Date.now() };
}

// ================================================================
// FETCH IV — get ATM option IV from TradeStation option chain
// ================================================================
async function fetchATMiv(ticker, token) {
  var cached = getCached(ticker);
  if (cached) return cached;

  try {
    // Get next weekly/monthly expiration's ATM call IV
    var url = TS_BASE + '/marketdata/options/chains/' + encodeURIComponent(ticker) +
              '?strikeProximity=1&optionType=Call&enableGreeks=true';
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      console.log('[IV] chain fetch failed for ' + ticker + ': ' + res.status);
      return null;
    }
    var data = await res.json();
    // Navigate the response — look for Spreads array or similar
    var spreads = data.Spreads || data.spreads || [];
    if (spreads.length === 0) {
      // Try alternate response shape
      var options = data.Options || data.options || data.Legs || [];
      if (options.length > 0) {
        var iv = parseFloat(options[0].ImpliedVolatility || options[0].impliedVolatility || 0);
        if (iv > 0) {
          var result = { iv: iv, source: 'chain-options' };
          setCache(ticker, result);
          return result;
        }
      }
      return null;
    }
    // Get the ATM spread (first one, closest to price center)
    var atm = spreads[0];
    var iv = parseFloat(atm.ImpliedVolatility || atm.impliedVolatility || 0);
    if (iv > 0) {
      var result = { iv: iv, source: 'chain-spread' };
      setCache(ticker, result);
      return result;
    }
    return null;
  } catch(e) {
    console.error('[IV] fetchATMiv ' + ticker + ' error:', e.message);
    return null;
  }
}

// ================================================================
// FETCH IV FROM OPTION QUOTE — when we already have contract symbol
// Uses the option chain snapshot endpoint which returns IV
// ================================================================
async function fetchContractIV(ticker, contractSymbol, token) {
  var cached = getCached(contractSymbol);
  if (cached) return cached;

  try {
    // Parse expiration from contract symbol (e.g., "LUNR 260501C24")
    // Format: TICKER YYMMDDCSTRIKE
    var parts = contractSymbol.split(' ');
    if (parts.length < 2) return null;
    var detail = parts[1]; // e.g., "260501C24"
    var yy = detail.substring(0, 2);
    var mm = detail.substring(2, 4);
    var dd = detail.substring(4, 6);
    var expiration = mm + '-' + dd + '-20' + yy;
    var strikeStr = detail.substring(7); // after C or P
    var strike = parseFloat(strikeStr);

    var url = TS_BASE + '/marketdata/options/chains/' + encodeURIComponent(ticker) +
              '?expiration=' + expiration + '&strikeProximity=1&enableGreeks=true&priceCenter=' + strike;
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      console.log('[IV] contract chain fetch failed: ' + res.status);
      return null;
    }
    var data = await res.json();
    var spreads = data.Spreads || data.spreads || [];
    if (spreads.length > 0) {
      var iv = parseFloat(spreads[0].ImpliedVolatility || spreads[0].impliedVolatility || 0);
      if (iv > 0) {
        var result = { iv: iv, source: 'contract-chain' };
        setCache(contractSymbol, result);
        return result;
      }
    }
    // Try Options array
    var options = data.Options || data.options || [];
    if (options.length > 0) {
      var iv = parseFloat(options[0].ImpliedVolatility || options[0].impliedVolatility || 0);
      if (iv > 0) {
        var result = { iv: iv, source: 'contract-options' };
        setCache(contractSymbol, result);
        return result;
      }
    }
    return null;
  } catch(e) {
    console.error('[IV] fetchContractIV error:', e.message);
    return null;
  }
}

// ================================================================
// MAIN: checkIV — returns { allowed, iv, cap, reason, warning }
// ================================================================
async function checkIV(ticker, token, contractSymbol) {
  try {
    var ivData = null;
    // If we have a contract symbol, try that first (more precise)
    if (contractSymbol) {
      ivData = await fetchContractIV(ticker, contractSymbol, token);
    }
    // Fall back to ATM IV
    if (!ivData) {
      ivData = await fetchATMiv(ticker, token);
    }
    // If we can't get IV data, allow the trade but warn
    if (!ivData || !ivData.iv) {
      console.log('[IV] no IV data for ' + ticker + ', allowing trade');
      return { allowed: true, iv: null, cap: null, reason: 'no IV data available', warning: false };
    }

    var iv = ivData.iv;
    var cap = getIVCap(ticker);
    var ivPct = Math.round(iv * 100);
    var capPct = Math.round(cap * 100);

    if (iv > cap) {
      var reason = ticker + ' IV ' + ivPct + '% exceeds cap ' + capPct + '% — theta trap, skipping';
      console.log('[IV] BLOCKED: ' + reason);
      return { allowed: false, iv: iv, cap: cap, reason: reason, warning: false };
    }

    var warning = iv > IV_WARNING_THRESHOLD;
    if (warning) {
      console.log('[IV] WARNING: ' + ticker + ' IV ' + ivPct + '% elevated (cap ' + capPct + '%)');
    }

    return { allowed: true, iv: iv, cap: cap, reason: null, warning: warning };
  } catch(e) {
    console.error('[IV] checkIV error:', e.message);
    // On error, allow trade — don't block on filter failure
    return { allowed: true, iv: null, cap: null, reason: 'error: ' + e.message, warning: false };
  }
}

// ================================================================
// DIAGNOSTICS
// ================================================================
function getState() {
  var entries = {};
  for (var key in _cache) {
    entries[key] = {
      iv: _cache[key].data ? _cache[key].data.iv : null,
      age: Math.round((Date.now() - _cache[key].ts) / 1000) + 's',
    };
  }
  return {
    defaultCap: DEFAULT_IV_CAP,
    highBetaCap: HIGH_BETA_IV_CAP,
    warningThreshold: IV_WARNING_THRESHOLD,
    cached: entries,
  };
}

function clearCache() {
  _cache = {};
}

module.exports = {
  checkIV: checkIV,
  fetchATMiv: fetchATMiv,
  fetchContractIV: fetchContractIV,
  getIVCap: getIVCap,
  getState: getState,
  clearCache: clearCache,
  HIGH_BETA: HIGH_BETA,
};
