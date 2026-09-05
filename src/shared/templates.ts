// 常用「能力模板」：首页（空输入）展示的高频任务入口。选中 → 带出 #id 填参数。
// kind=cmd   → 直接跑对应固定型 quick 命令（inline 结果，不进 agent，如翻译/找文件）；
// kind=agent → 组装引导词交给 agent 完成（需要编排子工具，如运行脚本/读文档总结/写笔记）。
// 底层子工具仍可用精确输入调用，不占首页。
export interface Template {
  id: string
  title: string
  emoji: string
  hint: string // 参数引导（首页副标题）
  kind: 'cmd' | 'agent'
  /** kind=cmd：映射的 quick 命令 id（参数原样传入）。 */
  cmdId?: string
  /** kind=agent：参数 → agent 首条消息。 */
  build?: (param: string) => string
}

export const TEMPLATES: Template[] = [
  {
    id: 'translate',
    title: '翻译',
    emoji: '🌐',
    hint: '输入要翻译的文本（可带目标语言）',
    kind: 'cmd',
    cmdId: 'trans',
  },
  {
    id: 'find',
    title: '找文件',
    emoji: '🔍',
    hint: '输入要找的内容/文件名关键词',
    kind: 'cmd',
    cmdId: 'find_file',
  },
  {
    id: 'run',
    title: '运行命令/脚本',
    emoji: '⚡',
    hint: '描述要达成的结果（需要执行时会请求你批准）',
    kind: 'agent',
    build: (p) =>
      `运行命令/脚本：请完成下面的任务。需要执行命令或写脚本时用 bash / file_write；执行前会出现批准请求，批准后才真正执行，不要假装执行。\n\n${p}`,
  },
  {
    id: 'read',
    title: '读文档并总结',
    emoji: '📄',
    hint: '输入文档路径或内容来源',
    kind: 'agent',
    build: (p) =>
      `读文档并总结：请读取下面的路径/来源（file_roots 内，可用 file_read / office_read），然后给出要点总结。\n\n${p}`,
  },
  {
    id: 'note',
    title: '新建笔记',
    emoji: '📝',
    hint: '输入要整理的笔记内容',
    kind: 'agent',
    build: (p) => `新建笔记：请把下面的内容整理成 markdown，写入 file_roots 内的一个新文件（路径自定并告诉我）。\n\n${p}`,
  },
  {
    id: 'clip',
    title: '查剪贴板',
    emoji: '📋',
    hint: '输入想在剪贴板历史里找的内容',
    kind: 'cmd',
    cmdId: 'clipboard',
  },
]

/** 取模板；无效返回 undefined。 */
export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
