// =============================================================================
// ICS MORNING BRIEF — 8:30 AM ET auto-publisher.
//
// PURPOSE: Wake AB up to a Discord card showing tonight's qualifying ICS setups
// + reminders from yesterday's journal. He reviews on phone, queues conditionals
// in Titan with one tap (paste the ticket text), system fires on triggers.
//
// READS:
//   - /data/journal/strategy_state.md (rolling agent personality file)
//   - /data/journal/{yesterday}.md (yesterday's lessons)
//   - simAutoTrader.collectQualifyingSetups() (tonight's qualifiers)
//   - tradeTracker.getStats() (lifetime track record)
//
// WRITES:
//   Discord card with:
//   - Today's qualifying ICS setups (table: ticker / dir / source / conv / trigger)
//   - Lifetime track record + validation phase
//   - Yesterday's lessons / open positions to manage
//   - Pre-built Titan conditional ticket text per setup (copy-paste ready)
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var JOURNAL_DIR = path.join(DATA_ROOT, 'journal');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var simAutoTrader = null;
try { simAutoTrader = require('./simAutoTrader'); } catch (e) {}
var tradeTracker = null;
try { tradeTracker = require('./tradeTracker'); } catch (e) {}

// Bullflow alignment lookup — reads /data/backtest/*.json for recent flow
// data on each setup's ticker. Tells us if institutional flow ALIGNS with
// the setup direction. Per AB: 'lining up makes sense'.
var BACKTEST_DIR_BRIEF = path.join(DATA_ROOT, 'backtest');
function getBullflowAlignment(ticker, direction) {
  try {
    if (!fs.existsSync(BACKTEST_DIR_BRIEF)) return null;
    var files = fs.readdirSync(BACKTEST_DIR_BRIEF).filter(function(f) { return f.endsWith('.json'); }).sort().reverse();
    var totals = { calls: 0, puts: 0, premium: 0, days: 0 };
    var daysCounted = 0;
    for (var i = 0; i < files.length && daysCounted < 5; i++) {
      try {
        var d = JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR_BRIEF, files[i]), 'utf8'));
        if (d.status !== 'done' || !d.stats) continue;
        var byTicker = d.stats.byTicker || {};
        var t = byTicker[ticker.toUpperCase()];
        if (t) {
          totals.calls += (t.calls || 0);
          totals.puts += (t.puts || 0);
          totals.premium += (t.totalPremium || 0);
          totals.days++;
        }
        daysCounted++;
      } catch (e) {}
    }
    if (totals.days === 0) return null;
    var totalAlerts = totals.calls + totals.puts;
    if (totalAlerts === 0) return { alignment: 'no-flow', daysCovered: daysCounted, alerts: 0 };
    var pctCalls = totals.calls / totalAlerts;
    var bullishFlow = pctCalls >= 0.6;
    var bearishFlow = pctCalls <= 0.4;
    var aligned = (direction === 'long' && bullishFlow) || (direction === 'short' && bearishFlow);
    var contradicts = (direction === 'long' && bearishFlow) || (direction === 'short' && bullishFlow);
    return {
      alignment: aligned ? 'ALIGNED' : contradicts ? 'CONTRADICTS' : 'MIXED',
      pctCalls: Math.round(pctCalls * 100),
      pctPuts: Math.round((1 - pctCalls) * 100),
      totalAlerts: totalAlerts,
      premiumK: Math.round(totals.premium / 1000),
      daysCovered: totals.days,
    };
  } catch (e) {
    console.error('[ICS-MORNING] alignment lookup error:', e.message);
    return null;
  }
}

function todayET() {
  var et = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, d, y] = et.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
}

function yesterdayET() {
  var d = new Date(Date.now() - 24 * 3600 * 1000);
  var et = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, day, y] = et.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + day.padStart(2, '0');
}

function loadStrategyState() {
  try { return fs.readFileSync(path.join(JOURNAL_DIR, 'strategy_state.md'), 'utf8'); }
  catch (e) { return null; }
}

function loadYesterdayJournal() {
  try { return fs.readFileSync(path.join(JOURNAL_DIR, yesterdayET() + '.md'), 'utf8'); }
  catch (e) { return null; }
}

// Parse open positions from yesterday's journal
function extractOpenPositions(journalText) {
  if (!journalText) return [];
  var match = journalText.match(/## Open positions carrying overnight[\s\S]*?(?=\n##|$)/);
  if (!match) return [];
  var lines = match[0].split('\n').filter(function(l) { return l.trim().startsWith('- '); });
  return lines;
}

// Build pre-formatted Titan conditional ticket text for a setup
function buildTitanTicket(setup) {
  var dir = setup.direction;
  var trig = setup.trigger;
  var stop = setup.stop;
  var op = dir === 'long' ? 'Above' : 'Below';
  var triggerPx = dir === 'long' ? (trig + 0.20) : (trig - 0.20);

  var optDir = dir === 'long' ? 'CALL' : 'PUT';
  var size = (setup.conviction >= 9 && setup.systems && setup.systems.length >= 2) ? 3 : 2;

  return [
    'TITAN CONDITIONAL ORDER:',
    '  Activation: ' + setup.ticker + ' ' + op + ' $' + triggerPx.toFixed(2) + ' (Double Trade Tick Within BBO)',
    '  Action: BUY +' + size + ' ' + setup.ticker + ' [resolve ATM ' + optDir + '] @ MARKET',
    '  Bracket OCO:',
    '    Stop: -25% premium STP / -30% LMT',
    '    TP1: +50% premium · exit 1ct same-day',
    '    TP2: +100% premium · exit rest next-day or trail',
    '  Stock invalidate: $' + (stop ? stop.toFixed(2) : '?'),
    '  Time stop: 2 PM next trading day if not in profit',
  ].join('\n');
}

// Build the morning brief Discord card
async function buildBrief() {
  var qualifying = [];
  if (simAutoTrader && simAutoTrader.collectQualifyingSetups) {
    try { qualifying = simAutoTrader.collectQualifyingSetups(); } catch (e) {
      console.error('[ICS-MORNING] qualifier error:', e.message);
    }
  }

  // Sort by conviction desc, then by source priority (multi-system bonus)
  qualifying.sort(function(a, b) {
    return (b.conviction || 0) - (a.conviction || 0);
  });
  // Cap top 5 for the morning card
  var top = qualifying.slice(0, 5);

  var stats = tradeTracker && tradeTracker.getStats ? tradeTracker.getStats() : null;
  var openPositions = extractOpenPositions(loadYesterdayJournal());

  // Build Discord embed
  // Infer TF from source — surfaces the timeframe so AB doesn't compare
  // 4HR/6HR/Weekly patterns against his daily chart and get confused.
  function inferTF(source) {
    if (!source) return '?';
    if (source.indexOf('Weekly') >= 0) return 'Weekly';
    if (source.indexOf('Daily') >= 0) return 'Daily';
    if (source.indexOf('6HR') >= 0) return '6HR';
    if (source.indexOf('4HR') >= 0) return '4HR';
    if (source.indexOf('AYCE') >= 0) return '12HR/4HR (AYCE)';
    if (source.indexOf('WP') >= 0) return '4HR';        // WP scanner is 4HR primary
    if (source.indexOf('COIL') >= 0) return 'Daily';     // COIL scanner default
    return '?';
  }

  var topFields = top.map(function(s, i) {
    var dirIcon = s.direction === 'long' ? '🟢' : '🔴';
    var convIcon = s.conviction >= 9 ? '🚀' : '🔥';
    var tf = inferTF(s.source);

    // Bullflow alignment from recent backtest data
    var bf = getBullflowAlignment(s.ticker, s.direction);
    var bfLine = '';
    if (bf && bf.alignment) {
      var bfIcon = bf.alignment === 'ALIGNED' ? '✅' : bf.alignment === 'CONTRADICTS' ? '❌' : bf.alignment === 'MIXED' ? '🟡' : '⚫';
      if (bf.alignment === 'no-flow') {
        bfLine = '**Bullflow**: ⚫ no recent institutional flow on ' + s.ticker + '\n';
      } else {
        bfLine = '**Bullflow**: ' + bfIcon + ' ' + bf.alignment + ' · ' + bf.totalAlerts + ' alerts (' + bf.pctCalls + '%C/' + bf.pctPuts + '%P) · $' + bf.premiumK + 'K premium · ' + bf.daysCovered + 'd window\n';
      }
    }

    return {
      name: convIcon + ' #' + (i + 1) + ' ' + dirIcon + ' ' + s.ticker + ' — conv ' + s.conviction + ' · ' + (s.source || '?') + ' · ⏱️ ' + tf,
      value: '**Direction**: ' + (s.direction || '?').toUpperCase() +
             ' · **Trigger**: $' + (s.trigger ? s.trigger.toFixed(2) : '?') +
             ' · **Stop**: $' + (s.stop ? s.stop.toFixed(2) : '?') + '\n' +
             '**Pattern**: ' + (s.pattern || '?') + ' on **' + tf + '** · **Hold**: ' + (s.holdRating || '?') + '\n' +
             bfLine +
             '*To verify pattern: open chart on ' + tf + ' timeframe (not daily)*\n' +
             '```\n' + buildTitanTicket(s).slice(0, 600) + '\n```',
      inline: false,
    };
  });

  if (top.length === 0) {
    topFields.push({
      name: '💤 No qualifying setups this morning',
      value: 'No tickers passing conv ≥ 8 + Hold SAFE + no earnings filters. Cash is a position. Check scanner manually for borderline setups.',
      inline: false,
    });
  }

  var lifetimeBlock = '';
  if (stats && stats.totalTrades) {
    var phase = stats.totalTrades >= 90 ? '✅ VALIDATED' :
                stats.totalTrades >= 60 ? 'solid signal' :
                stats.totalTrades >= 30 ? 'first read' : 'early';
    lifetimeBlock = stats.totalTrades + ' trades · ' +
                    (stats.winRate ? (stats.winRate * 100).toFixed(1) : '?') + '% win · ' +
                    (stats.avgR || '?') + 'R · ' + phase;
  } else {
    lifetimeBlock = 'No trades logged yet. Ready for first SIM fire.';
  }

  var openBlock = openPositions.length > 0
    ? openPositions.slice(0, 5).join('\n').slice(0, 500)
    : 'No paper positions carrying overnight.';

  var embed = {
    username: 'Flow Scout — ICS Morning Brief',
    embeds: [{
      title: '🌅 ICS Morning Brief · ' + todayET(),
      description: 'Tonight\'s qualifying ICS setups + open positions. Triggers fire intraday.\n\n**Track record**: ' + lifetimeBlock,
      color: 5763719,
      fields: [
        ...topFields,
        {
          name: '📂 Open positions to manage today',
          value: openBlock,
          inline: false,
        },
        {
          name: '⏰ ICS playbook reminder',
          value: '• Triggers fire intraday on prior-day H/L break\n' +
                 '• Auto-fires SIM 9:45 AM-3:30 PM (if SIM_AUTO_ENABLED=true)\n' +
                 '• TP1 +50% → exit 1ct same-day · TP2 +100% next-day\n' +
                 '• 2 PM next-day time stop · -25% premium / structural override',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | ICS Morning Brief | 8:30 AM ET daily' },
      timestamp: new Date().toISOString(),
    }],
  };

  return { embed: embed, qualifying: qualifying, openPositions: openPositions, stats: stats };
}

async function pushBrief() {
  var brief = await buildBrief();
  var dp = require('./discordPush');
  var result = await dp.send('icsMorningBrief', brief.embed, { webhook: DISCORD_WEBHOOK });
  return Object.assign({ pushResult: result }, brief);
}

module.exports = {
  pushBrief: pushBrief,
  buildBrief: buildBrief,
};
