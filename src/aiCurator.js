// aiCurator.js — Stratum Flow Scout
// AI-powered setup scorer. Takes TV alerts + market context, asks Claude
// to apply AB's 3-gate filter + R:R math, returns GO/SKIP verdict.
//
// Per OPERATING_MODEL_apr21.md + RR_HARD_RULE.md + DAY2_CONFIRMATION_CHECKLIST.md:
//  - NEVER auto-fire to broker. This is an ANALYSIS engine, not execution.
//  - Applies R:R ≥ 2:1 gate
//  - Applies archetype-aware entry mechanism (STT vs bar-close vs retest)
//  - For John-sourced picks, applies 5-point Day 2 confirmation checklist
//  - Pushes A+ alerts (score ≥ 8) to Discord. Silent-logs skips.
// -----------------------------------------------------------------

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

var pushNotifier = null;
try { pushNotifier = require('./pushNotifier'); } catch(e) { pushNotifier = null; }

var STATE_DIR = process.env.STATE_DIR || '/tmp';
var CURATOR_LOG = path.join(STATE_DIR, 'curator_log.jsonl');

// -----------------------------------------------------------------
// Anthropic API client (minimal, no SDK dep)
// -----------------------------------------------------------------
function callClaude(systemPrompt, userPrompt) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ANTHROPIC_API_KEY not set'));

  var fetch = require('node-fetch');
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  .then(function(r) {
    if (!r.ok) return r.text().then(function(t) { throw new Error('Anthropic ' + r.status + ': ' + t.slice(0, 300)); });
    return r.json();
  })
  .then(function(data) {
    var content = (data.content && data.content[0] && data.content[0].text) || '';
    return { raw: content, usage: data.usage };
  });
}

// -----------------------------------------------------------------
// System prompt — embeds AB's doctrine
// -----------------------------------------------------------------
var SYSTEM_PROMPT = [
  'You are the AI Curator for AB, a retail options trader with ~$20K account.',
  'AB has lost money for months following other people\'s signals without disciplined filters.',
  'Your job is to score trade setups from 1-10 against his EXPLICIT doctrine and return A/B/SKIP.',
  '',
  'AB\'S DOCTRINE (non-negotiable):',
  '1. MAX 1-2 setups per session. Reject if he already has active setups that use his cognitive budget.',
  '2. Risk-to-reward must be ≥ 2:1 in his favor. REJECT if risk > reward at first TP.',
  '3. NO averaging down. Structural stops only. Stops are sacred.',
  '4. SKIP binary catalysts within 2 days (earnings, FOMC, CPI). Period.',
  '5. SKIP trades where entry archetype doesn\'t fit setup type:',
  '   - Slow-movers (WMT, KR, PG, utilities): require bar-close confirmation, NOT STT',
  '   - Momentum (NVDA, ANET, SOXL): STT or LVL retest',
  '   - Reversals (Failed 2U, Hammer): STT works if volume confirms',
  '6. For John-sourced picks, apply 5-point Day 2 Confirmation Checklist:',
  '   - Day 1 closed ≥ 0.5% above trigger',
  '   - Day 1 closed in top 30% of daily range',
  '   - Day 1 volume > 20-day avg',
  '   - Pre-market Day 2 holds above Day 1 close',
  '   - 9:45 bar green above Day 1 close',
  '   Need 5/5 for full size, 4/5 for half size, <4 = SKIP',
  '',
  'SCORING (1-10):',
  '  10 = A+ setup: scanner + John + FTFC + volume + R:R 2.5:1+ + no catalyst within 2d',
  '  8-9 = A setup: meets all doctrine gates, R:R 2:1+',
  '  6-7 = B setup: meets most gates, R:R 2:1 but some concerns — reduce size or skip',
  '  <6 = C or below: violations of doctrine — SKIP',
  '',
  'OUTPUT FORMAT (strict JSON, nothing else):',
  '{',
  '  "score": <1-10>,',
  '  "verdict": "GO" | "REDUCE" | "SKIP",',
  '  "reason_one_line": "<20 words max>",',
  '  "failure_modes": ["<concern 1>", "<concern 2>"],',
  '  "r_r_computed": <number>,',
  '  "recommended_action": "<specific action AB should take>"',
  '}',
  '',
  'Be CONSERVATIVE. When in doubt, SKIP. AB needs FEWER trades with better math,',
  'not MORE trades with optimistic scoring.',
].join('\n');

// -----------------------------------------------------------------
// Score a TV alert (or direct setup spec) against doctrine
// -----------------------------------------------------------------
function scoreSetup(setup) {
  // setup = { ticker, action, price, tf, message, bars, flow, ftfc, scanner_agreed, john_agreed, archetype, catalyst_days, ...}
  var userPrompt = 'Setup to score:\n' + JSON.stringify(setup, null, 2);
  return callClaude(SYSTEM_PROMPT, userPrompt).then(function(result) {
    // Try to parse JSON from response
    var verdict = null;
    try {
      // Find the JSON object in the response
      var match = result.raw.match(/\{[\s\S]*\}/);
      if (match) verdict = JSON.parse(match[0]);
    } catch(e) {
      verdict = { score: 0, verdict: 'SKIP', reason_one_line: 'failed to parse Claude response', failure_modes: ['parse_error'], r_r_computed: 0, recommended_action: 'review manually' };
    }
    verdict._raw = result.raw;
    verdict._usage = result.usage;
    verdict._timestamp = new Date().toISOString();
    return verdict;
  });
}

// -----------------------------------------------------------------
// Route a TV alert through curator
// Pulls context, scores, pushes if A+, logs otherwise
// -----------------------------------------------------------------
function processTVAlert(alert) {
  var ticker = (alert.ticker || alert.symbol || '').toUpperCase();
  if (!ticker) return Promise.resolve({ error: 'no ticker', skipped: true });

  // Build context — scanner may add more later
  var setup = {
    ticker: ticker,
    action: alert.action || alert.direction || null,
    timeframe: alert.tf || alert.timeframe || null,
    price: alert.price ? parseFloat(alert.price) : null,
    message: alert.message || alert.alert || '',
    source: alert.source || 'TV_INDICATOR',
    received_at: new Date().toISOString(),
  };

  return scoreSetup(setup).then(function(verdict) {
    // Log regardless of outcome (transparency)
    try {
      var logEntry = JSON.stringify({
        ts: verdict._timestamp,
        ticker: ticker,
        score: verdict.score,
        verdict: verdict.verdict,
        reason: verdict.reason_one_line,
        setup: setup,
      }) + '\n';
      fs.appendFileSync(CURATOR_LOG, logEntry);
    } catch(e) {}

    // Only push if score ≥ 8 AND verdict is GO or REDUCE
    var shouldPush = verdict.score >= 8 && (verdict.verdict === 'GO' || verdict.verdict === 'REDUCE');
    if (shouldPush && pushNotifier && pushNotifier.pushCuratorAlert) {
      pushNotifier.pushCuratorAlert({
        ticker: ticker,
        score: verdict.score,
        verdict: verdict.verdict,
        reason: verdict.reason_one_line,
        r_r: verdict.r_r_computed,
        action: verdict.recommended_action,
        failure_modes: verdict.failure_modes,
      }).catch(function(e) { console.error('[CURATOR] push failed:', e.message); });
    }

    return { ticker: ticker, verdict: verdict, pushed: shouldPush };
  }).catch(function(err) {
    // Log errors too
    try {
      fs.appendFileSync(CURATOR_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        ticker: ticker,
        error: err.message,
      }) + '\n');
    } catch(e) {}
    return { ticker: ticker, error: err.message };
  });
}

// -----------------------------------------------------------------
// Read recent curator decisions (for scanner history tab)
// -----------------------------------------------------------------
function getRecentDecisions(limit) {
  limit = limit || 50;
  try {
    var raw = fs.readFileSync(CURATOR_LOG, 'utf8');
    var lines = raw.split('\n').filter(function(l) { return l.trim(); });
    var parsed = lines.map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean);
    return parsed.slice(-limit).reverse(); // newest first
  } catch(e) {
    return [];
  }
}

module.exports = {
  scoreSetup: scoreSetup,
  processTVAlert: processTVAlert,
  getRecentDecisions: getRecentDecisions,
  callClaude: callClaude,
};
