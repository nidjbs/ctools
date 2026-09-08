// quick 命令输入解析（Launcher / Chat 共用，保证两窗 Enter 语义一致）。
import type { CommandMeta } from './types'

/** 参数提取：整词命中命令名 → ''（待补参数）；命令名+空格 → 剩余参数；否则原样（候选非该命令时不会发生）。 */
export function commandParam(c: CommandMeta, q: string): string {
  const s = q.trim()
  const lower = s.toLowerCase()
  for (const n of [c.id, ...c.aliases]) {
    const nl = n.toLowerCase()
    if (lower === nl) return ''
    if (lower.startsWith(nl + ' ')) return s.slice(nl.length).trim()
  }
  return s
}

/** 回车一个命令候选的落点：run=false → 参数态（输入仅命令名，待补参数）；run=true → 带参数执行。 */
export function quickEnter(c: CommandMeta, input: string): { run: false } | { run: true; param: string } {
  const param = commandParam(c, input)
  return param ? { run: true, param } : { run: false }
}
