// 纯函数：agent 工具过程可见（tool.call/tool.result）的渲染模型。
// 只做展示推导（摘要/截断/参数预览），不承载会话语义。见 specs/tool-visible.md。
import type { SessionEvent } from './types'

const RESULT_MAX = 200
const PARAM_MAX = 120

/** 工具结果摘要：≤200 字 → 原文；否则首行截断 + …(共 N 字)。空 → (空)。 */
export function toolResultSummary(content: string | undefined): string {
  const t = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return '(空)'
  if (t.length <= RESULT_MAX) return t
  return `${t.slice(0, RESULT_MAX)}…(共 ${content!.length} 字)`
}

/** tool.call 的参数预览（首行，≤120 字；无则空）。 */
export function toolParamPreview(args: string | undefined): string {
  const t = (args ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > PARAM_MAX ? `${t.slice(0, PARAM_MAX)}…` : t
}

/** 运行气泡阶段文案：正在执行的工具 > 流式正文 > 思考。纯函数便于单测（specs/run-status.md）。 */
export function runStatusLabel(execTool: string | null, streaming: boolean): string {
  if (execTool) return `正在执行 ${execTool}…`
  if (streaming) return '生成中…'
  return '思考中…'
}

export type ToolRow =
  | { kind: 'call'; tool: string; params: string }
  | { kind: 'result'; tool: string; summary: string }

/** 把一条会话事件折叠成轻量工具行；非 tool.* 事件返回 null。 */
export function toolRowOf(ev: SessionEvent): ToolRow | null {
  if (ev.type === 'tool.call') return { kind: 'call', tool: ev.tool_name ?? '', params: toolParamPreview(ev.arguments) }
  if (ev.type === 'tool.result') return { kind: 'result', tool: ev.tool_name ?? '', summary: toolResultSummary(ev.content) }
  return null
}
