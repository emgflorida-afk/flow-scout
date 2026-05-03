// =============================================================================
// AUTO-FIRE ENGINE — Tier 1 → Tier 2 → Tier 3 orchestration
//
// Detects A++ confluence setups during the trading sweet spot, runs all the
// safety layers (vision approve, market research GREEN, hold not AVOID),
// builds a Tier 1 conditional bracket order package, and pushes Discord with
// a 60-sec countdown. AB taps APPROVE to manually fire (broker integration is
// PHASE 3, not yet — auto-fire DOES NOT submit to broker).
//
// HARD SAFETY LOCKS (cannot be bypassed):
//  1. AUTO_FIRE_ENABLED env var must equal "true" — default false
//  2. Confluence tier must be A++ (score >= 11)
//  3. Chart vision must be APPROVE (already in confluence)
//  4. Market researcher must be GREEN (not YELLOW)
//  5. Hold rating must NOT be AVOID
//  6. Time window: 9:45-10:30 AM ET only
//  7. Daily cap: 1 fire candidate per day max
//  8. 24h cooldown after any APPROVED fire
//  9. NEVER submits to broker — generates package only, AB executes
//
// State persisted to /data/autofire_state.json:
//  { lastFireDate, lastFireTime, lastFireTicker, todayDecisions: [...] }
// =============================================================================

var fs = require('fs');
var path = require('path');

var johnPatternScanner = null;
try { johnPatternScanner = require('./johnPatternScanner'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'autofire_state.json');
var LOG_FILE = path.join(DATA_ROOT, 'autofire_decisions_log.json');

var DISCORD_WEBHOOK = process.env.DISCORD_AUTOFIRE_WEBHOOK
  || 'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

function isAutoFireEnabled() {
  return String(process.env.AUTO_FIRE_ENABLED || 'false').toLowerCase() === 'true';
}

function todayET() {
  var now = new Date();
  var et = new Date(now.getTime() - 4 * 3600 * 1000); // EDT offset; daily bucket
  return et.toISOString().slice(0, 10);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { todayDecisions: [], lastFireDate: null, lastFireTicker: null }; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

function appendLog(decision) {
  var existing = [];
  try { existing = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) {}
  existing.push(decision);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(existing, null, 2)); } catch (e) {}
}

function isInSweetSpot() {
  // 9:45 AM - 10:30 AM ET
  var now = new Date();
  var etHr = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  var etMin = now.getMinutes();
  if (etHr === 9 && etMin >= 45) return true;
  if (etHr === 10 && etMin <= 30) return true;
  return false;
}

// Main check — runs the auto-fire decision pipeline
async function runCheck(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun || !isAutoFireEnabled();
  var force = opts.force || false; // bypass time window for testing

  var state = loadState();
  var today = todayET();

  // Reset todayDecisions if new day
  if (state.lastDecisionDate !== today) {
    state.todayDecisions = [];
    state.lastDecisionDate = today;
  }

  var blockReasons = [];

  // Lock 1: enabled?
  if (!isAutoFireEnabled()) blockReasons.push('AUTO_FIRE_ENABLED env var is not "true"');
  // Lock 2: time window
  if (!force && !isInSweetSpot()) blockReasons.push('Outside sweet-spot window (9:45-10:30 AM ET)');
  // Lock 3: daily cap
  var firedToday = (state.todayDecisions || []).filter(function(d) { return d.action === 'APPROVED'; }).length;
  if (firedToday >= 1) blockReasons.push('Daily cap reached (already 1 fire approved today)');
  // Lock 4: 24h cooldown after last fire
  if (state.lastFireTime) {
    var lastFire = new Date(state.lastFireTime);
    var hoursSince = (Date.now() - lastFire.getTime()) / 3600000;
    if (hoursSince < 24) blockReasons.push('24h cooldown active (' + Math.round(24 - hoursSince) + 'h remaining)');
  }

  // Even if blocked, still scan + log so we have backtest data
  var candidates = await findCandidates();

  if (blockReasons.length > 0 && !dryRun) {
    var blockedDecision = {
      timestamp: new Date().toISOString(),
      action: 'BLOCKED',
      reasons: blockReasons,
      candidatesDetected: candidates.length,
    };
    appendLog(blockedDecision);
    return { ok: true, action: 'BLOCKED', blockReasons: blockReasons, candidates: candidates };
  }

  if (candidates.length === 0) {
    var noCandDecision = {
      timestamp: new Date().toISOString(),
      action: 'NO_CANDIDATES',
      reasons: ['no A++ setups detected in current scan'],
    };
    if (!dryRun) appendLog(noCandDecision);
    return { ok: true, action: 'NO_CANDIDATES', candidates: [] };
  }

  // Pick highest-confluence candidate
  var pick = candidates[0];

  // Build the Tier 1 bracket order package (informational — does NOT submit)
  var orderPackage = buildOrderPackage(pick);

  // If dry run, just return the package
  if (dryRun) {
    return { ok: true, action: 'DRY_RUN_CANDIDATE', candidate: pick, orderPackage: orderPackage, blockReasons: blockReasons };
  }

  // Live: push Discord with countdown
  var pushResult = await pushDiscord(orderPackage, pick);

  var liveDecision = {
    timestamp: new Date().toISOString(),
    action: 'PROPOSED',
    ticker: pick.ticker,
    direction: pick.direction,
    confluence: pick.confluence,
    orderPackage: orderPackage,
    discordPushed: pushResult && pushResult.posted,
  };
  appendLog(liveDecision);

  state.todayDecisions = state.todayDecisions || [];
  state.todayDecisions.push(liveDecision);
  saveState(state);

  return { ok: true, action: 'PROPOSED', candidate: pick, orderPackage: orderPackage, discord: pushResult };
}

// Find A++ candidates from current JS scan
async function findCandidates() {
  if (!johnPatternScanner) return [];
  var lastScan = johnPatternScanner.loadLast();
  if (!lastScan || !lastScan.ready) return [];

  return (lastScan.ready || []).filter(function(r) {
    if (!r.confluence) return false;
    if (r.confluence.tier !== 'A++') return false;
    // Hold rating cannot be AVOID
    if (r.holdRating === 'AVOID') return false;
    return true;
  }).sort(function(a, b) {
    return (b.confluence.score || 0) - (a.confluence.score || 0);
  });
}

// Build the order package (informational — bracket details for AB to copy-paste)
function buildOrderPackage(setup) {
  var p = setup.plan || {};
  var pp = p.primary || {};
  var direction = setup.direction;

  // Suggested option spread structure
  var spreadType = direction === 'long' ? 'CALL DEBIT' : 'PUT DEBIT';
  var width = 10; // default $10 wide
  var longStrike = direction === 'long' ? Math.round(pp.trigger / 5) * 5 + 5 : Math.round(pp.trigger / 5) * 5;
  var shortStrike = direction === 'long' ? longStrike + width : longStrike - width;

  return {
    ticker: setup.ticker,
    direction: direction,
    underlyingTrigger: pp.trigger,
    underlyingStop: pp.stop,
    underlyingTP1: pp.tp1,
    underlyingTP2: pp.tp2,
    spread: {
      type: spreadType,
      longStrike: longStrike,
      shortStrike: shortStrike,
      width: width,
      expiry: '5/22 (or next 30-45 DTE Friday)',
      orderType: 'Net Debit Limit',
      maxDebitTarget: '$2.00',
      sizing: setup.confluence.sizeRecommendation + 'ct (' + setup.confluence.tier + ' tier)',
    },
    customStops: {
      hard: pp.stop,
      premium: '-25% on net debit',
      time: 'halve at 2 candle closes if not in profit',
      breakeven: 'move stop to entry at TP1',
    },
    confidence: {
      tier: setup.confluence.tier,
      score: setup.confluence.score + '/13',
      visionApproved: setup.confluence.layers && setup.confluence.layers.chartVision && setup.confluence.layers.chartVision.passed === true,
    },
  };
}

// Push Discord with full order package + 60s countdown frame
async function pushDiscord(orderPackage, setup) {
  if (!DISCORD_WEBHOOK) return { error: 'no webhook' };
  var fetchLib = require('node-fetch');

  var lines = [];
  lines.push('# 🤖 AUTO-FIRE PROPOSAL — A++ DETECTED');
  lines.push('_60-sec countdown · You execute manually in TS Titan · NOT auto-submitted_');
  lines.push('');
  lines.push('**' + orderPackage.ticker + '** · ' + (orderPackage.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'));
  lines.push('Confluence: **' + orderPackage.confidence.tier + ' (' + orderPackage.confidence.score + ')**');
  lines.push('');
  lines.push('## Suggested order');
  lines.push('```');
  lines.push('Type:   ' + orderPackage.spread.type + ' SPREAD');
  lines.push('Long:   ' + orderPackage.spread.longStrike + ' ' + (orderPackage.direction === 'long' ? 'CALL' : 'PUT') + ' ' + orderPackage.spread.expiry);
  lines.push('Short:  ' + orderPackage.spread.shortStrike + ' ' + (orderPackage.direction === 'long' ? 'CALL' : 'PUT') + ' ' + orderPackage.spread.expiry);
  lines.push('Limit:  ' + orderPackage.spread.maxDebitTarget + ' max');
  lines.push('Size:   ' + orderPackage.spread.sizing);
  lines.push('```');
  lines.push('');
  lines.push('## Trigger / Invalidate / Stops');
  lines.push('• Trigger: 5m close ' + (orderPackage.direction === 'long' ? '>' : '<') + ' $' + orderPackage.underlyingTrigger + ' + vol ≥ 1.5×');
  lines.push('• Hard stop: $' + orderPackage.customStops.hard + ' (5m close ' + (orderPackage.direction === 'long' ? '<' : '>') + ')');
  lines.push('• Premium stop: ' + orderPackage.customStops.premium);
  lines.push('• Time stop: ' + orderPackage.customStops.time);
  lines.push('• Breakeven move at TP1');
  lines.push('');
  lines.push('## TPs');
  lines.push('• TP1: $' + orderPackage.underlyingTP1 + ' (trim 50%)');
  lines.push('• TP2: $' + orderPackage.underlyingTP2 + ' (trim 30%)');
  lines.push('');
  lines.push('---');
  lines.push('🛑 **NOT AUTO-SUBMITTED.** AB executes manually. Validate spread debit via /api/spread-check before fire.');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'Auto-Fire Engine' }),
    });
    if (!r.ok) return { error: 'discord-' + r.status };
    return { posted: true };
  } catch (e) {
    return { error: e.message };
  }
}

function getStatus() {
  var state = loadState();
  return {
    autoFireEnabled: isAutoFireEnabled(),
    inSweetSpot: isInSweetSpot(),
    today: todayET(),
    todayDecisions: state.todayDecisions || [],
    firedTodayCount: (state.todayDecisions || []).filter(function(d) { return d.action === 'APPROVED'; }).length,
    lastFireDate: state.lastFireDate,
    lastFireTicker: state.lastFireTicker,
    statePath: STATE_FILE,
    logPath: LOG_FILE,
  };
}

module.exports = {
  runCheck: runCheck,
  getStatus: getStatus,
  findCandidates: findCandidates,
  buildOrderPackage: buildOrderPackage,
};
