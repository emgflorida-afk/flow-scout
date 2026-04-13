// agentDecision.js -- Stratum v7.4
// Claude Agent -- thinks before every card fires
// Checks all 8 conditions and makes the final decision
// Routes to #execute-now only when ALL conditions pass

var fetch = require('node-fetch');

var etTime = null;
try { etTime = require('./etTime'); } catch(e) {}

var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Agent decision cache -- prevent duplicate decisions on same ticker
var decisionCache = {};
var CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function agentDecide(signal, context) {
  var ticker    = signal.ticker;
  var type      = signal.type;
  var cacheKey  = ticker + '_' + type + '_' + new Date().getHours();

  // Check cache
  if (decisionCache[cacheKey] && (Date.now() - decisionCache[cacheKey].time) < CACHE_TTL) {
    console.log('[AGENT] Using cached decision for', cacheKey);
    return decisionCache[cacheKey].decision;
  }

  // Build context for agent
  var now = new Date();
  var _et = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et.hour; var etMin = _et.min;
  var timeET = (etHour > 12 ? etHour - 12 : etHour) + ':' + (etMin < 10 ? '0' : '') + etMin + (etHour >= 12 ? 'PM' : 'AM') + ' ET';
  var isPrimeTime = (etHour * 60 + etMin) >= (9 * 60 + 45) && (etHour * 60 + etMin) <= (11 * 60);

  var prompt = [
    'You are Stratum trading agent. Make a trading decision in JSON only.',
    '',
    'SIGNAL:',
    'Ticker: ' + ticker,
    'Type: ' + type + ' (call=bullish bet, put=bearish bet)',
    'Confluence: ' + (signal.confluence || '0/6'),
    'Strategy: ' + (signal.strategy || 'STRAT'),
    'Entry TF: ' + (signal.entryTF || '15') + ' minutes',
    '',
    'MARKET CONTEXT:',
    'Time ET: ' + timeET,
    'Prime time (9:45-11AM): ' + isPrimeTime,
    'SPY price: ' + (context.spyPrice || 'unknown'),
    'Macro bias: ' + (context.macroBias || 'MIXED'),
    '6HR bias: ' + (context.h6Bias || 'MIXED'),
    'Flow confirmed: ' + (context.hasFlow || false),
    'Flow size: $' + (context.flowSize || 0),
    '',
    'ACCOUNT:',
    'Buying power: $' + (context.buyingPower || 0),
    'Open positions: ' + (context.openPositions || 0),
    'Existing ' + ticker + ' positions: ' + (context.conflictPositions || 'none'),
    'Daily setups used: ' + (context.setupsToday || 0) + ' of 5 max',
    '',
    'RULES:',
    '1. 6HR bullish = CALLS ONLY. 6HR bearish = PUTS ONLY.',
    '2. Never take opposite side of existing position on same ticker.',
    '3. No entries after 11AM ET.',
    '4. Buying power must be above $300.',
    '5. Max 5 setups per day.',
    '6. A+ grade (5/6 + flow) = 2 contracts. A grade (5/6) = 1 contract.',
    '',
    'Reply with ONLY this JSON:',
    '{"execute":true/false,"grade":"A+/A/B/C","contracts":1/2,"reason":"one line max","warning":"optional warning or null"}',
  ].join('\n');

  try {
    if (!ANTHROPIC_KEY) {
      console.log('[AGENT] No Anthropic key -- using rule-based decision');
      return ruleBasedDecision(signal, context, isPrimeTime);
    }

    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.log('[AGENT] API error:', res.status, '-- using rule-based fallback');
      return ruleBasedDecision(signal, context, isPrimeTime);
    }

    var data     = await res.json();
    var text     = data.content && data.content[0] && data.content[0].text;
    if (!text)   return ruleBasedDecision(signal, context, isPrimeTime);

    var clean    = text.replace(/```json|```/g, '').trim();
    var decision = JSON.parse(clean);

    console.log('[AGENT] Decision for', ticker, type, ':', JSON.stringify(decision));

    // Cache it
    decisionCache[cacheKey] = { decision, time: Date.now() };
    return decision;

  } catch(e) {
    console.error('[AGENT] Error:', e.message, '-- using rule-based fallback');
    return ruleBasedDecision(signal, context, isPrimeTime);
  }
}

// Rule-based fallback when Anthropic API unavailable
function ruleBasedDecision(signal, context, isPrimeTime) {
  var confluence = parseInt(String(signal.confluence || '0').split('/')[0]) || 0;
  var type       = signal.type;
  var h6Bias     = context.h6Bias || 'MIXED';
  var macroBias  = context.macroBias || 'MIXED';
  var buyingPower = context.buyingPower || 0;
  var hasFlow    = context.hasFlow || false;
  var conflict   = context.conflictPositions || 'none';

  // Block conditions
  if (!isPrimeTime)                                          return { execute: false, grade: 'C', contracts: 0, reason: 'Outside prime time 9:45-11AM' };
  if (buyingPower < 300)                                     return { execute: false, grade: 'C', contracts: 0, reason: 'Buying power under $300' };
  if (h6Bias === 'BULLISH' && type === 'put')                return { execute: false, grade: 'C', contracts: 0, reason: '6HR BULLISH -- no puts today' };
  if (h6Bias === 'BEARISH' && type === 'call')               return { execute: false, grade: 'C', contracts: 0, reason: '6HR BEARISH -- no calls today' };
  if (conflict !== 'none' && conflict.includes(type))        return { execute: false, grade: 'C', contracts: 0, reason: 'Conflict -- already have ' + type + ' on ' + signal.ticker };
  if ((context.setupsToday || 0) >= 5)                       return { execute: false, grade: 'C', contracts: 0, reason: 'Max 5 setups reached today' };

  // Grade
  if (confluence >= 5 && hasFlow) return { execute: true,  grade: 'A+', contracts: 2, reason: 'A+ -- 5/6+ confluence + flow confirmed' };
  if (confluence >= 5)            return { execute: true,  grade: 'A',  contracts: 1, reason: 'A -- 5/6 confluence' };
  if (confluence >= 4 && hasFlow) return { execute: true,  grade: 'A',  contracts: 1, reason: 'A -- 4/6 + flow confirmed' };
  return { execute: false, grade: 'B', contracts: 0, reason: 'Insufficient confluence' };
}

module.exports = { agentDecide };
