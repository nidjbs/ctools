// bash：Launcher 执行 shell 命令，每次强制确认（specs/bash.md）。非 agentTool。
import { exec } from 'node:child_process'
import { homedir } from 'node:os'
import type { Command, Ctx } from '../src/shared/types'
import { queryText } from '../src/shared/tool'

const TIMEOUT_MS = 30_000
const MAX_OUT = 8000

function cap(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[输出截断，共 ${s.length} 字符]` : s
}

/** 确认闸门：bash 恒需 confirmApproved（无视 writeConfirm，never 也不放行）。 */
function gate(ctx: Ctx, cmd: string) {
  if (ctx.confirmApproved) return null
  const preview = cmd.replace(/\s+/g, ' ').slice(0, 80)
  return { type: 'confirm' as const, message: `确认在 shell 执行：${preview}` }
}

function runShell(cmd: string, cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUT * 2 }, (err, stdout, stderr) => {
      const out = cap(`${stdout}${stderr}`.trim())
      if (!err) {
        resolve({ code: 0, text: out ? `退出码 0\n${out}` : '退出码 0（无输出）' })
        return
      }
      const code = typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: unknown }).code) : 1
      if ((err as { killed?: boolean }).killed) {
        resolve({ code, text: `已超时(${TIMEOUT_MS / 1000}s)终止\n${out}` })
        return
      }
      resolve({ code, text: `退出码 ${code}\n${out}` })
    })
  })
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
    const { text } = await runShell(cmd, cwd)
    return { type: 'text', text }
  },
}
