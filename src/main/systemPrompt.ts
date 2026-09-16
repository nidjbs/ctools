// 每轮 system 段组装：环境（工作目录 / 可写范围 / 工具要点）+ 记忆（索引 / pinned 正文）+ 日期。
// 排列严格「稳定 → 易变」，日期排最后 —— 前缀缓存规则见 specs/system-prompt.md（R1–R4）。
import { homedir } from 'node:os'
import type { AppConfig } from '../shared/types'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地时区日期，粒度只到天（R1：禁止时分秒，否则每次请求前缀全废）。 */
export function dateLine(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `今天是 ${y}-${m}-${d} ${WEEK[now.getDay()]}。`
}

/** 工具要点：仅对**已启用**的工具给引导（不宣传不存在的工具）。 */
const TOOL_TIPS: Array<[id: string, tip: string]> = [
  ['file_edit', '改文件用 file_edit 精确替换，不要整份重写'],
  ['grep', '找内容用 grep，命中后再 file_read 对应行区间'],
  ['file_read', '读取大文件优先用行区间（offset/limit），不要整份读'],
  ['ask', '需求不明确用 ask 向用户澄清，不要猜'],
]

export interface TurnSystemInput {
  config: AppConfig
  /** 本 pass 可用的工具 id（决定列哪些要点）。 */
  tools: string[]
  /** 记忆索引页全文（MEMORY.md）；空则省略。 */
  memoryIndex?: string
  /** pinned 记忆正文拼接；空则省略。 */
  pinnedText?: string
  now?: Date
}

/**
 * 组装本 turn 的 system 段（调用方在 turn 开始时构建**一次**，turn 内复用 —— R2）。
 * 顺序：工作目录 → 可写范围 → 工具要点 → 记忆索引 → pinned 正文 → 日期。
 */
export function buildTurnSystem(input: TurnSystemInput): string {
  const { config, tools, memoryIndex, pinnedText, now = new Date() } = input
  const parts: string[] = []

  const roots = (config?.fileRoots ?? []).filter(Boolean)
  const cwd = roots[0] ?? homedir()
  const env: string[] = [`工作目录（bash cwd）: ${cwd}`]
  env.push(
    roots.length
      ? `可写范围（file_roots）: ${roots.join(', ')}`
      : '可写范围（file_roots）: （未配置，文件工具不可用）',
  )
  const tips = TOOL_TIPS.filter(([id]) => tools.includes(id)).map(([, tip]) => `- ${tip}`)
  if (tips.length) env.push('工具要点：', ...tips)
  parts.push(env.join('\n'))

  const idx = memoryIndex?.trim()
  if (idx) parts.push(idx)

  const pinned = pinnedText?.trim()
  if (pinned) parts.push(`【常驻记忆】\n${pinned}`)

  if (config?.injectDate !== false) parts.push(dateLine(now)) // 易变，排最后（R3）

  return parts.join('\n\n')
}
