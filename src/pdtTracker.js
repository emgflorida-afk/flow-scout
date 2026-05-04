// =============================================================================
// PDT DAY-TRADE TRACKER — Pattern Day Trader rolling-5d window for LIVE TS account.
//
// PDT rule (FINRA): if you make 4+ day trades in 5 business days on a margin
// account under $25K, you're flagged as a PDT and restricted from further
// day trading until you bring the account above $25K.
//
// AB's TS LIVE account is $20.4K = under $25K = PDT-restricted.
// Public.com cash account = no PDT.
// SIM account = no PDT.
//
// THIS MODULE:
//   - Tracks every fire (open) and close on LIVE TS account
//   - Detects same-day open+close = 1 day-trade used
//   - Maintains rolling 5-business-day count
//   - Exposes canDayTradeNow() for ICS auto-trader to gate live fires
//
// STORAGE: /data/pdt_day_trades.json
//   { trades: [{date, ticker, opened, closed, isDayTrade}], lastUpdated }
//
// PUBLIC API:
//   recordOpen(account, ticker, contractSymbol, time)
//   recordClose(account, ticker, contractSymbol, time)
//   getDayTradeCount() -> N day trades in past 5 business days
//   canDayTradeNow() -> { ok: true/false, used: N, remaining: 3-N }
//   getStatus()
// =============================================================================

var fs = require('fs');
var path = require('path');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var FILE = path.join(DATA_ROOT, 'pdt_day_trades.json');

var PDT_LIMIT = 3;  // 3 day-trades safe; 4 triggers PDT
var ROLLING_DAYS = 5;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return { trades: [], opens: {}, lastUpdated: null }; }
}

function save(state) {
  try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[PDT] save failed:', e.message); }
}

function isoToET(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

// Track an open. AB's contract opens get keyed by contractSymbol so we can
// match the close later.
function recordOpen(account, ticker, contractSymbol, time) {
  if (account !== 'ts' && account !== 'live') return { ok: false, reason: 'only LIVE account tracked' };
  var state = load();
  state.opens = state.opens || {};
  state.opens[contractSymbol] = {
    ticker: ticker,
    contractSymbol: contractSymbol,
    openedAt: time || new Date().toISOString(),
    openedDateET: isoToET(time || new Date().toISOString()),
  };
  state.lastUpdated = new Date().toISOString();
  save(state);
  return { ok: true };
}

// Track a close. If open and close are SAME ET CALENDAR DAY = day trade.
function recordClose(account, ticker, contractSymbol, time) {
  if (account !== 'ts' && account !== 'live') return { ok: false, reason: 'only LIVE account tracked' };
  var state = load();
  state.opens = state.opens || {};
  state.trades = state.trades || [];

  var openInfo = state.opens[contractSymbol];
  var closedAt = time || new Date().toISOString();
  var closedDateET = isoToET(closedAt);
  var isDayTrade = false;
  if (openInfo && openInfo.openedDateET === closedDateET) isDayTrade = true;

  var record = {
    ticker: ticker,
    contractSymbol: contractSymbol,
    openedAt: openInfo ? openInfo.openedAt : null,
    openedDateET: openInfo ? openInfo.openedDateET : null,
    closedAt: closedAt,
    closedDateET: closedDateET,
    isDayTrade: isDayTrade,
  };
  state.trades.push(record);

  // Cleanup the open marker
  if (openInfo) delete state.opens[contractSymbol];

  state.lastUpdated = new Date().toISOString();
  save(state);
  return { ok: true, isDayTrade: isDayTrade, record: record };
}

// Count day-trades in the trailing N business days (default 5)
function getDayTradeCount(rollingDays) {
  rollingDays = rollingDays || ROLLING_DAYS;
  var state = load();
  var trades = state.trades || [];
  // Count business days backwards: today + 4 prior business days
  var businessDates = [];
  var d = new Date();
  while (businessDates.length < rollingDays) {
    var dow = d.getDay();
    if (dow >= 1 && dow <= 5) {  // Mon-Fri
      businessDates.push(d.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    }
    d.setDate(d.getDate() - 1);
  }
  var count = 0;
  trades.forEach(function(t) {
    if (t.isDayTrade && businessDates.indexOf(t.closedDateET) >= 0) count++;
  });
  return count;
}

function canDayTradeNow() {
  var used = getDayTradeCount();
  var remaining = Math.max(0, PDT_LIMIT - used);
  return {
    ok: used < PDT_LIMIT,
    used: used,
    remaining: remaining,
    limit: PDT_LIMIT,
    rollingDays: ROLLING_DAYS,
    note: used >= PDT_LIMIT
      ? 'PDT limit reached (' + used + '/' + PDT_LIMIT + ' day-trades in last ' + ROLLING_DAYS + 'd). Next live fire MUST hold to next day.'
      : 'OK to day-trade. ' + remaining + ' day-trades remaining in rolling 5d window.',
  };
}

function getStatus() {
  var state = load();
  var status = canDayTradeNow();
  return Object.assign({
    timestamp: new Date().toISOString(),
    openPositions: Object.keys(state.opens || {}).length,
    totalTradesLogged: (state.trades || []).length,
    recentTrades: (state.trades || []).slice(-10).reverse(),
  }, status);
}

module.exports = {
  recordOpen: recordOpen,
  recordClose: recordClose,
  getDayTradeCount: getDayTradeCount,
  canDayTradeNow: canDayTradeNow,
  getStatus: getStatus,
};
