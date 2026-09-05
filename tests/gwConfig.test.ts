import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGwConfig, reconcileDefaultAlias } from '../src/main/gwConfig'

describe('gwConfig', () => {
  it('从 gw config.yaml 读取关键字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwcfg-'))
    const p = join(dir, 'config.yaml')
    writeFileSync(
      p,
      '# 注释行\nlisten: 127.0.0.1:8080\ngateway_url: http://127.0.0.1:8080\nadmin_url: http://127.0.0.1:8081\ndefault_alias: common\nadmin_token: "abc123"\n',
    )
    const old = process.env.GW_CONFIG
    process.env.GW_CONFIG = p
    try {
      const gw = readGwConfig()
      expect(gw?.gatewayUrl).toBe('http://127.0.0.1:8080')
      expect(gw?.adminUrl).toBe('http://127.0.0.1:8081')
      expect(gw?.defaultAlias).toBe('common')
      expect(gw?.adminToken).toBe('abc123')
    } finally {
      if (old === undefined) delete process.env.GW_CONFIG
      else process.env.GW_CONFIG = old
    }
  })

  it('默认别名校准到 gateway 真实存在的别名', async () => {
    const config = { defaultAlias: 'chat', gatewayUrl: 'http://m' } as any
    const ctx = { config, gateway: { models: async () => ['common', 'trans'] } } as any
    await reconcileDefaultAlias(ctx)
    expect(config.defaultAlias).toBe('common')
  })
})
