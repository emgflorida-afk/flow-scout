# TV Alert Templates — Webhook Setup

For each TV alert you want piped into the Flow Scout pipeline:

1. Right-click alert → **Edit**
2. Scroll to **Notifications** tab
3. Check **Webhook URL**
4. Paste: `https://flow-scout-production.up.railway.app/api/tv-alert/incoming`
5. In **Message** field, paste the appropriate JSON template below
6. Save

**TV alerts with webhook require Pro+ subscription.**

---

## TIER 1 — Primary Signal (Daily/60m + multi-confirmation)

Use for: daily close above key level, CRSI extreme cross, multi-bar structural patterns.

```json
{
  "ticker": "{{ticker}}",
  "direction": "long",
  "tier": 1,
  "tf": "1D",
  "alertName": "Daily close above Friday H",
  "price": {{close}},
  "trigger": 253.56,
  "stacked": true,
  "confirmations": 3
}
```

**Examples for your existing alerts**:
- IWM CRSI overbought cross DOWN → `direction: "short", tier: 1, alertName: "CRSI overbought signal"`
- IWM CRSI oversold cross UP → `direction: "long", tier: 1, alertName: "CRSI V-bottom signal"`
- ADBE Daily close > $253.56 → `direction: "long", tier: 1, alertName: "Daily close > Fri H"`

---

## TIER 2 — Confirmation (60m/15m + single technical)

Use for: 60m close above level, EMA crosses, Stoch RSI 60m crosses.

```json
{
  "ticker": "{{ticker}}",
  "direction": "long",
  "tier": 2,
  "tf": "60",
  "alertName": "60m close > yesterday HOD",
  "price": {{close}},
  "trigger": 255.88
}
```

**Examples**:
- 60m close above $255.88 → tier 2 long
- Stoch RSI K cross 80 down (60m) → `direction: "short", tier: 2`
- 9 EMA reclaim → tier 2 with direction matching

---

## TIER 3 — Entry Timing (5m/15m, noisy, must stack)

Use for: 5m vol pane breakouts, 5m price level crosses, fast cross signals.

```json
{
  "ticker": "{{ticker}}",
  "direction": "long",
  "tier": 3,
  "tf": "5",
  "alertName": "5m BULL BREAKOUT vol confirmed",
  "price": {{close}}
}
```

**Examples for your Vol Pane alerts**:
- "Bull break: green + vol 1.5x" (5m) → tier 3 long
- "Bear break: red + vol 1.5x" (5m) → tier 3 short

---

## How the system filters noise

- **Tier 1 alert fires** → Discord push HIGH priority always
- **Tier 2 alert fires** → Discord push ONLY if Tier 1 fired same ticker+direction today
- **Tier 3 alert fires** → SILENT unless Tier 1 + Tier 2 already fired today

So your Vol Pane 5m alerts (Tier 3) won't spam your Discord on chop. They only act when the higher-tier setup is confirmed.

---

## Test the webhook

After pasting templates and saving alerts:

```bash
curl -X POST https://flow-scout-production.up.railway.app/api/tv-alert/test
```

Should push a sample Tier 1 ADBE long alert to your Discord. Verify it lands.

Or test specific:
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"ticker":"NVDA","direction":"long","tier":1,"tf":"1D","alertName":"test","price":200}' \
  https://flow-scout-production.up.railway.app/api/tv-alert/test
```

---

## Bullflow UOA Detector

Separate pipeline. Bullflow stream auto-feeds into `uoaDetector.js`:

- Premium > $1M: scores +3
- Sweep size > 1000ct: +2
- Whale block ($10M+): +5
- Velocity > 5 alerts/min: +2

Score >= 7 = UOA push to Discord  
Score >= 10 = WHALE — auto-fire SIM if TV Tier 1+2 already stacked

You don't configure anything. The Bullflow stream already feeds Railway, the scorer runs automatically.

Check recent UOA: `GET /api/uoa/recent` or `/api/uoa/recent?maxAgeHours=4`
