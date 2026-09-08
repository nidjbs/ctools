// 直接 / 规划 模式分段开关。绑定 Main 的 ChatManager.mode（唯一事实源），经 onSessionMode 跨窗同步。
import { useEffect, useState } from 'react'
import type { AgentMode } from '../../shared/types'

export default function ModeChip() {
  const [mode, setMode] = useState<AgentMode>('normal')
  useEffect(() => {
    if (!window.api) return
    void window.api.session.mode().then(setMode).catch(() => {})
    return window.api.onSessionMode(setMode)
  }, [])
  const toggle = (m: AgentMode) => {
    setMode(m) // 乐观更新；Main 广播为准
    void window.api.session.setMode(m).catch(() => {})
  }
  return (
    <div className="mode-chip" title="对话模式：直接=现状直跑；规划=先出计划、批准后才执行">
      <button className={mode === 'normal' ? 'sel' : ''} onClick={() => toggle('normal')}>
        直接
      </button>
      <button className={mode === 'plan' ? 'sel plan' : ''} onClick={() => toggle('plan')}>
        规划
      </button>
    </div>
  )
}
