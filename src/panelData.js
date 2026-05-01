// =============================================================================
// PANEL DATA AGGREGATOR (May 1 2026)
//
// Single endpoint returning everything needed to render the smart TradingView
// alert panel for any ticker. Aggregates: LVL framework, structural levels,
// hold-overnight rating, signal state, GEX nodes (if available), and a
// computed alert prices list.
//
// Used by: smart-panel.js (injected into TradingView via CDP)
// =============================================================================

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

var lvlComputer = null;
try { lvlComputer = require('./lvlComputer'); } catch(e) {}

var holdOvernightChecker = null;
try { holdOvernightChecker = require('./holdOvernightChecker'); } catch(e) {}

var gexCalculator = null;
try { gexCalculator = require('./gexCalculator'); } catch(e) {}

var dailyCoilScanner = null;
try { dailyCoilScanner = require('./dailyCoilScanner'); } catch(e) {}

function round2(v) { return Math.round(v * 100) / 100; }

// =============================================================================
// AGGREGATE — returns the panel payload for a ticker
// =============================================================================
async function buildPanelData(ticker) {
  ticker = String(ticker).toUpperCase();
  var out = {
    ticker: ticker,
    fetchedAt: new Date().toISOString(),
    alerts: [],
  };

  // 1) Quote / spot
  var token = null;
  if (ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch(e) {}
  }

  // 2) LVL framework — 1H + Daily (parallel)
  if (lvlComputer && token) {
    try {
      var [lvl1H, lvlDaily] = await Promise.all([
        lvlComputer.computeForTimeframe(ticker, '1H', token).catch(function() { return null; }),
        lvlComputer.computeForTimeframe(ticker, 'Daily', token).catch(function() { return null; }),
      ]);
      if (lvl1H && lvl1H.ok) {
        out.lvl1H = {
          spot: lvl1H.spot,
          priorH: lvl1H.levels && lvl1H.levels.priorH,
          priorL: lvl1H.levels && lvl1H.levels.priorL,
          lvl125: lvl1H.levels && lvl1H.levels.lvl125,
          lvl25:  lvl1H.levels && lvl1H.levels.lvl25,
          lvl50:  lvl1H.levels && lvl1H.levels.lvl50,
          lvl75:  lvl1H.levels && lvl1H.levels.lvl75,
          lvl875: lvl1H.levels && lvl1H.levels.lvl875,
          rawSignal: lvl1H.rawSignal,
          direction: lvl1H.direction,
        };
        if (!out.spot) out.spot = lvl1H.spot;
      }
      if (lvlDaily && lvlDaily.ok) {
        out.lvlDaily = {
          spot: lvlDaily.spot,
          priorH: lvlDaily.levels && lvlDaily.levels.priorH,
          priorL: lvlDaily.levels && lvlDaily.levels.priorL,
          lvl125: lvlDaily.levels && lvlDaily.levels.lvl125,
          lvl25:  lvlDaily.levels && lvlDaily.levels.lvl25,
          lvl50:  lvlDaily.levels && lvlDaily.levels.lvl50,
          lvl75:  lvlDaily.levels && lvlDaily.levels.lvl75,
          lvl875: lvlDaily.levels && lvlDaily.levels.lvl875,
          rawSignal: lvlDaily.rawSignal,
          direction: lvlDaily.direction,
        };
        if (!out.spot) out.spot = lvlDaily.spot;
      }
    } catch(e) { out.lvlError = e.message; }
  }

  // 3) Hold-overnight rating
  if (holdOvernightChecker) {
    try {
      var hr = await holdOvernightChecker.checkTicker(ticker, { direction: 'LONG' });
      out.hold = {
        rating: hr.rating,
        score: hr.score,
        spot: hr.spot,
        atr14: hr.atr14,
        cautions: (hr.cautions || []).map(function(c) { return c.msg; }),
        greenLights: (hr.greenLights || []).map(function(g) { return g.msg; }),
        hardBlocks: (hr.hardBlocks || []).map(function(b) { return b.msg; }),
      };
      if (!out.spot && hr.spot) out.spot = parseFloat(hr.spot);
    } catch(e) {}
  }

  // 4) GEX (best-effort — works for indices)
  if (gexCalculator && token && /^(SPY|QQQ|IWM|DIA)$/.test(ticker)) {
    try {
      var gex = await gexCalculator.computeForTicker(ticker, token);
      if (gex && !gex.error) {
        out.gex = {
          spot: gex.spot,
          regime: gex.regime,
          totalGEX: gex.totalGEX,
          callWall: gex.callWall && gex.callWall.strike,
          putWall: gex.putWall && gex.putWall.strike,
          zeroGamma: gex.zeroGamma,
          kingNodes: (gex.kingNodes || []).slice(0, 3).map(function(k) {
            return { strike: k.strike, netGex: k.netGex, totalOI: k.totalOI };
          }),
        };
      }
    } catch(e) {}
  }

  // 5) Build prioritized alert list
  out.alerts = buildAlerts(out);
  return out;
}

// =============================================================================
// BUILD ALERTS — generate prioritized price level list
// =============================================================================
function buildAlerts(data) {
  var alerts = [];
  var spot = data.spot;

  // 1H LVL framework (most actionable for intraday)
  if (data.lvl1H) {
    var l = data.lvl1H;
    if (l.lvl25)  alerts.push({ price: round2(l.lvl25),  label: '1H LVL_LONG_25 ⭐',     color: 'yellow', priority: 1, side: 'long' });
    if (l.lvl125) alerts.push({ price: round2(l.lvl125), label: '1H lvl_125 (stop)',     color: 'red',    priority: 6, side: 'short' });
    if (l.lvl50)  alerts.push({ price: round2(l.lvl50),  label: '1H midpoint (TP1)',     color: 'aqua',   priority: 4, side: 'long' });
    if (l.lvl75)  alerts.push({ price: round2(l.lvl75),  label: '1H LVL_SHORT_75',       color: 'red',    priority: 5, side: 'short' });
    if (l.priorH) alerts.push({ price: round2(l.priorH), label: '1H priorH',             color: 'green',  priority: 3, side: 'long' });
    if (l.priorL) alerts.push({ price: round2(l.priorL), label: '1H priorL',             color: 'red',    priority: 6, side: 'short' });
  }

  // Daily structural levels
  if (data.lvlDaily) {
    var d = data.lvlDaily;
    if (d.priorH) alerts.push({ price: round2(d.priorH), label: 'Daily PDH',             color: 'green',  priority: 2, side: 'long' });
    if (d.priorL) alerts.push({ price: round2(d.priorL), label: 'Daily PDL',             color: 'red',    priority: 5, side: 'short' });
    if (d.lvl50)  alerts.push({ price: round2(d.lvl50),  label: 'Daily midpoint',        color: 'aqua',   priority: 7, side: 'mid' });
  }

  // GEX walls (when available)
  if (data.gex) {
    if (data.gex.callWall) alerts.push({ price: round2(data.gex.callWall), label: '🟩 CALL WALL', color: 'green', priority: 2, side: 'long' });
    if (data.gex.putWall)  alerts.push({ price: round2(data.gex.putWall),  label: '🟥 PUT WALL',  color: 'red',   priority: 5, side: 'short' });
    if (data.gex.zeroGamma) alerts.push({ price: round2(data.gex.zeroGamma), label: '⚪ Zero Gamma', color: 'aqua', priority: 4, side: 'mid' });
    (data.gex.kingNodes || []).slice(0,2).forEach(function(k) {
      var lab = k.netGex > 0 ? '👑 King CALL' : '👑 King PUT';
      alerts.push({ price: round2(k.strike), label: lab, color: k.netGex > 0 ? 'green' : 'red', priority: 3, side: k.netGex > 0 ? 'long' : 'short' });
    });
  }

  // Sort: by side (long-side bullish first if spot known), then priority, then price
  alerts.sort(function(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.price - b.price;
  });

  // Dedup by price (within 0.5% of each other = same level)
  var deduped = [];
  alerts.forEach(function(a) {
    var dup = deduped.find(function(d) {
      return Math.abs(d.price - a.price) / d.price < 0.005;
    });
    if (dup) {
      // Merge labels
      if (!dup.label.includes(a.label.split(' ')[0])) dup.label += ' / ' + a.label;
    } else {
      deduped.push(a);
    }
  });

  return deduped.slice(0, 12);  // cap at 12 levels max
}

module.exports = {
  buildPanelData: buildPanelData,
  buildAlerts: buildAlerts,
};
