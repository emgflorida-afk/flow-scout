// ayceScout.js -- Stratum
// -----------------------------------------------------------------
// AYCE ATH Scout. Auto-detects AYCE market-open reversal setups on
// SPY/QQQ (plus mega-caps) using TradeStation bar data and auto-
// queues qualifying trades via brainEngine.bulkAddQueuedTrades.
//
// Strategies implemented:
//  1) 12HR Miyagi       (FULL — 60m bar aggregation into 12HR blocks)
//  2) 4HR Re-Trigger    (FULL — 240m bars, 2-2 reversal, 9:30 break)
//  3) 3-2-2 First Live  (FULL — 60m bars, fires after 10 AM)
//  4) 7HR Liquidity Sweep (SIMPLIFIED — 4AM premarket range + 5m sweep, QQQ only)
//  5) Failed 9          (FULL — 60m bars, 8AM/9AM, fires 9:30+)
//
// Pattern mirrors stratEntry.js / caseyEntry.js: pollOnce() + run alias,
// STATE_DIR dedup, Discord confirm via DISCORD_EXECUTE_NOW_WEBHOOK,
// bulkAddQueuedTrades push.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs = require('fs');

// -----------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------
// Synced with preMarketScanner so anything alerted at 4AM can get queued at 9AM
var DEFAULT_WATCHLIST = 'SPY,QQQ,IWM,NVDA,AAPL,GOOGL,MSFT,AMZN,TSLA,META,MRVL,AVGO,COIN,JPM,GS,MS,WFC,LMT,RTX,NOC,GD,LDOS,BAH,DAL,UAL,LUV,AAL,XOM,CVX,OXY,XLE,U,ABNB,UBER,BIDU,MCD,FAST,TSM,NFLX,ASML,BAC,JNJ,UNH,PGR,SMH';
var EXTENDED_WATCH    = DEFAULT_WATCHLIST;

function getWatchlist() {
  try { var rc = require('./runtimeConfig'); var v = rc.get('AYCE_WATCHLIST'); if (v) return v.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean); } catch(e){}
  var raw = process.env.AYCE_WATCHLIST || DEFAULT_WATCHLIST;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// -----------------------------------------------------------------
// DEDUP
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var DEDUP_FILE = STATE_DIR + '/ayce_dedup.json';
var DEDUP_MS = 4 * 60 * 60 * 1000; // 4 hours

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      return JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')) || {};
    }
  } catch(e) { console.error('[AYCE] dedup load:', e.message); }
  return {};
}
function saveDedup(d) {
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(d)); }
  catch(e) { console.error('[AYCE] dedup save:', e.message); }
}
function dedupKey(ticker, strategy, tradeDate) {
  return ticker + ':' + strategy + ':' + tradeDate;
}
function isDuplicate(d, key) {
  var t = d[key];
  return t && (Date.now() - t < DEDUP_MS);
}
function pruneDedup(d) {
  var cutoff = Date.now() - DEDUP_MS;
  Object.keys(d).forEach(function(k){ if (d[k] < cutoff) delete d[k]; });
}

// -----------------------------------------------------------------
// DATE / TIME HELPERS (Eastern Time)
// -----------------------------------------------------------------
function todayET() {
  var d = new Date();
  var etStr = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  // mm/dd/yyyy -> yyyy-mm-dd
  var parts = etStr.split('/');
  return parts[2] + '-' + parts[0] + '-' + parts[1];
}

function nowETHour() {
  var d = new Date();
  var etStr = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  var hm = etStr.split(':');
  return { h: parseInt(hm[0], 10), m: parseInt(hm[1], 10) };
}

// parse TS bar timestamp into ET hour-of-day
function barETHour(bar) {
  var ts = bar.TimeStamp || bar.timestamp || bar.Timestamp;
  if (!ts) return null;
  try {
    var d = new Date(ts);
    var etStr = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    var hm = etStr.split(':');
    return { h: parseInt(hm[0], 10), m: parseInt(hm[1], 10), iso: ts };
  } catch(e) { return null; }
}

// -----------------------------------------------------------------
// TRADESTATION BARS
// -----------------------------------------------------------------
async function tsBars(ticker, unit, interval, barsback, token, session) {
  try {
    var sess = session || 'Default';
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker +
      '?interval=' + interval + '&unit=' + unit +
      '&barsback=' + barsback + '&sessiontemplate=' + sess;
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) {
      console.error('[AYCE] bars ' + ticker + ' ' + unit + interval + ' ' + res.status);
      return [];
    }
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) {
    console.error('[AYCE] bars error ' + ticker + ':', e.message);
    return [];
  }
}

function normBar(b) {
  if (!b) return null;
  return {
    o: parseFloat(b.Open || b.open || 0),
    h: parseFloat(b.High || b.high || 0),
    l: parseFloat(b.Low  || b.low  || 0),
    c: parseFloat(b.Close|| b.close|| 0),
    ts: b.TimeStamp || b.timestamp || b.Timestamp || null,
    raw: b,
  };
}

// -----------------------------------------------------------------
// STRAT CLASSIFICATION (same as stratEntry)
// -----------------------------------------------------------------
function classify(bar, prev) {
  if (!bar || !prev) return null;
  var took2U = bar.h > prev.h;
  var took2D = bar.l < prev.l;
  var inside  = (bar.h <= prev.h) && (bar.l >= prev.l);
  var outside = took2U && took2D;
  var is2U = took2U && !outside;
  var is2D = took2D && !outside;
  return {
    took2U: took2U, took2D: took2D,
    inside: inside, outside: outside,
    is1: inside, is3: outside, is2U: is2U, is2D: is2D,
  };
}

// -----------------------------------------------------------------
// STRATEGY 1: 12HR MIYAGI (1-3-1 Sequence)
// -----------------------------------------------------------------
// Aggregates 60-min bars into 12HR candles anchored at 4AM/4PM ET.
// Pattern: 1-3-1 (inside → outside → inside). Entry on 4th candle.
// Trigger = 50% of 3rd candle. 2UP above trigger → PUTS, 2DOWN below → CALLS.
async function detectMiyagi(ticker, token) {
  // Pull ~72 hours of 60m bars to build ~6 12HR candles
  var bars = await tsBars(ticker, 'Minute', 60, 72, token, 'USEQPreAndPost');
  if (!bars || bars.length < 24) return null;
  var normed = bars.map(normBar).filter(Boolean);

  // Aggregate into 12HR blocks anchored at 4AM and 4PM ET
  // Block boundaries: 4:00 AM → 3:59 PM (day session), 4:00 PM → 3:59 AM (night session)
  var blocks = [];
  var curBlock = null;
  for (var i = 0; i < normed.length; i++) {
    var b = normed[i];
    var et = barETHour(b.raw);
    if (!et) continue;
    // Determine which 12HR block this bar belongs to
    // 4AM-15:59 → block anchor = that day 4AM
    // 16:00-3:59 → block anchor = that day 4PM (or prev day)
    var blockKey;
    var bDate = new Date(b.ts);
    var ymd = bDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (et.h >= 4 && et.h < 16) {
      blockKey = ymd + '_4AM';
    } else {
      blockKey = ymd + '_4PM';
      if (et.h < 4) {
        // Past midnight but before 4AM — belongs to PREVIOUS day's 4PM block
        var prev = new Date(bDate.getTime() - 86400000);
        blockKey = prev.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) + '_4PM';
      }
    }
    if (!curBlock || curBlock.key !== blockKey) {
      curBlock = { key: blockKey, o: b.o, h: b.h, l: b.l, c: b.c, ts: b.ts };
      blocks.push(curBlock);
    } else {
      if (b.h > curBlock.h) curBlock.h = b.h;
      if (b.l < curBlock.l) curBlock.l = b.l;
      curBlock.c = b.c; // close of last bar in block
    }
  }

  if (blocks.length < 4) return null;

  // Look for 1-3-1-? pattern in last 4 blocks
  // blocks[-4]=1st, [-3]=2nd(3), [-2]=3rd(1), [-1]=4th(live)
  var b1 = blocks[blocks.length - 4];
  var b2 = blocks[blocks.length - 3];
  var b3 = blocks[blocks.length - 2];
  var b4 = blocks[blocks.length - 1];

  var cls1 = classify(b2, b1); // 2nd vs 1st: should be outside(3)
  var cls2 = classify(b3, b2); // 3rd vs 2nd: should be inside(1)
  var cls3 = classify(b4, b3); // 4th vs 3rd: should be 2U or 2D

  if (!cls1 || !cls2 || !cls3) return null;
  if (!cls1.is3) return null;  // 2nd must be outside bar
  if (!cls2.is1) return null;  // 3rd must be inside bar

  // Invalidation: 3rd candle became outside (3) — means it already went outside-3
  // which invalidates the setup
  // cls2.is1 already checked above, so we're good

  // Trigger = 50% of 3rd candle (the inside bar)
  var trigger = (b3.h + b3.l) / 2;

  // 4th candle must be 2UP or 2DOWN
  if (cls3.is2U) {
    // 2UP above trigger → PUTS (reversal setup)
    if (b4.c > trigger) {
      return {
        strategy: 'STRATUMFAILURE_MIYAGI',
        ticker: ticker,
        direction: 'PUTS',
        trigger: trigger,
        triggerPrice: b3.l, // entry when price breaks below 3rd candle low
        stop: b4.h, // above the 4th candle high
        note: 'Miyagi 1-3-1: 4th candle 2UP above 50% trigger $' + trigger.toFixed(2) + ' → PUTS',
        signalBarHigh: b4.h,
        signalBarLow: b3.l,
        waitUntil: '09:30',
      };
    }
  } else if (cls3.is2D) {
    // 2DOWN below trigger → CALLS (reversal setup)
    if (b4.c < trigger) {
      return {
        strategy: 'STRATUMFAILURE_MIYAGI',
        ticker: ticker,
        direction: 'CALLS',
        trigger: trigger,
        triggerPrice: b3.h, // entry when price breaks above 3rd candle high
        stop: b4.l, // below the 4th candle low
        note: 'Miyagi 1-3-1: 4th candle 2DOWN below 50% trigger $' + trigger.toFixed(2) + ' → CALLS',
        signalBarHigh: b3.h,
        signalBarLow: b4.l,
        waitUntil: '09:30',
      };
    }
  }

  return null;
}

// -----------------------------------------------------------------
// STRATEGY 2: 4HR RE-TRIGGER (FULL)
// -----------------------------------------------------------------
// Pull 240m bars with pre+post session. Find today's 4AM bar and
// 8AM bar (ET). 4AM must be 2U/2D, 8AM must reverse.
async function detect4HRReTrigger(ticker, token) {
  var bars = await tsBars(ticker, 'Minute', 240, 20, token, 'USEQPreAndPost');
  if (!bars || bars.length < 4) return null;
  var normed = bars.map(normBar).filter(Boolean);

  // Find the 4AM ET and 8AM ET bars for *today*
  var today = todayET();
  var bar4am = null, bar8am = null;
  for (var i = 0; i < normed.length; i++) {
    var b = normed[i];
    var et = barETHour(b.raw);
    if (!et) continue;
    var bDate = new Date(b.ts);
    var bDateET = bDate.toLocaleString('en-US', { timeZone: 'America/New_York' });
    // Rough same-day match: compare the yyyy-mm-dd of the bar in ET to today
    var bDateStr = (function(){
      var s = bDate.toLocaleString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
      var p = s.split('/'); return p[2] + '-' + p[0] + '-' + p[1];
    })();
    if (bDateStr !== today) continue;
    if (et.h === 4) bar4am = b;
    else if (et.h === 8) bar8am = b;
  }

  if (!bar4am || !bar8am) return null;

  // We need the bar prior to 4AM (previous day 12AM or afterhours) for classification.
  // Use bar immediately before bar4am in the series.
  var idx4 = normed.indexOf(bar4am);
  if (idx4 < 1) return null;
  var prev4 = normed[idx4 - 1];
  var cls4 = classify(bar4am, prev4);
  if (!cls4) return null;

  // 8AM classification against 4AM
  var cls8 = classify(bar8am, bar4am);
  if (!cls8) return null;

  // CALLS: 4AM 2D + 8AM 2U
  if (cls4.is2D && cls8.is2U) {
    return {
      strategy: 'STRATUMFAILURE_RETRIGGER',
      direction: 'CALLS',
      triggerPrice: bar4am.h,
      signalBarHigh: bar4am.h,
      signalBarLow: bar4am.l,
      note: '4HR ReTrig CALLS: 4AM=2D 8AM=2U, break above 4AM high ' + bar4am.h.toFixed(2),
    };
  }
  // PUTS: 4AM 2U + 8AM 2D
  if (cls4.is2U && cls8.is2D) {
    return {
      strategy: 'STRATUMFAILURE_RETRIGGER',
      direction: 'PUTS',
      triggerPrice: bar4am.l,
      signalBarHigh: bar4am.h,
      signalBarLow: bar4am.l,
      note: '4HR ReTrig PUTS: 4AM=2U 8AM=2D, break below 4AM low ' + bar4am.l.toFixed(2),
    };
  }
  return null;
}

// -----------------------------------------------------------------
// STRATEGY 3: 3-2-2 FIRST LIVE (FULL)
// -----------------------------------------------------------------
// 60m bars. 8AM=3 (outside), 9AM=2. Entry at 10AM against 9AM.
async function detect322FirstLive(ticker, token) {
  var bars = await tsBars(ticker, 'Minute', 60, 20, token, 'USEQPreAndPost');
  if (!bars || bars.length < 4) return null;
  var normed = bars.map(normBar).filter(Boolean);

  var today = todayET();
  var bar8 = null, bar9 = null, bar7 = null;
  for (var i = 0; i < normed.length; i++) {
    var b = normed[i];
    var bDate = new Date(b.ts);
    var bDateStr = (function(){
      var s = bDate.toLocaleString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
      var p = s.split('/'); return p[2] + '-' + p[0] + '-' + p[1];
    })();
    if (bDateStr !== today) continue;
    var et = barETHour(b.raw);
    if (!et) continue;
    if (et.h === 7) bar7 = b;
    else if (et.h === 8) bar8 = b;
    else if (et.h === 9) bar9 = b;
  }

  if (!bar8 || !bar9) return null;
  // Need bar before bar8 to classify it as outside
  var idx8 = normed.indexOf(bar8);
  var prior8 = bar7 || (idx8 > 0 ? normed[idx8 - 1] : null);
  if (!prior8) return null;

  var cls8 = classify(bar8, prior8);
  if (!cls8 || !cls8.is3) return null; // need outside bar

  var cls9 = classify(bar9, bar8);
  if (!cls9) return null;

  // Reversal: 9AM 2D -> enter CALLS on break above 9AM high
  if (cls9.is2D) {
    return {
      strategy: 'STRATUMFAILURE_322',
      direction: 'CALLS',
      triggerPrice: bar9.h,
      signalBarHigh: bar9.h,
      signalBarLow: bar9.l,
      note: '3-2-2 CALLS: 8AM=3 9AM=2D, break above 9AM high ' + bar9.h.toFixed(2),
    };
  }
  // Reversal: 9AM 2U -> PUTS on break below 9AM low
  if (cls9.is2U) {
    return {
      strategy: 'STRATUMFAILURE_322',
      direction: 'PUTS',
      triggerPrice: bar9.l,
      signalBarHigh: bar9.h,
      signalBarLow: bar9.l,
      note: '3-2-2 PUTS: 8AM=3 9AM=2U, break below 9AM low ' + bar9.l.toFixed(2),
    };
  }
  return null;
}

// -----------------------------------------------------------------
// STRATEGY 4: 7HR LIQUIDITY SWEEP (SIMPLIFIED)
// -----------------------------------------------------------------
// Simplified: use the 4AM 60m bar as a proxy "3-bar" premarket range.
// After 11 AM ET, check 5-min bars for a sweep/retest of 4AM high or low.
async function detect7HRSweep(ticker, token) {
  var now = nowETHour();
  if (now.h < 11) return null; // only fires after 11 AM

  // Get the 4AM 60m bar
  var bars60 = await tsBars(ticker, 'Minute', 60, 20, token, 'USEQPreAndPost');
  if (!bars60 || bars60.length < 4) return null;
  var normed60 = bars60.map(normBar).filter(Boolean);

  var today = todayET();
  var bar4 = null;
  for (var i = 0; i < normed60.length; i++) {
    var b = normed60[i];
    var bDate = new Date(b.ts);
    var bDateStr = (function(){
      var s = bDate.toLocaleString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
      var p = s.split('/'); return p[2] + '-' + p[0] + '-' + p[1];
    })();
    if (bDateStr !== today) continue;
    var et = barETHour(b.raw);
    if (et && et.h === 4) { bar4 = b; break; }
  }
  if (!bar4) return null;

  // 5-min bars after 11 AM to detect sweep
  var bars5 = await tsBars(ticker, 'Minute', 5, 80, token, 'USEQPreAndPost');
  if (!bars5 || bars5.length < 3) return null;
  var normed5 = bars5.map(normBar).filter(Boolean);

  var after11 = [];
  for (var j = 0; j < normed5.length; j++) {
    var bb = normed5[j];
    var d = new Date(bb.ts);
    var dStr = (function(){
      var s = d.toLocaleString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
      var p = s.split('/'); return p[2] + '-' + p[0] + '-' + p[1];
    })();
    if (dStr !== today) continue;
    var et5 = barETHour(bb.raw);
    if (et5 && et5.h >= 11) after11.push(bb);
  }
  if (after11.length < 2) return null;

  // Failed breakout above 4AM high: any 5m bar broke above then closed back below
  var highSweep = false, lowSweep = false;
  for (var k = 0; k < after11.length; k++) {
    var bar = after11[k];
    if (bar.h > bar4.h && bar.c < bar4.h) highSweep = true;
    if (bar.l < bar4.l && bar.c > bar4.l) lowSweep  = true;
  }

  // Check current bar confirms reversal direction
  var last5 = after11[after11.length - 1];
  if (highSweep && last5.c < bar4.h) {
    return {
      strategy: 'STRATUMFAILURE_SWEEP',
      direction: 'PUTS',
      triggerPrice: bar4.h,
      signalBarHigh: bar4.h,
      signalBarLow: bar4.l,
      note: '7HR Sweep PUTS: failed breakout above 4AM high ' + bar4.h.toFixed(2),
    };
  }
  if (lowSweep && last5.c > bar4.l) {
    return {
      strategy: 'STRATUMFAILURE_SWEEP',
      direction: 'CALLS',
      triggerPrice: bar4.l,
      signalBarHigh: bar4.h,
      signalBarLow: bar4.l,
      note: '7HR Sweep CALLS: failed breakdown below 4AM low ' + bar4.l.toFixed(2),
    };
  }
  return null;
}

// -----------------------------------------------------------------
// STRATEGY 5: FAILED 9 (FULL)
// -----------------------------------------------------------------
// 60m bars. 8AM + 9AM. 9AM must be 2U or 2D. After open, expect
// failure back through 50% of 8AM.
async function detectFailed9(ticker, token) {
  var bars = await tsBars(ticker, 'Minute', 60, 20, token, 'USEQPreAndPost');
  if (!bars || bars.length < 4) return null;
  var normed = bars.map(normBar).filter(Boolean);

  var today = todayET();
  var bar7 = null, bar8 = null, bar9 = null;
  for (var i = 0; i < normed.length; i++) {
    var b = normed[i];
    var bDate = new Date(b.ts);
    var bDateStr = (function(){
      var s = bDate.toLocaleString('en-US', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
      var p = s.split('/'); return p[2] + '-' + p[0] + '-' + p[1];
    })();
    if (bDateStr !== today) continue;
    var et = barETHour(b.raw);
    if (!et) continue;
    if (et.h === 7) bar7 = b;
    else if (et.h === 8) bar8 = b;
    else if (et.h === 9) bar9 = b;
  }

  if (!bar8 || !bar9) return null;
  var idx8 = normed.indexOf(bar8);
  var prior8 = bar7 || (idx8 > 0 ? normed[idx8 - 1] : null);
  if (!prior8) return null;

  // classify 9AM vs 8AM
  var cls9 = classify(bar9, bar8);
  if (!cls9) return null;

  var mid8 = (bar8.h + bar8.l) / 2;

  // 9AM 2U + price below 50% (put trigger): expect pullback into 50% -> PUTS
  if (cls9.is2U && bar9.c > bar8.h) {
    return {
      strategy: 'STRATUMFAILURE_FAILED9',
      direction: 'PUTS',
      triggerPrice: mid8,
      signalBarHigh: bar9.h,
      signalBarLow: bar9.l,
      note: 'Failed9 PUTS: 9AM=2U, pullback to 8AM 50% ' + mid8.toFixed(2),
    };
  }
  // 9AM 2D + expect push up into 50% -> CALLS
  if (cls9.is2D && bar9.c < bar8.l) {
    return {
      strategy: 'STRATUMFAILURE_FAILED9',
      direction: 'CALLS',
      triggerPrice: mid8,
      signalBarHigh: bar9.h,
      signalBarLow: bar9.l,
      note: 'Failed9 CALLS: 9AM=2D, push to 8AM 50% ' + mid8.toFixed(2),
    };
  }
  return null;
}

// -----------------------------------------------------------------
// FTFC SOFT CHECK
// -----------------------------------------------------------------
function ftfcAgrees(direction, ftfc) {
  if (!ftfc || !ftfc.state) return true; // soft-fail
  var state = ftfc.state;
  if (direction === 'CALLS') {
    return state !== 'FTFC DOWN' && state !== 'mostly DOWN';
  }
  return state !== 'FTFC UP' && state !== 'mostly UP';
}

// -----------------------------------------------------------------
// QUEUE ITEM BUILDER
// -----------------------------------------------------------------
function pickFridayExpiry(daysOut) {
  var d = new Date();
  d.setDate(d.getDate() + (daysOut || 3));
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

function buildContractSymbol(ticker, direction, strike, expDate) {
  var yy = String(expDate.getFullYear()).slice(2);
  var mm = String(expDate.getMonth() + 1).padStart(2, '0');
  var dd = String(expDate.getDate()).padStart(2, '0');
  var cp = direction === 'CALLS' ? 'C' : 'P';
  return ticker + ' ' + yy + mm + dd + cp + strike;
}

function buildItem(ticker, sig, currentPrice) {
  var expDate = pickFridayExpiry(3);
  var strike  = Math.round(currentPrice);
  var contractType = sig.direction === 'CALLS' ? 'Call' : 'Put';
  var contractSymbol = buildContractSymbol(ticker, sig.direction, strike, expDate);
  var mm = String(expDate.getMonth() + 1).padStart(2, '0');
  var dd = String(expDate.getDate()).padStart(2, '0');
  var yyyy = String(expDate.getFullYear());
  var expStr = mm + '-' + dd + '-' + yyyy;

  return {
    ticker: ticker,
    direction: sig.direction,
    triggerPrice: Number(sig.triggerPrice.toFixed(2)),
    contractSymbol: contractSymbol,
    strike: strike,
    expiration: expStr,
    contractType: contractType,
    maxEntryPrice: 4.00,
    stopPct: -0.30,
    contracts: 2,
    tradeDate: todayET(),
    tradeType: 'DAY',
    grade: 'A',
    source: sig.strategy,
    note: sig.note,
    signalBarHigh: Number(sig.signalBarHigh.toFixed(2)),
    signalBarLow: Number(sig.signalBarLow.toFixed(2)),
    targets: [0.25, 0.50, 1.00],
    management: 'AYCE',
  };
}

// -----------------------------------------------------------------
// DISCORD CONFIRM
// -----------------------------------------------------------------
async function postConfirmAlert(item, sig, ftfcDir) {
  var webhookUrl = process.env.DISCORD_STRATUMFAILURE_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhookUrl) return;
  try {
    var lines = [
      'AYCE ' + sig.strategy + ' — ' + item.ticker + ' ' + item.direction,
      '--------------------------------',
      'Trigger:  ' + (item.direction === 'CALLS' ? '>= ' : '<= ') + '$' + item.triggerPrice,
      'Contract: ' + item.contractSymbol + ' x' + item.contracts,
      'Max:      $' + item.maxEntryPrice.toFixed(2),
      'Stop:     -30% / 60-min flip',
      'TP:       25% / 50% / 100%',
      'FTFC:     ' + ftfcDir,
      'Mgmt:     AYCE (60-min flip exit)',
      '--------------------------------',
      'Note: ' + sig.note,
      'Status: PENDING — AYCE auto-queue',
    ].join('\n');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum AYCE Scout',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) {
    console.error('[AYCE] postConfirmAlert error:', e.message);
  }
}

// -----------------------------------------------------------------
// MAIN POLL
// -----------------------------------------------------------------
var _running = false;
async function pollOnce() {
  if (_running) {
    return { ok: false, checked: 0, queued: 0, skipped: 0, signals: [], reason: 'already running' };
  }
  _running = true;
  var checked = 0, queued = 0, skipped = 0;
  var queuedItems = [];
  var alerts = [];
  var signals = [];

  try {
    var ts;
    try { ts = require('./tradestation'); }
    catch(e) {
      console.error('[AYCE] require tradestation:', e.message);
      return { ok: false, checked: 0, queued: 0, skipped: 0, signals: [], reason: 'no ts module' };
    }

    var token;
    try { token = await ts.getAccessToken(); }
    catch(e) {
      console.error('[AYCE] no TS token:', e.message);
      return { ok: false, checked: 0, queued: 0, skipped: 0, signals: [], reason: 'no token' };
    }
    if (!token) {
      return { ok: false, checked: 0, queued: 0, skipped: 0, signals: [], reason: 'no token' };
    }

    var mb = null;
    try { mb = require('./morningBrief'); } catch(e) {}

    var dedup = loadDedup();
    pruneDedup(dedup);

    var tickers = getWatchlist();
    var tradeDate = todayET();

    for (var i = 0; i < tickers.length; i++) {
      var ticker = tickers[i];
      checked++;

      try {
        // Run each strategy; any errors contained per strategy
        var detectors = [
          { name: 'STRATUMFAILURE_MIYAGI',       fn: detectMiyagi },
          { name: 'STRATUMFAILURE_RETRIGGER',   fn: detect4HRReTrigger },
          { name: 'STRATUMFAILURE_322',fn: detect322FirstLive },
          { name: 'STRATUMFAILURE_FAILED9',      fn: detectFailed9 },
        ];
        // 7HR sweep on index ETFs (QQQ, SPY, IWM)
        if (ticker === 'QQQ' || ticker === 'SPY' || ticker === 'IWM') {
          detectors.push({ name: 'STRATUMFAILURE_SWEEP', fn: detect7HRSweep });
        }

        // Need a current price — pull 5m last bar
        var quoteBars = await tsBars(ticker, 'Minute', 5, 2, token, 'USEQPreAndPost');
        var last = (quoteBars && quoteBars.length) ? normBar(quoteBars[quoteBars.length - 1]) : null;
        var currentPrice = last ? last.c : 0;
        if (!currentPrice) { skipped++; continue; }

        for (var d = 0; d < detectors.length; d++) {
          var det = detectors[d];
          var sig = null;
          try {
            sig = await det.fn(ticker, token);
          } catch(e) {
            console.error('[AYCE] ' + det.name + ' ' + ticker + ' error: ' + e.message);
            continue;
          }
          if (!sig) continue;

          // REGIME GATE — block counter-trend entries
          var regimeGate = require('./regimeGate');
          var gate = await regimeGate.canEnter(ticker, sig.direction, token);
          if (!gate.allowed) {
            console.log('[AYCE] REGIME VETO ' + ticker + ' ' + sig.strategy + ': ' + gate.reason);
            skipped++;
            continue;
          }

          // FTFC check (regime gate already passed — this is secondary)
          var ftfcDir = 'N/A';
          if (mb && mb.checkFTFC) {
            try {
              var ftfc = await mb.checkFTFC(ticker, currentPrice, token);
              ftfcDir = ftfc && ftfc.state ? ftfc.state : 'N/A';
              if (!ftfcAgrees(sig.direction, ftfc)) {
                console.log('[AYCE] FTFC veto ' + ticker + ' ' + sig.strategy + ' (ftfc=' + ftfcDir + ')');
                skipped++;
                continue;
              }
            } catch(e) {
              console.log('[AYCE] FTFC fail ' + ticker + ': ' + e.message + ' — regime gate already passed, proceeding');
            }
          }

          // Dedup
          var key = dedupKey(ticker, sig.strategy, tradeDate);
          if (isDuplicate(dedup, key)) {
            skipped++;
            continue;
          }

          var item = buildItem(ticker, sig, currentPrice);
          queuedItems.push(item);
          alerts.push({ item: item, sig: sig, ftfcDir: ftfcDir });
          signals.push({ ticker: ticker, strategy: sig.strategy, direction: sig.direction, trigger: sig.triggerPrice });
          dedup[key] = Date.now();
          queued++;
        }
      } catch(e) {
        console.error('[AYCE] ticker loop ' + ticker + ' error:', e.message);
        skipped++;
      }
    }

    // Push to brain queue (SIGNAL-ONLY mode check Apr 18 2026)
    if (queuedItems.length > 0) {
      var ayceMode = process.env.BRAIN_AUTOFIRE_MODE || 'FULL';
      if (ayceMode === 'STRAT_ONLY') {
        console.log('[AYCE] SIGNAL-ONLY mode — ' + queuedItems.length + ' setups alerted to Discord, no auto-queue');
      } else {
        try {
          var be = require('./brainEngine');
          if (be && be.bulkAddQueuedTrades) {
            be.bulkAddQueuedTrades(queuedItems, { replaceAll: false });
          }
        } catch(e) { console.error('[AYCE] queue push error:', e.message); }
      }

      for (var a = 0; a < alerts.length; a++) {
        try {
          await postConfirmAlert(alerts[a].item, alerts[a].sig, alerts[a].ftfcDir);
        } catch(e) {
          console.error('[AYCE] alert error:', e.message);
        }
      }
    }

    saveDedup(dedup);

    console.log('[AYCE] pollOnce checked=' + checked + ' queued=' + queued + ' skipped=' + skipped);
    return { ok: true, checked: checked, queued: queued, skipped: skipped, signals: signals };
  } catch(e) {
    console.error('[AYCE] pollOnce error:', e.message);
    return { ok: false, checked: checked, queued: queued, skipped: skipped, signals: signals, reason: e.message };
  } finally {
    _running = false;
  }
}

async function run() { return await pollOnce(); }

module.exports = {
  pollOnce: pollOnce,
  run: run,
  // exported for testing
  classify: classify,
  detect4HRReTrigger: detect4HRReTrigger,
  detect322FirstLive: detect322FirstLive,
  detectFailed9: detectFailed9,
  detect7HRSweep: detect7HRSweep,
  detectMiyagi: detectMiyagi,
  ftfcAgrees: ftfcAgrees,
};
