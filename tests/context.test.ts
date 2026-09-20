// 上下文工程（specs/context.md）：大结果外置 + 按 token 计量（条数兜底）的摘要/shadow 压缩。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../src/main/session'
import { compactIfNeeded, trimText, spillText, makeSummarizer } from '../src/main/context'
import { seedSystem } from '../src/main/agent'
import type { ChatMessage } from '../src/main/session'

/** 条数模式：把 token 上限抬高，让条数成为唯一约束（验证兜底路径）。 */
const COUNT_ONLY = { capacityTokens: 1_000_000 }

let spillDir: string
beforeEach(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'ctools-spill-'))
})
afterAll(() => rmSync(spillDir, { recursive: true, force: true }))

function user(s: Session, i: number) {
  s.append('user.message', { role: 'user', content: `u${i}` })
}
function assistant(s: Session, i: number) {
  s.append('assistant.message', { role: 'assistant', content: `a${i}` })
}

describe('trimText / spillText', () => {
  it('超长保留头尾 + 标记', () => {
    const t = trimText('x'.repeat(10000))
    expect(t).toContain('已裁剪')
    expect(t).toContain('x'.repeat(1000)) // tail 保留
    expect(t.length).toBeLessThan(4000)
  })
  it('短文本原样', () => {
    expect(trimText('hi')).toBe('hi')
  })
  it('spillText 带路径时给出回取指引', () => {
    const t = spillText('y'.repeat(10000), '/tmp/spill/abc.txt')
    expect(t).toContain('完整结果已存至 /tmp/spill/abc.txt')
    expect(t).toContain('file_read')
  })
})

describe('大 tool.result 外置', () => {
  it('>maxToolBytes → 写 spill 文件 + 上下文换成可回取路径；原事件保留', async () => {
    const s = new Session()
    seedSystem(s, 'sys')
    user(s, 1)
    assistant(s, 1)
    s.append('tool.call', { tool_name: 'file_read', tool_call_id: 'c1', arguments: '{}' })
    const big = 'D'.repeat(20_000)
    const orig = s.append('tool.result', { role: 'tool', tool_name: 'file_read', tool_call_id: 'c1', content: big })

    expect(await compactIfNeeded(s, { maxToolBytes: 8000, spillDir })).toBe(true)

    const toolMsg = s.messages().find((m: ChatMessage) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(toolMsg?.content).toContain(spillDir) // 回取路径
    expect(toolMsg?.content).toContain('file_read')
    expect((toolMsg?.content ?? '').length).toBeLessThan(4000)
    expect(toolMsg?.tool_call_id).toBe('c1')

    // 全文真的落盘了，且可读回原样
    const file = join(spillDir, `${orig.event_id}.txt`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(big)

    // 原事件仍在 transcript（审计）
    expect(s.transcript().some((e) => e.seq === orig.seq && e.content!.length === 20_000)).toBe(true)
  })

  it('无 spillDir → 退化为纯裁剪（不崩）', async () => {
    const s = new Session()
    seedSystem(s, 'sys')
    s.append('tool.call', { tool_name: 'file_read', tool_call_id: 'c2' })
    s.append('tool.result', { role: 'tool', tool_call_id: 'c2', content: 'Z'.repeat(9000) })
    expect(await compactIfNeeded(s, { maxToolBytes: 8000, capacityCount: 20, triggerPercent: 20 })).toBe(true)
    expect(s.messages().find((m) => m.role === 'tool')?.content).toContain('已裁剪')
  })
})

describe('压缩（surface 超水位 → 摘要 / shadow 到 low）', () => {
  function longSession(): Session {
    const s = new Session()
    seedSystem(s, 'sys')
    for (let i = 1; i <= 5; i++) {
      user(s, i)
      assistant(s, i)
    }
    return s
  }

  it('条数兜底 capacityCount=6 (high4/low3)：11 条压到 ≤3，system 保留最前', async () => {
    const s = longSession()
    expect(s.messages().length).toBe(11)
    expect(await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20 })).toBe(true)
    const msgs = s.messages()
    expect(msgs.length).toBeLessThanOrEqual(3)
    expect(msgs[0].role).toBe('system') // system.context 永不被 shadow
    expect(s.transcript().filter((e) => e.type === 'context.compact').length).toBeGreaterThan(0)
  })

  it('未接近满（≤high）不压缩', async () => {
    const s = longSession() // 11 条
    expect(await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 20, triggerPercent: 20 })).toBe(false)
    expect(s.messages().length).toBe(11)
  })

  it('token 驱动：条数很少但单条很长 → 仍触发压缩', async () => {
    const s = new Session()
    seedSystem(s, 'sys')
    s.append('user.message', { role: 'user', content: '甲'.repeat(3000) }) // CJK ≈ 3000 token
    s.append('assistant.message', { role: 'assistant', content: 'a' })
    expect(await compactIfNeeded(s, { capacityTokens: 2000, capacityCount: 200, triggerPercent: 20 })).toBe(true)
    expect(s.messages().length).toBeLessThan(3)
  })

  it('capacityTokens<=0 禁用', async () => {
    const s = longSession()
    expect(await compactIfNeeded(s, { capacityTokens: 0 })).toBe(false)
    expect(s.messages().length).toBe(11)
  })

  it('幂等：压到 low 后再调用无动作', async () => {
    const s = longSession()
    const opts = { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20 }
    await compactIfNeeded(s, opts)
    const after = s.messages().length
    expect(await compactIfNeeded(s, opts)).toBe(false)
    expect(s.messages().length).toBe(after)
  })
})

describe('摘要压缩（不丢任务目标）', () => {
  function longSession(): Session {
    const s = new Session()
    seedSystem(s, 'sys')
    for (let i = 1; i <= 5; i++) {
      user(s, i)
      assistant(s, i)
    }
    return s
  }

  it('提供 summarize → 落 context.summary 事件并参与投影；被摘要批次被 shadow', async () => {
    const s = longSession()
    const seen: string[][] = []
    const summarize = async (msgs: Array<{ role: string; content?: string }>) => {
      seen.push(msgs.map((m) => m.content ?? ''))
      return '目标是 X；已完成 Y；待办 Z'
    }
    expect(await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20, summarize })).toBe(true)

    const sum = s.transcript().find((e) => e.type === 'context.summary')
    expect(sum?.content).toContain('待办 Z')
    expect(sum?.role).toBe('system')
    // 摘要参与模型可见投影
    expect(s.messages().some((m) => m.content?.includes('待办 Z'))).toBe(true)
    // 摘要器拿到了被压缩的原文
    expect(seen[0].join(' ')).toContain('u1')
    // 被摘要批次确实被 shadow 了
    expect((sum?.shadow_seqs ?? []).length).toBeGreaterThan(0)
  })

  it('summarize 返回 undefined（失败/禁用）→ 退回直接丢头，无 summary 事件', async () => {
    const s = longSession()
    const summarize = async () => undefined
    expect(await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20, summarize })).toBe(true)
    expect(s.transcript().some((e) => e.type === 'context.summary')).toBe(false)
    expect(s.messages().length).toBeLessThanOrEqual(3) // 仍压到 low
  })

  it('未提供 summarize → 纯丢头（现行为）', async () => {
    const s = longSession()
    expect(await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20 })).toBe(true)
    expect(s.transcript().some((e) => e.type === 'context.summary')).toBe(false)
  })

  it('摘要合并：第二次压缩把旧摘要并入新摘要，上下文里只留一条', async () => {
    const s = longSession()
    const inputs: string[][] = []
    const summarize = async (msgs: Array<{ role: string; content?: string }>) => {
      inputs.push(msgs.map((m) => m.content ?? ''))
      return inputs.length === 1 ? '第一轮摘要' : '合并后的摘要'
    }
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20, summarize })
    for (let i = 6; i <= 12; i++) {
      user(s, i)
      assistant(s, i)
    }
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20, summarize })

    // 第二次的摘要输入里带上了旧摘要（供合并）
    expect(inputs).toHaveLength(2)
    expect(inputs[1].some((t) => t.includes('已有摘要'))).toBe(true)
    expect(inputs[1].join(' ')).toContain('第一轮摘要')

    // 上下文里只剩一条摘要，且是新摘要
    const live = s.messages().filter((m) => m.content?.includes('早期对话摘要'))
    expect(live).toHaveLength(1)
    expect(live[0].content).toContain('合并后的摘要')

    // 旧摘要事件的原文仍在 transcript（审计），只是被 shadow
    expect(s.transcript().some((e) => e.content?.includes('第一轮摘要'))).toBe(true)
  })

  it('摘要批次不切开 tool 单元：压缩后不得残留孤立的 tool 消息', async () => {
    // 多个带工具往返的轮次，把批次边界正好压在 tool 单元上
    const s = new Session()
    seedSystem(s, 'sys')
    for (let i = 1; i <= 4; i++) {
      s.append('user.message', { role: 'user', content: `问题${i}：${'甲'.repeat(60)}` })
      s.append('assistant.message', {
        role: 'assistant',
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'file_list', arguments: '{}' } }],
      })
      s.append('tool.call', { tool_name: 'file_list', tool_call_id: `c${i}` })
      s.append('tool.result', { role: 'tool', tool_call_id: `c${i}`, content: `结果${i}` })
      s.append('assistant.message', { role: 'assistant', content: `回复${i}` })
    }
    await compactIfNeeded(s, {
      capacityTokens: 400,
      capacityCount: 200,
      triggerPercent: 20,
      summarize: async () => '早期摘要',
    })
    // 投影里，任何 tool 消息前面必须是带 tool_calls 的 assistant
    const msgs = s.messages()
    msgs.forEach((m, i) => {
      if (m.role !== 'tool') return
      const prev = msgs[i - 1]
      expect(prev?.role).toBe('assistant')
      expect((prev?.tool_calls as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
    })
  })

  it('兜底丢头不触碰摘要（KEEP_TYPES）：无 summarize 时摘要不参与 shadow 候选', async () => {
    const s = longSession()
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20, summarize: async () => '保留的摘要' })
    for (let i = 6; i <= 12; i++) {
      user(s, i)
      assistant(s, i)
    }
    // 第二次不给 summarize → 只走兜底丢头；摘要不是候选，应原样留存
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 6, triggerPercent: 20 })
    expect(s.messages().some((m) => m.content?.includes('保留的摘要'))).toBe(true)
  })
})

describe('makeSummarizer', () => {
  it('走注入的 chat；失败返回 undefined（不抛）', async () => {
    const ok = makeSummarizer(async () => ({ content: '  摘要  ' }), 'chat')
    expect(await ok([{ role: 'user', content: 'x' }])).toBe('摘要')

    const empty = makeSummarizer(async () => ({ content: '   ' }), 'chat')
    expect(await empty([{ role: 'user', content: 'x' }])).toBeUndefined()

    const boom = makeSummarizer(async () => {
      throw new Error('gateway down')
    }, 'chat')
    expect(await boom([{ role: 'user', content: 'x' }])).toBeUndefined()
  })
})

describe('回归：tool_calls 原子移除（修复孤立 tool 导致的 upstream 400）', () => {
  function toolRound(): { s: Session; asstSeq: number; toolSeq: number } {
    const s = new Session()
    seedSystem(s, 'sys')
    s.append('user.message', { role: 'user', content: 'u1' })
    const asst = s.append('assistant.message', {
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }],
    })
    const tool = s.append('tool.result', { role: 'tool', tool_call_id: 'c1', content: 'r1' })
    s.append('user.message', { role: 'user', content: 'u2' })
    s.append('assistant.message', { role: 'assistant', content: 'final' })
    return { s, asstSeq: asst.seq, toolSeq: tool.seq }
  }

  it('压缩到 low 后：不残留孤立 tool（无前置 tool_calls 的 tool.result）', async () => {
    const { s } = toolRound()
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 5, triggerPercent: 20 })
    const msgs = s.messages()
    const toolIdx = msgs.findIndex((m) => m.role === 'tool')
    if (toolIdx >= 0) {
      const prev = msgs[toolIdx - 1]
      expect(prev?.role).toBe('assistant')
      expect((prev?.tool_calls as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('assistant(tool_calls) 与其 tool.result 在同一 compact 单元里被一起 shadow', async () => {
    const { s, asstSeq, toolSeq } = toolRound()
    await compactIfNeeded(s, { ...COUNT_ONLY, capacityCount: 5, triggerPercent: 20 })
    const compacts = s.transcript().filter((e) => e.type === 'context.compact')
    const inSame = compacts.some(
      (e) => (e.shadow_seqs ?? []).includes(asstSeq) && (e.shadow_seqs ?? []).includes(toolSeq),
    )
    expect(inSame).toBe(true)
  })
})
