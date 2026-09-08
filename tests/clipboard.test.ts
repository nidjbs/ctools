// clipboard：历史存取 / 候选检索 / 本地模型召回 / 白名单隔离。specs/clipboard.md。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClipboardStore, tokenOverlap, startClipboardWatch } from '../src/main/clipboard'
import { clipboardCmd, recallByModel } from '../commands/clipboard'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx, ClipItem } from '../src/shared/types'

let file: string
let store: ClipboardStore
let ctx: Ctx

function seed(...texts: string[]) {
  store = new ClipboardStore(file)
  for (const t of texts) store.record(t)
  ctx = {
    config: { defaultAlias: 'common', clipboardLocalAlias: 'local', writeConfirm: 'auto', hotkey: 'x', enabledCommands: {} } as AppConfig,
    clipboard: {
      recent: (n) => Promise.resolve(store.recent(n)),
      candidates: (q, n) => Promise.resolve(store.candidates(q, n)),
      current: async () => '',
    },
    gateway: {
      models: async () => ['local'],
      chat: async () => ({ content: '2' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
}

beforeAll(() => {
  file = join(mkdtempSync(join(tmpdir(), 'ctools-clip-')), 'clip.jsonl')
  store = new ClipboardStore(file)
})
afterAll(() => rmSync(join(file, '..'), { recursive: true, force: true }))

describe('ClipboardStore', () => {
  it('record 去重（与上条相同跳过），recent 新→旧', () => {
    seed('aaa', 'bbb')
    expect(store.record('ccc')).toBe(true)
    expect(store.record('ccc')).toBe(false) // 与上条相同
    const r = store.recent(10)
    expect(r.map((i) => i.text)).toEqual(['ccc', 'bbb', 'aaa'])
  })

  it('tokenOverlap 纯函数（含中文按字）', () => {
    expect(tokenOverlap('发票 金额', '发票 1000 元')).toBeGreaterThan(0)
    expect(tokenOverlap('发票金额', '发票：金额 1000 元 增值税')).toBeGreaterThan(0)
    expect(tokenOverlap('发票', '会议室 明天')).toBe(0)
  })

  it('candidates 按交集返回；无交集为空', () => {
    seed('发票 金额 1000 元', '会议室 预定 明天', '地址 北京 朝阳')
    const hit = store.candidates('发票', 10)
    expect(hit[0]?.text).toContain('发票')
    expect(store.candidates('不存在的词xyz', 3)).toEqual([])
  })
})

describe('watcher（注入 read）', () => {
  it('变化记录、相同静默、stop 停止', async () => {
    store = new ClipboardStore(file)
    let current = 'first'
    const stop = startClipboardWatch(store, () => current, 20)
    await new Promise((r) => setTimeout(r, 60))
    expect(store.recent(10).some((i) => i.text === 'first')).toBe(true)
    current = 'same-value'
    await new Promise((r) => setTimeout(r, 60))
    current = 'third'
    await new Promise((r) => setTimeout(r, 60))
    const texts = store.recent(20).map((i) => i.text)
    expect(texts.filter((t) => t === 'same-value')).toHaveLength(1) // 重复不写
    expect(texts).toContain('third')
    stop()
    current = 'after-stop'
    await new Promise((r) => setTimeout(r, 60))
    expect(store.recent(20).some((i) => i.text === 'after-stop')).toBe(false)
  })
})

describe('clipboard 命令', () => {
  it('空参数 → 历史列表', async () => {
    seed('t1 hello', 't2 world')
    const r = await clipboardCmd.run('', ctx)
    expect(r.type).toBe('list')
    if (r.type === 'list') expect(r.items.some((i) => i.copy === 't1 hello')).toBe(true)
  })

  it('find → 本地模型挑编号并返回可复制的条目', async () => {
    seed('地址：北京朝阳望京SOHO', '发票：金额 1000 元 增值税', '会议：明天10点 腾讯会议')
    const r = await clipboardCmd.run('发票金额', ctx)
    expect(r.type).toBe('list')
    if (r.type === 'list') expect(r.items[0].copy).toContain('发票')
  })

  it('未配本地 alias → 回退普通默认模型召回', async () => {
    seed('地址：北京朝阳望京', '发票：金额 1000 元 增值税')
    const noLocal = { ...ctx, config: { ...ctx.config, clipboardLocalAlias: '' } }
    const r = await clipboardCmd.run('发票金额', noLocal)
    expect(r.type).toBe('list')
    if (r.type === 'list') expect(r.items[0].copy).toContain('发票')
  })

  it('本地与默认都未配置 → 提示', async () => {
    seed('x')
    const none = { ...ctx, config: { ...ctx.config, clipboardLocalAlias: '', defaultAlias: '' } }
    const r = await clipboardCmd.run('找找', none)
    expect(r.type).toBe('text')
    if (r.type === 'text') expect(r.text).toContain('未配置可用模型')
  })

  it('无历史时也读当前剪贴板：空参列出、find 可召回', async () => {
    // 用一个空历史的新 store
    const f2 = join(file, '..', 'clip-empty.jsonl')
    const s2 = new ClipboardStore(f2)
    const curCtx = {
      ...ctx,
      clipboard: {
        recent: (n: number) => Promise.resolve(s2.recent(n)),
        candidates: (q: string, n: number) => Promise.resolve(s2.candidates(q, n)),
        current: async () => '发票：金额 1000 元 增值税专用发票',
      },
    }
    // 空参：历史列表含当前
    const listR = await clipboardCmd.run('', curCtx)
    expect(listR.type).toBe('list')
    if (listR.type === 'list') expect(listR.items.some((i) => i.copy?.includes('发票'))).toBe(true)
    // find：直接基于当前召回
    const findR = await clipboardCmd.run('发票', curCtx)
    expect(findR.type).toBe('list')
    if (findR.type === 'list') expect(findR.items[0].copy).toContain('发票')
  })

  it('无匹配：提示未搜到并展示最近剪贴板（不静默）', async () => {
    seed('aaa')
    const r = await clipboardCmd.run('zzzz不存在的词', ctx)
    expect(r.type).toBe('list')
    if (r.type === 'list') {
      expect(r.items[0].title).toContain('未搜到')
      expect(r.items.some((i) => i.copy === 'aaa')).toBe(true) // 最近可复制
    }
  })

  it('recallByModel：ask 解析失败回退第 1 条', async () => {
    const items: ClipItem[] = [{ text: '甲', ts: 1 }, { text: '乙', ts: 2 }]
    const picked = await recallByModel('q', items, async () => 'not a number')
    expect(picked.text).toBe('甲')
  })
})

describe('白名单：clipboard 不暴露给 agent', () => {
  it('toolIds 不含 clipboard', () => {
    const r = new Registry().registerAll([clipboardCmd])
    expect(r.toolIds()).not.toContain('clipboard')
  })
})
