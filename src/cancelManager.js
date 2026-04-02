// cancelManager.js -- Stratum v7.4
// Auto-cancel unfilled orders based on two rules:
// Rule 1: TIME -- cancel if no fill after 90 minutes
// Rule 2: PRICE -- cancel if price moved 30%+ away from entry (move already happened)

var fetch = require('node-fetch');

var TS_LIVE = 'https://api.tradestation.com/v3';
var TS_SIM  = 'https://sim-api.tradestation.com/v3';

var CANCEL_AFTER_MS     = 90 * 60 * 1000;  // 90 minutes
var PRIME_TIME_END_ET   = 11 * 60;          // 11:00AM ET in minutes
var MOVE_THRESHOLD      = 0.30;             // 30% move = cancel

// Track pending orders
// { orderId, symbol, account, entryLimit, firedAt, direction }
var pendingOrders = {};

function getBaseUrl(account) {
  return (account && account.toUpperCase().startsWith('SIM')) ? TS_SIM : TS_LIVE;
}

function getETMinutes() {
  var now    = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  return etHour * 60 + now.getUTCMinutes();
}

// Register an order for cancel tracking
function trackOrder(params) {
  var { orderId, symbol, account, entryLimit, direction, ticker } = params;
  if (!orderId) return;
  pendingOrders[orderId] = {
    orderId:    orderId,
    symbol:     symbol,
    ticker:     ticker,
    account:    account,
    entryLimit: parseFloat(entryLimit),
    direction:  direction,
    firedAt:    Date.now(),
  };
  console.log('[CANCEL-MGR] Tracking order:', orderId, ticker, 'limit $' + entryLimit);
}

// Check all pending orders -- cancel if rules triggered
async function checkPendingOrders() {
  var keys = Object.keys(pendingOrders);
  if (keys.length === 0) return;

  var now   = Date.now();
  var etMin = getETMinutes();

  for (var i = 0; i < keys.length; i++) {
    var order = pendingOrders[keys[i]];
    var age   = now - order.firedAt;

    // Rule 1: TIME CANCEL -- 90 min passed or past 11AM ET
    var timeExpired   = age > CANCEL_AFTER_MS;
    var pastPrimeTime = etMin > PRIME_TIME_END_ET;

    if (timeExpired || pastPrimeTime) {
      var reason = timeExpired ? '90 min -- no fill' : 'Past 11AM prime time';
      await cancelOrder(order, reason);
      continue;
    }

    // Rule 2: PRICE CANCEL -- move already happened
    try {
      var ts    = require('./tradestation');
      var token = await ts.getAccessToken();
      if (!token) continue;

      var base = getBaseUrl(order.account);
      var res  = await fetch(base + '/marketdata/quotes/' + order.ticker, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var data = await res.json();
      var quote = data.Quotes && data.Quotes[0];
      if (!quote) continue;

      var currentAsk = parseFloat(quote.Ask || quote.Last || 0);
      if (!currentAsk || !order.entryLimit) continue;

      var pctMove = Math.abs(currentAsk - order.entryLimit) / order.entryLimit;

      if (pctMove > MOVE_THRESHOLD) {
        await cancelOrder(order, 'Move already happened -- price ' + (pctMove * 100).toFixed(0) + '% from entry');
        continue;
      }
    } catch(e) {
      console.error('[CANCEL-MGR] Price check error:', e.message);
    }
  }
}

async function cancelOrder(order, reason) {
  try {
    console.log('[CANCEL-MGR] Canceling order:', order.orderId, '--', reason);

    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return;

    var base = getBaseUrl(order.account);
    var res  = await fetch(base + '/orderexecution/orders/' + order.orderId, {
      method:  'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });

    var data = await res.json();
    console.log('[CANCEL-MGR] Cancel response:', JSON.stringify(data));

    // Post to Discord
    var msg = [
      'ORDER CANCELED -- ' + order.account,
      order.ticker + ' ' + (order.symbol || ''),
      '===============================',
      'Reason:    ' + reason,
      'Entry was: $' + order.entryLimit,
      'Order ID:  ' + order.orderId,
      'Action:    Order removed -- no fill',
    ].join('\n');

    var webhookUrl = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
      'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + msg + '\n```', username: 'Stratum Cancel' })
    });

    delete pendingOrders[order.orderId];
    console.log('[CANCEL-MGR] Order canceled and removed from tracking:', order.orderId);

  } catch(e) {
    console.error('[CANCEL-MGR] Cancel error:', e.message);
  }
}

// Remove order from tracking when filled
function orderFilled(orderId) {
  if (pendingOrders[orderId]) {
    console.log('[CANCEL-MGR] Order filled -- removed from tracking:', orderId);
    delete pendingOrders[orderId];
  }
}

module.exports = { trackOrder, checkPendingOrders, orderFilled };
