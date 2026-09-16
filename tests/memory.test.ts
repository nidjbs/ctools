// 长期记忆（specs/memory.md）：jsonl 事实源 + tombstone 折叠、索引页生成、本地关键词召回、pinned。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, tokenize } from '../src/main/memory'
import { Registry } from '../src/main/registry'
import { Session } from '../src/main/session'
import { runAgentTurn } from '../src/main/agent'
import { rememberCmd, forgetCmd, recallCmd, memoryListCmd } from '../commands/memory'
import { defaultConfig } from '../src/main/config'
import type { AppConfig, Ctx } from '../src/shared/types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-mem-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('tokenize', () => {
  it('ASCII 按词；CJK 出单字 + bigram', () => {
    const t = tokenize('部署 deploy')
    expect(t).toContain('deploy')
    expect(t).toContain('部')
    expect(t).toContain('部署')
  })
})

describe('add / list', () => {
  it('写入后可列出，title/gist 有缺省', () => {
    const m = new MemoryStore(dir)
    const meta = m.add({ text: '用户偏好中文文档，代码注释用英文' })
    expect(meta.id).toHaveLength(8)
    expect(meta.title).toBe('用户偏好中文文档，代码注释用英文'.slice(0, 20))
    expect(meta.gist.length).toBeLessThanOrEqual(61)
    expect(m.list()).toHaveLength(1)
  })

  it('显式 title/kind/tags 透传', () => {
    const m = new MemoryStore(dir)
    const meta = m.add({ text: 'x', title: '部署流程', kind: 'procedure', tags: ['deploy'] })
    expect(meta).toMatchObject({ title: '部署流程', kind: 'procedure', tags: ['deploy'] })
  })

  it('空 text 报错；超长截断到 500', () => {
    const m = new MemoryStore(dir)
    expect(() => m.add({ text: '   ' })).toThrow('记忆内容不能为空')
    const meta = m.add({ text: '甲'.repeat(900) })
    expect(meta.gist.length).toBeLessThanOrEqual(61)
    expect(m.recall('甲')[0].text.length).toBeLessThanOrEqual(501)
  })

  it('按 ts 降序（新的在前）', () => {
    const m = new MemoryStore(dir)
    m.add({ text: '第一条' })
    m.add({ text: '第二条' })
    expect(m.list()[0].gist).toContain('第二条')
  })
})

describe('forget（tombstone）', () => {
  it('软删后不在投影里，但 jsonl 保留原文（审计）', () => {
    const m = new MemoryStore(dir)
    const a = m.add({ text: '甲' })
    m.forget(a.id)
    expect(m.list()).toHaveLength(0)
    const raw = readFileSync(join(dir, 'memory.jsonl'), 'utf-8')
    expect(raw).toContain('"op":"add"') // 原记录仍在
    expect(raw).toContain('"op":"forget"') // 追加 tombstone
  })

  it('重复 forget 幂等（不再追加 tombstone）', () => {
    const m = new MemoryStore(dir)
    const a = m.add({ text: '甲' })
    m.forget(a.id)
    m.forget(a.id)
    m.forget('nope')
    const lines = readFileSync(join(dir, 'memory.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2) // add + 一次 forget
  })
})

describe('持久化与重放', () => {
  it('新实例重放 jsonl 得到一致投影', () => {
    const m1 = new MemoryStore(dir)
    const a = m1.add({ text: '持久事实', tags: ['t'] })
    const b = m1.add({ text: '要被删的' })
    m1.forget(b.id)
    m1.setPinned(a.id, true)

    const m2 = new MemoryStore(dir)
    expect(m2.list()).toHaveLength(1)
    expect(m2.list()[0]).toMatchObject({ id: a.id, pinned: true })
  })

  it('坏行跳过，不丢整库', () => {
    const m1 = new MemoryStore(dir)
    m1.add({ text: '好的' })
    const p = join(dir, 'memory.jsonl')
    const raw = readFileSync(p, 'utf-8')
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(p, `${raw}{ 坏行\n`, 'utf-8')
    const m2 = new MemoryStore(dir)
    expect(m2.list()).toHaveLength(1)
  })
})

describe('recall（本地关键词召回）', () => {
  it('命中标题/标签，返回正文', () => {
    const m = new MemoryStore(dir)
    m.add({ text: '项目在 /Users/mac/project/ctools', title: '项目位置', tags: ['path'] })
    m.add({ text: '用户偏好中文文档', title: '语言偏好' })
    const hits = m.recall('项目位置')
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toContain('/Users/mac/project/ctools')
  })

  it('标签权重高于正文：标签命中排在仅正文命中之前', () => {
    const m = new MemoryStore(dir)
    m.add({ text: '部署部署部署', title: '甲', tags: ['deploy'] })
    m.add({ text: '关于 deploy 的一点说明', title: '乙' })
    const hits = m.recall('deploy')
    expect(hits[0].tags).toContain('deploy')
  })

  it('无命中 → 空数组；空查询 → 空数组', () => {
    const m = new MemoryStore(dir)
    m.add({ text: '甲' })
    expect(m.recall('完全不相干的词xyz')).toEqual([])
    expect(m.recall('   ')).toEqual([])
  })

  it('k 限制返回条数', () => {
    const m = new MemoryStore(dir)
    for (let i = 0; i < 8; i++) m.add({ text: `共同关键词 alpha ${i}` })
    expect(m.recall('alpha', 3)).toHaveLength(3)
  })

  it('已 forget 的不参与召回', () => {
    const m = new MemoryStore(dir)
    const a = m.add({ text: '秘密甲' })
    m.forget(a.id)
    expect(m.recall('秘密甲')).toEqual([])
  })
})

describe('索引页 MEMORY.md', () => {
  it('写入后生成索引，pinned 带 ⭐', () => {
    const m = new MemoryStore(dir)
    const a = m.add({ text: '常驻事实', title: '甲' })
    m.add({ text: '普通事实', title: '乙' })
    m.setPinned(a.id, true)
    const text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    expect(text).toContain('- [⭐ 甲](')
    expect(text).toContain('- [乙](')
  })

  it('index() 空库返回 ""（调用方据此省略整段）；有记忆则含索引头', () => {
    const m = new MemoryStore(dir)
    expect(m.index()).toBe('')
    m.add({ text: '甲', title: 'T' })
    expect(m.index()).toContain('# 记忆索引')
    expect(m.index()).toContain('[T](')
  })

  it('forget 后索引同步移除', () => {
    const m = new MemoryStore(dir)
    const a = m.add({ text: '甲', title: '会被删' })
    m.forget(a.id)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).not.toContain('会被删')
  })
})

describe('pinnedText', () => {
  it('只含 pinned 正文；无 pinned → ""', () => {
    const m = new MemoryStore(dir)
    expect(m.pinnedText()).toBe('')
    const a = m.add({ text: '常驻的正文' })
    m.add({ text: '普通的正文' })
    expect(m.pinnedText()).toBe('')
    m.setPinned(a.id, true)
    expect(m.pinnedText()).toBe('- 常驻的正文')
  })

  it('超过 20 条只取 20', () => {
    const m = new MemoryStore(dir)
    for (let i = 0; i < 25; i++) {
      const x = m.add({ text: `p${i}` })
      m.setPinned(x.id, true)
    }
    expect(m.pinnedText().split('\n')).toHaveLength(20)
  })
})

/** 脚本化 gateway：按序发出工具调用，脚本用尽则收尾。 */
function scriptedCtx(memory: MemoryStore, script: Array<{ tool: string; args: unknown }>): Ctx {
  let i = 0
  return {
    config: { ...defaultConfig(), fileRoots: ['/tmp'] } as AppConfig,
    memory,
    gateway: {
      models: async () => ['chat'],
      chat: async () => ({ content: '' }),
      chatStream: async (_req, h) => {
        const step = script[i]
        i++
        if (step) {
          h.onToolCalls?.([
            { id: `c${i}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } },
          ])
          h.onFinish?.('tool_calls')
        } else {
          h.onContent('done')
          h.onFinish?.('stop')
        }
      },
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
}

describe('运行时贯通：agent ↔ registry ↔ MemoryStore', () => {
  it('agent 调 remember 落盘 → 新会话 recall 命中', async () => {
    const m = new MemoryStore(dir)
    const registry = new Registry().registerAll([rememberCmd, recallCmd, forgetCmd])

    const s1 = new Session()
    await runAgentTurn(
      s1,
      '记住我的项目位置',
      scriptedCtx(m, [{ tool: 'remember', args: { text: '用户的项目在 /Users/mac/project/ctools', title: '项目位置' } }]),
      registry,
      { onEvent: () => {}, onContent: () => {} },
    )
    const r1 = s1.transcript().find((e) => e.type === 'tool.result')
    expect(r1?.content).toContain('已记住 #')
    expect(m.list()).toHaveLength(1)

    // 新会话（不同 session）召回
    const s2 = new Session()
    await runAgentTurn(
      s2,
      '我的项目在哪',
      scriptedCtx(m, [{ tool: 'recall', args: { query: '项目位置' } }]),
      registry,
      { onEvent: () => {}, onContent: () => {} },
    )
    const r2 = s2.transcript().find((e) => e.type === 'tool.result')
    expect(r2?.content).toContain('/Users/mac/project/ctools')
  })

  it('ctx.sessionId 作为记忆来源落盘（审计）', async () => {
    const m = new MemoryStore(dir)
    const registry = new Registry().register(rememberCmd)
    const s = new Session()
    const c = scriptedCtx(m, [{ tool: 'remember', args: { text: '来源可追溯' } }])
    c.sessionId = s.id
    await runAgentTurn(s, '记一下', c, registry, { onEvent: () => {}, onContent: () => {} })
    expect(m.list()[0].source).toBe(s.id)
  })

  it('agent 调 forget → 该条不再可召回', async () => {
    const m = new MemoryStore(dir)
    const registry = new Registry().registerAll([rememberCmd, forgetCmd, recallCmd])
    const a = m.add({ text: '待删除的记忆', title: '临时' })
    const s = new Session()
    await runAgentTurn(s, '删掉它', scriptedCtx(m, [{ tool: 'forget', args: { id: a.id } }]), registry, {
      onEvent: () => {},
      onContent: () => {},
    })
    expect(m.list()).toHaveLength(0)
    expect(m.recall('待删除')).toEqual([])
  })

  it('agent 不可见 memory 浏览命令（不暴露给模型）', () => {
    const registry = new Registry().registerAll([rememberCmd, forgetCmd, recallCmd, memoryListCmd])
    expect(registry.toolIds()).not.toContain('memory')
    expect(registry.toolIds()).toContain('recall')
    expect(registry.planTools()).toEqual(['recall']) // 仅只读 recall 可入 plan
  })
})
