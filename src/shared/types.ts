// 共享类型：main / preload / renderer 三端共用。见 docs/architecture.md §9。

export type CommandKind = 'quick' | 'chat' | 'confirm'

/** agent 对话模式：normal=现状直跑；plan=先规划、批准后才执行（specs/plan-mode.md）。 */
export type AgentMode = 'normal' | 'plan'

export type CommandResult =
  | { type: 'text'; text: string }
  | {
      type: 'list'
      items: { title: string; subtitle?: string; copy?: string; path?: string }[]
    }
  | { type: 'chat'; sessionId: string }
  | { type: 'confirm'; message: string }
  /** agent 向用户提问；答案作为该工具的 tool.result 回填。见 specs/ask.md。 */
  | { type: 'ask'; question: string; options?: string[] }

/** 历史会话摘要（Launcher 首页「最近会话」用）。 */
export interface SessionSummary {
  id: string
  title: string
  updatedAt: string
}

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
  /** 只读、无副作用：可进入 plan 模式规划工具集。默认 false。 */
  planSafe?: boolean
  /** 给模型看的「何时用 / 何时不用」一句话；缺省回退到 title。见 specs/agent-loop.md §3。 */
  description?: string
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

// ---------- 网关配置文件（providers / aliases）----------

/** 上游配置。`api_key_env` 是**环境变量名**，cTools 不存也不回显真实密钥。 */
export interface GwProvider {
  type: string
  base_url: string
  request_timeout?: string
  api_key_env?: string
  [k: string]: unknown
}

export interface GwAlias {
  provider: string
  model: string
}

export interface GwConfigView {
  path: string
  exists: boolean
  providers: Record<string, GwProvider>
  aliases: Record<string, GwAlias>
  /** 读/解析失败的原因（存在时编辑区应禁用）。 */
  error?: string
}

export interface GwSaveInput {
  providers: Record<string, GwProvider>
  aliases: Record<string, GwAlias>
}

export interface GwSaveResult {
  ok: boolean
  /** 备份文件路径（成功时）。 */
  backup?: string
  error?: string
}

/** 记忆条目元数据（无正文，可经 IPC）。 */
export interface MemoryMeta {
  id: string
  title: string
  gist: string
  kind?: 'fact' | 'preference' | 'procedure'
  tags?: string[]
  pinned?: boolean
  ts: string
  source?: string
}

/** 召回命中：元数据 + 正文。 */
export interface MemoryHit extends MemoryMeta {
  text: string
}

/** 命令执行环境：一切依赖显式注入，命令自身不做硬编码。 */
export interface Ctx {
  config: AppConfig
  /** 当前活动会话 id（memory 溯源审计用）；无会话时为 undefined。 */
  sessionId?: string
  /** 大工具结果外置目录（读白名单之一，写仍限 file_roots）。见 specs/context.md。 */
  spillDir?: string
  /** Main 装配的长期记忆（agent 工具 + 每轮 system 注入）。见 specs/memory.md。 */
  memory?: {
    /** 索引页全文（MEMORY.md）；空库返回 ''。 */
    index(): string
    /** pinned 条目正文拼接（上限内，按 ts 新近）；无则 ''。 */
    pinnedText(): string
    /** 本地关键词召回（索引打分 → 命中取正文）。 */
    recall(query: string, k?: number): MemoryHit[]
    /** 写入一条记忆（含索引页重写）。 */
    add(input: { text: string; title?: string; kind?: MemoryMeta['kind']; tags?: string[] }): MemoryMeta
    /** 软删（tombstone）；不存在幂等。 */
    forget(id: string): void
    /** 切换 pinned（正文常驻注入）；不存在幂等。 */
    setPinned(id: string, pinned: boolean): void
    /** 全部活动记忆（Settings / Launcher 用），按 ts 降序。 */
    list(): MemoryMeta[]
  }
  /** Main 装配的剪贴板历史（clipboard 命令用）。 */
  clipboard?: {
    recent(n: number): Promise<ClipItem[]>
    candidates(query: string, n: number): Promise<ClipItem[]>
    /** 读取当前剪贴板文本（顺带记录），供命令即时使用。 */
    current?(): Promise<string>
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
  /** 各固定场景的模型别名（命令 id → 别名）；未设置/空串回退 defaultAlias。见 specs/settings.md §2。 */
  commandModels?: Record<string, string>
  clipboardLocalAlias?: string
  fileRoots: string[]
  writeConfirm: 'auto' | 'always' | 'never'
  hotkey: string
  /** 启动时自动拉起并托管 gateway（需 gw CLI；默认关，避免意外拉起外部进程）。 */
  managedGateway?: boolean
  /** 联网搜索开关（默认关；开启后 web_search 对 agent/Launcher 可用，调用仍需批准）。 */
  webSearchEnabled?: boolean
  /** bash 联网开关（默认关：bash 经 sandbox-exec 强制禁网；开=放行联网，执行仍每次人工确认）。 */
  bashNetwork?: boolean
  /** 每轮 system 注入当天日期（前缀缓存仅跨天失效一次；默认开）。见 specs/system-prompt.md。 */
  injectDate?: boolean
  /** 上下文 token 上限（按所连模型的窗口设；默认 24000）。见 specs/context.md。 */
  contextTokens?: number
  enabledCommands: Record<string, boolean>
}

// ---------- 会话（事件溯源，无损留痕） ----------

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
  | 'context.summary'
  | 'plan.propose'
  | 'plan.approved'
  | 'plan.rejected'
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
    /** 探测本机 Ollama（首启向导用）。specs/first-run.md。 */
    probeOllama(): Promise<{ ok: boolean; baseUrl: string; models: string[]; error?: string }>
    /** 读网关配置文件的 providers / aliases。见 specs/gateway-config.md。 */
    config(): Promise<GwConfigView>
    /** 写回 providers / aliases（备份 + 校验 + 原子写）；apply=reload 热更 / restart 重启。 */
    configSave(input: GwSaveInput, apply: 'reload' | 'restart'): Promise<GwSaveResult & { applied?: boolean; applyError?: string }>
  }
  window: {
    hide(): Promise<void>
    openSettings(): Promise<void>
    /** 关闭当前窗口（收起界面，进程保留）。 */
    close(): Promise<void>
    /** 原生目录选择器（首启配置 file_roots）；取消返回 null。见 specs/ux-polish.md §10。 */
    pickDirectory(): Promise<string | null>
  }
  system: {
    pbcopy(text: string): Promise<boolean>
    /** Finder 定位文件（IPC 层 file_roots 校验后 open -R）。越界/失败返回 false。 */
    reveal(path: string): Promise<boolean>
    /** 默认应用打开文件（IPC 层 file_roots 校验后 open）。越界/失败返回 false。 */
    open(path: string): Promise<boolean>
  }
  session: {
    /** 打开 Chat 会话（可携带首条消息直接开跑）。 */
    open(firstMessage?: string): Promise<{ id: string }>
    /** 最近会话摘要（按 updatedAt 降序，最多 10 条）。 */
    recent(): Promise<SessionSummary[]>
    /** 载入历史会话续聊（打开/聚焦 Chat，不自动发消息）。 */
    attach(id: string): Promise<{ id: string }>
    /** 另起全新会话（Chat「＋新会话」）。 */
    newSession(): Promise<{ id: string }>
    send(text: string): Promise<void>
    cancel(): Promise<void>
    transcript(): Promise<SessionEvent[]>
    running(): Promise<boolean>
    /** 回批工具人工在环确认（id 来自 onToolConfirm）。 */
    confirm(id: number, ok: boolean): Promise<void>
    /** 待批确认（晚挂载的渲染层主动拉取，防事件丢失）。 */
    pendingConfirm(): Promise<{ id: number; tool: string; message: string } | null>
    /** 待答问题（晚挂载拉取，防事件丢失）。 */
    pendingAsk(): Promise<{ id: number; question: string; options?: string[] } | null>
    /** 回答 agent 的提问（id 来自 onToolAsk）。 */
    answerAsk(id: number, text: string): Promise<void>
    /** 当前对话模式（Chat 顶栏 / Launcher 将进 agent 时 直接/规划 chip 同源）。 */
    mode(): Promise<AgentMode>
    setMode(m: AgentMode): Promise<AgentMode>
    /** 批准当前待批准计划 → 执行 pass。 */
    executePlan(): Promise<void>
    /** 按反馈重跑一轮规划 pass（content=feedback 落 plan.rejected）。 */
    replan(feedback?: string): Promise<void>
    /** 放弃待批准计划（落 plan.rejected，不回跑）。 */
    discardPlan(): Promise<void>
    /** 待批准计划（晚挂载拉取，防事件丢失）。 */
    pendingPlan(): Promise<{ seq: number; text: string } | null>
  }
  /** /save 沉淀复用模板（LLM 蒸馏 → 确认 → 保存）。 */
  saves: {
    list(): Promise<SavedMeta[]>
    draft(hint?: string, feedback?: string): Promise<DraftMeta>
    save(draft: DraftMeta): Promise<SavedMeta>
    /** 删除沉淀模板（按 id/slug；不存在幂等）。 */
    remove(id: string): Promise<void>
  }
  /** 长期记忆审阅（Settings）：列表 / 软删 / 切换常驻。见 specs/memory.md。 */
  memory: {
    list(): Promise<MemoryMeta[]>
    remove(id: string): Promise<void>
    pin(id: string, pinned: boolean): Promise<void>
  }
  /** 工具需人工批准（bash/破坏性写删）。 */
  onToolConfirm(cb: (req: { id: number; tool: string; message: string }) => void): () => void
  /** agent 提问（ask 工具）待用户回答。 */
  onToolAsk(cb: (req: { id: number; question: string; options?: string[] }) => void): () => void
  /** 订阅会话事件推送；返回取消订阅函数。 */
  onSessionEvent(cb: (ev: SessionEvent) => void): () => void
  /** 订阅流式文本增量。 */
  onSessionDelta(cb: (text: string) => void): () => void
  /** 订阅运行态变化（start/end），用于停止「回答中」态。 */
  onSessionRunning(cb: (running: boolean) => void): () => void
  /** 订阅对话模式变化（两窗 chip 同步）。 */
  onSessionMode(cb: (m: AgentMode) => void): () => void
  /** Launcher 每次唤起时通知（清空输入、重新聚焦）。 */
  onLauncherShow(cb: () => void): () => void
  /** 活动会话被切换（attach/new）→ Chat 需清态并重拉 transcript。 */
  onSessionReset(cb: () => void): () => void
}
