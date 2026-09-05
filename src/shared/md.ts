// 轻量 markdown 解析（无依赖，纯函数，可单测）。只输出结构化 token，渲染层用 React 元素
// 生成（绝不 innerHTML），模型输出无注入面。
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; v: string }
  | { t: 'i'; v: string }
  | { t: 's'; v: string }
  | { t: 'a'; v: string; href: string }

export type Block =
  | { t: 'code'; lang: string; code: string }
  | { t: 'h'; level: number; inlines: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'q'; inlines: Inline[] }
  | { t: 'hr' }
  | { t: 'p'; inlines: Inline[] }

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\(([^)\s]+)\))|(\*[^*\n]+\*)/g

/** 行内解析：code / bold / strike / link / italic / text。 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(src))) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) })
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) })
    else if (m[2]) out.push({ t: 'b', v: m[2].slice(2, -2) })
    else if (m[3]) out.push({ t: 's', v: m[3].slice(2, -2) })
    else if (m[4]) out.push({ t: 'a', v: m[4].slice(1, m[4].indexOf('](')), href: m[5] })
    else out.push({ t: 'i', v: m[6].slice(1, -1) })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) })
  return out
}

const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*\d+\.\s+(.*)$/

/** 块级解析：fence / 标题 / hr / 引用 / 列表 / 段落。 */
export function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    // fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过闭合 ```（可能不存在）
      blocks.push({ t: 'code', lang, code: buf.join('\n') })
      continue
    }
    // heading
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) {
      blocks.push({ t: 'h', level: hm[1].length, inlines: parseInline(hm[2]) })
      i++
      continue
    }
    // hr
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ t: 'q', inlines: parseInline(buf.join(' ')) })
      continue
    }
    // list
    const ulm = UL.exec(line)
    if (ulm) {
      const items: Inline[][] = []
      while (i < lines.length) {
        const mm = UL.exec(lines[i])
        if (mm) {
          items.push(parseInline(mm[1]))
          i++
        } else break
      }
      blocks.push({ t: 'ul', items })
      continue
    }
    const olm = OL.exec(line)
    if (olm) {
      const items: Inline[][] = []
      while (i < lines.length) {
        const mm = OL.exec(lines[i])
        if (mm) {
          items.push(parseInline(mm[1]))
          i++
        } else break
      }
      blocks.push({ t: 'ol', items })
      continue
    }
    blocks.push({ t: 'p', inlines: parseInline(line) })
    i++
  }
  return blocks
}
