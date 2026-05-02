// =============================================================================
// METHODOLOGY MINER — regex-only rulebook extraction from John's Discord raw
// JSON archives. Walks 3 channel files (cvo-swings-leaps, option-trade-ideas,
// vip-flow-options-alerts; SKIPS free-charts which is a separate sniper trader)
// and tallies pattern names, entry triggers, stop logic, target language,
// filters, time/catalyst keywords, risk/sizing, plus per-ticker stats and
// up to 5 example snippets per pattern.
//
// No LLM, no backtest, no hit-rate. Just frequency + examples. Output is
// {DATA_DIR}/methodology_rulebook.json. Built so the system survives the
// Discord subscription window — extract once, query forever.
//
// Storage matches chartArchiver.js: process.env.DATA_DIR, falling back to
// /data on Railway, falling back to repo-local data/ for local runs.
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HIST_DIR = path.join(DATA_ROOT, 'john_history');
var OUTPUT_FILE = path.join(DATA_ROOT, 'methodology_rulebook.json');

var CHANNELS = [
  { file: 'cvo-swings-leaps.raw.json',         key: 'cvo-swings-leaps' },
  { file: 'option-trade-ideas.raw.json',       key: 'option-trade-ideas' },
  { file: 'vip-flow-options-alerts.raw.json',  key: 'vip-flow-options-alerts' },
];

// ---- Pattern catalog ----------------------------------------------------
// Each entry: { canonical: 'name shown in output', regex: /matcher/i }
// Order matters: more specific patterns first so the example dedupe captures
// the strongest match.

var PATTERNS = [
  // Strat numeric combos
  { canonical: '1-3-1',           regex: /\b1[-\s]?3[-\s]?1\b/i },
  { canonical: '3-1-2',           regex: /\b3[-\s]?1[-\s]?2(?:U|D)?\b/i },
  { canonical: '2-1-2',           regex: /\b2[-\s]?1[-\s]?2(?:U|D)?\b/i },
  { canonical: '2-2 reversal',    regex: /\b2[-\s]?2\s*(?:reversal|rev)\b/i },
  { canonical: '2U-2D',           regex: /\b2U[-\s]?2D\b/i },
  { canonical: '2D-2U',           regex: /\b2D[-\s]?2U\b/i },

  // Strat single bars / failures (handle a lot of variants)
  { canonical: 'failed 2D',       regex: /\b(?:failed|fail)\s*2[-\s]?(?:Down|D)\b|\bF2D\b/i },
  { canonical: 'failed 2U',       regex: /\b(?:failed|fail)\s*2[-\s]?(?:Up|U)\b|\bF2U\b/i },
  { canonical: 'hammer',          regex: /\bhammer(?:\s*candle|\s*reversal)?\b/i },
  { canonical: 'shooter',         regex: /\bshooter(?:\s*candle)?|\bshooting\s*star\b/i },
  { canonical: 'inside bar',      regex: /\binside\s*(?:bar|day|candle)\b|\binside\s*1\b/i },
  { canonical: 'outside bar',     regex: /\boutside\s*(?:bar|day|candle|week)\b|\boutside\s*3\b/i },
  { canonical: 'double inside',   regex: /\bdouble\s*inside\b/i },
  { canonical: 'inside week',     regex: /\binside\s*week\b/i },
  { canonical: 'outside week',    regex: /\boutside\s*week\b/i },

  // Classical TA — chart patterns
  { canonical: 'ascending triangle',  regex: /\bascending\s*triangle\b/i },
  { canonical: 'descending triangle', regex: /\bdescending\s*triangle\b/i },
  { canonical: 'symmetric triangle',  regex: /\b(?:symmetric|symmetrical)\s*triangle\b/i },
  { canonical: 'falling wedge',       regex: /\bfalling\s*wedge\b/i },
  { canonical: 'rising wedge',        regex: /\brising\s*wedge\b/i },
  { canonical: 'bull flag',           regex: /\bbull\s*flag\b/i },
  { canonical: 'bear flag',           regex: /\bbear\s*flag\b/i },
  { canonical: 'cup and handle',      regex: /\bcup\s*(?:and|&|n)?\s*handle\b/i },
  { canonical: 'head and shoulders',  regex: /\bhead\s*(?:and|&|n)?\s*shoulders\b|\bH&S\b/i },
  { canonical: 'descending channel',  regex: /\bdescending\s*channel\b/i },
  { canonical: 'ascending channel',   regex: /\bascending\s*channel\b/i },
  { canonical: 'double top',          regex: /\bdouble\s*top\b/i },
  { canonical: 'double bottom',       regex: /\bdouble\s*bottom\b/i },
  { canonical: 'fair value gap',      regex: /\bfair\s*value\s*gap(?:s)?\b|\bFVG(?:s)?\b/i },

  // Generic structure
  { canonical: 'breakout',         regex: /\bbreak[\s-]?out(?:s)?\b/i },
  { canonical: 'breakdown',        regex: /\bbreak[\s-]?down(?:s)?\b/i },
  { canonical: 'reversal',         regex: /\breversal\b/i },
  { canonical: 'pullback',         regex: /\bpull[\s-]?back\b/i },
  { canonical: 'retest',           regex: /\bre[\s-]?test\b/i },
  { canonical: 'coil',             regex: /\bcoil(?:ing|ed)?\b/i },
  { canonical: 'compression',      regex: /\bcompress(?:ion|ing|ed)?\b/i },
  { canonical: 'consolidation',    regex: /\bconsolidat(?:ion|ing|ed|e)\b/i },
  { canonical: 'continuation',     regex: /\bcontinuation\b/i },
];

// ---- Entry trigger phrases ---------------------------------------------
var ENTRY_TRIGGERS = [
  { canonical: 'break above $X',  regex: /\bbreak(?:s|ing)?\s*above\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'break below $X',  regex: /\bbreak(?:s|ing)?\s*below\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'over $X',         regex: /\bover\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'under $X',        regex: /\bunder\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'above $X',        regex: /\babove\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'below $X',        regex: /\bbelow\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'close above',     regex: /\bclose(?:s|d)?\s*above\b/i },
  { canonical: 'close below',     regex: /\bclose(?:s|d)?\s*below\b/i },
  { canonical: '5m close',        regex: /\b5m?\s*(?:min|minute)?\s*close\b/i },
  { canonical: '15m close',       regex: /\b15m?\s*(?:min|minute)?\s*close\b/i },
  { canonical: 'hourly close',    regex: /\b(?:1HR|1H|hourly|60m)\s*close\b/i },
  { canonical: 'daily close',     regex: /\bdaily\s*close\b/i },
  { canonical: 'weekly close',    regex: /\bweekly\s*close\b/i },
  { canonical: 'retest of',       regex: /\bre[\s-]?test\s*(?:of|the)\b/i },
  { canonical: 'bounce off',      regex: /\bbounc(?:e|ed|es|ing)\s*(?:off|from)\b/i },
  { canonical: 'reclaim',         regex: /\breclaim(?:s|ed|ing)?\b/i },
  { canonical: 'VWAP reclaim',    regex: /\bvwap\s*(?:reclaim|hold|bounce)/i },
  { canonical: 'gap fill',        regex: /\bgap\s*fill\b/i },
  { canonical: 'wait time',       regex: /\bwait\s*time\b/i },
  { canonical: 'trigger',         regex: /\btrigger(?:s|ed|ing)?\b/i },
];

// ---- Stop logic phrases ------------------------------------------------
var STOP_LOGIC = [
  { canonical: 'stop below',         regex: /\bstop(?:\s*loss)?\s*below\b/i },
  { canonical: 'stop above',         regex: /\bstop(?:\s*loss)?\s*above\b/i },
  { canonical: 'below the low of',   regex: /\bbelow\s*the\s*low\s*of\b/i },
  { canonical: 'above the high of',  regex: /\babove\s*the\s*high\s*of\b/i },
  { canonical: 'tight stop',         regex: /\btight\s*stop\b/i },
  { canonical: 'structural stop',    regex: /\bstructur(?:al|e)\s*stop\b/i },
  { canonical: 'mental stop',        regex: /\bmental\s*stop\b/i },
  { canonical: 'trailing stop',      regex: /\btrail(?:ing)?\s*stop\b/i },
  { canonical: 'flat % stop',        regex: /\bstop\s*loss[:\s]*-?\s*\d+\s*%/i },
  { canonical: 'stop loss tag',      regex: /🛑|stop\s*loss\s*[:=]/i },
];

// ---- Target / measured-move phrases ------------------------------------
var TARGET_LANGUAGE = [
  { canonical: 'target X',         regex: /\btarget(?:s)?\s*[:=]?\s*\$?\d+(?:\.\d+)?/i },
  { canonical: 'PT X',             regex: /\bPT\s*[:=]?\s*\d+/i },
  { canonical: 'TP1',              regex: /\bTP\s*1\b/i },
  { canonical: 'TP2',              regex: /\bTP\s*2\b/i },
  { canonical: 'TP3',              regex: /\bTP\s*3\b/i },
  { canonical: 'take profit',      regex: /\btake\s*profit(?:s|\s*levels?)?\b/i },
  { canonical: 'measured move',    regex: /\bmeasured\s*move\b/i },
  { canonical: 'profit ladder',    regex: /\b25\s*%\s*[•·\-\/,]\s*50\s*%\s*[•·\-\/,]\s*100\s*\+?%/i },
  { canonical: '25% trim',         regex: /\b25\s*%\s*(?:profit|trim|off|target)/i },
  { canonical: '50% trim',         regex: /\b50\s*%\s*(?:profit|trim|off|target)/i },
  { canonical: '100% target',      regex: /\b100\s*\+?\s*%\s*(?:profit|target|return)?/i },
  { canonical: 'leave runners',    regex: /\b(?:leave|let)\s*runner(?:s)?\b/i },
  { canonical: '80% off',          regex: /\b(?:80\s*%|4\/5)\s*(?:of\s*your\s*position\s*)?off\b/i },
];

// ---- Filters / criteria -----------------------------------------------
var FILTERS = [
  { canonical: 'short float %',           regex: /\bshort\s*float\b|\bsi\s*ratio\b/i },
  { canonical: 'low float',               regex: /\blow\s*float\b/i },
  { canonical: 'high float',              regex: /\bhigh\s*float\b/i },
  { canonical: 'options OI',              regex: /\bopen\s*interest\b|\bOI\b/i },
  { canonical: 'unusual volume',          regex: /\bunusual\s*(?:volume|options?)\b|\bunusual\s*(?:vol|opt)\b/i },
  { canonical: 'IV percentile',           regex: /\bIV\s*(?:percentile|rank|crush)\b/i },
  { canonical: 'implied volatility',      regex: /\bimplied\s*volatility\b/i },
  { canonical: 'sector rotation',         regex: /\bsector\s*rotation\b/i },
  { canonical: 'manipulation',            regex: /\bmanipulation\s*(?:candle|bar)?\b|\bmanipulated\b/i },
  { canonical: 'momentum ignition',       regex: /\bmomentum\s*(?:ignition|push)\b/i },
  { canonical: 'big money',               regex: /\bbig\s*money\b|\bsmart\s*money\b/i },
  { canonical: 'dark pool',               regex: /\bdark\s*pool(?:s)?\b/i },
  { canonical: 'sweep',                   regex: /\bsweep(?:s|ing)?\b/i },
  { canonical: 'volume confirmation',     regex: /\bvolume\s*(?:confirm|spike|surge|conf)\b/i },
];

// ---- Time / catalyst phrases ------------------------------------------
var TIME_FRAMES = [
  { canonical: 'DTE',              regex: /\b\d+\s*DTE\b/i },
  { canonical: 'earnings',         regex: /\bearning(?:s)?\b|\bER\b(?!\w)/i },
  { canonical: 'FOMC',             regex: /\bFOMC\b/i },
  { canonical: 'CPI',              regex: /\bCPI\b/i },
  { canonical: 'PCE',              regex: /\bPCE\b/i },
  { canonical: 'GDP',              regex: /\bGDP\b/i },
  { canonical: 'jobs report',      regex: /\b(?:NFP|jobs\s*report|payroll)\b/i },
  { canonical: 'premarket',        regex: /\bpre[\s-]?market\b/i },
  { canonical: 'after hours',      regex: /\bafter[\s-]?hours?\b|\bAH\b(?!\w)/i },
  { canonical: 'overnight',        regex: /\bovernight\b/i },
  { canonical: 'scale in',         regex: /\bscale[\s-]?in\b|\bscaling\s*in\b/i },
  { canonical: 'scale out',        regex: /\bscale[\s-]?out\b|\bscaling\s*out\b/i },
  { canonical: 'swing',            regex: /\bswing(?:s|ing)?\b/i },
  { canonical: 'day trade',        regex: /\bday\s*trade(?:s|r)?\b/i },
  { canonical: 'lotto',            regex: /\blotto\b/i },
  { canonical: 'leap',             regex: /\bleap(?:s)?\b/i },
  { canonical: 'weekly',           regex: /\bweekly\s*(?:time\s*frame|chart|setup|TF)?\b/i },
  { canonical: 'daily TF',         regex: /\bdaily\s*(?:time\s*frame|chart|TF)\b/i },
];

// ---- Risk / sizing phrases --------------------------------------------
var RISK_SIZING = [
  { canonical: 'go light',         regex: /\bgo\s*light\b|\blight\s*size\b/i },
  { canonical: 'small size',       regex: /\bsmall\s*size\b/i },
  { canonical: 'full size',        regex: /\bfull\s*size\b/i },
  { canonical: 'trial position',   regex: /\btrial\s*(?:position|size)\b|\bstarter\s*(?:position|size)\b/i },
  { canonical: 'scaling in',       regex: /\bscale\s*in\b|\bscaling\s*in\b/i },
  { canonical: '1 ct',             regex: /\b1\s*c(?:t|ontract)\b/i },
  { canonical: '2 ct',             regex: /\b2\s*c(?:t|ontract)s?\b/i },
  { canonical: '3 ct',             regex: /\b3\s*c(?:t|ontract)s?\b/i },
  { canonical: '5 ct',             regex: /\b5\s*c(?:t|ontract)s?\b/i },
  { canonical: '1% of account',    regex: /\b1\s*%\s*of\s*(?:my\s*)?account\b/i },
  { canonical: 'risk %',           regex: /\brisk(?:ing)?\s*\d+\s*%/i },
  { canonical: 'average down',     regex: /\baverag(?:e|ed|ing)\s*down\b/i },
];

// ---- Universal counter helpers ----------------------------------------

function countDistinct(haystack, defs, examples, msgMeta) {
  // Returns an object { canonical: 1 } — at most 1 per body even if regex matches twice.
  var hits = {};
  for (var i = 0; i < defs.length; i++) {
    var def = defs[i];
    var m = haystack.match(def.regex);
    if (m) {
      hits[def.canonical] = 1;
      // Capture an example snippet centered on the match for the patterns dict only
      if (examples && msgMeta) {
        var arr = examples[def.canonical] || (examples[def.canonical] = []);
        if (arr.length < 5) {
          var idx = haystack.toLowerCase().indexOf(m[0].toLowerCase());
          var start = Math.max(0, idx - 50);
          var end   = Math.min(haystack.length, idx + m[0].length + 70);
          var snippet = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
          if (start > 0) snippet = '…' + snippet;
          if (end < haystack.length) snippet = snippet + '…';
          arr.push({
            msgId: msgMeta.msgId,
            ticker: msgMeta.ticker,
            channel: msgMeta.channel,
            snippet: snippet,
            postedAt: msgMeta.postedAt,
          });
        }
      }
    }
  }
  return hits;
}

function mergeCounts(target, hits) {
  Object.keys(hits).forEach(function(k) {
    target[k] = (target[k] || 0) + hits[k];
  });
}

// ---- Ticker extraction ------------------------------------------------
// Prefer $TICKER over plain TICKER to avoid false positives on BUY/PUT/CALL/etc.
var TICKER_BLACKLIST = {
  PUT: 1, CALL: 1, BUY: 1, SELL: 1, EXP: 1, TF: 1, ER: 1, HOD: 1, LOD: 1, ATH: 1, ATL: 1,
  ORB: 1, OPEN: 1, OI: 1, IV: 1, DTE: 1, GEX: 1, FOMC: 1, CPI: 1, PCE: 1, GDP: 1, NFP: 1,
  AH: 1, PM: 1, AM: 1, ET: 1, EST: 1, CST: 1, PST: 1, USD: 1, USA: 1, CEO: 1, CFO: 1,
  ETF: 1, US: 1, EU: 1, FYI: 1, EOD: 1, TPS: 1, TPL: 1, VWAP: 1, VIP: 1, NEW: 1, ALL: 1,
  TBA: 1, TBD: 1, AKA: 1, GG: 1, IT: 1, TBH: 1, BTW: 1, ETC: 1,
};

function extractTickers(body) {
  var found = {};
  var re = /\$([A-Z]{1,5})\b/g;
  var m;
  while ((m = re.exec(body)) !== null) {
    var t = m[1];
    if (t.length >= 1 && !TICKER_BLACKLIST[t]) found[t] = 1;
  }
  // Fallback: pick "Ticker: XYZ" line common in trade-idea boilerplate
  var tickerLine = body.match(/Ticker[:\s]+([A-Z]{1,6})\b/);
  if (tickerLine && !TICKER_BLACKLIST[tickerLine[1]]) found[tickerLine[1]] = 1;
  return Object.keys(found);
}

// ---- Main mining loop -------------------------------------------------

async function runMine(opts) {
  opts = opts || {};
  var startedAt = Date.now();

  // Output buckets
  var patternFrequency = {};
  var entryTriggers    = {};
  var stopLogic        = {};
  var targetLanguage   = {};
  var filters          = {};
  var timeFrames       = {};
  var riskSizing       = {};
  var examples         = {};        // patterns only — keyed by canonical pattern
  var tickerStats      = {};        // { TICKER: { count: N, patterns: Set } }
  var channelBreakdown = {};

  var totalMessagesScanned   = 0;
  var totalSubstantiveBodies = 0;

  for (var c = 0; c < CHANNELS.length; c++) {
    var ch = CHANNELS[c];
    var fp = path.join(HIST_DIR, ch.file);
    var chBucket = {
      msgs: 0,
      substantiveBodies: 0,
      patternsFound: 0,
      uniquePatterns: 0,
    };
    var chPatterns = {};

    if (!fs.existsSync(fp)) {
      channelBreakdown[ch.key] = Object.assign({ error: 'file-missing' }, chBucket);
      continue;
    }

    var data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) {
      channelBreakdown[ch.key] = Object.assign({ error: 'parse: ' + e.message }, chBucket);
      continue;
    }
    if (!Array.isArray(data)) {
      channelBreakdown[ch.key] = Object.assign({ error: 'not-array' }, chBucket);
      continue;
    }

    chBucket.msgs = data.length;

    for (var i = 0; i < data.length; i++) {
      var msg = data[i] || {};
      totalMessagesScanned++;

      var body = '';
      var embeds = msg.embeds || [];
      if (embeds[0] && embeds[0].description) body = String(embeds[0].description);
      else if (msg.content) body = String(msg.content);

      // Append title text — often holds key signal words like "SWING TRADE"
      if (embeds[0] && embeds[0].title) body = String(embeds[0].title) + ' ' + body;

      if (body.length <= 50) continue;
      totalSubstantiveBodies++;
      chBucket.substantiveBodies++;

      var msgMeta = {
        msgId: msg.id || ('msg' + i),
        channel: ch.key,
        postedAt: msg.timestamp || null,
        ticker: null,
      };

      // Tickers (best-effort)
      var tickers = extractTickers(body);
      msgMeta.ticker = tickers[0] || null;

      // Pattern hits (capture examples)
      var pHits = countDistinct(body, PATTERNS, examples, msgMeta);
      mergeCounts(patternFrequency, pHits);
      mergeCounts(chPatterns, pHits);
      var patternHitNames = Object.keys(pHits);
      chBucket.patternsFound += patternHitNames.length;

      // Entry / stop / target / filter / time / risk hits (no examples)
      mergeCounts(entryTriggers,  countDistinct(body, ENTRY_TRIGGERS));
      mergeCounts(stopLogic,      countDistinct(body, STOP_LOGIC));
      mergeCounts(targetLanguage, countDistinct(body, TARGET_LANGUAGE));
      mergeCounts(filters,        countDistinct(body, FILTERS));
      mergeCounts(timeFrames,     countDistinct(body, TIME_FRAMES));
      mergeCounts(riskSizing,     countDistinct(body, RISK_SIZING));

      // Ticker stats
      for (var t = 0; t < tickers.length; t++) {
        var tk = tickers[t];
        var ts = tickerStats[tk] || (tickerStats[tk] = { count: 0, patternsSet: {} });
        ts.count++;
        for (var p = 0; p < patternHitNames.length; p++) {
          ts.patternsSet[patternHitNames[p]] = 1;
        }
      }
    }

    chBucket.uniquePatterns = Object.keys(chPatterns).length;
    channelBreakdown[ch.key] = chBucket;
  }

  // Finalize ticker stats
  var byTicker = {};
  Object.keys(tickerStats).forEach(function(tk) {
    byTicker[tk] = {
      count: tickerStats[tk].count,
      patterns: Object.keys(tickerStats[tk].patternsSet).sort(),
    };
  });
  var topTickers = Object.keys(byTicker)
    .map(function(k) { return { ticker: k, count: byTicker[k].count, patterns: byTicker[k].patterns.length }; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 25);

  var rulebook = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totalMessagesScanned: totalMessagesScanned,
    totalSubstantiveBodies: totalSubstantiveBodies,
    sourceFiles: CHANNELS.map(function(c) { return c.file; }),
    patternFrequency: patternFrequency,
    entryTriggers: entryTriggers,
    stopLogic: stopLogic,
    targetLanguage: targetLanguage,
    filters: filters,
    timeFrames: timeFrames,
    riskSizing: riskSizing,
    examples: examples,
    tickerStats: { byTicker: byTicker, topTickers: topTickers },
    channelBreakdown: channelBreakdown,
  };

  // Write to disk (best-effort — don't fail the whole run if write fails)
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(rulebook, null, 2));
  } catch (e) {
    rulebook._writeError = e.message;
  }

  return rulebook;
}

// ---- Read helpers ------------------------------------------------------

function loadRulebook() {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); }
  catch (e) { return { _readError: e.message }; }
}

function getStatus() {
  var status = { outputFile: OUTPUT_FILE, exists: fs.existsSync(OUTPUT_FILE) };
  if (status.exists) {
    try {
      var st = fs.statSync(OUTPUT_FILE);
      status.fileBytes = st.size;
      status.fileMtime = st.mtime.toISOString();
    } catch (_) {}
    var rb = loadRulebook();
    if (rb && !rb._readError) {
      status.generatedAt = rb.generatedAt || null;
      status.totalMessagesScanned = rb.totalMessagesScanned || 0;
      status.totalSubstantiveBodies = rb.totalSubstantiveBodies || 0;
      status.patternsTracked = Object.keys(rb.patternFrequency || {}).length;
      status.tickersTracked = Object.keys(((rb.tickerStats || {}).byTicker) || {}).length;
    }
  }
  return status;
}

function examplesFor(pattern, limit) {
  var rb = loadRulebook();
  if (!rb || !rb.examples) return [];
  var key = String(pattern || '').trim();
  // Try exact match first, then case-insensitive
  var arr = rb.examples[key];
  if (!arr) {
    var keys = Object.keys(rb.examples);
    var keyL = key.toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === keyL) { arr = rb.examples[keys[i]]; break; }
    }
  }
  if (!arr) return [];
  var n = parseInt(limit, 10);
  if (!isFinite(n) || n <= 0) n = 5;
  return arr.slice(0, n);
}

module.exports = {
  runMine: runMine,
  loadRulebook: loadRulebook,
  getStatus: getStatus,
  examplesFor: examplesFor,
};
