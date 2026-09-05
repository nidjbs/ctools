// 工具/参数辅助：把 Command 转成 OpenAI function spec；统一取参方式。
import type { Command } from './types'

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

const DEFAULT_PARAMS = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
}

/** 从 Command 构建 function spec（agent 请求的 tools）。 */
export function toolSpecOf(cmd: Command): ToolSpec {
  return {
    type: 'function',
    function: { name: cmd.id, description: cmd.title, parameters: cmd.schema ?? DEFAULT_PARAMS },
  }
}

/** 统一取查询文本：Launcher 传字符串；agent 传 { query }。 */
export function queryText(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  if (input && typeof input === 'object' && 'query' in input) {
    return String((input as { query: unknown }).query ?? '').trim()
  }
  return String(input ?? '').trim()
}
