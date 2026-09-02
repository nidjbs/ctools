// Gateway 生命周期：探测状态 / 未就绪自动拉起 / 停止。见 docs/architecture.md §6。
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

export class GatewayManager {
  constructor(
    private readonly config: AppConfig,
    private readonly stateDir: string,
  ) {}

  private pidFile(): string {
    return join(this.stateDir, 'gateway.pid')
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/readyz`)
      return res.status >= 200 && res.status < 500
    } catch {
      return false
    }
  }

  async status(): Promise<'running' | 'stopped'> {
    return (await this.probe(this.config.adminUrl)) ? 'running' : 'stopped'
  }

  /** 未就绪则用受管配置拉起 gateway（binary 缺失/未配置时保持 stopped）。 */
  async ensureStarted(binary?: string, configPath?: string): Promise<'running' | 'stopped'> {
    if ((await this.status()) === 'running') return 'running'
    if (!binary || !existsSync(binary) || !configPath || !existsSync(configPath)) return 'stopped'
    await this.start(binary, configPath)
    return this.waitUntil('running', 15_000)
  }

  async stop(): Promise<void> {
    try {
      const pid = Number(readFileSync(this.pidFile(), 'utf-8').trim())
      process.kill(pid, 'SIGTERM')
    } catch {
      /* not running */
    }
    rmSync(this.pidFile(), { force: true })
    await this.waitUntil('stopped', 5_000)
  }

  private start(binary: string, configPath: string): void {
    const log = createWriteStream(join(this.stateDir, 'gateway.log'), { flags: 'a' })
    const proc = spawn(binary, ['-config', configPath], {
      stdio: ['ignore', log, log],
      env: { ...process.env, GW_CTOOLS_ADMIN: this.config.adminToken ?? '' },
    })
    writeFileSync(this.pidFile(), String(proc.pid))
  }

  private async waitUntil(want: 'running' | 'stopped', timeoutMs: number): Promise<'running' | 'stopped'> {
    const deadline = Date.now() + timeoutMs
    let status = await this.status()
    while (Date.now() < deadline && status !== want) {
      await new Promise((r) => setTimeout(r, 300))
      status = await this.status()
    }
    return status
  }
}
