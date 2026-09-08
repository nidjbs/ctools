// web_search：默认关、调用需批准；解析纯函数。specs/web-search.md。
import { describe, expect, it } from 'vitest'
import { webSearchCmd, parseDdg } from '../commands/web_search'
import { Registry } from '../src/main/registry'
import type { AppConfig, Ctx } from '../src/shared/types'

function ctx(webSearchEnabled: boolean): Ctx {
  return {
    config: { defaultAlias: 'common', webSearchEnabled, writeConfirm: 'auto', hotkey: 'x', enabledCommands: {} } as AppConfig,
    gateway: {
      models: async () => [],
      chat: async () => ({ content: '' }),
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
}

const HTML = `<div class="result"><a rel="nofollow" class="result__a" href="https://a.example">Alpha <b>Docs</b></a>
<a class="result__snippet" href="https://a.example">first snippet &amp; more</a></div>
<div class="result"><a rel="nofollow" class="result__a" href="https://b.example">Beta News</a>
<a class="result__snippet" href="https://b.example">second snippet</a></div>`

describe('parseDdg', () => {
  it('解析 title/url/snippet 并去标签', () => {
    const r = parseDdg(HTML)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ title: 'Alpha Docs', url: 'https://a.example' })
    expect(r[0].snippet).toContain('first snippet & more')
  })
  it('空结果返回空数组', () => {
    expect(parseDdg('no results')).toEqual([])
  })
})

describe('web_search 命令', () => {
  it('默认关闭 → 提示去 Settings 开启', async () => {
    const r = await webSearchCmd.run('deepseek api', ctx(false))
    expect(r.type).toBe('text')
    if (r.type === 'text') expect(r.text).toContain('未开启')
  })

  it('开启后调用仍需批准（confirmApproved）', async () => {
    const r = await webSearchCmd.run('deepseek api', ctx(true))
    expect(r).toMatchObject({ type: 'confirm', message: expect.stringContaining('联网搜索') })
  })

  it('是 agentTool（进白名单）', () => {
    const ids = new Registry().registerAll([webSearchCmd]).toolIds()
    expect(ids).toContain('web_search')
  })
})
