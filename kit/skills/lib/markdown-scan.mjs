/**
 * markdown-scan.mjs —— 全仓唯一的 Markdown 结构扫描内核：围栏状态机、标题行区间索引与无头摘要。
 *
 * 零第三方依赖、零磁盘 I/O（纯字符串输入输出），供 `kit/skills/` 与 `scripts/lib/markdown.mjs`
 * 共同复用，严守单一真相源与 `arch-rules` 单向隔离边界。
 */

import { EXIT } from './exit-codes.mjs'

/**
 * 逐行扫描，同时给出偏移量、围栏状态与标题。所有结构判据都从这里取。
 *
 * 围栏按 CommonMark 常见形态：起始围栏可带语言标记，闭合围栏须同类字符且不短于起始长度
 * （` ``` ` 与 ` ~~~~ ` 不互相闭合）。
 * `start` 是本行首字符偏移，`end` 是本行行尾符之后的偏移（末行无行尾符时即文末）。
 */
export function scanLines(text) {
  const src = String(text ?? '')
  const out = []
  let fence = null // { marker: '`' | '~', len: n }
  let offset = 0
  let i = 0
  for (const raw of src.split('\n')) {
    const start = offset
    offset = Math.min(start + raw.length + 1, src.length)
    const line = raw.replace(/\r$/, '')
    const info = {
      line,
      raw,
      index: i,
      start,
      end: offset,
      inFence: fence !== null,
      fenceEvent: null,
      heading: null,
    }
    i += 1
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
 * 围栏覆盖的区间（`[起点, 终点)` 列表）。围栏扫描的唯一出口。
 *
 * 未闭合的围栏一直算到文末，避免把代码里的标记或 `#` 注释当成正文结构。
 */
export function fencedSpans(text) {
  const src = String(text ?? '')
  const spans = []
  let openAt = -1
  for (const info of scanLines(src)) {
    if (info.fenceEvent === 'open') openAt = info.start
    else if (info.fenceEvent === 'close' && openAt >= 0) { spans.push([openAt, info.end]); openAt = -1 }
  }
  if (openAt >= 0) spans.push([openAt, src.length])
  return spans
}

/**
 * 某个标记在围栏之外且独占一行的出现位置（升序）。
 */
export function markerPositions(text, marker, spans = fencedSpans(text)) {
  const src = String(text ?? '')
  const out = []
  for (let i = src.indexOf(marker); i >= 0; i = src.indexOf(marker, i + marker.length)) {
    if (spans.some(([a, b]) => i >= a && i < b)) continue
    const lineStart = src.lastIndexOf('\n', i - 1) + 1
    const before = src.slice(lineStart, i)
    if (!/^[ \t]*$/.test(before)) continue
    let lineEnd = src.indexOf('\n', i + marker.length)
    if (lineEnd < 0) lineEnd = src.length
    const after = src.slice(i + marker.length, lineEnd)
    if (!/^[ \t]*\r?$/.test(after)) continue
    out.push(i)
  }
  return out
}

/**
 * 按二级标题把一份 Markdown 切成「前言 + 若干节」。全仓唯一实现。
 */
export function splitSections(text) {
  const src = String(text ?? '')
  const lines = scanLines(src)
  const heads = lines
    .map((info, i) => ({ info, i }))
    .filter((x) => !x.info.inFence && x.info.heading !== null && x.info.heading.level === 2)
  if (heads.length === 0) return { head: src, sections: [] }
  const head = lines.slice(0, heads[0].i).map((l) => l.raw).join('\n')
  const sections = heads.map(({ info }, k) => {
    const endLine = k + 1 < heads.length ? heads[k + 1].i : lines.length
    const body = lines.slice(heads[k].i, endLine).map((l) => l.raw)
    const end = k + 1 < heads.length ? heads[k + 1].info.start : src.length
    return { heading: info.line.trim(), lines: body, text: body.join('\n'), start: info.start, end }
  })
  return { head, sections }
}

/** 识别文档头部 YAML Frontmatter 的闭合 `---` 所在 0-based 行索引；无有效 Frontmatter 返回 -1。 */
export function findFrontmatterEndLine(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return -1
  if (lines[0].line.trim() !== '---') return -1
  let hasYamlKey = false
  let nonEmpty = 0
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].line.trim()
    if (t === '---') {
      return (nonEmpty === 0 || hasYamlKey) ? i : -1
    }
    if (t && !t.startsWith('#')) {
      nonEmpty += 1
      if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[i].line)) hasYamlKey = true
    }
  }
  return -1
}

function unquoteScalar(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === 'null' || s === '~') return ''
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
  }
  if (s.startsWith('\'') && s.endsWith('\'') && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, '\'').trim()
  }
  return s
}

function readFrontmatterFields(lines, fmEnd) {
  const fields = {}
  if (fmEnd <= 0) return fields
  for (let i = 1; i < fmEnd; i += 1) {
    const raw = lines[i].line
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const tail = kv[2].trim()
    if (!['summary', 'description', 'abstract', 'excerpt', 'title'].includes(key)) continue
    if (/^[|>][+-]?$/.test(tail)) {
      const parts = []
      let j = i + 1
      while (j < fmEnd && (lines[j].line.trim() === '' || /^\s+/.test(lines[j].line))) {
        const piece = lines[j].line.trim()
        if (piece) parts.push(piece)
        j += 1
      }
      if (parts.length > 0) fields[key] = parts.join(' ')
      i = j - 1
    } else if (tail) {
      const val = unquoteScalar(tail)
      if (val) fields[key] = val
    }
  }
  return fields
}

function cleanInlineMarkdown(raw) {
  return String(raw ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(text, maxLength = 180) {
  const s = String(text ?? '').trim()
  if (s.length <= maxLength) return s
  return `${s.slice(0, Math.max(12, maxLength - 3)).trimEnd()}...`
}

function extractFirstParagraph(lines, startIdx, endIdxExclusive, maxLength = 180) {
  const collected = []
  let inHtmlComment = false
  for (let i = Math.max(0, startIdx); i < Math.min(lines.length, endIdxExclusive); i += 1) {
    const info = lines[i]
    if (info.inFence) {
      if (collected.length > 0) break
      continue
    }
    const t = info.line.trim()
    if (inHtmlComment) {
      if (t.includes('-->')) inHtmlComment = false
      continue
    }
    if (t.startsWith('<!--')) {
      if (!t.includes('-->')) inHtmlComment = true
      if (collected.length > 0) break
      continue
    }
    if (!t) {
      if (collected.length > 0) break
      continue
    }
    if (info.heading !== null) {
      if (collected.length > 0) break
      continue
    }
    if (/^(?:---+|\*\*\*+|___+)$/.test(t)) {
      if (collected.length > 0) break
      continue
    }
    if (/^\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(t)) continue
    if (/^\[?!\[[^\]]*\]\([^)]*\)\]?(?:\([^)]*\))?$/.test(t)) continue

    const stripped = t.replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').trim()
    if (!stripped) continue
    collected.push(stripped)
    if (collected.length >= 3 || collected.join(' ').length >= maxLength) break
  }
  return truncateText(cleanInlineMarkdown(collected.join(' ')), maxLength)
}

/**
 * 为 Markdown 构建精确标题-行区间索引（1-based 行号，跳过代码围栏与 YAML Frontmatter）。
 *
 * 每节 `endLine` 延伸至下一同级或更高级标题之前（去掉末尾纯空行，且保证 `endLine >= startLine`）。
 *
 * @param {string} text
 * @returns {Array<{ level: number, title: string, startLine: number, endLine: number, summary: string }>}
 */
export function indexMarkdownSections(text) {
  const src = String(text ?? '')
  const lines = scanLines(src)
  const totalLines = lines.length > 1 && lines[lines.length - 1].raw === '' ? lines.length - 1 : lines.length
  const fmEnd = findFrontmatterEndLine(lines)

  const heads = []
  for (let i = fmEnd + 1; i < totalLines; i += 1) {
    const info = lines[i]
    if (!info.inFence && info.heading !== null) {
      heads.push({ idx: i, level: info.heading.level, title: info.heading.title })
    }
  }

  return heads.map((h, k) => {
    let endIdx = totalLines
    for (let m = k + 1; m < heads.length; m += 1) {
      if (heads[m].level <= h.level) {
        endIdx = heads[m].idx
        break
      }
    }
    let trimmedEnd = endIdx
    while (trimmedEnd > h.idx + 1 && lines[trimmedEnd - 1].line.trim() === '') {
      trimmedEnd -= 1
    }
    const ownEnd = k + 1 < heads.length ? Math.min(heads[k + 1].idx, trimmedEnd) : trimmedEnd
    const summary = extractFirstParagraph(lines, h.idx + 1, ownEnd)
      || extractFirstParagraph(lines, h.idx + 1, trimmedEnd)
      || ''
    return {
      level: h.level,
      title: h.title,
      startLine: h.idx + 1,
      endLine: Math.max(h.idx + 1, trimmedEnd),
      summary,
    }
  })
}

/**
 * 提取文档摘要（兼容无 Frontmatter / 无 H1 的无头文档与纯文本）。
 *
 * 回退优先级：`Frontmatter 摘要(summary/description/abstract/excerpt) -> Frontmatter title -> H1 -> 首段非空非围栏正文 -> 首个标题`。
 *
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function extractHeadlessSummary(text, { maxLength = 180 } = {}) {
  const src = String(text ?? '')
  if (!src.trim()) return ''
  const lines = scanLines(src)
  const totalLines = lines.length > 1 && lines[lines.length - 1].raw === '' ? lines.length - 1 : lines.length
  const fmEnd = findFrontmatterEndLine(lines)
  const fm = readFrontmatterFields(lines, fmEnd)

  for (const key of ['summary', 'description', 'abstract', 'excerpt']) {
    if (fm[key]) return truncateText(cleanInlineMarkdown(fm[key]), maxLength)
  }
  if (fm.title) return truncateText(cleanInlineMarkdown(fm.title), maxLength)

  let firstAnyHeading = ''
  for (let i = fmEnd + 1; i < totalLines; i += 1) {
    const info = lines[i]
    if (!info.inFence && info.heading !== null) {
      if (info.heading.level === 1) return truncateText(cleanInlineMarkdown(info.heading.title), maxLength)
      if (!firstAnyHeading) firstAnyHeading = cleanInlineMarkdown(info.heading.title)
    }
  }

  const para = extractFirstParagraph(lines, fmEnd + 1, totalLines, maxLength)
  if (para) return para
  return truncateText(firstAnyHeading, maxLength)
}

/**
 * 剥除 Markdown 围栏代码块与行内反引号片段（支持单反引号与多反引号包裹），
 * 供占位符检查与核心节实质性扫描隔离代码参数示例（如 `` `--top <n>` ``）。
 */
export function stripMarkdownCodeSpans(text, { preserveBareAngle = false } = {}) {
  const src = String(text ?? '')
  if (!src.includes('`') && !src.includes('~')) return src
  const spans = fencedSpans(src)
  let out = src
  if (spans.length > 0) {
    let buf = ''
    let cursor = 0
    for (const [a, b] of spans) {
      if (a > cursor) buf += src.slice(cursor, a)
      buf += '\n'
      cursor = Math.max(cursor, b)
    }
    if (cursor < src.length) buf += src.slice(cursor)
    out = buf
  }
  return out.replace(/(`+)([^\n]*?)\1/g, (full, _ticks, inner) => {
    if (preserveBareAngle && /^\s*<[^>\n]+>\s*$/.test(inner)) return full
    return ''
  })
}

/**
 * 将 Markdown 标题文本归一化为 GitHub 兼容的锚点 slug（保留 Unicode 字母数字、`_` 与 `-`）。
 */
export function slugifyHeading(rawTitle) {
  let s = String(rawTitle ?? '').trim()
  if (!s) return ''
  s = s.replace(/\s*\{#([A-Za-z0-9_.-]+)\}\s*$/, '')
  s = s.replace(/\s+#+\s*$/, '')
  s = s.replace(/<[^>]+>/g, '')
  s = cleanInlineMarkdown(s)
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * 提取 Markdown 全部有效标题与显式 HTML 锚点的归一化 slug 集合（跳过 YAML Frontmatter 与代码围栏）。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractHeadingSlugs(text) {
  const src = String(text ?? '')
  const slugs = new Set()
  if (!src.trim()) return slugs
  const lines = scanLines(src)
  const fmEnd = findFrontmatterEndLine(lines)
  const seenCounts = new Map()

  for (let i = fmEnd + 1; i < lines.length; i += 1) {
    const info = lines[i]
    if (info.inFence) continue
    if (info.heading !== null) {
      const raw = info.heading.title
      const customM = /\s*\{#([A-Za-z0-9_.-]+)\}\s*$/.exec(raw)
      if (customM) slugs.add(customM[1].toLowerCase())
      const base = slugifyHeading(raw)
      if (base) {
        const cnt = seenCounts.get(base) ?? 0
        seenCounts.set(base, cnt + 1)
        const indexed = cnt === 0 ? base : `${base}-${cnt}`
        slugs.add(indexed)
        const collapsed = indexed.replace(/-{2,}/g, '-')
        if (collapsed && collapsed !== indexed) slugs.add(collapsed)
      }
    }
    for (const am of info.line.matchAll(/<a\s+(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      const id = am[1].trim().toLowerCase()
      if (id) slugs.add(id)
    }
  }
  return slugs
}

/**
 * 校验待发送到远端平台的多节 Markdown 正文未被折叠成单行/双行。
 * 若发现同一行内出现段中标题或总行数过少的多节标题，抛出 `BLOCKED_MALFORMED_MARKDOWN_BODY`。
 */
export function assertWellFormedMarkdownBody(body, label = 'markdown正文') {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0)
  let inFence = false
  let headingCount = 0
  for (const rawLine of lines) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    const lineNoCode = rawLine.replace(/`[^`\n]*`/g, '')
    const hMatches = lineNoCode.match(/(?:^|\s)#{2,6}\s+\S/g)
    if (hMatches) {
      headingCount += hMatches.length
      if (hMatches.length >= 2) {
        const err = new Error(`BLOCKED_MALFORMED_MARKDOWN_BODY: ${label} 出现同多行标题折叠到单行，请保留正常换行。`)
        err.code = 'BLOCKED_MALFORMED_MARKDOWN_BODY'
        err.exitCode = EXIT.FACT
        throw err
      }
    }
  }
  if (headingCount >= 2 && nonEmptyLines.length <= 2) {
    const err = new Error(`BLOCKED_MALFORMED_MARKDOWN_BODY: ${label} 存在 ${headingCount} 个章节标题但有效行数仅 ${nonEmptyLines.length} 行，疑似换行丢失。`)
    err.code = 'BLOCKED_MALFORMED_MARKDOWN_BODY'
    err.exitCode = EXIT.FACT
    throw err
  }
}

export function stripHtmlCommentsOutsideFences(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inFence = false
  let inComment = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) { out.push(line); continue }
    let cur = line
    if (inComment) {
      const endIdx = cur.indexOf('-->')
      if (endIdx < 0) continue
      cur = cur.slice(endIdx + 3)
      inComment = false
    }
    while (cur.includes('<!--')) {
      const start = cur.indexOf('<!--')
      const end = cur.indexOf('-->', start + 4)
      if (end >= 0) {
        cur = `${cur.slice(0, start)}${cur.slice(end + 3)}`
      } else {
        cur = cur.slice(0, start)
        inComment = true
        break
      }
    }
    out.push(cur.trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function parseSectionHeaderLine(line) {
  const s = String(line ?? '')
  const h = /^(#{2,3})\s+(.+?)\s*$/.exec(s)
  if (h) return { kind: 'heading', level: h[1].length, title: h[2] }
  const b = /^\*\*([^*]+?)\*\*\s*(?:[:：]\s*)?$/.exec(s.trim())
  if (b) return { kind: 'bold', level: 4, title: b[1] }
  return null
}

function endsCurrentSection(outerHdr, nextHdr) {
  if (!nextHdr) return false
  if (outerHdr.kind === 'bold') return true
  return nextHdr.kind === 'heading' && nextHdr.level <= outerHdr.level
}

function matchHeadingCandidates(rawTitle, headingCandidates) {
  const clean = String(rawTitle ?? '')
    .replace(/^(?:\d+[.)、]\s*|[一二三四五六七八九十]+[、.)]\s*)/, '')
    .replace(/[:：]\s*$/, '')
    .trim()
  const low = clean.toLowerCase()
  return headingCandidates.some((cand) => (cand instanceof RegExp ? cand.test(clean) : String(cand).trim().toLowerCase() === low))
}

export function replaceSectionIfPresent(md, headingCandidates, newBody) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const hdr = parseSectionHeaderLine(lines[i])
    if (!hdr || !matchHeadingCandidates(hdr.title, headingCandidates)) continue
    let end = lines.length
    let innerFence = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[j])) { innerFence = !innerFence; continue }
      if (!innerFence && endsCurrentSection(hdr, parseSectionHeaderLine(lines[j]))) { end = j; break }
    }
    const replacement = [lines[i], '', ...String(newBody ?? '').split('\n'), '']
    const nextLines = [...lines.slice(0, i), ...replacement, ...lines.slice(end)]
    return { matched: true, text: nextLines.join('\n') }
  }
  return { matched: false, text: md }
}

export function removeSectionIfPresent(md, headingCandidates) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const hdr = parseSectionHeaderLine(lines[i])
    if (!hdr || !matchHeadingCandidates(hdr.title, headingCandidates)) continue
    let end = lines.length
    let innerFence = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[j])) { innerFence = !innerFence; continue }
      if (!innerFence && endsCurrentSection(hdr, parseSectionHeaderLine(lines[j]))) { end = j; break }
    }
    const nextLines = [...lines.slice(0, i), ...lines.slice(end)]
    return { matched: true, text: nextLines.join('\n') }
  }
  return { matched: false, text: md }
}
