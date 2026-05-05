// =============================================================================
// JOHN-LIKE PICKER (Phase 4.30C — May 5 2026 PM)
// =============================================================================
// Live module that takes today's scanner output (action-radar / setup-radar /
// JS scan / V-bottom) and asks: "would John have posted this tonight?"
//
// Algorithm:
//   1. Pull current scanner candidates (top of action-radar + JS scan ready)
//   2. For each candidate, classify its structural label using same logic as
//      johnPickAnalyzer.reverseEngineer (live bars, not historical)
//   3. Match against pattern_profiles.json (built by Phase 4.30B)
//   4. If matched and historical winRate >= 0.50 (or rawWinRate >= 0.30),
//      surface as a JOHN-LIKE PICK
//   5. Generate the contract per John's style:
//        - DTE: per pattern's typicalDTE.mean (rounded to nearest John convention)
//        - Strike: per pattern's typicalStrikePctOTM.mean
//        - TP ladder: 25/50/100 (John's signature)
//        - Stop: 25% (John's signature)
//   6. Save to /data/john_like_picks_YYYY-MM-DD.json
//   7. Return list for Discord push (caller handles it)
//
// Triggered:
//   - EOD cron 5:30 PM ET weekdays (after market close, before next-day open)
//   - Manual: POST /api/john-like-pick/generate
//   - JS tab in scanner-v2.html: GET /api/john-like-pick (returns latest)
// =============================================================================

'use strict';

var fs = require('fs');
var path = require('path');

var johnPickAnalyzer = require('./johnPickAnalyzer');
var johnPatternProfiler = require('./johnPatternProfiler');

var ts = null;
try { ts = require('./tradestation'); } catch (e) {}

var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));

function getServerBase() {
  return process.env.SERVER_INTERNAL_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
}

// =============================================================================
// CANDIDATE COLLECTION — pull from existing scanners
// =============================================================================
async function pullCandidates() {
  var base = getServerBase();
  var candidates = [];
  var seen = {};
  var add = function(rec) {
    var key = rec.ticker + '|' + rec.direction;
    if (seen[key]) return;
    seen[key] = true;
    candidates.push(rec);
  };

  // 1. JS pattern scan (ready bucket — already filtered for pattern matches)
  try {
    var r = await fetchLib(base + '/api/js-scan', { timeout: 10000 });
    if (r.ok) {
      var data = await r.json();
      var ready = (data.ready || []).slice(0, 20);
      ready.forEach(function(row) {
        add({
          ticker: row.ticker,
          direction: (row.direction || '').toLowerCase(),
          source: 'js-scan',
          pattern: row.pattern,
          tf: row.tf,
          conviction: row.conviction,
          plan: row.plan,
          lastClose: row.lastClose,
        });
      });
    }
  } catch (e) {
    console.error('[JLP] js-scan fetch fail:', e.message);
  }

  // 2. Action radar (live UOA-driven candidates)
  try {
    var r2 = await fetchLib(base + '/api/action-radar?minScore=10', { timeout: 10000 });
    if (r2.ok) {
      var d2 = await r2.json();
      (d2.actionable || []).slice(0, 10).forEach(function(row) {
        add({
          ticker: row.ticker,
          direction: row.direction || (row.bias === 'BULL' ? 'long' : 'short'),
          source: 'action-radar',
          pattern: 'flow-driven',
          conviction: row.score,
          lastClose: row.spot,
        });
      });
    }
  } catch (e) {}

  // 3. Daily coil scan (ready)
  try {
    var r3 = await fetchLib(base + '/api/coil-scan', { timeout: 10000 });
    if (r3.ok) {
      var d3 = await r3.json();
      (d3.ready || []).slice(0, 10).forEach(function(row) {
        add({
          ticker: row.ticker,
          direction: (row.direction || '').toLowerCase(),
          source: 'coil-scan',
          pattern: row.pattern,
          conviction: row.conviction,
          plan: row.plan,
          lastClose: row.lastClose,
        });
      });
    }
  } catch (e) {}

  return candidates;
}

// =============================================================================
// CLASSIFY LIVE CANDIDATE — same logic as analyzer but pulling current bars
// =============================================================================
async function classifyLive(candidate) {
  // Treat current as posted_at = now
  var stub = {
    posted_at: new Date().toISOString(),
    trade: {
      ticker: candidate.ticker,
      direction: candidate.direction,
      triggerPrice: (candidate.plan && candidate.plan.primary && candidate.plan.primary.trigger) || candidate.lastClose,
      strike: (candidate.plan && candidate.plan.primary && candidate.plan.primary.strike) || null,
      expiry: null,
      stopPct: 25,
      tpLevels: [25, 50, 100],
    },
  };
  // Reverse-engineer current chart state (no outcome — it's live)
  var revEng;
  try {
    revEng = await johnPickAnalyzer.enrichPick(stub);
  } catch (e) {
    return null;
  }
  return revEng;
}

// =============================================================================
// GENERATE LOGIC TEXT — human-readable reverse-engineered narrative
// =============================================================================
function buildLogicText(candidate, revEng, profile) {
  var rev = revEng && revEng.reverseEngineering;
  if (!rev) return 'Pattern match against John historical baseline.';

  var dir = (candidate.direction || '').toLowerCase();
  var verb = dir === 'long' || dir === 'call' ? 'rallied' : 'sold off';
  var biasWord = dir === 'long' || dir === 'call' ? 'breakout' : 'breakdown';

  var range = rev.recentRange || {};
  var atKey = rev.atKeyLevel || {};
  var trend = rev.trendDaily || 'unknown';

  var parts = [];
  // Trend phrase
  if (trend === 'UP') parts.push(candidate.ticker + ' is in a daily uptrend');
  else if (trend === 'DOWN') parts.push(candidate.ticker + ' is in a daily downtrend');
  else parts.push(candidate.ticker + ' is range-bound on the daily');

  // Range / level phrase
  if (range.high && range.low) {
    parts.push('20-day range $' + range.low.toFixed(2) + '-$' + range.high.toFixed(2) + ' (currently at ' + Math.round((range.position || 0) * 100) + '%)');
  }

  // Key level phrase
  if (atKey.type === 'resistance') {
    parts.push('testing resistance at $' + atKey.level.toFixed(2));
  } else if (atKey.type === 'support') {
    parts.push('testing support at $' + atKey.level.toFixed(2));
  }

  // Pattern phrase
  if (rev.recentPattern && rev.recentPattern !== 'UNKNOWN' && rev.recentPattern !== 'MIXED') {
    parts.push('recent bar pattern: ' + rev.recentPattern.replace(/_/g, ' ').toLowerCase());
  }

  var setup = 'Setup matches ' + (rev.structuralLabel || 'unknown').replace(/_/g, ' ').toLowerCase()
    + ' (' + (profile && profile.sampleSize ? profile.sampleSize + ' historical picks' : 'no n') + ', win rate '
    + Math.round((profile && profile.winRate ? profile.winRate : 0) * 100) + '%).';

  return parts.join('. ') + '. ' + setup;
}

// =============================================================================
// CONTRACT GENERATION — per John's style
// =============================================================================
function generateContract(candidate, profile) {
  var dir = (candidate.direction || '').toLowerCase();
  var spot = candidate.lastClose || 0;
  var trigger = (candidate.plan && candidate.plan.primary && candidate.plan.primary.trigger) || spot;

  // DTE: nearest John convention (1, 7, 14, 30 days)
  var meanDte = (profile && profile.typicalDTE && profile.typicalDTE.mean) || 1;
  var johnDtes = [1, 3, 7, 14, 30];
  var bestDte = johnDtes.reduce(function(prev, curr) {
    return Math.abs(curr - meanDte) < Math.abs(prev - meanDte) ? curr : prev;
  }, johnDtes[0]);

  // Strike: per profile's typicalStrikePctOTM
  var otmPct = (profile && profile.typicalStrikePctOTM && profile.typicalStrikePctOTM.mean) || 0;
  var rawStrike;
  if (dir === 'long' || dir === 'call') {
    rawStrike = trigger * (1 + otmPct / 100);
  } else {
    rawStrike = trigger * (1 - otmPct / 100);
  }
  // Round to nearest .50 (John conventional)
  var strike = Math.round(rawStrike * 2) / 2;
  // For high-priced names, round to nearest dollar
  if (rawStrike > 200) strike = Math.round(rawStrike);

  // Expiry calc: today + bestDte business days (best-effort — Friday-preferred)
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var target = new Date(et.getTime() + bestDte * 24 * 3600 * 1000);
  // Snap to next Friday if within 5 business days
  if (bestDte <= 7) {
    var dayOfWeek = target.getDay();
    var daysToFri = (5 - dayOfWeek + 7) % 7;
    target = new Date(target.getTime() + daysToFri * 24 * 3600 * 1000);
  }
  var expiry = target.toISOString().slice(0, 10);

  return {
    direction: dir,
    optDir: (dir === 'long' || dir === 'call') ? 'CALL' : 'PUT',
    strike: strike,
    expiry: expiry,
    dte: bestDte,
    triggerPrice: trigger,
    stopPrice: (dir === 'long' || dir === 'call')
      ? Math.round((trigger * 0.97) * 100) / 100  // ~3% stock stop = ~25% premium
      : Math.round((trigger * 1.03) * 100) / 100,
    stopPct: 25,
    tpLevels: [25, 50, 100],
  };
}

// =============================================================================
// GENERATE — main entry
// =============================================================================
async function generate(opts) {
  opts = opts || {};
  var minWinRate = opts.minWinRate != null ? opts.minWinRate : 0.50;
  var minSampleSize = opts.minSampleSize || 3;
  var maxPicks = opts.maxPicks || 8;

  // Ensure profiles are built (will return existing if already saved)
  var profilesData = johnPatternProfiler.loadProfiles();
  if (!profilesData || !profilesData.profiles) {
    return { ok: false, error: 'no pattern profiles loaded — run johnPickAnalyzer.backfillAll first' };
  }

  var candidates = await pullCandidates();
  if (!candidates.length) {
    return { ok: true, picks: [], note: 'no scanner candidates' };
  }

  var picks = [];
  for (var i = 0; i < candidates.length && picks.length < maxPicks; i++) {
    var cand = candidates[i];
    if (!cand.ticker || !cand.direction) continue;
    var revEng = await classifyLive(cand);
    if (!revEng || !revEng.reverseEngineering) continue;
    var label = revEng.reverseEngineering.structuralLabel;
    if (!label || label === 'UNKNOWN') continue;

    var profile = profilesData.profiles[label];
    if (!profile || profile.sampleSize < minSampleSize) {
      // Allow if rawWinRate is decent
      if (!profile || (profile.winRate || 0) < minWinRate) continue;
    }
    if ((profile.winRate || 0) < minWinRate) continue;

    var contract = generateContract(cand, profile);
    var logic = buildLogicText(cand, revEng, profile);

    picks.push({
      ticker: cand.ticker,
      direction: cand.direction,
      source: cand.source,
      structuralLabel: label,
      historicalWinRate: profile.winRate,
      historicalSampleSize: profile.sampleSize,
      historicalAvgMFE: profile.avgMFE,
      historicalAvgTimeToTP1Hours: profile.avgTimeToTP1Hours,
      reverseEngineering: revEng.reverseEngineering,
      contract: contract,
      logic: logic,
      generatedAt: new Date().toISOString(),
    });
  }

  // Sort: highest historical win rate × MFE × n first
  picks.sort(function(a, b) {
    var sa = (a.historicalWinRate || 0) * (a.historicalAvgMFE || 0) * Math.log(1 + (a.historicalSampleSize || 0));
    var sb = (b.historicalWinRate || 0) * (b.historicalAvgMFE || 0) * Math.log(1 + (b.historicalSampleSize || 0));
    return sb - sa;
  });

  // Save snapshot
  var nextSession = nextSessionDate();
  var outPath = path.join(DATA_ROOT, 'john_like_picks_' + nextSession + '.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      forSession: nextSession,
      profilesGeneratedAt: profilesData.generatedAt,
      picks: picks,
    }, null, 2));
  } catch (e) {
    console.error('[JLP] save fail:', e.message);
  }

  // Maintain a "latest" pointer
  try {
    fs.writeFileSync(path.join(DATA_ROOT, 'john_like_picks_latest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      forSession: nextSession,
      profilesGeneratedAt: profilesData.generatedAt,
      picks: picks,
    }, null, 2));
  } catch (e) {}

  return {
    ok: true,
    forSession: nextSession,
    candidatesScanned: candidates.length,
    picks: picks,
    pathOut: outPath,
  };
}

function nextSessionDate() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var dayOfWeek = et.getDay();
  // If Fri after 4 PM → next Mon. If Sat → Mon. If Sun → Mon. Else → tomorrow.
  var addDays = 1;
  if (dayOfWeek === 5 && et.getHours() >= 16) addDays = 3;
  else if (dayOfWeek === 6) addDays = 2;
  else if (dayOfWeek === 0) addDays = 1;
  var next = new Date(et.getTime() + addDays * 24 * 3600 * 1000);
  return next.toISOString().slice(0, 10);
}

function loadLatest() {
  try {
    var p = path.join(DATA_ROOT, 'john_like_picks_latest.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return null;
}

// =============================================================================
// PATTERN MATCH FOR FIRE GRADE BONUS
// =============================================================================
// Used by fireGradeComputer.js to grant bonus points when a setup matches a
// proven John pattern.
async function matchSetup(ticker, direction, currentPlan) {
  var stub = {
    ticker: ticker,
    direction: direction,
    plan: currentPlan,
    lastClose: currentPlan && currentPlan.primary && currentPlan.primary.trigger,
  };
  var revEng;
  try {
    revEng = await classifyLive(stub);
  } catch (e) { return null; }
  if (!revEng || !revEng.reverseEngineering) return null;
  var label = revEng.reverseEngineering.structuralLabel;
  if (!label || label === 'UNKNOWN') return null;
  var profilesData = johnPatternProfiler.loadProfiles();
  if (!profilesData || !profilesData.profiles) return null;
  var profile = profilesData.profiles[label];
  if (!profile) return null;
  return {
    label: label,
    historicalWinRate: profile.winRate,
    historicalSampleSize: profile.sampleSize,
    historicalAvgMFE: profile.avgMFE,
    matched: true,
  };
}

module.exports = {
  generate: generate,
  loadLatest: loadLatest,
  matchSetup: matchSetup,
  pullCandidates: pullCandidates,
  classifyLive: classifyLive,
};
