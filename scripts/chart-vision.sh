#!/bin/bash
# =============================================================================
# CHART VISION CLI HELPER
# Captures TV chart via TV MCP, sends to Railway chart-vision endpoint,
# returns the Claude vision API verdict (APPROVE/VETO/WAIT).
#
# Usage:
#   ./scripts/chart-vision.sh TICKER DIRECTION [TIMEFRAME]
#   ./scripts/chart-vision.sh SPY put-spread Daily
#   ./scripts/chart-vision.sh ARM long Weekly
# =============================================================================

set -e

TICKER="${1:?Usage: chart-vision.sh TICKER DIRECTION [TIMEFRAME]}"
DIRECTION="${2:-long}"
TIMEFRAME="${3:-Daily}"
SHIFT_TF="${TIMEFRAME}"

# TV MCP CLI path
TV_CLI="/Users/NinjaMon/Desktop/tradingview-mcp/src/cli/index.js"
RAILWAY_URL="https://flow-scout-production.up.railway.app/api/chart-vision-review"

# Map TF labels for TV
case "$SHIFT_TF" in
  Daily) TV_TF="D" ;;
  Weekly) TV_TF="W" ;;
  6HR) TV_TF="360" ;;
  4HR) TV_TF="240" ;;
  60|1H) TV_TF="60" ;;
  *) TV_TF="$SHIFT_TF" ;;
esac

echo "🔍 Chart Vision Review for $TICKER ($DIRECTION on $TIMEFRAME)"
echo ""

# Step 1: Set TV chart to ticker + TF
echo "  → Setting TV chart to $TICKER on $TV_TF..."
node "$TV_CLI" symbol "$TICKER" 2>&1 | tail -1
node "$TV_CLI" timeframe "$TV_TF" 2>&1 | tail -1

# Wait for chart data to load — TV needs time to fetch new ticker bars
echo "  → Waiting 8s for chart data to fully render..."
sleep 8

# Step 2: Capture screenshot
echo "  → Capturing screenshot..."
SHOT_OUTPUT=$(node "$TV_CLI" screenshot 2>&1)
SHOT_PATH=$(echo "$SHOT_OUTPUT" | grep -o '"file_path": "[^"]*"' | sed 's/"file_path": "//;s/"$//')

if [ -z "$SHOT_PATH" ] || [ ! -f "$SHOT_PATH" ]; then
  echo "  ❌ Screenshot capture failed"
  echo "$SHOT_OUTPUT"
  exit 1
fi

echo "  ✓ Screenshot at: $SHOT_PATH"

# Step 3: Base64-encode the image
echo "  → Encoding..."
B64=$(base64 -i "$SHOT_PATH" | tr -d '\n')
B64_SIZE=$(echo -n "$B64" | wc -c | tr -d ' ')
echo "  ✓ Base64 size: ${B64_SIZE} bytes"

# Step 4: Build trade context (read from session_state if available)
# Phase 4.42 — if GEX_CONTEXT env var is set (by visionDaemon.js per-candidate
# pre-fetch), prepend it so the model factors regime + king-node + direction
# agreement into the verdict. Stays empty if unset (back-compatible).
GEX_LINE=""
if [ -n "$GEX_CONTEXT" ]; then
  GEX_LINE="GEX context for this analysis: $GEX_CONTEXT — factor this into your verdict, especially for trade direction agreement vs the gamma regime. "
fi
TRADE_CONTEXT="${GEX_LINE}$DIRECTION trade on $TIMEFRAME timeframe. Pattern detector flagged this as actionable. Want chart-vision review for confirmation."

# Step 5: POST to Railway endpoint
echo "  → Calling Claude vision API..."
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'ticker': '$TICKER',
    'direction': '$DIRECTION',
    'tradeContext': '$TRADE_CONTEXT',
    'imageBase64': '$B64',
}))
")

RESPONSE=$(echo "$PAYLOAD" | curl -s -X POST "$RAILWAY_URL" \
  -H 'Content-Type: application/json' \
  -d @- \
  --max-time 60)

# Step 6: Parse + display verdict
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "$RESPONSE" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if not d.get('ok'):
        print('❌ ERROR:', d.get('error', 'unknown'))
        if d.get('apiError'): print('   API:', json.dumps(d['apiError'], indent=2)[:300])
        sys.exit(1)
    r = d.get('review', {})
    verdict = r.get('verdict', '?')
    icon = '🟢' if verdict == 'APPROVE' else '🔴' if verdict == 'VETO' else '🟡'
    print(f'{icon} VERDICT: {verdict}  (confidence: {r.get(\"confidence\")}/10)')
    print()
    print(f'PRIMARY REASON: {r.get(\"primaryReason\")}')
    print()
    print(f'STRUCTURAL ALIGNMENT: {r.get(\"structuralAlignment\")}')
    print(f'PATTERN INTEGRITY:    {r.get(\"patternIntegrity\")}')
    print(f'VOLUME PROFILE:       {r.get(\"volumeProfile\")}')
    print(f'TARGET ATTAINABILITY: {r.get(\"targetAttainability\")}')
    print()
    if r.get('strengths'):
        print('STRENGTHS:')
        for s in r['strengths']:
            print(f'  ✓ {s}')
    if r.get('conflictsDetected'):
        print('CONFLICTS:')
        for c in r['conflictsDetected']:
            print(f'  ⚠ {c}')
    print()
    print(f'IF ENTERED: {r.get(\"ifEntered\")}')
    print()
    print(f'(model: {d.get(\"model\")}, tokens in/out: {d.get(\"promptTokens\")}/{d.get(\"responseTokens\")})')
except Exception as e:
    print('❌ Parse error:', e)
    print('Raw response:', sys.stdin.read()[:500])
"
echo "═══════════════════════════════════════════════════════════════"
