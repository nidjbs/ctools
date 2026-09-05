// Gateway 生命周期：探测 / gw up 拉起 / down / reload / restart（依赖注入，不发真实子进程）。
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GatewayManager, ExecResult } from '../src/main/gatewayManager'
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

function makeMgr(opts: {
  upOk?: boolean
  exec?: (f: string, a: string[]) => Promise<ExecResult>
  calls?: string[][]
  postCalls?: Array<{ url: string; token: string }>
}) {
  const calls = opts.calls ?? []
  const postCalls = opts.postCalls ?? []
  let running = false
  const exec =
    opts.exec ??
    (async (f, a) => {
      calls.push(a)
      if (a[0] === 'up') running = opts.upOk ?? true
      return { code: a[0] === 'up' && !(opts.upOk ?? true) ? 1 : 0, out: '', err: '' }
    })
  const probe = async () => running
  const post = async (url: string, token: string) => {
    postCalls.push({ url, token })
    return url.includes('fail') ? { ok: false, body: 'boom' } : { ok: true, body: '{"status":"reloaded"}' }
  }
  return { mgr: new GatewayManager(cfg, '/tmp/state', { exec, probe, post }), calls, postCalls }
}

describe('GatewayManager', () => {
  it('status 反映 readyz 探测', async () => {
    const { mgr } = makeMgr({})
    expect(await mgr.status()).toBe('stopped')
  })

  it('ensureStarted：running 时不调 gw', async () => {
    const calls: string[][] = []
    const exec = async (f: string, a: string[]) => {
      calls.push(a)
      return { code: 0, out: '', err: '' }
    }
    const probe = async () => true
    const mgr = new GatewayManager(cfg, '/tmp', { exec, probe, post: async () => ({ ok: true, body: '' }) })
    expect(await mgr.ensureStarted()).toBe('running')
    expect(calls).toEqual([])
  })

  it('ensureStarted：stopped 时执行 `gw up <config>` 并等待 ready', async () => {
    const { mgr, calls } = makeMgr({})
    expect(await mgr.ensureStarted()).toBe('running')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('up')
    expect(calls[0][1]).toBe(join(homedir(), 'gw.yaml'))
  })

  it('ensureStarted：gw up 失败 → stopped + lastError', async () => {
    const { mgr } = makeMgr({ upOk: false })
    expect(await mgr.ensureStarted()).toBe('stopped')
    expect(mgr.lastError()).toContain('gw up')
  })

  it('down 执行 `gw down`', async () => {
    const { mgr, calls } = makeMgr({})
    await mgr.down()
    expect(calls.at(-1)?.[0]).toBe('down')
  })

  it('reload：POST {adminUrl}/admin/reload + Bearer token', async () => {
    const { mgr, postCalls } = makeMgr({})
    const r = await mgr.reload()
    expect(r.ok).toBe(true)
    expect(postCalls[0].url).toBe('http://127.0.0.1:8081/admin/reload')
    expect(postCalls[0].token).toBe('tok-1')
  })

  it('reload 失败返回 error 并记录 lastError', async () => {
    const mgr = new GatewayManager(cfg, '/tmp', {
      exec: async () => ({ code: 0, out: '', err: '' }),
      probe: async () => false,
      post: async () => ({ ok: false, body: 'unauthorized' }),
    })
    const rr = await mgr.reload()
    expect(rr).toEqual({ ok: false, error: 'unauthorized' })
    expect(mgr.lastError()).toBe('unauthorized')
  })

  it('restart = down 后 ensureStarted(up)', async () => {
    const { mgr, calls } = makeMgr({})
    await mgr.restart()
    expect(calls.map((c) => c[0])).toEqual(['down', 'up'])
  })
})
