// UI e2e：真实 Electron（构建产物 out/）UI 操作。
// 分层约定：这里覆盖可控交互（联想/quick 执行/聊天流式/优雅失败）；
// 依赖真实系统副作用的（Spotlight 全量搜、剪贴板写入）由运行时 e2e/单测兜底，不进 UI e2e。
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

test('启动：输入框聚焦；空态显示能力模板（非子工具）；联想与 Tab 补全', async () => {
  await withApp({}, async ({ launcher }) => {
    const bar = launcher.locator('.launcher .bar')

    // 输入框自动聚焦
    await launcher.waitForFunction(() => {
      const a = document.activeElement
      return !!(a && (a.className || '').includes('bar'))
    })

    // 空输入 → 能力模板（翻译/找文件/运行…），不罗列子工具
    await expect(launcher.locator('.matches li').first()).toBeVisible()
    await expect(launcher.locator('.matches').first()).toContainText('翻译')
    await expect(launcher.locator('.matches')).toContainText('运行命令/脚本')
    await expect(launcher.locator('.matches')).not.toContainText('file_')

    // 前缀联想
    await bar.fill('tra')
    const first = launcher.locator('.matches li').first()
    await expect(first).toContainText('trans')
    await expect(first).toHaveClass(/sel/)

    // Tab → 补全成 "trans "
    await bar.press('Tab')
    await expect(bar).toHaveValue('trans ')

    // 别名联想（用 find 前缀：file_list 会撞 'fi'）
    await bar.fill('find')
    await expect(launcher.locator('.matches li').first()).toContainText('find_file')
  })
})

test('quick 执行：trans 出中文 inline；find_file 空根出未找到；MRU + 方向键导航', async () => {
  await withApp({}, async ({ launcher }) => {
    const bar = launcher.locator('.launcher .bar')

    // trans hello → mock gateway 中文回复
    await bar.fill('trans hello')
    await expect(launcher.locator('.matches li').first()).toContainText('trans') // 等 match 就绪再回车
    await bar.press('Enter')
    await expect(launcher.locator('.result-text')).toContainText('你好')

    // 再回车 → 清空回到输入态
    await bar.press('Enter')
    await expect(bar).toHaveValue('')

    // find_file（fileRoots 为空 → 确定性"未找到"，不触真实 Spotlight）
    await bar.fill('find 不存在的xyz')
    await expect(launcher.locator('.matches li').first()).toContainText('find_file')
    await bar.press('Enter')
    await expect(launcher.locator('.result-text')).toContainText('未找到')

    // 清空 → 首页回到能力模板（不罗列子工具）
    await bar.press('Enter')
    await expect(launcher.locator('.matches li').first()).toContainText('翻译')
    await expect(launcher.locator('.matches')).not.toContainText('file_')

    // ↓ 选中第 2 个模板（找文件）→ Enter 带入 #find 参数态
    await bar.press('ArrowDown')
    await expect(launcher.locator('.matches li').nth(1)).toHaveClass(/sel/)
    await bar.press('Enter')
    await expect(bar).toHaveValue('#find ')
  })
})

test('自由内容开 Chat 窗：首轮工具执行不展示 + 流式回复 + markdown/复制；窗内二次发送', async () => {
  const behavior: MockBehavior = {
    toolName: 'find_file',
    toolArgs: '{"query":"临时文件"}',
    // 回复带 markdown（标题 + 代码块），验证渲染与复制
    streamReply: (t) => `# 汇总\n\n\`\`\`\n已收到:${t}\n\`\`\``,
  }
  await withApp({ behavior }, async ({ app, launcher }) => {
    const bar = launcher.locator('.launcher .bar')
    const text = '帮我总结一下今天的重点'

    // 自由内容（首词非命令）→ Enter 开 Chat 窗并直接开跑
    const chatWin = app.waitForEvent('window')
    await bar.fill(text)
    await bar.press('Enter')
    const chat = await chatWin
    await chat.waitForSelector('.chat-input-row .bar', { state: 'visible', timeout: 15_000 })

    // 首轮：用户气泡 / 工具调用不展示 / 助手最终回复（transcript 重建为准）
    await expect(chat.locator('.bubble.user').first()).toContainText(text)
    await expect(chat.locator('.bubble.tool')).toHaveCount(0)
    const firstAssistant = chat.locator('.bubble.assistant').last()
    await expect(firstAssistant).toContainText('已收到:', { timeout: 15_000 })

    // markdown 渲染：标题 + 代码块；每条气泡有复制钮
    await expect(firstAssistant.locator('.md-h')).toContainText('汇总')
    await expect(firstAssistant.locator('.md-code pre code')).toContainText('已收到:')
    await expect(firstAssistant.locator('.copy').first()).toBeVisible()

    // 窗内二次发送：流式再出一轮
    const cbar = chat.locator('.chat-input-row .bar')
    await expect(cbar).toBeEnabled()
    await cbar.fill('第二条')
    await cbar.press('Enter')
    await expect(chat.locator('.bubble.user').last()).toContainText('第二条')
    const second = chat.locator('.bubble.assistant').last()
    await expect(second).toContainText('已收到:第二条', { timeout: 15_000 })
    await expect(second.locator('.md-code pre code')).toContainText('已收到:第二条')
  })
})

test('首轮慢回复：挂载时运行中 → 完成后自动停止（输入恢复可用，可继续发）', async () => {
  const behavior: MockBehavior = { firstDelayMs: 1500, streamReply: (t) => `已收到:${t}` }
  await withApp({ behavior }, async ({ app, launcher }) => {
    const bar = launcher.locator('.launcher .bar')
    const chatWin = app.waitForEvent('window')
    await bar.fill('慢速示例')
    await bar.press('Enter')
    const chat = await chatWin
    const cbar = chat.locator('.chat-input-row .bar')
    await expect(cbar).toBeVisible({ timeout: 15_000 })

    // 用户问题已在会话中（可能在回答中，可能在完成态）
    await expect(chat.locator('.bubble.user').first()).toContainText('慢速示例')

    // 完成后自动停止：输入恢复可用，draft 消失，气泡定稿
    await expect(cbar).toBeEnabled({ timeout: 20_000 })
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:慢速示例')

    // 停止后能继续发第二轮
    await cbar.fill('再来一条')
    await cbar.press('Enter')
    await expect(chat.locator('.bubble.user').last()).toContainText('再来一条')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:再来一条', { timeout: 20_000 })
  })
})

test('模板参数 #run <描述> → 交给 agent Chat', async () => {
  await withApp({}, async ({ app, launcher }) => {
    const bar = launcher.locator('.launcher .bar')
    const win = app.waitForEvent('window')
    await bar.fill('#run 把 /tmp/a.json 里的记录按时间排序')
    await bar.press('Enter')
    const chat = await win
    const userBubble = chat.locator('.bubble.user').first()
    await expect(userBubble).toContainText('运行命令/脚本', { timeout: 15_000 })
    await expect(userBubble).toContainText('/tmp/a.json')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
  })
})

test('固定型模板 #translate <文本> → 直跑命令 inline 译文（不进 agent）', async () => {
  await withApp({}, async ({ launcher }) => {
    const bar = launcher.locator('.launcher .bar')
    await bar.fill('#translate hello')
    await bar.press('Enter')
    await expect(launcher.locator('.result-text')).toContainText('你好', { timeout: 15_000 })
  })
})

test('gateway 不可达：仍能启动，quick 命令优雅显示执行失败', async () => {
  await withApp({ down: true }, async ({ launcher }) => {
    const bar = launcher.locator('.launcher .bar')
    await expect(bar).toBeVisible()
    await bar.fill('trans hi')
    await expect(launcher.locator('.matches li').first()).toContainText('trans')
    await bar.press('Enter')
    await expect(launcher.locator('.result-text')).toContainText('执行失败')
  })
})
