// bullflowStream.js - Stratum Flow Scout v7.4
// FIXED: Wide net -- ALL watchlist flow posts to #flow-alerts (no score gate)
// FIXED: Score 4+ posts to #conviction-flow only
// FIXED: Compact emoji card format -- 3-line scannable
// FIXED: TS token health check removed from Discord -- Railway logs only
// -----------------------------------------------------------------

const fetch = require('node-fetch');

const WATCHLIST = new Set([
  'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
  'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
  'MRNA','MRVL','GUSH','UVXY','KO','PEP'
]);

// -- DISCORD WEBHOOKS ---------------------------------------------
const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_FLOW_WEBHOOK;

// -- SCORE FLOW ALERT ---------------------------------------------
function scoreFlow(alert) {
  var score = 0;
  var type  = (alert.alert_type || alert.alertType || '').toLowerCase();
  var prem  = parseFloat(alert.premium || alert.total_premium || 0);
  var vol   = parseInt(alert.volume || 0);
  var oi    = parseInt(alert.open_interest || alert.openInterest || 0);

  // Alert type
  if (type.includes('sweep'))  score += 2;
  if (type.includes('block'))  score += 1;
  if (type.includes('urgent')) score += 2;
  if (type.includes('whale'))  score += 2;

  // Premium size
  if (prem >= 1000000)     score += 4;
  else if (prem >= 500000) score += 3;
  else if (prem >= 100000) score += 2;
  else if (prem >= 25000)  score += 1;

  // Volume vs OI -- new position signal
  if (vol > 0 && oi > 0 && vol > oi) score += 1;

  return score;
}

// -- FORMAT COMPACT EMOJI CARD ------------------------------------
function formatFlowCard(alert, score) {
  var ticker    = (alert.ticker || alert.symbol || '?').toUpperCase();
  var direction = (alert.put_call || alert.type || alert.direction || '?').toUpperCase();
  var prem      = parseFloat(alert.premium || alert.total_premium || 0);
  var strike    = alert.strike_price || alert.strike || '?';
  var expiry    = (alert.expiration || alert.expiry || '?').slice(0,10);
  var type      = alert.alert_type || alert.alertType || 'Flow';
  var dte       = alert.dte || '?';
  var vol       = parseInt(alert.volume || 0);

  var emoji = direction === 'CALL' ? '🟢' : direction === 'PUT' ? '🔴' : '⚪';
  var premStr = prem >= 1000000
    ? '$' + (prem/1000000).toFixed(1) + 'M'
    : prem >= 1000
    ? '$' + (prem/1000).toFixed(0) + 'K'
    : '$' + prem.toFixed(0);

  return [
    emoji + ' **' + ticker + '** ' + direction + ' $' + strike + ' ' + expiry,
    '💰 ' + premStr + ' · ' + type + ' · ' + dte + 'DTE · Vol ' + vol.toLocaleString(),
    '📊 Score: ' + score + '/10',
  ].join('\n');
}

// -- SEND TO DISCORD ----------------------------------------------
async function sendToDiscord(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: message, username: 'Stratum Flow' }),
    });
  } catch(e) { console.error('[BULLFLOW] Discord error:', e.message); }
}

// -- PROCESS ALERT ------------------------------------------------
async function processAlert(alert) {
  var ticker = (alert.ticker || alert.symbol || '').toUpperCase();
  if (!ticker) return;

  var score     = scoreFlow(alert);
  var onList    = WATCHLIST.has(ticker);
  var card      = formatFlowCard(alert, score);
  var direction = (alert.put_call || alert.type || alert.direction || '').toUpperCase();

  console.log('[FLOW] ' + ticker + ' ' + direction + ' score:' + score + ' watchlist:' + onList);

  // WIDE NET -- ALL watchlist tickers post to #flow-alerts, no score gate
  if (onList) {
    await sendToDiscord(FLOW_WEBHOOK, card);
    console.log('[FLOW] Sent to #flow-alerts -- ' + ticker);
  }

  // CONVICTION -- score 4+ AND watchlist -- post to #conviction-flow
  if (onList && score >= 4) {
    var convCard = '🚨 **CONVICTION FLOW**\n' + card + '\n✅ Score ' + score + '/10 — High conviction';
    await sendToDiscord(CONVICTION_WEBHOOK, convCard);
    console.log('[FLOW] Sent to #conviction-flow -- ' + ticker + ' score:' + score);
  }
}

// -- LIVE AGGREGATOR (for /flow/summary endpoint) -----------------
var liveAggregator = {
  data: {},
  getSummary: function() { return this.data; },
  update: function(ticker, direction, premium) {
    if (!this.data[ticker]) this.data[ticker] = { calls: 0, puts: 0, premium: 0, count: 0 };
    var d = this.data[ticker];
    if ((direction||'').toUpperCase() === 'CALL') d.calls++;
    else d.puts++;
    d.premium += parseFloat(premium || 0);
    d.count++;
  },
};

// -- MAIN STREAM --------------------------------------------------
function startBullflowStream() {
  var apiKey = process.env.BULLFLOW_API_KEY;
  if (!apiKey) { console.error('[BULLFLOW] No API key'); return; }

  console.log('[BULLFLOW] Connecting to stream...');

  var connect = function() {
    fetch('https://api.bullflow.io/v1/streaming/alerts?key=' + apiKey, {
      headers: { 'Accept': 'text/event-stream' }
    }).then(function(res) {
      if (!res.ok) {
        console.error('[BULLFLOW] Connection failed:', res.status);
        setTimeout(connect, 10000);
        return;
      }

      console.log('[BULLFLOW] Stream connected OK');
      var buffer = '';

      res.body.on('data', function(chunk) {
        buffer += chunk.toString();
        var lines = buffer.split('\n');
        buffer = lines.pop();

        lines.forEach(function(line) {
          var trimmed = line.trim();
          if (!trimmed) return;
          console.log('[BULLFLOW SSE]', trimmed);
          if (!trimmed.startsWith('data: ')) return;

          var raw = trimmed.slice(6).trim();
          if (!raw || raw === '{}') return;

          try {
            var parsed = JSON.parse(raw);
            var event  = parsed.event || '';
            if (event === 'heartbeat' || event === 'init') return;
            if (event === 'alert') {
              var data = parsed.data || parsed;
              liveAggregator.update(
                (data.ticker||data.symbol||'').toUpperCase(),
                data.put_call || data.type,
                data.premium || data.total_premium
              );
              processAlert(data);
            }
          } catch(e) {
            console.log('[BULLFLOW] Parse error:', e.message);
          }
        });
      });

      res.body.on('error', function(err) {
        console.error('[BULLFLOW] Stream error:', err.message);
        setTimeout(connect, 10000);
      });

      res.body.on('end', function() {
        console.log('[BULLFLOW] Stream ended -- reconnecting...');
        setTimeout(connect, 10000);
      });

    }).catch(function(err) {
      console.error('[BULLFLOW] Connection error:', err.message);
      setTimeout(connect, 10000);
    });
  };

  connect();
}

module.exports = { startBullflowStream, liveAggregator };
