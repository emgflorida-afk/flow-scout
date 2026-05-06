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

# launchctl-managed?
if launchctl list com.flowscout.visiondaemon >/dev/null 2>&1; then
  LD_PID=$(launchctl list com.flowscout.visiondaemon 2>/dev/null | sed -n 's/.*"PID" = \([0-9]*\);/\1/p')
  if [ -n "$LD_PID" ] && [ "$LD_PID" != "0" ] && kill -0 "$LD_PID" 2>/dev/null; then
    echo "Vision daemon already running under launchctl (PID $LD_PID)"
    echo "  log: $LOG_FILE"
    echo "  to restart launchctl:"
    echo "    launchctl unload -w ~/Library/LaunchAgents/com.flowscout.visiondaemon.plist"
    echo "    launchctl load   -w ~/Library/LaunchAgents/com.flowscout.visiondaemon.plist"
    exit 0
  fi
fi

# Already running via start-script (no launchctl)?
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
