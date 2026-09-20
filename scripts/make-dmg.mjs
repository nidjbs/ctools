// 用 macOS 自带的 hdiutil 制作 .dmg（不依赖 electron-builder 的 dmg 目标）。
//
// 为什么不用 electron-builder 的 dmg target：它会去 GitHub Releases 下载 dmgbuild 辅助包，
// 而在网络受限的环境（含本机）拉不下来；hdiutil 是系统自带，离线即可复现。
//
// 用法：npm run dist:dmg   （先 electron-builder --dir 产出 .app，再本脚本包成 dmg）
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const pkg = JSON.parse(execFileSync('cat', [join(ROOT, 'package.json')], { encoding: 'utf-8' }))
const PRODUCT = pkg.build?.productName ?? 'cTools'
const VERSION = pkg.version

/** 找到 electron-builder 产出的 .app（arm64 → dist/mac-<arch>，x64 → dist/mac）。 */
function findApp(arch) {
  const candidates =
    arch === 'arm64'
      ? [join(DIST, 'mac-arm64', `${PRODUCT}.app`)]
      : [join(DIST, 'mac', `${PRODUCT}.app`), join(DIST, 'mac-x64', `${PRODUCT}.app`)]
  for (const c of candidates) if (existsSync(c)) return c
  const found = readdirSync(DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(DIST, d.name, `${PRODUCT}.app`))
    .find((p) => existsSync(p))
  return found
}

function makeDmg(arch) {
  const app = findApp(arch)
  if (!app) {
    console.error(`✗ 未找到 ${PRODUCT}.app（arch=${arch}）——先跑 npm run dist:dir 或 electron-builder --dir`)
    return false
  }
  const out = join(DIST, `${PRODUCT}-${VERSION}-${arch}.dmg`)
  const stage = mkdtempSync(join(tmpdir(), 'ctools-dmg-'))
  try {
    // 暂存目录 = .app + 指向 /Applications 的软链，用户拖一下即可安装
    cpSync(app, join(stage, `${PRODUCT}.app`), { recursive: true })
    symlinkSync('/Applications', join(stage, 'Applications'))
    rmSync(out, { force: true })
    // UDZO = 压缩只读映像；-ov 覆盖；-volname 是挂载后显示的卷名
    execFileSync(
      'hdiutil',
      ['create', '-volname', `${PRODUCT} ${VERSION}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', out],
      { stdio: 'pipe' },
    )
    const size = (execFileSync('du', ['-h', out], { encoding: 'utf-8' }).split('\t')[0] ?? '').trim()
    console.log(`✓ ${out.replace(ROOT + '/', '')}  (${size})`)
    return true
  } catch (e) {
    console.error(`✗ 制作 dmg 失败（${arch}）：${e.message}`)
    return false
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

mkdirSync(DIST, { recursive: true })
const arches = process.argv.slice(2).filter((a) => a === 'arm64' || 'x64')
const targets = arches.length ? arches : ['arm64', 'x64']
let ok = 0
for (const a of targets) if (makeDmg(a)) ok++
console.log(`\n${ok}/${targets.length} 个 dmg 生成成功`)
process.exit(ok === targets.length ? 0 : 1)
