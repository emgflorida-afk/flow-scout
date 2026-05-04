// =============================================================================
// POSITION MONITOR — watches AB's open LMT orders, alerts on stale fills
//
// SOLVES TODAY'S FAILURE (May 4 2026 SPY $715 cascade):
//   AB had SPY 5/15 $720/$715 PUT VERTICAL @ $1.80 LMT (set when SPY @ $720).
//   By the time SPY broke $715, the spread expanded to $2.83 — LMT was stale.
//   AB had no warning that his order wouldn't fill, missed the trade.
//
// WHAT THIS AGENT DOES:
//   1. Cron polls TS open orders every 60 sec during RTH (9:30-3:55 ET)
//   2. For each ACK/working LMT order on options:
//      a. Compute live spread mid via TS option-chain API
//      b. Compare to AB's LMT price
//      c. If spread NAT > LMT × 1.10 → "STALE LMT" — Discord push
//      d. Suggest replacement LMT at fillable price + show updated R:R
//   3. Cooldown 10 min per orderId to avoid spam
//
// THE EDGE:
//   AB knows BEFORE the cascade whether his fill price is realistic.
//   Either bumps proactively OR confirms the order is stale and skips.
//   No more "did my LMT fill?" anxiety mid-cascade.
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var COOLDOWN_FILE = path.join(DATA_ROOT, 'position_monitor_cooldown.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var STALE_THRESHOLD = 1.10;     // spread NAT > LMT × 1.10 = stale (10% past LMT)
var COOLDOWN_MIN = 10;
var FILL_THRESHOLD = 0.95;       // spread NAT < LMT × 0.95 = "imminent fill" warning

// ─── COOLDOWN ─────────────────────────────────────────────────────────────
function loadCooldown() {
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveCooldown(map) {
  try { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(map, null, 2)); } catch (e) {}
}
function isInCooldown(orderId, alertType) {
  var key = orderId + ':' + alertType;
  var map = loadCooldown();
  var last = map[key];
  if (!last) return false;
  var ageMin = (Date.now() - new Date(last).getTime()) / 60000;
  return ageMin < COOLDOWN_MIN;
}
function markCooldown(orderId, alertType) {
  var key = orderId + ':' + alertType;
  var map = loadCooldown();
  map[key] = new Date().toISOString();
  saveCooldown(map);
}

// ─── TS API HELPERS ───────────────────────────────────────────────────────
async function fetchTSAccounts(token) {
  var url = 'https://api.tradestation.com/v3/brokerage/accounts';
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
  if (!r.ok) return [];
  var data = await r.json();
  return (data.Accounts || []).map(function(a) { return a.AccountID; });
}

async function fetchOpenOrders(token, accountId) {
  var url = 'https://api.tradestation.com/v3/brokerage/accounts/' + accountId + '/orders';
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 8000 });
  if (!r.ok) return [];
  var data = await r.json();
  return (data.Orders || []).filter(function(o) {
    var s = String(o.Status || '').toUpperCase();
    // Working states only (don't waste calls on filled/cancelled)
    return ['OPN', 'ACK', 'QUE', 'PAR'].indexOf(s) >= 0;
  });
}

// Pull live mid for a single option symbol
async function fetchOptionMid(symbol, token) {
  var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(symbol);
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000 });
    if (!r.ok) return null;
    var data = await r.json();
    var q = (data.Quotes || data.quotes || [])[0];
    if (!q) return null;
    var bid = parseFloat(q.Bid || 0);
    var ask = parseFloat(q.Ask || 0);
    return { bid: bid, ask: ask, mid: (bid + ask) / 2 };
  } catch (e) { return null; }
}

// Compute net spread NAT (bid/mid/ask) from individual leg quotes
async function computeSpreadNAT(legs, token) {
  var legPrices = await Promise.all(legs.map(function(leg) {
    return fetchOptionMid(leg.Symbol, token).then(function(p) {
      return p ? { ratio: leg.Ratio || 1, ...p } : null;
    });
  }));
  if (legPrices.some(function(p) { return p === null; })) return null;
  // Net: long legs use ask (you pay), short legs use bid (you receive)
  var netAsk = 0, netBid = 0, netMid = 0;
  legPrices.forEach(function(p) {
    if (p.ratio > 0) {
      netAsk += p.ask * p.ratio;
      netBid += p.bid * p.ratio;
      netMid += p.mid * p.ratio;
    } else {
      // SHORT leg — flip sign (you receive bid, pay ask back)
      netAsk -= p.bid * Math.abs(p.ratio);
      netBid -= p.ask * Math.abs(p.ratio);
      netMid -= p.mid * Math.abs(p.ratio);
    }
  });
  return { bid: netBid, mid: netMid, ask: netAsk };
}

// ─── DISCORD ALERTS ───────────────────────────────────────────────────────
async function pushStaleLmtAlert(order, spreadNAT, lmtPrice) {
  var driftPct = ((spreadNAT.mid - lmtPrice) / lmtPrice) * 100;
  var symbol = order.Symbol || (order.Legs && order.Legs[0] && order.Legs[0].Symbol) || '?';
  var legCount = order.Legs ? order.Legs.length : 1;
  var ticker = symbol.split(' ')[0];

  var embed = {
    username: 'Flow Scout — Position Monitor',
    embeds: [{
      title: '⚠️ STALE LMT — Order Won\'t Fill at Current Spread',
      description: '**' + ticker + '**: your LMT $' + lmtPrice.toFixed(2) + ' is now ' + driftPct.toFixed(0) + '% BELOW current spread mid $' + spreadNAT.mid.toFixed(2) + '. Order will NOT fill unless market reverses to your level.',
      color: 16753920,
      fields: [
        {
          name: '📊 Spread NAT (live)',
          value: 'Bid $' + spreadNAT.bid.toFixed(2) + ' / Mid $' + spreadNAT.mid.toFixed(2) + ' / Ask $' + spreadNAT.ask.toFixed(2),
          inline: false,
        },
        {
          name: '📋 Order detail',
          value: 'OrderID: ' + (order.OrderID || '?') + '\nLegs: ' + legCount + '\nLMT: $' + lmtPrice.toFixed(2) + '\nDrift from mid: ' + driftPct.toFixed(0) + '%',
          inline: false,
        },
        {
          name: '🎯 Suggested action',
          value: driftPct > 50
            ? '🚨 **CANCEL** — spread moved too far (likely cascade fired). R:R now broken if you chase.'
            : driftPct > 20
            ? '⚠️ **BUMP LMT to $' + spreadNAT.ask.toFixed(2) + '** if you still want this trade. Or cancel and look elsewhere.'
            : '🟡 Watch for reversal — spread may come back to your LMT.',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Position Monitor | 1-min poll' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  var result = await dp.send('positionMonitor', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) console.log('[POSITION-MONITOR] STALE LMT alert pushed: ' + ticker);
  else console.error('[POSITION-MONITOR] stale-LMT push FAILED: ' + (result.error || 'unknown'));
  return result;
}

async function pushImminentFillAlert(order, spreadNAT, lmtPrice) {
  var symbol = order.Symbol || (order.Legs && order.Legs[0] && order.Legs[0].Symbol) || '?';
  var ticker = symbol.split(' ')[0];

  var embed = {
    username: 'Flow Scout — Position Monitor',
    embeds: [{
      title: '🎯 IMMINENT FILL — Spread Approaching Your LMT',
      description: '**' + ticker + '**: spread mid $' + spreadNAT.mid.toFixed(2) + ' is within 5% of your LMT $' + lmtPrice.toFixed(2) + '. Order may fill any second.',
      color: 5763719,
      fields: [
        {
          name: '📊 Live spread',
          value: 'Bid $' + spreadNAT.bid.toFixed(2) + ' / Mid $' + spreadNAT.mid.toFixed(2) + ' / Ask $' + spreadNAT.ask.toFixed(2),
          inline: false,
        },
        {
          name: '⏳ Status',
          value: 'OrderID: ' + (order.OrderID || '?') + ' / LMT $' + lmtPrice.toFixed(2) + ' — watching for fill.',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Position Monitor' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  var result = await dp.send('positionMonitor', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) console.log('[POSITION-MONITOR] IMMINENT FILL alert: ' + ticker);
  else console.error('[POSITION-MONITOR] imminent-fill push FAILED: ' + (result.error || 'unknown'));
  return result;
}

// ─── MAIN MONITOR ─────────────────────────────────────────────────────────
async function runMonitor() {
  if (!ts || !ts.getAccessToken) { console.log('[POSITION-MONITOR] No TS module'); return; }
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { console.log('[POSITION-MONITOR] No token'); return; }
  if (!token) return;

  var accounts = await fetchTSAccounts(token);
  if (!accounts.length) return;

  var totalChecked = 0;
  var alertsSent = 0;

  for (var i = 0; i < accounts.length; i++) {
    var orders = await fetchOpenOrders(token, accounts[i]);
    for (var j = 0; j < orders.length; j++) {
      var o = orders[j];
      // Skip non-limit orders
      if (String(o.OrderType || '').toUpperCase() !== 'LIMIT') continue;
      var lmtPrice = parseFloat(o.LimitPrice);
      if (!isFinite(lmtPrice) || lmtPrice <= 0) continue;
      // Only handle option spreads/single-legs
      var legs = o.Legs || [];
      if (!legs.length) continue;
      var hasOptionLeg = legs.some(function(l) { return /\d{6}[CP]\d+/.test(l.Symbol || ''); });
      if (!hasOptionLeg) continue;

      var spreadNAT = await computeSpreadNAT(legs, token);
      if (!spreadNAT) continue;
      totalChecked++;

      var driftPct = ((spreadNAT.mid - lmtPrice) / lmtPrice) * 100;

      // STALE — spread mid moved beyond LMT × 1.10
      if (spreadNAT.mid > lmtPrice * STALE_THRESHOLD) {
        if (!isInCooldown(o.OrderID, 'stale')) {
          await pushStaleLmtAlert(o, spreadNAT, lmtPrice);
          markCooldown(o.OrderID, 'stale');
          alertsSent++;
        }
      }
      // IMMINENT FILL — spread mid within 5% of LMT
      else if (spreadNAT.mid > lmtPrice * FILL_THRESHOLD && spreadNAT.mid < lmtPrice * 1.05) {
        if (!isInCooldown(o.OrderID, 'imminent')) {
          await pushImminentFillAlert(o, spreadNAT, lmtPrice);
          markCooldown(o.OrderID, 'imminent');
          alertsSent++;
        }
      }
    }
  }

  console.log('[POSITION-MONITOR] Checked ' + totalChecked + ' working orders, alerts: ' + alertsSent);
  return { checked: totalChecked, alertsSent: alertsSent };
}

module.exports = {
  runMonitor: runMonitor,
};
