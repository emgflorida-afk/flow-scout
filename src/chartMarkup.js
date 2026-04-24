// chartMarkup.js — Chart-level generator for TradingView (via queue)
// -----------------------------------------------------------------
// Created 2026-04-24. Server-side cannot directly draw on AB's local
// TradingView desktop (CDP port 9222 is local-only). Instead this
// module GENERATES a markup queue file that AB's local Claude session
// reads and executes via the TradingView MCP.
//
// Workflow:
//   1. Morning Planner identifies top 3 setups
//   2. For each, chartMarkup.queueSetup() writes to markup queue
//   3. AB opens Claude Code locally in morning
//   4. AB says "run chart markup"
//   5. Local Claude reads queue + marks charts via TV MCP
//
// Queue file: /data/chart_markup_queue.json
// -----------------------------------------------------------------

var fs = require('fs');
var path = require('path');

var STATE_DIR = process.env.STATE_DIR || '/tmp';
var QUEUE_FILE = path.join(STATE_DIR, 'chart_markup_queue.json');

// Color scheme (from CHART_MARKUP_PLAYBOOK.md)
var COLORS = {
  trigger: '#ffff00',       // yellow dashed
  stop: '#ff0000',          // red dashed
  tp1: '#00ff00',           // lime solid
  tp2: '#00aa00',           // green solid
  tp3: '#ffaa00',           // orange dotted (runner/pin)
  pdh: '#a78bfa',           // purple (prior day high)
  pdl: '#f472b6',           // pink (prior day low)
  vwap: '#06b6d4',          // cyan (VWAP)
};

function buildMarkupJob(opts) {
  return {
    id: opts.id || 'mk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    created: new Date().toISOString(),
    status: 'pending',
    ticker: opts.ticker,
    exchange: opts.exchange || 'NASDAQ',
    timeframe: opts.timeframe || '5',
    direction: opts.direction || 'LONG',
    levels: {
      trigger: opts.trigger,
      stop: opts.stop,
      tp1: opts.tp1,
      tp2: opts.tp2,
      tp3: opts.tp3,
      pdh: opts.pdh,
      pdl: opts.pdl,
      pmh: opts.pmh,  // pre-market high
      pml: opts.pml,  // pre-market low
    },
    colors: COLORS,
    reasoning: opts.reasoning || null,
  };
}

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch(e) { return { jobs: [], updatedAt: new Date().toISOString() }; }
}

function saveQueue(q) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }
  catch(e) { console.error('[CHARTMARKUP] save error:', e.message); }
}

function queueSetup(opts) {
  var job = buildMarkupJob(opts);
  var q = loadQueue();
  q.jobs.push(job);
  q.updatedAt = new Date().toISOString();
  saveQueue(q);
  return job;
}

function getPendingJobs() {
  var q = loadQueue();
  return (q.jobs || []).filter(function(j) { return j.status === 'pending'; });
}

function markJobComplete(id) {
  var q = loadQueue();
  (q.jobs || []).forEach(function(j) { if (j.id === id) j.status = 'complete'; });
  q.updatedAt = new Date().toISOString();
  saveQueue(q);
}

function clearQueue() {
  saveQueue({ jobs: [], updatedAt: new Date().toISOString(), cleared: true });
}

// Generate the exact TV MCP draw commands that local Claude should execute
function generateDrawCommands(job) {
  var commands = [];
  var currentTime = Math.floor(Date.now() / 1000);
  var lev = job.levels || {};

  // chart setup
  commands.push({ tool: 'chart_set_symbol', args: { symbol: job.exchange + ':' + job.ticker } });
  commands.push({ tool: 'chart_set_timeframe', args: { timeframe: job.timeframe } });

  function drawLine(price, color, lineStyle, label) {
    if (price == null || price <= 0) return;
    commands.push({
      tool: 'draw_shape',
      args: {
        shape: 'horizontal_line',
        point: { time: currentTime, price: price },
        overrides: JSON.stringify({ linecolor: color, linewidth: 2, linestyle: lineStyle })
      }
    });
    commands.push({
      tool: 'draw_shape',
      args: {
        shape: 'text',
        point: { time: currentTime, price: price },
        text: label,
        overrides: JSON.stringify({ color: color })
      }
    });
  }

  drawLine(lev.trigger, COLORS.trigger, 2, 'TRIGGER $' + lev.trigger);
  drawLine(lev.stop, COLORS.stop, 2, 'STOP $' + lev.stop);
  drawLine(lev.tp1, COLORS.tp1, 0, 'TP1 $' + lev.tp1);
  drawLine(lev.tp2, COLORS.tp2, 0, 'TP2 $' + lev.tp2);
  drawLine(lev.tp3, COLORS.tp3, 3, 'TP3 $' + lev.tp3 + ' (runner)');
  drawLine(lev.pdh, COLORS.pdh, 1, 'PDH $' + lev.pdh);
  drawLine(lev.pdl, COLORS.pdl, 1, 'PDL $' + lev.pdl);
  drawLine(lev.pmh, COLORS.pdh, 3, 'PMH $' + lev.pmh);
  drawLine(lev.pml, COLORS.pdl, 3, 'PML $' + lev.pml);

  commands.push({ tool: 'capture_screenshot', args: { region: 'chart', filename: job.ticker + '_marked_' + new Date().toISOString().slice(0, 10) } });

  return commands;
}

module.exports = {
  queueSetup: queueSetup,
  getPendingJobs: getPendingJobs,
  markJobComplete: markJobComplete,
  clearQueue: clearQueue,
  generateDrawCommands: generateDrawCommands,
  COLORS: COLORS,
};
