// 会话上下文压缩（TS 移植 cli/context.go，specs/context.md）：
// 1) 大 tool.result 无条件裁剪（一条 256KB 也远超模型窗口）；
// 2) surface 计数接近高水位时 shadow 最旧非 system 消息到低水位。
// 事件溯源：原事件保留，投影据 shadow_seqs 隐藏旧 seq。
import type { SessionEvent } from '../shared/types'
import { Session } from './session'

export interface ContextOpts {
  /** surface 消息计数上限（模型窗口近似）。 */
  capacity: number
  /** 剩余 < triggerPercent% 时触发计数压缩。 */
  triggerPercent: number
  maxToolBytes: number
}

export const DEFAULT_CTX: ContextOpts = { capacity: 20, triggerPercent: 20, maxToolBytes: 8000 }

const HEAD = 2000
const TAIL = 1000

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 大文本裁剪：保留头尾 + 省略标记。 */
export function trimText(text: string): string {
  if (text.length <= HEAD + TAIL) return text
  return `${text.slice(0, HEAD)}\n…[已裁剪，原长 ${text.length} 字符，此处省略]…\n${text.slice(-TAIL)}`
}

/** 执行一轮压缩；返回是否有动作。 */
export function compactIfNeeded(session: Session, opts: Partial<ContextOpts> = {}): boolean {
  const { capacity, triggerPercent, maxToolBytes } = { ...DEFAULT_CTX, ...opts }
  if (capacity <= 0) return false
  const high = Math.floor(capacity * (1 - clamp(triggerPercent, 0, 100) / 100))
  const low = Math.max(1, Math.floor(capacity * 0.6))
  let changed = false

  // 1) 裁剪大 tool.result（不受计数限制）
  for (const ev of session.surfaceEvents()) {
    if (ev.type !== 'tool.result') continue
    const c = ev.content ?? ''
    if (c.length <= maxToolBytes) continue
    session.append('tool.result', {
      role: 'tool',
      tool_name: ev.tool_name,
      tool_call_id: ev.tool_call_id,
      content: trimText(c),
      shadow_seqs: [ev.seq],
      source_seqs: [ev.seq],
    })
    changed = true
  }

  // 2) 计数压缩：仅当 surface > high（接近满），且 high >= low（避免极端小参数死循环）
  // 原子移除：assistant(tool_calls) 与其后续 tool.result 必须同单元消失，
  // 避免留下「孤立 tool 消息」（上游要求 tool 前必有 tool_calls，否则 400/502）。
  if (high >= low && session.surfaceEvents().length > high) {
    while (session.surfaceEvents().length > low) {
      const live = session.surfaceEvents()
      const ev = live.find((e) => e.type !== 'system.context')
      if (!ev) break
      const seqs: number[] = [ev.seq]
      if (ev.type === 'assistant.message' && (ev.tool_calls?.length ?? 0) > 0) {
        const ids = new Set(
          (ev.tool_calls as { id?: string }[]).map((tc) => tc.id).filter(Boolean) as string[],
        )
        for (const e2 of live) {
          if (e2.seq === ev.seq) continue
          if (e2.type !== 'tool.result') continue
          if (e2.tool_call_id && ids.has(e2.tool_call_id)) seqs.push(e2.seq)
        }
      }
      session.append('context.compact', { shadow_seqs: seqs })
      changed = true
    }
  }
  return changed
}
