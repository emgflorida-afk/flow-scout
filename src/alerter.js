// alerter.js - Stratum Flow Scout v6.1
// FULL EDGE: Time guardrails, spread warning, GEX, Max Pain, OI nodes, IV context
// TECHNICALS: RSI(14) + VWAP from TradingView webhook payload
// CHART: Finviz daily chart auto-attached to every alert
// THREE MODE SYSTEM: DAY / SWING / SPREAD
// -----------------------------------------------------------------

const fetch    = require('node-fetch');
const resolver = require('./contractResolver');
const calendar = require('./economicCalendar');

const WEBHOOKS = {
  strat:      process.env.DISCORD_WEBHOOK_URL,
  flow:       process.env.DISCORD_FLOW_WEBHOOK_URL,
  conviction: process.env.DISCORD_CONVICTION_WEBHOOK_URL,
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


// -- MARGIN STOCK CARD -------------------------------------------
// Used for leveraged ETFs and high-conviction stocks
// No theta decay -- hold overnight safely without PDT risk
// ATR-based stop placement for wider breathing room
// PDT rule: do NOT open and close same day -- hold overnight
function buildMarginStockCard(ticker, price, direction, tvData, atr) {
  if (!price || !ticker) return null;
  atr = atr || price * 0.02; // default 2% ATR if not provided

  var isBull    = direction === 'BULL' || direction === 'call';
  var dirLabel  = isBull ? 'BULLISH' : 'BEARISH';
  var action    = isBull ? 'BUY' : 'SELL SHORT';

  // Position sizing based on $7K account with 2:1 margin = $14K buying power
  // Risk 1.5% of account = $105 per trade
  var riskDollars  = 105;
  var stopDist     = parseFloat((atr * 1.5).toFixed(2));  // 1.5x ATR stop
  var shares       = Math.floor(riskDollars / stopDist);
  shares           = Math.max(1, Math.min(shares, 100));  // cap at 100 shares

  var stopPrice    = isBull
    ? parseFloat((price - stopDist).toFixed(2))
    : parseFloat((price + stopDist).toFixed(2));
  var t1Price      = isBull
    ? parseFloat((price + stopDist * 2).toFixed(2))   // 2:1 R/R
    : parseFloat((price - stopDist * 2).toFixed(2));
  var t2Price      = isBull
    ? parseFloat((price + stopDist * 4).toFixed(2))   // 4:1 runner
    : parseFloat((price - stopDist * 4).toFixed(2));

  var totalCost    = parseFloat((shares * price).toFixed(2));
  var riskAmt      = parseFloat((shares * stopDist).toFixed(2));
  var t1Profit     = parseFloat((shares * stopDist * 2).toFixed(2));

  var confluence   = tvData ? (tvData.confluence || '') : '';
  var adxVal       = tvData ? (tvData.adx ? parseFloat(tvData.adx) : 0) : 0;
  var volRatio     = tvData ? (tvData.volRatio ? parseFloat(tvData.volRatio) : null) : null;

  var lines = [
    'MARGIN STOCK TRADE',
    ticker + ' -- ' + dirLabel,
    '===============================',
    confluence ? 'Confluence  ' + confluence : null,
    '-------------------------------',
    'Price   $' + price,
    action + '  ' + shares + ' shares = $' + totalCost,
    'Stop    $' + stopPrice + ' (-$' + riskAmt + ')',
    'T1      $' + t1Price + ' (profit +$' + t1Profit + ')',
    'T2      $' + t2Price + ' (runner)',
    'Risk    $' + riskAmt + ' max (1.5% of $7K)',
    '-------------------------------',
    'NO THETA -- hold overnight safely',
    'PDT     Do NOT close same day -- swing only',
    adxVal > 30 ? 'Regime  HIGH VOL (ADX ' + adxVal.toFixed(0) + ') -- trending hard' : null,
    volRatio && volRatio >= 2 ? 'Volume  ' + volRatio.toFixed(1) + 'x avg -- high conviction' : null,
    '-------------------------------',
    'Hold    1-3 days minimum',
    'Window  9:45AM-3:30PM ET entry only',
    'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
  ].filter(function(l) { return l !== null; });

  return { text: lines.join('\n'), ticker: ticker };
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

  if (rsi != null && !isNaN(rsi)) {
    lines.push('RSI (14)    ' + rsi.toFixed(0) + ' -- ' + getRsiLabel(rsi));
  }
  if (vwap != null && !isNaN(vwap) && vwapBias) {
    const biasIcon = vwapBias === 'above' ? 'ABOVE \ud83d\udd3c bullish' : 'BELOW \ud83d\udd3d bearish';
    lines.push('VWAP        $' + vwap.toFixed(2) + ' -- price ' + biasIcon + ' confirmed');
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
  ]).filter(function(l) { return l !== null; });

  return { text: lines.join('\n'), ticker: ticker };
}

// -- BUILD STRAT CARD ---------------------------------------------
function buildStratCard(opraSymbol, tvData, resolved) {
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

  const lines = [
    modeLabel + ' -- ' + dteLabel,
    ticker + ' $' + strike + typeLabel + ' ' + expiryFmt + ' -- ' + direction,
    '===============================',
    confluence ? 'Confluence  ' + confluence : null,
    tfLine     ? 'Bias    '     + tfLine     : null,
    '-------------------------------',
    'Strike  $' + strike + ' -- ATM via Public.com',
    'Expiry  ' + expiryFmt + ' (' + dteLabel + ')',
    (tvData.bid && tvData.ask) ? 'Bid/Ask $' + parseFloat(tvData.bid).toFixed(2) + ' / $' + parseFloat(tvData.ask).toFixed(2) : null,
    '-------------------------------',
    s ? 'Entry   $' + s.premium.toFixed(2) + ' x' + s.contracts + ' = $' + s.totalCost : 'Check live premium before entry',
    s ? 'Stop    $' + s.stopPrice + ' (loss -$' + s.stopLoss + ')'      : 'Stop    ' + (mode === 'DAY' ? '35' : '40') + '% of premium',
    s ? 'T1      $' + s.t1Price   + ' (profit +$' + s.t1Profit + ')'   : 'T1      +' + (mode === 'DAY' ? '35' : '60') + '% of premium',
    s ? 'T2      $' + s.t2Price   + ' (runner)'                        : 'T2      +' + (mode === 'DAY' ? '70' : '120') + '% of premium',
    s ? 'Risk    ' + s.riskPct + '% of $7K = $' + s.stopLoss + ' max' : 'Risk    2% of $7K max',
    technicalsLines.length > 0 ? '-------------------------------' : null,
  ].concat(technicalsLines).concat([
    edgeLines.length > 0 ? '-------------------------------' : null,
  ]).concat(edgeLines).concat([
    '-------------------------------',
    mode === 'DAY' ? 'Hold    Exit same day by 3:30PM'     : 'Hold    1-3 days max',
    mode === 'DAY' ? 'Window  10AM-11:30AM | 3PM-3:30PM'  : 'Window  9:45AM-3:30PM ET',
    'Time    ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET',
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

  // Check if this is a leveraged ETF -- use margin stock card instead
  var parsedForStock  = resolver.parseOPRA(opraSymbol);
  var stockTicker     = parsedForStock ? parsedForStock.ticker : null;
  var leveragedETFs   = ['TQQQ','SQQQ','SPXL','SPXS','TNA','TZA','XLF','XLE','XLK','ARKK'];
  var isLeveragedETF  = stockTicker && leveragedETFs.indexOf(stockTicker) >= 0;

  let card;
  if (isLeveragedETF && resolved && resolved.price) {
    // Generate BOTH a margin stock card AND an options card
    var direction    = (tvData.type === 'put' || tvData.action === 'BEAR') ? 'BEAR' : 'BULL';
    var stockCard    = buildMarginStockCard(stockTicker, resolved.price, direction, tvData, null);
    if (stockCard) {
      await sendToChannel('strat', '[MARGIN STOCK OPTION]\n' + stockCard.text, stockCard.ticker);
    }
    card = buildStratCard(opraSymbol, tvData, resolved);
  } else if (tvData.mode === 'SPREAD' && resolved && resolved.debit) {
    card = buildSpreadCard(resolved, tvData);
  } else {
    card = buildStratCard(opraSymbol, tvData, resolved);
  }

  if (!card) return false;
  await sendToChannel('strat', card.text, card.ticker);

  const parsed = resolver.parseOPRA(opraSymbol);
  if (parsed) {
    const key = parsed.ticker + ':' + parsed.type;
    recentStratTickers.set(key, Date.now());
    setTimeout(function() { recentStratTickers.delete(key); }, 30 * 60 * 1000);
    if (recentFlowTickers.has(key)) {
      await sendToChannel('conviction',
        card.text
          .replace('SPREAD TRADE',  'CONVICTION SPREAD')
          .replace('SWING TRADE',   'CONVICTION TRADE')
          .replace('DAY TRADE',     'CONVICTION TRADE'),
        card.ticker
      );
      console.log('[CONVICTION] Both signals on ' + parsed.ticker + ' OK');
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
  ]).filter(function(l) { return l !== null; });

  await sendToChannel('flow', lines.join('\n'), parsed.ticker);

  if (flowConviction.isHighConviction && recentStratTickers.has(key)) {
    const res2 = await resolver.resolveContract(parsed.ticker, parsed.type, 'SWING');
    if (res2) {
      const card = (res2.mode === 'SPREAD' && res2.debit)
        ? buildSpreadCard(res2, {})
        : buildStratCard(res2.symbol, { mid: res2.mid, bid: res2.bid, ask: res2.ask, mode: res2.mode, dte: res2.dte }, res2);
      if (card) {
        await sendToChannel('conviction',
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
