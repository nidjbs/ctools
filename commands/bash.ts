// bash：Launcher 执行 shell 命令，每次强制确认（specs/bash.md）。agentTool。
// 默认经 sandbox-exec 禁网执行（AppConfig.bashNetwork=true 放行联网）。见 src/main/shellSandbox.ts。
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
  description: '在 shell 执行命令（每次需用户批准；默认禁网）。有专用工具时优先用专用工具。',
  aliases: ['run', 'sh', 'shell', '执行'],
  kind: 'quick',
  agentTool: true, // agent 可发起，但每次执行仍需 Chat 内人工批准（onConfirm → confirmApproved）
  enabled: true,
  run: async (input, ctx) => {
    const cmd = queryText(input)
    if (!cmd) return { type: 'text', text: '用法: bash <命令>' }
    // cwd 与 file_roots 一致；未配置则拒绝（否则会出现「file 工具全拒、bash 却能在家目录跑」的矛盾）
    const cwd = ctx.config.fileRoots.find(Boolean)
    if (!cwd) {
      return { type: 'text', text: '未配置可访问目录（file_roots），bash 不可用。请先在设置里选择目录。' }
    }
    const gated = gate(ctx, cmd)
    if (gated) return gated
    const { text } = await runShellSandboxed(cmd, cwd, !!ctx.config.bashNetwork)
    return { type: 'text', text }
  },
}
