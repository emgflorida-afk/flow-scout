#!/bin/bash
# =============================================================================
# START VISION DAEMON (Phase 4.32)
# Run on AB's local Mac. Spawns scripts/visionDaemon.js as a long-running
# background process. PID stored at /tmp/vision-daemon.pid.
#
# Usage:
#   ./scripts/start-vision-daemon.sh
# =============================================================================
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/vision-daemon.pid"
LOG_FILE="/tmp/vision-daemon.log"

# Already running?
if [ -f "$PID_FILE" ]; then
  EXISTING=$(cat "$PID_FILE")
  if kill -0 "$EXISTING" 2>/dev/null; then
    echo "Vision daemon already running (PID $EXISTING)"
    echo "  log: $LOG_FILE"
    echo "  to restart:  ./scripts/stop-vision-daemon.sh && ./scripts/start-vision-daemon.sh"
    exit 0
  else
    echo "Stale PID file ($EXISTING), removing"
    rm -f "$PID_FILE"
  fi
fi

# Truncate log on each fresh start so it doesn't grow unbounded
: > "$LOG_FILE"

cd "$REPO_ROOT"

echo "Starting vision daemon..."
echo "  REPO_ROOT=$REPO_ROOT"
echo "  log:  $LOG_FILE"

nohup node "$REPO_ROOT/scripts/visionDaemon.js" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

# Wait a moment to confirm it didn't immediately die
sleep 1
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Vision daemon started PID $NEW_PID"
  echo "  tail log: tail -f $LOG_FILE"
else
  echo "Vision daemon failed to start. Last log lines:"
  tail -20 "$LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
