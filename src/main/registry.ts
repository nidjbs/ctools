// CommandRegistry —— 一切能力 = 一个 Command。悬浮联想 / agent 工具 / 设置页都读它。
import type { Command, CommandMeta, CommandResult, Ctx } from '../shared/types'

export class Registry {
  private cmds = new Map<string, Command>()

  register(cmd: Command): this {
    this.cmds.set(cmd.id, cmd)
    return this
  }

  registerAll(cmds: Command[]): void {
    for (const c of cmds) this.register(c)
  }

  get(id: string): Command | undefined {
    return this.cmds.get(id)
  }

  list(enabledOnly = true): CommandMeta[] {
    return [...this.cmds.values()]
      .filter((c) => !enabledOnly || c.enabled)
      .map((c) => this.meta(c))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** agent 可用作工具的 command 名集合（agentTool: true 且启用）。 */
  toolIds(): string[] {
    return [...this.cmds.values()].filter((c) => c.enabled && c.agentTool).map((c) => c.id)
  }

  /** 悬浮框输入联想：前缀命中 > 包含命中。 */
  match(input: string): CommandMeta[] {
    const q = input.trim().toLowerCase().replace(/^\//, '')
    if (!q) return []
    const hit: Array<[Command, number]> = []
    for (const c of this.cmds.values()) {
      if (!c.enabled) continue
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
    return cmd.run(input, ctx)
  }

  private meta(c: Command): CommandMeta {
    return { id: c.id, title: c.title, aliases: c.aliases, kind: c.kind, agentTool: c.agentTool, enabled: c.enabled }
  }
}
