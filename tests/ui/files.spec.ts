// file 写/删两段 confirm 的 UI e2e（真实 Electron）：rm 确认/取消/放行、越界拒绝。
import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './helpers'

let root: string
let target: string

async function runQuick(l: Awaited<ReturnType<typeof launchApp>>, q: string) {
  const bar = l.launcher.locator('.launcher .bar')
  await bar.fill(q)
  await expect(l.launcher.locator('.matches li').first()).toContainText('file_rm') // 等 match 就绪
  await bar.press('Enter')
}

test('file_rm：先确认后删除；取消则不删', async () => {
  root = mkdtempSync(join(tmpdir(), 'ctools-ui-files-'))
  target = join(root, 'x.txt')
  writeFileSync(target, 'x')
  const l = await launchApp({ fileRoots: [root] })
  try {
    const launcher = l.launcher
    // 首跑 → confirm 面板（不执行）
    await runQuick(l, `file_rm ${target}`)
    await expect(launcher.locator('.confirm-box')).toContainText('删除')
    expect(existsSync(target)).toBe(true)

    // 取消 → 回到输入态，文件仍在
    await launcher.locator('.confirm-actions .btn:not(.danger)').click()
    await expect(launcher.locator('.confirm-box')).toHaveCount(0)
    expect(existsSync(target)).toBe(true)

    // 再跑 → 确认执行 → 已删除
    await runQuick(l, `file_rm ${target}`)
    await expect(launcher.locator('.confirm-box')).toContainText('删除')
    await launcher.locator('.confirm-actions .btn.danger').click()
    await expect(launcher.locator('.result-text')).toContainText('已删除')
    expect(existsSync(target)).toBe(false)
  } finally {
    await l.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent 发起 file_rm → Chat 内人工批准 → 执行删除', async () => {
  root = mkdtempSync(join(tmpdir(), 'ctools-ui-approve-'))
  target = join(root, 'victim.txt')
  writeFileSync(target, 'secret')
  const behavior = { toolName: 'file_rm', toolArgs: JSON.stringify({ path: target }) }
  const l = await launchApp({ fileRoots: [root], behavior })
  try {
    const bar = l.launcher.locator('.launcher .bar')
    const chatWin = l.app.waitForEvent('window')
    await bar.fill('帮我删除那个测试文件')
    await bar.press('Enter')
    const chat = await chatWin
    const cbar = chat.locator('.chat-input-row .bar')
    await expect(cbar).toBeVisible({ timeout: 15_000 })

    // 批准面板出现（file_rm + 删除提示）；文件仍在
    await expect(chat.locator('.approve-box')).toContainText('file_rm', { timeout: 15_000 })
    await expect(chat.locator('.approve-box')).toContainText('删除')
    expect(existsSync(target)).toBe(true)

    // 批准 → 执行删除并继续
    await chat.locator('.approve-box .btn.approve').click()
    await expect(chat.locator('.bubble.assistant').last()).toContainText('已收到:', { timeout: 20_000 })
    await expect(chat.locator('.approve-box')).toHaveCount(0)
    expect(existsSync(target)).toBe(false)
  } finally {
    await l.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('file_rm 越界直接拒绝（无 confirm）', async () => {
  root = mkdtempSync(join(tmpdir(), 'ctools-ui-files-'))
  const l = await launchApp({ fileRoots: [root] })
  try {
    await runQuick(l, 'file_rm /etc/hosts')
    await expect(l.launcher.locator('.result-text')).toContainText('拒绝')
    await expect(l.launcher.locator('.confirm-box')).toHaveCount(0)
  } finally {
    await l.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})
