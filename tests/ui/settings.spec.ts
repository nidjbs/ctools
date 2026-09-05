// Settings UI e2e：打开设置窗 / gateway 状态与热更新 / 命令启停落盘 / 表单保存落盘。
// 覆盖 specs/settings.md 的可观测部分；依赖真实 gw 的"托管启动/重启"不进 UI e2e。
import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchApp } from './helpers'

type Launch = Awaited<ReturnType<typeof launchApp>>

/** 在 Launcher 输入 settings 回车，返回设置窗。 */
async function openSettings(l: Launch): Promise<Page> {
  const bar = l.launcher.locator('.launcher .bar')
  const sw = l.app.waitForEvent('window')
  await bar.fill('settings')
  await bar.press('Enter')
  const page = await sw
  await page.waitForSelector('.settings h1', { state: 'visible', timeout: 15_000 })
  return page
}

async function diskConfig(userData: string) {
  return JSON.parse(await readFile(join(userData, 'config.json'), 'utf-8'))
}

test('打开设置窗：显示运行中；热更新成功反馈', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    await expect(settings.locator('.settings')).toContainText('运行中', { timeout: 15_000 })
    await settings
      .locator('.settings section', { hasText: 'Gateway' })
      .locator('button', { hasText: '热更新' })
      .click()
    await expect(settings.locator('.notice')).toContainText('已热更新')
  } finally {
    await l.cleanup()
  }
})

test('命令启停：禁用 find_file 立即落盘且列表反映', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    const row = settings.locator('.cmds li').filter({ hasText: 'find_file' })
    await expect(row.locator('input')).toBeChecked()
    await row.locator('input').uncheck()
    await expect(settings.locator('.notice')).toContainText('find_file 已禁用')
    await expect(row.locator('input')).not.toBeChecked()

    const disk = await diskConfig(l.userData)
    expect(disk.enabledCommands).toMatchObject({ find_file: false })
  } finally {
    await l.cleanup()
  }
})

test('表单保存：defaultAlias / hotkey / file_roots 落盘', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    await settings.locator('label', { hasText: '默认模型别名' }).locator('input').fill('trans')
    await settings.locator('label', { hasText: '全局热键' }).locator('input').fill('Alt+Space')
    await settings
      .locator('label', { hasText: 'file_roots' })
      .locator('textarea')
      .fill('/tmp\n/Users/mac/Documents')
    await settings.locator('button', { hasText: '保存' }).click()
    await expect(settings.locator('.notice')).toContainText('已保存')

    const disk = await diskConfig(l.userData)
    expect(disk.defaultAlias).toBe('trans')
    expect(disk.hotkey).toBe('Alt+Space')
    expect(disk.fileRoots).toEqual(['/tmp', '/Users/mac/Documents'])
  } finally {
    await l.cleanup()
  }
})
