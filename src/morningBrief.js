// morningBrief.js -- Stratum v7.5
// -----------------------------------------------------------------
// Auto-generated 6:00 AM ET morning brief, posted to Discord.
// Pulls from every data source the brain already has and assembles
// ONE clean document: market pulse, FTFC, queued picks, watchlist,
// avoid rules. The frame that keeps you from chasing shiny objects.
// -----------------------------------------------------------------
// Sources:
//   1. Market pulse     -> TradeStation quotes (SPY, QQQ, IWM, VIX, DXY)
//   2. FTFC             -> TradeStation multi-TF bars per ticker
//   3. Queued trades    -> brainEngine.getQueuedTrades()
//   4. Watchlist levels -> PDH/PDL from yesterday's daily bar per watchlist ticker
//   5. Earnings watch   -> static list for now (v2: earnings API)
// -----------------------------------------------------------------

var fetch = require('node-fetch');

var BRIEF_WEBHOOK = process.env.DISCORD_BRIEF_WEBHOOK ||
  process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// Default watchlist — overridable via MORNING_BRIEF_WATCHLIST env var (comma list)
var DEFAULT_WATCHLIST = ['SPY','QQQ','NVDA','AMZN','TSLA','META','MSFT','AAPL','AMD','GOOGL'];

function getWatchlist() {
  var raw = process.env.MORNING_BRIEF_WATCHLIST;
  if (!raw) return DEFAULT_WATCHLIST;
  return raw.split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
}

// -----------------------------------------------------------------
// TRADESTATION HELPERS
// -----------------------------------------------------------------
async function tsQuotes(symbols, token) {
  try {
    var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + symbols.join(',');
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    var q = data.Quotes || data.quotes || [];
    return Array.isArray(q) ? q : [q];
  } catch(e) {
    console.error('[BRIEF] quotes error:', e.message);
    return [];
  }
}

async function tsBars(ticker, unit, barsback, token) {
  try {
    // sessiontemplate=Default is only valid for Minute intervals; passing it
    // on Daily/Weekly/Monthly returns 0 bars (silent rejection). This bug
    // was causing checkFTFC to return ERR for every ticker and was silently
    // disabling the FTFC veto across stratEntry, wpEntry, ayceScout, and
    // the jsmith flow enricher. Found Apr 15 2026 PM.
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + ticker +
      '?interval=1&unit=' + unit + '&barsback=' + barsback +
      (unit === 'Minute' ? '&sessiontemplate=Default' : '');
    var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return [];
    var data = await res.json();
    return data.Bars || data.bars || [];
  } catch(e) {
    return [];
  }
}

// -----------------------------------------------------------------
// FTFC CHECK -- prior-candle-close continuity across M/W/D/60m
// Price above prior close on each TF = green; all green = FTFC UP
// -----------------------------------------------------------------
async function checkFTFC(ticker, currentPrice, token) {
  try {
    var results = await Promise.all([
      tsBars(ticker, 'Monthly', 3, token),
      tsBars(ticker, 'Weekly',  3, token),
      tsBars(ticker, 'Daily',   3, token),
      tsBars(ticker, 'Minute',  130, token), // 60m bars not supported, approx via minute
    ]);
    var monthly = results[0], weekly = results[1], daily = results[2];

    function priorClose(bars) {
      if (!bars || bars.length < 2) return null;
      var prior = bars[bars.length - 2];
      return parseFloat(prior.Close || prior.close || 0);
    }

    var mClose = priorClose(monthly);
    var wClose = priorClose(weekly);
    var dClose = priorClose(daily);

    var m = mClose ? (currentPrice > mClose ? 'G' : 'R') : '-';
    var w = wClose ? (currentPrice > wClose ? 'G' : 'R') : '-';
    var d = dClose ? (currentPrice > dClose ? 'G' : 'R') : '-';

    var greens = [m, w, d].filter(function(c){ return c === 'G'; }).length;
    var reds   = [m, w, d].filter(function(c){ return c === 'R'; }).length;
    var state  = greens === 3 ? 'FTFC UP' :
                 reds   === 3 ? 'FTFC DOWN' :
                 greens >= 2  ? 'mostly UP' :
                 reds   >= 2  ? 'mostly DOWN' : 'MIXED';

    return { m: m, w: w, d: d, state: state, greens: greens, reds: reds };
  } catch(e) {
    return { m: '-', w: '-', d: '-', state: 'ERR', greens: 0, reds: 0 };
  }
}

// -----------------------------------------------------------------
// MARKET PULSE
// -----------------------------------------------------------------
async function marketPulse(token) {
  var quotes = await tsQuotes(['SPY','QQQ','IWM','$VIX.X','$DXY'], token);
  var by = {};
  quotes.forEach(function(q) {
    var sym = (q.Symbol || '').toUpperCase();
    by[sym] = {
      last: parseFloat(q.Last || q.last || 0),
      prevClose: parseFloat(q.PreviousClose || q.previousClose || 0),
      change: parseFloat(q.NetChange || q.netChange || 0),
      pct: parseFloat(q.NetChangePct || q.netChangePct || 0),
    };
  });
  return by;
}

// -----------------------------------------------------------------
// WATCHLIST LEVELS -- PDH/PDL from yesterday's daily bar
// -----------------------------------------------------------------
async function watchlistLevels(tickers, token) {
  var out = [];
  for (var i = 0; i < tickers.length; i++) {
    var t = tickers[i];
    var bars = await tsBars(t, 'Daily', 3, token);
    if (bars.length < 2) { out.push({ ticker: t, error: 'no bars' }); continue; }
    var prior = bars[bars.length - 2];
    var pdh = parseFloat(prior.High  || prior.high  || 0);
    var pdl = parseFloat(prior.Low   || prior.low   || 0);
    var pdc = parseFloat(prior.Close || prior.close || 0);
    out.push({ ticker: t, pdh: pdh, pdl: pdl, pdc: pdc });
  }
  return out;
}

// -----------------------------------------------------------------
// FORMAT BRIEF
// -----------------------------------------------------------------
function fmtPrice(n) {
  if (!isFinite(n) || n === 0) return '--';
  return '$' + n.toFixed(2);
}

function fmtPct(n) {
  if (!isFinite(n)) return '--';
  var s = n >= 0 ? '+' : '';
  return s + n.toFixed(2) + '%';
}

function formatBrief(ctx) {
  var lines = [];
  var today = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York',
  });

  lines.push('🌅 STRATUM MORNING BRIEF — ' + today);
  lines.push('════════════════════════════════════════');

  // WEEKLY TRACKER BAR (Bill-Paying Mode)
  if (ctx.weekly) {
    var w = ctx.weekly;
    var goal = ctx.weeklyGoal || 2500;
    var pnl = w.totalPnL || 0;
    var pace = pnl >= 0 ? '+$' + pnl.toFixed(0) : '-$' + Math.abs(pnl).toFixed(0);
    var remain = Math.max(0, goal - pnl);
    // Days left this week (incl today) Mon-Fri
    var dayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    var daysLeft = Math.max(1, 6 - Math.max(1, Math.min(5, dayET)));
    var perDay = remain / daysLeft;
    lines.push('💰 WEEKLY — Goal $' + goal + '  |  P&L ' + pace + '  |  ' + (ctx.weeklyBar || ''));
    lines.push('   State: ' + w.status + '  |  Days left: ' + daysLeft +
               '  |  Need $' + perDay.toFixed(0) + '/day to finish green');
    if (w.status === 'BEHIND' || w.status === 'DANGER') {
      lines.push('   ⚠️  BEHIND PACE — A/A+ setups only. No sizing up. No B-grade trades.');
    } else if (w.status === 'STOP') {
      lines.push('   🛑 WEEKLY STOP HIT — queue frozen. Manage existing only.');
    } else if (w.status === 'AHEAD') {
      lines.push('   ✅ GOAL BANKED — ride runners only. No new entries.');
    }
    lines.push('');
  }

  // MARKET PULSE
  lines.push('📊 MARKET PULSE');
  var spy = ctx.pulse.SPY || {}, qqq = ctx.pulse.QQQ || {}, iwm = ctx.pulse.IWM || {};
  var vix = ctx.pulse['$VIX.X'] || {}, dxy = ctx.pulse['$DXY'] || {};
  lines.push('SPY ' + fmtPrice(spy.last) + ' (' + fmtPct(spy.pct) + ')  ' +
             'QQQ ' + fmtPrice(qqq.last) + ' (' + fmtPct(qqq.pct) + ')  ' +
             'IWM ' + fmtPrice(iwm.last) + ' (' + fmtPct(iwm.pct) + ')');
  lines.push('VIX ' + fmtPrice(vix.last) + '   DXY ' + fmtPrice(dxy.last));

  // SPY FTFC as market proxy
  if (ctx.spyFtfc) {
    lines.push('SPY FTFC: M:' + ctx.spyFtfc.m + ' W:' + ctx.spyFtfc.w + ' D:' + ctx.spyFtfc.d +
               '  → ' + ctx.spyFtfc.state);
  }
  lines.push('');

  // QUEUED TRADES
  lines.push('🎯 QUEUED (armed for 9:30)');
  if (!ctx.queued || !ctx.queued.length) {
    lines.push('  (none — queue empty)');
  } else {
    ctx.queued.forEach(function(qt) {
      var arrow = qt.direction === 'CALLS' ? '≥' : '≤';
      lines.push('  • ' + qt.ticker + '  ' + arrow + fmtPrice(qt.triggerPrice) +
                 '  ' + qt.contractSymbol + '  x' + qt.contracts +
                 '  (' + qt.source + ')');
    });
  }
  lines.push('');

  // WATCHLIST
  lines.push('👀 WATCHLIST LEVELS (PDH/PDL from yesterday)');
  ctx.watchlist.forEach(function(w) {
    if (w.error) {
      lines.push('  • ' + w.ticker + '  (no bars)');
      return;
    }
    var ftfc = ctx.ftfcByTicker[w.ticker];
    var ftfcTag = ftfc ? '  M:' + ftfc.m + ' W:' + ftfc.w + ' D:' + ftfc.d : '';
    lines.push('  • ' + w.ticker.padEnd(5) +
               '  PDH ' + fmtPrice(w.pdh) +
               '  PDL ' + fmtPrice(w.pdl) +
               '  PDC ' + fmtPrice(w.pdc) + ftfcTag);
  });
  lines.push('');

  // AVOID RULES
  lines.push('⚠️  AVOID');
  lines.push('  • Dead zone 11:30 AM – 2:00 PM ET — no 0DTE, no fresh entries');
  lines.push('  • No chasing above trigger — wait for retest');
  lines.push('  • Max 3 concurrent DAY positions');
  lines.push('  • If position not +25% by 11:00 → close for BE or small loss');
  lines.push('');

  // FTFC SUMMARY TABLE
  lines.push('📐 FTFC BY TICKER');
  var ftfcList = Object.keys(ctx.ftfcByTicker);
  ftfcList.forEach(function(t) {
    var f = ctx.ftfcByTicker[t];
    lines.push('  ' + t.padEnd(5) + ' M:' + f.m + ' W:' + f.w + ' D:' + f.d + '  → ' + f.state);
  });
  lines.push('');

  lines.push('════════════════════════════════════════');
  lines.push('Posted ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET | Stratum brain');

  return lines.join('\n');
}

// -----------------------------------------------------------------
// MAIN: generateAndPost
// -----------------------------------------------------------------
async function generateAndPost(opts) {
  opts = opts || {};
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) {
      console.error('[BRIEF] no TS token');
      return { error: 'no token' };
    }

    // Gather in parallel where possible
    var tickers = getWatchlist();

    var pulse = await marketPulse(token);
    var spyLast = (pulse.SPY && pulse.SPY.last) || 0;
    var spyFtfc = spyLast > 0 ? await checkFTFC('SPY', spyLast, token) : null;

    var wl    = await watchlistLevels(tickers, token);
    var wlQuotes = await tsQuotes(tickers, token);
    var lastByTicker = {};
    wlQuotes.forEach(function(q){
      lastByTicker[(q.Symbol||'').toUpperCase()] = parseFloat(q.Last || q.last || 0);
    });

    // FTFC per watchlist ticker (sequential to avoid hammering API)
    var ftfcByTicker = {};
    for (var i = 0; i < tickers.length; i++) {
      var t = tickers[i];
      var last = lastByTicker[t] || 0;
      if (last > 0) ftfcByTicker[t] = await checkFTFC(t, last, token);
    }

    // Queued trades from brain
    var queued = [];
    try {
      var be = require('./brainEngine');
      queued = (be.getQueuedTrades() || []).filter(function(q){ return q.status === 'PENDING'; });
    } catch(e) { console.error('[BRIEF] queue read error:', e.message); }

    // Weekly tracker state
    var weeklyState = null, weeklyBar = '', weeklyGoal = 2500;
    try {
      var wt = require('./weeklyTracker');
      weeklyState = wt.getState();
      weeklyBar = wt.formatWeeklyBar();
      weeklyGoal = wt.WEEKLY_GOAL;
    } catch(e) { console.error('[BRIEF] weekly read error:', e.message); }

    var ctx = {
      pulse:         pulse,
      spyFtfc:       spyFtfc,
      watchlist:     wl,
      ftfcByTicker:  ftfcByTicker,
      queued:        queued,
      weekly:        weeklyState,
      weeklyBar:     weeklyBar,
      weeklyGoal:    weeklyGoal,
    };

    var body = formatBrief(ctx);

    if (opts.dryRun) {
      console.log(body);
      return { dryRun: true, body: body };
    }

    await fetch(BRIEF_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum Morning Brief',
        content: '```\n' + body + '\n```',
      }),
    });

    console.log('[BRIEF] posted — ' + tickers.length + ' watchlist, ' + queued.length + ' queued');
    return { ok: true, watchlist: tickers.length, queued: queued.length };
  } catch(e) {
    console.error('[BRIEF] generateAndPost error:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  generateAndPost,
  formatBrief,
  checkFTFC,
  getWatchlist,
};
