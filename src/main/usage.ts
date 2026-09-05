// 命令使用记录：Launcher 空输入时展示最近常用。记录 lastUsed+count，落盘、可单测。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageRecord {
  id: string
  count: number
  lastUsed: string // ISO 时间
}

const MAX_RECORDS = 50

export class UsageStore {
  private readonly records = new Map<string, UsageRecord>()

  constructor(private readonly dir: string) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf-8')) as UsageRecord[]
      for (const r of raw) this.records.set(r.id, r)
    } catch {
      /* 首次运行无文件 */
    }
  }

  /** 记录一次命令使用（幂等：重复运行移到最前并累加 count）。 */
  record(id: string): void {
    const cur = this.records.get(id)
    this.records.set(id, { id, count: (cur?.count ?? 0) + 1, lastUsed: new Date().toISOString() })
    this.prune()
    this.persist()
  }

  /** 最近使用（MRU）的命令 id，按 lastUsed 降序。 */
  recent(limit: number): string[] {
    return [...this.records.values()]
      .sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : -1))
      .slice(0, limit)
      .map((r) => r.id)
  }

  private prune(): void {
    if (this.records.size <= MAX_RECORDS) return
    const sorted = [...this.records.values()].sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : -1))
    for (const r of sorted.slice(MAX_RECORDS)) this.records.delete(r.id)
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, 'usage.json'), JSON.stringify([...this.records.values()], null, 2), 'utf-8')
  }
}
