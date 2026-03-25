#!/bin/bash
# build-notify — run a build command and send errors to Pulse on failure
#
# Usage:
#   build-notify.sh <command...>
#
# Examples:
#   build-notify.sh npm run build
#   build-notify.sh bun x tsc --noEmit
#   build-notify.sh cargo build --release
#
# If the command fails, the last 50 lines of output are sent to the
# Pulse session. Works both inside Claude Code hooks (finds session via
# ancestor PID) and standalone (scans for any live Pulse instance).

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: build-notify.sh <command...>" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Find Pulse port
# ---------------------------------------------------------------------------

find_claude_pid() {
  local pid=$PPID
  while [ "$pid" -gt 1 ] 2>/dev/null; do
    local info
    info=$(ps -p "$pid" -o ppid=,comm= 2>/dev/null) || return 1
    local comm
    comm=$(echo "$info" | awk '{print $NF}')
    if [ "$comm" = "claude" ]; then
      echo "$pid"
      return 0
    fi
    pid=$(echo "$info" | awk '{print $1}')
  done
  return 1
}

PULSE_PORT=""

# Try 1: ancestor Claude PID
CLAUDE_PID=$(find_claude_pid 2>/dev/null) || true
if [ -n "$CLAUDE_PID" ]; then
  PULSE_PORT=$(cat ~/.pulse/"$CLAUDE_PID".port 2>/dev/null || echo "")
fi

# Try 2: scan port files for a live instance
if [ -z "$PULSE_PORT" ]; then
  for f in ~/.pulse/*.port; do
    [ -f "$f" ] || continue
    PORT_CANDIDATE=$(cat "$f" 2>/dev/null || echo "")
    if [ -n "$PORT_CANDIDATE" ] && curl -sf "localhost:$PORT_CANDIDATE/health" >/dev/null 2>&1; then
      PULSE_PORT="$PORT_CANDIDATE"
      break
    fi
  done
fi

# ---------------------------------------------------------------------------
# Run the build command
# ---------------------------------------------------------------------------

OUTPUT=$("$@" 2>&1) && exit 0

EXIT_CODE=$?

# Build failed — send error to Pulse if available
if [ -n "$PULSE_PORT" ]; then
  ERROR=$(echo "$OUTPUT" | tail -50 | jq -Rsa .)
  curl -s -X POST "localhost:$PULSE_PORT/notify" \
    -H "Content-Type: application/json" \
    -d "{\"text\":$ERROR,\"source\":\"build\",\"level\":\"error\"}" 2>/dev/null || true
fi

# Still output the error and exit with the original code
echo "$OUTPUT" >&2
exit $EXIT_CODE
