/**
 * docs.mjs —— 四层工程文档统一模板生成、Frontmatter 生命周期、成对归档、联动同步与 Mermaid 宽度校验。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-plan、dev-flow、dev-review、dev-govern 共用。
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { gitRun, posixPath, readTextSafe, writeAtomic } from './git.mjs'
import { listTaskLedgers, writeTaskLedger } from './ledger.mjs'

export const DOC_STANDARD_NAME_RE = /^(\d{6})(?:-issue(\d+))?-([a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5-]*)-(prd|spec|todo)\.md$/
export const DOC_LEGACY_NAME_RE = /^(\d{6})(?:-issue(\d+))?-([a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5-]*)\.md$/

export const DOC_FRONTMATTER_KEY_ORDER = Object.freeze({
  prd: ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'owner', 'plan_critique', 'related_spec', 'related_todo'],
  spec: ['kind', 'title', 'status', 'tier', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'approved', 'implemented', 'plan_critique', 'related_prd', 'related_todo', 'high_risk_paths'],
  todo: ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'approved', 'done_at', 'task_id', 'planned_at', 'related_prd', 'related_spec'],
})


/** 将输入文本规范化为 kebab-case slug（支持 ASCII 与中文）。 */
export function slugify(text, fallback = 'task') {
  const cleaned = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || fallback
}

/** 统一本地日期标记 YYMMDD（与 docIsoDate 保持同一时区日历日）。 */
export function docDateTag(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

/** 统一本地 ISO 日期 YYYY-MM-DD（消除各脚本 UTC 与本地时区日差）。 */
export function docIsoDate(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function splitInlineArrayItems(inner) {
  const items = []
  let cur = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        cur += ch + inner[i + 1]
        i += 1
        continue
      }
      if (ch === quote) {
        if (quote === '\'' && inner[i + 1] === '\'') {
          cur += '\'\''
          i += 1
          continue
        }
        quote = null
      }
      cur += ch
    } else if (ch === '"' || ch === '\'') {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) items.push(cur.trim())
  return items
}

function parseYamlScalar(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (s.startsWith('\'') && s.endsWith('\'') && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, '\'')
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineArrayItems(inner).map((item) => parseYamlScalar(item))
  }
  return s
}

function formatYamlScalar(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'boolean' || typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    return `[${val.map((item) => formatYamlScalar(item)).join(', ')}]`
  }
  const s = String(val)
  const needsQuote = s === ''
    || /^\s|\s$/.test(s)
    || /^(?:true|false|null|~)$/i.test(s)
    || /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)
    || /[\n\r"':#\[\]{},&*!|>@`]/.test(s)
    || s.startsWith('- ')
  if (!needsQuote) return s
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** 零依赖解析文档头部 YAML Frontmatter，兼容旧式列表元数据。 */
export function parseDocFrontmatter(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (norm.startsWith('---\n') || norm === '---') {
    const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(norm)
      ?? /^---\n---(?:\n([\s\S]*))?$/.exec(norm)
    if (!fmMatch) {
      return {
        hasFrontmatter: false, malformedFrontmatter: true, data: {}, keyOrder: [],
        body: norm, legacy: false, syntaxErrors: ['Frontmatter 缺少闭合的 `---` 分隔行'],
      }
    }
    const fmRaw = fmMatch.length === 3 ? fmMatch[1] : ''
    const body = fmMatch.length === 3 ? (fmMatch[2] ?? '') : (fmMatch[1] ?? '')
    const data = {}
    const keyOrder = []
    const syntaxErrors = []
    const fmLines = fmRaw ? fmRaw.split('\n') : []
    for (let i = 0; i < fmLines.length; i += 1) {
      const rawLine = fmLines[i]
      if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(rawLine)
      if (!kv) {
        syntaxErrors.push(`Frontmatter 第 ${i + 2} 行格式无效：${rawLine}`)
        continue
      }
      const key = kv[1]
      const tail = kv[2].trim()
      if (!keyOrder.includes(key)) keyOrder.push(key)
      if (!tail) {
        const blockItems = []
        let j = i + 1
        while (j < fmLines.length && /^\s+-\s+(.*)$/.test(fmLines[j])) {
          blockItems.push(parseYamlScalar(/^\s+-\s+(.*)$/.exec(fmLines[j])[1]))
          j += 1
        }
        if (blockItems.length > 0) {
          data[key] = blockItems
          i = j - 1
        } else {
          data[key] = null
        }
      } else {
        data[key] = parseYamlScalar(tail)
      }
    }
    return {
      hasFrontmatter: true,
      malformedFrontmatter: syntaxErrors.length > 0,
      data, keyOrder, body, legacy: false, syntaxErrors,
    }
  }

  const headerChunk = norm.split(/\n##\s+/)[0]
  const data = {}
  const keyOrder = []
  const pushField = (k, v) => {
    if (v === undefined) return
    if (!keyOrder.includes(k)) keyOrder.push(k)
    data[k] = v
  }
  const titleMatch = /^#\s+(.+)$/m.exec(headerChunk)
  if (titleMatch) pushField('title', titleMatch[1].replace(/^(?:PRD|SPEC|Todo)\s*[:：]\s*/i, '').trim())
  const statusMatch = /^(?:>\s*\*\*状态\*\*\s*[:：]|-\s*\*\*状态\*\*\s*[:：]|(?:-\s+)?Status\s*:)\s*`?([A-Za-z0-9_-]+)`?/mi.exec(headerChunk)
  if (statusMatch) pushField('status', statusMatch[1].toLowerCase())
  const critiqueMatch = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(headerChunk)
  if (critiqueMatch) pushField('plan_critique', critiqueMatch[1].trim())
  const createdMatch = /^(?:-\s+)?(?:Created|Date):\s*([0-9-]+)/mi.exec(headerChunk)
  if (createdMatch) pushField('created', createdMatch[1].trim())
  const plannedMatch = /^(?:-\s+)?(?:\*\*)?Planned at(?:\*\*)?[:：]\s*`?([^`\n]+)`?/mi.exec(headerChunk)
  if (plannedMatch) pushField('planned_at', plannedMatch[1].trim())
  const ownerMatch = /^(?:-\s+)?(?:\*\*)?(?:Owner|提出方)(?:\*\*)?[:：]\s*(.+)$/mi.exec(headerChunk)
  if (ownerMatch) pushField('owner', ownerMatch[1].trim())
  const relSpecMatch = /^(?:-\s+)?Related SPEC:\s*(.+)$/mi.exec(headerChunk)
  if (relSpecMatch && !/^(?:无|none)$/i.test(relSpecMatch[1].trim())) pushField('related_spec', relSpecMatch[1].trim())
  const relPrdMatch = /^(?:-\s+)?Related PRD:\s*(.+)$/mi.exec(headerChunk)
  if (relPrdMatch && !/^(?:无|none)$/i.test(relPrdMatch[1].trim())) pushField('related_prd', relPrdMatch[1].trim())

  return {
    hasFrontmatter: false, malformedFrontmatter: false,
    data, keyOrder, body: norm, legacy: true, syntaxErrors: [],
  }
}

/** 将结构化 Frontmatter 键按顺序序列化为干净 YAML `--- ... ---` 块。 */
export function serializeDocFrontmatter(data, keyOrder = []) {
  const ordered = []
  const seen = new Set()
  for (const k of keyOrder) {
    if (!seen.has(k) && Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) {
      seen.add(k)
      ordered.push(k)
    }
  }
  for (const k of Object.keys(data ?? {})) {
    if (!seen.has(k) && data[k] !== undefined) {
      seen.add(k)
      ordered.push(k)
    }
  }
  const lines = ['---']
  for (const k of ordered) lines.push(`${k}: ${formatYamlScalar(data[k])}`)
  lines.push('---')
  return `${lines.join('\n')}\n`
}

/** 原位更新或补齐文档 YAML Frontmatter 字段并原子写回。 */
export function updateDocFrontmatter(filePath, patch = {}, { defaultKeyOrder = [] } = {}) {
  const raw = readTextSafe(filePath)
  if (raw === undefined) throw new Error(`无法读取文档文件：${filePath}`)
  const parsed = parseDocFrontmatter(raw)
  const merged = { ...parsed.data }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) merged[k] = v
  }
  const keyOrder = [...defaultKeyOrder, ...parsed.keyOrder, ...Object.keys(merged)]
  const cleanBody = parsed.body.replace(/^\n+/, '')
  const nextText = `${serializeDocFrontmatter(merged, keyOrder)}\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`
  writeAtomic(filePath, nextText)
  return { file: filePath, data: merged }
}

/** 构造规范文档文件名：`YYMMDD-[issue<N>-]<slug>-{prd,spec,todo}.md`。 */
export function buildDocFilename({ date, issue, slug, kind }) {
  if (!['prd', 'spec', 'todo'].includes(kind)) {
    throw new Error(`无效文档 kind：${kind}（仅支持 prd | spec | todo）`)
  }
  const dateTag = date && /^\d{6}$/.test(String(date)) ? String(date) : docDateTag()
  const safeSlug = slugify(slug)
  const issueNum = issue !== undefined && issue !== null && String(issue).trim() !== ''
    ? Number(String(issue).replace(/^#/, '').trim())
    : null
  const issueSeg = Number.isInteger(issueNum) && issueNum > 0 ? `-issue${issueNum}` : ''
  return `${dateTag}${issueSeg}-${safeSlug}-${kind}.md`
}

/** 解析规范或兼容历史工程文档文件名，提取 date / issue / slug / kind。 */
export function parseDocFilename(name) {
  const base = basename(String(name ?? '').trim())
  const std = DOC_STANDARD_NAME_RE.exec(base)
  if (std) {
    return { date: std[1], issue: std[2] ? Number(std[2]) : null, slug: std[3], kind: std[4], legacy: false }
  }
  const leg = DOC_LEGACY_NAME_RE.exec(base)
  if (leg) {
    return { date: leg[1], issue: leg[2] ? Number(leg[2]) : null, slug: leg[3], kind: null, legacy: true }
  }
  return null
}

function inferDocKindFromPath(relPath, fmData) {
  const k = fmData?.kind
  if (k === 'prd' || k === 'spec' || k === 'todo') return k
  const p = posixPath(relPath).toLowerCase()
  if (p.startsWith('docs/prd/') || p.startsWith('docs/archive/prd/')) return 'prd'
  if (p.startsWith('docs/specs/') || p.startsWith('docs/archive/specs/')) return 'spec'
  if (p.startsWith('docs/todo/') || p.startsWith('docs/archive/todo/')) return 'todo'
  return parseDocFilename(p)?.kind ?? null
}

function listDocsInFolder(repoRoot, folderRel) {
  const absDir = join(repoRoot, folderRel)
  if (!existsSync(absDir)) return []
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => `${folderRel}/${e.name}`)
      .sort()
  } catch {
    return []
  }
}

function escapeRegExpStr(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 单遍安全替换正文中的旧路径或旧文件名引用，避免 `newBase` 包含 `oldBase` 引起的嵌套重复替换。
 */
function replaceDocReferencesSinglePass(rawText, renameMap) {
  if (!renameMap || renameMap.size === 0) return rawText
  const tokenMap = new Map()
  for (const [oldRel, newRel] of renameMap.entries()) {
    tokenMap.set(oldRel, newRel)
    const oldBase = basename(oldRel)
    const newBase = basename(newRel)
    if (!tokenMap.has(oldBase)) tokenMap.set(oldBase, newBase)
  }
  const keys = [...tokenMap.keys()].sort((a, b) => b.length - a.length)
  if (keys.length === 0) return rawText
  const altRe = new RegExp(`(?<![A-Za-z0-9\\u4e00-\\u9fa5_.-])(${keys.map(escapeRegExpStr).join('|')})(?![A-Za-z0-9\\u4e00-\\u9fa5_.-])`, 'g')
  return String(rawText ?? '').replace(altRe, (m) => tokenMap.get(m) ?? m)
}

async function moveDocWithGit(repoRoot, oldRel, targetRel) {
  mkdirSync(dirname(join(repoRoot, targetRel)), { recursive: true })
  const tracked = await gitRun(repoRoot, ['ls-files', '--error-unmatch', oldRel])
  if (tracked.ok) {
    const mv = await gitRun(repoRoot, ['mv', oldRel, targetRel])
    if (!mv.ok) throw new Error(`移动文档失败（${oldRel} -> ${targetRel}）：${mv.stderr}`)
  } else {
    renameSync(join(repoRoot, oldRel), join(repoRoot, targetRel))
  }
}

function collectSiblingSet(repoRoot, { slugOrPath, includeArchived = false } = {}) {
  const activeDirs = ['docs/prd', 'docs/specs', 'docs/todo']
  const archiveDirs = ['docs/archive/prd', 'docs/archive/specs', 'docs/archive/todo']
  const allActive = activeDirs.flatMap((d) => listDocsInFolder(repoRoot, d))
  const allArchived = archiveDirs.flatMap((d) => listDocsInFolder(repoRoot, d))
  const candidates = includeArchived ? [...allActive, ...allArchived] : allActive

  let seedRel = null
  if (slugOrPath) {
    const candidateAbs = resolve(repoRoot, slugOrPath)
    const candidateRel = posixPath(relative(repoRoot, candidateAbs))
    if (existsSync(candidateAbs) && candidateRel.startsWith('docs/')) {
      seedRel = candidateRel
    }
  }

  let targetDate = null
  let targetSlug = null
  if (seedRel) {
    const fn = parseDocFilename(seedRel)
    if (fn) { targetDate = fn.date; targetSlug = fn.slug }
    else targetSlug = slugify(basename(seedRel, '.md'))
  } else if (slugOrPath) {
    const fn = parseDocFilename(slugOrPath)
    if (fn) { targetDate = fn.date; targetSlug = fn.slug }
    else targetSlug = slugify(String(slugOrPath).replace(/^#/, ''))
  }

  const siblingSet = new Set()
  if (seedRel && (includeArchived || !seedRel.startsWith('docs/archive/'))) siblingSet.add(seedRel)

  for (const rel of candidates) {
    const fn = parseDocFilename(rel)
    if (fn && targetSlug && fn.slug === targetSlug && (!targetDate || fn.date === targetDate)) {
      siblingSet.add(rel)
    } else if (!fn && targetSlug && basename(rel, '.md') === targetSlug) {
      siblingSet.add(rel)
    }
  }

  const queue = [...siblingSet]
  const seenFollow = new Set(queue)
  while (queue.length > 0) {
    const curRel = queue.shift()
    const raw = readTextSafe(join(repoRoot, curRel))
    if (!raw) continue
    const fm = parseDocFrontmatter(raw)
    for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
      const rv = fm.data?.[rk]
      if (!rv || typeof rv !== 'string' || /^(?:无|none)$/i.test(rv.trim())) continue
      const resolvedAbs = resolve(dirname(join(repoRoot, curRel)), rv)
      const resolvedRel = posixPath(relative(repoRoot, resolvedAbs))
      if (existsSync(resolvedAbs) && resolvedRel.startsWith('docs/')
        && (includeArchived || !resolvedRel.startsWith('docs/archive/'))
        && !seenFollow.has(resolvedRel)) {
        seenFollow.add(resolvedRel)
        siblingSet.add(resolvedRel)
        queue.push(resolvedRel)
      }
    }
  }

  return { siblingSet, allActive, allArchived, seedRel, targetDate, targetSlug }
}

/** 同步 PRD / SPEC / Todo 生命周期、重命名、互链与任务账本（不再锁在 renameMap > 0）。 */
export async function syncDocsLifecycle(repoRoot, {
  slugOrPath, issue, pr, branch, owner, status, approved, implemented, doneAt, planCritique,
  preserveTerminalStatus = false,
} = {}) {
  const { siblingSet, allActive, allArchived, seedRel, targetDate, targetSlug } = collectSiblingSet(repoRoot, { slugOrPath })

  const normalizedIssue = issue !== undefined && issue !== null && String(issue).trim() !== ''
    ? Number(String(issue).replace(/^#/, '').trim())
    : undefined
  let effectiveIssue = Number.isInteger(normalizedIssue) && normalizedIssue > 0 ? normalizedIssue : undefined

  if (effectiveIssue === undefined) {
    for (const rel of siblingSet) {
      const fn = parseDocFilename(rel)
      if (fn?.issue) { effectiveIssue = fn.issue; break }
      const raw = readTextSafe(join(repoRoot, rel))
      const fm = raw ? parseDocFrontmatter(raw) : null
      if (Number.isInteger(fm?.data?.issue) && fm.data.issue > 0) {
        effectiveIssue = fm.data.issue
        break
      }
    }
  }

  const renameMap = new Map()
  const renamed = []
  const finalSiblings = []

  for (const oldRel of [...siblingSet].sort()) {
    const raw = readTextSafe(join(repoRoot, oldRel)) ?? ''
    const fm = parseDocFrontmatter(raw)
    const fn = parseDocFilename(oldRel)
    const kind = inferDocKindFromPath(oldRel, fm.data)
    const dateFromCreated = typeof fm.data?.created === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.data.created)
      ? `${fm.data.created.slice(2, 4)}${fm.data.created.slice(5, 7)}${fm.data.created.slice(8, 10)}`
      : null
    const docDate = fn?.date ?? targetDate ?? dateFromCreated ?? docDateTag()
    const docSlug = fn?.slug ?? targetSlug
    let currentRel = oldRel

    if (effectiveIssue && kind && docSlug) {
      const needsRename = !fn || fn.legacy || fn.issue !== effectiveIssue || fn.kind !== kind
      if (needsRename) {
        const dirRel = posixPath(dirname(oldRel))
        const targetRel = `${dirRel}/${buildDocFilename({ date: docDate, issue: effectiveIssue, slug: docSlug, kind })}`
        if (targetRel !== oldRel) {
          await moveDocWithGit(repoRoot, oldRel, targetRel)
          renameMap.set(oldRel, targetRel)
          renamed.push({ from: oldRel, to: targetRel, kind })
          currentRel = targetRel
        }
      }
    }
    finalSiblings.push({ oldRel, rel: currentRel, kind, date: docDate, slug: docSlug })
  }

  const byKind = { prd: null, spec: null, todo: null }
  for (const s of finalSiblings) {
    if (s.kind && !byKind[s.kind]) byKind[s.kind] = s.rel
  }
  for (const archRel of allArchived) {
    const fn = parseDocFilename(archRel)
    if (!fn || !targetSlug || fn.slug !== targetSlug) continue
    if (targetDate && fn.date !== targetDate) continue
    const k = inferDocKindFromPath(archRel, null)
    if (k && !byKind[k]) byKind[k] = archRel
  }
  if (seedRel && seedRel.startsWith('docs/archive/')) {
    const k = inferDocKindFromPath(seedRel, null)
    if (k && !byKind[k]) byKind[k] = seedRel
  }

  const updated = []
  const today = docIsoDate()
  for (const sib of finalSiblings) {
    const abs = join(repoRoot, sib.rel)
    let raw = readTextSafe(abs) ?? ''
    raw = replaceDocReferencesSinglePass(raw, renameMap)
    const fm = parseDocFrontmatter(raw)
    const patch = { updated: today }
    if (sib.kind && !fm.data.kind) patch.kind = sib.kind
    if (effectiveIssue !== undefined) patch.issue = effectiveIssue
    if (pr !== undefined) patch.pr = pr === null ? null : Number(pr)
    if (branch !== undefined) patch.branch = branch
    if (owner !== undefined) patch.owner = owner
    if (status !== undefined) {
      const curSt = String(fm.data?.status ?? '').toLowerCase()
      const isTerminal = ['done', 'implemented', 'superseded', 'archived'].includes(curSt)
      if (!preserveTerminalStatus || !isTerminal) patch.status = status
    }
    if (approved !== undefined) patch.approved = Boolean(approved)
    if (implemented !== undefined && sib.kind === 'spec') patch.implemented = Boolean(implemented)
    if (doneAt !== undefined && sib.kind === 'todo') patch.done_at = doneAt
    if (planCritique !== undefined) patch.plan_critique = planCritique

    for (const [rk, targetKind] of [['related_prd', 'prd'], ['related_spec', 'spec'], ['related_todo', 'todo']]) {
      if (sib.kind === targetKind) continue
      const targetRel = byKind[targetKind]
      if (targetRel) patch[rk] = posixPath(relative(dirname(abs), join(repoRoot, targetRel)))
    }

    const merged = { ...fm.data }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) merged[k] = v
    }
    const defaultOrder = DOC_FRONTMATTER_KEY_ORDER[sib.kind] ?? []
    const keyOrder = [...defaultOrder, ...fm.keyOrder, ...Object.keys(merged)]
    const cleanBody = fm.body.replace(/^\n+/, '')
    const nextText = `${serializeDocFrontmatter(merged, keyOrder)}\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`
    writeAtomic(abs, nextText)
    updated.push({ file: sib.rel, kind: sib.kind, data: merged })
  }

  if (renameMap.size > 0) {
    for (const todoDoc of allActive.filter((p) => p.startsWith('docs/todo/'))) {
      const resolvedTodo = renameMap.get(todoDoc) ?? todoDoc
      if (finalSiblings.some((s) => s.rel === resolvedTodo)) continue
      const absTodo = join(repoRoot, resolvedTodo)
      const txt = readTextSafe(absTodo)
      if (!txt) continue
      const nextTxt = replaceDocReferencesSinglePass(txt, renameMap)
      if (nextTxt !== txt) writeAtomic(absTodo, nextTxt)
    }
  }

  for (const ledger of listTaskLedgers(repoRoot)) {
    let dirty = false
    for (const field of ['prdFile', 'specFile', 'todoFile', 'archivedTodoFile', 'archivedSpecFile', 'archivedPrdFile']) {
      if (ledger[field] && renameMap.has(ledger[field])) {
        ledger[field] = renameMap.get(ledger[field])
        dirty = true
      }
    }
    const referencesThisSet = ['prdFile', 'specFile', 'todoFile', 'archivedTodoFile', 'archivedSpecFile', 'archivedPrdFile']
      .some((f) => finalSiblings.some((s) => s.rel === ledger[f] || s.oldRel === ledger[f]))
      || (targetSlug && ledger.slug === targetSlug)
    if (referencesThisSet) {
      if (effectiveIssue && Array.isArray(ledger.linkedIssues) && !ledger.linkedIssues.includes(effectiveIssue)) {
        ledger.linkedIssues = [...ledger.linkedIssues, effectiveIssue]
        dirty = true
      }
      if (pr !== undefined && pr !== null && Number(ledger.prNumber) !== Number(pr)) {
        ledger.prNumber = Number(pr)
        dirty = true
      }
      if (byKind.prd && !ledger.prdFile) { ledger.prdFile = byKind.prd; dirty = true }
      if (byKind.spec && !ledger.specFile) { ledger.specFile = byKind.spec; dirty = true }
      if (byKind.todo && !ledger.todoFile) { ledger.todoFile = byKind.todo; dirty = true }
    }
    if (dirty) writeTaskLedger(repoRoot, ledger)
  }

  return { renamed, updated, byKind, issue: effectiveIssue ?? null }
}

/**
 * 将关联的 PRD / SPEC / Todo 成对通过 `git mv` 归档至 `docs/archive/{prd,specs,todo}/`，
 * 并同步更新状态、done_at、三者互链 `related_*` 相对路径与任务账本。
 */
export async function archiveCompletedDocsGroup(repoRoot, {
  prdFile, specFile, todoFile, slugOrPath, issue, pr, branch, owner, doneAt,
} = {}) {
  const seedInput = specFile ?? todoFile ?? prdFile ?? slugOrPath
  const { siblingSet, targetSlug } = collectSiblingSet(repoRoot, { slugOrPath: seedInput, includeArchived: true })

  for (const explicitRel of [prdFile, specFile, todoFile].filter(Boolean)) {
    const norm = posixPath(explicitRel)
    if (existsSync(join(repoRoot, norm))) siblingSet.add(norm)
  }

  const archiveDirByKind = { prd: 'docs/archive/prd', spec: 'docs/archive/specs', todo: 'docs/archive/todo' }
  const moveMap = new Map()
  const moved = []
  const groupItems = []

  for (const oldRel of [...siblingSet].sort()) {
    const raw = readTextSafe(join(repoRoot, oldRel)) ?? ''
    const fm = parseDocFrontmatter(raw)
    const kind = inferDocKindFromPath(oldRel, fm.data)
    let curRel = oldRel
    if (kind && !oldRel.startsWith('docs/archive/')) {
      const targetRel = `${archiveDirByKind[kind]}/${basename(oldRel)}`
      if (targetRel !== oldRel) {
        await moveDocWithGit(repoRoot, oldRel, targetRel)
        moveMap.set(oldRel, targetRel)
        moved.push({ from: oldRel, to: targetRel, kind })
        curRel = targetRel
      }
    }
    groupItems.push({ oldRel, rel: curRel, kind })
  }

  const byKind = { prd: null, spec: null, todo: null }
  for (const it of groupItems) {
    if (it.kind && !byKind[it.kind]) byKind[it.kind] = it.rel
  }

  const today = doneAt ?? docIsoDate()
  const updated = []
  for (const item of groupItems) {
    const abs = join(repoRoot, item.rel)
    let raw = readTextSafe(abs) ?? ''
    raw = replaceDocReferencesSinglePass(raw, moveMap)
    const fm = parseDocFrontmatter(raw)
    const patch = { updated: today }
    if (item.kind && !fm.data.kind) patch.kind = item.kind
    if (issue !== undefined && issue !== null) patch.issue = Number(issue)
    if (pr !== undefined && pr !== null) patch.pr = Number(pr)
    if (branch) patch.branch = branch
    if (owner) patch.owner = owner
    if (item.kind === 'prd') patch.status = 'done'
    if (item.kind === 'spec') { patch.status = 'implemented'; patch.implemented = true }
    if (item.kind === 'todo') {
      const curSt = String(fm.data?.status ?? '').toLowerCase()
      patch.status = curSt === 'archived' ? 'archived' : 'done'
      patch.done_at = fm.data?.done_at ?? today
    }

    for (const [rk, targetKind] of [['related_prd', 'prd'], ['related_spec', 'spec'], ['related_todo', 'todo']]) {
      if (item.kind === targetKind) continue
      const targetRel = byKind[targetKind]
      if (targetRel) patch[rk] = posixPath(relative(dirname(abs), join(repoRoot, targetRel)))
    }

    const merged = { ...fm.data }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) merged[k] = v
    }
    const defaultOrder = DOC_FRONTMATTER_KEY_ORDER[item.kind] ?? []
    const keyOrder = [...defaultOrder, ...fm.keyOrder, ...Object.keys(merged)]
    const cleanBody = fm.body.replace(/^\n+/, '')
    const nextText = `${serializeDocFrontmatter(merged, keyOrder)}\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`
    writeAtomic(abs, nextText)
    updated.push({ file: item.rel, kind: item.kind, status: merged.status })
  }

  for (const ledger of listTaskLedgers(repoRoot)) {
    const matches = ['prdFile', 'specFile', 'todoFile'].some((f) => groupItems.some((g) => g.oldRel === ledger[f] || g.rel === ledger[f]))
      || (targetSlug && ledger.slug === targetSlug)
    if (!matches) continue
    let dirty = false
    if (byKind.prd) { ledger.prdFile = byKind.prd; ledger.archivedPrdFile = byKind.prd; dirty = true }
    if (byKind.spec) { ledger.specFile = byKind.spec; ledger.archivedSpecFile = byKind.spec; dirty = true }
    if (byKind.todo) { ledger.todoFile = byKind.todo; ledger.archivedTodoFile = byKind.todo; dirty = true }
    if (dirty) writeTaskLedger(repoRoot, ledger)
  }

  return { moved, updated, byKind, archived: groupItems.map((g) => g.rel) }
}

// ── 联动同步解析（AGENTS.md ## 改哪看哪）───────────────────────────────

const COUPLED_ROOT_FILENAMES = new Set([
  'AGENTS.md', 'SKILL.md', 'README.md', 'README.en.md',
  'CONTRIBUTING.md', 'RELEASING.md', 'CHANGELOG.md',
  'Makefile', 'justfile', '.gitattributes', '.gitignore',
])

function isPathLikeToken(rawToken) {
  const s = posixPath(String(rawToken ?? '').trim()).replace(/^\.\//, '')
  if (!s || /\s/.test(s) || /^https?:|^file:|^mailto:/i.test(s)) return false
  if (/[*?<>{};|$]/.test(s)) return false
  if (s.includes('/')) return true
  if (COUPLED_ROOT_FILENAMES.has(s)) return true
  return /^[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s)
}

function extractCoupledPathTokens(cellText) {
  const tokens = []
  const seen = new Set()
  for (const m of String(cellText ?? '').matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim()
    if (!isPathLikeToken(raw)) continue
    const norm = posixPath(raw).replace(/^\.\//, '')
    if (!seen.has(norm)) { seen.add(norm); tokens.push(norm) }
  }
  return tokens
}

function splitMarkdownTableRow(rawLine) {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  const inner = trimmed.slice(1, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '\\' && inner[i + 1] === '|') { cur += '|'; i += 1 }
    else if (ch === '|') { cells.push(cur.trim()); cur = '' }
    else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** 从 AGENTS.md「## 改哪看哪」章节表格解析文件联动触发与伴随同步规则。 */
export function parseCoupledSyncRules(agentsText) {
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  let inFence = false
  const tableRows = []
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##\s+改哪看哪(?:\s|$)/.test(line.trim())) { inSection = true; continue }
    if (inSection && (/^##\s+/.test(line.trim()) || /^<!--\s*project-forge:\s*end\b/.test(line.trim()))) break
    if (!inSection) continue
    const cells = splitMarkdownTableRow(line)
    if (cells && cells.length >= 2) tableRows.push({ rawRow: line.trim(), cells })
  }

  const rules = []
  for (let i = 0; i < tableRows.length; i += 1) {
    const { rawRow, cells } = tableRows[i]
    if (cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue
    const nextRow = tableRows[i + 1]
    if (nextRow && nextRow.cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue
    const triggers = extractCoupledPathTokens(cells[0])
    const companions = extractCoupledPathTokens(cells[1])
    if (triggers.length === 0 || companions.length === 0) continue
    rules.push({ triggers, companions, rawRow })
  }
  return rules
}

function matchesCoupledPath(filePath, ruleToken, repoRoot) {
  const normTok = posixPath(ruleToken).replace(/^\.\//, '')
  if (!normTok) return false
  if (normTok.endsWith('/')) return filePath.startsWith(normTok) || filePath === normTok.slice(0, -1)
  if (filePath === normTok) return true
  if (repoRoot) {
    try {
      const abs = join(repoRoot, normTok)
      if (existsSync(abs) && readdirSync(abs)) return filePath.startsWith(`${normTok}/`)
    } catch { /* not a dir */ }
  }
  return false
}

/** 对照「改哪看哪」规则校验变更文件清单，过滤目标仓不存在的可选伴随文件。 */
export function evaluateCoupledSync(changedFiles, rules, repoRoot) {
  const normalizedChanged = [...new Set(
    (Array.isArray(changedFiles) ? changedFiles : []).map((f) => posixPath(f).replace(/^\.\//, '').trim()).filter(Boolean),
  )]
  if (normalizedChanged.length === 0 || !Array.isArray(rules) || rules.length === 0) return []
  const warnings = []
  for (const rule of rules) {
    const touchedTriggers = (rule.triggers ?? []).filter((t) => normalizedChanged.some((f) => matchesCoupledPath(f, t, repoRoot)))
    if (touchedTriggers.length === 0) continue
    const existingCompanions = (rule.companions ?? []).filter((c) => {
      if (!repoRoot) return true
      const clean = posixPath(c).replace(/^\.\//, '').replace(/\/+$/, '')
      return Boolean(clean) && existsSync(join(repoRoot, clean))
    })
    if (existingCompanions.length === 0) continue
    const companionSynced = existingCompanions.some((c) => normalizedChanged.some((f) => matchesCoupledPath(f, c, repoRoot)))
    if (!companionSynced) warnings.push({ triggers: rule.triggers, touchedTriggers, expectedCompanions: existingCompanions, rawRow: rule.rawRow })
  }
  return warnings
}

export { checkMermaidLabelWidth, displayWidth, MERMAID_LIMITS } from './doc-templates.mjs'
import { buildStandardDocContent } from './doc-templates.mjs'

/**
 * 统一工程文档模板生成器（YAML Frontmatter + 顶部可见元信息概览表 + SPEC 短名 Mermaid 图）。
 * 供 `doc-plan.mjs init` 与 `govern-audit.mjs --write-todo` 共用唯一格式源。
 */
export function renderStandardDocTemplate(opts = {}) {
  return buildStandardDocContent({
    today: docIsoDate(),
    ...opts,
    serializeFm: serializeDocFrontmatter,
    keyOrders: DOC_FRONTMATTER_KEY_ORDER,
  })
}
