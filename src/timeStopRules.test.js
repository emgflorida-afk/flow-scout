// =============================================================================
// PHASE 4.26 — Test scenarios for timeStopRules module
//
// Run: node src/timeStopRules.test.js
// =============================================================================

var tsr = require('./timeStopRules');

var passed = 0;
var failed = 0;
var failures = [];

function assertEq(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  PASS · ' + label + ' = ' + actual);
  } else {
    failed++;
    failures.push(label + ' — expected ' + expected + ', got ' + actual);
    console.log('  FAIL · ' + label + ' — expected ' + expected + ', got ' + actual);
  }
}

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

console.log('\n=== Phase 4.26 timeStopRules — test scenarios ===\n');

// ---------------------------------------------------------------------------
console.log('1) DAY trade at 30min → HOLD');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(30), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);  // flat
  assertEq('action', res.action, 'HOLD');
  assertEq('tradeType', res.tradeType, 'DAY');
  assertEq('elapsed≈30', res.minutesElapsed, 30);
}

// ---------------------------------------------------------------------------
console.log('\n2) DAY trade at 50min → WARN (past warningAt 45min)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(50), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);  // flat
  assertEq('action', res.action, 'WARN');
  assertEq('elapsed≈50', res.minutesElapsed, 50);
}

// ---------------------------------------------------------------------------
console.log('\n3) DAY trade at 65min not in profit → EXIT');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(65), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.45);  // -3% not in profit
  assertEq('action', res.action, 'EXIT');
  assertEq('elapsed≈65', res.minutesElapsed, 65);
  assertEq('inProfit', res.inProfit, false);
}

// ---------------------------------------------------------------------------
console.log('\n4) DAY trade at 65min IN PROFIT (+8%) → HOLD (let winners run)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(65), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.62);  // +8% above entry → in profit
  assertEq('action', res.action, 'HOLD');
  assertEq('inProfit', res.inProfit, true);
}

// ---------------------------------------------------------------------------
console.log('\n5) SWING trade at 8h → HOLD (well under 24h)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'SWING', firedAt: minutesAgo(8 * 60), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);
  assertEq('action', res.action, 'HOLD');
  assertEq('tradeType', res.tradeType, 'SWING');
}

// ---------------------------------------------------------------------------
console.log('\n6) SWING trade at 25h not in profit → EXIT_2PM_NEXTDAY rule fires (action EXIT)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'SWING', firedAt: minutesAgo(25 * 60), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);
  assertEq('action', res.action, 'EXIT');
  assertEq('rule.ifNotProfit', res.rule.ifNotProfit, 'EXIT_2PM_NEXTDAY');
  assertEq('inProfit', res.inProfit, false);
}

// ---------------------------------------------------------------------------
console.log('\n7) SCALP trade at 22min → WARN (warning at 20min)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'SCALP', firedAt: minutesAgo(22), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);
  assertEq('action', res.action, 'WARN');
  assertEq('tradeType', res.tradeType, 'SCALP');
}

// ---------------------------------------------------------------------------
console.log('\n8) SCALP trade at 35min not in profit → EXIT (max 30min)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'SCALP', firedAt: minutesAgo(35), entryPrice: 1.50, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.50);
  assertEq('action', res.action, 'EXIT');
}

// ---------------------------------------------------------------------------
console.log('\n9a) LOTTO trade at 3h → HOLD (well under 6h, before warning at 4h)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'LOTTO', firedAt: minutesAgo(3 * 60), entryPrice: 0.30, direction: 'long', ticker: 'SOUN' };
  var res = tsr.shouldEnforce(pos, new Date(), 0.30);
  assertEq('action', res.action, 'HOLD');
}

// ---------------------------------------------------------------------------
console.log('\n9b) LOTTO trade at 5h → WARN (past 4h warning, before 6h max)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'LOTTO', firedAt: minutesAgo(5 * 60), entryPrice: 0.30, direction: 'long', ticker: 'SOUN' };
  var res = tsr.shouldEnforce(pos, new Date(), 0.30);
  assertEq('action', res.action, 'WARN');
}

// ---------------------------------------------------------------------------
console.log('\n10) LOTTO trade at 7h not in profit → EXIT');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'LOTTO', firedAt: minutesAgo(7 * 60), entryPrice: 0.30, direction: 'long', ticker: 'SOUN' };
  var res = tsr.shouldEnforce(pos, new Date(), 0.30);
  assertEq('action', res.action, 'EXIT');
}

// ---------------------------------------------------------------------------
console.log('\n11) classifyTradeType — live-mover/3 DTE → DAY');
// ---------------------------------------------------------------------------
{
  var t = tsr.classifyTradeType({ source: 'live-mover', dte: 3, conviction: 7 });
  assertEq('classify', t, 'DAY');
}

// ---------------------------------------------------------------------------
console.log('\n12) classifyTradeType — 30 DTE A++ → OVERNIGHT');
// ---------------------------------------------------------------------------
{
  var t = tsr.classifyTradeType({ source: 'tomorrow', dte: 30, conviction: 9.5 });
  assertEq('classify', t, 'OVERNIGHT');
}

// ---------------------------------------------------------------------------
console.log('\n13) classifyTradeType — 30 DTE conv 7 → SWING');
// ---------------------------------------------------------------------------
{
  var t = tsr.classifyTradeType({ source: 'tomorrow', dte: 30, conviction: 7 });
  assertEq('classify', t, 'SWING');
}

// ---------------------------------------------------------------------------
console.log('\n14) classifyTradeType — lotto-feed → LOTTO');
// ---------------------------------------------------------------------------
{
  var t = tsr.classifyTradeType({ source: 'lotto-feed', dte: 1 });
  assertEq('classify', t, 'LOTTO');
}

// ---------------------------------------------------------------------------
console.log('\n15) classifyTradeType — explicit override honored');
// ---------------------------------------------------------------------------
{
  var t = tsr.classifyTradeType({ tradeType: 'SCALP', source: 'tomorrow', dte: 30 });
  assertEq('classify', t, 'SCALP');
}

// ---------------------------------------------------------------------------
console.log('\n16) computeTimeStop — DAY with no time provided uses now');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(0) };
  var s = tsr.computeTimeStop(pos);
  var minDiff = (new Date(s.exitBy).getTime() - new Date(s.firedAt).getTime()) / 60000;
  assertEq('exitBy 60min after firedAt', minDiff, 60);
}

// ---------------------------------------------------------------------------
console.log('\n17) DAY trade at 65min in profit (+5% exact) → HOLD');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(65), entryPrice: 1.00, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.05);  // exactly 5% — counts as in profit
  assertEq('action', res.action, 'HOLD');
  assertEq('inProfit', res.inProfit, true);
}

// ---------------------------------------------------------------------------
console.log('\n18) DAY trade at 65min at +4% → EXIT (under 5% threshold)');
// ---------------------------------------------------------------------------
{
  var pos = { tradeType: 'DAY', firedAt: minutesAgo(65), entryPrice: 1.00, direction: 'long', ticker: 'SPY' };
  var res = tsr.shouldEnforce(pos, new Date(), 1.04);
  assertEq('action', res.action, 'EXIT');
  assertEq('inProfit', res.inProfit, false);
}

// ---------------------------------------------------------------------------
console.log('\n19) fmtCountdown formats minutes correctly');
// ---------------------------------------------------------------------------
{
  assertEq('30m', tsr.fmtCountdown(30), '30m');
  assertEq('90m → 1h 30m', tsr.fmtCountdown(90), '1h 30m');
  assertEq('1500m → 1d 1h', tsr.fmtCountdown(1500), '1d 1h');
}

// ---------------------------------------------------------------------------
console.log('\n=== TEST SUMMARY ===');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failed > 0) {
  console.log('\nFAILURES:');
  failures.forEach(function(f) { console.log('  - ' + f); });
  process.exit(1);
} else {
  console.log('\nALL PASS');
  process.exit(0);
}
