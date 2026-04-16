// armPage.js -- Stratum v7.5
// -----------------------------------------------------------------
// Phone-native one-tap arm/kill page for the brain queue.
// Mount via: app.get('/arm', armPage.handler)
// Save to iOS/Android home screen for a true native-feeling button.
// -----------------------------------------------------------------

var HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Stratum">
<meta name="theme-color" content="#0b0f14">
<title>Stratum ARM</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom);
    background: #0b0f14; color: #e6edf3;
    font: 500 16px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
    min-height: 100vh;
    display: flex; flex-direction: column;
  }
  header { padding: 20px 4px 8px; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
  .sub { color: #7d8590; font-size: 13px; margin-top: 4px; }
  .state {
    margin: 16px 0 24px; padding: 16px; border-radius: 14px;
    background: #161b22; border: 1px solid #30363d;
  }
  .state .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; }
  .state .row + .row { border-top: 1px solid #21262d; }
  .state .k { color: #7d8590; font-size: 13px; }
  .state .v { font-weight: 600; }
  .pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .on  { background: #0d4f2a; color: #7ee2a8; }
  .off { background: #4f1a1a; color: #ff9999; }
  .af-on  { background: #0a3d66; color: #7ec2ff; }
  .af-off { background: #3d2e0a; color: #ffcf7e; }
  button {
    width: 100%; padding: 22px; margin: 10px 0; border: 0; border-radius: 16px;
    font: 800 18px/1 -apple-system,system-ui,sans-serif; letter-spacing: 0.5px;
    transition: transform 0.08s ease, filter 0.12s ease;
    cursor: pointer; color: white;
  }
  button:active { transform: scale(0.97); filter: brightness(0.9); }
  .arm  { background: linear-gradient(180deg,#1f6feb,#1158c7); box-shadow: 0 4px 16px rgba(31,111,235,0.35); }
  .kill { background: linear-gradient(180deg,#da3633,#a82e2a); box-shadow: 0 4px 16px rgba(218,54,51,0.35); }
  .auto { background: linear-gradient(180deg,#8957e5,#6e40c9); box-shadow: 0 4px 16px rgba(137,87,229,0.35); }
  .small { padding: 12px; font-size: 14px; font-weight: 600; }
  .ghost { background: #21262d; color: #e6edf3; }
  .queue { margin-top: 20px; padding: 12px; border-radius: 12px; background: #161b22; border: 1px solid #30363d; }
  .q-item { padding: 10px 0; border-top: 1px solid #21262d; font-size: 13px; }
  .q-item:first-child { border-top: 0; }
  .q-head { display: flex; justify-content: space-between; font-weight: 600; font-size: 14px; }
  .q-sub { color: #7d8590; font-size: 12px; margin-top: 2px; }
  .grade-Aplus { color: #7ee2a8; font-weight: 800; }
  .grade-A { color: #7ec2ff; font-weight: 700; }
  .grade-B { color: #ffcf7e; }
  .flash { animation: flash 0.4s ease; }
  @keyframes flash { 0% { background:#0d4f2a; } 100% { background:#161b22; } }
  footer { margin-top: auto; padding: 16px 0; color: #484f58; font-size: 11px; text-align: center; }
  .calls { color: #7ee2a8; }
  .puts  { color: #ff9999; }
  /* Health heartbeat strip */
  .hb {
    margin: 8px 0 4px; padding: 10px 14px; border-radius: 10px;
    font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px;
    border: 1px solid #30363d;
  }
  .hb-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .hb-green  { background: #0d4f2a; color: #7ee2a8; }
  .hb-green .hb-dot { background: #7ee2a8; box-shadow: 0 0 6px #7ee2a8; }
  .hb-yellow { background: #3d2e0a; color: #ffcf7e; }
  .hb-yellow .hb-dot { background: #ffcf7e; box-shadow: 0 0 6px #ffcf7e; }
  .hb-red    { background: #4f1a1a; color: #ff9999; }
  .hb-red .hb-dot { background: #ff9999; box-shadow: 0 0 6px #ff9999; }
  .hb-gray   { background: #161b22; color: #7d8590; }
  .hb-gray .hb-dot { background: #484f58; }
  .scout-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .scout-chip {
    padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
    background: #21262d; color: #7d8590;
  }
  .scout-chip.ok { background: #0d4f2a; color: #7ee2a8; }
  .scout-chip.err { background: #4f1a1a; color: #ff9999; }
  .scout-chip.stale { background: #3d2e0a; color: #ffcf7e; }
</style>
</head>
<body>

<header>
  <h1>Stratum · ARM</h1>
  <div class="sub" id="clock">Loading…</div>
</header>

<div class="hb hb-gray" id="heartbeat">
  <span class="hb-dot"></span>
  <span id="hb-text">Checking system…</span>
</div>
<div class="scout-row" id="scout-chips"></div>

<div class="state" id="state">
  <div class="row"><span class="k">Queue</span><span class="v"><span class="pill off" id="queue-pill">OFF</span></span></div>
  <div class="row"><span class="k">Auto-Fire</span><span class="v"><span class="pill af-off" id="af-pill">OFF</span></span></div>
  <div class="row"><span class="k">Pending</span><span class="v" id="pending-count">—</span></div>
  <div class="row"><span class="k">FTFC (SPY)</span><span class="v" id="ftfc">—</span></div>
</div>

<button class="arm"  onclick="armQueue()">ARM QUEUE</button>
<button class="kill" onclick="killQueue()">KILL — DISARM</button>
<button class="auto" onclick="toggleAuto()">TOGGLE AUTO-FIRE</button>
<button class="small ghost" onclick="refresh()">⟳ Refresh</button>

<div class="queue" id="queue"><div class="q-sub">Loading queue…</div></div>

<div class="queue" id="watchlist-section" style="margin-top:20px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-weight:700;font-size:14px">Watchlist</span>
    <span class="q-sub" id="wl-count">—</span>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <input id="add-ticker" type="text" placeholder="Add ticker (e.g. RIVN)" autocapitalize="characters" autocorrect="off" spellcheck="false"
      style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px;outline:none;">
    <button onclick="addTicker()" class="small" style="width:auto;padding:10px 18px;margin:0;background:linear-gradient(180deg,#238636,#1a7f37);border-radius:10px;font-size:14px">+ ADD</button>
  </div>
  <div id="wl-tags" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
</div>

<footer>Tap ARM to go live. Tap KILL to stop. Auto-fire only touches A+.</footer>

<script>
var lastQueueLen = -1;

async function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  var r = await fetch(path, opts);
  return r.json();
}

function fmtTime() {
  var d = new Date();
  return d.toLocaleString('en-US', { timeZone:'America/New_York', hour:'numeric', minute:'2-digit', second:'2-digit', weekday:'short', month:'short', day:'numeric' }) + ' ET';
}

function renderQueue(trades) {
  var pending = trades.filter(function(t){ return t.status === 'PENDING'; });
  document.getElementById('pending-count').textContent = String(pending.length);
  var el = document.getElementById('queue');
  if (pending.length !== lastQueueLen && lastQueueLen >= 0) el.classList.add('flash');
  setTimeout(function(){ el.classList.remove('flash'); }, 400);
  lastQueueLen = pending.length;
  if (!pending.length) { el.innerHTML = '<div class="q-sub">Queue empty — scouts scanning…</div>'; return; }
  el.innerHTML = pending.map(function(t) {
    var g = (t.grade || '').replace('+','plus');
    var dirCls = t.direction === 'CALLS' ? 'calls' : 'puts';
    return '<div class="q-item">'
      + '<div class="q-head"><span>'+ t.ticker +' <span class="'+ dirCls +'">'+ t.direction +'</span></span>'
      + '<span class="grade-'+ g +'">'+ (t.grade || '—') +'</span></div>'
      + '<div class="q-sub">'+ (t.contractSymbol||'') +' · trig '+ t.triggerPrice +' · x'+ t.contracts +' · '+ (t.source||'') +'</div>'
      + '</div>';
  }).join('');
}

async function refresh() {
  try {
    var q = await api('GET','/api/queue/list');
    document.getElementById('queue-pill').className = 'pill ' + (q.active ? 'on' : 'off');
    document.getElementById('queue-pill').textContent = q.active ? 'ARMED' : 'OFF';
    renderQueue(q.trades || []);
  } catch(e) {}
  try {
    var af = await api('GET','/api/autofire/status');
    document.getElementById('af-pill').className = 'pill ' + (af.enabled ? 'af-on' : 'af-off');
    document.getElementById('af-pill').textContent = af.enabled ? 'ON (A+)' : 'OFF';
    if (af.ftfc) document.getElementById('ftfc').textContent = af.ftfc;
  } catch(e) {}
  document.getElementById('clock').textContent = fmtTime();
}

async function armQueue() {
  if (!confirm('ARM queue? Triggers will fire on match.')) return;
  await api('POST','/api/queue/start');
  refresh();
}
async function killQueue() {
  await api('POST','/api/queue/stop');
  refresh();
}
async function toggleAuto() {
  var af = await api('GET','/api/autofire/status');
  if (!confirm((af.enabled ? 'Turn OFF' : 'Turn ON') + ' auto-fire (A+ only)?')) return;
  await api('POST','/api/autofire/toggle', { enabled: !af.enabled });
  refresh();
}

// --- HEALTH HEARTBEAT ---
async function refreshHealth() {
  try {
    var h = await api('GET','/api/health');
    var el = document.getElementById('heartbeat');
    var txt = document.getElementById('hb-text');
    var chips = document.getElementById('scout-chips');

    // Status color
    var cls = 'hb-gray';
    if (h.status === 'HEALTHY') cls = 'hb-green';
    else if (h.status === 'DEGRADED' || h.status === 'STALE') cls = 'hb-yellow';
    else if (h.status === 'TOKEN_DOWN') cls = 'hb-red';
    el.className = 'hb ' + cls;

    // Token line
    var tokenStr = h.token && h.token.ok ? 'Token OK' : 'TOKEN DOWN';

    // Scout summary
    var names = h.scouts ? Object.keys(h.scouts) : [];
    var okCount = 0; var totalChecked = 0;
    for (var i = 0; i < names.length; i++) {
      var s = h.scouts[names[i]];
      if (s.ok && !s.stale) okCount++;
      totalChecked += (s.checked || 0);
    }

    // Find last scan time
    var lastScan = null;
    for (var j = 0; j < names.length; j++) {
      var lr = h.scouts[names[j]].lastRun;
      if (lr && (!lastScan || lr > lastScan)) lastScan = lr;
    }
    var lastStr = lastScan ? new Date(lastScan).toLocaleTimeString('en-US', { timeZone:'America/New_York', hour:'numeric', minute:'2-digit' }) + ' ET' : 'no scans';

    if (h.status === 'TOKEN_DOWN') {
      txt.textContent = 'TOKEN DOWN — scouts blind. Visit /ts-auth to fix.';
    } else if (h.status === 'HEALTHY') {
      txt.textContent = okCount + '/' + names.length + ' scouts OK · ' + totalChecked + ' tickers · ' + tokenStr + ' · ' + lastStr;
    } else if (h.status === 'DEGRADED') {
      txt.textContent = okCount + '/' + names.length + ' scouts OK · ' + tokenStr + ' · ' + lastStr;
    } else if (h.status === 'STALE') {
      txt.textContent = 'Stale — last scan ' + lastStr + ' · ' + tokenStr;
    } else {
      txt.textContent = 'Waiting for first scan…';
    }

    // Render scout chips
    if (names.length > 0) {
      chips.innerHTML = names.map(function(n) {
        var s = h.scouts[n];
        var c = s.ok && !s.stale ? 'ok' : s.stale ? 'stale' : 'err';
        var label = n.toUpperCase();
        if (s.ok && !s.stale) label += ' ' + (s.checked||0);
        else if (s.stale) label += ' stale';
        else label += ' ERR';
        return '<span class="scout-chip ' + c + '">' + label + '</span>';
      }).join('');
    }
  } catch(e) { /* health endpoint not available yet */ }
}

// --- WATCHLIST MANAGEMENT ---
var currentWatchlist = [];
var WL_KEYS = ['CASEY_WATCHLIST','STRAT_WATCHLIST'];

async function loadWatchlist() {
  try {
    var cfg = await api('GET','/api/config');
    // Show Casey watchlist as the canonical one (Strat mirrors it)
    var raw = cfg.CASEY_WATCHLIST || '';
    if (!raw) {
      // No override set — fetch default from a scout run to show what's active
      // For now show placeholder
      document.getElementById('wl-count').textContent = 'using defaults';
      document.getElementById('wl-tags').innerHTML = '<span class="q-sub">Tap + ADD to customize. Current: 37 tickers (defaults).</span>';
      return;
    }
    currentWatchlist = raw.split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean);
    renderWatchlist();
  } catch(e) { console.log('wl load error', e); }
}

function renderWatchlist() {
  document.getElementById('wl-count').textContent = currentWatchlist.length + ' tickers';
  var el = document.getElementById('wl-tags');
  el.innerHTML = currentWatchlist.map(function(t) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:#21262d;font-size:12px;font-weight:600">'
      + t + '<span onclick="removeTicker(\\'' + t + '\\')" style="cursor:pointer;color:#ff9999;font-size:14px;padding:0 2px">&times;</span></span>';
  }).join('');
}

async function addTicker() {
  var inp = document.getElementById('add-ticker');
  var t = inp.value.trim().toUpperCase();
  if (!t) return;
  inp.value = '';
  if (currentWatchlist.length === 0) {
    // First custom add — seed with defaults
    var cfg = await api('GET','/api/config');
    if (!cfg.CASEY_WATCHLIST) {
      // Load hardcoded defaults
      currentWatchlist = 'SPY,QQQ,NVDA,AAPL,MSFT,META,AMZN,TSLA,PLTR,AMD,MRVL,GOOGL,NFLX,AVGO,COIN,CRM,UBER,SHOP,NOW,HOOD,SOFI,MU,DKNG,RKLB,NET,PANW,CRWD,SNOW,WDAY,ARM,ANET,DELL,SMCI,MSTR,SMH,ARKK,XBI'.split(',');
    }
  }
  if (currentWatchlist.indexOf(t) >= 0) { alert(t + ' already on list'); return; }
  currentWatchlist.push(t);
  await saveWatchlist();
  renderWatchlist();
}

async function removeTicker(t) {
  currentWatchlist = currentWatchlist.filter(function(x){ return x !== t; });
  await saveWatchlist();
  renderWatchlist();
}

async function saveWatchlist() {
  var val = currentWatchlist.join(',');
  // Set for casey + strat (mirror). WP gets its own broader list.
  await api('POST','/api/config', { CASEY_WATCHLIST: val, STRAT_WATCHLIST: val });
}

loadWatchlist();

refresh();
refreshHealth();
setInterval(refresh, 10000);
setInterval(refreshHealth, 15000);
</script>
</body>
</html>`;

module.exports = {
  handler: function(req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(HTML);
  },
};
