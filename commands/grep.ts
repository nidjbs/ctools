// grep：在文件内容里按模式搜索（自实现遍历，不依赖 Spotlight 索引）。只读 → 可入 plan 工具集。
// specs/grep.md。
import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { Command, Ctx } from '../src/shared/types'
import { realInside } from '../src/main/pathGuard'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '__pycache__'])
const MAX_FILES = 5000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_DEPTH = 20
const BINARY_SNIFF = 8192
const DEFAULT_RESULTS = 100
const MAX_RESULTS_CAP = 500
const LINE_TEXT_MAX = 200

interface Hit {
  file: string
  line: number
  text: string
}

/** glob → 文件名正则（仅支持 * 与 ?）。 */
function globRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * 递归收集候选文件（不跟随符号链接 → 天然避免目录环）。
 * **异步**：同步遍历会阻塞主进程（UI 冻结），这里每个目录/文件的 IO 都让出事件循环。
 */
async function collect(dir: string, glob: string | undefined, out: string[], depth = 0): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 不可读目录跳过
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await collect(join(dir, e.name), glob, out, depth + 1)
    } else if (e.isFile()) {
      if (e.name === '.DS_Store') continue
      if (glob && !globRe(glob).test(e.name)) continue
      out.push(join(dir, e.name))
    }
  }
}

/** 逐行匹配：pattern 先当正则，非法则退化为字面量子串。 */
function matcher(pattern: string, ignoreCase: boolean): (line: string) => boolean {
  try {
    const re = new RegExp(pattern, ignoreCase ? 'i' : '')
    return (line) => re.test(line)
  } catch {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern
    return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle)
  }
}

export const grepCmd: Command = {
  id: 'grep',
  title: '搜索内容',
  description: '按模式搜索文件内容，返回 路径:行号。找内容/定位代码用它；按文件名找用 find_file。',
  aliases: ['grep', '搜索内容', '内容搜索'],
  kind: 'quick',
  agentTool: true,
  planSafe: true, // 只读
  enabled: true,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则；非法正则时按字面量匹配' },
      path: { type: 'string', description: '搜索起点（缺省 = 全部可读根）' },
      glob: { type: 'string', description: '文件名过滤，如 "*.ts"' },
      ignoreCase: { type: 'boolean' },
      maxResults: { type: 'number', description: `默认 ${DEFAULT_RESULTS}，上限 ${MAX_RESULTS_CAP}` },
    },
    required: ['pattern'],
  },
  run: async (input, ctx) => {
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const pattern = String(typeof input === 'string' ? input : (o.pattern ?? '')).trim()
    if (!pattern) return { type: 'text', text: '用法: grep <模式> [路径]' }

    const readRoots = ctx.spillDir ? [...ctx.config.fileRoots.filter(Boolean), ctx.spillDir] : ctx.config.fileRoots.filter(Boolean)
    const start = typeof o.path === 'string' && o.path.trim() ? o.path.trim() : undefined
    const roots = start ? [start] : readRoots
    if (start && !(await realInside(readRoots, start))) {
      return { type: 'text', text: `拒绝：路径不在 file_roots 内（${readRoots.join(', ') || '未配置'}）` }
    }

    const glob = typeof o.glob === 'string' && o.glob.trim() ? o.glob.trim() : undefined
    const ignoreCase = o.ignoreCase === true
    const max = Math.min(
      Math.max(1, Math.floor(Number(o.maxResults) || DEFAULT_RESULTS)),
      MAX_RESULTS_CAP,
    )
    const test = matcher(pattern, ignoreCase)

    const files: string[] = []
    for (const r of roots) await collect(r, glob, files)

    const hits: Hit[] = []
    let scanned = 0
    outer: for (const f of files) {
      scanned++
      let content: string
      try {
        const st = await stat(f)
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
        content = await readFile(f, 'utf-8')
      } catch {
        continue // 不可读/瞬时消失 → 跳过
      }
      if (content.slice(0, BINARY_SNIFF).includes('\0')) continue // 二进制
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!test(lines[i])) continue
        hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, LINE_TEXT_MAX) })
        if (hits.length >= max) break outer
      }
    }

    if (!hits.length) {
      return { type: 'text', text: `未找到匹配 "${pattern}"（已扫描 ${scanned} 个文件）` }
    }
    hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
    return {
      type: 'list',
      items: hits.map((h) => ({
        title: `${h.file}:${h.line}`,
        subtitle: h.text,
        copy: `${h.file}:${h.line}: ${h.text}`,
        path: h.file,
      })),
    }
  },
}

/** 供测试引用的导出（避免重复实现）。 */
export const grepInternals = { collect, matcher, globRe, SKIP_DIRS, basename }
