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
const BAR_BODY_FRAC = 0.66;        // MAY 6 PM: body in upper/lower THIRD (was 0.5) — AB rule: no rejection wick
const BAR_DEDUP_MIN = 15;          // 15-min dedup per ticker+direction
const BAR_DEDUP_MS = BAR_DEDUP_MIN * 60 * 1000;

// MAY 6 2026 PM — STRUCTURAL STOPS (AB recurring rule, see feedback_stop_management.md)
// "NEVER flat % stops. Structure-based."
//
// Long stop  = stock prior-bar low (or trigger level - small buffer)
//              translated to option price via delta
// Short stop = stock prior-bar high
//              translated to option price via delta
//
// Falls back to a -25% option-mid stop ONLY if structural data is missing
// (delta unavailable, no prior bar). Always logs whether structural or fallback.
function computeStructuralStop(direction, currentSpot, priorBarHigh, priorBarLow, optMid, optDelta) {
  const dir = String(direction).toLowerCase();
  // Stock-side structural stop: below prior low for long, above prior high for short
  // Buffer = 0.1% of spot (avoids stop-hunting on exact level)
  const buffer = currentSpot * 0.001;
  const stockStopLevel = (dir === 'long' || dir === 'call')
    ? (priorBarLow - buffer)
    : (priorBarHigh + buffer);

  if (!isFinite(stockStopLevel) || stockStopLevel <= 0) {
    return { optStop: (optMid * 0.75).toFixed(2), source: 'fallback-25pct-no-structural', stockStopLevel: null };
  }

  // Translate to option price using delta
  const stockMoveAdverse = (dir === 'long' || dir === 'call')
    ? (currentSpot - stockStopLevel)   // positive: how much stock would drop
    : (stockStopLevel - currentSpot);  // positive: how much stock would rise
  if (!isFinite(optDelta) || optDelta <= 0 || optDelta > 1) {
    // Delta unknown — assume 0.40 ATM-ish
    optDelta = 0.40;
  }
  const optDrop = stockMoveAdverse * optDelta;
  const optStop = Math.max(optMid - optDrop, optMid * 0.10);  // floor at 10% of mid (don't go negative)
  // Cap stop loss at 30% of premium even structurally (sanity check)
  const optStopFinal = Math.max(optStop, optMid * 0.70);
  const pctOfMid = ((optStopFinal / optMid - 1) * 100).toFixed(1);
  return {
    optStop: optStopFinal.toFixed(2),
    source: 'structural',
    stockStopLevel: stockStopLevel.toFixed(2),
    stockMoveAdverse: stockMoveAdverse.toFixed(2),
    deltaUsed: optDelta,
    pctMove: pctOfMid + '%',
  };
}

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
// MAY 6 2026 PM — DAY TRADE tier (AB explicit ask)
// Window: 9:30–10:30 ET ONLY. Stronger bar criteria. Exit by 3:30 PM same day.
// Routes to STRATUMBAR channel (bar-method execution).
const DISCORD_DAY_WEBHOOK = process.env.DISCORD_DAY_WEBHOOK ||
  process.env.DISCORD_STRATUMBAR_WEBHOOK ||
  'https://discord.com/api/webhooks/1494838632886964285/aD93F5W7aFxjblLv3v54RCvVi-a_h9rHe1hN2xbVG1bHohKq1bAUHrZxcHqMMpFR6lFH';
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
    // MAY 6 2026 PM — broker-specific OSI symbols for copy-paste (AB: "i tried
    // google and entered the wrong contract"). Eliminates manual typing.
    //   TS Titan format:    "GOOGL 260515C400"        (ticker + space + YYMMDD + C/P + strike)
    //   Public.com format:  "GOOGL260515C00400000"    (ticker + YYMMDD + C/P + strike*1000 8-digit padded)
    //   OCC standard OSI:   "GOOGL  260515C00400000"  (6-char ticker padded + YYMMDD + C/P + strike8)
    // yymmdd + cp already declared above; reuse them
    const tsSymbol = strike != null ? `${ticker} ${yymmdd}${cp}${strike}` : valid.symbol;
    const strikeMillis = strike != null ? String(Math.round(strike * 1000)).padStart(8, '0') : '';
    const publicSymbol = strike != null ? `${ticker}${yymmdd}${cp}${strikeMillis}` : null;
    const occSymbol = strike != null ? `${ticker.padEnd(6, ' ')}${yymmdd}${cp}${strikeMillis}` : null;
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
      tsSymbol: tsSymbol,
      publicSymbol: publicSymbol,
      occSymbol: occSymbol,
      yymmdd: yymmdd,
      cp: cp,
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
// MAY 6 2026 PM — buildDiscordCard now emits a Discord EMBED payload too.
// SWING profile (full A+ stack confirmation: vision + GEX + tape + king node).
async function buildDiscordCard(ctx) {
  const {
    ticker, direction, spot, pctChange,
    higher, lower, gex, spyPct,
  } = ctx;
  const dirLabel = direction === 'long' ? 'LONG' : 'SHORT';
  const optType = direction === 'long' ? 'C' : 'P';
  const triggerOp = direction === 'long' ? 'above' : 'below';
  const triggerStep = spot * 0.0015;
  const triggerPrice = direction === 'long' ? spot + triggerStep : spot - triggerStep;

  const gexLine = gex.available
    ? `${gex.regime} ${gex.totalNetGex != null ? ((gex.totalNetGex >= 0 ? '+' : '') + '$' + (gex.totalNetGex/1e6).toFixed(1) + 'M') : '?'}\nmagnet $${gex.kingNode} (${gex.distPct >= 0 ? '+' : ''}${gex.distPct}% from spot)`
    : 'GEX unavailable';

  const tapeAgrees = (direction === 'long' && spyPct > 0) || (direction === 'short' && spyPct < 0);
  const tapeLine = (spyPct != null)
    ? `SPY ${spyPct >= 0 ? '+' : ''}${spyPct}%\n${tapeAgrees ? '✅ with you' : '⚠ against you'}`
    : 'SPY tape unknown';

  const hiSummary = String(higher.summary || '').slice(0, 200);
  const loSummary = String(lower.summary || '').slice(0, 200);

  let sc = null;
  try { sc = await getSuggestedContract(ticker, direction, spot, 9); } catch (e) {}

  const fields = [
    { name: '💰 Spot',           value: `$${spot.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange}%)`, inline: true },
    { name: '🌊 Tape',           value: tapeLine, inline: true },
    { name: '⚡ GEX',            value: gexLine, inline: true },
    { name: `📊 Vision ${higher.tf || '6HR'}`, value: `${higher.verdict} ${higher.confidence}/10\n${hiSummary}`, inline: false },
    { name: `📊 Vision ${lower.tf || '4HR'}`,  value: `${lower.verdict} ${lower.confidence}/10\n${loSummary}`,  inline: false },
  ];
  if (sc) {
    const cost1ct = (sc.mid * 100).toFixed(0);
    const stop = (sc.mid * 0.80).toFixed(2);
    const tp1 = (sc.mid * 1.30).toFixed(2);
    const tp2 = (sc.mid * 1.60).toFixed(2);
    fields.push(
      { name: '📋 Contract', value: `**${ticker} ${sc.expiry} $${sc.strike}${optType}**\nMid $${sc.mid.toFixed(2)} · bid $${sc.bid.toFixed(2)} / ask $${sc.ask.toFixed(2)}\nvol ${sc.vol} · OI ${sc.oi}`, inline: false },
      { name: '🎯 SWING bracket', value: `Cost: **$${cost1ct}** · Breakeven: $${sc.breakeven.toFixed(2)}\nTP1 **$${tp1}** (+30%) · TP2 **$${tp2}** (+60%) · Stop **$${stop}** (-20%)\nHold 3-10 days · cut at 0.5 ATR break`, inline: false }
    );
  }
  fields.push(
    { name: '🚀 Trigger', value: `5m close ${triggerOp} $${triggerPrice.toFixed(2)} with vol > 1.5x`, inline: false },
    { name: '🔗 Open in TradingView', value: `[${ticker} 5m chart](${tvChartUrl(ticker)})`, inline: false },
  );

  return {
    title: `🐋 MEGA A+ SWING — ${ticker} ${dirLabel}`,
    description: 'Full stack confirmed: vision APPROVE both TFs · GEX agrees · tape agrees · within 1% of king node',
    color: direction === 'long' ? 0x4caf50 : 0xf44336,
    fields: fields,
    chartUrl: chartImageUrl(ticker, '60'),  // 1H for swing context
    footer: 'one-stop swing card · scanner not needed · fire 1ct from here',
  };
}

// MAY 6 2026 PM — channel-aware send. Now supports Discord EMBED format (rich
// card with chart image + structured fields) so Discord IS the one-stop trade
// surface. AB explicit ask: "this needs to replace the chart … one source of truth."
//
// type='bar-close'  → STRATUMBREAK channel  (scalps, anytime)
// type='day-trade'  → STRATUMBAR channel    (9:30-10:30 ET only, exit 3:30 PM)
// type='a-plus'     → STRATUMSWING channel  (full stack swing)
//
// payload can be either a string (legacy plain text) OR an object
// { content, embed, ticker, title, color, fields, chartUrl }
async function sendDiscordCard(payload, type) {
  const t = (type || 'a-plus').toLowerCase();
  let hook, username;
  if (t === 'bar-close')      { hook = DISCORD_BAR_WEBHOOK;   username = 'MEGA Bar-Close Trigger'; }
  else if (t === 'day-trade') { hook = DISCORD_DAY_WEBHOOK;   username = 'MEGA Day Trade'; }
  else                        { hook = DISCORD_APLUS_WEBHOOK; username = 'MEGA A+ Agent'; }
  if (!hook) return false;

  let body;
  if (typeof payload === 'string') {
    body = { content: payload, username: username };
  } else {
    // Rich embed format
    body = {
      username: username,
      content: payload.content || '',
      embeds: [{
        title: payload.title || 'MEGA Alert',
        description: payload.description || '',
        color: payload.color || 0x4caf50,
        fields: payload.fields || [],
        // Chart image — finviz public 5m chart PNG, free + reliable
        image: payload.chartUrl ? { url: payload.chartUrl } : undefined,
        footer: { text: payload.footer || 'one-stop trade card · scanner not needed · fire from here' },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  const r = await postJson(hook, body, { timeoutMs: 8000 });
  if (!r.ok) {
    log('WARN', `discord send fail (${t}): ${r.error || r.status}`);
    return false;
  }
  return true;
}

// MAY 6 2026 PM — chart image source for embeds.
// finviz returns a free PNG of the live chart. Format options:
//   p=i5 → 5-minute interval (intraday)
//   p=d  → daily
//   ta=1 → with technical indicators (MA + volume)
function chartImageUrl(ticker, interval) {
  const i = interval === '60' ? 'i60' : interval === 'd' ? 'd' : 'i5';
  return `https://finviz.com/chart.ashx?t=${encodeURIComponent(ticker)}&ty=c&ta=1&p=${i}&s=l`;
}

// TradingView deep link with 5m + studies for the click-through "open chart"
function tvChartUrl(ticker) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}&interval=5`;
}

// MAY 6 2026 PM — DAY TRADE WINDOW
// Day trade alerts only fire 9:30-10:30 ET. After 10:30, bar-close triggers
// stay scalp-grade (60-min cut, no day-hold). This prevents the 11 AM-3 PM
// dead-zone trades AB has been losing on (May 5 journal: "no afternoon entries").
function isInDayTradeWindow(now) {
  const dt = new Date(now || Date.now());
  // Convert to ET (handles EDT vs EST automatically with timezone string)
  const et = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  // et is like "5/6/2026, 09:45:00" — extract HH:MM
  const m = et.match(/,\s*(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const totalMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  // 9:30 = 570, 10:30 = 630
  return totalMin >= 570 && totalMin < 630;
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

// MAY 6 2026 PM — buildBarCloseCard now emits a Discord EMBED payload
// (rich card w/ chart image + structured fields). AB explicit ask: Discord
// IS the one-stop surface — no scanner, no chart-app round-trip.
//   alertTier='scalp'     → fast in/out 60-min profile     → STRATUMBREAK channel
//   alertTier='day-trade' → 9:30-10:30 ET, exit 3:30 PM    → STRATUMBAR channel
async function buildBarCloseCard(ticker, trig, quote, spyPct, alertTier) {
  const tier = alertTier || 'scalp';
  const dirLabel = trig.direction === 'long' ? 'LONG' : 'SHORT';
  const optType = trig.direction === 'long' ? 'call' : 'put';
  const aboveBelow = trig.direction === 'long' ? 'above prior high' : 'below prior low';
  const ref = trig.direction === 'long' ? trig.priorHigh : trig.priorLow;
  const spyLine = (spyPct != null) ? `SPY ${spyPct >= 0 ? '+' : ''}${spyPct}%` : 'SPY ?';
  const tickerPctStr = (quote && quote.pctChange != null)
    ? `${quote.pctChange >= 0 ? '+' : ''}${quote.pctChange}%`
    : '?';
  const spot = (quote && quote.last != null) ? Number(quote.last) : null;

  // Pull contract math
  let sc = null;
  if (spot) {
    try { sc = await getSuggestedContract(ticker, trig.direction, spot, 9); } catch (e) {}
  }

  let stop, tp1, tp2, profileLabel, holdRule, stopDetail = '';
  if (tier === 'day-trade') {
    profileLabel = '☀️ DAY TRADE (9:30-10:30 entry)';
    holdRule = 'Hard exit by 3:30 PM ET · no overnight';
  } else {
    profileLabel = '⚡ SCALP (fast in/out)';
    holdRule = 'Time stop: cut after 60 min if no progress';
  }
  if (sc) {
    // STRUCTURAL stop (AB rule: never flat % stops)
    // For long: stop at prior bar low. For short: prior bar high.
    const ss = computeStructuralStop(trig.direction, spot, trig.priorHigh, trig.priorLow, sc.mid, /*optDelta*/ 0.40);
    stop = ss.optStop;
    stopDetail = ss.source === 'structural'
      ? ` (stock invalidation $${ss.stockStopLevel}, ~${ss.pctMove})`
      : ` (no structural data — fallback)`;
    // TP based on tier (these stay % since they're profit targets, not risk control)
    if (tier === 'day-trade') {
      tp1 = (sc.mid * 1.20).toFixed(2); tp2 = (sc.mid * 1.40).toFixed(2);
    } else {
      tp1 = (sc.mid * 1.10).toFixed(2); tp2 = (sc.mid * 1.20).toFixed(2);
    }
  }

  const titleEmoji = tier === 'day-trade' ? '☀️' : '⚡';
  const titleLabel = tier === 'day-trade' ? 'DAY TRADE' : 'BAR-CLOSE TRIGGER';
  const color = tier === 'day-trade'
    ? (trig.direction === 'long' ? 0xffa500 : 0xff5722)   // orange / deep-orange
    : (trig.direction === 'long' ? 0x4caf50 : 0xf44336);  // green / red

  // Build structured fields
  const fields = [
    { name: '📊 5m Close',   value: `$${trig.latestClose.toFixed(2)}\n${aboveBelow} $${ref.toFixed(2)}`, inline: true },
    { name: '📈 Volume',     value: `${trig.volMult}× avg`, inline: true },
    { name: '🌊 Tape',       value: spyLine, inline: true },
    { name: '💰 Spot',       value: `$${(spot != null ? spot.toFixed(2) : '?')} (${tickerPctStr})`, inline: true },
  ];
  if (sc) {
    fields.push(
      { name: '📋 Contract', value: `**${ticker} ${sc.expiry} $${sc.strike}${optType[0].toUpperCase()}**\nMid $${sc.mid.toFixed(2)} · bid $${sc.bid.toFixed(2)} / ask $${sc.ask.toFixed(2)}\nvol ${sc.vol} · OI ${sc.oi}`, inline: false },
      // COPY-PASTE block — AB explicit ask after entering wrong GOOGL contract.
      // Triple-click to select, paste into broker symbol field. No typing.
      { name: '📑 Copy-paste symbol (no typos)', value: `**TS Titan:** \`${sc.tsSymbol}\`\n**Public.com:** \`${sc.publicSymbol || sc.tsSymbol}\``, inline: false },
      { name: '🎯 Bracket',  value: `Cost: **$${(sc.mid * 100).toFixed(0)}** · Breakeven: $${sc.breakeven.toFixed(2)}\nTP1 **$${tp1}** · TP2 **$${tp2}** · Stop **$${stop}**${stopDetail}\n${holdRule}`, inline: false }
    );
  }
  // Click-through chart link
  fields.push({
    name: '🔗 Open in TradingView',
    value: `[${ticker} 5m chart](${tvChartUrl(ticker)})`,
    inline: false,
  });

  return {
    title: `${titleEmoji} ${titleLabel} — ${ticker} ${dirLabel}`,
    description: profileLabel,
    color: color,
    fields: fields,
    chartUrl: chartImageUrl(ticker, '5'),
    footer: `${tier === 'day-trade' ? 'EXIT BY 3:30 PM' : 'ONE WIN, walk away'} · scanner not needed · fire from this card`,
  };
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
  // MAY 6 2026 PM — tier branching:
  //   9:30-10:30 ET window + strong follow-through (vol >= 1.8x) = DAY TRADE
  //   Otherwise (anytime, normal vol)                            = SCALP
  const inDayWindow = isInDayTradeWindow();
  const isStrongDay = inDayWindow && trig.volMult >= 1.8;
  const tier = isStrongDay ? 'day-trade' : 'scalp';
  const channelType = isStrongDay ? 'day-trade' : 'bar-close';
  const card = await buildBarCloseCard(ticker, trig, quote, spyPct, tier);
  const sent = await sendDiscordCard(card, channelType);
  if (sent) {
    markBarFired(ticker, trig.direction);
    return { fired: true, direction: trig.direction, volMult: trig.volMult, tier: tier };
  }
  return { fired: false, reason: 'send-fail', direction: trig.direction, tier: tier };
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
