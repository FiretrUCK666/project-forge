/**
 * gate-enforcement.mjs —— 门禁强执行默认开关、cleanup 预览哈希锁、安全删分支守卫与真实代码故障注入校验。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/）。
 */

import { createHash } from 'node:crypto'

import { EXIT } from './exit-codes.mjs'
import { gitRun, inspectBranchMergeState, posixPath, resolveDefaultBranch } from './git.mjs'

export const DEFAULT_ENFORCE_GATES = true

/** 计算 cleanup 待删清单的稳定预览指纹（防止预览后未确认直接换目标删除）。 */
export function computeCleanupPreviewHash({ taskId = '', worktrees = [], localBranch = null, remoteBranch = null } = {}) {
  const payload = {
    taskId: String(taskId ?? '').trim(),
    worktrees: [...new Set((Array.isArray(worktrees) ? worktrees : []).map((w) => posixPath(String(w?.path ?? w ?? '')).trim()).filter(Boolean))].sort(),
    localBranch: localBranch ? String(localBranch).trim() : null,
    remoteBranch: remoteBranch ? String(remoteBranch).trim() : null,
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 16)
}

export function verifyCleanupPreviewHash(expectedHash, providedHash) {
  const exp = String(expectedHash ?? '').trim()
  const got = String(providedHash ?? '').trim()
  if (!got) {
    return {
      ok: false,
      code: 'BLOCKED_CLEANUP_PREVIEW_MISMATCH',
      exitCode: EXIT.FACT,
      reason: `BLOCKED_CLEANUP_PREVIEW_MISMATCH: cleanup --confirm 需要传 --preview-hash ${exp} 确认待删清单未漂移。`,
    }
  }
  if (exp !== got) {
    return {
      ok: false,
      code: 'BLOCKED_CLEANUP_PREVIEW_MISMATCH',
      exitCode: EXIT.FACT,
      reason: `BLOCKED_CLEANUP_PREVIEW_MISMATCH: 传入 --preview-hash (${got}) 与当前待删清单指纹 (${exp}) 不匹配，请先重跑 cleanup 预览。`,
    }
  }
  return { ok: true }
}

/** 复用 ancestry + git cherry + 远端已合入态校验，阻止未合分支被盲目 `-D` 误删。 */
export async function isSafeBranchDelete(mainRoot, branch, baseBranch = null, {
  remoteBranchMerged = false,
  mergeState = null,
} = {}) {
  const targetBr = String(branch ?? '').trim()
  if (!targetBr) return { safe: false, code: 'BLOCKED_UNMERGED_BRANCH_DELETE', exitCode: EXIT.FACT, reason: '缺少待删除分支名' }

  if (remoteBranchMerged || mergeState?.state === 'squash_or_rebase_merged') {
    return { safe: true, method: 'squash-or-remote-merged', deleteFlag: '-D' }
  }

  const targetBase = String(baseBranch ?? '').trim() || await resolveDefaultBranch(mainRoot, { strict: true })
  if (!targetBase) {
    return {
      safe: false,
      code: 'BLOCKED_MISSING_DEFAULT_BRANCH',
      exitCode: EXIT.FACT,
      reason: `BLOCKED_MISSING_DEFAULT_BRANCH: 无法解析仓库默认分支，拒绝盲目删除分支 ${targetBr}。`,
    }
  }

  const state = mergeState ?? (await inspectBranchMergeState(mainRoot, { branch: targetBr, defaultBranch: targetBase }))
  if (state?.state === 'merged' || state?.state === 'merged_in_git' || state?.state === 'squash_or_rebase_merged') {
    return { safe: true, method: state.state, deleteFlag: state.state === 'squash_or_rebase_merged' ? '-D' : '-d', state }
  }

  const cherry = await gitRun(mainRoot, ['cherry', targetBase, targetBr])
  if (cherry.ok) {
    const unmergedLines = String(cherry.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('+ '))
    if (unmergedLines.length === 0) {
      return { safe: true, method: 'cherry-empty', deleteFlag: '-d', state }
    }
  }

  return {
    safe: false,
    code: 'BLOCKED_UNMERGED_BRANCH_DELETE',
    exitCode: EXIT.FACT,
    state,
    reason: `BLOCKED_UNMERGED_BRANCH_DELETE: 分支 ${targetBr} 仍有未合入 ${targetBase} 的提交（state=${state?.state ?? 'unmerged'}），拒绝强制删除；如为 Squash/Rebase 已合单请确认远端 state=MERGED。`,
  }
}

/**
 * 校验故障注入工作区变更包含真实可执行代码改动（拦截仅改注释、空行或纯说明文件的空故障）。
 */
export function hasExecutableCodeMutation(diffText = '', untrackedCodeFiles = []) {
  if (Array.isArray(untrackedCodeFiles) && untrackedCodeFiles.length > 0) {
    return { hasMutation: true, changedCodeLines: untrackedCodeFiles.length }
  }
  const lines = String(diffText ?? '').replace(/\r\n/g, '\n').split('\n')
  let changedCodeLines = 0
  let inBlockComment = false
  for (const line of lines) {
    if (!line || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue
    }
    if (line[0] !== '+' && line[0] !== '-') continue
    let body = line.slice(1).trim()
    if (!body) continue
    if (inBlockComment) {
      const endIdx = body.indexOf('*/')
      if (endIdx < 0) continue
      inBlockComment = false
      body = body.slice(endIdx + 2).trim()
      if (!body) continue
    }
    if (/^(?:\/\/|#(?!!)|<!--|\*\/?)/.test(body)) {
      if (body.startsWith('/*') && !body.includes('*/')) inBlockComment = true
      continue
    }
    if (body.startsWith('/*')) {
      const endIdx = body.indexOf('*/')
      if (endIdx < 0) { inBlockComment = true; continue }
      body = body.slice(endIdx + 2).trim()
      if (!body) continue
    }
    body = body.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!body) continue
    changedCodeLines += 1
  }
  return { hasMutation: changedCodeLines > 0, changedCodeLines }
}
