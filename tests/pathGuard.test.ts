// realInside（src/main/pathGuard）：realpath 级 containment。用真实 tmp 目录 + symlink 造逃逸场景。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { realInside } from '../src/main/pathGuard'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ctools-guard-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('realInside symlink-safe containment', () => {
  it('根内存在的文件放行（返回绝对词法路径）', async () => {
    const root = tmp()
    writeFileSync(join(root, 'a.txt'), 'hi')
    const p = await realInside([root], 'a.txt')
    expect(p).toBe(resolve(root, 'a.txt'))
  })

  it('词法穿越（../）拒绝', async () => {
    const root = tmp()
    expect(await realInside([root], '../etc/passwd')).toBeNull()
    expect(await realInside([root], join(root, '..'))).toBeNull()
  })

  it('根下不存在的深层目标放行（写入前置检查，锚定到已存在祖先）', async () => {
    const root = tmp()
    mkdirSync(join(root, 'safe'))
    const p = await realInside([root], 'safe/new.md')
    expect(p).toBe(resolve(root, 'safe/new.md'))
  })

  it('symlink 目录把路径带出根 → 拒绝（目标不存在写入场景）', async () => {
    const root = tmp()
    const outside = mkdtempSync(join(tmpdir(), 'ctools-outside-'))
    dirs.push(outside)
    symlinkSync(outside, join(root, 'link'))
    expect(await realInside([root], 'link/evil.txt')).toBeNull() // write 到 link 下新文件
  })

  it('目标自身是指向根外的 symlink → 拒绝（读/写逃逸）', async () => {
    const root = tmp()
    const outside = mkdtempSync(join(tmpdir(), 'ctools-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 's')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'out.txt'))
    expect(await realInside([root], 'out.txt')).toBeNull()
  })

  it('根内 symlink 指向根内目录 → 放行', async () => {
    const root = tmp()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    writeFileSync(join(root, 'real', 'x.txt'), 'x')
    expect(await realInside([root], 'alias/x.txt')).toBe(resolve(root, 'alias/x.txt'))
  })

  it('目标为根本身 → 放行', async () => {
    const root = tmp()
    expect(await realInside([root], root)).toBe(resolve(root))
  })

  it('空根列表 → 拒绝', async () => {
    expect(await realInside([], 'a.txt')).toBeNull()
  })
})
