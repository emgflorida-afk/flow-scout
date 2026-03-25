// bullflowStream.js — Stratum Flow Scout v6.1
// HIGH CONVICTION: sends BOTH naked option AND spread card to #flow-alerts
// CLUSTER ENGINE: aggregates flow by ticker, fires when $500K+ in 10 min
// ALL alerts go to #flow-alerts — no filter
// -----------------------------------------------------------------

const fetch    = require('node-fetch');
const resolver = require('./contractResolver');
const alerter  = require('./alerter');
const { processFlow } = require('./flowCluster'); // CLUSTER ENGINE

const FLOW_WEBHOOK = process.env.DISCORD_FLOW_WEBHOOK_URL;

const HIGH_CONVICTION_ALERTS = [
  'urgent repeater',
  'sizable sweep',
  'whale alert',
  'large block',
  'unusual sweep',
  'giant sweep',
  'explosive',
  'grenade trade',
];

function isHighConviction(alertName, alertPremium) {
  const nameMatch    = HIGH_CONVICTION_ALERTS.some(function(name) {
    return (alertName || '').toLowerCase().includes(name.toLowerCase());
  });
  const premiumMatch = parseFloat(alertPremium || 0) >= 50000;
  return nameMatch || premiumMatch;
}

// -- LIVE AGGREGATOR ----------------------------------------------
const liveAggregator = {
  data: {}, alertLog: [], lastResetDate: null,

  checkReset: function() {
    const now    = new Date();
    const today  = now.toISOString().slice(0, 10);
    const etHour = now.getUTCHours() - 4;
    const etMin  = now.getUTCMinutes();
    if ((etHour > 9 || (etHour === 9 && etMin >= 30)) && this.lastResetDate !== today) {
      this.data = {}; this.alertLog = []; this.lastResetDate = today;
      console.log('[AGGREGATOR] Daily reset OK');
    }
  },

  add: function(ticker, type, premium, orderType, alertName) {
    this.checkReset();
    const key = ticker + ':' + type;
    if (!this.data[key]) {
      this.data[key] = { ticker, type, total: 0, count: 0, sweeps: 0, firstSeen: new Date().toISOString() };
    }
    const e    = this.data[key];
    e.total   += parseFloat(premium || 0);
    e.count   += 1;
    e.lastSeen = new Date().toISOString();
    if ((orderType || '').toUpperCase() === 'SWEEP') e.sweeps++;
    this.alertLog.push({ ticker, type, premium, orderType, alertName, time: new Date().toISOString() });
    return e;
  },

  getSummary: function() {
    return { data: this.data, alertCount: this.alertLog.length, resetDate: this.lastResetDate };
  },
};

// -- SEND TO DISCORD ----------------------------------------------
async function sendFlowToDiscord(message) {
  if (!FLOW_WEBHOOK) { console.log('[FLOW] No webhook URL'); return; }
  try {
    await fetch(FLOW_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum Flow' }),
    });
    console.log('[FLOW] Sent to #flow-alerts OK');
  } catch (err) { console.error('[FLOW] Discord error:', err.message); }
}

// -- PARSE OPRA ---------------------------------------------------
function parseOPRA(symbol) {
  try {
    const clean = (symbol || '').replace('O:', '');
    const match = clean.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, ticker, date, typeChar, strikePadded] = match;
    return {
      ticker,
      strike:  parseInt(strikePadded) / 1000,
      expiry:  '20' + date.slice(0,2) + '-' + date.slice(2,4) + '-' + date.slice(4,6),
      type:    typeChar === 'C' ? 'call' : 'put',
    };
  } catch { return null; }
}

// -- PROCESS ALERT ------------------------------------------------
async function processAlert(raw) {
  console.log('[BULLFLOW RAW]', JSON.stringify(raw));

  const symbol      = raw.symbol      || raw.ticker    || '';
  const alertName   = raw.alertName   || raw.alert_name || raw.type || 'Flow Alert';
  const premium     = parseFloat(raw.alertPremium || raw.premium || raw.totalPremium || 0);
  const orderType   = raw.orderType   || raw.order_type || 'UNKNOWN';
  const underlying  = raw.underlying  || raw.underlyingSymbol || '';

  if (!symbol && !underlying) return;

  const parsed     = parseOPRA(symbol);
  const ticker     = parsed?.ticker || underlying || symbol;
  const type       = parsed?.type   || 'call';
  const strike     = parsed?.strike || '?';
  const expiry     = parsed?.expiry || '?';
  const expiryFmt  = typeof expiry === 'string' && expiry.length > 5
    ? expiry.slice(5).replace('-', '/') : expiry;

  const direction  = type === 'call' ? 'BULLISH' : 'BEARISH';
  const typeLabel  = type === 'call' ? 'C' : 'P';
  const isSwept    = (orderType || alertName || '').toLowerCase().includes('sweep');
  const orderTag   = isSwept ? 'SWEEP' : 'BLOCK';
  const premiumFmt = premium >= 1000000 ? '$' + (premium/1000000).toFixed(1) + 'M'
                   : premium >= 1000    ? '$' + (premium/1000).toFixed(0) + 'K'
                   : '$' + premium;

  liveAggregator.add(ticker, type, premium, orderType, alertName);

  // -- FEED INTO CLUSTER ENGINE ---------------------------------
  // Pass full raw data so cluster can parse OPRA and accumulate
  processFlow({ ...raw, opra: symbol, totalPremium: premium, orderType, alertName }).catch(function(err) {
    console.error('[CLUSTER] processFlow error:', err.message);
  });

  const price = await resolver.getPrice(ticker).catch(function() { return null; });

  // -- BASIC FLOW CARD — all alerts -----------------------------
  const flowLines = [
    'FLOW -- ' + ticker + ' ' + type.toUpperCase(),
    ticker + ' $' + strike + typeLabel + ' ' + expiryFmt + ' -- ' + direction,
    price ? 'Stock   $' + price + ' LIVE' : null,
    '===============================',
    'Premium ' + premiumFmt,
    'Type    ' + orderTag,
    'Alert   ' + alertName,
    '-------------------------------',
    isHighConviction(alertName, premium) ? 'HIGH CONVICTION' : 'Watch for Strat confirmation',
    'Time    ' + new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'}) + ' ET',
  ].filter(Boolean);

  await sendFlowToDiscord(flowLines.join('\n'));

  // -- HIGH CONVICTION — naked option + spread cards -----------
  if (isHighConviction(alertName, premium)) {
    console.log('[BULLFLOW] HIGH CONVICTION -- resolving contracts for ' + ticker);

    try {
      const swingResolved = await resolver.resolveContract(ticker, type, 'SWING');
      if (swingResolved) {
        const swingCard = [
          'SWING TRADE -- ' + swingResolved.dte + 'DTE',
          ticker + ' $' + swingResolved.strike + typeLabel + ' ' + (swingResolved.expiry ? swingResolved.expiry.slice(5).replace('-','/') : '--') + ' -- ' + direction,
          '===============================',
          'Flow trigger: ' + alertName + ' ' + premiumFmt,
          '-------------------------------',
          'Strike  $' + swingResolved.strike + ' -- ATM via Public.com',
          'Expiry  ' + (swingResolved.expiry ? swingResolved.expiry.slice(5).replace('-','/') : '--') + ' (' + swingResolved.dte + 'DTE)',
          (swingResolved.bid && swingResolved.ask) ? 'Bid/Ask $' + swingResolved.bid.toFixed(2) + ' / $' + swingResolved.ask.toFixed(2) : null,
          '-------------------------------',
        ].filter(Boolean);

        const sizing = resolver.calculatePositionSize(swingResolved.mid, 'SWING');
        if (sizing && sizing.viable) {
          swingCard.push(
            'Entry   $' + sizing.premium.toFixed(2) + ' x' + sizing.contracts + ' = $' + sizing.totalCost,
            'Stop    $' + sizing.stopPrice + ' (loss -$' + sizing.stopLoss + ')',
            'T1      $' + sizing.t1Price + ' (profit +$' + sizing.t1Profit + ')',
            'T2      $' + sizing.t2Price + ' (runner)',
            'Risk    ' + sizing.riskPct + '% of $7K = $' + sizing.stopLoss + ' max'
          );
        } else {
          swingCard.push('Check live premium before entry');
        }
        swingCard.push('-------------------------------', 'Hold    1-3 days max');
        await sendFlowToDiscord(swingCard.join('\n'));

        // Spread card
        const spreadResolved = await resolver.resolveContract(ticker, type, 'SPREAD');
        if (spreadResolved && spreadResolved.debit) {
          const spreadSizing = resolver.calculatePositionSize(spreadResolved.debit, 'SPREAD', 7000, spreadResolved);
          const s = spreadSizing && spreadSizing.viable ? spreadSizing : null;
          const exFmt = spreadResolved.expiry ? spreadResolved.expiry.slice(5).replace('-','/') : '--';

          const spreadCard = [
            'SPREAD TRADE -- ' + spreadResolved.dte + 'DTE',
            ticker + ' $' + spreadResolved.strike + '/$' + spreadResolved.sellStrike + typeLabel + ' ' + exFmt + ' -- ' + direction,
            '===============================',
            'Flow trigger: ' + alertName + ' ' + premiumFmt,
            '-------------------------------',
            'BUY     ' + ticker + ' $' + spreadResolved.strike    + typeLabel + ' ' + exFmt,
            'SELL    ' + ticker + ' $' + spreadResolved.sellStrike + typeLabel + ' ' + exFmt,
            'Width   $' + spreadResolved.spreadWidth + ' spread',
            '-------------------------------',
            s ? 'Debit   $' + s.debit.toFixed(2) + ' x' + s.contracts + ' = $' + s.totalCost : 'Debit   $' + (spreadResolved.debit ? spreadResolved.debit.toFixed(2) : '--'),
            s ? 'Max Loss    $' + s.maxLoss   : null,
            s ? 'Max Profit  $' + s.maxGain   : null,
            'Breakeven   $' + spreadResolved.breakeven,
            '-------------------------------',
            s ? 'Stop    $' + s.stopPrice + ' (50% of debit)' : 'Stop    50% of debit',
            s ? 'T1      $' + s.t1Price   + ' (100% gain)'   : 'T1      +100% of debit',
            s ? 'Risk    ' + s.riskPct + '% of $7K = $' + s.maxLoss : 'Risk    defined',
            '-------------------------------',
            'Hold    1-3 days max',
            'Time    ' + new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'}) + ' ET',
          ].filter(Boolean);

          await sendFlowToDiscord(spreadCard.join('\n'));
          console.log('[SPREAD] Sent spread card for ' + ticker + ' OK');
        }
      }
    } catch (err) {
      console.error('[BULLFLOW] Contract resolution error:', err.message);
    }
  }
}

// -- MAIN STREAM --------------------------------------------------
async function startBullflowStream() {
  const apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) { console.error('[BULLFLOW] No API key'); return; }

  console.log('[BULLFLOW] Connecting to stream...');

  const connect = async function() {
    try {
      const res = await fetch(
        'https://api.bullflow.io/v1/streaming/alerts?key=' + apiKey,
        { headers: { Accept: 'text/event-stream' } }
      );

      if (!res.ok) {
        console.error('[BULLFLOW] Connection failed:', res.status);
        scheduleReconnect();
        return;
      }

      console.log('[BULLFLOW] Stream connected OK');

      let buffer = '';

      res.body.on('data', async function(chunk) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          console.log('[BULLFLOW SSE]', trimmed);
          if (!trimmed.startsWith('data: ')) continue;

          const raw = trimmed.slice(6).trim();
          if (!raw || raw === '{}') continue;

          try {
            const parsed = JSON.parse(raw);
            const event  = parsed && parsed.event ? parsed.event : '';
            if (event === 'heartbeat' || event === 'init') return;

            if (event === 'alert') {
              const data = parsed.data || parsed;
              await processAlert(data);
            }
          } catch (err) {
            console.log('[BULLFLOW] Parse error:', err.message);
          }
        }
      });

      res.body.on('error', function(err) {
        console.error('[BULLFLOW] Stream error:', err.message);
        scheduleReconnect();
      });

      res.body.on('end', function() {
        console.log('[BULLFLOW] Stream ended -- reconnecting...');
        scheduleReconnect();
      });

    } catch (err) {
      console.error('[BULLFLOW] Connection error:', err.message);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = function() {
    console.log('[BULLFLOW] Reconnecting in 10 seconds...');
    setTimeout(connect, 10000);
  };

  connect();
}

module.exports = { startBullflowStream, liveAggregator };
