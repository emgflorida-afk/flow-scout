// holdLock.js -- Stratum v7.4
// Hold Lock Rule -- NEVER override a hold date
// Any position tagged with a hold date cannot be closed by analysis
// Only manual override by typing: "override hold rule on [ticker]"

var holds = {};

// Tag a position as held until a date
function addHold(ticker, type, holdUntil, reason) {
  var key = ticker.toUpperCase() + '_' + type;
  holds[key] = {
    ticker:    ticker.toUpperCase(),
    type:      type,
    holdUntil: new Date(holdUntil),
    reason:    reason || 'Multi-day swing hold',
    addedAt:   new Date(),
  };
  console.log('[HOLD-LOCK] Added hold: ' + key + ' until ' + holdUntil);
}

// Check if a position is locked
function isLocked(ticker, type) {
  var key = ticker.toUpperCase() + '_' + type;
  var hold = holds[key];
  if (!hold) return { locked: false };

  var now = new Date();
  if (now < hold.holdUntil) {
    return {
      locked:    true,
      until:     hold.holdUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      reason:    hold.reason,
      message:   '🔒 HOLD LOCKED -- DO NOT CLOSE ' + ticker.toUpperCase() + ' ' + type.toUpperCase() + ' UNTIL ' + hold.holdUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '\n' +
                 'Rule: ' + hold.reason + '\n' +
                 'To override: say "override hold rule on ' + ticker + '"',
    };
  }

  // Hold expired
  delete holds[key];
  return { locked: false };
}

// Manual override
function overrideHold(ticker, type) {
  var key = ticker.toUpperCase() + '_' + type;
  if (holds[key]) {
    delete holds[key];
    console.log('[HOLD-LOCK] Override applied: ' + key);
    return true;
  }
  return false;
}

// Get all active holds
function getActiveHolds() {
  var now = new Date();
  var active = [];
  Object.values(holds).forEach(function(h) {
    if (now < h.holdUntil) {
      active.push({
        ticker:    h.ticker,
        type:      h.type,
        until:     h.holdUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        reason:    h.reason,
      });
    }
  });
  return active;
}

// Pre-load today's holds based on current positions
function loadHoldsFromPositions(positions) {
  // April 6 = Iran deadline -- all puts held
  var april6 = '2026-04-06T20:00:00-04:00';
  positions.forEach(function(p) {
    if (!p.symbol) return;
    var sym = p.symbol;
    var isPut  = sym.includes('P');
    var isCall = sym.includes('C');
    var ticker = sym.split(' ')[0];

    // Tag all current options as held through their expiry or April 6
    if (isPut) {
      addHold(ticker, 'put', april6, 'Iran deadline April 6 -- hold through catalyst');
    }
  });
  console.log('[HOLD-LOCK] Loaded holds from positions');
}

module.exports = { addHold, isLocked, overrideHold, getActiveHolds, loadHoldsFromPositions };
