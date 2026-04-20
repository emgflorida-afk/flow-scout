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
  'MRNA','MRVL','GUSH','UVXY','KO','PEP',
  'CRWV','BA','NFLX','MCD','DKNG','SBUX','HUM','TSLL'
]);

const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_FLOW_WEBHOOK;

// -- RAW RECENT FLOW ALERTS (max 200) ----------------------------
var _recentFlowAlerts = [];
var MAX_RECENT_FLOW = 200;

function pushRecentFlow(alert, ticker, score) {
  var rawSymbol = alert.symbol || '';
  var direction = parseDirection(rawSymbol);
  var prem  = parseFloat(alert.premium || alert.alertPremium || alert.total_premium || 0);
  var vol   = parseInt(alert.volume || 0);
  var oi    = parseInt(alert.open_interest || alert.openInterest || 0);
  var type  = (alert.alert_type || alert.alertType || alert.alertName || 'unknown').toLowerCase();

  // Extract strike/expiry from OPRA
  var strike = null;
  var expiry = null;
  var m = rawSymbol.replace(/^O:/, '').match(/^[A-Z]+(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
  if (m) {
    strike = parseInt(m[5]);
    expiry = m[2] + '/' + m[3] + '/20' + m[1];
  }

  var entry = {
    ticker:        ticker,
    strike:        strike,
    expiry:        expiry,
    callPut:       direction,
    premium:       prem,
    volume:        vol,
    openInterest:  oi,
    alertType:     type,
    score:         score,
    timestamp:     new Date().toISOString(),
    executionType: alert.execution_type || alert.executionType || null,
    rawSymbol:     rawSymbol,
  };

  _recentFlowAlerts.push(entry);
  console.log('[FLOW] Alert stored:', ticker, type, prem > 0 ? '$' + Math.round(prem) : 'no-premium');
  // Trim to max size
  if (_recentFlowAlerts.length > MAX_RECENT_FLOW) {
    _recentFlowAlerts = _recentFlowAlerts.slice(_recentFlowAlerts.length - MAX_RECENT_FLOW);
  }
}

function getRecentFlow(filters) {
  var result = _recentFlowAlerts;
  if (!filters) return result;

  if (filters.symbol) {
    var sym = filters.symbol.toUpperCase();
    result = result.filter(function(a) { return a.ticker === sym; });
  }
  if (filters.minPremium) {
    var minP = parseFloat(filters.minPremium);
    result = result.filter(function(a) { return a.premium >= minP; });
  }
  if (filters.alertType) {
    var at = filters.alertType.toLowerCase();
    result = result.filter(function(a) { return a.alertType.includes(at); });
  }
  if (filters.callPut) {
    var cp = filters.callPut.toUpperCase();
    result = result.filter(function(a) { return a.callPut === cp; });
  }
  return result;
}

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

// Apr 20 2026 — CACHED KEY (for Railway lazy-env workaround).
// When HTTP requests resolve the env var (lazy injection works for request
// context), they can call setCachedApiKey to save it for background code.
var _cachedApiKey = null;
function setCachedApiKey(k) {
  if (typeof k === 'string' && k.length > 5) {
    _cachedApiKey = k;
    console.log('[BULLFLOW] API key cached via setCachedApiKey (length ' + k.length + ')');
  }
}

// -- MAIN STREAM --------------------------------------------------
// Apr 20 2026: apiKeyOverride param lets HTTP handlers pass the key directly
// (Railway lazy env workaround).
function startBullflowStream(apiKeyOverride) {
  var apiKey = apiKeyOverride || _cachedApiKey || process.env.BULLFLOW_API_KEY;
  console.log('[BULLFLOW] startBullflowStream called. override=' + (apiKeyOverride ? 'YES len='+apiKeyOverride.length : 'no') + ', cached=' + (_cachedApiKey ? 'YES' : 'no') + ', env=' + (process.env.BULLFLOW_API_KEY ? 'YES' : 'no'));
  if (apiKeyOverride && !_cachedApiKey) {
    _cachedApiKey = apiKeyOverride;
    console.log('[BULLFLOW] Cached override key for future reconnects');
  }
  if (!apiKey) {
    // Apr 20 2026: self-heal mode. Instead of giving up, re-check every 60s
    // so the stream connects as soon as the env var becomes available (e.g.
    // Railway variable shared-group update or late env injection).
    var envKeys = Object.keys(process.env).filter(function(k){ return k.indexOf('BULLFLOW') >= 0 || k.indexOf('FLOW') >= 0; });
    console.error('[BULLFLOW] No API key on startup. Process sees env keys matching FLOW/BULLFLOW: ' + JSON.stringify(envKeys) + '. Will retry every 60s...');
    var retryTimer = setInterval(function() {
      var k = process.env.BULLFLOW_API_KEY || _cachedApiKey;
      console.log('[BULLFLOW] retry: env=' + (process.env.BULLFLOW_API_KEY ? 'YES' : 'no') + ', cached=' + (_cachedApiKey ? 'YES' : 'no'));
      if (k && typeof k === 'string' && k.length > 5) {
        console.log('[BULLFLOW] API key detected on retry (length ' + k.length + '). Connecting now.');
        clearInterval(retryTimer);
        startBullflowStream();
      }
    }, 60 * 1000);
    return;
  }
  console.log('[BULLFLOW] Connecting to stream (key length=' + apiKey.length + ')...');

  var MAX_RETRIES     = 10;
  var RETRY_DELAY_MS  = 5000;
  var retryCount      = 0;

  var connect = function() {
    if (retryCount >= MAX_RETRIES) {
      console.error('[BULLFLOW] Max retries (' + MAX_RETRIES + ') reached -- stopping reconnection. Manual restart needed.');
      return;
    }

    if (retryCount > 0) {
      console.log('[BULLFLOW] Reconnect attempt ' + retryCount + '/' + MAX_RETRIES + '...');
    }

    fetch('https://api.bullflow.io/v1/streaming/alerts?key=' + apiKey, {
      headers: { 'Accept': 'text/event-stream' }
    }).then(function(res) {
      if (!res.ok) {
        console.error('[BULLFLOW] Connection failed:', res.status);
        retryCount++;
        setTimeout(connect, RETRY_DELAY_MS);
        return;
      }
      // Reset retry count on successful connection
      retryCount = 0;
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
              var alertScore = scoreFlow(data);
              var alertPremium = data.alertPremium || data.premium || 0;
              liveAggregator.update(ticker, data.symbol || '', alertPremium);
              // Store flow BEFORE processing alert -- ensures data is captured even if processAlert throws
              pushRecentFlow(data, ticker, alertScore);
              processAlert(data);
            }
          } catch(e) {
            console.log('[BULLFLOW] Parse error:', e.message);
          }
        });
      });

      res.body.on('error', function(err) {
        console.error('[BULLFLOW] Stream error:', err.message);
        retryCount++;
        setTimeout(connect, RETRY_DELAY_MS);
      });

      res.body.on('end', function() {
        console.log('[BULLFLOW] Stream ended -- reconnecting in ' + (RETRY_DELAY_MS / 1000) + 's...');
        retryCount++;
        setTimeout(connect, RETRY_DELAY_MS);
      });

    }).catch(function(err) {
      console.error('[BULLFLOW] Connection error:', err.message);
      retryCount++;
      setTimeout(connect, RETRY_DELAY_MS);
    });
  };

  connect();
}

module.exports = { startBullflowStream, liveAggregator, getRecentFlow, setCachedApiKey };
