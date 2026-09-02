import type { Command } from '../src/shared/types'

// 模糊找文件：Spotlight 搜文件名 + 内容（只限 file_roots）。agentTool 供 agent 调用。
export const findFile: Command = {
  id: 'find_file',
  title: '查找文件',
  aliases: ['find', '文件', '搜索', 'locate'],
  kind: 'quick',
  enabled: true,
  agentTool: true,
  run: async (input: unknown, ctx) => {
    const query = String(input ?? '').trim()
    if (!query) return { type: 'text', text: '输入文件名/内容关键词' }
    const paths = await ctx.system.mdfind(query, ctx.config.fileRoots)
    if (paths.length === 0) return { type: 'text', text: `未找到匹配 "${query}" 的文件` }
    return {
      type: 'list',
      items: paths.slice(0, 10).map((p) => ({ title: p, subtitle: '回车复制路径', copy: p })),
    }
  },
}
