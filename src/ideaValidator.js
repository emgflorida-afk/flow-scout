// ideaValidator.js - Stratum Flow Scout v7.0
// Validates trade ideas against Stratum edge conditions

var fetch    = require('node-fetch');
var resolver = require('./contractResolver');

var capitol = null;
try { capitol = require('./capitolTrades'); } catch(e) { console.log('[CAPITOL] Not loaded'); }

async function parseTradeIdea(rawText) {
  try {
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    var prompt = 'Extract the trade idea and return ONLY JSON: {"ticker":"SYMBOL","direction":"call or put","strike":null,"expiry":null} from: ' + rawText;
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    var data = await res.json();
    var text = data && data.content && data.content[0] ? data.content[0].text : '';
    var clean = text.replace(/```json|```/g, '').trim();
    var parsed = JSON.parse(clean);
    if (parsed.error) return null;
    return parsed;
  } catch(e) { console.error('[IDEA] Parse error:', e.message); return null; }
}

async function validateIdea(parsed) {
  var ticker = parsed.ticker;
  var direction = parsed.direction;
  var resolved = await resolver.resolveContract(ticker, direction, 'SWING');
  if (!resolved) return { error: 'Could not resolve contract for ' + ticker };
  var price = resolved.price;
  var gex = resolved.gex;
  var maxPain = resolved.maxPain;
  var ivCtx = resolved.ivCtx;
  var timeCtx = resolved.timeCtx;
  var oiNodes = resolved.oiNodes;
  var score = 0;
  var checks = [];
  if (gex) {
    var gexAligned = (direction === 'put' && !gex.isPositive) || (direction === 'call' && gex.isPositive);
    if (gexAligned) { score += 2; checks.push('GEX aligned'); }
    else { checks.push('GEX against direction'); }
  }
  if (maxPain && price) {
    var painAligned = (direction === 'put' && price > maxPain) || (direction === 'call' && price < maxPain);
    if (painAligned) { score += 1; checks.push('Max Pain $' + maxPain + ' aligned'); }
    else { checks.push('Max Pain $' + maxPain + ' against'); }
  }
  if (ivCtx) {
    if (ivCtx.ivRegime.includes('LOW')) { score += 1; checks.push('IV LOW - good for buying'); }
    if (ivCtx.ivRegime.includes('ELEVATED')) { score += 1; checks.push('IV ELEVATED - spreads preferred'); }
    checks.push('Impl Move +-' + ivCtx.impliedMove + '%');
  }
  if (oiNodes && oiNodes.length > 0) {
    var topNode = oiNodes[0];
    var nodeAligned = (direction === 'put' && topNode.bias.includes('PUT')) || (direction === 'call' && topNode.bias.includes('CALL'));
    if (nodeAligned) { score += 1; checks.push('OI Wall $' + topNode.strike + ' aligned'); }
    else { checks.push('OI Wall $' + topNode.strike + ' against'); }
  }
  if (timeCtx && timeCtx.ok) { score += 1; checks.push('Session: ' + timeCtx.window); }
  var verdict = score >= 4 ? { label: 'VALIDATED - EXECUTE', emoji: 'OK' }
             : score >= 2 ? { label: 'CAUTION - VERIFY FIRST', emoji: 'WARN' }
             :               { label: 'SKIP - EDGE NOT THERE', emoji: 'NO' };
  return { ticker: ticker, direction: direction, strike: parsed.strike, expiry: parsed.expiry, price: price, resolved: resolved, score: score, checks: checks, verdict: verdict };
}

function buildVerdictCard(rawText, parsed, validation) {
  var lines = [
    'IDEA VALIDATOR - ' + validation.verdict.emoji,
    parsed.ticker + ' ' + (parsed.direction === 'put' ? 'PUT' : 'CALL') + ' - ' + (parsed.direction === 'put' ? 'BEARISH' : 'BULLISH'),
    '===============================',
    'Idea: ' + rawText.slice(0, 80),
    '-------------------------------',
    'VERDICT:  ' + validation.verdict.label,
    'Score:    ' + validation.score + '/5',
    '-------------------------------',
  ];
  validation.checks.forEach(function(c) { lines.push('  ' + c); });
  lines.push('-------------------------------');
  if (validation.resolved && validation.resolved.mid) lines.push('Premium: $' + validation.resolved.mid.toFixed(2));
  if (validation.price) lines.push('Stock:   $' + validation.price);
  lines.push('Time: ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET');
  return lines.join('\n');
}

async function validateAndPost(rawText, webhookUrl) {
  console.log('[IDEA] Validating:', rawText);
  var parsed = await parseTradeIdea(rawText);
  if (!parsed) { await postToDiscord(webhookUrl, 'IDEA VALIDATOR - ERROR\nCould not parse: ' + rawText.slice(0, 80)); return; }
  var validation = await validateIdea(parsed);
  if (validation.error) { await postToDiscord(webhookUrl, 'IDEA VALIDATOR - ERROR\n' + validation.error); return; }
  var card = buildVerdictCard(rawText, parsed, validation);
  await postToDiscord(webhookUrl, card);
  console.log('[IDEA] Verdict: ' + validation.score + '/5 - ' + validation.verdict.label);
}

async function postToDiscord(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum Validator' })
    });
  } catch(e) { console.error('[IDEA] Discord error:', e.message); }
}

module.exports = { validateAndPost: validateAndPost, parseTradeIdea: parseTradeIdea, validateIdea: validateIdea };