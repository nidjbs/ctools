// plan 模式（specs/plan-mode.md）：规划→批准→执行。单测（planTools / opts 注入）+ ChatManager 状态机全链路（mock gateway）。
import { describe, expect, it } from 'vitest'
import { Session } from '../src/main/session'
import { Registry } from '../src/main/registry'
import { ChatManager, type ChatIO } from '../src/main/chat'
import { runAgentTurn, agentLoop } from '../src/main/agent'
import { fileRead, fileWrite, fileRm } from '../commands/file'
import { findFile } from '../commands/find_file'
import type { AppConfig, Ctx, SessionEvent } from '../src/shared/types'

/** mock chatStream：按状态分流 —— 执行阶段(tools 含 file_rm)→ 直接收尾；规划首次(无 tool role)→只读调研；
 *  规划再次(有 tool role)→产出计划文本（带反馈则标注）。 */
function gatewayFor(log: { reqs: { tools: string[]; messages: { role?: string; content?: string }[] }[] }) {
  const chatStream = async (req: any, h: any): Promise<void> => {
    log.reqs.push({
      tools: (req.tools ?? []).map((t: any) => t.function?.name),
      messages: req.messages ?? [],
    })
    const names = new Set((req.tools ?? []).map((t: any) => t.function?.name))
    const hasTool = (req.messages ?? []).some((m: any) => m.role === 'tool')
    if (names.has('file_rm')) {
      h.onContent('执行完成：已按计划落地')
      h.onFinish?.('stop')
      return
    }
    if (!hasTool) {
      h.onToolCalls?.([{ id: 'c1', type: 'function', function: { name: 'find_file', arguments: '{"query":"report"}' } }])
      h.onFinish?.('tool_calls')
      return
    }
    const hasFb = String((req.messages ?? [])[0]?.content ?? '').includes('请据此调整')
    h.onContent(hasFb ? '1. 调研现状\n2. 已按反馈调整并复核' : '1. 调研现状\n2. 拟定草稿')
    h.onFinish?.('stop')
  }
  return chatStream
}

function makeCtx(chatStream: (req: unknown, h: unknown) => Promise<void>): Ctx {
  return {
    config: {
      defaultAlias: 'common',
      gatewayUrl: 'http://x',
      adminUrl: 'http://x',
      fileRoots: ['/tmp'],
      writeConfirm: 'auto',
      hotkey: 'x',
      enabledCommands: {},
    } as AppConfig,
    gateway: { models: async () => [], chat: async () => ({ content: '' }), chatStream: chatStream as never },
    system: { pbcopy: async () => true, mdfind: async () => ['/tmp/report.md'] },
  } as Ctx
}

function collector() {
  const evs: SessionEvent[] = []
  const deltas: string[] = []
  let running: boolean | undefined
  const io: ChatIO = { onEvent: (e) => evs.push(e), onDelta: (d) => deltas.push(d), onRunning: (r) => (running = r) }
  return { io, evs, deltas, isRunning: () => running }
}

const planTypes = (evs: SessionEvent[]) => evs.filter((e) => e.type.startsWith('plan.'))
const planProposals = (evs: SessionEvent[]) => evs.filter((e) => e.type === 'plan.propose').map((e) => e.content)

describe('Registry.planTools', () => {
  it('只含只读 planSafe 且启用的 agentTool；排除写/删', () => {
    const reg = new Registry().registerAll([fileRead, fileWrite, findFile, fileRm])
    expect(reg.planTools().sort()).toEqual(['file_read', 'find_file'].sort())
    expect(reg.toolIds().sort()).toEqual(['file_read', 'file_write', 'find_file', 'file_rm'].sort())
  })
})

describe('agentLoop opts 注入', () => {
  it('runAgentTurn 注入只读工具集 + promptExtra；agentLoop 不 seed user.message', async () => {
    const seen: { tools: string[]; first: string | undefined }[] = []
    const ctx = makeCtx(async (req: any, h: any) => {
      seen.push({ tools: (req.tools ?? []).map((t: any) => t.function?.name), first: req.messages?.[0]?.content })
      h.onContent('结果')
      h.onFinish?.('stop')
    })
    const reg = new Registry().registerAll([fileRead, fileRm])

    const s = new Session()
    await runAgentTurn(s, 'hi', ctx, reg, { onEvent: () => {}, onContent: () => {} }, {
      tools: ['file_read'],
      promptExtra: '规划指令X',
    })
    expect(seen.length).toBe(1)
    expect(seen[0].tools).toEqual(['file_read']) // 只读工具集生效
    expect(seen[0].first).toBe('规划指令X') // promptExtra 置于请求首位
    expect(s.transcript().filter((e) => e.type === 'user.message')).toHaveLength(1)

    const s2 = new Session()
    const types: string[] = []
    await agentLoop(s2, ctx, reg, { onEvent: (e) => types.push(e.type), onContent: () => {} }, {
      tools: ['file_read'],
      promptExtra: 'Y',
    })
    expect(types).not.toContain('user.message') // 不新增用户消息
    expect(types).toContain('assistant.message')
  })
})

describe('ChatManager plan 模式状态机', () => {
  const reg = () => new Registry().registerAll([findFile, fileRm]) // 规划只 find_file，执行含 file_rm

  it('plan 模式：规划(只读)→ plan.propose → executePlan → 执行(全量工具)', async () => {
    const log = { reqs: [] as { tools: string[]; messages: { role?: string; content?: string }[] }[] }
    const chat = new ChatManager(makeCtx(gatewayFor(log)), reg(), undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('帮我重构 config', io)

    // 规划阶段只发只读工具
    expect(log.reqs[0].tools).toEqual(['find_file'])
    expect(log.reqs[1].tools).toEqual(['find_file'])
    expect(log.reqs.every((r) => !r.tools.includes('file_rm'))).toBe(true)

    let types = chat.transcript().map((e) => e.type)
    expect(types).toContain('plan.propose')
    expect(types).not.toContain('plan.approved')
    const pend = chat.pendingPlanValue()
    expect(pend).not.toBeNull()
    expect(pend!.text).toBe(planProposals(chat.transcript()).at(-1))
    expect(chat.isRunning()).toBe(false)

    await chat.executePlan(io)
    types = chat.transcript().map((e) => e.type)
    const idx = types.indexOf('plan.propose')
    expect(types.indexOf('plan.approved')).toBeGreaterThan(idx)
    // 执行 pass 用全量工具，并把已批准计划作为请求前缀
    const exec = log.reqs.find((r) => r.tools.includes('file_rm'))!
    expect(exec.tools.sort()).toEqual(['file_rm', 'find_file'].sort())
    expect(exec.messages[0]?.content).toContain(pend!.text)
    expect(chat.transcript().at(-1)!.content).toContain('执行完成')
    expect(chat.pendingPlanValue()).toBeNull()
    expect(planTypes(chat.transcript()).filter((e) => e.type === 'plan.propose')).toHaveLength(1)
  })

  it('plan.* 事件 role-less：不进模型消息投影', async () => {
    const chat = new ChatManager(makeCtx(gatewayFor({ reqs: [] })), reg(), undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('任务', io)
    const types = chat.transcript().filter((e) => e.role).map((e) => e.type)
    expect(types).not.toContain('plan.propose')
    expect(types).not.toContain('plan.approved')
  })

  it('拒绝 → replan(feedback) → 新规划带反馈', async () => {
    const chat = new ChatManager(makeCtx(gatewayFor({ reqs: [] })), reg(), undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('任务', io)
    const p1 = chat.pendingPlanValue()!.text
    await chat.replan(io, '太笼统')
    const p2 = chat.pendingPlanValue()!.text
    expect(chat.transcript().filter((e) => e.type === 'plan.rejected').at(-1)!.content).toBe('太笼统')
    expect(p1).not.toBe(p2)
    expect(p2).toContain('已按反馈调整')
    expect(planTypes(chat.transcript()).filter((e) => e.type === 'plan.propose')).toHaveLength(2)
    expect(chat.isRunning()).toBe(false)
  })

  it('放弃 → plan.rejected 且不执行不回跑', async () => {
    const chat = new ChatManager(makeCtx(gatewayFor({ reqs: [] })), reg(), undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('任务', io)
    await chat.discardPlan(io)
    expect(chat.pendingPlanValue()).toBeNull()
    expect(chat.transcript().at(-1)!.type).toBe('plan.rejected')
    expect(planTypes(chat.transcript()).filter((e) => e.type === 'plan.propose')).toHaveLength(1)
    // 只有规划（含调研），没有执行内容
    const executed = chat.transcript().find((e) => e.type === 'assistant.message' && e.content?.includes('执行完成'))
    expect(executed).toBeUndefined()
  })

  it('新消息取代待批准计划', async () => {
    const chat = new ChatManager(makeCtx(gatewayFor({ reqs: [] })), reg(), undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('任务一', io)
    expect(planProposals(chat.transcript())).toHaveLength(1)
    await chat.run('任务二', io) // 仍在 plan 模式 → 新规划
    expect(chat.transcript().filter((e) => e.type === 'user.message')).toHaveLength(2)
    expect(planProposals(chat.transcript())).toHaveLength(2)
    expect(chat.pendingPlanValue()).not.toBeNull()
  })

  it('normal 模式维持现状：无 plan.* 事件', async () => {
    const chat = new ChatManager(makeCtx(gatewayFor({ reqs: [] })), reg(), undefined)
    const { io } = collector()
    await chat.open('直接问', io) // mode 默认 normal
    expect(planTypes(chat.transcript())).toHaveLength(0)
    expect(chat.getMode()).toBe('normal')
  })
})

describe('ChatManager 计划编号结构兜底', () => {
  it('模型产出整段计划（无编号）→ 自动单轮改写为编号步骤后再 plan.propose', async () => {
    const seen: { tools: string[] }[] = []
    const ctx = makeCtx(async (req: any, h: any) => {
      const names = new Set((req.tools ?? []).map((t: any) => t.function?.name))
      seen.push({ tools: (req.tools ?? []).map((t: any) => t.function?.name) })
      if (names.has('file_rm')) {
        h.onContent('执行完成')
        h.onFinish?.('stop')
        return
      }
      if ((req.tools ?? []).length === 0) {
        h.onContent('1. 看现状\n2. 动手整理') // 改写轮：返回编号列表
        h.onFinish?.('stop')
        return
      }
      h.onContent('先看看现状，再直接动手把目录整理归档。') // 规划整段、无编号
      h.onFinish?.('stop')
    })
    const reg = new Registry().registerAll([findFile, fileRm])
    const chat = new ChatManager(ctx, reg, undefined)
    const { io } = collector()
    chat.setMode('plan')
    await chat.open('整理目录', io)

    // 改写轮：不带任何工具、纯文本重排
    expect(seen.at(-1)!.tools).toEqual([])
    const text = chat.pendingPlanValue()!.text
    expect(text).toContain('1. 看现状')
    expect(text).toContain('2. 动手整理')
    expect(chat.transcript().filter((e) => e.type === 'plan.propose')).toHaveLength(1)
  })
})
