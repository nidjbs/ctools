// shellSandbox：bash 默认禁网（sandbox-exec deny network*）。用本地 listener 做确定性离线验证。
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShellSandboxed } from '../src/main/shellSandbox'

let cwd = mkdtempSync(join(tmpdir(), 'ctools-sb-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))

/** 起一个本地 TCP 监听，返回端口与关闭函数。 */
function listen(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      resolve({ port, close: () => srv.close() })
    })
  })
}

describe('runShellSandboxed', () => {
  it('禁网默认下本地命令正常执行', async () => {
    const r = await runShellSandboxed('echo ctools-sb-ok', cwd, false)
    expect(r.text).toContain('退出码 0')
    expect(r.text).toContain('ctools-sb-ok')
  })

  it('禁网（allowNetwork=false）阻断本地 TCP 连接', async () => {
    const { port, close } = await listen()
    try {
      const r = await runShellSandboxed(`nc -z -w 2 127.0.0.1 ${port}`, cwd, false)
      expect(r.text).not.toContain('退出码 0') // 被 seatbelt 拒绝 → 非零
    } finally {
      close()
    }
  })

  it('放行联网（allowNetwork=true）可连本地 TCP', async () => {
    const { port, close } = await listen()
    try {
      const r = await runShellSandboxed(`nc -z -w 2 127.0.0.1 ${port}`, cwd, true)
      expect(r.text).toContain('退出码 0')
    } finally {
      close()
    }
  })
})
