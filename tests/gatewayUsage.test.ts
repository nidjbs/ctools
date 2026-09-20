// 用量查询（specs/gateway-usage.md）：解析网关的 snake_case 聚合、分类失败、按别名汇总。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { queryUsage, usageReport, type FetchLike } from '../src/main/gatewayUsage'
import { setUsageSink } from '../src/main/gwFile'

const OPTS = {
  adminUrl: 'http://127.0.0.1:8081',
  token: 'tok',
  from: new Date('2026-09-20T00:00:00Z'),
  to: new Date('2026-09-21T00:00:00Z'),
}

const summary = (over: Record<string, number> = {}) => ({
  requests: 3,
  successes: 3,
  failures: 0,
  streaming: 2,
  input_tokens: 120,
  output_tokens: 80,
  total_tokens: 200,
  cost_micros: 12345,
  duration_ms: 900,
  ...over,
})

function fetchOnce(body: unknown, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status })
}

describe('queryUsage', () => {
  it('解析 snake_case 聚合（含成本）', async () => {
    const r = await queryUsage(OPTS, fetchOnce(summary()))
    expect(r).toEqual({
      ok: true,
      total: {
        requests: 3,
        successes: 3,
        failures: 0,
        streaming: 2,
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        costMicros: 12345,
        durationMs: 900,
      },
      byAlias: [],
    })
  })

  it('带上 from/to（RFC3339）与 Bearer token', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const spy: FetchLike = async (url, init) => {
      seenUrl = url
      seenAuth = init?.headers?.Authorization ?? ''
      return new Response(JSON.stringify(summary()), { status: 200 })
    }
    await queryUsage({ ...OPTS, alias: 'trans' }, spy)
    expect(seenUrl).toContain('/admin/usage/summary')
    expect(seenUrl).toContain('from=2026-09-20T00%3A00%3A00.000Z')
    expect(seenUrl).toContain('alias=trans')
    expect(seenAuth).toBe('Bearer tok')
  })

  it('501 → unsupported，并给出「要启用什么」而不是笼统失败', async () => {
    const r = await queryUsage(OPTS, fetchOnce({ error: 'x' }, 501))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unsupported')
      expect(r.message).toContain('用量存储')
    }
  })

  it('401/403 → auth，指到 admin token', async () => {
    for (const s of [401, 403]) {
      const r = await queryUsage(OPTS, fetchOnce({}, s))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe('auth')
        expect(r.message).toContain('admin token')
      }
    }
  })

  it('连不上 → error 且带原因（不抛）', async () => {
    const r = await queryUsage(OPTS, async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('连不上网关')
  })

  it('响应非 JSON → error，不显示假数据', async () => {
    const r = await queryUsage(OPTS, async () => new Response('not json', { status: 200 }))
    expect(r.ok).toBe(false)
  })
})

describe('usageReport', () => {
  it('按别名逐个查询，只列有请求的，且按 token 降序', async () => {
    const byAlias: Record<string, number> = { chat: 500, trans: 900, idle: 0 }
    const spy: FetchLike = async (url) => {
      const alias = new URL(url).searchParams.get('alias')
      if (!alias) return new Response(JSON.stringify(summary({ total_tokens: 1400 })), { status: 200 })
      const tokens = byAlias[alias] ?? 0
      return new Response(JSON.stringify(summary({ requests: tokens > 0 ? 2 : 0, total_tokens: tokens })), { status: 200 })
    }
    const r = await usageReport(OPTS, ['chat', 'trans', 'idle'], spy)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.total.totalTokens).toBe(1400)
      expect(r.byAlias.map((a) => a.alias)).toEqual(['trans', 'chat']) // idle 无请求被略过
    }
  })

  it('总量查询失败（如 501）就不再去查明细', async () => {
    let calls = 0
    const r = await usageReport(OPTS, ['a', 'b'], async () => {
      calls++
      return new Response('{}', { status: 501 })
    })
    expect(r.ok).toBe(false)
    expect(calls).toBe(1)
  })
})

describe('setUsageSink（启用可查询的用量存储）', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctools-usage-'))
    file = join(dir, 'gateway.yaml')
    writeFileSync(file, 'listen: 127.0.0.1:8080\nproviders:\n  ds:\n    type: openai\n    base_url: http://x\naliases: {}\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('写入 sqlite sink 且不动其它键', () => {
    const r = setUsageSink(file, '/tmp/usage.db')
    expect(r.ok).toBe(true)
    const doc = load(readFileSync(file, 'utf-8')) as Record<string, any>
    expect(doc.usage).toEqual({ driver: 'sqlite', options: { path: '/tmp/usage.db' } })
    expect(doc.listen).toBe('127.0.0.1:8080')
    expect(doc.providers.ds.base_url).toBe('http://x')
    expect(r.backup).toBeTruthy()
  })

  it('传 null 可关闭', () => {
    setUsageSink(file, '/tmp/usage.db')
    setUsageSink(file, null)
    expect((load(readFileSync(file, 'utf-8')) as Record<string, unknown>).usage).toBeUndefined()
  })

  it('现有配置损坏 → 拒绝写入', () => {
    writeFileSync(file, 'providers: [broken\n')
    expect(setUsageSink(file, '/tmp/u.db').ok).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe('providers: [broken\n')
  })
})
