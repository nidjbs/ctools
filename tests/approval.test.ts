// agent 人工在环：工具 confirm → onConfirm 批准才执行（file_rm 为例）。specs/agent-whitelist.md。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentTurn } from '../src/main/agent'
import { Session } from '../src/main/session'
import { Registry } from '../src/main/registry'
import { fileRm } from '../commands/file'
import type { AppConfig, Ctx } from '../src/shared/types'

let root: string
beforeAll(() => (root = mkdtempSync(join(tmpdir(), 'ctools-approve-'))))
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function run(target: string, approve: boolean): Promise<string> {
  const ctx = {
    config: { fileRoots: [root], writeConfirm: 'auto', hotkey: 'x', enabledCommands: {} } as AppConfig,
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (req: { messages: { role: string }[] }, h: { onContent: (s: string) => void; onToolCalls?: (c: unknown[]) => void; onFinish: (r?: string) => void }) => {
        const hasTool = (req.messages ?? []).some((m) => m.role === 'tool')
        if (hasTool) {
          h.onContent('done')
          h.onFinish('stop')
        } else {
          h.onToolCalls?.([
            { id: 'c1', type: 'function', function: { name: 'file_rm', arguments: JSON.stringify({ path: target }) } },
          ])
          h.onFinish('tool_calls')
        }
      },
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  } as Ctx
  const reg = new Registry().registerAll([fileRm])
  const s = new Session()
  await runAgentTurn(s, '删除目标', ctx, reg, {
    onContent: () => {},
    onEvent: () => {},
    onConfirm: async () => approve,
  })
  return s.transcript().find((e) => e.type === 'tool.result')?.content ?? ''
}

describe('agent 破坏性操作 → 人工在环', () => {
  it('拒绝 → 不落盘，工具结果含「用户未批准」', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'x')
    const result = await run(f, false)
    expect(result).toContain('用户未批准')
    expect(existsSync(f)).toBe(true)
  })

  it('批准 → 真正删除', async () => {
    const f = join(root, 'b.txt')
    writeFileSync(f, 'x')
    const result = await run(f, true)
    expect(result).toContain('已删除')
    expect(existsSync(f)).toBe(false)
  })
})
