// 应用配置读写。纯函数，目录注入，不依赖 electron —— 可单测。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

export function defaultConfig(): AppConfig {
  return {
    gatewayUrl: 'http://127.0.0.1:8080',
    adminUrl: 'http://127.0.0.1:8081',
    adminToken: '',
    defaultAlias: 'chat',
    clipboardLocalAlias: '',
    fileRoots: [],
    writeConfirm: 'auto',
    hotkey: 'CommandOrControl+Shift+Space',
    managedGateway: false,
    webSearchEnabled: false,
    bashNetwork: false,
    enabledCommands: {},
  }
}

export function configFilePath(dir: string): string {
  return join(dir, 'config.json')
}

export function loadConfig(dir: string): AppConfig {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(dir), 'utf-8')) as Partial<AppConfig>
    return { ...defaultConfig(), ...raw }
  } catch {
    return defaultConfig()
  }
}

export function saveConfig(dir: string, cfg: AppConfig): AppConfig {
  mkdirSync(dir, { recursive: true })
  writeFileSync(configFilePath(dir), JSON.stringify(cfg, null, 2), 'utf-8')
  return cfg
}
