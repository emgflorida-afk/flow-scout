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
var DEFAULT_WATCH = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL';
function getWatchlist() {
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
  if (!minBars || minBars.length < 1) return null;

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

  if (!isFinite(pdh) || !isFinite(pdl) || !isFinite(cur)) return null;
  return { pdh: pdh, pdl: pdl, pdc: pdc, pmh: pmh, pml: pml, cur: cur };
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
function buildQueueItem(ticker, direction, lv) {
  var c = buildContract(ticker, direction, lv.cur);
  var trigger = direction === 'CALLS' ? lv.pdh : lv.pdl;
  var source = direction === 'CALLS' ? 'CASEY_PDH_RETEST' : 'CASEY_PDL_BREAKDOWN';
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

        var direction = null;
        if (lv.cur > lv.pdh && lv.pmh !== null) direction = 'CALLS';
        else if (lv.cur < lv.pdl && lv.pml !== null) direction = 'PUTS';

        if (!direction) { skipped++; continue; }

        if (isDeduped(sym, direction)) {
          console.log('[CASEY] dedup skip ' + sym + ' ' + direction);
          skipped++;
          continue;
        }

        var item = buildQueueItem(sym, direction, lv);
        items.push(item);
        markDeduped(sym, direction);
        console.log('[CASEY] signal ' + sym + ' ' + direction +
                    ' cur=' + lv.cur + ' pdh=' + lv.pdh + ' pdl=' + lv.pdl);
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
