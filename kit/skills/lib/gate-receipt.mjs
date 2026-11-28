/**
 * gate-receipt.mjs —— 干净 HEAD 六维确定性门禁回执缓存（支持任务态与 headless 态）
 * 与失败自动升级静默策略判定（shouldAutoEscalateFailure）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同级 `kit/skills/lib/`）。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ARCHITECTURE_MAP_REL } from './architecture-map.mjs'
import { FEATURE_MAP_REL } from './feature-map.mjs'
import {
  canonicalPath, gitRun, gitStatusPorcelainZ, posixPath, readJsonSafe,
  readTextSafe, sha256File, sha256Text, writeJsonAtomic,
} from './git.mjs'
import {
  readHeadFast, resolveDefaultBranchFast, resolveGitDirFast, resolveRefShaFast,
} from './git-fast.mjs'
import { isCleanWorktreeFast } from './git-status-fast.mjs'
import { sanitizeTaskId } from './ledger.mjs'
import { parseDevProfile } from './profile.mjs'
import { gitDiffRawEntriesAndText } from './static-gates.mjs'
import { resolveEffectiveBaseSha } from './workflow-helpers.mjs'

const SHA_HEX_RE = /^[0-9a-f]{40,64}$/i
const ALLOWED_CHECKS = new Set(['structuralHygiene', 'archRules', 'architectureMapSync', 'gateWeakening'])

function resolveCommonDirSync(workTreeRoot, gitCommonDir = null) {
  if (gitCommonDir) return canonicalPath(gitCommonDir)
  if (!workTreeRoot) return null
  const wtGitDir = resolveGitDirFast(workTreeRoot)
  if (!wtGitDir) return null
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  return canonicalPath(cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir)
}

function fileShaOrAbsent(absPath) {
  if (!absPath || !existsSync(absPath)) return 'ABSENT'
  return sha256File(absPath) ?? 'UNREADABLE'
}

function normalizeRuleList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object') return String(item.raw ?? `${item.from ?? ''} -> ${item.to ?? ''}`).trim()
      return ''
    })
    .filter(Boolean)
}

/** 计算与任务态 / headless 态对应的仓外门禁回执落盘路径（非 Git 仓返回 null）。 */
export function gateReceiptPath({ gitCommonDir, taskId = null, workTreeRoot = null } = {}) {
  if (!gitCommonDir) return null
  const cleanTask = typeof taskId === 'string' && taskId.trim() ? sanitizeTaskId(taskId.trim()) : null
  if (cleanTask) {
    return join(gitCommonDir, 'project-forge-flow', 'tasks', cleanTask, 'gate-receipt.json')
  }
  if (!workTreeRoot) return null
  const rootHash = sha256Text(canonicalPath(workTreeRoot)).slice(0, 12)
  return join(gitCommonDir, 'project-forge-flow', 'cache', `gate-receipt-${rootHash}.json`)
}

/** 计算配置与架构产物哈希（覆盖 arch-rules / high-risk / do-not-edit / feature-map / architecture-map / AGENTS.md / .gitattributes）。 */
export function computeProfileReceiptHash({ workTreeRoot, profile = null, extraHashes = null } = {}) {
  const repoRoot = canonicalPath(workTreeRoot)
  const disk = parseDevProfile(repoRoot)
  const src = profile && typeof profile === 'object' ? profile : {}
  const payload = {
    archRules: normalizeRuleList(src.archRules ?? src['arch-rules'] ?? disk['arch-rules']),
    highRisk: normalizeRuleList(src.highRisk ?? src['high-risk'] ?? disk['high-risk']),
    doNotEdit: normalizeRuleList(src.doNotEdit ?? src['do-not-edit'] ?? disk['do-not-edit']),
    featureMapSha: fileShaOrAbsent(join(repoRoot, FEATURE_MAP_REL)),
    architectureMapSha: fileShaOrAbsent(join(repoRoot, ARCHITECTURE_MAP_REL)),
    agentsSha: fileShaOrAbsent(join(repoRoot, 'AGENTS.md')),
    gitAttributesSha: fileShaOrAbsent(join(repoRoot, '.gitattributes')),
    ...(extraHashes ? { extraHashes } : {}),
  }
  return sha256Text(JSON.stringify(payload))
}

/**
 * 计算六维确定性门禁回执键：
 *   `{ repoRoot, dirty: false, headSha, baseSha, diffFingerprint, profileHash }`。
 * 任何脏树（dirty === true）或 UNBORN HEAD 一律返回 `{ valid: false, reason: 'dirty-or-unborn' }`。
 */
export function computeGateReceiptKey({
  workTreeRoot,
  dirty = false,
  headSha = null,
  baseSha = null,
  changedFiles = [],
  diffText = '',
  profile = null,
  extraHashes = null,
} = {}) {
  if (!workTreeRoot || dirty === true || !headSha || headSha === 'UNBORN') {
    return { valid: false, reason: 'dirty-or-unborn' }
  }
  const repoRoot = canonicalPath(workTreeRoot)
  const sortedChangedFiles = [...new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .map((f) => posixPath(String(f ?? '')).replace(/^\.\//, ''))
      .filter(Boolean),
  )].sort()
  const base = baseSha && baseSha !== 'HEAD' ? String(baseSha) : ''
  const diffFingerprint = sha256Text(`${base}\n${sortedChangedFiles.join('\n')}\n${String(diffText ?? '')}`)
  const profileHash = computeProfileReceiptHash({ workTreeRoot: repoRoot, profile, extraHashes })
  return {
    valid: true,
    repoRoot,
    dirty: false,
    headSha: String(headSha),
    baseSha: base,
    diffFingerprint,
    profileHash,
  }
}

export function keysMatch(storedKey, currentKey) {
  if (!storedKey || !currentKey) return false
  if (storedKey.valid !== true || currentKey.valid !== true) return false
  if (storedKey.dirty !== false || currentKey.dirty !== false) return false
  return storedKey.repoRoot === currentKey.repoRoot
    && storedKey.headSha === currentKey.headSha
    && storedKey.baseSha === currentKey.baseSha
    && storedKey.diffFingerprint === currentKey.diffFingerprint
    && storedKey.profileHash === currentKey.profileHash
}

/** 异步采集真实工作区状态与六维键（统一供 edit-gate / flow / review-locks / govern-checks 调用）。 */
export async function collectGateReceiptKey({
  workTreeRoot,
  gitCommonDir = null,
  ledger = null,
  baseSha = null,
  headSha = null,
  dirty = undefined,
  changedFiles = null,
  diffText = null,
  profile = null,
  extraHashes = null,
} = {}) {
  if (!workTreeRoot || !existsSync(workTreeRoot)) return { valid: false, reason: 'missing-root', gitCommonDir: null }
  const commonDir = resolveCommonDirSync(workTreeRoot, gitCommonDir)
  if (!commonDir) return { valid: false, reason: 'not-git', gitCommonDir: null }

  let isDirty = dirty
  if (isDirty === undefined) {
    const st = await gitStatusPorcelainZ(workTreeRoot)
    isDirty = !st.ok || st.entries.length > 0
  }
  if (isDirty) return { valid: false, reason: 'dirty-or-unborn', gitCommonDir: commonDir }

  const wtGitDir = resolveGitDirFast(workTreeRoot)
  let effHead = headSha || readHeadFast(wtGitDir, commonDir)?.oid || null
  if (!effHead) {
    const hr = await gitRun(workTreeRoot, ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'])
    effHead = hr.ok ? hr.stdout.trim() : null
  }
  if (!effHead || effHead === 'UNBORN') return { valid: false, reason: 'dirty-or-unborn', gitCommonDir: commonDir }

  let effBase = (baseSha && baseSha !== 'HEAD' && SHA_HEX_RE.test(String(baseSha))) ? String(baseSha) : null
  if (!effBase) {
    effBase = await resolveEffectiveBaseSha(workTreeRoot, ledger, { gitCommonDir: commonDir })
  }
  if (!effBase) {
    const defBr = resolveDefaultBranchFast(workTreeRoot, commonDir, { strict: false })
    if (defBr) {
      const mb = await gitRun(workTreeRoot, ['--no-optional-locks', 'merge-base', defBr, effHead])
      if (mb.ok && mb.stdout.trim() && mb.stdout.trim() !== effHead) effBase = mb.stdout.trim()
    }
  }
  if (effBase === 'HEAD') effBase = null

  let effFiles = Array.isArray(changedFiles) ? changedFiles : null
  let effDiff = typeof diffText === 'string' ? diffText : null
  if (effFiles === null || effDiff === null) {
    if (effBase && effBase !== effHead) {
      const dr = await gitDiffRawEntriesAndText(workTreeRoot, `${effBase}..${effHead}`)
      if (dr.ok) {
        effFiles = dr.entries.map((e) => e.file)
        effDiff = dr.diffText ?? ''
      } else {
        effFiles = []
        effDiff = ''
      }
    } else {
      effFiles = []
      effDiff = ''
    }
  }

  const key = computeGateReceiptKey({
    workTreeRoot,
    dirty: false,
    headSha: effHead,
    baseSha: effBase ?? '',
    changedFiles: effFiles,
    diffText: effDiff,
    profile,
    extraHashes,
  })
  return { ...key, gitCommonDir: commonDir }
}

/** 同步计算干净工作区六维键（供 review-gates.mjs 等同步路径使用；非确定干净一律返回 valid: false）。 */
export function resolveCleanReceiptKeySync({
  workTreeRoot,
  diff = null,
  baseSha = null,
  headSha = null,
  profile = null,
  task = null,
} = {}) {
  if (!workTreeRoot || (diff?.untracked?.length ?? 0) > 0) return { valid: false, reason: 'dirty-or-unborn', gitCommonDir: null }
  if (isCleanWorktreeFast(workTreeRoot)?.clean !== true) return { valid: false, reason: 'dirty-or-unborn', gitCommonDir: null }
  const commonDir = resolveCommonDirSync(workTreeRoot, null)
  if (!commonDir) return { valid: false, reason: 'not-git', gitCommonDir: null }
  const wtGitDir = resolveGitDirFast(workTreeRoot)
  const effHead = headSha || readHeadFast(wtGitDir, commonDir)?.oid || null
  if (!effHead || effHead === 'UNBORN') return { valid: false, reason: 'dirty-or-unborn', gitCommonDir: commonDir }
  let effBase = (baseSha && SHA_HEX_RE.test(String(baseSha))) ? String(baseSha) : (task?.baseSha && SHA_HEX_RE.test(String(task.baseSha)) ? String(task.baseSha) : null)
  if (!effBase) {
    const defBr = task?.baseBranch || resolveDefaultBranchFast(workTreeRoot, commonDir, { strict: false })
    if (defBr) {
      effBase = resolveRefShaFast(wtGitDir, `refs/heads/${defBr}`, commonDir)
        ?? resolveRefShaFast(wtGitDir, `refs/remotes/origin/${defBr}`, commonDir)
        ?? null
    }
  }
  const files = (diff?.files ?? []).map((f) => f.file)
  const key = computeGateReceiptKey({
    workTreeRoot,
    dirty: false,
    headSha: effHead,
    baseSha: effBase ?? '',
    changedFiles: files,
    diffText: typeof diff?.text === 'string' ? diff.text : '',
    profile,
  })
  return { ...key, gitCommonDir: commonDir }
}

function readReceiptFromPath(filePath, key) {
  if (!filePath) return null
  const doc = readJsonSafe(filePath)
  if (!doc || typeof doc !== 'object' || !keysMatch(doc.key, key)) return null
  return doc
}

export function readGateReceipt({ gitCommonDir, taskId = null, key } = {}) {
  if (!gitCommonDir || !key?.valid || key.dirty !== false) return null
  const primary = gateReceiptPath({ gitCommonDir, taskId, workTreeRoot: key.repoRoot })
  const found = readReceiptFromPath(primary, key)
  if (found) return found
  if (taskId) {
    const headless = gateReceiptPath({ gitCommonDir, taskId: null, workTreeRoot: key.repoRoot })
    return readReceiptFromPath(headless, key)
  }
  return null
}

function mergeWriteAtPath(filePath, key, filteredChecks) {
  const existing = readReceiptFromPath(filePath, key)
  const cleanKey = {
    valid: true,
    repoRoot: key.repoRoot,
    dirty: false,
    headSha: key.headSha,
    baseSha: key.baseSha,
    diffFingerprint: key.diffFingerprint,
    profileHash: key.profileHash,
  }
  const next = {
    version: 1,
    key: cleanKey,
    checks: { ...(existing?.checks ?? {}), ...filteredChecks },
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(filePath, next)
  return filePath
}

/** 原子合并写入门禁回执：严格拒写脏树/UNBORN/非 ok:true 条目，且禁止 edit-gate 伪造 gateWeakening。 */
export function writeGateReceipt({ gitCommonDir, taskId = null, key, checks = {}, producer = null } = {}) {
  if (!gitCommonDir || !key?.valid || key.dirty !== false) return null
  const now = new Date().toISOString()
  const filtered = {}
  for (const [name, val] of Object.entries(checks ?? {})) {
    if (!ALLOWED_CHECKS.has(name)) continue
    if (producer === 'edit-gate' && name === 'gateWeakening') continue
    if (!val || val.ok !== true) continue
    filtered[name] = { ...val, ok: true, ...(producer ? { producer } : {}), recordedAt: now }
  }
  if (Object.keys(filtered).length === 0) return null

  const primary = gateReceiptPath({ gitCommonDir, taskId, workTreeRoot: key.repoRoot })
  if (!primary) return null
  mergeWriteAtPath(primary, key, filtered)
  if (taskId) {
    const headless = gateReceiptPath({ gitCommonDir, taskId: null, workTreeRoot: key.repoRoot })
    if (headless && headless !== primary) mergeWriteAtPath(headless, key, filtered)
  }
  return primary
}

export function hasReusableGateCheck({ gitCommonDir, taskId = null, key, checkName } = {}) {
  if (!checkName || !ALLOWED_CHECKS.has(checkName)) return null
  const doc = readGateReceipt({ gitCommonDir, taskId, key })
  const entry = doc?.checks?.[checkName]
  return entry && entry.ok === true ? entry : null
}

/** 判断当前干净工作区是否可复用同 HEAD 的 `architectureMapSync` 通过回执。 */
export async function canReuseArchitectureMapReceipt({
  workTreeRoot,
  gitCommonDir = null,
  taskId = null,
  ledger = null,
  profile = null,
  key = null,
} = {}) {
  const effKey = key?.valid ? key : await collectGateReceiptKey({ workTreeRoot, gitCommonDir, ledger, profile })
  if (!effKey?.valid || effKey.dirty !== false) return false
  const commonDir = gitCommonDir ?? effKey.gitCommonDir
  if (!commonDir) return false
  const hit = hasReusableGateCheck({
    gitCommonDir: commonDir,
    taskId: taskId ?? ledger?.taskId ?? null,
    key: effKey,
    checkName: 'architectureMapSync',
  })
  return Boolean(hit && hit.ok === true)
}

/**
 * 统一失败自动升级判定：探索/沙箱/内环/local/staged/quick 默认静默（保留本地诊断与信号，不刷远端 Issue），
 * 仅外环阻断（verify smoke|gate、review task|pr）或非沙箱显式 `--escalate` 时返回 `{ escalate: true }`。
 */
export function shouldAutoEscalateFailure({ stage, mode = null, ledger = null, opts = {} } = {}) {
  if (opts?.['no-escalate'] === true || opts?.noEscalate === true) {
    return { escalate: false, reason: 'explicit-no-escalate' }
  }
  if (opts?.inner === true) {
    return { escalate: false, reason: 'inner-loop' }
  }
  if (ledger?.sandboxMode === true) {
    return { escalate: false, reason: 'sandbox-mode' }
  }
  if (mode === 'local' || mode === 'staged' || mode === 'quick') {
    return { escalate: false, reason: `local-or-quick:${mode}` }
  }
  if (stage === 'iterate') {
    return opts?.escalate === true
      ? { escalate: true, reason: 'explicit-escalate' }
      : { escalate: false, reason: 'iterate-default-silent' }
  }
  if (opts?.escalate === true) {
    return { escalate: true, reason: 'explicit-escalate' }
  }
  if (stage === 'verify' && (mode === 'smoke' || mode === 'gate')) {
    return { escalate: true, reason: `outer-verify:${mode}` }
  }
  if (stage === 'review' && (mode === 'task' || mode === 'pr')) {
    return { escalate: true, reason: `outer-review:${mode}` }
  }
  return { escalate: false, reason: 'default-silent' }
}
