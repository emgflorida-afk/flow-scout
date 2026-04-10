// caseyConfluence.js - Stratum Flow Scout v8.3
// CASEY METHOD CONFLUENCE SCORER
// Scores setups 0-10 using multi-timeframe analysis
// Used for ENTRY decisions AND position health monitoring
//
// This is a PURE scoring function -- it receives pre-fetched data
// from TradingView MCP (called by Claude agent) and returns a score.
// It does NOT call any APIs itself.
// -----------------------------------------------------------------

// ===================================================================
// SCORE ENTRY CONFLUENCE
// Takes TradingView data and returns a 0-10 score with checklist
// ===================================================================
function scoreConfluence(data) {
  // data shape:
  // {
  //   ema13: number,        // from data_get_study_values
  //   ema48: number,        // from data_get_study_values
  //   ema200: number|null,  // from data_get_study_values (may not be on chart)
  //   price: number,        // from quote_get
  //   volume: number,       // current bar volume
  //   avgVolume: number,    // 20-bar avg volume
  //   momPanel: string,     // raw MOM row from data_get_pine_tables e.g. "MOM | 15m + | 30m + | 55m - | ..."
  //   sqzPanel: string,     // raw SQZ row from data_get_pine_tables e.g. "SQZ | 30m SQZ | 55m --- | ..."
  //   biasPanel: string,    // raw BIAS row e.g. "BIAS | BULL 6/7 | SQZ 1/3"
  //   brainLabels: array,   // from data_get_pine_labels [{text, price}, ...]
  //   pdh: number|null,     // previous day high (from scanner or labels)
  //   pdl: number|null,     // previous day low
  //   pmh: number|null,     // pre-market high
  //   pml: number|null,     // pre-market low
  //   vwap: number|null,    // VWAP value (from study values)
  //   atr: number|null,     // ATR for stop calculation
  //   direction: string,    // 'CALLS' or 'PUTS' (which direction we're evaluating)
  // }

  var score = 0;
  var checklist = [];
  var direction = (data.direction || 'CALLS').toUpperCase();
  var isCalls = direction === 'CALLS';

  // ---------------------------------------------------------------
  // 1. EMA 13/48 RELATIONSHIP (0-3 points)
  // This is the CORE of Casey's method
  // ---------------------------------------------------------------
  var emaScore = 0;
  var emaState = 'AGAINST';

  if (data.ema13 && data.ema48) {
    var emaSpread = data.ema13 - data.ema48;
    var emaSpreadPct = Math.abs(emaSpread) / data.ema48 * 100;
    var emaAligned = isCalls ? (emaSpread > 0) : (emaSpread < 0);

    if (emaAligned && emaSpreadPct > 0.05) {
      // Fanned out -- strong momentum
      emaScore = 3;
      emaState = 'FANNED';
    } else if (emaAligned && emaSpreadPct > 0.01) {
      // Just crossed, starting to fan
      emaScore = 2.5;
      emaState = 'CROSSED';
    } else if (emaAligned) {
      // Barely aligned, flat
      emaScore = 1.5;
      emaState = 'FLAT';
    } else {
      // Against our direction
      emaScore = 0;
      emaState = 'AGAINST';
    }
  }

  score += emaScore;
  checklist.push({
    item: 'EMA 13/48 ' + emaState + (isCalls ? ' bullish' : ' bearish'),
    pass: emaScore >= 2,
    score: emaScore,
    max: 3,
    detail: data.ema13 && data.ema48
      ? 'EMA13=' + data.ema13.toFixed(2) + ' EMA48=' + data.ema48.toFixed(2)
      : 'EMA data missing'
  });

  // ---------------------------------------------------------------
  // 2. MOM PANEL -- MULTI-TIMEFRAME CONVICTION (0-2 points)
  // This tells us if HIGHER timeframes agree
  // ---------------------------------------------------------------
  var momGreen = 0;
  var momRed = 0;
  var momTotal = 7;

  if (data.biasPanel) {
    // Parse "BIAS | BULL 6/7 | SQZ 1/3" format
    var biasMatch = data.biasPanel.match(/(BULL|BEAR|NEUT)\s+(\d)\/7/);
    if (biasMatch) {
      momGreen = parseInt(biasMatch[2]);
      momRed = momTotal - momGreen;
    }
  } else if (data.momPanel) {
    // Parse "MOM | 15m + | 30m + | 55m - | ..." format
    var parts = data.momPanel.split('|').map(function(s) { return s.trim(); });
    for (var i = 1; i < parts.length; i++) {
      if (parts[i].indexOf('+') !== -1) momGreen++;
      if (parts[i].indexOf('-') !== -1) momRed++;
    }
  }

  var momScore = 0;
  if (momGreen >= 6) momScore = 2;
  else if (momGreen >= 4) momScore = 1.5;
  else if (momGreen >= 3) momScore = 1;
  else momScore = 0;

  // IMPORTANT: For PUTS, we want momRed high, not momGreen
  if (!isCalls) {
    momScore = 0;
    if (momRed >= 6) momScore = 2;
    else if (momRed >= 4) momScore = 1.5;
    else if (momRed >= 3) momScore = 1;
  }

  score += momScore;
  checklist.push({
    item: 'MOM panel ' + (isCalls ? momGreen : momRed) + '/7 aligned',
    pass: momScore >= 1.5,
    score: momScore,
    max: 2,
    detail: 'Green=' + momGreen + ' Red=' + momRed
  });

  // ---------------------------------------------------------------
  // 3. SQUEEZE (0-1 point)
  // Squeeze = energy building. When it fires, move is explosive.
  // ---------------------------------------------------------------
  var sqzFiring = false;
  var sqzCount = 0;
  var sqzTimeframes = [];

  if (data.biasPanel) {
    var sqzMatch = data.biasPanel.match(/SQZ\s+(\d)\/3/);
    if (sqzMatch) sqzCount = parseInt(sqzMatch[1]);
    sqzFiring = sqzCount > 0;
  } else if (data.sqzPanel) {
    var sqzParts = data.sqzPanel.split('|').map(function(s) { return s.trim(); });
    for (var i = 1; i < sqzParts.length; i++) {
      if (sqzParts[i].indexOf('SQZ') !== -1) {
        sqzFiring = true;
        sqzCount++;
        sqzTimeframes.push(sqzParts[i].split(' ')[0]);
      }
    }
  }

  var sqzScore = sqzFiring ? 1 : 0;
  score += sqzScore;
  checklist.push({
    item: 'Squeeze ' + (sqzFiring ? 'FIRING ' + sqzCount + '/3' : 'none'),
    pass: sqzFiring,
    score: sqzScore,
    max: 1,
    detail: sqzTimeframes.length ? 'Timeframes: ' + sqzTimeframes.join(', ') : 'No squeeze'
  });

  // ---------------------------------------------------------------
  // 4. BRAIN LABELS -- GO CALLS/PUTS + STRUCTURE BREAKS (0-2 points)
  // These come from the Flow Scout Brain Pine indicator
  // ---------------------------------------------------------------
  var brainScore = 0;
  var brainSignal = 'NONE';

  if (data.brainLabels && data.brainLabels.length > 0) {
    // Look for recent GO CALLS/GO PUTS labels
    var goLabel = data.brainLabels.find(function(l) {
      return l.text && l.text.indexOf(isCalls ? 'GO\nCALLS' : 'GO\nPUTS') !== -1;
    });
    if (goLabel) {
      brainScore = 2;
      brainSignal = goLabel.text.replace(/\n/g, ' ');
    }

    // Or PDH/PDL break labels
    if (brainScore === 0) {
      var breakLabel = data.brainLabels.find(function(l) {
        return l.text && (
          (isCalls && l.text.indexOf('PDH\nBREAK') !== -1) ||
          (!isCalls && l.text.indexOf('PDL\nBREAK') !== -1)
        );
      });
      if (breakLabel) {
        brainScore = 1;
        brainSignal = breakLabel.text.replace(/\n/g, ' ');
      }
    }
  }

  score += brainScore;
  checklist.push({
    item: 'Brain signal: ' + brainSignal,
    pass: brainScore >= 1,
    score: brainScore,
    max: 2,
    detail: brainSignal
  });

  // ---------------------------------------------------------------
  // 5. VOLUME CONFIRMATION (0-1 point)
  // Breakouts need volume. No volume = fake move.
  // ---------------------------------------------------------------
  var volScore = 0;
  if (data.volume && data.avgVolume && data.avgVolume > 0) {
    volScore = data.volume > data.avgVolume ? 1 : 0;
  }
  score += volScore;
  checklist.push({
    item: 'Volume ' + (volScore ? 'confirming' : 'weak'),
    pass: volScore > 0,
    score: volScore,
    max: 1,
    detail: data.volume && data.avgVolume
      ? 'Vol=' + Math.round(data.volume) + ' Avg=' + Math.round(data.avgVolume)
      : 'Volume data missing'
  });

  // ---------------------------------------------------------------
  // 6. VWAP (0-1 point)
  // Institutional anchor. Trade with it, not against it.
  // ---------------------------------------------------------------
  var vwapScore = 0;
  if (data.vwap && data.price) {
    var rightSide = isCalls ? (data.price > data.vwap) : (data.price < data.vwap);
    vwapScore = rightSide ? 1 : 0;
  }
  score += vwapScore;
  checklist.push({
    item: 'VWAP ' + (vwapScore ? (isCalls ? 'above' : 'below') : 'wrong side'),
    pass: vwapScore > 0,
    score: vwapScore,
    max: 1,
    detail: data.vwap ? 'VWAP=' + data.vwap.toFixed(2) + ' Price=' + (data.price || 0).toFixed(2) : 'No VWAP'
  });

  // ---------------------------------------------------------------
  // STRUCTURE LEVELS -- find retest level and invalidation
  // This is critical for the stop calculation
  // ---------------------------------------------------------------
  var retestLevel = null;
  var invalidationPrice = null;
  var structureNote = 'No structure detected';
  var atr = data.atr || 0.50;

  if (isCalls) {
    // For calls: PMH retest > PDH retest > PML retest
    if (data.pmh && data.price && data.price >= data.pmh * 0.998 && data.price <= data.pmh * 1.003) {
      retestLevel = data.pmh;
      invalidationPrice = data.pmh - (atr * 1.5);
      structureNote = 'PMH retest at ' + data.pmh.toFixed(2);
    } else if (data.pdh && data.price && data.price >= data.pdh * 0.998 && data.price <= data.pdh * 1.003) {
      retestLevel = data.pdh;
      invalidationPrice = data.pdh - (atr * 1.5);
      structureNote = 'PDH retest at ' + data.pdh.toFixed(2);
    } else if (data.pml && data.price && data.price >= data.pml * 0.998 && data.price <= data.pml * 1.005) {
      retestLevel = data.pml;
      invalidationPrice = data.pml - (atr * 1.5);
      structureNote = 'PML retest at ' + data.pml.toFixed(2);
    } else if (data.ema48 && data.price && Math.abs(data.price - data.ema48) / data.ema48 < 0.002) {
      retestLevel = data.ema48;
      invalidationPrice = data.ema48 - (atr * 1.5);
      structureNote = 'EMA 48 retest at ' + data.ema48.toFixed(2);
    }
    // BREAKOUT WITHOUT RETEST: price ran 1+ ATR past level, use last micro-pullback as structure
    if (!retestLevel && data.pmh && data.price && data.price > data.pmh + atr) {
      retestLevel = data.price - (atr * 0.5); // enter on micro-pullback
      invalidationPrice = data.pmh; // if it falls back below PMH, setup is dead
      structureNote = 'BREAKOUT CONTINUATION above PMH ' + data.pmh.toFixed(2) + ' (no retest, use micro-pullback)';
    }
    if (!retestLevel && data.pdh && data.price && data.price > data.pdh + atr) {
      retestLevel = data.price - (atr * 0.5);
      invalidationPrice = data.pdh;
      structureNote = 'BREAKOUT CONTINUATION above PDH ' + data.pdh.toFixed(2);
    }
  } else {
    // For puts: PML retest > PDL retest > PMH retest
    if (data.pml && data.price && data.price >= data.pml * 0.997 && data.price <= data.pml * 1.002) {
      retestLevel = data.pml;
      invalidationPrice = data.pml + (atr * 1.5);
      structureNote = 'PML retest at ' + data.pml.toFixed(2);
    } else if (data.pdl && data.price && data.price >= data.pdl * 0.997 && data.price <= data.pdl * 1.002) {
      retestLevel = data.pdl;
      invalidationPrice = data.pdl + (atr * 1.5);
      structureNote = 'PDL retest at ' + data.pdl.toFixed(2);
    } else if (data.pmh && data.price && Math.abs(data.price - data.pmh) / data.pmh < 0.002) {
      retestLevel = data.pmh;
      invalidationPrice = data.pmh + (atr * 1.5);
      structureNote = 'PMH retest (now resistance) at ' + data.pmh.toFixed(2);
    } else if (data.ema48 && data.price && Math.abs(data.price - data.ema48) / data.ema48 < 0.002) {
      retestLevel = data.ema48;
      invalidationPrice = data.ema48 + (atr * 1.5);
      structureNote = 'EMA 48 retest at ' + data.ema48.toFixed(2);
    }
    // BREAKOUT WITHOUT RETEST (puts): price dropped 1+ ATR below level
    if (!retestLevel && data.pml && data.price && data.price < data.pml - atr) {
      retestLevel = data.price + (atr * 0.5);
      invalidationPrice = data.pml;
      structureNote = 'BREAKDOWN CONTINUATION below PML ' + data.pml.toFixed(2);
    }
    if (!retestLevel && data.pdl && data.price && data.price < data.pdl - atr) {
      retestLevel = data.price + (atr * 0.5);
      invalidationPrice = data.pdl;
      structureNote = 'BREAKDOWN CONTINUATION below PDL ' + data.pdl.toFixed(2);
    }
  }

  // ---------------------------------------------------------------
  // CONVICTION LEVEL + DOLLAR-BASED SIZING
  // Position size = max risk ($) / (entry - stop) / 100
  // Confluence score sets conviction LEVEL, but dollars cap the SIZE
  // ---------------------------------------------------------------
  var conviction = 'SKIP';
  var maxRiskPct = 0; // % of account risked
  if (score >= 8) { conviction = 'HIGH'; maxRiskPct = 0.02; }      // 2% of account
  else if (score >= 7) { conviction = 'MEDIUM_HIGH'; maxRiskPct = 0.015; } // 1.5%
  else if (score >= 6) { conviction = 'MEDIUM'; maxRiskPct = 0.01; }       // 1%
  else if (score >= 4) { conviction = 'LOW'; maxRiskPct = 0.0075; }        // 0.75%
  else { conviction = 'SKIP'; maxRiskPct = 0; }

  // Calculate contracts from DOLLAR RISK, not arbitrary count
  var accountSize = data.accountSize || 20000;
  var maxRiskDollars = accountSize * maxRiskPct;
  var estimatedPremium = data.estimatedPremium || 1.50;
  var estimatedStopDist = invalidationPrice && data.price
    ? Math.abs(data.price - invalidationPrice) * (data.delta || 0.40)
    : estimatedPremium * 0.25; // fallback: 25% of premium
  var contracts = 0;

  if (conviction !== 'SKIP' && estimatedStopDist > 0) {
    contracts = Math.floor(maxRiskDollars / (estimatedStopDist * 100));
    contracts = Math.max(contracts, 2);  // minimum 2 (need to trim)
    contracts = Math.min(contracts, 6);  // maximum 6 (don't go crazy)
  }

  // Budget-aware: if caller provides maxBudget or settledCash, cap further
  if (data.maxBudget && estimatedPremium) {
    var maxAffordable = Math.floor(data.maxBudget / (estimatedPremium * 100));
    if (maxAffordable < contracts) {
      contracts = Math.max(maxAffordable, 2);
    }
  }

  // ---------------------------------------------------------------
  // ENTRY TYPE: RETEST (limit at mid) vs BREAKOUT (limit at ask)
  // Decides HOW to fill, not just whether to enter
  // ---------------------------------------------------------------
  var entryType = 'RETEST'; // default: patient, limit at mid
  var fillInstruction = 'LIMIT at mid-price. Wait 60 sec, bump $0.05 if no fill. Skip if still no fill.';

  if (structureNote && structureNote.indexOf('BREAKOUT CONTINUATION') !== -1) {
    // Price already ran past the level — no retest coming
    entryType = 'BREAKOUT';
    fillInstruction = 'LIMIT at ASK. Fill immediately. Do NOT chase if option already moved 30%+.';
  } else if (brainScore >= 2 && sqzFiring && volScore > 0) {
    // GO signal + squeeze firing + volume = this is moving NOW
    entryType = 'BREAKOUT';
    fillInstruction = 'LIMIT at ASK. Squeeze + signal + volume = move is happening now.';
  } else if (data.flowRatio && data.flowRatio > 10) {
    // One-sided flow (like AMZN 638:0 calls)
    entryType = 'BREAKOUT';
    fillInstruction = 'LIMIT at ASK. Heavy institutional flow — ride the wave.';
  }
  // Retests use mid-price by default (already set above)

  // ---------------------------------------------------------------
  // TRADE TYPE: DAY TRADE vs SWING
  // This is critical — we left $1,274 on the table by day trading
  // AMZN and MRVL when they were 8 DTE swing setups
  // ---------------------------------------------------------------
  var tradeType = 'DAY_TRADE'; // default
  var swingReason = null;

  // Swing criteria (ALL must be true):
  // 1. Contract has 5+ DTE (from data.dte if provided)
  // 2. MOM panel shows 5+ timeframes aligned (higher TFs agree)
  // 3. EMA fanned (not just crossed — sustained momentum)
  // 4. Volume above average (institutional participation)
  // 5. NOT a 0DTE or near-expiry play

  var dte = data.dte || 0;
  var momAligned = isCalls ? momGreen : momRed;

  if (dte >= 5 && momAligned >= 5 && emaState === 'FANNED' && volScore > 0) {
    tradeType = 'SWING';
    swingReason = 'DTE ' + dte + ', MOM ' + momAligned + '/7, EMA fanned, volume confirming';
  } else if (dte >= 8 && momAligned >= 4 && emaScore >= 2) {
    tradeType = 'SWING_POSSIBLE';
    swingReason = 'DTE ' + dte + ', MOM ' + momAligned + '/7 — hold if daily structure confirms at 3:30';
  }

  // Swing trades get different exit rules:
  // - Trim 1 contract at +50% (same)
  // - DO NOT close at 3:30 PM (check daily chart health instead)
  // - Trail stop on daily structure (not 2-min)
  // - Hold until daily health drops below 5

  return {
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    direction: direction,
    conviction: conviction,
    contracts: contracts,
    tradeType: tradeType,
    swingReason: swingReason,
    entryType: entryType,
    fillInstruction: fillInstruction,
    emaState: emaState,
    momGreen: momGreen,
    momRed: momRed,
    sqzFiring: sqzFiring,
    sqzCount: sqzCount,
    brainSignal: brainSignal,
    retestLevel: retestLevel,
    invalidationPrice: invalidationPrice,
    structureNote: structureNote,
    atr: atr,
    checklist: checklist,
    entryPrice: data.price || null,
    timestamp: new Date().toISOString(),
  };
}

// ===================================================================
// SCORE POSITION HEALTH
// Called every 60 seconds while in a trade
// Tells us whether to HOLD, TIGHTEN, or EXIT
// ===================================================================
function scorePositionHealth(current, entryContext) {
  // current: live TradingView data (same shape as scoreConfluence input)
  // entryContext: the confluence result from when we entered
  //   { score, emaState, momGreen, retestLevel, invalidationPrice, direction }

  if (!current || !entryContext) {
    return { health: 5, action: 'HOLD', reason: 'Missing data -- default hold' };
  }

  var health = 0;
  var reasons = [];
  var direction = entryContext.direction || 'CALLS';
  var isCalls = direction === 'CALLS';

  // ---------------------------------------------------------------
  // 1. EMA STILL FANNED (0-3 points)
  // Are the EMAs still in our favor?
  // ---------------------------------------------------------------
  if (current.ema13 && current.ema48) {
    var spread = current.ema13 - current.ema48;
    var spreadPct = Math.abs(spread) / current.ema48 * 100;
    var aligned = isCalls ? (spread > 0) : (spread < 0);

    if (aligned && spreadPct > 0.05) {
      health += 3;
      reasons.push('EMA fanned in direction (+3)');
    } else if (aligned && spreadPct > 0.02) {
      health += 2;
      reasons.push('EMA aligned but narrowing (+2)');
    } else if (aligned) {
      health += 1;
      reasons.push('EMA barely aligned (+1)');
    } else {
      reasons.push('EMA CROSSED AGAINST (0) -- DANGER');
    }
  }

  // ---------------------------------------------------------------
  // 2. MOM PANEL vs ENTRY (0-2 points)
  // Are we losing timeframe support?
  // ---------------------------------------------------------------
  var currentMomAligned = 0;
  if (current.biasPanel) {
    var match = current.biasPanel.match(/(BULL|BEAR|NEUT)\s+(\d)\/7/);
    if (match) {
      currentMomAligned = parseInt(match[2]);
      if (!isCalls) currentMomAligned = 7 - currentMomAligned;
    }
  } else if (current.momPanel) {
    var parts = current.momPanel.split('|').map(function(s) { return s.trim(); });
    for (var i = 1; i < parts.length; i++) {
      var marker = isCalls ? '+' : '-';
      if (parts[i].indexOf(marker) !== -1) currentMomAligned++;
    }
  }

  var entryMomAligned = isCalls ? (entryContext.momGreen || 0) : (entryContext.momRed || 0);

  if (currentMomAligned >= entryMomAligned) {
    health += 2;
    reasons.push('MOM same or better than entry (+2)');
  } else if (currentMomAligned >= entryMomAligned - 1) {
    health += 1.5;
    reasons.push('MOM lost 1 TF from entry (+1.5)');
  } else if (currentMomAligned >= entryMomAligned - 2) {
    health += 1;
    reasons.push('MOM lost 2 TFs from entry (+1)');
  } else {
    reasons.push('MOM collapsed from entry (0) -- DANGER');
  }

  // ---------------------------------------------------------------
  // 3. PRICE vs STRUCTURE (0-3 points)
  // Are we still above/below the key level?
  // ---------------------------------------------------------------
  var retestLevel = entryContext.retestLevel;
  var invalidation = entryContext.invalidationPrice;
  var price = current.price || 0;
  var atr = current.atr || entryContext.atr || 0.50;

  if (retestLevel && price) {
    if (isCalls) {
      if (price > retestLevel + (atr * 1.5)) {
        health += 3;
        reasons.push('Price well above retest level (+3)');
      } else if (price > retestLevel) {
        health += 2;
        reasons.push('Price above retest level (+2)');
      } else if (price > invalidation) {
        health += 1;
        reasons.push('Price below retest but above invalidation (+1)');
      } else {
        reasons.push('PRICE BELOW INVALIDATION (0) -- EXIT');
      }
    } else {
      if (price < retestLevel - (atr * 1.5)) {
        health += 3;
        reasons.push('Price well below retest level (+3)');
      } else if (price < retestLevel) {
        health += 2;
        reasons.push('Price below retest level (+2)');
      } else if (price < invalidation) {
        health += 1;
        reasons.push('Price above retest but below invalidation (+1)');
      } else {
        reasons.push('PRICE ABOVE INVALIDATION (0) -- EXIT');
      }
    }
  } else {
    // No structure data -- use entry price as reference
    var entryPrice = entryContext.entryPrice || 0;
    if (entryPrice > 0 && price > 0) {
      var pctFromEntry = ((price - entryPrice) / entryPrice) * 100;
      var favorable = isCalls ? pctFromEntry > 0 : pctFromEntry < 0;
      if (favorable && Math.abs(pctFromEntry) > 0.3) {
        health += 3;
      } else if (favorable) {
        health += 2;
      } else if (Math.abs(pctFromEntry) < 0.15) {
        health += 1;
        reasons.push('Flat near entry (+1)');
      }
    }
  }

  // ---------------------------------------------------------------
  // 4. VOLUME TREND (0-2 points)
  // Is volume supporting the move?
  // ---------------------------------------------------------------
  if (current.volume && current.avgVolume && current.avgVolume > 0) {
    var volRatio = current.volume / current.avgVolume;
    if (volRatio > 1.2) {
      health += 2;
      reasons.push('Volume strong (+2)');
    } else if (volRatio > 0.8) {
      health += 1;
      reasons.push('Volume average (+1)');
    } else {
      reasons.push('Volume drying up (0)');
    }
  }

  // ---------------------------------------------------------------
  // DETERMINE ACTION
  // ---------------------------------------------------------------
  health = Math.round(health * 10) / 10;
  var action = 'HOLD';
  var stopAction = null;

  if (health >= 8) {
    action = 'RIDE';
    stopAction = 'Trail stop wide -- 1.5x ATR below price';
  } else if (health >= 6) {
    action = 'HOLD';
    stopAction = 'Move stop to breakeven if in profit';
  } else if (health >= 4) {
    action = 'TIGHTEN';
    stopAction = 'Tighten stop to 0.5 ATR below current price';
  } else {
    action = 'EXIT';
    stopAction = 'Structure broken -- exit or set stop at current price';
  }

  return {
    health: health,
    maxHealth: 10,
    action: action,
    stopAction: stopAction,
    reasons: reasons,
    currentMomAligned: currentMomAligned,
    entryMomAligned: entryMomAligned,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { scoreConfluence, scorePositionHealth };
