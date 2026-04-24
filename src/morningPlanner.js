// morningPlanner.js — Automated Pre-Market Setup Ranking + Liquidity Check
// -----------------------------------------------------------------
// Created 2026-04-24 after META session failure.
// Runs at 6:00 AM ET cron. By 8:30 AM delivers Discord brief with:
//   - Top 3 setups from scanner + John's picks
//   - Each pre-verified via liquidity check
//   - Pre-computed entry/stop/TP levels
//   - Conviction score (0-10)
//
// Then at 9:15 AM ET runs a SECOND live liquidity check to catch
// any contract that degraded from pre-market to open.
//
// CRITICAL: NO execution. No order placement. Just analysis + push.
// AB decides based on the morning brief at 9:30 bell.
// -----------------------------------------------------------------

var fs = require('fs');
var path = require('path');

var stratumScanner = null;
try { stratumScanner = require('./stratumScanner'); } catch(e) {}

var liquidityCheck = null;
try { liquidityCheck = require('./liquidityCheck'); } catch(e) {}

var jsmithPoller = null;
try { jsmithPoller = require('./stratumExternalPoller'); } catch(e) {}

var pushNotifier = null;
try { pushNotifier = require('./pushNotifier'); } catch(e) {}

var ts = null;
try { ts = require('./tradestation'); } catch(e) {}

var STATE_DIR = process.env.STATE_DIR || '/tmp';
var PLANNER_LOG = path.join(STATE_DIR, 'morning_planner.jsonl');
var LATEST_REPORT = path.join(STATE_DIR, 'morning_planner_latest.json');

// ----------------------------------------------------------------------------
// CONFLUENCE SCORING (per TRADING_DESK_OPERATING_RULES)
// ----------------------------------------------------------------------------
function scoreRow(row, context) {
  var score = 0;
  var gates = [];

  // Scanner signal + conviction
  if (row.signal) { score += 1; gates.push('scanner_signal'); }
  if (row.conviction === 'high') { score += 1; gates.push('high_conviction'); }

  // Multi-TF alignment
  if (row.ftfc) { score += 1; gates.push('ftfc_aligned'); }

  // Flow confirmation
  if (row.flow && row.flow.total > 1000000) { score += 1; gates.push('bull_flow_1M+'); }
  if (row.flow && row.flow.total > 5000000) { score += 1; gates.push('huge_flow_5M+'); }

  // Gamma alignment (if enriched)
  if (row.gex) {
    if (row.gex.regime === 'POSITIVE' && row.signal && /up|2U|Hammer|Failed 2D|Continuation Up/i.test(row.signal)) {
      score += 1; gates.push('gamma_pull_bull');
    }
    if (row.gex.regime === 'NEGATIVE' && row.signal && /down|2D|Shooter|Failed 2U|Continuation Down/i.test(row.signal)) {
      score += 1; gates.push('gamma_pull_bear');
    }
  }

  // In-Force status
  if (row.inForce === 'ACTIVE') { score += 1; gates.push('status_active'); }
  if (row.inForce === 'TRIGGERED') { score += 2; gates.push('status_triggered'); }

  // No earnings within window
  if (!row.earnings || !row.earnings.startsWith('+0') && !row.earnings.startsWith('+1d') && !row.earnings.startsWith('+2d')) {
    score += 1; gates.push('no_earnings');
  }

  // John confirmation (passed via context)
  if (context.johnPicks && context.johnPicks.indexOf(row.ticker) >= 0) {
    score += 2; gates.push('john_confirmed');
  }

  return { score: score, gates: gates, maxPossible: 10 };
}

// ----------------------------------------------------------------------------
// Build option symbols to liquidity-check based on a scanner row
// ----------------------------------------------------------------------------
function buildCandidateOptions(row) {
  if (!row.price || !row.signal) return [];
  var isBull = /up|2U|Hammer|Failed 2D|Continuation Up/i.test(row.signal);
  var cp = isBull ? 'C' : 'P';
  var atmStrike = Math.round(row.price / 5) * 5; // nearest $5
  var otm1 = isBull ? atmStrike + 5 : atmStrike - 5;
  var itm1 = isBull ? atmStrike - 5 : atmStrike + 5;

  // Next 3 monthly expiries (most liquid)
  var today = new Date();
  var monthlies = getNextMonthlies(today, 3);

  var symbols = [];
  monthlies.forEach(function(m) {
    [itm1, atmStrike, otm1].forEach(function(strike) {
      // TS format: TICKER YYMMDDCSTRIKE (strike without padding, no cents)
      var strikeStr = strike % 1 === 0 ? String(strike) : strike.toFixed(1);
      symbols.push(row.ticker + ' ' + m + cp + strikeStr);
    });
  });

  return symbols;
}

function getNextMonthlies(fromDate, count) {
  // Returns array of YYMMDD strings for next N 3rd-Fridays
  var results = [];
  var yr = fromDate.getFullYear();
  var mo = fromDate.getMonth();
  while (results.length < count) {
    var firstOfMonth = new Date(yr, mo, 1);
    var dayOfWeek = firstOfMonth.getDay(); // 0=Sun
    var daysToFri = (5 - dayOfWeek + 7) % 7;
    var thirdFri = 1 + daysToFri + 14;
    var expiry = new Date(yr, mo, thirdFri);
    if (expiry >= fromDate) {
      var yy = String(yr).slice(-2);
      var mm = String(mo + 1).padStart(2, '0');
      var dd = String(thirdFri).padStart(2, '0');
      results.push(yy + mm + dd);
    }
    mo++;
    if (mo > 11) { mo = 0; yr++; }
  }
  return results;
}

// ----------------------------------------------------------------------------
// Main run — called by cron or manual endpoint
// ----------------------------------------------------------------------------
async function runMorningRoutine(opts) {
  opts = opts || {};
  var report = {
    ts: new Date().toISOString(),
    tapeScore: null,
    johnPicks: [],
    scannerMatches: 0,
    shortlist: [],
    cards: [],
    errors: [],
  };

  // 1. Get John's picks from last 12 hours
  try {
    if (jsmithPoller && jsmithPoller.peekLatest) {
      var vip = await jsmithPoller.peekLatest('VIP_FLOW_OPTIONS', 10);
      var picks = extractTickers(vip);
      report.johnPicks = picks;
    }
  } catch(e) { report.errors.push('john_peek: ' + e.message); }

  // 2. Run scanner Daily
  try {
    if (stratumScanner && stratumScanner.scan) {
      var scanResult = await stratumScanner.scan({ tf: 'Daily' });
      report.scannerMatches = scanResult.matched;

      // Flatten and score
      var allRows = [];
      Object.keys(scanResult.groups || {}).forEach(function(k) {
        (scanResult.groups[k] || []).forEach(function(r) { allRows.push(r); });
      });

      var scored = allRows.map(function(r) {
        return { row: r, confluence: scoreRow(r, { johnPicks: report.johnPicks }) };
      });

      scored.sort(function(a, b) { return b.confluence.score - a.confluence.score; });

      // Top 5 candidates before liquidity check
      report.shortlist = scored.slice(0, 5).map(function(s) {
        return {
          ticker: s.row.ticker,
          signal: s.row.signal,
          score: s.confluence.score,
          gates: s.confluence.gates,
          price: s.row.price,
          trigger: s.row.trigger,
          inForce: s.row.inForce,
          gex: s.row.gex,
          flow: s.row.flow,
        };
      });
    }
  } catch(e) { report.errors.push('scanner: ' + e.message); }

  // 3. Liquidity check TOP 3 candidates
  for (var i = 0; i < Math.min(3, report.shortlist.length); i++) {
    var candidate = report.shortlist[i];
    try {
      var optionSymbols = buildCandidateOptions(candidate);
      if (optionSymbols.length && liquidityCheck) {
        var liq = await liquidityCheck.checkMany(optionSymbols);
        if (liq.best) {
          report.cards.push({
            ticker: candidate.ticker,
            signal: candidate.signal,
            score: candidate.score,
            gates: candidate.gates,
            best_contract: liq.best,
            all_contracts: liq.all,
          });
        } else {
          report.cards.push({
            ticker: candidate.ticker,
            signal: candidate.signal,
            score: candidate.score,
            gates: candidate.gates,
            best_contract: null,
            reason: 'no contract passed liquidity gates',
          });
        }
      }
    } catch(e) { report.errors.push('liquidity ' + candidate.ticker + ': ' + e.message); }
  }

  // 4. Save report
  try {
    fs.writeFileSync(LATEST_REPORT, JSON.stringify(report, null, 2));
    fs.appendFileSync(PLANNER_LOG, JSON.stringify({ ts: report.ts, cards: report.cards.length, errors: report.errors.length }) + '\n');
  } catch(e) { console.error('[PLANNER] save error:', e.message); }

  // 5. Push Discord brief
  try {
    if (pushNotifier && pushNotifier.pushCuratorAlert && report.cards.length > 0) {
      var topCard = report.cards[0];
      if (topCard.best_contract) {
        await pushNotifier.pushCuratorAlert({
          ticker: topCard.ticker,
          score: topCard.score,
          verdict: 'MORNING PLANNER TOP SETUP',
          reason: topCard.signal + ' | Conviction: ' + topCard.score + '/10 | Gates: ' + topCard.gates.join(', '),
          r_r: 'TBD - run 9:15 AM re-verify',
          action: 'Contract: ' + topCard.best_contract.symbol + ' | Bid/Ask: $' + topCard.best_contract.bid + '/$' + topCard.best_contract.ask + ' | Vol: ' + topCard.best_contract.volume + ' | OI: ' + topCard.best_contract.openInterest + ' | Liquidity Score: ' + topCard.best_contract.score + ' (' + topCard.best_contract.tier + ') | ⚠️ RE-VERIFY AT 9:15 AM ET before building Titan card',
          failure_modes: [
            'NOT finalized — pre-market quotes. Re-check live at 9:15 AM ET.',
            'Multiple candidates in report: see /api/planner/latest',
            'John picks today: ' + (report.johnPicks.length ? report.johnPicks.join(', ') : 'none yet'),
            'Scanner matched ' + report.scannerMatches + ' total signals',
            report.errors.length ? 'Errors: ' + report.errors.join(' | ') : 'No errors',
          ],
        });
      }
    }
  } catch(e) { console.error('[PLANNER] push error:', e.message); }

  return report;
}

function extractTickers(msgs) {
  var tickers = [];
  var re = /\$([A-Z]{1,5})\b/g;
  (msgs || []).forEach(function(m) {
    var content = m.content || '';
    var embeds = m.embeds || [];
    var fullText = content + ' ' + embeds.map(function(e) { return (e.title || '') + ' ' + (e.description || ''); }).join(' ');
    var match;
    while ((match = re.exec(fullText)) !== null) {
      if (tickers.indexOf(match[1]) < 0) tickers.push(match[1]);
    }
  });
  return tickers;
}

function getLatestReport() {
  try {
    return JSON.parse(fs.readFileSync(LATEST_REPORT, 'utf8'));
  } catch(e) { return null; }
}

module.exports = {
  runMorningRoutine: runMorningRoutine,
  getLatestReport: getLatestReport,
  scoreRow: scoreRow,
  buildCandidateOptions: buildCandidateOptions,
};
