// quick 命令回车解析（Launcher / Chat 共用 quickRun）：命令名待参数态 vs 带参执行。
import { describe, expect, it } from 'vitest'
import type { CommandMeta } from '../src/shared/types'
import { commandParam, quickEnter } from '../src/shared/quickRun'

const cmd: CommandMeta = {
  id: 'find_file',
  title: '查找文件',
  aliases: ['找文件', 'ff'],
  kind: 'quick',
  agentTool: true,
  enabled: true,
}

describe('commandParam', () => {
  it('整词命中命令 id/别名 → 空（待补参数）', () => {
    expect(commandParam(cmd, 'find_file')).toBe('')
    expect(commandParam(cmd, 'ff')).toBe('')
    expect(commandParam(cmd, ' 找文件 ')).toBe('')
  })
  it('命令名+空格 → 剩余为参数', () => {
    expect(commandParam(cmd, 'find_file 桌面上')).toBe('桌面上')
    expect(commandParam(cmd, '找文件 桌面上')).toBe('桌面上')
    expect(commandParam(cmd, 'find_file  a b ')).toBe('a b')
  })
  it('不匹配输入原样返回（候选非该命令时）', () => {
    expect(commandParam(cmd, 'xyz')).toBe('xyz')
  })
})

describe('quickEnter', () => {
  it('无参数 → run=false（参数态）', () => {
    expect(quickEnter(cmd, 'find_file')).toEqual({ run: false })
  })
  it('带参数 → run=true + param', () => {
    expect(quickEnter(cmd, 'find_file 桌')).toEqual({ run: true, param: '桌' })
  })
})
