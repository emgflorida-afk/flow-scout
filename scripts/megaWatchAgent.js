#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// MEGA WATCH AGENT — A+ Setup Hunter (May 6 PM 2026)
// =============================================================================
// Dedicated vision + GEX agent that runs ONLY on AB's MEGA watchlist (9 names):
//   META, AAPL, GOOGL, AMZN, MSFT, NVDA, IWM, SPY, AMD
//
// Runs a 5-minute loop during RTH. For each ticker (sequential — TV CDP is
// single-instance), pulls live spot, runs chart-vision on 6HR + 4HR, computes
// king-node / GEX context, pushes verdict to Railway cache, AND fires a
// Discord card if ALL A+ criteria hit:
//
//   - Vision verdict APPROVE on BOTH 6HR and 4HR
//   - Confidence >= 7 on at least one TF
//   - GEX regime POSITIVE (long) or NEGATIVE (short)
//   - Direction agrees with tape (SPY pctChange same sign as ticker direction)
//   - Spot within 1% of king node (magnet pulls toward setup)
//
// SEPARATE from visionDaemon.js — no shared state. Reads same chart-vision.sh
// and kingNodeComputer modules. Alert-only (no auto-fire).
//
// AB context: scanner-v2 ships a MEGA tab (commit f0b1a82). AB asked for "1
// agent that focuses on A+ setup for this." This is that agent.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MEGA_WATCHLIST = ['META','AAPL','GOOGL','AMZN','MSFT','NVDA','IWM','SPY','AMD'];

const RAILWAY_BASE = process.env.FLOW_SCOUT_BASE || 'https://flow-scout-production.up.railway.app';
const REPO_ROOT = process.env.FLOW_SCOUT_ROOT || path.resolve(__dirname, '..');
const CHART_VISION_SH = path.join(REPO_ROOT, 'scripts', 'chart-vision.sh');

const LOOP_INTERVAL_MS = parseInt(process.env.MEGA_AGENT_INTERVAL_MS || String(5 * 60 * 1000), 10);
const DEDUP_MIN = parseInt(process.env.MEGA_DEDUP_MIN || '30', 10);
const DEDUP_MS = DEDUP_MIN * 60 * 1000;
const QUIET_OUTSIDE_MARKET = process.env.QUIET_OUTSIDE_MARKET !== 'false';

// Per-vision-shell cap (chart-vision.sh = 8s wait + 2 TV calls + Claude review)
const VISION_RUN_TIMEOUT_MS = 90 * 1000;
// Sleep between tickers — let TV CDP cool between renders
const TICKER_SLEEP_MS = 2000;

// Tape direction threshold — SPY pct must exceed this to count as a real tape
const TAPE_FLAT_THRESHOLD = 0.05;
// Ticker move threshold — below this we skip vision (no clear bias)
const TICKER_BIAS_THRESHOLD = 0.30;

// A+ criteria
const APLUS_MIN_CONFIDENCE = 7;
const APLUS_MAX_KING_DIST_PCT = 1.0;

// Bar-close-trigger criteria (separate, faster signal layer)
const BAR_VOL_MULT = 1.5;          // latest vol > 1.5× avg of prior 10
const BAR_BODY_FRAC = 0.5;         // body in upper/lower 50% of bar range
const BAR_DEDUP_MIN = 15;          // 15-min dedup per ticker+direction
const BAR_DEDUP_MS = BAR_DEDUP_MIN * 60 * 1000;

// MAY 6 2026 PM — SPLIT CHANNELS (AB: "everything going into one channel")
// BAR-CLOSE TRIGGERS  → STRATUMBREAK channel (live break-of-structure)
// MEGA A+ ALERTS      → STRATUMSWING channel (full-stack swing entries)
// Each can be overridden via env. Default fallbacks point to AB's existing
// real Stratum channels so nothing crashes if env not set.
const DISCORD_BAR_WEBHOOK = process.env.DISCORD_BAR_WEBHOOK ||
  process.env.DISCORD_STRATUMBREAK_WEBHOOK ||
  'https://discord.com/api/webhooks/1494836833778008205/j4x9WUFHV1mwUz2SndnxgAFLHhCrUcClU-2AJEGjojy_0i6yHgyFt5QuHxmBLZeUiiPI';
const DISCORD_APLUS_WEBHOOK = process.env.DISCORD_MEGA_WEBHOOK ||
  process.env.DISCORD_STRATUMSWING_WEBHOOK ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';
// Backward-compat alias used by older callsites in this file
const DISCORD_WEBHOOK = DISCORD_APLUS_WEBHOOK;
const RAILWAY_BASE_FOR_QUOTES = process.env.RAILWAY_BASE_URL ||
  'https://flow-scout-production.up.railway.app';

// MAY 6 2026 PM — REAL NUMBERS (AB: "it needs to have real numbers")
// Pull live bid/ask/mid for the suggested option contract at trade time so
// cards show actual fills, not estimates. Returns { strike, mid, bid, ask, last, vol, oi }
// or null if unavailable.
async function getSuggestedContract(ticker, direction, spot, dteDays) {
  try {
    // Pick strike: ATM for delta ~0.45, +5 for ~0.30, +10 for ~0.18
    const isLong = String(direction || '').toLowerCase() === 'long' || String(direction || '').toLowerCase() === 'call';
    const strikeStep = spot < 50 ? 1 : spot < 100 ? 1 : spot < 250 ? 2.5 : spot < 500 ? 5 : 10;
    const baseStrike = Math.round(spot / strikeStep) * strikeStep;
    const wantStrikes = isLong
      ? [baseStrike, baseStrike + strikeStep, baseStrike + 2 * strikeStep]
      : [baseStrike, baseStrike - strikeStep, baseStrike - 2 * strikeStep];
    // Build OSI symbols — find next Friday at least dteDays out
    const target = new Date(Date.now() + (dteDays || 9) * 24 * 60 * 60 * 1000);
    while (target.getDay() !== 5) target.setDate(target.getDate() + 1);
    const yymmdd = target.getFullYear().toString().slice(2) + String(target.getMonth() + 1).padStart(2, '0') + String(target.getDate()).padStart(2, '0');
    const cp = isLong ? 'C' : 'P';
    const syms = wantStrikes.map(s => `${ticker} ${yymmdd}${cp}${Math.round(s)}`);
    const url = `${RAILWAY_BASE_FOR_QUOTES}/api/option-mids?symbols=${encodeURIComponent(syms.join(','))}`;
    const r = await getJson(url, { timeoutMs: 8000 });
    if (!r || !r.quotes || !r.quotes.length) return null;
    // Pick the one with valid bid/ask AND mid > 0.50 (avoid worthless contracts)
    const valid = r.quotes.find(q => q.mid && Number(q.mid) > 0.5 && q.bid && q.ask);
    if (!valid) return null;
    const strikeMatch = (valid.symbol || '').match(/[CP](\d+)$/);
    const strike = strikeMatch ? Number(strikeMatch[1]) : null;
    return {
      symbol: valid.symbol,
      strike: strike,
      expiry: target.toISOString().slice(0, 10),
      mid: Number(valid.mid),
      bid: Number(valid.bid),
      ask: Number(valid.ask),
      last: Number(valid.last),
      vol: valid.volume,
      oi: valid.openInterest,
      breakeven: isLong ? (strike + Number(valid.mid)) : (strike - Number(valid.mid)),
    };
  } catch (e) {
    return null;
  }
}

// kingNodeComputer — pull GEX context. Fail-open if module missing.
let kingNodeComputer = null;
try {
  kingNodeComputer = require(path.join(__dirname, '..', 'src', 'kingNodeComputer'));
} catch (e) {
  console.log('[MEGA-AGENT] kingNodeComputer not loaded (will skip GEX context):', e.message);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] [MEGA-AGENT] ${msg}` +
    (extra ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '');
  console.log(line);
}

// ---------------------------------------------------------------------------
// FETCH HELPER
// ---------------------------------------------------------------------------
const fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

async function getJson(url, opts) {
  opts = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  try {
    const r = await fetchLib(url, { signal: ctrl.signal, headers: opts.headers || {} });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

async function postJson(url, body, opts) {
  opts = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  try {
    const r = await fetchLib(url, {
      method: opts.method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: data };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// ---------------------------------------------------------------------------
// MARKET HOURS — RTH 09:30-16:00 ET, M-F (no holiday calendar)
// ---------------------------------------------------------------------------
function isMarketHours() {
  if (!QUIET_OUTSIDE_MARKET) return true;
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const m = etStr.match(/^(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+):(\d+)/);
  if (!m) return true;
  const dow = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getDay();
  if (dow === 0 || dow === 6) return false;
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const minutesIntoDay = hour * 60 + min;
  // 09:30 ET = 570 min, 16:00 ET = 960 min
  return minutesIntoDay >= 570 && minutesIntoDay <= 960;
}

// ---------------------------------------------------------------------------
// VISION SHELL RUNNER (mirrors visionDaemon pattern)
// ---------------------------------------------------------------------------
function parseVisionOutput(stdout) {
  const verdict = (stdout.match(/VERDICT:\s*([A-Z]+)/) || [])[1] || null;
  const conf = parseInt((stdout.match(/confidence:\s*(\d+)/) || [])[1] || '0', 10);
  const primary = (stdout.match(/PRIMARY REASON:\s*(.+)/) || [])[1] || null;
  const structAlign = (stdout.match(/STRUCTURAL ALIGNMENT:\s*(.+)/) || [])[1] || null;
  const patternIntegrity = (stdout.match(/PATTERN INTEGRITY:\s*(.+)/) || [])[1] || null;
  return {
    verdict: verdict,
    confidence: conf,
    summary: primary || structAlign || 'no summary',
    structuralAlignment: structAlign,
    patternIntegrity: patternIntegrity,
  };
}

function runVisionShell(ticker, direction, tf, extraEnv) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CHART_VISION_SH)) {
      return resolve({ ok: false, error: 'chart-vision.sh missing at ' + CHART_VISION_SH });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('bash', [CHART_VISION_SH, ticker, direction, tf], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, extraEnv || {}),
    });
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, VISION_RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) return resolve({ ok: false, error: 'vision shell timeout' });
      if (code !== 0) return resolve({ ok: false, error: 'shell exit ' + code, stderr: stderr.slice(0, 200) });
      const parsed = parseVisionOutput(stdout);
      if (!parsed.verdict) return resolve({ ok: false, error: 'no verdict parsed' });
      resolve({ ok: true, parsed: parsed });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, error: e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// GEX CONTEXT — wraps kingNodeComputer with summary + agreement logic
// (lifted from visionDaemon Phase 4.42 pattern, kept self-contained)
// ---------------------------------------------------------------------------
async function getGexContext(ticker, direction) {
  const fallback = {
    available: false,
    totalNetGex: null,
    regime: null,
    kingNode: null,
    spot: null,
    distPct: null,
    agreesWithDirection: null,
    summary: 'GEX data unavailable',
  };
  // MAY 6 2026 PM — use Railway proxy /api/gex/:ticker (has working TS auth)
  // instead of local kingNodeComputer (needs local TS env vars AB doesn't have).
  // Railway endpoint returns: spot, totalGEX, regime, kingNodes[], callWall, putWall
  try {
    const gexRes = await getJson(`${RAILWAY_BASE}/api/gex/${encodeURIComponent(ticker)}`, { timeoutMs: 12000 });
    if (!gexRes || !gexRes.spot || !Array.isArray(gexRes.kingNodes) || !gexRes.kingNodes.length) {
      return Object.assign({}, fallback, { summary: 'GEX data unavailable: no candidates' });
    }
    // Pick highest |netGex| king node as the magnet
    const king = gexRes.kingNodes.slice().sort((a, b) => Math.abs(b.netGex || 0) - Math.abs(a.netGex || 0))[0];
    if (!king || king.strike == null) {
      return Object.assign({}, fallback, { summary: 'GEX data unavailable: no king node' });
    }
    const spot = Number(gexRes.spot);
    const k = Number(king.strike);
    if (!isFinite(spot) || !isFinite(k) || k === 0) return fallback;

    const totalNetGex = isFinite(gexRes.totalGEX) ? Number(gexRes.totalGEX) : null;
    const regime = gexRes.regime || null;
    const distPct = +(((spot - k) / k) * 100).toFixed(2);
    const absDist = Math.abs(distPct);
    const above = spot > k;
    const dir = String(direction || '').toLowerCase();
    const isLong = dir === 'long' || dir === 'call' || dir === 'bullish';
    const isShort = dir === 'short' || dir === 'put' || dir === 'bearish';

    let agreesWithDirection = null;
    const positiveRegime = regime === 'POSITIVE' || (totalNetGex != null && totalNetGex > 0 && regime !== 'NEGATIVE' && regime !== 'FLIPPED');

    if (absDist <= 0.5) {
      agreesWithDirection = null;
    } else if (positiveRegime) {
      if (isLong) agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
      else if (isShort) agreesWithDirection = above ? true : (absDist > 2 ? false : null);
    } else {
      if (isLong) agreesWithDirection = above ? true : (absDist > 2 ? false : null);
      else if (isShort) agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
    }

    const gexFmt = (totalNetGex != null)
      ? (totalNetGex >= 0 ? '+' : '') + '$' + (totalNetGex / 1e6).toFixed(1) + 'M'
      : '?';
    const regimeLbl = regime || (totalNetGex != null ? (totalNetGex >= 0 ? 'POSITIVE' : 'NEGATIVE') : 'UNKNOWN');
    const sideLbl = above ? 'above' : 'below';
    const agreeLbl = agreesWithDirection === true ? 'agrees with ' + (isLong ? 'LONG' : 'SHORT')
                   : agreesWithDirection === false ? 'fights ' + (isLong ? 'LONG' : 'SHORT')
                   : 'neutral';
    const summary = `${regimeLbl} gamma ${gexFmt}, $${k.toFixed(2)} magnet ${absDist.toFixed(1)}% ${sideLbl} spot, ${agreeLbl}`;

    return {
      available: true,
      totalNetGex: totalNetGex,
      regime: regimeLbl,
      kingNode: +k.toFixed(4),
      spot: +spot.toFixed(4),
      distPct: distPct,
      agreesWithDirection: agreesWithDirection,
      summary: summary,
    };
  } catch (e) {
    return Object.assign({}, fallback, { summary: 'GEX error: ' + String(e.message || e).slice(0, 80) });
  }
}

// ---------------------------------------------------------------------------
// LIVE TAPE — SPY pct change
// ---------------------------------------------------------------------------
let _spyCache = { ts: 0, pct: null };
async function getSpyPct() {
  if (Date.now() - _spyCache.ts < 60000 && _spyCache.pct != null) return _spyCache.pct;
  const r = await getJson(`${RAILWAY_BASE}/api/ticker-quote?symbols=SPY`, { timeoutMs: 8000 });
  if (!r || !r.ok || !r.quotes || !r.quotes.length) return null;
  const pct = r.quotes[0].pctChange;
  if (typeof pct === 'number') {
    _spyCache = { ts: Date.now(), pct: pct };
    return pct;
  }
  return null;
}

async function getTickerQuote(ticker) {
  const r = await getJson(`${RAILWAY_BASE}/api/ticker-quote?symbols=${encodeURIComponent(ticker)}`, { timeoutMs: 8000 });
  if (!r || !r.ok || !r.quotes || !r.quotes.length) return null;
  return r.quotes[0]; // { symbol, last, prevClose, pctChange }
}

// ---------------------------------------------------------------------------
// PUSH VERDICT TO RAILWAY CACHE
// ---------------------------------------------------------------------------
async function pushVerdictToRailway(payload) {
  const url = `${RAILWAY_BASE}/api/chart-vision/cache`;
  const r = await postJson(url, payload, { method: 'PUT', timeoutMs: 8000 });
  if (!r.ok) {
    log('WARN', `cache push fail ${payload.ticker}|${payload.direction}: ${r.error || r.status}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DISCORD ALERT
// ---------------------------------------------------------------------------
async function buildDiscordCard(ctx) {
  const {
    ticker, direction, spot, pctChange,
    higher, lower, gex, spyPct,
  } = ctx;
  const dirLabel = direction === 'long' ? 'LONG' : 'SHORT';
  const optType = direction === 'long' ? 'C' : 'P';
  const triggerOp = direction === 'long' ? 'above' : 'below';

  // Trigger price = current candle direction extension (5m structural)
  const triggerStep = spot * 0.0015;
  const triggerPrice = direction === 'long' ? spot + triggerStep : spot - triggerStep;

  const gexLine = gex.available
    ? `${gex.regime} ${gex.totalNetGex != null ? ((gex.totalNetGex >= 0 ? '+' : '') + '$' + (gex.totalNetGex/1e6).toFixed(1) + 'M') : '?'}, magnet $${gex.kingNode} (${gex.distPct >= 0 ? '+' : ''}${gex.distPct}% from spot)`
    : 'GEX unavailable';

  const tapeLine = (spyPct != null)
    ? `SPY ${spyPct >= 0 ? '+' : ''}${spyPct}% (${(direction === 'long' && spyPct > 0) || (direction === 'short' && spyPct < 0) ? 'with you' : 'against you'})`
    : 'SPY tape unknown';

  const hiSummary = String(higher.summary || '').slice(0, 100);
  const loSummary = String(lower.summary || '').slice(0, 100);

  // MAY 6 2026 PM — REAL CONTRACT NUMBERS (AB explicit ask)
  let contractLines = [`Suggested: ${ticker} 5/22 ATM ${optType} delta ~0.40`];
  const sc = await getSuggestedContract(ticker, direction, spot, 9);
  if (sc) {
    const cost1ct = (sc.mid * 100).toFixed(0);
    const stop = (sc.mid * 0.80).toFixed(2);
    const tp = (sc.mid * 1.50).toFixed(2);
    contractLines = [
      `Contract: **${ticker} ${sc.expiry} $${sc.strike}${optType}**`,
      `Mid $${sc.mid.toFixed(2)} (bid $${sc.bid.toFixed(2)} / ask $${sc.ask.toFixed(2)}) · vol ${sc.vol} · OI ${sc.oi}`,
      `Cost 1ct: **$${cost1ct}** · Breakeven: $${sc.breakeven.toFixed(2)}`,
      `Bracket: TP $${tp} (+50%) / Stop $${stop} (-20%)`,
    ];
  }

  const lines = [
    `🐋 **MEGA A+ — ${ticker} ${dirLabel}**`,
    `Spot: $${spot.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange}%)  ·  Tape: ${tapeLine}`,
    `Vision 6HR: ${higher.verdict} ${higher.confidence}/10 — ${hiSummary}`,
    `Vision 4HR: ${lower.verdict} ${lower.confidence}/10 — ${loSummary}`,
    `GEX: ${gexLine}`,
    ...contractLines,
    `Trigger: 5m close ${triggerOp} $${triggerPrice.toFixed(2)} with vol > 1.5x`,
  ];
  let content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1900) + '...';
  return content;
}

// MAY 6 2026 PM — channel-aware send. type='bar-close' → STRATUMBREAK channel,
// type='a-plus' (default) → STRATUMSWING/MEGA channel.
async function sendDiscordCard(content, type) {
  const t = (type || 'a-plus').toLowerCase();
  const hook = t === 'bar-close' ? DISCORD_BAR_WEBHOOK : DISCORD_APLUS_WEBHOOK;
  const username = t === 'bar-close' ? 'MEGA Bar-Close Trigger' : 'MEGA A+ Agent';
  if (!hook) return false;
  const r = await postJson(hook, { content: content, username: username }, { timeoutMs: 8000 });
  if (!r.ok) {
    log('WARN', `discord send fail (${t}): ${r.error || r.status}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DEDUP
// ---------------------------------------------------------------------------
const lastFire = new Map(); // `${ticker}|${direction}` → ts (A+ alerts)
const lastBarFire = new Map(); // bar-close-trigger dedup, separate window

function dedupKey(ticker, direction) { return `${ticker}|${direction}`; }
function isDeduped(ticker, direction) {
  const last = lastFire.get(dedupKey(ticker, direction));
  if (!last) return false;
  return (Date.now() - last) < DEDUP_MS;
}
function markFired(ticker, direction) {
  lastFire.set(dedupKey(ticker, direction), Date.now());
}
function isBarDeduped(ticker, direction) {
  const last = lastBarFire.get(dedupKey(ticker, direction));
  if (!last) return false;
  return (Date.now() - last) < BAR_DEDUP_MS;
}
function markBarFired(ticker, direction) {
  lastBarFire.set(dedupKey(ticker, direction), Date.now());
}

// ---------------------------------------------------------------------------
// BAR-CLOSE TRIGGER DETECTION
// Pull latest 5m bars, compare LATEST CLOSED to PRIOR. Bull breakout: close >
// prior high + volume > 1.5× avg(prior 10) + body in upper 50%. Bear: mirror.
// Pushes Discord card BEFORE vision verdict — bar close is the faster signal.
// ---------------------------------------------------------------------------
async function fetchRecentBars(ticker) {
  const r = await getJson(`${RAILWAY_BASE}/api/ticker-bars?symbol=${encodeURIComponent(ticker)}&interval=5&unit=Minute&barsback=20`, { timeoutMs: 8000 });
  if (!r || !r.ok || !Array.isArray(r.bars) || r.bars.length < 12) return null;
  return r.bars; // chronological — oldest first, latest last
}

function detectBarCloseTrigger(bars) {
  // Conservative: treat penultimate bar as "latest CLOSED" (the truly last one
  // may still be in-progress depending on TS feed). Falls back to last if only
  // closed bars are returned.
  if (!bars || bars.length < 12) return null;
  const latest = bars[bars.length - 2] || bars[bars.length - 1];
  const prior = bars[bars.length - 3] || bars[bars.length - 2];
  if (!latest || !prior) return null;
  if (!isFinite(latest.close) || !isFinite(latest.high) || !isFinite(latest.low) || !isFinite(prior.high) || !isFinite(prior.low)) return null;

  // Avg vol of prior 10 bars (excluding latest)
  const start = Math.max(0, bars.length - 12);
  const end = bars.length - 2; // exclude latest
  let volSum = 0, volN = 0;
  for (let i = start; i < end; i++) {
    const v = Number(bars[i].volume) || 0;
    if (v > 0) { volSum += v; volN++; }
  }
  if (volN < 5) return null;
  const avgVol = volSum / volN;
  const latestVol = Number(latest.volume) || 0;
  const volMult = avgVol > 0 ? latestVol / avgVol : 0;

  const range = latest.high - latest.low;
  if (range <= 0) return null;
  const body = Math.abs(latest.close - latest.open);
  const upperBodyMid = (Math.max(latest.open, latest.close) - latest.low) / range;
  const lowerBodyMid = (latest.high - Math.min(latest.open, latest.close)) / range;

  const isBullBreakout = latest.close > prior.high
    && volMult > BAR_VOL_MULT
    && upperBodyMid >= BAR_BODY_FRAC;
  const isBearBreakdown = latest.close < prior.low
    && volMult > BAR_VOL_MULT
    && lowerBodyMid >= BAR_BODY_FRAC;

  if (!isBullBreakout && !isBearBreakdown) return null;
  return {
    direction: isBullBreakout ? 'long' : 'short',
    latestClose: latest.close,
    priorHigh: prior.high,
    priorLow: prior.low,
    volMult: +volMult.toFixed(2),
    avgVol: Math.round(avgVol),
    latestVol: latestVol,
  };
}

async function buildBarCloseCard(ticker, trig, quote, spyPct) {
  const dirLabel = trig.direction === 'long' ? 'LONG' : 'SHORT';
  const optType = trig.direction === 'long' ? 'call' : 'put';
  const aboveBelow = trig.direction === 'long' ? 'above prior high' : 'below prior low';
  const ref = trig.direction === 'long' ? trig.priorHigh : trig.priorLow;
  const spyLine = (spyPct != null) ? `SPY ${spyPct >= 0 ? '+' : ''}${spyPct}%` : 'SPY ?';
  const tickerPctStr = (quote && quote.pctChange != null)
    ? `${quote.pctChange >= 0 ? '+' : ''}${quote.pctChange}%`
    : '?';
  const spot = (quote && quote.last != null) ? Number(quote.last) : null;
  // MAY 6 2026 PM — REAL CONTRACT NUMBERS (AB explicit ask)
  let contractLine = `Action: consider 1ct ATM ${optType}`;
  if (spot) {
    const sc = await getSuggestedContract(ticker, trig.direction, spot, 9);
    if (sc) {
      const cost1ct = (sc.mid * 100).toFixed(0);
      const stop = (sc.mid * 0.80).toFixed(2);  // -20% stop default
      const tp = (sc.mid * 1.50).toFixed(2);    // +50% TP default
      contractLine = [
        `Contract: **${ticker} ${sc.expiry} $${sc.strike}${optType[0].toUpperCase()}**`,
        `Mid $${sc.mid.toFixed(2)} (bid $${sc.bid.toFixed(2)} / ask $${sc.ask.toFixed(2)}) · vol ${sc.vol} · OI ${sc.oi}`,
        `Cost 1ct: **$${cost1ct}** · Breakeven: $${sc.breakeven.toFixed(2)}`,
        `Bracket: TP $${tp} (+50%) / Stop $${stop} (-20%)`,
      ].join('\n');
    }
  }
  const lines = [
    `⚡ **BAR-CLOSE TRIGGER — ${ticker} ${dirLabel}**`,
    `5m close: $${trig.latestClose.toFixed(2)} (${aboveBelow} $${ref.toFixed(2)})`,
    `Volume: ${trig.volMult}× avg (prior 10 bars)`,
    `Spot: $${(spot != null ? spot.toFixed(2) : '?')} (${tickerPctStr})  ·  Tape: ${spyLine}`,
    contractLine,
  ];
  let content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1900) + '...';
  return content;
}

async function checkBarCloseTrigger(ticker, quote, spyPct) {
  let bars;
  try {
    bars = await fetchRecentBars(ticker);
  } catch (e) {
    return { fired: false, reason: 'bars-fetch-error: ' + e.message };
  }
  if (!bars) return { fired: false, reason: 'no-bars' };
  const trig = detectBarCloseTrigger(bars);
  if (!trig) return { fired: false, reason: 'no-trigger' };
  if (isBarDeduped(ticker, trig.direction)) return { fired: false, reason: 'dedup', direction: trig.direction };
  const card = await buildBarCloseCard(ticker, trig, quote, spyPct);
  const sent = await sendDiscordCard(card, 'bar-close');
  if (sent) {
    markBarFired(ticker, trig.direction);
    return { fired: true, direction: trig.direction, volMult: trig.volMult };
  }
  return { fired: false, reason: 'send-fail', direction: trig.direction };
}

// ---------------------------------------------------------------------------
// PER-TICKER PROCESS
// ---------------------------------------------------------------------------
async function processTicker(ticker, spyPct) {
  let direction = null;
  let quote = null;
  try {
    quote = await getTickerQuote(ticker);
  } catch (e) {
    log('WARN', `${ticker} quote fetch error: ${e.message}`);
  }
  if (!quote || quote.last == null || quote.pctChange == null) {
    log('INFO', `${ticker} v6HR=skip v4HR=skip gex=- aPlusFire=no reason=no-quote`);
    return;
  }

  // Bar-close-trigger detection — runs INDEPENDENT of vision/A+ stack. The
  // 5m bar close IS the trigger; this fires Discord card immediately so AB
  // sees a faster signal than the full A+ verdict.
  try {
    const barRes = await checkBarCloseTrigger(ticker, quote, spyPct);
    if (barRes.fired) {
      log('INFO', `${ticker} bar-close-trigger=FIRED dir=${barRes.direction} vol=${barRes.volMult}x`);
    } else if (barRes.reason && barRes.reason !== 'no-trigger') {
      log('INFO', `${ticker} bar-close-trigger=skip reason=${barRes.reason}`);
    }
  } catch (e) {
    log('WARN', `${ticker} bar-close-trigger error: ${e.message}`);
  }

  const pct = quote.pctChange;
  if (pct >= TICKER_BIAS_THRESHOLD) direction = 'long';
  else if (pct <= -TICKER_BIAS_THRESHOLD) direction = 'short';
  else {
    log('INFO', `${ticker} v6HR=skip v4HR=skip gex=- aPlusFire=no reason=flat(${pct}%)`);
    return;
  }

  // GEX context first (fast, cached internally)
  const gex = await getGexContext(ticker, direction);
  const visionEnv = { GEX_CONTEXT: gex.summary || '' };

  // Vision shells — sequentially, 6HR then 4HR
  let higher, lower;
  try {
    const hiRes = await runVisionShell(ticker, direction, '6HR', visionEnv);
    higher = hiRes.ok ? hiRes.parsed : { verdict: 'WAIT', confidence: 5, summary: '6HR err: ' + (hiRes.error || '?') };
  } catch (e) {
    log('WARN', `${ticker} 6HR shell error: ${e.message}`);
    higher = { verdict: 'WAIT', confidence: 5, summary: '6HR exception' };
  }

  await sleep(TICKER_SLEEP_MS);

  try {
    const loRes = await runVisionShell(ticker, direction, '4HR', visionEnv);
    lower = loRes.ok ? loRes.parsed : { verdict: 'WAIT', confidence: 5, summary: '4HR err: ' + (loRes.error || '?') };
  } catch (e) {
    log('WARN', `${ticker} 4HR shell error: ${e.message}`);
    lower = { verdict: 'WAIT', confidence: 5, summary: '4HR exception' };
  }

  // Merge verdict
  const overall = (higher.verdict === 'VETO' || lower.verdict === 'VETO') ? 'VETO'
    : (higher.verdict === 'APPROVE' && lower.verdict === 'APPROVE') ? 'APPROVE'
    : (higher.verdict === 'WAIT' && lower.verdict === 'WAIT') ? 'WAIT'
    : 'MIXED';
  const confidence = Math.max(Number(higher.confidence) || 0, Number(lower.confidence) || 0) || 5;

  // Push to Railway cache (alert-only — useful for scanner card pre-validation too)
  const cachePayload = {
    ticker: ticker,
    direction: direction,
    tradeType: 'SWING',
    verdict: overall,
    confidence: confidence,
    summary: overall === 'APPROVE'
      ? `Both TFs approve: ${higher.summary || ''} / ${lower.summary || ''}`
      : overall === 'VETO'
        ? `VETO: ${(higher.verdict === 'VETO' ? higher.summary : lower.summary) || ''}`
        : `${higher.verdict}/${lower.verdict}: ${higher.summary || ''}`,
    higherTf: { tf: '6HR', verdict: higher.verdict, confidence: higher.confidence || 5, summary: higher.summary },
    lowerTf: { tf: '4HR', verdict: lower.verdict, confidence: lower.confidence || 5, summary: lower.summary },
    gex: gex,
    timestamp: new Date().toISOString(),
    source: 'mega-agent',
  };
  await pushVerdictToRailway(cachePayload);

  // ----- A+ FIRE CHECK -----
  let aPlusFire = 'no';
  let fireReason = '';
  const tapeAgrees = (spyPct != null) && (
    (direction === 'long' && spyPct > TAPE_FLAT_THRESHOLD) ||
    (direction === 'short' && spyPct < -TAPE_FLAT_THRESHOLD)
  );
  const gexAgrees = gex.available && (
    (direction === 'long' && gex.regime === 'POSITIVE') ||
    (direction === 'short' && gex.regime === 'NEGATIVE')
  );
  const kingClose = gex.available && (Math.abs(gex.distPct) <= APLUS_MAX_KING_DIST_PCT);
  const visionFull = higher.verdict === 'APPROVE' && lower.verdict === 'APPROVE';
  const confEnough = confidence >= APLUS_MIN_CONFIDENCE;

  if (visionFull && confEnough && gexAgrees && tapeAgrees && kingClose) {
    if (isDeduped(ticker, direction)) {
      aPlusFire = 'dedup';
    } else {
      const card = await buildDiscordCard({
        ticker, direction, spot: quote.last, pctChange: pct,
        higher, lower, gex, spyPct,
      });
      const sent = await sendDiscordCard(card, 'a-plus');
      if (sent) {
        markFired(ticker, direction);
        aPlusFire = 'yes';
      } else {
        aPlusFire = 'send-fail';
      }
    }
  } else {
    const fails = [];
    if (!visionFull) fails.push('vision');
    if (!confEnough) fails.push('conf');
    if (!gexAgrees) fails.push('gex');
    if (!tapeAgrees) fails.push('tape');
    if (!kingClose) fails.push('king');
    fireReason = fails.length ? ` fail=${fails.join(',')}` : '';
  }

  log('INFO', `${ticker} v6HR=${higher.verdict}(${higher.confidence}) v4HR=${lower.verdict}(${lower.confidence}) gex=${gex.regime || '-'} aPlusFire=${aPlusFire}${fireReason}`);
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
let _looping = false;

async function loopOnce() {
  if (_looping) {
    log('INFO', 'previous loop still in flight, skipping');
    return;
  }
  _looping = true;
  const started = Date.now();
  try {
    if (!isMarketHours()) {
      log('INFO', 'outside RTH, idling (set QUIET_OUTSIDE_MARKET=false to override)');
      return;
    }
    const spyPct = await getSpyPct();
    log('INFO', `loop-start tickers=${MEGA_WATCHLIST.length} spy=${spyPct != null ? (spyPct >= 0 ? '+' : '') + spyPct + '%' : '?'}`);
    for (const ticker of MEGA_WATCHLIST) {
      try {
        await processTicker(ticker, spyPct);
      } catch (e) {
        log('WARN', `${ticker} processTicker fatal: ${e.message}`);
      }
      await sleep(TICKER_SLEEP_MS);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    log('INFO', `loop-end elapsed=${elapsed}s`);
  } catch (e) {
    log('ERROR', `loop fatal: ${e.message}`);
  } finally {
    _looping = false;
  }
}

// ---------------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------------
log('INFO', `MEGA Watch Agent starting — pid=${process.pid} host=${os.hostname()}`);
log('INFO', `watchlist=${MEGA_WATCHLIST.join(',')} interval=${LOOP_INTERVAL_MS}ms dedup=${DEDUP_MIN}min`);
log('INFO', `railway=${RAILWAY_BASE} repo=${REPO_ROOT} cdp_required=true`);
log('INFO', `discord=${DISCORD_WEBHOOK ? DISCORD_WEBHOOK.slice(0, 50) + '...' : 'NONE'}`);

// First loop after a short startup delay (let TV CDP settle if just opened)
setTimeout(() => {
  loopOnce().catch((e) => log('ERROR', 'initial loop crash: ' + e.message));
  setInterval(() => {
    loopOnce().catch((e) => log('ERROR', 'interval loop crash: ' + e.message));
  }, LOOP_INTERVAL_MS);
}, 5000);

// Keep process alive
process.on('SIGTERM', () => { log('INFO', 'SIGTERM received, exiting'); process.exit(0); });
process.on('SIGINT', () => { log('INFO', 'SIGINT received, exiting'); process.exit(0); });
process.on('unhandledRejection', (e) => { log('ERROR', `unhandledRejection: ${(e && e.message) || e}`); });
process.on('uncaughtException', (e) => { log('ERROR', `uncaughtException: ${e.message}`); });
