// economicCalendar.js - Stratum Flow Scout v7.2
// Pulls economic events from Finnhub + market news from Polygon
// Posts daily briefing to #strat-alerts at 9:15AM ET
// Blocks high impact trade entries automatically

var fetch = require('node-fetch');

function getFinnhubKey() { return process.env.FINNHUB_API_KEY; }
function getPolygonKey() { return process.env.POLYGON_API_KEY; }
function getWebhook()    { return process.env.DISCORD_CALENDAR_WEBHOOK || process.env.DISCORD_WEBHOOK_URL; }
function getNewsApiKey() { return process.env.NEWS_API_KEY; }

// Impact levels from Finnhub: 1=low, 2=medium, 3=high
var IMPACT_LABELS = { '1': 'LOW', '2': 'MEDIUM', '3': 'HIGH' };
var IMPACT_EMOJI  = { '1': 'GREEN', '2': 'ORANGE', '3': 'RED' };

// High impact events that block trading
var HIGH_IMPACT_EVENTS = [
  'Non Farm', 'Nonfarm', 'NFP',
  'CPI', 'Consumer Price',
  'FOMC', 'Fed Decision', 'Interest Rate Decision',
  'GDP', 'Gross Domestic',
  'Unemployment', 'Jobless Claims',
  'PCE', 'Personal Consumption',
  'ISM', 'PMI',
  'Retail Sales',
  'PPI', 'Producer Price',
];

// Geopolitical keywords to watch
var GEO_KEYWORDS = [
  'Iran', 'Hormuz', 'tariff', 'trade war', 'trade deal',
  'Fed', 'Federal Reserve', 'rate cut', 'rate hike',
  'peace deal', 'ceasefire', 'sanctions',
  'China', 'Taiwan', 'Russia', 'Ukraine',
  'Trump', 'executive order', 'emergency',
];

// Cached state for trade blocking
var state = {
  highImpactEvents: [],
  geoAlerts: [],
  blockTrading: false,
  blockReason: null,
  blockUntil: null,
  lastUpdated: null,
};

// -- FETCH ECONOMIC CALENDAR FROM FINNHUB ----------------------
async function fetchEconomicCalendar() {
  var key = getFinnhubKey();
  if (!key) { console.log('[CAL] No Finnhub key'); return []; }
  try {
    var today = new Date().toISOString().split('T')[0];
    var url   = 'https://finnhub.io/api/v1/calendar/economic?from=' + today + '&to=' + today + '&token=' + key;
    var res   = await fetch(url);
    if (!res.ok) { console.error('[CAL] Finnhub error:', res.status); return []; }
    var data  = await res.json();
    var events = data && data.economicCalendar ? data.economicCalendar : [];
    console.log('[CAL] Got ' + events.length + ' economic events today');
    return events;
  } catch(e) { console.error('[CAL] fetchEconomicCalendar error:', e.message); return []; }
}

// -- FETCH MARKET NEWS FROM POLYGON ----------------------------
async function fetchMarketNews() {
  var key = getPolygonKey();
  if (!key) { console.log('[CAL] No Polygon key'); return []; }
  try {
    var url = 'https://api.polygon.io/v2/reference/news?ticker=SPY&limit=10&apiKey=' + key;
    var res = await fetch(url);
    if (!res.ok) { console.error('[CAL] Polygon news error:', res.status); return []; }
    var data = await res.json();
    var results = data && data.results ? data.results : [];
    console.log('[CAL] Got ' + results.length + ' news items');
    return results;
  } catch(e) { console.error('[CAL] fetchMarketNews error:', e.message); return []; }
}

// -- CHECK IF EVENT IS HIGH IMPACT ----------------------------
function isHighImpactEvent(eventName) {
  if (!eventName) return false;
  var name = eventName.toLowerCase();
  return HIGH_IMPACT_EVENTS.some(function(k) { return name.indexOf(k.toLowerCase()) >= 0; });
}

// -- SOURCE 3: NEWSAPI GEOPOLITICAL NEWS -----------------------
async function fetchNewsApiGeo() {
  var key = getNewsApiKey();
  if (!key) { console.log('[CAL] No NEWS_API_KEY -- skipping NewsAPI'); return []; }
  try {
    var query = encodeURIComponent('Iran OR Hormuz OR tariff OR "peace deal" OR "trade deal" OR "ceasefire" OR "rate cut"');
    var url   = 'https://newsapi.org/v2/everything?q=' + query + '&language=en&sortBy=publishedAt&pageSize=15&apiKey=' + key;
    var res   = await fetch(url);
    if (!res.ok) { console.error('[CAL] NewsAPI error:', res.status); return []; }
    var data  = await res.json();
    var articles = (data && data.articles) ? data.articles : [];
    console.log('[CAL] NewsAPI: ' + articles.length + ' articles');
    return articles;
  } catch(e) { console.error('[CAL] NewsAPI error:', e.message); return []; }
}

// -- CHECK NEWS FOR GEOPOLITICAL ALERTS -----------------------
function checkGeoAlerts(newsItems) {
  var alerts = [];
  newsItems.forEach(function(item) {
    var title = (item.title || '') + ' ' + (item.description || '');
    GEO_KEYWORDS.forEach(function(kw) {
      if (title.toLowerCase().indexOf(kw.toLowerCase()) >= 0) {
        var already = alerts.some(function(a) { return a.keyword === kw; });
        if (!already) {
          alerts.push({ keyword: kw, title: item.title, url: item.article_url });
        }
      }
    });
  });
  return alerts;
}

// -- DETERMINE MARKET BIAS FROM NEWS --------------------------
function getMarketBias(geoAlerts, events) {
  var bearish = ['tariff', 'Iran', 'Hormuz', 'sanctions', 'trade war'];
  var bullish = ['trade deal', 'peace deal', 'ceasefire', 'rate cut', 'stimulus'];

  var bearCount = 0;
  var bullCount = 0;

  geoAlerts.forEach(function(a) {
    if (bearish.some(function(k) { return a.keyword.toLowerCase().indexOf(k.toLowerCase()) >= 0; })) bearCount++;
    if (bullish.some(function(k) { return a.keyword.toLowerCase().indexOf(k.toLowerCase()) >= 0; })) bullCount++;
  });

  if (bullCount > bearCount) return 'BULLISH -- potential rip your face off rally';
  if (bearCount > bullCount) return 'BEARISH -- macro headwinds confirmed';
  return 'NEUTRAL -- no strong catalyst detected';
}

// -- BUILD AND POST DAILY BRIEFING -----------------------------
async function postDailyBrief() {
  var webhook = getWebhook();
  if (!webhook) { console.log('[CAL] No webhook'); return; }

  var events   = await fetchEconomicCalendar();
  var news          = await fetchMarketNews();
  var newsApiItems  = await fetchNewsApiGeo();
  // Merge NewsAPI into news for geo analysis
  newsApiItems.forEach(function(a) {
    news.push({ title: a.title, description: a.description, article_url: a.url });
  });
  var geoAlerts = checkGeoAlerts(news);
  var bias     = getMarketBias(geoAlerts, events);

  // Update state
  state.highImpactEvents = [];
  state.geoAlerts        = geoAlerts;
  state.blockTrading     = false;
  state.blockReason      = null;
  state.lastUpdated      = new Date().toISOString();

  var date = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var lines2 = [
    'ECONOMIC CALENDAR -- ' + date,
    '===============================',
  ];

  // Filter US events only, sort by time
  var usEvents = events.filter(function(e) { return e.country === 'US' || e.country === 'United States'; });
  usEvents.sort(function(a, b) { return (a.time || '').localeCompare(b.time || ''); });

  if (usEvents.length === 0) {
    lines2.push('No major US events today');
  } else {
    usEvents.forEach(function(e) {
      var impact = IMPACT_EMOJI[String(e.impact || '1')] || 'LOW';
      var time   = e.time ? e.time.split('T')[1].slice(0,5) : '?';
      var est    = e.estimate  ? 'Est: '  + e.estimate  : '';
      var prev   = e.previous  ? 'Prev: ' + e.previous  : '';
      var line   = time + '  ' + (e.event || e.name || 'Event') + '  [' + impact + ']';
      if (est || prev) line += '  ' + est + '  ' + prev;
      lines2.push(line);

      // Check if high impact
      if (e.impact >= 3 || isHighImpactEvent(e.event || e.name)) {
        state.highImpactEvents.push(e);
        state.blockTrading = true;
        state.blockReason  = 'HIGH IMPACT: ' + (e.event || e.name) + ' at ' + time;
        lines2.push('  --> HIGH IMPACT -- reduce size or wait until after event');
      }
    });
  }

  lines2.push('-------------------------------');

  // Geopolitical alerts
  lines2.push('GEOPOLITICAL WATCH:');
  if (geoAlerts.length === 0) {
    lines2.push('No major geopolitical alerts detected');
    lines2.push('Bias: ' + bias);
  } else {
    geoAlerts.slice(0, 5).forEach(function(a) {
      lines2.push('  [' + a.keyword.toUpperCase() + '] ' + (a.title || '').slice(0, 80));
    });
    lines2.push('Bias: ' + bias);

    // Check for rip your face off rally conditions
    var ripKeywords = ['peace deal', 'trade deal', 'ceasefire', 'Hormuz', 'tariff reversal'];
    var ripDetected = geoAlerts.some(function(a) {
      return ripKeywords.some(function(k) { return a.title && a.title.toLowerCase().indexOf(k.toLowerCase()) >= 0; });
    });
    if (ripDetected) {
      lines2.push('');
      lines2.push('WARNING -- RIP YOUR FACE OFF RALLY RISK');
      lines2.push('Potential catalyst for 5%+ single session reversal');
      lines2.push('CANCEL ALL PUT ORDERS IMMEDIATELY');
      lines2.push('Watch for SPY above $645 pre-market = flip to calls');
    }
  }

  lines2.push('-------------------------------');
  lines2.push('TRADE RULES TODAY:');

  if (state.blockTrading) {
    lines2.push('HIGH IMPACT EVENT -- reduce to 1 contract max');
    lines2.push('Wait 15 min after event before entering');
  } else {
    lines2.push('No major events -- trade normal size');
    lines2.push('A+ grade = 4 contracts');
    lines2.push('A grade  = 3 contracts');
  }

  var message = lines2.join('\n');
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum Calendar' })
    });
    console.log('[CAL] Posted daily brief -- ' + usEvents.length + ' events, ' + geoAlerts.length + ' geo alerts');
  } catch(e) { console.error('[CAL] Post error:', e.message); }
}

// -- CHECK IF TRADING IS BLOCKED RIGHT NOW --------------------
function isTradingBlocked() {
  if (!state.blockTrading) return { blocked: false };
  return { blocked: true, reason: state.blockReason };
}

// -- CHECK NEWS EVERY 30 MIN FOR BREAKING GEO NEWS -----------
async function checkBreakingNews() {
  var news      = await fetchMarketNews();
  // Add NewsAPI articles to breaking news check
  var newsApiItems2 = await fetchNewsApiGeo();
  newsApiItems2.forEach(function(a) {
    news.push({ title: a.title, description: a.description, article_url: a.url });
  });
  var geoAlerts = checkGeoAlerts(news);
  state.geoAlerts = geoAlerts;

  var webhook = getWebhook();
  if (!webhook) return;

  // Check for rip your face off conditions
  var ripKeywords = ['peace deal', 'trade deal', 'ceasefire', 'Hormuz opens', 'tariff reversed', 'tariff paused'];
  var ripAlert = geoAlerts.find(function(a) {
    return ripKeywords.some(function(k) { return a.title && a.title.toLowerCase().indexOf(k.toLowerCase()) >= 0; });
  });

  if (ripAlert) {
    var warning = [
      'BREAKING -- RIP YOUR FACE OFF RALLY ALERT',
      '===============================',
      'Catalyst: ' + (ripAlert.title || '').slice(0, 100),
      '-------------------------------',
      'ACTION REQUIRED:',
      '1. CANCEL ALL PUT ORDERS IMMEDIATELY',
      '2. Check SPY futures -- above $645 = flip to calls',
      '3. Do NOT short into this catalyst',
      'Historical: 2000-2002, 2008, 2015, 2020 had 5%+ single session reversals',
    ].join('\n');
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '```\n' + warning + '\n```', username: 'Stratum ALERT' })
      });
      console.log('[CAL] BREAKING NEWS ALERT posted');
    } catch(e) { console.error('[CAL] Breaking news post error:', e.message); }
  }
}

// -- EARNINGS CALENDAR (Finnhub) ---------------------------------
async function getEarningsCalendar(fromDate, toDate) {
  try {
    var key = getFinnhubKey();
    if (!key) { console.log('[EARNINGS] No Finnhub key'); return []; }
    if (!fromDate) {
      var d = new Date();
      fromDate = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() + 7);
      toDate = d.toISOString().slice(0, 10);
    }
    var url = 'https://finnhub.io/api/v1/calendar/earnings?from=' + fromDate + '&to=' + toDate + '&token=' + key;
    var res = await fetch(url);
    var data = await res.json();
    var earnings = data.earningsCalendar || [];
    // Sort by date, filter for known tickers
    earnings.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
    console.log('[EARNINGS] Found', earnings.length, 'reports from', fromDate, 'to', toDate);
    return earnings.map(function(e) {
      return {
        date: e.date,
        symbol: e.symbol,
        hour: e.hour === 'bmo' ? 'Before Market' : e.hour === 'amc' ? 'After Market' : e.hour,
        epsEstimate: e.epsEstimate,
        revenueEstimate: e.revenueEstimate,
        quarter: e.quarter,
        year: e.year,
      };
    });
  } catch(e) {
    console.error('[EARNINGS] Error:', e.message);
    return [];
  }
}

// alerter.js calls calendar.shouldBlockAlert() -- alias to isTradingBlocked
function shouldBlockAlert() {
  return state.blockTrading === true;
}

module.exports = {
  postDailyBrief:    postDailyBrief,
  checkBreakingNews: checkBreakingNews,
  isTradingBlocked:  isTradingBlocked,
  shouldBlockAlert:   shouldBlockAlert,
  getEarningsCalendar: getEarningsCalendar,
  getState:          function() { return state; },
};