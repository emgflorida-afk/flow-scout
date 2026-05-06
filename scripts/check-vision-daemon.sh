#!/bin/bash
# =============================================================================
# CHECK VISION DAEMON (Phase 4.32)
# Reports daemon status: PID alive?, last-N log lines, Railway health endpoint.
#
# Usage:
#   ./scripts/check-vision-daemon.sh
# =============================================================================
PID_FILE="/tmp/vision-daemon.pid"
LOG_FILE="/tmp/vision-daemon.log"
RAILWAY_BASE="${FLOW_SCOUT_BASE:-https://flow-scout-production.up.railway.app}"

echo "==================================================================="
echo "VISION DAEMON STATUS CHECK"
echo "==================================================================="
echo ""
echo "[1/3] Local process"
echo "-------------------------------------------------------------------"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "  PID:    $PID (RUNNING)"
    UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ' || echo '?')
    echo "  uptime: $UPTIME"
    echo "  cmd:    $(ps -o command= -p "$PID" 2>/dev/null | head -c 200)"
  else
    echo "  PID file exists ($PID) but process is dead. Stale."
  fi
else
  echo "  No PID file at $PID_FILE — daemon not started"
  STRAY=$(pgrep -f "node.*visionDaemon.js" || true)
  if [ -n "$STRAY" ]; then
    echo "  Stray daemon process(es) detected: $STRAY"
  fi
fi

echo ""
echo "[2/3] Local log tail (last 20 lines)"
echo "-------------------------------------------------------------------"
if [ -f "$LOG_FILE" ]; then
  tail -20 "$LOG_FILE"
else
  echo "  No log at $LOG_FILE"
fi

echo ""
echo "[3/3] Railway /api/vision/health"
echo "-------------------------------------------------------------------"
HEALTH=$(curl -s --max-time 8 "$RAILWAY_BASE/api/vision/health" || echo '{"ok":false,"error":"curl failed"}')
if command -v python3 >/dev/null 2>&1; then
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
else
  echo "$HEALTH"
fi

echo ""
echo "==================================================================="
