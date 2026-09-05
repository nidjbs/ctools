// file 只读工具：file_roots 强校验 / 读取 / 列目录。specs/file-tools.md。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileRead, fileList, fileWrite, fileRm } from '../commands/file'
import { checkInside, resolveInside, needConfirm } from '../src/shared/filePolicy'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx } from '../src/shared/types'

let root: string
let other: string
let ctx: Ctx
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctools-files-'))
  other = mkdtempSync(join(tmpdir(), 'ctools-files-other-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'hello')
  ctx = {
    config: { fileRoots: [root], writeConfirm: 'auto', hotkey: 'x', enabledCommands: {} } as AppConfig,
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_req, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

describe('filePolicy 词法 containment', () => {
  it('根内绝对路径与相对路径通过', () => {
    expect(resolveInside(root, join(root, 'a.txt'))).toBe(join(root, 'a.txt'))
    expect(resolveInside(root, 'sub')).toBe(join(root, 'sub'))
    expect(checkInside([root], 'a.txt')).toBe(join(root, 'a.txt'))
  })

  it('../ 穿越与根外绝对路径拒绝', () => {
    expect(resolveInside(root, join(root, '..', 'x'))).toBeNull()
    expect(checkInside([root], join(other, 'a.txt'))).toBeNull()
    expect(checkInside([], '/etc/hosts')).toBeNull() // 无根配置 → 全拒
  })
})

describe('file_read', () => {
  it('根内绝对路径读取成功', async () => {
    const r = (await fileRead.run({ path: join(root, 'a.txt') }, ctx)) as { type: 'text'; text: string }
    expect(r.text).toBe('hello')
  })

  it('相对路径读取成功', async () => {
    const r = (await fileRead.run('a.txt', ctx)) as { type: 'text'; text: string }
    expect(r.text).toBe('hello')
  })

  it('根外绝对路径拒绝', async () => {
    const r = (await fileRead.run(join(other, 'x'), ctx)) as { type: 'text'; text: string }
    expect(r.text).toContain('拒绝')
  })

  it('穿越路径拒绝', async () => {
    const r = (await fileRead.run('../ctools-files-other-2', ctx)) as { type: 'text'; text: string }
    expect(r.text).toContain('拒绝')
  })

  it('不存在文件 → 读取失败', async () => {
    const r = (await fileRead.run('nope.txt', ctx)) as { type: 'text'; text: string }
    expect(r.text).toContain('读取失败')
  })

  it('空参数给用法提示', async () => {
    const r = (await fileRead.run('', ctx)) as { type: 'text'; text: string }
    expect(r.text).toContain('用法')
  })
})

describe('file_list', () => {
  it('列出根内条目并给出完整 copy 路径', async () => {
    const r = await fileList.run('.', ctx)
    expect(r.type).toBe('list')
    const items = (r as { items: { title: string; copy: string }[] }).items
    expect(items.some((i) => i.title.includes('a.txt'))).toBe(true)
    expect(items.find((i) => i.title.includes('a.txt'))?.copy).toBe(join(root, 'a.txt'))
  })

  it('根外目录拒绝', async () => {
    const r = await fileList.run(other, ctx)
    expect(r.type).toBe('text')
    expect((r as { text: string }).text).toContain('拒绝')
  })
})

describe('needConfirm 策略', () => {
  it('auto：仅 delete / 覆盖已存在需要确认', () => {
    expect(needConfirm('auto', 'delete', true)).toBe(true)
    expect(needConfirm('auto', 'overwrite', true)).toBe(true)
    expect(needConfirm('auto', 'overwrite', false)).toBe(false)
    expect(needConfirm('auto', 'create', false)).toBe(false)
    expect(needConfirm('auto', 'append', true)).toBe(false)
  })
  it('always 全确认；never 全放行', () => {
    expect(needConfirm('always', 'create', false)).toBe(true)
    expect(needConfirm('never', 'delete', true)).toBe(false)
  })
})

describe('file_write / file_rm（两段 confirm）', () => {
  it('新建文件 auto 无需确认直接写', async () => {
    const r = await fileWrite.run(`new.txt hello`, ctx)
    expect(r).toMatchObject({ type: 'text', text: expect.stringContaining('已写入') })
  })

  it('覆盖已存在 auto → 先 confirm；approved 后执行', async () => {
    writeFileSync(join(root, 'keep.txt'), 'v1')
    const g = await fileWrite.run('keep.txt v2', ctx)
    expect(g).toMatchObject({ type: 'confirm', message: expect.stringContaining('覆盖') })
    // 普通 ctx 不会真执行（内容仍是 v1）
    expect(readFileSync(join(root, 'keep.txt'), 'utf-8')).toBe('v1')
    const ok = await fileWrite.run('keep.txt v2', { ...ctx, confirmApproved: true })
    expect(ok).toMatchObject({ type: 'text', text: expect.stringContaining('已覆盖') })
    expect(readFileSync(join(root, 'keep.txt'), 'utf-8')).toBe('v2')
  })

  it('rm auto 需确认；approved 后删除', async () => {
    writeFileSync(join(root, 'del.txt'), 'x')
    const g = await fileRm.run('del.txt', ctx)
    expect(g).toMatchObject({ type: 'confirm', message: expect.stringContaining('删除') })
    const ok = await fileRm.run('del.txt', { ...ctx, confirmApproved: true })
    expect(ok).toMatchObject({ type: 'text', text: expect.stringContaining('已删除') })
  })

  it('never 模式 rm 直接删（策略放行）', async () => {
    writeFileSync(join(root, 'n.txt'), 'x')
    const neverCtx = { ...ctx, config: { ...ctx.config, writeConfirm: 'never' as const } }
    const r = await fileRm.run('n.txt', neverCtx)
    expect(r).toMatchObject({ type: 'text', text: expect.stringContaining('已删除') })
  })

  it('根外/不存在：拒绝与报错', async () => {
    const out = await fileRm.run(join(other, 'x'), ctx)
    expect((out as { text: string }).text).toContain('拒绝')
    const missing = await fileRm.run('ghost.txt', ctx)
    expect((missing as { text: string }).text).toContain('文件不存在')
    const wOut = await fileWrite.run(`${join(other, 'y')} hi`, ctx)
    expect((wOut as { text: string }).text).toContain('拒绝')
  })
})

describe('agent 白名单（file 全套可调；破坏性操作被 confirm 闸门拦 agent）', () => {
  it('toolIds 含 read/list/write/rm 全部', () => {
    const r = new Registry().registerAll([fileRead, fileList, fileWrite, fileRm])
    const ids = r.toolIds()
    for (const id of ['file_read', 'file_list', 'file_write', 'file_rm']) {
      expect(ids).toContain(id)
    }
  })

  it('agent 发起破坏性写/删（普通 ctx）不落盘：只返回 confirm', async () => {
    writeFileSync(join(root, 'keep2.txt'), 'v1')
    const g = await fileWrite.run('keep2.txt v2', ctx) // 覆盖已存在
    expect(g).toMatchObject({ type: 'confirm' })
    expect(readFileSync(join(root, 'keep2.txt'), 'utf-8')).toBe('v1')
    const r = await fileRm.run('keep2.txt', ctx)
    expect(r).toMatchObject({ type: 'confirm' })
    expect(existsSync(join(root, 'keep2.txt'))).toBe(true)
  })
})
