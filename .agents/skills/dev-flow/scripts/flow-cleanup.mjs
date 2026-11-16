/**
 * flow-cleanup.mjs —— cleanup（Squash/Rebase 四态）、status 与 abort。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 与 flow-merge.mjs 调度。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  canonicalPath, detectInProgressGitOp, gitRun, gitStatusPorcelainZ,
  inspectBranchMergeState, samePath,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { listTaskLedgers, resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeGitHubEnv,
} from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK } from './flow-inspect.mjs'
import { unmountSharedDeps } from './worktree-deps.mjs'

function isCwdInside(wtAbs) {
  const cwd = canonicalPath(process.cwd())
  const wt = canonicalPath(wtAbs)
  if (samePath(cwd, wt)) return true
  const rel = relative(wt, cwd)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export async function buildCleanupChecklist(mainRoot, ledger, remoteUrls, targetRepo, pushRemote = 'origin', {
  skipRemoteProbe = false, _ghProbe = null, _ghClient = null, gitDir = null, mergeStateOverride = null, knownCleanWorktrees = [],
} = {}) {
  const cleanWtSet = new Set(Array.isArray(knownCleanWorktrees) ? knownCleanWorktrees.filter(Boolean) : [])
  const worktreePaths = [ledger.reviewWorktreePath, ledger.worktreePath]
    .filter(Boolean)
    .map((relWt) => ({ relWt, abs: resolve(mainRoot, relWt) }))
    .filter((item) => existsSync(item.abs))

  const pushUrl = remoteUrls[pushRemote] ?? ''
  const isNetworkRemote = /^(?:https?:\/\/|ssh:\/\/|[^/@:\s]+@)/i.test(pushUrl)
  const shouldProbeRemote = Boolean(ledger.branch && pushUrl)
    && !(isNetworkRemote && (skipRemoteProbe || process.env.PF_NO_REAL_AUTH_PROBE === '1'))

  const effectiveGitDir = gitDir ?? resolveGitDirFast(mainRoot)
  const fastBranchSha = ledger.branch ? resolveRefShaFast(effectiveGitDir, `refs/heads/${ledger.branch}`) : null
  const [wtEntries, refRes, lsRes] = await Promise.all([
    Promise.all(worktreePaths.map(async ({ relWt, abs }) => {
      if (cleanWtSet.has(relWt)) return { path: relWt, abs, dirty: false }
      const stZ = await gitStatusPorcelainZ(abs)
      return { path: relWt, abs, dirty: stZ.entries.length > 0 }
    })),
    ledger.branch
      ? (fastBranchSha ? Promise.resolve({ ok: true }) : gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${ledger.branch}`]))
      : Promise.resolve({ ok: false }),
    shouldProbeRemote
      ? gitRun(mainRoot, ['ls-remote', '--heads', pushRemote, ledger.branch])
      : Promise.resolve({ ok: false, stdout: '' }),
  ])

  const worktrees = wtEntries
  const localBranchExists = Boolean(ledger.branch && refRes.ok)
  const mergeState = localBranchExists
    ? (mergeStateOverride ?? await inspectBranchMergeState(mainRoot, { branch: ledger.branch, defaultBranch: ledger.baseBranch || 'main', gitDir: effectiveGitDir }))
    : null
  const remoteBranchExists = Boolean(shouldProbeRemote && lsRes.ok && lsRes.stdout.trim() !== '')

  const needGhApi = Boolean(targetRepo && ledger.branch && ledger.role !== 'local-only' && ledger.role !== 'generic-git')
  const ghProbe = _ghProbe
    ?? (_ghClient ? { env: { providerId: 'github', trackB: { tier: _ghClient.tier ?? 'gh-cli' } }, client: _ghClient } : null)
    ?? (needGhApi ? await probeGitHubEnv({ cwd: mainRoot, remoteUrls }) : null)
  const ghClient = _ghClient ?? ghProbe?.client
  const backend = createTaskBackend({
    role: ledger.role,
    providerId: ledger.providerId,
    targetRepo,
    client: ghClient,
    pushRemote,
    mainRoot,
    gitDir,
  })
  const canQueryGh = Boolean(_ghProbe || _ghClient)
    || ghProbe?.env?.trackB?.tier === 'gh-cli'
    || ghProbe?.env?.trackB?.tier === 'node-https-token'
  const downstream = needGhApi && ghProbe?.env?.providerId === 'github' && typeof ghClient?.listOpenPrsByBase === 'function'
    ? await ghClient.listOpenPrsByBase(targetRepo, ledger.branch)
    : { ok: true, prs: [] }

  let prState = ledger.prState ?? (ledger.status === 'awaiting-upstream-merge' ? 'OPEN' : null)
  if (needGhApi && ledger.prNumber && canQueryGh) {
    const pr = await backend.getPr(targetRepo, ledger.prNumber)
    if (pr?.ok) prState = pr.state
  }

  return {
    taskId: ledger.taskId, role: ledger.role, worktrees,
    localBranch: localBranchExists ? ledger.branch : null, mergeState,
    remoteBranch: remoteBranchExists ? `${pushRemote}/${ledger.branch}` : null,
    pushRemote, downstreamStackedPrs: downstream.prs ?? [], prNumber: ledger.prNumber, prState,
  }
}

export function printCleanupChecklistText(cl) {
  process.stdout.write('\n待确认清理清单（未得人点头前严禁自动删除）：\n')
  process.stdout.write(`- Worktrees: ${cl.worktrees.length > 0 ? cl.worktrees.map((w) => `${w.path}${w.dirty ? ' [脏]' : ' [干净]'}`).join(', ') : '无'}\n`)
  process.stdout.write(`- 本地分支: ${cl.localBranch ?? '无'}${cl.mergeState ? ` (${cl.mergeState.state})` : ''}\n`)
  process.stdout.write(`- 远端分支: ${cl.remoteBranch ?? '无'}\n`)
  process.stdout.write(`- 下游堆叠 PR: ${cl.downstreamStackedPrs.length}\n`)
  if (cl.prNumber) process.stdout.write(`- 关联 PR #${cl.prNumber} 状态: ${cl.prState ?? '未知'}\n`)
}

export async function handleCleanup(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)
  const cl = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, targetRepo, pushRemote, {
    skipRemoteProbe: Boolean(opts._ghProbe || opts._ghClient),
    _ghProbe: opts._ghProbe,
    _ghClient: opts._ghClient,
    gitDir: roots.gitDir,
  })

  const keepWorktree = Boolean(opts['keep-worktree'])
  const onlyReviewWt = Boolean(opts['only-review-worktree'])
  const keepLocalBr = Boolean(opts['keep-branch'] || opts['keep-local-branch'] || keepWorktree || onlyReviewWt)
  const keepRemoteBr = Boolean(opts['keep-branch'] || opts['keep-remote-branch'])
  const worktreesToRemove = keepWorktree
    ? []
    : (onlyReviewWt ? cl.worktrees.filter((w) => w.path === ledger.reviewWorktreePath || w.path.includes('/review-')) : cl.worktrees)
  const keptWorktrees = cl.worktrees.filter((w) => !worktreesToRemove.includes(w)).map((w) => w.path)

  if (!opts.confirm) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_CONFIRMATION_REQUIRED', checklist: cl }, null, 2)}\n`)
    else {
      process.stdout.write('BLOCKED_CONFIRMATION_REQUIRED: 缺少 --confirm，已拒绝执行删除。\n')
      printCleanupChecklistText(cl)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (ledger.role === 'contributor-fork' && cl.prState === 'OPEN' && (!keepRemoteBr || !keepLocalBr)) {
    process.stderr.write(`BLOCKED_OPEN_FORK_PR: contributor-fork 关联上游 PR #${ledger.prNumber ?? '?'} 仍为 OPEN，硬锁拒绝删除 Fork 分支。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (cl.downstreamStackedPrs.length > 0 && (!keepRemoteBr || !keepLocalBr)) {
    process.stderr.write(`BLOCKED_STACKED_PR: 存在以 ${ledger.branch} 为 base 的下游开放 PR，拒绝删除分支。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  const dirtyWt = worktreesToRemove.find((w) => w.dirty)
  if (dirtyWt && !opts.force) {
    process.stderr.write(`BLOCKED_DIRTY_WORKTREE: 工作树 ${dirtyWt.path} 存在未提交改动，拒绝自动移除。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  if (cl.localBranch && !keepLocalBr) {
    const fastMainBranch = readHeadFast(resolveGitDirFast(roots.mainRoot), roots.gitDir)?.branch ?? null
    const curBr = fastMainBranch ? { ok: true, stdout: fastMainBranch } : await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (curBr.ok && curBr.stdout.trim() === cl.localBranch) {
      const sw = await gitRun(roots.mainRoot, ['switch', ledger.baseBranch || 'main'])
      if (!sw.ok) throw new Error(`切回默认分支失败：${sw.stderr}`)
    }
  }

  const removedWorktrees = []
  for (const wt of worktreesToRemove) {
    if (isCwdInside(wt.abs)) throw new Error(`当前进程工作目录位于待删除 worktree (${wt.path}) 内，请先切回主仓根目录再清理`)
    // 解绑在前、判断在后：有未获准的外链就整条停下，绝不带着链接去 `worktree remove --force`
    // （那一步会跟随 junction 递归删掉主仓里的目标内容，而退出码依然是 0）。
    const unmount = unmountSharedDeps(roots.mainRoot, wt.abs, { allowOutbound: opts['allow-outbound'] ?? [] })
    if (unmount.ok === false) {
      const lines = unmount.blocked.map((one) => `  - ${one.path} -> ${one.resolved ?? one.target}（${one.reason}）`)
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_OUTBOUND_LINKS', worktree: wt.path, blockedLinks: unmount.blocked }, null, 2)}\n`)
      } else {
        process.stderr.write(`BLOCKED_OUTBOUND_LINKS: worktree ${wt.path} 里有 ${unmount.blocked.length} 条指向外部的链接。\n`)
        for (const line of lines) process.stderr.write(`${line}\n`)
        process.stderr.write('`git worktree remove --force` 会跟随 junction 递归删除，删了主仓那些目标就没了。\n')
        process.stderr.write('确认可以切断后，用 --allow-outbound <路径> 逐个列出重跑；没有「全部放行」开关。\n')
      }
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const rmArgs = opts.force ? ['worktree', 'remove', '--force', wt.abs] : ['worktree', 'remove', wt.abs]
    const rmRes = await gitRun(roots.mainRoot, rmArgs)
    if (!rmRes.ok) throw new Error(`移除 worktree ${wt.path} 失败：${rmRes.stderr}`)
    removedWorktrees.push({ path: wt.path, unmountedDeps: unmount.unmounted.length })
  }

  let deletedLocalBranch = false
  if (cl.localBranch && !keepLocalBr && cl.localBranch !== ledger.baseBranch) {
    const isSquashOrRemoteMerged = cl.mergeState?.state === 'squash_or_rebase_merged' || cl.prState === 'MERGED'
    const delArgs = isSquashOrRemoteMerged ? ['branch', '-D', cl.localBranch] : ['branch', '-d', cl.localBranch]
    const delBr = await gitRun(roots.mainRoot, delArgs)
    if (!delBr.ok) throw new Error(`安全删除本地分支 ${cl.localBranch} 失败（state=${cl.mergeState?.state ?? 'unknown'}）：${delBr.stderr}`)
    deletedLocalBranch = true
  }

  let deletedRemoteBranch = false
  if (cl.remoteBranch && !keepRemoteBr && ledger.role !== 'local-only') {
    const delRemote = await gitRun(roots.mainRoot, ['push', cl.pushRemote, '--delete', ledger.branch])
    if (!delRemote.ok) throw new Error(`删除远端分支 ${cl.pushRemote}/${ledger.branch} 失败：${delRemote.stderr}`)
    deletedRemoteBranch = true
  }

  ledger.status = (keptWorktrees.length === 0 && !keepLocalBr && !keepRemoteBr) ? 'cleaned' : ledger.status
  ledger.cleanedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  const summary = { taskId, removedWorktrees, keptWorktrees, deletedLocalBranch, mergeState: cl.mergeState?.state ?? null, deletedRemoteBranch, status: ledger.status }
  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else {
    process.stdout.write(`清理完成（task=${taskId}）：移除 worktree ${removedWorktrees.length} 个（保留 ${keptWorktrees.length} 个），本地分支删除=${deletedLocalBranch}，远端分支删除=${deletedRemoteBranch}。\n`)
    printNextStep(['按确认范围完成清理；如需继续调整可带 --only-review-worktree / --keep-local-branch / --keep-remote-branch 重跑。'], { repoRoot: roots.mainRoot })
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
  const stZ = exists ? await gitStatusPorcelainZ(implRoot) : { entries: [] }
  const fastStatusHead = exists ? readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid : null
  const [op, headRes] = exists
    ? await Promise.all([
        detectInProgressGitOp(implRoot, { statusEntries: stZ.entries }),
        fastStatusHead ? Promise.resolve({ ok: true, stdout: fastStatusHead }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
      ])
    : [{ inProgress: false }, { ok: false, stdout: '' }]
  const head = headRes.ok ? headRes.stdout.trim() : null

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
    const unmount = unmountSharedDeps(roots.mainRoot, wt.abs, { allowOutbound: opts['allow-outbound'] ?? [] })
    if (unmount.ok === false) {
      process.stderr.write(`BLOCKED_OUTBOUND_LINKS: worktree ${wt.path} 里有 ${unmount.blocked.length} 条指向外部的链接，放弃任务同样不得连带删除主仓内容。\n`)
      for (const one of unmount.blocked) process.stderr.write(`  - ${one.path} -> ${one.resolved ?? one.target}（${one.reason}）\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const rmRes = await gitRun(roots.mainRoot, opts.force ? ['worktree', 'remove', '--force', wt.abs] : ['worktree', 'remove', wt.abs])
    if (!rmRes.ok) throw new Error(`移除 ${wt.path} 失败：${rmRes.stderr}`)
  }
  if (ledger.branch && !opts['keep-branch'] && ledger.branch !== ledger.baseBranch) {
    const fastAbrBr = readHeadFast(resolveGitDirFast(roots.mainRoot), roots.gitDir)?.branch ?? null
    const cur = fastAbrBr ? { ok: true, stdout: fastAbrBr } : await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
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
