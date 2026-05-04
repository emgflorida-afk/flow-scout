// =============================================================================
// MACRO SENTINEL — regime flip detector with Discord push
//
// The "Macro Desk" of the Mini Hedge Fund.
//
// WHAT IT TRACKS (every 2 min during RTH):
//   • VIX direction + magnitude flips (cross 18 / 20 / 22 thresholds)
//   • SPY key levels: $720 (Fri close) / $715 (psych) / $710 / $705 / $700
//   • QQQ key levels: $675 / $670 / $665
//   • Sector rotation flips (XLE, XLF, XLI, XLK, XLV, XLP, XLU, XLY, XLB)
//   • Oil (USO) vol expansion
//
// WHEN IT PUSHES:
//   - VIX crosses regime threshold (18/20/22) — fear escalation/relief
//   - SPY breaks key level on 5m close — confirms trend
//   - Sector divergence (3+ sectors red while 1 green = rotation)
//   - State change: "risk on" → "risk off" or vice versa
//
// EACH PUSH INCLUDES REGIME-AWARE FIRE/WAIT VERDICT:
//   "GEX -1.39B + VIX +11% + SPY broke $715 = pre-confirmed cascade
//    → FIRE puts at market, don't wait for additional confirmation"
//
//   vs.
//
//   "VIX 16, SPY chopping $720, sectors mixed
//    = no regime, wait for clean setup"
// =============================================================================

var fs = require('fs');
var path = require('path');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var STATE_FILE = path.join(DATA_ROOT, 'macro_state.json');

var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var COOLDOWN_MIN = 5;  // 5 min cooldown per alert kind

// VIX regime thresholds
var VIX_THRESHOLDS = [
  { level: 16, label: 'COMPLACENCY', color: 'green' },
  { level: 18, label: 'NEUTRAL', color: 'yellow' },
  { level: 20, label: 'ELEVATED', color: 'orange' },
  { level: 22, label: 'STRESSED', color: 'red' },
  { level: 25, label: 'PANIC', color: 'crimson' },
];

// SPY key levels (will need updating as market moves)
var SPY_KEY_LEVELS = [
  { price: 705, label: 'breakdown trigger', side: 'bearish' },
  { price: 710, label: 'cascade midpoint', side: 'bearish' },
  { price: 715, label: 'psych support', side: 'bearish' },
  { price: 720, label: 'Friday close', side: 'neutral' },
  { price: 725, label: 'GEX call wall', side: 'bullish' },
];

// ─── STATE PERSISTENCE ────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { lastVix: null, lastSpy: null, lastQqq: null, alerts: {} }; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}
function isInCooldown(state, key) {
  var last = state.alerts[key];
  if (!last) return false;
  return (Date.now() - new Date(last).getTime()) / 60000 < COOLDOWN_MIN;
}
function markCooldown(state, key) {
  state.alerts[key] = new Date().toISOString();
}

// ─── TS API ───────────────────────────────────────────────────────────────
async function fetchQuotes(symbols, token) {
  var url = 'https://api.tradestation.com/v3/marketdata/quotes/' + symbols.join(',');
  var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    var r = await fetchLib(url, { headers: { 'Authorization': 'Bearer ' + token }, timeout: 5000 });
    if (!r.ok) return {};
    var data = await r.json();
    var out = {};
    (data.Quotes || data.quotes || []).forEach(function(q) {
      out[q.Symbol] = {
        last: parseFloat(q.Last || q.Close || 0),
        prev: parseFloat(q.PreviousClose || 0),
        high: parseFloat(q.High || 0),
        low: parseFloat(q.Low || 0),
        change: parseFloat(q.NetChange || 0),
        pct: parseFloat(q.NetChangePct || 0),
      };
    });
    return out;
  } catch (e) { return {}; }
}

// ─── REGIME CLASSIFICATION ────────────────────────────────────────────────
function getVixRegime(vix) {
  for (var i = VIX_THRESHOLDS.length - 1; i >= 0; i--) {
    if (vix >= VIX_THRESHOLDS[i].level) return VIX_THRESHOLDS[i];
  }
  return VIX_THRESHOLDS[0];
}

// "Pre-confirmed regime" detection — when GEX + VIX + SPY all align,
// you don't need to wait for 5m close confirmation
function getRegimeVerdict(vix, spy, sectors) {
  var verdict = '';
  var fireRecommend = false;
  var direction = 'neutral';

  // Bearish regime: VIX > 18 + spiking, SPY breaking levels, sectors rotating risk-off
  var bearishCount = 0;
  if (vix.last >= 18 && vix.pct >= 5) bearishCount++;  // VIX surging
  if (spy.pct < -0.5) bearishCount++;                   // SPY weak
  var redSectors = Object.values(sectors).filter(function(s) { return s.pct < 0; }).length;
  var greenSectors = Object.values(sectors).filter(function(s) { return s.pct > 0; }).length;
  if (redSectors >= 6) bearishCount++;                  // most sectors red

  // Bullish regime: VIX < 17 + falling, SPY making highs, sectors broadly green
  var bullishCount = 0;
  if (vix.last <= 17 && vix.pct <= -2) bullishCount++;
  if (spy.pct >= 0.3) bullishCount++;
  if (greenSectors >= 6) bullishCount++;

  if (bearishCount >= 2) {
    direction = 'bearish';
    verdict = '🔴 RISK-OFF REGIME CONFIRMED — VIX expansion + SPY weakness + sector rotation. ' +
              'On bearish setups: **FIRE AT MARKET, don\'t wait for additional confirmation.** ' +
              'On bullish setups: SKIP, fighting the regime.';
    fireRecommend = true;
  } else if (bullishCount >= 2) {
    direction = 'bullish';
    verdict = '🟢 RISK-ON REGIME CONFIRMED — VIX collapse + SPY strength + sector broadening. ' +
              'On bullish setups: **FIRE AT MARKET, regime supports continuation.** ' +
              'On bearish setups: SKIP unless single-name catalyst.';
    fireRecommend = true;
  } else {
    verdict = '🟡 CHOP REGIME — no clean direction. ' +
              'Wait for clean 5m close confirmation on any setup. ' +
              'Stink-bid LMTs may not fill.';
    fireRecommend = false;
  }

  return { direction: direction, verdict: verdict, fireRecommend: fireRecommend, bearishCount: bearishCount, bullishCount: bullishCount };
}

// ─── DISCORD ALERTS ───────────────────────────────────────────────────────
async function pushVixCrossAlert(prevVix, currVix, threshold, direction) {
  var arrow = direction === 'up' ? '📈' : '📉';
  var color = direction === 'up' ? 16753920 : 5763719;
  var embed = {
    username: 'Flow Scout — Macro Sentinel',
    embeds: [{
      title: arrow + ' VIX ' + (direction === 'up' ? 'CROSSED UP' : 'CROSSED DOWN') + ' through ' + threshold.level + ' — ' + threshold.label,
      description: '**VIX**: was ' + prevVix.toFixed(2) + ' → now ' + currVix.toFixed(2) + ' (regime: **' + threshold.label + '**)',
      color: color,
      fields: [
        {
          name: '🎯 What this means',
          value: direction === 'up'
            ? 'Fear is expanding. Dealer hedging pressure increasing. Trends amplify on negative gamma. Bear setups GET STRONGER tailwind.'
            : 'Fear is bleeding off. Dealer hedging easing. Trends mean-revert. Bull setups regain footing.',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Macro Sentinel | 2-min poll' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  var result = await dp.send('macroSentinel', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) console.log('[MACRO-SENTINEL] VIX cross alert: ' + threshold.level);
  else console.error('[MACRO-SENTINEL] VIX push FAILED: ' + (result.error || 'unknown'));
  return result;
}

async function pushSpyLevelBreakAlert(spy, level, direction) {
  var arrow = direction === 'down' ? '🔻' : '🔺';
  var color = direction === 'down' ? 15158332 : 5763719;
  var embed = {
    username: 'Flow Scout — Macro Sentinel',
    embeds: [{
      title: arrow + ' SPY broke ' + (direction === 'down' ? 'BELOW' : 'ABOVE') + ' $' + level.price + ' — ' + level.label,
      description: '**SPY**: $' + spy.last.toFixed(2) + ' (' + (spy.pct >= 0 ? '+' : '') + spy.pct.toFixed(2) + '%) — broke ' + level.label,
      color: color,
      footer: { text: 'Flow Scout | Macro Sentinel' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  var result = await dp.send('macroSentinel', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) console.log('[MACRO-SENTINEL] SPY level break: $' + level.price);
  else console.error('[MACRO-SENTINEL] SPY push FAILED: ' + (result.error || 'unknown'));
  return result;
}

async function pushRegimeFlipAlert(prev, curr, regime) {
  var color = regime.direction === 'bearish' ? 15158332 : regime.direction === 'bullish' ? 5763719 : 16753920;
  var embed = {
    username: 'Flow Scout — Macro Sentinel',
    embeds: [{
      title: '🌐 REGIME FLIP — ' + (prev || 'unknown') + ' → ' + regime.direction.toUpperCase(),
      description: regime.verdict,
      color: color,
      fields: [
        {
          name: '📊 Confidence count',
          value: 'Bearish signals: ' + regime.bearishCount + ' / 3\nBullish signals: ' + regime.bullishCount + ' / 3',
          inline: false,
        },
        {
          name: '⚡ Action',
          value: regime.fireRecommend
            ? 'High-conviction directional setups in this direction = FIRE AT MARKET, no need to wait.'
            : 'Wait for clean 5m close + volume confirmation on any setup.',
          inline: false,
        },
      ],
      footer: { text: 'Flow Scout | Macro Sentinel | regime engine' },
      timestamp: new Date().toISOString(),
    }],
  };
  var dp = require('./discordPush');
  var result = await dp.send('macroSentinel', embed, { webhook: DISCORD_WEBHOOK });
  if (result.ok) console.log('[MACRO-SENTINEL] REGIME FLIP: ' + regime.direction);
  else console.error('[MACRO-SENTINEL] regime flip push FAILED: ' + (result.error || 'unknown'));
  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
async function runSentinel() {
  if (!ts || !ts.getAccessToken) { console.log('[MACRO-SENTINEL] No TS module'); return; }
  var token;
  try { token = await ts.getAccessToken(); }
  catch (e) { return; }
  if (!token) return;

  var symbols = ['SPY', 'QQQ', '$VIX.X', 'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLP', 'XLU', 'XLY', 'XLB', 'USO'];
  var quotes = await fetchQuotes(symbols, token);
  if (!quotes['SPY'] || !quotes['$VIX.X']) return;

  var spy = quotes['SPY'];
  var vix = quotes['$VIX.X'];
  var qqq = quotes['QQQ'];
  var sectors = {};
  ['XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLP', 'XLU', 'XLY', 'XLB'].forEach(function(s) {
    if (quotes[s]) sectors[s] = quotes[s];
  });

  var state = loadState();
  var alertsSent = 0;

  // 1. VIX threshold crosses
  if (state.lastVix != null) {
    VIX_THRESHOLDS.forEach(function(t) {
      var key = 'vix-' + t.level;
      var crossedUp = vix.last >= t.level && state.lastVix < t.level;
      var crossedDown = vix.last < t.level && state.lastVix >= t.level;
      if ((crossedUp || crossedDown) && !isInCooldown(state, key)) {
        pushVixCrossAlert(state.lastVix, vix.last, t, crossedUp ? 'up' : 'down');
        markCooldown(state, key);
        alertsSent++;
      }
    });
  }
  state.lastVix = vix.last;

  // 2. SPY key level breaks
  if (state.lastSpy != null) {
    SPY_KEY_LEVELS.forEach(function(L) {
      var key = 'spy-' + L.price;
      var crossedDown = spy.last < L.price && state.lastSpy >= L.price;
      var crossedUp = spy.last > L.price && state.lastSpy <= L.price;
      if ((crossedDown || crossedUp) && !isInCooldown(state, key)) {
        pushSpyLevelBreakAlert(spy, L, crossedDown ? 'down' : 'up');
        markCooldown(state, key);
        alertsSent++;
      }
    });
  }
  state.lastSpy = spy.last;

  // 3. Regime flip detection
  var regime = getRegimeVerdict(vix, spy, sectors);
  var regimeKey = 'regime-flip';
  if (state.lastRegime !== regime.direction && regime.direction !== 'neutral' && !isInCooldown(state, regimeKey)) {
    pushRegimeFlipAlert(state.lastRegime, regime.direction, regime);
    markCooldown(state, regimeKey);
    alertsSent++;
  }
  state.lastRegime = regime.direction;

  saveState(state);
  console.log('[MACRO-SENTINEL] alerts sent: ' + alertsSent + ' | VIX ' + vix.last.toFixed(2) + ' | SPY ' + spy.last.toFixed(2) + ' | regime: ' + regime.direction);
  return { alertsSent: alertsSent, regime: regime };
}

module.exports = {
  runSentinel: runSentinel,
  getRegimeVerdict: getRegimeVerdict,
  getVixRegime: getVixRegime,
};
