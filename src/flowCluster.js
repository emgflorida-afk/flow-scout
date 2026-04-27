// flowCluster.js — Stratum Flow Scout v6.2
// Aggregates real-time flow alerts by ticker
// Fires ONE cluster alert when combined premium crosses threshold
// Reduces 31 individual alerts to 1 high-signal cluster card
//
// v6.2 (Apr 27 PM): persist _cardBuffer + processedAlertIds to /data so
//   they survive Railway redeploys. Apr 27 bug: AB saw no flow cards
//   despite obvious institutional flow (AMD puts, NVDA calls) — root cause
//   was that _cardBuffer was in-memory only, wiped on every redeploy.
//   Same bug caused "Card ID not found" errors when AB hit FIRE on a card
//   whose buffer entry got wiped between scanner load and click.
//   Also adds 12-hour age filter — cards older than 12h drop off the
//   active list automatically (still in history file).
// -----------------------------------------------------------------

const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const resolver = require('./contractResolver');

// Persist flow cards to Railway /data volume so they survive redeploys.
const STATE_DIR = process.env.STATE_DIR || '/data';
const CARDS_FILE = path.join(STATE_DIR, 'flow_cards.json');
const CARD_AGE_LIMIT_MS = 12 * 60 * 60 * 1000;  // 12 hours

function _safeReadCards() {
  try {
    if (!fs.existsSync(CARDS_FILE)) return [];
    var raw = fs.readFileSync(CARDS_FILE, 'utf8');
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch(e) {
    console.error('[CLUSTER] cards-load error:', e.message);
    return [];
  }
}
function _safeWriteCards(cards) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CARDS_FILE, JSON.stringify(cards), 'utf8');
  } catch(e) {
    console.error('[CLUSTER] cards-save error:', e.message);
  }
}

const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;

// -- CLUSTER CONFIG -----------------------------------------------
// Apr 26 2026 — lowered thresholds to catch IREN-class clusters (~$96K/8min)
// that the old config missed. Override via env vars.
const CONFIG = {
  windowMs:       parseInt(process.env.FLOW_CLUSTER_WINDOW_MS  || '300000'),   // 5 min rolling window (was 10)
  minPremium:     parseInt(process.env.FLOW_CLUSTER_MIN_PREM   || '150000'),   // $150K combined (was 500K)
  minOrders:      parseInt(process.env.FLOW_CLUSTER_MIN_ORDERS || '3'),
  cooldownMs:     parseInt(process.env.FLOW_CLUSTER_COOLDOWN_MS || '900000'), // 15 min
};
// CARD BUFFER — most-recent N fired clusters, served via /api/flow-cards/active
// v6.2: now persisted to /data/flow_cards.json so it survives redeploys.
const CARD_BUFFER_MAX = 100;  // bumped from 50, matches 12h capacity
var _cardBuffer = _safeReadCards();
console.log('[CLUSTER] Loaded ' + _cardBuffer.length + ' persisted flow cards from ' + CARDS_FILE);

// -- CLUSTER STATE ------------------------------------------------
const clusterState   = new Map();
const cooldownState  = new Map();

// -- DEDUPLICATION ------------------------------------------------
// Track alert IDs we've already processed to prevent duplicate cards
const processedAlertIds = new Set();

// -- ADD FLOW TO CLUSTER ------------------------------------------
function addFlow(flowData) {
  // Deduplicate by alert ID
  const alertId = flowData.id || flowData.alertId || null;
  if (alertId) {
    if (processedAlertIds.has(alertId)) {
      return null; // already processed this exact alert
    }
    processedAlertIds.add(alertId);
    // Clean old IDs after 30 min to prevent memory bloat
    setTimeout(function() { processedAlertIds.delete(alertId); }, 30 * 60 * 1000);
  }

  const opra    = flowData.opra || flowData.symbol || '';
  const parsed  = parseFlowSymbol(opra);
  if (!parsed) return null;

  const { ticker, type } = parsed;
  const premium  = parseFloat(flowData.totalPremium || 0);
  const now      = Date.now();

  if (!clusterState.has(ticker)) {
    clusterState.set(ticker, { calls: [], puts: [] });
  }

  const state = clusterState.get(ticker);
  const side  = type === 'call' ? 'calls' : 'puts';

  state[side].push({
    premium,
    orderType:  flowData.orderType  || 'UNKNOWN',
    alertName:  flowData.alertName  || '',
    strike:     parsed.strike,
    expiry:     parsed.expiry,
    timestamp:  now,
    opra,
  });

  // Clean old entries outside window
  const cutoff = now - CONFIG.windowMs;
  state.calls  = state.calls.filter(function(f) { return f.timestamp > cutoff; });
  state.puts   = state.puts.filter(function(f)  { return f.timestamp > cutoff; });

  return checkCluster(ticker, state, now);
}

// -- CHECK IF CLUSTER THRESHOLD MET -------------------------------
function checkCluster(ticker, state, now) {
  const sides = [
    { side: 'calls', type: 'call',  orders: state.calls },
    { side: 'puts',  type: 'put',   orders: state.puts  },
  ];

  for (const { type, orders } of sides) {
    if (orders.length < CONFIG.minOrders) continue;

    const totalPremium = orders.reduce(function(sum, f) { return sum + f.premium; }, 0);
    if (totalPremium < CONFIG.minPremium) continue;

    const cooldownKey = ticker + ':' + type;
    const lastFired   = cooldownState.get(cooldownKey) || 0;
    if (now - lastFired < CONFIG.cooldownMs) continue;

    cooldownState.set(cooldownKey, now);

    const strikeCounts = {};
    orders.forEach(function(f) {
      strikeCounts[f.strike] = (strikeCounts[f.strike] || 0) + 1;
    });
    const dominantStrike = Object.entries(strikeCounts)
      .sort(function(a, b) { return b[1] - a[1]; })[0][0];

    const expiries = orders.map(function(f) { return f.expiry; }).filter(Boolean).sort();
    const nearestExpiry = expiries[0] || null;

    const sweeps = orders.filter(function(f) { return (f.orderType || '').toUpperCase() === 'SWEEP'; }).length;
    const blocks = orders.filter(function(f) { return (f.orderType || '').toUpperCase() === 'BLOCK'; }).length;

    return {
      ticker,
      type,
      totalPremium,
      orderCount:     orders.length,
      sweepCount:     sweeps,
      blockCount:     blocks,
      dominantStrike: parseFloat(dominantStrike),
      nearestExpiry,
      windowMinutes:  CONFIG.windowMs / 60000,
      orders,
    };
  }

  return null;
}

// -- PARSE FLOW SYMBOL --------------------------------------------
function parseFlowSymbol(opra) {
  try {
    const raw   = (opra || '').replace(/^O:/, '');
    const match = raw.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, dateStr, typeChar, strikeRaw] = match;
    const expiry = '20' + dateStr.slice(0,2) + '-' + dateStr.slice(2,4) + '-' + dateStr.slice(4,6);
    return {
      ticker,
      expiry,
      type:   typeChar === 'C' ? 'call' : 'put',
      strike: parseInt(strikeRaw) / 1000,
    };
  } catch { return null; }
}

// -- BUILD CLUSTER CARD -------------------------------------------
function buildClusterCard(cluster, resolved) {
  const { ticker, type, totalPremium, orderCount, sweepCount, blockCount, dominantStrike, nearestExpiry, windowMinutes } = cluster;

  const direction  = type === 'put' ? 'BEARISH' : 'BULLISH';
  const typeLabel  = type === 'put' ? 'P' : 'C';
  const premiumStr = totalPremium >= 1000000
    ? '$' + (totalPremium/1000000).toFixed(1) + 'M'
    : '$' + (totalPremium/1000).toFixed(0) + 'K';

  const orderTypeSummary = [
    sweepCount > 0 ? sweepCount + ' SWEEP' + (sweepCount > 1 ? 'S' : '') : null,
    blockCount > 0 ? blockCount + ' BLOCK' + (blockCount > 1 ? 'S' : '') : null,
  ].filter(Boolean).join(' + ') || orderCount + ' ORDERS';

  // -- USE STRATUM-RESOLVED CONTRACT (not smart money's deep ITM)
  const resolvedStrike  = resolved ? resolved.strike  : dominantStrike;
  const resolvedExpiry  = resolved ? (resolved.expiry ? resolved.expiry.slice(5).replace('-', '/') : '--') : (nearestExpiry ? nearestExpiry.slice(5).replace('-', '/') : '--');
  const resolvedSymbol  = resolved ? resolved.symbol  : null;
  const resolvedPrice   = resolved ? resolved.price   : null;

  // Entry sizing from resolved contract
  const mid  = resolved && resolved.mid  ? resolved.mid  : null;
  const entry = mid ? '$' + mid.toFixed(2)                    : 'check live mid';
  const stop  = mid ? '$' + (mid * 0.60).toFixed(2) + ' (40% stop)' : null;
  const t1    = mid ? '$' + (mid * 1.60).toFixed(2) + ' (+60%)'     : null;
  const t2    = mid ? '$' + (mid * 2.20).toFixed(2) + ' (+120% runner)' : null;

  // Retracement entry
  const retrace = mid ? '$' + (mid * 0.875).toFixed(2) + ' (12.5% retrace -- LIMIT)' : null;

  // Contracts sizing (2% of $7K = $147 max risk)
  var contracts = 1;
  if (mid && mid > 0) {
    contracts = Math.max(1, Math.floor(147 / (mid * 0.40 * 100)));
  }

  const lines = [
    'CLUSTER ALERT -- ' + ticker + ' ' + type.toUpperCase() + 'S',
    ticker + ' $' + resolvedStrike + typeLabel + ' ' + resolvedExpiry + ' -- ' + direction,
    '===============================',
    'Total Flow   ' + premiumStr + ' in ' + windowMinutes + ' min',
    'Orders       ' + orderCount + ' (' + orderTypeSummary + ')',
    '-------------------------------',
    resolvedPrice  ? 'Stock        $' + resolvedPrice.toFixed(2) + ' LIVE'   : null,
    resolvedSymbol ? 'Contract     ' + resolvedSymbol                         : null,
    '-------------------------------',
    'Entry   ' + entry,
    retrace        ? 'Limit   ' + retrace : null,
    stop           ? 'Stop    ' + stop    : null,
    t1             ? 'T1      ' + t1      : null,
    t2             ? 'T2      ' + t2      : null,
    mid            ? 'Size    ' + contracts + ' contract' + (contracts > 1 ? 's' : '') + ' (2% risk max)' : null,
    '-------------------------------',
    'CONVICTION   HIGH -- execute on next candle close',
    'Window       9:45AM-3:30PM ET only',
    'Time         ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
  ].filter(function(l) { return l !== null; });

  return lines.join('\n');
}

// -- BUILD STRUCTURED CARD OBJECT (for scanner UI) ----------------
// Apr 26 2026 — display card (vs Discord text card). Returns a serializable
// object the scanner.html flow panel renders, plus a confluence read against
// the current scanner state (set externally via setScannerSetupLookup).
var _scannerSetupLookup = null;  // function(ticker) -> {direction, pattern} | null
function setScannerSetupLookup(fn) { _scannerSetupLookup = fn; }

function buildCardObject(cluster, resolved) {
  const direction = cluster.type === 'put' ? 'BEARISH' : 'BULLISH';
  const sweepPct  = cluster.orderCount > 0 ? Math.round(100 * cluster.sweepCount / cluster.orderCount) : 0;
  const mid       = resolved && resolved.mid ? resolved.mid : null;
  const stop      = mid ? +(mid * 0.60).toFixed(2) : null;
  const tp1       = mid ? +(mid * 1.60).toFixed(2) : null;
  const tp2       = mid ? +(mid * 2.20).toFixed(2) : null;

  // Confluence — does this match a current scanner setup on the same ticker?
  var confluence = { state: 'discovery', text: '⚠ discovery — no technical setup, watchlist tomorrow' };
  if (_scannerSetupLookup) {
    try {
      const setup = _scannerSetupLookup(cluster.ticker);
      if (setup && setup.direction) {
        const flowSide  = direction === 'BULLISH' ? 'LONG' : 'SHORT';
        const setupSide = setup.direction.toUpperCase().includes('LONG') || setup.direction.toUpperCase().includes('CALL') ? 'LONG' : 'SHORT';
        if (flowSide === setupSide) {
          confluence = { state: 'aligned', text: '✓ aligns with ' + setup.pattern + ' on ' + cluster.ticker };
        } else {
          confluence = { state: 'opposing', text: '⚠ OPPOSES current ' + setup.pattern + ' on ' + cluster.ticker + ' — pause/reassess' };
        }
      }
    } catch(e) { /* ignore lookup errors */ }
  }

  return {
    id:           cluster.ticker + '-' + cluster.type + '-' + Date.now(),
    firedAt:      new Date().toISOString(),
    ticker:       cluster.ticker,
    direction:    direction,
    flowSide:     direction === 'BULLISH' ? 'LONG' : 'SHORT',
    totalPremium: cluster.totalPremium,
    orderCount:   cluster.orderCount,
    sweepCount:   cluster.sweepCount,
    blockCount:   cluster.blockCount,
    sweepPct:     sweepPct,
    windowMin:    cluster.windowMinutes,
    smartStrike:  cluster.dominantStrike,
    smartExpiry:  cluster.nearestExpiry,
    contract:     resolved ? {
      symbol: resolved.symbol,
      strike: resolved.strike,
      expiry: resolved.expiry,
      mid:    mid,
      ask:    resolved.ask  || null,
      bid:    resolved.bid  || null,
      delta:  resolved.delta || null,
    } : null,
    bracket: mid ? { entry: mid, stop: stop, tp1: tp1, tp2: tp2, defaultQty: 1 } : null,
    confluence: confluence,
    underlyingPrice: resolved && resolved.price ? resolved.price : null,
  };
}

// -- PROCESS INCOMING FLOW ----------------------------------------
async function processFlow(flowData) {
  const cluster = addFlow(flowData);
  if (cluster) {
    // Resolve contract once, reused for both card paths.
    let resolved = null;
    try {
      resolved = await resolver.resolveContract(cluster.ticker, cluster.type, 'SWING');
    } catch (err) {
      console.error('[CLUSTER] Contract resolve error:', err.message);
    }

    // 1) Discord text card (existing path, unchanged behavior)
    try {
      const card = buildClusterCard(cluster, resolved);
      const res = await fetch(CONVICTION_WEBHOOK, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content: '```\n' + card + '\n```', username: 'Stratum Cluster' }),
      });
      if (res.ok) console.log('[CLUSTER] Discord alert sent OK');
      else console.error('[CLUSTER] Webhook error:', res.status);
    } catch (err) {
      console.error('[CLUSTER] Discord send error:', err.message);
    }

    // 2) Scanner-UI card object (new — display only, no auto-fire)
    try {
      const cardObj = buildCardObject(cluster, resolved);
      cardObj.firedAt = cardObj.firedAt || Date.now();  // v6.2: timestamp for age filter
      _cardBuffer.unshift(cardObj);
      if (_cardBuffer.length > CARD_BUFFER_MAX) _cardBuffer.length = CARD_BUFFER_MAX;
      _safeWriteCards(_cardBuffer);  // v6.2: persist
      console.log('[CLUSTER] Card buffered + persisted: ' + cardObj.ticker + ' ' + cardObj.direction + ' ' + cardObj.confluence.state);
    } catch(err) {
      console.error('[CLUSTER] Card buffer error:', err.message);
    }
  }
}

// v6.2: filter out stale (>12h) cards on read, but keep them in the
// persisted file for history/research. UI only shows active.
function getActiveCards() {
  var cutoff = Date.now() - CARD_AGE_LIMIT_MS;
  return _cardBuffer.filter(function(c) {
    var t = c.firedAt || c.timestamp || 0;
    return t >= cutoff;
  });
}
function clearCards() { _cardBuffer = []; _safeWriteCards(_cardBuffer); }

// -- GET CURRENT CLUSTER STATE ------------------------------------
function getClusterSummary() {
  const summary = {};
  clusterState.forEach(function(state, ticker) {
    const callTotal = state.calls.reduce(function(s, f) { return s + f.premium; }, 0);
    const putTotal  = state.puts.reduce(function(s, f)  { return s + f.premium; }, 0);
    if (callTotal > 0 || putTotal > 0) {
      summary[ticker] = {
        calls: { orders: state.calls.length, premium: '$' + (callTotal/1000).toFixed(0) + 'K' },
        puts:  { orders: state.puts.length,  premium: '$' + (putTotal/1000).toFixed(0) + 'K'  },
      };
    }
  });
  return summary;
}

module.exports = {
  processFlow,
  getClusterSummary,
  getActiveCards,
  clearCards,
  setScannerSetupLookup,
};
