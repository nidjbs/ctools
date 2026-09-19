// 网关配置读写（specs/gateway-config.md）：只替换 providers/aliases，保留其余键；校验；备份；原子写。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { readGwFile, writeGwFile, validateGwConfig, normalizeProviders } from '../src/main/gwFile'

let dir: string
let file: string

const SAMPLE = `# 说明性注释（往返后会丢）
listen: 127.0.0.1:8080
healthz: 127.0.0.1:8081
auth:
  mode: none

providers:
  ds:
    type: openai
    base_url: https://api.deepseek.com
    request_timeout: 60s
    api_key_env: DEEPSEEK_API_KEY

aliases:
  common:
    provider: ds
    model: deepseek-v4-flash
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-gw-'))
  file = join(dir, 'gw.yaml')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readGwFile', () => {
  it('解析出 providers / aliases', () => {
    writeFileSync(file, SAMPLE)
    const v = readGwFile(file)
    expect(v.exists).toBe(true)
    expect(v.error).toBeUndefined()
    expect(Object.keys(v.providers)).toEqual(['ds'])
    expect(v.providers.ds.base_url).toBe('https://api.deepseek.com')
    expect(v.providers.ds.api_key_env).toBe('DEEPSEEK_API_KEY')
    expect(v.aliases.common).toEqual({ provider: 'ds', model: 'deepseek-v4-flash' })
  })

  it('文件不存在 → exists:false 且带原因（编辑区据此禁用）', () => {
    const v = readGwFile(join(dir, 'nope.yaml'))
    expect(v.exists).toBe(false)
    expect(v.error).toContain('不存在')
  })

  it('YAML 损坏 → 不抛，以 error 呈现', () => {
    writeFileSync(file, 'providers:\n  ds: [unclosed\n')
    const v = readGwFile(file)
    expect(v.error).toContain('YAML')
    expect(v.providers).toEqual({})
  })
})

describe('normalizeProviders', () => {
  it('type 缺省 openai；空字段不写回', () => {
    const p = normalizeProviders({ a: { base_url: 'http://x' }, b: { type: 'ollama', base_url: 'http://y', api_key_env: '' } })
    expect(p.a.type).toBe('openai')
    expect(p.b.type).toBe('ollama')
    expect('api_key_env' in p.b).toBe(false) // 空串视为未设置
  })
})

describe('validateGwConfig', () => {
  const ok = { providers: { ds: { type: 'openai', base_url: 'http://x' } }, aliases: { a: { provider: 'ds', model: 'm' } } }

  it('合法 → null', () => {
    expect(validateGwConfig(ok)).toBeNull()
  })

  it('上游缺 base_url → 报错并指名', () => {
    expect(validateGwConfig({ ...ok, providers: { ds: { type: 'openai', base_url: '  ' } } })).toContain('ds')
  })

  it('别名指向不存在的上游 → 报错并指名（防悬空引用）', () => {
    const bad = { ...ok, aliases: { a: { provider: 'nope', model: 'm' } } }
    expect(validateGwConfig(bad)).toContain('不存在的上游')
  })

  it('别名缺 model / 缺 provider → 报错', () => {
    expect(validateGwConfig({ ...ok, aliases: { a: { provider: 'ds', model: '' } } })).toContain('model')
    expect(validateGwConfig({ ...ok, aliases: { a: { provider: '', model: 'm' } } })).toContain('上游')
  })
})

describe('writeGwFile', () => {
  it('只替换 providers/aliases：listen/auth 等未知键原样保留', () => {
    writeFileSync(file, SAMPLE)
    const r = writeGwFile(file, {
      providers: { ollama: { type: 'openai', base_url: 'http://localhost:11434/v1' } },
      aliases: { trans: { provider: 'ollama', model: 'hy-mt1.5' } },
    })
    expect(r.ok).toBe(true)
    const doc = load(readFileSync(file, 'utf-8')) as Record<string, unknown>
    expect(doc.listen).toBe('127.0.0.1:8080')
    expect(doc.healthz).toBe('127.0.0.1:8081')
    expect(doc.auth).toEqual({ mode: 'none' })
    expect(Object.keys(doc.providers as object)).toEqual(['ollama'])
    expect((doc.aliases as Record<string, { model: string }>).trans.model).toBe('hy-mt1.5')
  })

  it('写入前备份原文件', () => {
    writeFileSync(file, SAMPLE)
    const r = writeGwFile(file, { providers: { ds: { type: 'openai', base_url: 'http://x' } }, aliases: {} })
    expect(r.ok).toBe(true)
    expect(r.backup).toBeTruthy()
    expect(readFileSync(r.backup!, 'utf-8')).toBe(SAMPLE) // 备份是原文（含注释）
  })

  it('备份只保留最近若干份，不无限堆积', () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(file, SAMPLE)
      writeGwFile(file, { providers: { ds: { type: 'openai', base_url: 'http://x' } }, aliases: {} })
    }
    const baks = readdirSync(dir).filter((f) => f.includes('.bak-'))
    expect(baks.length).toBeLessThanOrEqual(5)
  })

  it('校验不过 → 不写盘、不备份', () => {
    writeFileSync(file, SAMPLE)
    const r = writeGwFile(file, { providers: {}, aliases: { a: { provider: 'ghost', model: 'm' } } })
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe(SAMPLE)
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(0)
  })

  it('现有文件损坏 → 拒绝写入（不拿坏文件当基线）', () => {
    writeFileSync(file, 'providers: [broken\n')
    const r = writeGwFile(file, { providers: {}, aliases: {} })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('拒绝')
  })

  it('文件不存在 → 直接创建（首次写）', () => {
    const r = writeGwFile(file, { providers: { ds: { type: 'openai', base_url: 'http://x' } }, aliases: {} })
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(r.backup).toBeUndefined() // 无原文件可备份
  })

  it('不残留临时文件（原子写用 rename）', () => {
    writeFileSync(file, SAMPLE)
    writeGwFile(file, { providers: { ds: { type: 'openai', base_url: 'http://x' } }, aliases: {} })
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0)
  })
})
