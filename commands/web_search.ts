// web_search：联网搜索（默认 DuckDuckGo HTML，零 key）。默认关闭（config.webSearchEnabled），
// 每次调用需人工批准（confirmApproved）。agentTool。只回标题+摘要，不自动开正文。
import type { Command, Ctx } from '../src/shared/types'
import { queryText } from '../src/shared/tool'

const MAX_RESULTS = 5

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

/** 解析 DuckDuckGo html 结果页为 {title,url,snippet}[]（纯函数，可单测）。 */
export function parseDdg(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = []
  const re =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < MAX_RESULTS) {
    out.push({ url: m[1], title: stripTags(m[2]), snippet: stripTags(m[3]) })
  }
  return out
}

/** 实际检索（main 内网络）。 */
export async function searchWeb(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`搜索上游 ${res.status}`)
  const results = parseDdg(await res.text())
  if (results.length === 0) return '(未检索到结果，可能被限流或词过偏)'
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n')
}

function gate(ctx: Ctx) {
  if (ctx.confirmApproved) return null
  return { type: 'confirm' as const, message: '确认发起一次联网搜索？' }
}

export const webSearchCmd: Command = {
  id: 'web_search',
  title: '联网搜索',
  aliases: ['搜索', 'search', 'ddg', '查一下'],
  kind: 'quick',
  agentTool: true,
  enabled: true,
  run: async (input, ctx) => {
    const q = queryText(input)
    if (!q) return { type: 'text', text: '用法: web_search <查询>' }
    if (!ctx.config.webSearchEnabled) {
      return { type: 'text', text: '联网搜索未开启（Settings → 偏好 打开 web search 后可用）' }
    }
    const gated = gate(ctx)
    if (gated) return gated
    try {
      return { type: 'text', text: await searchWeb(q) }
    } catch (e) {
      return { type: 'text', text: `搜索失败: ${(e as Error).message}` }
    }
  },
}
