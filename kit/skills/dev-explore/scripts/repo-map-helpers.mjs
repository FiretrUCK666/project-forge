/**
 * repo-map-helpers.mjs —— 从 `repo-map.mjs` 拆出的 CI 步骤、任务入口、Feature Map、业务流与报告格式化辅助。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`）。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { validateExecutableCommandShape } from '../../lib/command-lex.mjs'
import { isNonFeatureArtifactPath, matchTestsForSourceFile, slugifyFeatureId } from '../../lib/feature-map.mjs'
import { normRelPath } from '../../lib/feature-map-graph.mjs'
import { posixPath, readJsonSafe, readTextSafe } from '../../lib/git.mjs'
import {
  buildDirFileIndex, extractImportsForArch, resolveGoModules, resolveLocalImportTarget,
} from '../../lib/import-graph.mjs'
import { isProfileExplicitNone } from '../../lib/profile.mjs'
import { extractStructuredCiSteps, scanDeclaredTaskRunners } from '../../lib/profile-sniffer.mjs'
import { isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

/** 复用 profile-sniffer.mjs 单源提取中立 CI 步骤（含 workingDirectory 与可执行标记）。 */
export function extractCiRunSteps(root, _readdirSyncFn) {
  const structured = extractStructuredCiSteps(root)
  const cleanByKey = new Map()
  for (const s of structured.steps ?? []) {
    cleanByKey.set(`${s.file}:${s.line}:${s.cmd}`, s)
  }
  const steps = []
  const seenFiles = new Set()
  for (const raw of structured.rawSteps ?? []) {
    const cmd = String(raw?.cmd ?? '').trim()
    if (!cmd) continue
    const norm = cmd.replace(/\s+/g, ' ').trim()
    const cleanHit = cleanByKey.get(`${raw.file}:${raw.line}:${norm}`) ?? null
    seenFiles.add(raw.file)
    steps.push({
      workflow: basename(raw.file),
      job: null,
      stepName: cleanHit?.kind ?? 'ci-step',
      workingDirectory: raw.workingDirectory ?? null,
      file: raw.file,
      command: cmd,
      runnable: Boolean(cleanHit),
    })
  }
  for (const extraCi of ['.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml']) {
    if (!seenFiles.has(extraCi) && existsSync(join(root, extraCi))) {
      steps.push({ workflow: basename(extraCi), job: null, stepName: 'ci-config', workingDirectory: null, file: extraCi, command: `(detected ${extraCi})`, runnable: false })
    }
  }
  return steps.slice(0, 50)
}

/** 复用 profile-sniffer.mjs 单源提取根级 Makefile / justfile / Taskfile 与子包任务入口。 */
export function extractTaskRunners(root, packages) {
  const declared = scanDeclaredTaskRunners(root)
  const runners = {
    makefile: [...(declared.makeTargets ?? [])],
    justfile: [...(declared.justRecipes ?? [])],
    taskfile: [...(declared.taskNames ?? [])],
    npmScripts: [],
    subpackages: [],
  }
  const rootPkg = readJsonSafe(join(root, 'package.json'))
  if (rootPkg?.scripts && typeof rootPkg.scripts === 'object') {
    for (const [k, v] of Object.entries(rootPkg.scripts)) runners.npmScripts.push({ name: k, command: String(v) })
  }
  for (const pkg of packages ?? []) {
    if (!pkg.dirRel) continue
    const nodeCmds = pkg.commands?.node
    if (nodeCmds?.scripts?.length) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: 'node', scripts: nodeCmds.scripts })
    for (const [eco, cmdObj] of Object.entries(pkg.commands ?? {})) {
      if (eco !== 'node' && cmdObj?.quickTest) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: eco, quickTest: cmdObj.quickTest })
    }
  }
  return runners
}

function extractFeatureTableCellPaths(root, rawCell) {
  const cleaned = String(rawCell ?? '').replace(/`/g, ' ').replace(/\r?\n/g, ' ')
  const tokens = cleaned.split(/[\s,，;；()[\]]+/).map((t) => t.trim()).filter(Boolean)
  const paths = []
  const symbols = []
  const seen = new Set()
  for (const tok of tokens) {
    const colonParts = tok.split('::')
    const baseTok = colonParts[0]
    const cand = baseTok
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '')
    if (!cand || cand.includes('..') || /^https?:/i.test(cand) || /[<>*?]/.test(cand)) continue
    if (existsSync(join(root, cand))) {
      if (!seen.has(cand)) { seen.add(cand); paths.push(cand) }
      if (colonParts[1]) symbols.push(colonParts.slice(1).join('::'))
    } else if (/^[A-Za-z_][A-Za-z0-9_.:]*(?:\([^)]*\))?$/.test(tok)) {
      symbols.push(tok)
    }
  }
  return { paths, symbols: [...new Set(symbols)] }
}

function resolveClusterForSource(relPath, packages = []) {
  const norm = normRelPath(relPath)
  const sortedPkgs = [...(Array.isArray(packages) ? packages : [])]
    .filter((p) => p?.dirRel)
    .sort((a, b) => b.dirRel.length - a.dirRel.length)
  const hitPkg = sortedPkgs.find((p) => norm === p.dirRel || norm.startsWith(`${p.dirRel}/`))
  if (hitPkg) {
    return { key: hitPkg.dirRel, label: hitPkg.name || hitPkg.dirRel, pkg: hitPkg }
  }
  const segs = norm.split('/').filter(Boolean)
  if (segs[0] === 'kit' && segs[1] === 'skills' && segs[2]) {
    const key = `kit/skills/${segs[2]}`
    return { key, label: segs[2] === 'lib' ? 'kit-lib' : segs[2], pkg: null }
  }
  if (segs.length >= 3) {
    const key = `${segs[0]}/${segs[1]}`
    return { key, label: key, pkg: null }
  }
  if (segs.length === 2) {
    return { key: segs[0], label: segs[0], pkg: null }
  }
  return { key: 'root', label: basename(norm).replace(/\.[^.]+$/, '') || 'root', pkg: null }
}

export function buildFeatureMap(root, entrypoints, testFiles, profile, runners, packages, projectCodeFiles = []) {
  const features = []
  const seen = new Set()
  const tddText = readTextSafe(join(root, 'docs', 'TDD.md'))
  if (tddText) {
    const fmIdx = tddText.search(/^##.*(?:Feature\s*Map|功能与入口地图|模块拓扑)/mi)
    if (fmIdx >= 0) {
      for (const line of tddText.slice(fmIdx).split('\n').slice(1, 40)) {
        if (/^##\s+/.test(line)) break
        const row = /^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line.trim())
        if (!row) continue
        const [c1, c2, c3] = [row[1], row[2], row[3]].map((s) => s.trim().replace(/`/g, ''))
        if (!c1 || /^[-:]+$/.test(c1) || /功能|模块|Feature|Entry/i.test(c1) || /^<.*>$/.test(c1)) continue
        const extracted = extractFeatureTableCellPaths(root, row[2])
        if (extracted.paths.length === 0) continue
        const primary = extracted.paths[0]
        const key = `${c1}=>${primary}`
        if (!seen.has(key)) {
          seen.add(key)
          features.push({
            feature: c1,
            source: primary,
            ...(extracted.paths.length > 1 ? { sources: extracted.paths } : {}),
            ...(extracted.symbols.length > 0 ? { symbols: extracted.symbols } : {}),
            verifyCmd: c3 || profile.smokeVerify || profile.quickTest || '待补充',
            origin: 'docs/TDD.md',
          })
        }
      }
    }
  }

  // 按 Workspace 包或二级架构子目录聚类源码与入口，避免字母序截断碎片并汇总同域 testRefs
  const entrySet = new Set((entrypoints ?? []).map((p) => normRelPath(p)).filter((p) => p && !isNonFeatureArtifactPath(p)))
  const sourcePool = []
  const seenPool = new Set()
  for (const ep of entrySet) { seenPool.add(ep); sourcePool.push(ep) }
  for (const item of Array.isArray(projectCodeFiles) ? projectCodeFiles : []) {
    const rel = normRelPath(item?.rel ?? item)
    if (!rel || seenPool.has(rel) || isNonFeatureArtifactPath(rel)) continue
    seenPool.add(rel)
    sourcePool.push(rel)
  }

  const clusters = new Map()
  for (const rel of sourcePool) {
    const info = resolveClusterForSource(rel, packages)
    if (!clusters.has(info.key)) {
      clusters.set(info.key, { key: info.key, label: info.label, pkg: info.pkg, entrypoints: [], modules: [], testRefs: new Set() })
    }
    const bucket = clusters.get(info.key)
    if (entrySet.has(rel) && bucket.entrypoints.length < 10) bucket.entrypoints.push(rel)
    if (bucket.modules.length < 30) bucket.modules.push(rel)
  }

  const normTests = (Array.isArray(testFiles) ? testFiles : []).map((t) => normRelPath(t)).filter(Boolean)
  for (const bucket of clusters.values()) {
    const prefix = bucket.key === 'root' ? '' : `${bucket.key}/`
    for (const tf of normTests) {
      if (prefix && tf.startsWith(prefix)) bucket.testRefs.add(tf)
    }
    const probeSources = [...new Set([...bucket.entrypoints, ...bucket.modules.slice(0, 12)])]
    for (const src of probeSources) {
      for (const mt of matchTestsForSourceFile(src, normTests)) bucket.testRefs.add(mt)
    }
  }

  const sortedClusters = [...clusters.values()].sort((a, b) => (b.entrypoints.length - a.entrypoints.length) || (b.modules.length - a.modules.length) || a.key.localeCompare(b.key))
  for (const bucket of sortedClusters.slice(0, 30)) {
    const primary = bucket.entrypoints[0] ?? bucket.modules[0]
    if (!primary) continue
    const pkgCmd = bucket.pkg ? Object.values(bucket.pkg.commands ?? {}).find((c) => c?.quickTest)?.quickTest : null
    const verifyCmd = pkgCmd ?? profile.smokeVerify ?? profile.quickTest ?? null
    const key = `${bucket.label}=>${primary}`
    if (!seen.has(key)) {
      seen.add(key)
      const allSources = [...new Set([...bucket.entrypoints, ...bucket.modules])].slice(0, 20)
      features.push({
        feature: bucket.label,
        source: primary,
        ...(allSources.length > 1 ? { sources: allSources } : {}),
        ...(bucket.testRefs.size > 0 ? { testRefs: [...bucket.testRefs].sort().slice(0, 20) } : {}),
        verifyCmd: verifyCmd ?? (isProfileExplicitNone(profile, 'quick-test') ? 'none (explicit)' : '未配置（建议补充 smoke-verify）'),
        origin: 'detected-domain',
      })
    }
  }
  return features.slice(0, 35)
}

export function buildPreferredVerifyCommands(profile, ciRunSteps, runners, packages) {
  const list = []
  const add = (role, cmd, source, workingDirectory = null) => {
    if (!cmd || list.some((x) => x.command === cmd && x.role === role && x.workingDirectory === workingDirectory)) return
    list.push({ role, command: cmd, source, ...(workingDirectory ? { workingDirectory } : {}) })
  }
  add('quick-test', profile.quickTest, profile.hasAgents ? 'AGENTS.md/auto' : 'auto')
  add('smoke-verify', profile.smokeVerify, 'AGENTS.md')
  add('full-test', profile.fullTest, 'AGENTS.md/auto')
  add('merge-gate', profile.mergeGate, 'AGENTS.md/auto')
  for (const step of ciRunSteps) {
    if (step.runnable === false || !validateExecutableCommandShape(step.command, { allowNone: false }).ok) continue
    if (/\b(?:test|check|verify|lint|smoke|preflight|build|mvn|gradle|pytest|cargo|go)\b/i.test(step.command)) {
      add('ci-check', step.command, step.file, step.workingDirectory ?? null)
    }
  }
  for (const pkg of packages) {
    if (!pkg.dirRel) continue
    for (const c of Object.values(pkg.commands)) {
      if (c?.quickTest) add('package-test', c.quickTest, `${pkg.dirRel}/`, pkg.dirRel)
    }
  }
  const targetRe = /^(?:test|check|smoke|lint|verify|build)$/i
  for (const mk of runners.makefile) if (targetRe.test(mk)) add('make-target', `make ${mk}`, 'Makefile')
  for (const jf of runners.justfile) if (targetRe.test(jf)) add('just-target', `just ${jf}`, 'justfile')
  for (const tf of runners.taskfile) if (targetRe.test(tf)) add('task-target', `task ${tf}`, 'Taskfile.yml')
  return list.slice(0, 25)
}

export function buildBusinessFlows(root, files, entrypoints, cliEntrypoints) {
  const nonTool = files.filter((f) => !isToolOwnedPath(f.rel) && !isTestOrFixtureFile(f.rel) && !/^(?:dist|build|coverage)\//i.test(f.rel))
  const fileSet = new Set(files.map((f) => f.rel))
  const routes = nonTool
    .filter((f) => /(?:^|\/)(?:routes?|routers?|controllers?|handlers?|endpoints?|pages\/api)\//i.test(f.rel)
      || /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(f.rel) || /\.proto$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const ui = nonTool
    .filter((f) => /\.(?:tsx|jsx|vue|svelte|astro)$/i.test(f.rel)
      || /(?:^|\/)(?:pages|screens|views|app)\/[^/]+\.(?:tsx|jsx|vue|svelte|html)$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const jobs = nonTool
    .filter((f) => /(?:^|\/)(?:jobs?|workers?|queues?|cron|schedules?|pipelines?)\//i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const cli = cliEntrypoints.length > 0
    ? cliEntrypoints
    : entrypoints.filter((ep) => /(?:^|\/)(?:cmd|bin|cli)\//i.test(ep) || ep === 'SKILL.md')
        .map((ep) => ({ ecosystem: 'generic', name: basename(ep), file: ep }))

  const audienceCues = []
  let primaryDocText = ''
  for (const cand of ['README.md', 'README.zh-CN.md', 'README.en.md', 'ARCHITECTURE.md', 'docs/TDD.md']) {
    const txt = readTextSafe(join(root, cand))
    if (!txt) continue
    primaryDocText += `\n${txt}`
    if (audienceCues.length === 0) {
      const lead = txt.split('\n').map((l) => l.trim()).find((l) => l && !/^(?:#|<!--|\[!|!\[)/.test(l))
      if (lead) audienceCues.push(lead.slice(0, 120))
    }
  }
  if (cli.length > 0) audienceCues.push('CLI/命令行用户与自动化脚本')
  if (routes.length > 0) audienceCues.push('HTTP/RPC 接口调用方')
  if (ui.length > 0) audienceCues.push('交互式前端界面用户')
  if (jobs.length > 0) audienceCues.push('后台作业与持续集成流水线')

  const flows = [
    ...cli.slice(0, 10).map((c) => ({ name: `CLI:${c.name}`, surface: 'cli', entry: c.file, source: c.target ?? c.file })),
    ...routes.slice(0, 8).map((r) => ({ name: basename(r), surface: 'route', entry: r, source: r })),
    ...ui.slice(0, 6).map((u) => ({ name: basename(u), surface: 'ui', entry: u, source: u })),
    ...jobs.slice(0, 6).map((j) => ({ name: basename(j), surface: 'job', entry: j, source: j })),
  ]
  const docCodeGaps = []
  if (primaryDocText) {
    const seenGap = new Set()
    for (const m of primaryDocText.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?)`/g)) {
      const p = m[1].replace(/^\.\//, '')
      if (p.includes('<') || p.includes('*') || /^https?:/.test(p) || isToolOwnedPath(p)) continue
      if (!/\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|sh|ya?ml|json|toml|proto)$/i.test(p)) continue
      if (!fileSet.has(p) && !existsSync(join(root, p)) && !seenGap.has(p)) {
        seenGap.add(p)
        docCodeGaps.push({ kind: 'missing-doc-path', path: p, detail: `文档引用的路径 ${p} 在源码树中不存在` })
      }
    }
    for (const c of cli.slice(0, 10)) {
      if (!primaryDocText.includes(c.name) && !primaryDocText.includes(c.file)) {
        docCodeGaps.push({ kind: 'undocumented-entry', path: c.file, detail: `源码 CLI 入口 ${c.name}（${c.file}）未在 README/TDD 说明` })
      }
    }
  }
  return {
    audienceCues: [...new Set(audienceCues)].slice(0, 6),
    surfaces: { routes, cli: cli.slice(0, 12), ui, jobs },
    flows: flows.slice(0, 25),
    docCodeGaps: docCodeGaps.slice(0, 15),
  }
}

function resolveFeatureDomainMeta(primaryPath, packages = []) {
  const norm = normRelPath(primaryPath)
  const sortedPkgs = [...(Array.isArray(packages) ? packages : [])]
    .filter((p) => p?.dirRel)
    .sort((a, b) => b.dirRel.length - a.dirRel.length)
  const hitPkg = sortedPkgs.find((p) => norm === p.dirRel || norm.startsWith(`${p.dirRel}/`))
  if (hitPkg) {
    return { id: slugifyFeatureId(hitPkg.dirRel), name: hitPkg.name || hitPkg.dirRel }
  }
  const segs = norm.split('/').filter(Boolean)
  if (segs[0] === 'kit' && segs[1] === 'skills' && segs[2]) {
    const label = segs[2] === 'lib' ? 'kit-lib' : segs[2]
    return { id: slugifyFeatureId(label), name: label }
  }
  if (segs.length <= 1) return { id: 'core', name: 'core' }
  return { id: slugifyFeatureId(segs[0]), name: segs[0] }
}

/** Layer-1 确定性推导 `domains[]` 与基于跨模块引用的无环 `dependsOn[]`（单源复用 `import-graph.mjs`）。 */
export function inferLayer1Topology(root, files = [], featureEntries = [], flowEntries = [], packages = []) {
  const fileSet = new Set((files ?? []).map((f) => posixPath(f.rel ?? f)))
  const dirIndex = buildDirFileIndex(fileSet)
  const goModules = resolveGoModules(root)
  const featFiles = new Map()
  const fileOwner = new Map()
  const domainMap = new Map()
  const domainByFeatureId = {}
  const dependsOnByFeatureId = {}

  const registerFeature = (fid, paths) => {
    if (!fid || featFiles.has(fid)) return
    const valid = paths.map((p) => normRelPath(p)).filter(Boolean)
    if (valid.length === 0) return
    featFiles.set(fid, valid)
    for (const p of valid) {
      if (!fileOwner.has(p)) fileOwner.set(p, fid)
    }
    const dom = resolveFeatureDomainMeta(valid[0], packages)
    domainByFeatureId[fid] = dom.id
    if (!domainMap.has(dom.id)) {
      domainMap.set(dom.id, { id: dom.id, name: dom.name, entrypoints: [] })
    }
    const dEntry = domainMap.get(dom.id)
    if (!dEntry.entrypoints.includes(valid[0])) dEntry.entrypoints.push(valid[0])
    dependsOnByFeatureId[fid] = []
  }

  for (const fm of Array.isArray(featureEntries) ? featureEntries : []) {
    const src = normRelPath(String(fm?.source ?? '').trim())
    if (!src || isNonFeatureArtifactPath(src)) continue
    const extra = Array.isArray(fm?.sources) ? fm.sources.map((p) => normRelPath(p)).filter((p) => p && !isNonFeatureArtifactPath(p)) : []
    const fid = slugifyFeatureId(fm?.feature || basename(src).replace(/\.[^.]+$/, ''))
    registerFeature(fid, [src, ...extra])
  }
  for (const fl of Array.isArray(flowEntries) ? flowEntries : []) {
    const ep = normRelPath(fl?.entry)
    if (!ep || isNonFeatureArtifactPath(ep)) continue
    const fid = slugifyFeatureId(basename(ep).replace(/\.[^.]+$/, ''))
    registerFeature(fid, [ep])
  }

  const edgeWeights = new Map()
  for (const [fid, paths] of featFiles.entries()) {
    for (const rel of paths) {
      const txt = readTextSafe(join(root, rel), 256 * 1024)
      if (!txt) continue
      const targets = new Set()
      for (const imp of extractImportsForArch(rel, txt, goModules)) {
        const resolved = resolveLocalImportTarget(imp.candidates, fileSet, { dirIndex })
        if (resolved) targets.add(resolved)
      }
      for (const tgt of targets) {
        const targetFid = fileOwner.get(tgt)
        if (!targetFid || targetFid === fid) continue
        const key = `${fid}=>${targetFid}`
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1)
      }
    }
  }

  const sortedEdges = [...edgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('=>')
      return { from, to, weight }
    })
    .sort((a, b) => (b.weight - a.weight) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const dagAdj = new Map()
  const canReach = (start, goal) => {
    const visited = new Set([start])
    const stack = [start]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (cur === goal) return true
      for (const nxt of dagAdj.get(cur) ?? []) {
        if (!visited.has(nxt)) { visited.add(nxt); stack.push(nxt) }
      }
    }
    return false
  }
  for (const edge of sortedEdges) {
    if (canReach(edge.to, edge.from)) continue
    if (!dagAdj.has(edge.from)) dagAdj.set(edge.from, [])
    dagAdj.get(edge.from).push(edge.to)
    dependsOnByFeatureId[edge.from].push(edge.to)
  }
  for (const deps of Object.values(dependsOnByFeatureId)) deps.sort()

  const domains = [...domainMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { domains, domainByFeatureId, dependsOnByFeatureId }
}

export function formatRepoMapText(map) {
  const lines = [
    `# 仓库地图：${map.name}`,
    `- 路径: ${map.root}（枚举器: ${map.scanSource}）`,
    `- Git: ${map.isGit ? `是（分支: ${map.branch ?? 'detached/unborn'}）` : '否'} | 生态: ${map.devProfile.ecosystems.join(', ') || '未识别'}`,
    `- 文件统计: 共 ${map.totalFiles}${map.truncated ? '+' : ''} 个（文本 ${map.textFileCount}，源码 ${map.codeFileCount}，测试 ${map.testFileCount}）`,
  ]
  if (map.packages.length > 0) {
    lines.push('', '## 多生态包清单（Manifest-First）')
    for (const p of map.packages) lines.push(`- [${p.dirRel || '.'}] (${p.ecosystems.join(', ') || 'generic'}) manifests=${p.manifests.join(', ')}`)
  }
  const fmtCmd = (val, key) => val ?? (map.devProfile.explicitNone.includes(key) ? 'none (显式关闭)' : '未配置')
  lines.push(
    '', '## Dev Profile 与优先验证入口',
    `- quick-test: ${fmtCmd(map.devProfile.quickTest, 'quick-test')}`,
    `- smoke-verify: ${fmtCmd(map.devProfile.smokeVerify, 'smoke-verify')}`,
    `- full-test: ${fmtCmd(map.devProfile.fullTest, 'full-test')}`,
    `- merge-gate: ${fmtCmd(map.devProfile.mergeGate, 'merge-gate')}`,
    `- high-risk: ${map.devProfile.highRisk.join(', ') || '无'}`,
  )
  if (map.ciRunSteps.length > 0) {
    lines.push('', '## CI 工作流验证步骤')
    for (const s of map.ciRunSteps.slice(0, 12)) {
      lines.push(`- [${s.file}]${s.workingDirectory ? ` (cwd=${s.workingDirectory})` : ''} ${s.command.replace(/\n/g, ' ; ')}`)
    }
  }
  lines.push('', '## 顶层目录分布')
  for (const d of map.topDirectories) lines.push(`- ${d.dir}: ${d.count} 个文件`)
  if (map.reusableModules.length > 0) {
    lines.push('', '## 可复用现成模块清单')
    for (const m of map.reusableModules) lines.push(`- ${m.file}${m.exports.length > 0 ? ` [导出: ${m.exports.join(', ')}]` : ''}`)
  }
  if (map.symbolCoverage?.languageCount > 0) {
    lines.push('', `## 符号抽取覆盖：本仓 ${map.symbolCoverage.languageCount} 种语言，其中 ${map.symbolCoverage.unsupportedCount} 种缺少符号规则`)
    if (map.symbolCoverage.unsupportedCount > 0) {
      lines.push(`- 缺规则的语言（这些语言的模块没有符号清单，不是「没有符号」）：${map.symbolCoverage.unsupported.join('、')}`)
    }
  }
  if (map.featureMap.length > 0) {
    lines.push('', '## Feature Map（入口 -> 源码 -> 验证）')
    for (const fm of map.featureMap) lines.push(`- ${fm.feature}: ${fm.source} -> ${fm.verifyCmd}`)
  }
  if (map.businessFlows) {
    const bf = map.businessFlows
    lines.push('', '## 核心业务流与服务入口（Business Flows）')
    if (bf.audienceCues.length > 0) lines.push(`- 服务对象线索: ${bf.audienceCues.join('；')}`)
    for (const fl of bf.flows.slice(0, 12)) lines.push(`- [${fl.surface}] ${fl.name}: ${fl.entry}`)
    for (const g of bf.docCodeGaps.slice(0, 8)) lines.push(`- [文档差异:${g.kind}] ${g.detail}`)
  }
  if (map.testFiles.length > 0) {
    lines.push('', '## 测试文件（前 40 项）')
    for (const t of map.testFiles) lines.push(`- ${t}`)
  }
  lines.push(
    '', '## 工程文档现状与按需定位入口',
    `- AGENTS.md: ${map.docs.agents ? '有' : '无'} | ARCHITECTURE.md: ${map.docs.architecture ? map.docs.architecture.file : '无'} | docs/TDD.md: ${map.docs.tdd ? '有' : '无'} | prd: ${map.docs.prd.length} | specs: ${map.docs.specs.length} | todo: ${map.docs.todo.length}`,
  )
  if ((map.docs.subAgents ?? []).length > 0) {
    lines.push(`- 子目录 AGENTS.md: ${map.docs.subAgents.map((s) => s.file).join(', ')}`)
  }
  if ((map.docs.headlessDocs ?? []).length > 0) {
    lines.push(`- 无头/非 Frontmatter 文档 (${map.docs.headlessDocs.length} 份):`)
    for (const hd of map.docs.headlessDocs.slice(0, 6)) lines.push(`  - ${hd.file}: ${hd.summary || '无摘要'}`)
  }
  lines.push(`- 按需定位命令: ${map.docLocateHint}`)
  if (map.hotspots.length > 0) {
    lines.push('', '## 近期修改热点（git log 前 10）')
    for (const h of map.hotspots) lines.push(`- ${h.file} (${h.touches} 次)`)
  }
  return `${lines.join('\n')}\n`
}
