// =============================================================================
// STRATEGY PICKER (Apr 29 2026)
//
// Picks the RIGHT options structure for a given setup based on:
//   - Account approval level (Level 1-5 per TradeStation)
//   - Setup conditions (direction strength, IV percentile, catalyst)
//   - Underlying type (cash-settled index vs ETF/stock)
//
// The principle (per AB Apr 29): "one tool for everything doesn't work"
// - Strong directional + low IV  -> Long single leg (cheap)
// - Strong directional + high IV -> Debit vertical (cap IV crush)
// - Vol-crush event (FOMC)       -> Iron condor on XSP/SPX (cash-settled)
// - Earnings into resistance     -> Credit vertical
// - Range-bound + low IV         -> Skip (no edge)
//
// Public API:
//   pickStrategy(setup, accountConfig) -> { type, params, rationale, allowed, level }
// =============================================================================

// Cash-settled European-style indices (preferred for short-leg strategies)
var CASH_SETTLED_INDICES = ['XSP', 'SPX', 'RUT', 'NDX'];
var ETF_INDICES = ['SPY', 'QQQ', 'IWM', 'DIA'];

// Strategy approval level matrix (mirrors the TS account types screenshot)
var STRATEGIES_BY_LEVEL = {
  1: ['COVERED_CALL', 'COVERED_PUT', 'PROTECTIVE_PUT'],
  2: ['LONG_OPTION', 'COVERED_CALL', 'COVERED_PUT', 'PROTECTIVE_PUT', 'CASH_SECURED_PUT_IRA'],
  3: ['LONG_OPTION', 'DEBIT_VERTICAL', 'CREDIT_VERTICAL', 'IRON_CONDOR', 'IRON_BUTTERFLY',
      'BUTTERFLY', 'CALENDAR', 'RATIO_SPREAD', 'COVERED_CALL', 'COVERED_PUT',
      'CASH_SECURED_PUT', 'PROTECTIVE_PUT'],
  4: ['NAKED_PUT'].concat([]),  // adds to Level 3
  5: ['NAKED_CALL', 'NAKED_STRADDLE', 'NAKED_STRANGLE'],  // adds to Level 4
};

// Build the cumulative allowed-strategies set per level
function strategiesAllowedAtLevel(level) {
  var allowed = new Set();
  for (var L = 1; L <= level; L++) {
    (STRATEGIES_BY_LEVEL[L] || []).forEach(function(s) { allowed.add(s); });
  }
  return allowed;
}

// =============================================================================
// MAIN PICKER
// =============================================================================
function pickStrategy(setup, accountConfig) {
  setup = setup || {};
  accountConfig = accountConfig || {};

  var level     = accountConfig.optionsLevel || 3;          // AB is Level 3
  var allowed   = strategiesAllowedAtLevel(level);
  var ticker    = (setup.ticker || '').toUpperCase();
  var direction = setup.direction || 'NONE';                // 'LONG'|'SHORT'|'RANGE'|'NONE'
  var score     = setup.score     || 0;
  var ivp       = setup.ivPercentile || null;               // 0-100; null = unknown
  var catalyst  = setup.catalyst    || 'NONE';              // 'FOMC'|'EARNINGS'|'NONE'
  var rangeBoundExpected = setup.rangeBoundExpected === true;

  var isCashIndex  = CASH_SETTLED_INDICES.indexOf(ticker) >= 0;
  var isETFIndex   = ETF_INDICES.indexOf(ticker) >= 0;

  // -------------------------------------------------------------------------
  // 1. NO SIGNAL -> skip
  // -------------------------------------------------------------------------
  if (direction === 'NONE' || score < 5) {
    return reject('No qualifying setup', { score: score, direction: direction });
  }

  // -------------------------------------------------------------------------
  // 2. VOL-CRUSH EVENTS (FOMC, post-earnings on direction-unclear)
  // -------------------------------------------------------------------------
  if (catalyst === 'FOMC' || (catalyst === 'EARNINGS' && rangeBoundExpected)) {
    if (allowed.has('IRON_CONDOR')) {
      // Prefer cash-settled index; if user is trading ETF, suggest the index equivalent
      var indexTarget = isCashIndex ? ticker
                      : (ticker === 'SPY' ? 'XSP' : ticker === 'QQQ' ? 'NDX' : ticker === 'IWM' ? 'RUT' : ticker);
      var indexNote = (indexTarget !== ticker)
        ? ' (switched ' + ticker + ' -> ' + indexTarget + ' for cash settlement / no early assignment)'
        : '';
      return accept('IRON_CONDOR', {
        underlying: indexTarget,
        shortLegs: '~25 delta',
        longLegs:  '~15 delta',
        dte:       7,  // weeklies for FOMC
        creditTarget: '30-40% of width',
        rationale: 'Vol-crush event - sell premium both sides' + indexNote +
                   '. Cash-settled = no assignment, no early exercise risk. Defined risk to wing width.',
      });
    }
    // Iron fly fallback
    if (allowed.has('IRON_BUTTERFLY')) {
      return accept('IRON_BUTTERFLY', {
        underlying: ticker,
        shortLegs: 'ATM both sides',
        longLegs:  'wings $5-10 wide',
        dte:       7,
        rationale: 'Vol-crush event, profits if price stays at ATM. Cap risk via wings.',
      });
    }
    return reject('Vol-crush setup needs Level 3+ for iron condor/butterfly',
                  { level: level, requires: 3 });
  }

  // -------------------------------------------------------------------------
  // 3. EARNINGS INTO RESISTANCE/SUPPORT (sell IV against the move)
  // -------------------------------------------------------------------------
  if (catalyst === 'EARNINGS' && (direction === 'LONG' || direction === 'SHORT')) {
    // Sell credit vertical against the move (collect inflated IV)
    if (allowed.has('CREDIT_VERTICAL')) {
      var creditSide = direction === 'LONG' ? 'BULL_PUT_SPREAD' : 'BEAR_CALL_SPREAD';
      return accept('CREDIT_VERTICAL', {
        underlying: ticker,
        side:       creditSide,
        shortStrike: '~30 delta',
        longStrike:  '~15 delta',
        dte:        14,
        creditTarget: '33% of width',
        rationale: 'Earnings IV bloated. Sell credit spread - profit from IV crush + directional bias. Defined risk.',
      });
    }
    // Fallback to long if no credit vertical access
    return _longSingleLeg(setup, allowed, level, 'Earnings + directional bias, IV crush will hurt - prefer credit vertical (need Level 3)');
  }

  // -------------------------------------------------------------------------
  // 4. STRONG DIRECTIONAL (no special catalyst)
  // -------------------------------------------------------------------------
  if (direction === 'LONG' || direction === 'SHORT') {
    var ivKnown = (ivp != null);
    // High IV -> debit vertical to cap IV crush risk
    if (ivKnown && ivp >= 60 && allowed.has('DEBIT_VERTICAL')) {
      var debitSide = direction === 'LONG' ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD';
      return accept('DEBIT_VERTICAL', {
        underlying: ticker,
        side:       debitSide,
        longStrike: 'ATM',
        shortStrike: '~+5% OTM',  // 5% above ATM for bull call, below for bear put
        dte:        21,
        debitTarget: '40-50% of width',
        rationale: 'High IV (' + ivp + 'th percentile) - debit vertical caps IV decay. Defined risk, defined reward.',
      });
    }
    // Low/mid IV -> long single leg (cheapest)
    return _longSingleLeg(setup, allowed, level,
      ivKnown ? ('IV ' + ivp + 'th pct - long single leg cost-effective') : 'IV unknown - default to long single leg');
  }

  // -------------------------------------------------------------------------
  // 5. RANGE-BOUND, NON-EVENT (theta play)
  // -------------------------------------------------------------------------
  if (direction === 'RANGE' || rangeBoundExpected) {
    if (allowed.has('IRON_CONDOR') && (isCashIndex || isETFIndex)) {
      var indexTarget2 = isCashIndex ? ticker
                       : (ticker === 'SPY' ? 'XSP' : ticker === 'QQQ' ? 'NDX' : ticker === 'IWM' ? 'RUT' : ticker);
      return accept('IRON_CONDOR', {
        underlying: indexTarget2,
        shortLegs: '~20 delta',
        longLegs:  '~10 delta',
        dte:       30,
        creditTarget: '25-33% of width',
        rationale: 'Range-bound theta play. Cash-settled index = clean execution. Wider wings vs FOMC condor (no event = lower probability of touch).',
      });
    }
    if (allowed.has('CASH_SECURED_PUT')) {
      return accept('CASH_SECURED_PUT', {
        underlying: ticker,
        strike: '~25 delta below spot',
        dte: 30,
        rationale: 'Range-bound + want to acquire shares at discount. Sell put for premium.',
      });
    }
    return reject('Range-bound setup needs Level 3 (iron condor) or Level 2+ for CSP', { level: level });
  }

  return reject('Unhandled setup pattern', { setup: setup });
}

// -------------------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------------------
function _longSingleLeg(setup, allowed, level, rationale) {
  if (!allowed.has('LONG_OPTION')) {
    if (allowed.has('COVERED_CALL') && setup.direction === 'LONG') {
      return accept('COVERED_CALL', {
        underlying: setup.ticker,
        strike: '~10 delta OTM call',
        dte: 30,
        sharesRequired: 100,
        rationale: 'Level 1 only - covered call against 100 shares for income.',
      });
    }
    return reject('Long options require Level 2+', { level: level, requires: 2 });
  }
  return accept('LONG_OPTION', {
    underlying: setup.ticker,
    side:       setup.direction === 'LONG' ? 'CALL' : 'PUT',
    strike:     'ATM',  // can be refined to 0.40-0.55 delta in scoring
    dte:        setup.holdDays ? Math.max(7, setup.holdDays + 7) : 14,
    rationale:  rationale,
  });
}

function accept(type, params) {
  return { ok: true, type: type, params: params, rationale: params.rationale };
}
function reject(reason, ctx) {
  return { ok: false, type: 'SKIP', reason: reason, context: ctx || {} };
}

module.exports = {
  pickStrategy:                pickStrategy,
  strategiesAllowedAtLevel:    strategiesAllowedAtLevel,
  STRATEGIES_BY_LEVEL:         STRATEGIES_BY_LEVEL,
  CASH_SETTLED_INDICES:        CASH_SETTLED_INDICES,
};
