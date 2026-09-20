// 会话持久化 / resume：JSONL 重放重建 + 最近会话扫描 + 续聊续写。
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, latestSessionId, listSessions, titleOf } from '../src/main/session'
import { seedSystem } from '../src/main/agent'
import type { SessionEvent } from '../src/shared/types'

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

const ev = (content?: string, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ event_id: 'x', session_id: 's', seq: 1, type: 'user.message', occurred_at: '', content, ...extra }) as SessionEvent

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

  it('listSessions 按 mtime 降序 + title 取首条 user.message', () => {
    const newer = 'n001'
    const older = 'o002'
    emit(new Session(dir, older), 'user.message', '旧会话标题')
    emit(new Session(dir, newer), 'user.message', '新近的一个会话') // 后写 → mtime 新
    const list = listSessions(dir)
    expect(list[0]?.id).toBe(newer)
    expect(list[0]?.title).toBe('新近的一个会话')
    const olderRow = list.find((r) => r.id === older)
    expect(olderRow?.title).toBe('旧会话标题')
    expect(olderRow?.updatedAt).toBeTruthy()
  })

  it('半行损坏（崩溃遗留）不阻断整段会话的载入', () => {
    const id = 'trunc1'
    const s1 = new Session(dir, id)
    emit(s1, 'user.message', '第一句')
    emit(s1, 'assistant.message', '第一句回复')
    const before = s1.transcript().length
    // 模拟崩溃：追加半行 JSON
    appendFileSync(join(dir, `${id}.jsonl`), '{"event_id":"x","session_id":"trunc1","seq":3,"ty', 'utf-8')

    const s2 = Session.fromJSONL(dir, id) // 不抛
    expect(s2.transcript()).toHaveLength(before) // 有效事件全在
    expect(s2.skippedLines).toBe(1) // 但如实报告
    // 续写仍可用，且 seq 不冲突
    emit(s2, 'user.message', '继续')
    expect(s2.transcript().at(-1)?.seq).toBe(before + 1)
  })

  it('缺 seq 的行也按损坏跳过', () => {
    const id = 'badseq'
    const s = new Session(dir, id)
    emit(s, 'user.message', 'hi')
    appendFileSync(join(dir, `${id}.jsonl`), '{"event_id":"y","session_id":"badseq"}\n', 'utf-8')
    const s2 = Session.fromJSONL(dir, id)
    expect(s2.skippedLines).toBe(1)
    expect(s2.transcript()).toHaveLength(1)
  })

  it('完好文件 skippedLines 为 0', () => {
    const id = 'clean1'
    emit(new Session(dir, id), 'user.message', 'ok')
    expect(Session.fromJSONL(dir, id).skippedLines).toBe(0)
  })

  it('listSessions 缺 user.message / 空目录 不崩', () => {
    expect(listSessions(join(dir, 'no-such-dir'))).toEqual([])
    emit(new Session(dir, 'sys0'), 'system.context', '只言片语') // 无 user.message
    const list = listSessions(dir)
    const row = list.find((r) => r.id === 'sys0')
    expect(row?.title).toBe('（空会话）')
  })
})

describe('titleOf', () => {
  it('折叠空白、截断 28 字并加省略号；无 user 占位', () => {
    const long = '甲'.repeat(30)
    const t = titleOf([ev(`  第一行\n${long}  继续  `), ev('后话')])
    expect(t.startsWith('第一行 ')).toBe(true)
    expect(t.length).toBe(28 + 1) // 截断 28 字符 + '…'
    expect(t.endsWith('…')).toBe(true)
    expect(titleOf([ev('')])).toBe('（空会话）')
    expect(titleOf([{ ...ev(), type: 'assistant.message' }])).toBe('（空会话）')
  })
})
