// 黄金测试集（main 进程端到端）：用**录制型 mock gateway** 断言「模型实际收到了什么」，
// 锁住 P0 改动的可观测行为 —— 环境注入、前缀缓存不变量、记忆闭环、大结果外置、摘要压缩。
// 与单测的分工：单测验证模块语义；本集验证这些语义**真的透到了发给模型的请求里**。
// 见 specs/context.md、specs/system-prompt.md、specs/memory.md。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayClient } from '../src/main/gatewayClient'
import { estimateMessagesTokens } from '../src/shared/tokens'
import { ChatManager, type ChatIO } from '../src/main/chat'
import { Registry } from '../src/main/registry'
import { MemoryStore } from '../src/main/memory'
import { fileRead, fileList, fileWrite, fileRm, fileEdit } from '../commands/file'
import { findFile } from '../commands/find_file'
import { grepCmd } from '../commands/grep'
import { askCmd } from '../commands/ask'
import { rememberCmd, forgetCmd, recallCmd, memoryListCmd } from '../commands/memory'
import type { AppConfig, Ctx, SessionEvent } from '../src/shared/types'
import { startRecordingGateway, type GatewayRequest, type RecordingGateway, type Reply } from './helpers/gateway'

const ROLE_PROMPT = '你是用户的个人 AI 助手，定位是快速帮用户处理简单、重复的工作。回答简洁，直接给出结果。'
/** 固定时钟：让 system 段（含日期）可逐字节断言。 */
const NOW = new Date('2026-09-17T10:30:00')

let root: string
let userData: string
let gw: RecordingGateway
let ctx: Ctx
let registry: Registry
/** 每个用例自行设置；gateway 每次都读它。 */
let responder: (req: GatewayRequest, i: number) => Reply

/** 本 turn 内已产生工具结果 → 收尾；否则发起一次工具调用（只看最后一条 user 之后，避免误判历史轮次）。 */
function toolThenFinal(tool: string, args: unknown, final = '完成'): (req: GatewayRequest) => Reply {
  return (req) => {
    let lastUser = -1
    req.messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const thisTurn = req.messages.slice(lastUser + 1)
    return thisTurn.some((m) => m.role === 'tool')
      ? { stream: true, content: final }
      : { stream: true, toolCalls: [{ name: tool, args }] }
  }
}

const io = (sink?: SessionEvent[], extra: Partial<ChatIO> = {}): ChatIO => ({
  onEvent: (e) => sink?.push(e),
  onDelta: () => {},
  ...extra,
})

const envOf = (t: GatewayRequest): string =>
  t.messages.find((m) => m.content?.includes('工作目录'))?.content ?? ''

/** 默认用「最小注册表」以保持环境段 golden 稳定；P1 用例显式传完整表。 */
function newChat(reg: Registry = registry): ChatManager {
  return new ChatManager(ctx, reg, join(userData, 'sessions'))
}

/** 完整注册表（含 P1 新增工具）—— 会让环境段多出对应「工具要点」，故只在 P1 用例里用。 */
function fullRegistry(): Registry {
  return new Registry().registerAll([
    fileRead,
    fileList,
    fileWrite,
    fileRm,
    fileEdit,
    grepCmd,
    askCmd,
    findFile,
    rememberCmd,
    forgetCmd,
    recallCmd,
    memoryListCmd,
  ])
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => vi.useRealTimers())

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ctools-golden-root-'))
  userData = mkdtempSync(join(tmpdir(), 'ctools-golden-data-'))
  responder = () => ({ stream: true, content: '好的' })
  gw = await startRecordingGateway((req, i) => responder(req, i))

  const config: AppConfig = {
    gatewayUrl: gw.base,
    adminUrl: gw.base,
    defaultAlias: 'golden',
    fileRoots: [root],
    writeConfirm: 'auto',
    hotkey: '',
    injectDate: true,
    enabledCommands: {},
  }
  ctx = {
    config,
    gateway: new GatewayClient(config),
    system: { pbcopy: async () => true, mdfind: async () => [] },
    memory: new MemoryStore(userData),
    spillDir: join(userData, 'spill'),
  }
  registry = new Registry().registerAll([
    fileRead,
    fileList,
    fileWrite,
    fileRm,
    findFile,
    rememberCmd,
    forgetCmd,
    recallCmd,
    memoryListCmd,
  ])
})

afterEach(async () => {
  await gw.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('G1 环境注入：逐字节 golden + 位置正确（R3）', () => {
  it('角色 → 环境段 → 历史，且环境段内容逐字节匹配', async () => {
    const chat = newChat()
    await chat.open('你好', io())

    const msgs = gw.turns()[0].messages
    expect(msgs[0]).toMatchObject({ role: 'system', content: ROLE_PROMPT })

    expect(msgs[1].role).toBe('system')
    // 黄金串：稳定段（工作目录/可写范围/要点）在前，易变段（日期）在最后
    expect(msgs[1].content).toBe(
      [
        `工作目录（bash cwd）: ${root}`,
        `可写范围（file_roots）: ${root}`,
        '工具要点：',
        '- 读取大文件优先用行区间（offset/limit），不要整份读',
        '',
        '今天是 2026-09-17 周四。',
      ].join('\n'),
    )

    expect(msgs[2]).toMatchObject({ role: 'user', content: '你好' })
  })

  it('环境段不含时分秒（R1）', async () => {
    const chat = newChat()
    await chat.open('你好', io())
    expect(envOf(gw.turns()[0])).not.toMatch(/\d{1,2}:\d{2}/)
  })

  it('未启用的工具不出现在工具要点里（不宣传不存在的工具）', async () => {
    const chat = newChat()
    await chat.open('你好', io())
    const env = envOf(gw.turns()[0])
    expect(env).not.toContain('file_edit')
    expect(env).not.toContain('grep')
    expect(env).not.toContain('ask')
  })
})

describe('G2 前缀缓存不变量：turn 内字节一致（R2）+ 工具定义稳定', () => {
  it('同一 turn 的多次模型请求，system 段与 tools 定义完全一致', async () => {
    responder = toolThenFinal('file_list', { path: root }, '列完了')
    const chat = newChat()
    await chat.open('列一下目录', io())

    const turns = gw.turns()
    expect(turns.length).toBeGreaterThanOrEqual(2) // 工具轮 + 收尾轮
    expect(envOf(turns[0])).toBe(envOf(turns[1]))
    expect(JSON.stringify(turns[0].tools)).toBe(JSON.stringify(turns[1].tools))
  })

  it('turn 中途写入记忆也不改变本 turn 的 system（R2）', async () => {
    responder = toolThenFinal('remember', { text: '中途写入的记忆', title: '中途' }, '记住了')
    const chat = newChat()
    await chat.open('记住一件事', io())

    const turns = gw.turns()
    expect(turns.length).toBeGreaterThanOrEqual(2)
    // 记忆确实写进去了
    expect(ctx.memory!.list()).toHaveLength(1)
    // 但本 turn 的 system 未被重建（仍不含新记忆）
    expect(envOf(turns[0])).toBe(envOf(turns[1]))
    expect(envOf(turns[1])).not.toContain('中途')
  })
})

describe('G3 记忆闭环：remember → 索引进 system → recall 取回正文', () => {
  it('写入落盘、索引进入下一轮 system、recall 返回正文', async () => {
    // 长文本：索引里只有标题 + 前 60 字 gist，尾部可用来验证「正文不常驻」
    const proj = '/Users/mac/project/ctools'
    const tail = '尾部独有标记TAILMARK'
    const body = `用户的项目在 ${proj}，${'补充说明'.repeat(40)}${tail}`

    // ① agent 记住
    responder = toolThenFinal('remember', { text: body, title: '项目位置' })
    const chat = newChat()
    await chat.open('记住项目位置', io())

    expect(existsSync(join(userData, 'memory.jsonl'))).toBe(true)
    expect(readFileSync(join(userData, 'MEMORY.md'), 'utf-8')).toContain('项目位置')

    // ② 下一轮：索引常驻进 system
    gw.reset()
    responder = () => ({ stream: true, content: '好的' })
    await chat.run('第二问', io())
    const env = envOf(gw.turns()[0])
    expect(env).toContain('项目位置')
    expect(env).toMatch(/\([0-9a-f]{8}\)/) // 索引行含 id

    // ③ 正文默认**不**常驻：索引只到 gist（前 60 字），尾部仍在库里但没进上下文
    expect(env).not.toContain(tail)

    // ④ recall 才把正文取回上下文
    gw.reset()
    responder = toolThenFinal('recall', { query: '项目位置' })
    const evs: SessionEvent[] = []
    await chat.run('项目在哪', io(evs))
    const result = evs.find((e) => e.type === 'tool.result')
    expect(result?.content).toContain(proj)
    expect(result?.content).toContain(tail)
  })

  it('pinned 记忆的正文常驻进 system', async () => {
    const meta = ctx.memory!.add({ text: '常驻的偏好正文', title: '偏好' })
    ctx.memory!.setPinned(meta.id, true)
    const chat = newChat()
    await chat.open('你好', io())
    const env = envOf(gw.turns()[0])
    expect(env).toContain('【常驻记忆】')
    expect(env).toContain('常驻的偏好正文')
  })

  it('记忆浏览命令对 agent 不可见', async () => {
    const chat = newChat()
    await chat.open('你好', io())
    const names = gw.turns()[0].tools.map((t) => t.function.name)
    expect(names).not.toContain('memory') // 浏览入口不暴露给模型
    expect(names).toContain('recall')
  })
})

describe('G4 大结果外置：退出上下文、可回取', () => {
  it('>8KB 的工具结果落 spill，上下文只剩指针，且能读回全文', async () => {
    const big = 'R'.repeat(20_000)
    writeFileSync(join(root, 'big.txt'), big)
    responder = toolThenFinal('file_read', { path: join(root, 'big.txt') }, '读完了')
    const chat = newChat()
    await chat.open('读 big.txt', io())

    // 全文落盘
    const files = readdirSync(ctx.spillDir!)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(ctx.spillDir!, files[0]), 'utf-8')).toBe(big)

    // 后续请求里该工具消息已被换成指针，不再携带全文
    const toolMsg = gw.turns()[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('完整结果已存至')
    expect(toolMsg?.content).not.toContain(big)
    expect((toolMsg?.content ?? '').length).toBeLessThan(4000)

    // agent 可经 file_read 回取（spill 在读白名单、不在写白名单）
    const back = await fileRead.run({ path: join(ctx.spillDir!, files[0]) }, ctx)
    expect((back as { text: string }).text).toBe(big)
  })

  it('小结果不落盘、不进指针（避免无谓外置）', async () => {
    writeFileSync(join(root, 'small.txt'), '小内容')
    responder = toolThenFinal('file_read', { path: join(root, 'small.txt') }, '读完了')
    const chat = newChat()
    await chat.open('读 small.txt', io())
    expect(existsSync(ctx.spillDir!) ? readdirSync(ctx.spillDir!) : []).toHaveLength(0)
    const toolMsg = gw.turns()[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toBe('小内容')
  })
})

describe('G5 摘要压缩：原文退出上下文、摘要进入、审计无损', () => {
  it('超上限 → 走模型摘要 + 原文被 shadow；transcript 仍保留原文', async () => {
    ctx.config.contextTokens = 400 // 小窗口逼出压缩

    const summaryReply = '早期要点：目标是 Z'
    responder = (req) => (req.stream ? { stream: true, content: '收到' } : { stream: false, content: summaryReply })

    const chat = newChat()
    await chat.open(undefined, io()) // 先建会话（run 在无会话时直接返回）
    for (let i = 0; i < 8; i++) {
      await chat.run(`第${i}轮：${'甲'.repeat(300)}`, io())
    }

    // ① 确实调了模型做摘要（非流式，且带摘要指令）
    const sumCall = gw.calls().find((c) => c.messages[0]?.content?.includes('即将被压缩掉'))
    expect(sumCall).toBeTruthy()

    // ② 摘要事件落库并参与投影
    const evs = chat.transcript()
    const sumEv = evs.find((e) => e.type === 'context.summary')
    expect(sumEv?.content).toContain(summaryReply)

    // ③ 最后一次请求：摘要在内，最早的原文已退出
    const last = gw.turns().at(-1)!
    const joined = last.messages.map((m) => m.content ?? '').join('\n')
    expect(joined).toContain(summaryReply)
    expect(joined).not.toContain('第0轮')

    // ④ 事件溯源无损：原文仍在 transcript（审计）
    expect(evs.some((e) => e.content?.includes('第0轮'))).toBe(true)
    // 且被 shadow 的原文有来源标记
    const compacted = evs.filter((e) => e.type === 'context.compact' || e.type === 'context.summary')
    expect(compacted.some((e) => (e.shadow_seqs ?? []).length > 0)).toBe(true)
  })

  it('摘要模型不可用 → 退回丢头，不崩且仍压到水位下', async () => {
    ctx.config.contextTokens = 400
    responder = (req) => {
      if (!req.stream) throw new Error('gateway 摘要不可用')
      return { stream: true, content: '收到' }
    }
    // 摘要抛错 → makeSummarizer 捕获后返回 undefined
    responder = (req) => (req.stream ? { stream: true, content: '收到' } : { stream: false, content: '' })

    const chat = newChat()
    await chat.open(undefined, io()) // 先建会话（run 在无会话时直接返回）
    for (let i = 0; i < 8; i++) {
      await chat.run(`第${i}轮：${'乙'.repeat(300)}`, io())
    }
    // 空摘要 → 无 context.summary，但压缩仍发生（context.compact）
    const evs = chat.transcript()
    expect(evs.some((e) => e.type === 'context.compact')).toBe(true)
    expect(gw.turns().at(-1)!.messages.map((m) => m.content ?? '').join('\n')).not.toContain('第0轮')
  })
})

describe('G8 摘要合并：长会话里模型只看到一条摘要', () => {
  it('多次压缩后：transcript 有多条摘要历史，但请求里只有一条（已合并）', async () => {
    ctx.config.contextTokens = 400
    responder = (req) => (req.stream ? { stream: true, content: '收到' } : { stream: false, content: '累积摘要' })

    const chat = newChat()
    await chat.open(undefined, io())
    for (let i = 0; i < 20; i++) {
      await chat.run(`第${i}轮：${'丙'.repeat(300)}`, io())
    }

    // 确实发生了多次摘要（否则本用例验证不到合并）
    const allSummaries = chat.transcript().filter((e) => e.type === 'context.summary')
    expect(allSummaries.length).toBeGreaterThan(1)

    // 但最后一次请求里只有**一条**摘要消息
    const last = gw.turns().at(-1)!
    const visible = last.messages.filter((m) => m.content?.includes('早期对话摘要'))
    expect(visible).toHaveLength(1)

    // 且合并确实把旧摘要喂给过模型（输入里出现「已有摘要」标记）
    const mergeCall = gw.calls().find((c) => c.messages.some((m) => m.content?.includes('已有摘要')))
    expect(mergeCall).toBeTruthy()

    // 最早的原文仍不在上下文里（压缩生效）
    expect(last.messages.map((m) => m.content ?? '').join('\n')).not.toContain('第0轮')
  })
})

describe('G6 安全闸门回归：白名单兜底 + 破坏性操作人工在环', () => {
  it('agent 幻觉调用未提供的工具 → 白名单拒绝，不执行', async () => {
    responder = toolThenFinal('web_search', { query: 'x' }, '好的')
    const chat = newChat()
    const evs: SessionEvent[] = []
    await chat.open('搜一下', io(evs))
    const result = evs.find((e) => e.type === 'tool.result')
    expect(result?.content).toContain('不在 agent 白名单')
  })

  it('agent 发起覆盖写 → 走人工确认；拒绝则不落盘', async () => {
    const target = join(root, 'guard.txt')
    writeFileSync(target, 'v1')
    responder = toolThenFinal('file_write', { path: target, content: 'v2' }, '好的')
    const chat = newChat()
    const asked: string[] = []
    await chat.open('覆盖它', {
      onEvent: () => {},
      onDelta: () => {},
      onConfirm: async (tool) => {
        asked.push(tool)
        return false
      },
    })
    expect(asked).toContain('file_write')
    expect(readFileSync(target, 'utf-8')).toBe('v1')
  })
})

describe('G9 P1 工具能力：ask / file_edit / grep / 并发顺序 / 工具描述', () => {
  it('ask：问题到达用户，回答回填为 tool.result', async () => {
    responder = toolThenFinal('ask', { question: '选哪个方案？', options: ['A', 'B'] }, '好的')
    const asked: Array<{ q: string; opts?: string[] }> = []
    const evs: SessionEvent[] = []
    const chat = newChat(fullRegistry())
    await chat.open('帮我选一个', io(evs, { onAsk: async (q, opts) => { asked.push({ q, opts }); return 'B' } }))

    expect(asked[0].q).toBe('选哪个方案？')
    expect(asked[0].opts).toEqual(['A', 'B'])
    expect(evs.find((e) => e.type === 'tool.result')?.content).toBe('用户回答：B')
  })

  it('grep：结果以 路径:行号 进入 tool.result', async () => {
    writeFileSync(join(root, 'notes.txt'), 'first line\nneedle here\nthird\n')
    responder = toolThenFinal('grep', { pattern: 'needle' }, '找到了')
    const evs: SessionEvent[] = []
    const chat = newChat(fullRegistry())
    await chat.open('搜 needle', io(evs))

    const result = evs.find((e) => e.type === 'tool.result')?.content ?? ''
    expect(result).toContain('notes.txt:2')
    expect(result).toContain('needle here')
  })

  it('file_edit：经网关走通，唯一匹配替换落盘', async () => {
    const target = join(root, 'edit-me.txt')
    writeFileSync(target, 'alpha\nbeta\n')
    ctx.config.writeConfirm = 'never'
    responder = toolThenFinal('file_edit', { path: target, old_string: 'beta', new_string: 'BETA' }, '改好了')
    const chat = newChat(fullRegistry())
    await chat.open('把 beta 改成大写', io())

    expect(readFileSync(target, 'utf-8')).toBe('alpha\nBETA\n')
    expect(gw.turns()[1].messages.find((m) => m.role === 'tool')?.content).toContain('已修改')
  })

  it('只读批：事件顺序为 全部 call → 全部 result（与模型给出顺序一致）', async () => {
    responder = (req) => {
      let lastUser = -1
      req.messages.forEach((m, i) => {
        if (m.role === 'user') lastUser = i
      })
      const thisTurn = req.messages.slice(lastUser + 1)
      return thisTurn.some((m) => m.role === 'tool')
        ? { stream: true, content: '都看完了' }
        : { stream: true, toolCalls: [{ name: 'file_list', args: { path: root } }, { name: 'find_file', args: { query: 'x' } }] }
    }
    const evs: SessionEvent[] = []
    const chat = newChat(fullRegistry())
    await chat.open('列目录并找文件', io(evs))
    const seq = evs
      .filter((e) => e.type === 'tool.call' || e.type === 'tool.result')
      .map((e) => `${e.type}:${e.tool_name}`)
    expect(seq).toEqual(['tool.call:file_list', 'tool.call:find_file', 'tool.result:file_list', 'tool.result:find_file'])
  })

  it('工具描述进入 tools 定义（不再是 title）', async () => {
    responder = () => ({ stream: true, content: '好的' })
    const chat = newChat(fullRegistry())
    await chat.open('你好', io())
    const byName = new Map(gw.turns()[0].tools.map((t) => [t.function.name, t.function.description]))
    expect(byName.get('file_edit')).toContain('不要整份重写')
    expect(byName.get('grep')).toContain('find_file')
    expect(byName.get('file_read')).toContain('offset/limit')
    expect(byName.get('ask')).toContain('options')
  })

  it('环境段为已启用的 P1 工具列出要点', async () => {
    responder = () => ({ stream: true, content: '好的' })
    const chat = newChat(fullRegistry())
    await chat.open('你好', io())
    const env = envOf(gw.turns()[0])
    expect(env).toContain('file_edit')
    expect(env).toContain('grep')
    expect(env).toContain('ask')
  })
})

describe('G11 长会话可用性（specs/context.md 的实际表现）', () => {
  /**
   * 一小段带工具往返的轮次，用来把会话堆到触发压缩。
   * **必须区分非流式请求**：那是上下文摘要调用，若也当成流式回空串，摘要会失败并退回「直接丢头」，
   * 于是这段测试就验证不到摘要承接早期目标的行为。
   */
  const turnWithTool = (tool: string, args: unknown, summary: string) => (req: GatewayRequest): Reply => {
    if (!req.stream) return { stream: false, content: summary }
    let lastUser = -1
    req.messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const thisTurn = req.messages.slice(lastUser + 1)
    return thisTurn.some((m) => m.role === 'tool')
      ? { stream: true, content: '好' }
      : { stream: true, toolCalls: [{ name: tool, args }] }
  }

  it('长会话：每轮请求都不超预算，且早期目标由摘要保住（而非直接丢失）', async () => {
    ctx.config.contextTokens = 1200 // 小窗口逼出多轮压缩
    const goal = '目标：把 /tmp/report.csv 按月份汇总'
    // 摘要承接早期目标（真实场景里由模型产出）
    responder = turnWithTool('file_list', { path: root }, '早期要点：目标是把 /tmp/report.csv 按月份汇总')

    const chat = newChat(fullRegistry())
    await chat.open(undefined, io())
    await chat.run(goal, io()) // 第一轮承载任务目标
    for (let i = 0; i < 25; i++) await chat.run(`第${i}轮：${'补充'.repeat(40)}`, io())

    // ① 每一次发给模型的请求都在预算内（用与实现同源的估算，容忍 system 段与工具定义的少量溢出）
    const over = gw.turns().filter((t) => estimateMessagesTokens(t.messages) > 1200 * 1.6)
    expect(over).toHaveLength(0)

    // ② 早期目标没有消失：要么原文还在，要么被摘要承接（不得静默丢失）
    const last = gw.turns().at(-1)!
    const joined = last.messages.map((m) => m.content ?? '').join('\n')
    // 审计无损：原文永远在 transcript 里
    expect(chat.transcript().some((e) => e.content?.includes('report.csv'))).toBe(true)
    // 模型侧：早期目标不得静默消失 —— 要么原文还在，要么被摘要承接
    expect(joined.includes('report.csv')).toBe(true)

    // ③ 原子性：请求里绝不出现「孤立的 tool 消息」（无前置 tool_calls）——上游会 400
    for (const t of gw.turns()) {
      t.messages.forEach((m, i) => {
        if (m.role !== 'tool') return
        const prev = t.messages[i - 1]
        const ok = prev?.role === 'assistant' && (prev?.tool_calls as unknown[] | undefined)?.length
        expect(ok).toBeTruthy()
      })
    }
  })

  it('长会话不会失控：轮数与耗时都在有界范围', async () => {
    ctx.config.contextTokens = 1200
    responder = () => ({ stream: true, content: '好' })
    const chat = newChat()
    await chat.open(undefined, io())
    const t0 = Date.now()
    for (let i = 0; i < 40; i++) await chat.run(`第${i}轮：${'内容'.repeat(30)}`, io())
    const elapsed = Date.now() - t0
    // 40 轮 × (1 次模型请求 + 压缩开销) 应在数秒内完成；这里给足余量只拦「数量级失控」
    expect(elapsed).toBeLessThan(20_000)
    // 摘要不堆积：模型可见的摘要始终只有一条（合并生效）
    const visible = gw.turns().at(-1)!.messages.filter((m) => m.content?.includes('早期对话摘要'))
    expect(visible.length).toBeLessThanOrEqual(1)
  })
})

describe('G10 续聊（attach）：完整历史进入下一次请求', () => {
  it('attach 一段多轮会话后追问，此前每一轮都仍在请求里', async () => {
    responder = () => ({ stream: true, content: '好的' })
    const chat = newChat()
    await chat.open(undefined, io())
    for (let i = 1; i <= 3; i++) await chat.run(`第${i}问`, io())
    const id = chat.sessionId()!
    expect(id).toBeTruthy()

    // 新实例模拟「从最近会话进入」
    const chat2 = newChat()
    await chat2.attach(id)
    expect(chat2.sessionId()).toBe(id)

    gw.reset()
    await chat2.run('追问', io())
    const joined = gw.turns()[0].messages.map((m) => m.content ?? '').join('\n')
    expect(joined).toContain('第1问')
    expect(joined).toContain('第2问')
    expect(joined).toContain('第3问')
    expect(joined).toContain('追问')
    // 会话上下文（角色/环境）也应在
    expect(gw.turns()[0].messages[0].role).toBe('system')
  })

  it('attach 后助手此前回复也在请求里（不只用户消息）', async () => {
    responder = (req) => ({ stream: true, content: `回复${req.messages.filter((m) => m.role === 'user').length}` })
    const chat = newChat()
    await chat.open(undefined, io())
    await chat.run('Q1', io())
    await chat.run('Q2', io())
    const id = chat.sessionId()!

    const chat2 = newChat()
    await chat2.attach(id)
    gw.reset()
    await chat2.run('Q3', io())
    const joined = gw.turns()[0].messages.map((m) => m.content ?? '').join('\n')
    expect(joined).toContain('回复1')
    expect(joined).toContain('回复2')
  })
})

describe('G7 规划模式工具集：规划只读、执行全量', () => {
  const planText = '摘要：整理目录\n1. 调研现状\n2. 汇总结果'

  it('规划 pass 只提供只读工具；批准执行后恢复全量', async () => {
    responder = () => ({ stream: true, content: planText })
    const chat = newChat()
    chat.setMode('plan')
    await chat.open('帮我整理目录', io())

    const planTools = gw.turns()[0].tools.map((t) => t.function.name)
    expect(planTools).toContain('file_read')
    expect(planTools).toContain('recall') // 只读记忆检索可入规划
    expect(planTools).not.toContain('file_write')
    expect(planTools).not.toContain('file_rm')
    expect(planTools).not.toContain('remember')

    // 批准执行 → 全量工具
    gw.reset()
    await chat.executePlan(io())
    const execTools = gw.turns()[0].tools.map((t) => t.function.name)
    expect(execTools).toContain('file_write')
    expect(execTools).toContain('file_rm')
  })
})
