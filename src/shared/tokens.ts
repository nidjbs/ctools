// 本地 token 估算（纯函数，不引入 tokenizer 依赖）：ASCII ≈ 4 字符/token，CJK ≈ 1 字符/token。
// 取保守上界，只用于上下文阈值判断，不用于计费。见 specs/context.md。

/** CJK 及全角标点（按 1 字符 ≈ 1 token 计）。 */
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

const ASCII_PER_TOKEN = 4
/** 每条消息的角色/分隔开销。 */
const PER_MESSAGE = 4

/** 是否 CJK / 全角字符（记忆切词等复用同一判定）。 */
export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / ASCII_PER_TOKEN)
}

/** 模型可见消息的结构化投影（session.ChatMessage 的最小形状，避免 shared → main 依赖）。 */
export interface TokenCountable {
  content?: string
  reasoning_content?: string
  tool_calls?: unknown
}

/** 消息数组的 token 估算：含 tool_calls 的 JSON 序列化长度与每条固定开销。 */
export function estimateMessagesTokens(msgs: TokenCountable[]): number {
  let total = 0
  for (const m of msgs) {
    total += PER_MESSAGE
    total += estimateTokens(m.content ?? '')
    total += estimateTokens(m.reasoning_content ?? '')
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return total
}
