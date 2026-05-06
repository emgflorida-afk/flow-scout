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
# launchctl-managed daemon takes priority — check launchd first.
if launchctl list com.flowscout.visiondaemon >/dev/null 2>&1; then
  LD_PID=$(launchctl list com.flowscout.visiondaemon 2>/dev/null | sed -n 's/.*"PID" = \([0-9]*\);/\1/p')
  if [ -n "$LD_PID" ] && [ "$LD_PID" != "0" ] && kill -0 "$LD_PID" 2>/dev/null; then
    UPTIME=$(ps -o etime= -p "$LD_PID" 2>/dev/null | tr -d ' ' || echo '?')
    echo "  Launchctl: com.flowscout.visiondaemon"
    echo "  PID:       $LD_PID (RUNNING via launchd)"
    echo "  uptime:    $UPTIME"
  else
    echo "  Launchctl: com.flowscout.visiondaemon LOADED but no live PID"
    echo "  (launchd will respawn on next trigger)"
  fi
elif [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "  PID:    $PID (RUNNING via start-script)"
    UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ' || echo '?')
    echo "  uptime: $UPTIME"
    echo "  cmd:    $(ps -o command= -p "$PID" 2>/dev/null | head -c 200)"
  else
    echo "  PID file exists ($PID) but process is dead. Stale."
  fi
else
  echo "  No launchctl agent and no PID file — daemon not started"
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
