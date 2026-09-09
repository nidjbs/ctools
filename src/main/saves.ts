// /save：用 LLM 把会话蒸馏成「精炼可复用指令」草稿 → Chat 内确认/微调 → 保存。
// 持久化到 userData/saves.json；Launcher 首页空态/前缀搜索即可命中使用。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from '../shared/types'

export interface DraftMeta {
  title: string
  instruction: string // 可含 {param} 占位
  paramHint: string
}

export interface SavedCommand extends DraftMeta {
  id: string
  createdAt: string
}

/** 只需 chat 能力的最小 ctx（便于单测/主进程注入）。 */
export interface DraftCtx {
  gateway: { chat(req: { model: string; messages: unknown[] }): Promise<{ content: string }> }
  config: { defaultAlias: string }
}

function file(dir: string): string {
  return join(dir, 'saves.json')
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿-]+/g, '_')
    .slice(0, 24)
  return s || 'saved'
}

export function listSaves(dir: string): SavedCommand[] {
  const p = file(dir)
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SavedCommand[]
  } catch {
    return []
  }
}

export function saveCommand(dir: string, d: DraftMeta): SavedCommand {
  const cmd: SavedCommand = {
    id: slug(d.title),
    title: d.title.trim() || '我的命令',
    instruction: d.instruction,
    paramHint: d.paramHint,
    createdAt: new Date().toISOString(),
  }
  const all = listSaves(dir).filter((c) => c.id !== cmd.id)
  all.unshift(cmd)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file(dir), JSON.stringify(all, null, 2), 'utf-8')
  return cmd
}

/** 删除沉淀模板（按 id 精确；不存在幂等）。 */
export function removeSave(dir: string, id: string): void {
  const all = listSaves(dir)
  const next = all.filter((c) => c.id !== id)
  if (next.length === all.length) return
  writeFileSync(file(dir), JSON.stringify(next, null, 2), 'utf-8')
}

/** 会话摘要（供蒸馏）：取最近若干条 用户/助手 内容，各截断。 */
export function transcriptDigest(events: SessionEvent[], max = 8): string {
  const lines: string[] = []
  for (const e of events) {
    if (e.type === 'user.message' || e.type === 'assistant.message') {
      const who = e.type === 'user.message' ? '用户' : '助手'
      const c = (e.content ?? '').replace(/\s+/g, ' ').slice(0, 400)
      if (c) lines.push(`${who}：${c}`)
    }
  }
  const cut = lines.slice(-max)
  return cut.length ? cut.join('\n') : '（空会话）'
}

/** 从模型响应里稳健抽出 JSON 对象。 */
export function extractJson(text: string): DraftMeta | null {
  const t = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(t.slice(start, end + 1)) as Partial<DraftMeta>
    if (typeof o.title === 'string' && typeof o.instruction === 'string') {
      return { title: o.title.trim(), instruction: o.instruction.trim(), paramHint: (o.paramHint ?? '').trim() }
    }
  } catch {
    /* not json */
  }
  return null
}

const DISTILL_PROMPT = (digest: string, hint: string, feedback: string) =>
  `你是命令提炼器。下面是一段真实会话（可能含工具执行），请提炼成一条可复用的个人助手「能力模板」。
要求：
- title：一句话名称（8~20 字）
- instruction：精炼、无废话、可直接执行的操作指令（可含占位符 {param} 表示每次要用户给的可变输入）；不要出现本次具体数据，除非是固定路径
- paramHint：给用户看的参数引导，如"输入要处理的文本/路径"
${hint ? `- 用户希望模板名偏向：${hint}\n` : ''}${feedback ? `- 用户要求调整：${feedback}\n` : ''}
只输出 JSON：{"title":"...","instruction":"...","paramHint":"..."}

会话：
${digest}`

/** LLM 蒸馏草稿；模型失败则回退朴素裁剪。 */
export async function distillDraft(ctx: DraftCtx, events: SessionEvent[], hint = '', feedback = ''): Promise<DraftMeta> {
  const digest = transcriptDigest(events)
  const fallback: DraftMeta = {
    title: hint || '我的命令',
    instruction: digest === '（空会话）' ? '把下面内容处理好并输出结果' : `按下面会话的做法执行：\n${digest}`,
    paramHint: '输入要处理的内容',
  }
  try {
    const r = await ctx.gateway.chat({
      model: ctx.config.defaultAlias,
      messages: [{ role: 'user', content: DISTILL_PROMPT(digest, hint, feedback) }],
    })
    return extractJson(r.content) ?? fallback
  } catch {
    return fallback
  }
}
