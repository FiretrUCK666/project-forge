#!/usr/bin/env node
/**
 * repo-map.mjs —— 只读探索仓库结构、多生态包清单、CI 步骤、可复用模块、Feature Map 与 git 热点。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--dir <path>] [--focus <subdir>] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { discoverContextDocs } from '../../lib/doc-locator.mjs'
import {
  gitLsFilesTextAndCode, gitRun, isMainModule, posixPath, readJsonSafe, readTextSafe, resolveRepoRoots,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { createExploredEvidence, resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import { discoverWorkspacePackages, isProfileExplicitNone, parseAgentsProfile } from '../../lib/profile.mjs'
import { TEST_FILE_RE, isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { extractSymbols, summarizeSymbolCoverage } from '../../lib/symbol-index.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

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

function detectEntrypoints(root, files, packages) {
  const entries = new Set()
  const cliEntrypoints = []
  const fileSet = new Set(files.map((f) => f.rel))

  for (const f of files) {
    if (isToolOwnedPath(f.rel) || isTestOrFixtureFile(f.rel)) continue
    const goCmd = /(?:^|\/)cmd\/([^/]+)\/main\.go$/i.exec(f.rel)
    if (goCmd) {
      entries.add(f.rel)
      cliEntrypoints.push({ ecosystem: 'go', name: goCmd[1], file: f.rel })
    }
  }

  const addPkgEntries = (dirRel) => {
    const prefixRel = (raw) => {
      const clean = posixPath(raw).replace(/^\.\//, '')
      return dirRel ? `${dirRel}/${clean}` : clean
    }
    const pkg = readJsonSafe(dirRel ? join(root, dirRel, 'package.json') : join(root, 'package.json'))
    if (pkg) {
      for (const field of [pkg.main, pkg.module]) {
        if (typeof field === 'string') entries.add(prefixRel(field))
      }
      for (const expTarget of collectPkgExportStrings(pkg.exports)) entries.add(prefixRel(expTarget))
      if (typeof pkg.bin === 'string') {
        const rel = prefixRel(pkg.bin)
        entries.add(rel)
        cliEntrypoints.push({ ecosystem: 'node', name: String(pkg.name ?? basename(rel)), file: rel })
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        for (const [cmdName, v] of Object.entries(pkg.bin)) {
          if (typeof v === 'string') {
            const rel = prefixRel(v)
            entries.add(rel)
            cliEntrypoints.push({ ecosystem: 'node', name: cmdName, file: rel })
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
        entries.add(modRel ?? manifestRel)
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
    if (isToolOwnedPath(f.rel)) continue
    if (ENTRY_NAMES.has(f.name)
      || /(?:Application|Main|Server|App)\.(?:java|kt|cs|swift|ts|tsx)$/i.test(f.name)
      || /^(?:bin|cmd|scripts)\/[^/]+\.(?:js|mjs|ts|py|go|sh)$/i.test(f.rel)) {
      entries.add(f.rel)
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

/** 解析 .github/workflows/*.{yml,yaml} 中的 job、working-directory 与多行 run 脚本。 */
function extractCiRunSteps(root) {
  const wfDir = join(root, '.github', 'workflows')
  const steps = []
  if (existsSync(wfDir)) {
    let entries = []
    try { entries = readdirSync(wfDir).filter((n) => /\.(?:yml|yaml)$/i.test(n)).sort() } catch { entries = [] }
    for (const file of entries) {
      const rel = `.github/workflows/${file}`
      const text = readTextSafe(join(wfDir, file))
      if (!text) continue
      const wfName = /^name:\s*["']?([^"'\n]+)["']?/m.exec(text)?.[1]?.trim() ?? file
      const lines = text.split('\n')
      let currentJob = null; let jobWorkingDir = null; let inJobs = false; let inJobDefaultsRun = false
      let curStepName = null; let curStepWorkingDir = null; let stepBaseIndent = -1

      for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i]
        const trimmed = rawLine.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const indent = rawLine.length - rawLine.trimStart().length

        if (indent === 0 && /^jobs\s*:/.test(trimmed)) { inJobs = true; continue }
        if (indent === 0 && /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) { inJobs = false; inJobDefaultsRun = false }
        if (inJobs && indent === 2 && /^([A-Za-z0-9_-]+)\s*:/.test(trimmed)) {
          currentJob = /^([A-Za-z0-9_-]+)\s*:/.exec(trimmed)[1]
          jobWorkingDir = null; inJobDefaultsRun = false; curStepName = null; curStepWorkingDir = null; stepBaseIndent = -1
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
          stepBaseIndent = indent; curStepName = null; curStepWorkingDir = null
        } else if (stepBaseIndent >= 0 && indent < stepBaseIndent) {
          curStepName = null; curStepWorkingDir = null; stepBaseIndent = -1
        }
        const nameM = /^\s*(?:-\s+)?name\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (nameM) curStepName = nameM[1].trim()
        const stepWdM = /^\s*(?:-\s+)?working-directory\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (stepWdM) { curStepWorkingDir = stepWdM[1].trim(); continue }

        const runM = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(rawLine)
        if (!runM) continue
        const baseIndent = runM[1].length + (rawLine.includes('- run:') ? 2 : 0)
        const rhs = runM[2].trim()
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
          scriptText = blockLines.filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n').trim()
        } else if (rhs) {
          scriptText = rhs.replace(/\s+#.*$/, '').trim()
        }
        if (scriptText) {
          steps.push({
            workflow: wfName, job: currentJob, stepName: curStepName,
            workingDirectory: curStepWorkingDir ?? jobWorkingDir ?? null, file: rel, command: scriptText,
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
    for (const [k, v] of Object.entries(rootPkg.scripts)) runners.npmScripts.push({ name: k, command: String(v) })
  }
  for (const pkg of packages) {
    if (!pkg.dirRel) continue
    const nodeCmds = pkg.commands?.node
    if (nodeCmds?.scripts?.length) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: 'node', scripts: nodeCmds.scripts })
    for (const [eco, cmdObj] of Object.entries(pkg.commands)) {
      if (eco !== 'node' && cmdObj?.quickTest) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: eco, quickTest: cmdObj.quickTest })
    }
  }
  return runners
}

/** 扫描潜在可复用共享模块与公开导出符号，排除工具托管的 `.agents/` 产物。 */
function extractReusableModules(files) {
  const candidates = files.filter((f) => {
    if (isToolOwnedPath(f.rel) || !isSourceCodeFile(f) || isTestOrFixtureFile(f.rel)) return false
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
        const [c1, c2, c3] = [row[1], row[2], row[3]].map((s) => s.trim().replace(/`/g, ''))
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
    const matchedPkg = packages.filter((p) => p.dirRel && ep.startsWith(`${p.dirRel}/`)).sort((a, b) => b.dirRel.length - a.dirRel.length)[0]
    const pkgCmd = matchedPkg ? Object.values(matchedPkg.commands).find((c) => c?.quickTest)?.quickTest : null
    const verifyCmd = matchedTest
      ? (profile.quickTest?.includes('{target}') ? profile.quickTest.replace(/\{target\}/g, matchedTest) : `${matchedTest} (或 ${pkgCmd ?? profile.quickTest ?? '项目单测'})`)
      : (pkgCmd ?? profile.smokeVerify ?? profile.quickTest ?? (runners.npmScripts[0]?.name ? `npm run ${runners.npmScripts[0].name}` : null))
    const key = `${epBase}=>${ep}`
    if (!seen.has(key)) {
      seen.add(key)
      features.push({
        feature: epBase, source: ep,
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
    if (!cmd || list.some((x) => x.command === cmd && x.role === role && x.workingDirectory === workingDirectory)) return
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
  const targetRe = /^(?:test|check|smoke|lint|verify|build)$/i
  for (const mk of runners.makefile) if (targetRe.test(mk)) add('make-target', `make ${mk}`, 'Makefile')
  for (const jf of runners.justfile) if (targetRe.test(jf)) add('just-target', `just ${jf}`, 'justfile')
  for (const tf of runners.taskfile) if (targetRe.test(tf)) add('task-target', `task ${tf}`, 'Taskfile.yml')
  return list.slice(0, 25)
}

function buildBusinessFlows(root, files, entrypoints, cliEntrypoints) {
  const nonTool = files.filter((f) => !isToolOwnedPath(f.rel) && !isTestOrFixtureFile(f.rel))
  const fileSet = new Set(files.map((f) => f.rel))
  const routes = nonTool
    .filter((f) => /(?:^|\/)(?:routes?|routers?|controllers?|handlers?|endpoints?|pages\/api)\//i.test(f.rel)
      || /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(f.rel) || /\.proto$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const ui = nonTool
    .filter((f) => /\.(?:tsx|jsx|vue|svelte|astro)$/i.test(f.rel)
      || /(?:^|\/)(?:pages|screens|views|app)\/[^/]+\.(?:tsx|jsx|vue|svelte|html)$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const jobs = files
    .filter((f) => !isToolOwnedPath(f.rel)
      && (/(?:^|\/)(?:jobs?|workers?|queues?|cron|schedules?|pipelines?)\//i.test(f.rel)
        || /(?:^|\/)(?:\.github\/workflows\/.+\.ya?ml|Dockerfile(?:\.[^/]+)?|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml|Jenkinsfile|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml)$/i.test(f.rel)))
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

export async function generateRepoMap(targetDir = process.cwd(), { focus } = {}) {
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
  const ciRunSteps = extractCiRunSteps(root)
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
}

function formatText(map) {
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

async function main(argv) {
  let cli
  try {
    cli = parseStandardCli(argv, {
      positionalDir: 'first',
      booleanFlags: ['json', 'help'],
      valueFlags: ['focus', 'dir', 'repo', 'task', 'tier', 'by'],
      usageHint: 'node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--task <id>] [--json]',
    })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (cli.help) {
    process.stdout.write([
      '用法：node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--dir <path>] [--focus <subdir>] [--task <id>] [--json]',
      '',
      '无深度限制枚举全仓文本源码与多生态包清单（git ls-files -z + 4KB NUL 探测），',
      '输出入口、Dev Profile 命令、带 working-directory 的 CI 步骤、可复用模块、文档索引与 Feature Map。',
    ].join('\n') + '\n')
    return 0
  }

  try {
    const map = await generateRepoMap(cli.targetDir, { focus: cli.opts.focus })
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
      writeTaskLedger(roots.mainRoot, ledger)
    }
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(map, null, 2)}\n`)
    } else {
      process.stdout.write(formatText(map))
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
