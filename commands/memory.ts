// 长期记忆三工具（specs/memory.md）：remember / forget 有副作用；recall 只读（可入 plan 工具集）。
// Launcher 传字符串；agent 传 { text | id | query }。
import type { Command, Ctx } from '../src/shared/types'
import type { MemoryKind } from '../src/main/memory'

function need(ctx: Ctx) {
  if (!ctx.memory) throw new Error('记忆未启用')
  return ctx.memory
}

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

const KIND_ENUM = ['fact', 'preference', 'procedure']

export const rememberCmd: Command = {
  id: 'remember',
  title: '记住',
  aliases: ['记住', '记下', '记忆', 'memorize'],
  kind: 'quick',
  agentTool: true, // 写有副作用 → 不进 plan 工具集（无 planSafe）
  enabled: true,
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要记住的内容（一句话事实/偏好/流程）' },
      title: { type: 'string', description: '索引里显示的短标题' },
      kind: { type: 'string', enum: KIND_ENUM },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['text'],
  },
  run: async (input, ctx) => {
    const m = need(ctx)
    const o = typeof input === 'string' ? { text: input } : obj(input)
    const text = String(o.text ?? o.query ?? '').trim()
    if (!text) return { type: 'text', text: '用法: remember <要记住的内容>' }
    const kind = KIND_ENUM.includes(String(o.kind)) ? (o.kind as MemoryKind) : undefined
    try {
      const meta = m.add({
        text,
        title: typeof o.title === 'string' ? o.title : undefined,
        kind,
        tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : undefined,
        ...(ctx.sessionId ? { source: ctx.sessionId } : {}),
      })
      return { type: 'text', text: `已记住 #${meta.id}：${meta.title}` }
    } catch (e) {
      return { type: 'text', text: `记忆失败: ${(e as Error).message}` }
    }
  },
}

export const forgetCmd: Command = {
  id: 'forget',
  title: '忘记',
  aliases: ['忘记', '删除记忆', 'forget'],
  kind: 'quick',
  agentTool: true,
  enabled: true,
  schema: {
    type: 'object',
    properties: { id: { type: 'string', description: '记忆 id（见 recall / 设置页）' } },
    required: ['id'],
  },
  run: async (input, ctx) => {
    const m = need(ctx)
    const o = typeof input === 'string' ? { id: input } : obj(input)
    const id = String(o.id ?? '').trim()
    if (!id) return { type: 'text', text: '用法: forget <记忆 id>' }
    m.forget(id) // 不存在幂等
    return { type: 'text', text: `已删除记忆 #${id}` }
  },
}

export const recallCmd: Command = {
  id: 'recall',
  title: '回忆',
  aliases: ['回忆', 'recall', 'memo'],
  kind: 'quick',
  agentTool: true,
  planSafe: true, // 只读，可入 plan 规划工具集
  enabled: true,
  schema: {
    type: 'object',
    properties: { query: { type: 'string', description: '要检索的关键词' } },
    required: ['query'],
  },
  run: async (input, ctx) => {
    const m = need(ctx)
    const o = typeof input === 'string' ? { query: input } : obj(input)
    const query = String(o.query ?? o.text ?? '').trim()
    if (!query) return { type: 'text', text: '用法: recall <关键词>' }
    const hits = m.recall(query)
    if (!hits.length) return { type: 'text', text: `（无匹配记忆：「${query}」）` }
    return {
      type: 'list',
      items: hits.map((h) => ({
        title: `${h.pinned ? '⭐ ' : ''}${h.title}${h.kind ? `  [${h.kind}]` : ''}`,
        subtitle: h.text,
        copy: h.text,
      })),
    }
  },
}

/** Launcher 浏览：列出全部记忆（点击复制正文）。 */
export const memoryListCmd: Command = {
  id: 'memory',
  title: '记忆列表',
  aliases: ['记忆列表', 'memories'],
  kind: 'quick',
  agentTool: false, // 浏览用，不给 agent（agent 用 recall）
  planSafe: true,
  enabled: true,
  run: async (_input, ctx) => {
    const m = need(ctx)
    const rows = m.list()
    if (!rows.length) return { type: 'text', text: '（还没有记忆。对话里让 agent「记住…」即可）' }
    return {
      type: 'list',
      items: rows.map((r) => ({
        title: `${r.pinned ? '⭐ ' : ''}${r.title}${r.kind ? `  [${r.kind}]` : ''}`,
        subtitle: r.gist,
        copy: r.gist,
      })),
    }
  },
}
