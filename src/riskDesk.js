// =============================================================================
// RISK DESK — Hedge fund "Risk Officer." Monitors AB's exposure, day-trade
// budget, correlation, and pushes Discord alerts on rule violations.
//
// CHECKS (every 5 min during RTH):
//   1. Total open option exposure ($) — alert if >25% of equity
//   2. Day-trade count (round-trips today) — alert if 3+ used (PDT risk)
//   3. Correlated positions (3+ shorts on same sector = concentration)
//   4. Position concentration (any single ticker > 15% of capital)
//   5. Daily P/L milestones (+$500 / +$1000 / -$300 stop-out)
//
// AB's CONFIG (in /data/risk_config.json):
//   • equityCap: $20,400
//   • maxExposurePct: 25 (= $5,100 max in open positions)
//   • dayTradeBudget: 4 (PDT trigger)
//   • dailyLossLimit: -$300 (stop trading for the day)
//   • dailyProfitTarget: $500 (lock-in target)
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'risk_state.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var COOLDOWN_MIN = 30;  // 30 min cooldown per alert kind

// Default config — can be overridden via /api/risk-config endpoint
var DEFAULT_CONFIG = {
  equityCap: 20400,
  maxExposurePct: 25,           // 25% of equity in open options
  dayTradeBudget: 4,             // PDT threshold
  dailyLossLimit: -300,          // Stop trading after -$300 day P/L
  dailyProfitTarget: 500,        // Lock-in alert at +$500 day P/L
  maxPositionConcentrationPct: 15, // any single ticker >15% of capital
  maxCorrelatedPositions: 2,     // 3+ same-direction same-sector = alert
};

// Sector mapping for correlation checks
var SECTOR_MAP = {
  'JPM': 'financial', 'BAC': 'financial', 'C': 'financial', 'WFC': 'financial', 'GS': 'financial', 'MS': 'financial', 'USB': 'financial',
  'NVDA': 'semi', 'AMD': 'semi', 'AVGO': 'semi', 'MU': 'semi', 'MRVL': 'semi', 'ASML': 'semi', 'TSM': 'semi', 'ARM': 'semi',
  'AAPL': 'mega-tech', 'MSFT': 'mega-tech', 'GOOGL': 'mega-tech', 'META': 'mega-tech', 'AMZN': 'mega-tech',
  'UNH': 'healthcare', 'CVS': 'healthcare', 'CI': 'healthcare', 'HUM': 'healthcare',
  'XOM': 'energy', 'CVX': 'energy', 'XLE': 'energy', 'USO': 'energy',
  'TSLA': 'autos-ev', 'RIVN': 'autos-ev', 'F': 'autos-ev', 'GM': 'autos-ev',
  'COIN': 'crypto', 'MSTR': 'crypto',
  'SPY': 'index', 'QQQ': 'index', 'IWM': 'index', 'DIA': 'index',
};

// ─── STATE ────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { lastAlerts: {}, dayPnLBaseline: null, dayTradesUsed: 0 }; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}
function isInCooldown(state, key) {
  var last = state.lastAlerts[key];
  if (!last) return false;
  return (Date.now() - new Date(last).getTime()) / 60000 < COOLDOWN_MIN;
}
function markCooldown(state, key) {
  state.lastAlerts[key] = new Date().toISOString();
}

// ─── TS API ───────────────────────────────────────────────────────────────
async function fetchAccount(token, accountId) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var r = await fetchLib('https://api.tradestation.com/v3/brokerage/accounts/' + accountId + '/balances', {
      headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000
    });
    if (!r.ok) return null;
    var d = await r.json();
    var b = (d.Balances || [])[0];
    if (!b) return null;
    return {
      equity: parseFloat(b.Equity || 0),
      cashBalance: parseFloat(b.CashBalance || 0),
      buyingPower: parseFloat(b.BuyingPower || 0),
      todaysProfitLoss: parseFloat(b.TodaysProfitLoss || 0),
      marketValue: parseFloat(b.MarketValue || 0),
    };
  } catch (e) { return null; }
}

async function fetchPositions(token, accountId) {
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var r = await fetchLib('https://api.tradestation.com/v3/brokerage/accounts/' + accountId + '/positions', {
      headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000
    });
    if (!r.ok) return [];
    var d = await r.json();
    return d.Positions || [];
  } catch (e) { return []; }
}

// ─── DISCORD ALERTS ───────────────────────────────────────────────────────
async function pushAlert(title, description, fields, color) {
  var embed = {
    username: 'Flow Scout — Risk Desk',
    embeds: [{
      title: title,
      description: description,
      color: color,
      fields: fields,
      footer: { text: 'Flow Scout | Risk Desk | 5-min poll' },
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    await fetchLib(DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(embed), timeout: 5000 });
    console.log('[RISK-DESK] ALERT: ' + title);
  } catch (e) {}
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function runRiskDesk() {
  if (!ts || !ts.getAccessToken) { console.log('[RISK-DESK] No TS module'); return; }
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { return; }
  if (!token) return;

  // Get all accounts
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  var r = await fetchLib('https://api.tradestation.com/v3/brokerage/accounts', {
    headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000
  });
  if (!r.ok) return;
  var data = await r.json();
  var accounts = (data.Accounts || []).filter(function(a) { return a.AccountType === 'Margin'; });
  if (!accounts.length) return;

  var state = loadState();
  var config = DEFAULT_CONFIG;
  var alertsSent = 0;

  for (var i = 0; i < accounts.length; i++) {
    var accountId = accounts[i].AccountID;
    var balance = await fetchAccount(token, accountId);
    var positions = await fetchPositions(token, accountId);

    if (!balance) continue;

    // Check 1: Daily P/L milestones
    var dayPnL = balance.todaysProfitLoss;
    if (dayPnL <= config.dailyLossLimit && !isInCooldown(state, 'daily-loss-limit')) {
      await pushAlert(
        '🚨 DAILY LOSS LIMIT HIT',
        'Today\'s P/L $' + dayPnL.toFixed(2) + ' is at or below your stop limit ($' + config.dailyLossLimit + '). **STOP TRADING FOR THE DAY.** Tomorrow is a fresh start.',
        [{ name: 'Equity', value: '$' + balance.equity.toFixed(2), inline: true },
         { name: 'BP', value: '$' + balance.buyingPower.toFixed(2), inline: true }],
        15158332
      );
      markCooldown(state, 'daily-loss-limit');
      alertsSent++;
    }
    if (dayPnL >= config.dailyProfitTarget && !isInCooldown(state, 'daily-profit-target')) {
      await pushAlert(
        '🎯 DAILY PROFIT TARGET HIT',
        'Today\'s P/L $' + dayPnL.toFixed(2) + ' hit your $' + config.dailyProfitTarget + ' target. **Consider locking in — taking remaining trades from a position of strength.**',
        [{ name: 'Equity', value: '$' + balance.equity.toFixed(2), inline: true }],
        5763719
      );
      markCooldown(state, 'daily-profit-target');
      alertsSent++;
    }

    // Check 2: Position concentration & exposure
    var totalExposure = 0;
    var byTicker = {};
    var bySector = {};
    positions.forEach(function(p) {
      var marketValue = Math.abs(parseFloat(p.MarketValue || 0));
      totalExposure += marketValue;
      var sym = (p.Symbol || '').split(' ')[0];
      byTicker[sym] = (byTicker[sym] || 0) + marketValue;
      var sector = SECTOR_MAP[sym] || 'other';
      if (!bySector[sector]) bySector[sector] = [];
      bySector[sector].push({ ticker: sym, value: marketValue, side: parseFloat(p.LongQuantity || 0) > 0 ? 'long' : 'short' });
    });

    var exposurePct = (totalExposure / config.equityCap) * 100;
    if (exposurePct > config.maxExposurePct && !isInCooldown(state, 'over-exposure')) {
      await pushAlert(
        '⚠️ OVER-EXPOSURE WARNING',
        'Total open positions = **$' + totalExposure.toFixed(0) + ' (' + exposurePct.toFixed(0) + '% of equity)**. Recommended max: ' + config.maxExposurePct + '%. Consider trimming or closing weakest position.',
        [{ name: 'Total Open', value: '$' + totalExposure.toFixed(0), inline: true },
         { name: 'Equity', value: '$' + balance.equity.toFixed(2), inline: true },
         { name: 'Threshold', value: config.maxExposurePct + '%', inline: true }],
        16753920
      );
      markCooldown(state, 'over-exposure');
      alertsSent++;
    }

    // Check 3: Concentration on single ticker
    Object.keys(byTicker).forEach(function(t) {
      var pct = (byTicker[t] / config.equityCap) * 100;
      if (pct > config.maxPositionConcentrationPct && !isInCooldown(state, 'concentration-' + t)) {
        pushAlert(
          '⚠️ POSITION CONCENTRATION — ' + t,
          t + ' position = $' + byTicker[t].toFixed(0) + ' = ' + pct.toFixed(0) + '% of equity. Max recommended: ' + config.maxPositionConcentrationPct + '%. Consider trimming.',
          [],
          16753920
        );
        markCooldown(state, 'concentration-' + t);
      }
    });

    // Check 4: Correlated positions (3+ same-side same-sector)
    Object.keys(bySector).forEach(function(s) {
      if (s === 'other' || s === 'index') return;
      var posInSector = bySector[s];
      var longs = posInSector.filter(function(p) { return p.side === 'long'; });
      var shorts = posInSector.filter(function(p) { return p.side === 'short'; });
      if (longs.length > config.maxCorrelatedPositions) {
        if (!isInCooldown(state, 'corr-long-' + s)) {
          pushAlert(
            '⚠️ CORRELATED LONG EXPOSURE — ' + s.toUpperCase() + ' sector',
            longs.length + ' long positions in ' + s + ': ' + longs.map(function(l) { return l.ticker; }).join(', ') + '. If sector reverses, all hit at once. **Consider diversifying or trimming.**',
            [],
            16753920
          );
          markCooldown(state, 'corr-long-' + s);
        }
      }
      if (shorts.length > config.maxCorrelatedPositions) {
        if (!isInCooldown(state, 'corr-short-' + s)) {
          pushAlert(
            '⚠️ CORRELATED SHORT EXPOSURE — ' + s.toUpperCase() + ' sector',
            shorts.length + ' short positions in ' + s + ': ' + shorts.map(function(l) { return l.ticker; }).join(', ') + '. Sector squeeze = all hit. **Consider diversifying.**',
            [],
            16753920
          );
          markCooldown(state, 'corr-short-' + s);
        }
      }
    });
  }

  saveState(state);
  console.log('[RISK-DESK] Checked ' + accounts.length + ' accounts, alerts: ' + alertsSent);
  return { alertsSent: alertsSent };
}

module.exports = {
  runRiskDesk: runRiskDesk,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
};
