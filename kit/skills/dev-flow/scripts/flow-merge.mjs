/**
 * flow-merge.mjs —— merge（前置门禁共享校验/堆叠/依赖/CI/止损/generic-git）、claim 与 release。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 与 flow-batch.mjs 调度。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { hasSkillSupport, printNextStep } from '../../lib/cli.mjs'
import { buildMergeComments, formatAttribution } from '../../lib/docs.mjs'
import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { evaluateRemoteChecks } from '../../lib/gate-truth.mjs'
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { hasExploredEvidence, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseFlowInputs, parseIssueNumbers, parsePfStateTags, parsePrNumber, parseRemotesTopology, parseRemoteUrls, probeGitHubEnv, resolveIdentityLayers, probeForWrite } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { classifyDoorType, detectGateWeakening, gitDiffRawEntriesAndText, matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { checkStackedParentMerged, checkUnresolvedDependencies } from '../../lib/task-graph.mjs'
import {
  determineWorkflowPolicy, hasRepoCiWorkflow, readVerificationEvidence,
  resolveEffectiveBaseSha, validatePreMergeShaAndWorktree, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildCleanupChecklist, handleAbort, handleCleanup, handleStatus, printCleanupChecklistText } from './flow-cleanup.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'
import { runLifecycleGovernHook } from './flow-lifecycle-hooks.mjs'
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
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_FORK_CANNOT_MERGE' }
  }
  if (ledger.role === 'clone-readonly' || ledger.role === 'undetermined') {
    process.stderr.write(`BLOCKED_ROLE_CANNOT_MERGE: 当前身份为 ${ledger.role}，不允许执行合并。\n`)
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_ROLE_CANNOT_MERGE' }
  }
  if (ledger.role === 'generic-git' && !opts['human-approved']) {
    const msg = 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED: generic-git 有远端仓必须先在远端托管平台完成 MR/PR 合并；'
      + 'merge 会现场取回远端，并按四态合流判定核验，核不到就阻断。确需人工拍板时带 --human-approved --reason "<原因>"。'
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED', role: ledger.role }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED' }
  }

  const implRoot = ledger.worktreePath ? resolve(mainRoot, ledger.worktreePath) : mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const fastHeadOid = readHeadFast(resolveGitDirFast(implRoot), gitDir)?.oid ?? null
  const effectiveBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: gitDir })
  const [stZ, headRes, diffNsRes] = await Promise.all([
    gitStatusPorcelainZ(implRoot),
    fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
    !effectiveBase
      ? Promise.resolve(null)
      : (fastHeadOid && fastHeadOid === effectiveBase ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${effectiveBase}..HEAD`)),
  ])
  const op = await detectInProgressGitOp(implRoot, { statusEntries: stZ.entries })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 实施工作区存在未提交改动，请先提交并验证后再执行 merge。\n')
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_DIRTY_WORKTREE' }
  }
  if (ledger.role !== 'inbound-external-pr' && !hasExploredEvidence(ledger)) {
    const msg = `BLOCKED_NOT_EXPLORED: 任务 ${taskId} 缺少只读探索证据（ledger.explored），请先运行 flow.mjs explore --task ${taskId} 记录后再合并。`
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_NOT_EXPLORED', taskId }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { ok: false, exitCode: EXIT.HUMAN, code: 'BLOCKED_NOT_EXPLORED' }
  }

  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (!ledger.verifiedHead || (currentHead && ledger.verifiedHead !== currentHead) || ledger.lastVerifyExitCode !== 0) {
    process.stderr.write('BLOCKED_NOT_VERIFIED: 合并前必须有匹配当前 HEAD 的实证通过记录。\n')
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_NOT_VERIFIED' }
  }

  const stackGate = await checkStackedParentMerged(mainRoot, ledger, { backend, targetRepo, defaultBranch: ledger.stackTargetBase || 'main' })
  if (stackGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(stackGate, null, 2)}\n`)
    process.stderr.write(`${stackGate.message}\n`)
    return { ok: false, exitCode: stackGate.exitCode ?? EXIT.FACT, code: stackGate.code }
  }

  if (Array.isArray(ledger.unresolvedBlockers) && ledger.unresolvedBlockers.length > 0) {
    const depGate = checkUnresolvedDependencies({ unresolvedBlockers: ledger.unresolvedBlockers }, { force: Boolean(opts.force) })
    if (depGate.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(depGate, null, 2)}\n`)
      process.stderr.write(`${depGate.message}\n`)
      return { ok: false, exitCode: depGate.exitCode ?? EXIT.FACT, code: depGate.code }
    }
  }

  const profile = preProfile ?? parseAgentsProfile(mainRoot)
  const sharedDiffEntries = diffNsRes?.ok ? diffNsRes.entries : undefined
  const [changed, gateFindings] = await Promise.all([
    getChangedFiles(implRoot, effectiveBase, { statusEntries: stZ.entries, diffEntries: sharedDiffEntries }),
    detectGateWeakening(implRoot, effectiveBase, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: sharedDiffEntries }),
  ])
  const ownArchived = [ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean)
  const hasDevReview = hasSkillSupport(mainRoot, 'dev-review')
  const policy = determineWorkflowPolicy({
    changedFiles: changed, ownArchived, caseType: ledger.caseType,
    highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateFindings, hasRemote: ledger.role !== 'local-only',
    hasCiWorkflow: hasRepoCiWorkflow(implRoot),
    visualFilesChanged: changed.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile, hasDevReview,
  })
  const evidence = readVerificationEvidence(gitDir, taskId)
  const evCheck = validateVerificationEvidence({ policy, evidence, headSha: currentHead, profile })
  if (!evCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: evCheck.code, reason: evCheck.reason, policy }, null, 2)}\n`)
    process.stderr.write(`${evCheck.code}: ${evCheck.reason}\n`)
    return { ok: false, exitCode: evCheck.exitCode ?? EXIT.FACT, code: evCheck.code }
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
    return { ok: false, exitCode: EXIT.HUMAN, code: 'BLOCKED_GATE_WEAKENING' }
  }

  const stopLossActive = Boolean(ledger.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered)
  const humanApprovedUnlock = Boolean(opts['human-approved'] || ledger.humanApprovedStopLoss)
  if (stopLossActive && !humanApprovedUnlock) {
    process.stderr.write('BLOCKED_STOP_LOSS_ESCALATE: 独立审查已触发停损升级（STOP_LOSS_ESCALATE），须人类裁决后带 --human-approved --reason "..." 放行。\n')
    return { ok: false, exitCode: EXIT.HUMAN, code: 'BLOCKED_STOP_LOSS_ESCALATE' }
  }
  if (stopLossActive && opts['human-approved']) {
    // 解锁停损是放行点里最重的一个：它让「连续两轮同一阻塞项」或「三轮未收口」的结论
    // 直接失效。此前这里在缺省 `--reason` 时自动填一句占位串，等于校验点要求理由、
    // 调用点却自己编一个——校验被绕过，而账本里留下一句谁也没说过的「理由」。
    const reasonCheck = evaluateReleaseReason(opts.reason, { subject: '停损解锁理由' })
    if (!reasonCheck.ok) {
      const msg = `BLOCKED_STOP_LOSS_REASON_REQUIRED: ${reasonCheck.reason} 解锁停损必须写清：为什么这次可以放过、放过的代价是什么。\n`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_STOP_LOSS_REASON_REQUIRED', stopLoss: true, message: msg.trim() }, null, 2)}\n`)
      process.stderr.write(msg)
      return { ok: false, exitCode: EXIT.HUMAN, code: 'BLOCKED_STOP_LOSS_REASON_REQUIRED' }
    }
    ledger.humanApprovedStopLoss = true
    ledger.humanApprovedReason = reasonCheck.cleaned
  }

  if (!hasDevReview && policy.humanApprovalRequired) {
    const hasApprove = Boolean(opts['human-approved'])
    const reasonCheck = evaluateReleaseReason(opts.reason, { subject: '高风险人工确认理由' })
    if (!hasApprove || !reasonCheck.ok) {
      const msg = `BLOCKED_HIGH_RISK_HUMAN_APPROVAL: 未装配 dev-review 且触及高风险/one-way 边界（${policy.reasons.join('；')}），须人类确认并同时附加 --human-approved --reason "<确认原因>"。\n`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_HIGH_RISK_HUMAN_APPROVAL', reasons: policy.reasons, message: msg.trim() }, null, 2)}\n`)
      process.stderr.write(msg)
      return { ok: false, exitCode: EXIT.HUMAN, code: 'BLOCKED_HIGH_RISK_HUMAN_APPROVAL' }
    }
    ledger.humanApprovedReason = reasonCheck.cleaned
  }

  const requiresReview = hasDevReview && (policy.independentReviewRequired || (policy.riskTier !== 'low' && (rounds.length > 0 || Boolean(ledger.lastReview))))
  if (requiresReview) {
    if (!effectiveReviewer || effectiveReviewer === ledger.implementerId) {
      process.stderr.write(`BLOCKED_REQUIRES_INDEPENDENT_REVIEW: 触碰高风险路径或需要独立审查（hits=${highRiskHits.join(',') || `case ${ledger.caseType}`}），必须存在 reviewerId !== implementerId 的独立审查 PASS 记录。\n`)
      return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_REQUIRES_INDEPENDENT_REVIEW' }
    }
    if (!stopLossActive) {
      if (ledger.reviewPassed !== true) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 独立审查未通过（reviewPassed=${ledger.reviewPassed}）。\n`)
        return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_REVIEW_NOT_PASSED' }
      }
      if (lastRound && (lastRound.verdict !== 'pass' || (lastRound.blockers ?? []).length > 0)) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 最新一轮审查未通过（verdict=${lastRound.verdict}）。\n`)
        return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_REVIEW_NOT_PASSED' }
      }
    }
  }

  if (profile.mergeAuthority === 'human' && !opts['human-approved']) {
    process.stderr.write('BLOCKED_HUMAN_MERGE_AUTHORITY: 项目「取舍」声明了 merge-authority: human，请经人类确认后附加 --human-approved。\n')
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_HUMAN_MERGE_AUTHORITY' }
  }

  const shaGate = validatePreMergeShaAndWorktree({
    currentHead,
    evidence,
    ledger,
    lastRound,
    dirtyCount: stZ.entries.length,
    requiresReview,
    stopLossActive,
  })
  if (!shaGate.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: shaGate.code, reason: shaGate.reason }, null, 2)}\n`)
    process.stderr.write(`${shaGate.code}: ${shaGate.reason}\n`)
    return { ok: false, exitCode: EXIT.FACT, code: shaGate.code }
  }

  return { ok: true, implRoot, currentHead, profile, changed, policy, evidence, effectiveReviewer, stopLossActive, gateFindings }
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
  const ghProbe = canUseGhApi ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))) : null
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

  const { implRoot, currentHead, profile, changed, policy, evidence, effectiveReviewer, stopLossActive, gateFindings } = gate
  // 被绕过的项逐条入账：结论行写「人类签字放行」却说不出绕过了什么，等于把放行说成通过。
  const mergeBypassed = [
    stopLossActive ? '独立审查停损（STOP_LOSS_ESCALATE）' : null,
    (gateFindings ?? []).length > 0 ? `门禁弱化检查（${(gateFindings ?? []).map((f) => f.type).join(', ')}）` : null,
  ].filter(Boolean)
  const baseBranch = ledger.baseBranch || 'main'
  let mergeRes = null

  if (canUseGhApi && ledger.prNumber) {
    if (currentHead) {
      const checks = await backend.getCommitChecks({ repo: originFull, ref: currentHead })
      const ciRequired = hasRepoCiWorkflow(implRoot)
      const ciBlock = (code, msg) => {
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code, head: currentHead, checks }, null, 2)}\n`)
        process.stderr.write(`${msg}\n`)
        return { exitCode: EXIT.FACT }
      }
      if (checks?.ok) {
        const verdict = evaluateRemoteChecks(checks, { ciRequired, headSha: currentHead })
        if (verdict.blocking && !opts['human-approved']) return ciBlock(verdict.code, verdict.message)
      } else if (checks && !checks.skipped && ciRequired && !opts['human-approved']) {
        const verdict = evaluateRemoteChecks(checks, { ciRequired, headSha: currentHead })
        return ciBlock(verdict.code ?? 'BLOCKED_CI_UNVERIFIED', verdict.message
          ?? `BLOCKED_CI_UNVERIFIED: 无法核验当前 HEAD (${currentHead.slice(0, 7)}) 远端 CI 状态（${checks.error ?? 'unknown'}），拒绝盲目合并。`)
      }
    }
    try {
      mergeRes = await backend.mergePr({ repo: originFull, number: ledger.prNumber, method: opts.method ?? 'merge', sha: currentHead })
    } catch (err) {
      mergeRes = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!mergeRes?.delegated && (!mergeRes?.ok || !mergeRes?.merged) && typeof backend.getPr === 'function') {
      const readback = await backend.getPr(originFull, ledger.prNumber).catch(() => null)
      if (readback?.ok && readback.merged === true) {
        mergeRes = { ok: true, merged: true, alreadyMerged: true, state: 'MERGED' }
      }
    }
    if (mergeRes.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, mergeDelegated: mergeRes }, null, 2)}\n`)
      else {
        process.stdout.write(`无直连 GitHub 凭据，已生成合并代理载荷：${JSON.stringify(mergeRes.jsonPayload)}\n`)
        printNextStep(['请在宿主 MCP 完成合并并回读 state=MERGED 后，再向人展示待清理清单。'], { repoRoot: roots.mainRoot })
      }
      return { exitCode: EXIT.OK }
    }
    if (!mergeRes.ok || !mergeRes.merged) {
      const detail = mergeRes.headMismatch ? `409 HEAD 漂移(${mergeRes.error ?? ''})`
        : (mergeRes.mergeBlocked ? `405 合并受阻(${mergeRes.error ?? ''})` : (mergeRes.state ?? mergeRes.error))
      throw new Error(`PR #${ledger.prNumber} 合并或回读确认 MERGED 失败（${detail}）`)
    }
    const mergeImplLayers = resolveIdentityLayers({
      ghLogin: ghProbe?.env?.trackB?.login,
      ghTier: ghProbe?.env?.trackB?.tier,
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const implementerDisplay = formatAttribution({ ...mergeImplLayers, capabilities: backend.capabilities })
    const reviewerDisplay = effectiveReviewer
      ? formatAttribution({ agent: effectiveReviewer, capabilities: backend.capabilities })
      : ''
    const mergeCommitSha = mergeRes?.mergeCommit ?? mergeRes?.sha ?? mergeRes?.mergedSha ?? null
    // 被绕过的项逐条入账：结论行写「人类签字放行」却说不出绕过了什么，等于把放行说成通过。
    const mergeBypassed = [
      stopLossActive ? '独立审查停损（STOP_LOSS_ESCALATE）' : null,
      gateFindings.length > 0 ? `门禁弱化检查（${gateFindings.map((f) => f.type).join(', ')}）` : null,
    ].filter(Boolean)
    const { prCommentBody: mergePrBody, issueCommentBody: mergeIssueBody } = buildMergeComments({
      prNumber: ledger.prNumber, branch: ledger.branch, baseBranch, headSha: currentHead, mergeCommit: mergeCommitSha,
      reviewerId: effectiveReviewer, reviewerDisplay, implementerDisplay, linkedIssues: ledger.linkedIssues ?? [],
      humanApprovedReason: ledger.humanApprovedReason ?? null, bypassed: mergeBypassed,
    })
    await backend.postComment({
      repo: originFull,
      number: ledger.prNumber,
      body: mergePrBody,
      statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer ?? null },
    })
    for (const iss of ledger.linkedIssues ?? []) {
      await backend.postComment({ repo: originFull, number: iss, body: mergeIssueBody, statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer ?? null } })
      await backend.removeLabel({ repo: originFull, number: iss, label: 'in-progress' })
      await backend.removeLabel({ repo: originFull, number: iss, label: 'in-review' })
      await backend.removeLabel({ repo: originFull, number: iss, label: 'changes-requested' })
      await backend.closeIssue({ repo: originFull, number: iss })
    }
    const mainSt = await gitStatusPorcelainZ(roots.mainRoot)
    if (!opts._ghProbe && mainSt.ok && mainSt.entries.length === 0) {
      await gitRun(roots.mainRoot, ['fetch', pushRemote, baseBranch])
      const fastMainBr = readHeadFast(resolveGitDirFast(roots.mainRoot), roots.gitDir)?.branch ?? null
      const curMainBr = fastMainBr ? { ok: true, stdout: fastMainBr } : await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (curMainBr.ok && curMainBr.stdout.trim() === baseBranch) {
        await gitRun(roots.mainRoot, ['merge', '--ff-only', '--no-edit', `${pushRemote}/${baseBranch}`])
      }
    }
  } else if (ledger.branch || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || backend?.kind === 'generic-git') {
    if (ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || backend?.kind === 'generic-git') {
      mergeRes = await backend.mergePr({
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
      return { exitCode: mergeRes.exitCode ?? EXIT.FACT, ...(mergeRes.code ? { code: mergeRes.code } : {}) }
    }
    if ((ledger.linkedIssues ?? []).length > 0 && mergeRes?.merged !== false) {
      const mergeImplLayers = resolveIdentityLayers({
        ledgerAccount: ledger.account,
        ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
        ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
      })
      const implementerDisplay = formatAttribution({ ...mergeImplLayers, capabilities: backend.capabilities })
      const reviewerDisplay = effectiveReviewer
        ? formatAttribution({ agent: effectiveReviewer, capabilities: backend.capabilities })
        : ''
      const mergeCommitSha = mergeRes?.mergeCommit ?? mergeRes?.mergedSha ?? mergeRes?.sha ?? null
      const { issueCommentBody: localMergeBody } = buildMergeComments({
        prNumber: ledger.prNumber ?? null, branch: ledger.branch, baseBranch, headSha: currentHead, mergeCommit: mergeCommitSha,
        reviewerId: effectiveReviewer, reviewerDisplay, implementerDisplay, linkedIssues: ledger.linkedIssues ?? [],
        humanApprovedReason: ledger.humanApprovedReason ?? null, bypassed: mergeBypassed,
      })
      for (const iss of ledger.linkedIssues ?? []) {
        await backend.postComment({ taskId, number: iss, body: localMergeBody, statePayload: { taskId, action: 'merged', branch: ledger.branch, reviewerId: effectiveReviewer ?? null } })
        await backend.removeLabel({ taskId, number: iss, label: 'in-progress' })
        await backend.removeLabel({ taskId, number: iss, label: 'in-review' })
        await backend.removeLabel({ taskId, number: iss, label: 'changes-requested' })
        await backend.closeIssue({ number: iss, reason: `merged into ${baseBranch}` })
      }
    }
  }

  ledger.status = 'merged'
  ledger.mergedAt = new Date().toISOString()
  await runLifecycleGovernHook({ stage: 'merge', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  const checklist = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, originFull, pushRemote, {
    skipRemoteProbe: Boolean(opts._ghProbe || opts._ghClient),
    _ghProbe: opts._ghProbe,
    _ghClient: opts._ghClient,
    gitDir: roots.gitDir,
    mergeStateOverride: mergeRes?.trialMerged ? { state: 'merged', ownCommits: 0, isShallow: false, reason: `已合入 ${baseBranch}` } : null,
    knownCleanWorktrees: ledger.worktreePath ? [ledger.worktreePath] : [],
  })
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, status: ledger.status, mergeRes, pendingCleanupChecklist: checklist }, null, 2)}\n`)
  else {
    process.stdout.write(`合并状态已确认（task=${taskId}, status=${ledger.status}）。未自动删除任何分支或 Worktree。\n`)
    printCleanupChecklistText(checklist)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
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

  const reason = String(opts.reason ?? '').trim()
  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  const releaseResults = []
  if (!skipApi) {
    // 认领/释放都要往平台写。写之前必须联网探清通道——
    // 用「不联网」的探测结果判断「能不能写」，必然得到「不能」，而且不报错。
    const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const relLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login,
      ghTier: ghProbe.env?.trackB?.tier ?? ghClient?.tier ?? (ghClient ? 'authenticated' : null),
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const actorDisplay = formatAttribution({ ...relLayers, capabilities: backend.capabilities })
    const rel = await backend.releaseTask({
      taskId, issues: ledger.linkedIssues,
      account: relLayers.account, verifiedPlatformLogin: relLayers.verifiedPlatformLogin, agent: relLayers.agent,
      actor: relLayers.agent || relLayers.account, actorDisplay, branch: ledger.branch, reason,
    })
    releaseResults.push(...(rel.results ?? []))
  } else {
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const relLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const actorDisplay = formatAttribution({ ...relLayers, capabilities: localBackend.capabilities })
    await localBackend.releaseTask({
      taskId, issues: ledger.linkedIssues,
      account: relLayers.account, verifiedPlatformLogin: relLayers.verifiedPlatformLogin, agent: relLayers.agent,
      actor: relLayers.agent || relLayers.account, actorDisplay, branch: ledger.branch, reason,
    })
  }

  ledger.status = 'released'
  ledger.releasedAt = new Date().toISOString()
  ledger.releaseReason = reason || null
  ledger.claimedAt = null
  ledger.claimedBy = null
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, taskId, role: ledger.role, mode: skipApi ? 'local-ledger-only' : 'remote-synced', status: ledger.status, reason: ledger.releaseReason, releaseResults }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已释放认领（status=released${skipApi ? '，仅本地账本' : `, issues=${ledger.linkedIssues.join(',')}`}）。\n`)
    printNextStep([
      { skill: 'dev-flow', text: `如需由其他人接手：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <agent>` },
      { skill: 'dev-flow', text: `或安全放弃任务与工作区：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
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
          account: st.account ?? null,
          verifiedPlatformLogin: Boolean(st.verifiedPlatformLogin),
          agent: st.agent ?? null,
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
    return { exitCode: EXIT.FACT }
  }

  const prevAgent = ledger.agent ?? ledger.claimedBy ?? ledger.implementerId ?? null
  const claimRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  if (skipApi) {
    const gitNameRes = await gitRun(roots.mainRoot, ['config', 'user.name']).catch(() => ({ ok: false, stdout: '' }))
    const localLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      gitName: gitNameRes.ok ? gitNameRes.stdout.trim() : null,
      ledgerAccount: ledger.account,
      ledgerAgent: prevAgent,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    if (localLayers.account) {
      ledger.account = localLayers.account
      ledger.verifiedPlatformLogin = localLayers.verifiedPlatformLogin
    }
    if (localLayers.agent) {
      ledger.agent = localLayers.agent
      ledger.implementerId = localLayers.agent
    } else if (!ledger.implementerId && localLayers.account) {
      ledger.implementerId = localLayers.account
    }
    if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
      const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
      await syncTaskDocsSafe(claimRoot, ledger)
    }
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const actorDisplay = formatAttribution({ ...localLayers, capabilities: localBackend.capabilities })
    const localClaim = await localBackend.claimTask({
      taskId, issues: ledger.linkedIssues, prNumber: ledger.prNumber,
      account: localLayers.account, verifiedPlatformLogin: localLayers.verifiedPlatformLogin, agent: localLayers.agent,
      actor: localLayers.agent || localLayers.account, actorDisplay, branch: ledger.branch,
      takeover: isTakeover, reason: takeoverReason,
    })
    if (localClaim?.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, taskId, ...localClaim }, null, 2)}\n`)
      process.stderr.write(`${localClaim.message}\n`)
      return { exitCode: localClaim.exitCode ?? EXIT.FACT }
    }
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    ledger.claimedBy = String(opts.agent ?? '').trim() || localLayers.agent || localLayers.account || null
    if (isTakeover) {
      ledger.takeoverReason = takeoverReason
      ledger.takenOverAt = ledger.claimedAt
    }
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status, takeover: isTakeover }, null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰平台 API）。\n`)
      const nextCmd = hasExploredEvidence(ledger)
        ? `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`
        : `node ".agents/skills/dev-flow/scripts/flow.mjs" explore --task ${taskId}`
      printNextStep([{ skill: 'dev-flow', text: nextCmd }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  // 认领/释放都要往平台写。写之前必须联网探清通道——
  // 用「不联网」的探测结果判断「能不能写」，必然得到「不能」，而且不报错。
  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
  const onlineLayers = resolveIdentityLayers({
    explicitAgent: opts.agent,
    ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login,
    ghTier: ghProbe.env?.trackB?.tier ?? ghClient?.tier ?? (ghClient ? 'authenticated' : null),
    ledgerAccount: ledger.account,
    ledgerAgent: prevAgent,
    ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
  })
  if (onlineLayers.account) {
    ledger.account = onlineLayers.account
    ledger.verifiedPlatformLogin = onlineLayers.verifiedPlatformLogin
  }
  if (onlineLayers.agent) {
    ledger.agent = onlineLayers.agent
    ledger.implementerId = onlineLayers.agent
  } else if (!ledger.implementerId && onlineLayers.account) {
    ledger.implementerId = onlineLayers.account
  }
  if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
    const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
    await syncTaskDocsSafe(claimRoot, ledger)
  }
  const actorKey = onlineLayers.agent || onlineLayers.account
  const actorDisplay = formatAttribution({ ...onlineLayers, capabilities: backend.capabilities })
  const canQueryComments = Boolean(opts._ghClient) || ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token'
  const activeClaimsByIssue = new Map()
  if (canQueryComments) {
    for (const num of ledger.linkedIssues) {
      const listRes = await backend.listComments({ repo: targetRepo, number: num })
      if (!listRes.ok) continue
      const activeClaim = analyzeIssueClaimState(listRes.comments)
      if (activeClaim && !isSameClaimant(activeClaim, actorKey, ghProbe.env.trackB.login)) {
        if (!isTakeover) {
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({
              blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, issue: num, activeClaim,
              nextStep: `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --takeover --reason "<接管原因>"`,
            }, null, 2)}\n`)
          }
          process.stderr.write(`BLOCKED_ISSUE_ALREADY_CLAIMED: Issue #${num} 已被 ${activeClaim.actor ?? activeClaim.login ?? '他人'} 认领（分支=${activeClaim.branch ?? '未知'}），且尚无 release/takeover；如需接管请传 --takeover --reason "<接管原因>"。\n`)
          return { exitCode: EXIT.FACT }
        }
        activeClaimsByIssue.set(num, activeClaim)
      }
    }
  }

  const prevClaim = [...activeClaimsByIssue.values()][0] ?? null
  const prevActors = [...activeClaimsByIssue.values()].map((c) => c.agent ?? c.actor ?? c.login).filter(Boolean)
  const claimOut = await backend.claimTask({
    taskId,
    issues: ledger.linkedIssues,
    prNumber: ledger.prNumber,
    account: onlineLayers.account,
    verifiedPlatformLogin: onlineLayers.verifiedPlatformLogin,
    agent: onlineLayers.agent,
    actor: actorKey,
    actorDisplay,
    branch: ledger.branch,
    takeover: isTakeover,
    reason: takeoverReason,
    previousActor: prevActors[0] ?? null,
    previousAccount: prevClaim?.account ?? null,
    previousVerifiedPlatformLogin: Boolean(prevClaim?.verifiedPlatformLogin),
    previousAgent: prevClaim?.agent ?? prevActors[0] ?? null,
  })
  const claimResults = claimOut.results ?? []
  const prTakeoverResult = claimOut.prResult ?? null

  ledger.status = 'claimed'
  ledger.claimedAt = new Date().toISOString()
  ledger.claimedBy = String(opts.agent ?? '').trim() || onlineLayers.agent || onlineLayers.account || null
  if (isTakeover) {
    ledger.takeoverReason = takeoverReason
    ledger.takenOverAt = ledger.claimedAt
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, targetRepo, takeover: isTakeover, claimResults, ...(prTakeoverResult ? { prTakeoverResult } : {}) }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已${isTakeover ? '接管' : '认领'}（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    const nextCmd = hasExploredEvidence(ledger)
      ? `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`
      : `node ".agents/skills/dev-flow/scripts/flow.mjs" explore --task ${taskId}`
    printNextStep([{ skill: 'dev-flow', text: nextCmd }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
