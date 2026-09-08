// plan 模式 UI 纯函数（从事件流推导，不改事件/schema）：版本、任务态、步骤解析、执行进度标记。
// 事件溯源是真相源；UI 只读推导 → 晚挂载/重建都能恢复。见 specs/plan-mode.md。
import type { SessionEvent } from './types'

export type PlanTaskStatus = 'pending' | 'exec' // pending=待批准；exec=已批准执行中/完毕
export interface PlanTask {
  version: number // 本次任务内第几版计划（以 user.message 为界从 1 起）
  text: string
  status: PlanTaskStatus
  approvedSeq?: number
}

/** 任务段（最后一个 user.message 之后）内最新 plan.propose；被放弃(null) 返回 null。
 *  段内每多一条 plan.propose(重规划) → version+1。 */
export function taskPlan(evs: SessionEvent[]): PlanTask | null {
  let start = 0
  for (const e of evs) if (e.type === 'user.message') start = e.seq
  const seg = evs.filter((e) => e.seq > start)
  const proposes = seg.filter((e) => e.type === 'plan.propose')
  if (!proposes.length) return null
  const last = proposes[proposes.length - 1]
  const version = proposes.length
  const after = seg.filter((e) => e.seq > last.seq)
  const approved = after.find((e) => e.type === 'plan.approved')
  if (approved) return { version, text: last.content ?? '', status: 'exec', approvedSeq: approved.seq }
  // 待批准后被 rejected 且无新 propose → 放弃（或重规划失败），收起 rail
  if (after.some((e) => e.type === 'plan.rejected')) return null
  return { version, text: last.content ?? '', status: 'pending' }
}

/** 当前任务段（最后一个 user.message 之后）内每条 propose 紧前 assistant.message 的 seq → UI 隐藏它以计划卡替代。
 *  只处理本段：更早已完成任务的计划文本仍以历史气泡展示，不被误藏。 */
export function planTextSeqs(evs: SessionEvent[]): Set<number> {
  const s = new Set<number>()
  let lastUser = -1
  for (let i = 0; i < evs.length; i++) if (evs[i].type === 'user.message') lastUser = i
  for (let i = lastUser + 1; i < evs.length; i++) {
    if (evs[i].type === 'plan.propose' && evs[i - 1].type === 'assistant.message') s.add(evs[i - 1].seq)
  }
  return s
}

export interface PlanStep {
  num: number
  title: string
}

/** 首行 “摘要/目标/概述：…” 作为计划摘要；无 → null。 */
export function parsePlanSummary(text: string): string | null {
  for (const ln of text.split('\n')) {
    const m = ln.match(/^\s*(?:摘要|目标|概述|计划)\s*[:：]\s*(.+)$/)
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

/** 把计划文本解析成编号步骤（如 “1. xxx”）。无编号列表 → []（当纯文本整块展示）。 */
export function parsePlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = []
  const seen = new Set<number>()
  for (const ln of text.split('\n')) {
    const m = ln.match(/^\s*(\d{1,2})[.、)．:：]\s*(.*)$/)
    if (!m) continue
    const num = parseInt(m[1], 10)
    if (num >= 1 && num <= 50 && !seen.has(num)) {
      seen.add(num)
      steps.push({ num, title: m[2].trim() })
    }
  }
  return steps.length >= 2 ? steps : [] // 单条算不上“步骤列表”，整块展示
}

/** 文本里出现的 “第 N 步”（按出现顺序去重）。执行协议标记用。 */
export function distinctStepMarkers(text: string): number[] {
  const out: number[] = []
  const re = /第\s*(\d{1,2})\s*步/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10)
    if (n >= 1 && n <= 99 && !out.includes(n)) out.push(n)
  }
  return out
}

export interface ExecProgress {
  active: number | null // 当前执行到的步骤编号（最新一条标记）
  done: number[] // 已完成的步骤编号（比 active 更早的标记）
}

/** 从已批准后的 assistant 文本收集执行进度标记。 */
export function execProgress(evs: SessionEvent[], approvedSeq: number): ExecProgress {
  const marks: number[] = []
  for (const e of evs) {
    if (e.type !== 'assistant.message' || !e.content || e.seq <= approvedSeq) continue
    for (const n of distinctStepMarkers(e.content)) if (!marks.includes(n)) marks.push(n)
  }
  const active = marks.length ? marks[marks.length - 1] : null
  return { active, done: active ? marks.filter((n) => n < active) : [] }
}

export type PlanStepState = 'todo' | 'active' | 'done'

/** 逐条步骤状态（计划卡打勾用）：done=已完成/已过、active=最新执行中、todo=待办；收尾 → 全 done。 */
export function stepStates(steps: PlanStep[], progress: ExecProgress | null, finished: boolean): PlanStepState[] {
  const doneSet = new Set(progress?.done ?? [])
  const active = progress?.active ?? null
  return steps.map((s) => {
    if (finished) return 'done'
    if (s.num === active) return 'active'
    if (doneSet.has(s.num)) return 'done'
    return 'todo'
  })
}
