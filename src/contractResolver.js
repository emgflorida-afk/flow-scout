// contractResolver.js - Stratum Flow Scout v7.5
// CHAIN HIERARCHY: TradeStation → Public.com → Polygon
// Falls back to next source if chain returns 404 or empty
// -----------------------------------------------------------------

const fetch = require('node-fetch');

// Rate limiter -- serialized queue prevents TS 429 under concurrent Stratum bursts.
// Prior version was a race: N concurrent callers all read _lastChainRequest at once
// and fired simultaneously. This chains each call onto the tail of a promise so
// requests leave with a guaranteed gap between them.
// Apr 21 2026 PM v4 — dropped 1500ms → 400ms. TS tier allows ~10 req/s and
// 400ms leaves plenty of headroom. 1500ms was so conservative that 12 card
// enrichments queued for 18s before each per-card timeout even started,
// guaranteeing every card timed out. Override via TS_CHAIN_DELAY_MS env.
var CHAIN_DELAY_MS = parseInt(process.env.TS_CHAIN_DELAY_MS, 10) || 400;
var _chainTail = Promise.resolve();
var _lastChainDone = 0;
function rateLimit() {
  var next = _chainTail.then(function() {
    var gap = Date.now() - _lastChainDone;
    var wait = gap < CHAIN_DELAY_MS ? CHAIN_DELAY_MS - gap : 0;
    return new Promise(function(r) { setTimeout(r, wait); }).then(function() {
      _lastChainDone = Date.now();
    });
  });
  _chainTail = next.catch(function() {});
  return next;
}

const MODES = {
  DAY: {
    label: 'DAY TRADE', minPremium: 0.30, maxPremium: 3.50,
    minDTE: 2, maxDTE: 5, stopPct: 0.25, t1Pct: 0.40, maxRisk: 400,
    minVol: 50, minOI: 50,           // Phase 4.19 — DAY can tolerate slightly thin
  },
  SWING: {
    label: 'SWING TRADE', minPremium: 0.50, maxPremium: 5.00,
    minDTE: 7, maxDTE: 21, stopPct: 0.30, t1Pct: 0.50, maxRisk: 600,
    minVol: 100, minOI: 200,         // Phase 4.19 — SWING needs real liquidity (May 5 META 55/97 burn)
  },
  // LOTTO mode (May 4 2026 v2) — MAXIMUM PERMISSIVE, last-resort fallback.
  // Goal: never return null when ANY tradable option exists for the ticker.
  // After v1's $0.05-$2.00 / 1-14 DTE still bounced AB's test, we widened to
  // $0.02-$5.00 / 0-45 DTE so AYCE big-cap setups (sometimes 30+ DTE, sometimes
  // very-cheap deep-OTM lottos) can both resolve through this fallback.
  LOTTO: {
    label: 'LOTTO', minPremium: 0.02, maxPremium: 5.00,
    minDTE: 0, maxDTE: 45, stopPct: 0.40, t1Pct: 0.60, maxRisk: 300,
    minVol: 25, minOI: 25,           // Phase 4.19 — LOTTO most permissive but still some floor
  },
};

// Phase 4.19 — STANDARD EXPIRY POLICY for SWING/LOTTO.
// Tuesday/Thursday weeklies often have thin OI/vol. Friday weeklies + monthlies
// are the liquid expiries. This filter prevents the resolver from picking a
// "Tuesday weekly" that auto-resolved to a 50-volume contract. Override only
// for explicit lotto plays where any expiry is acceptable.
function isStandardExpiry(dateStr) {
  if (!dateStr) return false;
  // YYYY-MM-DD → Date object treated as UTC noon (avoids TZ rollover)
  var d = new Date(dateStr + 'T12:00:00Z');
  var dow = d.getUTCDay();    // 0=Sun, 5=Fri
  return dow === 5;           // Only Friday — covers weekly Fri AND monthly Fri (3rd Fri)
}
function isMonthlyExpiry(dateStr) {
  if (!dateStr) return false;
  var d = new Date(dateStr + 'T12:00:00Z');
  // Monthly expiry = 3rd Friday of the month
  if (d.getUTCDay() !== 5) return false;
  var dom = d.getUTCDate();
  return dom >= 15 && dom <= 21;
}

const MIN_PREMIUM = 0.30;
const MAX_PREMIUM = 5.00;

// HIGH-PRICED STOCKS: ATM options on $100+ stocks exceed default cap.
// Expanded for Bill-Paying Mode — A+ Stratum alerts on liquid mega-caps
// need room. $105K BP supports 3 contracts × $6 = $1,800 risk per setup.
var HIGH_PRICE_TICKERS = new Set([
  'NVDA','AMZN','GOOGL','GOOG','META','NFLX','AVGO','MSFT','XSP','TSM','ASML','NOC',
  'TSLA','COST','HD','LOW','JPM','GS','BAC','CVX','XOM','UNH','LLY','ORCL','CRM','ADBE',
  'COIN','MU','MRVL','SPY','QQQ','IWM','DIA','WMT','MA','V','BRK.B','AAPL','SMCI','PLTR',
]);
var HIGH_PRICE_MAX_PREMIUM = 7.00; // 3 contracts × $7 = $2,100 risk max on A+ setup

// MAY 6 2026 PM — DIVIDEND/BLUE-CHIP ATM-EXPENSIVE NAMES (AB caught KO failure).
// Stocks like KO, PG, JNJ, MCD, WMT, T, VZ, MO, KHC trade slow but their NEAR-
// THE-MONEY calls have high time value relative to spot — $9-12 mid is typical
// even though the stock is only $50-80. Default $5 maxPremium blocks them.
// These get a $12 maxPremium so ATM/just-OTM contracts can resolve cleanly.
var DIVIDEND_HIGH_TIME_VALUE_TICKERS = new Set([
  'KO','PG','JNJ','MCD','WMT','T','VZ','MO','KHC','PEP','PM','ABBV','PFE','MRK',
  'XOM','CVX','CAT','MMM','HD','LOW','UNP','HON','BA','LMT','RTX','BMY','GILD',
  'C','WFC','USB','MS','SCHW','BLK',
]);
var DIVIDEND_MAX_PREMIUM = 12.00;

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','XSP',
  'NVDA','TSLA','META','GOOGL','AMZN','MSFT','AMD','AAPL','MRVL',
  'JPM','GS','MS','WFC','BAC','V','MA',
  'XLE','XOM','CVX','COP',
  'UNH','MRK','LLY','ABBV',
  'WMT','COST','HD','TGT',
  'COIN','MSTR','PLTR','DKNG','RIVN','U','ABNB','UBER','BIDU',
  'MCD','FAST',
  'XLK','XLF','XLV','GLD','TLT',
  'KO','PEP','MRNA','GUSH','UVXY',
  'TSM','NFLX','ASML','JNJ','PGR','NOC','XLE'
]);

const T1_TARGETS = {
  TSLA: 0.50, COIN: 0.50, NVDA: 0.50, MRVL: 0.50,
  AAPL: 0.40, AMZN: 0.40, MSFT: 0.40, GOOGL: 0.40,
};
function getT1Target(ticker) { return T1_TARGETS[ticker] || 0.30; }

// -- TRADESTATION TOKEN -------------------------------------------
async function getTSToken() {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) { console.error('[TS] getAccessToken returned null'); return null; }
    return token;
  } catch(e) { console.error('[TS] Token error:', e.message); return null; }
}

function getTSBase()       { return 'https://api.tradestation.com/v3'; }
function getTSBaseOrders() {
  return process.env.SIM_MODE === 'true'
    ? 'https://sim-api.tradestation.com/v3'
    : 'https://api.tradestation.com/v3';
}

// -- GET STOCK PRICE ----------------------------------------------
async function getPrice(ticker, token) {
  try {
    console.log('[PRICE] Fetching', ticker);
    if (!token) return null;
    var res = await fetch(getTSBase() + '/marketdata/quotes/' + ticker, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var quotes = data.Quotes || data.quotes || (Array.isArray(data) ? data : [data]);
    var q = quotes[0];
    if (!q) return null;
    var price = parseFloat(q.Last || q.Bid || q.Ask || 0);
    if (price > 0) { console.log('[PRICE] ' + ticker + ' $' + price + ' - TradeStation'); return price; }
    return null;
  } catch(e) { console.error('[PRICE] Error:', e.message); return null; }
}

// -- GET PDH/PDL --------------------------------------------------
async function getLVLs(ticker, token) {
  try {
    console.log('[LVL] Fetching bars for', ticker);
    if (!token) return null;
    var res = await fetch(
      getTSBase() + '/marketdata/barcharts/' + ticker +
      '?unit=Daily&interval=1&barsback=3',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    console.log('[LVL] Bars returned:', bars.length);
    if (bars.length < 2) return null;
    bars.sort(function(a,b){ return new Date(a.TimeStamp)-new Date(b.TimeStamp); });
    var prev = bars[bars.length-2];
    var curr = bars[bars.length-1];
    var pdh=parseFloat(prev.High), pdl=parseFloat(prev.Low), pdc=parseFloat(prev.Close);
    console.log('[LVL] ' + ticker + ' PDH:$'+pdh+' PDL:$'+pdl+' PDC:$'+pdc);
    return { pdh, pdl, pdc, todayOpen:parseFloat(curr.Open),
      callEntry:pdh, putEntry:pdl, callStop:pdl, putStop:pdh };
  } catch(e) { console.error('[LVL] Error for',ticker,':',e.message); return null; }
}

// -- GET EXPIRATIONS ----------------------------------------------
async function getExpirations(ticker, token) {
  try {
    console.log('[EXPIRY] Fetching for', ticker);
    if (!token) return [];
    var url = getTSBase() + '/marketdata/options/expirations/' + ticker;
    var res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    console.log('[EXPIRY] HTTP status:', res.status);
    var data = await res.json();
    var exps = data.Expirations || data.expirations || [];
    console.log('[EXPIRY] Raw count:', exps.length);
    if (!exps.length) return [];
    var mapped = exps.map(function(e){
      var dateStr = (e.Date||e.date||'').slice(0,10);
      // Calculate DTE by calendar days in ET timezone (not milliseconds)
      // This prevents today's expiry from showing as 1DTE due to rounding
      var etNow = new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
      var etToday = new Date(etNow).toISOString().slice(0,10); // YYYY-MM-DD in ET
      var todayMs = new Date(etToday+'T00:00:00Z').getTime();
      var expMs   = new Date(dateStr+'T00:00:00Z').getTime();
      var dte = dateStr ? Math.round((expMs - todayMs) / (1000*60*60*24)) : 0;
      return { date:dateStr, dte:Math.max(0,dte), type:e.Type||'Weekly' };
    }).filter(function(e){ return e.date && e.dte >= 0; });
    console.log('[EXPIRY] Valid:', mapped.length, mapped.slice(0,3).map(function(e){ return e.date+'('+e.dte+'DTE)'; }).join(', '));
    return mapped;
  } catch(e) { console.error('[EXPIRY] Error:', e.message); return []; }
}

function selectExpiry(expirations, mode) {
  var config = MODES[mode] || MODES.SWING;
  // HARD RULE: NEVER select dead-expiry -- must be >= config.minDTE.
  // No "nearest non-zero" fallback: a 1DTE for a SWING is a bug, not a fallback.
  var eligible = expirations.filter(function(e){ return e.dte >= config.minDTE; });
  if (eligible.length === 0) {
    console.log('[EXPIRY] BLOCKED -- no expirations meet minDTE=' + config.minDTE);
    return null;
  }
  var valid = eligible.filter(function(e){ return e.dte <= config.maxDTE; });

  // Phase 4.19 — for SWING/LOTTO, PREFER Friday weeklies + monthlies (skip Tue/Thu
  // weeklies which often have thin OI). DAY mode picks nearest regardless because
  // 0-3 DTE has limited choices anyway.
  if (mode === 'SWING' || mode === 'LOTTO') {
    var fridays = valid.filter(function(e){ return isStandardExpiry(e.date); });
    var monthlies = fridays.filter(function(e){ return isMonthlyExpiry(e.date); });
    // Prefer monthly Friday if within DTE band — most liquid
    if (monthlies.length > 0) {
      console.log('[EXPIRY] PREFERRED MONTHLY:', monthlies[0].date+'('+monthlies[0].dte+'DTE)');
      return monthlies[0];
    }
    // Otherwise nearest Friday weekly
    if (fridays.length > 0) {
      console.log('[EXPIRY] PREFERRED FRIDAY-WEEKLY:', fridays[0].date+'('+fridays[0].dte+'DTE)');
      return fridays[0];
    }
    // Fallback within band — log warning that we're picking a non-standard weekday
    if (valid.length > 0) {
      console.log('[EXPIRY] WARN no Friday in DTE band -- falling back to:', valid[0].date+'('+valid[0].dte+'DTE) day-of-week='+new Date(valid[0].date+'T12:00:00Z').getUTCDay());
      return valid[0];
    }
  }

  if (valid.length > 0) { console.log('[EXPIRY] Selected:',valid[0].date+'('+valid[0].dte+'DTE)'); return valid[0]; }
  // Fallback: nearest expiry that still meets minDTE (may be slightly past maxDTE)
  console.log('[EXPIRY] Fallback (past maxDTE but >= minDTE):',eligible[0].date+'('+eligible[0].dte+'DTE)');
  return eligible[0];
}

function formatExpiry(dateStr) {
  if (!dateStr) return null;
  var p = dateStr.split('-');
  return p.length !== 3 ? dateStr : p[1]+'-'+p[2]+'-'+p[0];
}

// -- GET OPTION CHAIN: TRADESTATION (source 1) --------------------
async function getChainTS(ticker, expiry, type, price, token) {
  try {
    console.log('[CHAIN-TS] Fetching', ticker, type, expiry);
    await rateLimit(); // Prevent 429 throttling
    var optType = type === 'call' ? 'Call' : 'Put';
    // TS v3 option chains are STREAMING only — /stream/options/chains/
    var url = getTSBase() + '/marketdata/stream/options/chains/' + ticker
      + '?expiration=' + formatExpiry(expiry)
      + '&optionType=' + optType
      + '&strikeProximity=12&enableGreeks=true';
    if (price) url += '&priceCenter=' + Math.round(price);

    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    console.log('[CHAIN-TS] HTTP status:', res.status);
    if (!res.ok) {
      console.error('[CHAIN-TS] Failed:', res.status);
      return [];
    }

    // SSE stream — read chunks with timeout, don't wait for stream end
    var chain = [];
    var buffer = '';

    await new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function() {
        if (!done) { done = true; res.body.destroy(); resolve(); }
      }, 5000);

      res.body.on('data', function(chunk) {
        buffer += chunk.toString();
        // Process complete lines as they arrive
        var parts = buffer.split('\n');
        buffer = parts.pop(); // keep incomplete line in buffer
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (!line) continue;
          try {
            var obj = JSON.parse(line);
            if (obj && (obj.Legs || obj.legs || obj.Delta !== undefined || obj.Ask || obj.Bid)) {
              chain.push(obj);
            }
            // Once we have enough contracts, stop early
            if (chain.length >= 12) {
              clearTimeout(timer);
              if (!done) { done = true; res.body.destroy(); resolve(); }
            }
          } catch(e) { /* skip non-JSON lines */ }
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

    console.log('[CHAIN-TS] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + chain.length + ' contracts (stream)');
    return chain;
  } catch(e) {
    console.error('[CHAIN-TS] Error:', e.message);
    return [];
  }
}

// -- PUBLIC.COM TOKEN EXCHANGE ------------------------------------
// Public.com auth is 2-step: long-lived secret -> short-lived accessToken.
// Prior version sent the secret directly as Bearer, which the API rejects
// with 401 every time. Exchange + cache the accessToken here.
var _pubAccessToken = null;
var _pubTokenExpiresAt = 0;
async function getPublicAccessToken() {
  var now = Date.now();
  if (_pubAccessToken && now < _pubTokenExpiresAt - 60000) return _pubAccessToken;
  var secret = process.env.PUBLIC_API_KEY;
  if (!secret) return null;
  try {
    var validityMinutes = 60;
    var res = await fetch('https://api.public.com/userapiauthservice/personal/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ validityInMinutes: validityMinutes, secret: secret }),
    });
    console.log('[PUB-AUTH] Token exchange HTTP:', res.status);
    if (!res.ok) { console.error('[PUB-AUTH] Exchange failed:', res.status); return null; }
    var data = await res.json();
    var tok = data.accessToken || data.access_token || null;
    if (!tok) { console.error('[PUB-AUTH] No accessToken in response'); return null; }
    _pubAccessToken = tok;
    _pubTokenExpiresAt = now + (validityMinutes * 60 * 1000);
    console.log('[PUB-AUTH] Exchanged secret -> accessToken (cached ' + validityMinutes + 'm)');
    return tok;
  } catch(e) {
    console.error('[PUB-AUTH] Exchange error:', e.message);
    return null;
  }
}

// -- GET OPTION CHAIN: PUBLIC.COM (source 2) ----------------------
async function getChainPublic(ticker, expiry, type, price) {
  try {
    console.log('[CHAIN-PUB] Fetching', ticker, type, expiry);
    var accessToken = await getPublicAccessToken();
    if (!accessToken) { console.log('[CHAIN-PUB] No access token'); return []; }

    // Public.com options chain -- POST with JSON body per API docs
    var url = 'https://api.public.com/userapigateway/marketdata/' + (process.env.PUBLIC_ACCOUNT_ID || '5OF64813') + '/option-chain';
    var body = JSON.stringify({
      instrument: { symbol: ticker, type: 'EQUITY' },
      expirationDate: expiry
    });

    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: body
    });
    console.log('[CHAIN-PUB] HTTP status:', res.status);
    if (!res.ok) { console.log('[CHAIN-PUB] Failed:', res.status); return []; }

    var data = await res.json();
    var contracts = data.contracts || data.options || data.results || data || [];
    if (!Array.isArray(contracts)) {
      // Diagnostic: dump top-level keys + first 300 chars so we can fix the normalizer.
      var keys = (data && typeof data === 'object') ? Object.keys(data).join(',') : typeof data;
      var sample = JSON.stringify(data).slice(0, 300);
      console.log('[CHAIN-PUB] Unexpected format. keys=' + keys + ' sample=' + sample);
      return [];
    }

    // Normalize to TS format
    var normalized = contracts.map(function(c) {
      var bid = parseFloat(c.bid || c.bid_price || 0);
      var ask = parseFloat(c.ask || c.ask_price || 0);
      var mid = (bid + ask) / 2;
      var strike = parseFloat(c.strike || c.strike_price || 0);
      var sym = ticker + ' ' + expiry.replace(/-/g,'').slice(2) + (type==='call'?'C':'P') + strike;
      return {
        Bid: bid, Ask: ask, Mid: mid,
        Volume: parseInt(c.volume || 0),
        DailyOpenInterest: parseInt(c.open_interest || c.openInterest || 0),
        Delta: parseFloat(c.greeks && c.greeks.delta || c.delta || 0),
        Theta: parseFloat(c.greeks && c.greeks.theta || c.theta || 0),
        ImpliedVolatility: parseFloat(c.implied_volatility || c.iv || 0),
        ProbabilityITM: parseFloat(c.probability_itm || 0),
        Legs: [{ Symbol: sym, StrikePrice: String(strike) }],
        _source: 'public'
      };
    }).filter(function(c){ return c.Bid > 0 || c.Ask > 0; });

    console.log('[CHAIN-PUB] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + normalized.length + ' contracts');
    return normalized;
  } catch(e) { console.error('[CHAIN-PUB] Error:', e.message); return []; }
}

// -- GET OPTION CHAIN: POLYGON (source 3) -------------------------
async function getChainPolygon(ticker, expiry, type, price) {
  try {
    console.log('[CHAIN-POL] Fetching', ticker, type, expiry);
    var apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) { console.log('[CHAIN-POL] No POLYGON_API_KEY'); return []; }

    var optType = type === 'call' ? 'call' : 'put';
    var url = 'https://api.polygon.io/v3/snapshot/options/' + ticker
      + '?expiration_date=' + expiry
      + '&contract_type=' + optType
      + '&limit=25'
      + '&apiKey=' + apiKey;
    if (price) url += '&strike_price_gte=' + Math.round(price*0.9) + '&strike_price_lte=' + Math.round(price*1.1);

    var res  = await fetch(url);
    console.log('[CHAIN-POL] HTTP status:', res.status);
    if (!res.ok) { console.log('[CHAIN-POL] Failed:', res.status); return []; }

    var data = await res.json();
    var results = data.results || [];

    // Normalize to TS format
    var normalized = results.map(function(r) {
      var d = r.details || {};
      var q = r.day || {};
      var g = r.greeks || {};
      var bid = parseFloat(r.last_quote && r.last_quote.bid || 0);
      var ask = parseFloat(r.last_quote && r.last_quote.ask || 0);
      var mid = parseFloat(r.last_trade && r.last_trade.price || (bid+ask)/2);
      var strike = parseFloat(d.strike_price || 0);
      var sym = ticker + ' ' + expiry.replace(/-/g,'').slice(2) + (type==='call'?'C':'P') + strike;
      return {
        Bid: bid, Ask: ask, Mid: mid,
        Volume: parseInt(q.volume || r.open_interest || 0),
        DailyOpenInterest: parseInt(r.open_interest || 0),
        Delta: parseFloat(g.delta || 0),
        Theta: parseFloat(g.theta || 0),
        ImpliedVolatility: parseFloat(r.implied_volatility || 0),
        ProbabilityITM: Math.abs(parseFloat(g.delta || 0)),
        Legs: [{ Symbol: sym, StrikePrice: String(strike) }],
        _source: 'polygon'
      };
    }).filter(function(c){ return c.Bid > 0 || c.Ask > 0; });

    console.log('[CHAIN-POL] ' + ticker + ' ' + type + ' ' + expiry + ' - ' + normalized.length + ' contracts');
    return normalized;
  } catch(e) { console.error('[CHAIN-POL] Error:', e.message); return []; }
}

// -- GET OPTION CHAIN WITH FALLBACK HIERARCHY ---------------------
async function getOptionChain(ticker, expiry, type, price, token) {
  // Source 1: TradeStation
  var chain = await getChainTS(ticker, expiry, type, price, token);
  if (chain.length > 0) return chain;

  // Source 2: Public.com
  console.log('[CHAIN] TS failed -- trying Public.com...');
  chain = await getChainPublic(ticker, expiry, type, price);
  if (chain.length > 0) return chain;

  // Source 3: Polygon
  console.log('[CHAIN] Public failed -- trying Polygon...');
  chain = await getChainPolygon(ticker, expiry, type, price);
  if (chain.length > 0) return chain;

  console.error('[CHAIN] All sources failed for', ticker, expiry, type);
  return [];
}

// -- PARSE CONTRACT -----------------------------------------------
function parseContract(c, expiry, type) {
  try {
    var legs=c.Legs||c.legs||[], leg=legs[0]||{};
    var symbol=leg.Symbol||leg.symbol||'';
    var strike=parseFloat(leg.StrikePrice||leg.strikePrice||0);
    var bid=parseFloat(c.Bid||c.bid||0), ask=parseFloat(c.Ask||c.ask||0);
    var mid=parseFloat(c.Mid||c.mid||((bid+ask)/2));
    if (!symbol||strike<=0||mid<=0) return null;
    if (ask>0) {
      var sp=(ask-bid)/ask;
      var thresh=ask<0.50?0.40:ask<1.50?0.30:0.25;
      if (sp>thresh) return null;
    }
    return { symbol, strike, bid, ask, mid,
      volume:parseInt(c.Volume||c.volume||0), openInterest:parseInt(c.DailyOpenInterest||0),
      delta:parseFloat(c.Delta||c.delta||0), theta:parseFloat(c.Theta||c.theta||0),
      iv:parseFloat(c.ImpliedVolatility||0), probITM:parseFloat(c.ProbabilityITM||0),
      expiry, type, source:c._source||'ts',
      high:parseFloat(c.High||0), low:parseFloat(c.Low||0), open:parseFloat(c.Open||0) };
  } catch(e) { return null; }
}

// -- ENTRY MODE ---------------------------------------------------
function getEntryMode(confluence, strategy) {
  var score=parseInt(String(confluence||'0').split('/')[0])||0;
  var isORB=(strategy||'').toUpperCase().includes('ORB')||(strategy||'').toUpperCase().includes('3-2-2');
  return (score>=5||isORB) ? 'BREAKOUT' : 'RETRACEMENT';
}

// -- SELECT BEST CONTRACT -----------------------------------------
function selectBestContract(contracts, price, config, lvls, type) {
  if (!contracts||!contracts.length) return null;

  // Phase 4.19 — HARD LIQUIDITY FLOOR. May 5 META 5/13 $612.5C handed AB
  // 55 vol / 97 OI (dead). Now we filter at the gate.
  var minVol = (config && config.minVol) || 50;
  var minOI  = (config && config.minOI) || 50;

  // Stage 1: full filter (premium band + delta floor + LIQUIDITY)
  var candidates=contracts.filter(function(c){
    if (!c || c.mid<config.minPremium || c.mid>config.maxPremium) return false;
    if (Math.abs(c.delta) < 0.15) return false;
    // Liquidity gate: vol OR OI must clear (one or the other — both ideal)
    var liqOK = (c.volume >= minVol) || (c.openInterest >= minOI);
    return liqOK;
  });

  // Stage 2: drop delta floor but KEEP liquidity floor
  if (!candidates.length) {
    console.log('[SELECT] Stage 1 empty -- relaxing delta floor (keeping liquidity)');
    candidates=contracts.filter(function(c){
      if (!c || c.mid<config.minPremium || c.mid>config.maxPremium) return false;
      return (c.volume >= minVol) || (c.openInterest >= minOI);
    });
  }

  // Stage 3: REJECT if no liquid candidates — caller will retry next expiry
  if (!candidates.length) {
    var sample = contracts.slice(0,5).map(function(c){
      return c ? c.strike+'/$'+c.mid+'/v'+c.volume+'/oi'+c.openInterest : 'null';
    }).join(', ');
    console.error('[SELECT] LIQUIDITY REJECT — no contract meets vol≥'+minVol+' OR OI≥'+minOI+'. Sample: '+sample);
    return { _liquidityReject: true, sample: sample };  // signal caller to retry next expiry
  }

  var scored=candidates.map(function(c){
    var score=0, abs=Math.abs(c.delta), dist=Math.abs(c.strike-price)/price;
    if (abs>=0.35&&abs<=0.55) score+=3; else if (abs>=0.25) score+=1;
    if (dist<0.01) score+=3; else if (dist<0.03) score+=2; else if (dist<0.05) score+=1;
    if (c.volume>1000) score+=2; else if (c.volume>500) score+=1;
    if (c.openInterest>5000) score+=2; else if (c.openInterest>1000) score+=1;
    if (c.ask>0){var sp=(c.ask-c.bid)/c.ask; if(sp<0.05)score+=2; else if(sp<0.10)score+=1;}
    if (lvls) {
      if (type==='call'&&Math.abs(c.strike-lvls.pdh)/lvls.pdh<0.02) score+=2;
      if (type==='put' &&Math.abs(c.strike-lvls.pdl)/lvls.pdl<0.02) score+=2;
    }
    return {contract:c, score};
  });
  scored.sort(function(a,b){return b.score-a.score;});
  var best=scored[0].contract;
  console.log('[SELECT] '+best.symbol+' strike:$'+best.strike+' mid:$'+best.mid+' delta:'+best.delta.toFixed(2)+' vol:'+best.volume+' oi:'+best.openInterest+' score:'+scored[0].score+' source:'+best.source);
  return best;
}

function calcDTE(dateStr) {
  if (!dateStr) return 0;
  // Use market close 4PM ET -- DST-aware (EDT=-04:00, EST=-05:00)
  var expClose = new Date(dateStr + 'T16:00:00');
  var etNowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  var etNow = new Date(etNowStr);
  return Math.max(0, Math.ceil((expClose - etNow) / (1000 * 60 * 60 * 24)));
}

function getTimeContext() {
  var now=new Date();
  var _etCR=now.toLocaleString('en-US',{timeZone:'America/New_York',hour12:false});
  var _etCRp=(_etCR.split(', ')[1]||_etCR).split(':');
  var etH=parseInt(_etCRp[0],10), etM=parseInt(_etCRp[1],10), t=etH*60+etM;
  if (t<9*60+30)  return {window:'PREMARKET',ok:false};
  if (t<9*60+45)  return {window:'EARLY',ok:false};
  if (t>=15*60+30) return {window:'LATE',ok:false};
  if (t>=16*60)   return {window:'CLOSED',ok:false};
  return {window:'OPEN',ok:true};
}

// -- RESOLVE CONTRACT (MAIN) --------------------------------------
async function resolveContract(ticker, type, tradeType, signalMeta) {
  type=(type||'call').toLowerCase();
  tradeType=(tradeType||'SWING').toUpperCase();
  signalMeta=signalMeta||{};
  // Fixed May 4 2026: previously hardcoded to DAY|SWING which broke LOTTO mode
  // added to fix lotto FIRE button bug.
  var mode = MODES[tradeType] ? tradeType
           : tradeType.includes('DAY') ? 'DAY'
           : tradeType.includes('LOTTO') ? 'LOTTO'
           : 'SWING';
  var config=Object.assign({}, MODES[mode]); // copy so we can adjust per-ticker
  // HIGH-PRICED STOCKS: raise premium cap, force 1 contract
  if (HIGH_PRICE_TICKERS.has(ticker.toUpperCase())) {
    config.maxPremium = HIGH_PRICE_MAX_PREMIUM;
    console.log('[RESOLVE] High-price ticker '+ticker+' -- maxPremium raised to $'+HIGH_PRICE_MAX_PREMIUM);
  }
  // MAY 6 2026 PM — DIVIDEND/BLUE-CHIP names with high ATM time value
  // (AB hit this on KO call: ATM strikes $9-11 mid blocked by $5 default cap)
  if (DIVIDEND_HIGH_TIME_VALUE_TICKERS.has(ticker.toUpperCase())) {
    config.maxPremium = Math.max(config.maxPremium, DIVIDEND_MAX_PREMIUM);
    console.log('[RESOLVE] Dividend/blue-chip ticker '+ticker+' -- maxPremium raised to $'+config.maxPremium);
  }
  console.log('[RESOLVE] '+ticker+' '+type+' '+mode);

  var token=await getTSToken();
  if (!token) { console.error('[RESOLVE] No TS token -- aborting'); return { ok:false, stage:'auth', reason:'TS access token unavailable (auth failed)' }; }
  console.log('[RESOLVE] Token OK');

  var price=await getPrice(ticker, token);
  if (!price) { console.error('[RESOLVE] No price for',ticker); return { ok:false, stage:'price', reason:'TS quote API returned no price for ' + ticker }; }

  var lvls=await getLVLs(ticker, token);
  if (!lvls) console.log('[RESOLVE] No LVL data -- continuing without LVL filter');

  var entryMode=getEntryMode(signalMeta.confluence, signalMeta.strategy);
  console.log('[ENTRY MODE] '+entryMode+' | confluence:'+(signalMeta.confluence||'N/A'));

  if (lvls) {
    if (type==='call') {
      var dPDH=(price-lvls.pdh)/lvls.pdh;
      console.log('[LVL] CALL | Price:$'+price+' PDH:$'+lvls.pdh+' dist:'+(dPDH*100).toFixed(1)+'%');
      if (dPDH<-0.03&&entryMode==='BREAKOUT') {
        var r='Price $'+price+' is '+(Math.abs(dPDH)*100).toFixed(1)+'% below PDH $'+lvls.pdh;
        console.log('[LVL] BLOCKED --',r); return {blocked:true,reason:r,lvls};
      }
    } else {
      var dPDL=(lvls.pdl-price)/lvls.pdl;
      console.log('[LVL] PUT | Price:$'+price+' PDL:$'+lvls.pdl+' dist:'+(dPDL*100).toFixed(1)+'%');
      if (dPDL<-0.03&&entryMode==='BREAKOUT') {
        var r2='Price $'+price+' is above PDL $'+lvls.pdl;
        console.log('[LVL] BLOCKED --',r2); return {blocked:true,reason:r2,lvls};
      }
    }
  }

  var expirations=await getExpirations(ticker, token);
  if (!expirations.length) { console.error('[RESOLVE] No expirations for',ticker); return { ok:false, stage:'expirations', reason:'TS option expirations API returned 0 dates for ' + ticker + ' (likely no listed options)' }; }

  var expiryObj=selectExpiry(expirations, mode);
  if (!expiryObj) { console.error('[RESOLVE] No expiry found'); return { ok:false, stage:'expirySelect', reason:'No expiration matched ' + mode + ' DTE band (' + config.minDTE + '-' + config.maxDTE + '). Available: ' + expirations.slice(0,5).map(function(e){return e.date+'/'+e.dte+'DTE';}).join(', ') }; }

  var expiry=expiryObj.date, dte=expiryObj.dte;
  var rawChain=await getOptionChain(ticker, expiry, type, price, token);

  if (!rawChain.length) {
    var remaining=expirations.filter(function(e){ return e.date > expiry && e.dte >= config.minDTE; });
    for (var i=0; i<Math.min(remaining.length,3); i++) {
      console.log('[RESOLVE] Retrying expiry', remaining[i].date+'('+remaining[i].dte+'DTE)');
      expiry  = remaining[i].date;
      dte     = remaining[i].dte;
      rawChain = await getOptionChain(ticker, expiry, type, price, token);
      if (rawChain.length) break;
    }
  }

  if (!rawChain.length) { console.error('[RESOLVE] No chain found for',ticker,type,'expiry:',expiry); return { ok:false, stage:'chain', reason:'TS option chain API returned 0 contracts for ' + ticker + ' ' + type + ' ' + expiry }; }

  var contracts=rawChain.map(function(c){return parseContract(c,expiry,type);}).filter(Boolean);
  console.log('[RESOLVE] Parsed contracts:',contracts.length,'maxPremium:$'+config.maxPremium);
  if (contracts.length) {
    var mids=contracts.slice(0,5).map(function(c){return '$'+c.mid.toFixed(2);}).join(', ');
    console.log('[RESOLVE] First 5 mids:',mids);
  }
  if (!contracts.length) { console.error('[RESOLVE] No parseable contracts from',rawChain.length,'raw'); return { ok:false, stage:'parse', reason:'parseContract dropped all ' + rawChain.length + ' raw contracts (missing mid/strike/delta?)' }; }

  var best=selectBestContract(contracts, price, config, lvls, type);

  // Phase 4.19 — if selectBestContract rejects on liquidity, retry with NEXT
  // expiry that's also a standard (Fri) expiry. Example: META 5/13 (Tue) had
  // 55 vol / 97 OI on $612.5C — auto-roll to 5/15 (Fri) which has way more flow.
  if (best && best._liquidityReject) {
    var rejectedExpiry = expiry;
    var nextStandard = expirations.filter(function(e){
      return e.date > rejectedExpiry && e.dte >= config.minDTE && e.dte <= config.maxDTE * 1.5
        && (mode === 'DAY' ? true : isStandardExpiry(e.date));
    });
    for (var k=0; k<Math.min(nextStandard.length, 3); k++) {
      console.log('[RESOLVE] LIQUIDITY ROLL -- retrying', nextStandard[k].date+'('+nextStandard[k].dte+'DTE)');
      var newRaw = await getOptionChain(ticker, nextStandard[k].date, type, price, token);
      if (!newRaw.length) continue;
      var newContracts = newRaw.map(function(c){ return parseContract(c, nextStandard[k].date, type); }).filter(Boolean);
      if (!newContracts.length) continue;
      var attempt = selectBestContract(newContracts, price, config, lvls, type);
      if (attempt && !attempt._liquidityReject) {
        console.log('[RESOLVE] LIQUIDITY ROLL SUCCESS at', nextStandard[k].date);
        best = attempt;
        expiry = nextStandard[k].date;
        dte = nextStandard[k].dte;
        contracts = newContracts;
        break;
      }
    }
    // Still rejected after all retries — fail with explicit reason
    if (best && best._liquidityReject) {
      return { ok:false, stage:'liquidity', reason:'No expiry within DTE band has a contract meeting vol≥'+(config.minVol||50)+' OR OI≥'+(config.minOI||50)+' in the $'+config.minPremium+'-$'+config.maxPremium+' premium band. Tried '+(rejectedExpiry+', then '+nextStandard.slice(0,3).map(function(e){return e.date;}).join(', '))+'. Sample: '+best.sample };
    }
  }

  if (!best) {
    var midSample = contracts.slice(0,8).map(function(c){return '$'+c.mid.toFixed(2)+'(d'+(c.delta?c.delta.toFixed(2):'?')+')';}).join(', ');
    console.error('[RESOLVE] No contract passed selection -- maxPremium:$'+config.maxPremium+' contracts checked:',contracts.length);
    return { ok:false, stage:'select', reason:'All ' + contracts.length + ' contracts filtered out by ' + mode + ' band ($' + config.minPremium + '-$' + config.maxPremium + ' premium, |delta|>=0.15). Sample mids: ' + midSample };
  }

  var t1Pct=getT1Target(ticker), stopPct=config.stopPct;
  var entryPrice=entryMode==='BREAKOUT'?best.ask:parseFloat((best.ask*0.875).toFixed(2));
  var underlyingStop=null, optionStopPct=stopPct;

  if (lvls) {
    underlyingStop=type==='call'?lvls.callStop:lvls.putStop;
    var dist=Math.abs(price-underlyingStop);
    var estLoss=dist*Math.abs(best.delta);
    optionStopPct=Math.min(0.50,Math.max(0.20,estLoss/best.mid));
    console.log('[DYNAMIC STOP] dist:$'+dist.toFixed(2)+' delta:'+best.delta.toFixed(2)+' estLoss:$'+estLoss.toFixed(2)+' stopPct:'+(optionStopPct*100).toFixed(0)+'%');
  }

  var optionStop=parseFloat((best.mid*(1-optionStopPct)).toFixed(2));
  var t1Price=parseFloat((best.mid*(1+t1Pct)).toFixed(2));
  // Default resolver qty (2 cheap, 1 expensive). Alerter overrides this for
  // Stratum A+/A++ via Bill-Paying sizing ladder — see alerter.js.
  var qty=best.mid<=1.50?2:1;
  var timeCtx=getTimeContext();

  console.log('[OPRA] '+ticker+' '+best.symbol+' $'+best.strike+' mid:$'+best.mid+' '+dte+'DTE entry:'+entryMode+' T1:+'+(t1Pct*100).toFixed(0)+'% source:'+best.source);

  return {
    symbol:best.symbol, mid:best.mid, bid:best.bid, ask:best.ask,
    strike:best.strike, expiry, mode, dte, price,
    delta:best.delta, theta:best.theta, iv:best.iv,
    probITM:Math.round(best.probITM*100),
    volume:best.volume, openInterest:best.openInterest,
    lvls, underlyingStop, entryMode, entryPrice,
    optionStop, optionStopPct:Math.round(optionStopPct*100),
    t1Price, t1Pct:Math.round(t1Pct*100),
    qty, timeCtx, wideSpread:(best.ask-best.bid)/best.ask>0.15,
    source:best.source,
  };
}

// -- RESOLVE WITH SPECIFIC EXPIRY ---------------------------------
async function resolveContractWithExpiry(ticker, type, expiry) {
  try {
    var token=await getTSToken();
    if (!token) return null;
    var price=await getPrice(ticker, token);
    if (!price) return null;
    var rawChain=await getOptionChain(ticker, expiry, type, price, token);
    if (!rawChain.length) return null;
    var contracts=rawChain.map(function(c){return parseContract(c,expiry,type);}).filter(Boolean);
    if (!contracts.length) return null;
    var best=selectBestContract(contracts, price, MODES.SWING, null, type);
    if (!best) return null;
    return { symbol:best.symbol, mid:best.mid, bid:best.bid, ask:best.ask,
      strike:best.strike, expiry, mode:'SWING', dte:calcDTE(expiry),
      price, delta:best.delta, probITM:Math.round(best.probITM*100), source:best.source };
  } catch(e) { console.error('[RESOLVE EXPIRY] Error:',e.message); return null; }
}

// -- PARSE OPRA ---------------------------------------------------
function parseOPRA(opraSymbol) {
  try {
    var raw=(opraSymbol||'').trim().replace(/^O:/,'');
    var tsMatch=raw.match(/^([A-Z]+)\s+(\d{6})([CP])(\d+(?:\.\d+)?)$/);
    if (tsMatch) {
      var ds=tsMatch[2];
      return { ticker:tsMatch[1], expiry:'20'+ds.slice(0,2)+'-'+ds.slice(2,4)+'-'+ds.slice(4,6),
        type:tsMatch[3]==='C'?'call':'put', strike:parseFloat(tsMatch[4]), symbol:raw };
    }
    var opraMatch=raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (opraMatch) {
      var ds2=opraMatch[2], whole=parseInt(opraMatch[4].slice(0,5),10), dec=parseInt(opraMatch[4].slice(5),10);
      var strike=dec===0?whole:parseFloat(whole+'.'+String(dec).replace(/0+$/,''));
      return { ticker:opraMatch[1], expiry:'20'+ds2.slice(0,2)+'-'+ds2.slice(2,4)+'-'+ds2.slice(4,6),
        type:opraMatch[3]==='C'?'call':'put', strike, symbol:opraMatch[1]+' '+ds2+opraMatch[3]+strike };
    }
    return null;
  } catch(e) { return null; }
}

// -- POSITION SIZING ----------------------------------------------
function calculatePositionSize(premium, mode, accountSize) {
  if (!mode) mode='SWING'; if (!accountSize) accountSize=6400;
  var config=MODES[mode]||MODES.SWING;
  if (!premium||premium<=0) return {viable:false,reason:'No premium'};
  if (premium>MAX_PREMIUM)  return {viable:false,reason:'Over $2.40 max'};
  if (premium<config.minPremium) return {viable:false,reason:'Under min'};
  var contracts=premium<=1.20?2:1;
  var stopPrice=parseFloat((premium*(1-config.stopPct)).toFixed(2));
  var t1Price=parseFloat((premium*(1+config.t1Pct)).toFixed(2));
  var stopLoss=parseFloat((premium*config.stopPct*100*contracts).toFixed(0));
  var t1Profit=parseFloat(((t1Price-premium)*100*contracts).toFixed(0));
  var totalCost=parseFloat((premium*100*contracts).toFixed(0));
  var riskPct=parseFloat((stopLoss/accountSize*100).toFixed(1));
  // RISK:REWARD GATE -- NEVER risk more than reward
  var riskRewardRatio = t1Profit > 0 ? parseFloat((t1Profit / stopLoss).toFixed(2)) : 0;
  if (riskRewardRatio < 1.0) {
    console.log('[SIZING] REJECTED -- R:R ' + riskRewardRatio + ':1 (need 1.0+ minimum). Risk:$' + stopLoss + ' Reward:$' + t1Profit);
    return {viable:false,reason:'Bad R:R ' + riskRewardRatio + ':1 -- risk $' + stopLoss + ' for only $' + t1Profit + ' reward'};
  }
  return {viable:true,mode,contracts,premium,totalCost,stopPrice,t1Price,stopLoss,t1Profit,riskPct,riskRewardRatio};
}

// -- GET OPTION SNAPSHOT ------------------------------------------
async function getOptionSnapshot(tsSymbol) {
  try {
    var token=await getTSToken();
    if (!token) return null;
    var res=await fetch(getTSBase()+'/marketdata/quotes/'+encodeURIComponent(tsSymbol),
      { headers:{'Authorization':'Bearer '+token} });
    var data=await res.json();
    var quotes=data.Quotes||data.quotes||(Array.isArray(data)?data:[data]);
    var q=quotes[0]; if (!q) return null;
    return { symbol:tsSymbol, bid:parseFloat(q.Bid||0), ask:parseFloat(q.Ask||0),
      mid:parseFloat(q.Last||((parseFloat(q.Bid||0)+parseFloat(q.Ask||0))/2)),
      volume:parseInt(q.Volume||0), openInterest:parseInt(q.DailyOpenInterest||0) };
  } catch(e) { return null; }
}

module.exports = {
  parseOPRA, resolveContract, resolveContractWithExpiry,
  getOptionSnapshot, getPrice, getLVLs, getEntryMode,
  calculatePositionSize, getTimeContext, getT1Target,
  getTSToken,
  WATCHLIST, MIN_PREMIUM, MAX_PREMIUM, MODES,
};
