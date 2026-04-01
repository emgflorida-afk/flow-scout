// executeNow.js -- Stratum v7.4
// #execute-now channel -- ONLY fires when ALL agree same direction:
// 6HR + 4HR + Strat + Flow = same direction
// This is the ONLY channel you trade from
// Max 3-5 setups per day -- zero contradictions

var fetch = require('node-fetch');

var EXECUTE_NOW_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
var CONVICTION_WEBHOOK  = process.env.DISCORD_CONVICTION_WEBHOOK;

// Core watchlist -- trade every day no matter what
var CORE_WATCHLIST = [
  // Indices (1HR entry)
  'SPY', 'QQQ', 'IWM',
  // Tech
  'NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'MRVL', 'AVGO',
  // Finance
  'JPM', 'GS', 'MS', 'WFC',
  // Movers
  'TSLA', 'COIN', 'DKNG',
  // Defense (NATO news)
  'LMT', 'RTX', 'NOC', 'GD', 'LDOS',
  // Airlines (oil dropping)
  'DAL', 'UAL', 'LUV'
];

var INDEX_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Track setups today
var todaySetups = [];
var MAX_SETUPS_PER_DAY = 5;

function resetDailySetups() {
  todaySetups = [];
  console.log('[EXECUTE-NOW] Daily setups reset');
}

// Check if ticker is an index (uses 1HR entry)
function isIndex(ticker) {
  return INDEX_TICKERS.includes(ticker.toUpperCase());
}

// Main decision engine
// Returns: { execute: bool, grade: string, reason: string, contracts: number }
async function shouldExecute(signal, macroBias, h6Bias, hasFlow, positions, buyingPower) {
  var ticker    = signal.ticker;
  var type      = signal.type; // call or put
  var confluence = parseInt((signal.confluence || '0').split('/')[0]) || 0;

  // Check 1 -- Max setups for today
  if (todaySetups.length >= MAX_SETUPS_PER_DAY) {
    return { execute: false, reason: 'Max ' + MAX_SETUPS_PER_DAY + ' setups reached for today' };
  }

  // Check 2 -- Core watchlist only for #execute-now
  if (!CORE_WATCHLIST.includes(ticker.toUpperCase())) {
    return { execute: false, reason: ticker + ' not in core watchlist' };
  }

  // Check 3 -- Macro filter (6HR is the boss)
  if (h6Bias === 'BULLISH' && type === 'put') {
    return { execute: false, reason: '6HR is BULLISH -- no put cards today' };
  }
  if (h6Bias === 'BEARISH' && type === 'call') {
    return { execute: false, reason: '6HR is BEARISH -- no call cards today' };
  }

  // Check 4 -- Macro SPY bias
  if (macroBias === 'BULLISH' && type === 'put') {
    return { execute: false, reason: 'SPY macro is BULLISH -- blocking put cards' };
  }
  if (macroBias === 'BEARISH' && type === 'call') {
    return { execute: false, reason: 'SPY macro is BEARISH -- blocking call cards' };
  }

  // Check 5 -- Buying power
  if (buyingPower < 300) {
    return { execute: false, reason: 'Buying power under $300 -- no new positions' };
  }

  // Check 6 -- Prime time (9:45AM - 11:00AM ET)
  var now = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  var etMin  = now.getUTCMinutes();
  var etTime = etHour * 60 + etMin;
  var PRIME_START = 9 * 60 + 45;
  var PRIME_END   = 11 * 60;

  if (etTime < PRIME_START || etTime > PRIME_END) {
    return { execute: false, reason: 'Outside prime time (9:45AM-11:00AM ET)' };
  }

  // Check 7 -- Grade and contracts
  var grade;
  var contracts;

  if (confluence >= 5 && hasFlow) {
    grade = 'A+';
    contracts = 2; // T1 + T2 runner
  } else if (confluence >= 5) {
    grade = 'A';
    contracts = 1; // T1 only
  } else if (confluence >= 4 && hasFlow) {
    grade = 'A';
    contracts = 1;
  } else {
    return { execute: false, reason: 'Insufficient confluence for #execute-now' };
  }

  // All checks passed
  todaySetups.push({ ticker, type, grade, time: new Date().toISOString() });

  return {
    execute:   true,
    grade:     grade,
    contracts: contracts,
    reason:    grade + ' -- ' + confluence + '/6 confluence' + (hasFlow ? ' + flow confirmed' : ''),
    isIndex:   isIndex(ticker),
    entryTF:   isIndex(ticker) ? '1HR' : '15MIN',
  };
}

// Build the #execute-now card
function buildExecuteCard(signal, decision, resolved) {
  var ticker    = signal.ticker;
  var type      = signal.type;
  var premium   = resolved && resolved.mid ? parseFloat(resolved.mid) : null;
  var direction = type === 'call' ? 'BULLISH' : 'BEARISH';
  var typeLabel = type === 'call' ? 'C' : 'P';

  var contracts = decision.contracts;
  var limit     = premium ? (premium * 0.875).toFixed(2) : 'set at retracement';
  var stop      = premium ? (premium * 0.60).toFixed(2) : 'set at 40%';
  var t1        = premium ? (premium * 1.60).toFixed(2) : 'T1 target';
  var t2        = premium ? (premium * 2.20).toFixed(2) : 'T2 runner';
  var risk      = premium ? '$' + (premium * 100 * 0.40).toFixed(0) : 'check premium';

  // Cancel By time
  var now = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  var etMin  = now.getUTCMinutes();
  var cancelMin = Math.min(etHour * 60 + etMin + 90, 11 * 60);
  var cancelH = Math.floor(cancelMin / 60);
  var cancelM = cancelMin % 60;
  var cancelStr = (cancelH > 12 ? cancelH - 12 : cancelH) + ':' + (cancelM < 10 ? '0' : '') + cancelM + (cancelH >= 12 ? 'PM' : 'AM') + ' ET';

  var lines = [
    decision.grade === 'A+' ? 'A+  EXECUTE NOW -- ' + decision.grade + ' GRADE -- ' + contracts + ' CONTRACTS' : 'A   EXECUTE NOW -- HIGH PRIORITY',
    ticker + ' ' + (resolved && resolved.strike ? '$' + resolved.strike : '') + typeLabel + ' -- ' + direction,
    '===============================',
    'Grade       ' + decision.grade + (decision.grade === 'A+' ? '  SIZE UP -- 2 CONTRACTS' : ''),
    'Entry TF    ' + decision.entryTF + (decision.isIndex ? '  INDEX -- use 1HR candle' : '  15-min candle'),
    '-------------------------------',
  ];

  if (premium) {
    lines.push('Entry   $' + premium.toFixed(2) + ' x' + contracts + ' = $' + (premium * contracts * 100).toFixed(0));
    lines.push('Limit   $' + limit + ' (12.5% retrace -- SET THIS)');
    lines.push('Stop    $' + stop + ' (40% stop)');
    if (contracts === 2) {
      lines.push('T1      $' + t1 + '  CLOSE CONTRACT 1 HERE');
      lines.push('T2      $' + t2 + '  RIDE CONTRACT 2 HERE');
    } else {
      lines.push('T1      $' + t1 + '  CLOSE HERE');
      lines.push('T2      $' + t2 + '  optional runner');
    }
    lines.push('Risk    ' + risk + ' max');
  }

  lines.push('-------------------------------');
  lines.push('Cancel By  ' + cancelStr + ' -- prime time only');
  lines.push('Reason     ' + decision.reason);
  lines.push('Time       ' + now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET');

  return lines.join('\n');
}

// Post to #execute-now Discord channel
async function postExecuteNow(card) {
  var webhook = EXECUTE_NOW_WEBHOOK || CONVICTION_WEBHOOK;
  if (!webhook) {
    console.log('[EXECUTE-NOW] No webhook configured');
    return;
  }
  try {
    await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  ' ```\n' + card + '\n```',
        username: 'Stratum Execute Now',
      }),
    });
    console.log('[EXECUTE-NOW] Posted to Discord OK');
  } catch(e) {
    console.error('[EXECUTE-NOW] Error:', e.message);
  }
}

module.exports = { shouldExecute, buildExecuteCard, postExecuteNow, resetDailySetups, isIndex, CORE_WATCHLIST };
