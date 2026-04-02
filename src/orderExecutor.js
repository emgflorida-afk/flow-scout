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
function getBaseUrl(account, liveBypass) {
  // liveBypass=true means ALWAYS use live API (John's ideas bypass simMode)
  if (liveBypass === true) {
    console.log('[EXECUTOR] liveBypass -- forcing LIVE API for:', account);
    return TS_LIVE;
  }
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

  // DAILY EXPOSURE TRACKER
// Tracks total risk deployed today across all trades
// Resets at midnight ET
var dailyRiskDeployed = 0;
var dailyRiskDate     = '';

function getTodayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetDailyRiskIfNewDay() {
  var today = getTodayET();
  if (dailyRiskDate !== today) {
    dailyRiskDeployed = 0;
    dailyRiskDate     = today;
    console.log('[RISK] Daily exposure reset for new day:', today);
  }
}

function checkDailyExposure(riskAmount, accountEquity) {
  resetDailyRiskIfNewDay();
  var maxDailyRisk    = (accountEquity || 19268) * 0.02; // 2% of account
  var projectedTotal  = dailyRiskDeployed + riskAmount;
  if (projectedTotal > maxDailyRisk) {
    console.log('[RISK] DAILY EXPOSURE BLOCKED -- deployed:$' + dailyRiskDeployed.toFixed(0) +
      ' + this:$' + riskAmount.toFixed(0) + ' = $' + projectedTotal.toFixed(0) +
      ' exceeds 2% limit of $' + maxDailyRisk.toFixed(0));
    return { allowed: false, deployed: dailyRiskDeployed, limit: maxDailyRisk, projected: projectedTotal };
  }
  return { allowed: true, deployed: dailyRiskDeployed, limit: maxDailyRisk, projected: projectedTotal };
}

function recordTradeRisk(riskAmount) {
  resetDailyRiskIfNewDay();
  dailyRiskDeployed += riskAmount;
  console.log('[RISK] Trade recorded -- risk:$' + riskAmount.toFixed(0) +
    ' total today:$' + dailyRiskDeployed.toFixed(0));
}

// DYNAMIC T1 -- if no T1 passed in, calculate based on ticker volatility
  // High vol (TSLA, COIN, NVDA, MRVL) = 50% target
  // Medium vol (AAPL, AMZN, MSFT, GOOGL) = 40% target
  // Financials/others (JPM, GS) = 35% target
  if (!t1 && limit) {
    var HIGH_VOL_T = ['TSLA', 'COIN', 'MRVL', 'NVDA'];
    var MED_VOL_T  = ['AAPL', 'AMZN', 'MSFT', 'GOOGL', 'META'];
    var baseTicker = (symbol || '').split(' ')[0].toUpperCase();
    var t1Mult;
    if (HIGH_VOL_T.indexOf(baseTicker) > -1)    t1Mult = 1.50;
    else if (MED_VOL_T.indexOf(baseTicker) > -1) t1Mult = 1.40;
    else                                          t1Mult = 1.35;
    t1 = parseFloat((parseFloat(limit) * t1Mult).toFixed(2));
    console.log('[EXECUTOR] Dynamic T1:', baseTicker, 'mult:', t1Mult, 'entry:$' + limit, 'T1:$' + t1);
  }

  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    // SMART CONTRACT SIZING -- based on account size and premium
    // Overrides qty if it exceeds safe sizing for account
    try {
      var premium    = parseFloat(limit);
      var orderCost  = premium * 100; // cost per contract
      var acctSize   = 19268;         // approximate live account size
      var maxRisk2pct = acctSize * 0.02; // $385 max risk

      // Premium-based sizing rules for $19K account:
      // Under $1.00 = max 3 contracts
      // $1.00-$2.00 = max 2 contracts
      // $2.00-$4.00 = max 1 contract
      // Over $4.00  = max 1 contract
      var premiumLimit;
      if      (premium < 1.00) premiumLimit = 3;
      else if (premium < 2.00) premiumLimit = 2;
      else                     premiumLimit = 1;

      // Also cap by 2% risk rule
      var riskLimit = Math.max(1, Math.floor(maxRisk2pct / orderCost));

      // Take the more conservative of the two
      var maxAllowed = Math.min(premiumLimit, riskLimit);
      if (qty > maxAllowed) {
        console.log('[EXECUTOR] Qty reduced from ' + qty + ' to ' + maxAllowed +
          ' -- premium $' + premium + ' risk limit $' + maxRisk2pct.toFixed(0));
        qty = maxAllowed;
      }
    } catch(e) { /* sizing check skipped */ }

    // DAILY EXPOSURE CHECK -- block if 2% daily risk limit hit
    try {
      var riskPerContract = stop ? Math.abs(parseFloat(limit) - parseFloat(stop)) * 100 : parseFloat(limit) * 0.40 * 100;
      var totalRisk       = riskPerContract * (qty || 1);
      var equityForCheck  = 19268; // approximate -- updated by portfolio check below
      var exposureCheck   = checkDailyExposure(totalRisk, equityForCheck);
      if (!exposureCheck.allowed) {
        var msg = 'Daily 2% risk limit hit -- deployed:$' + exposureCheck.deployed.toFixed(0) +
          ' + this trade:$' + totalRisk.toFixed(0) + ' = $' + exposureCheck.projected.toFixed(0) +
          ' exceeds limit of $' + exposureCheck.limit.toFixed(0);
        console.log('[EXECUTOR] BLOCKED --', msg);
        return { error: msg };
      }
    } catch(e) { console.log('[RISK] Exposure check skipped:', e.message); }

    // MAX POSITIONS CHECK -- block if too many open positions
    try {
      var posMgr = require('./positionManager');
      var maxCheck = await posMgr.checkMaxPositions(account);
      if (!maxCheck.allowed) {
        console.log('[EXECUTOR] BLOCKED -- max positions hit:', maxCheck.current, '/', maxCheck.max);
        return { error: 'Max positions hit -- ' + maxCheck.current + '/' + maxCheck.max + ' open. Close a position first.' };
      }
    } catch(e) { /* position manager not loaded -- continue */ }

    // CONFLICT CHECK -- no opposite side same ticker
    try {
      var posMgr2  = require('./positionManager');
      var ticker2  = symbol.split(' ')[0].replace(/[0-9]/g, '').toUpperCase();
      var dir2     = symbol.includes('C') ? 'call' : 'put';
      var conflict = await posMgr2.checkConflict(account, ticker2, dir2);
      if (!conflict.allowed) {
        console.log('[EXECUTOR] BLOCKED -- conflict:', ticker2, 'already have', conflict.conflict, 'cannot open', dir2);
        return { error: 'Conflict block -- already have ' + conflict.conflict + ' on ' + ticker2 + '. Cannot open ' + dir2 };
      }
    } catch(e) { /* position manager not loaded -- continue */ }

    // DYNAMIC BIAS CHECK -- block if trading against current bias
    try {
      var dynamicBias = require('./dynamicBias');
      var direction   = (action === 'BUYTOOPEN') 
        ? (symbol.includes('C') ? 'call' : 'put')
        : null;
      if (direction && !dynamicBias.isAllowed(direction)) {
        var bias = dynamicBias.getBias();
        console.log('[EXECUTOR] BLOCKED -- trading against bias:', bias.bias, bias.strength, 'direction:', direction);
        return { error: 'Bias block -- current bias is ' + bias.bias + ' (' + bias.strength + '), cannot open ' + direction };
      }
    } catch(e) { /* dynamic bias not loaded -- continue */ }

    // DAILY LOSS LIMIT CHECK -- block if limit hit
    try {
      var lossLimit = require('./dailyLossLimit');
      if (lossLimit.isBlocked(account)) {
        console.log('[EXECUTOR] BLOCKED -- daily loss limit hit for account:', account);
        return { error: 'Daily loss limit hit -- no new positions allowed today' };
      }
    } catch(e) { /* loss limit module not loaded -- continue */ }

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

    // PORTFOLIO-AWARE POSITION SIZING
    // Check buying power before placing order
    // Never risk more than 2% of account on single trade
    try {
      var tsCheck    = require('./tradestation');
      var tokenCheck = await tsCheck.getAccessToken();
      if (tokenCheck) {
        var baseCheck = getBaseUrl(account);
        var balRes    = await fetch(baseCheck + '/brokerage/accounts/' + account + '/balances', {
          headers: { 'Authorization': 'Bearer ' + tokenCheck }
        });
        var balData   = await balRes.json();
        var balArr    = balData.Balances || balData.balances || [];
        var bal       = balArr[0] || {};
        var buyingPower = parseFloat(bal.BuyingPower || bal.CashBalance || 0);
        var equity      = parseFloat(bal.Equity || buyingPower);

        // Hard stops
        var orderCost   = parseFloat(limit) * qty * 100;
        var maxRisk     = equity * 0.02; // 2% of account
        var minBP       = 300;           // minimum buying power gate

        if (buyingPower < minBP) {
          console.log('[EXECUTOR] BLOCKED -- buying power $' + buyingPower + ' below $' + minBP + ' gate');
          return { error: 'Buying power gate -- $' + buyingPower + ' available, minimum $' + minBP + ' required' };
        }

        if (orderCost > maxRisk && equity > 1000) {
          // Reduce qty to fit within 2% risk
          var maxQty = Math.max(1, Math.floor(maxRisk / (parseFloat(limit) * 100)));
          if (maxQty < qty) {
            console.log('[EXECUTOR] Qty reduced from ' + qty + ' to ' + maxQty + ' -- 2% risk rule ($' + maxRisk.toFixed(0) + ' max)');
            qty = maxQty;
          }
        }

        console.log('[EXECUTOR] Portfolio check OK -- BP:$' + buyingPower + ' equity:$' + equity + ' orderCost:$' + orderCost.toFixed(0) + ' qty:' + qty);
      }
    } catch(e) {
      console.log('[EXECUTOR] Portfolio check skipped:', e.message);
    }

    var base = getBaseUrl(account, params.liveBypass || false);
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
  // DAILY EXPOSURE TRACKER
// Tracks total risk deployed today across all trades
// Resets at midnight ET
var dailyRiskDeployed = 0;
var dailyRiskDate     = '';

function getTodayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetDailyRiskIfNewDay() {
  var today = getTodayET();
  if (dailyRiskDate !== today) {
    dailyRiskDeployed = 0;
    dailyRiskDate     = today;
    console.log('[RISK] Daily exposure reset for new day:', today);
  }
}

function checkDailyExposure(riskAmount, accountEquity) {
  resetDailyRiskIfNewDay();
  var maxDailyRisk    = (accountEquity || 19268) * 0.02; // 2% of account
  var projectedTotal  = dailyRiskDeployed + riskAmount;
  if (projectedTotal > maxDailyRisk) {
    console.log('[RISK] DAILY EXPOSURE BLOCKED -- deployed:$' + dailyRiskDeployed.toFixed(0) +
      ' + this:$' + riskAmount.toFixed(0) + ' = $' + projectedTotal.toFixed(0) +
      ' exceeds 2% limit of $' + maxDailyRisk.toFixed(0));
    return { allowed: false, deployed: dailyRiskDeployed, limit: maxDailyRisk, projected: projectedTotal };
  }
  return { allowed: true, deployed: dailyRiskDeployed, limit: maxDailyRisk, projected: projectedTotal };
}

function recordTradeRisk(riskAmount) {
  resetDailyRiskIfNewDay();
  dailyRiskDeployed += riskAmount;
  console.log('[RISK] Trade recorded -- risk:$' + riskAmount.toFixed(0) +
    ' total today:$' + dailyRiskDeployed.toFixed(0));
}

// DYNAMIC T1 -- if no T1 passed in, calculate based on ticker volatility
  // High vol (TSLA, COIN, NVDA, MRVL) = 50% target
  // Medium vol (AAPL, AMZN, MSFT, GOOGL) = 40% target
  // Financials/others (JPM, GS) = 35% target
  if (!t1 && limit) {
    var HIGH_VOL_T = ['TSLA', 'COIN', 'MRVL', 'NVDA'];
    var MED_VOL_T  = ['AAPL', 'AMZN', 'MSFT', 'GOOGL', 'META'];
    var baseTicker = (symbol || '').split(' ')[0].toUpperCase();
    var t1Mult;
    if (HIGH_VOL_T.indexOf(baseTicker) > -1)    t1Mult = 1.50;
    else if (MED_VOL_T.indexOf(baseTicker) > -1) t1Mult = 1.40;
    else                                          t1Mult = 1.35;
    t1 = parseFloat((parseFloat(limit) * t1Mult).toFixed(2));
    console.log('[EXECUTOR] Dynamic T1:', baseTicker, 'mult:', t1Mult, 'entry:$' + limit, 'T1:$' + t1);
  }

  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    var base = getBaseUrl(account, params.liveBypass || false);

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
