// capitolTrades.js — Stratum Flow Scout v7.0
// Fetches recent congress trades from capitoltrades.com
// Posts to #congress-trades channel at 9:15AM as RESEARCH ONLY
// NOT used for live trade scoring — data is delayed 30+ days
// -----------------------------------------------------------------

const fetch = require('node-fetch');

function congressWebhook() { return process.env.DISCORD_CONGRESS_WEBHOOK_URL; }

const BASE_URL = 'https://capitoltrades.com/trades';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'text/html',
};

// In-memory cache — refresh every 30 minutes
let cache = {
  trades:    [],
  fetchedAt: 0,
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// -- FETCH CONGRESS TRADES ----------------------------------------
async function fetchCongressTrades() {
  const now = Date.now();
  if (cache.trades.length && now - cache.fetchedAt < CACHE_TTL) {
    return cache.trades;
  }

  try {
    // Use the API endpoint with JSON format
    const url = BASE_URL + '?txDate=30d&page=1&pageSize=100';
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      console.error('[CAPITOL] Fetch failed:', res.status);
      return cache.trades; // return stale cache
    }

    const text = await res.text();

    // Parse trades from the response
    // capitoltrades.com returns HTML — extract trade data from table
    const trades = parseTradesFromHTML(text);

    cache.trades    = trades;
    cache.fetchedAt = now;

    console.log('[CAPITOL] Fetched ' + trades.length + ' congress trades ✅');
    return trades;
  } catch (err) {
    console.error('[CAPITOL] Error:', err.message);
    return cache.trades;
  }
}

// -- PARSE TRADES FROM HTML ---------------------------------------
function parseTradesFromHTML(html) {
  const trades = [];

  try {
    // Extract ticker symbols and transaction types from table rows
    // Pattern: ticker symbol in data attributes or table cells
    const tickerPattern = /([A-Z]{1,5}):US/g;
    const typePattern   = /\b(buy|sell)\b/gi;

    const tickers = [];
    let match;

    while ((match = tickerPattern.exec(html)) !== null) {
      tickers.push(match[1]);
    }

    // Also look for common ticker patterns in the HTML
    const tickerPattern2 = /data-issuer="([A-Z]{1,5})"/g;
    while ((match = tickerPattern2.exec(html)) !== null) {
      tickers.push(match[1]);
    }

    // Extract rows with ticker + transaction type
    // Look for table rows containing ticker and buy/sell
    const rowPattern = /Goto trade detail[\s\S]*?([A-Z]{1,5}):US[\s\S]*?\b(buy|sell)\b/gi;
    while ((match = rowPattern.exec(html)) !== null) {
      trades.push({
        ticker: match[1].toUpperCase(),
        type:   match[2].toLowerCase(),
      });
    }

    // Fallback — just collect unique tickers seen
    if (trades.length === 0) {
      const seen = new Set();
      tickers.forEach(function(t) {
        if (!seen.has(t)) {
          seen.add(t);
          trades.push({ ticker: t, type: 'unknown' });
        }
      });
    }
  } catch (err) {
    console.error('[CAPITOL] Parse error:', err.message);
  }

  return trades;
}

// -- CHECK TICKER -------------------------------------------------
// Returns: { found: bool, buys: int, sells: int, direction: 'buy'|'sell'|'mixed'|null }
async function checkTicker(ticker) {
  const trades = await fetchCongressTrades();

  const matching = trades.filter(function(t) {
    return t.ticker.toUpperCase() === ticker.toUpperCase();
  });

  if (!matching.length) {
    return { found: false, buys: 0, sells: 0, direction: null };
  }

  const buys  = matching.filter(function(t) { return t.type === 'buy'; }).length;
  const sells = matching.filter(function(t) { return t.type === 'sell'; }).length;

  let direction = 'unknown';
  if (buys > 0 && sells === 0)  direction = 'buy';
  if (sells > 0 && buys === 0)  direction = 'sell';
  if (buys > 0 && sells > 0)    direction = 'mixed';

  return { found: true, buys, sells, direction };
}

// -- GET SCORE MODIFIER -------------------------------------------
// Used by ideaValidator to add/subtract from score
// Bull trade + congress bought = +1
// Bear trade + congress sold  = +1
// Bull trade + congress sold  = -1 (warning)
async function getScoreModifier(ticker, tradeDirection) {
  try {
    const result = await checkTicker(ticker);

    if (!result.found) {
      return { modifier: 0, note: null };
    }

    const dir = tradeDirection.toLowerCase(); // 'bull' or 'bear' or 'call' or 'put'
    const isBull = dir === 'bull' || dir === 'call' || dir === 'bullish';
    const isBear = dir === 'bear' || dir === 'put'  || dir === 'bearish';

    if (isBull && result.direction === 'buy') {
      return {
        modifier: 1,
        note: '✅ Congress bought ' + ticker + ' in last 30 days (' + result.buys + ' buys)',
      };
    }

    if (isBear && result.direction === 'sell') {
      return {
        modifier: 1,
        note: '✅ Congress sold ' + ticker + ' in last 30 days (' + result.sells + ' sells)',
      };
    }

    if (isBull && result.direction === 'sell') {
      return {
        modifier: -1,
        note: '⚠️ Congress SOLD ' + ticker + ' in last 30 days — against your direction',
      };
    }

    if (isBear && result.direction === 'buy') {
      return {
        modifier: -1,
        note: '⚠️ Congress BOUGHT ' + ticker + ' in last 30 days — against your direction',
      };
    }

    return {
      modifier: 0,
      note: '📊 Congress activity on ' + ticker + ': ' + result.buys + ' buys / ' + result.sells + ' sells',
    };
  } catch (err) {
    console.error('[CAPITOL] Score error:', err.message);
    return { modifier: 0, note: null };
  }
}

// -- GET RECENT TRADES FOR DISPLAY --------------------------------
async function getRecentTrades(limit) {
  const trades = await fetchCongressTrades();
  return trades.slice(0, limit || 10);
}

// -- POST MORNING CONGRESS REPORT --------------------------------
async function postCongressReport() {
  const webhookUrl = congressWebhook();
  if (!webhookUrl) {
    console.log('[CAPITOL] No DISCORD_CONGRESS_WEBHOOK_URL set');
    return;
  }

  const trades = await fetchCongressTrades();

  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'short', day: 'numeric',
  });

  // Group by ticker
  const byTicker = {};
  trades.forEach(function(t) {
    if (!t.ticker) return;
    if (!byTicker[t.ticker]) byTicker[t.ticker] = { buys: 0, sells: 0 };
    if (t.type === 'buy')  byTicker[t.ticker].buys++;
    if (t.type === 'sell') byTicker[t.ticker].sells++;
  });

  const tickers = Object.keys(byTicker);

  const lines = [
    '🏛️ CONGRESS TRADES — Last 30 Days',
    dateStr,
    '===============================',
    '⚠️  DATA DELAYED 30+ DAYS',
    '   Use for RESEARCH only',
    '   NOT for immediate entries',
    '===============================',
  ];

  if (tickers.length === 0) {
    lines.push('No recent congress trades found');
  } else {
    lines.push('Tickers with recent activity:');
    tickers.slice(0, 15).forEach(function(ticker) {
      const d = byTicker[ticker];
      const buyStr  = d.buys  > 0 ? d.buys  + ' buy'  + (d.buys  > 1 ? 's'  : '') : '';
      const sellStr = d.sells > 0 ? d.sells + ' sell' + (d.sells > 1 ? 's' : '') : '';
      const activity = [buyStr, sellStr].filter(Boolean).join(' / ');
      const arrow = d.buys > d.sells ? '🟢' : d.sells > d.buys ? '🔴' : '🟡';
      lines.push('  ' + arrow + ' ' + ticker.padEnd(6) + ' — ' + activity);
    });
  }

  lines.push('-------------------------------');
  lines.push('Full data: capitoltrades.com');
  lines.push('Time  9:15 AM ET');

  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + lines.join('\n') + '\n```',
        username: 'Stratum Congress',
      }),
    });
    console.log('[CAPITOL] Posted to #congress-trades OK ✅');
  } catch (err) {
    console.error('[CAPITOL] Post error:', err.message);
  }
}

module.exports = { checkTicker, getScoreModifier, getRecentTrades, fetchCongressTrades, postCongressReport };
