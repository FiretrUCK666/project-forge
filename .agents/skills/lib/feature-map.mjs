/**
 * feature-map.mjs —— 机读唯一功能地图（docs/feature-map.json）Schema、读写、增量合并、
 * 路径与关键词切片查询（matchFeatureMapForPaths）及仓外验证状态统一导出。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-explore、dev-verify-tools、dev-review、dev-flow、dev-plan 共用。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'

import {
  FORBIDDEN_TRACKED_KEYS,
  SUPPORTED_FEATURE_MAP_VERSIONS,
  buildFallbackDomains,
  computeFeatureMapCanonicalSha256,
  computeFeatureMapFingerprint,
  hasFeatureMapV2Signals,
  isValidFeaturePath,
  normRelPath,
  sanitizeDomainEntry,
  sanitizeFlowEntry,
  sliceFeatureMapContext,
  slugifyFeatureId,
  uniqPaths,
  uniqStrings,
  validateFeatureMapTopology,
  verifyArchitectureMapHeader,
} from './feature-map-graph.mjs'
import { posixPath, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import { splitCommandSegments, validateExecutableCommandShape } from './command-lex.mjs'
import { isTestOrFixtureFile } from './static-gates.mjs'
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
  syncVerifyCacheOnMerge,
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
  syncVerifyCacheOnMerge,
  validateE2eEvidenceText,
  writeVerifyCacheEntry,
}

export {
  FORBIDDEN_TRACKED_KEYS,
  SUPPORTED_FEATURE_MAP_VERSIONS,
  buildFallbackDomains,
  computeFeatureMapCanonicalSha256,
  computeFeatureMapFingerprint,
  sanitizeDomainEntry,
  sanitizeFlowEntry,
  sliceFeatureMapContext,
  slugifyFeatureId,
  validateFeatureMapTopology,
  verifyArchitectureMapHeader,
}
export const FEATURE_MAP_REL = 'docs/feature-map.json'
export const FEATURE_MAP_VERSION = 1
export const VALID_TOOL_KINDS = Object.freeze(['script', 'command', 'e2e', 'smoke', 'probe'])

const CORE_FEATURE_KEYS = new Set([
  'id', 'name', 'entrypoints', 'modules', 'businessFlows', 'verificationTools', 'testRefs',
  'docAnchors', 'domain', 'dependsOn', 'actors', ...FORBIDDEN_TRACKED_KEYS,
])

function sanitizeToolCommand(raw) {
  if (!raw) return null
  const text = String(raw).trim()
  if (!text) return null
  if (validateExecutableCommandShape(text, { allowNone: false }).ok) return text
  for (const seg of splitCommandSegments(text)) {
    if (validateExecutableCommandShape(seg, { allowNone: false }).ok) return seg
  }
  return null
}

export function sanitizeVerificationTool(tool) {
  const id = slugifyFeatureId(tool?.id ?? tool?.scriptPath ?? tool?.command ?? 'tool')
  const kindRaw = String(tool?.kind ?? (tool?.scriptPath ? 'script' : 'command')).trim().toLowerCase()
  const kind = VALID_TOOL_KINDS.includes(kindRaw) ? kindRaw : 'command'
  const riskRaw = String(tool?.riskLevel ?? 'medium').trim().toLowerCase()
  const riskLevel = VALID_RISK_LEVELS.includes(riskRaw) ? riskRaw : 'medium'
  const command = sanitizeToolCommand(tool?.command)
  const scriptPath = tool?.scriptPath ? normRelPath(tool.scriptPath) : null
  const triggerHints = uniqStrings(tool?.triggerHints)
  return { id, kind, command, scriptPath, riskLevel, triggerHints }
}

export function sanitizeFeatureEntry(entry) {
  const id = slugifyFeatureId(entry?.id ?? entry?.name ?? 'feature')
  const name = String(entry?.name ?? id).trim() || id
  const entrypoints = uniqPaths(entry?.entrypoints, { strictFeaturePath: true })
  const modules = uniqPaths(entry?.modules?.length ? entry.modules : entrypoints, { strictFeaturePath: true })
  const businessFlows = uniqStrings(entry?.businessFlows)
  const seenTools = new Set()
  const verificationTools = []
  for (const rawTool of Array.isArray(entry?.verificationTools) ? entry.verificationTools : []) {
    const clean = sanitizeVerificationTool(rawTool)
    if (seenTools.has(clean.id)) continue
    seenTools.add(clean.id)
    verificationTools.push(clean)
  }
  const testRefs = uniqPaths(entry?.testRefs, { strictFeaturePath: true })
  const out = { id, name, entrypoints, modules, businessFlows, verificationTools, testRefs }
  if (Array.isArray(entry?.docAnchors)) out.docAnchors = uniqStrings(entry.docAnchors)
  if (typeof entry?.domain === 'string' && entry.domain.trim()) out.domain = entry.domain.trim()
  if (Array.isArray(entry?.dependsOn)) out.dependsOn = uniqStrings(entry.dependsOn)
  if (Array.isArray(entry?.actors)) out.actors = uniqStrings(entry.actors)
  if (entry && typeof entry === 'object') {
    for (const [k, v] of Object.entries(entry)) {
      if (CORE_FEATURE_KEYS.has(k) || v === undefined) continue
      out[k] = v
    }
  }
  return out
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
  const domains = []
  const seenDomIds = new Set()
  for (const item of Array.isArray(raw?.domains) ? raw.domains : []) {
    const clean = sanitizeDomainEntry(item)
    if (seenDomIds.has(clean.id)) continue
    seenDomIds.add(clean.id)
    domains.push(clean)
  }
  const flows = []
  const seenFlowIds = new Set()
  for (const item of Array.isArray(raw?.flows) ? raw.flows : []) {
    const clean = sanitizeFlowEntry(item)
    if (seenFlowIds.has(clean.id)) continue
    seenFlowIds.add(clean.id)
    flows.push(clean)
  }
  const isV2 = hasFeatureMapV2Signals({ ...raw, features, domains, flows })
  if (!isV2) return { version: FEATURE_MAP_VERSION, features }
  return {
    version: 2,
    ...(domains.length > 0 || Array.isArray(raw?.domains) ? { domains } : {}),
    features,
    ...(flows.length > 0 || Array.isArray(raw?.flows) ? { flows } : {}),
  }
}

/** 严格校验 `docs/feature-map.json` 结构，拦截受跟踪文件内的易变哈希或手工日期字段。 */
export function validateFeatureMap(raw) {
  const errors = []
  const warnings = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['feature-map 根节点必须为 JSON 对象'], warnings }
  }
  if (!SUPPORTED_FEATURE_MAP_VERSIONS.includes(raw.version)) {
    errors.push(`feature-map version 必须为 ${SUPPORTED_FEATURE_MAP_VERSIONS.join(' 或 ')}，收到：${String(raw.version)}`)
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
    for (const field of ['entrypoints', 'modules', 'testRefs']) {
      if (!Array.isArray(f[field])) continue
      for (const rawPath of f[field]) {
        const s = String(rawPath ?? '').trim()
        if (!s || /\s/.test(s)) {
          errors.push(`feature "${fid || i}" ${field} 包含含空白或符号后缀的非法路径："${s}"`)
        }
      }
    }
    if (!Array.isArray(f.testRefs)) warnings.push(`feature "${fid || i}" 缺少 testRefs 数组`)
  }
  const topo = validateFeatureMapTopology(raw)
  for (const err of topo.errors) {
    if (!errors.includes(err)) errors.push(err)
  }
  for (const w of topo.warnings) {
    if (!warnings.includes(w)) warnings.push(w)
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
    ...(Array.isArray(f.docAnchors) ? { docAnchors: [...f.docAnchors] } : {}),
    ...(Array.isArray(f.dependsOn) ? { dependsOn: [...f.dependsOn] } : {}),
    ...(Array.isArray(f.actors) ? { actors: [...f.actors] } : {}),
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
    if (!match.domain && cand.domain) { match.domain = cand.domain; changed = true }
    // 显式声明 `dependsOn: []` 的叶子节点不得被自动推断覆盖
    if (!Array.isArray(match.dependsOn) && Array.isArray(cand.dependsOn) && cand.dependsOn.length > 0) {
      match.dependsOn = [...cand.dependsOn]; changed = true
    }
    if ((!Array.isArray(match.actors) || match.actors.length === 0) && Array.isArray(cand.actors) && cand.actors.length > 0) {
      match.actors = [...cand.actors]; changed = true
    }
    if ((!Array.isArray(match.docAnchors) || match.docAnchors.length === 0) && Array.isArray(cand.docAnchors) && cand.docAnchors.length > 0) {
      match.docAnchors = [...cand.docAnchors]; changed = true
    }
    if (changed) updatedFeatures += 1
  }

  const mergedDomains = Array.isArray(base.domains) ? base.domains.map((d) => ({ ...d })) : []
  for (const dom of Array.isArray(incoming.domains) ? incoming.domains : []) {
    if (!mergedDomains.some((cur) => cur.id === dom.id)) mergedDomains.push(dom)
  }
  const mergedFlows = Array.isArray(base.flows) ? base.flows.map((fl) => ({ ...fl })) : []
  for (const fl of Array.isArray(incoming.flows) ? incoming.flows : []) {
    if (!mergedFlows.some((cur) => cur.id === fl.id)) mergedFlows.push(fl)
  }
  const hasV2 = base.version === 2 || incoming.version === 2 || mergedDomains.length > 0 || mergedFlows.length > 0
  const rawMerged = {
    version: hasV2 ? 2 : FEATURE_MAP_VERSION,
    ...(hasV2 ? { domains: mergedDomains } : {}),
    features: merged,
    ...(hasV2 ? { flows: mergedFlows } : {}),
  }
  return { featureMap: sanitizeFeatureMap(rawMerged), addedFeatures, updatedFeatures }
}

const ECO_BY_EXT = new Map([
  ...['js', 'mjs', 'cjs', 'mts', 'cts', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'astro'].map((e) => [e, 'jsts']),
  ['py', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ...['java', 'kt', 'kts', 'scala', 'groovy'].map((e) => [e, 'jvm']),
  ...['cs', 'fs', 'vb'].map((e) => [e, 'dotnet']),
  ['rb', 'ruby'],
  ['php', 'php'],
  ['swift', 'swift'],
  ['dart', 'dart'],
  ...['c', 'cc', 'cpp', 'cxx', 'h', 'hpp'].map((e) => [e, 'cpp']),
  ...['sh', 'bash', 'zsh', 'ps1'].map((e) => [e, 'shell']),
])

function ecosystemOfPath(relPath) {
  const ext = posixPath(relPath).split('.').pop()?.toLowerCase() ?? ''
  return ECO_BY_EXT.get(ext) ?? null
}

function testBaseStemOf(relPath) {
  const base = basename(posixPath(relPath))
  const noExt = base.replace(/\.[^.]+$/, '')
  return noExt
    .replace(/\.(?:test|spec)$/i, '')
    .replace(/(?:_test|_unittest|_spec)$/i, '')
    .replace(/(?:Tests?|IT)$/, '')
    .replace(/^test_/i, '')
    .toLowerCase()
}

export function isNonFeatureArtifactPath(relPath) {
  const p = normRelPath(relPath)
  if (!p) return true
  if (/^(?:dist|build|coverage|\.github|\.agents|\.worktrees|node_modules)\//i.test(p)) return true
  return isTestOrFixtureFile(p)
}

/** 按同生态边界与文件名/路径词边界匹配源码对应的测试文件。 */
export function matchTestsForSourceFile(srcPath, testFiles = []) {
  const srcNorm = normRelPath(srcPath)
  if (!srcNorm) return []
  const srcEco = ecosystemOfPath(srcNorm)
  const rawStem = basename(srcNorm).replace(/\.[^.]+$/, '').toLowerCase()
  if (!rawStem) return []
  const escaped = rawStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordRe = new RegExp(`(?:^|[._-])${escaped}(?:$|[._-])`, 'i')

  return (Array.isArray(testFiles) ? testFiles : []).filter((rawTest) => {
    const tNorm = normRelPath(rawTest)
    if (!tNorm) return false
    const testEco = ecosystemOfPath(tNorm)
    if (srcEco && testEco && srcEco !== testEco) return false
    const tStem = testBaseStemOf(tNorm)
    if (!tStem) return false
    if (rawStem.length <= 2) return tStem === rawStem
    return tStem === rawStem || wordRe.test(tStem)
  })
}

function isRunnableVerifyCommand(cmd) {
  return validateExecutableCommandShape(cmd, { allowNone: false }).ok
}

/** 从 repo-map 产出增量预填 `docs/feature-map.json`（默认只读，传 `{ write: true }` 才落盘）。 */
export function prefillFeatureMapFromRepoMap(repoRoot, repoMap, { write = false, topology = null } = {}) {
  const discovered = []
  const seen = new Set()
  const testFiles = Array.isArray(repoMap?.testFiles) ? repoMap.testFiles : []
  const highRiskGlobs = repoMap?.devProfile?.highRisk ?? []
  const smokeCmd = repoMap?.devProfile?.smokeVerify ?? null
  const flowsList = Array.isArray(repoMap?.businessFlows?.flows) ? repoMap.businessFlows.flows : []
  const topo = topology ?? repoMap?.featureTopology ?? null
  const domainByFeature = topo?.domainByFeatureId ?? {}
  const dependsOnByFeature = topo?.dependsOnByFeatureId ?? {}
  const discoveredDomains = Array.isArray(topo?.domains) ? topo.domains : []

  const addCandidate = ({ id, name, entrypoints, modules, businessFlows, command, testRefs }) => {
    const cleanId = slugifyFeatureId(id)
    if (seen.has(cleanId)) return
    seen.add(cleanId)
    const epList = uniqPaths(entrypoints, { strictFeaturePath: true })
    const modList = uniqPaths([...epList, ...(modules ?? [])], { strictFeaturePath: true })
    const isHigh = modList.some((m) => highRiskGlobs.some((g) => m.startsWith(g.replace(/\/\*+$/, ''))))
    const verificationTools = isRunnableVerifyCommand(command)
      ? [sanitizeVerificationTool({
          id: `verify-${cleanId}`, kind: command === smokeCmd ? 'smoke' : 'command', command,
          scriptPath: null, riskLevel: isHigh ? 'high' : 'medium', triggerHints: [cleanId, name].filter(Boolean),
        })]
      : []
    const domId = domainByFeature[cleanId] ?? null
    const deps = Array.isArray(dependsOnByFeature[cleanId]) ? dependsOnByFeature[cleanId] : null
    discovered.push(sanitizeFeatureEntry({
      id: cleanId, name: name || cleanId, entrypoints: epList, modules: modList,
      businessFlows: uniqStrings(businessFlows), verificationTools, testRefs: uniqPaths(testRefs),
      ...(domId ? { domain: domId } : {}),
      ...(deps ? { dependsOn: deps } : {}),
    }))
  }

  for (const fm of Array.isArray(repoMap?.featureMap) ? repoMap.featureMap : []) {
    const rawSource = String(fm.source ?? '').trim()
    const src = normRelPath(rawSource)
    if (!isValidFeaturePath(src) || isNonFeatureArtifactPath(src)) continue
    const extraSources = Array.isArray(fm.sources)
      ? fm.sources.map((p) => normRelPath(p)).filter((p) => isValidFeaturePath(p) && !isNonFeatureArtifactPath(p))
      : []
    const allSources = uniqPaths([src, ...extraSources], { strictFeaturePath: true })
    const rawNorm = posixPath(rawSource).replace(/^['"`]+|['"`]+$/g, '').replace(/^\.\//, '').replace(/^\/+/, '')
    const inlineSym = rawNorm.startsWith(src) && rawNorm.length > src.length
      ? rawNorm.slice(src.length).replace(/^['"`\s]+/, '').trim()
      : ''
    const symbols = Array.isArray(fm.symbols) && fm.symbols.length > 0
      ? fm.symbols
      : (inlineSym ? [inlineSym] : [])
    const stem = basename(src).replace(/\.[^.]+$/, '')
    const matchedTests = matchTestsForSourceFile(src, testFiles).slice(0, 6)
    const relatedFlows = flowsList
      .filter((fl) => normRelPath(fl.entry) === src || normRelPath(fl.source) === src)
      .map((fl) => `[${fl.surface}] ${fl.name} (${fl.entry})`)
    const defaultFlow = symbols.length > 0
      ? `${fm.feature || stem} 主入口 (${src}: ${symbols.join(', ')})`
      : `${fm.feature || stem} 主入口 (${src})`
    addCandidate({
      id: stem, name: fm.feature || stem, entrypoints: allSources, modules: allSources,
      businessFlows: relatedFlows.length > 0 ? relatedFlows : [defaultFlow],
      command: fm.verifyCmd, testRefs: matchedTests,
    })
  }
  for (const fl of flowsList) {
    const ep = normRelPath(fl.entry)
    if (isNonFeatureArtifactPath(ep)) continue
    const stem = basename(ep).replace(/\.[^.]+$/, '')
    if (seen.has(slugifyFeatureId(stem))) continue
    const matchedTests = matchTestsForSourceFile(ep, testFiles).slice(0, 6)
    addCandidate({
      id: stem, name: fl.name || stem, entrypoints: [ep], modules: [ep],
      businessFlows: [`[${fl.surface}] ${fl.name} (${ep})`],
      command: smokeCmd ?? repoMap?.preferredVerifyCommands?.[0]?.command ?? null, testRefs: matchedTests,
    })
  }

  const finalDomains = discoveredDomains.length > 0
    ? discoveredDomains
    : (discovered.length > 0 && (Array.isArray(repoMap?.packages) || Array.isArray(repoMap?.topDirectories))
        ? buildFallbackDomains(discovered).map((d) => ({ id: d.id, name: d.name }))
        : [])
  if (finalDomains.length > 0 && discoveredDomains.length === 0) {
    const domByFeat = new Map()
    for (const fd of buildFallbackDomains(discovered)) {
      for (const fid of fd.featureIds) domByFeat.set(fid, fd.id)
    }
    for (const f of discovered) {
      if (!f.domain && domByFeat.has(f.id)) f.domain = domByFeat.get(f.id)
    }
  }
  const hasV2 = finalDomains.length > 0 || discovered.some((f) => Boolean(f.domain) || (f.dependsOn?.length ?? 0) > 0)
  const incomingDoc = hasV2
    ? { version: 2, domains: finalDomains, features: discovered, flows: [] }
    : { version: FEATURE_MAP_VERSION, features: discovered }

  const existing = readFeatureMap(repoRoot)
  const merged = mergeFeatureMapIncremental(existing, incomingDoc)
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

/**
 * 按标准 JSON Schema（兼容 v1/v2）无损读取 `docs/feature-map.json`，
 * 缺失或格式异常时优雅降级不抛错，供 flow/govern/iterate 共用。
 */
export function readFeatureMapSafe(repoRoot) {
  const abs = join(repoRoot, FEATURE_MAP_REL)
  if (!existsSync(abs)) {
    return {
      present: false, valid: false, path: FEATURE_MAP_REL, data: null,
      version: null, domains: [], features: [], flows: [], businessFlows: [],
    }
  }
  const parsed = readJsonSafe(abs, 4 * 1024 * 1024)
  if (!parsed || typeof parsed !== 'object') {
    return {
      present: true, valid: false, path: FEATURE_MAP_REL, data: null,
      version: null, domains: [], features: [], flows: [], businessFlows: [],
    }
  }
  const features = Array.isArray(parsed.features)
    ? parsed.features.filter((f) => f && typeof f === 'object')
    : (Array.isArray(parsed) ? parsed.filter((f) => f && typeof f === 'object') : [])
  const domains = Array.isArray(parsed.domains)
    ? parsed.domains.filter((d) => d && typeof d === 'object')
    : []
  const flows = Array.isArray(parsed.flows)
    ? parsed.flows.filter((fl) => fl && typeof fl === 'object')
    : []
  const topFlows = Array.isArray(parsed.businessFlows) ? parsed.businessFlows : []
  const nestedFlows = features.flatMap((f) => (Array.isArray(f.businessFlows) ? f.businessFlows : []))
  const businessFlows = [...new Set([...topFlows, ...nestedFlows].filter(Boolean))]
  const version = parsed.version ?? parsed.schemaVersion ?? (hasFeatureMapV2Signals(parsed) ? 2 : 1)
  return {
    present: true,
    valid: true,
    path: FEATURE_MAP_REL,
    data: parsed,
    version,
    domains,
    features,
    flows,
    businessFlows,
  }
}

/** 将新生成测试路径增量挂回 `docs/feature-map.json` 对应 feature 的 `testRefs`（无损保留 v1/v2 全部既有字段）。 */
export function updateFeatureMapTestRefs(repoRoot, { featureIds = [], modulePaths = [], testPaths = [] } = {}) {
  const cleanTests = [...new Set((testPaths ?? []).map((p) => posixPath(p).replace(/^\.\//, '')).filter(Boolean))]
  if (cleanTests.length === 0) return { updated: false, reason: 'no-test-paths', matchedFeatures: [], addedRefs: [] }
  const loaded = readFeatureMapSafe(repoRoot)
  if (!loaded.present) return { updated: false, reason: 'feature-map-absent', matchedFeatures: [], addedRefs: [] }
  if (!loaded.valid || !loaded.data || !Array.isArray(loaded.data.features)) {
    return { updated: false, reason: 'feature-map-invalid', matchedFeatures: [], addedRefs: [] }
  }

  const wantedIds = new Set((featureIds ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))
  const normMods = (modulePaths ?? []).map((p) => posixPath(p).replace(/^\.\//, '').toLowerCase()).filter(Boolean)
  const matchedFeatures = []
  const addedRefs = []

  for (const feat of loaded.data.features) {
    const fId = String(feat.id ?? feat.name ?? '').trim().toLowerCase()
    const fFiles = [
      ...(Array.isArray(feat.entrypoints) ? feat.entrypoints : []),
      ...(Array.isArray(feat.modules) ? feat.modules : []),
      ...(Array.isArray(feat.entryFiles) ? feat.entryFiles : []),
      ...(Array.isArray(feat.files) ? feat.files : []),
      ...(Array.isArray(feat.paths) ? feat.paths : []),
      ...(feat.entry ? [feat.entry] : []),
    ].map((p) => posixPath(p).replace(/^\.\//, '').toLowerCase())

    const byId = fId && wantedIds.has(fId)
    const byPath = normMods.some((mp) => fFiles.some((ff) => ff === mp || ff.startsWith(`${mp}/`) || mp.startsWith(`${ff}/`) || posix.dirname(ff) === posix.dirname(mp)))
    if (!byId && !byPath) continue

    const curRefs = Array.isArray(feat.testRefs) ? feat.testRefs.map((r) => posixPath(r)) : []
    const refSet = new Set(curRefs)
    let featChanged = false
    for (const tp of cleanTests) {
      if (!refSet.has(tp)) {
        curRefs.push(tp)
        refSet.add(tp)
        addedRefs.push(tp)
        featChanged = true
      }
    }
    if (featChanged) {
      feat.testRefs = curRefs
      matchedFeatures.push(feat.id ?? feat.name ?? 'unnamed')
    }
  }

  if (matchedFeatures.length === 0) {
    return { updated: false, reason: 'no-matching-feature-or-already-linked', matchedFeatures: [], addedRefs: [] }
  }

  const abs = join(repoRoot, FEATURE_MAP_REL)
  mkdirSync(dirname(abs), { recursive: true })
  writeJsonAtomic(abs, loaded.data)
  return { updated: true, path: FEATURE_MAP_REL, matchedFeatures, addedRefs: [...new Set(addedRefs)] }
}
