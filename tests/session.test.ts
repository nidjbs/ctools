import { describe, expect, it } from 'vitest'
import { Session } from '../src/main/session'

describe('session', () => {
  it('append 后 messages 投影 surface(只取带 role 的, 审计事件排除)', () => {
    const s = new Session()
    s.append('system.context', { role: 'system', content: 'sys' })
    s.append('user.message', { role: 'user', content: 'hi' })
    s.append('model.request', {}) // 审计, 无 role
    const msgs = s.messages()
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user'])
    expect(msgs[1].content).toBe('hi')
  })

  it('seq 递增, 事件入 transcript', () => {
    const s = new Session()
    s.append('user.message', { role: 'user', content: 'a' })
    s.append('assistant.message', { role: 'assistant', content: 'b' })
    const ev = s.transcript()
    expect(ev.map((e) => e.seq)).toEqual([1, 2])
    expect(ev[0].session_id).toBe(s.id)
  })
})
