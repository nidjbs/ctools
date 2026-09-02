// macOS 系统集成：剪贴板、Spotlight 检索。命令都经 exec 调用，可注入/单测。
import { execFile } from 'node:child_process'

export interface System {
  pbcopy(text: string): Promise<boolean>
  mdfind(query: string, roots: string[]): Promise<string[]>
}

export class MacSystem implements System {
  /** 把 text 写回系统剪贴板（供用户直接粘贴）。 */
  pbcopy(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = execFile('pbcopy', (err) => resolve(!err))
      child.stdin?.end(text)
    })
  }

  /** 用 Spotlight 在指定根目录内搜文件名 + 内容，返回路径（最多 limit 条）。 */
  async mdfind(query: string, roots: string[]): Promise<string[]> {
    if (!query.trim() || roots.length === 0) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const root of roots) {
      for (const p of await this.mdfindInRoot(query, root)) {
        if (!seen.has(p)) {
          seen.add(p)
          out.push(p)
        }
      }
    }
    return out
  }

  private mdfindInRoot(query: string, root: string): Promise<string[]> {
    return new Promise((resolve) => {
      execFile(
        'mdfind',
        ['-onlyin', root, query],
        { maxBuffer: 1 << 20 },
        (_err, stdout) => {
          resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
        },
      )
    })
  }
}
