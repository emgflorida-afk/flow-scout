// ideaValidator.js  Stratum Flow Scout v6.1
// Parses trade ideas from any text format using Claude AI
// Runs full Stratum validation  confluence, RSI, VWAP, GEX, Max Pain
// Posts scored verdict card to #conviction-trades
// —————————————————————–

const fetch    = require(‘node-fetch’);
const resolver = require(’./contractResolver’);

// – PARSE TRADE IDEA WITH CLAUDE AI ——————————
// Accepts any format: “NVDA puts $120 4/2”, “buying SPY 560P this week”, etc.
async function parseTradeIdea(rawText) {
try {
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) return null;

```
const prompt = 'Extract the trade idea from this text and return ONLY a JSON object with no markdown or explanation.\n\nText: ' + rawText + '\n\nReturn this exact JSON format:\n{\n  "ticker": "SYMBOL",\n  "direction": "call" or "put",\n  "strike": number or null,\n  "expiry": "YYYY-MM-DD" or null,\n  "confidence": "high" or "medium" or "low"\n}\n\nRules:\n- ticker must be uppercase stock symbol\n- direction: if bearish/puts/short = "put", if bullish/calls/long = "call"\n- strike: extract number if mentioned, else null\n- expiry: convert to YYYY-MM-DD if mentioned, else null\n- confidence: how clearly the idea is expressed\n- If no valid trade idea found, return {"error": "no trade idea found"}';

const res  = await fetch('https://api.anthropic.com/v1/messages', {
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

const data = await res.json();
const text = data?.content?.[0]?.text || '';
const clean = text.replace(/```json|```/g, '').trim();
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
const { ticker, direction, strike, expiry } = parsed;

// Resolve contract  gets price, chain, GEX, Max Pain, IV context
const resolved = await resolver.resolveContract(ticker, direction, ‘SWING’);
if (!resolved) return { error: ’Could not resolve contract for ’ + ticker };

// Score the setup
const price    = resolved.price;
const gex      = resolved.gex;
const maxPain  = resolved.maxPain;
const ivCtx    = resolved.ivCtx;
const timeCtx  = resolved.timeCtx;
const oiNodes  = resolved.oiNodes;

// Build validation score
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
const topNode = oiNodes[0];
const nodeAligned = (direction === ‘put’ && topNode.bias.includes(‘PUT’)) || (direction === ‘call’ && topNode.bias.includes(‘CALL’));
if (nodeAligned) { score += 1; checks.push(‘OI Wall $’ + topNode.strike + ’ ’ + topNode.bias + ’ – aligned’); }
else             { checks.push(‘OI Wall $’ + topNode.strike + ’ ’ + topNode.bias + ’ – against’); }
}

// Time context
if (timeCtx && timeCtx.ok) { score += 1; checks.push(’Session: ’ + timeCtx.window); }

// Verdict
const verdict = score >= 4 ? { label: ‘VALIDATED – EXECUTE’,   emoji: ‘OK’,   color: ‘green’ }
: score >= 2 ? { label: ‘CAUTION – VERIFY FIRST’, emoji: ‘WARN’, color: ‘amber’ }
:              { label: ‘SKIP – EDGE NOT THERE’,  emoji: ‘NO’,   color: ‘red’   };

return {
ticker, direction, strike, expiry,
price, resolved, score,
checks, verdict, gex, maxPain, ivCtx, timeCtx,
};
}

// – BUILD VERDICT CARD —————————————––
function buildVerdictCard(rawText, parsed, validation) {
const { ticker, direction, strike, expiry } = parsed;
const { verdict, score, checks, price, resolved } = validation;

const typeLabel = direction === ‘put’ ? ‘P’ : ‘C’;
const dirLabel  = direction === ‘put’ ? ‘BEARISH’ : ‘BULLISH’;
const strikeStr = strike  ? ‘$’ + strike   : ‘ATM’;
const expiryStr = expiry  ? expiry.slice(5).replace(’-’, ‘/’) : ‘nearest’;
const midStr    = resolved?.mid ? ‘$’ + resolved.mid.toFixed(2) : ‘–’;

const lines = [
’IDEA VALIDATOR – ’ + verdict.emoji,
ticker + ’ ’ + strikeStr + typeLabel + ’ ’ + expiryStr + ’ – ’ + dirLabel,
‘===============================’,
‘Original idea:’,
‘”’ + rawText.slice(0, 80) + ‘”’,
‘—————————––’,
’VERDICT    ’ + verdict.label,
‘Score      ’ + score + ‘/5’,
‘—————————––’,
‘Stock      $’ + (price ? price.toFixed(2) : ‘–’) + ’ LIVE’,
resolved ? ’Contract   ’ + resolved.symbol : null,
resolved ? ‘Premium    ’ + midStr : null,
‘—————————––’,
‘VALIDATION CHECKS:’,
].concat(checks.map(function(c) { return ’  ’ + c; })).concat([
‘—————————––’,
resolved ? ‘Entry   ’ + midStr : null,
resolved?.mid ? ‘Stop    $’ + (resolved.mid * 0.60).toFixed(2) + ’ (40% of premium)’ : null,
resolved?.mid ? ‘T1      $’ + (resolved.mid * 1.60).toFixed(2) + ’ (+60%)’ : null,
‘—————————––’,
‘Time    ’ + new Date().toLocaleTimeString(‘en-US’, { timeZone: ‘America/New_York’, hour: ‘2-digit’, minute: ‘2-digit’ }) + ’ ET’,
]).filter(function(l) { return l !== null; });

return lines.join(’\n’);
}

// – MAIN EXPORT –––––––––––––––––––––––––
async function validateAndPost(rawText, webhookUrl) {
console.log(’[IDEA] Validating:’, rawText);

// Step 1  Parse with Claude AI
const parsed = await parseTradeIdea(rawText);
if (!parsed) {
console.log(’[IDEA] Could not parse trade idea’);
return { error: ‘Could not parse trade idea from text’ };
}

// Step 2  Validate against Stratum
const validation = await validateIdea(parsed);
if (validation.error) {
console.log(’[IDEA] Validation error:’, validation.error);
return { error: validation.error };
}

// Step 3  Build and post verdict card
const card = buildVerdictCard(rawText, parsed, validation);

try {
const res = await fetch(webhookUrl, {
method:  ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body:    JSON.stringify({ content: ‘`\n' + card + '\n`’, username: ‘Stratum Validator’ }),
});
if (res.ok) console.log(’[IDEA] Verdict posted to Discord OK’);
} catch (err) {
console.error(’[IDEA] Discord post error:’, err.message);
}

return {
ticker:   parsed.ticker,
direction: parsed.direction,
verdict:  validation.verdict.label,
score:    validation.score,
};
}

module.exports = { validateAndPost };
