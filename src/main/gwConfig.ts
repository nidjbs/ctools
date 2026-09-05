// 从本地 gw CLI 配置引导 cTools（gateway URL / 默认别名 / token），并校准默认别名。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, Ctx } from '../shared/types'

/** 读取 gw 的 CLI 配置 (~/.config/gw/config.yaml 或 $GW_CONFIG)。 */
export function readGwConfig(): Partial<AppConfig> | null {
  const path = process.env.GW_CONFIG || join(homedir(), '.config', 'gw', 'config.yaml')
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const pick = (key: string): string => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  const out: Partial<AppConfig> = {}
  const gwUrl = pick('gateway_url')
  const admUrl = pick('admin_url')
  const tok = pick('admin_token')
  const alias = pick('default_alias')
  if (gwUrl) out.gatewayUrl = gwUrl
  if (admUrl) out.adminUrl = admUrl
  if (tok) out.adminToken = tok
  if (alias) out.defaultAlias = alias
  return Object.keys(out).length ? out : null
}

/** 首次运行（无 cTools config）时从 gw 引导并持久化；返回是否引导过。 */
export function bootstrapFromGw(configDir: string, config: AppConfig, save: (cfg: AppConfig) => void): boolean {
  if (existsSync(join(configDir, 'config.json'))) return false
  const gw = readGwConfig()
  if (!gw) return false
  Object.assign(config, gw)
  save(config)
  return true
}

/** 把默认别名校准到 gateway 真实存在的别名（取第一个可用），失败则保留原值。 */
export async function reconcileDefaultAlias(ctx: Ctx): Promise<void> {
  try {
    const aliases = await ctx.gateway.models()
    if (aliases.length > 0 && !aliases.includes(ctx.config.defaultAlias)) {
      ctx.config.defaultAlias = aliases[0]
    }
  } catch {
    /* gateway 未就绪：保留原配置 */
  }
}
