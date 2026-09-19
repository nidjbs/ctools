// cTools 自持 gateway 配置（specs/gateway-config.md）：首启迁移 / admin 块注入 / 地址由 cTools 决定。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { ensureGatewayConfig, managedConfigPath, ADMIN_TOKEN_ENV } from '../src/main/gatewayHome'

let dir: string
let src: string

const USER_GW = `listen: 127.0.0.1:8080
healthz: 127.0.0.1:8081
auth:
  mode: none
providers:
  ds:
    type: openai
    base_url: https://api.deepseek.com
aliases:
  common:
    provider: ds
    model: deepseek-v4-flash
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-gwhome-'))
  src = join(dir, 'user-gw.yaml')
  writeFileSync(src, USER_GW)
  process.env.GW_GATEWAY_CONFIG = src
})
afterAll(() => {
  delete process.env.GW_GATEWAY_CONFIG
  rmSync(dir, { recursive: true, force: true })
})

const read = (p: string) => load(readFileSync(p, 'utf-8')) as Record<string, any>

describe('ensureGatewayConfig', () => {
  it('首次运行：从用户既有 gw 配置迁移 providers/aliases（不丢他已有的模型）', () => {
    const r = ensureGatewayConfig(dir, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    expect(r.created).toBe(true)
    expect(r.migratedFrom).toBe(src)
    const doc = read(r.path)
    expect(doc.providers.ds.base_url).toBe('https://api.deepseek.com')
    expect(doc.aliases.common.model).toBe('deepseek-v4-flash')
  })

  it('注入 cTools 自己的 admin 块：token 走环境变量名，不写 token 值', () => {
    const r = ensureGatewayConfig(dir, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    const doc = read(r.path)
    expect(doc.admin).toEqual({ enabled: true, token_env: ADMIN_TOKEN_ENV })
    // 配置文件里绝不出现 token 值本身
    expect(JSON.stringify(doc.admin)).not.toMatch(/[0-9a-f]{32}/)
  })

  it('覆盖 gw up 注入的旧 admin 块（避免指向 gw 的环境变量）', () => {
    const p = managedConfigPath(dir)
    writeFileSync(p, `providers: {}\naliases: {}\nadmin:\n  enabled: true\n  token_env: GW_ADMIN_TOKEN\n`)
    ensureGatewayConfig(dir, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    expect(read(p).admin.token_env).toBe(ADMIN_TOKEN_ENV)
  })

  it('listen / healthz 由 cTools 决定（与客户端连的地址保持一致）', () => {
    const r = ensureGatewayConfig(dir, { listen: '127.0.0.1:9090', healthz: '127.0.0.1:9091' })
    const doc = read(r.path)
    expect(doc.listen).toBe('127.0.0.1:9090')
    expect(doc.healthz).toBe('127.0.0.1:9091')
  })

  it('已存在则不迁移、不覆盖用户改动', () => {
    const p = managedConfigPath(dir)
    writeFileSync(p, `providers:\n  mine:\n    type: openai\n    base_url: http://mine\naliases: {}\n`)
    const r = ensureGatewayConfig(dir, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    expect(r.created).toBe(false)
    expect(r.migratedFrom).toBeUndefined()
    expect(read(p).providers.mine.base_url).toBe('http://mine')
  })

  it('无可迁移来源 → 写空模板（providers/aliases 为空，不编造上游）', () => {
    process.env.GW_GATEWAY_CONFIG = join(dir, 'nope.yaml') // 不存在 → 跳过
    const isolated = mkdtempSync(join(tmpdir(), 'ctools-gwhome2-'))
    try {
      // 迁移来源里还有 ~/gw.yaml；用一个不可能存在的 HOME 隔离掉
      const oldHome = process.env.HOME
      process.env.HOME = join(dir, 'no-such-home')
      const r = ensureGatewayConfig(isolated, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
      process.env.HOME = oldHome
      const doc = read(r.path)
      expect(doc.providers).toEqual({})
      expect(doc.aliases).toEqual({})
      expect(doc.admin.enabled).toBe(true)
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('现有配置损坏 → 返回 error，不覆盖', () => {
    const p = managedConfigPath(dir)
    writeFileSync(p, 'providers: [broken\n')
    const r = ensureGatewayConfig(dir, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    expect(r.error).toContain('无法解析')
    expect(readFileSync(p, 'utf-8')).toBe('providers: [broken\n')
  })

  it('目标目录不存在也能创建', () => {
    const fresh = join(dir, 'nested', 'deep')
    const r = ensureGatewayConfig(fresh, { listen: '127.0.0.1:8080', healthz: '127.0.0.1:8081' })
    expect(existsSync(r.path)).toBe(true)
  })
})
