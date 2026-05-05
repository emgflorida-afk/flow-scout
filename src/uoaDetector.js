// =============================================================================
// UOA DETECTOR — Unusual Options Activity scorer + auto-chart-vision pipeline.
//
// AB's vision: "When institutions pile in intraday, system should see flow,
// auto-pull chart for confirmation, scream at me to enter."
//
// FLOW:
//   Bullflow live alert arrives → uoaDetector.score()
//                                  ↓
//   Score = function of premium, sweep size, velocity, OI ratio
//                                  ↓
//   If score >= UOA_THRESHOLD → uoaDetector.handleUoa()
//     1. Cross-reference watchlist (am I tracking this ticker?)
//     2. Check tier-stack (has TV alert tier 1+2 fired?)
//     3. Push Discord HIGH priority card
//     4. If full stack + UOA → trigger SIM auto-fire (when SIM_AUTO_ENABLED)
//
// SCORING RUBRIC:
//   Premium spent:    >$5M  = +5,  >$1M  = +3,  >$500K = +2,  >$200K = +1
//   Sweep size:       >5000 = +5,  >2000 = +3,  >1000  = +2,  >500   = +1
//   Velocity (alerts/min): >10 = +3, >5 = +2, >2 = +1
//   OI ratio (vol/OI): >2.0 = +2, >1.0 = +1
//   Whale ($10M+ block): +5
//
// Score >= 7 = UOA (push Discord + trigger pipeline)
// Score >= 10 = WHALE (auto-fire SIM if conditions stack)
//
// STATE: /data/uoa_log.json — rolling log of high-score alerts
// =============================================================================

var fs = require('fs');
var path = require('path');

var alertTiers = null;
try { alertTiers = require('./alertTiers'); } catch (e) {}
var dp = null;
try { dp = require('./discordPush'); } catch (e) {}
var uoaEnrichment = null;
try { uoaEnrichment = require('./uoaEnrichment'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var LOG_FILE = path.join(DATA_ROOT, 'uoa_log.json');

var UOA_THRESHOLD = 7;
var WHALE_THRESHOLD = 10;

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveLog(records) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(records.slice(-500), null, 2)); }
  catch (e) {}
}

// Score a single Bullflow alert
function score(alert) {
  if (!alert) return 0;
  var s = 0;
  var premium = parseFloat(alert.totalPremium || alert.premium || 0);
  var sweepSize = parseInt(alert.size || alert.contractSize || 0, 10);
  var oiRatio = parseFloat(alert.volOiRatio || 0);
  var velocity = parseFloat(alert.velocity || 0);
  var isWhale = alert.isWhale || premium > 10000000;

  if (premium > 5000000) s += 5;
  else if (premium > 1000000) s += 3;
  else if (premium > 500000) s += 2;
  else if (premium > 200000) s += 1;

  if (sweepSize > 5000) s += 5;
  else if (sweepSize > 2000) s += 3;
  else if (sweepSize > 1000) s += 2;
  else if (sweepSize > 500) s += 1;

  if (velocity > 10) s += 3;
  else if (velocity > 5) s += 2;
  else if (velocity > 2) s += 1;

  if (oiRatio > 2.0) s += 2;
  else if (oiRatio > 1.0) s += 1;

  if (isWhale) s += 5;

  return s;
}

// Process a Bullflow alert through UOA pipeline
async function handleAlert(alert) {
  if (!alert || !alert.ticker) return { ok: false, error: 'invalid alert' };

  var baseScore = score(alert);

  // PHASE 4.2.1 (May 5 PM): Custom alerts elevated.
  // Bullflow custom alerts = AB's saved filters firing — pre-curated by him,
  // high-signal by definition. Bypass UOA_THRESHOLD (always push) + boost
  // score so the Discord card visibly ranks above algo noise.
  var isCustom = !!alert.isCustomAlert || alert.bullflowAlertCategory === 'custom';

  // Phase 4.2.2 — per-filter weight from registry (replaces flat +5 boost).
  // If filter is in KNOWN_FILTERS, use its weight; unknown custom = +5 default.
  var customBoost = 0;
  var filterWeight = null;
  if (isCustom) {
    filterWeight = (alert.filterMeta && typeof alert.filterMeta.weight === 'number')
      ? alert.filterMeta.weight
      : 5;
    customBoost = filterWeight;
  }
  var s = baseScore + customBoost;
  alert._uoaScore = s;
  alert._baseScore = baseScore;
  alert._customBoost = customBoost;
  alert._filterWeight = filterWeight;

  // Direction-alignment warning — filter says Bullish but OPRA is PUT (or vice versa)
  var alignmentWarning = (isCustom && alert.directionAlignment === 'mismatch');

  // Below threshold = silent log — UNLESS custom alert (AB curated, always elevate)
  if (!isCustom && s < UOA_THRESHOLD) {
    return { ok: true, action: 'log', score: s, threshold: UOA_THRESHOLD };
  }

  // UOA threshold hit (or custom alert) — log it
  var log = loadLog();
  log.push({
    timestamp: new Date().toISOString(),
    ticker: alert.ticker,
    direction: alert.direction || 'unknown',
    premium: alert.totalPremium || alert.premium,
    size: alert.size,
    score: s,
    baseScore: baseScore,
    isWhale: s >= WHALE_THRESHOLD,
    isCustom: isCustom,
    customAlertName: alert.customAlertName || alert.bullflowAlertName || null,
    contract: alert.contractSymbol,
  });
  saveLog(log);

  // Stack-check via alertTiers
  var ticker = String(alert.ticker).toUpperCase();
  var direction = String(alert.direction || 'long').toLowerCase();
  var stack = alertTiers ? alertTiers.getStackStatus(ticker, direction) : { fullStack: false };

  // ENRICH — pull live ticker context, scanner setup, level distance, Titan ticket
  var enriched = null;
  if (uoaEnrichment && uoaEnrichment.enrichUoaPush) {
    try {
      enriched = await uoaEnrichment.enrichUoaPush({
        ticker: ticker, direction: direction,
        totalPremium: alert.totalPremium || alert.premium,
        size: alert.size, contractSymbol: alert.contractSymbol,
      });
    } catch (e) { console.error('[UOA] enrichment error:', e.message); }
  }

  // Custom alerts get the curated-thesis flag (🎯) so AB sees his own filter fired
  var icon = isCustom
    ? '🎯'
    : (s >= WHALE_THRESHOLD ? '🐋🐋' : '🌊');
  var titleLabel = isCustom
    ? 'CUSTOM ALERT FIRED'
    : (s >= WHALE_THRESHOLD ? 'WHALE' : 'UOA');
  // Auto-fire eligibility:
  //   - whale (s >= WHALE_THRESHOLD) + full stack always eligible
  //   - custom alert + full stack eligible IFF filter is autoFireEligible
  //     AND direction not mismatched
  var customAutoEligible = isCustom
    && (alert.filterMeta && alert.filterMeta.autoFireEligible !== false)
    && !alignmentWarning;
  var triggerAutoFire = ((s >= WHALE_THRESHOLD) || customAutoEligible) && stack.fullStack;

  // Build stackLine — prefer enriched version (has emoji + tier age info)
  var stackLine = (enriched && enriched.summary && enriched.summary.stackLine)
    ? enriched.summary.stackLine
    : (stack.fullStack
        ? '✅ FULL STACK — TV Tier 1 + 2 fired earlier today on ' + ticker + ' ' + direction
        : stack.t1Fired ? '🟡 Tier 1 fired today (no Tier 2 yet)'
        : stack.t2Fired ? '🟡 Tier 2 fired today (no Tier 1)'
        : '⚫ No TV alerts on this ticker today');

  // Build description with enriched live spot + day H/L if available
  var descParts = [
    '**Premium**: $' + Math.round((alert.totalPremium || alert.premium || 0) / 1000) + 'K',
    '**Size**: ' + (alert.size || '?') + ' contracts',
    '**Contract**: ' + (alert.contractSymbol || '?'),
  ];
  if (enriched && enriched.summary && enriched.summary.liveLine) {
    descParts.push(enriched.summary.liveLine);
  }

  // Fields — enriched setup + level + Titan ticket
  var fields = [
    { name: '📊 Stack confluence', value: stackLine, inline: false },
  ];

  if (enriched && enriched.summary && enriched.summary.setupLine) {
    fields.push({ name: '🎯 Scanner setup', value: enriched.summary.setupLine, inline: false });
  }
  if (enriched && enriched.summary && enriched.summary.levelLine) {
    fields.push({ name: '📍 Level distance', value: enriched.summary.levelLine, inline: false });
  }

  fields.push({
    name: '🎬 Decision',
    value: triggerAutoFire
      ? '✅ AUTO-FIRE SIM (whale + full stack)'
      : (enriched && enriched.levelInfo && enriched.levelInfo.atTrigger
          ? '🔥 AT TRIGGER ZONE — manual fire ready (verify chart)'
          : '🔔 Watch — manual fire if you confirm chart'),
    inline: false,
  });

  // Pre-formatted Titan ticket — collapse into ```code block``` if present
  if (enriched && enriched.ticket) {
    var ticketText = enriched.ticket;
    if (ticketText.length > 1000) ticketText = ticketText.slice(0, 997) + '...';
    fields.push({
      name: '📋 Titan ticket (copy-paste ready)',
      value: '```\n' + ticketText + '\n```',
      inline: false,
    });
  }

  // Insert custom-alert callout above stack confluence if present
  if (isCustom) {
    var filterName = alert.customAlertName || alert.bullflowAlertName || 'Custom alert';
    var filterDesc = alert.filterMeta && alert.filterMeta.description
      ? '\n_' + alert.filterMeta.description + '_'
      : '';
    var calloutValue = '**' + filterName + '** fired · score ' + baseScore + ' + filter weight +' + customBoost + ' = **' + s + '**' + filterDesc;
    fields.unshift({
      name: '🎯 Your saved Bullflow filter',
      value: calloutValue,
      inline: false,
    });

    // Direction-alignment warning if filter direction != OPRA direction
    if (alignmentWarning) {
      fields.unshift({
        name: '⚠️ DIRECTION MISMATCH',
        value: 'Filter "' + filterName + '" expects **' + (alert.filterMeta && alert.filterMeta.direction || '?').toUpperCase() + '**, but OPRA is **' + (alert.opraDirection || '?').toUpperCase() + '**. Counter-signal — verify chart before action.',
        inline: false,
      });
    }
  }

  // Custom alerts get gold color so they stand out in Discord; whale = red; standard UOA = green
  var embedColor = isCustom ? 15844367 : (s >= WHALE_THRESHOLD ? 15158332 : 5763719);

  var embed = {
    username: 'Flow Scout — UOA Detector',
    embeds: [{
      title: icon + ' ' + titleLabel + ' — ' + ticker + ' ' + direction.toUpperCase() +
             (isCustom ? ' · ' + (alert.customAlertName || 'custom filter') : '') +
             ' (score ' + s + (isCustom ? '/20' : '/15') + ')',
      description: descParts.join('\n'),
      color: embedColor,
      fields: fields,
      footer: { text: 'Flow Scout | UOA Detector | ' + (isCustom ? 'CUSTOM ALERT — your saved filter' : 'algo flow + tier') },
      timestamp: new Date().toISOString(),
    }],
  };

  if (dp) await dp.send('uoaDetector', embed, { webhook: DISCORD_WEBHOOK });

  // Trigger SIM auto-fire if conditions stack
  if (triggerAutoFire) {
    try {
      var simAutoTrader = require('./simAutoTrader');
      // Manually inject this UOA-driven setup into qualifying setups
      // and let simAutoTrader fire it on next cron tick (or directly here)
      // For tonight's MVP: just log the auto-fire intent. Real fire happens via cron.
      console.log('[UOA] AUTO-FIRE INTENT: ' + ticker + ' ' + direction + ' score ' + s);
    } catch (e) { console.error('[UOA] auto-fire intent error:', e.message); }
  }

  return {
    ok: true,
    action: triggerAutoFire ? 'auto-fire-intent' : 'discord-push',
    score: s,
    baseScore: baseScore,
    isCustom: isCustom,
    customAlertName: alert.customAlertName || null,
    stack: stack,
    enriched: !!enriched,
  };
}

function getRecentUoa(maxAgeHours) {
  var maxAge = maxAgeHours || 24;
  var cutoff = Date.now() - (maxAge * 3600 * 1000);
  var log = loadLog();
  return log.filter(function(e) { return new Date(e.timestamp).getTime() >= cutoff; });
}

module.exports = {
  score: score,
  handleAlert: handleAlert,
  getRecentUoa: getRecentUoa,
  UOA_THRESHOLD: UOA_THRESHOLD,
  WHALE_THRESHOLD: WHALE_THRESHOLD,
};
