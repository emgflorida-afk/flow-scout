// stratumAgent.js -- Stratum v7.4
// THE MASTER AUTONOMOUS AGENT
// This is the brain of the entire system
// Runs continuously and manages everything:
// Morning routine, signal processing, journaling
// All powered by Claude AI + TradeStation API
// Zero manual intervention needed

var fetch   = require('node-fetch');
var cron    = require('node-cron');

var etTime = null;
try { etTime = require('./etTime'); } catch(e) {}

var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
var TS_BASE        = 'https://api.tradestation.com/v3';
var ACCOUNT_ID     = '11975462';

// Discord webhooks
var WEBHOOKS = {
  executeNow:  process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
    'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx',
  journal:     process.env.DISCORD_JOURNAL_WEBHOOK ||
    'https://discord.com/api/webhooks/1488702394551238778/u4xe8u7xLuh_4g6-IR1ZSEo41O8Q2QCLEKiC455y_WzXbCmSAiUfIHFMH4_7JljbuT43',
  strat:       process.env.DISCORD_WEBHOOK_URL,
  conviction:  process.env.DISCORD_CONVICTION_WEBHOOK_URL,
};

// Agent state -- persists in memory during session
var agentState = {
  macroBias:     'MIXED',
  h6Bias:        'MIXED',
  bodEquity:     0,
  buyingPower:   0,
  openPositions: [],
  conflictMap:   {},
  setupsToday:   0,
  goalHit:       false,
  lastUpdate:    null,
};

// ================================================================
// TRADESTATION DATA LAYER
// ================================================================
async function getTSToken() {
  try {
    var ts = require('./tradestation');
    return await ts.getAccessToken();
  } catch(e) {
    console.error('[AGENT] TS token error:', e.message);
    return null;
  }
}

async function getTSData(endpoint) {
  var token = await getTSToken();
  if (!token) return null;
  try {
    var res = await fetch(TS_BASE + endpoint, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) {
    console.error('[AGENT] TS data error:', e.message);
    return null;
  }
}

async function getLiveBalances() {
  var data = await getTSData('/brokerage/accounts/' + ACCOUNT_ID + '/balances');
  if (!data || !data.Balances || !data.Balances[0]) return null;
  var b = data.Balances[0];
  return {
    equity:       parseFloat(b.Equity          || 0),
    buyingPower:  parseFloat(b.BuyingPower      || 0),
    realizedPnL:  parseFloat(b.RealizedProfitLoss || 0),
    unrealizedPnL:parseFloat(b.UnrealizedProfitLoss || 0),
    optionsBP:    parseFloat(b.OptionBuyingPower || 0),
  };
}

async function getLivePositions() {
  var data = await getTSData('/brokerage/accounts/' + ACCOUNT_ID + '/positions');
  if (!data) return [];
  return data.Positions || [];
}

async function get6HRBars() {
  var token = await getTSToken();
  if (!token) return null;
  try {
    var url = TS_BASE + '/marketdata/barcharts/SPY?unit=Daily&interval=1&barsback=5';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    var data = await res.json();
    return data.Bars || [];
  } catch(e) { return null; }
}

async function get4HRBars(ticker) {
  var token = await getTSToken();
  if (!token) return null;
  try {
    var url = TS_BASE + '/marketdata/barcharts/' + ticker + '?unit=Minute&interval=240&barsback=3&sessiontemplate=Default';
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    var data = await res.json();
    return data.Bars || [];
  } catch(e) { return null; }
}

// ================================================================
// DIRECTION ANALYSIS
// ================================================================
function analyzeBars(bars) {
  if (!bars || bars.length < 2) return 'MIXED';
  var curr  = bars[bars.length - 1];
  var prev  = bars[bars.length - 2];
  var close = parseFloat(curr.Close || 0);
  var open  = parseFloat(curr.Open  || 0);
  var prevH = parseFloat(prev.High  || 0);
  var prevL = parseFloat(prev.Low   || 0);
  if (close > open && close > prevH) return 'BULLISH';
  if (close < open && close < prevL) return 'BEARISH';
  if (close > open) return 'BULLISH';
  if (close < open) return 'BEARISH';
  return 'MIXED';
}

function buildConflictMap(positions) {
  var map = {};
  positions.forEach(function(p) {
    var sym = p.Symbol || '';
    if (!sym.includes(' ')) return;
    var ticker = sym.split(' ')[0];
    var isCall = sym.toUpperCase().includes('C');
    var isPut  = sym.toUpperCase().includes('P');
    if (!map[ticker]) map[ticker] = [];
    if (isCall && !map[ticker].includes('call')) map[ticker].push('call');
    if (isPut  && !map[ticker].includes('put'))  map[ticker].push('put');
  });
  return map;
}

// ================================================================
// CLAUDE AGENT DECISION
// ================================================================
async function claudeDecide(signal, context) {
  if (!ANTHROPIC_KEY) return ruleDecide(signal, context);

  var now    = new Date();
  var _et = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et.hour; var etMin = _et.min;
  var etTimeStr = etHour + ':' + (etMin < 10 ? '0' : '') + etMin + ' ET';
  var isPrime = (etHour * 60 + etMin) >= (9 * 60 + 45) && (etHour * 60 + etMin) <= (11 * 60);

  var prompt = [
    'You are Stratum autonomous trading agent.',
    'Make a precise trading decision. Reply ONLY with JSON.',
    '',
    'SIGNAL: ticker=' + signal.ticker + ' type=' + signal.type +
    ' confluence=' + (signal.confluence || '0/6') +
    ' strategy=' + (signal.strategy || 'STRAT') +
    ' hasFlow=' + (signal.hasFlow || false),
    '',
    'MARKET: time=' + etTimeStr + ' primeTime=' + isPrime +
    ' spyPrice=$' + (context.spyPrice || 0) +
    ' macroBias=' + context.macroBias +
    ' h6Bias=' + context.h6Bias +
    ' h4Bias=' + (context.h4Bias || 'MIXED'),
    '',
    'ACCOUNT: buyingPower=$' + context.buyingPower +
    ' openPositions=' + context.openPositions +
    ' setupsToday=' + context.setupsToday +
    ' conflictOn=' + (context.conflictPositions || 'none'),
    '',
    'RULES (non-negotiable):',
    '1. 6HR bullish=CALLS ONLY, 6HR bearish=PUTS ONLY',
    '2. No opposite side on same ticker',
    '3. No entries after 11AM ET',
    '4. Buying power must be above $300',
    '5. Max 5 setups per day',
    '6. A+(5/6+flow)=2 contracts T1+T2, A(5/6)=1 contract T1',
    '7. Index tickers(SPY,QQQ,IWM) use 1HR entry not 15-min',
    '',
    'Respond ONLY with this exact JSON:',
    '{"execute":true,"grade":"A+","contracts":2,"entryTF":"15","reason":"brief reason","warning":null}',
  ].join('\n');

  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return ruleDecide(signal, context);
    var data  = await res.json();
    var text  = data.content && data.content[0] && data.content[0].text;
    if (!text) return ruleDecide(signal, context);
    var clean = text.replace(/```json|```/g, '').trim();
    var dec   = JSON.parse(clean);
    console.log('[AGENT] Claude decided:', JSON.stringify(dec));
    return dec;
  } catch(e) {
    console.error('[AGENT] Claude error:', e.message);
    return ruleDecide(signal, context);
  }
}

// Rule-based fallback
function ruleDecide(signal, context) {
  var conf    = parseInt(String(signal.confluence || '0').split('/')[0]) || 0;
  var type    = signal.type;
  var h6      = context.h6Bias || 'MIXED';
  var bp      = context.buyingPower || 0;
  var hasFlow = signal.hasFlow || false;
  var now     = new Date();
  var _et2 = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et2.hour; var etMin = _et2.min;
  var isPrime = (etHour * 60 + etMin) >= (9 * 60 + 45) && (etHour * 60 + etMin) <= (11 * 60);
  var isIndex = ['SPY','QQQ','IWM'].includes((signal.ticker||'').toUpperCase());

  if (!isPrime)                                    return { execute: false, grade: 'C', contracts: 0, reason: 'Outside prime time' };
  if (bp < 300)                                    return { execute: false, grade: 'C', contracts: 0, reason: 'Buying power under $300' };
  if (h6 === 'BULLISH' && type === 'put')          return { execute: false, grade: 'C', contracts: 0, reason: '6HR BULLISH -- no puts' };
  if (h6 === 'BEARISH' && type === 'call')         return { execute: false, grade: 'C', contracts: 0, reason: '6HR BEARISH -- no calls' };
  if ((context.setupsToday || 0) >= 5)             return { execute: false, grade: 'C', contracts: 0, reason: 'Max 5 setups today' };

  if (conf >= 5 && hasFlow) return { execute: true,  grade: 'A+', contracts: 2, entryTF: isIndex ? '60' : '15', reason: 'A+ 5/6+flow' };
  if (conf >= 5)            return { execute: true,  grade: 'A',  contracts: 1, entryTF: isIndex ? '60' : '15', reason: 'A 5/6' };
  if (conf >= 4 && hasFlow) return { execute: true,  grade: 'A',  contracts: 1, entryTF: isIndex ? '60' : '15', reason: 'A 4/6+flow' };
  return { execute: false, grade: 'B', contracts: 0, reason: 'Insufficient confluence' };
}

// ================================================================
// BUILD EXECUTE-NOW CARD
// ================================================================
function buildCard(signal, decision, resolved) {
  var ticker    = signal.ticker;
  var type      = signal.type;
  var premium   = resolved && resolved.mid ? parseFloat(resolved.mid) : null;
  var limit     = premium ? (premium * 0.875).toFixed(2) : 'ask x 0.875';
  var stop      = premium ? (premium * 0.60).toFixed(2)  : 'set 40%';
  var t1        = premium ? (premium * 1.60).toFixed(2)  : 'T1';
  var t2        = premium ? (premium * 2.20).toFixed(2)  : 'T2';
  var contracts = decision.contracts || 1;
  var entryTF   = decision.entryTF === '60' ? '1HR candle (INDEX)' : '15-min candle';
  var now       = new Date();
  var _et3 = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et3.hour; var etMin = _et3.min;
  var cancelMin = Math.min(etHour * 60 + etMin + 90, 11 * 60);
  var cH = Math.floor(cancelMin / 60);
  var cM = cancelMin % 60;
  var cancelStr = (cH > 12 ? cH - 12 : cH) + ':' + (cM < 10 ? '0' : '') + cM + (cH >= 12 ? 'PM' : 'AM') + ' ET';

  var lines = [
    decision.grade + '  EXECUTE NOW -- ' + (contracts === 2 ? '2 CONTRACTS' : '1 CONTRACT'),
    ticker + ' ' + type.toUpperCase() + ' -- ' + (type === 'call' ? 'BULLISH' : 'BEARISH'),
    '===============================',
    'Grade      ' + decision.grade + (decision.grade === 'A+' ? ' -- SIZE UP' : ''),
    'Entry TF   ' + entryTF,
    '-------------------------------',
  ];

  if (premium) {
    lines.push('Entry   $' + premium.toFixed(2) + ' x' + contracts + ' = $' + (premium * contracts * 100).toFixed(0));
    lines.push('Limit   $' + limit + ' (12.5% retrace -- SET THIS)');
    lines.push('Stop    $' + stop + ' (40% stop -- SET THIS)');
    if (contracts === 2) {
      lines.push('T1      $' + t1 + '  close contract 1');
      lines.push('T2      $' + t2 + '  ride contract 2');
    } else {
      lines.push('T1      $' + t1 + '  close here');
    }
  }

  lines.push('-------------------------------');
  lines.push('Macro   ' + agentState.h6Bias + ' (6HR boss)');
  lines.push('Reason  ' + decision.reason);
  lines.push('Cancel  ' + cancelStr + ' -- prime time only');
  lines.push('Time    ' + now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit'
  }) + ' ET');

  return lines.join('\n');
}

// ================================================================
// POST TO DISCORD
// ================================================================
async function post(webhook, content, username) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + content + '\n```', username: username || 'Stratum Agent' }),
    });
  } catch(e) { console.error('[AGENT] Discord error:', e.message); }
}

// ================================================================
// REFRESH AGENT STATE -- called every 5 minutes
// ================================================================
async function refreshState() {
  try {
    var [balances, positions, h6Bars] = await Promise.all([
      getLiveBalances(),
      getLivePositions(),
      get6HRBars(),
    ]);

    if (balances) {
      agentState.buyingPower = balances.buyingPower;
      if (!agentState.bodEquity) agentState.bodEquity = balances.equity;
    }

    if (positions) {
      agentState.openPositions = positions;
      agentState.conflictMap   = buildConflictMap(positions);
    }

    if (h6Bars) {
      agentState.h6Bias    = analyzeBars(h6Bars);
      agentState.macroBias = agentState.h6Bias;
    }

    agentState.lastUpdate = new Date();
    console.log('[AGENT] State refreshed -- 6HR=' + agentState.h6Bias +
      ' BP=$' + agentState.buyingPower + ' Positions=' + agentState.openPositions.length);
  } catch(e) {
    console.error('[AGENT] Refresh error:', e.message);
  }
}

// ================================================================
// PROCESS INCOMING SIGNAL -- called from alerter.js
// ================================================================
async function processSignal(signal, resolved) {
  if (!signal || !signal.ticker) return;

  var ticker  = signal.ticker.toUpperCase();
  var type    = signal.type || 'call';
  var conflict = agentState.conflictMap[ticker] || [];

  // Build context from live state
  var context = {
    spyPrice:          agentState.openPositions.length > 0 ? 'live' : 'unknown',
    macroBias:         agentState.macroBias,
    h6Bias:            agentState.h6Bias,
    buyingPower:       agentState.buyingPower,
    openPositions:     agentState.openPositions.filter(function(p) {
      return p.Symbol && p.Symbol.includes(' ');
    }).length,
    setupsToday:       agentState.setupsToday,
    conflictPositions: conflict.length > 0 ? conflict.join(',') : 'none',
  };

  // Get Claude's decision
  var decision = await claudeDecide(signal, context);
  console.log('[AGENT] ' + ticker + ' ' + type + ' -> ' + (decision.execute ? 'EXECUTE' : 'BLOCK') + ' ' + decision.grade);

  if (!decision.execute) {
    console.log('[AGENT] Blocked: ' + decision.reason);
    return;
  }

  // Build and post card to #execute-now
  var card = buildCard(signal, decision, resolved);
  await post(WEBHOOKS.executeNow, card, 'Stratum Execute Now');
  agentState.setupsToday++;

  console.log('[AGENT] Posted to #execute-now -- setups today: ' + agentState.setupsToday);
}

// ================================================================
// AUTONOMOUS MORNING ROUTINE -- 7:30AM ET
// ================================================================
async function morningRoutine() {
  console.log('[AGENT] Running morning routine...');
  await refreshState();

  var today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric'
  });

  var optPositions = agentState.openPositions.filter(function(p) {
    return p.Symbol && p.Symbol.includes(' ');
  });

  var pnlLines = optPositions.map(function(p) {
    var pnl  = parseFloat(p.UnrealizedProfitLoss || 0);
    var icon = pnl >= 0 ? '+' : '';
    return '  ' + p.Symbol + '  ' + icon + '$' + pnl.toFixed(0);
  });

  var brief = [
    'STRATUM MORNING BRIEF -- ' + today,
    '===============================',
    '6HR BOSS:  ' + agentState.h6Bias,
    'DIRECTION: ' + (agentState.h6Bias === 'BULLISH' ? 'CALLS ONLY today' :
                     agentState.h6Bias === 'BEARISH' ? 'PUTS ONLY today' :
                     'WAIT for 6HR clarity'),
    'BUYING PWR: $' + agentState.buyingPower.toFixed(0),
    '-------------------------------',
    'OPEN POSITIONS: ' + optPositions.length,
  ].concat(pnlLines).concat([
    '-------------------------------',
    'RULES TODAY:',
    '  Watch #execute-now ONLY',
    '  ' + (agentState.h6Bias === 'BULLISH' ? 'CALLS ONLY -- 6HR bullish' :
             agentState.h6Bias === 'BEARISH' ? 'PUTS ONLY -- 6HR bearish' :
             'WAIT for 6HR direction'),
    '  Prime time: 9:45AM - 11:00AM ET',
    '  Retracement entry only (ask x 0.875)',
    '  Max 5 setups -- 2 contracts on A+',
    '-------------------------------',
    'Claude agent is LIVE and monitoring all signals',
  ]);

  await post(WEBHOOKS.strat, brief.join('\n'), 'Stratum Morning');
  agentState.setupsToday = 0; // reset daily counter
  console.log('[AGENT] Morning routine complete');
}

// ================================================================
// AUTONOMOUS EOD JOURNAL -- 4:00PM ET
// ================================================================
async function eodJournal() {
  console.log('[AGENT] Running EOD journal...');
  await refreshState();

  var balances  = await getLiveBalances();
  var positions = agentState.openPositions;

  var today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  var realizedPnL   = balances ? balances.realizedPnL   : 0;
  var unrealizedPnL = balances ? balances.unrealizedPnL : 0;
  var equity        = balances ? balances.equity        : 0;
  var buyingPower   = balances ? balances.buyingPower   : 0;
  var dayChange     = equity - agentState.bodEquity;

  // Grade the day
  var grade;
  if (realizedPnL >= 400)       grade = 'A+';
  else if (realizedPnL >= 250)  grade = 'A';
  else if (realizedPnL >= 100)  grade = 'B';
  else if (realizedPnL >= 0)    grade = 'C';
  else                          grade = 'D';

  var optPositions = positions.filter(function(p) {
    return p.Symbol && p.Symbol.includes(' ');
  });

  var posLines = optPositions.map(function(p) {
    var pnl  = parseFloat(p.UnrealizedProfitLoss || 0);
    var icon = pnl >= 0 ? '+' : '';
    return '  ' + p.Symbol + '  ' + icon + '$' + pnl.toFixed(0);
  });

  var journal = [
    'TRADING JOURNAL -- ' + today,
    '===============================',
    'GRADE: ' + grade,
    '-------------------------------',
    'ACCOUNT',
    '  Equity:        $' + equity.toFixed(2),
    '  Day change:    ' + (dayChange >= 0 ? '+' : '') + '$' + dayChange.toFixed(2),
    '  Realized P&L:  ' + (realizedPnL >= 0 ? '+' : '') + '$' + realizedPnL.toFixed(2),
    '  Unrealized:    ' + (unrealizedPnL >= 0 ? '+' : '') + '$' + unrealizedPnL.toFixed(2),
    '  Buying power:  $' + buyingPower.toFixed(2),
    '  Goal $400/day: ' + (realizedPnL >= 400 ? 'HIT' : '$' + (400 - realizedPnL).toFixed(0) + ' remaining'),
    '-------------------------------',
    'OPEN POSITIONS: ' + optPositions.length,
  ].concat(posLines).concat([
    '-------------------------------',
    'Setups taken today: ' + agentState.setupsToday + ' / 5 max',
    'Agent status: LIVE',
    '-------------------------------',
    'TOMORROW:',
    '  Morning brief fires at 7:30AM automatically',
    '  Watch #execute-now ONLY',
    '  Agent will filter all signals',
  ]);

  await post(WEBHOOKS.journal, journal.join('\n'), 'Stratum Journal');
  console.log('[AGENT] EOD journal posted -- grade=' + grade);
}

// ================================================================
// CRON SCHEDULE
// ================================================================
function startCrons() {
  // 7:30AM ET -- morning routine (Mon-Fri)
  cron.schedule('30 11 * * 1-5', function() {
    morningRoutine().catch(console.error);
  });

  // Every 5 minutes during market hours -- refresh state
  cron.schedule('*/5 9-16 * * 1-5', function() {
    refreshState().catch(console.error);
  });

  // 4:00PM ET -- EOD journal (Mon-Fri)
  cron.schedule('0 20 * * 1-5', function() {
    eodJournal().catch(console.error);
  });

  // Midnight -- reset daily counters
  cron.schedule('0 4 * * 1-5', function() {
    agentState.setupsToday = 0;
    agentState.goalHit     = false;
    agentState.bodEquity   = 0;
    console.log('[AGENT] Daily reset complete');
  });

  console.log('[AGENT] Crons started -- morning 7:30AM, refresh every 5min, journal 4PM');
}

// ================================================================
// EXPORTS
// ================================================================
module.exports = {
  processSignal,
  refreshState,
  morningRoutine,
  eodJournal,
  startCrons,
  getState: function() { return agentState; },
  setManualBias: function(bias) {
    agentState.macroBias = bias;
    agentState.h6Bias    = bias;
    console.log('[AGENT] Manual bias set:', bias);
  },
};
