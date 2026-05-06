#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// PHASE 4.32 — ALWAYS-ON VISION DAEMON (May 5 PM 2026)
// =============================================================================
// Long-running Node process on AB's local Mac. Continuously vision-checks the
// top scanner candidates + open positions, pushes verdicts back to the Railway
// scanner-card cache so:
//   1. Every Grade A card already has a vision pill before AB clicks fire.
//   2. Click-fire is instant (no 30-80s round-trip to Claude vision API).
//   3. Open positions get continuous structural-health checks.
//   4. Discord alert when an OPEN position's vision verdict flips to VETO.
//
// THE GAP THIS CLOSES (May 5 ADBE/CRM lesson):
//   AB fired CRM and ADBE in the 3:30 swing window. Vision had VETO'd both at
//   14:55 ET — but by 15:25 the verdict was 30 minutes stale and AB had already
//   emotionally committed. He overrode the VETO. Both rolled over.
//   Always-on vision means the verdict is fresh ALL DAY, not just at fire time.
//
// CONSTRAINTS:
//   - Runs ONLY on AB's Mac (Railway has no Chrome / no TV CDP).
//   - Uses existing scripts/chart-vision.sh which spawns the TV MCP CLI.
//   - Cache pushes to Railway via PUT /api/chart-vision/cache.
//   - Heartbeat every 30s via POST /api/vision/heartbeat.
//   - Concurrency 2 (don't burst TV; each scan is ~25s of CDP work).
//   - Discord alerts deduped per ticker (30 min cooldown).
//   - Fail-open: if Railway is down, daemon keeps polling and retries.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const RAILWAY_BASE = process.env.FLOW_SCOUT_BASE || 'https://flow-scout-production.up.railway.app';
const REPO_ROOT = process.env.FLOW_SCOUT_ROOT || path.resolve(__dirname, '..');
const CHART_VISION_SH = path.join(REPO_ROOT, 'scripts', 'chart-vision.sh');
const TV_CLI = process.env.TV_CLI_PATH || '/Users/NinjaMon/Desktop/tradingview-mcp/src/cli/index.js';

// Polling cadences
const CANDIDATE_LOOP_MS = 60 * 1000;          // refresh top-10 candidates every 60s
const POSITION_LOOP_MS = 5 * 60 * 1000;       // recheck open positions every 5 min
const HEARTBEAT_MS = 30 * 1000;               // beat to Railway every 30s

// Cache TTLs (local memory)
const CANDIDATE_TTL_MS = 5 * 60 * 1000;       // candidate verdict valid 5 min
const POSITION_TTL_MS = 5 * 60 * 1000;        // position verdict valid 5 min

// Discord dedupe — same alert won't fire twice within this window
const ALERT_DEDUPE_MS = 30 * 60 * 1000;

// Concurrency for vision runs (keeps TV CDP healthy)
const CONCURRENCY = 2;

// Cap top-N candidates per loop (Grade A focus)
const TOP_N_CANDIDATES = 10;

// Discord webhook for position-health alerts
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// Per-vision-run timeout (chart-vision.sh waits 8s + 2 TV calls + Claude review)
const VISION_RUN_TIMEOUT_MS = 90 * 1000;

// Local log file
const LOG_FILE = process.env.VISION_DAEMON_LOG || '/tmp/vision-daemon.log';

// Whether to run vision against the live TV chart.  If TV CDP is unavailable
// (no port 9222) the daemon falls back to a "skipped" verdict so it doesn't
// poison the cache with WAITs.
const REQUIRE_TV = process.env.VISION_DAEMON_REQUIRE_TV !== 'false';

// Quiet hours — outside RTH the daemon idles (still beats heartbeat, no scans)
const QUIET_OUTSIDE_MARKET = process.env.VISION_DAEMON_24_7 !== 'true';

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}` +
    (extra ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '');
  // When running under nohup the stdout is already redirected to LOG_FILE.
  // Avoid double-writes: write to console only (nohup captures it). If the
  // process is run interactively (no NOHUP_LOG_REDIRECT env), we mirror to
  // the explicit log file so a stray foreground run doesn't lose its log.
  console.log(line);
  if (process.env.VISION_DAEMON_DUAL_WRITE === 'true') {
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// FETCH HELPER (Node 18+ has global fetch)
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

// ---------------------------------------------------------------------------
// LOCAL CACHE — keyed by `${ticker}|${direction}|${tradeType}`
// ---------------------------------------------------------------------------
const cache = new Map();
const lastDiscordAlert = new Map();   // ticker|direction → last alert ts
const recentVerdicts = [];            // ring buffer of last 25 verdicts pushed

function cacheKey(t, d, tt) {
  return `${(t || '').toUpperCase()}|${String(d || 'long').toLowerCase()}|${String(tt || 'SWING').toUpperCase()}`;
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CANDIDATE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key, payload) {
  cache.set(key, { ts: Date.now(), payload: payload });
  recentVerdicts.unshift({
    key: key,
    ts: Date.now(),
    verdict: payload && payload.verdict,
    summary: payload && payload.summary && String(payload.summary).slice(0, 120),
  });
  if (recentVerdicts.length > 25) recentVerdicts.length = 25;
}

// ---------------------------------------------------------------------------
// MARKET HOURS (ET) — RTH: 09:30-16:00, M-F (no holiday calendar)
// ---------------------------------------------------------------------------
function isMarketHours() {
  if (!QUIET_OUTSIDE_MARKET) return true;
  const now = new Date();
  // Convert to ET via locale string (handles DST)
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  // Format: "M/D/YYYY, HH:MM:SS"
  const m = etStr.match(/^(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+):(\d+)/);
  if (!m) return true;
  const dow = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getDay();
  if (dow === 0 || dow === 6) return false; // weekend
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const minutesIntoDay = hour * 60 + min;
  // 09:30 ET = 570 min, 16:00 ET = 960 min — extend +30 either side for prep
  return minutesIntoDay >= 540 && minutesIntoDay <= 990;
}

// ---------------------------------------------------------------------------
// VISION RUN — spawn scripts/chart-vision.sh, parse stdout
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

function runVisionShell(ticker, direction, tf) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CHART_VISION_SH)) {
      return resolve({ ok: false, error: 'chart-vision.sh missing at ' + CHART_VISION_SH });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('bash', [CHART_VISION_SH, ticker, direction, tf], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env),
    });
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, VISION_RUN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) return resolve({ ok: false, error: 'vision shell timeout', stdout: stdout, stderr: stderr });
      if (code !== 0) return resolve({ ok: false, error: 'shell exit ' + code, stdout: stdout, stderr: stderr });
      const parsed = parseVisionOutput(stdout);
      if (!parsed.verdict) return resolve({ ok: false, error: 'no verdict parsed', stdout: stdout });
      resolve({ ok: true, parsed: parsed, stdout: stdout });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, error: e.message });
    });
  });
}

// Trade-type → TF map
function tfMapForTradeType(tt) {
  const t = String(tt || 'SWING').toUpperCase();
  if (t === 'DAY') return { higher: '1H', lower: '15m' };
  if (t === 'LOTTO') return { higher: '15m', lower: '5m' };
  return { higher: '6HR', lower: '4HR' }; // SWING default
}

function mergeVerdicts(higher, lower) {
  const hv = (higher && higher.verdict) || 'WAIT';
  const lv = (lower && lower.verdict) || 'WAIT';
  if (hv === 'VETO' || lv === 'VETO') return 'VETO';
  if (hv === 'APPROVE' && lv === 'APPROVE') return 'APPROVE';
  if (hv === 'WAIT' && lv === 'WAIT') return 'WAIT';
  return 'MIXED';
}

// Run both higher + lower TF for a ticker/direction/tradeType, merge + return.
async function runVisionForCandidate(ticker, direction, tradeType) {
  const tfs = tfMapForTradeType(tradeType);

  log('INFO', `vision-run ${ticker} ${direction} ${tradeType} (${tfs.higher} + ${tfs.lower})`);

  const higherRes = await runVisionShell(ticker, direction, tfs.higher);
  const lowerRes = await runVisionShell(ticker, direction, tfs.lower);

  const hi = higherRes.ok ? higherRes.parsed : { verdict: 'WAIT', confidence: 5, summary: 'higher TF unavailable: ' + (higherRes.error || '?').slice(0, 80) };
  const lo = lowerRes.ok ? lowerRes.parsed : { verdict: 'WAIT', confidence: 5, summary: 'lower TF unavailable: ' + (lowerRes.error || '?').slice(0, 80) };

  const overall = mergeVerdicts(hi, lo);

  let summary;
  if (overall === 'VETO') {
    const vetoSide = (hi.verdict === 'VETO') ? `higher TF (${tfs.higher})` : `lower TF (${tfs.lower})`;
    const vetoSummary = (hi.verdict === 'VETO') ? hi.summary : lo.summary;
    summary = `VETO from ${vetoSide}: ${vetoSummary}`;
  } else if (overall === 'APPROVE') {
    summary = `Both TFs approve: ${hi.summary || ''}${lo.summary ? ' / ' + lo.summary : ''}`;
  } else if (overall === 'WAIT') {
    if (!higherRes.ok && !lowerRes.ok) summary = 'vision unavailable (TV CDP / shell error)';
    else summary = `Both TFs WAIT: ${hi.summary || ''}`;
  } else {
    summary = `MIXED: ${tfs.higher} ${hi.verdict} / ${tfs.lower} ${lo.verdict}`;
  }

  const confidence = Math.max(Number(hi.confidence) || 0, Number(lo.confidence) || 0) || 5;

  return {
    ticker: ticker,
    direction: direction,
    tradeType: tradeType,
    verdict: overall,
    confidence: confidence,
    summary: summary,
    higherTf: { tf: tfs.higher, verdict: hi.verdict, confidence: hi.confidence || 5, summary: hi.summary },
    lowerTf: { tf: tfs.lower, verdict: lo.verdict, confidence: lo.confidence || 5, summary: lo.summary },
    timestamp: new Date().toISOString(),
    source: 'local-daemon',
  };
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
// HEARTBEAT
// ---------------------------------------------------------------------------
async function sendHeartbeat() {
  const url = `${RAILWAY_BASE}/api/vision/heartbeat`;
  const body = {
    cachedCount: cache.size,
    recentVerdicts: recentVerdicts.slice(0, 5),
    pid: process.pid,
    host: os.hostname(),
    repoRoot: REPO_ROOT,
    inMarketHours: isMarketHours(),
    uptimeSec: Math.round(process.uptime()),
  };
  const r = await postJson(url, body, { timeoutMs: 5000 });
  if (!r.ok) log('WARN', `heartbeat fail: ${r.error || r.status}`);
}

// ---------------------------------------------------------------------------
// FETCH CANDIDATES — merge top-10 across action-radar + setup-radar
// ---------------------------------------------------------------------------
async function fetchTopCandidates() {
  const merged = new Map(); // key=ticker|direction → { ticker, direction, tradeType, score }

  // 1. Action radar (UOA + flow)
  try {
    const ar = await getJson(`${RAILWAY_BASE}/api/action-radar?minScore=10`, { timeoutMs: 8000 });
    if (ar && Array.isArray(ar.rows)) {
      ar.rows.forEach((r) => {
        if (!r.ticker || !r.direction || r.direction === 'mixed') return;
        if (r.status !== 'ACTIONABLE') return;
        const k = (r.ticker.toUpperCase()) + '|' + r.direction;
        if (!merged.has(k)) {
          merged.set(k, {
            ticker: r.ticker.toUpperCase(),
            direction: r.direction,
            tradeType: 'SWING',
            score: r.maxScore || 10,
            source: 'action-radar',
          });
        }
      });
    }
  } catch (e) {
    log('WARN', 'fetchCandidates action-radar error: ' + e.message);
  }

  // 2. Setup radar (ICS qualifying setups)
  try {
    const sr = await getJson(`${RAILWAY_BASE}/api/setup-radar`, { timeoutMs: 8000 });
    const buckets = ['ready', 'forming'];
    buckets.forEach((b) => {
      const list = (sr && sr[b]) || [];
      list.forEach((c) => {
        if (!c.ticker || !c.direction) return;
        const k = c.ticker.toUpperCase() + '|' + c.direction;
        if (!merged.has(k)) {
          merged.set(k, {
            ticker: c.ticker.toUpperCase(),
            direction: c.direction,
            tradeType: 'SWING',
            score: (c.conviction || 7) + (b === 'ready' ? 5 : 0),
            source: 'setup-radar:' + b,
          });
        }
      });
    });
  } catch (e) {
    log('WARN', 'fetchCandidates setup-radar error: ' + e.message);
  }

  // 3. (Optional) JS scan top picks — skip if unavailable
  try {
    const js = await getJson(`${RAILWAY_BASE}/api/js-scan`, { timeoutMs: 6000 });
    const picks = (js && js.picks) || (js && js.candidates) || [];
    picks.slice(0, 10).forEach((p) => {
      const t = (p.ticker || '').toUpperCase();
      const d = String(p.direction || p.bias || 'long').toLowerCase().includes('short') ? 'short' : 'long';
      if (!t) return;
      const k = t + '|' + d;
      if (!merged.has(k)) {
        merged.set(k, { ticker: t, direction: d, tradeType: 'SWING', score: p.score || 6, source: 'js-scan' });
      }
    });
  } catch (e) {}

  // Sort by score desc, take TOP_N
  const all = Array.from(merged.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
  return all.slice(0, TOP_N_CANDIDATES);
}

// ---------------------------------------------------------------------------
// FETCH OPEN POSITIONS
// ---------------------------------------------------------------------------
async function fetchOpenPositions() {
  const positions = [];
  try {
    const r = await getJson(`${RAILWAY_BASE}/api/active-positions`, { timeoutMs: 8000 });
    if (r && Array.isArray(r.positions)) {
      r.positions.forEach((p) => {
        if (!p || p.status !== 'OPEN') return;
        if (!p.ticker || !p.direction) return;
        positions.push({
          id: p.id,
          ticker: p.ticker.toUpperCase(),
          direction: p.direction,
          tradeType: (p.tradeType || 'SWING').toUpperCase(),
          entryPrice: p.entryPrice,
          firedAt: p.firedAt,
          structuralStop: p.structuralStop,
          optionSymbol: p.optionSymbol,
        });
      });
    }
  } catch (e) {
    log('WARN', 'fetchOpenPositions error: ' + e.message);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// CONCURRENCY-LIMITED QUEUE
// ---------------------------------------------------------------------------
class Pool {
  constructor(size) {
    this.size = size;
    this.active = 0;
    this.queue = [];
  }
  run(fn) {
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve });
      this._drain();
    });
  }
  _drain() {
    while (this.active < this.size && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => job.fn())
        .then((res) => job.resolve(res))
        .catch((e) => job.resolve({ ok: false, error: e.message }))
        .then(() => { this.active--; this._drain(); });
    }
  }
}

const visionPool = new Pool(CONCURRENCY);

// ---------------------------------------------------------------------------
// CANDIDATE LOOP — every CANDIDATE_LOOP_MS
// ---------------------------------------------------------------------------
async function candidateLoop() {
  if (!isMarketHours()) {
    log('INFO', 'candidate-loop skipped (outside market hours)');
    return;
  }
  const candidates = await fetchTopCandidates();
  log('INFO', `candidate-loop pulled ${candidates.length} top candidates`);
  for (const c of candidates) {
    const k = cacheKey(c.ticker, c.direction, c.tradeType);
    const cached = cacheGet(k);
    if (cached) continue; // fresh, skip

    visionPool.run(async () => {
      const t0 = Date.now();
      const verdict = await runVisionForCandidate(c.ticker, c.direction, c.tradeType);
      cacheSet(k, verdict);
      await pushVerdictToRailway(verdict);
      log('INFO', `verdict ${c.ticker} ${c.direction}: ${verdict.verdict} (conf ${verdict.confidence}) — ${(Date.now() - t0)}ms`);
    });
  }
}

// ---------------------------------------------------------------------------
// POSITION LOOP — every POSITION_LOOP_MS
// ---------------------------------------------------------------------------
const lastPositionVerdict = new Map(); // posId → { verdict, ts }

async function positionLoop() {
  if (!isMarketHours()) return;
  const positions = await fetchOpenPositions();
  log('INFO', `position-loop pulled ${positions.length} open positions`);
  for (const p of positions) {
    visionPool.run(async () => {
      const verdict = await runVisionForCandidate(p.ticker, p.direction, p.tradeType);
      const k = cacheKey(p.ticker, p.direction, p.tradeType);
      cacheSet(k, verdict);
      await pushVerdictToRailway(verdict);

      // Check for verdict CHANGE — if was APPROVE/WAIT and now VETO → alert
      const prev = lastPositionVerdict.get(p.id);
      lastPositionVerdict.set(p.id, { verdict: verdict.verdict, ts: Date.now() });

      const flippedToVeto = verdict.verdict === 'VETO' &&
                            (!prev || prev.verdict !== 'VETO');
      if (flippedToVeto) {
        await sendPositionHealthAlert(p, verdict, prev);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// DISCORD POSITION-HEALTH ALERT (deduped 30 min per ticker|direction)
// ---------------------------------------------------------------------------
async function sendPositionHealthAlert(pos, currVerdict, prevVerdict) {
  const dedupeKey = `${pos.ticker}|${pos.direction}|veto`;
  const last = lastDiscordAlert.get(dedupeKey) || 0;
  if (Date.now() - last < ALERT_DEDUPE_MS) {
    log('INFO', `alert deduped (recent ${pos.ticker} VETO sent ${Math.round((Date.now() - last) / 60000)} min ago)`);
    return;
  }
  lastDiscordAlert.set(dedupeKey, Date.now());

  const dirEmoji = pos.direction === 'long' ? 'GREEN LONG' : 'RED SHORT';
  const sideText = pos.direction === 'long' ? 'LONG' : 'SHORT';

  const stopLine = pos.structuralStop
    ? `${pos.structuralStop.predicate || (pos.direction === 'long' ? 'below' : 'above')} $${pos.structuralStop.price}`
    : '(none recorded)';

  const prevText = prevVerdict
    ? `${prevVerdict.verdict} (${Math.round((Date.now() - prevVerdict.ts) / 60000)} min ago)`
    : 'unknown';

  const concerns = []
    .concat(currVerdict.higherTf && currVerdict.higherTf.verdict === 'VETO' ? [`${currVerdict.higherTf.tf}: ${currVerdict.higherTf.summary}`] : [])
    .concat(currVerdict.lowerTf && currVerdict.lowerTf.verdict === 'VETO' ? [`${currVerdict.lowerTf.tf}: ${currVerdict.lowerTf.summary}`] : [])
    .slice(0, 2);

  const body = {
    username: 'Vision Daemon',
    embeds: [{
      title: `POSITION HEALTH ALERT — ${pos.ticker} ${sideText}`,
      description:
        `Position filled at $${pos.entryPrice || '?'} (entered ${pos.firedAt || '?'})\n` +
        `**Vision verdict THEN:** ${prevText}\n` +
        `**Vision verdict NOW:** VETO ${currVerdict.confidence}/10\n\n` +
        `**Concern:** ${currVerdict.summary}`,
      color: 15158332, // red
      fields: [
        { name: 'Action', value: 'Consider exit or tighten stop', inline: true },
        { name: 'Locked stop', value: stopLine, inline: true },
      ].concat(concerns.length ? [{ name: 'TF concerns', value: concerns.join('\n').slice(0, 1000), inline: false }] : []),
      footer: { text: `Vision Daemon · ${dirEmoji} · ${pos.optionSymbol || pos.ticker}` },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      log('INFO', `position-health alert pushed for ${pos.ticker} ${pos.direction} (VETO)`);
    } else {
      const txt = await r.text().catch(() => '');
      log('WARN', `discord push failed ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    log('WARN', `discord push error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
let stopRequested = false;

function shutdown(signal) {
  log('INFO', `shutdown on ${signal}, draining…`);
  stopRequested = true;
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (e) => {
  log('ERROR', 'uncaughtException: ' + e.message);
  // Don't exit — keep running
});
process.on('unhandledRejection', (e) => {
  log('ERROR', 'unhandledRejection: ' + (e && e.message ? e.message : e));
});

async function main() {
  log('INFO', 'visionDaemon starting');
  log('INFO', `RAILWAY_BASE=${RAILWAY_BASE}`);
  log('INFO', `REPO_ROOT=${REPO_ROOT}`);
  log('INFO', `CHART_VISION_SH=${CHART_VISION_SH}`);
  log('INFO', `TV_CLI=${TV_CLI}`);
  log('INFO', `CANDIDATE_LOOP=${CANDIDATE_LOOP_MS}ms POSITION_LOOP=${POSITION_LOOP_MS}ms HEARTBEAT=${HEARTBEAT_MS}ms`);
  log('INFO', `CONCURRENCY=${CONCURRENCY} TOP_N=${TOP_N_CANDIDATES}`);
  log('INFO', `QUIET_OUTSIDE_MARKET=${QUIET_OUTSIDE_MARKET}`);

  // Sanity-check chart-vision.sh exists
  if (!fs.existsSync(CHART_VISION_SH)) {
    log('ERROR', `chart-vision.sh missing — daemon will idle until script is restored`);
  }

  // First heartbeat immediately
  sendHeartbeat();

  // Start the loops with a small stagger so candidate is hit first
  const candTick = async () => {
    if (stopRequested) return;
    try { await candidateLoop(); } catch (e) { log('ERROR', 'candidate-loop: ' + e.message); }
  };
  const posTick = async () => {
    if (stopRequested) return;
    try { await positionLoop(); } catch (e) { log('ERROR', 'position-loop: ' + e.message); }
  };
  const hbTick = async () => {
    if (stopRequested) return;
    try { await sendHeartbeat(); } catch (e) { log('ERROR', 'heartbeat: ' + e.message); }
  };

  // Fire first candidate scan after 5s to let TV settle
  setTimeout(candTick, 5000);
  setTimeout(posTick, 30000);

  setInterval(candTick, CANDIDATE_LOOP_MS);
  setInterval(posTick, POSITION_LOOP_MS);
  setInterval(hbTick, HEARTBEAT_MS);
}

main().catch((e) => {
  log('ERROR', 'main fatal: ' + e.message);
  process.exit(1);
});
