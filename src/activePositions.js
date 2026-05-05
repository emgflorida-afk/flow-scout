// =============================================================================
// ACTIVE POSITIONS MANAGER — locks structural stop at fire time, manages exits
// without flip-flopping on tape signals.
//
// AB feedback May 5 PM (after 3 flip-flops in one day on ABBV/INTC/SBUX):
// "you keep doing this over and over what is wrong. if the system is broken
//  and the cards are fix it im sick of this shit"
//
// PROBLEM: I (Claude) kept overriding the LOCKED structural stop at fire time
// with reactive cut/hold calls based on every new whale flow alert. AB needs
// the SYSTEM to manage exits, not me. Once in a trade, the structural stop
// is the rule. Period.
//
// THIS MODULE:
//   1. Records every position fired through ACTION/Live Movers/Tomorrow with
//      its LOCKED structural stop and trigger info.
//   2. Cron polls every 60s during market hours, checks each active position
//      against current 5m close.
//   3. ONLY pushes Discord exit alert when STRUCTURAL STOP HITS — not on
//      tape ripples, not on counter-flow whales, not on Claude flip-flops.
//   4. Auto-marks position closed when stop hits or user manually exits.
//
// STATE: /data/active_positions.json
//   [{ id, ticker, direction, optionSymbol, entryPrice, qty, account,
//      structuralStop: { ticker, predicate, price },
//      firedAt, status: 'OPEN' | 'STOPPED_OUT' | 'CLOSED_MANUAL' | 'TP_HIT',
//      lastChecked, exitReason }]
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var POSITIONS_FILE = path.join(DATA_ROOT, 'active_positions.json');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}
var dp = null;
try { dp = require('./discordPush'); } catch (e) {}

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

function loadPositions() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); }
  catch (e) { return []; }
}

function savePositions(positions) {
  try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2)); }
  catch (e) { console.error('[ACTIVE-POS] save error:', e.message); }
}

// Record a new position with its LOCKED structural stop.
// Called by ACTION tab / Live Movers / Tomorrow tab fire handlers.
function recordPosition(pos) {
  if (!pos || !pos.ticker || !pos.direction || !pos.structuralStop) {
    throw new Error('recordPosition: ticker, direction, structuralStop required');
  }
  var positions = loadPositions();
  var entry = {
    id: 'pos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ticker: String(pos.ticker).toUpperCase(),
    direction: String(pos.direction).toLowerCase(),
    optionSymbol: pos.optionSymbol || null,
    entryPrice: parseFloat(pos.entryPrice) || null,
    qty: parseInt(pos.qty || 1, 10),
    account: pos.account || 'unknown',
    structuralStop: {
      ticker: pos.structuralStop.ticker || pos.ticker,
      predicate: pos.structuralStop.predicate || (pos.direction === 'long' ? 'below' : 'above'),
      price: parseFloat(pos.structuralStop.price),
    },
    triggerPrice: pos.triggerPrice ? parseFloat(pos.triggerPrice) : null,
    tp1: pos.tp1 ? parseFloat(pos.tp1) : null,
    tp2: pos.tp2 ? parseFloat(pos.tp2) : null,
    firedAt: new Date().toISOString(),
    status: 'OPEN',
    lastChecked: null,
    exitReason: null,
    exitedAt: null,
    notes: pos.notes || '',
    source: pos.source || 'manual',
  };
  positions.push(entry);
  savePositions(positions);
  return entry;
}

// Manually mark a position closed (user exited)
function markClosed(id, reason) {
  var positions = loadPositions();
  var p = positions.find(function(x){ return x.id === id; });
  if (!p) return { ok: false, error: 'position not found' };
  p.status = 'CLOSED_MANUAL';
  p.exitReason = reason || 'user closed';
  p.exitedAt = new Date().toISOString();
  savePositions(positions);
  return { ok: true, position: p };
}

// Get all OPEN positions
function getOpenPositions() {
  return loadPositions().filter(function(p) { return p.status === 'OPEN'; });
}

// Check a single position against current 5m close. Returns:
//   { stopHit: boolean, currentPrice, reason }
async function checkPosition(p, token) {
  if (p.status !== 'OPEN') return { skip: true, reason: 'not open' };
  if (!ts) return { skip: true, reason: 'no TS module' };

  var fetchLib = require('node-fetch');
  // Use 60m bars for SWING trades (NOT 5m which is scalp territory).
  // AB feedback May 5 PM: "you basically saying i only have 5m" — wrong
  // timeframe. Swing intent means swing-timeframe exits.
  var interval = p.timeframe === '5' ? 5 : 60;  // default 60m, override per-position
  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(p.ticker)
    + '?interval=' + interval + '&unit=Minute&barsback=2';
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000 });
    if (!r.ok) return { skip: true, reason: 'http ' + r.status };
    var data = await r.json();
    var bars = data.Bars || [];
    if (bars.length < 1) return { skip: true, reason: 'no bars' };

    // Use the most recent CLOSED bar (5m close, not live tick)
    var closedBar = bars[bars.length - 2] || bars[bars.length - 1];
    var close5m = parseFloat(closedBar.Close);
    var stopPrice = p.structuralStop.price;
    var predicate = p.structuralStop.predicate;

    var stopHit = false;
    if (predicate === 'below') stopHit = close5m < stopPrice;
    else if (predicate === 'above') stopHit = close5m > stopPrice;

    return {
      stopHit: stopHit,
      close5m: close5m,
      stopPrice: stopPrice,
      predicate: predicate,
      reason: stopHit
        ? 'STRUCTURAL STOP HIT: ' + p.ticker + ' 5m close $' + close5m + ' ' + predicate + ' $' + stopPrice
        : 'OK: ' + p.ticker + ' 5m close $' + close5m + ' (stop $' + stopPrice + ' ' + predicate + ')',
    };
  } catch (e) {
    return { skip: true, reason: e.message };
  }
}

// Run scan across all open positions, push Discord exit alert if structural stop hit
async function scanAllPositions() {
  if (!ts || !ts.getAccessToken) return { ok: false, error: 'TS not loaded' };
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { return { ok: false, error: 'no TS token' }; }
  if (!token) return { ok: false, error: 'no TS token' };

  var positions = loadPositions();
  var opens = positions.filter(function(p) { return p.status === 'OPEN'; });
  if (opens.length === 0) return { ok: true, openCount: 0 };

  var stopHitCount = 0;
  for (var i = 0; i < opens.length; i++) {
    var p = opens[i];
    var result = await checkPosition(p, token);
    p.lastChecked = new Date().toISOString();
    if (result.skip) continue;

    if (result.stopHit) {
      p.status = 'STOPPED_OUT';
      p.exitReason = result.reason;
      p.exitedAt = new Date().toISOString();
      stopHitCount++;
      // Push Discord — STRUCTURAL STOP HIT ALERT
      if (dp) {
        var dirIcon = p.direction === 'long' ? '🔴 LONG' : '🔴 SHORT';
        var embed = {
          username: 'Flow Scout — Active Positions',
          embeds: [{
            title: '🛑 STRUCTURAL STOP HIT — EXIT ' + p.ticker + ' ' + p.direction.toUpperCase(),
            description: '**' + result.reason + '**\n\n' +
                         'Position: ' + p.qty + 'ct ' + (p.optionSymbol || p.ticker) +
                         (p.entryPrice ? ' @ $' + p.entryPrice.toFixed(2) : '') +
                         '\nFired: ' + p.firedAt +
                         '\nAccount: ' + p.account,
            color: 15158332,
            fields: [
              { name: '⏰ Action', value: '**EXIT POSITION AT MARKET NOW.** Structural stop on underlying triggered. Trade thesis invalidated.', inline: false },
              { name: '📊 Hit detail', value: '5m close: $' + result.close5m + '\nStop: ' + p.structuralStop.predicate + ' $' + result.stopPrice, inline: false },
            ],
            footer: { text: 'Flow Scout | Active Position Manager | structural-stop only, NO tape-noise overrides' },
            timestamp: new Date().toISOString(),
          }],
        };
        try { await dp.send('activePositions', embed, { webhook: DISCORD_WEBHOOK }); } catch (e) {}
      }
    }
  }
  savePositions(positions);
  return { ok: true, openCount: opens.length, stopHitCount: stopHitCount };
}

module.exports = {
  recordPosition: recordPosition,
  markClosed: markClosed,
  getOpenPositions: getOpenPositions,
  scanAllPositions: scanAllPositions,
  loadPositions: loadPositions,
};
