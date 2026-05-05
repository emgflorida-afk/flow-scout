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

  var s = score(alert);
  alert._uoaScore = s;

  // Below threshold = silent log
  if (s < UOA_THRESHOLD) {
    return { ok: true, action: 'log', score: s, threshold: UOA_THRESHOLD };
  }

  // UOA threshold hit — log it
  var log = loadLog();
  log.push({
    timestamp: new Date().toISOString(),
    ticker: alert.ticker,
    direction: alert.direction || 'unknown',
    premium: alert.totalPremium || alert.premium,
    size: alert.size,
    score: s,
    isWhale: s >= WHALE_THRESHOLD,
    contract: alert.contractSymbol,
  });
  saveLog(log);

  // Stack-check via alertTiers
  var ticker = String(alert.ticker).toUpperCase();
  var direction = String(alert.direction || 'long').toLowerCase();
  var stack = alertTiers ? alertTiers.getStackStatus(ticker, direction) : { fullStack: false };

  // Push Discord card
  var icon = s >= WHALE_THRESHOLD ? '🐋🐋' : '🌊';
  var stackLine = stack.fullStack
    ? '✅ FULL STACK — TV Tier 1 + 2 fired earlier today on ' + ticker + ' ' + direction
    : stack.t1Fired ? '🟡 Tier 1 fired today (no Tier 2 yet)'
    : stack.t2Fired ? '🟡 Tier 2 fired today (no Tier 1)'
    : '⚫ No TV alerts on this ticker today';

  var triggerAutoFire = s >= WHALE_THRESHOLD && stack.fullStack;

  var embed = {
    username: 'Flow Scout — UOA Detector',
    embeds: [{
      title: icon + ' ' + (s >= WHALE_THRESHOLD ? 'WHALE' : 'UOA') + ' — ' + ticker + ' ' + direction.toUpperCase() + ' (score ' + s + '/15)',
      description: '**Premium**: $' + Math.round((alert.totalPremium || alert.premium || 0) / 1000) + 'K' +
                   '\n**Size**: ' + (alert.size || '?') + ' contracts' +
                   '\n**Contract**: ' + (alert.contractSymbol || '?'),
      color: s >= WHALE_THRESHOLD ? 15158332 : 5763719,
      fields: [
        { name: '📊 Stack confluence', value: stackLine, inline: false },
        { name: '🎯 Decision', value: triggerAutoFire ? '✅ AUTO-FIRE SIM (whale + full stack)' : '🔔 Watch — manual fire if you confirm chart', inline: false },
      ],
      footer: { text: 'Flow Scout | UOA Detector | live Bullflow scoring' },
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

  return { ok: true, action: triggerAutoFire ? 'auto-fire-intent' : 'discord-push', score: s, stack: stack };
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
