/**
 * verify-state.mjs —— 仓外验证命名空间（cache.json / scratch/{taskId}/）、免手工日期过时校验、
 * 跨 PR 临时脚本固化提示与防敷衍 `--e2e-evidence` 校验内核（由 feature-map.mjs 统一重导出）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import {
  canonicalPath, gitRun, posixPath, readJsonSafe, readTextSafe, samePath,
  sha256Text, writeJsonAtomic,
} from './git.mjs'
import { evaluateTextSubstance } from './evidence-substance.mjs'
import { sanitizeTaskId } from './ledger.mjs'
import { appendGovernSignal, readSignalsJsonl } from './signals.mjs'
import { extractSymbols } from './symbol-index.mjs'

export const VALID_RISK_LEVELS = Object.freeze(['low', 'medium', 'high'])

function normRelPath(p) {
  return posixPath(String(p ?? '').trim()).replace(/^\.\//, '').replace(/^\/+/, '')
}

function uniqPaths(arr) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = normRelPath(item)
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** 校验 `--e2e-evidence` 是否写清执行入口与观察到的真实输出/状态，拦截水话与占位符。 */
export function validateE2eEvidenceText(raw) {
  // 判据只有一处实现：措辞千变万化，词表每加一条就逼出下一个措辞。
  // 所以这里只把结果映射成原有的码位，判法本身在 evidence-substance.mjs。
  const base = evaluateTextSubstance(raw, { subject: '--e2e-evidence' })
  return base.ok
    ? { ok: true, code: null, cleaned: base.cleaned }
    : { ok: false, code: 'BLOCKED_SHALLOW_E2E_EVIDENCE', reason: base.reason }
}

/** 仓外验证命名空间根路径：`{gitCommonDir}/project-forge-verify/`（非 Git 回退 tmpdir 哈希目录）。 */
export function resolveVerifyStateDir(gitCommonDir, mainRoot = process.cwd()) {
  if (gitCommonDir) return join(gitCommonDir, 'project-forge-verify')
  const hash = sha256Text(canonicalPath(mainRoot)).slice(0, 12)
  return join(tmpdir(), 'project-forge-verify', hash)
}

export function resolveVerifyCachePath(gitCommonDir, mainRoot = process.cwd()) {
  return join(resolveVerifyStateDir(gitCommonDir, mainRoot), 'cache.json')
}

export function resolveScratchRoot(gitCommonDir, mainRoot = process.cwd()) {
  return join(resolveVerifyStateDir(gitCommonDir, mainRoot), 'scratch')
}

export function resolveTaskScratchDir(gitCommonDir, taskId, mainRoot = process.cwd()) {
  const safeId = sanitizeTaskId(taskId || 'default')
  return join(resolveScratchRoot(gitCommonDir, mainRoot), safeId)
}

/** 严格前缀校验：仅允许操作 `{gitCommonDir}/project-forge-verify/scratch/{taskId}` 及其子项，严防越界误删。 */
export function isSafeTaskScratchPath(candidateAbs, gitCommonDir, taskId, mainRoot = process.cwd()) {
  if (!candidateAbs || !taskId) return false
  const expected = canonicalPath(resolveTaskScratchDir(gitCommonDir, taskId, mainRoot))
  const scratchRoot = canonicalPath(resolveScratchRoot(gitCommonDir, mainRoot))
  const cand = canonicalPath(candidateAbs)
  if (samePath(cand, scratchRoot)) return false
  if (samePath(cand, expected)) return true
  const rel = relative(expected, cand)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export function ensureTaskScratchDir(gitCommonDir, taskId, mainRoot = process.cwd(), meta = null) {
  const safeId = sanitizeTaskId(taskId || 'default')
  const dir = resolveTaskScratchDir(gitCommonDir, safeId, mainRoot)
  if (!isSafeTaskScratchPath(dir, gitCommonDir, safeId, mainRoot)) {
    throw new Error(`UNSAFE_SCRATCH_PATH: 拒绝创建仓外校验前缀之外的 scratch 目录 (${dir})`)
  }
  mkdirSync(dir, { recursive: true })
  if (meta && typeof meta === 'object') {
    const metaPath = join(dir, '.scratch-meta.json')
    const prev = readJsonSafe(metaPath) ?? {}
    writeJsonAtomic(metaPath, {
      ...prev,
      taskId: safeId,
      featureId: meta.featureId ?? prev.featureId ?? null,
      modules: uniqPaths([...(prev.modules ?? []), ...(meta.modules ?? [])]),
      updatedAt: new Date().toISOString(),
    })
  }
  return { ok: true, taskId: safeId, dir, posixDir: posixPath(dir) }
}

export function inspectScratchDir(scratchDir) {
  if (!scratchDir || !existsSync(scratchDir)) {
    return { exists: false, fileCount: 0, files: [], meta: null }
  }
  const files = []
  const walkDir = (cur, relPrefix = '') => {
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      const abs = join(cur, ent.name)
      if (ent.isDirectory()) walkDir(abs, rel)
      else files.push(rel)
    }
  }
  walkDir(scratchDir)
  const meta = readJsonSafe(join(scratchDir, '.scratch-meta.json')) ?? null
  return { exists: true, fileCount: files.length, files: files.sort(), meta }
}

/** 列举 `{gitCommonDir}/project-forge-verify/scratch/` 下全部任务临时目录。 */
export function listTaskScratchDirs(gitCommonDir, mainRoot = process.cwd()) {
  const root = resolveScratchRoot(gitCommonDir, mainRoot)
  if (!existsSync(root)) return []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const abs = join(root, ent.name)
    let mtimeMs = 0
    try { mtimeMs = statSync(abs).mtimeMs } catch { /* ignore */ }
    const info = inspectScratchDir(abs)
    out.push({ taskId: ent.name, dir: abs, posixDir: posixPath(abs), fileCount: info.fileCount, files: info.files, meta: info.meta, mtimeMs })
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId))
}

/**
 * 销毁指定任务的仓外 `scratch/{taskId}/` 目录：
 * 1. 先校验路径前缀必落于 `{gitCommonDir}/project-forge-verify/scratch/{taskId}`；
 * 2. 若目录非空或含元信息，先向 `signals.jsonl` 记 `verify.scratch-used`；
 * 3. 彻底销毁目录与关联空锁文件。
 */
export async function destroyTaskScratchDir({
  gitCommonDir, mainRoot = process.cwd(), taskId, recordSignal = true,
  fallbackFeatureId = null, fallbackModules = [], source = 'flow-cleanup',
} = {}) {
  const safeId = sanitizeTaskId(taskId)
  const dir = resolveTaskScratchDir(gitCommonDir, safeId, mainRoot)
  if (!isSafeTaskScratchPath(dir, gitCommonDir, safeId, mainRoot)) {
    return { ok: false, code: 'UNSAFE_SCRATCH_PATH', path: posixPath(dir), destroyed: false, signalRecorded: false }
  }
  const info = inspectScratchDir(dir)
  if (!info.exists) {
    return { ok: true, existed: false, destroyed: false, path: posixPath(dir), fileCount: 0, signalRecorded: false }
  }
  const featureId = info.meta?.featureId ?? fallbackFeatureId ?? 'unmapped'
  const modules = uniqPaths([...(info.meta?.modules ?? []), ...(fallbackModules ?? [])])
  let signalRecorded = false
  if (recordSignal && (info.fileCount > 0 || Boolean(info.meta))) {
    const sig = await appendGovernSignal({
      mainRoot,
      gitDir: gitCommonDir,
      isGit: Boolean(gitCommonDir),
      category: 'verify',
      module: modules[0] ?? featureId,
      pattern: 'verify.scratch-used',
      ruleId: 'verify.scratch-used',
      defectClass: 'missing-runtime-proof',
      severity: 'low',
      source,
      file: modules[0] ?? '',
      taskId: safeId,
      targetArtifact: featureId,
      message: `task ${safeId} relied on out-of-repo scratch probes for feature "${featureId}" (${info.fileCount} file(s))`,
      meta: { type: 'verify.scratch-used', featureId, taskId: safeId, modules, fileCount: info.fileCount },
    })
    signalRecorded = Boolean(sig?.ok)
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 })
  const lockPath = `${dir}.lock`
  if (existsSync(lockPath)) {
    try { rmSync(lockPath, { force: true }) } catch { /* ignore */ }
  }
  return { ok: true, existed: true, destroyed: true, path: posixPath(dir), fileCount: info.fileCount, signalRecorded, featureId, modules }
}

/** 扫描 `signals.jsonl` 中跨 `>= minTasks`（默认 2）个不同 taskId 依赖仓外 scratch 的功能，输出确定性固化提示。 */
export function detectScratchSolidificationHints({ gitCommonDir, mainRoot = process.cwd(), minTasks = 2, filterFeatureIds = null } = {}) {
  const { events } = readSignalsJsonl({ mainRoot, gitDir: gitCommonDir, isGit: Boolean(gitCommonDir) })
  const byFeature = new Map()
  for (const ev of events) {
    if (ev.pattern !== 'verify.scratch-used' && ev.meta?.type !== 'verify.scratch-used') continue
    const fid = String(ev.meta?.featureId ?? ev.targetArtifact ?? ev.module ?? '').trim()
    const tid = String(ev.meta?.taskId ?? ev.taskId ?? '').trim()
    if (!fid || !tid) continue
    if (Array.isArray(filterFeatureIds) && filterFeatureIds.length > 0 && !filterFeatureIds.includes(fid)) continue
    let bucket = byFeature.get(fid)
    if (!bucket) {
      bucket = { featureId: fid, taskIds: new Set(), modules: new Set(), totalEvents: 0 }
      byFeature.set(fid, bucket)
    }
    bucket.taskIds.add(tid)
    bucket.totalEvents += 1
    for (const m of Array.isArray(ev.meta?.modules) ? ev.meta.modules : []) {
      if (m) bucket.modules.add(normRelPath(m))
    }
  }
  const hints = []
  for (const bucket of byFeature.values()) {
    if (bucket.taskIds.size < minTasks) continue
    const taskIds = [...bucket.taskIds].sort()
    const modules = [...bucket.modules].sort()
    hints.push({
      code: 'SUGGEST_SOLIDIFY_SCRATCH_TOOL',
      featureId: bucket.featureId,
      taskCount: taskIds.length,
      taskIds,
      modules,
      suggestion: `功能 "${bucket.featureId}" 已在 ${taskIds.length} 个独立任务（${taskIds.join(', ')}）中依赖仓外临时脚本；建议另开独立 PR 运行 \`node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs create --feature ${bucket.featureId}\` 固化进 docs/feature-map.json（勿污染当前业务 PR）。`,
    })
  }
  return hints.sort((a, b) => b.taskCount - a.taskCount || a.featureId.localeCompare(b.featureId))
}

export function readVerifyCache(gitCommonDir, mainRoot = process.cwd()) {
  const p = resolveVerifyCachePath(gitCommonDir, mainRoot)
  const raw = readJsonSafe(p)
  if (!raw || typeof raw !== 'object') return { version: 1, tools: {} }
  const tools = raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools) ? raw.tools : {}
  return { version: 1, tools }
}

export function writeVerifyCacheEntry(gitCommonDir, mainRoot, toolId, entry) {
  const p = resolveVerifyCachePath(gitCommonDir, mainRoot)
  const cur = readVerifyCache(gitCommonDir, mainRoot)
  cur.tools[toolId] = {
    featureId: entry.featureId ?? null,
    symbolHash: entry.symbolHash,
    moduleTreeHash: entry.moduleTreeHash,
    verifiedSha: entry.verifiedSha ?? null,
    passedAtCommit: entry.passedAtCommit ?? entry.verifiedSha ?? null,
    ...(entry.symbolsByFile ? { symbolsByFile: entry.symbolsByFile } : {}),
  }
  writeJsonAtomic(p, cur)
  return { path: posixPath(p), entry: cur.tools[toolId] }
}

async function readFileAtRefOrDisk(repoRoot, relPath, ref = null) {
  if (ref) {
    const show = await gitRun(repoRoot, ['show', `${ref}:${relPath}`])
    if (show.ok) return { exists: true, text: show.stdout }
    return { exists: false, text: '' }
  }
  const abs = join(repoRoot, relPath)
  if (!existsSync(abs)) return { exists: false, text: '' }
  return { exists: true, text: readTextSafe(abs, 512 * 1024) ?? '' }
}

/** 计算单个功能的符号摘要哈希与模块树内容哈希（零时间戳依赖，ref 与工作区同口径求值）。 */
export async function computeFeatureFingerprint(repoRoot, feature, { ref = null } = {}) {
  const targets = uniqPaths([...(feature?.entrypoints ?? []), ...(feature?.modules ?? [])]).sort()
  const symbolRecords = []
  const treeRecords = []
  const symbolsByFile = {}
  const missingFiles = []

  for (const rel of targets) {
    const fileData = await readFileAtRefOrDisk(repoRoot, rel, ref)
    if (!fileData.exists) {
      missingFiles.push(rel)
      symbolRecords.push([rel, 'missing', false, []])
      treeRecords.push([rel, 'MISSING'])
      symbolsByFile[rel] = []
      continue
    }
    const ext = rel.includes('.') ? rel.split('.').pop() : ''
    const extracted = extractSymbols(fileData.text, ext)
    symbolRecords.push([rel, extracted.lang, extracted.supported, extracted.symbols])
    symbolsByFile[rel] = extracted.symbols
    treeRecords.push([rel, sha256Text(fileData.text.replace(/\r\n/g, '\n').replace(/\n+$/, ''))])
  }

  return {
    targets,
    missingFiles,
    symbolsByFile,
    symbolHash: sha256Text(JSON.stringify(symbolRecords)),
    moduleTreeHash: sha256Text(JSON.stringify(treeRecords)),
  }
}

function diffSymbolsByFile(prevMap = {}, curMap = {}) {
  const changedModules = []
  const addedSymbols = []
  const removedSymbols = []
  const allFiles = new Set([...Object.keys(prevMap ?? {}), ...Object.keys(curMap ?? {})])
  for (const f of [...allFiles].sort()) {
    const prevSet = new Set(Array.isArray(prevMap?.[f]) ? prevMap[f] : [])
    const curSet = new Set(Array.isArray(curMap?.[f]) ? curMap[f] : [])
    let fileChanged = false
    for (const s of curSet) { if (!prevSet.has(s)) { addedSymbols.push(`${f}:${s}`); fileChanged = true } }
    for (const s of prevSet) { if (!curSet.has(s)) { removedSymbols.push(`${f}:${s}`); fileChanged = true } }
    if (fileChanged) changedModules.push(f)
  }
  return { changedModules, addedSymbols, removedSymbols }
}

/** 免手工日期过时校验与三级风险处置（`low` 告警、`medium` 转 E2E/scratch 记债、`high` 硬阻断）。 */
export async function evaluateToolStaleness({
  repoRoot, gitCommonDir, mainRoot = repoRoot, feature, tool, baseRef = null,
} = {}) {
  const riskLevel = VALID_RISK_LEVELS.includes(tool?.riskLevel) ? tool.riskLevel : 'medium'
  if (tool?.scriptPath && !existsSync(join(repoRoot, tool.scriptPath))) {
    return {
      toolId: tool.id, featureId: feature?.id ?? null, riskLevel,
      status: 'missing-script', action: 'block-missing-script', code: 'BLOCKED_MISSING_TOOL_SCRIPT',
      reasons: [`工具脚本路径不存在：${tool.scriptPath}`],
      changedModules: [tool.scriptPath], addedSymbols: [], removedSymbols: [], baseline: null, current: null,
    }
  }

  const cache = readVerifyCache(gitCommonDir, mainRoot)
  const baseline = cache.tools[tool.id] ?? null
  const headRes = await gitRun(repoRoot, ['rev-parse', 'HEAD'])
  const headSha = headRes.ok ? headRes.stdout.trim() : null
  let resolvedBaseSha = null
  if (baseRef) {
    const br = await gitRun(repoRoot, ['rev-parse', '--verify', baseRef])
    if (br.ok) resolvedBaseSha = br.stdout.trim()
  }
  const useBaseTree = Boolean(resolvedBaseSha && headSha && resolvedBaseSha !== headSha)
  const currentFp = await computeFeatureFingerprint(repoRoot, feature)
  const treeFp = useBaseTree ? await computeFeatureFingerprint(repoRoot, feature, { ref: resolvedBaseSha }) : currentFp

  if (!baseline) {
    return {
      toolId: tool.id, featureId: feature?.id ?? null, riskLevel,
      status: 'unbaselined', action: 'run', code: null,
      reasons: ['尚无仓外 cache.json 基线快照，运行通过后将自动采集首次符号与树基线'],
      changedModules: [], addedSymbols: [], removedSymbols: [], baseline: null, current: currentFp,
    }
  }

  const symbolDrift = currentFp.symbolHash !== baseline.symbolHash
  const treeDrift = treeFp.moduleTreeHash !== baseline.moduleTreeHash
  if (!symbolDrift && !treeDrift) {
    return {
      toolId: tool.id, featureId: feature?.id ?? null, riskLevel,
      status: 'fresh', action: 'run', code: null,
      reasons: [], changedModules: [], addedSymbols: [], removedSymbols: [], baseline, current: currentFp,
    }
  }

  const symDiff = diffSymbolsByFile(baseline.symbolsByFile, currentFp.symbolsByFile)
  const reasons = []
  if (symbolDrift) reasons.push(`导出符号哈希漂移（新增=${symDiff.addedSymbols.length}，移除=${symDiff.removedSymbols.length}）`)
  if (treeDrift) {
    reasons.push(useBaseTree
      ? `基准分支 (${baseRef}) 模块树哈希与基线提交 ${String(baseline.passedAtCommit ?? '').slice(0, 8)} 不一致`
      : `关联模块树哈希与基线提交 ${String(baseline.passedAtCommit ?? '').slice(0, 8)} 不一致`)
  }
  const changedModules = symDiff.changedModules.length > 0 ? symDiff.changedModules : currentFp.targets
  const disposition = riskLevel === 'low'
    ? { action: 'warn-and-run', code: 'STALE_WARN' }
    : riskLevel === 'medium'
      ? { action: 'fallback-e2e-or-scratch', code: 'STALE_MEDIUM_FALLBACK' }
      : { action: 'block-high-risk', code: 'BLOCKED_STALE_HIGH_RISK_TOOL' }

  return {
    toolId: tool.id, featureId: feature?.id ?? null, riskLevel, status: 'stale',
    ...disposition, reasons, changedModules,
    addedSymbols: symDiff.addedSymbols, removedSymbols: symDiff.removedSymbols,
    baseline, current: currentFp,
  }
}
