// UI e2e：交互打磨（specs/ux-polish.md + specs/tool-visible.md + specs/session-resume.md）。
// 覆盖可控交互：复制 toast / text 可复制、Chat 就地确认、工具过程可见、多行输入、最近会话续聊、
// 新会话、模板删除（经由 /save 蒸馏回退沉淀 → 删除）、首启网关引导条、设置剪贴板本地别名字段。
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
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

test('设置入口：空态列表末尾有「设置」行，点击即开设置窗', async () => {
  const l = await launchApp({})
  try {
    const row = l.launcher.locator('.matches li', { hasText: '设置' }).last()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('网关与模型')
    const sw = l.app.waitForEvent('window')
    await row.click()
    const settings = await sw
    await expect(settings.locator('.settings h1')).toContainText('设置', { timeout: 15_000 })
  } finally {
    await l.cleanup()
  }
})

test('首启目录引导：file_roots 为空 → 引导条出现；选目录后写入配置', async () => {
  const picked = mkdtempSync(join(tmpdir(), 'ctools-pick-'))
  const l = await launchApp({ fileRoots: [], pickDir: picked })
  try {
    const banner = l.launcher.locator('.gw-banner.roots')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('未配置可访问目录')

    await banner.locator('button', { hasText: '选择目录' }).click()
    await expect(banner).toHaveCount(0, { timeout: 10_000 })

    const disk = JSON.parse(readFileSync(join(l.userData, 'config.json'), 'utf-8'))
    expect(disk.fileRoots).toEqual([picked])
  } finally {
    await l.cleanup()
    rmSync(picked, { recursive: true, force: true })
  }
})

test('首启连接引导：gateway 不可达 → 空态显示引导条，点开设置', async () => {
  const l = await launchApp({ down: true })
  try {
    // 精确到网关那条：file_roots 为空时目录引导条会同时出现（`.gw-banner.roots`）
    const gwBanner = l.launcher.locator('.gw-banner:not(.roots)')
    await expect(gwBanner).toBeVisible({ timeout: 15_000 })
    await expect(gwBanner).toContainText('模型网关未连接')
    const sw = l.app.waitForEvent('window')
    await gwBanner.locator('button', { hasText: '打开设置' }).click()
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

test('从最近会话进入后能继续对话（不卡住），且多轮历史完整恢复', async () => {
  const l = await launchApp({})
  try {
    const bar = l.launcher.locator('.launcher .bar')
    // 先跑一段**多轮**会话
    const win = l.app.waitForEvent('window')
    await bar.fill('第一句')
    await bar.press('Enter')
    const chat = await win
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
    const cbox = chat.locator('.chat-input-row .chat-box')
    for (const t of ['第二句', '第三句']) {
      await cbox.fill(t)
      await cbox.press('Enter')
      await expect(chat.locator('.bubble.assistant').last()).toContainText(`已收到:${t}`, { timeout: 15_000 })
    }

    // 关闭 Chat（窗口销毁），从最近会话重新进入
    await chat.close()
    await expect(l.launcher.locator('.recent-chip').first()).toBeVisible({ timeout: 10_000 })
    const win2 = l.app.waitForEvent('window')
    await l.launcher.locator('.recent-chip').first().click()
    const chat2 = await win2
    // 三轮用户消息全部恢复（不是只恢复最近一句）
    await expect(chat2.locator('.bubble.user')).toHaveCount(3, { timeout: 15_000 })
    await expect(chat2.locator('.bubble.user').nth(0)).toContainText('第一句')
    await expect(chat2.locator('.bubble.user').nth(1)).toContainText('第二句')
    await expect(chat2.locator('.bubble.user').nth(2)).toContainText('第三句')

    // 关键：输入框必须可用（卡住时它会一直 disabled / 显示「回答中…」）
    const box = chat2.locator('.chat-input-row .chat-box')
    await expect(box).toBeEnabled({ timeout: 10_000 })
    await box.fill('第二句')
    await box.press('Enter')
    await expect(chat2.locator('.bubble.user').last()).toContainText('第二句')
    await expect(chat2.locator('.bubble.assistant').last()).toContainText('已收到:第二句', { timeout: 15_000 })
  } finally {
    await l.cleanup()
  }
})

test('Chat 已打开时切到别的会话（走 session:reset）后能继续对话', async () => {
  const l = await launchApp({})
  try {
    const bar = l.launcher.locator('.launcher .bar')
    // 会话 A
    const win = l.app.waitForEvent('window')
    await bar.fill('A的问题')
    await bar.press('Enter')
    const chat = await win
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 15_000 })
    const recent = await l.launcher.evaluate(() =>
      (window as unknown as { api: { session: { recent(): Promise<{ id: string }[]> } } }).api.session.recent(),
    )
    const idA = recent[0].id

    // 切到新会话 B（Chat 窗口保持打开）
    await l.launcher.evaluate(() =>
      (window as unknown as { api: { session: { newSession(): Promise<unknown> } } }).api.session.newSession(),
    )
    const box = chat.locator('.chat-input-row .chat-box')
    await expect(chat.locator('.bubble')).toHaveCount(0, { timeout: 10_000 })
    await expect(box).toBeEnabled({ timeout: 10_000 })
    await box.fill('B的问题')
    await box.press('Enter')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:B的问题', { timeout: 15_000 })

    // 关键路径：窗口开着时 attach 回会话 A → 应收到 reset 并恢复可用
    await l.launcher.evaluate(
      (id) => (window as unknown as { api: { session: { attach(i: string): Promise<unknown> } } }).api.session.attach(id),
      idA,
    )
    await expect(chat.locator('.bubble.user').first()).toContainText('A的问题', { timeout: 15_000 })
    await expect(box).toBeEnabled({ timeout: 10_000 })
    await box.fill('A的追问')
    await box.press('Enter')
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:A的追问', { timeout: 15_000 })
  } finally {
    await l.cleanup()
  }
})

test('运行中未批准就关窗 → 再从最近会话进入不应卡住', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctools-hang-'))
  writeFileSync(join(root, 'victim.txt'), 'x')
  const behavior: MockBehavior = {
    toolName: 'file_rm',
    toolArgs: JSON.stringify({ path: join(root, 'victim.txt') }),
    streamReply: (t) => `已收到:${t}`,
  }
  const l = await launchApp({ fileRoots: [root], behavior })
  try {
    const bar = l.launcher.locator('.launcher .bar')
    const win = l.app.waitForEvent('window')
    await bar.fill('删掉那个测试文件')
    await bar.press('Enter')
    const chat = await win
    // 停在批准面板上，不批准就关窗
    await expect(chat.locator('.approve-box')).toContainText('file_rm', { timeout: 15_000 })
    await chat.close()
    await expect(l.launcher.locator('.recent-chip').first()).toBeVisible({ timeout: 10_000 })

    // 再次进入该会话：窗口必须能开、输入必须可用
    const win2 = l.app.waitForEvent('window')
    await l.launcher.locator('.recent-chip').first().click()
    const chat2 = await win2
    const box = chat2.locator('.chat-input-row .chat-box')
    await expect(box).toBeEnabled({ timeout: 10_000 })
    await box.fill('还在吗')
    await box.press('Enter')
    await expect(chat2.locator('.bubble.assistant').last()).toContainText('已收到:还在吗', { timeout: 20_000 })
  } finally {
    await l.cleanup()
    rmSync(root, { recursive: true, force: true })
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

test('agent 提问（ask）：Chat 内出现提问条，回答后回填并继续', async () => {
  const behavior: MockBehavior = {
    toolName: 'ask',
    toolArgs: JSON.stringify({ question: '选哪个方案？', options: ['A', 'B'] }),
    streamReply: (t) => `已收到:${t}`,
  }
  const l = await launchApp({ behavior })
  try {
    const bar = l.launcher.locator('.launcher .bar')
    const win = l.app.waitForEvent('window')
    await bar.fill('帮我选一个方案')
    await bar.press('Enter')
    const chat = await win
    await chat.waitForSelector('.chat-input-row .bar', { state: 'visible', timeout: 15_000 })

    // 提问条 + 候选项按钮
    await expect(chat.locator('.ask-box')).toContainText('选哪个方案？', { timeout: 15_000 })
    await expect(chat.locator('.ask-opts .btn')).toHaveCount(2)

    // 点候选项 → 提问条消失，agent 拿到回答继续
    await chat.locator('.ask-opts .btn', { hasText: 'B' }).click()
    await expect(chat.locator('.ask-box')).toHaveCount(0)
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 20_000 })
  } finally {
    await l.cleanup()
  }
})

test('设置：模型分配区（默认 + 各场景）；连接区默认折叠但在高级里', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    // 模型区：默认 + 翻译场景（直接按 label 定位，避免 section 的 hasText 误命中别处的「模型」二字）
    await expect(settings.locator('label', { hasText: '默认模型别名' })).toBeVisible()
    const transField = settings.locator('label', { hasText: '翻译（trans）' }).locator('input')
    await expect(transField).toBeVisible()

    // 连接字段默认**不可见**（折叠在高级里），不再作为主字段
    await expect(settings.locator('label', { hasText: 'gateway URL' })).toBeHidden()
    await expect(settings.locator('.adv summary')).toContainText('通常无需修改')
    await settings.locator('.adv summary').click()
    await expect(settings.locator('label', { hasText: 'gateway URL' })).toBeVisible()

    // 场景模型保存落盘
    await transField.fill('ds')
    await settings.locator('button', { hasText: /^\s*保存\s*$/ }).click()
    await expect(settings.locator('.notice')).toContainText('已保存')
    const disk = JSON.parse(readFileSync(join(l.userData, 'config.json'), 'utf-8'))
    expect(disk.commandModels).toMatchObject({ trans: 'ds' })
  } finally {
    await l.cleanup()
  }
})

test('网关配置：读取 ~/gw.yaml 的 providers/aliases，编辑后写回并保留其余键', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctools-gwui-'))
  const gwFile = join(dir, 'gw.yaml')
  writeFileSync(
    gwFile,
    ['listen: 127.0.0.1:8080', 'auth:', '  mode: none', 'providers:', '  ds:', '    type: openai', '    base_url: https://api.deepseek.com', 'aliases:', '  common:', '    provider: ds', '    model: deepseek-v4-flash', ''].join('\n'),
  )
  const l = await launchApp({ gwConfig: gwFile })
  try {
    const settings = await openSettings(l)
    const section = settings.locator('section', { has: settings.locator('h2', { hasText: '网关配置' }) })
    await expect(section).toContainText(gwFile)
    // 读到了现有的上游与别名（input 的 value 不计入 textContent，须断言 value）
    await expect(section.locator('.gw-list').first().locator('li').first().locator('input').nth(2)).toHaveValue(
      'https://api.deepseek.com',
    )
    await expect(section.locator('.gw-list').nth(1).locator('li').first().locator('input').nth(1)).toHaveValue(
      'deepseek-v4-flash',
    )

    // 加一个上游 + 一个别名
    await section.locator('button', { hasText: '添加上游' }).click()
    const newProvider = section.locator('.gw-list').first().locator('li').last()
    await newProvider.locator('input').nth(0).fill('ollama')
    await newProvider.locator('input').nth(2).fill('http://localhost:11434/v1')
    await section.locator('button', { hasText: '添加别名' }).click()
    const newAlias = section.locator('.gw-list').nth(1).locator('li').last()
    await newAlias.locator('input').nth(0).fill('trans')
    await newAlias.locator('select').selectOption('ollama')
    await newAlias.locator('input').nth(1).fill('hy-mt1.5')

    await section.locator('button', { hasText: '保存并热更' }).click()
    await expect(section.locator('.notice')).toBeVisible({ timeout: 15_000 })

    // 磁盘上：新内容写入，且 listen/auth 等未被本功能管理的键原样保留
    const doc = (await import('js-yaml')).load(readFileSync(gwFile, 'utf-8')) as Record<string, unknown>
    expect(doc.listen).toBe('127.0.0.1:8080')
    expect(doc.auth).toEqual({ mode: 'none' })
    expect(Object.keys(doc.providers as object).sort()).toEqual(['ds', 'ollama'])
    expect((doc.aliases as Record<string, { model: string }>).trans.model).toBe('hy-mt1.5')
    // 有备份
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(true)
  } finally {
    await l.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：剪贴板本地模型别名字段存在并保存落盘', async () => {
  const l = await launchApp({})
  try {
    const settings = await openSettings(l)
    const field = settings.locator('label', { hasText: '剪贴板召回模型（本地）' }).locator('input')
    await expect(field).toBeVisible()
    await field.fill('trans')
    await settings.locator('button', { hasText: /^\s*保存\s*$/ }).click()
    await expect(settings.locator('.notice')).toContainText('已保存')
    const disk = JSON.parse(readFileSync(join(l.userData, 'config.json'), 'utf-8'))
    expect(disk.clipboardLocalAlias).toBe('trans')
  } finally {
    await l.cleanup()
  }
})
