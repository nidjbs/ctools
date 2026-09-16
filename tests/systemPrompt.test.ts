// 每轮 system 段（specs/system-prompt.md）：环境 + 记忆 + 日期，顺序严格「稳定 → 易变」。
import { describe, expect, it } from 'vitest'
import { buildTurnSystem, dateLine } from '../src/main/systemPrompt'
import { defaultConfig } from '../src/main/config'

const NOW = new Date('2026-09-17T10:30:00')

function build(over: Partial<Parameters<typeof buildTurnSystem>[0]> = {}) {
  return buildTurnSystem({ config: defaultConfig(), tools: [], now: NOW, ...over })
}

describe('dateLine（R1：粒度只到天）', () => {
  it('格式 YYYY-MM-DD + 星期，不含时分秒', () => {
    const line = dateLine(NOW)
    expect(line).toBe('今天是 2026-09-17 周四。')
    expect(line).not.toMatch(/\d{2}:\d{2}/)
  })
})

describe('buildTurnSystem 顺序（R3：稳定 → 易变）', () => {
  it('工作目录在前，日期在最后', () => {
    const out = build()
    expect(out.indexOf('工作目录')).toBeLessThan(out.indexOf('今天是'))
    expect(out.trimEnd().endsWith(dateLine(NOW))).toBe(true)
  })

  it('记忆索引与 pinned 排在日期之前', () => {
    const out = build({ memoryIndex: '# 记忆索引\n- [A](a1) — 甲', pinnedText: '- 常驻事实' })
    expect(out.indexOf('记忆索引')).toBeLessThan(out.indexOf('今天是'))
    expect(out.indexOf('常驻记忆')).toBeLessThan(out.indexOf('今天是'))
  })
})

describe('环境段', () => {
  it('工作目录 = fileRoots[0]（与 bash cwd 一致）', () => {
    const out = build({ config: { ...defaultConfig(), fileRoots: ['/tmp/proj', '/tmp/other'] } })
    expect(out).toContain('工作目录（bash cwd）: /tmp/proj')
    expect(out).toContain('可写范围（file_roots）: /tmp/proj, /tmp/other')
  })

  it('fileRoots 为空 → 明示未配置，不省略该行', () => {
    const out = build()
    expect(out).toContain('未配置，文件工具不可用')
  })

  it('工具要点只列已启用的工具（不宣传不存在的）', () => {
    expect(build({ tools: [] })).not.toContain('工具要点')
    expect(build({ tools: ['file_read'] })).toContain('行区间')
    const out = build({ tools: ['file_edit', 'grep', 'ask'] })
    expect(out).toContain('file_edit')
    expect(out).toContain('grep')
    expect(out).toContain('ask')
  })
})

describe('injectDate 开关', () => {
  it('false → 省略日期行（换取完全稳定的 system）', () => {
    const out = build({ config: { ...defaultConfig(), injectDate: false } })
    expect(out).not.toContain('今天是')
    expect(out).toContain('工作目录') // 其余仍在
  })
})

describe('记忆段省略', () => {
  it('无索引 / 无 pinned → 不留空标题', () => {
    const out = build({ memoryIndex: '  ', pinnedText: '' })
    expect(out).not.toContain('记忆索引')
    expect(out).not.toContain('常驻记忆')
  })
})
