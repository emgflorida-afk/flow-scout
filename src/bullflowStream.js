// bullflowStream.js - Stratum Flow Scout v7.4
// FIXED: Ticker extraction from OPRA symbol format O:AMD260410C00230000
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

const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_FLOW_WEBHOOK;

// -- EXTRACT TICKER FROM OPRA SYMBOL ------------------------------
// Handles: O:AMD260410C00230000, AMD260410C00230000, AMD, etc.
function extractTicker(symbol) {
  if (!symbol) return '';
  var s = symbol.replace(/^O:/, '').trim();
  // Match leading letters before 6-digit date
  var m = s.match(/^([A-Z]{1,5})(\d{6}[CP]\d+)/);
  if (m) return m[1];
  // Fallback -- return as-is if no date pattern found
  return s.replace(/\s.*/, '').toUpperCase();
}

// -- SCORE FLOW ALERT ---------------------------------------------
function scoreFlow(alert) {
  var score = 0;
  var type  = (alert.alert_type || alert.alertType || alert.alertName || '').toLowerCase();
  var prem  = parseFloat(alert.premium || alert.alertPremium || alert.total_premium || 0);
  var vol   = parseInt(alert.volume || 0);
  var oi    = parseInt(alert.open_interest || alert.openInterest || 0);

  if (type.includes('sweep'))   score += 2;
  if (type.includes('block'))   score += 1;
  if (type.includes('urgent'))  score += 2;
  if (type.includes('whale'))   score += 2;
  if (type.includes('grenade')) score += 3;
  if (type.includes('sizable')) score += 2;
  if (type.includes('unusual')) score += 1;
  if (type.includes('repeat'))  score += 1;
  if (type.includes('high sig')) score += 2;
  if (type.includes('ap watch')) score += 1;

  if (prem >= 1000000)     score += 4;
  else if (prem >= 500000) score += 3;
  else if (prem >= 100000) score += 2;
  else if (prem >= 25000)  score += 1;

  if (vol > 0 && oi > 0 && vol > oi) score += 1;

  return score;
}

// -- PARSE DIRECTION FROM OPRA SYMBOL -----------------------------
function parseDirection(symbol) {
  var s = (symbol || '').replace(/^O:/, '');
  if (s.match(/\d{6}C\d+/)) return 'CALL';
  if (s.match(/\d{6}P\d+/)) return 'PUT';
  return '?';
}

// -- FORMAT COMPACT EMOJI CARD ------------------------------------
function formatFlowCard(alert, ticker, score) {
  var rawSymbol = alert.symbol || '';
  var direction = parseDirection(rawSymbol);
  var prem      = parseFloat(alert.premium || alert.alertPremium || alert.total_premium || 0);
  var type      = alert.alert_type || alert.alertType || alert.alertName || 'Flow';
  var vol       = parseInt(alert.volume || 0);

  var emoji = direction === 'CALL' ? '🟢' : direction === 'PUT' ? '🔴' : '⚪';
  var premStr = prem >= 1000000
    ? '$' + (prem/1000000).toFixed(1) + 'M'
    : prem >= 1000
    ? '$' + Math.round(prem/1000) + 'K'
    : '$' + Math.round(prem);

  // Extract strike/expiry from OPRA if possible
  var details = '';
  var m = rawSymbol.replace(/^O:/,'').match(/^[A-Z]+(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
  if (m) {
    var strike = parseInt(m[5]);
    details = '$' + strike + ' ' + m[2] + '/' + m[3] + '/2' + m[1] + ' ' + (m[4]==='C'?'CALL':'PUT');
  }

  return [
    emoji + ' **' + ticker + '** ' + (details || direction) + ' — ' + premStr,
    '📊 ' + type + (vol > 0 ? ' · Vol ' + vol.toLocaleString() : '') + ' · Score ' + score + '/10',
    '🕐 ' + new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'}) + ' ET',
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
  } catch(e) { console.error('[BULLFLOW] Discord send error:', e.message); }
}

// -- PROCESS ALERT ------------------------------------------------
async function processAlert(alert) {
  var rawSymbol = alert.symbol || '';
  var ticker    = extractTicker(rawSymbol);
  if (!ticker) return;

  var score  = scoreFlow(alert);
  var onList = WATCHLIST.has(ticker);
  var prem   = parseFloat(alert.premium || alert.alertPremium || alert.total_premium || 0);

  console.log('[FLOW] ' + ticker + ' (' + rawSymbol + ') score:' + score + ' watchlist:' + onList + ' prem:$' + Math.round(prem));

  // Wide net -- ALL watchlist tickers post to #flow-alerts, no score gate
  if (onList) {
    var card = formatFlowCard(alert, ticker, score);
    await sendToDiscord(FLOW_WEBHOOK, card);
    console.log('[FLOW] Sent to #flow-alerts -- ' + ticker);

    // Conviction -- score 4+ AND watchlist
    if (score >= 4) {
      var convCard = '🚨 **CONVICTION FLOW**\n' + card + '\n✅ Score ' + score + '/10';
      await sendToDiscord(CONVICTION_WEBHOOK, convCard);
      console.log('[FLOW] Sent to #conviction-flow -- ' + ticker + ' score:' + score);
    }
  }
}

// -- LIVE AGGREGATOR ----------------------------------------------
var liveAggregator = {
  data: {},
  getSummary: function() { return this.data; },
  update: function(ticker, direction, premium) {
    if (!this.data[ticker]) this.data[ticker] = { calls:0, puts:0, premium:0, count:0 };
    var d = this.data[ticker];
    if ((direction||'').toUpperCase().includes('C')) d.calls++;
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
          console.log('[BULLFLOW SSE]', trimmed.slice(0, 120));
          if (!trimmed.startsWith('data: ')) return;

          var raw = trimmed.slice(6).trim();
          if (!raw || raw === '{}') return;

          try {
            var parsed = JSON.parse(raw);
            var event  = parsed.event || '';
            if (event === 'heartbeat' || event === 'init') return;
            if (event === 'alert') {
              var data = parsed.data || parsed;
              var ticker = extractTicker(data.symbol || '');
              liveAggregator.update(ticker, data.symbol || '', data.alertPremium || data.premium || 0);
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
