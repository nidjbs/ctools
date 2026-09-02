// 共享类型：main / preload / renderer 三端共用。见 docs/architecture.md §9。

export type CommandKind = 'quick' | 'chat' | 'confirm'

export type CommandResult =
  | { type: 'text'; text: string }
  | { type: 'list'; items: { title: string; subtitle?: string; copy?: string }[] }
  | { type: 'chat'; sessionId: string }
  | { type: 'confirm'; message: string }

/** 一个能力 = 一个 Command。悬浮联想 / agent 工具 / 设置页启停都读注册表。 */
export interface CommandMeta {
  id: string
  title: string
  aliases: string[]
  kind: CommandKind
  agentTool: boolean
  enabled: boolean
}

export interface Command extends CommandMeta {
  /** 声明式参数 schema（悬浮框与 agent 共用校验）。 */
  schema?: unknown
  /** 执行；ctx 携带 config / gateway / system 集成。 */
  run(input: unknown, ctx: Ctx): Promise<CommandResult>
}

/** 命令执行环境：一切依赖显式注入，命令自身不做硬编码。 */
export interface Ctx {
  config: AppConfig
  gateway: {
    chat(req: { model: string; messages: unknown[] }): Promise<{ content: string }>
  }
  system: {
    pbcopy(text: string): Promise<boolean>
    mdfind(query: string, roots: string[]): Promise<string[]>
  }
}

export interface AppConfig {
  gatewayUrl: string
  adminUrl: string
  adminToken?: string
  defaultAlias: string
  clipboardLocalAlias?: string
  fileRoots: string[]
  writeConfirm: 'auto' | 'always' | 'never'
  hotkey: string
  enabledCommands: Record<string, boolean>
}

// ---------- 会话（事件溯源, 与 gw sessionlog schema 对齐） ----------

export type SessionEventType =
  | 'session.started'
  | 'system.context'
  | 'user.message'
  | 'model.request'
  | 'assistant.message'
  | 'tool.call'
  | 'tool.result'
  | 'agent.error'
  | 'context.compact'
  | 'session.ended'

export interface SessionEvent {
  event_id: string
  session_id: string
  seq: number
  type: SessionEventType
  occurred_at: string
  role?: string
  turn?: number
  request_id?: string
  model?: string
  tool_name?: string
  tool_call_id?: string
  arguments?: string
  content?: string
  tool_calls?: unknown[]
  source_seqs?: number[]
  shadow_seqs?: number[]
}

// ---------- IPC 契约（preload 暴露到 window.api） ----------

export interface CtoolsApi {
  commands: {
    list(): Promise<CommandMeta[]>
    match(input: string): Promise<CommandMeta[]>
    run(id: string, input: string): Promise<CommandResult>
  }
  config: {
    get(): Promise<AppConfig>
    update(patch: Partial<AppConfig>): Promise<AppConfig>
  }
  gateway: {
    status(): Promise<'running' | 'stopped'>
  }
  system: {
    pbcopy(text: string): Promise<boolean>
  }
}
