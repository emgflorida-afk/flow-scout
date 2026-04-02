// alerter.js - Stratum Flow Scout v6.1
// FULL EDGE: Time guardrails, spread warning, GEX, Max Pain, OI nodes, IV context
// TECHNICALS: RSI(14) + VWAP from TradingView webhook payload
// CHART: Finviz daily chart auto-attached to every alert
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// -----------------------------------------------------------------

const fetch             = require('node-fetch');
const optionChartReader = require('./optionChartReader');

// DISCORD CHANNELS
var INDICES_WEBHOOK = process.env.DISCORD_INDICES_WEBHOOK ||
  'https://discord.com/api/webhooks/1489297759248056513/U9w2yLf7qr3skwZuu6-mwMpVcB5Y1HQtLx5ulNQvugcWARG1HGagsoxUhrnX_f_GHsk5';
var INDEX_TICKERS = ['SPY', 'QQQ', 'IWM'];

// DEDUP TRACKER -- prevents duplicate auto-executions same ticker same day
var executedToday = {};
setInterval(function() {
  var now    = new Date();
  var etHour = ((now.getUTCHours() - 4) + 24) % 24;
  if (etHour === 0) { executedToday = {}; console.log('[DEDUP] Reset for new day'); }
}, 60 * 60 * 1000);
const resolver = require('./contractResolver');
const calendar    = require('./economicCalendar');
let smartStops   = null;
let macroFilter  = null;
let executeNow   = null;
let holdLock     = null;
try { smartStops  = require('./smartStop');    console.log('[ALERTER] smartStop loaded OK');   } catch(e) { console.log('[ALERTER] smartStop not loaded:', e.message); }
try { macroFilter = require('./macroFilter');  console.log('[ALERTER] macroFilter loaded OK'); } catch(e) { console.log('[ALERTER] macroFilter not loaded:', e.message); }
try { executeNow  = require('./executeNow');   console.log('[ALERTER] executeNow loaded OK');  } catch(e) { console.log('[ALERTER] executeNow not loaded:', e.message); }
try { holdLock    = require('./holdLock');     console.log('[ALERTER] holdLock loaded OK');    } catch(e) { console.log('[ALERTER] holdLock not loaded:', e.message); }

const WEBHOOKS = {
  strat:      process.env.DISCORD_WEBHOOK_URL,
  flow:       process.env.DISCORD_FLOW_WEBHOOK_URL,
  conviction: process.env.DISCORD_CONVICTION_WEBHOOK_URL,
  executeNow:  process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
    'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx',
  indicesBias: INDICES_WEBHOOK,
};

// -- FINVIZ CHART -------------------------------------------------
async function getFinvizChart(ticker) {
  try {
    const url = 'https://finviz.com/chart.ashx?t=' + ticker + '&ty=c&ta=1&p=d&s=l';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://finviz.com',
      },
    });
    if (!res.ok) { console.log('[CHART] Finviz ' + ticker + ' failed: ' + res.status); return null; }
    const buffer = await res.buffer();
    console.log('[CHART] ' + ticker + ' chart fetched OK');
    return buffer;
  } catch (err) {
    console.error('[CHART] Error fetching ' + ticker + ':', err.message);
    return null;
  }
}

// -- SEND CHART VIA MULTIPART -------------------------------------
// Uses raw multipart/form-data boundary - no FormData dependency
async function sendChartToDiscord(webhookUrl, ticker, chartBuffer) {
  try {
    const boundary = '----StratumBoundary' + Date.now();
    const filename  = ticker + '_chart.png';

    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: image/png\r\n\r\n'
    );
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, chartBuffer, tail]);

    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: {
        'Content-Type':   'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
      body,
    });
    if (res.ok) { console.log('[CHART] ' + ticker + ' sent to Discord OK'); }
    else        { console.log('[CHART] Discord rejected chart: ' + res.status); }
  } catch (err) {
    console.error('[CHART] Send error:', err.message);
  }
}

// -- SEND TO CHANNEL ----------------------------------------------
async function sendToChannel(channel, message, ticker) {
  const url = WEBHOOKS[channel];
  if (!url) { console.log('[DISCORD] No webhook for ' + channel); return false; }
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: '```\n' + message + '\n```', username: 'Stratum' }),
    });
    if (!res.ok) return false;
    console.log('[DISCORD] Sent to #' + channel + ' OK');

    if (ticker) {
      const chart = await getFinvizChart(ticker);
      if (chart) await sendChartToDiscord(url, ticker, chart);
    }
    return true;
  } catch (err) {
    console.error('[DISCORD] Error:', err.message);
    return false;
  }
}

async function sendDiscordRaw(msg) { await sendToChannel('strat', msg); }

function calcDTE(expiryDateStr) {
  const diff = Math.ceil((new Date(expiryDateStr + 'T16:00:00-04:00') - new Date()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

// -- RSI LABEL ----------------------------------------------------
function getRsiLabel(rsi) {
  if (rsi == null || isNaN(rsi)) return '--';
  if (rsi > 70) return 'overbought \u26a0\ufe0f';
  if (rsi < 30) return 'oversold \u26a0\ufe0f';
  if (rsi > 55) return 'bullish momentum';
  if (rsi < 45) return 'room to fall \u2705';
  return 'neutral';
}

// -- BUILD TECHNICALS SECTION -------------------------------------
function buildTechnicalsSection(tvData) {
  if (!tvData) return [];
  const rsi           = tvData.rsi           != null ? parseFloat(tvData.rsi)           : null;
  const vwap          = tvData.vwap          != null ? parseFloat(tvData.vwap)          : null;
  const vwapBias      = tvData.vwapBias      || null;
  const bearFVGTop    = tvData.bearFVGTop    != null ? parseFloat(tvData.bearFVGTop)    : null;
  const bearFVGBottom = tvData.bearFVGBottom != null ? parseFloat(tvData.bearFVGBottom) : null;
  const bullFVGTop    = tvData.bullFVGTop    != null ? parseFloat(tvData.bullFVGTop)    : null;
  const bullFVGBottom = tvData.bullFVGBottom != null ? parseFloat(tvData.bullFVGBottom) : null;

  if (rsi == null && vwap == null && bearFVGTop == null && bullFVGTop == null) return [];

  const lines = [];

  if (rsi != null && !isNaN(rsi) && rsi >= 0 && rsi <= 100) {
    lines.push('RSI (14)    ' + rsi.toFixed(0) + ' -- ' + getRsiLabel(rsi));
  }
  if (vwap != null && !isNaN(vwap)) {
    if (vwapBias) {
      const biasIcon = vwapBias === 'above' ? 'ABOVE -- bullish' : 'BELOW -- bearish';
      lines.push('VWAP        $' + vwap.toFixed(2) + ' -- price ' + biasIcon);
    } else {
      lines.push('VWAP        $' + vwap.toFixed(2));
    }
  }
  if (bearFVGTop != null && bearFVGBottom != null && bearFVGTop > 0 && bearFVGBottom > 0) {
    lines.push('FVG Above   $' + bearFVGBottom.toFixed(2) + '-$' + bearFVGTop.toFixed(2) + ' -- resistance gap');
  }
  if (bullFVGTop != null && bullFVGBottom != null && bullFVGTop > 0 && bullFVGBottom > 0) {
    lines.push('FVG Below   $' + bullFVGBottom.toFixed(2) + '-$' + bullFVGTop.toFixed(2) + ' -- target magnet \u2705');
  }

  return lines;
}

// -- FLOW SCORING -------------------------------------------------
function scoreFlow(flowData) {
  if (!flowData) flowData = {};
  const flags = [];
  let score = 0;
  const orderType = (flowData.orderType || '').toUpperCase();
  const premium   = parseFloat(flowData.totalPremium || 0);
  const alertName = (flowData.alertName || '').toLowerCase();

  if (orderType === 'SWEEP')      { score += 2; flags.push('SWEEP'); }
  else if (orderType === 'BLOCK') { score += 1; flags.push('BLOCK'); }

  if (premium >= 1000000)     { score += 4; flags.push('$' + (premium/1000000).toFixed(1) + 'M -- WHALE'); }
  else if (premium >= 500000) { score += 3; flags.push('$' + (premium/1000).toFixed(0) + 'K -- LARGE'); }
  else if (premium >= 100000) { score += 2; flags.push('$' + (premium/1000).toFixed(0) + 'K'); }
  else if (premium >= 25000)  { score += 1; flags.push('$' + (premium/1000).toFixed(0) + 'K'); }

  if (alertName.includes('urgent') || alertName.includes('whale') || alertName.includes('giant') || alertName.includes('grenade')) {
    score += 2; flags.push(flowData.alertName);
  } else if (alertName.includes('sweep') || alertName.includes('sizable')) {
    score += 1; flags.push(flowData.alertName);
  }

  const label = score >= 6 ? 'MAXIMUM CONVICTION'
               : score >= 4 ? 'HIGH CONVICTION'
               : score >= 2 ? 'NOTABLE FLOW'
               : 'FLOW DETECTED';

  return { score, flags, label, isHighConviction: score >= 4 };
}

// -- GRADE STRAT ALERT --------------------------------------------
function gradeStratAlert(confluence, hasFlow) {
  var score = parseInt((confluence || '0').split('/')[0]) || 0;
  if (score >= 6) return 'A+';
  if (score >= 5 && hasFlow) return 'A';
  if (score >= 5) return 'A';
  if (score >= 4) return 'B';
  return 'C';
}

// -- POSITION CONFLICT CHECK --------------------------------------
// Before firing any card check if we already own the opposite side
// Requires TS token to be valid -- silently skips if no token
var cachedPositions = null;
var positionCacheTime = 0;

async function getOpenPositions() {
  try {
    // Read from Claude MCP positions webhook -- no TS token needed
    var server = null;
    try { server = require('./server'); } catch(e) {}
    var livePos = server && server.getLivePositions ? server.getLivePositions() : {};

    if (livePos && Object.keys(livePos).length > 0) {
      console.log('[CONFLICT] Using Claude MCP positions -- ' + Object.keys(livePos).length + ' tickers');
      return livePos;
    }

    console.log('[CONFLICT] No live positions from Claude MCP yet -- skipping conflict check');
    return null;
  } catch(e) {
    console.error('[CONFLICT] Position check error:', e.message);
    return null;
  }
}

async function checkPositionConflict(ticker, type) {
  try {
    const positions = await getOpenPositions();
    if (!positions) return { conflict: false };
    const existing = positions[ticker] || [];
    const opposite = type === 'call' ? 'put' : 'call';
    if (existing.includes(opposite)) {
      console.log('[CONFLICT] ' + ticker + ' -- already have ' + opposite + ', new signal is ' + type);
      return { conflict: true, existing: opposite, newSignal: type };
    }
    return { conflict: false };
  } catch(e) { return { conflict: false }; }
}



const recentFlowTickers  = new Map();
const recentStratTickers = new Map();

// -- BUILD EDGE SECTION -------------------------------------------
function buildEdgeSection(resolved) {
  const lines = [];
  if (!resolved) return lines;

  const { maxPain, gex, oiNodes, ivCtx, timeCtx, wideSpread, bid, ask } = resolved;

  if (timeCtx && timeCtx.warning) lines.push(timeCtx.warning);

  if (wideSpread && bid && ask) {
    const sw = parseFloat((ask - bid).toFixed(2));
    lines.push('\u26a0\ufe0f WIDE SPREAD -- $' + sw + ' wide -- risky fill, limit at mid only');
  }

  if (resolved.dte === 0) {
    const now    = new Date();
    const etHour = now.getUTCHours() - 4;
    if (etHour >= 14) lines.push('\ud83d\udeab 0DTE after 2PM -- DO NOT ENTER');
  }

  if (lines.length > 0) lines.push('-------------------------------');

  if (maxPain) lines.push('Max Pain    $' + maxPain + ' -- price magnet into expiry');

  if (gex) {
    const gexM = (gex.netGEX / 1000000).toFixed(0);
    lines.push('GEX         ' + (gex.netGEX > 0 ? '+' : '') + '$' + gexM + 'M -- ' + (gex.isPositive ? 'POSITIVE (range bound)' : 'NEGATIVE (trending)') + ' ' + (gex.source || ''));
    if (gex.topGEXStrike) lines.push('GEX Pin     $' + gex.topGEXStrike + ' -- highest dealer hedge zone');
  }

  if (oiNodes && oiNodes.length > 0) {
    const top = oiNodes.slice(0, 2).map(function(n) { return '$' + n.strike + '(' + n.bias + ')'; }).join(' | ');
    lines.push('OI Walls    ' + top);
  }

  if (ivCtx) {
    lines.push('IV Regime   ' + ivCtx.ivRegime);
    lines.push('Impl Move   +-' + ivCtx.impliedMove + '% | Daily +-' + ivCtx.dailyMove + '%');
    if (ivCtx.recommendSpreads) lines.push('\ud83d\udca1 High IV -- consider spread instead of naked');
  }

  return lines;
}

// -- BUILD SPREAD CARD --------------------------------------------
function buildSpreadCard(resolved, tvData) {
  if (!tvData) tvData = {};
  const parsed = resolver.parseOPRA(resolved.symbol);
  if (!parsed) return null;

  const ticker    = parsed.ticker;
  const expiry    = parsed.expiry;
  const type      = parsed.type;
  const dte       = resolved.dte != null ? resolved.dte : calcDTE(expiry);
  const dteLabel  = dte + 'DTE';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const direction = type === 'put' ? 'BEARISH' : 'BULLISH';
  const typeLabel = type === 'put' ? 'P' : 'C';

  const sizing = resolver.calculatePositionSize(resolved.debit, 'SPREAD', 7000, resolved);
  const s      = sizing && sizing.viable ? sizing : null;

  const confluence = tvData.confluence || '';
  const tfParts = [];
  if (tvData.weekly) tfParts.push('WEEKLY:' + tvData.weekly);
  if (tvData.daily)  tfParts.push('DAILY:'  + tvData.daily);
  if (tvData.h4)     tfParts.push('H4:'     + tvData.h4);
  const tfLine = tfParts.join('  ');

  const edgeLines       = buildEdgeSection(resolved);
  const technicalsLines = buildTechnicalsSection(tvData);

  const lines = [
    'SPREAD TRADE -- ' + dteLabel,
    ticker + ' $' + resolved.strike + '/$' + resolved.sellStrike + typeLabel + ' ' + expiryFmt + ' -- ' + direction,
    '===============================',
    confluence ? 'Confluence  ' + confluence : null,
    tfLine     ? 'Bias    ' + tfLine         : null,
    '-------------------------------',
    'BUY     ' + ticker + ' $' + resolved.strike    + typeLabel + ' ' + expiryFmt,
    'SELL    ' + ticker + ' $' + resolved.sellStrike + typeLabel + ' ' + expiryFmt,
    'Width   $' + resolved.spreadWidth + ' spread',
    '-------------------------------',
    s ? 'Debit   $' + s.debit.toFixed(2) + ' x' + s.contracts + ' = $' + s.totalCost : 'Debit   $' + (resolved.debit ? resolved.debit.toFixed(2) : '--'),
    s ? 'Max Loss    $' + s.maxLoss    : null,
    s ? 'Max Profit  $' + s.maxGain   : null,
    'Breakeven   $' + resolved.breakeven,
    '-------------------------------',
    s ? 'Stop    $' + s.stopPrice + ' (50% of debit)'  : 'Stop    50% of debit',
    s ? 'T1      $' + s.t1Price   + ' (100% gain)'     : 'T1      +100% of debit',
    s ? 'Risk    ' + s.riskPct + '% of $7K = $' + s.maxLoss : 'Risk    defined',
    technicalsLines.length > 0 ? '-------------------------------' : null,
  ].concat(technicalsLines).concat([
    edgeLines.length > 0 ? '-------------------------------' : null,
  ]).concat(edgeLines).concat([
    '-------------------------------',
    'Hold    1-3 days max',
    'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
    (function() {
      var now = new Date();
      var etOffset = -4; // ET = UTC-4 (EDT)
      var etHour = ((now.getUTCHours() + etOffset) % 24 + 24) % 24;
      var etMin  = now.getUTCMinutes();
      var etTime = etHour * 60 + etMin;
      var PRIME_END   = 11 * 60;       // 11:00AM
      var CAUTION_END = 12 * 60;       // 12:00PM
      var LATE_ENTRY  = 15 * 60 + 30; // 3:30PM
      var MARKET_OPEN =  9 * 60 + 45; // 9:45AM

      function formatTime(totalMin) {
        var h = Math.floor(totalMin / 60) % 24;
        var m = totalMin % 60;
        var ampm = h >= 12 ? 'PM' : 'AM';
        var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        return h12 + ':' + (m < 10 ? '0' : '') + m + ampm + ' ET';
      }

      if (etTime >= LATE_ENTRY || etTime < MARKET_OPEN) {
        return 'Cancel By  DO NOT ENTER -- wait for 9:45AM';
      } else if (etTime >= CAUTION_END) {
        return 'Cancel By  SKIP -- choppy afternoon, wait for tomorrow';
      } else if (etTime >= PRIME_END) {
        var cancelMin = Math.min(etTime + 60, CAUTION_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' (CAUTION -- past prime time)';
      } else {
        var cancelMin = Math.min(etTime + 90, PRIME_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' -- PRIME TIME';
      }
    })(),
  ]).filter(function(l) { return l !== null; });

  return { text: lines.join('\n'), ticker: ticker };
}

// -- BUILD STRAT CARD ---------------------------------------------
async function buildStratCard(opraSymbol, tvData, resolved, ss) {
  if (!tvData)    tvData    = {};
  if (!resolved)  resolved  = null;

  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return null;

  const ticker    = parsed.ticker;
  const expiry    = parsed.expiry;
  const type      = parsed.type;
  const strike    = parsed.strike;
  const dte       = tvData.dte != null ? tvData.dte : calcDTE(expiry);
  const direction = type === 'put' ? 'BEARISH' : 'BULLISH';
  const typeLabel = type === 'put' ? 'P' : 'C';
  const expiryFmt = expiry.slice(5).replace('-', '/');
  const dteLabel  = dte === 0 ? '0DTE' : dte === 1 ? '1DTE' : dte + 'DTE';

  const mode      = tvData.mode || 'SWING';
  const premium   = tvData.mid  || null;
  const sizing    = premium ? resolver.calculatePositionSize(premium, mode) : null;
  const s         = sizing && sizing.viable ? sizing : null;
  const modeLabel = mode === 'DAY' ? 'DAY TRADE' : 'SWING TRADE';

  const confluence = tvData.confluence || '';
  const tfParts = [];
  if (tvData.weekly) tfParts.push('WEEKLY:' + tvData.weekly);
  if (tvData.daily)  tfParts.push('DAILY:'  + tvData.daily);
  if (tvData.h4)     tfParts.push('H4:'     + tvData.h4);
  if (tvData.h1)     tfParts.push('H1:'     + tvData.h1);
  const tfLine = tfParts.join('  ');

  const edgeLines       = resolved ? buildEdgeSection(resolved) : [];
  const technicalsLines = buildTechnicalsSection(tvData);

  const confluenceScore = parseInt((tvData.confluence || '0').split('/')[0]) || 0;
  const flowConfirmed = tvData.hasFlow || false;
  const grade = gradeStratAlert(tvData.confluence, flowConfirmed);
  const gradeLabel = grade === 'A+' ? 'GRADE  A+ -- EXECUTE IMMEDIATELY'
                   : grade === 'A'  ? 'GRADE  A  -- HIGH PRIORITY'
                   : grade === 'B'  ? 'GRADE  B  -- WAIT FOR CONFIRMATION'
                   : 'GRADE  C  -- MONITOR ONLY';

  const hasFlow = tvData.hasFlow || false;

  const lines = [
    modeLabel + ' -- ' + dteLabel + '  [' + grade + ']',
    ticker + ' $' + strike + typeLabel + ' ' + expiryFmt + ' -- ' + direction,
    '===============================',
    confluence ? 'Confluence  ' + confluence : null,
    'Grade   ' + gradeLabel,
    hasFlow ? 'STRAT + FLOW MATCH -- EXECUTE NOW at retracement' : null,
    resolved && resolved.freshness ? 'Freshness ' + resolved.freshness.label + (resolved.freshness.pctFromLow > 0 ? ' (' + resolved.freshness.pctFromLow + '% from day low)' : '') : null,
    tfLine     ? 'Bias    '     + tfLine     : null,
    '-------------------------------',
    'Strike  $' + strike + ' -- ATM via Public.com',
    'Expiry  ' + expiryFmt + ' (' + dteLabel + ')',
    (tvData.bid && tvData.ask) ? 'Bid/Ask $' + parseFloat(tvData.bid).toFixed(2) + ' / $' + parseFloat(tvData.ask).toFixed(2) : null,
    '-------------------------------',
    s ? 'Entry   $' + s.premium.toFixed(2) + ' x' + s.contracts + ' = $' + s.totalCost : 'Check live premium before entry',
    s ? 'Limit   $' + (s.premium * 0.875).toFixed(2) + ' (12.5% retrace -- SET THIS AS LIMIT)' : null,
    s ? 'Stop    $' + s.stopPrice + ' (loss -$' + s.stopLoss + ')'      : 'Stop    ' + (mode === 'DAY' ? '35' : '40') + '% of premium',
    s ? 'T1      $' + s.t1Price   + ' (profit +$' + s.t1Profit + ')'   : 'T1      +' + (mode === 'DAY' ? '35' : '60') + '% of premium',
    s ? 'T2      $' + s.t2Price   + ' (runner)'                        : 'T2      +' + (mode === 'DAY' ? '70' : '120') + '% of premium',
    s ? 'Risk    ' + s.riskPct + '% of $7K = $' + s.stopLoss + ' max' : 'Risk    2% of $7K max',
    '-------------------------------',
    ss ? 'STRUCTURAL LEVELS:' : null,
    ss ? 'Pivot      $' + ss.pivot + '  -- price ' + (ss.bias === 'BULL' ? 'ABOVE' : 'BELOW') + ' = ' + ss.bias : null,
    ss ? 'Prev High  $' + ss.prevHigh : null,
    ss ? 'Prev Low   $' + ss.prevLow : null,
    ss ? 'R1         $' + ss.r1 : null,
    ss ? 'S1         $' + ss.s1 : null,
    ss ? '-------------------------------' : null,
    ss ? 'SMART STOP:' : null,
    ss ? 'Stop Type  ' + ss.stopType + ' (' + ss.why + ')' : null,
    ss && ss.underlyingStop ? 'Underlying $' + ss.underlyingStop + '  <-- if stock hits this = EXIT' : null,
    ss ? 'Option     $' + ss.optionStop + '  <-- SET THIS AS YOUR STOP' : null,
    ss ? 'Distance   $' + ss.distance + ' from current price' : null,
    ss && !ss.approved ? 'WARNING  ' + (ss.skipReason || 'Risk too wide') : null,
    ss && ss.pivotWarn ? 'PIVOT    ' + ss.pivotWarn : null,
    ss && ss.approved ? 'Risk     $' + ss.dollarRisk + ' (' + ss.riskPct + '% of account)' : null,
    ss && ss.approved ? 'Contracts ' + ss.maxContracts + ' max (fits 2% risk)' : null,
    technicalsLines.length > 0 ? '-------------------------------' : null,
  ].concat(technicalsLines).concat([
    edgeLines.length > 0 ? '-------------------------------' : null,
  ]).concat(edgeLines).concat([
    '-------------------------------',
    mode === 'DAY' ? 'Hold    Exit same day by 3:30PM'     : 'Hold    1-3 days max',
    mode === 'DAY' ? 'Window  10AM-11:30AM | 3PM-3:30PM'  : 'Window  9:45AM-3:30PM ET',
    'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
    (function() {
      var now = new Date();
      var etOffset = -4; // ET = UTC-4 (EDT)
      var etHour = ((now.getUTCHours() + etOffset) % 24 + 24) % 24;
      var etMin  = now.getUTCMinutes();
      var etTime = etHour * 60 + etMin;
      var PRIME_END   = 11 * 60;       // 11:00AM
      var CAUTION_END = 12 * 60;       // 12:00PM
      var LATE_ENTRY  = 15 * 60 + 30; // 3:30PM
      var MARKET_OPEN =  9 * 60 + 45; // 9:45AM

      function formatTime(totalMin) {
        var h = Math.floor(totalMin / 60) % 24;
        var m = totalMin % 60;
        var ampm = h >= 12 ? 'PM' : 'AM';
        var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        return h12 + ':' + (m < 10 ? '0' : '') + m + ampm + ' ET';
      }

      if (etTime >= LATE_ENTRY || etTime < MARKET_OPEN) {
        return 'Cancel By  DO NOT ENTER -- wait for 9:45AM';
      } else if (etTime >= CAUTION_END) {
        return 'Cancel By  SKIP -- choppy afternoon, wait for tomorrow';
      } else if (etTime >= PRIME_END) {
        var cancelMin = Math.min(etTime + 60, CAUTION_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' (CAUTION -- past prime time)';
      } else {
        var cancelMin = Math.min(etTime + 90, PRIME_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' -- PRIME TIME';
      }
    })(),
  ]).filter(function(l) { return l !== null; });

  return { text: lines.join('\n'), ticker: ticker };
}

// -- STRAT ALERT --------------------------------------------------
async function sendStratAlert(opraSymbol, tvData, resolved) {
  if (!tvData)   tvData   = {};
  if (!resolved) resolved = null;
  console.log('[STRAT] Processing:', opraSymbol);

  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', 'BLOCKED\n' + calCheck.reason);
    return false;
  }

  // -- POSITION CONFLICT CHECK ----------------------------------
  const parsed0 = resolver.parseOPRA(opraSymbol);
  if (parsed0) {
    const conflict = await checkPositionConflict(parsed0.ticker, parsed0.type);
    if (conflict.conflict) {
      console.log('[CONFLICT] Blocking card -- already in ' + parsed0.ticker + ' ' + conflict.existing);
      await sendToChannel('strat',
        '\u26a0\ufe0f POSITION CONFLICT -- ' + parsed0.ticker + '\n' +
        'New signal:  ' + conflict.newSignal.toUpperCase() + '\n' +
        'Already in: ' + conflict.existing.toUpperCase() + '\n' +
        'Skipping card -- close existing position first\n' +
        'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET'
      );
      return false;
    }
  }

  // -- MACRO FILTER -- 6HR is the boss --
  if (macroFilter) {
    try {
      var macro = await macroFilter.getMacroBias();
      var blocked = macroFilter.shouldBlock(tvData.type || (opraSymbol.includes('C') ? 'call' : 'put'), macro);
      if (blocked.block) {
        console.log('[MACRO-FILTER] Blocked:', blocked.reason);
        return false;
      }
    } catch(e) { console.error('[MACRO-FILTER]', e.message); }
  }

  var ss = null;
  if (smartStops) {
    try {
      var parsedForStop = resolver.parseOPRA(opraSymbol);
      if (parsedForStop && tvData.mid) {
        ss = await smartStops.getSmartStop(
          parsedForStop.ticker,
          parsedForStop.type,
          tvData.mid,
          tvData.delta || 0.45,
          parseFloat(tvData.adx) || null,
          parseFloat(tvData.atrPct) || null
        );
      }
    } catch(e) { console.error('[STOPS] getSmartStop error:', e.message); }
  }

  let card;
  if (tvData.mode === 'SPREAD' && resolved && resolved.debit) {
    card = buildSpreadCard(resolved, tvData);
  } else {
    card = await buildStratCard(opraSymbol, tvData, resolved, ss);
  }

  if (!card) return false;
  await sendToChannel('strat', card.text, card.ticker);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (parsed) {
    const key = parsed.ticker + ':' + parsed.type;
    recentStratTickers.set(key, Date.now());
    setTimeout(function() { recentStratTickers.delete(key); }, 30 * 60 * 1000);

    const confluenceScore = parseInt((tvData.confluence || '0').split('/')[0]) || 0;
    const hasFlow = recentFlowTickers.has(key);
    const freshnessBlocked = resolved && resolved.freshness && resolved.freshness.block;
    const isConviction = !freshnessBlocked && (confluenceScore >= 5 || (confluenceScore >= 4 && hasFlow));

    if (freshnessBlocked) {
      console.log('[FRESHNESS] ' + parsed.ticker + ' blocked -- move already happened (' + resolved.freshness.pctFromLow + '% from low)');
      await sendToChannel('strat',
        '\u26a0\ufe0f MOVE ALREADY HAPPENED -- ' + parsed.ticker + '\n' +
        'Contract up ' + resolved.freshness.pctFromLow + '% from day low $' + resolved.freshness.dayLow + '\n' +
        'Skip this card -- wait for reset or next day\n' +
        'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET'
      );
    }

    const flowMatch = recentFlowTickers.has(key);
    if (isConviction) {
      var convLabel = confluenceScore >= 6 && flowMatch ? 'A+ CONVICTION TRADE -- STRAT + FLOW MATCH -- EXECUTE NOW'
                    : confluenceScore >= 6              ? 'A+ CONVICTION TRADE -- EXECUTE NOW'
                    : flowMatch                         ? 'A  CONVICTION TRADE -- STRAT + FLOW MATCH -- EXECUTE NOW'
                    : 'A  CONVICTION TRADE -- 5/6 STRAT';
      // SMART ENTRY MODE DETECTION
      // BREAKOUT: ORB/momentum/6-6/near day high -> entry at ask
      // RETRACEMENT: mid-day pullback/retest -> entry at ask x 0.875
      function getEntryMode(bars, tvData, resolved) {
        if (!resolved || !resolved.mid) return { mode: 'RETRACEMENT', entry: null };
        var ask = parseFloat(resolved.ask || resolved.mid);

        // Get current ET hour
        var now = new Date();
        var etHour = ((now.getUTCHours() - 4) + 24) % 24;
        var etMin  = now.getUTCMinutes();
        var etTime = etHour * 60 + etMin;
        var isORBWindow = etTime <= (10 * 60);       // Before 10AM ET
        var isPrimTime  = etTime <= (11 * 60);       // Before 11AM ET

        // Get day high from bars
        var dayHigh = bars && bars[0] ? parseFloat(bars[0].High || bars[0].high) : null;
        var lastPrice = parseFloat(tvData.price || resolved.last || 0);
        var pctFromHigh = dayHigh ? (dayHigh - lastPrice) / dayHigh : 1;

        // BREAKOUT conditions
        var is66          = parseInt((tvData.confluence||'0').split('/')[0]) >= 6;
        var isNearHigh    = pctFromHigh < 0.02;   // within 2% of day high
        var isMomentum    = isNearHigh && isORBWindow;
        var isF2          = tvData.strategy && (tvData.strategy.includes('F2') || tvData.strategy.includes('ORB'));

        if (is66 || (isMomentum && isPrimTime) || isF2) {
          return {
            mode:  'BREAKOUT',
            entry: parseFloat(ask.toFixed(2)),
            note:  is66 ? '6/6 -- entry at ask' : isF2 ? 'ORB/F2 -- entry at ask' : 'Momentum near day high -- entry at ask',
          };
        }

        // RETRACEMENT: wait for pullback
        return {
          mode:  'RETRACEMENT',
          entry: parseFloat((ask * 0.875).toFixed(2)),
          note:  'Mid-day pullback -- retracement entry 12.5%',
        };
      }

      // Route A+/A to #execute-now, B/C to #conviction-trades
      var stratGrade = (confluenceScore >= 5 || (confluenceScore >= 4 && flowMatch)) ? 'A' : 'B';
      if (confluenceScore >= 5 && flowMatch) stratGrade = 'A+';
      // Normalize ticker -- TradingView sends as ticker, symbol, or Ticker
      if (!tvData.ticker) tvData.ticker = tvData.symbol || tvData.Ticker || tvData.TICKER || '';
      // Route indices (SPY/QQQ/IWM) to #indices-bias, others to #execute-now
      var isIndexTicker = INDEX_TICKERS.indexOf(tvData.ticker) > -1;
      var stratChannel  = isIndexTicker ? 'indicesBias'
        : ((stratGrade === 'A+' || stratGrade === 'A') ? 'executeNow' : 'conviction');
      // Send FULL card to #strat-alerts (reference)
      // Send COMPACT card to #execute-now and #indices-bias (action)
      var isActionChannel = (stratChannel === 'executeNow' || stratChannel === 'indicesBias');

      if (isActionChannel) {
        // COMPACT 3-LINE CARD for action channels
        var cType    = (tvData.type || 'call').toUpperCase();
        var cPrice   = tvData.price || '?';
        var cDTE     = resolved && resolved.dte ? resolved.dte + 'DTE' : '?';
        var cEntry   = resolved && resolved.mid ? parseFloat(resolved.mid * 0.875).toFixed(2) : '?';
        var cStop    = resolved && resolved.stop ? resolved.stop : '?';
        var cT1      = resolved && resolved.t1 ? resolved.t1 : '?';
        var cScore   = [];
        if (flowMatch) cScore.push('Flow');
        if (tvData.h6bias) cScore.push('Bias');
        if (confluenceScore >= 5) cScore.push('5/6+');
        var cTime    = new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'});
        // EMOJI COMPACT CARD -- scannable in 2 seconds
        var gradeEmoji = stratGrade === 'A+' ? '\uD83D\uDD25' : stratGrade === 'A' ? '\u2B50' : '\uD83D\uDFE1';
        var dirEmoji   = cType === 'CALL' ? '\uD83D\uDCC8' : '\uD83D\uDCC9';
        var scoreEmoji = cScore.length >= 3 ? '\uD83C\uDFAF' : cScore.length >= 2 ? '\u2705' : '\uD83D\uDFE1';
        // Add contract score and prob ITM if available from resolver
        var contractGrade = resolved && resolved.grade ? resolved.grade : '';
        var probITM       = resolved && resolved.probITM ? resolved.probITM + '% ITM' : '';
        var contractWarn  = resolved && resolved.warnings && resolved.warnings.length
          ? '\u26A0\uFE0F ' + resolved.warnings[0] : '';
        var cLine1   = gradeEmoji + ' ' + stratGrade + (contractGrade ? '|' + contractGrade : '') + ' | ' + dirEmoji + ' ' + parsed.ticker + ' ' + cType + ' | $' + cPrice + ' | ' + cDTE;
        var cLine2   = '\uD83D\uDCB0 Entry $' + cEntry + '  \uD83D\uDED1 Stop $' + cStop + '  \uD83C\uDFAF T1 $' + cT1 + (probITM ? '  ' + probITM : '');
        var cLine3   = scoreEmoji + ' ' + (cScore.length ? cScore.join(' + ') : 'Strat only') + ' | \uD83D\uDD50 ' + cTime + ' ET' + (contractWarn ? '\n' + contractWarn : '');
        var compact  = cLine1 + '\n' + cLine2 + '\n' + cLine3;

        // PHASE 2 -- OPTION CHART EXECUTION GATE
        // Read option bar data from TradeStation directly
        // EXTENDED = blocked, recheck every 10 min
        // DISCOUNT or LOWER HALF = proceed
        var chartAnalysis = null;
        if (resolved && resolved.optionTicker && isActionChannel) {
          try {
            chartAnalysis = await optionChartReader.analyzeOptionChart(
              resolved.optionTicker,
              parsed.ticker,
              tvData.type || 'call',
              resolved.mid ? parseFloat((resolved.mid * 0.875).toFixed(2)) : null
            );
            if (chartAnalysis) {
              var rangeTag = chartAnalysis.extended   ? ' \uD83D\uDD34 EXTENDED'
                           : chartAnalysis.favorable  ? ' \uD83D\uDFE2 DISCOUNT'
                           :                            ' \uD83D\uDFE1 MID-RANGE';
              cLine3  = cLine3 + rangeTag;
              compact = cLine1 + '\n' + cLine2 + '\n' + cLine3;
            }
          } catch(ce) { console.error('[OPTION-CHART] Phase 2 error:', ce.message); }
        }

        // If contract is DEAD -- hard block, no recheck
        if (chartAnalysis && chartAnalysis.dead) {
          console.log('[OPTION-CHART] DEAD contract -- hard block:', chartAnalysis.deadReason);
          var deadCard = cLine1 + '\n' + cLine2 + '\n\u26D4 DEAD CONTRACT -- ' + chartAnalysis.deadReason + ' | ' + cTime + ' ET';
          await sendToChannel(stratChannel, deadCard, parsed.ticker);
          return true; // hard block -- no recheck, no execute
        }

        // If contract is EXTENDED -- post blocked card + arm recheck
        if (chartAnalysis && chartAnalysis.extended) {
          console.log('[OPTION-CHART] BLOCKED -- contract at', chartAnalysis.posInRange + '% of range');
          var blockedCard = cLine1 + '\n' + cLine2 + '\n\uD83D\uDD34 EXTENDED -- waiting for pullback | ' + cTime + ' ET';
          await sendToChannel(stratChannel, blockedCard, parsed.ticker);

          // Recheck every 10 min for up to 60 min
          var recheckSym   = resolved && resolved.optionTicker ? resolved.optionTicker : null;
          var recheckCount = 0;
          if (recheckSym) {
            var recheckTimer = setInterval(async function() {
              recheckCount++;
              if (recheckCount >= 6) { clearInterval(recheckTimer); return; }
              try {
                var recheck = await optionChartReader.analyzeOptionChart(recheckSym, parsed.ticker, tvData.type || 'call', null);
                if (recheck && recheck.favorable) {
                  clearInterval(recheckTimer);
                  var freshCard = cLine1 + '\n' + cLine2 + '\n\uD83D\uDFE2 Pulled back -- NOW FAVORABLE | ' +
                    new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York', hour:'2-digit', minute:'2-digit'}) + ' ET';
                  await sendToChannel(stratChannel, freshCard, parsed.ticker);
                  console.log('[OPTION-CHART] Recheck -- now favorable, fresh card posted');
                }
              } catch(re) { console.error('[OPTION-CHART] Recheck error:', re.message); }
            }, 10 * 60 * 1000);
          }
        } else {
          await sendToChannel(stratChannel, compact, parsed.ticker);
        }
      } else {
        await sendToChannel(stratChannel,
          card.text
            .replace('SWING TRADE',  convLabel)
            .replace('DAY TRADE',    convLabel)
            .replace('SPREAD TRADE', convLabel),
          card.ticker
        );
      }
      console.log('[EXECUTE-NOW] ' + parsed.ticker + ' ' + stratGrade + ' routed to #' + stratChannel);

      // AUTO-EXECUTE in SIM for A+/A grades
      // AGENT_MODE=CONVICTION_ONLY means skip auto-execute (Discord cards only)
      if (AGENT_MODE === 'CONVICTION_ONLY') {
        console.log('[AGENT] CONVICTION_ONLY mode -- Discord card sent, no auto-execute for:', normalTicker);
      } else {
      // AUTO-EXECUTE BLOCK BELOW
      // Convert OPRA symbol NVDA260406C00175000 to TS format NVDA 260406C175
      function opraToTS(opra) {
        if (!opra) return null;
        if (opra.indexOf(' ') > -1) return opra;
        var om = opra.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!om) return opra;
        var whole2  = parseInt(om[4].slice(0, 5), 10);
        var dec2    = parseInt(om[4].slice(5), 10);
        var strike2 = dec2 === 0 ? String(whole2) : String(whole2) + '.' + String(dec2).replace(/0+$/, '');
        return om[1] + ' ' + om[2] + om[3] + strike2;
      }

      // SPREAD QUALITY CHECK -- reject before dedup/execution
      if (resolved && resolved.bid !== null && resolved.ask !== null) {
        var bidAskSpread = parseFloat(resolved.ask) - parseFloat(resolved.bid);
        if (bidAskSpread > 0.20) {
          console.log('[ALERTER] SPREAD REJECTED:', resolved.symbol,
            'bid:$' + resolved.bid, 'ask:$' + resolved.ask,
            'spread:$' + bidAskSpread.toFixed(2), '-- too wide, skipping');
          return; // skip this signal entirely
        }
        console.log('[ALERTER] SPREAD CHECK PASSED:', resolved.symbol,
          'spread:$' + bidAskSpread.toFixed(2));
      }

      // NORMALIZE TICKER -- TradingView sends as ticker, symbol, or Ticker
      // Must do this FIRST before any routing decisions
      tvData.ticker = tvData.ticker || tvData.symbol || tvData.Ticker || tvData.TICKER || '';
      tvData.type   = tvData.type   || tvData.action || tvData.direction || 'call';

      // AGENT MODE -- set AGENT_MODE=FULL in Railway to re-enable auto-execute
      // Default: CONVICTION_ONLY = Discord cards only, no auto-execute from Strat alerts
      // Only John's ideas (ideaIngestor) and conviction flow will execute trades
      var AGENT_MODE = process.env.AGENT_MODE || 'CONVICTION_ONLY';

      // DEDUP CHECK -- ONE execution per ticker per direction per day
      // Normalize ticker first to avoid undefined keys
      var normalTicker = tvData.ticker || tvData.symbol || tvData.Ticker || '';
      var dedupKey = normalTicker + ':' + (tvData.type || tvData.action || 'call');
      if ((stratGrade === 'A+' || stratGrade === 'A') && resolved && resolved.mid && !executedToday[dedupKey]) {
        executedToday[dedupKey] = Date.now(); // mark immediately -- blocks ALL subsequent signals for this ticker today
        console.log('[DEDUP] Locking ticker for today:', dedupKey, '-- no more', tvData.type, 'orders on', tvData.ticker, 'until midnight');
        try {
          var orderExecutor  = require('./orderExecutor');
          var entryDecision  = getEntryMode(null, tvData, resolved);
          var ep  = parseFloat(resolved.mid);
          var lmt = entryDecision.entry || parseFloat((ep * 0.875).toFixed(2));
          var stp = parseFloat((ep * 0.60).toFixed(2));
          var t1v = parseFloat((ep * 1.60).toFixed(2));
          var qty = stratGrade === 'A+' ? 2 : 1;
          console.log('[ENTRY-MODE] ' + entryDecision.mode + ' -- ' + entryDecision.note + ' -- limit $' + lmt);
          var er  = await orderExecutor.placeOrder({
            account: 'SIM3142118M',
            symbol:  opraToTS(resolved.symbol),
            action:  'BUYTOOPEN',
            qty:     qty,
            limit:   lmt,
            stop:    stp,
            t1:      t1v,
          });
          if (er && er.success) {
            console.log('[AUTO-EXEC] SIM order placed:', resolved.symbol, 'ID:', er.orderId);
          } else {
            console.log('[AUTO-EXEC] Failed:', er && er.error);
          }
        } catch(e) { console.error('[AUTO-EXEC]', e.message); }
      }
      } // close CONVICTION_ONLY else block
    }
  }
  return true;
}

// -- FLOW ALERT ---------------------------------------------------
async function sendFlowAlert(opraSymbol, flowData) {
  if (!flowData) flowData = {};
  console.log('[FLOW] Processing:', opraSymbol);
  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return false;

  const flowConviction = scoreFlow(flowData);
  const key = parsed.ticker + ':' + parsed.type;
  recentFlowTickers.set(key, Date.now());
  setTimeout(function() { recentFlowTickers.delete(key); }, 30 * 60 * 1000);

  const price   = await resolver.getPrice(parsed.ticker);
  const premium = parseFloat(flowData.totalPremium || 0);
  const premiumStr = premium >= 1000000
    ? '$' + (premium/1000000).toFixed(1) + 'M'
    : '$' + (premium/1000).toFixed(0) + 'K';

  const lines = [
    'FLOW ALERT -- ' + parsed.ticker + ' ' + parsed.type.toUpperCase(),
    parsed.ticker + ' $' + parsed.strike + (parsed.type === 'call' ? 'C' : 'P') + ' ' + parsed.expiry.slice(5).replace('-', '/'),
    price ? 'Stock   $' + price + ' LIVE' : null,
    '===============================',
    'Flow    ' + flowConviction.label,
  ].concat(flowConviction.flags.map(function(f) { return '        ' + f; })).concat([
    '-------------------------------',
    'Premium ' + premiumStr,
    'Type    ' + (flowData.orderType || 'UNKNOWN').toUpperCase(),
    flowData.alertName ? 'Alert   ' + flowData.alertName : null,
    '-------------------------------',
    'Watch for Strat confirmation',
    'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
    (function() {
      var now = new Date();
      var etOffset = -4; // ET = UTC-4 (EDT)
      var etHour = ((now.getUTCHours() + etOffset) % 24 + 24) % 24;
      var etMin  = now.getUTCMinutes();
      var etTime = etHour * 60 + etMin;
      var PRIME_END   = 11 * 60;       // 11:00AM
      var CAUTION_END = 12 * 60;       // 12:00PM
      var LATE_ENTRY  = 15 * 60 + 30; // 3:30PM
      var MARKET_OPEN =  9 * 60 + 45; // 9:45AM

      function formatTime(totalMin) {
        var h = Math.floor(totalMin / 60) % 24;
        var m = totalMin % 60;
        var ampm = h >= 12 ? 'PM' : 'AM';
        var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        return h12 + ':' + (m < 10 ? '0' : '') + m + ampm + ' ET';
      }

      if (etTime >= LATE_ENTRY || etTime < MARKET_OPEN) {
        return 'Cancel By  DO NOT ENTER -- wait for 9:45AM';
      } else if (etTime >= CAUTION_END) {
        return 'Cancel By  SKIP -- choppy afternoon, wait for tomorrow';
      } else if (etTime >= PRIME_END) {
        var cancelMin = Math.min(etTime + 60, CAUTION_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' (CAUTION -- past prime time)';
      } else {
        var cancelMin = Math.min(etTime + 90, PRIME_END);
        return 'Cancel By  ' + formatTime(cancelMin) + ' -- PRIME TIME';
      }
    })(),
  ]).filter(function(l) { return l !== null; });

  await sendToChannel('flow', lines.join('\n'), parsed.ticker);

  if (flowConviction.isHighConviction && recentStratTickers.has(key)) {
    const res2 = await resolver.resolveContract(parsed.ticker, parsed.type, 'SWING');
    if (res2) {
      const card = (res2.mode === 'SPREAD' && res2.debit)
        ? buildSpreadCard(res2, {})
        : buildStratCard(res2.symbol, { mid: res2.mid, bid: res2.bid, ask: res2.ask, mode: res2.mode, dte: res2.dte }, res2);
      if (card) {
        // AUTO-EXECUTE in SIM -- fires after conviction card posts
      if (resolved && resolved.mid && (grade === 'A+' || grade === 'A')) {
        try {
          var orderExecutor = require('./orderExecutor');
          var execPremium = parseFloat(resolved.mid);
          var execLimit   = parseFloat((execPremium * 0.875).toFixed(2));
          var execStop    = parseFloat((execPremium * 0.60).toFixed(2));
          var execT1      = parseFloat((execPremium * 1.60).toFixed(2));
          var execQty     = (confluenceScore >= 5 && flowMatch) ? 2 : 1;
          var execResult  = await orderExecutor.placeOrder({
            account: 'SIM3142118M',
            symbol:  opraToTS(resolved.symbol),
            action:  'BUYTOOPEN',
            qty:     execQty,
            limit:   execLimit,
            stop:    execStop,
            t1:      execT1,
          });
          if (execResult && execResult.success) {
            console.log('[AUTO-EXEC] SIM order placed:', resolved.symbol, 'ID:', execResult.orderId);
          } else {
            console.log('[AUTO-EXEC] Failed:', execResult && execResult.error);
          }
        } catch(e) { console.error('[AUTO-EXEC]', e.message); }
      }

      // Route A+/A to #execute-now, everything else to #conviction-trades
      var isIdxTicker    = INDEX_TICKERS.indexOf(parsed.ticker) > -1;
      var targetChannel  = isIdxTicker ? 'indicesBias'
        : ((grade === 'A+' || grade === 'A') ? 'executeNow' : 'conviction');
      await sendToChannel(targetChannel,
          card.text.replace('SWING TRADE', 'CONVICTION TRADE'),
          card.ticker
        );
      }
    }
  }
  return true;
}

// -- MAIN WRAPPER -------------------------------------------------
async function sendTradeAlert(opraSymbol, tvData, flowData, isStratSignal, resolved) {
  if (!tvData)        tvData        = {};
  if (!flowData)      flowData      = {};
  if (!isStratSignal) isStratSignal = false;
  if (!resolved)      resolved      = null;
  if (isStratSignal)  return sendStratAlert(opraSymbol, tvData, resolved);
  return sendFlowAlert(opraSymbol, flowData);
}

// -- MORNING BRIEF ------------------------------------------------
async function sendMorningBrief() {
  console.log('[BRIEF] Building morning brief...');
  const dateStr   = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const spyPrice  = await resolver.getPrice('SPY');
  const uvxyPrice = await resolver.getPrice('UVXY');
  const spyLine   = spyPrice  ? 'SPY  $' + spyPrice + ' LIVE' : 'SPY  -- unavailable';
  const vixLevel  = uvxyPrice
    ? parseFloat(uvxyPrice) >= 30 ? 'EXTREME -- reduce size'
    : parseFloat(uvxyPrice) >= 20 ? 'ELEVATED -- be careful'
    : 'NORMAL' : '';
  const vixLine = uvxyPrice ? 'UVXY $' + uvxyPrice + ' ' + vixLevel : 'VIX  -- unavailable';

  const lines = [
    '\ud83d\udcca STRATUM MORNING BRIEF v6.1',
    dateStr,
    '===============================',
    '\ud83d\udcc8 ' + spyLine,
    '   \u27a1\ufe0f  Wait for 9:45AM to settle',
    '-------------------------------',
    '\ud83d\ude28 ' + vixLine,
    '-------------------------------',
    '\u26a1 DAY    0-1DTE  $0.30-$1.50  T1:+35%  risk $120',
    '\ud83d\udcc8 SWING  5-7DTE  $0.50-$3.00  T1:+60%  risk $140',
    '\ud83d\udcca SPREAD 5-7DTE  $0.50-$1.50  T1:+100% risk $150',
    '-------------------------------',
    'RULES:',
    '6/6 confluence -- execute immediately',
    '5/6 confluence -- wait for flow confirmation',
    'Flow high conviction -- execute swing or spread card',
    'Flow + Strat same ticker -- conviction trade',
    '-------------------------------',
    '\u23f0 Entry window: 9:45AM - 3:30PM ET',
    '\ud83d\udeab No entries after 3:30PM',
    '\ud83d\udeab No 0DTE entries after 2PM',
    '-------------------------------',
    '\ud83d\udcca #strat-alerts      -- Chart setups',
    '\ud83c\udf0a #flow-alerts       -- Unusual flow',
    '\ud83d\udc51 #conviction-trades -- Execute',
  ];

  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent OK');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', 'STRATUM\n' + msg);
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow };
