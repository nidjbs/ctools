import { useEffect, useRef, useState } from 'react'
import type { CommandMeta, CommandResult, SavedMeta } from '../../shared/types'
import { TEMPLATES, type Template } from '../../shared/templates'

declare global {
  interface Window {
    api: import('../../shared/types').CtoolsApi
  }
}

/** 无命令命中时，这些词直接打开 Settings。 */
const SETTINGS_KEYS = new Set(['settings', '设置', 'config', 'prefs'])

type Item = { kind: 'cmd'; c: CommandMeta } | { kind: 'tpl'; t: Template }

/** 提取命令参数：输入命中命令前缀后，剩余部分即参数。 */
function paramFor(c: CommandMeta, q: string): string {
  const lower = q.toLowerCase()
  for (const n of [c.id, ...c.aliases]) {
    const nl = n.toLowerCase()
    if (lower === nl) return ''
    if (lower.startsWith(nl + ' ')) return q.slice(nl.length).trim()
  }
  return q
}

/** 模板参数：输入以 模板 id/标题 开头则剩余为参数；否则整段作为参数（agent 类）。 */
function templateParam(t: Template, q: string): string {
  const lower = q.toLowerCase()
  for (const n of [t.id, t.title]) {
    const nl = n.toLowerCase()
    if (lower === nl) return ''
    if (lower.startsWith(nl + ' ')) return q.slice(nl.length).trim()
  }
  return q
}

/** /save 沉淀 → 可渲染模板（⭐ agent 类；{param} 占位换成用户输入）。 */
function toTpl(s: SavedMeta): Template {
  const build = (p: string): string => {
    if (!p) return s.instruction
    return s.instruction.includes('{param}') ? s.instruction.replace(/\{param\}/g, p) : `${s.instruction}\n\n用户补充：${p}`
  }
  return {
    id: s.id,
    title: s.title,
    emoji: '⭐',
    hint: s.paramHint || '会话沉淀模板（可再加补充）',
    kind: 'agent',
    build,
  }
}

/** 前缀/包含匹配模板（命令优先：有命令命中就不列模板）。 */
function matchTemplates(q: string, list: Template[]): Template[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const hit = list.filter(
    (t) => t.id.toLowerCase().startsWith(s) || t.title.toLowerCase().startsWith(s),
  )
  if (hit.length) return hit.slice(0, 6)
  return list.filter((t) => t.id.toLowerCase().includes(s) || t.title.toLowerCase().includes(s)).slice(0, 6)
}

function ResultView({ result }: { result: CommandResult }) {
  if (result.type === 'text') {
    return <div className="result-text">{result.text}</div>
  }
  if (result.type === 'list') {
    return (
      <ul className="result-list">
        {result.items.map((it, i) => (
          <li key={i} onClick={() => void window.api.system.pbcopy(it.copy ?? '')}>
            <div className="li-title">{it.title}</div>
            {it.subtitle && <div className="li-sub">{it.subtitle}</div>}
          </li>
        ))}
      </ul>
    )
  }
  return <div className="result-text">（无结果）</div>
}

export default function App() {
  const [input, setInput] = useState('')
  const [saved, setSaved] = useState<Template[]>([])
  const [cmd, setCmd] = useState<CommandMeta[]>([])
  const [found, setFound] = useState<Template[]>([]) // 普通输入无命令命中时的模板前缀命中
  const [tplCtx, setTplCtx] = useState<Template | null>(null) // 「#id 参数」模式
  const [result, setResult] = useState<CommandResult | null>(null)
  const [confirmReq, setConfirmReq] = useState<{ id: string; input: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false) // 命令执行中：等待响应
  const [fatal, setFatal] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const all: Template[] = [...TEMPLATES, ...saved]

  useEffect(() => inputRef.current?.focus(), [])

  // 加载 /save 沉淀模板（唤起时也刷新）
  useEffect(() => {
    if (!window.api) return
    const load = () => {
      window.api.saves
        .list()
        .then((ms) => setSaved(ms.map(toTpl)))
        .catch(() => {})
    }
    void load()
    const off = window.api.onLauncherShow(() => void load())
    return off
  }, [])

  useEffect(() => {
    if (!window.api) return
    const q = input.trim()
    if (!q) {
      setCmd([])
      setFound([])
      setTplCtx(null)
      setCursor(0)
    } else if (q.startsWith('#')) {
      setCmd([])
      setFound([])
      setTplCtx(all.find((t) => t.id === q.slice(1).split(/\s+/)[0]) ?? null)
      setCursor(0)
    } else {
      setTplCtx(null)
      window.api.commands
        .match(q)
        .then((m) => {
          setCmd(m)
          setFound(m.length === 0 ? matchTemplates(q, all) : [])
          setCursor(0)
        })
        .catch((e) => setFatal(String((e as Error)?.message ?? e)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, result, saved])

  const items: Item[] = (() => {
    const q = input.trim()
    if (!q) return all.map((t) => ({ kind: 'tpl', t }))
    if (q.startsWith('#')) return tplCtx ? [{ kind: 'tpl', t: tplCtx }] : []
    if (cmd.length) return cmd.map((c) => ({ kind: 'cmd', c }))
    return found.map((t) => ({ kind: 'tpl', t }))
  })()

  /** 跑一条 quick 命令（含 confirm 与错误展示）。执行中显示等待态。 */
  async function runQuick(id: string, param: string) {
    setBusy(true)
    setResult(null)
    try {
      const r = await window.api.commands.run(id, param)
      if (r.type === 'confirm') {
        setConfirmReq({ id, input: param, message: r.message })
        setResult(null)
        setInput('')
      } else {
        setResult(r)
      }
    } catch (e) {
      setResult({ type: 'text', text: `执行失败: ${(e as Error).message ?? e}` })
    } finally {
      setBusy(false)
    }
  }

  /** 执行模板：cmd → 直跑命令；agent → 交对话窗。 */
  async function runTemplate(t: Template, param: string) {
    if (t.kind === 'cmd' && t.cmdId) {
      await runQuick(t.cmdId, param)
      return
    }
    setInput('')
    try {
      await window.api.session.open(t.build ? t.build(param) : param)
    } catch (e) {
      setResult({ type: 'text', text: `对话失败: ${(e as Error).message ?? e}` })
    }
  }

  async function approveConfirm() {
    if (!confirmReq) return
    const { id, input: input0 } = confirmReq
    setConfirmReq(null)
    setBusy(true)
    try {
      setResult(await window.api.commands.confirm(id, input0))
    } catch (e) {
      setResult({ type: 'text', text: `执行失败: ${(e as Error).message ?? e}` })
    } finally {
      setBusy(false)
    }
  }

  function dismissConfirm() {
    setConfirmReq(null)
    setInput('')
    inputRef.current?.focus()
  }

  async function onEnter() {
    if (busy || confirmReq) return
    if (result) {
      setResult(null)
      setInput('')
      return
    }
    const q = input.trim()
    // 「#id 参数」模式
    if (q.startsWith('#')) {
      const sp = q.indexOf(' ')
      const param = sp >= 0 ? q.slice(sp + 1).trim() : ''
      if (!tplCtx) return
      if (tplCtx.kind === 'cmd' && !param) return // 命令型等参数
      await runTemplate(tplCtx, param)
      return
    }
    const picked = items[cursor]
    if (picked?.kind === 'tpl') {
      const param = templateParam(picked.t, q)
      if (!param) {
        setInput(`#${picked.t.id} `) // 只选了模板 → 带出参数态
        return
      }
      await runTemplate(picked.t, param)
      return
    }
    if (picked?.kind === 'cmd') {
      if (!q) return
      const param = paramFor(picked.c, q)
      if (!param) {
        setInput(picked.c.id + ' ')
        return
      }
      await runQuick(picked.c.id, param)
      return
    }
    if (!q) return // 其余流程（设置/自由对话）都需要有输入
    if (SETTINGS_KEYS.has(q.toLowerCase())) {
      setInput('')
      try {
        await window.api.window.openSettings()
      } catch (e) {
        setResult({ type: 'text', text: `设置打开失败: ${(e as Error).message ?? e}` })
      }
      return
    }
    // 自由内容 → agent
    setInput('')
    try {
      await window.api.session.open(q)
    } catch (e) {
      setResult({ type: 'text', text: `对话失败: ${(e as Error).message ?? e}` })
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(items.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Tab') {
      const picked = items[cursor]
      const q = input.trim().toLowerCase()
      if (picked?.kind === 'cmd' && (!q || picked.c.id.startsWith(q) || q === picked.c.id)) {
        e.preventDefault()
        setInput(picked.c.id + ' ')
      } else if (picked?.kind === 'tpl' && (!q || picked.t.id.startsWith(q.slice(1)))) {
        e.preventDefault()
        setInput(`#${picked.t.id} `)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (confirmReq) dismissConfirm()
      else if (result) setResult(null)
      else if (input) setInput('')
      else void window.api.window.hide()
    }
  }

  const isTplParam = input.trim().startsWith('#')
  const showHint = !isTplParam && !!input.trim() && items.length === 0 && !fatal

  return (
    <div className="launcher">
      <input
        ref={inputRef}
        className="bar"
        value={input}
        placeholder="模板或输入内容… (回车=交给 agent；#模板id 参数)"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        onKeyUp={(e) => e.key === 'Enter' && void onEnter()}
      />
      <div className="body">
        {fatal && <div className="result-text fatal">{fatal}</div>}
        {!fatal && confirmReq ? (
          <div className="confirm-box">
            <div className="result-text">{confirmReq.message}</div>
            <div className="confirm-actions">
              <button className="btn danger" onClick={() => void approveConfirm()}>
                确认执行
              </button>
              <button className="btn" onClick={dismissConfirm}>
                取消
              </button>
            </div>
          </div>
        ) : !fatal && busy ? (
          <div className="result-text dim">处理中…</div>
        ) : !fatal && !result ? (
          <ul className="matches">
            {items.map((it, i) => (
              <li key={it.kind === 'cmd' ? it.c.id : it.t.id} className={i === cursor ? 'sel' : ''}>
                {it.kind === 'cmd' ? (
                  <>
                    <span className="m-id">{it.c.id}</span>
                    <span className="m-title">{it.c.title}</span>
                  </>
                ) : (
                  <>
                    <span className="m-id">{it.t.emoji}</span>
                    <span className="m-title">{it.t.title}</span>
                    <span className="t-sub">{isTplParam ? it.t.hint : it.t.hint}</span>
                  </>
                )}
              </li>
            ))}
            {!items.length && (
              <li className="hint">
                {showHint
                  ? '回车：交给 agent 对话'
                  : isTplParam
                    ? '未知模板，直接输入内容回车会交给 agent'
                    : '回车：交给 agent 对话'}
              </li>
            )}
          </ul>
        ) : result ? (
          <ResultView result={result} />
        ) : null}
      </div>
    </div>
  )
}
