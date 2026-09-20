// 应用配置读写 + 版本迁移。纯函数，目录注入，不依赖 electron —— 可单测。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

/** 当前配置结构版本。**改结构就 +1，并在 MIGRATIONS 里补一步**（否则老配置会缺字段/含义漂移）。 */
export const CONFIG_SCHEMA_VERSION = 1

export function defaultConfig(): AppConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    gatewayUrl: 'http://127.0.0.1:8080',
    adminUrl: 'http://127.0.0.1:8081',
    adminToken: '',
    defaultAlias: 'chat',
    commandModels: {},
    clipboardLocalAlias: '',
    fileRoots: [],
    writeConfirm: 'auto',
    hotkey: 'CommandOrControl+Shift+Space',
    managedGateway: false,
    webSearchEnabled: false,
    bashNetwork: false,
    injectDate: true,
    enabledCommands: {},
  }
}

export function configFilePath(dir: string): string {
  return join(dir, 'config.json')
}

/**
 * 迁移表：`from` 表示「从该版本升上来」。按序应用到最新版。
 *
 * 约定：迁移函数只做**必要的结构变换**，不填业务默认值（那由 defaultConfig + 展开兜底）。
 * 现有 0→1 仅补版本号：0.1.0 之前的配置没有这个字段，语义上没有变化。
 */
export const MIGRATIONS: Array<{ from: number; migrate: (cfg: Record<string, unknown>) => Record<string, unknown> }> = [
  { from: 0, migrate: (cfg) => cfg },
]

/** 把任意版本的配置对象升到当前版本；返回升后的对象与是否发生过迁移。 */
export function migrateConfig(raw: Record<string, unknown>): {
  config: Record<string, unknown>
  migratedFrom: number
} {
  const start = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  let cfg = raw
  let v = start
  for (const step of MIGRATIONS) {
    if (step.from === v && v < CONFIG_SCHEMA_VERSION) {
      cfg = step.migrate(cfg)
      v = step.from + 1
    }
  }
  return { config: { ...cfg, schemaVersion: CONFIG_SCHEMA_VERSION }, migratedFrom: start }
}

/** 载入并迁移；文件缺失/损坏则用默认值。 */
export function loadConfig(dir: string): AppConfig {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configFilePath(dir), 'utf-8')) as Record<string, unknown>
  } catch {
    return defaultConfig()
  }
  const { config } = migrateConfig(raw)
  return { ...defaultConfig(), ...config } as AppConfig
}

export function saveConfig(dir: string, cfg: AppConfig): AppConfig {
  mkdirSync(dir, { recursive: true })
  const next = { ...cfg, schemaVersion: CONFIG_SCHEMA_VERSION }
  writeFileSync(configFilePath(dir), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
