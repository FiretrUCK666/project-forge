/**
 * diff-materiality.mjs —— 基于 `merge-base(base, HEAD)...HEAD` 3-dot 差异的
 * Materiality 过滤器、1-hop 邻域并集与有界 `-`/`+` hunk 摘要提取器。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { readFeatureMapSafe } from './feature-map.mjs'
import { gitDiffNameStatusZ, gitRun, gitRunBuffer, posixPath, resolveDefaultBranch } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'
import { LOCKFILE_NAMES, splitDiffByFile } from './static-gates.mjs'

export const SCHEMA_MIGRATION_RE = /(?:^|\/)(?:migrations?|migrate)\/|\.(?:prisma|sql)$|(?:^|\/)schema\.[a-z0-9_-]+$/i
export const NON_MATERIAL_DOC_RE = /\.(?:md|mdx|txt|rst|adoc)$/i

/**
 * 按 Materiality 规则分类变更条目：
 * - Schema/迁移（`*.prisma`、`*.sql`、`migrations/**`、`schema.*`）必触发；
 * - 100% 相似度纯重命名（`R100`）、锁文件（`LOCKFILE_NAMES`）、纯文档自动跳过。
 */
export function classifyDiffMateriality(entries = []) {
  const classified = []
  const materialFiles = []
  const mandatoryFiles = []
  const skippedFiles = []

  for (const raw of Array.isArray(entries) ? entries : []) {
    const file = posixPath(raw?.file ?? '').replace(/^\.\//, '')
    if (!file) continue
    const status = String(raw?.status ?? 'M').trim().toUpperCase()
    const baseName = file.split('/').pop()?.toLowerCase() ?? ''

    if (SCHEMA_MIGRATION_RE.test(file)) {
      const item = { file, oldFile: raw?.oldFile ?? null, status, material: true, priority: 'mandatory', reason: 'schema-or-migration' }
      classified.push(item)
      materialFiles.push(file)
      mandatoryFiles.push(file)
      continue
    }
    if (/^R100$/i.test(status)) {
      const item = { file, oldFile: raw?.oldFile ?? null, status, material: false, priority: 'skip', reason: 'pure-rename-r100' }
      classified.push(item)
      skippedFiles.push(item)
      continue
    }
    if (LOCKFILE_NAMES.has(baseName)) {
      const item = { file, oldFile: raw?.oldFile ?? null, status, material: false, priority: 'skip', reason: 'lockfile' }
      classified.push(item)
      skippedFiles.push(item)
      continue
    }
    if (NON_MATERIAL_DOC_RE.test(file)) {
      const item = { file, oldFile: raw?.oldFile ?? null, status, material: false, priority: 'skip', reason: 'pure-doc' }
      classified.push(item)
      skippedFiles.push(item)
      continue
    }

    const item = { file, oldFile: raw?.oldFile ?? null, status, material: true, priority: 'normal', reason: 'code-or-config-change' }
    classified.push(item)
    materialFiles.push(file)
  }

  return {
    entries: classified,
    materialFiles: [...new Set(materialFiles)].sort(),
    mandatoryFiles: [...new Set(mandatoryFiles)].sort(),
    skippedFiles,
    hasMaterialChanges: materialFiles.length > 0,
  }
}

/** 从 unified diff 提取有界 `-`/`+` hunk 摘要，严控单文件与全局最大行数。 */
export function extractBoundedHunks(diffText, {
  maxLinesPerFile = 40,
  maxTotalLines = 240,
  allowFiles = null,
} = {}) {
  const perLimit = Math.max(1, Number(maxLinesPerFile) || 40)
  const totalLimit = Math.max(1, Number(maxTotalLines) || 240)
  const allowSet = allowFiles ? new Set(allowFiles) : null
  const chunks = splitDiffByFile(diffText)
  const files = []
  let totalLines = 0
  let globalTruncated = false

  for (const [file, chunk] of [...chunks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (allowSet && !allowSet.has(file)) continue
    if (totalLines >= totalLimit) {
      globalTruncated = true
      break
    }
    const lines = []
    let addedCount = 0
    let removedCount = 0
    let fileTruncated = false

    for (const rawLine of String(chunk ?? '').split('\n')) {
      if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('diff --git ') || rawLine.startsWith('index ')) {
        continue
      }
      const isHunkHdr = rawLine.startsWith('@@')
      const isAdd = rawLine.startsWith('+')
      const isRem = rawLine.startsWith('-')
      if (!isHunkHdr && !isAdd && !isRem) continue
      if (isAdd) addedCount += 1
      if (isRem) removedCount += 1

      if (lines.length >= perLimit || totalLines >= totalLimit) {
        fileTruncated = true
        globalTruncated = true
        continue
      }
      lines.push(rawLine.slice(0, 200))
      totalLines += 1
    }
    files.push({ file, lines, addedCount, removedCount, truncated: fileTruncated })
  }

  return { files, totalLines, truncated: globalTruncated }
}

function computeOneHopUnion(materialFiles, analysis, featureMap) {
  const materialSet = new Set(materialFiles)
  const oneHopFiles = new Set()
  const impactedFeatures = new Set()

  for (const edge of analysis?.edges ?? []) {
    if (materialSet.has(edge.from) && !materialSet.has(edge.to)) oneHopFiles.add(edge.to)
    if (materialSet.has(edge.to) && !materialSet.has(edge.from)) oneHopFiles.add(edge.from)
  }

  const features = Array.isArray(featureMap?.features) ? featureMap.features : []
  if (features.length > 0) {
    const byId = new Map(features.map((f) => [f.id, f]))
    const directIds = new Set()
    for (const f of features) {
      const owned = [...(f.entrypoints ?? []), ...(f.modules ?? [])]
      if (owned.some((p) => materialSet.has(posixPath(p)))) directIds.add(f.id)
    }
    for (const id of directIds) {
      const f = byId.get(id)
      if (!f) continue
      for (const dep of f.dependsOn ?? []) {
        if (!directIds.has(dep)) impactedFeatures.add(dep)
      }
    }
    for (const f of features) {
      if (directIds.has(f.id)) continue
      if ((f.dependsOn ?? []).some((dep) => directIds.has(dep))) impactedFeatures.add(f.id)
    }
    for (const fid of impactedFeatures) {
      const f = byId.get(fid)
      if (!f) continue
      for (const p of [...(f.entrypoints ?? []), ...(f.modules ?? [])]) {
        const norm = posixPath(p)
        if (norm && !materialSet.has(norm)) oneHopFiles.add(norm)
      }
    }
  }

  const impactedOneHop = [...oneHopFiles].sort()
  const neighborhood = [...new Set([...materialFiles, ...impactedOneHop])].sort()
  return { impactedOneHop, impactedFeatures: [...impactedFeatures].sort(), neighborhood }
}

function degradedResult(reason, extra = {}) {
  return {
    ok: true,
    degraded: true,
    degradedReason: reason,
    mergeBase: null,
    range: null,
    entries: [],
    materialFiles: [],
    mandatoryFiles: [],
    skippedFiles: [],
    impactedOneHop: [],
    impactedFeatures: [],
    neighborhood: [],
    hunks: { files: [], totalLines: 0, truncated: false },
    hasMaterialChanges: false,
    ...extra,
  }
}

/**
 * 基于 `git merge-base <baseRef> <headRef>` 与 `<mergeBase>...<headRef>` 3-dot 差异，
 * 计算 PR Materiality 过滤结果、1-hop 邻域并集与有界 `-`/`+` hunk。
 */
export async function computePrDiffContext(repoRoot, {
  baseRef = 'main',
  headRef = 'HEAD',
  analysis = null,
  featureMap = null,
  maxLinesPerFile = 40,
  maxTotalLines = 240,
} = {}) {
  const root = resolve(String(repoRoot || process.cwd()))
  const wtGitDir = resolveGitDirFast(root)
  if (!wtGitDir || !existsSync(wtGitDir)) return degradedResult('non-git-repo')

  let effectiveBase = baseRef
  const baseCheck = await gitRun(root, ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', effectiveBase])
  if (!baseCheck.ok && baseRef === 'main') {
    const def = await resolveDefaultBranch(root, { strict: true })
    if (def) effectiveBase = def
  }
  const mbRes = await gitRun(root, ['--no-optional-locks', 'merge-base', effectiveBase, headRef])
  if (!mbRes.ok || !mbRes.stdout.trim()) {
    return degradedResult('merge-base-unavailable', { baseRef: effectiveBase, headRef })
  }
  const mergeBase = mbRes.stdout.trim()
  const range = `${mergeBase}...${headRef}`

  const [nsRes, diffRes] = await Promise.all([
    gitDiffNameStatusZ(root, ['-M', range]),
    gitRunBuffer(root, ['--no-optional-locks', 'diff', '--unified=3', '--no-ext-diff', '--no-color', '-M', range]),
  ])
  if (!nsRes.ok) return degradedResult('git-diff-failed', { baseRef: effectiveBase, headRef, mergeBase, range })

  const classified = classifyDiffMateriality(nsRes.entries)
  const fmData = featureMap ?? readFeatureMapSafe(root)?.data ?? null
  const { impactedOneHop, impactedFeatures, neighborhood } = computeOneHopUnion(classified.materialFiles, analysis, fmData)
  const diffText = diffRes.ok && diffRes.stdout ? diffRes.stdout.toString('utf8').replace(/\r\n/g, '\n') : ''
  const hunks = extractBoundedHunks(diffText, {
    maxLinesPerFile,
    maxTotalLines,
    allowFiles: new Set(classified.materialFiles),
  })

  return {
    ok: true,
    degraded: false,
    degradedReason: null,
    baseRef: effectiveBase,
    headRef,
    mergeBase,
    range,
    ...classified,
    impactedOneHop,
    impactedFeatures,
    neighborhood,
    hunks,
  }
}
