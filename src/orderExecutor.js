// orderExecutor.js -- Stratum v7.4
// DIRECT ORDER EXECUTION via TradeStation API
// Bypasses MCP limitation -- places orders directly
// Supports LIVE and SIM accounts
// Called from /webhook/execute endpoint
// Full bracket: entry + stop + T1 in one order using OSO

var fetch = require('node-fetch');

var TS_LIVE = 'https://api.tradestation.com/v3';
var TS_SIM  = 'https://sim-api.tradestation.com/v3';

// ================================================================
// GET BASE URL -- live vs sim
// ================================================================
function getBaseUrl(account) {
  // SIM accounts start with SIM
  if (account && account.toUpperCase().startsWith('SIM')) {
    return TS_SIM;
  }
  return TS_LIVE;
}

// ================================================================
// PLACE ORDER WITH FULL BRACKET
// Entry limit + stop + T1 in one OSO order
// ================================================================
async function placeOrder(params) {
  var {
    account,
    symbol,
    action,      // BUYTOOPEN, SELLTOCLOSE etc
    qty,
    limit,       // entry limit price
    stop,        // stop loss price
    t1,          // take profit 1
    t2,          // take profit 2 (optional runner)
    duration,    // GTC or DAY
    note,        // for logging
  } = params;

  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    // Convert OPRA format to TradeStation format
    // NVDA260406C00175000 -> NVDA 260406C175
    // NVDA260406C00177500 -> NVDA 260406C177.5
    if (symbol && symbol.indexOf(' ') === -1 && /^[A-Z]/.test(symbol)) {
      var om = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (om) {
        var whole2  = parseInt(om[4].slice(0, 5), 10);
        var dec2    = parseInt(om[4].slice(5), 10);
        var strike2 = dec2 === 0 ? String(whole2) : String(whole2) + '.' + String(dec2).replace(/0+$/, '');
        symbol = om[1] + ' ' + om[2] + om[3] + strike2;
        console.log('[EXECUTOR] Converted symbol to TS format:', symbol);
      }
    }

    // Round price to nearest valid increment (options use $0.05 above $3, $0.01 below)
    function roundToIncrement(price) {
      if (!price) return price;
      var p = parseFloat(price);
      if (p >= 3) return Math.round(p / 0.05) * 0.05;
      return Math.round(p / 0.01) * 0.01;
    }
    limit = roundToIncrement(limit);
    if (stop) stop = roundToIncrement(stop);
    if (t1)   t1   = roundToIncrement(t1);
    if (t2)   t2   = roundToIncrement(t2);

    var base = getBaseUrl(account);
    console.log('[EXECUTOR] Placing order on', base, '-- account:', account);
    console.log('[EXECUTOR] Order:', symbol, action, qty, 'x @ $' + limit);

    // Build OSO bracket orders (fire after parent fills)
    var osos = [];

    if (stop || t1) {
      var bracketOrders = [];

      // Stop loss
      if (stop) {
        bracketOrders.push({
          AccountID:   account,
          Symbol:      symbol,
          Quantity:    String(qty),
          OrderType:   'StopMarket',
          StopPrice:   String(stop),
          TradeAction: action === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
          TimeInForce: { Duration: duration || 'GTC' },
          Route:       'Intelligent',
        });
      }

      // T1 take profit
      if (t1) {
        bracketOrders.push({
          AccountID:   account,
          Symbol:      symbol,
          Quantity:    String(qty),
          OrderType:   'Limit',
          LimitPrice:  String(t1),
          TradeAction: action === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
          TimeInForce: { Duration: duration || 'GTC' },
          Route:       'Intelligent',
        });
      }

      if (bracketOrders.length > 0) {
        osos.push({
          Type:   bracketOrders.length === 2 ? 'BRK' : 'NORMAL',
          Orders: bracketOrders,
        });
      }
    }

    // Build main entry order
    var orderBody = {
      AccountID:   account,
      Symbol:      symbol,
      Quantity:    String(qty),
      OrderType:   'Limit',
      LimitPrice:  String(limit),
      TradeAction: action,
      TimeInForce: { Duration: duration || 'GTC' },
      Route:       'Intelligent',
    };

    // Attach bracket if we have one
    if (osos.length > 0) {
      orderBody.OSOs = osos;
    }

    console.log('[EXECUTOR] Order body:', JSON.stringify(orderBody, null, 2));

    // Place the order
    var res = await fetch(base + '/orderexecution/orders', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    var data = await res.json();
    console.log('[EXECUTOR] Response:', JSON.stringify(data));

    if (!res.ok) {
      return { error: 'Order failed: ' + JSON.stringify(data), status: res.status };
    }

    var orders = data.Orders || [data];
    var orderId = orders[0] && (orders[0].OrderID || orders[0].orderId);

    console.log('[EXECUTOR] Order placed OK -- ID:', orderId);

    return {
      success:  true,
      orderId:  orderId,
      symbol:   symbol,
      account:  account,
      qty:      qty,
      limit:    limit,
      stop:     stop,
      t1:       t1,
      t2:       t2,
      bracketSet: !!(stop || t1),
      response: data,
    };

  } catch(e) {
    console.error('[EXECUTOR] Error:', e.message);
    return { error: e.message };
  }
}

// ================================================================
// CLOSE POSITION
// ================================================================
async function closePosition(account, symbol, qty) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    var base = getBaseUrl(account);

    var orderBody = {
      AccountID:   account,
      Symbol:      symbol,
      Quantity:    String(qty),
      OrderType:   'Market',
      TradeAction: 'SELLTOCLOSE',
      TimeInForce: { Duration: 'DAY' },
      Route:       'Intelligent',
    };

    var res = await fetch(base + '/orderexecution/orders', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    var data = await res.json();
    if (!res.ok) return { error: JSON.stringify(data) };

    return { success: true, orderId: data.Orders && data.Orders[0] && data.Orders[0].OrderID };
  } catch(e) {
    return { error: e.message };
  }
}

module.exports = { placeOrder, closePosition, getBaseUrl };
