// 设置窗（#/settings）：gateway 状态/托管、网络与别名、偏好、命令启停。
// 数据经类型化 IPC（config.get/update, commands.all, gateway.*）。specs/settings.md。
import { useEffect, useRef, useState } from 'react'
import type { AppConfig, CommandMeta, GwConfigView, MemoryMeta } from '../../shared/types'
import { MODEL_SCENARIOS } from '../../shared/model'

/**
 * 首启向导（specs/first-run.md）：仅在零上游时出现 —— 此时 gateway 起不来，用户需要「一步配好」。
 * 优先一键用本机 Ollama（不需要任何密钥），否则手填一个上游。
 */
function FirstRunGuide({ onDone }: { onDone: () => void }) {
  const [probe, setProbe] = useState<{ ok: boolean; baseUrl: string; models: string[]; error?: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [manual, setManual] = useState({ name: 'my', baseUrl: '', apiKeyEnv: '', model: '', alias: 'chat' })

  async function detect() {
    setProbing(true)
    setMsg(null)
    try {
      const r = await window.api.gateway.probeOllama()
      setProbe(r)
      setModel(r.models[0] ?? '')
      if (!r.ok) setMsg({ kind: 'err', text: `未检测到本机 Ollama（${r.error ?? '不可达'}）——可在下方手动配置上游` })
    } finally {
      setProbing(false)
    }
  }

  /** 写入一个上游 + 一个别名，并把默认别名指过去；网关未运行时会被一并拉起。 */
  async function apply(provider: { name: string; baseUrl: string; apiKeyEnv?: string }, model: string, alias: string) {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.api.gateway.configSave(
        {
          providers: {
            [provider.name]: {
              type: 'openai',
              base_url: provider.baseUrl,
              ...(provider.apiKeyEnv ? { api_key_env: provider.apiKeyEnv } : {}),
            },
          },
          aliases: { [alias]: { provider: provider.name, model } },
        },
        'reload',
      )
      if (!r.ok) setMsg({ kind: 'err', text: r.error ?? '保存失败' })
      else if (r.applied) {
        await window.api.config.update({ defaultAlias: alias })
        setMsg({ kind: 'ok', text: `已配置并启动 ✓（默认模型别名 = ${alias}）` })
        // 延迟收起：立刻 onDone() 会让本组件卸载，用户根本看不到上面的确认
        setTimeout(onDone, 2500)
      } else setMsg({ kind: 'err', text: `已写入配置，但网关未起来：${r.applyError ?? ''}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="firstrun">
      <h2>快速开始</h2>
      <p className="hint">
        还没有任何模型上游，<b>网关无法启动</b>。配一个即可开始使用。
      </p>

      <h3 className="sub">① 用本机 Ollama（推荐，无需密钥）</h3>
      <div className="row">
        <button disabled={probing || busy} onClick={() => void detect()}>
          {probing ? '检测中…' : '检测本机 Ollama'}
        </button>
        {probe?.ok && probe.models.length > 0 && (
          <>
            <select className="bar" value={model} onChange={(e) => setModel(e.target.value)}>
              {probe.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={busy || !model}
              onClick={() => void apply({ name: 'ollama', baseUrl: `${probe.baseUrl}/v1` }, model, 'chat')}
            >
              使用它
            </button>
          </>
        )}
        {probe?.ok && probe.models.length === 0 && <span className="dim">Ollama 可达，但没有已安装的模型</span>}
      </div>

      <h3 className="sub">② 或者手动配置一个上游</h3>
      <div className="grid">
        <label>
          上游名
          <input className="bar" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
        </label>
        <label className="wide">
          base_url
          <input
            className="bar"
            placeholder="https://api.example.com/v1"
            value={manual.baseUrl}
            onChange={(e) => setManual({ ...manual, baseUrl: e.target.value })}
          />
        </label>
        <label>
          模型名
          <input className="bar" value={manual.model} onChange={(e) => setManual({ ...manual, model: e.target.value })} />
        </label>
        <label>
          别名
          <input className="bar" value={manual.alias} onChange={(e) => setManual({ ...manual, alias: e.target.value })} />
        </label>
        <label className="wide">
          api_key_env（环境变量名，可留空）
          <input
            className="bar"
            placeholder="OPENAI_API_KEY"
            value={manual.apiKeyEnv}
            onChange={(e) => setManual({ ...manual, apiKeyEnv: e.target.value })}
          />
          {/* 这个坑必须写在输入框旁：gateway 从「自己的环境」读该变量 */}
          <span className="hint">
            注意：gateway 读的是<b>它自己进程</b>的环境变量，而从程序坞/访达启动的 app <b>不会加载 ~/.zshrc</b>。
            从终端启动可见；否则需 <code>launchctl setenv {manual.apiKeyEnv || 'VAR'} 你的密钥</code>。本机 Ollama 不需要密钥。
          </span>
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !manual.baseUrl.trim() || !manual.model.trim() || !manual.name.trim() || !manual.alias.trim()}
          onClick={() =>
            void apply(
              { name: manual.name.trim(), baseUrl: manual.baseUrl.trim(), apiKeyEnv: manual.apiKeyEnv.trim() },
              manual.model.trim(),
              manual.alias.trim(),
            )
          }
        >
          配置并启动
        </button>
        {busy && <span className="dim">处理中…</span>}
      </div>
      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
    </section>
  )
}

/** providers / aliases 编辑区（specs/gateway-config.md）。 */
function GwConfigSection() {
  const [gw, setGw] = useState<GwConfigView | null>(null)
  const [providers, setProviders] = useState<Record<string, import('../../shared/types').GwProvider>>({})
  const [aliases, setAliases] = useState<Record<string, import('../../shared/types').GwAlias>>({})
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!window.api) return
    const v = await window.api.gateway.config().catch(() => null)
    setGw(v)
    if (v) {
      setProviders(v.providers)
      setAliases(v.aliases)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (apply: 'reload' | 'restart') => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.api.gateway.configSave({ providers, aliases }, apply)
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error ?? '保存失败' })
      } else if (r.applied) {
        setMsg({ kind: 'ok', text: `已保存并${apply === 'reload' ? '热更' : '重启'} ✓` })
      } else {
        // 配置已落盘但未生效：必须说清楚，否则用户会以为「没生效=没保存」
        setMsg({ kind: 'err', text: `已保存到文件，但${apply === 'reload' ? '热更' : '重启'}失败：${r.applyError ?? ''}` })
      }
      await load()
    } catch (e) {
      setMsg({ kind: 'err', text: `保存失败: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  const patchProvider = (name: string, patch: Partial<import('../../shared/types').GwProvider>) =>
    setProviders((p) => ({ ...p, [name]: { ...p[name], ...patch } }))
  const renameProvider = (from: string, to: string) => {
    if (from === to || !to.trim()) return
    setProviders((p) => {
      const next: typeof p = {}
      for (const [k, v] of Object.entries(p)) next[k === from ? to : k] = v
      return next
    })
    // 别名对上游的引用跟着改名，避免出现悬空引用
    setAliases((a) => {
      const next = { ...a }
      for (const k of Object.keys(next)) if (next[k].provider === from) next[k] = { ...next[k], provider: to }
      return next
    })
  }

  if (!gw) return null
  const disabled = busy || !!gw.error

  return (
    <section>
      <h2>网关配置</h2>
      <p className="hint">
        直接编辑网关的<b>上游 providers</b> 与 <b>模型别名 aliases</b>（<code>{gw.path}</code>）。
        保存时自动备份原文件；<code>api_key_env</code> 只填<b>环境变量名</b>，cTools 不存储亦不回显真实密钥。
      </p>
      {gw.error && <div className="notice err">{gw.error}</div>}

      <h3 className="sub">上游 providers</h3>
      <ul className="gw-list">
        {Object.entries(providers).map(([name, p]) => (
          <li key={name}>
            <input className="bar gw-name" value={name} disabled={disabled} onChange={(e) => renameProvider(name, e.target.value)} />
            <input
              className="bar"
              value={p.type}
              disabled={disabled}
              placeholder="type"
              onChange={(e) => patchProvider(name, { type: e.target.value })}
            />
            <input
              className="bar gw-wide"
              value={p.base_url}
              disabled={disabled}
              placeholder="base_url"
              onChange={(e) => patchProvider(name, { base_url: e.target.value })}
            />
            <input
              className="bar"
              value={p.request_timeout ?? ''}
              disabled={disabled}
              placeholder="60s"
              title="request_timeout"
              onChange={(e) => patchProvider(name, { request_timeout: e.target.value })}
            />
            <input
              className="bar"
              value={p.api_key_env ?? ''}
              disabled={disabled}
              placeholder="API_KEY_ENV"
              title="api_key_env（环境变量名）"
              onChange={(e) => patchProvider(name, { api_key_env: e.target.value })}
            />
            <button
              className="mem-del"
              disabled={disabled}
              title="删除该上游"
              onClick={() =>
                setProviders((prev) => {
                  const next = { ...prev }
                  delete next[name]
                  return next
                })
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button disabled={disabled} onClick={() => setProviders((p) => ({ ...p, [`provider${Object.keys(p).length + 1}`]: { type: 'openai', base_url: '' } }))}>
        ＋ 添加上游
      </button>

      <h3 className="sub">模型别名 aliases</h3>
      <ul className="gw-list">
        {Object.entries(aliases).map(([alias, a]) => (
          <li key={alias}>
            <input
              className="bar gw-name"
              value={alias}
              disabled={disabled}
              onChange={(e) => {
                const to = e.target.value
                if (!to.trim()) return
                setAliases((prev) => {
                  const next: typeof prev = {}
                  for (const [k, v] of Object.entries(prev)) next[k === alias ? to : k] = v
                  return next
                })
              }}
            />
            <select
              className="bar"
              value={a.provider}
              disabled={disabled}
              onChange={(e) => setAliases((p) => ({ ...p, [alias]: { ...p[alias], provider: e.target.value } }))}
            >
              <option value="">（选上游）</option>
              {Object.keys(providers).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              className="bar gw-wide"
              value={a.model}
              disabled={disabled}
              placeholder="model"
              onChange={(e) => setAliases((p) => ({ ...p, [alias]: { ...p[alias], model: e.target.value } }))}
            />
            <button
              className="mem-del"
              disabled={disabled}
              title="删除该别名"
              onClick={() =>
                setAliases((prev) => {
                  const next = { ...prev }
                  delete next[alias]
                  return next
                })
              }
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button disabled={disabled} onClick={() => setAliases((a) => ({ ...a, [`alias${Object.keys(a).length + 1}`]: { provider: '', model: '' } }))}>
        ＋ 添加别名
      </button>

      <div className="row">
        <button className="primary" disabled={disabled} onClick={() => void save('reload')}>
          保存并热更
        </button>
        <button disabled={disabled} onClick={() => void save('restart')}>
          保存并重启
        </button>
        <button disabled={busy} onClick={() => void load()}>
          重新读取
        </button>
        {busy && <span className="dim">处理中…</span>}
      </div>
      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}
    </section>
  )
}

export default function Settings() {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [cmds, setCmds] = useState<CommandMeta[]>([])
  const [mems, setMems] = useState<MemoryMeta[]>([])
  const [gwEmpty, setGwEmpty] = useState(false) // 零上游 → 显示首启向导（specs/first-run.md）
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
    const gw = await window.api.gateway.config().catch(() => null)
    setGwEmpty(!!gw && Object.keys(gw.providers).length === 0)
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

      {gwEmpty && <FirstRunGuide onDone={() => void refresh()} />}
      <GwConfigSection />

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
