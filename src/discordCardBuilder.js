// =============================================================================
// discordCardBuilder.js — UNIVERSAL DISCORD CARD RENDERER (Phase 4.52)
// =============================================================================
// AB called this out May 6: the FIRE button only existed on the MEGA channel.
// All other Stratum desks pushed plain text or partial embeds with no way to
// act. This module is the single renderer used by every push path.
//
// Three card types:
//   - buildEntryCard  — initial trigger / A+ alert / external pick. Carries
//                       SIM ⚡ button (one-tap auto-fire) + LIVE 🔥 button
//                       (goes through confirm page).
//   - buildTrimCard   — TP1 fill notification.
//   - buildExitCard   — full close (TP2, stop, manual).
//
// Quarantined sources (X poller etc.) get the same embed shape but FIRE field
// shows a greyed "QUARANTINED — grading in progress" line instead of buttons.
//
// Outputs Discord webhook payload `{ embeds: [{...}] }`.
// Caller posts via discordPush.send(deskName, payload, { webhook }).
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var BASE_URL = process.env.FLOW_SCOUT_BASE ||
  process.env.RAILWAY_BASE_URL ||
  'https://flow-scout-production.up.railway.app';

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var ACTIVE_SIGNALS_FILE = path.join(DATA_ROOT, 'active_signals.json');

// Source-emoji map — gives every channel a consistent visual identity
var SOURCE_EMOJI = {
  mega: '🐋',
  bar: '⚡',
  uoa: '🌊',
  bullflow: '🌊',
  john: '👑',
  jsmith: '👑',
  x: '🐦',
  raven: '🐦',
  sniper: '🎯',
  failure: '💥',
  break: '📈',
  swing: '🎢',
  external: '🔗',
  ics: '🧊',
  trigger: '🎯',
  reversal: '🔄',
};

// Tier color (hex int) — long is base color, short is offset
function colorFor(direction, tier) {
  var dir = String(direction || 'long').toLowerCase();
  var isLong = (dir === 'long' || dir === 'call' || dir === 'bullish');

  if (tier === 'day-trade') return isLong ? 0xFFA500 : 0xFF5722; // orange / deep
  if (tier === 'swing')     return isLong ? 0x009688 : 0x9C27B0; // teal / purple
  if (tier === 'scalp')     return isLong ? 0x4CAF50 : 0xF44336; // green / red
  // default
  return isLong ? 0x4CAF50 : 0xF44336;
}

function tierLabel(tier) {
  if (!tier) return 'TRADE';
  var t = String(tier).toLowerCase();
  if (t === 'day-trade' || t === 'day') return 'DAY TRADE';
  if (t === 'scalp')                    return 'SCALP';
  if (t === 'swing')                    return 'SWING';
  return String(tier).toUpperCase();
}

function dirLabel(direction) {
  var dir = String(direction || 'long').toLowerCase();
  if (dir === 'long' || dir === 'call' || dir === 'bullish') return 'LONG';
  if (dir === 'short' || dir === 'put' || dir === 'bearish') return 'SHORT';
  return dir.toUpperCase();
}

function emojiFor(source) {
  if (!source) return '🎯';
  var s = String(source).toLowerCase();
  if (SOURCE_EMOJI[s]) return SOURCE_EMOJI[s];
  // partial match
  for (var key in SOURCE_EMOJI) {
    if (s.indexOf(key) !== -1) return SOURCE_EMOJI[key];
  }
  return '🎯';
}

function chartImage(ticker) {
  if (!ticker) return null;
  return 'https://finviz.com/chart.ashx?t=' + encodeURIComponent(ticker) +
    '&ty=c&ta=1&p=i5&s=l&_=' + Date.now();
}

function tvChartUrl(ticker) {
  return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(ticker);
}

// ----------------------------------------------------------------------------
// PERSISTENCE — every signal is written so /api/quick-fire can validate it
// ----------------------------------------------------------------------------
function readSignals() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_SIGNALS_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function writeSignals(map) {
  try {
    if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(ACTIVE_SIGNALS_FILE, JSON.stringify(map, null, 2));
    return true;
  } catch (e) {
    console.error('[CARD-BUILDER] writeSignals failed:', e.message);
    return false;
  }
}

function pruneStale(map, ttlMs) {
  var cutoff = Date.now() - ttlMs;
  var out = {};
  Object.keys(map).forEach(function(k) {
    var s = map[k];
    if (s && s.createdAt && new Date(s.createdAt).getTime() > cutoff) out[k] = s;
  });
  return out;
}

// Persists a signal so /api/quick-fire can validate freshness.
// Returns the assigned signalId.
function persistSignal(opts) {
  var sid = opts.signalId || (opts.source + '-' + opts.ticker + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  var entry = {
    id: sid,
    source: opts.source || 'unknown',
    tier: opts.tier || 'scalp',
    ticker: opts.ticker,
    direction: opts.direction || 'long',
    contract: opts.contract || null,        // { osi, strike, expiry, mid, bid, ask }
    bracket: opts.bracket || null,          // { entry, tp1, tp2, stop }
    stockSpot: opts.stockSpot || null,
    quarantined: !!opts.quarantined,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (opts.ttlMin || 30) * 60000).toISOString(),
    fired: false,
  };
  var map = readSignals();
  // prune anything older than 24 hr
  map = pruneStale(map, 24 * 60 * 60 * 1000);
  map[sid] = entry;
  writeSignals(map);
  return sid;
}

function loadSignal(signalId) {
  var map = readSignals();
  return map[signalId] || null;
}

function markFired(signalId, account, fillResult) {
  var map = readSignals();
  if (!map[signalId]) return false;
  map[signalId].fired = true;
  map[signalId].firedAt = new Date().toISOString();
  map[signalId].firedAccount = account;
  map[signalId].firedResult = fillResult || null;
  writeSignals(map);
  return true;
}

// ----------------------------------------------------------------------------
// FIRE BUTTON FIELD — the workhorse of the whole system
// ----------------------------------------------------------------------------
function buildFireField(signalId, costStr, quarantined) {
  if (quarantined) {
    return {
      name: '⚪ QUARANTINED',
      value: 'Source under grading. No fire button until 30-trade hit-rate is reviewed. View on Action tab → ' +
        '[scanner-v2](' + BASE_URL + '/scanner-v2)',
      inline: false,
    };
  }
  var simUrl  = BASE_URL + '/quick-fire?sid=' + encodeURIComponent(signalId) + '&acct=sim';
  var liveUrl = BASE_URL + '/quick-fire?sid=' + encodeURIComponent(signalId) + '&acct=live';
  var sizingNote = costStr ? ' · Auto-sized (1.5/2.5/4% per tier)' : '';
  return {
    name: '⚡ FIRE',
    value:
      '[⚡ FIRE on **SIM** ' + (costStr ? '(' + costStr + ')' : '') + '](' + simUrl + ')\n' +
      '[🔥 FIRE on **LIVE** ' + (costStr ? '(' + costStr + ')' : '') + ' — confirm required](' + liveUrl + ')' +
      sizingNote,
    inline: false,
  };
}

// ----------------------------------------------------------------------------
// ENTRY CARD — used for every initial trigger / A+ alert / external pick
// ----------------------------------------------------------------------------
function buildEntryCard(opts) {
  opts = opts || {};
  var ticker    = String(opts.ticker || '').toUpperCase();
  var dir       = dirLabel(opts.direction);
  var tier      = (opts.tier || 'scalp').toLowerCase();
  var source    = (opts.source || 'unknown').toLowerCase();
  var contract  = opts.contract || {};
  var bracket   = opts.bracket || {};
  var spotStr   = (opts.stockSpot != null) ? '$' + Number(opts.stockSpot).toFixed(2) : '—';
  var tape      = opts.tape || null;
  var gex       = opts.gex || null;
  var vision    = opts.vision || null;
  var quarantined = !!opts.quarantined;
  var dirSign   = (String(opts.direction || 'long').toLowerCase().match(/^(long|call|bull)/)) ? 'long' : 'short';

  // Persist signal — even quarantined ones get a row, just no fire button
  var sid = persistSignal({
    signalId: opts.signalId,
    source: source,
    tier: tier,
    ticker: ticker,
    direction: dirSign,
    contract: contract,
    bracket: bracket,
    stockSpot: opts.stockSpot,
    quarantined: quarantined,
    ttlMin: opts.ttlMin || 30,
  });

  var emoji = emojiFor(source);
  var srcLabel = (source === 'mega' || source === 'bar') ? 'MEGA' :
                 (source === 'john' || source === 'jsmith') ? 'JOHN' :
                 (source === 'x' || source === 'raven' || source === 'sniper') ? 'X' :
                 source.toUpperCase();
  var title = emoji + ' ' + srcLabel + ' ' + tierLabel(tier) + ' — ' + ticker + ' ' + dir;

  var fields = [];

  // Spot + Tape inline
  fields.push({ name: '💰 Spot', value: spotStr, inline: true });
  if (tape) {
    fields.push({ name: '🌊 Tape', value: String(tape), inline: true });
  } else {
    fields.push({ name: '🌊 Tape', value: '—', inline: true });
  }
  if (gex) {
    fields.push({ name: '⚙️ GEX', value: String(gex), inline: true });
  } else {
    fields.push({ name: '⚙️ GEX', value: '—', inline: true });
  }

  // Contract block
  if (contract && contract.expiry && contract.strike != null) {
    var optType = (dirSign === 'long') ? 'C' : 'P';
    var midNum = Number(contract.mid || 0);
    var contractLine = '**' + ticker + ' ' + contract.expiry + ' $' + contract.strike + optType + '**';
    if (midNum) {
      contractLine += '\nMid $' + midNum.toFixed(2);
      if (contract.bid != null && contract.ask != null) {
        contractLine += ' · bid $' + Number(contract.bid).toFixed(2) + ' / ask $' + Number(contract.ask).toFixed(2);
      }
    }
    if (contract.vol != null || contract.oi != null) {
      contractLine += '\nvol ' + (contract.vol || '?') + ' · OI ' + (contract.oi || '?');
    }
    fields.push({ name: '📋 Contract', value: contractLine, inline: false });
  }

  // Bracket block (with structural-stop indicator)
  if (bracket && (bracket.entry != null || bracket.tp1 != null || bracket.stop != null)) {
    var midNum2 = Number((contract && contract.mid) || 0);
    var costStr = midNum2 ? '$' + (midNum2 * 100).toFixed(0) : '';
    var lines = [];
    if (bracket.entry != null) lines.push('Entry **$' + Number(bracket.entry).toFixed(2) + '**' + (costStr ? ' · ' + costStr + '/ct' : ''));
    if (bracket.tp1 != null)   lines.push('TP1 **$' + Number(bracket.tp1).toFixed(2) + '**' + (bracket.tp2 != null ? ' · TP2 **$' + Number(bracket.tp2).toFixed(2) + '**' : ''));
    if (bracket.stop != null) {
      var stopLine = 'Stop **$' + Number(bracket.stop).toFixed(2) + '**';
      if (bracket.stopSource) stopLine += ' (' + bracket.stopSource + ')';
      lines.push(stopLine);
    }
    if (bracket.holdRule) lines.push(bracket.holdRule);
    fields.push({ name: '🎯 Bracket', value: lines.join('\n'), inline: false });
  }

  // Vision / setup line — optional
  if (vision || opts.scannerSetup) {
    var setupLines = [];
    if (vision)            setupLines.push('Vision: ' + vision);
    if (opts.scannerSetup) setupLines.push('Setup: ' + opts.scannerSetup);
    fields.push({ name: '🔍 Setup', value: setupLines.join('\n'), inline: false });
  }

  // FIRE field — the centerpiece
  var midForFire = Number((contract && contract.mid) || 0);
  var perCtCost = midForFire ? '$' + (midForFire * 100).toFixed(0) + '/ct' : '';
  fields.push(buildFireField(sid, perCtCost, quarantined));

  // Chart link
  fields.push({
    name: '🔗 Open',
    value: '[' + ticker + ' 5m chart](' + tvChartUrl(ticker) + ') · [Action tab](' + BASE_URL + '/scanner-v2#action)',
    inline: false,
  });

  var embed = {
    title: title,
    color: colorFor(dirSign, tier),
    fields: fields,
    image: { url: chartImage(ticker) },
    footer: {
      text: (quarantined ? 'QUARANTINED — Action tab only' : 'Tap SIM to test · LIVE requires confirm') +
        ' · sid=' + sid.slice(0, 12),
    },
    timestamp: new Date().toISOString(),
  };

  return {
    embeds: [embed],
    username: 'Stratum ' + (srcLabel || 'BOT'),
    signalId: sid, // exposed for caller to log
  };
}

// ----------------------------------------------------------------------------
// TRIM CARD — TP1 hit
// ----------------------------------------------------------------------------
function buildTrimCard(opts) {
  opts = opts || {};
  var ticker = String(opts.ticker || '').toUpperCase();
  var src    = (opts.source || 'unknown').toLowerCase();
  var emoji  = emojiFor(src);
  var contract = opts.contract || {};
  var fillPrice = opts.fillPrice != null ? Number(opts.fillPrice) : null;
  var entry = opts.entry != null ? Number(opts.entry) : null;
  var pctGain = (entry && fillPrice) ? (((fillPrice - entry) / entry) * 100).toFixed(1) + '%' : '—';
  var dollarGain = (entry && fillPrice && opts.qty) ? '$' + ((fillPrice - entry) * Number(opts.qty) * 100).toFixed(0) : '—';

  var fields = [
    { name: '✂️ TP1 Filled', value: fillPrice != null ? '$' + fillPrice.toFixed(2) : '—', inline: true },
    { name: '📈 Gain', value: pctGain + ' · ' + dollarGain, inline: true },
    { name: '🎫 Account', value: opts.account || '—', inline: true },
  ];
  if (contract && contract.expiry) {
    fields.push({ name: '📋 Contract', value: ticker + ' ' + contract.expiry + ' $' + contract.strike + (opts.direction === 'short' || opts.direction === 'put' ? 'P' : 'C'), inline: false });
  }
  fields.push({
    name: '📌 Next',
    value: 'Runner is on. Trail stop to entry. TP2 still set' + (opts.tp2 != null ? ' at **$' + Number(opts.tp2).toFixed(2) + '**.' : '.'),
    inline: false,
  });

  var embed = {
    title: emoji + ' TRIM — ' + ticker + ' TP1 HIT',
    color: 0x4CAF50,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Bill-money locked · 1 ct sold · 1 ct runs' },
  };
  return { embeds: [embed], username: 'Stratum LIFECYCLE' };
}

// ----------------------------------------------------------------------------
// EXIT CARD — full close (TP2, stop, manual)
// ----------------------------------------------------------------------------
function buildExitCard(opts) {
  opts = opts || {};
  var ticker = String(opts.ticker || '').toUpperCase();
  var src    = (opts.source || 'unknown').toLowerCase();
  var emoji  = emojiFor(src);
  var reason = opts.reason || 'manual';
  var fillPrice = opts.fillPrice != null ? Number(opts.fillPrice) : null;
  var entry = opts.entry != null ? Number(opts.entry) : null;
  var qty = Number(opts.qty || 1);
  var dollarPL = (entry && fillPrice != null) ? ((fillPrice - entry) * qty * 100) : null;
  var pctPL = (entry && fillPrice != null) ? (((fillPrice - entry) / entry) * 100).toFixed(1) + '%' : '—';

  var color = (dollarPL == null) ? 0x9E9E9E : (dollarPL > 0 ? 0x4CAF50 : 0xF44336);
  var icon = (dollarPL == null) ? '⚪' : (dollarPL > 0 ? '✅' : '🛑');

  var fields = [
    { name: '🚪 Reason', value: String(reason).toUpperCase(), inline: true },
    { name: '🎫 Account', value: opts.account || '—', inline: true },
    { name: '💵 P/L', value: (dollarPL != null ? (dollarPL > 0 ? '+' : '') + '$' + dollarPL.toFixed(0) + ' (' + pctPL + ')' : pctPL), inline: true },
  ];
  if (fillPrice != null) fields.push({ name: '🏷️ Fill', value: '$' + fillPrice.toFixed(2), inline: true });
  if (entry != null)     fields.push({ name: '🎬 Entry', value: '$' + entry.toFixed(2), inline: true });

  var embed = {
    title: icon + ' EXIT — ' + ticker + ' (' + emoji + ')',
    color: color,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Closed · ' + reason },
  };
  return { embeds: [embed], username: 'Stratum LIFECYCLE' };
}

module.exports = {
  buildEntryCard: buildEntryCard,
  buildTrimCard:  buildTrimCard,
  buildExitCard:  buildExitCard,
  persistSignal:  persistSignal,
  loadSignal:     loadSignal,
  markFired:      markFired,
  readSignals:    readSignals,
  // Useful helpers
  colorFor: colorFor,
  emojiFor: emojiFor,
  chartImage: chartImage,
  tvChartUrl: tvChartUrl,
  ACTIVE_SIGNALS_FILE: ACTIVE_SIGNALS_FILE,
};
