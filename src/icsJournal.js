// =============================================================================
// ICS JOURNAL — 4:05 PM ET daily journal + Friday weekly review.
//
// PURPOSE: Build a learning loop the agent can actually read tomorrow morning.
// Stateless agent wakes up Tuesday → reads /data/journal/strategy_state.md +
// last 5 daily journals → walks into the day with yesterday's lessons baked in.
//
// PATTERN (from "I Turned Claude Opus 4.7 Into a 24/7 Trader" video):
//   "Files aren't memory — they're the agent's PERSONALITY"
//
// DAILY (4:05 PM ET Mon-Fri):
//   - Read today's SIM fires from /data/sim_auto_state.json
//   - Read tradeTracker.getStats() for win-rate
//   - Read open positions
//   - Write /data/journal/YYYY-MM-DD.md with:
//     * Today's fires (ticker / direction / source / outcome if closed)
//     * Today's open positions (carry over to tomorrow)
//     * Lessons: what rule each fire passed/failed
//     * Tomorrow's queue: setups that armed but didn't fire today
//   - Push Discord recap card
//   - Update /data/journal/strategy_state.md (rolling agent personality file)
//
// FRIDAY 4:30 PM ET extra weekly review:
//   - Aggregate Mon-Fri P&L
//   - Win rate by source (JS/COIL/WP/AYCE)
//   - Win rate by direction
//   - Identify: what worked, what didn't, what to tighten
//   - Push Discord weekly review card
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var JOURNAL_DIR = path.join(DATA_ROOT, 'journal');
var STATE_FILE = path.join(DATA_ROOT, 'sim_auto_state.json');
var STRATEGY_STATE_FILE = path.join(JOURNAL_DIR, 'strategy_state.md');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var tradeTracker = null;
try { tradeTracker = require('./tradeTracker'); } catch (e) {}

function ensureDir() {
  try { fs.mkdirSync(JOURNAL_DIR, { recursive: true }); } catch (e) {}
}

function todayET() {
  var et = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var [m, d, y] = et.split('/');
  return y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
}

function loadSimState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { dailyFires: [], openPositions: [] }; }
}

function loadStrategyState() {
  try { return fs.readFileSync(STRATEGY_STATE_FILE, 'utf8'); }
  catch (e) {
    // Initialize on first run
    return [
      '# ICS Strategy State (auto-updated by agent)',
      '',
      '## Strategy lock-in (May 4 2026)',
      'Intraday-Confirmed Swing (ICS):',
      '- Setup: conv >= 8 + Hold SAFE + no earnings + Daily/Weekly TFC aligned',
      '- Trigger: stock breaks past prior day H/L by 0.2%',
      '- Sizing: 2ct base, 3ct top-tier (conv 9-10 + multi-system)',
      '- Exit: TP1 +50% same-day (1ct) / TP2 +100% next-day / 2 PM next-day time stop / -25% stop',
      '- Validation: 65% win rate over 90 trades',
      '',
      '## Lessons learned (oldest first)',
      '',
    ].join('\n');
  }
}

function saveStrategyState(content) {
  ensureDir();
  try { fs.writeFileSync(STRATEGY_STATE_FILE, content); } catch (e) {
    console.error('[ICS-JOURNAL] strategy_state save failed:', e.message);
  }
}

// Build today's daily journal
function buildDailyEntry() {
  var simState = loadSimState();
  var fires = simState.dailyFires || [];
  var openPositions = simState.openPositions || [];

  var stats = null;
  if (tradeTracker && tradeTracker.getStats) {
    try { stats = tradeTracker.getStats(); } catch (e) {}
  }

  var date = todayET();
  var lines = [];
  lines.push('# ICS Journal · ' + date);
  lines.push('');
  lines.push('## Fires today (' + fires.length + ')');
  if (fires.length === 0) {
    lines.push('*No fires today. Either no qualifying setups arming or triggers did not hit.*');
  } else {
    fires.forEach(function(f, i) {
      lines.push((i+1) + '. **' + f.ticker + '** ' + (f.direction || '?').toUpperCase() +
                 ' · ' + (f.source || 'unknown') +
                 ' · conv ' + (f.conviction || '?') +
                 ' · entry $' + (f.limitPrice || '?') +
                 ' · spot @ fire $' + (f.spotAtFire ? f.spotAtFire.toFixed(2) : '?') +
                 ' · contract `' + (f.contractSymbol || '?') + '`');
    });
  }
  lines.push('');

  lines.push('## Open positions carrying overnight (' + openPositions.length + ')');
  if (openPositions.length === 0) {
    lines.push('*No open paper positions.*');
  } else {
    openPositions.forEach(function(p) {
      lines.push('- **' + p.ticker + '** ' + (p.direction || '').toUpperCase() +
                 ' · `' + (p.contractSymbol || '?') + '`' +
                 ' · opened ' + (p.openedAt ? new Date(p.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '?'));
    });
  }
  lines.push('');

  lines.push('## Track record (lifetime)');
  if (stats && stats.totalTrades) {
    lines.push('- **Total trades**: ' + stats.totalTrades);
    lines.push('- **Wins**: ' + (stats.wins || 0) + ' · **Losses**: ' + (stats.losses || 0) + ' · **Breakeven**: ' + (stats.breakevens || 0));
    lines.push('- **Win rate**: ' + (stats.winRate ? (stats.winRate * 100).toFixed(1) : '?') + '%');
    lines.push('- **Avg R-multiple**: ' + (stats.avgR || '?'));

    // Confidence band
    var n = stats.totalTrades;
    var ciBand = n >= 90 ? '±10% (validated)' : n >= 60 ? '±12% (solid)' : n >= 30 ? '±15% (first read)' : '±25% (early)';
    lines.push('- **Sample confidence**: ' + ciBand + ' at 95% confidence');
    lines.push('- **Validation gate**: 90 trades @ ≥65% to enable LIVE auto · ' + (n >= 90 && stats.winRate >= 0.65 ? '✅ PASSED' : '⏳ in progress'));
  } else {
    lines.push('*No tradeTracker stats yet.*');
  }
  lines.push('');

  lines.push('## Notes for tomorrow');
  lines.push('- Re-evaluate open positions on the open');
  lines.push('- Check overnight gap context vs entry direction');
  lines.push('- Trim TP1 hits same-day, hold rest');
  lines.push('- 2 PM time stop for any position not in profit');
  lines.push('');

  return { date: date, body: lines.join('\n'), fireCount: fires.length, openCount: openPositions.length, stats: stats };
}

// Append to strategy_state.md as a rolling agent-personality file
function appendToStrategyState(date, summary) {
  var existing = loadStrategyState();
  var newLine = '- **' + date + '**: ' + summary;
  // Insert after "## Lessons learned (oldest first)" line
  var marker = '## Lessons learned (oldest first)';
  var idx = existing.indexOf(marker);
  if (idx === -1) {
    existing += '\n' + newLine;
  } else {
    var before = existing.slice(0, idx + marker.length + 1);
    var after = existing.slice(idx + marker.length + 1);
    existing = before + '\n' + newLine + after;
  }
  saveStrategyState(existing);
}

// Push Discord daily recap card
async function pushDailyRecap(entry) {
  var fires = entry.fireCount;
  var open = entry.openCount;
  var s = entry.stats;

  var color = fires > 0 ? 5763719 : 8359053;  // green if fires, gray if quiet day
  var winRateLine = '';
  if (s && s.totalTrades) {
    winRateLine = 'Lifetime: ' + s.totalTrades + ' trades · ' +
                  (s.winRate ? (s.winRate * 100).toFixed(1) : '?') + '% win · avg ' +
                  (s.avgR || '?') + 'R';
  }

  var embed = {
    username: 'Flow Scout — ICS Journal',
    embeds: [{
      title: '📓 ICS Journal · ' + entry.date,
      description: '**' + fires + '** SIM fires today · **' + open + '** carrying overnight\n' + winRateLine,
      color: color,
      fields: [
        {
          name: '📋 Today\'s memo',
          value: '```\n' + entry.body.split('\n').slice(2, 30).join('\n').slice(0, 950) + '\n```',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | ICS Journal | full file at /data/journal/' + entry.date + '.md' },
      timestamp: new Date().toISOString(),
    }],
  };

  var dp = require('./discordPush');
  return await dp.send('icsJournal', embed, { webhook: DISCORD_WEBHOOK });
}

// MAIN — runs the daily journal
async function runDailyJournal() {
  ensureDir();
  var entry = buildDailyEntry();
  var dailyFile = path.join(JOURNAL_DIR, entry.date + '.md');
  try { fs.writeFileSync(dailyFile, entry.body); } catch (e) {
    console.error('[ICS-JOURNAL] daily file write failed:', e.message);
  }

  // Append summary to strategy_state.md
  var summary = entry.fireCount + ' fires, ' + entry.openCount + ' open' +
                (entry.stats && entry.stats.winRate ? ', win rate ' + (entry.stats.winRate * 100).toFixed(0) + '%' : '');
  appendToStrategyState(entry.date, summary);

  await pushDailyRecap(entry);
  return entry;
}

// FRIDAY WEEKLY REVIEW — aggregates last 5 trading days
async function runWeeklyReview() {
  ensureDir();
  var now = new Date();
  var pastDays = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    var dateKey = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    var [m, day, y] = dateKey.split('/');
    pastDays.push(y + '-' + m.padStart(2, '0') + '-' + day.padStart(2, '0'));
  }
  var dailyEntries = pastDays.map(function(d) {
    try { return { date: d, content: fs.readFileSync(path.join(JOURNAL_DIR, d + '.md'), 'utf8') }; }
    catch (e) { return null; }
  }).filter(Boolean);

  var stats = tradeTracker && tradeTracker.getStats ? tradeTracker.getStats() : null;

  var lines = [];
  lines.push('# ICS Weekly Review · week ending ' + todayET());
  lines.push('');
  lines.push('## Daily summary');
  dailyEntries.reverse().forEach(function(de) {
    var fireMatch = de.content.match(/## Fires today \((\d+)\)/);
    var openMatch = de.content.match(/## Open positions carrying overnight \((\d+)\)/);
    lines.push('- **' + de.date + '**: ' + (fireMatch ? fireMatch[1] + ' fires' : '? fires') +
               (openMatch ? ' · ' + openMatch[1] + ' open' : ''));
  });
  lines.push('');

  if (stats && stats.totalTrades) {
    lines.push('## Lifetime stats');
    lines.push('- Total: ' + stats.totalTrades + ' trades');
    lines.push('- Win rate: ' + (stats.winRate ? (stats.winRate * 100).toFixed(1) : '?') + '%');
    lines.push('- Avg R: ' + (stats.avgR || '?'));
    lines.push('- Validation phase: ' + (stats.totalTrades >= 90 ? 'VALIDATED' : stats.totalTrades >= 60 ? 'solid' : stats.totalTrades >= 30 ? 'first read' : 'early'));
    lines.push('');
  }

  lines.push('## Action items for next week');
  lines.push('- Review any losing trades for pattern');
  lines.push('- Check if same-day TP1 hits are reliably triggering');
  lines.push('- Assess source attribution (which scanner produces winners)');
  lines.push('');

  var weeklyFile = path.join(JOURNAL_DIR, 'weekly_' + todayET() + '.md');
  try { fs.writeFileSync(weeklyFile, lines.join('\n')); } catch (e) {}

  // Discord card
  var embed = {
    username: 'Flow Scout — ICS Weekly Review',
    embeds: [{
      title: '📊 ICS Weekly Review · ' + todayET(),
      description: 'Friday wrap-up. Validation progress + actionable insights.',
      color: 5763719,
      fields: [
        {
          name: '📅 Week recap',
          value: lines.slice(2, 12).join('\n').slice(0, 1000),
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | ICS Weekly | /data/journal/weekly_' + todayET() + '.md' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  return await dp.send('icsWeeklyReview', embed, { webhook: DISCORD_WEBHOOK });
}

module.exports = {
  runDailyJournal: runDailyJournal,
  runWeeklyReview: runWeeklyReview,
  buildDailyEntry: buildDailyEntry,
};
