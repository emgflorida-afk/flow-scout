// caseyEntry.js -- Stratum
// Standalone scout that auto-queues Casey PDH-retest (CALL) and
// PDL-breakdown (PUT) setups. caseyConfluence.js only scores; this acts.
// Mirrors jsmithPoller shape: pollOnce -> bulkAddQueuedTrades -> Discord.

var fetch = require('node-fetch');
var fs    = require('fs');

// -----------------------------------------------------------------
// STATE / DEDUP
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var DEDUP_FILE = STATE_DIR + '/casey_dedup.json';
var DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

var dedup = {};
function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      dedup = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')) || {};
    }
  } catch(e) { console.log('[CASEY] dedup load error: ' + e.message); }
}
function saveDedup() {
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(dedup)); }
  catch(e) { console.log('[CASEY] dedup save error: ' + e.message); }
}
loadDedup();

function dedupKey(ticker, direction) { return ticker + '|' + direction; }
function isDeduped(ticker, direction) {
  var k = dedupKey(ticker, direction);
  var last = dedup[k] || 0;
  return (Date.now() - last) < DEDUP_WINDOW_MS;
}
function markDeduped(ticker, direction) {
  dedup[dedupKey(ticker, direction)] = Date.now();
  saveDedup();
}

// -----------------------------------------------------------------
// WATCHLIST
// -----------------------------------------------------------------
var DEFAULT_WATCH = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL,NFLX,AVGO,COIN,CRM,UBER,SHOP,NOW,HOOD,SOFI,MU,DKNG,RKLB,NET,PANW,CRWD,SNOW,WDAY,ARM,ANET,DELL,SMCI,MSTR,SMH,ARKK,XBI';
function getWatchlist() {
  try { var rc = require('./runtimeConfig'); var v = rc.get('CASEY_WATCHLIST'); if (v) return v.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean); } catch(e){}
  var raw = process.env.CASEY_WATCHLIST || DEFAULT_WATCH;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// -----------------------------------------------------------------
// TRADESTATION BAR FETCH
// -----------------------------------------------------------------
var TS_BASE = 'https://api.tradestation.com/v3';

async function fetchBars(symbol, query, token) {
  var url = TS_BASE + '/marketdata/barcharts/' + symbol + '?' + query;
  try {
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) {
      console.log('[CASEY] bars ' + symbol + ' ' + res.status);
      return null;
    }
    var j = await res.json();
    return (j && j.Bars) ? j.Bars : null;
  } catch(e) {
    console.log('[CASEY] bars error ' + symbol + ': ' + e.message);
    return null;
  }
}

// -----------------------------------------------------------------
// TIME HELPERS -- ET pre-market = bars timestamped before 9:30 ET
// -----------------------------------------------------------------
function isPreMarket(isoTs) {
  // Parse "2026-04-15T13:25:00Z" -> convert to ET wallclock
  try {
    var d = new Date(isoTs);
    var etStr = d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    // etStr = "HH:MM" or "HH:MM:SS"
    var parts = etStr.split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var mins = h * 60 + m;
    return mins < 9 * 60 + 30; // before 9:30
  } catch(e) { return false; }
}

// -----------------------------------------------------------------
// LEVEL COMPUTATION
// -----------------------------------------------------------------
function computeLevels(dailyBars, minBars) {
  if (!dailyBars || dailyBars.length < 2) return null;
  if (!minBars || minBars.length < 3) return null;

  // Prior day = second-to-last daily bar (last is today in progress)
  var prior = dailyBars[dailyBars.length - 2];
  var pdh = Number(prior.High);
  var pdl = Number(prior.Low);
  var pdc = Number(prior.Close);

  // Pre-market high/low from minute bars timestamped before 9:30 ET today
  var pmh = null, pml = null;
  for (var i = 0; i < minBars.length; i++) {
    var b = minBars[i];
    if (!b || !b.TimeStamp) continue;
    if (!isPreMarket(b.TimeStamp)) continue;
    var hi = Number(b.High);
    var lo = Number(b.Low);
    if (pmh === null || hi > pmh) pmh = hi;
    if (pml === null || lo < pml) pml = lo;
  }

  var last = minBars[minBars.length - 1];
  var cur = last ? Number(last.Close) : null;

  // Last closed 5m bar (for green/red retest confirm) and prior 5m bar (pullback)
  var lastClosed = minBars[minBars.length - 2] || null;
  var priorBar   = minBars[minBars.length - 3] || null;

  if (!isFinite(pdh) || !isFinite(pdl) || !isFinite(cur)) return null;
  return {
    pdh: pdh, pdl: pdl, pdc: pdc,
    pmh: pmh, pml: pml,
    cur: cur,
    lastBar:  lastClosed ? { o: +lastClosed.Open, h: +lastClosed.High, l: +lastClosed.Low, c: +lastClosed.Close } : null,
    priorBar: priorBar   ? { o: +priorBar.Open,   h: +priorBar.High,   l: +priorBar.Low,   c: +priorBar.Close   } : null,
  };
}

// -----------------------------------------------------------------
// CASEY TRIGGER LOGIC (tightened Apr 15 2026)
// The old logic was just `cur > PDH` which fired on every ticker above
// yesterday's high. Real Casey = retest of PMH after a break.
//
// CALLS require:
//   1. cur > PDH                        (daily breakout context)
//   2. PMH is set                       (actual premarket level existed)
//   3. cur is within [-0.15%, +0.75%] of PMH   (hovering near the retest)
//   4. prior 5m bar low touched PMH ± 0.25%    (pulled back)
//   5. last closed 5m bar is green (c > o)    (reclaimed)
//
// PUTS mirror: cur < PDL, near PML, prior tested from above, last bar red.
//
// If the tight retest condition doesn't fit but the breakout is clean
// (cur > PDH and cur > PMH * 1.002 AND last bar green), we allow a
// looser "BREAKOUT" variant labeled differently so we can track edge.
// -----------------------------------------------------------------
function classifyCasey(lv) {
  if (!lv || !isFinite(lv.cur)) return null;
  var cur = lv.cur;
  var lb  = lv.lastBar;
  var pb  = lv.priorBar;
  if (!lb) return null;

  // ---------- CALLS ----------
  if (cur > lv.pdh && isFinite(lv.pmh) && lv.pmh > 0) {
    var nearPmh = (cur >= lv.pmh * 0.9985) && (cur <= lv.pmh * 1.0075);
    var pulledBack = pb && (pb.l <= lv.pmh * 1.0025) && (pb.l >= lv.pmh * 0.9975);
    var lastGreen = lb.c > lb.o;
    if (nearPmh && pulledBack && lastGreen) {
      return { direction: 'CALLS', kind: 'RETEST', trigger: lv.pmh };
    }
    // Clean breakout variant: price decisively above PMH and still pushing.
    // STALE-CHASE GUARD (Apr 15 PM): reject if price is already more than
    // 0.75% above PMH or 1.00% above PDH — the move already played out and
    // entering here is chasing the top (the same bug that almost fired
    // AAPL @ 261.93 with cur 265.32 and TSLA @ 367 with cur 386).
    var cleanBO = (cur > lv.pmh * 1.002) && lastGreen && (lb.c > pb.c);
    var staleChase = (cur > lv.pmh * 1.0075) || (cur > lv.pdh * 1.010);
    if (cleanBO && !staleChase) {
      return { direction: 'CALLS', kind: 'BREAKOUT', trigger: Math.max(lv.pmh, lv.pdh) };
    }
  }

  // ---------- PUTS ----------
  if (cur < lv.pdl && isFinite(lv.pml) && lv.pml > 0) {
    var nearPml = (cur <= lv.pml * 1.0015) && (cur >= lv.pml * 0.9925);
    var pulledUp = pb && (pb.h >= lv.pml * 0.9975) && (pb.h <= lv.pml * 1.0025);
    var lastRed  = lb.c < lb.o;
    if (nearPml && pulledUp && lastRed) {
      return { direction: 'PUTS', kind: 'RETEST', trigger: lv.pml };
    }
    var cleanBD = (cur < lv.pml * 0.998) && lastRed && (lb.c < pb.c);
    var staleBD = (cur < lv.pml * 0.9925) || (cur < lv.pdl * 0.990);
    if (cleanBD && !staleBD) {
      return { direction: 'PUTS', kind: 'BREAKDOWN', trigger: Math.min(lv.pml, lv.pdl) };
    }
  }

  return null;
}

// -----------------------------------------------------------------
// CONTRACT SYMBOL BUILDER
// -----------------------------------------------------------------
// Target expiry: nearest Friday >= 3 DTE and <= 7 DTE. Fall back to +5d.
function pickExpiryDate() {
  var now = new Date();
  for (var offset = 3; offset <= 7; offset++) {
    var d = new Date(now.getTime() + offset * 24 * 3600 * 1000);
    if (d.getDay() === 5) return d; // Friday
  }
  // No Friday in window -> use +5d
  return new Date(now.getTime() + 5 * 24 * 3600 * 1000);
}

function buildContract(ticker, direction, current) {
  var exp = pickExpiryDate();
  var yy = String(exp.getFullYear()).slice(2);
  var mm = String(exp.getMonth() + 1).padStart(2, '0');
  var dd = String(exp.getDate()).padStart(2, '0');
  var cp = direction === 'CALLS' ? 'C' : 'P';
  var strike = Math.round(current);
  var contractSymbol = ticker + ' ' + yy + mm + dd + cp + strike;
  var expiration = mm + '-' + dd + '-' + String(exp.getFullYear());
  return {
    contractSymbol: contractSymbol,
    strike: strike,
    expiration: expiration,
    contractType: direction === 'CALLS' ? 'Call' : 'Put',
  };
}

// -----------------------------------------------------------------
// QUEUE ITEM BUILDER
// -----------------------------------------------------------------
function buildQueueItem(ticker, sig, lv) {
  var direction = sig.direction;
  var c = buildContract(ticker, direction, lv.cur);
  var trigger = sig.trigger;
  var source;
  if (direction === 'CALLS') {
    source = sig.kind === 'RETEST' ? 'CASEY_PMH_RETEST' : 'CASEY_PDH_BREAKOUT';
  } else {
    source = sig.kind === 'RETEST' ? 'CASEY_PML_RETEST' : 'CASEY_PDL_BREAKDOWN';
  }
  // GRADE: RETEST = A+ (Casey's textbook entry), BREAKOUT = A (one rule
  // looser but still passes stale-chase guard).
  var grade = sig.kind === 'RETEST' ? 'A+' : 'A';
  return {
    ticker:         ticker,
    direction:      direction,
    triggerPrice:   trigger,
    contractSymbol: c.contractSymbol,
    strike:         c.strike,
    expiration:     c.expiration,
    contractType:   c.contractType,
    maxEntryPrice:  6.00,
    stopPct:        -0.25,
    targets:        [0.20, 0.50, 1.00],
    contracts:      3,
    management:     'CASEY',
    tradeType:      'DAY',
    grade:          grade,
    source:         source,
    note:           'PDH=' + lv.pdh + ' PDL=' + lv.pdl +
                    ' PMH=' + lv.pmh + ' PML=' + lv.pml +
                    ' cur=' + lv.cur,
  };
}

// -----------------------------------------------------------------
// DISCORD CONFIRM
// -----------------------------------------------------------------
async function postDiscord(item) {
  var hook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!hook) return;
  try {
    var line = '[CASEY] queued ' + item.ticker + ' ' + item.direction +
               ' @ ' + item.triggerPrice + ' | ' + item.contractSymbol +
               ' x' + item.contracts + ' | ' + item.source;
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum Casey Scout',
        content: '```\n' + line + '\n```',
      }),
    });
  } catch(e) { console.log('[CASEY] discord error: ' + e.message); }
}

// -----------------------------------------------------------------
// MAIN POLL
// -----------------------------------------------------------------
var _running = false;

async function pollOnce() {
  if (_running) return { ok: false, reason: 'already running', checked: 0, queued: 0, skipped: 0 };
  _running = true;

  var checked = 0, queued = 0, skipped = 0;

  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) {
      console.log('[CASEY] no TS token, bailing');
      return { ok: false, reason: 'no token', checked: 0, queued: 0, skipped: 0 };
    }

    var watch = getWatchlist();
    var items = [];

    for (var i = 0; i < watch.length; i++) {
      var sym = watch[i];
      checked++;
      try {
        var daily = await fetchBars(sym, 'unit=Daily&barsback=2', token);
        var mins  = await fetchBars(sym, 'unit=Minute&interval=5&barsback=80&sessiontemplate=USEQPreAndPost', token);
        var lv = computeLevels(daily, mins);
        if (!lv) { skipped++; continue; }

        var sig = classifyCasey(lv);
        if (!sig) { skipped++; continue; }
        var direction = sig.direction;

        if (isDeduped(sym, direction + '|' + sig.kind)) {
          console.log('[CASEY] dedup skip ' + sym + ' ' + direction + ' ' + sig.kind);
          skipped++;
          continue;
        }

        var item = buildQueueItem(sym, sig, lv);
        items.push(item);
        markDeduped(sym, direction + '|' + sig.kind);
        console.log('[CASEY] signal ' + sym + ' ' + direction + ' ' + sig.kind +
                    ' cur=' + lv.cur + ' pmh=' + lv.pmh + ' pml=' + lv.pml);
      } catch(e) {
        console.log('[CASEY] ticker error ' + sym + ': ' + e.message);
        skipped++;
      }
    }

    if (items.length === 0) {
      return { ok: true, checked: checked, queued: 0, skipped: skipped };
    }

    // Push to brain queue
    try {
      var be = require('./brainEngine');
      if (be && be.bulkAddQueuedTrades) {
        var res = be.bulkAddQueuedTrades(items, { replaceAll: false });
        queued = (res && res.added) || 0;
        console.log('[CASEY] bulkAdd result: ' + JSON.stringify(res));
      }
    } catch(e) {
      console.log('[CASEY] queue push error: ' + e.message);
    }

    // Discord confirms
    for (var k = 0; k < items.length; k++) {
      await postDiscord(items[k]);
    }

    return { ok: true, checked: checked, queued: queued, skipped: skipped };
  } catch(e) {
    console.log('[CASEY] pollOnce fatal: ' + e.message);
    return { ok: false, reason: e.message, checked: checked, queued: queued, skipped: skipped };
  } finally {
    _running = false;
  }
}

// Alias for generic cron callers
async function run() { return await pollOnce(); }

module.exports = {
  pollOnce: pollOnce,
  run: run,
};
