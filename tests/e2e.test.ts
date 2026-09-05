// 运行时 e2e：真实 GatewayClient ↔ mock gateway HTTP ↔ 真实 registry/agent/session。
// 覆盖主流程：quick 命令(trans) + agent 对话(流式 + 工具分发)。不依赖 Electron GUI。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { Registry } from '../src/main/registry'
import { GatewayClient } from '../src/main/gatewayClient'
import { Session } from '../src/main/session'
import { runAgentTurn } from '../src/main/agent'
import { ChatManager } from '../src/main/chat'
import type { AppConfig, Ctx, SessionEvent } from '../src/shared/types'
import { trans } from '../commands/trans'
import { findFile } from '../commands/find_file'

// 最小 mock gateway：models + chat(非流式→译文; 流式→agent 工具→最终回复)
function mockGateway() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'common' }, { id: 'trans' }] }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const r = JSON.parse(body)
        if (!r.stream) {
          // trans 等非流式
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ choices: [{ message: { content: '你好,世界' }, finish_reason: 'stop' }] }))
          return
        }
        res.setHeader('Content-Type', 'text/event-stream')
        const hasToolRole = (r.messages ?? []).some((m: any) => m.role === 'tool')
        const hasTools = Array.isArray(r.tools) && r.tools.length > 0
        if (hasTools && !hasToolRole) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'find_file', arguments: '{"query":"report"}' } }] } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '找到了 /tmp/report.md' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        }
        res.end('data: [DONE]\n\n')
      })
    }
  })
}

let server: ReturnType<typeof mockGateway>
let ctx: Ctx
let registry: Registry

beforeAll(async () => {
  server = mockGateway()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const config: AppConfig = {
    gatewayUrl: `http://127.0.0.1:${port}`,
    adminUrl: `http://127.0.0.1:${port}`,
    defaultAlias: 'common',
    fileRoots: ['/tmp'],
    writeConfirm: 'auto',
    hotkey: 'x',
    enabledCommands: {},
  }
  ctx = {
    config,
    gateway: new GatewayClient(config),
    system: { pbcopy: async () => true, mdfind: async (q) => [`/tmp/${q}.md`] },
  }
  registry = new Registry().registerAll([trans, findFile])
})

afterAll(() => server?.close())

describe('runtime e2e（主流程）', () => {
  it('quick 命令：match → run(trans) → inline 结果', async () => {
    const m = registry.match('tra')
    expect(m[0]?.id).toBe('trans')
    const out = await registry.run('trans', 'hello', ctx)
    expect(out.type === 'text' && (out as any).text).toContain('你好')
  })

  it('models 发现别名', async () => {
    const aliases = await ctx.gateway.models()
    expect(aliases).toContain('common')
  })

  it('agent 对话：流式 + 工具分发 + 会话事件', async () => {
    const session = new Session()
    const deltas: string[] = []
    const events: SessionEvent[] = []
    const final = await runAgentTurn(session, '帮我找 report', ctx, registry, {
      onContent: (d) => deltas.push(d),
      onEvent: (e) => events.push(e),
    })
    expect(final).toContain('找到了')
    expect(deltas.join('')).toContain('找到了')
    const types = session.transcript().map((e) => e.type)
    expect(types).toContain('tool.call')
    expect(types).toContain('tool.result')
    expect(events.map((e) => e.type)).toEqual(types)
  })

  it('ChatManager 串行 run 并推流', async () => {
    const chat = new ChatManager(ctx, registry, undefined)
    await chat.open('帮我找 report', {
      onEvent: () => {},
      onDelta: () => {},
    })
    expect(chat.transcript().length).toBeGreaterThan(0)
    expect(chat.transcript().some((e) => e.type === 'tool.result')).toBe(true)
  })
})
