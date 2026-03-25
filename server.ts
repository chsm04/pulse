#!/usr/bin/env bun
// Pulse — local channel plugin for Claude Code
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'))

const PORT = Number(process.env.PULSE_PORT ?? 3400)
const STATE_DIR = join(homedir(), '.pulse')
const WATCHDOG_INTERVAL_MS = 5_000
let seq = 0
let boundPort = PORT

// ---------------------------------------------------------------------------
// Session key: find ancestor Claude Code process PID
// ---------------------------------------------------------------------------

function findAncestorPid(name: string): number | null {
  let pid = process.ppid
  while (pid > 1) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], {
      encoding: 'utf-8',
    })
    if (result.status !== 0 || !result.stdout.trim()) return null
    const line = result.stdout.trim()
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) return null
    const comm = match[2].trim()
    if (comm === name || comm.endsWith(`/${name}`)) return pid
    pid = parseInt(match[1], 10)
  }
  return null
}

const _claudePid = findAncestorPid('claude')
if (!_claudePid) {
  process.stderr.write('[pulse] could not find ancestor claude process, exiting\n')
  process.exit(1)
}
const CLAUDE_PID: number = _claudePid
const SESSION_KEY = String(CLAUDE_PID)
process.stderr.write(`[pulse] session key: claude PID ${SESSION_KEY}\n`)

// ---------------------------------------------------------------------------
// Port file management
// ---------------------------------------------------------------------------

function nextId() {
  return `p-${Date.now()}-${++seq}`
}

function savePort(port: number): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, `${SESSION_KEY}.port`), String(port))
  process.stderr.write(`[pulse] port file: ~/.pulse/${SESSION_KEY}.port → ${port}\n`)
}

function cleanupPort(): void {
  try { unlinkSync(join(STATE_DIR, `${SESSION_KEY}.port`)) } catch {}
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function cleanupStale(): void {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith('.port')) continue
      const pid = parseInt(f.replace('.port', ''), 10)
      if (isNaN(pid)) {
        try { unlinkSync(join(STATE_DIR, f)) } catch {}
        continue
      }
      if (!isProcessAlive(pid)) {
        process.stderr.write(`[pulse] removing stale port file: ${f} (PID ${pid} dead)\n`)
        try { unlinkSync(join(STATE_DIR, f)) } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Watchdog: self-terminate when Claude Code dies
// ---------------------------------------------------------------------------

function startWatchdog(): void {
  const timer = setInterval(() => {
    if (!isProcessAlive(CLAUDE_PID)) {
      process.stderr.write(`[pulse] claude process ${CLAUDE_PID} gone, shutting down\n`)
      clearInterval(timer)
      cleanupPort()
      process.exit(0)
    }
  }, WATCHDOG_INTERVAL_MS)
  timer.unref()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on('exit', cleanupPort)
process.on('SIGINT', () => { cleanupPort(); process.exit(0) })
process.on('SIGTERM', () => { cleanupPort(); process.exit(0) })

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'pulse', version: pkg.version },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'Pulse is a local notification channel. Messages arrive from background processes like CI, hooks, or scripts.',
      'Messages appear as <channel source="pulse">. The level field indicates severity: info, warn, or error.',
      'Use the acknowledge tool to confirm you have seen and handled the notification.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'acknowledge',
      description: 'Acknowledge a pulse notification.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'ID of the notification' },
          note: { type: 'string', description: 'Optional note about action taken' },
        },
        required: ['message_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  if (req.params.name === 'acknowledge') {
    const id = args.message_id as string
    const note = (args.note as string) ?? ''
    process.stderr.write(`[pulse] ack ${id}${note ? `: ${note}` : ''}\n`)
    return { content: [{ type: 'text', text: `acknowledged: ${id}` }] }
  }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
})

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Notification delivery
// ---------------------------------------------------------------------------

function deliver(text: string, source?: string, level?: string): string {
  const id = nextId()
  const content = source ? `[${source}] ${text}` : text

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        chat_id: 'pulse',
        message_id: id,
        user: source ?? 'pulse',
        ts: new Date().toISOString(),
        ...(level ? { level } : {}),
      },
    },
  })

  process.stderr.write(`[pulse] delivered ${id}: ${content.slice(0, 80)}\n`)
  return id
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_PORT_ATTEMPTS = 10

function tryServe(port: number, attempt = 0): void {
  try {
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === '/health') {
          return Response.json({
            status: 'ok',
            port: boundPort,
            session: SESSION_KEY,
            pid: process.pid,
          })
        }

        if (url.pathname === '/notify' && req.method === 'POST') {
          try {
            const body = await req.json() as { text?: string; source?: string; level?: string }
            if (!body.text) {
              return Response.json({ error: 'text is required' }, { status: 400 })
            }
            const level = body.level ?? 'info'
            if (!['info', 'warn', 'error'].includes(level)) {
              return Response.json({ error: 'level must be info, warn, or error' }, { status: 400 })
            }
            const id = deliver(body.text, body.source, level)
            return new Response(null, { status: 204, headers: { 'x-pulse-id': id } })
          } catch {
            return Response.json({ error: 'invalid json' }, { status: 400 })
          }
        }

        return Response.json({ error: 'not found' }, { status: 404 })
      },
    })
    boundPort = port
    cleanupStale()
    savePort(port)
    startWatchdog()
    process.stderr.write(`[pulse] listening on http://127.0.0.1:${port}\n`)
  } catch {
    if (attempt < MAX_PORT_ATTEMPTS - 1) {
      process.stderr.write(`[pulse] port ${port} in use, trying ${port + 1}...\n`)
      tryServe(port + 1, attempt + 1)
    } else {
      process.stderr.write(`[pulse] failed to find available port (tried ${PORT}-${port})\n`)
      process.exit(1)
    }
  }
}

tryServe(PORT)
