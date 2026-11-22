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
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, samePath } from '../../lib/git.mjs'
import { enforceSlotBoundary } from '../../lib/harness-context.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseRemoteUrls, parseRemotesTopology, probeForWrite, resolveIdentityLayers,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { classifyDoorType, detectGateWeakening, gitDiffRawEntriesAndText, matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { checkStackedParentMerged, checkUnresolvedDependencies } from '../../lib/task-graph.mjs'
import {
  determineWorkflowPolicy, hasRepoCiWorkflow, readVerificationEvidence,
  resolveEffectiveBaseSha, validatePreMergeShaAndWorktree, validateReviewRecordClosure, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildCleanupChecklist, handleAbort, handleCleanup, handleStatus, printCleanupChecklistText } from './flow-cleanup.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'
import { runLifecycleGovernHook } from './flow-lifecycle-hooks.mjs'
import {
  analyzeIssueClaimState, assertClaimOrMergeProvenance, evaluateMasterIssueCloseGuard,
  handleClaim, handleRelease,
} from './flow-merge-claim.mjs'
import { runTrialMerge } from './flow-trial-merge.mjs'

export { analyzeIssueClaimState, handleAbort, handleClaim, handleCleanup, handleRelease, handleStatus }

/**
 * 一次写评论的成败，从后端返回值里读。
 *
 * 后端在没有直连凭据时返回的是「未成功 + 已转交宿主代理」——`ok: false` 加 `delegated: true`。
 * 这种失败是**没发出去**，不是「发了但被别人接着做了」。所以判据只看 `ok`：
 * 只要不是成功，就当作未发出，并把后端给的原因原样带出来。
 */
export function judgeCommentOutcome(result) {
  if (result && result.ok === true) return { ok: true }
  const reason = result?.skipped
    ? `后端不支持写评论（${result.reason ?? 'client-unsupported'}）`
    : (result?.delegated ? '后端没有直连凭据，评论已转交宿主代理但未由本工具发出' : (result?.reason ?? '后端返回未成功'))
  return { ok: false, reason }
}

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
  if (ledger.tier !== 1 && !samePath(implRoot, mainRoot)) {
    const mainStPre = await gitStatusPorcelainZ(mainRoot)
    const dirtyMainEntries = mainStPre.ok ? (mainStPre.entries ?? []).filter((e) => e.file && !e.file.startsWith('.worktrees/')) : []
    const mainGate = enforceSlotBoundary({ mainRoot, implRoot, caseType: ledger.caseType, isDirtyMain: dirtyMainEntries.length > 0, commits: ledger.baseSha ? 1 : 0 })
    if (!mainGate.ok) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: mainGate.code, reason: mainGate.reason }, null, 2)}\n`)
      process.stderr.write(`${mainGate.code}: ${mainGate.reason}\n`)
      return { ok: false, exitCode: mainGate.exitCode, code: mainGate.code }
    }
  }

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
  if (ledger.planning === true || ledger.status === 'planning') {
    const msg = `BLOCKED_PLAN_NOT_READY: 任务 ${taskId} 仍处于规划阶段（planning），请先批准规划并运行 flow.mjs start --task ${taskId} 转入实施后再合并。`
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_PLAN_NOT_READY', taskId }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { ok: false, exitCode: EXIT.FACT, code: 'BLOCKED_PLAN_NOT_READY' }
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
      const closureCheck = validateReviewRecordClosure({ ledger, lastRound, policy, hasDevReview, stopLossActive })
      if (!closureCheck.ok) {
        process.stderr.write(`${closureCheck.code}: ${closureCheck.reason}\n`)
        return { ok: false, exitCode: closureCheck.exitCode ?? EXIT.FACT, code: closureCheck.code }
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

  const provActor = (ledger.claimedBy && ledger.claimedBy !== 'local-agent' ? ledger.claimedBy : null)
    ?? (ledger.agent && ledger.agent !== 'local-agent' ? ledger.agent : null)
    ?? (ledger.implementerId && ledger.implementerId !== 'local-agent' ? ledger.implementerId : null)
  const provGate = assertClaimOrMergeProvenance({
    mainRoot, docRoot: implRoot, ledger, taskId, actor: provActor, opts,
  })
  if (provGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, ...provGate }, null, 2)}\n`)
    process.stderr.write(`${provGate.code}: ${provGate.reason}\n`)
    return { ok: false, exitCode: provGate.exitCode ?? EXIT.FACT, code: provGate.code }
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
  // 本次合并发出的回告逐条记成败：两条合并路径共用一份，报告里统一列出未发出的那些。
  const mergeComments = []
  const syncFailures = []
  const issueCloseDecisions = []

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
    // 先同步 mainRoot，确保 1:N 总控 Issue 关单保护读取到最新主线切片终态。
    const mainSt = await gitStatusPorcelainZ(roots.mainRoot)
    if (!opts._ghProbe && mainSt.ok && mainSt.entries.length === 0) {
      await gitRun(roots.mainRoot, ['fetch', pushRemote, baseBranch])
      const fastMainBr = readHeadFast(resolveGitDirFast(roots.mainRoot), roots.gitDir)?.branch ?? null
      const curMainBr = fastMainBr ? { ok: true, stdout: fastMainBr } : await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (curMainBr.ok && curMainBr.stdout.trim() === baseBranch) {
        await gitRun(roots.mainRoot, ['merge', '--ff-only', '--no-edit', `${pushRemote}/${baseBranch}`])
      }
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
    try {
      const prCmt = judgeCommentOutcome(await backend.postComment({
        repo: originFull,
        number: ledger.prNumber,
        body: mergePrBody,
        statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer ?? null },
      }))
      mergeComments.push({ target: `PR #${ledger.prNumber}`, ...prCmt })
      if (!prCmt.ok) syncFailures.push({ target: `PR #${ledger.prNumber}`, phase: 'merge', error: prCmt.reason || prCmt.error || 'comment_failed' })
    } catch (err) {
      const msg = err?.message ?? String(err)
      mergeComments.push({ target: `PR #${ledger.prNumber}`, ok: false, reason: msg })
      syncFailures.push({ target: `PR #${ledger.prNumber}`, phase: 'merge', error: msg })
    }
    for (const iss of ledger.linkedIssues ?? []) {
      try {
        const closeGuard = evaluateMasterIssueCloseGuard({
          mainRoot: roots.mainRoot, implRoot, issueNumber: iss, ledger, taskId, baseBranch,
        })
        const issBody = closeGuard.progressNote ? `${mergeIssueBody}\n\n${closeGuard.progressNote}` : mergeIssueBody
        const issCmt = judgeCommentOutcome(await backend.postComment({
          repo: originFull, number: iss, body: issBody,
          statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber, reviewerId: effectiveReviewer ?? null },
        }))
        mergeComments.push({ target: `Issue #${iss}`, ...issCmt })
        if (!issCmt.ok) syncFailures.push({ target: `Issue #${iss}`, phase: 'merge', error: issCmt.reason || issCmt.error || 'comment_failed' })
        await backend.removeLabel({ repo: originFull, number: iss, label: 'in-progress' })
        await backend.removeLabel({ repo: originFull, number: iss, label: 'in-review' })
        await backend.removeLabel({ repo: originFull, number: iss, label: 'changes-requested' })
        if (closeGuard.shouldClose) {
          await backend.closeIssue({ repo: originFull, number: iss })
          issueCloseDecisions.push({ issue: iss, action: 'closed', reason: closeGuard.reason ?? 'merged' })
        } else {
          issueCloseDecisions.push({
            issue: iss,
            action: 'kept-open',
            reason: closeGuard.reason,
            masterPrd: closeGuard.masterPrd,
            remainingSiblings: closeGuard.remainingSiblings,
          })
        }
      } catch (err) {
        const msg = err?.message ?? String(err)
        mergeComments.push({ target: `Issue #${iss}`, ok: false, reason: msg })
        syncFailures.push({ target: `Issue #${iss}`, phase: 'merge', error: msg })
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
        try {
          const closeGuard = evaluateMasterIssueCloseGuard({
            mainRoot: roots.mainRoot, implRoot, issueNumber: iss, ledger, taskId, baseBranch,
          })
          const issBody = closeGuard.progressNote ? `${localMergeBody}\n\n${closeGuard.progressNote}` : localMergeBody
          const issCmt = judgeCommentOutcome(await backend.postComment({
            taskId, number: iss, body: issBody,
            statePayload: { taskId, action: 'merged', branch: ledger.branch, reviewerId: effectiveReviewer ?? null },
          }))
          mergeComments.push({ target: `Issue #${iss}`, ...issCmt })
          if (!issCmt.ok) syncFailures.push({ target: `Issue #${iss}`, phase: 'merge', error: issCmt.reason || issCmt.error || 'comment_failed' })
          await backend.removeLabel({ taskId, number: iss, label: 'in-progress' })
          await backend.removeLabel({ taskId, number: iss, label: 'in-review' })
          await backend.removeLabel({ taskId, number: iss, label: 'changes-requested' })
          if (closeGuard.shouldClose) {
            await backend.closeIssue({ number: iss, reason: `merged into ${baseBranch}` })
            issueCloseDecisions.push({ issue: iss, action: 'closed', reason: closeGuard.reason ?? 'merged' })
          } else {
            issueCloseDecisions.push({
              issue: iss,
              action: 'kept-open',
              reason: closeGuard.reason,
              masterPrd: closeGuard.masterPrd,
              remainingSiblings: closeGuard.remainingSiblings,
            })
          }
        } catch (err) {
          const msg = err?.message ?? String(err)
          mergeComments.push({ target: `Issue #${iss}`, ok: false, reason: msg })
          syncFailures.push({ target: `Issue #${iss}`, phase: 'merge', error: msg })
        }
      }
    }
  }

  ledger.status = 'merged'
  ledger.mergedAt = new Date().toISOString()
  ledger.mergeComments = mergeComments
  if (syncFailures.length > 0) {
    ledger.syncFailures = [...(Array.isArray(ledger.syncFailures) ? ledger.syncFailures : []), ...syncFailures]
  }
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
  const unreported = mergeComments.filter((c) => !c.ok)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, status: ledger.status, mergeRes, pendingCleanupChecklist: checklist, ...(issueCloseDecisions.length > 0 ? { issueCloseDecisions } : {}), ...(mergeComments.length > 0 ? { mergeComments } : {}), ...(unreported.length > 0 ? { unreportedComments: unreported } : {}), ...(syncFailures.length > 0 ? { syncFailures } : {}) }, null, 2)}\n`)
  else {
    process.stdout.write(`合并状态已确认（task=${taskId}, status=${ledger.status}）。未自动删除任何分支或 Worktree。\n`)
    for (const d of issueCloseDecisions.filter((x) => x.action === 'kept-open')) {
      process.stdout.write(`[1:N 关单保护] Issue #${d.issue} 保留开启（${d.masterPrd} 仍有 ${d.remainingSiblings?.length ?? '?'} 个未完成兄弟切片）。\n`)
    }
    // 回告没发出去必须看得见：静默吞掉等于对外部提案人一声不吭地合了单。
    for (const u of unreported) {
      process.stdout.write(`回告未发出：${u.target}（${u.reason}）\n`)
      const num = String(u.target).replace(/^[^#]*#/, '')
      process.stdout.write(`  补发命令：node .agents/skills/dev-flow/scripts/flow.mjs issue comment --issue ${num} --body "<回告正文>"\n`)
    }
    printCleanupChecklistText(checklist)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}

