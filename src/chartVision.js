// =============================================================================
// CHART VISION REVIEW — Layer 2 of auto-fire architecture
//
// Sends a chart screenshot + trade context to Claude vision API for
// qualitative review. The pattern detector says structure is bullish/bearish;
// the chart vision says "but does the BROADER chart actually support firing?"
//
// Two layers must both APPROVE before any auto-fire trigger:
//   Layer 1: pattern detector (deterministic, fast — johnPatternScanner)
//   Layer 2: chart vision (qualitative, comprehensive — this module)
//
// Requires ANTHROPIC_API_KEY env var on Railway.
//
// USAGE:
//   POST /api/chart-vision-review
//   Body: { ticker, direction, tradeContext, imageBase64 }
//   Returns: { ok, verdict: APPROVE|VETO|WAIT, reasoning, ... }
// =============================================================================

var axios = require('axios');
var fs = require('fs');

var ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
var DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

// Strip data: URL prefix if present, return raw base64
function normalizeBase64(input) {
  if (!input) return null;
  var s = String(input);
  // Strip "data:image/png;base64," prefix if present
  var match = s.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
  return match ? match[2] : s;
}

// Detect media type from base64 magic bytes
function detectMediaType(base64) {
  if (!base64) return 'image/png';
  // PNG starts with iVBORw0K... (89 50 4E 47 in hex = iVBORw)
  if (base64.startsWith('iVBORw')) return 'image/png';
  // JPEG starts with /9j/...
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  // GIF starts with R0lGOD...
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  // WebP
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/png'; // safe default
}

// Build the vision prompt with strict output schema
function buildVisionPrompt(ticker, direction, tradeContext) {
  return [
    'You are the chart-vision reviewer for AB\'s trading system. AB is on a ',
    '$20.4K account, swing-only on TS due to PDT. The pattern detector has ',
    'already identified a setup; your job is to qualitatively review the ',
    'BROADER CHART STRUCTURE and either APPROVE, VETO, or say WAIT.',
    '\n\n',
    'TRADE CONTEXT:\n',
    '- Ticker: ' + ticker + '\n',
    '- Direction: ' + (direction || 'unknown') + '\n',
    '- Setup details: ' + (tradeContext || 'not provided') + '\n',
    '\n',
    'EVALUATE THE CHART FOR:\n',
    '1. STRUCTURAL ALIGNMENT: Does the broader chart (multi-bar context) actually support the proposed direction? Look beyond the latest 1-3 bars.\n',
    '2. CONFLICTING SIGNALS: Are there visible higher-TF resistance/support levels that the pattern detector missed? Any divergences (price vs momentum)?\n',
    '3. VOLUME PROFILE: Is volume confirming the recent move or fading? Vol spikes vs vol contractions in the right places?\n',
    '4. CHART PATTERN INTEGRITY: If a key pattern is visible (channel, wedge, head-and-shoulders), does our trade direction match its expected resolution?\n',
    '5. RECENT ACTION QUALITY: Is the rejection/breakout candle clean or messy? Is there gap risk visible?\n',
    '6. STRUCTURAL TARGETS: Are TP1/TP2 levels clearly attainable based on visible structure, or do they look optimistic?\n',
    '\n',
    'OUTPUT EXACTLY THIS JSON (no markdown wrapper, no commentary, raw JSON):\n',
    '{\n',
    '  "verdict": "APPROVE" or "VETO" or "WAIT",\n',
    '  "confidence": <integer 1-10>,\n',
    '  "structuralAlignment": "<one sentence>",\n',
    '  "conflictsDetected": ["<concern 1>", "<concern 2>"],\n',
    '  "strengths": ["<strength 1>", "<strength 2>"],\n',
    '  "volumeProfile": "<one sentence>",\n',
    '  "patternIntegrity": "<one sentence>",\n',
    '  "targetAttainability": "<one sentence>",\n',
    '  "primaryReason": "<one sentence — the SINGLE biggest reason for your verdict>",\n',
    '  "ifEntered": "<one sentence — what specifically to watch as confirmation/invalidation>"\n',
    '}\n',
    '\n',
    'VERDICT GUIDELINES:\n',
    '- APPROVE: chart structure aligns with pattern detector\'s read, no major conflicts, targets attainable\n',
    '- VETO: chart shows clear contradiction (e.g., bearish setup but big bullish channel intact)\n',
    '- WAIT: ambiguous — needs another candle to clarify direction\n',
    '\n',
    'Be CONSERVATIVE. Default to WAIT or VETO if uncertain. AB\'s account is small; preserving capital > catching every trade.',
  ].join('');
}

// Main vision review function
async function reviewChart(opts) {
  opts = opts || {};
  var ticker = String(opts.ticker || '').toUpperCase();
  var direction = opts.direction || null;
  var tradeContext = opts.tradeContext || null;
  var imageBase64 = normalizeBase64(opts.imageBase64);

  if (!ticker) return { ok: false, error: 'ticker required' };
  if (!imageBase64) return { ok: false, error: 'imageBase64 required (chart screenshot as base64 string)' };

  var apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set on server env' };

  var mediaType = detectMediaType(imageBase64);
  var prompt = buildVisionPrompt(ticker, direction, tradeContext);

  try {
    var resp = await axios.post(ANTHROPIC_API_URL, {
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 45000,
    });

    var responseText = resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text;
    if (!responseText) return { ok: false, error: 'empty response from Claude API' };

    // Parse the JSON output
    var review = null;
    try {
      // Strip any markdown code fences if Claude added them
      var clean = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      review = JSON.parse(clean);
    } catch(parseErr) {
      return { ok: false, error: 'failed to parse vision response as JSON', rawResponse: responseText };
    }

    // Sanitize verdict to one of the 3 expected values
    var validVerdicts = ['APPROVE', 'VETO', 'WAIT'];
    var verdict = String(review.verdict || '').toUpperCase();
    if (validVerdicts.indexOf(verdict) < 0) verdict = 'WAIT';
    review.verdict = verdict;

    return {
      ok: true,
      ticker: ticker,
      direction: direction,
      review: review,
      model: DEFAULT_MODEL,
      mediaType: mediaType,
      promptTokens: resp.data && resp.data.usage && resp.data.usage.input_tokens,
      responseTokens: resp.data && resp.data.usage && resp.data.usage.output_tokens,
    };
  } catch (e) {
    var errInfo = { ok: false, error: e.message };
    if (e.response && e.response.data) errInfo.apiError = e.response.data;
    return errInfo;
  }
}

// Convenience: review a screenshot from local file path (used by CLI helper)
async function reviewChartFile(opts) {
  opts = opts || {};
  if (!opts.imagePath) return { ok: false, error: 'imagePath required' };
  if (!fs.existsSync(opts.imagePath)) return { ok: false, error: 'file not found: ' + opts.imagePath };
  var imageBuffer = fs.readFileSync(opts.imagePath);
  var imageBase64 = imageBuffer.toString('base64');
  return reviewChart(Object.assign({}, opts, { imageBase64: imageBase64 }));
}

module.exports = {
  reviewChart: reviewChart,
  reviewChartFile: reviewChartFile,
  buildVisionPrompt: buildVisionPrompt,
};
