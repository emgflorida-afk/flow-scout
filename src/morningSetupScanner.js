// =============================================================================
// MORNING SETUP SCANNER (Apr 30 2026 — v6 PM)
//
// EOD coordinator that builds tomorrow's SETUP_RADAR.json by combining:
//   - stratumScanner.js results (Strat 3-1-2 / failed-2 / hammer / etc.)
//   - lvlComputer.js LVL framework state per ticker
//   - earnings calendar (rough — uses TS quote.HasEarnings flags + radar overrides)
//
// Each candidate is classified into Type A/B/C/D/E:
//   A = post-positive-catalyst pullback continuation (QCOM Apr 30 template)
//   B = post-negative-catalyst day 1 continuation down (MSFT/META Apr 30)
//   C = post-flush reversal bounce (Day 2-3 of breakdown)
//   D = LVL retracement at clean level (sweep + retrace)
//   E = Strat 3-1-2 from coil (multi-day breakout)
//
// Output: writes SETUP_RADAR with ready / forming / dead / earningsWatch arrays.
// AB workflow: tomorrow morning, opens scanner-v2 TOMORROW tab → sees ranked Type A's.
//
// Cron: "30 16 * * 1-5"  (4:30 PM ET weekdays, after the bell)
// =============================================================================

var fs = require('fs');
var path = require('path');

// Optional dependencies — wrapped so missing modules don't crash boot.
var stratumScanner = null;
try { stratumScanner = require('./stratumScanner'); } catch (e) { console.log('[MSS] stratumScanner not loaded:', e.message); }
var lvlComputer = null;
try { lvlComputer = require('./lvlComputer'); } catch (e) { console.log('[MSS] lvlComputer not loaded:', e.message); }
var ts = null;
try { ts = require('./tradestation'); } catch (e) { console.log('[MSS] tradestation not loaded:', e.message); }

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var RADAR_FILE = path.join(DATA_ROOT, 'setup_radar.json');

var DEFAULT_WATCHLIST = [
  'AMZN','AAPL','NVDA','TSLA','META','GOOGL','MSFT','SPY','QQQ','AMD','QCOM','IWM'
];

function getWatchlist() {
  var env = (process.env.MORNING_WATCHLIST || '').trim();
  if (env) return env.split(',').map(function(t){ return t.trim().toUpperCase(); }).filter(Boolean);
  return DEFAULT_WATCHLIST.slice();
}

// ----- Last-run snapshot -----
var lastRun = {
  finishedAt: null,
  scanned: 0,
  ready: 0,
  forming: 0,
  dead: 0,
  errors: 0,
  lastError: null,
};

// =============================================================================
// CLASSIFICATION — given enriched per-ticker data, decide Type and bucket
// =============================================================================
function classify(ticker, enriched) {
  // enriched = {
  //   spot, dailyBar, prevDailyBar, weeklyDir, monthlyDir,
  //   stratPattern, lvlState, hasEarnings, daysSinceEarnings,
  //   netChangePct, recentMove
  // }
  var d = enriched.dailyBar;
  var prev = enriched.prevDailyBar;
  if (!d || !prev) return { bucket: 'dead', reason: 'no bar data' };

  // Earnings watch (next 14 days = avoid)
  if (enriched.hasEarnings && enriched.daysToEarnings != null && enriched.daysToEarnings < 14 && enriched.daysToEarnings >= 0) {
    return {
      bucket: 'earningsWatch',
      type: null,
      reason: 'earnings in ' + enriched.daysToEarnings + ' days',
      action: 'Flat into print. Trade post-print if Type A or C forms.',
    };
  }

  // Recent earnings (last 1-3 days) = post-catalyst window
  var postBeat   = enriched.daysSinceEarnings != null && enriched.daysSinceEarnings <= 3 && enriched.netChangePct > 3;
  var postMiss   = enriched.daysSinceEarnings != null && enriched.daysSinceEarnings <= 3 && enriched.netChangePct < -3;
  var recentRun  = enriched.recentMove > 5;       // big multi-day move
  var bearishOutsideClose = (d.high > prev.high) && (d.low < prev.low) && (d.close < d.open);
  var bullishOutsideClose = (d.high > prev.high) && (d.low < prev.low) && (d.close > d.open);
  var dailyStrat3 = bearishOutsideClose || bullishOutsideClose;

  // ----- Type A: post-positive-catalyst continuation -----
  if (postBeat && !dailyStrat3) {
    return {
      bucket: 'ready',
      type: 'A',
      score: 8,
      direction: 'LONG',
      reason: 'Post-beat +' + enriched.netChangePct.toFixed(1) + '%, looking for fade-to-structure then reclaim continuation.',
    };
  }

  // ----- Type B: post-miss continuation down (Day 1) -----
  if (postMiss && d.close < (d.high + d.low) / 2) {
    return {
      bucket: 'forming',  // day 1 of breakdown — not ready until day 2 reversal possible
      type: 'B',
      score: 6,
      direction: 'SHORT',
      reason: 'Post-miss ' + enriched.netChangePct.toFixed(1) + '% with bearish close. Day 1 of breakdown.',
    };
  }

  // ----- Type C: post-flush reversal candidate (Day 2-3) -----
  if (postMiss && enriched.daysSinceEarnings >= 1 && enriched.daysSinceEarnings <= 4 && d.close > (d.high + d.low) / 2) {
    return {
      bucket: 'forming',
      type: 'C',
      score: 5,
      direction: 'LONG',
      reason: 'Day ' + enriched.daysSinceEarnings + ' post-miss, bullish close — possible reversal forming.',
    };
  }

  // ----- Type D: LVL retracement -----
  if (enriched.lvlState && (enriched.lvlState.signal === 'LVL_LONG_25' || enriched.lvlState.signal === 'LVL_SHORT_75')) {
    var dir = enriched.lvlState.signal === 'LVL_LONG_25' ? 'LONG' : 'SHORT';
    return {
      bucket: 'ready',
      type: 'D',
      score: 7,
      direction: dir,
      reason: 'LVL ' + dir + ' setup armed (sweep + 25%/75% retrace).',
    };
  }
  if (enriched.lvlState && (enriched.lvlState.signal === 'EARLY_LONG' || enriched.lvlState.signal === 'EARLY_SHORT')) {
    return {
      bucket: 'forming',
      type: 'D',
      score: 4,
      direction: enriched.lvlState.signal === 'EARLY_LONG' ? 'LONG' : 'SHORT',
      reason: 'LVL early ' + (enriched.lvlState.signal === 'EARLY_LONG' ? 'long' : 'short') + ' — watching for trigger.',
    };
  }

  // ----- Type E: Strat 3-1-2 -----
  if (enriched.stratPattern && /3-1-2|3-2-2/.test(enriched.stratPattern)) {
    return {
      bucket: 'ready',
      type: 'E',
      score: 6,
      direction: enriched.stratPattern.indexOf('U') >= 0 ? 'LONG' : 'SHORT',
      reason: 'Strat ' + enriched.stratPattern + ' coil break.',
    };
  }

  // ----- Daily Strat 3 expansion = pause -----
  if (dailyStrat3) {
    return {
      bucket: 'dead',
      reason: 'Daily Strat 3 (range expansion) — wait for retrace.',
    };
  }

  // ----- Default = dead -----
  return { bucket: 'dead', reason: 'no qualifying setup' };
}

// =============================================================================
// ENRICH ONE TICKER
// =============================================================================
async function enrichTicker(ticker, token) {
  var out = {
    ticker: ticker,
    spot: null,
    dailyBar: null,
    prevDailyBar: null,
    netChangePct: null,
    stratPattern: null,
    lvlState: null,
    hasEarnings: false,
    daysSinceEarnings: null,
    daysToEarnings: null,
    recentMove: null,
  };

  try {
    if (!lvlComputer) throw new Error('lvlComputer not loaded');
    var bars = await lvlComputer.fetchBars(ticker, 'Daily', token);
    if (!bars || bars.length < 5) throw new Error('not enough daily bars');
    var d = bars[bars.length - 1];
    var prev = bars[bars.length - 2];
    out.dailyBar = d;
    out.prevDailyBar = prev;
    out.spot = d.Close;
    out.netChangePct = ((d.Close - prev.Close) / prev.Close) * 100;
    // 5-day move
    if (bars.length >= 5) {
      var fiveAgo = bars[bars.length - 5];
      out.recentMove = ((d.Close - fiveAgo.Close) / fiveAgo.Close) * 100;
    }

    // LVL state — Daily
    var lvlMTF = await lvlComputer.computeMultiTF(ticker, ['Daily'], token);
    if (lvlMTF && lvlMTF.tfs && lvlMTF.tfs.Daily && lvlMTF.tfs.Daily.ok) {
      out.lvlState = lvlMTF.tfs.Daily;
    }

    // Strat pattern (lightweight) — last 3 daily bars classification
    if (bars.length >= 3) {
      var c2 = bars[bars.length - 3];
      var c1 = prev;
      var c0 = d;
      function strat(b, p) {
        if (b.High > p.High && b.Low > p.Low) return '2U';
        if (b.High < p.High && b.Low < p.Low) return '2D';
        if (b.High <= p.High && b.Low >= p.Low) return '1';
        return '3';
      }
      out.stratPattern = strat(c2, c1) + '-' + strat(c1, c0[0] || c0);
      // Note: this is approximate; the real scanner has a richer detector
    }

  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// =============================================================================
// MAIN — runs the scan, classifies each ticker, writes SETUP_RADAR.json
// =============================================================================
async function runScan(opts) {
  opts = opts || {};
  var tickers = opts.tickers || getWatchlist();

  // Get token
  var token = opts.token;
  if (!token) {
    try { if (ts && ts.getAccessToken) token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) {
    var msg = 'no TS access token';
    lastRun.lastError = msg;
    return { error: msg };
  }

  console.log('[MSS] scanning', tickers.length, 'tickers');
  var enriched = [];
  for (var i = 0; i < tickers.length; i++) {
    try {
      var e = await enrichTicker(tickers[i], token);
      enriched.push(e);
    } catch (err) {
      console.error('[MSS] enrich error', tickers[i], err.message);
      lastRun.errors++;
    }
  }

  // Classify
  var ready = [];
  var forming = [];
  var dead = [];
  var earningsWatch = [];
  for (var j = 0; j < enriched.length; j++) {
    var e2 = enriched[j];
    var c = classify(e2.ticker, e2);
    var card = {
      ticker:        e2.ticker,
      type:          c.type,
      direction:     c.direction,
      spot:          e2.spot,
      score:         c.score,
      reason:        c.reason,
      why:           c.reason,
      stratPattern:  e2.stratPattern,
      lvlSignal:     e2.lvlState && e2.lvlState.signal,
      netChangePct:  e2.netChangePct,
    };
    if (c.bucket === 'ready')          ready.push(card);
    else if (c.bucket === 'forming')   forming.push(card);
    else if (c.bucket === 'earningsWatch') earningsWatch.push(Object.assign(card, { date: 'TBD', action: c.action }));
    else                               dead.push({ ticker: e2.ticker, reason: c.reason || 'no setup' });
  }

  // Sort ready by score desc
  ready.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
  forming.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });

  var radar = {
    updatedAt: new Date().toISOString(),
    note: 'Generated by morningSetupScanner.js (v6 PM)',
    ready: ready,
    forming: forming,
    dead: dead,
    earningsWatch: earningsWatch,
  };

  if (!opts.dryRun) {
    try {
      fs.writeFileSync(RADAR_FILE, JSON.stringify(radar, null, 2));
    } catch (e) {
      lastRun.lastError = 'write-radar:' + e.message;
      return { error: 'failed to write radar: ' + e.message };
    }
  }

  lastRun.finishedAt = new Date().toISOString();
  lastRun.scanned    = enriched.length;
  lastRun.ready      = ready.length;
  lastRun.forming    = forming.length;
  lastRun.dead       = dead.length;

  console.log('[MSS] DONE: ready=' + ready.length + ' forming=' + forming.length + ' dead=' + dead.length + ' earnings=' + earningsWatch.length);
  return radar;
}

function getStatus() { return Object.assign({}, lastRun, { radarFile: RADAR_FILE, watchlistDefault: DEFAULT_WATCHLIST }); }

module.exports = {
  runScan: runScan,
  getStatus: getStatus,
  classify: classify,           // exposed for unit tests
  enrichTicker: enrichTicker,
  getWatchlist: getWatchlist,
};
