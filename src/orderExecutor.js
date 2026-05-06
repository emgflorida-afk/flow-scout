// orderExecutor.js -- Stratum v7.5
// DIRECT ORDER EXECUTION via TradeStation API
// Bypasses MCP limitation -- places orders directly
// Supports LIVE and SIM accounts
// Called from /webhook/execute endpoint
// Full bracket: entry + stop + T1 in one order using OSO
// FIXED v7.5: decimal precision rounding, removed duplicate code blocks

'use strict';

var fetch = require('node-fetch');

var TS_LIVE = 'https://api.tradestation.com/v3';
var TS_SIM  = 'https://sim-api.tradestation.com/v3';

// AUTOFIRE GATE wiring (Apr 29 2026): when TS rejects with "Day trading margin
// rules" we engage TS-LOCK to freeze new fires until next 9:30 ET. We require
// it lazily so a missing/broken autoFireGate doesn't break order execution.
function _autoFireGate() {
  try { return require('./autoFireGate'); } catch(e) { return null; }
}
function _maybeEngageTSLock(rejectionMessage) {
  try {
    var afg = _autoFireGate();
    if (afg && typeof afg.triggerTSLock === 'function') {
      afg.triggerTSLock(rejectionMessage);
    }
  } catch(e) { console.error('[EXECUTOR] TS-LOCK engage error:', e.message); }
}

// ================================================================
// PRICE ROUNDING -- prevents floating point artifacts
// e.g. 1.15 * 0.75 = 1.1500000000000001 -> round to 1.15
// ================================================================
function round2(n) {
  return parseFloat(Math.round(parseFloat(n) * 100) / 100).toFixed(2);
}

// ================================================================
// DAILY EXPOSURE TRACKER
// Tracks total risk deployed today across all trades
// Resets at midnight ET
// ================================================================
var dailyRiskDeployed = 0;
var dailyRiskDate     = '';
// Re-entry cooldown: symbol -> timestamp of last SELLTOCLOSE fill.
// Prevents re-buying same contract within 15 min of closing it.
// Committed Apr 17 2026 after SPY 260416C702 +$12 -> re-entry -$28 chop.
var _lastSellBySymbol = {};

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
  var maxDailyRisk   = (accountEquity || 19268) * 0.02;
  var projectedTotal = dailyRiskDeployed + riskAmount;
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

// ================================================================
// GET BASE URL -- live vs sim
// ================================================================
function getBaseUrl(account, liveBypass) {
  if (liveBypass === true) {
    console.log('[EXECUTOR] liveBypass -- forcing LIVE API for:', account);
    return TS_LIVE;
  }
  if (account && account.toUpperCase().startsWith('SIM')) {
    return TS_SIM;
  }
  return TS_LIVE;
}

// ================================================================
// ROUND TO VALID OPTION PRICE INCREMENT
// Options use $0.05 above $3, $0.01 below $3
// ================================================================
function roundToIncrement(price) {
  if (!price) return price;
  var p = parseFloat(price);
  if (p >= 3) return parseFloat((Math.round(p / 0.05) * 0.05).toFixed(2));
  return parseFloat((Math.round(p / 0.01) * 0.01).toFixed(2));
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
    trigger,     // Apr 26 2026: { symbol, predicate ('above'|'below'), price }
                 // attaches TS MarketActivationRules so order queues until
                 // underlying crosses trigger. Bypasses RTH gate (GTC-queued).
  } = params;

  // Apr 26 PM — manualFire flag bypasses time-based gates. Set by
  // /api/take-trade for human-click-through fires (FLOW CARDS button,
  // TOMORROW tab FIRE NOW). The human is the gate; the time-of-day
  // restrictions exist to prevent AUTO-fire in chop hours, not to gate
  // intentional manual entries the trader has already eyeballed.
  var manualFire = params.manualFire === true;

  // ================================================================
  // GATES — split into time-based (skipped for conditional/manual) and
  // contract-based (always enforced). Conditional orders queue at TS;
  // manual orders are deliberate clicks. Time gates don't apply to either.
  // ================================================================
  if (action === 'BUYTOOPEN') {
    var etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    var timePart = etStr.split(', ')[1] || etStr;
    var tParts = timePart.split(':');
    var etH = parseInt(tParts[0], 10);
    var etM = parseInt(tParts[1], 10);
    var etTotal = etH * 60 + etM;
    var dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });

    // TIME-BASED GATES — skipped if conditional order (trigger present)
    if (!trigger && !manualFire) {
      if (dayOfWeek === 'Sat' || dayOfWeek === 'Sun') {
        console.log('[EXECUTOR] BLOCKED -- weekend order attempted on', dayOfWeek);
        return { error: 'Market closed -- weekend. No orders allowed.' };
      }
      if (etTotal < (9 * 60 + 30) || etTotal >= (16 * 60)) {
        console.log('[EXECUTOR] BLOCKED -- outside RTH:', etH + ':' + (etM < 10 ? '0' : '') + etM, 'ET');
        return { error: 'Market closed -- outside 9:30AM-4PM ET. Current time: ' + etH + ':' + (etM < 10 ? '0' : '') + etM + ' ET' };
      }
    }

    // ============================================================
    // CONTRACT-BASED GATES — always enforced (blacklist, 0DTE, etc.)
    // ============================================================
    var baseTicker = (symbol || '').split(' ')[0].toUpperCase();

    // GATE: Blacklisted tickers -- hard reject regardless of signal grade
    // TSLA: per SESSION_START_RULES.md
    // BTC-correlated (Apr 18 2026): AB personal preference, BTC beta exposure
    // Apr 20 2026 AM: added high-IV small-cap names that keep stopping out on
    // gamma chop — UPST/RKLB/LUNR/HOOD/AFRM/HIMS/APP/SNAP/RDDT. AB's rule.
    // Apr 20 2026 PM: added MRVL (-$110 on Apr 17, Casey false-positive pattern).
    // Apr 26 PM — IREN removed. AB's symmetric-triangle / bull-flag setup
    // with FTFC alignment is structurally documented; he needs the option to
    // act on it this week. Remaining BTC-correlated names (TSLA/MSTR/COIN/etc.)
    // and high-IV chop names (UPST/APP/etc.) stay blacklisted.
    // Apr 27 — HOOD removed at AB's request. JSmith VIP 4/27 pick (86C 5/1
    // entry $85.05) gets the option to fire when triggered.
    // May 6 2026 — AB hard-blocked ADBE + CRM + SBUX after stop-outs. "Never again."
    var BLACKLIST = [
      'TSLA', 'MSTR', 'COIN', 'MARA', 'RIOT', 'WULF', 'BMNR', 'CLSK', 'HUT', 'BITF', 'CIFR', 'HIVE', 'SOFI',
      'UPST', 'RKLB', 'LUNR', 'AFRM', 'HIMS', 'APP', 'SNAP', 'RDDT',
      'MRVL', 'ADBE', 'CRM', 'SBUX'
    ];
    if (BLACKLIST.indexOf(baseTicker) !== -1) {
      console.log('[EXECUTOR] BLOCKED -- ' + baseTicker + ' is blacklisted');
      return { error: baseTicker + ' is blacklisted. Hard reject.' };
    }

    // GATE: 0DTE hard reject -- parse OSI YYMMDD from symbol
    // OSI format: "TSLA 260417C385" where 260417 = expiration
    try {
      var osiMatch = (symbol || '').match(/\s(\d{6})[CP]\d/);
      if (osiMatch) {
        var yy = parseInt(osiMatch[1].substring(0, 2), 10);
        var mm = parseInt(osiMatch[1].substring(2, 4), 10) - 1;
        var dd = parseInt(osiMatch[1].substring(4, 6), 10);
        var expDate = new Date(2000 + yy, mm, dd);
        var todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        todayET.setHours(0,0,0,0);
        var daysToExp = Math.round((expDate - todayET) / (1000 * 60 * 60 * 24));
        if (daysToExp <= 0) {
          console.log('[EXECUTOR] BLOCKED -- 0DTE contract ' + symbol + ' (exp ' + expDate.toISOString().slice(0,10) + ')');
          return { error: '0DTE blocked. ' + symbol + ' expires today. Per rule: no 0DTE.' };
        }
        if (daysToExp === 1) {
          // Check if market open (AM): allow 1DTE only in first 2 hours
          if (etTotal >= (11 * 60 + 30)) {
            console.log('[EXECUTOR] BLOCKED -- 1DTE after 11:30 AM: ' + symbol);
            return { error: '1DTE contract after 11:30 AM ET blocked. Theta crush zone.' };
          }
        }
      }
    } catch(e) { /* soft fail — don't block on parse error */ }

    // TIME-BASED GATES (skipped for conditional/queued orders)
    if (!trigger && !manualFire) {
      // GATE: First 15 min of open (9:30-9:45 AM ET) -- block all entries.
      if (etTotal >= (9 * 60 + 30) && etTotal < (9 * 60 + 45)) {
        console.log('[EXECUTOR] BLOCKED -- first 15 min ' + etH + ':' + (etM < 10 ? '0' : '') + etM + ' ET (wait for 9:45 candle close)');
        return { error: 'First-15-min block. No new entries 9:30-9:45 AM ET. Wait for opening bar to close. Current: ' + etH + ':' + (etM < 10 ? '0' : '') + etM + ' ET' };
      }

      // GATE: Dead zone (11:30 AM - 2:00 PM ET) -- no new entries, period
      if (etTotal >= (11 * 60 + 30) && etTotal < (14 * 60)) {
        console.log('[EXECUTOR] BLOCKED -- dead zone ' + etH + ':' + (etM < 10 ? '0' : '') + etM + ' ET (11:30 AM - 2 PM no-trade window)');
        return { error: 'Dead zone block. No new entries 11:30 AM - 2:00 PM ET. Current: ' + etH + ':' + (etM < 10 ? '0' : '') + etM + ' ET' };
      }

      // GATE: Re-entry cooldown -- 15 min after a sell of the SAME contract symbol
      var lastSellAt = _lastSellBySymbol[symbol];
      if (lastSellAt) {
        var minsSince = (Date.now() - lastSellAt) / 60000;
        if (minsSince < 15) {
          console.log('[EXECUTOR] BLOCKED -- re-entry cooldown ' + symbol + ' (' + minsSince.toFixed(1) + ' min since sell, need 15)');
          return { error: 'Re-entry cooldown: sold ' + symbol + ' ' + minsSince.toFixed(0) + ' min ago. Wait 15 min before buying back same contract.' };
        }
      }
    }

    // GATE: Market orders auto-convert to Limit on entry (fills suck at Market)
    // If caller passed no limit, compute one from current bid/ask or fail safely.
    if (!limit || limit === 0) {
      console.log('[EXECUTOR] BLOCKED -- Market order attempted without limit price. Set limit = ask + $0.05 and retry.');
      return { error: 'Market orders not allowed for entries. Pass a limit price (ask + $0.05 recommended).' };
    }
  }

  // Track sells for re-entry cooldown
  if (action === 'SELLTOCLOSE') {
    _lastSellBySymbol[symbol] = Date.now();
  }

  // DYNAMIC T1 -- if no T1 passed in, calculate based on ticker volatility
  // High vol (TSLA, COIN, NVDA, MRVL) = 50% target
  // Medium vol (AAPL, AMZN, MSFT, GOOGL) = 40% target
  // Others = 35% target
  if (!t1 && limit) {
    var HIGH_VOL_T = ['TSLA', 'COIN', 'MRVL', 'NVDA'];
    var MED_VOL_T  = ['AAPL', 'AMZN', 'MSFT', 'GOOGL', 'META'];
    var baseTicker = (symbol || '').split(' ')[0].toUpperCase();
    var t1Mult;
    if (HIGH_VOL_T.indexOf(baseTicker) > -1)     t1Mult = 1.50;
    else if (MED_VOL_T.indexOf(baseTicker) > -1)  t1Mult = 1.40;
    else                                           t1Mult = 1.35;
    t1 = parseFloat((parseFloat(limit) * t1Mult).toFixed(2));
    console.log('[EXECUTOR] Dynamic T1:', baseTicker, 'mult:', t1Mult, 'entry:$' + limit, 'T1:$' + t1);
  }

  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    // SMART CONTRACT SIZING -- based on account size and premium
    try {
      var premium     = parseFloat(limit);
      var acctSize    = 19268;
      var maxRisk2pct = acctSize * 0.02;

      var premiumLimit;
      if      (premium < 1.00) premiumLimit = 3;
      else if (premium < 2.00) premiumLimit = 2;
      else                     premiumLimit = 1;

      var orderCostSizing = premium * 100;
      var riskLimit = Math.max(1, Math.floor(maxRisk2pct / orderCostSizing));
      var maxAllowed = Math.min(premiumLimit, riskLimit);

      if (qty > maxAllowed) {
        console.log('[EXECUTOR] Qty reduced from ' + qty + ' to ' + maxAllowed +
          ' -- premium $' + premium + ' risk limit $' + maxRisk2pct.toFixed(0));
        qty = maxAllowed;
      }
    } catch(e) { console.log('[EXECUTOR] Static sizing check skipped:', e.message); }

    // DAILY EXPOSURE CHECK -- HARD BLOCK on failure
    try {
      var riskPerContract = stop
        ? Math.abs(parseFloat(limit) - parseFloat(stop)) * 100
        : parseFloat(limit) * 0.40 * 100;
      var totalRisk      = riskPerContract * (qty || 1);
      var equityForCheck = (account === '11975462') ? 19268 : 50000;
      var exposureCheck  = checkDailyExposure(totalRisk, equityForCheck);
      if (!exposureCheck.allowed) {
        var msg = 'Daily 2% risk limit hit -- deployed:$' + exposureCheck.deployed.toFixed(0) +
          ' + this trade:$' + totalRisk.toFixed(0) + ' = $' + exposureCheck.projected.toFixed(0) +
          ' exceeds limit of $' + exposureCheck.limit.toFixed(0);
        console.log('[EXECUTOR] BLOCKED --', msg);
        return { error: msg };
      }
    } catch(e) {
      console.error('[RISK] EXPOSURE CHECK FAILED -- BLOCKING ORDER:', e.message);
      return { error: 'Safety gate failed (exposure check): ' + e.message };
    }

    // MAX POSITIONS CHECK -- HARD BLOCK on failure
    try {
      var posMgr   = require('./positionManager');
      var maxCheck = await posMgr.checkMaxPositions(account);
      if (!maxCheck.allowed) {
        console.log('[EXECUTOR] BLOCKED -- max positions hit:', maxCheck.current, '/', maxCheck.max);
        return { error: 'Max positions hit -- ' + maxCheck.current + '/' + maxCheck.max + ' open. Close a position first.' };
      }
    } catch(e) {
      console.error('[EXECUTOR] POSITION CHECK FAILED -- BLOCKING ORDER:', e.message);
      return { error: 'Safety gate failed (position check): ' + e.message };
    }

    // CONFLICT CHECK -- no opposite side same ticker -- HARD BLOCK on failure
    try {
      var posMgr2  = require('./positionManager');
      var ticker2  = symbol.split(' ')[0].replace(/[0-9]/g, '').toUpperCase();
      var dir2     = symbol.includes('C') ? 'call' : 'put';
      var conflict = await posMgr2.checkConflict(account, ticker2, dir2);
      if (!conflict.allowed) {
        console.log('[EXECUTOR] BLOCKED -- conflict:', ticker2, 'already have', conflict.conflict, 'cannot open', dir2);
        return { error: 'Conflict block -- already have ' + conflict.conflict + ' on ' + ticker2 + '. Cannot open ' + dir2 };
      }
    } catch(e) {
      console.error('[EXECUTOR] CONFLICT CHECK FAILED -- BLOCKING ORDER:', e.message);
      return { error: 'Safety gate failed (conflict check): ' + e.message };
    }

    // DYNAMIC BIAS CHECK -- soft fail OK (bias is supplementary)
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
    } catch(e) { console.log('[EXECUTOR] Dynamic bias check skipped:', e.message); }

    // DAILY LOSS LIMIT CHECK -- HARD BLOCK on failure
    try {
      var lossLimit = require('./dailyLossLimit');
      if (lossLimit.isBlocked(account)) {
        console.log('[EXECUTOR] BLOCKED -- daily loss limit hit for account:', account);
        return { error: 'Daily loss limit hit -- no new positions allowed today' };
      }
    } catch(e) {
      console.error('[EXECUTOR] LOSS LIMIT CHECK FAILED -- BLOCKING ORDER:', e.message);
      return { error: 'Safety gate failed (loss limit check): ' + e.message };
    }

    // CONVERT OPRA FORMAT TO TRADESTATION FORMAT
    // NVDA260406C00175000 -> NVDA 260406C175
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

    // ROUND ALL PRICES TO VALID INCREMENTS + apply round2 to prevent float artifacts
    limit = round2(roundToIncrement(limit));
    if (stop) stop = round2(roundToIncrement(stop));
    if (t1)   t1   = round2(roundToIncrement(t1));
    if (t2)   t2   = round2(roundToIncrement(t2));

    // PORTFOLIO-AWARE POSITION SIZING
    try {
      var tsCheck    = require('./tradestation');
      var tokenCheck = await tsCheck.getAccessToken();
      if (tokenCheck) {
        var baseCheck = getBaseUrl(account);
        var balRes    = await fetch(baseCheck + '/brokerage/accounts/' + account + '/balances', {
          headers: { 'Authorization': 'Bearer ' + tokenCheck }
        });
        var balData     = await balRes.json();
        var balArr      = balData.Balances || balData.balances || [];
        var bal         = balArr[0] || {};
        var buyingPower = parseFloat(bal.BuyingPower || bal.CashBalance || 0);
        var equity      = parseFloat(bal.Equity || buyingPower);
        var orderCost   = parseFloat(limit) * qty * 100;
        var maxRisk     = equity * 0.02;
        var minBP       = 300;

        if (buyingPower < minBP) {
          console.log('[EXECUTOR] BLOCKED -- buying power $' + buyingPower + ' below $' + minBP + ' gate');
          return { error: 'Buying power gate -- $' + buyingPower + ' available, minimum $' + minBP + ' required' };
        }

        if (orderCost > maxRisk && equity > 1000) {
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

    // BUILD OSO BRACKET ORDERS
    var osos = [];

    // Apr 26 PM — structuralStop is the underlying-price activation for the
    // stop child. When present, the stop fires on UNDERLYING crossing the
    // structural level (not on option-price wicks). Tail-risk-event proof
    // because option mid wobbles can't trip it.
    //   structuralStop: { symbol, predicate ('above'|'below'), price }
    var structuralStop = params.structuralStop;

    if (stop || t1 || structuralStop) {
      var bracketOrders = [];

      // Apr 28 2026: PREFER option-premium StopLimit over structural Market.
      // AB feedback: structural Market got wicked out on KO Live Mover SIM —
      // underlying KO briefly crossed structural level → Market sell on option
      // dumped at terrible bid. StopLimit on option premium is wick-resistant
      // because the option itself has to trade at the stop price.
      if (stop) {
        // Option-premium StopLimit (wick-resistant, AB-preferred).
        var stopOffsetPct = parseFloat(process.env.STOP_LIMIT_OFFSET_PCT || '0.10');
        var stopLimitPrice = Math.max(0.01, parseFloat(stop) * (1 - stopOffsetPct));
        stopLimitPrice = Math.round(stopLimitPrice * 100) / 100;
        bracketOrders.push({
          AccountID:   account,
          Symbol:      symbol,
          Quantity:    String(qty),
          OrderType:   'StopLimit',
          StopPrice:   String(stop),
          LimitPrice:  String(stopLimitPrice),
          TradeAction: action === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
          TimeInForce: { Duration: duration || 'GTC' },
          Route:       'Intelligent',
        });
        console.log('[EXECUTOR] Stop=StopLimit ' + symbol + ' trigger $' + stop + ' limit $' + stopLimitPrice + ' (preferred over structural)');
      } else if (structuralStop && structuralStop.symbol && structuralStop.price) {
        // Apr 29 2026: Fixed bad-fills bug. AB SIM account showed GE/GM stops
        // coming in as Market orders -> bad fills. Now: prefer StopLimit on
        // the same symbol with a small slippage buffer; only fall back to
        // Market+ActivationRules when the structural symbol differs from the
        // order symbol (e.g., option order with stock-price trigger).
        var ssPred = (structuralStop.predicate || 'below').toLowerCase();
        var isSellStop = (ssPred === 'below' || ssPred === 'lt' || ssPred === 'lte');
        var ssLimitOffsetPct = parseFloat(process.env.STRUCTURAL_STOP_LIMIT_OFFSET_PCT || '0.005');  // 0.5%
        var ssTrigger = parseFloat(structuralStop.price);
        var ssLimit = isSellStop
          ? Math.max(0.01, ssTrigger * (1 - ssLimitOffsetPct))
          : ssTrigger * (1 + ssLimitOffsetPct);
        ssLimit = Math.round(ssLimit * 100) / 100;

        if (String(structuralStop.symbol).toUpperCase() === String(symbol).toUpperCase()) {
          // Same-symbol structural stop -> StopLimit (wick-resistant, no Market wreckage)
          bracketOrders.push({
            AccountID:   account,
            Symbol:      symbol,
            Quantity:    String(qty),
            OrderType:   'StopLimit',
            StopPrice:   String(ssTrigger.toFixed(2)),
            LimitPrice:  String(ssLimit),
            TradeAction: action === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
            TimeInForce: { Duration: duration || 'GTC' },
            Route:       'Intelligent',
          });
          console.log('[EXECUTOR] StructuralStop=StopLimit ' + symbol + ' trigger $' + ssTrigger.toFixed(2) + ' limit $' + ssLimit + ' (same-symbol, fixed Market bug)');
        } else {
          // Cross-symbol structural stop (e.g., option order with stock trigger)
          // No StopLimit equivalent in TS API for this; keep Market+ActivationRules
          // but warn loudly so we know it happened.
          var ssTsPred = (ssPred === 'above' || ssPred === 'gt' || ssPred === 'gte') ? 'Gt' : 'Lt';
          bracketOrders.push({
            AccountID:   account,
            Symbol:      symbol,
            Quantity:    String(qty),
            OrderType:   'Market',
            TradeAction: action === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
            TimeInForce: { Duration: duration || 'GTC' },
            Route:       'Intelligent',
            AdvancedOptions: {
              MarketActivationRules: [{
                RuleType:   'Price',
                Symbol:     String(structuralStop.symbol).toUpperCase(),
                Predicate:  ssTsPred,
                TriggerKey: 'STT',
                Price:      String(ssTrigger.toFixed(2)),
              }],
            },
          });
          console.warn('[EXECUTOR] StructuralStop=Market+Activation (cross-symbol ONLY: order=' + symbol + ', trigger-on=' + structuralStop.symbol + ') - StopLimit not available for cross-symbol triggers in TS API');
        }
      }

      if (t1) {
        bracketOrders.push({
          AccountID:   account,
          Symbol:      symbol,
          Quantity:    String(qty),
          OrderType:   'Limit',
          LimitPrice:  String(t1),        // already round2'd above
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

    // BUILD MAIN ENTRY ORDER
    var orderBody = {
      AccountID:   account,
      Symbol:      symbol,
      Quantity:    String(qty),
      OrderType:   'Limit',
      LimitPrice:  String(limit),         // already round2'd above
      TradeAction: action,
      TimeInForce: { Duration: duration || 'GTC' },
      Route:       'Intelligent',
    };

    // CONDITIONAL TRIGGER (Apr 26 2026) — TS MarketActivationRules
    // The bracket queues at TS until underlying price crosses trigger.
    // Activation fires the entry Limit order, which then attaches the OSO
    // bracket children (stop + TP).
    if (trigger && trigger.symbol && trigger.price && trigger.predicate) {
      var pred = trigger.predicate.toLowerCase();
      var tsPredicate = (pred === 'above' || pred === 'gt' || pred === 'gte') ? 'Gt' : 'Lt';
      orderBody.AdvancedOptions = {
        MarketActivationRules: [{
          RuleType:   'Price',
          Symbol:     String(trigger.symbol).toUpperCase(),
          Predicate:  tsPredicate,
          TriggerKey: 'STT',  // Single-Trade-Tick — fires on first tick crossing
          Price:      String(parseFloat(trigger.price).toFixed(2)),
        }],
      };
      console.log('[EXECUTOR] Conditional trigger attached:', trigger.symbol, tsPredicate, '$' + trigger.price);
    }

    if (osos.length > 0) {
      orderBody.OSOs = osos;
    }

    console.log('[EXECUTOR] Order body:', JSON.stringify(orderBody, null, 2));

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

    var orders  = data.Orders || [data];
    var orderId = orders[0] && (orders[0].OrderID || orders[0].orderId);

    // EMBEDDED REJECTION CHECK: TS can return 200 with rejection details
    // in data.Errors[] or orders[0].Error/Message
    var embeddedError = null;
    if (data.Errors && data.Errors.length > 0) {
      embeddedError = 'TS_REJ: ' + JSON.stringify(data.Errors);
    } else if (orders[0] && (orders[0].Error || orders[0].error)) {
      embeddedError = 'TS_REJ: ' + (orders[0].Error || orders[0].error);
    } else if (!orderId && orders[0] && orders[0].Message) {
      embeddedError = 'TS_REJ: ' + orders[0].Message;
    } else if (!orderId) {
      embeddedError = 'TS_REJ: No OrderID returned: ' + JSON.stringify(data);
    }
    if (embeddedError) {
      console.error('[EXECUTOR] REJECTED --', embeddedError);
      _maybeEngageTSLock(embeddedError);
      return { error: embeddedError, rejected: true, response: data };
    }

    console.log('[EXECUTOR] Order placed OK -- ID:', orderId);

    // POST-PLACEMENT VERIFICATION: Poll TS for status after 1.2s.
    // Catches rejections that land in the order record (REJ/CAN/EXP)
    // even though the POST returned 200.
    try {
      await new Promise(function(r){ setTimeout(r, 1200); });
      var verifyRes = await fetch(base + '/brokerage/accounts/' + account + '/orders/' + orderId, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (verifyRes.ok) {
        var verifyData = await verifyRes.json();
        var ordArr = verifyData.Orders || [verifyData];
        var liveOrder = ordArr[0] || {};
        var status = (liveOrder.Status || liveOrder.StatusDescription || '').toUpperCase();
        var rejStatuses = ['REJ', 'REJECTED', 'CAN', 'CANCELLED', 'CANCELED', 'EXP', 'EXPIRED', 'BRO', 'BROKEN'];
        var isRej = rejStatuses.some(function(s){ return status.indexOf(s) !== -1; });
        if (isRej) {
          var rejMsg = liveOrder.RejectReason || liveOrder.StatusDescription || status;
          console.error('[EXECUTOR] ORDER REJECTED POST-PLACEMENT --', orderId, status, rejMsg);
          _maybeEngageTSLock(rejMsg);
          return { error: 'TS_REJ: ' + status + ' -- ' + rejMsg, rejected: true, orderId: orderId };
        }
        console.log('[EXECUTOR] Order verified alive --', orderId, 'status:', status);
      }
    } catch(vErr) {
      console.log('[EXECUTOR] Verify skipped:', vErr.message);
    }

    // RECORD RISK AFTER SUCCESSFUL PLACEMENT
    try {
      var riskRecorded = stop
        ? Math.abs(parseFloat(limit) - parseFloat(stop)) * 100 * qty
        : parseFloat(limit) * 0.40 * 100 * qty;
      recordTradeRisk(riskRecorded);
    } catch(e) { /* recording skipped */ }

    return {
      success:    true,
      orderId:    orderId,
      symbol:     symbol,
      account:    account,
      qty:        qty,
      limit:      limit,
      stop:       stop,
      t1:         t1,
      t2:         t2,
      bracketSet: !!(stop || t1),
      response:   data,
    };

  } catch(e) {
    console.error('[EXECUTOR] Error:', e.message);
    return { error: e.message };
  }
}

// ================================================================
// CLOSE POSITION -- LIMIT sell to close (Apr 16 2026: AB rule = no Market)
// ================================================================
async function closePosition(account, symbol, qty, limitPrice) {
  try {
    var ts    = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return { error: 'No TradeStation token' };

    var base = getBaseUrl(account, false);

    // Apr 16 2026: AB rule "never market orders, only stop limits."
    // If caller provides limitPrice, use it. Otherwise fetch current bid
    // and set limit = bid - $0.05 for fast fill without slippage.
    var useLimit = limitPrice;
    if (!useLimit || isNaN(parseFloat(useLimit))) {
      try {
        var q = await fetch(base + '/marketdata/quotes/' + encodeURIComponent(symbol), {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        if (q.ok) {
          var qd = await q.json();
          var qq = (qd.Quotes || qd.quotes || [])[0] || {};
          var bid = parseFloat(qq.Bid || qq.bid || 0);
          if (bid > 0) useLimit = Math.max(0.01, bid - 0.05).toFixed(2);
        }
      } catch(e) { /* fallback */ }
      if (!useLimit) useLimit = '0.01'; // safety floor - will likely not fill but won't market-dump
    }

    var orderBody = {
      AccountID:   account,
      Symbol:      symbol,
      Quantity:    String(qty),
      OrderType:   'Limit',
      LimitPrice:  String(useLimit),
      TradeAction: 'SELLTOCLOSE',
      TimeInForce: { Duration: 'DAY' },
      Route:       'Intelligent',
    };
    console.log('[CLOSE-POSITION] LIMIT sell @ $' + useLimit + ' for ' + qty + 'x ' + symbol);

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
