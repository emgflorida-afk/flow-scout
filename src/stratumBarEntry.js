// stratEntry.js -- Stratum v7.5
// -----------------------------------------------------------------
// STRAT (Primo) scout. Detects F2U, F2D, Inside-bar breakouts,
// Hammers, Shooters on 60-min and Daily timeframes across a
// watchlist, applies a STRICT FTFC veto, then auto-queues the
// trades via brainEngine.bulkAddQueuedTrades().
//
// Pattern mirrors jsmithPoller.js: pollOnce() + run alias,
// STATE_DIR dedup, Discord confirm via DISCORD_EXECUTE_NOW_WEBHOOK.
//
// NOTE: bottomTick.js has a detectSetups() helper but it uses a
// different schema (CRT / 2-1-2 / 3-1). Per Primo, we want pure
// F2U/F2D/Inside/Hammer/Shooter classification on CLOSED bars, so
// we implement the classifier inline here. Read-only on bottomTick.
// -----------------------------------------------------------------

var fetch = require('node-fetch');
var fs = require('fs');

// -----------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------
var DEFAULT_WATCHLIST = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL,NFLX,AVGO,COIN,CRM,UBER,SHOP,NOW,HOOD,SOFI,MU,DKNG,RKLB,NET,PANW,CRWD,SNOW,WDAY,ARM,ANET,DELL,SMCI,MSTR,SMH,ARKK,XBI,IONQ,HIMS,RGTI,SOUN,SNAP,APP,AFRM,UPST,PYPL,RDDT,ROKU,SE,MARA,RIOT,LUNR,ACHR,BABA,CRWV';

function getWatchlist() {
  try { var rc = require('./runtimeConfig'); var v = rc.get('STRAT_WATCHLIST'); if (v) return v.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean); } catch(e){}
  var raw = process.env.STRAT_WATCHLIST || DEFAULT_WATCHLIST;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// -----------------------------------------------------------------
// DEDUP STORE
// -----------------------------------------------------------------
var STATE_DIR = process.env.STATE_DIR || '/tmp';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e) {}
var DEDUP_FILE = STATE_DIR + '/strat_dedup.json';
var DEDUP_MS = 4 * 60 * 60 * 1000; // 4 hours

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      return JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')) || {};
    }
  } catch(e) { console.error('[STRAT] dedup load:', e.message); }
  return {};
}
function saveDedup(d) {
  try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(d)); }
  catch(e) { console.error('[STRAT] dedup save:', e.message); }
}
function dedupKey(ticker, signal, tf) { return ticker + ':' + signal + ':' + tf; }
function isDuplicate(d, key) {
  var t = d[key];
  return t && (Date.now() - t < DEDUP_MS);
}
function pruneDedup(d) {
  var cutoff = Date.now() - DEDUP_MS;
  Object.keys(d).forEach(function(k){ if (d[k] < cutoff) delete d[k]; });
}

// -----------------------------------------------------------------
// TRADESTATION BARS
// -----------------------------------------------------------------
async function tsBars(ticker, unit, interval, barsback, token) {
  try {
    // sessiontemplate=Default only valid for Minute interval; silent reject
    // on Daily/Weekly/Monthly. See Apr 15 2026 spreadScout fix.
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker +
      '?interval=' + interval + '&unit=' + unit +
      '&barsback=' + barsback +
      (unit === 'Minute' ? '&sessiontemplate=Default' : '');
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) {
      console.error('[STRAT] bars ' + ticker + ' ' + unit + ' ' + res.status);
      return [];
    }
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) {
    console.error('[STRAT] bars error ' + ticker + ':', e.message);
    return [];
  }
}

// Apr 20 2026: classification now delegated to shared stratClassifier.js
// (single source of truth between scanner and brain).
var stratClassifier = require('./stratClassifier');
var normBar = stratClassifier.normBar;
var classify = stratClassifier.evalBar;

// Pick the single strongest signal on a timeframe (priority: F2U/F2D > Inside > Hammer/Shooter)
function detectSignal(bars, currentPrice) {
  if (!bars || bars.length < 3) return null;
  // Signal bar = second-to-last (CLOSED). last may still be forming.
  var signal = normBar(bars[bars.length - 2]);
  var prev   = normBar(bars[bars.length - 3]);
  if (!signal || !prev) return null;
  var cls = classify(signal, prev);
  if (!cls) return null;

  if (cls.f2u) {
    return { signal: 'F2U', direction: 'PUTS',  trigger: signal.l, bar: signal, source: 'STRATUMBAR_F2U' };
  }
  if (cls.f2d) {
    return { signal: 'F2D', direction: 'CALLS', trigger: signal.h, bar: signal, source: 'STRATUMBAR_F2D' };
  }
  if (cls.inside) {
    // Inside bar breakout by current price
    if (currentPrice > signal.h) {
      return { signal: 'INSIDE_BO_UP', direction: 'CALLS', trigger: signal.h, bar: signal, source: 'STRATUMBAR_INSIDE_BO' };
    }
    if (currentPrice < signal.l) {
      return { signal: 'INSIDE_BO_DN', direction: 'PUTS',  trigger: signal.l, bar: signal, source: 'STRATUMBAR_INSIDE_BO' };
    }
    return null;
  }
  if (cls.hammer) {
    return { signal: 'HAMMER',  direction: 'CALLS', trigger: signal.h, bar: signal, source: 'STRATUMBAR_HAMMER' };
  }
  if (cls.shooter) {
    return { signal: 'SHOOTER', direction: 'PUTS',  trigger: signal.l, bar: signal, source: 'STRATUMBAR_SHOOTER' };
  }
  return null;
}

// -----------------------------------------------------------------
// FTFC VETO (STRICT — no MIXED, no soft-fail on errors).
// Apr 20: AB's rule locked — MIXED is NOT alignment, it's indecision.
// If FTFC is MIXED or unverifiable, SKIP the trade.
// Primo: "trade in the direction of Full Timeframe Continuity."
// -----------------------------------------------------------------
function ftfcAgrees(direction, ftfc) {
  // HARD-FAIL on missing/error FTFC (was soft-fail pre-Apr 20; caused mixed fires)
  if (!ftfc || ftfc.state === 'ERR' || ftfc.state === undefined) return false;
  var state = ftfc.state;
  if (direction === 'CALLS') {
    // Bullish signal must have clean UP alignment — MIXED is no longer acceptable
    return state === 'FTFC UP' || state === 'mostly UP';
  }
  // PUTS — bearish signal must have clean DOWN alignment
  return state === 'FTFC DOWN' || state === 'mostly DOWN';
}

// -----------------------------------------------------------------
// QUEUE ITEM BUILDER
// -----------------------------------------------------------------
function buildContractSymbol(ticker, direction, strike, expDate) {
  var yy = String(expDate.getFullYear()).slice(2);
  var mm = String(expDate.getMonth() + 1).padStart(2, '0');
  var dd = String(expDate.getDate()).padStart(2, '0');
  var cp = direction === 'CALLS' ? 'C' : 'P';
  return ticker + ' ' + yy + mm + dd + cp + strike;
}

function pickExpiry(daysOut) {
  // Simple: now + daysOut, roll forward to Friday
  var d = new Date();
  d.setDate(d.getDate() + daysOut);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

function buildItem(ticker, sig, tf, currentPrice, ftfcDir) {
  var is60 = (tf === '60m');
  var tradeType = is60 ? 'DAY' : 'SWING';
  var contracts = is60 ? 2 : 3;
  var dte       = is60 ? 5 : 10;
  // GRADE: FTFC-aligned F2U/F2D = A+ (Primo's textbook actionable signal).
  // Non-aligned reversal or continuation = A. No B grades ever emerge here.
  var ftfcAligned = ftfcDir === 'FTFC UP' || ftfcDir === 'FTFC DOWN';
  var isReversal  = sig.signal === 'F2U' || sig.signal === 'F2D';
  var grade = (isReversal && ftfcAligned) ? 'A+' : 'A';
  var expDate   = pickExpiry(dte);
  var strike    = Math.round(currentPrice);
  var contractType = sig.direction === 'CALLS' ? 'Call' : 'Put';
  var contractSymbol = buildContractSymbol(ticker, sig.direction, strike, expDate);
  var mm = String(expDate.getMonth() + 1).padStart(2, '0');
  var dd = String(expDate.getDate()).padStart(2, '0');
  var yyyy = String(expDate.getFullYear());
  var expStr = mm + '-' + dd + '-' + yyyy;

  return {
    ticker: ticker,
    direction: sig.direction,
    triggerPrice: Number(sig.trigger.toFixed(2)),
    contractSymbol: contractSymbol,
    strike: strike,
    expiration: expStr,
    contractType: contractType,
    maxEntryPrice: 6.00,
    stopPct: -0.30,
    targets: [0.25, 0.50, 1.00],
    contracts: contracts,
    management: 'STRAT',
    tradeType: tradeType,
    grade: grade,
    source: sig.source,
    note: tf + ' ' + sig.signal + ' bar=' + JSON.stringify(sig.bar) + ' ftfc=' + ftfcDir,
  };
}

// -----------------------------------------------------------------
// DISCORD CONFIRM
// -----------------------------------------------------------------
async function postConfirmAlert(item, sig, tf, ftfcDir) {
  var webhookUrl = process.env.DISCORD_STRATUMBAR_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhookUrl) return;
  try {
    var lines = [
      'STRAT ' + sig.signal + ' — ' + item.ticker + ' ' + item.direction + ' [' + tf + ']',
      '--------------------------------',
      'Trigger:  ' + (item.direction === 'CALLS' ? '>= ' : '<= ') + '$' + item.triggerPrice,
      'Contract: ' + item.contractSymbol + ' x' + item.contracts,
      'Max:      $' + item.maxEntryPrice.toFixed(2),
      'Stop:     -30%',
      'TP:       25% / 50% / 100%',
      'FTFC:     ' + ftfcDir,
      'Type:     ' + item.tradeType,
      '--------------------------------',
      'Status: PENDING — STRAT auto-queue',
    ].join('\n');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum STRAT Scout',
        content: '```\n' + lines + '\n```',
      }),
    });
  } catch(e) {
    console.error('[STRAT] postConfirmAlert error:', e.message);
  }
}

// -----------------------------------------------------------------
// MAIN POLL
// -----------------------------------------------------------------
var _running = false;
async function pollOnce() {
  if (_running) return { ok: false, checked: 0, queued: 0, skipped: 0, reason: 'already running' };
  _running = true;
  var checked = 0, queued = 0, skipped = 0;
  var queuedItems = [];
  var alerts = [];

  try {
    var ts = require('./tradestation');
    var token;
    try { token = await ts.getAccessToken(); }
    catch(e) {
      console.error('[STRAT] no TS token:', e.message);
      return { ok: false, checked: 0, queued: 0, skipped: 0, reason: 'no token' };
    }
    if (!token) {
      return { ok: false, checked: 0, queued: 0, skipped: 0, reason: 'no token' };
    }

    var mb = null;
    try { mb = require('./morningBrief'); } catch(e) {}

    var dedup = loadDedup();
    pruneDedup(dedup);

    var tickers = getWatchlist();
    // PRIORITY REORDER — biggest pre-market gappers scan first
    try { var gs = require('./gapScanner'); if (gs.hasPriority()) { tickers = gs.prioritize(tickers); } } catch(e) {}

    for (var i = 0; i < tickers.length; i++) {
      var ticker = tickers[i];
      checked++;

      // Pull bars: 60-min (last 10) and daily (last 5)
      var bars60 = await tsBars(ticker, 'Minute', 60, 10, token);
      var barsD  = await tsBars(ticker, 'Daily',  1,  5, token);
      if ((!bars60 || bars60.length < 3) && (!barsD || barsD.length < 3)) {
        skipped++;
        continue;
      }

      // Current price = close of last (forming) bar
      var lastBar = normBar(bars60[bars60.length - 1]) || normBar(barsD[barsD.length - 1]);
      var currentPrice = lastBar ? lastBar.c : 0;
      if (!currentPrice) { skipped++; continue; }

      // Detect on both timeframes; prefer 60m if both fire
      var sig60 = detectSignal(bars60, currentPrice);
      var sigD  = detectSignal(barsD,  currentPrice);

      var candidates = [];
      if (sig60) candidates.push({ sig: sig60, tf: '60m' });
      if (sigD)  candidates.push({ sig: sigD,  tf: 'D'   });

      for (var k = 0; k < candidates.length; k++) {
        var c = candidates[k];

        // REGIME GATE — block counter-trend entries (replaces soft-fail FTFC)
        var regimeGate = require('./regimeGate');
        var gate = await regimeGate.canEnter(ticker, c.sig.direction, token);
        if (!gate.allowed) {
          console.log('[STRAT] REGIME VETO ' + ticker + ' ' + c.sig.signal + ': ' + gate.reason);
          skipped++;
          continue;
        }

        // FTFC veto (now hard-fail: if FTFC opposes, block even if API errors)
        var ftfcDir = 'N/A';
        if (mb && mb.checkFTFC) {
          try {
            var ftfc = await mb.checkFTFC(ticker, currentPrice, token);
            ftfcDir = ftfc && ftfc.state ? ftfc.state : 'N/A';
            if (!ftfcAgrees(c.sig.direction, ftfc)) {
              console.log('[STRAT] FTFC veto ' + ticker + ' ' + c.sig.signal + ' (ftfc=' + ftfcDir + ')');
              skipped++;
              continue;
            }
          } catch(e) {
            console.log('[STRAT] FTFC check failed ' + ticker + ': ' + e.message + ' — regime gate already passed, proceeding');
          }
        }

        // Dedup
        var key = dedupKey(ticker, c.sig.signal, c.tf);
        if (isDuplicate(dedup, key)) {
          skipped++;
          continue;
        }

        var item = buildItem(ticker, c.sig, c.tf, currentPrice, ftfcDir);
        queuedItems.push(item);
        alerts.push({ item: item, sig: c.sig, tf: c.tf, ftfcDir: ftfcDir });
        dedup[key] = Date.now();
        queued++;
      }
    }

    // Push to brain queue
    if (queuedItems.length > 0) {
      try {
        var be = require('./brainEngine');
        if (be && be.bulkAddQueuedTrades) {
          be.bulkAddQueuedTrades(queuedItems, { replaceAll: false });
        }
      } catch(e) { console.error('[STRAT] queue push error:', e.message); }

      for (var a = 0; a < alerts.length; a++) {
        await postConfirmAlert(alerts[a].item, alerts[a].sig, alerts[a].tf, alerts[a].ftfcDir);
      }
    }

    saveDedup(dedup);

    console.log('[STRAT] pollOnce checked=' + checked + ' queued=' + queued + ' skipped=' + skipped);
    return { ok: true, checked: checked, queued: queued, skipped: skipped };
  } catch(e) {
    console.error('[STRAT] pollOnce error:', e.message);
    return { ok: false, checked: checked, queued: queued, skipped: skipped, reason: e.message };
  } finally {
    _running = false;
  }
}

module.exports = {
  pollOnce: pollOnce,
  run: pollOnce,
  // exported for testing
  classify: classify,
  detectSignal: detectSignal,
  ftfcAgrees: ftfcAgrees,
};
