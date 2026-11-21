/**
 * plan-sync.mjs —— 规划阶段关键节点远端/本地同步桥（`doc-plan` -> `TaskBackend`）。
 *
 * 严格只调用 `createTaskBackend()` 现有方法，不修改 `task-backend.mjs`。
 * 幂等键 `${taskKey}:${phase}:${round}` 落盘防重；无 API 能力（`local-only`/`generic-git`）
 * 写入本地事件日志并显式返回 `status: 'NOT_APPLICABLE'`，绝不伪造 `synced: true`。
 */

import path from 'node:path'
import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { gitRun, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import { readGitConfigFast, resolveGitDirFast } from './git-fast.mjs'
import { readTaskLedger, sanitizeTaskId, updateTaskLedger } from './ledger.mjs'
import {
  detectDeclaredRepo, githubRepoFull, parseRemoteUrls, probeForWrite, resolveRemoteDescriptor,
} from './platform.mjs'
import { createTaskBackend } from './task-backend.mjs'

export const PLAN_SYNC_PHASES = Object.freeze({
  init: Object.freeze({ label: 'planning', title: '规划启动' }),
  'critique-reject': Object.freeze({ label: 'changes-requested', title: '内审退回修改' }),
  'stop-loss': Object.freeze({ label: 'needs-human-decision', title: '内审触发停损，待人类裁决' }),
  'critique-pass': Object.freeze({ label: 'planning', title: '内审通过，待批准' }),
  approve: Object.freeze({ label: 'approved', title: '规划已批准' }),
})

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

function buildPlanSyncKey(taskId, relDoc, phase, round) {
  const safeTask = taskId
    ? sanitizeTaskId(taskId)
    : String(relDoc || 'plan').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64)
  return `${safeTask}:${phase}:${Number.isFinite(Number(round)) ? Number(round) : 0}`
}

function buildPlanSyncBody({ phase, title, relDoc, round, summary, actor, sha, reason }) {
  const lines = [
    `<!-- pf:plan-sync phase=${phase} round=${round ?? 0} -->`,
    `### [Plan Sync] ${title}`,
    `- 文档：\`${relDoc || '(未指定)'}\``,
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

/**
 * 将 `doc-plan` 关键节点（`init`/`critique-reject`/`stop-loss`/`critique-pass`/`approve`）
 * 幂等同步至 `TaskBackend` 对应的远端平台或本地事件日志。
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
  const round = opts.round ?? 0
  const taskId = opts.taskId ? sanitizeTaskId(opts.taskId) : null
  const ledger = taskId ? readTaskLedger(mainRoot, taskId) : null
  const syncKey = buildPlanSyncKey(taskId, relDoc, phase, round)

  const seenInLedger = Array.isArray(ledger?.planSyncKeys) && ledger.planSyncKeys.includes(syncKey)
  const fallbackKeys = seenInLedger ? null : await readFallbackSyncKeys(gitDir)
  if (seenInLedger || fallbackKeys?.keys.includes(syncKey)) {
    return {
      ok: true, synced: false, skipped: true, deduplicated: true,
      status: 'ALREADY_SYNCED', syncKey, phase, round,
    }
  }

  const issueNums = normalizeIssueList(opts, ledger)
  const prNumber = opts.prNumber ?? ledger?.prNumber ?? null
  const body = buildPlanSyncBody({
    phase, title: meta.title, relDoc, round,
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
        statePayload: { phase, round, label: meta.label, file: relDoc, syncKey },
      })).catch(() => null)
      await Promise.resolve(backend.addLabels({
        taskId: taskId ?? undefined, repo: targetRepo ?? 'local', number: issueNums[0] ?? 0, labels: [meta.label],
      })).catch(() => null)
    }
    await recordPlanSyncKey(mainRoot, gitDir, taskId, syncKey)
    return {
      ok: true, synced: false, status: 'NOT_APPLICABLE', notApplicable: true,
      reason: `backend(${backend?.kind ?? 'local-only'}) 无远端 API 能力，已写入本地事件日志`,
      syncKey, phase, round, label: meta.label, eventPath: localEvent?.eventPath ?? null,
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
      reason: '未关联 Issue 或已知 PR 编号，跳过远端同步', syncKey, phase, round, label: meta.label,
    }
  }

  const syncFailures = []
  const targets = []

  for (const num of issueNums) {
    try {
      const comment = await backend.postComment({
        repo: targetRepo, number: num, body, statePayload: { phase, round, syncKey },
      })
      const labelRes = await syncLabelsForTarget(backend, { repo: targetRepo, number: num, targetLabel: meta.label, isPr: false })
      if (comment?.ok === false) throw new Error(comment.reason || comment.error || 'postComment failed')
      targets.push({ kind: 'issue', number: num, commentOk: true, labelOk: labelRes?.ok !== false })
    } catch (err) {
      syncFailures.push({ kind: 'issue', number: num, phase, syncKey, error: err?.message ?? String(err) })
    }
  }

  if (prNumber != null) {
    try {
      const comment = await backend.postComment({
        repo: targetRepo, number: prNumber, body, statePayload: { phase, round, syncKey },
      })
      const labelRes = await syncLabelsForTarget(backend, { repo: targetRepo, number: prNumber, targetLabel: meta.label, isPr: true })
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
      syncKey, phase, round, label: meta.label, targets, syncFailures,
    }
  }

  await recordPlanSyncKey(mainRoot, gitDir, taskId, syncKey)
  return {
    ok: true, synced: true, status: 'SYNCED', notApplicable: false,
    syncKey, phase, round, label: meta.label, targets, syncFailures: [],
  }
}
