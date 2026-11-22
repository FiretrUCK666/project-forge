/**
 * docs.mjs —— 四层工程文档统一模板生成、Frontmatter 生命周期、成对归档、联动同步与 Mermaid 宽度校验。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-plan、dev-flow、dev-review、dev-govern 共用。
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  DOC_LEGACY_NAME_RE,
  DOC_STANDARD_NAME_RE,
  isManagedPlanDoc,
  parseDocFilename,
  parseDocFrontmatter,
  serializeDocFrontmatter,
  stripCritiqueMeta,
  updateDocFrontmatter,
} from './doc-frontmatter.mjs'
import { evaluateMasterPrdClosureState } from './doc-substantive.mjs'
import { collectOwnerHistory, isApprovingStatus, PREVIOUS_OWNERS_KEY } from './doc-approval.mjs'
import { EXIT } from './exit-codes.mjs'
import { gitRun, posixPath, readTextSafe, writeAtomic } from './git.mjs'
import { hasDotGitInAncestors, isPathInGitIndexFast } from './git-fast.mjs'
import { listTaskLedgers, recordPlanningProvenance, resolveLedgerRoot, updateTaskLedger } from './ledger.mjs'

export {
  DOC_LEGACY_NAME_RE,
  DOC_STANDARD_NAME_RE,
  isManagedPlanDoc,
  parseDocFilename,
  parseDocFrontmatter,
  serializeDocFrontmatter,
  stripCritiqueMeta,
  updateDocFrontmatter,
}

export { collectOwnerHistory, isApprovingStatus, isApprovingStatusValue, PREVIOUS_OWNERS_KEY } from './doc-approval.mjs'

export const DOC_FRONTMATTER_KEY_ORDER = Object.freeze({
  prd: ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'owner', 'previous_owners', 'plan_mode', 'plan_critique', 'critique_rounds', 'critique_override', 'related_spec', 'related_todo'],
  spec: ['kind', 'title', 'status', 'tier', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'previous_owners', 'plan_mode', 'approved', 'implemented', 'plan_critique', 'critique_rounds', 'critique_override', 'related_prd', 'related_todo', 'high_risk_paths'],
  todo: ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'previous_owners', 'plan_mode', 'approved', 'done_at', 'task_id', 'planned_at', 'related_prd', 'related_spec'],
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
  const fastTracked = isPathInGitIndexFast(repoRoot, oldRel)
  const isTracked = fastTracked !== null
    ? fastTracked
    : (hasDotGitInAncestors(repoRoot) ? (await gitRun(repoRoot, ['ls-files', '--error-unmatch', oldRel])).ok : false)
  if (isTracked) {
    const mv = await gitRun(repoRoot, ['mv', oldRel, targetRel])
    if (!mv.ok) throw new Error(`移动文档失败（${oldRel} -> ${targetRel}）：${mv.stderr}`)
  } else {
    renameSync(join(repoRoot, oldRel), join(repoRoot, targetRel))
  }
}

function docIssueNumber(repoRoot, rel) {
  const fn = parseDocFilename(rel)
  if (fn?.issue) return fn.issue
  const raw = readTextSafe(join(repoRoot, rel))
  const fm = raw ? parseDocFrontmatter(raw) : null
  const num = Number(fm?.data?.issue)
  return Number.isInteger(num) && num > 0 ? num : null
}

function ledgerMatchesGroup(ledger, members, targetSlug, effectiveIssue) {
  const memberSet = new Set(members)
  const fields = ['prdFile', 'specFile', 'todoFile', 'archivedTodoFile', 'archivedSpecFile', 'archivedPrdFile']
  if (fields.some((f) => ledger[f] && memberSet.has(ledger[f]))) return true
  if (!targetSlug || ledger.slug !== targetSlug) return false
  const nonPrdConflict = ['specFile', 'todoFile', 'archivedTodoFile', 'archivedSpecFile']
    .some((f) => ledger[f] && !memberSet.has(ledger[f]))
  if (nonPrdConflict) return false
  if (effectiveIssue && Array.isArray(ledger.linkedIssues) && ledger.linkedIssues.length > 0) {
    return ledger.linkedIssues.includes(effectiveIssue)
  }
  return true
}

function readDocIdentityMeta(repoRoot, rel) {
  const fn = parseDocFilename(rel)
  const raw = readTextSafe(join(repoRoot, rel))
  const fm = raw ? parseDocFrontmatter(raw) : null
  const kind = inferDocKindFromPath(rel, fm?.data ?? null)
  const issueNum = Number(fm?.data?.issue)
  const prNum = Number(fm?.data?.pr)
  const issue = fn?.issue ?? (Number.isInteger(issueNum) && issueNum > 0 ? issueNum : null)
  const pr = Number.isInteger(prNum) && prNum > 0 ? prNum : null
  const branch = typeof fm?.data?.branch === 'string' && fm.data.branch.trim() && !/^(?:null|none|无)$/i.test(fm.data.branch.trim())
    ? fm.data.branch.trim()
    : null
  const taskId = typeof fm?.data?.task_id === 'string' && fm.data.task_id.trim() && !/^(?:null|none|无)$/i.test(fm.data.task_id.trim())
    ? fm.data.task_id.trim()
    : null
  const related = {}
  for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
    const targetRel = resolveRelatedTargetRel(repoRoot, rel, fm?.data?.[rk])
    if (targetRel && targetRel.startsWith('docs/')) related[rk] = targetRel
  }
  return { kind, date: fn?.date ?? null, slug: fn?.slug ?? null, issue, pr, branch, taskId, related }
}

function isCompatibleActiveSibling(candRel, candMeta, { seedRel, seedMeta, explicitSet, groupIssue, targetDate, byRelMeta }) {
  if (candRel === seedRel || explicitSet.has(candRel)) return true
  if (groupIssue && candMeta.issue && candMeta.issue !== groupIssue) return false
  if (seedMeta) {
    if (seedMeta.pr && candMeta.pr && candMeta.pr !== seedMeta.pr) return false
    if (seedMeta.taskId && candMeta.taskId && candMeta.taskId !== seedMeta.taskId) return false
    if (seedMeta.branch && candMeta.branch && candMeta.branch !== seedMeta.branch) return false

    const linkedSeedToCand = seedRel && Object.values(candMeta.related).includes(seedRel)
    const linkedCandToSeed = Object.values(seedMeta.related).includes(candRel)
    const explicitlyLinked = Boolean(linkedSeedToCand || linkedCandToSeed)
    if (!explicitlyLinked) {
      // 未显式互指时，若对方已绑定另一个明确 Issue 且自己无 Issue 且日期不同，不盲目混并
      if (!groupIssue && !seedMeta.issue && candMeta.issue && candMeta.date && targetDate && candMeta.date !== targetDate) {
        return false
      }
      // 同一类型（如两份独立活跃 SPEC）重名 slug 在不同日期不得互吞
      if (seedMeta.kind && candMeta.kind && candMeta.kind === seedMeta.kind) return false
      // 明确指向其他同类型文档则属于另一件事
      if (seedMeta.kind && candMeta.related[`related_${seedMeta.kind}`] && candMeta.related[`related_${seedMeta.kind}`] !== seedRel) {
        return false
      }
      if (candMeta.kind && seedMeta.related[`related_${candMeta.kind}`] && seedMeta.related[`related_${candMeta.kind}`] !== candRel) {
        return false
      }
    }
  }
  for (const [expRel, expMeta] of byRelMeta.entries()) {
    if (expRel === candRel) continue
    if (expMeta.issue && candMeta.issue && candMeta.issue !== expMeta.issue) return false
    if (expMeta.pr && candMeta.pr && candMeta.pr !== expMeta.pr) return false
    if (expMeta.taskId && candMeta.taskId && candMeta.taskId !== expMeta.taskId) return false
    if (expMeta.branch && candMeta.branch && candMeta.branch !== expMeta.branch) return false
    if (expMeta.kind && candMeta.kind === expMeta.kind && !Object.values(expMeta.related).includes(candRel) && !Object.values(candMeta.related).includes(expRel)) {
      return false
    }
  }
  return true
}

function collectSiblingSet(repoRoot, { slugOrPath, includeArchived = false, explicitRels = [], currentIssue = null } = {}) {
  const activeDirs = ['docs/prd', 'docs/specs', 'docs/todo']
  const archiveDirs = ['docs/archive/prd', 'docs/archive/specs', 'docs/archive/todo']
  const allActive = activeDirs.flatMap((d) => listDocsInFolder(repoRoot, d))
  const allArchived = archiveDirs.flatMap((d) => listDocsInFolder(repoRoot, d))

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
  const explicitSet = new Set()
  if (seedRel && (includeArchived || !seedRel.startsWith('docs/archive/'))) {
    siblingSet.add(seedRel)
    explicitSet.add(seedRel)
  }
  for (const expRel of explicitRels) {
    const norm = posixPath(expRel)
    if (norm && existsSync(join(repoRoot, norm)) && norm.startsWith('docs/') && (includeArchived || !norm.startsWith('docs/archive/'))) {
      siblingSet.add(norm)
      explicitSet.add(norm)
    }
  }

  const byRelMeta = new Map()
  for (const r of explicitSet) byRelMeta.set(r, readDocIdentityMeta(repoRoot, r))
  const seedMeta = seedRel ? (byRelMeta.get(seedRel) ?? readDocIdentityMeta(repoRoot, seedRel)) : null

  let groupIssue = Number.isInteger(Number(currentIssue)) && Number(currentIssue) > 0 ? Number(currentIssue) : null
  if (!groupIssue) {
    for (const rel of explicitSet) {
      const iss = byRelMeta.get(rel)?.issue ?? docIssueNumber(repoRoot, rel)
      if (iss) { groupIssue = iss; break }
    }
  }

  const slugMatches = []
  // 仅按 slug 匹配活跃目录，绝不以裸 slug 拉入 docs/archive/** 历史同 slug 文档
  for (const rel of allActive) {
    const fn = parseDocFilename(rel)
    const matched = (fn && targetSlug && fn.slug === targetSlug)
      || (!fn && targetSlug && basename(rel, '.md') === targetSlug)
    if (!matched) continue
    const candMeta = readDocIdentityMeta(repoRoot, rel)
    if (!rel.startsWith('docs/archive/') && !isCompatibleActiveSibling(rel, candMeta, { seedRel, seedMeta, explicitSet, groupIssue, targetDate, byRelMeta })) continue
    slugMatches.push({ rel, meta: candMeta })
  }

  // 若某个类型在同 slug 活跃区同时存在多个无明确关联文档，只收精确日匹配或已互指者，避免误合并不同任务
  const byKindCount = new Map()
  for (const m of slugMatches) {
    if (!m.meta.kind) continue
    byKindCount.set(m.meta.kind, (byKindCount.get(m.meta.kind) ?? 0) + 1)
  }
  for (const { rel, meta } of slugMatches) {
    const isLinked = explicitSet.has(rel)
      || (seedRel && Object.values(meta.related).includes(seedRel))
      || (seedMeta && Object.values(seedMeta.related).includes(rel))
    if (!isLinked && meta.kind && (byKindCount.get(meta.kind) ?? 0) > 1) {
      if (!(targetDate && meta.date === targetDate)) continue
    }
    siblingSet.add(rel)
  }

  if (!groupIssue) {
    for (const rel of siblingSet) {
      const iss = docIssueNumber(repoRoot, rel)
      if (iss) { groupIssue = iss; break }
    }
  }

  // 条件 ③（返工重归档）：仅允许同非空 issue 且同 slug（如同 YYYYMMDD-issueN-slug-*）的归档文档进入集合
  if (includeArchived && groupIssue && targetSlug) {
    for (const archRel of allArchived) {
      const fn = parseDocFilename(archRel)
      if (fn && fn.issue === groupIssue && fn.slug === targetSlug) {
        siblingSet.add(archRel)
      }
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
      if (!rv || typeof rv !== 'string' || /^(?:无|none|null)$/i.test(rv.trim())) continue
      const resolvedAbs = resolve(dirname(join(repoRoot, curRel)), rv)
      const resolvedRel = posixPath(relative(repoRoot, resolvedAbs))
      if (!existsSync(resolvedAbs) || !resolvedRel.startsWith('docs/') || seenFollow.has(resolvedRel)) continue
      if (resolvedRel.startsWith('docs/archive/')) {
        if (!includeArchived) continue
        const targetIssue = docIssueNumber(repoRoot, resolvedRel)
        if (groupIssue && targetIssue && targetIssue !== groupIssue) continue
      }
      seenFollow.add(resolvedRel)
      siblingSet.add(resolvedRel)
      queue.push(resolvedRel)
    }
  }

  return { siblingSet, allActive, allArchived, seedRel, targetDate, targetSlug }
}

function resolveRelatedTargetRel(repoRoot, fromRel, relLink) {
  if (!relLink || typeof relLink !== 'string') return null
  const trimmed = relLink.trim()
  if (!trimmed || /^(?:无|none|null)$/i.test(trimmed)) return null
  const abs = resolve(dirname(join(repoRoot, fromRel)), trimmed)
  return posixPath(relative(repoRoot, abs))
}

/**
 * 判定 PRD 是否为 1:N 多切片共享总控 PRD，避免被单个子切片生命周期改写或提前归档。
 */
export function isSharedMasterPrd(repoRoot, prdRel, activeSpecRel = null) {
  if (!prdRel) return false
  const prdNorm = posixPath(prdRel).replace(/^\.\//, '')
  const prdAbs = join(repoRoot, prdNorm)
  if (!existsSync(prdAbs)) return false
  const raw = readTextSafe(prdAbs) ?? ''
  const fm = parseDocFrontmatter(raw)
  const fn = parseDocFilename(prdNorm)
  const normActiveSpec = activeSpecRel ? posixPath(activeSpecRel).replace(/^\.\//, '') : null

  if (fm.data?.multi_spec === true || String(fm.data?.archive_policy ?? '').toLowerCase() === 'manual') {
    return true
  }

  for (const archSpec of listDocsInFolder(repoRoot, 'docs/archive/specs')) {
    if (normActiveSpec && archSpec === normActiveSpec) continue
    const sFm = parseDocFrontmatter(readTextSafe(join(repoRoot, archSpec)) ?? '')
    if (resolveRelatedTargetRel(repoRoot, archSpec, sFm.data?.related_prd) === prdNorm) {
      return true
    }
  }

  for (const otherSpec of listDocsInFolder(repoRoot, 'docs/specs')) {
    if (normActiveSpec && otherSpec === normActiveSpec) continue
    const sFm = parseDocFrontmatter(readTextSafe(join(repoRoot, otherSpec)) ?? '')
    if (resolveRelatedTargetRel(repoRoot, otherSpec, sFm.data?.related_prd) === prdNorm) {
      return true
    }
  }

  for (const otherTodo of listDocsInFolder(repoRoot, 'docs/todo')) {
    const tFm = parseDocFrontmatter(readTextSafe(join(repoRoot, otherTodo)) ?? '')
    if (resolveRelatedTargetRel(repoRoot, otherTodo, tFm.data?.related_prd) !== prdNorm) continue
    const linkedSpec = resolveRelatedTargetRel(repoRoot, otherTodo, tFm.data?.related_spec)
    if (normActiveSpec) {
      if (linkedSpec && linkedSpec !== normActiveSpec) return true
      if (!linkedSpec && parseDocFilename(otherTodo)?.slug !== fn?.slug) return true
    } else {
      const prdRelSpec = resolveRelatedTargetRel(repoRoot, prdNorm, fm.data?.related_spec)
      if (linkedSpec && prdRelSpec && linkedSpec !== prdRelSpec) return true
      if (!prdRelSpec && parseDocFilename(otherTodo)?.slug !== fn?.slug) return true
    }
  }

  if ((fm.data?.related_spec === null || fm.data?.related_spec === undefined) && normActiveSpec) {
    const specSlug = parseDocFilename(normActiveSpec)?.slug
    if (fn?.slug && specSlug && fn.slug !== specSlug && /^- \[ \]\s+C\d+/m.test(raw)) {
      return true
    }
  }
  return false
}

/** 同步 PRD / SPEC / Todo 生命周期、重命名、互链与任务账本（不再锁在 renameMap > 0）。 */
export async function syncDocsLifecycle(repoRoot, {
  slugOrPath, issue, pr, branch, owner, ownerReason, status, approved, implemented, doneAt, planCritique,
  preserveTerminalStatus = false, ledgerRoot = null,
} = {}) {
  const preIssue = issue !== undefined && issue !== null && String(issue).trim() !== ''
    ? Number(String(issue).replace(/^#/, '').trim())
    : null
  const { siblingSet, allActive, allArchived, seedRel, targetDate, targetSlug } = collectSiblingSet(repoRoot, {
    slugOrPath,
    currentIssue: Number.isInteger(preIssue) && preIssue > 0 ? preIssue : null,
  })

  const activeSpecRel = [...siblingSet].find((p) => inferDocKindFromPath(p, null) === 'spec')
    ?? (seedRel && inferDocKindFromPath(seedRel, null) === 'spec' ? seedRel : null)
  const sharedPrds = new Set(
    [...siblingSet].filter((p) => inferDocKindFromPath(p, null) === 'prd' && isSharedMasterPrd(repoRoot, p, activeSpecRel)),
  )

  const normalizedIssue = issue !== undefined && issue !== null && String(issue).trim() !== ''
    ? Number(String(issue).replace(/^#/, '').trim())
    : undefined
  let effectiveIssue = Number.isInteger(normalizedIssue) && normalizedIssue > 0 ? normalizedIssue : undefined

  if (effectiveIssue === undefined) {
    for (const rel of siblingSet) {
      if (sharedPrds.has(rel)) continue
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
    const isSharedMaster = sharedPrds.has(oldRel)
    const dateFromCreated = typeof fm.data?.created === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.data.created)
      ? `${fm.data.created.slice(2, 4)}${fm.data.created.slice(5, 7)}${fm.data.created.slice(8, 10)}`
      : null
    const docDate = fn?.date ?? targetDate ?? dateFromCreated ?? docDateTag()
    const docSlug = fn?.slug ?? targetSlug
    let currentRel = oldRel

    if (!isSharedMaster && effectiveIssue && kind && docSlug) {
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
    finalSiblings.push({ oldRel, rel: currentRel, kind, date: docDate, slug: docSlug, isSharedMaster })
  }

  const byKind = { prd: null, spec: null, todo: null }
  for (const s of finalSiblings) {
    if (s.kind && !byKind[s.kind]) byKind[s.kind] = s.rel
  }
  if (seedRel && seedRel.startsWith('docs/archive/')) {
    const k = inferDocKindFromPath(seedRel, null)
    if (k && !byKind[k]) byKind[k] = seedRel
  }

  const updated = []
  const today = docIsoDate()
  for (const sib of finalSiblings) {
    if (sib.isSharedMaster) continue
    const abs = join(repoRoot, sib.rel)
    let raw = readTextSafe(abs) ?? ''
    raw = replaceDocReferencesSinglePass(raw, renameMap)
    const fm = parseDocFrontmatter(raw)
    const patch = { updated: today }
    if (sib.kind && !fm.data.kind) patch.kind = sib.kind
    if (effectiveIssue !== undefined) patch.issue = effectiveIssue
    if (pr !== undefined) patch.pr = pr === null ? null : Number(pr)
    if (branch !== undefined) patch.branch = branch

    // 负责人变更要留痕：原负责人进历史集合，理由进文档。
    //
    // 自审锁判的是「这个人在这个文档上有没有话语权」，而只看当前字段的话，
    // 改一行 Frontmatter 就能让原负责人以复核人身份重新登场——他写的稿子还在这里。
    // 所以变更必须带理由，并把原负责人留在历史里，三处自审判定按「历史 ∪ 当前」比对。
    if (owner !== undefined) {
      const prevOwner = String(fm.data?.owner ?? '').trim()
      const nextOwner = String(owner ?? '').trim()
      const changing = Boolean(prevOwner) && prevOwner !== 'null' && prevOwner !== nextOwner
      if (changing) {
        const why = String(ownerReason ?? '').trim()
        if (!why) {
          throw Object.assign(
            new Error(`OWNER_CHANGE_REASON_REQUIRED: ${sib.rel} 的负责人要从 ${prevOwner} 改成 ${nextOwner}，`
              + '必须同时传 --owner-reason "<变更原因>"。原负责人会进历史集合，自审锁按历史比对，'
              + '不留痕的改写等于让原负责人换个身份继续给自己放行。'),
            { code: 'OWNER_CHANGE_REASON_REQUIRED', exitCode: EXIT.USAGE },
          )
        }
        patch.owner = nextOwner
        patch[PREVIOUS_OWNERS_KEY] = [...new Set([...collectOwnerHistory(fm.data), prevOwner])]
        patch.owner_changed_reason = why
        patch.owner_changed_at = today
      } else {
        patch.owner = owner
      }
    }

    if (status !== undefined) {
      const curSt = String(fm.data?.status ?? '').toLowerCase()
      const isTerminal = ['done', 'implemented', 'superseded', 'archived'].includes(curSt)
      if (!preserveTerminalStatus || !isTerminal) {
        patch.status = status
        // 回退必须同批清标记：状态与批准标记是同一件事的两面，
        // 只改一面就会留下「已回退到草稿、批准仍为真」的文档——而分诊豁免只看那个标记。
        if (!isApprovingStatus(sib.kind, status)) {
          patch.approved = false
          patch.implemented = false
        }
      }
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

  const groupRelList = finalSiblings.flatMap((s) => [s.oldRel, s.rel])
  const effectiveLedgerRoot = await resolveLedgerRoot(repoRoot, ledgerRoot)
  recordPlanningProvenance(effectiveLedgerRoot, {
    docRoot: repoRoot, docRels: updated.map((u) => u.file), isLegitimateTransfer: Boolean(owner && ownerReason), renameMap,
  })
  for (const ledger of listTaskLedgers(effectiveLedgerRoot)) {
    const patch = {}
    let dirty = false
    for (const field of ['prdFile', 'specFile', 'todoFile', 'archivedTodoFile', 'archivedSpecFile', 'archivedPrdFile']) {
      if (ledger[field] && renameMap.has(ledger[field])) {
        patch[field] = renameMap.get(ledger[field]); dirty = true
      }
    }
    if (ledgerMatchesGroup(ledger, groupRelList, targetSlug, effectiveIssue)) {
      if (effectiveIssue && Array.isArray(ledger.linkedIssues) && !ledger.linkedIssues.includes(effectiveIssue)) {
        patch.linkedIssues = [...ledger.linkedIssues, effectiveIssue]; dirty = true
      }
      if (pr !== undefined && pr !== null && Number(ledger.prNumber) !== Number(pr)) {
        patch.prNumber = Number(pr); dirty = true
      }
      if (byKind.prd && !ledger.prdFile) { patch.prdFile = byKind.prd; dirty = true }
      if (byKind.spec && !ledger.specFile) { patch.specFile = byKind.spec; dirty = true }
      if (byKind.todo && !ledger.todoFile) { patch.todoFile = byKind.todo; dirty = true }
    }
    if (dirty) await updateTaskLedger(effectiveLedgerRoot, ledger.taskId, patch)
  }

  return { renamed, updated, byKind, issue: effectiveIssue ?? null, sharedMasterPrds: [...sharedPrds] }
}

/** 成对归档 PRD / SPEC / Todo 至 `docs/archive/`，同步互链与账本，并按 C19 四态规则闭环总控 PRD。 */
export async function archiveCompletedDocsGroup(repoRoot, {
  prdFile, specFile, todoFile, slugOrPath, issue, pr, branch, owner, doneAt,
  includeMasterPrd = false, ledgerRoot = null,
} = {}) {
  const seedInput = specFile ?? todoFile ?? prdFile ?? slugOrPath
  const explicitRels = [prdFile, specFile, todoFile].filter(Boolean)
  const numericIssue = issue !== undefined && issue !== null && String(issue).trim() !== ''
    ? Number(String(issue).replace(/^#/, '').trim())
    : null
  const { siblingSet, targetSlug } = collectSiblingSet(repoRoot, {
    slugOrPath: seedInput, includeArchived: true, explicitRels,
    currentIssue: Number.isInteger(numericIssue) && numericIssue > 0 ? numericIssue : null,
  })

  for (const explicitRel of explicitRels) {
    const norm = posixPath(explicitRel)
    if (existsSync(join(repoRoot, norm))) siblingSet.add(norm)
    else if (norm.startsWith('docs/prd/')) {
      const arch = `docs/archive/prd/${basename(norm)}`
      if (existsSync(join(repoRoot, arch))) siblingSet.add(arch)
    }
  }

  const activeSpecRel = (specFile ? posixPath(specFile) : null) ?? [...siblingSet].find((p) => inferDocKindFromPath(p, null) === 'spec') ?? null
  const activeTodoRel = (todoFile ? posixPath(todoFile) : null) ?? [...siblingSet].find((p) => inferDocKindFromPath(p, null) === 'todo') ?? null
  const wasSharedPrds = new Set(
    [...siblingSet].filter((p) => inferDocKindFromPath(p, null) === 'prd' && isSharedMasterPrd(repoRoot, p, activeSpecRel)),
  )
  const skippedSharedPrds = new Set()
  const masterPrdClosures = []
  for (const p of [...siblingSet].filter((rel) => inferDocKindFromPath(rel, null) === 'prd')) {
    const closure = evaluateMasterPrdClosureState(repoRoot, p, { currentSpecRel: activeSpecRel, currentTodoRel: activeTodoRel, includeMasterPrd })
    masterPrdClosures.push(closure)
    if (!includeMasterPrd && (wasSharedPrds.has(p) || (closure.isMasterPrd && closure.shouldHold)) && (closure.shouldHold || closure.blocked)) {
      skippedSharedPrds.add(p)
    }
  }

  const archiveDirByKind = { prd: 'docs/archive/prd', spec: 'docs/archive/specs', todo: 'docs/archive/todo' }
  const moveMap = new Map()
  const moved = []
  const groupItems = []

  for (const oldRel of [...siblingSet].sort()) {
    const fm = parseDocFrontmatter(readTextSafe(join(repoRoot, oldRel)) ?? '')
    const kind = inferDocKindFromPath(oldRel, fm.data)
    const isSharedMaster = skippedSharedPrds.has(oldRel)
    const wasSharedMaster = wasSharedPrds.has(oldRel)
    let curRel = oldRel
    if (kind && !oldRel.startsWith('docs/archive/') && !isSharedMaster) {
      const targetRel = `${archiveDirByKind[kind]}/${basename(oldRel)}`
      if (targetRel !== oldRel) {
        await moveDocWithGit(repoRoot, oldRel, targetRel)
        moveMap.set(oldRel, targetRel)
        moved.push({ from: oldRel, to: targetRel, kind })
        curRel = targetRel
      }
    }
    groupItems.push({ oldRel, rel: curRel, kind, isSharedMaster, wasSharedMaster })
  }

  const byKind = { prd: null, spec: null, todo: null }
  for (const it of groupItems) if (it.kind && !it.oldRel.startsWith('docs/archive/') && !byKind[it.kind]) byKind[it.kind] = it.rel
  for (const it of groupItems) if (it.kind && !byKind[it.kind]) byKind[it.kind] = it.rel

  const today = doneAt ?? docIsoDate()
  const updated = []
  for (const item of groupItems) {
    if (item.isSharedMaster || (item.oldRel.startsWith('docs/archive/prd/') && item.kind === 'prd')) continue
    const abs = join(repoRoot, item.rel)
    let raw = replaceDocReferencesSinglePass(readTextSafe(abs) ?? '', moveMap)
    for (const [movedOldRel, movedNewRel] of moveMap.entries()) {
      if (movedOldRel.startsWith('docs/prd/') && movedNewRel.startsWith('docs/archive/prd/')) {
        const base = basename(movedOldRel)
        if (item.rel.startsWith('docs/archive/')) raw = raw.replace(new RegExp(`\\.\\./\\.\\./prd/${escapeRegExpStr(base)}`, 'g'), `../prd/${base}`)
        else raw = raw.replace(new RegExp(`(\\.\\./)prd/${escapeRegExpStr(base)}`, 'g'), `$1archive/prd/${base}`)
      }
    }
    if (item.rel.startsWith('docs/archive/') && !item.oldRel.startsWith('docs/archive/')) {
      for (const sharedRel of skippedSharedPrds) {
        const base = basename(sharedRel)
        raw = raw.replace(new RegExp(`\\.\\./prd/${escapeRegExpStr(base)}`, 'g'), `../../prd/${base}`)
      }
    }
    const fm = parseDocFrontmatter(raw)
    const preserveMasterMeta = item.wasSharedMaster || (
      item.oldRel.startsWith('docs/archive/prd/') && item.kind === 'prd'
      && !parseDocFilename(item.oldRel)?.issue && fm.data?.issue == null && fm.data?.related_spec == null
    )
    const relatedTargets = {}
    if (!preserveMasterMeta) {
      for (const [rk, targetKind] of [['related_prd', 'prd'], ['related_spec', 'spec'], ['related_todo', 'todo']]) {
        if (item.kind !== targetKind && byKind[targetKind]) {
          relatedTargets[rk] = posixPath(relative(dirname(abs), join(repoRoot, byKind[targetKind])))
        }
      }
    }
    const patch = buildArchivedDocPatch({ kind: item.kind, fmData: fm.data, today, issue, pr, branch, owner, preserveMasterMeta, relatedTargets })
    const merged = { ...fm.data }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v
    const keyOrder = [...(DOC_FRONTMATTER_KEY_ORDER[item.kind] ?? []), ...fm.keyOrder, ...Object.keys(merged)]
    const cleanBody = fm.body.replace(/^\n+/, '')
    writeAtomic(abs, `${serializeDocFrontmatter(merged, keyOrder)}\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`)
    updated.push({ file: item.rel, kind: item.kind, status: merged.status })
  }

  const sharedMasterRels = new Set([
    ...skippedSharedPrds,
    ...groupItems.filter((g) => g.wasSharedMaster).flatMap((g) => [g.oldRel, g.rel]),
  ])
  const archivedMasterPrd = groupItems.find((g) => g.wasSharedMaster && g.rel.startsWith('docs/archive/'))?.rel ?? null
  const archiveMembers = groupItems
    .filter((g) => !sharedMasterRels.has(g.rel) && !sharedMasterRels.has(g.oldRel))
    .flatMap((g) => [g.oldRel, g.rel])
  const numericIssueArg = Number.isInteger(numericIssue) && numericIssue > 0 ? numericIssue : null
  const effectiveLedgerRoot = await resolveLedgerRoot(repoRoot, ledgerRoot)
  for (const ledger of listTaskLedgers(effectiveLedgerRoot)) {
    const patch = {}
    let dirty = false
    if (ledgerMatchesGroup(ledger, archiveMembers, targetSlug, numericIssueArg)) {
      if (byKind.prd) {
        patch.prdFile = byKind.prd
        patch.archivedPrdFile = skippedSharedPrds.has(byKind.prd) ? null : (byKind.prd.startsWith('docs/archive/') ? byKind.prd : ledger.archivedPrdFile)
        dirty = true
      }
      if (byKind.spec) { patch.specFile = byKind.spec; patch.archivedSpecFile = byKind.spec; dirty = true }
      if (byKind.todo) { patch.todoFile = byKind.todo; patch.archivedTodoFile = byKind.todo; dirty = true }
    } else if (archivedMasterPrd && sharedMasterRels.has(ledger.prdFile)) {
      patch.prdFile = archivedMasterPrd
      patch.archivedPrdFile = archivedMasterPrd
      dirty = true
    }
    if (dirty) await updateTaskLedger(effectiveLedgerRoot, ledger.taskId, patch)
  }
  return {
    moved, updated, byKind, archivedMasterPrd, masterPrdClosures,
    archived: groupItems.filter((g) => !g.isSharedMaster).map((g) => g.rel),
    sharedMasterPrds: [...skippedSharedPrds],
  }
}

export {
  buildArchivedDocPatch,
  buildIssueCloseComment,
  buildMergeComments,
  buildReviewComments,
  buildStandardDocContent,
  buildSubmitComments,
  checkMermaidLabelWidth,
  displayWidth,
  evaluateCoupledSync,
  formatAttribution,
  MERMAID_LIMITS,
  parseCoupledSyncRules,
  resolveRepoCustomDocTemplate,
} from './doc-templates.mjs'
import { buildArchivedDocPatch, buildStandardDocContent } from './doc-templates.mjs'

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
