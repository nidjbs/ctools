// markdown 轻量解析（md.ts）：行内/块级 token 纯函数。
import { describe, expect, it } from 'vitest'
import { parseInline, parseBlocks } from '../src/shared/md'

describe('parseInline', () => {
  it('code / bold / italic / strike / text', () => {
    const t = parseInline('前 `x++` 后 **粗** 斜*体* ~~删~~ 尾')
    const kinds = t.map((x) => x.t)
    expect(kinds).toContain('code')
    expect(kinds).toContain('b')
    expect(kinds).toContain('i')
    expect(kinds).toContain('s')
    expect(t.find((x) => x.t === 'code')).toMatchObject({ v: 'x++' })
    expect(t.find((x) => x.t === 'b')).toMatchObject({ v: '粗' })
  })

  it('链接解析带 href', () => {
    const t = parseInline('看 [文档](https://a.b/c)')
    const a = t.find((x) => x.t === 'a')
    expect(a).toMatchObject({ v: '文档', href: 'https://a.b/c' })
  })

  it('纯文本不变', () => {
    expect(parseInline('hello world')[0]).toEqual({ t: 'text', v: 'hello world' })
  })
})

describe('parseBlocks', () => {
  it('fenced code 保留语言与多行内容', () => {
    const src = '```ts\nconst a = 1\nconst b = 2\n```'
    const b = parseBlocks(src)
    expect(b).toHaveLength(1)
    expect(b[0]).toEqual({ t: 'code', lang: 'ts', code: 'const a = 1\nconst b = 2' })
  })

  it('标题 / 无序列表 / 段落', () => {
    const b = parseBlocks('# 标题\n\n- 一\n- 二\n\n普通段落 **粗**')
    const types = b.map((x) => x.t)
    expect(types).toEqual(['h', 'ul', 'p'])
    expect((b[0] as { level: number }).level).toBe(1)
    const ul = b[1] as { items: unknown[][] }
    expect(ul.items).toHaveLength(2)
    expect(parseBlocks('普通段落 **粗**').at(-1)).toMatchObject({ t: 'p' })
  })

  it('有序列表 / 引用 / hr', () => {
    const b = parseBlocks('1. 第一\n2. 第二\n\n---')
    expect(b.map((x) => x.t)).toEqual(['ol', 'hr'])
  })

  it('HTML 串按纯文本 token 处理（渲染层只会当文本节点输出，无注入面）', () => {
    const b = parseBlocks('<script>alert(1)</script>')
    const p = b[0] as { t: 'p'; inlines: { t: string; v?: string }[] }
    expect(p.t).toBe('p')
    expect(p.inlines[0].t).toBe('text')
    expect(p.inlines[0].v).toContain('script')
  })
})
