/**
 * flow-merge.mjs —— merge（前置门禁共享校验/堆叠/依赖/CI/止损/generic-git）、claim 与 release。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 与 flow-batch.mjs 调度。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseFlowInputs, parseIssueNumbers, parsePfStateTags, parsePrNumber,
  parseRemotesTopology, parseRemoteUrls, probeGitHubEnv, resolveContributorIdentity,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { classifyDoorType, detectGateWeakening, matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { checkStackedParentMerged, checkUnresolvedDependencies } from '../../lib/task-graph.mjs'
import {
  determineWorkflowPolicy, hasRepoCiWorkflow, readVerificationEvidence,
  validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildCleanupChecklist, handleAbort, handleCleanup, handleStatus, printCleanupChecklistText } from './flow-cleanup.mjs'
import { buildTargetRepoContext, EXIT_ACTION_REQUIRED, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import { runTrialMerge } from './flow-trial-merge.mjs'

export { handleAbort, handleCleanup, handleStatus }

/**
 * 统一合并前置门禁校验（被 flow-merge 与 flow-batch FIFO 合并队列共同复用）。
 */
export async function assertPreMergeGates({
  mainRoot, gitDir, taskId, ledger, opts = {}, profile: preProfile = null, backend = null, targetRepo = null,
} = {}) {
  if (ledger.role === 'contributor-fork') {
    process.stderr.write('BLOCKED_FORK_CANNOT_MERGE: contributor-fork 无权合并上游仓库 PR，请等待上游维护者合并。\n')
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_FORK_CANNOT_MERGE' }
  }
  if (ledger.role === 'clone-readonly' || ledger.role === 'undetermined') {
    process.stderr.write(`BLOCKED_ROLE_CANNOT_MERGE: 当前身份为 ${ledger.role}，不允许执行合并。\n`)
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_ROLE_CANNOT_MERGE' }
  }
  if (ledger.role === 'generic-git' && !opts['remote-merged'] && !opts['human-approved']) {
    const msg = 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED: generic-git 有远端仓必须先在远端托管平台完成 MR/PR 合并，确认后再带 --remote-merged（或 --human-approved）执行 merge。'
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED', role: ledger.role }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED' }
  }

  const implRoot = ledger.worktreePath ? resolve(mainRoot, ledger.worktreePath) : mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const fastHeadOid = readHeadFast(resolveGitDirFast(implRoot), gitDir)?.oid ?? null
  const [stZ, headRes, diffNsRes] = await Promise.all([
    gitStatusPorcelainZ(implRoot),
    fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
    ledger.baseSha ? gitDiffNameStatusZ(implRoot, [`${ledger.baseSha}..HEAD`]) : Promise.resolve(null),
  ])
  const op = await detectInProgressGitOp(implRoot, { statusEntries: stZ.entries })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 实施工作区存在未提交改动，请先提交并验证后再执行 merge。\n')
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_DIRTY_WORKTREE' }
  }

  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (!ledger.verifiedHead || (currentHead && ledger.verifiedHead !== currentHead) || ledger.lastVerifyExitCode !== 0) {
    process.stderr.write('BLOCKED_NOT_VERIFIED: 合并前必须有匹配当前 HEAD 的实证通过记录。\n')
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_NOT_VERIFIED' }
  }

  const stackGate = await checkStackedParentMerged(mainRoot, ledger, { backend, targetRepo, defaultBranch: ledger.stackTargetBase || 'main' })
  if (stackGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(stackGate, null, 2)}\n`)
    process.stderr.write(`${stackGate.message}\n`)
    return { ok: false, exitCode: stackGate.exitCode ?? EXIT_POLICY_BLOCK, code: stackGate.code }
  }

  if (Array.isArray(ledger.unresolvedBlockers) && ledger.unresolvedBlockers.length > 0) {
    const depGate = checkUnresolvedDependencies({ unresolvedBlockers: ledger.unresolvedBlockers }, { force: Boolean(opts.force) })
    if (depGate.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(depGate, null, 2)}\n`)
      process.stderr.write(`${depGate.message}\n`)
      return { ok: false, exitCode: depGate.exitCode ?? EXIT_POLICY_BLOCK, code: depGate.code }
    }
  }

  const profile = preProfile ?? parseAgentsProfile(mainRoot)
  const sharedDiffEntries = diffNsRes?.ok ? diffNsRes.entries : undefined
  const [changed, gateFindings] = await Promise.all([
    getChangedFiles(implRoot, ledger.baseSha, { statusEntries: stZ.entries, diffEntries: sharedDiffEntries }),
    detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: sharedDiffEntries }),
  ])
  const ownArchived = [ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean)
  const policy = determineWorkflowPolicy({
    changedFiles: changed, ownArchived, caseType: ledger.caseType,
    highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateFindings, hasRemote: ledger.role !== 'local-only',
    hasCiWorkflow: hasRepoCiWorkflow(implRoot),
    visualFilesChanged: changed.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile,
  })
  const evidence = readVerificationEvidence(gitDir, taskId)
  const evCheck = validateVerificationEvidence({ policy, evidence, headSha: currentHead, profile })
  if (!evCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: evCheck.code, reason: evCheck.reason, policy }, null, 2)}\n`)
    process.stderr.write(`${evCheck.code}: ${evCheck.reason}\n`)
    return { ok: false, exitCode: evCheck.exitCode ?? EXIT_POLICY_BLOCK, code: evCheck.code }
  }

  const highRiskHits = changed.filter((f) => profile.highRisk.some((pat) => matchGlob(f, pat)))
  const rounds = ledger.rounds ?? []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const effectiveReviewer = lastRound?.reviewerId ?? ledger.reviewerId ?? ledger.lastReview?.reviewerId
  if (gateFindings.length > 0 && !opts['human-approved']) {
    const doorInfo = classifyDoorType({ changedFiles: changed, highRisk: profile.highRisk, gateWeakened: true })
    const summary = gateFindings.map((f) => `[${f.type}] ${f.file}: ${f.detail}`).join('; ')
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false, blocked: true, code: 'BLOCKED_GATE_WEAKENING', doorType: doorInfo.doorType, findings: gateFindings,
        nextStep: '请向人类报告上述门禁弱化发现，获准后再附 --human-approved 重试 merge',
      }, null, 2)}\n`)
    } else {
      process.stderr.write(`BLOCKED_GATE_WEAKENING (one-way door): 检测到门禁弱化改动，须人类确认：${summary}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId} --human-approved` }], { repoRoot: mainRoot })
    }
    return { ok: false, exitCode: EXIT_ACTION_REQUIRED, code: 'BLOCKED_GATE_WEAKENING' }
  }

  const stopLossActive = Boolean(ledger.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered)
  const humanApprovedUnlock = Boolean(opts['human-approved'] || ledger.humanApprovedStopLoss)
  if (stopLossActive && !humanApprovedUnlock) {
    process.stderr.write('BLOCKED_STOP_LOSS_ESCALATE: 独立审查已触发停损升级（STOP_LOSS_ESCALATE），须人类裁决后带 --human-approved --reason "..." 放行。\n')
    return { ok: false, exitCode: EXIT_ACTION_REQUIRED, code: 'BLOCKED_STOP_LOSS_ESCALATE' }
  }
  if (stopLossActive && opts['human-approved']) {
    ledger.humanApprovedStopLoss = true
    ledger.humanApprovedReason = opts.reason ?? ledger.humanApprovedReason ?? 'human-approved-stop-loss-override'
  }

  const requiresReview = policy.independentReviewRequired || rounds.length > 0 || Boolean(ledger.lastReview)
  if (requiresReview) {
    if (!effectiveReviewer || effectiveReviewer === ledger.implementerId) {
      process.stderr.write(`BLOCKED_REQUIRES_INDEPENDENT_REVIEW: 触碰高风险路径或需要独立审查（hits=${highRiskHits.join(',') || `case ${ledger.caseType}`}），必须存在 reviewerId !== implementerId 的独立审查 PASS 记录。\n`)
      return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_REQUIRES_INDEPENDENT_REVIEW' }
    }
    if (!stopLossActive) {
      const reviewHeadOk = ledger.reviewPassed === true
        && (!currentHead || ledger.reviewPassedHead === currentHead)
        && (!ledger.lastReview || !currentHead || ledger.lastReview.headSha === currentHead)
        && (!lastRound || !currentHead || lastRound.headSha === currentHead)
      if (!reviewHeadOk) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 独立审查结论未覆盖当前 HEAD（reviewPassed=${ledger.reviewPassed}, reviewPassedHead=${ledger.reviewPassedHead ?? 'null'}, currentHead=${currentHead ?? 'null'}）。\n`)
        return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_REVIEW_NOT_PASSED' }
      }
      if (lastRound && (lastRound.verdict !== 'pass' || (lastRound.blockers ?? []).length > 0)) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 最新一轮审查未通过（verdict=${lastRound.verdict}）。\n`)
        return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_REVIEW_NOT_PASSED' }
      }
    }
  }

  if (profile.mergeAuthority === 'human' && !opts['human-approved']) {
    process.stderr.write('BLOCKED_HUMAN_MERGE_AUTHORITY: 项目「取舍」声明了 merge-authority: human，请经人类确认后附加 --human-approved。\n')
    return { ok: false, exitCode: EXIT_POLICY_BLOCK, code: 'BLOCKED_HUMAN_MERGE_AUTHORITY' }
  }

  return { ok: true, implRoot, currentHead, profile, changed, policy, evidence, effectiveReviewer }
}

export async function handleMerge(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)

  const canUseGhApi = ledger.role === 'maintainer' && ledger.providerId !== 'generic-git' && originFull
  const ghProbe = canUseGhApi ? (opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls }))) : null
  const backend = createTaskBackend({
    role: ledger.role,
    providerId: ledger.providerId,
    targetRepo: originFull,
    client: opts._ghClient ?? ghProbe?.client,
    pushRemote,
    mainRoot: roots.mainRoot,
    gitDir: roots.gitDir,
  })

  const gate = await assertPreMergeGates({
    mainRoot: roots.mainRoot, gitDir: roots.gitDir, taskId, ledger, opts, backend, targetRepo: originFull,
  })
  if (!gate.ok) return { exitCode: gate.exitCode, code: gate.code }

  const { implRoot, currentHead, profile, changed, policy, evidence, effectiveReviewer } = gate
  const baseBranch = ledger.baseBranch || 'main'
  let mergeRes = null

  if (canUseGhApi && ledger.prNumber) {
    if (currentHead) {
      const checks = await backend.getCommitChecks({ repo: originFull, ref: currentHead })
      const ciRequired = hasRepoCiWorkflow(implRoot)
      const ciBlock = (code, msg) => {
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code, head: currentHead, checks }, null, 2)}\n`)
        process.stderr.write(`${msg}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
      if (checks?.ok) {
        if (checks.bucket === 'fail' && !opts['human-approved']) {
          const list = checks.failed.map((c) => `${c.name}[${c.state}]`).join(', ')
          return ciBlock('BLOCKED_CI_FAILED', `BLOCKED_CI_FAILED: 当前 HEAD (${currentHead.slice(0, 7)}) 远端 CI 检查未通过（${list}），禁止带病合并。`)
        }
        if (checks.bucket === 'pending' && !opts['human-approved']) {
          const list = checks.pending.map((c) => `${c.name}[${c.state}]`).join(', ')
          return ciBlock('BLOCKED_CI_PENDING', `BLOCKED_CI_PENDING: 当前 HEAD (${currentHead.slice(0, 7)}) 远端 CI 仍在运行或排队（${list}），请等待全部变绿后再执行 merge。`)
        }
        if (checks.bucket === 'none' && ciRequired && !opts['human-approved']) {
          return ciBlock('BLOCKED_CI_PENDING', `BLOCKED_CI_PENDING: 仓库存在检查工作流，但当前 HEAD (${currentHead.slice(0, 7)}) 远端尚未注册 check-run，请等待检查变绿后再执行 merge。`)
        }
      } else if (checks && !checks.skipped && ciRequired && !opts['human-approved']) {
        return ciBlock('BLOCKED_CI_UNVERIFIED', `BLOCKED_CI_UNVERIFIED: 无法核验当前 HEAD (${currentHead.slice(0, 7)}) 远端 CI 状态（${checks.error ?? 'unknown'}），拒绝盲目合并。`)
      }
    }
    mergeRes = await backend.mergePr({ repo: originFull, number: ledger.prNumber, method: opts.method ?? 'merge' })
    if (mergeRes.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, mergeDelegated: mergeRes }, null, 2)}\n`)
      else {
        process.stdout.write(`无直连 GitHub 凭据，已生成合并代理载荷：${JSON.stringify(mergeRes.jsonPayload)}\n`)
        printNextStep(['请在宿主 MCP 完成合并并回读 state=MERGED 后，再向人展示待清理清单。'], { repoRoot: roots.mainRoot })
      }
      return { exitCode: 0 }
    }
    if (!mergeRes.ok || !mergeRes.merged) throw new Error(`PR #${ledger.prNumber} 合并或回读确认 MERGED 失败（state=${mergeRes.state ?? mergeRes.error}）`)
    const mergeContrib = resolveContributorIdentity({ ghLogin: ghProbe?.env?.trackB?.login, ledgerActor: ledger.implementerId })
    await backend.postComment({
      repo: originFull,
      number: ledger.prNumber,
      body: `审查通过并已合并：由独立审查（\`${effectiveReviewer}\`）复核通过（fail: 无），已将 \`${ledger.branch}\` 合入 \`${baseBranch}\`（实施人：${mergeContrib.display}）。`,
      statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer },
    })
    for (const iss of ledger.linkedIssues ?? []) {
      await backend.postComment({ repo: originFull, number: iss, body: `已合并：PR #${ledger.prNumber} 经独立审查通过并合入 \`${baseBranch}\`。`, statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer } })
      await backend.removeLabel({ repo: originFull, number: iss, label: 'in-progress' })
      await backend.removeLabel({ repo: originFull, number: iss, label: 'changes-requested' })
    }
    const mainSt = await gitStatusPorcelainZ(roots.mainRoot)
    if (!opts._ghProbe && mainSt.ok && mainSt.entries.length === 0) {
      await gitRun(roots.mainRoot, ['fetch', pushRemote, baseBranch])
      const curMainBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (curMainBr.ok && curMainBr.stdout.trim() === baseBranch) {
        await gitRun(roots.mainRoot, ['merge', '--ff-only', `${pushRemote}/${baseBranch}`])
      }
    }
  } else if (ledger.branch || ledger.role === 'generic-git') {
    if (ledger.role === 'generic-git') {
      mergeRes = await backend.mergePr({
        remoteMerged: Boolean(opts['remote-merged']),
        humanApproved: Boolean(opts['human-approved']),
        ledger,
        branch: ledger.branch,
        baseBranch,
      })
    } else {
      mergeRes = await backend.mergePr({
        ledger,
        mainRoot: roots.mainRoot,
        baseBranch,
        profile,
        evidence,
        policy,
        changedFiles: changed,
        runVerify: true,
        trialMerger: runTrialMerge,
      })
    }
    if (mergeRes.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, ...mergeRes }, null, 2)}\n`)
      process.stderr.write(`${mergeRes.message}\n`)
      return { exitCode: mergeRes.exitCode ?? EXIT_POLICY_BLOCK }
    }
  }

  ledger.status = 'merged'
  ledger.mergedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  const checklist = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, originFull, pushRemote, {
    skipRemoteProbe: Boolean(opts._ghProbe || opts._ghClient),
    _ghProbe: opts._ghProbe,
    _ghClient: opts._ghClient,
    gitDir: roots.gitDir,
  })
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, status: ledger.status, mergeRes, pendingCleanupChecklist: checklist }, null, 2)}\n`)
  else {
    process.stdout.write(`合并状态已确认（task=${taskId}, status=${ledger.status}）。未自动删除任何分支或 Worktree。\n`)
    printCleanupChecklistText(checklist)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleRelease(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const parsedPos = parseFlowInputs(opts._ ?? [])
  const extraIssues = [
    ...(opts.issue || opts.issues ? parseIssueNumbers([opts.issue, opts.issues], { strict: true }) : []),
    ...parsedPos.issues.map((i) => i.number),
  ]
  if (extraIssues.length > 0) ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extraIssues])]

  const relInit = resolveContributorIdentity({ explicitActor: opts.agent, ledgerActor: ledger.implementerId })
  let actor = relInit.actor
  let actorDisplay = relInit.display
  const reason = String(opts.reason ?? '').trim()
  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  const releaseResults = []
  if (!skipApi) {
    const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const onlineRel = resolveContributorIdentity({
      explicitActor: opts.agent, ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login, ledgerActor: ledger.implementerId,
    })
    actor = onlineRel.actor
    actorDisplay = onlineRel.display
    const rel = await backend.releaseTask({ taskId, issues: ledger.linkedIssues, actor, actorDisplay, branch: ledger.branch, reason })
    releaseResults.push(...(rel.results ?? []))
  } else {
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    await localBackend.releaseTask({ taskId, issues: ledger.linkedIssues, actor, actorDisplay, branch: ledger.branch, reason })
  }

  ledger.status = 'released'
  ledger.releasedAt = new Date().toISOString()
  ledger.releaseReason = reason || null
  ledger.claimedAt = null
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, taskId, role: ledger.role, mode: skipApi ? 'local-ledger-only' : 'remote-synced', status: ledger.status, reason: ledger.releaseReason, releaseResults }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已释放认领（status=released${skipApi ? '，仅本地账本' : `, issues=${ledger.linkedIssues.join(',')}`}）。\n`)
    printNextStep([
      { skill: 'dev-flow', text: `如需由其他人接手：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <agent>` },
      { skill: 'dev-flow', text: `或安全放弃任务与工作区：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

/** 解析 Issue 评论流中的最新有效认领状态（claim/takeover 激活，release 释放）。 */
export function analyzeIssueClaimState(comments = []) {
  let activeClaim = null
  for (const c of Array.isArray(comments) ? comments : []) {
    const states = Array.isArray(c?.pfStates) && c.pfStates.length > 0 ? c.pfStates : (c?.pfState ? [c.pfState] : parsePfStateTags(c?.body ?? ''))
    for (const st of states) {
      const action = String(st?.action ?? '').toLowerCase()
      if (action === 'claim' || action === 'takeover') {
        activeClaim = {
          action, actor: st.agent || st.actor || st.owner || c?.author || null,
          login: c?.author ?? null, taskId: st.taskId ?? null, branch: st.branch ?? null,
          reason: st.reason ?? null, commentId: c?.id ?? null, createdAt: c?.createdAt ?? null,
        }
      } else if (action === 'release') {
        const relActor = st.agent || st.actor || c?.author || null
        if (!activeClaim || !relActor || !activeClaim.actor
          || String(relActor).toLowerCase() === String(activeClaim.actor).toLowerCase()
          || (c?.author && activeClaim.login && c.author.toLowerCase() === activeClaim.login.toLowerCase())
          || (st.taskId && activeClaim.taskId && st.taskId === activeClaim.taskId)) {
          activeClaim = null
        }
      }
    }
  }
  return activeClaim
}

function isSameClaimant(activeClaim, actor, viewerLogin) {
  if (!activeClaim) return true
  const aNorm = String(actor ?? '').trim().toLowerCase()
  const cNorm = String(activeClaim.actor ?? '').trim().toLowerCase()
  if (cNorm && aNorm) return cNorm === aNorm
  if (viewerLogin && activeClaim.login) return String(viewerLogin).trim().toLowerCase() === String(activeClaim.login).trim().toLowerCase()
  return false
}

export async function handleClaim(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const parsedPos = parseFlowInputs(opts._ ?? [])
  const extraIssues = [
    ...(opts.issue || opts.issues ? parseIssueNumbers([opts.issue, opts.issues], { strict: true }) : []),
    ...parsedPos.issues.map((i) => i.number),
  ]
  if (extraIssues.length > 0) ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extraIssues])]
  const claimPr = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : (parsedPos.prs[0]?.number ?? null)
  if (claimPr) ledger.prNumber = claimPr

  const isTakeover = Boolean(opts.takeover)
  const takeoverReason = String(opts.reason ?? '').trim()
  if (isTakeover && !takeoverReason) {
    process.stderr.write('BLOCKED_TAKEOVER_REASON_REQUIRED: --takeover 必须同时传入 --reason "<接管原因>"。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const initContrib = resolveContributorIdentity({ explicitActor: opts.agent, ledgerActor: ledger.implementerId })
  const prevImpl = ledger.implementerId
  let actor = initContrib.actor
  let actorDisplay = initContrib.display
  ledger.implementerId = actor
  const claimRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
    const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
    await syncTaskDocsSafe(claimRoot, ledger)
  }

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  if (skipApi) {
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    await localBackend.claimTask({ taskId, issues: ledger.linkedIssues, prNumber: ledger.prNumber, actor, actorDisplay, branch: ledger.branch, takeover: isTakeover, reason: takeoverReason })
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    if (isTakeover) {
      ledger.takeoverReason = takeoverReason
      ledger.takenOverAt = ledger.claimedAt
    }
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status, takeover: isTakeover }, null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰平台 API）。\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
  const onlineContrib = resolveContributorIdentity({
    explicitActor: opts.agent, ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login, ledgerActor: prevImpl,
  })
  if (onlineContrib.actor !== actor) {
    actor = onlineContrib.actor
    actorDisplay = onlineContrib.display
    ledger.implementerId = actor
    if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
      const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
      await syncTaskDocsSafe(claimRoot, ledger)
    }
  }
  const canQueryComments = Boolean(opts._ghClient) || ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token'
  const activeClaimsByIssue = new Map()
  if (canQueryComments) {
    for (const num of ledger.linkedIssues) {
      const listRes = await backend.listComments({ repo: targetRepo, number: num })
      if (!listRes.ok) continue
      const activeClaim = analyzeIssueClaimState(listRes.comments)
      if (activeClaim && !isSameClaimant(activeClaim, actor, ghProbe.env.trackB.login)) {
        if (!isTakeover) {
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({
              blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, issue: num, activeClaim,
              nextStep: `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --takeover --reason "<接管原因>"`,
            }, null, 2)}\n`)
          }
          process.stderr.write(`BLOCKED_ISSUE_ALREADY_CLAIMED: Issue #${num} 已被 ${activeClaim.actor ?? activeClaim.login ?? '他人'} 认领（分支=${activeClaim.branch ?? '未知'}），且尚无 release/takeover；如需接管请传 --takeover --reason "<接管原因>"。\n`)
          return { exitCode: EXIT_POLICY_BLOCK }
        }
        activeClaimsByIssue.set(num, activeClaim)
      }
    }
  }

  const prevActors = [...activeClaimsByIssue.values()].map((c) => c.actor ?? c.login).filter(Boolean)
  const claimOut = await backend.claimTask({
    taskId,
    issues: ledger.linkedIssues,
    prNumber: ledger.prNumber,
    actor,
    actorDisplay,
    branch: ledger.branch,
    takeover: isTakeover,
    reason: takeoverReason,
    previousActor: prevActors[0] ?? null,
  })
  const claimResults = claimOut.results ?? []
  const prTakeoverResult = claimOut.prResult ?? null

  ledger.status = 'claimed'
  ledger.claimedAt = new Date().toISOString()
  if (isTakeover) {
    ledger.takeoverReason = takeoverReason
    ledger.takenOverAt = ledger.claimedAt
  }
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, targetRepo, takeover: isTakeover, claimResults, ...(prTakeoverResult ? { prTakeoverResult } : {}) }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已${isTakeover ? '接管' : '认领'}（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}
