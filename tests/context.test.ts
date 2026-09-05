// 上下文压缩（specs/context.md）：大工具结果裁剪 + 接近满时的计数压缩（shadow 最旧）。
import { describe, expect, it } from 'vitest'
import { Session } from '../src/main/session'
import { compactIfNeeded, trimText } from '../src/main/context'
import { seedSystem } from '../src/main/agent'
import type { ChatMessage } from '../src/main/session'

function user(s: Session, i: number) {
  s.append('user.message', { role: 'user', content: `u${i}` })
}
function assistant(s: Session, i: number) {
  s.append('assistant.message', { role: 'assistant', content: `a${i}` })
}

describe('trimText', () => {
  it('超长保留头尾 + 标记', () => {
    const t = trimText('x'.repeat(10000))
    expect(t).toContain('已裁剪')
    expect(t).toContain('x'.repeat(1000)) // tail 保留
    expect(t.length).toBeLessThan(4000)
  })
  it('短文本原样', () => {
    expect(trimText('hi')).toBe('hi')
  })
})

describe('大 tool.result 裁剪', () => {
  it('>maxToolBytes → 追加裁剪节点 shadow 原事件；原事件仍在 transcript', () => {
    const s = new Session()
    seedSystem(s, 'sys')
    user(s, 1)
    assistant(s, 1)
    s.append('tool.call', { tool_name: 'file_read', tool_call_id: 'c1', arguments: '{}' })
    const big = 'D'.repeat(20_000)
    const orig = s.append('tool.result', { role: 'tool', tool_name: 'file_read', tool_call_id: 'c1', content: big })

    expect(compactIfNeeded(s, { maxToolBytes: 8000 })).toBe(true)

    const msgs = s.messages()
    const toolMsg = msgs.find((m: ChatMessage) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect((toolMsg?.content ?? '').length).toBeLessThan(4000)
    expect(toolMsg?.content).toContain('已裁剪')
    expect(toolMsg?.tool_call_id).toBe('c1')

    // 原 20KB 事件保留（审计），投影里被 shadow 掉
    expect(s.transcript().some((e) => e.seq === orig.seq && e.content!.length === 20_000)).toBe(true)
    expect(s.transcript().filter((e) => e.type === 'context.compact')).toHaveLength(0)
  })

  it('消息少但单条超大也裁剪（不看计数）', () => {
    const s = new Session()
    seedSystem(s, 'sys')
    s.append('tool.call', { tool_name: 'file_read', tool_call_id: 'c2' })
    s.append('tool.result', { role: 'tool', tool_call_id: 'c2', content: 'Z'.repeat(9000) })
    expect(compactIfNeeded(s, { maxToolBytes: 8000, capacity: 20, triggerPercent: 20 })).toBe(true)
  })
})

describe('计数压缩（surface > high → shadow 最旧到 low）', () => {
  function longSession(): Session {
    const s = new Session()
    seedSystem(s, 'sys')
    for (let i = 1; i <= 5; i++) {
      user(s, i)
      assistant(s, i)
    }
    return s
  }

  it('capacity=6 (high4/low3)：从 11 条压到 ≤3，system 保留在最前', () => {
    const s = longSession()
    expect(s.messages().length).toBe(11)
    expect(compactIfNeeded(s, { capacity: 6, triggerPercent: 20 })).toBe(true)
    const msgs = s.messages()
    expect(msgs.length).toBeLessThanOrEqual(3)
    expect(msgs[0].role).toBe('system') // system.context 永不被 shadow
    expect(s.transcript().filter((e) => e.type === 'context.compact').length).toBeGreaterThan(0)
  })

  it('未接近满（≤high）不压缩', () => {
    const s = longSession() // 11 条
    // capacity 20 → high 16；11 ≤ 16 不压缩（无大工具结果则无任何动作）
    expect(compactIfNeeded(s, { capacity: 20, triggerPercent: 20 })).toBe(false)
    expect(s.messages().length).toBe(11)
  })

  it('capacity<=0 禁用', () => {
    const s = longSession()
    expect(compactIfNeeded(s, { capacity: 0 })).toBe(false)
    expect(s.messages().length).toBe(11)
  })

  it('幂等：压到 low 后再调用无动作', () => {
    const s = longSession()
    compactIfNeeded(s, { capacity: 6, triggerPercent: 20 })
    const after = s.messages().length
    expect(compactIfNeeded(s, { capacity: 6, triggerPercent: 20 })).toBe(false)
    expect(s.messages().length).toBe(after)
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

  it('压缩到 low 后：不残留孤立 tool（无前置 tool_calls 的 tool.result）', () => {
    const { s } = toolRound()
    // capacity=5 → high4/low3；首轮会需要移除 assistant(tool_calls)
    compactIfNeeded(s, { capacity: 5, triggerPercent: 20 })

    const msgs = s.messages()
    const toolIdx = msgs.findIndex((m) => m.role === 'tool')
    if (toolIdx >= 0) {
      // 若仍有 tool 消息，其前面必须存在带 tool_calls 的 assistant
      const prev = msgs[toolIdx - 1]
      expect(prev?.role).toBe('assistant')
      expect((prev?.tool_calls as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('assistant(tool_calls) 与其 tool.result 在同一 compact 单元里被一起 shadow', () => {
    const { s, asstSeq, toolSeq } = toolRound()
    compactIfNeeded(s, { capacity: 5, triggerPercent: 20 })
    const compacts = s.transcript().filter((e) => e.type === 'context.compact')
    const inSame = compacts.some(
      (e) => (e.shadow_seqs ?? []).includes(asstSeq) && (e.shadow_seqs ?? []).includes(toolSeq),
    )
    expect(inSame).toBe(true)
  })
})
