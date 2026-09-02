import { useEffect, useRef, useState } from 'react'
import type { CommandMeta, CommandResult } from '../../shared/types'

declare global {
  interface Window {
    api: import('../../shared/types').CtoolsApi
  }
}

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
  return <div className="result-text">对话会话（MVP 后续）</div>
}

export default function App() {
  const [input, setInput] = useState('')
  const [matches, setMatches] = useState<CommandMeta[]>([])
  const [result, setResult] = useState<CommandResult | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    const q = input.trim()
    if (!q || result) {
      setMatches([])
      return
    }
    void window.api.commands.match(q).then((m) => {
      setMatches(m)
      setCursor(0)
    })
  }, [input, result])

  async function onEnter() {
    const q = input.trim()
    if (!q) return
    if (result) {
      setResult(null)
      setInput('')
      return
    }
    const picked = matches[cursor]
    if (!picked) return
    setResult(await window.api.commands.run(picked.id, paramFor(picked, q)))
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Escape') {
      if (result) setResult(null)
      else setInput('')
    }
  }

  return (
    <div className="launcher">
      <input
        ref={inputRef}
        className="bar"
        value={input}
        placeholder="输入命令或内容… (trans 翻译 / find_file 找文件)"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        onKeyUp={(e) => e.key === 'Enter' && void onEnter()}
      />
      <div className="body">
        {!result ? (
          <ul className="matches">
            {matches.map((c, i) => (
              <li key={c.id} className={i === cursor ? 'sel' : ''}>
                <span className="m-id">{c.id}</span>
                <span className="m-title">{c.title}</span>
              </li>
            ))}
            {!matches.length && input.trim() && <li className="hint">回车：交给 agent 对话（MVP 后续）</li>}
          </ul>
        ) : (
          <ResultView result={result} />
        )}
      </div>
    </div>
  )
}
