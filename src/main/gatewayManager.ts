// Gateway 生命周期：直接拉起内嵌的 gateway 二进制（不再经过 gw CLI）。见 specs/gateway-config.md。
// cTools 自己管进程（pid 落 stateDir）、自己管配置（<userData>/gateway.yaml）、自己注入 admin token。
// 依赖注入（spawn/kill/probe/post）便于单测。
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'
import { ADMIN_TOKEN_ENV } from './gatewayHome'
import { readGwFile } from './gwFile'

export interface ExecResult {
  code: number
  out: string
  err: string
}
export type SpawnFn = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => { pid?: number; unref?: () => void }
export type KillFn = (pid: number) => void
type Probe = (url: string) => Promise<boolean>
type Post = (url: string, token: string) => Promise<{ ok: boolean; body: string }>

export interface GatewayManagerDeps {
  spawn?: SpawnFn
  kill?: KillFn
  probe?: Probe
  post?: Post
  /** 等待 readyz 的总时长（测试可调小）。 */
  readyTimeoutMs?: number
}

/** cTools 托管的 gateway 运行时：二进制、配置文件、admin token。 */
export interface GatewayRuntime {
  bin: string
  cfgFile: string
  adminToken: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 默认 spawn：把子进程 stdout/stderr **重定向到日志文件**。
 * 不能用 'ignore' —— gateway 启动失败（如「at least one provider is required」）会只打在自己的
 * stderr 上，丢弃后就只剩「未就绪」这种无法自查的现象。
 */
function makeDefaultSpawn(logPath: string): SpawnFn {
  return (bin, args, env) => {
    let fd: number | undefined
    try {
      fd = openSync(logPath, 'a')
    } catch {
      /* 日志开不了也要能启动 */
    }
    const child: ChildProcess = nodeSpawn(bin, args, {
      env,
      detached: true,
      stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
    })
    if (fd !== undefined) child.once('spawn', () => closeSync(fd!))
    child.unref?.()
    return { pid: child.pid, unref: () => child.unref() }
  }
}

const defaultKill: KillFn = (pid) => {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* 进程已不在 */
  }
}

const defaultProbe: Probe = async (url) => {
  try {
    const res = await fetch(`${url}/readyz`)
    return res.status >= 200 && res.status < 500
  } catch {
    return false
  }
}

const defaultPost: Post = async (url, token) => {
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    return { ok: res.ok, body: await res.text() }
  } catch (e) {
    return { ok: false, body: String((e as Error)?.message ?? e) }
  }
}

export class GatewayManager {
  private lastErr: string | null = null
  private readonly spawnFn: SpawnFn
  private readonly killFn: KillFn
  private readonly probe: Probe
  private readonly post: Post
  private readonly readyTimeoutMs: number

  constructor(
    private readonly config: AppConfig,
    private readonly stateDir: string,
    private readonly rt: GatewayRuntime,
    deps: GatewayManagerDeps = {},
  ) {
    this.spawnFn = deps.spawn ?? makeDefaultSpawn(join(stateDir, 'gateway.log'))
    this.killFn = deps.kill ?? defaultKill
    this.probe = deps.probe ?? defaultProbe
    this.post = deps.post ?? defaultPost
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 15_000
  }

  /** cTools 自持的 gateway 配置文件（配置编辑区指向它）。 */
  gwConfigFile(): string {
    return this.rt.cfgFile
  }

  private pidFile(): string {
    return join(this.stateDir, 'gateway.pid')
  }

  /** 最近一次失败原因（供 UI 展示）。 */
  lastError(): string | null {
    return this.lastErr
  }

  async status(): Promise<'running' | 'stopped'> {
    return (await this.probe(this.config.adminUrl)) ? 'running' : 'stopped'
  }

  /** 未就绪则拉起内嵌 gateway 并等 readyz；二进制缺失/启动失败保持 stopped（不阻塞启动）。 */
  async ensureStarted(): Promise<'running' | 'stopped'> {
    if ((await this.status()) === 'running') return 'running'
    if (!existsSync(this.rt.bin)) {
      this.lastErr = `未找到 gateway 二进制：${this.rt.bin}`
      return 'stopped'
    }
    // gateway 硬要求：零上游直接拒绝启动（"at least one provider is required"）。
    // 与其 spawn 后等超时，不如提前给出可操作的原因。
    const providers = readGwFile(this.rt.cfgFile).providers
    if (Object.keys(providers).length === 0) {
      this.lastErr = '尚未配置模型上游（providers），gateway 未启动。请在「设置 → 网关配置」里添加一个上游。'
      return 'stopped'
    }
    try {
      const { pid } = this.spawnFn(this.rt.bin, ['-config', this.rt.cfgFile], {
        ...process.env,
        [ADMIN_TOKEN_ENV]: this.rt.adminToken, // token 只经环境变量传递，不落配置文件
      })
      if (pid) writeFileSync(this.pidFile(), String(pid), 'utf-8')
    } catch (e) {
      this.lastErr = `启动 gateway 失败：${(e as Error).message}`
      return 'stopped'
    }
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline && (await this.status()) !== 'running') await sleep(300)
    const s = await this.status()
    if (s !== 'running') this.lastErr = 'gateway 启动后未在超时内就绪'
    return s
  }

  /** 停止：按记录的 pid 结束进程（未在运行也视为成功）。 */
  async down(): Promise<void> {
    const f = this.pidFile()
    if (!existsSync(f)) return
    try {
      const pid = Number(readFileSync(f, 'utf-8').trim())
      if (Number.isFinite(pid) && pid > 0) this.killFn(pid)
    } catch {
      /* 忽略 */
    }
    rmSync(f, { force: true })
    // 等端口释放，避免 restart 时旧进程还占着
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && (await this.status()) === 'running') await sleep(200)
  }

  /** 热更：POST {adminUrl}/admin/reload（Bearer admin token）。 */
  async reload(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post(`${this.config.adminUrl}/admin/reload`, this.rt.adminToken)
    if (!res.ok) this.lastErr = res.body
    return { ok: res.ok, error: res.ok ? undefined : res.body }
  }

  /** 重启 = down + up。 */
  async restart(): Promise<'running' | 'stopped'> {
    await this.down()
    return this.ensureStarted()
  }
}
