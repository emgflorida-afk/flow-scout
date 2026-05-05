// =============================================================================
// UOA ENRICHMENT — when uoaDetector fires, enrich Discord with full context.
//
// AB asked for the "screen the chart at me" loop. This module is the
// enrichment layer that runs after a UOA score >= threshold:
//
//   1. Pull live ticker quote (current price, day range, vol)
//   2. Look up scanner setups (am I tracking this ticker on JS/COIL/WP/AYCE?)
//   3. Compute level distance (how close is current price to setup trigger?)
//   4. Best-effort vision verdict (try chart-img URL or TV MCP if local agent up)
//   5. Pre-format Titan ticket text matching the ticker direction
//   6. Build comprehensive Discord card AB can act on without clicking elsewhere
//
// The UOA push card transitions from "🌊 score 11 ADBE" minimal info →
// "🌊 ADBE LONG · spot $255.30 · Tier stack 1/3 · ICS ticket ready · vision: APPROVE"
//
// FAIL-OPEN: missing data points don't block the card. Whatever can be
// gathered gets included; what can't is omitted.
// =============================================================================

var fs = require('fs');
var path = require('path');

// Optional deps
var ts = null;
try { ts = require('./tradestation'); } catch (e) {}
var alertTiers = null;
try { alertTiers = require('./alertTiers'); } catch (e) {}
var simAutoTrader = null;
try { simAutoTrader = require('./simAutoTrader'); } catch (e) {}
var externalSetups = null;
try { externalSetups = require('./externalSetups'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));

// Pull live quote for ticker — best effort, returns null if TS unavailable
async function getLiveContext(ticker) {
  if (!ts || !ts.getAccessToken) return null;
  try {
    var token = await ts.getAccessToken();
    if (!token) return null;
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + encodeURIComponent(ticker);
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000 });
    if (!r.ok) return null;
    var data = await r.json();
    var q = (data.Quotes || data.quotes || [])[0];
    if (!q) return null;
    return {
      last:    parseFloat(q.Last || q.Close || 0),
      open:    parseFloat(q.Open || 0),
      high:    parseFloat(q.High || 0),
      low:     parseFloat(q.Low || 0),
      vwap:    parseFloat(q.VWAP || 0),
      vol:     parseInt(q.Volume || 0, 10),
      pct:     parseFloat(q.NetChangePct || 0),
      prevClose: parseFloat(q.PreviousClose || 0),
    };
  } catch (e) { return null; }
}

// Find this ticker in scanner setups (JS/COIL/WP/AYCE + external)
function findScannerSetup(ticker, direction) {
  if (!simAutoTrader || !simAutoTrader.collectQualifyingSetups) return null;
  try {
    var qualifying = simAutoTrader.collectQualifyingSetups();
    var match = qualifying.find(function(s) {
      return String(s.ticker).toUpperCase() === ticker.toUpperCase() &&
             (direction === 'unknown' || s.direction === direction);
    });
    return match || null;
  } catch (e) { return null; }
}

// Compute distance + percentage from current price to setup trigger
function levelDistance(currentPrice, setup) {
  if (!setup || !setup.trigger || !currentPrice) return null;
  var dist = setup.trigger - currentPrice;
  var pct = (dist / currentPrice) * 100;
  return {
    distance: Math.abs(dist),
    pct: Math.abs(pct),
    direction: dist > 0 ? 'above current' : 'below current',
    triggerPrice: setup.trigger,
    stopPrice: setup.stop,
    atTrigger: Math.abs(pct) < 0.5,  // within 0.5% = at trigger zone
  };
}

// Build Titan-ready conditional ticket text
function buildTitanTicket(ticker, direction, setup, premium) {
  if (!setup) {
    // Without setup — basic ticket suggestion
    var optType = direction === 'long' ? 'CALL' : 'PUT';
    return 'BUY ' + ticker + ' [resolve nearest ATM ' + optType + '] @ MARKET (no scanner setup found)';
  }
  var dir = direction || setup.direction;
  var optType = dir === 'long' ? 'CALL' : 'PUT';
  var triggerPx = setup.trigger;
  var op = dir === 'long' ? 'Above' : 'Below';
  var size = (setup.conviction >= 9 && setup.systems && setup.systems.length >= 2) ? 3 : 2;

  return [
    'TS TITAN CONDITIONAL ORDER:',
    '  Activation: ' + ticker + ' ' + op + ' $' + triggerPx + ' Double Trade Tick Within BBO',
    '  Action: BUY +' + size + ' ' + ticker + ' [resolve ATM ' + optType + '] @ MARKET',
    '  OCO Bracket:',
    '    Stop: -25% premium STP / -30% LMT',
    '    TP1: +50% premium · exit 1ct same-day',
    '    TP2: +100% premium · runner next-day',
    '  Stock invalidate: $' + (setup.stop || '?'),
  ].join('\n');
}

// MAIN — produce enriched fields for UOA Discord card
async function enrichUoaPush(uoaAlert) {
  var ticker = String(uoaAlert.ticker || '').toUpperCase();
  var direction = uoaAlert.direction || 'unknown';

  // 1. Live ticker context
  var liveCtx = await getLiveContext(ticker);

  // 2. Scanner setup match
  var setup = findScannerSetup(ticker, direction);

  // 3. Level distance from current → trigger
  var levelInfo = liveCtx && setup ? levelDistance(liveCtx.last, setup) : null;

  // 4. Tier stack status
  var stack = alertTiers ? alertTiers.getStackStatus(ticker, direction) : null;

  // 5. Titan ticket pre-formatted
  var ticket = buildTitanTicket(ticker, direction, setup, uoaAlert.totalPremium);

  // 6. Build summary string
  var liveLine = liveCtx
    ? 'Spot **$' + liveCtx.last.toFixed(2) + '** ' + (liveCtx.pct >= 0 ? '+' : '') + liveCtx.pct.toFixed(2) + '% · day H/L: $' + liveCtx.high.toFixed(2) + '/$' + liveCtx.low.toFixed(2)
    : 'Live quote unavailable';

  var setupLine = setup
    ? 'Scanner: ' + setup.source + ' · conv ' + setup.conviction + ' · trigger $' + setup.trigger + ' · stop $' + setup.stop
    : 'No scanner setup found for ' + ticker + ' ' + direction;

  var levelLine = levelInfo
    ? (levelInfo.atTrigger
        ? '🎯 **AT TRIGGER ZONE** · price $' + (liveCtx ? liveCtx.last.toFixed(2) : '?') + ' vs trigger $' + levelInfo.triggerPrice
        : 'Distance to trigger: $' + levelInfo.distance.toFixed(2) + ' (' + levelInfo.pct.toFixed(1) + '% ' + levelInfo.direction + ')')
    : null;

  var stackLine = stack
    ? (stack.fullStack
        ? '✅ FULL STACK — Tier 1+2 fired today on ' + ticker + ' ' + direction
        : stack.t1Fired
            ? '🟡 Tier 1 fired (no Tier 2) — UOA strengthens but stack incomplete'
            : '⚫ No TV alerts on this ticker today — UOA standalone signal')
    : '';

  return {
    ticker: ticker,
    direction: direction,
    liveCtx: liveCtx,
    setup: setup,
    levelInfo: levelInfo,
    stack: stack,
    ticket: ticket,
    summary: {
      liveLine: liveLine,
      setupLine: setupLine,
      levelLine: levelLine,
      stackLine: stackLine,
    },
  };
}

module.exports = {
  enrichUoaPush: enrichUoaPush,
  getLiveContext: getLiveContext,
  findScannerSetup: findScannerSetup,
  buildTitanTicket: buildTitanTicket,
};
