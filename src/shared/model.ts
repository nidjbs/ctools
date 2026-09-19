// 模型路由：固定场景可用自己的别名，未指定则回退默认模型。见 specs/settings.md §2。
import type { AppConfig } from './types'

/** 使用模型的固定场景（Settings 据此渲染「各场景模型」）。 */
export const MODEL_SCENARIOS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'trans', label: '翻译（trans）', hint: '翻译命令用哪个模型' },
]

/**
 * 取某场景应使用的别名：`commandModels[id]` 非空则用它，否则回退 `defaultAlias`。
 * 空串/空白视为未设置 —— 用户只想改默认模型时不必逐个填。
 */
export function resolveModel(config: AppConfig, scenarioId?: string): string {
  const override = scenarioId ? config.commandModels?.[scenarioId]?.trim() : ''
  return override || config.defaultAlias
}
