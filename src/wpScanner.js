// =============================================================================
// WP (WEALTH PRINCE) SCANNER (May 1 2026)
//
// Hunts WP-methodology swing setups:
//   - 4HR primary timeframe
//   - 9 EMA > 21 EMA on 4HR (longs) / inverse (shorts) — TREND GATE (mandatory)
//   - Price above both EMAs (longs) — POSITION GATE (mandatory)
//   - Hammer / inside-bar / pullback signal at 4HR support — ENTRY TRIGGER
//   - Volume confirmation (1.0×+ MA on signal bar)
//   - Multi-TF FTFC bonus (Daily aligned with 4HR = +2 conviction)
//
// Conviction tiers (RISK-BASED sizing):
//   5-6   TRIAL     2.5% risk budget ($500 on $20K acct)
//   7-8   STANDARD  5%   risk budget ($1,000)
//   9-10  MAX SIZE  7.5% risk budget ($1,500) ← QCOM-quality setups
//   10+   TURBO     10%  risk budget ($2,000) — requires explicit override
//
// Discipline guards:
//   - NO size-up below conviction 7 (system refuses 2ct+ recommendations)
//   - TURBO requires override keyword
//   - FOCUS MODE: only top 3 setups shown; "MY PICK" tracking limits active swings
//
// Cron: 4:30 PM ET weekdays (after coil scan, before EOD positioning)
// Endpoint: GET /api/wp-scan + POST /api/wp-scan/run
// =============================================================================

var fs = require('fs');
var path = require('path');

var lvlComputer = null;
try { lvlComputer = require('./lvlComputer'); }
catch (e) { console.log('[WP] lvlComputer not loaded:', e.message); }

var ts = null;
try { ts = require('./tradestation'); }
catch (e) { console.log('[WP] tradestation not loaded:', e.message); }

var wpScanner = null;
try { wpScanner = require('./wealthPrinceScanner'); }
catch (e) { console.log('[WP] wealthPrinceScanner not loaded:', e.message); }

var lottoFeed = null;
try { lottoFeed = require('./lottoFeed'); } catch (e) {}

var swingLeapFeed = null;
try { swingLeapFeed = require('./swingLeapFeed'); } catch (e) {}

var sniperFeed = null;
try { sniperFeed = require('./sniperFeed'); } catch (e) {}

var holdOvernightChecker = null;
try { holdOvernightChecker = require('./holdOvernightChecker'); } catch (e) {}

var johnPatternMatcher = null;
try { johnPatternMatcher = require('./johnPatternMatcher'); } catch (e) {}

var dailyCoilScanner = null;
try { dailyCoilScanner = require('./dailyCoilScanner'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var WP_FILE = path.join(DATA_ROOT, 'wp_scan.json');
var DISCORD_WEBHOOK = process.env.DISCORD_WP_WEBHOOK || process.env.DISCORD_STRATUMSWING_WEBHOOK || null;

// Account size for risk-based sizing (set via env, default $20K)
var ACCOUNT_SIZE = parseInt(process.env.WP_ACCOUNT_SIZE || '20000');

// =============================================================================
// EMA CALCULATION
// =============================================================================
function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  var k = 2 / (period + 1);
  var ema = values.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (var i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// Returns array of EMAs aligned to bars (last index = most recent EMA)
function emaSeries(values, period) {
  if (!values || values.length < period) return [];
  var k = 2 / (period + 1);
  var out = [];
  var seed = values.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  // Pad pre-period
  for (var i = 0; i < period - 1; i++) out.push(null);
  out.push(seed);
  var prev = seed;
  for (var i = period; i < values.length; i++) {
    var ema = values[i] * k + prev * (1 - k);
    out.push(ema);
    prev = ema;
  }
  return out;
}

// =============================================================================
// 4HR BAR FETCH (240-minute interval)
// =============================================================================
async function fetch4HRBars(ticker, token, barsBack) {
  barsBack = barsBack || 30;
  var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
    + '?unit=Minute&interval=240&barsback=' + barsBack
    + '&sessiontemplate=Default';
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 12000 });
  if (!r.ok) throw new Error('TS-bars-' + r.status);
  var data = await r.json();
  var raw = (data && (data.Bars || data.bars)) || [];
  return raw.map(function(b) {
    return {
      Open:  parseFloat(b.Open),
      High:  parseFloat(b.High),
      Low:   parseFloat(b.Low),
      Close: parseFloat(b.Close),
      Volume: parseFloat(b.TotalVolume || b.Volume || 0),
      TimeStamp: b.TimeStamp,
    };
  }).filter(function(b) { return isFinite(b.High) && isFinite(b.Low); });
}

// =============================================================================
// PATTERN DETECTION — hammer / inside / pullback
// =============================================================================
function isHammer(bar) {
  if (!bar) return false;
  var body = Math.abs(bar.Close - bar.Open);
  var range = bar.High - bar.Low;
  if (range <= 0) return false;
  var lowerWick = Math.min(bar.Open, bar.Close) - bar.Low;
  var upperWick = bar.High - Math.max(bar.Open, bar.Close);
  // Hammer: lower wick ≥ 2× body AND upper wick ≤ 0.5× body
  return lowerWick >= 2 * body && upperWick <= 0.5 * body && body > 0.001;
}

function isShootingStar(bar) {
  if (!bar) return false;
  var body = Math.abs(bar.Close - bar.Open);
  var range = bar.High - bar.Low;
  if (range <= 0) return false;
  var lowerWick = Math.min(bar.Open, bar.Close) - bar.Low;
  var upperWick = bar.High - Math.max(bar.Open, bar.Close);
  return upperWick >= 2 * body && lowerWick <= 0.5 * body && body > 0.001;
}

function isInsideBar(bar, prev) {
  if (!bar || !prev) return false;
  return bar.High <= prev.High && bar.Low >= prev.Low;
}

// Pullback to EMA: low touches/dips below EMA, close back above EMA
function isPullbackToEMA(bar, emaValue) {
  if (!bar || !emaValue) return false;
  return bar.Low <= emaValue * 1.005 && bar.Close > emaValue;
}

// =============================================================================
// WP SIGNAL CLASSIFIER — given bars + EMAs, return signal + direction or null
// =============================================================================
function classifyWPSignal(bars, ema9, ema21) {
  if (!bars || bars.length < 3 || !ema9 || !ema21) return null;
  var n = bars.length;
  var lastBar = bars[n - 1];
  var prevBar = bars[n - 2];
  var lastEma9 = ema9[n - 1];
  var lastEma21 = ema21[n - 1];
  if (!lastEma9 || !lastEma21) return null;

  // TREND GATE
  var bullTrend = lastEma9 > lastEma21;
  var bearTrend = lastEma9 < lastEma21;

  // POSITION GATE — for longs, price above both EMAs
  var bullPosition = lastBar.Close > lastEma9 && lastBar.Close > lastEma21;
  var bearPosition = lastBar.Close < lastEma9 && lastBar.Close < lastEma21;

  // ENTRY TRIGGER
  if (bullTrend && bullPosition) {
    if (isHammer(lastBar)) {
      return { signal: 'hammer-long', direction: 'long', confidence: 'high' };
    }
    if (isPullbackToEMA(lastBar, lastEma9)) {
      return { signal: 'pullback-9ema-long', direction: 'long', confidence: 'high' };
    }
    if (isInsideBar(lastBar, prevBar) && prevBar.Close > prevBar.Open) {
      return { signal: 'inside-after-up-long', direction: 'long', confidence: 'medium' };
    }
  }

  if (bearTrend && bearPosition) {
    if (isShootingStar(lastBar)) {
      return { signal: 'star-short', direction: 'short', confidence: 'high' };
    }
    if (lastBar.High >= lastEma9 * 0.995 && lastBar.Close < lastEma9) {
      return { signal: 'pullback-9ema-short', direction: 'short', confidence: 'high' };
    }
    if (isInsideBar(lastBar, prevBar) && prevBar.Close < prevBar.Open) {
      return { signal: 'inside-after-down-short', direction: 'short', confidence: 'medium' };
    }
  }

  return null;
}

// =============================================================================
// CONVICTION SCORING (1-10)
// =============================================================================
function scoreConviction(opts) {
  var conv = 5;  // base
  if (opts.signalConfidence === 'high') conv += 2;
  else if (opts.signalConfidence === 'medium') conv += 1;

  if (opts.dailyAligned) conv += 2;
  if (opts.volumeStrong) conv += 2;       // ≥ 1.5× MA
  else if (opts.volumeOK) conv += 1;       // ≥ 1.0× MA
  if (opts.coilAligned) conv += 1;         // dailyCoilScanner found same-direction coil
  if (opts.catalystClear) conv += 1;       // no earnings/macro nearby
  if (opts.holdSafe) conv += 1;
  if (opts.holdAvoid) conv -= 3;
  if (opts.holdCaution) conv -= 1;
  if (opts.johnPrecedent > 0) conv += 1;
  if (opts.counterTrendDaily) conv -= 2;

  return Math.max(1, Math.min(10, conv));
}

// =============================================================================
// RISK-BASED SIZING — given conviction + premium, returns recommended size
// =============================================================================
function suggestSize(conviction, premiumPerCt, opts) {
  opts = opts || {};
  var accountSize = opts.accountSize || ACCOUNT_SIZE;
  var maxConcentration = opts.maxConcentration || 5;  // never more than 5ct

  // Discipline guard: no size-up below conviction 7
  var allowSizeUp = conviction >= 7;

  var budgetPct;
  var tier;
  if (conviction >= 10 && opts.turboOverride) {
    budgetPct = 0.10;
    tier = 'TURBO';
  } else if (conviction >= 9) {
    budgetPct = 0.075;
    tier = 'MAX';
  } else if (conviction >= 7) {
    budgetPct = 0.05;
    tier = 'STANDARD';
  } else if (conviction >= 5) {
    budgetPct = 0.025;
    tier = 'TRIAL';
  } else {
    return { skip: true, reason: 'conviction <5', tier: 'SKIP' };
  }

  var riskBudget = accountSize * budgetPct;
  var contractCost = (premiumPerCt || 0) * 100;
  if (contractCost <= 0) return { skip: true, reason: 'no premium' };

  var contracts = Math.floor(riskBudget / contractCost);
  if (contracts < 1) {
    return { skip: true, reason: 'premium too high for tier ($' + premiumPerCt.toFixed(2) + ' × 100 > $' + riskBudget + ')' };
  }
  contracts = Math.min(contracts, maxConcentration);

  // Discipline guard on TRIAL — force 1ct only
  if (tier === 'TRIAL') contracts = 1;

  // Discipline guard on STANDARD — max 3ct (extra friction for size-up)
  if (tier === 'STANDARD' && contracts > 3) contracts = 3;

  return {
    tier: tier,
    contracts: contracts,
    totalRisk: contracts * contractCost,
    budgetPct: budgetPct,
    budget: riskBudget,
    allowSizeUp: allowSizeUp,
    requiresOverride: tier === 'TURBO',
  };
}

// =============================================================================
// BUILD UNIVERSE — same dynamic merge pattern
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
// SCAN ONE TICKER
// =============================================================================
async function scanTicker(ticker, token, opts) {
  opts = opts || {};
  try {
    var bars = await fetch4HRBars(ticker, token, 30);
    if (bars.length < 22) return { ticker: ticker, error: 'not-enough-bars-' + bars.length };

    var closes = bars.map(function(b) { return b.Close; });
    var ema9 = emaSeries(closes, 9);
    var ema21 = emaSeries(closes, 21);

    var sig = classifyWPSignal(bars, ema9, ema21);
    if (!sig) return { ticker: ticker, sig: null, lastClose: bars[bars.length-1].Close };

    var lastBar = bars[bars.length - 1];
    var lastEma9 = ema9[ema9.length - 1];
    var lastEma21 = ema21[ema21.length - 1];

    // Volume vs 20-bar MA
    var volMA = bars.slice(-20).reduce(function(a, b) { return a + (b.Volume || 0); }, 0) / 20;
    var volRel = volMA > 0 ? lastBar.Volume / volMA : 0;
    var volumeOK = volRel >= 1.0;
    var volumeStrong = volRel >= 1.5;

    // Daily alignment check via dailyCoilScanner.scanTicker (it pulls daily bars)
    var dailyAligned = false;
    var counterTrendDaily = false;
    var coilAligned = false;
    if (dailyCoilScanner) {
      try {
        var coilResult = await dailyCoilScanner.scanTicker(ticker, token);
        if (coilResult && coilResult.direction) {
          if (coilResult.direction === sig.direction) {
            dailyAligned = true;
            coilAligned = !!coilResult.pattern;
          } else if (coilResult.direction !== 'neutral') {
            counterTrendDaily = true;
          }
        }
      } catch(e) {}
    }

    // Hold-overnight rating
    var holdRating = null;
    var holdSafe = false, holdAvoid = false, holdCaution = false;
    if (holdOvernightChecker) {
      try {
        var dir = sig.direction === 'long' ? 'LONG' : 'SHORT';
        var hr = await holdOvernightChecker.checkTicker(ticker, { direction: dir });
        holdRating = hr && hr.rating;
        holdSafe = holdRating === 'SAFE';
        holdAvoid = holdRating === 'AVOID';
        holdCaution = holdRating === 'CAUTION';
      } catch(e) {}
    }

    // John precedent
    var johnPrecedent = 0;
    if (johnPatternMatcher && johnPatternMatcher.findPrecedent) {
      try {
        var precedent = johnPatternMatcher.findPrecedent(ticker, sig.direction);
        johnPrecedent = (precedent && precedent.count) || 0;
      } catch(e) {}
    }

    var conviction = scoreConviction({
      signalConfidence: sig.confidence,
      dailyAligned: dailyAligned,
      counterTrendDaily: counterTrendDaily,
      coilAligned: coilAligned,
      volumeOK: volumeOK,
      volumeStrong: volumeStrong,
      catalystClear: true,  // TODO: integrate earnings calendar check
      holdSafe: holdSafe,
      holdAvoid: holdAvoid,
      holdCaution: holdCaution,
      johnPrecedent: johnPrecedent,
    });

    // Plan: structural stop below 21 EMA for longs, above for shorts
    // Target: 2× ATR projection
    var atr = computeATR(bars, 14);
    var entry = lastBar.Close;
    var stop = sig.direction === 'long' ? Math.min(lastBar.Low, lastEma21 * 0.99) : Math.max(lastBar.High, lastEma21 * 1.01);
    var risk = Math.abs(entry - stop);
    var tp1 = sig.direction === 'long' ? entry + atr * 1.0 : entry - atr * 1.0;
    var tp2 = sig.direction === 'long' ? entry + atr * 2.0 : entry - atr * 2.0;
    var rr1 = risk > 0 ? Math.abs(tp1 - entry) / risk : null;
    var rr2 = risk > 0 ? Math.abs(tp2 - entry) / risk : null;

    return {
      ticker: ticker,
      signal: sig.signal,
      direction: sig.direction,
      confidence: sig.confidence,
      conviction: conviction,
      lastClose: round2(lastBar.Close),
      ema9: round2(lastEma9),
      ema21: round2(lastEma21),
      volume: lastBar.Volume,
      volRel: round2(volRel),
      atr: round2(atr),
      plan: {
        entry: round2(entry),
        stop: round2(stop),
        risk: round2(risk),
        tp1: round2(tp1),
        tp2: round2(tp2),
        rr1: round2(rr1),
        rr2: round2(rr2),
      },
      dailyAligned: dailyAligned,
      counterTrendDaily: counterTrendDaily,
      coilAligned: coilAligned,
      holdRating: holdRating,
      johnPrecedent: johnPrecedent,
    };
  } catch (e) {
    return { ticker: ticker, error: e.message };
  }
}

function computeATR(bars, period) {
  if (!bars || bars.length < period) return 0;
  var trs = [];
  for (var i = 1; i < bars.length; i++) {
    var b = bars[i];
    var prev = bars[i-1];
    var tr = Math.max(b.High - b.Low, Math.abs(b.High - prev.Close), Math.abs(b.Low - prev.Close));
    trs.push(tr);
  }
  var slice = trs.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / slice.length;
}

function round2(v) { return Math.round(v * 100) / 100; }

// =============================================================================
// MAIN SCAN
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

    console.log('[WP] scanning', universe.length, 'tickers (4HR)');

    var CONCURRENCY = 4;  // Lower than coil scan — we make 2× API calls per ticker
    var results = [];
    for (var i = 0; i < universe.length; i += CONCURRENCY) {
      var batch = universe.slice(i, i + CONCURRENCY);
      var batchResults = await Promise.all(batch.map(function(t) { return scanTicker(t, token); }));
      results = results.concat(batchResults);
      if (i + CONCURRENCY < universe.length) {
        await new Promise(function(r) { setTimeout(r, 150); });
      }
    }

    var matches = results.filter(function(r) { return r.signal && r.plan && !r.error; });
    matches.sort(function(a, b) { return b.conviction - a.conviction; });

    // FOCUS MODE: top 3 only by default for the "MY PICK" workflow
    var topPicks = matches.slice(0, 3);
    var ready = matches.filter(function(m) { return m.conviction >= 7; });
    var trial = matches.filter(function(m) { return m.conviction >= 5 && m.conviction < 7; });

    var payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      scanned: results.length,
      matched: matches.length,
      topPicks: topPicks,
      ready: ready,
      trial: trial,
      accountSize: ACCOUNT_SIZE,
    };

    try {
      fs.writeFileSync(WP_FILE, JSON.stringify(payload, null, 2));
    } catch (e) { console.warn('[WP] write fail:', e.message); }

    _lastRun = { finishedAt: payload.generatedAt, scanned: payload.scanned, matched: payload.matched };
    console.log('[WP] done in', payload.tookMs + 'ms · matched', payload.matched, '· ready(7+)', ready.length);

    if (opts.pushDiscord !== false && (opts.cron || ready.length > 0)) {
      try {
        var pushResult = await pushToDiscord(payload);
        payload.discordPush = pushResult;
      } catch (e) { console.warn('[WP] push fail:', e.message); }
    }

    return payload;
  } finally {
    _running = false;
  }
}

// =============================================================================
// DISCORD PUSH
// =============================================================================
async function pushToDiscord(payload) {
  if (!DISCORD_WEBHOOK) return { skipped: 'no webhook' };
  var ready = (payload.ready || []).slice(0, 3);
  var trial = (payload.trial || []).slice(0, 2);
  if (!ready.length && !trial.length) return { skipped: 'no setups' };

  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var lines = [];
  lines.push('# 🌊 WP SWING SCAN — 4HR/EMA Setups');
  lines.push('_' + new Date(payload.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + payload.matched + ' setups across ' + payload.scanned + ' tickers · FOCUS MODE: top 3 only_');
  lines.push('');

  if (ready.length) {
    lines.push('## 🔥 READY — Conviction 7+ (size-up enabled)');
    ready.forEach(function(r, i) {
      var dirIcon = r.direction === 'long' ? '🟢⬆️' : '🔴⬇️';
      var convColor = r.conviction >= 9 ? '⭐⭐⭐ MAX' : r.conviction >= 8 ? '⭐⭐ HIGH' : '⭐ STANDARD';
      lines.push('**' + (i+1) + '. ' + r.ticker + '** ' + dirIcon + ' ' + r.signal + ' · ' + convColor + ' (' + r.conviction + '/10)');
      lines.push('  Entry `$' + r.plan.entry + '` · Stop `$' + r.plan.stop + '` · TP1 `$' + r.plan.tp1 + '` · TP2 `$' + r.plan.tp2 + '` · RR1 `' + r.plan.rr1 + '×`');
      lines.push('  TF stack: 4HR ✅' + (r.dailyAligned ? ' Daily ✅' : '') + (r.coilAligned ? ' Coil ✅' : '') + ' · Vol `' + r.volRel + '×` · Hold: ' + (r.holdRating || '?') + (r.johnPrecedent ? ' · John: ' + r.johnPrecedent + ' prior' : ''));
    });
    lines.push('');
  }

  if (trial.length) {
    lines.push('## 🟡 TRIAL — Conviction 5-6 (1ct only, no size-up)');
    trial.forEach(function(r) {
      var dirIcon = r.direction === 'long' ? '⬆️' : '⬇️';
      lines.push('**' + r.ticker + '** ' + dirIcon + ' ' + r.signal + ' · ' + r.conviction + '/10 · entry `$' + r.plan.entry + '`');
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('🎯 FOCUS RULE: Pick ONE setup. Watch it. Wait for trigger. Don\'t spread across multiple.');
  lines.push('🛡️ Discipline guard: NO size-up below conviction 7. TURBO requires explicit override.');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'WP Scanner Bot' }),
    });
    if (!r.ok) return { error: 'discord-' + r.status };
    return { posted: true, readyCount: ready.length, trialCount: trial.length };
  } catch (e) { return { error: e.message }; }
}

function loadLast() {
  if (!fs.existsSync(WP_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(WP_FILE, 'utf8')); }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

function getStatus() {
  return { running: _running, lastRun: _lastRun, file: WP_FILE, accountSize: ACCOUNT_SIZE };
}

module.exports = {
  runScan: runScan,
  scanTicker: scanTicker,
  loadLast: loadLast,
  getStatus: getStatus,
  pushToDiscord: pushToDiscord,
  scoreConviction: scoreConviction,
  suggestSize: suggestSize,
  classifyWPSignal: classifyWPSignal,
  // Internal exposed for testing
  emaSeries: emaSeries,
  isHammer: isHammer,
  isInsideBar: isInsideBar,
};
