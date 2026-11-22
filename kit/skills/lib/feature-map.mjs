/**
 * feature-map.mjs —— 机读唯一功能地图（docs/feature-map.json）Schema、读写、增量合并、
 * 路径与关键词切片查询（matchFeatureMapForPaths）及仓外验证状态统一导出。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-explore、dev-verify-tools、dev-review、dev-flow、dev-plan 共用。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { posixPath, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import {
  VALID_RISK_LEVELS,
  computeFeatureFingerprint,
  destroyTaskScratchDir,
  detectScratchSolidificationHints,
  ensureTaskScratchDir,
  evaluateToolStaleness,
  inspectScratchDir,
  isSafeTaskScratchPath,
  listTaskScratchDirs,
  readVerifyCache,
  reclaimVerifySlotCache,
  resolveScratchRoot,
  resolveTaskScratchDir,
  resolveVerifyCachePath,
  resolveVerifySlotKey,
  resolveVerifyStateDir,
  validateE2eEvidenceText,
  writeVerifyCacheEntry,
} from './verify-state.mjs'

export {
  VALID_RISK_LEVELS,
  computeFeatureFingerprint,
  destroyTaskScratchDir,
  detectScratchSolidificationHints,
  ensureTaskScratchDir,
  evaluateToolStaleness,
  inspectScratchDir,
  isSafeTaskScratchPath,
  listTaskScratchDirs,
  readVerifyCache,
  reclaimVerifySlotCache,
  resolveScratchRoot,
  resolveTaskScratchDir,
  resolveVerifyCachePath,
  resolveVerifySlotKey,
  resolveVerifyStateDir,
  validateE2eEvidenceText,
  writeVerifyCacheEntry,
}

export const FEATURE_MAP_REL = 'docs/feature-map.json'
export const FEATURE_MAP_VERSION = 1
export const VALID_TOOL_KINDS = Object.freeze(['script', 'command', 'e2e', 'smoke', 'probe'])
export const FORBIDDEN_TRACKED_KEYS = Object.freeze([
  'symbolHash', 'moduleTreeHash', 'verifiedSha', 'passedAtCommit',
  'lastVerifiedDate', 'verifiedAt', 'contentHash', 'treeHash', 'symbolsByFile',
])

function normRelPath(p) {
  return posixPath(String(p ?? '').trim()).replace(/^\.\//, '').replace(/^\/+/, '')
}

function uniqStrings(arr) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = String(item ?? '').trim()
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

function uniqPaths(arr) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = normRelPath(item)
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

export function slugifyFeatureId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'feature'
}

export function sanitizeVerificationTool(tool) {
  const id = slugifyFeatureId(tool?.id ?? tool?.scriptPath ?? tool?.command ?? 'tool')
  const kindRaw = String(tool?.kind ?? (tool?.scriptPath ? 'script' : 'command')).trim().toLowerCase()
  const kind = VALID_TOOL_KINDS.includes(kindRaw) ? kindRaw : 'command'
  const riskRaw = String(tool?.riskLevel ?? 'medium').trim().toLowerCase()
  const riskLevel = VALID_RISK_LEVELS.includes(riskRaw) ? riskRaw : 'medium'
  const command = tool?.command ? String(tool.command).trim() : null
  const scriptPath = tool?.scriptPath ? normRelPath(tool.scriptPath) : null
  const triggerHints = uniqStrings(tool?.triggerHints)
  return { id, kind, command, scriptPath, riskLevel, triggerHints }
}

export function sanitizeFeatureEntry(entry) {
  const id = slugifyFeatureId(entry?.id ?? entry?.name ?? 'feature')
  const name = String(entry?.name ?? id).trim() || id
  const entrypoints = uniqPaths(entry?.entrypoints)
  const modules = uniqPaths(entry?.modules?.length ? entry.modules : entrypoints)
  const businessFlows = uniqStrings(entry?.businessFlows)
  const seenTools = new Set()
  const verificationTools = []
  for (const rawTool of Array.isArray(entry?.verificationTools) ? entry.verificationTools : []) {
    const clean = sanitizeVerificationTool(rawTool)
    if (seenTools.has(clean.id)) continue
    seenTools.add(clean.id)
    verificationTools.push(clean)
  }
  const testRefs = uniqPaths(entry?.testRefs)
  return { id, name, entrypoints, modules, businessFlows, verificationTools, testRefs }
}

/** 净化功能地图结构，确保受跟踪 JSON 永不包含局部哈希或手工日期字段。 */
export function sanitizeFeatureMap(raw) {
  const features = []
  const seenIds = new Set()
  for (const item of Array.isArray(raw?.features) ? raw.features : []) {
    const clean = sanitizeFeatureEntry(item)
    if (seenIds.has(clean.id)) continue
    seenIds.add(clean.id)
    features.push(clean)
  }
  return { version: FEATURE_MAP_VERSION, features }
}

/** 严格校验 `docs/feature-map.json` 结构，拦截受跟踪文件内的易变哈希或手工日期字段。 */
export function validateFeatureMap(raw) {
  const errors = []
  const warnings = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['feature-map 根节点必须为 JSON 对象'], warnings }
  }
  if (raw.version !== FEATURE_MAP_VERSION) {
    errors.push(`feature-map version 必须为 ${FEATURE_MAP_VERSION}，收到：${String(raw.version)}`)
  }
  for (const key of FORBIDDEN_TRACKED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      errors.push(`受跟踪 feature-map 根节点禁止包含易变哈希/日期字段 "${key}"`)
    }
  }
  if (!Array.isArray(raw.features)) {
    errors.push('feature-map.features 必须为数组')
    return { ok: false, errors, warnings }
  }
  const seenFeatureIds = new Set()
  const seenToolIds = new Set()
  for (let i = 0; i < raw.features.length; i += 1) {
    const f = raw.features[i]
    if (!f || typeof f !== 'object') { errors.push(`features[${i}] 必须为对象`); continue }
    const fid = String(f.id ?? '').trim()
    if (!fid) errors.push(`features[${i}] 缺少非空 id`)
    else if (seenFeatureIds.has(fid)) errors.push(`重复的 feature id: "${fid}"`)
    else seenFeatureIds.add(fid)

    for (const key of FORBIDDEN_TRACKED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(f, key)) {
        errors.push(`feature "${fid || i}" 禁止在受跟踪 JSON 内写入易变哈希/日期字段 "${key}"`)
      }
    }
    if (!Array.isArray(f.verificationTools)) {
      errors.push(`feature "${fid || i}" 缺少 verificationTools 数组`)
    } else {
      for (const tool of f.verificationTools) {
        if (!tool || typeof tool !== 'object') { errors.push(`feature "${fid || i}" 包含非法 verificationTool 项`); continue }
        const tid = String(tool.id ?? '').trim()
        if (!tid) errors.push(`feature "${fid || i}" 存在缺少 id 的 verificationTool`)
        else if (seenToolIds.has(tid)) errors.push(`重复的 verificationTool id: "${tid}"`)
        else seenToolIds.add(tid)
        if (tool.riskLevel && !VALID_RISK_LEVELS.includes(tool.riskLevel)) {
          errors.push(`tool "${tid}" riskLevel 非法："${tool.riskLevel}"（仅允许 low|medium|high）`)
        }
        for (const key of FORBIDDEN_TRACKED_KEYS) {
          if (Object.prototype.hasOwnProperty.call(tool, key)) {
            errors.push(`tool "${tid || '?'}" 禁止在受跟踪 JSON 内写入易变哈希/日期字段 "${key}"`)
          }
        }
      }
    }
    if (!Array.isArray(f.testRefs)) warnings.push(`feature "${fid || i}" 缺少 testRefs 数组`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 检查并读取 `docs/feature-map.json` 三态（缺失 / 损坏 / 正常），供只读 Fail-Soft 与写入 Fail-Closed 精确区分。 */
export function readFeatureMapStatus(repoRoot) {
  if (!repoRoot) return { exists: false, corrupt: false, featureMap: null, raw: null, error: null }
  const abs = join(repoRoot, FEATURE_MAP_REL)
  if (!existsSync(abs)) return { exists: false, corrupt: false, featureMap: null, raw: null, error: null }
  const text = readTextSafe(abs, 4 * 1024 * 1024)
  if (text === undefined) {
    return { exists: true, corrupt: true, featureMap: null, raw: null, error: `无法读取 ${FEATURE_MAP_REL}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { exists: true, corrupt: true, featureMap: null, raw: null, error: `${FEATURE_MAP_REL} JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.features)) {
    return { exists: true, corrupt: true, featureMap: null, raw: parsed, error: `${FEATURE_MAP_REL} 结构损坏：根节点须为包含 features 数组的对象` }
  }
  return { exists: true, corrupt: false, featureMap: sanitizeFeatureMap(parsed), raw: parsed, error: null }
}

export function readFeatureMap(repoRoot) {
  const st = readFeatureMapStatus(repoRoot)
  return st.corrupt ? null : st.featureMap
}

export function readFeatureMapRaw(repoRoot) {
  if (!repoRoot) return null
  const abs = join(repoRoot, FEATURE_MAP_REL)
  if (!existsSync(abs)) return null
  return readJsonSafe(abs) ?? null
}

export function writeFeatureMap(repoRoot, data) {
  const clean = sanitizeFeatureMap(data)
  const abs = join(repoRoot, FEATURE_MAP_REL)
  writeJsonAtomic(abs, clean)
  return { path: FEATURE_MAP_REL, abs, featureMap: clean }
}

/**
 * 增量合并刷新功能地图：保留用户既有手写条目、名称、业务流与工具配置不被覆盖，
 * 仅补齐新发现的功能、缺失模块与新测试引用（供 repo-map 与后续 govern reconcile 共用）。
 */
export function mergeFeatureMapIncremental(existing, discovered) {
  const base = sanitizeFeatureMap(existing ?? { version: FEATURE_MAP_VERSION, features: [] })
  const incoming = sanitizeFeatureMap(discovered ?? { version: FEATURE_MAP_VERSION, features: [] })
  const merged = base.features.map((f) => ({
    ...f,
    entrypoints: [...f.entrypoints],
    modules: [...f.modules],
    businessFlows: [...f.businessFlows],
    verificationTools: f.verificationTools.map((t) => ({ ...t, triggerHints: [...t.triggerHints] })),
    testRefs: [...f.testRefs],
  }))

  let addedFeatures = 0
  let updatedFeatures = 0
  for (const cand of incoming.features) {
    const match = merged.find((cur) => cur.id === cand.id
      || (cand.entrypoints.length > 0 && cur.entrypoints.some((ep) => cand.entrypoints.includes(ep))))
    if (!match) { merged.push(cand); addedFeatures += 1; continue }
    let changed = false
    for (const ep of cand.entrypoints) { if (!match.entrypoints.includes(ep)) { match.entrypoints.push(ep); changed = true } }
    for (const mod of cand.modules) { if (!match.modules.includes(mod)) { match.modules.push(mod); changed = true } }
    for (const ref of cand.testRefs) { if (!match.testRefs.includes(ref)) { match.testRefs.push(ref); changed = true } }
    if (match.businessFlows.length === 0 && cand.businessFlows.length > 0) {
      match.businessFlows.push(...cand.businessFlows); changed = true
    }
    if (match.verificationTools.length === 0 && cand.verificationTools.length > 0) {
      for (const t of cand.verificationTools) {
        if (!match.verificationTools.some((x) => x.id === t.id)) { match.verificationTools.push(t); changed = true }
      }
    }
    if (changed) updatedFeatures += 1
  }
  return { featureMap: sanitizeFeatureMap({ version: FEATURE_MAP_VERSION, features: merged }), addedFeatures, updatedFeatures }
}

function isRunnableVerifyCommand(cmd) {
  const s = String(cmd ?? '').trim()
  return Boolean(s) && !/^(?:待补充|未配置|none\b)/i.test(s) && !/\(或\s+/.test(s)
}

/** 从 repo-map 产出增量预填 `docs/feature-map.json`（默认只读，传 `{ write: true }` 才落盘）。 */
export function prefillFeatureMapFromRepoMap(repoRoot, repoMap, { write = false } = {}) {
  const discovered = []
  const seen = new Set()
  const testFiles = Array.isArray(repoMap?.testFiles) ? repoMap.testFiles : []
  const highRiskGlobs = repoMap?.devProfile?.highRisk ?? []
  const smokeCmd = repoMap?.devProfile?.smokeVerify ?? null
  const flowsList = Array.isArray(repoMap?.businessFlows?.flows) ? repoMap.businessFlows.flows : []

  const addCandidate = ({ id, name, entrypoints, modules, businessFlows, command, testRefs }) => {
    const cleanId = slugifyFeatureId(id)
    if (seen.has(cleanId)) return
    seen.add(cleanId)
    const epList = uniqPaths(entrypoints)
    const modList = uniqPaths([...epList, ...(modules ?? [])])
    const isHigh = modList.some((m) => highRiskGlobs.some((g) => m.startsWith(g.replace(/\/\*+$/, ''))))
    const verificationTools = isRunnableVerifyCommand(command)
      ? [sanitizeVerificationTool({
          id: `verify-${cleanId}`, kind: command === smokeCmd ? 'smoke' : 'command', command,
          scriptPath: null, riskLevel: isHigh ? 'high' : 'medium', triggerHints: [cleanId, name].filter(Boolean),
        })]
      : []
    discovered.push(sanitizeFeatureEntry({
      id: cleanId, name: name || cleanId, entrypoints: epList, modules: modList,
      businessFlows: uniqStrings(businessFlows), verificationTools, testRefs: uniqPaths(testRefs),
    }))
  }

  for (const fm of Array.isArray(repoMap?.featureMap) ? repoMap.featureMap : []) {
    const src = normRelPath(fm.source)
    if (!src) continue
    const stem = basename(src).replace(/\.[^.]+$/, '')
    const matchedTests = testFiles.filter((t) => t.toLowerCase().includes(stem.toLowerCase())).slice(0, 6)
    const relatedFlows = flowsList
      .filter((fl) => normRelPath(fl.entry) === src || normRelPath(fl.source) === src)
      .map((fl) => `[${fl.surface}] ${fl.name} (${fl.entry})`)
    addCandidate({
      id: stem, name: fm.feature || stem, entrypoints: [src], modules: [src],
      businessFlows: relatedFlows.length > 0 ? relatedFlows : [`${fm.feature || stem} 主入口 (${src})`],
      command: fm.verifyCmd, testRefs: matchedTests,
    })
  }
  for (const fl of flowsList) {
    const ep = normRelPath(fl.entry)
    if (!ep) continue
    const stem = basename(ep).replace(/\.[^.]+$/, '')
    if (seen.has(slugifyFeatureId(stem))) continue
    const matchedTests = testFiles.filter((t) => t.toLowerCase().includes(stem.toLowerCase())).slice(0, 6)
    addCandidate({
      id: stem, name: fl.name || stem, entrypoints: [ep], modules: [ep],
      businessFlows: [`[${fl.surface}] ${fl.name} (${ep})`],
      command: smokeCmd ?? repoMap?.preferredVerifyCommands?.[0]?.command ?? null, testRefs: matchedTests,
    })
  }

  const existing = readFeatureMap(repoRoot)
  const merged = mergeFeatureMapIncremental(existing, { version: FEATURE_MAP_VERSION, features: discovered })
  let written = false
  if (write) { writeFeatureMap(repoRoot, merged.featureMap); written = true }
  return { ...merged, existed: Boolean(existing), written, path: FEATURE_MAP_REL }
}

function pathMatchesFeatureEntry(changedFile, entry) {
  const cf = normRelPath(changedFile)
  const pat = normRelPath(entry)
  if (!cf || !pat) return false
  if (cf === pat) return true
  if (pat.endsWith('/') && cf.startsWith(pat)) return true
  return false
}

/** 按变更文件反查受波及的功能切片（机读按需切片，绝不向调用方灌整张地图）。 */
export function findAffectedFeatures(featureMap, changedFiles = []) {
  const files = uniqPaths(changedFiles)
  const features = Array.isArray(featureMap?.features) ? featureMap.features : []
  const matchedFeatures = []
  const matchedFileSet = new Set()
  const tools = []
  const testRefs = []
  const businessFlows = []

  for (const f of features) {
    const hitFiles = files.filter((cf) => (
      (f.entrypoints ?? []).some((e) => pathMatchesFeatureEntry(cf, e))
      || (f.modules ?? []).some((m) => pathMatchesFeatureEntry(cf, m))
      || (f.testRefs ?? []).some((t) => pathMatchesFeatureEntry(cf, t))
      || (f.verificationTools ?? []).some((vt) => vt.scriptPath && pathMatchesFeatureEntry(cf, vt.scriptPath))
    ))
    if (hitFiles.length === 0) continue
    for (const hf of hitFiles) matchedFileSet.add(hf)
    matchedFeatures.push({ ...f, matchedFiles: hitFiles })
    for (const vt of f.verificationTools ?? []) tools.push({ featureId: f.id, featureName: f.name, tool: vt })
    for (const tr of f.testRefs ?? []) { if (!testRefs.includes(tr)) testRefs.push(tr) }
    for (const bf of f.businessFlows ?? []) { if (!businessFlows.includes(bf)) businessFlows.push(bf) }
  }
  return { matchedFeatures, unmatchedFiles: files.filter((f) => !matchedFileSet.has(f)), tools, testRefs, businessFlows }
}

/**
 * 通用纯查询函数（供 review-context、handoff-package、doc-plan triage 统一复用）：
 * 按路径与关键词查询 `docs/feature-map.json` 受波及切片；缺文件时安全返回空结构不报错。
 */
export function matchFeatureMapForPaths(repoRoot, paths = [], keywords = []) {
  const status = readFeatureMapStatus(repoRoot)
  if (!status.exists) {
    return { exists: false, corrupt: false, warning: null, matchedFeatures: [], businessFlows: [], verificationTools: [], testRefs: [] }
  }
  if (status.corrupt || !status.featureMap) {
    return {
      exists: true,
      corrupt: true,
      warning: status.error ?? `${FEATURE_MAP_REL} 损坏，已 Fail-Soft 返回空切片`,
      matchedFeatures: [],
      businessFlows: [],
      verificationTools: [],
      testRefs: [],
    }
  }
  const map = status.featureMap
  if (!Array.isArray(map.features) || map.features.length === 0) {
    return { exists: true, corrupt: false, warning: null, matchedFeatures: [], businessFlows: [], verificationTools: [], testRefs: [] }
  }

  const normPaths = uniqPaths(paths)
  const kwList = uniqStrings(keywords).map((k) => k.toLowerCase()).filter((k) => k.length >= 2)
  const pathHit = normPaths.length > 0 ? findAffectedFeatures(map, normPaths) : { matchedFeatures: [] }
  const matchedById = new Map()
  for (const mf of pathHit.matchedFeatures) matchedById.set(mf.id, { ...mf, matchedBy: ['path'] })

  if (kwList.length > 0) {
    for (const f of map.features) {
      const hay = [
        f.id, f.name, ...(f.entrypoints ?? []), ...(f.modules ?? []),
        ...(f.businessFlows ?? []), ...(f.verificationTools ?? []).flatMap((t) => [t.id, ...(t.triggerHints ?? [])]),
      ].join(' ').toLowerCase()
      const hitKws = kwList.filter((kw) => hay.includes(kw))
      if (hitKws.length === 0) continue
      const cur = matchedById.get(f.id)
      if (cur) {
        cur.matchedBy = uniqStrings([...cur.matchedBy, 'keyword'])
        cur.matchedKeywords = hitKws
      } else {
        matchedById.set(f.id, { ...f, matchedFiles: [], matchedBy: ['keyword'], matchedKeywords: hitKws })
      }
    }
  }

  const matchedFeatures = [...matchedById.values()]
  const businessFlows = uniqStrings(matchedFeatures.flatMap((f) => f.businessFlows ?? []))
  const testRefs = uniqPaths(matchedFeatures.flatMap((f) => f.testRefs ?? []))
  const seenToolIds = new Set()
  const verificationTools = []
  for (const f of matchedFeatures) {
    for (const t of f.verificationTools ?? []) {
      if (seenToolIds.has(t.id)) continue
      seenToolIds.add(t.id)
      verificationTools.push({ featureId: f.id, featureName: f.name, ...t })
    }
  }
  return { exists: true, corrupt: false, warning: null, matchedFeatures, businessFlows, verificationTools, testRefs }
}
