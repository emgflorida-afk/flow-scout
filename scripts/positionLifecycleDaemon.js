#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// POSITION LIFECYCLE DAEMON — TRIM/EXIT alerts on TP1/TP2/Stop hits (Phase 4.54)
// =============================================================================
// Polls open option positions on both LIVE (11975462) and SIM (SIM3142118M)
// every 30 seconds. For each position:
//
//   - Fetches latest option mid via /api/quote/option (or TS direct fallback)
//   - Compares mark vs bracket TP1, TP2, Stop persisted in active_signals
//   - On TP1 hit → posts buildTrimCard via STRATUMSWING webhook (state: trimmed)
//   - On TP2 OR Stop hit → posts buildExitCard, removes from open list
//
// Dedup: state kept in /data/active_positions.json. Each position tracks
// `trimmed: true|false` and `exited: true|false` so we never push the same
// alert twice.
//
// Designed to run on AB's MacBook (he leaves it open) via launchd:
//   ~/Library/LaunchAgents/com.flowscout.lifecycle.plist
// Logs to /tmp/lifecycle.log. KeepAlive on crash. RTH only by default.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const RAILWAY_BASE = process.env.FLOW_SCOUT_BASE || 'https://flow-scout-production.up.railway.app';
const POLL_MS = parseInt(process.env.LIFECYCLE_POLL_MS || String(30 * 1000), 10);
const QUIET_OUTSIDE_MARKET = process.env.QUIET_OUTSIDE_MARKET !== 'false';

const SIM_ACCOUNT = process.env.TS_SIM_ACCOUNT  || 'SIM3142118M';
const LIVE_ACCOUNT = process.env.TS_LIVE_ACCOUNT || '11975462';

const DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.resolve(__dirname, '..', 'data'));
const POSITIONS_FILE = path.join(DATA_ROOT, 'lifecycle_positions.json');

const DISCORD_LIFECYCLE_HOOK = process.env.DISCORD_LIFECYCLE_WEBHOOK ||
  process.env.DISCORD_STRATUMSWING_WEBHOOK ||
  process.env.DISCORD_EXECUTE_NOW_WEBHOOK;

function nowET() {
  const dt = new Date();
  const et = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const m = et.match(/,\s*(\d{1,2}):(\d{2})/);
  if (!m) return { h: 0, mins: 0 };
  const h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  return { h, mins, total: h * 60 + mins };
}

function inMarketHours() {
  const { total } = nowET();
  // Day of week: Mon-Fri only
  const dt = new Date();
  const dow = dt.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dow === 'Sat' || dow === 'Sun') return false;
  // 9:30 - 16:00 ET
  return total >= 9 * 60 + 30 && total <= 16 * 60;
}

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [LIFECYCLE] [${level}] ${msg}`);
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); }
  catch (e) { return { positions: {} }; }
}

function saveState(s) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(s, null, 2));
  } catch (e) { log('ERROR', 'state save failed: ' + e.message); }
}

// ---------------------------------------------------------------------------
// HTTP helpers — talks to Railway-hosted server
// ---------------------------------------------------------------------------
function getJson(url, opts) {
  return new Promise(function(resolve) {
    opts = opts || {};
    const fetchLib = (typeof fetch !== 'undefined') ? fetch : require(path.resolve(__dirname, '..', 'node_modules', 'node-fetch'));
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000) : null;
    fetchLib(url, ctrl ? { signal: ctrl.signal } : {})
      .then(r => { if (t) clearTimeout(t); return r.text().then(b => ({ ok: r.ok, status: r.status, body: b })); })
      .then(({ ok, status, body }) => {
        try { resolve(Object.assign({ httpOk: ok, status }, JSON.parse(body))); }
        catch (e) { resolve({ httpOk: ok, status, body }); }
      })
      .catch(e => resolve({ ok: false, error: e.message }));
  });
}

function postJson(url, payload, opts) {
  return new Promise(function(resolve) {
    opts = opts || {};
    const fetchLib = (typeof fetch !== 'undefined') ? fetch : require(path.resolve(__dirname, '..', 'node_modules', 'node-fetch'));
    fetchLib(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.text().then(b => ({ ok: r.ok, status: r.status, body: b })))
      .then(({ ok, status, body }) => {
        try { resolve(Object.assign({ httpOk: ok, status }, JSON.parse(body))); }
        catch (e) { resolve({ httpOk: ok, status, body }); }
      })
      .catch(e => resolve({ ok: false, error: e.message }));
  });
}

// ---------------------------------------------------------------------------
// Pull open positions from a TS account via Railway proxy
//
// We rely on existing Railway endpoints. If /api/positions is missing on
// Railway, fall back to /api/account/SIM3142118M/positions style.
// ---------------------------------------------------------------------------
async function fetchOpenPositions(account) {
  const tries = [
    `${RAILWAY_BASE}/api/positions?account=${encodeURIComponent(account)}`,
    `${RAILWAY_BASE}/api/account/${encodeURIComponent(account)}/positions`,
  ];
  for (let i = 0; i < tries.length; i++) {
    const r = await getJson(tries[i]);
    if (r && r.positions && Array.isArray(r.positions)) return r.positions;
    if (r && Array.isArray(r)) return r;
    if (r && r.data && Array.isArray(r.data)) return r.data;
  }
  return [];
}

async function fetchOptionMid(symbol) {
  const r = await getJson(`${RAILWAY_BASE}/api/quote/option?symbol=${encodeURIComponent(symbol)}`);
  if (r && r.mid != null) return Number(r.mid);
  if (r && r.last != null) return Number(r.last);
  if (r && r.bid != null && r.ask != null) return (Number(r.bid) + Number(r.ask)) / 2;
  return null;
}

// ---------------------------------------------------------------------------
// Discord push — uses cardBuilder server-side via /api/discord-card endpoint
// or builds a simpler embed if endpoint missing. Posts to lifecycle webhook.
// ---------------------------------------------------------------------------
async function postLifecycleCard(card) {
  if (!DISCORD_LIFECYCLE_HOOK) {
    log('WARN', 'no DISCORD_LIFECYCLE_WEBHOOK / DISCORD_STRATUMSWING_WEBHOOK / DISCORD_EXECUTE_NOW_WEBHOOK — skipping push');
    return false;
  }
  const r = await postJson(DISCORD_LIFECYCLE_HOOK, card, { timeoutMs: 8000 });
  if (!r.httpOk) {
    log('WARN', `discord push fail status=${r.status} body=${(r.body || '').slice(0, 200)}`);
    return false;
  }
  return true;
}

function buildSimpleTrimEmbed(p, mark) {
  const dollarGain = (p.entryPrice && mark != null) ? ((mark - p.entryPrice) * p.qty * 100).toFixed(0) : '?';
  const pctGain = (p.entryPrice && mark != null) ? (((mark - p.entryPrice) / p.entryPrice) * 100).toFixed(1) : '?';
  return {
    username: 'Stratum LIFECYCLE',
    embeds: [{
      title: '✂️ TRIM — ' + p.ticker + ' TP1 HIT',
      color: 0x4caf50,
      fields: [
        { name: 'Mark', value: mark != null ? '$' + mark.toFixed(2) : '?', inline: true },
        { name: 'Gain', value: pctGain + '% · $' + dollarGain, inline: true },
        { name: 'Account', value: p.account || '?', inline: true },
        { name: 'Symbol', value: p.optionSymbol || (p.ticker + ' ' + (p.expiry || '?') + ' $' + p.strike), inline: false },
        { name: 'Next', value: 'Trail stop to entry. Runner is on. TP2 ' + (p.tp2 != null ? '$' + Number(p.tp2).toFixed(2) : 'open') + '.', inline: false },
      ],
      footer: { text: 'Bill-money locked · 1 ct sold · 1 ct runs' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildSimpleExitEmbed(p, mark, reason) {
  const dollarPL = (p.entryPrice && mark != null) ? ((mark - p.entryPrice) * p.qty * 100) : null;
  const pctPL = (p.entryPrice && mark != null) ? (((mark - p.entryPrice) / p.entryPrice) * 100).toFixed(1) : null;
  const win = dollarPL != null && dollarPL > 0;
  return {
    username: 'Stratum LIFECYCLE',
    embeds: [{
      title: (win ? '✅' : '🛑') + ' EXIT — ' + p.ticker + ' (' + reason + ')',
      color: win ? 0x4caf50 : 0xf44336,
      fields: [
        { name: 'Reason', value: String(reason).toUpperCase(), inline: true },
        { name: 'Account', value: p.account || '?', inline: true },
        { name: 'P/L', value: dollarPL != null ? ((dollarPL > 0 ? '+' : '') + '$' + dollarPL.toFixed(0) + ' (' + pctPL + '%)') : '?', inline: true },
        { name: 'Mark', value: mark != null ? '$' + mark.toFixed(2) : '?', inline: true },
        { name: 'Entry', value: p.entryPrice ? '$' + Number(p.entryPrice).toFixed(2) : '?', inline: true },
        { name: 'Symbol', value: p.optionSymbol || '?', inline: false },
      ],
      footer: { text: 'Closed · ' + reason },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ---------------------------------------------------------------------------
// Cycle — pulls /api/active-signals to find what's tracked, then polls each
// account's open positions and matches symbols.
// ---------------------------------------------------------------------------
async function cycle() {
  if (QUIET_OUTSIDE_MARKET && !inMarketHours()) {
    return; // silent
  }

  const state = loadState();

  // Pull active signals (created by quick-fire / megaWatchAgent / john pusher)
  const signalsRes = await getJson(`${RAILWAY_BASE}/api/active-signals`);
  const signals = (signalsRes && signalsRes.signals) || [];
  const firedSignals = signals.filter(s => s.fired);

  // For each account
  for (const account of [SIM_ACCOUNT, LIVE_ACCOUNT]) {
    let positions;
    try { positions = await fetchOpenPositions(account); }
    catch (e) { log('WARN', 'fetch positions ' + account + ' failed: ' + e.message); continue; }
    if (!positions || positions.length === 0) continue;

    for (const pos of positions) {
      // Symbol normalization — TS uses "NVDA 260516C200" or "NVDA260516C00200000"
      const symbol = pos.Symbol || pos.symbol || pos.optionSymbol || pos.osi;
      if (!symbol) continue;

      // Try to match against a fired signal
      const matched = firedSignals.find(s => {
        if (!s.contract) return false;
        if (s.contract.osi && symbol.indexOf(s.contract.osi) === 0) return true;
        if (s.ticker && symbol.indexOf(s.ticker) === 0 && s.contract.strike != null
            && symbol.indexOf(String(Math.round(s.contract.strike))) !== -1) return true;
        return false;
      });

      const tracked = matched ? Object.assign({
        ticker: matched.ticker,
        direction: matched.direction,
        bracket: matched.bracket || {},
        contract: matched.contract || {},
        signalId: matched.id,
      }, pos) : { ticker: (symbol.split(' ')[0] || symbol), bracket: {}, contract: {}, optionSymbol: symbol };

      const stateKey = account + '|' + symbol;
      const prior = state.positions[stateKey] || { trimmed: false, exited: false };
      if (prior.exited) continue;

      // Determine entry price + qty
      const entryPrice = parseFloat(pos.AveragePrice || pos.entryPrice || matched && matched.bracket && matched.bracket.entry || 0);
      const qty = parseInt(pos.Quantity || pos.qty || 1, 10);

      // Pull current mark
      let mark = null;
      const markCandidate = parseFloat(pos.MarkToMarket || pos.markPrice || pos.mid || pos.last);
      if (isFinite(markCandidate) && markCandidate > 0) mark = markCandidate;
      if (mark == null) mark = await fetchOptionMid(symbol);
      if (mark == null) continue;

      // Bracket — tp1, tp2, stop
      const tp1 = matched && matched.bracket && matched.bracket.tp1 != null ? Number(matched.bracket.tp1) : null;
      const tp2 = matched && matched.bracket && matched.bracket.tp2 != null ? Number(matched.bracket.tp2) : null;
      const stop = matched && matched.bracket && matched.bracket.stop != null ? Number(matched.bracket.stop) : null;

      // Decide event: TP2 or Stop trumps TP1 (for cases where price moved fast)
      let event = null;
      let reason = null;
      if (tp2 != null && mark >= tp2) { event = 'EXIT'; reason = 'TP2 hit'; }
      else if (stop != null && mark <= stop) { event = 'EXIT'; reason = 'STOP hit'; }
      else if (!prior.trimmed && tp1 != null && mark >= tp1) { event = 'TRIM'; reason = 'TP1 hit'; }

      if (!event) continue;

      const enrichedPos = {
        ticker: tracked.ticker,
        direction: tracked.direction,
        account: account,
        optionSymbol: symbol,
        entryPrice: entryPrice,
        qty: qty,
        strike: tracked.contract && tracked.contract.strike,
        expiry: tracked.contract && tracked.contract.expiry,
        tp1: tp1, tp2: tp2, stop: stop,
      };

      let card;
      if (event === 'TRIM') card = buildSimpleTrimEmbed(enrichedPos, mark);
      else card = buildSimpleExitEmbed(enrichedPos, mark, reason);

      const sent = await postLifecycleCard(card);
      log('INFO', `${event} fired for ${symbol} on ${account}: ${reason} (mark $${mark.toFixed(2)}, sent=${sent})`);

      // Update state
      if (event === 'TRIM') {
        state.positions[stateKey] = Object.assign(prior, { trimmed: true, trimmedAt: new Date().toISOString(), trimMark: mark });
      } else {
        state.positions[stateKey] = Object.assign(prior, { exited: true, exitedAt: new Date().toISOString(), exitReason: reason, exitMark: mark });
      }
      saveState(state);
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
async function main() {
  log('INFO', 'starting position lifecycle daemon · poll=' + POLL_MS + 'ms · base=' + RAILWAY_BASE);
  log('INFO', `accounts: SIM=${SIM_ACCOUNT} LIVE=${LIVE_ACCOUNT}`);

  let stop = false;
  function shutdown(sig) {
    log('INFO', 'received ' + sig + ' — shutting down after current cycle');
    stop = true;
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!stop) {
    try { await cycle(); }
    catch (e) { log('ERROR', 'cycle exception: ' + (e.stack || e.message)); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log('INFO', 'exited');
}

if (require.main === module) {
  main().catch(e => { log('FATAL', e.stack || e.message); process.exit(1); });
}

module.exports = { cycle, fetchOpenPositions, fetchOptionMid };
