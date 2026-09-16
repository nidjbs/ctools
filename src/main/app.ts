// 组合根：组装 config + registry + 内置命令 + ctx。不依赖 electron，可单测。
import { Registry } from './registry'
import { GatewayClient } from './gatewayClient'
import { MacSystem } from './system'
import { loadConfig } from './config'
import { join } from 'node:path'
import type { AppConfig, Ctx } from '../shared/types'
import { trans } from '../../commands/trans'
import { findFile } from '../../commands/find_file'
import { fileRead, fileList, fileWrite, fileRm } from '../../commands/file'
import { clipboardCmd } from '../../commands/clipboard'
import { officeRead } from '../../commands/office'
import { bashCmd } from '../../commands/bash'
import { webSearchCmd } from '../../commands/web_search'
import { rememberCmd, forgetCmd, recallCmd, memoryListCmd } from '../../commands/memory'
import { MemoryStore } from './memory'

export interface App {
  config: AppConfig
  registry: Registry
  ctx: Ctx
}

/** 新增内置命令：注册到这里（或未来从目录按约定扫描）。 */
const builtinCommands = [
  trans,
  findFile,
  fileRead,
  fileList,
  fileWrite,
  fileRm,
  clipboardCmd,
  officeRead,
  bashCmd,
  webSearchCmd,
  rememberCmd,
  forgetCmd,
  recallCmd,
  memoryListCmd,
]

export function createApp(configDir: string): App {
  const config = loadConfig(configDir)
  const ctx: Ctx = {
    config,
    gateway: new GatewayClient(config),
    system: new MacSystem(),
    memory: new MemoryStore(configDir), // userData 下；不进入 file_roots 作用域
    spillDir: join(configDir, 'spill'), // 大工具结果外置（仅读白名单，写仍限 file_roots）
  }
  const registry = new Registry()
  registry.registerAll(builtinCommands)
  registry.syncEnabled(config) // config.enabledCommands 覆盖默认启停
  return { config, registry, ctx }
}
