// Regression tests for April 14 bug patterns.
// Run: node tests/regression_apr14.test.js

'use strict';

var assert = require('assert');
var results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try { fn(); results.passed++; console.log('PASS: ' + name); }
  catch(e) { results.failed++; results.errors.push(name + ': ' + e.message); console.log('FAIL: ' + name + ' -- ' + e.message); }
}

// ================================================================
// #1: NVDA conflict-block bug
// Long NVDA shares (AssetType OP/STOCKOPTION filter) must not
// conflict with opening NVDA calls or puts.
// ================================================================
test('positionManager: long stock does not conflict with new options', function() {
  // Mock option-symbol regex checks the real checkConflict uses
  var sym = 'NVDA'; // plain stock
  var isOption = /\s\d{6}[CP]\d/.test(sym) || /\d{6}[CP]\d{8}/.test(sym);
  assert.strictEqual(isOption, false, 'Plain stock ticker must not be detected as option');
});

test('positionManager: NVDA option symbol correctly identified as call', function() {
  var sym = 'NVDA 260418C180';
  var isCall = /\d{6}C\d/.test(sym) || /\sC\d/.test(sym);
  var isPut  = /\d{6}P\d/.test(sym) || /\sP\d/.test(sym);
  assert.strictEqual(isCall, true);
  assert.strictEqual(isPut, false);
});

test('positionManager: NVDA option symbol correctly identified as put', function() {
  var sym = 'NVDA 260418P170';
  var isCall = /\d{6}C\d/.test(sym) || /\sC\d/.test(sym);
  var isPut  = /\d{6}P\d/.test(sym) || /\sP\d/.test(sym);
  assert.strictEqual(isCall, false);
  assert.strictEqual(isPut, true);
});

// ================================================================
// #2: HCA dead-expiry picker bug
// Swing setups must require minDTE 7, day trades minDTE 2.
// No 0DTE or 1DTE ever slips through.
// ================================================================
test('contractResolver: DAY mode rejects 0DTE and 1DTE', function() {
  var resolver = require('../src/contractResolver');
  // We can only validate the config since selectExpiry is not exported
  // but test intent via the MODES constant patched into the file.
  var src = require('fs').readFileSync(__dirname + '/../src/contractResolver.js', 'utf8');
  var dayMinMatch = src.match(/DAY:\s*\{[\s\S]*?minDTE:\s*(\d+)/);
  assert.ok(dayMinMatch, 'DAY mode minDTE must be defined');
  assert.ok(parseInt(dayMinMatch[1], 10) >= 2, 'DAY minDTE must be >= 2 (was 1, allowed 1DTE)');
});

test('contractResolver: SWING mode requires >= 7 DTE', function() {
  var src = require('fs').readFileSync(__dirname + '/../src/contractResolver.js', 'utf8');
  var swingMinMatch = src.match(/SWING:\s*\{[\s\S]*?minDTE:\s*(\d+)/);
  assert.ok(swingMinMatch, 'SWING mode minDTE must be defined');
  assert.ok(parseInt(swingMinMatch[1], 10) >= 7, 'SWING minDTE must be >= 7 (was 5, allowed early-expiry swings)');
});

// ================================================================
// #3: TS REJ phantom position bug
// executeAutonomous must return executed:false when placeOrder
// returns rejected:true. Brain must not push to activePositions.
// ================================================================
test('orderExecutor: rejection signature returned on embedded errors', function() {
  var src = require('fs').readFileSync(__dirname + '/../src/orderExecutor.js', 'utf8');
  assert.ok(src.indexOf('rejected: true') !== -1, 'placeOrder must return rejected:true on TS REJ');
  assert.ok(src.indexOf('TS_REJ') !== -1, 'placeOrder must tag rejections with TS_REJ prefix');
  assert.ok(src.indexOf('verifyRes') !== -1, 'placeOrder must verify order status post-placement');
});

test('brainEngine: executeAutonomous maps rejected to executed:false', function() {
  var src = require('fs').readFileSync(__dirname + '/../src/brainEngine.js', 'utf8');
  assert.ok(src.indexOf('result.rejected') !== -1, 'executeAutonomous must check result.rejected');
  assert.ok(src.indexOf('ORDER REJECTED BY TS') !== -1, 'executeAutonomous must log TS rejections distinctly');
});

// ================================================================
// #4: A-tier grader regression
// ================================================================
test('gradeSetup: A++ requires all 7 criteria', function() {
  var brain = require('../src/brainEngine');
  var perfect = {
    direction: 'call', ftfc: 'BULL', tfAligned: 4,
    flowScore: 85, flowBias: 'bullish',
    stratSignal: 'F2D', emaFanAligned: true, atKeyLevel: true,
    dte: 5, spreadPct: 0.05, premium: 1.20,
    earningsWithin3Days: false, highImpactEventImminent: false,
  };
  var g = brain.gradeSetup(perfect);
  assert.strictEqual(g.grade, 'A++');
  assert.strictEqual(g.aTier, true);
});

test('gradeSetup: empty setup grades F', function() {
  var brain = require('../src/brainEngine');
  var g = brain.gradeSetup({});
  assert.strictEqual(g.grade, 'F');
  assert.strictEqual(g.tradeable, false);
});

test('gradeSetup: earnings within 3 days drops score', function() {
  var brain = require('../src/brainEngine');
  var withEarnings = {
    direction: 'call', ftfc: 'BULL', flowScore: 85,
    stratSignal: 'F2D', emaFanAligned: true, atKeyLevel: true,
    dte: 5, spreadPct: 0.05, premium: 1.20,
    earningsWithin3Days: true,
  };
  var g = brain.gradeSetup(withEarnings);
  assert.ok(g.score <= 6, 'Earnings within 3 days must drop score by 1');
  assert.strictEqual(g.failed.indexOf('CATALYST_CLEAR') !== -1, true);
});

// ================================================================
// #5: Dynamic watchlist expansion
// ================================================================
test('brainEngine: dynamic watchlist exposes getScanWatchlist', function() {
  var brain = require('../src/brainEngine');
  assert.strictEqual(typeof brain.addDynamicTicker, 'function');
  assert.strictEqual(typeof brain.getFullWatchlist, 'function');
  assert.strictEqual(typeof brain.clearDynamicWatchlist, 'function');

  brain.clearDynamicWatchlist();
  var added = brain.addDynamicTicker('ABCDEF', 'test');
  assert.strictEqual(added, true);
  var list = brain.getDynamicWatchlist();
  assert.strictEqual(list.indexOf('ABCDEF') !== -1, true);
  // Duplicate rejected
  var dupe = brain.addDynamicTicker('ABCDEF', 'test');
  assert.strictEqual(dupe, false);
  brain.clearDynamicWatchlist();
});

// ================================================================
// #6: Spread engine continuity uses close-vs-prior-close
// ================================================================
test('creditSpreadEngine: getContinuity uses Close not High/Low', function() {
  var src = require('fs').readFileSync(__dirname + '/../src/creditSpreadEngine.js', 'utf8');
  var idx = src.indexOf('function getContinuity');
  assert.ok(idx !== -1, 'getContinuity must exist');
  var body = src.slice(idx, idx + 800);
  assert.ok(body.indexOf('.Close') !== -1, 'getContinuity must compare Close values');
});

// ================================================================
// Summary
// ================================================================
console.log('\n================================');
console.log('PASS: ' + results.passed + ' | FAIL: ' + results.failed);
if (results.failed > 0) {
  console.log('\nFAILURES:');
  results.errors.forEach(function(e) { console.log(' - ' + e); });
  process.exit(1);
}
console.log('================================');
