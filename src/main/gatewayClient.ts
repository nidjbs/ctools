// OpenAI 兼容客户端 —— cTools 到本地 go-ai-gateway 的唯一模型出口。
// 无任何硬编码 URL/别名；全部来自 AppConfig。
import type { AppConfig, StreamHandlers } from '../shared/types'

export interface ChatRequest {
  model: string
  messages: unknown[]
  stream?: boolean
  tools?: unknown[]
}

export interface ChatTurn {
  content: string
  finishReason?: string
}

/** 轻量 HTTP 传输，便于测试注入替换。 */
export interface Transport {
  post(url: string, body: unknown, reqId?: string, signal?: AbortSignal): Promise<Response>
  get(url: string): Promise<Response>
}

export class FetchTransport implements Transport {
  post(url: string, body: unknown, reqId?: string, signal?: AbortSignal): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(reqId ? { 'X-Request-Id': reqId } : {}) },
      body: JSON.stringify(body),
      signal,
    })
  }
  get(url: string): Promise<Response> {
    return fetch(url)
  }
}

export class GatewayClient {
  constructor(
    private readonly config: AppConfig,
    private readonly transport: Transport = new FetchTransport(),
  ) {}

  private endpoint(path: string): string {
    return this.config.gatewayUrl.replace(/\/+$/, '') + path
  }

  async chat(req: ChatRequest, reqId?: string): Promise<ChatTurn> {
    const res = await this.transport.post(this.endpoint('/v1/chat/completions'), req, reqId)
    if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    const c = data.choices?.[0]
    return { content: c?.message?.content ?? '', finishReason: c?.finish_reason }
  }

  async models(): Promise<string[]> {
    const res = await this.transport.get(this.endpoint('/v1/models'))
    if (!res.ok) throw new Error(`gateway ${res.status}`)
    const data = (await res.json()) as { data?: { id: string }[] }
    return (data.data ?? []).map((m) => m.id)
  }

  /** 流式对话：SSE 逐段回调 content；累积 tool_calls（按 index 合并）后 onToolCalls。 */
  async chatStream(
    req: ChatRequest,
    h: StreamHandlers,
    opts: { reqId?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    const res = await this.transport.post(
      this.endpoint('/v1/chat/completions'),
      { ...req, stream: true },
      opts.reqId,
      opts.signal,
    )
    if (!res.ok || !res.body) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const byIndex = new Map<number, { id: string; name: string; args: string }>()
    let finish = ''
    for (;;) {
      if (opts.signal?.aborted) throw new Error('cancelled')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let ev: {
          choices?: {
            delta?: { content?: string; reasoning_content?: string; tool_calls?: any[] }
            finish_reason?: string
          }[]
        }
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }
        const ch = ev.choices?.[0]
        if (!ch) continue
        if (ch.delta?.content) h.onContent(ch.delta.content)
        if (ch.delta?.reasoning_content) h.onReasoning?.(ch.delta.reasoning_content)
        for (const tc of ch.delta?.tool_calls ?? []) {
          const slot = byIndex.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          slot.args += tc.function?.arguments ?? ''
          byIndex.set(tc.index, slot)
        }
        if (ch.finish_reason) finish = ch.finish_reason
      }
    }
    if (byIndex.size > 0) {
      h.onToolCalls?.(
        [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => ({
          id: s.id,
          type: 'function',
          function: { name: s.name, arguments: s.args },
        })),
      )
    }
    h.onFinish?.(finish || undefined)
  }
}
