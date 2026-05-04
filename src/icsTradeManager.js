// =============================================================================
// ICS TRADE MANAGER — active position management. STRUCTURAL-STOPS PRIMARY.
//
// CRITICAL CORRECTION (May 4 2026, after AB called out the bug):
//   Earlier draft used flat -25% premium stops. AB's memory documents this
//   exact failure — "feedback_stop_management.md": flat-% stops triggered by
//   noise, every April 8-10 loss came from flat stops or panic-cutting on
//   normal pullbacks. Structural stops at the underlying-stock invalidation
//   level are the only stops that survive intraday noise.
//
// CORRECT HIERARCHY:
//
//   STAGE -1 (PRIMARY, runs every cron tick) — STRUCTURAL STOP
//     Pull live stock price for setup.ticker.
//     LONG: if stock_price <= structuralStopPrice → exit ALL contracts.
//     SHORT: if stock_price >= structuralStopPrice → exit ALL contracts.
//     This is the ONLY stop that should fire before TP1.
//
//   STAGE 1 BE (after TP1 fills) — premium-based runner management
//     1ct exited at +50% premium. Move remaining stop to entry premium.
//     Rationale: BE on premium ≈ BE on stock if delta is stable. Acceptable
//     RISK only because runner is now 1ct max, half the original capital.
//
//   STAGE 2 LOCK25 (HW reaches +75% premium)
//     Trail stop to +25% premium. Locks 25% gains on runner.
//
//   STAGE 3 TP2 NOTIFY (HW reaches +100% premium)
//     Trim 2nd ct, runner stop to +50% premium.
//
// THE KEY DIFFERENCE FROM v1:
//   - STAGE -1 STRUCTURAL is the PRIMARY exit
//   - The premium stages only run AFTER TP1 has already filled
//   - Before TP1, the original -25% bracket from simAutoTrader is the
//     SECONDARY ceiling (so if structural stop somehow doesn't fire, premium
//     loss is still capped). But structural is the real exit.
//
// STATE: /data/ics_position_state.json
// SAFETY: SIM only. Operates on SIM3142118M account exclusively.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}
var orderExecutor = null;
try { orderExecutor = require('./orderExecutor'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'ics_position_state.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var SIM_ACCOUNT = 'SIM3142118M';

// Stage thresholds (% from entry)
var STAGE_BE_TRIGGER = 50;     // After +50% TP1 hits → move to breakeven (current entry)
var STAGE_LOCK25_TRIGGER = 75; // After +75% → move stop to +25%
var STAGE_TP2_TRIGGER = 100;   // After +100% TP2 hits → trim, stop to +50%
var STAGE_RUNNER_STOP = 50;    // Final runner stop pct

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[ICS-MGR] state save failed:', e.message); }
}

// Pull SIM positions from TS sim-api
async function getSimPositions(token) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://sim-api.tradestation.com/v3/brokerage/accounts/' + SIM_ACCOUNT + '/positions';
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    if (!r.ok) return null;
    var data = await r.json();
    return (data && data.Positions) || [];
  } catch (e) { console.error('[ICS-MGR] positions fetch error:', e.message); return null; }
}

// Pull SIM open orders for a symbol so we can cancel stale stops/TPs
async function getSimOpenOrders(token, symbol) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://sim-api.tradestation.com/v3/brokerage/accounts/' + SIM_ACCOUNT + '/orders';
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    if (!r.ok) return [];
    var data = await r.json();
    var orders = (data && data.Orders) || [];
    return orders.filter(function(o) {
      var openStatuses = ['REC', 'SUS', 'OPN', 'EXP', 'OUR', 'DON', 'OAR', 'BRO', 'CHN', 'CAN', 'SED', 'UCH', 'SBL'];
      // Use OPEN-style states only (rec=received, sus=sent_to_exchange, opn=open, etc.)
      var isOpen = ['REC', 'SUS', 'OPN', 'OAR'].indexOf(o.Status) >= 0;
      var matches = !symbol || (o.Legs && o.Legs.some(function(l) { return l.Symbol === symbol; }));
      return isOpen && matches;
    });
  } catch (e) { console.error('[ICS-MGR] orders fetch error:', e.message); return []; }
}

// Cancel an order via TS sim-api
async function cancelOrder(token, orderID) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://sim-api.tradestation.com/v3/orderexecution/orders/' + encodeURIComponent(orderID);
    var r = await fetchLib(url, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
    return r.ok;
  } catch (e) { console.error('[ICS-MGR] cancel error:', e.message); return false; }
}

// Place a new stop-limit order on the SIM account (for the post-TP1 stop adjustment)
async function placeBreakevenStop(token, contractSymbol, size, stopTrigger, stopLimit) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://sim-api.tradestation.com/v3/orderexecution/orders';
    var body = {
      AccountID: SIM_ACCOUNT,
      Symbol: contractSymbol,
      Quantity: String(size),
      OrderType: 'StopLimit',
      LimitPrice: stopLimit.toFixed(2),
      StopPrice: stopTrigger.toFixed(2),
      TradeAction: 'SELLTOCLOSE',
      TimeInForce: { Duration: 'GTC' },
      Route: 'Intelligent',
    };
    var r = await fetchLib(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    if (!r.ok) {
      var t = '';
      try { t = await r.text(); } catch (e) {}
      return { ok: false, error: 'HTTP ' + r.status + ' ' + t.slice(0, 200) };
    }
    return { ok: true, body: await r.json().catch(function() { return null; }) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Pull current option mid via /api/quote-or-bars or direct TS quote
async function getCurrentPremium(token, contractSymbol) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(contractSymbol);
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 6000 });
    if (!r.ok) return null;
    var data = await r.json();
    var q = (data.Quotes || data.quotes || [])[0];
    if (!q) return null;
    var bid = parseFloat(q.Bid || 0);
    var ask = parseFloat(q.Ask || 0);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return parseFloat(q.Last || 0) || null;
  } catch (e) { return null; }
}

// Pull current STOCK price for structural stop check
async function getStockPrice(token, ticker) {
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(ticker);
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 6000 });
    if (!r.ok) return null;
    var data = await r.json();
    var q = (data.Quotes || data.quotes || [])[0];
    if (!q) return null;
    return parseFloat(q.Last || q.Close || 0) || null;
  } catch (e) { return null; }
}

// MARKET-CLOSE the entire option position — used by structural stop trigger and time stop.
// Cancels all open orders for the symbol, then places SELL TO CLOSE market for full qty.
async function marketCloseAll(token, contractSymbol, qty, reason) {
  console.log('[ICS-MGR] MARKET CLOSE ' + contractSymbol + ' qty ' + qty + ' reason: ' + reason);
  // Cancel any open stops/TPs first
  var openOrders = await getSimOpenOrders(token, contractSymbol);
  for (var i = 0; i < openOrders.length; i++) {
    await cancelOrder(token, openOrders[i].OrderID);
  }

  // Place market sell-to-close
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://sim-api.tradestation.com/v3/orderexecution/orders';
    var body = {
      AccountID: SIM_ACCOUNT,
      Symbol: contractSymbol,
      Quantity: String(qty),
      OrderType: 'Market',
      TradeAction: 'SELLTOCLOSE',
      TimeInForce: { Duration: 'DAY' },
      Route: 'Intelligent',
    };
    var r = await fetchLib(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function pushDiscord(title, description, fields) {
  var dp = require('./discordPush');
  var embed = {
    username: 'Flow Scout — ICS Trade Manager',
    embeds: [{
      title: title,
      description: description,
      color: 5763719,
      fields: fields || [],
      footer: { text: 'Flow Scout | ICS Trade Manager | active position adjustment' },
      timestamp: new Date().toISOString(),
    }],
  };
  return await dp.send('icsTradeManager', embed, { webhook: DISCORD_WEBHOOK });
}

// MAIN — runs every 2 min during RTH
async function runManager() {
  if (!ts || !ts.getAccessToken) return { ok: false, error: 'no tradestation module' };
  var token;
  try { token = await ts.getAccessToken(); } catch (e) { return { ok: false, error: 'token error' }; }
  if (!token) return { ok: false, error: 'no token' };

  var positions = await getSimPositions(token);
  if (positions === null) return { ok: false, error: 'positions API error' };

  var state = loadState();
  var actions = [];

  // Track each option position
  for (var i = 0; i < positions.length; i++) {
    var p = positions[i];
    var symbol = p.Symbol;
    if (!symbol || !/\d{6}[CP]\d+/.test(symbol)) continue;  // option positions only

    var qty = parseInt(p.Quantity, 10);
    if (!qty || qty <= 0) continue;
    var avgPrice = parseFloat(p.AveragePrice || p.AvgPrice || 0);
    if (!avgPrice) continue;

    // Initialize state for new positions
    if (!state[symbol]) {
      state[symbol] = {
        contractSymbol: symbol,
        entry: avgPrice,
        originalSize: qty,
        currentSize: qty,
        highWaterPremium: avgPrice,
        stage: 'STAGE_0',           // STAGE_0 = parent fill, original -25% stop in place
        openedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      saveState(state);
      continue;
    }

    var st = state[symbol];
    st.lastSeen = new Date().toISOString();

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE -1 — STRUCTURAL STOCK STOP (PRIMARY)
    // Per AB's feedback_stop_management.md: NEVER flat % stops. Stop at the
    // underlying-stock invalidation level. This block runs FIRST every cron.
    // ─────────────────────────────────────────────────────────────────────────
    if (st.ticker && st.structuralStopPrice && st.direction) {
      var stockPrice = await getStockPrice(token, st.ticker);
      if (stockPrice) {
        st.lastStockPrice = stockPrice;
        var structuralBroken = (st.direction === 'long' && stockPrice <= st.structuralStopPrice) ||
                                (st.direction === 'short' && stockPrice >= st.structuralStopPrice);
        if (structuralBroken && st.stage !== 'EXITED_STRUCTURAL') {
          console.log('[ICS-MGR] STRUCTURAL STOP HIT for ' + symbol + ': ' +
                      st.ticker + ' at $' + stockPrice + ' broke $' + st.structuralStopPrice);
          var closeResult = await marketCloseAll(token, symbol, qty,
            'STRUCTURAL: ' + st.ticker + ' $' + stockPrice + ' broke invalidation $' + st.structuralStopPrice);
          st.stage = 'EXITED_STRUCTURAL';
          st.exitedAt = new Date().toISOString();
          st.exitReason = 'structural-stop';
          actions.push({
            symbol: symbol,
            action: 'STRUCTURAL_STOP_EXIT',
            qty: qty,
            ticker: st.ticker,
            stockPrice: stockPrice,
            structuralStopPrice: st.structuralStopPrice,
            closeResult: closeResult,
          });
          await pushDiscord(
            '🛑 STRUCTURAL STOP — ' + st.ticker + ' broke invalidation',
            'Stock at $' + stockPrice.toFixed(2) + ' breached structural stop $' + st.structuralStopPrice.toFixed(2) + ' (' + st.direction.toUpperCase() + '). Closing all ' + qty + 'ct of ' + symbol + ' at market.',
            [
              { name: '📊 Why', value: 'AB rule: structural stops fire on stock-level invalidation, not premium-% noise. The trade thesis is broken when stock breaks ' + (st.direction === 'long' ? 'below' : 'above') + ' the entry trigger / stop level.', inline: false },
              { name: '🎯 Position', value: 'Entry trigger: $' + (st.triggerPrice ? st.triggerPrice.toFixed(2) : '?') + '\nStructural stop: $' + st.structuralStopPrice.toFixed(2) + '\nCurrent stock: $' + stockPrice.toFixed(2) + '\nOption qty closed: ' + qty + 'ct', inline: false },
            ]
          );
          saveState(state);
          continue;  // skip the rest of the stages for this position
        }
      }
    }

    var currentMid = await getCurrentPremium(token, symbol);
    if (currentMid && currentMid > st.highWaterPremium) {
      st.highWaterPremium = currentMid;
    }

    var pctFromEntry = currentMid ? ((currentMid - st.entry) / st.entry) * 100 : 0;
    var hwPctFromEntry = ((st.highWaterPremium - st.entry) / st.entry) * 100;

    // STAGE 1: TP1 fill detected (size dropped from original)
    if (st.currentSize > 0 && qty < st.currentSize && st.stage === 'STAGE_0') {
      // 1+ contracts exited via TP1. Cancel old stop, place breakeven stop.
      console.log('[ICS-MGR] TP1 fill detected on ' + symbol + ': ' + st.currentSize + ' → ' + qty);
      var openOrders = await getSimOpenOrders(token, symbol);
      var staleStops = openOrders.filter(function(o) {
        return o.OrderType === 'StopLimit' || o.OrderType === 'Stop' || o.OrderType === 'StopMarket';
      });
      for (var so = 0; so < staleStops.length; so++) {
        await cancelOrder(token, staleStops[so].OrderID);
      }

      // Place new BE stop
      var beStopTrigger = Math.round(st.entry * 100) / 100;
      var beStopLimit = Math.round((st.entry - 0.05) * 100) / 100;
      var beResult = await placeBreakevenStop(token, symbol, qty, beStopTrigger, beStopLimit);

      st.stage = 'STAGE_1_BE';
      st.currentSize = qty;
      st.tp1FilledAt = new Date().toISOString();
      st.beStopPrice = beStopTrigger;

      actions.push({
        symbol: symbol,
        action: 'TP1_FILL_BREAKEVEN_STOP',
        qty: qty,
        entry: st.entry,
        beStopTrigger: beStopTrigger,
        beResult: beResult,
      });

      await pushDiscord(
        '✂️ TP1 HIT — Stop moved to BREAKEVEN — ' + symbol,
        '1ct exited at TP1 (+50%). Remaining ' + qty + 'ct now riskless.',
        [
          { name: '📊 Position', value: 'Entry: $' + st.entry.toFixed(2) + ' · Current: $' + (currentMid || 0).toFixed(2) + ' (' + pctFromEntry.toFixed(0) + '%)\nRemaining: ' + qty + 'ct · BE stop: $' + beStopTrigger.toFixed(2), inline: false },
          { name: '🎯 Next', value: 'Trail stop to +25% if premium hits +75% of entry.\nTP2 trim at +100%, runner stop at +50%.', inline: false },
        ]
      );

      saveState(state);
      continue;
    }

    // STAGE 2: high-water reached +75% → move stop to +25%
    if (st.stage === 'STAGE_1_BE' && hwPctFromEntry >= STAGE_LOCK25_TRIGGER) {
      console.log('[ICS-MGR] +75% HW on ' + symbol + ' → tightening stop to +25%');
      var openOrders2 = await getSimOpenOrders(token, symbol);
      var staleStops2 = openOrders2.filter(function(o) {
        return (o.OrderType === 'StopLimit' || o.OrderType === 'Stop') && (o.OrderType !== 'Limit');
      });
      for (var so2 = 0; so2 < staleStops2.length; so2++) {
        await cancelOrder(token, staleStops2[so2].OrderID);
      }

      var lockTrigger = Math.round(st.entry * 1.25 * 100) / 100;
      var lockLimit = Math.round((st.entry * 1.25 - 0.05) * 100) / 100;
      var lockResult = await placeBreakevenStop(token, symbol, qty, lockTrigger, lockLimit);

      st.stage = 'STAGE_2_LOCK25';
      st.lockedStopPrice = lockTrigger;

      actions.push({
        symbol: symbol,
        action: 'LOCK_25_STOP',
        qty: qty,
        lockTrigger: lockTrigger,
        lockResult: lockResult,
      });

      await pushDiscord(
        '🔒 LOCKED 25% — Stop moved to +25% — ' + symbol,
        'High-water hit +' + hwPctFromEntry.toFixed(0) + '%. Tightening stop locks +25% gains on the runner.',
        [
          { name: '📊 Position', value: 'Entry: $' + st.entry.toFixed(2) + ' · HW: $' + st.highWaterPremium.toFixed(2) + ' (+' + hwPctFromEntry.toFixed(0) + '%)\nLocked stop: $' + lockTrigger.toFixed(2) + ' (+25%)', inline: false },
        ]
      );

      saveState(state);
      continue;
    }

    // STAGE 3: TP2 hit (+100%) — auto-trim 1ct at LIMIT, runner stop to +50%
    if (['STAGE_1_BE', 'STAGE_2_LOCK25'].indexOf(st.stage) >= 0 && hwPctFromEntry >= STAGE_TP2_TRIGGER && qty >= 1) {
      console.log('[ICS-MGR] +100% HW on ' + symbol + ' → AUTO-TRIM 1ct + runner stop +50%');

      var tp2Limit = Math.round(st.entry * (1 + STAGE_TP2_TRIGGER / 100) * 100) / 100;  // +100%
      var runnerStopTrigger = Math.round(st.entry * (1 + STAGE_RUNNER_STOP / 100) * 100) / 100;  // +50%
      var runnerStopLimit = Math.round((st.entry * (1 + STAGE_RUNNER_STOP / 100) - 0.05) * 100) / 100;
      var trimQty = Math.min(1, qty);  // trim 1ct (or all if only 1 left)
      var keepQty = qty - trimQty;

      // 1) Place a LIMIT sell to trim 1ct at +100%
      var trimRes;
      try {
        var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
        var trimUrl = 'https://sim-api.tradestation.com/v3/orderexecution/orders';
        var trimBody = {
          AccountID: SIM_ACCOUNT,
          Symbol: symbol,
          Quantity: String(trimQty),
          OrderType: 'Limit',
          LimitPrice: tp2Limit.toFixed(2),
          TradeAction: 'SELLTOCLOSE',
          TimeInForce: { Duration: 'GTC' },
          Route: 'Intelligent',
        };
        var tr = await fetchLib(trimUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(trimBody),
          timeout: 8000,
        });
        trimRes = { ok: tr.ok, status: tr.status };
      } catch (e) { trimRes = { ok: false, error: e.message }; }

      // 2) Cancel old stop, place runner stop at +50% on the keepQty
      if (keepQty > 0) {
        var openOrders3 = await getSimOpenOrders(token, symbol);
        var staleStops3 = openOrders3.filter(function(o) {
          return o.OrderType === 'StopLimit' || o.OrderType === 'Stop';
        });
        for (var so3 = 0; so3 < staleStops3.length; so3++) {
          await cancelOrder(token, staleStops3[so3].OrderID);
        }
        await placeBreakevenStop(token, symbol, keepQty, runnerStopTrigger, runnerStopLimit);
      }

      st.stage = 'STAGE_3_TP2_TRIM';
      st.tp2TrimAt = new Date().toISOString();
      st.tp2LimitPrice = tp2Limit;
      st.runnerStopPrice = runnerStopTrigger;

      actions.push({
        symbol: symbol,
        action: 'TP2_AUTO_TRIM_RUNNER_STOP',
        trimQty: trimQty,
        tp2Limit: tp2Limit,
        runnerStopTrigger: runnerStopTrigger,
        keepQty: keepQty,
        trimResult: trimRes,
      });

      await pushDiscord(
        '🎯 TP2 +100% AUTO-TRIM — ' + symbol,
        'Premium HW +' + hwPctFromEntry.toFixed(0) + '%. Auto-placed: 1ct LIMIT sell @ $' + tp2Limit + ', runner stop $' + runnerStopTrigger + ' (+50%).',
        [
          { name: '📊 Position', value: 'Entry: $' + st.entry.toFixed(2) + ' · HW: $' + st.highWaterPremium.toFixed(2) + '\nTrim 1ct @ $' + tp2Limit + ' GTC\nRunner ' + keepQty + 'ct, stop $' + runnerStopTrigger + ' (+50%)', inline: false },
        ]
      );
      saveState(state);
      continue;
    }

    // STAGE 4: 2 PM next-day TIME STOP — exit if not in profit by 2 PM next trading day
    if (st.openedAt && (st.stage === 'STAGE_0' || !st.stage)) {
      var openedDate = new Date(st.openedAt);
      var nowDate = new Date();
      var daysSinceOpen = (nowDate - openedDate) / (1000 * 60 * 60 * 24);
      var etHr = parseInt(nowDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
      // Time stop fires only on day 2+ after 2 PM ET, and only if currently NOT in profit (TP1 hasn't filled = STAGE_0)
      if (daysSinceOpen >= 1 && etHr >= 14 && pctFromEntry <= 0) {
        console.log('[ICS-MGR] 2 PM TIME STOP for ' + symbol + ' (day ' + daysSinceOpen.toFixed(1) + ', not in profit)');
        var closeRes = await marketCloseAll(token, symbol, qty, '2 PM time stop, day ' + daysSinceOpen.toFixed(1) + ' not in profit');
        st.stage = 'EXITED_TIMESTOP';
        st.exitedAt = new Date().toISOString();
        st.exitReason = 'time-stop-2pm';
        actions.push({
          symbol: symbol,
          action: '2PM_TIME_STOP_EXIT',
          qty: qty,
          daysSinceOpen: daysSinceOpen.toFixed(1),
          closeResult: closeRes,
        });
        await pushDiscord(
          '⏰ 2 PM TIME STOP — ' + symbol,
          'Day ' + daysSinceOpen.toFixed(1) + ' since open, not in profit. Exiting per ICS spec.',
          [
            { name: '📊 Position', value: 'Entry: $' + st.entry.toFixed(2) + ' · Current: $' + (currentMid || 0).toFixed(2) + ' (' + pctFromEntry.toFixed(0) + '%)\nQty closed: ' + qty + 'ct', inline: false },
          ]
        );
        saveState(state);
        continue;
      }
    }
  }

  // Cleanup: remove state entries for closed positions
  var seenSymbols = positions.map(function(p) { return p.Symbol; }).filter(Boolean);
  Object.keys(state).forEach(function(sym) {
    if (seenSymbols.indexOf(sym) === -1) {
      console.log('[ICS-MGR] position closed: ' + sym + ' (cleaning state)');
      delete state[sym];
    }
  });
  saveState(state);

  return { ok: true, positionsTracked: positions.length, actionsTaken: actions.length, actions: actions };
}

function getStatus() {
  var state = loadState();
  return {
    timestamp: new Date().toISOString(),
    trackedPositions: Object.keys(state).length,
    positions: Object.keys(state).map(function(sym) {
      var s = state[sym];
      return {
        symbol: sym,
        entry: s.entry,
        currentSize: s.currentSize,
        highWaterPremium: s.highWaterPremium,
        stage: s.stage,
        openedAt: s.openedAt,
        beStopPrice: s.beStopPrice,
        lockedStopPrice: s.lockedStopPrice,
      };
    }),
  };
}

module.exports = {
  runManager: runManager,
  getStatus: getStatus,
};
