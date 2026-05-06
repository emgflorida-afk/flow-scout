// =============================================================================
// johnLikePusher.js — Pushes generated John-VIP-style picks to Discord using
// the unified discordCardBuilder. Phase 4.55.
// =============================================================================
// johnLikePicker.generate() emits picks like:
//   { ticker, direction, contract:{ strike, expiry, dte, triggerPrice, stopPrice, optDir, tpLevels:[25,50,100] }, structuralLabel, historicalWinRate, ... }
//
// This module:
//   1. Optionally enriches each pick with current option mid/bid/ask via
//      contractResolver.getOptionSnapshot when TS token is available.
//   2. Persists the signal via discordCardBuilder.persistSignal so /quick-fire
//      buttons can route the order.
//   3. Posts the embed to DISCORD_STRATUMEXTERNAL_WEBHOOK channel.
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');
var dp = null;
try { dp = require('./discordPush'); } catch (e) {}
var cb = require('./discordCardBuilder');
var resolver = null;
try { resolver = require('./contractResolver'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'john_pushed_state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { pushed: {} }; }
}

function saveState(s) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('[JLP-PUSH] state save failed:', e.message); }
}

function pickKey(p) {
  var c = p.contract || {};
  return [p.ticker, p.direction, c.strike, c.expiry].join('|');
}

function buildOSI(ticker, expiry, optType, strike) {
  // John picks store expiry as "2026-05-16". Convert to "260516" (YYMMDD).
  if (!expiry || !ticker || !optType || strike == null) return null;
  var d = String(expiry).replace(/-/g, '');
  if (d.length === 8) d = d.slice(2); // YYYYMMDD → YYMMDD
  if (d.length !== 6) return null;
  // OSI uses round strikes in OPRA. Stratum's orderExecutor accepts symbol as
  // "TICKER YYMMDDXSTRIKE" (e.g. "NVDA 260516C200")
  var t = String(optType).toUpperCase().charAt(0); // C or P
  return ticker + ' ' + d + t + Math.round(strike);
}

async function enrichWithMid(p) {
  // Enrich pick with current bid/ask/mid if resolver is available
  if (!p.contract) return p;
  if (p.contract.mid != null && p.contract.bid != null) return p;
  if (!resolver || !resolver.getOptionSnapshot) return p;
  try {
    var snap = await resolver.getOptionSnapshot({
      ticker: p.ticker,
      expiry: p.contract.expiry,
      strike: p.contract.strike,
      type: p.contract.optDir || (p.direction === 'short' || p.direction === 'put' ? 'PUT' : 'CALL'),
    });
    if (snap && (snap.mid != null || snap.last != null)) {
      p.contract.mid = snap.mid != null ? snap.mid : (snap.last || 0);
      p.contract.bid = snap.bid != null ? snap.bid : 0;
      p.contract.ask = snap.ask != null ? snap.ask : 0;
      p.contract.vol = snap.volume || 0;
      p.contract.oi  = snap.openInterest || 0;
    }
  } catch (e) { /* soft fail — we'll push without pricing */ }
  return p;
}

// pushPick(pick) → builds card, persists signal, sends Discord.
// Returns { ok, signalId, deduped }.
async function pushPick(pick) {
  var key = pickKey(pick);
  var state = loadState();
  if (state.pushed[key]) {
    var since = Date.now() - new Date(state.pushed[key]).getTime();
    // 6 hour dedup
    if (since < 6 * 60 * 60 * 1000) return { ok: true, deduped: true, key: key };
  }

  await enrichWithMid(pick);

  var c = pick.contract || {};
  var optType = (c.optDir && c.optDir.toUpperCase().charAt(0)) ||
    ((pick.direction === 'short' || pick.direction === 'put') ? 'P' : 'C');
  var osi = buildOSI(pick.ticker, c.expiry, optType, c.strike);

  // Bracket — translate stop/TP to option dollars where possible. Picks store
  // stop as STOCK price (3% buffer) and TP levels as % gains [25,50,100].
  var mid = Number(c.mid || 0);
  var bracket = {
    entry: mid || c.triggerPrice || null,
    stop: mid > 0 ? +(mid * 0.75).toFixed(2) : null,           // 25% premium loss
    tp1:  mid > 0 ? +(mid * 1.25).toFixed(2) : null,
    tp2:  mid > 0 ? +(mid * 1.50).toFixed(2) : null,
    stopSource: 'flat-25pct (john profile)',
    holdRule: 'Hold target ' + (c.tpLevels ? c.tpLevels.join('/') + '%' : '+25/+50/+100%'),
  };

  var card = cb.buildEntryCard({
    source: 'john',
    tier: c.dte && c.dte <= 7 ? 'scalp' : 'swing',
    ticker: pick.ticker,
    direction: pick.direction,
    stockSpot: c.triggerPrice || null,
    contract: {
      osi: osi,
      strike: c.strike,
      expiry: c.expiry,
      mid: mid,
      bid: c.bid,
      ask: c.ask,
      vol: c.vol || 0,
      oi:  c.oi  || 0,
    },
    bracket: bracket,
    scannerSetup: pick.structuralLabel +
      (pick.historicalWinRate != null ? ' · ' + Math.round(pick.historicalWinRate * 100) + '% hist hit-rate (' + (pick.historicalSampleSize || '?') + ' samples)' : ''),
    ttlMin: 60 * 8, // John picks valid through next session
  });

  var hook = process.env.DISCORD_STRATUMEXTERNAL_WEBHOOK ||
    process.env.DISCORD_JSMITH_WEBHOOK ||
    process.env.DISCORD_FLOW_WEBHOOK_URL;
  var result = { ok: true, sent: false };
  if (dp && hook) {
    result = await dp.send('johnLikePicks', card, { webhook: hook });
  }

  state.pushed[key] = new Date().toISOString();
  saveState(state);

  return { ok: result.ok !== false, signalId: card.signalId, sent: !!(result && result.ok) };
}

// pushAllLatest() pulls cached picks (johnLikePicker.loadLatest) + pushes each
async function pushAllLatest(opts) {
  opts = opts || {};
  var johnLikePicker = require('./johnLikePicker');
  var data = johnLikePicker.loadLatest();
  if (!data || !Array.isArray(data.picks)) return { ok: false, error: 'no cached john picks' };
  var picks = data.picks.slice(0, opts.max || 10);
  var results = [];
  for (var i = 0; i < picks.length; i++) {
    try { results.push(await pushPick(picks[i])); }
    catch (e) { results.push({ ok: false, error: e.message, ticker: picks[i].ticker }); }
  }
  return { ok: true, count: results.length, results: results };
}

module.exports = {
  pushPick: pushPick,
  pushAllLatest: pushAllLatest,
  buildOSI: buildOSI,
  enrichWithMid: enrichWithMid,
  pickKey: pickKey,
};
