// dailyLossLimit.js -- Stratum v7.4
// Protects account from catastrophic loss days
// Checks realized P&L every 5 min during RTH
// If loss exceeds limit = blocks ALL auto-execution

var fetch = require('node-fetch');

// LOSS LIMITS BY ACCOUNT
var LIMITS = {
  '11975462':    -500,   // Live account -- stop at -$500 realized
  'SIM3142118M': -2000,  // SIM account -- stop at -$2000
};

var DEFAULT_LIMIT = -500;
var blocked = {};        // account -> { blocked: true, reason, blockedAt }

// ================================================================
// CHECK DAILY LOSS -- call every 5 min
// ================================================================
async function checkDailyLoss(account) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return false;

    var isSim = account && account.toUpperCase().startsWith('SIM');
    var base  = isSim ? 'https://sim-api.tradestation.com/v3' : 'https://api.tradestation.com/v3';

    var res  = await fetch(base + '/brokerage/accounts/' + account + '/balances', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var bal  = (data.Balances || data.balances || [])[0] || {};

    var realizedPL = parseFloat(bal.RealizedProfitLoss || 0);
    var limit      = LIMITS[account] || DEFAULT_LIMIT;

    if (realizedPL <= limit) {
      if (!blocked[account]) {
        blocked[account] = {
          blocked:   true,
          reason:    'Daily loss limit hit -- realized P&L: $' + realizedPL + ' (limit: $' + limit + ')',
          blockedAt: new Date().toISOString(),
          realizedPL: realizedPL,
          limit:     limit,
        };
        console.log('[LOSS-LIMIT] BLOCKED:', account, 'Realized P&L: $' + realizedPL, 'Limit: $' + limit);

        // Post to Discord
        try {
          var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
            'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
          var msg = [
            'DAILY LOSS LIMIT HIT -- ' + account,
            '===============================',
            'Realized P&L: $' + realizedPL,
            'Limit:        $' + limit,
            'Status:       ALL AUTO-EXECUTION BLOCKED',
            'Action:       No new positions will be opened',
            'Reset:        Automatically at midnight ET',
            'Override:     bash stratum.sh override-loss-limit',
          ].join('\n');
          await fetch(webhook, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content: '```\n' + msg + '\n```', username: 'Stratum Risk Manager' }),
          });
        } catch(e) { console.error('[LOSS-LIMIT] Discord post error:', e.message); }
      }
      return true; // blocked
    }

    // Not blocked -- clear if previously blocked
    if (blocked[account]) {
      delete blocked[account];
      console.log('[LOSS-LIMIT] Cleared for account:', account);
    }
    return false; // not blocked

  } catch(e) {
    console.error('[LOSS-LIMIT] Check error:', e.message);
    return false;
  }
}

// Check if account is currently blocked
function isBlocked(account) {
  return !!(blocked[account] && blocked[account].blocked);
}

// Manual override -- use only in emergencies
function override(account) {
  delete blocked[account];
  console.log('[LOSS-LIMIT] Manual override applied for:', account);
}

// Reset all blocks at midnight
setInterval(function() {
  var now    = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  if (etHour === 0) {
    blocked = {};
    console.log('[LOSS-LIMIT] Reset for new trading day');
  }
}, 60 * 60 * 1000);

module.exports = { checkDailyLoss, isBlocked, override };
