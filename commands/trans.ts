import type { Command } from '../src/shared/types'
import { queryText } from '../src/shared/tool'

// 示例 Command：quick 单轮。悬浮输入 / 回车直接 inline 出译文。
export const trans: Command = {
  id: 'trans',
  title: '翻译',
  aliases: ['translate', '翻译', 'fy'],
  kind: 'quick',
  enabled: true,
  agentTool: false,
  run: async (input: unknown, ctx) => {
    const text = queryText(input)
    if (!text) return { type: 'text', text: '输入要翻译的内容' }
    const turn = await ctx.gateway.chat({
      model: ctx.config.defaultAlias,
      messages: [
        { role: 'system', content: '你是翻译引擎。中文输入→英文输出, 英文输入→中文输出。只输出译文。' },
        { role: 'user', content: text },
      ],
    })
    return { type: 'text', text: turn.content || '(空回复)' }
  },
}
