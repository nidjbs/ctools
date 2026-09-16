// agent 循环增强（specs/agent-loop.md）：并行工具调用、循环检测、工具描述；以及 ask 回填（specs/ask.md）。
import { describe, expect, it } from 'vitest'
import { Session } from '../src/main/session'
import { Registry } from '../src/main/registry'
import { agentLoop, type AgentCallbacks } from '../src/main/agent'
import { toolSpecOf } from '../src/shared/tool'
import type { Command, CommandResult, Ctx, StreamHandlers } from '../src/shared/types'
import { defaultConfig } from '../src/main/config'

interface CallSpec {
  name: string
  args: unknown
}

/** 脚本化 gateway：按 turns 依次给出工具调用，用尽后收尾。 */
function scriptedCtx(callsPerTurn: CallSpec[][], log: string[] = []): Ctx {
  let i = 0
  return {
    config: { ...defaultConfig(), fileRoots: ['/tmp'] },
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_req, h: StreamHandlers) => {
        const calls = callsPerTurn[i] ?? []
        i++
        if (calls.length) {
          h.onToolCalls?.(
            calls.map((c, j) => ({
              id: `c${i}_${j}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          )
          h.onFinish?.('tool_calls')
        } else {
          h.onContent('done')
          h.onFinish?.('stop')
        }
        void log
      },
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
}

/** 记录 start/end 的工具，用于观测并发与否。 */
function tracingCmd(id: string, planSafe: boolean, log: string[], delay = 15): Command {
  return {
    id,
    title: id,
    aliases: [],
    kind: 'quick',
    agentTool: true,
    planSafe,
    enabled: true,
    schema: { type: 'object', properties: { query: { type: 'string' } } },
    run: async (): Promise<CommandResult> => {
      log.push(`${id}:start`)
      await new Promise((r) => setTimeout(r, delay))
      log.push(`${id}:end`)
      return { type: 'text', text: `${id} done` }
    },
  }
}

const cb = (over: Partial<AgentCallbacks> = {}): AgentCallbacks => ({
  onEvent: () => {},
  onContent: () => {},
  ...over,
})

describe('§1 并行工具调用', () => {
  it('整批只读 → 并发（start 全部先于 end）', async () => {
    const log: string[] = []
    const registry = new Registry().registerAll([
      tracingCmd('r1', true, log),
      tracingCmd('r2', true, log),
      tracingCmd('r3', true, log),
    ])
    const ctx = scriptedCtx([[{ name: 'r1', args: {} }, { name: 'r2', args: {} }, { name: 'r3', args: {} }]])
    await agentLoop(new Session(), ctx, registry, cb())
    // 并发：三个 start 都出现在第一个 end 之前
    const firstEnd = log.indexOf('r1:end')
    expect(log.slice(0, firstEnd)).toEqual(['r1:start', 'r2:start', 'r3:start'])
  })

  it('含写操作 → 整批串行（start/end 成对出现）', async () => {
    const log: string[] = []
    const registry = new Registry().registerAll([
      tracingCmd('r1', true, log),
      tracingCmd('w1', false, log), // 非 planSafe
    ])
    const ctx = scriptedCtx([[{ name: 'r1', args: {} }, { name: 'w1', args: {} }]])
    await agentLoop(new Session(), ctx, registry, cb())
    expect(log).toEqual(['r1:start', 'r1:end', 'w1:start', 'w1:end'])
  })

  it('事件顺序与模型给出顺序一致：先全部 tool.call，后全部 tool.result', async () => {
    const log: string[] = []
    const registry = new Registry().registerAll([
      tracingCmd('r1', true, log),
      tracingCmd('r2', true, log),
    ])
    const ctx = scriptedCtx([[{ name: 'r1', args: {} }, { name: 'r2', args: {} }]])
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    const kinds = s.transcript().map((e) => `${e.type}${e.tool_name ? `:${e.tool_name}` : ''}`)
    expect(kinds).toEqual([
      'assistant.message',
      'tool.call:r1',
      'tool.call:r2',
      'tool.result:r1',
      'tool.result:r2',
      'assistant.message',
    ])
  })

  it('并发不改变结果顺序（结果按 call 顺序回填）', async () => {
    const log: string[] = []
    const registry = new Registry().registerAll([
      tracingCmd('slow', true, log, 30),
      tracingCmd('fast', true, log, 1),
    ])
    const ctx = scriptedCtx([[{ name: 'slow', args: {} }, { name: 'fast', args: {} }]])
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    const results = s.transcript().filter((e) => e.type === 'tool.result')
    expect(results.map((e) => e.tool_name)).toEqual(['slow', 'fast'])
  })
})

describe('§2 循环检测', () => {
  it('同工具同参数第 4 次起追加提示；前 3 次不提示', async () => {
    const registry = new Registry().register(tracingCmd('r1', true, []))
    const ctx = scriptedCtx(Array.from({ length: 4 }, () => [{ name: 'r1', args: { query: 'same' } }]))
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    const results = s.transcript().filter((e) => e.type === 'tool.result')
    expect(results).toHaveLength(4)
    expect(results[0].content).not.toContain('[提示]')
    expect(results[2].content).not.toContain('[提示]')
    expect(results[3].content).toContain('第 4 次')
  })

  it('参数不同则不触发', async () => {
    const registry = new Registry().register(tracingCmd('r1', true, []))
    const ctx = scriptedCtx([
      [{ name: 'r1', args: { query: 'a' } }],
      [{ name: 'r1', args: { query: 'b' } }],
      [{ name: 'r1', args: { query: 'c' } }],
      [{ name: 'r1', args: { query: 'd' } }],
      [{ name: 'r1', args: { query: 'e' } }],
    ])
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    expect(s.transcript().filter((e) => e.type === 'tool.result').every((e) => !e.content?.includes('[提示]'))).toBe(true)
  })

  it('键序不同的等价参数视为同一次调用', async () => {
    const registry = new Registry().register(tracingCmd('r1', true, []))
    const raw = ['{"query":"x","n":1}', '{"n":1,"query":"x"}']
    // 直接构造两轮，参数 JSON 键序不同但语义相同
    let i = 0
    const ctx: Ctx = {
      config: { ...defaultConfig(), fileRoots: ['/tmp'] },
      gateway: {
        models: async () => [],
        chat: async () => ({ content: '' }),
        chatStream: async (_r, h) => {
          const step = i++
          if (step < raw.length + 2) {
            h.onToolCalls?.([{ id: `c${step}`, type: 'function', function: { name: 'r1', arguments: raw[step % raw.length] } }])
            h.onFinish?.('tool_calls')
          } else {
            h.onContent('done')
            h.onFinish?.('stop')
          }
        },
      },
      system: { pbcopy: async () => true, mdfind: async () => [] },
    }
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    const results = s.transcript().filter((e) => e.type === 'tool.result')
    expect(results[3].content).toContain('[提示]') // 第 4 次触发，说明键序不同仍算同一调用
  })
})

describe('§3 工具描述', () => {
  it('toolSpecOf 用 description；缺省回退 title', () => {
    const withDesc: Command = { ...tracingCmd('a', true, []), description: '何时用 A' }
    expect(toolSpecOf(withDesc).function.description).toBe('何时用 A')
    const noDesc: Command = { ...tracingCmd('b', true, []), description: undefined }
    expect(toolSpecOf(noDesc).function.description).toBe('b')
  })
})

describe('ask：提问回填（specs/ask.md）', () => {
  const askLike: Command = {
    id: 'ask',
    title: '向用户提问',
    aliases: [],
    kind: 'quick',
    agentTool: true,
    enabled: true,
    schema: { type: 'object', properties: { question: { type: 'string' } } },
    run: async (input): Promise<CommandResult> => ({
      type: 'ask',
      question: String((input as { question?: string })?.question ?? ''),
      options: ['A', 'B'],
    }),
  }

  it('onAsk 被调用，回答作为 tool.result 回填', async () => {
    const registry = new Registry().register(askLike)
    const ctx = scriptedCtx([[{ name: 'ask', args: { question: '选哪个？' } }]])
    const seen: Array<{ q: string; opts?: string[] }> = []
    const s = new Session()
    await agentLoop(s, ctx, registry, cb({ onAsk: async (q, opts) => { seen.push({ q, opts }); return 'B' } }))
    expect(seen[0].q).toBe('选哪个？')
    expect(seen[0].opts).toEqual(['A', 'B'])
    expect(s.transcript().find((e) => e.type === 'tool.result')?.content).toBe('用户回答：B')
  })

  it('未回答/空串 → 记为（用户未回答）', async () => {
    const registry = new Registry().register(askLike)
    const ctx = scriptedCtx([[{ name: 'ask', args: { question: 'q' } }]])
    const s = new Session()
    await agentLoop(s, ctx, registry, cb({ onAsk: async () => '   ' }))
    expect(s.transcript().find((e) => e.type === 'tool.result')?.content).toBe('（用户未回答）')
  })

  it('无 onAsk 回调（非对话场景）→ 不挂死，记为用户未回答', async () => {
    const registry = new Registry().register(askLike)
    const ctx = scriptedCtx([[{ name: 'ask', args: { question: 'q' } }]])
    const s = new Session()
    await agentLoop(s, ctx, registry, cb())
    expect(s.transcript().find((e) => e.type === 'tool.result')?.content).toBe('（用户未回答）')
  })

  it('ask 非 planSafe（不进规划工具集）', () => {
    const registry = new Registry().register(askLike)
    expect(registry.toolIds()).toContain('ask')
    expect(registry.planTools()).not.toContain('ask')
  })
})
