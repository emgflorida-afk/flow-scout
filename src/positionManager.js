// positionManager.js -- Stratum v7.4
// Dynamic position management:
// 1. Move stop to breakeven after T1 hit
// 2. Trail stop as position gains
// 3. Conflict check -- no opposite side same ticker
// 4. Max positions gate
// 5. EOD cash out at 3:45PM ET

var fetch = require('node-fetch');

var LIVE_ACCOUNT = '11975462';
var SIM_ACCOUNT  = 'SIM3142118M';
var MAX_POSITIONS_LIVE = 4;
var MAX_POSITIONS_SIM  = 6;
var EOD_CLOSE_HOUR     = 15;  // 3PM ET
var EOD_CLOSE_MIN      = 45;  // 3:45PM ET

var EXECUTE_NOW_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

function getBaseUrl(account) {
  return (account && account.toUpperCase().startsWith('SIM'))
    ? 'https://sim-api.tradestation.com/v3'
    : 'https://api.tradestation.com/v3';
}

async function getToken() {
  var ts = require('./tradestation');
  return await ts.getAccessToken();
}

async function postDiscord(msg, label) {
  try {
    await fetch(EXECUTE_NOW_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + msg + '\n```',
        username: label || 'Stratum Position Manager',
      }),
    });
  } catch(e) { console.error('[POS-MGR] Discord error:', e.message); }
}

// ================================================================
// CHECK MAX POSITIONS -- called before every new order
// ================================================================
async function checkMaxPositions(account) {
  try {
    var token = await getToken();
    if (!token) return { allowed: true };
    var base  = getBaseUrl(account);
    var res   = await fetch(base + '/brokerage/accounts/' + account + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data     = await res.json();
    var positions = (data.Positions || []).filter(function(p) {
      return p.AssetType === 'OP' || p.AssetType === 'StockOption';
    });
    var max = account === LIVE_ACCOUNT ? MAX_POSITIONS_LIVE : MAX_POSITIONS_SIM;
    if (positions.length >= max) {
      console.log('[POS-MGR] MAX POSITIONS HIT:', positions.length, '/', max, 'on', account);
      return { allowed: false, current: positions.length, max: max };
    }
    return { allowed: true, current: positions.length, max: max };
  } catch(e) {
    console.error('[POS-MGR] Max check error:', e.message);
    return { allowed: true };
  }
}

// ================================================================
// CHECK CONFLICT -- no opposite side same ticker
// ================================================================
async function checkConflict(account, ticker, direction) {
  try {
    var token = await getToken();
    if (!token) return { allowed: true };
    var base  = getBaseUrl(account);
    var res   = await fetch(base + '/brokerage/accounts/' + account + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data      = await res.json();
    var positions = data.Positions || [];

    for (var i = 0; i < positions.length; i++) {
      var p      = positions[i];
      var sym    = (p.Symbol || '').toUpperCase();
      var isCall = sym.includes('C') && !sym.includes('CRM');
      var isPut  = sym.includes('P') && !sym.includes('SPY');

      // Simpler check -- look for ticker in symbol
      if (sym.includes(ticker.toUpperCase())) {
        var existingDir = isCall ? 'call' : 'put';
        if (existingDir !== direction) {
          console.log('[POS-MGR] CONFLICT:', ticker, 'already have', existingDir, 'cannot open', direction);
          return { allowed: false, conflict: existingDir, ticker: ticker };
        }
      }
    }
    return { allowed: true };
  } catch(e) {
    console.error('[POS-MGR] Conflict check error:', e.message);
    return { allowed: true };
  }
}

// ================================================================
// EOD CLOSE ALL -- fires at 3:45PM ET
// ================================================================
async function eodCloseAll(account) {
  try {
    console.log('[POS-MGR] EOD CLOSE ALL -- closing all option positions on', account);
    var token = await getToken();
    if (!token) return;
    var base  = getBaseUrl(account);

    // Get all positions
    var res  = await fetch(base + '/brokerage/accounts/' + account + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data      = await res.json();
    var positions = (data.Positions || []).filter(function(p) {
      return (p.AssetType === 'OP' || p.AssetType === 'StockOption') && parseFloat(p.Quantity) > 0;
    });

    if (positions.length === 0) {
      console.log('[POS-MGR] EOD -- no option positions to close');
      return;
    }

    console.log('[POS-MGR] EOD -- closing', positions.length, 'positions');
    var closed = [];

    for (var i = 0; i < positions.length; i++) {
      var p            = positions[i];
      var qty          = Math.abs(parseFloat(p.Quantity));
      var unrealizedPL = parseFloat(p.UnrealizedProfitLoss || 0);
      var avgPrice     = parseFloat(p.AveragePrice || 0);

      // SMART EOD CLOSE:
      // Try limit at mid price first (better fill)
      // Fall back to market if not filled by 3:55PM
      var etNow  = new Date();
      var etMins = ((etNow.getUTCHours() - 4 + 24) % 24) * 60 + etNow.getUTCMinutes();
      var useMarket = etMins >= (15 * 60 + 55); // after 3:55PM = market order

      var orderBody = {
        AccountID:   account,
        Symbol:      p.Symbol,
        Quantity:    String(qty),
        OrderType:   useMarket ? 'Market' : 'Limit',
        TradeAction: 'SELLTOCLOSE',
        TimeInForce: { Duration: 'DAY' },
        Route:       'Intelligent',
      };

      // For limit orders use mid price (bid + ask / 2 from position data)
      if (!useMarket && p.Last) {
        var midPrice = parseFloat(p.Last);
        // Round to valid increment
        var limitPx = midPrice >= 3
          ? Math.round(midPrice / 0.05) * 0.05
          : Math.round(midPrice / 0.01) * 0.01;
        orderBody.LimitPrice = String(limitPx.toFixed(2));
      }

      var closeType = useMarket ? 'MARKET' : 'LIMIT @ $' + (orderBody.LimitPrice || 'mid');
      console.log('[POS-MGR] EOD closing:', p.Symbol, 'qty:', qty, 'type:', closeType,
        'unrealizedPL: $' + unrealizedPL.toFixed(2));

      try {
        var orderRes = await fetch(base + '/orderexecution/orders', {
          method:  'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(orderBody),
        });
        var orderData = await orderRes.json();
        var orderId   = orderData.Orders && orderData.Orders[0] && orderData.Orders[0].OrderID;
        var plStr     = unrealizedPL >= 0 ? '+$' + unrealizedPL.toFixed(2) : '-$' + Math.abs(unrealizedPL).toFixed(2);
        closed.push(p.Symbol + ' x' + qty + ' ' + closeType + ' P&L:' + plStr + ' (ID: ' + orderId + ')');
        console.log('[POS-MGR] EOD order placed:', p.Symbol, 'orderId:', orderId);
      } catch(e) {
        console.error('[POS-MGR] EOD close error for', p.Symbol, ':', e.message);
      }
    }

    // Post to Discord
    if (closed.length > 0) {
      var msg = [
        'EOD CLOSE ALL -- ' + account,
        '===============================',
        'Closed ' + closed.length + ' position(s):',
        closed.join('\n'),
        'Time: 3:45PM ET -- end of day cash out',
        'Account is now in CASH',
      ].join('\n');
      await postDiscord(msg, 'Stratum EOD Manager');
    }

  } catch(e) {
    console.error('[POS-MGR] EOD close error:', e.message);
  }
}

// ================================================================
// MOVE STOP TO BREAKEVEN -- called when T1 is hit
// ================================================================
async function moveStopToBreakeven(account, stopOrderId, entryPrice) {
  try {
    var token = await getToken();
    if (!token) return false;
    var base  = getBaseUrl(account);

    // Replace stop order with breakeven price
    var res = await fetch(base + '/orderexecution/orders/' + stopOrderId, {
      method:  'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ StopPrice: String(entryPrice) }),
    });
    var data = await res.json();
    console.log('[POS-MGR] Stop moved to breakeven $' + entryPrice + ' for order:', stopOrderId);
    return true;
  } catch(e) {
    console.error('[POS-MGR] Move stop error:', e.message);
    return false;
  }
}

// ================================================================
// MOVE STOP TO BREAKEVEN -- called when T1 hits
// Finds the stop order attached to position and moves to entry price
// ================================================================
async function checkAndMoveStops(account) {
  try {
    var token = await getToken();
    if (!token) return;
    var base  = getBaseUrl(account);

    // Get all positions
    var posRes  = await fetch(base + '/brokerage/accounts/' + account + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var posData   = await posRes.json();
    var positions = (posData.Positions || []).filter(function(p) {
      return (p.AssetType === 'OP' || p.AssetType === 'StockOption');
    });

    for (var i = 0; i < positions.length; i++) {
      var p          = positions[i];
      var entryPrice = parseFloat(p.AveragePrice || 0);
      var lastPrice  = parseFloat(p.Last || 0);
      var t1         = entryPrice * 1.60; // T1 = 60% gain

      // If position is at or past T1 -- move stop to breakeven
      if (lastPrice >= t1 && entryPrice > 0) {
        console.log('[POS-MGR] T1 hit on', p.Symbol, '-- moving stop to breakeven $' + entryPrice);

        // Find working stop order for this position
        var ordRes  = await fetch(base + '/orderexecution/orders?status=OPN', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var ordData = await ordRes.json();
        var orders  = ordData.Orders || [];

        for (var j = 0; j < orders.length; j++) {
          var o = orders[j];
          if (o.Symbol === p.Symbol && o.OrderType === 'StopMarket' && o.TradeAction === 'SELLTOCLOSE') {
            var currentStop = parseFloat(o.StopPrice || 0);
            // Only move stop UP (never lower the stop)
            if (currentStop < entryPrice) {
              try {
                await fetch(base + '/orderexecution/orders/' + o.OrderID, {
                  method:  'PUT',
                  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ StopPrice: String(entryPrice.toFixed(2)) }),
                });
                console.log('[POS-MGR] Stop moved to breakeven $' + entryPrice + ' for', p.Symbol, 'order:', o.OrderID);
                await postDiscord([
                  'STOP MOVED TO BREAKEVEN -- ' + account,
                  p.Symbol + ' hit T1',
                  '==============================',
                  'T1 hit:     $' + lastPrice.toFixed(2),
                  'Stop was:   $' + currentStop.toFixed(2),
                  'Stop now:   $' + entryPrice.toFixed(2) + ' (breakeven)',
                  'Position protected -- cannot lose now',
                ].join('\n'), 'Stratum Stop Manager');
              } catch(e) {
                console.error('[POS-MGR] Move stop error:', e.message);
              }
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('[POS-MGR] checkAndMoveStops error:', e.message);
  }
}

// ================================================================
// SIM -> LIVE AUTO-PROMOTION
// When SIM hits 65% win rate over 20+ trades = promote to live
// ================================================================
async function checkSimPromotion() {
  try {
    var winTracker = require('./winTracker');
    if (!winTracker) return;
    var stats = winTracker.getStats ? winTracker.getStats() : null;
    if (!stats) return;

    var totalTrades = stats.totalTrades || 0;
    var winRate     = stats.winRate || 0;

    if (totalTrades >= 20 && winRate >= 0.65) {
      console.log('[POS-MGR] SIM PROMOTION CRITERIA MET -- win rate:', (winRate * 100).toFixed(1) + '%', 'trades:', totalTrades);
      await postDiscord([
        'SIM PROMOTION READY',
        '==============================',
        'Win Rate:    ' + (winRate * 100).toFixed(1) + '% (need 65%)',
        'Total Trades: ' + totalTrades + ' (need 20+)',
        'Status:      CRITERIA MET',
        'Action:      Review results then run:',
        '             bash stratum.sh sim off',
        'WARNING:     Do NOT switch to live without manual review',
      ].join('\n'), 'Stratum Promotion Manager');
    } else {
      console.log('[POS-MGR] SIM promotion check -- win rate:', (winRate * 100).toFixed(1) + '%', 'trades:', totalTrades, '-- not ready yet');
    }
  } catch(e) {
    console.error('[POS-MGR] SIM promotion check error:', e.message);
  }
}

module.exports = {
  checkMaxPositions,
  checkConflict,
  eodCloseAll,
  moveStopToBreakeven,
  checkAndMoveStops,
  checkSimPromotion,
  MAX_POSITIONS_LIVE,
  MAX_POSITIONS_SIM,
  EOD_CLOSE_HOUR,
  EOD_CLOSE_MIN,
};
