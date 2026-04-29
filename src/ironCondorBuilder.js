// =============================================================================
// IRON CONDOR BUILDER (Apr 29 2026)
//
// Picks 4 strikes for an iron condor on a cash-settled European-style index
// (XSP, SPX, RUT, NDX preferred over SPY/QQQ/IWM/DIA).
//
// Structure (for credit, neutral bias):
//   Short Put  ~ shortDelta  (collect premium)
//   Long Put   ~ wingDelta   (cap downside)
//   Short Call ~ shortDelta  (collect premium)
//   Long Call  ~ wingDelta   (cap upside)
//
// The "wing width" = abs(short_put - long_put) = abs(short_call - long_call)
// This is the max risk per side. AB's Level 3 approval covers this.
//
// Why cash-settled:
//   - European-style: no early assignment surprise on short legs
//   - Cash-settled: no T+1 stock settlement issues
//   - SPX/XSP get Section 1256 60/40 tax treatment
//
// Public API:
//   buildIronCondor(chainRows, opts)  -> { ok, legs, credit, maxRisk, maxReward, ... }
//   selectByDelta(side, rows, targetDelta) -> { strike, contract, deltaErr }
// =============================================================================

// =============================================================================
// PURE PICKER — given chain rows + target deltas, returns the condor plan
// =============================================================================
function buildIronCondor(chainRows, opts) {
  opts = opts || {};
  var shortDelta = opts.shortDelta != null ? opts.shortDelta : 0.25;
  var wingDelta  = opts.wingDelta  != null ? opts.wingDelta  : 0.15;
  var minWingWidth = opts.minWingWidth || 5;   // dollars, minimum width
  var spot       = opts.spot || null;

  if (!Array.isArray(chainRows) || chainRows.length < 4) {
    return { ok: false, reason: 'insufficient-chain-rows', count: chainRows && chainRows.length };
  }

  // Each chainRow is { strike, call: {...}, put: {...} } from optionsChain.js
  // Filter to rows with both call + put present (clean strikes)
  var rows = chainRows.filter(function(r) {
    return r && r.call && r.put && isFinite(r.call.delta) && isFinite(r.put.delta) && r.call.bid > 0 && r.put.bid > 0;
  });

  if (rows.length < 4) {
    return { ok: false, reason: 'too-few-tradable-strikes', count: rows.length };
  }

  // Sort ascending by strike for clarity
  rows.sort(function(a, b) { return a.strike - b.strike; });

  // ATM: row whose call delta is closest to 0.50
  var atmRow = rows.reduce(function(best, r) {
    var bestErr = Math.abs(Math.abs(best.call.delta) - 0.50);
    var thisErr = Math.abs(Math.abs(r.call.delta) - 0.50);
    return thisErr < bestErr ? r : best;
  }, rows[0]);

  // Put side: strikes BELOW ATM
  // - Short put: row with put delta closest to -shortDelta (e.g., -0.25)
  // - Long put: further OTM, put delta closest to -wingDelta (e.g., -0.15)
  var putRows = rows.filter(function(r) { return r.strike <= atmRow.strike; });
  var shortPut = _selectByDelta(putRows, 'put', -shortDelta);
  var longPut  = _selectByDelta(
    putRows.filter(function(r) { return r.strike < shortPut.strike; }),
    'put', -wingDelta);

  // Call side: strikes ABOVE ATM
  // - Short call: row with call delta closest to +shortDelta
  // - Long call: further OTM, call delta closest to +wingDelta
  var callRows = rows.filter(function(r) { return r.strike >= atmRow.strike; });
  var shortCall = _selectByDelta(callRows, 'call', shortDelta);
  var longCall  = _selectByDelta(
    callRows.filter(function(r) { return r.strike > shortCall.strike; }),
    'call', wingDelta);

  // Sanity: any leg missing -> reject
  if (!shortPut || !longPut || !shortCall || !longCall) {
    return { ok: false, reason: 'leg-selection-failed', details: {
      shortPut: !!shortPut, longPut: !!longPut, shortCall: !!shortCall, longCall: !!longCall,
    }};
  }

  // Wing widths
  var putWingWidth  = shortPut.strike  - longPut.strike;
  var callWingWidth = longCall.strike  - shortCall.strike;

  // If the chosen wings are too narrow (e.g., due to coarse strike grid), expand
  if (putWingWidth < minWingWidth || callWingWidth < minWingWidth) {
    // Try widening to next strikes
    var widenedLongPut = putRows
      .filter(function(r) { return shortPut.strike - r.strike >= minWingWidth; })
      .sort(function(a, b) { return b.strike - a.strike; })[0];  // closest that meets min
    var widenedLongCall = callRows
      .filter(function(r) { return r.strike - shortCall.strike >= minWingWidth; })
      .sort(function(a, b) { return a.strike - b.strike; })[0];
    if (widenedLongPut)  longPut  = widenedLongPut;
    if (widenedLongCall) longCall = widenedLongCall;
    putWingWidth  = shortPut.strike  - longPut.strike;
    callWingWidth = longCall.strike  - shortCall.strike;
  }

  // Credit calculation (round to penny)
  var shortPutCredit  = _midPrice(shortPut.put);
  var longPutCost     = _midPrice(longPut.put);
  var shortCallCredit = _midPrice(shortCall.call);
  var longCallCost    = _midPrice(longCall.call);

  var totalCredit = round2((shortPutCredit + shortCallCredit) - (longPutCost + longCallCost));
  var maxLossPerSide = round2(Math.max(putWingWidth, callWingWidth) - totalCredit);

  // Breakevens
  var lowerBE = round2(shortPut.strike  - totalCredit);
  var upperBE = round2(shortCall.strike + totalCredit);

  // Profit zone width (between short strikes) - inside this zone at expiry = max profit
  var profitZoneWidth = shortCall.strike - shortPut.strike;

  // Probability heuristic from short deltas (rough): P(profit) ~ 1 - (|short_put_delta| + short_call_delta)
  var probProfit = round2(1 - (Math.abs(shortPut.put.delta) + shortCall.call.delta));

  return {
    ok:   true,
    type: 'IRON_CONDOR',
    legs: {
      shortPut: _legSummary(shortPut, 'put', 'short'),
      longPut:  _legSummary(longPut,  'put', 'long'),
      shortCall: _legSummary(shortCall, 'call', 'short'),
      longCall:  _legSummary(longCall,  'call', 'long'),
    },
    summary: {
      totalCredit:    totalCredit,
      creditPerCt:    round2(totalCredit * 100),  // dollars per contract
      maxLossPerSide: maxLossPerSide,
      maxLossPerCt:   round2(maxLossPerSide * 100),
      putWingWidth:   round2(putWingWidth),
      callWingWidth:  round2(callWingWidth),
      profitZoneWidth: round2(profitZoneWidth),
      lowerBreakeven: lowerBE,
      upperBreakeven: upperBE,
      probProfit:     probProfit,
      atmStrike:      atmRow.strike,
      atmCallDelta:   round3(atmRow.call.delta),
    },
    structure: 'short ' + shortPut.strike + 'P / long ' + longPut.strike + 'P / short ' + shortCall.strike + 'C / long ' + longCall.strike + 'C',
    titanCard: 'IC ' + (opts.underlying || '') + ' '
      + (opts.expiry || '') + ' '
      + longPut.strike + 'P/' + shortPut.strike + 'P/' + shortCall.strike + 'C/' + longCall.strike + 'C '
      + '@ ~$' + totalCredit.toFixed(2) + ' credit',
  };
}

// =============================================================================
// HELPERS
// =============================================================================
function _selectByDelta(rows, side, targetDelta) {
  if (!rows || !rows.length) return null;
  return rows.reduce(function(best, r) {
    var bestErr = Math.abs((side === 'put' ? r.put.delta : r.call.delta) - targetDelta);
    var bestDef = best ? Math.abs((side === 'put' ? best.put.delta : best.call.delta) - targetDelta) : 999;
    return bestErr < bestDef ? r : best;
  }, null);
}

function _midPrice(c) {
  if (c.mid && c.mid > 0) return c.mid;
  if (c.bid > 0 && c.ask > 0) return round2((c.bid + c.ask) / 2);
  return c.last || 0;
}

function _legSummary(row, side, dir) {
  var c = row[side];
  return {
    strike:  row.strike,
    symbol:  c.symbol,
    side:    side.toUpperCase(),
    dir:     dir.toUpperCase(),
    delta:   round3(c.delta),
    bid:     c.bid,
    ask:     c.ask,
    mid:     _midPrice(c),
    iv:      round3(c.iv),
    volume:  c.volume,
    oi:      c.oi,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// Underlying preference: prefer cash-settled European-style for short-leg strategies
function preferredUnderlying(ticker) {
  ticker = (ticker || '').toUpperCase();
  if (['XSP','SPX','RUT','NDX'].indexOf(ticker) >= 0) return ticker;  // already preferred
  if (ticker === 'SPY') return 'XSP';   // mini-SPX, 1/10 size
  if (ticker === 'QQQ') return 'NDX';
  if (ticker === 'IWM') return 'RUT';
  if (ticker === 'DIA') return 'DJX';
  return ticker;  // not an index, return as-is
}

module.exports = {
  buildIronCondor: buildIronCondor,
  preferredUnderlying: preferredUnderlying,
};
