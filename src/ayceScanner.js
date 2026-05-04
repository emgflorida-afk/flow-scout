// =============================================================================
// AYCE SCANNER — All 5 ATH strategies from AYCE course (Miyagi / 4HR Re-Trigger /
//                3-2-2 First Live / 7HR Liquidity Sweep / Failed 9)
//
// ALL TIMES IN EASTERN. Bars come from TS in UTC, we convert.
// Strategies are TIME-OF-DAY specific — different from Strat which is bar-pattern
// based. Each AYCE strategy keys off specific session candles (4AM, 8AM, 9AM,
// 4PM, etc.) and fires at known clock times.
//
// Universal exit rule: 60-minute flip (price breaks high/low of last 60m candle).
//
// USAGE:
//   var ayce = require('./ayceScanner');
//   var result = await ayce.scanTicker('SPY');
//   // → { ticker, spot, atr, strategies: [{ name, direction, trigger, T1, T2, stop, status }] }
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var LAST_FILE = path.join(DATA_ROOT, 'ayce_last_scan.json');

// Universe: starts with the same MID_CAP universe as JS scanner + indices
var DEFAULT_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD',
  'JPM', 'BAC', 'GS', 'MS', 'C', 'WFC',
  'XLE', 'XLF', 'XLK', 'XLV', 'XLI', 'XLP',
  'COIN', 'PLTR', 'SNOW', 'NET', 'CRWD', 'NOW',
  'UNH', 'CI', 'CVS', 'HUM',
  'BABA', 'BIDU', 'JD', 'PDD',
  'CRM', 'ORCL', 'ADBE', 'IBM',
];

function round2(v) { return Math.round(v * 100) / 100; }

// Convert UTC ISO timestamp → ET hour (handles DST automatically)
function etHour(ts) {
  var d = new Date(ts);
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(fmt.format(d));
}

function etDate(ts) {
  var d = new Date(ts);
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  var parts = fmt.formatToParts(d);
  var y, m, dd;
  parts.forEach(function(p) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') m = p.value;
    if (p.type === 'day') dd = p.value;
  });
  return y + '-' + m + '-' + dd;
}

// Fetch raw bars from TS API — uses Minute/60 then aggregates as needed
async function fetchBars(ticker, opts) {
  opts = opts || {};
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  // For AYCE we need extended-hours bars — sessiontemplate=USEQPreAndPost
  var unit = opts.unit || 'Minute';
  var interval = opts.interval || 60;
  var barsback = opts.barsback || 200;
  var session = opts.session || 'USEQPreAndPost';

  try {
    var url = 'https://api.tradestation.com/v3/marketdata/barcharts/' + encodeURIComponent(ticker)
      + '?unit=' + unit + '&interval=' + interval + '&barsback=' + barsback
      + '&sessiontemplate=' + session;
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 15000 });
    if (!r.ok) return { ok: false, error: 'TS-' + r.status };
    var data = await r.json();
    var raw = (data.Bars || data.bars || []);
    var bars = raw.map(function(b) {
      return {
        t: b.TimeStamp,
        O: parseFloat(b.Open),
        H: parseFloat(b.High),
        L: parseFloat(b.Low),
        C: parseFloat(b.Close),
        V: parseFloat(b.TotalVolume || b.Volume || 0),
      };
    }).filter(function(b) { return isFinite(b.H) && isFinite(b.L); });
    return { ok: true, bars: bars };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =============================================================================
// STRAT BAR HELPERS
// =============================================================================

function stratNumber(bar, prev) {
  if (!prev) return null;
  var hHigh = bar.H > prev.H;
  var lLow = bar.L < prev.L;
  if (hHigh && lLow) return '3';        // outside
  if (hHigh && !lLow) return '2U';
  if (!hHigh && lLow) return '2D';
  return '1';                            // inside
}

function isInside(bar, prev) { return stratNumber(bar, prev) === '1'; }
function isOutside(bar, prev) { return stratNumber(bar, prev) === '3'; }
function is2U(bar, prev) { return stratNumber(bar, prev) === '2U'; }
function is2D(bar, prev) { return stratNumber(bar, prev) === '2D'; }

// =============================================================================
// STRATEGY 1: 12HR MIYAGI (1-3-1 sequence + 50% trigger)
//
// 12HR session bars (4PM ET start, 4AM ET start). We aggregate 60-min bars
// into 12HR sessions:
//   Session A: 4AM ET → 4PM ET (12 hours including RTH)
//   Session B: 4PM ET → 4AM ET (12 hours overnight)
//
// Look at last 4 closed sessions:
//   Sess[N-3] = 1st  (must be inside / 1)
//   Sess[N-2] = 2nd  (must be outside / 3)
//   Sess[N-1] = 3rd  (must be inside / 1) → trigger candle
//   Sess[N]   = 4th  (live)              → 2U/2D direction sets play
//
// Trigger = 50% of 3rd candle (high+low)/2
// 2U direction → at 9:30 if price ABOVE trigger → PUTS
// 2D direction → at 9:30 if price BELOW trigger → CALLS
// =============================================================================

function aggregateTo12HR(bars60m) {
  var sessions = [];
  var current = null;

  bars60m.forEach(function(b) {
    var hour = etHour(b.t);
    // Session anchor: 4 AM ET (starts session A) or 4 PM ET (starts session B = 16)
    var isAnchor = hour === 4 || hour === 16;
    if (isAnchor || !current) {
      if (current) sessions.push(current);
      current = { t: b.t, O: b.O, H: b.H, L: b.L, C: b.C, V: b.V, anchor: hour };
    } else {
      current.H = Math.max(current.H, b.H);
      current.L = Math.min(current.L, b.L);
      current.C = b.C;
      current.V += b.V;
    }
  });
  if (current) sessions.push(current);
  return sessions;
}

function detectMiyagi(bars60m, currentSpot) {
  var sessions = aggregateTo12HR(bars60m);
  if (sessions.length < 4) return null;

  // We need the LAST 4 sessions: 3 closed + 1 live
  var n = sessions.length;
  var s1 = sessions[n - 4];  // 1st (Inside expected)
  var s2 = sessions[n - 3];  // 2nd (Outside expected)
  var s3 = sessions[n - 2];  // 3rd (Inside expected) — TRIGGER CANDLE
  var s4 = sessions[n - 1];  // 4th (live)

  // Compute strat numbers
  var s2Type = stratNumber(s2, s1);
  var s3Type = stratNumber(s3, s2);
  var s4Type = stratNumber(s4, s3);

  // Pattern check: 1-3-1
  var firstIsInside = stratNumber(s1, sessions[n - 5] || s1) === '1' || true; // s1 strict check optional
  if (s2Type !== '3') return null;
  if (s3Type !== '1') return null;

  // Trigger = 50% of 3rd candle
  var trigger = (s3.H + s3.L) / 2;

  // 4th candle direction
  var direction, status, entry, stop, T1, T2;
  if (s4Type === '2U') {
    // PUTS setup — need spot ABOVE trigger at 9:30
    direction = 'short';
    if (currentSpot > trigger) status = 'live-armed';
    else status = 'pending-spot';
    entry = trigger; // entry zone
    stop = s2.H;     // 60-min flip backstop
    T1 = s3.L;       // low of inside bar
    T2 = s2.L;       // low of outside bar
  } else if (s4Type === '2D') {
    direction = 'long';
    if (currentSpot < trigger) status = 'live-armed';
    else status = 'pending-spot';
    entry = trigger;
    stop = s2.L;
    T1 = s3.H;
    T2 = s2.H;
  } else if (s4Type === '3') {
    return { detected: true, name: 'Miyagi', status: 'invalidated-3rd-bar-became-3', detail: '3rd-candle (1-bar) became outside (3) — setup INVALID' };
  } else {
    return { detected: false, reason: '4th candle is ' + s4Type + ' — must be 2U or 2D' };
  }

  return {
    detected: true,
    name: 'Miyagi-12HR',
    direction: direction,
    status: status,
    trigger: round2(trigger),
    entry: round2(entry),
    stop: round2(stop),
    T1: round2(T1),
    T2: round2(T2),
    structure: {
      s1: { time: s1.t, OHLC: [s1.O, s1.H, s1.L, s1.C] },
      s2: { time: s2.t, OHLC: [s2.O, s2.H, s2.L, s2.C], strat: s2Type },
      s3: { time: s3.t, OHLC: [s3.O, s3.H, s3.L, s3.C], strat: s3Type },
      s4_live: { time: s4.t, OHLC: [s4.O, s4.H, s4.L, s4.C], strat: s4Type },
    },
    thesis: '1-3-1 sequence detected. 4th candle is ' + s4Type + ', looking for ' +
            (direction === 'long' ? 'CALLS' : 'PUTS') + ' on ' + (direction === 'long' ? 'break BELOW' : 'break ABOVE') +
            ' $' + round2(trigger) + ' at 9:30 bell.',
  };
}

// =============================================================================
// STRATEGY 2: 4HR RE-TRIGGER (2-2 Reversal)
//
// 4AM ET bias candle + 8AM ET reversal candle. Entry at 9:30 on break of 4AM h/l.
// CALLS: 4AM=2D, 8AM=2U (reversed), retraced below 8AM trigger by 9:30
// PUTS:  4AM=2U, 8AM=2D (reversed), retraced above 8AM trigger by 9:30
// =============================================================================

function aggregateTo4HR(bars60m) {
  var blocks = [];
  var current = null;
  bars60m.forEach(function(b) {
    var hour = etHour(b.t);
    // 4HR anchors: 4 AM, 8 AM, 12 PM, 4 PM, 8 PM, 12 AM (every 4 hrs)
    var isAnchor = (hour % 4) === 0;
    if (isAnchor || !current) {
      if (current) blocks.push(current);
      current = { t: b.t, O: b.O, H: b.H, L: b.L, C: b.C, V: b.V, anchorHour: hour };
    } else {
      current.H = Math.max(current.H, b.H);
      current.L = Math.min(current.L, b.L);
      current.C = b.C;
      current.V += b.V;
    }
  });
  if (current) blocks.push(current);
  return blocks;
}

function detect4HRRetrigger(bars60m, currentSpot, prevDay4PMCandle) {
  var blocks = aggregateTo4HR(bars60m);
  if (blocks.length < 4) return null;

  // Find this morning's 4AM and 8AM blocks
  var today = etDate(new Date().toISOString());
  var b4am = null, b8am = null;
  for (var i = blocks.length - 1; i >= 0 && i >= blocks.length - 8; i--) {
    var blk = blocks[i];
    if (etDate(blk.t) !== today) continue;
    if (blk.anchorHour === 4 && !b4am) b4am = { idx: i, blk: blk };
    if (blk.anchorHour === 8 && !b8am) b8am = { idx: i, blk: blk };
  }
  if (!b4am || !b8am) return null;

  var prev4am = blocks[b4am.idx - 1]; // bar before 4am
  var prev8am = blocks[b8am.idx - 1];

  var s4am = stratNumber(b4am.blk, prev4am);
  var s8am = stratNumber(b8am.blk, prev8am);

  if (s4am === '2D' && s8am === '2U') {
    // CALLS reversal setup
    // 9:30 filter: spot still BELOW 4AM high (didn't break out yet)
    var valid = currentSpot < b4am.blk.H;
    return {
      detected: true,
      name: '4HR-Retrigger',
      direction: 'long',
      status: valid ? 'armed' : 'invalid-already-broke-4am-high',
      trigger: round2(b4am.blk.H),
      stop: round2(b4am.blk.L),
      T1: prevDay4PMCandle ? round2(prevDay4PMCandle.H) : null,
      structure: { '4am': s4am, '8am': s8am, '4amH': b4am.blk.H, '4amL': b4am.blk.L },
      thesis: '2D→2U reversal. ENTER CALLS on break ABOVE 4AM high $' + round2(b4am.blk.H),
    };
  }
  if (s4am === '2U' && s8am === '2D') {
    // PUTS reversal setup
    var validP = currentSpot > b4am.blk.L;
    return {
      detected: true,
      name: '4HR-Retrigger',
      direction: 'short',
      status: validP ? 'armed' : 'invalid-already-broke-4am-low',
      trigger: round2(b4am.blk.L),
      stop: round2(b4am.blk.H),
      T1: prevDay4PMCandle ? round2(prevDay4PMCandle.L) : null,
      structure: { '4am': s4am, '8am': s8am, '4amH': b4am.blk.H, '4amL': b4am.blk.L },
      thesis: '2U→2D reversal. ENTER PUTS on break BELOW 4AM low $' + round2(b4am.blk.L),
    };
  }

  return null;
}

// =============================================================================
// STRATEGY 3: 3-2-2 FIRST LIVE (1HR)
//
// 8AM = outside (3), 9AM = 2U or 2D, 10AM = REVERSAL execution
// 9AM 2U → 10AM enters PUTS on break below 9AM low
// 9AM 2D → 10AM enters CALLS on break above 9AM high
// PT = high/low of 8AM 3-bar
// =============================================================================

function detect322FirstLive(bars60m, currentSpot) {
  var today = etDate(new Date().toISOString());
  // Find today's 8AM, 9AM, 10AM hour bars
  var b8 = null, b9 = null, b10 = null;
  for (var i = bars60m.length - 1; i >= 0 && i >= bars60m.length - 30; i--) {
    var b = bars60m[i];
    if (etDate(b.t) !== today) continue;
    var hr = etHour(b.t);
    if (hr === 8 && !b8) b8 = { idx: i, bar: b };
    if (hr === 9 && !b9) b9 = { idx: i, bar: b };
    if (hr === 10 && !b10) b10 = { idx: i, bar: b };
  }
  if (!b8 || !b9) return null;

  var prev8 = bars60m[b8.idx - 1];
  var prev9 = bars60m[b9.idx - 1];
  var s8 = stratNumber(b8.bar, prev8);
  var s9 = stratNumber(b9.bar, prev9);

  if (s8 !== '3') return null;
  if (s9 !== '2U' && s9 !== '2D') return null;

  if (s9 === '2D') {
    // CALLS reversal — enter on break ABOVE 9AM high during 10AM hour
    var triggered10am = b10 && b10.bar.H > b9.bar.H;
    return {
      detected: true,
      name: '3-2-2-First-Live',
      direction: 'long',
      status: triggered10am ? 'live-fired' : (b10 ? 'armed-10am-active' : 'pending-10am'),
      trigger: round2(b9.bar.H),
      stop: round2(b9.bar.L),
      T1: round2(b8.bar.H),
      structure: { '8am': '3', '9am': s9, '8amH': b8.bar.H, '8amL': b8.bar.L, '9amH': b9.bar.H, '9amL': b9.bar.L },
      thesis: '8AM 3-bar + 9AM 2D reversal. ENTER CALLS on 10AM hour break ABOVE $' + round2(b9.bar.H),
    };
  } else {
    // PUTS — enter on break BELOW 9AM low during 10AM hour
    var triggered = b10 && b10.bar.L < b9.bar.L;
    return {
      detected: true,
      name: '3-2-2-First-Live',
      direction: 'short',
      status: triggered ? 'live-fired' : (b10 ? 'armed-10am-active' : 'pending-10am'),
      trigger: round2(b9.bar.L),
      stop: round2(b9.bar.H),
      T1: round2(b8.bar.L),
      structure: { '8am': '3', '9am': s9, '8amH': b8.bar.H, '8amL': b8.bar.L, '9amH': b9.bar.H, '9amL': b9.bar.L },
      thesis: '8AM 3-bar + 9AM 2U reversal. ENTER PUTS on 10AM hour break BELOW $' + round2(b9.bar.L),
    };
  }
}

// =============================================================================
// STRATEGY 4: 7HR LIQUIDITY SWEEP (QQQ-primary)
//
// 9PM ET = inside (1) bar, 4AM ET = outside (3) bar (pre-market session)
// Mark high/low/midpoint of 4AM 3-bar
// AFTER 11AM ET, look for sweep + retest on 5/15m TF
// =============================================================================

function aggregateTo7HR(bars60m) {
  // 7HR anchor: 9PM ET → 4AM ET = 7 hours; 4AM → 11AM = 7 hours
  // We want the 4AM 3-bar (pre-market session) — anchor at 4AM, span 7hrs (covers 4AM-11AM)
  var blocks = [];
  var current = null;
  bars60m.forEach(function(b) {
    var hour = etHour(b.t);
    var isAnchor = hour === 4 || hour === 11 || hour === 18 || hour === 21;
    if (isAnchor || !current) {
      if (current) blocks.push(current);
      current = { t: b.t, O: b.O, H: b.H, L: b.L, C: b.C, V: b.V, anchorHour: hour };
    } else {
      current.H = Math.max(current.H, b.H);
      current.L = Math.min(current.L, b.L);
      current.C = b.C;
      current.V += b.V;
    }
  });
  if (current) blocks.push(current);
  return blocks;
}

function detect7HRSweep(bars60m, currentSpot, ticker) {
  // QQQ-primary
  if (ticker !== 'QQQ' && ticker !== 'SPY') return null;

  var blocks = aggregateTo7HR(bars60m);
  if (blocks.length < 3) return null;

  var today = etDate(new Date().toISOString());
  var b4am = null, b9pm_prev = null;
  for (var i = blocks.length - 1; i >= 0 && i >= blocks.length - 8; i--) {
    var blk = blocks[i];
    if (blk.anchorHour === 4 && etDate(blk.t) === today && !b4am) b4am = blk;
    if (blk.anchorHour === 21 && !b9pm_prev) b9pm_prev = blk;
  }
  if (!b4am || !b9pm_prev) return null;

  var s4am = stratNumber(b4am, b9pm_prev);
  var s9pm = stratNumber(b9pm_prev, blocks[blocks.indexOf(b9pm_prev) - 1] || b9pm_prev);

  if (s4am !== '3') return null;

  // Mark levels
  var range_high = b4am.H;
  var range_low = b4am.L;
  var midpoint = (range_high + range_low) / 2;

  var nowET = etHour(new Date().toISOString());
  var afterEleven = nowET >= 11;

  return {
    detected: true,
    name: '7HR-Liquidity-Sweep',
    direction: 'pending-sweep',
    status: afterEleven ? 'window-open-watch-5m' : 'window-pending-11am',
    trigger_high: round2(range_high),
    trigger_low: round2(range_low),
    midpoint_PT1: round2(midpoint),
    stop_above: round2(range_high),
    stop_below: round2(range_low),
    thesis: 'QQQ 1-3 sweep. AFTER 11AM ET drop to 5/15m. Sweep ABOVE $' + round2(range_high) +
            ' → enter PUTS (failed breakout). Sweep BELOW $' + round2(range_low) +
            ' → enter CALLS (failed breakdown). PT1 = midpoint $' + round2(midpoint),
  };
}

// =============================================================================
// STRATEGY 5: FAILED 9 (1HR Market Open Reversal — SPY/QQQ)
//
// 8AM session candle: mark H, L, 50%
// 9AM candle: must be 2U or 2D BEFORE market open (9:30)
// At 9:30 open: 9AM must trigger 50% of 8AM
// 9AM=2U + open ABOVE 50% put trigger → wait pullback to 50% → PUTS
// 9AM=2D + open BELOW 50% call trigger → wait push to 50% → CALLS
// =============================================================================

function detectFailed9(bars60m, currentSpot) {
  var today = etDate(new Date().toISOString());
  var b8 = null, b9 = null;
  for (var i = bars60m.length - 1; i >= 0 && i >= bars60m.length - 30; i--) {
    var b = bars60m[i];
    if (etDate(b.t) !== today) continue;
    var hr = etHour(b.t);
    if (hr === 8 && !b8) b8 = b;
    if (hr === 9 && !b9) b9 = b;
  }
  if (!b8 || !b9) return null;

  var prev9 = bars60m[bars60m.indexOf(b9) - 1];
  var s9 = stratNumber(b9, prev9);

  if (s9 === '1' || s9 === '3') {
    return { detected: true, name: 'Failed-9', status: 'invalidated', detail: '9AM is ' + s9 + ' — must be 2U or 2D' };
  }
  if (s9 !== '2U' && s9 !== '2D') return null;

  var midpoint8 = (b8.H + b8.L) / 2;

  if (s9 === '2U') {
    // PUTS setup — at open, spot must be ABOVE 50% put trigger
    if (currentSpot < midpoint8) return { detected: true, name: 'Failed-9', status: 'invalidated', detail: '9AM 2U but spot below 8AM 50% — invalid' };
    return {
      detected: true,
      name: 'Failed-9',
      direction: 'short',
      status: 'armed',
      trigger: round2(midpoint8),
      stop: round2(b9.H),
      T1: round2(b8.L),
      structure: { '8am': { H: b8.H, L: b8.L, mid: midpoint8 }, '9am': s9 },
      thesis: '9AM 2U + spot above 8AM 50%. Wait for pullback to $' + round2(midpoint8) + ' → ENTER PUTS',
    };
  } else {
    // 2D → CALLS setup — at open, spot must be BELOW 50% call trigger
    if (currentSpot > midpoint8) return { detected: true, name: 'Failed-9', status: 'invalidated', detail: '9AM 2D but spot above 8AM 50% — invalid' };
    return {
      detected: true,
      name: 'Failed-9',
      direction: 'long',
      status: 'armed',
      trigger: round2(midpoint8),
      stop: round2(b9.L),
      T1: round2(b8.H),
      structure: { '8am': { H: b8.H, L: b8.L, mid: midpoint8 }, '9am': s9 },
      thesis: '9AM 2D + spot below 8AM 50%. Wait for push up to $' + round2(midpoint8) + ' → ENTER CALLS',
    };
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

async function scanTicker(ticker, opts) {
  opts = opts || {};
  var token = opts.token;
  if (!token && ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ticker: ticker, ok: false, error: 'no-token' };

  // Pull 60-min bars with extended hours, 200 bars back (~8 days of 24hr data)
  var fetched = await fetchBars(ticker, { token: token, unit: 'Minute', interval: 60, barsback: 250, session: 'USEQPreAndPost' });
  if (!fetched.ok) return { ticker: ticker, ok: false, error: fetched.error };
  var bars60m = fetched.bars;
  if (!bars60m || bars60m.length < 24) return { ticker: ticker, ok: false, error: 'insufficient-bars' };

  var currentSpot = bars60m[bars60m.length - 1].C;

  // Run all 5 detectors
  var results = [];
  try { var m = detectMiyagi(bars60m, currentSpot); if (m && m.detected) results.push(m); } catch (e) { results.push({ name: 'Miyagi-12HR', error: e.message }); }
  try { var r4 = detect4HRRetrigger(bars60m, currentSpot, null); if (r4 && r4.detected) results.push(r4); } catch (e) { results.push({ name: '4HR-Retrigger', error: e.message }); }
  try { var r322 = detect322FirstLive(bars60m, currentSpot); if (r322 && r322.detected) results.push(r322); } catch (e) { results.push({ name: '3-2-2-First-Live', error: e.message }); }
  try { var sw = detect7HRSweep(bars60m, currentSpot, ticker); if (sw && sw.detected) results.push(sw); } catch (e) { results.push({ name: '7HR-Sweep', error: e.message }); }
  try { var f9 = detectFailed9(bars60m, currentSpot); if (f9 && f9.detected) results.push(f9); } catch (e) { results.push({ name: 'Failed-9', error: e.message }); }

  return {
    ticker: ticker,
    ok: true,
    spot: round2(currentSpot),
    barCount: bars60m.length,
    strategies: results,
    scannedAt: new Date().toISOString(),
  };
}

async function scanUniverse(opts) {
  opts = opts || {};
  var universe = opts.universe || DEFAULT_UNIVERSE;
  var token = null;
  if (ts && ts.getAccessToken) {
    try { token = await ts.getAccessToken(); } catch (e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };

  var hits = [];
  var errors = [];
  for (var i = 0; i < universe.length; i++) {
    var t = universe[i];
    try {
      var res = await scanTicker(t, { token: token });
      if (res.ok && res.strategies && res.strategies.length > 0) {
        hits.push(res);
      }
    } catch (e) {
      errors.push({ ticker: t, error: e.message });
    }
  }

  var out = {
    ok: true,
    scannedAt: new Date().toISOString(),
    universeSize: universe.length,
    hits: hits,
    errors: errors,
  };
  try { fs.writeFileSync(LAST_FILE, JSON.stringify(out, null, 2)); } catch (e) {}
  return out;
}

function loadLast() {
  try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); }
  catch (e) { return { ok: false, error: 'no-scan-yet' }; }
}

module.exports = {
  scanTicker: scanTicker,
  scanUniverse: scanUniverse,
  loadLast: loadLast,
  // detectors exposed for testing
  detectMiyagi: detectMiyagi,
  detect4HRRetrigger: detect4HRRetrigger,
  detect322FirstLive: detect322FirstLive,
  detect7HRSweep: detect7HRSweep,
  detectFailed9: detectFailed9,
  // helpers
  aggregateTo12HR: aggregateTo12HR,
  aggregateTo4HR: aggregateTo4HR,
  etHour: etHour,
  etDate: etDate,
};
