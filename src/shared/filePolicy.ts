// file_roots 路径强校验（纯函数）。词法 containment：resolve 后必须仍落在某根内。
import { resolve, sep, isAbsolute } from 'node:path'

/** 把 target 解析到 base 内；越界（含 ../ 穿越、symlink 逃逸等超出词法判断）返回 null。 */
export function resolveInside(root: string, target: string): string | null {
  const base = resolve(root)
  const p = isAbsolute(target) ? resolve(target) : resolve(base, target)
  if (p === base) return p
  if (p.startsWith(base + sep)) return p
  return null
}

/** 逐个根尝试；返回命中的绝对路径，否则 null。 */
export function checkInside(roots: string[], target: string): string | null {
  for (const r of roots) {
    if (!r) continue
    const p = resolveInside(r, target)
    if (p) return p
  }
  return null
}

export type WriteOp = 'create' | 'overwrite' | 'append' | 'delete'

/** 两段 confirm 判定：never 全放行；always 全确认；auto 仅破坏性（删除 / 覆盖已存在）。 */
export function needConfirm(mode: 'auto' | 'always' | 'never', op: WriteOp, exists: boolean): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  return op === 'delete' || (op === 'overwrite' && exists)
}
