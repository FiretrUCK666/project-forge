#!/usr/bin/env node
/**
 * repo-map.mjs —— 只读探索仓库结构、多生态包清单、CI 步骤、可复用模块、Feature Map 与 git 热点。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--dir <path>] [--focus <subdir>] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, posix } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { discoverContextDocs } from '../../lib/doc-locator.mjs'
import { FEATURE_MAP_REL, isNonFeatureArtifactPath, prefillFeatureMapFromRepoMap } from '../../lib/feature-map.mjs'
import {
  gitLsFilesTextAndCode, gitRun, isMainModule, posixPath, readJsonSafe, readTextSafe, resolveRepoRoots,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { createExploredEvidence, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { discoverWorkspacePackages, parseAgentsProfile } from '../../lib/profile.mjs'
import { recordTopicAnchors } from '../../lib/session-state.mjs'
import { TEST_FILE_RE, isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { extractSymbols, summarizeSymbolCoverage } from '../../lib/symbol-index.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'
import {
  buildBusinessFlows, buildFeatureMap, buildPreferredVerifyCommands,
  extractCiRunSteps, extractTaskRunners, formatRepoMapText, inferLayer1Topology,
} from './repo-map-helpers.mjs'

const CODE_RE = /\.(?:js|mjs|cjs|mts|cts|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|kts|scala|groovy|rb|php|cs|fs|vb|c|cc|cpp|cxx|h|hpp|m|mm|swift|dart|ex|exs|erl|sh|bash|zsh|ps1|sql|lua|r|zig|nim|hs)$/i
const DOC_OR_DATA_EXT_RE = /\.(?:md|mdx|txt|rst|json|ya?ml|toml|xml|csv|tsv|ini|cfg|lock|lockb|svg|png|jpg|jpeg|gif|webp|ico|pdf|woff2?)$/i
const ENTRY_NAMES = new Set([
  'index.js', 'index.mjs', 'index.ts', 'index.tsx', 'main.js', 'main.mjs', 'main.ts', 'main.tsx',
  'app.js', 'app.ts', 'app.tsx', 'app.vue', 'server.js', 'server.ts', 'cli.js', 'cli.mjs', 'cli.ts',
  'main.py', '__main__.py', 'app.py', 'main.go', 'main.rs', 'lib.rs', 'Program.cs', 'Startup.cs',
  'Main.java', 'Main.kt', 'Package.swift', 'SKILL.md',
])

function isSourceCodeFile(f) {
  if (!f.isText) return false
  if (CODE_RE.test(f.name)) return true
  if (DOC_OR_DATA_EXT_RE.test(f.name)) return false
  return /(?:^|\/)(?:src|lib|app|cmd|internal|pkg|server|client|backend|frontend)\//i.test(f.rel)
}

function collectPkgExportStrings(val, out = []) {
  if (typeof val === 'string') {
    if (!val.includes('*') && !/\/package\.json$/i.test(val)) out.push(val)
    return out
  }
  if (Array.isArray(val)) {
    for (const item of val) collectPkgExportStrings(item, out)
  } else if (val && typeof val === 'object') {
    for (const child of Object.values(val)) collectPkgExportStrings(child, out)
  }
  return out
}

function parsePyprojectScripts(text) {
  const scripts = []
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  for (const m of norm.matchAll(/^\[(project\.(?:gui-)?scripts|tool\.poetry\.scripts)\]\s*$/gm)) {
    const rest = norm.slice((m.index ?? 0) + m[0].length)
    const nextSec = /^\s*\[/m.exec(rest)
    const body = nextSec ? rest.slice(0, nextSec.index) : rest
    for (const line of body.split('\n')) {
      const clean = line.replace(/#.*$/, '').trim()
      const kv = clean && /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(clean)
      if (kv) scripts.push({ name: kv[1], target: kv[2] })
    }
  }
  return scripts
}

function resolvePythonModuleRel(targetExpr, dirRel, fileSet) {
  const modPart = String(targetExpr ?? '').split(':')[0].trim()
  if (!modPart) return null
  const slashPath = modPart.replace(/\./g, '/')
  const prefix = dirRel ? `${dirRel}/` : ''
  const cands = [
    `${prefix}${slashPath}.py`, `${prefix}src/${slashPath}.py`,
    `${prefix}${slashPath}/__init__.py`, `${prefix}src/${slashPath}/__init__.py`,
  ]
  return cands.find((cand) => fileSet.has(cand)) ?? null
}

const BUILD_OUT_PREFIX_RE = /^(?:dist|build|out|lib|esm|cjs)(?:\/(?:esm|cjs|mjs))?\//i

function isRegularFileRel(root, rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) return false
  try { return statSync(abs).isFile() } catch { return false }
}

/**
 * 解析 package.json 声明入口：磁盘存在则收入；若指向缺失的 `.js`/`.cjs`/`.mjs` 构建产物，
 * 尝试匹配同名或源码目录对应 `.ts`/`.tsx` 源码，仍缺失则跳过以避免产出僵尸入口。
 */
function resolvePkgEntryRel(root, dirRel, rawTarget) {
  const raw = posixPath(String(rawTarget ?? '').trim()).replace(/^\.\//, '')
  if (!raw || raw.includes('*') || raw.startsWith('#') || raw.endsWith('/')) return null
  const combined = posix.normalize(dirRel ? `${dirRel}/${raw}` : raw)
  if (!combined || combined === '.' || combined.startsWith('..') || combined.startsWith('/')) return null
  if (isRegularFileRel(root, combined)) return combined
  if (!/\.(?:js|cjs|mjs)$/i.test(combined)) return null

  const prefix = dirRel ? `${dirRel}/` : ''
  const relInPkg = prefix && combined.startsWith(prefix) ? combined.slice(prefix.length) : combined
  const stem = relInPkg.replace(/\.(?:js|cjs|mjs)$/i, '')
  const cands = [`${stem}.ts`, `${stem}.tsx`, `src/${stem}.ts`, `src/${stem}.tsx`]
  if (BUILD_OUT_PREFIX_RE.test(stem)) {
    const stripped = stem.replace(BUILD_OUT_PREFIX_RE, '')
    cands.push(`src/${stripped}.ts`, `src/${stripped}.tsx`, `${stripped}.ts`, `${stripped}.tsx`)
  }
  for (const cand of cands) {
    const fullRel = `${prefix}${cand}`
    if (isRegularFileRel(root, fullRel)) return fullRel
  }
  return null
}

function detectEntrypoints(root, files, packages) {
  const entries = new Set()
  const cliEntrypoints = []
  const fileSet = new Set(files.map((f) => f.rel))

  const addEntry = (rel) => {
    if (rel && !isNonFeatureArtifactPath(rel)) entries.add(rel)
  }

  for (const f of files) {
    if (isToolOwnedPath(f.rel) || isNonFeatureArtifactPath(f.rel)) continue
    const goCmd = /(?:^|\/)cmd\/([^/]+)\/main\.go$/i.exec(f.rel)
    if (goCmd) {
      addEntry(f.rel)
      cliEntrypoints.push({ ecosystem: 'go', name: goCmd[1], file: f.rel })
    }
  }

  const addPkgEntries = (dirRel) => {
    const pkg = readJsonSafe(dirRel ? join(root, dirRel, 'package.json') : join(root, 'package.json'))
    if (pkg) {
      for (const field of [pkg.main, pkg.module]) {
        if (typeof field === 'string') {
          const rel = resolvePkgEntryRel(root, dirRel, field)
          if (rel) addEntry(rel)
        }
      }
      for (const expTarget of collectPkgExportStrings(pkg.exports)) {
        const rel = resolvePkgEntryRel(root, dirRel, expTarget)
        if (rel) addEntry(rel)
      }
      if (typeof pkg.bin === 'string') {
        const rel = resolvePkgEntryRel(root, dirRel, pkg.bin)
        if (rel && !isNonFeatureArtifactPath(rel)) {
          addEntry(rel)
          cliEntrypoints.push({ ecosystem: 'node', name: String(pkg.name ?? basename(rel)), file: rel })
        }
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        for (const [cmdName, v] of Object.entries(pkg.bin)) {
          if (typeof v === 'string') {
            const rel = resolvePkgEntryRel(root, dirRel, v)
            if (rel && !isNonFeatureArtifactPath(rel)) {
              addEntry(rel)
              cliEntrypoints.push({ ecosystem: 'node', name: cmdName, file: rel })
            }
          }
        }
      }
    }
    const pyPath = dirRel ? join(root, dirRel, 'pyproject.toml') : join(root, 'pyproject.toml')
    const pyText = existsSync(pyPath) ? readTextSafe(pyPath) : undefined
    if (pyText) {
      for (const sc of parsePyprojectScripts(pyText)) {
        const modRel = resolvePythonModuleRel(sc.target, dirRel, fileSet)
        const manifestRel = dirRel ? `${dirRel}/pyproject.toml` : 'pyproject.toml'
        addEntry(modRel ?? manifestRel)
        cliEntrypoints.push({ ecosystem: 'python', name: sc.name, target: sc.target, file: modRel ?? manifestRel })
      }
    }
  }

  addPkgEntries('')
  for (const pkg of packages) {
    if (pkg.dirRel && (pkg.manifests.includes('package.json') || pkg.manifests.includes('pyproject.toml'))) {
      addPkgEntries(pkg.dirRel)
    }
  }
  for (const f of files) {
    if (isToolOwnedPath(f.rel) || isNonFeatureArtifactPath(f.rel)) continue
    if (ENTRY_NAMES.has(f.name)
      || /(?:Application|Main|Server|App)\.(?:java|kt|cs|swift|ts|tsx)$/i.test(f.name)
      || /^(?:bin|cmd|scripts)\/[^/]+\.(?:js|mjs|ts|py|go|sh)$/i.test(f.rel)) {
      addEntry(f.rel)
    }
  }
  return { entrypoints: [...entries].slice(0, 35), cliEntrypoints }
}

function detectDocsPresence(root, contextDocs) {
  const scanDir = (relDir) => {
    const abs = join(root, relDir)
    if (!existsSync(abs)) return []
    try { return readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => `${relDir}/${n}`) } catch { return [] }
  }
  return {
    agents: existsSync(join(root, 'AGENTS.md')),
    readme: existsSync(join(root, 'README.md')),
    tdd: existsSync(join(root, 'docs', 'TDD.md')),
    architecture: contextDocs.architecture,
    subAgents: contextDocs.subAgents,
    headlessDocs: contextDocs.headlessDocs,
    prd: scanDir('docs/prd'),
    specs: scanDir('docs/specs'),
    todo: scanDir('docs/todo'),
  }
}

/** 扫描潜在可复用共享模块与公开导出符号，排除工具托管的 `.agents/` 产物。 */
function extractReusableModules(files) {
  const candidates = files.filter((f) => {
    if (isToolOwnedPath(f.rel) || !isSourceCodeFile(f) || isTestOrFixtureFile(f.rel)) return false
    if (/^(?:dist|build|coverage|\.github)\//i.test(f.rel)) return false
    return /(?:^|\/)(?:lib|shared|utils?|helpers?|common|core|domain)\//i.test(f.rel)
      || /(?:shared|utils?|helpers?|common|protocol|template|render)\.[^/]+$/i.test(f.name)
  })
  const out = []
  for (const item of candidates.slice(0, 80)) {
    const text = readTextSafe(item.full, 256 * 1024)
    if (!text) continue
    const ext = item.name.includes('.') ? item.name.split('.').pop() : ''
    const { symbols } = extractSymbols(text, ext)
    const exportsList = symbols.slice(0, 12)
    if (exportsList.length > 0 || /(?:^|\/)(?:lib|common|core|shared)\//.test(item.rel)) {
      out.push({ file: item.rel, exports: exportsList, exportCount: symbols.length })
    }
  }
  return out.sort((a, b) => b.exportCount - a.exportCount || a.file.localeCompare(b.file)).slice(0, 20)
}

async function detectHotspots(root, focus) {
  const args = ['log', '-n', '60', '--name-only', '--pretty=format:']
  if (focus) args.push('--', focus)
  const res = await gitRun(root, args)
  if (!res.ok || !res.stdout) return []
  const counts = new Map()
  for (const line of res.stdout.split('\n')) {
    const p = posixPath(line.trim())
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([file, touches]) => ({ file, touches }))
}

export async function generateRepoMap(targetDir = process.cwd(), { focus, writeFeatureMap = false } = {}) {
  const roots = await resolveRepoRoots(targetDir)
  const root = roots.isGit ? roots.workTreeRoot : roots.cwd
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`目标目录不存在：${root}`)
  const focusRel = focus ? posixPath(focus).replace(/^\/+|\/+$/g, '') : undefined
  if (focusRel && !existsSync(join(root, focusRel))) throw new Error(`--focus 指定的子目录不存在：${focusRel}`)

  const fastHead = roots.isGit ? readHeadFast(roots.workTreeGitDir ?? resolveGitDirFast(root), roots.gitDir) : null
  const [branchRes, hotspots, scan] = await Promise.all([
    roots.isGit
      ? (fastHead ? Promise.resolve({ ok: Boolean(fastHead.branch), stdout: fastHead.branch ?? '' }) : gitRun(root, ['symbolic-ref', '--short', 'HEAD']))
      : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? detectHotspots(root, focusRel) : Promise.resolve([]),
    gitLsFilesTextAndCode(root, { isGit: roots.isGit, focus: focusRel }),
  ])

  const profile = parseAgentsProfile(root)
  const discovery = discoverWorkspacePackages(root, scan.files.map((f) => f.rel))
  const codeFiles = scan.files.filter(isSourceCodeFile)
  const testFiles = scan.files.filter((f) => f.isText && TEST_FILE_RE.test(f.rel)).map((f) => f.rel)
  const { entrypoints, cliEntrypoints } = detectEntrypoints(root, scan.files, discovery.packages)
  const contextDocs = discoverContextDocs(root)
  const docs = detectDocsPresence(root, contextDocs)
  const ciRunSteps = extractCiRunSteps(root, readdirSync)
  const taskRunners = extractTaskRunners(root, discovery.packages)
  const reusableModules = extractReusableModules(scan.files)
  const projectCodeFiles = scan.files.filter((f) => !isToolOwnedPath(f.rel) && isSourceCodeFile(f))
  const symbolCoverage = summarizeSymbolCoverage(projectCodeFiles.map((f) => f.name))
  let symbolCount = 0
  for (const item of projectCodeFiles.slice(0, 200)) {
    const text = readTextSafe(item.full, 256 * 1024)
    if (!text) continue
    const ext = item.name.includes('.') ? item.name.split('.').pop() : ''
    symbolCount += extractSymbols(text, ext).symbols.length
  }
  const featureMap = buildFeatureMap(root, entrypoints, testFiles, profile, taskRunners, discovery.packages)
  const businessFlows = buildBusinessFlows(root, scan.files, entrypoints, cliEntrypoints)
  const preferredVerifyCommands = buildPreferredVerifyCommands(profile, ciRunSteps, taskRunners, discovery.packages)
  const focusAgents = focusRel && existsSync(join(root, focusRel, 'AGENTS.md')) ? `${focusRel}/AGENTS.md` : null
  const focusFiles = focusRel
    ? scan.files.filter((f) => f.rel === focusRel || f.rel.startsWith(`${focusRel}/`)).map((f) => f.rel).slice(0, 80)
    : []

  const map = {
    root,
    name: basename(root),
    isGit: roots.isGit,
    scanSource: scan.source,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    focus: focusRel ?? null,
    focusAgents,
    focusFiles,
    truncated: scan.truncated,
    totalFiles: scan.files.length,
    textFileCount: scan.files.filter((f) => f.isText).length,
    codeFileCount: codeFiles.length,
    testFileCount: testFiles.length,
    topDirectories: [...scan.dirSummary.entries()].map(([dir, count]) => ({ dir, count })),
    packages: discovery.packages,
    workspaceGlobs: discovery.workspaceGlobs,
    entrypoints,
    cliEntrypoints,
    testFiles: testFiles.slice(0, 40),
    devProfile: {
      quickTest: profile.quickTest ?? null,
      fullTest: profile.fullTest ?? null,
      smokeVerify: profile.smokeVerify ?? null,
      mergeGate: profile.mergeGate ?? null,
      explicitNone: [...(profile.explicitNone ?? [])],
      archRules: profile.archRules,
      highRisk: profile.highRisk,
      doNotEdit: profile.doNotEdit,
      ecosystems: discovery.ecosystems,
    },
    ciRunSteps,
    taskRunners,
    preferredVerifyCommands,
    reusableModules,
    symbolCount,
    symbolCoverage,
    featureMap,
    businessFlows,
    docs,
    docIndex: contextDocs.contextIndex,
    docLocateHint: contextDocs.docLocateHints[0] ?? 'node .agents/skills/dev-explore/scripts/doc-locate.mjs --query "<关键词>"',
    docLocateHints: contextDocs.docLocateHints,
    hotspots,
  }
  const featureTopology = inferLayer1Topology(root, scan.files, featureMap, businessFlows.flows, discovery.packages)
  Object.defineProperty(map, 'featureTopology', {
    value: featureTopology,
    enumerable: false,
    configurable: true,
  })
  const fmSync = prefillFeatureMapFromRepoMap(root, map, { write: Boolean(writeFeatureMap), topology: featureTopology })
  const result = {
    ...map,
    featureMapPath: FEATURE_MAP_REL,
    featureMapExists: existsSync(join(root, FEATURE_MAP_REL)),
    featureMapWritten: fmSync.written,
  }
  Object.defineProperties(result, {
    featureMapIndex: {
      value: fmSync.featureMap,
      enumerable: false,
      configurable: true,
    },
    featureMapSync: {
      value: fmSync,
      enumerable: false,
      configurable: true,
    },
    featureTopology: {
      value: featureTopology,
      enumerable: false,
      configurable: true,
    },
  })
  return result
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [选项]',
    '',
    '选项：',
    '  --dir <path>           目标仓库根目录',
    '  --focus <subdir>       聚焦指定子目录',
    '  --task <id>            将探索证据写入对应任务账本',
    '  --tier <tier>          覆盖探索层级（direct-read | single-subagent | parallel-subagents）',
    '  --by <actor>           记录探索执行者标识',
    '  --topic <id>           可选：将探索命中的真实路径写入仓外 Working Brief 锚点（默认不写）',
    '  --write-feature-map    按探测结果增量预填 docs/feature-map.json',
    '  --json                 输出结构化 JSON',
    '  --help                 显示帮助',
    '',
    '无深度限制枚举全仓文本源码与多生态包清单（git ls-files -z + 4KB NUL 探测），',
    '输出入口、Dev Profile 命令、带 working-directory 的 CI 步骤、可复用模块、文档索引与 Feature Map。',
  ].join('\n') + '\n')
}

async function main(argv) {
  let cli
  try {
    cli = parseStandardCli(argv, {
      positionalDir: 'first',
      booleanFlags: ['write-feature-map'],
      valueFlags: ['focus', 'task', 'tier', 'by', 'topic'],
      usageHint: 'node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--task <id>] [--write-feature-map] [--json]',
    })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (cli.help) {
    printHelp()
    return 0
  }

  try {
    const map = await generateRepoMap(cli.targetDir, { focus: cli.opts.focus, writeFeatureMap: Boolean(cli.opts['write-feature-map']) })
    if (cli.opts.task) {
      const roots = await resolveRepoRoots(cli.targetDir)
      const { ledger } = await resolveTaskContext(roots, { task: cli.opts.task })
      const autoTier = cli.opts.tier ?? ((map.codeFileCount ?? 0) >= 25 ? 'parallel-subagents' : ((map.codeFileCount ?? 0) >= 6 ? 'single-subagent' : 'direct-read'))
      ledger.explored = createExploredEvidence({
        at: new Date().toISOString(),
        tier: autoTier,
        symbolCount: map.symbolCount ?? 0,
        by: cli.opts.by ?? 'repo-map',
        source: 'repo-map',
      })
      await updateTaskLedger(roots.mainRoot, ledger.taskId, (cur) => ({ ...(cur ?? ledger), explored: ledger.explored }), { createIfMissing: true })
    }
    if (cli.opts.topic) {
      const roots = await resolveRepoRoots(cli.targetDir)
      const candidates = [
        ...(map.focusFiles ?? []).slice(0, 6),
        ...(map.entrypoints ?? []).map((e) => (typeof e === 'string' ? e : e?.file ?? e?.path)).filter(Boolean),
        ...(map.cliEntrypoints ?? []).map((e) => (typeof e === 'string' ? e : e?.file ?? e?.path)).filter(Boolean),
        ...(map.hotspots ?? []).map((h) => (typeof h === 'string' ? h : h?.file ?? h?.path)).filter(Boolean),
      ].map((p) => posixPath(String(p)))
      const verifiedAnchors = [...new Set(candidates)].filter((p) => existsSync(join(map.root, p))).slice(0, 12)
      if (verifiedAnchors.length > 0) recordTopicAnchors(roots.mainRoot, { topic: cli.opts.topic, anchors: verifiedAnchors })
    }
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(map, null, 2)}\n`)
    } else {
      process.stdout.write(formatRepoMapText(map))
      printNextStep([
        { skill: 'dev-explore', text: map.docLocateHint },
        { skill: 'dev-flow', text: 'node ".agents/skills/dev-flow/scripts/flow.mjs" inspect' },
        { skill: 'dev-plan', text: 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<任务摘要>"' },
      ], { repoRoot: map.root })
    }
    return 0
  } catch (err) {
    process.stderr.write(`探索失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`探索失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
