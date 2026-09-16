// ask：agent 向用户澄清。返回 {type:'ask'}，由 agentLoop 转成提问 → 用户回答回填为 tool.result。
// 非 planSafe（有交互副作用）。specs/ask.md。
import type { Command } from '../src/shared/types'

export const askCmd: Command = {
  id: 'ask',
  title: '向用户提问',
  description: '需求不明确时先问用户，不要猜。给出 2-4 个候选项时用 options。',
  aliases: ['ask', '提问', '澄清'],
  kind: 'quick',
  agentTool: true, // 但非 planSafe：提问有交互副作用，不进规划工具集
  enabled: true,
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问用户的问题（一句话，具体）' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的候选项（用户也可自由输入）',
      },
    },
    required: ['question'],
  },
  run: async (input) => {
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const question = String(typeof input === 'string' ? input : (o.question ?? '')).trim()
    if (!question) return { type: 'text', text: '用法: ask <问题>' }
    const options = Array.isArray(o.options) ? (o.options as unknown[]).map(String).filter(Boolean) : undefined
    return { type: 'ask', question, ...(options?.length ? { options } : {}) }
  },
}
