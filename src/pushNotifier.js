// pushNotifier.js — Stratum Flow Scout
// Discord webhook wrapper for AI Curator alerts.
//
// Pushes A+ setups (score ≥ 8) to the stratum-external channel via
// DISCORD_AI_CURATOR_WEBHOOK env var.
// -----------------------------------------------------------------

var fetch = require('node-fetch');

function curatorWebhook() {
  return process.env.DISCORD_AI_CURATOR_WEBHOOK || process.env.DISCORD_STRATUMEXTERNAL_WEBHOOK;
}

// -----------------------------------------------------------------
// Format a curator alert for Discord (rich embed)
// -----------------------------------------------------------------
function formatCuratorEmbed(alert) {
  var colorByScore = alert.score >= 9 ? 0x22c55e /* green */
                   : alert.score >= 8 ? 0xeab308 /* yellow */
                   : 0x64748b /* gray */;

  var title;
  if (alert.verdict === 'GO') title = '🟢 ' + alert.ticker + ' — GO (score ' + alert.score + '/10)';
  else if (alert.verdict === 'REDUCE') title = '🟡 ' + alert.ticker + ' — REDUCE SIZE (score ' + alert.score + '/10)';
  else title = '⚫ ' + alert.ticker + ' — ' + alert.verdict + ' (score ' + alert.score + '/10)';

  var fields = [];
  if (alert.reason) fields.push({ name: 'Reasoning', value: alert.reason, inline: false });
  if (alert.r_r) fields.push({ name: 'R:R Computed', value: String(alert.r_r) + ':1', inline: true });
  if (alert.action) fields.push({ name: 'Recommended Action', value: alert.action, inline: false });
  if (alert.failure_modes && alert.failure_modes.length) {
    fields.push({
      name: '⚠️ Failure Modes',
      value: alert.failure_modes.map(function(m){ return '• ' + m; }).join('\n'),
      inline: false,
    });
  }

  return {
    embeds: [{
      title: title,
      color: colorByScore,
      fields: fields,
      footer: { text: 'AI Curator · ' + new Date().toISOString() },
    }],
  };
}

// -----------------------------------------------------------------
// Send curator alert to Discord
// -----------------------------------------------------------------
function pushCuratorAlert(alert) {
  var webhook = curatorWebhook();
  if (!webhook) return Promise.reject(new Error('No DISCORD_AI_CURATOR_WEBHOOK configured'));

  var payload = formatCuratorEmbed(alert);
  return fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(function(r) {
    if (!r.ok) return r.text().then(function(t){ throw new Error('Discord ' + r.status + ': ' + t.slice(0, 200)); });
    return { ok: true };
  });
}

// -----------------------------------------------------------------
// Plain text push (for EOD plans, test messages, etc.)
// -----------------------------------------------------------------
function pushText(message) {
  var webhook = curatorWebhook();
  if (!webhook) return Promise.reject(new Error('No DISCORD_AI_CURATOR_WEBHOOK configured'));

  return fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message.slice(0, 1900) }), // Discord 2000 char limit
  }).then(function(r) {
    if (!r.ok) return r.text().then(function(t){ throw new Error('Discord ' + r.status + ': ' + t.slice(0, 200)); });
    return { ok: true };
  });
}

module.exports = {
  pushCuratorAlert: pushCuratorAlert,
  pushText: pushText,
  formatCuratorEmbed: formatCuratorEmbed,
};
