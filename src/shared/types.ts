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

/** agent 流式回调。 */
export interface StreamHandlers {
  onContent(delta: string): void
  /** 推理模型（如 deepseek-v4 思考模式）的 reasoning 增量，需回传。 */
  onReasoning?(delta: string): void
  onToolCalls?(calls: unknown[]): void
  onFinish?(reason?: string): void
}

export interface ClipItem {
  text: string
  ts: number
}

/** /save LLM 蒸馏草稿（可含 {param} 占位）。 */
export interface DraftMeta {
  title: string
  instruction: string
  paramHint: string
}

/** /save 沉淀的复用模板元数据（无函数，可经 IPC）。 */
export interface SavedMeta {
  id: string
  title: string
  instruction: string
  paramHint: string
}

/** 命令执行环境：一切依赖显式注入，命令自身不做硬编码。 */
export interface Ctx {
  config: AppConfig
  /** Main 装配的剪贴板历史（clipboard 命令用）。 */
  clipboard?: {
    recent(n: number): Promise<ClipItem[]>
    candidates(query: string, n: number): Promise<ClipItem[]>
  }
  /** 仅 commands:confirm IPC 设置：写/删命令两段 confirm 的放行标记。 */
  confirmApproved?: boolean
  gateway: {
    models(): Promise<string[]>
    chat(req: { model: string; messages: unknown[] }): Promise<{ content: string }>
    chatStream(
      req: { model: string; messages: unknown[]; tools?: unknown[] },
      h: StreamHandlers,
      opts?: { signal?: AbortSignal },
    ): Promise<void>
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
  /** 启动时自动拉起并托管 gateway（需 gw CLI；默认关，避免意外拉起外部进程）。 */
  managedGateway?: boolean
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
  /** 推理模型思考内容（assistant.message 携带，回传上游要求）。 */
  reasoning_content?: string
  tool_calls?: unknown[]
  source_seqs?: number[]
  shadow_seqs?: number[]
}

// ---------- IPC 契约（preload 暴露到 window.api） ----------

export interface CtoolsApi {
  commands: {
    list(): Promise<CommandMeta[]>
    all(): Promise<CommandMeta[]> // 含禁用，供 Settings
    match(input: string): Promise<CommandMeta[]>
    recent(): Promise<CommandMeta[]> // 空输入时的最近常用
    run(id: string, input: string): Promise<CommandResult>
    /** 两段 confirm：带放行标记重放执行写/删命令。 */
    confirm(id: string, input: string): Promise<CommandResult>
  }
  config: {
    get(): Promise<AppConfig>
    update(patch: Partial<AppConfig>): Promise<AppConfig>
  }
  gateway: {
    status(): Promise<'running' | 'stopped'>
    models(): Promise<string[]>
    reload(): Promise<{ ok: boolean; error?: string }>
    restart(): Promise<'running' | 'stopped'>
    ensure(): Promise<'running' | 'stopped'>
  }
  window: {
    hide(): Promise<void>
    openSettings(): Promise<void>
  }
  system: {
    pbcopy(text: string): Promise<boolean>
  }
  session: {
    /** 打开 Chat 会话（可携带首条消息直接开跑）。 */
    open(firstMessage?: string): Promise<{ id: string }>
    send(text: string): Promise<void>
    cancel(): Promise<void>
    transcript(): Promise<SessionEvent[]>
    running(): Promise<boolean>
    /** 回批工具人工在环确认（id 来自 onToolConfirm）。 */
    confirm(id: number, ok: boolean): Promise<void>
    /** 待批确认（晚挂载的渲染层主动拉取，防事件丢失）。 */
    pendingConfirm(): Promise<{ id: number; tool: string; message: string } | null>
  }
  /** /save 沉淀复用模板（LLM 蒸馏 → 确认 → 保存）。 */
  saves: {
    list(): Promise<SavedMeta[]>
    draft(hint?: string, feedback?: string): Promise<DraftMeta>
    save(draft: DraftMeta): Promise<SavedMeta>
  }
  /** 工具需人工批准（bash/破坏性写删）。 */
  onToolConfirm(cb: (req: { id: number; tool: string; message: string }) => void): () => void
  /** 订阅会话事件推送；返回取消订阅函数。 */
  onSessionEvent(cb: (ev: SessionEvent) => void): () => void
  /** 订阅流式文本增量。 */
  onSessionDelta(cb: (text: string) => void): () => void
  /** 订阅运行态变化（start/end），用于停止「回答中」态。 */
  onSessionRunning(cb: (running: boolean) => void): () => void
  /** Launcher 每次唤起时通知（清空输入、重新聚焦）。 */
  onLauncherShow(cb: () => void): () => void
}
