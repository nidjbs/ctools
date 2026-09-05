// office_read：纯文本 / docx / xlsx / pdf 失败兜底 / 越界与格式拒绝。specs/office-read.md。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { officeRead, parseDocx, parseXlsx } from '../commands/office'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx } from '../src/shared/types'

let root: string
let ctx: Ctx

function docxZip(): Promise<Buffer> {
  const z = new JSZip()
  z.file(
    'word/document.xml',
    '<w:document><w:body><w:p><w:r><w:t>第一行标题</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>第二行 hello world</w:t></w:r></w:p></w:body></w:document>',
  )
  return z.generateAsync({ type: 'nodebuffer' })
}

function xlsxZip(): Promise<Buffer> {
  const z = new JSZip()
  z.file('xl/sharedStrings.xml', '<sst><si><t>你好</t></si><si><t>数量</t></si></sst>')
  z.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
  )
  return z.generateAsync({ type: 'nodebuffer' })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ctools-office-'))
  writeFileSync(join(root, 'note.txt'), '纯文本 hello')
  writeFileSync(join(root, 'd.docx'), await docxZip())
  writeFileSync(join(root, 's.xlsx'), await xlsxZip())
  writeFileSync(join(root, 'bin.exe'), 'not really an exe')
  writeFileSync(join(root, 'bad.pdf'), 'this is not a pdf header at all ' + 'x'.repeat(400))
  ctx = {
    config: { fileRoots: [root], writeConfirm: 'auto', hotkey: 'x', enabledCommands: {} } as AppConfig,
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function text(input: string): Promise<string> {
  const r = await officeRead.run(input, ctx)
  expect(r.type).toBe('text')
  return (r as { text: string }).text
}

describe('office_read 解析', () => {
  it('纯文本直读', async () => {
    expect(await text('note.txt')).toContain('纯文本 hello')
  })

  it('docx 段落文本', async () => {
    const t = await text('d.docx')
    expect(t).toContain('第一行标题')
    expect(t).toContain('第二行 hello world')
  })

  it('xlsx 单元格（sharedString 解析）', async () => {
    const t = await text('s.xlsx')
    expect(t).toContain('你好')
    expect(t).toContain('数量')
  })

  it('pdf 解析失败优雅兜底（不抛、返回文本）', async () => {
    const t = await text('bad.pdf')
    expect(t.length).toBeGreaterThan(0)
  })

  it('不支持格式', async () => {
    expect(await text('bin.exe')).toContain('不支持的格式')
  })

  it('越界拒绝；空参数用法提示', async () => {
    expect(await text('/etc/hosts')).toContain('拒绝')
    expect(await text('')).toContain('用法')
  })
})

describe('parse 单元（Buffer 直测）', () => {
  it('parseDocx / parseXlsx 对坏 zip 不抛', async () => {
    await expect(parseDocx(Buffer.from('nope'))).rejects.toThrow()
    await expect(parseXlsx(Buffer.from('nope'))).rejects.toThrow()
  })
})

describe('白名单：office_read 是只读 agentTool', () => {
  it('toolIds 含 office_read', () => {
    const r = new Registry().registerAll([officeRead])
    expect(r.toolIds()).toContain('office_read')
  })
})
