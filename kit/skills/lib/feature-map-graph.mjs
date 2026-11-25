/**
 * feature-map-graph.mjs —— feature-map v2 层次拓扑校验、DFS 判环、规范化指纹、
 * 合成域视图与低 token 分层上下文切片叶子内核。
 *
 * 严格零上游业务依赖：仅导入 `node:*` 内置模块与 `./git-core.mjs`（绝不导入 `feature-map.mjs` 或 `static-gates.mjs`）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { posixPath, readJsonSafe, readTextSafe, sha256Text } from './git-core.mjs'

export const SUPPORTED_FEATURE_MAP_VERSIONS = Object.freeze([1, 2])
export const FORBIDDEN_TRACKED_KEYS = Object.freeze([
  'symbolHash', 'moduleTreeHash', 'verifiedSha', 'passedAtCommit',
  'lastVerifiedDate', 'verifiedAt', 'contentHash', 'treeHash', 'symbolsByFile',
])

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_TRACKED_KEYS)
const PATH_WITH_SYMBOL_RE = /^([^\s'"`()<>]+(?:\.[A-Za-z0-9]{1,12}|\/))['"`]?(?:\s+.*|\s*\([^)]*\).*)$/
const ARCH_HEADER_SHA_RE = /^<!--\s*@generated\b[^>]*\bfeature-map-sha256=([0-9a-f]{64})\b[^>]*-->/i

export function normRelPath(p) {
  let s = posixPath(String(p ?? '').trim()).replace(/^['"`]+/, '')
  const m = PATH_WITH_SYMBOL_RE.exec(s)
  if (m && (m[1].includes('/') || /\.[A-Za-z0-9]{1,12}$/.test(m[1]))) {
    s = m[1]
  } else {
    s = s.replace(/['"`]+$/, '')
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '')
}

export function isValidFeaturePath(normPath) {
  if (!normPath || /\s/.test(normPath)) return false
  return !normPath.includes('..') && !/[<>*?`'"|]/.test(normPath)
}

export function uniqStrings(arr) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = String(item ?? '').trim()
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

export function uniqPaths(arr, { strictFeaturePath = false } = {}) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = normRelPath(item)
    if (!s) continue
    if (strictFeaturePath && !isValidFeaturePath(s)) continue
    if (!seen.has(s)) { seen.add(s); out.push(s) }
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

function scanForbiddenKeysOnObject(obj, label, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
  for (const key of FORBIDDEN_TRACKED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`${label} 禁止在受跟踪 JSON 内写入易变哈希/日期字段 "${key}"`)
    }
  }
}

function validatePathList(arr, label, errors) {
  if (!Array.isArray(arr)) return
  for (const rawPath of arr) {
    const s = String(rawPath ?? '').trim()
    if (!s || /\s/.test(s)) {
      errors.push(`${label} 包含含空白或符号后缀的非法路径："${s}"`)
    }
  }
}

export function sanitizeDomainEntry(domain) {
  const id = slugifyFeatureId(domain?.id ?? domain?.name ?? 'domain')
  const name = String(domain?.name ?? id).trim() || id
  const out = { id, name }
  if (typeof domain?.description === 'string' && domain.description.trim()) {
    out.description = domain.description.trim()
  }
  const entrypoints = uniqPaths(domain?.entrypoints, { strictFeaturePath: true })
  if (entrypoints.length > 0 || Array.isArray(domain?.entrypoints)) out.entrypoints = entrypoints
  const docAnchors = uniqStrings(domain?.docAnchors)
  if (docAnchors.length > 0 || Array.isArray(domain?.docAnchors)) out.docAnchors = docAnchors
  return out
}

export function sanitizeFlowEntry(flow) {
  const id = slugifyFeatureId(flow?.id ?? flow?.name ?? 'flow')
  const name = String(flow?.name ?? id).trim() || id
  const actors = uniqStrings(flow?.actors)
  const features = uniqStrings(flow?.features)
  const out = { id, name, actors, features }
  if (Array.isArray(flow?.steps)) {
    out.steps = flow.steps
      .filter((st) => st && typeof st === 'object')
      .map((st) => {
        const cleanStep = {}
        if (typeof st.feature === 'string' && st.feature.trim()) cleanStep.feature = st.feature.trim()
        if (typeof st.action === 'string' && st.action.trim()) cleanStep.action = st.action.trim()
        if (typeof st.actor === 'string' && st.actor.trim()) cleanStep.actor = st.actor.trim()
        if (Array.isArray(st.branches)) {
          cleanStep.branches = st.branches
            .filter((br) => br && typeof br === 'object')
            .map((br) => {
              const cleanBr = {}
              if (typeof br.when === 'string' && br.when.trim()) cleanBr.when = br.when.trim()
              if (typeof br.condition === 'string' && br.condition.trim()) cleanBr.condition = br.condition.trim()
              if (typeof br.label === 'string' && br.label.trim()) cleanBr.label = br.label.trim()
              if (typeof br.fromFeature === 'string' && br.fromFeature.trim()) cleanBr.fromFeature = br.fromFeature.trim()
              if (typeof br.toFeature === 'string' && br.toFeature.trim()) cleanBr.toFeature = br.toFeature.trim()
              return cleanBr
            })
        }
        return cleanStep
      })
  }
  if (Array.isArray(flow?.branches)) {
    out.branches = flow.branches
      .filter((br) => br && typeof br === 'object')
      .map((br) => {
        const cleanBr = {}
        if (typeof br.when === 'string' && br.when.trim()) cleanBr.when = br.when.trim()
        if (typeof br.condition === 'string' && br.condition.trim()) cleanBr.condition = br.condition.trim()
        if (typeof br.label === 'string' && br.label.trim()) cleanBr.label = br.label.trim()
        if (typeof br.fromFeature === 'string' && br.fromFeature.trim()) cleanBr.fromFeature = br.fromFeature.trim()
        if (typeof br.toFeature === 'string' && br.toFeature.trim()) cleanBr.toFeature = br.toFeature.trim()
        return cleanBr
      })
  }
  const docAnchors = uniqStrings(flow?.docAnchors)
  if (docAnchors.length > 0 || Array.isArray(flow?.docAnchors)) out.docAnchors = docAnchors
  return out
}

export function hasFeatureMapV2Signals(raw) {
  if (!raw || typeof raw !== 'object') return false
  if (raw.version === 2) return true
  if (Array.isArray(raw.domains) && raw.domains.length > 0) return true
  if (Array.isArray(raw.flows) && raw.flows.length > 0) return true
  const features = Array.isArray(raw.features) ? raw.features : []
  return features.some((f) => f && typeof f === 'object' && (
    (typeof f.domain === 'string' && f.domain.trim().length > 0)
    || (Array.isArray(f.dependsOn) && f.dependsOn.length > 0)
    || (Array.isArray(f.actors) && f.actors.length > 0)
  ))
}

function collectFlowBranchRefs(flow) {
  const refs = []
  if (Array.isArray(flow?.branches)) {
    for (let j = 0; j < flow.branches.length; j += 1) {
      refs.push({ branch: flow.branches[j], label: `branches[${j}]` })
    }
  }
  if (Array.isArray(flow?.steps)) {
    for (let j = 0; j < flow.steps.length; j += 1) {
      const st = flow.steps[j]
      if (Array.isArray(st?.branches)) {
        for (let k = 0; k < st.branches.length; k += 1) {
          refs.push({ branch: st.branches[k], label: `steps[${j}].branches[${k}]` })
        }
      }
    }
  }
  return refs
}

/**
 * 校验 feature-map v2 拓扑完整性：
 * 1. `domains[]` 与 `flows[]` ID 唯一性及 `FORBIDDEN_TRACKED_KEYS`（含 nested steps/branches）；
 * 2. 悬空 `feature.domain`、悬空/自环 `feature.dependsOn[]`；
 * 3. 悬空 `flows[].features[]`、`flows[].steps[].feature` 与 `branches[].toFeature`；
 * 4. 三色 DFS 检测 `dependsOn[]` 有向环并返回完整环链。
 */
export function validateFeatureMapTopology(raw) {
  const errors = []
  const warnings = []
  const cycles = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['feature-map 根节点必须为 JSON 对象'], warnings, cycles }
  }

  const domainIds = new Set()
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains)) {
      errors.push('feature-map.domains 必须为数组')
    } else {
      for (let i = 0; i < raw.domains.length; i += 1) {
        const d = raw.domains[i]
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
          errors.push(`domains[${i}] 必须为对象`)
          continue
        }
        const did = String(d.id ?? '').trim()
        if (!did) errors.push(`domains[${i}] 缺少非空 id`)
        else if (domainIds.has(did)) errors.push(`重复的 domain id: "${did}"`)
        else domainIds.add(did)
        scanForbiddenKeysOnObject(d, `domain "${did || i}"`, errors)
        validatePathList(d.entrypoints, `domain "${did || i}" entrypoints`, errors)
      }
    }
  }

  const features = Array.isArray(raw.features) ? raw.features : []
  const featureIds = new Set()
  const adj = new Map()
  for (let i = 0; i < features.length; i += 1) {
    const f = features[i]
    if (!f || typeof f !== 'object') continue
    const fid = String(f.id ?? '').trim()
    if (!fid) continue
    featureIds.add(fid)
    if (!adj.has(fid)) adj.set(fid, [])
  }

  for (let i = 0; i < features.length; i += 1) {
    const f = features[i]
    if (!f || typeof f !== 'object') continue
    const fid = String(f.id ?? '').trim() || String(i)

    if (f.domain !== undefined && f.domain !== null) {
      if (typeof f.domain !== 'string') {
        errors.push(`feature "${fid}" domain 必须为字符串`)
      } else {
        const dom = f.domain.trim()
        if (dom && !domainIds.has(dom)) {
          errors.push(`feature "${fid}" 引用了未定义的悬空 domain: "${dom}"`)
        }
      }
    }

    if (f.dependsOn !== undefined) {
      if (!Array.isArray(f.dependsOn)) {
        errors.push(`feature "${fid}" dependsOn 必须为数组`)
      } else {
        for (const depRaw of f.dependsOn) {
          const dep = String(depRaw ?? '').trim()
          if (!dep) {
            errors.push(`feature "${fid}" dependsOn 包含空依赖`)
            continue
          }
          if (dep === fid) {
            errors.push(`feature "${fid}" 存在自环依赖 dependsOn: "${dep}"`)
            cycles.push([fid, dep])
            continue
          }
          if (!featureIds.has(dep)) {
            errors.push(`feature "${fid}" dependsOn 引用了不存在的悬空 feature: "${dep}"`)
            continue
          }
          if (adj.has(fid)) adj.get(fid).push(dep)
        }
      }
    }
  }

  // 三色 DFS 判环（0=未访问, 1=访问中, 2=已完成）
  const color = new Map()
  const stack = []
  const seenCycleKeys = new Set()
  const dfs = (u) => {
    color.set(u, 1)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      const st = color.get(v) ?? 0
      if (st === 1) {
        const idx = stack.indexOf(v)
        const chain = [...stack.slice(idx), v]
        const key = chain.join('->')
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key)
          cycles.push(chain)
          errors.push(`feature dependsOn 存在循环依赖环路: ${chain.join(' -> ')}`)
        }
      } else if (st === 0) {
        dfs(v)
      }
    }
    stack.pop()
    color.set(u, 2)
  }
  for (const fid of adj.keys()) {
    if ((color.get(fid) ?? 0) === 0) dfs(fid)
  }

  const flowIds = new Set()
  if (raw.flows !== undefined) {
    if (!Array.isArray(raw.flows)) {
      errors.push('feature-map.flows 必须为数组')
    } else {
      for (let i = 0; i < raw.flows.length; i += 1) {
        const fl = raw.flows[i]
        if (!fl || typeof fl !== 'object' || Array.isArray(fl)) {
          errors.push(`flows[${i}] 必须为对象`)
          continue
        }
        const flId = String(fl.id ?? '').trim()
        if (!flId) errors.push(`flows[${i}] 缺少非空 id`)
        else if (flowIds.has(flId)) errors.push(`重复的 flow id: "${flId}"`)
        else flowIds.add(flId)
        scanForbiddenKeysOnObject(fl, `flow "${flId || i}"`, errors)

        if (fl.features !== undefined && !Array.isArray(fl.features)) {
          errors.push(`flow "${flId || i}" features 必须为数组`)
        } else {
          for (const fRef of Array.isArray(fl.features) ? fl.features : []) {
            const ref = String(fRef ?? '').trim()
            if (!ref || !featureIds.has(ref)) {
              errors.push(`flow "${flId || i}" 引用了不存在的悬空 feature: "${ref}"`)
            }
          }
        }
        if (fl.steps !== undefined && !Array.isArray(fl.steps)) {
          errors.push(`flow "${flId || i}" steps 必须为数组`)
        } else {
          for (let j = 0; j < (Array.isArray(fl.steps) ? fl.steps.length : 0); j += 1) {
            const st = fl.steps[j]
            if (!st || typeof st !== 'object') {
              errors.push(`flow "${flId || i}" steps[${j}] 必须为对象`)
              continue
            }
            scanForbiddenKeysOnObject(st, `flow "${flId || i}" steps[${j}]`, errors)
            const targetFeat = String(st.feature ?? '').trim()
            if (targetFeat && !featureIds.has(targetFeat)) {
              errors.push(`flow "${flId || i}" steps[${j}].feature 引用了不存在的悬空 feature: "${targetFeat}"`)
            } else if (!targetFeat && !st.toFeature) {
              errors.push(`flow "${flId || i}" steps[${j}] 缺少 feature 引用`)
            }
            if (st.toFeature !== undefined) {
              const tf = String(st.toFeature ?? '').trim()
              if (!tf || !featureIds.has(tf)) {
                errors.push(`flow "${flId || i}" steps[${j}].toFeature 引用了不存在的悬空 feature: "${tf}"`)
              }
            }
          }
        }
        for (const { branch, label } of collectFlowBranchRefs(fl)) {
          if (!branch || typeof branch !== 'object') {
            errors.push(`flow "${flId || i}" ${label} 必须为对象`)
            continue
          }
          scanForbiddenKeysOnObject(branch, `flow "${flId || i}" ${label}`, errors)
          const toF = String(branch.toFeature ?? '').trim()
          if (!toF || !featureIds.has(toF)) {
            errors.push(`flow "${flId || i}" ${label}.toFeature 引用了不存在的悬空 feature: "${toF}"`)
          }
          if (branch.fromFeature !== undefined) {
            const fromF = String(branch.fromFeature ?? '').trim()
            if (!fromF || !featureIds.has(fromF)) {
              errors.push(`flow "${flId || i}" ${label}.fromFeature 引用了不存在的悬空 feature: "${fromF}"`)
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, cycles }
}

function canonicalSortDeep(val) {
  if (Array.isArray(val)) return val.map(canonicalSortDeep)
  if (!val || typeof val !== 'object') return val
  const out = {}
  for (const key of Object.keys(val).sort()) {
    if (FORBIDDEN_KEY_SET.has(key) || val[key] === undefined) continue
    out[key] = canonicalSortDeep(val[key])
  }
  return out
}

/** 计算 feature-map 规范化（键排序、去易变字段）SHA256 hex 指纹。 */
export function computeFeatureMapFingerprint(map) {
  if (!map || typeof map !== 'object') return sha256Text('{}')
  return sha256Text(JSON.stringify(canonicalSortDeep(map)))
}

export const computeFeatureMapCanonicalSha256 = computeFeatureMapFingerprint

/** 校验生成态 HTML 首行是否声明与当前 `docs/feature-map.json` 一致的 `feature-map-sha256` 指纹。 */
export function verifyArchitectureMapHeader(repoRoot, fileRel = 'docs/architecture-map.html', featureMapRel = 'docs/feature-map.json') {
  if (!repoRoot) return { ok: false, expectedSha: null, actualSha: null, reason: 'missing-repo-root' }
  const fmRaw = readJsonSafe(join(repoRoot, featureMapRel), 4 * 1024 * 1024)
  if (!fmRaw || typeof fmRaw !== 'object') {
    return { ok: false, expectedSha: null, actualSha: null, reason: 'missing-or-invalid-feature-map' }
  }
  const expectedSha = computeFeatureMapFingerprint(fmRaw)
  const htmlAbs = join(repoRoot, fileRel)
  if (!existsSync(htmlAbs)) {
    return { ok: false, expectedSha, actualSha: null, reason: 'missing-html-file' }
  }
  const headText = readTextSafe(htmlAbs, 8192) ?? ''
  const firstLine = headText.split('\n')[0]?.trim() ?? ''
  const match = ARCH_HEADER_SHA_RE.exec(firstLine)
  if (!match) {
    return { ok: false, expectedSha, actualSha: null, reason: 'missing-header-fingerprint' }
  }
  const actualSha = match[1].toLowerCase()
  return {
    ok: actualSha === expectedSha,
    expectedSha,
    actualSha,
    reason: actualSha === expectedSha ? null : 'sha256-mismatch',
  }
}

function inferTopDirBucket(relPath) {
  const norm = normRelPath(relPath)
  if (!norm) return 'core'
  const segs = norm.split('/').filter(Boolean)
  if (segs.length <= 1) return 'root'
  if ((segs[0] === 'packages' || segs[0] === 'apps') && segs.length >= 3) return `${segs[0]}/${segs[1]}`
  return segs[0]
}

/** 为 v1 或无 `domains[]` 的地图按 `modules[]` 顶层目录聚合只读合成域视图。 */
export function buildFallbackDomains(mapOrFeatures) {
  const features = Array.isArray(mapOrFeatures)
    ? mapOrFeatures
    : (Array.isArray(mapOrFeatures?.features) ? mapOrFeatures.features : [])
  const groups = new Map()
  for (const f of features) {
    if (!f || typeof f !== 'object') continue
    const fid = String(f.id ?? f.name ?? '').trim()
    if (!fid) continue
    const paths = [
      ...(Array.isArray(f.modules) ? f.modules : []),
      ...(Array.isArray(f.entrypoints) ? f.entrypoints : []),
      ...(Array.isArray(f.entryFiles) ? f.entryFiles : []),
      ...(Array.isArray(f.files) ? f.files : []),
      ...(f.entry ? [f.entry] : []),
    ]
    const bucket = inferTopDirBucket(paths[0] ?? '')
    const domId = slugifyFeatureId(bucket)
    if (!groups.has(domId)) {
      groups.set(domId, { id: domId, name: bucket, synthetic: true, featureIds: [], featureCount: 0 })
    }
    const g = groups.get(domId)
    g.featureIds.push(fid)
    g.featureCount += 1
  }
  return [...groups.values()].sort((a, b) => b.featureCount - a.featureCount || a.id.localeCompare(b.id))
}

function toSlimNeighborPointer(feat) {
  const eps = Array.isArray(feat?.entrypoints) && feat.entrypoints.length > 0
    ? feat.entrypoints
    : (Array.isArray(feat?.entryFiles) ? feat.entryFiles : [])
  const anchors = Array.isArray(feat?.docAnchors) ? feat.docAnchors : []
  return {
    id: feat.id,
    name: feat.name ?? feat.id,
    domain: feat.domain ?? null,
    entrypoint: eps[0] ?? null,
    docAnchor: anchors[0] ?? null,
  }
}

function collectFlowFeatureIds(fl) {
  const ids = new Set()
  for (const fid of Array.isArray(fl?.features) ? fl.features : []) {
    if (String(fid ?? '').trim()) ids.add(String(fid).trim())
  }
  for (const st of Array.isArray(fl?.steps) ? fl.steps : []) {
    if (typeof st?.feature === 'string' && st.feature.trim()) ids.add(st.feature.trim())
    if (typeof st?.toFeature === 'string' && st.toFeature.trim()) ids.add(st.toFeature.trim())
  }
  for (const { branch } of collectFlowBranchRefs(fl)) {
    if (typeof branch?.fromFeature === 'string' && branch.fromFeature.trim()) ids.add(branch.fromFeature.trim())
    if (typeof branch?.toFeature === 'string' && branch.toFeature.trim()) ids.add(branch.toFeature.trim())
  }
  return [...ids]
}

/**
 * 构造低 token 分层上下文切片：
 * - `domainSummary[]`: L0 域分布统计；
 * - `upstream[]` / `downstream[]`: 1-hop 紧凑指针（仅 `{ id, name, domain, entrypoint, docAnchor }`）；
 * - `matchedFlows[]`: 相关跨模块流转（硬上限 6 条）。
 */
export function sliceFeatureMapContext(map, matchedOrOpts = {}, maybeOpts = {}) {
  const isArr = Array.isArray(matchedOrOpts)
  const opts = isArr ? (maybeOpts ?? {}) : (matchedOrOpts ?? {})
  const rawMatched = isArr ? matchedOrOpts : (opts.matchedFeatureIds ?? opts.matchedFeatures ?? [])
  const matchedSet = new Set(
    (Array.isArray(rawMatched) ? rawMatched : [])
      .map((x) => (typeof x === 'string' ? x : x?.id))
      .map((s) => String(s ?? '').trim())
      .filter(Boolean),
  )
  const features = Array.isArray(map?.features) ? map.features.filter((f) => f && typeof f === 'object') : []
  if (features.length === 0) {
    return { domainSummary: [], upstream: [], downstream: [], matchedFlows: [] }
  }

  const maxDomains = Math.max(0, Number(opts.maxDomains ?? opts.limit ?? 6) || 0)
  const maxNeighbors = Math.max(0, Number(opts.maxNeighbors ?? opts.limit ?? 6) || 0)
  const maxFlows = Math.min(6, Math.max(0, Number(opts.maxFlows ?? opts.limit ?? 6) || 0))
  const kwList = uniqStrings(opts.keywords).map((k) => k.toLowerCase()).filter((k) => k.length >= 2)

  const hasExplicitDomains = Array.isArray(map?.domains) && map.domains.length > 0
  const fallbackDomains = hasExplicitDomains ? [] : buildFallbackDomains(features)
  const domainMap = new Map()
  if (hasExplicitDomains) {
    for (const d of map.domains) {
      if (!d || typeof d !== 'object') continue
      const did = String(d.id ?? '').trim()
      if (!did) continue
      domainMap.set(did, {
        id: did,
        name: String(d.name ?? did).trim() || did,
        synthetic: false,
        featureCount: 0,
        matchedCount: 0,
        docAnchor: Array.isArray(d.docAnchors) && d.docAnchors[0] ? String(d.docAnchors[0]) : null,
      })
    }
    for (const f of features) {
      const did = String(f.domain ?? '').trim()
      if (!did || !domainMap.has(did)) continue
      const entry = domainMap.get(did)
      entry.featureCount += 1
      if (matchedSet.has(f.id)) entry.matchedCount += 1
    }
  } else {
    for (const fd of fallbackDomains) {
      domainMap.set(fd.id, {
        id: fd.id,
        name: fd.name,
        synthetic: true,
        featureCount: fd.featureCount,
        matchedCount: fd.featureIds.filter((id) => matchedSet.has(id)).length,
        docAnchor: null,
      })
    }
  }
  const domainSummary = [...domainMap.values()]
    .sort((a, b) => (b.matchedCount - a.matchedCount) || (b.featureCount - a.featureCount) || a.id.localeCompare(b.id))
    .slice(0, maxDomains)

  const byId = new Map(features.map((f) => [f.id, f]))
  const upstreamIds = []
  const downstreamIds = []
  const seenUp = new Set()
  const seenDown = new Set()

  if (matchedSet.size > 0) {
    for (const mid of matchedSet) {
      const m = byId.get(mid)
      if (!m) continue
      for (const dep of Array.isArray(m.dependsOn) ? m.dependsOn : []) {
        if (!matchedSet.has(dep) && byId.has(dep) && !seenUp.has(dep)) {
          seenUp.add(dep)
          upstreamIds.push(dep)
        }
      }
    }
    for (const f of features) {
      if (matchedSet.has(f.id) || seenDown.has(f.id)) continue
      const deps = Array.isArray(f.dependsOn) ? f.dependsOn : []
      if (deps.some((d) => matchedSet.has(d))) {
        seenDown.add(f.id)
        downstreamIds.push(f.id)
      }
    }
  }

  const upstream = upstreamIds.slice(0, maxNeighbors).map((id) => toSlimNeighborPointer(byId.get(id)))
  const downstream = downstreamIds.slice(0, maxNeighbors).map((id) => toSlimNeighborPointer(byId.get(id)))

  const rawFlows = Array.isArray(map?.flows) ? map.flows : []
  const scoredFlows = []
  for (const fl of rawFlows) {
    if (!fl || typeof fl !== 'object') continue
    const flId = String(fl.id ?? '').trim()
    if (!flId) continue
    const flFeats = collectFlowFeatureIds(fl)
    const actors = uniqStrings(fl.actors)
    const hitFeats = flFeats.filter((fid) => matchedSet.has(fid))
    const hay = [flId, fl.name, ...actors, ...flFeats].join(' ').toLowerCase()
    const kwHits = kwList.filter((kw) => hay.includes(kw))
    let score = hitFeats.length * 10 + kwHits.length * 3
    if (matchedSet.size === 0 && kwList.length === 0) score = 1
    if (score <= 0) continue
    const chain = flFeats.join(' -> ')
    scoredFlows.push({
      score,
      flow: {
        id: flId,
        name: String(fl.name ?? flId).trim() || flId,
        actors,
        features: flFeats,
        summary: `[${flId}] (${actors.join(', ') || 'system'}) ${chain}`,
      },
    })
  }
  const matchedFlows = scoredFlows
    .sort((a, b) => (b.score - a.score) || a.flow.id.localeCompare(b.flow.id))
    .slice(0, maxFlows)
    .map((x) => x.flow)

  return { domainSummary, upstream, downstream, matchedFlows }
}
