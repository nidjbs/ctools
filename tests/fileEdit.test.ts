// file_edit（specs/file-edit.md）：精确替换的唯一性语义、闸门与边界。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileEdit } from '../commands/file'
import { defaultConfig } from '../src/main/config'
import type { Ctx } from '../src/shared/types'

let root: string
let ctx: Ctx

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctools-edit-'))
  // 语义用例专注匹配行为：关闭写确认；闸门用例另建 auto ctx
  ctx = {
    config: { ...defaultConfig(), fileRoots: [root], writeConfirm: 'never' },
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const text = (path: string) => readFileSync(join(root, path), 'utf-8')
const run = (args: Record<string, unknown>, c: Ctx = ctx) => fileEdit.run(args, c)
const autoCtx = (): Ctx => ({ ...ctx, config: { ...ctx.config, writeConfirm: 'auto' } })

describe('唯一匹配语义', () => {
  it('恰好一处 → 替换并返回处数与行号', async () => {
    writeFileSync(join(root, 'a.txt'), 'line1\nfoo\nline3\n')
    const r = await run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' })
    expect((r as { text: string }).text).toContain('替换 1 处')
    expect((r as { text: string }).text).toContain('第 2 行')
    expect(text('a.txt')).toBe('line1\nbar\nline3\n')
  })

  it('0 处 → 报错且不写盘（提示先 file_read）', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    const r = await run({ path: 'a.txt', old_string: 'nope', new_string: 'x' })
    expect((r as { text: string }).text).toContain('未找到该片段')
    expect((r as { text: string }).text).toContain('1 行')
    expect(text('a.txt')).toBe('hello\n')
  })

  it('多处且未授权 → 报错且不写盘', async () => {
    writeFileSync(join(root, 'a.txt'), 'x\nx\n')
    const r = await run({ path: 'a.txt', old_string: 'x', new_string: 'y' })
    expect((r as { text: string }).text).toContain('匹配到 2 处')
    expect(text('a.txt')).toBe('x\nx\n')
  })

  it('replace_all → 全部替换', async () => {
    writeFileSync(join(root, 'a.txt'), 'x\nx\nx\n')
    const r = await run({ path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true })
    expect((r as { text: string }).text).toContain('替换 3 处')
    expect(text('a.txt')).toBe('y\ny\ny\n')
  })

  it('多行片段精确匹配（含换行与缩进）', async () => {
    writeFileSync(join(root, 'a.ts'), 'function f() {\n  return 1\n}\n')
    await run({ path: 'a.ts', old_string: '  return 1', new_string: '  return 2' })
    expect(text('a.ts')).toContain('return 2')
    expect(text('a.ts')).toContain('function f()')
  })
})

describe('参数校验', () => {
  it('old_string 为空 → 拒绝', async () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    const r = await run({ path: 'a.txt', old_string: '', new_string: 'y' })
    expect((r as { text: string }).text).toContain('old_string 不能为空')
  })

  it('old === new → 提示无需修改', async () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    const r = await run({ path: 'a.txt', old_string: 'x', new_string: 'x' })
    expect((r as { text: string }).text).toContain('无需修改')
  })

  it('文件不存在 → 提示改用 file_write', async () => {
    const r = await run({ path: 'nope.txt', old_string: 'a', new_string: 'b' })
    expect((r as { text: string }).text).toContain('文件不存在')
    expect((r as { text: string }).text).toContain('file_write')
  })

  it('目标是目录 → 拒绝', async () => {
    mkdirSync(join(root, 'sub'))
    const r = await run({ path: 'sub', old_string: 'a', new_string: 'b' })
    expect((r as { text: string }).text).toContain('是目录')
  })

  it('new_string 为空串 = 删除该片段', async () => {
    writeFileSync(join(root, 'a.txt'), 'keep\nDELETE\n')
    await run({ path: 'a.txt', old_string: 'DELETE\n', new_string: '' })
    expect(text('a.txt')).toBe('keep\n')
  })
})

describe('权限与闸门', () => {
  it('越界路径拒绝', async () => {
    const r = await run({ path: '/etc/hosts', old_string: 'a', new_string: 'b' })
    expect((r as { text: string }).text).toContain('拒绝')
  })

  it('auto 模式下改已存在文件 → 先返回 confirm，不写盘', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo\n')
    const auto = autoCtx()
    const r = await run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, auto)
    expect(r).toMatchObject({ type: 'confirm' })
    expect(text('a.txt')).toBe('foo\n') // 未落盘

    // 批准后放行
    const ok = await run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, { ...auto, confirmApproved: true })
    expect((ok as { text: string }).text).toContain('已修改')
    expect(text('a.txt')).toBe('bar\n')
  })

  it('无效改动（0 处）不触发 confirm —— 不打扰用户', async () => {
    writeFileSync(join(root, 'a.txt'), 'foo\n')
    const r = await run({ path: 'a.txt', old_string: 'nope', new_string: 'x' }, autoCtx())
    expect(r).toMatchObject({ type: 'text' })
  })

  it('多处匹配（无效改动）在 auto 下也不触发 confirm', async () => {
    writeFileSync(join(root, 'a.txt'), 'x\nx\n')
    const r = await run({ path: 'a.txt', old_string: 'x', new_string: 'y' }, autoCtx())
    expect(r).toMatchObject({ type: 'text' })
    expect((r as { text: string }).text).toContain('匹配到 2 处')
  })
})
