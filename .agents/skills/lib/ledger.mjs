/**
 * ledger.mjs —— 任务账本统一原子读写、并发安全落盘与零记忆上下文自动推断。
 *
 * 账本统一存于主仓 `<mainRoot>/.worktrees/.state/tasks/<taskId>.json`，
 * 支持显式 `--task` -> CWD worktree -> 当前分支 -> `--pr`/`--issue` -> 唯一未闭环任务推断。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  canonicalPath, gitRun, posixPath, readJsonSafe, readTextSafe, resolveRepoRoots, samePath, withFileLock, withFileLockSync, writeJsonAtomic,
} from './git.mjs'
import { hasDotGitInAncestors, readHeadFast, resolveGitDirFast } from './git-fast.mjs'
import { parseIssueNumbers, parsePrNumber } from './github-client.mjs'

const TERMINAL_TASK_STATUSES = new Set(['cleaned', 'aborted'])
const OPEN_TASK_STATUSES = new Set(['planned', 'started', 'claimed', 'released', 'finalized', 'verified', 'verify-failed', 'submitted', 'rework', 'review-ready', 'awaiting-upstream-merge', 'local-ready'])

/**
 * 发一枚独立审查令牌。**只由 `flow next` 在 `needs-review` 阶段调用。**
 *
 * 令牌的形状刻意不透明（前缀 `pf-rv-` 便于在日志里认出来，其余是随机字节），
 * 它不承载任何可推导的信息：能推导的东西就等于能自己造。
 */
export function issueReviewToken(round) {
  const bytes = randomBytes(18)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { token: `pf-rv-${hex}`, round: Number(round) || 1, issuedAt: new Date().toISOString(), consumedAt: null }
}

/**
 * 取这一轮的一次性审查令牌：有未消费的就复用，没有就发一枚并写回账本。
 *
 * 只有 `flow next` 在待审查阶段调用它——**签发点唯一**，否则调用方各发各的，
 * 令牌就不再是「现场签发的那个东西」。
 *
 * 复用而不是每次新发：`flow next` 可能被连跑好几次（人看状态、脚本问路），
 * 每次新发一枚会让前一枚作废，而调用方手里拿的很可能是前一枚。
 *
 * @returns {{ token: string, entry: object, issued: boolean }}
 */
export function ensureReviewToken(mainRoot, ledger, round) {
  const list = Array.isArray(ledger?.reviewTokens) ? ledger.reviewTokens : []
  const existing = list.find((t) => t && Number(t.round) === Number(round) && !t.consumedAt)
  if (existing) return { token: existing.token, entry: existing, issued: false }
  const entry = issueReviewToken(round)
  ledger.reviewTokens = [...list, entry]
  writeTaskLedger(mainRoot, ledger)
  return { token: entry.token, entry, issued: true }
}

/**
 * 消费一枚令牌。成功返回 `{ ok: true }`，失败返回原因。
 *
 * 三条都要满足：令牌存在、round 对得上、未被消费过。少判一条就等于没有令牌——
 * 复用旧令牌、或拿 Round 1 的令牌记 Round 3，都会让「独立审查」这个说法失效。
 */
export function consumeReviewToken(ledger, token, round) {
  const value = String(token ?? '').trim()
  if (!value) return { ok: false, reason: 'MISSING_REVIEW_TOKEN' }
  const list = Array.isArray(ledger?.reviewTokens) ? ledger.reviewTokens : []
  const hit = list.find((t) => t && t.token === value)
  if (!hit) return { ok: false, reason: 'UNKNOWN_REVIEW_TOKEN' }
  if (hit.consumedAt) return { ok: false, reason: 'REVIEW_TOKEN_ALREADY_CONSUMED' }
  if (Number(hit.round) !== Number(round)) {
    return { ok: false, reason: `REVIEW_TOKEN_ROUND_MISMATCH: 令牌是 Round ${hit.round} 的，当前记 Round ${round}` }
  }
  hit.consumedAt = new Date().toISOString()
  return { ok: true, entry: hit }
}

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

export function normalizeExploredEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = typeof raw.at === 'string' && raw.at.trim() ? raw.at.trim() : null
  const tier = typeof raw.tier === 'string' && raw.tier.trim() ? raw.tier.trim() : null
  const symNum = Number(raw.symbolCount ?? raw.symbols ?? raw.indexedSymbols)
  if (!at || !tier || !Number.isFinite(symNum) || symNum < 0) return null
  const by = typeof raw.by === 'string' && raw.by.trim() ? raw.by.trim() : undefined
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : undefined
  return {
    at,
    tier,
    symbolCount: Math.floor(symNum),
    ...(by ? { by } : {}),
    ...(source ? { source } : {}),
  }
}

export function createExploredEvidence({ at = new Date().toISOString(), tier = 'direct-read', symbolCount = 0, by, source = 'repo-map' } = {}) {
  return normalizeExploredEvidence({ at, tier, symbolCount, by, source })
}

export function hasExploredEvidence(ledger) {
  return normalizeExploredEvidence(ledger?.explored) !== null
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
    depsMode: partial.depsMode ?? 'none',
    /**
     * 工具自己挂载的共享依赖相对路径清单（按工作位索引 + 扁平汇总）。
     * `cleanup` 只依实际挂盘清单逐条自动解绑，不靠 `depsMode === 'shared'` 一股脑放行。
     */
    mountedDeps: Array.isArray(partial.mountedDeps) ? partial.mountedDeps : [],
    mountedDepsByWorktree: (partial.mountedDepsByWorktree && typeof partial.mountedDepsByWorktree === 'object' && !Array.isArray(partial.mountedDepsByWorktree))
      ? partial.mountedDepsByWorktree
      : {},
    todoFile: partial.todoFile ?? null,
    specFile: partial.specFile ?? null,
    prdFile: partial.prdFile ?? null,
    archivedTodoFile: partial.archivedTodoFile ?? null,
    archivedSpecFile: partial.archivedSpecFile ?? null,
    archivedPrdFile: partial.archivedPrdFile ?? null,
    privateDocsDir: partial.privateDocsDir ?? null,
    linkedIssues: Array.isArray(partial.linkedIssues) ? partial.linkedIssues : [],
    /**
     * 验收标准的冻结指纹。
     *
     * 批准那一刻记下 `C1..Cn` 的指纹；之后实现阶段回到 SPEC 里改标准，
     * 指纹就对不上。**这是「批准后标准不许变」的唯一机械保证**——
     * 在此之前，改标准既不报错也不留痕，只能靠审查者记得原文。
     */
    criteriaFingerprint: partial.criteriaFingerprint ?? null,
    /** 冻结发生在哪个文件上（SPEC 或 Todo），以及冻结时的审批人/时间。 */
    criteriaFrozenFrom: partial.criteriaFrozenFrom ?? null,
    criteriaFrozenAt: partial.criteriaFrozenAt ?? null,
    /**
     * 贴进来的 Issue 到底说了什么。
     *
     * 只记编号不够：AI 拿着一个 「42」 什么也做不了，只能要么自己再跑一次 `gh issue view`
     * （没人检查它做没做），要么凭编号猜。这里把标题与正文摘要落在账本里。
     */
    issueContext: Array.isArray(partial.issueContext) ? partial.issueContext : [],
    /** 没取到正文的 Issue 编号。非空时 `flow next` 要提示先去取。 */
    issueContextUnavailable: Array.isArray(partial.issueContextUnavailable) ? partial.issueContextUnavailable : [],
    /** 无法联网或无权读取 Issue 时，用户显式确认继续的放行记录。 */
    issueContextAck: partial.issueContextAck && typeof partial.issueContextAck === 'object'
      ? {
          issues: Array.isArray(partial.issueContextAck.issues) ? partial.issueContextAck.issues.map(Number).filter(Boolean) : [],
          reason: typeof partial.issueContextAck.reason === 'string' ? partial.issueContextAck.reason : '',
          at: typeof partial.issueContextAck.at === 'string' ? partial.issueContextAck.at : null,
          by: typeof partial.issueContextAck.by === 'string' ? partial.issueContextAck.by : null,
        }
      : null,
    prNumber: partial.prNumber ?? null,
    prState: partial.prState ?? null,
    prUrl: partial.prUrl ?? null,
    prContext: partial.prContext && typeof partial.prContext === 'object' && !Array.isArray(partial.prContext)
      ? partial.prContext
      : null,
    prContextUnavailable: partial.prContextUnavailable && typeof partial.prContextUnavailable === 'object' && !Array.isArray(partial.prContextUnavailable)
      ? partial.prContextUnavailable
      : null,
    prBaseSha: partial.prBaseSha ?? null,
    prHeadSha: partial.prHeadSha ?? null,
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
    claimedBy: partial.claimedBy ?? null,
    reviewerId: partial.reviewerId ?? null,
    account: partial.account ?? null,
    verifiedPlatformLogin: Boolean(partial.verifiedPlatformLogin),
    agent: partial.agent ?? null,
    reviewEmpirical: partial.reviewEmpirical ?? null,
    /**
     * 探索证据：这个任务开干之前，有没有人真的读过这个仓。
     *
     * 形状冻结在这里，因为三处要读它——`flow next`（缺了就只给探索这一步）、
     * `flow merge`（缺了拦）、`review-pack`（写进审查材料）。三处各定义一个字段名，
     * 就会出现「写了没人读、读了没人写」。
     *
     * `by` 是派发者标识（子代理名或会话标识）。它不承担防伪——防伪在 `reviewTokens`；
     * 它承担的是「事后能追到是谁说的」。
     */
    explored: normalizeExploredEvidence(partial.explored),
    /**
     * 独立审查的一次性令牌。
     *
     * `--reviewer-id` 是命令行传进来的自由字符串，谁都能编一个不一样的名字。
     * 令牌把「随便编个名」抬成「至少得伪造一个 `flow next` 现场发的东西」，
     * 且一个令牌只能被消费一次。
     */
    reviewTokens: Array.isArray(partial.reviewTokens) ? partial.reviewTokens : [],
    rounds: Array.isArray(partial.rounds) ? partial.rounds : [],
    lastReview: partial.lastReview ?? null,
    reviewPassed: Boolean(partial.reviewPassed),
    reviewPassedHead: partial.reviewPassedHead ?? null,
    humanApprovedStopLoss: Boolean(partial.humanApprovedStopLoss),
    humanApprovedReason: partial.humanApprovedReason ?? null,
    rebuts: Array.isArray(partial.rebuts) ? partial.rebuts : [],
    status: partial.status ?? 'started',
    ...partial,
    explored: normalizeExploredEvidence(partial.explored),
    taskId,
  }
}

export function readTaskLedger(mainRoot, taskId) {
  return readJsonSafe(taskLedgerPath(mainRoot, taskId))
}

/** 将 `mountSharedDeps` 实际挂载/已挂载的单元路径同步写入账本，供 `cleanup` 精确识别工具挂载。 */
export function recordMountedDepsInLedger(ledger, worktreeRel, mountResult) {
  if (!ledger || typeof ledger !== 'object') return []
  const rawList = Array.isArray(mountResult?.mountedPaths)
    ? mountResult.mountedPaths
    : [...(mountResult?.mounted ?? []), ...(mountResult?.alreadyMounted ?? [])].map((item) => (typeof item === 'string' ? item : item?.path))
  const normalizedPaths = [...new Set(
    rawList
      .map((p) => posixPath(String(p ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, ''))
      .filter((p) => p && p !== '.'),
  )].sort()
  const wtKey = posixPath(String(worktreeRel ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  const byWt = (ledger.mountedDepsByWorktree && typeof ledger.mountedDepsByWorktree === 'object' && !Array.isArray(ledger.mountedDepsByWorktree))
    ? { ...ledger.mountedDepsByWorktree }
    : {}
  if (wtKey) byWt[wtKey] = normalizedPaths
  ledger.mountedDepsByWorktree = byWt
  const flat = new Set()
  for (const arr of Object.values(byWt)) {
    if (Array.isArray(arr)) for (const p of arr) if (p) flat.add(p)
  }
  if (!wtKey) for (const p of normalizedPaths) flat.add(p)
  ledger.mountedDeps = [...flat].sort()
  return normalizedPaths
}

function writeTaskLedgerUnlocked(mainRoot, ledger) {
  const p = taskLedgerPath(mainRoot, ledger.taskId)
  const existing = readJsonSafe(p)
  const safeInput = { ...ledger }
  if (existing?.status === 'merged' && !['merged', 'cleaned'].includes(String(safeInput.status ?? '').toLowerCase())) {
    safeInput.status = 'merged'
    if (existing.prState === 'MERGED' && (!safeInput.prState || String(safeInput.prState).toUpperCase() === 'UNKNOWN')) {
      safeInput.prState = 'MERGED'
    }
  }
  const stamped = {
    ...createDefaultLedger(safeInput),
    updatedAt: new Date().toISOString(),
  }
  if (!stamped.createdAt) stamped.createdAt = stamped.updatedAt
  writeJsonAtomic(p, stamped)
  return p
}

function resolveLedgerLockDir(mainRoot) {
  const dotGit = join(mainRoot, '.git')
  try {
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
      return join(dotGit, 'project-forge-flow', 'locks')
    }
  } catch { /* fallback below */ }
  return join(mainRoot, '.worktrees', '.state', 'locks')
}

/** 加锁同步兼容写封装：内部经与 `updateTaskLedger` 相同的互斥锁落盘，供尚未迁移的同步调用方平滑过渡。 */
export function writeTaskLedger(mainRoot, ledger) {
  const id = sanitizeTaskId(ledger.taskId)
  const lockPath = join(resolveLedgerLockDir(mainRoot), `ledger-${id}.lock`)
  return withFileLockSync(lockPath, () => writeTaskLedgerUnlocked(mainRoot, { ...ledger, taskId: id }))
}

/** 原子读取、转换并写回任务账本（防止直接裸写丢失契约默认值，且经文件锁防并发竞态）。 */
export async function updateTaskLedger(mainRoot, taskId, updater, { createIfMissing = false, defaults = {} } = {}) {
  const id = sanitizeTaskId(taskId)
  const lockPath = join(resolveLedgerLockDir(mainRoot), `ledger-${id}.lock`)
  return withFileLock(lockPath, async () => {
    const existing = readTaskLedger(mainRoot, id)
    if (!existing && !createIfMissing) {
      throw new Error(`找不到任务账本：${id}（请先运行 flow.mjs start --task ${id}）`)
    }
    const base = existing ? createDefaultLedger(existing) : createDefaultLedger({ ...defaults, taskId: id })
    const nextRaw = typeof updater === 'function' ? await updater(structuredClone(base)) : { ...base, ...updater }
    const next = { ...(nextRaw ?? {}) }
    if (base.status === 'merged' && next.status !== undefined && !['merged', 'cleaned'].includes(String(next.status).toLowerCase())) {
      next.status = 'merged'
      if (base.prState === 'MERGED' && String(next.prState ?? '').toUpperCase() === 'UNKNOWN') {
        next.prState = 'MERGED'
      }
    }
    const merged = createDefaultLedger({ ...base, ...next, taskId: id })
    const path = writeTaskLedgerUnlocked(mainRoot, merged)
    return { ledger: readTaskLedger(mainRoot, id) ?? merged, path }
  })
}

/** 从工作树或主仓路径解析账本所在的主仓根路径（避免误读 worktree 下的空账本目录）。 */
export async function resolveLedgerRoot(repoRoot, explicitLedgerRoot = null) {
  if (explicitLedgerRoot) return explicitLedgerRoot
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (wtGitDir) {
    const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
    if (cdTxt) {
      const commonDir = resolve(wtGitDir, cdTxt.trim())
      if (basename(commonDir) === '.git') return dirname(commonDir)
    }
  }
  if (hasDotGitInAncestors(repoRoot)) {
    const roots = await resolveRepoRoots(repoRoot).catch(() => null)
    if (roots?.mainRoot) return roots.mainRoot
  }
  return repoRoot
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
    const fastHead = readHeadFast(roots.workTreeGitDir ?? resolveGitDirFast(workRoot), roots.gitDir)
    const curBranch = fastHead
      ? (fastHead.branch ?? '')
      : ((await gitRun(workRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout?.trim() ?? '')
    if (curBranch) {
      const brMatches = active.filter((t) => t.branch === curBranch)
      if (brMatches.length === 1) {
        return { taskId: brMatches[0].taskId, ledger: brMatches[0], source: 'branch', activeTasks: active }
      }
    }
  }

  // 4. --pr or --issue match
  if (opts.pr !== undefined && String(opts.pr).trim() !== '') {
    const prNum = parsePrNumber(opts.pr)
    const prMatch = prNum ? active.find((t) => Number(t.prNumber) === prNum) : null
    if (prMatch) return { taskId: prMatch.taskId, ledger: prMatch, source: 'pr', activeTasks: active }
  }
  if (opts.issue !== undefined && String(opts.issue).trim() !== '') {
    const issNums = parseIssueNumbers(opts.issue)
    const issMatches = issNums.length > 0
      ? active.filter((t) => Array.isArray(t.linkedIssues) && issNums.some((n) => t.linkedIssues.includes(n)))
      : []
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

/**
 * 下一个审查轮次。
 *
 * ## 为什么必须只有一个派生式
 *
 * 这件事此前在五处各算一遍，其中两种算法并存：
 *
 * - `rounds.length + 1`（签令、打印命令）—— 轮次有空档时算错；
 * - `Math.max(...) + 1`（diff 基线、变更记录、rebind）—— 这个是对的。
 *
 * 空档（`rounds = [1, 3]`）时前者给 3、后者给 4：令牌按 4 签、命令让人照 3 跑，
 * 于是 `REVIEW_TOKEN_ROUND_MISMATCH`，而且没有出口。
 *
 * 判据就是「取最大轮次加一」——**空档不是异常，是正常历史**（某轮被撤销、
 * 某轮只审了一部分）。按条数算等于假设轮次永远连续，那个假设不成立。
 *
 * @param {object} ledger 任务账本
 * @returns {number} 下一个轮次，最小为 1
 */
export function nextReviewRound(ledger) {
  const rounds = Array.isArray(ledger?.rounds) ? ledger.rounds : []
  const nums = rounds.map((r) => Number(r?.round ?? r) || 0).filter((n) => n > 0)
  return nums.length > 0 ? Math.max(...nums) + 1 : 1
}
