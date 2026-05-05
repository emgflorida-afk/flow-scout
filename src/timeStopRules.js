// =============================================================================
// PHASE 4.26 — TIME-STOP RULES per card type
//
// AB directive May 5 PM: "specific cards should stand need to exit by 60m
// after entry etc."
//
// PROBLEM: a DAY trade still flat after 60m IS a losing trade — theta + the
// thesis was "this moves now". A SWING with the same P&L is still fine —
// thesis is multi-day. The same flat-PnL meaning differs per card type.
// AB has been stuck in trades past their natural expiration window.
//
// SOLUTION: per-card-type time-stop rules. Compute exitBy + warningAt at
// position open. Phase 4.11 cron evaluates time-stop alongside structural
// stop. Time stop is SECONDARY — if structural stop fires first, that wins.
//
// CARD TYPES:
//   SCALP    — 30m hold, exit if not in profit. 0-3 DTE ATM. Smallest theta tolerance.
//   DAY      — 60m hold, exit if not in profit. 3-10 DTE ATM. Move-now thesis.
//   LOTTO    — 360m (6h) max, exit EOD. Cheap, accept high IV decay, often 1-3 DTE.
//   SWING    — 1440m (24h), exit 2 PM next day if not in profit. 20-45 DTE delta 0.35.
//   OVERNIGHT — 4320m (3 day), exit 3-day if not in profit. 30+ DTE multi-day hold.
//
// "IN PROFIT" = option premium ≥ entry × 1.05 (5%+ above entry)
//
// USAGE:
//   var tsr = require('./timeStopRules');
//   var trade = tsr.classifyTradeType({ dte: 7, source: 'live-mover', conviction: 8 });
//   var stop = tsr.computeTimeStop({ tradeType: 'DAY', firedAt: '2026-05-05T13:30:00Z' });
//   var action = tsr.shouldEnforce(position, new Date());
// =============================================================================

var TIME_STOP_RULES = {
  'SCALP':     { maxHoldMinutes: 30,   ifNotProfit: 'EXIT',             warningAt: 20,   label: 'SCALP', display: '🕐 30m SCALP' },
  'DAY':       { maxHoldMinutes: 60,   ifNotProfit: 'EXIT',             warningAt: 45,   label: 'DAY',   display: '🕐 60m DAY' },
  'LOTTO':     { maxHoldMinutes: 360,  ifNotProfit: 'EXIT',             warningAt: 240,  label: 'LOTTO', display: '🕐 6h LOTTO' },
  'SWING':     { maxHoldMinutes: 1440, ifNotProfit: 'EXIT_2PM_NEXTDAY', warningAt: 1080, label: 'SWING', display: '🕐 24h SWING' },
  'OVERNIGHT': { maxHoldMinutes: 4320, ifNotProfit: 'EXIT_3DAY',        warningAt: 2880, label: 'OVERNIGHT', display: '🕐 3d OVERNIGHT' },
};

var IN_PROFIT_THRESHOLD = 1.05;  // 5%+ above entry counts as "in profit"

function getRule(tradeType) {
  var key = String(tradeType || '').toUpperCase();
  return TIME_STOP_RULES[key] || TIME_STOP_RULES['DAY'];
}

// Classify a setup into a trade-type bucket based on DTE, source, conviction.
//   - SCALP:    very short DTE (≤2) AND scalp-source (live-mover/lotto-feed) AND
//               conviction ≥ 7
//   - DAY:      DTE 3-10 (default for live-mover/action tab cards)
//   - LOTTO:    explicit lotto source OR cheap (premium ≤ $1) with DTE ≤ 5
//   - SWING:    DTE 20-45 (the standard ICS hold)
//   - OVERNIGHT: DTE 30+ AND conviction A++ (multi-day swing on best-of-day setup)
//
// Default if uncertain: SWING (the safest assumption — it gives the most rope).
function classifyTradeType(setup) {
  setup = setup || {};
  var dte = parseInt(setup.dte || setup.daysToExpiry || 0, 10);
  var src = String(setup.source || '').toLowerCase();
  var pattern = String(setup.pattern || '').toLowerCase();
  var conv = parseFloat(setup.conviction || 0);
  var premium = parseFloat(setup.entryPremium || setup.limitPrice || 0);
  var explicit = String(setup.tradeType || setup.cardType || '').toUpperCase();

  // 1) Honor explicit type (caller knows best)
  if (explicit && TIME_STOP_RULES[explicit]) return explicit;

  // 2) LOTTO: explicit lotto source or very cheap short-dated contract
  if (src.indexOf('lotto') >= 0 || pattern.indexOf('lotto') >= 0) return 'LOTTO';
  if (premium > 0 && premium <= 1.00 && dte > 0 && dte <= 5) return 'LOTTO';

  // 3) SCALP: ultra-short DTE + scalp-style source
  if (dte > 0 && dte <= 2 && (src.indexOf('mover') >= 0 || src.indexOf('scalp') >= 0)) return 'SCALP';

  // 4) DAY: live-mover/action/intraday-radar cards default 3-10 DTE
  if (src.indexOf('mover') >= 0 || src.indexOf('action') >= 0 || src.indexOf('radar') >= 0) {
    if (dte > 0 && dte <= 10) return 'DAY';
    return 'DAY';
  }

  // 5) OVERNIGHT: multi-day swing on highest conviction
  if (dte >= 30 && conv >= 9) return 'OVERNIGHT';

  // 6) SWING: standard 20-45 DTE delta-0.35 ICS hold
  if (dte >= 14) return 'SWING';

  // 7) DAY fallback if nothing else fits and DTE is short
  if (dte > 0 && dte <= 10) return 'DAY';

  // 8) Default — SWING (most rope, safest default)
  return 'SWING';
}

// Compute the absolute exit-by + warning-at timestamps for a position.
//   position: { firedAt: ISO string OR openedAt OR entryTime, tradeType }
// Returns: { tradeType, exitBy, warningAt, action: 'HOLD'|'WARN'|'EXIT', minutesElapsed, minutesRemaining }
function computeTimeStop(position, currentTime) {
  position = position || {};
  var now = currentTime ? new Date(currentTime) : new Date();
  var firedStr = position.firedAt || position.openedAt || position.entryTime;
  if (!firedStr) {
    return { error: 'no firedAt/openedAt timestamp on position' };
  }
  var firedAt = new Date(firedStr);
  if (isNaN(firedAt.getTime())) {
    return { error: 'invalid firedAt timestamp: ' + firedStr };
  }
  var tradeType = String(position.tradeType || classifyTradeType(position) || 'SWING').toUpperCase();
  var rule = getRule(tradeType);
  var exitBy = new Date(firedAt.getTime() + rule.maxHoldMinutes * 60 * 1000);
  var warningAt = new Date(firedAt.getTime() + rule.warningAt * 60 * 1000);
  var elapsedMs = now.getTime() - firedAt.getTime();
  var elapsedMin = Math.floor(elapsedMs / 60000);
  var remainingMin = Math.floor((exitBy.getTime() - now.getTime()) / 60000);
  return {
    tradeType: tradeType,
    rule: rule,
    firedAt: firedAt.toISOString(),
    exitBy: exitBy.toISOString(),
    warningAt: warningAt.toISOString(),
    minutesElapsed: elapsedMin,
    minutesRemaining: remainingMin,
  };
}

// "In profit" = option premium ≥ entry × 1.05 (5%+ above entry).
// Returns true if the position is currently in profit by that definition.
function isInProfit(position, currentPremium) {
  if (currentPremium == null) return false;
  var entry = parseFloat(position.entryPremium || position.entryPrice || position.limitPrice || 0);
  if (!entry || entry <= 0) return false;
  return parseFloat(currentPremium) >= entry * IN_PROFIT_THRESHOLD;
}

// Decide what action to take for a position right now.
// Returns one of:
//   { action: 'HOLD' }              — under warning threshold OR in profit (let winners run)
//   { action: 'WARN' }              — past warningAt but not yet at exitBy
//   { action: 'EXIT', reason: ... } — past exitBy AND not in profit (TIME STOP HIT)
//
// IMPORTANT: time stop is SECONDARY to structural stop. Caller handles
// "structural stop already triggered" path; this only handles time logic.
function shouldEnforce(position, currentTime, currentPremium) {
  var stop = computeTimeStop(position, currentTime);
  if (stop.error) return { action: 'HOLD', error: stop.error };

  var inProfit = currentPremium != null ? isInProfit(position, currentPremium) : false;
  var now = currentTime ? new Date(currentTime) : new Date();
  var exitBy = new Date(stop.exitBy);
  var warningAt = new Date(stop.warningAt);

  // Past exit-by AND not in profit → EXIT
  if (now >= exitBy && !inProfit) {
    return {
      action: 'EXIT',
      reason: 'TIME STOP HIT — ' + stop.tradeType + ' position past max-hold (' + stop.rule.maxHoldMinutes + 'min) and not in profit',
      tradeType: stop.tradeType,
      rule: stop.rule,
      minutesElapsed: stop.minutesElapsed,
      minutesRemaining: stop.minutesRemaining,
      exitBy: stop.exitBy,
      warningAt: stop.warningAt,
      inProfit: false,
      currentPremium: currentPremium,
    };
  }

  // Past exit-by BUT in profit → HOLD (let winners run)
  if (now >= exitBy && inProfit) {
    return {
      action: 'HOLD',
      reason: 'past exit-by (' + stop.minutesElapsed + 'min) but IN PROFIT — let it run',
      tradeType: stop.tradeType,
      rule: stop.rule,
      minutesElapsed: stop.minutesElapsed,
      exitBy: stop.exitBy,
      warningAt: stop.warningAt,
      inProfit: true,
      currentPremium: currentPremium,
    };
  }

  // Past warning threshold → WARN
  if (now >= warningAt) {
    return {
      action: 'WARN',
      reason: stop.tradeType + ' position approaching max-hold (' + stop.minutesElapsed + '/' + stop.rule.maxHoldMinutes + 'min)',
      tradeType: stop.tradeType,
      rule: stop.rule,
      minutesElapsed: stop.minutesElapsed,
      minutesRemaining: stop.minutesRemaining,
      exitBy: stop.exitBy,
      warningAt: stop.warningAt,
      inProfit: inProfit,
      currentPremium: currentPremium,
    };
  }

  // Within window — hold
  return {
    action: 'HOLD',
    tradeType: stop.tradeType,
    rule: stop.rule,
    minutesElapsed: stop.minutesElapsed,
    minutesRemaining: stop.minutesRemaining,
    exitBy: stop.exitBy,
    warningAt: stop.warningAt,
    inProfit: inProfit,
    currentPremium: currentPremium,
  };
}

// Convenience: format minutes-remaining as a human countdown string.
function fmtCountdown(minutes) {
  if (minutes == null || isNaN(minutes)) return '—';
  if (minutes < 0) return 'PAST';
  if (minutes < 60) return minutes + 'm';
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  if (h < 24) return h + 'h ' + m + 'm';
  var d = Math.floor(h / 24);
  var rh = h % 24;
  return d + 'd ' + rh + 'h';
}

// Build a Discord WARN embed payload
function buildWarnEmbed(position, enforceResult) {
  var dirIcon = position.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  var ticker = position.ticker || '?';
  var ct = fmtCountdown(enforceResult.minutesRemaining);
  return {
    username: 'Flow Scout — Time Stop Watch',
    embeds: [{
      title: '⏰ TIME WARN — ' + ticker + ' ' + dirIcon + ' (' + enforceResult.tradeType + ')',
      description: '**' + enforceResult.reason + '**\n\n' +
                   'Position: ' + (position.qty || 1) + 'ct ' + (position.optionSymbol || ticker) +
                   (position.entryPrice ? ' @ $' + parseFloat(position.entryPrice).toFixed(2) : '') +
                   '\nFired: ' + position.firedAt +
                   '\nElapsed: ' + enforceResult.minutesElapsed + 'min · Remaining: **' + ct + '**',
      color: 16753920,  // amber
      fields: [
        { name: '⚠ Action', value: 'Watch closely. If still flat at the **' + enforceResult.rule.maxHoldMinutes + 'min** mark and not in profit (premium ≥ entry × 1.05), the system will push EXIT alert.', inline: false },
        { name: '🎯 Trade Type', value: enforceResult.rule.display + ' · max-hold ' + enforceResult.rule.maxHoldMinutes + 'min', inline: false },
      ],
      footer: { text: 'Flow Scout | Phase 4.26 Time-Stop Watch | warning at ' + enforceResult.rule.warningAt + 'min' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// Build a Discord EXIT embed payload (TIME STOP HIT)
function buildExitEmbed(position, enforceResult) {
  var dirIcon = position.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  var ticker = position.ticker || '?';
  return {
    username: 'Flow Scout — Time Stop Watch',
    embeds: [{
      title: '🕐 TIME STOP HIT — EXIT ' + ticker + ' ' + dirIcon + ' (' + enforceResult.tradeType + ')',
      description: '**' + enforceResult.reason + '**\n\n' +
                   'Position: ' + (position.qty || 1) + 'ct ' + (position.optionSymbol || ticker) +
                   (position.entryPrice ? ' @ $' + parseFloat(position.entryPrice).toFixed(2) : '') +
                   '\nFired: ' + position.firedAt +
                   '\nElapsed: ' + enforceResult.minutesElapsed + 'min',
      color: 15158332,  // red
      fields: [
        { name: '⏰ Action', value: '**EXIT POSITION AT MARKET NOW.** ' + enforceResult.tradeType + ' max-hold window expired. Trade thesis was time-bound and the move did not happen.', inline: false },
        { name: '🎯 Rule', value: enforceResult.rule.display + ' · ifNotProfit=' + enforceResult.rule.ifNotProfit, inline: false },
        { name: '💵 P&L Status', value: 'Premium: ' + (enforceResult.currentPremium != null ? '$' + parseFloat(enforceResult.currentPremium).toFixed(2) : 'unknown') + ' (entry $' + parseFloat(position.entryPrice || 0).toFixed(2) + ') — NOT IN PROFIT (need 5%+ above entry to override time stop)', inline: false },
      ],
      footer: { text: 'Flow Scout | Phase 4.26 Time-Stop Watch | structural-stop monitoring continues independently' },
      timestamp: new Date().toISOString(),
    }],
  };
}

module.exports = {
  TIME_STOP_RULES: TIME_STOP_RULES,
  IN_PROFIT_THRESHOLD: IN_PROFIT_THRESHOLD,
  getRule: getRule,
  classifyTradeType: classifyTradeType,
  computeTimeStop: computeTimeStop,
  isInProfit: isInProfit,
  shouldEnforce: shouldEnforce,
  fmtCountdown: fmtCountdown,
  buildWarnEmbed: buildWarnEmbed,
  buildExitEmbed: buildExitEmbed,
};
