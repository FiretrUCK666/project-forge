#!/usr/bin/env node
/**
 * repo-map.mjs —— 只读探索仓库结构、多生态包清单、CI 步骤、可复用模块、Feature Map 与 git 热点。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--dir <path>] [--focus <subdir>] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import {
  gitLsFilesTextAndCode, gitRun, isMainModule, posixPath, readJsonSafe, readTextSafe, resolveRepoRoots,
} from '../../lib/git.mjs'
import { discoverWorkspacePackages, isProfileExplicitNone, parseAgentsProfile } from '../../lib/profile.mjs'
import { TEST_FILE_RE } from '../../lib/static-gates.mjs'

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

function detectEntrypoints(root, files, packages) {
  const entries = new Set()
  const addPkgEntries = (dirRel) => {
    const pkgPath = dirRel ? join(root, dirRel, 'package.json') : join(root, 'package.json')
    const pkg = readJsonSafe(pkgPath)
    if (!pkg) return
    const prefixRel = (raw) => {
      const clean = posixPath(raw).replace(/^\.\//, '')
      return dirRel ? `${dirRel}/${clean}` : clean
    }
    for (const field of [pkg.main, pkg.module, pkg.exports]) {
      if (typeof field === 'string') entries.add(prefixRel(field))
    }
    if (typeof pkg.bin === 'string') entries.add(prefixRel(pkg.bin))
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === 'string') entries.add(prefixRel(v))
      }
    }
  }

  addPkgEntries('')
  for (const pkg of packages) {
    if (pkg.dirRel && pkg.manifests.includes('package.json')) addPkgEntries(pkg.dirRel)
  }

  for (const f of files) {
    if (ENTRY_NAMES.has(f.name)
      || /(?:Application|Main|Server|App)\.(?:java|kt|cs|swift|ts|tsx)$/i.test(f.name)
      || /^(?:bin|cmd|scripts)\/[^/]+\.(?:js|mjs|ts|py|go|sh)$/i.test(f.rel)) {
      entries.add(f.rel)
    }
  }
  return [...entries].slice(0, 35)
}

function detectDocsPresence(root) {
  const scanDir = (relDir) => {
    const abs = join(root, relDir)
    if (!existsSync(abs)) return []
    try {
      return readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => `${relDir}/${n}`)
    } catch { return [] }
  }
  return {
    agents: existsSync(join(root, 'AGENTS.md')),
    readme: existsSync(join(root, 'README.md')),
    tdd: existsSync(join(root, 'docs', 'TDD.md')),
    prd: scanDir('docs/prd'),
    specs: scanDir('docs/specs'),
    todo: scanDir('docs/todo'),
  }
}

/** 解析 .github/workflows/*.{yml,yaml} 中的 job、working-directory 与多行 run 脚本（保留控制流语义）。 */
function extractCiRunSteps(root) {
  const wfDir = join(root, '.github', 'workflows')
  const steps = []
  if (existsSync(wfDir)) {
    let entries = []
    try {
      entries = readdirSync(wfDir).filter((n) => /\.(?:yml|yaml)$/i.test(n)).sort()
    } catch { entries = [] }

    for (const file of entries) {
      const rel = `.github/workflows/${file}`
      const text = readTextSafe(join(wfDir, file))
      if (!text) continue
      const wfName = /^name:\s*["']?([^"'\n]+)["']?/m.exec(text)?.[1]?.trim() ?? file
      const lines = text.split('\n')

      let currentJob = null
      let jobWorkingDir = null
      let inJobs = false
      let inJobDefaultsRun = false
      let curStepName = null
      let curStepWorkingDir = null
      let stepBaseIndent = -1

      for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i]
        const trimmed = rawLine.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const indent = rawLine.length - rawLine.trimStart().length

        if (indent === 0 && /^jobs\s*:/.test(trimmed)) { inJobs = true; continue }
        if (indent === 0 && /^[A-Za-z0-9_-]+\s*:/.test(trimmed) && !/^jobs\s*:/.test(trimmed)) {
          inJobs = false; inJobDefaultsRun = false
        }
        if (inJobs && indent === 2 && /^([A-Za-z0-9_-]+)\s*:/.test(trimmed)) {
          currentJob = /^([A-Za-z0-9_-]+)\s*:/.exec(trimmed)[1]
          jobWorkingDir = null
          inJobDefaultsRun = false
          curStepName = null
          curStepWorkingDir = null
          stepBaseIndent = -1
          continue
        }
        if (inJobs && indent >= 4 && /^defaults\s*:/.test(trimmed)) { inJobDefaultsRun = false; continue }
        if (inJobs && indent >= 6 && /^run\s*:\s*$/.test(trimmed)) { inJobDefaultsRun = true; continue }
        if (inJobDefaultsRun) {
          const wdM = /^working-directory\s*:\s*["']?([^"'\n]+)["']?/.exec(trimmed)
          if (wdM) { jobWorkingDir = wdM[1].trim(); continue }
          if (indent <= 4) inJobDefaultsRun = false
        }

        if (/^\s*-\s+/.test(rawLine) && (stepBaseIndent === -1 || indent <= stepBaseIndent)) {
          stepBaseIndent = indent
          curStepName = null
          curStepWorkingDir = null
        } else if (stepBaseIndent >= 0 && indent < stepBaseIndent) {
          curStepName = null
          curStepWorkingDir = null
          stepBaseIndent = -1
        }

        const nameM = /^\s*(?:-\s+)?name\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (nameM) curStepName = nameM[1].trim()
        const stepWdM = /^\s*(?:-\s+)?working-directory\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (stepWdM) { curStepWorkingDir = stepWdM[1].trim(); continue }

        const runM = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(rawLine)
        if (!runM) continue
        const baseIndent = runM[1].length + (rawLine.includes('- run:') ? 2 : 0)
        const rhs = runM[2].trim()
        const effectiveWd = curStepWorkingDir ?? jobWorkingDir ?? null

        let scriptText = ''
        if (rhs === '|' || rhs === '|-' || rhs === '>' || rhs === '>-') {
          const blockLines = []
          let blockIndent = null
          for (let j = i + 1; j < lines.length; j += 1) {
            const cur = lines[j]
            if (cur.trim() === '') { blockLines.push(''); continue }
            const curIndent = /^(\s*)/.exec(cur)?.[1].length ?? 0
            if (curIndent <= baseIndent) break
            if (blockIndent === null) blockIndent = curIndent
            blockLines.push(cur.slice(Math.min(blockIndent, curIndent)))
            i = j
          }
          scriptText = blockLines
            .filter((l) => l.trim() && !l.trim().startsWith('#'))
            .join('\n')
            .trim()
        } else if (rhs) {
          scriptText = rhs.replace(/\s+#.*$/, '').trim()
        }

        if (scriptText) {
          steps.push({
            workflow: wfName,
            job: currentJob,
            stepName: curStepName,
            workingDirectory: effectiveWd,
            file: rel,
            command: scriptText,
          })
        }
      }
    }
  }

  for (const extraCi of ['.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml']) {
    if (existsSync(join(root, extraCi))) {
      steps.push({ workflow: basename(extraCi), job: null, stepName: 'ci-config', workingDirectory: null, file: extraCi, command: `(detected ${extraCi})` })
    }
  }
  return steps.slice(0, 50)
}

/** 提取根级与各子包 Makefile / justfile / Taskfile / package.json 中的可运行任务入口。 */
function extractTaskRunners(root, packages) {
  const runners = { makefile: [], justfile: [], taskfile: [], npmScripts: [], subpackages: [] }

  for (const mkName of ['Makefile', 'GNUmakefile', 'makefile']) {
    const mkText = readTextSafe(join(root, mkName))
    if (!mkText) continue
    for (const m of mkText.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)) {
      if (!m[1].startsWith('.') && !runners.makefile.includes(m[1])) runners.makefile.push(m[1])
    }
    break
  }

  for (const jfName of ['justfile', 'Justfile', '.justfile']) {
    const jfText = readTextSafe(join(root, jfName))
    if (!jfText) continue
    for (const m of jfText.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s+[^:\n]*)?:(?!=)/gm)) {
      if (!runners.justfile.includes(m[1])) runners.justfile.push(m[1])
    }
    break
  }

  for (const tfName of ['Taskfile.yml', 'Taskfile.yaml']) {
    const tfText = readTextSafe(join(root, tfName))
    if (!tfText) continue
    const tasksSec = /\ntasks:\s*\n([\s\S]*?)(?:\n[a-z]+:|\s*$)/.exec(`\n${tfText}`)
    if (tasksSec) {
      for (const m of tasksSec[1].matchAll(/^ {2}([A-Za-z0-9_.-]+)\s*:/gm)) {
        if (!runners.taskfile.includes(m[1])) runners.taskfile.push(m[1])
      }
    }
    break
  }

  const rootPkg = readJsonSafe(join(root, 'package.json'))
  if (rootPkg?.scripts && typeof rootPkg.scripts === 'object') {
    for (const [k, v] of Object.entries(rootPkg.scripts)) {
      runners.npmScripts.push({ name: k, command: String(v) })
    }
  }

  for (const pkg of packages) {
    if (!pkg.dirRel) continue
    const nodeCmds = pkg.commands?.node
    if (nodeCmds?.scripts?.length) {
      runners.subpackages.push({ dir: pkg.dirRel, ecosystem: 'node', scripts: nodeCmds.scripts })
    }
    for (const [eco, cmdObj] of Object.entries(pkg.commands)) {
      if (eco === 'node') continue
      if (cmdObj?.quickTest) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: eco, quickTest: cmdObj.quickTest })
    }
  }
  return runners
}

/** 扫描潜在可复用共享模块与公开导出符号，抑制重复造轮子。 */
function extractReusableModules(files) {
  const candidates = files.filter((f) => {
    if (!isSourceCodeFile(f) || TEST_FILE_RE.test(f.rel)) return false
    return /(?:^|\/)(?:lib|shared|utils?|helpers?|common|core|domain)\//i.test(f.rel)
      || /(?:shared|utils?|helpers?|common|protocol|template|render)\.[^/]+$/i.test(f.name)
  })

  const out = []
  for (const item of candidates.slice(0, 80)) {
    const text = readTextSafe(item.full, 256 * 1024)
    if (!text) continue
    const exportsList = []
    const re = /^(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)|pub\s+(?:fn|struct|enum|trait)|func\s+[A-Z]|def\s+[A-Za-z]|public\s+(?:static\s+|final\s+|abstract\s+)?(?:class|interface|record|enum|fun))\s+([A-Za-z_][A-Za-z0-9_]*)/gm
    for (const m of text.matchAll(re)) {
      if (!m[1].startsWith('_') && !exportsList.includes(m[1])) exportsList.push(m[1])
    }
    if (exportsList.length > 0 || /(?:^|\/)(?:lib|common|core|shared)\//.test(item.rel)) {
      out.push({ file: item.rel, exports: exportsList.slice(0, 12), exportCount: exportsList.length })
    }
  }
  return out.sort((a, b) => b.exportCount - a.exportCount || a.file.localeCompare(b.file)).slice(0, 20)
}

function buildFeatureMap(root, entrypoints, testFiles, profile, runners, packages) {
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
        const c1 = row[1].trim().replace(/`/g, '')
        const c2 = row[2].trim().replace(/`/g, '')
        const c3 = row[3].trim().replace(/`/g, '')
        if (!c1 || /^[-:]+$/.test(c1) || /功能|模块|Feature|Entry/i.test(c1) || /^<.*>$/.test(c1)) continue
        const key = `${c1}=>${c2}`
        if (!seen.has(key)) {
          seen.add(key)
          features.push({ feature: c1, source: c2, verifyCmd: c3 || profile.smokeVerify || profile.quickTest || '待补充', origin: 'docs/TDD.md' })
        }
      }
    }
  }

  for (const ep of entrypoints.slice(0, 18)) {
    const epBase = basename(ep).replace(/\.[^.]+$/, '')
    const matchedTest = testFiles.find((t) => t.toLowerCase().includes(epBase.toLowerCase()))
    const matchedPkg = packages
      .filter((p) => p.dirRel && ep.startsWith(`${p.dirRel}/`))
      .sort((a, b) => b.dirRel.length - a.dirRel.length)[0]
    const pkgCmd = matchedPkg ? Object.values(matchedPkg.commands).find((c) => c?.quickTest)?.quickTest : null
    const verifyCmd = matchedTest
      ? (profile.quickTest?.includes('{target}') ? profile.quickTest.replace(/\{target\}/g, matchedTest) : `${matchedTest} (或 ${pkgCmd ?? profile.quickTest ?? '项目单测'})`)
      : (pkgCmd ?? profile.smokeVerify ?? profile.quickTest ?? (runners.npmScripts[0]?.name ? `npm run ${runners.npmScripts[0].name}` : null))
    const key = `${epBase}=>${ep}`
    if (!seen.has(key)) {
      seen.add(key)
      features.push({
        feature: epBase,
        source: ep,
        verifyCmd: verifyCmd ?? (isProfileExplicitNone(profile, 'quick-test') ? 'none (explicit)' : '未配置（建议补充 smoke-verify）'),
        origin: 'detected-entry',
      })
    }
  }

  return features.slice(0, 25)
}

function buildPreferredVerifyCommands(profile, ciRunSteps, runners, packages) {
  const list = []
  const add = (role, cmd, source, workingDirectory = null) => {
    if (!cmd) return
    if (list.some((x) => x.command === cmd && x.role === role && x.workingDirectory === workingDirectory)) return
    list.push({ role, command: cmd, source, ...(workingDirectory ? { workingDirectory } : {}) })
  }
  add('quick-test', profile.quickTest, profile.hasAgents ? 'AGENTS.md/auto' : 'auto')
  add('smoke-verify', profile.smokeVerify, 'AGENTS.md')
  add('full-test', profile.fullTest, 'AGENTS.md/auto')
  add('merge-gate', profile.mergeGate, 'AGENTS.md/auto')
  for (const step of ciRunSteps) {
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
  for (const mk of runners.makefile) {
    if (/^(?:test|check|smoke|lint|verify|build)$/i.test(mk)) add('make-target', `make ${mk}`, 'Makefile')
  }
  for (const jf of runners.justfile) {
    if (/^(?:test|check|smoke|lint|verify|build)$/i.test(jf)) add('just-target', `just ${jf}`, 'justfile')
  }
  for (const tf of runners.taskfile) {
    if (/^(?:test|check|smoke|lint|verify|build)$/i.test(tf)) add('task-target', `task ${tf}`, 'Taskfile.yml')
  }
  return list.slice(0, 25)
}

async function detectHotspots(root, focus) {
  const args = ['log', '-n', '60', '--name-only', '--pretty=format:']
  if (focus) args.push('--', focus)
  const res = await gitRun(root, args)
  if (!res.ok || !res.stdout) return []
  const counts = new Map()
  for (const line of res.stdout.split('\n')) {
    const p = posixPath(line.trim())
    if (!p) continue
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, touches]) => ({ file, touches }))
}

export async function generateRepoMap(targetDir = process.cwd(), { focus } = {}) {
  const roots = await resolveRepoRoots(targetDir)
  const root = roots.isGit ? roots.workTreeRoot : roots.cwd
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`目标目录不存在：${root}`)
  }
  const focusRel = focus ? posixPath(focus).replace(/^\/+|\/+$/g, '') : undefined
  if (focusRel && !existsSync(join(root, focusRel))) {
    throw new Error(`--focus 指定的子目录不存在：${focusRel}`)
  }

  const [branchRes, hotspots, scan] = await Promise.all([
    roots.isGit ? gitRun(root, ['symbolic-ref', '--short', 'HEAD']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? detectHotspots(root, focusRel) : Promise.resolve([]),
    gitLsFilesTextAndCode(root, { isGit: roots.isGit, focus: focusRel }),
  ])

  const profile = parseAgentsProfile(root)
  const discovery = discoverWorkspacePackages(root, scan.files.map((f) => f.rel))
  const codeFiles = scan.files.filter(isSourceCodeFile)
  const testFiles = scan.files.filter((f) => f.isText && TEST_FILE_RE.test(f.rel)).map((f) => f.rel)
  const entrypoints = detectEntrypoints(root, scan.files, discovery.packages)
  const docs = detectDocsPresence(root)
  const ciRunSteps = extractCiRunSteps(root)
  const taskRunners = extractTaskRunners(root, discovery.packages)
  const reusableModules = extractReusableModules(scan.files)
  const featureMap = buildFeatureMap(root, entrypoints, testFiles, profile, taskRunners, discovery.packages)
  const preferredVerifyCommands = buildPreferredVerifyCommands(profile, ciRunSteps, taskRunners, discovery.packages)

  const focusAgents = focusRel && existsSync(join(root, focusRel, 'AGENTS.md')) ? `${focusRel}/AGENTS.md` : null
  const focusFiles = focusRel
    ? scan.files.filter((f) => f.rel === focusRel || f.rel.startsWith(`${focusRel}/`)).map((f) => f.rel).slice(0, 80)
    : []

  return {
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
    featureMap,
    docs,
    hotspots,
  }
}

function formatText(map) {
  const lines = []
  lines.push(`# 仓库地图：${map.name}`)
  lines.push(`- 路径: ${map.root}（枚举器: ${map.scanSource}）`)
  lines.push(`- Git: ${map.isGit ? `是（分支: ${map.branch ?? 'detached/unborn'}）` : '否'} | 生态: ${map.devProfile.ecosystems.join(', ') || '未识别'}`)
  lines.push(`- 文件统计: 共 ${map.totalFiles}${map.truncated ? '+' : ''} 个（文本 ${map.textFileCount}，源码 ${map.codeFileCount}，测试 ${map.testFileCount}）`)
  if (map.packages.length > 0) {
    lines.push('')
    lines.push('## 多生态包清单（Manifest-First）')
    for (const p of map.packages) {
      lines.push(`- [${p.dirRel || '.'}] (${p.ecosystems.join(', ') || 'generic'}) manifests=${p.manifests.join(', ')}`)
    }
  }
  lines.push('')
  lines.push('## Dev Profile 与优先验证入口')
  const fmtCmd = (val, key) => val ?? (map.devProfile.explicitNone.includes(key) ? 'none (显式关闭)' : '未配置')
  lines.push(`- quick-test: ${fmtCmd(map.devProfile.quickTest, 'quick-test')}`)
  lines.push(`- smoke-verify: ${fmtCmd(map.devProfile.smokeVerify, 'smoke-verify')}`)
  lines.push(`- full-test: ${fmtCmd(map.devProfile.fullTest, 'full-test')}`)
  lines.push(`- merge-gate: ${fmtCmd(map.devProfile.mergeGate, 'merge-gate')}`)
  lines.push(`- high-risk: ${map.devProfile.highRisk.join(', ') || '无'}`)
  if (map.ciRunSteps.length > 0) {
    lines.push('')
    lines.push('## CI 工作流验证步骤')
    for (const s of map.ciRunSteps.slice(0, 12)) {
      const wd = s.workingDirectory ? ` (cwd=${s.workingDirectory})` : ''
      lines.push(`- [${s.file}]${wd} ${s.command.replace(/\n/g, ' ; ')}`)
    }
  }
  lines.push('')
  lines.push('## 顶层目录分布')
  for (const d of map.topDirectories) lines.push(`- ${d.dir}: ${d.count} 个文件`)
  if (map.reusableModules.length > 0) {
    lines.push('')
    lines.push('## 可复用现成模块清单')
    for (const m of map.reusableModules) {
      lines.push(`- ${m.file}${m.exports.length > 0 ? ` [导出: ${m.exports.join(', ')}]` : ''}`)
    }
  }
  if (map.featureMap.length > 0) {
    lines.push('')
    lines.push('## Feature Map（入口 -> 源码 -> 验证）')
    for (const fm of map.featureMap) lines.push(`- ${fm.feature}: ${fm.source} -> ${fm.verifyCmd}`)
  }
  if (map.testFiles.length > 0) {
    lines.push('')
    lines.push('## 测试文件（前 40 项）')
    for (const t of map.testFiles) lines.push(`- ${t}`)
  }
  lines.push('')
  lines.push('## 工程文档现状')
  lines.push(`- AGENTS.md: ${map.docs.agents ? '有' : '无'} | docs/TDD.md: ${map.docs.tdd ? '有' : '无'} | prd: ${map.docs.prd.length} | specs: ${map.docs.specs.length} | todo: ${map.docs.todo.length}`)
  if (map.hotspots.length > 0) {
    lines.push('')
    lines.push('## 近期修改热点（git log 前 10）')
    for (const h of map.hotspots) lines.push(`- ${h.file} (${h.touches} 次)`)
  }
  return `${lines.join('\n')}\n`
}

async function main(argv) {
  let cli
  try {
    cli = parseStandardCli(argv, {
      positionalDir: 'first',
      booleanFlags: ['json', 'help'],
      valueFlags: ['focus', 'dir', 'repo'],
      usageHint: 'node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--json]',
    })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (cli.help) {
    process.stdout.write([
      '用法：node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--dir <path>] [--focus <subdir>] [--json]',
      '',
      '无深度限制枚举全仓文本源码与多生态包清单（git ls-files -z + 4KB NUL 探测），',
      '输出入口、Dev Profile 命令、带 working-directory 的 CI 步骤、可复用模块与 Feature Map。',
    ].join('\n') + '\n')
    return 0
  }

  try {
    const map = await generateRepoMap(cli.targetDir, { focus: cli.opts.focus })
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(map, null, 2)}\n`)
    } else {
      process.stdout.write(formatText(map))
      printNextStep([
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

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
