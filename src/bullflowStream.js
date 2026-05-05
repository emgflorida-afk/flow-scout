// bullflowStream.js - Stratum Flow Scout v7.4
// FIXED: Ticker extraction from OPRA symbol format O:AMD260410C00230000
// FIXED: Wide net -- ALL watchlist flow posts to #flow-alerts (no score gate)
// FIXED: Score 4+ posts to #conviction-flow only
// FIXED: Compact emoji card format -- 3-line scannable
// FIXED: TS token health check removed from Discord -- Railway logs only
// -----------------------------------------------------------------

const fetch = require('node-fetch');

// Apr 21 2026 PM v3 — AB wants Mag7-only subscription to cut Bullflow
// API burn while traveling. Override via BULLFLOW_WATCHLIST env
// (comma list). Falls back to extended default for server-side use.
var _bfList = (process.env.BULLFLOW_WATCHLIST || '')
  .split(',').map(function(s){ return s.trim().toUpperCase(); }).filter(Boolean);
if (!_bfList.length) {
  _bfList = [
    'SPY','QQQ','IWM','NVDA','TSLA','META','GOOGL',
    'AMZN','MSFT','AMD','JPM','GS','BAC','WFC',
    'MRNA','MRVL','GUSH','UVXY','KO','PEP',
    'CRWV','BA','NFLX','MCD','DKNG','SBUX','HUM','TSLL'
  ];
}
const WATCHLIST = new Set(_bfList);
console.log('[BULLFLOW] Watchlist:', _bfList.length, 'symbols', _bfList.slice(0,10).join(','), _bfList.length > 10 ? '...' : '');

const FLOW_WEBHOOK       = process.env.DISCORD_FLOW_WEBHOOK_URL;
const CONVICTION_WEBHOOK = process.env.DISCORD_CONVICTION_FLOW_WEBHOOK;

// -- RAW RECENT FLOW ALERTS (max 200) ----------------------------
var _recentFlowAlerts = [];
var MAX_RECENT_FLOW = 200;

// Apr 24 2026 — expose SSE connection state for /api/bullflow/health
var _connState = {
  state: 'idle',           // 'idle' | 'connecting' | 'open' | 'error' | 'retrying'
  lastStatusCode: null,    // fetch response status
  lastErrorMsg: null,      // error string from fetch or parse
  lastConnectAt: null,     // ISO ts when stream opened
  lastAlertAt: null,       // ISO ts when last alert arrived
  lastDataAt: null,        // ISO ts when last SSE chunk arrived (even heartbeats)
  alertsReceived: 0,       // total alert events since boot
  chunksReceived: 0,       // total SSE chunks since boot (includes heartbeats)
  retryCount: 0,
};
function getConnState() {
  return Object.assign({}, _connState, { alertsBuffered: _recentFlowAlerts.length });
}

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
  _connState.alertsReceived++;
  _connState.lastAlertAt = entry.timestamp;
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

  // v6.2 (Apr 27 PM): WIRE INTO CLUSTER ENGINE.
  // Apr 27 root-cause: flowCluster.addFlow had zero callers in codebase.
  // Live alerts hit liveAggregator + Discord but NEVER reached the cluster
  // engine, so cards never fired even with obvious institutional flow
  // (AMD puts, NVDA calls today). Now every processAlert feeds clusters too.
  try {
    var flowCluster = require('./flowCluster');
    flowCluster.addFlow({
      id:           alert.id || alert.alertId || null,
      opra:         rawSymbol,
      symbol:       rawSymbol,
      totalPremium: prem,
      ticker:       ticker,
      score:        score,
    });
  } catch(e) {
    console.error('[FLOW->CLUSTER] feed error:', e.message);
  }

  // Phase 4.1 (May 5): WIRE INTO UOA DETECTOR.
  // Every Bullflow alert now scored for UOA. If score >= 7 (premium / sweep /
  // velocity / whale flag stack), uoaDetector pushes Discord card and checks
  // alertTiers for stack confluence. If whale + Tier 1+2 stacked = AUTO-FIRE
  // SIM intent. This closes the "institutions piling in → system sees it →
  // screens chart at AB" loop AB asked for this morning.
  try {
    var uoaDetector = require('./uoaDetector');
    // Determine direction from OPRA symbol's C/P character
    var contractMatch = rawSymbol.match(/\d{6}([CP])\d/);
    var optType = contractMatch ? contractMatch[1] : null;
    var opraDirection = optType === 'C' ? 'long' : optType === 'P' ? 'short' : 'unknown';
    var direction = opraDirection;

    // Phase 4.2.2 (May 5 PM): If this is a custom alert, let the filter name
    // resolve direction — "AB Bullish Flow" forces long, mismatch with OPRA
    // gets flagged for downstream warning.
    var filterDirResolution = null;
    try {
      var bff = require('./bullflowFilters');
      var rawFilterAlertName = alert.alertName || alert.alert_name || null;
      if (rawFilterAlertName) {
        filterDirResolution = bff.resolveDirection(rawFilterAlertName, opraDirection);
        if (filterDirResolution && filterDirResolution.direction !== 'unknown') {
          direction = filterDirResolution.direction;
        }
      }
    } catch (e) { /* fail open */ }

    // Extract local vol/oi/type since they're not in processAlert scope
    var uoaVol  = parseInt(alert.volume || alert.size || 0, 10);
    var uoaOi   = parseInt(alert.open_interest || alert.openInterest || 0, 10);
    var uoaType = String(alert.alert_type || alert.alertType || alert.alertName || 'unknown').toLowerCase();

    // PHASE 4.2.1 (May 5 PM): Detect Bullflow custom alerts (AB's saved filters).
    // Bullflow's /v1/streaming/alerts emits both algo alerts AND any custom
    // alerts matching saved filters in the dashboard. data.alertType is
    // either "algo" (Bullflow built-in) or "custom" (AB's curated thesis).
    // Custom = pre-curated by AB → high-signal → bypass score threshold + boost.
    var rawAlertType = String(alert.alertType || alert.alert_type || '').toLowerCase();
    var isCustomAlert = rawAlertType === 'custom';
    var customAlertName = isCustomAlert ? (alert.alertName || alert.alert_name || 'Custom') : null;

    // Phase 5.3 — compute per-contract trade price for peak return lookup.
    // Bullflow live stream emits alertPremium (total $) but not per-contract
    // tradePrice. Equity options × 100 multiplier.
    var pricePerContract = (uoaVol > 0 && prem > 0) ? prem / (uoaVol * 100) : null;
    var tradeTimestamp = alert.timestamp ? Math.floor(parseFloat(alert.timestamp)) : Math.floor(Date.now() / 1000);

    // Normalize payload for uoaDetector
    var uoaPayload = {
      ticker:          ticker,
      direction:       direction,
      contractSymbol:  rawSymbol,
      totalPremium:    prem,
      premium:         prem,
      size:            uoaVol,
      volOiRatio:      uoaOi > 0 && uoaVol > 0 ? uoaVol / uoaOi : 0,
      velocity:        alert.velocity || 0,
      isWhale:         prem > 10000000,
      alertType:       uoaType,
      bullflowAlertCategory: isCustomAlert ? 'custom' : 'algo',
      isCustomAlert:   isCustomAlert,
      customAlertName: customAlertName,
      bullflowAlertName: alert.alertName || alert.alert_name || null,
      executionType:   alert.execution_type || alert.executionType || null,
      flowScore:       score,
      // Phase 4.2.2 — propagate filter resolution + meta downstream
      opraDirection:   opraDirection,
      filterMeta:      filterDirResolution ? filterDirResolution.filterMeta : null,
      directionAlignment: filterDirResolution ? filterDirResolution.alignment : null,
      // Phase 5.3 — for peakReturn lookup
      tradePrice:      pricePerContract,
      tradeTimestamp:  tradeTimestamp,
    };
    // Fire-and-forget — don't await (don't slow down main flow processing)
    uoaDetector.handleAlert(uoaPayload).catch(function(e) {
      console.error('[FLOW->UOA] handleAlert error:', e.message);
    });
  } catch(e) {
    console.error('[FLOW->UOA] wire error:', e.message);
  }

  // Apr 20 2026: Discord flow posts OFF by default (AB decision). Flow routes to
  // scanner only. liveAggregator still receives all alerts (scanner populates).
  // Re-enable by setting FLOW_DISCORD_ENABLED=true.
  var discordEnabled = (process.env.FLOW_DISCORD_ENABLED || '').toLowerCase() === 'true';

  if (onList && discordEnabled) {
    var card = formatFlowCard(alert, ticker, score);
    await sendToDiscord(FLOW_WEBHOOK, card);
    console.log('[FLOW] Sent to #flow-alerts -- ' + ticker);

    // Conviction -- score 4+ AND watchlist
    if (score >= 4) {
      var convCard = '🚨 **CONVICTION FLOW**\n' + card + '\n✅ Score ' + score + '/10';
      await sendToDiscord(CONVICTION_WEBHOOK, convCard);
      console.log('[FLOW] Sent to #conviction-flow -- ' + ticker + ' score:' + score);
    }
  } else if (onList) {
    // Silent — scanner still gets data via liveAggregator
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

// -- DISK-BASED KEY STORE (Railway lazy-env workaround) --
// HTTP request context can see process.env.BULLFLOW_API_KEY and writes it
// to a persistent file. setInterval/startup paths (which can't see the env)
// read from that file on each retry.
var _keyFile = (process.env.STATE_DIR || '/tmp') + '/bullflow_key.txt';
function readKeyFromDisk() {
  try {
    var fs = require('fs');
    if (fs.existsSync(_keyFile)) {
      var k = fs.readFileSync(_keyFile, 'utf8').trim();
      if (k && k.length > 5) return k;
    }
  } catch(e) {}
  return null;
}
function writeKeyToDisk(k) {
  try {
    var fs = require('fs');
    fs.writeFileSync(_keyFile, k);
    console.log('[BULLFLOW] Wrote key to disk at ' + _keyFile);
    return true;
  } catch(e) {
    console.error('[BULLFLOW] Failed writing key to disk:', e.message);
    return false;
  }
}

// ⚠️ TEMPORARY HARDCODE — Apr 20 2026 PM ⚠️
// Railway lazy env injection can't inject to background contexts (setInterval,
// module load). HTTP request context CAN see process.env.BULLFLOW_API_KEY but
// the streaming setup needs to run in background. 9 attempts to bridge failed.
// AB provided the key for hardcode so flow column can populate today.
//
// Apr 21 2026 PM: Removed stale hardcoded FALLBACK_KEY (was causing 403
// loop even after env was updated). Stream now uses env key only. If env
// missing → stream fails loudly instead of using a dead key.
// Old key (DELETED): bull_3ea4d29262a9cda5b0ee9d951b389d1fe60c0185e67cd43c
var FALLBACK_KEY = null;

// -- MAIN STREAM --------------------------------------------------
function startBullflowStream(apiKeyOverride) {
  var diskKey = readKeyFromDisk();
  var apiKey = apiKeyOverride || _cachedApiKey || process.env.BULLFLOW_API_KEY || diskKey || FALLBACK_KEY;
  console.log('[BULLFLOW] startBullflowStream called. override=' + (apiKeyOverride ? 'YES len='+apiKeyOverride.length : 'no') + ', cached=' + (_cachedApiKey ? 'YES' : 'no') + ', env=' + (process.env.BULLFLOW_API_KEY ? 'YES' : 'no') + ', disk=' + (diskKey ? 'YES len='+diskKey.length : 'no'));
  if (apiKeyOverride) {
    _cachedApiKey = apiKeyOverride;
    writeKeyToDisk(apiKeyOverride);
  }
  if (!apiKey) {
    // Apr 20 2026: self-heal mode. Instead of giving up, re-check every 60s
    // so the stream connects as soon as the env var becomes available (e.g.
    // Railway variable shared-group update or late env injection).
    var envKeys = Object.keys(process.env).filter(function(k){ return k.indexOf('BULLFLOW') >= 0 || k.indexOf('FLOW') >= 0; });
    console.error('[BULLFLOW] No API key on startup. Process sees env keys matching FLOW/BULLFLOW: ' + JSON.stringify(envKeys) + '. Will retry every 60s...');
    var retryTimer = setInterval(function() {
      var diskK = readKeyFromDisk();
      var k = process.env.BULLFLOW_API_KEY || _cachedApiKey || diskK;
      console.log('[BULLFLOW] retry: env=' + (process.env.BULLFLOW_API_KEY ? 'YES' : 'no') + ', cached=' + (_cachedApiKey ? 'YES' : 'no') + ', disk=' + (diskK ? 'YES' : 'no'));
      if (k && typeof k === 'string' && k.length > 5) {
        console.log('[BULLFLOW] API key available (length ' + k.length + '). Connecting now.');
        clearInterval(retryTimer);
        startBullflowStream(k);
      }
    }, 20 * 1000);  // retry every 20s
    return;
  }
  console.log('[BULLFLOW] Connecting to stream (key length=' + apiKey.length + ')...');

  var MAX_RETRIES     = 10;
  var RETRY_DELAY_MS  = 60 * 1000;  // Apr 20 2026: 5s → 60s. Bullflow 429s on rapid retries.
  var retryCount      = 0;

  var connect = function() {
    if (retryCount >= MAX_RETRIES) {
      console.error('[BULLFLOW] Max retries (' + MAX_RETRIES + ') reached -- stopping reconnection. Manual restart needed.');
      return;
    }

    if (retryCount > 0) {
      console.log('[BULLFLOW] Reconnect attempt ' + retryCount + '/' + MAX_RETRIES + '...');
    }

    _connState.state = 'connecting';
    _connState.retryCount = retryCount;

    // Auth via query param (confirmed by 429 response on Apr 20 2026 — key works, was rate-limited)
    fetch('https://api.bullflow.io/v1/streaming/alerts?key=' + apiKey, {
      headers: { 'Accept': 'text/event-stream' }
    }).then(function(res) {
      _connState.lastStatusCode = res.status;
      if (!res.ok) {
        // 429 = rate-limited; longer backoff
        var delay = res.status === 429 ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
        _connState.state = 'retrying';
        _connState.lastErrorMsg = 'http ' + res.status;
        console.error('[BULLFLOW] Connection failed:', res.status, '— retrying in', Math.round(delay/1000) + 's');
        retryCount++;
        setTimeout(connect, delay);
        return;
      }
      // Reset retry count on successful connection
      retryCount = 0;
      _connState.state = 'open';
      _connState.lastConnectAt = new Date().toISOString();
      _connState.lastErrorMsg = null;
      console.log('[BULLFLOW] Stream connected OK');
      var buffer = '';

      res.body.on('data', function(chunk) {
        _connState.chunksReceived++;
        _connState.lastDataAt = new Date().toISOString();
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
            // Apr 24 2026 — track every event type for health diagnostic
            _connState.eventTypeCounts = _connState.eventTypeCounts || {};
            _connState.eventTypeCounts[event || '(no-event-field)'] = (_connState.eventTypeCounts[event || '(no-event-field)'] || 0) + 1;
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
              return;
            }
            // Apr 24 2026 — if we get an event we don't recognize, store a sample so
            // we can inspect it via the health endpoint (first 2 unknown events only)
            _connState.unknownSamples = _connState.unknownSamples || [];
            if (_connState.unknownSamples.length < 2) {
              _connState.unknownSamples.push({ event: event, keys: Object.keys(parsed).slice(0, 10), raw: raw.slice(0, 300) });
            }
          } catch(e) {
            console.log('[BULLFLOW] Parse error:', e.message);
            _connState.lastParseError = e.message;
          }
        });
      });

      res.body.on('error', function(err) {
        console.error('[BULLFLOW] Stream error:', err.message);
        retryCount++;
        setTimeout(connect, RETRY_DELAY_MS);
      });

      res.body.on('end', function() {
        _connState.state = 'retrying';
        _connState.lastErrorMsg = 'stream ended';
        console.log('[BULLFLOW] Stream ended -- reconnecting in ' + (RETRY_DELAY_MS / 1000) + 's...');
        retryCount++;
        setTimeout(connect, RETRY_DELAY_MS);
      });

    }).catch(function(err) {
      _connState.state = 'error';
      _connState.lastErrorMsg = err && err.message ? err.message : String(err);
      console.error('[BULLFLOW] Connection error:', err.message);
      retryCount++;
      setTimeout(connect, RETRY_DELAY_MS);
    });
  };

  connect();
}

module.exports = { startBullflowStream, liveAggregator, getRecentFlow, setCachedApiKey, getConnState };
