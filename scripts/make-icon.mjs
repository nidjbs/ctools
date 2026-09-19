// 生成应用图标（无第三方依赖）：SDF 绘制 + 超采样抗锯齿 → PNG → .iconset → .icns
// 用法：node scripts/make-icon.mjs
// 产物：build/icon.png（1024）与 build/icon.icns
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'build')
const SIZE = 1024
const SS = 3 // 每像素的每轴子采样数（抗锯齿）

// ---------- 绘制基元（归一化坐标 0..1） ----------
/** 圆角矩形有符号距离（<0 在形状内）。 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
/** 胶囊/线段的有符号距离。 */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

// 品牌：应用内主色 #2f4fcf，做轻微竖向渐变
const BG_TOP = hex('#3c5ce8')
const BG_BOTTOM = hex('#22308f')
const FG = hex('#ffffff')

/** 采样一点的颜色与 alpha（归一化坐标）。 */
function sample(u, v) {
  // 底：Apple 风格圆角方块（半宽 0.40、圆角 0.18）
  const bgD = sdRoundRect(u, v, 0.5, 0.5, 0.4, 0.4, 0.18)
  if (bgD > 0) return [0, 0, 0, 0]
  // 前景：命令提示符「> _」
  const chevron = Math.min(
    sdSegment(u, v, 0.35, 0.36, 0.475, 0.5, 0.042),
    sdSegment(u, v, 0.475, 0.5, 0.35, 0.64, 0.042),
  )
  const cursor = sdSegment(u, v, 0.55, 0.645, 0.69, 0.645, 0.042)
  const fg = Math.min(chevron, cursor)

  if (fg <= 0) return [...FG, 255]
  // 渐变底
  const t = v
  const c = BG_TOP.map((a, i) => Math.round(a + (BG_BOTTOM[i] - a) * t))
  return [...c, 255]
}

/** 逐像素超采样 → RGBA。 */
function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4)
  const inv = 1 / SIZE
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) * inv
          const v = (y + (sy + 0.5) / SS) * inv
          const [cr, cg, cb, ca] = sample(u, v)
          const w = ca / 255
          r += cr * w
          g += cg * w
          b += cb * w
          a += ca
        }
      }
      const n = SS * SS
      const aa = a / n
      const wsum = a / 255 || 1
      const i = (y * SIZE + x) * 4
      buf[i] = Math.round(r / wsum)
      buf[i + 1] = Math.round(g / wsum)
      buf[i + 2] = Math.round(b / wsum)
      buf[i + 3] = Math.round(aa)
    }
  }
  return buf
}

// ---------- 最小 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 生成 ----------
mkdirSync(OUT, { recursive: true })
const png = encodePng(render(), SIZE)
writeFileSync(join(OUT, 'icon.png'), png)
console.log(`wrote build/icon.png (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`)

// .icns：由 png 缩放出各尺寸 iconset，再 iconutil 打包
const iconset = join(OUT, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
const VARIANTS = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]
for (const [px, name] of VARIANTS) {
  execFileSync('sips', ['-z', String(px), String(px), join(OUT, 'icon.png'), '--out', join(iconset, name)], {
    stdio: 'ignore',
  })
}
copyFileSync(join(OUT, 'icon.png'), join(iconset, 'icon_512x512@2x.png'))
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
console.log('wrote build/icon.icns')
