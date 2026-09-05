// Agent loop：一次用户输入 → 流式回复 + 工具调用（分发到 agentTool 命令）→ 回填直至无工具。
// 对应 docs §9.6 伪码。
import type { Ctx, StreamHandlers, SessionEvent } from '../shared/types'
import { Registry } from './registry'
import { Session } from './session'
import { toolSpecOf } from '../shared/tool'
import { compactIfNeeded } from './context'

export interface AgentCallbacks extends StreamHandlers {
  /** 每个会话事件（user/assistant/tool.call/result…）都推给 UI。 */
  onEvent(ev: SessionEvent): void
  /** 工具返回 confirm 时的人工在环批准：true → 以 confirmApproved 重放执行；false → 记为用户未批准。 */
  onConfirm?(tool: string, message: string): Promise<boolean>
}

const MAX_TURNS = 8

interface ToolCallMsg {
  id: string
  type: string
  function: { name: string; arguments: string }
}

/** 把 session 首条 system.context 写好（默认定位 + 可选 agent 规则），供 UI 先建会话。 */
export function seedSystem(session: Session, content: string): void {
  if (!content.trim()) return
  session.append('system.context', { role: 'system', content })
}

export async function runAgentTurn(
  session: Session,
  userText: string,
  ctx: Ctx,
  registry: Registry,
  cb: AgentCallbacks,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  session.append('user.message', { role: 'user', content: userText })
  cb.onEvent(session.transcript().at(-1)!)

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // 每次模型请求前做上下文压缩：裁剪大工具结果 + 接近满时 shadow 最旧消息
    compactIfNeeded(session)
    const allowed = new Set(registry.toolIds())
    const tools = [...allowed]
      .map((id) => registry.get(id)!)
      .map(toolSpecOf)
    let content = ''
    let reasoning = ''
    let toolCalls: ToolCallMsg[] = []
    const stream: StreamHandlers = {
      onContent: (d) => {
        content += d
        cb.onContent(d)
      },
      onReasoning: (d) => {
        reasoning += d
      },
      onToolCalls: (calls) => {
        toolCalls = calls as ToolCallMsg[]
      },
      onFinish: () => {},
    }
    await ctx.gateway.chatStream(
      { model: ctx.config.defaultAlias, messages: session.messages(), tools },
      stream,
      opts,
    )

    session.append('assistant.message', {
      role: 'assistant',
      content,
      reasoning_content: reasoning || undefined, // 推理模型要求后续请求原样回传
      tool_calls: toolCalls.length ? toolCalls : undefined,
    })
    cb.onEvent(session.transcript().at(-1)!)
    if (toolCalls.length === 0) return content

    for (const call of toolCalls) {
      session.append('tool.call', {
        tool_name: call.function.name,
        tool_call_id: call.id,
        arguments: call.function.arguments,
      })
      cb.onEvent(session.transcript().at(-1)!)
      let result: string
      if (!allowed.has(call.function.name)) {
        // 白名单兜底：模型幻觉出未提供的工具（写命令等）绝不执行
        result = `错误: 工具 ${call.function.name} 不在 agent 白名单`
      } else {
        try {
          const cmd = registry.get(call.function.name)
          if (!cmd) throw new Error(`未知工具 ${call.function.name}`)
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : undefined
          const r = await cmd.run(args, ctx)
          if (r.type === 'confirm') {
            // 人工在环：bash / 破坏性写删等需用户批准
            const ok = cb.onConfirm ? await cb.onConfirm(call.function.name, r.message) : false
            if (!ok) result = `用户未批准：${r.message}`
            else {
              const rr = await cmd.run(args, { ...ctx, confirmApproved: true })
              result = rr.type === 'text' ? rr.text : JSON.stringify(rr)
            }
          } else {
            result = r.type === 'text' ? r.text : JSON.stringify(r)
          }
        } catch (e) {
          result = `错误: ${(e as Error).message}`
        }
      }
      session.append('tool.result', {
        role: 'tool',
        tool_name: call.function.name,
        tool_call_id: call.id,
        content: result,
      })
      cb.onEvent(session.transcript().at(-1)!)
    }
  }
  return ''
}
