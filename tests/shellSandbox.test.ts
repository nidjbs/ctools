// shellSandbox：bash 默认禁网（sandbox-exec deny network*）。用本地 listener 做确定性离线验证。
// 依赖 sandbox-exec 的用例只在 macOS 上跑（其它平台 cTools 按设计拒绝执行 shell 命令，见 specs/bash.md）。
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShellSandboxed } from '../src/main/shellSandbox'
import { HAS_SANDBOX, SANDBOX_SKIP_REASON } from './helpers/platform'

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

/** 用 node 自身发一次 TCP 探测 —— 不依赖 nc 是否安装（CI 上曾因此脆弱）。 */
const tcpProbe = (port: number) =>
  `node -e "const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"`

describe('runShellSandboxed', () => {
  it.skipIf(!HAS_SANDBOX)(`禁网默认下本地命令正常执行（${SANDBOX_SKIP_REASON}）`, async () => {
    const r = await runShellSandboxed('echo ctools-sb-ok', cwd, false)
    expect(r.text).toContain('退出码 0')
    expect(r.text).toContain('ctools-sb-ok')
  })

  it.skipIf(!HAS_SANDBOX)(`禁网（allowNetwork=false）阻断本地 TCP 连接（${SANDBOX_SKIP_REASON}）`, async () => {
    const { port, close } = await listen()
    try {
      const r = await runShellSandboxed(tcpProbe(port), cwd, false)
      expect(r.text).not.toContain('退出码 0') // 被 seatbelt 拒绝 → 非零
    } finally {
      close()
    }
  })

  it('沙箱不可用时拒绝执行，且给出可操作提示（不静默降级为无沙箱）', async () => {
    const r = await runShellSandboxed('echo hi', cwd, false)
    if (HAS_SANDBOX) {
      expect(r.text).toContain('退出码 0') // 有沙箱则正常执行
    } else {
      expect(r.text).toContain('沙箱')
      expect(r.text).toContain('拒绝执行')
      expect(r.text).toContain('bash 联网')
    }
  })

  it('放行联网（allowNetwork=true）可连本地 TCP（不走沙箱，全平台通用）', async () => {
    const { port, close } = await listen()
    try {
      const r = await runShellSandboxed(tcpProbe(port), cwd, true)
      expect(r.text).toContain('退出码 0')
    } finally {
      close()
    }
  })
})
