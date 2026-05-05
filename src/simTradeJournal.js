// =============================================================================
// SIM TRADE JOURNAL — Phase 4.24 (May 5 2026)
//
// Closes the journaling gap for the SIM auto-trader. Until today, SIM fires
// were logged in `sim_auto_state.json` but exits were NEVER tracked — so AB
// could not answer "did any open positions get stopped out today?". This
// module gives every SIM fire a full lifecycle: openPosition → mark-to-market
// updates → closePosition → win-rate stats + EOD recap.
//
// PERSISTENCE:
//   /data/sim_trade_journal.json
//   {
//     activePositions: [ <position> ],
//     closed: { '2026-05-05': [ <closedPosition> ], ... }
//   }
//
// POSITION SHAPE:
//   {
//     id, ticker, direction ('long'|'short'),
//     contractSymbol, entryPrice, entrySpot, entryTimestamp,
//     conviction, source,
//     currentPrice, currentSpot, pnlPct, pnlDollar,
//     exitPrice (null if open), exitSpot, exitTimestamp,
//     exitReason ('STOP'|'TP1'|'TP2'|'TIME'|'EOD'|'MANUAL'),
//     bracketTracker: { tp1Hit, stopHit, timeStopHit }
//   }
// =============================================================================

var fs = require('fs');
var path = require('path');

// Phase 4.26 — time-stop classifier
var tsr = null;
try { tsr = require('./timeStopRules'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var JOURNAL_FILE = path.join(DATA_ROOT, 'sim_trade_journal.json');

// Default journal scaffold
function emptyJournal() {
  return {
    activePositions: [],
    closed: {},
  };
}

function loadJournal() {
  try {
    var raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
    var j = JSON.parse(raw);
    if (!j.activePositions) j.activePositions = [];
    if (!j.closed) j.closed = {};
    return j;
  } catch (e) {
    return emptyJournal();
  }
}

function saveJournal(j) {
  try {
    // Make sure DATA_ROOT exists
    if (!fs.existsSync(DATA_ROOT)) {
      try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch (e) {}
    }
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2));
  } catch (e) {
    console.error('[SIM-JOURNAL] save failed:', e.message);
  }
}

function todayET() {
  var now = new Date();
  var et = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  var parts = et.split('/');
  var m = parts[0], d = parts[1], y = parts[2];
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function dateETFromTimestamp(iso) {
  try {
    var d = new Date(iso);
    var et = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    var parts = et.split('/');
    var m = parts[0], dd = parts[1], y = parts[2];
    return y + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  } catch (e) {
    return todayET();
  }
}

function genId(ticker) {
  return ticker + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Compute % change from entry (positive = profit on long, negative = loss)
// Direction matters only for the underlying spot interpretation (not for option premium).
// Long calls: entry $1.00 → current $1.50 = +50% (good).
// Short puts: entry $1.00 → current $1.50 = +50% (good — for buying protection).
// For ICS we BUY puts on shorts and BUY calls on longs, so option price up = profit
// regardless of direction.
function computePnlPct(entryPrice, currentPrice) {
  if (!entryPrice || entryPrice <= 0 || currentPrice == null) return null;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

// =============================================================================
// PUBLIC API
// =============================================================================

// Append a new active position
function openPosition(args) {
  args = args || {};
  if (!args.ticker || !args.direction || !args.contractSymbol || !args.entryPrice) {
    return { ok: false, error: 'missing required fields (ticker/direction/contractSymbol/entryPrice)' };
  }
  var j = loadJournal();
  var existing = j.activePositions.find(function(p) {
    return p.contractSymbol === args.contractSymbol;
  });
  if (existing) {
    return { ok: false, error: 'position already open for ' + args.contractSymbol, position: existing };
  }
  var pos = {
    id: args.id || genId(args.ticker),
    ticker: args.ticker,
    direction: args.direction,
    contractSymbol: args.contractSymbol,
    entryPrice: parseFloat(args.entryPrice),
    entrySpot: args.entrySpot != null ? parseFloat(args.entrySpot) : null,
    entryTimestamp: args.entryTimestamp || new Date().toISOString(),
    conviction: args.conviction || null,
    source: args.source || null,
    contracts: args.contracts || args.qty || 1,
    structuralStop: args.structuralStop != null ? parseFloat(args.structuralStop) : null,
    currentPrice: parseFloat(args.entryPrice),
    currentSpot: args.entrySpot != null ? parseFloat(args.entrySpot) : null,
    pnlPct: 0,
    pnlDollar: 0,
    exitPrice: null,
    exitSpot: null,
    exitTimestamp: null,
    exitReason: null,
    bracketTracker: {
      tp1Hit: false,
      tp2Hit: false,
      stopHit: false,
      timeStopHit: false,
      lastChecked: null,
    },
    // Phase 4.26 — time-stop fields
    tradeType: null,
    timeStopExitBy: null,
    timeStopWarningAt: null,
  };

  // Phase 4.26 — classify trade type, compute exitBy/warningAt
  if (tsr) {
    try {
      pos.tradeType = String(args.tradeType || tsr.classifyTradeType({
        source: args.source,
        dte: args.dte,
        conviction: args.conviction,
        pattern: args.pattern,
        entryPremium: pos.entryPrice,
      }) || 'SWING').toUpperCase();
      var rule = tsr.getRule(pos.tradeType);
      var firedTime = new Date(pos.entryTimestamp);
      pos.timeStopExitBy = new Date(firedTime.getTime() + rule.maxHoldMinutes * 60 * 1000).toISOString();
      pos.timeStopWarningAt = new Date(firedTime.getTime() + rule.warningAt * 60 * 1000).toISOString();
    } catch (e) { console.error('[SIM-JOURNAL] timeStopRules classify error:', e.message); }
  }

  j.activePositions.push(pos);
  saveJournal(j);
  console.log('[SIM-JOURNAL] OPEN ' + pos.ticker + ' ' + pos.direction + ' ' + pos.contractSymbol + ' @ $' + pos.entryPrice +
              (pos.tradeType ? ' [' + pos.tradeType + ' exitBy=' + pos.timeStopExitBy + ']' : ''));
  return { ok: true, position: pos };
}

// Phase 4.26 — check ALL active SIM positions for time-stop expiry. Returns
// list of positions that should be auto-closed via 'TIME' exitReason.
//
// Caller (cron in server.js) is responsible for invoking closePosition() with
// the right exitPrice (currentPrice from mark-to-market). We just return the
// list here so the cron has a chance to fetch fresh prices first.
function checkTimeStops() {
  if (!tsr) return { ok: false, error: 'timeStopRules not loaded', exits: [], warns: [] };
  var j = loadJournal();
  var exits = [];
  var warns = [];
  var now = new Date();
  j.activePositions.forEach(function(p) {
    if (!p.tradeType || !p.entryTimestamp) return;
    var enf = tsr.shouldEnforce({
      tradeType: p.tradeType,
      firedAt: p.entryTimestamp,
      entryPrice: p.entryPrice,
    }, now, p.currentPrice);
    if (enf.action === 'EXIT' && !p.bracketTracker.timeStopHit) {
      exits.push({ position: p, enforce: enf });
    } else if (enf.action === 'WARN' && !p._timeStopWarned) {
      warns.push({ position: p, enforce: enf });
    }
  });
  return { ok: true, exits: exits, warns: warns };
}

// Mark a position as time-stop-warned so we only push WARN once
function markTimeStopWarned(contractSymbol) {
  var j = loadJournal();
  var p = j.activePositions.find(function(x) { return x.contractSymbol === contractSymbol; });
  if (!p) return { ok: false, error: 'no position' };
  p._timeStopWarned = true;
  saveJournal(j);
  return { ok: true };
}

// Update mark-to-market for an active position (called by 5-min cron)
function updateMark(contractSymbol, currentPrice, currentSpot) {
  var j = loadJournal();
  var pos = j.activePositions.find(function(p) { return p.contractSymbol === contractSymbol; });
  if (!pos) return { ok: false, error: 'no active position for ' + contractSymbol };
  if (currentPrice != null) {
    pos.currentPrice = parseFloat(currentPrice);
    pos.pnlPct = computePnlPct(pos.entryPrice, pos.currentPrice);
    // option price * 100 * contracts = dollar P&L
    pos.pnlDollar = (pos.currentPrice - pos.entryPrice) * 100 * (pos.contracts || 1);
  }
  if (currentSpot != null) {
    pos.currentSpot = parseFloat(currentSpot);
  }
  pos.bracketTracker.lastChecked = new Date().toISOString();
  saveJournal(j);
  return { ok: true, position: pos };
}

// Close a position — moves from active to closed
function closePosition(contractSymbol, args) {
  args = args || {};
  var j = loadJournal();
  var idx = j.activePositions.findIndex(function(p) { return p.contractSymbol === contractSymbol; });
  if (idx < 0) {
    // Try matching by ticker as fallback (legacy path — closes any open for the ticker)
    if (args.ticker) {
      idx = j.activePositions.findIndex(function(p) { return p.ticker === args.ticker; });
    }
    if (idx < 0) return { ok: false, error: 'no active position for ' + contractSymbol };
  }
  var pos = j.activePositions[idx];

  pos.exitPrice = args.exitPrice != null ? parseFloat(args.exitPrice) : pos.currentPrice;
  pos.exitSpot = args.exitSpot != null ? parseFloat(args.exitSpot) : pos.currentSpot;
  pos.exitTimestamp = args.exitTimestamp || new Date().toISOString();
  pos.exitReason = args.exitReason || 'MANUAL';

  // Final P&L compute
  if (pos.exitPrice != null && pos.entryPrice > 0) {
    pos.pnlPct = computePnlPct(pos.entryPrice, pos.exitPrice);
    pos.pnlDollar = (pos.exitPrice - pos.entryPrice) * 100 * (pos.contracts || 1);
  }

  // Categorize for win-rate
  // Wins: pnlPct > +5
  // Losses: pnlPct < -5
  // Flat: between -5 and +5
  pos.outcome = pos.pnlPct > 5 ? 'win' : (pos.pnlPct < -5 ? 'loss' : 'flat');

  // Move to closed bucket keyed by date of exit
  var dateKey = dateETFromTimestamp(pos.exitTimestamp);
  if (!j.closed[dateKey]) j.closed[dateKey] = [];
  j.closed[dateKey].push(pos);

  // Remove from active
  j.activePositions.splice(idx, 1);
  saveJournal(j);

  console.log('[SIM-JOURNAL] CLOSE ' + pos.ticker + ' ' + pos.contractSymbol + ' ' + pos.exitReason +
              ' ' + (pos.pnlPct != null ? pos.pnlPct.toFixed(1) + '%' : '?') +
              ' ($' + (pos.pnlDollar != null ? pos.pnlDollar.toFixed(0) : '?') + ')');

  return { ok: true, position: pos };
}

function getActivePositions() {
  var j = loadJournal();
  return j.activePositions.slice();
}

function getClosedPositions(date) {
  var j = loadJournal();
  if (!date) {
    // Return all closed positions across all dates (flattened)
    var all = [];
    Object.keys(j.closed).forEach(function(d) {
      (j.closed[d] || []).forEach(function(p) { all.push(p); });
    });
    return all;
  }
  return (j.closed[date] || []).slice();
}

function getClosedByDateRange(daysBack) {
  daysBack = daysBack || 30;
  var j = loadJournal();
  var cutoff = Date.now() - (daysBack * 86400 * 1000);
  var out = [];
  Object.keys(j.closed).forEach(function(dateKey) {
    var ms = new Date(dateKey).getTime();
    if (isNaN(ms)) return;
    if (ms < cutoff) return;
    (j.closed[dateKey] || []).forEach(function(p) { out.push(p); });
  });
  return out;
}

// Compute win rate over the last N days
function computeWinRate(daysBack) {
  daysBack = daysBack || 30;
  var positions = getClosedByDateRange(daysBack);
  var wins = 0, losses = 0, flat = 0;
  var winPctSum = 0, lossPctSum = 0;
  positions.forEach(function(p) {
    if (p.outcome === 'win') { wins++; winPctSum += p.pnlPct || 0; }
    else if (p.outcome === 'loss') { losses++; lossPctSum += p.pnlPct || 0; }
    else { flat++; }
  });
  var total = wins + losses + flat;
  var decisive = wins + losses;
  return {
    daysBack: daysBack,
    total: total,
    wins: wins,
    losses: losses,
    flat: flat,
    winRatePct: decisive > 0 ? (wins / decisive) * 100 : 0,
    avgWinPct: wins > 0 ? winPctSum / wins : 0,
    avgLossPct: losses > 0 ? lossPctSum / losses : 0,
  };
}

// Pull a snapshot of full journal for /api/sim-auto/journal
function getJournalSnapshot(daysBack) {
  daysBack = daysBack || 30;
  var active = getActivePositions();
  var closed = getClosedByDateRange(daysBack);
  var stats = computeWinRate(daysBack);
  return {
    daysBack: daysBack,
    activeCount: active.length,
    closedCount: closed.length,
    activePositions: active,
    closedPositions: closed,
    stats: stats,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  openPosition: openPosition,
  closePosition: closePosition,
  updateMark: updateMark,
  getActivePositions: getActivePositions,
  getClosedPositions: getClosedPositions,
  getClosedByDateRange: getClosedByDateRange,
  computeWinRate: computeWinRate,
  getJournalSnapshot: getJournalSnapshot,
  // Phase 4.26 — time-stop helpers
  checkTimeStops: checkTimeStops,
  markTimeStopWarned: markTimeStopWarned,
  // exposed for cron / introspection
  loadJournal: loadJournal,
  saveJournal: saveJournal,
  todayET: todayET,
};
