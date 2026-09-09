// Chat 会话管理：单活动会话，串行 agent turn，可取消。事件 + 流式增量都推给 UI。
// plan 模式（specs/plan-mode.md）：run 按模式分发 —— plan=规划 pass → plan.propose 待批准 →
// executePlan（执行 pass）/ replan（反馈重规划）/ discardPlan（放弃）。
import type { AgentMode, Ctx, SessionEvent } from '../shared/types'
import { Registry } from './registry'
import { Session } from './session'
import { agentLoop, runAgentTurn, seedSystem, type AgentCallbacks } from './agent'
import { parsePlanSteps } from '../shared/planModel'

const defaultSystemPrompt = '你是用户的个人 AI 助手，定位是快速帮用户处理简单、重复的工作。回答简洁，直接给出结果。'
const PLAN_MAX_TURNS = 12
const PLAN_STEPS_MIN = 2
const PLAN_STEPS_MAX = 6 // 步骤保持在 4-6 个（最多 6），避免十几步的冗长计划

const planPrompt = (feedback?: string): string => {
  const base =
    '规划模式：请先只读调研任务（可用工具已限制为只读），然后给出可执行的分步计划。\n' +
    '计划第一行必须是“摘要：…”（一句话概述目标），随后是编号步骤列表（每一行一步，以 “1.” “2.” “3.” … 开头）。\n' +
    '步骤要控制在 4-6 个之间（最多不超过 6 个）：过细就合并同类、过粗就拆出关键动作，不要列出十几步的流水账。格式：\n' +
    '摘要：整理归档当前目录并生成索引\n1. 调研现状\n2. 确定归档规则\n3. 执行整理\n4. 汇总结果\n' +
    '除摘要和步骤外，不要输出任何其他前言、标题或总结。不要调用任何有副作用的工具；以纯计划文本收尾。'
  return feedback ? `${base}\n\n用户对上一版计划的要求/反馈，请据此调整：\n${feedback}` : base
}

/** 计划未按「摘要+编号步骤」输出或步骤数超限时的改写指令。 */
const stepRewritePrompt = (plan: string): string =>
  '以下是给用户的一份计划，需要重排为规范结构。请把同一计划改写成：' +
  '第一行「摘要：…」一句话概述目标，随后是严格的编号步骤列表（每一行一步，以 “1.” “2.” … 开头）。\n' +
  '步骤控制在 4-6 个之间（最多不超过 6 个）：保留原计划全部要点，过细合并、冗余删减，最多 6 步。' +
  '只输出这段文本本身。\n\n原计划：\n' + plan

/** ChatManager → UI 的输出：结构化事件 + 流式增量 + 运行态变化。 */
export interface ChatIO {
  onEvent(ev: SessionEvent): void
  onDelta(text: string): void
  /** 运行态变化（开始/结束），让 UI 停止「回答中」态。 */
  onRunning?(running: boolean): void
  /** 工具需人工批准（bash/破坏性写删）。resolve(true)=批准执行。 */
  onConfirm?(tool: string, message: string): Promise<boolean>
}

export class ChatManager {
  /** 无会话则新建（不自动续上次：首次打开即新会话）。 */
  private session: Session | null = null
  private running = false
  private abort?: AbortController
  private mode: AgentMode = 'normal'
  /** 待批准计划（最近 plan.propose 且未被 approved/rejected）。 */
  private pendingPlan: { seq: number; text: string } | null = null

  constructor(
    private readonly ctx: Ctx,
    private readonly registry: Registry,
    private readonly sessionsDir?: string,
  ) {}

  private newSession(): Session {
    const s = new Session(this.sessionsDir)
    seedSystem(s, defaultSystemPrompt)
    return s
  }

  /** 载入历史会话续聊：重放指定 id 并设为活动（不自动发消息）。running 守卫。 */
  async attach(id: string): Promise<{ id: string }> {
    if (this.running) throw new Error('上一轮仍在运行，请等待或取消')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('非法的会话 id')
    if (!this.sessionsDir) throw new Error('未配置会话目录')
    this.session = Session.fromJSONL(this.sessionsDir, id) // 文件不存在/坏 → 上抛
    this.pendingPlan = null
    return { id: this.session.id }
  }

  /** 另起全新会话（Chat「＋新会话」）。running 守卫。 */
  async fresh(): Promise<{ id: string }> {
    if (this.running) throw new Error('上一轮仍在运行，请等待或取消')
    this.session = this.newSession()
    this.pendingPlan = null
    return { id: this.session.id }
  }

  private cbs(io: ChatIO): AgentCallbacks {
    return {
      onContent: (d) => io.onDelta(d),
      onEvent: (e) => io.onEvent(e),
      ...(io.onConfirm ? { onConfirm: io.onConfirm } : {}),
    }
  }

  /** 运行脚手架：running 守卫 + 取消 + agent.error 落盘 + onRunning 推态。 */
  private async withRun(io: ChatIO, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.running) throw new Error('上一轮仍在运行，请等待或取消')
    this.running = true
    this.abort = new AbortController()
    io.onRunning?.(true)
    try {
      await task(this.abort.signal)
    } catch (e) {
      const err = e as { message?: string; name?: string }
      const cancelled = err?.message === 'cancelled' || err?.name === 'AbortError'
      if (!cancelled) {
        // 错误落成会话事件，晚挂载/重建的窗口也能在 transcript 里看到
        this.session?.append('agent.error', { content: err?.message ?? String(e) })
        throw e
      }
    } finally {
      this.running = false
      io.onRunning?.(false)
    }
  }

  async open(firstMessage: string | undefined, io: ChatIO): Promise<{ id: string }> {
    if (!this.session) this.session = this.newSession()
    if (firstMessage?.trim()) await this.run(firstMessage, io)
    return { id: this.session.id }
  }

  /** 一次 send：按当前模式分发。plan → 规划 pass；normal → 现状直跑。 */
  async run(text: string, io: ChatIO): Promise<void> {
    if (!this.session) return
    if (this.running) throw new Error('上一轮仍在运行，请等待或取消')
    this.pendingPlan = null // 新消息取代待批准计划
    const mode = this.mode
    await this.withRun(io, async (signal) => {
      if (mode === 'plan') await this.runPlanPass(io, signal, { seed: text })
      else await runAgentTurn(this.session!, text, this.ctx, this.registry, this.cbs(io), { signal })
    })
  }

  /** 批准待批准计划 → 执行 pass（全量工具 + 计划指令）。 */
  async executePlan(io: ChatIO): Promise<void> {
    if (!this.session) return
    if (!this.pendingPlan) throw new Error('当前没有待批准的计划')
    const plan = this.pendingPlan
    await this.withRun(io, async (signal) => {
      const ev = this.session!.append('plan.approved', { content: plan.text })
      io.onEvent(ev)
      this.pendingPlan = null
      const extra =
        `用户已批准以下计划，请按其执行（执行中如遇破坏性操作仍会请用户确认）：\n\n${plan.text}\n\n` +
        '执行协议：每一步开始时先单独输出一行“第 N 步：…”（N 对应该计划里的步骤编号），再做这一步的操作；' +
        '完成一步再进入下一步，最后给出执行完成小结。'
      await agentLoop(this.session!, this.ctx, this.registry, this.cbs(io), {
        signal,
        tools: this.registry.toolIds(),
        promptExtra: extra,
      })
    })
  }

  /** 按反馈重新规划（不新增 user.message；反馈落 plan.rejected）。 */
  async replan(io: ChatIO, feedback?: string): Promise<void> {
    if (!this.session) return
    if (!this.pendingPlan) throw new Error('当前没有待批准的计划')
    const text = (feedback ?? '').trim()
    await this.withRun(io, async (signal) => {
      const ev = this.session!.append('plan.rejected', { content: text || undefined })
      io.onEvent(ev)
      this.pendingPlan = null
      await this.runPlanPass(io, signal, { seed: undefined, feedback: text })
    })
  }

  /** 放弃待批准计划（落 plan.rejected，不回跑）。 */
  async discardPlan(io: ChatIO): Promise<void> {
    if (!this.session || !this.pendingPlan) return
    const ev = this.session!.append('plan.rejected', {})
    io.onEvent(ev)
    this.pendingPlan = null
  }

  /** 规划 pass：只读工具集 + 规划协议；产出的纯文本计划 → plan.propose + pendingPlan。 */
  private async runPlanPass(
    io: ChatIO,
    signal: AbortSignal,
    opts: { seed?: string; feedback?: string },
  ): Promise<void> {
    const tools = this.registry.planTools()
    const extra = planPrompt(opts.feedback)
    const plan =
      opts.seed !== undefined
        ? await runAgentTurn(this.session!, opts.seed, this.ctx, this.registry, this.cbs(io), {
            signal,
            tools,
            promptExtra: extra,
            maxTurns: PLAN_MAX_TURNS,
          })
        : await agentLoop(this.session!, this.ctx, this.registry, this.cbs(io), {
            signal,
            tools,
            promptExtra: extra,
            maxTurns: PLAN_MAX_TURNS,
          })
    if (!plan || !plan.trim()) {
      const ev = this.session!.append('agent.error', { content: '规划未产出计划文本，请换种描述后重试' })
      io.onEvent(ev)
      return
    }
    // 结构兜底：产出若不是编号步骤列表（整段描述）或步数超限，让模型改写为「4-6 个编号步骤」，确保 UI 可按步骤展示/勾选
    let text = plan
    const n = parsePlanSteps(text).length
    if (n < PLAN_STEPS_MIN || n > PLAN_STEPS_MAX) {
      const rw = await this.rewriteSteps(io, signal, text)
      if (rw) text = rw
    }
    const ev = this.session!.append('plan.propose', { content: text })
    this.pendingPlan = { seq: ev.seq, text }
    io.onEvent(ev)
  }

  /** 单轮改写（无工具）：把整段计划规范成 4-6 个编号步骤；步数落在 [MIN,MAX] 才采用，否则保留原文。 */
  private async rewriteSteps(io: ChatIO, signal: AbortSignal, plan: string): Promise<string | undefined> {
    const out = await agentLoop(this.session!, this.ctx, this.registry, this.cbs(io), {
      signal,
      tools: [],
      promptExtra: stepRewritePrompt(plan),
      maxTurns: 1,
    })
    const t = out?.trim()
    if (!t) return undefined
    const n = parsePlanSteps(t).length
    return n >= PLAN_STEPS_MIN && n <= PLAN_STEPS_MAX ? t : undefined
  }

  // ---------- mode / 待批准计划状态 ----------

  setMode(m: AgentMode): AgentMode {
    this.mode = m
    return this.mode
  }

  getMode(): AgentMode {
    return this.mode
  }

  pendingPlanValue(): { seq: number; text: string } | null {
    return this.pendingPlan ? { ...this.pendingPlan } : null
  }

  sessionId(): string | undefined {
    return this.session?.id
  }

  cancel(): void {
    this.abort?.abort()
  }

  isRunning(): boolean {
    return this.running
  }

  transcript(): SessionEvent[] {
    return this.session?.transcript() ?? []
  }
}
