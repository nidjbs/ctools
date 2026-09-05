// Chat 会话管理：单活动会话，串行 agent turn，可取消。事件 + 流式增量都推给 UI。
import type { Ctx, SessionEvent } from '../shared/types'
import { Registry } from './registry'
import { Session } from './session'
import { runAgentTurn, seedSystem } from './agent'

const defaultSystemPrompt = '你是用户的个人 AI 助手，定位是快速帮用户处理简单、重复的工作。回答简洁，直接给出结果。'

/** ChatManager → UI 的输出：结构化事件 + 流式增量 + 运行态变化。 */
export interface ChatIO {
  onEvent(ev: SessionEvent): void
  onDelta(text: string): void
  /** 运行态变化（开始/结束），让 UI 停止「回答中」态。 */
  onRunning?(running: boolean): void
  /** 工具需人工批准（bash/破坏性写删）。resolve(true)=批准执行。 */
  onConfirm?(tool: string, message: string): Promise<boolean>
}

export class ChatManager {
  /** 无会话则新建（不自动续上次：首次打开即新会话）。 */
  private session: Session | null = null
  private running = false
  private abort?: AbortController

  constructor(
    private readonly ctx: Ctx,
    private readonly registry: Registry,
    private readonly sessionsDir?: string,
  ) {}

  private newSession(): Session {
    const s = new Session(this.sessionsDir)
    seedSystem(s, defaultSystemPrompt)
    return s
  }

  async open(firstMessage: string | undefined, io: ChatIO): Promise<{ id: string }> {
    if (!this.session) this.session = this.newSession()
    if (firstMessage?.trim()) await this.run(firstMessage, io)
    return { id: this.session.id }
  }

  async run(text: string, io: ChatIO): Promise<void> {
    if (!this.session) return
    if (this.running) throw new Error('上一轮仍在运行，请等待或取消')
    this.running = true
    this.abort = new AbortController()
    io.onRunning?.(true)
    try {
      await runAgentTurn(
        this.session,
        text,
        this.ctx,
        this.registry,
        {
          onContent: (d) => io.onDelta(d),
          onEvent: (e) => io.onEvent(e),
          ...(io.onConfirm ? { onConfirm: io.onConfirm } : {}),
        },
        { signal: this.abort.signal },
      )
    } catch (e) {
      if ((e as Error).message !== 'cancelled') {
        // 错误落成会话事件，晚挂载/重建的窗口也能在 transcript 里看到
        this.session?.append('agent.error', { content: (e as Error).message })
      }
      throw e
    } finally {
      this.running = false
      io.onRunning?.(false)
    }
  }

  sessionId(): string | undefined {
    return this.session?.id
  }

  cancel(): void {
    this.abort?.abort()
  }

  isRunning(): boolean {
    return this.running
  }

  transcript(): SessionEvent[] {
    return this.session?.transcript() ?? []
  }
}
