// flowConcentration.js — end-of-day Bullflow concentration → next-day queue.
// Pulls a historical day's tape via backtester, scores each ticker on
// (alert_count × directional_lean × premium), and optionally auto-queues
// the top N into brainEngine for trigger-on-open execution tomorrow.

var backtester = require('./backtester');

var LIQUID_UNIVERSE = new Set([
  'SPY','QQQ','IWM','DIA','NVDA','TSLA','AAPL','MSFT','META','AMZN','GOOGL','GOOG',
  'AMD','NFLX','AVGO','COIN','PLTR','SMCI','MU','MRVL','CRM','ORCL','ADBE','UBER',
  'COST','HD','LOW','JPM','BAC','GS','XOM','CVX','WMT','UNH','LLY','MA','V',
  'CRWD','CRWV','NBIS','INTC','SNDK','SMH','XLE','XLF','DKNG','MSTR',
]);

function score(t) {
  var total = t.calls + t.puts;
  if (total < 20) return 0;                           // noise floor
  var lean = t.calls / total;                         // 0..1
  var conviction = Math.abs(lean - 0.5) * 2;          // 0..1
  if (conviction < 0.15) return 0;                    // too balanced = no edge
  var premLog = Math.log10((t.totalPremium || 0) + 1);
  return total * conviction * premLog;
}

async function runConcentration(opts) {
  var date = opts && opts.date;
  if (!date) return { error: 'date required' };
  var limit = (opts && opts.limit) || 5;

  var bt = await backtester.runBacktest({ date: date, timeoutMs: (opts && opts.timeoutMs) || 360000 });
  if (!bt || bt.error) return { error: bt && bt.error, probe: bt && bt.probe };
  var stats = bt.stats || {};
  var byTicker = stats.byTicker || {};

  var scored = Object.keys(byTicker).map(function(k) {
    var t = byTicker[k];
    var total = t.calls + t.puts;
    var direction = t.calls > t.puts ? 'CALLS' : 'PUTS';
    var lean = total > 0 ? (direction === 'CALLS' ? t.calls / total : t.puts / total) : 0;
    return {
      ticker: k, direction: direction,
      calls: t.calls, puts: t.puts, total: total,
      leanPct: Math.round(lean * 1000) / 10,
      totalPremium: Math.round(t.totalPremium || 0),
      score: Math.round(score({ calls: t.calls, puts: t.puts, totalPremium: t.totalPremium }) * 10) / 10,
      liquid: LIQUID_UNIVERSE.has(k),
    };
  }).filter(function(t) { return t.score > 0 && t.liquid; });

  scored.sort(function(a, b) { return b.score - a.score; });
  var top = scored.slice(0, limit);

  var queued = [];
  if (opts && opts.autoQueue && top.length) {
    var brainEngine = null;
    try { brainEngine = require('./brainEngine'); } catch(e) {}
    if (brainEngine && brainEngine.addQueuedTrade && brainEngine.getQueuedTrades) {
      var existing = brainEngine.getQueuedTrades() || [];
      top.forEach(function(t) {
        // Dedupe on ticker+source+direction so reruns don't stack
        var dup = existing.some(function(q) {
          return q.ticker === t.ticker && q.direction === t.direction &&
                 q.status === 'PENDING' && q.source && q.source.indexOf('FLOW_CONC') === 0;
        });
        if (dup) return;
        var qt = brainEngine.addQueuedTrade({
          ticker: t.ticker,
          direction: t.direction,
          triggerPrice: 0,                              // 0 = fire at open, let scanner pick entry
          contracts: 2,                                 // Bill-Paying default; alerter re-sizes for Stratum A+
          stopPct: -25,
          targets: [0.20, 0.50, 1.00],
          management: 'BILL_PAYING',
          source: 'FLOW_CONC_' + date,
          tradeType: 'DAY',
          note: 'Auto-queued from Bullflow concentration ' + date +
                ' | ' + t.total + ' alerts ' + t.leanPct + '% ' + t.direction +
                ' | $' + Math.round(t.totalPremium / 1e6) + 'M premium | score ' + t.score,
        });
        queued.push({ id: qt.id, ticker: qt.ticker, direction: qt.direction });
      });
    }
  }

  return {
    status: 'OK',
    date: date,
    eventsDrained: stats.eventsReceived || 0,
    streamEndReason: stats.streamEndReason,
    customAlertsCounted: stats.customAlerts || 0,
    algoAlertsCounted: stats.algoAlerts || 0,
    ranked: top,
    queued: queued,
  };
}

module.exports = { runConcentration: runConcentration };
