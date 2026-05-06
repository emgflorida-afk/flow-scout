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
// Apr 24 2026 — GEX enrichment for scanner upgrade. Pulls gamma pin,
// regime, expected range, nearest walls for each top-conviction row.
var gex = null;
try { gex = require('./gex'); } catch(e) { console.log('[SCANNER] gex module not loaded:', e.message); }
var bullflow = null;
try { bullflow = require('./bullflowStream'); } catch(e) {}
var contractCard = null;
try { contractCard = require('./contractCard'); } catch(e) {}

// -----------------------------------------------------------------
// CARD ENRICHMENT BUDGET (Apr 21 2026 PM v3)
// The TS rate limiter gates option-chain calls at 1500ms gaps globally,
// so >15 enrichments in a scan push the request past Railway's HTTP
// timeout -> "Fetch failed: Unexpected end of JSON input" on scanner.
// We cap total card enrichments per scan, with WAR_ROOM tickers always
// privileged (they get enriched even past the cap because AB watches them).
// Reset at the top of scan(); read inside scanTicker().
// -----------------------------------------------------------------
var _enrichBudget = { count: 0, cap: parseInt(process.env.CARD_ENRICH_CAP, 10) || 12 };
function _resetEnrichBudget() {
  _enrichBudget.count = 0;
  _enrichBudget.cap = parseInt(process.env.CARD_ENRICH_CAP, 10) || 12;
}
// Race a promise against a hard timeout so one slow card can't blow the scan.
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(resolve) { setTimeout(function() { resolve(null); }, ms); }),
  ]);
}

// -----------------------------------------------------------------
// PERSISTENT STATE -- stars + daily signal history
// -----------------------------------------------------------------
// Apr 20 2026 PM: auto-use /data if it exists (Railway volume default) so we
// don't wipe stars/TV alerts on every deploy. AB's feedback: stars kept
// disappearing because /tmp was ephemeral.
var STATE_DIR = process.env.STATE_DIR;
if (!STATE_DIR) {
  try {
    var fsTest = require('fs');
    if (fsTest.existsSync('/data')) {
      STATE_DIR = '/data';
      console.log('[SCANNER] STATE_DIR auto-detected /data (Railway volume)');
    } else {
      STATE_DIR = '/tmp';
    }
  } catch(e) { STATE_DIR = '/tmp'; }
}
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
// Apr 20 2026 PM: TV alerts persisted to disk so Railway redeploys don't
// wipe them. Saved after every ingest, loaded at startup.
var TV_ALERTS_FILE = path.join(STATE_DIR, 'tv_alerts.json');
var _tvAlerts = (function() {
  try {
    if (fs.existsSync(TV_ALERTS_FILE)) {
      var d = JSON.parse(fs.readFileSync(TV_ALERTS_FILE, 'utf8'));
      console.log('[SCANNER] Loaded TV alerts for ' + Object.keys(d).length + ' tickers from disk');
      return d;
    }
  } catch(e) { console.error('[SCANNER] TV alerts load error:', e.message); }
  return {};
})();
function persistTVAlerts() {
  try { fs.writeFileSync(TV_ALERTS_FILE, JSON.stringify(_tvAlerts)); } catch(e) {}
}
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
  persistTVAlerts();  // persist to disk so deploy doesn't wipe
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
  // John VIP watchlist (Apr 20 adds): BABA, CRWV
  'BABA','CRWV',
  // Apr 25 2026 — AB next-week watchlist via John reversal indicator: APP, RBLX, IREN (CRWD/AVGO already listed above)
  'APP','RBLX','IREN',
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
// Apr 25 2026 — AB lifted IREN per next-week watchlist (BTC-miner, but actively traded)
// May 6 2026 — AB blocked ADBE + CRM after both stopped out same day. "Never again."
//              Also blocks SBUX (ABBV stays — was good idea, bad execution).
var SCANNER_BLACKLIST = ['TSLA','MSTR','COIN','MARA','RIOT','WULF','BMNR','CLSK','HUT','BITF','CIFR','HIVE','SOFI','ADBE','CRM','SBUX','MRVL'];

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
// STRAT BAR CLASSIFICATION + SIGNAL DETECTION
// Now delegated to shared src/stratClassifier.js — single source of
// truth used by both scanner (display) AND brain (auto-fire).
// Apr 20 2026: AB asked to unify scanner + brain so fresh positions
// open cleanly.
// -----------------------------------------------------------------
var stratClassifier = require('./stratClassifier');
var classifyBar = stratClassifier.classifyBar;
var detectSignal = stratClassifier.detect3BarSignalWithTypes;

// Apr 24 2026 — sector lookup for scanner UI color coding
var sectorMap = null;
try { sectorMap = require('./sectorMap'); } catch(e) {}
function getSector(ticker) {
  try { return sectorMap && sectorMap.getSector ? sectorMap.getSector(ticker) : null; }
  catch(e) { return null; }
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
  // Apr 24 2026 — added 30m, 60m, Monthly timeframe support
  // Apr 27 PM — added 6HR (360min) per AB observation that 6H catches reversals
  // 3-6 hours before daily and is the cleanest intraday HTF for retrace detection.
  if (tf === '30m')       { barUnit = 'Minute'; barInterval = 30; barCount = 60; }
  else if (tf === '60m' || tf === '1HR')  { barUnit = 'Minute'; barInterval = 60; barCount = 60; }
  else if (tf === '4HR' || tf === '4h')   { barUnit = 'Minute'; barInterval = 240; barCount = 60; tf = '4HR'; }
  else if (tf === '6HR' || tf === '6h' || tf === '360')  { barUnit = 'Minute'; barInterval = 360; barCount = 40; tf = '6HR'; }
  else if (tf === 'Weekly' || tf === 'W') { barUnit = 'Weekly'; barInterval = 1; barCount = 20; tf = 'Weekly'; }
  else if (tf === 'Monthly' || tf === 'M') { barUnit = 'Monthly'; barInterval = 1; barCount = 20; tf = 'Monthly'; }
  else                     { barUnit = 'Daily';  barInterval = 1; barCount = 30; tf = 'Daily'; }

  var bars = await fetchBars(ticker, barUnit, barInterval, barCount, token);
  // Apr 20 2026: if bars fetch fails BUT ticker has TV alert or is starred,
  // still surface a minimal row in TV Watch / Starred group so AB can see it.
  if (!bars || bars.length < 5) {
    var _tvFallback = getTVAlertsFor(ticker);
    var _starFallback = isStarred(ticker);
    if (_tvFallback || _starFallback) {
      return {
        ticker: ticker,
        sector: getSector(ticker),   // Apr 24 2026 — populate in fallback row too
        price: null, chgPct: null, atrPct: null,
        signal: _tvFallback ? 'TV Watch' : 'Starred',
        combo: [], dwmq: {}, ftfc: false, ftfcDir: null,
        volAbs: null, volRel: null, earnings: null,
        gap: null, signalContext: null, ftfcAligned: false,
        atrExtreme: false, aPlusAlert: null,
        flow: null, analyst: null, priceTargetPct: null,
        tvAlert: _tvFallback, starred: _starFallback,
        magnitude: null, midpoints: {},
        trigger: null,
      };
    }
    return null;
  }

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

  // Gap detection (today open vs prior close)
  var gap = prev && last ? stratClassifier.computeGap(last, prev) : null;

  // Signal context (REVERSAL / CONTINUATION / COMPRESSION)
  var signalContext = stratClassifier.classifySignalContext(signal);

  var dwmq = await fetchContinuity(ticker, price, token);
  var ftfcDir = ftfcDirection(dwmq); // 'UP' | 'DOWN' | null
  var ftfc = !!ftfcDir;

  // Strict FTFC ALIGNED badge — requires ALL 4 TFs (D/W/M/Q) pointing same direction
  var ftfcAligned = false;
  if (dwmq && dwmq.D && dwmq.W && dwmq.M && dwmq.Q) {
    var allUp = dwmq.D === 'UP' && dwmq.W === 'UP' && dwmq.M === 'UP' && dwmq.Q === 'UP';
    var allDown = dwmq.D === 'DOWN' && dwmq.W === 'DOWN' && dwmq.M === 'DOWN' && dwmq.Q === 'DOWN';
    ftfcAligned = allUp || allDown;
  }

  // Extreme ATR flag (>7% = news/vol event)
  var atrExtreme = atrPct >= 7;

  // A+ WAR ROOM — recent big-dollar algo alert matching this ticker+direction
  // Apr 20 2026 (AB rule): "one central place, peace that it'll move."
  // Requires: algo alert in last 10 min, ≥ $250K premium, direction match.
  //
  // Apr 21 2026 PM: AB limited War Room to top 10 tickers (Mag 7 + hot picks)
  // so the room stays signal-dense. Scanner still scans full watchlist, but
  // A+ alert only fires when one of these top names triggers.
  // Customize via WAR_ROOM_TICKERS env var (comma list) — falls back to hardcoded.
  var WAR_ROOM_TICKERS = (process.env.WAR_ROOM_TICKERS || 'SPY,QQQ,AAPL,MSFT,NVDA,AMZN,GOOGL,META,ORCL,CRWV').split(',').map(function(s){ return s.trim().toUpperCase(); });
  var aPlusAlert = null;
  var warRoomEligible = WAR_ROOM_TICKERS.indexOf(ticker) !== -1;
  try {
    if (warRoomEligible && bullflow && bullflow.getRecentFlow) {
      var recent = bullflow.getRecentFlow({ symbol: ticker, minPremium: 250000 }) || [];
      var cutoff = Date.now() - 10 * 60 * 1000;
      var matching = recent.filter(function(a) {
        var t = new Date(a.timestamp).getTime();
        if (t < cutoff) return false;
        // Match direction: bullish signal wants CALL alerts, bearish wants PUT
        if (signal === 'Failed 2U' || signal === 'Shooter' || signal === '2-1-2 Down' || signal === '3-1-2 Down' || signal === 'Continuation Down' || signal === '2-2 Reversal Down' || signal === '3-2D Broadening') {
          return a.callPut === 'PUT';
        }
        if (signal === 'Failed 2D' || signal === 'Hammer' || signal === '2-1-2 Up' || signal === '3-1-2 Up' || signal === 'Continuation Up' || signal === '2-2 Reversal Up' || signal === '3-2U Broadening') {
          return a.callPut === 'CALL';
        }
        return false;
      });
      if (matching.length) {
        // Take biggest
        matching.sort(function(x,y){ return y.premium - x.premium; });
        var top = matching[0];
        aPlusAlert = {
          premium: top.premium,
          alertType: top.alertType,
          callPut: top.callPut,
          timestamp: top.timestamp,
          ageSeconds: Math.round((Date.now() - new Date(top.timestamp).getTime()) / 1000),
        };
      }
    }
  } catch(e) { /* non-blocking */ }

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

  // Apr 20 2026: force-include tickers with fresh TV alerts OR starred —
  // surfaces John VIP / Reversal Indicator alerts on scanner even when
  // no Strat signal is present yet.
  var _tvAlertsLocal = getTVAlertsFor(ticker);
  var _starred = isStarred(ticker);
  if (!signal && (_tvAlertsLocal || _starred)) {
    signal = _tvAlertsLocal ? 'TV Watch' : 'Starred';
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
  // Apr 21 2026 PM v3 — extend coverage to 2-2 Reversals + 3-2 Broadening
  // so those signals produce conviction tags, freshness badges, AND contract cards.
  var sigDirLocal = (function() {
    if (signal === 'Failed 2U' || signal === 'Shooter' || signal === '2-1-2 Down' || signal === '3-1-2 Down' || signal === 'Continuation Down' || signal === '2-2 Reversal Down' || signal === '3-2D Broadening') return 'BEAR';
    if (signal === 'Failed 2D' || signal === 'Hammer'  || signal === '2-1-2 Up'   || signal === '3-1-2 Up'   || signal === 'Continuation Up'   || signal === '2-2 Reversal Up'   || signal === '3-2U Broadening') return 'BULL';
    return null;
  })();
  var magnitude = nextMagnitude(price, dwmq.levels || {}, sigDirLocal, atrPct);
  var midStack = midpointStack(price, dwmq.mids || {});

  // ----------------------------------------------------------------
  // CONTRACT CARD ENRICHMENT (Apr 21 2026)
  // Per OPERATING_MODEL_apr21.md: produce Titan-ready contract cards per
  // directional signal row. Display only — scanner never fires orders.
  // ----------------------------------------------------------------
  var contractCardData = null;
  var skipCard = !sigDirLocal || !signal || signal === 'Inside' || signal === 'Outside Bar' || signal === '1-1 Compression' || signal === 'TV Watch' || signal === 'Starred';
  // Apr 21 2026 PM v3 — budget-gated enrichment.
  // WAR_ROOM tickers always enrich (AB's primary watch). Non-WAR_ROOM
  // directional rows compete for a shared budget (CARD_ENRICH_CAP, default 12)
  // so the scan never exceeds Railway's HTTP timeout. Rows that don't get
  // enriched this scan simply render without a ⚡/📨 button — they still
  // show up with all normal scanner data. On the next refresh, the 60s
  // quote cache eats most of the cost so cards backfill quickly.
  if (!skipCard && contractCard && contractCard.buildCard) {
    var isWarRoom = warRoomEligible; // computed earlier in this function
    var budgetAvail = _enrichBudget.count < _enrichBudget.cap;
    var shouldEnrich = isWarRoom || budgetAvail;
    if (shouldEnrich) {
      if (!isWarRoom) _enrichBudget.count++;
      try {
        var triggerLvl = null;
        if (signal === 'Failed 2U' || signal === 'Shooter' || signal === '2-1-2 Down' || signal === '3-1-2 Down' || signal === 'Continuation Down' || signal === '2-2 Reversal Down' || signal === '3-2D Broadening') triggerLvl = C.l;
        if (signal === 'Failed 2D' || signal === 'Hammer'  || signal === '2-1-2 Up'   || signal === '3-1-2 Up'   || signal === 'Continuation Up'   || signal === '2-2 Reversal Up'   || signal === '3-2U Broadening') triggerLvl = C.h;

        // Binary catalyst detection: earnings next 1-2 days OR env flag
        var binaryCatalyst = false;
        if (badge && /EARN/.test(badge)) binaryCatalyst = true;
        if (process.env.BINARY_CATALYST_TODAY === 'true') binaryCatalyst = true;

        if (triggerLvl) {
          // Apr 21 2026 PM v4 — 10s hard cap per card. With 400ms rate limiter
          // and 60s quote cache, 12 cards queue fits easily in the budget.
          // 10s per-card covers the worst case of rate-limit queue + chain fetch.
          contractCardData = await _withTimeout(
            contractCard.buildCard({
              ticker: ticker,
              direction: sigDirLocal,
              signal: signal,
              bars: { A: A, B: B, C: C },
              stockPrice: price,
              trigger: triggerLvl,
              timeframe: tf || 'Daily',
              source: 'SCANNER',
              binaryCatalyst: binaryCatalyst,
            }),
            10000,
            ticker + '-card'
          );
        }
      } catch(e) {
        contractCardData = null; // non-blocking; leave row un-enriched
      }
    }
  }

  // FRESHNESS TAG (Apr 21 2026 PM — AB's stale/fresh question)
  // Tells AB if today's magnitude was already captured (exhausted), or
  // if the setup is still cocked for tomorrow. Prevents "did I miss it?"
  // second-guessing on post-close scans.
  //
  //   🟢 fresh     — setup cocked, today didn't consume magnitude
  //   🟡 partial   — 50%+ of magnitude distance captured today, room left
  //   🔴 exhausted — today's high/low hit or exceeded magnitude target
  //   ⚫ faded     — wide-range bar that closed rejecting (intraday whipsaw)
  var freshness = null;
  if (sigDirLocal && signal && signal !== 'TV Watch' && signal !== 'Starred' && signal !== 'Inside' && signal !== 'Outside Bar' && signal !== '1-1 Compression') {
    var magHit = false;
    var magPct = 0;
    if (magnitude && magnitude.level && C) {
      var magLvl = magnitude.level;
      var prevClose = prev ? prev.c : (B ? B.c : null);
      if (sigDirLocal === 'BULL') {
        magHit = C.h >= magLvl;
        if (prevClose && magLvl > prevClose) {
          magPct = Math.min(Math.max((C.h - prevClose) / (magLvl - prevClose), 0), 1);
        }
      } else if (sigDirLocal === 'BEAR') {
        magHit = C.l <= magLvl;
        if (prevClose && prevClose > magLvl) {
          magPct = Math.min(Math.max((prevClose - C.l) / (prevClose - magLvl), 0), 1);
        }
      }
    }
    // Intraday fade detection: wide-range bar with close rejecting the direction
    var rng = C ? (C.h - C.l) : 0;
    var closePos = rng > 0 ? (price - C.l) / rng : 0.5; // 0=at low, 1=at high
    var faded = false;
    if (C && rng > (C.h * 0.015)) { // at least 1.5% range
      if (sigDirLocal === 'BULL' && closePos < 0.35) faded = true;
      if (sigDirLocal === 'BEAR' && closePos > 0.65) faded = true;
    }
    if (magHit) freshness = 'exhausted';
    else if (faded) freshness = 'faded';
    else if (magPct >= 0.5) freshness = 'partial';
    else freshness = 'fresh';
  }

  // CONVICTION TAG (Apr 21 2026 — drives FAST vs REVIEW button in UI)
  // HIGH: War Room A+ hit, OR JSmith alert matching, OR FTFC-aligned + volume-confirmed
  // NORMAL: directional signal present, no boost
  // null: non-directional / TV Watch / Starred only
  var conviction = null;
  if (sigDirLocal && signal && signal !== 'TV Watch' && signal !== 'Starred' && signal !== 'Inside' && signal !== 'Outside Bar' && signal !== '1-1 Compression') {
    var jsmithHit = !!(tvAlerts && tvAlerts.latest && /jsmith|john/i.test((tvAlerts.latest.message || tvAlerts.latest.source || '')));
    if (aPlusAlert || jsmithHit) {
      conviction = 'high';
    } else if (ftfcAligned && vol && vol.rel >= 1.5) {
      conviction = 'high';
    } else {
      conviction = 'normal';
    }
  }

  return {
    ticker: ticker,
    sector: getSector(ticker),   // Apr 24 2026 — for scanner UI sector column
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
    // Apr 20 2026 enrichments (shown on scanner table + badges):
    gap: gap,                      // { gapPct, gapDir, gapSize, gapFilled } or null
    signalContext: signalContext,  // 'REVERSAL' | 'CONTINUATION' | 'COMPRESSION' | null
    ftfcAligned: ftfcAligned,      // strict: ALL 4 TFs (D/W/M/Q) same direction
    atrExtreme: atrExtreme,        // true if ATR% >= 7 (news/vol event)
    aPlusAlert: aPlusAlert,        // recent big-$ flow alert matching direction (or null)
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

    // Apr 21 2026 — Titan-ready contract card (display only; no auto-fire)
    // See: memory/OPERATING_MODEL_apr21.md + memory/SCANNER_CONTRACT_CARD_SPEC.md
    contractCard: contractCardData,

    // Apr 21 2026 PM — conviction tag ('high'|'normal'|null) drives UI
    // FAST vs REVIEW button. High-conviction → can fast-fire via MCP
    // without manual confirm-order preview step.
    conviction: conviction,

    // Apr 21 2026 PM — freshness tag tells AB if today's move already
    // captured magnitude. 🟢fresh · 🟡partial · 🔴exhausted · ⚫faded
    freshness: freshness,
    magnitudePctCaptured: (function() {
      if (!magnitude || !magnitude.level || !prev || !C) return null;
      if (sigDirLocal === 'BULL' && magnitude.level > prev.c) {
        return Math.round(Math.min(Math.max((C.h - prev.c) / (magnitude.level - prev.c), 0), 1) * 100);
      }
      if (sigDirLocal === 'BEAR' && prev.c > magnitude.level) {
        return Math.round(Math.min(Math.max((prev.c - C.l) / (prev.c - magnitude.level), 0), 1) * 100);
      }
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
    // Drop any existing entry for today+tf (re-scan)
    var snapTf = (scanResult.tf || scanResult.timeframe || 'Daily');
    history.days = (history.days || []).filter(function(d) {
      return !(d.date === today && (d.tf || 'Daily') === snapTf);
    });
    // Flatten all rows with RICH data — Apr 24 2026 v1.5 enrichment so we can
    // slice win-rate by any criterion (FTFC aligned / GEX regime / flow size /
    // midpoint stack / sector / conviction). Required for real edge discovery.
    var rows = [];
    Object.keys(scanResult.groups).forEach(function(sig) {
      (scanResult.groups[sig] || []).forEach(function(r) {
        var dir = signalDirectionOf(sig);
        if (!dir) return; // skip non-directional signals for the "winners" tracking
        rows.push({
          ticker:        r.ticker,
          signal:        sig,
          dir:           dir,
          price:         r.price,
          trigger:       r.trigger,
          // Trend alignment
          ftfc:          r.ftfc,
          ftfcAligned:   !!r.ftfcAligned,           // strict 4-TF match
          ftfcDir:       r.ftfcDir || null,
          // Volatility + volume
          atrPct:        r.atrPct,
          atrExtreme:    !!r.atrExtreme,
          volRel:        r.volRel,
          // Flow (Bullflow aggregation at signal time)
          flow:          r.flow ? r.flow.dominant : null,
          flowTotal:     r.flow ? r.flow.total : null,
          flowNet:       r.flow ? r.flow.net : null,
          // Gamma regime (GEX enrichment)
          gexRegime:     r.gex ? r.gex.regime : null,
          gexPin:        r.gex ? r.gex.pin : null,
          gexFlip:       r.gex ? r.gex.gammaFlip : null,
          // Structural
          inForce:       r.inForce || null,
          magnitudePct:  r.magnitude ? r.magnitude.pct : null,
          midpointStack: r.midpoints ? r.midpoints.stack : null,
          // Context
          sector:        r.sector || null,
          conviction:    r.conviction || null,
          starred:       !!r.starred,
          gap:           r.gap ? r.gap.gapPct : null,
          gapSize:       r.gap ? r.gap.gapSize : null,
          earnings:      r.earnings || null,
          signalContext: r.signalContext || null,
          freshness:     r.freshness || null,
          // Raw flow count so we can ask "did big-flow signals win more?"
          flowCallCount: r.flow ? r.flow.callCount : 0,
          flowPutCount:  r.flow ? r.flow.putCount : 0,
        });
      });
    });
    history.days.push({ date: today, tf: snapTf, rows: rows });
  }

  // Also prune any phantom weekend/holiday entries from prior runs
  history.days = (history.days || []).filter(function(d) { return isTradingDayET(d.date); });
  // Trim
  history.days.sort(function(a,b){ return a.date.localeCompare(b.date); });
  if (history.days.length > HISTORY_MAX_DAYS) {
    history.days = history.days.slice(history.days.length - HISTORY_MAX_DAYS);
  }

  // Evaluate wins/losses on non-today+tf days. TF-aware eval windows:
  //   Daily: 3 daily bars forward, 1% favorable = WIN
  //   4HR:   2 4HR bars forward, 0.8% favorable = WIN (~1 day)
  //   60m:   4 60m bars forward, 0.5% favorable = WIN (~4 hours)
  //   30m:   4 30m bars forward, 0.3% favorable = WIN (~2 hours)
  // Daily prefers Bullflow peakReturn (real option P&L); intraday uses underlying %.
  try {
    var haveBullflow = !!process.env.BULLFLOW_API_KEY;
    var token = await getToken();
    for (var i = 0; i < history.days.length; i++) {
      var day = history.days[i];
      var dayTf = day.tf || 'Daily';
      // Skip in-flight day+tf. For intraday TFs a same-day eval is valid once
      // enough forward bars have printed, but we defer to a later cron for
      // simplicity — only eval full prior trading days here.
      if (day.date === today) continue;
      for (var j = 0; j < (day.rows || []).length; j++) {
        var row = day.rows[j];
        if (row.outcome) continue; // already evaluated

        // Primary path for Daily: peakReturn via Bullflow (real option P&L)
        if (dayTf === 'Daily' && haveBullflow) {
          var ok = await evaluateRowWithPeakReturn(row, day.date);
          if (ok) continue;
          // fall through to TS-bar fallback if peakReturn errored
        }

        // TF-appropriate underlying eval
        if (!token) continue;
        var evalCfg = {
          'Daily': { unit: 'Daily',  interval: 1,   fwdBars: 3, winThresh: 1.0, lossThresh: 1.0 },
          '4HR':   { unit: 'Minute', interval: 240, fwdBars: 2, winThresh: 0.8, lossThresh: 0.8 },
          '60m':   { unit: 'Minute', interval: 60,  fwdBars: 4, winThresh: 0.5, lossThresh: 0.5 },
          '1HR':   { unit: 'Minute', interval: 60,  fwdBars: 4, winThresh: 0.5, lossThresh: 0.5 },
          '30m':   { unit: 'Minute', interval: 30,  fwdBars: 4, winThresh: 0.3, lossThresh: 0.3 },
        }[dayTf] || { unit: 'Daily', interval: 1, fwdBars: 3, winThresh: 1.0, lossThresh: 1.0 };

        var bars = await fetchBars(row.ticker, evalCfg.unit, evalCfg.interval, evalCfg.fwdBars + 10, token);
        if (!bars || bars.length < 3) continue;

        // Find anchor bar (signal print). For Daily we match date string.
        // For intraday we use the last bar with TimeStamp ≤ end-of-day(day.date) and >= signalTs (~close of session).
        var anchorIdx = -1;
        if (evalCfg.unit === 'Daily') {
          for (var k = 0; k < bars.length; k++) {
            var bd = (bars[k].TimeStamp || bars[k].timestamp || '').slice(0, 10);
            if (bd === day.date) { anchorIdx = k; break; }
          }
        } else {
          // Intraday: anchor = last bar with date ≤ day.date AND time ≤ end-of-session
          for (var k = bars.length - 1; k >= 0; k--) {
            var bts = (bars[k].TimeStamp || bars[k].timestamp || '');
            if (bts.slice(0, 10) === day.date) { anchorIdx = k; break; }
          }
        }
        if (anchorIdx < 0 || anchorIdx + 1 >= bars.length) continue;

        var anchor = normBar(bars[anchorIdx]);
        var winBars = [];
        for (var w = anchorIdx + 1; w < Math.min(anchorIdx + 1 + evalCfg.fwdBars, bars.length); w++) {
          winBars.push(normBar(bars[w]));
        }
        if (winBars.length === 0) continue;
        var maxUp = Math.max.apply(null, winBars.map(function(b){return b.h;})) - anchor.c;
        var maxDn = anchor.c - Math.min.apply(null, winBars.map(function(b){return b.l;}));
        var movePct = anchor.c ? (row.dir === 'BULL' ? (maxUp / anchor.c) : (maxDn / anchor.c)) * 100 : 0;
        var advPct  = anchor.c ? (row.dir === 'BULL' ? (maxDn / anchor.c) : (maxUp / anchor.c)) * 100 : 0;
        if (movePct >= evalCfg.winThresh && movePct > advPct) row.outcome = 'WIN';
        else if (advPct >= evalCfg.lossThresh) row.outcome = 'LOSS';
        else row.outcome = 'FLAT';
        row.movePct = +movePct.toFixed(2);
        row.advPct  = +advPct.toFixed(2);
        row.evalMethod = 'underlying-' + dayTf;
        row.evalWindow = evalCfg.fwdBars + 'x' + dayTf;
      }
    }
  } catch(e) { console.error('[SCANNER] snapshot eval error:', e.message); }
  saveHistory(history);
}

// Apr 24 2026 v1.5 — live in-flight scoring for today's rows across all TFs.
// Called from a 5-min cron during market hours. Updates row.liveMovePct /
// row.liveAdvPct / row.liveStatus so the History tab shows partial progress
// before tomorrow's final eval fires.
async function updateLiveScores() {
  try {
    var history = loadHistory();
    var today = todayET();
    if (!isTradingDayET(today)) return;
    var token = await getToken();
    if (!token) return;
    var updated = 0;
    for (var i = 0; i < (history.days || []).length; i++) {
      var day = history.days[i];
      if (day.date !== today) continue;
      var dayTf = day.tf || 'Daily';
      var evalCfg = {
        'Daily': { unit: 'Daily',  interval: 1,   winThresh: 1.0 },
        '4HR':   { unit: 'Minute', interval: 240, winThresh: 0.8 },
        '60m':   { unit: 'Minute', interval: 60,  winThresh: 0.5 },
        '1HR':   { unit: 'Minute', interval: 60,  winThresh: 0.5 },
        '30m':   { unit: 'Minute', interval: 30,  winThresh: 0.3 },
      }[dayTf] || { unit: 'Daily', interval: 1, winThresh: 1.0 };
      for (var j = 0; j < (day.rows || []).length; j++) {
        var row = day.rows[j];
        if (row.outcome) continue;
        if (!row.price) continue;
        // Get recent bars since signal — max 20 bars covers full session for intraday
        try {
          var bars = await fetchBars(row.ticker, evalCfg.unit, evalCfg.interval, 20, token);
          if (!bars || bars.length < 2) continue;
          var tfBars = bars.map(normBar).filter(Boolean);
          if (!tfBars.length) continue;
          // Max/min across today's bars after signal anchor (approximate: last N bars)
          var anchor = row.price;
          var maxUp = Math.max.apply(null, tfBars.map(function(b){return b.h;})) - anchor;
          var maxDn = anchor - Math.min.apply(null, tfBars.map(function(b){return b.l;}));
          var movePct = (row.dir === 'BULL' ? (maxUp / anchor) : (maxDn / anchor)) * 100;
          var advPct  = (row.dir === 'BULL' ? (maxDn / anchor) : (maxUp / anchor)) * 100;
          row.liveMovePct = +movePct.toFixed(2);
          row.liveAdvPct  = +advPct.toFixed(2);
          if (movePct >= evalCfg.winThresh && movePct > advPct) row.liveStatus = 'WIN_IN_PROGRESS';
          else if (advPct >= evalCfg.winThresh) row.liveStatus = 'DRAWDOWN';
          else row.liveStatus = 'FLAT';
          row.liveUpdatedAt = new Date().toISOString();
          updated++;
        } catch(e) { /* skip row on error */ }
      }
    }
    if (updated > 0) {
      saveHistory(history);
      console.log('[HIST-LIVE] Updated live scores on ' + updated + ' rows');
    }
  } catch(e) { console.error('[HIST-LIVE] updateLiveScores error:', e.message); }
}

// Apr 24 2026 v1.5 — TIER 5 confluence-sliced win-rate. Given a filter map
// (e.g., {ftfcAligned: true, gexRegime: 'POSITIVE', flow: 'BULL'}), returns
// aggregated stats only for rows that match ALL filters. This is the edge-
// discovery engine — lets AB ask "what combination actually wins for me?"
function getHistoryBreakdown(filters, opts) {
  opts = opts || {};
  var tfFilter = opts.tf || null;  // 'Daily' | '30m' | '60m' | '4HR' | null (all)
  var days = opts.days || 30;
  var h = loadHistory();
  var recent = (h.days || []).slice(-days);
  var stats = { total: 0, wins: 0, partials: 0, losses: 0, flat: 0, pending: 0, avgPeakPct: null, avgMovePct: null };
  var peakPcts = [];
  var movePcts = [];
  var matchedRows = [];
  recent.forEach(function(d) {
    if (tfFilter && (d.tf || 'Daily') !== tfFilter) return;
    (d.rows || []).forEach(function(r) {
      // Apply every filter — row must match ALL
      var pass = true;
      Object.keys(filters || {}).forEach(function(k) {
        if (!pass) return;
        var want = filters[k];
        var got = r[k];
        // Support min-value filters via "min:X" prefix (e.g. flowTotal: "min:1000000")
        if (typeof want === 'string' && want.indexOf('min:') === 0) {
          var minV = parseFloat(want.slice(4));
          if (!(typeof got === 'number' && got >= minV)) pass = false;
        } else if (typeof want === 'string' && want.indexOf('max:') === 0) {
          var maxV = parseFloat(want.slice(4));
          if (!(typeof got === 'number' && got <= maxV)) pass = false;
        } else {
          if (got !== want) pass = false;
        }
      });
      if (!pass) return;
      stats.total++;
      if (!r.outcome) { stats.pending++; return; }
      if (r.outcome === 'WIN')     stats.wins++;
      if (r.outcome === 'PARTIAL') stats.partials++;
      if (r.outcome === 'LOSS')    stats.losses++;
      if (r.outcome === 'FLAT')    stats.flat++;
      if (typeof r.peakPct === 'number') peakPcts.push(r.peakPct);
      if (typeof r.movePct === 'number') movePcts.push(r.movePct);
      matchedRows.push({ date: d.date, tf: d.tf || 'Daily', ticker: r.ticker, signal: r.signal, dir: r.dir, outcome: r.outcome, peakPct: r.peakPct || null, movePct: r.movePct || null });
    });
  });
  if (peakPcts.length) stats.avgPeakPct = +(peakPcts.reduce(function(a,b){return a+b;}, 0) / peakPcts.length).toFixed(1);
  if (movePcts.length) stats.avgMovePct = +(movePcts.reduce(function(a,b){return a+b;}, 0) / movePcts.length).toFixed(2);
  var graded = stats.wins + stats.partials + stats.losses;
  stats.hitRate = graded > 0 ? +((stats.wins + stats.partials) / graded).toFixed(3) : null;
  return { filters: filters || {}, tf: tfFilter, days: days, stats: stats, matchedRows: matchedRows.slice(-200) };
}

function getHistory(days, tfFilter) {
  days = days || 5;
  var h = loadHistory();
  var allDays = h.days || [];
  // Filter by tf if requested, else return all TFs (each day-entry has its own .tf)
  var filtered = tfFilter ? allDays.filter(function(d) { return (d.tf || 'Daily') === tfFilter; }) : allDays;
  var recent = filtered.slice(-days * 4);  // * 4 because up to 4 TFs can snapshot same date
  var stats = {
    total: 0, wins: 0, partials: 0, losses: 0, flat: 0, pending: 0,
    avgPeakPct: null, bySignal: {}, byTf: {}
  };
  var peakPcts = [];
  recent.forEach(function(d) {
    var dTf = d.tf || 'Daily';
    var tfBucket = stats.byTf[dTf] = stats.byTf[dTf] || { total: 0, wins: 0, partials: 0, losses: 0, flat: 0, pending: 0 };
    (d.rows || []).forEach(function(r) {
      stats.total++; tfBucket.total++;
      var bucket = stats.bySignal[r.signal] = stats.bySignal[r.signal]
        || { total: 0, wins: 0, partials: 0, losses: 0, flat: 0, avgPeakPct: null, _peaks: [] };
      bucket.total++;
      if (r.outcome === 'WIN')          { stats.wins++;     bucket.wins++;     tfBucket.wins++; }
      else if (r.outcome === 'PARTIAL') { stats.partials++; bucket.partials++; tfBucket.partials++; }
      else if (r.outcome === 'LOSS')    { stats.losses++;   bucket.losses++;   tfBucket.losses++; }
      else if (r.outcome === 'FLAT')    { stats.flat++;     bucket.flat++;     tfBucket.flat++; }
      else { stats.pending++; tfBucket.pending++; }
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

// ----------------------------------------------------------------------------
// GEX ENRICHMENT (Apr 24 2026 — Phase 1 of scanner upgrade)
// ----------------------------------------------------------------------------
// Pulls gamma pin, regime, expected range, nearest walls for each row.
// Performance: enriches only TOP 15 rows by rowScore (avoid 500ms × 60 = 30s delay).
// Degrades gracefully if gex module unavailable or CBOE fetch fails.
async function enrichTopRowsWithGex(groups, rowScoreFn) {
  if (!gex || !gex.getGammaLevels) return;
  // Collect top-scoring rows from each group, dedupe by ticker
  var allRows = [];
  Object.keys(groups).forEach(function(k) {
    (groups[k] || []).forEach(function(r) { allRows.push(r); });
  });
  // Rank by rowScore, take top 15 across all groups
  allRows.sort(function(a, b) { return rowScoreFn(b) - rowScoreFn(a); });
  var topRows = allRows.slice(0, 15);
  var seen = {};
  var topTickers = [];
  topRows.forEach(function(r) {
    if (!seen[r.ticker]) { seen[r.ticker] = true; topTickers.push(r.ticker); }
  });
  if (!topTickers.length) return;
  // Fetch GEX sequentially with throttle (CBOE rate limit friendly)
  for (var i = 0; i < topTickers.length; i++) {
    try {
      var g = await gex.getGammaLevels(topTickers[i]);
      if (!g) continue;
      // Merge into all rows matching this ticker
      topRows.forEach(function(r) {
        if (r.ticker === topTickers[i]) {
          var wallAbove = (g.walls || []).filter(function(w) { return w.strike > r.price && w.type === 'CALL_WALL'; })[0];
          var wallBelow = (g.walls || []).filter(function(w) { return w.strike < r.price && w.type === 'PUT_WALL'; }).pop();
          r.gex = {
            pin: g.pin,
            regime: g.regime,                 // "POSITIVE" | "NEGATIVE"
            gammaFlip: g.gammaFlip,
            expectedHigh: g.expectedHigh,
            expectedLow: g.expectedLow,
            expectedMove: g.expectedMove,
            totalNetGex: g.totalNetGex,
            wallAbove: wallAbove ? { strike: wallAbove.strike, gex: wallAbove.gex } : null,
            wallBelow: wallBelow ? { strike: wallBelow.strike, gex: wallBelow.gex } : null,
          };
        }
      });
    } catch(e) { /* skip bad ticker, continue */ }
    // 300ms throttle between GEX fetches
    if (i < topTickers.length - 1) await new Promise(function(r){ setTimeout(r, 300); });
  }
}

// ----------------------------------------------------------------------------
// IN-FORCE STATUS (Apr 24 2026 — Phase 2 of scanner upgrade)
// ----------------------------------------------------------------------------
// Computes whether setup is still actionable given current price action.
// Returns: "ACTIVE" | "TRIGGERED" | "INVALIDATED" | "EXPIRED"
// - ACTIVE: price near trigger but hasn't broken yet (setup cocked)
// - TRIGGERED: price broke through trigger (setup in motion)
// - INVALIDATED: price moved far against trigger (setup dead, skip)
// - EXPIRED: signal was from yesterday and no follow-through by mid-day
function computeInForceForRow(r) {
  if (!r || !r.trigger || !r.price) { r.inForce = null; return; }

  var price = r.price;
  var trigger = r.trigger;
  var signal = r.signal || '';
  var isBull = /up|2U|Hammer|Failed 2D|Continuation Up/i.test(signal);
  var isBear = /down|2D|Shooter|Failed 2U|Continuation Down/i.test(signal);
  var dir = isBull ? 'long' : (isBear ? 'short' : null);

  if (!dir) { r.inForce = null; return; }

  var tolerance = trigger * 0.03; // 3% wiggle room
  if (dir === 'long') {
    if (price < trigger - tolerance * 2)      r.inForce = 'INVALIDATED'; // 6%+ below
    else if (price < trigger - tolerance)     r.inForce = 'EXPIRED';     // 3-6% below
    else if (price < trigger)                 r.inForce = 'ACTIVE';      // within 3% below
    else                                      r.inForce = 'TRIGGERED';   // above
  } else {
    if (price > trigger + tolerance * 2)      r.inForce = 'INVALIDATED';
    else if (price > trigger + tolerance)     r.inForce = 'EXPIRED';
    else if (price > trigger)                 r.inForce = 'ACTIVE';
    else                                      r.inForce = 'TRIGGERED';
  }
}

async function scan(opts) {
  opts = opts || {};
  var tf = opts.tf || 'Daily';
  // Apr 24 2026 — accept more timeframes
  var validTFs = ['30m','60m','1HR','4HR','4h','Daily','Weekly','W','Monthly','M'];
  if (validTFs.indexOf(tf) === -1) tf = 'Daily';
  var concurrency = opts.concurrency || 6;
  if (_running[tf] && !opts.force) return _lastScan[tf];
  _running[tf] = true;
  var startedAt = Date.now();
  _resetEnrichBudget(); // Apr 21 2026 PM v3 — fresh card budget per scan

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

    // Apr 24 2026 — Phase 1: GEX enrichment for top-conviction rows
    // Pulls gamma pin/regime/expected-range for the top 15 rows across all groups.
    // Keeps scan fast by only enriching actionable candidates (not all 60+).
    await enrichTopRowsWithGex(groups, rowScore);

    // Apr 24 2026 — Phase 2: Compute in-force status for ALL rows (fast, synchronous)
    rows.forEach(computeInForceForRow);

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
    // Snapshot ALL timeframes for history — Apr 24 2026 v1.5 so scalp/day-trade
    // setups accumulate outcome data alongside swings. Evaluation windows are
    // TF-appropriate (30m→next 2hr, 60m→next 4hr, 4HR→next day, Daily→3 days).
    snapshotHistory(result).catch(function(e) { console.error('[SCANNER] history ' + tf + ':', e.message); });
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
  updateLiveScores: updateLiveScores,
  getHistoryBreakdown: getHistoryBreakdown,
  // Trade builder
  buildTradeItem: buildTradeItem,
  queueFromRow: queueFromRow,
  // exported for testing
  classifyBar: classifyBar,
  detectSignal: detectSignal,
};
