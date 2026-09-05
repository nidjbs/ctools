// 会话持久化 / resume：JSONL 重放重建 + 最近会话扫描 + 续聊续写。
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, latestSessionId } from '../src/main/session'
import { seedSystem } from '../src/main/agent'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctools-resume-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function emit(s: Session, type: 'user.message' | 'assistant.message' | 'system.context', content: string) {
  s.append(type, {
    role: type === 'system.context' ? 'system' : type.split('.')[0],
    content,
  })
}

describe('session 持久化 / resume', () => {
  it('fromJSONL 重建与追加前一致，seq 续接', () => {
    const id = 'abc'
    const s1 = new Session(dir, id)
    seedSystem(s1, '你是助手')
    emit(s1, 'user.message', 'hi')
    emit(s1, 'assistant.message', 'hello')
    const before = s1.transcript()

    const s2 = Session.fromJSONL(dir, id)
    expect(s2.transcript()).toEqual(before)
    expect(s2.messages()).toEqual(s1.messages())

    // 续聊：新事件 seq 继续递增，且与旧文件同源追加
    emit(s2, 'user.message', 'again')
    const evs = s2.transcript()
    expect(evs.at(-1)?.seq).toBe(before.length + 1)
    const onDisk = readFileSync(join(dir, `${id}.jsonl`), 'utf-8')
    expect(onDisk.trim().split('\n')).toHaveLength(before.length + 1)
  })

  it('latestSessionId 返回最近写入的会话', () => {
    const idA = 'aaa'
    const idB = 'bbb'
    const a = new Session(dir, idA)
    emit(a, 'user.message', 'x')
    const b = new Session(dir, idB)
    emit(b, 'user.message', 'y') // 后写入 → mtime 更新
    expect(latestSessionId(dir)).toBe(idB)
  })
})
