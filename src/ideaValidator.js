// ideaValidator.js - Stratum Flow Scout v7.0
// Parses trade ideas from any text format using Claude AI
// Runs full Stratum validation - confluence, RSI, VWAP, GEX, Max Pain
// Posts scored verdict card to #conviction-trades
// —————————————————————–

const fetch    = require(‘node-fetch’);
const resolver = require(’./contractResolver’);

// Capitol Trades loaded safely
let capitol = null;
try { capitol = require(’./capitolTrades’); } catch(e) { console.log(’[CAPITOL] Not loaded in validator’); }

// – PARSE TRADE IDEA WITH CLAUDE AI ——————————
async function parseTradeIdea(rawText) {
try {
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) return null;

```
const prompt = 'Extract the trade idea from this text and return ONLY a JSON object with no markdown or explanation.\n\nText: ' + rawText + '\n\nReturn this exact JSON format:\n{\n  "ticker": "SYMBOL",\n  "direction": "call" or "put",\n  "strike": number or null,\n  "expiry": "YYYY-MM-DD" or null,\n  "confidence": "high" or "medium" or "low"\n}\n\nRules:\n- ticker must be uppercase stock symbol\n- direction: if bearish/puts/short = "put", if bullish/calls/long = "call"\n- strike: extract number if mentioned, else null\n- expiry: convert to YYYY-MM-DD if mentioned, else null\n- If no valid trade idea found, return {"error": "no trade idea found"}';

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method:  'POST',
  headers: {
    'Content-Type':      'application/json',
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
  }),
});

const data   = await res.json();
const text   = data && data.content && data.content[0] ? data.content[0].text : '';
const clean  = text.replace(/```json|```/g, '').trim();
const parsed = JSON.parse(clean);
if (parsed.error) return null;
console.log('[IDEA] Parsed:', JSON.stringify(parsed));
return parsed;
```

} catch (err) {
console.error(’[IDEA] Parse error:’, err.message);
return null;
}
}

// – VALIDATE IDEA AGAINST STRATUM ––––––––––––––––
async function validateIdea(parsed) {
const ticker    = parsed.ticker;
const direction = parsed.direction;
const strike    = parsed.strike;
const expiry    = parsed.expiry;

const resolved = await resolver.resolveContract(ticker, direction, ‘SWING’);
if (!resolved) return { error: ’Could not resolve contract for ’ + ticker };

const price   = resolved.price;
const gex     = resolved.gex;
const maxPain = resolved.maxPain;
const ivCtx   = resolved.ivCtx;
const timeCtx = resolved.timeCtx;
const oiNodes = resolved.oiNodes;

let score = 0;
const checks = [];

// GEX alignment
if (gex) {
const gexAligned = (direction === ‘put’ && !gex.isPositive) || (direction === ‘call’ && gex.isPositive);
if (gexAligned) { score += 2; checks.push(’GEX aligned ’ + (direction === ‘put’ ? ‘NEGATIVE trending’ : ‘POSITIVE range’)); }
else            { checks.push(’GEX against – ’ + (gex.isPositive ? ‘POSITIVE range bound’ : ‘NEGATIVE trending’)); }
}

// Max Pain alignment
if (maxPain && price) {
const painAligned = (direction === ‘put’ && price > maxPain) || (direction === ‘call’ && price < maxPain);
if (painAligned) { score += 1; checks.push(‘Max Pain $’ + maxPain + ’ – price pulled toward it’); }
else             { checks.push(‘Max Pain $’ + maxPain + ’ – against direction’); }
}

// IV context
if (ivCtx) {
if (ivCtx.ivRegime.includes(‘LOW’))      { score += 1; checks.push(‘IV LOW – good for buying’); }
if (ivCtx.ivRegime.includes(‘ELEVATED’)) { score += 1; checks.push(‘IV ELEVATED – spreads preferred’); }
checks.push(‘Impl Move +-’ + ivCtx.impliedMove + ‘% | Daily +-’ + ivCtx.dailyMove + ‘%’);
}

// OI nodes
if (oiNodes && oiNodes.length > 0) {
var topNode    = oiNodes[0];
var nodeAligned = (direction === ‘put’ && topNode.bias.includes(‘PUT’)) || (direction === ‘call’ && topNode.bias.includes(‘CALL’));
if (nodeAligned) { score += 1; checks.push(‘OI Wall $’ + topNode.strike + ’ ’ + topNode.bias + ’ – aligned’); }
else             { checks.push(‘OI Wall $’ + topNode.strike + ’ ’ + topNode.bias + ’ – against’); }
}

// Time context
if (timeCtx && timeCtx.ok) { score += 1; checks.push(’Session: ’ + timeCtx.window); }

// Verdict
var verdict = score >= 4 ? { label: ‘VALIDATED – EXECUTE’,   emoji: ‘OK’,   color: ‘green’ }
: score >= 2 ? { label: ‘CAUTION – VERIFY FIRST’, emoji: ‘WARN’, color: ‘amber’ }
:               { label: ‘SKIP – EDGE NOT THERE’,  emoji: ‘NO’,   color: ‘red’   };

return { ticker, direction, strike, expiry, price, resolved, score, checks, verdict, gex, maxPain, ivCtx, timeCtx };
}

// – BUILD VERDICT CARD —————————————––
function buildVerdictCard(rawText, parsed, validation) {
var ticker    = parsed.ticker;
var direction = parsed.direction;
var strike    = parsed.strike;
var expiry    = parsed.expiry;
var verdict   = validation.verdict;
var score     = validation.score;
var checks    = validation.checks;
var price     = validation.price;
var resolved  = validation.resolved;

var typeLabel  = direction === ‘put’ ? ‘P’ : ‘C’;
var dirLabel   = direction === ‘put’ ? ‘BEARISH’ : ‘BULLISH’;
var strikeStr  = strike ? ‘$’ + strike : ‘ATM’;
var expiryStr  = expiry ? expiry.slice(5).replace(’-’, ‘/’) : ‘nearest’;
var midStr     = resolved && resolved.mid ? ‘$’ + resolved.mid.toFixed(2) : ‘–’;

var lines = [
’IDEA VALIDATOR – ’ + verdict.emoji,
ticker + ’ ’ + strikeStr + typeLabel + ’ ’ + expiryStr + ’ – ’ + dirLabel,
‘===============================’,
‘Original idea:’,
‘”’ + rawText.slice(0, 80) + ‘”’,
‘—————————––’,
’VERDICT    ’ + verdict.label,
’Score      ’ + score + ‘/5’,
‘—————————––’,
];

checks.forEach(function(c) { lines.push(’  ’ + c); });

lines.push(’—————————––’);
if (resolved && resolved.mid) lines.push(‘Premium    ’ + midStr + ’ (live)’);
if (price) lines.push(‘Stock      $’ + price + ’ (live)’);
lines.push(‘Time       ’ + new Date().toLocaleTimeString(‘en-US’, { timeZone: ‘America/New_York’, hour: ‘2-digit’, minute: ‘2-digit’ }) + ’ ET’);

return lines.filter(function(l) { return l !== null; }).join(’\n’);
}

// – VALIDATE AND POST ––––––––––––––––––––––
async function validateAndPost(rawText, webhookUrl) {
console.log(’[IDEA] Validating:’, rawText);

var parsed = await parseTradeIdea(rawText);
if (!parsed) {
await postToDiscord(webhookUrl, ‘IDEA VALIDATOR – ERROR\nCould not parse trade idea from: “’ + rawText.slice(0, 80) + ‘”’);
return;
}

var validation = await validateIdea(parsed);
if (validation.error) {
await postToDiscord(webhookUrl, ‘IDEA VALIDATOR – ERROR\n’ + validation.error);
return;
}

var card = buildVerdictCard(rawText, parsed, validation);
await postToDiscord(webhookUrl, card);
console.log(’[IDEA] Verdict posted – Score: ’ + validation.score + ’/5 – ’ + validation.verdict.label);
}

// – POST TO DISCORD –––––––––––––––––––––––
async function postToDiscord(webhookUrl, message) {
if (!webhookUrl) return;
try {
await fetch(webhookUrl, {
method:  ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body:    JSON.stringify({ content: ‘`\n' + message + '\n`’, username: ‘Stratum Validator’ }),
});
} catch (err) {
console.error(’[IDEA] Discord error:’, err.message);
}
}

module.exports = { validateAndPost, parseTradeIdea, validateIdea };
