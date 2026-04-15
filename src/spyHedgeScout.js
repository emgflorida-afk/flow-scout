// spyHedgeScout.js -- SPY Put Hedge Scout
// -----------------------------------------------------------------
// Watches SPY 5-min bars for a FAILED resistance rejection or support
// break, then auto-queues a SPY put hedge via brainEngine.
// Built Apr 15 2026 AM to automate the manual hedge watch AB was
// doing around the 694-697 weekly resistance cluster.
//
// Triggers (in priority order):
//   A) FAILED resistance: a 5m bar prints high >= RESISTANCE, then
//      closes red AND closes below its own midpoint. That bar is
//      flagged as the SIGNAL BAR. On the NEXT 5m bar breaking below
//      the signal bar LOW, queue the put.
//   B) SUPPORT BREAK: any 5m close strictly below SUPPORT (when the
//      prior bar was above) → queue the put.
//   C) ABORT: any 5m close strictly above ABORT_ABOVE → thesis dead
//      for the day, scout goes dormant until tomorrow.
//
// Stops are STRUCTURAL (signal bar high + cushion), never flat %.
// Sizing = 1 contract (this is a HEDGE). Expiry ~9 DTE next Friday.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs = require('fs');

// -----------------------------------------------------------------
// CONFIG — tuneable via POST /api/spy-hedge/config
// -----------------------------------------------------------------
var config = {
  resistance:  parseFloat(process.env.SPY_HEDGE_RESISTANCE  || '697.50'),
  support:     parseFloat(process.env.SPY_HEDGE_SUPPORT     || '693.50'),
  abortAbove:  parseFloat(process.env.SPY_HEDGE_ABORT_ABOVE || '698.10'),
  dte:         parseInt(process.env.SPY_HEDGE_DTE || '9', 10),
  strikeOffset: parseFloat(process.env.SPY_HEDGE_STRIKE_OFFSET || '7'),
  maxEntry:    parseFloat(process.env.SPY_HEDGE_MAX_ENTRY || '4.00'),
  cushion:     parseFloat(process.env.SPY_HEDGE_CUSHION || '0.10'),
};

// -----------------------------------------------------------------
// STATE — persisted so we survive restarts inside a single trading day
// -----------------------------------------------------------------
var STATE_FILE = '/tmp/spy_hedge_scout.json';
var state = {
  date: null,         // 'YYYY-MM-DD' ET — reset each day
  signalBar: null,    // { time, open, high, low, close } — pending rejection bar
  hedgeQueuedId: null,
  aborted: false,
  lastBarTime: null,
  lastTrigger: null,  // 'A' | 'B' | null
};

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || state;
    }
  } catch(e) { console.error('[SPY-HEDGE] state load error:', e.message); }
  // Fresh day reset
  if (state.date !== todayET()) {
    state = {
      date: todayET(),
      signalBar: null,
      hedgeQueuedId: null,
      aborted: false,
      lastBarTime: null,
      lastTrigger: null,
    };
    saveState();
  }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch(e) { console.error('[SPY-HEDGE] state save error:', e.message); }
}

// -----------------------------------------------------------------
// BARS — pull last N SPY 5-min bars
// -----------------------------------------------------------------
async function fetchBars(barsBack) {
  barsBack = barsBack || 12;
  var ts = require('./tradestation');
  var token = await ts.getAccessToken();
  if (!token) return null;
  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/SPY' +
            '?interval=5&unit=Minute&barsback=' + barsBack + '&sessiontemplate=Default';
  var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) {
    console.error('[SPY-HEDGE] bar fetch status', res.status);
    return null;
  }
  var data = await res.json();
  return (data.Bars || []).map(function(b) {
    return {
      time:  b.TimeStamp,
      open:  parseFloat(b.Open),
      high:  parseFloat(b.High),
      low:   parseFloat(b.Low),
      close: parseFloat(b.Close),
      vol:   parseFloat(b.TotalVolume || 0),
    };
  });
}

// -----------------------------------------------------------------
// TRIGGER DETECTION
// -----------------------------------------------------------------
function isFailedRejection(bar) {
  if (!bar) return false;
  if (bar.high < config.resistance) return false;
  if (bar.close >= bar.open) return false;  // must close red
  var mid = (bar.high + bar.low) / 2;
  if (bar.close >= mid) return false;       // must close below midpoint
  return true;
}

function isSupportBreak(bar, prev) {
  if (!bar || !prev) return false;
  if (prev.close <= config.support) return false;  // prior must be above
  if (bar.close >= config.support) return false;   // current must close below
  return true;
}

function isAbort(bar) {
  if (!bar) return false;
  return bar.close > config.abortAbove;
}

// -----------------------------------------------------------------
// QUEUE ITEM BUILDER
// -----------------------------------------------------------------
function nextFridayISO(dte) {
  var now = new Date();
  // Walk forward until we hit a Friday that is at least `dte` days out
  var d = new Date(now);
  for (var i = 0; i < 21; i++) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 5) {
      var diff = Math.floor((d - now) / (1000 * 60 * 60 * 24));
      if (diff >= Math.max(1, dte - 2)) break;
    }
  }
  return d.toISOString().slice(0, 10);
}

function buildQueueItem(triggerType, signalBar, spyPrice) {
  var expiry = nextFridayISO(config.dte);
  var strike = Math.round(spyPrice - config.strikeOffset);
  var yymmdd = expiry.slice(2,4) + expiry.slice(5,7) + expiry.slice(8,10);
  var contractSymbol = 'SPY ' + yymmdd + 'P' + strike;

  var triggerPrice, signalHigh, signalLow;
  if (triggerType === 'A') {
    triggerPrice = signalBar.low;
    signalHigh = signalBar.high;
    signalLow  = signalBar.low;
  } else {
    triggerPrice = config.support;
    signalHigh = signalBar.high;
    signalLow  = signalBar.low;
  }

  return {
    ticker:         'SPY',
    direction:      'PUTS',
    triggerPrice:   triggerPrice,
    contractSymbol: contractSymbol,
    strike:         strike,
    expiration:     expiry.slice(5,7) + '-' + expiry.slice(8,10) + '-' + expiry.slice(0,4),
    contractType:   'Put',
    maxEntryPrice:  config.maxEntry,
    stopPct:        -25, // placeholder; stopManager overrides with structural
    contracts:      1,
    tradeDate:      todayET(),
    tradeType:      'DAY',
    grade:          'A',
    source:         triggerType === 'A' ? 'SPY_HEDGE_FAILED_RESISTANCE' : 'SPY_HEDGE_SUPPORT_BREAK',
    // Context for stopManager.signalBar profile
    signalBarHigh:  signalHigh,
    signalBarLow:   signalLow,
    note:           'Auto-queued by spyHedgeScout | trigger=' + triggerType +
                    ' | resistance=' + config.resistance +
                    ' | support=' + config.support +
                    ' | signalBar H=' + signalHigh + ' L=' + signalLow,
  };
}

// -----------------------------------------------------------------
// DISCORD CONFIRM
// -----------------------------------------------------------------
async function postConfirm(item, trigger, signalBar) {
  var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhook) return;
  try {
    var lines = [
      '🛡️ SPY HEDGE SCOUT — trigger ' + trigger + ' FIRED',
      '────────────────────────────────',
      'Contract: ' + item.contractSymbol + ' x' + item.contracts,
      'Trigger:  $' + item.triggerPrice,
      'Max:      $' + item.maxEntryPrice.toFixed(2),
      'Signal:   H=' + signalBar.high + ' L=' + signalBar.low + ' @ ' + signalBar.time,
      'Stop:     structural (via stopManager)',
      'Source:   ' + item.source,
      '────────────────────────────────',
      'Queued via brainEngine.bulkAddQueuedTrades',
    ].join('\n');
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum SPY Hedge',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) { console.error('[SPY-HEDGE] webhook error:', e.message); }
}

async function postAbort(bar) {
  var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum SPY Hedge',
        content: '```\n⚠️ SPY HEDGE SCOUT — ABORT\nSPY 5m closed above ' + config.abortAbove + ' (close=' + bar.close + ')\nHedge thesis dead for the day. Scout dormant until tomorrow.\n```',
      }),
    });
  } catch(e) {}
}

// -----------------------------------------------------------------
// MAIN CYCLE
// -----------------------------------------------------------------
var _running = false;
async function runCycle() {
  if (_running) return { skipped: 'already running' };
  _running = true;
  try {
    loadState();
    if (state.aborted) return { status: 'aborted_for_day' };
    if (state.hedgeQueuedId) return { status: 'already_queued', id: state.hedgeQueuedId };

    var bars = await fetchBars(12);
    if (!bars || bars.length < 3) return { error: 'no bars' };

    // Work only with the most recent CLOSED bar. TradeStation returns the
    // live forming bar as the last element; treat bars.length-2 as closed.
    var closed = bars[bars.length - 2];
    var prev   = bars[bars.length - 3];
    if (!closed) return { error: 'no closed bar' };

    // Dedup by bar time
    if (state.lastBarTime === closed.time) return { status: 'no_new_bar' };
    state.lastBarTime = closed.time;

    // -------- ABORT first --------
    if (isAbort(closed)) {
      state.aborted = true;
      saveState();
      await postAbort(closed);
      return { status: 'ABORT', bar: closed };
    }

    // -------- Trigger B: support break (immediate) --------
    if (isSupportBreak(closed, prev)) {
      var spyPrice = closed.close;
      var itemB = buildQueueItem('B', closed, spyPrice);
      var pushB = pushToQueue(itemB);
      state.hedgeQueuedId = 'B_' + closed.time;
      state.lastTrigger = 'B';
      saveState();
      await postConfirm(itemB, 'B (SUPPORT BREAK)', closed);
      return { status: 'FIRED_B', push: pushB, item: itemB };
    }

    // -------- Trigger A: failed resistance rejection --------
    // Two-step: first detect signal bar, then on NEXT bar's break, queue.
    if (state.signalBar) {
      // We already flagged a signal bar. Now wait for a bar that breaks
      // below signalBar.low. "Break" = any bar whose low pierces it.
      if (closed.low < state.signalBar.low) {
        var spyPriceA = closed.close;
        var itemA = buildQueueItem('A', state.signalBar, spyPriceA);
        var pushA = pushToQueue(itemA);
        state.hedgeQueuedId = 'A_' + state.signalBar.time;
        state.lastTrigger = 'A';
        saveState();
        await postConfirm(itemA, 'A (FAILED RESISTANCE)', state.signalBar);
        return { status: 'FIRED_A', push: pushA, item: itemA };
      }
      // If SPY runs back above the signal bar high, invalidate the setup
      if (closed.high > state.signalBar.high) {
        state.signalBar = null;
        saveState();
        return { status: 'signal_bar_invalidated' };
      }
      return { status: 'awaiting_break', signalBar: state.signalBar };
    }

    // No pending signal bar — look for a fresh rejection
    if (isFailedRejection(closed)) {
      state.signalBar = {
        time:  closed.time,
        open:  closed.open,
        high:  closed.high,
        low:   closed.low,
        close: closed.close,
      };
      saveState();
      return { status: 'signal_bar_flagged', bar: state.signalBar };
    }

    return { status: 'watching', lastClose: closed.close };
  } catch(e) {
    console.error('[SPY-HEDGE] cycle error:', e.message);
    return { error: e.message };
  } finally {
    _running = false;
  }
}

function pushToQueue(item) {
  try {
    var be = require('./brainEngine');
    if (be && be.bulkAddQueuedTrades) {
      return be.bulkAddQueuedTrades([item], { replaceAll: false });
    }
    return { error: 'brainEngine not available' };
  } catch(e) {
    console.error('[SPY-HEDGE] queue push error:', e.message);
    return { error: e.message };
  }
}

// -----------------------------------------------------------------
// CONFIG + STATE API HELPERS
// -----------------------------------------------------------------
function getConfig() { return Object.assign({}, config); }
function setConfig(patch) {
  patch = patch || {};
  ['resistance','support','abortAbove','dte','strikeOffset','maxEntry','cushion'].forEach(function(k) {
    if (patch[k] !== undefined) {
      var v = parseFloat(patch[k]);
      if (!isNaN(v)) config[k] = v;
    }
  });
  return getConfig();
}
function getState() { loadState(); return Object.assign({}, state); }
function resetState() {
  state = {
    date: todayET(),
    signalBar: null,
    hedgeQueuedId: null,
    aborted: false,
    lastBarTime: null,
    lastTrigger: null,
  };
  saveState();
  return state;
}

module.exports = {
  runCycle,
  getConfig,
  setConfig,
  getState,
  resetState,
};
