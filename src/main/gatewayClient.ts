// 流式 LLM 客户端 —— cTools 到本地模型网关（go-ai-gateway）的唯一模型出口。
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

/** 失败分类：决定「能不能重试」以及给用户看什么话。 */
export type GatewayErrorKind =
  | 'unreachable' // 连不上（进程没起、端口不通、DNS）
  | 'timeout'
  | 'auth' // 401/403
  | 'not_found' // 404（模型/别名不存在）
  | 'bad_request' // 400/422（参数问题，重试无意义）
  | 'server' // 5xx
  | 'unknown'

export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
  /** 只有「可能自愈」的失败才值得重试；参数/鉴权问题重试多少次都一样。 */
  get retryable(): boolean {
    return this.kind === 'unreachable' || this.kind === 'timeout' || this.kind === 'server'
  }
}

/** 把任意失败整理成分类错误 + 可操作的中文说明。 */
export function classifyGatewayError(e: unknown, status?: number): GatewayError {
  const msg = (e as Error)?.message ?? String(e)
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
  if (status !== undefined) {
    if (status === 401 || status === 403) return new GatewayError('auth', '网关鉴权失败（token 无效或缺失）', status)
    if (status === 404) return new GatewayError('not_found', '网关找不到该资源（模型别名可能不存在）', status)
    if (status === 400 || status === 422) return new GatewayError('bad_request', `请求被网关拒绝：${msg}`, status)
    if (status >= 500) return new GatewayError('server', `网关内部错误（HTTP ${status}）`, status)
    return new GatewayError('unknown', `网关返回 HTTP ${status}：${msg}`, status)
  }
  const name = (e as Error)?.name
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') {
    return new GatewayError('timeout', '请求超时')
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return new GatewayError('unreachable', '连不上本地模型网关（它可能没在运行）')
  }
  if (/fetch failed|network|socket/i.test(msg)) {
    return new GatewayError('unreachable', '连不上本地模型网关（它可能没在运行）')
  }
  return new GatewayError('unknown', msg)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 幂等请求的重试退避：指数 + 抖动，仅对 retryable 的失败。
 * **不要**用于流式请求——首个 chunk 到达后可能已产生副作用或计费。
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 300): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const err = e instanceof GatewayError ? e : classifyGatewayError(e)
      if (!err.retryable || i === attempts - 1) throw err
      // 抖动避免多个请求同时重试打崩刚起来的网关
      const backoff = baseMs * 2 ** i * (0.7 + Math.random() * 0.6)
      await sleep(Math.round(backoff))
    }
  }
  throw last
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

  /** 非流式对话（幂等）→ 失败可重试。 */
  async chat(req: ChatRequest, reqId?: string): Promise<ChatTurn> {
    return withRetry(async () => {
      let res: Response
      try {
        res = await this.transport.post(this.endpoint('/v1/chat/completions'), req, reqId)
      } catch (e) {
        throw classifyGatewayError(e)
      }
      if (!res.ok) throw classifyGatewayError(new Error((await res.text()).slice(0, 200)), res.status)
      const data = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[]
      }
      const c = data.choices?.[0]
      return { content: c?.message?.content ?? '', finishReason: c?.finish_reason }
    })
  }

  /** 列出别名（幂等）→ 失败可重试。 */
  async models(): Promise<string[]> {
    return withRetry(async () => {
      let res: Response
      try {
        res = await this.transport.get(this.endpoint('/v1/models'))
      } catch (e) {
        throw classifyGatewayError(e)
      }
      if (!res.ok) throw classifyGatewayError(new Error(`HTTP ${res.status}`), res.status)
      const data = (await res.json()) as { data?: { id: string }[] }
      return (data.data ?? []).map((m) => m.id)
    })
  }

  /** 流式对话：SSE 逐段回调 content；累积 tool_calls（按 index 合并）后 onToolCalls。 */
  async chatStream(
    req: ChatRequest,
    h: StreamHandlers,
    opts: { reqId?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    // 流式**不重试**：首个 chunk 到达后就可能已有副作用/计费，重放不安全
    let res: Response
    try {
      res = await this.transport.post(
        this.endpoint('/v1/chat/completions'),
        { ...req, stream: true },
        opts.reqId,
        opts.signal,
      )
    } catch (e) {
      // 取消判定必须**先于**分类：我们主动 abort 时，抛出的 AbortError 会被 classify 归成
      // 'timeout'，而 ChatManager 依赖 `cancelled` 区分「用户取消」与「真失败」——否则取消会被
      // 当成错误抛出并落 agent.error（曾因此让「关窗中止」变成界面报错）。
      if (opts.signal?.aborted) throw new Error('cancelled')
      throw classifyGatewayError(e)
    }
    if (!res.ok || !res.body) throw classifyGatewayError(new Error((await res.text()).slice(0, 200)), res.status)
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
