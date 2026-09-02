// OpenAI 兼容客户端 —— cTools 到本地 go-ai-gateway 的唯一模型出口。
// 无任何硬编码 URL/别名；全部来自 AppConfig。
import type { AppConfig } from '../shared/types'

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
  post(url: string, body: unknown, reqId?: string): Promise<Response>
  get(url: string): Promise<Response>
}

export class FetchTransport implements Transport {
  post(url: string, body: unknown, reqId?: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(reqId ? { 'X-Request-Id': reqId } : {}) },
      body: JSON.stringify(body),
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
}
