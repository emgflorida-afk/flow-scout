# Scanner Upgrade Spec — surface Bullflow GEX + In-Force

**Goal:** Match the TRADER AI scanner's density (Image 1) + add our edges (flow, gamma, John). End state: AB opens scanner, sees for each row at a glance: trigger level, stop level, TP1/TP2, gamma pin, regime, flow dominance, in-force status.

**Built on:** AB's 4/24 observation — *"we stoll have seen the bullfow on our scanner come in so we use the app same as the gex"*. Scanner should SURFACE what we already pull.

---

## PHASE 1: Backend — merge GEX data into scanner rows (~1 hr)

### File: `src/stratumScanner.js`

Add a batch GEX enrichment step after `runScan()` generates matches:

```js
async function enrichWithGex(rows) {
  if (!rows.length) return rows;
  var tickers = rows.map(r => r.ticker).join(',');
  var url = 'http://localhost:' + (process.env.PORT || 3000) + '/api/gex/batch?tickers=' + tickers;
  try {
    var r = await fetch(url, { timeout: 10000 });
    if (!r.ok) return rows;
    var data = await r.json();
    var gexByTicker = data.results || {};
    rows.forEach(row => {
      var g = gexByTicker[row.ticker];
      if (g) {
        row.gex = {
          pin: g.pin,
          regime: g.regime,           // POSITIVE | NEGATIVE
          gammaFlip: g.gammaFlip,
          expectedHigh: g.expectedHigh,
          expectedLow: g.expectedLow,
          totalNetGex: g.totalNetGex,
          wallAbove: (g.walls || []).find(w => w.strike > row.price && w.type === 'CALL_WALL'),
          wallBelow: (g.walls || []).find(w => w.strike < row.price && w.type === 'PUT_WALL'),
        };
      }
    });
    return rows;
  } catch (e) { console.error('[SCANNER] GEX enrich failed:', e.message); return rows; }
}

// In main runScan, after matched rows built:
await enrichWithGex(matchedRows);
```

### New row fields available after enrichment:
```
r.gex.pin              number (e.g., 315)
r.gex.regime           "POSITIVE" | "NEGATIVE"
r.gex.gammaFlip        number (e.g., 325)
r.gex.expectedHigh     number
r.gex.expectedLow      number
r.gex.wallAbove.strike / .gex (nearest call wall above price)
r.gex.wallBelow.strike / .gex (nearest put wall below price)
```

---

## PHASE 2: In-Force Logic — is setup still valid? (~45 min)

### Add to scanner row generation:
```js
function computeInForce(row) {
  // In Force = setup is still VALID given current price action
  // Returns: "ACTIVE" | "TRIGGERED" | "INVALIDATED" | "EXPIRED"
  
  if (!row.trigger) return null;
  
  var price = row.price;
  var dir = row.signal && row.signal.toLowerCase().indexOf('up') >= 0 ? 'long' : 'short';
  
  if (dir === 'long') {
    if (price < row.trigger * 0.97) return 'INVALIDATED'; // 3%+ below trigger
    if (price >= row.trigger) return 'TRIGGERED';
    return 'ACTIVE'; // below trigger but within 3%
  } else {
    if (price > row.trigger * 1.03) return 'INVALIDATED';
    if (price <= row.trigger) return 'TRIGGERED';
    return 'ACTIVE';
  }
}

row.inForce = computeInForce(row);
```

---

## PHASE 3: Frontend — new scanner columns (~1.5 hrs)

### File: `src/scanner.html`

Add to table header (around line 825):
```html
<th class="col-gex-pin" title="Gamma Pin — magnetic price target">Pin</th>
<th class="col-gex-regime" title="Gamma regime: +(dampens) vs −(amplifies)">Reg</th>
<th class="col-inforce" title="Setup status">Status</th>
<th class="col-trigger" title="Entry trigger price">Trigger</th>
<th class="col-exp-range" title="Expected range today (1 std dev)">Exp</th>
```

Add to `rowHtml(r)` (around line 605):
```js
'<td class="col-gex-pin">' + gexPinHtml(r.gex) + '</td>' +
'<td class="col-gex-regime">' + gexRegimeHtml(r.gex) + '</td>' +
'<td class="col-inforce">' + inForceBadge(r.inForce) + '</td>' +
'<td class="col-trigger">' + triggerHtml(r) + '</td>' +
'<td class="col-exp-range">' + expRangeHtml(r.gex) + '</td>' +
```

### Helper functions:
```js
function gexPinHtml(gex) {
  if (!gex || !gex.pin) return '<span class="muted">—</span>';
  return '<span class="gex-pin">$' + gex.pin.toFixed(0) + '</span>';
}

function gexRegimeHtml(gex) {
  if (!gex) return '';
  var isPos = gex.regime === 'POSITIVE';
  return '<span class="regime-badge ' + (isPos ? 'regime-pos' : 'regime-neg') + '" title="' + 
    (isPos ? 'Positive gamma: moves dampened, mean-reverting' : 'Negative gamma: moves amplified') + '">' +
    (isPos ? '+γ' : '−γ') + '</span>';
}

function inForceBadge(status) {
  if (!status) return '';
  var cls = 'if-' + status.toLowerCase();
  var icon = status === 'ACTIVE' ? '🟢' : status === 'TRIGGERED' ? '🔥' : status === 'INVALIDATED' ? '🔴' : '⚫';
  return '<span class="inforce-badge ' + cls + '">' + icon + ' ' + status + '</span>';
}

function triggerHtml(r) {
  if (!r.trigger) return '<span class="muted">—</span>';
  var pct = r.price && r.trigger ? ((r.trigger - r.price) / r.price * 100).toFixed(1) : null;
  var toLabel = pct != null ? (pct > 0 ? ' (+' + pct + '%)' : ' (' + pct + '%)') : '';
  return '<span class="trigger-cell">$' + r.trigger.toFixed(2) + '<small>' + toLabel + '</small></span>';
}

function expRangeHtml(gex) {
  if (!gex || !gex.expectedLow || !gex.expectedHigh) return '';
  return '<span class="exp-range">$' + gex.expectedLow.toFixed(0) + '-$' + gex.expectedHigh.toFixed(0) + '</span>';
}
```

### CSS additions:
```css
.col-gex-pin { width: 60px; }
.col-gex-regime { width: 40px; }
.col-inforce { width: 90px; }
.col-trigger { width: 80px; }
.col-exp-range { width: 100px; }

.regime-badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.regime-pos { background: rgba(74,222,128,0.15); color: var(--green); }
.regime-neg { background: rgba(248,113,113,0.15); color: var(--red); }

.inforce-badge { font-size: 10px; font-weight: 600; }
.if-active { color: var(--green); }
.if-triggered { color: var(--yellow); }
.if-invalidated { color: var(--red); }
.if-expired { color: var(--muted); }

.gex-pin { color: var(--blue); font-weight: 600; }
.trigger-cell small { display: block; color: var(--muted); font-size: 9px; }
.exp-range { color: var(--muted); font-size: 11px; font-family: var(--mono); }
```

---

## PHASE 4: Filter controls (~30 min)

Add pre-filter buttons above table:
```html
<label><input type="checkbox" id="filter-gex-pos">+γ only</label>
<label><input type="checkbox" id="filter-inforce-active">In Force only</label>
<label><input type="checkbox" id="filter-flow-bull">Bull flow only</label>
```

Wire to row filter logic to hide non-matching rows.

---

## ACCEPTANCE CRITERIA

After build complete:
- [ ] Each scanner row shows Pin + Regime badge + In-Force status + Trigger price
- [ ] Expected range (stat boundaries) visible
- [ ] Filter by regime, in-force, flow works
- [ ] Page renders in < 2 sec with 60+ rows
- [ ] Row click still opens chart + copies levels to clipboard
- [ ] Scanner still auto-refreshes on cron

---

## ROLLOUT

1. Test locally first (`npm run dev`)
2. Test with live scanner data (top 20 tickers)
3. Push to Railway
4. Compare against TRADER AI screenshot — match density
5. AB uses for Monday morning routine

---

## WHAT THIS UNLOCKS

**AB pulls up scanner at 8:30 AM.** For each top row:
- Sees: "MSFT | Chg -0.5% | Pin $445 | +γ | ACTIVE | Trigger $421 (+0.6%) | Exp $412-$430 | Bull flow $8M"
- Decides in 10 seconds: "MSFT trigger $0.60 away, positive gamma pulls UP toward $445, bull flow confirms. Mark this chart."
- Says: "mark MSFT"
- Claude runs playbook, chart marked, Pine indicator configured, alert set
- AB watches open, entry candle fires, enters

**Entire morning routine reduced from 45 min to 10 min per ticker.**

*Spec created 2026-04-24. Build priority: Phase 1-3 this weekend, Phase 4 next week.*
