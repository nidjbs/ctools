// Electron Main：窗口 + IPC。逻辑全在 runtime 模块；这里只装配。
import { app, BrowserWindow, globalShortcut, ipcMain, clipboard as electronClipboard } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { createApp } from './app'
import { GatewayManager } from './gatewayManager'
import { saveConfig } from './config'
import { UsageStore } from './usage'
import { ChatManager, ChatIO } from './chat'
import { ClipboardStore, startClipboardWatch } from './clipboard'
import { listSaves, saveCommand, removeSave, distillDraft, type DraftMeta } from './saves'
import { listSessions } from './session'
import { realInside } from './pathGuard'
import { bootstrapFromGw, reconcileDefaultAlias } from './gwConfig'
import type { AgentMode, AppConfig, CommandMeta, Ctx, SessionEvent, SavedMeta } from '../shared/types'

// 测试隔离 seam：e2e 用 CTOOLS_USER_DATA 指向临时目录，默认零影响。
if (process.env['CTOOLS_USER_DATA']) app.setPath('userData', process.env['CTOOLS_USER_DATA'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等 gateway 就绪后，把默认别名校准到真实可用别名。 */
async function reconcileWhenReady(ctx: Ctx, gateway: GatewayManager): Promise<void> {
  for (let i = 0; i < 10 && (await gateway.status()) === 'stopped'; i++) await sleep(300)
  await reconcileDefaultAlias(ctx)
}

type WinKind = 'launcher' | 'chat' | 'settings'
const WINMETA: Record<WinKind, { hash: string; width: number; height: number; resizable: boolean }> = {
  launcher: { hash: '', width: 720, height: 440, resizable: false },
  chat: { hash: '/chat', width: 760, height: 640, resizable: true },
  settings: { hash: '/settings', width: 640, height: 560, resizable: true },
}

let launcherWin: BrowserWindow | null = null
let chatWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let quitting = false
app.on('before-quit', () => (quitting = true))

function makeWindow(kind: WinKind): BrowserWindow {
  const m = WINMETA[kind]
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const win = new BrowserWindow({
    width: m.width,
    height: m.height,
    minWidth: kind === 'launcher' ? undefined : 460,
    minHeight: kind === 'launcher' ? undefined : 360,
    frame: kind === 'launcher' ? false : true, // launcher 无边框悬浮；chat/settings 带框
    alwaysOnTop: kind === 'launcher',
    resizable: m.resizable,
    show: false,
    backgroundColor: '#1e1e28',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (m.hash) {
    if (devUrl) win.loadURL(devUrl + '#' + m.hash)
    else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: m.hash })
  } else if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.once('ready-to-show', () => win.show())
  if (kind === 'launcher' && !devUrl) {
    // 生产模式：Launcher 失焦即收起（悬浮层惯例）；开发模式保留便于调试
    win.on('blur', () => {
      if (launcherWin === win) win.hide()
    })
  }
  win.on('closed', () => {
    if (kind === 'launcher') {
      launcherWin = null
      return
    }
    if (kind === 'chat') chatWin = null
    else settingsWin = null
    if (!quitting) showLauncher() // 关闭对话/设置 → 回到 Launcher
  })
  return win
}

/** 显示 Launcher 并通知渲染层清空输入、重新聚焦（每次唤起即新查询）。 */
function showLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) launcherWin = makeWindow('launcher')
  launcherWin.show()
  launcherWin.focus()
  launcherWin.webContents.send('launcher:show')
}

/** 打开/聚焦对话窗，并让 Launcher 让位——否则 alwaysOnTop 悬浮层会一直盖住它。 */
function openChatWindow(): BrowserWindow {
  if (!chatWin || chatWin.isDestroyed()) chatWin = makeWindow('chat')
  launcherWin?.hide()
  chatWin.show()
  chatWin.focus()
  return chatWin
}

/** 打开/聚焦设置窗（同 Chat 模式）。 */
function openSettingsWindow(): BrowserWindow {
  if (!settingsWin || settingsWin.isDestroyed()) settingsWin = makeWindow('settings')
  launcherWin?.hide()
  settingsWin.show()
  settingsWin.focus()
  return settingsWin
}

// 人工在环确认桥：main 持 pending resolver，渲染层经 IPC 回批/拒。
// currentConfirm 存最新待批项，供晚挂载的渲染层主动拉取（避免事件丢失）。
let confirmSeq = 0
const pendingConfirms = new Map<number, (ok: boolean) => void>()
let currentConfirm: { id: number; tool: string; message: string } | null = null

function askConfirm(win: BrowserWindow, tool: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++confirmSeq
    currentConfirm = { id, tool, message }
    const timer = setTimeout(() => {
      pendingConfirms.delete(id)
      if (currentConfirm?.id === id) currentConfirm = null
      resolve(false) // 超时默认拒绝，避免挂死 agent 循环
    }, 120_000)
    pendingConfirms.set(id, (ok) => {
      clearTimeout(timer)
      pendingConfirms.delete(id)
      if (currentConfirm?.id === id) currentConfirm = null
      resolve(ok)
    })
    const send = () => {
      if (!win.isDestroyed()) win.webContents.send('tool:confirm', { id, tool, message })
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  })
}

/** 会话事件 / 流式增量 / 运行态 / 人工批准 → 指定 Chat 窗口。 */
const ioFor = (win: BrowserWindow): ChatIO => ({
  onEvent: (ev) => {
    if (!win.isDestroyed()) win.webContents.send('session:event', ev)
  },
  onDelta: (text) => {
    if (!win.isDestroyed()) win.webContents.send('session:delta', text)
  },
  onRunning: (running) => {
    if (!win.isDestroyed()) win.webContents.send('session:running', running)
  },
  onConfirm: (tool, message) => askConfirm(win, tool, message),
})

/** 注册/重绑全局热键（空串或非法则跳过；每次全量重注册）。 */
function bindHotkey(key: string) {
  try {
    globalShortcut.unregisterAll()
    if (!key) return
    globalShortcut.register(key, () => {
      if (launcherWin?.isVisible()) launcherWin.hide()
      else showLauncher()
    })
  } catch {
    /* 非法/被占用则忽略（仍可从启动窗口用） */
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const { registry, ctx } = createApp(userData)
  bootstrapFromGw(userData, ctx.config, (c) => saveConfig(userData, c))
  const gateway = new GatewayManager(ctx.config, userData)
  const usage = new UsageStore(userData)
  const sessionsDir = join(userData, 'sessions')
  const chat = new ChatManager(ctx, registry, sessionsDir)

  // 剪贴板历史：装配进 ctx 供 clipboard 命令，并常驻 watcher 轮询写入
  const clip = new ClipboardStore(join(userData, 'clipboard.jsonl'))
  ctx.clipboard = {
    recent: (n) => Promise.resolve(clip.recent(n)),
    candidates: (q, n) => Promise.resolve(clip.candidates(q, n)),
    current: async () => {
      const t = await electronClipboard.readText()
      clip.record(t) // 读到即记录，保证后续历史可用
      return t.trim()
    },
  }
  try {
    clip.record(await electronClipboard.readText()) // 启动即收录当前剪贴板
  } catch {
    /* ignore */
  }
  startClipboardWatch(clip, async () => electronClipboard.readText())

  /** config 更新统一出口：原地合并 + 持久化 + 命令启停/热键热生效。 */
  const applyConfig = (patch: Partial<AppConfig>): AppConfig => {
    Object.assign(ctx.config, patch)
    saveConfig(userData, ctx.config)
    registry.syncEnabled(ctx.config)
    if ('hotkey' in patch) bindHotkey(ctx.config.hotkey)
    return { ...ctx.config }
  }

  // 命令（先确保 gateway 别名已校准，避免 default_alias 不匹配）
  let reconciled = false
  const ensureReconciled = async (): Promise<void> => {
    if (reconciled) return
    reconciled = true
    await reconcileDefaultAlias(ctx) // 幂等; gateway 不可达则保留原配置
  }
  ipcMain.handle('commands:list', () => registry.list())
  ipcMain.handle('commands:all', () => registry.list(false))
  ipcMain.handle('commands:match', async (_e, input: string) => {
    await ensureReconciled()
    return registry.match(input)
  })
  ipcMain.handle('commands:recent', () =>
    usage.recent(8).map((id) => registry.metaFor(id)).filter((m): m is CommandMeta => !!m),
  )
  ipcMain.handle('commands:run', async (_e, id: string, input: string) => {
    await ensureReconciled()
    const r = await registry.run(id, input, ctx)
    usage.record(id)
    return r
  })
  // 两段 confirm：以放行 ctx 重放，写/删命令才真正执行
  ipcMain.handle('commands:confirm', async (_e, id: string, input: string) => {
    await ensureReconciled()
    const r = await registry.run(id, input, { ...ctx, confirmApproved: true })
    usage.record(id)
    return r
  })

  // 配置 / gateway / 系统
  ipcMain.handle('config:get', () => ({ ...ctx.config }))
  ipcMain.handle('config:update', (_e, patch: Partial<AppConfig>) => applyConfig(patch))
  ipcMain.handle('gateway:status', () => gateway.status())
  ipcMain.handle('gateway:models', () => ctx.gateway.models())
  ipcMain.handle('gateway:reload', () => gateway.reload())
  ipcMain.handle('gateway:restart', async () => {
    const s = await gateway.restart()
    if (s === 'running') await reconcileDefaultAlias(ctx)
    return s
  })
  ipcMain.handle('gateway:ensure', async () => {
    const s = await gateway.ensureStarted()
    if (s === 'running') await reconcileDefaultAlias(ctx)
    return s
  })
  ipcMain.handle('system:copy', (_e, text: string) => ctx.system.pbcopy(text))
  // 文件动作：file_roots 越界（含 symlink 逃逸）把关后交系统 open（-R = Finder 定位）。越界/失败返回 false。
  const openBySystem = async (reveal: boolean, target: string): Promise<boolean> => {
    const abs = await realInside(ctx.config.fileRoots, target)
    if (!abs) return false
    return new Promise((resolve) => {
      execFile('open', reveal ? ['-R', abs] : [abs], (err) => resolve(!err))
    })
  }
  ipcMain.handle('system:reveal', (_e, p: string) => openBySystem(true, p))
  ipcMain.handle('system:open', (_e, p: string) => openBySystem(false, p))
  ipcMain.handle('window:hide', () => launcherWin?.hide())
  ipcMain.handle('window:openSettings', () => openSettingsWindow())
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // Chat 会话（进入即让 Launcher 退场，错误由 ChatManager 落 agent.error 事件）
  ipcMain.handle('session:open', async (_e, first?: string) => {
    const win = openChatWindow()
    return chat.open(first, ioFor(win))
  })
  // 最近会话（Launcher 首页 chips）；attach/new 切活动会话 → 已开的 Chat 需 reset 重同步
  ipcMain.handle('session:recent', () => listSessions(sessionsDir, 5))
  ipcMain.handle('session:attach', async (_e, id: string) => {
    const existed = chatWin && !chatWin.isDestroyed()
    const prev = chat.sessionId()
    const r = await chat.attach(id)
    const win = openChatWindow()
    if (existed && prev !== r.id) win.webContents.send('session:reset')
    return r
  })
  ipcMain.handle('session:new', async () => {
    const existed = chatWin && !chatWin.isDestroyed()
    const prev = chat.sessionId()
    const r = await chat.fresh()
    const win = openChatWindow()
    if (existed && prev !== r.id) win.webContents.send('session:reset')
    return r
  })
  ipcMain.handle('session:send', (_e, text: string) => {
    const win = chatWin
    if (!win || win.isDestroyed()) throw new Error('对话窗口未打开')
    win.focus()
    return chat.run(text, ioFor(win))
  })
  ipcMain.handle('session:cancel', () => chat.cancel())
  ipcMain.handle('session:transcript', () => chat.transcript())
  ipcMain.handle('session:running', () => chat.isRunning())
  ipcMain.handle('session:pendingConfirm', () => currentConfirm)

  // plan 模式：模式读写 / 计划批准 / 重规划 / 放弃 / 待批准拉取（specs/plan-mode.md）
  const broadcastMode = () => {
    const m = chat.getMode()
    // 两窗同步：Chat 顶栏常驻 + Launcher 将进 agent 时按需显示同一开关
    for (const w of [chatWin, launcherWin]) if (w && !w.isDestroyed()) w.webContents.send('session:mode', m)
  }
  const chatWinIO = (): { io: ReturnType<typeof ioFor>; win: BrowserWindow } => {
    const win = chatWin
    if (!win || win.isDestroyed()) throw new Error('对话窗口未打开')
    win.focus()
    return { io: ioFor(win), win }
  }
  ipcMain.handle('session:mode', () => chat.getMode())
  ipcMain.handle('session:setMode', (_e, m: AgentMode) => {
    const next = chat.setMode(m)
    broadcastMode()
    return next
  })
  ipcMain.handle('session:executePlan', () => chat.executePlan(chatWinIO().io))
  ipcMain.handle('session:replan', (_e, feedback?: string) => chat.replan(chatWinIO().io, feedback))
  ipcMain.handle('session:discardPlan', () => chat.discardPlan(chatWinIO().io))
  ipcMain.handle('session:pendingPlan', () => chat.pendingPlanValue())
  // /save：LLM 蒸馏草稿 → 确认 → 保存
  ipcMain.handle('saves:list', (): SavedMeta[] =>
    listSaves(userData).map((s) => ({ id: s.id, title: s.title, instruction: s.instruction, paramHint: s.paramHint })),
  )
  ipcMain.handle('saves:draft', (_e, hint?: string, feedback?: string): Promise<DraftMeta> =>
    distillDraft(ctx, chat.transcript(), hint ?? '', feedback ?? ''),
  )
  ipcMain.handle('saves:save', (_e, d: DraftMeta): SavedMeta => {
    const s = saveCommand(userData, d)
    return { id: s.id, title: s.title, instruction: s.instruction, paramHint: s.paramHint }
  })
  ipcMain.handle('saves:remove', (_e, id: string) => removeSave(userData, id))
  ipcMain.handle('tool:confirm', (_e, id: number, ok: boolean) => {
    pendingConfirms.get(id)?.(!!ok)
  })

  launcherWin = makeWindow('launcher')
  bindHotkey(ctx.config.hotkey)
  app.on('will-quit', () => globalShortcut.unregisterAll())

  // 显式开启托管时才自动拉起 gateway（否则尊重外部进程）；别名随后校准
  void (async () => {
    if (ctx.config.managedGateway) await gateway.ensureStarted()
    await reconcileWhenReady(ctx, gateway)
  })()

  app.on('window-all-closed', () => app.quit())
})
