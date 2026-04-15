// spreadScout.js -- Stratum v7.5
// -----------------------------------------------------------------
// SPX/XSP Credit Spread Scout. Computes Full Time Frame Continuity
// (FTFC) across Monthly / Weekly / Daily / 60-min on SPY as a proxy
// for SPX direction, and when alignment is strong (3/4 or 4/4) it
// pulls an optimal bull-put or bear-call spread from the existing
// creditSpreadEngine and either queues it for manual review
// (default) or auto-places it if SPREAD_AUTOFIRE=true.
//
// This is the LAST Tier-3 scout for bill-paying mode. The existing
// creditSpreadEngine.js already handles strike selection and order
// placement -- we do NOT duplicate that logic. We ONLY gate entry
// on FTFC so the engine stops firing wrong directions on mixed days.
//
// DO NOT edit creditSpreadEngine.js from this file. Read-only import.
//
// Rules (feedback_spread_mistakes.md):
//   - Never auto-close at open
//   - Never set unrealistic min credit (engine owns that)
//   - Let spreads run
//
// Pattern copied from caseyEntry.js + stratEntry.js.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs    = require('fs');

// -----------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------
// NOTE: creditSpreadEngine internally trades XSP (mini-SPX). We keep
// SPX,SPXW as the spec default so logging lines up with user intent,
// but FTFC is computed off SPY (highest-fidelity intraday bars).
var DEFAULT_WATCHLIST = 'SPX,SPXW';
var FTFC_PROXY        = 'SPY';
var MIN_CREDIT        = 0.50;   // $/share net credit floor
var DTE_TARGET        = 7;
var ET_OFFSET_MIN     = -300;   // crude ET offset fallback

function getWatchlist() {
  var raw = process.env.SPREAD_WATCHLIST || DEFAULT_WATCHLIST;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

function isAutofire() {
  return String(process.env.SPREAD_AUTOFIRE || '').toLowerCase() === 'true';
}

// -----------------------------------------------------------------
// STATE / DEDUP
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var STATE_FILE = STATE_DIR + '/spread_scout.json';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    }
  } catch(e) { console.error('[SPREAD] state load:', e.message); }
  return {};
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
  catch(e) { console.error('[SPREAD] state save:', e.message); }
}

// -----------------------------------------------------------------
// TIME HELPERS (ET)
// -----------------------------------------------------------------
function getETParts() {
  // Use Intl where available; fallback to naive offset
  try {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function(p){ parts[p.type] = p.value; });
    return {
      weekday: parts.weekday,                         // 'Mon','Fri',...
      hour:    parseInt(parts.hour, 10),
      minute:  parseInt(parts.minute, 10),
      ymd:     parts.year + '-' + parts.month + '-' + parts.day,
    };
  } catch(e) {
    var d = new Date(Date.now() + ET_OFFSET_MIN * 60 * 1000);
    return {
      weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()],
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      ymd: d.toISOString().slice(0,10),
    };
  }
}

function withinTradingWindow() {
  var p = getETParts();
  if (p.weekday === 'Sat' || p.weekday === 'Sun') {
    return { ok: false, reason: 'weekend (' + p.weekday + ')' };
  }
  var hm = p.hour * 60 + p.minute;
  // 9:30 to 14:30 ET (pin-risk guard)
  if (hm < 570)  return { ok: false, reason: 'pre-930ET (' + p.hour + ':' + p.minute + ')' };
  if (hm > 870)  return { ok: false, reason: 'post-1430ET (' + p.hour + ':' + p.minute + ')' };
  // Friday: no entries after 14:00 ET (pin risk)
  if (p.weekday === 'Fri' && hm >= 840) {
    return { ok: false, reason: 'fri-pin-risk (post 14:00 ET)' };
  }
  return { ok: true, ymd: p.ymd };
}

// -----------------------------------------------------------------
// TRADESTATION BARS
// -----------------------------------------------------------------
async function tsBars(ticker, unit, interval, barsback, token) {
  try {
    // sessiontemplate=Default is only valid for Minute intervals in the TS API;
    // passing it on Daily/Weekly/Monthly returns "insufficient bars" (silent
    // rejection). Drop it for non-intraday timeframes.
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker +
      '?interval=' + interval + '&unit=' + unit +
      '&barsback=' + barsback +
      (unit === 'Minute' ? '&sessiontemplate=Default' : '');
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) {
      console.error('[SPREAD] bars ' + ticker + ' ' + unit + '/' + interval + ' ' + res.status);
      return [];
    }
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) {
    console.error('[SPREAD] bars error ' + ticker + ':', e.message);
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
  };
}

// -----------------------------------------------------------------
// FTFC COMPUTATION
// For each TF (monthly / weekly / daily / 60m):
//   - prior bar = second to last CLOSED bar
//   - current price = close of last (forming) bar
//   - GREEN if current > prior.close, RED if <
// -----------------------------------------------------------------
async function computeFTFC(symbol) {
  var ts;
  try { ts = require('./tradestation'); }
  catch(e) {
    return { direction: 'MIXED', aligned: 0, error: 'no tradestation module', details: {} };
  }
  var token;
  try { token = await ts.getAccessToken(); }
  catch(e) { return { direction: 'MIXED', aligned: 0, error: e.message, details: {} }; }
  if (!token) return { direction: 'MIXED', aligned: 0, error: 'no token', details: {} };

  var proxy = symbol;
  // SPX index has no direct bar feed on many plans -- fall back to SPY
  if (symbol === 'SPX' || symbol === 'SPXW' || symbol === '$SPX.X') proxy = FTFC_PROXY;

  var tfs = [
    { key: 'M',   unit: 'Monthly', interval: 1  },
    { key: 'W',   unit: 'Weekly',  interval: 1  },
    { key: 'D',   unit: 'Daily',   interval: 1  },
    { key: '60m', unit: 'Minute',  interval: 60 },
  ];

  var details = {};
  var green = 0, red = 0, counted = 0;
  var currentPrice = null;

  for (var i = 0; i < tfs.length; i++) {
    var tf = tfs[i];
    var bars = await tsBars(proxy, tf.unit, tf.interval, 3, token);
    if (!bars || bars.length < 2) {
      details[tf.key] = { state: 'N/A', reason: 'insufficient bars' };
      continue;
    }
    var last = normBar(bars[bars.length - 1]);
    var prior = normBar(bars[bars.length - 2]);
    if (!last || !prior) {
      details[tf.key] = { state: 'N/A', reason: 'bad bar' };
      continue;
    }
    if (currentPrice == null) currentPrice = last.c;

    var state = 'FLAT';
    if (last.c > prior.c) { state = 'GREEN'; green++; }
    else if (last.c < prior.c) { state = 'RED'; red++; }
    counted++;

    details[tf.key] = {
      state: state,
      priorClose: prior.c,
      lastClose:  last.c,
    };
  }

  var direction, aligned;
  if (green >= 3 && red === 0) {
    direction = 'BULL'; aligned = green;
  } else if (red >= 3 && green === 0) {
    direction = 'BEAR'; aligned = red;
  } else if (green === 4) {
    direction = 'BULL'; aligned = 4;
  } else if (red === 4) {
    direction = 'BEAR'; aligned = 4;
  } else {
    direction = 'MIXED';
    aligned   = Math.max(green, red);
  }

  return {
    direction: direction,
    aligned:   aligned,
    counted:   counted,
    green:     green,
    red:       red,
    currentPrice: currentPrice,
    proxy:     proxy,
    details:   details,
  };
}

// -----------------------------------------------------------------
// QUEUE ITEM BUILDER
// -----------------------------------------------------------------
function fmtExp(dateLike) {
  var d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  var yyyy = String(d.getFullYear());
  return mm + '-' + dd + '-' + yyyy;
}

function buildQueueItem(ticker, engineType, spread, ftfc, currentPrice, today) {
  // engineType = 'BULL_PUT' or 'BEAR_CALL'
  var isBullPut = engineType === 'BULL_PUT';
  var shortDir  = isBullPut ? 'PUTS' : 'CALLS';
  var contractType = isBullPut ? 'Put' : 'Call';
  var source = isBullPut ? 'SPREAD_FTFC_BULLPUT' : 'SPREAD_FTFC_BEARCALL';

  var shortStrike = spread && spread.shortStrike ? spread.shortStrike : null;
  var longStrike  = spread && spread.longStrike  ? spread.longStrike  : null;
  var netCredit   = spread && spread.netCredit   ? spread.netCredit   : 0;
  var expiration  = spread && spread.expirationDate
    ? fmtExp(spread.expirationDate)
    : (spread && spread.expiration ? fmtExp(spread.expiration) : fmtExp(new Date(Date.now() + DTE_TARGET*86400000)));

  var note =
    'FTFC ' + ftfc.direction + ' ' + ftfc.aligned + '/4 | ' +
    'short=' + shortStrike + '/long=' + longStrike + ' ' + contractType +
    ' | net credit=$' + netCredit.toFixed(2) +
    ' | dte=' + (spread && spread.dte ? spread.dte : DTE_TARGET) +
    ' | proxy=' + ftfc.proxy + '@' + (ftfc.currentPrice || currentPrice);

  return {
    ticker: ticker,
    direction: shortDir,
    triggerPrice: Number((currentPrice || 0).toFixed(2)),
    contractSymbol: '(multi-leg spread)',
    strike: shortStrike,
    expiration: expiration,
    contractType: contractType,
    // For credit spreads maxEntryPrice is meaningless; we overload it as a
    // max-credit-target sentinel. Executor should recognize isSpread.
    maxEntryPrice: 100,
    stopPct: -2.0,           // 2x-credit stop (executor interprets when isSpread)
    contracts: 1,
    tradeDate: today,
    tradeType: 'SWING',
    grade: 'A',
    source: source,
    note: note,
    isSpread: true,
    spreadLegs: spread ? [
      { side: 'SELL', symbol: spread.shortSymbol, strike: spread.shortStrike, type: contractType },
      { side: 'BUY',  symbol: spread.longSymbol,  strike: spread.longStrike,  type: contractType },
    ] : [],
    targets: [0.50, 0.75],   // take 50% / 75% of max credit
    management: 'SPREAD',
  };
}

// -----------------------------------------------------------------
// DISCORD
// -----------------------------------------------------------------
async function postAlert(item, ftfc, mode) {
  var webhookUrl = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhookUrl) return;
  try {
    var lines = [
      'SPREAD ' + (item.source === 'SPREAD_FTFC_BULLPUT' ? 'BULL PUT' : 'BEAR CALL') +
        ' -- ' + item.ticker + ' (FTFC ' + ftfc.direction + ' ' + ftfc.aligned + '/4)',
      '--------------------------------',
      'Short:    ' + item.strike + ' ' + item.contractType + ' @ ' + item.expiration,
      'Legs:     ' + (item.spreadLegs || []).map(function(l){ return l.side + ' ' + l.symbol; }).join(' / '),
      'Credit:   $' + ((item.spreadLegs && item.spreadLegs.length) ? (item.note.match(/credit=\$([0-9.]+)/) || [,'?'])[1] : '?'),
      'Proxy:    ' + ftfc.proxy + ' @ $' + (ftfc.currentPrice || 0),
      'Mode:     ' + mode,
      '--------------------------------',
      'Status:   ' + (mode === 'AUTOFIRE' ? 'PLACED' : 'QUEUED for manual review'),
    ].join('\n');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum Spread Scout',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) {
    console.error('[SPREAD] postAlert:', e.message);
  }
}

// -----------------------------------------------------------------
// MAIN POLL
// -----------------------------------------------------------------
var _running = false;

async function pollOnce() {
  if (_running) {
    return { ok: false, action: 'skipped', reason: 'already running' };
  }
  _running = true;

  try {
    // 1) Time gate
    var win = withinTradingWindow();
    if (!win.ok) {
      console.log('[SPREAD] outside window: ' + win.reason);
      return { ok: true, action: 'skipped', reason: win.reason };
    }
    var today = getETParts().ymd;

    // 2) Load state for dedup
    var state = loadState();
    if (!state[today]) state[today] = { BULLPUT: false, BEARCALL: false };

    // 3) Load credit spread engine
    var engine;
    try { engine = require('./creditSpreadEngine'); }
    catch(e) {
      console.error('[SPREAD] creditSpreadEngine load failed:', e.message);
      return { ok: false, action: 'skipped', reason: 'engine not loadable' };
    }
    if (!engine || !engine.findOptimalStrikes) {
      return { ok: false, action: 'skipped', reason: 'engine missing findOptimalStrikes' };
    }

    // 4) Compute FTFC
    var tickers = getWatchlist();
    var primary = tickers[0] || 'SPX';
    var ftfc = await computeFTFC(primary);
    console.log('[SPREAD] FTFC ' + primary + ' -> ' + ftfc.direction + ' ' + ftfc.aligned + '/4 ' + JSON.stringify(ftfc.details));

    // 5) Decide direction
    if (ftfc.direction === 'MIXED' || ftfc.aligned < 3) {
      return { ok: true, action: 'mixed', reason: 'FTFC mixed (' + ftfc.aligned + '/4)', ftfc: ftfc };
    }

    var engineType = ftfc.direction === 'BULL' ? 'BULL_PUT' : 'BEAR_CALL';
    var dedupKey   = engineType === 'BULL_PUT' ? 'BULLPUT' : 'BEARCALL';
    if (state[today][dedupKey]) {
      return { ok: true, action: 'skipped', reason: 'already fired ' + dedupKey + ' today', ftfc: ftfc };
    }

    // 6) Pull optimal strikes from engine
    var spread;
    try {
      spread = await engine.findOptimalStrikes(engineType);
    } catch(e) {
      console.error('[SPREAD] findOptimalStrikes threw:', e.message);
      return { ok: false, action: 'skipped', reason: 'strikes error: ' + e.message, ftfc: ftfc };
    }

    if (!spread) {
      return { ok: true, action: 'skipped', reason: 'no valid spread from engine', ftfc: ftfc };
    }
    if (typeof spread.netCredit === 'number' && spread.netCredit < MIN_CREDIT) {
      return {
        ok: true, action: 'skipped',
        reason: 'credit $' + spread.netCredit + ' < $' + MIN_CREDIT,
        ftfc: ftfc,
      };
    }

    // 7) Build queue item
    var item = buildQueueItem(
      primary, engineType, spread, ftfc,
      ftfc.currentPrice, today
    );

    // 8) Queue OR autofire
    if (isAutofire()) {
      if (!engine.placeSpreadOrder) {
        return { ok: false, action: 'skipped', reason: 'placeSpreadOrder missing', ftfc: ftfc };
      }
      try {
        var placed = await engine.placeSpreadOrder(spread);
        state[today][dedupKey] = true;
        saveState(state);
        await postAlert(item, ftfc, 'AUTOFIRE');
        console.log('[SPREAD] AUTOFIRED ' + engineType + ' -> ' + JSON.stringify(placed).slice(0, 200));
        return { ok: true, action: 'placed', item: item, ftfc: ftfc, placed: placed };
      } catch(e) {
        console.error('[SPREAD] placeSpreadOrder threw:', e.message);
        return { ok: false, action: 'skipped', reason: 'place error: ' + e.message, ftfc: ftfc };
      }
    }

    // Default: queue-only mode
    try {
      var be = require('./brainEngine');
      if (be && be.bulkAddQueuedTrades) {
        be.bulkAddQueuedTrades([item], { replaceAll: false });
      } else if (be && be.addQueuedTrade) {
        be.addQueuedTrade(item);
      }
    } catch(e) {
      console.error('[SPREAD] queue push error:', e.message);
    }

    state[today][dedupKey] = true;
    saveState(state);
    await postAlert(item, ftfc, 'QUEUE');

    console.log('[SPREAD] QUEUED ' + engineType + ' short=' + item.strike + ' exp=' + item.expiration);
    return { ok: true, action: 'queued', item: item, ftfc: ftfc };
  } catch(e) {
    console.error('[SPREAD] pollOnce error:', e.message);
    return { ok: false, action: 'skipped', reason: e.message };
  } finally {
    _running = false;
  }
}

module.exports = {
  pollOnce:    pollOnce,
  run:         pollOnce,
  computeFTFC: computeFTFC,
};
