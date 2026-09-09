// 会话：事件溯源（append-only）。模型可见消息由事件投影生成。见 docs §9.2/9.6。
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent, SessionEventType, SessionSummary } from '../shared/types'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  /** 思考内容原样回传（DeepSeek 推理模型要求）。 */
  reasoning_content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

const TITLE_MAX = 28

/** 从首条 user.message 截 title；无则占位。 */
export function titleOf(events: SessionEvent[]): string {
  for (const e of events) {
    if (e.type === 'user.message') {
      const t = (e.content ?? '').replace(/\s+/g, ' ').trim()
      if (t) return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t
    }
  }
  return '（空会话）'
}

/** 扫描 dir 下 *.jsonl，按 mtime 降序，返回最近若干会话摘要（title 取自首条 user.message）。 */
export function listSessions(dir: string, max = 10): SessionSummary[] {
  let files: string[]
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .sort((a, b) => statSync(join(dir, b.name)).mtimeMs - statSync(join(dir, a.name)).mtimeMs)
      .slice(0, max)
      .map((f) => f.name.slice(0, -'.jsonl'.length))
  } catch {
    return [] // 目录不存在/不可读 → 空
  }
  return files.map((id) => {
    let title = '（空会话）'
    let updatedAt = ''
    try {
      // 只读文件头定位首条 user.message，避免整读大会话
      const raw = readFileSync(join(dir, `${id}.jsonl`), 'utf-8').split('\n').slice(0, 200)
      const evs: SessionEvent[] = []
      for (const line of raw) {
        if (!line.trim()) continue
        try {
          evs.push(JSON.parse(line) as SessionEvent)
        } catch {
          /* 忽略坏行 */
        }
      }
      title = titleOf(evs)
      updatedAt = statSync(join(dir, `${id}.jsonl`)).mtime.toISOString()
    } catch {
      /* 单文件不可读 → 保留占位 */
    }
    return { id, title, updatedAt }
  })
}

/** 扫描 dir 下 *.jsonl，返回 mtime 最新（最近会话）的 session id。 */
export function latestSessionId(dir: string): string | undefined {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
    .sort((a, b) => statSync(join(dir, b.name)).mtimeMs - statSync(join(dir, a.name)).mtimeMs)
  return files[0]?.name.slice(0, -'.jsonl'.length)
}

export class Session {
  readonly id: string
  private events: SessionEvent[] = []
  private seq = 0

  constructor(private readonly dir?: string, id?: string) {
    this.id = id ?? randomUUID().slice(0, 12)
  }

  /** 从 JSONL 重放重建会话（seq 续接，可继续追加写回同一文件）。 */
  static fromJSONL(dir: string, id: string): Session {
    const s = new Session(dir, id)
    const raw = readFileSync(join(dir, `${id}.jsonl`), 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const ev = JSON.parse(line) as SessionEvent
      s.events.push(ev)
      if (ev.seq > s.seq) s.seq = ev.seq
    }
    return s
  }

  append(type: SessionEventType, data: Partial<SessionEvent>): SessionEvent {
    const ev: SessionEvent = {
      event_id: randomUUID(),
      session_id: this.id,
      seq: ++this.seq,
      type,
      occurred_at: new Date().toISOString(),
      ...data,
    }
    this.events.push(ev)
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${this.id}.jsonl`), JSON.stringify(ev) + '\n', 'utf-8')
    }
    return ev
  }

  /** 未被 shadowed 的带 role 事件（surface）。compaction/context 用。 */
  surfaceEvents(): SessionEvent[] {
    const shadowed = new Set<number>()
    for (const e of this.events) for (const s of e.shadow_seqs ?? []) shadowed.add(s)
    return this.events.filter((e) => !shadowed.has(e.seq) && e.role)
  }

  /** 模型可见消息投影：跳过 shadowed（compaction 用），只取带 role 的 surface 事件。 */
  messages(): ChatMessage[] {
    return this.surfaceEvents().map((e) => ({
      role: e.role as ChatMessage['role'],
      content: e.content,
      reasoning_content: e.reasoning_content,
      tool_calls: e.tool_calls,
      tool_call_id: e.tool_call_id,
    }))
  }

  transcript(): SessionEvent[] {
    return [...this.events]
  }
}
