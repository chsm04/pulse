#!/bin/bash
# CI Watcher — tracks GitHub Actions runs and reports results via Pulse
#
# Automatically triggered by Claude Code PostToolUse hook on `gh pr create`,
# `git push`, or `gh pr merge`. Watches all CI/CD runs for the relevant
# commit and sends pass/fail notifications to the active Pulse channel.
#
# Features:
#   - Finds Pulse port via ancestor Claude Code PID (session-aware)
#   - Deduplicates notifications (lock file per commit + session)
#   - Supports .ci-watch-ignore for skipping specific workflows
#   - Tracks multiple concurrent runs, reports each as it completes
#   - Tracks post-merge CI/CD runs (e.g. deploy pipelines on main)
#   - 10 minute timeout with warning notification
#
# Requirements: gh, jq, curl
#
# Setup — add to ~/.claude/settings.json:
#
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "bash /path/to/ci-watcher.sh",
#               "statusMessage": "CI watcher started...",
#               "async": true
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Optional — create .ci-watch-ignore in your repo root to skip workflows:
#
#   # one pattern per line (case-insensitive grep match)
#   deploy
#   nightly

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse hook input
# ---------------------------------------------------------------------------

STDIN_JSON=$(cat)
CMD=$(echo "$STDIN_JSON" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then exit 0; fi

# Determine trigger type
TRIGGER=""
if echo "$CMD" | grep -qE "gh pr merge"; then
  TRIGGER="merge"
elif echo "$CMD" | grep -qE "gh pr create"; then
  TRIGGER="pr"
elif echo "$CMD" | grep -qE "git push" && ! echo "$CMD" | grep -qE "--delete|-d"; then
  TRIGGER="push"
fi
if [ -z "$TRIGGER" ]; then exit 0; fi

# ---------------------------------------------------------------------------
# Resolve Pulse port via ancestor Claude Code PID
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

CLAUDE_PID=$(find_claude_pid) || { exit 0; }
PULSE_PORT=$(cat ~/.pulse/"$CLAUDE_PID".port 2>/dev/null || echo "")
if [ -z "$PULSE_PORT" ]; then exit 0; fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

notify() {
  local text="$1"
  local level="${2:-info}"
  curl -s -X POST "localhost:$PULSE_PORT/notify" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$text\",\"source\":\"ci\",\"level\":\"$level\"}" 2>/dev/null || true
}

# Get repo
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$REPO" ]; then exit 0; fi

# ---------------------------------------------------------------------------
# Resolve commit SHA based on trigger type
# ---------------------------------------------------------------------------

if [ "$TRIGGER" = "merge" ]; then
  # Extract PR number from command (gh pr merge 123 or gh pr merge URL)
  PR_NUM=$(echo "$CMD" | grep -oE 'gh pr merge [^ ]+' | awk '{print $NF}' | grep -oE '[0-9]+' | head -1)
  if [ -z "$PR_NUM" ]; then exit 0; fi

  # Get the merge commit SHA from the merged PR
  PR_JSON=$(gh pr view "$PR_NUM" --repo "$REPO" --json mergeCommit,baseRefName 2>/dev/null || echo "{}")
  SHA=$(echo "$PR_JSON" | jq -r '.mergeCommit.oid // empty' 2>/dev/null)

  if [ -z "$SHA" ]; then
    # Merge might not be complete yet, wait and retry
    sleep 5
    PR_JSON=$(gh pr view "$PR_NUM" --repo "$REPO" --json mergeCommit,baseRefName 2>/dev/null || echo "{}")
    SHA=$(echo "$PR_JSON" | jq -r '.mergeCommit.oid // empty' 2>/dev/null)
  fi
  if [ -z "$SHA" ]; then exit 0; fi
else
  SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$SHA" ]; then exit 0; fi
fi

# ---------------------------------------------------------------------------
# Dedup: skip if another ci-watcher is already tracking this commit
# ---------------------------------------------------------------------------

LOCK_DIR=~/.pulse/locks
mkdir -p "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/${CLAUDE_PID}-${SHA}.lock"
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_FILE" 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
# Load .ci-watch-ignore
# ---------------------------------------------------------------------------

IGNORE_FILE="$(git rev-parse --show-toplevel 2>/dev/null)/.ci-watch-ignore"
IGNORE_PATTERNS=()
if [ -f "$IGNORE_FILE" ]; then
  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/#.*//' | xargs)
    [ -n "$line" ] && IGNORE_PATTERNS+=("$line")
  done < "$IGNORE_FILE"
fi

is_ignored() {
  local name="$1"
  for pattern in "${IGNORE_PATTERNS[@]+"${IGNORE_PATTERNS[@]}"}"; do
    if echo "$name" | grep -qi "$pattern"; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Watch CI runs
# ---------------------------------------------------------------------------

START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 10  # wait for runs to appear

SEEN_RUNS=()
TIMEOUT=600
ELAPSED=0
NO_NEW_RUNS_COUNT=0
MAX_NO_NEW=6  # 30s without new runs after all completed → done

while [ $ELAPSED -lt $TIMEOUT ]; do
  RUNS_JSON=$(gh run list --repo "$REPO" --commit "$SHA" --created ">=$START_TIME" \
    --json databaseId,name,status,conclusion --limit 50 2>/dev/null || echo "[]")

  if [ "$RUNS_JSON" = "[]" ] || [ -z "$RUNS_JSON" ]; then
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    continue
  fi

  ALL_COMPLETED=true
  CURRENT_RUN_IDS=()

  while IFS= read -r run; do
    RUN_ID=$(echo "$run" | jq -r '.databaseId')
    RUN_NAME=$(echo "$run" | jq -r '.name')
    RUN_STATUS=$(echo "$run" | jq -r '.status')
    RUN_CONCLUSION=$(echo "$run" | jq -r '.conclusion')

    CURRENT_RUN_IDS+=("$RUN_ID")

    if is_ignored "$RUN_NAME"; then continue; fi

    ALREADY_REPORTED=false
    for seen in "${SEEN_RUNS[@]+"${SEEN_RUNS[@]}"}"; do
      if [ "$seen" = "$RUN_ID:done" ]; then
        ALREADY_REPORTED=true
        break
      fi
    done
    if [ "$ALREADY_REPORTED" = true ]; then continue; fi

    if [ "$RUN_STATUS" = "completed" ]; then
      JOBS_JSON=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs 2>/dev/null || echo "{}")
      JOB_NAMES=$(echo "$JOBS_JSON" | jq -r '.jobs[].name // empty' 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

      if [ "$RUN_CONCLUSION" = "success" ]; then
        notify "$RUN_NAME passed! ($JOB_NAMES)" "info"
      else
        FAILED_JOBS=$(echo "$JOBS_JSON" | jq -r '.jobs[] | select(.conclusion != "success") | .name' 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
        notify "$RUN_NAME failed! Failed jobs: $FAILED_JOBS" "error"
      fi

      SEEN_RUNS+=("$RUN_ID:done")
    else
      ALL_COMPLETED=false
    fi
  done <<< "$(echo "$RUNS_JSON" | jq -c '.[]')"

  if [ "$ALL_COMPLETED" = true ] && [ ${#CURRENT_RUN_IDS[@]} -gt 0 ]; then
    NO_NEW_RUNS_COUNT=$((NO_NEW_RUNS_COUNT + 1))
    if [ $NO_NEW_RUNS_COUNT -ge $MAX_NO_NEW ]; then
      break
    fi
  else
    NO_NEW_RUNS_COUNT=0
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if [ $ELAPSED -ge $TIMEOUT ]; then
  notify "CI watch timed out (10min). Some runs may still be in progress." "warn"
fi
