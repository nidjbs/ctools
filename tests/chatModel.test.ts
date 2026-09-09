// chatModel：agent 工具过程可见的渲染纯函数（摘要/截断/参数预览）。
import { describe, expect, it } from 'vitest'
import { toolResultSummary, toolParamPreview, toolRowOf, runStatusLabel } from '../src/shared/chatModel'
import type { SessionEvent } from '../src/shared/types'

const ev = (t: SessionEvent['type'], extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ event_id: 'x', session_id: 's', seq: 1, type: t, occurred_at: '', ...extra }) as SessionEvent

describe('toolResultSummary', () => {
  it('≤200 字原文', () => {
    expect(toolResultSummary('found 1 file')).toBe('found 1 file')
  })
  it('>200 字 → 截断并标全长', () => {
    const long = 'a'.repeat(600)
    const s = toolResultSummary(long)
    expect(s.length).toBe(200 + '…(共 600 字)'.length)
    expect(s.endsWith('…(共 600 字)')).toBe(true)
  })
  it('空白/undefined → (空)', () => {
    expect(toolResultSummary('')).toBe('(空)')
    expect(toolResultSummary(undefined)).toBe('(空)')
    expect(toolResultSummary('   ')).toBe('(空)')
  })
})

describe('toolParamPreview', () => {
  it('空参数 → 空串', () => {
    expect(toolParamPreview('')).toBe('')
    expect(toolParamPreview(undefined)).toBe('')
  })
  it('长参数截 120', () => {
    const long = '{"p":"' + 'x'.repeat(200) + '"}'
    const s = toolParamPreview(long)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toHaveLength(120 + 1)
  })
})

describe('runStatusLabel', () => {
  it('有正在执行工具 → 执行中文案', () => {
    expect(runStatusLabel('file_read', false)).toBe('正在执行 file_read…')
  })
  it('无工具但有流式正文 → 生成中', () => {
    expect(runStatusLabel(null, true)).toBe('生成中…')
  })
  it('无工具且无正文 → 思考中', () => {
    expect(runStatusLabel(null, false)).toBe('思考中…')
  })
})

describe('toolRowOf', () => {
  it('tool.call → call 行 + 参数预览', () => {
    expect(toolRowOf(ev('tool.call', { tool_name: 'find_file', arguments: '{"query":"发票"}' }))).toEqual({
      kind: 'call',
      tool: 'find_file',
      params: '{"query":"发票"}',
    })
  })
  it('tool.result → result 行 + 摘要', () => {
    expect(toolRowOf(ev('tool.result', { tool_name: 'file_read', content: '/a/b.txt' }))).toEqual({
      kind: 'result',
      tool: 'file_read',
      summary: '/a/b.txt',
    })
  })
  it('非 tool 事件 → null', () => {
    expect(toolRowOf(ev('assistant.message', { content: 'hi' }))).toBeNull()
    expect(toolRowOf(ev('user.message', { content: 'hi' }))).toBeNull()
  })
})
