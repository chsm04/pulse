# Pulse

Claude Code 세션에 외부 알림을 실시간으로 주입하는 로컬 Channel 플러그인.

Discord, Telegram 같은 외부 서비스 없이 HTTP POST 하나로 대화에 끼어들 수 있어요.

**[English](./README.md)**

## 왜 Pulse인가?

Claude Code의 Channels는 세션에 메시지를 보내려면 Discord나 Slack 같은 외부 메신저를 거쳐야 해요. 로컬 스크립트에서 간단한 알림 하나 보내려고 봇 토큰, 계정, 외부 네트워크 접근이 필요한 건 불필요한 마찰이에요.

Pulse는 이 의존성을 제거하는 **이벤트 추상화 레이어**예요. HTTP 호출이 가능한 모든 로컬 프로세스가 외부 메신저를 거치지 않고 Claude Code 세션과 직접 소통할 수 있어요.

## 개념

```
훅 / 스크립트 / cron
    ↓ HTTP POST localhost:3400/notify
Pulse MCP 서버
    ↓ notifications/claude/channel
Claude Code 세션에 실시간 주입
```

Pulse는 Claude Code의 [Channels](https://docs.anthropic.com/en/docs/claude-code/channels) 프로토콜을 활용해요. MCP 서버가 `claude/channel` capability로 등록되고, HTTP 요청을 받으면 `notifications/claude/channel`로 세션에 메시지를 전달해요.

## 설치

### 1. Claude Code에서 marketplace 추가

`/plugins` → `Add Marketplace` → `chsm04/pulse` 입력

### 2. pulse 플러그인 설치

marketplace 목록에서 pulse 선택 → Install

### 3. 채널 모드로 세션 시작

```bash
claude --dangerously-load-development-channels plugin:pulse@pulse
```

## API

### POST `/notify`

알림을 Claude Code 세션에 전달.

```bash
curl -s -X POST localhost:3400/notify \
  -H "Content-Type: application/json" \
  -d '{"text":"메시지 내용","source":"ci","level":"error"}'
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `text` | string | O | 알림 내용 |
| `source` | string | X | 알림 출처 (ci, deploy, cron 등) |
| `level` | string | X | `info` \| `warn` \| `error` (기본: info) |

**응답:** `204 No Content` (성공 시 `x-pulse-id` 헤더에 메시지 ID 포함)

### GET `/health`

```bash
curl localhost:3400/health
# {"status":"ok","port":3400,"session":"12345","pid":67890}
```

## 활용 예시

### CI/CD 결과 알림

[`examples/ci-watcher.sh`](./examples/ci-watcher.sh) — GitHub Actions 실행을 추적하고 결과를 Pulse로 보내주는 hook 스크립트에요.

**기능:**
- Claude Code PID를 기반으로 Pulse 포트를 자동 탐색
- 중복 알림 방지 (`git push` + `gh pr create` 동시 트리거 시 1번만 알림)
- `.ci-watch-ignore`로 특정 워크플로우 제외 가능
- 여러 CI run을 동시 추적, 각각 완료될 때마다 알림

**설정** — `~/.claude/settings.json`에 추가:

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

`gh`, `jq`, `curl`이 필요해요.

### 배포 완료 알림

배포 스크립트 끝에 한 줄 추가:

```bash
#!/bin/bash
docker compose up -d --build backend
curl -s -X POST localhost:3400/notify \
  -H "Content-Type: application/json" \
  -d '{"text":"backend 배포 완료","source":"deploy","level":"info"}'
```

### cron job 결과 알림

```bash
# crontab -e
0 * * * * /path/to/backup.sh && curl -s -X POST localhost:3400/notify -H "Content-Type: application/json" -d '{"text":"백업 완료","source":"cron","level":"info"}' || curl -s -X POST localhost:3400/notify -H "Content-Type: application/json" -d '{"text":"백업 실패!","source":"cron","level":"error"}'
```

### 서버 모니터링

```bash
#!/bin/bash
USAGE=$(df -h / | awk 'NR==2{print $5}' | tr -d '%')
if [ "$USAGE" -gt 90 ]; then
  curl -s -X POST localhost:3400/notify \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"디스크 사용량 ${USAGE}% 초과!\",\"source\":\"monitor\",\"level\":\"warn\"}"
fi
```

## 설정

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `PULSE_PORT` | `3400` | HTTP 서버 포트 |

## 제약사항

- localhost 전용 (127.0.0.1)
- 인메모리 (서버 재시작 시 초기화)
- Claude Code 세션이 `--dangerously-load-development-channels`로 시작돼야 함
- 인증 없음 (로컬 환경 전용)

## License

MIT
