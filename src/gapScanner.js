// gapScanner.js -- Stratum v7.5
// PRE-MARKET GAP SCANNER
//
// Runs at 9:25 AM ET. Fetches quotes for the full watchlist in ONE batch call.
// Ranks by gap % (open vs previous close). Top 5 gappers become the
// PRIORITY list — these get scanned FIRST by Casey, before any other ticker.
//
// This is how you catch AMD +7.5% at open instead of finding it at 2PM
// after scanning 53 tickers sequentially.
//
// Also runs at 9:31 to re-rank with live opening prices.

var fetch = require('node-fetch');

var TS_BASE = 'https://api.tradestation.com/v3';

// ================================================================
// PRIORITY LIST — consumed by all entry engines
// ================================================================
var _priorityList = [];       // [{ ticker, gapPct, gapDir, prevClose, open, volume }]
var _priorityTickers = [];    // just the ticker strings, in rank order
var _lastScan = 0;
var _scanCount = 0;

// ================================================================
// WATCHLIST — same master list the engines use
// ================================================================
var DEFAULT_WATCH = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL,NFLX,AVGO,COIN,CRM,UBER,SHOP,NOW,HOOD,SOFI,MU,DKNG,RKLB,NET,PANW,CRWD,SNOW,WDAY,ARM,ANET,DELL,SMCI,MSTR,SMH,ARKK,XBI,IONQ,HIMS,RGTI,SOUN,SNAP,APP,AFRM,UPST,PYPL,RDDT,ROKU,SE,MARA,RIOT,LUNR,ACHR';

function getWatchlist() {
  try {
    var rc = require('./runtimeConfig');
    var v = rc.get('GAP_WATCHLIST') || rc.get('CASEY_WATCHLIST');
    if (v) return v.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
  } catch(e) {}
  return (process.env.CASEY_WATCHLIST || DEFAULT_WATCH)
    .split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// ================================================================
// SCAN — one batch quote call, rank by gap %
// ================================================================
async function scan() {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) {
      console.log('[GAP] no token');
      return { ok: false, reason: 'no token' };
    }

    var watch = getWatchlist();

    // TradeStation batch quotes — up to 100 symbols in one call
    // Split into chunks of 50 to stay safe
    var allQuotes = [];
    for (var c = 0; c < watch.length; c += 50) {
      var chunk = watch.slice(c, c + 50);
      var url = TS_BASE + '/marketdata/quotes/' + chunk.join(',');
      var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) {
        console.log('[GAP] quotes batch failed: ' + res.status);
        continue;
      }
      var data = await res.json();
      var quotes = data.Quotes || data.quotes || [];
      if (Array.isArray(quotes)) allQuotes = allQuotes.concat(quotes);
    }

    if (allQuotes.length === 0) {
      console.log('[GAP] no quotes returned');
      return { ok: false, reason: 'no quotes' };
    }

    // Calculate gap % for each
    var gaps = [];
    for (var i = 0; i < allQuotes.length; i++) {
      var q = allQuotes[i];
      // Handle nested Quote object
      var qt = q.Quote || q;
      var sym = qt.Symbol || '';
      var prevClose = parseFloat(qt.PreviousClose || 0);
      var openPrice = parseFloat(qt.Open || 0);
      var lastPrice = parseFloat(qt.Last || qt.Close || 0);
      var volume = parseInt(qt.Volume || 0, 10);
      var prevVolume = parseInt(qt.PreviousVolume || 0, 10);

      if (!prevClose || prevClose === 0) continue;

      // Use open if available, otherwise last
      var refPrice = openPrice > 0 ? openPrice : lastPrice;
      var gapPct = ((refPrice - prevClose) / prevClose) * 100;
      var gapDir = gapPct >= 0 ? 'UP' : 'DOWN';

      // Volume ratio — is today's volume tracking ahead of yesterday?
      var volRatio = prevVolume > 0 ? (volume / prevVolume) : 0;

      gaps.push({
        ticker: sym,
        gapPct: Math.round(gapPct * 100) / 100,
        absGap: Math.abs(gapPct),
        gapDir: gapDir,
        prevClose: prevClose,
        open: openPrice,
        last: lastPrice,
        volume: volume,
        volRatio: Math.round(volRatio * 100) / 100,
      });
    }

    // Sort by absolute gap % descending
    gaps.sort(function(a, b) { return b.absGap - a.absGap; });

    // Top 10 for logging, top 5 for priority
    var top10 = gaps.slice(0, 10);
    var top5 = gaps.slice(0, 5);

    _priorityList = top5;
    _priorityTickers = top5.map(function(g) { return g.ticker; });
    _lastScan = Date.now();
    _scanCount++;

    // Log
    console.log('[GAP] === PRE-MARKET GAP SCAN #' + _scanCount + ' ===');
    for (var j = 0; j < top10.length; j++) {
      var g = top10[j];
      var star = j < 5 ? ' ★ PRIORITY' : '';
      console.log('[GAP] ' + (j+1) + '. ' + g.ticker + ' ' + g.gapDir + ' ' +
        g.gapPct + '% | open=$' + g.open + ' prev=$' + g.prevClose +
        ' vol=' + g.volume + ' volRatio=' + g.volRatio + star);
    }

    // Discord alert for top 5
    await postDiscord(top5);

    return { ok: true, count: gaps.length, top5: top5, top10: top10 };
  } catch(e) {
    console.error('[GAP] scan error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ================================================================
// DISCORD ALERT
// ================================================================
async function postDiscord(top5) {
  var hook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!hook || top5.length === 0) return;
  try {
    var lines = ['🔥 PRE-MARKET GAP SCAN — TOP 5 MOVERS'];
    for (var i = 0; i < top5.length; i++) {
      var g = top5[i];
      lines.push((i+1) + '. ' + g.ticker + ' ' + g.gapDir + ' ' + g.gapPct + '%' +
        ' | open $' + g.open + ' | vol ratio ' + g.volRatio + 'x');
    }
    lines.push('');
    lines.push('These scan FIRST at open. Biggest gap = first entry.');
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum Gap Scanner',
        content: '```\n' + lines.join('\n') + '\n```',
      }),
    });
  } catch(e) { console.log('[GAP] discord error: ' + e.message); }
}

// ================================================================
// GETTERS — used by entry engines to prioritize
// ================================================================

// Returns the priority tickers in rank order (biggest gap first)
function getPriorityTickers() {
  return _priorityTickers.slice();
}

// Returns full gap data for a ticker (null if not in top 5)
function getGapData(ticker) {
  for (var i = 0; i < _priorityList.length; i++) {
    if (_priorityList[i].ticker === ticker.toUpperCase()) return _priorityList[i];
  }
  return null;
}

// Returns true if priority list is fresh (scanned within last 30 min)
function hasPriority() {
  return _priorityTickers.length > 0 && (Date.now() - _lastScan) < 30 * 60 * 1000;
}

// Reorder a watchlist to put priority tickers first
function prioritize(watchlist) {
  if (!hasPriority()) return watchlist;
  var prio = [];
  var rest = [];
  // Put priority tickers first, in gap-rank order
  for (var p = 0; p < _priorityTickers.length; p++) {
    if (watchlist.indexOf(_priorityTickers[p]) !== -1) {
      prio.push(_priorityTickers[p]);
    }
  }
  // Then the rest in original order
  for (var i = 0; i < watchlist.length; i++) {
    if (prio.indexOf(watchlist[i]) === -1) {
      rest.push(watchlist[i]);
    }
  }
  return prio.concat(rest);
}

// Full state for diagnostics
function getState() {
  return {
    priorityTickers: _priorityTickers,
    priorityList: _priorityList,
    lastScan: _lastScan ? new Date(_lastScan).toISOString() : null,
    scanCount: _scanCount,
    fresh: hasPriority(),
  };
}

module.exports = {
  scan: scan,
  getPriorityTickers: getPriorityTickers,
  getGapData: getGapData,
  hasPriority: hasPriority,
  prioritize: prioritize,
  getState: getState,
};
