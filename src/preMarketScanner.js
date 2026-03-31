// preMarketScanner.js - Stratum Flow Scout v7.2
// Scans for AYCE 3 strategies + oil tickers
// 12HR Miyagi, 4HR Re-Trigger, 3-2-2 First Live
// Posts setup cards to Discord #strat-alerts at 9:15AM ET

var fetch = require(‘node-fetch’);

var STRAT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
var CONV_WEBHOOK  = process.env.DISCORD_CONVICTION_WEBHOOK_URL;

// – SCAN TICKERS ————————————————
// Core indices + tech + oil tickers
var SCAN_TICKERS = [
‘QQQ’, ‘SPY’, ‘IWM’,
‘NVDA’, ‘TSLA’, ‘META’, ‘AAPL’, ‘AMZN’, ‘MSFT’, ‘GOOGL’,
‘USO’, ‘XOM’, ‘OXY’, ‘CVX’, ‘COP’, ‘MRO’,
‘SCO’, ‘UCO’, ‘XLE’, ‘OIH’,
];

// – CANDLE TYPE DETECTION —————————————
function getCandleType(candle, prev) {
if (!candle || !prev) return ‘unknown’;
var high = parseFloat(candle.High);
var low  = parseFloat(candle.Low);
var ph   = parseFloat(prev.High);
var pl   = parseFloat(prev.Low);
if (high > ph && low < pl)  return ‘3’;
if (high <= ph && low >= pl) return ‘1’;
if (high > ph && low >= pl) return ‘2U’;
if (low < pl && high <= ph)  return ‘2D’;
return ‘unknown’;
}

// – GET BARS FROM TRADESTATION API —————————–
async function getBars(symbol, unit, interval, barsback) {
try {
var ts    = require(’./tradestation’);
var token = await ts.getAccessToken();
if (!token) { console.log(’[SCANNER] No TS token’); return []; }
var url = ‘https://api.tradestation.com/v3/marketdata/barcharts/’ + symbol
+ ‘?interval=’ + interval
+ ‘&unit=’ + unit
+ ‘&barsback=’ + (barsback || 10)
+ ‘&sessiontemplate=USEQPreAndPost’;
var res  = await fetch(url, { headers: { ‘Authorization’: ‘Bearer ’ + token } });
if (!res.ok) return [];
var data = await res.json();
return (data && data.Bars) ? data.Bars : [];
} catch(e) { console.error(’[SCANNER] getBars error:’, e.message); return []; }
}

// – POST TO DISCORD —————————————––
async function postCard(webhookUrl, message, username) {
if (!webhookUrl) return;
try {
await fetch(webhookUrl, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ content: ‘`\n' + message + '\n`’, username: username || ‘Stratum Scanner’ })
});
} catch(e) { console.error(’[SCANNER] Discord error:’, e.message); }
}

// ================================================================
// STRATEGY 1: 12HR MIYAGI (1-3-1)
// ================================================================
async function scanMiyagi(symbol) {
try {
var bars = await getBars(symbol, ‘Minute’, ‘720’, 10);
if (bars.length < 5) return null;
var b4 = bars[bars.length - 1];
var b3 = bars[bars.length - 2];
var b2 = bars[bars.length - 3];
var b1 = bars[bars.length - 4];
var b0 = bars[bars.length - 5];
var type1 = getCandleType(b1, b0);
var type2 = getCandleType(b2, b1);
var type3 = getCandleType(b3, b2);
var type4 = getCandleType(b4, b3);
if (type1 !== ‘1’ || type2 !== ‘3’ || type3 !== ‘1’) return null;
if (type4 !== ‘2U’ && type4 !== ‘2D’) return null;
if (parseFloat(b4.High) > parseFloat(b3.High) && parseFloat(b4.Low) < parseFloat(b3.Low)) return null;
var trigger   = parseFloat(((parseFloat(b3.High) + parseFloat(b3.Low)) / 2).toFixed(2));
var t1        = type4 === ‘2D’ ? parseFloat(b3.High).toFixed(2) : parseFloat(b3.Low).toFixed(2);
var t2        = type4 === ‘2D’ ? parseFloat(b2.High).toFixed(2) : parseFloat(b2.Low).toFixed(2);
var direction = type4 === ‘2D’ ? ‘CALLS’ : ‘PUTS’;
return { strategy: ‘12HR MIYAGI’, symbol: symbol, direction: direction,
trigger: trigger, t1: t1, t2: t2, current: parseFloat(b4.Close), type4: type4, valid: true };
} catch(e) { return null; }
}

// ================================================================
// STRATEGY 2: 4HR RE-TRIGGER (2-2 REV)
// ================================================================
async function scan4HRRetrigger(symbol) {
try {
var bars = await getBars(symbol, ‘Minute’, ‘240’, 10);
if (bars.length < 3) return null;
var bAM8  = bars[bars.length - 1];
var bAM4  = bars[bars.length - 2];
var bPrev = bars[bars.length - 3];
var type4AM = getCandleType(bAM4, bPrev);
var type8AM = getCandleType(bAM8, bAM4);
if (type4AM === ‘2D’ && type8AM === ‘2U’) {
var entry = parseFloat(bAM4.High).toFixed(2);
var stop  = parseFloat(bAM4.Low).toFixed(2);
if (parseFloat(bAM8.Close) > parseFloat(entry)) return null;
return { strategy: ‘4HR RE-TRIGGER’, symbol: symbol, direction: ‘CALLS’,
entryLevel: entry, stopLevel: stop, current: parseFloat(bAM8.Close), valid: true };
}
if (type4AM === ‘2U’ && type8AM === ‘2D’) {
var entry2 = parseFloat(bAM4.Low).toFixed(2);
var stop2  = parseFloat(bAM4.High).toFixed(2);
if (parseFloat(bAM8.Close) < parseFloat(entry2)) return null;
return { strategy: ‘4HR RE-TRIGGER’, symbol: symbol, direction: ‘PUTS’,
entryLevel: entry2, stopLevel: stop2, current: parseFloat(bAM8.Close), valid: true };
}
return null;
} catch(e) { return null; }
}

// ================================================================
// STRATEGY 3: 3-2-2 FIRST LIVE (1HR)
// ================================================================
async function scan322(symbol) {
try {
var bars = await getBars(symbol, ‘Minute’, ‘60’, 6);
if (bars.length < 4) return null;
var b10AM = bars[bars.length - 1];
var b9AM  = bars[bars.length - 2];
var b8AM  = bars[bars.length - 3];
var bPrev = bars[bars.length - 4];
var type8AM = getCandleType(b8AM, bPrev);
var type9AM = getCandleType(b9AM, b8AM);
if (type8AM !== ‘3’) return null;
if (type9AM === ‘2D’) {
return { strategy: ‘3-2-2 FIRST LIVE’, symbol: symbol, direction: ‘CALLS’,
entryLevel: parseFloat(b9AM.High).toFixed(2),
stopLevel:  parseFloat(b9AM.Low).toFixed(2),
target:     parseFloat(b8AM.High).toFixed(2),
current:    parseFloat(b10AM.Close), valid: true };
}
if (type9AM === ‘2U’) {
return { strategy: ‘3-2-2 FIRST LIVE’, symbol: symbol, direction: ‘PUTS’,
entryLevel: parseFloat(b9AM.Low).toFixed(2),
stopLevel:  parseFloat(b9AM.High).toFixed(2),
target:     parseFloat(b8AM.Low).toFixed(2),
current:    parseFloat(b10AM.Close), valid: true };
}
return null;
} catch(e) { return null; }
}

// ================================================================
// BUILD SETUP CARD
// ================================================================
function buildSetupCard(setup) {
if (!setup || !setup.valid) return null;
var time = new Date().toLocaleTimeString(‘en-US’, { timeZone: ‘America/New_York’, hour: ‘2-digit’, minute: ‘2-digit’ });
var lines2 = [];
if (setup.strategy === ‘12HR MIYAGI’) {
lines2.push(‘12HR MIYAGI – ’ + setup.symbol + ’ ’ + setup.direction);
lines2.push(‘Pattern: 1-3-1 Confirmed’);
lines2.push(’===============================’);
lines2.push(‘Trigger    $’ + setup.trigger + ’  <– ENTRY (50% of Candle 3)’);
lines2.push(‘T1         $’ + setup.t1 + ’  (Candle 3 high/low)’);
lines2.push(‘T2         $’ + setup.t2 + ’  (Candle 2 outside bar)’);
lines2.push(‘Current    $’ + setup.current);
lines2.push(’—————————––’);
lines2.push(‘Entry      Price hits trigger at open’);
lines2.push(‘Exit       60-min flip = immediate exit’);
lines2.push(‘Candle 4   ’ + setup.type4 + ’ confirmed’);
}
if (setup.strategy === ‘4HR RE-TRIGGER’) {
lines2.push(‘4HR RE-TRIGGER – ’ + setup.symbol + ’ ’ + setup.direction);
lines2.push(‘Pattern: 2-2 Reversal Confirmed’);
lines2.push(’===============================’);
lines2.push(‘Entry      $’ + setup.entryLevel + ’  <– Break of 4AM candle’);
lines2.push(‘Stop       $’ + setup.stopLevel);
lines2.push(‘Current    $’ + setup.current);
lines2.push(’—————————––’);
lines2.push(‘Be ready – may trigger immediately at 9:30AM bell’);
lines2.push(‘Exit       60-min flip = immediate exit’);
}
if (setup.strategy === ‘3-2-2 FIRST LIVE’) {
lines2.push(‘3-2-2 FIRST LIVE – ’ + setup.symbol + ’ ’ + setup.direction);
lines2.push(‘Pattern: 3-2-2 Reversal Confirmed’);
lines2.push(’===============================’);
lines2.push(‘Entry      $’ + setup.entryLevel + ’  <– Break of 9AM candle’);
lines2.push(‘Stop       $’ + setup.stopLevel + ’  (60-min flip)’);
lines2.push(‘Target     $’ + setup.target + ’  (8AM outside bar)’);
lines2.push(‘Current    $’ + setup.current);
lines2.push(’—————————––’);
lines2.push(‘Execute at 10AM session’);
lines2.push(‘Exit       60-min flip = immediate exit’);
}
lines2.push(‘Time       ’ + time + ’ ET’);
return lines2.join(’\n’);
}

// ================================================================
// MAIN SCANNER – runs at 9:15AM ET
// ================================================================
async function runPreMarketScan() {
console.log(’[SCANNER] Running pre-market scan for ’ + SCAN_TICKERS.length + ’ tickers…’);
var setups = [];
for (var i = 0; i < SCAN_TICKERS.length; i++) {
var ticker  = SCAN_TICKERS[i];
var miyagi  = await scanMiyagi(ticker);
var retrig  = await scan4HRRetrigger(ticker);
if (miyagi) setups.push(miyagi);
if (retrig) setups.push(retrig);
}
var date = new Date().toLocaleDateString(‘en-US’, { timeZone: ‘America/New_York’, weekday: ‘long’, month: ‘short’, day: ‘numeric’ });
if (setups.length === 0) {
var msg = ‘PRE-MARKET SCAN – ’ + date + ‘\n===============================\nNo AYCE setups detected today\nWatch for Strat alerts at open’;
await postCard(STRAT_WEBHOOK, msg, ‘Stratum Scanner’);
console.log(’[SCANNER] No setups found’);
return;
}
var header = ‘PRE-MARKET SETUP REPORT – ’ + date + ‘\n’ + setups.length + ’ AYCE setup(s) detected’;
await postCard(STRAT_WEBHOOK, header, ‘Stratum Scanner’);
for (var j = 0; j < setups.length; j++) {
var card = buildSetupCard(setups[j]);
if (card) {
await postCard(STRAT_WEBHOOK, card, ‘Stratum Scanner’);
if (setups[j].strategy === ‘12HR MIYAGI’) {
await postCard(CONV_WEBHOOK, card, ‘Stratum Scanner’);
}
}
}
console.log(’[SCANNER] ’ + setups.length + ’ setup(s) posted’);
}

// 3-2-2 scanner runs at 10AM after 9AM candle closes
async function run322Scan() {
console.log(’[322 SCAN] Running 10AM check…’);
for (var i = 0; i < SCAN_TICKERS.length; i++) {
var setup = await scan322(SCAN_TICKERS[i]);
if (setup) {
var card = buildSetupCard(setup);
if (card) await postCard(STRAT_WEBHOOK, card, ‘Stratum Scanner’);
}
}
}

module.exports = { runPreMarketScan: runPreMarketScan, run322Scan: run322Scan };
  }
}

module.exports = { runPreMarketScan: runPreMarketScan, run322Scan: run322Scan };
