// preMarketScanner.js - Stratum Flow Scout v7.2
// Scans for AYCE's 3 strategies before market open
// 12HR Miyagi (1-3-1), 4HR Re-Trigger (2-2 Rev), 3-2-2 First Live
// Posts setup cards to Discord #strat-alerts at 9:15AM ET
// Requires TradeStation API for extended hours candle data

var fetch = require('node-fetch');

var STRAT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
var CONV_WEBHOOK  = process.env.DISCORD_CONVICTION_WEBHOOK_URL;

// -- CANDLE TYPE DETECTION ----------------------------------------
function getCandleType(candle, prev) {
  if (!candle || !prev) return 'unknown';
  var high = parseFloat(candle.High);
  var low  = parseFloat(candle.Low);
  var ph   = parseFloat(prev.High);
  var pl   = parseFloat(prev.Low);
  if (high > ph && low < pl) return '3';   // outside bar
  if (high <= ph && low >= pl) return '1'; // inside bar
  if (high > ph && low >= pl) return '2U'; // 2 up
  if (low < pl && high <= ph) return '2D'; // 2 down
  return 'unknown';
}

function isBullish(candle) { return parseFloat(candle.Close) > parseFloat(candle.Open); }
function isBearish(candle) { return parseFloat(candle.Close) < parseFloat(candle.Open); }

// -- GET BARS FROM TRADESTATION API --------------------------------
async function getBars(symbol, unit, interval, barsback, sessiontemplate) {
  try {
    var ts = require('./tradestation');
    var token = await ts.getAccessToken();
    if (!token) { console.log('[SCANNER] No TS token -- skipping'); return []; }

    var sess = sessiontemplate || 'USEQPreAndPost';
    var url  = 'https://api.tradestation.com/v3/marketdata/barcharts/' + symbol
      + '?interval=' + interval
      + '&unit=' + unit
      + '&barsback=' + (barsback || 10)
      + '&sessiontemplate=' + sess;

    var res  = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) { console.error('[SCANNER] Bars error:', res.status); return []; }
    var data = await res.json();
    var bars = data && data.Bars ? data.Bars : [];
    console.log('[SCANNER] Got ' + bars.length + ' ' + unit + ' bars for ' + symbol);
    return bars;
  } catch(e) { console.error('[SCANNER] getBars error:', e.message); return []; }
}

// -- POST TO DISCORD -----------------------------------------------
async function postToDiscord(webhookUrl, message, username) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + message + '\n```', username: username || 'Stratum Scanner' })
    });
  } catch(e) { console.error('[SCANNER] Discord error:', e.message); }
}

// ================================================================
// STRATEGY 1: 12HR MIYAGI (1-3-1)
// Candle 1: 4PM Inside(1) -> Candle 2: 4AM Outside(3)
// Candle 3: 4PM Inside(1) -> Candle 4: 4AM Live (must be 2UP or 2DOWN)
// Entry at 50% of Candle 3 when Candle 4 is 2-candle
// ================================================================
async function scanMiyagi(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '720', 10, 'USEQPreAndPost'); // 720 min = 12HR
    if (bars.length < 4) { console.log('[MIYAGI] Not enough bars for ' + symbol); return null; }

    // Most recent bars -- newest last
    var b4 = bars[bars.length - 1]; // Candle 4 (live 4AM)
    var b3 = bars[bars.length - 2]; // Candle 3 (4PM inside)
    var b2 = bars[bars.length - 3]; // Candle 2 (4AM outside)
    var b1 = bars[bars.length - 4]; // Candle 1 (4PM inside)

    var type1 = getCandleType(b1, bars[bars.length - 5] || b1);
    var type2 = getCandleType(b2, b1);
    var type3 = getCandleType(b3, b2);
    var type4 = getCandleType(b4, b3);

    console.log('[MIYAGI] ' + symbol + ' types: ' + type1 + ' ' + type2 + ' ' + type3 + ' ' + type4);

    // Check 1-3-1 sequence
    if (type1 !== '1' || type2 !== '3' || type3 !== '1') {
      console.log('[MIYAGI] ' + symbol + ' -- no 1-3-1 sequence');
      return null;
    }

    // Candle 4 must be 2UP or 2DOWN
    if (type4 !== '2U' && type4 !== '2D') {
      console.log('[MIYAGI] ' + symbol + ' -- Candle 4 is not a 2 candle (' + type4 + ')');
      return null;
    }

    // 50% trigger of Candle 3
    var trigger = parseFloat(((parseFloat(b3.High) + parseFloat(b3.Low)) / 2).toFixed(2));
    var t1      = type4 === '2D' ? parseFloat(b3.High).toFixed(2) : parseFloat(b3.Low).toFixed(2);
    var t2      = type4 === '2D' ? parseFloat(b2.High).toFixed(2) : parseFloat(b2.Low).toFixed(2);
    var direction = type4 === '2D' ? 'CALLS' : 'PUTS';
    var current   = parseFloat(b4.Close);

    // Invalidation check: Candle 3 must not have become an outside bar
    if (parseFloat(b4.High) > parseFloat(b3.High) && parseFloat(b4.Low) < parseFloat(b3.Low)) {
      console.log('[MIYAGI] ' + symbol + ' -- INVALIDATED: Candle 3 became outside bar');
      return null;
    }

    return {
      strategy:  '12HR MIYAGI',
      symbol:    symbol,
      direction: direction,
      trigger:   trigger,
      t1:        t1,
      t2:        t2,
      current:   current,
      type4:     type4,
      valid:     true,
    };
  } catch(e) { console.error('[MIYAGI] Error:', e.message); return null; }
}

// ================================================================
// STRATEGY 2: 4HR RE-TRIGGER (2-2 REV)
// 4AM 4H candle = 2DOWN -> 8AM 4H candle = 2UP -> CALLS at 4AM high
// 4AM 4H candle = 2UP   -> 8AM 4H candle = 2DOWN -> PUTS at 4AM low
// ================================================================
async function scan4HRRetrigger(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '240', 10, 'USEQPreAndPost'); // 240 min = 4HR
    if (bars.length < 3) { console.log('[4HR] Not enough bars for ' + symbol); return null; }

    var bAM8  = bars[bars.length - 1]; // 8AM candle (most recent)
    var bAM4  = bars[bars.length - 2]; // 4AM candle
    var bPrev = bars[bars.length - 3]; // previous candle

    var type4AM = getCandleType(bAM4, bPrev);
    var type8AM = getCandleType(bAM8, bAM4);

    console.log('[4HR] ' + symbol + ' 4AM:' + type4AM + ' 8AM:' + type8AM);

    // CALLS setup: 4AM=2DOWN, 8AM=2UP
    if (type4AM === '2D' && type8AM === '2U') {
      var entryLevel = parseFloat(bAM4.High).toFixed(2);
      var stopLevel  = parseFloat(bAM4.Low).toFixed(2);
      var current    = parseFloat(bAM8.Close);

      // Valid: price still below 4AM high at 9:30AM
      if (current > parseFloat(entryLevel)) {
        console.log('[4HR] ' + symbol + ' -- CALLS but price already above entry');
        return null;
      }

      return { strategy: '4HR RE-TRIGGER', symbol: symbol, direction: 'CALLS',
               entryLevel: entryLevel, stopLevel: stopLevel, current: current,
               type4AM: type4AM, type8AM: type8AM, valid: true };
    }

    // PUTS setup: 4AM=2UP, 8AM=2DOWN
    if (type4AM === '2U' && type8AM === '2D') {
      var entryLevel = parseFloat(bAM4.Low).toFixed(2);
      var stopLevel  = parseFloat(bAM4.High).toFixed(2);
      var current    = parseFloat(bAM8.Close);

      if (current < parseFloat(entryLevel)) {
        console.log('[4HR] ' + symbol + ' -- PUTS but price already below entry');
        return null;
      }

      return { strategy: '4HR RE-TRIGGER', symbol: symbol, direction: 'PUTS',
               entryLevel: entryLevel, stopLevel: stopLevel, current: current,
               type4AM: type4AM, type8AM: type8AM, valid: true };
    }

    console.log('[4HR] ' + symbol + ' -- no valid setup');
    return null;
  } catch(e) { console.error('[4HR] Error:', e.message); return null; }
}

// ================================================================
// STRATEGY 3: 3-2-2 FIRST LIVE (1HR)
// 8AM = 3 bar, 9AM = 2DOWN -> CALLS on break above 9AM high at 10AM
// 8AM = 3 bar, 9AM = 2UP   -> PUTS on break below 9AM low at 10AM
// ================================================================
async function scan322(symbol) {
  try {
    var bars = await getBars(symbol, 'Minute', '60', 6, 'USEQPreAndPost'); // 60 min = 1HR
    if (bars.length < 3) { console.log('[322] Not enough bars for ' + symbol); return null; }

    var b10AM = bars[bars.length - 1]; // 10AM (current/live)
    var b9AM  = bars[bars.length - 2]; // 9AM
    var b8AM  = bars[bars.length - 3]; // 8AM
    var bPrev = bars[bars.length - 4]; // 7AM

    var type8AM = getCandleType(b8AM, bPrev);
    var type9AM = getCandleType(b9AM, b8AM);

    console.log('[322] ' + symbol + ' 8AM:' + type8AM + ' 9AM:' + type9AM);

    if (type8AM !== '3') { console.log('[322] ' + symbol + ' -- 8AM not a 3 bar'); return null; }

    // CALLS: 9AM=2DOWN -> enter CALLS on break above 9AM high
    if (type9AM === '2D') {
      return { strategy: '3-2-2 FIRST LIVE', symbol: symbol, direction: 'CALLS',
               entryLevel: parseFloat(b9AM.High).toFixed(2),
               stopLevel:  parseFloat(b9AM.Low).toFixed(2),
               target:     parseFloat(b8AM.High).toFixed(2),
               current:    parseFloat(b10AM.Close),
               type8AM: type8AM, type9AM: type9AM, valid: true };
    }

    // PUTS: 9AM=2UP -> enter PUTS on break below 9AM low
    if (type9AM === '2U') {
      return { strategy: '3-2-2 FIRST LIVE', symbol: symbol, direction: 'PUTS',
               entryLevel: parseFloat(b9AM.Low).toFixed(2),
               stopLevel:  parseFloat(b9AM.High).toFixed(2),
               target:     parseFloat(b8AM.Low).toFixed(2),
               current:    parseFloat(b10AM.Close),
               type8AM: type8AM, type9AM: type9AM, valid: true };
    }

    console.log('[322] ' + symbol + ' -- no valid setup');
    return null;
  } catch(e) { console.error('[322] Error:', e.message); return null; }
}

// ================================================================
// BUILD SETUP CARD
// ================================================================
function buildSetupCard(setup) {
  if (!setup || !setup.valid) return null;

  var lines = [];
  var time  = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

  if (setup.strategy === '12HR MIYAGI') {
    lines.push('12HR MIYAGI SETUP -- ' + setup.symbol);
    lines.push('Pattern: 1-3-1 Confirmed');
    lines.push('===============================');
    lines.push('Direction  ' + setup.direction);
    lines.push('-------------------------------');
    lines.push('Trigger    $' + setup.trigger + '  <-- ENTRY LEVEL (50% of Candle 3)');
    lines.push('T1         $' + setup.t1 + '  (High/Low of Candle 3)');
    lines.push('T2         $' + setup.t2 + '  (High/Low of Candle 2 outside)');
    lines.push('Current    $' + setup.current);
    lines.push('-------------------------------');
    lines.push('Entry      Price hits trigger at market open');
    lines.push('Exit       60-min flip = immediate exit');
    lines.push('-------------------------------');
    lines.push('Candle 4:  ' + setup.type4 + ' confirmed');
    lines.push('Time       ' + time + ' ET');
  }

  if (setup.strategy === '4HR RE-TRIGGER') {
    lines.push('4HR RE-TRIGGER SETUP -- ' + setup.symbol);
    lines.push('Pattern: 2-2 Rev (' + setup.type4AM + ' -> ' + setup.type8AM + ')');
    lines.push('===============================');
    lines.push('Direction  ' + setup.direction);
    lines.push('-------------------------------');
    lines.push('Entry      $' + setup.entryLevel + '  <-- Break of 4AM candle');
    lines.push('Stop       $' + setup.stopLevel);
    lines.push('Current    $' + setup.current);
    lines.push('-------------------------------');
    lines.push('Be ready at 9:30AM -- may trigger immediately at bell');
    lines.push('Exit       60-min flip = immediate exit');
    lines.push('Time       ' + time + ' ET');
  }

  if (setup.strategy === '3-2-2 FIRST LIVE') {
    lines.push('3-2-2 FIRST LIVE SETUP -- ' + setup.symbol);
    lines.push('Pattern: 3-2-2 Rev (' + setup.type8AM + '-' + setup.type9AM + ')');
    lines.push('===============================');
    lines.push('Direction  ' + setup.direction);
    lines.push('-------------------------------');
    lines.push('Entry      $' + setup.entryLevel + '  <-- Break of 9AM candle');
    lines.push('Stop       $' + setup.stopLevel + '  (60-min flip)');
    lines.push('Target     $' + setup.target + '  (8AM outside bar)');
    lines.push('Current    $' + setup.current);
    lines.push('-------------------------------');
    lines.push('Execute at 10AM session');
    lines.push('Exit       60-min flip = immediate exit');
    lines.push('Time       ' + time + ' ET');
  }

  return lines.join('\n');
}

// ================================================================
// MAIN SCANNER -- runs at 9:15AM ET
// Scans core tickers for all 3 setups
// ================================================================
var SCAN_TICKERS = ['QQQ', 'SPY', 'NVDA', 'TSLA', 'META', 'AAPL', 'AMZN', 'MSFT'];

async function runPreMarketScan() {
  console.log('[SCANNER] Running pre-market scan...');

  var setups = [];

  for (var i = 0; i < SCAN_TICKERS.length; i++) {
    var ticker = SCAN_TICKERS[i];

    // Scan all 3 strategies
    var miyagi  = await scanMiyagi(ticker);
    var retrig  = await scan4HRRetrigger(ticker);
    var s322    = await scan322(ticker);

    if (miyagi)  setups.push(miyagi);
    if (retrig)  setups.push(retrig);
    if (s322)    setups.push(s322);
  }

  if (setups.length === 0) {
    console.log('[SCANNER] No AYCE setups found today');
    var noSetup = 'PRE-MARKET SCAN COMPLETE\n===============================\nNo AYCE setups detected today\nWatch for Strat alerts at open\nTime  ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) + ' ET';
    await postToDiscord(STRAT_WEBHOOK, noSetup, 'Stratum Scanner');
    return;
  }

  console.log('[SCANNER] Found ' + setups.length + ' setups');

  // Post header
  var dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  var header  = 'PRE-MARKET SETUP REPORT -- ' + dateStr + '\n' + setups.length + ' AYCE setup(s) detected -- review before open';
  await postToDiscord(STRAT_WEBHOOK, header, 'Stratum Scanner');

  // Post each setup card
  for (var j = 0; j < setups.length; j++) {
    var card = buildSetupCard(setups[j]);
    if (card) {
      await postToDiscord(STRAT_WEBHOOK, card, 'Stratum Scanner');
      // High conviction setups also go to #conviction-trades
      if (setups[j].strategy === '12HR MIYAGI') {
        await postToDiscord(CONV_WEBHOOK, card, 'Stratum Scanner');
      }
    }
  }

  console.log('[SCANNER] Pre-market scan complete -- ' + setups.length + ' setup(s) posted');
}

// 322 scanner runs again at 10AM after 9AM candle closes
async function run322Scan() {
  console.log('[322 SCAN] Running 10AM 3-2-2 check...');
  for (var i = 0; i < SCAN_TICKERS.length; i++) {
    var setup = await scan322(SCAN_TICKERS[i]);
    if (setup) {
      var card = buildSetupCard(setup);
      if (card) await postToDiscord(STRAT_WEBHOOK, card, 'Stratum Scanner');
    }
  }
}

module.exports = { runPreMarketScan: runPreMarketScan, run322Scan: run322Scan };