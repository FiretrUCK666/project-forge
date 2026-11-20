/**
 * flow-sync.mjs —— 堆叠 PR 与长生命周期分支变基同步引擎（unmountSharedDeps -> rebase --onto -> remount -> updatePrBase -> roundBaseSha / syncCount）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  detectInProgressGitOp, gitRun, gitStatusPorcelainZ, resolveDefaultBranch, syncDetachedWorktree, } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { readTaskLedger, recordMountedDepsInLedger, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeForWrite } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { checkStackedParentMerged } from '../../lib/task-graph.mjs'
import { resolveEffectiveBaseSha } from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK } from './flow-inspect.mjs'
import { mountSharedDeps, unmountSharedDeps } from './worktree-deps.mjs'

export async function handleSync(opts = {}, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const stZ = await gitStatusPorcelainZ(implRoot)
  const op = await detectInProgressGitOp(implRoot, { statusEntries: stZ.entries })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突再 sync`)
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 实施工作区存在未提交改动，请先提交后再执行 sync。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const fastPrevHead = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
  const headRes = fastPrevHead ? { ok: true, stdout: fastPrevHead } : await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const prevHeadSha = headRes.ok ? headRes.stdout.trim() : null
  const oldBaseSha = ledger.baseSha ?? null
  const oldBaseBranch = ledger.baseBranch ?? 'main'

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)

  const canQueryGh = ledger.role === 'maintainer' && ledger.providerId !== 'generic-git' && originFull
  const ghProbe = canQueryGh && (opts._ghProbe || opts._ghClient || opts['probe-auth'] || ledger.prNumber || ledger.parentPrNumber)
    ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls })))
    : null
  const backend = createTaskBackend({
    role: opts._ghClient ? 'maintainer' : ledger.role,
    providerId: opts._ghClient ? 'github' : ledger.providerId,
    targetRepo: originFull ?? 'local/mock',
    client: opts._ghClient ?? ghProbe?.client,
    pushRemote,
    mainRoot: roots.mainRoot,
    gitDir: roots.gitDir,
  })

  const defaultBranch = ledger.stackTargetBase ?? (await resolveDefaultBranch(roots.mainRoot)) ?? 'main'
  let targetBaseBranch = opts.onto ? String(opts.onto).trim() : oldBaseBranch
  let parentMerged = false
  if (!opts.onto && (ledger.parentTaskId || ledger.parentBranch)) {
    const parentCheck = await checkStackedParentMerged(roots.mainRoot, ledger, { backend, targetRepo: originFull, defaultBranch })
    if (!parentCheck.blocked) {
      targetBaseBranch = defaultBranch
      parentMerged = true
    } else if (ledger.parentBranch) {
      targetBaseBranch = ledger.parentBranch
    }
  }

  let newBaseSha = resolveRefShaFast(roots.gitDir, `refs/heads/${targetBaseBranch}`)
    ?? resolveRefShaFast(roots.gitDir, `refs/remotes/${pushRemote}/${targetBaseBranch}`)
  if (!newBaseSha) {
    for (const cand of [targetBaseBranch, `refs/heads/${targetBaseBranch}`, `refs/remotes/${pushRemote}/${targetBaseBranch}`]) {
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', cand])
      if (r.ok && r.stdout.trim()) { newBaseSha = r.stdout.trim(); break }
    }
  }
  if (!newBaseSha) {
    throw new Error(`找不到 sync 目标基线分支或提交：${targetBaseBranch}`)
  }

  // 若 HEAD 已经基于目标基线（例如用户手工执行过 `git rebase origin/main`），直接刷新 ledger.baseSha，不重放旧提交
  const alreadyAnc = await gitRun(implRoot, ['--no-optional-locks', 'merge-base', '--is-ancestor', newBaseSha, 'HEAD'])
  const alreadyBasedOnTarget = Boolean(alreadyAnc.ok)
  let depMount = { mode: ledger.depsMode ?? 'none' }

  if (!alreadyBasedOnTarget) {
    if (ledger.tier === 2) {
      const mountedForImpl = ledger.mountedDepsByWorktree?.[ledger.worktreePath] ?? ledger.mountedDeps ?? []
      const implUm = unmountSharedDeps(roots.mainRoot, implRoot, { mode: 'deps', mountedPaths: mountedForImpl })
      if (!implUm?.ok) throw new Error(`sync 前解绑实施工作区共享依赖失败：${JSON.stringify(implUm?.blocked ?? [])}`)
    }

    const calibratedOldBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: roots.gitDir, pushRemote })
    const rebaseArgs = calibratedOldBase
      ? ['rebase', '--onto', newBaseSha, calibratedOldBase, ...(ledger.branch ? [ledger.branch] : [])]
      : ['rebase', newBaseSha]
    const rbRes = await gitRun(implRoot, rebaseArgs)
    if (!rbRes.ok) {
      const conflictSt = await gitStatusPorcelainZ(implRoot)
      const conflicts = conflictSt.entries.map((e) => e.file)
      await gitRun(implRoot, ['rebase', '--abort'])
      if (ledger.tier === 2) {
        const remount = mountSharedDeps(roots.mainRoot, implRoot)
        ledger.depsMode = remount.mode
        recordMountedDepsInLedger(ledger, ledger.worktreePath, remount)
        await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
      }
      const payload = {
        ok: false,
        blocked: true,
        code: 'BLOCKED_SYNC_REBASE_CONFLICT',
        exitCode: EXIT_POLICY_BLOCK,
        taskId,
        onto: targetBaseBranch,
        newBaseSha,
        oldBaseSha: calibratedOldBase ?? oldBaseSha,
        conflicts,
        stderr: rbRes.stderr,
      }
      if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      process.stderr.write(`BLOCKED_SYNC_REBASE_CONFLICT: sync 变基到 ${targetBaseBranch} 产生冲突（${conflicts.join(', ') || rbRes.stderr}），已中止变基保护现场。\n`)
      return { exitCode: EXIT_POLICY_BLOCK, ...payload }
    }

    depMount = ledger.tier === 2 ? mountSharedDeps(roots.mainRoot, implRoot) : { mode: 'none' }
    if (ledger.tier === 2) {
      ledger.depsMode = depMount.mode
      recordMountedDepsInLedger(ledger, ledger.worktreePath, depMount)
    }
  }
  const fastNewHead = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
  const newHeadRes = fastNewHead ? { ok: true, stdout: fastNewHead } : await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const newHeadSha = newHeadRes.ok ? newHeadRes.stdout.trim() : prevHeadSha

  let prBaseUpdate = null
  if (ledger.prNumber && targetBaseBranch !== oldBaseBranch && (originFull || opts._ghClient)) {
    prBaseUpdate = await backend.updatePrBase({ repo: originFull ?? 'local/mock', number: ledger.prNumber, base: targetBaseBranch })
  }

  let reviewSlotSync = null
  if (ledger.tier === 2 && newHeadSha && ledger.reviewWorktreePath) {
    const reviewAbs = resolve(roots.mainRoot, ledger.reviewWorktreePath)
    if (existsSync(reviewAbs)) {
      const revUm = unmountSharedDeps(roots.mainRoot, reviewAbs, { mode: 'deps' })
      if (!revUm?.ok) throw new Error(`sync 前解绑审查槽共享依赖失败：${JSON.stringify(revUm?.blocked ?? [])}`)
      reviewSlotSync = await syncDetachedWorktree(roots.mainRoot, reviewAbs, newHeadSha, { resetDirty: true })
      const revDeps = mountSharedDeps(roots.mainRoot, reviewAbs)
      recordMountedDepsInLedger(ledger, ledger.reviewWorktreePath, revDeps)
      ledger.reviewWorktreeHead = newHeadSha
      reviewSlotSync.depsMode = revDeps.mode
    }
  }

  const roundBaseSha = {
    prevBaseSha: oldBaseSha,
    prevHeadSha,
    newBaseSha,
    newHeadSha,
    prevBaseBranch: oldBaseBranch,
    newBaseBranch: targetBaseBranch,
  }
  ledger.syncCount = (Number(ledger.syncCount) || 0) + 1
  ledger.roundBaseSha = roundBaseSha
  ledger.lastSync = { ...roundBaseSha, syncedAt: new Date().toISOString() }
  ledger.baseBranch = targetBaseBranch
  ledger.baseSha = newBaseSha
  if (newHeadSha !== prevHeadSha) {
    ledger.verifiedHead = null
    ledger.reviewPassed = false
    ledger.reviewPassedHead = null
  }
  if (parentMerged) {
    ledger.parentTaskId = null
    ledger.parentBranch = null
    ledger.parentPrNumber = null
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const out = {
    ok: true,
    taskId,
    parentMerged,
    alreadyBasedOnTarget,
    syncCount: ledger.syncCount,
    roundBaseSha,
    baseBranch: ledger.baseBranch,
    baseSha: ledger.baseSha,
    headSha: newHeadSha,
    depsMode: depMount.mode,
    prBaseUpdate,
    reviewSlotSync,
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(`sync 完成（task=${taskId}, syncCount=${ledger.syncCount}, onto=${targetBaseBranch}@${newBaseSha.slice(0, 7)}, HEAD=${newHeadSha?.slice(0, 7)}）。\n`)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK, ...out }
}
