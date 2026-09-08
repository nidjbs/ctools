// UI e2e：agent（Chat）输入的命令检索与唤起 —— 与 Launcher 同一套 commands.match + 回车语义。
// 开一个空对话窗 → 输入 "trans hello"：候选默认高亮 → 回车直接执行 quick 命令（不进 agent 对话）。
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

async function withApp(fn: (l: Awaited<ReturnType<typeof launchApp>>) => Promise<void>) {
  const l = await launchApp({})
  try {
    await fn(l)
  } finally {
    await l.cleanup()
  }
}

async function openChat(l: Awaited<ReturnType<typeof launchApp>>) {
  const win = l.app.waitForEvent('window')
  await l.launcher.evaluate(() =>
    (window as unknown as { api: { session: { open(m?: string): Promise<unknown> } } }).api.session.open(),
  )
  const chat = await win
  await chat.waitForSelector('.chat-input-row .bar')
  return chat
}

test('agent 输入：命令候选默认高亮，回车唤起 quick 执行（结果内联，不进 agent）', async () => {
  await withApp(async (l) => {
    const chat = await openChat(l)
    const bar = chat.locator('.chat-input-row .bar')

    await bar.fill('trans hello')
    // 候选出现且默认高亮首项
    const sel = chat.locator('.chat-sug li.sel')
    await expect(sel.first()).toContainText('trans', { timeout: 10_000 })

    await bar.press('Enter')
    // quick 命令结果内联展示、输入清空、未产生 agent 气泡
    await expect(chat.locator('.cmd-out pre')).toContainText('你好', { timeout: 15_000 })
    await expect(bar).toHaveValue('')
    await expect(chat.locator('.bubble.assistant')).toHaveCount(0)
  })
})
