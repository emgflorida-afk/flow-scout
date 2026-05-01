// =============================================================================
// SMART PANEL — auto-updating TradingView floating panel
//
// Detects ticker changes on the active TradingView chart, fetches live alert
// levels from /api/panel/:ticker, and re-renders the panel automatically.
// Survives TF switches, symbol switches, and continues running until tab close.
//
// Loaded by CDP injector via:
//   fetch('https://flow-scout-production.up.railway.app/panel.js')
//   then evaluated in the TradingView page context.
// =============================================================================

(function() {
  'use strict';

  var API_BASE = 'https://flow-scout-production.up.railway.app';
  var POLL_INTERVAL_MS = 2000;     // check ticker every 2s
  var REFRESH_INTERVAL_MS = 60000; // refresh data every 60s even if same ticker
  var PANEL_ID = 'claude-smart-panel';

  // Remove any existing panel + clear prior intervals
  var existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();
  if (window.__claudePanelInterval) {
    clearInterval(window.__claudePanelInterval);
  }

  var state = {
    lastTicker: null,
    lastFetched: 0,
    panelEl: null,
    isFetching: false,
  };

  // -------------------------------------------------------------------------
  // PANEL DOM (draggable, minimizable, position-persistent)
  // -------------------------------------------------------------------------
  function createPanel() {
    // Restore saved position + minimize state
    var savedPos = null;
    var savedMin = false;
    try {
      savedPos = JSON.parse(localStorage.getItem('claudePanelPos') || 'null');
      savedMin = localStorage.getItem('claudePanelMinimized') === '1';
    } catch(e) {}
    var top = (savedPos && savedPos.top) || 80;
    var left = (savedPos && savedPos.left) || 80;  // LEFT side, away from price scale

    var p = document.createElement('div');
    p.id = PANEL_ID;
    p.style.cssText = [
      'position:fixed',
      'top:' + top + 'px',
      'left:' + left + 'px',
      'z-index:99999',
      'background:rgba(15,18,28,0.96)',
      'border:1px solid #46b4ff',
      'border-radius:12px',
      'padding:0',
      'color:#fff',
      'font-family:"SF Mono",Monaco,monospace',
      'font-size:12px',
      'line-height:1.6',
      'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
      'max-width:340px',
      'min-width:280px',
      'backdrop-filter:blur(8px)',
      'user-select:none',
    ].join(';');

    var header = document.createElement('div');
    header.id = PANEL_ID + '-header';
    header.style.cssText = 'padding:10px 14px;cursor:move;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;border-radius:12px 12px 0 0;background:rgba(70,180,255,0.06);';
    header.innerHTML = '<span id="' + PANEL_ID + '-title" style="color:#46b4ff;font-weight:700;font-size:13px;">🎯 Loading…</span>'
      + '<div>'
      + '<button id="' + PANEL_ID + '-min" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 6px;">' + (savedMin ? '▢' : '_') + '</button>'
      + '<button id="' + PANEL_ID + '-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0 4px;">×</button>'
      + '</div>';

    var body = document.createElement('div');
    body.id = PANEL_ID + '-body';
    body.style.cssText = 'padding:10px 14px 14px 14px;' + (savedMin ? 'display:none;' : '');
    body.innerHTML = '<div style="text-align:center;color:#888;font-size:11px;padding:20px;">Loading…</div>';

    p.appendChild(header);
    p.appendChild(body);
    document.body.appendChild(p);
    state.panelEl = p;
    state.bodyEl = body;
    state.titleEl = document.getElementById(PANEL_ID + '-title');

    // Drag logic
    var drag = { active: false, offsetX: 0, offsetY: 0 };
    header.addEventListener('mousedown', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      drag.active = true;
      var rect = p.getBoundingClientRect();
      drag.offsetX = e.clientX - rect.left;
      drag.offsetY = e.clientY - rect.top;
      p.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!drag.active) return;
      var nl = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - drag.offsetX));
      var nt = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - drag.offsetY));
      p.style.left = nl + 'px';
      p.style.top = nt + 'px';
      p.style.right = 'auto';
    });
    document.addEventListener('mouseup', function() {
      if (drag.active) {
        drag.active = false;
        try {
          localStorage.setItem('claudePanelPos', JSON.stringify({
            top: parseInt(p.style.top),
            left: parseInt(p.style.left),
          }));
        } catch(e) {}
      }
    });

    // Minimize button
    document.getElementById(PANEL_ID + '-min').addEventListener('click', function() {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? 'block' : 'none';
      this.textContent = hidden ? '_' : '▢';
      try { localStorage.setItem('claudePanelMinimized', hidden ? '0' : '1'); } catch(e) {}
    });

    // Close button — also stops the polling interval
    document.getElementById(PANEL_ID + '-close').addEventListener('click', function() {
      p.remove();
      if (window.__claudePanelInterval) clearInterval(window.__claudePanelInterval);
    });

    return p;
  }

  // -------------------------------------------------------------------------
  // TICKER DETECTION
  // -------------------------------------------------------------------------
  function getCurrentTicker() {
    try {
      if (typeof TradingViewApi !== 'undefined' && TradingViewApi.activeChart) {
        var symbol = TradingViewApi.activeChart().symbol();
        if (!symbol) return null;
        // "NYSE:RBLX" → "RBLX" ; "BINANCE:BTCUSDT" → "BTCUSDT"
        var ticker = String(symbol).split(':').pop().split('.')[0].trim();
        return ticker || null;
      }
    } catch(e) {}
    return null;
  }

  // -------------------------------------------------------------------------
  // FETCH + RENDER
  // -------------------------------------------------------------------------
  function colorFor(c) {
    return c === 'green' ? '#16e39d'
         : c === 'red'    ? '#ff6b6b'
         : c === 'yellow' ? '#fbbf24'
         : c === 'aqua'   ? '#46b4ff'
         : '#888';
  }

  function ratingPill(rating) {
    if (rating === 'SAFE')    return '<span style="background:rgba(22,227,157,0.18);color:#16e39d;padding:2px 6px;border-radius:4px;font-size:10px;">🟢 SAFE</span>';
    if (rating === 'CAUTION') return '<span style="background:rgba(251,191,36,0.18);color:#fbbf24;padding:2px 6px;border-radius:4px;font-size:10px;">🟡 CAUTION</span>';
    if (rating === 'AVOID')   return '<span style="background:rgba(255,107,107,0.18);color:#ff6b6b;padding:2px 6px;border-radius:4px;font-size:10px;">🔴 AVOID</span>';
    return '';
  }

  function renderPanel(data) {
    if (!state.bodyEl || !state.titleEl) return;
    if (data.error) {
      state.titleEl.textContent = '🎯 ' + (data.ticker || '?');
      state.bodyEl.innerHTML = '<div style="color:#ff6b6b;font-size:11px;padding:8px;">Error: ' + (data.error || 'unknown') + '</div>';
      return;
    }

    var ticker = data.ticker || '?';
    var spot = data.spot || '?';
    var holdRating = (data.hold && data.hold.rating) || '?';
    var alerts = data.alerts || [];

    // Update title bar (above the body)
    state.titleEl.textContent = '🎯 ' + ticker;

    // Split alerts above/below spot
    var above = alerts.filter(function(a) { return a.price > spot; }).sort(function(a, b) { return a.price - b.price; });
    var below = alerts.filter(function(a) { return a.price < spot; }).sort(function(a, b) { return b.price - a.price; });
    var atSpot = alerts.filter(function(a) { return Math.abs(a.price - spot) / spot < 0.005; });

    var html = [];
    html.push('<div style="display:flex;justify-content:space-between;font-size:11px;color:#aaa;margin-bottom:10px;">');
    html.push('<span>Spot: <strong style="color:#fff;">$' + spot + '</strong></span>');
    html.push('<span>' + ratingPill(holdRating) + '</span>');
    html.push('</div>');

    // ABOVE spot (bullish targets)
    if (above.length) {
      html.push('<div style="border-top:1px solid #333;padding-top:8px;margin-bottom:6px;">');
      html.push('<div style="color:#16e39d;font-weight:700;font-size:11px;margin-bottom:4px;">⬆️ ABOVE</div>');
      above.slice(0, 6).forEach(function(a) {
        html.push('<div style="font-size:11px;display:flex;justify-content:space-between;">');
        html.push('<span style="color:' + colorFor(a.color) + ';">$' + a.price.toFixed(2) + '</span>');
        html.push('<span style="color:#888;font-size:10px;">' + a.label + '</span>');
        html.push('</div>');
      });
      html.push('</div>');
    }

    // AT SPOT
    if (atSpot.length) {
      html.push('<div style="background:rgba(70,180,255,0.10);border-left:3px solid #46b4ff;padding:4px 8px;margin:4px 0;font-size:11px;">');
      atSpot.forEach(function(a) {
        html.push('<div style="display:flex;justify-content:space-between;">');
        html.push('<span style="color:' + colorFor(a.color) + ';font-weight:700;">$' + a.price.toFixed(2) + '</span>');
        html.push('<span style="color:#aaa;font-size:10px;">' + a.label + ' ⚡</span>');
        html.push('</div>');
      });
      html.push('</div>');
    }

    // BELOW spot (bearish/support)
    if (below.length) {
      html.push('<div style="border-top:1px solid #333;padding-top:8px;margin-top:6px;">');
      html.push('<div style="color:#ff6b6b;font-weight:700;font-size:11px;margin-bottom:4px;">⬇️ BELOW</div>');
      below.slice(0, 5).forEach(function(a) {
        html.push('<div style="font-size:11px;display:flex;justify-content:space-between;">');
        html.push('<span style="color:' + colorFor(a.color) + ';">$' + a.price.toFixed(2) + '</span>');
        html.push('<span style="color:#888;font-size:10px;">' + a.label + '</span>');
        html.push('</div>');
      });
      html.push('</div>');
    }

    // Footer
    var fetchedTime = new Date(data.fetchedAt || Date.now()).toLocaleTimeString();
    html.push('<div style="border-top:1px solid #333;padding-top:6px;margin-top:8px;font-size:9px;color:#666;display:flex;justify-content:space-between;">');
    html.push('<span>auto-refresh 60s · drag to move</span>');
    html.push('<span>' + fetchedTime + '</span>');
    html.push('</div>');

    state.bodyEl.innerHTML = html.join('');
  }

  function showLoading(ticker) {
    if (!state.bodyEl || !state.titleEl) return;
    state.titleEl.textContent = '🎯 ' + (ticker || '?');
    state.bodyEl.innerHTML = '<div style="text-align:center;color:#aaa;font-size:11px;padding:20px;">⌛ Fetching levels…</div>';
  }

  // -------------------------------------------------------------------------
  // POLL LOOP
  // -------------------------------------------------------------------------
  async function poll() {
    if (state.isFetching) return;
    var ticker = getCurrentTicker();
    if (!ticker) return;

    var now = Date.now();
    var tickerChanged = ticker !== state.lastTicker;
    var stale = (now - state.lastFetched) > REFRESH_INTERVAL_MS;

    if (!tickerChanged && !stale) return;

    state.isFetching = true;
    if (tickerChanged) {
      state.lastTicker = ticker;
      showLoading(ticker);
    }

    try {
      var resp = await fetch(API_BASE + '/api/panel/' + encodeURIComponent(ticker), { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      renderPanel(data);
      state.lastFetched = Date.now();
    } catch(e) {
      if (state.panelEl) {
        state.panelEl.innerHTML = '<div style="color:#ff6b6b;font-size:11px;text-align:center;padding:20px;">Fetch failed: ' + e.message + '</div>';
      }
    } finally {
      state.isFetching = false;
    }
  }

  // -------------------------------------------------------------------------
  // INIT
  // -------------------------------------------------------------------------
  createPanel();
  poll();
  window.__claudePanelInterval = setInterval(poll, POLL_INTERVAL_MS);

  // Expose manual refresh for debugging
  window.__claudePanelRefresh = function() {
    state.lastFetched = 0;
    poll();
  };

  console.log('[SmartPanel] Loaded · API:', API_BASE, '· polling every ' + POLL_INTERVAL_MS + 'ms');
})();
