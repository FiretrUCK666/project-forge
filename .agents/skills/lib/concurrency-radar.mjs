/**
 * concurrency-radar.mjs —— 多会话只读并发雷达与主干漂移交集唯一原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/，零循环导入 `SCC = 0`）。
 * 复用 `sandbox-scope.mjs` 的 `checkScopeListsOverlap` 与 `ledger.mjs` 的 `listTaskLedgers`，
 * 全部覆盖 5 类退化边界（unborn HEAD、无远端、空仓、detached HEAD、Windows `canonicalPath` 大小写）
 * 且 0 重叠静默并行、有重叠给出非阻断预警与 `--base` / `--write-scope` 指引。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildContextBrief, formatContextBriefLines } from './context-brief.mjs'
import { canonicalPath, gitRun, posixPath, samePath } from './git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast, resolveRefShaFast } from './git-fast.mjs'
import { listTaskLedgers } from './ledger.mjs'
import { checkScopeListsOverlap, normalizeWriteScope } from './sandbox-scope.mjs'
import { readAllActiveTopics, readPreInitState } from './session-state.mjs'

const DEFAULT_RADAR_MAX_BYTES = 1536

function collectLedgerScope(ledger) {
  const scopes = []
  if (Array.isArray(ledger?.writeScope)) scopes.push(...ledger.writeScope)
  if (Array.isArray(ledger?.implementers)) {
    for (const imp of ledger.implementers) {
      if (imp && Array.isArray(imp.writeScope)) scopes.push(...imp.writeScope)
    }
  }
  if (Array.isArray(ledger?.files)) scopes.push(...ledger.files)
  if (Array.isArray(ledger?.scopeFiles)) scopes.push(...ledger.scopeFiles)
  return normalizeWriteScope(scopes)
}

function resolveGitProbeSummary(mainRoot) {
  const out = {
    isGit: false,
    gitDir: null,
    unbornHead: false,
    detachedHead: false,
    hasRemote: false,
    headSha: null,
    branch: null,
    degradedReasons: [],
  }
  try {
    const gitDir = resolveGitDirFast(mainRoot)
    if (!gitDir) {
      out.degradedReasons.push('not-git-repo')
      return out
    }
    out.isGit = true
    out.gitDir = gitDir
    const head = readHeadFast(gitDir, gitDir)
    if (!head || !head.oid) {
      out.unbornHead = true
      out.branch = head?.branch ?? null
      out.degradedReasons.push('unborn-head')
    } else {
      out.headSha = head.oid
      out.detachedHead = Boolean(head.detached)
      out.branch = head.detached ? null : head.branch
      if (out.detachedHead) out.degradedReasons.push('detached-head')
    }
    const cfg = readGitConfigFast(gitDir, { systemMap: false })
    out.hasRemote = Boolean(cfg?.remoteText && cfg.remoteText.trim().length > 0)
    if (!out.hasRemote) out.degradedReasons.push('no-remote')
  } catch {
    out.degradedReasons.push('git-probe-error')
  }
  return out
}

function resolveMainHeadShaFast(gitDir, baseBranch) {
  if (!gitDir || !baseBranch) return null
  return resolveRefShaFast(gitDir, `refs/heads/${baseBranch}`)
    ?? resolveRefShaFast(gitDir, `refs/remotes/origin/${baseBranch}`)
    ?? null
}

/**
 * 只读并发雷达主原语（同步、零写入、Fail-Soft）。
 * 识别其他活跃工作树/账本任务与当前任务/改动写域的重叠及活跃主题清单。
 */
export function projectConcurrencyRadar(mainRoot, {
  currentTaskId = null,
  currentWorkRoot = null,
  currentFiles = [],
  currentWriteScope = [],
  baseBranch = null,
  baseSha = null,
} = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const curWork = currentWorkRoot ? resolve(String(currentWorkRoot)) : null
  const curWorkCanon = curWork ? canonicalPath(curWork) : null
  const gitInfo = resolveGitProbeSummary(effMain)

  let allLedgers = []
  try {
    allLedgers = listTaskLedgers(effMain, { includeTerminal: false }) ?? []
  } catch {
    allLedgers = []
    gitInfo.degradedReasons.push('ledger-read-error')
  }

  let activeTopics = []
  try {
    activeTopics = (readAllActiveTopics(effMain) ?? []).map((t) => ({
      topicId: t.topicId,
      topic: t.topic ?? t.topicId,
      decisionsCount: (t.decisions ?? []).length,
      deadEndsCount: (t.deadEnds ?? []).length,
      openCount: (t.unresolvedOpen ?? t.openQuestions ?? []).length,
    }))
  } catch {
    activeTopics = []
  }

  const currentScope = normalizeWriteScope([...(currentWriteScope ?? []), ...(currentFiles ?? [])])
  const siblings = []
  const overlaps = []
  const warnings = []

  for (const ldg of allLedgers) {
    if (!ldg || typeof ldg !== 'object' || !ldg.taskId) continue
    if (currentTaskId && String(ldg.taskId) === String(currentTaskId)) continue
    const sibAbs = ldg.worktreePath ? resolve(effMain, ldg.worktreePath) : null
    if (curWorkCanon && sibAbs && samePath(curWorkCanon, sibAbs)) continue

    const sibScope = collectLedgerScope(ldg)
    const entry = {
      taskId: ldg.taskId,
      status: ldg.status ?? 'unknown',
      branch: ldg.branch ?? null,
      worktreePath: ldg.worktreePath ? posixPath(ldg.worktreePath) : null,
      worktreeExists: sibAbs ? existsSync(sibAbs) : false,
      writeScope: sibScope,
      sandboxMode: Boolean(ldg.sandboxMode),
    }
    siblings.push(entry)

    if (currentScope.length > 0 && sibScope.length > 0) {
      const ov = checkScopeListsOverlap(currentScope, sibScope)
      if (ov.overlap) {
        const hit = {
          siblingTaskId: ldg.taskId,
          siblingBranch: ldg.branch ?? null,
          siblingWorktree: entry.worktreePath,
          conflicts: ov.conflicts,
        }
        overlaps.push(hit)
        const pairDesc = ov.conflicts.slice(0, 3).map((c) => `${c.a}<->${c.b}`).join('、')
        const hint = ldg.branch
          ? `建议基于其分支堆叠（--base ${ldg.branch}）或拆开 --write-scope`
          : '建议错开 --write-scope 或串行合入'
        warnings.push({
          code: 'WARN_CONCURRENT_SCOPE_OVERLAP',
          siblingTaskId: ldg.taskId,
          message: `并发雷达提醒：与活跃兄弟任务 ${ldg.taskId}（${ldg.status ?? 'active'}）存在写域重叠（${pairDesc}）；${hint}。`,
        })
      }
    }
  }

  let mainDrift = null
  if (gitInfo.isGit && !gitInfo.unbornHead && baseBranch && baseSha) {
    const mainHeadSha = resolveMainHeadShaFast(gitInfo.gitDir, baseBranch)
    const drifted = Boolean(mainHeadSha && mainHeadSha !== baseSha)
    mainDrift = {
      baseBranch,
      baseSha,
      mainHeadSha,
      drifted,
      overlappingFiles: [],
    }
  }

  return {
    ok: true,
    isGit: gitInfo.isGit,
    unbornHead: gitInfo.unbornHead,
    detachedHead: gitInfo.detachedHead,
    hasRemote: gitInfo.hasRemote,
    degraded: gitInfo.degradedReasons.length > 0,
    degradedReasons: gitInfo.degradedReasons,
    siblingCount: siblings.length,
    siblings,
    activeTopicsCount: activeTopics.length,
    activeTopics,
    hasOverlap: overlaps.length > 0,
    overlaps,
    mainDrift,
    warnings,
  }
}

/**
 * 异步计算主干漂移交集（用于 `verify`/`submit` 阶段检测基线以来默认分支改动与本分支改动的文件交集）。
 * 严格 Fail-Soft，遇 unborn HEAD / 无远端 / 空仓 / detached HEAD / 无基线时安全返回零交集不抛错。
 */
export async function computeMainDriftIntersection({
  mainRoot,
  workRoot = mainRoot,
  baseBranch = null,
  baseSha = null,
  changedFiles = [],
} = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const effWork = resolve(String(workRoot || effMain))
  const empty = {
    baseBranch: baseBranch ?? null,
    baseSha: baseSha ?? null,
    mainHeadSha: null,
    drifted: false,
    mainChangedFiles: [],
    overlappingFiles: [],
    warning: null,
    degradedReason: null,
  }
  const gitInfo = resolveGitProbeSummary(effMain)
  if (!gitInfo.isGit) return { ...empty, degradedReason: 'not-git-repo' }
  if (gitInfo.unbornHead) return { ...empty, degradedReason: 'unborn-head' }
  const targetBranch = String(baseBranch ?? '').trim()
  if (!targetBranch || !baseSha) return { ...empty, degradedReason: 'missing-base-ref' }

  const mainHeadSha = resolveMainHeadShaFast(gitInfo.gitDir, targetBranch)
  if (!mainHeadSha) return { ...empty, degradedReason: 'base-branch-not-found' }
  if (mainHeadSha === baseSha) {
    return { ...empty, mainHeadSha, drifted: false }
  }

  try {
    const diffRes = await gitRun(effWork, ['--no-optional-locks', 'diff', '--name-only', `${baseSha}..${mainHeadSha}`])
    if (!diffRes.ok) return { ...empty, mainHeadSha, drifted: true, degradedReason: 'git-diff-unavailable' }
    const mainChangedFiles = diffRes.stdout
      .split(/\r?\n/)
      .map((s) => posixPath(s.trim()))
      .filter(Boolean)
    const curSet = new Set((changedFiles ?? []).map((f) => posixPath(String(f ?? '').trim())).filter(Boolean))
    const overlappingFiles = mainChangedFiles.filter((f) => curSet.has(f))
    const warning = overlappingFiles.length > 0
      ? {
          code: 'WARN_MAIN_DRIFT_OVERLAP',
          overlappingFiles,
          message: `主干漂移预警：基线 ${targetBranch} 已前进至 ${mainHeadSha.slice(0, 7)} 且与本任务改动存在 ${overlappingFiles.length} 个重叠文件（${overlappingFiles.slice(0, 5).join(', ')}）；建议合并前同步基线防冲突。`,
        }
      : null
    return {
      baseBranch: targetBranch,
      baseSha,
      mainHeadSha,
      drifted: true,
      mainChangedFiles,
      overlappingFiles,
      warning,
      degradedReason: null,
    }
  } catch {
    return { ...empty, mainHeadSha, drifted: true, degradedReason: 'git-diff-error' }
  }
}

/** 格式化并发雷达紧凑提示行（0 兄弟且无漂移预警时返回空数组，静默不打扰；超预算按字节裁剪）。 */
export function formatConcurrencyRadarLines(radar, { maxBytes = DEFAULT_RADAR_MAX_BYTES } = {}) {
  if (!radar || typeof radar !== 'object') return []
  const lines = []
  const siblings = Array.isArray(radar.siblings) ? radar.siblings : []
  const warnings = Array.isArray(radar.warnings) ? radar.warnings : []
  const driftOverlaps = Array.isArray(radar.mainDrift?.overlappingFiles) ? radar.mainDrift.overlappingFiles : []
  if (siblings.length === 0 && warnings.length === 0 && driftOverlaps.length === 0) return []

  if (siblings.length > 0) {
    const desc = siblings
      .slice(0, 6)
      .map((s) => `${s.taskId}(${s.status}${s.branch ? `, ${s.branch}` : ''})`)
      .join('、')
    lines.push(`- 兄弟活跃任务（${siblings.length}）：${desc}${siblings.length > 6 ? ' 等' : ''}`)
  }
  for (const w of warnings.slice(0, 5)) {
    lines.push(`- [并发预警] ${w.message}`)
  }
  if (driftOverlaps.length > 0) {
    lines.push(`- [主干漂移] 与 ${radar.mainDrift.baseBranch} 重叠文件（${driftOverlaps.length}）：${driftOverlaps.slice(0, 5).join(', ')}`)
  }

  while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) {
    lines.pop()
  }
  return lines
}

/** 改前统一装配 contextBrief + concurrencyRadar + 活跃 topic 投影（供 edit-gate --pre-edit 复用）。 */
export function buildPreEditEnrichment({ workTreeRoot, mainRoot, checkedFiles = [], taskId = null, taskLedger = null, isWorktree = false } = {}) {
  const contextBrief = buildContextBrief(workTreeRoot, {
    paths: checkedFiles,
    keywords: taskLedger ? [taskLedger.taskId, taskLedger.slug].filter(Boolean) : [],
    excludeFiles: ['AGENTS.md'],
    limit: 3,
    budgetLines: 32,
    role: 'implementer',
  })
  const concurrencyRadar = projectConcurrencyRadar(mainRoot, {
    currentTaskId: taskId ?? taskLedger?.taskId ?? null,
    currentWorkRoot: workTreeRoot,
    currentFiles: checkedFiles,
    baseBranch: taskLedger?.baseBranch ?? null,
    baseSha: taskLedger?.baseSha ?? null,
  })
  const preTopic = readPreInitState(mainRoot, {
    taskId: taskId ?? taskLedger?.taskId ?? null,
    slug: taskLedger?.slug ?? null,
    branch: taskLedger?.branch ?? null,
    worktreePath: taskLedger?.worktreePath ?? (isWorktree ? workTreeRoot : null),
  })
  const activeTopic = preTopic ? { topicId: preTopic.topicId, decisions: preTopic.decisions ?? [], deadEnds: preTopic.deadEnds ?? [] } : null
  return { contextBrief, concurrencyRadar, activeTopic }
}

/** 格式化改前附加上下文行（并发雷达 + 常青简报 + 活跃 topic 决策与死路）。 */
export function formatPreEditEnrichmentLines(res = {}) {
  const out = []
  const radarLines = formatConcurrencyRadarLines(res.concurrencyRadar)
  if (radarLines.length > 0) out.push('', '--- Concurrency Radar ---', ...radarLines)
  const briefLines = formatContextBriefLines(res.contextBrief)
  if (briefLines.length > 0) out.push('', ...briefLines)
  if (res.activeTopic && ((res.activeTopic.decisions?.length ?? 0) > 0 || (res.activeTopic.deadEnds?.length ?? 0) > 0)) {
    out.push('', `--- Active Topic (${res.activeTopic.topicId}) ---`)
    for (const d of res.activeTopic.decisions ?? []) out.push(`  - 决策: ${d}`)
    for (const e of res.activeTopic.deadEnds ?? []) out.push(`  - 死路: ${e}`)
  }
  return out
}
