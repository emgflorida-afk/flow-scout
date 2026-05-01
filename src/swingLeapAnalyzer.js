// =============================================================================
// SWING/LEAP CHART ANALYZER (May 1 2026)
//
// Vision-LLM layer for #cvo-trades-swings-leaps. Posts are minimal text + chart,
// so all setup info (entry/stop/target/timeframe) lives IN the chart image.
// Claude vision reads the chart and returns structured JSON.
//
// Pipeline:
//   1. Download chart from Discord CDN (URLs expire ~24h → cache locally)
//   2. Send to Claude with structured JSON schema prompt
//   3. Parse + cache result by msgId (idempotent — same chart = same result)
//
// Cost:
//   ~$0.015/image × 20 charts/day = ~$0.30/day at full feed analysis
//   Cached forever — only first analysis costs anything
// =============================================================================

var fs = require('fs');
var path = require('path');
var fetch = require('node-fetch');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var CHARTS_DIR = path.join(DATA_ROOT, 'swing_leap_charts');
var ANALYSIS_FILE = path.join(DATA_ROOT, 'swing_leap_analysis.json');

try { fs.mkdirSync(CHARTS_DIR, { recursive: true }); } catch(e) {}

var MODEL = process.env.SWING_LEAP_MODEL || 'claude-sonnet-4-5';

function loadCache() {
  if (!fs.existsSync(ANALYSIS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveCache(cache) {
  // Atomic write to avoid corruption on concurrent calls
  var tmp = ANALYSIS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, ANALYSIS_FILE);
}

async function downloadChart(url, msgId, idx) {
  var localPath = path.join(CHARTS_DIR, msgId + '_' + idx + '.png');
  if (fs.existsSync(localPath)) return localPath;
  var r = await fetch(url, { timeout: 15000 });
  if (!r.ok) throw new Error('download-' + r.status);
  var buf = await r.buffer();
  fs.writeFileSync(localPath, buf);
  return localPath;
}

function buildPrompt(ticker, body) {
  return 'You are reading a stock chart posted by a trader for a swing/leap setup.\n\n' +
    'Context:\n' +
    '  Ticker hint: ' + (ticker || 'unknown — read from chart') + '\n' +
    '  Trader comment: "' + (body || '(no comment)') + '"\n\n' +
    'Analyze the chart carefully. Return JSON ONLY (no markdown fences, no preamble, no trailing text):\n' +
    '{\n' +
    '  "ticker": "<ticker visible on the chart>",\n' +
    '  "timeframe": "<chart TF — Daily, Weekly, 4H, 1H, etc>",\n' +
    '  "setup": "<setup name — e.g. \\"breakout\\", \\"1-3-1 coil\\", \\"double bottom\\", \\"trendline retest\\", \\"failed 2D\\", \\"cup and handle\\">",\n' +
    '  "direction": "long|short|neutral",\n' +
    '  "entry": <number — entry price level shown or implied on chart>,\n' +
    '  "stop": <number — invalidation level>,\n' +
    '  "target1": <number — first profit target>,\n' +
    '  "target2": <number or null — second target if visible>,\n' +
    '  "rr": <number — risk/reward ratio target1 vs stop>,\n' +
    '  "conviction": <integer 1-10 — your read of setup quality>,\n' +
    '  "summary": "<single sentence describing the setup and key trigger>"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- If the chart shows no clear setup, set conviction=1 and summary="no clear setup".\n' +
    '- If you can\'t read a level, use null (not 0).\n' +
    '- Conviction 8+ = clean structure, multiple confluences. 5-7 = decent. 1-4 = weak.\n' +
    '- direction "long" if bullish bias, "short" if bearish, "neutral" if waiting for trigger.';
}

async function analyzeChart(msgId, chartUrls, ticker, body) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!chartUrls || !chartUrls.length) throw new Error('no charts to analyze');

  // Download first chart (most posts have just one — additional charts are usually
  // alternate timeframes of the same setup)
  var localPath = await downloadChart(chartUrls[0], msgId, 0);
  var imgBuf = fs.readFileSync(localPath);
  var imgB64 = imgBuf.toString('base64');

  var prompt = buildPrompt(ticker, body);

  var requestBody = {
    model: MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    timeout: 60000
  });

  if (!r.ok) {
    var errText = await r.text();
    throw new Error('claude-' + r.status + ': ' + errText.slice(0, 300));
  }

  var resp = await r.json();
  var text = ((resp.content || [{}])[0] || {}).text || '';

  // Parse JSON from response — handle case where Claude wraps in markdown fences
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in response: ' + text.slice(0, 200));

  var parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { throw new Error('parse JSON: ' + e.message + ' — raw: ' + jsonMatch[0].slice(0, 200)); }

  // Add metadata
  parsed.usage = resp.usage || {};
  parsed.model = MODEL;
  return parsed;
}

async function analyzeOrCached(msgId, chartUrls, ticker, body, opts) {
  opts = opts || {};
  var cache = loadCache();
  if (cache[msgId] && !opts.force) {
    return Object.assign({ cached: true }, cache[msgId]);
  }
  var result = await analyzeChart(msgId, chartUrls, ticker, body);
  result.analyzedAt = new Date().toISOString();
  result.msgId = msgId;
  cache[msgId] = result;
  saveCache(cache);
  return Object.assign({ cached: false }, result);
}

async function batchAnalyze(posts, opts) {
  opts = opts || {};
  var maxItems = opts.max || 20;
  var throttleMs = opts.throttleMs || 500;
  var results = [];

  for (var i = 0; i < Math.min(posts.length, maxItems); i++) {
    var p = posts[i];
    if (!p.hasChart) {
      results.push({ msgId: p.msgId, skipped: 'no chart' });
      continue;
    }
    try {
      var r = await analyzeOrCached(p.msgId, p.attachmentUrls, p.ticker, p.body, opts);
      results.push(Object.assign({ msgId: p.msgId }, r));
    } catch (e) {
      results.push({ msgId: p.msgId, error: e.message });
    }
    // Throttle Anthropic API to avoid rate limits
    if (i < posts.length - 1) {
      await new Promise(function(r){ setTimeout(r, throttleMs); });
    }
  }
  return results;
}

function getCachedAnalysis(msgId) {
  var cache = loadCache();
  return cache[msgId] || null;
}

module.exports = {
  analyzeChart: analyzeChart,
  analyzeOrCached: analyzeOrCached,
  batchAnalyze: batchAnalyze,
  getCachedAnalysis: getCachedAnalysis,
  loadCache: loadCache,
};
