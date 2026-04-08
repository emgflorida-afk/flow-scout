// executeNow.js -- Stratum v8.0
// REBUILT: LVL framework, 2-bar confirmation, structural stops, position limits
// #execute-now channel -- ONLY fires when ALL gates pass
// Gates: Watchlist → Positions → Duplicates → Time → Bias → Confluence → LVL → 2-Bar → Execute

var fetch = require('node-fetch');
var resolver = require('./contractResolver');

var EXECUTE_NOW_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
var CONVICTION_WEBHOOK  = process.env.DISCORD_CONVICTION_WEBHOOK;

// Account rules -- mirrors real $6K account
var ACCOUNT_SIZE     = parseFloat(process.env.ACCOUNT_SIZE || '6000');
var MAX_PREMIUM      = 2.40;
var MAX_LOSS_PER_TRADE = 120; // 2% of $6K
var MAX_POSITIONS    = 4;
var MAX_SETUPS_PER_DAY = 4;

// Core watchlist -- 43 tickers across sectors for daily setups
var CORE_WATCHLIST = [
  // Indices
  'SPY','QQQ','IWM',
  // Tech
  'NVDA','TSLA','META','GOOGL','AMZN','MSFT','AMD','AAPL','MRVL',
  // Financials
  'JPM','GS','MS','WFC','BAC','V','MA',
  // Energy
  'XLE','XOM','CVX','COP',
  // Healthcare
  'UNH','MRK','LLY','ABBV',
  // Retail
  'WMT','COST','HD','TGT',
  // Momentum
  'COIN','MSTR','PLTR','DKNG','RIVN',
  // Sector ETFs
  'XLK','XLF','XLV','GLD','TLT',
  // Defensive
  'KO','PEP',
  // Legacy
  'MRNA','GUSH','UVXY'
];

var INDEX_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Wide-range tickers -- structural stops
var WIDE_RANGE = ['NVDA','TSLA','COIN','MSTR','AMD','META','CRWD','SNOW','MRVL','DKNG','AMZN','GOOGL','MSFT','AAPL'];
// Tight-range tickers -- flat stops
var TIGHT_RANGE = ['KO','PEP','WMT','DG','JNJ','PG','XLF','XLE','VZ','T','BAC','WFC'];

// T1 targets by ticker
var T1_TARGETS = {
  TSLA: 0.50, COIN: 0.50, NVDA: 0.50, MRVL: 0.50,
  AAPL: 0.40, AMZN: 0.40, MSFT: 0.40, GOOGL: 0.40,
};
function getT1Pct(ticker) { return T1_TARGETS[ticker] || 0.35; }

// Track state -- persistent across restarts
var fs = require('fs');
var STATE_FILE = '/tmp/stratum-exec-state.json';

var todaySetups = [];
var todayTickers = {};
var pendingBars = {};

// Load state from file on startup
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Only restore if same day
      var today = new Date().toISOString().slice(0, 10);
      if (data.date === today) {
        todaySetups = data.todaySetups || [];
        todayTickers = data.todayTickers || {};
        pendingBars = data.pendingBars || {};
        console.log('[EXECUTE-NOW] State restored from file:', todaySetups.length, 'setups,', Object.keys(pendingBars).length, 'pending bars');
      } else {
        console.log('[EXECUTE-NOW] State file is from', data.date, '-- starting fresh');
      }
    }
  } catch(e) { console.log('[EXECUTE-NOW] No saved state -- starting fresh'); }
}

// Save state to file after each change
function saveState() {
  try {
    var data = {
      date: new Date().toISOString().slice(0, 10),
      todaySetups: todaySetups,
      todayTickers: todayTickers,
      pendingBars: pendingBars,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch(e) { console.error('[EXECUTE-NOW] Save state error:', e.message); }
}

// Load on module init
loadState();

function resetDailySetups() {
  todaySetups = [];
  todayTickers = {};
  pendingBars = {};
  saveState();
  console.log('[EXECUTE-NOW] Daily state reset');
}

function isIndex(ticker) {
  return INDEX_TICKERS.includes(ticker.toUpperCase());
}

// ============================================================
// GATE 1: TIME WINDOW
// ============================================================
function isEntryWindow() {
  var now = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  var etMin  = now.getUTCMinutes();
  var etTime = etHour * 60 + etMin;

  var AM_START = 9 * 60 + 35;   // 9:35 AM -- primo enters at open, 5 min buffer
  var AM_END   = 11 * 60;       // 11:00 AM -- extended morning window
  var PM_START = 14 * 60 + 45;  // 2:45 PM -- pre-power hour for catalyst setups
  var PM_END   = 15 * 60 + 30;  // 3:30 PM -- hard close deadline

  if (etTime >= AM_START && etTime <= AM_END) return { ok: true, window: 'AM' };
  if (etTime >= PM_START && etTime <= PM_END) return { ok: true, window: 'PM' };
  return { ok: false, window: 'CLOSED' };
}

// ============================================================
// GATE 2: LVL FRAMEWORK CHECK
// Two valid trade types per direction:
//   CALL: Type 1 = breakout above PDH | Type 2 = reversal bounce off PDL
//   PUT:  Type 1 = breakdown below PDL | Type 2 = reversal rejection at PDH
// ============================================================
function checkLVL(ticker, type, price, lvls) {
  if (!lvls) return { pass: true, reason: 'No LVL data -- allowing (fallback)', tradeType: 'UNKNOWN' };

  var distFromPDH = (price - lvls.pdh) / lvls.pdh;
  var distFromPDL = (lvls.pdl - price) / lvls.pdl;

  if (type === 'call') {
    // TYPE 1: Breakout — price near or above PDH
    if (Math.abs(distFromPDH) <= 0.03) {
      return { pass: true, reason: 'BREAKOUT: Near PDH $' + lvls.pdh.toFixed(2), tradeType: 'BREAKOUT' };
    }
    // TYPE 2: Reversal — price bouncing off PDL (was near PDL, now moving up)
    if (distFromPDL >= -0.01 && distFromPDL <= 0.03) {
      return { pass: true, reason: 'REVERSAL: Bouncing off PDL $' + lvls.pdl.toFixed(2), tradeType: 'REVERSAL' };
    }
    // Too extended above PDH
    if (distFromPDH > 0.03) {
      return { pass: false, reason: ticker + ' $' + price.toFixed(2) + ' too extended above PDH $' + lvls.pdh.toFixed(2), tradeType: null };
    }
    // In no mans land — between PDL and PDH but not near either
    return { pass: false, reason: ticker + ' $' + price.toFixed(2) + ' not near PDH $' + lvls.pdh.toFixed(2) + ' or PDL $' + lvls.pdl.toFixed(2), tradeType: null };
  } else {
    // TYPE 1: Breakdown — price near or below PDL
    if (Math.abs(distFromPDL) <= 0.03) {
      return { pass: true, reason: 'BREAKDOWN: Near PDL $' + lvls.pdl.toFixed(2), tradeType: 'BREAKOUT' };
    }
    // TYPE 2: Reversal — price rejected at PDH (was near PDH, now moving down)
    if (distFromPDH >= -0.01 && distFromPDH <= 0.03) {
      return { pass: true, reason: 'REVERSAL: Rejected at PDH $' + lvls.pdh.toFixed(2), tradeType: 'REVERSAL' };
    }
    // Too extended below PDL
    if (distFromPDL > 0.03) {
      return { pass: false, reason: ticker + ' $' + price.toFixed(2) + ' too extended below PDL $' + lvls.pdl.toFixed(2), tradeType: null };
    }
    // In no mans land
    return { pass: false, reason: ticker + ' $' + price.toFixed(2) + ' not near PDL $' + lvls.pdl.toFixed(2) + ' or PDH $' + lvls.pdh.toFixed(2), tradeType: null };
  }
}

// ============================================================
// GATE 3: 2-BAR CONFIRMATION
// Returns true only on SECOND consecutive bar through level
// ============================================================
function check2Bar(ticker, type, price, lvls) {
  var key = ticker + '_' + type;
  var level = type === 'call' ? (lvls ? lvls.pdh : null) : (lvls ? lvls.pdl : null);

  if (!level) {
    // No LVL data -- skip 2-bar check
    return { confirmed: true, reason: 'No LVL -- skipping 2-bar' };
  }

  var through = type === 'call' ? (price > level) : (price < level);

  if (!through) {
    // Price not through level -- reset counter
    pendingBars[key] = 0;
    saveState();
    return { confirmed: false, reason: ticker + ' not through ' + (type === 'call' ? 'PDH' : 'PDL') + ' $' + level.toFixed(2) };
  }

  pendingBars[key] = (pendingBars[key] || 0) + 1;
  saveState();

  if (pendingBars[key] >= 2) {
    return { confirmed: true, reason: '2-bar confirmed: ' + ticker + ' through $' + level.toFixed(2) + ' for ' + pendingBars[key] + ' bars' };
  }

  return { confirmed: false, reason: 'PENDING: ' + ticker + ' bar 1/' + '2 through $' + level.toFixed(2) + ' -- waiting for confirmation' };
}

// ============================================================
// STRUCTURAL STOP CALCULATOR
// ============================================================
function calcStructuralStop(ticker, type, premium, lvls, price, delta) {
  var t = ticker.toUpperCase();

  // Tight range tickers -- flat 40% stop
  if (TIGHT_RANGE.includes(t)) {
    var flatStop = parseFloat((premium * 0.60).toFixed(2));
    return { stopPrice: flatStop, stopType: 'FLAT', reason: '40% flat stop (tight range ticker)' };
  }

  // Index tickers -- pivot stop
  if (INDEX_TICKERS.includes(t)) {
    var pivot = lvls ? (lvls.pdh + lvls.pdl + lvls.pdc) / 3 : null;
    if (pivot && price && delta) {
      var distToPivot = Math.abs(price - pivot);
      var estLoss = distToPivot * Math.abs(delta);
      var stopPct = Math.min(0.50, Math.max(0.25, estLoss / premium));
      var pivotStop = parseFloat((premium * (1 - stopPct)).toFixed(2));
      return { stopPrice: pivotStop, stopType: 'PIVOT', reason: 'Pivot $' + pivot.toFixed(2) + ' stop at ' + (stopPct * 100).toFixed(0) + '%' };
    }
    var indexStop = parseFloat((premium * 0.65).toFixed(2));
    return { stopPrice: indexStop, stopType: 'PIVOT', reason: '35% index stop (no pivot data)' };
  }

  // Wide range tickers -- structural stop based on PDH/PDL
  if (WIDE_RANGE.includes(t) && lvls && price && delta) {
    var structLevel = type === 'call' ? lvls.pdl : lvls.pdh;
    var dist = Math.abs(price - structLevel);
    var estOptionLoss = dist * Math.abs(delta);
    var stopPct2 = Math.min(0.50, Math.max(0.20, estOptionLoss / premium));
    var structStop = parseFloat((premium * (1 - stopPct2)).toFixed(2));

    // Verify max loss rule
    var maxLossCheck = premium * stopPct2 * 100;
    if (maxLossCheck > MAX_LOSS_PER_TRADE) {
      // Reduce to stay within $120 max loss
      var safeStop = parseFloat((premium - (MAX_LOSS_PER_TRADE / 100)).toFixed(2));
      return { stopPrice: Math.max(safeStop, 0.05), stopType: 'STRUCTURAL_CAPPED', reason: 'Structural stop capped at $120 max loss' };
    }

    return { stopPrice: structStop, stopType: 'STRUCTURAL', reason: type === 'call' ? 'PDL $' + lvls.pdl.toFixed(2) : 'PDH $' + lvls.pdh.toFixed(2) + ' -- ' + (stopPct2 * 100).toFixed(0) + '% stop' };
  }

  // Default -- hybrid 40% with $120 cap
  var defaultStop = parseFloat((premium * 0.60).toFixed(2));
  return { stopPrice: defaultStop, stopType: 'DEFAULT', reason: '40% default stop' };
}

// ============================================================
// MAIN DECISION ENGINE
// ============================================================
async function shouldExecute(signal, macroBias, h6Bias, hasFlow, positions, buyingPower) {
  var ticker     = (signal.ticker || '').toUpperCase();
  var type       = (signal.type || 'call').toLowerCase();
  var confluence = parseInt((signal.confluence || '0').split('/')[0]) || 0;
  var price      = signal.close ? parseFloat(signal.close) : null;

  console.log('[EXECUTE-NOW] Evaluating ' + ticker + ' ' + type + ' conf:' + confluence + '/6');

  // GATE 1: Watchlist
  if (!CORE_WATCHLIST.includes(ticker)) {
    console.log('[EXECUTE-NOW] BLOCKED: ' + ticker + ' not on watchlist');
    return { execute: false, reason: ticker + ' not in core watchlist' };
  }

  // GATE 2: Max positions
  var openCount = Array.isArray(positions) ? positions.length : (positions || 0);
  if (openCount >= MAX_POSITIONS) {
    console.log('[EXECUTE-NOW] BLOCKED: ' + openCount + ' positions open (max ' + MAX_POSITIONS + ')');
    return { execute: false, reason: openCount + ' positions open -- max ' + MAX_POSITIONS };
  }

  // GATE 3: Duplicate ticker today
  if (todayTickers[ticker]) {
    console.log('[EXECUTE-NOW] BLOCKED: Already traded ' + ticker + ' today');
    return { execute: false, reason: 'Already traded ' + ticker + ' today -- one per ticker' };
  }

  // GATE 4: Max setups per day
  if (todaySetups.length >= MAX_SETUPS_PER_DAY) {
    console.log('[EXECUTE-NOW] BLOCKED: Max ' + MAX_SETUPS_PER_DAY + ' setups reached');
    return { execute: false, reason: 'Max ' + MAX_SETUPS_PER_DAY + ' setups reached for today' };
  }

  // GATE 5: Entry window
  var timeCheck = isEntryWindow();
  if (!timeCheck.ok) {
    console.log('[EXECUTE-NOW] BLOCKED: Outside entry window');
    return { execute: false, reason: 'Outside entry window (9:50-10:30AM or 3:00-3:30PM ET)' };
  }

  // GATE 6: Macro bias -- allows contra-trend trades when ticker shows relative weakness/strength
  // High confluence (5+/6) overrides macro bias -- the setup IS the edge
  if (confluence < 5) {
    if (h6Bias === 'BULLISH' && type === 'put') {
      return { execute: false, reason: '6HR is BULLISH -- no puts (need 5+/6 to override)' };
    }
    if (h6Bias === 'BEARISH' && type === 'call') {
      return { execute: false, reason: '6HR is BEARISH -- no calls (need 5+/6 to override)' };
    }
    if (macroBias === 'BULLISH' && type === 'put') {
      return { execute: false, reason: 'SPY macro BULLISH -- blocking puts (need 5+/6 to override)' };
    }
    if (macroBias === 'BEARISH' && type === 'call') {
      return { execute: false, reason: 'SPY macro BEARISH -- blocking calls (need 5+/6 to override)' };
    }
  } else {
    console.log('[EXECUTE-NOW] Confluence ' + confluence + '/6 overrides macro bias for ' + ticker + ' ' + type);
  }

  // GATE 7: Buying power
  if (buyingPower < 300) {
    return { execute: false, reason: 'Buying power under $300' };
  }

  // GATE 8: Confluence
  var grade, contracts;
  if (confluence >= 5 && hasFlow) {
    grade = 'A+'; contracts = 2;
  } else if (confluence >= 5) {
    grade = 'A'; contracts = 1;
  } else if (confluence >= 4 && hasFlow) {
    grade = 'A'; contracts = 1;
  } else {
    return { execute: false, reason: 'Insufficient confluence (' + confluence + '/6) for execute-now' };
  }

  // GATE 9: LVL Framework -- fetch PDH/PDL/PDC
  var lvls = null;
  try {
    var token = resolver.getTSToken ? await resolver.getTSToken() : null;
    if (token) {
      lvls = await resolver.getLVLs(ticker, token);
    }
  } catch(e) { console.log('[EXECUTE-NOW] LVL fetch error:', e.message); }

  if (price && lvls) {
    var lvlCheck = checkLVL(ticker, type, price, lvls);
    console.log('[EXECUTE-NOW] LVL: ' + lvlCheck.reason);
    if (!lvlCheck.pass) {
      return { execute: false, reason: 'LVL BLOCKED: ' + lvlCheck.reason };
    }
  }

  // GATE 10: 2-Bar Confirmation
  if (price && lvls) {
    var barCheck = check2Bar(ticker, type, price, lvls);
    console.log('[EXECUTE-NOW] 2-BAR: ' + barCheck.reason);
    if (!barCheck.confirmed) {
      return { execute: false, reason: '2-BAR PENDING: ' + barCheck.reason };
    }
  }

  // ALL GATES PASSED -- record and execute
  todaySetups.push({ ticker, type, grade, time: new Date().toISOString() });
  todayTickers[ticker] = true;
  saveState();

  console.log('[EXECUTE-NOW] ✅ ALL GATES PASSED: ' + ticker + ' ' + type + ' ' + grade);

  return {
    execute:   true,
    grade:     grade,
    contracts: contracts,
    reason:    grade + ' -- ' + confluence + '/6' + (hasFlow ? ' + flow' : '') + ' -- LVL confirmed -- 2-bar confirmed',
    isIndex:   isIndex(ticker),
    entryTF:   isIndex(ticker) ? '1HR' : '5MIN',
    lvls:      lvls,
    stopCalc:  null, // Will be calculated after contract resolution with premium/delta
  };
}

// ============================================================
// BUILD CARD WITH STRUCTURAL STOPS
// ============================================================
function buildExecuteCard(signal, decision, resolved) {
  var ticker    = signal.ticker;
  var type      = signal.type;
  var premium   = resolved && resolved.mid ? parseFloat(resolved.mid) : null;
  var direction = type === 'call' ? 'BULLISH' : 'BEARISH';
  var typeLabel = type === 'call' ? 'C' : 'P';
  var contracts = decision.contracts;
  var price     = resolved ? resolved.price : null;
  var delta     = resolved ? resolved.delta : null;

  // Calculate structural stop
  var stopInfo = premium ? calcStructuralStop(ticker, type, premium, decision.lvls, price, delta) : null;
  var stop     = stopInfo ? stopInfo.stopPrice : (premium ? parseFloat((premium * 0.60).toFixed(2)) : null);
  var t1Pct    = getT1Pct(ticker);
  var t1       = premium ? parseFloat((premium * (1 + t1Pct)).toFixed(2)) : null;

  // Contract sizing -- $6K rules
  if (premium && premium > MAX_PREMIUM) {
    contracts = 0; // Skip -- over max premium
  } else if (premium && premium <= 1.20) {
    contracts = Math.min(contracts, 2);
  } else {
    contracts = 1;
  }

  var limit = premium ? parseFloat((premium * 0.875).toFixed(2)) : null;
  var risk  = premium && stop ? '$' + ((premium - stop) * 100 * contracts).toFixed(0) : 'check';

  var now = new Date();
  var lines = [
    decision.grade === 'A+' ? '🔥 A+  EXECUTE NOW -- ' + contracts + ' CONTRACTS' : '⚡ A   EXECUTE NOW -- HIGH PRIORITY',
    ticker + ' ' + (resolved && resolved.strike ? '$' + resolved.strike : '') + typeLabel + ' -- ' + direction,
    '===============================',
    'Grade       ' + decision.grade,
    'Entry TF    ' + decision.entryTF,
    'Stop Type   ' + (stopInfo ? stopInfo.stopType + ': ' + stopInfo.reason : 'FLAT 40%'),
    '-------------------------------',
  ];

  if (premium) {
    if (premium > MAX_PREMIUM) {
      lines.push('⚠️  PREMIUM $' + premium.toFixed(2) + ' EXCEEDS $' + MAX_PREMIUM + ' MAX -- SKIP');
    } else {
      lines.push('Entry   $' + premium.toFixed(2) + ' x' + contracts + ' = $' + (premium * contracts * 100).toFixed(0));
      lines.push('Limit   $' + (limit || '?') + ' (12.5% retrace)');
      lines.push('Stop    $' + (stop || '?') + ' (' + (stopInfo ? stopInfo.stopType : 'flat') + ')');
      lines.push('T1      $' + (t1 || '?') + ' (+' + (t1Pct * 100).toFixed(0) + '%)');
      lines.push('Risk    ' + risk + ' max');
    }
  }

  if (decision.lvls) {
    lines.push('-------------------------------');
    lines.push('PDH $' + decision.lvls.pdh.toFixed(2) + ' | PDL $' + decision.lvls.pdl.toFixed(2) + ' | PDC $' + decision.lvls.pdc.toFixed(2));
  }

  lines.push('-------------------------------');
  lines.push('Reason     ' + decision.reason);
  lines.push('Time       ' + now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET');

  return lines.join('\n');
}

// Post to Discord
async function postExecuteNow(card) {
  var webhook = EXECUTE_NOW_WEBHOOK || CONVICTION_WEBHOOK;
  if (!webhook) { console.log('[EXECUTE-NOW] No webhook'); return; }
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + card + '\n```', username: 'Stratum Execute Now' }),
    });
    console.log('[EXECUTE-NOW] Posted to Discord OK');
  } catch(e) { console.error('[EXECUTE-NOW] Error:', e.message); }
}

// ============================================================
// STALE ORDER CANCEL -- cancel unfilled entries older than 30 min
// ============================================================
async function cancelStaleOrders() {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) return;
    var simAccount = process.env.SIM_ACCOUNT_ID || 'SIM3142118M';
    var baseUrl = 'https://sim-api.tradestation.com/v3';
    var res = await fetch(baseUrl + '/brokerage/accounts/' + simAccount + '/orders', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var orders = data.Orders || [];
    var now = Date.now();
    var STALE_MS = 30 * 60 * 1000;
    var cancelled = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var st = o.StatusDescription || '';
      if (st !== 'Received' && st !== 'Queued' && st !== 'Open') continue;
      var legs = o.Legs || [];
      var isBuy = legs.some(function(l) { return l.BuyOrSell === 'Buy' && l.OpenOrClose === 'Open'; });
      if (!isBuy) continue;
      var age = now - new Date(o.OpenedDateTime || 0).getTime();
      if (age > STALE_MS) {
        var oid = o.OrderID || o.OrderId;
        console.log('[CANCEL-STALE] Cancelling ' + oid + ' (' + (age/60000).toFixed(0) + 'min old)');
        try {
          await fetch(baseUrl + '/orderexecution/orders/' + oid, {
            method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
          });
          cancelled++;
        } catch(e) {}
      }
    }
    if (cancelled) console.log('[CANCEL-STALE] Cancelled ' + cancelled + ' stale orders');
  } catch(e) { console.error('[CANCEL-STALE] Error:', e.message); }
}

// ============================================================
// HARD CLOSE 3:30 PM -- close all day trade positions
// ============================================================
async function hardCloseAllPositions() {
  try {
    var now = new Date();
    var etH = ((now.getUTCHours()-4)+24)%24, etM = now.getUTCMinutes();
    if (etH !== 15 || etM < 25 || etM > 35) return;
    console.log('[HARD-CLOSE] 3:30 PM -- closing all positions');
    var ts = require('./tradestation');
    var orderExecutor = require('./orderExecutor');
    var token = await ts.getAccessToken();
    if (!token) return;
    var simAccount = process.env.SIM_ACCOUNT_ID || 'SIM3142118M';
    var res = await fetch('https://sim-api.tradestation.com/v3/brokerage/accounts/' + simAccount + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var positions = data.Positions || [];
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      console.log('[HARD-CLOSE] Closing ' + p.Symbol + ' x' + p.Quantity);
      try {
        await orderExecutor.placeOrder({ account: simAccount, symbol: p.Symbol, action: 'SELLTOCLOSE', qty: parseInt(p.Quantity || 1), type: 'Market' });
      } catch(e) { console.error('[HARD-CLOSE] Error:', e.message); }
    }
  } catch(e) { console.error('[HARD-CLOSE] Error:', e.message); }
}

module.exports = {
  shouldExecute, buildExecuteCard, postExecuteNow, resetDailySetups,
  isIndex, CORE_WATCHLIST, calcStructuralStop, checkLVL, check2Bar, isEntryWindow,
  cancelStaleOrders, hardCloseAllPositions,
};
