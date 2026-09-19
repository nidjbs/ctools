// 模型路由（specs/settings.md §2）：场景别名非空则用，否则回退默认；trans 真的走它。
import { describe, expect, it } from 'vitest'
import { resolveModel, MODEL_SCENARIOS } from '../src/shared/model'
import { trans } from '../commands/trans'
import { defaultConfig } from '../src/main/config'
import type { AppConfig, Ctx } from '../src/shared/types'

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...defaultConfig(), ...over })

function ctxWith(config: AppConfig, seen: string[]): Ctx {
  return {
    config,
    gateway: {
      models: async () => [],
      chat: async (req) => {
        seen.push(req.model)
        return { content: '译文' }
      },
      chatStream: async (_r, h) => h.onFinish?.('stop'),
    },
    system: { pbcopy: async () => true, mdfind: async () => [] },
  }
}

describe('resolveModel', () => {
  it('未设置场景别名 → 回退默认', () => {
    expect(resolveModel(cfg({ defaultAlias: 'chat' }), 'trans')).toBe('chat')
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: {} }), 'trans')).toBe('chat')
  })

  it('场景别名非空 → 用它', () => {
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: { trans: 'ds' } }), 'trans')).toBe('ds')
  })

  it('空串 / 纯空白视为未设置（用户只想改默认模型时不必逐个填）', () => {
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: { trans: '' } }), 'trans')).toBe('chat')
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: { trans: '   ' } }), 'trans')).toBe('chat')
  })

  it('场景别名前后空白被裁剪', () => {
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: { trans: ' ds ' } }), 'trans')).toBe('ds')
  })

  it('不传场景 id → 默认模型', () => {
    expect(resolveModel(cfg({ defaultAlias: 'chat', commandModels: { trans: 'ds' } }))).toBe('chat')
  })

  it('MODEL_SCENARIOS 里的 id 都是 commandModels 的合法键', () => {
    expect(MODEL_SCENARIOS.map((s) => s.id)).toContain('trans')
    for (const s of MODEL_SCENARIOS) expect(s.label && s.hint).toBeTruthy()
  })
})

describe('trans 使用场景别名', () => {
  it('设置了 commandModels.trans → 请求用该模型', async () => {
    const seen: string[] = []
    await trans.run('hello', ctxWith(cfg({ commandModels: { trans: 'ds' } }), seen))
    expect(seen).toEqual(['ds'])
  })

  it('未设置 → 用默认模型', async () => {
    const seen: string[] = []
    await trans.run('hello', ctxWith(cfg({ defaultAlias: 'chat' }), seen))
    expect(seen).toEqual(['chat'])
  })
})
