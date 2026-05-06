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
var peakReturn = null;
try { peakReturn = require('./bullflowPeakReturn'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var LOG_FILE = path.join(DATA_ROOT, 'uoa_log.json');

var UOA_THRESHOLD = 5;            // Lowered from 7 May 5 PM — catches NBIS/DDOG/EBAY-style $1-3M institutional blocks that previously silent-logged
var WHALE_THRESHOLD = 10;
var PREMIUM_ALWAYS_PUSH = 1000000; // $1M+ premium ALWAYS pushes Discord regardless of score (institutional block — AB decides)
var WHALE_PREMIUM = 5000000;       // $5M+ → mark WHALE in card title even if score math underweights

// Standard watchlist — used to flag whether ticker is in AB's tracked universe.
// Off-watchlist alerts still push but get a "📡 OFF-WATCHLIST" tag so AB knows.
var WATCHLIST = (process.env.FLOW_TICKERS || 'SPY,QQQ,IWM,NVDA,TSLA,META,GOOGL,AMZN,MSFT,AMD,COIN,PLTR,UBER,ARKK,XLE,GLD,TLT,DIA,KO,WMT,XOM,CVX,JNJ,UNH,JPM,GS,BAC,DAL')
  .split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);

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

  // Bullflow algo-name boost — high-quality built-in algos (per Bullflow docs:
  // Urgent Repeater, Sizable Sweep, Whale Block) catch the trades AB tweets
  // about: $NBIS 500%, $DDOG +45%, $EBAY pre-GME-news. Boost so they don't
  // get filtered out when their math is light (small contracts, low velocity).
  var alertName = String(alert.alertName || alert.bullflowAlertName || '').toLowerCase();
  if (alertName) {
    if (alertName.includes('whale') || alertName.includes('block')) s += 4;
    else if (alertName.includes('urgent repeater') || alertName.includes('repeat')) s += 3;
    else if (alertName.includes('sizable sweep') || alertName.includes('sweep')) s += 2;
    else if (alertName.includes('aggressive')) s += 2;
  }

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

  // Premium-floor override — institutional blocks ($1M+) ALWAYS push regardless
  // of score math. We were silent-logging $3.4M leveraged-ETF buys + $10M NOK
  // calls because Bullflow's algo alertType=algo + small contract size yielded
  // score < 7. Net effect: we filtered out exactly the trades worth chasing.
  var premium = parseFloat(alert.totalPremium || alert.premium || 0);
  var premiumOverride = premium >= PREMIUM_ALWAYS_PUSH;

  // Below threshold = silent log — UNLESS custom alert OR premium override
  if (!isCustom && !premiumOverride && s < UOA_THRESHOLD) {
    return { ok: true, action: 'log', score: s, threshold: UOA_THRESHOLD };
  }
  alert._premiumOverride = premiumOverride;
  alert._whaleByPremium = premium >= WHALE_PREMIUM;
  alert._offWatchlist = WATCHLIST.indexOf(String(alert.ticker).toUpperCase()) === -1;

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

  // PHASE 4.3 (May 5 PM): Custom Bullflow alerts register as Tier 1 in
  // alertTiers — they ARE primary signals (AB-curated thesis). This lets
  // a Bullflow custom alert + a TV Tier 2 confirmation = full stack.
  // (Previously only TV alerts populated the tier framework.)
  if (isCustom && !alignmentWarning && alertTiers && alertTiers.recordAlert) {
    try {
      alertTiers.recordAlert(ticker, direction, 1, {
        source: 'bullflow-custom',
        alertName: alert.customAlertName || alert.bullflowAlertName,
        filterWeight: filterWeight,
        premium: alert.totalPremium || alert.premium,
        contractSymbol: alert.contractSymbol,
      });
    } catch (e) { console.error('[UOA] tier1-register error:', e.message); }
  }

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

  // PHASE 5.3 — peak return since this alert's trade timestamp
  // Best-effort. Most UOAs fire near alert time so peak return ≈ 0% initially,
  // but for backfill / late-arriving UOA cards this surfaces the real signal.
  var peakReturnInfo = null;
  if (peakReturn && peakReturn.getPeakReturn && alert.contractSymbol && alert.tradePrice) {
    try {
      var ts = alert.tradeTimestamp || Math.floor(Date.now() / 1000);
      var sym = alert.contractSymbol.startsWith('O:') ? alert.contractSymbol : 'O:' + alert.contractSymbol;
      var pr = await peakReturn.getPeakReturn(sym, alert.tradePrice, ts);
      if (pr.ok) peakReturnInfo = pr;
    } catch (e) { /* fail open */ }
  }

  // Whale = score >= 10 OR raw premium >= $5M. Latter catches institutional
  // blocks that sneak under our scoring (small contract count × big premium).
  var isWhale = s >= WHALE_THRESHOLD || alert._whaleByPremium;

  // ─────────────────────────────────────────────────────────────────────
  // MAY 6 2026 AUDIT UNBLOCK — UOA-ONLY FAST PATH
  //
  // PROBLEM: Phase 4.2.2 requires BOTH a TV Tier 2 alert AND a Bullflow Tier 1
  // alert to count as `fullStack`. Today (May 6) META hit Bullflow Tier 1 alone
  // with $249K Whale + 100k AA Sweep + score 11 — but ZERO TV alerts arrived.
  // Auto-fire blocked. NVDA had 53 UOA hits — same outcome. System fired 0.
  //
  // FIX: when an alert is institutionally decisive on its own (high score AND
  // confirmed whale AND ≥$100K premium AND fresh < 30min), fire SIM auto-fire
  // immediately without waiting for a TV TF confirmation. The existing fullStack
  // path is untouched — this is ADDITIVE.
  //
  // ENV: UOA_FAST_PATH_AUTO=on (default ON — that's the whole point).
  // SAFETY: SIM ONLY. The simAutoTrader fire path hardcodes account='sim'.
  // ─────────────────────────────────────────────────────────────────────
  var uoaFastPathEnabled = String(process.env.UOA_FAST_PATH_AUTO || 'on').toLowerCase() !== 'off';
  var fastPathScoreThreshold = parseInt(process.env.UOA_FAST_PATH_SCORE || '11', 10);
  var fastPathPremiumFloor = parseFloat(process.env.UOA_FAST_PATH_PREMIUM || '100000');
  var fastPathMaxAgeMin = parseFloat(process.env.UOA_FAST_PATH_AGE_MIN || '30');

  // Compute alert age in minutes — alerts can carry tradeTimestamp (epoch sec)
  // OR be live-stream events (treat as 0 min if no timestamp present)
  var alertAgeMinutes = 0;
  if (alert.tradeTimestamp && isFinite(alert.tradeTimestamp)) {
    var tsMs = alert.tradeTimestamp > 1e12 ? alert.tradeTimestamp : alert.tradeTimestamp * 1000;
    alertAgeMinutes = (Date.now() - tsMs) / 60000;
  }

  var fastPathEligible = uoaFastPathEnabled
    && (s >= fastPathScoreThreshold)
    && (isWhale === true)
    && (premium >= fastPathPremiumFloor)
    && (alertAgeMinutes < fastPathMaxAgeMin)
    && !alignmentWarning
    && !alert._offWatchlist;

  if (fastPathEligible) {
    console.log('[UOA-FAST-PATH] ' + ticker + ' score=' + s + ' premium=$' + Math.round(premium) +
      ' whale=true ageMin=' + alertAgeMinutes.toFixed(1) + ' → SIM auto-fire-intent dispatched');
    setImmediate(async function() {
      try {
        var simAutoTrader = require('./simAutoTrader');
        if (!simAutoTrader.isEnabled || !simAutoTrader.isEnabled()) {
          console.log('[UOA-FAST-PATH] auto-fire skipped — simAutoTrader disabled');
          return;
        }
        if (simAutoTrader.inFireWindow && !simAutoTrader.inFireWindow()) {
          console.log('[UOA-FAST-PATH] auto-fire skipped — outside fire window');
          return;
        }
        var fpResult = await simAutoTrader.runSimAuto({
          source: 'uoa-fast-path',
          uoaTicker: ticker,
          uoaDirection: direction,
        });
        console.log('[UOA-FAST-PATH] auto-fire complete:', JSON.stringify({
          fired: (fpResult && fpResult.firesSucceeded) || 0,
          attempted: (fpResult && fpResult.firesAttempted) || 0,
        }));
      } catch (e) { console.error('[UOA-FAST-PATH] auto-fire error:', e.message); }
    });
  }

  // Custom alerts get the curated-thesis flag (🎯) so AB sees his own filter fired
  var icon = isCustom
    ? '🎯'
    : (isWhale ? '🐋🐋' : '🌊');
  var titleLabel = isCustom
    ? 'CUSTOM ALERT FIRED'
    : (isWhale ? 'WHALE' : 'UOA');
  // Off-watchlist tag — ticker is being chased outside AB's tracked universe
  if (alert._offWatchlist) titleLabel = '📡 ' + titleLabel + ' [off-watchlist]';
  // Premium-floor tag — alert pushed because of $1M+ premium even if score low
  if (alert._premiumOverride && !isCustom && s < UOA_THRESHOLD) {
    titleLabel = '💰 ' + titleLabel + ' [premium override]';
  }
  // Auto-fire eligibility:
  //   - whale (s >= WHALE_THRESHOLD) + full stack always eligible
  //   - custom alert + full stack eligible IFF filter is autoFireEligible
  //     AND direction not mismatched
  var customAutoEligible = isCustom
    && (alert.filterMeta && alert.filterMeta.autoFireEligible !== false)
    && !alignmentWarning;
  // Auto-fire only on standard whale path (not premium-override) — institutional
  // blocks on off-watchlist tickers get pushed for AB review, not auto-fired.
  var triggerAutoFire = ((s >= WHALE_THRESHOLD) || customAutoEligible) && stack.fullStack && !alert._offWatchlist;

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

  // Peak return so far — historical max % gain on this contract since alert fired.
  // Only show on cards where return is meaningful (> 1%) — fresh live alerts
  // typically have 0% so skip those to avoid clutter.
  if (peakReturnInfo && peakReturnInfo.peakPercent != null && Math.abs(peakReturnInfo.peakPercent) >= 1) {
    var prSign = peakReturnInfo.peakPercent >= 0 ? '+' : '';
    var prEmoji = peakReturnInfo.peakPercent >= 50 ? '🚀'
                : peakReturnInfo.peakPercent >= 25 ? '✅'
                : peakReturnInfo.peakPercent >= 0 ? '📈' : '📉';
    fields.push({
      name: prEmoji + ' Peak return since alert',
      value: '**' + prSign + peakReturnInfo.peakPercent.toFixed(1) + '%** · peak price $' + peakReturnInfo.peakPrice.toFixed(2) + ' (entry $' + (alert.tradePrice || 0).toFixed(2) + ')',
      inline: false,
    });
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

  // Phase 4.3 — confluence auto-fire SIM when stack complete.
  // Don't wait for next cron tick — fire NOW via simAutoTrader.runSimAuto().
  // The existing pipeline applies all safety: daily cap, ticker cooldown,
  // vision gate, fire window, account hardcoded 'sim'. If no scanner setup
  // matches (no trigger/stop), it skips silently.
  if (triggerAutoFire) {
    console.log('[UOA] AUTO-FIRE TRIGGER: ' + ticker + ' ' + direction + ' score ' + s + ' (custom=' + isCustom + ', whale=' + (s >= WHALE_THRESHOLD) + ', stack=fullStack)');
    setImmediate(async function() {
      try {
        var simAutoTrader = require('./simAutoTrader');
        if (!simAutoTrader.isEnabled || !simAutoTrader.isEnabled()) {
          console.log('[UOA] auto-fire skipped — simAutoTrader disabled');
          return;
        }
        if (simAutoTrader.inFireWindow && !simAutoTrader.inFireWindow()) {
          console.log('[UOA] auto-fire skipped — outside fire window');
          return;
        }
        var result = await simAutoTrader.runSimAuto({ source: 'uoa-confluence', uoaTicker: ticker, uoaDirection: direction });
        console.log('[UOA] auto-fire complete:', JSON.stringify({ fired: (result && result.firesSucceeded) || 0, attempted: (result && result.firesAttempted) || 0 }));
      } catch (e) { console.error('[UOA] auto-fire error:', e.message); }
    });
  }

  return {
    ok: true,
    action: triggerAutoFire
      ? 'auto-fire-intent'
      : (fastPathEligible ? 'auto-fire-intent-fastpath' : 'discord-push'),
    fastPathEligible: !!fastPathEligible,
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
