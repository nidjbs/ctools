// AI 对话窗。渲染以主进程 session transcript 为唯一事实源：
// 稳定事件(user/assistant/tool.call/错误)到达 → 整体重建；流式增量进独立的 draft 气泡。
// 挂载时若首轮已完成/进行中，transcript() 会把已落库事件全部带出，避免窗口加载慢导致空白。
import { useEffect, useRef, useState } from 'react'
import type { CommandMeta, DraftMeta, SessionEvent } from '../../shared/types'
import { Md, CopyButton } from './Md'
import ModeChip from './ModeChip'
import PlanCard, { type PlanAction } from './PlanCard'
import { planTextSeqs, taskPlan } from '../../shared/planModel'
import { toolRowOf, runStatusLabel, type ToolRow } from '../../shared/chatModel'
import { quickEnter } from '../../shared/quickRun'

type Bubble = { role: 'user' | 'assistant' | 'tool'; content: string }

function toBubble(ev: SessionEvent): Bubble | null {
  if (ev.type === 'user.message') return { role: 'user', content: ev.content ?? '' }
  if (ev.type === 'tool.call') return null // 工具调用过程不展示
  if (ev.type === 'agent.error') return { role: 'tool', content: `✗ ${ev.content ?? '执行失败'}` }
  if (ev.type === 'assistant.message') {
    if (!ev.content && ev.tool_calls?.length) return null // 纯工具轮无文本
    return { role: 'assistant', content: ev.content ?? '' }
  }
  return null
}

const REBUILD = new Set(['user.message', 'assistant.message', 'tool.call', 'tool.result', 'agent.error', 'plan.propose', 'plan.approved', 'plan.rejected'])

/** 运行中真正在跑的工具：transcript 尾部是未配对的 tool.call（其后尚无 result）即视作执行中。 */
function runningTool(evs: SessionEvent[]): string | null {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (e.type === 'tool.result') return null
    if (e.type === 'tool.call') return e.tool_name || 'tool'
    if (e.type === 'assistant.message' || e.type === 'user.message' || e.type === 'agent.error') return null
  }
  return null
}

/** 紧凑工具行：调用中（🔧 / 执行中 ⏳ + 参数预览）或结果（✓ + 摘要 + 复制全文）。 */
function ToolRow({ row, full, live }: { row: ToolRow; full?: string; live?: boolean }) {
  if (row.kind === 'call') {
    return (
      <div className={`tool-row call${live ? ' live' : ''}`} title={live ? `${row.tool} 执行中…` : `${row.tool} 已调用`}>
        <span className="tr-tool">{live ? '⏳' : '🔧'} {row.tool}</span>
        {row.params && <span className="tr-param">{row.params}</span>}
      </div>
    )
  }
  return (
    <div className="tool-row result" title={`${row.tool} 结果`}>
      <span className="tr-tool">✓ {row.tool}</span>
      <span className="tr-summary">{row.summary}</span>
      {full && <CopyButton text={full} label="复制全文" />}
    </div>
  )
}

/** 工具过程组块：相邻 tool 事件折叠成「▸ 工具×N」，默认收起；尾部未配对调用即执行中（live）。 */
function ToolGroup({ events, running }: { events: SessionEvent[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const rows = events.map((ev) => toolRowOf(ev)).filter((r): r is ToolRow => r !== null)
  const last = events[events.length - 1]
  const active = running && !!last && last.type === 'tool.call'
  const names = [...new Set(rows.map((r) => r.tool))]
  const calls = rows.filter((r) => r.kind === 'call').length
  const count = calls || rows.length
  const label = names.join('、')
  return (
    <div className={`tool-group${active ? ' live' : ''}`}>
      <button className="tg-toggle" onClick={() => setOpen((o) => !o)} title="展开/收起工具过程">
        <span className="tg-arrow">{open ? '▾' : '▸'}</span>
        <span className="tg-tool">🔧 工具 {label}</span>
        <span className="tg-count">· {count} 次调用</span>
        {active && <span className="spinner sm" />}
      </button>
      {open && (
        <div className="tg-body">
          {rows.map((r, i) => (
            <ToolRow key={i} row={r} full={events[i]?.content} live={active && i === rows.length - 1} />
          ))}
        </div>
      )}
    </div>
  )
}

type Sug = { kind: 'cmd'; c: CommandMeta } | { kind: 'slash'; label: string; desc: string }

/** /save 斜杠候选（固定）。 */
const SLASH_SUG: Sug = { kind: 'slash', label: '/save <名称>', desc: '把会话沉淀为可复用模板' }

export default function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draftText, setDraftText] = useState('') // 流式增量，尚未落到 transcript
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftMeta | null>(null) // /save 草稿（可编辑/调整）
  const [feedback, setFeedback] = useState('')
  const [cands, setCands] = useState<Sug[]>([]) // 输入候选（commands.match 同源 Launcher）
  const [sel, setSel] = useState(-1) // 候选选中（默认 -1；有候选且已就绪时 effect 置 0）
  const [cmdOut, setCmdOut] = useState<string | null>(null) // 面板执行的 quick 结果
  const [quickConfirm, setQuickConfirm] = useState<{ id: string; input: string; message: string } | null>(null)
  const [approval, setApproval] = useState<{ id: number; tool: string; message: string } | null>(null)
  const [planPending, setPlanPending] = useState(false) // plan.propose 后待批准（门控联想等）
  const [evs, setEvs] = useState<SessionEvent[]>([]) // 最近一次 transcript，供计划卡推导
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const verRef = useRef(0) // 防止慢快照覆盖新快照
  const task = taskPlan(evs)
  const execTool = running ? runningTool(evs) : null // 运行中正在执行的工具名（loading 态）

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    const tail = tailRef.current
    tail?.scrollIntoView({ behavior: 'smooth' })
  }, [bubbles, draftText, running, error])

  useEffect(() => {
    if (!window.api) {
      setError('窗口 API 未就绪 —— 检查主进程/preload 报错')
      return
    }
    void window.api.session.running().then(setRunning).catch(() => {})

    // 整体重建：每次拉最新 transcript；乱序返回的旧快照不生效
    const sync = async () => {
      const v = ++verRef.current
      try {
        const all = await window.api.session.transcript()
        if (v !== verRef.current) return
        setEvs(all)
        // 计划卡激活（taskPlan 非空）时，隐藏当前段的计划文本气泡；放弃/新段后沉回历史气泡
        const planSeq = taskPlan(all) ? planTextSeqs(all) : new Set<number>()
        setBubbles(
          all
            .map((ev) => (planSeq.has(ev.seq) ? null : toBubble(ev)))
            .filter((b): b is Bubble => b !== null),
        )
      } catch (e) {
        if (v === verRef.current) setError(String((e as Error)?.message ?? e))
      }
    }
    void sync()

    const offDelta = window.api.onSessionDelta((t) => setDraftText((d) => d + t))
    const offEvent = window.api.onSessionEvent((ev) => {
      if (ev.type === 'plan.propose') {
        setDraftText('')
        setPlanPending(true) // 规划结束 → 显示批准面板（running 已随 onRunning 转 false）
      } else if (ev.type === 'plan.approved' || ev.type === 'plan.rejected') {
        setPlanPending(false)
      }
      if (REBUILD.has(ev.type)) {
        setDraftText('')
        void sync()
      }
    })
    // 主进程运行态变化 → 结束时退出「回答中」并重新可用输入
    const offRunning = window.api.onSessionRunning(setRunning)
    // 工具人工在环批准（bash/破坏性写删）
    const offApprove = window.api.onToolConfirm((req) => setApproval(req))
    // 会话被切换（attach/new）→ 清瞬态后重拉 transcript（session:reset）
    const offReset = window.api.onSessionReset(() => {
      setDraftText('')
      setApproval(null)
      setQuickConfirm(null)
      setPlanPending(false)
      setCmdOut(null)
      setError(null)
      setInput('')
      void sync()
    })
    // 晚挂载兜底：首轮已到工具确认/计划批准而我们刚订阅 → 主动拉取待批项
    void window.api.session.pendingConfirm().then((p) => {
      if (p) setApproval(p)
    })
    void window.api.session.pendingPlan().then((p) => {
      if (p) setPlanPending(true)
    })
    return () => {
      offDelta()
      offEvent()
      offRunning()
      offApprove()
      offReset()
    }
  }, [])

  // 输入候选：与 Launcher 同源（commands.match），默认高亮首项以便回车即执行；/ 前缀走 /save。
  useEffect(() => {
    if (!window.api) return
    if (running || draft || approval || planPending) {
      setCands([])
      setSel(-1)
      return
    }
    const q = input.trim()
    if (!q) {
      setCands([])
      setSel(-1)
      return
    }
    let alive = true
    if (q.startsWith('/')) {
      const low = q.toLowerCase()
      const show = '/save 名称'.startsWith(low) || low.startsWith('/save')
      setCands(show ? [SLASH_SUG] : [])
      setSel(show ? 0 : -1)
      return () => {
        alive = false
      }
    }
    void window.api.commands
      .match(q)
      .then((list) => {
        if (!alive) return
        const cs = list.map((c): Sug => ({ kind: 'cmd', c }))
        setCands(cs)
        setSel(cs.length ? 0 : -1)
      })
      .catch(() => {
        if (alive) {
          setCands([])
          setSel(-1)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, running, draft, approval, planPending])

  function decideApproval(ok: boolean) {
    if (!approval) return
    const { id } = approval
    setApproval(null)
    void window.api.session.confirm(id, ok)
  }

  /** plan 模式：批准执行 / 按反馈重规划 / 放弃（由计划卡调用）。 */
  async function decidePlan(action: PlanAction, feedback = '') {
    if (!task || task.status !== 'pending' || running) return
    setPlanPending(false)
    try {
      if (action === 'execute') await window.api.session.executePlan()
      else if (action === 'replan') await window.api.session.replan(feedback.trim())
      else await window.api.session.discardPlan()
    } catch (e) {
      setNotice(`操作失败: ${(e as Error).message}`)
    }
  }

  /** 用 LLM 提炼草稿（feedback 用于按你的要求调整）。 */
  async function regen(hint: string, fb: string) {
    setNotice('正在用 LLM 提炼可复用指令…')
    try {
      const d = await window.api.saves.draft(hint || undefined, fb || undefined)
      setDraft(d)
      setFeedback('')
      setNotice(null)
    } catch (e) {
      setNotice(`提炼失败: ${(e as Error).message}`)
    }
  }

  /** 确认保存当前草稿。 */
  async function persistDraft() {
    if (!draft) return
    try {
      const s = await window.api.saves.save(draft)
      setDraft(null)
      setNotice(`已保存为模板「${s.title}」——Launcher 空态首页 / 前缀搜索即可使用`)
      setTimeout(() => setNotice(null), 6000)
    } catch (e) {
      setNotice(`保存失败: ${(e as Error).message}`)
    }
  }

  /** 执行一条候选：斜杠命令 / quick 命令（Enter 语义与 Launcher 一致：命令名待参数 → 补参数态）。 */
  async function runSug(s: Sug) {
    setSel(-1)
    if (s.kind === 'slash') {
      const raw = input.trim()
      if (/^\/save(\s|$)/.test(raw)) {
        setInput('')
        await runSlash(raw)
      } else {
        setInput('/save ') // 前缀输入 → 展开为命令名+空格
        inputRef.current?.focus()
      }
      return
    }
    const c = s.c
    const t = quickEnter(c, input)
    if (!t.run) {
      setInput(`${c.id} `) // 仅命令名无参数 → 参数态（同 Launcher）
      inputRef.current?.focus()
      return
    }
    setInput('')
    setCmdOut(null)
    try {
      const r = await window.api.commands.run(c.id, t.param)
      if (r.type === 'confirm') {
        setCmdOut(null)
        setQuickConfirm({ id: c.id, input: t.param, message: r.message }) // 就地确认（不再踢去 Launcher）
      } else if (r.type === 'list') {
        setCmdOut(r.items.map((it) => it.title).join('\n'))
      } else if (r.type === 'text') {
        setCmdOut(r.text)
      }
    } catch (e) {
      setNotice(`执行失败: ${(e as Error).message}`)
    }
  }

  /** 就地批准 quick 确认（confirmApproved 重放）；拒绝则关闭。 */
  async function decideQuickConfirm(ok: boolean) {
    if (!quickConfirm) return
    const { id, input: input0 } = quickConfirm
    setQuickConfirm(null)
    setCmdOut(null)
    if (!ok) {
      setNotice('已取消')
      return
    }
    try {
      const r = await window.api.commands.confirm(id, input0)
      if (r.type === 'list') setCmdOut(r.items.map((it) => it.title).join('\n'))
      else if (r.type === 'text') setCmdOut(r.text)
      else setCmdOut('(已执行)')
    } catch (e) {
      setNotice(`执行失败: ${(e as Error).message}`)
    }
  }

  /** 斜杠命令：/save [名称] → LLM 蒸馏 → 草稿确认。 */
  async function runSlash(raw: string) {
    setError(null)
    if (raw.startsWith('/save')) {
      await regen(raw.slice(5).trim(), '')
      return
    }
    setNotice(`未知命令 ${raw}（支持：/save <名称>）`)
    setTimeout(() => setNotice(null), 6000)
  }

  async function send() {
    const text = input.trim()
    if (!text || running) return
    if (draft) {
      setNotice('请先处理当前 /save 草稿（保存或取消）')
      return
    }
    setInput('')
    setNotice(null)
    setPlanPending(false) // 新消息取代待批准计划
    if (text.startsWith('/')) {
      await runSlash(text)
      return
    }
    setDraftText('')
    setError(null)
    setRunning(true)
    try {
      await window.api.session.send(text) // 主进程整轮跑完才 resolve
    } catch {
      /* 错误已持久化为 agent.error 事件，由重建渲染 */
    } finally {
      setRunning(false)
    }
  }

  // 对话流节点：气泡 + 工具过程（相邻 tool 事件折叠为可展开组块）；计划激活时内联计划卡
  const planSeq = task ? planTextSeqs(evs) : new Set<number>()
  const nodes: React.ReactNode[] = []
  let lastUser = -1 // 计划卡插入点（nodes 内最后一个 user 气泡之后）
  let toolBuf: SessionEvent[] = []
  const flushTools = () => {
    if (toolBuf.length) {
      nodes.push(<ToolGroup key={toolBuf[0].event_id} events={toolBuf} running={running} />)
      toolBuf = []
    }
  }
  for (const ev of evs) {
    if (planSeq.has(ev.seq)) continue
    if (toolRowOf(ev)) {
      toolBuf.push(ev) // 聚合相邻工具事件，遇非工具事件再 flush
      continue
    }
    flushTools()
    const b = toBubble(ev)
    if (!b) continue
    if (b.role === 'user') lastUser = nodes.length
    nodes.push(
      <div key={ev.event_id} className={`bubble ${b.role}`}>
        <div className="bubble-head">
          <span className="bubble-role">{b.role === 'user' ? '你' : b.role === 'tool' ? '工具' : '助手'}</span>
          {b.content && <CopyButton text={b.content} />}
        </div>
        <div className="bubble-body">
          {b.role === 'user' || b.role === 'assistant' ? (
            <Md text={b.content} />
          ) : (
            <div className="tool-out">{b.content || '…'}</div>
          )}
        </div>
      </div>,
    )
  }
  flushTools()
  if (task) {
    nodes.splice(
      lastUser + 1,
      0,
      <PlanCard key="plan" task={task} evs={evs} running={running} busy={!!approval} onAction={decidePlan} />,
    )
  }

  return (
    <div className="chat">
      <div className="chat-modebar">
        <ModeChip />
        <button
          className="chat-new"
          disabled={running}
          title="另起一个干净会话"
          onClick={() => void window.api.session.newSession()}
        >
          ＋ 新会话
        </button>
      </div>
      <div className="chat-list">
        {nodes}
        {running && (
          <div className="bubble assistant live">
            <div className="bubble-head">
              <span className="run-status">
                <span className="spinner" />
                {runStatusLabel(execTool, !!draftText)}
              </span>
            </div>
            <div className="bubble-body">{draftText ? <Md text={draftText} /> : <span className="dots"><i /><i /><i /></span>}</div>
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
        <div ref={tailRef} />
      </div>
      {approval && (
        <div className="approve-box">
          <div className="approve-msg">
            <strong>{approval.tool}</strong>：{approval.message}
          </div>
          <div className="confirm-actions">
            <button className="btn approve" onClick={() => decideApproval(true)}>
              批准执行
            </button>
            <button className="btn" onClick={() => decideApproval(false)}>
              拒绝
            </button>
          </div>
        </div>
      )}
      {quickConfirm && !approval && (
        <div className="approve-box">
          <div className="approve-msg">
            <strong>{quickConfirm.id}</strong> 需要人工确认：{quickConfirm.message}
          </div>
          <div className="confirm-actions">
            <button className="btn approve" onClick={() => void decideQuickConfirm(true)}>
              批准执行
            </button>
            <button className="btn" onClick={() => void decideQuickConfirm(false)}>
              拒绝
            </button>
          </div>
        </div>
      )}
      {draft && (
        <div className="save-box">
          <div className="save-h">保存为复用模板（LLM 提炼 · 可编辑/调整后保存）</div>
          <input className="bar" placeholder="名称" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea
            className="bar sb-area"
            placeholder="可复用指令（{param} = 每次用户给的可变输入）"
            value={draft.instruction}
            onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
          />
          <input
            className="bar"
            placeholder="参数引导（如：输入要处理的文本/路径）"
            value={draft.paramHint}
            onChange={(e) => setDraft({ ...draft, paramHint: e.target.value })}
          />
          <div className="sb-row">
            <input
              className="bar"
              placeholder="想怎么调整？如：更简短 / 参数名改成 path"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && feedback.trim()) void regen(draft.title, feedback.trim())
              }}
            />
            <button className="sb-btn" onClick={() => void regen(draft.title, feedback.trim())}>
              重新提炼
            </button>
          </div>
          <div className="confirm-actions">
            <button className="btn approve" onClick={() => void persistDraft()}>
              💾 保存模板
            </button>
            <button
              className="btn"
              onClick={() => {
                setDraft(null)
                setFeedback('')
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {cmdOut && (
        <div className="cmd-out">
          <div className="cmd-out-head">
            <span>命令结果</span>
            <CopyButton text={cmdOut} />
          </div>
          <pre>{cmdOut}</pre>
        </div>
      )}
      {notice && <div className="notice-info">{notice}</div>}
      {cands.length > 0 && (
        <ul className="chat-sug">
          {cands.map((s, i) => (
            <li
              key={s.kind === 'cmd' ? s.c.id : 'slash'}
              className={i === sel ? 'sel' : ''}
              onMouseMove={() => setSel(i)}
              onClick={() => void runSug(s)}
            >
              <span className="sug-key">{s.kind === 'cmd' ? s.c.id : s.label}</span>
              <span className="sug-desc">{s.kind === 'cmd' ? s.c.title : s.desc}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="bar chat-box"
          rows={1}
          value={input}
          placeholder={running ? '回答中…' : draft ? '请先处理 /save 草稿' : '输入消息，回车发送 / Shift+回车换行'}
          disabled={running || !!draft}
          onChange={(e) => {
            setInput(e.target.value)
            setSel(-1)
            e.currentTarget.style.height = 'auto'
            e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 168) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && cands.length) {
              e.preventDefault()
              setSel((s) => (s + 1) % cands.length)
            } else if (e.key === 'ArrowUp' && cands.length) {
              e.preventDefault()
              setSel((s) => (s <= 0 ? cands.length - 1 : s - 1))
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (sel >= 0 && cands[sel]) {
                void runSug(cands[sel])
              } else {
                void send()
              }
            } else if (e.key === 'Escape') {
              e.preventDefault()
              void window.api.window.close() // 收起界面，进程保留
            }
          }}
        />
        {running && (
          <button
            className="stop"
            onClick={() => {
              void window.api.session.cancel()
              setRunning(false)
            }}
          >
            停止
          </button>
        )}
      </div>
    </div>
  )
}
