// 录制型 mock gateway（真实 HTTP）：记录每次请求的 messages/tools，供黄金断言「模型实际收到了什么」。
// 与 tests/ui/helpers.ts 的差别：那个面向 Playwright 的固定行为；这个面向断言，回复由 responder 决定。
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface GatewayRequest {
  /** 本次请求的模型可见消息（含 system）。 */
  messages: Array<{ role: string; content?: string; tool_calls?: unknown; tool_call_id?: string }>
  /** 本轮提供给模型的工具定义。 */
  tools: Array<{ function: { name: string; description?: string } }>
  /** true = agent 对话（流式）；false = quick 命令 / 上下文摘要。 */
  stream: boolean
  model?: string
}

export type Reply =
  | { stream: true; content?: string; toolCalls?: Array<{ name: string; args: unknown }> }
  | { stream: false; content: string }

export type Responder = (req: GatewayRequest, index: number) => Reply

export interface RecordingGateway {
  base: string
  /** 全部请求（按到达顺序）。 */
  requests: GatewayRequest[]
  /** 仅流式请求（agent turn）。 */
  turns(): GatewayRequest[]
  /** 仅非流式请求（quick 命令、上下文摘要）。 */
  calls(): GatewayRequest[]
  /** 清空录制（用例间隔离）。 */
  reset(): void
  close(): Promise<void>
}

const ALIASES = ['golden', 'common', 'trans']

/** 拆成两段，模拟真实流式。 */
function chunks(text: string): string[] {
  const mid = Math.ceil(text.length / 2)
  return [text.slice(0, mid), text.slice(mid)].filter(Boolean)
}

export async function startRecordingGateway(responder: Responder, aliases = ALIASES): Promise<RecordingGateway> {
  const requests: GatewayRequest[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/readyz') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: aliases.map((id) => ({ id })) }))
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed: {
        messages?: GatewayRequest['messages']
        tools?: GatewayRequest['tools']
        stream?: boolean
        model?: string
      } = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* 忽略畸形请求体 */
      }
      const rec: GatewayRequest = {
        messages: parsed.messages ?? [],
        tools: parsed.tools ?? [],
        stream: !!parsed.stream,
        model: parsed.model,
      }
      requests.push(rec)

      const reply = responder(rec, requests.length - 1)
      if (!rec.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message: { content: reply.stream ? '' : reply.content }, finish_reason: 'stop' }],
          }),
        )
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const r = reply as Extract<Reply, { stream: true }>
      if (r.toolCalls?.length) {
        r.toolCalls.forEach((tc, i) => {
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: i,
                      id: `call_${i}_${requests.length}`,
                      type: 'function',
                      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    },
                  ],
                },
              },
            ],
          })
        })
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        for (const c of chunks(r.content ?? '')) send({ choices: [{ delta: { content: c } }] })
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      }
      res.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    turns: () => requests.filter((r) => r.stream),
    calls: () => requests.filter((r) => !r.stream),
    reset: () => requests.splice(0, requests.length),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
