// creditSpreadEngine.js - Stratum Flow Scout v8.5
// CREDIT SPREAD ENGINE: Autonomous XSP credit spread placement
// Uses FTFC + Sunday bias + dynamic bias for direction
// Bull put spreads (bullish) or bear call spreads (bearish) on XSP
// XSP = mini S&P 500 index, 1/10th SPX, cash-settled, European-style
// $5-wide spreads, minimum $1.50 credit (30%+ return on risk)
// 5-10 DTE, delta 0.20-0.35 on short leg, max 3 open at once
// -----------------------------------------------------------------

var fetch = require('node-fetch');

// -- SAFE REQUIRES -----------------------------------------------
var tradestation = null;
var brainEngine = null;
var dynamicBias = null;
var econCalendar = null;
var signalEnricher = null;

try { tradestation = require('./tradestation'); } catch(e) { console.log('[SPREAD] tradestation not loaded:', e.message); }
try { brainEngine = require('./brainEngine'); } catch(e) { console.log('[SPREAD] brainEngine not loaded:', e.message); }
try { dynamicBias = require('./dynamicBias'); } catch(e) { console.log('[SPREAD] dynamicBias not loaded:', e.message); }
try { econCalendar = require('./economicCalendar'); } catch(e) { console.log('[SPREAD] economicCalendar not loaded:', e.message); }
try { signalEnricher = require('./signalEnricher'); } catch(e) { console.log('[SPREAD] signalEnricher not loaded:', e.message); }

// -- CONSTANTS ---------------------------------------------------
var ACCOUNT_ID = '11975462';
var TS_BASE    = 'https://api.tradestation.com/v3';
var SPREAD_WIDTH = 5;            // $5 wide spreads
var MIN_CREDIT   = 1.50;         // minimum credit to accept
var PROFIT_TARGET_PCT = 0.50;    // close at 50% of max profit
var STOP_LOSS_PCT     = 1.50;    // close at 150% of credit received in loss
var MAX_OPEN_SPREADS  = 3;
var MIN_DTE = 5;
var MAX_DTE = 10;
var SHORT_DELTA_MIN = 0.20;
var SHORT_DELTA_MAX = 0.35;
var OTM_MIN_PCT = 0.02;         // short strike at least 2% OTM
var OTM_MAX_PCT = 0.05;         // short strike at most 5% OTM
var MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

var DISCORD_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// -- STATE -------------------------------------------------------
var openSpreads = [];            // array of spread position objects
var monitorTimer = null;
var dailySpreadCount = 0;
var dailySpreadDate  = '';

// ================================================================
// LOGGING
// ================================================================
function log(msg) {
  console.log('[SPREAD] ' + msg);
}

// ================================================================
// DISCORD POSTING
// ================================================================
async function postDiscord(msg) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: msg,
        username: 'Stratum Spread Engine',
      }),
    });
  } catch(e) {
    log('Discord post failed: ' + e.message);
  }
}

// ================================================================
// TIME HELPERS
// ================================================================
function getETNow() {
  var now = new Date();
  var etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

function isMarketHours() {
  var et = getETNow();
  var h  = et.getHours();
  var m  = et.getMinutes();
  var timeMinutes = h * 60 + m;
  // 9:45 AM to 3:00 PM ET
  return timeMinutes >= 585 && timeMinutes <= 900;
}

function isWeekday() {
  var et = getETNow();
  var day = et.getDay();
  return day >= 1 && day <= 5;
}

function getTodayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetDailyCountIfNewDay() {
  var today = getTodayET();
  if (dailySpreadDate !== today) {
    dailySpreadCount = 0;
    dailySpreadDate  = today;
  }
}

// ================================================================
// PRICE ROUNDING
// ================================================================
function round2(n) {
  return parseFloat(Math.round(parseFloat(n) * 100) / 100).toFixed(2);
}

// ================================================================
// FORMAT OPTION SYMBOL
// XSP format: "XSP YYMMDDCSTRIKE" or "XSP YYMMDDPSTRIKE"
// e.g. "XSP 260417P555" for XSP April 17 2026 555 put
// ================================================================
function formatOptionSymbol(expDate, type, strike) {
  var yy = String(expDate.getFullYear()).slice(-2);
  var mm = String(expDate.getMonth() + 1).padStart(2, '0');
  var dd = String(expDate.getDate()).padStart(2, '0');
  var side = type === 'PUT' ? 'P' : 'C';
  var strikeStr = String(strike);
  return 'XSP ' + yy + mm + dd + side + strikeStr;
}

// ================================================================
// FETCH FTFC FOR SPY (XSP tracks SPX which tracks SPY)
// Reuses the signalEnricher pattern for time frame continuity
// ================================================================
async function fetchFTFC() {
  try {
    var token = await tradestation.getAccessToken();
    if (!token) { log('No token for FTFC fetch'); return 'MIXED'; }

    var headers = { 'Authorization': 'Bearer ' + token };

    var monthlyRes = await fetch(TS_BASE + '/marketdata/barcharts/SPY?interval=1&unit=Monthly&barsback=3&sessiontemplate=Default', { headers: headers });
    var weeklyRes  = await fetch(TS_BASE + '/marketdata/barcharts/SPY?interval=1&unit=Weekly&barsback=3&sessiontemplate=Default', { headers: headers });
    var dailyRes   = await fetch(TS_BASE + '/marketdata/barcharts/SPY?interval=1&unit=Daily&barsback=3&sessiontemplate=Default', { headers: headers });
    var hourlyRes  = await fetch(TS_BASE + '/marketdata/barcharts/SPY?interval=60&unit=Minute&barsback=5&sessiontemplate=Default', { headers: headers });

    var monthlyData = await monthlyRes.json();
    var weeklyData  = await weeklyRes.json();
    var dailyData   = await dailyRes.json();
    var hourlyData  = await hourlyRes.json();

    var monthlyBars = (monthlyData.Bars || []);
    var weeklyBars  = (weeklyData.Bars || []);
    var dailyBars   = (dailyData.Bars || []);
    var hourlyBars  = (hourlyData.Bars || []);

    var monthlyCont = getContinuity(monthlyBars);
    var weeklyCont  = getContinuity(weeklyBars);
    var dailyCont   = getContinuity(dailyBars);
    var hourlyCont  = getContinuity(hourlyBars);

    var tfs = [monthlyCont, weeklyCont, dailyCont, hourlyCont];
    var bullCount = tfs.filter(function(t) { return t === 'BULL'; }).length;
    var bearCount = tfs.filter(function(t) { return t === 'BEAR'; }).length;

    var ftfc = 'MIXED';
    if (bullCount === 4) ftfc = 'BULL';
    else if (bearCount === 4) ftfc = 'BEAR';
    else if (bullCount >= 3) ftfc = 'BULL';
    else if (bearCount >= 3) ftfc = 'BEAR';

    log('FTFC: ' + ftfc + ' (M:' + monthlyCont + ' W:' + weeklyCont + ' D:' + dailyCont + ' 60m:' + hourlyCont + ')');
    return ftfc;
  } catch(e) {
    log('FTFC fetch error: ' + e.message);
    return 'MIXED';
  }
}

function getContinuity(bars) {
  if (!bars || bars.length < 2) return 'NEUTRAL';
  var last = bars[bars.length - 1];
  var prev = bars[bars.length - 2];
  var h  = parseFloat(last.High);
  var l  = parseFloat(last.Low);
  var ph = parseFloat(prev.High);
  var pl = parseFloat(prev.Low);
  if (h > ph && l > pl) return 'BULL';
  if (h < ph && l < pl) return 'BEAR';
  return 'NEUTRAL';
}

// ================================================================
// FETCH XSP CURRENT PRICE
// ================================================================
async function getXSPPrice() {
  try {
    var token = await tradestation.getAccessToken();
    if (!token) return null;
    var res = await fetch(TS_BASE + '/marketdata/quotes/XSP', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await res.json();
    if (data.Quotes && data.Quotes.length > 0) {
      return parseFloat(data.Quotes[0].Last || data.Quotes[0].Close);
    }
    return null;
  } catch(e) {
    log('XSP price fetch error: ' + e.message);
    return null;
  }
}

// ================================================================
// EVALUATE SPREAD OPPORTUNITY
// Main entry point -- called by brainEngine
// Checks FTFC + Sunday bias + dynamic bias (2/3 must agree)
// ================================================================
async function evaluateSpreadOpportunity() {
  log('Evaluating spread opportunity...');

  // -- Pre-checks --
  if (!isWeekday()) {
    log('REJECTED: Not a weekday');
    return null;
  }
  if (!isMarketHours()) {
    log('REJECTED: Outside trading hours (9:45 AM - 3:00 PM ET)');
    return null;
  }

  // Check economic calendar for high impact events
  if (econCalendar && econCalendar.isTradingBlocked) {
    var blocked = econCalendar.isTradingBlocked();
    if (blocked.blocked) {
      log('REJECTED: High impact event -- ' + blocked.reason);
      return null;
    }
  }

  // Check max open spreads
  if (openSpreads.length >= MAX_OPEN_SPREADS) {
    log('REJECTED: Max ' + MAX_OPEN_SPREADS + ' spreads already open');
    return null;
  }

  // -- Gather directional signals --
  var ftfc = await fetchFTFC();

  var sundayBias = null;
  if (brainEngine && brainEngine.getSundayBias) {
    sundayBias = brainEngine.getSundayBias();
  }
  var sundayDir = null;
  if (sundayBias && sundayBias.direction) {
    sundayDir = sundayBias.direction.toUpperCase();
    if (sundayDir.indexOf('BULL') >= 0 || sundayDir.indexOf('UP') >= 0) sundayDir = 'BULL';
    else if (sundayDir.indexOf('BEAR') >= 0 || sundayDir.indexOf('DOWN') >= 0) sundayDir = 'BEAR';
    else sundayDir = 'NEUTRAL';
  }

  var dynBias = null;
  if (dynamicBias && dynamicBias.getBias) {
    var biasState = dynamicBias.getBias();
    if (biasState && biasState.bias) {
      dynBias = biasState.bias.toUpperCase();
      if (dynBias === 'BULLISH') dynBias = 'BULL';
      else if (dynBias === 'BEARISH') dynBias = 'BEAR';
      else dynBias = 'NEUTRAL';
    }
  }

  log('Signals -- FTFC: ' + ftfc + ' | Sunday: ' + sundayDir + ' | Dynamic: ' + dynBias);

  // -- 2/3 must agree on direction --
  var signals = [ftfc, sundayDir, dynBias];
  var bullVotes = signals.filter(function(s) { return s === 'BULL'; }).length;
  var bearVotes = signals.filter(function(s) { return s === 'BEAR'; }).length;

  var direction = null;
  var type = null;
  var confidence = 0;

  if (bullVotes >= 2) {
    direction = 'BULLISH';
    type = 'BULL_PUT';
    confidence = bullVotes / 3;
  } else if (bearVotes >= 2) {
    direction = 'BEARISH';
    type = 'BEAR_CALL';
    confidence = bearVotes / 3;
  } else {
    log('REJECTED: No 2/3 confluence -- BULL:' + bullVotes + ' BEAR:' + bearVotes);
    return null;
  }

  log('APPROVED: ' + type + ' spread (confidence: ' + Math.round(confidence * 100) + '%)');

  return {
    type: type,
    direction: direction,
    confidence: confidence,
    ftfc: ftfc,
    sundayBias: sundayDir,
    dynamicBias: dynBias,
  };
}

// ================================================================
// FIND OPTIMAL STRIKES
// Fetches XSP option chain, filters by DTE, delta, credit
// ================================================================
async function findOptimalStrikes(type, xspPrice) {
  if (!xspPrice) {
    xspPrice = await getXSPPrice();
    if (!xspPrice) {
      log('Cannot get XSP price for strike selection');
      return null;
    }
  }

  log('Finding optimal strikes for ' + type + ' | XSP @ ' + xspPrice);

  var token = await tradestation.getAccessToken();
  if (!token) { log('No token for option chain'); return null; }

  // Calculate target date range for 5-10 DTE
  var now = new Date();
  var minExpDate = new Date(now);
  minExpDate.setDate(minExpDate.getDate() + MIN_DTE);
  var maxExpDate = new Date(now);
  maxExpDate.setDate(maxExpDate.getDate() + MAX_DTE);

  // Fetch XSP option chain from TradeStation
  var optionType = type === 'BULL_PUT' ? 'Put' : 'Call';

  // Calculate strike range based on OTM percentage
  var strikeMin, strikeMax;
  if (type === 'BULL_PUT') {
    // Puts below current price: 2-5% below
    strikeMax = Math.floor(xspPrice * (1 - OTM_MIN_PCT));
    strikeMin = Math.floor(xspPrice * (1 - OTM_MAX_PCT)) - SPREAD_WIDTH;
  } else {
    // Calls above current price: 2-5% above
    strikeMin = Math.ceil(xspPrice * (1 + OTM_MIN_PCT));
    strikeMax = Math.ceil(xspPrice * (1 + OTM_MAX_PCT)) + SPREAD_WIDTH;
  }

  try {
    // TradeStation option chain endpoint
    var chainUrl = TS_BASE + '/marketdata/options/chains/XSP' +
      '?optionType=' + optionType +
      '&strikeRange=' + strikeMin + '-' + strikeMax +
      '&expirationType=Weekly';

    var res = await fetch(chainUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var data = await res.json();

    if (!data.Options && !data.Expirations) {
      log('No option chain data returned');
      log('Response: ' + JSON.stringify(data).slice(0, 500));
      return null;
    }

    var options = data.Options || [];
    if (options.length === 0) {
      log('Empty option chain for XSP');
      return null;
    }

    // Filter options by DTE range
    var validOptions = options.filter(function(opt) {
      var expStr = opt.ExpirationDate || opt.Expiration;
      if (!expStr) return false;
      var expDate = new Date(expStr);
      return expDate >= minExpDate && expDate <= maxExpDate;
    });

    if (validOptions.length === 0) {
      log('No options in ' + MIN_DTE + '-' + MAX_DTE + ' DTE range');
      return null;
    }

    // Group by expiration to find best expiry
    var expirations = {};
    validOptions.forEach(function(opt) {
      var expStr = (opt.ExpirationDate || opt.Expiration).slice(0, 10);
      if (!expirations[expStr]) expirations[expStr] = [];
      expirations[expStr].push(opt);
    });

    // Try each expiration, find the best spread
    var bestSpread = null;

    Object.keys(expirations).forEach(function(expStr) {
      var expOptions = expirations[expStr];

      // Sort by strike
      expOptions.sort(function(a, b) {
        return parseFloat(a.StrikePrice || a.Strikes) - parseFloat(b.StrikePrice || b.Strikes);
      });

      expOptions.forEach(function(shortLeg) {
        var shortStrike = parseFloat(shortLeg.StrikePrice || shortLeg.Strikes);
        var shortDelta  = Math.abs(parseFloat(shortLeg.Delta || shortLeg.Greeks_Delta || 0));
        var shortBid    = parseFloat(shortLeg.Bid || 0);
        var shortAsk    = parseFloat(shortLeg.Ask || 0);
        var shortMid    = (shortBid + shortAsk) / 2;

        // Check delta range
        if (shortDelta < SHORT_DELTA_MIN || shortDelta > SHORT_DELTA_MAX) return;

        // Find long leg ($5 away)
        var longStrike;
        if (type === 'BULL_PUT') {
          longStrike = shortStrike - SPREAD_WIDTH;
        } else {
          longStrike = shortStrike + SPREAD_WIDTH;
        }

        var longLeg = expOptions.find(function(o) {
          var s = parseFloat(o.StrikePrice || o.Strikes);
          return Math.abs(s - longStrike) < 0.5;
        });

        if (!longLeg) return;

        var longBid = parseFloat(longLeg.Bid || 0);
        var longAsk = parseFloat(longLeg.Ask || 0);
        var longMid = (longBid + longAsk) / 2;

        // Calculate net credit
        // For BULL_PUT: sell higher put, buy lower put -> credit = sell mid - buy mid
        // For BEAR_CALL: sell lower call, buy higher call -> credit = sell mid - buy mid
        var netCredit = shortMid - longMid;

        // Use bid/ask for conservative estimate
        var conservativeCredit = shortBid - longAsk;

        if (conservativeCredit < MIN_CREDIT) return;

        var maxRisk    = SPREAD_WIDTH - conservativeCredit;
        var returnPct  = conservativeCredit / maxRisk;

        var expDate = new Date(expStr);
        var dte     = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));

        var spread = {
          type: type,
          expiration: expStr,
          expirationDate: expDate,
          dte: dte,
          shortStrike: shortStrike,
          longStrike: longStrike,
          shortDelta: shortDelta,
          shortSymbol: formatOptionSymbol(expDate, type === 'BULL_PUT' ? 'PUT' : 'CALL', shortStrike),
          longSymbol:  formatOptionSymbol(expDate, type === 'BULL_PUT' ? 'PUT' : 'CALL', longStrike),
          netCredit: parseFloat(round2(conservativeCredit)),
          midCredit: parseFloat(round2(netCredit)),
          maxRisk: parseFloat(round2(maxRisk)),
          returnPct: parseFloat((returnPct * 100).toFixed(1)),
          quantity: 1,
        };

        // Pick best by return % (higher credit for same risk)
        if (!bestSpread || spread.netCredit > bestSpread.netCredit) {
          bestSpread = spread;
        }
      });
    });

    if (!bestSpread) {
      log('No spread meets minimum $' + MIN_CREDIT + ' credit requirement');
      return null;
    }

    log('OPTIMAL SPREAD: ' + bestSpread.type +
      ' | Short: ' + bestSpread.shortStrike + ' Long: ' + bestSpread.longStrike +
      ' | Credit: $' + bestSpread.netCredit +
      ' | Risk: $' + bestSpread.maxRisk +
      ' | Return: ' + bestSpread.returnPct + '%' +
      ' | DTE: ' + bestSpread.dte +
      ' | Delta: ' + bestSpread.shortDelta.toFixed(2));

    return bestSpread;
  } catch(e) {
    log('Strike selection error: ' + e.message);
    return null;
  }
}

// ================================================================
// PLACE SPREAD ORDER
// Sends multi-leg credit spread to TradeStation API
// ================================================================
async function placeSpreadOrder(spreadConfig) {
  if (!spreadConfig) {
    log('No spread config provided');
    return null;
  }

  log('Placing ' + spreadConfig.type + ' spread order...');

  // Final safety checks
  if (openSpreads.length >= MAX_OPEN_SPREADS) {
    log('ORDER BLOCKED: Max ' + MAX_OPEN_SPREADS + ' spreads open');
    return null;
  }

  if (!isMarketHours()) {
    log('ORDER BLOCKED: Outside trading hours');
    return null;
  }

  if (spreadConfig.netCredit < MIN_CREDIT) {
    log('ORDER BLOCKED: Credit $' + spreadConfig.netCredit + ' below minimum $' + MIN_CREDIT);
    return null;
  }

  var token = await tradestation.getAccessToken();
  if (!token) {
    log('ORDER BLOCKED: No TradeStation token');
    return null;
  }

  // Build multi-leg order payload
  var shortAction, longAction;
  if (spreadConfig.type === 'BULL_PUT') {
    shortAction = 'SELLTOOPEN';  // sell the higher put
    longAction  = 'BUYTOOPEN';   // buy the lower put (protection)
  } else {
    shortAction = 'SELLTOOPEN';  // sell the lower call
    longAction  = 'BUYTOOPEN';   // buy the higher call (protection)
  }

  var orderPayload = {
    AccountID: ACCOUNT_ID,
    Symbol: spreadConfig.shortSymbol,
    Quantity: String(spreadConfig.quantity),
    OrderType: 'Limit',
    TradeAction: shortAction,
    TimeInForce: { Duration: 'DAY' },
    Legs: [
      {
        Symbol: spreadConfig.shortSymbol,
        Quantity: String(spreadConfig.quantity),
        TradeAction: shortAction,
      },
      {
        Symbol: spreadConfig.longSymbol,
        Quantity: String(spreadConfig.quantity),
        TradeAction: longAction,
      },
    ],
    Price: round2(spreadConfig.netCredit),
  };

  log('Order payload: ' + JSON.stringify(orderPayload, null, 2));

  try {
    var res = await fetch(TS_BASE + '/orderexecution/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    var result = await res.json();

    if (result.Orders && result.Orders.length > 0) {
      var order = result.Orders[0];
      var orderId = order.OrderID || order.OrderId || 'UNKNOWN';

      var spreadRecord = {
        id: orderId,
        type: spreadConfig.type,
        shortSymbol: spreadConfig.shortSymbol,
        longSymbol:  spreadConfig.longSymbol,
        shortStrike: spreadConfig.shortStrike,
        longStrike:  spreadConfig.longStrike,
        expiration:  spreadConfig.expiration,
        dte:         spreadConfig.dte,
        creditReceived: spreadConfig.netCredit,
        maxRisk:     spreadConfig.maxRisk,
        quantity:    spreadConfig.quantity,
        status:      'OPEN',
        openedAt:    new Date().toISOString(),
        profitTarget: parseFloat(round2(spreadConfig.netCredit * PROFIT_TARGET_PCT)),
        stopLoss:     parseFloat(round2(spreadConfig.netCredit * STOP_LOSS_PCT)),
      };

      openSpreads.push(spreadRecord);
      resetDailyCountIfNewDay();
      dailySpreadCount++;

      log('ORDER PLACED: ' + orderId);
      log('  Type: ' + spreadConfig.type);
      log('  Short: ' + spreadConfig.shortSymbol + ' @ ' + spreadConfig.shortStrike);
      log('  Long: ' + spreadConfig.longSymbol + ' @ ' + spreadConfig.longStrike);
      log('  Credit: $' + spreadConfig.netCredit);
      log('  Max Risk: $' + spreadConfig.maxRisk);
      log('  Profit Target: close when spread costs $' + round2(spreadConfig.netCredit - spreadRecord.profitTarget));
      log('  Stop Loss: close when loss exceeds $' + round2(spreadRecord.stopLoss));

      // Post to Discord
      var discordMsg = '```\n' +
        'CREDIT SPREAD OPENED\n' +
        '========================\n' +
        'Type: ' + spreadConfig.type + '\n' +
        'Short: ' + spreadConfig.shortSymbol + ' (' + spreadConfig.shortStrike + ')\n' +
        'Long:  ' + spreadConfig.longSymbol + ' (' + spreadConfig.longStrike + ')\n' +
        'Credit: $' + spreadConfig.netCredit + '\n' +
        'Max Risk: $' + spreadConfig.maxRisk + '\n' +
        'Return: ' + spreadConfig.returnPct + '%\n' +
        'DTE: ' + spreadConfig.dte + '\n' +
        'Delta (short): ' + (spreadConfig.shortDelta || 'N/A') + '\n' +
        'Expiration: ' + spreadConfig.expiration + '\n' +
        'Profit Target: 50% ($' + round2(spreadRecord.profitTarget) + ')\n' +
        'Stop Loss: 150% ($' + round2(spreadRecord.stopLoss) + ')\n' +
        'Order ID: ' + orderId + '\n' +
        '========================\n' +
        '```';

      await postDiscord(discordMsg);

      return spreadRecord;
    } else {
      var errMsg = result.Message || result.Error || JSON.stringify(result).slice(0, 300);
      log('ORDER FAILED: ' + errMsg);
      await postDiscord('```\nSPREAD ORDER FAILED\n' + spreadConfig.type + '\n' + errMsg + '\n```');
      return null;
    }
  } catch(e) {
    log('Order execution error: ' + e.message);
    await postDiscord('```\nSPREAD ORDER ERROR\n' + e.message + '\n```');
    return null;
  }
}

// ================================================================
// CLOSE SPREAD
// Buys back the short, sells the long (reverse the opening legs)
// ================================================================
async function closeSpread(spreadId, reason) {
  var spread = openSpreads.find(function(s) { return s.id === spreadId; });
  if (!spread) {
    log('Cannot close spread ' + spreadId + ' -- not found');
    return null;
  }

  log('CLOSING spread ' + spreadId + ' -- reason: ' + reason);

  var token = await tradestation.getAccessToken();
  if (!token) {
    log('Cannot close spread -- no token');
    return null;
  }

  // Reverse legs: BuyToClose the short, SellToClose the long
  var closePayload = {
    AccountID: ACCOUNT_ID,
    Symbol: spread.shortSymbol,
    Quantity: String(spread.quantity),
    OrderType: 'Market',
    TradeAction: 'BUYTOCLOSE',
    TimeInForce: { Duration: 'DAY' },
    Legs: [
      {
        Symbol: spread.shortSymbol,
        Quantity: String(spread.quantity),
        TradeAction: 'BUYTOCLOSE',
      },
      {
        Symbol: spread.longSymbol,
        Quantity: String(spread.quantity),
        TradeAction: 'SELLTOCLOSE',
      },
    ],
  };

  try {
    var res = await fetch(TS_BASE + '/orderexecution/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(closePayload),
    });

    var result = await res.json();

    if (result.Orders && result.Orders.length > 0) {
      spread.status   = 'CLOSED';
      spread.closedAt = new Date().toISOString();
      spread.closeReason = reason;

      // Remove from open spreads
      openSpreads = openSpreads.filter(function(s) { return s.id !== spreadId; });

      log('SPREAD CLOSED: ' + spreadId + ' -- ' + reason);

      var discordMsg = '```\n' +
        'CREDIT SPREAD CLOSED\n' +
        '========================\n' +
        'Type: ' + spread.type + '\n' +
        'Short: ' + spread.shortSymbol + ' (' + spread.shortStrike + ')\n' +
        'Long:  ' + spread.longSymbol + ' (' + spread.longStrike + ')\n' +
        'Credit Received: $' + spread.creditReceived + '\n' +
        'Reason: ' + reason + '\n' +
        'Opened: ' + spread.openedAt + '\n' +
        'Closed: ' + spread.closedAt + '\n' +
        'Order ID: ' + spreadId + '\n' +
        '========================\n' +
        '```';

      await postDiscord(discordMsg);
      return spread;
    } else {
      var errMsg = result.Message || result.Error || JSON.stringify(result).slice(0, 300);
      log('CLOSE FAILED: ' + errMsg);
      return null;
    }
  } catch(e) {
    log('Close spread error: ' + e.message);
    return null;
  }
}

// ================================================================
// MONITOR SPREADS
// Checks open spreads every 5 minutes, closes at profit target or stop
// ================================================================
async function monitorSpreads() {
  if (openSpreads.length === 0) {
    return;
  }

  if (!isMarketHours() || !isWeekday()) {
    return;
  }

  log('Monitoring ' + openSpreads.length + ' open spread(s)...');

  var token = await tradestation.getAccessToken();
  if (!token) {
    log('Monitor: no token');
    return;
  }

  // Get current positions from TradeStation
  try {
    var posRes = await fetch(TS_BASE + '/brokerage/accounts/' + ACCOUNT_ID + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    var posData = await posRes.json();
    var positions = posData.Positions || [];

    // Check each open spread
    var spreadsToCheck = openSpreads.slice(); // copy to avoid mutation during iteration

    for (var i = 0; i < spreadsToCheck.length; i++) {
      var spread = spreadsToCheck[i];

      try {
        // Get current quotes for both legs
        var symbols = spread.shortSymbol + ',' + spread.longSymbol;
        var quoteRes = await fetch(TS_BASE + '/marketdata/quotes/' + encodeURIComponent(symbols), {
          headers: { 'Authorization': 'Bearer ' + token },
        });
        var quoteData = await quoteRes.json();
        var quotes = quoteData.Quotes || [];

        var shortQuote = quotes.find(function(q) { return q.Symbol === spread.shortSymbol; });
        var longQuote  = quotes.find(function(q) { return q.Symbol === spread.longSymbol; });

        if (!shortQuote || !longQuote) {
          log('Monitor: Missing quotes for spread ' + spread.id);
          continue;
        }

        var shortMid = (parseFloat(shortQuote.Bid || 0) + parseFloat(shortQuote.Ask || 0)) / 2;
        var longMid  = (parseFloat(longQuote.Bid || 0) + parseFloat(longQuote.Ask || 0)) / 2;

        // Current cost to close = buy back short - sell long
        var costToClose = shortMid - longMid;
        var currentPnL  = spread.creditReceived - costToClose;

        log('Spread ' + spread.id + ': cost to close=$' + round2(costToClose) +
          ' | P&L=$' + round2(currentPnL) +
          ' | credit=$' + spread.creditReceived);

        // -- PROFIT TARGET: 50% of max profit --
        // Max profit = credit received. 50% profit means spread is now worth 50% of credit
        if (currentPnL >= spread.profitTarget) {
          log('PROFIT TARGET HIT: $' + round2(currentPnL) + ' >= $' + round2(spread.profitTarget));
          await closeSpread(spread.id, 'PROFIT TARGET (50%) -- P&L: $' + round2(currentPnL));
          continue;
        }

        // -- STOP LOSS: loss exceeds 150% of credit received --
        var maxLoss = spread.stopLoss;
        if (currentPnL < 0 && Math.abs(currentPnL) >= maxLoss) {
          log('STOP LOSS HIT: loss $' + round2(Math.abs(currentPnL)) + ' >= $' + round2(maxLoss));
          await closeSpread(spread.id, 'STOP LOSS (150%) -- Loss: $' + round2(Math.abs(currentPnL)));
          continue;
        }

        // -- EXPIRATION WARNING: close if 1 DTE remaining --
        var expDate = new Date(spread.expiration);
        var now = new Date();
        var dteRemaining = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
        if (dteRemaining <= 1) {
          log('EXPIRATION CLOSE: only ' + dteRemaining + ' DTE remaining');
          await closeSpread(spread.id, 'EXPIRATION CLOSE (' + dteRemaining + ' DTE) -- P&L: $' + round2(currentPnL));
          continue;
        }
      } catch(e) {
        log('Monitor error for spread ' + spread.id + ': ' + e.message);
      }
    }
  } catch(e) {
    log('Monitor cycle error: ' + e.message);
  }
}

// ================================================================
// START / STOP MONITOR LOOP
// ================================================================
function startMonitor() {
  if (monitorTimer) {
    log('Monitor already running');
    return;
  }
  log('Starting spread monitor (every ' + (MONITOR_INTERVAL_MS / 1000) + 's)');
  monitorTimer = setInterval(function() {
    monitorSpreads().catch(function(e) {
      log('Monitor loop error: ' + e.message);
    });
  }, MONITOR_INTERVAL_MS);
}

function stopMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    log('Spread monitor stopped');
  }
}

// ================================================================
// GET SPREAD STATUS
// Returns current open positions and summary
// ================================================================
function getSpreadStatus() {
  resetDailyCountIfNewDay();
  var totalCredit = 0;
  var totalRisk   = 0;

  openSpreads.forEach(function(s) {
    totalCredit += s.creditReceived * s.quantity * 100; // per contract in dollars
    totalRisk   += s.maxRisk * s.quantity * 100;
  });

  return {
    openSpreads: openSpreads.slice(),
    count: openSpreads.length,
    maxAllowed: MAX_OPEN_SPREADS,
    totalCreditReceived: parseFloat(round2(totalCredit)),
    totalRiskDeployed: parseFloat(round2(totalRisk)),
    dailySpreadCount: dailySpreadCount,
    monitorRunning: monitorTimer !== null,
  };
}

// ================================================================
// FULL EXECUTION FLOW
// Convenience: evaluate → find strikes → place order, all in one
// ================================================================
async function executeFullFlow() {
  log('=== CREDIT SPREAD FULL FLOW ===');

  var opportunity = await evaluateSpreadOpportunity();
  if (!opportunity) {
    log('No spread opportunity found');
    return null;
  }

  var xspPrice = await getXSPPrice();
  if (!xspPrice) {
    log('Cannot get XSP price');
    return null;
  }

  log('XSP price: $' + xspPrice);

  var strikes = await findOptimalStrikes(opportunity.type, xspPrice);
  if (!strikes) {
    log('No viable strikes found');
    await postDiscord('```\n[SPREAD] Evaluated ' + opportunity.type + ' but no strikes met criteria\nXSP @ $' + xspPrice + '\nMin credit: $' + MIN_CREDIT + '\n```');
    return null;
  }

  var result = await placeSpreadOrder(strikes);
  if (result) {
    // Start monitor if not already running
    startMonitor();
  }

  return result;
}

// ================================================================
// MODULE EXPORTS
// ================================================================
module.exports = {
  evaluateSpreadOpportunity: evaluateSpreadOpportunity,
  findOptimalStrikes:        findOptimalStrikes,
  placeSpreadOrder:          placeSpreadOrder,
  monitorSpreads:            monitorSpreads,
  getSpreadStatus:           getSpreadStatus,
  closeSpread:               closeSpread,
  startMonitor:              startMonitor,
  stopMonitor:               stopMonitor,
  executeFullFlow:           executeFullFlow,
};
