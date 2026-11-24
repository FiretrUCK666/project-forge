/**
 * plan-index.mjs —— 全仓规划文档（PRD / SPEC / Todo / Archive / Worktree）唯一只读索引与防重原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 `kit/skills/lib/`），
 * 替换 `collectPlanDocs`、`collectCandidateDocs`、`listDocs` 三套重复扫描器，
 * 并切断 `session-orient.mjs -> dev-plan/scripts/doc-audit.mjs` 反向依赖。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { isManagedPlanDoc, parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { exitCodeForBlocked } from './exit-codes.mjs'
import { canonicalPath, posixPath, readTextSafe } from './git.mjs'
import { sanitizeTaskId } from './ledger.mjs'

/** 不参与当前规划或阻塞的惰性/终态文档状态。 */
export const INERT_PLAN_STATUSES = Object.freeze(new Set(['superseded', 'dropped', 'archived']))

/** 已完成状态：依赖到它们视为已满足。 */
export const DONE_PLAN_STATUSES = Object.freeze(new Set(['implemented', 'done', 'merged', 'cleaned', 'archived']))

/** 按文档类型统一的已批准/就绪状态集合（单源定义，供 session-orient / plan-next / doc-plan 共用）。 */
export const APPROVED_STATUS_BY_KIND = Object.freeze({
  prd: Object.freeze(new Set(['active', 'in_review', 'done'])),
  spec: Object.freeze(new Set(['approved', 'implementing', 'in_review', 'implemented', 'done', 'archived'])),
  todo: Object.freeze(new Set(['active', 'in_review', 'done', 'archived'])),
})

const PLAN_DIR_KINDS = Object.freeze([
  ['docs/prd', 'prd', false],
  ['docs/specs', 'spec', false],
  ['docs/todo', 'todo', false],
])

const ARCHIVE_DIR_KINDS = Object.freeze([
  ['docs/archive/prd', 'prd', true],
  ['docs/archive/specs', 'spec', true],
  ['docs/archive/todo', 'todo', true],
])

/** 推断规划文档类型（`prd` | `spec` | `todo` | `tdd`）。 */
export function inferPlanDocKind(relPath, fmData = null) {
  const k = typeof fmData?.kind === 'string' ? fmData.kind.trim().toLowerCase() : ''
  if (k === 'prd' || k === 'spec' || k === 'todo') return k
  const low = posixPath(String(relPath ?? '')).toLowerCase()
  if (low === 'docs/tdd.md') return 'tdd'
  if (low.includes('/prd/') || low.startsWith('docs/prd/')) return 'prd'
  if (low.includes('/specs/') || low.startsWith('docs/specs/')) return 'spec'
  if (low.includes('/todo/') || low.startsWith('docs/todo/')) return 'todo'
  return parseDocFilename(low)?.kind ?? 'spec'
}

/** 统一判定规划文档是否处于已批准/就绪态。 */
export function isPlanDocApproved(doc) {
  if (!doc) return false
  const kind = String(doc.kind ?? '').toLowerCase()
  const status = String(doc.status ?? doc.data?.status ?? '').trim().toLowerCase()
  if (kind === 'prd') return APPROVED_STATUS_BY_KIND.prd.has(status)
  if (kind === 'todo') return APPROVED_STATUS_BY_KIND.todo.has(status)
  return APPROVED_STATUS_BY_KIND.spec.has(status) || doc.data?.approved === true
}

function parsePositiveInt(val) {
  if (val === undefined || val === null || val === '') return null
  const num = Number(String(val).replace(/^#/, '').trim())
  return Number.isInteger(num) && num > 0 ? num : null
}

function listMarkdownFilesSafe(dirAbs, { recursive = false } = {}) {
  if (!existsSync(dirAbs)) return []
  const out = []
  try {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
      const full = join(dirAbs, ent.name)
      if (ent.isDirectory()) {
        if (recursive) out.push(...listMarkdownFilesSafe(full, { recursive: true }))
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(full)
      }
    }
  } catch { /* ignore unreadable dir */ }
  return out.sort()
}

function normalizeDocSlug(rel, fmData) {
  const fn = parseDocFilename(rel)
  if (fn?.slug) return fn.slug
  const fromBase = basename(String(rel ?? ''), '.md')
    .toLowerCase()
    .replace(/^\d{6,8}-(?:issue\d+-)?/, '')
    .replace(/-(?:prd|spec|todo)$/, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (fromBase) return fromBase
  if (typeof fmData?.task_id === 'string' && fmData.task_id.trim()) {
    return fmData.task_id.trim().toLowerCase()
  }
  return null
}

function buildIndexedDocEntry({ root, abs, rel, kind, archived, locationType, text, fm }) {
  const data = fm.data ?? {}
  const rawStatus = data.status ?? null
  const status = typeof rawStatus === 'string' && rawStatus.trim()
    ? rawStatus.trim().toLowerCase()
    : (archived ? 'archived' : 'draft')
  const title = /^#\s+(.+)$/m.exec(fm.body || text)?.[1]?.trim() ?? data.title ?? basename(rel)
  const fn = parseDocFilename(rel)
  const issue = fn?.issue ?? parsePositiveInt(data.issue)
  const pr = parsePositiveInt(data.pr)
  const totalChecks = (text.match(/^- \[[ xX]\]/gm) ?? []).length
  const doneChecks = (text.match(/^- \[[xX]\]/gm) ?? []).length
  const doc = {
    root,
    abs,
    rel,
    file: rel,
    kind,
    archived: Boolean(archived || rel.startsWith('docs/archive/')),
    status,
    rawStatus,
    title,
    created: data.created ?? null,
    plannedAt: data.planned_at ?? null,
    issue,
    pr,
    slug: normalizeDocSlug(rel, data),
    taskId: typeof data.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : null,
    totalChecks,
    doneChecks,
    inert: Boolean(archived || rel.startsWith('docs/archive/') || INERT_PLAN_STATUSES.has(status)),
    locationType,
    data,
    text,
  }
  doc.approved = isPlanDocApproved(doc)
  return doc
}

/** 解析规划文档扫描根目录列表（当前工作区、任务 worktree、在途规划 worktree 与主仓，去重保序）。 */
export function resolvePlanDocRoots({
  repoRoot = null,
  mainRoot = repoRoot,
  taskId = null,
  ledger = null,
  file = null,
  includeWorktrees = true,
} = {}) {
  const roots = []
  const seen = new Set()
  const addRoot = (dir, source) => {
    if (!dir || !existsSync(dir)) return
    const normKey = canonicalPath(dir)
    const key = process.platform === 'win32' ? normKey.toLowerCase() : normKey
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ dir: resolve(dir), source })
  }

  if (file && repoRoot) addRoot(repoRoot, 'cwd')
  if (ledger?.worktreePath && mainRoot) addRoot(join(mainRoot, ledger.worktreePath), 'task-worktree')
  if (taskId && mainRoot) addRoot(join(mainRoot, '.worktrees', `impl-${sanitizeTaskId(taskId)}`), 'task-worktree')
  if (repoRoot && mainRoot) addRoot(repoRoot, 'cwd')

  if (includeWorktrees && mainRoot) {
    const wtBase = join(mainRoot, '.worktrees')
    if (existsSync(wtBase)) {
      try {
        for (const ent of readdirSync(wtBase, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!ent.isDirectory() || !ent.name.startsWith('impl-')) continue
          addRoot(join(wtBase, ent.name), 'planning-worktree')
        }
      } catch { /* ignore unreadable .worktrees */ }
    }
  }
  if (mainRoot) addRoot(mainRoot, 'main')
  return roots
}

/**
 * 统一规划文档单源索引器：扫描 `docs/{prd,specs,todo}`、可选 `docs/archive/**` 与 `.worktrees/impl-*`。
 *
 * 兼容两类传参：
 *   - `indexPlanDocs(repoRoot, opts)`
 *   - `indexPlanDocs({ repoRoot, mainRoot, ...opts })`
 */
export function indexPlanDocs(rootOrOpts, extraOpts = {}) {
  const opts = typeof rootOrOpts === 'string'
    ? { repoRoot: rootOrOpts, ...extraOpts }
    : { ...(rootOrOpts ?? {}) }
  const repoRoot = opts.repoRoot ?? opts.mainRoot ?? null
  const mainRoot = opts.mainRoot ?? repoRoot
  if (!repoRoot && !mainRoot) return []

  const includeArchive = opts.includeArchive !== false
  const includeWorktrees = Boolean(opts.includeWorktrees)
  const includeTdd = Boolean(opts.includeTdd)
  const managedOnly = Boolean(opts.managedOnly)
  const recursive = Boolean(opts.recursive)
  const ledger = opts.ledger ?? null
  const taskId = opts.taskId ?? null
  const file = opts.file ?? null

  const roots = includeWorktrees
    ? resolvePlanDocRoots({ repoRoot, mainRoot, taskId, ledger, file, includeWorktrees: true })
    : [{ dir: resolve(repoRoot || mainRoot), source: 'main' }]

  const privateRel = ledger?.privateDocsDir ? posixPath(String(ledger.privateDocsDir).trim()) : null
  const byRel = new Map()

  for (const r of roots) {
    const scanDirs = [...PLAN_DIR_KINDS]
    if (includeArchive && r.source === 'main') {
      if (recursive) {
        scanDirs.push(['docs/archive', 'archived', true])
      } else {
        scanDirs.push(...ARCHIVE_DIR_KINDS)
      }
    }
    if (privateRel) scanDirs.push([privateRel, null, false])

    for (const [dirRel, fallbackKind, isArchiveDir] of scanDirs) {
      const dirAbs = join(r.dir, dirRel)
      if (!existsSync(dirAbs)) continue
      const locType = dirRel === privateRel ? 'private-docs' : r.source
      for (const abs of listMarkdownFilesSafe(dirAbs, { recursive: recursive && isArchiveDir })) {
        const rel = posixPath(relative(r.dir, abs))
        if (byRel.has(rel)) continue
        const text = readTextSafe(abs)
        if (text === undefined) continue
        if (managedOnly && !isManagedPlanDoc(rel, text)) continue
        const fm = parseDocFrontmatter(text)
        const kind = fallbackKind && fallbackKind !== 'archived'
          ? (fm.data?.kind && ['prd', 'spec', 'todo'].includes(String(fm.data.kind).toLowerCase())
              ? String(fm.data.kind).toLowerCase()
              : fallbackKind)
          : inferPlanDocKind(rel, fm.data)
        byRel.set(rel, buildIndexedDocEntry({
          root: r.dir,
          abs,
          rel,
          kind,
          archived: Boolean(isArchiveDir || rel.startsWith('docs/archive/')),
          locationType: locType,
          text,
          fm,
        }))
      }
    }

    if (includeTdd && r.source === 'main') {
      const tddRel = 'docs/TDD.md'
      const tddAbs = join(r.dir, tddRel)
      if (!byRel.has(tddRel) && existsSync(tddAbs)) {
        const text = readTextSafe(tddAbs)
        if (text !== undefined) {
          byRel.set(tddRel, buildIndexedDocEntry({
            root: r.dir,
            abs: tddAbs,
            rel: tddRel,
            kind: 'tdd',
            archived: false,
            locationType: r.source,
            text,
            fm: parseDocFrontmatter(text),
          }))
        }
      }
    }
  }

  return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel))
}

function resolveDocLinkRel(repoRoot, fromDocRel, rawTarget) {
  if (typeof rawTarget !== 'string') return null
  const s = rawTarget.trim()
  if (!s || /^(?:null|none|无)$/i.test(s)) return null
  const absTarget = resolve(repoRoot, dirname(fromDocRel), s)
  const relFromRoot = posixPath(relative(repoRoot, absTarget)).replace(/^\.\//, '')
  return relFromRoot || null
}

/**
 * 解析关联规划子图（沿着 `related_prd`、`related_spec`、`related_todo` 与反向子切片边），
 * 返回整图节点及就绪状态明细，供 `plan-next` 与 `doc-plan-ops` 原子就绪校验共用。
 */
export function resolveLinkedPlanGraph({
  repoRoot = process.cwd(),
  mainRoot = repoRoot,
  file = null,
  doc = null,
  allDocs = null,
} = {}) {
  const docs = Array.isArray(allDocs)
    ? allDocs
    : indexPlanDocs({ repoRoot, mainRoot, includeArchive: false, includeWorktrees: true, managedOnly: true })
  const byRel = new Map(docs.map((d) => [d.rel, d]))
  const startRel = doc?.rel ?? (file ? posixPath(String(file).trim()).replace(/^\.\//, '') : null)
  const rootDoc = (startRel && byRel.get(startRel)) ?? doc ?? null
  if (!rootDoc) {
    return { rootDoc: null, nodes: [], masterPrd: null, specs: [], todos: [], unreadyNodes: [], ready: true }
  }
  if (!byRel.has(rootDoc.rel)) byRel.set(rootDoc.rel, rootDoc)

  const visited = new Map()
  const queue = [rootDoc]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (!cur || visited.has(cur.rel)) continue
    visited.set(cur.rel, cur)

    for (const key of ['related_prd', 'related_spec', 'related_todo']) {
      const targetRel = resolveDocLinkRel(cur.root || repoRoot, cur.rel, cur.data?.[key])
      if (targetRel && byRel.has(targetRel) && !visited.has(targetRel)) {
        queue.push(byRel.get(targetRel))
      }
    }

    for (const cand of byRel.values()) {
      if (cand.inert || visited.has(cand.rel)) continue
      for (const key of ['related_prd', 'related_spec', 'related_todo']) {
        const candTarget = resolveDocLinkRel(cand.root || repoRoot, cand.rel, cand.data?.[key])
        if (candTarget && candTarget === cur.rel) {
          queue.push(cand)
          break
        }
      }
    }
  }

  const nodes = [...visited.values()].sort((a, b) => a.rel.localeCompare(b.rel))
  const masterPrd = nodes.find((n) => n.kind === 'prd' && !n.inert) ?? null
  const specs = nodes.filter((n) => n.kind === 'spec' && !n.inert)
  const todos = nodes.filter((n) => n.kind === 'todo' && !n.inert)
  const unreadyNodes = nodes.filter((n) => !n.inert && !isPlanDocApproved(n))
  return {
    rootDoc,
    nodes,
    masterPrd,
    specs,
    todos,
    unreadyNodes,
    ready: unreadyNodes.length === 0,
  }
}

function toDocSummary(doc) {
  return {
    file: doc.rel,
    title: doc.title,
    status: doc.rawStatus ?? null,
    created: doc.created,
    plannedAt: doc.plannedAt,
    issue: doc.issue,
    pr: doc.pr,
    totalChecks: doc.totalChecks,
    doneChecks: doc.doneChecks,
  }
}

/** 唯一规划文档摘要列表：直接替换 `doc-audit-repo.mjs` `listDocs` 与 `session-orient.mjs` 反向导入。 */
export function listPlanDocsSummary(repoRoot) {
  const docs = indexPlanDocs(repoRoot, {
    includeArchive: true,
    includeWorktrees: false,
    includeTdd: true,
    recursive: true,
  })
  const tddDoc = docs.find((d) => d.kind === 'tdd') ?? null
  return {
    tdd: tddDoc ? toDocSummary(tddDoc) : null,
    prds: docs.filter((d) => !d.archived && d.kind === 'prd').map(toDocSummary),
    specs: docs.filter((d) => !d.archived && d.kind === 'spec').map(toDocSummary),
    todos: docs.filter((d) => !d.archived && d.kind === 'todo').map(toDocSummary),
    archived: docs.filter((d) => d.archived).map(toDocSummary),
  }
}

/**
 * 全仓检索同 `slug` 或同 `issue` 的活跃非惰性规划文档（跨日期、跨工作树），供 `initDoc` 与 `intake-triage` 查重。
 */
export function findDuplicatePlanDocs(repoRoot, {
  mainRoot = repoRoot,
  slug = null,
  issue = null,
  kinds = [],
  includeWorktrees = true,
} = {}) {
  const cleanSlug = slug ? String(slug).trim().toLowerCase() : null
  const issueNum = parsePositiveInt(issue)
  const targetKinds = new Set((Array.isArray(kinds) ? kinds : []).map((k) => String(k).toLowerCase()).filter(Boolean))
  if (!cleanSlug && !issueNum) return []

  const allDocs = indexPlanDocs({
    repoRoot,
    mainRoot,
    includeArchive: false,
    includeWorktrees,
    managedOnly: true,
  })

  const matches = []
  for (const doc of allDocs) {
    if (doc.inert) continue
    if (targetKinds.size > 0 && !targetKinds.has(doc.kind)) continue
    const matchedBy = []
    if (issueNum && doc.issue === issueNum) matchedBy.push('issue')
    if (cleanSlug && doc.slug && doc.slug === cleanSlug) matchedBy.push('slug')
    if (matchedBy.length === 0) continue
    matches.push({
      rel: doc.rel,
      root: doc.root,
      kind: doc.kind,
      status: doc.status,
      issue: doc.issue,
      slug: doc.slug,
      taskId: doc.taskId,
      locationType: doc.locationType,
      matchedBy,
    })
  }
  return matches
}

/** 构造 `BLOCKED_DUPLICATE_PLAN_DOC`（exit 3）结构化错误，附已有文档路径与 `flow.mjs start` 接手指令。 */
export function buildDuplicatePlanDocError(matches, { slug = null, issue = null } = {}) {
  const first = matches[0]
  const taskHint = first?.taskId || first?.slug || slug || (issue ? `issue-${issue}` : 'task')
  const flagHint = first?.kind === 'spec'
    ? `--case 4 --spec "${first.rel}"`
    : (first?.kind === 'todo' ? `--case 3 --todo "${first.rel}"` : `--case 4`)
  const startCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskHint} ${flagHint}`
  const summaryList = matches.map((m) => `${m.rel} (kind=${m.kind}, status=${m.status}${m.issue ? `, issue=#${m.issue}` : ''}, hit=${m.matchedBy.join('+')})`).join('；')
  const err = new Error(
    `BLOCKED_DUPLICATE_PLAN_DOC: 仓库中已存在同 ${matches[0]?.matchedBy?.join('/') || 'slug/issue'} 的非惰性规划文档：${summaryList}。`
    + `请直接接手已有文档（${startCmd}），若确需覆盖重建请显式传 --force。`,
  )
  err.code = 'BLOCKED_DUPLICATE_PLAN_DOC'
  err.exitCode = exitCodeForBlocked('BLOCKED_DUPLICATE_PLAN_DOC')
  err.details = {
    duplicates: matches,
    takeoverCommand: startCmd,
  }
  return err
}

function formatMetaLinkVal(rel) {
  if (!rel || typeof rel !== 'string') return null
  const s = rel.trim()
  if (!s || /^(?:null|none|无)$/i.test(s)) return null
  return `\`${posixPath(s)}\``
}

/**
 * 单源双向正文投影：把 PRD / SPEC / Todo Frontmatter 生命周期字段同步进正文概览表与 Todo 断点状态。
 */
export function syncPlanDocBodyMeta(rawText, fmData = {}, extra = {}) {
  const raw = String(rawText ?? '')
  if (!raw) return raw
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const status = extra.status ?? (fmData?.status ? String(fmData.status).trim() : null)
  const today = extra.today ?? (fmData?.updated ? String(fmData.updated).trim() : null)
  const prdRel = extra.prdRel ?? (typeof fmData?.related_prd === 'string' && !/^(?:null|none|无)$/i.test(fmData.related_prd.trim()) ? fmData.related_prd.trim() : null)
  const todoRel = extra.todoRel ?? (typeof fmData?.related_todo === 'string' && !/^(?:null|none|无)$/i.test(fmData.related_todo.trim()) ? fmData.related_todo.trim() : null)
  const specRel = extra.specRel ?? (typeof fmData?.related_spec === 'string' && !/^(?:null|none|无)$/i.test(fmData.related_spec.trim()) ? fmData.related_spec.trim() : null)
  const critiquePassed = extra.critiquePassed ?? Boolean(fmData?.approved === true || /^passed/i.test(String(fmData?.plan_critique ?? '')))
  const issueNum = parsePositiveInt(fmData?.issue)
  const prNum = parsePositiveInt(fmData?.pr)
  const branch = typeof fmData?.branch === 'string' && fmData.branch.trim() && !/^(?:null|none|无)$/i.test(fmData.branch.trim()) ? fmData.branch.trim() : null
  const owner = typeof fmData?.owner === 'string' && fmData.owner.trim() && !/^(?:null|none|无)$/i.test(fmData.owner.trim()) ? fmData.owner.trim() : null
  const approvedFlag = (fmData?.approved === true || fmData?.approved === false) ? String(fmData.approved) : null

  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inTable = false
  let inBreakpoint = false

  for (const line of lines) {
    if (/^\|\s*(?:项目|字段|Key)\s*\|/.test(line)) { inTable = true; out.push(line); continue }
    if (inTable && !/^\s*\|/.test(line)) inTable = false
    if (/^##\s+断点与遗留决策/.test(line)) inBreakpoint = true
    else if (inBreakpoint && /^##\s+/.test(line)) inBreakpoint = false

    if (inBreakpoint && status && /^-\s+\*\*当前状态\*\*\s*[:：]/.test(line)) {
      const stLow = status.toLowerCase()
      const label = ['done', 'archived', 'implemented'].includes(stLow) ? `已完成 (${status})` : (stLow === 'active' ? '进行中' : status)
      out.push(line.replace(/^(-\s+\*\*当前状态\*\*\s*[:：]\s*)(?:`[^`]*`|[^\s（(]+)(.*)$/, `$1\`${label}\`$2`))
      continue
    }
    if (!inTable) { out.push(line); continue }

    const m = /^(\|\s*([^|]+?)\s*\|\s*)(.+?)(\s*\|\s*)$/.exec(line)
    if (!m) { out.push(line); continue }
    const [, prefix, rawKey, rawVal, suffix] = m
    const key = rawKey.trim()
    let nextVal = rawVal.trim()

    if (status && /^(?:当前状态|状态|Status)$/i.test(key)) {
      const rest = nextVal.replace(/^`?(?:draft|active|approved|implementing|in_review|implemented|done|pending|archived|dropped|superseded)`?/i, '').trim()
      nextVal = rest ? `\`${status}\`${rest.startsWith('（') || rest.startsWith('(') ? rest : ` ${rest}`}` : `\`${status}\``
    } else if (today && /^(?:创建\s*\/\s*更新|建单\s*\/\s*更新|更新日期|Updated)$/i.test(key)) {
      nextVal = /\//.test(nextVal) ? nextVal.replace(/(\s*\/\s*)`?\d{4}-\d{2}-\d{2}`?/, `$1\`${today}\``) : `\`${today}\``
    } else if (/^(?:负责人\s*\/\s*内审状态|内审状态)$/i.test(key)) {
      if (owner && /\//.test(nextVal)) nextVal = nextVal.replace(/^[^/]+?\s*\//, `${owner} /`)
      if (critiquePassed) nextVal = nextVal.replace(/`pending`/i, '`passed`')
    } else if (/^负责人\s*\/\s*审批$/.test(key)) {
      const parts = nextVal.split(/\s+\/\s+/).map((s) => s.trim())
      nextVal = `${owner ?? parts[0] ?? '未指定'} / ${approvedFlag ? `\`${approvedFlag}\`` : (parts[1] ?? '`false`')}`
    } else if (/^关联\s*Issue\s*\/\s*PR$/i.test(key)) {
      const parts = nextVal.split(/\s+\/\s+/).map((s) => s.trim())
      nextVal = `${issueNum ? `#${issueNum}` : (parts[0] ?? '未关联')} / ${prNum ? `#${prNum}` : (parts[1] ?? '未关联')}`
    } else if (/^分支\s*\/\s*Issue\s*\/\s*PR$/i.test(key)) {
      const parts = nextVal.split(/\s+\/\s+/).map((s) => s.trim())
      nextVal = `${branch ? `\`${branch}\`` : (parts[0] ?? '未关联')} / ${issueNum ? `#${issueNum}` : (parts[1] ?? '未关联')} / ${prNum ? `#${prNum}` : (parts[2] ?? '未关联')}`
    } else if (/^分支\s*\/\s*基线$/.test(key) && branch) {
      nextVal = nextVal.includes('@') ? nextVal.replace(/^[^@]+@/, `\`${branch}\` @`) : `\`${branch}\``
    } else if (/^关联\s*Issue\s*\/\s*PR\s*\/\s*SPEC$/i.test(key)) {
      const parts = nextVal.split(/\s+\/\s+/).map((s) => s.trim())
      nextVal = `${issueNum ? `#${issueNum}` : (parts[0] ?? '未关联')} / ${prNum ? `#${prNum}` : (parts[1] ?? '未关联')} / ${formatMetaLinkVal(specRel) ?? (parts[2] ?? '按需关联')}`
    } else if ((prdRel || todoRel) && /^(?:关联\s*PRD\s*\/\s*Todo|关联文档)$/i.test(key)) {
      const parts = nextVal.split(/\s+\/\s+/).map((s) => s.trim())
      const pFmt = formatMetaLinkVal(prdRel)
      const tFmt = formatMetaLinkVal(todoRel)
      if (parts.length >= 2) {
        nextVal = `${pFmt ?? parts[0]} / ${tFmt ?? parts.slice(1).join(' / ')}`
      } else if (pFmt && tFmt) {
        nextVal = `${pFmt} / ${tFmt}`
      } else if (pFmt) {
        nextVal = pFmt
      } else if (tFmt) {
        nextVal = `${parts[0] || '未关联'} / ${tFmt}`
      }
    } else if ((specRel || todoRel) && /^关联设计\s*\/\s*任务单$/.test(key)) {
      const sFmt = formatMetaLinkVal(specRel)
      const tFmt = formatMetaLinkVal(todoRel)
      if (sFmt && tFmt) nextVal = `${sFmt} / ${tFmt}`
      else if (sFmt) nextVal = sFmt
      else if (tFmt) nextVal = `未关联 / ${tFmt}`
    }
    out.push(`${prefix}${nextVal}${suffix}`)
  }
  const joined = out.join(eol)
  return raw.endsWith('\n') && !joined.endsWith('\n') ? `${joined}${eol}` : joined
}
