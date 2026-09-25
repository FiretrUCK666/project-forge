#!/usr/bin/env node
/**
 * sync-toc.mjs —— 让 Markdown 的目录与标题保持同步
 *
 * 目录是**派生内容**：它完全由文件里的标题决定。手工维护的派生内容一定会漂移——
 * 加了一节忘了加目录项、改了标题忘了改锚点。而锚点写错的表现是「点了没反应」，
 * 不报错、不显眼，作者通常不会去点自己的目录。
 *
 * 所以这里不写「记得同步」这种规则，而是把它变成一条命令：**从标题生成目录，
 * 插在标记之间，改完重跑即同步**。与 `compose-agents.mjs` 处理内核是同一个思路——
 * 能机械派生的东西，就交给工具派生，不靠人记。
 *
 * 用法：
 *   node scripts/sync-toc.mjs <文件.md> [更多文件...]     生成 / 刷新
 *   node scripts/sync-toc.mjs <文件.md> --check           只校验，不同步时退出码 1
 *   node scripts/sync-toc.mjs <文件.md> --max-level 2     只收二级标题（默认 2）
 *   node scripts/sync-toc.mjs <文件.md> --min-sections 5  少于这么多节就不加目录（默认 5）
 *
 * 识别三种现状，都不报错：
 *   - 已有标记对 → 就地刷新标记之间的内容（人写的其余部分一字不动）；
 *   - 有手写的目录节、没有标记 → 把那一节纳入标记管理后刷新（**不新增第二个目录**）；
 *   - 完全没有目录 → 节数够时才加；不够就明确说「不需要目录」并跳过。
 *
 * 结构识别一律走**同一份带围栏状态的扫描**（见 scanLines）：标题、目录节定位、
 * 插入点、损坏检查四处判据同源。分开写就会出现「生成时跳过代码块、定位时不跳过」
 * 这种自相矛盾——实测后果是目录被塞进代码块内部，并且把围栏闭合行一并删掉，
 * 而 `--check` 还说没问题。损坏（标记落在围栏内）时**拒绝写入**并说清怎么修，
 * 与 compose-agents 处理受损标记同一种做法：宁可不写，也不写坏。
 *
 * 本文件同时是**围栏扫描的唯一实现**：`scanLines` / `fencedSpans` / `markerPositions`
 * 导出去给 `compose-agents.mjs` 用。它要判的是同一件事（这对标记是不是真在正文里），
 * 两边各写一份状态机，就会出现同一个文件、同一种损坏，两处给出不同答案。
 * 所以入口必须能被安全引入：main 只在**本文件被直接执行**时才跑。
 *
 * 退出码：0 = 已同步 / 无需同步；1 = --check 发现不同步；2 = 用法或文件错误。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const START = '<!-- toc:start -->'
const END = '<!-- toc:end -->'

/** 目录节的标题写法：中英文常见几种，都认。 */
const TOC_HEADING_RE = /^##\s+(目录|目錄|Table of contents|Contents|TOC)\s*$/i

/**
 * 生成 GitHub 用的锚点。
 *
 * 规则以权威实现（`github-slugger@2`，GitHub 页面用的就是那一套）为准，逐条对拍过：
 *   `功能特性`                        → `功能特性`（中日韩字符原样保留）
 *   `1. 局域网访问`                    → `1-局域网访问`（标点去掉，空格变连字符）
 *   `A   B`                          → `a---b`（**每个空格各换一个连字符**，不折叠）
 *   `一　二`（全角空格）                → `一二`（非 ASCII 空白被**删除**，不换连字符）
 *   `说明①`（带圈数字）                → `说明`（`\p{No}` 这类序号形状会删掉）
 *   `snake_case 与 README_CN.md`      → `snake_case-与-readme_cnmd`（词内下划线**保留**）
 *   `_强调_`                          → `强调`（只有作强调定界符的下划线才去掉）
 *   `<图标> 功能特性`                  → `-功能特性`（标签与 emoji 去掉，前面的空格留下一个连字符）
 *
 * `selftest.mjs` 的「锚点以权威实现为准」一组，存的就是拿真实 `github-slugger@2`
 * 跑同一批标题得到的期望值（六处历史偏差——连续空格、全角空格、带圈数字、词内
 * 下划线被误删、重复标题同锚点、U+9FFD-9FFF——都已对齐）。
 * 剩下的差异只有两类，都不是错：
 *   - 标签、链接、强调、行内代码按**渲染后**的文字取。库直接吃原始 Markdown，
 *     于是 `<b>x</b>` 在它那里得到 `bxb`；GitHub 页面对的是渲染结果，故取本实现。
 *   - 库的数据表比 Unicode 落后，把后来分配的一批字母（如 U+9FFD-9FFF）也删掉。
 *     本实现按 Unicode 分类保留它们——那是它的表过期，不是规则。
 */
const SLUG_DROP = /[^\p{L}\p{N}\p{M}_ -]|\p{No}/u
/** 例外：这些形状按分类是标点或符号，但权威实现**保留**它们（逐码点实测得出）。 */
const SLUG_KEEP_EXCEPTIONS = /[\u{203F}-\u{2040}\u{2054}\u{24B6}-\u{24E9}\u{FE33}-\u{FE34}\u{FE4D}-\u{FE4F}\u{FF3F}]/u

/** 去掉行内标记，只留渲染后会出现在页面上的文字。 */
function stripInline(text) {
  return text
    .replace(/<((?:https?|mailto):[^>\s]*)>/gi, '$1') // 自动链接：渲染出来就是那个地址
    .replace(/<[^>]*>/g, '')                          // 其余 HTML 标签
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')        // 行内链接与图片：只留文字
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')         // 引用式链接：同上
}

/**
 * 下划线只在**作强调定界符**时去掉；词内下划线保留（`snake_case`、`README_CN.md`）。
 * 判据是「这一串下划线两侧是否都是文字或数字」——CommonMark 也不把词内下划线当强调，
 * 而 GitHub 的锚点取自渲染后的文字，词内那串于是原样留下。
 */
function stripUnderscoreDelimiters(text) {
  return text.replace(/_+/gu, (run, offset) => {
    const before = offset > 0 ? text[offset - 1] : ''
    const after = offset + run.length < text.length ? text[offset + run.length] : ''
    const wordish = (c) => c !== '' && /[\p{L}\p{N}]/u.test(c)
    return wordish(before) && wordish(after) ? run : ''
  })
}

function slug(text) {
  const lowered = stripUnderscoreDelimiters(stripInline(String(text)).trim().toLowerCase())
  let out = ''
  for (const ch of lowered) {
    if (SLUG_KEEP_EXCEPTIONS.test(ch)) { out += ch; continue }
    if (SLUG_DROP.test(ch)) continue
    out += ch
  }
  return out.replace(/ /g, '-')
}

/**
 * 逐行扫描，同时给出**偏移量**、围栏状态与标题。**所有结构判据都从这里取**。
 *
 * 围栏按 CommonMark 的常见形态：起始围栏可带语言标记，闭合围栏须同类字符且不短于
 * 起始长度（` ``` ` 与 ` ~~~~ ` 不互相闭合）。
 *
 * 带上偏移量是刻意的：改写文件时按偏移**切原字符串**，而不是把行拆开再按统一行尾
 * 拼回去。后者会把标记之外那些行尾不一的行悄悄改掉——文字一个字没动，字节动了，
 * 而「标记之外一个字节都不动」正是本工具对外承诺的那句话。
 * `start` 是本行首字符的位置，`end` 是本行行尾符之后的位置（末行没有行尾符时即文末）。
 */
export function scanLines(text) {
  const out = []
  let fence = null // { marker: '`' | '~', len: n }
  let offset = 0
  for (const raw of text.split('\n')) {
    const start = offset
    offset = Math.min(start + raw.length + 1, text.length)
    const line = raw.replace(/\r$/, '')
    const info = {
      line,
      raw,
      start,
      end: offset,
      inFence: fence !== null,
      fenceEvent: null,
      heading: null,
    }
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (m !== null && (fence === null || m[1][0] === fence.marker)) {
      if (fence === null) { fence = { marker: m[1][0], len: m[1].length }; info.fenceEvent = 'open' }
      else if (m[1].length >= fence.len && m[2].trim() === '') { fence = null; info.fenceEvent = 'close' }
      info.inFence = true
      out.push(info)
      continue
    }
    if (!info.inFence) {
      const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (h !== null) info.heading = { level: h[1].length, title: h[2] }
    }
    out.push(info)
  }
  return out
}

/**
 * 围栏覆盖的区间（`[起点, 终点)` 列表）。**围栏扫描的唯一出口**。
 *
 * 未闭合的围栏一直算到文末：那种文件的后半截在 Markdown 意义上就是代码，
 * 按「还在围栏里」处理才不会把代码里的标记当成正文的。
 */
export function fencedSpans(text) {
  const spans = []
  let openAt = -1
  for (const info of scanLines(text)) {
    if (info.fenceEvent === 'open') openAt = info.start
    else if (info.fenceEvent === 'close' && openAt >= 0) { spans.push([openAt, info.end]); openAt = -1 }
  }
  if (openAt >= 0) spans.push([openAt, text.length])
  return spans
}

/**
 * 某个标记在**围栏之外**的出现位置（升序）。
 *
 * 排除围栏内的出现不是洁癖：文档里在代码块里展示这对标记是正常的用法（本脚本的
 * 报错信息就是这么写的），把它算进去会得到「文件里有两对标记」这种错误答案，
 * 进而把一份好文件判成受损。
 */
export function markerPositions(text, marker, spans = fencedSpans(text)) {
  const out = []
  for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + marker.length)) {
    if (!spans.some(([a, b]) => i >= a && i < b)) out.push(i)
  }
  return out
}

/** 按原文件的主导行尾决定新内容的行尾；判不出来用 LF。 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * 去掉一段前缀末尾的空行（含最后那个换行本身）。
 *
 * 结果以**非空白字符**结尾，接上 `${eol}${eol}` 才正好是「内容 / 空行 / 空行 / 新内容」。
 * 少去一个换行会叠出三四行空白，多留一个换行会让围栏闭合行与新节之间多出一道空行。
 */
function trimTrailingBlanks(prefix) {
  return prefix.replace(/[ \t]*(?:\r?\n[ \t]*)+$/, '')
}

/** 抽出标题。**必须跳过围栏代码块**——代码块里以 `#` 开头的行不是标题。 */
function headings(text, maxLevel) {
  const out = []
  const seen = new Map()
  for (const info of scanLines(text)) {
    if (info.inFence || info.heading === null) continue
    const { level, title } = info.heading
    if (level < 2 || level > maxLevel) continue
    if (TOC_HEADING_RE.test(`## ${title}`)) continue // 目录自己不进目录
    // 同名标题：权威实现给第二个加 -1、第三个加 -2，并且**继续找第一个空位**。
    // 只加后缀不检查占用会造出两个同锚点——实测过，目录第二条会跳到第一条去。
    const original = slug(title)
    let id = original
    while (seen.has(id)) {
      seen.set(original, (seen.get(original) ?? 0) + 1)
      id = `${original}-${seen.get(original)}`
    }
    seen.set(id, 0)
    out.push({ level, title, id })
  }
  return out
}

/** 按标题生成目录正文。 */
function renderToc(items, eol) {
  const lines = []
  for (const it of items) {
    const indent = '  '.repeat(it.level - 2)
    lines.push(`${indent}- [${it.title}](#${it.id})`)
  }
  return lines.join(eol)
}

/**
 * 标记在文件里的状态。**判据只有一处**，标题、目录节定位、插入点、损坏检查都从这里取。
 *
 *   - `absent`：正文里没有这对标记（围栏内的展示不算）；
 *   - `ok`：围栏外恰好一对，附带两个偏移量；
 *   - `in-fence`：正文里一对都没有，但文件里出现过——**文件已经被写坏了**
 *     （旧版本会把目录插进代码块内部并吃掉围栏闭合行）。此时既不能刷新也不能读成
 *     「已是当前状态」：越修越坏，而且下一次 `--check` 会把损坏说成正常；
 *   - `reversed`：结束标记在开始标记之前；
 *   - `duplicated`：不止一对。
 *
 * 后三种一律**停下报错、不写文件**。
 */
function markerState(text) {
  const spans = fencedSpans(text)
  const starts = markerPositions(text, START, spans)
  const ends = markerPositions(text, END, spans)
  if (starts.length === 0 && ends.length === 0) {
    return text.includes(START) || text.includes(END) ? { kind: 'in-fence' } : { kind: 'absent' }
  }
  if (starts.length === 1 && ends.length === 1) {
    return starts[0] < ends[0]
      ? { kind: 'ok', startAt: starts[0], endAt: ends[0] }
      : { kind: 'reversed' }
  }
  return { kind: 'duplicated', starts: starts.length, ends: ends.length }
}

/** 状态异常时，把「这是什么、为什么停下、怎么手工修」说清楚，然后返回退出码 2。 */
function reportBroken(f, state) {
  const repair = `    ${START}\n    ${END}\n`
  if (state.kind === 'in-fence') {
    process.stderr.write(
      `${f}：目录标记落在代码围栏内部——文件已被写坏（目录被插进了代码块）。\n`
      + '  **本脚本没有改动它。** 请手工删掉围栏内的这一对标记：\n'
      + repair
      + '  删掉后重跑本脚本，它会在正确位置重建目录。\n',
    )
    return 2
  }
  if (state.kind === 'reversed') {
    process.stderr.write(
      `${f}：目录标记顺序颠倒——结束标记出现在开始标记之前。\n`
      + '  **本脚本没有改动它。** 请把这一对标记调回正确顺序（各一个）：\n'
      + repair,
    )
    return 2
  }
  const parts = []
  if (state.starts !== 1) parts.push(`开始标记 ${state.starts} 个（应为 1）`)
  if (state.ends !== 1) parts.push(`结束标记 ${state.ends} 个（应为 1）`)
  process.stderr.write(
    `${f}：目录标记不成对——${parts.join('，')}。\n`
    + '  **本脚本没有改动它。** 多半是复制粘贴了整段目录，或合并冲突留下了重复内容。\n'
    + '  请手工清理到恰好一对（各一个）：\n'
    + repair,
  )
  return 2
}

/**
 * 读一个数字选项。**校验与 compose-agents 的 --budget 同形**。
 *
 * 不校验的代价不是「报错」而是「换判据」：`Number(undefined)` 与 `Number('两')` 都是
 * NaN，而 NaN 与任何数比较都是 false，于是 `level > maxLevel` 恒真（筛选失效，标题被
 * 多收）、`items.length < minSections` 恒假（阈值失效，短文件也被加目录）。
 * 两种都静默成功、退出码 0，随后 `--check` 还会把结果读成「已是当前状态」。
 */
function readIntOption(flag, raw, min) {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n < min) {
    const shown = raw === undefined ? '（后面没有值）' : `「${raw}」`
    throw new Error(`${flag} 需要一个不小于 ${min} 的整数，收到 ${shown}。`)
  }
  return n
}

function main() {
  const args = process.argv.slice(2)
  const files = []
  let check = false
  let maxLevel = 2
  let minSections = 5

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--check') { check = true; continue }
    if (a === '--max-level' || a === '--min-sections') {
      try {
        const n = readIntOption(a, args[++i], a === '--max-level' ? 2 : 1)
        if (a === '--max-level') maxLevel = n
        else minSections = n
      } catch (error) {
        process.stderr.write(`错误：${error.message}\n`); return 2
      }
      continue
    }
    if (a === '--help' || a === '-h') {
      process.stdout.write('用法：node scripts/sync-toc.mjs <文件.md...> [--check] [--max-level N] [--min-sections N]\n')
      return 0
    }
    if (a.startsWith('--')) { process.stderr.write(`错误：无法识别的参数 ${a}\n`); return 2 }
    files.push(a)
  }
  if (files.length === 0) { process.stderr.write('用法：node scripts/sync-toc.mjs <文件.md...> [--check]\n'); return 2 }
  if (files.some((f) => !existsSync(f))) {
    process.stderr.write(`错误：文件不存在 ${files.find((f) => !existsSync(f))}\n`)
    return 2
  }

  let drifted = 0
  for (const f of files) {
    // 读一次、判一次。标记状态异常时**停下不写**，并说清是什么、怎么手工修
    //（与 compose-agents 同一种做法：宁可不写，也不写坏）。
    let text
    try {
      text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '')
    } catch (error) {
      process.stderr.write(`${f}：读不出来——${error.message}\n  **本脚本没有改动它。**\n`)
      return 2
    }
    const state = markerState(text)
    if (state.kind !== 'absent' && state.kind !== 'ok') return reportBroken(f, state)
    // 每次处理都清一遍残留临时文件，**不只在要写的时候**：上一次运行被杀时留下的
    // 临时文件，若这一轮判定「无需改动」就会一直留着，而顶层多出来的条目会被结构
    // 自检当成无主文件。
    clearStaleTemps(f)

    try {
      const items = headings(text, maxLevel)
      const eol = detectEol(text)
      const body = renderToc(items, eol)

      if (state.kind === 'ok') {
        const next = `${text.slice(0, state.startAt + START.length)}${eol}${eol}${body}${eol}${eol}${text.slice(state.endAt)}`
        if (next === text) {
          process.stdout.write(`${f}：目录已是当前状态（${items.length} 项）\n`)
        } else if (check) {
          drifted += 1
          process.stdout.write(`${f}：**目录与标题不同步**（应为 ${items.length} 项）\n`)
        } else {
          writeAtomic(f, next)
          process.stdout.write(`${f}：已刷新目录（${items.length} 项）\n`)
        }
        continue
      }

      if (items.length < minSections) {
        process.stdout.write(`${f}：${items.length} 节，少于阈值 ${minSections}，**不需要目录**\n`)
        continue
      }

      // 没有标记。分两种情况：已有手写目录节，或完全没有。
      // 判据取**围栏外**的行；接管手写目录时只吃「目录标题 + 紧随其后的连续列表项」，
      // 不用「标题到下一个标题」那种区间——那会把区间里的说明文字、乃至围栏闭合行
      // 一并吃掉（实测过）。
      const lines = scanLines(text)
      const tocAt = lines.findIndex(
        (l) => !l.inFence && l.heading !== null && l.heading.level === 2
          && TOC_HEADING_RE.test(`## ${l.heading.title}`),
      )
      if (tocAt >= 0) {
        // 只吃掉「目录标题之后的空行与列表项」，到**最后一个列表项**为止：
        // 之后的说明文字、引用块、围栏都留在原地。空行不算内容，但也不许越过它去
        // 吃后面的东西——那正是旧版本「标题到下一个标题」的区间式接管的病根。
        let lastItem = tocAt
        for (let i = tocAt + 1; i < lines.length; i += 1) {
          const l = lines[i]
          if (l.inFence || l.heading !== null) break
          const blank = l.line.trim() === ''
          const item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(l.line)
          if (!blank && !item) break
          if (item) lastItem = i
        }
        // 头尾都**按偏移切原字符串**：标记之外的那些行连同它们各自的行尾原样搬过去。
        const head = trimTrailingBlanks(text.slice(0, lines[tocAt].end))
        const tail = text.slice(lines[lastItem].end)
        const managed = `${head}${eol}${eol}${START}${eol}${eol}${body}${eol}${eol}${END}`
        const next = tail === '' ? `${managed}${eol}` : `${managed}${eol}${eol}${tail}`
        if (check) {
          drifted += 1
          process.stdout.write(`${f}：目录是手写的、还没纳入自动同步（${items.length} 项应生成）\n`)
        } else {
          writeAtomic(f, next)
          process.stdout.write(`${f}：已把手写目录纳入自动同步（${items.length} 项）\n`)
        }
        continue
      }

      // 完全没有目录：插在**围栏外的第一个二级标题**之前；没有二级标题就追加到文件末尾。
      // 前后各留一个空行：先按偏移切出头部、去掉它末尾的空行，再补两处，避免叠出三四行空白。
      const firstH2 = lines.findIndex((l) => !l.inFence && l.heading !== null && l.heading.level === 2)
      const tailStart = firstH2 >= 0 ? lines[firstH2].start : text.length
      const head = trimTrailingBlanks(text.slice(0, tailStart))
      const tail = text.slice(tailStart)
      const section = `## 目录${eol}${eol}${START}${eol}${eol}${body}${eol}${eol}${END}`
      const tailPart = tail === '' ? `${eol}` : `${eol}${eol}${tail}`
      const next = head === '' ? `${section}${tailPart}` : `${head}${eol}${eol}${section}${tailPart}`
      if (check) {
        drifted += 1
        process.stdout.write(`${f}：**缺少目录**（${items.length} 节，建议加）\n`)
      } else {
        writeAtomic(f, next)
        process.stdout.write(`${f}：已添加目录（${items.length} 项）\n`)
      }
    } catch (error) {
      process.stderr.write(
        `${f}：处理失败——${error instanceof Error ? error.message : String(error)}\n`
        + '  **本脚本没有改动它。**\n',
      )
      return 2
    }
  }

  if (check && drifted > 0) {
    // 含空格或中文的路径必须加引号，否则给出的「修正命令」照抄就失败（实测过）。
    const quoted = files.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(' ')
    // 提示里给脚本自己的路径：写死 scripts/ 时，脚本被放到别处（例如仓库的 tools/）后
    // 这条「照抄即修复」的命令会直接失败，而它恰恰是给人复制的。脚本路径自己同样要
    // 引号——装在带空格的目录下时，未加引号的这条命令照样跑不起来。
    const selfPath = resolve(process.argv[1] ?? 'sync-toc.mjs')
    const selfRel = relative(process.cwd(), selfPath) || 'sync-toc.mjs'
    const selfQuoted = /\s/.test(selfRel) ? `"${selfRel}"` : selfRel
    process.stderr.write(`\n${drifted} 个文件的目录需要同步。修正：node ${selfQuoted} ${quoted}\n`)
    return 1
  }
  return 0
}

/**
 * 清掉这个文件此前的临时文件（**任何**进程号留下的）。
 *
 * 只清自己那个进程号的等于没清：进程被杀掉时留下的是当时的进程号，下一次运行换了
 * pid，那个文件就永远躺在那里——而顶层多出来的条目会被结构自检当成无主文件
 * （见 preflight 的顶层目录整洁检查）。按「同目录、同前缀」匹配，不误删别人的文件。
 */
function clearStaleTemps(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try { unlinkSync(join(dir, name)) } catch { /* 清不掉就算了 */ }
  }
}

/**
 * 先写临时文件再改名：中途失败不会留下半截文件。
 *
 * 失败时清掉自己的临时文件：它带着 `.tmp-` 后缀留在仓库里，会被结构自检当成无主文件。
 */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8' })
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    throw error
  }
}

// 入口守卫：本文件同时是围栏扫描的实现方，被 compose-agents.mjs 引入时不能顺带跑一遍。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
