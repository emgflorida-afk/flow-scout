# Morning Planner Spec — automate the 45-minute pre-market routine

**Goal:** Claude wakes up at 6:00 AM ET, runs the entire morning routine automatically, outputs pre-marked charts + ranked setups + Titan-ready cards + Discord brief by 8:30 AM. AB opens laptop at 9:00, sees everything pre-planned.

**Built from:** AB's 4/24 request — *"im building this for you to do it"*. End state: AB doesn't plan mornings. Claude does.

---

## THE INPUTS (what Claude checks every morning)

1. **Overnight positions** — TS MCP get-positions-details
2. **Sector ETFs + VIX** — tape quality score (see TAPE_QUALITY_FRAMEWORK.md)
3. **John's VIP posts** — last 12 hrs via jsmithPoller
4. **Scanner 4h** — matched setups with conviction ≥ normal
5. **Academy pre-market brief** — via Chrome MCP or saved PDF
6. **Bullflow GEX** — pins, regimes, walls for shortlist
7. **Option chains** — 5/8 and 5/15 expiries for strike selection
8. **Earnings calendar** — avoid binary catalysts within 2 days

---

## THE OUTPUTS (what AB wakes up to)

### 1. Marked Charts (up to 3 setups)
- Each chart has: trigger, stop, TP1/TP2/TP3 drawn
- AB Entry Marker configured with those levels
- Saved screenshot to Box

### 2. Titan Cards (pre-built orders, SAVED not queued)
- Each shortlist ticker has a JSON card with:
  - Contract (ticker + expiry + strike)
  - Entry order (LMT or STP LMT with prices)
  - OSO bracket (stop + TP)
  - Comments explaining logic

### 3. Discord Morning Brief
Push to AI Curator channel at 8:30 AM:
```
📋 FRI 4/24 MORNING BRIEF
Tape Score: 3/5 (mixed, catalyst-driven)
Regime: Tech reversal (AMD +8% catalyst)

🎯 TOP SETUPS:
1. MSFT 5/8 $425C — LMT $5.20 — Trigger $421.24 — Stop $414
   Why: $8M bull flow confirming, pin $445 upside, no earnings
   Chart: [link to marked screenshot]
   Size: 2 ct | R:R 3.2:1 to TP2

2. VZ 5/15 $47C — LMT $0.80 — Trigger $47.50 — Stop $46.70
   Why: F2U reversal continuation, multi-day trend alive
   Chart: [link]
   Size: 2 ct | R:R 2.8:1 to TP2

3. SMH — WATCH, gap too big, wait for retest
   Why: +3% pre-mkt gap, need pullback first

⚠️ SKIP:
- MRVL — chase (up 95% in 6 weeks)
- V — hammer broken, setup dead
- JNJ — already TP'd yesterday, now in profit-taking phase
```

### 4. Flow-scout frontend dashboard
Scanner page renders the 3 shortlisted tickers at top with ⭐ flag.

---

## IMPLEMENTATION

### File: `src/morningPlanner.js` (NEW)

```js
const ts = require('./tradestation');
const scanner = require('./stratumScanner');
const jsmith = require('./stratumExternalPoller');
const gex = require('./gex'); // existing
const pushNotifier = require('./pushNotifier');

const MIN_CONVICTION_GATES = 4; // must pass 4/5 to shortlist
const MAX_SHORTLIST = 3;

async function runMorningRoutine() {
  var report = {
    ts: new Date().toISOString(),
    tapeScore: null,
    sectorRotation: null,
    johnPicks: [],
    scannerMatches: [],
    shortlist: [],
    cards: [],
  };

  // Step 1: Tape + sectors
  report.tapeScore = await computeTapeScore();
  report.sectorRotation = await getSectorRotation();
  
  // Step 2: John VIP last 12 hrs
  report.johnPicks = await extractJohnPicks();
  
  // Step 3: Scanner 4h
  var scanResults = await scanner.runScan({ tf: '4h' });
  report.scannerMatches = scanResults.matches;
  
  // Step 4: Score + shortlist
  var allCandidates = mergeCandidates(report.johnPicks, report.scannerMatches);
  var scored = scoreAllCandidates(allCandidates, report);
  report.shortlist = scored.slice(0, MAX_SHORTLIST);
  
  // Step 5: For each shortlisted, build full plan
  for (var ticker of report.shortlist) {
    var plan = await buildTickerPlan(ticker, report);
    report.cards.push(plan);
  }
  
  // Step 6: Push Discord brief
  await pushMorningBrief(report);
  
  // Step 7: Save to state for UI
  saveReport(report);
  
  return report;
}

async function buildTickerPlan(ticker, context) {
  var bars = await ts.getBars(ticker, 'Daily', 30);
  var gexData = await gex.getGex(ticker);
  var chain = await ts.getOptionChain(ticker, nextWeeklyExpiry());
  
  // Determine levels
  var trigger = computeTrigger(bars);
  var stop = computeStop(bars);
  var tp1 = computeTP1(gexData, bars);
  var tp2 = computeTP2(gexData, bars);
  var tp3 = gexData.pin;
  
  // Strike selection
  var strike = pickStrike(chain, trigger, gexData);
  var option = chain.find(c => c.strike === strike);
  
  // Build Titan card
  return {
    ticker: ticker,
    expiry: option.expiry,
    strike: strike,
    optionSymbol: option.symbol,
    entry: { type: 'LMT', price: option.mid },
    stop: { trigger: stop, limit: stop - 0.10 },
    tp1: tp1, tp2: tp2, tp3: tp3,
    levels: { trigger, stop, tp1, tp2, tp3 },
    convictionScore: context.scoresByTicker[ticker],
    recommendedSize: sizeBy(context.scoresByTicker[ticker]),
    reasoning: generateReasoning(ticker, context),
  };
}
```

### File: `src/server.js` — add cron + endpoints

```js
// Cron: run morning planner at 6:00 AM ET Mon-Fri
cron.schedule('0 6 * * 1-5', async function() {
  if (morningPlanner) {
    try {
      var report = await morningPlanner.runMorningRoutine();
      console.log('[MORNING] Planner complete:', report.shortlist.length, 'shortlisted');
    } catch(e) { console.error('[MORNING] error:', e.message); }
  }
}, { timezone: 'America/New_York' });

// Manual trigger
app.post('/api/morning/run', async function(req, res) {
  if (!morningPlanner) return res.status(500).json({ error: 'planner not loaded' });
  try { res.json(await morningPlanner.runMorningRoutine()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Get latest report
app.get('/api/morning/latest', function(req, res) {
  if (!morningPlanner) return res.json({ error: 'not loaded' });
  res.json(morningPlanner.getLatestReport());
});
```

### Chart marking step (runs after shortlist)

Instead of calling TV MCP directly (server doesn't have access), **the planner writes a "markup queue" that the local Claude session reads:**

```js
function writeMarkupQueue(shortlist) {
  var queue = shortlist.map(ticker => ({
    ticker,
    levels: ticker.levels,
    direction: ticker.trigger > ticker.price ? 'LONG' : 'SHORT',
    timestamp: new Date().toISOString(),
  }));
  fs.writeFileSync('/data/morning_markup_queue.json', JSON.stringify(queue, null, 2));
}
```

When AB opens Claude Code in the morning:
```
AB: "run morning markup"
Claude: reads /data/morning_markup_queue.json
Claude: for each, runs CHART_MARKUP_PLAYBOOK
Claude: saves screenshots to Box
Claude: confirms "3 charts marked, screenshots in Box"
```

---

## STRIKE SELECTION LOGIC

```js
function pickStrike(chain, triggerPrice, gex) {
  // Filter to expiries 7-21 days out
  // Pick strike closest to:
  //   LONG: 0.50 delta (ATM) unless trigger is far above spot, then use 0.45 OTM
  //   SHORT: 0.45 put delta
  // Prefer strike that aligns with nearest gamma wall for TP alignment
  
  var atmTarget = Math.round(triggerPrice / 5) * 5; // round to nearest $5
  
  // Check if nearest gamma wall is within 2 strikes of ATM
  if (gex.wallAbove && Math.abs(gex.wallAbove.strike - atmTarget) <= 10) {
    // Position between current spot and wall
    return Math.round((atmTarget + gex.wallAbove.strike) / 2 / 5) * 5;
  }
  
  return atmTarget;
}
```

---

## ACCEPTANCE CRITERIA

- [ ] Cron fires 6 AM Mon-Fri
- [ ] Report completes in < 5 min
- [ ] Report saved to /data/morning_report_YYYYMMDD.json
- [ ] Discord message posted by 8:30 AM
- [ ] At least 1 shortlisted setup on typical day
- [ ] 0 false "high conviction" on obvious bad setups
- [ ] Strike selection matches John's picks ≥ 80% of the time
- [ ] Cards survive Railway restart (saved to /data)

---

## ROLLOUT PLAN

### Week 1: MVP
- Build report generation (no chart markup yet)
- Test against last 5 days of data
- Validate strike selection vs John's fills

### Week 2: Full integration
- Add chart markup queue
- Add Titan card building
- Wire into scanner UI (highlight shortlisted)

### Week 3: Tune
- Monitor Discord briefs against real tape
- Adjust scoring weights
- Backtest shortlist win rate

---

## COST ESTIMATE

- Each morning run: ~1500 input + 1000 output tokens × 3-5 LLM calls = ~$0.05
- Daily: $0.05
- Monthly: ~$1-2
- Bullflow + TradeStation: already paid

**Total: < $5/mo for full automation.** Pays for itself on first saved morning.

---

## AB's DAILY FLOW AFTER DEPLOY

```
6:00 AM → cron fires, planner runs
8:30 AM → Discord "📋 MORNING BRIEF" posts with 3 tickers + reasoning
9:00 AM → AB opens Claude Code on laptop
         AB says: "run morning markup"
         Claude marks 3 charts, saves screenshots
9:15 AM → AB opens TV, tabs through marked charts
         Reviews each plan
         Adjusts any levels if needed
         Decides: trade all 3? skip 1? scale size?
9:30 AM → Market opens. AB watches 5m bars.
9:45 AM → AB Entry Marker alert fires on 1-2 tickers
         AB sends pre-built Titan order
         Chart executes with auto-bracket
10:00 AM → Done. Hands off. Brackets work.

Morning time investment: 15 min (down from 45+)
```

*Spec created 2026-04-24. Priority: after scanner upgrade. Target ship: next week.*
