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

// Phase 4.42 — GEX-Aware Vision: pull king-node / gamma context BEFORE every
// vision shell run so the verdict carries regime + magnet + direction-agreement
// metadata. Fail-open: if kingNodeComputer can't be loaded (e.g. its TS deps
// aren't on the local Mac), we just skip the GEX block. Never throw.
let kingNodeComputer = null;
try {
  kingNodeComputer = require(path.join(__dirname, '..', 'src', 'kingNodeComputer'));
} catch (e) {
  console.log('[VISION-DAEMON] kingNodeComputer not loaded (will skip GEX context):', e.message);
}

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
const SNIPER_LOOP_MS = 60 * 1000;             // Phase 4.33 — poll Sniper feed every 60s
const INDEX_REVERSAL_LOOP_MS = 5 * 60 * 1000; // Phase 4.38 — index reversal watch every 5 min

// Cache TTLs (local memory)
const CANDIDATE_TTL_MS = 5 * 60 * 1000;       // candidate verdict valid 5 min
const POSITION_TTL_MS = 5 * 60 * 1000;        // position verdict valid 5 min

// Discord dedupe — same alert won't fire twice within this window
const ALERT_DEDUPE_MS = 30 * 60 * 1000;

// Concurrency for vision runs (keeps TV CDP healthy)
const CONCURRENCY = 2;

// Cap top-N candidates per loop (Grade A focus)
const TOP_N_CANDIDATES = 10;

// Phase 4.33 — Sniper freshness gate (default 24hr)
const SNIPER_FRESH_HOURS = parseInt(process.env.SNIPER_FRESH_HOURS || '24', 10);

// Phase 4.33 — Sniper backfill on first start (one-time, processes last N posts
// regardless of freshness so AB has fresh verdicts immediately)
const SNIPER_BACKFILL_COUNT = parseInt(process.env.SNIPER_BACKFILL_COUNT || '5', 10);

// Discord webhook for position-health alerts
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

// Per-vision-run timeout (chart-vision.sh waits 8s + 2 TV calls + Claude review)
const VISION_RUN_TIMEOUT_MS = 90 * 1000;

// Local log file
const LOG_FILE = process.env.VISION_DAEMON_LOG || '/tmp/vision-daemon.log';

// Persistence — Sniper "seen msgIds" so we don't re-evaluate already-processed posts.
// Survives daemon restart. Path resolves to /data when available (Railway-style),
// otherwise local data dir.
const DATA_DIR = process.env.DATA_DIR ||
  (fs.existsSync('/data') ? '/data' : path.join(REPO_ROOT, 'data'));
const SNIPER_SEEN_FILE = path.join(DATA_DIR, 'sniper_seen.json');

// Phase 4.38 — Index reversal watch state file (per-ticker last-alert timestamps)
const INDEX_REVERSAL_FILE = path.join(DATA_DIR, 'index_reversal_alerts.json');

// Phase 4.38 — index watchlist & dedup window
const INDEX_WATCHLIST = ['SPY', 'QQQ', 'IWM'];
const INDEX_REVERSAL_DEDUP_HOURS = parseInt(process.env.INDEX_REVERSAL_DEDUP_HOURS || '4', 10);
// Bearish reversal pattern keywords — substring search on Daily/4HR summary
const BEARISH_REVERSAL_RE = /(hanging\s+man|shooting\s+star|distribution|failed[\s-]2U|bearish\s+(divergence|reversal|engulf)|lower\s+high|rejection|exhaustion|topping)/i;

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

function runVisionShell(ticker, direction, tf, extraEnv) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CHART_VISION_SH)) {
      return resolve({ ok: false, error: 'chart-vision.sh missing at ' + CHART_VISION_SH });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Phase 4.42 — extraEnv lets callers (runVisionForCandidate) inject
    // GEX_CONTEXT into the shell's environment so chart-vision.sh can quote
    // it in the model prompt.
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
  // Phase 4.33 — Sniper posts are multi-day swing analysis; use Daily + 4HR
  // (longer TFs than the standard SWING 6HR + 4HR pairing) to match the
  // narrative timeframe of Sniper chart-analysis posts.
  if (t === 'SWING_SNIPER') return { higher: 'Daily', lower: '4HR' };
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

// ---------------------------------------------------------------------------
// PHASE 4.42 — GEX CONTEXT for vision verdicts
// ---------------------------------------------------------------------------
// Pulls king-node / gamma regime once per candidate run and turns it into a
// human-readable summary the vision prompt can quote AND a structured block
// the scanner UI can render as a pill. Fail-open everywhere — if anything
// throws we return { available: false, summary: 'GEX data unavailable' }.
//
// agreesWithDirection rules:
//   POSITIVE regime is a magnet — gravity pulls TOWARD the king node.
//     LONG  + spot below king         → agrees (pulled UP toward magnet)
//     LONG  + spot above king by >2%  → fights (extended above magnet)
//     SHORT + spot above king         → agrees (pulled DOWN toward magnet)
//     SHORT + spot below king by >2%  → fights (extended below magnet)
//   NEGATIVE / FLIPPED regime is anti-magnet — spot tends to drift AWAY:
//     invert the agreement logic.
//   Within ±0.5% of king + POSITIVE regime → 'neutral' (chop zone, no edge).
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
  if (!kingNodeComputer || !kingNodeComputer.computeKingNode) {
    return fallback;
  }
  try {
    const king = await kingNodeComputer.computeKingNode(ticker);
    if (!king || king.kingNode == null || king.spot == null) {
      return Object.assign({}, fallback, {
        summary: 'GEX data unavailable: ' + (king && king.reason ? String(king.reason).slice(0, 80) : 'no king node'),
      });
    }
    const spot = Number(king.spot);
    const k = Number(king.kingNode);
    if (!isFinite(spot) || !isFinite(k) || k === 0) {
      return Object.assign({}, fallback, { summary: 'GEX data unavailable: invalid spot/king' });
    }

    // Pull GEX detail — total net gex + regime
    const gd = (king.detail && king.detail.gex) || {};
    const totalNetGex = isFinite(gd.netGex) ? Number(gd.netGex) : null;
    const regime = gd.regime || null;

    // Distance % (signed: negative = spot below king, positive = above)
    const distPct = +(((spot - k) / k) * 100).toFixed(2);
    const absDist = Math.abs(distPct);
    const above = spot > k;
    const dir = String(direction || '').toLowerCase();
    const isLong = dir === 'long' || dir === 'call' || dir === 'bullish' || dir === 'bull';
    const isShort = dir === 'short' || dir === 'put' || dir === 'bearish' || dir === 'bear';

    // Agreement logic — defaults to null for neutral/unknown
    let agreesWithDirection = null;
    const positiveRegime = regime === 'POSITIVE' || (totalNetGex != null && totalNetGex > 0 && regime !== 'NEGATIVE' && regime !== 'FLIPPED');

    if (absDist <= 0.5) {
      // At king node — chop zone, no edge regardless of direction
      agreesWithDirection = null;
    } else if (positiveRegime) {
      if (isLong) agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
      else if (isShort) agreesWithDirection = above ? true : (absDist > 2 ? false : null);
    } else {
      // NEGATIVE or FLIPPED — gamma is anti-magnet, spot drifts away
      if (isLong) agreesWithDirection = above ? true : (absDist > 2 ? false : null);
      else if (isShort) agreesWithDirection = !above ? true : (absDist > 2 ? false : null);
    }

    // Build human-readable summary
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
      // Useful side data for UI/log (but not part of the contract spec)
      strength: king.strength || null,
      sourceLabel: king.sourceLabel || null,
    };
  } catch (e) {
    return Object.assign({}, fallback, {
      summary: 'GEX data unavailable: ' + String(e.message || e).slice(0, 80),
    });
  }
}

// Run both higher + lower TF for a ticker/direction/tradeType, merge + return.
async function runVisionForCandidate(ticker, direction, tradeType) {
  const tfs = tfMapForTradeType(tradeType);

  // Phase 4.42 — pull GEX context ONCE per candidate (king-node computer is
  // cached 5 min internally, so this is cheap on repeat calls).
  const gex = await getGexContext(ticker, direction);
  log('INFO', `[GEX-CTX] ${ticker} ${direction}: ${gex.summary}`);

  log('INFO', `vision-run ${ticker} ${direction} ${tradeType} (${tfs.higher} + ${tfs.lower})`);

  // Phase 4.42 — pass the GEX summary into the vision shell via env var
  // (chart-vision.sh strictly takes 3 positional args today; env var keeps
  // changes minimal and back-compatible).
  const visionEnv = { GEX_CONTEXT: gex.summary || '' };

  const higherRes = await runVisionShell(ticker, direction, tfs.higher, visionEnv);
  const lowerRes = await runVisionShell(ticker, direction, tfs.lower, visionEnv);

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
    // Phase 4.42 — surface GEX context on every verdict so the cache push
    // carries it through to the scanner card pill + Discord embeds.
    gex: gex,
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

// =============================================================================
// PHASE 4.33 — SNIPER FEED MONITORING
// =============================================================================
// Sniper Trades posts chart analysis (e.g. "QCOM — PARABOLIC BREAKOUT EXTENSION
// / 174.50 PIVOT KEY") in #free-charts. These are SWING-style multi-day setups —
// different from John VIP day-trade picks. AB's directive: don't waste cycles on
// stale posts, but ANY fresh post from today gets immediate vision validation.
//
// FLOW:
//   1. Poll /api/sniper-feed every 60s
//   2. Compare against /data/sniper_seen.json (msgIds already processed)
//   3. For each NEW post within SNIPER_FRESH_HOURS:
//        a. Parse pivot price + direction from title
//        b. Run vision on Daily + 4HR (SWING_SNIPER trade type)
//        c. PUT verdict to Railway cache (key: TICKER|dir|SWING_SNIPER)
//        d. Push Discord notification
//        e. Mark msgId as seen
//   4. Older posts: log "skipped (stale)" and mark seen so we don't re-evaluate
// =============================================================================

// In-memory state, hydrated from disk on startup
let sniperSeen = { processed: [], lastChecked: null };
const sniperSeenSet = new Set();

function loadSniperSeen() {
  try {
    if (!fs.existsSync(SNIPER_SEEN_FILE)) {
      log('INFO', `sniper_seen: no file at ${SNIPER_SEEN_FILE}, starting fresh`);
      return;
    }
    const raw = fs.readFileSync(SNIPER_SEEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    sniperSeen = {
      processed: Array.isArray(data.processed) ? data.processed : [],
      lastChecked: data.lastChecked || null,
    };
    sniperSeen.processed.forEach((id) => sniperSeenSet.add(String(id)));
    log('INFO', `sniper_seen: loaded ${sniperSeenSet.size} processed msgIds (lastChecked ${sniperSeen.lastChecked || 'never'})`);
  } catch (e) {
    log('WARN', `sniper_seen load error: ${e.message} — starting fresh`);
    sniperSeen = { processed: [], lastChecked: null };
  }
}

function saveSniperSeen() {
  try {
    // Ensure data dir exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Cap processed list at 500 entries (rolling) so file doesn't grow forever
    const capped = sniperSeen.processed.slice(-500);
    sniperSeen.processed = capped;
    sniperSeen.lastChecked = new Date().toISOString();
    fs.writeFileSync(SNIPER_SEEN_FILE, JSON.stringify(sniperSeen, null, 2));
  } catch (e) {
    log('WARN', `sniper_seen save error: ${e.message}`);
  }
}

function markSniperSeen(msgId) {
  if (!msgId) return;
  const id = String(msgId);
  if (sniperSeenSet.has(id)) return;
  sniperSeenSet.add(id);
  sniperSeen.processed.push(id);
}

// Parse pivot price level from Sniper title
// Example: "QCOM — PARABOLIC BREAKOUT EXTENSION / 174.50 PIVOT KEY" → 174.50
//          "TSLA — DESCENDING CHANNEL UPPER TEST" → null
function parseSniperPivot(title) {
  if (!title) return null;
  const m = title.match(/([\d,]+(?:\.\d+)?)\s*PIVOT/i);
  if (!m) return null;
  const cleaned = m[1].replace(/,/g, '');
  const v = parseFloat(cleaned);
  return isFinite(v) ? v : null;
}

// Determine direction from Sniper title
function parseSniperDirection(title) {
  const t = String(title || '').toUpperCase();
  // Bear keywords first (more specific)
  if (/(BREAKDOWN|BEAR|REJECTION|REVERSAL|TOP|RESISTANCE\s+TEST|UPPER\s+TEST|FAILED\s+BREAKOUT)/.test(t)) return 'short';
  // Bull keywords
  if (/(BREAKOUT|BULL|EXTENSION|SUPPORT\s+BOUNCE|DUAL\s+CHANNEL\s+BOUNCE|RECLAIM)/.test(t)) return 'long';
  // Channel patterns: descending channel break = bullish (most common Sniper setup)
  if (/DESCENDING\s+CHANNEL/.test(t)) return 'long';
  if (/ASCENDING\s+CHANNEL/.test(t)) return 'short';
  // Default to long (Sniper is mostly bull-biased)
  return 'long';
}

function isPostFresh(postedAt, freshHours) {
  if (!postedAt) return false;
  const ts = new Date(postedAt).getTime();
  if (!isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs < (freshHours || SNIPER_FRESH_HOURS) * 60 * 60 * 1000;
}

// Run vision on a single Sniper post and push to Railway cache.
// Returns the verdict object so callers can build summaries.
async function processSniperPost(post, opts) {
  opts = opts || {};
  const ticker = (post.ticker || '').toUpperCase();
  if (!ticker) {
    log('INFO', `sniper post ${post.msgId} has no ticker — skipping`);
    return null;
  }

  const direction = parseSniperDirection(post.title);
  const pivot = parseSniperPivot(post.title);

  log('INFO', `sniper-vision ${ticker} ${direction} pivot=${pivot || 'n/a'} (${post.title || ''})`);

  const verdict = await runVisionForCandidate(ticker, direction, 'SWING_SNIPER');

  // Augment verdict with Sniper-specific metadata
  verdict.sniperMsgId = post.msgId;
  verdict.sniperTitle = post.title;
  verdict.sniperPivot = pivot;
  verdict.sniperPostedAt = post.postedAt;
  verdict.source = 'local-daemon-sniper';

  // Cache locally + push to Railway
  const k = cacheKey(ticker, direction, 'SWING_SNIPER');
  cacheSet(k, verdict);
  await pushVerdictToRailway(verdict);

  return verdict;
}

// Push individual Sniper Discord notification (per fresh post)
async function sendSniperVisionAlert(post, verdict) {
  if (!verdict) return;

  const verdictEmoji = verdict.verdict === 'APPROVE' ? 'APPROVE' :
                       verdict.verdict === 'VETO'    ? 'VETO'    :
                       verdict.verdict === 'MIXED'   ? 'MIXED'   : 'WAIT';
  const color = verdict.verdict === 'APPROVE' ? 3066993 :   // green
                verdict.verdict === 'VETO'    ? 15158332 :  // red
                verdict.verdict === 'MIXED'   ? 15844367 :  // amber
                                                10070709;   // grey

  const hi = verdict.higherTf || {};
  const lo = verdict.lowerTf || {};
  const concerns = []
    .concat(hi.verdict === 'VETO' || hi.verdict === 'WAIT' ? [`${hi.tf}: ${hi.summary || ''}`] : [])
    .concat(lo.verdict === 'VETO' || lo.verdict === 'WAIT' ? [`${lo.tf}: ${lo.summary || ''}`] : [])
    .slice(0, 2);

  const pivotLine = verdict.sniperPivot ? `Pivot: $${verdict.sniperPivot}` : 'Pivot: not parsed';

  const body = {
    username: 'Vision Daemon',
    embeds: [{
      title: `SNIPER POST — ${post.ticker}`,
      description:
        `**${post.title || '(no title)'}**\n\n` +
        `**Vision verdict:** ${verdictEmoji} ${verdict.confidence}/10\n` +
        `${pivotLine}\n` +
        `Daily: ${hi.verdict || '?'} ${hi.confidence || '?'}/10\n` +
        `4HR: ${lo.verdict || '?'} ${lo.confidence || '?'}/10`,
      color: color,
      fields: concerns.length ? [
        { name: 'Concerns', value: concerns.join('\n').slice(0, 1000), inline: false },
      ] : [],
      footer: { text: `Vision Daemon · Phase 4.33 Sniper · ${post.msgId}` },
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
      log('INFO', `sniper-alert pushed for ${post.ticker} (${verdict.verdict})`);
    } else {
      const txt = await r.text().catch(() => '');
      log('WARN', `sniper-alert discord push failed ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    log('WARN', `sniper-alert discord error: ${e.message}`);
  }
}

// Main Sniper poll loop — runs every SNIPER_LOOP_MS
async function sniperLoop() {
  // Sniper posts can arrive AH/overnight — process even outside market hours
  // since we want fresh verdicts ready when AB opens the dashboard at 8 AM.
  // (Heartbeat still tells us it's running.)
  try {
    const r = await getJson(`${RAILWAY_BASE}/api/sniper-feed?limit=20`, { timeoutMs: 8000 });
    if (!r || !Array.isArray(r.posts)) {
      log('WARN', 'sniper-loop: no posts returned');
      return;
    }
    const newPosts = r.posts.filter((p) => p.msgId && !sniperSeenSet.has(String(p.msgId)));
    if (!newPosts.length) {
      // No new posts — quiet log
      return;
    }
    log('INFO', `sniper-loop: ${newPosts.length} new post(s) detected`);

    let dirty = false;
    for (const p of newPosts) {
      // Stale gate
      if (!isPostFresh(p.postedAt, SNIPER_FRESH_HOURS)) {
        log('INFO', `sniper-loop: ${p.ticker || 'UNKNOWN'} (${p.msgId}) skipped — stale (>${SNIPER_FRESH_HOURS}h)`);
        markSniperSeen(p.msgId);
        dirty = true;
        continue;
      }

      // Fresh post — queue vision run
      visionPool.run(async () => {
        try {
          const t0 = Date.now();
          const verdict = await processSniperPost(p);
          if (verdict) {
            await sendSniperVisionAlert(p, verdict);
            log('INFO', `sniper-fresh ${p.ticker}: ${verdict.verdict} ${verdict.confidence}/10 — ${(Date.now() - t0)}ms`);
          }
        } catch (e) {
          log('ERROR', `sniper post ${p.msgId} processing error: ${e.message}`);
        } finally {
          markSniperSeen(p.msgId);
          saveSniperSeen();
        }
      });
      dirty = true;
    }
    if (dirty) saveSniperSeen();
  } catch (e) {
    log('ERROR', `sniper-loop fatal: ${e.message}`);
  }
}

// One-time startup backfill — process last N posts regardless of freshness
// so AB has fresh verdicts on the most recent Sniper picks immediately.
async function sniperBackfill() {
  try {
    const r = await getJson(`${RAILWAY_BASE}/api/sniper-feed?limit=${SNIPER_BACKFILL_COUNT}`, { timeoutMs: 8000 });
    if (!r || !Array.isArray(r.posts)) {
      log('WARN', 'sniper-backfill: no posts returned');
      return;
    }
    const posts = r.posts.slice(0, SNIPER_BACKFILL_COUNT);
    log('INFO', `sniper-backfill: processing last ${posts.length} posts (one-time)`);

    const verdicts = [];

    // Process serially through the pool (let the pool gate concurrency)
    const results = await Promise.all(posts.map((p) => visionPool.run(async () => {
      try {
        const t0 = Date.now();
        const verdict = await processSniperPost(p);
        markSniperSeen(p.msgId);
        if (verdict) {
          log('INFO', `sniper-backfill ${p.ticker}: ${verdict.verdict} ${verdict.confidence}/10 — ${(Date.now() - t0)}ms`);
          return { post: p, verdict };
        }
        return null;
      } catch (e) {
        log('ERROR', `sniper-backfill ${p.ticker || p.msgId} error: ${e.message}`);
        markSniperSeen(p.msgId);
        return null;
      }
    })));

    results.forEach((res) => { if (res) verdicts.push(res); });
    saveSniperSeen();

    // Single Discord summary embed for backfill
    if (verdicts.length) {
      await sendSniperBackfillSummary(verdicts);
    }
    log('INFO', `sniper-backfill: complete (${verdicts.length}/${posts.length} verdicts)`);
  } catch (e) {
    log('ERROR', `sniper-backfill fatal: ${e.message}`);
  }
}

async function sendSniperBackfillSummary(verdictPairs) {
  const lines = verdictPairs.map(({ post, verdict }) => {
    const emoji = verdict.verdict === 'APPROVE' ? 'APPROVE' :
                  verdict.verdict === 'VETO'    ? 'VETO'    :
                  verdict.verdict === 'MIXED'   ? 'MIXED'   : 'WAIT';
    const dt = post.postedAt ? new Date(post.postedAt).toISOString().slice(5, 10) : '?';
    const pivot = verdict.sniperPivot ? `pivot $${verdict.sniperPivot}` : '';
    const summary = (verdict.summary || '').slice(0, 60);
    return `**${post.ticker}** (${dt}): vision ${emoji} ${verdict.confidence}/10 — ${pivot}${summary ? ' · ' + summary : ''}`;
  });
  const body = {
    username: 'Vision Daemon',
    embeds: [{
      title: `SNIPER VISION BACKFILL (${verdictPairs.length} most recent)`,
      description: lines.join('\n'),
      color: 3447003, // blue
      footer: { text: 'Vision Daemon · Phase 4.33 · One-time startup backfill' },
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
      log('INFO', `sniper-backfill summary embed sent (${verdictPairs.length} entries)`);
    } else {
      const txt = await r.text().catch(() => '');
      log('WARN', `sniper-backfill summary push failed ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    log('WARN', `sniper-backfill summary error: ${e.message}`);
  }
}

// =============================================================================
// PHASE 4.38 — INDEX REVERSAL WATCH (SPY / QQQ / IWM)
// -----------------------------------------------------------------------------
// AB's directive (May 5 2026 PM): SPY ATH $720→$730 in 24hr, IWM +1.80%, vol
// indices rolling — "vision-on-watch BEFORE the reversal so I don't miss the
// entry." Persistent loop independent of scanner candidates: every 5 min during
// RTH, run vision on Daily + 4HR for SHORT bias on each index. If a bearish
// reversal pattern fires:
//   1. Push Discord alert with Daily + 4HR reasoning + spot + suggested PUT
//      trigger.
//   2. Auto-create an ARMED smart conditional with TA + TAPE + VISION gates so
//      it won't fire on wicks — has to clear all gates at trigger break.
//   3. 4-hour per-ticker dedup so we don't spam.
// =============================================================================

// In-memory + on-disk dedup state
let indexReversalState = { lastAlertedAt: {} };

function loadIndexReversalState() {
  try {
    if (!fs.existsSync(INDEX_REVERSAL_FILE)) {
      log('INFO', `index-reversal: no file at ${INDEX_REVERSAL_FILE}, starting fresh`);
      return;
    }
    const raw = fs.readFileSync(INDEX_REVERSAL_FILE, 'utf8');
    const data = JSON.parse(raw);
    indexReversalState = {
      lastAlertedAt: (data && typeof data.lastAlertedAt === 'object') ? data.lastAlertedAt : {},
    };
    const counts = Object.keys(indexReversalState.lastAlertedAt).length;
    log('INFO', `index-reversal: loaded ${counts} ticker dedup entries`);
  } catch (e) {
    log('WARN', `index-reversal load error: ${e.message} — starting fresh`);
    indexReversalState = { lastAlertedAt: {} };
  }
}

function saveIndexReversalState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INDEX_REVERSAL_FILE, JSON.stringify(indexReversalState, null, 2));
  } catch (e) {
    log('WARN', `index-reversal save error: ${e.message}`);
  }
}

function indexRecentlyAlerted(ticker, hours) {
  const last = indexReversalState.lastAlertedAt[ticker];
  if (!last) return false;
  const ageMs = Date.now() - new Date(last).getTime();
  if (!isFinite(ageMs)) return false;
  return ageMs < (hours || INDEX_REVERSAL_DEDUP_HOURS) * 60 * 60 * 1000;
}

function markIndexAlerted(ticker) {
  indexReversalState.lastAlertedAt[ticker] = new Date().toISOString();
  saveIndexReversalState();
}

// Pull live spot for one or many tickers via /api/ticker-quote.
async function fetchIndexQuote(ticker) {
  const url = `${RAILWAY_BASE}/api/ticker-quote?symbols=${encodeURIComponent(ticker)}`;
  const r = await getJson(url, { timeoutMs: 6000 });
  if (!r || !r.ok || !Array.isArray(r.quotes) || !r.quotes.length) return null;
  const q = r.quotes[0];
  if (!q || !isFinite(q.last)) return null;
  return { last: q.last, prevClose: q.prevClose, pctChange: q.pctChange };
}

// Pull recent 6HR low for trigger calculation. Falls back to a % buffer below
// spot if the bars endpoint is not reachable.
async function fetchRecentSwingLow(ticker, spot) {
  try {
    const url = `${RAILWAY_BASE}/api/js-scan/debug/${encodeURIComponent(ticker)}?tf=6HR`;
    const r = await getJson(url, { timeoutMs: 8000 });
    if (r && r.ok && Array.isArray(r.classified) && r.classified.length) {
      // Use the lowest L of the last 6 classified bars (covers the recent swing)
      const recentLows = r.classified.slice(-6).map((b) => parseFloat(b.L)).filter((v) => isFinite(v));
      if (recentLows.length) return Math.min.apply(null, recentLows);
    }
  } catch (e) {
    log('WARN', `fetchRecentSwingLow ${ticker} error: ${e.message}`);
  }
  // Fallback: 0.5% below spot
  return spot * 0.995;
}

// Compute the suggested PUT trigger for a bearish reversal.
// = 0.3% below the recent swing low (break = confirmed reversal).
function computeReversalTrigger(spot, swingLow) {
  const base = isFinite(swingLow) ? swingLow : spot * 0.995;
  const trigger = base * 0.997;
  return Math.round(trigger * 100) / 100;
}

// Pick a put strike: 1 strike OTM (below spot) for SPY/QQQ ($1 strikes), IWM
// ($1 strikes too). Round down to nearest dollar.
function pickPutStrike(ticker, spot) {
  if (!isFinite(spot)) return null;
  // ETF strikes are mostly $1 increments — use floor(spot)-strikeStep for OTM
  // but stay close enough that mid is meaningful.
  const offset = ticker === 'SPY' || ticker === 'QQQ' ? 5 : 2;
  return Math.floor(spot) - offset;
}

// Compute next standard Friday at least minDTE days out, formatted YYMMDD.
function nextFridayYYMMDD(minDTE) {
  const base = new Date();
  const targetMs = base.getTime() + (minDTE || 7) * 86400000;
  let d = new Date(base.getTime());
  while (true) {
    d = new Date(d.getTime() + 86400000);
    if (d.getDay() === 5 && d.getTime() >= targetMs) break;
    if (d.getTime() - base.getTime() > 45 * 86400000) break;
  }
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

// Build TS-format option symbol: "SPY 260515P730"
function pickPutContract(ticker, spot) {
  const strike = pickPutStrike(ticker, spot);
  if (!isFinite(strike) || strike <= 0) return null;
  // Aim for ~10 day DTE — next Friday at least 7 days out.
  const yymmdd = nextFridayYYMMDD(7);
  return { symbol: `${ticker} ${yymmdd}P${strike}`, strike: strike, expiry: yymmdd };
}

// Approximate put mid for the auto-armed conditional limit. Real mid pulled at
// fire time via /api/option-mids — this is just a sane initial bound that won't
// be obviously wrong at trigger time.
function estimatedPutMid(ticker, spot, strike) {
  if (!isFinite(spot) || !isFinite(strike)) return null;
  // For a put OTM by a few %, intrinsic is ~0; rough premium = max(0.5, spot*0.005)
  const intrinsic = Math.max(0, strike - spot);
  const extrinsic = Math.max(0.5, spot * 0.005);
  const mid = intrinsic + extrinsic;
  return Math.round(mid * 100) / 100;
}

// One-shot: check ticker for bearish reversal pattern. Returns the verdict
// object plus a flag indicating whether a reversal was detected.
async function checkIndexForReversal(ticker) {
  // Run vision on Daily + 4HR for SHORT setup
  const verdict = await runVisionForCandidate(ticker, 'short', 'SWING_SNIPER');
  // SWING_SNIPER → tfMapForTradeType returns Daily + 4HR (see line ~262)

  const hi = verdict.higherTf || {};
  const lo = verdict.lowerTf || {};
  const hiText = String(hi.summary || '');
  const loText = String(lo.summary || '');

  // Reversal detected if either TF approves a SHORT setup OR either TF summary
  // mentions a bearish reversal keyword.
  const isBearishReversal = (
    hi.verdict === 'APPROVE' ||
    lo.verdict === 'APPROVE' ||
    BEARISH_REVERSAL_RE.test(hiText) ||
    BEARISH_REVERSAL_RE.test(loText)
  );

  return { verdict: verdict, isBearishReversal: isBearishReversal };
}

// Build + push Discord embed for an index reversal signal.
async function pushIndexReversalAlert(ticker, verdict, quote, trigger, contract, putMid) {
  const hi = verdict.higherTf || {};
  const lo = verdict.lowerTf || {};
  const hiText = (hi.summary || '').slice(0, 200);
  const loText = (lo.summary || '').slice(0, 200);

  const dailyConf = hi.confidence || 5;
  const fourConf = lo.confidence || 5;

  const fields = [
    { name: 'Spot', value: `$${quote.last}` + (quote.pctChange != null ? ` (${quote.pctChange >= 0 ? '+' : ''}${quote.pctChange}%)` : ''), inline: true },
    { name: 'Suggested PUT trigger', value: `$${trigger} crossing_down`, inline: true },
    { name: 'Suggested contract', value: contract ? `${contract.symbol}` : '(skipped — no strike)', inline: false },
    { name: 'Estimated cost', value: contract && putMid ? `1ct ~ $${(putMid * 100).toFixed(0)}` : 'n/a', inline: true },
    { name: `Reasoning (${hi.tf || 'Daily'})`, value: hiText || `${hi.verdict || '?'} ${dailyConf}/10`, inline: false },
    { name: `Reasoning (${lo.tf || '4HR'})`, value: loText || `${lo.verdict || '?'} ${fourConf}/10`, inline: false },
    { name: 'Action', value: 'Auto-armed smart conditional fires PUT 1ct if ' + ticker + ' drops thru $' + trigger + ' + 7 gates pass (TA + TAPE + VISION). Cancel: POST /api/smart-conditional/cancel/<id>', inline: false },
  ];

  const body = {
    username: 'Vision Daemon',
    embeds: [{
      title: `INDEX REVERSAL SIGNAL — ${ticker}`,
      description:
        `Vision detected bearish reversal pattern.\n\n` +
        `**Daily:** ${hi.verdict || '?'} ${dailyConf}/10\n` +
        `**4HR:** ${lo.verdict || '?'} ${fourConf}/10`,
      color: 15158332, // red
      fields: fields,
      footer: { text: 'Vision Daemon · Phase 4.38 · Index Reversal Watch' },
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
      log('INFO', `index-reversal alert pushed for ${ticker} (Daily ${hi.verdict || '?'} / 4HR ${lo.verdict || '?'})`);
    } else {
      const txt = await r.text().catch(() => '');
      log('WARN', `index-reversal discord push failed ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    log('WARN', `index-reversal discord error: ${e.message}`);
  }
}

// Auto-create the smart conditional. ARMED with TA + TAPE + VISION gates so
// trigger break alone doesn't fire — gates have to pass too.
async function armReversalConditional(ticker, quote, trigger, contract, putMid) {
  if (!contract || !contract.symbol || !isFinite(putMid) || putMid <= 0) {
    log('WARN', `index-reversal arm skipped for ${ticker} — missing contract or mid`);
    return null;
  }

  // 24-hour expiry from now
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Stop = 1% above current spot (i.e., if SPY pulls back to trigger but
  // recovers higher, the structural short thesis is invalidated)
  const stopPrice = Math.round(quote.last * 1.01 * 100) / 100;

  const body = {
    ticker: ticker,
    direction: 'short',
    contractSymbol: contract.symbol,
    triggerPrice: trigger,
    triggerDirection: 'crossing_down',
    stopPrice: stopPrice,
    account: 'ts-live',
    qty: 1,
    limitPrice: putMid,
    gates: ['TA', 'TAPE', 'VISION'],
    allowOverride: false,
    bracket: { stopPct: 50, tp1Pct: 25 },
    timeWindow: { start: '09:45', end: '15:00' },
    expiresAt: expiresAt,
    pattern: 'index-reversal-watch',
    source: 'index-reversal-watch',
    notes: `Auto-armed by Phase 4.38 daemon — bearish reversal pattern on ${ticker} Daily/4HR. Strike ${contract.strike}, expiry ${contract.expiry}.`,
  };

  const url = `${RAILWAY_BASE}/api/smart-conditional/add`;
  const r = await postJson(url, body, { timeoutMs: 10000 });
  if (!r.ok) {
    log('WARN', `index-reversal arm failed for ${ticker}: ${r.error || r.status} ${r.data && r.data.error ? '— ' + r.data.error : ''}`);
    return null;
  }
  if (r.data && r.data.id) {
    log('INFO', `index-reversal armed smart conditional ${r.data.id} for ${ticker} short ${contract.symbol}`);
  }
  return r.data;
}

// Main loop — runs every 5 min during RTH (and a +30 min buffer either side
// per isMarketHours).
async function indexReversalLoop() {
  if (!isMarketHours()) return;

  for (const ticker of INDEX_WATCHLIST) {
    try {
      // Gate 1: dedup window
      if (indexRecentlyAlerted(ticker, INDEX_REVERSAL_DEDUP_HOURS)) {
        // Quiet skip — no log spam every 5 min
        continue;
      }

      log('INFO', `index-reversal check ${ticker}`);
      const t0 = Date.now();

      // Gate 2: vision verdict
      let res;
      try {
        res = await checkIndexForReversal(ticker);
      } catch (e) {
        log('WARN', `index-reversal vision error ${ticker}: ${e.message}`);
        continue;
      }

      if (!res || !res.isBearishReversal) {
        log('INFO', `index-reversal ${ticker}: no reversal pattern (Daily ${res && res.verdict.higherTf && res.verdict.higherTf.verdict || '?'} / 4HR ${res && res.verdict.lowerTf && res.verdict.lowerTf.verdict || '?'}) — ${(Date.now() - t0)}ms`);
        continue;
      }

      // Gate 3: live spot
      const quote = await fetchIndexQuote(ticker);
      if (!quote || !isFinite(quote.last) || quote.last <= 0) {
        log('WARN', `index-reversal ${ticker}: no live quote — skipping`);
        continue;
      }

      // Compute trigger + contract
      const swingLow = await fetchRecentSwingLow(ticker, quote.last);
      const trigger = computeReversalTrigger(quote.last, swingLow);
      const contract = pickPutContract(ticker, quote.last);
      const putMid = contract ? estimatedPutMid(ticker, quote.last, contract.strike) : null;

      // Push Discord + arm smart conditional (mark dedup BEFORE either so a
      // partial failure still suppresses spam)
      markIndexAlerted(ticker);
      await pushIndexReversalAlert(ticker, res.verdict, quote, trigger, contract, putMid);
      await armReversalConditional(ticker, quote, trigger, contract, putMid);

      log('INFO', `index-reversal ${ticker}: REVERSAL signal handled — trigger $${trigger}, contract ${contract ? contract.symbol : 'n/a'} — ${(Date.now() - t0)}ms`);
    } catch (e) {
      log('ERROR', `index-reversal ${ticker}: ${e.message}`);
    }
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
  log('INFO', `DATA_DIR=${DATA_DIR}`);
  log('INFO', `CHART_VISION_SH=${CHART_VISION_SH}`);
  log('INFO', `TV_CLI=${TV_CLI}`);
  log('INFO', `CANDIDATE_LOOP=${CANDIDATE_LOOP_MS}ms POSITION_LOOP=${POSITION_LOOP_MS}ms HEARTBEAT=${HEARTBEAT_MS}ms SNIPER_LOOP=${SNIPER_LOOP_MS}ms INDEX_REVERSAL_LOOP=${INDEX_REVERSAL_LOOP_MS}ms`);
  log('INFO', `CONCURRENCY=${CONCURRENCY} TOP_N=${TOP_N_CANDIDATES} SNIPER_FRESH_HOURS=${SNIPER_FRESH_HOURS} SNIPER_BACKFILL_COUNT=${SNIPER_BACKFILL_COUNT}`);
  log('INFO', `INDEX_WATCHLIST=${INDEX_WATCHLIST.join(',')} INDEX_REVERSAL_DEDUP_HOURS=${INDEX_REVERSAL_DEDUP_HOURS}`);
  log('INFO', `QUIET_OUTSIDE_MARKET=${QUIET_OUTSIDE_MARKET}`);

  // Mute-noise env gates — default ON. Flip to 'off' via Railway env to
  // silence a loop without redeploying or editing code.
  const indexReversalGate = process.env.INDEX_REVERSAL_LOOP === 'off' ? 'OFF (env)' : 'ON';
  const sniperGate = process.env.SNIPER_LOOP === 'off' ? 'OFF (env)' : 'ON';
  log('INFO', `[VISION-DAEMON] index-reversal-loop: ${indexReversalGate}`);
  log('INFO', `[VISION-DAEMON] sniper-loop: ${sniperGate}`);

  // Sanity-check chart-vision.sh exists
  if (!fs.existsSync(CHART_VISION_SH)) {
    log('ERROR', `chart-vision.sh missing — daemon will idle until script is restored`);
  }

  // Phase 4.33 — hydrate Sniper-seen state from disk
  loadSniperSeen();

  // Phase 4.38 — hydrate index reversal dedup state from disk
  loadIndexReversalState();

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
  let _sniperGateMuteLogged = false;
  let _indexReversalGateMuteLogged = false;
  const sniperTick = async () => {
    if (stopRequested) return;
    if (process.env.SNIPER_LOOP === 'off') {
      if (!_sniperGateMuteLogged) {
        log('INFO', '[VISION-DAEMON] sniper-loop: tick skipped (env=off)');
        _sniperGateMuteLogged = true;
      }
      return;
    }
    _sniperGateMuteLogged = false;
    try { await sniperLoop(); } catch (e) { log('ERROR', 'sniper-loop: ' + e.message); }
  };
  const indexReversalTick = async () => {
    if (stopRequested) return;
    if (process.env.INDEX_REVERSAL_LOOP === 'off') {
      if (!_indexReversalGateMuteLogged) {
        log('INFO', '[VISION-DAEMON] index-reversal-loop: tick skipped (env=off)');
        _indexReversalGateMuteLogged = true;
      }
      return;
    }
    _indexReversalGateMuteLogged = false;
    try { await indexReversalLoop(); } catch (e) { log('ERROR', 'index-reversal-loop: ' + e.message); }
  };

  // Fire first candidate scan after 5s to let TV settle
  setTimeout(candTick, 5000);
  setTimeout(posTick, 30000);
  // Phase 4.38 — first index reversal sweep 2 min after start (after candidate
  // + position loops have warmed up TV CDP)
  setTimeout(indexReversalTick, 2 * 60 * 1000);

  // Phase 4.33 — Sniper backfill 60s after start (let TV warm up first).
  // Skip backfill if we already have a lastChecked within the last 6 hours
  // (means daemon was just restarted, not a cold install).
  const lastCheckedAge = sniperSeen.lastChecked
    ? (Date.now() - new Date(sniperSeen.lastChecked).getTime())
    : Infinity;
  const SHOULD_BACKFILL = process.env.SNIPER_FORCE_BACKFILL === 'true' ||
                          lastCheckedAge > 6 * 60 * 60 * 1000;
  if (SHOULD_BACKFILL) {
    log('INFO', `sniper-backfill scheduled (lastChecked age: ${isFinite(lastCheckedAge) ? Math.round(lastCheckedAge / 60000) + 'min' : 'never'})`);
    setTimeout(() => sniperBackfill().catch((e) => log('ERROR', 'sniper-backfill error: ' + e.message)), 60 * 1000);
  } else {
    log('INFO', `sniper-backfill skipped (lastChecked ${Math.round(lastCheckedAge / 60000)}min ago, <6hr)`);
  }

  // Sniper poll loop starts 90s after backfill (after first backfill cycle ends)
  setTimeout(sniperTick, SHOULD_BACKFILL ? 90 * 1000 : 30 * 1000);

  setInterval(candTick, CANDIDATE_LOOP_MS);
  setInterval(posTick, POSITION_LOOP_MS);
  setInterval(hbTick, HEARTBEAT_MS);
  setInterval(sniperTick, SNIPER_LOOP_MS);
  setInterval(indexReversalTick, INDEX_REVERSAL_LOOP_MS);
}

main().catch((e) => {
  log('ERROR', 'main fatal: ' + e.message);
  process.exit(1);
});
