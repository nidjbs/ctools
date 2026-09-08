// PlanCard/计划卡 纯函数（tests planModel）——版本/任务态/步骤解析/执行进度/逐条打勾，均从事件流推导。
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventType } from '../src/shared/types'
import {
  taskPlan,
  planTextSeqs,
  parsePlanSteps,
  parsePlanSummary,
  distinctStepMarkers,
  execProgress,
  stepStates,
} from '../src/shared/planModel'

const ev = (type: SessionEventType, seq: number, content?: string): SessionEvent =>
  ({ type, seq, content, event_id: `e${seq}`, session_id: 's', occurred_at: '' }) as SessionEvent

describe('taskPlan：段界/版本/状态', () => {
  it('pending：段内首条 propose → 第 1 版', () => {
    const t = taskPlan([ev('user.message', 1, '任务'), ev('assistant.message', 2, '计划A'), ev('plan.propose', 3, '计划A')])
    expect(t).toEqual({ version: 1, text: '计划A', status: 'pending' })
  })
  it('replan 递增版本，取最新 propose', () => {
    const evs = [
      ev('user.message', 1, '任务'),
      ev('assistant.message', 2, '计划A'),
      ev('plan.propose', 3, '计划A'),
      ev('plan.rejected', 4),
      ev('assistant.message', 5, '计划B'),
      ev('plan.propose', 6, '计划B'),
    ]
    expect(taskPlan(evs)).toEqual({ version: 2, text: '计划B', status: 'pending' })
  })
  it('approved → exec（rail 执行态常驻），approvedSeq 就位', () => {
    const evs = [
      ev('user.message', 1, '任务'),
      ev('assistant.message', 2, '计划'),
      ev('plan.propose', 3, '计划'),
      ev('plan.approved', 4, '计划'),
    ]
    expect(taskPlan(evs)).toEqual({ version: 1, text: '计划', status: 'exec', approvedSeq: 4 })
  })
  it('rejected 后无新 propose（放弃/重规划失败）→ null 收起', () => {
    const evs = [
      ev('user.message', 1, '任务'),
      ev('assistant.message', 2, '计划'),
      ev('plan.propose', 3, '计划'),
      ev('plan.rejected', 4),
    ]
    expect(taskPlan(evs)).toBeNull()
  })
  it('新 user.message 另起一段 → 旧任务收起、新段从第 1 版', () => {
    const evs = [
      ev('user.message', 1, '任务一'),
      ev('assistant.message', 2, '计划A'),
      ev('plan.propose', 3, '计划A'),
      ev('plan.approved', 4, '计划A'),
      ev('user.message', 10, '任务二'),
      ev('assistant.message', 11, '计划B'),
      ev('plan.propose', 12, '计划B'),
    ]
    expect(taskPlan(evs)).toEqual({ version: 1, text: '计划B', status: 'pending' })
  })
})

describe('planTextSeqs / parsePlanSteps', () => {
  it('返回每条 propose 紧前 assistant.message 的 seq', () => {
    const s = planTextSeqs([
      ev('user.message', 1),
      ev('assistant.message', 2, 'P1'),
      ev('plan.propose', 3, 'P1'),
      ev('assistant.message', 4, '调研'),
      ev('tool.call', 5),
    ])
    expect([...s]).toEqual([2])
  })
  it('只藏当前段（最后 user.message 之后）的计划文本；更早已完成任务的可视气泡不藏', () => {
    const evs = [
      ev('user.message', 1, '任务一'),
      ev('assistant.message', 2, '旧计划A'),
      ev('plan.propose', 3, 'A'),
      ev('plan.approved', 4, 'A'),
      ev('assistant.message', 5, 'A 执行完'),
      ev('user.message', 10, '任务二'),
      ev('assistant.message', 11, '新计划B'),
      ev('plan.propose', 12, 'B'),
    ]
    expect([...planTextSeqs(evs)]).toEqual([11]) // seq 2（旧任务）保留为历史
  })
  it('编号列表解析成步骤', () => {
    expect(parsePlanSteps('1. 调研目录\n2. 整理\n3. 汇报')).toEqual([
      { num: 1, title: '调研目录' },
      { num: 2, title: '整理' },
      { num: 3, title: '汇报' },
    ])
  })
  it('中文序号解析；无编号/不足两条/首行被加粗吞掉 → 按纯文本（空列表）', () => {
    expect(parsePlanSteps('1、调研\n2、整理')).toHaveLength(2)
    expect(parsePlanSteps('给出一份整理归档方案。')).toEqual([])
    expect(parsePlanSteps('1. 只有一步')).toEqual([])
    expect(parsePlanSteps('**1. 加粗标题**\n2. 正文')).toEqual([]) // 仅解析到一条，不足两条 → 不按步骤列表
  })
})

describe('parsePlanSummary', () => {
  it('取首行 摘要/目标：…；无则 null', () => {
    expect(parsePlanSummary('摘要：整理归档当前目录\n1. 调研\n2. 动手')).toBe('整理归档当前目录')
    expect(parsePlanSummary('目标：完成迁移')).toBe('完成迁移')
    expect(parsePlanSummary('1. 调研\n2. 动手')).toBeNull()
  })
})

describe('执行进度标记', () => {
  it('distinctStepMarkers 去重保序', () => {
    expect(distinctStepMarkers('先第 2 步，再第 1 步，回头第 2 步')).toEqual([2, 1])
  })
  it('execProgress：取 approved 后 assistant 文本里最新标记为 active，之前为 done', () => {
    const evs = [
      ev('user.message', 1, '任务'),
      ev('assistant.message', 2, 'P'),
      ev('plan.propose', 3, 'P'),
      ev('plan.approved', 4, 'P'),
      ev('assistant.message', 5, '第 1 步：调研'),
      ev('tool.result', 6),
      ev('assistant.message', 7, '第 2 步：整理'),
    ]
    expect(execProgress(evs, 4)).toEqual({ active: 2, done: [1] })
  })
  it('approved 之前的 assistant 不算执行标记', () => {
    const evs = [
      ev('user.message', 1, '任务'),
      ev('assistant.message', 2, '计划里提到第 3 步'), // 规划文本含数字也不当执行进度
      ev('plan.propose', 3, '计划'),
      ev('plan.approved', 4, '计划'),
      ev('assistant.message', 5, '完毕'),
    ]
    expect(execProgress(evs, 4)).toEqual({ active: null, done: [] })
  })
})

describe('stepStates：逐条打勾', () => {
  const steps = parsePlanSteps('1. 调研\n2. 整理\n3. 汇报') // num 1,2,3
  it('待批准（无进度、未收尾）→ 全 todo', () => {
    expect(stepStates(steps, null, false)).toEqual(['todo', 'todo', 'todo'])
  })
  it('执行到第 2 步：第 1 步 done、第 2 步 active、后续 todo', () => {
    expect(stepStates(steps, { active: 2, done: [1] }, false)).toEqual(['done', 'active', 'todo'])
  })
  it('收尾 → 全 done（不依赖每步都有标记）', () => {
    expect(stepStates(steps, { active: 3, done: [1, 2] }, true)).toEqual(['done', 'done', 'done'])
  })
  it('标记跳号：未执行到的编号维持 todo', () => {
    expect(stepStates(steps, { active: 3, done: [1] }, false)).toEqual(['done', 'todo', 'active'])
  })
})
