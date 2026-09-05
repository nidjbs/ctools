// file 工具：read / list / write / rm 全套 agentTool；破坏性写/删由 confirm 闸门拦 agent（specs/file-tools.md）。
// Launcher 传字符串（write/rm 时首 token 为路径），agent 传 { path }（read/list）或 { path, content }（write）。
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Command, Ctx } from '../src/shared/types'
import { checkInside, needConfirm } from '../src/shared/filePolicy'

const MAX_READ = 256 * 1024

const PATH_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
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
  aliases: ['read', '读取', '读文件', 'cat'],
  kind: 'quick',
  agentTool: true,
  enabled: true,
  schema: PATH_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input)
    if (!target) return { type: 'text', text: '用法: file_read <绝对路径 或 file_roots 下相对路径>' }
    const p = checkInside(ctx.config.fileRoots, target)
    if (!p) return denied(ctx.config.fileRoots)
    try {
      const text = readFileSync(p, 'utf-8')
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
  aliases: ['ls', 'dir', '列出'],
  kind: 'quick',
  agentTool: true,
  enabled: true,
  schema: PATH_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input) || '.'
    const p = checkInside(ctx.config.fileRoots, target)
    if (!p) return denied(ctx.config.fileRoots)
    try {
      const items = readdirSync(p, { withFileTypes: true })
      if (items.length === 0) return { type: 'text', text: '(空目录)' }
      return {
        type: 'list',
        items: items.slice(0, 50).map((d) => ({
          title: `${d.isDirectory() ? '📁' : '📄'} ${d.name}`,
          copy: join(p, d.name),
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
    const p = checkInside(ctx.config.fileRoots, target)
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

/** file_rm：删除文件/目录（auto 下总是确认）。 */
export const fileRm: Command = {
  id: 'file_rm',
  title: '删除文件',
  aliases: ['rm', 'del', '删除'],
  kind: 'quick',
  agentTool: true, // 删除恒需 confirm，agent 无 confirmApproved → 只能返回确认提示
  enabled: true,
  schema: PATH_SCHEMA,
  run: async (input, ctx) => {
    const target = pathOf(input)
    if (!target) return { type: 'text', text: '用法: file_rm <路径>' }
    const p = checkInside(ctx.config.fileRoots, target)
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
