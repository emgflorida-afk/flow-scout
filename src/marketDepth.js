// marketDepth.js - Level 2 / Market Depth via TradeStation Streaming API
// Provides bid/ask size at multiple price levels for entry confirmation
// Usage: GET /api/depth/:symbol

var fetch = require('node-fetch');

var _depthCache = {}; // { TSLA: { bids: [...], asks: [...], updated: Date } }
var CACHE_TTL = 5000; // 5 seconds

async function getToken() {
  try {
    var ts = require('./tradestation');
    return await ts.getAccessToken();
  } catch(e) { return null; }
}

function getTSBase() { return 'https://api.tradestation.com/v3'; }

// Fetch market depth snapshot via streaming endpoint (read first chunk then close)
async function fetchDepth(symbol) {
  try {
    // Check cache
    var cached = _depthCache[symbol];
    if (cached && (Date.now() - cached.updated) < CACHE_TTL) return cached;

    var token = await getToken();
    if (!token) return null;

    var url = getTSBase() + '/marketdata/stream/marketdepth/quotes/' + encodeURIComponent(symbol);
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (!res.ok) {
      console.error('[DEPTH] HTTP', res.status, 'for', symbol);
      return null;
    }

    // Read first chunk from SSE stream then close
    var depth = { symbol: symbol, bids: [], asks: [], updated: Date.now() };
    var buffer = '';

    await new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function() {
        if (!done) { done = true; res.body.destroy(); resolve(); }
      }, 3000);

      res.body.on('data', function(chunk) {
        buffer += chunk.toString();
        var parts = buffer.split('\n');
        buffer = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (!line) continue;
          try {
            var obj = JSON.parse(line);
            if (obj && obj.Bids) {
              depth.bids = obj.Bids.map(function(b) {
                return { price: parseFloat(b.Price || 0), size: parseInt(b.Size || 0) };
              });
            }
            if (obj && obj.Asks) {
              depth.asks = obj.Asks.map(function(a) {
                return { price: parseFloat(a.Price || 0), size: parseInt(a.Size || 0) };
              });
            }
            // Got data, close stream
            if (depth.bids.length > 0 || depth.asks.length > 0) {
              clearTimeout(timer);
              if (!done) { done = true; res.body.destroy(); resolve(); }
            }
          } catch(e) { /* skip */ }
        }
      });

      res.body.on('end', function() { clearTimeout(timer); if (!done) { done = true; resolve(); } });
      res.body.on('error', function() { clearTimeout(timer); if (!done) { done = true; resolve(); } });
    });

    // Sort bids descending, asks ascending
    depth.bids.sort(function(a, b) { return b.price - a.price; });
    depth.asks.sort(function(a, b) { return a.price - b.price; });

    // Find walls (large size concentrations)
    var avgBidSize = depth.bids.reduce(function(s, b) { return s + b.size; }, 0) / (depth.bids.length || 1);
    var avgAskSize = depth.asks.reduce(function(s, a) { return s + a.size; }, 0) / (depth.asks.length || 1);

    depth.walls = {
      bidWalls: depth.bids.filter(function(b) { return b.size > avgBidSize * 3; }),
      askWalls: depth.asks.filter(function(a) { return a.size > avgAskSize * 3; }),
    };

    depth.summary = {
      totalBidSize: depth.bids.reduce(function(s, b) { return s + b.size; }, 0),
      totalAskSize: depth.asks.reduce(function(s, a) { return s + a.size; }, 0),
      levels: depth.bids.length + depth.asks.length,
    };

    // Bid/ask imbalance — positive = more buyers, negative = more sellers
    var totalBid = depth.summary.totalBidSize;
    var totalAsk = depth.summary.totalAskSize;
    depth.summary.imbalance = totalBid + totalAsk > 0
      ? parseFloat(((totalBid - totalAsk) / (totalBid + totalAsk) * 100).toFixed(1))
      : 0;
    depth.summary.bias = depth.summary.imbalance > 10 ? 'BUYERS' : depth.summary.imbalance < -10 ? 'SELLERS' : 'BALANCED';

    _depthCache[symbol] = depth;
    console.log('[DEPTH] ' + symbol + ' | ' + depth.bids.length + ' bids, ' + depth.asks.length + ' asks | bias: ' + depth.summary.bias);
    return depth;
  } catch(e) {
    console.error('[DEPTH] Error for', symbol, ':', e.message);
    return null;
  }
}

module.exports = { fetchDepth };
