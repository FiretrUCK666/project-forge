/**
 * flow-next.mjs —— 单一入口 `flow.mjs next [--task id] [--probe-auth] [--json]` 状态路由与惰性水合。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），保持默认无外网 <= 300ms 预算。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { listTaskLedgers, resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, parsePfStateTags, parseRemoteUrls, probeGitHubEnv } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { detectGateWeakening } from '../../lib/static-gates.mjs'
import {
  determineWorkflowPolicy, evaluateNextState, hasRepoCiWorkflow,
  readVerificationEvidence, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'

async function hydrateRemotePfState({ roots, ledger, opts }) {
  if (!opts['probe-auth']) return { rehydrated: false }
  if (process.env.PF_NO_REAL_AUTH_PROBE === '1' && !opts._ghClient && !opts._ghProbe) {
    return { rehydrated: false, reason: 'PF_NO_REAL_AUTH_PROBE' }
  }
  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)
  if (!targetRepo || ledger.role === 'local-only' || ledger.role === 'generic-git') {
    return { rehydrated: false, reason: 'no-github-target' }
  }

  const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls, probeNetwork: true }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const canApi = Boolean(opts._ghClient || opts._ghProbe) || ghProbe.env?.trackB?.tier === 'gh-cli' || ghProbe.env?.trackB?.tier === 'node-https-token'
  if (!canApi || typeof ghClient?.listComments !== 'function') return { rehydrated: false, reason: 'api-unavailable' }

  const numbers = [
    ...(ledger.prNumber ? [Number(ledger.prNumber)] : []),
    ...(Array.isArray(ledger.linkedIssues) ? ledger.linkedIssues.map(Number) : []),
  ].filter((n, idx, arr) => Number.isInteger(n) && n > 0 && arr.indexOf(n) === idx)

  let changed = false
  if (ledger.prNumber && typeof ghClient.getPr === 'function') {
    const pr = await ghClient.getPr(targetRepo, ledger.prNumber)
    if (pr?.ok && pr.state && pr.state !== ledger.prState) {
      ledger.prState = pr.state
      if (pr.merged && ledger.status !== 'merged' && ledger.status !== 'cleaned') ledger.status = 'merged'
      changed = true
    }
  }

  const remoteRounds = []
  for (const num of numbers) {
    const cRes = await ghClient.listComments({ repo: targetRepo, number: num })
    if (!cRes?.ok || !Array.isArray(cRes.comments)) continue
    for (const c of cRes.comments) {
      const states = Array.isArray(c.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c.body)
      for (const st of states) {
        if (st.taskId && st.taskId !== ledger.taskId) continue
        if ((st.action === 'claim' || st.action === 'takeover') && st.agent && st.agent !== ledger.implementerId) {
          ledger.implementerId = st.agent
          changed = true
        } else if (st.action === 'pr-created' && st.prNumber && !ledger.prNumber) {
          ledger.prNumber = Number(st.prNumber)
          changed = true
        } else if (st.action === 'review' && Number.isInteger(Number(st.round))) {
          remoteRounds.push({
            round: Number(st.round),
            verdict: st.verdict,
            headSha: st.headSha ?? null,
            reviewerId: st.reviewerId ?? null,
            stopLossTriggered: Boolean(st.stopLossTriggered),
          })
        }
      }
    }
  }

  if (remoteRounds.length > 0) {
    const existingByRound = new Map((ledger.rounds ?? []).map((r) => [Number(r.round), r]))
    for (const rr of remoteRounds) {
      if (!existingByRound.has(rr.round)) {
        existingByRound.set(rr.round, { ...rr, mustFix: [], shouldFix: [], rehydratedFromRemote: true })
        changed = true
      }
    }
    const mergedRounds = [...existingByRound.values()].sort((a, b) => a.round - b.round)
    const last = mergedRounds[mergedRounds.length - 1]
    ledger.rounds = mergedRounds
    if (last && (!ledger.lastReview || last.round >= Number(ledger.lastReview.round ?? 0))) {
      ledger.lastReview = {
        round: last.round, verdict: last.verdict, headSha: last.headSha,
        reviewerId: last.reviewerId, stopLossTriggered: Boolean(last.stopLossTriggered),
      }
      ledger.reviewerId = last.reviewerId ?? ledger.reviewerId
      ledger.reviewPassed = last.verdict === 'pass' && !last.stopLossTriggered
      ledger.reviewPassedHead = ledger.reviewPassed ? last.headSha : null
    }
  }

  if (changed) writeTaskLedger(roots.mainRoot, ledger)
  return { rehydrated: true, changed, remoteRoundsCount: remoteRounds.length }
}

/** 唯一路由入口：处理 0 任务 idle、多任务 ambiguous 与单任务全态判定。 */
export async function handleNext(opts, roots) {
  const activeTasks = listTaskLedgers(roots.mainRoot, { includeTerminal: false })
  let selectedTask = null

  if (opts.task && String(opts.task).trim() !== '') {
    const ctx = await resolveTaskContext(roots, opts, { requireExisting: true })
    selectedTask = ctx.ledger
  } else if (activeTasks.length > 0) {
    try {
      const ctx = await resolveTaskContext(roots, opts, { requireExisting: true })
      selectedTask = ctx.ledger
    } catch {
      selectedTask = null
    }
  }

  let hydration = { rehydrated: false }
  let taskRuntime = null
  if (selectedTask) {
    hydration = await hydrateRemotePfState({ roots, ledger: selectedTask, opts })
    const implRoot = selectedTask.worktreePath ? resolve(roots.mainRoot, selectedTask.worktreePath) : roots.mainRoot
    const exists = existsSync(implRoot)
    const profile = parseAgentsProfile(roots.mainRoot)
    const stZ = exists ? await gitStatusPorcelainZ(implRoot) : { ok: true, entries: [] }
    const [op, headRes, changedFiles, gateHits] = exists
      ? await Promise.all([
          detectInProgressGitOp(implRoot, { statusEntries: stZ.entries }),
          gitRun(implRoot, ['rev-parse', 'HEAD']),
          getChangedFiles(implRoot, selectedTask.baseSha, { statusEntries: stZ.entries }),
          detectGateWeakening(implRoot, selectedTask.baseSha, selectedTask.baseBranch),
        ])
      : [{ inProgress: false }, { ok: false, stdout: '' }, [], []]

    const headSha = headRes.ok ? headRes.stdout.trim() : null
    const ownArchived = [selectedTask.archivedTodoFile, selectedTask.archivedSpecFile, selectedTask.archivedPrdFile].filter(Boolean)
    const policy = determineWorkflowPolicy({
      changedFiles,
      ownArchived,
      caseType: selectedTask.caseType,
      highRiskGlobs: profile.highRisk,
      doNotEditGlobs: profile.doNotEdit,
      gateWeakeningHits: gateHits,
      hasRemote: selectedTask.role !== 'local-only',
      hasCiWorkflow: hasRepoCiWorkflow(exists ? implRoot : roots.mainRoot),
      profile,
    })

    const evidence = readVerificationEvidence(roots.gitDir, selectedTask.taskId)
    const evidenceValidation = validateVerificationEvidence({ policy, evidence, headSha, profile })

    let nonDocChangesAfterFinalize = false
    if (selectedTask.finalized && selectedTask.finalizedHead && headSha && selectedTask.finalizedHead !== headSha && exists) {
      const postFin = await gitDiffNameStatusZ(implRoot, [`${selectedTask.finalizedHead}..${headSha}`])
      nonDocChangesAfterFinalize = postFin.entries.some((e) => e.file && !/^docs\//.test(e.file))
    }

    taskRuntime = {
      opInProgress: Boolean(op.inProgress),
      opName: op.op ?? null,
      headSha,
      dirty: stZ.entries.length,
      policy,
      evidenceValidation,
      nonDocChangesAfterFinalize,
    }
  }

  const out = evaluateNextState({ activeTasks, selectedTask, taskRuntime })
  const payload = { ...out, hydration }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`# flow next (${payload.phase} | owner=${payload.ownerRole})\n`)
    if (payload.taskId) process.stdout.write(`- 任务: ${payload.taskId} | risk=${payload.policy?.riskTier ?? '-'} | worktree=${payload.worktreePath ?? 'branch'}\n`)
    process.stdout.write(`- 下一步: ${payload.nextAction}\n`)
    if (payload.blockingReasons.length > 0) process.stdout.write(`- 阻塞原因: ${payload.blockingReasons.join(', ')}\n`)
    if (payload.candidates?.length > 0) {
      for (const c of payload.candidates) process.stdout.write(`  * --task ${c.taskId} (status=${c.status}, branch=${c.branch ?? '-'})\n`)
    }
    printNextStep([{ skill: 'dev-flow', text: payload.command }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0, payload }
}
