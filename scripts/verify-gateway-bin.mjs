// 校验内嵌 gateway 二进制与 checksums.txt 一致。
// 用途：① 本地替换二进制后自检；② CI/发布前确认打包进去的就是预期那一份（约 83MB 的 blob 必须可审计）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'resources', 'gateway')
const sums = readFileSync(join(DIR, 'checksums.txt'), 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [hash, rel] = l.split(/\s+/)
    return { hash, file: join(DIR, rel) }
  })

if (sums.length === 0) {
  console.error('checksums.txt 为空')
  process.exit(1)
}

let bad = 0
for (const { hash, file } of sums) {
  let actual
  try {
    actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (e) {
    console.error(`✗ 读取失败 ${file}: ${e.message}`)
    bad++
    continue
  }
  if (actual === hash) console.log(`✓ ${file.replace(ROOT + '/', '')}`)
  else {
    console.error(`✗ ${file.replace(ROOT + '/', '')}\n    期望 ${hash}\n    实际 ${actual}`)
    bad++
  }
}

if (bad > 0) {
  console.error(`\n${bad} 个文件不一致。若你有意替换了二进制，请更新 resources/gateway/checksums.txt 并在 README.md 记录新的源 commit。`)
  process.exit(1)
}
console.log('\n全部一致')
