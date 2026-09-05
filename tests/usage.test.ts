import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageStore } from '../src/main/usage'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function freshStore(): { dir: string; store: UsageStore } {
  const dir = mkdtempSync(join(tmpdir(), 'ctools-'))
  return { dir, store: new UsageStore(dir) }
}

describe('usage', () => {
  it('按最近使用排序(MRU)', async () => {
    const { store } = freshStore()
    store.record('a')
    await sleep(3)
    store.record('b')
    await sleep(3)
    store.record('a') // a 再次使用 → 移到最前
    expect(store.recent(10)).toEqual(['a', 'b'])
  })

  it('recent 受 limit 限制', async () => {
    const { store } = freshStore()
    for (const id of ['a', 'b', 'c']) store.record(id)
    expect(store.recent(2)).toEqual(['c', 'b'])
  })

  it('持久化: 重启后保留顺序', () => {
    const { dir } = freshStore()
    const s1 = new UsageStore(dir)
    s1.record('a')
    s1.record('b')
    const s2 = new UsageStore(dir) // 模拟重启
    expect(s2.recent(10)).toEqual(['b', 'a'])
  })
})
