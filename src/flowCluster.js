// flowCluster.js — Stratum Flow Scout v6.1
// Aggregates real-time flow alerts by ticker
// Fires ONE cluster alert when combined premium crosses threshold
// Reduces 31 individual alerts to 1 high-signal cluster card
// -----------------------------------------------------------------

const fetch    = require('node-fetch');
const resolver = require('./contractResolver');

const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_WEBHOOK_URL;
const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;

// -- CLUSTER CONFIG -----------------------------------------------
const CONFIG = {
  windowMs:       10 * 60 * 1000,  // 10 minute rolling window
  minPremium:     500000,           // $500K combined to fire
  minOrders:      3,                // minimum 3 orders same ticker
  cooldownMs:     15 * 60 * 1000,  // 15 min cooldown after cluster fires
};

// -- CLUSTER STATE ------------------------------------------------
// Map of ticker -> { calls: [], puts: [] }
const clusterState   = new Map();
const cooldownState  = new Map(); // ticker -> timestamp last fired

// -- ADD FLOW TO CLUSTER ------------------------------------------
function addFlow(flowData) {
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

  // Add this flow
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
  state.calls  = state.calls.filter(f => f.timestamp > cutoff);
  state.puts   = state.puts.filter(f  => f.timestamp > cutoff);

  // Check cluster for dominant side
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

    // Check cooldown
    const cooldownKey = ticker + ':' + type;
    const lastFired   = cooldownState.get(cooldownKey) || 0;
    if (now - lastFired < CONFIG.cooldownMs) continue;

    // CLUSTER THRESHOLD MET
    cooldownState.set(cooldownKey, now);

    // Find dominant strike (most orders at same strike)
    const strikeCounts = {};
    orders.forEach(function(f) {
      strikeCounts[f.strike] = (strikeCounts[f.strike] || 0) + 1;
    });
    const dominantStrike = Object.entries(strikeCounts)
      .sort(function(a, b) { return b[1] - a[1]; })[0][0];

    // Find nearest expiry
    const expiries = orders.map(function(f) { return f.expiry; }).filter(Boolean).sort();
    const nearestExpiry = expiries[0] || null;

    // Count order types
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

  const expiryFmt  = nearestExpiry ? nearestExpiry.slice(5).replace('-', '/') : '--';
  const orderTypeSummary = [
    sweepCount > 0 ? sweepCount + ' SWEEP' + (sweepCount > 1 ? 'S' : '') : null,
    blockCount > 0 ? blockCount + ' BLOCK' + (blockCount > 1 ? 'S' : '') : null,
  ].filter(Boolean).join(' + ') || orderCount + ' ORDERS';

  const mid    = resolved?.mid   ? '$' + resolved.mid.toFixed(2)   : '--';
  const stop   = resolved?.mid   ? '$' + (resolved.mid * 0.60).toFixed(2) : '--';
  const t1     = resolved?.mid   ? '$' + (resolved.mid * 1.60).toFixed(2) : '--';
  const t2     = resolved?.mid   ? '$' + (resolved.mid * 2.20).toFixed(2) : '--';
  const strike = resolved?.strike || dominantStrike;

  const lines = [
    'CLUSTER ALERT -- ' + ticker + ' ' + type.toUpperCase() + 'S',
    ticker + ' $' + strike + typeLabel + ' ' + expiryFmt + ' -- ' + direction,
    '===============================',
    'Total Flow   ' + premiumStr + ' in ' + windowMinutes + ' min',
    'Orders       ' + orderCount + ' (' + orderTypeSummary + ')',
    'Strike       $' + dominantStrike + typeLabel + ' dominant',
    'Expiry       ' + expiryFmt,
    '===============================',
    resolved ? 'Stock        $' + resolved.price.toFixed(2) + ' LIVE' : null,
    resolved ? 'Contract     ' + resolved.symbol : null,
    '-------------------------------',
    resolved ? 'Entry   ' + mid : 'Entry   check live mid',
    resolved ? 'Stop    ' + stop + ' (40% of premium)' : null,
    resolved ? 'T1      ' + t1 + ' (+60%)' : null,
    resolved ? 'T2      ' + t2 + ' (+120% runner)' : null,
    '-------------------------------',
    'CONVICTION   HIGH -- execute on next candle close',
    'Window       9:45AM-3:30PM ET only',
    'Time         ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
  ].filter(function(l) { return l !== null; });

  return lines.join('\n');
}

// -- SEND CLUSTER ALERT -------------------------------------------
async function sendClusterAlert(cluster) {
  console.log('[CLUSTER] ' + cluster.ticker + ' ' + cluster.type.toUpperCase() + ' -- $' + (cluster.totalPremium/1000).toFixed(0) + 'K in ' + cluster.orderCount + ' orders FIRING');

  // Resolve contract for entry details
  let resolved = null;
  try {
    resolved = await resolver.resolveContract(cluster.ticker, cluster.type, 'SWING');
  } catch (err) {
    console.error('[CLUSTER] Contract resolve error:', err.message);
  }

  const card = buildClusterCard(cluster, resolved);

  // Send to conviction channel
  try {
    const res = await fetch(CONVICTION_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + card + '\n```',
        username: 'Stratum Cluster',
      }),
    });
    if (res.ok) console.log('[CLUSTER] Alert sent to #conviction-trades OK');
  } catch (err) {
    console.error('[CLUSTER] Send error:', err.message);
  }

  return card;
}

// -- PROCESS INCOMING FLOW ----------------------------------------
// Call this from bullflowStream.js on every incoming flow alert
async function processFlow(flowData) {
  const cluster = addFlow(flowData);
  if (cluster) {
    await sendClusterAlert(cluster);
  }
}

// -- GET CURRENT CLUSTER STATE (for debugging) --------------------
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

module.exports = { processFlow, getClusterSummary };
