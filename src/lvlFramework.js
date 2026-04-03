// lvlFramework.js -- Stratum v7.4
// LVL Framework concepts added to system signal scoring
// DOES NOT affect John's ideas (ideaIngestor.js) at all
// Used by contractResolver.js and alerter.js for system signals only
// ---------------------------------------------------------------
// LVL CONCEPTS IMPLEMENTED:
// 1. PDH/PDL Detection -- is price approaching a key level?
// 2. 25% Pullback Entry -- wait for retracement from PDH/PDL
// 3. Multi-TF Momentum Score -- D + W + M alignment
// 4. Sweep + Structure Confirmation -- HH after sweep = highest prob
// ---------------------------------------------------------------

const fetch = require('node-fetch');

// ---------------------------------------------------------------
// GET PDH/PDL (Previous Day High/Low) for underlying
// Uses TradeStation API daily bars
// ---------------------------------------------------------------
async function getPDHL(ticker, token, isSim) {
  try {
    var base = isSim
      ? 'https://sim-api.tradestation.com/v3'
      : 'https://api.tradestation.com/v3';

    var res  = await fetch(base + '/marketdata/barcharts/' + ticker +
      '?interval=1&unit=Daily&barsback=5&sessiontemplate=Default', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    var bars = data.Bars || data.bars || [];
    if (bars.length < 2) return null;

    // Previous day = second to last bar (last bar = today)
    var prevDay = bars[bars.length - 2];
    var today   = bars[bars.length - 1];

    return {
      pdHigh:    parseFloat(prevDay.High  || prevDay.high  || 0),
      pdLow:     parseFloat(prevDay.Low   || prevDay.low   || 0),
      pdClose:   parseFloat(prevDay.Close || prevDay.close || 0),
      pdOpen:    parseFloat(prevDay.Open  || prevDay.open  || 0),
      todayOpen: parseFloat(today.Open    || today.open    || 0),
      todayHigh: parseFloat(today.High    || today.high    || 0),
      todayLow:  parseFloat(today.Low     || today.low     || 0),
    };
  } catch(e) {
    console.error('[LVL] PDH/PDL error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// MULTI-TIMEFRAME MOMENTUM SCORE
// Checks Daily + Weekly + Monthly bar direction
// Returns score 0-3 and alignment status
// ---------------------------------------------------------------
async function getMTFMomentum(ticker, token, isSim, direction) {
  try {
    var base = isSim
      ? 'https://sim-api.tradestation.com/v3'
      : 'https://api.tradestation.com/v3';

    // Fetch daily, weekly, monthly bars
    var [dailyRes, weeklyRes, monthlyRes] = await Promise.all([
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Daily&barsback=5', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Weekly&barsback=5', { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch(base + '/marketdata/barcharts/' + ticker + '?interval=1&unit=Monthly&barsback=3', { headers: { 'Authorization': 'Bearer ' + token } }),
    ]);

    var [dailyData, weeklyData, monthlyData] = await Promise.all([
      dailyRes.json(), weeklyRes.json(), monthlyRes.json()
    ]);

    var dailyBars   = dailyData.Bars   || dailyData.bars   || [];
    var weeklyBars  = weeklyData.Bars  || weeklyData.bars  || [];
    var monthlyBars = monthlyData.Bars || monthlyData.bars || [];

    // Get last completed bar direction for each timeframe
    function barDirection(bars) {
      if (bars.length < 2) return 'NEUTRAL';
      var bar   = bars[bars.length - 2]; // last completed bar
      var open  = parseFloat(bar.Open  || bar.open  || 0);
      var close = parseFloat(bar.Close || bar.close || 0);
      return close > open ? 'BULLISH' : close < open ? 'BEARISH' : 'NEUTRAL';
    }

    var dailyDir   = barDirection(dailyBars);
    var weeklyDir  = barDirection(weeklyBars);
    var monthlyDir = barDirection(monthlyBars);

    // Score alignment with trade direction
    var isBull  = direction === 'call';
    var target  = isBull ? 'BULLISH' : 'BEARISH';
    var score   = 0;
    if (dailyDir   === target) score++;
    if (weeklyDir  === target) score++;
    if (monthlyDir === target) score++;

    var alignment = score === 3 ? 'STRONG'
                  : score === 2 ? 'MODERATE'
                  : score === 1 ? 'WEAK'
                  : 'AGAINST';

    console.log('[LVL] MTF Momentum:', ticker, direction.toUpperCase(),
      'D:' + dailyDir, 'W:' + weeklyDir, 'M:' + monthlyDir,
      'Score:' + score + '/3', alignment);

    return { score, alignment, dailyDir, weeklyDir, monthlyDir };
  } catch(e) {
    console.error('[LVL] MTF Momentum error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// LVL ENTRY ANALYSIS
// Main function called by alerter.js for system signals
// Returns full LVL analysis object
// ---------------------------------------------------------------
async function analyzeLVL(ticker, direction, currentPrice, token, isSim) {
  try {
    var pdhl = await getPDHL(ticker, token, isSim);
    var mtf  = await getMTFMomentum(ticker, token, isSim, direction);

    if (!pdhl) return null;

    var isBull      = direction === 'call';
    var keyLevel    = isBull ? pdhl.pdHigh : pdhl.pdLow;
    var range       = pdhl.pdHigh - pdhl.pdLow;

    // Is price approaching the key level?
    var distFromLevel = Math.abs(currentPrice - keyLevel);
    var distPct       = range > 0 ? (distFromLevel / range * 100) : 100;
    var approaching   = distPct <= 10; // within 10% of range from key level

    // Has price touched/swept the level?
    var touched = isBull
      ? pdhl.todayHigh >= keyLevel
      : pdhl.todayLow  <= keyLevel;

    // 25% pullback entry zone (LVL concept)
    // After touching PDH/PDL, wait for 25% pullback from that extreme
    var pullbackZone = null;
    if (touched) {
      var pullback25 = isBull
        ? keyLevel - (range * 0.25)  // 25% below PDH
        : keyLevel + (range * 0.25); // 25% above PDL
      var nearPullback = isBull
        ? currentPrice <= pullbackZone && currentPrice >= pullbackZone - (range * 0.10)
        : currentPrice >= pullbackZone && currentPrice <= pullbackZone + (range * 0.10);
      pullbackZone = parseFloat(pullback25.toFixed(2));
    }

    // LVL Signal strength
    var lvlScore  = 0;
    var lvlNotes  = [];

    if (approaching)  { lvlScore++; lvlNotes.push('Approaching PDH/PDL'); }
    if (touched)      { lvlScore++; lvlNotes.push('Level touched/swept'); }
    if (pullbackZone) { lvlScore++; lvlNotes.push('25% pullback zone active'); }
    if (mtf && mtf.score >= 2) { lvlScore++; lvlNotes.push('MTF aligned ' + mtf.alignment); }
    if (mtf && mtf.score === 3) { lvlScore++; lvlNotes.push('All 3 TF confirmed'); }

    var lvlGrade = lvlScore >= 4 ? 'A+' : lvlScore >= 3 ? 'A' : lvlScore >= 2 ? 'B' : 'C';

    console.log('[LVL] Analysis:', ticker, direction, 'Score:' + lvlScore, lvlGrade,
      'PDH:' + pdhl.pdHigh, 'PDL:' + pdhl.pdLow,
      'Approaching:' + approaching, 'Touched:' + touched);

    return {
      ticker,
      direction,
      pdHigh:       pdhl.pdHigh,
      pdLow:        pdhl.pdLow,
      keyLevel,
      approaching,
      touched,
      pullbackZone,
      mtf,
      lvlScore,
      lvlGrade,
      lvlNotes,
      // For Discord card
      summary: lvlGrade + ' LVL | ' + lvlNotes.join(' + '),
    };

  } catch(e) {
    console.error('[LVL] Analysis error:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// PDH/PDL HEADS UP ALERT
// Posts to Discord when price is approaching a key level
// Gives you 5-10 min prep time before trigger fires
// ---------------------------------------------------------------
async function postHeadsUp(ticker, direction, currentPrice, pdhl, webhook) {
  try {
    var isBull    = direction === 'call';
    var keyLevel  = isBull ? pdhl.pdHigh : pdhl.pdLow;
    var dist      = Math.abs(currentPrice - keyLevel).toFixed(2);
    var distPct   = ((Math.abs(currentPrice - keyLevel) / keyLevel) * 100).toFixed(1);

    var lines = [
      '\u26A0\uFE0F HEADS UP -- ' + ticker.toUpperCase() + ' approaching key level',
      '========================================',
      'Ticker:      ' + ticker.toUpperCase(),
      'Direction:   ' + direction.toUpperCase(),
      'Key Level:   $' + keyLevel + ' (prev day ' + (isBull ? 'HIGH' : 'LOW') + ')',
      'Current:     $' + currentPrice,
      'Distance:    $' + dist + ' (' + distPct + '% away)',
      '----------------------------------------',
      '\uD83C\uDFAF Get ready -- trigger may fire soon',
      '\uD83D\uDCCB Check GEXR zone before entering',
      '\uD83D\uDCB0 25% pullback entry zone will activate on touch',
      '========================================',
    ].join('\n');

    await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        content:  '```\n' + lines + '\n```',
        username: 'Stratum LVL Monitor',
      }),
    });
    console.log('[LVL] Heads up alert posted for', ticker);
  } catch(e) {
    console.error('[LVL] Heads up error:', e.message);
  }
}

module.exports = { analyzeLVL, getPDHL, getMTFMomentum, postHeadsUp };
