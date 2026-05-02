// =============================================================================
// CHART ARCHIVER — downloads chart attachments from Discord raw JSON archives
// to local storage so they survive Discord CDN URL expiry.
//
// Walks the 4 channel raw files (cvo-swings-leaps, option-trade-ideas,
// vip-flow-options-alerts, free-charts) and downloads every attachment +
// embed image URL to /data/charts/{channel}/. Saves a .json sidecar with
// ticker/title/body/timestamp = labeled training data alongside each image.
//
// Idempotent: re-running skips already-downloaded files. Run nightly via cron
// so new posts get archived before Discord CDN expires their URLs.
// =============================================================================

var fs = require('fs');
var path = require('path');
var https = require('https');

var DATA_ROOT = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
var HIST_DIR = path.join(DATA_ROOT, 'john_history');
var CHARTS_DIR = path.join(DATA_ROOT, 'charts');

var CHANNELS = [
  { file: 'cvo-swings-leaps.raw.json',         dirName: 'cvo-swings' },
  { file: 'option-trade-ideas.raw.json',       dirName: 'option-trade-ideas' },
  { file: 'vip-flow-options-alerts.raw.json',  dirName: 'lotto' },
  { file: 'free-charts.raw.json',              dirName: 'sniper' },
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Parse a ticker from message title/content (best-effort)
function extractTicker(msg) {
  var sources = [];
  var embeds = msg.embeds || [];
  for (var i = 0; i < embeds.length; i++) {
    if (embeds[i].title) sources.push(embeds[i].title);
    if (embeds[i].description) sources.push(embeds[i].description.slice(0, 200));
  }
  if (msg.content) sources.push(msg.content.slice(0, 200));
  for (var s = 0; s < sources.length; s++) {
    var t = sources[s];
    var m = t.match(/^([A-Z]{1,5})\s+[—–-]/) || t.match(/\$([A-Z]{1,5})\b/) || t.match(/\b([A-Z]{2,5})\b/);
    if (m && m[1].length >= 1) return m[1];
  }
  return 'UNKNOWN';
}

// Sanitize a filename
function safe(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

// Pull file extension from URL (strip query params)
function urlExt(u) {
  try {
    var pathOnly = String(u).split('?')[0];
    var ext = path.extname(pathOnly).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0 ? ext : '.png';
  } catch(e) { return '.png'; }
}

// Download a URL to a local path; resolves to bytes written or 0 if skipped
function downloadOne(url, dest) {
  return new Promise(function(resolve) {
    if (fs.existsSync(dest)) return resolve({ skipped: true, bytes: 0 });
    var attempt = function(remainingRedirects) {
      var req = https.get(url, { timeout: 15000 }, function(resp) {
        if ((resp.statusCode === 301 || resp.statusCode === 302) && resp.headers.location && remainingRedirects > 0) {
          resp.resume();
          return attempt(remainingRedirects - 1);
        }
        if (resp.statusCode !== 200) {
          resp.resume();
          return resolve({ error: 'HTTP-' + resp.statusCode, bytes: 0 });
        }
        var stream = fs.createWriteStream(dest);
        var bytes = 0;
        resp.on('data', function(chunk) { bytes += chunk.length; });
        resp.pipe(stream);
        stream.on('finish', function() { stream.close(function() { resolve({ ok: true, bytes: bytes }); }); });
        stream.on('error', function(e) { try { fs.unlinkSync(dest); } catch(_) {} resolve({ error: e.message, bytes: 0 }); });
      });
      req.on('error', function(e) { resolve({ error: e.message, bytes: 0 }); });
      req.on('timeout', function() { req.destroy(); resolve({ error: 'timeout', bytes: 0 }); });
    };
    attempt(3);
  });
}

// Iterate all channels and download every chart-bearing message's images
async function runArchive(opts) {
  opts = opts || {};
  ensureDir(CHARTS_DIR);
  var totals = { totalMsgsScanned: 0, totalUrls: 0, downloaded: 0, skipped: 0, errors: 0, byChannel: {} };

  for (var c = 0; c < CHANNELS.length; c++) {
    var ch = CHANNELS[c];
    var fp = path.join(HIST_DIR, ch.file);
    if (!fs.existsSync(fp)) {
      totals.byChannel[ch.dirName] = { error: 'file-missing' };
      continue;
    }
    var data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { totals.byChannel[ch.dirName] = { error: 'parse: ' + e.message }; continue; }
    if (!Array.isArray(data)) continue;

    var dir = path.join(CHARTS_DIR, ch.dirName);
    ensureDir(dir);

    var chTotals = { msgs: data.length, urls: 0, downloaded: 0, skipped: 0, errors: 0 };

    for (var i = 0; i < data.length; i++) {
      var msg = data[i];
      totals.totalMsgsScanned++;
      var msgId = msg.id || ('msg' + i);
      var ts = (msg.timestamp || '').slice(0, 10) || 'unknown';
      var ticker = extractTicker(msg);

      // Collect URLs from attachments AND embed images/thumbnails
      var urls = [];
      (msg.attachments || []).forEach(function(a) { if (a && a.url) urls.push(a.url); });
      (msg.embeds || []).forEach(function(e) {
        if (e && e.image && e.image.url) urls.push(e.image.url);
        else if (e && e.thumbnail && e.thumbnail.url) urls.push(e.thumbnail.url);
      });
      if (!urls.length) continue;

      for (var u = 0; u < urls.length; u++) {
        var url = urls[u];
        chTotals.urls++;
        totals.totalUrls++;
        var ext = urlExt(url);
        var fname = safe(ticker) + '_' + safe(ts) + '_' + safe(msgId) + (urls.length > 1 ? '_' + u : '') + ext;
        var dest = path.join(dir, fname);

        // Cap concurrent downloads — keep it serial for politeness vs Discord CDN
        var result = await downloadOne(url, dest);
        if (result.skipped) {
          chTotals.skipped++;
          totals.skipped++;
        } else if (result.ok) {
          chTotals.downloaded++;
          totals.downloaded++;
          // Sidecar JSON with metadata
          var sidecar = path.join(dir, fname + '.json');
          var meta = {
            channel: ch.dirName,
            msgId: msgId,
            ticker: ticker,
            postedAt: msg.timestamp || null,
            title: ((msg.embeds || [])[0] || {}).title || null,
            body: (((msg.embeds || [])[0] || {}).description || msg.content || '').slice(0, 1500),
            sourceUrl: url,
            archivedAt: new Date().toISOString(),
            bytes: result.bytes,
            author: (msg.author || {}).username || null,
          };
          try { fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2)); } catch(_) {}
        } else {
          chTotals.errors++;
          totals.errors++;
        }

        // Cap total downloads if requested (for testing)
        if (opts.limit && totals.downloaded >= opts.limit) {
          totals.byChannel[ch.dirName] = chTotals;
          return totals;
        }
      }
    }
    totals.byChannel[ch.dirName] = chTotals;
  }
  return totals;
}

// List all archived charts (optional filters: channel, ticker)
function listCharts(opts) {
  opts = opts || {};
  ensureDir(CHARTS_DIR);
  var out = [];
  var dirs = opts.channel ? [opts.channel] : fs.readdirSync(CHARTS_DIR).filter(function(d) {
    return fs.statSync(path.join(CHARTS_DIR, d)).isDirectory();
  });
  for (var d = 0; d < dirs.length; d++) {
    var dir = path.join(CHARTS_DIR, dirs[d]);
    if (!fs.existsSync(dir)) continue;
    var files = fs.readdirSync(dir).filter(function(f) { return !f.endsWith('.json'); });
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var sidecar = path.join(dir, f + '.json');
      var meta = null;
      if (fs.existsSync(sidecar)) {
        try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch(_) {}
      }
      if (opts.ticker && meta && meta.ticker !== opts.ticker.toUpperCase()) continue;
      out.push({
        channel: dirs[d],
        filename: f,
        path: '/api/charts/serve/' + dirs[d] + '/' + f,
        ticker: meta && meta.ticker,
        title: meta && meta.title,
        postedAt: meta && meta.postedAt,
        body: meta && (meta.body || '').slice(0, 200),
      });
    }
  }
  out.sort(function(a, b) { return (b.postedAt || '').localeCompare(a.postedAt || ''); });
  return { count: out.length, charts: out.slice(0, opts.limit || 100) };
}

function getChartPath(channel, filename) {
  // Defensive — prevent path traversal
  if (!channel || !filename) return null;
  if (channel.includes('..') || filename.includes('..') || channel.includes('/') || filename.includes('/')) return null;
  var p = path.join(CHARTS_DIR, channel, filename);
  if (!fs.existsSync(p)) return null;
  return p;
}

function getStatus() {
  ensureDir(CHARTS_DIR);
  var byChannel = {};
  try {
    var dirs = fs.readdirSync(CHARTS_DIR).filter(function(d) { return fs.statSync(path.join(CHARTS_DIR, d)).isDirectory(); });
    for (var d = 0; d < dirs.length; d++) {
      var dir = path.join(CHARTS_DIR, dirs[d]);
      var files = fs.readdirSync(dir).filter(function(f) { return !f.endsWith('.json'); });
      byChannel[dirs[d]] = files.length;
    }
  } catch(_) {}
  return { chartsDir: CHARTS_DIR, byChannel: byChannel };
}

module.exports = {
  runArchive: runArchive,
  listCharts: listCharts,
  getChartPath: getChartPath,
  getStatus: getStatus,
};
