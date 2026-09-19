// cTools 自持的 gateway 运行时配置（specs/gateway-config.md）。
// 位置：<userData>/gateway.yaml —— 不再依赖 gw CLI 的 ~/.config/gw/gateway.yaml。
// 首次运行：能从用户既有的 gw 配置迁移就迁移（不丢他已有的 providers/aliases），否则写空模板。
// admin 块由 cTools 自己注入：token 走**环境变量**，配置文件里只出现变量名。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'

/** cTools 注入给 gateway 子进程的 admin token 环境变量名（配置里只写这个名字）。 */
export const ADMIN_TOKEN_ENV = 'CTOOLS_GATEWAY_ADMIN_TOKEN'

/** 迁移来源（按优先级）：用户手写的 gw.yaml → gw up 生成的运行时配置。 */
export function migrationSources(): string[] {
  const out: string[] = []
  if (process.env.GW_GATEWAY_CONFIG) out.push(process.env.GW_GATEWAY_CONFIG)
  out.push(join(homedir(), 'gw.yaml'))
  out.push(join(homedir(), '.config', 'gw', 'gateway.yaml'))
  return out
}

export function managedConfigPath(userDataDir: string): string {
  return join(userDataDir, 'gateway.yaml')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export interface EnsureResult {
  path: string
  /** 是否为本次新建。 */
  created: boolean
  /** 迁移来源（未迁移则 undefined）。 */
  migratedFrom?: string
  error?: string
}

/**
 * 保证 <userData>/gateway.yaml 存在且带 cTools 的 admin 块。
 * `listen` / `healthz` 由 cTools 的 AppConfig 决定（保证与客户端连的地址一致）。
 */
export function ensureGatewayConfig(
  userDataDir: string,
  opts: { listen: string; healthz: string },
): EnsureResult {
  const path = managedConfigPath(userDataDir)
  mkdirSync(dirname(path), { recursive: true })

  let doc: Record<string, unknown> = {}
  let created = false
  let migratedFrom: string | undefined

  if (existsSync(path)) {
    try {
      doc = asRecord(load(readFileSync(path, 'utf-8')))
    } catch (e) {
      return { path, created: false, error: `现有配置无法解析：${(e as Error).message}` }
    }
  } else {
    created = true
    // 首次：从用户既有的 gw 配置迁移（保留他的 providers/aliases），找不到就留空模板
    for (const src of migrationSources()) {
      if (!existsSync(src)) continue
      try {
        doc = asRecord(load(readFileSync(src, 'utf-8')))
        migratedFrom = src
        break
      } catch {
        /* 源不可解析则试下一个 */
      }
    }
  }

  const next: Record<string, unknown> = {
    ...doc,
    listen: opts.listen,
    healthz: opts.healthz,
    providers: doc.providers ?? {},
    aliases: doc.aliases ?? {},
    admin: { enabled: true, token_env: ADMIN_TOKEN_ENV }, // 覆盖 gw 注入的旧 admin 块
  }
  try {
    writeFileSync(path, dump(next, { lineWidth: 120, noRefs: true }), 'utf-8')
  } catch (e) {
    return { path, created, error: `写入失败：${(e as Error).message}` }
  }
  return { path, created, ...(migratedFrom ? { migratedFrom } : {}) }
}
