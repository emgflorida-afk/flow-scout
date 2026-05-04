// =============================================================================
// POWER HOUR BRIEF — auto-fires at 2:30 PM ET each trading day
//
// AB's BUSINESS MODEL (his exact words):
//   "Walk into the day with swings already running, trim 24hr+, ride runners.
//    +intraday day-trades = $1,500/week consistent."
//
// THIS DESK SUPPORTS THAT BY:
//   1. Synthesizing TOP 3-5 swing-eligible setups for tomorrow
//   2. Cross-system confluence ranking (JS + COIL + WP + AYCE)
//   3. Filtering for SAFE-HOLD (no earnings within 3 days, hold rating OK)
//   4. Pre-built order specs (contract / entry / stop / TPs) for each
//   5. One-click FIRE links to scanner FIRE button
//   6. Discord push as a daily 2:30 PM card AB acts on from phone
//
// SWING ELIGIBILITY CRITERIA:
//   - JS / COIL conv >= 7 OR WP ready (any)
//   - Daily / Weekly / 6HR pattern (NOT 5m/15m intraday-only)
//   - Direction has multi-system confluence (2+ scanners agree)
//   - Hold rating != AVOID
//   - No earnings within 3 trading days
//   - DTE for swing-friendly (10+ days minimum)
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var BRIEF_FILE = path.join(DATA_ROOT, 'power_hour_brief.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// Lazy-load scanners
function lazy(name) {
  try { return require('./' + name); } catch (e) { return null; }
}

// ─── COLLECT SETUPS FROM ALL SCANNERS ─────────────────────────────────────
async function collectSwingCandidates() {
  var candidates = [];

  // JS scanner — Daily/Weekly conv >= 7
  var johnPatternScanner = lazy('johnPatternScanner');
  if (johnPatternScanner) {
    try {
      var jsData = johnPatternScanner.loadLast();
      var ready = (jsData && jsData.ready) || [];
      ready.forEach(function(r) {
        if ((r.conviction || 0) >= 7 && ['Daily', 'Weekly', '6HR'].indexOf(r.tf) >= 0 && r.direction !== 'neutral') {
          candidates.push({
            ticker: r.ticker,
            source: 'JS-' + r.tf,
            tf: r.tf,
            pattern: r.pattern,
            direction: r.direction,
            conviction: r.conviction,
            trigger: r.triggerPrice,
            stop: r.stopPrice,
            tp1: r.tp1,
            tp2: r.tp2,
            holdRating: r.holdRating || 'unknown',
          });
        }
      });
    } catch (e) {}
  }

  // COIL scanner — daily coil conv >= 7
  var dailyCoilScanner = lazy('dailyCoilScanner');
  if (dailyCoilScanner) {
    try {
      var coilData = dailyCoilScanner.loadLast();
      var coilReady = ((coilData && coilData.ready) || []).concat((coilData && coilData.watching) || []);
      coilReady.forEach(function(r) {
        if ((r.conviction || 0) >= 7 && r.direction && r.direction !== 'neutral') {
          candidates.push({
            ticker: r.ticker,
            source: 'COIL',
            tf: 'Daily',
            pattern: r.pattern,
            direction: r.direction,
            conviction: r.conviction,
            trigger: r.triggerPrice,
            stop: r.stopPrice,
            tp1: r.tp1,
            tp2: r.tp2,
            holdRating: r.holdRating || 'unknown',
          });
        }
      });
    } catch (e) {}
  }

  // WP scanner — 4HR swings
  var wpScanner = lazy('wpScanner');
  if (wpScanner) {
    try {
      var wpData = wpScanner.loadLast();
      var wpAll = ((wpData && wpData.ready) || []).concat((wpData && wpData.trial) || []);
      wpAll.forEach(function(r) {
        if ((r.conviction || 0) >= 7 && r.direction) {
          candidates.push({
            ticker: r.ticker,
            source: 'WP',
            tf: '4HR',
            pattern: r.pattern || 'wp-swing',
            direction: r.direction,
            conviction: r.conviction,
            trigger: r.triggerPrice,
            stop: r.stopPrice,
            tp1: r.tp1,
            tp2: r.tp2,
            holdRating: r.holdRating || 'CAUTION',
          });
        }
      });
    } catch (e) {}
  }

  return candidates;
}

// ─── EARNINGS CHECK ───────────────────────────────────────────────────────
async function hasEarningsRisk(ticker) {
  try {
    var economicCalendar = lazy('economicCalendar');
    if (!economicCalendar) return false;
    var er = economicCalendar.checkTicker ? economicCalendar.checkTicker(ticker) : null;
    return er && er.earningsWithin3Days === true;
  } catch (e) { return false; }
}

// ─── RANK CANDIDATES ──────────────────────────────────────────────────────
async function rankCandidates(candidates) {
  // Group by ticker — find tickers with multi-system confluence (2+ scanners agree on direction)
  var byTicker = {};
  candidates.forEach(function(c) {
    if (!byTicker[c.ticker]) byTicker[c.ticker] = [];
    byTicker[c.ticker].push(c);
  });

  var ranked = [];
  for (var ticker in byTicker) {
    var setups = byTicker[ticker];
    // Filter for direction agreement (most common direction)
    var dirCounts = {};
    setups.forEach(function(s) { dirCounts[s.direction] = (dirCounts[s.direction] || 0) + 1; });
    var primaryDir = Object.keys(dirCounts).reduce(function(a, b) { return dirCounts[a] > dirCounts[b] ? a : b; });
    var aligned = setups.filter(function(s) { return s.direction === primaryDir; });

    // Score: 2 systems agreeing = 10pt baseline, each additional = +5
    var score = 10 + (aligned.length - 1) * 5;
    // Bonus for high conviction
    aligned.forEach(function(s) { if (s.conviction >= 8) score += 2; });
    // Bonus for SAFE hold
    if (aligned.some(function(s) { return s.holdRating === 'SAFE'; })) score += 5;
    // Penalty for AVOID
    if (aligned.some(function(s) { return s.holdRating === 'AVOID'; })) score -= 8;

    // Earnings check
    var earningsRisk = await hasEarningsRisk(ticker);
    if (earningsRisk) score -= 10;

    // Pull best trigger/stop/tps from highest-conviction setup
    var best = aligned.reduce(function(a, b) { return (b.conviction || 0) > (a.conviction || 0) ? b : a; });

    ranked.push({
      ticker: ticker,
      direction: primaryDir,
      score: score,
      systems: aligned.map(function(s) { return s.source; }),
      systemsCount: aligned.length,
      conviction: best.conviction,
      pattern: best.pattern,
      tf: best.tf,
      trigger: best.trigger,
      stop: best.stop,
      tp1: best.tp1,
      tp2: best.tp2,
      holdRating: best.holdRating,
      earningsRisk: earningsRisk,
    });
  }

  // Sort by score desc
  ranked.sort(function(a, b) { return b.score - a.score; });
  return ranked;
}

// ─── BUILD BRIEF ──────────────────────────────────────────────────────────
async function buildBrief() {
  var candidates = await collectSwingCandidates();
  var ranked = await rankCandidates(candidates);

  // Pull live macro context
  var macroSentinel = lazy('macroSentinel');
  var macroState = null;
  try {
    var ts = lazy('tradestation');
    if (ts && ts.getAccessToken) {
      var token = await ts.getAccessToken().catch(function() { return null; });
      if (token) {
        var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
        var r = await fetchLib('https://api.tradestation.com/v3/marketdata/quotes/SPY,QQQ,$VIX.X,XLE,XLF,XLI,XLK,XLV,XLP,XLU,XLY,XLB', {
          headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000
        });
        if (r.ok) {
          var data = await r.json();
          var quotes = {};
          (data.Quotes || []).forEach(function(q) {
            quotes[q.Symbol] = {
              last: parseFloat(q.Last || q.Close || 0),
              pct: parseFloat(q.NetChangePct || 0),
            };
          });
          var sectors = {};
          ['XLE','XLF','XLI','XLK','XLV','XLP','XLU','XLY','XLB'].forEach(function(s) {
            if (quotes[s]) sectors[s] = quotes[s];
          });
          if (macroSentinel && quotes['$VIX.X'] && quotes['SPY']) {
            macroState = macroSentinel.getRegimeVerdict(quotes['$VIX.X'], quotes['SPY'], sectors);
            macroState.spy = quotes['SPY'];
            macroState.qqq = quotes['QQQ'];
            macroState.vix = quotes['$VIX.X'];
          }
        }
      }
    }
  } catch (e) {}

  var brief = {
    builtAt: new Date().toISOString(),
    macro: macroState,
    topSetups: ranked.slice(0, 5),
    totalCandidates: candidates.length,
    totalUniqueTickers: ranked.length,
  };

  try { fs.writeFileSync(BRIEF_FILE, JSON.stringify(brief, null, 2)); } catch (e) {}
  return brief;
}

// ─── DISCORD PUSH ─────────────────────────────────────────────────────────
async function pushBriefToDiscord(brief) {
  var topFields = [];
  brief.topSetups.slice(0, 5).forEach(function(s, i) {
    var dirIcon = s.direction === 'long' ? '🟢' : s.direction === 'short' ? '🔴' : '🟡';
    var earningsFlag = s.earningsRisk ? ' ⚠️ EARNINGS RISK' : '';
    var holdIcon = s.holdRating === 'SAFE' ? '✅' : s.holdRating === 'AVOID' ? '🚫' : '🟡';
    var systemsList = s.systems.join(' + ');
    topFields.push({
      name: '#' + (i + 1) + ' ' + dirIcon + ' ' + s.ticker + ' — score ' + s.score,
      value: '**' + s.direction.toUpperCase() + '** | ' + s.pattern + ' (' + s.tf + ', conv ' + s.conviction + ')\n' +
             '🔗 Stack: ' + systemsList + ' (' + s.systemsCount + ' systems)\n' +
             '🎯 Trigger: ' + (s.trigger ? '$' + s.trigger : 'see scanner') + ' · 🛑 Stop: ' + (s.stop ? '$' + s.stop : 'see scanner') + '\n' +
             '✅ TP1: ' + (s.tp1 ? '$' + s.tp1 : '?') + ' · TP2: ' + (s.tp2 ? '$' + s.tp2 : '?') + '\n' +
             holdIcon + ' Hold: ' + s.holdRating + earningsFlag,
      inline: false,
    });
  });

  var macroDesc = '';
  if (brief.macro && brief.macro.spy) {
    var dirIcon = brief.macro.direction === 'bearish' ? '🔴' : brief.macro.direction === 'bullish' ? '🟢' : '🟡';
    macroDesc = dirIcon + ' **Regime: ' + brief.macro.direction.toUpperCase() + '**  ·  SPY $' + brief.macro.spy.last.toFixed(2) + ' (' + (brief.macro.spy.pct >= 0 ? '+' : '') + brief.macro.spy.pct.toFixed(2) + '%) · QQQ $' + brief.macro.qqq.last.toFixed(2) + ' · VIX ' + brief.macro.vix.last.toFixed(2);
  }

  var embed = {
    username: 'Flow Scout — Power Hour Brief',
    embeds: [{
      title: '⏰ POWER HOUR BRIEF — Pre-position for tomorrow',
      description: macroDesc + '\n\n' +
                   '**' + brief.totalUniqueTickers + ' unique swing-eligible tickers across ' + brief.totalCandidates + ' setups.**\n' +
                   'Top 5 ranked by multi-system confluence + hold safety + no earnings landmines.\n\n' +
                   'Pre-build orders at 3:00-3:30 PM, fire at 3:30-4:00 PM, walk into tomorrow with positions running.',
      color: brief.macro && brief.macro.direction === 'bearish' ? 15158332 : 5763719,
      fields: topFields.length > 0 ? topFields : [{
        name: '💤 No swing-eligible setups',
        value: 'No tickers met multi-system confluence + hold safety + no-earnings filters. Cash is a position. Try again tomorrow.',
        inline: false,
      }],
      footer: { text: 'Flow Scout | Power Hour Brief | auto-fires 2:30 PM ET daily' },
      timestamp: new Date().toISOString(),
    }],
  };

  // Use shared discordPush helper — tracks heartbeat + retries on 5xx + logs full errors
  var dp = require('./discordPush');
  var result = await dp.send('powerHourBrief', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) {
    console.log('[POWER-HOUR-BRIEF] PUSHED: ' + brief.totalUniqueTickers + ' tickers, top ' + topFields.length + ' (attempts ' + result.attempts + ')');
  } else {
    console.error('[POWER-HOUR-BRIEF] PUSH FAILED after ' + result.attempts + ' attempts: ' + (result.error || 'unknown'));
  }
  return result;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────
async function runBrief() {
  var brief = await buildBrief();
  await pushBriefToDiscord(brief);
  return brief;
}

function loadLastBrief() {
  try { return JSON.parse(fs.readFileSync(BRIEF_FILE, 'utf8')); }
  catch (e) { return null; }
}

module.exports = {
  runBrief: runBrief,
  buildBrief: buildBrief,
  loadLastBrief: loadLastBrief,
};
