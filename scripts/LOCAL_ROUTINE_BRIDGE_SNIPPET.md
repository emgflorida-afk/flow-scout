# Local Claude Code Routine → Railway Bridge

After your local WP / JS / COIL scan routine writes its `.md` file to memory,
add this final step so the setups flow into Railway's ICS auto-trader.

## ✅ One-time setup

Paste this block at the **end of your local scanner routine prompt** (the one
that produces `wp_scan_YYYY-MM-DD.md` etc):

```
After writing the .md file and updating MEMORY.md, ALSO push the setups to
Railway so the ICS auto-trader uses them as source of truth.

POST to: https://flow-scout-production.up.railway.app/api/external-setups/import

Headers:
  Content-Type: application/json
  X-Source-Token: <leave blank if EXTERNAL_SETUPS_TOKEN env not set>

Body shape:
{
  "source": "local-wp-routine",          // or "local-js-routine", "local-coil-routine"
  "scanType": "WP",                      // WP / JS / COIL / AYCE
  "generatedAt": "<ISO 8601 timestamp>",
  "setups": [
    {
      "ticker": "ABBV",
      "direction": "long",                // long | short
      "pattern": "Failed-2D",
      "tf": "Daily",                      // Daily | 4HR | 6HR | Weekly | etc
      "trigger": 208.34,
      "stop": 204.87,
      "tp1": 210.08,
      "tp2": 211.81,
      "tp3": 215.28,
      "conviction": 14,                   // your scoring (any scale)
      "holdRating": "SAFE",               // SAFE | CAUTION | AVOID — gates auto-fire
      "earningsRisk": null,               // null = no earnings risk; truthy blocks fire
      "spot": 208.16,
      "preferredContractSymbol": "ABBV 260619C210",   // OPTIONAL — exact OPRA symbol
      "preferredStrike": 210,                          // OPTIONAL
      "preferredExpiry": "2026-06-19",                 // OPTIONAL
      "preferredSize": 2,                              // OPTIONAL — 1-5ct override
      "flowNotes": "Bullflow shows 4.2k call vol on 210C, OI 12k"  // OPTIONAL
    },
    // ... 4 more setups
  ]
}

Verify the push worked:
  curl https://flow-scout-production.up.railway.app/api/external-setups/list
```

## 🔥 What happens next

After your routine pushes:

1. **Railway stores it** in `/data/external_setups.json` keyed by `source:scanType`
2. **simAutoTrader.collectQualifyingSetups()** reads it on every 5-min cron run
3. **8:30 AM Morning Brief** Discord card lists your setups with TF + Titan tickets
4. **Auto-fire** when a setup hits trigger price (Hold-SAFE only, conv ≥ 8 by default)
5. **Preferred contract** — if you specified `preferredContractSymbol`, the
   auto-trader uses THAT contract verbatim instead of running its own resolver.
   Lets you override based on Bullflow / volume / flow research.

## 📋 Field reference

| Field | Required? | Notes |
|--|--|--|
| ticker | ✅ | Uppercase |
| direction | ✅ | `long` or `short` only |
| trigger | ✅ | Stock price level for entry |
| stop | recommended | Stock-level invalidation |
| tp1, tp2, tp3 | optional | Stock-level targets |
| conviction | ✅ | Any number; ≥ 8 required to auto-fire |
| holdRating | ✅ for auto-fire | Must be `'SAFE'` or auto-fire skips |
| earningsRisk | recommended | Truthy value blocks auto-fire |
| pattern | informational | Surfaces in Discord card |
| tf | informational | Surfaces in Discord card |
| **preferredContractSymbol** | optional | OPRA format `'ABBV 260619C210'` — if provided, used VERBATIM (skips resolver) |
| preferredSize | optional | Override default 2-3ct sizing |
| flowNotes | optional | Bullflow research note for the journal |

## 🧪 Test push from terminal

```bash
curl -X POST https://flow-scout-production.up.railway.app/api/external-setups/import \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "test",
    "scanType": "WP",
    "generatedAt": "2026-05-04T22:00:00Z",
    "setups": [
      {
        "ticker": "ABBV",
        "direction": "long",
        "pattern": "Failed-2D",
        "tf": "Daily",
        "trigger": 208.34,
        "stop": 204.87,
        "tp1": 210.08,
        "tp2": 211.81,
        "conviction": 14,
        "holdRating": "SAFE"
      }
    ]
  }'
```

Then verify:
```bash
curl https://flow-scout-production.up.railway.app/api/external-setups/list
curl https://flow-scout-production.up.railway.app/api/external-setups/active
```
