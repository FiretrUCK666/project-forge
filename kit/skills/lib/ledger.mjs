/**
 * ledger.mjs —— 任务账本统一原子读写、并发安全落盘与零记忆上下文自动推断。
 *
 * 账本统一存于主仓 `<mainRoot>/.worktrees/.state/tasks/<taskId>.json`，
 * 支持显式 `--task` -> CWD worktree -> 当前分支 -> `--pr`/`--issue` -> 唯一未闭环任务推断。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  canonicalPath, gitRun, posixPath, readJsonSafe, samePath, writeJsonAtomic,
} from './git.mjs'

const TERMINAL_TASK_STATUSES = new Set(['cleaned', 'aborted'])
const OPEN_TASK_STATUSES = new Set(['planned', 'started', 'claimed', 'released', 'finalized', 'verified', 'verify-failed', 'submitted', 'rework', 'review-ready', 'awaiting-upstream-merge', 'local-ready'])

/** 校验并清洗 taskId，兼容 ASCII 与中文字符，防止路径穿越。 */
export function sanitizeTaskId(taskId) {
  const raw = String(taskId ?? '').trim().normalize('NFC')
  if (!raw || raw.includes('..') || /[/\\:\0\s]/.test(raw) || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,80}$/u.test(raw)) {
    throw new Error(`非法的 taskId：「${raw}」（仅允许字母/中文/数字、点、下划线、连字符）`)
  }
  return raw
}

function defaultSlug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task'
}

/** 返回任务账本绝对路径：.worktrees/.state/tasks/<taskId>.json */
export function taskLedgerPath(mainRoot, taskId) {
  return join(mainRoot, '.worktrees', '.state', 'tasks', `${sanitizeTaskId(taskId)}.json`)
}

/** 构建符合跨模块统一契约的默认任务账本结构。 */
export function createDefaultLedger(partial = {}) {
  const taskId = sanitizeTaskId(partial.taskId)
  return {
    taskId,
    slug: partial.slug ?? defaultSlug(taskId),
    caseType: partial.caseType ?? 3,
    tier: partial.tier ?? 2,
    isolation: partial.isolation ?? 'worktree',
    role: partial.role ?? 'local-only',
    providerId: partial.providerId ?? 'github',
    branch: partial.branch ?? null,
    baseBranch: partial.baseBranch ?? 'main',
    baseSha: partial.baseSha ?? null,
    worktreePath: partial.worktreePath ?? null,
    reviewWorktreePath: partial.reviewWorktreePath ?? null,
    reviewWorktreeHead: partial.reviewWorktreeHead ?? null,
    todoFile: partial.todoFile ?? null,
    specFile: partial.specFile ?? null,
    prdFile: partial.prdFile ?? null,
    archivedTodoFile: partial.archivedTodoFile ?? null,
    archivedSpecFile: partial.archivedSpecFile ?? null,
    archivedPrdFile: partial.archivedPrdFile ?? null,
    privateDocsDir: partial.privateDocsDir ?? null,
    linkedIssues: Array.isArray(partial.linkedIssues) ? partial.linkedIssues : [],
    prNumber: partial.prNumber ?? null,
    prState: partial.prState ?? null,
    prUrl: partial.prUrl ?? null,
    finalized: Boolean(partial.finalized),
    finalizedHead: partial.finalizedHead ?? null,
    verifiedHead: partial.verifiedHead ?? null,
    verifiedCmd: partial.verifiedCmd ?? null,
    verifiedMode: partial.verifiedMode ?? null,
    verifiedTarget: partial.verifiedTarget ?? null,
    verifiedDirtyHash: partial.verifiedDirtyHash ?? null,
    lastVerifyExitCode: partial.lastVerifyExitCode ?? null,
    visualFilesChanged: Array.isArray(partial.visualFilesChanged) ? partial.visualFilesChanged : [],
    empiricalVisualCheckRequired: Boolean(partial.empiricalVisualCheckRequired),
    visualVerifiedHead: partial.visualVerifiedHead ?? null,
    visualCheckEvidence: partial.visualCheckEvidence ?? null,
    implementerId: partial.implementerId ?? null,
    reviewerId: partial.reviewerId ?? null,
    rounds: Array.isArray(partial.rounds) ? partial.rounds : [],
    lastReview: partial.lastReview ?? null,
    reviewPassed: Boolean(partial.reviewPassed),
    reviewPassedHead: partial.reviewPassedHead ?? null,
    humanApprovedStopLoss: Boolean(partial.humanApprovedStopLoss),
    humanApprovedReason: partial.humanApprovedReason ?? null,
    rebuts: Array.isArray(partial.rebuts) ? partial.rebuts : [],
    status: partial.status ?? 'started',
    ...partial,
    taskId,
  }
}

export function readTaskLedger(mainRoot, taskId) {
  return readJsonSafe(taskLedgerPath(mainRoot, taskId))
}

export function writeTaskLedger(mainRoot, ledger) {
  const p = taskLedgerPath(mainRoot, ledger.taskId)
  const stamped = {
    ...createDefaultLedger(ledger),
    updatedAt: new Date().toISOString(),
  }
  if (!stamped.createdAt) stamped.createdAt = stamped.updatedAt
  writeJsonAtomic(p, stamped)
  return p
}

/** 原子读取、转换并写回任务账本（防止直接裸写丢失契约默认值）。 */
export async function updateTaskLedger(mainRoot, taskId, updater, { createIfMissing = false, defaults = {} } = {}) {
  const id = sanitizeTaskId(taskId)
  const existing = readTaskLedger(mainRoot, id)
  if (!existing && !createIfMissing) {
    throw new Error(`找不到任务账本：${id}（请先运行 flow.mjs start --task ${id}）`)
  }
  const base = existing ? createDefaultLedger(existing) : createDefaultLedger({ ...defaults, taskId: id })
  const next = typeof updater === 'function' ? await updater(structuredClone(base)) : { ...base, ...updater }
  const merged = createDefaultLedger({ ...base, ...(next ?? {}), taskId: id })
  const path = writeTaskLedger(mainRoot, merged)
  return { ledger: readTaskLedger(mainRoot, id) ?? merged, path }
}

export function listTaskLedgers(mainRoot, { includeTerminal = true } = {}) {
  const dir = join(mainRoot, '.worktrees', '.state', 'tasks')
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue
      const data = readJsonSafe(join(dir, name))
      if (!data || !data.taskId) continue
      if (!includeTerminal && TERMINAL_TASK_STATUSES.has(String(data.status ?? '').toLowerCase())) continue
      out.push(data)
    }
  } catch { /* 忽略不可读条目 */ }
  return out
}

/**
 * 零记忆任务上下文自动推断：
 *   1. 显式 `opts.task`；
 *   2. 当前 CWD 所在 worktree（匹配 `worktreePath` / `reviewWorktreePath` 或 `.worktrees/(impl|review)-<id>`）；
 *   3. 当前 Git 分支匹配活跃账本 `branch`；
 *   4. `--pr <M>` 或 `--issue <N>` 匹配活跃账本；
 *   5. 全仓仅存在 1 个未闭环任务时自动命中。
 */
export async function resolveTaskContext(roots, opts = {}, { requireExisting = true } = {}) {
  const mainRoot = roots?.mainRoot ?? process.cwd()
  const workRoot = roots?.workTreeRoot ?? mainRoot
  const all = listTaskLedgers(mainRoot, { includeTerminal: true })
  const active = all.filter((t) => !TERMINAL_TASK_STATUSES.has(String(t.status ?? '').toLowerCase()))

  if (opts.task !== undefined && String(opts.task).trim() !== '') {
    const taskId = sanitizeTaskId(opts.task)
    const ledger = readTaskLedger(mainRoot, taskId)
    if (!ledger && requireExisting) {
      const hint = active.length > 0
        ? `当前未闭环任务：${active.map((t) => t.taskId).join(', ')}`
        : '当前无任何任务账本，请先运行 flow.mjs start'
      throw new Error(`找不到任务账本：${taskId}（${hint}）`)
    }
    return { taskId, ledger: ledger ?? null, source: 'explicit', activeTasks: active }
  }

  // 2. CWD worktree match
  if (roots?.isWorktree || posixPath(workRoot).includes('/.worktrees/')) {
    const wtMatch = active.find((t) =>
      (t.worktreePath && samePath(workRoot, join(mainRoot, t.worktreePath)))
      || (t.reviewWorktreePath && samePath(workRoot, join(mainRoot, t.reviewWorktreePath))))
    if (wtMatch) {
      return { taskId: wtMatch.taskId, ledger: wtMatch, source: 'worktree', activeTasks: active }
    }
    const baseMatch = /^(?:impl|review)-(.+)$/.exec(basename(canonicalPath(workRoot)))
    if (baseMatch) {
      const cand = readTaskLedger(mainRoot, baseMatch[1])
      if (cand) return { taskId: cand.taskId, ledger: cand, source: 'worktree-dirname', activeTasks: active }
    }
  }

  // 3. Current branch match
  if (roots?.isGit) {
    const brRes = await gitRun(workRoot, ['symbolic-ref', '--short', 'HEAD'])
    const curBranch = brRes.ok ? brRes.stdout.trim() : ''
    if (curBranch) {
      const brMatches = active.filter((t) => t.branch === curBranch)
      if (brMatches.length === 1) {
        return { taskId: brMatches[0].taskId, ledger: brMatches[0], source: 'branch', activeTasks: active }
      }
    }
  }

  // 4. --pr or --issue match
  if (opts.pr !== undefined && String(opts.pr).trim() !== '') {
    const prNum = Number(String(opts.pr).replace(/^#/, '').trim())
    const prMatch = active.find((t) => Number(t.prNumber) === prNum)
    if (prMatch) return { taskId: prMatch.taskId, ledger: prMatch, source: 'pr', activeTasks: active }
  }
  if (opts.issue !== undefined && String(opts.issue).trim() !== '') {
    const issNum = Number(String(opts.issue).replace(/^#/, '').trim())
    const issMatches = active.filter((t) => Array.isArray(t.linkedIssues) && t.linkedIssues.includes(issNum))
    if (issMatches.length === 1) {
      return { taskId: issMatches[0].taskId, ledger: issMatches[0], source: 'issue', activeTasks: active }
    }
  }

  // 5. Sole open/unclosed task
  const openTasks = active.filter((t) => OPEN_TASK_STATUSES.has(String(t.status ?? '').toLowerCase()))
  if (openTasks.length === 1) {
    return { taskId: openTasks[0].taskId, ledger: openTasks[0], source: 'sole-open', activeTasks: active }
  }
  if (active.length === 1) {
    return { taskId: active[0].taskId, ledger: active[0], source: 'sole-active', activeTasks: active }
  }

  if (active.length === 0) {
    throw new Error('未检测到活跃任务且未传 --task <id>；请先运行 `flow.mjs start --task <id> --slug <slug>` 创建任务。')
  }
  const choices = active.map((t) => `  - --task ${t.taskId} (status=${t.status}, branch=${t.branch ?? '-'})`).join('\n')
  throw new Error(`存在 ${active.length} 个未闭环任务，无法自动消歧，请显式追加以下任一参数：\n${choices}`)
}
