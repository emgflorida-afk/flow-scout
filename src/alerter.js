// alerter.js - Stratum Flow Scout v6.2
// STRAT ALERTS NOW AUTO-EXECUTE IN SIM -- no flow confirmation needed
// Flow alerts remain independent track
// -----------------------------------------------------------------

const fetch             = require('node-fetch');
const optionChartReader = require('./optionChartReader');
const lvlFramework      = require('./lvlFramework');

var etTime = null;
try { etTime = require('./etTime'); } catch(e) {}

// DISCORD CHANNELS
var INDICES_WEBHOOK = process.env.DISCORD_INDICES_WEBHOOK ||
  'https://discord.com/api/webhooks/1489297759248056513/U9w2yLf7qr3skwZuu6-mwMpVcB5Y1HQtLx5ulNQvugcWARG1HGagsoxUhrnX_f_GHsk5';
var INDEX_TICKERS = ['SPY', 'QQQ', 'IWM'];

// DEDUP TRACKER -- prevents duplicate auto-executions same ticker same day
var executedToday = {};
setInterval(function() {
  var now    = new Date();
  var _et = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24 }; var etHour = _et.hour;
  if (etHour === 0) { executedToday = {}; console.log('[DEDUP] Reset for new day'); }
}, 60 * 60 * 1000);

const resolver  = require('./contractResolver');
const calendar  = require('./economicCalendar');
let smartStops  = null;
let macroFilter = null;
let executeNow  = null;
let holdLock    = null;
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
  var expClose = new Date(expiryDateStr + 'T16:00:00');
  var etNowStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  var etNow = new Date(etNowStr);
  return Math.max(0, Math.ceil((expClose - etNow) / (1000 * 60 * 60 * 24)));
}

function getRsiLabel(rsi) {
  if (rsi == null || isNaN(rsi)) return '--';
  if (rsi > 70) return 'overbought ⚠️';
  if (rsi < 30) return 'oversold ⚠️';
  if (rsi > 55) return 'bullish momentum';
  if (rsi < 45) return 'room to fall ✅';
  return 'neutral';
}

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
    lines.push('FVG Below   $' + bullFVGBottom.toFixed(2) + '-$' + bullFVGTop.toFixed(2) + ' -- target magnet ✅');
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
  if (score >= 5) return 'A';
  if (score >= 4) return 'B';
  return 'C';
}

// -- POSITION CONFLICT CHECK --------------------------------------
var cachedPositions    = null;
var positionCacheTime  = 0;

async function getOpenPositions() {
  try {
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
    lines.push('⚠️ WIDE SPREAD -- $' + sw + ' wide -- risky fill, limit at mid only');
  }
  if (resolved.dte === 0) {
    const now    = new Date();
    var _et2 = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24 }; const etHour = _et2.hour;
    if (etHour >= 14) lines.push('🚫 0DTE after 2PM -- DO NOT ENTER');
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
    if (ivCtx.recommendSpreads) lines.push('💡 High IV -- consider spread instead of naked');
  }
  return lines;
}

// -- OPRA TO TS FORMAT --------------------------------------------
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

// -- FORMAT TIME HELPER -------------------------------------------
function formatTime(totalMin) {
  var h = Math.floor(totalMin / 60) % 24;
  var m = totalMin % 60;
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  return h12 + ':' + (m < 10 ? '0' : '') + m + ampm + ' ET';
}

// -- CANCEL BY LINE -----------------------------------------------
function buildCancelByLine() {
  var now = new Date();
  var _et3 = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et3.hour; var etMin = _et3.min;
  var etTime = etHour * 60 + etMin;
  var PRIME_END   = 11 * 60;
  var CAUTION_END = 12 * 60;
  var LATE_ENTRY  = 15 * 60 + 30;
  var MARKET_OPEN =  9 * 60 + 45;
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
}

// -- IS WITHIN TRADING HOURS --------------------------------------
function isWithinTradingHours() {
  var now = new Date();
  var _et4 = etTime ? etTime.getETTime(now) : { hour: ((now.getUTCHours() - 4) + 24) % 24, min: now.getUTCMinutes(), total: 0 }; var etHour = _et4.hour; var etMin = _et4.min;
  var etTime = etHour * 60 + etMin;
  return etTime >= (9 * 60 + 45) && etTime <= (15 * 60 + 30);
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
    buildCancelByLine(),
  ]).filter(function(l) { return l !== null; });
  return { text: lines.join('\n'), ticker: ticker };
}

// -- BUILD STRAT CARD ---------------------------------------------
async function buildStratCard(opraSymbol, tvData, resolved, ss) {
  if (!tvData)   tvData   = {};
  if (!resolved) resolved = null;
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
  const flowConfirmed   = tvData.hasFlow || false;
  const grade           = gradeStratAlert(tvData.confluence, flowConfirmed);
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
    s ? 'Stop    $' + s.stopPrice + ' (loss -$' + s.stopLoss + ')'    : 'Stop    ' + (mode === 'DAY' ? '35' : '40') + '% of premium',
    s ? 'T1      $' + s.t1Price   + ' (profit +$' + s.t1Profit + ')' : 'T1      +' + (mode === 'DAY' ? '35' : '60') + '% of premium',
    s ? 'T2      $' + s.t2Price   + ' (runner)'                      : 'T2      +' + (mode === 'DAY' ? '70' : '120') + '% of premium',
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
    buildCancelByLine(),
  ]).filter(function(l) { return l !== null; });
  return { text: lines.join('\n'), ticker: ticker };
}

// ================================================================
// -- STRAT ALERT -- PURE TA FROM TRADINGVIEW -- EXECUTES IN SIM --
// ================================================================
async function sendStratAlert(opraSymbol, tvData, resolved) {
  if (!tvData)   tvData   = {};
  if (!resolved) resolved = null;
  console.log('[STRAT] Processing:', opraSymbol);

  // CALENDAR CHECK
  const calCheck = await calendar.shouldBlockAlert();
  if (calCheck.block) {
    await sendToChannel('strat', 'BLOCKED\n' + calCheck.reason);
    return false;
  }

  // POSITION CONFLICT CHECK
  const parsed0 = resolver.parseOPRA(opraSymbol);
  if (parsed0) {
    const conflict = await checkPositionConflict(parsed0.ticker, parsed0.type);
    if (conflict.conflict) {
      console.log('[CONFLICT] Blocking card -- already in ' + parsed0.ticker + ' ' + conflict.existing);
      await sendToChannel('strat',
        '⚠️ POSITION CONFLICT -- ' + parsed0.ticker + '\n' +
        'New signal:  ' + conflict.newSignal.toUpperCase() + '\n' +
        'Already in: ' + conflict.existing.toUpperCase() + '\n' +
        'Skipping card -- close existing position first\n' +
        'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET'
      );
      return false;
    }
  }

  // MACRO FILTER
  if (macroFilter) {
    try {
      var macro   = await macroFilter.getMacroBias();
      var blocked = macroFilter.shouldBlock(tvData.type || (opraSymbol.includes('C') ? 'call' : 'put'), macro);
      if (blocked.block) {
        console.log('[MACRO-FILTER] Blocked:', blocked.reason);
        return false;
      }
    } catch(e) { console.error('[MACRO-FILTER]', e.message); }
  }

  // TRADING HOURS CHECK
  if (!isWithinTradingHours()) {
    console.log('[STRAT] Outside trading hours -- skipping execution');
    return false;
  }

  // SMART STOPS
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

  // BUILD CARD
  let card;
  if (tvData.mode === 'SPREAD' && resolved && resolved.debit) {
    card = buildSpreadCard(resolved, tvData);
  } else {
    card = await buildStratCard(opraSymbol, tvData, resolved, ss);
  }
  if (!card) return false;

  // POST FULL CARD TO #strat-alerts
  await sendToChannel('strat', card.text, card.ticker);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (!parsed) return true;

  const key = parsed.ticker + ':' + parsed.type;
  recentStratTickers.set(key, Date.now());
  setTimeout(function() { recentStratTickers.delete(key); }, 30 * 60 * 1000);

  const confluenceScore = parseInt((tvData.confluence || '0').split('/')[0]) || 0;
  const flowMatch       = recentFlowTickers.has(key);

  // FRESHNESS CHECK
  const freshnessBlocked = resolved && resolved.freshness && resolved.freshness.block;
  if (freshnessBlocked) {
    console.log('[FRESHNESS] ' + parsed.ticker + ' blocked -- move already happened');
    await sendToChannel('strat',
      '⚠️ MOVE ALREADY HAPPENED -- ' + parsed.ticker + '\n' +
      'Contract up ' + resolved.freshness.pctFromLow + '% from day low $' + resolved.freshness.dayLow + '\n' +
      'Skip this card -- wait for reset or next day\n' +
      'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET'
    );
    return true;
  }

  // GEXR DIRECTION GATE
  var gexrDir    = global.gexrDirection || null;
  var signalType = (tvData.type || parsed.type || '').toLowerCase();
  if (gexrDir) {
    var gexrBlock = false;
    if (gexrDir === 'above' && signalType === 'put')  gexrBlock = true;
    if (gexrDir === 'below' && signalType === 'call') gexrBlock = true;
    if (gexrBlock) {
      console.log('[GEXR] BLOCKED', parsed.ticker, signalType.toUpperCase(), '-- GEXR is', gexrDir.toUpperCase());
      return true;
    }
    console.log('[GEXR] PASSED', parsed.ticker, signalType.toUpperCase());
  }

  // NORMALIZE
  tvData.ticker = tvData.ticker || tvData.symbol || tvData.Ticker || tvData.TICKER || parsed.ticker;
  tvData.type   = tvData.type   || tvData.action || tvData.direction || parsed.type || 'call';

  // DEDUP CHECK
  var dedupKey = tvData.ticker + ':' + tvData.type;
  if (executedToday[dedupKey]) {
    console.log('[DEDUP] Already executed today:', dedupKey, '-- skipping');
    return true;
  }

  // GRADE
  var stratGrade = 'C';
  if (confluenceScore >= 6 && flowMatch) stratGrade = 'A+';
  else if (confluenceScore >= 6)         stratGrade = 'A+';
  else if (confluenceScore >= 5)         stratGrade = 'A';
  else if (confluenceScore >= 4)         stratGrade = 'B';

  // BUILD COMPACT EMOJI CARD
  var cType   = tvData.type.toUpperCase();
  var cPrice  = resolved && resolved.strike ? resolved.strike : (tvData.price || '?');
  var cDTE    = resolved && resolved.dte ? resolved.dte + 'DTE' : '?';
  var cMid    = resolved && resolved.mid ? parseFloat(resolved.mid) : null;
  var cEntry  = cMid ? parseFloat((cMid * 0.875).toFixed(2)) : '?';
  var cStop   = cMid ? parseFloat((cMid * 0.60).toFixed(2))  : '?';
  var cT1     = cMid ? parseFloat((cMid * 1.60).toFixed(2))  : '?';
  var cScore  = [];
  if (flowMatch)          cScore.push('Flow');
  if (tvData.h6bias)      cScore.push('Bias');
  if (confluenceScore >= 5) cScore.push(confluenceScore + '/6');
  var cTime   = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  var gradeEmoji = stratGrade === 'A+' ? '🔥' : stratGrade === 'A' ? '⭐' : '🟡';
  var dirEmoji   = cType === 'CALL' ? '📈' : '📉';
  var scoreEmoji = cScore.length >= 2 ? '🎯' : '✅';

  var contractGrade = resolved && resolved.grade   ? resolved.grade   : '';
  var probITM       = resolved && resolved.probITM ? resolved.probITM + '% ITM' : '';
  var contractWarn  = resolved && resolved.warnings && resolved.warnings.length ? '⚠️ ' + resolved.warnings[0] : '';

  var cLine1 = gradeEmoji + ' ' + stratGrade + (contractGrade ? '|' + contractGrade : '') + ' | ' + dirEmoji + ' ' + parsed.ticker + ' ' + cType + ' | $' + cPrice + ' | ' + cDTE;
  var cLine2 = '💰 Entry $' + cEntry + '  🛑 Stop $' + cStop + '  🎯 T1 $' + cT1 + (probITM ? '  ' + probITM : '');
  var cLine2ct = cMid ? '📋 2-CT METHOD: Trim 1 @ $' + parseFloat((cMid * 1.25).toFixed(2)) + ' | Runner stop @ $' + cMid.toFixed(2) + ' (breakeven)' : '';
  var cLine3 = scoreEmoji + ' ' + (cScore.length ? cScore.join(' + ') : 'Pure Strat TA') + ' | 🕐 ' + cTime + ' ET' + (contractWarn ? '\n' + contractWarn : '');
  var compact = cLine1 + '\n' + cLine2 + (cLine2ct ? '\n' + cLine2ct : '') + '\n' + cLine3;

  // ROUTE: indices to #indices-bias, all others to #execute-now
  var isIndexTicker = INDEX_TICKERS.indexOf(parsed.ticker) > -1;
  var stratChannel  = isIndexTicker ? 'indicesBias' : 'executeNow';

  // OPTION CHART CHECK (EXTENDED / DEAD / DISCOUNT)
  var chartAnalysis = null;
  if (resolved && resolved.optionTicker) {
    try {
      chartAnalysis = await optionChartReader.analyzeOptionChart(
        resolved.optionTicker,
        parsed.ticker,
        tvData.type || 'call',
        cEntry || null
      );
      if (chartAnalysis) {
        var rangeTag = chartAnalysis.extended  ? ' 🔴 EXTENDED'
                     : chartAnalysis.favorable ? ' 🟢 DISCOUNT'
                     :                           ' 🟡 MID-RANGE';
        cLine3  = cLine3 + rangeTag;
        compact = cLine1 + '\n' + cLine2 + '\n' + cLine3;
      }
    } catch(ce) { console.error('[OPTION-CHART] Phase 2 error:', ce.message); }
  }

  // DEAD CONTRACT -- hard block
  if (chartAnalysis && chartAnalysis.dead) {
    console.log('[OPTION-CHART] DEAD contract -- hard block:', chartAnalysis.deadReason);
    var deadCard = cLine1 + '\n' + cLine2 + '\n⛔ DEAD CONTRACT -- ' + chartAnalysis.deadReason + ' | ' + cTime + ' ET';
    await sendToChannel(stratChannel, deadCard, parsed.ticker);
    return true;
  }

  // EXTENDED -- post blocked card + recheck
  if (chartAnalysis && chartAnalysis.extended) {
    console.log('[OPTION-CHART] BLOCKED -- contract at', chartAnalysis.posInRange + '% of range');
    var blockedCard = cLine1 + '\n' + cLine2 + '\n🔴 EXTENDED -- waiting for pullback | ' + cTime + ' ET';
    await sendToChannel(stratChannel, blockedCard, parsed.ticker);
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
            var freshCard = cLine1 + '\n' + cLine2 + '\n🟢 Pulled back -- NOW FAVORABLE | ' +
              new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET';
            await sendToChannel(stratChannel, freshCard, parsed.ticker);
            // AUTO-EXECUTE after pullback confirmation
            await autoExecuteStratSIM(parsed, resolved, tvData, stratGrade, dedupKey);
          }
        } catch(re) { console.error('[OPTION-CHART] Recheck error:', re.message); }
      }, 10 * 60 * 1000);
    }
    return true;
  }

  // ✅ ALL CHECKS PASSED -- POST COMPACT CARD TO #execute-now
  // 2-CT METHOD fields
  var alertTrimTarget  = cMid ? parseFloat((cMid * 1.25).toFixed(2)) : null;
  var alertRunnerStop  = cMid ? cMid : null;

  storeAlert({
    ticker: parsed.ticker, type: cType, grade: stratGrade,
    strike: resolved && resolved.strike ? resolved.strike : null,
    expiry: resolved && resolved.expiry ? resolved.expiry : null,
    dte: resolved && resolved.dte ? resolved.dte : null,
    entry: cEntry, stop: cStop, t1: cT1,
    probITM: probITM, mid: cMid,
    trimTarget: alertTrimTarget, runnerStop: alertRunnerStop,
    contracts: 2,
    compact: compact, time: new Date().toISOString(),
  });
  await sendToChannel(stratChannel, compact, parsed.ticker);
  console.log('[STRAT] Card posted to #' + stratChannel + ' -- ' + parsed.ticker + ' ' + stratGrade);

  // ✅ AUTO-EXECUTE IN SIM -- STRAT ALERTS ARE PURE TA, NO FLOW NEEDED
  await autoExecuteStratSIM(parsed, resolved, tvData, stratGrade, dedupKey);

  return true;
}

// -- AUTO EXECUTE STRAT IN SIM ------------------------------------
async function autoExecuteStratSIM(parsed, resolved, tvData, stratGrade, dedupKey) {
  if (!resolved || !resolved.mid) {
    console.log('[AUTO-EXEC] No resolved contract/mid -- skipping SIM order for', parsed.ticker);
    return;
  }

  try {
    // ============================================
    // RUN ALL GATES BEFORE EXECUTING
    // ============================================
    var execGates = require('./executeNow');
    var orderExecutor = require('./orderExecutor');

    // Build signal for gate check
    var signal = {
      ticker: parsed.ticker,
      type: parsed.type,
      confluence: tvData.confluence || parsed.confluence || '0/6',
      close: resolved.price || null,
    };

    // Get current positions (full list, not just count) for duplicate check
    var positions = [];
    try {
      var ts = require('./tradestation');
      var token = await ts.getAccessToken();
      if (token) {
        var posRes = await fetch('https://sim-api.tradestation.com/v3/brokerage/accounts/SIM3142118M/positions', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var posData = await posRes.json();
        positions = posData.Positions || [];
      }
    } catch(e) { console.log('[AUTO-EXEC] Position check error:', e.message); }

    // Get buying power
    var buyingPower = 6000;
    try {
      var ts2 = require('./tradestation');
      var token2 = await ts2.getAccessToken();
      if (token2) {
        var balRes = await fetch('https://sim-api.tradestation.com/v3/brokerage/accounts/SIM3142118M/balances', {
          headers: { 'Authorization': 'Bearer ' + token2 }
        });
        var balData = await balRes.json();
        var bals = balData.Balances || [balData];
        if (bals[0]) buyingPower = parseFloat(bals[0].BuyingPower || bals[0].CashBalance || 6000);
      }
    } catch(e) { console.log('[AUTO-EXEC] Balance check error:', e.message); }

    // Get macro bias
    var macroBias = 'NEUTRAL';
    var h6Bias = 'NEUTRAL';
    try {
      var dynBias = require('./dynamicBias');
      if (dynBias.getBias) {
        var b = dynBias.getBias();
        macroBias = b.macro || 'NEUTRAL';
        h6Bias = b.h6 || 'NEUTRAL';
      }
    } catch(e) {}

    var hasFlow = false; // Strat-only signal, no flow confirmation

    // Run all 10 gates
    var decision = await execGates.shouldExecute(signal, macroBias, h6Bias, hasFlow, positions, buyingPower);

    if (!decision.execute) {
      console.log('[AUTO-EXEC] ❌ GATES BLOCKED: ' + parsed.ticker + ' -- ' + decision.reason);
      return;
    }

    console.log('[AUTO-EXEC] ✅ GATES PASSED: ' + parsed.ticker + ' ' + decision.grade);

    // Lock dedup after gates pass
    executedToday[dedupKey] = Date.now();

    var ep   = parseFloat(resolved.mid);

    // Stop at -25% like John's method (was structural/flat 40%)
    // -25% is tight enough to limit losses but wide enough to not get shaken out
    var stp  = parseFloat((ep * 0.75).toFixed(2));

    // T1: minimum 50% target -- hold for REAL gains, not pennies
    // Primo's community makes 100-300% per trade. 50% is conservative.
    var t1Pct = 0.50; // 50% minimum target on ALL tickers
    var t1v  = parseFloat((ep * (1 + t1Pct)).toFixed(2));

    // Enter at ask, not 12.5% retrace -- retrace limits never fill
    var lmt  = resolved.ask ? parseFloat(resolved.ask.toFixed(2)) : parseFloat((ep * 1.02).toFixed(2));
    var qty  = decision.contracts;

    // Final premium check
    if (ep > 2.40) {
      console.log('[AUTO-EXEC] Premium $' + ep + ' over $2.40 max -- skipping', parsed.ticker);
      return;
    }

    // 2-CONTRACT METHOD -- always buy 2, trim 1 at +25%, leave runner
    qty = 2;
    // Only reduce to 1 if premium is too high for 2 contracts within account limits
    if (ep > 1.20) { qty = 1; }

    // 2-CT trim and runner targets
    var trimTarget  = parseFloat((ep * 1.25).toFixed(2));  // Trim 1 contract at +25%
    var runnerStop  = ep;                                   // Runner stop at breakeven (entry price)

    var er = await orderExecutor.placeOrder({
      account: 'SIM3142118M',
      symbol:  opraToTS(resolved.symbol),
      action:  'BUYTOOPEN',
      qty:     qty,
      limit:   lmt,
      stop:    stp,
      t1:      t1v,
    });

    if (er && er.success) {
      console.log('[AUTO-EXEC] ✅ SIM order placed:', resolved.symbol, 'ID:', er.orderId, 'qty:', qty, 'limit:$' + lmt);
      // Post execution confirmation to #execute-now
      var execWebhook = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
        'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';
      var twoCtLine = qty >= 2
        ? '\n📋 2-CT METHOD: Trim 1 @ $' + trimTarget.toFixed(2) + ' | Runner stop @ $' + runnerStop.toFixed(2) + ' (breakeven)'
        : '';
      var execCard = '✅ SIM ORDER PLACED -- ' + parsed.ticker + '\n' +
        parsed.ticker + ' ' + parsed.type.toUpperCase() + ' x' + qty + ' @ $' + lmt + ' limit\n' +
        '🛑 Stop $' + stp + '  🎯 T1 $' + t1v + twoCtLine + '\n' +
        'Order ID: ' + er.orderId + ' | Pure Strat TA | ' +
        new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET';
      await fetch(execWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '```\n' + execCard + '\n```', username: 'Stratum' }),
      }).catch(function(e) { console.error('[AUTO-EXEC] Discord post error:', e.message); });
    } else {
      console.log('[AUTO-EXEC] ❌ Failed:', er && er.error);
    }
  } catch(e) {
    console.error('[AUTO-EXEC] Error:', e.message);
  }
}

// -- FLOW ALERT -- INDEPENDENT TRACK ------------------------------
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
    buildCancelByLine(),
  ]).filter(function(l) { return l !== null; });

  await sendToChannel('flow', lines.join('\n'), parsed.ticker);

  // If high conviction flow AND strat already fired for same ticker = conviction trade
  if (flowConviction.isHighConviction && recentStratTickers.has(key)) {
    console.log('[FLOW] HIGH CONVICTION + Strat match for', parsed.ticker, '-- routing to #conviction-trades');
    const res2 = await resolver.resolveContract(parsed.ticker, parsed.type, 'SWING');
    if (res2) {
      const card2 = (res2.mode === 'SPREAD' && res2.debit)
        ? buildSpreadCard(res2, {})
        : await buildStratCard(res2.symbol, { mid: res2.mid, bid: res2.bid, ask: res2.ask, mode: res2.mode, dte: res2.dte }, res2, null);
      if (card2) {
        await sendToChannel('conviction',
          card2.text.replace('SWING TRADE', 'CONVICTION TRADE -- FLOW + STRAT MATCH'),
          card2.ticker
        );
        // Also execute in SIM for conviction-grade flow+strat combo
        var convDedupKey = parsed.ticker + ':' + parsed.type + ':flow';
        if (!executedToday[convDedupKey] && res2.mid && parseFloat(res2.mid) <= 2.40) {
          await autoExecuteStratSIM(parsed, res2, {}, 'A+', convDedupKey);
        }
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
    '📊 STRATUM MORNING BRIEF v6.2',
    dateStr,
    '===============================',
    '📈 ' + spyLine,
    '   ➡️  Wait for 9:45AM to settle',
    '-------------------------------',
    '😨 ' + vixLine,
    '-------------------------------',
    '⚡ STRAT ALERTS -- Auto-execute in SIM (pure TA)',
    '🌊 FLOW ALERTS  -- Posts to #flow-alerts',
    '👑 CONVICTION   -- Flow + Strat same ticker',
    '-------------------------------',
    'RULES:',
    'Any Strat alert (3-2-2, ORB, etc) -- SIM auto-executes',
    'Flow high conviction -- posts to #flow-alerts',
    'Flow + Strat match -- conviction trade',
    '-------------------------------',
    '⏰ Entry window: 9:45AM - 3:30PM ET',
    '🚫 No entries after 3:30PM',
    '🚫 No 0DTE entries after 2PM',
    '-------------------------------',
    '📊 #strat-alerts      -- Chart setups + auto-SIM',
    '🌊 #flow-alerts       -- Unusual flow',
    '👑 #conviction-trades -- Flow + Strat match',
    '⚡ #execute-now       -- Compact action cards',
  ];
  await sendToChannel('strat', lines.join('\n'));
  console.log('[BRIEF] Sent OK');
  return true;
}

async function sendSystemMessage(msg) {
  await sendToChannel('strat', 'STRATUM\n' + msg);
}

// -- ALERT STORE for API access ----------------------------------
var _recentAlerts = [];
var MAX_STORED_ALERTS = 50;

function storeAlert(alert) {
  _recentAlerts.unshift(alert);
  if (_recentAlerts.length > MAX_STORED_ALERTS) _recentAlerts.length = MAX_STORED_ALERTS;
}

function getRecentAlerts(count) {
  return _recentAlerts.slice(0, count || 20);
}

function clearAlerts() {
  _recentAlerts = [];
}

// ===================================================================
// SCANNER ALERT — Dual: Discord embed + Mac system notification
// Used by scheduled task scanners to alert AB even during active sessions
// ===================================================================
async function scannerAlert(title, message, tier) {
  tier = tier || 'INFO';
  var emoji = tier === 'A-TIER' ? '🔥' : tier === 'B-TIER' ? '⚡' : tier === 'HEALTH' ? '💊' : tier === 'PRIMO' ? '🎯' : 'ℹ️';

  // 1. MAC SYSTEM NOTIFICATION — pops up even if Claude Code is mid-conversation
  try {
    var { execSync } = require('child_process');
    var safeTitle = (emoji + ' ' + title).replace(/'/g, '').replace(/"/g, '');
    var safeMsg = message.replace(/'/g, '').replace(/"/g, '').substring(0, 200);
    execSync("osascript -e 'display notification \"" + safeMsg + "\" with title \"" + safeTitle + "\" sound name \"Glass\"'");
    console.log('[SCANNER ALERT] Mac notification: ' + title);
  } catch(e) {
    console.log('[SCANNER ALERT] Mac notify failed:', e.message);
  }

  // 2. DISCORD EMBED — persistent, can check phone
  try {
    var color = tier === 'A-TIER' ? 0xFF4500 : tier === 'B-TIER' ? 0xFFA500 : tier === 'HEALTH' ? 0x00FF00 : tier === 'PRIMO' ? 0x9B59B6 : 0x808080;
    var webhook = INDICES_WEBHOOK; // use the indices channel for scanner alerts
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: emoji + ' ' + title,
          description: message.substring(0, 2000),
          color: color,
          timestamp: new Date().toISOString(),
          footer: { text: 'Flow Scout Scanner | ' + tier }
        }]
      }),
    });
    console.log('[SCANNER ALERT] Discord sent: ' + title);
  } catch(e) {
    console.log('[SCANNER ALERT] Discord failed:', e.message);
  }

  // Also store in recent alerts
  storeAlert({ title: title, message: message, tier: tier, time: new Date().toISOString() });
}

module.exports = { sendTradeAlert, sendMorningBrief, sendSystemMessage, sendDiscordRaw, scoreFlow, storeAlert, getRecentAlerts, clearAlerts, scannerAlert };
