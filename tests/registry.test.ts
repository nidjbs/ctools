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
      models: async () => ['chat'],
      chat: async (req) => ({ content: `mock: ${(req.messages.at(-1) as { content: string }).content}` }),
      chatStream: async (_req, h) => {
        h.onContent('mock stream')
        h.onFinish?.('stop')
      },
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

  it('带参数输入保留命令：match("trans hello") → trans', () => {
    expect(registry().match('trans hello').map((m) => m.id)).toEqual(['trans'])
  })

  it('别名+参数命中：match("find 报告") → find_file', () => {
    expect(registry().match('find 报告').map((m) => m.id)).toEqual(['find_file'])
  })

  it('自由内容(首词非命令)仍为空 → 交给 agent', () => {
    expect(registry().match('帮我 找文件')).toEqual([])
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

describe('registry 启停覆盖（Settings 写入 config.enabledCommands）', () => {
  it('syncEnabled({trans:false}) → 联想/列表/工具/执行全隔离，且不动命令单例', async () => {
    const r = registry()
    r.syncEnabled({ enabledCommands: { trans: false } })

    expect(r.match('tra')).toEqual([]) // 联想不返回
    expect(r.list().map((m) => m.id)).not.toContain('trans')
    expect(r.metaFor('trans')).toBeUndefined()
    expect(r.list(false).find((m) => m.id === 'trans')?.enabled).toBe(false) // all 列表仍可见
    await expect(r.run('trans', 'hi', testCtx())).rejects.toThrow('command disabled: trans')

    // 命令模块单例未被改写 → 新注册表仍默认启用
    expect(registry().get('trans')?.enabled).toBe(true)
  })

  it('重新启用后恢复', () => {
    const r = registry()
    r.syncEnabled({ enabledCommands: { find_file: false } })
    expect(r.match('find_file')).toEqual([])
    r.syncEnabled({ enabledCommands: { find_file: true } })
    expect(r.match('find_file')[0]?.id).toBe('find_file')
  })

  it('无覆盖时保留命令默认 enabled', () => {
    const r = registry()
    r.syncEnabled({ enabledCommands: {} })
    expect(r.list().map((m) => m.id)).toContain('trans')
  })
})
