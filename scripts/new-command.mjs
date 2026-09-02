#!/usr/bin/env node
// npm run command:new <name> —— 生成一个命令模块骨架到 commands/<name>.ts
import { writeFileSync, mkdirSync } from 'node:fs'

const name = process.argv[2]
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error('用法: npm run command:new <name>  (小写下划线, 如 find_file)')
  process.exit(1)
}

const path = `commands/${name}.ts`
mkdirSync('commands', { recursive: true })
writeFileSync(
  path,
  `import type { Command } from '../src/shared/types'

// TODO: 补 schema / aliases / agentTool 后即可被悬浮联想与 agent 使用
export const ${name}: Command = {
  id: '${name}',
  title: '${name}',
  aliases: ['${name}'],
  kind: 'quick',
  enabled: true,
  agentTool: true,
  run: async (input: unknown, ctx) => {
    const text = String(input ?? '').trim()
    if (!text) return { type: 'text', text: '请输入内容' }
    // TODO: 用 ctx.config / ctx.gateway / ctx.system 实现
    return { type: 'text', text: 'TODO' }
  },
}
`,
  'utf-8',
)
console.log(`created ${path} — 记得在 src/main/app.ts 的 builtinCommands 里注册它`)
