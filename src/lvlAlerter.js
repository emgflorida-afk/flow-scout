// =============================================================================
// LVL ALERTER (Apr 29 2026)
//
// Server-side LVL Framework alerter. Scans a curated watchlist using
// lvlComputer.computeMultiTF() and posts state-transition alerts to a
// dedicated Discord channel (#stratum-lvl).
//
// Top-10 default watchlist: AMZN, AAPL, NVDA, TSLA, META, GOOGL, MSFT, SPY, QQQ, AMD
// (override via env LVL_WATCHLIST=AMZN,AAPL,...).
//
// Timeframes: Daily (primary, KIAKILI standard) + 1H (intraday companion).
// Set env LVL_TFS=Daily,1H to customize.
//
// Posts on transitions:
//   - NONE → LVL_LONG_25 / EARLY_LONG / LVL_SHORT_75 / EARLY_SHORT / HIGH_BREAK / LOW_BREAK
//   - any → TP1_HIT
//   - any → STOP_HIT
//
// State persists to /data/lvl_alerter_state.json so we don't spam on restarts.
//
// Public API:
//   runScan(opts)              - one-shot scan + post; returns { scanned, posted }
//   getDefaultWatchlist()      - introspection helper
//   formatAlert(ticker, tf, st)- pure formatter (testable without HTTP)
// =============================================================================

var fs = require('fs');
var path = require('path');
var lvlComputer = require('./lvlComputer');

var WEBHOOK_URL = process.env.DISCORD_STRATUMLVL_WEBHOOK || '';

var DEFAULT_WATCHLIST_TICKERS = [
  'AMZN', 'AAPL', 'NVDA', 'TSLA', 'META',
  'GOOGL', 'MSFT', 'SPY', 'QQQ', 'AMD'
];

var DEFAULT_TFS = ['Daily', '1H'];

var STATE_FILE = process.env.LVL_STATE_FILE
  || (fs.existsSync('/data') ? '/data/lvl_alerter_state.json' : path.join(__dirname, '..', 'lvl_alerter_state.json'));

// =============================================================================
// CONFIG HELPERS
// =============================================================================
function getWatchlist() {
  var env = (process.env.LVL_WATCHLIST || '').trim();
  if (env) return env.split(',').map(function(t){ return t.trim().toUpperCase(); }).filter(Boolean);
  return DEFAULT_WATCHLIST_TICKERS.slice();
}

function getTfs() {
  var env = (process.env.LVL_TFS || '').trim();
  if (env) return env.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
  return DEFAULT_TFS.slice();
}

function getDefaultWatchlist() { return getWatchlist(); }

// =============================================================================
// STATE PERSISTENCE  - { TICKER: { Daily: 'PREV_SIGNAL', '1H': 'PREV_SIGNAL' } }
// =============================================================================
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    var raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[LVL-ALERTER] loadState error:', e.message);
    return {};
  }
}

function saveState(state) {
  try {
    var dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[LVL-ALERTER] saveState error:', e.message);
  }
}

// =============================================================================
// SUGGESTED CONTRACT (matches LVL Assist Pine logic — round trigger to step)
// =============================================================================
function strikeStep(price) {
  if (!isFinite(price)) return 1.0;
  if (price < 25)   return 0.5;
  if (price < 100)  return 1.0;
  if (price < 250)  return 2.5;
  if (price < 500)  return 5.0;
  if (price < 1000) return 10.0;
  return 25.0;
}

function suggestedContract(state) {
  if (!state || !state.plan || !isFinite(state.plan.entry)) return '--';
  var step = strikeStep(state.spot);
  var strike = Math.round(state.plan.entry / step) * step;
  var cp = state.isLong ? 'c' : state.isShort ? 'p' : '';
  if (!cp) return '--';
  return '$' + strike.toFixed(step < 1 ? 2 : (step < 10 ? 1 : 0)).replace(/\.0$/, '') + cp;
}

// =============================================================================
// ALERT FORMATTER
// =============================================================================
function tfLabel(tf) { return tf === 'Daily' ? '1D' : tf; }

function fmtPrice(v) {
  if (!isFinite(v) || v == null) return '--';
  return '$' + v.toFixed(2);
}

function pct(curr, base) {
  if (!isFinite(curr) || !isFinite(base) || base === 0) return '--';
  var p = ((curr - base) / base) * 100;
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

function signalHeader(signal, ticker, tf) {
  var lvlTf = tfLabel(tf);
  switch (signal) {
    case 'LVL_LONG_25':   return '🎯 ' + ticker + ' — LVL LONG 25% (' + lvlTf + ')';
    case 'EARLY_LONG':    return '🔵 ' + ticker + ' — EARLY LONG (' + lvlTf + ')';
    case 'LVL_SHORT_75':  return '🎯 ' + ticker + ' — LVL SHORT 75% (' + lvlTf + ')';
    case 'EARLY_SHORT':   return '🔵 ' + ticker + ' — EARLY SHORT (' + lvlTf + ')';
    case 'HIGH_BREAK':    return '⬆ '  + ticker + ' — HIGH BREAK (' + lvlTf + ')';
    case 'LOW_BREAK':     return '⬇ '  + ticker + ' — LOW BREAK (' + lvlTf + ')';
    case 'TP1_HIT':       return '✅ ' + ticker + ' — TP1 HIT (' + lvlTf + ')';
    case 'STOP_HIT':      return '🛑 ' + ticker + ' — STOP HIT (' + lvlTf + ')';
    default:              return '⚪ ' + ticker + ' — ' + signal + ' (' + lvlTf + ')';
  }
}

function formatAlert(ticker, tf, state) {
  var lines = [];
  lines.push(signalHeader(state.signal, ticker, tf));
  lines.push('────────────────────────────────');

  if (state.signal === 'TP1_HIT') {
    lines.push('TP1 hit at ' + fmtPrice(state.plan && state.plan.tp1) + ' — TRIM 50%');
    lines.push('Entry was:   ' + fmtPrice(state.plan && state.plan.entry));
    lines.push('Spot:        ' + fmtPrice(state.spot) + '   (' + pct(state.spot, state.plan && state.plan.entry) + ')');
    lines.push('Trail stop:  to entry / breakeven');
    lines.push('Runner TP2:  ' + fmtPrice(state.plan && state.plan.tp2));
  } else if (state.signal === 'STOP_HIT') {
    lines.push('Stop hit at ' + fmtPrice(state.plan && state.plan.stop) + ' — CLOSE TRADE');
    lines.push('Entry was: ' + fmtPrice(state.plan && state.plan.entry));
    lines.push('Spot:      ' + fmtPrice(state.spot));
  } else {
    var dir = state.direction === 'LONG' ? 'LONG' : state.direction === 'SHORT' ? 'SHORT' : '--';
    lines.push('Direction: ' + dir);
    lines.push('Spot:      ' + fmtPrice(state.spot));
    lines.push('Entry:     ' + fmtPrice(state.plan && state.plan.entry));
    lines.push('Stop:      ' + fmtPrice(state.plan && state.plan.stop));
    lines.push('TP1 (50%): ' + fmtPrice(state.plan && state.plan.tp1));
    lines.push('TP2:       ' + fmtPrice(state.plan && state.plan.tp2));
    lines.push('Suggested: ' + suggestedContract(state));
  }
  lines.push('────────────────────────────────');
  return lines.join('\n');
}

// =============================================================================
// DISCORD POST  (mirrors ideaValidator.postToDiscord pattern)
// =============================================================================
async function postToDiscord(message) {
  if (!WEBHOOK_URL) {
    console.log('[LVL-ALERTER] no DISCORD_STRATUMLVL_WEBHOOK set, would have posted:\n' + message);
    return;
  }
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '```\n' + message + '\n```',
        username: 'Stratum LVL Bot'
      })
    });
    if (!r.ok) console.error('[LVL-ALERTER] Discord HTTP ' + r.status);
  } catch (e) {
    console.error('[LVL-ALERTER] Discord error:', e.message);
  }
}

// =============================================================================
// TRANSITION DETECTOR
//
// Returns true if (prev → curr) is a transition we should announce.
// Rules:
//   - Any → TP1_HIT  : YES
//   - Any → STOP_HIT : YES
//   - NONE → active : YES
//   - prev === curr : NO (no change)
//   - active → NONE : NO (silent reset, no spam)
//   - active → different active (e.g. EARLY_LONG → LVL_LONG_25) : YES (real escalation)
// =============================================================================
function isTransition(prev, curr) {
  prev = prev || 'NONE';
  if (curr === prev) return false;
  if (curr === 'NONE') return false;          // active → NONE = silent
  if (curr === 'TP1_HIT' || curr === 'STOP_HIT') return true;
  if (prev === 'NONE') return true;
  // Active → different active - alert (e.g. promotion EARLY_LONG → LVL_LONG_25)
  return true;
}

// =============================================================================
// MAIN SCAN FUNCTION
// =============================================================================
async function runScan(opts) {
  opts = opts || {};
  if (!WEBHOOK_URL && !opts.dryRun) {
    console.log('[LVL-ALERTER] no DISCORD_STRATUMLVL_WEBHOOK set; skipping (set env var or pass dryRun:true)');
    return { ok: false, reason: 'no-webhook', scanned: 0, posted: 0 };
  }

  // Get TS token via shared module
  var tradestation = require('./tradestation');
  var token;
  try {
    token = await tradestation.getAccessToken();
  } catch (e) {
    console.error('[LVL-ALERTER] TS token fetch failed:', e.message);
    return { ok: false, reason: 'no-token', scanned: 0, posted: 0 };
  }

  var watchlist = opts.watchlist || getWatchlist();
  var tfs = opts.tfs || getTfs();

  var prevState = loadState();
  var newState = JSON.parse(JSON.stringify(prevState));
  var posted = 0;
  var scanned = 0;
  var alerts = [];

  for (var i = 0; i < watchlist.length; i++) {
    var ticker = watchlist[i];
    try {
      var result = await lvlComputer.computeMultiTF(ticker, tfs, token);
      scanned++;

      for (var t = 0; t < tfs.length; t++) {
        var tf = tfs[t];
        var tfState = result.tfs[tf];
        if (!tfState || !tfState.ok) continue;

        var prevSignal = (prevState[ticker] || {})[tf] || 'NONE';
        var currSignal = tfState.signal || 'NONE';

        if (isTransition(prevSignal, currSignal)) {
          var message = formatAlert(ticker, tf, tfState);
          alerts.push({ ticker: ticker, tf: tf, signal: currSignal, message: message });
          if (!opts.dryRun) await postToDiscord(message);
          posted++;
        }

        if (!newState[ticker]) newState[ticker] = {};
        newState[ticker][tf] = currSignal;
      }
    } catch (e) {
      console.error('[LVL-ALERTER] scan error ' + ticker + ':', e.message);
    }
  }

  saveState(newState);
  console.log('[LVL-ALERTER] scan done: ' + scanned + ' tickers, ' + posted + ' alerts posted');
  return { ok: true, scanned: scanned, posted: posted, alerts: alerts };
}

module.exports = {
  runScan:             runScan,
  formatAlert:         formatAlert,
  isTransition:        isTransition,
  getDefaultWatchlist: getDefaultWatchlist,
  suggestedContract:   suggestedContract,
};
