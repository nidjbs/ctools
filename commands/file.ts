// file 工具：read / list / write / rm 全套 agentTool；破坏性写/删由 confirm 闸门拦 agent（specs/file-tools.md）。
// Launcher 传字符串（write/rm 时首 token 为路径），agent 传 { path }（read/list）或 { path, content }（write）。
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command, Ctx } from '../src/shared/types'
import { needConfirm } from '../src/shared/filePolicy'
import { realInside } from '../src/main/pathGuard'

const MAX_READ = 256 * 1024
const MAX_LINES = 2000 // file_read 行区间上限
const MAX_EDIT_BYTES = 1024 * 1024 // file_edit 仅支持 ≤1MB（避免整份读入）

const PATH_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
}

const READ_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'number', description: '起始行（1-based，可选）' },
    limit: { type: 'number', description: `读取行数（可选，上限 ${MAX_LINES}）` },
  },
  required: ['path'],
}

/** 对象入参取数（Launcher 传字符串时返回空对象）。 */
function objOf(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

/** 取可选数字参数；非有限数返回 undefined。 */
function numOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** 行数（末尾换行不计）。 */
export function countLines(text: string): number {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines.length
}

/** 按行切片并加行号（`  12| 内容`）；offset 为 1-based。 */
export function sliceLines(text: string, offset: number, limit?: number): string {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop() // 末尾换行不算多一行
  const total = lines.length
  const start = Math.max(1, Math.floor(offset))
  if (start > total) return `(超出文件范围，共 ${total} 行)`
  const count = Math.min(limit === undefined ? total - start + 1 : Math.floor(limit), MAX_LINES)
  if (count <= 0) return `(超出文件范围，共 ${total} 行)`
  const width = String(total).length
  return lines
    .slice(start - 1, start - 1 + count)
    .map((l, i) => `${String(start + i).padStart(width)}| ${l}`)
    .join('\n')
}

/** 统一取路径参数。 */
function pathOf(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  if (input && typeof input === 'object' && 'path' in input) {
    return String((input as { path: unknown }).path ?? '').trim()
  }
  return ''
}

function denied(roots: string[]): { type: 'text'; text: string } {
  return { type: 'text', text: `拒绝：路径不在 file_roots 内（${roots.join(', ') || '未配置'}）` }
}

/** 读白名单 = file_roots ∪ spill 目录（大结果外置后可回取）；**写仍限 file_roots**。 */
function readRoots(ctx: Ctx): string[] {
  const roots = ctx.config.fileRoots.filter(Boolean)
  return ctx.spillDir ? [...roots, ctx.spillDir] : roots
}

/** 写/删是否需要确认：policy 判定且当前调用未获放行 → 返回 confirm 结果。 */
function gateConfirm(ctx: Ctx, op: 'create' | 'overwrite' | 'append' | 'delete', p: string, exists: boolean) {
  const want = needConfirm(ctx.config.writeConfirm, op, exists)
  if (!want || ctx.confirmApproved) return null
  const verb = op === 'delete' ? '删除' : op === 'overwrite' ? '覆盖' : '写入'
  return { type: 'confirm' as const, message: `确认${verb} ${p}？` }
}

export const fileRead: Command = {
  id: 'file_read',
  title: '读取文件',
  description: '读取文件内容。大文件先用 grep 定位，再用 offset/limit 只读相关行区间。',
  aliases: ['read', '读取', '读文件', 'cat'],
  kind: 'quick',
  agentTool: true,
  planSafe: true, // 只读，可入 plan 规划工具集
  enabled: true,
  schema: READ_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input)
    if (!target) return { type: 'text', text: '用法: file_read <绝对路径 或 file_roots 下相对路径>' }
    const o = objOf(input)
    const offset = numOf(o.offset)
    const limit = numOf(o.limit)
    const p = await realInside(readRoots(ctx), target)
    if (!p) return denied(ctx.config.fileRoots)
    try {
      const text = readFileSync(p, 'utf-8')
      if (offset !== undefined || limit !== undefined) {
        return { type: 'text', text: sliceLines(text, offset ?? 1, limit) }
      }
      const clipped =
        text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…[截断，全文 ${text.length} 字符]` : text
      return { type: 'text', text: clipped || '(空文件)' }
    } catch (e) {
      return { type: 'text', text: `读取失败: ${(e as Error).message}` }
    }
  },
}

export const fileList: Command = {
  id: 'file_list',
  title: '列目录',
  description: '列出目录下的文件。想知道有哪些文件用它；要知道文件里写了什么用 grep/file_read。',
  aliases: ['ls', 'dir', '列出'],
  kind: 'quick',
  agentTool: true,
  planSafe: true, // 只读
  enabled: true,
  schema: PATH_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input) || '.'
    const p = await realInside(readRoots(ctx), target)
    if (!p) return denied(ctx.config.fileRoots)
    try {
      const items = readdirSync(p, { withFileTypes: true })
      if (items.length === 0) return { type: 'text', text: '(空目录)' }
      return {
        type: 'list',
        items: items.slice(0, 50).map((d) => ({
          title: `${d.isDirectory() ? '📁' : '📄'} ${d.name}`,
          copy: join(p, d.name),
          path: join(p, d.name),
        })),
      }
    } catch (e) {
      return { type: 'text', text: `读取失败: ${(e as Error).message}` }
    }
  },
}

/** file_write：首 token 为路径，其余为内容；或 { path, content }。覆盖已存在需 confirm（auto）。 */
export const fileWrite: Command = {
  id: 'file_write',
  title: '写入文件',
  description: '整份写入或覆盖文件。只改一小段请用 file_edit（更省 token、更不容易丢内容）。',
  aliases: ['write', '写', '写入'],
  kind: 'quick',
  agentTool: true, // 破坏性写（覆盖/删除）仍被 confirm 闸门拦 agent
  enabled: true,
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path'],
  },
  run: async (input, ctx) => {
    let target = ''
    let content = ''
    if (typeof input === 'string') {
      const t = input.trim()
      const sp = t.indexOf(' ')
      target = (sp >= 0 ? t.slice(0, sp) : t).trim()
      content = sp >= 0 ? t.slice(sp + 1) : ''
    } else if (input && typeof input === 'object') {
      const o = input as { path?: unknown; content?: unknown }
      target = String(o.path ?? '').trim()
      content = String(o.content ?? '')
    }
    if (!target) return { type: 'text', text: '用法: file_write <路径> <内容>' }
    const p = await realInside(ctx.config.fileRoots, target)
    if (!p) return denied(ctx.config.fileRoots)
    const exists = existsSync(p)
    const gated = gateConfirm(ctx, exists ? 'overwrite' : 'create', p, exists)
    if (gated) return gated
    try {
      writeFileSync(p, content, 'utf-8')
      return { type: 'text', text: `${exists ? '已覆盖' : '已写入'} ${p}` }
    } catch (e) {
      return { type: 'text', text: `写入失败: ${(e as Error).message}` }
    }
  },
}

/** file_edit：精确片段替换（唯一匹配才改）。改一行不必重写整份文件。specs/file-edit.md。 */
export const fileEdit: Command = {
  id: 'file_edit',
  title: '编辑文件',
  description: '改文件里的某段文字（精确匹配、默认要求唯一）。改文件优先用它，不要整份重写。',
  aliases: ['edit', 'replace', '改', '编辑'],
  kind: 'quick',
  agentTool: true, // 写操作：走 confirm 闸门
  enabled: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要被替换的原文（精确匹配，含空白与换行）' },
      new_string: { type: 'string', description: '替换成什么；空串表示删除该片段' },
      replace_all: { type: 'boolean', description: '默认 false：要求 old_string 在文件中唯一' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  run: async (input, ctx) => {
    const o = objOf(input)
    const target = pathOf(input)
    const oldStr = typeof o.old_string === 'string' ? o.old_string : ''
    const newStr = typeof o.new_string === 'string' ? o.new_string : ''
    const replaceAll = o.replace_all === true
    if (!target) return { type: 'text', text: '用法: file_edit <路径>（需 old_string / new_string）' }
    if (!oldStr) return { type: 'text', text: 'old_string 不能为空' }
    if (oldStr === newStr) return { type: 'text', text: 'old_string 与 new_string 相同，无需修改' }
    const p = await realInside(ctx.config.fileRoots, target) // 写：只走 file_roots
    if (!p) return denied(ctx.config.fileRoots)
    if (!existsSync(p)) return { type: 'text', text: `文件不存在: ${p}（新建请用 file_write）` }
    try {
      const stat = statSync(p)
      if (stat.isDirectory()) return { type: 'text', text: `读取失败: ${p} 是目录` }
      if (stat.size > MAX_EDIT_BYTES) {
        return { type: 'text', text: `文件过大（${stat.size} 字节），file_edit 仅支持 ≤1MB` }
      }
      const text = readFileSync(p, 'utf-8')
      const count = text.split(oldStr).length - 1
      if (count === 0) {
        return { type: 'text', text: `未找到该片段；请先用 file_read 确认原文（文件共 ${countLines(text)} 行）` }
      }
      if (count > 1 && !replaceAll) {
        return { type: 'text', text: `匹配到 ${count} 处；请给出更长、唯一的上下文，或设置 replace_all` }
      }
      // 先校验再请批：避免为无效改动打扰用户
      const gated = gateConfirm(ctx, 'overwrite', p, true)
      if (gated) return gated
      const next = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr)
      writeFileSync(p, next, 'utf-8')
      const at = text.slice(0, text.indexOf(oldStr)).split('\n').length
      return { type: 'text', text: `已修改 ${p}（替换 ${count} 处，首次在第 ${at} 行）` }
    } catch (e) {
      return { type: 'text', text: `编辑失败: ${(e as Error).message}` }
    }
  },
}

/** file_rm：删除文件/目录（auto 下总是确认）。 */
export const fileRm: Command = {
  id: 'file_rm',
  title: '删除文件',
  description: '删除文件或目录（恒需用户批准，不可逆）。',
  aliases: ['rm', 'del', '删除'],
  kind: 'quick',
  agentTool: true, // 删除恒需 confirm，agent 无 confirmApproved → 只能返回确认提示
  enabled: true,
  schema: PATH_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input)
    if (!target) return { type: 'text', text: '用法: file_rm <路径>' }
    const p = await realInside(ctx.config.fileRoots, target)
    if (!p) return denied(ctx.config.fileRoots)
    if (!existsSync(p)) return { type: 'text', text: `文件不存在: ${p}` }
    const gated = gateConfirm(ctx, 'delete', p, true)
    if (gated) return gated
    try {
      rmSync(p, { recursive: true, force: true })
      return { type: 'text', text: `已删除 ${p}` }
    } catch (e) {
      return { type: 'text', text: `删除失败: ${(e as Error).message}` }
    }
  },
}
