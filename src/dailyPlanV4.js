// dailyPlanV4.js — Auto-discovered daily trade plan generator
// ----------------------------------------------------------------------
// Built Apr 27 2026 after AB lost $600 on a HOOD trade that was on the
// handpicked TOMORROW board. Root cause: handpicked watchlists miss
// mega-cap rotation (GOOGL/SNAP/MU/AMD/MSFT had cleaner setups but were
// not on the board). This module replaces the human watchlist with:
//
//   1. /api/live-movers  → top 20 ranked names by % move + vol + range
//   2. JSmith peek       → John's latest picks across 4 channels
//   3. Confluence score  → mover + John mention + earnings proximity
//   4. ATM next-Friday   → live option mid via /api/option-mids
//
// Output: markdown plan + Discord summary post + (optional) PDF when
// the build-tradeplan.sh script is available locally.
//
// Cron fires Mon-Fri 4:30 PM ET via server.js scheduler. Manual trigger
// available at POST /api/tradeplan/build-v4 (auth: x-stratum-secret).
// ----------------------------------------------------------------------

var fs       = require('fs');
var path     = require('path');
var fetchLib = require('node-fetch');

// ----------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------
var INTERNAL_BASE = 'http://localhost:' + (process.env.PORT || 3000);
var DESKTOP_DIR   = '/Users/NinjaMon/Desktop';
var TMP_DIR       = '/tmp';
var DISCORD_HOOK  =
  process.env.DISCORD_STRATUMSWING_WEBHOOK ||
  'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';

var CHANNEL_KEYS = ['VIP_FLOW_OPTIONS', 'OPTION_TRADE_IDEAS', 'CAPITAL_FLOW', 'SWINGS_LEAPS'];

// John's standard ladder applied to live option mid
var JOHN_LADDER = { stop: -0.25, tp1: 0.25, tp2: 0.50, tp3: 1.00 };

// ----------------------------------------------------------------------
// EARNINGS BLOCKLIST (Apr 27 lesson — HOOD swing into Tue AH earnings = -$600)
// Tickers reporting within EARNINGS_BLOCK_DAYS are EXCLUDED from the plan.
// Update this list each Sunday from the upcoming earnings calendar, OR
// hook to a real earnings feed when /api/earnings is built.
// ----------------------------------------------------------------------
var EARNINGS_BLOCK_DAYS = 3;  // exclude any name reporting in next 3 trading days
// AB confirmed Apr 27 PM: TSLA already reported (last week per his TS terminal).
// Remove TSLA from blocklist. Mega-caps still upcoming this week.
// TODO v4.2: wire to live earnings feed (econCalendar/finviz API) so this
// list auto-updates rather than being hand-maintained.
var EARNINGS_THIS_WEEK = {
  // Apr 28 - May 2 2026 — UPCOMING earnings (not already-reported)
  'HOOD':  '2026-04-28',  // Tue AH — REMOVED from plan
  'AMZN':  '2026-04-29',  // Wed AH
  'MSFT':  '2026-04-29',  // Wed AH
  'META':  '2026-04-29',  // Wed AH
  'GOOGL': '2026-04-29',  // Wed AH
  'GOOG':  '2026-04-29',
  'AAPL':  '2026-04-30',  // Thu AH
};

function tradingDaysUntil(targetDateStr, fromDate) {
  if (!targetDateStr) return null;
  var target = new Date(targetDateStr + 'T00:00:00-04:00');
  var from   = fromDate || new Date();
  var diff   = Math.ceil((target - from) / (1000 * 60 * 60 * 24));
  return diff;
}

function isEarningsBlocked(ticker, fromDate) {
  var d = EARNINGS_THIS_WEEK[ticker];
  if (!d) return false;
  var days = tradingDaysUntil(d, fromDate);
  return days !== null && days >= 0 && days <= EARNINGS_BLOCK_DAYS;
}

function earningsFlag(ticker, fromDate) {
  var d = EARNINGS_THIS_WEEK[ticker];
  if (!d) return null;
  var days = tradingDaysUntil(d, fromDate);
  if (days == null) return null;
  if (days < 0)  return '✅ POST-EARNINGS (already reported)';
  if (days === 0) return '🚨 EARNINGS TODAY AH — DO NOT TRADE';
  if (days <= 3) return '⚠️ EARNINGS in ' + days + 'd (' + d + ') — BLOCKED';
  return '📅 Earnings ' + d;
}

// ----------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------
function safeNum(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
function fmtPrice(v) { return (v == null || !isFinite(v)) ? 'n/a' : '$' + Number(v).toFixed(2); }
function fmtPct(v) { return (v == null || !isFinite(v)) ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function fmtInt(v) { return (v == null || !isFinite(v)) ? 'n/a' : Math.round(v).toLocaleString(); }

// Format a Date in America/New_York timezone with parts.
function etParts(d) {
  d = d || new Date();
  // en-US locale gives: "Mon, 04/27/2026, 16:30:05"
  var s = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year:    'numeric',
    month:   '2-digit',
    day:     '2-digit',
    hour:    '2-digit',
    minute:  '2-digit',
    hour12:  false,
  });
  // s like "Mon, 04/27/2026, 16:30"
  var m = s.match(/^(\w+),\s*(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+)/);
  if (!m) return null;
  return {
    weekday: m[1],
    month:   parseInt(m[2], 10),
    day:     parseInt(m[3], 10),
    year:    parseInt(m[4], 10),
    hour:    parseInt(m[5], 10),
    minute:  parseInt(m[6], 10),
  };
}

// "2026-04-28"
function etISODate(d) {
  var p = etParts(d || new Date());
  if (!p) return null;
  return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}

// Returns the next trading day (skip Sat/Sun) given an ET Date.
function nextTradingDay(d) {
  var base = new Date(d || Date.now());
  // Step forward in 1-day increments until we hit Mon-Fri
  for (var i = 1; i <= 5; i++) {
    var trial = new Date(base.getTime() + i * 24 * 60 * 60 * 1000);
    var p = etParts(trial);
    if (!p) continue;
    // Map weekday short name → 0..6
    var wd = ({Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6})[p.weekday];
    if (wd >= 1 && wd <= 5) return trial;
  }
  return new Date(base.getTime() + 24 * 60 * 60 * 1000);
}

// Returns YYMMDD for the next Friday at or after the given date.
// Used to build OSI option symbols for the next-Friday expiry.
function nextFridayYYMMDD(d) {
  var base = new Date((d || new Date()).getTime());
  // Walk forward up to 7 days to find Friday in ET
  for (var i = 0; i <= 7; i++) {
    var trial = new Date(base.getTime() + i * 24 * 60 * 60 * 1000);
    var p = etParts(trial);
    if (!p) continue;
    if (p.weekday === 'Fri') {
      var yy = String(p.year).slice(2);
      var mm = String(p.month).padStart(2, '0');
      var dd = String(p.day).padStart(2, '0');
      return yy + mm + dd;
    }
  }
  return null;
}

// Build OSI option symbol like "AAPL 260502C175"
function buildOSI(ticker, expiryYYMMDD, side, strike) {
  var s = String(strike);
  // Drop trailing .00 on integer strikes (TS prefers integer when possible)
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return ticker + ' ' + expiryYYMMDD + side + s;
}

// Round a price to a sensible ATM strike.
function atmStrike(spot) {
  if (!spot || !isFinite(spot)) return null;
  if (spot >= 200) return Math.round(spot / 5) * 5;       // $5 strikes
  if (spot >= 50)  return Math.round(spot);                // $1 strikes
  if (spot >= 10)  return Math.round(spot * 2) / 2;        // $0.50 strikes
  return Math.round(spot * 2) / 2;
}

// ----------------------------------------------------------------------
// DATA FETCHERS — all defensive: return [] / null on failure rather
// than throwing. We want the plan to ship even if half the feeds fail.
// ----------------------------------------------------------------------
async function fetchMovers() {
  try {
    var r = await fetchLib(INTERNAL_BASE + '/api/live-movers', { timeout: 20000 });
    if (!r.ok) { console.error('[V4-PLAN] live-movers HTTP ' + r.status); return []; }
    var data = await r.json();
    return (data && data.movers) ? data.movers : [];
  } catch (e) {
    console.error('[V4-PLAN] live-movers fetch failed:', e.message);
    return [];
  }
}

async function fetchJohnPicks() {
  try {
    var poller;
    try { poller = require('./stratumExternalPoller'); } catch (e) { return []; }
    if (!poller || typeof poller.peekLatest !== 'function') return [];
    var all = [];
    for (var i = 0; i < CHANNEL_KEYS.length; i++) {
      var key = CHANNEL_KEYS[i];
      try {
        var res = await poller.peekLatest(key, 10);
        if (res && Array.isArray(res.messages)) {
          res.messages.forEach(function(m) {
            all.push({
              channel: key,
              author:  m.author,
              ts:      m.timestamp,
              text:    [m.content || '']
                         .concat((m.embeds || []).map(function(e){
                           return [e.title || '', e.description || ''].join(' ');
                         }))
                         .join(' '),
            });
          });
        }
      } catch (e) {
        console.error('[V4-PLAN] peekLatest(' + key + ') failed:', e.message);
      }
    }
    return all;
  } catch (e) {
    console.error('[V4-PLAN] fetchJohnPicks failed:', e.message);
    return [];
  }
}

async function fetchOptionMids(osiList) {
  if (!osiList || !osiList.length) return {};
  try {
    var url = INTERNAL_BASE + '/api/option-mids?symbols=' +
              osiList.map(encodeURIComponent).join(',');
    var r = await fetchLib(url, { timeout: 12000 });
    if (!r.ok) return {};
    var data = await r.json();
    var out = {};
    (data.quotes || []).forEach(function(q) { out[q.symbol] = q; });
    return out;
  } catch (e) {
    console.error('[V4-PLAN] option-mids fetch failed:', e.message);
    return {};
  }
}

// ----------------------------------------------------------------------
// SCORING
// ----------------------------------------------------------------------
// Bonus when a ticker shows up in John's recent picks. Higher bonus if
// the message specifically mentions the target date or "DAY TRADE" or a
// "(YYYY/MM/DD)" date matching tomorrow.
function johnBonusFor(ticker, picks, targetISO) {
  if (!ticker || !picks || !picks.length) return { bonus: 0, mentions: 0, hot: false };
  var tickerRE = new RegExp('\\b' + ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  var dateUS = '';
  if (targetISO) {
    var p = targetISO.split('-');
    dateUS = p[1] + '/' + p[2] + '/' + p[0];   // 04/28/2026
  }
  // Match (YYYY/MM/DD) or (M/D)
  var dateRE = targetISO
    ? new RegExp('(' + targetISO.replace(/-/g, '\\/') + '|' +
                  dateUS.replace(/\//g, '\\/') + ')')
    : null;
  var hits = 0, hot = false;
  picks.forEach(function(m) {
    var t = m.text || '';
    if (!tickerRE.test(t)) return;
    hits++;
    if (/DAY\s*TRADE/i.test(t)) hot = true;
    if (dateRE && dateRE.test(t)) hot = true;
  });
  // 8 pts per mention, +15 if hot match (capped to keep one channel
  // from stuffing the score)
  var bonus = Math.min(hits, 4) * 8 + (hot ? 15 : 0);
  return { bonus: bonus, mentions: hits, hot: hot };
}

// Earnings proximity placeholder — wire to real earnings feed when one
// lands. For now: stays at 0 and the section is marked PENDING in MD.
function earningsBonusFor(/* ticker */) {
  return { bonus: 0, daysOut: null };
}

// ----------------------------------------------------------------------
// PLAN BUILDER
// ----------------------------------------------------------------------
function rankPicks(movers, johnPicks, targetISO) {
  // v4.1 (Apr 27 PM): apply earnings blocklist FIRST — drop names reporting
  // within EARNINGS_BLOCK_DAYS so they never make the plan, ever. HOOD lesson.
  var targetDate = targetISO ? new Date(targetISO + 'T08:00:00-04:00') : new Date();
  var filtered = movers.filter(function(m) {
    if (isEarningsBlocked(m.ticker, targetDate)) {
      console.log('[V4-PLAN] BLOCKED earnings risk:', m.ticker, EARNINGS_THIS_WEEK[m.ticker]);
      return false;
    }
    return true;
  });

  return filtered.map(function(m) {
    var jb = johnBonusFor(m.ticker, johnPicks, targetISO);
    var eb = earningsBonusFor(m.ticker);
    var composite = (m.score || 0) + jb.bonus + eb.bonus;
    return {
      ticker:    m.ticker,
      last:      m.last,
      prevClose: m.prevClose,
      pctChange: m.pctChange,
      volume:    m.volume,
      volMA30:   m.volMA30,
      volRatio:  m.volRatio,
      rangePct:  m.rangePct,
      direction: m.suggestedDirection,
      moverScore: m.score,
      johnMentions: jb.mentions,
      johnHot:      jb.hot,
      johnBonus:    jb.bonus,
      earningsDaysOut: eb.daysOut,
      earningsBonus:   eb.bonus,
      earningsFlag:    earningsFlag(m.ticker, targetDate),
      composite: +composite.toFixed(2),
    };
  }).sort(function(a, b) { return b.composite - a.composite; });
}

function bracketFromMid(mid) {
  if (!mid || !isFinite(mid) || mid <= 0) return null;
  return {
    entry: +mid.toFixed(2),
    stop:  +(mid * (1 + JOHN_LADDER.stop)).toFixed(2),
    tp1:   +(mid * (1 + JOHN_LADDER.tp1)).toFixed(2),
    tp2:   +(mid * (1 + JOHN_LADDER.tp2)).toFixed(2),
    tp3:   +(mid * (1 + JOHN_LADDER.tp3)).toFixed(2),
    riskPerCt: +((mid * Math.abs(JOHN_LADDER.stop)) * 100).toFixed(2),
    tp1PerCt:  +((mid * JOHN_LADDER.tp1) * 100).toFixed(2),
    tp2PerCt:  +((mid * JOHN_LADDER.tp2) * 100).toFixed(2),
    tp3PerCt:  +((mid * JOHN_LADDER.tp3) * 100).toFixed(2),
  };
}

// Attach OSI symbols + live mids to top picks.
async function attachOptionData(picks, expiryYYMMDD) {
  if (!picks.length) return picks;
  var osiList = [];
  picks.forEach(function(p) {
    var spot = p.last;
    var strike = atmStrike(spot);
    if (!strike) return;
    var side = (p.direction === 'PUT') ? 'P' : 'C';
    p.strike = strike;
    p.expiry = expiryYYMMDD;
    p.side   = side;
    p.osi    = buildOSI(p.ticker, expiryYYMMDD, side, strike);
    osiList.push(p.osi);
  });
  var mids = await fetchOptionMids(osiList);
  picks.forEach(function(p) {
    if (!p.osi) return;
    var q = mids[p.osi];
    if (!q) {
      // Try a fallback OSI without the trailing .0 in the strike
      // tradestation accepts both forms but we stay defensive.
      q = mids[p.osi.replace(/(\d)\.0$/, '$1')];
    }
    p.optionMid    = q ? q.mid : null;
    p.optionBid    = q ? q.bid : null;
    p.optionAsk    = q ? q.ask : null;
    p.optionVolume = q ? q.volume : null;
    p.optionOI     = q ? q.openInterest : null;
    p.bracket      = q && q.mid ? bracketFromMid(q.mid) : null;
  });
  return picks;
}

// ----------------------------------------------------------------------
// MARKDOWN BUILDER — match the v3 voice.
// ----------------------------------------------------------------------
function buildMarkdown(ctx) {
  var lines = [];
  var p = ctx.targetParts;
  var dayLabel = p ? (p.weekday + ' ' + p.month + '/' + p.day + '/' + p.year) : 'Next Session';
  var topPicks = ctx.picks.slice(0, 8);
  var top5     = ctx.picks.slice(0, 5);

  lines.push('# Stratum Trade Plan — ' + dayLabel + ' (v4 — AUTO-DISCOVERED)');
  lines.push('');
  lines.push('> **Auto-built ' + ctx.builtAtET + ' ET. No handpicked watchlist — top names ranked from live tape + John\'s 4-channel feed.**');
  lines.push('>');
  lines.push('> Built after the Apr 27 HOOD -$600 loss exposed the gap in human-curated boards.');
  lines.push('> If a name shows up here it earned the slot via score, not vibes.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // SIZING RULE — FIRST THING ON THE PAGE (Apr 27 lesson: HOOD -$600 from 5ct cold fire)
  lines.push('## ⚠️ SIZING RULE — READ BEFORE FIRING');
  lines.push('');
  lines.push('**Every "qty" number in this plan is the FULL TARGET position, NOT the opening entry.**');
  lines.push('');
  lines.push('| Step | Size | Trigger |');
  lines.push('|---|---|---|');
  lines.push('| **Open** | **1ct** | First 5m close above trigger price |');
  lines.push('| **Add 1** | +2ct (3ct total) | Retest of trigger holds + 5m close > trigger |');
  lines.push('| **Add 2** | +2ct (5ct total) | TP1 hit, breakout extending |');
  lines.push('');
  lines.push('🚨 **NEVER lead with 5ct on a fresh setup.** Today\'s -$600 HOOD loss came from firing 5ct cold on an unconfirmed bias-blocked signal. Earn the size.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // TL;DR
  lines.push('## TL;DR — morning routine');
  lines.push('');
  lines.push('1. **8:30 AM** — read this plan + cross-check SPY/QQQ daily bar from last close.');
  lines.push('2. **9:00 AM** — set TV alerts for the top 5 triggers in the table below.');
  lines.push('3. **9:30 AM** — DO NOT FIRE. Watch the open. Let the institutional sweep print.');
  lines.push('4. **9:45 AM** — earliest fire window. Three 5m closes above trigger required.');
  lines.push('5. **10:00 AM+** — execute against the brackets below. **1ct initial → 2ct retest → 2ct TP1 add.**');
  lines.push('6. **3:45 PM** — flat all day-trade contracts. Swings only past this point.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // LIVE MOVERS
  lines.push('## LIVE MOVERS RANKED (auto from /api/live-movers)');
  lines.push('');
  if (!ctx.movers.length) {
    lines.push('> live-movers feed empty or failed. Check /api/live-movers manually.');
  } else {
    lines.push('| # | Ticker | Last | %Δ | Vol Ratio | Range% | Score | Dir |');
    lines.push('|---|---|---|---|---|---|---|---|');
    ctx.movers.slice(0, 20).forEach(function(m, i) {
      lines.push('| ' + (i+1) + ' | **' + m.ticker + '** | ' + fmtPrice(m.last) +
                 ' | ' + fmtPct(m.pctChange) +
                 ' | ' + (m.volRatio != null ? m.volRatio + 'x' : 'n/a') +
                 ' | ' + (m.rangePct != null ? m.rangePct + '%' : 'n/a') +
                 ' | ' + (m.score != null ? m.score.toFixed(2) : 'n/a') +
                 ' | ' + (m.suggestedDirection || '?') + ' |');
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // EARNINGS RADAR
  lines.push('## EARNINGS RADAR');
  lines.push('');
  lines.push('> earnings feed pending — wire to econCalendar/finviz earnings in v4.1.');
  lines.push('> For now: cross-check tickers against your earnings calendar manually before fire.');
  lines.push('> Reminder: NEVER hold options through an earnings print without specific intent.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // TOP 5 SETUPS
  lines.push('## TOP 5 SETUPS — bracket math on live mid');
  lines.push('');
  if (!top5.length) {
    lines.push('> No qualifying setups generated. Skip the day or build a manual board.');
  } else {
    top5.forEach(function(pk, i) {
      var rank = ['🥇 #1', '🥇 #2', '🥈 #3', '🥉 #4', '🥉 #5'][i];
      var sideWord = pk.direction === 'PUT' ? 'PUT' : 'CALL';
      lines.push('### ' + rank + ' — ' + pk.ticker + ' ' + (pk.strike || '?') + sideWord.charAt(0) +
                 ' ' + (pk.expiry ? pk.expiry.slice(2,4) + '/' + pk.expiry.slice(4,6) : '') +
                 ' (composite ' + pk.composite + ')');
      lines.push('');
      lines.push('**Spot ' + fmtPrice(pk.last) + ' (' + fmtPct(pk.pctChange) + ' today). ' +
                 'Vol ' + (pk.volRatio != null ? pk.volRatio + 'x' : 'n/a') + ' avg, range ' +
                 (pk.rangePct != null ? pk.rangePct + '%' : 'n/a') + '.**');
      lines.push('');
      if (pk.johnMentions) {
        lines.push('John mentions: **' + pk.johnMentions + '**' +
                   (pk.johnHot ? ' (hot match — date or DAY TRADE keyword)' : '') + '.');
      } else {
        lines.push('No John mentions in last 10 messages — pure tape pick.');
      }
      lines.push('');

      if (pk.bracket) {
        var b = pk.bracket;
        lines.push('| | Stock | Option (' + pk.osi + ') |');
        lines.push('|---|---|---|');
        lines.push('| **Trigger** (5m close above) | ' + fmtPrice(pk.last) +
                   ' break confirm | LIMIT ' + fmtPrice(b.entry) + ' |');
        lines.push('| **Stop** (-25% John ladder) | structural — see chart | ' +
                   fmtPrice(b.stop) + ' |');
        lines.push('| **TP1** (+25%) | first cluster / R:1 | ' + fmtPrice(b.tp1) +
                   ' — peel 1ct |');
        lines.push('| **TP2** (+50%) | next magnet | ' + fmtPrice(b.tp2) + ' — peel 1-2ct |');
        lines.push('| **TP3** (+100%) | full extension | ' + fmtPrice(b.tp3) + ' — runner |');
        lines.push('');
        lines.push('Per-ct math: risk ~$' + b.riskPerCt + ' to make $' + b.tp1PerCt +
                   ' at TP1 / $' + b.tp2PerCt + ' at TP2 / $' + b.tp3PerCt + ' at TP3.');
        if (b.tp1PerCt < 50) {
          lines.push('⚠️ TP1 < $50/ct — size 5+ ct OR skip per AB rule.');
        }
      } else {
        lines.push('_Option mid pull failed for ' + (pk.osi || 'n/a') +
                   ' — pull manually before fire (TS chain → mid → apply -25/+25/+50/+100)._ ');
      }
      lines.push('');
    });
  }
  lines.push('---');
  lines.push('');

  // BACKUP PICKS 6-8
  if (topPicks.length > 5) {
    lines.push('## BACKUP — picks 6-8');
    lines.push('');
    lines.push('| # | Ticker | Dir | Spot | %Δ | Vol | Composite | OSI | Mid |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    topPicks.slice(5).forEach(function(pk, i) {
      lines.push('| ' + (i+6) + ' | **' + pk.ticker + '** | ' + pk.direction +
                 ' | ' + fmtPrice(pk.last) + ' | ' + fmtPct(pk.pctChange) +
                 ' | ' + (pk.volRatio != null ? pk.volRatio + 'x' : 'n/a') +
                 ' | ' + pk.composite +
                 ' | ' + (pk.osi || 'n/a') +
                 ' | ' + (pk.optionMid != null ? fmtPrice(pk.optionMid) : 'n/a') + ' |');
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // 7 v4 FILTERS
  lines.push('## ALL 7 v4 FILTERS — read before every click');
  lines.push('');
  lines.push('1. **No fires before 9:45 ET.** The first 15 min is institutional sweep — not yours.');
  lines.push('2. **Three 5m close hold required.** Two-bar confirms got us stop-hunted; we hold for three.');
  lines.push('3. **SPY 5m above 20MA for CALL fires** (regime alignment). Below 20MA = puts only or stand down.');
  lines.push('4. **Adaptive intraday levels (LVL Assist v2.2.4).** Use the framework, not gut levels.');
  lines.push('5. **Auto-trim mode default ON.** Peel on each push — bills before runners.');
  lines.push('6. **Scale-in: 1ct initial, 2ct on retest, 2ct on TP1.** Never lead with full size.');
  lines.push('7. **Volume confirmation: bar vol > 20MA on the breakout bar.** Thin breakouts fade.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // JOHN PICKS RAW (digest of last 10 msgs/channel)
  if (ctx.johnPicks && ctx.johnPicks.length) {
    var byCh = {};
    ctx.johnPicks.forEach(function(m) { (byCh[m.channel] = byCh[m.channel] || []).push(m); });
    lines.push('## JOHN FEED DIGEST (latest 10/channel)');
    lines.push('');
    Object.keys(byCh).forEach(function(ch) {
      lines.push('### ' + ch);
      byCh[ch].slice(0, 5).forEach(function(m) {
        var snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (snippet) lines.push('- _' + (m.ts ? m.ts.slice(0, 16) : '?') + '_ — ' + snippet);
      });
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  }

  // FOOTER
  lines.push('## TODAY WE MAKE MONEY');
  lines.push('');
  lines.push('Order of priority: top 5 in score order. Don\'t skip ranks. Don\'t bend the 7 filters.');
  lines.push('');
  lines.push('Walk into ' + dayLabel + ' clear-headed. Plan beats reaction every time.');
  lines.push('');
  lines.push('— v4 auto-plan');
  lines.push('');
  return lines.join('\n');
}

// ----------------------------------------------------------------------
// DISCORD POST — keep < 2000 chars, link to PDF if hostable.
// ----------------------------------------------------------------------
function buildDiscordContent(ctx) {
  var p = ctx.targetParts;
  var dayLabel = p ? (p.weekday + ' ' + p.month + '/' + p.day) : 'Next Session';
  var top5 = ctx.picks.slice(0, 5);
  var lines = [];
  lines.push('**Stratum Trade Plan — ' + dayLabel + ' (v4 AUTO-DISCOVERED)**');
  lines.push('Built ' + ctx.builtAtET + ' ET');
  lines.push('');
  if (!top5.length) {
    lines.push('No qualifying setups. Skip the open or build a manual board.');
  } else {
    lines.push('```');
    lines.push('# | Ticker | Dir | Spot   | %Δ     | OptionMid | Comp');
    lines.push('--+--------+-----+--------+--------+-----------+-----');
    top5.forEach(function(pk, i) {
      lines.push((i+1) + ' | ' + pk.ticker.padEnd(6) +
                 ' | ' + (pk.direction || '?').padEnd(3) +
                 ' | ' + (pk.last != null ? ('$'+pk.last.toFixed(2)).padEnd(6) : 'n/a   ') +
                 ' | ' + (pk.pctChange != null ?
                          ((pk.pctChange >= 0 ? '+' : '') + pk.pctChange.toFixed(2) + '%').padEnd(6) :
                          'n/a   ') +
                 ' | ' + (pk.optionMid != null ? ('$'+pk.optionMid.toFixed(2)).padEnd(9) : 'n/a      ') +
                 ' | ' + pk.composite);
    });
    lines.push('```');
  }
  lines.push('');
  lines.push('**v4.1 filters:** 9:45 ET HARD GATE · 3x 5m closes · SPY>20MA for calls · LVL Assist v2.3.0 ✅ CONFIRMED · earnings ≤3d BLOCKED · auto-trim ON · scale 1/2/2 · vol>20MA · prefer RETESTS over breakouts');
  lines.push('');
  if (ctx.pdfPath) lines.push('Local PDF: `' + ctx.pdfPath + '`');
  if (ctx.mdPath)  lines.push('Local MD:  `' + ctx.mdPath + '`');
  var out = lines.join('\n');
  // Discord 2000 char limit safety net
  if (out.length > 1900) out = out.slice(0, 1850) + '\n...(truncated)';
  return out;
}

async function postDiscord(content) {
  try {
    if (!DISCORD_HOOK) { console.warn('[V4-PLAN] no Discord hook configured'); return null; }
    var r = await fetchLib(DISCORD_HOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: content, username: 'Stratum Trade Plan v4' }),
      timeout: 8000,
    });
    return { status: r.status, ok: r.ok };
  } catch (e) {
    console.error('[V4-PLAN] Discord post failed:', e.message);
    return { error: e.message };
  }
}

// ----------------------------------------------------------------------
// PUBLIC API
// ----------------------------------------------------------------------
async function generateV4Plan(targetDate) {
  var now      = new Date();
  var target   = targetDate ? new Date(targetDate) : nextTradingDay(now);
  var tParts   = etParts(target);
  var targetISO = etISODate(target);
  var expiry   = nextFridayYYMMDD(target);
  var builtAt  = etParts(now);
  var builtAtET = builtAt
    ? (builtAt.month + '/' + builtAt.day + ' ' + String(builtAt.hour).padStart(2,'0') + ':' + String(builtAt.minute).padStart(2,'0'))
    : now.toISOString();

  console.log('[V4-PLAN] generating for target=' + targetISO + ' expiry=' + expiry);

  var movers, johnPicks;
  try {
    var pair = await Promise.all([fetchMovers(), fetchJohnPicks()]);
    movers    = pair[0] || [];
    johnPicks = pair[1] || [];
  } catch (e) {
    console.error('[V4-PLAN] data fetch error:', e.message);
    movers = []; johnPicks = [];
  }

  var ranked = rankPicks(movers, johnPicks, targetISO);
  var top    = ranked.slice(0, 8);
  await attachOptionData(top, expiry);

  var ctx = {
    targetISO:    targetISO,
    targetParts:  tParts,
    builtAtET:    builtAtET,
    movers:       movers,
    johnPicks:    johnPicks,
    picks:        top,
  };
  var md = buildMarkdown(ctx);
  ctx.md = md;

  // Save markdown — try Desktop first (local dev), fall back to /tmp on Railway.
  var mdPath = null;
  var fname  = 'TRADEPLAN_' + targetISO + '.md';
  var candidates = [path.join(DESKTOP_DIR, fname), path.join(TMP_DIR, fname)];
  for (var i = 0; i < candidates.length; i++) {
    try {
      fs.writeFileSync(candidates[i], md, 'utf8');
      mdPath = candidates[i];
      console.log('[V4-PLAN] markdown saved →', mdPath);
      break;
    } catch (e) {
      console.warn('[V4-PLAN] write to', candidates[i], 'failed:', e.message);
    }
  }
  ctx.mdPath = mdPath;

  // PDF generation — only attempt if build-tradeplan.sh exists locally.
  var pdfPath = null;
  var buildScript = path.join(DESKTOP_DIR, 'build-tradeplan.sh');
  if (mdPath && mdPath.indexOf(DESKTOP_DIR) === 0 && fs.existsSync(buildScript)) {
    try {
      var execSync = require('child_process').execSync;
      execSync('bash ' + JSON.stringify(buildScript) + ' ' + JSON.stringify(mdPath),
               { timeout: 60000, stdio: 'pipe' });
      var maybe = mdPath.replace(/\.md$/, '.pdf');
      if (fs.existsSync(maybe)) { pdfPath = maybe; console.log('[V4-PLAN] PDF generated →', pdfPath); }
    } catch (e) {
      console.warn('[V4-PLAN] PDF build failed (non-fatal):', e.message);
    }
  } else {
    console.log('[V4-PLAN] skipping PDF — script not present (probably Railway)');
  }
  ctx.pdfPath = pdfPath;

  var discordContent = buildDiscordContent(ctx);

  return {
    md:             md,
    mdPath:         mdPath,
    pdfPath:        pdfPath,
    discordContent: discordContent,
    picks:          top,
    targetISO:      targetISO,
    expiry:         expiry,
    builtAtET:      builtAtET,
  };
}

async function runDailyPlanCron() {
  try {
    console.log('[V4-PLAN] cron fire — building tomorrow plan');
    var out = await generateV4Plan();
    var disc = await postDiscord(out.discordContent);
    console.log('[V4-PLAN] discord →', JSON.stringify(disc));
    return out;
  } catch (e) {
    console.error('[V4-PLAN] cron error:', e.message, e.stack);
    return { error: e.message };
  }
}

module.exports = {
  generateV4Plan:    generateV4Plan,
  runDailyPlanCron:  runDailyPlanCron,
  // export internals for tests / manual sanity checks
  _internals: {
    rankPicks:        rankPicks,
    bracketFromMid:   bracketFromMid,
    atmStrike:        atmStrike,
    nextFridayYYMMDD: nextFridayYYMMDD,
    nextTradingDay:   nextTradingDay,
    etISODate:        etISODate,
    buildOSI:         buildOSI,
    buildMarkdown:    buildMarkdown,
    buildDiscordContent: buildDiscordContent,
  },
};
