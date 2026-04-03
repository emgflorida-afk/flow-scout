// lvlFramework.js -- Stratum v7.4
// TRUE 25sense Model -- LVL Framework implementation
// Based on: Enter at 25% retrace of prior HTF candle
// Stop at 12.5% of range, TP1 = 50% midpoint, TP2 = opposite extreme
// ---------------------------------------------------------------
// DOES NOT affect John's ideas (ideaIngestor.js) at all
// Used by alerter.js for SYSTEM signals only
// ---------------------------------------------------------------
// 3 CHECKPOINTS:
// 1. LIQUIDITY  -- price tags prior swing/gap/session level
// 2. VALIDATION -- micro-trend + multi-TF candle color align
// 3. LOCK-ON    -- targets next opposing liquidity pool
// ---------------------------------------------------------------

const fetch = require('node-fetch');

const EXECUTE_WEBHOOK = process.env.DISCORD_EXECUTE_NOW_WEBHOOK ||
  'https://discord.com/api/webhooks/1489007440501538949/Lm7EAa9zEXG6Uh3gEG7Flnw378sMmmeupCHG2yLceDmHCQQZO5TI4Z3jkujQGaZdCWPx';

// ---------------------------------------------------------------
// GET HTF CANDLE (Daily by default for intraday plays)
// Returns the prior completed HTF candle OHLC
// This is the FOUNDATION of 25sense -- everything is derived from it
// ---------------------------------------------------------------
async function getHTFCandle(ticker, token, isSim, htfUnit) {
  try {
    var base = isSim
      ? 'https://sim-api.tradestation.com/v3'
      : 'https://api.tradestation.com/v3';

    var unit = htfUnit || 'Daily';
    var res  = await fetch(base + '/marketdata/barcharts/' + ticker +
      '?interval=1&unit=' + unit + '&barsback=5&sessiontemplate=Default', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return null;

    // Prior HTF candle = second to last (last = current incomplete)
    var prior   = bars[bars.length - 2];
    var current = bars[bars.length - 1];

    var priorOpen  = parseFloat(prior.Open  || prior.open  || 0);
    var priorHigh  = parseFloat(prior.High  || prior.high  || 0);
    var priorLow   = parseFloat(prior.Low   || prior.low   || 0);
    var priorClose = parseFloat(prior.Close || prior.close || 0);
    var range      = priorHigh - priorLow;

    // 25sense key levels derived from prior HTF candle range
    var level25    = parseFloat((priorLow  + (range * 0.25)).toFixed(2)); // 25% from low = LONG entry
    var level50    = parseFloat((priorLow  + (range * 0.50)).toFixed(2)); // 50% midpoint = TP1
    var level75    = parseFloat((priorLow  + (range * 0.75)).toFixed(2)); // 75% from low = SHORT entry
    var level125   = parseFloat((priorLow  + (range * 0.125)).toFixed(2)); // 12.5% = stop for longs
    var level875   = parseFloat((priorLow  + (range * 0.875)).toFixed(2)); // 87.5% = stop for shorts

    var priorBull  = priorClose > priorOpen; // Prior candle bullish or bearish

    return {
      priorOpen, priorHigh, priorLow, priorClose,
      currentOpen:  parseFloat(current.Open  || current.open  || 0),
      currentHigh:  parseFloat(current.High  || current.high  || 0),
      currentLow:   parseFloat(current.Low   || current.low   || 0),
      currentClose: parseFloat(current.Close || current.close || 0),
      range,
      // 25sense levels
      level25,   // LONG entry zone (25% of HTF range from low)
      level50,   // TP1 for both long and short (midpoint)
      level75,   // SHORT entry zone (75% = 25% from high)
      level125,  // LONG stop (12.5% from low)
      level875,  // SHORT stop (12.5% from high)
      priorHigh, // TP2 for longs (opposite extreme)
      priorLow,  // TP2 for shorts (opposite extreme)
      priorBull,
      htfUnit: unit,
    };
  } catch(e) {
    console.error('[LVL] HTF candle error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// CHECKPOINT 1: LIQUIDITY
// Has price tagged the prior HTF candle level?
// Long: price needs to reach the 25% level
// Short: price needs to reach the 75% level
// ---------------------------------------------------------------
function checkLiquidity(htf, currentPrice, direction) {
  var isBull    = direction === 'call';
  var target    = isBull ? htf.level25 : htf.level75;
  var tolerance = htf.range * 0.02; // 2% tolerance

  var tagged    = isBull
    ? currentPrice <= target + tolerance
    : currentPrice >= target - tolerance;

  var approaching = isBull
    ? currentPrice <= target + (htf.range * 0.10) && currentPrice > target
    : currentPrice >= target - (htf.range * 0.10) && currentPrice < target;

  return {
    passed:     tagged,
    approaching,
    target,
    note: tagged
      ? 'Price at 25sense entry level $' + target
      : approaching
      ? 'Approaching 25sense level $' + target
      : 'Not yet at 25sense level $' + target,
  };
}

// ---------------------------------------------------------------
// CHECKPOINT 2: VALIDATION
// Multi-TF candle color alignment
// Daily + Weekly + Monthly must agree with direction
// ---------------------------------------------------------------
async function checkValidation(ticker, token, isSim, direction) {
  try {
    var base = isSim
      ? 'https://sim-api.tradestation.com/v3'
      : 'https://api.tradestation.com/v3';

    var [dRes, wRes, mRes] = await Promise.all([
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Daily&barsback=3', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Weekly&barsback=3', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Monthly&barsback=3', { headers: { 'Authorization': 'Bearer ' + token } }),
    ]);

    var [dData, wData, mData] = await Promise.all([dRes.json(), wRes.json(), mRes.json()]);

    function isBullBar(bars) {
      if (!bars || bars.length < 2) return null;
      var b = bars[bars.length - 2];
      return parseFloat(b.Close || b.close) > parseFloat(b.Open || b.open);
    }

    var dailyBull   = isBullBar(dData.Bars || dData.bars);
    var weeklyBull  = isBullBar(wData.Bars || wData.bars);
    var monthlyBull = isBullBar(mData.Bars || mData.bars);

    var isBull = direction === 'call';
    var score  = 0;
    var colors = [];

    if (dailyBull   === isBull)  { score++; colors.push('D:✅'); } else { colors.push('D:❌'); }
    if (weeklyBull  === isBull)  { score++; colors.push('W:✅'); } else { colors.push('W:❌'); }
    if (monthlyBull === isBull)  { score++; colors.push('M:✅'); } else { colors.push('M:❌'); }

    var passed    = score >= 2; // At least 2 of 3 TF aligned
    var alignment = score === 3 ? 'STRONG' : score === 2 ? 'MODERATE' : 'WEAK';

    return {
      passed,
      score,
      alignment,
      colors: colors.join(' '),
      note: alignment + ' -- ' + score + '/3 TF aligned ' + colors.join(' '),
    };
  } catch(e) {
    console.error('[LVL] Validation error:', e.message);
    return { passed: false, score: 0, alignment: 'UNKNOWN', note: 'Could not check TF alignment' };
  }
}

// ---------------------------------------------------------------
// CHECKPOINT 3: LOCK-ON
// Calculate precise targets based on 25sense model
// TP1 = 50% midpoint of prior HTF candle
// TP2 = opposite extreme of prior HTF candle
// Stop = 12.5% of range from entry
// ---------------------------------------------------------------
function getLockOnTargets(htf, direction) {
  var isBull = direction === 'call';

  return {
    entry: isBull ? htf.level25  : htf.level75,   // 25sense entry
    stop:  isBull ? htf.level125 : htf.level875,  // 12.5% stop
    tp1:   htf.level50,                            // 50% midpoint always
    tp2:   isBull ? htf.priorHigh : htf.priorLow, // opposite extreme
    note:  'Entry: $' + (isBull ? htf.level25 : htf.level75) +
           ' | Stop: $' + (isBull ? htf.level125 : htf.level875) +
           ' | TP1: $' + htf.level50 +
           ' | TP2: $' + (isBull ? htf.priorHigh : htf.priorLow),
  };
}

// ---------------------------------------------------------------
// MAIN: analyze25sense
// Runs all 3 checkpoints and returns full LVL analysis
// Called by alerter.js for system signals only
// ---------------------------------------------------------------
async function analyze25sense(ticker, direction, currentPrice, token, isSim) {
  try {
    // Get prior HTF candle (Daily for intraday plays)
    var htf = await getHTFCandle(ticker, token, isSim, 'Daily');
    if (!htf) return null;

    // Run 3 checkpoints
    var liquidity  = checkLiquidity(htf, currentPrice, direction);
    var validation = await checkValidation(ticker, token, isSim, direction);
    var lockOn     = getLockOnTargets(htf, direction);

    // Overall LVL score
    var score = 0;
    if (liquidity.passed)    score += 2; // Liquidity = most important
    if (liquidity.approaching) score += 1; // Approaching = heads up
    if (validation.passed)   score += 2; // Validation = important
    if (validation.score === 3) score += 1; // All 3 TF = bonus

    var grade = score >= 5 ? 'A+' : score >= 4 ? 'A' : score >= 3 ? 'B' : 'C';

    console.log('[LVL] 25sense analysis:', ticker, direction,
      'Score:' + score, 'Grade:' + grade,
      'Liquidity:' + liquidity.passed, 'Validation:' + validation.alignment,
      'Entry:$' + lockOn.entry, 'TP1:$' + lockOn.tp1, 'TP2:$' + lockOn.tp2);

    // Post heads up if approaching but not yet at level
    if (liquidity.approaching && !liquidity.passed) {
      postHeadsUp(ticker, direction, currentPrice, htf, lockOn).catch(console.error);
    }

    return {
      ticker,
      direction,
      currentPrice,
      htf,
      liquidity,
      validation,
      lockOn,
      score,
      grade,
      // Structural targets for orderExecutor (replaces premium % targets)
      structuralEntry: lockOn.entry,
      structuralStop:  lockOn.stop,
      structuralTP1:   lockOn.tp1,
      structuralTP2:   lockOn.tp2,
      // For compact card display
      summary: grade + ' LVL | ' + liquidity.note + ' | ' + validation.note,
      tag: grade === 'A+' ? ' \uD83D\uDFE2 25sense A+' :
           grade === 'A'  ? ' \uD83D\uDFE1 25sense A'  :
           grade === 'B'  ? ' \uD83D\uDFE0 25sense B'  : '',
    };

  } catch(e) {
    console.error('[LVL] 25sense error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// HEADS UP ALERT
// Fires when price is approaching the 25sense entry zone
// Gives 5-10 min prep time before trigger fires
// ---------------------------------------------------------------
async function postHeadsUp(ticker, direction, currentPrice, htf, lockOn) {
  try {
    var isBull   = direction === 'call';
    var target   = isBull ? htf.level25 : htf.level75;
    var dist     = Math.abs(currentPrice - target).toFixed(2);

    var lines = [
      '\u26A0\uFE0F 25SENSE HEADS UP -- ' + ticker.toUpperCase() + ' ' + direction.toUpperCase(),
      '========================================',
      'Approaching 25sense entry zone',
      'Current:  $' + currentPrice,
      'Target:   $' + target + ' (25% of prior daily range)',
      'Distance: $' + dist + ' away',
      '----------------------------------------',
      'When price tags $' + target + ':',
      '\uD83D\uDCB0 Entry:  $' + lockOn.entry,
      '\uD83D\uDED1 Stop:   $' + lockOn.stop + ' (12.5% of range)',
      '\uD83C\uDFAF TP1:    $' + lockOn.tp1 + ' (50% midpoint)',
      '\uD83C\uDFAF TP2:    $' + lockOn.tp2 + ' (opposite extreme)',
      '========================================',
      'Get ready -- check GEXR zone before entry',
    ].join('\n');

    await fetch(EXECUTE_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + lines + '\n```',
        username: 'Stratum 25sense',
      }),
    });
    console.log('[LVL] Heads up posted for', ticker, direction);
  } catch(e) {
    console.error('[LVL] Heads up error:', e.message);
  }
}

module.exports = { analyze25sense, getHTFCandle, checkLiquidity, checkValidation, getLockOnTargets, postHeadsUp };
