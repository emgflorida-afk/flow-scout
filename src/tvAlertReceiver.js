// =============================================================================
// TV ALERT RECEIVER — webhook endpoint for TV alerts → Railway pipeline.
//
// FLOW:
//   TV alert fires → POSTs JSON to /api/tv-alert/incoming
//                  ↓
//   tvAlertReceiver.process(payload):
//     1. Validate token (TV_WEBHOOK_TOKEN env)
//     2. Classify tier (1/2/3) via alertTiers.classifyAlert
//     3. Record fire timestamp
//     4. Check shouldAct() — does this stack-qualify for action?
//     5. Push Discord card with priority based on stack status
//     6. Cross-reference Bullflow state for confluence boost
//     7. If full stack + Bullflow UOA aligned → trigger SIM auto-fire
//
// EXPECTED PAYLOAD (TV alert message body):
// {
//   "ticker": "ADBE",
//   "direction": "long",          // long | short
//   "tier": 1,                    // 1 | 2 | 3 (explicit tier)
//   "tf": "1D",                   // for inference if tier missing
//   "alertName": "Daily close > Friday H",
//   "price": 254.06,
//   "trigger": 253.56,
//   "stacked": true,              // optional — multi-condition Pine alert
//   "confirmations": 3,           // optional — count of conditions met
//   "secret": "your-token"
// }
// =============================================================================

var alertTiers = require('./alertTiers');
var dp = require('./discordPush');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

function expectedToken() {
  return process.env.TV_WEBHOOK_TOKEN || null;
}

// Color codes by tier
var TIER_COLORS = { 1: 15158332, 2: 16753920, 3: 5763719, 0: 8359053 };  // red / orange / green / gray
var TIER_ICONS = { 1: '🚨🚨', 2: '🔶', 3: '🔷', 0: '⚫' };

async function processAlert(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'invalid payload (not object)' };
  }

  // Token check (open if not configured)
  var expected = expectedToken();
  if (expected && payload.secret !== expected) {
    return { ok: false, error: 'invalid token' };
  }

  var ticker = String(payload.ticker || '').toUpperCase();
  var direction = String(payload.direction || 'long').toLowerCase();
  if (!ticker) return { ok: false, error: 'ticker required' };

  var tier = alertTiers.classifyAlert(payload);
  alertTiers.recordAlert(ticker, direction, tier, {
    alertName: payload.alertName,
    price: payload.price,
    trigger: payload.trigger,
    tf: payload.tf,
  });

  var verdict = alertTiers.shouldAct(ticker, direction, tier);
  var stack = alertTiers.getStackStatus(ticker, direction);

  // Build Discord embed
  var icon = TIER_ICONS[tier] || '⚫';
  var color = TIER_COLORS[tier] || TIER_COLORS[0];
  var dirIcon = direction === 'long' ? '🟢' : '🔴';

  var stackLine = '';
  if (stack.fullStack) {
    stackLine = '✅ **FULL STACK** — Tier 1 + Tier 2 already fired today.';
  } else if (stack.t1Fired) {
    stackLine = '🟡 Tier 1 fired ' + ageMin(stack.t1FiredAt) + ' min ago. Waiting for Tier 2.';
  } else if (stack.t2Fired) {
    stackLine = '⚠️ Tier 2 fired but Tier 1 not — counter-signal?';
  } else {
    stackLine = '⚫ No prior tiers fired today.';
  }

  var actionLine = verdict.act
    ? '🎯 **ACTION**: ' + verdict.priority + ' priority · ' + verdict.reason
    : '🔇 **MUTED**: ' + verdict.reason;

  var embed = {
    username: 'Flow Scout — TV Alert',
    embeds: [{
      title: icon + ' ' + dirIcon + ' Tier ' + tier + ' — ' + ticker + ' ' + direction.toUpperCase(),
      description: '**Alert**: ' + (payload.alertName || 'unnamed') + '\n' +
                   '**Price**: $' + (payload.price != null ? payload.price : '?') +
                   (payload.trigger != null ? ' · **Trigger**: $' + payload.trigger : '') +
                   '\n**TF**: ' + (payload.tf || '?'),
      color: color,
      fields: [
        { name: '📊 Stack status', value: stackLine, inline: false },
        { name: '🎬 Decision', value: actionLine, inline: false },
      ],
      footer: { text: 'Flow Scout | TV Alert | tier-aware filter' },
      timestamp: new Date().toISOString(),
    }],
  };

  // Only push Discord if we should ACT (filters Tier 3 noise)
  if (verdict.act) {
    var pushResult = await dp.send('tvAlert', embed, { webhook: DISCORD_WEBHOOK });
    return { ok: true, tier: tier, action: 'discord-push', verdict: verdict, stack: stack, pushOk: pushResult.ok };
  } else {
    // Log silently — don't push
    console.log('[TV-ALERT] silent: ' + ticker + ' ' + direction + ' tier ' + tier + ' — ' + verdict.reason);
    return { ok: true, tier: tier, action: 'silent-log', verdict: verdict, stack: stack };
  }
}

function ageMin(iso) {
  if (!iso) return '?';
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

module.exports = {
  processAlert: processAlert,
  // Backward-compat alias — `process` shadows Node global, only via export
  process: processAlert,
};
