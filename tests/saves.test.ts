// /save：LLM 蒸馏草稿（JSON 解析/回退）+ 存取（同名覆盖/slug）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCommand, listSaves, distillDraft, extractJson, transcriptDigest, type DraftCtx } from '../src/main/saves'
import type { SessionEvent } from '../src/shared/types'

let dir: string
beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'ctools-saves-'))))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ev = (type: SessionEvent['type'], content?: string): SessionEvent =>
  ({
    event_id: 'x',
    session_id: 's',
    seq: 1,
    type,
    occurred_at: '',
    content,
  }) as SessionEvent

describe('saveCommand / listSaves', () => {
  it('保存并列出；同 title 覆盖', () => {
    saveCommand(dir, { title: '整理周报', instruction: 'instr-a', paramHint: '输入本周纪要' })
    expect(listSaves(dir)).toHaveLength(1)
    expect(listSaves(dir)[0].paramHint).toBe('输入本周纪要')
    saveCommand(dir, { title: '整理周报', instruction: 'instr-b', paramHint: '' })
    expect(listSaves(dir)).toHaveLength(1)
    expect(listSaves(dir)[0].instruction).toBe('instr-b')
  })

  it('空白名有兜底 id', () => {
    const c = saveCommand(dir, { title: '   ', instruction: 'x', paramHint: '' })
    expect(c.id).toBe('saved')
  })
})

describe('extractJson / distillDraft', () => {
  it('extractJson 剥离代码围栏后解析', () => {
    const got = extractJson('```json\n{"title":"清缓存","instruction":"执行 {param} 清理","paramHint":"路径"}\n```')
    expect(got).toEqual({ title: '清缓存', instruction: '执行 {param} 清理', paramHint: '路径' })
    expect(extractJson('不是 json')).toBeNull()
  })

  it('LLM 可用时返回其草稿', async () => {
    const ctx: DraftCtx = {
      config: { defaultAlias: 'common' },
      gateway: {
        chat: async () => ({
          content: '{"title":"排序JSON","instruction":"读取 {param} 并按时间排序输出","paramHint":"文件路径"}',
        }),
      },
    }
    const events = [ev('user.message', '帮我把 /tmp/a.json 按时间排序'), ev('assistant.message', '已用 bash sort 完成')]
    const d = await distillDraft(ctx, events, '排序', '更简短')
    expect(d.title).toContain('排序')
    expect(d.instruction).toContain('{param}')
  })

  it('LLM 失败 → 朴素回退（不崩）', async () => {
    const ctx: DraftCtx = {
      config: { defaultAlias: 'common' },
      gateway: {
        chat: async () => {
          throw new Error('gateway down')
        },
      },
    }
    const events = [ev('user.message', '把 /tmp/a 排序')]
    const d = await distillDraft(ctx, events, '我的命令')
    expect(d.instruction).toContain('/tmp/a')
    expect(d.title).toBe('我的命令')
  })
})

describe('transcriptDigest', () => {
  it('只取最近若干条 用户/助手', () => {
    const events = [
      ev('user.message', '旧问题'),
      ev('assistant.message', '旧做法'),
      ev('user.message', '把 /tmp/a 排序'),
      ev('assistant.message', '用 bash sort 完成，输出如下…'),
    ]
    const out = transcriptDigest(events, 3)
    expect(out).toContain('/tmp/a')
    expect(out).toContain('bash sort')
    expect(out).not.toContain('旧问题') // 最早一条被裁掉
  })
})
