// contextBridge：向渲染进程暴露类型化 api（契约见 shared/types CtoolsApi）。
import { contextBridge, ipcRenderer } from 'electron'
import type { CtoolsApi } from '../shared/types'

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
    match: handle('commands:match'),
    run: handle('commands:run'),
  },
  config: {
    get: handle('config:get'),
    update: handle('config:update'),
  },
  gateway: {
    status: handle('gateway:status'),
  },
  system: {
    pbcopy: handle('system:copy'),
  },
}

contextBridge.exposeInMainWorld('api', api)
