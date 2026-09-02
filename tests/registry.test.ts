import { describe, expect, it } from 'vitest'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx } from '../src/shared/types'
import { trans } from '../commands/trans'
import { findFile } from '../commands/find_file'

function testCtx(): Ctx {
  return {
    config: {
      gatewayUrl: 'http://mock',
      adminUrl: 'http://mock',
      defaultAlias: 'chat',
      fileRoots: ['/tmp'],
      writeConfirm: 'auto',
      hotkey: 'x',
      enabledCommands: {},
    } as AppConfig,
    gateway: {
      chat: async (req) => ({ content: `mock: ${(req.messages.at(-1) as { content: string }).content}` }),
    },
    system: { pbcopy: async () => true, mdfind: async (q) => [`/tmp/${q}.md`] },
  }
}

function registry(): Registry {
  return new Registry().registerAll([trans, findFile])
}

describe('registry', () => {
  it('匹配工具前缀(alias)', () => {
    const m = registry().match('tran')
    expect(m[0]?.id).toBe('trans')
  })

  it('匹配多个并去重排序', () => {
    const m = registry().match('fi')
    expect(m[0]?.id).toBe('find_file')
  })

  it('空输入不返回', () => {
    expect(registry().match('')).toEqual([])
  })

  it('执行命令并注入 ctx', async () => {
    const out = await registry().run('trans', 'hello', testCtx())
    expect(out).toMatchObject({ type: 'text', text: 'mock: hello' })
  })

  it('agentTool 命令进入 toolIds', () => {
    expect(registry().toolIds()).toContain('find_file')
    expect(registry().toolIds()).not.toContain('trans')
  })

  it('未知命令抛错', async () => {
    await expect(registry().run('nope', '', testCtx())).rejects.toThrow()
  })
})
