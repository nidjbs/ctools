// clipboard：最近历史（quick）+ 语义召回（clipboard <query>）。
// specs/clipboard.md。非 agentTool。召回默认走本地模型 alias（clipboardLocalAlias）；
// 未配置本地 alias 时先回退普通（远端）默认模型。剪贴板内容会进入所用模型。
import type { ClipItem, Command } from '../src/shared/types'
import { queryText } from '../src/shared/tool'
import { tokenOverlap } from '../src/main/clipboard'

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

    /** 当前剪贴板文本（调用即读并顺带记录），保证“复制完立刻能用”。 */
    const live = async (): Promise<ClipItem | null> => {
      try {
        const t = ctx.clipboard?.current ? await ctx.clipboard.current() : ''
        return t ? { text: t, ts: Date.now() } : null
      } catch {
        return null
      }
    }

    if (!q) {
      const cur = await live()
      const items = await ctx.clipboard.recent(15)
      const combined = cur ? [cur, ...items.filter((i) => i.text !== cur.text)] : items
      if (combined.length === 0) return { type: 'text', text: '剪贴板为空——复制任意内容即可在这里看到' }
      return {
        type: 'list',
        items: combined.slice(0, 15).map((it) => ({ title: preview(it.text), subtitle: time(it.ts), copy: it.text })),
      }
    }

    // 语义召回：优先本地模型 alias（隐私）；未配则回退普通默认模型
    const alias = ctx.config.clipboardLocalAlias || ctx.config.defaultAlias
    if (!alias) {
      return { type: 'text', text: '未配置可用模型（defaultAlias / clipboardLocalAlias）' }
    }
    const cur = await live()
    const items = await ctx.clipboard.candidates(q, 20)
    const combined = cur && tokenOverlap(q, cur.text) > 0 && !items.some((i) => i.text === cur.text)
      ? [cur, ...items]
      : items

    // 无相关内容：不静默——明确提示未搜到，并展示最近剪贴板供复制
    if (combined.length === 0) {
      const recents = await ctx.clipboard.recent(10)
      return {
        type: 'list',
        items: [
          { title: `未搜到与「${q}」匹配的内容`, subtitle: '以下为最近剪贴板，点按可复制' },
          ...recents.map((it) => ({ title: preview(it.text), subtitle: time(it.ts), copy: it.text })),
        ],
      }
    }

    const picked = await recallByModel(q, combined, (prompt) =>
      ctx.gateway.chat({ model: alias, messages: [{ role: 'user', content: prompt }] }).then((r) => r.content),
    )
    // 命中结果可点按复制（避免“搜到了却没法用”）
    return {
      type: 'list',
      items: [{ title: preview(picked.text), subtitle: `命中「${q}」— 点按复制`, copy: picked.text }],
    }
  },
}
