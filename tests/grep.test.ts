// grep（specs/grep.md）：内容搜索、跳过规则、上限、只读性。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grepCmd } from '../commands/grep'
import { defaultConfig } from '../src/main/config'
import type { CommandResult, Ctx } from '../src/shared/types'

let root: string
let ctx: Ctx

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctools-grep-'))
  ctx = {
    config: { ...defaultConfig(), fileRoots: [root] },
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (args: Record<string, unknown>, c: Ctx = ctx): Promise<CommandResult> => grepCmd.run(args, c)
const items = (r: CommandResult) => (r.type === 'list' ? r.items : [])

function seed() {
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1\nfind me here\nconst y = 2\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'nothing\n')
  writeFileSync(join(root, 'node_modules', 'dep.ts'), 'find me here\n')
  writeFileSync(join(root, '.git', 'cfg'), 'find me here\n')
  writeFileSync(join(root, 'README.md'), 'find me here\n')
}

describe('基本搜索', () => {
  it('命中返回 路径:行号 + 行内容 + path（供 Finder/打开）', async () => {
    seed()
    const r = await run({ pattern: 'find me here' })
    const its = items(r)
    expect(its.length).toBeGreaterThan(0)
    const hit = its.find((i) => i.title.includes('a.ts'))!
    expect(hit.title).toContain(':2') // 第 2 行
    expect(hit.subtitle).toBe('find me here')
    expect(hit.copy).toContain('find me here')
    expect(hit.path).toBe(join(root, 'src', 'a.ts'))
  })

  it('结果按路径、行号稳定排序', async () => {
    seed()
    const its = items(await run({ pattern: 'find me here' }))
    const keys = its.map((i) => i.title)
    expect([...keys].sort()).toEqual(keys)
  })

  it('无命中 → text 并报告扫描文件数', async () => {
    seed()
    const r = await run({ pattern: '绝不存在xyz' })
    expect(r.type).toBe('text')
    expect((r as { text: string }).text).toContain('未找到匹配')
    expect((r as { text: string }).text).toContain('已扫描')
  })

  it('空模式 → 用法提示', async () => {
    const r = await run({ pattern: '   ' })
    expect((r as { text: string }).text).toContain('用法')
  })
})

describe('跳过规则', () => {
  it('跳过 node_modules / .git（不返回其中的命中）', async () => {
    seed()
    const its = items(await run({ pattern: 'find me here' }))
    expect(its.some((i) => i.title.includes('node_modules'))).toBe(false)
    expect(its.some((i) => i.title.includes('.git'))).toBe(false)
    expect(its.some((i) => i.title.includes('README.md'))).toBe(true) // 普通文件仍在
  })

  it('glob 过滤文件名', async () => {
    seed()
    const its = items(await run({ pattern: 'find me here', glob: '*.md' }))
    expect(its.length).toBeGreaterThan(0)
    expect(its.every((i) => i.path?.endsWith('.md'))).toBe(true)
    expect(its.some((i) => i.path?.endsWith('a.ts'))).toBe(false)
  })

  it('跳过二进制文件（含 NUL）', async () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from('find me here\0\x01\x02'))
    const its = items(await run({ pattern: 'find me here' }))
    expect(its.some((i) => i.title.includes('bin.dat'))).toBe(false)
  })
})

describe('模式语义与上限', () => {
  it('正则生效', async () => {
    writeFileSync(join(root, 'a.txt'), 'abc123\nxyz\n')
    const its = items(await run({ pattern: '^abc\\d+$' }))
    expect(its).toHaveLength(1)
    expect(its[0].title).toContain(':1')
  })

  it('非法正则退化为字面量匹配', async () => {
    writeFileSync(join(root, 'a.txt'), 'a(b\nplain\n')
    const its = items(await run({ pattern: 'a(b' }))
    expect(its).toHaveLength(1)
    expect(its[0].subtitle).toBe('a(b')
  })

  it('ignoreCase', async () => {
    writeFileSync(join(root, 'a.txt'), 'Hello World\n')
    expect(items(await run({ pattern: 'hello' }))).toHaveLength(0)
    expect(items(await run({ pattern: 'hello', ignoreCase: true }))).toHaveLength(1)
  })

  it('maxResults 限制条数', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 50 }, () => 'hit').join('\n'))
    expect(items(await run({ pattern: 'hit', maxResults: 5 }))).toHaveLength(5)
  })

  it('maxResults 超硬上限被截到 500', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 600 }, () => 'hit').join('\n'))
    expect(items(await run({ pattern: 'hit', maxResults: 9999 })).length).toBe(500)
  })
})

describe('范围与权限', () => {
  it('path 限定子目录', async () => {
    seed()
    writeFileSync(join(root, 'top.txt'), 'find me here\n')
    const its = items(await run({ pattern: 'find me here', path: join(root, 'src') }))
    expect(its.every((i) => i.title.includes('/src/'))).toBe(true)
  })

  it('越界 path 拒绝', async () => {
    const r = await run({ pattern: 'x', path: '/etc' })
    expect((r as { text: string }).text).toContain('拒绝')
  })

  it('spill 目录可被搜索（读白名单含 spill）', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'ctools-grep-spill-'))
    try {
      writeFileSync(join(spill, 'spilled.txt'), 'unique-mark-zzz\n')
      const withSpill: Ctx = { ...ctx, spillDir: spill }
      const its = items(await run({ pattern: 'unique-mark-zzz' }, withSpill))
      expect(its).toHaveLength(1)
      expect(its[0].title).toContain('spilled.txt')
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })

  it('file_roots 为空 → 无命中（不抛）', async () => {
    const empty: Ctx = { ...ctx, config: { ...ctx.config, fileRoots: [] } }
    const r = await run({ pattern: 'x' }, empty)
    expect(r.type).toBe('text')
  })
})

describe('工具属性', () => {
  it('只读：可入 plan 工具集，且是 agentTool', () => {
    expect(grepCmd.planSafe).toBe(true)
    expect(grepCmd.agentTool).toBe(true)
    expect(grepCmd.description).toBeTruthy()
  })
})
