// 本地 token 估算（specs/context.md）：ASCII ≈ 4 字符/token，CJK ≈ 1 字符/token。
import { describe, expect, it } from 'vitest'
import { estimateTokens, estimateMessagesTokens } from '../src/shared/tokens'

describe('estimateTokens', () => {
  it('空串 → 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('ASCII 按 4 字符/token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('CJK 按 1 字符/token', () => {
    expect(estimateTokens('中文四个字')).toBe(5)
  })

  it('中英混合分别计', () => {
    // 4 ASCII(=1) + 2 CJK(=2)
    expect(estimateTokens('abcd中文')).toBe(3)
  })

  it('保守上界：CJK 不少于字符数', () => {
    const s = '甲'.repeat(50)
    expect(estimateTokens(s)).toBeGreaterThanOrEqual(50)
  })
})

describe('estimateMessagesTokens', () => {
  it('含每条固定开销', () => {
    const a = estimateMessagesTokens([{ content: '' }])
    const b = estimateMessagesTokens([{ content: '' }, { content: '' }])
    expect(b).toBeGreaterThan(a)
  })

  it('计入 tool_calls 的 JSON 长度', () => {
    const calls = [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{"path":"/a"}' } }]
    const withCalls = estimateMessagesTokens([{ content: 'x', tool_calls: calls }])
    const without = estimateMessagesTokens([{ content: 'x' }])
    expect(withCalls).toBeGreaterThan(without)
  })

  it('计入 reasoning_content', () => {
    const withR = estimateMessagesTokens([{ content: 'x', reasoning_content: '甲'.repeat(100) }])
    const without = estimateMessagesTokens([{ content: 'x' }])
    expect(withR).toBeGreaterThan(without + 90)
  })
})
