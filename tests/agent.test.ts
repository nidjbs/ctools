import { describe, expect, it } from 'vitest'
import { Session, type ChatMessage } from '../src/main/session'
import { Registry } from '../src/main/registry'
import { runAgentTurn, seedSystem } from '../src/main/agent'
import type { AppConfig, Ctx, MemoryMeta } from '../src/shared/types'
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

/** 记录每次模型请求的 messages，供 R2/R3 断言。 */
function capturingCtx(captured: ChatMessage[][], memory?: Ctx['memory']): Ctx {
  const base = ctx()
  return {
    ...base,
    ...(memory ? { memory } : {}),
    gateway: {
      ...base.gateway,
      chatStream: async (req, h) => {
        captured.push(req.messages as ChatMessage[])
        if (captured.length === 1) {
          // 首轮：让 agent 去调工具（触发第二次模型请求）
          h.onToolCalls?.([{ id: 'c1', type: 'function', function: { name: 'find_file', arguments: '{"query":"r"}' } }])
          h.onFinish?.('tool_calls')
        } else {
          h.onContent('done')
          h.onFinish?.('stop')
        }
      },
    },
  }
}

const memMeta: MemoryMeta = { id: 'a1', title: 'T', gist: 'g', ts: '2026-09-17T00:00:00Z' }

/** 最小 memory provider 桩（只需 index/pinnedText 参与 system 组装）。 */
function memStub(over: Partial<NonNullable<Ctx['memory']>> = {}): NonNullable<Ctx['memory']> {
  return {
    index: () => '',
    pinnedText: () => '',
    recall: () => [],
    add: () => memMeta,
    forget: () => {},
    setPinned: () => {},
    list: () => [],
    ...over,
  }
}

describe('每轮 system 段注入（specs/system-prompt.md）', () => {
  it('R3：插在角色之后、历史之前', async () => {
    const session = new Session()
    seedSystem(session, '你是助手')
    const captured: ChatMessage[][] = []
    const registry = new Registry().register(findFile)
    await runAgentTurn(session, '找 r', capturingCtx(captured), registry, { onEvent: () => {}, onContent: () => {} })

    const msgs = captured[0]
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe('你是助手') // 角色仍在最前
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].content).toContain('工作目录（bash cwd）: /tmp') // fileRoots[0]
    expect(msgs[1].content).toContain('今天是') // 日期在环境段内、排最后
    expect(msgs[2].role).toBe('user') // 历史随后
  })

  it('R2：turn 内 agent 写入记忆也不改变本 turn 的 system（字节一致）', async () => {
    const session = new Session()
    seedSystem(session, '你是助手')
    const captured: ChatMessage[][] = []
    let idx = 'v1'
    const c = capturingCtx(captured, memStub({ index: () => idx }))
    const registry = new Registry().register(findFile)
    // 首轮模型请求后，模拟 agent 写了记忆（索引变化）
    const orig = c.gateway.chatStream
    c.gateway.chatStream = async (req, h) => {
      await orig(req, h)
      idx = 'v2'
    }
    await runAgentTurn(session, '找 r', c, registry, { onEvent: () => {}, onContent: () => {} })

    expect(captured).toHaveLength(2)
    const sysOf = (m: ChatMessage[]) => m.find((x) => x.content?.includes('工作目录'))?.content
    expect(sysOf(captured[0])).toBe(sysOf(captured[1])) // turn 内快照不变
    expect(sysOf(captured[1])).not.toContain('v2') // 未在 turn 中途重建
  })

  it('pinned 正文与索引进入 system；无记忆时不出现', async () => {
    const session = new Session()
    seedSystem(session, '你是助手')
    const captured: ChatMessage[][] = []
    const memory = memStub({ index: () => '# 记忆索引\n- [偏好](a1) — 中文', pinnedText: () => '- 用户偏好中文文档' })
    const registry = new Registry().register(findFile)
    await runAgentTurn(session, '找 r', capturingCtx(captured, memory), registry, { onEvent: () => {}, onContent: () => {} })
    expect(captured[0][1].content).toContain('记忆索引')
    expect(captured[0][1].content).toContain('用户偏好中文文档')

    // 无 memory provider → 不含记忆段
    const captured2: ChatMessage[][] = []
    await runAgentTurn(session, '找 r', capturingCtx(captured2), registry, { onEvent: () => {}, onContent: () => {} })
    expect(captured2[0][1].content).not.toContain('记忆索引')
  })
})
