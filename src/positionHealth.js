// positionHealth.js
// Position Health Re-Check Loop (Plan 03)
//
// Every 5 min during RTH, iterate open option positions from TradeStation,
// re-scan the underlying via bottomTick, and alert if a higher-timeframe
// signal has flipped AGAINST the position direction.
//
// READ-ONLY v1. Never auto-closes. Never mutates state.
// Triggering event: Apr 14 2026 SPY 694C -- scanner printed PUT:FAILED_2U:2HR
// across SPY/QQQ/META while the brain blindly held. Never again.

var fetch        = require('node-fetch');
var tradestation = require('./tradestation');
var bottomTick   = require('./bottomTick');

var TS_BASE  = 'https://api.tradestation.com/v3';
var ACCOUNT  = '11975462';
var WEBHOOK  = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// Dedup: { 'SPY|CALLS|RED': epochMs } — suppress same key within 15 min
var _lastAlert = {};
var DEDUP_MS   = 15 * 60 * 1000;

// ------------------------------------------------------------
// Parse an OPRA option symbol -> underlying + call/put.
// TradeStation option symbols look like:  "SPY   260416C694"
// ------------------------------------------------------------
function parseOptionSymbol(sym) {
  if (!sym || typeof sym !== 'string') return null;
  var s = sym.trim();
  // Match: TICKER  YYMMDD [C|P] STRIKE
  var m = s.match(/^([A-Z\.]+)\s+(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return {
    underlying: m[1],
    expiry:     m[2],
    right:      m[3],                       // 'C' | 'P'
    strike:     parseFloat(m[4]),
    direction:  m[3] === 'C' ? 'CALLS' : 'PUTS',
  };
}

// ------------------------------------------------------------
// Pull live positions from TradeStation.
// ------------------------------------------------------------
async function fetchOpenOptionPositions() {
  var token = await tradestation.getAccessToken();
  if (!token) { console.log('[HEALTH] no TS token'); return []; }
  try {
    var r = await fetch(TS_BASE + '/brokerage/accounts/' + ACCOUNT + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await r.json();
    var raw = data.Positions || data || [];
    if (!Array.isArray(raw)) return [];
    var opts = [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i];
      var sym = p.Symbol || p.symbol;
      var parsed = parseOptionSymbol(sym);
      if (!parsed) continue;
      var qty = parseFloat(p.Quantity || p.quantity || 0);
      if (!qty) continue;
      opts.push({
        symbol:     sym,
        underlying: parsed.underlying,
        direction:  parsed.direction,
        strike:     parsed.strike,
        qty:        qty,
        avgPrice:   parseFloat(p.AveragePrice || p.averagePrice || 0),
        unrealized: parseFloat(p.UnrealizedProfitLoss || 0),
      });
    }
    return opts;
  } catch (e) {
    console.error('[HEALTH] fetch positions error:', e.message);
    return [];
  }
}

// ------------------------------------------------------------
// Score a position against fresh bottomTick scan.
// Returns { level, reasons[] }
//   GREEN    — no counter-signal
//   YELLOW   — 30min counter-signal only
//   RED      — 2HR counter-signal
//   CRITICAL — 2HR + DAILY both counter-signal
// ------------------------------------------------------------
function scorePosition(pos, scan) {
  var reasons = [];
  if (!scan || !scan.setups) return { level: 'GREEN', reasons: ['no scan'] };

  // A CALL position wants bullish signals; bearish = counter.
  // A PUT position wants bearish signals; bullish = counter.
  var want = pos.direction === 'CALLS' ? 'BULLISH' : 'BEARISH';
  var counter = pos.direction === 'CALLS' ? 'BEARISH' : 'BULLISH';

  var flipped30 = false, flipped2h = false, flippedD = false;

  for (var i = 0; i < scan.setups.length; i++) {
    var s = scan.setups[i];
    if (s.direction !== counter) continue;
    if (s.timeframe === '30MIN') { flipped30 = true; reasons.push('30m ' + s.type); }
    if (s.timeframe === '2HR')   { flipped2h = true; reasons.push('2HR ' + s.type); }
    if (s.timeframe === 'DAILY') { flippedD  = true; reasons.push('DAILY ' + s.type); }
  }

  var level = 'GREEN';
  if (flipped30)              level = 'YELLOW';
  if (flipped2h)              level = 'RED';
  if (flipped2h && flippedD)  level = 'CRITICAL';

  return { level: level, reasons: reasons, want: want, counter: counter };
}

// ------------------------------------------------------------
// Post a Discord alert (code-block plain text).
// ------------------------------------------------------------
async function postAlert(pos, score, scan) {
  var rec = '';
  if (score.level === 'YELLOW')   rec = 'WATCH -- 30min counter-signal forming.';
  if (score.level === 'RED')      rec = 'TIGHTEN STOP TO BREAKEVEN or EXIT.';
  if (score.level === 'CRITICAL') rec = 'EXIT NOW -- 2HR + DAILY both flipped.';

  var price = scan && scan.price ? scan.price : 'n/a';
  var msg = [
    'POSITION HEALTH -- ' + score.level + ' -- ' + pos.symbol,
    'Direction: ' + pos.direction + ' | Qty: ' + pos.qty + ' | Avg: ' + pos.avgPrice,
    'Underlying: ' + pos.underlying + ' @ ' + price,
    'Counter signals: ' + (score.reasons.join(', ') || 'none'),
    'Unrealized P/L: $' + (pos.unrealized || 0).toFixed(2),
    'Recommendation: ' + rec,
  ].join('\n');

  try {
    await fetch(WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + msg + '\n```', username: 'PositionHealth' }),
    });
    console.log('[HEALTH] alert posted:', pos.symbol, score.level);
  } catch (e) {
    console.error('[HEALTH] alert post error:', e.message);
  }
}

// ------------------------------------------------------------
// Main loop. Called from cron.
// ------------------------------------------------------------
async function checkAll() {
  var t0 = Date.now();
  try {
    var positions = await fetchOpenOptionPositions();
    if (!positions.length) {
      console.log('[HEALTH] no open option positions');
      return { checked: 0, alerts: 0 };
    }

    var token = await tradestation.getAccessToken();
    if (!token) { console.log('[HEALTH] no TS token for scans'); return { checked: 0, alerts: 0 }; }

    // Dedupe underlyings (a ticker with 2 calls = 1 scan)
    var byTicker = {};
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      if (!byTicker[p.underlying]) byTicker[p.underlying] = [];
      byTicker[p.underlying].push(p);
    }

    var alerts = 0;
    var checked = 0;
    var tickers = Object.keys(byTicker);

    for (var j = 0; j < tickers.length; j++) {
      var tkr = tickers[j];
      var scan;
      try { scan = await bottomTick.scanTicker(tkr, token); }
      catch (e) { console.error('[HEALTH] scan error', tkr, e.message); continue; }

      var positionsForTkr = byTicker[tkr];
      for (var k = 0; k < positionsForTkr.length; k++) {
        var pos = positionsForTkr[k];
        checked++;
        var score = scorePosition(pos, scan);
        console.log('[HEALTH]', pos.symbol, pos.direction, '->', score.level,
          '(' + score.reasons.join(',') + ')');

        if (score.level === 'GREEN') continue;

        // Dedup
        var key = pos.symbol + '|' + score.level;
        var last = _lastAlert[key] || 0;
        if (Date.now() - last < DEDUP_MS) {
          console.log('[HEALTH] dedup suppress:', key);
          continue;
        }
        _lastAlert[key] = Date.now();

        await postAlert(pos, score, scan);
        alerts++;
      }
    }

    console.log('[HEALTH] cycle done checked:', checked, 'alerts:', alerts, 'ms:', Date.now() - t0);
    return { checked: checked, alerts: alerts };
  } catch (e) {
    console.error('[HEALTH] checkAll error:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  checkAll:            checkAll,
  parseOptionSymbol:   parseOptionSymbol,
  scorePosition:       scorePosition,
  fetchOpenOptionPositions: fetchOpenOptionPositions,
};
