// UI e2e 助手：起一个可配置行为的 mock gateway，向临时 userData 写入 config，
// 再以 Playwright 启动真实 Electron（out/ 构建产物）。每个测试独立启动/清理。
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { defaultConfig } from '../../src/main/config'

export const ROOT = join(__dirname, '..', '..')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface MockBehavior {
  models?: string[]
  quickReply?: string // 非流式(quick 命令如 trans)回复
  streamReply?: (lastUserText: string) => string // agent 流式最终文本
  toolName?: string // 若设置：首轮带 tools 且无 tool 结果 → 先发一次工具调用
  toolArgs?: string // toolName 的参数 JSON
  /** 首条内容 chunk 前的延迟（ms）——用于验证「挂载时首轮还在跑」的场景。 */
  firstDelayMs?: number
}

export interface Mock {
  base: string
  close(): void
}

/** OpenAI 兼容 mock：/readyz、/v1/models、/v1/chat/completions(流式+非流式)。 */
export async function startMock(beh: MockBehavior = {}): Promise<Mock> {
  const models = beh.models ?? ['common', 'trans']
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/readyz') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/admin/reload') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'reloaded' }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        let r: { stream?: boolean; messages?: { role: string; content?: string }[]; tools?: unknown[] } = {}
        try {
          r = JSON.parse(body)
        } catch {
          /* ignore malformed */
        }
        if (!r.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: beh.quickReply ?? '你好,世界' }, finish_reason: 'stop' }] }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const send = (s: string) => res.write(`data: ${s}\n\n`)
        const messages = r.messages ?? []
        const hasToolRole = messages.some((m) => m.role === 'tool')
        const hasTools = Array.isArray(r.tools) && r.tools.length > 0
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        if (beh.toolName && hasTools && !hasToolRole) {
          const args = beh.toolArgs ?? '{"query":"临时文件"}'
          send(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: beh.toolName, arguments: args } }] } }] }))
          send(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
          res.end('data: [DONE]\n\n')
          return
        }
        const text = beh.streamReply ? beh.streamReply(String(lastUser?.content ?? '')) : `已收到:${String(lastUser?.content ?? '')}`
        if (beh.firstDelayMs) await sleep(beh.firstDelayMs) // 拉长首回复，模拟慢模型
        const mid = Math.ceil(text.length / 2)
        for (const ch of [text.slice(0, mid), text.slice(mid)]) {
          if (!ch) continue
          send(JSON.stringify({ choices: [{ delta: { content: ch } }] }))
          await sleep(8) // 留出可观察的流式窗口
        }
        send(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        res.end('data: [DONE]\n\n')
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** 占一个随即空闲端口后立刻关闭 —— 用于"gateway 不可达"场景。 */
async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', resolve)
  })
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

export interface LaunchOpts {
  behavior?: MockBehavior
  fileRoots?: string[]
  /** gateway 完全不可达（down）。 */
  down?: boolean
}

export interface Launched {
  app: ElectronApplication
  launcher: Page
  userData: string
  cleanup(): Promise<void>
}

export async function launchApp(opts: LaunchOpts = {}): Promise<Launched> {
  const { behavior = {}, fileRoots = [], down = false } = opts
  let mock: Mock | null = null
  let base: string
  if (down) {
    base = `http://127.0.0.1:${await closedPort()}`
  } else {
    mock = await startMock(behavior)
    base = mock.base
  }
  const userData = mkdtempSync(join(tmpdir(), 'ctools-e2e-'))
  const cfg = { ...defaultConfig(), gatewayUrl: base, adminUrl: base, defaultAlias: 'common', fileRoots, hotkey: '' }
  writeFileSync(join(userData, 'config.json'), JSON.stringify(cfg, null, 2))

  const env: Record<string, string> = { ...process.env } as Record<string, string>
  env.CTOOLS_USER_DATA = userData
  delete env.GW_GATEWAY_BIN // 不自动拉起真实 gateway
  delete env.ELECTRON_RENDERER_URL // 走 out/ 构建产物，不接 dev server

  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env })
  const launcher = await app.firstWindow()
  await launcher.waitForSelector('.launcher .bar', { state: 'visible' })
  return {
    app,
    launcher,
    userData,
    cleanup: async () => {
      try {
        await app.close()
      } catch {
        /* 已退出 */
      }
      rmSync(userData, { recursive: true, force: true })
      await mock?.close()
    },
  }
}
