// AI 对话窗。渲染以主进程 session transcript 为唯一事实源：
// 稳定事件(user/assistant/tool.call/错误)到达 → 整体重建；流式增量进独立的 draft 气泡。
// 挂载时若首轮已完成/进行中，transcript() 会把已落库事件全部带出，避免窗口加载慢导致空白。
import { useEffect, useRef, useState } from 'react'
import type { DraftMeta, SessionEvent } from '../../shared/types'
import { Md, CopyButton } from './Md'

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

const REBUILD = new Set(['user.message', 'assistant.message', 'tool.call', 'agent.error'])

export default function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [draftText, setDraftText] = useState('') // 流式增量，尚未落到 transcript
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftMeta | null>(null) // /save 草稿（可编辑/调整）
  const [feedback, setFeedback] = useState('')
  const [approval, setApproval] = useState<{ id: number; tool: string; message: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const verRef = useRef(0) // 防止慢快照覆盖新快照

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
        const evs = await window.api.session.transcript()
        if (v !== verRef.current) return
        setBubbles(evs.map(toBubble).filter((b): b is Bubble => b !== null))
      } catch (e) {
        if (v === verRef.current) setError(String((e as Error)?.message ?? e))
      }
    }
    void sync()

    const offDelta = window.api.onSessionDelta((t) => setDraftText((d) => d + t))
    const offEvent = window.api.onSessionEvent((ev) => {
      if (REBUILD.has(ev.type)) {
        setDraftText('')
        void sync()
      }
    })
    // 主进程运行态变化 → 结束时退出「回答中」并重新可用输入
    const offRunning = window.api.onSessionRunning(setRunning)
    // 工具人工在环批准（bash/破坏性写删）
    const offApprove = window.api.onToolConfirm((req) => setApproval(req))
    // 晚挂载兜底：首轮已到工具确认而我们刚订阅 → 主动拉取待批项
    void window.api.session.pendingConfirm().then((p) => {
      if (p) setApproval(p)
    })
    return () => {
      offDelta()
      offEvent()
      offRunning()
      offApprove()
    }
  }, [])

  function decideApproval(ok: boolean) {
    if (!approval) return
    const { id } = approval
    setApproval(null)
    void window.api.session.confirm(id, ok)
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

  return (
    <div className="chat">
      <div className="chat-list">
        {bubbles.map((b, i) => (
          <div key={i} className={`bubble ${b.role}`}>
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
          </div>
        ))}
        {running && (
          <div className="bubble assistant">
            <div className="bubble-head">
              <span className="bubble-role">助手</span>
            </div>
            <div className="bubble-body">{draftText ? <Md text={draftText} /> : '…'}</div>
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
      {notice && <div className="notice-info">{notice}</div>}
      <div className="chat-input-row">
        <input
          ref={inputRef}
          className="bar"
          value={input}
          placeholder={running ? '回答中…' : draft ? '请先处理 /save 草稿' : '输入消息，回车发送'}
          disabled={running || !!draft}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
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
