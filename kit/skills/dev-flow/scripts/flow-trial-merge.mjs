/**
 * flow-trial-merge.mjs —— 在隔离的临时 `--detach` worktree 执行试合、挂载依赖与复测，
 * 成功后再推进干净 `mainRoot` 的基线分支，严禁直接在 `mainRoot` 运行 `git switch` / `git merge --no-ff`。
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { execShellCommand, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { sanitizeTaskId } from '../../lib/ledger.mjs'
import { isProfileExplicitNone } from '../../lib/profile.mjs'
import { runLowRiskDocStaticCheck } from '../../lib/workflow-policy.mjs'
import { mountSharedDeps, unmountSharedDeps } from './worktree-deps.mjs'

function pickTrialVerifyCommand({ policy, profile, evidence, ledger }) {
  if (policy?.riskTier === 'low') return null
  const tier = policy?.requiredGates?.[0] ?? null
  let cmd = null
  if (tier === 'gate' && profile?.mergeGate && !isProfileExplicitNone(profile, 'merge-gate')) cmd = profile.mergeGate
  else if (tier === 'full' && profile?.fullTest && !isProfileExplicitNone(profile, 'full-test')) cmd = profile.fullTest
  else if (tier === 'smoke' && profile?.smokeVerify && !isProfileExplicitNone(profile, 'smoke-verify')) cmd = profile.smokeVerify
  else if (tier === 'quick' && profile?.quickTest && !isProfileExplicitNone(profile, 'quick-test')) cmd = profile.quickTest

  if (!cmd && evidence?.gates && evidence.mode) {
    const g = evidence.gates[evidence.mode]
    if (g && g.exitCode === 0 && g.cmd && g.cmd !== 'none (explicitly disabled)') cmd = g.cmd
  }
  if (!cmd) return null
  if (cmd.includes('{target}')) {
    if (ledger?.verifiedTarget) {
      const safe = /\s/.test(ledger.verifiedTarget) ? `"${ledger.verifiedTarget}"` : ledger.verifiedTarget
      cmd = cmd.replace(/\{target\}/g, safe)
    } else if (tier === 'quick') {
      cmd = cmd.replace(/\s*(?:--[A-Za-z0-9_-]+(?:=|\s+)|-[A-Za-z]\s+)?\{target\}\s*/g, ' ').replace(/\s+/g, ' ').trim()
    } else {
      return null
    }
  }
  return cmd
}

/**
 * 执行临时 `--detach` worktree 试合复测并推进干净主干。
 */
export async function runTrialMerge({
  mainRoot,
  ledger,
  baseBranch = 'main',
  profile = null,
  evidence = null,
  policy = null,
  changedFiles = [],
  runVerify = true,
} = {}) {
  const mainSt = await gitStatusPorcelainZ(mainRoot)
  if (!mainSt.ok || mainSt.entries.length > 0) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_DIRTY_MAIN',
      exitCode: 3,
      message: 'BLOCKED_DIRTY_MAIN: 主工作区存在未提交改动，无法并入基线分支，请清理后再 merge。',
    }
  }

  const branch = ledger?.branch
  if (!branch) return { ok: true, localBranchMissing: true, into: baseBranch }
  const fastGitDir = resolveGitDirFast(mainRoot)
  const fastBranchSha = resolveRefShaFast(fastGitDir, `refs/heads/${branch}`)
  const brRes = fastBranchSha
    ? { ok: true, stdout: fastBranchSha }
    : await gitRun(mainRoot, ['rev-parse', '--verify', `refs/heads/${branch}`])
  if (!brRes.ok || !brRes.stdout.trim()) {
    throw new Error(`找不到本地待合并分支：${branch}`)
  }
  const branchSha = brRes.stdout.trim()

  const baseRefName = `refs/heads/${baseBranch}`
  const fastBaseSha = resolveRefShaFast(fastGitDir, baseRefName)
  const fastHead = readHeadFast(fastGitDir)
  const [baseRes, curMainRes] = await Promise.all([
    fastBaseSha ? Promise.resolve({ ok: true, stdout: fastBaseSha }) : gitRun(mainRoot, ['rev-parse', '--verify', '--quiet', baseRefName]),
    fastHead?.branch ? Promise.resolve({ ok: true, stdout: fastHead.branch }) : gitRun(mainRoot, ['symbolic-ref', '--short', 'HEAD']),
  ])
  const curMainBranch = curMainRes.ok ? curMainRes.stdout.trim() : ''

  if (!baseRes.ok) {
    if (curMainBranch === branch && baseBranch === branch) {
      return { ok: true, localBranchCurrent: true, branch, into: baseBranch, mergedSha: branchSha }
    }
    const up = await gitRun(mainRoot, ['update-ref', baseRefName, branchSha])
    if (!up.ok) throw new Error(`创建基线分支 ${baseBranch} 失败：${up.stderr}`)
    if (curMainBranch === baseBranch) {
      await gitRun(mainRoot, ['merge', '--ff-only', branchSha])
    }
    return { ok: true, localMerge: true, initialBranchCreated: true, branch, into: baseBranch, mergedSha: branchSha }
  }

  const oldBaseSha = baseRes.stdout.trim()
  const isAnc = await gitRun(mainRoot, ['merge-base', '--is-ancestor', branchSha, oldBaseSha])
  if (isAnc.ok) {
    return { ok: true, alreadyMerged: true, branch, into: baseBranch, mergedSha: oldBaseSha }
  }

  const safeId = sanitizeTaskId(ledger.taskId)
  const tmpRel = `.worktrees/.tmp-merge-${safeId}`
  const tmpAbs = join(mainRoot, tmpRel)
  if (existsSync(tmpAbs)) {
    try { unmountSharedDeps(mainRoot, tmpAbs) } catch { /* ignore */ }
    await gitRun(mainRoot, ['worktree', 'remove', '--force', tmpAbs])
    await gitRun(mainRoot, ['worktree', 'prune'])
    if (existsSync(tmpAbs)) {
      try { rmSync(tmpAbs, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  const addRes = await gitRun(mainRoot, ['worktree', 'add', '--detach', tmpAbs, oldBaseSha])
  if (!addRes.ok) throw new Error(`创建临时试合 worktree 失败：${addRes.stderr}`)

  let mergedSha = null
  try {
    const mRes = await gitRun(tmpAbs, ['merge', '--no-ff', branchSha, '-m', `Merge branch '${branch}' (${ledger.taskId})`])
    if (!mRes.ok) {
      await gitRun(tmpAbs, ['merge', '--abort'])
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_TRIAL_MERGE_CONFLICT',
        exitCode: 3,
        message: `BLOCKED_TRIAL_MERGE_CONFLICT: 临时试合 ${branch} 到 ${baseBranch} 存在冲突：${(mRes.stderr || mRes.stdout).trim()}`,
      }
    }
    const revRes = await gitRun(tmpAbs, ['rev-parse', 'HEAD'])
    mergedSha = revRes.stdout.trim()

    if (runVerify) {
      mountSharedDeps(mainRoot, tmpAbs)
      if (policy?.riskTier === 'low' && policy?.staticDocCheckRequired) {
        const docCheck = runLowRiskDocStaticCheck(tmpAbs, changedFiles)
        if (!docCheck.ok) {
          return {
            ok: false,
            blocked: true,
            code: 'BLOCKED_STATIC_DOC_CHECK_FAILED',
            exitCode: 3,
            message: `BLOCKED_STATIC_DOC_CHECK_FAILED: 试合后文档静态校验失败：${docCheck.errors.map((e) => e.message).slice(0, 3).join('；')}`,
          }
        }
      }
      const trialCmd = pickTrialVerifyCommand({ policy, profile, evidence, ledger })
      if (trialCmd) {
        const execRes = await execShellCommand(trialCmd, tmpAbs, { timeout: 300000 })
        if (!execRes.ok) {
          return {
            ok: false,
            blocked: true,
            code: 'BLOCKED_TRIAL_MERGE_VERIFY_FAILED',
            exitCode: 3,
            message: `BLOCKED_TRIAL_MERGE_VERIFY_FAILED: 临时试合后复测失败（cmd="${trialCmd}", exit=${execRes.code}）：${(execRes.stderr || execRes.stdout).trim().slice(0, 300)}`,
          }
        }
      }
    }
  } finally {
    try { unmountSharedDeps(mainRoot, tmpAbs) } catch { /* ignore */ }
    await gitRun(mainRoot, ['worktree', 'remove', '--force', tmpAbs])
  }

  if (curMainBranch === baseBranch) {
    const ffRes = await gitRun(mainRoot, ['merge', '--ff-only', mergedSha])
    if (!ffRes.ok) throw new Error(`试合通过但推进主干 ${baseBranch} (merge --ff-only) 失败：${ffRes.stderr}`)
  } else {
    const casRes = await gitRun(mainRoot, ['update-ref', baseRefName, mergedSha, oldBaseSha])
    if (!casRes.ok) throw new Error(`试合通过但 CAS 更新 ${baseRefName} 失败：${casRes.stderr}`)
  }

  return {
    ok: true,
    localMerge: true,
    trialMerged: true,
    branch,
    into: baseBranch,
    oldBaseSha,
    mergedSha,
  }
}
