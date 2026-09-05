// CommandRegistry —— 一切能力 = 一个 Command。悬浮联想 / agent 工具 / 设置页都读它。
// 启停：命令自带默认 enabled；设置页写入 config.enabledCommands 后 syncEnabled 以覆盖为准
// （覆盖存注册表实例内，不改命令模块单例，避免跨测试/跨实例污染）。
import type { Command, CommandMeta, CommandResult, Ctx } from '../shared/types'

export class Registry {
  private cmds = new Map<string, Command>()
  private overrides = new Map<string, boolean>()

  register(cmd: Command): this {
    this.cmds.set(cmd.id, cmd)
    return this
  }

  registerAll(cmds: Command[]): this {
    for (const c of cmds) this.register(c)
    return this
  }

  get(id: string): Command | undefined {
    return this.cmds.get(id)
  }

  /** 原始命令（含已禁用），供 Settings 列表用。 */
  all(): Command[] {
    return [...this.cmds.values()]
  }

  /** 用 config.enabledCommands 覆盖默认启停（无覆盖则保留命令默认值）。 */
  syncEnabled(cfg: { enabledCommands?: Record<string, boolean> }): this {
    this.overrides.clear()
    for (const [id, on] of Object.entries(cfg.enabledCommands ?? {})) this.overrides.set(id, !!on)
    return this
  }

  private isOn(c: Command): boolean {
    const v = this.overrides.get(c.id)
    return v === undefined ? c.enabled : v
  }

  list(enabledOnly = true): CommandMeta[] {
    return this.all()
      .filter((c) => !enabledOnly || this.isOn(c))
      .map((c) => this.meta(c))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 按 id 取启用命令的元数据（供 MRU 等按引用渲染）。 */
  metaFor(id: string): CommandMeta | undefined {
    const c = this.cmds.get(id)
    return c && this.isOn(c) ? this.meta(c) : undefined
  }

  /** agent 可用作工具的 command 名集合（agentTool: true 且启用）。 */
  toolIds(): string[] {
    return this.all()
      .filter((c) => this.isOn(c) && c.agentTool)
      .map((c) => c.id)
  }

  /** 悬浮框输入联想：命令+参数首词命中 > 前缀命中 > 包含命中。 */
  match(input: string): CommandMeta[] {
    const q = input.trim().toLowerCase().replace(/^\//, '')
    if (!q) return []
    // "命令 + 参数"：首词完整等于某命令 id/alias 时保留该命令（参数由 Enter 侧剥离）。
    const space = q.indexOf(' ')
    if (space > 0) {
      const head = q.slice(0, space)
      for (const c of this.cmds.values()) {
        if (!this.isOn(c)) continue
        const names = [c.id, ...c.aliases].map((s) => s.toLowerCase())
        if (names.includes(head)) return [this.meta(c)]
      }
    }
    const hit: Array<[Command, number]> = []
    for (const c of this.cmds.values()) {
      if (!this.isOn(c)) continue
      const names = [c.id, ...c.aliases].map((s) => s.toLowerCase())
      if (names.some((n) => n.startsWith(q))) hit.push([c, 2])
      else if (names.some((n) => n.includes(q))) hit.push([c, 1])
    }
    hit.sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id))
    return hit.map(([c]) => this.meta(c))
  }

  async run(id: string, input: string, ctx: Ctx): Promise<CommandResult> {
    const cmd = this.get(id)
    if (!cmd) throw new Error(`unknown command: ${id}`)
    if (!this.isOn(cmd)) throw new Error(`command disabled: ${id}`)
    return cmd.run(input, ctx)
  }

  private meta(c: Command): CommandMeta {
    return { id: c.id, title: c.title, aliases: c.aliases, kind: c.kind, agentTool: c.agentTool, enabled: this.isOn(c) }
  }
}
