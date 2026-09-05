// Gateway 生命周期：探测 / 拉起 / 热更 / 重启。见 docs/architecture.md §6 / §9.5。
// 进程编排委托给 gw CLI（gw up/down 负责二进制定位、config admin 注入、写 cli 配置与
// pid/log 状态）；cTools 只做 readyz 探测与 admin HTTP 热更。依赖注入可单测。
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

export interface ExecResult {
  code: number
  out: string
  err: string
}
type Exec = (file: string, args: string[]) => Promise<ExecResult>
type Probe = (url: string) => Promise<boolean>
type Post = (url: string, token: string) => Promise<{ ok: boolean; body: string }>

export interface GatewayManagerDeps {
  exec?: Exec
  probe?: Probe
  post?: Post
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const defaultExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1
        resolve({ code, out: String(stdout), err: String(stderr || err.message) })
      } else resolve({ code: 0, out: String(stdout), err: String(stderr) })
    })
  })

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
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    return { ok: res.ok, body: await res.text() }
  } catch (e) {
    return { ok: false, body: String((e as Error)?.message ?? e) }
  }
}

export class GatewayManager {
  private lastErr: string | null = null
  private readonly exec: Exec
  private readonly probe: Probe
  private readonly post: Post

  constructor(private readonly config: AppConfig, private readonly stateDir: string, deps: GatewayManagerDeps = {}) {
    this.exec = deps.exec ?? defaultExec
    this.probe = deps.probe ?? defaultProbe
    this.post = deps.post ?? defaultPost
  }

  /** gw CLI 可执行名/路径（GW_GATEWAY_CLI 覆盖，默认 PATH 里的 gw）。 */
  private cli(): string {
    return process.env.GW_GATEWAY_CLI || 'gw'
  }

  /** gateway 配置：GW_GATEWAY_CONFIG 优先，缺省 ~/gw.yaml（gw up 同款解析）。 */
  private gwConfigPath(): string {
    return process.env.GW_GATEWAY_CONFIG || join(homedir(), 'gw.yaml')
  }

  /** 最近一次失败原因（供 UI 展示）。 */
  lastError(): string | null {
    return this.lastErr
  }

  async status(): Promise<'running' | 'stopped'> {
    return (await this.probe(this.config.adminUrl)) ? 'running' : 'stopped'
  }

  private async runCli(args: string[]): Promise<boolean> {
    const r = await this.exec(this.cli(), args)
    this.lastErr = r.code !== 0 ? `gw ${args.join(' ')}: ${(r.err || r.out).trim()}` : null
    return r.code === 0
  }

  /** 未就绪则 `gw up` 拉起并等待 ready；gw/config 不可用时保持 stopped（不阻塞启动）。 */
  async ensureStarted(): Promise<'running' | 'stopped'> {
    if ((await this.status()) === 'running') return 'running'
    if (!(await this.runCli(['up', this.gwConfigPath()]))) return 'stopped'
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && (await this.status()) !== 'running') await sleep(300)
    return this.status()
  }

  /** 停止（"未在运行"也视为成功）。 */
  async down(): Promise<void> {
    await this.runCli(['down'])
  }

  /** 热更：POST {adminUrl}/admin/reload（Bearer admin token）。 */
  async reload(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post(`${this.config.adminUrl}/admin/reload`, this.config.adminToken ?? '')
    if (!res.ok) this.lastErr = res.body
    return { ok: res.ok, error: res.ok ? undefined : res.body }
  }

  /** 重启 = down + up（面向 gw 托管的实例；外部进程需自行管理）。 */
  async restart(): Promise<'running' | 'stopped'> {
    await this.down()
    return this.ensureStarted()
  }
}
