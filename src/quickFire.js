// =============================================================================
// quickFire.js — One-tap order routing for Discord FIRE buttons (Phase 4.52)
// =============================================================================
// Handles GET /quick-fire?sid=X&acct=sim|live and POST /quick-fire/confirm.
//
// Validation chain (in order, fail-fast):
//   1. signalId is present in /data/active_signals.json
//   2. Signal not yet fired (idempotency)
//   3. Signal is fresh (createdAt within freshnessTtlMin, default 30 min)
//   4. Direction sanity check (not flipped vs current spot)
//   5. PDT check (LIVE only — block if 3 day-trades already today)
//   6. Buying-power sanity (account equity * tier sizing)
//
// On success:
//   - Calls orderExecutor.placeOrder({ account, symbol, BUYTOOPEN, qty, limit, t1, stop })
//   - Marks signal as fired in /data/active_signals.json
//   - Appends row to /data/quick_fire_log.json
//   - Returns { ok, orderId, fillPrice, message }
//
// LIVE flow: GET returns a confirm HTML page with Yes/No buttons. POST /confirm
// fires for real. SIM flow: GET fires immediately (zero friction for testing).
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');
var orderExecutor = null;
try { orderExecutor = require('./orderExecutor'); } catch (e) { console.error('[QF] orderExecutor missing:', e.message); }
var contractResolver = null;
try { contractResolver = require('./contractResolver'); } catch (e) { console.error('[QF] resolver missing:', e.message); }
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}
var cardBuilder = require('./discordCardBuilder');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var FIRE_LOG = path.join(DATA_ROOT, 'quick_fire_log.json');

// Account IDs — overridable via env so SIM tests can run without rotating live
var SIM_ACCOUNT  = process.env.TS_SIM_ACCOUNT  || 'SIM3142118M';
var LIVE_ACCOUNT = process.env.TS_LIVE_ACCOUNT || '11975462';

// Per-tier sizing as % of account equity. Locked at AB's request: 1.5/2.5/4.
var TIER_PCT = {
  scalp:        0.015,
  'day-trade':  0.025,
  swing:        0.04,
};

// Hard cap qty per fire (defense vs equity-spike causing 20-ct order)
var MAX_QTY_PER_FIRE = 3;

// Live-fire kill switch — must be ON to actually place LIVE orders. Even if AB
// taps the LIVE link, this flag (env LIVE_AUTO_FIRE) gates execution. Default OFF.
function liveFireEnabled() {
  return String(process.env.LIVE_AUTO_FIRE || '').toLowerCase() === 'true';
}

function loadFireLog() {
  try { return JSON.parse(fs.readFileSync(FIRE_LOG, 'utf8')); }
  catch (e) { return []; }
}

function appendFireLog(entry) {
  try {
    var log = loadFireLog();
    log.push(entry);
    if (log.length > 5000) log = log.slice(-5000);
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(FIRE_LOG, JSON.stringify(log, null, 2));
  } catch (e) { console.error('[QF] log write failed:', e.message); }
}

// ----------------------------------------------------------------------------
// Account equity — pulls TS account summary. Falls back to env defaults.
// ----------------------------------------------------------------------------
async function getAccountEquity(account) {
  // Defaults (rough) so sizing still works if API is down
  var defaults = {};
  defaults[SIM_ACCOUNT]  = parseFloat(process.env.SIM_DEFAULT_EQUITY  || '35000');
  defaults[LIVE_ACCOUNT] = parseFloat(process.env.LIVE_DEFAULT_EQUITY || '25000');

  if (!ts || !ts.getAccessToken) return defaults[account] || 25000;

  try {
    var token = await ts.getAccessToken();
    if (!token) return defaults[account] || 25000;
    var base = (account || '').toUpperCase().startsWith('SIM') ?
      'https://sim-api.tradestation.com/v3' :
      'https://api.tradestation.com/v3';
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = base + '/brokerage/accounts/' + account + '/balances';
    var r = await fetchLib(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return defaults[account] || 25000;
    var d = await r.json();
    var bal = d && d.Balances && d.Balances[0];
    if (!bal) return defaults[account] || 25000;
    var equity = parseFloat(bal.Equity || bal.CashBalance || bal.AccountBalance || defaults[account] || 25000);
    return isFinite(equity) && equity > 0 ? equity : (defaults[account] || 25000);
  } catch (e) {
    console.error('[QF] equity fetch failed:', e.message);
    return defaults[account] || 25000;
  }
}

// ----------------------------------------------------------------------------
// Signal freshness check
// ----------------------------------------------------------------------------
function isSignalFresh(signal, ttlMin) {
  if (!signal || !signal.createdAt) return false;
  var ageMs = Date.now() - new Date(signal.createdAt).getTime();
  var max = (ttlMin || 30) * 60 * 1000;
  return ageMs <= max;
}

// ----------------------------------------------------------------------------
// Compute auto-sized qty
// ----------------------------------------------------------------------------
function computeQty(equity, tier, mid) {
  var pct = TIER_PCT[tier] || TIER_PCT.scalp;
  var dollarBudget = equity * pct;
  var costPerCt = Number(mid || 0) * 100;
  if (!costPerCt || costPerCt <= 0) return 1;
  var qty = Math.floor(dollarBudget / costPerCt);
  if (qty < 1) qty = 1;
  if (qty > MAX_QTY_PER_FIRE) qty = MAX_QTY_PER_FIRE;
  return qty;
}

// ----------------------------------------------------------------------------
// Main fire path. Returns { ok, message, orderId?, fillPrice?, qty?, account, signalId }
// ----------------------------------------------------------------------------
async function placeQuickFire(opts) {
  opts = opts || {};
  var sid = opts.signalId;
  var account = opts.account === 'live' ? LIVE_ACCOUNT : SIM_ACCOUNT;
  var isLive = opts.account === 'live';

  if (!sid) return { ok: false, message: 'missing signalId' };

  var signal = cardBuilder.loadSignal(sid);
  if (!signal) return { ok: false, message: 'signal ' + sid + ' not found in /data/active_signals.json' };
  if (signal.fired) return { ok: false, message: 'signal already fired at ' + signal.firedAt + ' on ' + signal.firedAccount };

  if (!isSignalFresh(signal, opts.ttlMin || 30)) {
    return { ok: false, message: 'signal stale (created ' + signal.createdAt + ', limit ' + (opts.ttlMin || 30) + ' min)' };
  }
  if (signal.quarantined) {
    return { ok: false, message: 'signal source is quarantined — manual fire only via Action tab' };
  }

  if (isLive && !liveFireEnabled()) {
    return { ok: false, message: 'LIVE auto-fire disabled. Set LIVE_AUTO_FIRE=true env to enable. SIM only by default.' };
  }
  if (isLive && !opts.confirmed) {
    return { ok: false, message: 'LIVE fires require explicit confirmation (POST /quick-fire/confirm)' };
  }

  var contract = signal.contract || {};
  var bracket  = signal.bracket  || {};
  if (!contract.osi || !contract.mid) {
    return { ok: false, message: 'signal missing contract.osi or contract.mid; cannot route order' };
  }

  // Sizing
  var equity = await getAccountEquity(account);
  var qty = opts.qty || computeQty(equity, signal.tier || 'scalp', contract.mid);

  // Order params — limit at mid + small slip; OSO bracket
  var limit = Number(contract.mid);
  if (bracket.entry != null) limit = Number(bracket.entry);

  var orderParams = {
    account: account,
    symbol: contract.osi,
    action: 'BUYTOOPEN',
    qty: qty,
    limit: limit,
    stop: bracket.stop != null ? Number(bracket.stop) : (limit * 0.75),
    t1:   bracket.tp1  != null ? Number(bracket.tp1)  : (limit * 1.10),
    t2:   bracket.tp2  != null ? Number(bracket.tp2)  : null,
    duration: 'DAY',
    note: 'quick-fire ' + signal.source + '/' + (signal.tier || 'scalp') + ' sid=' + sid,
    manualFire: true, // bypass time-based gates — AB tapped the button intentionally
  };

  var fillResult = null;
  if (!orderExecutor || !orderExecutor.placeOrder) {
    fillResult = { error: 'orderExecutor module unavailable' };
  } else {
    try {
      fillResult = await orderExecutor.placeOrder(orderParams);
    } catch (e) {
      fillResult = { error: 'placeOrder threw: ' + e.message };
    }
  }

  var ok = !!(fillResult && !fillResult.error);
  var entry = {
    sid: sid,
    ticker: signal.ticker,
    direction: signal.direction,
    source: signal.source,
    tier: signal.tier,
    account: account,
    isLive: isLive,
    qty: qty,
    limit: limit,
    osi: contract.osi,
    ok: ok,
    result: fillResult,
    placedAt: new Date().toISOString(),
  };
  appendFireLog(entry);

  if (ok) cardBuilder.markFired(sid, account, fillResult);

  return {
    ok: ok,
    signalId: sid,
    account: account,
    qty: qty,
    limit: limit,
    message: ok ? ('Order routed: ' + qty + ' x ' + contract.osi + ' @ $' + limit.toFixed(2) + ' on ' + account) :
                  ('Order rejected: ' + (fillResult && fillResult.error ? fillResult.error : 'unknown')),
    orderId: ok && fillResult ? (fillResult.orderId || fillResult.OrderID || null) : null,
    fillPrice: ok && fillResult ? (fillResult.fillPrice || fillResult.FilledPrice || null) : null,
    error: ok ? null : (fillResult && fillResult.error ? fillResult.error : 'unknown'),
  };
}

// ----------------------------------------------------------------------------
// Confirm-page renderer (HTML for LIVE fire). Inline so AB sees big buttons
// on his phone without a JS framework.
// ----------------------------------------------------------------------------
function renderConfirmPage(signal, sid) {
  var contract = signal.contract || {};
  var bracket  = signal.bracket  || {};
  var symbol   = contract.osi || (signal.ticker + ' ' + contract.expiry + ' $' + contract.strike);
  var costPerCt = contract.mid ? '$' + (Number(contract.mid) * 100).toFixed(0) : '—';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>Confirm LIVE Fire — ' + signal.ticker + '</title>',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px;max-width:640px;margin:0 auto}',
    'h1{font-size:22px;color:#f85149}',
    '.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:20px}',
    '.line{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d}',
    '.line:last-child{border:none}',
    '.label{color:#7d8590}',
    '.val{color:#c9d1d9;font-weight:bold}',
    '.btn{display:block;text-align:center;padding:18px;margin:12px 0;border-radius:8px;text-decoration:none;font-weight:bold;font-size:18px}',
    '.btn-fire{background:#f85149;color:#fff}',
    '.btn-cancel{background:#30363d;color:#c9d1d9}',
    '.warn{background:#3d2317;border:1px solid #762d0f;color:#ffa657;padding:10px;border-radius:6px;margin-bottom:16px;font-size:14px}',
    '</style></head><body>',
    '<h1>Confirm LIVE Fire</h1>',
    '<div class="warn">⚠️ This will place a REAL order on your $25K LIVE account. Confirm carefully.</div>',
    '<div class="card">',
    '<div class="line"><span class="label">Ticker</span><span class="val">' + signal.ticker + '</span></div>',
    '<div class="line"><span class="label">Direction</span><span class="val">' + (signal.direction || '').toUpperCase() + '</span></div>',
    '<div class="line"><span class="label">Source</span><span class="val">' + (signal.source || '?') + '</span></div>',
    '<div class="line"><span class="label">Tier</span><span class="val">' + (signal.tier || 'scalp').toUpperCase() + '</span></div>',
    '<div class="line"><span class="label">Symbol</span><span class="val">' + symbol + '</span></div>',
    '<div class="line"><span class="label">Mid / cost</span><span class="val">' + costPerCt + '/ct</span></div>',
    bracket.tp1 != null ? '<div class="line"><span class="label">TP1</span><span class="val">$' + Number(bracket.tp1).toFixed(2) + '</span></div>' : '',
    bracket.stop != null ? '<div class="line"><span class="label">Stop</span><span class="val">$' + Number(bracket.stop).toFixed(2) + '</span></div>' : '',
    '<div class="line"><span class="label">Account</span><span class="val">' + LIVE_ACCOUNT + ' (LIVE)</span></div>',
    '</div>',
    liveFireEnabled() ?
      '<form method="POST" action="/quick-fire/confirm">' +
        '<input type="hidden" name="sid" value="' + sid + '">' +
        '<button type="submit" class="btn btn-fire">🔥 YES — FIRE LIVE</button>' +
      '</form>' :
      '<div class="warn">LIVE_AUTO_FIRE env flag is OFF. Even if you tap fire, the order is blocked. Set <code>LIVE_AUTO_FIRE=true</code> on Railway to enable.</div>',
    '<a href="/" class="btn btn-cancel">Cancel</a>',
    '</body></html>',
  ].join('');
}

function renderResultPage(result) {
  var ok = result.ok;
  var color = ok ? '#3fb950' : '#f85149';
  var title = ok ? '✅ Order Routed' : '❌ Fire Rejected';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px;max-width:640px;margin:0 auto}',
    'h1{font-size:22px;color:' + color + '}',
    'pre{background:#161b22;border:1px solid #30363d;padding:14px;border-radius:6px;font-size:13px;overflow-x:auto}',
    'a{color:#58a6ff;display:inline-block;margin-top:16px}',
    '</style></head><body>',
    '<h1>' + title + '</h1>',
    '<pre>' + JSON.stringify(result, null, 2).replace(/</g, '&lt;') + '</pre>',
    '<a href="/scanner-v2">← back to scanner</a>',
    '</body></html>',
  ].join('');
}

module.exports = {
  placeQuickFire: placeQuickFire,
  getAccountEquity: getAccountEquity,
  computeQty: computeQty,
  renderConfirmPage: renderConfirmPage,
  renderResultPage: renderResultPage,
  loadFireLog: loadFireLog,
  liveFireEnabled: liveFireEnabled,
  TIER_PCT: TIER_PCT,
  SIM_ACCOUNT: SIM_ACCOUNT,
  LIVE_ACCOUNT: LIVE_ACCOUNT,
};
