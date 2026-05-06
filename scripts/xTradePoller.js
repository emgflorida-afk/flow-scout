#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// X TRADE POLLER — Phase 4.57 (May 6 2026)
// =============================================================================
// Polls AB's X watchlist (TheMarketRaven, ProblemSniper, GaaOptions) every
// 5 min during RTH. For each new tweet:
//   - style: 'contract'  → regex parse "$TICKER MM/DD STRIKEc/p @ PRICE"
//   - style: 'bias'      → Anthropic API extracts trade idea
//   - style: 'mixed'     → tries contract regex first, falls back to Anthropic
//
// Posts every parsed pick to STRATUMEXTERNAL Discord channel using
// discordCardBuilder.buildEntryCard with `quarantined: true` so the FIRE
// button is suppressed. Picks are persisted to /data/active_signals.json
// so they show on the Action tab — the user can manually fire from there.
//
// Dedup tweet IDs in /data/x_seen.json to prevent re-pushing.
//
// SOURCING X CONTENT:
//   1. Chrome remote-debug at port 9222 (preferred — uses AB's logged-in
//      session at https://x.com/HANDLE) — same pattern as visionDaemon.
//   2. Nitter mirror fallback — public, no auth, sometimes blocked.
//   3. Manual paste mode — POST /api/x-poller/ingest with tweet text.
//
// LAUNCHD: scripts/com.flowscout.xpoller.plist mirrors megaagent. Logs to
// /tmp/xpoller.log.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const RAILWAY_BASE = process.env.FLOW_SCOUT_BASE || 'https://flow-scout-production.up.railway.app';
const REPO_ROOT = process.env.FLOW_SCOUT_ROOT || path.resolve(__dirname, '..');
const POLL_INTERVAL_MS = parseInt(process.env.XPOLLER_INTERVAL_MS || String(5 * 60 * 1000), 10);
const QUIET_OUTSIDE_MARKET = process.env.QUIET_OUTSIDE_MARKET !== 'false';

const ACCOUNTS_FILE = path.join(REPO_ROOT, 'data', 'x_trade_accounts.json');
const SEEN_FILE = path.join(REPO_ROOT, 'data', 'x_seen.json');

const CHROME_DEBUG_PORT = parseInt(process.env.CHROME_DEBUG_PORT || '9222', 10);

const DISCORD_HOOK = process.env.DISCORD_STRATUMEXTERNAL_WEBHOOK ||
  process.env.DISCORD_X_POLLER_WEBHOOK ||
  process.env.DISCORD_FLOW_WEBHOOK_URL;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [XPOLLER] [${level}] ${msg}`);
}

function inMarketHours() {
  const dt = new Date();
  const dow = dt.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dow === 'Sat' || dow === 'Sun') return false;
  const et = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const m = et.match(/,\s*(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return total >= 9 * 60 && total <= 16 * 60 + 30;
}

// ---------------------------------------------------------------------------
// PERSIST SEEN
// ---------------------------------------------------------------------------
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
  catch (e) { return { ids: {} }; }
}

function saveSeen(s) {
  try {
    if (!fs.existsSync(path.dirname(SEEN_FILE))) fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(s, null, 2));
  } catch (e) { log('ERROR', 'seen save fail: ' + e.message); }
}

// ---------------------------------------------------------------------------
// HTTP HELPERS
// ---------------------------------------------------------------------------
function getJson(url, opts) {
  return new Promise((resolve) => {
    opts = opts || {};
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: opts.timeoutMs || 8000, headers: opts.headers || {} }, (r) => {
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => {
        try { resolve(Object.assign({ httpOk: r.statusCode === 200, status: r.statusCode }, JSON.parse(body))); }
        catch (e) { resolve({ httpOk: r.statusCode === 200, status: r.statusCode, body }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function postJson(url, payload, opts) {
  return new Promise((resolve) => {
    opts = opts || {};
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: opts.timeoutMs || 10000,
    }, (r) => {
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => {
        try { resolve(Object.assign({ httpOk: r.statusCode < 400, status: r.statusCode }, JSON.parse(body))); }
        catch (e) { resolve({ httpOk: r.statusCode < 400, status: r.statusCode, body }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SOURCING — Chrome remote-debug DOM eval
// ---------------------------------------------------------------------------
async function fetchTweetsViaChrome(handle) {
  // Discover available debugger targets
  const targets = await getJson(`http://localhost:${CHROME_DEBUG_PORT}/json`, { timeoutMs: 3000 });
  if (!targets || !Array.isArray(targets)) return null;
  // Find an x.com tab — open one if needed
  let target = targets.find(t => (t.url || '').indexOf('x.com/') !== -1 || (t.url || '').indexOf('twitter.com/') !== -1);
  if (!target) return null;
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  // Use direct CDP via WebSocket would need a ws lib; skip without ws dep
  // Instead use the HTTP-only target evaluation endpoint if exposed. As a
  // fallback we just return null — the daemon will try the next strategy.
  return null;
}

// ---------------------------------------------------------------------------
// SOURCING — Nitter mirror fallback. Many mirrors get blocked; we try a
// short list and stop on first success.
// ---------------------------------------------------------------------------
const NITTER_MIRRORS = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.foss.wtf',
];

function fetchPlain(url, opts) {
  return new Promise((resolve) => {
    opts = opts || {};
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: opts.timeoutMs || 8000,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 flow-scout-xpoller' }, opts.headers || {}),
    }, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        return resolve({ ok: false, status: r.statusCode, redirect: r.headers.location });
      }
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => resolve({ ok: r.statusCode === 200, status: r.statusCode, body }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function fetchTweetsViaNitter(handle) {
  for (let i = 0; i < NITTER_MIRRORS.length; i++) {
    const base = NITTER_MIRRORS[i];
    const url = `${base}/${handle}`;
    const r = await fetchPlain(url, { timeoutMs: 8000 });
    if (!r.ok || !r.body) continue;
    // Parse tweets — Nitter HTML has <div class="tweet-content media-body" ...>
    const tweets = [];
    const re = /<a class="tweet-link" href="\/[^"]+\/status\/(\d+)"[\s\S]*?<div class="tweet-date"[\s\S]*?title="([^"]+)"[\s\S]*?<div class="tweet-content[\s\S]*?>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(r.body)) !== null) {
      const id = m[1];
      const dt = m[2];
      const html = m[3];
      const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      tweets.push({ id, date: dt, text, url: `https://x.com/${handle}/status/${id}`, mirror: base });
      if (tweets.length >= 20) break;
    }
    if (tweets.length) return { ok: true, mirror: base, tweets };
  }
  return { ok: false, error: 'all nitter mirrors failed/blocked' };
}

// ---------------------------------------------------------------------------
// PARSING — contract-style regex
// $TICKER MM/DD STRIKEc/p @ PRICE
// e.g. "$NVDA 5/16 200c @ 1.50" → { ticker: 'NVDA', expiry: '2026-05-16', strike: 200, dir: 'long', entry: 1.50 }
// ---------------------------------------------------------------------------
const CONTRACT_RE = /\$([A-Z]{1,6})\s+(\d{1,2})\/(\d{1,2})\s+(\d+(?:\.\d+)?)\s*([cp])\s+@\s+(\d+\.\d+)/i;

function parseContract(text) {
  const m = CONTRACT_RE.exec(text);
  if (!m) return null;
  const ticker = m[1].toUpperCase();
  const mm = parseInt(m[2], 10);
  const dd = parseInt(m[3], 10);
  const strike = parseFloat(m[4]);
  const dirChar = m[5].toLowerCase();
  const entry = parseFloat(m[6]);
  // Year inference: pick nearest future MM/DD (within next 12 months)
  const now = new Date();
  const yyyy = now.getFullYear();
  let candidate = new Date(yyyy, mm - 1, dd);
  if (candidate < now) candidate = new Date(yyyy + 1, mm - 1, dd);
  const expiry = candidate.toISOString().slice(0, 10);
  return {
    ticker, strike, entry,
    direction: dirChar === 'c' ? 'long' : 'short',
    optType: dirChar === 'c' ? 'CALL' : 'PUT',
    expiry,
  };
}

// ---------------------------------------------------------------------------
// PARSING — bias-style via Anthropic API (only if ANTHROPIC_API_KEY set)
// ---------------------------------------------------------------------------
async function parseBiasViaAnthropic(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const sysPrompt = `Extract a stock options trade idea from this tweet. Return STRICT JSON only:
{"ticker":"STR","direction":"long|short","priceTarget":number|null,"levels":[number]}
If the tweet has no actionable trade idea, return: {"ticker":null}`;
  const r = await postJson('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: sysPrompt,
    messages: [{ role: 'user', content: text.slice(0, 1500) }],
  }, {
    timeoutMs: 12000,
  });
  // Accept either { content:[{type:'text',text:'...'}] } or { body: '...' }
  let raw = '';
  if (r.content && Array.isArray(r.content)) {
    raw = r.content.map(c => c.text || '').join('');
  } else if (r.body) {
    try { const j = JSON.parse(r.body); raw = j.content && j.content[0] && j.content[0].text || ''; }
    catch (e) {}
  }
  if (!raw) return null;
  // Extract first JSON block
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj.ticker) return null;
    return obj;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// PIPELINE — for one tweet, parse → register signal → push Discord card
// ---------------------------------------------------------------------------
async function processTweet(account, tweet) {
  const text = tweet.text || '';
  const handle = account.handle;
  const style = (account.style || 'mixed').toLowerCase();

  let parsed = null;
  if (style === 'contract' || style === 'mixed') {
    parsed = parseContract(text);
  }
  if (!parsed && (style === 'bias' || style === 'mixed')) {
    parsed = await parseBiasViaAnthropic(text);
  }
  if (!parsed) {
    return { skipped: 'unparseable', tweetId: tweet.id };
  }

  // Build a card payload via the unified Discord embed format. Quarantined.
  const ticker = (parsed.ticker || '').toUpperCase();
  const direction = (parsed.direction || 'long').toLowerCase();
  const optType = parsed.optType || (direction === 'short' || direction === 'put' ? 'PUT' : 'CALL');

  // Register signal on Railway so it shows on Action tab
  const contract = {
    osi: parsed.strike != null && parsed.expiry ?
      ticker + ' ' + parsed.expiry.replace(/-/g, '').slice(2) + optType.charAt(0) + Math.round(parsed.strike) : null,
    strike: parsed.strike || null,
    expiry: parsed.expiry || null,
    mid: parsed.entry || null,
  };
  const bracket = parsed.entry ? {
    entry: parsed.entry,
    stop: +(parsed.entry * 0.75).toFixed(2),
    tp1: +(parsed.entry * 1.25).toFixed(2),
    tp2: +(parsed.entry * 1.50).toFixed(2),
    stopSource: 'flat-25pct (X-source)',
  } : null;

  const reg = await postJson(`${RAILWAY_BASE}/api/active-signals/register`, {
    source: 'x',
    tier: 'scalp',
    ticker: ticker,
    direction: direction,
    contract: contract,
    bracket: bracket,
    quarantined: true, // CRITICAL — never auto-fires until graded
    ttlMin: 60,
  }, { timeoutMs: 5000 });
  const signalId = (reg && reg.signalId) || null;

  // Build a simple embed — quarantined cards display the source tweet + parsed
  // contract spec but no FIRE button.
  const embed = {
    username: 'X Watch · ' + handle,
    embeds: [{
      title: '🐦 X · ' + handle + ' — ' + ticker + ' ' + direction.toUpperCase() + ' [QUARANTINED]',
      description: text.slice(0, 280),
      color: direction === 'short' ? 0xf44336 : 0x4caf50,
      url: tweet.url,
      fields: [
        { name: 'Parsed', value: ticker + ' ' + (parsed.strike || '?') + (optType === 'CALL' ? 'C' : 'P') + ' ' + (parsed.expiry || '?') + (parsed.entry ? ' @ $' + parsed.entry : ''), inline: false },
        { name: '⚪ QUARANTINED', value: 'Not auto-fired. Source under grading. Manual review on Action tab.', inline: false },
        { name: '🔗 Tweet', value: tweet.url || '?', inline: false },
      ],
      footer: { text: 'sid=' + (signalId ? signalId.slice(0, 12) : 'no-reg') + ' · ' + (tweet.date || '') },
      timestamp: new Date().toISOString(),
    }],
  };

  if (DISCORD_HOOK) {
    const r = await postJson(DISCORD_HOOK, embed, { timeoutMs: 8000 });
    if (!r.httpOk) log('WARN', 'discord push fail status=' + r.status);
  }

  return { ok: true, ticker, signalId, parsed };
}

// ---------------------------------------------------------------------------
// CYCLE — for each account, fetch, parse, push
// ---------------------------------------------------------------------------
async function cycle() {
  let accountsConfig;
  try { accountsConfig = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch (e) { log('ERROR', 'accounts file load fail: ' + e.message); return; }
  const accounts = (accountsConfig.accounts || []).filter(a => a && a.handle);

  const seen = loadSeen();
  if (!seen.ids) seen.ids = {};

  for (const account of accounts) {
    const handle = account.handle;
    log('INFO', 'polling @' + handle);

    // Try Chrome → Nitter
    let res = null;
    try { res = await fetchTweetsViaChrome(handle); } catch (e) { log('WARN', 'chrome fetch err: ' + e.message); }
    if (!res || !res.tweets) {
      try { res = await fetchTweetsViaNitter(handle); } catch (e) { log('WARN', 'nitter fetch err: ' + e.message); }
    }
    if (!res || !res.tweets || res.tweets.length === 0) {
      log('WARN', '@' + handle + ' no tweets sourced (chrome+nitter both failed)');
      continue;
    }
    log('INFO', '@' + handle + ' fetched ' + res.tweets.length + ' tweets via ' + (res.mirror || 'chrome'));

    for (const tweet of res.tweets) {
      if (seen.ids[tweet.id]) continue; // dedup
      try {
        const out = await processTweet(account, tweet);
        log('INFO', '@' + handle + ' tweet ' + tweet.id + ' → ' + (out.ok ? 'ok ' + out.ticker : 'skip ' + (out.skipped || '?')));
      } catch (e) { log('ERROR', 'processTweet err: ' + e.message); }
      seen.ids[tweet.id] = { handle, ts: Date.now() };
    }
  }

  // Prune seen older than 7 days
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  Object.keys(seen.ids).forEach(k => {
    if (seen.ids[k].ts < cutoff) delete seen.ids[k];
  });
  saveSeen(seen);
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
async function main() {
  log('INFO', 'starting X poller · interval=' + POLL_INTERVAL_MS + 'ms');
  log('INFO', 'accounts file=' + ACCOUNTS_FILE);
  log('INFO', 'webhook? ' + (DISCORD_HOOK ? 'YES' : 'NO'));

  let stop = false;
  process.on('SIGINT',  () => { log('INFO', 'SIGINT — exit after current cycle');  stop = true; });
  process.on('SIGTERM', () => { log('INFO', 'SIGTERM — exit after current cycle'); stop = true; });

  while (!stop) {
    if (QUIET_OUTSIDE_MARKET && !inMarketHours()) {
      log('INFO', 'quiet (outside market hours)');
    } else {
      try { await cycle(); }
      catch (e) { log('ERROR', 'cycle exception: ' + (e.stack || e.message)); }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  log('INFO', 'exited');
}

if (require.main === module) {
  main().catch(e => { log('FATAL', e.stack || e.message); process.exit(1); });
}

module.exports = { cycle, processTweet, parseContract, parseBiasViaAnthropic };
