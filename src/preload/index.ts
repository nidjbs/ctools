// contextBridge：向渲染进程暴露类型化 api（契约见 shared/types CtoolsApi）。
import { contextBridge, ipcRenderer } from 'electron'
import type { AgentMode, CtoolsApi, SessionEvent } from '../shared/types'

function handle<T>(channel: string): (...args: unknown[]) => Promise<T>
function handle<T>(channel: string, map: (...a: unknown[]) => unknown): (...args: unknown[]) => Promise<T>
function handle<T>(channel: string, map?: (...a: unknown[]) => unknown) {
  return async (...args: unknown[]): Promise<T> => {
    const out = (await ipcRenderer.invoke(channel, ...args)) as T
    return map ? (map(out) as T) : out
  }
}

const api: CtoolsApi = {
  commands: {
    list: handle('commands:list'),
    all: handle('commands:all'),
    match: handle('commands:match'),
    recent: handle('commands:recent'),
    run: handle('commands:run'),
    confirm: handle('commands:confirm'),
  },
  config: {
    get: handle('config:get'),
    update: handle('config:update'),
  },
  gateway: {
    status: handle('gateway:status'),
    models: handle('gateway:models'),
    reload: handle('gateway:reload'),
    restart: handle('gateway:restart'),
    ensure: handle('gateway:ensure'),
  },
  window: {
    hide: handle('window:hide'),
    openSettings: handle('window:openSettings'),
    close: handle('window:close'),
  },
  system: {
    pbcopy: handle('system:copy'),
  },
  session: {
    open: handle('session:open'),
    send: handle('session:send'),
    cancel: handle('session:cancel'),
    transcript: handle('session:transcript'),
    running: handle('session:running'),
    confirm: handle('tool:confirm'),
    pendingConfirm: handle('session:pendingConfirm'),
    mode: handle('session:mode'),
    setMode: handle('session:setMode'),
    executePlan: handle('session:executePlan'),
    replan: handle('session:replan'),
    discardPlan: handle('session:discardPlan'),
    pendingPlan: handle('session:pendingPlan'),
  },
  saves: {
    list: handle('saves:list'),
    draft: handle('saves:draft'),
    save: handle('saves:save'),
  },
  onSessionEvent: (cb) => {
    const listener = (_e: unknown, ev: SessionEvent) => cb(ev)
    ipcRenderer.on('session:event', listener)
    return () => ipcRenderer.removeListener('session:event', listener)
  },
  onSessionDelta: (cb) => {
    const listener = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on('session:delta', listener)
    return () => ipcRenderer.removeListener('session:delta', listener)
  },
  onSessionRunning: (cb) => {
    const listener = (_e: unknown, running: boolean) => cb(running)
    ipcRenderer.on('session:running', listener)
    return () => ipcRenderer.removeListener('session:running', listener)
  },
  onToolConfirm: (cb) => {
    const listener = (_e: unknown, req: { id: number; tool: string; message: string }) => cb(req)
    ipcRenderer.on('tool:confirm', listener)
    return () => ipcRenderer.removeListener('tool:confirm', listener)
  },
  onLauncherShow: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('launcher:show', listener)
    return () => ipcRenderer.removeListener('launcher:show', listener)
  },
  onSessionMode: (cb) => {
    const listener = (_e: unknown, m: AgentMode) => cb(m)
    ipcRenderer.on('session:mode', listener)
    return () => ipcRenderer.removeListener('session:mode', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)
