// gatewayClient：reasoning_content 捕获；agent 存储并在投影中原样回传。
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { GatewayClient, GatewayError, classifyGatewayError, withRetry } from '../src/main/gatewayClient'
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

describe('错误分类与重试（specs/roadmap 阶段三）', () => {
  const mkCfg = () => ({ gatewayUrl: 'http://x', adminUrl: 'http://x', defaultAlias: 'chat', fileRoots: [] }) as never

  it('classifyGatewayError：按状态码与 errno 归类，并给出可读说明', () => {
    expect(classifyGatewayError(new Error('x'), 401).kind).toBe('auth')
    expect(classifyGatewayError(new Error('x'), 404).kind).toBe('not_found')
    expect(classifyGatewayError(new Error('x'), 422).kind).toBe('bad_request')
    expect(classifyGatewayError(new Error('x'), 503).kind).toBe('server')
    expect(classifyGatewayError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })).kind).toBe('unreachable')
    expect(classifyGatewayError(Object.assign(new Error('t'), { name: 'TimeoutError' })).kind).toBe('timeout')
    // 给用户看的不是原始错误，而是可操作的话
    expect(classifyGatewayError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).message).toContain('网关')
  })

  it('只有可能自愈的失败才标记可重试', () => {
    expect(classifyGatewayError(new Error('x'), 500).retryable).toBe(true)
    expect(classifyGatewayError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).retryable).toBe(true)
    expect(classifyGatewayError(new Error('x'), 400).retryable).toBe(false)
    expect(classifyGatewayError(new Error('x'), 403).retryable).toBe(false)
  })

  it('withRetry：可重试的失败会重试并最终成功', async () => {
    let n = 0
    const r = await withRetry(async () => {
      n++
      if (n < 3) throw new GatewayError('unreachable', 'boom')
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(n).toBe(3)
  })

  it('withRetry：不可重试的失败立即抛出（不浪费时间）', async () => {
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw new GatewayError('bad_request', 'nope')
      }),
    ).rejects.toThrow('nope')
    expect(n).toBe(1)
  })

  it('withRetry：重试次数用尽后抛出最后一次错误', async () => {
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw new GatewayError('server', 'down')
      }, 3, 1),
    ).rejects.toThrow('down')
    expect(n).toBe(3)
  })

  it('models()：连不上会重试（注入 transport 前两次失败）', async () => {
    let n = 0
    const client = new GatewayClient(mkCfg(), {
      post: async () => {
        throw new Error('unused')
      },
      get: async () => {
        n++
        if (n < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
        return new Response(JSON.stringify({ data: [{ id: 'chat' }] }), { status: 200 })
      },
    } as never)
    expect(await client.models()).toEqual(['chat'])
    expect(n).toBe(3)
  })

  it('取消：abort 后抛 cancelled（不归类为 timeout，否则会被当成真失败）', async () => {
    const ctrl = new AbortController()
    const client = new GatewayClient(mkCfg(), {
      post: async () => {
        ctrl.abort() // 模拟用户在流式进行中取消
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
      get: async () => new Response('', { status: 200 }),
    } as never)
    await expect(
      client.chatStream({ model: 'chat', messages: [] }, { onContent: () => {} }, { signal: ctrl.signal }),
    ).rejects.toThrow('cancelled')
  })

  it('models()：401 不重试，且报鉴权失败', async () => {
    let n = 0
    const client = new GatewayClient(mkCfg(), {
      post: async () => new Response('', { status: 200 }),
      get: async () => {
        n++
        return new Response('nope', { status: 401 })
      },
    } as never)
    await expect(client.models()).rejects.toThrow(/鉴权/)
    expect(n).toBe(1)
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
