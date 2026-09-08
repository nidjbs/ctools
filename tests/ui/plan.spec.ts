// UI e2e：plan 模式（计划卡，specs/plan-mode.md）。
// - Launcher：未输入时不显示 直接/规划；输入自由内容（将进 agent）按需浮现 chip → 可切 规划 → 冷启动首条即规划。
// - Chat：计划以内联计划卡呈现，默认展开可见编号步骤；批准后按「第 N 步」标记逐条打勾；replan 版本递增；放弃后卡片收起。
// mock gateway：带工具的请求先回只读工具(find_file)调用；纯文本请求由 streamReply 按请求次数给出（首次=计划，其后=执行输出）。
import { test, expect } from '@playwright/test'
import { launchApp, type MockBehavior } from './helpers'

async function withApp(opts: Parameters<typeof launchApp>[0], fn: (l: Awaited<ReturnType<typeof launchApp>>) => Promise<void>) {
  const l = await launchApp(opts)
  try {
    await fn(l)
  } finally {
    await l.cleanup()
  }
}

/** 计数 streamReply：第 1 次文本 = 计划；后续 = 执行输出 / 重规划计划。 */
function nthText(first: string, rest: string): MockBehavior['streamReply'] {
  let n = 0
  return () => {
    n += 1
    return n === 1 ? first : rest
  }
}

/** 开一个空对话窗（= 已在 agent）并切到 规划，返回 chat 页。 */
async function enterPlanChat(l: Awaited<ReturnType<typeof launchApp>>): Promise<import('@playwright/test').Page> {
  const { app, launcher } = l
  const win = app.waitForEvent('window')
  await launcher.evaluate(() =>
    (window as unknown as { api: { session: { open(m?: string): Promise<unknown> } } }).api.session.open(),
  )
  const chat = await win
  await chat.waitForSelector('.chat-modebar .mode-chip button')
  await chat.locator('.chat-modebar .mode-chip button').filter({ hasText: '规划' }).click()
  await expect(chat.locator('.chat-modebar .mode-chip button.sel.plan')).toBeVisible()
  return chat
}

test('Launcher 冷启动首条：按需浮现 规划 chip → 计划卡展开可见步骤 → 批准 → 逐条打勾完成', async () => {
  const behavior: MockBehavior = {
    toolName: 'find_file',
    toolArgs: '{"query":"临时文件"}',
    streamReply: nthText(
      '摘要：整理归档当前目录并生成索引\n1. 调研现状\n2. 确定归档规则\n3. 执行整理',
      '第 1 步：调研现状\n第 2 步：确定归档规则\n第 3 步：执行整理并小结',
    ),
  }
  await withApp({ behavior }, async (l) => {
    const { launcher } = l
    // 空输入（未进 agent）：Launcher 不显示 直接/规划
    await expect(launcher.locator('.mode-chip')).toHaveCount(0)

    const bar = launcher.locator('.launcher .bar')
    await bar.fill('把当前目录整理归档并生成索引，给出方案')
    // 自由内容 → 将进 agent → chip 按需浮现；切 规划
    await expect(launcher.locator('.launch-mode .mode-chip')).toBeVisible({ timeout: 10_000 })
    await launcher.locator('.launch-mode .mode-chip button').filter({ hasText: '规划' }).click()
    await expect(launcher.locator('.launch-mode .mode-chip button.sel.plan')).toBeVisible()

    // 回车 → 开 Chat 并以此模式直跑首条（冷启动即可规划）
    const win = l.app.waitForEvent('window')
    await bar.press('Enter')
    const chat = await win
    await expect(chat.locator('.chat-modebar .mode-chip button.sel.plan')).toBeVisible({ timeout: 10_000 })

    // 计划卡内联、默认展开：3 条步骤可见、待批准，无重复计划文本气泡
    const card = chat.locator('.plan-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('.pc-title')).toContainText('第 1 版')
    await expect(card.locator('.pc-title')).toContainText('整理归档当前目录')
    await expect(card.locator('.pc-step')).toHaveCount(3)
    await expect(card.locator('.pc-step.todo')).toHaveCount(3)
    await expect(card.locator('.pc-status')).toContainText('待批准')
    await expect(chat.locator('.bubble.assistant')).toHaveCount(0)

    // 批准 → 执行完成：三条步骤全部打勾，卡片保留在流中
    await card.locator('.confirm-actions button').filter({ hasText: '批准并执行' }).click()
    await expect(chat.locator('.chat-input-row .bar')).toBeEnabled({ timeout: 15_000 })
    await expect(card.locator('.pc-status')).toContainText('已完成')
    await expect(card.locator('.pc-step.done')).toHaveCount(3)
    await expect(chat.locator('.bubble.assistant')).toHaveCount(1) // 仅执行收尾一条，计划不重复
  })
})

test('plan 模式：replan 第 2 版；放弃后卡片收起、计划文本沉回历史气泡', async () => {
  const behavior: MockBehavior = {
    toolName: 'find_file',
    toolArgs: '{"query":"临时文件"}',
    streamReply: nthText('摘要：做一个两步骤的方案\n1. 步骤甲\n2. 步骤乙', '摘要：按你要求重排\n1. 先做整理\n2. 再复核结果'),
  }
  await withApp({ behavior }, async (l) => {
    await expect(l.launcher.locator('.mode-chip')).toHaveCount(0)
    const chat = await enterPlanChat(l)
    await chat.locator('.chat-input-row .bar').fill('给出一个两步骤方案')
    await chat.locator('.chat-input-row .bar').press('Enter')

    const card = chat.locator('.plan-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('.pc-title')).toContainText('第 1 版')
    await expect(card.locator('.pc-title')).toContainText('两步骤的方案')

    // 反馈重规划 → 第 2 版（摘要更新），卡片原位刷新
    await card.locator('.confirm-actions button').filter({ hasText: '按反馈重新规划' }).click()
    await expect(card.locator('.pc-title')).toContainText('第 2 版', { timeout: 20_000 })
    await expect(card.locator('.pc-title')).toContainText('按你要求重排')

    // 放弃 → 卡片收起；两份计划文本沉回历史气泡（事件溯源不抹除）
    await card.locator('.confirm-actions button').filter({ hasText: '放弃' }).click()
    await expect(chat.locator('.plan-card')).toHaveCount(0)
    await expect(chat.locator('.bubble.assistant')).toHaveCount(2, { timeout: 15_000 })
  })
})
