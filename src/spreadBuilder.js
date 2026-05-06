// =============================================================================
// SPREAD BUILDER — Phase 4.31 (May 5 2026)
//
// Builds multi-leg spread tickets for one-click TS MCP fire. AB's pain:
// setting up a 2-leg or 4-leg ticket in Titan UI takes ~30s of careful
// strike + side + qty entry — error-prone (wrong sign on a leg flips the
// risk profile) and a leaky edge during fast tape. This module turns that
// into a buildSpreadTicket({...}) → ticket → place-order one-click.
//
// SUPPORTED TYPES:
//   - BULL_CALL_DEBIT     : long lower-K call + short higher-K call (debit)
//   - BEAR_PUT_DEBIT      : long higher-K put  + short lower-K put  (debit)
//   - BULL_PUT_CREDIT     : short higher-K put + long lower-K put   (credit)
//   - BEAR_CALL_CREDIT    : short lower-K call + long higher-K call (credit)
//   - IRON_CONDOR         : 4-leg, two short verticals (credit, neutral)
//   - CALENDAR_CALL       : long back-month + short front-month, same K (debit)
//   - CALENDAR_PUT        : same as above on puts
//   - BUTTERFLY_CALL      : 1×long + 2×short + 1×long, same expiry (debit)
//
// PUBLIC API:
//   buildSpreadTicket(opts)         → { ok, ticket, riskReward, legs }
//   suggestSpreadForCard(card, ctx) → { primary: {...}, secondary: {...} }
//   getSpreadTypes()                → string[] (list of supported types)
//   getTypeMeta(type)               → { label, direction, legCount, ... }
//
// TS TICKET FORMAT (post-orderExecutor envelope):
//   {
//     AccountID: '11975462' | 'SIM3142118M',
//     Symbol:    null,                 // multi-leg uses Legs[]
//     OrderType: 'Limit',
//     LimitPrice: '2.36',
//     TradeAction: 'BUY' | 'SELL',     // for net debit/credit direction
//     TimeInForce: { Duration: 'GTC' },
//     Route: 'Intelligent',
//     Legs: [
//       { Symbol: 'META 260515C610', Quantity: '1', TradeAction: 'BUYTOOPEN' },
//       ...
//     ],
//     OSOs: [{ Type: 'BRK', Orders: [...stop, ...tp1] }],
//   }
//
// OPRA SYMBOL FORMAT (TS API):
//   "META 260515C610"   ← root + space + YYMMDD + C/P + strike (no zero pad)
//   Strike formatted as integer if whole, else "610.5"
//
// =============================================================================

'use strict';

// =============================================================================
// SPREAD TYPE DEFINITIONS
// =============================================================================
var SPREAD_TYPES = {
  BULL_CALL_DEBIT: {
    label:       'Bull Call Debit Spread',
    direction:   'bullish',
    legCount:    2,
    netSign:     'debit',           // pay net premium
    expectsRise: true,
    legs: [
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'long'  },  // lower K
      { side: 'SELLTOOPEN', type: 'CALL', strikeKey: 'short' },  // higher K
    ],
  },
  BEAR_PUT_DEBIT: {
    label:       'Bear Put Debit Spread',
    direction:   'bearish',
    legCount:    2,
    netSign:     'debit',
    expectsRise: false,
    legs: [
      { side: 'BUYTOOPEN',  type: 'PUT',  strikeKey: 'long'  },  // higher K
      { side: 'SELLTOOPEN', type: 'PUT',  strikeKey: 'short' },  // lower K
    ],
  },
  BULL_PUT_CREDIT: {
    label:       'Bull Put Credit Spread',
    direction:   'bullish',
    legCount:    2,
    netSign:     'credit',
    expectsRise: true,
    legs: [
      { side: 'SELLTOOPEN', type: 'PUT',  strikeKey: 'short' },  // higher K
      { side: 'BUYTOOPEN',  type: 'PUT',  strikeKey: 'long'  },  // lower K
    ],
  },
  BEAR_CALL_CREDIT: {
    label:       'Bear Call Credit Spread',
    direction:   'bearish',
    legCount:    2,
    netSign:     'credit',
    expectsRise: false,
    legs: [
      { side: 'SELLTOOPEN', type: 'CALL', strikeKey: 'short' },  // lower K
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'long'  },  // higher K
    ],
  },
  IRON_CONDOR: {
    label:       'Iron Condor',
    direction:   'neutral',
    legCount:    4,
    netSign:     'credit',
    expectsRise: null,
    legs: [
      { side: 'SELLTOOPEN', type: 'PUT',  strikeKey: 'putShort'  },
      { side: 'BUYTOOPEN',  type: 'PUT',  strikeKey: 'putLong'   },
      { side: 'SELLTOOPEN', type: 'CALL', strikeKey: 'callShort' },
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'callLong'  },
    ],
  },
  CALENDAR_CALL: {
    label:       'Call Calendar Spread',
    direction:   'neutral-bullish',
    legCount:    2,
    netSign:     'debit',
    expectsRise: null,
    needsTwoExpiries: true,
    legs: [
      { side: 'SELLTOOPEN', type: 'CALL', strikeKey: 'atm', expiryKey: 'front' },
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'atm', expiryKey: 'back'  },
    ],
  },
  CALENDAR_PUT: {
    label:       'Put Calendar Spread',
    direction:   'neutral-bearish',
    legCount:    2,
    netSign:     'debit',
    expectsRise: null,
    needsTwoExpiries: true,
    legs: [
      { side: 'SELLTOOPEN', type: 'PUT',  strikeKey: 'atm', expiryKey: 'front' },
      { side: 'BUYTOOPEN',  type: 'PUT',  strikeKey: 'atm', expiryKey: 'back'  },
    ],
  },
  BUTTERFLY_CALL: {
    label:       'Call Butterfly',
    direction:   'neutral',
    legCount:    3,            // 3 distinct strikes (1+2+1 = 4 contracts)
    netSign:     'debit',
    expectsRise: null,
    legs: [
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'wing1', qtyMult: 1 },
      { side: 'SELLTOOPEN', type: 'CALL', strikeKey: 'body',  qtyMult: 2 },
      { side: 'BUYTOOPEN',  type: 'CALL', strikeKey: 'wing2', qtyMult: 1 },
    ],
  },
};

function getSpreadTypes() { return Object.keys(SPREAD_TYPES); }
function getTypeMeta(type) {
  if (!type || !SPREAD_TYPES[type]) return null;
  var def = SPREAD_TYPES[type];
  return {
    type: type,
    label: def.label,
    direction: def.direction,
    legCount: def.legCount,
    netSign: def.netSign,
    needsTwoExpiries: !!def.needsTwoExpiries,
  };
}

// =============================================================================
// OPRA SYMBOL CONSTRUCTION (TS format)
//
//   buildOpraSymbol('META', '2026-05-15', 610, 'CALL') → 'META 260515C610'
//   buildOpraSymbol('SPY',  '2026-05-09', 692.5, 'PUT') → 'SPY 260509P692.5'
//
// TS uses YYMMDD (2-digit year) and strike with optional decimal — no zero pad.
// =============================================================================
function buildOpraSymbol(root, expiry, strike, type) {
  if (!root || !expiry || strike == null || !type) return null;
  // Expiry can be YYYY-MM-DD or YYYYMMDD
  var clean = String(expiry).replace(/-/g, '');
  if (clean.length !== 8) return null;
  var yymmdd = clean.slice(2);  // 260515
  var cp = String(type).toUpperCase().charAt(0);   // C or P
  // Strike: int if whole, else 1 decimal
  var k = parseFloat(strike);
  var strikeStr = (k === Math.floor(k)) ? String(Math.floor(k)) : String(k.toFixed(1));
  return String(root).toUpperCase() + ' ' + yymmdd + cp + strikeStr;
}

// =============================================================================
// LEG VALIDATION
// =============================================================================
function validateInputs(opts) {
  var errs = [];
  if (!opts) errs.push('opts missing');
  else {
    if (!opts.ticker) errs.push('ticker required');
    if (!opts.type) errs.push('type required');
    else if (!SPREAD_TYPES[opts.type]) errs.push('unknown spread type: ' + opts.type);
    if (!opts.expiry) errs.push('expiry required');
    if (!opts.strikes) errs.push('strikes required');
    if (!opts.qty || opts.qty < 1) errs.push('qty must be >=1');
    if (opts.netLimit == null) errs.push('netLimit required (net debit/credit price)');

    var def = opts.type ? SPREAD_TYPES[opts.type] : null;
    if (def && def.needsTwoExpiries && !opts.backExpiry) {
      errs.push('backExpiry required for ' + opts.type);
    }

    // Strike map sanity
    if (def && opts.strikes) {
      def.legs.forEach(function(leg) {
        var k = opts.strikes[leg.strikeKey];
        if (k == null || !isFinite(parseFloat(k))) {
          errs.push('strikes.' + leg.strikeKey + ' missing/invalid');
        }
      });
    }
  }
  return errs;
}

// =============================================================================
// RISK / REWARD COMPUTATION
//
// Returns { maxProfit, maxLoss, breakeven, pop, costBasis }
// costBasis is the dollar amount put up per spread (debit) or
// margin required per spread (credit).
// =============================================================================
function computeRiskReward(opts) {
  var def = SPREAD_TYPES[opts.type];
  var net = parseFloat(opts.netLimit);
  var s = opts.strikes;
  if (!def || !isFinite(net)) return null;

  var R = { maxProfit: null, maxLoss: null, breakeven: null, pop: null, costBasis: null, structure: '' };

  if (opts.type === 'BULL_CALL_DEBIT') {
    var width = s.short - s.long;
    R.maxProfit = round2((width - net) * 100 * (opts.qty || 1));
    R.maxLoss   = round2(net * 100 * (opts.qty || 1));
    R.breakeven = round2(s.long + net);
    R.costBasis = R.maxLoss;
    R.structure = 'long ' + s.long + 'C / short ' + s.short + 'C @ $' + net.toFixed(2) + ' debit';
  } else if (opts.type === 'BEAR_PUT_DEBIT') {
    var widthBP = s.long - s.short;
    R.maxProfit = round2((widthBP - net) * 100 * (opts.qty || 1));
    R.maxLoss   = round2(net * 100 * (opts.qty || 1));
    R.breakeven = round2(s.long - net);
    R.costBasis = R.maxLoss;
    R.structure = 'long ' + s.long + 'P / short ' + s.short + 'P @ $' + net.toFixed(2) + ' debit';
  } else if (opts.type === 'BULL_PUT_CREDIT') {
    var widthBPC = s.short - s.long;
    R.maxProfit = round2(net * 100 * (opts.qty || 1));
    R.maxLoss   = round2((widthBPC - net) * 100 * (opts.qty || 1));
    R.breakeven = round2(s.short - net);
    R.costBasis = R.maxLoss;     // margin = max loss for defined-risk credit spread
    R.structure = 'short ' + s.short + 'P / long ' + s.long + 'P @ $' + net.toFixed(2) + ' credit';
  } else if (opts.type === 'BEAR_CALL_CREDIT') {
    var widthBCC = s.long - s.short;
    R.maxProfit = round2(net * 100 * (opts.qty || 1));
    R.maxLoss   = round2((widthBCC - net) * 100 * (opts.qty || 1));
    R.breakeven = round2(s.short + net);
    R.costBasis = R.maxLoss;
    R.structure = 'short ' + s.short + 'C / long ' + s.long + 'C @ $' + net.toFixed(2) + ' credit';
  } else if (opts.type === 'IRON_CONDOR') {
    var putWingWidth  = s.putShort  - s.putLong;
    var callWingWidth = s.callLong  - s.callShort;
    var maxWingWidth  = Math.max(putWingWidth, callWingWidth);
    R.maxProfit = round2(net * 100 * (opts.qty || 1));
    R.maxLoss   = round2((maxWingWidth - net) * 100 * (opts.qty || 1));
    R.breakeven = { lower: round2(s.putShort - net), upper: round2(s.callShort + net) };
    R.costBasis = R.maxLoss;
    R.structure = 'IC ' + s.putLong + 'P/' + s.putShort + 'P/' + s.callShort + 'C/' + s.callLong + 'C @ $' + net.toFixed(2) + ' credit';
  } else if (opts.type === 'CALENDAR_CALL' || opts.type === 'CALENDAR_PUT') {
    // Calendar max profit can't be computed without vol model — flag pessimistic
    R.maxProfit = null;          // depends on terminal IV at front expiry
    R.maxLoss   = round2(net * 100 * (opts.qty || 1));
    R.breakeven = null;
    R.costBasis = R.maxLoss;
    R.structure = (opts.type === 'CALENDAR_CALL' ? 'CAL CALL' : 'CAL PUT') + ' @ ' + s.atm +
      ' front ' + opts.expiry + ' / back ' + opts.backExpiry + ' @ $' + net.toFixed(2) + ' debit';
  } else if (opts.type === 'BUTTERFLY_CALL') {
    var bfWidth = s.body - s.wing1;     // assume symmetric
    R.maxProfit = round2((bfWidth - net) * 100 * (opts.qty || 1));
    R.maxLoss   = round2(net * 100 * (opts.qty || 1));
    R.breakeven = { lower: round2(s.wing1 + net), upper: round2(s.wing2 - net) };
    R.costBasis = R.maxLoss;
    R.structure = 'BFLY ' + s.wing1 + 'C/' + s.body + 'Cx2/' + s.wing2 + 'C @ $' + net.toFixed(2) + ' debit';
  }

  // Probability of profit heuristic (rough, no vol model)
  // Defined-risk credit spread → POP ≈ 1 - (maxLoss / wingWidth)
  if (def.netSign === 'credit' && R.maxLoss && R.maxProfit) {
    R.pop = round2(R.maxProfit / (R.maxProfit + R.maxLoss));
  }
  return R;
}

// =============================================================================
// BUILD MULTI-LEG TS LEGS[] ARRAY
// =============================================================================
function buildLegs(opts) {
  var def = SPREAD_TYPES[opts.type];
  if (!def) return null;
  var rootSym = String(opts.ticker).toUpperCase();
  var qty = parseInt(opts.qty || 1);
  var legs = [];
  for (var i = 0; i < def.legs.length; i++) {
    var leg = def.legs[i];
    var strike = opts.strikes[leg.strikeKey];
    var legExpiry = (leg.expiryKey === 'back') ? opts.backExpiry : opts.expiry;
    var legSym = buildOpraSymbol(rootSym, legExpiry, strike, leg.type);
    if (!legSym) return null;
    var legQty = qty * (leg.qtyMult || 1);
    legs.push({
      Symbol:      legSym,
      Quantity:    String(legQty),
      TradeAction: leg.side,
      strike:      strike,
      type:        leg.type,
      side:        leg.side,
      expiry:      legExpiry,
    });
  }
  return legs;
}

// =============================================================================
// BUILD OSO BRACKET (stop + tp child orders)
//
// For DEBIT spreads (we paid premium):
//   stop  = close at -bracketStopPct of debit (e.g. -50% means premium drops to 50%)
//   tp1   = close at +bracketTp1Pct (e.g. +25% means +25% on debit paid)
//   close action = SELL (we own the debit)
//
// For CREDIT spreads (we collected premium):
//   stop  = close at +bracketStopPct of credit (e.g. spread doubles → max loss)
//   tp1   = close at -bracketTp1Pct (premium drops to ~50% of original = capture half)
//   close action = BUY (we owe the credit, buy back to close)
//
// brackets shape: { stopPct: number (% of net), tp1Pct: number (% of net) }
//
// Legs in close order are MIRRORED actions:
//   BUYTOOPEN → SELLTOCLOSE  ;  SELLTOOPEN → BUYTOCLOSE
// =============================================================================
function buildOsoBracket(legs, netLimit, brackets, def) {
  if (!brackets || (!brackets.stopPct && !brackets.tp1Pct)) return null;
  var children = [];
  var stopPct = brackets.stopPct || null;
  var tp1Pct  = brackets.tp1Pct  || null;
  var stopPrice = null;
  var tpPrice   = null;
  var net = parseFloat(netLimit);

  if (def.netSign === 'debit') {
    // DEBIT — close legs at SELL-side; net premium dropped means we lost
    if (stopPct) stopPrice = round2(net * (1 - stopPct / 100));   // e.g. -50% → 0.50 × original
    if (tp1Pct)  tpPrice   = round2(net * (1 + tp1Pct / 100));    // e.g. +25%
  } else {
    // CREDIT — close legs at BUY-side; rising premium means we lost
    if (stopPct) stopPrice = round2(net * (1 + stopPct / 100));   // e.g. spread doubled
    if (tp1Pct)  tpPrice   = round2(net * (1 - tp1Pct / 100));    // capture portion
  }

  var closeLegs = legs.map(function(L) {
    return {
      Symbol:      L.Symbol,
      Quantity:    L.Quantity,
      TradeAction: L.TradeAction === 'BUYTOOPEN' ? 'SELLTOCLOSE' : 'BUYTOCLOSE',
    };
  });

  if (stopPrice != null && stopPrice > 0) {
    children.push({
      Type:       'NORMAL',
      OrderType:  'StopLimit',
      StopPrice:  String(stopPrice),
      LimitPrice: String(round2(stopPrice * (def.netSign === 'debit' ? 0.90 : 1.10))),  // slip buffer
      TradeAction: def.netSign === 'debit' ? 'SELL' : 'BUY',
      Legs:       closeLegs.map(function(L) { return Object.assign({}, L); }),
      TimeInForce: { Duration: 'GTC' },
      Route:       'Intelligent',
      _purpose:    'STOP',
    });
  }
  if (tpPrice != null && tpPrice > 0) {
    children.push({
      Type:        'NORMAL',
      OrderType:   'Limit',
      LimitPrice:  String(tpPrice),
      TradeAction: def.netSign === 'debit' ? 'SELL' : 'BUY',
      Legs:        closeLegs.map(function(L) { return Object.assign({}, L); }),
      TimeInForce: { Duration: 'GTC' },
      Route:        'Intelligent',
      _purpose:     'TP1',
    });
  }

  if (!children.length) return null;
  return {
    Type:   children.length === 2 ? 'BRK' : 'NORMAL',
    Orders: children,
  };
}

// =============================================================================
// BUILD COMPLETE TS TICKET
//
// Returns:
//   { ok, ticket, legs, riskReward, summary, errors? }
// =============================================================================
function buildSpreadTicket(opts) {
  var errs = validateInputs(opts);
  if (errs.length) return { ok: false, errors: errs };

  var def = SPREAD_TYPES[opts.type];
  var rootSym = String(opts.ticker).toUpperCase();
  var account = opts.account || (opts.live === true ? '11975462' : 'SIM3142118M');

  // Build legs
  var legs = buildLegs(opts);
  if (!legs) return { ok: false, errors: ['leg construction failed'] };

  // Compute risk/reward
  var riskReward = computeRiskReward(opts);
  if (!riskReward) return { ok: false, errors: ['risk/reward compute failed'] };

  // Net limit price formatted (debit positive, credit negative in some envelopes)
  var netLimitStr = String(parseFloat(opts.netLimit).toFixed(2));

  // Outer order action: BUY for debit, SELL for credit (TS convention)
  var outerAction = (def.netSign === 'debit') ? 'BUY' : 'SELL';

  // Build the parent TS order
  var ticket = {
    AccountID:   account,
    Symbol:      null,  // multi-leg uses Legs[]
    OrderType:   'Limit',
    LimitPrice:  netLimitStr,
    TradeAction: outerAction,
    TimeInForce: { Duration: opts.duration || 'GTC' },
    Route:       'Intelligent',
    Legs:        legs.map(function(L) {
      return {
        Symbol:      L.Symbol,
        Quantity:    L.Quantity,
        TradeAction: L.TradeAction,
      };
    }),
  };

  // Optional OSO brackets
  if (opts.brackets) {
    var oso = buildOsoBracket(legs, opts.netLimit, opts.brackets, def);
    if (oso) ticket.OSOs = [oso];
  }

  // Optional underlying-trigger activation rule (for queued conditional fires)
  if (opts.trigger && opts.trigger.symbol && opts.trigger.price && opts.trigger.predicate) {
    var pred = String(opts.trigger.predicate).toLowerCase();
    var tsPred = (pred === 'above' || pred === 'gt' || pred === 'gte') ? 'Gt' : 'Lt';
    ticket.AdvancedOptions = {
      MarketActivationRules: [{
        RuleType:   'Price',
        Symbol:     String(opts.trigger.symbol).toUpperCase(),
        Predicate:  tsPred,
        TriggerKey: 'STT',
        Price:      String(parseFloat(opts.trigger.price).toFixed(2)),
      }],
    };
  }

  // Titan-card style summary string for one-line review
  var qtyStr = String(opts.qty || 1) + 'ct';
  var titanCard = qtyStr + ' ' + def.label + ' · ' + rootSym + ' · ' + opts.expiry +
    ' · ' + riskReward.structure +
    (riskReward.maxProfit != null ? ' · MaxP $' + riskReward.maxProfit : '') +
    (riskReward.maxLoss != null   ? ' / MaxL $' + riskReward.maxLoss   : '');

  return {
    ok:        true,
    type:      opts.type,
    label:     def.label,
    direction: def.direction,
    netSign:   def.netSign,
    ticker:    rootSym,
    qty:       opts.qty || 1,
    expiry:    opts.expiry,
    strikes:   opts.strikes,
    netLimit:  parseFloat(netLimitStr),
    account:   account,
    legs:      legs,
    riskReward: riskReward,
    summary: {
      titanCard:   titanCard,
      legCount:    legs.length,
      structure:   riskReward.structure,
      maxProfit:   riskReward.maxProfit,
      maxLoss:     riskReward.maxLoss,
      breakeven:   riskReward.breakeven,
      pop:         riskReward.pop,
      costBasis:   riskReward.costBasis,
      brackets:    opts.brackets || null,
      hasTrigger:  !!opts.trigger,
    },
    ticket:   ticket,
  };
}

// =============================================================================
// SPREAD AUTO-SUGGESTION
//
// Maps scanner card attributes to recommended spread types.
// Inputs:
//   card: { ticker, direction, strategyType, fireGrade, spot, ... }
//   ctx:  { tape: 'RISK_ON'|'RISK_OFF'|'MIXED', vix?: number, atmIV?: number }
//
// Returns:
//   { primary: { type, rationale, strikeOffsets }, secondary: ?{...} }
//
// Heuristic:
//   BREAKOUT + bullish + RISK_ON                  → BULL_CALL_DEBIT (primary)
//                                                 → BULL_PUT_CREDIT (secondary, income)
//   BREAKOUT + bearish + RISK_OFF                 → BEAR_PUT_DEBIT  (primary)
//                                                 → BEAR_CALL_CREDIT (secondary)
//   PULLBACK_RETEST + bullish                     → BULL_CALL_DEBIT (cheaper than CALL)
//   COIL + neutral + low VIX                      → IRON_CONDOR
//   REVERSAL + counter-tape                       → CALENDAR (theta + vol expansion)
//   High IV (>50%) + bullish                      → BULL_PUT_CREDIT (sell vol)
//   Low IV  (<25%) + bullish                      → BULL_CALL_DEBIT (buy vol)
// =============================================================================
function suggestSpreadForCard(card, ctx) {
  card = card || {};
  ctx = ctx || {};
  var dir = String(card.direction || '').toLowerCase();
  var isLong = dir === 'long' || dir === 'call' || dir === 'bullish' || dir === 'bull';
  var isShort = dir === 'short' || dir === 'put' || dir === 'bearish' || dir === 'bear';
  var st = String(card.strategyType || '').toUpperCase();
  var tape = String(ctx.tape || '').toUpperCase();
  var iv = parseFloat(ctx.atmIV || 0);
  var vix = parseFloat(ctx.vix || 0);

  var spot = parseFloat(card.spot || 0);
  if (!spot || !isFinite(spot)) {
    return { primary: null, secondary: null, reason: 'no spot price' };
  }

  // IV regime
  var ivHigh = iv > 0.45 || vix > 22;
  var ivLow  = iv > 0 && iv < 0.22;

  function pickStrikes(type, mode) {
    // Generic 1%-wide vertical with anchor near ATM
    var wide = Math.max(spot * 0.01, 1);  // 1% of spot, min $1 wide
    if (type === 'BULL_CALL_DEBIT') {
      var lk = roundStrike(spot, spot);                  // ATM long
      var sk = roundStrike(spot + wide * 2, spot);       // 2% OTM short
      return { long: lk, short: sk };
    }
    if (type === 'BEAR_PUT_DEBIT') {
      var lk2 = roundStrike(spot, spot);
      var sk2 = roundStrike(spot - wide * 2, spot);
      return { long: lk2, short: sk2 };
    }
    if (type === 'BULL_PUT_CREDIT') {
      var sk3 = roundStrike(spot - wide * 1.5, spot);    // 1.5% OTM short
      var lk3 = roundStrike(spot - wide * 3, spot);      // 3% OTM long (1.5% wing)
      return { short: sk3, long: lk3 };
    }
    if (type === 'BEAR_CALL_CREDIT') {
      var sk4 = roundStrike(spot + wide * 1.5, spot);
      var lk4 = roundStrike(spot + wide * 3, spot);
      return { short: sk4, long: lk4 };
    }
    if (type === 'IRON_CONDOR') {
      return {
        putShort:  roundStrike(spot - wide * 1.5, spot),
        putLong:   roundStrike(spot - wide * 3,   spot),
        callShort: roundStrike(spot + wide * 1.5, spot),
        callLong:  roundStrike(spot + wide * 3,   spot),
      };
    }
    return null;
  }

  var primary   = null;
  var secondary = null;

  if (isLong) {
    if (ivLow || st === 'BREAKOUT' || st === 'PULLBACK_RETEST') {
      primary = {
        type: 'BULL_CALL_DEBIT',
        rationale: 'Long ' + (st || 'directional') + ' with IV ' + (ivLow ? 'low ' : '') + '— buy debit spread for capped premium + leverage',
        strikes: pickStrikes('BULL_CALL_DEBIT'),
      };
    }
    if (tape === 'RISK_ON' || ivHigh) {
      secondary = {
        type: 'BULL_PUT_CREDIT',
        rationale: 'RISK-ON tape ' + (ivHigh ? '+ high IV ' : '') + '— sell put credit spread for income (defined risk)',
        strikes: pickStrikes('BULL_PUT_CREDIT'),
      };
    }
    if (!primary && tape === 'RISK_ON') {
      // Fall back to credit spread when no other primary fits
      primary = secondary;
      secondary = null;
    }
  } else if (isShort) {
    if (ivLow || st === 'BREAKOUT' || st === 'REVERSAL') {
      primary = {
        type: 'BEAR_PUT_DEBIT',
        rationale: 'Short ' + (st || 'directional') + ' with IV ' + (ivLow ? 'low ' : '') + '— buy put debit spread',
        strikes: pickStrikes('BEAR_PUT_DEBIT'),
      };
    }
    if (tape === 'RISK_OFF' || ivHigh) {
      secondary = {
        type: 'BEAR_CALL_CREDIT',
        rationale: 'RISK-OFF tape ' + (ivHigh ? '+ high IV ' : '') + '— sell call credit spread for income',
        strikes: pickStrikes('BEAR_CALL_CREDIT'),
      };
    }
    if (!primary && tape === 'RISK_OFF') {
      primary = secondary;
      secondary = null;
    }
  } else {
    // Neutral / COIL / unknown direction — Iron Condor in low-vol
    if (st === 'COIL' || (!ivHigh && !ivLow)) {
      primary = {
        type: 'IRON_CONDOR',
        rationale: 'Neutral ' + (st || 'range-bound') + ' setup — sell IC for theta capture (defined risk both sides)',
        strikes: pickStrikes('IRON_CONDOR'),
      };
    }
  }

  return {
    primary: primary,
    secondary: secondary,
    context: { tape: tape, ivHigh: ivHigh, ivLow: ivLow, spot: spot },
  };
}

// =============================================================================
// STRIKE GRID — round to typical underlying tick
//   Stocks <$25:    $0.50
//   Stocks $25-100: $1
//   Stocks $100-500: $2.50 (or $5)
//   Stocks >$500:   $5
//   Indices use $5 typical
// =============================================================================
function roundStrike(target, anchor) {
  var ref = anchor || target;
  var grid;
  if (ref < 25) grid = 0.5;
  else if (ref < 100) grid = 1;
  else if (ref < 250) grid = 2.5;
  else if (ref < 500) grid = 5;
  else grid = 5;
  return Math.round(target / grid) * grid;
}

// =============================================================================
// HELPERS
// =============================================================================
function round2(n) { return Math.round(n * 100) / 100; }

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
  buildSpreadTicket:    buildSpreadTicket,
  suggestSpreadForCard: suggestSpreadForCard,
  buildOpraSymbol:      buildOpraSymbol,
  computeRiskReward:    computeRiskReward,
  buildLegs:            buildLegs,
  buildOsoBracket:      buildOsoBracket,
  getSpreadTypes:       getSpreadTypes,
  getTypeMeta:          getTypeMeta,
  roundStrike:          roundStrike,
  SPREAD_TYPES:         SPREAD_TYPES,
};
