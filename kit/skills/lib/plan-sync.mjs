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

function collectPlanSummaryMeta({ repoRoot, mainRoot, ledger, files, phase, round, metaLabel }) {
  const docList = normalizeSyncFiles(files, '')
  for (const extra of [ledger?.prdFile, ledger?.specFile, ledger?.todoFile]) {
    const p = String(extra ?? '').replaceAll('\\', '/').trim()
    if (p && !docList.includes(p)) docList.push(p)
  }
  const statusParts = []
  const critSeen = new Map()
  let critiqueText = ''
  let hasApproved = false
  let hasRejected = false

  for (const rel of docList) {
    const abs = path.isAbsolute(rel) ? rel : (readTextSafe(path.join(repoRoot, rel)) !== undefined ? path.join(repoRoot, rel) : path.join(mainRoot, rel))
    const raw = readTextSafe(abs)
    if (!raw) continue
    const fm = parseDocFrontmatter(raw)
    const kind = String(fm?.data?.kind ?? '').toUpperCase() || (rel.includes('/specs/') ? 'SPEC' : rel.includes('/todo/') ? 'Todo' : 'PRD')
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

  const ledgerRounds = Object.values(ledger?.planCritique ?? {}).flatMap((e) => (Array.isArray(e?.rounds) ? e.rounds : []))
  if (!critiqueText && ledgerRounds.length > 0) {
    const last = ledgerRounds[ledgerRounds.length - 1]
    critiqueText = `${last.verdict ?? 'recorded'} (round=${last.round ?? round})`
  }
  if (!critiqueText) critiqueText = round > 0 ? `Round ${round}` : '未开始'
  const critList = [...critSeen.values()]
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

  return { docList, statusDisplay, critiqueText, criteriaText, effectiveLabel, summaryBlock }
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

async function syncLabelsForTarget(backend, { repo, number, targetLabel, isPr = false }) {
  const addRes = await backend.addLabels({ repo, number, labels: [targetLabel], isPr })
  const stale = ALL_PLAN_LABELS.filter((l) => l !== targetLabel)
  for (const label of stale) {
    await Promise.resolve(backend.removeLabel({ repo, number, label })).catch(() => ({ ok: false }))
  }
  return addRes
}

async function syncIssueSummaryBody(backend, { repo, number, summaryBlock }) {
  if (!summaryBlock || typeof backend?.getIssue !== 'function' || typeof backend?.updateIssueBody !== 'function') {
    return null
  }
  const curIss = await Promise.resolve(backend.getIssue({ repo, number })).catch(() => null)
  if (!curIss?.ok) return false
  const nextBody = mergeManagedPlanSummary(curIss.body ?? '', summaryBlock)
  const curNorm = String(curIss.body ?? '').replace(/\r\n/g, '\n')
  if (nextBody === curNorm) return true
  const upd = await Promise.resolve(backend.updateIssueBody({ repo, number, body: nextBody })).catch(() => null)
  return upd?.ok !== false
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
  const planMeta = collectPlanSummaryMeta({
    repoRoot, mainRoot, ledger, files, phase, round, metaLabel: meta.label,
  })
  const digest = JSON.stringify({
    relDoc, files: planMeta.docList, sha: opts.sha ?? '', reason: opts.reason ?? '', summary: opts.summary ?? '',
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
    if (taskId || issueNums[0] != null) {
      localEvent = await Promise.resolve(backend.postComment({
        taskId: taskId ?? undefined,
        repo: targetRepo ?? 'local',
        number: issueNums[0] ?? 0,
        body,
        statePayload: { phase, round, label: planMeta.effectiveLabel, file: relDoc, files, syncKey },
      })).catch(() => null)
      await Promise.resolve(backend.addLabels({
        taskId: taskId ?? undefined, repo: targetRepo ?? 'local', number: issueNums[0] ?? 0, labels: [planMeta.effectiveLabel],
      })).catch(() => null)
      for (const num of issueNums) {
        await syncIssueSummaryBody(backend, { repo: targetRepo ?? 'local', number: num, summaryBlock: planMeta.summaryBlock })
      }
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
      const comment = await backend.postComment({
        repo: targetRepo, number: num, body, statePayload: { phase, round, files, syncKey },
      })
      const labelRes = await syncLabelsForTarget(backend, { repo: targetRepo, number: num, targetLabel: planMeta.effectiveLabel, isPr: false })
      if (comment?.ok === false) throw new Error(comment.reason || comment.error || 'postComment failed')
      const bodyOk = await syncIssueSummaryBody(backend, { repo: targetRepo, number: num, summaryBlock: planMeta.summaryBlock })
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
