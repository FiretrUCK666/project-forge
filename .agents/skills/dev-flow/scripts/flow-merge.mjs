/**
 * flow-merge.mjs —— merge（强校审查 HEAD/止损解锁/generic-git）、cleanup（Squash/Rebase 四态）、status 与 abort。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  canonicalPath, detectInProgressGitOp, gitRun, gitStatusPorcelainZ,
  inspectBranchMergeState, samePath,
} from '../../lib/git.mjs'
import { listTaskLedgers, resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseFlowInputs, parseIssueNumbers, parseRemotesTopology,
  parseRemoteUrls, probeGitHubEnv,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { classifyDoorType, detectGateWeakening, matchGlob } from '../../lib/static-gates.mjs'
import { buildTargetRepoContext, EXIT_ACTION_REQUIRED, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import { unmountSharedDeps } from './worktree-deps.mjs'

function isCwdInside(wtAbs) {
  const cwd = canonicalPath(process.cwd())
  const wt = canonicalPath(wtAbs)
  if (samePath(cwd, wt)) return true
  const rel = relative(wt, cwd)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

async function buildCleanupChecklist(mainRoot, ledger, remoteUrls, targetRepo, pushRemote = 'origin') {
  const worktrees = []
  for (const relWt of [ledger.reviewWorktreePath, ledger.worktreePath].filter(Boolean)) {
    const abs = resolve(mainRoot, relWt)
    if (!existsSync(abs)) continue
    const stZ = await gitStatusPorcelainZ(abs)
    worktrees.push({ path: relWt, abs, dirty: stZ.entries.length > 0 })
  }

  let localBranchExists = false
  let mergeState = null
  if (ledger.branch) {
    const ref = await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${ledger.branch}`])
    localBranchExists = ref.ok
    if (localBranchExists) {
      mergeState = await inspectBranchMergeState(mainRoot, { branch: ledger.branch, defaultBranch: ledger.baseBranch || 'main' })
    }
  }

  let remoteBranchExists = false
  if (ledger.branch && remoteUrls[pushRemote]) {
    const ls = await gitRun(mainRoot, ['ls-remote', '--heads', pushRemote, ledger.branch])
    remoteBranchExists = ls.ok && ls.stdout.trim() !== ''
  }

  const ghProbe = await probeGitHubEnv({ cwd: mainRoot, remoteUrls })
  const downstream = targetRepo && ledger.branch && ghProbe.env.providerId === 'github'
    ? await ghProbe.client.listOpenPrsByBase(targetRepo, ledger.branch)
    : { ok: true, prs: [] }

  let prState = ledger.prState ?? (ledger.status === 'awaiting-upstream-merge' ? 'OPEN' : null)
  if (targetRepo && ledger.prNumber && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')) {
    const pr = await ghProbe.client.getPr(targetRepo, ledger.prNumber)
    if (pr.ok) prState = pr.state
  }

  return {
    taskId: ledger.taskId, role: ledger.role, worktrees,
    localBranch: localBranchExists ? ledger.branch : null, mergeState,
    remoteBranch: remoteBranchExists ? `${pushRemote}/${ledger.branch}` : null,
    pushRemote, downstreamStackedPrs: downstream.prs ?? [], prNumber: ledger.prNumber, prState,
  }
}

function printCleanupChecklistText(cl) {
  process.stdout.write('\n待确认清理清单（未得人点头前严禁自动删除）：\n')
  process.stdout.write(`- Worktrees: ${cl.worktrees.length > 0 ? cl.worktrees.map((w) => `${w.path}${w.dirty ? ' [脏]' : ' [干净]'}`).join(', ') : '无'}\n`)
  process.stdout.write(`- 本地分支: ${cl.localBranch ?? '无'}${cl.mergeState ? ` (${cl.mergeState.state})` : ''}\n`)
  process.stdout.write(`- 远端分支: ${cl.remoteBranch ?? '无'}\n`)
  process.stdout.write(`- 下游堆叠 PR: ${cl.downstreamStackedPrs.length}\n`)
  if (cl.prNumber) process.stdout.write(`- 关联 PR #${cl.prNumber} 状态: ${cl.prState ?? '未知'}\n`)
}

export async function handleMerge(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx

  if (ledger.role === 'contributor-fork') {
    process.stderr.write('BLOCKED_FORK_CANNOT_MERGE: contributor-fork 无权合并上游仓库 PR，请等待上游维护者合并。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (ledger.role === 'clone-readonly' || ledger.role === 'undetermined') {
    process.stderr.write(`BLOCKED_ROLE_CANNOT_MERGE: 当前身份为 ${ledger.role}，不允许执行合并。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot)
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)

  const stZ = await gitStatusPorcelainZ(implRoot)
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 实施工作区存在未提交改动，请先提交并验证后再执行 merge。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (!ledger.verifiedHead || (currentHead && ledger.verifiedHead !== currentHead) || ledger.lastVerifyExitCode !== 0) {
    process.stderr.write('BLOCKED_NOT_VERIFIED: 合并前必须有匹配当前 HEAD 的实证通过记录。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const profile = parseAgentsProfile(roots.mainRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)
  const highRiskHits = changed.filter((f) => profile.highRisk.some((pat) => matchGlob(f, pat)))
  const rounds = ledger.rounds ?? []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const effectiveReviewer = lastRound?.reviewerId ?? ledger.reviewerId ?? ledger.lastReview?.reviewerId

  const gateFindings = await detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch)
  if (gateFindings.length > 0 && !opts['human-approved']) {
    const doorInfo = classifyDoorType({ changedFiles: changed, highRisk: profile.highRisk, gateWeakened: true })
    const summary = gateFindings.map((f) => `[${f.type}] ${f.file}: ${f.detail}`).join('; ')
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false, blocked: true, code: 'BLOCKED_GATE_WEAKENING', doorType: doorInfo.doorType, findings: gateFindings,
        nextStep: `请向人类报告上述门禁弱化发现，获准后再附 --human-approved 重试 merge`,
      }, null, 2)}\n`)
    } else {
      process.stderr.write(`BLOCKED_GATE_WEAKENING (one-way door): 检测到门禁弱化改动，须人类确认：${summary}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId} --human-approved` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT_ACTION_REQUIRED }
  }

  const stopLossActive = Boolean(ledger.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered)
  const humanApprovedUnlock = Boolean(opts['human-approved'] || ledger.humanApprovedStopLoss)
  if (stopLossActive && !humanApprovedUnlock) {
    process.stderr.write('BLOCKED_STOP_LOSS_ESCALATE: 独立审查已触发停损升级（STOP_LOSS_ESCALATE），须人类裁决后带 --human-approved --reason "..." 放行。\n')
    return { exitCode: EXIT_ACTION_REQUIRED }
  }
  if (stopLossActive && opts['human-approved']) {
    ledger.humanApprovedStopLoss = true
    ledger.humanApprovedReason = opts.reason ?? ledger.humanApprovedReason ?? 'human-approved-stop-loss-override'
  }

  const requiresReview = highRiskHits.length > 0 || rounds.length > 0 || ledger.caseType >= 3 || Boolean(ledger.lastReview)
  if (requiresReview) {
    if (!effectiveReviewer || effectiveReviewer === ledger.implementerId) {
      process.stderr.write(`BLOCKED_REQUIRES_INDEPENDENT_REVIEW: 触碰高风险路径或需要独立审查（hits=${highRiskHits.join(',') || `case ${ledger.caseType}`}），必须存在 reviewerId !== implementerId 的独立审查 PASS 记录。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (!stopLossActive) {
      const reviewHeadOk = ledger.reviewPassed === true
        && (!currentHead || ledger.reviewPassedHead === currentHead)
        && (!ledger.lastReview || !currentHead || ledger.lastReview.headSha === currentHead)
        && (!lastRound || !currentHead || lastRound.headSha === currentHead)
      if (!reviewHeadOk) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 独立审查结论未覆盖当前 HEAD（reviewPassed=${ledger.reviewPassed}, reviewPassedHead=${ledger.reviewPassedHead ?? 'null'}, currentHead=${currentHead ?? 'null'}）。\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
      if (lastRound && (lastRound.verdict !== 'pass' || (lastRound.blockers ?? []).length > 0)) {
        process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 最新一轮审查未通过（verdict=${lastRound.verdict}）。\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
  }

  if (profile.mergeAuthority === 'human' && !opts['human-approved']) {
    process.stderr.write('BLOCKED_HUMAN_MERGE_AUTHORITY: 项目「取舍」声明了 merge-authority: human，请经人类确认后附加 --human-approved。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)

  let mergeRes = null
  const baseBranch = ledger.baseBranch || 'main'
  const canUseGhMerge = ledger.role === 'maintainer' && ledger.providerId !== 'generic-git' && ledger.prNumber && originFull
  if (canUseGhMerge) {
    const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
    mergeRes = await ghProbe.client.mergePr({ repo: originFull, number: ledger.prNumber, method: opts.method ?? 'merge' })
    if (mergeRes.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, mergeDelegated: mergeRes }, null, 2)}\n`)
      else {
        process.stdout.write(`无直连 GitHub 凭据，已生成合并代理载荷：${JSON.stringify(mergeRes.jsonPayload)}\n`)
        printNextStep(['请在宿主 MCP 完成合并并回读 state=MERGED 后，再向人展示待清理清单。'], { repoRoot: roots.mainRoot })
      }
      return { exitCode: 0 }
    }
    if (!mergeRes.ok || !mergeRes.merged) throw new Error(`PR #${ledger.prNumber} 合并或回读确认 MERGED 失败（state=${mergeRes.state ?? mergeRes.error}）`)
    for (const iss of ledger.linkedIssues ?? []) {
      await ghProbe.client.postComment({ repo: originFull, number: iss, body: `已合并：PR #${ledger.prNumber} 已合并至 \`${baseBranch}\`。`, statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber } })
    }
    const mainSt = await gitStatusPorcelainZ(roots.mainRoot)
    if (mainSt.ok && mainSt.entries.length === 0) {
      await gitRun(roots.mainRoot, ['fetch', pushRemote, baseBranch])
      const curMainBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (curMainBr.ok && curMainBr.stdout.trim() === baseBranch) {
        await gitRun(roots.mainRoot, ['merge', '--ff-only', `${pushRemote}/${baseBranch}`])
      }
    }
  } else if (ledger.branch) {
    const mainSt = await gitStatusPorcelainZ(roots.mainRoot)
    if (!mainSt.ok || mainSt.entries.length > 0) {
      process.stderr.write('BLOCKED_DIRTY_MAIN: 主工作区存在未提交改动，无法并入基线分支，请清理后再 merge。\n')
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const curMainBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (!curMainBr.ok || curMainBr.stdout.trim() !== baseBranch) {
      const hasBase = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${baseBranch}`])
      if (hasBase.ok) {
        const sw = await gitRun(roots.mainRoot, ['switch', baseBranch])
        if (!sw.ok) throw new Error(`切回基线分支 ${baseBranch} 失败：${sw.stderr}`)
      }
    }
    const baseExists = (await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', baseBranch])).ok
    const curAfter = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (baseExists && (!curAfter.ok || curAfter.stdout.trim() !== ledger.branch)) {
      const isAnc = await gitRun(roots.mainRoot, ['merge-base', '--is-ancestor', ledger.branch, 'HEAD'])
      if (!isAnc.ok) {
        const mRes = await gitRun(roots.mainRoot, ['merge', '--no-ff', ledger.branch, '-m', `Merge branch '${ledger.branch}' (${taskId})`])
        if (!mRes.ok) {
          await gitRun(roots.mainRoot, ['merge', '--abort'])
          throw new Error(`本地合并分支 ${ledger.branch} 到 ${baseBranch} 失败（已中止合并）：${mRes.stderr}`)
        }
        mergeRes = { ok: true, localMerge: true, branch: ledger.branch, into: baseBranch }
      } else {
        mergeRes = { ok: true, alreadyMerged: true, branch: ledger.branch, into: baseBranch }
      }
    } else {
      mergeRes = { ok: true, localBranchCurrent: true, branch: ledger.branch, into: baseBranch }
    }
  }

  ledger.status = 'merged'
  ledger.mergedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  const checklist = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, originFull, pushRemote)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, status: ledger.status, mergeRes, pendingCleanupChecklist: checklist }, null, 2)}\n`)
  else {
    process.stdout.write(`合并状态已确认（task=${taskId}, status=${ledger.status}）。未自动删除任何分支或 Worktree。\n`)
    printCleanupChecklistText(checklist)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleCleanup(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)
  const cl = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, targetRepo, pushRemote)

  if (!opts.confirm) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_CONFIRMATION_REQUIRED', checklist: cl }, null, 2)}\n`)
    else {
      process.stdout.write('BLOCKED_CONFIRMATION_REQUIRED: 缺少 --confirm，已拒绝执行删除。\n')
      printCleanupChecklistText(cl)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (ledger.role === 'contributor-fork' && cl.prState === 'OPEN' && !opts['keep-branch']) {
    process.stderr.write(`BLOCKED_OPEN_FORK_PR: contributor-fork 关联上游 PR #${ledger.prNumber ?? '?'} 仍为 OPEN，硬锁拒绝删除 Fork 分支。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (cl.downstreamStackedPrs.length > 0 && !opts['keep-branch']) {
    process.stderr.write(`BLOCKED_STACKED_PR: 存在以 ${ledger.branch} 为 base 的下游开放 PR，拒绝删除分支。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  const dirtyWt = cl.worktrees.find((w) => w.dirty)
  if (dirtyWt && !opts.force) {
    process.stderr.write(`BLOCKED_DIRTY_WORKTREE: 工作树 ${dirtyWt.path} 存在未提交改动，拒绝自动移除。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  if (cl.localBranch) {
    const curBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (curBr.ok && curBr.stdout.trim() === cl.localBranch) {
      const sw = await gitRun(roots.mainRoot, ['switch', ledger.baseBranch || 'main'])
      if (!sw.ok) throw new Error(`切回默认分支失败：${sw.stderr}`)
    }
  }

  const removedWorktrees = []
  for (const wt of cl.worktrees) {
    if (isCwdInside(wt.abs)) throw new Error(`当前进程工作目录位于待删除 worktree (${wt.path}) 内，请先切回主仓根目录再清理`)
    const unmount = unmountSharedDeps(roots.mainRoot, wt.abs)
    const rmArgs = opts.force ? ['worktree', 'remove', '--force', wt.abs] : ['worktree', 'remove', wt.abs]
    const rmRes = await gitRun(roots.mainRoot, rmArgs)
    if (!rmRes.ok) throw new Error(`移除 worktree ${wt.path} 失败：${rmRes.stderr}`)
    removedWorktrees.push({ path: wt.path, unmountedDeps: unmount.unmounted.length })
  }

  let deletedLocalBranch = false
  if (cl.localBranch && !opts['keep-branch'] && cl.localBranch !== ledger.baseBranch) {
    const isSquashOrRebase = cl.mergeState?.state === 'squash_or_rebase_merged'
    const delArgs = isSquashOrRebase ? ['branch', '-D', cl.localBranch] : ['branch', '-d', cl.localBranch]
    const delBr = await gitRun(roots.mainRoot, delArgs)
    if (!delBr.ok) throw new Error(`安全删除本地分支 ${cl.localBranch} 失败（state=${cl.mergeState?.state ?? 'unknown'}）：${delBr.stderr}`)
    deletedLocalBranch = true
  }

  let deletedRemoteBranch = false
  if (cl.remoteBranch && !opts['keep-branch'] && ledger.role !== 'local-only') {
    const delRemote = await gitRun(roots.mainRoot, ['push', cl.pushRemote, '--delete', ledger.branch])
    if (!delRemote.ok) throw new Error(`删除远端分支 ${cl.pushRemote}/${ledger.branch} 失败：${delRemote.stderr}`)
    deletedRemoteBranch = true
  }

  ledger.status = 'cleaned'
  ledger.cleanedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  const summary = { taskId, removedWorktrees, deletedLocalBranch, mergeState: cl.mergeState?.state ?? null, deletedRemoteBranch, status: ledger.status }
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else {
    process.stdout.write(`清理完成（task=${taskId}）：移除 worktree ${removedWorktrees.length} 个，本地分支删除=${deletedLocalBranch}，远端分支删除=${deletedRemoteBranch}。\n`)
    printNextStep(['任务全流程已完成，工作区与账本均保持干净状态。'], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleStatus(opts, roots) {
  const active = listTaskLedgers(roots.mainRoot, { includeTerminal: false })
  let ctx = null
  try {
    ctx = await resolveTaskContext(roots, opts)
  } catch (err) {
    if (opts.task || active.length === 0) throw err
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, ambiguous: true, activeTasks: active }, null, 2)}\n`)
    else {
      process.stdout.write(`当前有 ${active.length} 个未闭环任务：\n`)
      for (const t of active) process.stdout.write(`- ${t.taskId}: status=${t.status}, branch=${t.branch ?? '-'}\n`)
      printNextStep(active.map((t) => ({ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" status --task ${t.taskId}` })), { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const { taskId, ledger, source } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const exists = existsSync(implRoot)
  const op = exists ? await detectInProgressGitOp(implRoot) : { inProgress: false }
  const headRes = exists ? await gitRun(implRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' }
  const head = headRes.ok ? headRes.stdout.trim() : null
  const stZ = exists ? await gitStatusPorcelainZ(implRoot) : { entries: [] }

  let nextAction
  if (op.inProgress) nextAction = `先解决当前 ${op.op} 冲突，再继续流转`
  else if (ledger.status === 'released') nextAction = `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId}`
  else if (stZ.entries.length > 0) nextAction = '工作区有未提交改动，完成后 git add -A && git commit 再 verify'
  else if ((ledger.caseType >= 3 || ledger.todoFile || ledger.specFile) && !ledger.finalized) nextAction = `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`
  else if (!ledger.verifiedHead || (head && ledger.verifiedHead !== head) || ledger.lastVerifyExitCode !== 0) nextAction = `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}`
  else if (!['submitted', 'local-ready', 'awaiting-upstream-merge', 'merged'].includes(ledger.status)) nextAction = `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}`
  else if (ledger.status === 'merged') nextAction = `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm`
  else nextAction = ledger.reviewPassed ? `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId}` : `等待独立审查 PASS（当前 HEAD=${head?.slice(0, 7) ?? 'unborn'}）`

  const payload = { taskId, inferredFrom: source, status: ledger.status, role: ledger.role, branch: ledger.branch, head, dirty: stZ.entries.length, finalized: ledger.finalized, verifiedHead: ledger.verifiedHead, reviewPassed: Boolean(ledger.reviewPassed), nextAction }
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else {
    process.stdout.write(`任务状态：${taskId}（推断来源=${source}）\n- status=${ledger.status} | role=${ledger.role} | branch=${ledger.branch ?? '-'}\n- HEAD=${head?.slice(0, 7) ?? 'unborn'} | dirty=${stZ.entries.length} | verified=${ledger.verifiedHead === head} | reviewPassed=${Boolean(ledger.reviewPassed)}\n`)
    printNextStep([{ skill: 'dev-flow', text: nextAction }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleAbort(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const worktrees = [ledger.reviewWorktreePath, ledger.worktreePath].filter(Boolean).map((p) => ({ path: p, abs: resolve(roots.mainRoot, p) })).filter((w) => existsSync(w.abs))
  if (!opts.confirm) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_CONFIRMATION_REQUIRED', taskId, worktrees: worktrees.map((w) => w.path), branch: ledger.branch }, null, 2)}\n`)
    else {
      process.stdout.write(`BLOCKED_CONFIRMATION_REQUIRED: 放弃任务 ${taskId} 将移除 worktree (${worktrees.map((w) => w.path).join(', ') || '无'}) 并标记账本为 aborted。\n`)
      printNextStep([{ skill: 'dev-flow', text: `确认放弃后运行：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  for (const wt of worktrees) {
    if (isCwdInside(wt.abs)) throw new Error(`当前工作目录位于待拆除 worktree (${wt.path}) 内，请先切回主仓`)
    unmountSharedDeps(roots.mainRoot, wt.abs)
    const rmRes = await gitRun(roots.mainRoot, opts.force ? ['worktree', 'remove', '--force', wt.abs] : ['worktree', 'remove', wt.abs])
    if (!rmRes.ok) throw new Error(`移除 ${wt.path} 失败：${rmRes.stderr}`)
  }
  if (ledger.branch && !opts['keep-branch'] && ledger.branch !== ledger.baseBranch) {
    const cur = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (cur.ok && cur.stdout.trim() === ledger.branch) await gitRun(roots.mainRoot, ['switch', ledger.baseBranch || 'main'])
    await gitRun(roots.mainRoot, opts.force ? ['branch', '-D', ledger.branch] : ['branch', '-d', ledger.branch])
  }
  ledger.status = 'aborted'
  ledger.abortedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, taskId, status: 'aborted' }, null, 2)}\n`)
  else process.stdout.write(`任务 ${taskId} 已安全放弃并更新账本为 aborted。\n`)
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
  if (extraIssues.length > 0) {
    ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extraIssues])]
  }

  const actor = opts.agent ?? ledger.implementerId ?? 'local-agent'
  const reason = String(opts.reason ?? '').trim()
  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only'
    || ledger.role === 'generic-git'
    || ledger.providerId === 'generic-git'
    || (ledger.linkedIssues ?? []).length === 0
    || !targetRepo

  const releaseResults = []
  if (!skipApi) {
    const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    for (const num of ledger.linkedIssues) {
      const commentRes = await ghClient.postComment({
        repo: targetRepo,
        number: num,
        body: `释放认领：${actor} 放弃任务 \`${taskId}\`（分支 \`${ledger.branch ?? 'none'}\`）${reason ? `，原因：${reason}` : ''}。`,
        statePayload: {
          taskId,
          action: 'release',
          agent: actor,
          branch: ledger.branch ?? null,
          ...(reason ? { reason } : {}),
        },
      })
      const labelRes = await ghClient.removeLabel({ repo: targetRepo, number: num, label: 'in-progress' })
      releaseResults.push({ issue: num, comment: commentRes, labelRemoved: labelRes })
    }
  }

  ledger.status = 'released'
  ledger.releasedAt = new Date().toISOString()
  ledger.releaseReason = reason || null
  ledger.claimedAt = null
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      taskId,
      role: ledger.role,
      mode: skipApi ? 'local-ledger-only' : 'remote-synced',
      status: ledger.status,
      reason: ledger.releaseReason,
      releaseResults,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已释放认领（status=released${skipApi ? '，仅本地账本' : `, issues=${ledger.linkedIssues.join(',')}`}）。\n`)
    printNextStep([
      { skill: 'dev-flow', text: `如需由其他人接手：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <agent>` },
      { skill: 'dev-flow', text: `或安全放弃任务与工作区：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}
