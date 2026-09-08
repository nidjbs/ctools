// office_read：读取 docx/xlsx/pdf/纯文本 → 文本（只读，file_roots 限定，agentTool）。
// specs/office-read.md。pdf 解析 best-effort（动态导入失败返回原因）。
import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import type { Command } from '../src/shared/types'
import { checkInside } from '../src/shared/filePolicy'
import { queryText } from '../src/shared/tool'

const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html'])
const MAX_OUT = 30_000

function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function clip(text: string): string {
  return text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n…[截断，全文 ${text.length} 字符]` : text
}

/** docx：解包 document.xml，按 <w:p> 段落拼接 <w:t>。 */
export async function parseDocx(buf: Buffer): Promise<string> {
  const z = await JSZip.loadAsync(buf)
  const entry = z.file('word/document.xml')
  if (!entry) return '(未找到 word/document.xml)'
  const xml = await entry.async('string')
  const paras: string[] = []
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>/g
  let pm: RegExpExecArray | null
  while ((pm = pRe.exec(xml))) {
    const tRe = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g
    const texts: string[] = []
    let tm: RegExpExecArray | null
    while ((tm = tRe.exec(pm[0]))) texts.push(tm[1])
    if (texts.join('').trim()) paras.push(texts.join(''))
  }
  return paras.length ? paras.join('\n') : '(无可提取文本)'
}

/** xlsx：sharedStrings + 第一个 worksheet，单元格按行 | 连接。 */
export async function parseXlsx(buf: Buffer): Promise<string> {
  const z = await JSZip.loadAsync(buf)
  const shared: string[] = []
  const ssf = z.file('xl/sharedStrings.xml')
  if (ssf) {
    const xml = await ssf.async('string')
    const siRe = /<si[ >][\s\S]*?<\/si>/g
    let sm: RegExpExecArray | null
    while ((sm = siRe.exec(xml))) {
      const tRe = /<t(?: [^>]*)?>([\s\S]*?)<\/t>/g
      const texts: string[] = []
      let tm: RegExpExecArray | null
      while ((tm = tRe.exec(sm[0]))) texts.push(tm[1])
      shared.push(texts.join(''))
    }
  }
  const sheetName = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet.xml'].find((n) => z.file(n))
  if (!sheetName) return '(未找到 worksheet)'
  const xml = await z.file(sheetName)!.async('string')
  const rows: string[] = []
  const rowRe = /<row[ >][\s\S]*?<\/row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(xml))) {
    const cells: string[] = []
    const cRe = /<c([^>]*)>([\s\S]*?)<\/c>/g
    let cm: RegExpExecArray | null
    while ((cm = cRe.exec(rm[0]))) {
      const type = (cm[1].match(/t="([^"]+)"/) || [])[1] || 'n'
      const v = (cm[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ''
      const inline = (cm[2].match(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/) || [])[1] || ''
      const val = type === 's' ? (shared[parseInt(v, 10)] ?? '') : inline || v
      if (val.trim()) cells.push(val.replace(/<[^>]*>/g, ''))
    }
    if (cells.length) rows.push(cells.join(' | '))
  }
  return rows.length ? rows.join('\n') : '(无可提取文本)'
}

/** pdf：pdfjs 逐页取文本。best-effort。 */
export async function parsePdf(buf: Buffer): Promise<string> {
  const pdf = (await import('pdfjs-dist')) as typeof import('pdfjs-dist')
  const doc = await pdf.getDocument({ data: new Uint8Array(buf) }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push(
      (tc.items as { str?: string }[])
        .map((it) => it.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' '),
    )
  }
  return pages.length ? pages.join('\n\n') : '(无可提取文本)'
}

export const officeRead: Command = {
  id: 'office_read',
  title: '读取文档',
  aliases: ['read_doc', '文档', 'office'],
  kind: 'quick',
  agentTool: true,
  planSafe: true, // 只读
  enabled: true,
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async (input, ctx) => {
    const target = queryText(input)
    if (!target) return { type: 'text', text: '用法: office_read <路径>' }
    const p = checkInside(ctx.config.fileRoots, target)
    if (!p) return { type: 'text', text: `拒绝：路径不在 file_roots 内（${ctx.config.fileRoots.join(', ') || '未配置'}）` }
    const ext = extOf(p)
    try {
      const buf = readFileSync(p)
      let text: string
      if (TEXT_EXTS.has(ext)) text = buf.toString('utf-8')
      else if (ext === 'docx') text = await parseDocx(buf)
      else if (ext === 'xlsx') text = await parseXlsx(buf)
      else if (ext === 'pdf') text = await parsePdf(buf)
      else return { type: 'text', text: `不支持的格式: ${ext || '(无扩展名)'}` }
      return { type: 'text', text: clip(text || '(空文档)') }
    } catch (e) {
      return { type: 'text', text: `读取失败: ${(e as Error).message}` }
    }
  },
}
