// bash 命令：强制确认门（never 也不放行）+ 批准后执行 + 退出码。specs/bash.md。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bashCmd } from '../commands/bash'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx } from '../src/shared/types'

let root: string
let ctx: Ctx
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctools-bash-'))
  ctx = {
    config: { fileRoots: [root], writeConfirm: 'never', hotkey: 'x', enabledCommands: {} } as AppConfig,
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('bash 确认门', () => {
  it('writeConfirm=never 也必须确认', async () => {
    const r = await bashCmd.run('echo hi', ctx)
    expect(r).toMatchObject({ type: 'confirm', message: expect.stringContaining('echo hi') })
  })

  it('批准后执行并回显输出', async () => {
    const r = await bashCmd.run('echo ctools-bash-ok', { ...ctx, confirmApproved: true })
    expect(r.type).toBe('text')
    if (r.type === 'text') {
      expect(r.text).toContain('退出码 0')
      expect(r.text).toContain('ctools-bash-ok')
    }
  })

  it('非零退出码回显', async () => {
    const r = await bashCmd.run('echo oops >&2; exit 3', { ...ctx, confirmApproved: true })
    expect(r.type).toBe('text')
    if (r.type === 'text') expect(r.text).toContain('退出码 3')
  })

  it('空参数用法提示', async () => {
    const r = await bashCmd.run('', ctx)
    expect(r.type).toBe('text')
    if (r.type === 'text') expect(r.text).toContain('用法')
  })

  it('bash 是 agentTool（agent 可发起，执行仍需批准）', () => {
    const ids = new Registry().registerAll([bashCmd]).toolIds()
    expect(ids).toContain('bash')
  })
})
