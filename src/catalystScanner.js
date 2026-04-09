// catalystScanner.js - Stratum Flow Scout v8.1
// Pre-market catalyst scanner -- like primo's Stratalyst
// Scans: analyst upgrades/downgrades, earnings, news events
// Posts daily brief at 8:30 AM with direction + options play
// -----------------------------------------------------------------

var fetch = require('node-fetch');

function getFinnhubKey() { return process.env.FINNHUB_API_KEY; }

var WATCHLIST = [
  'SPY','QQQ','IWM',
  'NVDA','TSLA','META','GOOGL','AMZN','MSFT','AMD','AAPL','MRVL',
  'JPM','GS','MS','WFC','BAC','V','MA',
  'XLE','XOM','CVX','COP',
  'UNH','MRK','LLY','ABBV',
  'WMT','COST','HD','TGT',
  'COIN','MSTR','PLTR','DKNG','RIVN',
  'KO','PEP','BA','NFLX','CRM',
  'INTC','AVGO','QCOM','MU',
];

// -- GET ANALYST RECOMMENDATIONS (upgrades/downgrades) ------------
async function getAnalystActions(symbol) {
  try {
    var key = getFinnhubKey();
    if (!key) return [];
    var url = 'https://finnhub.io/api/v1/stock/recommendation?symbol=' + symbol + '&token=' + key;
    var res = await fetch(url);
    var data = await res.json();
    if (!Array.isArray(data)) return [];
    // Only return recent (last 7 days)
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    return data.filter(function(r) {
      return new Date(r.period) >= cutoff;
    }).map(function(r) {
      return {
        symbol: symbol,
        period: r.period,
        buy: r.buy,
        hold: r.hold,
        sell: r.sell,
        strongBuy: r.strongBuy,
        strongSell: r.strongSell,
      };
    });
  } catch(e) { return []; }
}

// -- GET UPGRADE/DOWNGRADE EVENTS ---------------------------------
async function getUpgradeDowngrade(symbol) {
  try {
    var key = getFinnhubKey();
    if (!key) return [];
    var from = new Date();
    from.setDate(from.getDate() - 3);
    var to = new Date();
    var url = 'https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=' + symbol +
      '&from=' + from.toISOString().slice(0, 10) +
      '&to=' + to.toISOString().slice(0, 10) +
      '&token=' + key;
    var res = await fetch(url);
    var data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(function(d) {
      var action = 'NEUTRAL';
      var optionsPlay = '';
      var fromGrade = (d.fromGrade || '').toLowerCase();
      var toGrade = (d.toGrade || '').toLowerCase();
      var actionType = (d.action || '').toLowerCase();

      // Determine direction
      if (actionType.includes('downgrade') || toGrade.includes('sell') || toGrade.includes('underweight') || toGrade.includes('underperform')) {
        action = 'BEARISH';
        optionsPlay = 'PUTS';
      } else if (actionType.includes('upgrade') || toGrade.includes('buy') || toGrade.includes('overweight') || toGrade.includes('outperform')) {
        action = 'BULLISH';
        optionsPlay = 'CALLS';
      } else if (actionType.includes('init') && (toGrade.includes('buy') || toGrade.includes('overweight'))) {
        action = 'BULLISH';
        optionsPlay = 'CALLS';
      } else if (actionType.includes('init') && (toGrade.includes('sell') || toGrade.includes('underweight'))) {
        action = 'BEARISH';
        optionsPlay = 'PUTS';
      }

      return {
        symbol: symbol,
        company: d.company || '',
        action: actionType,
        fromGrade: d.fromGrade || '',
        toGrade: d.toGrade || '',
        priceTarget: d.priceTarget || null,
        date: d.gradeTime || '',
        direction: action,
        optionsPlay: optionsPlay,
        notable: action !== 'NEUTRAL',
      };
    });
  } catch(e) { return []; }
}

// -- GET COMPANY NEWS (catalysts) ---------------------------------
async function getCompanyNews(symbol) {
  try {
    var key = getFinnhubKey();
    if (!key) return [];
    var from = new Date();
    from.setDate(from.getDate() - 1);
    var to = new Date();
    var url = 'https://finnhub.io/api/v1/company-news?symbol=' + symbol +
      '&from=' + from.toISOString().slice(0, 10) +
      '&to=' + to.toISOString().slice(0, 10) +
      '&token=' + key;
    var res = await fetch(url);
    var data = await res.json();
    if (!Array.isArray(data)) return [];
    // Only high-impact headlines
    return data.slice(0, 3).map(function(n) {
      return {
        symbol: symbol,
        headline: n.headline || '',
        source: n.source || '',
        datetime: n.datetime,
        url: n.url || '',
      };
    });
  } catch(e) { return []; }
}

// -- SCAN ALL WATCHLIST FOR CATALYSTS -----------------------------
async function scanCatalysts() {
  var allUpgrades = [];
  var allNews = [];

  // Scan in batches to respect rate limits (60 calls/min on Finnhub)
  for (var i = 0; i < WATCHLIST.length; i++) {
    var sym = WATCHLIST[i];
    try {
      var upgrades = await getUpgradeDowngrade(sym);
      if (upgrades.length > 0) {
        allUpgrades = allUpgrades.concat(upgrades);
      }
      // Rate limit: 60/min = 1 per second
      if (i % 2 === 0) {
        await new Promise(function(r) { setTimeout(r, 1100); });
      }
    } catch(e) { /* skip */ }
  }

  // Get notable news for tickers that had upgrades/downgrades
  var notableTickers = allUpgrades.filter(function(u) { return u.notable; }).map(function(u) { return u.symbol; });
  var uniqueNotable = Array.from(new Set(notableTickers));

  for (var j = 0; j < uniqueNotable.length; j++) {
    try {
      var news = await getCompanyNews(uniqueNotable[j]);
      allNews = allNews.concat(news);
      await new Promise(function(r) { setTimeout(r, 1100); });
    } catch(e) { /* skip */ }
  }

  // Sort: notable first, then by date
  allUpgrades.sort(function(a, b) {
    if (a.notable && !b.notable) return -1;
    if (!a.notable && b.notable) return 1;
    return (b.date || '').localeCompare(a.date || '');
  });

  return {
    timestamp: new Date().toISOString(),
    totalScanned: WATCHLIST.length,
    upgrades: allUpgrades,
    notableCount: allUpgrades.filter(function(u) { return u.notable; }).length,
    news: allNews,
  };
}

// -- BUILD CATALYST BRIEF FOR DISCORD -----------------------------
function buildCatalystBrief(catalysts) {
  var lines = [
    '📰 DAILY CATALYST BRIEF',
    WATCHLIST.length + ' tickers scanned • ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
    '===============================',
  ];

  var notable = catalysts.upgrades.filter(function(u) { return u.notable; });

  if (notable.length === 0) {
    lines.push('No notable analyst actions today');
  } else {
    lines.push('UPGRADES / DOWNGRADES:');
    lines.push('');
    for (var i = 0; i < notable.length; i++) {
      var u = notable[i];
      var emoji = u.direction === 'BULLISH' ? '🟢' : '🔴';
      var ptStr = u.priceTarget ? ' PT $' + u.priceTarget : '';
      lines.push(emoji + ' ' + u.symbol + ' | ' + u.company + ' | ' + u.action.toUpperCase() + ' → ' + u.toGrade + ptStr);
      lines.push('   ' + u.direction + ' | Options play: ' + u.optionsPlay);
    }
  }

  if (catalysts.news.length > 0) {
    lines.push('');
    lines.push('KEY NEWS:');
    for (var j = 0; j < Math.min(catalysts.news.length, 5); j++) {
      var n = catalysts.news[j];
      lines.push('📌 ' + n.symbol + ': ' + (n.headline || '').slice(0, 100));
    }
  }

  return lines.join('\n');
}

// -- POST CATALYST BRIEF TO DISCORD -------------------------------
async function postCatalystBrief() {
  try {
    console.log('[CATALYST] Scanning watchlist for catalysts...');
    var catalysts = await scanCatalysts();
    var brief = buildCatalystBrief(catalysts);
    console.log('[CATALYST] Brief built:', catalysts.notableCount, 'notable actions');

    var webhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK;
    if (webhook) {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '```\n' + brief + '\n```', username: 'Stratum Catalyst Scanner' }),
      });
      console.log('[CATALYST] Brief posted to Discord');
    }

    return catalysts;
  } catch(e) {
    console.error('[CATALYST] Error:', e.message);
    return null;
  }
}

module.exports = { scanCatalysts, postCatalystBrief, getUpgradeDowngrade, getCompanyNews, buildCatalystBrief };
