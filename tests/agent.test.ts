import { describe, expect, it } from 'vitest'
import { Session } from '../src/main/session'
import { Registry } from '../src/main/registry'
import { runAgentTurn } from '../src/main/agent'
import type { AppConfig, Ctx } from '../src/shared/types'
import { findFile } from '../commands/find_file'

function ctx(): Ctx {
  // 脚本化 gateway：第一次返回 find_file 工具调用, 第二次流式返回结果
  let calls = 0
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
      chat: async () => ({ content: 'ok' }),
      chatStream: async (_req, h) => {
        calls++
        if (calls === 1) {
          h.onToolCalls?.([{ id: 'c1', type: 'function', function: { name: 'find_file', arguments: '{"query":"report"}' } }])
          h.onFinish?.('tool_calls')
        } else {
          h.onContent('找到 1 个文件: /tmp/report.md')
          h.onFinish?.('stop')
        }
      },
    },
    system: { pbcopy: async () => true, mdfind: async (q) => [`/tmp/${q}.md`] },
  }
}

describe('agent', () => {
  it('一次输入: user → assistant(tool_calls) → tool.call/result → 最终回复', async () => {
    const session = new Session()
    const registry = new Registry().register(findFile)
    let events = 0
    let streamed = ''
    const final = await runAgentTurn(session, '帮我找 report', ctx(), registry, {
      onEvent: () => events++,
      onContent: (d) => (streamed += d),
    })
    expect(streamed).toContain('找到 1 个文件')
    expect(final).toContain('找到 1 个文件')
    const types = session.transcript().map((e) => e.type)
    expect(types).toEqual(['user.message', 'assistant.message', 'tool.call', 'tool.result', 'assistant.message'])
    expect(events).toBe(types.length)
  })

  it('无工具时单次流式即返回', async () => {
    const session = new Session()
    const registry = new Registry().register(findFile)
    const c = ctx()
    const plain: Ctx = { ...c, gateway: { ...c.gateway, chatStream: async (_r, h) => { h.onContent('你好'); h.onFinish?.('stop') } } }
    const final = await runAgentTurn(session, '你好', plain, registry, { onEvent: () => {}, onContent: () => {} })
    expect(final).toBe('你好')
    expect(session.transcript().map((e) => e.type)).toEqual(['user.message', 'assistant.message'])
  })
})
