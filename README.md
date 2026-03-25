# Pulse

Claude Code 세션에 외부 알림을 실시간으로 주입하는 로컬 Channel 플러그인.

Discord, Telegram 같은 외부 서비스 없이 HTTP POST 하나로 대화에 끼어들 수 있어요.

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
# {"status":"ok"}
```

## 활용 예시

### CI/CD 결과 알림

Claude Code 훅(PostToolUse)에서 PR 생성 후 CI 상태를 추적하고, 결과를 pulse로 전달:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c '...gh run watch...; if [ $EXIT -ne 0 ]; then curl -s -X POST localhost:3400/notify -H \"Content-Type: application/json\" -d \"{\\\"text\\\":\\\"CI 실패!\\\",\\\"source\\\":\\\"ci\\\",\\\"level\\\":\\\"error\\\"}\"; fi'",
            "async": true
          }
        ]
      }
    ]
  }
}
```

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
# 디스크 사용량 90% 초과 시 알림
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
