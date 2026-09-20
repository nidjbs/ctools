// 配置读写与版本迁移（src/main/config.ts）：老配置缺 schemaVersion 也要能升上来且不丢字段。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_SCHEMA_VERSION,
  MIGRATIONS,
  configFilePath,
  defaultConfig,
  loadConfig,
  migrateConfig,
  saveConfig,
} from '../src/main/config'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-cfg-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('defaultConfig', () => {
  it('带上当前 schemaVersion', () => {
    expect(defaultConfig().schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })
})

describe('migrateConfig', () => {
  it('无 schemaVersion（老配置）→ 视作 0 并升到当前版本', () => {
    const { config, migratedFrom } = migrateConfig({ defaultAlias: 'ds' })
    expect(migratedFrom).toBe(0)
    expect(config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(config.defaultAlias).toBe('ds') // 业务字段不丢
  })

  it('已是当前版本 → 原样通过', () => {
    const { config, migratedFrom } = migrateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, hotkey: 'x' })
    expect(migratedFrom).toBe(CONFIG_SCHEMA_VERSION)
    expect(config.hotkey).toBe('x')
  })

  it('迁移表每一档都能接上（避免漏写一步导致老配置卡住）', () => {
    const froms = MIGRATIONS.map((m) => m.from).sort((a, b) => a - b)
    expect(froms).toEqual(Array.from({ length: CONFIG_SCHEMA_VERSION }, (_, i) => i))
  })
})

describe('loadConfig / saveConfig', () => {
  it('文件不存在 → 默认值', () => {
    expect(loadConfig(dir).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it('文件损坏 → 默认值（不抛）', () => {
    writeFileSync(configFilePath(dir), '{ not json')
    expect(loadConfig(dir).defaultAlias).toBe(defaultConfig().defaultAlias)
  })

  it('载入时自动迁移 + 用默认值补齐缺字段', () => {
    writeFileSync(configFilePath(dir), JSON.stringify({ defaultAlias: 'ds', fileRoots: ['/tmp'] }))
    const c = loadConfig(dir)
    expect(c.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(c.defaultAlias).toBe('ds')
    expect(c.fileRoots).toEqual(['/tmp'])
    expect(c.writeConfirm).toBe('auto') // 缺字段由默认补齐
  })

  it('保存总会写上当前 schemaVersion', () => {
    const saved = saveConfig(dir, { ...defaultConfig(), schemaVersion: undefined, defaultAlias: 'x' })
    expect(saved.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(JSON.parse(readFileSync(configFilePath(dir), 'utf-8')).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })
})
