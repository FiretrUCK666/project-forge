/**
 * plan-sync.mjs —— 规划阶段关键节点远端/本地同步桥（`doc-plan` -> `TaskBackend`）。
 *
 * 幂等键落盘防重；无 API 能力（`local-only`/`generic-git`）
 * 写入本地事件日志并显式返回 `status: 'NOT_APPLICABLE'`，绝不伪造 `synced: true`。
 */

import path from 'node:path'
import { extractCriteria } from './criteria-lock.mjs'
import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { gitRun, readJsonSafe, readTextSafe, sha256Text, writeJsonAtomic } from './git.mjs'
import { readGitConfigFast, resolveGitDirFast } from './git-fast.mjs'
import { listTaskLedgers, readTaskLedger, sanitizeTaskId, updateTaskLedger } from './ledger.mjs'
import { getLocalIssue } from './local-issues.mjs'
import {
  detectDeclaredRepo, githubRepoFull, parseRemoteUrls, probeForWrite, resolveRemoteDescriptor,
} from './platform.mjs'
import { createTaskBackend } from './task-backend.mjs'

export const PLAN_SUMMARY_START = '<!-- pf:plan-summary:start -->'
export const PLAN_SUMMARY_END = '<!-- pf:plan-summary:end -->'

export const PLAN_SYNC_PHASES = Object.freeze({
  init: Object.freeze({ label: 'planning', title: '规划启动' }),
  clarify: Object.freeze({ label: 'planning', title: '规划澄清补充' }),
  'critique-reject': Object.freeze({ label: 'changes-requested', title: '内审退回修改' }),
  'stop-loss': Object.freeze({ label: 'needs-human-decision', title: '内审触发停损，待人类裁决' }),
  'critique-continue': Object.freeze({ label: 'planning', title: '停损后继续规划复核' }),
  'critique-override': Object.freeze({ label: 'planning', title: '人类裁决解锁规划批准' }),
  'critique-pass': Object.freeze({ label: 'planning', title: '内审通过，待批准' }),
  approve: Object.freeze({ label: 'approved', title: '规划已批准' }),
  supersede: Object.freeze({ label: 'planning', title: '规划规范取代' }),
  'plan-backfill': Object.freeze({ label: 'planning', title: '规划摘要补录' }),
})

const CONTENT_KEYED_PHASES = new Set(['clarify', 'critique-continue', 'critique-override', 'supersede', 'plan-backfill'])

const ALL_PLAN_LABELS = Object.freeze([
  'planning', 'changes-requested', 'needs-human-decision', 'approved',
])

const CRITERIA_SECTION_HEADING_RE = /^(?:验收标准|验收条件|验收清单|验收条目|(?:acceptance\s+criteria|checklist|definition\s+of\s+done)\b)/i
const NUMBERED_CRITERIA_LINE_RE = /^(\s*[-*]\s*)\[([ xX])\](\s+(?:\*\*)?(C\d+)(?:\*\*)?(?:\s*[:：]|\s|$).*)$/i
const UNNUMBERED_CRITERIA_LINE_RE = /^(\s*[-*]\s*)\[ \](.+)$/

/** 确定性同步 Issue 正文中 `C<N>` 勾选框及（完成态时）验收章节内未编号勾选框，绝不触碰代码块与托管摘要区。 */
export function syncIssueCriteriaCheckboxes(existingBody = '', { criteria = [], markAllCriteriaDone = false } = {}) {
  const criteriaMap = new Map()
  for (const item of Array.isArray(criteria) ? criteria : []) {
    const id = String(item?.id ?? '').trim().toUpperCase()
    if (id) criteriaMap.set(id, Boolean(item.checked))
  }

  const lines = String(existingBody ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  const checkedIds = []
  const uncheckedIds = []
  let changed = false
  let inFence = false
  let inSummary = false
  let inCriteriaSection = false

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line.includes(PLAN_SUMMARY_START)) {
      if (!line.includes(PLAN_SUMMARY_END)) inSummary = true
      out.push(line)
      continue
    }
    if (inSummary) {
      if (line.includes(PLAN_SUMMARY_END)) inSummary = false
      out.push(line)
      continue
    }

    const headingMatch = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (headingMatch) {
      inCriteriaSection = CRITERIA_SECTION_HEADING_RE.test(headingMatch[1].trim())
      out.push(line)
      continue
    }

    const numMatch = NUMBERED_CRITERIA_LINE_RE.exec(line)
    if (numMatch) {
      const id = numMatch[4].toUpperCase()
      const curChecked = numMatch[2].toLowerCase() === 'x'
      let nextChecked = curChecked
      if (criteriaMap.has(id)) nextChecked = criteriaMap.get(id)
      else if (markAllCriteriaDone === true) nextChecked = true

      if (nextChecked !== curChecked) {
        out.push(`${numMatch[1]}[${nextChecked ? 'x' : ' '}]${numMatch[3]}`)
        changed = true
        if (nextChecked) checkedIds.push(id)
        else uncheckedIds.push(id)
      } else {
        out.push(line)
      }
      continue
    }

    if (inCriteriaSection && markAllCriteriaDone === true) {
      const plainMatch = UNNUMBERED_CRITERIA_LINE_RE.exec(line)
      if (plainMatch) {
        out.push(`${plainMatch[1]}[x]${plainMatch[2]}`)
        changed = true
        continue
      }
    }

    out.push(line)
  }

  return { body: out.join('\n'), changed, checkedIds, uncheckedIds }
}

const BODY_CRITERIA_LINE_RE = /^[-*]\s+\[([ xX])\]\s+(?:(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]\s*)?(.+)$/i
const STRICT_NUMBERED_CRITERIA_LINE_RE = /^[-*]\s+\[([ xX])\]\s+(?:\*\*)?(C\d+)(?:\*\*)?\s*[:：]\s*(.+)$/i

/** 从任意工单/规划文档正文中无损提取验收条款（跳过围栏代码块，兼容全角 `C1：` 与未编号复选框）。 */
export function extractCriteriaFromBodyText(txt, sourceLabel, { seen = new Set(), allowUnnumbered = true } = {}) {
  const extracted = []
  if (!txt) return extracted
  let inFence = false
  let nextAuto = 1
  const pattern = allowUnnumbered ? BODY_CRITERIA_LINE_RE : STRICT_NUMBERED_CRITERIA_LINE_RE
  for (const rawLine of String(txt).replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = pattern.exec(rawLine.trim())
    if (!m) continue
    let id = m[2] ? m[2].toUpperCase() : null
    if (!id) {
      while (seen.has(`C${nextAuto}`)) nextAuto += 1
      id = `C${nextAuto}`
      nextAuto += 1
    }
    if (seen.has(id)) continue
    seen.add(id)
    extracted.push({ id, checked: m[1].toLowerCase() === 'x', text: m[3].trim(), source: sourceLabel })
  }
  return extracted
}

/** Case 2 或无本地规划文档时，依次从 `issueContext`、`prContext` 与同步本地工单 `getLocalIssue` 回退提取验收条款。 */
export function appendFallbackCriteriaFromTask(criteria, seen, { mainRoot = null, task = null, gitDir = null } = {}) {
  const pushFrom = (txt, label) => {
    for (const item of extractCriteriaFromBodyText(txt, label, { seen, allowUnnumbered: true })) {
      criteria.push(item)
    }
  }
  for (const iss of Array.isArray(task?.issueContext) ? task.issueContext : []) {
    pushFrom(iss?.body || iss?.summary || '', iss?.number ? `issue#${iss.number}` : 'issue')
  }
  if (task?.prContext && typeof task.prContext === 'object') {
    const prNum = task.prNumber ?? task.prContext.number ?? null
    pushFrom(task.prContext.body || task.prContext.summary || '', prNum ? `pr#${prNum}` : 'pr')
  }
  if (criteria.length === 0 && mainRoot && Array.isArray(task?.linkedIssues)) {
    for (const rawNum of task.linkedIssues) {
      const num = Number(rawNum)
      if (!Number.isInteger(num) || num <= 0) continue
      try {
        const localRes = getLocalIssue({ mainRoot, gitDir: gitDir ?? task?.gitDir ?? null, number: num })
        if (localRes?.ok && localRes.body) pushFrom(localRes.body, `issue#${num}`)
      } catch { /* Fail-Soft: 本地工单损坏或不可读时不阻塞审查 */ }
    }
  }
  return criteria
}

export function resolveDocIssueNumber(repoRoot, file, explicitIssue = null) {
  const explicitNum = Number(explicitIssue)
  if (Number.isInteger(explicitNum) && explicitNum > 0) return explicitNum
  if (!file) return null
  const abs = path.isAbsolute(file) ? file : path.join(repoRoot, file)
  const raw = readTextSafe(abs)
  if (raw) {
    const fm = parseDocFrontmatter(raw)
    const fmNum = Number(fm?.data?.issue)
    if (Number.isInteger(fmNum) && fmNum > 0) return fmNum
  }
  const fnNum = Number(parseDocFilename(file)?.issue)
  return Number.isInteger(fnNum) && fnNum > 0 ? fnNum : null
}

function normalizeIssueList(opts, ledger) {
  const set = new Set()
  for (const n of opts?.issueNumbers ?? []) {
    const num = Number(n)
    if (Number.isInteger(num) && num > 0) set.add(num)
  }
  if (opts?.issueNumber != null) {
    const num = Number(opts.issueNumber)
    if (Number.isInteger(num) && num > 0) set.add(num)
  }
  for (const n of ledger?.linkedIssues ?? []) {
    const num = Number(n)
    if (Number.isInteger(num) && num > 0) set.add(num)
  }
  return [...set]
}

function normalizeSyncFiles(files, relDoc) {
  const list = Array.isArray(files) ? files : (files ? [files] : [])
  const out = []
  for (const raw of [...list, relDoc]) {
    const val = (raw && typeof raw === 'object') ? (raw.file ?? raw.path ?? '') : raw
    const p = String(val ?? '').replaceAll('\\', '/').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** 非破坏合并 Issue 正文末尾的托管规划摘要块，绝对保留标记之外手写正文。 */
export function mergeManagedPlanSummary(existingBody = '', summaryBlock = '') {
  const normExisting = String(existingBody ?? '').replace(/\r\n/g, '\n')
  let inner = String(summaryBlock ?? '').replace(/\r\n/g, '\n').trim()
  if (!inner) return normExisting
  if (inner.startsWith(PLAN_SUMMARY_START) && inner.endsWith(PLAN_SUMMARY_END)) {
    inner = inner.slice(PLAN_SUMMARY_START.length, inner.length - PLAN_SUMMARY_END.length).trim()
  }
  const wrapped = `${PLAN_SUMMARY_START}\n${inner}\n${PLAN_SUMMARY_END}`
  const startIdx = normExisting.indexOf(PLAN_SUMMARY_START)
  const endIdx = startIdx >= 0 ? normExisting.indexOf(PLAN_SUMMARY_END, startIdx + PLAN_SUMMARY_START.length) : -1
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = normExisting.slice(0, startIdx).replace(/\s+$/, '')
    const after = normExisting.slice(endIdx + PLAN_SUMMARY_END.length).replace(/^\s+/, '')
    return [before, wrapped, after].filter(Boolean).join('\n\n')
  }
  const trimmed = normExisting.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${wrapped}` : wrapped
}

export function collectPlanSummaryMeta({
  repoRoot, mainRoot, ledger, files, phase, round, metaLabel, targetIssueNumber = null,
  criteriaOverride = null, onlyFiles = false,
}) {
  const allDocs = []
  const rawInputs = onlyFiles
    ? normalizeSyncFiles(files, '')
    : [...normalizeSyncFiles(files, ''), ledger?.specFile, ledger?.todoFile, ledger?.prdFile]
  for (const extra of rawInputs) {
    const p = String(extra ?? '').replaceAll('\\', '/').trim()
    if (p && !allDocs.includes(p)) allDocs.push(p)
  }

  const readDocWithFm = (rel) => {
    const abs = path.isAbsolute(rel) ? rel : (readTextSafe(path.join(repoRoot, rel)) !== undefined ? path.join(repoRoot, rel) : path.join(mainRoot, rel))
    const raw = readTextSafe(abs)
    if (!raw) return null
    const fm = parseDocFrontmatter(raw)
    const kind = String(fm?.data?.kind ?? '').toUpperCase() || (rel.includes('/specs/') ? 'SPEC' : rel.includes('/todo/') ? 'Todo' : 'PRD')
    return { rel, raw, fm, kind }
  }
  const parsedDocs = allDocs.map(readDocWithFm).filter(Boolean)
  const hasSliceSpec = parsedDocs.some((d) => d.kind === 'SPEC')
  const targetNum = Number(targetIssueNumber)
  const hasTargetNum = Number.isInteger(targetNum) && targetNum > 0
  const sliceDocs = parsedDocs.filter((d) => {
    if (d.kind !== 'PRD') return true
    if (!hasSliceSpec) return true
    const prdIssue = Number(d.fm?.data?.issue)
    const isMaster = d.fm?.data?.multi_spec === true
    if (isMaster) return hasTargetNum && prdIssue === targetNum
    if (hasTargetNum && Number.isInteger(prdIssue) && prdIssue > 0 && prdIssue !== targetNum) return false
    return true
  })
  const orderedDocs = [
    ...sliceDocs.filter((d) => d.kind === 'SPEC'),
    ...sliceDocs.filter((d) => d.kind === 'Todo'),
    ...sliceDocs.filter((d) => d.kind !== 'SPEC' && d.kind !== 'Todo'),
  ]
  const docList = orderedDocs.map((d) => d.rel)

  const statusParts = []
  const critSeen = new Map()
  let critiqueText = ''
  let hasApproved = false
  let hasRejected = false

  for (const { fm, kind, raw } of orderedDocs) {
    const st = fm?.data?.status ? String(fm.data.status).trim() : null
    const approved = fm?.data?.approved === true || st === 'approved'
    if (approved && (kind === 'SPEC' || kind === 'Todo')) hasApproved = true
    if (st) statusParts.push(`${kind}:${st}`)
    const pc = fm?.data?.plan_critique ? String(fm.data.plan_critique).trim() : ''
    if (pc && !critiqueText) critiqueText = pc
    if (/^rejected\b/i.test(pc)) hasRejected = true
    for (const c of extractCriteria(raw)) {
      if (!critSeen.has(c.id)) critSeen.set(c.id, c)
    }
  }

  const isMasterTarget = hasTargetNum && parsedDocs.some((d) => d.kind === 'PRD' && d.fm?.data?.multi_spec === true && Number(d.fm?.data?.issue) === targetNum)
  const fallbackKeys = hasSliceSpec && !isMasterTarget ? [ledger?.specFile, ledger?.todoFile].filter(Boolean) : []
  const scopedEntries = [...new Set([...docList, ...fallbackKeys])]
    .map((rel) => ledger?.planCritique?.[rel])
    .filter((e) => e && Array.isArray(e.rounds))
  const ledgerRounds = (scopedEntries.length > 0 ? scopedEntries : Object.values(ledger?.planCritique ?? {}))
    .flatMap((e) => (Array.isArray(e?.rounds) ? e.rounds : []))
  if (!critiqueText && ledgerRounds.length > 0) {
    const last = ledgerRounds[ledgerRounds.length - 1]
    critiqueText = `${last.verdict ?? 'recorded'} (round=${last.round ?? round})`
  }
  if (!critiqueText) critiqueText = round > 0 ? `Round ${round}` : '未开始'
  const critList = Array.isArray(criteriaOverride)
    ? [...criteriaOverride]
      .map((c) => ({ ...c, id: String(c?.id ?? '').trim().toUpperCase(), checked: Boolean(c?.checked) }))
      .filter((c) => c.id)
      .sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)))
    : [...critSeen.values()].sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)))
  const doneCount = critList.filter((c) => c.checked).length
  const criteriaText = critList.length > 0
    ? `${doneCount}/${critList.length} 已完成（${critList.map((c) => `${c.checked ? '[x]' : '[ ]'} ${c.id}`).join('、')}）`
    : '未定义 C1..Cn'

  const effectiveLabel = (phase === 'plan-backfill' || phase === 'clarify')
    ? (hasApproved ? 'approved' : (hasRejected ? 'changes-requested' : metaLabel))
    : metaLabel
  const docDisplay = docList.length > 0 ? docList.map((f) => `\`${f}\``).join('、') : '`(未指定)`'
  const statusDisplay = statusParts.length > 0 ? statusParts.join(' / ') : effectiveLabel

  const summaryBlock = [
    '### 规划摘要（自动同步）',
    `- **当前状态**：\`${statusDisplay}\`（节点：\`${phase}\`）`,
    `- **文档路径**：${docDisplay}`,
    `- **Critique 轮次**：${critiqueText}`,
    `- **验收进度**：${criteriaText}`,
  ].join('\n')

  return { docList, statusDisplay, critiqueText, criteriaText, effectiveLabel, summaryBlock, critList }
}

function buildPlanSyncKey(taskId, relDoc, phase, round, digest = '') {
  const safeTask = taskId
    ? sanitizeTaskId(taskId)
    : String(relDoc || 'plan').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64)
  const roundNum = Number.isFinite(Number(round)) ? Number(round) : 0
  if (CONTENT_KEYED_PHASES.has(phase)) {
    const fp = sha256Text(String(digest || relDoc || phase)).slice(0, 12)
    return `${safeTask}:${phase}:${roundNum}:${fp}`
  }
  return `${safeTask}:${phase}:${roundNum}`
}

function buildPlanSyncBody({ phase, title, relDoc, files = [], round, summary, actor, sha, reason }) {
  const docList = normalizeSyncFiles(files, relDoc)
  const docDisplay = docList.length > 0 ? docList.map((f) => `\`${f}\``).join('、') : '`(未指定)`'
  const lines = [
    `<!-- pf:plan-sync phase=${phase} round=${round ?? 0} -->`,
    `### [Plan Sync] ${title}`,
    `- 文档：${docDisplay}`,
  ]
  if (round != null) lines.push(`- 轮次：Round ${round}`)
  if (actor) lines.push(`- 执行人：\`${actor}\``)
  if (sha) lines.push(`- 摘要 SHA：\`${sha}\``)
  if (reason) lines.push(`- 说明：${reason}`)
  if (summary) lines.push('', summary)
  return lines.join('\n')
}

async function readFallbackSyncKeys(gitDir) {
  const file = path.join(gitDir, 'project-forge-flow', 'events', 'plan-sync-keys.json')
  const data = await readJsonSafe(file, null)
  return { file, keys: Array.isArray(data?.keys) ? data.keys : [] }
}

async function recordPlanSyncKey(mainRoot, gitDir, taskId, syncKey) {
  if (taskId) {
    const existing = readTaskLedger(mainRoot, taskId)
    if (existing) {
      await updateTaskLedger(mainRoot, taskId, (cur) => {
        const keys = Array.isArray(cur.planSyncKeys) ? [...cur.planSyncKeys] : []
        if (!keys.includes(syncKey)) keys.push(syncKey)
        return { ...cur, planSyncKeys: keys }
      })
      return
    }
  }
  const { file, keys } = await readFallbackSyncKeys(gitDir)
  if (!keys.includes(syncKey)) {
    await writeJsonAtomic(file, { keys: [...keys, syncKey] })
  }
}

async function recordSyncFailuresToLedger(mainRoot, taskId, failures) {
  if (!taskId || !failures.length) return
  const existing = readTaskLedger(mainRoot, taskId)
  if (!existing) return
  await updateTaskLedger(mainRoot, taskId, (cur) => ({
    ...cur,
    syncFailures: [...(Array.isArray(cur.syncFailures) ? cur.syncFailures : []), ...failures],
  }))
}

async function syncLabelsForTarget(backend, { taskId = null, repo, number, targetLabel, isPr = false }) {
  const addRes = await backend.addLabels({ ...(taskId ? { taskId } : {}), repo, number, labels: [targetLabel], isPr })
  const stale = ALL_PLAN_LABELS.filter((l) => l !== targetLabel)
  if (typeof backend?.removeLabel === 'function') {
    for (const label of stale) {
      await Promise.resolve(backend.removeLabel({ ...(taskId ? { taskId } : {}), repo, number, label })).catch(() => ({ ok: false }))
    }
  }
  return addRes
}

export async function syncIssueSummaryBody(backend, {
  repo, number, summaryBlock = null, renamedPaths = [], criteria = [], markAllCriteriaDone = false,
}) {
  const hasCriteria = Array.isArray(criteria) && criteria.length > 0
  if ((!summaryBlock && !hasCriteria && !markAllCriteriaDone)
    || typeof backend?.getIssue !== 'function'
    || typeof backend?.updateIssueBody !== 'function') {
    return null
  }
  const curIss = await Promise.resolve(backend.getIssue({ repo, number })).catch(() => null)
  if (!curIss?.ok) return false
  const curNorm = String(curIss.body ?? '').replace(/\r\n/g, '\n')
  let baseBody = curNorm
  for (const item of Array.isArray(renamedPaths) ? renamedPaths : []) {
    if (item?.from && item?.to && item.from !== item.to) {
      baseBody = baseBody.split(item.from).join(item.to)
    }
  }
  baseBody = syncIssueCriteriaCheckboxes(baseBody, { criteria, markAllCriteriaDone }).body
  const nextBody = summaryBlock ? mergeManagedPlanSummary(baseBody, summaryBlock) : baseBody
  if (nextBody === curNorm) return true
  const upd = await Promise.resolve(backend.updateIssueBody({ repo, number, body: nextBody })).catch(() => null)
  return upd?.ok === true
}

/**
 * 将 `doc-plan` 关键节点（`init`/`clarify`/`critique-*`/`stop-loss`/`approve`/`supersede`/`plan-backfill`）
 * 幂等同步至 `TaskBackend` 对应的远端平台或本地事件日志，并维护 Issue 正文托管规划摘要块。
 */
export async function syncPlanPhaseToBackend(opts = {}) {
  const phase = String(opts.phase ?? '').trim()
  const meta = PLAN_SYNC_PHASES[phase]
  if (!meta) {
    return { ok: false, synced: false, status: 'INVALID_PHASE', notApplicable: false, reason: `未知同步阶段: ${phase}` }
  }

  const repoRoot = path.resolve(opts.repoRoot ?? opts.mainRoot ?? process.cwd())
  const detectedGitDir = opts.gitDir ? path.resolve(opts.gitDir) : resolveGitDirFast(repoRoot)
  const mainRoot = path.resolve(
    opts.mainRoot
      ?? (detectedGitDir && path.basename(detectedGitDir) === '.git' ? path.dirname(detectedGitDir) : repoRoot),
  )
  const gitDir = path.resolve(detectedGitDir ?? path.join(mainRoot, '.git'))
  const relDoc = String(opts.file ?? '').replaceAll('\\', '/')
  const files = normalizeSyncFiles(opts.files, relDoc)
  const round = opts.round ?? 0
  const docTaskId = relDoc
    ? (parseDocFrontmatter(readTextSafe(path.join(repoRoot, relDoc)) ?? readTextSafe(path.join(mainRoot, relDoc)) ?? '')?.data?.task_id ?? null)
    : null
  const matchedLedger = (!opts.taskId && !docTaskId && relDoc)
    ? listTaskLedgers(mainRoot, { includeTerminal: true }).find((l) => [l.specFile, l.todoFile, l.prdFile].includes(relDoc))
    : null
  const resolvedTaskRaw = opts.taskId || docTaskId || matchedLedger?.taskId || null
  const taskId = resolvedTaskRaw ? sanitizeTaskId(resolvedTaskRaw) : null
  const ledger = taskId ? readTaskLedger(mainRoot, taskId) : null
  const issueNums = normalizeIssueList(opts, ledger)
  const prNumber = opts.prNumber ?? ledger?.prNumber ?? null
  const renamedPaths = Array.isArray(opts.renamedPaths) ? opts.renamedPaths : []
  const planMetaFor = (targetIssueNumber = null) => collectPlanSummaryMeta({
    repoRoot, mainRoot, ledger, files, phase, round, metaLabel: meta.label, targetIssueNumber,
  })
  const planMeta = planMetaFor(issueNums[0] ?? null)
  const digest = JSON.stringify({
    relDoc, files: planMeta.docList, renamedPaths, sha: opts.sha ?? '', reason: opts.reason ?? '', summary: opts.summary ?? '',
    ...(phase === 'plan-backfill' ? { issues: issueNums, status: planMeta.statusDisplay, critique: planMeta.critiqueText, criteria: planMeta.criteriaText } : {}),
  })
  const syncKey = buildPlanSyncKey(taskId, relDoc, phase, round, digest)

  const seenInLedger = Array.isArray(ledger?.planSyncKeys) && ledger.planSyncKeys.includes(syncKey)
  const fallbackKeys = seenInLedger ? null : await readFallbackSyncKeys(gitDir)
  if (seenInLedger || fallbackKeys?.keys.includes(syncKey)) {
    return {
      ok: true, synced: false, skipped: true, deduplicated: true,
      status: 'ALREADY_SYNCED', syncKey, phase, round,
    }
  }

  const body = buildPlanSyncBody({
    phase, title: meta.title, relDoc, files, round,
    summary: opts.summary, actor: opts.actor, sha: opts.sha, reason: opts.reason,
  })

  let backend = opts.backend ?? null
  let targetRepo = opts.targetRepo ?? null
  let tier = 'unknown'

  if (!backend) {
    const fastCfg = detectedGitDir ? readGitConfigFast(detectedGitDir) : null
    const remoteText = fastCfg?.remoteText ?? (await gitRun(mainRoot, ['remote', '-v']).catch(() => ({ stdout: '' }))).stdout
    const remoteUrls = parseRemoteUrls(remoteText)
    let declaredRepo = null
    try { declaredRepo = detectDeclaredRepo(mainRoot) } catch { declaredRepo = null }
    const originFull = githubRepoFull(remoteUrls.origin)
    const upstreamFull = githubRepoFull(remoteUrls.upstream)
    const primaryUrl = remoteUrls.upstream ?? remoteUrls.origin ?? declaredRepo
    const providerId = opts.providerId ?? ledger?.providerId
      ?? (primaryUrl ? (resolveRemoteDescriptor(primaryUrl)?.providerId ?? 'generic-git') : 'none')
    const role = opts.role ?? ledger?.role
      ?? ((remoteUrls.origin || remoteUrls.upstream) ? 'maintainer' : 'local-only')
    targetRepo = targetRepo ?? (role === 'contributor-fork'
      ? (upstreamFull ?? declaredRepo ?? originFull)
      : (originFull ?? declaredRepo)) ?? null

    let ghClient = opts._ghClient ?? null
    if (!ghClient && providerId === 'github' && role !== 'local-only' && (issueNums.length > 0 || prNumber != null)) {
      const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: mainRoot, remoteUrls }).catch(() => null))
      ghClient = ghProbe?.client ?? null
      tier = ghClient?.tier ?? ghProbe?.env?.trackB?.tier ?? 'offline'
    } else if (ghClient) {
      tier = ghClient.tier ?? 'direct'
    }

    backend = createTaskBackend({ role, providerId, targetRepo, client: ghClient, mainRoot, gitDir })
  }

  const hasApi = Boolean(backend?.capabilities?.api)
  if (!hasApi) {
    let localEvent = null
    if (issueNums.length > 0) {
      for (const num of issueNums) {
        const metaNum = planMetaFor(num)
        const ev = await Promise.resolve(backend.postComment({
          taskId: taskId ?? undefined,
          repo: targetRepo ?? 'local',
          number: num,
          body,
          statePayload: { phase, round, label: metaNum.effectiveLabel, file: relDoc, files, syncKey },
        })).catch(() => null)
        if (!localEvent && ev?.eventPath) localEvent = ev
        await syncLabelsForTarget(backend, {
          taskId: taskId ?? undefined,
          repo: targetRepo ?? 'local',
          number: num,
          targetLabel: metaNum.effectiveLabel,
          isPr: false,
        }).catch(() => null)
        await syncIssueSummaryBody(backend, {
          repo: targetRepo ?? 'local',
          number: num,
          summaryBlock: metaNum.summaryBlock,
          renamedPaths,
          criteria: metaNum.critList,
          markAllCriteriaDone: false,
        })
      }
    } else if (taskId) {
      localEvent = await Promise.resolve(backend.postComment({
        taskId,
        repo: targetRepo ?? 'local',
        number: 0,
        body,
        statePayload: { phase, round, label: planMeta.effectiveLabel, file: relDoc, files, syncKey },
      })).catch(() => null)
      await syncLabelsForTarget(backend, {
        taskId,
        repo: targetRepo ?? 'local',
        number: 0,
        targetLabel: planMeta.effectiveLabel,
        isPr: false,
      }).catch(() => null)
    }
    await recordPlanSyncKey(mainRoot, gitDir, taskId, syncKey)
    return {
      ok: true, synced: false, status: 'NOT_APPLICABLE', notApplicable: true,
      reason: `backend(${backend?.kind ?? 'local-only'}) 无远端 API 能力，已写入本地事件日志`,
      syncKey, phase, round, label: planMeta.effectiveLabel, eventPath: localEvent?.eventPath ?? null,
    }
  }

  if (tier === 'offline' || tier === 'delegated') {
    const failure = { target: targetRepo ?? 'github', phase, syncKey, error: `tier=${tier}`, at: new Date().toISOString() }
    await recordSyncFailuresToLedger(mainRoot, taskId, [failure])
    return {
      ok: false, synced: false, status: tier === 'delegated' ? 'DELEGATED' : 'OFFLINE', notApplicable: false,
      reason: `GitHub 通道当前为 ${tier}，未执行伪同步`, syncKey, phase, round, syncFailures: [failure],
    }
  }

  if (issueNums.length === 0 && prNumber == null) {
    return {
      ok: true, synced: false, status: 'NOT_APPLICABLE', notApplicable: true,
      reason: '未关联 Issue 或已知 PR 编号，跳过远端同步', syncKey, phase, round, label: planMeta.effectiveLabel,
    }
  }

  const syncFailures = []
  const targets = []

  for (const num of issueNums) {
    try {
      const metaNum = planMetaFor(num)
      const numBody = buildPlanSyncBody({
        phase, title: meta.title, relDoc, files: metaNum.docList, round,
        summary: opts.summary, actor: opts.actor, sha: opts.sha, reason: opts.reason,
      })
      const comment = await backend.postComment({
        repo: targetRepo, number: num, body: numBody, statePayload: { phase, round, files: metaNum.docList, syncKey },
      })
      const labelRes = await syncLabelsForTarget(backend, { repo: targetRepo, number: num, targetLabel: metaNum.effectiveLabel, isPr: false })
      if (comment?.ok === false) throw new Error(comment.reason || comment.error || 'postComment failed')
      const bodyOk = await syncIssueSummaryBody(backend, {
        repo: targetRepo,
        number: num,
        summaryBlock: metaNum.summaryBlock,
        renamedPaths,
        criteria: metaNum.critList,
        markAllCriteriaDone: false,
      })
      targets.push({ kind: 'issue', number: num, commentOk: true, labelOk: labelRes?.ok !== false, ...(bodyOk !== null ? { bodyOk } : {}) })
    } catch (err) {
      syncFailures.push({ kind: 'issue', number: num, phase, syncKey, error: err?.message ?? String(err) })
    }
  }

  if (prNumber != null) {
    try {
      const comment = await backend.postComment({
        repo: targetRepo, number: prNumber, body, statePayload: { phase, round, files, syncKey },
      })
      const labelRes = await syncLabelsForTarget(backend, { repo: targetRepo, number: prNumber, targetLabel: planMeta.effectiveLabel, isPr: true })
      if (comment?.ok === false) throw new Error(comment.reason || comment.error || 'postComment failed')
      targets.push({ kind: 'pr', number: prNumber, commentOk: true, labelOk: labelRes?.ok !== false })
    } catch (err) {
      syncFailures.push({ kind: 'pr', number: prNumber, phase, syncKey, error: err?.message ?? String(err) })
    }
  }

  if (syncFailures.length > 0) {
    await recordSyncFailuresToLedger(mainRoot, taskId, syncFailures)
    return {
      ok: false, synced: false, status: 'SYNC_FAILED', notApplicable: false,
      syncKey, phase, round, label: planMeta.effectiveLabel, targets, syncFailures,
    }
  }

  await recordPlanSyncKey(mainRoot, gitDir, taskId, syncKey)
  return {
    ok: true, synced: true, status: 'SYNCED', notApplicable: false,
    syncKey, phase, round, label: planMeta.effectiveLabel, targets, syncFailures: [],
  }
}
