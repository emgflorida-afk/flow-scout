// =============================================================================
// DAILY FLOW BACKTEST + MORNING BRIEF — Phase 4.25 (May 5)
//
// AB's directive: "make sure we run backtest for today's flow" +
// "everyday we should know what is coming in."
//
// PURPOSE:
//   Daily executive recap of what the system actually saw, what fired, what
//   worked. Replaces the cold-start every morning where AB has to ask "did
//   anything happen yesterday?". Now there is a deterministic morning ritual:
//
//     1. 4:30 PM ET — Daily flow recap pushed to Discord (yesterday's tape).
//     2. 8:00 AM ET — Morning brief pushed (today's plan + yesterday's perf).
//
// OUTPUT FILES (persisted to /data volume):
//   /data/flow_recap_YYYY-MM-DD.json    — full structured recap
//   /data/morning_brief_YYYY-MM-DD.md   — markdown brief AB can read aloud
//
// EXPORTS:
//   runDailyBacktest(date)        → recap structure (object)
//   buildMorningBrief(date)       → { markdown, json } morning brief
//   loadRecap(date)               → cached recap or null
//   loadMorningBrief(date)        → cached MD or null
//   pushDailyRecapToDiscord(rec)  → fire Discord embed
//   pushMorningBriefToDiscord(b)  → fire Discord embed
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));

var dp = null;
try { dp = require('./discordPush'); } catch (e) {}

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayET() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var y = et.getFullYear();
  var m = String(et.getMonth() + 1).padStart(2, '0');
  var d = String(et.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function isWeekend(date) {
  var d = new Date(date + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}

function lastTradingDay(date) {
  var d = new Date(date + 'T12:00:00Z');
  for (var i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      var y = d.getUTCFullYear();
      var m = String(d.getUTCMonth() + 1).padStart(2, '0');
      var dd = String(d.getUTCDate()).padStart(2, '0');
      return y + '-' + m + '-' + dd;
    }
  }
  return date;
}

function safeRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

function safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function fmtDollar(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + Math.round(n);
}

function fmtDate(d) {
  // 2026-05-05 → May 5
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var parts = String(d).split('-');
  if (parts.length !== 3) return d;
  var m = parseInt(parts[1], 10);
  var dd = parseInt(parts[2], 10);
  return months[m - 1] + ' ' + dd;
}

// ---------------------------------------------------------------------------
// CORE — runDailyBacktest(date)
// Aggregates everything the system saw on date Y, structures a recap.
// ---------------------------------------------------------------------------

function runDailyBacktest(date) {
  date = date || todayET();
  var startOfDay = new Date(date + 'T00:00:00-04:00').getTime();   // ET-ish
  var endOfDay   = new Date(date + 'T23:59:59-04:00').getTime();

  // ---- 1. UOA log breakdown ---------------------------------------------------
  var uoaLog = safeRead(path.join(DATA_ROOT, 'uoa_log.json')) || [];
  var dayUoa = uoaLog.filter(function(e) {
    var t = new Date(e.timestamp).getTime();
    return t >= startOfDay && t <= endOfDay;
  });

  // Source attribution: TV alerts have alert source 'tv' typically (or marker on
  // record); Bullflow custom alerts have isCustom=true; everything else = bullflow algo.
  var bySource = { bullflow_custom: 0, bullflow_algo: 0, tv: 0, other: 0 };
  dayUoa.forEach(function(e) {
    if (e.isCustom) bySource.bullflow_custom++;
    else if (e.source === 'tv' || e.alertSource === 'tv') bySource.tv++;
    else bySource.bullflow_algo++;
  });

  // John Discord history — count posts on date
  var johnPosts = 0;
  var johnFiles = ['option-trade-ideas.parsed.json', 'free-charts.parsed.json', 'cvo-swings-leaps.parsed.json', 'vip-flow-options-alerts.parsed.json'];
  var johnDir = path.join(DATA_ROOT, 'john_history');
  johnFiles.forEach(function(f) {
    var fp = path.join(johnDir, f);
    var arr = safeRead(fp);
    if (!Array.isArray(arr)) return;
    arr.forEach(function(p) {
      var t = new Date(p.posted_at || 0).getTime();
      if (t >= startOfDay && t <= endOfDay) johnPosts++;
    });
  });

  // ---- 2. Top tickers by premium ---------------------------------------------
  var byTicker = {};
  dayUoa.forEach(function(e) {
    var t = String(e.ticker || '').toUpperCase();
    if (!t) return;
    if (!byTicker[t]) byTicker[t] = { ticker: t, alerts: 0, premium: 0, scoreMax: 0, customCount: 0, directions: {} };
    byTicker[t].alerts++;
    byTicker[t].premium += parseFloat(e.premium || 0);
    if ((e.score || 0) > byTicker[t].scoreMax) byTicker[t].scoreMax = e.score;
    if (e.isCustom) byTicker[t].customCount++;
    var dir = String(e.direction || 'unknown').toLowerCase();
    byTicker[t].directions[dir] = (byTicker[t].directions[dir] || 0) + 1;
  });
  var topTickers = Object.values(byTicker)
    .sort(function(a, b) { return b.premium - a.premium; })
    .slice(0, 10);

  // ---- 3. SIM fires breakdown -------------------------------------------------
  var simState = safeRead(path.join(DATA_ROOT, 'sim_auto_state.json')) || {};
  // Use today's fires if date == today, else previousDayFires when archived.
  var simFires = [];
  if (simState.currentDate === date) {
    simFires = simState.dailyFires || [];
  } else if (simState.previousDate === date) {
    simFires = simState.previousDayFires || [];
  } else {
    // Try as best-effort from dailyFires if dates roughly match
    simFires = (simState.dailyFires || []).filter(function(f) {
      var t = new Date(f.firedAt || 0).getTime();
      return t >= startOfDay && t <= endOfDay;
    });
  }

  // ---- 4. Trade tracker outcomes (closed trades fired today) ------------------
  var tradeTracker = safeRequire('./tradeTracker');
  var tradesFired = [];
  var winCount = 0, lossCount = 0, breakevenCount = 0, openCount = 0;
  var totalPnl = 0;
  if (tradeTracker && tradeTracker.listAll) {
    try {
      var allTrades = tradeTracker.listAll();
      tradesFired = allTrades.filter(function(t) {
        var ft = new Date(t.firedAt || t.loggedAt || 0).getTime();
        return ft >= startOfDay && ft <= endOfDay;
      });
      tradesFired.forEach(function(t) {
        if (t.outcome === 'win') winCount++;
        else if (t.outcome === 'loss') lossCount++;
        else if (t.outcome === 'breakeven') breakevenCount++;
        else openCount++;
        if (typeof t.pnl === 'number') totalPnl += t.pnl;
      });
    } catch (e) {}
  }

  // ---- 5. Conviction-vs-outcome correlation (key insight from May 5) ---------
  // For trades that closed: bucket by conviction tier (high 9-10, mid 7-8, low <7)
  // and compare win rates. Surfaces miscalibration.
  var convictionBuckets = {
    high: { count: 0, wins: 0, losses: 0, sumR: 0 },   // conv >= 9
    mid:  { count: 0, wins: 0, losses: 0, sumR: 0 },   // conv 7-8
    low:  { count: 0, wins: 0, losses: 0, sumR: 0 },   // conv < 7
  };
  var topWinner = null, topLoser = null, highestConviction = null;
  tradesFired.forEach(function(t) {
    var conv = t.confluenceScore || 0;
    var bucket = conv >= 9 ? 'high' : conv >= 7 ? 'mid' : 'low';
    if (t.outcome === 'win' || t.outcome === 'loss') {
      convictionBuckets[bucket].count++;
      if (t.outcome === 'win') convictionBuckets[bucket].wins++;
      if (t.outcome === 'loss') convictionBuckets[bucket].losses++;
      if (typeof t.rRealized === 'number') convictionBuckets[bucket].sumR += t.rRealized;
    }
    if (t.outcome === 'win' && (!topWinner || (t.pnl || 0) > (topWinner.pnl || 0))) topWinner = t;
    if (t.outcome === 'loss' && (!topLoser || (t.pnl || 0) < (topLoser.pnl || 0))) topLoser = t;
    if (!highestConviction || (t.confluenceScore || 0) > (highestConviction.confluenceScore || 0)) highestConviction = t;
  });

  // Calibration verdict — was the highest-conviction trade actually a winner?
  var calibrationLine = null;
  if (highestConviction) {
    var hcOut = highestConviction.outcome;
    var hcConv = highestConviction.confluenceScore || 0;
    if (hcOut === 'win') {
      calibrationLine = 'HIGHEST conv ' + hcConv + ' = WIN — system calibrated.';
    } else if (hcOut === 'loss') {
      calibrationLine = '⚠ HIGHEST conv ' + hcConv + ' = LOSS — signal mismatch (review tier weights).';
    } else if (hcOut === 'breakeven') {
      calibrationLine = 'HIGHEST conv ' + hcConv + ' = BREAKEVEN.';
    } else {
      calibrationLine = 'HIGHEST conv ' + hcConv + ' = still open.';
    }
  }

  // ---- 6. Vision-verdict accuracy --------------------------------------------
  var visionStats = { approve: { fired: 0, win: 0, loss: 0 }, veto: { count: 0 } };
  tradesFired.forEach(function(t) {
    var v = String(t.visionVerdict || '').toUpperCase();
    if (v === 'APPROVE' || v === 'GO' || v === 'GREEN') {
      visionStats.approve.fired++;
      if (t.outcome === 'win') visionStats.approve.win++;
      if (t.outcome === 'loss') visionStats.approve.loss++;
    } else if (v === 'VETO' || v === 'KILL' || v === 'RED' || v === 'NO') {
      visionStats.veto.count++;
    }
  });

  // ---- 7. Pattern matches that fired vs setups that DIDN'T fire ---------------
  // Best-effort from setup_radar.json — what was qualifying yesterday vs what fired.
  var setupRadar = safeRead(path.join(DATA_ROOT, 'setup_radar.json')) || { ready: [], forming: [] };
  var firedTickerKeys = {};
  simFires.forEach(function(f) {
    firedTickerKeys[(f.ticker || '').toUpperCase() + ':' + (f.direction || '?')] = true;
  });
  var didNotFire = (setupRadar.ready || []).filter(function(s) {
    var key = (s.ticker || '').toUpperCase() + ':' + (s.direction || '?');
    return !firedTickerKeys[key];
  }).slice(0, 10);

  // ---- 8. Patterns aggregate (what scanners caught) ---------------------------
  var patternCounts = {};
  (setupRadar.ready || []).concat(setupRadar.forming || []).forEach(function(s) {
    var p = s.type || s.pattern || 'unknown';
    patternCounts[p] = (patternCounts[p] || 0) + 1;
  });

  // ---- 9. Hit rate (fired+closed) --------------------------------------------
  var firedClosed = winCount + lossCount + breakevenCount;
  var hitRate = firedClosed > 0 ? Math.round((winCount / firedClosed) * 100) : null;

  // ---- 10. UOA whale alerts (premium >= $1M) ---------------------------------
  var whaleAlerts = dayUoa
    .filter(function(e) { return parseFloat(e.premium || 0) >= 1000000 || e.isWhale; })
    .map(function(e) { return { ticker: e.ticker, premium: parseFloat(e.premium || 0), direction: e.direction, custom: e.isCustom, alertName: e.customAlertName }; })
    .sort(function(a, b) { return b.premium - a.premium; })
    .slice(0, 5);

  // ---- 11. Build executive summary -------------------------------------------
  var execSummary = [];
  execSummary.push('UOA alerts: ' + dayUoa.length +
                   ' (Bullflow custom ' + bySource.bullflow_custom +
                   ', algo ' + bySource.bullflow_algo +
                   ', TV ' + bySource.tv + ')');
  if (johnPosts > 0) execSummary.push('John Discord posts: ' + johnPosts);
  if (topTickers.length > 0) {
    execSummary.push('Top by $: ' + topTickers.slice(0, 3).map(function(t) {
      return t.ticker + ' ' + fmtDollar(t.premium);
    }).join(', '));
  }
  execSummary.push('SIM fires: ' + simFires.length +
                   (firedClosed > 0 ? ' → ' + winCount + 'W/' + lossCount + 'L/' + breakevenCount + 'BE/' + openCount + ' open' : '') +
                   (hitRate != null ? ' (' + hitRate + '%)' : ''));
  if (calibrationLine) execSummary.push('Calibration: ' + calibrationLine);

  var recap = {
    date: date,
    generatedAt: new Date().toISOString(),
    executiveSummary: execSummary,

    uoa: {
      total: dayUoa.length,
      bySource: bySource,
      johnPosts: johnPosts,
      whaleAlerts: whaleAlerts,
      topTickers: topTickers,
    },

    simFires: {
      count: simFires.length,
      fires: simFires,
      closed: firedClosed,
      wins: winCount,
      losses: lossCount,
      breakevens: breakevenCount,
      open: openCount,
      hitRatePct: hitRate,
      totalPnl: totalPnl,
      topWinner: topWinner ? { ticker: topWinner.ticker, pnl: topWinner.pnl, pnlPct: topWinner.pnlPct, conviction: topWinner.confluenceScore } : null,
      topLoser:  topLoser  ? { ticker: topLoser.ticker,  pnl: topLoser.pnl,  pnlPct: topLoser.pnlPct,  conviction: topLoser.confluenceScore  } : null,
    },

    convictionCalibration: {
      buckets: convictionBuckets,
      highestConvictionTrade: highestConviction ? {
        ticker: highestConviction.ticker,
        conviction: highestConviction.confluenceScore,
        outcome: highestConviction.outcome,
        pnl: highestConviction.pnl,
      } : null,
      verdict: calibrationLine,
    },

    visionAccuracy: visionStats,

    patterns: {
      qualifying: patternCounts,
      readyCount: (setupRadar.ready || []).length,
      formingCount: (setupRadar.forming || []).length,
      didNotFire: didNotFire.map(function(s) {
        return { ticker: s.ticker, direction: s.direction, conviction: s.conviction, type: s.type, source: s.source };
      }),
    },
  };

  // Save to /data
  try {
    var fp = path.join(DATA_ROOT, 'flow_recap_' + date + '.json');
    fs.writeFileSync(fp, JSON.stringify(recap, null, 2));
    recap._savedTo = fp;
  } catch (e) { recap._saveError = e.message; }

  return recap;
}

function loadRecap(date) {
  date = date || todayET();
  return safeRead(path.join(DATA_ROOT, 'flow_recap_' + date + '.json'));
}

// ---------------------------------------------------------------------------
// MORNING BRIEF — combines yesterday's recap + today's pre-market snapshot.
// ---------------------------------------------------------------------------

async function buildMorningBrief(date) {
  date = date || todayET();

  // 1. Yesterday recap (or last trading day if today is Mon)
  var yDate = lastTradingDay(date);
  var yRecap = loadRecap(yDate);
  // Lazy backfill if yesterday's recap was never saved
  if (!yRecap) {
    try { yRecap = runDailyBacktest(yDate); } catch (e) {}
  }

  // 2. Today's market context (live, may fail pre-market)
  var marketCtx = await fetchInternalEndpoint('/api/market-context');

  // 3. Today's setup radar
  var setupRadar = await fetchInternalEndpoint('/api/setup-radar');
  if (!setupRadar) setupRadar = safeRead(path.join(DATA_ROOT, 'setup_radar.json')) || { ready: [], forming: [] };

  // 4. JS scan (last persisted)
  var jsScan = await fetchInternalEndpoint('/api/js-scan');
  // 5. WP scan (last persisted)
  var wpScan = await fetchInternalEndpoint('/api/wp-scan');
  // 6. V-Bottom (live)
  var vBot = await fetchInternalEndpoint('/api/v-bottom-scan?minScore=8').catch(function() { return null; });

  // ---------- Build markdown ----------
  var lines = [];
  lines.push('# MORNING BRIEF — ' + fmtDate(date));
  lines.push('');
  lines.push('_Generated ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET_');
  lines.push('');

  // Tape now
  lines.push('## Tape now');
  if (marketCtx && marketCtx.ok) {
    lines.push('- **Verdict**: ' + marketCtx.verdict);
    lines.push('- **Summary**: ' + marketCtx.summary);
    if (marketCtx.warnings && marketCtx.warnings.length) {
      lines.push('- Warnings:');
      marketCtx.warnings.forEach(function(w) { lines.push('  - ' + w); });
    }
  } else {
    lines.push('- _market-context unavailable (likely pre-market) — check /api/market-context after 9:30 AM ET_');
  }
  lines.push('');

  // Yesterday recap
  lines.push('## Yesterday (' + fmtDate(yDate) + ')');
  if (yRecap) {
    yRecap.executiveSummary.forEach(function(s) { lines.push('- ' + s); });
    if (yRecap.simFires && yRecap.simFires.topWinner) {
      var w = yRecap.simFires.topWinner;
      lines.push('- Top winner: ' + w.ticker + (w.pnl != null ? ' ($' + Math.round(w.pnl) + ')' : '') + ' conv ' + (w.conviction || '?'));
    }
    if (yRecap.simFires && yRecap.simFires.topLoser) {
      var L = yRecap.simFires.topLoser;
      lines.push('- Top loser: ' + L.ticker + (L.pnl != null ? ' ($' + Math.round(L.pnl) + ')' : '') + ' conv ' + (L.conviction || '?'));
    }
    if (yRecap.uoa && yRecap.uoa.whaleAlerts && yRecap.uoa.whaleAlerts.length) {
      lines.push('- Whales ($1M+):');
      yRecap.uoa.whaleAlerts.slice(0, 3).forEach(function(w) {
        lines.push('  - ' + w.ticker + ' ' + (w.direction || '?') + ' ' + fmtDollar(w.premium) + (w.alertName ? ' (' + w.alertName + ')' : ''));
      });
    }
  } else {
    lines.push('- _no recap available for ' + yDate + '_');
  }
  lines.push('');

  // Today's setups
  lines.push("## Today's high-conviction setups");
  var ready = (setupRadar && setupRadar.ready) || [];
  ready.sort(function(a, b) { return (b.conviction || 0) - (a.conviction || 0); });
  var hi = ready.filter(function(s) { return (s.conviction || 0) >= 8; });
  if (hi.length === 0) {
    lines.push('- _No conv >= 8 candidates in setup_radar — check /api/setup-radar after pre-market scanners run_');
  } else {
    var tape = (marketCtx && marketCtx.tape) || 'MIXED';
    var longs = hi.filter(function(s) { return String(s.direction).toLowerCase() === 'long'; });
    var shorts = hi.filter(function(s) { return String(s.direction).toLowerCase() === 'short'; });
    lines.push('### LONG candidates' + (tape === 'RISK_ON' ? ' (✅ tape aligned)' : tape === 'RISK_OFF' ? ' (⚠ counter-tape — risk-off)' : ' (mixed tape)'));
    longs.slice(0, 8).forEach(function(s) {
      lines.push('- **' + s.ticker + '** · ' + (s.type || 'setup') +
                 ' · entry ' + (s.trigger != null ? '$' + s.trigger : '?') +
                 ' · stop ' + (s.stop != null ? '$' + s.stop : '?') +
                 ' · TP1 ' + (s.tp1 != null ? '$' + s.tp1 : '?') +
                 ' · conv ' + s.conviction +
                 (s.source ? ' [' + s.source + ']' : ''));
    });
    lines.push('### SHORT candidates' + (tape === 'RISK_OFF' ? ' (✅ tape aligned)' : ' (only fire if tape RISK_OFF or sector lagging)'));
    shorts.slice(0, 8).forEach(function(s) {
      lines.push('- **' + s.ticker + '** · ' + (s.type || 'setup') +
                 ' · entry ' + (s.trigger != null ? '$' + s.trigger : '?') +
                 ' · stop ' + (s.stop != null ? '$' + s.stop : '?') +
                 ' · TP1 ' + (s.tp1 != null ? '$' + s.tp1 : '?') +
                 ' · conv ' + s.conviction +
                 (s.source ? ' [' + s.source + ']' : ''));
    });
  }
  lines.push('');

  // JS scan top
  if (jsScan && (jsScan.ready || []).length) {
    lines.push('## JS pattern scan ready (' + jsScan.ready.length + ')');
    jsScan.ready.slice(0, 5).forEach(function(s) {
      lines.push('- ' + s.ticker + ' ' + (s.pattern || '?') + ' · ' + (s.tf || '?') + (s.trigger != null ? ' · trig $' + s.trigger : ''));
    });
    lines.push('');
  }

  // WP scan top
  if (wpScan && (wpScan.ready || wpScan.topPicks || []).length) {
    var wpReady = wpScan.ready || wpScan.topPicks || [];
    lines.push('## WP scan ready (' + wpReady.length + ')');
    wpReady.slice(0, 5).forEach(function(s) {
      lines.push('- ' + s.ticker + (s.score != null ? ' score ' + s.score : '') + (s.trigger != null ? ' · trig $' + s.trigger : '') + (s.pattern ? ' · ' + s.pattern : ''));
    });
    lines.push('');
  }

  // V-Bottom
  if (vBot && vBot.candidates && vBot.candidates.length) {
    lines.push('## V-Bottom candidates');
    vBot.candidates.slice(0, 3).forEach(function(c) {
      lines.push('- ' + c.ticker + ' (' + c.tier + ', score ' + c.totalScore + ') · spot $' + c.spot);
    });
    lines.push('');
  }

  // Risk reminders
  lines.push('## Reminders');
  lines.push('- 9:45 hard gate — no fires before 9:45 AM ET');
  lines.push('- 2:00 PM time stop on any losing position');
  lines.push('- Earnings blocklist live — verify before fire');
  if (marketCtx && marketCtx.tape === 'RISK_OFF') {
    lines.push('- ⚠ RISK_OFF tape — longs need extra confluence; shorts aligned');
  }
  if (marketCtx && marketCtx.tape === 'MIXED') {
    lines.push('- ⚠ MIXED tape — chop, 6/6 clean setups only, smaller size');
  }
  lines.push('');

  lines.push('---');
  lines.push('_Auto-generated by Flow Scout · Phase 4.25 Daily Backtest + Morning Brief_');

  var markdown = lines.join('\n');

  // Save MD
  var mdPath = path.join(DATA_ROOT, 'morning_brief_' + date + '.md');
  try { fs.writeFileSync(mdPath, markdown); } catch (e) {}

  return {
    date: date,
    yesterdayDate: yDate,
    markdown: markdown,
    yesterdayRecap: yRecap,
    marketContext: marketCtx,
    setupRadar: setupRadar,
    jsScan: jsScan,
    wpScan: wpScan,
    vBottom: vBot,
    savedTo: mdPath,
  };
}

function loadMorningBrief(date) {
  date = date || todayET();
  var p = path.join(DATA_ROOT, 'morning_brief_' + date + '.md');
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// Helper — call internal endpoints by hitting localhost:PORT (server is up).
async function fetchInternalEndpoint(p) {
  try {
    var port = process.env.PORT || 3000;
    var url = 'http://127.0.0.1:' + port + p;
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { timeout: 8000 });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// DISCORD PUSH — daily recap card
// ---------------------------------------------------------------------------

async function pushDailyRecapToDiscord(recap) {
  if (!dp) return { ok: false, error: 'discordPush not loaded' };
  var d = recap || {};
  var fields = [];

  // UOA breakdown
  fields.push({
    name: '🌊 UOA alerts',
    value: 'Total: **' + (d.uoa ? d.uoa.total : 0) + '** · ' +
           'Bullflow custom: ' + (d.uoa ? d.uoa.bySource.bullflow_custom : 0) +
           ' · algo: ' + (d.uoa ? d.uoa.bySource.bullflow_algo : 0) +
           ' · TV: ' + (d.uoa ? d.uoa.bySource.tv : 0) +
           (d.uoa && d.uoa.johnPosts ? ' · John posts: ' + d.uoa.johnPosts : ''),
    inline: false,
  });

  // Top tickers by $
  if (d.uoa && d.uoa.topTickers && d.uoa.topTickers.length) {
    var topLine = d.uoa.topTickers.slice(0, 5).map(function(t) {
      return t.ticker + ' ' + fmtDollar(t.premium);
    }).join(' · ');
    fields.push({ name: '💰 Top tickers by $', value: topLine, inline: false });
  }

  // SIM fires breakdown
  var sim = d.simFires || {};
  var firesText = sim.count === 0 ? 'No fires today.' :
    sim.count + ' fires → ' + (sim.wins || 0) + 'W / ' + (sim.losses || 0) + 'L / ' +
    (sim.breakevens || 0) + 'BE / ' + (sim.open || 0) + ' open' +
    (sim.hitRatePct != null ? '  (' + sim.hitRatePct + '% hit rate)' : '');
  if (sim.topWinner) firesText += '\nTop W: ' + sim.topWinner.ticker + (sim.topWinner.pnl != null ? ' $' + Math.round(sim.topWinner.pnl) : '');
  if (sim.topLoser)  firesText += '\nTop L: ' + sim.topLoser.ticker  + (sim.topLoser.pnl  != null ? ' $' + Math.round(sim.topLoser.pnl)  : '');
  fields.push({ name: '🎯 SIM fires', value: firesText, inline: false });

  // Conviction calibration
  if (d.convictionCalibration && d.convictionCalibration.verdict) {
    fields.push({
      name: '🧠 Conviction calibration',
      value: d.convictionCalibration.verdict,
      inline: false,
    });
  }

  // Vision accuracy
  if (d.visionAccuracy && d.visionAccuracy.approve.fired > 0) {
    var v = d.visionAccuracy;
    fields.push({
      name: '👁 Vision verdict accuracy',
      value: 'APPROVE fired ' + v.approve.fired + ' → ' + v.approve.win + 'W/' + v.approve.loss + 'L · VETO blocked ' + v.veto.count,
      inline: false,
    });
  }

  // Patterns + didn't fire
  if (d.patterns) {
    var didNot = d.patterns.didNotFire || [];
    var didNotLine = didNot.length === 0 ? '—' : didNot.slice(0, 5).map(function(s) {
      return s.ticker + ' ' + (s.direction || '?') + ' (conv ' + (s.conviction || '?') + ')';
    }).join(' · ');
    fields.push({
      name: '⏸ Qualifying but did NOT fire',
      value: didNotLine + (didNot.length > 5 ? '  · +' + (didNot.length - 5) + ' more' : ''),
      inline: false,
    });
  }

  // Whales
  if (d.uoa && d.uoa.whaleAlerts && d.uoa.whaleAlerts.length) {
    fields.push({
      name: '🐋 Whales ($1M+)',
      value: d.uoa.whaleAlerts.slice(0, 5).map(function(w) {
        return w.ticker + ' ' + (w.direction || '?') + ' ' + fmtDollar(w.premium) + (w.custom ? ' (custom)' : '');
      }).join('\n'),
      inline: false,
    });
  }

  var embed = {
    username: 'Flow Scout — Daily Flow Recap',
    embeds: [{
      title: '📈 DAILY FLOW RECAP — ' + fmtDate(d.date || todayET()),
      description: (d.executiveSummary || []).join('\n'),
      color: 5763719,
      fields: fields,
      footer: { text: 'Flow Scout · Phase 4.25 Daily Backtest · /api/daily-flow-recap?date=' + d.date },
      timestamp: new Date().toISOString(),
    }],
  };

  return await dp.send('dailyFlowRecap', embed, { webhook: DISCORD_WEBHOOK });
}

// ---------------------------------------------------------------------------
// DISCORD PUSH — morning brief card
// ---------------------------------------------------------------------------

async function pushMorningBriefToDiscord(brief) {
  if (!dp) return { ok: false, error: 'discordPush not loaded' };
  var d = brief || {};
  var fields = [];

  var mc = d.marketContext || {};
  fields.push({
    name: '📡 Tape now',
    value: mc.ok ? (mc.verdict + '\n' + mc.summary) : '_market-context unavailable_',
    inline: false,
  });

  // Yesterday
  if (d.yesterdayRecap) {
    var y = d.yesterdayRecap;
    var ySimText = (y.simFires && y.simFires.count > 0)
      ? y.simFires.count + ' fires · ' + (y.simFires.wins || 0) + 'W/' + (y.simFires.losses || 0) + 'L'
      : 'no fires';
    fields.push({
      name: '📅 Yesterday (' + fmtDate(d.yesterdayDate) + ')',
      value: 'UOA: ' + (y.uoa ? y.uoa.total : 0) + ' · SIM: ' + ySimText +
             (y.simFires && y.simFires.topWinner ? '\nTop W: ' + y.simFires.topWinner.ticker : '') +
             (y.simFires && y.simFires.topLoser  ? ' · Top L: ' + y.simFires.topLoser.ticker  : ''),
      inline: false,
    });
  }

  // Today's high-conv setups
  var ready = (d.setupRadar && d.setupRadar.ready) || [];
  ready.sort(function(a, b) { return (b.conviction || 0) - (a.conviction || 0); });
  var hi = ready.filter(function(s) { return (s.conviction || 0) >= 8; }).slice(0, 6);
  if (hi.length) {
    var hiText = hi.map(function(s) {
      return (String(s.direction).toLowerCase() === 'long' ? '🟢' : '🔴') + ' ' + s.ticker +
             ' ' + (s.type || '?') + ' · trig ' + (s.trigger != null ? '$' + s.trigger : '?') +
             ' · conv ' + s.conviction;
    }).join('\n');
    fields.push({ name: "🎯 Today's high-conv (>= 8)", value: hiText, inline: false });
  } else {
    fields.push({
      name: "🎯 Today's high-conv (>= 8)",
      value: '_No conv >= 8 candidates yet — pre-market scanners may not have run_',
      inline: false,
    });
  }

  fields.push({
    name: '📋 Reminders',
    value: '9:45 hard gate · earnings blocklist live · 2 PM time stop · /morning-brief for full plan',
    inline: false,
  });

  var embed = {
    username: 'Flow Scout — Morning Brief',
    embeds: [{
      title: '☀️ MORNING BRIEF — ' + fmtDate(d.date || todayET()),
      description: 'Pre-market plan based on yesterday\'s tape + today\'s pre-bell scanners.',
      color: 16753920,
      fields: fields,
      footer: { text: 'Flow Scout · Phase 4.25 · /api/morning-brief?date=' + d.date },
      timestamp: new Date().toISOString(),
    }],
  };

  return await dp.send('morningBrief', embed, { webhook: DISCORD_WEBHOOK });
}

// ---------------------------------------------------------------------------
// HTML render — for the /morning-brief route (lightweight, no deps)
// ---------------------------------------------------------------------------

function renderMorningBriefHtml(date, markdown) {
  var d = date || todayET();
  var safeMd = (markdown || '_no brief generated yet for ' + d + '_').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>Morning Brief — ' + d + '</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:780px;margin:24px auto;padding:0 20px;background:#0d1117;color:#e6edf3;line-height:1.55}',
    'pre{background:#161b22;border:1px solid #30363d;padding:16px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:14px}',
    'header{border-bottom:1px solid #30363d;padding-bottom:12px;margin-bottom:18px}',
    'a{color:#58a6ff}',
    '.meta{color:#7d8590;font-size:13px}',
    '</style></head><body>',
    '<header><h1 style="margin:0">☀️ Morning Brief — ' + d + '</h1>',
    '<div class="meta">Flow Scout · Phase 4.25 · <a href="/api/morning-brief?date=' + d + '">JSON</a> · <a href="/api/daily-flow-recap?date=' + d + '">Yesterday recap JSON</a></div>',
    '</header>',
    '<pre>' + safeMd + '</pre>',
    '</body></html>',
  ].join('\n');
}

module.exports = {
  runDailyBacktest: runDailyBacktest,
  loadRecap: loadRecap,
  buildMorningBrief: buildMorningBrief,
  loadMorningBrief: loadMorningBrief,
  pushDailyRecapToDiscord: pushDailyRecapToDiscord,
  pushMorningBriefToDiscord: pushMorningBriefToDiscord,
  renderMorningBriefHtml: renderMorningBriefHtml,
  todayET: todayET,
  lastTradingDay: lastTradingDay,
};
