// 网关用量查询（specs/gateway-usage.md）。
// 数据源是网关自己的 /admin/usage/summary —— 它已按 alias/时间聚合，还带成本，
// cTools 不自己算账（自己解析 SSE 既易错又会漏掉网关侧的重试/路由细节）。
import type { GwUsageResult, GwUsageSummary } from '../shared/types'

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>

export interface UsageQueryOpts {
  adminUrl: string
  token: string
  from: Date
  to: Date
  alias?: string
}

const EMPTY: GwUsageSummary = {
  requests: 0,
  successes: 0,
  failures: 0,
  streaming: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costMicros: 0,
  durationMs: 0,
}

/** 网关返回的是 snake_case 扁平结构。 */
function parseSummary(raw: unknown): GwUsageSummary {
  const o = (raw ?? {}) as Record<string, unknown>
  const n = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0)
  return {
    requests: n('requests'),
    successes: n('successes'),
    failures: n('failures'),
    streaming: n('streaming'),
    inputTokens: n('input_tokens'),
    outputTokens: n('output_tokens'),
    totalTokens: n('total_tokens'),
    costMicros: n('cost_micros'),
    durationMs: n('duration_ms'),
  }
}

/** 查一次聚合。失败按可操作的原因分类返回，不抛。 */
export async function queryUsage(opts: UsageQueryOpts, fetchImpl: FetchLike = fetch): Promise<GwUsageResult> {
  const url = new URL(`${opts.adminUrl.replace(/\/+$/, '')}/admin/usage/summary`)
  url.searchParams.set('from', opts.from.toISOString())
  url.searchParams.set('to', opts.to.toISOString())
  if (opts.alias) url.searchParams.set('alias', opts.alias)

  let res: Response
  try {
    res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${opts.token}` } })
  } catch (e) {
    return { ok: false, reason: 'error', message: `连不上网关：${(e as Error).message}` }
  }
  if (res.status === 501) {
    // 网关默认的 audit sink 不可查询 —— 这是最常见的情况，必须给出怎么开
    return {
      ok: false,
      reason: 'unsupported',
      message: '网关未启用可查询的用量存储（当前为 audit sink）。启用后可看到 token 与成本。',
    }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'auth', message: '用量查询需要有效的 admin token（设置 → 连接（高级））' }
  }
  if (!res.ok) return { ok: false, reason: 'error', message: `网关返回 HTTP ${res.status}` }

  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    return { ok: false, reason: 'error', message: `用量响应无法解析：${(e as Error).message}` }
  }
  return { ok: true, total: parseSummary(body), byAlias: [] }
}

/** 汇总区间内的总量与各别名明细。别名列表来自 /v1/models。 */
export async function usageReport(
  opts: Omit<UsageQueryOpts, 'alias'>,
  aliases: string[],
  fetchImpl: FetchLike = fetch,
): Promise<GwUsageResult> {
  const total = await queryUsage(opts, fetchImpl)
  if (!total.ok) return total

  const byAlias: Array<{ alias: string; summary: GwUsageSummary }> = []
  for (const alias of aliases) {
    const r = await queryUsage({ ...opts, alias }, fetchImpl)
    if (r.ok && r.total.requests > 0) byAlias.push({ alias, summary: r.total })
  }
  byAlias.sort((a, b) => b.summary.totalTokens - a.summary.totalTokens)
  return { ok: true, total: total.total, byAlias }
}

export { EMPTY as EMPTY_USAGE }
