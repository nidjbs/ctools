// Electron Main 入口：窗口 + IPC + gateway 自拉起。逻辑都在 runtime 模块，这里只做装配。
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { createApp } from './app'
import { GatewayManager } from './gatewayManager'
import { saveConfig } from './config'
import type { AppConfig } from '../shared/types'

function createLauncherWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 440,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // electron-vite dev 走 http; build 走文件
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => win.show())
  return win
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const { registry, ctx } = createApp(userData)
  const gateway = new GatewayManager(ctx.config, userData)

  // ---- 类型化 IPC（与 shared/types 的 CtoolsApi 对齐） ----
  ipcMain.handle('commands:list', () => registry.list())
  ipcMain.handle('commands:match', (_e, input: string) => registry.match(input))
  ipcMain.handle('commands:run', (_e, id: string, input: string) => registry.run(id, input, ctx))
  ipcMain.handle('config:get', () => ctx.config)
  // MVP: 配置持久化后重启生效（Settings 接入时再支持运行时热重建 runtime）
  ipcMain.handle('config:update', (_e, patch: Partial<AppConfig>) => {
    const merged = { ...ctx.config, ...patch }
    saveConfig(userData, merged)
    return merged
  })
  ipcMain.handle('gateway:status', () => gateway.status())
  ipcMain.handle('system:copy', (_e, text: string) => ctx.system.pbcopy(text))

  createLauncherWindow()

  // 启动自动拉起 gateway（MVP: binary 由 GW_GATEWAY_BIN 提供; 受管配置路径待 Settings 完善）
  const bin = process.env['GW_GATEWAY_BIN']
  if (bin) void gateway.ensureStarted(bin)

  app.on('window-all-closed', () => app.quit())
})
