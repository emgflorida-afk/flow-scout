// contractCard.js - Stratum Flow Scout
// Produces Titan-ready contract cards for scanner setups.
// Display-only. Never calls orderExecutor. AB executes in Titan manually.
//
// Per OPERATING_MODEL_apr21.md:
//  - NO auto-fire. Returns data structures only.
//  - Structural stops via delta translation (never flat %).
//  - Match John's exact strike/expiry when source=JSMITH_VIP.
//  - AB's ladder: 10/15/20/25/30.
// -----------------------------------------------------------------

var contractResolver;
try { contractResolver = require('./contractResolver'); } catch(e) { contractResolver = null; }

// -----------------------------------------------------------------
// STOP PIVOT MAP — which stock level acts as structural invalidation
// per signal. Confirmed against stratumbar_method.md (Rob Smith).
// -----------------------------------------------------------------
function getStopPivot(signal, A, B, C) {
  if (!C) return null;

  // BEAR signals — stop ABOVE
  //  Reversals: Failed 2U, Shooter → above the signal bar high (C.h)
  //  Continuations: 2-1-2 Down, 3-1-2 Down → above inside bar high (B.h)
  //  Continuation Down (FTFC-trend): above prior bar high (B.h)
  if (signal === 'Failed 2U' || signal === 'Shooter') return { level: C.h, reason: 'signal bar high' };
  if (signal === '2-1-2 Down' || signal === '3-1-2 Down') return { level: B.h, reason: 'inside bar high' };
  if (signal === 'Continuation Down') return { level: B.h, reason: 'prior bar high' };
  if (signal === '2-2 Reversal Down') return { level: B.h, reason: 'reversal bar high' };
  if (signal === '3-2D Broadening') return { level: C.h, reason: 'outside bar high' };

  // BULL signals — stop BELOW
  //  Reversals: Failed 2D, Hammer → below the signal bar low (C.l)
  //  Continuations: 2-1-2 Up, 3-1-2 Up → below inside bar low (B.l)
  //  Continuation Up (FTFC-trend): below prior bar low (B.l)
  if (signal === 'Failed 2D' || signal === 'Hammer') return { level: C.l, reason: 'signal bar low' };
  if (signal === '2-1-2 Up' || signal === '3-1-2 Up') return { level: B.l, reason: 'inside bar low' };
  if (signal === 'Continuation Up') return { level: B.l, reason: 'prior bar low' };
  if (signal === '2-2 Reversal Up') return { level: B.l, reason: 'reversal bar low' };
  if (signal === '3-2U Broadening') return { level: C.l, reason: 'outside bar low' };

  // Inside / Outside / Compression — no single pivot (breakout could go either way)
  return null;
}

// -----------------------------------------------------------------
// PROJECT PREMIUM TO TRIGGER — AB's key concern.
// At plan time, stock is NOT at trigger. Option premium at trigger
// ≈ currentAsk + (stockMove × delta). This lets AB set a static LMT
// that actually fills when the conditional fires.
// -----------------------------------------------------------------
function projectPremiumAtTrigger(currentAsk, stockPrice, trigger, delta, isCall) {
  if (!currentAsk || !trigger || delta == null) return null;
  var absD = Math.abs(delta);
  var stockMove = trigger - stockPrice;
  // CALL: stock up → premium up. PUT: stock down → premium up.
  var premiumChange = isCall ? (stockMove * absD) : (-stockMove * absD);
  var projected = currentAsk + premiumChange;
  return projected > 0.01 ? +projected.toFixed(2) : 0.01;
}

// -----------------------------------------------------------------
// STRUCTURAL STOP TRANSLATOR
// Converts stock pivot level → option stop price via delta.
// -----------------------------------------------------------------
function translateStructuralStop(opts) {
  var stockTrigger = opts.stockTrigger;
  var stockStopPivot = opts.stockStopPivot;
  var optionEntry = opts.optionEntry;
  var delta = Math.abs(opts.delta || 0);
  var isCall = !!opts.isCall;

  if (!stockTrigger || !stockStopPivot || !optionEntry || !delta) {
    return { optionStop: null, optionStopLimit: null, optionLoss: null, stockMove: null, stopDerivation: 'missing inputs' };
  }

  var stockMove = Math.abs(stockTrigger - stockStopPivot);
  var optionLoss = stockMove * delta;
  var optionStop = Math.max(+(optionEntry - optionLoss).toFixed(2), 0.05);
  var optionStopLimit = Math.max(+(optionStop * 0.93).toFixed(2), 0.05);
  var dir = isCall ? 'drop' : 'rise';

  return {
    optionStop: optionStop,
    optionStopLimit: optionStopLimit,
    optionLoss: +optionLoss.toFixed(2),
    stockMove: +stockMove.toFixed(2),
    stopDerivation: 'stock ' + dir + ' $' + stockMove.toFixed(2) + ' × |Δ| ' + delta.toFixed(2) + ' = $' + optionLoss.toFixed(2) + ' option loss',
  };
}

// -----------------------------------------------------------------
// TP LADDER — AB's new 10/15/20/25/30 ladder (Apr 21 2026)
// Replaces John's 25/50/100. Locks profit on quick pops.
// -----------------------------------------------------------------
function computeTPLadder(entry) {
  if (!entry || entry <= 0) return null;
  return {
    rung1_10pct: +(entry * 1.10).toFixed(2),
    rung2_15pct: +(entry * 1.15).toFixed(2),
    rung3_20pct: +(entry * 1.20).toFixed(2),
    rung4_25pct: +(entry * 1.25).toFixed(2),
    rung5_30pct: +(entry * 1.30).toFixed(2),
    runner: 'no LMT',
  };
}

// -----------------------------------------------------------------
// POSITION SIZER — 2% of ACCOUNT_SIZE env, 1-5 ct range.
// Floor to 1 ct even if loss-per-ct > max (flag via qtyFlag).
// -----------------------------------------------------------------
function sizePosition(opts) {
  var optionEntry = opts.optionEntry;
  var optionStop = opts.optionStop;
  var maxRiskDollars = opts.maxRiskDollars || ((parseFloat(process.env.ACCOUNT_SIZE) || 20000) * 0.02);

  if (!optionEntry || !optionStop || optionEntry <= optionStop) {
    return { recommendedQty: 1, totalCost: optionEntry ? +(optionEntry * 100).toFixed(0) : null, maxLoss: null, riskPctBook: null, qtyFlag: 'invalid inputs' };
  }

  var lossPerCt = (optionEntry - optionStop) * 100;
  var rawQty = Math.floor(maxRiskDollars / lossPerCt);
  var qty = Math.min(Math.max(rawQty, 1), 5);
  var flag = null;
  if (rawQty < 1) flag = 'loss-per-ct exceeds ' + maxRiskDollars.toFixed(0) + ' budget — floored to 1 ct';
  if (rawQty > 5) flag = 'risk budget supports ' + rawQty + ' ct — capped at 5';

  var totalCost = +(optionEntry * qty * 100).toFixed(0);
  var maxLoss = +(lossPerCt * qty).toFixed(0);
  var accountSize = parseFloat(process.env.ACCOUNT_SIZE) || 20000;
  var riskPctBook = +((maxLoss / accountSize) * 100).toFixed(2);

  return { recommendedQty: qty, totalCost: totalCost, maxLoss: maxLoss, riskPctBook: riskPctBook, qtyFlag: flag };
}

// -----------------------------------------------------------------
// ENTRY BUFFER — buffer above projected premium depends on trade context.
// Wider buffer = more likely to fill through volatility spikes at trigger,
// but higher slippage on normal fills.
// -----------------------------------------------------------------
function pickEntryBuffer(context) {
  // context: { timeframe, source, binaryCatalyst }
  if (context.binaryCatalyst) return 0.18;           // Trump day, FOMC, CPI
  if (context.source === 'JSMITH_VIP') return 0.06;  // trade same session John posts
  if (context.timeframe === 'Daily' || context.timeframe === 'Weekly') return 0.12;  // swing, overnight risk
  if (context.timeframe === '4HR' || context.timeframe === '2HR') return 0.08;
  if (context.timeframe === '60MIN' || context.timeframe === '30MIN') return 0.06;
  return 0.10; // default
}

// -----------------------------------------------------------------
// FORMAT TITAN CARD — the copy-paste string AB pastes into Titan.
// Matches the conditional STT ticket format.
// -----------------------------------------------------------------
function formatTitanCard(e) {
  if (!e || !e.contract || !e.entry || !e.structuralStop || !e.tpLadder || !e.sizing) return null;
  var c = e.contract;
  var entry = e.entry;
  var stop = e.structuralStop;
  var tp = e.tpLadder;
  var size = e.sizing;
  var trigOp = e.isCall ? '≥' : '≤';

  var lines = [];
  lines.push(c.optionSymbolDisplay + ' × ' + size.recommendedQty + ' ct');
  lines.push('Trigger: ' + e.ticker + ' ' + trigOp + ' $' + entry.stockTrigger.toFixed(2) + ' · Single Trade Tick');
  lines.push('Entry:   BTO LMT $' + entry.optionLMT.toFixed(2) + ' GTC');
  lines.push('Stop:    STC StopLimit $' + stop.optionStop.toFixed(2) + '/$' + stop.optionStopLimit.toFixed(2));
  lines.push('TP1:     STC LMT $' + tp.rung1_10pct.toFixed(2) + ' (+10%)');
  lines.push('TP2:     STC LMT $' + tp.rung2_15pct.toFixed(2) + ' (+15%)');
  lines.push('TP3:     STC LMT $' + tp.rung3_20pct.toFixed(2) + ' (+20%)');
  lines.push('TP4:     STC LMT $' + tp.rung4_25pct.toFixed(2) + ' (+25%)');
  lines.push('TP5:     STC LMT $' + tp.rung5_30pct.toFixed(2) + ' (+30%)');
  lines.push('Runner:  1 ct, no LMT');
  lines.push('Max Loss: $' + size.maxLoss + ' (' + size.riskPctBook + '% book)');
  return lines.join('\n');
}

// -----------------------------------------------------------------
// 10-SECOND QUOTE CACHE — protects the TS rate limiter on hot scans.
// -----------------------------------------------------------------
var _quoteCache = {};
var QUOTE_TTL_MS = 10000;

async function liveQuote(tsSymbol) {
  if (!contractResolver || !contractResolver.getOptionSnapshot) return null;
  var now = Date.now();
  var cached = _quoteCache[tsSymbol];
  if (cached && (now - cached.ts) < QUOTE_TTL_MS) return cached.snap;
  try {
    var snap = await contractResolver.getOptionSnapshot(tsSymbol);
    _quoteCache[tsSymbol] = { snap: snap, ts: now };
    return snap;
  } catch(e) { return null; }
}

// -----------------------------------------------------------------
// BUILD CARD — orchestrator. Scanner calls this once per directional row.
//
// inputs:
//   ticker        — 'CRWV'
//   direction     — 'BULL' or 'BEAR' (from signalDirectionOf)
//   signal        — 'Failed 2D' / 'Hammer' / etc.
//   bars          — { A, B, C } normalized OHLC bars
//   stockPrice    — current price
//   trigger       — stock trigger level (scanner already computes this)
//   timeframe     — 'Daily' | '4HR' | 'Weekly' | '60MIN' | etc
//   source        — 'SCANNER' | 'JSMITH_VIP' | 'JSMITH_PUBLIC' | 'TV_WATCH'
//   jsmithOverride — optional { strike, expiry } to bypass picker
//   binaryCatalyst — boolean, widen buffer on Trump/FOMC/earnings days
//
// returns: enriched setup object or null if not viable
// -----------------------------------------------------------------
async function buildCard(inputs) {
  if (!contractResolver) return null;
  if (!inputs.ticker || !inputs.direction || !inputs.trigger) return null;
  if (!inputs.bars || !inputs.bars.A || !inputs.bars.B || !inputs.bars.C) return null;

  var isCall = inputs.direction === 'BULL';
  var type = isCall ? 'call' : 'put';

  // Stop pivot from bar structure
  var pivot = getStopPivot(inputs.signal, inputs.bars.A, inputs.bars.B, inputs.bars.C);
  if (!pivot || !pivot.level) return null; // can't build card without structural stop

  // Timeframe → resolver mode
  var mode = 'DAY';
  if (inputs.timeframe === 'Daily' || inputs.timeframe === 'Weekly') mode = 'SWING';

  // Resolve contract (strike + expiry + live quote)
  var contract;
  try {
    if (inputs.source === 'JSMITH_VIP' && inputs.jsmithOverride && inputs.jsmithOverride.expiry) {
      var resolved = await contractResolver.resolveContractWithExpiry(
        inputs.ticker, type, inputs.jsmithOverride.expiry
      );
      if (!resolved || resolved.blocked) return null;
      contract = resolved;
    } else {
      var signalMeta = {
        triggerPrice: inputs.trigger,
        stockPrice: inputs.stockPrice,
        confluence: 6,
        strategy: 'strat',
      };
      contract = await contractResolver.resolveContract(inputs.ticker, type, mode, signalMeta);
      if (!contract || contract.blocked) return null;
    }
  } catch(e) { return null; }

  if (!contract.strike || !contract.expiry || !contract.ask) return null;
  var delta = contract.delta != null ? Math.abs(contract.delta) : (isCall ? 0.40 : -0.40);
  if (!delta) delta = 0.40;

  // Project premium AT trigger — critical for static LMT
  var projectedAtTrigger = projectPremiumAtTrigger(contract.ask, inputs.stockPrice, inputs.trigger, delta, isCall);
  var planPremium = projectedAtTrigger || contract.ask;

  // Buffer selection
  var buffer = pickEntryBuffer({
    timeframe: inputs.timeframe,
    source: inputs.source,
    binaryCatalyst: inputs.binaryCatalyst,
  });
  var optionLMT = +(planPremium * (1 + buffer)).toFixed(2);

  // Structural stop
  var stopT = translateStructuralStop({
    stockTrigger: inputs.trigger,
    stockStopPivot: pivot.level,
    optionEntry: optionLMT,
    delta: delta,
    isCall: isCall,
  });
  if (!stopT.optionStop) return null;

  // TP ladder
  var tpLadder = computeTPLadder(optionLMT);

  // Sizing
  var sizing = sizePosition({
    optionEntry: optionLMT,
    optionStop: stopT.optionStop,
    maxRiskDollars: (parseFloat(process.env.ACCOUNT_SIZE) || 20000) * 0.02,
  });

  // Build display symbol (human-readable for the card)
  // contract.symbol from resolver is OPRA/TS format — we want both
  var expDisplay = contract.expiry; // e.g. "2026-05-01" or MM/DD/YYYY
  try {
    if (/^\d{4}-\d{2}-\d{2}/.test(contract.expiry)) {
      var parts = contract.expiry.split('-');
      expDisplay = parts[1] + '/' + parts[2] + '/' + parts[0].slice(2);
    }
  } catch(e) {}
  var symType = isCall ? 'C' : 'P';
  var optionSymbolDisplay = inputs.ticker + ' ' + expDisplay + ' ' + symType + contract.strike;

  var enriched = {
    ticker: inputs.ticker,
    isCall: isCall,
    source: inputs.source || 'SCANNER',
    contract: {
      strike: contract.strike,
      expiry: contract.expiry,
      dte: contract.dte || null,
      optionSymbol: contract.symbol || null,
      optionSymbolDisplay: optionSymbolDisplay,
      delta: +delta.toFixed(3),
      currentBid: contract.bid || null,
      currentAsk: contract.ask || null,
      currentMid: contract.mid || null,
    },
    entry: {
      stockPriceNow: inputs.stockPrice,
      stockTrigger: inputs.trigger,
      activationType: 'Single Trade Tick',
      projectedPremiumAtTrigger: projectedAtTrigger,
      optionLMT: optionLMT,
      optionLMTBuffer: Math.round(buffer * 100) + '% above projected',
    },
    structuralStop: {
      stockLevel: pivot.level,
      stockPivotReason: pivot.reason,
      optionStop: stopT.optionStop,
      optionStopLimit: stopT.optionStopLimit,
      stopDerivation: stopT.stopDerivation,
    },
    tpLadder: tpLadder,
    sizing: sizing,
    generatedAt: new Date().toISOString(),
  };

  enriched.titanCard = formatTitanCard(enriched);

  return enriched;
}

module.exports = {
  buildCard: buildCard,
  getStopPivot: getStopPivot,
  projectPremiumAtTrigger: projectPremiumAtTrigger,
  translateStructuralStop: translateStructuralStop,
  computeTPLadder: computeTPLadder,
  sizePosition: sizePosition,
  formatTitanCard: formatTitanCard,
  pickEntryBuffer: pickEntryBuffer,
  liveQuote: liveQuote,
};
