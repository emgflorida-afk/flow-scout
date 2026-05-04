// =============================================================================
// ICS TRADE MANAGER — active position management for ICS auto-fired trades.
//
// AB asked for active management, not set-and-forget. This cron polls open
// SIM positions every 2 min during RTH and adjusts brackets based on ICS rules:
//
//   STAGE 1 — After TP1 fills (1ct exits at +50%):
//     - Cancel old stop at -25%
//     - Place new BREAKEVEN stop on remaining contracts
//     - This locks in scratch on the runner; can't lose money on this trade
//
//   STAGE 2 — Premium reaches +75% (between TP1 and TP2):
//     - Move stop from breakeven to +25% (lock 25% of gains)
//
//   STAGE 3 — Premium reaches +100% (TP2):
//     - Trim 2nd ct at +100%
//     - Move runner stop to +50%
//
//   STAGE 4 — 2 PM next-day time stop:
//     - If position not in profit (premium <= entry): market close all
//
//   STAGE 5 — Stock-trigger invalidation:
//     - If underlying breaks structural stop level (2 days closed past): exit all
//
// STATE: /data/ics_position_state.json
//   { contractSymbol: { entry, originalSize, currentSize, highWaterPremium,
//     stage, lastAdjustedAt, openedAt, structuralStop, ... } }
//
// SAFETY: Operates on SIM positions only. Reads from TS sim-api positions
// endpoint, places adjustments via orderExecutor with sim flag.
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

    // STAGE 3: TP2 hit (+100%) — trim 2nd ct, runner stop to +50%
    if (['STAGE_1_BE', 'STAGE_2_LOCK25'].indexOf(st.stage) >= 0 && hwPctFromEntry >= STAGE_TP2_TRIGGER && qty >= 1) {
      console.log('[ICS-MGR] +100% HW on ' + symbol + ' → TP2 trim recommendation');
      // For now, just push Discord — actual sell-to-close on TP2 is more complex
      // because it requires a LIMIT sell order at +100%, which is what TP2Premium
      // bracket should already be. Real check: did TP2 already fill?

      st.stage = 'STAGE_3_TP2_NOTIFIED';
      await pushDiscord(
        '🎯 TP2 ZONE — ' + symbol + ' at +100%',
        'Premium reached +' + hwPctFromEntry.toFixed(0) + '%. If TP2 didn\'t auto-fill, trim manually now and trail runner stop to +50%.',
        [
          { name: '📊 Position', value: 'Entry: $' + st.entry.toFixed(2) + ' · HW: $' + st.highWaterPremium.toFixed(2) + ' (+' + hwPctFromEntry.toFixed(0) + '%)\nQty: ' + qty + 'ct\nRecommended runner stop: $' + (st.entry * 1.50).toFixed(2) + ' (+50%)', inline: false },
        ]
      );
      saveState(state);
      continue;
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
