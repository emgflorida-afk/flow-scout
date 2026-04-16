// morningBrainBrief.js -- Stratum
// Enhanced morning brief: 8-step data gather + Claude judgment layer.
// Runs at 8:55 AM ET. Posts to Discord before the bell.

var fetch = require('node-fetch');
var fs = require('fs');

var STATE_DIR = process.env.STATE_DIR || '/tmp';
var CACHE_FILE = STATE_DIR + '/backtest-cache-yesterday.json';
var DISCORD_WEBHOOK = process.env.DISCORD_BRIEF_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function fmtPrice(n) {
  if (!isFinite(n) || n === 0) return '--';
  return '$' + n.toFixed(2);
}
function fmtPct(n) {
  if (!isFinite(n)) return '--';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function yesterdayStr() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  var day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  if (day === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// -- Step 1-4: Market data via TradeStation --
async function gatherMarketData(token) {
  var data = { futures: {}, etfs: {}, vix: null, spy52w: null };
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/ESM26,NQM26,RTYM26,SPY,QQQ,IWM,DIA,$VIX.X';
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) { console.error('[BRAIN-BRIEF] quotes HTTP ' + res.status); return data; }
    var json = await res.json();
    var quotes = json.Quotes || json.quotes || [];
    if (!Array.isArray(quotes)) quotes = [quotes];
    quotes.forEach(function(q) {
      var sym = (q.Symbol || '').toUpperCase();
      var last = parseFloat(q.Last || q.last || 0);
      var prevClose = parseFloat(q.PreviousClose || q.previousClose || 0);
      var pct = parseFloat(q.NetChangePct || q.netChangePct || 0);
      var high52 = parseFloat(q.High52Week || q.high52Week || 0);
      var entry = { last: last, prevClose: prevClose, pct: pct };
      if (sym === 'ESM26' || sym === 'NQM26' || sym === 'RTYM26') {
        data.futures[sym === 'ESM26' ? 'ES' : sym === 'NQM26' ? 'NQ' : 'RTY'] = entry;
      } else if (sym === '$VIX.X') {
        data.vix = entry;
      } else if (['SPY', 'QQQ', 'IWM', 'DIA'].indexOf(sym) !== -1) {
        data.etfs[sym] = entry;
        if (sym === 'SPY' && high52 > 0 && last > 0) {
          data.spy52w = { high: high52, last: last, distPct: (last - high52) / high52 * 100 };
        }
      }
    });
  } catch (e) { console.error('[BRAIN-BRIEF] gatherMarketData error:', e.message); }
  return data;
}

// -- Step 5: Queue concentration --
function gatherQueueData() {
  var r = { queued: [], calls: 0, puts: 0, total: 0, concentrationPct: 0, warning: '' };
  try {
    var be = require('./brainEngine');
    var all = be.getQueuedTrades() || [];
    r.queued = all.filter(function(q) { return q.status === 'PENDING'; });
    r.total = r.queued.length;
    r.queued.forEach(function(q) {
      if (q.direction === 'CALLS') r.calls++; else if (q.direction === 'PUTS') r.puts++;
    });
    if (r.total > 0) {
      var dom = Math.max(r.calls, r.puts);
      r.concentrationPct = Math.round((dom / r.total) * 100);
      if (r.concentrationPct >= 80) {
        r.warning = r.concentrationPct + '% ' + (r.calls >= r.puts ? 'calls' : 'puts') + ' \u2014 heavy directional lean';
      }
    }
  } catch (e) { console.error('[BRAIN-BRIEF] gatherQueueData error:', e.message); }
  return r;
}

// -- Step 6: Yesterday backtest (read pre-cached file) --
function readBacktestCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) { console.error('[BRAIN-BRIEF] readBacktestCache error:', e.message); return null; }
}

// -- Step 7: Weekly tracker state --
function gatherWeeklyState() {
  try {
    var wt = require('./weeklyTracker');
    return {
      state: wt.getState(),
      goal: wt.WEEKLY_GOAL || 2500,
      bar: typeof wt.formatWeeklyBar === 'function' ? wt.formatWeeklyBar() : '',
    };
  } catch (e) { console.error('[BRAIN-BRIEF] gatherWeeklyState error:', e.message); return null; }
}

// -- Step 8: Claude judgment layer --
function buildJudgmentPrompt(d) {
  var p = ['You are a day-trading co-pilot. Analyze this pre-market data and produce a bell plan.', ''];
  // Futures
  p.push('## FUTURES');
  var fut = d.market.futures || {};
  ['ES', 'NQ', 'RTY'].forEach(function(f) {
    var e = fut[f]; p.push(e ? f + ': ' + fmtPrice(e.last) + ' (' + fmtPct(e.pct) + ')' : f + ': unavailable');
  });
  // ETFs
  p.push('', '## ETFs (pre-market)');
  var etfs = d.market.etfs || {};
  ['SPY', 'QQQ', 'IWM', 'DIA'].forEach(function(s) {
    var e = etfs[s]; p.push(e ? s + ': ' + fmtPrice(e.last) + ' (' + fmtPct(e.pct) + ')' : s + ': unavailable');
  });
  if (d.market.vix) p.push('VIX: ' + fmtPrice(d.market.vix.last));
  if (d.market.spy52w) p.push('SPY distance from 52w high: ' + fmtPct(d.market.spy52w.distPct));
  // Queue
  p.push('', '## QUEUED TRADES (' + d.queue.total + ' total)');
  p.push('CALLS: ' + d.queue.calls + '  |  PUTS: ' + d.queue.puts);
  if (d.queue.warning) p.push('WARNING: ' + d.queue.warning);
  d.queue.queued.forEach(function(q) {
    p.push('  - ' + q.ticker + ' ' + (q.direction || '') + ' trigger ' + fmtPrice(q.triggerPrice) + ' (' + (q.source || '?') + ')');
  });
  // Backtest
  p.push('');
  if (d.backtest) {
    p.push('## YESTERDAY BACKTEST (' + (d.backtest.date || '?') + ')');
    p.push('Algo alerts: ' + (d.backtest.algoAlerts || 0));
    p.push('Direction: CALLS ' + ((d.backtest.byDirection || {}).CALLS || 0) + ' / PUTS ' + ((d.backtest.byDirection || {}).PUTS || 0));
    var bt = Object.keys(d.backtest.byTicker || {});
    if (bt.length) {
      bt.sort(function(a, b) { return (d.backtest.byTicker[b] || 0) - (d.backtest.byTicker[a] || 0); });
      p.push('Top tickers: ' + bt.slice(0, 5).map(function(t) { return t + '(' + d.backtest.byTicker[t] + ')'; }).join(', '));
    }
  } else { p.push('## YESTERDAY BACKTEST: unavailable'); }
  // Weekly
  p.push('');
  if (d.weekly) {
    var ws = d.weekly.state || {};
    p.push('## WEEKLY TRACKER');
    p.push('P&L: $' + (ws.totalPnL || 0).toFixed(0) + ' | Status: ' + (ws.status || '?') + ' | Goal: $' + (d.weekly.goal || 2500));
  } else { p.push('## WEEKLY TRACKER: unavailable'); }
  // Doctrine
  p.push('', '## TRADING DOCTRINE (must follow)');
  p.push('- Dead zone 11:30 AM-2:00 PM no 0DTE. No fresh entries in dead zone.');
  p.push('- Grade gate: A/A+ only if behind pace. B+ minimum otherwise.');
  p.push('- 3-contract minimum for trim ladder (sell 1 at +20%, sell 1 at +50%, hold 1 runner).');
  p.push('- No chasing above trigger. Wait for retest.');
  p.push('- SPY put hedge if 3+ directional calls are in play.');
  p.push('- Max 3 concurrent day positions.');
  p.push('- Morning window 9:30-11:30 AM is prime. After that, only A+ setups.');
  // Response format
  p.push('', '## RESPOND WITH EXACTLY THESE SECTIONS:');
  p.push('1. TAPE READ \u2014 3 sentences on market tone and bell expectations.');
  p.push('2. QUEUE ANALYSIS \u2014 which queued trades tape favors, which it warns against.');
  p.push('3. CONCENTRATION WARNING \u2014 directional lean risk + hedge consideration.');
  p.push('4. BELL PLAN \u2014 time-stamped plan 9:25\u21923:55 ET (key decision points only).');
  p.push('', 'Keep it tight. No fluff. Trader language.');
  return p.join('\n');
}

async function claudeJudgment(allData) {
  if (!ANTHROPIC_KEY) { console.log('[BRAIN-BRIEF] no ANTHROPIC_API_KEY \u2014 skipping judgment'); return null; }
  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: buildJudgmentPrompt(allData) }],
      }),
    });
    if (!res.ok) {
      console.error('[BRAIN-BRIEF] Claude API ' + res.status + ': ' + (await res.text()).slice(0, 200));
      return null;
    }
    var json = await res.json();
    return (json.content && json.content[0] && json.content[0].text) || null;
  } catch (e) { console.error('[BRAIN-BRIEF] claudeJudgment error:', e.message); return null; }
}

// -- Pre-cache backtest (called by 6 AM cron) --
async function preCacheBacktest() {
  try {
    var bt = require('./backtester');
    var date = yesterdayStr();
    console.log('[BRAIN-BRIEF] pre-caching backtest for ' + date);
    var result = await bt.runBacktest({ date: date });
    if (result && !result.error) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
      console.log('[BRAIN-BRIEF] backtest cached -> ' + CACHE_FILE);
      return { ok: true, date: date };
    }
    console.error('[BRAIN-BRIEF] backtest error:', result && result.error);
    return { error: result && result.error };
  } catch (e) { console.error('[BRAIN-BRIEF] preCacheBacktest error:', e.message); return { error: e.message }; }
}

// -- Format brief for Discord --
function formatBrief(data, judgment) {
  var lines = [];
  var today = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  lines.push('\uD83E\uDDE0 STRATUM BRAIN BRIEF \u2014 ' + today);
  lines.push('\u2550'.repeat(40));
  // Market data
  lines.push('', '\uD83D\uDCCA MARKET DATA');
  var fut = data.market.futures || {};
  lines.push(['ES', 'NQ', 'RTY'].map(function(f) {
    var e = fut[f]; return e ? f + ' ' + fmtPct(e.pct) : f + ' --';
  }).join(' | '));
  var etfs = data.market.etfs || {};
  lines.push(['SPY', 'QQQ', 'IWM', 'DIA'].map(function(s) {
    var e = etfs[s]; return e ? s + ' ' + fmtPrice(e.last) + ' (' + fmtPct(e.pct) + ')' : s + ' --';
  }).join('  '));
  var vixStr = data.market.vix ? 'VIX ' + fmtPrice(data.market.vix.last) : 'VIX --';
  var spy52Str = data.market.spy52w ? 'SPY ' + fmtPct(data.market.spy52w.distPct) + ' from 52w high' : '';
  lines.push(vixStr + (spy52Str ? ' | ' + spy52Str : ''));
  // Queue
  lines.push('', '\uD83C\uDFAF QUEUE ANALYSIS');
  lines.push(data.queue.total + ' queued: ' + data.queue.calls + ' CALLS / ' + data.queue.puts + ' PUTS');
  if (data.queue.warning) lines.push('\u26A0\uFE0F CONCENTRATION: ' + data.queue.warning);
  // Backtest
  lines.push('', '\uD83D\uDCC8 YESTERDAY\'S FLOW (backtest)');
  if (data.backtest) {
    var bt = Object.keys(data.backtest.byTicker || {});
    if (bt.length) {
      bt.sort(function(a, b) { return (data.backtest.byTicker[b] || 0) - (data.backtest.byTicker[a] || 0); });
      lines.push('Top tickers: ' + bt.slice(0, 5).map(function(t) {
        return t + ' (' + data.backtest.byTicker[t] + ' alerts)';
      }).join(', '));
    }
    lines.push('Algo alerts: ' + (data.backtest.algoAlerts || 0) +
      ' | CALLS ' + ((data.backtest.byDirection || {}).CALLS || 0) +
      ' / PUTS ' + ((data.backtest.byDirection || {}).PUTS || 0));
  } else { lines.push('[backtest unavailable]'); }
  // Weekly
  lines.push('', '\uD83D\uDCB0 WEEKLY TRACKER');
  if (data.weekly) {
    var ws = data.weekly.state || {};
    var pnl = ws.totalPnL || 0;
    var goal = data.weekly.goal || 2500;
    var remain = Math.max(0, goal - pnl);
    var dayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    var daysLeft = Math.max(1, 6 - Math.max(1, Math.min(5, dayET)));
    lines.push('P&L: ' + (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0) +
      ' | Status: ' + (ws.status || '?') + ' | Need $' + (remain / daysLeft).toFixed(0) + '/day');
    if (data.weekly.bar) lines.push(data.weekly.bar);
  } else { lines.push('[weekly tracker unavailable]'); }
  // Judgment
  lines.push('', '\uD83E\uDD16 CLAUDE BELL PLAN');
  lines.push(judgment || '[judgment unavailable \u2014 ANTHROPIC_API_KEY not set or API error]');
  // Footer
  lines.push('', '\u2550'.repeat(40));
  lines.push('Posted ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET | Stratum brain brief');
  return lines.join('\n');
}

// -- Main: generateAndPost --
async function generateAndPost(opts) {
  opts = opts || {};
  try {
    var token = null;
    try { var ts = require('./tradestation'); token = await ts.getAccessToken(); }
    catch (e) { console.error('[BRAIN-BRIEF] TS token error:', e.message); }

    var market = { futures: {}, etfs: {}, vix: null, spy52w: null };
    if (token) { market = await gatherMarketData(token); }
    else { console.error('[BRAIN-BRIEF] no TS token \u2014 market data unavailable'); }

    var queue = gatherQueueData();
    var backtest = readBacktestCache();
    var weekly = gatherWeeklyState();
    var allData = { market: market, queue: queue, backtest: backtest, weekly: weekly };

    var judgment = null;
    if (!opts.skipJudgment) judgment = await claudeJudgment(allData);

    var body = formatBrief(allData, judgment);

    if (opts.dryRun) { console.log(body); return { dryRun: true, body: body }; }

    if (!DISCORD_WEBHOOK) { console.error('[BRAIN-BRIEF] no webhook'); return { error: 'no webhook' }; }

    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Stratum Brain Brief', content: '```\n' + body + '\n```' }),
    });

    console.log('[BRAIN-BRIEF] posted \u2014 queue ' + queue.total + ', bt ' + (backtest ? 'Y' : 'N') + ', ai ' + (judgment ? 'Y' : 'N'));
    return { ok: true, queue: queue.total, hasBacktest: !!backtest, hasJudgment: !!judgment };
  } catch (e) { console.error('[BRAIN-BRIEF] generateAndPost error:', e.message); return { error: e.message }; }
}

module.exports = {
  generateAndPost: generateAndPost,
  preCacheBacktest: preCacheBacktest,
};
