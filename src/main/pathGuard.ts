// realpath 级路径守卫：词法 containment 挡 ../ 穿越，realpath 挡 symlink 目录逃逸。
// 供所有真正触碰磁盘的入口用（file 读写删、system open/reveal）。词法纯函数见 shared/filePolicy。
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** 目标可不存在（写入/删除前）：向上锚定到最深已存在祖先的 realpath。 */
async function anchorOf(abs: string): Promise<string> {
  let p = abs
  for (;;) {
    const r = await real(p)
    if (r) return r
    const d = dirname(p)
    if (d === p) return abs // 到根都不存在，兜底返回原路径（词法已在根内）
    p = d
  }
}

/**
 * symlink-safe containment：目标词法上落在某 file_root 内，且其真实路径锚点也落在该根的
 * realpath 内（中间任何 symlink 目录把路径带出根 → 拒绝）。目标自身若已存在，也须解析回根内。
 * 通过返回目标绝对路径（词法路径），否则 null。
 */
export async function realInside(roots: string[], target: string): Promise<string | null> {
  for (const root of roots) {
    if (!root) continue
    const base = resolve(root)
    const abs = isAbsolute(target) ? resolve(target) : resolve(base, target)
    if (abs !== base && !abs.startsWith(base + sep)) continue // 词法越界 → 试下一根
    const baseR = await real(base)
    if (!baseR) continue
    const anchor = await anchorOf(abs)
    if (anchor !== baseR && !anchor.startsWith(baseR + sep)) continue // 祖先锚点逃逸（symlink 目录）
    const self = await real(abs) // 目标自身存在但指向根外（读/写经 symlink 逃逸）→ 拒绝
    if (self && self !== baseR && !self.startsWith(baseR + sep)) continue
    return abs
  }
  return null
}
