/**
 * signals.mjs —— 统一运行期信号总线（withFileLock 并发保护写入 `<gitCommonDir>/project-forge-govern/signals.jsonl`）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-edit、dev-flow、dev-review、dev-govern 共用。
 * 所有事件携带三层倒金字塔结构化字段：`defectClass`、`pyramidTier`、`fingerprint`、`targetArtifact`；
 * 读旧无指纹历史条目时实时补全虚拟指纹，兼容既有账本。
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CODE_EXT_RE } from './git-core.mjs'
import { canonicalPath, posixPath, readTextSafe, sha256Text, withFileLock } from './git.mjs'
import { isTestOrFixtureFile } from './static-gates.mjs'
import { isToolOwnedPath } from './tool-owned.mjs'

export const DEFECT_CLASSES = Object.freeze([
  'suppression-bypass',
  'arch-boundary',
  'state-split',
  'mock-only-test',
  'race-condition',
  'stale-contract',
  'missing-runtime-proof',
  'file-bloat',
  'dead-code',
  'review-defect',
  'general',
])

export const PYRAMID_TIERS = Object.freeze([
  'tier1-architecture',
  'tier2-deterministic-gate',
  'tier3-prompt-fallback',
])

const TIER1_DEFECT_CLASSES = new Set([
  'state-split',
  'race-condition',
  'file-bloat',
])

export function inferSignalModule(fileRel) {
  const clean = posixPath(fileRel).replace(/^\.\//, '').trim()
  if (!clean) return 'repo'
  const parts = clean.split('/')
  if (parts.length <= 1) return 'root'
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** 根据 ruleId/pattern/category/message 确定性推断故障类别 `defectClass`。 */
export function inferDefectClass({ ruleId = '', pattern = '', category = '', message = '' } = {}) {
  const hay = `${ruleId} ${pattern} ${category} ${message}`.toLowerCase()
  if (/(?:suppression|excuse|ts-ignore|ts-nocheck|eslint-disable|noqa|type:\s*ignore|rust-allow|hack|workaround|skip-edit-gate|gate-weaken)/.test(hay)) {
    return 'suppression-bypass'
  }
  if (/(?:arch-boundary|arch-rules|cross-layer|forbidden-import|circular-dep)/.test(hay)) {
    return 'arch-boundary'
  }
  if (/(?:state-split|ledger-split|writeTaskLedger|dual-source|single-source|stop-loss|coupling|conflict)/.test(hay)) {
    return 'state-split'
  }
  if (/(?:mock-tautology|mock-only|zero-assertion|hard-sleep|non-headless|test-anti-cheat)/.test(hay)) {
    return 'mock-only-test'
  }
  if (/(?:race-condition|lock|concurrent|flaky|deadlock|toctou)/.test(hay)) {
    return 'race-condition'
  }
  if (/(?:stale-contract|tdd-drift|tdd-stale|dead-link|tombstone|changelog-voice|outdated-doc|contract)/.test(hay)) {
    return 'stale-contract'
  }
  if (/(?:e2e|smoke|runtime-proof|missing-evidence|verify\.|unverified|empirical)/.test(hay)) {
    return 'missing-runtime-proof'
  }
  if (/(?:god-file|oversized|file-bloat|near-limit|800)/.test(hay)) {
    return 'file-bloat'
  }
  if (/(?:deadcode|dead-code|commented-block|orphan|unused)/.test(hay)) {
    return 'dead-code'
  }
  if (category === 'review' || /^review\./.test(String(pattern ?? ''))) {
    return 'review-defect'
  }
  return 'general'
}

/** 依据倒金字塔优先级映射默认纠偏层级（默认绝不落入 Tier 3 提示词兜底）。 */
export function inferPyramidTier(defectClass, { crossModule = false, stopLoss = false } = {}) {
  const dc = String(defectClass ?? 'general').trim().toLowerCase()
  if (stopLoss || TIER1_DEFECT_CLASSES.has(dc)) return 'tier1-architecture'
  if (dc === 'arch-boundary' && crossModule) return 'tier1-architecture'
  return 'tier2-deterministic-gate'
}

/** 计算稳定 12 位故障指纹：`sha256(ruleId + defectClass + moduleRoot)` 前 12 位。 */
export function computeSignalFingerprint({ ruleId = '', pattern = '', defectClass = 'general', moduleRoot = '', module = '' } = {}) {
  const normRule = String(ruleId || pattern || 'signal').trim().toLowerCase()
  const normClass = String(defectClass || 'general').trim().toLowerCase()
  const normMod = posixPath(String(moduleRoot || module || 'repo').trim()).replace(/^\.\//, '').toLowerCase() || 'repo'
  return sha256Text(`${normRule}|${normClass}|${normMod}`).slice(0, 12)
}

/** 读取旧/新信号事件时补全结构化倒金字塔字段（兼容无指纹历史日志）。 */
export function enrichSignalEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return rawEvent
  const moduleName = String(rawEvent.module ?? '').trim() || inferSignalModule(rawEvent.file ?? '')
  const pattern = String(rawEvent.pattern ?? 'signal').trim() || 'signal'
  const ruleId = String(rawEvent.ruleId ?? pattern).trim() || pattern
  const defectClass = String(rawEvent.defectClass ?? '').trim()
    || inferDefectClass({ ruleId, pattern, category: rawEvent.category, message: rawEvent.message })
  const pyramidTier = PYRAMID_TIERS.includes(rawEvent.pyramidTier)
    ? rawEvent.pyramidTier
    : inferPyramidTier(defectClass, { stopLoss: /stop-loss/.test(pattern) })
  const hasExplicitFp = typeof rawEvent.fingerprint === 'string' && rawEvent.fingerprint.trim().length > 0
  const fingerprint = hasExplicitFp
    ? rawEvent.fingerprint.trim()
    : computeSignalFingerprint({ ruleId, pattern, defectClass, moduleRoot: moduleName })
  const targetArtifact = String(rawEvent.targetArtifact ?? '').trim()
    || (rawEvent.file ? posixPath(rawEvent.file) : moduleName)
  return {
    ...rawEvent,
    module: moduleName,
    pattern,
    ruleId,
    defectClass,
    pyramidTier,
    fingerprint,
    targetArtifact,
    ...(!hasExplicitFp ? { virtualFingerprint: true } : {}),
  }
}

/**
 * 解析园艺信号与治理状态落盘目录（Git 仓写 `<gitCommonDir>/project-forge-govern`，非 Git 回退 tmpdir 哈希目录）。
 */
export function resolveGovernStateDir(mainRoot, gitDir = null, isGit = Boolean(gitDir)) {
  if (isGit) {
    return join(gitDir ?? join(mainRoot || process.cwd(), '.git'), 'project-forge-govern')
  }
  const hash = sha256Text(canonicalPath(mainRoot || process.cwd())).slice(0, 12)
  return join(tmpdir(), 'project-forge-govern', hash)
}

function resolveWorktreeBranchFast(rootDir) {
  if (!rootDir) return null
  try {
    const dotGit = join(rootDir, '.git')
    if (!existsSync(dotGit)) return null
    let gitDir = dotGit
    if (statSync(dotGit).isFile()) {
      const ptr = readTextSafe(dotGit) ?? ''
      const m = /^gitdir:\s*(.+)$/im.exec(ptr)
      if (!m) return null
      gitDir = resolve(dirname(dotGit), m[1].trim())
    }
    const head = (readTextSafe(join(gitDir, 'HEAD')) ?? '').trim()
    const refM = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return refM ? refM[1].trim() : null
  } catch {
    return null
  }
}

function worktreeMatches(evWt, filterWt) {
  if (!filterWt) return true
  if (!evWt) return false
  const a = posixPath(String(evWt)).replace(/\/+$/, '')
  const b = posixPath(String(filterWt)).replace(/\/+$/, '')
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** 判断 signal 关联目标是否为仓库内现存的有效源码文件（排除文档/归档/工具文件/已删文件/测试夹具）。 */
export function isActionableSignalCodeTarget(target, repoRoot = null) {
  const rel = posixPath(String(target ?? '')).replace(/^\.\//, '').trim()
  if (!rel || isToolOwnedPath(rel) || isTestOrFixtureFile(rel)) return false
  if (/^(?:docs\/archive\/|node_modules\/|dist\/|build\/|\.worktrees\/)/i.test(rel)) return false
  if (!CODE_EXT_RE.test(rel)) return false
  if (repoRoot && !existsSync(join(repoRoot, rel))) return false
  return true
}

/** 过滤出针对有效源码目标的信号事件。 */
export function filterActionableCodeSignals(events = [], repoRoot = null) {
  return (events ?? []).filter((ev) => isActionableSignalCodeTarget(ev?.targetArtifact || ev?.file, repoRoot))
}

/** 读取并解析 `signals.jsonl`（支持按 `{ taskId, branch, worktree, codeOnly, repoRoot }` 隔离过滤）。 */
export function readSignalsJsonl(stateDirOrRoots, filter = {}) {
  const stateDir = typeof stateDirOrRoots === 'string'
    ? stateDirOrRoots
    : resolveGovernStateDir(stateDirOrRoots?.mainRoot, stateDirOrRoots?.gitDir, stateDirOrRoots?.isGit ?? Boolean(stateDirOrRoots?.gitDir))
  const signalsPath = join(stateDir, 'signals.jsonl')
  if (!existsSync(signalsPath)) return { signalsPath, events: [] }
  const text = readTextSafe(signalsPath, 8 * 1024 * 1024) ?? ''
  const events = []
  const wantTask = filter?.taskId ? String(filter.taskId).trim() : null
  const wantBranch = filter?.branch ? String(filter.branch).trim() : null
  const wantWorktree = filter?.worktree ? String(filter.worktree).trim() : null
  const codeOnly = Boolean(filter?.codeOnly)
  const repoRoot = filter?.repoRoot ?? (typeof stateDirOrRoots === 'object' ? stateDirOrRoots?.mainRoot ?? null : null)
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (!obj || typeof obj !== 'object') continue
      const ev = enrichSignalEvent(obj)
      if (wantTask && ev.taskId !== wantTask) continue
      if (wantBranch && ev.branch !== wantBranch) continue
      if (wantWorktree && !worktreeMatches(ev.worktree, wantWorktree)) continue
      if (codeOnly && !isActionableSignalCodeTarget(ev.targetArtifact || ev.file, repoRoot)) continue
      events.push(ev)
    } catch { /* ignore corrupt partial line */ }
  }
  return { signalsPath, events }
}

/**
 * 使用 `withFileLock` 并发安全追加一条治理信号事件至 `signals.jsonl`（默认非阻塞，I/O 异常不阻断主流程）。
 */
export async function appendGovernSignal(opts = {}) {
  const {
    mainRoot,
    gitDir = null,
    isGit = Boolean(gitDir),
    stateDir: explicitStateDir,
    category = 'hygiene',
    module: explicitModule,
    pattern = '',
    ruleId: explicitRuleId = '',
    defectClass: explicitDefectClass = '',
    pyramidTier: explicitPyramidTier = '',
    fingerprint: explicitFingerprint = '',
    targetArtifact: explicitTargetArtifact = '',
    severity = 'medium',
    source = 'workflow',
    file = '',
    line,
    message = '',
    note = '',
    taskId = null,
    branch = null,
    worktree = null,
    workRoot = null,
    round = null,
    verdict = null,
    meta = null,
    silent = true,
  } = opts ?? {}

  const stateDir = explicitStateDir ?? resolveGovernStateDir(mainRoot, gitDir, isGit)
  const signalsPath = join(stateDir, 'signals.jsonl')
  const lockPath = join(stateDir, 'signals.jsonl.lock')
  const fileRel = file ? posixPath(file) : ''
  const moduleName = String(explicitModule || '').trim() || inferSignalModule(fileRel)
  const rawMessage = String(message || note || '').trim()
  const rawPattern = String(pattern || '').trim()
  const finalPattern = rawPattern
    || rawMessage.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
    || 'signal'
  const normCategory = String(category || 'hygiene').trim().toLowerCase()
  const finalRuleId = String(explicitRuleId || finalPattern).trim() || finalPattern
  const finalDefectClass = String(explicitDefectClass || '').trim().toLowerCase()
    || inferDefectClass({ ruleId: finalRuleId, pattern: finalPattern, category: normCategory, message: rawMessage })
  const finalPyramidTier = PYRAMID_TIERS.includes(explicitPyramidTier)
    ? explicitPyramidTier
    : inferPyramidTier(finalDefectClass, { stopLoss: /stop-loss/.test(finalPattern) })
  const finalFingerprint = String(explicitFingerprint || '').trim()
    || computeSignalFingerprint({ ruleId: finalRuleId, pattern: finalPattern, defectClass: finalDefectClass, moduleRoot: moduleName })
  const finalTargetArtifact = String(explicitTargetArtifact || '').trim() || fileRel || moduleName

  const resolvedBranch = (branch ? String(branch).trim() : null) ?? resolveWorktreeBranchFast(workRoot ?? mainRoot)
  const resolvedWorktree = worktree
    ? posixPath(String(worktree))
    : (workRoot ? posixPath(String(workRoot)) : null)

  const event = {
    ts: new Date().toISOString(),
    category: normCategory,
    module: moduleName,
    pattern: finalPattern,
    ruleId: finalRuleId,
    defectClass: finalDefectClass,
    pyramidTier: finalPyramidTier,
    fingerprint: finalFingerprint,
    targetArtifact: finalTargetArtifact,
    severity: String(severity || 'medium').trim().toLowerCase(),
    source: String(source || 'workflow').trim().toLowerCase(),
    file: fileRel,
    ...(Number.isInteger(line) ? { line } : {}),
    message: (rawMessage || finalPattern).slice(0, 500),
    ...(taskId ? { taskId: String(taskId) } : {}),
    ...(resolvedBranch ? { branch: resolvedBranch } : {}),
    ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
    ...(round !== undefined && round !== null ? { round: Number(round) } : {}),
    ...(verdict ? { verdict: String(verdict) } : {}),
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  }

  try {
    await withFileLock(lockPath, () => {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(signalsPath, `${JSON.stringify(event)}\n`, 'utf8')
    }, { timeoutMs: 5000, staleMs: 15000, pollMs: 15 })
    return { ok: true, stateDir, signalsPath: posixPath(signalsPath), event }
  } catch (err) {
    if (!silent) throw err
    return { ok: false, stateDir, signalsPath: posixPath(signalsPath), event, error: err instanceof Error ? err.message : String(err) }
  }
}
