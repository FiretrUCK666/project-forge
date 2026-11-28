/**
 * iterate-plan.mjs —— 从 `iterate.mjs` 拆出的源码勘察、热点统计与补测候选规划内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, posix } from 'node:path'

import { locateDocuments } from '../../lib/doc-locator.mjs'
import {
  COMMON_SKIP_DIRS, gitRun, isMacOsJunkPath, posixPath, readTextSafe,
} from '../../lib/git.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import { isActionableSignalCodeTarget, readSignalsJsonl, resolveGovernStateDir } from '../../lib/signals.mjs'
import { CODE_EXT_RE, TEST_FILE_RE } from '../../lib/static-gates.mjs'
import { extractSymbols } from '../../lib/symbol-index.mjs'
import {
  isPathInQuickTestScope, readFeatureMapSafe, resolveNativeTestDir, slugTestToken,
} from '../../lib/suite-inventory.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

export const VALID_TIERS = new Set(['integration', 'e2e', 'perf', 'regression'])
export const ITERATE_SKIP_DIRS = new Set([...COMMON_SKIP_DIRS, '.git', '.worktrees', '.agents', 'docs'])

export function walkSourceFiles(repoRoot, maxFiles = 1500) {
  const out = []
  const stack = ['']
  while (stack.length > 0 && out.length < maxFiles) {
    const relDir = stack.pop()
    const absDir = relDir ? join(repoRoot, relDir) : repoRoot
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (isMacOsJunkPath(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (ITERATE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(rel)
      } else if (entry.isFile()) {
        if (isToolOwnedPath(rel) || !CODE_EXT_RE.test(entry.name)) continue
        out.push({ rel: posixPath(rel), name: entry.name, full: join(absDir, entry.name) })
        if (out.length >= maxFiles) break
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export async function collectRecentChangedFiles(repoRoot, isGit) {
  if (!isGit) return []
  const res = await gitRun(repoRoot, ['log', '-n', '10', '--name-only', '--pretty=format:'])
  if (!res.ok) return []
  const counts = new Map()
  for (const line of String(res.stdout ?? '').split('\n')) {
    const clean = posixPath(line.trim())
    if (!clean || !CODE_EXT_RE.test(clean) || TEST_FILE_RE.test(clean) || isToolOwnedPath(clean)) continue
    if (!existsSync(join(repoRoot, clean))) continue
    counts.set(clean, (counts.get(clean) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file, touches]) => ({ file, touches }))
}

export function extractFocusKeywords(focusText) {
  const raw = String(focusText ?? '').trim().toLowerCase()
  if (!raw) return []
  const asciiTokens = raw.match(/[a-z0-9_./-]{2,}/g) ?? []
  const cjkChunks = raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  return [...new Set([...asciiTokens, ...cjkChunks])].slice(0, 12)
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
  for (const br of Array.isArray(fl?.branches) ? fl.branches : []) {
    if (typeof br?.fromFeature === 'string' && br.fromFeature.trim()) ids.add(br.fromFeature.trim())
    if (typeof br?.toFeature === 'string' && br.toFeature.trim()) ids.add(br.toFeature.trim())
  }
  return [...ids]
}

function computeIncomingDependentCounts(features = []) {
  const counts = new Map()
  for (const f of features) {
    for (const dep of Array.isArray(f?.dependsOn) ? f.dependsOn : []) {
      const key = String(dep ?? '').trim()
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function pickPrimaryFeatureModule(repoRoot, feat) {
  const entryFiles = [
    ...(Array.isArray(feat?.entrypoints) ? feat.entrypoints : []),
    ...(Array.isArray(feat?.modules) ? feat.modules : []),
    ...(Array.isArray(feat?.entryFiles) ? feat.entryFiles : []),
    ...(Array.isArray(feat?.files) ? feat.files : []),
    ...(feat?.entry ? [feat.entry] : []),
  ].filter(Boolean)
  return entryFiles.find((p) => existsSync(join(repoRoot, p))) ?? entryFiles[0] ?? null
}

/** 识别盲区、跨 feature 流转与热点并构造补测候选计划（支持自动交叉比对与 `--focus` 自然语言定向）。 */
export async function buildIterationPlan(repoRoot, {
  focus = '',
  tier = 'integration',
  limit = 5,
  isGit = true,
  gitDir = null,
} = {}) {
  const cleanTier = VALID_TIERS.has(String(tier).toLowerCase()) ? String(tier).toLowerCase() : 'integration'
  const devProfile = parseDevProfile(repoRoot)
  const allCode = walkSourceFiles(repoRoot)
  const srcFiles = allCode.filter((f) => !TEST_FILE_RE.test(f.rel))
  const testFiles = allCode.filter((f) => TEST_FILE_RE.test(f.rel))
  const featureMap = readFeatureMapSafe(repoRoot)
  const stateDir = resolveGovernStateDir(repoRoot, gitDir, isGit)
  const { events: signals } = readSignalsJsonl(stateDir, { codeOnly: true, repoRoot })
  const recentChanges = await collectRecentChangedFiles(repoRoot, isGit)
  const nativeTarget = resolveNativeTestDir(repoRoot, { tier: cleanTier, devProfile, files: allCode })

  const candidates = []
  const seenTargets = new Set()
  const addCandidate = (cand) => {
    const key = `${cand.featureId ?? ''}|${cand.targetModule ?? ''}|${cand.topic ?? ''}|${cand.flowId ?? ''}`
    if (seenTargets.has(key)) return
    seenTargets.add(key)
    candidates.push(cand)
  }

  let focusContext = null
  if (String(focus ?? '').trim()) {
    const keywords = extractFocusKeywords(focus)
    let docSlices = []
    try {
      const located = locateDocuments(repoRoot, { query: focus, limit: 5 })
      docSlices = (located?.slices ?? located?.matches ?? []).slice(0, 5).map((m) => ({
        file: m.relPath ?? m.file,
        heading: m.section ?? m.heading ?? null,
        lines: m.startLine && m.endLine ? `${m.startLine}-${m.endLine}` : null,
      }))
    } catch { /* graceful degrade */ }

    const scoredModules = []
    for (const sf of srcFiles) {
      const lowPath = sf.rel.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (lowPath.includes(kw)) score += 3
      }
      const txt = readTextSafe(sf.full, 128 * 1024) ?? ''
      if (txt) {
        const lowTxt = txt.toLowerCase()
        for (const kw of keywords) {
          if (lowTxt.includes(kw)) score += 1
        }
      }
      if (score > 0) {
        const syms = extractSymbols(txt, posix.extname(sf.rel) || sf.rel)
        scoredModules.push({
          rel: sf.rel,
          score,
          symbols: Array.isArray(syms?.symbols)
            ? syms.symbols.slice(0, 6).map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
            : [],
        })
      }
    }
    scoredModules.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))

    const matchedFeatures = featureMap.features.filter((feat) => {
      const blob = JSON.stringify(feat).toLowerCase()
      return keywords.some((kw) => blob.includes(kw))
    })
    focusContext = {
      query: String(focus).trim(),
      keywords,
      docSlices,
      matchedModules: scoredModules.slice(0, 8),
      matchedFeatures: matchedFeatures.map((f) => f.id ?? f.name).filter(Boolean),
    }

    for (const mod of scoredModules.slice(0, limit)) {
      const feat = matchedFeatures.find((f) => JSON.stringify(f).toLowerCase().includes(mod.rel.toLowerCase()))
        ?? matchedFeatures[0] ?? null
      addCandidate({
        priority: 100 + mod.score,
        source: 'focus',
        reason: `定向主题「${String(focus).trim()}」命中模块 ${mod.rel}`,
        topic: String(focus).trim(),
        featureId: feat?.id ?? feat?.name ?? null,
        targetModule: mod.rel,
        exportedSymbols: mod.symbols,
        tier: cleanTier,
      })
    }
    if (candidates.length === 0) {
      const fallbackMod = srcFiles[0]?.rel ?? null
      addCandidate({
        priority: 95,
        source: 'focus',
        reason: `定向主题「${String(focus).trim()}」生成行为回归覆盖`,
        topic: String(focus).trim(),
        featureId: matchedFeatures[0]?.id ?? matchedFeatures[0]?.name ?? null,
        targetModule: fallbackMod,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }
  } else {
    const dependentCounts = computeIncomingDependentCounts(featureMap.features)
    const featById = new Map(featureMap.features.map((f) => [f.id, f]))

    // 0. 跨 feature `flows[]` 端到端盲区
    for (const flow of Array.isArray(featureMap.flows) ? featureMap.flows : []) {
      const involvedIds = collectFlowFeatureIds(flow)
      if (involvedIds.length < 2) continue
      const flowToken = slugTestToken(flow.id || flow.name || 'flow')
      const hasE2eRef = involvedIds.some((fid) => {
        const feat = featById.get(fid)
        const refs = Array.isArray(feat?.testRefs) ? feat.testRefs : []
        return refs.some((r) => /(?:^|\/|[._-])e2e(?:[._-]|\/|$)/i.test(r) || r.toLowerCase().includes(flowToken))
      }) || testFiles.some((tf) => tf.rel.toLowerCase().includes(flowToken) && /e2e/i.test(tf.rel))
      if (hasE2eRef) continue
      const primaryMod = involvedIds.map((fid) => pickPrimaryFeatureModule(repoRoot, featById.get(fid))).find(Boolean) ?? null
      addCandidate({
        priority: cleanTier === 'e2e' ? 98 : 88,
        source: 'cross-feature-flow',
        reason: `跨 feature 业务流 ${flow.id}（${involvedIds.join(' -> ')}）缺少 E2E 端到端测试覆盖`,
        topic: flow.id || flow.name || 'cross-flow',
        flowId: flow.id ?? null,
        involvedFeatures: involvedIds,
        featureId: involvedIds[0] ?? null,
        targetModule: primaryMod ? posixPath(primaryMod) : null,
        exportedSymbols: [],
        tier: 'e2e',
      })
    }

    // 1. 功能地图盲区（无 testRefs、弱覆盖或 stale，按被依赖入度加权）
    for (const feat of featureMap.features) {
      const testRefs = Array.isArray(feat.testRefs) ? feat.testRefs.filter(Boolean) : []
      const isWeak = testRefs.length === 0 || feat.stale === true
      if (!isWeak) continue
      const depWeight = Math.min(10, (dependentCounts.get(feat.id) ?? 0) * 2)
      const primaryMod = pickPrimaryFeatureModule(repoRoot, feat)
      addCandidate({
        priority: (feat.stale ? 95 : 90) + depWeight,
        source: 'feature-map-gap',
        reason: feat.stale
          ? `feature-map 条目 ${feat.id ?? feat.name} 已标记 stale 且缺少回归护栏`
          : `feature-map 条目 ${feat.id ?? feat.name} 尚无 testRefs 覆盖${depWeight > 0 ? `（被 ${dependentCounts.get(feat.id)} 个模块依赖）` : ''}`,
        topic: feat.name ?? feat.id ?? 'feature-gap',
        featureId: feat.id ?? feat.name ?? null,
        dependentCount: dependentCounts.get(feat.id) ?? 0,
        targetModule: primaryMod ? posixPath(primaryMod) : null,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 2. signals.jsonl 高频复发热点模块
    const hotspotByMod = new Map()
    for (const ev of signals) {
      const target = posixPath(ev.file || ev.targetArtifact || '').replace(/^\.\//, '')
      if (!isActionableSignalCodeTarget(target, repoRoot)) continue
      const cur = hotspotByMod.get(target) ?? { count: 0, classes: new Set() }
      cur.count += 1
      if (ev.defectClass) cur.classes.add(ev.defectClass)
      hotspotByMod.set(target, cur)
    }
    for (const [mod, info] of [...hotspotByMod.entries()].sort((a, b) => b[1].count - a[1].count)) {
      if (info.count < 2) continue
      addCandidate({
        priority: 80 + Math.min(15, info.count * 2),
        source: 'signal-hotspot',
        reason: `signals.jsonl 中 ${mod} 累计触发 ${info.count} 次告警（${[...info.classes].join(', ') || 'defect'}）`,
        topic: basename(mod).replace(/\.[^.]+$/, ''),
        featureId: null,
        targetModule: mod,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 3. 近期高频变更源码模块
    for (const ch of recentChanges.slice(0, limit)) {
      const covered = testFiles.some((tf) => tf.rel.toLowerCase().includes(basename(ch.file).replace(/\.[^.]+$/, '').toLowerCase()))
      if (covered && candidates.length >= limit) continue
      addCandidate({
        priority: covered ? 50 + ch.touches : 70 + ch.touches,
        source: 'recent-change',
        reason: `近期提交高频改动 ${ch.file}（${ch.touches} 次）`,
        topic: basename(ch.file).replace(/\.[^.]+$/, ''),
        featureId: null,
        targetModule: ch.file,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 4. 兜底：无 feature-map / signals / 历史变更时按核心源码补测
    if (candidates.length === 0 && srcFiles.length > 0) {
      for (const sf of srcFiles.slice(0, limit)) {
        addCandidate({
          priority: 40,
          source: 'source-inventory',
          reason: `源码模块 ${sf.rel} 缺少对应 ${cleanTier} 回归测试`,
          topic: basename(sf.rel).replace(/\.[^.]+$/, ''),
          featureId: null,
          targetModule: sf.rel,
          exportedSymbols: [],
          tier: cleanTier,
        })
      }
    }
  }

  candidates.sort((a, b) => b.priority - a.priority)
  const selected = candidates.slice(0, Math.max(1, Number(limit) || 5)).map((c) => {
    const effTier = c.tier || cleanTier
    const stem = slugTestToken(c.flowId || c.featureId || c.topic || (c.targetModule ? basename(c.targetModule).replace(/\.[^.]+$/, '') : 'flow'))
    const fileName = nativeTarget.stack === 'python'
      ? `test_${stem.replace(/-/g, '_')}_${effTier}.py`
      : nativeTarget.stack === 'go'
        ? `${stem.replace(/-/g, '_')}_${effTier}_test.go`
        : nativeTarget.stack === 'rust'
          ? `${stem.replace(/-/g, '_')}_${effTier}.rs`
          : (nativeTarget.isTypeScript || nativeTarget.ext === '.ts'
              ? `${stem}.${effTier}.test.ts`
              : `${stem}.${effTier}.test.mjs`)
    const plannedTestFile = posixPath(`${nativeTarget.dirRel}/${fileName}`)
    return {
      ...c,
      plannedTestFile,
      avoidsQuickTest: !isPathInQuickTestScope(devProfile, plannedTestFile),
    }
  })

  return {
    ok: true,
    repoRoot: posixPath(repoRoot),
    tier: cleanTier,
    mode: focus ? 'focus' : 'auto',
    featureMapPresent: featureMap.present,
    featureMapValid: featureMap.valid,
    signalsAnalyzed: signals.length,
    recentChangedCount: recentChanges.length,
    nativeTarget,
    ...(focusContext ? { focusContext } : {}),
    candidates: selected,
  }
}
