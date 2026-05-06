#!/bin/bash
# =============================================================================
# STOP VISION DAEMON (Phase 4.32)
# Sends SIGTERM to the daemon (graceful shutdown), then SIGKILL after 3s.
#
# Usage:
#   ./scripts/stop-vision-daemon.sh
# =============================================================================
PID_FILE="/tmp/vision-daemon.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file at $PID_FILE — daemon not running?"
  # Try a process scan as a fallback
  STRAY_PIDS=$(pgrep -f "node.*visionDaemon.js" || true)
  if [ -n "$STRAY_PIDS" ]; then
    echo "But found stray daemon process(es): $STRAY_PIDS"
    echo "Killing..."
    echo "$STRAY_PIDS" | xargs kill 2>/dev/null || true
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID not running (already stopped). Cleaning up."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping vision daemon (PID $PID)..."
kill -TERM "$PID" 2>/dev/null || true

# Wait up to 3s for graceful exit
for i in 1 2 3; do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Vision daemon stopped cleanly."
    rm -f "$PID_FILE"
    exit 0
  fi
done

# Force kill
echo "Daemon didn't exit gracefully — SIGKILL."
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Vision daemon force-stopped."
