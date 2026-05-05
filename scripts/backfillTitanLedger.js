// =============================================================================
// scripts/backfillTitanLedger.js — Phase 4.28 (May 5 2026)
//
// Backfills the SIM Trade Journal (Phase 4.24) with the 7-day Titan SIM3142118M
// ledger AB extracted from screenshots (Apr 28 - May 5).
//
// USAGE
//   Local against local data/:
//     DATA_DIR=$(pwd)/data node scripts/backfillTitanLedger.js
//   Railway shell (writes /data/sim_trade_journal.json directly):
//     railway run node scripts/backfillTitanLedger.js
//   Against prod over HTTP (no shell access required):
//     BACKFILL_VIA_HTTP=https://flow-scout-production.up.railway.app \
//       node scripts/backfillTitanLedger.js
//
// FLAGS
//   --dry         — print plan, don't write to journal, don't push Discord
//   --no-discord  — write to journal but skip Discord summary push
//
// IDEMPOTENT: Looks up existing positions by (ticker + entryTimestamp prefix
// truncated to minute) and skips duplicates. Safe to re-run.
//
// SOURCE: AB-shared Titan SIM screenshots, account SIM3142118M.
// =============================================================================

var path = require('path');
var simTradeJournal = require(path.join(__dirname, '..', 'src', 'simTradeJournal'));
var dp;
try { dp = require(path.join(__dirname, '..', 'src', 'discordPush')); } catch (e) { dp = null; }

var argv = process.argv.slice(2);
var DRY = argv.indexOf('--dry') !== -1;
var NO_DISCORD = argv.indexOf('--no-discord') !== -1;
var HTTP_BASE = process.env.BACKFILL_VIA_HTTP || null;
var fetchLib = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

// =============================================================================
// LEDGER (verified from Titan screenshots)
// quantity is the contract count (multiplier for P&L)
// "type: 'OPEN_ONLY'" = currently open at session end → openPosition only, no close
// =============================================================================
var trades = [
  // ===== MONDAY 5/4 =====
  {
    ticker: 'INTC', direction: 'short', contractSymbol: 'INTC 260508P',
    entryPrice: 3.85, entryTimestamp: '2026-05-04T13:35:00Z',
    exitPrice: 2.58, exitTimestamp: '2026-05-04T17:39:15Z',
    exitReason: 'STOP', conviction: 0, source: 'titan-backfill', quantity: 1,
  },
  {
    ticker: 'RIVN', direction: 'short', contractSymbol: 'RIVN 260508P',
    entryPrice: 0.43, entryTimestamp: '2026-05-04T13:30:00Z',
    exitPrice: 0.29, exitTimestamp: '2026-05-04T17:38:35Z',
    exitReason: 'STOP', conviction: 0, source: 'titan-backfill', quantity: 2,
  },
  {
    ticker: 'ADBE', direction: 'long', contractSymbol: 'ADBE 260508',
    entryPrice: 5.40, entryTimestamp: '2026-05-04T13:25:00Z',
    exitPrice: 3.65, exitTimestamp: '2026-05-04T17:34:10Z',
    exitReason: 'STOP', conviction: 0, source: 'titan-backfill', quantity: 1,
  },
  {
    ticker: 'CRWD', direction: 'long', contractSymbol: 'CRWD 260508',
    entryPrice: 11.50, entryTimestamp: '2026-05-04T13:15:00Z',
    exitPrice: 14.40, exitTimestamp: '2026-05-04T17:33:51Z',
    exitReason: 'TP1', conviction: 0, source: 'titan-backfill', quantity: 1,
  },
  {
    ticker: 'F', direction: 'short', contractSymbol: 'F 260508P11.5',
    entryPrice: 0.17, entryTimestamp: '2026-05-04T13:30:00Z',
    exitPrice: 0.12, exitTimestamp: '2026-05-04T17:33:07Z',
    exitReason: 'STOP', conviction: 0, source: 'titan-backfill', quantity: 2,
  },

  // ===== APRIL 30 =====
  {
    ticker: 'CRWD', direction: 'long', contractSymbol: 'CRWD 260501',
    entryPrice: null,  // not visible in screenshot
    exitPrice: 9.90, exitTimestamp: '2026-04-30T13:34:58Z',
    exitReason: 'CLOSE', conviction: 0, source: 'titan-backfill', quantity: 1,
    note: 'entry price not in screenshots — partial data',
  },

  // ===== APRIL 29 =====
  {
    ticker: 'BA', direction: 'short', contractSymbol: 'BA 260501P22',
    entryPrice: 2.78, entryTimestamp: '2026-04-29T15:34:18Z',
    exitPrice: 3.45, exitTimestamp: '2026-04-29T15:34:35Z',
    exitReason: 'TP1', conviction: 0, source: 'titan-backfill', quantity: 1,
    note: 'WINNER +24%',
  },
  {
    ticker: 'GM', direction: 'short', contractSymbol: 'GM 260501P7',
    entryPrice: 1.04, entryTimestamp: '2026-04-29T15:34:00Z',
    exitPrice: 0.70, exitTimestamp: '2026-04-29T15:34:23Z',
    exitReason: 'STOP', conviction: 0, source: 'titan-backfill', quantity: 1,
  },
  {
    ticker: 'OXY', direction: 'long', contractSymbol: 'OXY 260501C',
    entryPrice: null,
    exitPrice: 0.87, exitTimestamp: '2026-04-29T16:31:43Z',
    exitReason: 'CLOSE', conviction: 0, source: 'titan-backfill', quantity: 2,
    note: 'mixed exit — partial fills',
  },

  // ===== APRIL 28 =====
  {
    ticker: 'AMD', direction: 'short', contractSymbol: 'AMD 260501P',
    entryPrice: 9.30, entryTimestamp: '2026-04-28T18:49:09Z',
    exitPrice: null,
    exitTimestamp: '2026-04-28T18:49:09Z',
    exitReason: 'MANUAL', conviction: 0, source: 'titan-backfill', quantity: 1,
    note: 'exit at market — price not in visible ledger',
  },
  {
    ticker: 'KO', direction: 'long', contractSymbol: 'KO 260501C7',
    entryPrice: 0.63, entryTimestamp: '2026-04-28T18:48:47Z',
    exitPrice: null,
    exitTimestamp: '2026-04-28T18:48:47Z',
    exitReason: 'MANUAL', conviction: 0, source: 'titan-backfill', quantity: 1,
    note: 'exit at market',
  },
  {
    ticker: 'GM', direction: 'long', contractSymbol: 'GM 260501C7',
    entryPrice: 1.37, entryTimestamp: '2026-04-28T18:47:41Z',
    exitPrice: null,
    exitTimestamp: null,
    exitReason: 'OPEN_OR_UNKNOWN', conviction: 0, source: 'titan-backfill', quantity: 1,
    note: 'no exit visible — may still be open or expired',
  },

  // ===== TODAY 5/5 =====
  // NTAP-2 small strike — the +50% win. Distinct from NTAP 260515C115 (already in journal)
  {
    ticker: 'NTAP', direction: 'long', contractSymbol: 'NTAP 260515C lowstrike',
    entryPrice: 0.50, entryTimestamp: '2026-05-05T13:55:10Z',
    exitPrice: 0.75, exitTimestamp: '2026-05-05T13:55:10Z',
    exitReason: 'TP1', conviction: 9, source: 'jsmith-discord-day', quantity: 2,
    note: 'NTAP-2 +50% win — small-strike short-DTE play',
  },
  // The XLV 1ct that stopped earlier (the OTHER 1ct of the 2ct fire). The
  // remaining 1ct is the one already in journal under XLV_...urem16 (entry $1.11).
  {
    ticker: 'XLV', direction: 'short', contractSymbol: 'XLV 260515P stopped-leg',
    entryPrice: 1.11, entryTimestamp: '2026-05-05T14:35:00Z',
    exitPrice: 1.06, exitTimestamp: '2026-05-05T14:36:50Z',
    exitReason: 'STOP', conviction: 8, source: 'AYCE-3-2-2-First-Live', quantity: 1,
    note: 'one of 2ct stopped at small loss; remaining 1ct already in journal',
  },

  // ===== OPEN POSITIONS at end of session — backfill the ones NOT already in journal =====
  // (UNH/XLE/NTAP-115/NVDA/XLV-144 are already EOD-closed in journal — skip them)
  // CART is the Monday carryover that wasn't in the existing 5/5 journal closes.
  {
    type: 'OPEN_ONLY',
    ticker: 'CART', direction: 'long', contractSymbol: 'CART 260515C44.5',
    entryPrice: 2.05, entryTimestamp: '2026-05-04T17:57:14Z',
    conviction: 0, source: 'titan-backfill-monday-carry', quantity: 1,
    note: 'Monday carryover — currently +6.1%',
  },
];

// =============================================================================
// IDEMPOTENCY: signature = ticker + entryTimestamp truncated to minute
// We can also include contractSymbol since user might re-fire same ticker.
// =============================================================================
function tradeKey(t) {
  var ts = t.entryTimestamp ? t.entryTimestamp.slice(0, 16) : 'NO_TS'; // "2026-05-04T13:35"
  return t.ticker + '|' + (t.contractSymbol || 'NO_SYM') + '|' + ts;
}

async function existingKeys() {
  if (HTTP_BASE) {
    try {
      var r = await fetchLib(HTTP_BASE + '/api/sim-auto/journal?days=60');
      var data = await r.json();
      var keys = new Set();
      (data.activePositions || []).forEach(function(p) {
        var ts = p.entryTimestamp ? p.entryTimestamp.slice(0, 16) : 'NO_TS';
        keys.add(p.ticker + '|' + (p.contractSymbol || 'NO_SYM') + '|' + ts);
      });
      (data.closedPositions || []).forEach(function(p) {
        var ts = p.entryTimestamp ? p.entryTimestamp.slice(0, 16) : 'NO_TS';
        keys.add(p.ticker + '|' + (p.contractSymbol || 'NO_SYM') + '|' + ts);
      });
      return keys;
    } catch (e) {
      console.error('[HTTP] existingKeys failed:', e.message);
      return new Set();
    }
  }
  // Local — read /data file
  var snap = simTradeJournal.loadJournal();
  var keys = new Set();
  (snap.activePositions || []).forEach(function(p) {
    var ts = p.entryTimestamp ? p.entryTimestamp.slice(0, 16) : 'NO_TS';
    keys.add(p.ticker + '|' + (p.contractSymbol || 'NO_SYM') + '|' + ts);
  });
  Object.keys(snap.closed || {}).forEach(function(d) {
    (snap.closed[d] || []).forEach(function(p) {
      var ts = p.entryTimestamp ? p.entryTimestamp.slice(0, 16) : 'NO_TS';
      keys.add(p.ticker + '|' + (p.contractSymbol || 'NO_SYM') + '|' + ts);
    });
  });
  return keys;
}

// HTTP wrappers — match the contract of the local simTradeJournal functions
async function httpOpen(args) {
  var r = await fetchLib(HTTP_BASE + '/api/sim-auto/journal/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  var j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.ok === false) {
    return { ok: false, error: (j && j.error) || ('HTTP ' + r.status) };
  }
  return j;
}

async function httpClose(contractSymbol, args) {
  var body = Object.assign({ contractSymbol: contractSymbol }, args || {});
  var r = await fetchLib(HTTP_BASE + '/api/sim-auto/journal/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  var j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.ok === false) {
    return { ok: false, error: (j && j.error) || ('HTTP ' + r.status) };
  }
  return j;
}

async function httpJournalSnapshot(days) {
  var r = await fetchLib(HTTP_BASE + '/api/sim-auto/journal?days=' + (days || 30));
  var j = await r.json();
  return j;
}

async function openPos(args) {
  if (HTTP_BASE) return await httpOpen(args);
  return simTradeJournal.openPosition(args);
}
async function closePos(symbol, args) {
  if (HTTP_BASE) return await httpClose(symbol, args);
  return simTradeJournal.closePosition(symbol, args);
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log('============================================================');
  console.log('PHASE 4.28 — TITAN SIM LEDGER BACKFILL');
  console.log('Source: SIM3142118M screenshots (Apr 28 - May 5)');
  console.log('Mode:   ' + (DRY ? 'DRY-RUN (no writes)' : 'WRITE'));
  console.log('Target: ' + (HTTP_BASE ? ('HTTP ' + HTTP_BASE) : 'local DATA_DIR=' + (process.env.DATA_DIR || '<default>')));
  console.log('============================================================');

  var dup = await existingKeys();
  console.log('Existing journal keys: ' + dup.size);

  var summary = {
    attempted: 0,
    skippedDuplicate: 0,
    skippedMissingPrice: 0,
    skippedMissingExit: 0,
    openedOnly: 0,
    closed: 0,
    errors: 0,
    rows: [],
  };

  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    summary.attempted++;
    var key = tradeKey(t);

    // Skip if already in journal
    if (dup.has(key)) {
      summary.skippedDuplicate++;
      summary.rows.push({
        ticker: t.ticker, contract: t.contractSymbol, status: 'SKIP-DUP',
      });
      console.log('[SKIP-DUP] ' + key);
      continue;
    }

    // OPEN_ONLY = open without closing
    if (t.type === 'OPEN_ONLY') {
      if (!t.entryPrice) {
        summary.skippedMissingPrice++;
        summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'SKIP-NO-ENTRY' });
        console.log('[SKIP-NO-ENTRY] ' + t.ticker + ' (open-only without entry price)');
        continue;
      }
      if (DRY) {
        summary.openedOnly++;
        summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'OPEN-PLAN', pnl: null });
        console.log('[DRY-OPEN] ' + t.ticker + ' ' + t.contractSymbol + ' x' + t.quantity + ' @ $' + t.entryPrice);
        continue;
      }
      var openOnly = await openPos({
        ticker: t.ticker,
        direction: t.direction,
        contractSymbol: t.contractSymbol,
        entryPrice: t.entryPrice,
        entryTimestamp: t.entryTimestamp,
        conviction: t.conviction,
        source: t.source,
        contracts: t.quantity,
      });
      if (!openOnly.ok) {
        summary.errors++;
        summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'ERR-OPEN', err: openOnly.error });
        console.error('[ERR-OPEN] ' + t.ticker + ': ' + openOnly.error);
        continue;
      }
      summary.openedOnly++;
      summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'OPENED' });
      continue;
    }

    // CLOSED trade — need both entry and exit price to log meaningful P&L
    if (!t.entryPrice) {
      summary.skippedMissingPrice++;
      summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'SKIP-NO-ENTRY' });
      console.log('[SKIP-NO-ENTRY] ' + t.ticker + ' ' + (t.note || ''));
      continue;
    }
    if (t.exitPrice == null) {
      summary.skippedMissingExit++;
      summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'SKIP-NO-EXIT' });
      console.log('[SKIP-NO-EXIT] ' + t.ticker + ' ' + (t.note || ''));
      continue;
    }

    var pnlPct = ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
    var pnlDollar = (t.exitPrice - t.entryPrice) * 100 * (t.quantity || 1);

    if (DRY) {
      summary.closed++;
      summary.rows.push({
        ticker: t.ticker, contract: t.contractSymbol, status: 'CLOSE-PLAN',
        pnlPct: pnlPct, pnlDollar: pnlDollar,
      });
      console.log('[DRY-CLOSE] ' + t.ticker + ' ' + t.contractSymbol +
                  ' x' + t.quantity + ' ' + t.exitReason +
                  ' ' + pnlPct.toFixed(1) + '% ($' + pnlDollar.toFixed(0) + ')');
      continue;
    }

    var openR = await openPos({
      ticker: t.ticker,
      direction: t.direction,
      contractSymbol: t.contractSymbol,
      entryPrice: t.entryPrice,
      entryTimestamp: t.entryTimestamp,
      conviction: t.conviction,
      source: t.source,
      contracts: t.quantity,
    });
    if (!openR.ok) {
      summary.errors++;
      summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'ERR-OPEN', err: openR.error });
      console.error('[ERR-OPEN] ' + t.ticker + ': ' + openR.error);
      continue;
    }

    var closeR = await closePos(t.contractSymbol, {
      exitPrice: t.exitPrice,
      exitTimestamp: t.exitTimestamp,
      exitReason: t.exitReason,
    });
    if (!closeR.ok) {
      summary.errors++;
      summary.rows.push({ ticker: t.ticker, contract: t.contractSymbol, status: 'ERR-CLOSE', err: closeR.error });
      console.error('[ERR-CLOSE] ' + t.ticker + ': ' + closeR.error);
      continue;
    }

    summary.closed++;
    summary.rows.push({
      ticker: t.ticker, contract: t.contractSymbol, status: 'CLOSED',
      pnlPct: closeR.position.pnlPct, pnlDollar: closeR.position.pnlDollar,
      outcome: closeR.position.outcome,
    });
  }

  // -----------------------------------------------------------
  // Build final stats
  // -----------------------------------------------------------
  var stats7, stats30, allClosed7;
  if (HTTP_BASE) {
    var snap7 = await httpJournalSnapshot(7);
    var snap30 = await httpJournalSnapshot(30);
    stats7 = snap7.stats;
    stats30 = snap30.stats;
    allClosed7 = snap7.closedPositions || [];
  } else {
    stats7 = simTradeJournal.computeWinRate(7);
    stats30 = simTradeJournal.computeWinRate(30);
    allClosed7 = simTradeJournal.getClosedByDateRange(7);
  }
  var netPnl = allClosed7.reduce(function(s, p) { return s + (p.pnlDollar || 0); }, 0);
  var winsArr = allClosed7.filter(function(p) { return p.outcome === 'win'; });
  var lossesArr = allClosed7.filter(function(p) { return p.outcome === 'loss'; });
  var avgWinDollar = winsArr.length ? winsArr.reduce(function(s, p) { return s + (p.pnlDollar || 0); }, 0) / winsArr.length : 0;
  var avgLossDollar = lossesArr.length ? lossesArr.reduce(function(s, p) { return s + (p.pnlDollar || 0); }, 0) / lossesArr.length : 0;
  var expectancy = stats7.total > 0 ? netPnl / stats7.total : 0;

  console.log('============================================================');
  console.log('BACKFILL SUMMARY');
  console.log('============================================================');
  console.log('Attempted:           ' + summary.attempted);
  console.log('Skipped duplicates:  ' + summary.skippedDuplicate);
  console.log('Skipped missing $:   ' + summary.skippedMissingPrice);
  console.log('Skipped no exit:     ' + summary.skippedMissingExit);
  console.log('Opened-only:         ' + summary.openedOnly);
  console.log('Closed:              ' + summary.closed);
  console.log('Errors:              ' + summary.errors);
  console.log('-----------------------------------------------------------');
  console.log('JOURNAL STATS (7-day window):');
  console.log('  Total decisive: ' + (stats7.wins + stats7.losses) + ' (' + stats7.wins + 'W / ' + stats7.losses + 'L)');
  console.log('  Flat:           ' + stats7.flat);
  console.log('  Win rate:       ' + stats7.winRatePct.toFixed(1) + '%');
  console.log('  Avg win:        ' + (stats7.avgWinPct || 0).toFixed(1) + '%  ($' + avgWinDollar.toFixed(0) + ')');
  console.log('  Avg loss:       ' + (stats7.avgLossPct || 0).toFixed(1) + '%  ($' + avgLossDollar.toFixed(0) + ')');
  console.log('  Net realized:   $' + netPnl.toFixed(0));
  console.log('  Expectancy/trd: $' + expectancy.toFixed(2));
  console.log('-----------------------------------------------------------');
  console.log('JOURNAL STATS (30-day window): ' + stats30.wins + 'W / ' + stats30.losses + 'L (' + stats30.winRatePct.toFixed(1) + '%)');
  console.log('-----------------------------------------------------------');
  console.log('Per-trade breakdown:');
  summary.rows.forEach(function(r) {
    var line = '  [' + r.status + '] ' + r.ticker + ' ' + (r.contract || '');
    if (r.pnlPct != null) line += '  ' + r.pnlPct.toFixed(1) + '%  $' + r.pnlDollar.toFixed(0);
    if (r.outcome) line += '  (' + r.outcome + ')';
    if (r.err) line += '  err=' + r.err;
    console.log(line);
  });
  console.log('============================================================');

  // -----------------------------------------------------------
  // Conviction-vs-outcome correlation (only trades with conviction>0)
  // -----------------------------------------------------------
  var withConviction = allClosed7.filter(function(p) { return p.conviction && p.conviction > 0; });
  if (withConviction.length > 0) {
    console.log('\nCONVICTION CORRELATION (trades w/ conviction>0):');
    withConviction.forEach(function(p) {
      console.log('  conv=' + p.conviction + '  ' + p.ticker + '  ' + (p.outcome || '?') + '  ' +
                  (p.pnlPct != null ? p.pnlPct.toFixed(1) + '%' : '?'));
    });
    var avgConvWin = winsArr.filter(function(p) { return p.conviction; }).reduce(function(s, p) { return s + p.conviction; }, 0) /
                     Math.max(1, winsArr.filter(function(p) { return p.conviction; }).length);
    var avgConvLoss = lossesArr.filter(function(p) { return p.conviction; }).reduce(function(s, p) { return s + p.conviction; }, 0) /
                      Math.max(1, lossesArr.filter(function(p) { return p.conviction; }).length);
    console.log('  avgConv on wins:   ' + avgConvWin.toFixed(1));
    console.log('  avgConv on losses: ' + avgConvLoss.toFixed(1));
  }

  // -----------------------------------------------------------
  // Discord push
  // -----------------------------------------------------------
  if (DRY || NO_DISCORD || !dp) {
    console.log('\n[DISCORD] Skipped (' + (DRY ? 'dry-run' : NO_DISCORD ? 'no-discord flag' : 'discordPush not loaded') + ')');
    return;
  }

  var winRows = winsArr.map(function(p) {
    return p.ticker + ' ' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(0) + '%';
  }).join(', ') || '—';
  var lossRows = lossesArr.map(function(p) {
    return p.ticker + ' ' + p.pnlPct.toFixed(0) + '%';
  }).join(', ') || '—';

  var embed = {
    username: 'Flow Scout — Phase 4.28 Backfill',
    embeds: [{
      title: '📒 SIM JOURNAL BACKFILL COMPLETE',
      description: 'Phase 4.28 — Titan SIM3142118M ledger piped into journal.',
      color: 5763719,
      fields: [
        { name: 'Period', value: 'Apr 28 — May 5 2026', inline: false },
        { name: 'Total trades (closed, 7d)', value: String(stats7.wins + stats7.losses + stats7.flat), inline: true },
        { name: 'Wins', value: String(stats7.wins) + ' (' + stats7.winRatePct.toFixed(0) + '%)', inline: true },
        { name: 'Losses', value: String(stats7.losses), inline: true },
        { name: 'Net realized (7d)', value: '$' + netPnl.toFixed(0), inline: true },
        { name: 'Avg win', value: '$' + avgWinDollar.toFixed(0) + ' (' + (stats7.avgWinPct || 0).toFixed(0) + '%)', inline: true },
        { name: 'Avg loss', value: '$' + avgLossDollar.toFixed(0) + ' (' + (stats7.avgLossPct || 0).toFixed(0) + '%)', inline: true },
        { name: 'Expectancy / trade', value: '$' + expectancy.toFixed(2) + (expectancy > 0 ? '  (POSITIVE EDGE)' : '  (negative)'), inline: false },
        { name: 'Wins', value: winRows.slice(0, 1000), inline: false },
        { name: 'Losses', value: lossRows.slice(0, 1000), inline: false },
        { name: 'Backfill counts', value:
          'Closed: ' + summary.closed +
          '  |  Open-only: ' + summary.openedOnly +
          '  |  Skipped-dup: ' + summary.skippedDuplicate +
          '  |  Skipped-no-data: ' + (summary.skippedMissingPrice + summary.skippedMissingExit), inline: false },
      ],
      footer: { text: 'Flow Scout | Phase 4.28 | Source: AB Titan screenshots' },
      timestamp: new Date().toISOString(),
    }],
  };

  var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
    'https://discord.com/api/webhooks/1494838146272333887/6JmwoJRhys8Rm55DT7FNUVZZF_JYLtGxKmfVj4T9X_mcuisNPMUjDJ3D3WX2Txwfe4xw';
  try {
    var pushR = await dp.send('phase4.28-backfill', embed, { webhook: DISCORD_WEBHOOK });
    console.log('\n[DISCORD] push: ' + JSON.stringify(pushR));
  } catch (e) {
    console.error('[DISCORD] push failed:', e.message);
  }
}

main().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error('FATAL:', e);
  process.exit(1);
});
