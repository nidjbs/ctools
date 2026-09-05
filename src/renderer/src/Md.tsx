// Markdown 渲染：块级 + 行内（React 元素，无 innerHTML）。代码块带一键复制。
import { useState } from 'react'
import { parseBlocks, type Block, type Inline } from '../../shared/md'

function copyText(text: string) {
  void window.api.system.pbcopy(text)
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy"
      onClick={() => {
        copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? '已复制 ✓' : label}
    </button>
  )
}

function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null
}

function InlineView({ node }: { node: Inline }) {
  switch (node.t) {
    case 'code':
      return <code>{node.v}</code>
    case 'b':
      return <strong>{node.v}</strong>
    case 'i':
      return <em>{node.v}</em>
    case 's':
      return <del>{node.v}</del>
    case 'a': {
      const href = safeHref(node.href)
      if (!href) return <span>{node.v}</span>
      return (
        <a
          className="md-link"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            copyText(href)
          }}
          title={`点击复制 ${href}`}
        >
          {node.v}
        </a>
      )
    }
    default:
      return <>{node.v}</>
  }
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => (
        <InlineView key={i} node={n} />
      ))}
    </>
  )
}

export function Md({ text }: { text: string }) {
  const blocks: Block[] = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'code':
            return (
              <div className="md-code" key={i}>
                <div className="md-code-head">
                  <span>{b.lang || 'text'}</span>
                  <CopyButton text={b.code} label="复制代码" />
                </div>
                <pre>
                  <code>{b.code}</code>
                </pre>
              </div>
            )
          case 'h':
            return <div className={`md-h h${b.level}`} key={i}><Inlines nodes={b.inlines} /></div>
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}><Inlines nodes={it} /></li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}><Inlines nodes={it} /></li>
                ))}
              </ol>
            )
          case 'q':
            return (
              <blockquote key={i}><Inlines nodes={b.inlines} /></blockquote>
            )
          case 'hr':
            return <hr key={i} />
          default:
            return (
              <p key={i}>
                <Inlines nodes={b.inlines} />
              </p>
            )
        }
      })}
    </div>
  )
}
