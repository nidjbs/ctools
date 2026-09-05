// 组合根：组装 config + registry + 内置命令 + ctx。不依赖 electron，可单测。
import { Registry } from './registry'
import { GatewayClient } from './gatewayClient'
import { MacSystem } from './system'
import { loadConfig } from './config'
import type { AppConfig, Ctx } from '../shared/types'
import { trans } from '../../commands/trans'
import { findFile } from '../../commands/find_file'
import { fileRead, fileList, fileWrite, fileRm } from '../../commands/file'
import { clipboardCmd } from '../../commands/clipboard'
import { officeRead } from '../../commands/office'
import { bashCmd } from '../../commands/bash'

export interface App {
  config: AppConfig
  registry: Registry
  ctx: Ctx
}

/** 新增内置命令：注册到这里（或未来从目录按约定扫描）。 */
const builtinCommands = [trans, findFile, fileRead, fileList, fileWrite, fileRm, clipboardCmd, officeRead, bashCmd]

export function createApp(configDir: string): App {
  const config = loadConfig(configDir)
  const ctx: Ctx = {
    config,
    gateway: new GatewayClient(config),
    system: new MacSystem(),
  }
  const registry = new Registry()
  registry.registerAll(builtinCommands)
  registry.syncEnabled(config) // config.enabledCommands 覆盖默认启停
  return { config, registry, ctx }
}
