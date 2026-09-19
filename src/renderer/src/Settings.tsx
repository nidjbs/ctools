// 设置窗（#/settings）：gateway 状态/托管、网络与别名、偏好、命令启停。
// 数据经类型化 IPC（config.get/update, commands.all, gateway.*）。specs/settings.md。
import { useEffect, useRef, useState } from 'react'
import type { AppConfig, CommandMeta, MemoryMeta } from '../../shared/types'
import { MODEL_SCENARIOS } from '../../shared/model'

export default function Settings() {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [cmds, setCmds] = useState<CommandMeta[]>([])
  const [mems, setMems] = useState<MemoryMeta[]>([])
  const [status, setStatus] = useState<'running' | 'stopped'>('stopped')
  const [models, setModels] = useState<string[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const loadedRef = useRef(false)

  async function refresh() {
    if (!window.api) return
    const [c, all, s] = await Promise.all([
      window.api.config.get(),
      window.api.commands.all(),
      window.api.gateway.status(),
    ])
    setCfg(c)
    setCmds(all)
    setStatus(s)
    setMems(await window.api.memory.list().catch(() => []))
    setModels(await window.api.gateway.models().catch(() => []))
  }

  useEffect(() => {
    if (!window.api) return
    if (!loadedRef.current) {
      loadedRef.current = true
      void refresh()
    }
    const off = window.api.onLauncherShow(() => void refresh())
    return off
  }, [])

  const set = (patch: Partial<AppConfig>) => setCfg((c) => (c ? { ...c, ...patch } : c))

  async function save() {
    if (!cfg || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const next = await window.api.config.update({
        gatewayUrl: cfg.gatewayUrl.trim(),
        adminUrl: cfg.adminUrl.trim(),
        adminToken: cfg.adminToken,
        defaultAlias: cfg.defaultAlias.trim(),
        commandModels: cfg.commandModels,
        clipboardLocalAlias: cfg.clipboardLocalAlias?.trim(),
        hotkey: cfg.hotkey.trim(),
        fileRoots: cfg.fileRoots.map((p) => p.trim()).filter(Boolean),
        writeConfirm: cfg.writeConfirm,
        managedGateway: cfg.managedGateway,
        webSearchEnabled: cfg.webSearchEnabled,
        bashNetwork: cfg.bashNetwork,
      })
      setCfg(next)
      // 开启托管 → 立即拉起（spec：开启即在本机启动）
      if (next.managedGateway) {
        const s = await window.api.gateway.ensure()
        setStatus(s)
        setMsg(
          s === 'running'
            ? { kind: 'ok', text: '已保存 ✓（gateway 已托管启动）' }
            : { kind: 'err', text: '已保存，但托管 gateway 未就绪' },
        )
      } else {
        setMsg({ kind: 'ok', text: '已保存 ✓' })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `保存失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  async function gateway(action: 'reload' | 'restart' | 'ensure') {
    setBusy(true)
    setMsg(null)
    try {
      if (action === 'reload') {
        const r = await window.api.gateway.reload()
        setMsg(r.ok ? { kind: 'ok', text: '已热更新 ✓' } : { kind: 'err', text: `热更新失败: ${r.error ?? ''}` })
      } else {
        const s = action === 'restart' ? await window.api.gateway.restart() : await window.api.gateway.ensure()
        setMsg(
          s === 'running'
            ? { kind: 'ok', text: 'gateway 运行中 ✓' }
            : { kind: 'err', text: 'gateway 未就绪（gw up 失败？）' },
        )
        setStatus(s)
      }
      setModels(await window.api.gateway.models().catch(() => []))
    } catch (e) {
      setMsg({ kind: 'err', text: `操作失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  async function removeMem(id: string) {
    await window.api.memory.remove(id).catch(() => {})
    setMems(await window.api.memory.list().catch(() => []))
  }

  async function pinMem(id: string, pinned: boolean) {
    await window.api.memory.pin(id, pinned).catch(() => {})
    setMems(await window.api.memory.list().catch(() => []))
  }

  async function toggleCmd(id: string, on: boolean) {
    if (!cfg || busy) return
    const prevCfg = cfg
    const prevCmds = cmds
    const enabledCommands = { ...(prevCfg.enabledCommands ?? {}), [id]: on }
    // 乐观更新：先即时反映，再落盘；失败回滚
    setCmds((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: on } : c)))
    setCfg((c) => (c ? { ...c, enabledCommands } : c))
    setMsg(null)
    setBusy(true)
    try {
      const next = await window.api.config.update({ enabledCommands })
      setCfg(next)
      setMsg({ kind: 'ok', text: `${id} 已${on ? '启用' : '禁用'}（Launcher/agent 即刻生效）` })
    } catch (e) {
      setCmds(prevCmds)
      setCfg((c) => (c ? { ...c, enabledCommands: prevCfg.enabledCommands } : c))
      setMsg({ kind: 'err', text: `切换失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  if (!cfg) return <div className="settings pad">加载中…</div>

  return (
    <div
      className="settings pad"
      onKeyDown={(e) => {
        if (e.key === 'Escape') void window.api.window.close() // 收起界面
      }}
    >
      <h1>设置</h1>
      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

      <section>
        <h2>Gateway</h2>
        <div className="row">
          <span className="lbl">状态</span>
          <span className={`dot ${status === 'running' ? 'on' : ''}`} />
          <span>{status === 'running' ? '运行中' : '已停止'}</span>
          <span className="gap" />
          <button disabled={busy} onClick={() => void gateway('reload')}>
            热更新
          </button>
          <button disabled={busy} onClick={() => void gateway('restart')}>
            重启
          </button>
          {status === 'stopped' && (
            <button disabled={busy} onClick={() => void gateway('ensure')}>
              立即托管启动
            </button>
          )}
        </div>
        <label className="row">
          <input
            type="checkbox"
            checked={!!cfg.managedGateway}
            onChange={(e) => set({ managedGateway: e.target.checked })}
          />
          <span>启动时自动托管 gateway（需 gw CLI）——开启保存后立即在本机拉起</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={!!cfg.webSearchEnabled}
            onChange={(e) => set({ webSearchEnabled: e.target.checked })}
          />
          <span>联网搜索（web_search）——开启后 agent 可搜索，每次调用仍会先请求你批准</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={!!cfg.bashNetwork}
            onChange={(e) => set({ bashNetwork: e.target.checked })}
          />
          <span>bash 联网——默认关（命令经 OS 沙箱禁网）；开启后 bash 可联网，执行仍每次人工确认</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={cfg.injectDate !== false}
            onChange={(e) => set({ injectDate: e.target.checked })}
          />
          <span>每轮注入当天日期——关掉可让 system 前缀完全稳定（省缓存），但模型需自行 bash date 才知道今天</span>
        </label>
      </section>

      <section>
        <h2>模型</h2>
        <datalist id="alias-list">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="grid">
          <label className="wide">
            默认模型别名
            <input
              className="bar"
              list="alias-list"
              value={cfg.defaultAlias}
              onChange={(e) => set({ defaultAlias: e.target.value })}
            />
            <span className="hint">未单独指定的场景都用它（agent 对话、上下文摘要、/save 蒸馏…）。</span>
          </label>
          {MODEL_SCENARIOS.map((s) => (
            <label key={s.id}>
              {s.label}
              <input
                className="bar"
                list="alias-list"
                placeholder={`留空 = 用默认（${cfg.defaultAlias || '未设置'}）`}
                value={cfg.commandModels?.[s.id] ?? ''}
                onChange={(e) => set({ commandModels: { ...(cfg.commandModels ?? {}), [s.id]: e.target.value } })}
              />
              <span className="hint">{s.hint}</span>
            </label>
          ))}
          <label>
            剪贴板召回模型（本地）
            <input
              className="bar"
              list="alias-list"
              placeholder="留空 = 用默认模型（不推荐）"
              value={cfg.clipboardLocalAlias ?? ''}
              onChange={(e) => set({ clipboardLocalAlias: e.target.value })}
            />
            <span className="hint">剪贴板语义召回只走本地模型别名（隐私），留空则退回默认/远端。</span>
          </label>
        </div>
      </section>

      <section>
        <h2>连接（高级）</h2>
        <details className="adv">
          <summary>默认 127.0.0.1:8080 / 8081 —— 通常无需修改</summary>
          <div className="grid">
            <label>
              gateway URL
              <input className="bar" value={cfg.gatewayUrl} onChange={(e) => set({ gatewayUrl: e.target.value })} />
            </label>
            <label>
              admin URL
              <input className="bar" value={cfg.adminUrl} onChange={(e) => set({ adminUrl: e.target.value })} />
            </label>
            <label>
              admin token
              <input
                className="bar"
                type="password"
                value={cfg.adminToken ?? ''}
                onChange={(e) => set({ adminToken: e.target.value })}
              />
            </label>
          </div>
          <p className="hint">
            这是本地网关的固定入口。改动前请确认目标确实在运行——填错会导致命令与对话全部不可用，且不易自查。
          </p>
        </details>
      </section>

      <section>
        <h2>偏好</h2>
        <div className="grid">
          <label>
            全局热键
            <input className="bar" placeholder="CommandOrControl+Shift+Space" value={cfg.hotkey} onChange={(e) => set({ hotkey: e.target.value })} />
          </label>
          <label>
            写确认模式
            <select className="bar" value={cfg.writeConfirm} onChange={(e) => set({ writeConfirm: e.target.value as AppConfig['writeConfirm'] })}>
              <option value="auto">auto（按危险度自动确认）</option>
              <option value="always">always（写操作总是确认）</option>
              <option value="never">never（不确认）</option>
            </select>
          </label>
          <label className="wide">
            file_roots（每行一个路径）
            <textarea className="bar area" value={cfg.fileRoots.join('\n')} onChange={(e) => set({ fileRoots: e.target.value.split('\n') })} />
          </label>
        </div>
      </section>

      <section>
        <h2>记忆</h2>
        <p className="hint">
          agent 在对话里「记住…」的内容。索引常驻注入模型；正文仅在 agent 主动 recall 时进入。
          <strong>「常驻」会把正文每轮都发给当前模型（可能为远端）——请只对不敏感内容开启。</strong>
        </p>
        {mems.length === 0 ? (
          <div className="dim">（还没有记忆）</div>
        ) : (
          <ul className="mems">
            {mems.map((m) => (
              <li key={m.id}>
                <input
                  type="checkbox"
                  checked={!!m.pinned}
                  title="常驻注入（每轮发给模型）"
                  onChange={(e) => void pinMem(m.id, e.target.checked)}
                />
                <span className="mem-main">
                  <span className="m-title">
                    {m.pinned ? '⭐ ' : ''}
                    {m.title}
                    {m.kind && <span className="tag">{m.kind}</span>}
                  </span>
                  <span className="mem-gist">{m.gist}</span>
                </span>
                <button className="mem-del" title="删除这条记忆" onClick={() => void removeMem(m.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>命令（启停即刻生效）</h2>
        <ul className="cmds">
          {cmds.map((c) => (
            <li key={c.id}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => void toggleCmd(c.id, e.target.checked)} />
              <span className="m-id">{c.id}</span>
              <span className="m-title">{c.title}</span>
              {c.agentTool && <span className="tag">agent 工具</span>}
            </li>
          ))}
        </ul>
      </section>

      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        {busy && <span className="dim">处理中…</span>}
      </div>
    </div>
  )
}
