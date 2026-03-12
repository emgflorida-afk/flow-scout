// tradeClassifier.js — Stratum Flow Scout
// PURPOSE: Classify every alert as DAY TRADE, SWING, or LOTTO
// Based on The Strat timeframe continuity rules
// Source: 5__THESTRAT__Option_Trading_.pdf + strategy PDFs
// ─────────────────────────────────────────────────────────────────

// ── BAR TYPE DEFINITIONS ─────────────────────────────────────────
// Directly from The Strat:
// 1 = Inside Bar    (consolidation, did not break prior high OR low)
// 2U = Directional Up   (broke prior high only)
// 2D = Directional Down (broke prior low only)
// 3  = Outside Bar  (broke BOTH prior high and low)
// F2U = Failed 2 Up   (went 2U then reversed — bearish trap)
// F2D = Failed 2 Down (went 2D then reversed — bullish trap)

const BAR = {
  INSIDE:   '1',
  TWO_UP:   '2U',
  TWO_DOWN: '2D',
  OUTSIDE:  '3',
  FAILED_2U: 'F2U',  // bearish signal
  FAILED_2D: 'F2D',  // bullish signal
};

// ── COMBO DEFINITIONS ────────────────────────────────────────────
// From The Strat PDF — all 16 combos with type and quality
const COMBOS = {
  // Continuations (trend following)
  '2U-2U': { name: '2-2 Bullish Continuation',  direction: 'bullish', type: 'continuation', strength: 'moderate' },
  '2D-2D': { name: '2-2 Bearish Continuation',  direction: 'bearish', type: 'continuation', strength: 'moderate' },

  // Reversals (counter trend)
  '2D-2U': { name: '2-2 Bullish Reversal',       direction: 'bullish', type: 'reversal',     strength: 'moderate' },
  '2U-2D': { name: '2-2 Bearish Reversal',       direction: 'bearish', type: 'reversal',     strength: 'moderate' },
  '3-2D-2U': { name: '3-2-2 Bullish Reversal',  direction: 'bullish', type: 'reversal',     strength: 'strong'   },
  '3-2U-2D': { name: '3-2-2 Bearish Reversal',  direction: 'bearish', type: 'reversal',     strength: 'strong'   },

  // 2-1-2 (compression then breakout — highest probability)
  '2U-1-2U': { name: '2-1-2 Bullish Continuation', direction: 'bullish', type: 'continuation', strength: 'strong' },
  '2D-1-2D': { name: '2-1-2 Bearish Continuation', direction: 'bearish', type: 'continuation', strength: 'strong' },
  '2D-1-2U': { name: '2-1-2 Bullish Reversal',     direction: 'bullish', type: 'reversal',     strength: 'strong' },
  '2U-1-2D': { name: '2-1-2 Bearish Reversal',     direction: 'bearish', type: 'reversal',     strength: 'strong' },

  // 3-1-2
  '3-1-2U': { name: '3-1-2 Bullish Continuation', direction: 'bullish', type: 'continuation', strength: 'strong' },
  '3-1-2D': { name: '3-1-2 Bearish Continuation', direction: 'bearish', type: 'continuation', strength: 'strong' },

  // Holy Grail / Nirvana
  '1-2U': { name: '1-2 Bullish Breakout',  direction: 'bullish', type: 'reversal', strength: 'moderate' },
  '1-2D': { name: '1-2 Bearish Breakout',  direction: 'bearish', type: 'reversal', strength: 'moderate' },
  '1-3':  { name: '1-3 Outside Reversal',  direction: 'both',    type: 'reversal', strength: 'strong'   },

  // Failed 2 (manipulation traps)
  'F2U': { name: 'Failed 2 Up',   direction: 'bearish', type: 'reversal', strength: 'strong' },
  'F2D': { name: 'Failed 2 Down', direction: 'bullish', type: 'reversal', strength: 'strong' },
};

// ── TIMEFRAME HIERARCHY ──────────────────────────────────────────
// From The Strat PDF:
// DAY TRADE TFs:   Weekly → Daily → 4H → 1H → 30M → 15M → 5M → 1M
// SWING TRADE TFs: Quarterly → Monthly → Weekly → Daily

// ── TRADE TYPE CLASSIFICATION RULES ─────────────────────────────
// Based directly on The Strat timeframe continuity section

function classifyTrade(tfData, dte, contractType) {
  const {
    monthly  = null,
    weekly   = null,
    daily    = null,
    h4       = null,
    h1       = null,
    m30      = null,
    m15      = null,
  } = tfData;

  const direction = contractType === 'put' ? 'bearish' : 'bullish';

  // Count how many TFs align with trade direction
  const tfs = [monthly, weekly, daily, h4, h1, m30, m15].filter(Boolean);
  const aligned = tfs.filter(tf => isBearish(tf) === (direction === 'bearish'));
  const alignedCount = aligned.length;

  // ── LOTTO CLASSIFICATION ──────────────────────────────────────
  // Short DTE + high risk + volatility play
  if (dte <= 1) {
    return {
      type:       'LOTTO',
      label:      '🎲 LOTTO',
      dte,
      alignedTFs: alignedCount,
      reason:     `${dte}DTE — high risk volatility play`,
      holdRules:  'Hold through target or stop. No adds.',
      dteRange:   '0–1 day',
      sizing:     'Under $1.20 = 2 contracts max. Treat as lotto.',
      stopRule:   '50% premium loss = stop',
      targets:    'T1: 50% | T2: 100% | Let runners fly',
    };
  }

  // ── SWING CLASSIFICATION ──────────────────────────────────────
  // Per Strat: Swing = Monthly + Weekly + Daily continuity
  // DTE 7–45 days, multi-day hold
  const isSwing =
    dte >= 7 &&
    weekly && daily &&
    isBearish(weekly) === (direction === 'bearish') &&
    isBearish(daily)  === (direction === 'bearish');

  if (isSwing) {
    // Check for monthly confluence (optional but adds strength)
    const hasMonthly = monthly && isBearish(monthly) === (direction === 'bearish');
    const tfsAligned = [monthly, weekly, daily].filter((tf, i) => {
      if (!tf) return false;
      return isBearish(tf) === (direction === 'bearish');
    }).length;

    return {
      type:       'SWING',
      label:      '🔄 SWING TRADE',
      dte,
      alignedTFs: tfsAligned,
      reason:     `Weekly + Daily both ${direction} | ${dte}DTE`,
      holdRules:  'Hold 1–5 days. Normal pullbacks expected. Don\'t panic sell.',
      dteRange:   '7–45 days',
      sizing:     'Standard sizing. 1–2 contracts per rules.',
      stopRule:   '50% premium OR stock invalidation level',
      targets:    'T1: 50% gain | T2: 100% | Trail runner',
      extraNote:  hasMonthly ? '✅ Monthly confirms — strongest swing setup' : null,
    };
  }

  // ── DAY TRADE CLASSIFICATION ──────────────────────────────────
  // Per Strat: Day trade = Daily + 4H + 15M continuity
  // DTE 2–6 days, same day or next day hold max
  const isDayTrade =
    dte >= 2 && dte <= 6 &&
    daily && isBearish(daily) === (direction === 'bearish');

  if (isDayTrade) {
    const has4H  = h4  && isBearish(h4)  === (direction === 'bearish');
    const has15M = m15 && isBearish(m15) === (direction === 'bearish');
    const tfsAligned = [daily, h4, m15].filter(tf => tf && isBearish(tf) === (direction === 'bearish')).length;

    return {
      type:       'DAY',
      label:      '⚡ DAY TRADE',
      dte,
      alignedTFs: tfsAligned,
      reason:     `Daily ${direction} | ${dte}DTE | Intraday window`,
      holdRules:  'Close by end of session. Do not hold overnight.',
      dteRange:   '2–6 days',
      sizing:     'Standard sizing per premium rules.',
      stopRule:   '50% premium loss = stop. No exceptions.',
      targets:    'T1: 50% gain | Sell 80% | Let 20% run to T2',
      extraNote:  has4H && has15M ? '🔥 4H + 15M aligned — high conviction entry' :
                  has4H           ? '✅ 4H aligned' :
                  has15M          ? '✅ 15M triggered' : null,
    };
  }

  // ── DEFAULT — use DTE as tiebreaker ──────────────────────────
  if (dte >= 7) {
    return {
      type:       'SWING',
      label:      '🔄 SWING TRADE',
      dte,
      alignedTFs: alignedCount,
      reason:     `${dte}DTE — longer expiry suggests swing`,
      holdRules:  'Give it room. Check daily at 9:15AM.',
      dteRange:   '7+ days',
      sizing:     'Standard',
      stopRule:   '50% premium or stock invalidation',
      targets:    'T1: 50% | T2: 100%',
    };
  }

  return {
    type:       'DAY',
    label:      '⚡ DAY TRADE',
    dte,
    alignedTFs: alignedCount,
    reason:     `${dte}DTE — short expiry, treat as day trade`,
    holdRules:  'Close same session if possible.',
    dteRange:   '2–6 days',
    sizing:     'Standard',
    stopRule:   '50% premium loss',
    targets:    'T1: 50% | T2: 100%',
  };
}

// ── HELPERS ───────────────────────────────────────────────────────
function isBearish(barType) {
  return ['2D', 'F2U', '3'].includes(barType);
}

function isBullish(barType) {
  return ['2U', 'F2D'].includes(barType);
}

// ── CONFLUENCE SCORER ─────────────────────────────────────────────
// How many timeframes agree with the trade direction
// Returns score and emoji label
function getConfluenceScore(tfData, direction) {
  const tfs = {
    Monthly: tfData.monthly,
    Weekly:  tfData.weekly,
    Daily:   tfData.daily,
    '4H':    tfData.h4,
    '1H':    tfData.h1,
    '30M':   tfData.m30,
    '15M':   tfData.m15,
  };

  const isBear = direction === 'bearish';
  let aligned = 0;
  let total   = 0;
  const details = [];

  for (const [name, bar] of Object.entries(tfs)) {
    if (!bar) continue;
    total++;
    const matches = isBear ? isBearish(bar) : isBullish(bar);
    if (matches) {
      aligned++;
      details.push(`${name}:${bar}✅`);
    } else {
      details.push(`${name}:${bar}❌`);
    }
  }

  const pct = total > 0 ? Math.round((aligned / total) * 100) : 0;
  const emoji = aligned >= 4 ? '🔥' : aligned >= 2 ? '⚠️' : '❌';

  return {
    aligned,
    total,
    pct,
    emoji,
    label:   `${emoji} ${aligned}/${total} TFs aligned`,
    details,
  };
}

// ── IDENTIFY SETUP COMBO ──────────────────────────────────────────
// Given 3 consecutive bar types, identifies the Strat combo
function identifyCombo(bar1, bar2, bar3 = null) {
  if (!bar1 || !bar2) return null;

  // Check for Failed 2 first
  if (bar1 === BAR.FAILED_2U) return COMBOS['F2U'];
  if (bar1 === BAR.FAILED_2D) return COMBOS['F2D'];

  // 3-bar combos
  if (bar3) {
    const key3 = `${bar1}-${bar2}-${bar3}`;
    if (COMBOS[key3]) return COMBOS[key3];
  }

  // 2-bar combos
  const key2 = `${bar1}-${bar2}`;
  if (COMBOS[key2]) return COMBOS[key2];

  // Single bar + type
  if (bar1 === '1') {
    if (bar2 === '2U') return COMBOS['1-2U'];
    if (bar2 === '2D') return COMBOS['1-2D'];
    if (bar2 === '3')  return COMBOS['1-3'];
  }

  return null;
}

// ── 322 STRATEGY CHECK ────────────────────────────────────────────
// From _322_FIRST_LIVE_STRATEGY_AYCE_ATH_1.pdf
// 8AM = 3 (outside), 9AM = 2 (directional), trade at 10AM
function check322Setup(bar8am, bar9am) {
  if (bar8am !== '3') return null;
  if (!['2U', '2D'].includes(bar9am)) return null;

  const direction = bar9am === '2U' ? 'puts at 10AM' : 'calls at 10AM';
  const tradeDir  = bar9am === '2U' ? 'bearish' : 'bullish';

  return {
    strategy:  '322 First Live Strategy',
    valid:     true,
    direction: tradeDir,
    entry:     `10AM reversal — ${direction}`,
    target:    bar9am === '2U' ? 'Low of 8AM (3) candle' : 'High of 8AM (3) candle',
    stop:      '60-minute flip = invalidation',
  };
}

// ── 4HR RETRIGGER CHECK ───────────────────────────────────────────
// From _4_HR_REV_RETRIGGER_STRATEGY_Detailed_Breakdown.pdf
// 4AM = 2 directional, 8AM = reversal 2, entry at trigger
function check4HRRetrigger(bar4am, bar8am) {
  if (!bar4am || !bar8am) return null;
  if (!['2U', '2D'].includes(bar4am)) return null;

  const isValid =
    (bar4am === '2D' && bar8am === '2U') ||
    (bar4am === '2U' && bar8am === '2D');

  if (!isValid) return null;

  const direction = bar4am === '2D' ? 'bullish' : 'bearish';
  const entry     = bar4am === '2D'
    ? 'Enter CALLS on break above 4AM high'
    : 'Enter PUTS on break below 4AM low';

  return {
    strategy:  '4HR Re-Trigger Strategy',
    valid:     true,
    direction,
    entry,
    target:    bar4am === '2D' ? 'High of 4PM ET candle' : 'Low of 4PM ET candle',
    note:      'Be ready — entries may trigger immediately at 9:30AM',
  };
}

// ── FAILED 9 CHECK ────────────────────────────────────────────────
// From Failed_9_PDF_2.pdf
// 8AM candle sets range, 9AM goes 2U/2D, then fails → 3 bar
function checkFailed9(bar8am, bar9am, priceVs50pct) {
  if (!bar8am || !bar9am) return null;
  if (!['2U', '2D'].includes(bar9am)) return null;
  if (priceVs50pct === 'triggered_premarket') return null; // invalid

  return {
    strategy: 'Failed 9',
    valid:    true,
    direction: bar9am === '2U' ? 'bearish' : 'bullish',
    entry:    `9AM went ${bar9am} — wait for 50% of 8AM to trigger → outside 3 forms`,
    target:   'Opposite end of 8AM candle',
    stop:     bar9am === '2U' ? '10AM 2U continuation (high of 9AM)' : '10AM 2D continuation',
    note:     'Fast move — happens in first 5 minutes after open',
  };
}

module.exports = {
  BAR,
  COMBOS,
  classifyTrade,
  getConfluenceScore,
  identifyCombo,
  check322Setup,
  check4HRRetrigger,
  checkFailed9,
  isBearish,
  isBullish,
};
