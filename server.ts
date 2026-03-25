#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const PORT = Number(process.env.PULSE_PORT ?? 3400)
let seq = 0

function nextId() {
  return `p-${Date.now()}-${++seq}`
}

const mcp = new Server(
  { name: 'pulse', version: '0.1.0' },
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

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' })
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

process.stderr.write(`[pulse] listening on http://127.0.0.1:${PORT}\n`)
