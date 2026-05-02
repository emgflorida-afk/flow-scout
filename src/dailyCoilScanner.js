// =============================================================================
// DAILY COIL SCANNER (May 1 2026)
//
// Hunts overnight-plannable Strat patterns where the setup completes at
// prior-day close. Catches the "KO May 1" type plays — Daily 1-3-1 + double
// inside day = max coil = explosion at next-day open.
//
// Setup taxonomy:
//   1-3-1       inside, outside, inside (classic coil-explode-coil)
//   double-1    two consecutive inside bars (energy compression)
//   3-1-1       outside followed by 2 insides (releasing into double coil)
//   2U-1-1      directional up then 2 insides (looking for continuation)
//   2D-1-1      directional down then 2 insides (looking for continuation)
//   2-1         prep state — one directional + one inside (waiting for trigger)
//
// Output per match:
//   ticker, pattern, direction bias, bull/bear triggers, stop, target,
//   conviction, RR, broker-split sizing (Public 1ct + TS 2ct default)
//
// Cron: 4:00 PM ET weekdays (after RTH close, after morningSetupScanner queues)
// Endpoint: GET /api/coil-scan (cached) + POST /api/coil-scan/run (force)
// =============================================================================

var fs = require('fs');
var path = require('path');

var lvlComputer = null;
try { lvlComputer = require('./lvlComputer'); }
catch (e) { console.log('[COIL] lvlComputer not loaded:', e.message); }

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[COIL] tradestation not loaded:', e.message); }

var wpScanner = null;
try { wpScanner = require('./wealthPrinceScanner'); }
catch (e) { console.log('[COIL] wealthPrinceScanner not loaded:', e.message); }

var lottoFeed = null;
try { lottoFeed = require('./lottoFeed'); } catch (e) {}

var swingLeapFeed = null;
try { swingLeapFeed = require('./swingLeapFeed'); } catch (e) {}

var sniperFeed = null;
try { sniperFeed = require('./sniperFeed'); } catch (e) {}

var holdOvernightChecker = null;
try { holdOvernightChecker = require('./holdOvernightChecker'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var COIL_FILE = path.join(DATA_ROOT, 'coil_scan.json');

// Hardcoded fallback to #stratum-swing webhook (per discord_webhooks.md memory).
// Avoids Railway env-var dependency for auto-push to work out of the box.
var DISCORD_WEBHOOK = process.env.DISCORD_COIL_WEBHOOK
  || process.env.DISCORD_STRATUMSWING_WEBHOOK
  || 'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// =============================================================================
// STRAT BAR CLASSIFICATION
// =============================================================================
function stratNumber(bar, prev) {
  if (!bar || !prev) return null;
  var insideHigh = bar.High <= prev.High;
  var insideLow  = bar.Low >= prev.Low;
  var outsideHigh = bar.High > prev.High;
  var outsideLow  = bar.Low < prev.Low;

  if (insideHigh && insideLow)   return '1';   // inside bar
  if (outsideHigh && outsideLow) return '3';   // outside bar
  if (outsideHigh && insideLow)  return '2U';  // directional up (took prior high, held above prior low)
  if (insideHigh && outsideLow)  return '2D';  // directional down
  // Edge cases (equal H or L) — treat as directional based on close
  if (bar.High > prev.High) return '2U';
  if (bar.Low < prev.Low)   return '2D';
  return '1';
}

// Build sequence of last N Strat numbers
function classifySequence(bars) {
  var seq = [];
  for (var i = 1; i < bars.length; i++) {
    seq.push(stratNumber(bars[i], bars[i - 1]));
  }
  return seq;
}

// =============================================================================
// PATTERN DETECTION
// =============================================================================
// Returns { name, direction, conviction } or null
function detectCoilPattern(seq, bars) {
  var n = seq.length;
  if (n < 1) return null;

  var last = seq[n - 1];
  var prev = n >= 2 ? seq[n - 2] : null;
  var p3 = n >= 3 ? seq[n - 3] : null;

  // Classic 1-3-1 (3 most recent: inside, outside, inside)
  if (p3 === '1' && prev === '3' && last === '1') {
    var dir = directionFromOutside(bars[bars.length - 2]);  // bar 3 = bars[n-1]
    return { name: '1-3-1', direction: dir, conviction: 9 };
  }

  // Double inside day (last 2 are inside)
  if (prev === '1' && last === '1') {
    // Direction inferred from the bar BEFORE the doubles (the parent directional)
    var parent = n >= 3 ? seq[n - 3] : null;
    var pdir = parent === '2U' ? 'long' : parent === '2D' ? 'short' : 'neutral';
    if (parent === '3') pdir = directionFromOutside(bars[bars.length - 3]);
    var convBoost = parent === '2U' || parent === '2D' ? 1 : 0;
    return { name: 'double-inside', direction: pdir, conviction: 7 + convBoost };
  }

  // 3-1-1 (outside + 2 insides) — same shape as KO Apr 30 (when read as 3 then 1 then 1)
  if (p3 === '3' && prev === '1' && last === '1') {
    var d = directionFromOutside(bars[bars.length - 3]);  // bar 3 = bars[n-3]+1 = bars[n-2]
    return { name: '3-1-1', direction: d, conviction: 8 };
  }

  // 2U/2D-1-1 (directional + 2 insides) — momentum coil
  if (p3 === '2U' && prev === '1' && last === '1') {
    return { name: '2U-1-1', direction: 'long', conviction: 7 };
  }
  if (p3 === '2D' && prev === '1' && last === '1') {
    return { name: '2D-1-1', direction: 'short', conviction: 7 };
  }

  // 2-1 prep (only 2 bars matter — directional + inside) — lower conviction, "watch for trigger"
  if (prev === '2U' && last === '1') {
    return { name: '2U-1-prep', direction: 'long', conviction: 5 };
  }
  if (prev === '2D' && last === '1') {
    return { name: '2D-1-prep', direction: 'short', conviction: 5 };
  }

  return null;
}

function directionFromOutside(bar) {
  if (!bar) return 'neutral';
  // Outside bar that closed higher than open = bull bias; lower = bear
  if (bar.Close > bar.Open) return 'long';
  if (bar.Close < bar.Open) return 'short';
  return 'neutral';
}

// =============================================================================
// PLAN BUILDER — given pattern + bars, compute entry/stop/target/RR
// =============================================================================
function buildPlan(pattern, bars) {
  if (!bars || bars.length < 2) return null;
  var lastBar = bars[bars.length - 1];   // the most recent inside (or current state)
  var range = lastBar.High - lastBar.Low;
  if (range <= 0) return null;

  // For a coil setup, triggers are ABOVE the inside bar high (bull) or BELOW (bear)
  var bullTrigger = round2(lastBar.High);
  var bearTrigger = round2(lastBar.Low);
  var bullStop = round2(lastBar.Low);
  var bearStop = round2(lastBar.High);

  // Target = projection of the prior bar's range (where the energy was stored)
  var priorBar = bars[bars.length - 2];
  var priorRange = (priorBar && priorBar.High > priorBar.Low) ? (priorBar.High - priorBar.Low) : range * 1.5;

  var bullTarget1 = round2(bullTrigger + priorRange * 0.5);
  var bullTarget2 = round2(bullTrigger + priorRange);
  var bearTarget1 = round2(bearTrigger - priorRange * 0.5);
  var bearTarget2 = round2(bearTrigger - priorRange);

  var direction = pattern.direction;
  var primary = direction === 'long' ? {
    trigger: bullTrigger, stop: bullStop, tp1: bullTarget1, tp2: bullTarget2,
    risk: round2(bullTrigger - bullStop),
    reward1: round2(bullTarget1 - bullTrigger),
    reward2: round2(bullTarget2 - bullTrigger),
  } : direction === 'short' ? {
    trigger: bearTrigger, stop: bearStop, tp1: bearTarget1, tp2: bearTarget2,
    risk: round2(bearStop - bearTrigger),
    reward1: round2(bearTrigger - bearTarget1),
    reward2: round2(bearTrigger - bearTarget2),
  } : null;

  return {
    direction: direction,
    primary: primary,
    bullTrigger: bullTrigger, bullStop: bullStop, bullTarget1: bullTarget1, bullTarget2: bullTarget2,
    bearTrigger: bearTrigger, bearStop: bearStop, bearTarget1: bearTarget1, bearTarget2: bearTarget2,
    insideRange: round2(range),
    priorRange: round2(priorRange),
    rr1: primary && primary.risk > 0 ? round2(primary.reward1 / primary.risk) : null,
    rr2: primary && primary.risk > 0 ? round2(primary.reward2 / primary.risk) : null,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

// =============================================================================
// VOLUME CONTEXT — John's rule: low vol on coil, expand on breakout (≥1.5×)
// Computed at scan time so the Discord card carries the volume threshold AB
// must see on the breakout candle to consider it confirmed (not a false break).
// =============================================================================
// =============================================================================
// BREAKOUT CONFIRM — pulls intraday 5m bars, checks if a coil setup has fired
// with John's rule (>=1.5x avg vol on breakout candle = confirmed).
// Returns: { verdict, breakoutBar, avgVolume, threshold, lastClose, ... }
// Verdicts: CONFIRMED_STRONG (>=1.5x) | CONFIRMED_LIGHT (>=1.2x) |
//           UNCONFIRMED_LOW_VOL (<1.2x) | NOT_TRIGGERED | STALE_BREAKOUT |
//           INSUFFICIENT_BARS | TS_ERROR
// =============================================================================
async function checkBreakoutConfirm(ticker, trigger, direction, opts) {
  opts = opts || {};
  trigger = parseFloat(trigger);
  direction = String(direction || 'long').toLowerCase();
  if (!ticker || !isFinite(trigger)) return { ok: false, error: 'bad-args' };
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch(e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
    + '?unit=Minute&interval=5&barsback=60&sessiontemplate=Default';
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ok: false, error: 'TS-bars-' + r.status, verdict: 'TS_ERROR' };
    var data = await r.json();
    var raw = (data && (data.Bars || data.bars)) || [];
    if (raw.length < 25) return { ok: true, ticker: ticker, verdict: 'INSUFFICIENT_BARS', barCount: raw.length };

    var bars = raw.map(function(b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || b.Volume || 0),
        TimeStamp: b.TimeStamp,
      };
    });

    var breakoutIdx = -1;
    for (var i = 1; i < bars.length; i++) {
      var prevClose = bars[i - 1].Close;
      var thisClose = bars[i].Close;
      if (direction === 'long' && prevClose < trigger && thisClose >= trigger) { breakoutIdx = i; break; }
      if (direction === 'short' && prevClose > trigger && thisClose <= trigger) { breakoutIdx = i; break; }
    }

    var refEnd = breakoutIdx > 0 ? breakoutIdx : bars.length;
    var refStart = Math.max(0, refEnd - 20);
    var sum = 0, n = 0;
    for (var j = refStart; j < refEnd; j++) {
      if (isFinite(bars[j].Volume) && bars[j].Volume > 0) { sum += bars[j].Volume; n++; }
    }
    var avgVol = n > 0 ? sum / n : 0;
    var threshold = Math.round(avgVol * 1.5);
    var lastBar = bars[bars.length - 1];
    var lastBreached = direction === 'long' ? lastBar.Close >= trigger : lastBar.Close <= trigger;

    var verdict, breakoutBar = null, breakoutRatio = null;
    if (breakoutIdx === -1) {
      verdict = lastBreached ? 'STALE_BREAKOUT' : 'NOT_TRIGGERED';
    } else {
      breakoutBar = bars[breakoutIdx];
      breakoutRatio = avgVol > 0 ? Math.round((breakoutBar.Volume / avgVol) * 100) / 100 : null;
      if (breakoutRatio >= 1.5)      verdict = 'CONFIRMED_STRONG';
      else if (breakoutRatio >= 1.2) verdict = 'CONFIRMED_LIGHT';
      else                            verdict = 'UNCONFIRMED_LOW_VOL';
    }

    return {
      ok: true,
      ticker: ticker, direction: direction, trigger: trigger,
      verdict: verdict,
      breakoutIndex: breakoutIdx,
      breakoutBar: breakoutBar ? {
        time: breakoutBar.TimeStamp,
        close: breakoutBar.Close,
        volume: breakoutBar.Volume,
        ratio: breakoutRatio,
      } : null,
      avgVolume: Math.round(avgVol),
      threshold: threshold,
      lastClose: lastBar.Close,
      barCount: bars.length,
    };
  } catch(e) {
    return { ok: false, error: e.message, verdict: 'TS_ERROR' };
  }
}

function computeVolumeContext(bars) {
  if (!bars || bars.length < 4) return null;
  var lookback = Math.min(20, bars.length - 1);
  // Use bars BEFORE the current inside bar (excludes the latest 1 bar so the
  // average reflects the prior swing, not the just-formed coil).
  var ref = bars.slice(-1 - lookback, -1);
  var sum = 0, n = 0;
  for (var i = 0; i < ref.length; i++) {
    if (isFinite(ref[i].Volume) && ref[i].Volume > 0) { sum += ref[i].Volume; n++; }
  }
  if (n < 3) return null;
  var avg = sum / n;
  var insideBarVol = bars[bars.length - 1].Volume || 0;
  return {
    avgN: n,
    avgVolume: Math.round(avg),
    insideBarVolume: Math.round(insideBarVol),
    insideBarRatio: avg > 0 ? round2(insideBarVol / avg) : null,
    breakoutMin: Math.round(avg * 1.2),     // baseline confirmation
    breakoutTarget: Math.round(avg * 1.5),  // John's "with volume" standard
    breakoutStrong: Math.round(avg * 2.0),  // power-candle level
  };
}

// =============================================================================
// CONVICTION SCORING — refines the base pattern conviction with extra factors
// =============================================================================
function adjustConviction(base, ticker, bars, holdRating, tf) {
  var conv = base;

  // TF weight: Weekly setups are structurally rarer and carry more meaning
  // than the same pattern on intraday TFs. Sniper-style "fire weekly
  // consolidations" deserve a baseline bump.
  if (tf === 'Weekly')      conv += 2;
  else if (tf === 'Daily')  conv += 1;
  // 6HR: no bump (this was the original calibration baseline)

  // Hold-overnight rating
  if (holdRating === 'AVOID')   conv -= 3;
  if (holdRating === 'CAUTION') conv -= 1;
  if (holdRating === 'SAFE')    conv += 1;

  // Tight inside bar (range < 1.5% of price) = high coil
  if (bars && bars.length >= 1) {
    var lastBar = bars[bars.length - 1];
    var rangePct = lastBar.High > 0 ? ((lastBar.High - lastBar.Low) / lastBar.High) * 100 : 99;
    if (rangePct < 1.5) conv += 1;
    if (rangePct < 1.0) conv += 1;
  }

  // Clamp 1-10
  return Math.max(1, Math.min(10, conv));
}

// =============================================================================
// BUILD UNIVERSE — same dynamic merge as LVL scan
// =============================================================================
function buildUniverse() {
  var staticUniverse = (wpScanner && wpScanner.UNIVERSE) ? wpScanner.UNIVERSE.slice() : [];
  var dynamic = [];
  try {
    if (lottoFeed) {
      var lf = lottoFeed.loadFeed({ limit: 50 });
      (lf.picks || []).forEach(function(p) { if (p.ticker) dynamic.push(p.ticker); });
    }
    if (swingLeapFeed) {
      var sf = swingLeapFeed.loadFeed({ limit: 30 });
      (sf.posts || []).forEach(function(p) { if (p.ticker) dynamic.push(p.ticker); });
    }
    if (sniperFeed) {
      var snf = sniperFeed.loadFeed({ limit: 30 });
      (snf.posts || []).forEach(function(p) { if (p.ticker) dynamic.push(p.ticker); });
    }
  } catch(e) {}

  var seen = {};
  var universe = [];
  staticUniverse.concat(dynamic).forEach(function(t) {
    var u = String(t).toUpperCase();
    if (!seen[u]) { seen[u] = true; universe.push(u); }
  });
  return universe;
}

// =============================================================================
// TIMEFRAME SPECS — Daily and 6HR (240 min × 1.5 = 360 min)
// =============================================================================
var TF_SPECS = {
  'Daily':  { unit: 'Daily',  interval: 1,   barsback: 5,  sessiontemplate: null,      label: 'Daily'  },
  '6HR':    { unit: 'Minute', interval: 360, barsback: 10, sessiontemplate: 'Default', label: '6HR'    },
  'Weekly': { unit: 'Weekly', interval: 1,   barsback: 12, sessiontemplate: null,      label: 'Weekly' },
};

// =============================================================================
// SCAN ONE TICKER — supports Daily + 6HR via opts.tf
// =============================================================================
async function scanTicker(ticker, token, opts) {
  opts = opts || {};
  var tf = opts.tf || 'Daily';
  var spec = TF_SPECS[tf];
  if (!spec) return { ticker: ticker, tf: tf, error: 'unknown-tf-' + tf };

  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=' + spec.unit + '&interval=' + spec.interval + '&barsback=' + spec.barsback;
    if (spec.sessiontemplate) url += '&sessiontemplate=' + spec.sessiontemplate;

    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    if (!r.ok) return { ticker: ticker, tf: tf, error: 'TS-bars-' + r.status };
    var data = await r.json();
    var raw = (data && (data.Bars || data.bars)) || [];
    if (raw.length < 3) return { ticker: ticker, tf: tf, error: 'not-enough-bars-' + raw.length };

    var bars = raw.map(function(b) {
      return {
        High: parseFloat(b.High), Low: parseFloat(b.Low),
        Open: parseFloat(b.Open), Close: parseFloat(b.Close),
        Volume: parseFloat(b.TotalVolume || b.Volume || 0),
        TimeStamp: b.TimeStamp,
      };
    }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });

    var seq = classifySequence(bars);
    var pattern = detectCoilPattern(seq, bars);
    if (!pattern) return { ticker: ticker, tf: tf, sequence: seq.join('-'), pattern: null };

    var plan = buildPlan(pattern, bars);
    if (!plan || !plan.primary) return { ticker: ticker, tf: tf, sequence: seq.join('-'), pattern: pattern.name, error: 'no-plan' };

    var lastClose = bars[bars.length - 1].Close;

    // Hold-overnight rating
    var holdRating = null;
    if (holdOvernightChecker) {
      try {
        var dir = pattern.direction === 'long' ? 'LONG' : 'SHORT';
        var hr = await holdOvernightChecker.checkTicker(ticker, { direction: dir });
        holdRating = hr && hr.rating;
      } catch(e) {}
    }

    var conviction = adjustConviction(pattern.conviction, ticker, bars, holdRating, tf);
    var volumeContext = computeVolumeContext(bars);

    return {
      ticker: ticker,
      tf: tf,
      pattern: pattern.name,
      direction: pattern.direction,
      sequence: seq.join('-'),
      conviction: conviction,
      lastClose: round2(lastClose),
      plan: plan,
      holdRating: holdRating || null,
      volumeContext: volumeContext,
      bars: bars.length,
    };
  } catch (e) {
    return { ticker: ticker, tf: tf, error: e.message };
  }
}

// =============================================================================
// MAIN SCAN — runs across universe with concurrency
// =============================================================================
var _lastRun = null;
var _running = false;

async function runScan(opts) {
  opts = opts || {};
  if (_running && !opts.force) return { skipped: true, reason: 'already-running' };
  _running = true;
  var start = Date.now();

  try {
    var token = opts.token;
    if (!token && ts && ts.getAccessToken) {
      try { token = await ts.getAccessToken(); }
      catch (e) { return { error: 'TS auth: ' + e.message }; }
    }
    if (!token) return { error: 'no-token' };

    var universe = opts.tickers || buildUniverse();
    if (!universe.length) return { error: 'empty-universe' };

    // Default: scan BOTH Daily and 6HR timeframes (John uses 6HR primarily,
    // Daily catches the bigger structural plays like KO Apr 30 double-inside)
    var tfs = opts.tfs || ['Daily', '6HR'];
    if (typeof tfs === 'string') tfs = [tfs];

    console.log('[COIL] scanning', universe.length, 'tickers across TFs:', tfs.join(','));

    var CONCURRENCY = 5;
    var results = [];

    // Run scan once per timeframe, accumulate all results (each tagged with tf)
    for (var tfIdx = 0; tfIdx < tfs.length; tfIdx++) {
      var currentTF = tfs[tfIdx];
      console.log('[COIL]   ↳', currentTF);
      for (var i = 0; i < universe.length; i += CONCURRENCY) {
        var batch = universe.slice(i, i + CONCURRENCY);
        var batchTF = currentTF;  // closure-safe capture
        var batchResults = await Promise.all(batch.map(function(t) {
          return scanTicker(t, token, { tf: batchTF });
        }));
        results = results.concat(batchResults);
        if (i + CONCURRENCY < universe.length) {
          await new Promise(function(r) { setTimeout(r, 100); });
        }
      }
      // Throttle harder between timeframes (different bar fetches stress TS)
      if (tfIdx < tfs.length - 1) {
        await new Promise(function(r) { setTimeout(r, 500); });
      }
    }

    // Filter to actual matches with plans
    var matches = results.filter(function(r) { return r.pattern && r.plan; });

    // Sort by conviction desc, then by direction-bias clarity
    matches.sort(function(a, b) {
      if (b.conviction !== a.conviction) return b.conviction - a.conviction;
      // Long/short over neutral
      if (a.direction === 'neutral' && b.direction !== 'neutral') return 1;
      if (b.direction === 'neutral' && a.direction !== 'neutral') return -1;
      return 0;
    });

    // Bucket by quality
    var ready    = matches.filter(function(m) { return m.conviction >= 8 && m.direction !== 'neutral'; });
    var watching = matches.filter(function(m) { return m.conviction >= 6 && m.conviction < 8 && m.direction !== 'neutral'; });
    var prep     = matches.filter(function(m) { return m.conviction < 6 || m.direction === 'neutral'; });

    var payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      timeframes: tfs,
      scanned: results.length,
      matched: matches.length,
      ready: ready,
      watching: watching,
      prep: prep,
      // Counts of each pattern across all matches
      byPattern: matches.reduce(function(acc, m) {
        var key = m.tf + ':' + m.pattern;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      byTF: matches.reduce(function(acc, m) {
        acc[m.tf] = (acc[m.tf] || 0) + 1;
        return acc;
      }, {}),
    };

    // Persist for the cron + UI to read
    try {
      fs.writeFileSync(COIL_FILE, JSON.stringify(payload, null, 2));
    } catch (e) { console.warn('[COIL] write fail:', e.message); }

    _lastRun = { finishedAt: payload.generatedAt, scanned: payload.scanned, matched: payload.matched };
    console.log('[COIL] done in', payload.tookMs + 'ms · matched', payload.matched + '/' + payload.scanned,
                '· ready', ready.length, '· watching', watching.length);

    // Push to Discord — only on cron/EOD runs (skip on manual force scans to avoid spam)
    if (opts.pushDiscord !== false && (opts.cron || ready.length > 0)) {
      try {
        var pushResult = await pushToDiscord(payload);
        payload.discordPush = pushResult;
      } catch (e) {
        console.warn('[COIL] discord push failed:', e.message);
        payload.discordPush = { error: e.message };
      }
    }

    return payload;
  } finally {
    _running = false;
  }
}

function loadLast() {
  if (!fs.existsSync(COIL_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(COIL_FILE, 'utf8')); }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

// =============================================================================
// DISCORD PUSH — top coil setups posted at 3:50 PM ET pre-close
// =============================================================================
async function pushToDiscord(payload) {
  if (!DISCORD_WEBHOOK) {
    console.log('[COIL] no DISCORD_COIL_WEBHOOK set — skipping push');
    return { skipped: 'no webhook' };
  }
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var ready = (payload.ready || []).slice(0, 5);
  var watching = (payload.watching || []).slice(0, 3);

  if (!ready.length && !watching.length) {
    console.log('[COIL] no coils to push to Discord');
    return { skipped: 'no coils' };
  }

  var lines = [];
  var tfTag = (payload.timeframes || ['Daily']).join('+');
  lines.push('# 🌀 COIL SCAN — ' + tfTag + ' Pre-Position');
  lines.push('_' + new Date(payload.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + payload.matched + ' coils across ' + payload.scanned + ' (' + (payload.byTF ? Object.keys(payload.byTF).map(function(t) { return t + ':' + payload.byTF[t]; }).join(' / ') : '?') + ')_');
  lines.push('');

  // Group ready setups by TF for cleaner display
  var readyByTF = {};
  ready.forEach(function(r) {
    var t = r.tf || 'Daily';
    if (!readyByTF[t]) readyByTF[t] = [];
    readyByTF[t].push(r);
  });

  if (ready.length) {
    Object.keys(readyByTF).forEach(function(tfKey) {
      var arr = readyByTF[tfKey];
      var tfIcon = tfKey === '6HR' ? '⏱️' : tfKey === 'Weekly' ? '📆' : '📅';
      lines.push('## 🔥 READY · ' + tfIcon + ' ' + tfKey + ' (' + arr.length + ')');
      arr.forEach(function(r) {
        var p = r.plan || {};
        var pp = p.primary || {};
        var dirIcon = r.direction === 'long' ? '🟢⬆️' : r.direction === 'short' ? '🔴⬇️' : '⚪';
        var holdIcon = r.holdRating === 'SAFE' ? '✅' : r.holdRating === 'CAUTION' ? '⚠️' : r.holdRating === 'AVOID' ? '🛑' : '';
        lines.push('**' + r.ticker + '** ' + dirIcon + ' ' + r.pattern + ' · conv ' + r.conviction + '/10 ' + holdIcon);
        // Compute % moves (Sniper-style "15% expected")
        var trig = pp.trigger;
        var tp1Pct = (trig && pp.tp1) ? round2(((pp.tp1 - trig) / trig) * 100 * (r.direction === 'short' ? -1 : 1)) : null;
        var tp2Pct = (trig && pp.tp2) ? round2(((pp.tp2 - trig) / trig) * 100 * (r.direction === 'short' ? -1 : 1)) : null;
        var pctTag = (tp2Pct != null) ? ' (+' + tp2Pct + '%)' : '';
        lines.push('  Trigger `$' + (pp.trigger || '?') + '` · Stop `$' + (pp.stop || '?') + '` · TP1 `$' + (pp.tp1 || '?') + '` · TP2 `$' + (pp.tp2 || '?') + '`' + pctTag + ' · RR `' + (p.rr1 || '?') + '×`');
        // Volume confirmation rule (John): ≥1.5× avg on breakout candle = confirmed
        if (r.volumeContext) {
          var vc = r.volumeContext;
          var coilVol = vc.insideBarRatio != null ? (vc.insideBarRatio + '×') : '?';
          lines.push('  📊 Coil vol `' + coilVol + '` · Need ≥`' + Math.round(vc.breakoutTarget / 1000) + 'k` (1.5× avg) on breakout candle to fire');
        }
        lines.push('  → 1ct Public + 2ct TS overnight pre-position');
      });
      lines.push('');
    });
  }

  // Watching grouped likewise
  var watchingByTF = {};
  watching.forEach(function(r) {
    var t = r.tf || 'Daily';
    if (!watchingByTF[t]) watchingByTF[t] = [];
    watchingByTF[t].push(r);
  });

  if (watching.length) {
    Object.keys(watchingByTF).forEach(function(tfKey) {
      var arr = watchingByTF[tfKey];
      var tfIcon = tfKey === '6HR' ? '⏱️' : tfKey === 'Weekly' ? '📆' : '📅';
      lines.push('## 🟡 WATCHING · ' + tfIcon + ' ' + tfKey + ' (' + arr.length + ')');
      arr.forEach(function(r) {
        var p = r.plan || {};
        var pp = p.primary || {};
        var dirIcon = r.direction === 'long' ? '⬆️' : '⬇️';
        lines.push('**' + r.ticker + '** ' + dirIcon + ' ' + r.pattern + ' · ' + r.conviction + '/10 · trig `$' + (pp.trigger || '?') + '` · RR `' + (p.rr1 || '?') + '×`');
      });
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('🕒 3:50 PM ET cron · 📅 Daily = bigger structure (rare) · ⏱️ 6HR = John\'s primary signal');

  var content = lines.join('\n');
  // Discord limits content to 2000 chars
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'Coil Scanner Bot' }),
    });
    if (!r.ok) {
      var t = await r.text();
      console.warn('[COIL] discord push failed:', r.status, t.slice(0, 200));
      return { error: 'discord-' + r.status };
    }
    console.log('[COIL] discord push OK (' + ready.length + ' ready, ' + watching.length + ' watching)');
    return { posted: true, readyCount: ready.length, watchingCount: watching.length };
  } catch (e) {
    console.error('[COIL] discord push error:', e.message);
    return { error: e.message };
  }
}

function getStatus() {
  return { running: _running, lastRun: _lastRun, file: COIL_FILE };
}

module.exports = {
  runScan: runScan,
  scanTicker: scanTicker,
  loadLast: loadLast,
  getStatus: getStatus,
  pushToDiscord: pushToDiscord,
  checkBreakoutConfirm: checkBreakoutConfirm,
  // Exposed for testing
  stratNumber: stratNumber,
  classifySequence: classifySequence,
  detectCoilPattern: detectCoilPattern,
  buildPlan: buildPlan,
};
