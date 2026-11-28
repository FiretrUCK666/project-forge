/**
 * master-criteria-sync.mjs —— 主文档优先级、planBootstrap 自动挂载过滤、
 * 1:N 总控验收进度聚合与 PR/Issue 同源验收进度表渲染单源。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），独立于 `doc-slice-graph.mjs`
 * 以守住单文件 <= 800 行边界。
 */

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { extractCriteria } from './criteria-lock.mjs'
import { buildSliceGraph, extractClaimedCriteria } from './doc-slice-graph.mjs'
import { posixPath, readTextSafe } from './git.mjs'

const TERMINAL_SLICE_STATUSES = new Set([
  'implemented',
  'done',
  'superseded',
  'dropped',
  'archived',
])

const PLAN_DOC_PATH_RE = /^docs\/(?:prd|specs|todo)\/.*\.md$/

/** 返回主规划文档解析顺序：`planBootstrap === true` 固定以 `prd` 唯一优先，常规切片维持 `spec -> todo -> prd`。 */
export function resolvePrimaryPlanDocOrder(ledger = null) {
  return ledger?.planBootstrap === true
    ? ['prd', 'spec', 'todo']
    : ['spec', 'todo', 'prd']
}

/** 返回规划文档目录扫描顺序，与 `resolvePrimaryPlanDocOrder` 同源。 */
export function resolvePlanBootstrapDirOrder(ledger = null) {
  return resolvePrimaryPlanDocOrder(ledger).map((kind) => (
    kind === 'spec' ? 'docs/specs' : (kind === 'todo' ? 'docs/todo' : 'docs/prd')
  ))
}

/** 按 `resolvePrimaryPlanDocOrder(ledger)` 输出去重后的账本规划文档候选路径列表。 */
export function resolvePrimaryPlanDocCandidates(ledger = null, { includePrivate = false } = {}) {
  const byKind = {
    prd: includePrivate
      ? [ledger?.privatePrdFile, ledger?.prdFile, ledger?.archivedPrdFile]
      : [ledger?.prdFile, ledger?.archivedPrdFile],
    spec: includePrivate
      ? [ledger?.privateSpecFile, ledger?.specFile, ledger?.archivedSpecFile]
      : [ledger?.specFile, ledger?.archivedSpecFile],
    todo: includePrivate
      ? [ledger?.privateTodoFile, ledger?.todoFile, ledger?.archivedTodoFile]
      : [ledger?.todoFile, ledger?.archivedTodoFile],
  }
  const out = []
  const seen = new Set()
  for (const kind of resolvePrimaryPlanDocOrder(ledger)) {
    for (const raw of byKind[kind] ?? []) {
      const clean = posixPath(String(raw ?? '').trim()).replace(/^\.\//, '')
      if (clean && !seen.has(clean)) {
        seen.add(clean)
        out.push(clean)
      }
    }
  }
  return out
}

/**
 * 过滤自动挂载的规划文档列表：
 * 在 `isBootstrap === true` 且未显式传 `--spec`/`--todo` 时，阻断自动挂载 `docs/specs/` 与 `docs/todo/`
 * （仅允许自动挂载 `docs/prd/`），根治 1:N 规划引导 PR 误挂子切片 SPEC/Todo（PR #215）。
 */
export function filterBootstrapAutoAttachDocs(docs = [], {
  isBootstrap = false,
  hasPrd = false,
  explicitPrd = null,
  explicitSpec = null,
  explicitTodo = null,
} = {}) {
  const normalized = []
  const seen = new Set()
  for (const raw of Array.isArray(docs) ? docs : []) {
    const p = posixPath(String(raw ?? '').trim()).replace(/^\.\//, '')
    if (p && PLAN_DOC_PATH_RE.test(p) && !seen.has(p)) {
      seen.add(p)
      normalized.push(p)
    }
  }
  const effectiveHasPrd = Boolean(hasPrd || explicitPrd || normalized.some((p) => p.startsWith('docs/prd/')))
  const allowSpec = !isBootstrap || !effectiveHasPrd || Boolean(explicitSpec)
  const allowTodo = !isBootstrap || !effectiveHasPrd || Boolean(explicitTodo)
  return normalized.filter((p) => {
    if (p.startsWith('docs/specs/') && !allowSpec) return false
    if (p.startsWith('docs/todo/') && !allowTodo) return false
    return true
  })
}

/** 供 `flow-inspect.mjs` 两处自动挂载位共用的受控文档解析入口（统一经 `filterBootstrapAutoAttachDocs` 拦截）。 */
export function resolveBootstrapStartDocs({
  root,
  slug,
  taskId,
  linkedIssues = [],
  extraDocs = [],
  current = {},
  explicit = {},
  isBootstrap = false,
  findStrict = null,
} = {}) {
  const strictCandidates = []
  if (typeof findStrict === 'function' && root) {
    strictCandidates.push(
      findStrict(root, 'docs/prd', slug, taskId, linkedIssues),
      findStrict(root, 'docs/specs', slug, taskId, linkedIssues),
      findStrict(root, 'docs/todo', slug, taskId, linkedIssues),
    )
  }
  const filtered = filterBootstrapAutoAttachDocs(
    [...strictCandidates.filter(Boolean), ...(Array.isArray(extraDocs) ? extraDocs : [])],
    {
      isBootstrap,
      hasPrd: Boolean(explicit.prd || current.prdFile),
      explicitPrd: explicit.prd,
      explicitSpec: explicit.spec,
      explicitTodo: explicit.todo,
    },
  )
  return {
    prdFile: explicit.prd ?? current.prdFile ?? filtered.find((f) => f.startsWith('docs/prd/')) ?? null,
    specFile: explicit.spec ?? current.specFile ?? filtered.find((f) => f.startsWith('docs/specs/')) ?? null,
    todoFile: explicit.todo ?? current.todoFile ?? filtered.find((f) => f.startsWith('docs/todo/')) ?? null,
  }
}

function sameMasterPath(a, b) {
  if (!a || !b) return false
  const na = posixPath(a)
  const nb = posixPath(b)
  return na === nb || basename(na) === basename(nb)
}

/**
 * 汇总 1:N 总控 PRD 的验收标准完成态：
 * - 默认 `includeSelf = false`（非终态 `plan-backfill`/`approve`/`critique-*`）：仅聚合已归档/已实现兄弟切片，
 *   绝不把当前尚未完成的 `isSelf` 切片 `C*` 误判为已完成（根治 Issue #219）。
 * - 终态合并收尾（`flow-merge.mjs`）显式传 `includeSelf: true`：把当前正在合并的切片并入终态完成集。
 */
export function collectMasterIssueCriteriaState({
  mainRoot,
  implRoot = null,
  masterPrdRel,
  ledger = {},
  taskId = null,
  includeSelf = false,
} = {}) {
  if (!masterPrdRel) return []
  const masterNorm = posixPath(masterPrdRel)
  const implMasterAbs = implRoot ? resolve(implRoot, masterPrdRel) : null
  const mainMasterAbs = mainRoot ? resolve(mainRoot, masterPrdRel) : null
  const masterRaw = (implMasterAbs && existsSync(implMasterAbs) ? readTextSafe(implMasterAbs) : null)
    ?? (mainMasterAbs && existsSync(mainMasterAbs) ? readTextSafe(mainMasterAbs) : null)
    ?? ''
  const masterCriteria = extractCriteria(masterRaw)
  if (masterCriteria.length === 0) return []

  const graph = mainRoot ? buildSliceGraph(mainRoot) : { slices: [] }
  let implGraph = null
  const implSliceState = new Map()
  if (implRoot && existsSync(implRoot)) {
    try {
      implGraph = buildSliceGraph(implRoot)
      for (const s of implGraph.slices ?? []) {
        if (s.kind === 'spec' && s.key) implSliceState.set(s.key, s)
      }
    } catch { /* ignore unreadable implRoot slice graph */ }
  }

  const ledgerSpecNorm = ledger?.specFile
    ? posixPath(ledger.specFile)
    : (ledger?.archivedSpecFile ? posixPath(ledger.archivedSpecFile) : null)
  const completedIds = new Set()
  const seenKeys = new Set()
  const allSlices = [...(graph.slices ?? []), ...(implGraph?.slices ?? [])]

  for (const sib of allSlices) {
    if (!sib.masterRel || !sameMasterPath(sib.masterRel, masterNorm)) continue
    const dedupKey = `${sib.kind}:${sib.key || posixPath(sib.rel)}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const implOverlay = (sib.kind === 'spec' && sib.key) ? implSliceState.get(sib.key) : null
    const effective = implOverlay ?? sib
    const st = String(effective?.status ?? sib.status ?? '').toLowerCase()
    const isSelf = (taskId && (sib.key === taskId || effective?.key === taskId))
      || (ledgerSpecNorm && (posixPath(sib.rel) === ledgerSpecNorm || basename(posixPath(sib.rel)) === basename(ledgerSpecNorm)))
    const isActuallyTerminal = Boolean(
      sib.done || sib.archived || implOverlay?.done || implOverlay?.archived || TERMINAL_SLICE_STATUSES.has(st),
    )
    const isTerminal = isActuallyTerminal || (includeSelf === true && isSelf)
    if (!isTerminal) continue

    const text = effective?.text ?? sib.text ?? ''
    if (sib.kind === 'spec') {
      for (const cid of extractClaimedCriteria(text)) {
        completedIds.add(String(cid).toUpperCase())
      }
    } else if (sib.kind === 'todo') {
      for (const item of extractCriteria(text)) {
        if (item.checked || (includeSelf === true && isSelf)) {
          completedIds.add(String(item.id).toUpperCase())
        }
      }
    }
  }

  if (includeSelf === true) {
    for (const rel of [ledger?.archivedSpecFile, ledger?.specFile, ledger?.archivedTodoFile, ledger?.todoFile].filter(Boolean)) {
      const abs = (implRoot && existsSync(resolve(implRoot, rel)))
        ? resolve(implRoot, rel)
        : (mainRoot ? resolve(mainRoot, rel) : null)
      const raw = abs && existsSync(abs) ? readTextSafe(abs) : null
      if (!raw) continue
      for (const cid of extractClaimedCriteria(raw)) completedIds.add(String(cid).toUpperCase())
    }
  }

  return masterCriteria.map((c) => {
    const id = String(c.id).toUpperCase()
    return { ...c, id, checked: Boolean(c.checked || completedIds.has(id)) }
  })
}

function sanitizeCell(raw, maxLen = 120) {
  const clean = String(raw ?? '').replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`
}

/** 单源渲染验收清单进度表（供 PR 变更摘要与 Issue `pf:plan-summary` 共用，保持字段口径一致）。 */
export function renderCriteriaProgressTable(critList = []) {
  const list = (Array.isArray(critList) ? critList : [])
    .map((c) => ({
      id: String(c?.id ?? '').trim().toUpperCase(),
      checked: Boolean(c?.checked),
      text: String(c?.text ?? '').trim(),
    }))
    .filter((c) => c.id)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  if (list.length === 0) {
    return { doneCount: 0, total: 0, summaryLine: '未定义 C1..Cn', tableLines: [], block: '' }
  }
  const doneCount = list.filter((c) => c.checked).length
  const summaryLine = `${doneCount}/${list.length} 已完成（${list.map((c) => `${c.checked ? '[x]' : '[ ]'} ${c.id}`).join('、')}）`
  const tableLines = [
    '| 条款 | 状态 | 说明 |',
    '| --- | --- | --- |',
    ...list.map((c) => `| \`${c.id}\` | ${c.checked ? '[x]' : '[ ]'} | ${sanitizeCell(c.text || '-')} |`),
  ]
  return { doneCount, total: list.length, summaryLine, tableLines, block: tableLines.join('\n') }
}
