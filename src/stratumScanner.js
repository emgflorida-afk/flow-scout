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
var fs = require('fs');
var path = require('path');
var ts = null;
try { ts = require('./tradestation'); } catch(e) {}
var calendar = null;
try { calendar = require('./economicCalendar'); } catch(e) {}
var bullflow = null;
try { bullflow = require('./bullflowStream'); } catch(e) {}

// -----------------------------------------------------------------
// PERSISTENT STATE -- stars + daily signal history
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
if (STATE_DIR === '/tmp') {
  console.warn('[SCANNER] ⚠ STATE_DIR=/tmp — scanner history + stars will be WIPED on redeploy. Mount a Railway volume and set STATE_DIR=/data to persist.');
}
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var STARS_FILE   = path.join(STATE_DIR, 'scanner_stars.json');
var HISTORY_FILE = path.join(STATE_DIR, 'scanner_history.json');
var HISTORY_MAX_DAYS = 10;

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { console.error('[SCANNER] load ' + file + ':', e.message); }
  return fallback;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch(e) { console.error('[SCANNER] save ' + file + ':', e.message); }
}

var _stars = loadJSON(STARS_FILE, {}); // { TICKER: true }
function getStars()     { return Object.keys(_stars); }
function isStarred(t)   { return !!_stars[t]; }
function setStar(t, v)  {
  t = (t || '').toUpperCase();
  if (!t) return { ok: false, reason: 'no ticker' };
  if (v) _stars[t] = true;
  else   delete _stars[t];
  saveJSON(STARS_FILE, _stars);
  return { ok: true, ticker: t, starred: !!_stars[t] };
}

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

// Blacklisted tickers never show up in scan -- mirrors orderExecutor blacklist.
// TSLA = SESSION_START_RULES; BTC-correlated = AB personal preference.
var SCANNER_BLACKLIST = ['TSLA','MSTR','COIN','MARA','RIOT','WULF','BMNR','CLSK','HUT','BITF','IREN','CIFR','HIVE','SOFI'];

function getWatchlist() {
  var raw;
  try { var rc = require('./runtimeConfig'); var v = rc.get('STRATUM_SCANNER_WATCHLIST'); if (v) raw = v; } catch(e){}
  if (!raw) raw = process.env.STRATUM_SCANNER_WATCHLIST;
  var list = raw
    ? raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean)
    : DEFAULT_WATCHLIST.slice();
  // Dedup + remove blacklisted tickers
  var seen = {};
  return list.filter(function(s){
    if (seen[s]) return false;
    if (SCANNER_BLACKLIST.indexOf(s) !== -1) return false;
    seen[s] = 1;
    return true;
  });
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
// CONTINUITY ARROWS (D/W/M/Q) + STRUCTURAL LEVELS
// Each: 'up' if current price > previous-period close,
//       'down' if <, null if unknown
// Also returns prior-period H/L for structural level calculations.
// -----------------------------------------------------------------
async function fetchContinuity(ticker, currentPrice, token) {
  var out = { D: null, W: null, M: null, Q: null, levels: {}, mids: {} };
  try {
    var daily = await fetchBars(ticker, 'Daily', 1, 10, token);
    var weekly = await fetchBars(ticker, 'Weekly', 1, 6, token);
    var monthly = await fetchBars(ticker, 'Monthly', 1, 12, token);
    function dirFromPrevClose(bars) {
      if (!bars || bars.length < 2) return null;
      var prev = normBar(bars[bars.length - 2]);
      if (!prev || !prev.c) return null;
      return currentPrice > prev.c ? 'up' : (currentPrice < prev.c ? 'down' : null);
    }
    out.D = dirFromPrevClose(daily);
    out.W = dirFromPrevClose(weekly);
    out.M = dirFromPrevClose(monthly);
    if (monthly && monthly.length >= 4) {
      var q = normBar(monthly[monthly.length - 4]);
      if (q && q.c) out.Q = currentPrice > q.c ? 'up' : (currentPrice < q.c ? 'down' : null);
    }
    // Structural levels + MIDPOINTS (Rob Smith's 50% Rule)
    // Midpoint = (high + low) / 2 of each TF's most recent bar (including the current forming one)
    if (daily && daily.length >= 2) {
      var pd = normBar(daily[daily.length - 2]);
      var cd = normBar(daily[daily.length - 1]);
      if (pd) { out.levels.pdh = pd.h; out.levels.pdl = pd.l; }
      if (cd) out.mids.daily = +((cd.h + cd.l) / 2).toFixed(2);
    }
    if (weekly && weekly.length >= 2) {
      var pw = normBar(weekly[weekly.length - 2]);
      var cw = normBar(weekly[weekly.length - 1]);
      if (pw) { out.levels.pwh = pw.h; out.levels.pwl = pw.l; }
      if (cw) out.mids.weekly = +((cw.h + cw.l) / 2).toFixed(2);
    }
    if (monthly && monthly.length >= 2) {
      var pm = normBar(monthly[monthly.length - 2]);
      var cm = normBar(monthly[monthly.length - 1]);
      if (pm) { out.levels.pmh = pm.h; out.levels.pml = pm.l; }
      if (cm) out.mids.monthly = +((cm.h + cm.l) / 2).toFixed(2);
    }
    // 52-week high/low
    if (monthly && monthly.length >= 2) {
      var hi52 = 0, lo52 = Infinity;
      for (var i = 0; i < monthly.length - 1; i++) {
        var b = normBar(monthly[i]);
        if (!b) continue;
        if (b.h > hi52) hi52 = b.h;
        if (b.l < lo52) lo52 = b.l;
      }
      if (hi52 > 0)      out.levels.hi52 = hi52;
      if (lo52 < Infinity) out.levels.lo52 = lo52;
    }
  } catch(e) { /* soft */ }
  return out;
}

// Compute mid-alignment stack: price vs weekly mid, vs daily mid
// Returns { weekly: 'above'|'below'|null, daily: 'above'|'below'|null, aligned: 'BULL'|'BEAR'|null }
function midpointStack(price, mids) {
  var out = { weekly: null, daily: null, aligned: null };
  if (!price || !mids) return out;
  if (mids.weekly) out.weekly = price > mids.weekly ? 'above' : 'below';
  if (mids.daily)  out.daily  = price > mids.daily  ? 'above' : 'below';
  if (out.weekly === 'above' && out.daily === 'above') out.aligned = 'BULL';
  else if (out.weekly === 'below' && out.daily === 'below') out.aligned = 'BEAR';
  return out;
}

// -----------------------------------------------------------------
// MAGNITUDE: pick next structural target in signal's direction
// Returns { level: price, label: 'PWH' | 'PMH' | '52wH' | 'TRND', pct: +3.2 }
// atrPct is optional -- used for fallback trend projection when a stock
// has already broken all structural levels (e.g. SPY/QQQ at new ATHs).
// -----------------------------------------------------------------
function nextMagnitude(currentPrice, levels, direction, atrPct) {
  if (!currentPrice || !levels) return null;
  var candidates = [];
  if (direction === 'BULL') {
    if (levels.pdh && levels.pdh > currentPrice) candidates.push({ level: levels.pdh, label: 'PDH' });
    if (levels.pwh && levels.pwh > currentPrice) candidates.push({ level: levels.pwh, label: 'PWH' });
    if (levels.pmh && levels.pmh > currentPrice) candidates.push({ level: levels.pmh, label: 'PMH' });
    if (levels.hi52 && levels.hi52 > currentPrice) candidates.push({ level: levels.hi52, label: '52wH' });
    candidates.sort(function(a,b){ return a.level - b.level; });
  } else if (direction === 'BEAR') {
    if (levels.pdl && levels.pdl < currentPrice) candidates.push({ level: levels.pdl, label: 'PDL' });
    if (levels.pwl && levels.pwl < currentPrice) candidates.push({ level: levels.pwl, label: 'PWL' });
    if (levels.pml && levels.pml < currentPrice) candidates.push({ level: levels.pml, label: 'PML' });
    if (levels.lo52 && levels.lo52 < currentPrice) candidates.push({ level: levels.lo52, label: '52wL' });
    candidates.sort(function(a,b){ return b.level - a.level; });
  } else {
    return null;
  }
  if (candidates.length) {
    var best = candidates[0];
    var pct = ((best.level - currentPrice) / currentPrice) * 100;
    return { level: +best.level.toFixed(2), label: best.label, pct: +pct.toFixed(1) };
  }
  // FALLBACK: trend projection when no structural level remains
  // (stock has broken above 52wH for BULL, below 52wL for BEAR)
  // Use 2x ATR as target. If ATR unavailable, default to 3%.
  var projPct = atrPct && isFinite(atrPct) ? atrPct * 2 : 3.0;
  if (direction === 'BULL') {
    var target = currentPrice * (1 + projPct / 100);
    return { level: +target.toFixed(2), label: 'TRND', pct: +projPct.toFixed(1) };
  }
  if (direction === 'BEAR') {
    var tgt = currentPrice * (1 - projPct / 100);
    return { level: +tgt.toFixed(2), label: 'TRND', pct: -projPct.toFixed(1) };
  }
  return null;
}

// Returns 'UP', 'DOWN', or null. When all available D/W/M/Q point same direction
// and we have at least 3 TFs, return that direction. Otherwise null.
function ftfcDirection(dwmq) {
  if (!dwmq) return null;
  var vals = [dwmq.D, dwmq.W, dwmq.M, dwmq.Q].filter(function(v){ return v; });
  if (vals.length < 3) return null;
  if (vals.every(function(v){ return v === 'up'; }))   return 'UP';
  if (vals.every(function(v){ return v === 'down'; })) return 'DOWN';
  return null;
}
// Legacy boolean check for simpler UI code
function isFTFC(dwmq) { return !!ftfcDirection(dwmq); }

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
// SCAN ONE TICKER -- optional TF: 'Daily' (default), '4HR', 'Weekly'
// -----------------------------------------------------------------
async function scanTicker(ticker, token, earningsMap, tf) {
  tf = tf || 'Daily';
  var barUnit, barInterval, barCount;
  if (tf === '4HR')       { barUnit = 'Minute'; barInterval = 240; barCount = 60; }
  else if (tf === 'Weekly') { barUnit = 'Weekly'; barInterval = 1; barCount = 20; }
  else                     { barUnit = 'Daily';  barInterval = 1; barCount = 30; tf = 'Daily'; }

  var bars = await fetchBars(ticker, barUnit, barInterval, barCount, token);
  if (!bars || bars.length < 5) return null;

  var normed = bars.map(normBar).filter(Boolean);
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
  var ftfcDir = ftfcDirection(dwmq); // 'UP' | 'DOWN' | null
  var ftfc = !!ftfcDir;

  // CONTINUATION DETECTION (added Apr 17 2026 after AB caught the gap):
  // Reversal patterns fire on intraday exhaustion. On strong TREND days
  // (like today: SPY +0.5%, near highs, weekly 2U#2) most stocks run with
  // the tape -- no reversal, so scanner goes silent on the winners.
  //
  // Fix: if no reversal signal AND price closes green above prior day close
  // AND FTFC direction aligns, surface as "Continuation Up" (CALL).
  // Mirror for "Continuation Down" (PUT).
  //
  // Conditions for Continuation Up:
  //   - No reversal signal fired above
  //   - FTFC direction = UP
  //   - Current bar closed above prior bar close (green day)
  //   - Current bar took prior day high (2U bar type) OR current close > PDH
  //   - Not an Inside / Outside / Compression bar (those have their own signals)
  if (!signal && ftfcDir && B) {
    var pdhBreak = dwmq.levels && dwmq.levels.pdh && price > dwmq.levels.pdh;
    var pdlBreak = dwmq.levels && dwmq.levels.pdl && price < dwmq.levels.pdl;
    var greenDay = prev && prev.c && price > prev.c;
    var redDay   = prev && prev.c && price < prev.c;
    if (ftfcDir === 'UP' && greenDay && (cType === '2U' || pdhBreak)) {
      signal = 'Continuation Up';
    } else if (ftfcDir === 'DOWN' && redDay && (cType === '2D' || pdlBreak)) {
      signal = 'Continuation Down';
    }
  }

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

  // Magnitude: next structural target in signal's direction (Primo "ride to next level")
  var sigDirLocal = (function() {
    if (signal === 'Failed 2U' || signal === 'Shooter' || signal === '2-1-2 Down' || signal === '3-1-2 Down' || signal === 'Continuation Down') return 'BEAR';
    if (signal === 'Failed 2D' || signal === 'Hammer'  || signal === '2-1-2 Up'   || signal === '3-1-2 Up'   || signal === 'Continuation Up')   return 'BULL';
    return null;
  })();
  var magnitude = nextMagnitude(price, dwmq.levels || {}, sigDirLocal, atrPct);
  var midStack = midpointStack(price, dwmq.mids || {});

  return {
    ticker: ticker,
    price: price,
    chgPct: chgPct,
    atrPct: atrPct,
    signal: signal,
    combo: [aType, bType, cType],
    dwmq: dwmq,
    ftfc: ftfc,            // boolean (for UI badge compat)
    ftfcDir: ftfcDir,      // 'UP' | 'DOWN' | null
    volAbs: vol ? vol.abs : null,
    volRel: vol ? vol.rel : null,
    earnings: badge,
    // Enrichments:
    flow: flow,
    analyst: analyst,
    priceTargetPct: priceTargetPct,
    tvAlert: tvAlerts,
    starred: isStarred(ticker),
    magnitude: magnitude,  // { level, label, pct } or null
    midpoints: {           // Rob Smith's 50% Rule — buyers won if price > mid
      daily: (dwmq.mids && dwmq.mids.daily) || null,
      weekly: (dwmq.mids && dwmq.mids.weekly) || null,
      monthly: (dwmq.mids && dwmq.mids.monthly) || null,
      stack: midStack.aligned,          // 'BULL'|'BEAR'|null (weekly+daily agree?)
      vsDaily: midStack.daily,          // 'above'|'below'
      vsWeekly: midStack.weekly,        // 'above'|'below'
    },

    // Structural trigger level (where to enter / where stop sits)
    trigger: (function() {
      var C = normed[normed.length - 1];
      var B = normed[normed.length - 2];
      if (!C || !B) return null;
      if (signal === 'Failed 2U' || signal === 'Shooter' || signal === '2-1-2 Down' || signal === '3-1-2 Down' || signal === 'Continuation Down') return C.l;
      if (signal === 'Failed 2D' || signal === 'Hammer'  || signal === '2-1-2 Up'   || signal === '3-1-2 Up'   || signal === 'Continuation Up')   return C.h;
      if (signal === 'Outside Bar' || signal === 'Inside' || signal === '1-1 Compression') return null; // both sides
      return null;
    })(),
  };
}

// -----------------------------------------------------------------
// HISTORY: snapshot today's scan and evaluate past wins/losses
// A signal is WIN if the ATM option peak return ≥ 50% within 3 trading days,
// measured via Bullflow /v1/data/peakReturn. Falls back to underlying-%
// evaluation (legacy) when BULLFLOW_API_KEY is missing.
// -----------------------------------------------------------------
function signalDirectionOf(sig) {
  if (!sig) return null;
  if (sig === 'Failed 2U' || sig === 'Shooter' || sig === '2-1-2 Down' || sig === '3-1-2 Down' || sig === 'Continuation Down') return 'BEAR';
  if (sig === 'Failed 2D' || sig === 'Hammer'  || sig === '2-1-2 Up'   || sig === '3-1-2 Up'   || sig === 'Continuation Up')   return 'BULL';
  return null;
}

function todayET() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  catch(e) { return new Date().toISOString().slice(0,10); }
}

// Weekday + non-US-market-holiday check. Covers the biggest holiday gaps but is
// best-effort; TS bar eval already no-ops when no bar exists, so false positives
// (snapshotting on a holiday) cost at most one wasted row.
function isTradingDayET(dateStr) {
  var d = new Date(dateStr + 'T12:00:00-05:00');
  if (isNaN(d.getTime())) return true;
  var dow = d.getDay();
  if (dow === 0 || dow === 6) return false; // Sat, Sun
  var mmdd = dateStr.slice(5); // MM-DD
  // Fixed-date US market holidays (NYSE + Nasdaq)
  var fixed = ['01-01', '06-19', '07-04', '12-25'];
  if (fixed.indexOf(mmdd) !== -1) return false;
  return true;
}

// Next Friday at least `minDTE` days out, in OCC YYMMDD format.
// Used to build a representative ATM contract for peakReturn scoring.
function nextFridayYYMMDD(fromDateStr, minDTE) {
  var base = new Date(fromDateStr + 'T12:00:00-05:00');
  if (isNaN(base.getTime())) base = new Date();
  var d = new Date(base.getTime());
  var targetMs = base.getTime() + (minDTE * 86400000);
  while (true) {
    d = new Date(d.getTime() + 86400000);
    if (d.getDay() === 5 && d.getTime() >= targetMs) break;
    if (d.getTime() - base.getTime() > 45 * 86400000) break; // safety cap
  }
  var yy = String(d.getFullYear()).slice(-2);
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

// Build OCC option symbol for Bullflow: O:SYMBOL + YYMMDD + C|P + strike×1000 padded to 8 digits.
// Example: HD 5/15/2026 $350 Call → O:HD260515C00350000
function occSymbol(ticker, yymmdd, callOrPut, strike) {
  var strikePadded = String(Math.round(strike * 1000)).padStart(8, '0');
  return 'O:' + String(ticker).toUpperCase() + yymmdd + callOrPut + strikePadded;
}

// ATM premium estimator (proxy for peakReturn old_price). 2% of spot is a
// working heuristic for 14-DTE ATM in normal IV regimes; Bullflow returns %
// return on whatever we pass, so relative accuracy matters more than absolute.
function estimateATMPremium(spotPrice) {
  return Math.max(0.05, +(spotPrice * 0.02).toFixed(2));
}

// Bullflow peakReturn: highest % return an option contract reached since the
// signal timestamp. Returns null on error so caller can fall back gracefully.
async function fetchPeakReturn(sym, oldPrice, tradeTimestamp) {
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) return null;
  var url = 'https://api.bullflow.io/v1/data/peakReturn'
    + '?key=' + encodeURIComponent(apiKey)
    + '&sym=' + encodeURIComponent(sym)
    + '&old_price=' + encodeURIComponent(oldPrice)
    + '&trade_timestamp=' + encodeURIComponent(tradeTimestamp);
  try {
    var res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return null;
    var json = await res.json();
    if (json && typeof json.peakPercentReturnSinceTimestamp === 'number') {
      return json.peakPercentReturnSinceTimestamp;
    }
    return null;
  } catch(e) {
    console.error('[SCANNER] peakReturn error for ' + sym + ':', e.message);
    return null;
  }
}

// Evaluate one signal row via Bullflow peakReturn. Sets row.outcome and row.peakPct.
// WIN: peak ≥ 50% (AB's trim rule), PARTIAL: 25–49% (bill-paying min),
// LOSS: ≤ −30% (approximates structural stop), FLAT: between.
async function evaluateRowWithPeakReturn(row, signalDate) {
  if (!process.env.BULLFLOW_API_KEY) return false;
  var dir = row.dir;
  if (!dir || !row.price || !row.ticker) return false;
  var callOrPut = dir === 'BULL' ? 'C' : 'P';
  var strike = Math.round(row.price); // ATM
  var yymmdd = nextFridayYYMMDD(signalDate, 14);
  var sym = occSymbol(row.ticker, yymmdd, callOrPut, strike);
  var oldPrice = estimateATMPremium(row.price);
  // Signal timestamp = 9:35 AM ET on signal date (first 5-min bar close)
  var tsUnix = Math.floor(new Date(signalDate + 'T13:35:00Z').getTime() / 1000);
  var pct = await fetchPeakReturn(sym, oldPrice, tsUnix);
  if (pct === null) return false;
  row.peakPct = +pct.toFixed(2);
  row.evalMethod = 'peakReturn';
  row.evalContract = sym;
  if (pct >= 50) row.outcome = 'WIN';
  else if (pct >= 25) row.outcome = 'PARTIAL';
  else if (pct <= -30) row.outcome = 'LOSS';
  else row.outcome = 'FLAT';
  return true;
}

function loadHistory() { return loadJSON(HISTORY_FILE, { days: [] }); }
function saveHistory(h) { saveJSON(HISTORY_FILE, h); }

async function snapshotHistory(scanResult) {
  if (!scanResult || !scanResult.groups) return;
  var today = todayET();
  var history = loadHistory();

  // Skip weekend/holiday snapshots — they create phantom rows that can never
  // evaluate (no underlying bar and no option trading). We still evaluate prior
  // days on weekend calls, just don't add a new row.
  var isToday = isTradingDayET(today);
  if (isToday) {
    // Drop any existing entry for today (re-scan)
    history.days = (history.days || []).filter(function(d) { return d.date !== today; });
    // Flatten all rows with minimal data
    var rows = [];
    Object.keys(scanResult.groups).forEach(function(sig) {
      (scanResult.groups[sig] || []).forEach(function(r) {
        var dir = signalDirectionOf(sig);
        if (!dir) return; // skip non-directional signals for the "winners" tracking
        rows.push({
          ticker:  r.ticker,
          signal:  sig,
          dir:     dir,
          price:   r.price,
          trigger: r.trigger,
          ftfc:    r.ftfc,
          flow:    r.flow ? r.flow.dominant : null,
        });
      });
    });
    history.days.push({ date: today, rows: rows });
  }

  // Also prune any phantom weekend/holiday entries from prior runs
  history.days = (history.days || []).filter(function(d) { return isTradingDayET(d.date); });
  // Trim
  history.days.sort(function(a,b){ return a.date.localeCompare(b.date); });
  if (history.days.length > HISTORY_MAX_DAYS) {
    history.days = history.days.slice(history.days.length - HISTORY_MAX_DAYS);
  }

  // Evaluate wins/losses on older days. Prefer Bullflow peakReturn (real option
  // P&L); fall back to TS bar underlying-% when API key missing.
  try {
    var haveBullflow = !!process.env.BULLFLOW_API_KEY;
    var token = haveBullflow ? null : await getToken();
    for (var i = 0; i < history.days.length - 1; i++) {
      var day = history.days[i];
      for (var j = 0; j < (day.rows || []).length; j++) {
        var row = day.rows[j];
        if (row.outcome) continue; // already evaluated

        // Primary path: peakReturn via Bullflow
        if (haveBullflow) {
          var ok = await evaluateRowWithPeakReturn(row, day.date);
          if (ok) continue;
          // fall through to TS-bar fallback if peakReturn errored
        }

        // Fallback path: underlying % (legacy logic, used only if Bullflow unavailable)
        if (!token) continue;
        var bars = await fetchBars(row.ticker, 'Daily', 1, 6, token);
        if (!bars || bars.length < 3) continue;
        var anchorIdx = -1;
        for (var k = 0; k < bars.length; k++) {
          var bd = (bars[k].TimeStamp || bars[k].timestamp || '').slice(0, 10);
          if (bd === day.date) { anchorIdx = k; break; }
        }
        if (anchorIdx < 0 || anchorIdx + 1 >= bars.length) continue;
        var anchor = normBar(bars[anchorIdx]);
        var winBars = [];
        for (var w = anchorIdx + 1; w < Math.min(anchorIdx + 4, bars.length); w++) {
          winBars.push(normBar(bars[w]));
        }
        if (winBars.length === 0) continue;
        var maxUp = Math.max.apply(null, winBars.map(function(b){return b.h;})) - anchor.c;
        var maxDn = anchor.c - Math.min.apply(null, winBars.map(function(b){return b.l;}));
        var movePct = anchor.c ? (row.dir === 'BULL' ? (maxUp / anchor.c) : (maxDn / anchor.c)) * 100 : 0;
        var advPct  = anchor.c ? (row.dir === 'BULL' ? (maxDn / anchor.c) : (maxUp / anchor.c)) * 100 : 0;
        if (movePct >= 1.0 && movePct > advPct) row.outcome = 'WIN';
        else if (advPct >= 1.0) row.outcome = 'LOSS';
        else row.outcome = 'FLAT';
        row.movePct = +movePct.toFixed(2);
        row.advPct  = +advPct.toFixed(2);
        row.evalMethod = 'underlying-fallback';
      }
    }
  } catch(e) { console.error('[SCANNER] snapshot eval error:', e.message); }
  saveHistory(history);
}

function getHistory(days) {
  days = days || 5;
  var h = loadHistory();
  var recent = (h.days || []).slice(-days);
  // Aggregate stats. WIN = option peak ≥ 50%, PARTIAL = 25–49%, LOSS = ≤ −30%,
  // FLAT = middle, pending = not yet evaluated. Tracks avg peak % when available.
  var stats = {
    total: 0, wins: 0, partials: 0, losses: 0, flat: 0, pending: 0,
    avgPeakPct: null, bySignal: {}
  };
  var peakPcts = [];
  recent.forEach(function(d) {
    (d.rows || []).forEach(function(r) {
      stats.total++;
      var bucket = stats.bySignal[r.signal] = stats.bySignal[r.signal]
        || { total: 0, wins: 0, partials: 0, losses: 0, flat: 0, avgPeakPct: null, _peaks: [] };
      bucket.total++;
      if (r.outcome === 'WIN')          { stats.wins++;     bucket.wins++; }
      else if (r.outcome === 'PARTIAL') { stats.partials++; bucket.partials++; }
      else if (r.outcome === 'LOSS')    { stats.losses++;   bucket.losses++; }
      else if (r.outcome === 'FLAT')    { stats.flat++;     bucket.flat++; }
      else stats.pending++;
      if (typeof r.peakPct === 'number') {
        peakPcts.push(r.peakPct);
        bucket._peaks.push(r.peakPct);
      }
    });
  });
  if (peakPcts.length) {
    stats.avgPeakPct = +(peakPcts.reduce(function(a,b){return a+b;}, 0) / peakPcts.length).toFixed(2);
  }
  Object.keys(stats.bySignal).forEach(function(s) {
    var b = stats.bySignal[s];
    if (b._peaks.length) {
      b.avgPeakPct = +(b._peaks.reduce(function(a,b){return a+b;}, 0) / b._peaks.length).toFixed(2);
    }
    delete b._peaks;
  });
  return { days: recent, stats: stats };
}

// -----------------------------------------------------------------
// TRADE BUILDER: turn a scanner row into a bulkAddQueuedTrades item
// -----------------------------------------------------------------
function nextFriday(daysMin) {
  daysMin = daysMin || 5;
  var d = new Date();
  d.setDate(d.getDate() + daysMin);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}
function buildOSISymbol(ticker, dir, strike, exp) {
  var yy = String(exp.getFullYear()).slice(2);
  var mm = String(exp.getMonth() + 1).padStart(2, '0');
  var dd = String(exp.getDate()).padStart(2, '0');
  var cp = dir === 'CALLS' ? 'C' : 'P';
  return ticker + ' ' + yy + mm + dd + cp + strike;
}

function buildTradeItem(opts) {
  opts = opts || {};
  var ticker = (opts.ticker || '').toUpperCase();
  var signal = opts.signal || '';
  var dir = signalDirectionOf(signal) === 'BULL' ? 'CALLS' : signalDirectionOf(signal) === 'BEAR' ? 'PUTS' : (opts.direction || null);
  if (!ticker || !dir) return null;
  var contracts = parseInt(opts.contracts || 2, 10);
  var price = parseFloat(opts.price || 0);
  var trigger = parseFloat(opts.trigger || price);
  var strike = Math.round(price);
  var exp = nextFriday(opts.dte || 5);
  var mm = String(exp.getMonth() + 1).padStart(2, '0');
  var dd = String(exp.getDate()).padStart(2, '0');
  var yyyy = String(exp.getFullYear());
  return {
    ticker: ticker,
    direction: dir,
    triggerPrice: +trigger.toFixed(2),
    contractSymbol: buildOSISymbol(ticker, dir, strike, exp),
    strike: strike,
    expiration: mm + '-' + dd + '-' + yyyy,
    contractType: dir === 'CALLS' ? 'Call' : 'Put',
    maxEntryPrice: 6.00,
    stopPct: -0.30,
    targets: [0.25, 0.50, 1.00],
    contracts: contracts,
    management: 'STRAT',
    tradeType: 'DAY',
    grade: opts.ftfc ? 'A+' : 'A',
    source: 'STRATUMSCANNER_' + signal.replace(/\s+/g, '_').toUpperCase(),
    note: 'Queued from /scanner UI — ' + signal + (opts.ftfc ? ' (FTFC)' : '') + (opts.flow ? ' flow=' + opts.flow : ''),
  };
}

async function queueFromRow(opts) {
  var item = buildTradeItem(opts);
  if (!item) return { ok: false, reason: 'Could not build trade (missing ticker or non-directional signal)' };
  try {
    var be = require('./brainEngine');
    if (be && be.bulkAddQueuedTrades) {
      be.bulkAddQueuedTrades([item], { replaceAll: false });
      return { ok: true, queued: item };
    }
    return { ok: false, reason: 'brainEngine.bulkAddQueuedTrades not available' };
  } catch(e) { return { ok: false, reason: e.message }; }
}

// -----------------------------------------------------------------
// FULL SCAN (with concurrency)
// -----------------------------------------------------------------
var _running = {};      // keyed by tf
var _lastScan = {};     // keyed by tf

async function scan(opts) {
  opts = opts || {};
  var tf = opts.tf || 'Daily';
  if (['Daily','4HR','Weekly'].indexOf(tf) === -1) tf = 'Daily';
  var concurrency = opts.concurrency || 6;
  if (_running[tf] && !opts.force) return _lastScan[tf];
  _running[tf] = true;
  var startedAt = Date.now();

  try {
    var token = await getToken();
    if (!token) {
      _running[tf] = false;
      return { error: 'no TS token', generatedAt: new Date().toISOString(), tf: tf, groups: {} };
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
          var row = await scanTicker(t, token, earningsMap, tf);
          if (row && row.signal) rows.push(row);
        } catch(e) { /* skip bad ticker */ }
      }
    }
    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    // Group by signal -- priority order matters for display
    var priority = [
      'Continuation Up', 'Continuation Down',
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
      if (sig === 'Failed 2U' || sig === '2-1-2 Down' || sig === '3-1-2 Down' || sig === 'Shooter' || sig === 'Continuation Down') return 'BEAR';
      if (sig === 'Failed 2D' || sig === '2-1-2 Up' || sig === '3-1-2 Up' || sig === 'Hammer' || sig === 'Continuation Up') return 'BULL';
      return null;
    }
    function rowScore(r) {
      var score = 0;
      var sd = signalDir(r.signal);  // 'BULL' | 'BEAR' | null
      // FTFC direction must MATCH signal direction to earn the boost.
      // FTFC opposing signal (e.g. all ↑ but signal is Failed 2U PUT) is
      // counter-trend -- per Rob Smith, only valid at exhaustion, so push down.
      if (r.ftfcDir && sd) {
        var ftfcBull = r.ftfcDir === 'UP';
        var sigBull  = sd === 'BULL';
        if (ftfcBull === sigBull) score += 3;   // aligned = high conviction
        else                      score -= 3;   // counter-trend = penalty
      } else if (r.ftfc) {
        // We know FTFC is aligned across TFs but signal is non-directional
        // (Inside, Outside, 1-1 Comp). Still a small boost for clarity.
        score += 1;
      }
      if (r.tvAlert) score += 3; // user-curated = big boost
      if (sd && r.flow && r.flow.dominant) {
        var flowBull = r.flow.dominant === 'BULL';
        var sigBullF = sd === 'BULL';
        if (r.flow.dominant === 'MIXED') {
          // neutral flow -- no change
        } else if (flowBull === sigBullF) score += 2;
        else                              score -= 2;
      }
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
      tf: tf,
      scanned: tickers.length,
      matched: rows.length,
      groups: groups,
      stars: getStars(),
    };
    _lastScan[tf] = result;
    // Snapshot Daily scans only for history tracking
    if (tf === 'Daily') {
      snapshotHistory(result).catch(function(e) { console.error('[SCANNER] history:', e.message); });
    }
    return result;
  } finally {
    _running[tf] = false;
  }
}

module.exports = {
  scan: scan,
  getLastScan: function(tf) { return _lastScan[tf || 'Daily']; },
  ingestTVAlert: ingestTVAlert,
  getTVAlertsFor: getTVAlertsFor,
  // Stars
  getStars: getStars,
  setStar: setStar,
  isStarred: isStarred,
  // History
  getHistory: getHistory,
  snapshotHistory: snapshotHistory,
  // Trade builder
  buildTradeItem: buildTradeItem,
  queueFromRow: queueFromRow,
  // exported for testing
  classifyBar: classifyBar,
  detectSignal: detectSignal,
};
