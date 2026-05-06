#!/usr/bin/env bash
# =============================================================================
# Phase 4.34 — Pre-seed Smart Conditionals
# -----------------------------------------------------------------------------
# Arms TMO PUT + META CALL smart conditionals on production. John posted both
# tonight (May 5 PM). Server-side watcher polls every 30s and runs gates
# before placing the order — wick-resistant, gate-protected auto-fire.
#
# Run AFTER the Phase 4.34 deploy lands on Railway:
#   bash scripts/seed-smart-conditionals.sh
# =============================================================================
set -euo pipefail

BASE="${BASE:-https://flow-scout-production.up.railway.app}"

# Default expiry: end-of-day Friday May 8 2026 (gives John's TMO entry 3 trading days)
TMO_EXPIRY="${TMO_EXPIRY:-2026-05-08T20:00:00Z}"
# META 1 DTE warning — expires Wed May 6 to keep theta exposure tight
META_EXPIRY="${META_EXPIRY:-2026-05-06T20:00:00Z}"

echo ">>> Health check"
curl -sS "$BASE/api/smart-conditional/health" | python3 -m json.tool

echo
echo ">>> Arming TMO PUT (entry trigger \$466.16 crossing down)"
curl -sS -X POST "$BASE/api/smart-conditional/add" \
  -H 'Content-Type: application/json' \
  -d "{
    \"ticker\": \"TMO\",
    \"direction\": \"short\",
    \"contractSymbol\": \"TMO 260515P450\",
    \"triggerPrice\": 466.16,
    \"triggerDirection\": \"crossing_down\",
    \"stopPrice\": 468.94,
    \"account\": \"ts-live\",
    \"qty\": 1,
    \"limitPrice\": 2.50,
    \"gates\": [\"TA\", \"TAPE\", \"VISION\"],
    \"allowOverride\": false,
    \"bracket\": { \"stopPct\": 50, \"tp1Pct\": 25 },
    \"timeWindow\": { \"start\": \"09:45\", \"end\": \"15:00\" },
    \"expiresAt\": \"$TMO_EXPIRY\",
    \"pattern\": \"john-vip-entry\",
    \"source\": \"john-vip\",
    \"notes\": \"John posted TMO PUT entry \$466.16 on May 5 PM. Stop \$468.94. Smart conditional armed Phase 4.34 — gates run before fire.\"
  }" | python3 -m json.tool

echo
echo ">>> Arming META CALL (entry trigger \$606.80 crossing up)"
curl -sS -X POST "$BASE/api/smart-conditional/add" \
  -H 'Content-Type: application/json' \
  -d "{
    \"ticker\": \"META\",
    \"direction\": \"long\",
    \"contractSymbol\": \"META 260508C600\",
    \"triggerPrice\": 606.80,
    \"triggerDirection\": \"crossing_up\",
    \"stopPrice\": 603.90,
    \"account\": \"ts-live\",
    \"qty\": 1,
    \"limitPrice\": 7.00,
    \"gates\": [\"TA\", \"TAPE\", \"VISION\"],
    \"allowOverride\": false,
    \"bracket\": { \"stopPct\": 50, \"tp1Pct\": 25 },
    \"timeWindow\": { \"start\": \"09:45\", \"end\": \"15:00\" },
    \"expiresAt\": \"$META_EXPIRY\",
    \"pattern\": \"john-vip-entry\",
    \"source\": \"john-vip\",
    \"notes\": \"John posted META CALL entry \$606.80 on May 5 PM. Stop \$603.90. 1 DTE warning — expires Wed.\"
  }" | python3 -m json.tool

echo
echo ">>> Final list of armed conditionals"
curl -sS "$BASE/api/smart-conditional/list?status=ARMED" | python3 -m json.tool
