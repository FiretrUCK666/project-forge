/**
 * review-context.mjs —— dev-review 上下文装配、docs/feature-map.json 按需切片反查、
 * 依赖逆邻域构建、可用运行时能力探测与零预设工具分级实证任务单生成。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`）。
 */

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { buildContextBrief, formatContextBriefLines } from '../../lib/context-brief.mjs'
import { resolveExecutable } from '../../lib/exec.mjs'
import {
  FEATURE_MAP_REL, detectScratchSolidificationHints, evaluateToolStaleness,
  findAffectedFeatures, matchFeatureMapForPaths, prefillFeatureMapFromRepoMap,
  readVerifyCache, resolveTaskScratchDir,
} from '../../lib/feature-map.mjs'
import {
  LIKELY_DEFAULT_BRANCHES, gitLsFilesTextAndCode, gitRun, posixPath, readTextSafe, resolveDefaultBranch,
} from '../../lib/git.mjs'
import { resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { parsePrNumber } from '../../lib/platform.mjs'
import { CODE_EXT_RE, TEST_FILE_RE, isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { extractSymbols } from '../../lib/symbol-index.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'
import { generateRepoMap } from '../../dev-explore/scripts/repo-map.mjs'

const IMPORT_SPEC_RE = /(?:^\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gm
const PY_FROM_RE = /^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/gm

function defaultBaseCandidates(def) {
  return [...new Set([
    def,
    ...(def ? [`origin/${def}`] : []),
    ...LIKELY_DEFAULT_BRANCHES,
    ...LIKELY_DEFAULT_BRANCHES.map((b) => `origin/${b}`),
  ].filter(Boolean))]
}

export async function resolveDefaultBaseRef(repoRoot, headRef) {
  const fastGitDir = resolveGitDirFast(repoRoot)
  const canFastRefs = Boolean(fastGitDir && !existsSync(join(fastGitDir, 'reftable')))
  if (canFastRefs) {
    const origHeadTxt = readTextSafe(join(fastGitDir, 'refs', 'remotes', 'origin', 'HEAD'))?.trim()
    if (origHeadTxt?.startsWith('ref:')) {
      const symTarget = origHeadTxt.slice(4).trim()
      if (resolveRefShaFast(fastGitDir, symTarget)) return symTarget.replace(/^refs\/remotes\//, '')
    }
    const def = await resolveDefaultBranch(repoRoot)
    for (const cand of defaultBaseCandidates(def)) {
      const fullRef = cand.startsWith('origin/') ? `refs/remotes/${cand}` : `refs/heads/${cand}`
      if (resolveRefShaFast(fastGitDir, fullRef)) return cand
    }
  }
  const sym = await gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (sym.ok && sym.stdout.trim()) {
    const ref = sym.stdout.trim()
    if ((await gitRun(repoRoot, ['rev-parse', '--verify', ref])).ok) return ref
  }
  const def = await resolveDefaultBranch(repoRoot)
  for (const cand of defaultBaseCandidates(def)) {
    if ((await gitRun(repoRoot, ['rev-parse', '--verify', cand])).ok) return cand
  }
  if ((await gitRun(repoRoot, ['rev-parse', '--verify', `${headRef}~1`])).ok) return `${headRef}~1`
  return undefined
}

export function validatePackCliArgs(cli, subcommands) {
  const { sub, opts } = cli
  if (!sub && opts._.length === 1) {
    const posPr = parsePrNumber(String(opts._[0]).trim())
    if (posPr !== null && opts.pr === undefined && opts['external-pr'] === undefined) {
      opts.pr = String(posPr)
      opts._.shift()
    }
  }
  if (opts.pr !== undefined) {
    const prNum = parsePrNumber(opts.pr, { strict: true })
    if (prNum !== null) opts.pr = String(prNum)
  }
  if (opts['external-pr'] !== undefined) {
    const extNum = parsePrNumber(opts['external-pr'], { strict: true })
    if (extNum !== null) opts['external-pr'] = String(extNum)
  }
  if (opts._.length > 1) throw new Error(`多余的位置参数：${opts._.slice(1).join(' ')}`)
  if (opts._.length === 1) {
    const cand = resolve(String(opts._[0]))
    if (opts.dir !== undefined) throw new Error(`未知参数或重复目录：${opts._[0]}`)
    if (!existsSync(cand) || !statSync(cand).isDirectory()) throw new Error(`未知子命令或不存在的目录：${opts._[0]}`)
  }
  if (sub && !subcommands.includes(sub)) throw new Error(`未知子命令：${sub}`)
  if (sub === 'check-fault') {
    const phase = String(opts.phase ?? '').trim().toLowerCase()
    if (phase !== 'fail' && phase !== 'restore') throw new Error('check-fault 必须指定 --phase fail 或 --phase restore')
  }
  const hasLocal = Boolean(opts.local)
  const hasStaged = Boolean(opts.staged)
  const hasTask = opts.task !== undefined
  const hasPr = opts.pr !== undefined || opts['external-pr'] !== undefined
  const hasBase = opts.base !== undefined
  if (hasLocal && (hasStaged || hasTask || hasPr || hasBase)) throw new Error('--local 与 --staged/--task/--pr/--base 互斥，不能同时指定')
  if (hasStaged && (hasTask || hasPr || hasBase)) throw new Error('--staged 与 --task/--pr/--base 互斥，不能同时指定')
}

function resolveRelativeImport(repoRoot, fromRel, spec, fileSet) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const baseDir = dirname(join(repoRoot, fromRel))
  const rawAbs = resolve(baseDir, spec)
  const relFromRoot = relative(resolve(repoRoot), rawAbs)
  if (!relFromRoot || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) return null
  const relBase = posixPath(relFromRoot).replace(/^\/+/, '')
  const cands = [
    relBase,
    `${relBase}.mjs`, `${relBase}.js`, `${relBase}.ts`, `${relBase}.tsx`, `${relBase}.cjs`, `${relBase}.py`,
    `${relBase}/index.mjs`, `${relBase}/index.js`, `${relBase}/index.ts`,
  ]
  return cands.find((c) => fileSet.has(c)) ?? null
}

function extractImportsForFile(repoRoot, rel, text, fileSet) {
  const targets = new Set()
  for (const m of text.matchAll(IMPORT_SPEC_RE)) {
    const resolved = resolveRelativeImport(repoRoot, rel, m[1].trim(), fileSet)
    if (resolved) targets.add(resolved)
  }
  if (rel.endsWith('.py')) {
    for (const m of text.matchAll(PY_FROM_RE)) {
      const mod = m[1].replace(/^\.+/, '').replace(/\./g, '/')
      if (!mod) continue
      const dir = posixPath(dirname(rel))
      const cands = [`${mod}.py`, `${dir}/${mod}.py`, `src/${mod}.py`]
      const hit = cands.find((c) => fileSet.has(c))
      if (hit) targets.add(hit)
    }
  }
  return [...targets]
}

function readPublicSymbols(repoRoot, rel) {
  const text = readTextSafe(join(repoRoot, rel), 128 * 1024)
  if (!text) return []
  const ext = rel.includes('.') ? rel.split('.').pop() : ''
  return extractSymbols(text, ext).symbols.slice(0, 10)
}

/** 构建变更文件的直接依赖与逆向调用邻域（有界返回，避免灌爆上下文）。 */
export async function buildModuleNeighbors(repoRoot, changedFiles = []) {
  const changedCode = [...new Set(changedFiles.map((f) => posixPath(f)).filter((f) => CODE_EXT_RE.test(f)))]
  if (changedCode.length === 0) return { outgoing: [], incoming: [] }
  const changedSet = new Set(changedCode)

  const scan = await gitLsFilesTextAndCode(repoRoot, { isGit: true })
  const codeFiles = scan.files.filter((f) => f.isText && CODE_EXT_RE.test(f.rel) && !isToolOwnedPath(f.rel))
  const fileSet = new Set(codeFiles.map((f) => f.rel))
  const outgoingMap = new Map()
  const incomingMap = new Map()

  for (const rel of changedCode.slice(0, 20)) {
    const txt = readTextSafe(join(repoRoot, rel), 256 * 1024)
    if (!txt) continue
    for (const dep of extractImportsForFile(repoRoot, rel, txt, fileSet)) {
      if (changedSet.has(dep) || outgoingMap.has(dep)) continue
      outgoingMap.set(dep, { file: dep, relation: 'imports', via: rel, symbols: readPublicSymbols(repoRoot, dep) })
    }
  }

  for (const f of codeFiles.slice(0, 320)) {
    if (changedSet.has(f.rel) || isTestOrFixtureFile(f.rel) || incomingMap.size >= 12) continue
    const txt = readTextSafe(f.full, 128 * 1024)
    if (!txt) continue
    const deps = extractImportsForFile(repoRoot, f.rel, txt, fileSet)
    const hit = deps.find((d) => changedSet.has(d))
    if (hit && !incomingMap.has(f.rel)) {
      incomingMap.set(f.rel, { file: f.rel, relation: 'imported-by', via: hit, symbols: readPublicSymbols(repoRoot, f.rel) })
    }
  }

  return {
    outgoing: [...outgoingMap.values()].slice(0, 10),
    incoming: [...incomingMap.values()].slice(0, 12),
  }
}

export function detectRuntimeCapabilities({ reviewRoot, mainRoot, gitDir, effectiveProfile, taskId, matchedTestRefs = [] }) {
  const runtimes = []
  for (const bin of ['node', 'python3', 'python', 'go', 'cargo', 'pytest', 'npm']) {
    if (resolveExecutable(bin, { cwd: reviewRoot })) runtimes.push(bin)
  }
  const scratchDir = posixPath(resolveTaskScratchDir(gitDir, taskId || 'review-probe', mainRoot))
  return {
    runtimes,
    smokeVerifyConfigured: (effectiveProfile?.['smoke-verify'] ?? []).length > 0,
    devProfileCommands: [
      ...(effectiveProfile?.['smoke-verify'] ?? []),
      ...(effectiveProfile?.['quick-test'] ?? []),
      ...(effectiveProfile?.['full-test'] ?? []),
    ],
    matchedTestRefs: matchedTestRefs.slice(0, 12),
    scratchDir,
  }
}

/**
 * 装配审查前置上下文：
 * - 按变更文件切片反查 `docs/feature-map.json`（缺失时自动轻量化内存预填不崩溃）；
 * - 无条件注入受波及 `businessFlows`、直接/逆向相邻模块接口、可用运行时能力；
 * - 执行免手工日期过时检查与跨 `>=2` PR `verify.scratch-used` 固化提示；
 * - 产出可执行实证任务单（无论有无预设工具均要求先跑业务流实证再 `--include-diff`）。
 */
export async function assembleReviewContext({ reviewRoot, mainRoot, gitDir, diff, effectiveProfile, baseRef, headSha = null, task }) {
  const changedFiles = [...new Set([...(diff?.files ?? []).map((f) => posixPath(f.file)), ...(diff?.untracked ?? []).map((f) => posixPath(f))])].sort()
  const runtimeChanged = changedFiles.filter((f) => CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f))
  const taskId = task?.taskId ?? 'review-probe'

  let featureMapSource = FEATURE_MAP_REL
  const warnings = []
  let matchedFeatures = []
  let matchedToolsRaw = []
  let matchedTestRefs = []
  let businessFlows = []

  const directMatch = matchFeatureMapForPaths(reviewRoot, changedFiles)
  if (directMatch.exists && !directMatch.corrupt) {
    matchedFeatures = directMatch.matchedFeatures
    matchedToolsRaw = directMatch.verificationTools.map((vt) => ({
      feature: matchedFeatures.find((f) => f.id === vt.featureId),
      tool: vt,
    })).filter((x) => x.feature)
    matchedTestRefs = directMatch.testRefs
    businessFlows = [...directMatch.businessFlows]
  } else {
    featureMapSource = directMatch.corrupt ? 'corrupt-fallback' : 'prefill-in-memory'
    if (directMatch.warning) warnings.push(directMatch.warning)
    try {
      const rm = await generateRepoMap(reviewRoot)
      const draft = prefillFeatureMapFromRepoMap(reviewRoot, rm, { write: false }).featureMap
      const aff = findAffectedFeatures(draft, changedFiles)
      matchedFeatures = aff.matchedFeatures
      matchedToolsRaw = aff.tools.map((t) => ({
        feature: matchedFeatures.find((f) => f.id === t.featureId),
        tool: t.tool,
      })).filter((x) => x.feature)
      matchedTestRefs = aff.testRefs
      businessFlows = [...aff.businessFlows]
    } catch {
      featureMapSource = 'unavailable'
    }
  }

  const neighbors = await buildModuleNeighbors(reviewRoot, changedFiles)
  if (businessFlows.length === 0 && runtimeChanged.length > 0) {
    for (const rf of runtimeChanged.slice(0, 6)) {
      const caller = neighbors.incoming.find((n) => n.via === rf)
      businessFlows.push(caller
        ? `${basename(rf)} 业务路径（直接调用方：${caller.file}）`
        : `${basename(rf)} 运行态入口/模块（${rf}）`)
    }
  }

  let resolvedBaseSha = null
  let effectiveHeadSha = headSha
  if (matchedToolsRaw.length > 0) {
    if (!effectiveHeadSha) {
      const hr = await gitRun(reviewRoot, ['--no-optional-locks', 'rev-parse', 'HEAD'])
      effectiveHeadSha = hr.ok ? hr.stdout.trim() : null
    }
    if (baseRef) {
      const br = await gitRun(reviewRoot, ['--no-optional-locks', 'rev-parse', '--verify', baseRef])
      if (br.ok) resolvedBaseSha = br.stdout.trim()
    }
  }
  const changedFilesSet = new Set(changedFiles)
  const verifyCache = matchedToolsRaw.length > 0 ? readVerifyCache(gitDir, mainRoot) : null
  const precomputed = { headSha: effectiveHeadSha, resolvedBaseSha, cache: verifyCache }
  const toolChecks = await Promise.all(
    matchedToolsRaw.map(async ({ feature, tool }) => {
      const staleness = await evaluateToolStaleness({
        repoRoot: reviewRoot, gitCommonDir: gitDir, mainRoot, feature, tool, baseRef,
        skipFingerprintOnUnbaselined: true, changedFilesSet, precomputed,
      })
      return { featureId: feature.id, featureName: feature.name, tool, staleness }
    }),
  )
  const healthyTools = toolChecks.filter((t) => t.staleness.status === 'fresh' || (t.staleness.status === 'stale' && t.tool.riskLevel === 'low'))
  const unbaselinedTools = toolChecks.filter((t) => t.staleness.status === 'unbaselined')
  const staleMediumTools = toolChecks.filter((t) => t.staleness.status === 'stale' && t.tool.riskLevel === 'medium')
  const staleHighRiskTools = toolChecks.filter((t) => (t.staleness.status === 'stale' && t.tool.riskLevel === 'high') || t.staleness.status === 'missing-script')

  const runtimeCapabilities = detectRuntimeCapabilities({
    reviewRoot, mainRoot, gitDir, effectiveProfile, taskId, matchedTestRefs,
  })
  const matchedIds = matchedFeatures.map((f) => f.id)
  const solidificationHints = detectScratchSolidificationHints({
    gitCommonDir: gitDir,
    mainRoot,
    filterFeatureIds: matchedIds.length > 0 ? matchedIds : null,
  })

  let strategy = 'no-runtime-changes'
  const actionItems = []
  if (runtimeChanged.length > 0) {
    if (staleHighRiskTools.length > 0) {
      strategy = 'stale-high-risk-blocked'
      actionItems.push(`检测到 ${staleHighRiskTools.length} 个高风险验证工具已过期或缺失脚本，禁止直接复用假绿；须先升级工具或改跑等效实时 E2E / 仓外探针。`)
    } else if (healthyTools.length > 0) {
      strategy = 'registered-tools'
      for (const h of healthyTools.slice(0, 4)) {
        const cmd = h.tool.command || (h.tool.scriptPath ? `node ${h.tool.scriptPath}` : '')
        actionItems.push(`优先运行已登记工具 [${h.featureId}/${h.tool.id}]: node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs run --tool ${h.tool.id}${baseRef ? ` --base ${baseRef}` : ''} --task ${taskId}${cmd ? ` (底层命令: ${cmd})` : ''}`)
      }
      for (const u of unbaselinedTools.slice(0, 2)) {
        actionItems.push(`待建基线工具 [${u.featureId}/${u.tool.id}]: node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs run --tool ${u.tool.id}${baseRef ? ` --base ${baseRef}` : ''} --task ${taskId}`)
      }
    } else if (unbaselinedTools.length > 0 && staleMediumTools.length === 0) {
      strategy = 'unbaselined-tools'
      for (const u of unbaselinedTools.slice(0, 4)) {
        const cmd = u.tool.command || (u.tool.scriptPath ? `node ${u.tool.scriptPath}` : '')
        actionItems.push(`工具尚无基线 [${u.featureId}/${u.tool.id}]，须先实跑建基线后再放行：node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs run --tool ${u.tool.id}${baseRef ? ` --base ${baseRef}` : ''} --task ${taskId}${cmd ? ` (底层命令: ${cmd})` : ''}`)
      }
    } else if (staleMediumTools.length > 0) {
      strategy = 'stale-medium-fallback'
      actionItems.push(`中风险预设工具已过期，请转跑关联 testRefs (${matchedTestRefs.join(', ') || '无'}) 或在仓外 ${runtimeCapabilities.scratchDir} 编写临时探针验证受波及业务流。`)
    } else {
      strategy = 'zero-preset-empirical'
      actionItems.push('功能地图未登记对应预设验证工具，但严禁跳过实证直接看 --include-diff；按分级策略依次执行：')
      actionItems.push(`  1. 复用项目现有命令/testRefs：${runtimeCapabilities.devProfileCommands[0] ?? matchedTestRefs[0] ?? '无预设命令，进入步骤 2'}`)
      actionItems.push(`  2. 复用本机可用运行/浏览器/GUI/模拟器能力（已探测：${runtimeCapabilities.runtimes.join(', ') || '基础环境'}）真启真测受波及业务流`)
      actionItems.push(`  3. 缺少现成入口时在仓外 ${runtimeCapabilities.scratchDir} 现写一次性探针脚本真实运行并采证（绝不脏仓树）`)
      actionItems.push('  4. 缺不可替代外部环境时如实阻断汇报，绝不假绿，并通过 --e2e-evidence 写明入口与真实输出')
    }
  }

  const contextBrief = buildContextBrief(reviewRoot, {
    paths: changedFiles,
    keywords: [],
    excludeFiles: [task?.specFile, task?.todoFile, task?.prdFile].filter(Boolean),
    role: 'reviewer',
    profile: effectiveProfile,
  })
  const dg = contextBrief?.docGraph
  const docGraphWarnings = []
  if (dg) {
    if (dg.brokenLinksCount > 0) docGraphWarnings.push(`存在 ${dg.brokenLinksCount} 处文档断链 (brokenLinks)`)
    if (dg.brokenAnchorsCount > 0) docGraphWarnings.push(`存在 ${dg.brokenAnchorsCount} 处失效文档标题锚点 (brokenAnchors)`)
    if (dg.anchorWarningsCount > 0) docGraphWarnings.push(`存在 ${dg.anchorWarningsCount} 处 feature-map docAnchors 缺标题告警 (missing-doc-anchor-heading)`)
    if (dg.cyclesCount > 0) docGraphWarnings.push(`检测到 ${dg.cyclesCount} 组权威文档互指环 (cycles)`)
    if (dg.redirectChainsCount > 0) docGraphWarnings.push(`检测到 ${dg.redirectChainsCount} 条多跳重定向链 (redirectChains)`)
    if (dg.orphansCount > 0) docGraphWarnings.push(`存在 ${dg.orphansCount} 份从入口不可达的权威文档 (orphans)`)
    if (dg.unaccountedCount > 0) docGraphWarnings.push(`存在 ${dg.unaccountedCount} 份未纳管活跃文档 (${(dg.unaccountedDocs ?? []).slice(0, 4).join(', ')})`)
  }
  for (const w of docGraphWarnings) warnings.push(w)

  return {
    featureMapSource,
    warnings,
    docGraphWarnings,
    changedFilesCount: changedFiles.length,
    runtimeFilesCount: runtimeChanged.length,
    contextBrief,
    matchedFeatures: matchedFeatures.map((f) => ({
      id: f.id,
      name: f.name,
      matchedFiles: f.matchedFiles ?? [],
      businessFlows: f.businessFlows ?? [],
      testRefs: f.testRefs ?? [],
    })),
    affectedBusinessFlows: businessFlows,
    adjacentModules: neighbors,
    toolChecks: toolChecks.map((t) => ({
      featureId: t.featureId,
      toolId: t.tool.id,
      riskLevel: t.tool.riskLevel,
      command: t.tool.command,
      scriptPath: t.tool.scriptPath,
      status: t.staleness.status,
      code: t.staleness.code,
      reasons: t.staleness.reasons,
    })),
    healthyToolCommands: healthyTools.map((h) => h.tool.command || (h.tool.scriptPath ? `node ${h.tool.scriptPath}` : '')).filter(Boolean),
    unbaselinedTools: unbaselinedTools.map((t) => ({ featureId: t.featureId, toolId: t.tool.id, riskLevel: t.tool.riskLevel })),
    staleMediumTools: staleMediumTools.map((t) => ({ featureId: t.featureId, toolId: t.tool.id, reasons: t.staleness.reasons })),
    staleHighRiskTools: staleHighRiskTools.map((t) => ({ featureId: t.featureId, toolId: t.tool.id, code: t.staleness.code, reasons: t.staleness.reasons })),
    runtimeCapabilities,
    solidificationHints,
    empiricalTaskOrder: {
      strategy,
      hasPresetTools: toolChecks.length > 0,
      actionItems,
    },
  }
}

/** 将 reviewContext 渲染为精简文本节区（供 review-gates.mjs formatPackText 调用）。 */
export function formatReviewContextLines(rc) {
  if (!rc) return []
  const lines = ['', '--- Business Flows, Adjacent Modules & Verification Context ---']
  lines.push(`  Map Source : ${rc.featureMapSource} | Matched Features: ${rc.matchedFeatures.length} | Strategy: ${rc.empiricalTaskOrder.strategy}`)
  if (rc.affectedBusinessFlows.length > 0) {
    lines.push('  Affected Business Flows:')
    for (const bf of rc.affectedBusinessFlows.slice(0, 8)) lines.push(`    - ${bf}`)
  }
  const adj = [...(rc.adjacentModules?.incoming ?? []), ...(rc.adjacentModules?.outgoing ?? [])]
  if (adj.length > 0) {
    lines.push(`  Adjacent Modules (${adj.length}):`)
    for (const m of adj.slice(0, 8)) {
      lines.push(`    - [${m.relation}] ${m.file} (via ${m.via})${m.symbols?.length ? ` [exports: ${m.symbols.slice(0, 5).join(', ')}]` : ''}`)
    }
  }
  lines.push(`  Runtime Env: runtimes=[${rc.runtimeCapabilities.runtimes.join(', ') || 'none'}] | scratchDir=${rc.runtimeCapabilities.scratchDir}`)
  if (rc.toolChecks.length > 0) {
    lines.push('  Verification Tools (Date-Free Staleness):')
    for (const t of rc.toolChecks.slice(0, 6)) {
      lines.push(`    - [${t.featureId}/${t.toolId}] risk=${t.riskLevel} status=${t.status}${t.code ? ` (${t.code})` : ''}${t.reasons?.length ? ` — ${t.reasons[0]}` : ''}`)
    }
  }
  for (const item of rc.empiricalTaskOrder.actionItems) lines.push(`  * ${item}`)
  for (const h of rc.solidificationHints ?? []) lines.push(`  - [${h.code}] ${h.suggestion}`)
  if ((rc.docGraphWarnings?.length ?? 0) > 0) {
    lines.push(`  Doc Graph Alerts (${rc.docGraphWarnings.length}):`)
    for (const w of rc.docGraphWarnings.slice(0, 6)) lines.push(`    - ${w}`)
  }
  const brief = rc.contextBrief ?? rc.evergreenContext
  const topoFm = brief?.featureMap
  if (topoFm && !topoFm.corrupt && (rc.affectedBusinessFlows?.length ?? 0) > 0) {
    if ((topoFm.downstream?.length ?? 0) > 0) {
      lines.push(`  1-Hop Downstream Impact: ${topoFm.downstream.slice(0, 6).map((n) => `${n.id}[${n.entrypoint ?? '-'}]`).join(', ')}`)
    }
    if ((topoFm.upstream?.length ?? 0) > 0) {
      lines.push(`  1-Hop Upstream Deps: ${topoFm.upstream.slice(0, 6).map((n) => `${n.id}[${n.entrypoint ?? '-'}]`).join(', ')}`)
    }
    if ((topoFm.matchedFlows?.length ?? 0) > 0) {
      lines.push(`  Topology Flows: ${topoFm.matchedFlows.slice(0, 4).map((f) => f.summary).join(' | ')}`)
    }
  }
  if (brief) {
    lines.push(...formatContextBriefLines(brief, {
      title: '  Evergreen Docs & Context Brief:',
      role: 'reviewer',
      includeFeatureMap: (rc.affectedBusinessFlows?.length ?? 0) === 0,
    }))
  }
  return lines
}
