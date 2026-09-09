// bash 的 OS 级网络沙箱：sandbox-exec + Seatbelt 禁网（默认禁；AppConfig.bashNetwork=true 放行）。
// 禁网语义必须强制：沙箱不可用时宁可报错，也不静默降级成无沙箱执行。
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 30_000
const MAX_OUT = 8000
const PROFILE_NO_NET = '(version 1)(allow default)(deny network*)'

export interface ShellOut {
  code: number
  text: string
}

let usable: boolean | null = null
function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sandbox-exec', ['-p', PROFILE_NO_NET, '/bin/echo', 'probe'], (err) => resolve(!err))
  })
}
/** sandbox-exec 是否可用（首用探测并缓存）。 */
export function sandboxUsable(): Promise<boolean> {
  if (usable !== null) return Promise.resolve(usable)
  return probe().then((ok) => (usable = ok))
}

function cap(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[输出截断，共 ${s.length} 字符]` : s
}

function run(argv: string[], cwd: string): Promise<ShellOut> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUT * 2 }, (err, stdout, stderr) => {
      const out = cap(`${stdout}${stderr}`.trim())
      if (!err) {
        resolve({ code: 0, text: out ? `退出码 0\n${out}` : '退出码 0（无输出）' })
        return
      }
      const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean }
      const code = typeof e.code === 'number' ? Number(e.code) : 1
      resolve({ code, text: e.killed ? `已超时(${TIMEOUT_MS / 1000}s)终止\n${out}` : `退出码 ${code}\n${out}` })
    })
  })
}

/**
 * 执行一条 shell 命令：
 * - allowNetwork=false（默认）→ 强制 OS 级禁网；sandbox-exec 不可用时拒绝执行（不降级）。
 * - allowNetwork=true → 普通 /bin/sh -c 执行（保持原有联网能力，仍受 confirm + 超时约束）。
 */
export async function runShellSandboxed(cmd: string, cwd: string, allowNetwork: boolean): Promise<ShellOut> {
  if (!allowNetwork) {
    if (!(await sandboxUsable())) {
      return { code: 1, text: '错误: 网络沙箱（sandbox-exec）不可用，已拒绝执行。可在设置中开启「bash 联网」后重试' }
    }
    return run(['sandbox-exec', '-p', PROFILE_NO_NET, '/bin/sh', '-c', cmd], cwd)
  }
  return run(['/bin/sh', '-c', cmd], cwd)
}
