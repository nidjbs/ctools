// 剪贴板历史（append-only jsonl）+ 可注入 watcher。specs/clipboard.md。
// 命令调用走 ctx.clipboard；watcher 在 Main 常驻轮询系统剪贴板（读函数可注入以便单测）。
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ClipItem } from '../shared/types'

/** token 交集分数（候选检索用，纯函数）。 */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  const tb = new Set(b.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of tb) if (ta.has(t)) inter++
  return inter / Math.max(ta.size, tb.size)
}

export class ClipboardStore {
  private last?: string

  constructor(private readonly file: string) {}

  /** 记录一条（去重与上条相同）。返回是否写入。 */
  record(text: string): boolean {
    const t = text.trim()
    if (!t || t === this.last) return false
    this.last = t
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify({ text: t, ts: Date.now() }) + '\n', 'utf-8')
    return true
  }

  private load(): ClipItem[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ClipItem
        } catch {
          return null
        }
      })
      .filter((i): i is ClipItem => !!i)
  }

  /** 最近 n 条，新→旧。 */
  recent(n: number): ClipItem[] {
    return this.load().slice(-n).reverse()
  }

  /** query 检索候选：有 token 交集的较新条目，按 相关度+新近 排序取 n；无交集回退最近。 */
  candidates(query: string, n: number): ClipItem[] {
    const pool = this.load().slice(-200)
    const scored = pool
      .map((i, idx) => ({ ...i, idx, score: tokenOverlap(query, i.text) }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score || b.idx - a.idx)
    return scored.slice(0, n).map(({ text, ts }) => ({ text, ts }))
  }
}

/** 常驻轮询 watcher：read 返回当前剪贴板文本（sync 或 async）；变化经 store.record 落历史。返回停止函数。 */
export function startClipboardWatch(
  store: ClipboardStore,
  read: () => string | Promise<string>,
  intervalMs = 1500,
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        store.record(await read())
      } catch {
        /* 读剪贴板失败静默 */
      }
    })()
  }, intervalMs)
  return () => clearInterval(timer)
}
