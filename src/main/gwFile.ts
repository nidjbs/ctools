// 网关配置文件的读写（specs/gateway-config.md）。
// 只碰 providers / aliases 两个键：其余键（listen/healthz/auth…）原样保留。
// 写路径 = 校验 → 备份 → 合并 → 再校验 → 原子写。已知代价：YAML 往返会丢注释（有备份可回溯）。
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'

/** 上游（providers 的一项）。`api_key_env` 存的是**环境变量名**，不是密钥。 */
export interface GwProvider {
  type: string
  base_url: string
  request_timeout?: string
  api_key_env?: string
  [k: string]: unknown
}

export interface GwAlias {
  provider: string
  model: string
}

export interface GwConfigView {
  path: string
  exists: boolean
  providers: Record<string, GwProvider>
  aliases: Record<string, GwAlias>
  /** 读/解析失败的原因（存在时编辑区应禁用）。 */
  error?: string
}

export interface GwSaveInput {
  providers: Record<string, GwProvider>
  aliases: Record<string, GwAlias>
}

export interface GwSaveResult {
  ok: boolean
  /** 备份文件路径（成功时）。 */
  backup?: string
  error?: string
}

const BACKUP_KEEP = 5

/** 备份保留最近 N 份，避免长期堆积。 */
function pruneBackups(path: string): void {
  try {
    const dir = dirname(path)
    const prefix = `${path.split('/').pop()}.bak-`
    const olds = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
    for (const f of olds.slice(0, Math.max(0, olds.length - BACKUP_KEEP))) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 目录不可读则跳过清理 */
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

/**
 * 规范化 providers：type 缺省 `openai`；`request_timeout` / `api_key_env` 的**空串视为未设置**
 * （不写回文件，也不在表单里留空字段）；其余未知键原样保留。
 */
export function normalizeProviders(raw: unknown): Record<string, GwProvider> {
  const out: Record<string, GwProvider> = {}
  for (const [name, v] of Object.entries(asRecord(raw))) {
    const { type, base_url, request_timeout, api_key_env, ...rest } = asRecord(v)
    const p: GwProvider = { ...rest, type: str(type) || 'openai', base_url: str(base_url) }
    if (str(request_timeout)) p.request_timeout = str(request_timeout)
    if (str(api_key_env)) p.api_key_env = str(api_key_env)
    out[name] = p
  }
  return out
}

export function normalizeAliases(raw: unknown): Record<string, GwAlias> {
  const out: Record<string, GwAlias> = {}
  for (const [name, v] of Object.entries(asRecord(raw))) {
    const o = asRecord(v)
    out[name] = { provider: str(o.provider), model: str(o.model) }
  }
  return out
}

/** 校验：上游要有 type/base_url；别名必须指向存在的上游且给出 model。 */
export function validateGwConfig(input: GwSaveInput): string | null {
  for (const [name, p] of Object.entries(input.providers)) {
    if (!name.trim()) return '存在未命名的上游'
    if (!p.base_url?.trim()) return `上游「${name}」缺少 base_url`
  }
  for (const [alias, a] of Object.entries(input.aliases)) {
    if (!alias.trim()) return '存在未命名的别名'
    if (!a.provider?.trim()) return `别名「${alias}」未指定上游`
    if (!(a.provider in input.providers)) return `别名「${alias}」指向不存在的上游「${a.provider}」`
    if (!a.model?.trim()) return `别名「${alias}」缺少 model`
  }
  return null
}

/** 读配置文件；解析失败不抛，以 error 呈现（编辑区据此禁用）。 */
export function readGwFile(path: string): GwConfigView {
  if (!existsSync(path)) {
    return { path, exists: false, providers: {}, aliases: {}, error: `配置文件不存在：${path}` }
  }
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    return { path, exists: true, providers: {}, aliases: {}, error: `读取失败：${(e as Error).message}` }
  }
  try {
    const doc = asRecord(load(text))
    return {
      path,
      exists: true,
      providers: normalizeProviders(doc.providers),
      aliases: normalizeAliases(doc.aliases),
    }
  } catch (e) {
    return { path, exists: true, providers: {}, aliases: {}, error: `YAML 解析失败：${(e as Error).message}` }
  }
}

/** 读现有配置为基线；不存在或损坏时返回 null（损坏时不允许覆盖）。 */
function readBase(path: string): { base: Record<string, unknown> } | { error: string } {
  if (!existsSync(path)) return { base: {} }
  try {
    return { base: asRecord(load(readFileSync(path, 'utf-8'))) }
  } catch (e) {
    return { error: `现有配置无法解析，已拒绝写入：${(e as Error).message}` }
  }
}

/** 备份 → 原子写（临时文件 + rename）。 */
function commit(path: string, doc: Record<string, unknown>): GwSaveResult {
  let text: string
  try {
    text = dump(doc, { lineWidth: 120, noRefs: true })
    load(text) // 写前再解析一次，确保产物合法
  } catch (e) {
    return { ok: false, error: `生成配置失败：${(e as Error).message}` }
  }
  let backup: string | undefined
  try {
    if (existsSync(path)) {
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(path, backup)
      pruneBackups(path)
    }
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, text, 'utf-8')
    renameSync(tmp, path) // 原子替换，避免半截文件
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error).message}`, ...(backup ? { backup } : {}) }
  }
  return { ok: true, ...(backup ? { backup } : {}) }
}

/**
 * 在托管配置里启用（或关闭）可查询的用量存储。
 * 网关默认的 audit sink 不支持 /admin/usage/* 查询，只有 sqlite 之类可以。
 */
export function setUsageSink(path: string, dbPath: string | null): GwSaveResult {
  const r = readBase(path)
  if ('error' in r) return { ok: false, error: r.error }
  const next = { ...r.base }
  if (dbPath) next.usage = { driver: 'sqlite', options: { path: dbPath } }
  else delete next.usage
  return commit(path, next)
}

/**
 * 写回 providers / aliases：校验 → 备份 → 合并（保留其余键）→ 再校验 → 原子写。
 * 见 specs/gateway-config.md。
 */
export function writeGwFile(path: string, input: GwSaveInput): GwSaveResult {
  const invalid = validateGwConfig(input)
  if (invalid) return { ok: false, error: invalid }

  // 以磁盘当前内容为基线合并，避免丢掉 listen/auth 等未知键
  const r = readBase(path)
  if ('error' in r) return { ok: false, error: r.error }
  return commit(path, { ...r.base, providers: input.providers, aliases: input.aliases })
}
