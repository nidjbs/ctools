// 会话上下文工程（specs/context.md）：
// 1) 大 tool.result 外置到 spill 目录，上下文里换成「头尾 + 可回取路径」；
// 2) surface 超水位时先让模型**摘要**该批（落 context.summary），再 shadow 原批次 —— 不丢任务目标；
// 3) 条数作兜底；原子移除 assistant(tool_calls) 与其 tool.result，避免孤立 tool 消息触发上游 400。
// 事件溯源：原事件一律保留，投影据 shadow_seqs 隐藏。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from '../shared/types'
import { Session, type ChatMessage } from './session'
import { estimateMessagesTokens, estimateTokens } from '../shared/tokens'

export interface ContextOpts {
  /** surface 消息的 token 上限（模型窗口近似，扣除输出余量）。 */
  capacityTokens: number
  /** 条数兜底（极端小参数/超长单条时仍能收敛）。 */
  capacityCount: number
  /** 剩余 < triggerPercent% 时触发压缩。 */
  triggerPercent: number
  maxToolBytes: number
  /** 大结果外置目录；缺省则退化为纯头尾裁剪。 */
  spillDir?: string
  /** 摘要器；缺省/返回 undefined 则退回「直接丢头」。 */
  summarize?: Summarizer
}

export const DEFAULT_CTX: ContextOpts = {
  capacityTokens: 24000, // ≈32k 窗口留 25% 余量
  capacityCount: 200,
  triggerPercent: 20,
  maxToolBytes: 8000,
}

const HEAD = 2000
const TAIL = 1000
/** 单次摘要的批次上限（条），避免把整段历史一次塞给摘要模型。 */
const SUMMARY_BATCH_MAX = 30
/** 不参与**兜底丢头**的事件类型（角色 + 摘要）。摘要的退役只由「摘要合并」显式处理。 */
const KEEP_TYPES = new Set(['system.context', 'context.summary'])

export type Summarizer = (
  msgs: Array<{ role: string; content?: string }>,
) => Promise<string | undefined>

export const SUMMARY_PROMPT =
  '以下是本会话早期的一段对话，即将被压缩掉。请用中文简要总结，覆盖：\n' +
  '1) 任务目标；2) 已完成的事；3) 关键结论/数据/路径；4) 未完成的待办。\n' +
  '只输出总结正文，不要前言、标题或客套。'

/** 由 gateway.chat 构造摘要器（走 defaultAlias；被摘要内容本就在上下文里，不产生新外传）。 */
export function makeSummarizer(
  chat: (req: { model: string; messages: unknown[] }) => Promise<{ content: string }>,
  model: string,
): Summarizer {
  return async (msgs) => {
    try {
      const r = await chat({
        model,
        messages: [{ role: 'system', content: SUMMARY_PROMPT }, ...msgs],
      })
      return r.content?.trim() || undefined
    } catch {
      return undefined // 失败 → 退回直接丢头，不阻断主流程
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 大文本裁剪：保留头尾 + 省略标记（spill 不可用时的降级路径）。 */
export function trimText(text: string): string {
  if (text.length <= HEAD + TAIL) return text
  return `${text.slice(0, HEAD)}\n…[已裁剪，原长 ${text.length} 字符，此处省略]…\n${text.slice(-TAIL)}`
}

/** 把全文写到 spill 目录，返回可回取的绝对路径；失败返回 null。 */
function spillFull(eventId: string, content: string, spillDir: string): string | null {
  try {
    mkdirSync(spillDir, { recursive: true })
    const p = join(spillDir, `${eventId}.txt`)
    writeFileSync(p, content, 'utf-8')
    return p
  } catch {
    return null
  }
}

/** 外置后的替换正文：头尾 + 回取指引（无 spill 则退化为纯裁剪）。 */
export function spillText(content: string, path: string | null): string {
  const head = content.slice(0, HEAD)
  const tail = content.slice(-TAIL)
  const note = path
    ? `…[完整结果已存至 ${path}，可用 file_read 读取]…`
    : `…[已裁剪，原长 ${content.length} 字符，此处省略]…`
  return `${head}\n${note}\n${tail}`
}

/** 执行一轮压缩；返回是否有动作。 */
export async function compactIfNeeded(session: Session, opts: Partial<ContextOpts> = {}): Promise<boolean> {
  const { capacityTokens, capacityCount, triggerPercent, maxToolBytes, spillDir, summarize } = {
    ...DEFAULT_CTX,
    ...opts,
  }
  if (capacityTokens <= 0) return false
  const pct = clamp(triggerPercent, 0, 100) / 100
  const highTokens = Math.floor(capacityTokens * (1 - pct))
  const lowTokens = Math.max(1, Math.floor(capacityTokens * 0.6))
  const highCount = Math.floor(capacityCount * (1 - pct))
  const lowCount = Math.max(1, Math.floor(capacityCount * 0.6))
  const overHigh = () =>
    estimateMessagesTokens(session.messages()) > highTokens || session.surfaceEvents().length > highCount
  const overLow = () =>
    estimateMessagesTokens(session.messages()) > lowTokens || session.surfaceEvents().length > lowCount
  let changed = false

  // 1) 大 tool.result 外置（不看计数，每次必做）
  for (const ev of session.surfaceEvents()) {
    if (ev.type !== 'tool.result') continue
    const c = ev.content ?? ''
    if (c.length <= maxToolBytes) continue
    const path = spillDir ? spillFull(ev.event_id, c, spillDir) : null
    session.append('tool.result', {
      role: 'tool',
      tool_name: ev.tool_name,
      tool_call_id: ev.tool_call_id,
      content: spillText(c, path),
      shadow_seqs: [ev.seq],
      source_seqs: [ev.seq],
    })
    changed = true
  }

  if (highTokens < lowTokens || !overHigh()) return changed

  // 2) 摘要：把最旧一批活消息交给模型压缩成一段，落 context.summary（不丢目标）
  if (summarize) {
    const live = session.surfaceEvents().filter((e) => !KEEP_TYPES.has(e.type))
    const priorSummaries = session.surfaceEvents().filter((e) => e.type === 'context.summary')
    const batch: SessionEvent[] = []
    // 取到「移除后剩余同时低于两个低水位」为止（token 与条数任一触发都要照顾）
    let remainTokens = estimateMessagesTokens(session.messages())
    let remainCount = session.surfaceEvents().length
    for (const ev of live) {
      if (batch.length >= SUMMARY_BATCH_MAX) break
      if (remainTokens <= lowTokens && remainCount <= lowCount) break
      batch.push(ev)
      remainTokens -= estimateTokens(ev.content ?? '') + 4 + estimateTokens(ev.tool_calls ? JSON.stringify(ev.tool_calls) : '')
      remainCount -= 1
    }
    if (batch.length) {
      // 原子性（与 step 3 同理，但摘要批次单独选，必须自己保证）：
      // 批次若含 assistant(tool_calls)，其配对的 tool.result 必须一起进批次。
      // 否则 shadow 掉 assistant 却留下 tool.result → 投影里出现「孤立的 tool 消息」→ 上游 400。
      const pending = new Set<string>()
      for (const e of batch) {
        if (e.type === 'assistant.message') {
          for (const tc of (e.tool_calls as { id?: string }[] | undefined) ?? []) if (tc.id) pending.add(tc.id)
        }
        if (e.type === 'tool.result' && e.tool_call_id) pending.delete(e.tool_call_id)
      }
      if (pending.size > 0) {
        const inBatch = new Set(batch.map((e) => e.seq))
        for (const e of live) {
          if (pending.size === 0) break
          if (inBatch.has(e.seq)) continue
          if (e.type === 'tool.result' && e.tool_call_id && pending.has(e.tool_call_id)) {
            batch.push(e)
            inBatch.add(e.seq)
            pending.delete(e.tool_call_id)
          }
        }
      }
      // 摘要合并：把已有摘要一并喂给模型，并让它们随本次压缩退役 —— 长会话里只保留**一条**摘要，
      // 避免历次摘要层层堆积（信息不丢：旧摘要内容已并入新的）。
      const digest = [
        ...priorSummaries.map((e) => ({
          role: 'system',
          content: `（已有摘要，请合并进新摘要，不要丢失其中的事实）\n${trimText(e.content ?? '')}`,
        })),
        ...batch.map((e) => ({ role: e.role ?? 'user', content: trimText(e.content ?? '') })),
      ]
      const summary = await summarize(digest)
      if (summary) {
        const retired = [...priorSummaries.map((e) => e.seq), ...batch.map((e) => e.seq)]
        session.append('context.summary', {
          role: 'system',
          content: `【早期对话摘要】\n${summary}`,
          source_seqs: retired,
          shadow_seqs: retired,
        })
        changed = true
      }
    }
  }

  // 3) shadow 兜底：摘要不足/不可用时继续按原子单元丢头，直到低于低水位
  while (overLow()) {
    const live = session.surfaceEvents().filter((e) => !KEEP_TYPES.has(e.type))
    const ev = live[0]
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
  return changed
}
