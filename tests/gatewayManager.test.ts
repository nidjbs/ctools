// Gateway 生命周期（specs/gateway-config.md）：直接 spawn 内嵌 gateway，不再经 gw CLI。
// 依赖注入（spawn/kill/probe/post），不发真实子进程。
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayManager, type GatewayRuntime } from '../src/main/gatewayManager'
import { ADMIN_TOKEN_ENV } from '../src/main/gatewayHome'
import type { AppConfig } from '../src/shared/types'

const cfg: AppConfig = {
  gatewayUrl: 'http://127.0.0.1:8080',
  adminUrl: 'http://127.0.0.1:8081',
  adminToken: 'tok-1',
  defaultAlias: 'chat',
  fileRoots: [],
  writeConfirm: 'auto',
  hotkey: 'x',
  enabledCommands: {},
}

let dir: string
let bin: string
let rt: GatewayRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-gwmgr-'))
  bin = join(dir, 'gateway')
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  rt = { bin, cfgFile: join(dir, 'gateway.yaml'), adminToken: 'tok-1' }
  // gateway 硬要求至少一个上游；夹具给一个，否则会在前置守卫处短路
  writeFileSync(rt.cfgFile, 'providers:\n  ds:\n    type: openai\n    base_url: http://x\naliases: {}\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function makeMgr(opts: { ready?: boolean; spawnThrows?: boolean } = {}) {
  const spawned: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const killed: number[] = []
  const postCalls: Array<{ url: string; token: string }> = []
  let running = false
  const mgr = new GatewayManager(cfg, dir, rt, {
    spawn: (b, args, env) => {
      if (opts.spawnThrows) throw new Error('EACCES')
      spawned.push({ bin: b, args, env })
      running = opts.ready ?? true
      return { pid: 4242 }
    },
    kill: (pid) => {
      killed.push(pid)
      running = false
    },
    probe: async () => running,
    post: async (url, token) => {
      postCalls.push({ url, token })
      return url.includes('fail') ? { ok: false, body: 'boom' } : { ok: true, body: '{"status":"reloaded"}' }
    },
    readyTimeoutMs: 300,
  })
  return { mgr, spawned, killed, postCalls }
}

describe('GatewayManager', () => {
  it('status 反映 readyz 探测', async () => {
    expect(await makeMgr().mgr.status()).toBe('stopped')
  })

  it('ensureStarted：已在运行则不 spawn', async () => {
    const { mgr, spawned } = makeMgr({})
    await mgr.ensureStarted() // 首次拉起
    spawned.length = 0
    expect(await mgr.ensureStarted()).toBe('running')
    expect(spawned).toEqual([])
  })

  it('ensureStarted：spawn 内嵌二进制 -config <自持配置>，token 只经环境变量', async () => {
    const { mgr, spawned } = makeMgr({})
    expect(await mgr.ensureStarted()).toBe('running')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].bin).toBe(bin)
    expect(spawned[0].args).toEqual(['-config', rt.cfgFile])
    expect(spawned[0].env[ADMIN_TOKEN_ENV]).toBe('tok-1')
  })

  it('pid 落盘，供后续 down 使用', async () => {
    const { mgr } = makeMgr({})
    await mgr.ensureStarted()
    expect(readFileSync(join(dir, 'gateway.pid'), 'utf-8')).toBe('4242')
  })

  it('二进制缺失 → stopped + 可读原因（不抛）', async () => {
    const { mgr } = makeMgr({})
    rmSync(bin)
    expect(await mgr.ensureStarted()).toBe('stopped')
    expect(mgr.lastError()).toContain('未找到 gateway 二进制')
  })

  it('spawn 抛错 → stopped + 记录原因', async () => {
    const { mgr } = makeMgr({ spawnThrows: true })
    expect(await mgr.ensureStarted()).toBe('stopped')
    expect(mgr.lastError()).toContain('启动 gateway 失败')
  })

  it('启动后未在超时内就绪 → stopped + 记录原因', async () => {
    const { mgr } = makeMgr({ ready: false })
    expect(await mgr.ensureStarted()).toBe('stopped')
    expect(mgr.lastError()).toContain('未在超时内就绪')
  })

  it('down：按记录的 pid 结束进程并清理 pid 文件', async () => {
    const { mgr, killed } = makeMgr({})
    await mgr.ensureStarted()
    await mgr.down()
    expect(killed).toEqual([4242])
    expect(existsSync(join(dir, 'gateway.pid'))).toBe(false)
  })

  it('down：未运行过也安全（无 pid 文件）', async () => {
    const { mgr, killed } = makeMgr({})
    await mgr.down()
    expect(killed).toEqual([])
  })

  it('reload：POST {adminUrl}/admin/reload + Bearer token', async () => {
    const { mgr, postCalls } = makeMgr({})
    const r = await mgr.reload()
    expect(r.ok).toBe(true)
    expect(postCalls[0].url).toBe('http://127.0.0.1:8081/admin/reload')
    expect(postCalls[0].token).toBe('tok-1')
  })

  it('reload 失败返回 error 并记录 lastError', async () => {
    const mgr = new GatewayManager(cfg, dir, { ...rt, adminToken: 'x' }, {
      spawn: () => ({ pid: 1 }),
      kill: () => {},
      probe: async () => false,
      post: async () => ({ ok: false, body: 'unauthorized' }),
      readyTimeoutMs: 100,
    })
    expect(await mgr.reload()).toEqual({ ok: false, error: 'unauthorized' })
    expect(mgr.lastError()).toBe('unauthorized')
  })

  it('restart = down（杀旧 pid）后重新 spawn', async () => {
    const { mgr, killed, spawned } = makeMgr({})
    await mgr.ensureStarted()
    spawned.length = 0
    await mgr.restart()
    expect(killed).toEqual([4242])
    expect(spawned).toHaveLength(1)
  })

  it('gwConfigFile 指向 cTools 自持的配置（配置编辑区用它）', () => {
    expect(makeMgr().mgr.gwConfigFile()).toBe(rt.cfgFile)
  })

  it('零上游 → 不 spawn，给出可操作原因（gateway 硬要求至少一个 provider）', async () => {
    writeFileSync(rt.cfgFile, 'providers: {}\naliases: {}\n')
    const { mgr, spawned } = makeMgr({})
    expect(await mgr.ensureStarted()).toBe('stopped')
    expect(spawned).toEqual([]) // 提前拦住，不去等超时
    expect(mgr.lastError()).toContain('尚未配置模型上游')
    expect(mgr.lastError()).toContain('设置')
  })
})
