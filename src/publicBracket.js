// =============================================================================
// PUBLIC SYNTHETIC BRACKET (May 1 2026 — v6 PM)
//
// Public.com's API has no native bracket / OCO orders. This module synthesizes
// one by:
//   1. Placing the entry LIMIT BUY (already done by caller)
//   2. Polling status every 3s until FILLED
//   3. On fill, auto-placing 3 child orders:
//        SELL qty/2 @ tp1  LIMIT     (TP1 leg)
//        SELL qty/2 @ tp2  LIMIT     (TP2 leg, if qty >= 2)
//        SELL qty   @ stop STOP_LIMIT (Stop leg)
//   4. Tracking child orderIds in /data/public_brackets.json
//   5. If TP1 fills, optionally cancels Stop and re-places at break-even (trail)
//
// AB: cash account, no PDT, $500 cap. Brackets give him the same workflow
// as TS Titan even though Public's API is order-list-only.
//
// Public API: POST /{accountId}/order, GET /{accountId}/order/{id}, DELETE /{accountId}/order/{id}
// =============================================================================

var fs = require('fs');
var path = require('path');
var publicBroker = require('./public');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var BRACKETS_FILE = path.join(DATA_ROOT, 'public_brackets.json');

// Poll interval + timeout
var POLL_INTERVAL_MS = parseInt(process.env.PUBLIC_BRACKET_POLL_MS || '3000');   // 3s
var POLL_TIMEOUT_MS  = parseInt(process.env.PUBLIC_BRACKET_TIMEOUT_MS || (15 * 60 * 1000));   // 15 min

// In-memory active brackets — keyed by entry orderId
var ACTIVE = {};

function loadState() {
  try {
    if (!fs.existsSync(BRACKETS_FILE)) return {};
    return JSON.parse(fs.readFileSync(BRACKETS_FILE, 'utf8'));
  } catch (e) {
    console.error('[BRACKET] state load failed:', e.message);
    return {};
  }
}
function saveState(state) {
  try {
    var tmp = BRACKETS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, BRACKETS_FILE);
  } catch (e) { console.error('[BRACKET] state save failed:', e.message); }
}

// =============================================================================
// MAIN: place a synthetic bracket
// =============================================================================
//
// opts:
//   symbol         (option OPRA or equity ticker — required)
//   quantity       (integer total contracts, defaults 2)
//   entryPrice     (LIMIT BUY price, required)
//   stopPrice      (STOP_LIMIT trigger, required)
//   tp1Price       (LIMIT SELL for first half, required)
//   tp2Price       (LIMIT SELL for runner half, optional — uses tp1Price if absent)
//   stopLimitOffset(default $0.05 below stop trigger for the limit price)
//   instrumentType ('OPTION' or 'EQUITY' — auto-detected if omitted)
//
async function placeBracket(opts) {
  if (!opts || !opts.symbol)     throw new Error('placeBracket: symbol required');
  if (!opts.entryPrice)          throw new Error('placeBracket: entryPrice required');
  if (!opts.stopPrice)           throw new Error('placeBracket: stopPrice required');
  if (!opts.tp1Price)            throw new Error('placeBracket: tp1Price required');

  // May 5 2026 — flat-percent-stop guard. AB rule from feedback_stop_management.md:
  // NEVER flat % stops alone. Structural stop = PRIMARY. ABBV stop-out today
  // ($153 loss) was caused by a flat -25% premium stop fired during opening-5m
  // volatility. This guard rejects brackets where stopPrice is a naive
  // -25% / -30% premium stop unless caller explicitly attests with
  // structuralStopOnUnderlying or acceptsFlatStop=true (acknowledging the risk).
  var entryP = parseFloat(opts.entryPrice);
  var stopP  = parseFloat(opts.stopPrice);
  if (isFinite(entryP) && isFinite(stopP) && entryP > 0) {
    var stopPctBelow = ((entryP - stopP) / entryP) * 100;
    var isLikelyFlatPct = stopPctBelow >= 20 && stopPctBelow <= 35;  // -20% to -35% = flat-% pattern
    var hasStructural = !!opts.structuralStopUnderlying;
    var explicitOverride = opts.acceptsFlatStop === true;
    if (isLikelyFlatPct && !hasStructural && !explicitOverride) {
      return {
        ok: false,
        stage: 'pre-entry-validation',
        error: 'flat-percent-stop-rejected',
        details: 'Stop ' + stopPctBelow.toFixed(1) + '% below entry looks like a flat-% stop. AB rule: NEVER flat % alone — structural stock-level stop is PRIMARY. Either: (1) pass structuralStopUnderlying:{ticker,price,predicate} to attest the structural level, OR (2) pass acceptsFlatStop:true to override after explicit risk acknowledgment.',
        guidance: 'Pull 5m chart, identify the lowest swing/base low + buffer, use UNDERLYING price as structural stop. Use option premium stop ONLY at -50% as tail-risk catch.',
      };
    }
  }

  var qty = parseInt(opts.quantity || 2);
  if (qty < 1) qty = 1;

  var symbol = String(opts.symbol).replace(/\s+/g, '');
  var isOption = !!opts.instrumentType
    ? opts.instrumentType.toUpperCase() === 'OPTION'
    : /\d{6}[CP]\d+/.test(symbol);

  // Step 1: fire the entry order
  var entry = await publicBroker.placeOrder({
    symbol: symbol,
    side: 'BUY',
    quantity: qty,
    orderType: 'LIMIT',
    limitPrice: opts.entryPrice,
    timeInForce: opts.timeInForce || 'DAY',
    instrumentType: isOption ? 'OPTION' : 'EQUITY',
    openCloseIndicator: 'OPEN',
  });
  if (!entry || !entry.ok || !entry.orderId) {
    return { ok: false, stage: 'entry', error: entry && entry.error };
  }
  var entryOrderId = entry.orderId;

  // Persist bracket state
  var bracket = {
    id: entryOrderId,
    createdAt: new Date().toISOString(),
    status: 'AWAITING_FILL',
    symbol: symbol,
    qty: qty,
    isOption: isOption,
    entry: { orderId: entryOrderId, price: opts.entryPrice, status: 'WORKING' },
    stop: { price: opts.stopPrice, limitPrice: opts.stopPrice - (opts.stopLimitOffset || 0.05) },
    tp1: { price: opts.tp1Price, qty: Math.max(1, Math.floor(qty / 2)) },
    tp2: { price: opts.tp2Price || opts.tp1Price, qty: qty - Math.max(1, Math.floor(qty / 2)) },
    childOrderIds: {},
    log: [],
  };
  ACTIVE[entryOrderId] = bracket;
  var state = loadState();
  state[entryOrderId] = bracket;
  saveState(state);

  // Step 2: kick off polling-and-fill handler in background. The HTTP caller
  // doesn't wait for fill — the bracket continues server-side.
  setImmediate(function() { _watchBracket(entryOrderId).catch(function(e) {
    console.error('[BRACKET] watcher error for', entryOrderId, e.message);
  }); });

  return {
    ok: true,
    bracketId: entryOrderId,
    entryOrderId: entryOrderId,
    status: 'AWAITING_FILL',
    bracket: bracket,
  };
}

// Background watcher: polls entry until FILLED, then places child legs
async function _watchBracket(bracketId) {
  var bracket = ACTIVE[bracketId];
  if (!bracket) return;
  var startedAt = Date.now();

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise(function(r) { setTimeout(r, POLL_INTERVAL_MS); });
    var status;
    try { status = await publicBroker.getOrder(bracket.entry.orderId); }
    catch (e) {
      _log(bracket, 'poll-error: ' + e.message);
      continue;
    }
    var s = (status && status.status) || '';
    bracket.entry.status = s;
    bracket.entry.last = status;
    _persist(bracket);
    if (s === 'FILLED') break;
    if (s === 'CANCELLED' || s === 'REJECTED' || s === 'EXPIRED') {
      bracket.status = 'ENTRY_' + s;
      _log(bracket, 'entry resolved without fill: ' + s);
      _persist(bracket);
      return;
    }
  }

  if (bracket.entry.status !== 'FILLED') {
    bracket.status = 'TIMEOUT';
    _log(bracket, 'timeout waiting for fill');
    _persist(bracket);
    return;
  }

  // Place children: tp1, tp2, stop
  await _placeChildren(bracket);
}

async function _placeChildren(bracket) {
  bracket.status = 'CHILDREN_WORKING';
  _log(bracket, 'entry filled, placing 3 child orders');

  // TP1
  var tp1Res = await publicBroker.placeOrder({
    symbol: bracket.symbol,
    side: 'SELL',
    quantity: bracket.tp1.qty,
    orderType: 'LIMIT',
    limitPrice: bracket.tp1.price,
    timeInForce: 'DAY',
    instrumentType: bracket.isOption ? 'OPTION' : 'EQUITY',
    openCloseIndicator: 'CLOSE',
  });
  bracket.childOrderIds.tp1 = (tp1Res && tp1Res.orderId) || null;
  bracket.tp1.placed = !!tp1Res.ok;
  bracket.tp1.error = tp1Res.error;

  // TP2 (only if qty > 1)
  if (bracket.tp2.qty > 0) {
    var tp2Res = await publicBroker.placeOrder({
      symbol: bracket.symbol,
      side: 'SELL',
      quantity: bracket.tp2.qty,
      orderType: 'LIMIT',
      limitPrice: bracket.tp2.price,
      timeInForce: 'DAY',
      instrumentType: bracket.isOption ? 'OPTION' : 'EQUITY',
      openCloseIndicator: 'CLOSE',
    });
    bracket.childOrderIds.tp2 = (tp2Res && tp2Res.orderId) || null;
    bracket.tp2.placed = !!tp2Res.ok;
    bracket.tp2.error = tp2Res.error;
  }

  // Stop (covers full qty)
  var stopRes = await publicBroker.placeOrder({
    symbol: bracket.symbol,
    side: 'SELL',
    quantity: bracket.qty,
    orderType: 'STOP_LIMIT',
    stopPrice: bracket.stop.price,
    limitPrice: bracket.stop.limitPrice,
    timeInForce: 'DAY',
    instrumentType: bracket.isOption ? 'OPTION' : 'EQUITY',
    openCloseIndicator: 'CLOSE',
  });
  bracket.childOrderIds.stop = (stopRes && stopRes.orderId) || null;
  bracket.stop.placed = !!stopRes.ok;
  bracket.stop.error = stopRes.error;

  bracket.status = 'CHILDREN_PLACED';
  _log(bracket, 'children placed: tp1=' + (bracket.tp1.placed ? '✓' : '✗') +
                ' tp2=' + (bracket.tp2.placed ? '✓' : '✗') +
                ' stop=' + (bracket.stop.placed ? '✓' : '✗'));
  _persist(bracket);

  // Background OCO watcher: if any leg fills, cancel the others
  setImmediate(function() { _watchOCO(bracket.id).catch(function(e) {
    console.error('[BRACKET] OCO watcher error', e.message);
  }); });
}

async function _watchOCO(bracketId) {
  var bracket = ACTIVE[bracketId];
  if (!bracket) return;
  var startedAt = Date.now();
  // Poll every 3s for up to 6.5 hrs (full RTH)
  var deadline = startedAt + 6.5 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(function(r) { setTimeout(r, POLL_INTERVAL_MS); });
    var anyFilled = false;
    var firstFilled = null;
    for (var legName of ['tp1', 'tp2', 'stop']) {
      var oid = bracket.childOrderIds[legName];
      if (!oid) continue;
      try {
        var s = await publicBroker.getOrder(oid);
        bracket[legName].lastStatus = s && s.status;
        if (s && s.status === 'FILLED' && !bracket[legName].filled) {
          bracket[legName].filled = true;
          firstFilled = legName;
          anyFilled = true;
        }
      } catch (e) { /* swallow, retry next tick */ }
    }
    if (anyFilled) {
      _log(bracket, firstFilled + ' filled — cancelling other legs (synthetic OCO)');
      for (var n of ['tp1', 'tp2', 'stop']) {
        if (n === firstFilled) continue;
        var oid = bracket.childOrderIds[n];
        if (!oid) continue;
        try { await publicBroker.cancelOrder(oid); }
        catch (e) { _log(bracket, 'cancel ' + n + ' err: ' + e.message); }
      }
      bracket.status = 'COMPLETE';
      _persist(bracket);
      return;
    }
  }
  bracket.status = 'OCO_TIMEOUT';
  _persist(bracket);
}

function _log(bracket, msg) {
  bracket.log = bracket.log || [];
  bracket.log.push('[' + new Date().toISOString() + '] ' + msg);
  if (bracket.log.length > 50) bracket.log.shift();
}
function _persist(bracket) {
  var state = loadState();
  state[bracket.id] = bracket;
  saveState(state);
}

function listBrackets() {
  var state = loadState();
  return Object.keys(state).map(function(k) { return state[k]; });
}
function getBracket(id) {
  var state = loadState();
  return state[id] || null;
}
async function cancelBracket(id) {
  var b = getBracket(id);
  if (!b) return { error: 'bracket not found' };
  var canceled = [];
  // Cancel entry if still working
  if (b.entry && b.entry.orderId && b.entry.status !== 'FILLED' && b.entry.status !== 'CANCELLED') {
    try { await publicBroker.cancelOrder(b.entry.orderId); canceled.push('entry'); } catch(e) {}
  }
  // Cancel any child legs
  for (var n of ['tp1', 'tp2', 'stop']) {
    var oid = b.childOrderIds && b.childOrderIds[n];
    if (oid) {
      try { await publicBroker.cancelOrder(oid); canceled.push(n); } catch(e) {}
    }
  }
  b.status = 'CANCELLED_BY_USER';
  _persist(b);
  return { ok: true, canceled: canceled };
}

module.exports = {
  placeBracket: placeBracket,
  listBrackets: listBrackets,
  getBracket: getBracket,
  cancelBracket: cancelBracket,
};
