// bash：Launcher 执行 shell 命令，每次强制确认（specs/bash.md）。agentTool。
// 默认经 sandbox-exec 禁网执行（AppConfig.bashNetwork=true 放行联网）。见 src/main/shellSandbox.ts。
import { homedir } from 'node:os'
import type { Command, Ctx } from '../src/shared/types'
import { queryText } from '../src/shared/tool'
import { runShellSandboxed } from '../src/main/shellSandbox'

/** 确认闸门：bash 恒需 confirmApproved（无视 writeConfirm，never 也不放行）。 */
function gate(ctx: Ctx, cmd: string) {
  if (ctx.confirmApproved) return null
  const preview = cmd.replace(/\s+/g, ' ').slice(0, 80)
  return { type: 'confirm' as const, message: `确认在 shell 执行：${preview}` }
}

export const bashCmd: Command = {
  id: 'bash',
  title: '执行命令',
  aliases: ['run', 'sh', 'shell', '执行'],
  kind: 'quick',
  agentTool: true, // agent 可发起，但每次执行仍需 Chat 内人工批准（onConfirm → confirmApproved）
  enabled: true,
  run: async (input, ctx) => {
    const cmd = queryText(input)
    if (!cmd) return { type: 'text', text: '用法: bash <命令>' }
    const gated = gate(ctx, cmd)
    if (gated) return gated
    const cwd = ctx.config.fileRoots.find(Boolean) || homedir()
    const { text } = await runShellSandboxed(cmd, cwd, !!ctx.config.bashNetwork)
    return { type: 'text', text }
  },
}
