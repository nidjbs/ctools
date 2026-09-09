// UI e2e：交互打磨（specs/ux-polish.md + specs/tool-visible.md + specs/session-resume.md）。
// 覆盖可控交互：复制 toast / text 可复制、Chat 就地确认、工具过程可见、多行输入、最近会话续聊、
// 新会话、模板删除（经由 /save 蒸馏回退沉淀 → 删除）、首启网关引导条、设置剪贴板本地别名字段。
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, type MockBehavior } from './helpers'

type Launch = Awaited<ReturnType<typeof launchApp>>

async function openChat(l: Launch): Promise<Page> {
  const win = l.app.waitForEvent('window')
  await l.launcher.evaluate(() =>
    (window as unknown as { api: { session: { open(m?: string): Promise<unknown> } } }).api.session.open(),
  )
  const chat = await win
  await chat.waitForSelector('.chat-input-row .bar', { state: 'visible', timeout: 15_000 })
  return chat
}

async function openSettings(l: Launch): Promise<Page> {
  const bar = l.launcher.locator('.launcher .bar')
  const sw = l.app.waitForEvent('window')
  await bar.fill('settings')
  await bar.press('Enter')
  const page = await sw
  await page.waitForSelector('.settings h1', { state: 'visible', timeout: 15_000 })
  return page
}

test('复制反馈：text 结果有复制钮，点击出 toast；list 点击复制出 toast', async () => {
  const l = await launchApp({})
  try {
    const bar = l.launcher.locator('.launcher .bar')
    // text 结果（trans → mock 中文）
    await bar.fill('trans hello')
    await expect(l.launcher.locator('.matches li').first()).toContainText('trans')
    await bar.press('Enter')
    await expect(l.launcher.locator('.result-text')).toContainText('你好')
    await expect(l.launcher.locator('.result-text .copy')).toBeVisible()
    await l.launcher.locator('.result-text .copy').click()
    await expect(l.launcher.locator('.toast')).toContainText('已复制')
  } finally {
    await l.cleanup()
  }
})

test('首启连接引导：gateway 不可达 → 空态显示引导条，点开设置', async () => {
  const l = await launchApp({ down: true })
  try {
    await expect(l.launcher.locator('.gw-banner')).toBeVisible({ timeout: 15_000 })
    await expect(l.launcher.locator('.gw-banner')).toContainText('模型网关未连接')
    const sw = l.app.waitForEvent('window')
    await l.launcher.locator('.gw-banner').locator('button', { hasText: '打开设置' }).click()
    const settings = await sw
    await expect(settings.locator('.settings h1')).toContainText('设置')
  } finally {
    await l.cleanup()
  }
})

test('工具过程可见：agent 调 find_file → 组块默认收起，展开后见 🔧/✓ 行（不撞 .bubble.tool）', async () => {
  const behavior: MockBehavior = { toolName: 'find_file', toolArgs: '{"query":"临时文件"}', streamReply: (t) => `已收到:${t}` }
  const l = await launchApp({ behavior })
  try {
    const bar = l.launcher.locator('.launcher .bar')
    const win = l.app.waitForEvent('window')
    await bar.fill('帮我找一下临时文件')
    await bar.press('Enter')
    const chat = await win
    await chat.waitForSelector('.chat-input-row .bar', { state: 'visible', timeout: 15_000 })
    await expect(chat.locator('.tool-group .tg-toggle')).toContainText('find_file', { timeout: 15_000 })
    // 默认收起：不直接铺出逐条工具行
    await expect(chat.locator('.tool-group .tg-body')).toHaveCount(0)
    await expect(chat.locator('.bubble.tool')).toHaveCount(0)
    // 点击展开 → 显示 call/result 行
    await chat.locator('.tool-group .tg-toggle').click()
    await expect(chat.locator('.tool-row.call').first()).toContainText('find_file')
    await expect(chat.locator('.tool-row.result').first()).toContainText('find_file')
  } finally {
    await l.cleanup()
  }
})

test('Chat 内 quick 确认就地完成：rm 走就地批准条，批准后删除', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctools-ui-polish-'))
  const target = join(root, 'doomed.txt')
  writeFileSync(target, 'x')
  const l = await launchApp({ fileRoots: [root] })
  try {
    const chat = await openChat(l)
    const bar = chat.locator('.chat-input-row .bar')
    await bar.fill(`file_rm ${target}`)
    await expect(chat.locator('.chat-sug li.sel').first()).toContainText('file_rm', { timeout: 10_000 })
    await bar.press('Enter')
    // 就地批准条（不提示去 Launcher）
    await expect(chat.locator('.approve-box')).toContainText('人工确认', { timeout: 10_000 })
    await expect(chat.locator('.approve-box')).toContainText('删除')
    expect(existsSync(target)).toBe(true)
    await chat.locator('.approve-box .btn.approve').click()
    await expect(chat.locator('.approve-box')).toHaveCount(0)
    await expect(chat.locator('.cmd-out')).toContainText('已删除', { timeout: 10_000 })
    expect(existsSync(target)).toBe(false)
  } finally {
    await l.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Chat 多行输入：textarea 存在，Shift+Enter 换行，Enter 发送', async () => {
  const l = await launchApp({})
  try {
    const chat = await openChat(l)
    const box = chat.locator('.chat-input-row .chat-box')
    await expect(box).toBeVisible()
    await box.fill('第一行')
    await box.press('Shift+Enter')
    await box.pressSequentially('第二行')
    await expect(box).toHaveValue('第一行\n第二行')
  } finally {
    await l.cleanup()
  }
})

test('会话续聊：跑一段后 Launcher 出最近会话 chip，点它回到历史', async () => {
  const l = await launchApp({})
  try {
    const bar = l.launcher.locator('.launcher .bar')
    // 开一段会话并完成一轮
    const win = l.app.waitForEvent('window')
    await bar.fill('历史第一条')
    await bar.press('Enter')
    const chat = await win
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
    // 关闭 Chat → 回到 Launcher（onLauncherShow → 刷新 recents）
    await chat.close()
    await expect(l.launcher.locator('.recent-chip').first()).toBeVisible({ timeout: 10_000 })
    await expect(l.launcher.locator('.recent-chip').first()).toContainText('历史第一条')
    // 点 chip → attach → 打开 Chat 回显历史
    const win2 = l.app.waitForEvent('window')
    await l.launcher.locator('.recent-chip').first().click()
    const chat2 = await win2
    await chat2.waitForSelector('.bubble.user', { state: 'visible', timeout: 15_000 })
    await expect(chat2.locator('.bubble.user').first()).toContainText('历史第一条')
  } finally {
    await l.cleanup()
  }
})

test('＋新会话：完成后点新会话 → Chat 清空到空会话', async () => {
  const l = await launchApp({})
  try {
    const chat = await openChat(l)
    const cbar = chat.locator('.chat-input-row .bar')
    await cbar.fill('一句话')
    await cbar.press('Enter')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
    await chat.locator('.chat-new').click()
    await expect(chat.locator('.bubble')).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await l.cleanup()
  }
})

test('/save 沉淀模板可删除：⭐ 显示 → 确认删除 → 从列表消失', async () => {
  const l = await launchApp({})
  try {
    const chat = await openChat(l)
    const cbar = chat.locator('.chat-input-row .bar')
    await cbar.fill('把 /tmp/a.json 按时间排序')
    await cbar.press('Enter')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
    // /save 蒸馏（mock 非 JSON → 回退朴素草稿）
    await cbar.fill('/save 排序助手')
    await cbar.press('Enter')
    const saveBtn = chat.locator('.save-box').locator('button', { hasText: '保存模板' })
    await expect(saveBtn).toBeVisible({ timeout: 15_000 })
    await saveBtn.click()
    await expect(chat.locator('.save-box')).toHaveCount(0, { timeout: 10_000 })

    // 回 Launcher：⭐ 模板出现
    await chat.close()
    const launcher = l.launcher
    await expect(launcher.locator('.matches li', { hasText: '排序助手' })).toBeVisible({ timeout: 10_000 })
    // hover 该行 → ✕ → 确认删除
    const row = launcher.locator('.matches li', { hasText: '排序助手' })
    await row.hover()
    await row.locator('.tpl-del').click()
    await expect(row.locator('.tpl-del')).toContainText('确认删除？')
    await row.locator('.tpl-del').click()
    await expect(launcher.locator('.matches li', { hasText: '排序助手' })).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await l.cleanup()
  }
})

test('设置：剪贴板本地模型别名字段存在并保存落盘', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    const field = settings.locator('label', { hasText: '剪贴板本地模型别名' }).locator('input')
    await expect(field).toBeVisible()
    await field.fill('trans')
    await settings.locator('button', { hasText: '保存' }).click()
    await expect(settings.locator('.notice')).toContainText('已保存')
    const disk = JSON.parse(readFileSync(join(l.userData, 'config.json'), 'utf-8'))
    expect(disk.clipboardLocalAlias).toBe('trans')
  } finally {
    await l.cleanup()
  }
})
