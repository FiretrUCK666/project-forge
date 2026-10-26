#!/usr/bin/env node
/**
 * render-svg.mjs —— 把 README 的卡片渲染成位图，并**量出来**：内容有没有越界、
 * 四边留白对不对、指定那一列上的墨迹重心落在哪里。
 *
 * 为什么要有这个工具：SVG 的文字宽度不写在文件里，中文、英文、字重的实际占宽都不同，
 * 「看着差不多」正是上两次改版留下问题的原因（有一处标题超出画布 32 单位被裁掉）。
 * 所以判据必须是**渲染之后的像素**，而不是读源码时的估计。
 *
 * 用法：
 *   node scripts/dev/render-svg.mjs <卡片.svg> [--width 1200] [--expect-margin 64]
 *
 * 做法：用本机浏览器无头截图（宽度就是 GitHub 实际显示宽度），再用内置 zlib 解 PNG，
 * 与卡片底色逐像素比，算出内容外接矩形，最后打印一份量出来的结论。
 *
 * 退出码：0 = 四边留白达到要求且内容没有贴边；1 = 有越界或贴边。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..', '..')

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

function browser() {
  for (const b of BROWSERS) if (existsSync(b)) return b
  return undefined
}

/** 一个 PNG 里的像素：只支持 8 位 RGB/RGBA/灰度（这就是截图会产出的那几种）。 */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let at = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，这份是 ${bitDepth}`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (channels === undefined) throw new Error(`不支持的色彩类型 ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += Math.floor((a + b) / 2)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

/** 一张图的像素取值：统一成 [r,g,b]（灰度图复制三份，带 alpha 的按白底混合）。 */
function pixel(png, x, y) {
  const { channels, data } = png
  const at = (y * png.width + x) * channels
  if (channels === 1) return [data[at], data[at], data[at]]
  if (channels === 2) return [data[at], data[at], data[at]]
  const [r, g, b] = [data[at], data[at + 1], data[at + 2]]
  return [r, g, b]
}

/** 与底色差得够远就算「这里画了东西」。容差取 6：抗锯齿边缘不算内容。 */
const isInk = (p, bg) => Math.abs(p[0] - bg[0]) > 6 || Math.abs(p[1] - bg[1]) > 6 || Math.abs(p[2] - bg[2]) > 6

/**
 * 按行切出「内容带」：连续有墨迹的行算一带，带与带之间的空行就是间距。
 *
 * 为什么需要它：调纵向节奏时真正要动的是**带与带之间的空行**，而不是画布高度。
 * 只看「上留白 / 下留白」两个数，会得出一张「留白很均匀、内容全挤在中间」的卡片。
 *
 * 阈值 `minInk` 默认 2：纵向分隔线（stroke-width 1）每行只贡献 1 个像素，取 2 就把它
 * 滤掉了。不滤的话它会从第一条文字带一路连到最后一条，把整张卡的节奏糊成一带。
 */
function inkBands(png, bg, maxY, from, to, minInk = 2) {
  const bands = []
  let start = -1
  for (let y = 0; y <= maxY; y += 1) {
    let count = 0
    for (let x = from; x < to; x += 1) if (isInk(pixel(png, x, y), bg)) count += 1
    if (count >= minInk) {
      if (start < 0) start = y
    } else if (start >= 0) {
      bands.push({ top: start, bottom: y - 1 })
      start = -1
    }
  }
  if (start >= 0) bands.push({ top: start, bottom: maxY })
  return bands
}

function render(svgPath, width, outPath) {
  const exe = browser()
  if (exe === undefined) return { ok: false, why: '这台机器上没有找到 Chrome 或 Edge' }
  const r = spawnSync(exe, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${width},4000`,
    `--screenshot=${outPath}`,
    `file:///${svgPath.replace(/\\/g, '/')}`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  if (!existsSync(outPath)) {
    return { ok: false, why: `浏览器没产出截图（退出码 ${r.status}）：${(r.stderr ?? '').slice(0, 200)}` }
  }
  return { ok: true }
}

/** 卡片自己声明的画布尺寸。画布与内容对不上时必须当场说，不能靠渲染出来才发现。 */
function declaredSize(svgText) {
  const open = /<svg\b[^>]*>/.exec(svgText)?.[0] ?? ''
  const attr = (name) => Number(new RegExp(`${name}="([0-9.]+)"`).exec(open)?.[1])
  return { width: attr('width'), height: attr('height') }
}

function main(argv) {
  const svgArg = argv.find((a) => !a.startsWith('--'))
  if (svgArg === undefined) {
    process.stderr.write('用法：node scripts/dev/render-svg.mjs <卡片.svg> [--width 1200] [--expect-margin 64]\n')
    return 2
  }
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    return i < 0 ? fallback : Number(argv[i + 1])
  }
  const width = value('--width', 1200)
  const expectMargin = value('--expect-margin', 64)
  const svgPath = resolve(SKILL_ROOT, svgArg)
  if (!existsSync(svgPath)) { process.stderr.write(`找不到 ${svgPath}\n`); return 2 }

  const tmp = mkdtempSync(join(tmpdir(), 'pf-render-'))
  const pngPath = join(tmp, 'shot.png')
  try {
    const shot = render(svgPath, width, pngPath)
    if (!shot.ok) { process.stderr.write(`${shot.why}\n`); return 1 }
    const png = readPng(readFileSync(pngPath))
    const bg = pixel(png, 2, 2)
    // 浏览器会把窗口高度之外的空白截出来，所以真正的卡片底边 = 最后一行「有底色」的行。
    let cardBottom = 0
    for (let y = png.height - 1; y >= 0; y -= 1) {
      const p = pixel(png, 2, y)
      if (!isInk(p, [255, 255, 255]) || Math.abs(p[0] - bg[0]) < 6) { cardBottom = y; break }
    }
    let minX = png.width
    let maxX = -1
    let minY = png.height
    let maxY = -1
    let ink = 0
    for (let y = 0; y <= cardBottom; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        if (!isInk(pixel(png, x, y), bg)) continue
        ink += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (ink === 0) { process.stderr.write('整张图没有内容？请检查底色判断。\n'); return 1 }
    const declared = declaredSize(readFileSync(svgPath, 'utf8'))
    const name = svgArg.replace(/\\/g, '/')
    process.stdout.write(`\n${name}  （渲染宽度 ${width}）\n`)
    process.stdout.write(`  画布 ${png.width} × ${cardBottom + 1}（卡片声明 ${declared.width} × ${declared.height}）\n`)
    process.stdout.write(`  内容外接矩形 x ${minX}–${maxX}，y ${minY}–${maxY}\n`)
    process.stdout.write(`  四边留白：左 ${minX} / 右 ${png.width - 1 - maxX} / 上 ${minY} / 下 ${cardBottom - maxY}\n`)
    const problems = []
    // 画布声明与实际渲染高度必须一致：声明写错了（改了内容忘了改画布），卡片底部会凭空
    // 多出一条底色，或字形被裁掉——两种都不是「看着差不多」能放过的。
    if (declared.height !== cardBottom + 1) {
      problems.push(`画布声明高 ${declared.height}，实际渲染出 ${cardBottom + 1} —— 卡片的 height / viewBox 该改了`)
    }
    if (minX < expectMargin - 2) problems.push(`左边留白只有 ${minX}，小于 ${expectMargin}`)
    if (png.width - 1 - maxX < expectMargin - 2) problems.push(`右边留白只有 ${png.width - 1 - maxX}，小于 ${expectMargin}`)
    if (minY < 6) problems.push(`顶到上边缘（${minY}）`)
    if (cardBottom - maxY < 6) problems.push(`顶到下边缘（${cardBottom - maxY}）`)
    if (Math.abs(minX - (png.width - 1 - maxX)) > 2) {
      problems.push(`左右留白不对称：左 ${minX}、右 ${png.width - 1 - maxX}`)
    }

    // 指定了某个 x 区间时，再量这一带里墨迹的重心落在哪——箭头有没有居中靠它判。
    const spanArg = argv.indexOf('--ink-center')
    if (spanArg >= 0) {
      const [from, to] = String(argv[spanArg + 1]).split('-').map(Number)
      let sum = 0
      let count = 0
      for (let y = 0; y <= cardBottom; y += 1) {
        for (let x = from; x < to; x += 1) {
          if (isInk(pixel(png, x, y), bg)) { sum += x; count += 1 }
        }
      }
      const want = Number(argv[spanArg + 2])
      const center = count === 0 ? undefined : sum / count
      process.stdout.write(`  区间 ${from}–${to} 里墨迹重心：${center === undefined ? '（这一带没有内容）' : center.toFixed(1)}`
        + `${Number.isFinite(want) ? `，期望 ${want}` : ''}\n`)
      if (center === undefined) problems.push(`区间 ${from}–${to} 里没有内容，无法核对位置`)
      else if (Number.isFinite(want) && Math.abs(center - want) > 3) {
        problems.push(`区间 ${from}–${to} 的墨迹重心在 ${center.toFixed(1)}，与期望的 ${want} 差得超过 3`)
      }
    }

    if (problems.length > 0) {
      for (const p of problems) process.stdout.write(`  不合格：${p}\n`)
      return 1
    }

    // 指定了 --bands 时，把纵向节奏摊开：每一条内容带的起止，以及带与带之间的空行。
    //
    // 这一项存在的理由：判「画布加高而内容没动」不能靠肉眼。上留白与下留白同时变大、
    // 而带间距一个没变，就是那种情况的指纹——它看起来「留白很足」，其实什么都没重排。
    const bandArg = argv.indexOf('--bands')
    if (bandArg >= 0) {
      const [from, to] = String(argv[bandArg + 1] ?? `64-${png.width - 64}`).split('-').map(Number)
      const bands = inkBands(png, bg, cardBottom, from, to)
      process.stdout.write(`  纵向节奏（x ${from}–${to}，共 ${bands.length} 带）：\n`)
      let prev
      for (const b of bands) {
        const gap = prev === undefined ? '' : `　↑ 空 ${b.top - prev - 1}`
        process.stdout.write(`    ${String(b.top).padStart(4)}–${String(b.bottom).padEnd(4)} 高 ${String(b.bottom - b.top + 1).padStart(3)}${gap}\n`)
        prev = b.bottom
      }
      const gaps = bands.slice(1).map((b, i) => b.top - bands[i].bottom - 1)
      if (gaps.length > 0) {
        // 间距的离散程度是「节奏是否统一」的直接指标：一串块之间本该等距，
        // 差得太多说明某处是硬塞进去的，而不是排出来的。
        const uniq = [...new Set(gaps)]
        process.stdout.write(`  带间距：${gaps.join(' / ')}`
          + `${uniq.length === 1 ? '（等距）' : `（${uniq.length} 种，不等距）`}\n`)
      }
    }

    process.stdout.write('  合格：画布与内容一致，没有越界，留白对称\n')
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

process.exitCode = main(process.argv.slice(2))
