// gatewayClient：reasoning_content 捕获；agent 存储并在投影中原样回传。
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { GatewayClient } from '../src/main/gatewayClient'
import { runAgentTurn } from '../src/main/agent'
import { Session } from '../src/main/session'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx, StreamHandlers } from '../src/shared/types'

let server: ReturnType<typeof createServer>
let base: string
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { reasoning_content: '思考一下' } }],
          }) +
          '\n\n',
      )
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '结果' } }] }) + '\n\n',
      )
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server?.close())

function makeCfg(): AppConfig {
  return {
    gatewayUrl: base,
    adminUrl: base,
    defaultAlias: 'common',
    writeConfirm: 'auto',
    hotkey: 'x',
    enabledCommands: {},
  } as AppConfig
}

describe('gatewayClient chatStream', () => {
  it('解析 reasoning_content 与 content 增量', async () => {
    const client = new GatewayClient(makeCfg())
    let content = ''
    let reasoning = ''
    await client.chatStream(
      { model: 'common', messages: [{ role: 'user', content: 'q' }] },
      {
        onContent: (d) => (content += d),
        onReasoning: (d) => (reasoning += d),
        onFinish: () => {},
      },
    )
    expect(content).toBe('结果')
    expect(reasoning).toBe('思考一下')
  })
})

describe('reasoning_content 存储与回传', () => {
  it('assistant.message 携带 reasoning_content → 投影 messages() 原样回传', () => {
    const s = new Session()
    s.append('assistant.message', { role: 'assistant', content: '答', reasoning_content: '思考' })
    const m = s.messages()[0]
    expect(m.content).toBe('答')
    expect(m.reasoning_content).toBe('思考')
  })

  it('runAgentTurn 从流式捕获并存入 assistant.message', async () => {
    const ctx = {
      config: makeCfg(),
      gateway: {
        models: async () => ['common'],
        chat: async () => ({ content: '' }),
        chatStream: async (_req: { messages: unknown[] }, h: StreamHandlers, _opts?: { signal?: AbortSignal }) => {
          h.onReasoning?.('内部推理')
          h.onContent('可见答复')
          h.onFinish?.('stop')
        },
      },
      system: { pbcopy: async () => true, mdfind: async () => [] },
    } as unknown as Ctx
    const s = new Session()
    await runAgentTurn(s, 'hi', ctx, new Registry(), { onContent: () => {}, onEvent: () => {} })
    const asst = s.transcript().find((e) => e.type === 'assistant.message')
    expect(asst?.content).toBe('可见答复')
    expect(asst?.reasoning_content).toBe('内部推理')
    expect(s.messages().some((m) => m.reasoning_content === '内部推理')).toBe(true)
  })
})
