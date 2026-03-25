#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const PORT = Number(process.env.PULSE_PORT ?? 3400)
const STATE_DIR = join(homedir(), '.pulse')
const SESSION_KEY = process.env.CLAUDE_CODE_SSE_PORT ?? String(process.ppid)
let seq = 0
let boundPort = PORT

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

function cleanupStale(): void {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.endsWith('.port')) continue
      const pid = parseInt(f.replace('.port', ''), 10)
      if (isNaN(pid)) continue
      try { process.kill(pid, 0) } catch {
        // process doesn't exist, remove stale port file
        try { unlinkSync(join(STATE_DIR, f)) } catch {}
      }
    }
  } catch {}
}

process.on('exit', cleanupPort)
process.on('SIGINT', () => { cleanupPort(); process.exit(0) })
process.on('SIGTERM', () => { cleanupPort(); process.exit(0) })

const mcp = new Server(
  { name: 'pulse', version: '0.0.1' },
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

const MAX_PORT_ATTEMPTS = 10

function tryServe(port: number, attempt = 0): void {
  try {
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === '/health') {
          return Response.json({ status: 'ok', port: boundPort, session: SESSION_KEY })
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
