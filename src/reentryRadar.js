// reentryRadar.js — Stratum Flow Scout
// Server-side monitor that catches 2nd-chance entry patterns intraday.
// Solves the "never had a chance to book it" problem (WMT 4/22 case).
//
// Watches list:
//   1. Current open positions (from TS MCP)
//   2. Recently triggered brackets (still working orders)
//   3. Tickers with recent TV alerts (last 2 hrs)
//
// Pattern detected (per ticker):
//   A. Trigger was crossed UP (for longs) earlier in the session
//   B. Price pulled BACK below trigger
//   C. Price reclaimed ABOVE trigger with a green 5m bar
//   → FIRE: re-entry candidate alert
//
// Cooldown: 30 min per ticker — don't spam on choppy stocks.
// Push: Discord via pushNotifier.pushCuratorAlert (or pushText as fallback).
// -----------------------------------------------------------------

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

var pushNotifier = null;
try { pushNotifier = require('./pushNotifier'); } catch(e) {}

var stratumScanner = null;
try { stratumScanner = require('./stratumScanner'); } catch(e) {}

var STATE_DIR = process.env.STATE_DIR || '/tmp';
var RADAR_STATE_FILE = path.join(STATE_DIR, 'reentry_radar_state.json');
var RADAR_LOG_FILE = path.join(STATE_DIR, 'reentry_radar.jsonl');

var COOLDOWN_MS = 30 * 60 * 1000; // 30 min per ticker

// -----------------------------------------------------------------
// State persistence (cooldowns across restarts)
// -----------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(RADAR_STATE_FILE, 'utf8'));
  } catch(e) {
    return { lastAlert: {}, watchList: [] };
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(RADAR_STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) { console.error('[RADAR] state save failed:', e.message); }
}

function logEvent(entry) {
  try {
    entry.ts = new Date().toISOString();
    fs.appendFileSync(RADAR_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch(e) {}
}

// -----------------------------------------------------------------
// Fetch watchlist: open positions + recently triggered tickers
// -----------------------------------------------------------------
async function getWatchList() {
  var tickers = new Set();

  // Pull open positions via TS
  if (ts && ts.getToken) {
    try {
      var token = await ts.getToken();
      if (token) {
        // Fetch positions for the account
        var acct = process.env.TS_ACCOUNT_ID;
        if (acct) {
          var fetch = require('node-fetch');
          var r = await fetch('https://api.tradestation.com/v3/brokerage/accounts/' + acct + '/positions', {
            headers: { Authorization: 'Bearer ' + token }
          });
          if (r.ok) {
            var data = await r.json();
            (data.Positions || []).forEach(function(p) {
              // For option positions, use the underlying ticker
              var sym = (p.Symbol || '').split(' ')[0];
              if (sym) tickers.add(sym.toUpperCase());
            });
          }
        }
      }
    } catch(e) { console.error('[RADAR] TS position fetch failed:', e.message); }
  }

  // Add tickers with recent TV alerts (last 2 hrs)
  if (stratumScanner && stratumScanner.getTVAlertsFor) {
    // Scanner module exposes tvAlerts map internally; iterate via scan result
    // For v1, just use the TS position list. Future: expose a getActiveTVAlerts()
  }

  return Array.from(tickers);
}

// -----------------------------------------------------------------
// Pull recent 5-min bars for a ticker via TradeStation API
// -----------------------------------------------------------------
async function pullRecentBars(ticker, count) {
  if (!ts || !ts.getToken) return null;
  count = count || 30; // last 30 * 5min = 2.5 hours
  try {
    var token = await ts.getToken();
    if (!token) return null;
    var fetch = require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker) +
              '?unit=Minute&interval=5&barsback=' + count + '&sessiontemplate=Default';
    var r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    var data = await r.json();
    return (data.Bars || []).map(function(b) {
      return {
        time: new Date(b.TimeStamp).getTime() / 1000,
        open: parseFloat(b.Open),
        high: parseFloat(b.High),
        low: parseFloat(b.Low),
        close: parseFloat(b.Close),
        volume: parseFloat(b.TotalVolume || 0),
      };
    });
  } catch(e) {
    console.error('[RADAR] bars fetch failed for', ticker, e.message);
    return null;
  }
}

// -----------------------------------------------------------------
// Detect re-entry pattern on recent 5m bars
// Returns: { fired: bool, type: 'bull_reclaim' | 'bear_reclaim', details }
// -----------------------------------------------------------------
function detectReentry(bars, triggerPrice, direction) {
  // direction: 'long' | 'short'
  if (!bars || bars.length < 6) return { fired: false, reason: 'insufficient_bars' };
  if (!triggerPrice) return { fired: false, reason: 'no_trigger' };

  var recent = bars.slice(-6); // last 6 bars (30 min)

  // Find a bar where price was ABOVE trigger earlier
  var hadAboveTrigger = false;
  var hadBelowTrigger = false;
  var recentCloseTrigger = recent[recent.length - 1].close;

  for (var i = 0; i < recent.length - 1; i++) {
    if (recent[i].high >= triggerPrice) hadAboveTrigger = true;
    if (recent[i].low <= triggerPrice) hadBelowTrigger = true;
  }

  var lastBar = recent[recent.length - 1];
  var prevBar = recent[recent.length - 2];
  var greenBar = lastBar.close > lastBar.open;
  var redBar = lastBar.close < lastBar.open;
  var bodyRatio = Math.abs(lastBar.close - lastBar.open) / Math.max(lastBar.high - lastBar.low, 0.01);
  var strongBar = bodyRatio >= 0.40;

  if (direction === 'long') {
    // Bull re-entry: price above, then below, now back above with green bar
    var reclaim = hadAboveTrigger && hadBelowTrigger &&
                  prevBar.close < triggerPrice &&
                  lastBar.close > triggerPrice &&
                  greenBar && strongBar;
    if (reclaim) {
      return {
        fired: true,
        type: 'bull_reclaim',
        details: {
          trigger: triggerPrice,
          reclaim_close: lastBar.close,
          prev_close: prevBar.close,
          body_pct: Math.round(bodyRatio * 100),
          recent_low: Math.min.apply(null, recent.map(function(b){ return b.low; })),
        }
      };
    }
  } else if (direction === 'short') {
    // Bear re-entry: price below, then above, now back below with red bar
    var bearReclaim = hadAboveTrigger && hadBelowTrigger &&
                      prevBar.close > triggerPrice &&
                      lastBar.close < triggerPrice &&
                      redBar && strongBar;
    if (bearReclaim) {
      return {
        fired: true,
        type: 'bear_reclaim',
        details: {
          trigger: triggerPrice,
          reclaim_close: lastBar.close,
          prev_close: prevBar.close,
          body_pct: Math.round(bodyRatio * 100),
          recent_high: Math.max.apply(null, recent.map(function(b){ return b.high; })),
        }
      };
    }
  }

  return { fired: false, reason: 'pattern_not_matched' };
}

// -----------------------------------------------------------------
// Run one full radar cycle
// -----------------------------------------------------------------
async function runCycle() {
  var state = loadState();
  var watch = await getWatchList();
  if (!watch || watch.length === 0) {
    logEvent({ cycle: 'skip', reason: 'empty_watchlist' });
    return { checked: 0, fired: 0 };
  }

  var fired = 0;
  var now = Date.now();

  for (var i = 0; i < watch.length; i++) {
    var ticker = watch[i];

    // Cooldown check
    if (state.lastAlert[ticker] && (now - state.lastAlert[ticker] < COOLDOWN_MS)) {
      continue;
    }

    // TODO v2: pull trigger price + direction from open bracket orders
    // For v1, we'd need triggerPrice passed in via config
    // Skip ticker if we can't determine trigger
    var triggerPrice = null;
    var direction = null;
    // Placeholder: fetch from stratumScanner.getActivePosition or similar
    // For now log and skip
    if (!triggerPrice) {
      logEvent({ cycle: 'ticker_skip', ticker: ticker, reason: 'no_trigger_config' });
      continue;
    }

    var bars = await pullRecentBars(ticker, 12);
    var result = detectReentry(bars, triggerPrice, direction);

    logEvent({
      cycle: 'ticker_check',
      ticker: ticker,
      trigger: triggerPrice,
      direction: direction,
      fired: result.fired,
      reason: result.reason || result.type,
    });

    if (result.fired) {
      // Fire Discord push
      if (pushNotifier && pushNotifier.pushCuratorAlert) {
        try {
          await pushNotifier.pushCuratorAlert({
            ticker: ticker,
            score: 8, // tentative — curator v2 will properly score this
            verdict: 'REENTRY_CANDIDATE',
            reason: 'RE-ENTRY: ' + result.type + ' — ' + ticker + ' reclaimed ' + triggerPrice + ' at ' + result.details.reclaim_close,
            r_r: 'pending',
            action: 'Review chart. Consider adding to existing position or fresh entry if missed earlier.',
            failure_modes: ['Chop risk', 'Validate with 5m volume'],
          });
          fired++;
          state.lastAlert[ticker] = now;
        } catch(e) { console.error('[RADAR] push failed for', ticker, e.message); }
      }
    }
  }

  state.watchList = watch;
  saveState(state);

  return { checked: watch.length, fired: fired, ts: new Date().toISOString() };
}

// -----------------------------------------------------------------
// Register a watched ticker with trigger info (for v1 config)
// -----------------------------------------------------------------
function registerWatch(ticker, triggerPrice, direction) {
  var state = loadState();
  if (!state.configuredWatches) state.configuredWatches = {};
  state.configuredWatches[ticker.toUpperCase()] = {
    triggerPrice: parseFloat(triggerPrice),
    direction: direction,
    registeredAt: new Date().toISOString(),
  };
  saveState(state);
  return state.configuredWatches[ticker.toUpperCase()];
}

function unregisterWatch(ticker) {
  var state = loadState();
  if (state.configuredWatches) {
    delete state.configuredWatches[ticker.toUpperCase()];
    saveState(state);
  }
  return { ok: true };
}

function listWatches() {
  var state = loadState();
  return state.configuredWatches || {};
}

// -----------------------------------------------------------------
module.exports = {
  runCycle: runCycle,
  registerWatch: registerWatch,
  unregisterWatch: unregisterWatch,
  listWatches: listWatches,
  detectReentry: detectReentry, // exported for testing
  getWatchList: getWatchList,
};
