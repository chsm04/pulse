# Pulse

A local Channel plugin that injects external notifications into Claude Code sessions in real-time.

No Discord, no Telegram — just a single HTTP POST to push messages into your conversation.

**[한국어](./README.ko.md)**

## Why Pulse?

Checking your email every time CI fails, then telling the agent "go check the CI result"?

Copying and pasting build error logs into the session manually?

Running a deploy script and opening another terminal to see if it finished?

With Pulse, you don't have to. Background processes send messages directly to your session.

Pulse is an **event abstraction layer** built on Claude Code's [Channels](https://docs.anthropic.com/en/docs/claude-code/channels) protocol. Any local process that can make an HTTP call can communicate with your Claude Code session directly — no external messengers, no bot tokens, no accounts.

## Concept

```
Hooks / Scripts / Cron
    ↓ HTTP POST localhost:3400/notify
Pulse MCP Server
    ↓ notifications/claude/channel
Real-time injection into Claude Code session
```

Pulse leverages Claude Code's [Channels](https://docs.anthropic.com/en/docs/claude-code/channels) protocol. The MCP server registers with the `claude/channel` capability and forwards HTTP requests to the session via `notifications/claude/channel`.

## Installation

### 1. Add marketplace in Claude Code

`/plugins` → `Add Marketplace` → enter `chsm04/pulse`

### 2. Install the pulse plugin

Select pulse from the marketplace list → Install

### 3. Start session with channel mode

```bash
claude --dangerously-load-development-channels plugin:pulse@pulse
```

## API

### POST `/notify`

Deliver a notification to the Claude Code session.

```bash
curl -s -X POST localhost:3400/notify \
  -H "Content-Type: application/json" \
  -d '{"text":"Build failed!","source":"ci","level":"error"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Notification content |
| `source` | string | No | Origin identifier (ci, deploy, cron, etc.) |
| `level` | string | No | `info` \| `warn` \| `error` (default: info) |

**Response:** `204 No Content` (`x-pulse-id` header contains the message ID)

### GET `/health`

```bash
curl localhost:3400/health
# {"status":"ok","port":3400,"session":"12345","pid":67890}
```

## Examples

### CI/CD Result Notification

[`examples/ci-watcher.sh`](./examples/ci-watcher.sh) — a ready-to-use hook script that watches GitHub Actions runs and reports results via Pulse.

**Features:**
- Finds Pulse port automatically via Claude Code PID
- Deduplicates notifications (no double alerts from `git push` + `gh pr create`)
- Supports `.ci-watch-ignore` for skipping specific workflows
- Tracks multiple concurrent runs, reports each as it completes

**Setup** — add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/ci-watcher.sh",
            "statusMessage": "CI watcher started...",
            "async": true
          }
        ]
      }
    ]
  }
}
```

Requires `gh`, `jq`, `curl`.

### Build Error Auto-Report

Add to your build script — on failure, error logs are sent straight to your session:

```bash
#!/bin/bash
BUILD_OUTPUT=$(npm run build 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  # Send last 30 lines (trim if too long)
  ERROR=$(echo "$BUILD_OUTPUT" | tail -30 | jq -Rsa .)
  curl -s -X POST localhost:3400/notify \
    -H "Content-Type: application/json" \
    -d "{\"text\":$ERROR,\"source\":\"build\",\"level\":\"error\"}"
fi
```

### Deploy Notification

Add one line at the end of your deploy script:

```bash
#!/bin/bash
docker compose up -d --build backend
curl -s -X POST localhost:3400/notify \
  -H "Content-Type: application/json" \
  -d '{"text":"backend deploy complete","source":"deploy","level":"info"}'
```

### Cron Job Result

```bash
# crontab -e
0 * * * * /path/to/backup.sh && curl -s -X POST localhost:3400/notify -H "Content-Type: application/json" -d '{"text":"Backup complete","source":"cron","level":"info"}' || curl -s -X POST localhost:3400/notify -H "Content-Type: application/json" -d '{"text":"Backup failed!","source":"cron","level":"error"}'
```

### Server Monitoring

```bash
#!/bin/bash
USAGE=$(df -h / | awk 'NR==2{print $5}' | tr -d '%')
if [ "$USAGE" -gt 90 ]; then
  curl -s -X POST localhost:3400/notify \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"Disk usage ${USAGE}% exceeded!\",\"source\":\"monitor\",\"level\":\"warn\"}"
fi
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PULSE_PORT` | `3400` | HTTP server port |

## Limitations

- Localhost only (127.0.0.1)
- In-memory (resets on server restart)
- Requires `--dangerously-load-development-channels` flag to start
- No authentication (local environment only)

## License

MIT
