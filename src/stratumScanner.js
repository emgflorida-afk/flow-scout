// stratumScanner.js -- Strat dashboard scanner (Primo-style table)
// -----------------------------------------------------------------
// Scans a large watchlist on the Daily timeframe and classifies the
// last 3 bars (1 / 2U / 2D / 3), detects actionable signals, computes
// ATR%, volume ratio, and multi-timeframe continuity arrows (D/W/M/Q).
//
// Exposes:
//   scan(opts?) -> { generatedAt, asOf, groups: { [signal]: [row...] } }
// Each row matches the columns in the screenshot:
//   ticker, price, chgPct, atrPct, signal, combo[], dwmq, volAbs, volRel,
//   earnings, ftfc
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var ts = null;
try { ts = require('./tradestation'); } catch(e) {}
var calendar = null;
try { calendar = require('./economicCalendar'); } catch(e) {}
var bullflow = null;
try { bullflow = require('./bullflowStream'); } catch(e) {}

// -----------------------------------------------------------------
// FINNHUB ENRICHMENT -- analyst recommendations + news sentiment
// -----------------------------------------------------------------
function finnhubKey() { return process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY || ''; }

var _finnhubCache = {}; // ticker -> { data, ts }
var FINNHUB_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getFinnhubData(ticker) {
  var key = finnhubKey();
  if (!key) return null;
  var cached = _finnhubCache[ticker];
  if (cached && (Date.now() - cached.ts) < FINNHUB_TTL_MS) return cached.data;
  try {
    var base = 'https://finnhub.io/api/v1';
    var recRes = await fetch(base + '/stock/recommendation?symbol=' + ticker + '&token=' + key);
    var targetRes = await fetch(base + '/stock/price-target?symbol=' + ticker + '&token=' + key);
    var rec = await recRes.json().catch(function(){return[];});
    var target = await targetRes.json().catch(function(){return{};});
    var latest = Array.isArray(rec) && rec.length ? rec[0] : null;
    var data = {
      rec: latest ? {
        buy: (latest.strongBuy || 0) + (latest.buy || 0),
        hold: latest.hold || 0,
        sell: (latest.sell || 0) + (latest.strongSell || 0),
      } : null,
      target: target && target.targetMean ? target.targetMean : null,
    };
    _finnhubCache[ticker] = { data: data, ts: Date.now() };
    return data;
  } catch(e) { return null; }
}

function recToLabel(rec) {
  if (!rec) return null;
  var total = rec.buy + rec.hold + rec.sell;
  if (!total) return null;
  if (rec.buy / total >= 0.6) return 'BUY';
  if (rec.sell / total >= 0.5) return 'SELL';
  return 'HOLD';
}

// -----------------------------------------------------------------
// BULLFLOW ENRICHMENT -- aggregate recent flow per ticker
// -----------------------------------------------------------------
function getFlowForTicker(ticker) {
  if (!bullflow || !bullflow.getRecentFlow) return null;
  try {
    var recent = bullflow.getRecentFlow({ symbol: ticker }) || [];
    if (!recent.length) return null;
    var callPrem = 0, putPrem = 0, callCount = 0, putCount = 0;
    recent.forEach(function(a) {
      var p = parseFloat(a.premium || 0);
      if (a.callPut === 'CALL') { callPrem += p; callCount++; }
      else if (a.callPut === 'PUT') { putPrem += p; putCount++; }
    });
    var net = callPrem - putPrem;
    var total = callPrem + putPrem;
    if (!total) return null;
    var dominant = total > 0 ? (callPrem / total >= 0.6 ? 'BULL' : (putPrem / total >= 0.6 ? 'BEAR' : 'MIXED')) : 'NONE';
    return {
      callPrem: callPrem,
      putPrem: putPrem,
      callCount: callCount,
      putCount: putCount,
      net: net,
      dominant: dominant,
      total: total,
    };
  } catch(e) { return null; }
}

// -----------------------------------------------------------------
// TRADINGVIEW ALERT RECEIVER -- in-memory store, 4hr TTL
// Wire to /api/tv-alert in server.js
// -----------------------------------------------------------------
var _tvAlerts = {};  // ticker -> [{ message, tf, action, time }]
var TV_TTL_MS = 4 * 60 * 60 * 1000;

function ingestTVAlert(payload) {
  if (!payload) return { ok: false, reason: 'no payload' };
  var ticker = (payload.ticker || payload.symbol || '').toUpperCase();
  if (!ticker) return { ok: false, reason: 'no ticker' };
  _tvAlerts[ticker] = _tvAlerts[ticker] || [];
  _tvAlerts[ticker].push({
    message:   payload.message || payload.alert || '',
    tf:        payload.timeframe || payload.tf || '',
    action:    payload.action || payload.direction || '',
    price:     parseFloat(payload.price || 0) || null,
    time:      Date.now(),
  });
  // Prune old
  var cutoff = Date.now() - TV_TTL_MS;
  _tvAlerts[ticker] = _tvAlerts[ticker].filter(function(a) { return a.time > cutoff; });
  return { ok: true, ticker: ticker, count: _tvAlerts[ticker].length };
}

function getTVAlertsFor(ticker) {
  var list = _tvAlerts[ticker];
  if (!list) return null;
  var cutoff = Date.now() - TV_TTL_MS;
  list = list.filter(function(a) { return a.time > cutoff; });
  _tvAlerts[ticker] = list;
  if (!list.length) return null;
  // Return most recent + count
  return {
    count: list.length,
    latest: list[list.length - 1],
  };
}

// -----------------------------------------------------------------
// WATCHLIST
// -----------------------------------------------------------------
var DEFAULT_WATCHLIST = [
  // Indices / ETFs
  'SPY','QQQ','IWM','DIA','SMH','XLF','XLE','XLV','XLK','XLP','XLY','XLU','XLB','XLI','XLRE','KRE','LABU','SOXL',
  // Mega cap tech
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','ORCL','NFLX','ADBE','CRM','AMD','INTC',
  // Growth / momentum
  'MU','MSTR','COIN','PLTR','ARM','PANW','CRWD','SNOW','WDAY','NOW','SHOP','UBER','ABNB','HOOD','SOFI','DKNG',
  'ANET','DELL','SMCI','AMAT','LRCX','KLAC','MRVL','QCOM','TSM','ASML',
  // Financials
  'JPM','BAC','GS','MS','WFC','C','BLK','SCHW','V','MA','PYPL','AXP','PNC','FITB','CB',
  // Healthcare
  'UNH','JNJ','LLY','PFE','ABBV','MRK','TMO','ABT','DHR','AMGN','REGN','BMY','GILD','CVS','HCA','CI','DXCM',
  // Consumer / industrials
  'WMT','HD','COST','NKE','MCD','SBUX','DIS','LOW','TGT','PG','KO','PEP','CL','PM','MO',
  'CAT','DE','BA','GE','LMT','RTX','NOC','GD','HON','UPS','FDX','CSX','UNP','PSX','FCX','SRE',
  // REITs / utilities
  'AMT','CCI','O','PLD','SPG','NEE','DUK','SO','AEP','XOM','CVX','COP','OXY',
  // Communications / other
  'CSCO','T','VZ','CMCSA','DIS','NFLX','ROKU','SE','SPOT',
];

function getWatchlist() {
  try { var rc = require('./runtimeConfig'); var v = rc.get('STRATUM_SCANNER_WATCHLIST'); if (v) return v.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean); } catch(e){}
  var raw = process.env.STRATUM_SCANNER_WATCHLIST;
  if (raw) return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
  // Dedup DEFAULT_WATCHLIST
  var seen = {};
  return DEFAULT_WATCHLIST.filter(function(s){ if (seen[s]) return false; seen[s] = 1; return true; });
}

// -----------------------------------------------------------------
// TRADESTATION BARS
// -----------------------------------------------------------------
async function getToken() {
  if (!ts) return null;
  try { return await ts.getAccessToken(); } catch(e) { return null; }
}

async function fetchBars(ticker, unit, interval, barsback, token) {
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker +
      '?interval=' + interval + '&unit=' + unit + '&barsback=' + barsback +
      (unit === 'Minute' ? '&sessiontemplate=Default' : '');
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) { return []; }
}

function normBar(b) {
  if (!b) return null;
  return {
    o: parseFloat(b.Open  || b.open  || 0),
    h: parseFloat(b.High  || b.high  || 0),
    l: parseFloat(b.Low   || b.low   || 0),
    c: parseFloat(b.Close || b.close || 0),
    v: parseFloat(b.TotalVolume || b.Volume || b.volume || 0),
  };
}

// -----------------------------------------------------------------
// STRAT BAR CLASSIFICATION
// -----------------------------------------------------------------
function classifyBar(bar, prev) {
  if (!bar || !prev) return null;
  var tookHigh = bar.h > prev.h;
  var tookLow  = bar.l < prev.l;
  if (tookHigh && tookLow) return '3';   // outside
  if (!tookHigh && !tookLow) return '1'; // inside
  if (tookHigh) return '2U';             // up
  return '2D';                           // down
}

// -----------------------------------------------------------------
// SIGNAL DETECTION
// Last 3 closed bars A (oldest) -> B -> C (most recent closed)
// -----------------------------------------------------------------
function detectSignal(A, B, C, aType, bType, cType) {
  if (!A || !B || !C || !aType || !bType || !cType) return null;

  // 1-1 Compression: B and C both inside
  if (bType === '1' && cType === '1') return '1-1 Compression';

  // Inside bar (single)
  if (cType === '1') return 'Inside';

  // Outside bar
  if (cType === '3') return 'Outside Bar';

  // Failed 2U: C broke prior high, reversed, closed red and below midpoint
  var midC = (C.h + C.l) / 2;
  var tookHighC = C.h > B.h;
  var tookLowC  = C.l < B.l;
  if (tookHighC && !tookLowC && C.c < C.o && C.c < midC) return 'Failed 2U';
  if (tookLowC && !tookHighC && C.c > C.o && C.c > midC) return 'Failed 2D';

  // 2-1-2 (inside reversal): A directional, B inside, C opposite directional
  if (bType === '1') {
    if (aType === '2U' && cType === '2D') return '2-1-2 Down';
    if (aType === '2D' && cType === '2U') return '2-1-2 Up';
    if (aType === '2U' && cType === '2U') return '2-1-2 Continuation';
    if (aType === '2D' && cType === '2D') return '2-1-2 Continuation';
  }

  // 3-1-2 (outside -> inside -> directional)
  if (aType === '3' && bType === '1') {
    if (cType === '2U') return '3-1-2 Up';
    if (cType === '2D') return '3-1-2 Down';
  }

  // Hammer / Shooter on closed bar
  var body = Math.abs(C.c - C.o);
  var upperWick = C.h - Math.max(C.c, C.o);
  var lowerWick = Math.min(C.c, C.o) - C.l;
  if (body > 0 && lowerWick >= 2 * body && C.c > C.o) return 'Hammer';
  if (body > 0 && upperWick >= 2 * body && C.c < C.o) return 'Shooter';

  return null;
}

// -----------------------------------------------------------------
// ATR (14-day, simple)
// -----------------------------------------------------------------
function calcATRPct(bars, closePrice) {
  if (!bars || bars.length < 15 || !closePrice) return null;
  var trs = [];
  for (var i = bars.length - 14; i < bars.length; i++) {
    var cur = bars[i];
    var prev = bars[i-1];
    if (!cur || !prev) continue;
    var tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  var atr = trs.reduce(function(a,b){return a+b;},0) / trs.length;
  return (atr / closePrice) * 100;
}

// -----------------------------------------------------------------
// VOLUME RATIO (current / 20-day avg)
// -----------------------------------------------------------------
function calcVolRatio(bars) {
  if (!bars || bars.length < 21) return null;
  var last = bars[bars.length - 1];
  if (!last || !last.v) return null;
  var sum = 0, n = 0;
  for (var i = bars.length - 21; i < bars.length - 1; i++) {
    if (bars[i] && bars[i].v) { sum += bars[i].v; n++; }
  }
  if (!n) return null;
  var avg = sum / n;
  return { abs: last.v, rel: last.v / avg };
}

// -----------------------------------------------------------------
// CONTINUITY ARROWS (D/W/M/Q)
// Each: 'up' if current price > previous-period close,
//       'down' if <, null if unknown
// -----------------------------------------------------------------
async function fetchContinuity(ticker, currentPrice, token) {
  var out = { D: null, W: null, M: null, Q: null };
  try {
    var daily = await fetchBars(ticker, 'Daily', 1, 3, token);
    var weekly = await fetchBars(ticker, 'Weekly', 1, 3, token);
    var monthly = await fetchBars(ticker, 'Monthly', 1, 3, token);
    // Quarterly: synthesize from monthly (3-month aggregate) -- approximate using 3 monthly closes
    function dirFromPrevClose(bars) {
      if (!bars || bars.length < 2) return null;
      var prev = normBar(bars[bars.length - 2]);
      if (!prev || !prev.c) return null;
      return currentPrice > prev.c ? 'up' : (currentPrice < prev.c ? 'down' : null);
    }
    out.D = dirFromPrevClose(daily);
    out.W = dirFromPrevClose(weekly);
    out.M = dirFromPrevClose(monthly);
    // Quarter approx: use close of 3 monthly bars ago
    if (monthly && monthly.length >= 4) {
      var q = normBar(monthly[monthly.length - 4]);
      if (q && q.c) out.Q = currentPrice > q.c ? 'up' : (currentPrice < q.c ? 'down' : null);
    }
  } catch(e) { /* soft */ }
  return out;
}

function isFTFC(dwmq) {
  if (!dwmq) return false;
  var vals = [dwmq.D, dwmq.W, dwmq.M, dwmq.Q].filter(function(v){ return v; });
  if (vals.length < 3) return false;
  var allUp = vals.every(function(v){ return v === 'up'; });
  var allDown = vals.every(function(v){ return v === 'down'; });
  return allUp || allDown;
}

// -----------------------------------------------------------------
// EARNINGS LOOKUP -- returns number of days until next earnings, or null
// -----------------------------------------------------------------
var _earningsCache = { data: null, fetchedAt: 0 };
async function getEarningsMap() {
  var now = Date.now();
  if (_earningsCache.data && (now - _earningsCache.fetchedAt) < 6 * 60 * 60 * 1000) {
    return _earningsCache.data;
  }
  try {
    if (!calendar || !calendar.getEarningsCalendar) { _earningsCache.data = {}; return {}; }
    var from = new Date(); var to = new Date(); to.setDate(to.getDate() + 14);
    var list = await calendar.getEarningsCalendar(from.toISOString().slice(0,10), to.toISOString().slice(0,10));
    var map = {};
    (list || []).forEach(function(e) {
      if (!e.symbol || !e.date) return;
      if (!map[e.symbol]) map[e.symbol] = e.date;
    });
    _earningsCache = { data: map, fetchedAt: now };
    return map;
  } catch(e) { return {}; }
}

function earningsBadge(dateStr) {
  if (!dateStr) return null;
  try {
    var today = new Date();
    today.setHours(0,0,0,0);
    var ed = new Date(dateStr + 'T00:00:00');
    var diff = Math.round((ed - today) / (1000 * 60 * 60 * 24));
    if (diff < 0) return null;
    if (diff === 0) return 'NOW';
    if (diff === 1) return 'TMR';
    return '+' + diff + 'd';
  } catch(e) { return null; }
}

// -----------------------------------------------------------------
// SCAN ONE TICKER
// -----------------------------------------------------------------
async function scanTicker(ticker, token, earningsMap) {
  var dailyBars = await fetchBars(ticker, 'Daily', 1, 30, token);
  if (!dailyBars || dailyBars.length < 5) return null;

  var normed = dailyBars.map(normBar).filter(Boolean);
  if (normed.length < 4) return null;

  var last = normed[normed.length - 1];
  var prev = normed[normed.length - 2];

  // Classify last 3 bars (A, B, C) where C is most-recent CLOSED bar
  // Using today's (forming) bar requires intraday data, so we classify against close-of-day;
  // during market hours the "C" bar will be the forming daily bar (still useful).
  var C = normed[normed.length - 1];
  var B = normed[normed.length - 2];
  var A = normed[normed.length - 3];
  var Bprev = normed[normed.length - 3];
  var Aprev = normed[normed.length - 4];

  var cType = classifyBar(C, B);
  var bType = classifyBar(B, Bprev);
  var aType = classifyBar(A, Aprev);

  var signal = detectSignal(A, B, C, aType, bType, cType);

  var price = last.c;
  var chgPct = prev && prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
  var atrPct = calcATRPct(normed, last.c);
  var vol = calcVolRatio(normed);

  var dwmq = await fetchContinuity(ticker, price, token);
  var ftfc = isFTFC(dwmq);

  var badge = earningsBadge(earningsMap[ticker]);

  // Enrich: Bullflow + Finnhub + TradingView alerts (all non-blocking)
  var flow = getFlowForTicker(ticker);
  var tvAlerts = getTVAlertsFor(ticker);
  var finn = null;
  try { finn = await getFinnhubData(ticker); } catch(e) {}

  var analyst = finn && finn.rec ? recToLabel(finn.rec) : null;
  var priceTargetPct = null;
  if (finn && finn.target && price) {
    priceTargetPct = ((finn.target - price) / price) * 100;
  }

  return {
    ticker: ticker,
    price: price,
    chgPct: chgPct,
    atrPct: atrPct,
    signal: signal,
    combo: [aType, bType, cType],
    dwmq: dwmq,
    ftfc: ftfc,
    volAbs: vol ? vol.abs : null,
    volRel: vol ? vol.rel : null,
    earnings: badge,
    // Enrichments:
    flow: flow,                       // { callPrem, putPrem, dominant, total }
    analyst: analyst,                 // 'BUY' | 'HOLD' | 'SELL'
    priceTargetPct: priceTargetPct,   // % upside to analyst mean target
    tvAlert: tvAlerts,                // { count, latest } or null
  };
}

// -----------------------------------------------------------------
// FULL SCAN (with concurrency)
// -----------------------------------------------------------------
var _running = false;
var _lastScan = null;

async function scan(opts) {
  opts = opts || {};
  var concurrency = opts.concurrency || 6;
  if (_running && !opts.force) return _lastScan;
  _running = true;
  var startedAt = Date.now();

  try {
    var token = await getToken();
    if (!token) {
      _running = false;
      return { error: 'no TS token', generatedAt: new Date().toISOString(), groups: {} };
    }

    var earningsMap = await getEarningsMap();
    var tickers = getWatchlist();
    var rows = [];
    var idx = 0;

    async function worker() {
      while (idx < tickers.length) {
        var myIdx = idx++;
        var t = tickers[myIdx];
        try {
          var row = await scanTicker(t, token, earningsMap);
          if (row && row.signal) rows.push(row);
        } catch(e) { /* skip bad ticker */ }
      }
    }
    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    // Group by signal -- priority order matters for display
    var priority = [
      'Failed 2U', 'Failed 2D',
      '2-1-2 Up', '2-1-2 Down', '2-1-2 Continuation',
      '3-1-2 Up', '3-1-2 Down',
      'Outside Bar',
      'Hammer', 'Shooter',
      '1-1 Compression',
      'Inside',
    ];
    var groups = {};
    priority.forEach(function(k){ groups[k] = []; });
    rows.forEach(function(r){
      if (!groups[r.signal]) groups[r.signal] = [];
      groups[r.signal].push(r);
    });
    // Signal -> preferred direction (for flow-alignment scoring)
    function signalDir(sig) {
      if (!sig) return null;
      if (sig === 'Failed 2U' || sig === '2-1-2 Down' || sig === '3-1-2 Down' || sig === 'Shooter') return 'BEAR';
      if (sig === 'Failed 2D' || sig === '2-1-2 Up' || sig === '3-1-2 Up' || sig === 'Hammer') return 'BULL';
      return null;
    }
    function rowScore(r) {
      var score = 0;
      if (r.ftfc) score += 3;
      if (r.tvAlert) score += 3; // user-curated = big boost
      var sd = signalDir(r.signal);
      if (sd && r.flow && r.flow.dominant === sd) score += 2; // flow aligns with signal
      if (sd && r.flow && r.flow.dominant && r.flow.dominant !== sd && r.flow.dominant !== 'MIXED') score -= 2;
      if (r.volRel && r.volRel >= 1.5) score += 1;
      if (r.volRel && r.volRel >= 3)   score += 1;
      return score;
    }
    // Sort each group: highest rowScore first, tie-break by |chgPct|
    Object.keys(groups).forEach(function(k) {
      groups[k].sort(function(a,b) {
        var ds = rowScore(b) - rowScore(a);
        if (ds !== 0) return ds;
        return Math.abs(b.chgPct || 0) - Math.abs(a.chgPct || 0);
      });
    });
    // Drop empty groups
    Object.keys(groups).forEach(function(k){ if (groups[k].length === 0) delete groups[k]; });

    var result = {
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
      scanned: tickers.length,
      matched: rows.length,
      groups: groups,
    };
    _lastScan = result;
    return result;
  } finally {
    _running = false;
  }
}

module.exports = {
  scan: scan,
  getLastScan: function() { return _lastScan; },
  ingestTVAlert: ingestTVAlert,
  getTVAlertsFor: getTVAlertsFor,
  // exported for testing
  classifyBar: classifyBar,
  detectSignal: detectSignal,
};
