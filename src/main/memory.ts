// 长期记忆（specs/memory.md）：memory.jsonl 为唯一事实源（append-only + tombstone），
// MEMORY.md 是由 live() 投影生成的索引页，供人阅读 + 常驻注入。
// 召回为本地关键词打分（不引入 embedding：网关无 /v1/embeddings，且向量服务可能远端）。
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryHit, MemoryMeta } from '../shared/types'
import { isCjk } from '../shared/tokens'

export type MemoryKind = 'fact' | 'preference' | 'procedure'
export type MemoryOp = 'add' | 'update' | 'forget'

/** jsonl 行（审计原文）。 */
export interface MemoryRecord {
  id: string
  op: MemoryOp
  ts: string
  title?: string
  gist?: string
  text?: string
  kind?: MemoryKind
  tags?: string[]
  pinned?: boolean
  source?: string
}

const TEXT_MAX = 500
const TITLE_MAX = 20
const GIST_MAX = 60
const PINNED_MAX = 20
const RECALL_K = 5
const HIT_TEXT_MAX = 2000

const W_TAG = 3
const W_TITLE = 2
const W_GIST = 1
const W_TEXT = 0.5

const INDEX_HEAD = '# 记忆索引\n\n<!-- 由 cTools 自动生成；手改会被下次写入覆盖，源: memory.jsonl -->\n'

/** 切词：ASCII 按词；CJK 按单字 + bigram（无需分词器即可中文召回）。 */
export function tokenize(s: string): string[] {
  const lower = s.toLowerCase()
  const out = new Set<string>()
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) out.add(m[0])
  const cjk = [...lower].filter(isCjk)
  for (let i = 0; i < cjk.length; i++) {
    out.add(cjk[i])
    if (i + 1 < cjk.length) out.add(cjk[i] + cjk[i + 1])
  }
  return [...out]
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function toMeta(r: MemoryRecord): MemoryMeta {
  return {
    id: r.id,
    title: r.title ?? '',
    gist: r.gist ?? '',
    kind: r.kind,
    tags: r.tags,
    pinned: r.pinned,
    ts: r.ts,
    source: r.source,
  }
}

export class MemoryStore {
  /** id → 折叠后的当前状态。 */
  private readonly live_ = new Map<string, MemoryRecord>()

  constructor(private readonly dir: string) {
    this.load()
  }

  private jsonlPath(): string {
    return join(this.dir, 'memory.jsonl')
  }

  private indexPath(): string {
    return join(this.dir, 'MEMORY.md')
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.jsonlPath(), 'utf-8')
    } catch {
      return // 首次运行无文件
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        this.fold(JSON.parse(line) as MemoryRecord)
      } catch {
        /* 坏行跳过：不因单行损坏丢整库 */
      }
    }
  }

  /** 投影折叠：add/update 覆盖当前状态，forget 移除。 */
  private fold(r: MemoryRecord): void {
    if (!r?.id) return
    if (r.op === 'forget') {
      this.live_.delete(r.id)
      return
    }
    const prev = this.live_.get(r.id)
    this.live_.set(r.id, r.op === 'update' && prev ? { ...prev, ...r, op: 'add' } : { ...r, op: 'add' })
  }

  private append(r: MemoryRecord): void {
    this.fold(r)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.jsonlPath(), JSON.stringify(r) + '\n', 'utf-8')
      this.rewriteIndex()
    } catch {
      /* 写盘失败不改内存投影；索引可重建 */
    }
  }

  /** 按 ts 降序的活动记忆。 */
  private rows(): MemoryRecord[] {
    return [...this.live_.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1))
  }

  list(): MemoryMeta[] {
    return this.rows().map(toMeta)
  }

  add(input: { text: string; title?: string; kind?: MemoryKind; tags?: string[]; source?: string }): MemoryMeta {
    const text = (input.text ?? '').trim()
    if (!text) throw new Error('记忆内容不能为空')
    const clipped = clip(text, TEXT_MAX)
    const rec: MemoryRecord = {
      id: randomUUID().slice(0, 8),
      op: 'add',
      ts: new Date().toISOString(),
      title: input.title?.trim() || clip(clipped.replace(/\s+/g, ' '), TITLE_MAX),
      gist: clip(clipped.replace(/\s+/g, ' '), GIST_MAX),
      text: clipped,
      kind: input.kind,
      tags: input.tags?.filter(Boolean),
      ...(input.source ? { source: input.source } : {}),
    }
    this.append(rec)
    return toMeta(rec)
  }

  forget(id: string): void {
    if (!this.live_.has(id)) return // 幂等
    this.append({ id, op: 'forget', ts: new Date().toISOString() })
  }

  setPinned(id: string, pinned: boolean): void {
    if (!this.live_.has(id)) return
    this.append({ id, op: 'update', ts: new Date().toISOString(), pinned })
  }

  /** 本地关键词召回：索引（tags/title/gist）打分 → 命中取正文。 */
  recall(query: string, k = RECALL_K): MemoryHit[] {
    const terms = tokenize(query)
    if (!terms.length) return []
    const scored: Array<{ r: MemoryRecord; score: number }> = []
    for (const r of this.rows()) {
      const tags = (r.tags ?? []).join(' ').toLowerCase()
      const title = (r.title ?? '').toLowerCase()
      const gist = (r.gist ?? '').toLowerCase()
      const text = (r.text ?? '').toLowerCase()
      let score = 0
      for (const t of terms) {
        if (tags.includes(t)) score += W_TAG
        if (title.includes(t)) score += W_TITLE
        if (gist.includes(t)) score += W_GIST
        if (text.includes(t)) score += W_TEXT
      }
      if (score > 0) scored.push({ r, score })
    }
    scored.sort((a, b) => b.score - a.score || (a.r.ts < b.r.ts ? 1 : -1))
    return scored.slice(0, k).map(({ r }) => ({ ...toMeta(r), text: clip(r.text ?? '', HIT_TEXT_MAX) }))
  }

  /** pinned 正文拼接（上限内、按 ts 新近）；无则 ''。 */
  pinnedText(): string {
    const pinned = this.rows().filter((r) => r.pinned).slice(0, PINNED_MAX)
    return pinned.map((r) => `- ${r.text ?? ''}`).join('\n')
  }

  /** 索引页全文；空库返回 ''（调用方据此省略整段）。 */
  index(): string {
    const rows = this.rows()
    if (!rows.length) return ''
    return this.renderIndex(rows).trim()
  }

  private renderIndex(rows = this.rows()): string {
    if (!rows.length) return INDEX_HEAD
    const lines = rows.map((r) => `- [${r.pinned ? '⭐ ' : ''}${r.title ?? ''}](${r.id}) — ${r.gist ?? ''}`)
    return `${INDEX_HEAD}\n${lines.join('\n')}\n`
  }

  /** 索引页是投影产物，写盘仅为便于人阅读/外部工具。 */
  private rewriteIndex(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.indexPath(), this.renderIndex(), 'utf-8')
    } catch {
      /* 索引可重建，失败不影响 jsonl */
    }
  }
}
