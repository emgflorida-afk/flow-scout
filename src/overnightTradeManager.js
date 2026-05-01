// =============================================================================
// OVERNIGHT TRADE MANAGER (May 1 2026)
//
// Tracks open option positions across Public.com + TradeStation through
// weekend/overnight holds. Two cron firings:
//
//   FRIDAY 4:05 PM ET — snapshot positions, compute theta decay, post Discord
//   MONDAY 9:25 AM ET — pull pre-market quotes, compute exit plan, post Discord
//
// Pulls from publicBroker.getPortfolio() — Public positions are first-class
// supported. TS positions tracked via positionManager (best-effort).
//
// Output JSON: /data/overnight_positions.json
// Discord webhook: DISCORD_OVERNIGHT_WEBHOOK or fallback DISCORD_STRATUMSWING_WEBHOOK
// =============================================================================

var fs = require('fs');
var path = require('path');

var publicBroker = null;
try { publicBroker = require('./public'); }
catch (e) { console.log('[OVERNIGHT] publicBroker not loaded:', e.message); }

var positionManager = null;
try { positionManager = require('./positionManager'); }
catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var OVERNIGHT_FILE = path.join(DATA_ROOT, 'overnight_positions.json');
var DISCORD_WEBHOOK = process.env.DISCORD_OVERNIGHT_WEBHOOK || process.env.DISCORD_STRATUMSWING_WEBHOOK || null;

// =============================================================================
// OPRA SYMBOL PARSING
// =============================================================================
function parseOpra(sym) {
  if (!sym) return null;
  var s = String(sym).replace(/\s+/g, '');
  // Pattern: TICKER + YYMMDD + C/P + 8-digit strike
  var m = s.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  var ticker = m[1];
  var yy = parseInt(m[2].slice(0,2), 10);
  var mm = parseInt(m[2].slice(2,4), 10);
  var dd = parseInt(m[2].slice(4,6), 10);
  var type = m[3] === 'C' ? 'CALL' : 'PUT';
  var strike = parseInt(m[4], 10) / 1000;
  // Convert to JS Date in ET (use noon to avoid boundary issues)
  var expiry = new Date(2000 + yy, mm - 1, dd, 16, 0);
  var dte = Math.max(0, Math.round((expiry - Date.now()) / (1000 * 60 * 60 * 24)));
  return {
    ticker: ticker,
    expiry: expiry.toISOString().slice(0, 10),
    type: type,
    strike: strike,
    dte: dte,
  };
}

// =============================================================================
// WEEKEND THETA ESTIMATE
// Weekend decay is roughly: 1.5-2× normal daily theta (markets pricing it in
// progressively over Fri close + Mon open). For options without explicit theta:
// approximate via Black-Scholes-ish heuristic using DTE.
// =============================================================================
function estimateDailyTheta(currentPrice, dte) {
  // Rough: at-the-money option daily theta ≈ price / sqrt(2 × DTE × 365)
  // Wait — simpler heuristic: theta_daily ≈ -(price * 0.5) / DTE for ATM
  // We're estimating, not pricing exactly. For a 7DTE @ $2.00, theta ~$0.07/day
  if (!dte || dte <= 0) return -currentPrice;
  if (dte > 60) return -currentPrice * 0.005;   // slow decay for far-dated
  if (dte > 30) return -currentPrice * 0.012;
  if (dte > 14) return -currentPrice * 0.025;
  if (dte > 7)  return -currentPrice * 0.045;
  if (dte > 3)  return -currentPrice * 0.085;
  return -currentPrice * 0.15;   // 0-3 DTE = brutal
}

function estimateWeekendDecay(currentPrice, dte) {
  // Friday close → Monday open = ~3 calendar days, but markets price in
  // ~1.5-2× a daily theta unit.
  var dailyTheta = estimateDailyTheta(currentPrice, dte);
  return dailyTheta * 1.8;  // weekend friction
}

// =============================================================================
// FRIDAY SNAPSHOT
// =============================================================================
async function snapshotPositions(opts) {
  opts = opts || {};
  var snapshotAt = new Date().toISOString();
  var positions = [];
  var errors = [];

  // PUBLIC positions
  if (publicBroker) {
    try {
      var portfolio = await publicBroker.getPortfolio();
      var pubPositions = (portfolio && portfolio.positions) || [];
      pubPositions.forEach(function(p) {
        var sym = p.instrument && p.instrument.symbol;
        var instrumentType = p.instrument && p.instrument.type;
        var qty = parseInt(p.quantity || 0, 10);
        if (!sym || !qty) return;
        var avgPrice = parseFloat(p.averagePrice || p.costBasis || 0);
        var currentPrice = parseFloat(p.lastPrice || p.marketPrice || avgPrice);
        var pnlPerCt = (currentPrice - avgPrice) * (instrumentType === 'OPTION' ? 100 : 1);
        var pnlTotal = pnlPerCt * qty;

        var pos = {
          broker: 'public',
          symbol: sym,
          instrumentType: instrumentType,
          qty: qty,
          avgPrice: avgPrice,
          currentPrice: currentPrice,
          mtmPnl: Math.round(pnlTotal * 100) / 100,
        };

        if (instrumentType === 'OPTION') {
          var parsed = parseOpra(sym);
          if (parsed) {
            pos.ticker = parsed.ticker;
            pos.strike = parsed.strike;
            pos.expiry = parsed.expiry;
            pos.optionType = parsed.type;
            pos.dte = parsed.dte;
            pos.weekendDecay = Math.round(estimateWeekendDecay(currentPrice, parsed.dte) * 100) / 100;
            pos.weekendDecayPct = currentPrice > 0 ? Math.round((pos.weekendDecay / currentPrice) * 1000) / 10 : 0;
          }
        } else {
          pos.ticker = sym;
        }
        positions.push(pos);
      });
    } catch (e) {
      errors.push({ broker: 'public', error: e.message });
    }
  }

  // TS positions (best-effort — positionManager may have a getter)
  if (positionManager && typeof positionManager.getPositions === 'function') {
    try {
      var tsPositions = await positionManager.getPositions();
      (tsPositions || []).forEach(function(p) {
        // positionManager format may differ; normalize what we have
        var sym = p.symbol || p.opra || p.contract;
        if (!sym) return;
        var pos = {
          broker: 'ts',
          symbol: sym,
          instrumentType: 'OPTION',
          qty: p.qty || p.quantity || 0,
          avgPrice: parseFloat(p.entry || p.avgPrice || 0),
          currentPrice: parseFloat(p.last || p.currentPrice || p.entry || 0),
          mtmPnl: parseFloat(p.pnl || 0),
        };
        var parsed = parseOpra(sym);
        if (parsed) {
          pos.ticker = parsed.ticker;
          pos.strike = parsed.strike;
          pos.expiry = parsed.expiry;
          pos.optionType = parsed.type;
          pos.dte = parsed.dte;
          pos.weekendDecay = Math.round(estimateWeekendDecay(pos.currentPrice, parsed.dte) * 100) / 100;
          pos.weekendDecayPct = pos.currentPrice > 0 ? Math.round((pos.weekendDecay / pos.currentPrice) * 1000) / 10 : 0;
        }
        positions.push(pos);
      });
    } catch (e) {
      errors.push({ broker: 'ts', error: e.message });
    }
  }

  var snapshot = {
    snapshotAt: snapshotAt,
    isFridayClose: opts.fridayClose === true,
    positions: positions,
    errors: errors,
    totalPositions: positions.length,
    totalNotional: positions.reduce(function(acc, p) {
      return acc + (p.qty * p.currentPrice * (p.instrumentType === 'OPTION' ? 100 : 1));
    }, 0),
    totalMtm: positions.reduce(function(acc, p) { return acc + (p.mtmPnl || 0); }, 0),
    totalWeekendDecay: positions
      .filter(function(p) { return p.instrumentType === 'OPTION'; })
      .reduce(function(acc, p) { return acc + ((p.weekendDecay || 0) * p.qty * 100); }, 0),
  };

  try { fs.writeFileSync(OVERNIGHT_FILE, JSON.stringify(snapshot, null, 2)); }
  catch (e) { console.warn('[OVERNIGHT] write fail:', e.message); }

  return snapshot;
}

// =============================================================================
// MONDAY EXIT PLAN — pulls pre-market quotes, builds exit recommendations
// =============================================================================
async function buildExitPlan(opts) {
  opts = opts || {};
  var snapshot;
  if (opts.snapshot) {
    snapshot = opts.snapshot;
  } else {
    if (!fs.existsSync(OVERNIGHT_FILE)) return { error: 'no overnight snapshot yet' };
    snapshot = JSON.parse(fs.readFileSync(OVERNIGHT_FILE, 'utf8'));
  }

  if (!snapshot.positions || !snapshot.positions.length) {
    return { ok: true, plan: [], note: 'no overnight positions' };
  }

  var optionPositions = snapshot.positions.filter(function(p) { return p.instrumentType === 'OPTION'; });
  if (!optionPositions.length) return { ok: true, plan: [], note: 'no option positions' };

  // Pull pre-market quotes for each underlying ticker
  var tickers = Array.from(new Set(optionPositions.map(function(p) { return p.ticker; }).filter(Boolean)));
  var quotes = {};

  if (publicBroker) {
    try {
      // Public's getQuotes for equities
      var qresp = await publicBroker.getQuotes(tickers);
      var qarr = (qresp && qresp.quotes) || [];
      qarr.forEach(function(q) {
        var sym = q.instrument && q.instrument.symbol;
        if (!sym) return;
        quotes[sym] = {
          last: parseFloat(q.lastPrice || q.last || 0),
          bid: parseFloat(q.bid || 0),
          ask: parseFloat(q.ask || 0),
          source: 'public',
        };
      });
    } catch (e) {
      console.warn('[OVERNIGHT] quote fetch fail:', e.message);
    }
  }

  var plan = optionPositions.map(function(p) {
    var underlyingQuote = quotes[p.ticker] || {};
    var currentSpot = underlyingQuote.last || null;
    var entryPrice = p.avgPrice;
    var prevClosePrice = p.currentPrice;

    // Estimate option premium at current pre-market spot using delta heuristic
    var deltaEstimate = estimateDelta(p);
    var spotDelta = currentSpot && entryPrice ? (currentSpot - (p.openSpot || currentSpot)) : 0;
    var estimatedOptionPrice = currentSpot
      ? Math.max(0.01, prevClosePrice + (spotDelta * deltaEstimate))
      : prevClosePrice;

    var pnlPerCt = (estimatedOptionPrice - entryPrice) * 100;
    var pnlPctOnEntry = entryPrice > 0 ? ((estimatedOptionPrice - entryPrice) / entryPrice) * 100 : 0;

    // Action recommendation
    var action = 'HOLD';
    var reason = '';
    if (pnlPctOnEntry >= 50) {
      action = 'TRIM AGGRESSIVELY';
      reason = '+' + pnlPctOnEntry.toFixed(0) + '% on premium — lock the win, runner only';
    } else if (pnlPctOnEntry >= 20) {
      action = 'TRIM 50%';
      reason = '+' + pnlPctOnEntry.toFixed(0) + '% pre-mkt — pay yourself, hold runner';
    } else if (pnlPctOnEntry >= 0) {
      action = 'HOLD';
      reason = 'Flat to slightly positive — let it work into RTH';
    } else if (pnlPctOnEntry >= -25) {
      action = 'WATCH';
      reason = pnlPctOnEntry.toFixed(0) + '% — held overnight, watch open structure';
    } else {
      action = 'CUT AT OPEN';
      reason = pnlPctOnEntry.toFixed(0) + '% — overnight invalidation, reduce loss';
    }

    return {
      symbol: p.symbol,
      ticker: p.ticker,
      strike: p.strike,
      expiry: p.expiry,
      type: p.optionType,
      qty: p.qty,
      entryPrice: entryPrice,
      prevClosePrice: prevClosePrice,
      currentSpot: currentSpot,
      estimatedOptionPrice: Math.round(estimatedOptionPrice * 100) / 100,
      pnlPerCt: Math.round(pnlPerCt * 100) / 100,
      pnlPctOnEntry: Math.round(pnlPctOnEntry * 10) / 10,
      action: action,
      reason: reason,
      weekendDecay: p.weekendDecay,
    };
  });

  return {
    ok: true,
    builtAt: new Date().toISOString(),
    plan: plan,
    snapshotAt: snapshot.snapshotAt,
  };
}

// Quick delta heuristic (we don't have real Greeks from Public)
function estimateDelta(p) {
  if (!p || !p.strike || !p.dte) return 0.5;
  // ATM = ~0.5; estimate moneyness from strike vs current
  // Without spot, fall back to 0.5
  return 0.5;
}

// =============================================================================
// DISCORD PUSH
// =============================================================================
async function pushDiscordSnapshot(snapshot) {
  if (!DISCORD_WEBHOOK) return { skipped: 'no webhook' };
  if (!snapshot.positions.length) return { skipped: 'no positions' };
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var lines = [];
  lines.push('# 🌙 OVERNIGHT POSITIONS — Friday Close');
  lines.push('_' + new Date(snapshot.snapshotAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + snapshot.totalPositions + ' positions over weekend_');
  lines.push('');

  snapshot.positions.forEach(function(p) {
    var pnlSign = p.mtmPnl >= 0 ? '+' : '';
    var pnlEmoji = p.mtmPnl >= 0 ? '🟢' : '🔴';
    if (p.instrumentType === 'OPTION') {
      lines.push('**' + p.ticker + '** ' + (p.optionType || '?') + ' $' + p.strike + ' ' + p.expiry + ' · ' + p.broker.toUpperCase());
      lines.push('  Qty `' + p.qty + 'ct` · Entry `$' + (p.avgPrice||0).toFixed(2) + '` · Now `$' + (p.currentPrice||0).toFixed(2) + '` ' + pnlEmoji + ' `' + pnlSign + '$' + (p.mtmPnl||0).toFixed(0) + '`');
      lines.push('  📉 Weekend theta est: `~$' + (p.weekendDecay || 0).toFixed(2) + '` per ct (' + (p.weekendDecayPct || 0).toFixed(1) + '%) · DTE Mon: `' + Math.max(0, (p.dte || 0) - 3) + '`');
    } else {
      lines.push('**' + p.ticker + '** EQUITY · ' + p.broker.toUpperCase());
      lines.push('  Qty `' + p.qty + ' sh` · Avg `$' + (p.avgPrice||0).toFixed(2) + '` · Now `$' + (p.currentPrice||0).toFixed(2) + '` ' + pnlEmoji + ' `' + pnlSign + '$' + (p.mtmPnl||0).toFixed(0) + '`');
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('💼 Total notional: `$' + snapshot.totalNotional.toFixed(0) + '` · MtM: `' + (snapshot.totalMtm >= 0 ? '+' : '') + '$' + snapshot.totalMtm.toFixed(0) + '`');
  lines.push('📉 Est weekend decay: `' + snapshot.totalWeekendDecay.toFixed(0) + '` total option dollars');
  lines.push('🌅 Monday 9:25 AM exit plan auto-posts here');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'Overnight Trade Manager' }),
    });
    if (!r.ok) return { error: 'discord-' + r.status };
    return { posted: true, count: snapshot.totalPositions };
  } catch (e) { return { error: e.message }; }
}

async function pushDiscordExitPlan(planResult) {
  if (!DISCORD_WEBHOOK) return { skipped: 'no webhook' };
  if (!planResult.plan || !planResult.plan.length) return { skipped: 'no plan' };
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

  var lines = [];
  lines.push('# 🌅 MONDAY EXIT PLAN — 9:25 AM Pre-Market');
  lines.push('_' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET · ' + planResult.plan.length + ' positions to manage_');
  lines.push('');

  planResult.plan.forEach(function(p) {
    var pnlSign = p.pnlPctOnEntry >= 0 ? '+' : '';
    var pnlEmoji = p.pnlPctOnEntry >= 50 ? '🚀' : p.pnlPctOnEntry >= 20 ? '🟢' : p.pnlPctOnEntry >= 0 ? '🟡' : p.pnlPctOnEntry >= -25 ? '🟠' : '🔴';
    var actionEmoji = p.action.includes('TRIM') ? '✂️' : p.action.includes('CUT') ? '🛑' : p.action === 'WATCH' ? '👁️' : '✋';

    lines.push('**' + p.ticker + '** ' + (p.type || '?') + ' $' + p.strike + ' (' + p.qty + 'ct)');
    lines.push('  Entry `$' + p.entryPrice.toFixed(2) + '` · Fri close `$' + p.prevClosePrice.toFixed(2) + '` · Mon est `$' + p.estimatedOptionPrice.toFixed(2) + '` ' + pnlEmoji + ' `' + pnlSign + p.pnlPctOnEntry.toFixed(0) + '%`');
    lines.push('  ' + actionEmoji + ' **' + p.action + '** · ' + p.reason);
    if (p.currentSpot) lines.push('  Underlying pre-mkt: `$' + p.currentSpot.toFixed(2) + '`');
    lines.push('');
  });

  lines.push('---');
  lines.push('🕒 Markets open 9:30 ET · execute exits in first 5-15 min based on tape');

  var content = lines.join('\n');
  if (content.length > 1900) content = content.slice(0, 1880) + '\n…(truncated)';

  try {
    var r = await fetchLib(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, username: 'Overnight Trade Manager' }),
    });
    if (!r.ok) return { error: 'discord-' + r.status };
    return { posted: true, count: planResult.plan.length };
  } catch (e) { return { error: e.message }; }
}

// =============================================================================
// CRON ENTRY POINTS
// =============================================================================
async function runFridaySnapshot() {
  console.log('[OVERNIGHT] Friday close snapshot starting...');
  var snap = await snapshotPositions({ fridayClose: true });
  console.log('[OVERNIGHT] snapshot: ' + snap.totalPositions + ' positions, $' + snap.totalNotional.toFixed(0) + ' notional');
  if (snap.totalPositions > 0) {
    var push = await pushDiscordSnapshot(snap);
    if (push.posted) console.log('[OVERNIGHT] Discord snapshot posted');
    else if (push.error) console.warn('[OVERNIGHT] Discord push failed:', push.error);
  }
  return snap;
}

async function runMondayExitPlan() {
  console.log('[OVERNIGHT] Monday exit plan starting...');
  var plan = await buildExitPlan({});
  if (plan.error) { console.warn('[OVERNIGHT] exit plan error:', plan.error); return plan; }
  if (!plan.plan || !plan.plan.length) {
    console.log('[OVERNIGHT] no positions to manage');
    return plan;
  }
  console.log('[OVERNIGHT] exit plan: ' + plan.plan.length + ' positions');
  var push = await pushDiscordExitPlan(plan);
  if (push.posted) console.log('[OVERNIGHT] Discord exit plan posted');
  else if (push.error) console.warn('[OVERNIGHT] Discord push failed:', push.error);
  return plan;
}

function loadLast() {
  if (!fs.existsSync(OVERNIGHT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(OVERNIGHT_FILE, 'utf8')); }
  catch (e) { return { error: 'parse: ' + e.message }; }
}

module.exports = {
  snapshotPositions: snapshotPositions,
  buildExitPlan: buildExitPlan,
  pushDiscordSnapshot: pushDiscordSnapshot,
  pushDiscordExitPlan: pushDiscordExitPlan,
  runFridaySnapshot: runFridaySnapshot,
  runMondayExitPlan: runMondayExitPlan,
  loadLast: loadLast,
  parseOpra: parseOpra,
  estimateDailyTheta: estimateDailyTheta,
  estimateWeekendDecay: estimateWeekendDecay,
};
