// weeklyTracker.js -- Stratum v7.6
// -----------------------------------------------------------------
// Bill-Paying Mode weekly P&L state machine.
// Goal: $2,500/week. Hard stop: -$750/week.
//
// States:
//   AHEAD    -- weekly P&L >= WEEKLY_GOAL. No new entries. Ride runners only.
//   ON_PACE  -- on track for goal by Friday. Normal sizing.
//   BEHIND   -- under pace but not in the red past danger. Normal sizing, focus A+.
//   DANGER   -- -$500 to -$750. Only A+ setups fire. Max 2 concurrent positions.
//   STOP     -- <= WEEKLY_STOP. Queue frozen. Manage existing only.
//
// All 5 scouts (JSmith, Casey, WP, Strat, Spread) must call
// shouldAllowNewEntry(grade) BEFORE pushing to the queue.
// Order executor must call recordFill(pnl) on every closed position.
// -----------------------------------------------------------------

var fs = require('fs');
var fetch = require('node-fetch');

var WEEKLY_GOAL_BASE = parseFloat(process.env.WEEKLY_GOAL || '2500');
var WEEKLY_STOP = parseFloat(process.env.WEEKLY_STOP || '-750');
var DANGER_FLOOR = parseFloat(process.env.WEEKLY_DANGER || '-500');
// Deficit carry: on missed week, next week absorbs half the shortfall,
// capped at +$1000 added (max effective goal = $3500). Prevents tilt.
var DEFICIT_CARRY_PCT = parseFloat(process.env.DEFICIT_CARRY_PCT || '0.5');
var DEFICIT_CARRY_MAX = parseFloat(process.env.DEFICIT_CARRY_MAX || '1000');
var WEEKLY_GOAL = WEEKLY_GOAL_BASE;

var STATE_FILE = '/tmp/weekly_state.json';

var state = {
  weekStart: '',      // YYYY-MM-DD of Monday
  weekEnd: '',        // YYYY-MM-DD of Friday
  totalPnL: 0,
  fills: [],          // [{ticker, pnl, source, time}]
  status: 'ON_PACE',
  goalHit: false,
  stopHit: false,
  effectiveGoal: WEEKLY_GOAL_BASE,  // may be bumped by deficit carry
  carryFromPrior: 0,                 // dollars of deficit carried in
};

// -----------------------------------------------------------------
// Week boundary helpers -- Monday 9:30 ET to Friday 4:00 PM ET
// -----------------------------------------------------------------
function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function mondayOfThisWeek() {
  var d = etNow();
  var day = d.getDay(); // 0=Sun..6=Sat
  var offset = day === 0 ? -6 : 1 - day; // back up to Monday
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fridayOfThisWeek() {
  var m = mondayOfThisWeek();
  m.setDate(m.getDate() + 4);
  return m;
}
function isoDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// -----------------------------------------------------------------
// Persistence -- /tmp plus optional env bootstrap for redeploys
// -----------------------------------------------------------------
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw && raw.weekStart) state = raw;
      return;
    }
    if (process.env.WEEKLY_STATE_JSON) {
      var boot = JSON.parse(process.env.WEEKLY_STATE_JSON);
      if (boot && boot.weekStart) state = boot;
    }
  } catch (e) {
    console.error('[WEEKLY] load error:', e.message);
  }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch (e) { console.error('[WEEKLY] save error:', e.message); }
}
loadState();

// -----------------------------------------------------------------
// Week rollover -- if we cross into a new week, reset
// -----------------------------------------------------------------
function resetIfNewWeek() {
  var ws = isoDate(mondayOfThisWeek());
  if (state.weekStart !== ws) {
    // Compute deficit carry from prior week
    var priorPnL = state.totalPnL || 0;
    var priorGoal = state.effectiveGoal || WEEKLY_GOAL_BASE;
    var carry = 0;
    if (state.weekStart && priorPnL < priorGoal) {
      var shortfall = priorGoal - priorPnL;
      carry = Math.min(DEFICIT_CARRY_MAX, shortfall * DEFICIT_CARRY_PCT);
      // Don't carry if last week was a blowup (-$500+ loss). Wipe it clean.
      if (priorPnL <= DANGER_FLOOR) {
        console.log('[WEEKLY] Prior week blowup ($' + priorPnL.toFixed(2) + '). Wiping deficit, fresh start.');
        carry = 0;
      }
    }
    var newGoal = WEEKLY_GOAL_BASE + carry;
    WEEKLY_GOAL = newGoal;
    console.log('[WEEKLY] New week reset -- prior P&L: $' + priorPnL.toFixed(2) +
                ' | carry: $' + carry.toFixed(0) +
                ' | new goal: $' + newGoal.toFixed(0));
    state = {
      weekStart: ws,
      weekEnd: isoDate(fridayOfThisWeek()),
      totalPnL: 0,
      fills: [],
      status: 'ON_PACE',
      goalHit: false,
      stopHit: false,
      effectiveGoal: newGoal,
      carryFromPrior: carry,
    };
    saveState();
  } else if (state.effectiveGoal) {
    // Keep module-level WEEKLY_GOAL synced with persisted state
    WEEKLY_GOAL = state.effectiveGoal;
  }
}

// -----------------------------------------------------------------
// Compute status from P&L + day-of-week pace
// -----------------------------------------------------------------
function recomputeStatus() {
  if (state.totalPnL >= WEEKLY_GOAL) {
    state.goalHit = true;
    state.status = 'AHEAD';
    return;
  }
  if (state.totalPnL <= WEEKLY_STOP) {
    state.stopHit = true;
    state.status = 'STOP';
    return;
  }
  if (state.totalPnL <= DANGER_FLOOR) {
    state.status = 'DANGER';
    return;
  }
  // Pace check -- by EOD of each trading day we want pnl >= goal * (dayIdx/5)
  var day = etNow().getDay(); // 1=Mon..5=Fri
  var dayIdx = Math.max(1, Math.min(5, day));
  var paceTarget = WEEKLY_GOAL * (dayIdx / 5);
  state.status = state.totalPnL >= paceTarget ? 'ON_PACE' : 'BEHIND';
}

// -----------------------------------------------------------------
// Public: record a closed fill
// -----------------------------------------------------------------
function recordFill(ticker, pnl, source) {
  resetIfNewWeek();
  var t = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
  });
  state.fills.push({
    ticker: ticker || '?',
    pnl: parseFloat(pnl) || 0,
    source: source || 'unknown',
    time: t,
  });
  state.totalPnL += parseFloat(pnl) || 0;
  recomputeStatus();
  saveState();
  console.log('[WEEKLY] ' + ticker + ' ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) +
              ' -> weekly $' + state.totalPnL.toFixed(2) + ' [' + state.status + ']');
  return state;
}

// -----------------------------------------------------------------
// Public: gate for scouts to check before queueing
// grade is optional (e.g. 'A+', 'A', 'B')
// -----------------------------------------------------------------
function shouldAllowNewEntry(grade) {
  resetIfNewWeek();
  recomputeStatus();
  if (state.status === 'STOP') {
    return { allow: false, reason: 'Weekly STOP hit ($' + state.totalPnL.toFixed(2) + '). Queue frozen.' };
  }
  if (state.status === 'AHEAD') {
    return { allow: false, reason: 'Weekly goal hit ($' + state.totalPnL.toFixed(2) + '). No new entries -- ride runners.' };
  }
  if (state.status === 'DANGER') {
    if (grade && /^A\+?$/.test(grade)) {
      return { allow: true, reason: 'DANGER state -- A+ only, proceed' };
    }
    return { allow: false, reason: 'DANGER state ($' + state.totalPnL.toFixed(2) + '). Only A+ fires.' };
  }
  return { allow: true, reason: state.status };
}

function getState() {
  resetIfNewWeek();
  recomputeStatus();
  return state;
}

// -----------------------------------------------------------------
// Discord summary -- called Friday 4:05 PM + on demand
// -----------------------------------------------------------------
function formatWeeklyBar() {
  var pct = Math.max(-100, Math.min(100, Math.round((state.totalPnL / WEEKLY_GOAL) * 100)));
  var filled = Math.max(0, Math.round(Math.abs(pct) / 10));
  var bar = '';
  for (var i = 0; i < 10; i++) bar += (i < filled ? '#' : '-');
  return '[' + bar + '] ' + pct + '%';
}

async function postWeeklySummary() {
  resetIfNewWeek();
  recomputeStatus();
  var webhook = process.env.DISCORD_GOAL_WEBHOOK || process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
  if (!webhook) return;
  var lines = [
    'WEEKLY P&L TRACKER -- Bill-Paying Mode',
    state.weekStart + '  ->  ' + state.weekEnd,
    '================================',
    'Goal      $' + WEEKLY_GOAL.toFixed(0) + '/week',
    'P&L       ' + (state.totalPnL >= 0 ? '+' : '') + '$' + state.totalPnL.toFixed(2),
    'Bar       ' + formatWeeklyBar(),
    'Status    ' + state.status,
    'Fills     ' + state.fills.length,
    '--------------------------------',
  ];
  if (state.fills.length) {
    lines.push('FILL LOG:');
    state.fills.forEach(function (f) {
      lines.push('  ' + f.time + '  ' + f.ticker + '  ' +
        (f.pnl >= 0 ? '+' : '') + '$' + f.pnl.toFixed(2) + '  (' + f.source + ')');
    });
    lines.push('--------------------------------');
  }
  if (state.goalHit) lines.push('GOAL HIT -- ride runners only');
  else if (state.stopHit) lines.push('WEEKLY STOP HIT -- freeze new entries');
  else lines.push('Remaining to goal: $' + Math.max(0, WEEKLY_GOAL - state.totalPnL).toFixed(2));

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Stratum Weekly Tracker',
        content: '```\n' + lines.join('\n') + '\n```',
      }),
    });
  } catch (e) {
    console.error('[WEEKLY] post error:', e.message);
  }
}

module.exports = {
  recordFill: recordFill,
  shouldAllowNewEntry: shouldAllowNewEntry,
  getState: getState,
  postWeeklySummary: postWeeklySummary,
  formatWeeklyBar: formatWeeklyBar,
  WEEKLY_GOAL: WEEKLY_GOAL,
  WEEKLY_STOP: WEEKLY_STOP,
};
