// clipboard：最近历史（quick）+ 语义召回（clipboard <query>，仅走本地模型 alias）。
// specs/clipboard.md。非 agentTool —— 远端模型接触不到剪贴板。
import type { ClipItem, Command } from '../src/shared/types'
import { queryText } from '../src/shared/tool'

const preview = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 140)
const time = (ts: number): string => new Date(ts).toLocaleTimeString()

/** 本地模型从候选中挑最贴合的一条（编号），失败回退第 1 条。 */
export async function recallByModel(
  query: string,
  items: ClipItem[],
  ask: (prompt: string) => Promise<string>,
): Promise<ClipItem> {
  const list = items.map((it, i) => `${i + 1}. ${preview(it.text)}`).join('\n')
  const prompt = `剪贴板候选：\n${list}\n\n查询：${query}\n只返回与查询最匹配的一条的编号（纯数字）。`
  let content = ''
  try {
    content = (await ask(prompt)).trim()
  } catch {
    /* fallback below */
  }
  const m = content.match(/\d+/)
  const idx = m ? parseInt(m[0], 10) - 1 : 0
  const clamped = Math.min(Math.max(idx, 0), items.length - 1)
  return items[clamped] ?? items[0]
}

export const clipboardCmd: Command = {
  id: 'clipboard',
  title: '剪贴板',
  aliases: ['clip', '剪贴板', 'cb'],
  kind: 'quick',
  agentTool: false, // 剪贴板内容对远端模型不可见
  enabled: true,
  run: async (input, ctx) => {
    if (!ctx.clipboard) return { type: 'text', text: '剪贴板存储未初始化' }
    const q = queryText(input)

    if (!q) {
      const items = await ctx.clipboard.recent(15)
      if (items.length === 0) return { type: 'text', text: '剪贴板历史为空' }
      return {
        type: 'list',
        items: items.map((it) => ({ title: preview(it.text), subtitle: time(it.ts), copy: it.text })),
      }
    }

    // 语义召回：仅本地模型 alias（远端 agent 不可信）
    const alias = ctx.config.clipboardLocalAlias
    if (!alias) {
      return { type: 'text', text: 'clipboard <query> 需要本地模型 alias（Settings → 偏好配置）。空参数回车可看历史。' }
    }
    const items = await ctx.clipboard.candidates(q, 20)
    if (items.length === 0) return { type: 'text', text: `剪贴板无匹配 "${q}"` }

    const picked = await recallByModel(q, items, (prompt) =>
      ctx.gateway.chat({ model: alias, messages: [{ role: 'user', content: prompt }] }).then((r) => r.content),
    )
    return { type: 'text', text: picked.text }
  },
}
