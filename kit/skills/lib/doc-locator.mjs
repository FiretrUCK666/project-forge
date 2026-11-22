/**
 * doc-locator.mjs —— 零写入按需定位引擎（Markdown 节区间 + 代码符号边界 + 无头文档摘要）。
 *
 * 严格只读红线：仅调用 `node:fs` 只读 API（`existsSync`/`readdirSync`/`readFileSync`/`statSync`），
 * 严禁创建、修改或写入任何文件；不派生外部子进程以保证单次定位控制在 ~40–120ms 预算内。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { BROAD_CODE_EXT_RE, COMMON_SKIP_DIRS, canonicalPath, isMacOsJunkPath, posixPath } from './git.mjs'
import {
  extractHeadlessSummary, findFrontmatterEndLine, indexMarkdownSections, scanLines,
} from './markdown-scan.mjs'
import { stripCodeCommentsLines } from './static-gates-lexer.mjs'
import { isSymbolRuleSupported, languageOf } from './symbol-index.mjs'
import { isToolOwnedPath } from './tool-owned.mjs'

export const VALID_LOCATE_KINDS = Object.freeze(['prd', 'spec', 'todo', 'adr', 'doc', 'code'])
export const VALID_LOCATE_SCOPES = Object.freeze(['docs', 'src', 'all'])

const DOC_EXT_RE = /\.(?:md|mdx|txt|rst)$/i
const CODE_EXT_RE = BROAD_CODE_EXT_RE
const MAX_READ_BYTES = 512 * 1024
const MAX_LINE_CHARS = 220

const JS_DEF_RULES = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
]

const SYMBOL_DEF_PATTERNS = Object.freeze({
  powershell: [/\bfunction\s+(?:global:|script:|local:)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[({]/i],
  bash: [/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/, /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(\[]/, /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/],
  javascript: JS_DEF_RULES,
  typescript: [...JS_DEF_RULES, /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/],
  python: [/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/],
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/],
  java: [/^\s*(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/],
  kotlin: [/^\s*(?:public\s+|internal\s+|private\s+)?(?:data\s+|sealed\s+|open\s+|abstract\s+)?(?:class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*\(/],
  csharp: [/^\s*(?:public\s+|internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*(?:public\s+|internal\s+|private\s+|protected\s+)(?:static\s+|async\s+|virtual\s+|override\s+)*[A-Za-z_][A-Za-z0-9_<>,\[\]?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
  php: [/^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
  ruby: [/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[?!=]?)/, /^\s*(?:class|module)\s+([A-Z][A-Za-z0-9_:]*)/],
})

function readTextFast(absPath) {
  try {
    const buf = readFileSync(absPath)
    if (buf.length > MAX_READ_BYTES || buf.subarray(0, 1024).includes(0)) return undefined
    const s = buf.toString('utf8')
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
  } catch {
    return undefined
  }
}

/** 根据路径与头部内容判定文档/源码类别：`prd | spec | todo | adr | doc | code | other`。 */
export function classifyFileKind(relPath, text = '') {
  const rel = posixPath(String(relPath ?? '')).replace(/^\.\//, '')
  const low = rel.toLowerCase()
  const base = basename(low)
  if (CODE_EXT_RE.test(base)) return 'code'
  if (!DOC_EXT_RE.test(base)) return 'other'
  if (/(?:^|\/)(?:docs\/(?:archive\/)?)?prd\//.test(low) || /-prd\.md$/.test(base)) return 'prd'
  if (/(?:^|\/)(?:docs\/(?:archive\/)?)?specs?\//.test(low) || /-spec\.md$/.test(base)) return 'spec'
  if (/(?:^|\/)(?:docs\/(?:archive\/)?)?todo\//.test(low) || /-todo\.md$/.test(base)) return 'todo'
  if (/(?:^|\/)(?:docs\/)?(?:adr|decisions)\//.test(low) || /^adr[-_]/.test(base)) return 'adr'
  if (text) {
    const km = /^\s*kind\s*:\s*['"]?(prd|spec|todo|adr)['"]?\s*$/im.exec(String(text).slice(0, 600))
    if (km) return km[1].toLowerCase()
  }
  return 'doc'
}

function isDocKind(kind) {
  return kind === 'prd' || kind === 'spec' || kind === 'todo' || kind === 'adr' || kind === 'doc'
}

function quoteCliArg(value) {
  return `"${String(value ?? '').replace(/"/g, '\\"')}"`
}

function buildLocateCommand(relPath, { section = null, symbol = null, query = null } = {}) {
  const base = `node .agents/skills/dev-explore/scripts/doc-locate.mjs --file ${quoteCliArg(relPath)}`
  if (section) {
    const secArg = section.length > 44 ? section.slice(0, 40).trimEnd() : section
    return `${base} --section ${quoteCliArg(secArg)}`
  }
  if (symbol) return `${base} --symbol ${quoteCliArg(symbol)}`
  if (query) return `${base} --query ${quoteCliArg(query)}`
  return base
}

function parseQueryTerms(query) {
  const raw = String(query ?? '').trim()
  if (!raw) return { primary: [], all: [], groups: [] }
  const primary = []
  const all = new Set()
  const groups = []
  for (const part of raw.split(/[\s,，;；|]+/).filter(Boolean)) {
    const clean = part.replace(/^[`"'()[\]{}]+|[`"'()[\]{}]+$/g, '').trim()
    if (!clean) continue
    const low = clean.toLowerCase()
    if (!primary.includes(low)) primary.push(low)
    all.add(low)
    const subs = /^[A-Za-z][A-Za-z0-9_-]{3,}$/.test(clean)
      ? clean.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().split(/\s+/).filter((s) => s.length >= 3)
      : []
    if (subs.length >= 2) {
      for (const s of subs) all.add(s)
      groups.push({ primary: low, subs })
    } else {
      groups.push({ primary: low, subs: [] })
    }
  }
  return { primary, all: [...all], groups }
}

function passesQueryPrefilter(lowText, relLow, queryTerms) {
  if (queryTerms.primary.length === 0) return true
  for (const g of queryTerms.groups) {
    if (lowText.includes(g.primary) || relLow.includes(g.primary)) return true
    if (g.subs.length >= 2 && g.subs.every((s) => lowText.includes(s) || relLow.includes(s))) return true
  }
  return false
}

function walkRepoFiles(absRoot, { scope = 'all', includeArchive = false, maxFiles = 6000 } = {}) {
  const active = []
  const archived = []
  const queue = [absRoot]
  while (queue.length > 0 && active.length + archived.length < maxFiles) {
    const dir = queue.shift()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(absRoot, full))
      if (!rel || isToolOwnedPath(rel)) continue
      if (entry.isDirectory()) {
        if (COMMON_SKIP_DIRS.has(entry.name)) continue
        if (scope === 'docs' && (entry.name === 'fixtures' || entry.name === '__mocks__')) continue
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const kind = classifyFileKind(rel)
      if (kind === 'other' || (scope === 'docs' && !isDocKind(kind)) || (scope === 'src' && kind !== 'code')) continue
      if (/^docs\/archive\//i.test(rel)) {
        if (includeArchive) archived.push({ rel, abs: full, kind, isArchive: true })
      } else {
        active.push({ rel, abs: full, kind, isArchive: false })
      }
    }
  }
  return { active, archived }
}

function maskStrings(line) {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      out += ' '
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; out += ' '; continue }
    out += ch
  }
  return out
}

function findSymbolEndLine(codeLines, startIdx, lang) {
  const total = codeLines.length
  if (lang === 'python') {
    const baseIndent = codeLines[startIdx].length - codeLines[startIdx].trimStart().length
    let endIdx = startIdx
    for (let i = startIdx + 1; i < total; i += 1) {
      if (!codeLines[i].trim()) continue
      if (codeLines[i].length - codeLines[i].trimStart().length <= baseIndent) break
      endIdx = i
    }
    return endIdx + 1
  }
  let braceDepth = 0; let parenDepth = 0; let seenBrace = false; let endIdx = startIdx
  for (let i = startIdx; i < total; i += 1) {
    for (const ch of maskStrings(codeLines[i])) {
      if (ch === '{') { braceDepth += 1; seenBrace = true }
      else if (ch === '}' && braceDepth > 0) braceDepth -= 1
      else if (ch === '(') parenDepth += 1
      else if (ch === ')' && parenDepth > 0) parenDepth -= 1
    }
    endIdx = i
    if (seenBrace && braceDepth === 0) return endIdx + 1
    if (!seenBrace && i >= startIdx + 2 && parenDepth === 0) return endIdx + 1
    if (!seenBrace && i === startIdx && parenDepth === 0 && !/[,=({\[]\s*$/.test(codeLines[i].trim()) && !(codeLines[i + 1] ?? '').trim().startsWith('{')) {
      return startIdx + 1
    }
  }
  return endIdx + 1
}

/** 在源码文本中定位符号定义区间（1-based `startLine..endLine`，单次词法剥注）。 */
export function locateSymbolsInText(text, ext, symbolQuery = '') {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  const rawLines = src.split('\n')
  const totalLines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length
  const cleanExt = String(ext ?? '').replace(/^\./, '').toLowerCase()
  const lang = languageOf(cleanExt)
  const rules = isSymbolRuleSupported(cleanExt) ? SYMBOL_DEF_PATTERNS[lang] : null
  const codeLines = stripCodeCommentsLines(src, cleanExt).slice(0, totalLines)
  const queryLow = String(symbolQuery ?? '').trim().toLowerCase()
  const hits = []

  if (rules) {
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i]
      if (!line.trim()) continue
      for (const rule of rules) {
        const m = rule.exec(line)
        if (!m?.[1]) continue
        const name = m[1]
        const nameLow = name.toLowerCase()
        let score = 50
        if (queryLow) {
          if (name === symbolQuery) score = 100
          else if (nameLow === queryLow) score = 90
          else if (nameLow.startsWith(queryLow)) score = 72
          else if (nameLow.includes(queryLow)) score = 58
          else continue
        }
        hits.push({
          symbol: name, startLine: i + 1,
          endLine: Math.min(totalLines, findSymbolEndLine(codeLines, i, lang)),
          score, summary: rawLines[i].trim().slice(0, 140),
        })
        break
      }
    }
  } else if (queryLow) {
    for (let i = 0; i < codeLines.length; i += 1) {
      if (codeLines[i].toLowerCase().includes(queryLow)) {
        hits.push({ symbol: symbolQuery, startLine: i + 1, endLine: Math.min(totalLines, i + 12), score: 40, summary: rawLines[i].trim().slice(0, 140) })
        break
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.startLine - b.startLine)
}

function sliceLines(rawLines, startLine, endLine, maxLines) {
  const sIdx = Math.max(0, startLine - 1)
  const eIdx = Math.min(rawLines.length, endLine)
  const available = Math.max(0, eIdx - sIdx)
  const take = Math.min(available, Math.max(1, maxLines))
  const body = rawLines.slice(sIdx, sIdx + take).map((l) => {
    const s = String(l ?? '')
    return s.length <= MAX_LINE_CHARS ? s : `${s.slice(0, MAX_LINE_CHARS - 3)}...`
  })
  return { snippet: body.join('\n'), usedLines: body.length, truncated: take < available }
}

function scoreTextByTokens(haystack, tokens, weight = 1) {
  if (!haystack || tokens.length === 0) return 0
  const low = haystack.toLowerCase()
  let hits = 0
  let totalOcc = 0
  for (const tok of tokens) {
    let pos = low.indexOf(tok)
    if (pos < 0) continue
    hits += 1
    let count = 0
    while (pos >= 0 && count < 5) { count += 1; pos = low.indexOf(tok, pos + tok.length) }
    totalOcc += count
  }
  return hits === 0 ? 0 : Math.round(((hits / tokens.length) * 30 + Math.min(20, totalOcc * 4)) * weight)
}

function scoreSectionMatch(title, query) {
  const t = String(title ?? '').trim().toLowerCase()
  const q = String(query ?? '').trim().toLowerCase()
  if (!t || !q) return 0
  if (t === q) return 100
  if (t.includes(q)) return 85
  const { all } = parseQueryTerms(q)
  if (all.length === 0) return 0
  const matched = all.filter((tok) => t.includes(tok)).length
  return matched > 0 ? Math.round(45 + (matched / all.length) * 35) : 0
}

function rankDefaultDocPriority(rel, kind) {
  const low = rel.toLowerCase()
  if (low === 'docs/tdd.md') return 98
  if (low === 'architecture.md' || low === 'docs/architecture.md') return 96
  if (low === 'agents.md') return 94
  if (/\/agents\.md$/.test(low)) return 90
  if (low === 'skill.md') return 88
  if (kind === 'spec') return 84
  if (kind === 'prd') return 82
  if (kind === 'todo') return 80
  if (kind === 'adr') return 78
  return low === 'readme.md' ? 76 : 60
}

function scoreDocCandidates(fileInfo, text, { section, queryTerms }) {
  const norm = text.replace(/\r\n/g, '\n')
  const rawLines = norm.split('\n')
  const totalLines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length
  const trimmedLines = rawLines.slice(0, totalLines)
  const sections = indexMarkdownSections(norm)
  const docSummary = extractHeadlessSummary(norm)
  const fmEnd = findFrontmatterEndLine(trimmedLines.slice(0, 80).map((line) => ({ line })))
  const bodyStartIdx = fmEnd >= 0 ? fmEnd + 1 : 0
  const archivePenalty = fileInfo.isArchive ? 0.35 : 1
  const tokens = queryTerms.all
  const out = []

  if (section) {
    for (const sec of sections) {
      const secScore = scoreSectionMatch(sec.title, section)
      if (secScore <= 0) continue
      const bonus = tokens.length > 0 ? scoreTextByTokens(trimmedLines.slice(sec.startLine - 1, sec.endLine).join('\n'), tokens, 0.5) : 0
      out.push({
        ...fileInfo, section: sec.title, symbol: null, startLine: sec.startLine, endLine: sec.endLine,
        score: Math.round((secScore + bonus) * archivePenalty), summary: sec.summary || docSummary, rawLines: trimmedLines,
      })
    }
    return out
  }

  if (tokens.length > 0) {
    const pathScore = scoreTextByTokens(fileInfo.rel, tokens, 0.8)
    const docSumScore = scoreTextByTokens(docSummary, tokens, 0.7)
    for (const sec of sections) {
      const titleScore = scoreTextByTokens(sec.title, tokens, 1.3)
      const secBody = trimmedLines.slice(sec.startLine - 1, sec.endLine).join('\n')
      const bodyScore = scoreTextByTokens(secBody, tokens, 0.9)
      const exactBoost = scoreTextByTokens(`${sec.title}\n${secBody}`, queryTerms.primary, 0.8)
      if (titleScore === 0 && bodyScore === 0 && pathScore === 0) continue
      const levelBias = sec.level === 1 && sections.length > 1 ? 0.75 : 1
      out.push({
        ...fileInfo, section: sec.title, symbol: null, startLine: sec.startLine, endLine: sec.endLine,
        score: Math.round((titleScore + bodyScore + exactBoost + pathScore + docSumScore * 0.4) * levelBias * archivePenalty),
        summary: sec.summary || docSummary, rawLines: trimmedLines,
      })
    }
    if (out.length === 0) {
      const bodyLines = trimmedLines.slice(bodyStartIdx)
      const bodyScore = scoreTextByTokens(bodyLines.join('\n'), tokens, 0.9)
      if (bodyScore > 0 || pathScore > 0 || docSumScore > 0) {
        const hitIdx = bodyLines.findIndex((l) => tokens.some((tok) => l.toLowerCase().includes(tok)))
        const sLine = Math.max(bodyStartIdx + 1, (hitIdx >= 0 ? bodyStartIdx + hitIdx : bodyStartIdx) - 2)
        out.push({
          ...fileInfo, section: null, symbol: null, startLine: sLine, endLine: Math.max(sLine, Math.min(totalLines, sLine + 24)),
          score: Math.round((bodyScore + pathScore + docSumScore) * archivePenalty), summary: docSummary, rawLines: trimmedLines,
        })
      }
    }
    return out
  }

  const firstSec = sections[0]
  const startLine = Math.max(1, firstSec ? firstSec.startLine : Math.min(totalLines, bodyStartIdx + 1))
  const endLine = Math.max(startLine, firstSec ? firstSec.endLine : Math.min(totalLines, startLine + 24))
  out.push({
    ...fileInfo, section: firstSec?.title ?? null, symbol: null, startLine, endLine,
    score: Math.round(rankDefaultDocPriority(fileInfo.rel, fileInfo.kind) * archivePenalty),
    summary: docSummary, rawLines: trimmedLines,
  })
  return out
}

function scoreCodeCandidates(fileInfo, text, { symbol, queryTerms }) {
  const src = text.replace(/\r\n/g, '\n')
  const rawLines = src.split('\n')
  const totalLines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length
  const ext = extname(fileInfo.rel).replace(/^\./, '')
  const trimmedLines = rawLines.slice(0, totalLines)
  const out = []

  if (symbol) {
    for (const hit of locateSymbolsInText(src, ext, symbol)) {
      out.push({ ...fileInfo, section: null, symbol: hit.symbol, startLine: hit.startLine, endLine: hit.endLine, score: hit.score, summary: hit.summary, rawLines: trimmedLines })
    }
    return out
  }

  const tokens = queryTerms.all
  if (tokens.length > 0) {
    const pathScore = scoreTextByTokens(fileInfo.rel, tokens, 1.0)
    for (const sym of locateSymbolsInText(src, ext, '')) {
      const symScore = scoreTextByTokens(sym.symbol, tokens, 1.4) + scoreTextByTokens(sym.symbol, queryTerms.primary, 1.0)
      if (symScore <= 0) continue
      const bodyScore = scoreTextByTokens(trimmedLines.slice(sym.startLine - 1, sym.endLine).join('\n'), tokens, 0.7)
      out.push({
        ...fileInfo, section: null, symbol: sym.symbol, startLine: sym.startLine, endLine: sym.endLine,
        score: Math.round(symScore + bodyScore + pathScore), summary: sym.summary, rawLines: trimmedLines,
      })
    }
    if (out.length === 0) {
      const bodyScore = scoreTextByTokens(src, tokens, 0.75) + scoreTextByTokens(src, queryTerms.primary, 0.8)
      if (bodyScore > 0 || pathScore > 0) {
        const hitIdx = trimmedLines.findIndex((l) => tokens.some((tok) => l.toLowerCase().includes(tok)))
        const sLine = Math.max(1, (hitIdx >= 0 ? hitIdx + 1 : 1) - 2)
        out.push({
          ...fileInfo, section: null, symbol: null, startLine: sLine, endLine: Math.max(sLine, Math.min(totalLines, sLine + 24)),
          score: Math.round(bodyScore + pathScore), summary: (trimmedLines[hitIdx >= 0 ? hitIdx : 0] ?? '').trim().slice(0, 140), rawLines: trimmedLines,
        })
      }
    }
    return out
  }

  const firstSym = locateSymbolsInText(src, ext, '')[0]
  out.push({
    ...fileInfo, section: null, symbol: firstSym?.symbol ?? null,
    startLine: firstSym?.startLine ?? 1, endLine: firstSym?.endLine ?? Math.min(totalLines, 30),
    score: 50, summary: firstSym?.summary ?? (trimmedLines[0] ?? '').trim().slice(0, 140), rawLines: trimmedLines,
  })
  return out
}

function applyBudgetToCandidates(candidates, { limit, budgetLines, query }) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.startLine - b.startLine)
  const picked = []
  const perFileCount = new Map()
  const multiFile = new Set(sorted.map((c) => c.rel)).size > 1
  for (const cand of sorted) {
    if (picked.length >= limit) break
    const overlaps = picked.some(
      (p) => p.rel === cand.rel && ((cand.startLine <= p.startLine && cand.endLine >= p.endLine)
        || (p.startLine <= cand.startLine && p.endLine >= cand.endLine)
        || (Math.abs(p.startLine - cand.startLine) <= 2 && p.section === cand.section && p.symbol === cand.symbol)),
    )
    if (overlaps) continue
    const fCount = perFileCount.get(cand.rel) ?? 0
    if (multiFile && fCount >= 2 && sorted.length > limit) continue
    perFileCount.set(cand.rel, fCount + 1)
    picked.push(cand)
  }

  let remainingBudget = Math.max(1, budgetLines)
  const slices = []
  let usedBudgetLines = 0
  for (let i = 0; i < picked.length; i += 1) {
    const c = picked[i]
    const slotsLeft = picked.length - i
    const fairShare = Math.max(4, Math.floor(remainingBudget / slotsLeft))
    const actualLen = Math.max(1, c.endLine - c.startLine + 1)
    const takeLines = Math.min(actualLen, Math.min(remainingBudget, slotsLeft === 1 ? remainingBudget : fairShare))
    const clipped = sliceLines(c.rawLines, c.startLine, c.endLine, takeLines)
    remainingBudget = Math.max(0, remainingBudget - clipped.usedLines)
    usedBudgetLines += clipped.usedLines
    slices.push({
      absPath: canonicalPath(c.abs), relPath: c.rel, kind: c.kind,
      section: c.section, symbol: c.symbol, startLine: c.startLine, endLine: c.endLine,
      lineCount: actualLen, truncated: clipped.truncated, score: c.score,
      summary: c.summary || '', snippet: clipped.snippet,
      locateCommand: buildLocateCommand(c.rel, { section: c.section, symbol: c.symbol, query: !c.section && !c.symbol ? query : null }),
    })
  }
  return { slices, usedBudgetLines, totalMatches: sorted.length }
}

/** 零写入只读定位入口：支持按文件、关键词、符号、标题节、类型与范围返回精确绝对路径与行区间切片。 */
export function locateDocuments(repoRoot = process.cwd(), options = {}) {
  const t0 = performance.now()
  const root = canonicalPath(options.worktree ?? repoRoot)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`目标目录不存在：${root}`)

  const kind = options.kind ? String(options.kind).trim().toLowerCase() : null
  if (kind && !VALID_LOCATE_KINDS.includes(kind)) throw new Error(`无效 --kind「${kind}」（允许：${VALID_LOCATE_KINDS.join(' | ')}）`)
  const rawScope = options.scope ? String(options.scope).trim().toLowerCase() : 'all'
  if (!VALID_LOCATE_SCOPES.includes(rawScope)) throw new Error(`无效 --scope「${rawScope}」（允许：${VALID_LOCATE_SCOPES.join(' | ')}）`)
  const effectiveScope = options.symbol && !options.scope && !kind ? 'src' : rawScope
  const limit = Number(options.limit ?? options.maxSlices ?? 5)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`无效 --limit「${options.limit ?? options.maxSlices}」（必须为正整数）`)
  const budgetLines = Number(options.budgetLines ?? 220)
  if (!Number.isInteger(budgetLines) || budgetLines <= 0) throw new Error(`无效 --budget-lines「${options.budgetLines}」（必须为正整数）`)

  const query = options.query ? String(options.query).trim() : null
  const section = options.section ? String(options.section).trim() : null
  const symbol = options.symbol ? String(options.symbol).trim() : null
  const queryTerms = parseQueryTerms(query)
  const symLow = symbol ? symbol.toLowerCase() : ''
  const secTerms = parseQueryTerms(section)

  let targetFiles = []; let archivedFiles = []; let fileRel = null
  if (options.file) {
    const rawFile = String(options.file).trim()
    const absTarget = canonicalPath(isAbsolute(rawFile) ? rawFile : resolve(root, rawFile))
    if (!existsSync(absTarget) || !statSync(absTarget).isFile()) throw new Error(`指定文件不存在：${rawFile}`)
    fileRel = posixPath(relative(root, absTarget))
    const detectedKind = classifyFileKind(fileRel)
    targetFiles = [{ rel: fileRel, abs: absTarget, kind: detectedKind === 'other' ? 'doc' : detectedKind, isArchive: /^docs\/archive\//i.test(fileRel) }]
  } else {
    const walked = walkRepoFiles(root, { scope: effectiveScope, includeArchive: true })
    targetFiles = walked.active
    archivedFiles = walked.archived
  }

  const candidates = []
  let scannedFiles = 0
  const processBatch = (batch) => {
    for (const item of batch) {
      if (kind && item.kind !== kind && item.kind !== 'doc') continue
      const text = readTextFast(item.abs)
      if (text === undefined) continue
      scannedFiles += 1
      const refinedKind = item.kind === 'doc' ? classifyFileKind(item.rel, text) : item.kind
      if (kind && refinedKind !== kind) continue
      if ((symbol && refinedKind !== 'code' && !options.file) || (section && !isDocKind(refinedKind) && !options.file)) continue

      const lowText = (symLow || queryTerms.primary.length > 0 || secTerms.all.length > 0) ? text.toLowerCase() : ''
      if (symLow && !lowText.includes(symLow)) continue
      if (!options.file && queryTerms.primary.length > 0 && !passesQueryPrefilter(lowText, item.rel.toLowerCase(), queryTerms)) continue
      if (!options.file && section && secTerms.all.length > 0 && !secTerms.all.some((tok) => lowText.includes(tok))) continue

      const enriched = { ...item, kind: refinedKind }
      if (refinedKind === 'code') candidates.push(...scoreCodeCandidates(enriched, text, { symbol, queryTerms }))
      else candidates.push(...scoreDocCandidates(enriched, text, { section, queryTerms }))
    }
  }

  processBatch(targetFiles)
  if (!options.file && candidates.length < limit && archivedFiles.length > 0 && (query || section || kind)) {
    processBatch(archivedFiles)
  }
  const { slices, usedBudgetLines, totalMatches } = applyBudgetToCandidates(candidates, { limit, budgetLines, query })
  return {
    root, scope: effectiveScope, kind, query, section, symbol, file: fileRel,
    limit, budgetLines, usedBudgetLines, scannedFiles,
    durationMs: Math.round((performance.now() - t0) * 10) / 10, totalMatches, slices,
  }
}

/** 供交棒包复用的 Top-3 定位入口：结合任务影响路径与关键词返回最相关文档切片（零写入）。 */
export function locateTopSlicesForPaths(repoRoot, {
  paths = [], keywords = [], excludeFiles = [], priorityFiles = [], limit = 3, budgetLines = 48,
} = {}) {
  const root = canonicalPath(repoRoot)
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const normExcludes = new Set((excludeFiles ?? []).map((p) => posixPath(String(p)).replace(/^\.\//, '')))
  const normPriority = new Set((priorityFiles ?? []).map((p) => posixPath(String(p)).replace(/^\.\//, '')))
  const normPaths = (paths ?? []).map((p) => posixPath(String(p)).replace(/^\.\//, '')).filter(Boolean)
  const pathDirs = new Set()
  const rawSeeds = []
  for (const p of normPaths) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i += 1) pathDirs.add(segs.slice(0, i).join('/'))
    rawSeeds.push(basename(p).replace(/\.[^.]+$/, ''))
  }
  for (const kw of keywords ?? []) rawSeeds.push(String(kw))
  const queryTerms = parseQueryTerms(rawSeeds.slice(0, 12).join(' '))
  const walked = walkRepoFiles(root, { scope: 'docs', includeArchive: false })
  const candidates = []

  for (const item of walked.active) {
    if (normExcludes.has(item.rel)) continue
    const text = readTextFast(item.abs)
    if (!text) continue
    const refinedKind = item.kind === 'doc' ? classifyFileKind(item.rel, text) : item.kind
    const isSubAgents = /\/AGENTS\.md$/i.test(item.rel)
    const agentsDir = isSubAgents ? item.rel.replace(/\/AGENTS\.md$/i, '') : ''
    const dirHit = isSubAgents && [...pathDirs].some((d) => d === agentsDir || d.startsWith(`${agentsDir}/`))
    let docHits = scoreDocCandidates({ ...item, kind: refinedKind }, text, { section: null, queryTerms })
    if (dirHit && docHits.length === 0) {
      docHits = scoreDocCandidates({ ...item, kind: refinedKind }, text, { section: null, queryTerms: { primary: [], all: [], groups: [] } })
    }
    for (const hit of docHits) {
      let boost = dirHit ? 55 : 0
      const sliceText = hit.rawLines.slice(hit.startLine - 1, hit.endLine).join('\n')
      for (const p of normPaths) {
        if (sliceText.includes(p) || sliceText.includes(basename(p))) boost += 22
      }
      if (normPriority.has(item.rel) || /^(?:docs\/TDD\.md|ARCHITECTURE\.md|docs\/ARCHITECTURE\.md|AGENTS\.md)$/i.test(item.rel)) boost += 14
      if (hit.score + boost > 0) candidates.push({ ...hit, score: hit.score + boost })
    }
  }
  return applyBudgetToCandidates(candidates, { limit, budgetLines, query: queryTerms.primary.slice(0, 4).join(' ') }).slices
}

/** 发现高价值上下文文档：`ARCHITECTURE.md`、`*\/AGENTS.md`（跳过 `COMMON_SKIP_DIRS`/`.agents/`）及无头文档。 */
export function listIndexableDocs(repoRoot, { scope = 'docs', kind = null, includeArchive = false, limit = 100 } = {}) {
  const root = canonicalPath(repoRoot)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: true, mode: 'list', repoRoot: root, scope, kind: kind ?? null, count: 0, files: [] }
  }
  const walked = walkRepoFiles(root, { scope, includeArchive })
  const items = walked.active
    .filter((item) => !kind || item.kind === kind)
    .slice(0, Math.max(1, limit))
    .map((item) => ({ file: item.rel, kind: item.kind, locateCommand: buildLocateCommand(item.rel) }))
  return { ok: true, mode: 'list', repoRoot: root, scope, kind: kind ?? null, count: items.length, files: items }
}

export function discoverContextDocs(repoRoot, { maxHeadless = 10, maxContext = 30 } = {}) {
  const root = canonicalPath(repoRoot)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { architecture: null, subAgents: [], headlessDocs: [], contextIndex: [], docLocateHints: [] }
  }
  const walked = walkRepoFiles(root, { scope: 'docs', includeArchive: false })
  let architecture = null; const subAgents = []; const headlessDocs = []; const contextIndex = []

  for (const item of walked.active) {
    const low = item.rel.toLowerCase()
    const isArch = low === 'architecture.md' || low === 'docs/architecture.md'
    const isSubAgents = /\/agents\.md$/.test(low)
    const isTopDoc = low === 'docs/tdd.md' || low === 'agents.md' || low === 'readme.md' || low === 'skill.md'
    const isRefDoc = /^references\/.+\.md$/i.test(item.rel)
    const isDocsMd = /^docs\/.+\.md$/i.test(item.rel) || isRefDoc
    if (!isArch && !isSubAgents && !isTopDoc && !isDocsMd) continue
    const text = readTextFast(item.abs)
    if (!text) continue
    const fm = parseDocFrontmatter(text)
    const lines = scanLines(text)
    const fmEnd = findFrontmatterEndLine(lines)
    const entry = {
      file: item.rel, absPath: canonicalPath(item.abs),
      kind: item.kind === 'doc' ? classifyFileKind(item.rel, text) : item.kind,
      summary: extractHeadlessSummary(text),
      hasFrontmatter: Boolean(fm.hasFrontmatter),
      hasH1: lines.slice(fmEnd + 1).some((l) => !l.inFence && l.heading?.level === 1),
      locateCommand: buildLocateCommand(item.rel),
    }
    if (isArch) { if (!architecture || low === 'architecture.md') architecture = entry; contextIndex.push(entry) }
    else if (isSubAgents) { subAgents.push(entry); contextIndex.push(entry) }
    else if (isTopDoc || isRefDoc) contextIndex.push(entry)
    else if (!entry.hasFrontmatter && !['prd', 'spec', 'todo'].includes(entry.kind)) headlessDocs.push(entry)
  }

  const docLocateHints = ['node .agents/skills/dev-explore/scripts/doc-locate.mjs --query "<关键词>"']
  if (architecture) docLocateHints.push(`node .agents/skills/dev-explore/scripts/doc-locate.mjs --file ${quoteCliArg(architecture.file)}`)
  if (existsSync(join(root, 'docs', 'TDD.md'))) docLocateHints.push('node .agents/skills/dev-explore/scripts/doc-locate.mjs --file "docs/TDD.md" --section "<章节名>"')
  if (subAgents.length > 0) docLocateHints.push(`node .agents/skills/dev-explore/scripts/doc-locate.mjs --file ${quoteCliArg(subAgents[0].file)}`)
  return { architecture, subAgents, headlessDocs: headlessDocs.slice(0, maxHeadless), contextIndex: contextIndex.slice(0, maxContext), docLocateHints }
}

/** 将定位结果格式化为紧凑人类可读文本（多切片默认收敛至 ~1.5–2.2 KB 预算内）。 */
export function formatLocateText(result) {
  const filters = []
  if (result.file) filters.push(`file=${result.file}`)
  if (result.section) filters.push(`section=${result.section}`)
  if (result.symbol) filters.push(`symbol=${result.symbol}`)
  if (result.query) filters.push(`query=${result.query}`)
  if (result.kind) filters.push(`kind=${result.kind}`)
  filters.push(`scope=${result.scope}`)

  const lines = [
    `# doc-locate (${result.slices.length}/${result.totalMatches}, ${result.durationMs}ms, ${result.usedBudgetLines}/${result.budgetLines}L)`,
    `root: ${result.root} | ${filters.join(' | ')}`,
  ]
  if (result.slices.length === 0) {
    lines.push('', '未命中匹配切片。可放宽 `--scope all` 或更换 `--query` / `--section` / `--symbol`。')
    return `${lines.join('\n')}\n`
  }

  const single = result.slices.length === 1
  const maxSum = single ? 140 : 64
  const includePreview = single || result.slices.length <= 2
  const maxPrevChars = single ? 1400 : 180

  result.slices.forEach((s, idx) => {
    const anchor = s.section ? `§ ${s.section.slice(0, 44)}` : (s.symbol ? `sym:${s.symbol}` : 'head')
    lines.push('', `${idx + 1}. [${s.kind}] ${s.relPath}:${s.startLine}-${s.endLine} (${anchor}, score=${s.score})`)
    lines.push(`   abs: ${s.absPath}`)
    if (s.summary) lines.push(`   sum: ${s.summary.length > maxSum ? `${s.summary.slice(0, maxSum - 3)}...` : s.summary}`)
    lines.push(`   cmd: ${s.locateCommand}`)
    if (includePreview && s.snippet) {
      let preview = s.snippet.split('\n').slice(0, single ? 32 : 3).join('\n')
      if (preview.length > maxPrevChars) preview = `${preview.slice(0, maxPrevChars - 3).trimEnd()}...`
      lines.push('   ---')
      for (const pl of preview.split('\n')) lines.push(`   ${pl}`)
    }
  })
  return `${lines.join('\n')}\n`
}
