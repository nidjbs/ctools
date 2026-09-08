// 计划卡：内联在当前用户气泡后，默认展开可见编号步骤。
// pending 态 = 反馈框 + 批准/重规划/放弃；exec 态 = 按「第 N 步」标记逐条打勾。见 specs/plan-mode.md。
import { useMemo, useState } from 'react'
import type { SessionEvent } from '../../shared/types'
import type { PlanTask } from '../../shared/planModel'
import {
  execProgress,
  parsePlanSteps,
  parsePlanSummary,
  stepStates,
  type PlanStep,
} from '../../shared/planModel'
import { Md } from './Md'

export type PlanAction = 'execute' | 'replan' | 'discard'

interface Props {
  task: PlanTask
  evs: SessionEvent[]
  running: boolean
  busy: boolean // 底部有工具 confirm 弹层时禁用操作
  onAction(action: PlanAction, feedback: string): void
}

const STATE_META: Record<string, { icon: string; label: string }> = {
  done: { icon: '✓', label: '完成' },
  active: { icon: '▶', label: '进行中' },
  todo: { icon: '○', label: '待办' },
}

/** 计划文本是否有摘要/编号步骤之外的多余内容（引言/收尾），决定是否提供「原文」展开。 */
function hasExtra(text: string, steps: PlanStep[]): boolean {
  const nums = new Set(steps.map((s) => s.num))
  return text.split('\n').some((ln) => {
    const s = ln.trim()
    if (!s) return false
    const m = ln.match(/^\s*(\d{1,2})[.、)．:：]\s*/)
    if (m && nums.has(parseInt(m[1], 10))) return false
    if (/^(?:摘要|目标|概述|计划)\s*[:：]/.test(s)) return false
    return true
  })
}

export default function PlanCard({ task, evs, running, busy, onAction }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const [fb, setFb] = useState('')
  const steps = useMemo(() => parsePlanSteps(task.text), [task.text])
  const summary = useMemo(
    () =>
      parsePlanSummary(task.text) ??
      (steps[0] ? `步骤 1：${steps[0].title}` : null) ??
      '（计划）',
    [task.text, steps],
  )
  const approvedSeq = task.approvedSeq
  const progress = approvedSeq != null ? execProgress(evs, approvedSeq) : null
  const errAfter = approvedSeq != null && evs.some((e) => e.type === 'agent.error' && e.seq > approvedSeq)
  const finished = task.status === 'exec' && !running && !errAfter
  const states = stepStates(steps, progress, finished)

  const statusTxt =
    task.status === 'pending'
      ? '待批准'
      : finished
        ? '✓ 已完成'
        : errAfter
          ? '✗ 执行中断'
          : '执行中…'
  const statusCls = task.status === 'pending' ? '' : finished ? 'ok' : errAfter ? 'err' : 'run'
  const extra = steps.length > 0 && hasExtra(task.text, steps)

  return (
    <div className="plan-card">
      <div className="pc-top">
        <span className="pc-title">
          📋 第 {task.version} 版 · {summary}
        </span>
        <span className={`pc-status ${statusCls}`}>{statusTxt}</span>
      </div>

      {steps.length > 0 ? (
        <ul className="pc-steps">
          {steps.map((s, i) => {
            const st = states[i]
            const meta = STATE_META[st]
            return (
              <li key={s.num} className={`pc-step ${st}`} title={meta.label}>
                <span className="pc-ico">{meta.icon}</span>
                <span className="pc-num">{s.num}.</span>
                <span className="pc-step-t">{s.title}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="pc-body">
          <Md text={task.text} />
        </div>
      )}

      {extra && (
        <>
          <button className="pc-raw-toggle" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? '收起原文' : '查看原文'}
          </button>
          {showRaw && (
            <div className="pc-raw">
              <Md text={task.text} />
            </div>
          )}
        </>
      )}

      {task.status === 'pending' && (
        <>
          <textarea
            className="bar sb-area"
            placeholder="要调整吗？如：太笼统 / 别动某文件 / 先调研某目录（选填，留空即按原方向重规划）"
            value={fb}
            onChange={(e) => setFb(e.target.value)}
          />
          <div className="confirm-actions">
            <button className="btn approve" disabled={busy || running} onClick={() => onAction('execute', fb)}>
              批准并执行
            </button>
            <button className="btn" disabled={busy || running} onClick={() => onAction('replan', fb)}>
              按反馈重新规划
            </button>
            <button className="btn" disabled={busy || running} onClick={() => onAction('discard', fb)}>
              放弃
            </button>
          </div>
        </>
      )}
    </div>
  )
}
