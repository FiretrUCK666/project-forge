/**
 * profile-sniffer.mjs —— 唯一单源三层命令嗅探与全深度非 vendor 子包探测器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零平台禁词（使用中性 CI 配置清单）：
 *   Layer 1: AGENTS.md `## Dev Profile`
 *   Layer 2: 中性 CI 配置（2/4 空格 YAML、Jenkinsfile）+ Taskfile / Makefile / justfile
 *   Layer 3: 全深度递归包清单探测（跳过 COMMON_SKIP_DIRS 与 vendor/examples 等参考目录，Windows 安全）
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe } from './git.mjs'
import {
  ECOSYSTEM_MANIFEST_BY_KIND,
  ECOSYSTEM_MANIFEST_TABLE,
  VENDOR_OR_EXAMPLE_SKIP_DIRS,
  WORKSPACE_MANIFEST_NAMES,
  detectNonNodePackageCommands,
  groupPackageManifests,
  hasDotnetMinVer,
  hasPytestEvidence,
  isDotnetTestProject,
  isWorkspaceManifestFile,
  parseYamlWorkspaceGlobs,
  readDenoOrJsrManifest,
  readJsoncSafe,
  resolveJavaWrapper,
  resolveNodePackageManager,
  stripInlineYamlComment,
  stripWrapQuotes,
} from './profile-sniffer-packages.mjs'

export {
  ECOSYSTEM_MANIFEST_BY_KIND,
  ECOSYSTEM_MANIFEST_TABLE,
  VENDOR_OR_EXAMPLE_SKIP_DIRS,
  WORKSPACE_MANIFEST_NAMES,
  hasDotnetMinVer,
  hasPytestEvidence,
  isDotnetTestProject,
  isWorkspaceManifestFile,
  parseYamlWorkspaceGlobs,
  readDenoOrJsrManifest,
  readJsoncSafe,
  resolveJavaWrapper,
  resolveNodePackageManager,
  stripInlineYamlComment,
  stripWrapQuotes,
}

export const NEUTRAL_CI_CONFIGS = Object.freeze([
  '.circleci/config.yml', '.circleci/config.yaml',
  'azure-pipelines.yml', 'azure-pipelines.yaml',
  'Jenkinsfile', '.travis.yml', '.drone.yml',
  '.buildkite/pipeline.yml', '.buildkite/pipeline.yaml',
  '.woodpecker.yml',
])

const CI_COMMAND_KINDS = [
  { key: 'test', re: /\b(?:test|tests|runtest|spec|specs|check|verify|validate|preflight|pytest|unittest|vitest|jest|mocha|rspec|ctest|phpunit)\b/i },
  { key: 'lint', re: /\b(?:lint|clippy|rubocop|eslint|oxlint|flake8|pylint|ruff|mypy|pyright|biome|format|fmt|oxfmt|dprint|hlint|vet)\b/i },
  { key: 'build', re: /\b(?:build|compile|bundle|package|make|assemble)\b/i },
  { key: 'install', re: /\b(?:install|deps|dependencies|setup|bootstrap|restore)\b/i },
]

const TASKFILE_ALIASES = {
  test: ['test', 'tests', 'check', 'verify', 'spec', 'specs', 'runtest', 'unittest'],
  lint: ['lint', 'vet', 'fmt-check', 'format-check', 'style'],
  build: ['build', 'all', 'compile', 'dist'],
  install: ['install', 'deps', 'dependencies', 'setup', 'bootstrap'],
}

/** 兼容 2 空格 / 4 空格 / 混合缩进 YAML 的 `run:` / `script:` / `commands:` / `command:` 提取器（支持 CircleCI mapping 步）。 */
export function extractYamlRunBlocks(relFile, text) {
  const steps = []
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const stepMappingKeyRe = /^(?:name|command|shell|working[-_]directory|environment|env|when|no_output_timeout|background|if|id|continue-on-error)\s*:/i
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?(?:run|script|commands|command)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const listPrefix = /^(\s*-\s+)(?:run|script|commands|command)\s*:/.exec(lines[i])
    const baseIndent = listPrefix ? listPrefix[1].length : m[1].length
    const tail = m[2].trim()
    const startLine = i + 1

    if (!tail || /^[|>][+-]?$/.test(tail)) {
      const blockLines = []
      let blockIndent = null
      let isYamlStepObject = false
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j]
        if (!raw.trim()) { blockLines.push(''); continue }
        const curIndent = /^(\s*)/.exec(raw)[1].length
        if (curIndent <= baseIndent) break
        if (!tail && stepMappingKeyRe.test(raw.trim())) { isYamlStepObject = true; break }
        if (!tail && /^\s*-\s+/.test(raw)) {
          const itemCmd = raw.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim()
          if (itemCmd && !/^(?:true|false|null)$/i.test(itemCmd)) {
            steps.push({ file: relFile, line: j + 1, cmd: stripWrapQuotes(itemCmd) })
          }
          i = j
          continue
        }
        if (blockIndent === null) blockIndent = curIndent
        else if (curIndent < blockIndent) break
        blockLines.push(raw.slice(Math.min(blockIndent, raw.length)))
        i = j
      }
      if (!isYamlStepObject) {
        const cleanLines = blockLines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        for (const [offset, clean] of cleanLines.entries()) {
          steps.push({ file: relFile, line: startLine + offset + 1, cmd: clean })
        }
      }
    } else {
      const clean = stripWrapQuotes(tail.replace(/\s+#.*$/, '').trim())
      if (clean && !/^(?:true|false|null)$/i.test(clean)) steps.push({ file: relFile, line: startLine, cmd: clean })
    }
  }
  return steps
}

/** 扫描仓库中所有中立 CI 配置（支持 2/4 空格 YAML 与 Jenkinsfile）。 */
export function scanNeutralCiSteps(repoRoot) {
  const steps = []
  const ciConfigFiles = []

  const wfDir = join(repoRoot, '.github', 'workflows')
  if (existsSync(wfDir)) {
    try {
      for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/i.test(n) && !isMacOsJunkPath(n)).sort()) {
        const rel = `.github/workflows/${name}`
        ciConfigFiles.push(rel)
        const text = readTextSafe(join(wfDir, name))
        if (text) steps.push(...extractYamlRunBlocks(rel, text))
      }
    } catch { /* ignore */ }
  }

  for (const rel of NEUTRAL_CI_CONFIGS) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    ciConfigFiles.push(rel)
    const text = readTextSafe(abs)
    if (!text) continue
    if (rel === 'Jenkinsfile') {
      text.split('\n').forEach((ln, idx) => {
        for (const m of ln.matchAll(/\bsh\s+['"]([^'"]+)['"]/g)) {
          if (m[1]?.trim()) steps.push({ file: rel, line: idx + 1, cmd: m[1].trim() })
        }
      })
    } else {
      steps.push(...extractYamlRunBlocks(rel, text))
    }
  }

  const wpDir = join(repoRoot, '.woodpecker')
  if (existsSync(wpDir)) {
    try {
      for (const name of readdirSync(wpDir).filter((n) => /\.ya?ml$/i.test(n) && !isMacOsJunkPath(n)).sort()) {
        const rel = `.woodpecker/${name}`
        ciConfigFiles.push(rel)
        const text = readTextSafe(join(wpDir, name))
        if (text) steps.push(...extractYamlRunBlocks(rel, text))
      }
    } catch { /* ignore */ }
  }

  return { steps, ciConfigFiles: [...new Set(ciConfigFiles)].sort() }
}

/** 提取根级 Makefile / justfile / Taskfile 任务入口（带行号证据）。 */
export function scanDeclaredTaskRunners(repoRoot) {
  const commands = {}
  const sources = {}
  const evidence = []
  const makeTargets = new Set()
  const justRecipes = new Set()
  const taskNames = new Set()
  const runners = []

  const findLine = (lines, re) => {
    const idx = lines.findIndex((l) => re.test(l))
    return idx >= 0 ? idx + 1 : 1
  }

  const makefile = ['Makefile', 'GNUmakefile', 'makefile'].find((n) => existsSync(join(repoRoot, n)))
  if (makefile) {
    const text = readTextSafe(join(repoRoot, makefile)) ?? ''
    for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) {
      if (!m[1].startsWith('.')) makeTargets.add(m[1])
    }
    runners.push({ runner: 'make', file: makefile, names: makeTargets, lines: text.split('\n') })
  }
  const justfile = ['justfile', 'Justfile', '.justfile'].find((n) => existsSync(join(repoRoot, n)))
  if (justfile) {
    const text = readTextSafe(join(repoRoot, justfile)) ?? ''
    for (const m of text.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s+[^:\n]*)?:(?!=)/gm)) justRecipes.add(m[1])
    runners.push({ runner: 'just', file: justfile, names: justRecipes, lines: text.split('\n') })
  }
  const taskfile = ['Taskfile.yml', 'Taskfile.yaml'].find((n) => existsSync(join(repoRoot, n)))
  if (taskfile) {
    const text = readTextSafe(join(repoRoot, taskfile)) ?? ''
    const tasksSec = /\ntasks:\s*\n([\s\S]*?)(?:\n[a-z]+:|\s*$)/.exec(`\n${text}`)
    if (tasksSec) {
      for (const m of tasksSec[1].matchAll(/^ {2,4}([A-Za-z0-9_.-]+)\s*:/gm)) taskNames.add(m[1])
    }
    runners.push({ runner: 'task', file: taskfile, names: taskNames, lines: text.split('\n') })
  }

  for (const { runner, file, names, lines } of runners) {
    for (const [kind, aliases] of Object.entries(TASKFILE_ALIASES)) {
      if (commands[kind] !== undefined) continue
      const hit = aliases.find((alias) => names.has(alias))
      if (!hit) continue
      const cmd = `${runner} ${hit}`
      commands[kind] = cmd
      sources[kind] = file
      const lineNo = findLine(lines, new RegExp(`^\\s*@?${hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`))
      evidence.push({ layer: 'ci-or-taskfile', kind, file, line: lineNo, command: cmd })
    }
  }

  return { commands, sources, evidence, makeTargets, justRecipes, taskNames }
}

function detectNodePackageCommands(repoRoot, dirRel, rootPm) {
  const absDir = dirRel ? join(repoRoot, dirRel) : repoRoot
  const pkg = readJsonSafe(join(absDir, 'package.json'))
  if (!pkg) return null
  const pm = existsSync(join(absDir, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(absDir, 'yarn.lock')) ? 'yarn'
      : existsSync(join(absDir, 'bun.lock')) || existsSync(join(absDir, 'bun.lockb')) ? 'bun'
        : existsSync(join(absDir, 'package-lock.json')) ? 'npm' : (rootPm ?? 'npm')
  const prefixArg = dirRel
    ? (pm === 'npm' ? ` --prefix ${dirRel}` : pm === 'pnpm' ? ` --dir ${dirRel}` : ` --cwd ${dirRel}`)
    : ''
  const wrapDir = (subCmd) => `${pm}${prefixArg} ${subCmd}`
  const scripts = pkg.scripts ?? {}
  let quickTest
  let fullTest
  let lint
  let build
  if (scripts.test && !/no test specified/i.test(String(scripts.test))) quickTest = wrapDir('test')
  if (scripts.check) fullTest = wrapDir(pm === 'npm' ? 'run check' : 'check')
  else if (scripts.verify) fullTest = wrapDir(pm === 'npm' ? 'run verify' : 'verify')
  else if (scripts.ci) fullTest = wrapDir(pm === 'npm' ? 'run ci' : 'ci')
  if (scripts.lint) lint = wrapDir(pm === 'npm' ? 'run lint' : 'lint')
  if (scripts.build) build = wrapDir(pm === 'npm' ? 'run build' : 'build')
  return { name: pkg.name ?? (dirRel || 'root'), scripts: Object.keys(scripts), pm, quickTest, fullTest, lint, build }
}

/** 动态发现全仓库多语言包清单与任务入口（全深度、跳过 vendor/examples 等参考目录，Windows 安全无 subshell cd）。 */
export function discoverWorkspacePackages(repoRoot, fileRelList = null) {
  const byDir = groupPackageManifests(repoRoot, fileRelList)
  const rootPm = resolveNodePackageManager(repoRoot)
  const packages = []
  const allEcosystems = new Set()

  for (const bucket of [...byDir.values()].sort((a, b) => a.dirRel.localeCompare(b.dirRel))) {
    for (const eco of bucket.ecosystems) allEcosystems.add(eco)
    if (bucket.ecosystems.has('node')) {
      const nodeInfo = detectNodePackageCommands(repoRoot, bucket.dirRel, rootPm)
      if (nodeInfo) { bucket.name = nodeInfo.name; bucket.commands.node = nodeInfo }
    }
    detectNonNodePackageCommands(repoRoot, bucket)
    packages.push({
      dirRel: bucket.dirRel,
      name: bucket.name ?? (bucket.dirRel || basename(repoRoot)),
      ecosystems: [...bucket.ecosystems].sort(),
      manifests: bucket.manifests.sort(),
      lockfiles: [...new Set(bucket.lockfiles)].sort(),
      commands: bucket.commands,
    })
  }

  return {
    packages,
    ecosystems: [...allEcosystems].sort(),
    workspaceGlobs: parseYamlWorkspaceGlobs(repoRoot),
  }
}

function classifyCiCommand(cmd) {
  for (const kind of CI_COMMAND_KINDS) {
    if (kind.re.test(cmd)) return kind.key
  }
  return undefined
}

const HEAVY_E2E_SEG_RE = /(?:^|\/)(?:e2e|webtest|web-tests?|browser-tests?|playwright|cypress|selenium)(?:\/|$)/i
const HEAVY_E2E_CMD_RE = /\b(?:playwright|cypress|selenium|puppeteer|wdio|testcafe)\b|:e2e\b/i

function isHeavyE2ePackage(pkg, cmdObj) {
  const dirRel = String(pkg?.dirRel ?? '')
  const pkgName = String(pkg?.name ?? '')
  if (HEAVY_E2E_SEG_RE.test(dirRel) || /(?:^|[-_/])(?:e2e|webtest)$/i.test(pkgName)) return true
  const cmds = [cmdObj?.quickTest, cmdObj?.fullTest].filter(Boolean)
  return cmds.some((c) => HEAVY_E2E_CMD_RE.test(String(c)))
}

function normalizeCmdKey(cmd) {
  return String(cmd ?? '').trim().replace(/\s+/g, ' ')
}

/** 统一三层优先级命令嗅探：Dev Profile / 中立 CI + Taskfile / 递归子包清单。 */
export function sniffLayeredCommands(repoRoot, { profile = null, fileRelList = null } = {}) {
  const detectionEvidence = []
  const ci = scanNeutralCiSteps(repoRoot)
  const taskRunners = scanDeclaredTaskRunners(repoRoot)
  const discovery = discoverWorkspacePackages(repoRoot, fileRelList)
  const ciCommands = {}
  const ciSources = {}
  const ciCommandsByKind = { test: [], lint: [], build: [], install: [] }
  const ciVerifyCommands = []
  const seenVerify = new Set()
  const ciE2eCommands = []

  for (const step of ci.steps) {
    const normCmd = normalizeCmdKey(step.cmd)
    if (!normCmd) continue
    if (HEAVY_E2E_CMD_RE.test(normCmd)) { if (!ciE2eCommands.includes(normCmd)) ciE2eCommands.push(normCmd); continue }
    const kind = classifyCiCommand(normCmd)
    if (!kind) continue
    if (!ciCommandsByKind[kind].includes(normCmd)) {
      ciCommandsByKind[kind].push(normCmd)
      detectionEvidence.push({ layer: 'ci-or-taskfile', kind, file: step.file, line: step.line, command: normCmd })
    }
    if (ciSources[kind] === undefined) ciSources[kind] = step.file
    if (kind !== 'install' && !seenVerify.has(normCmd)) { seenVerify.add(normCmd); ciVerifyCommands.push(normCmd) }
  }
  for (const [kind, cmds] of Object.entries(ciCommandsByKind)) {
    if (cmds.length > 0) ciCommands[kind] = kind === 'test' && cmds.length > 1 ? cmds.join(' && ') : cmds[0]
  }
  for (const ev of taskRunners.evidence) {
    if (ciCommands[ev.kind] === undefined) {
      ciCommands[ev.kind] = ev.command
      ciSources[ev.kind] = ev.file
      if (!ciCommandsByKind[ev.kind].includes(ev.command)) ciCommandsByKind[ev.kind].push(ev.command)
      if (ev.kind !== 'install' && !seenVerify.has(ev.command)) { seenVerify.add(ev.command); ciVerifyCommands.push(ev.command) }
      detectionEvidence.push(ev)
    }
  }

  const pkgQuick = []
  const pkgFull = []
  const pkgLint = []
  const pkgBuild = []
  const e2eCommands = [...ciE2eCommands]
  const e2ePackages = []
  for (const pkg of discovery.packages) {
    const mFile = pkg.dirRel ? `${pkg.dirRel}/${pkg.manifests[0] ?? ''}` : (pkg.manifests[0] ?? '')
    for (const c of Object.values(pkg.commands)) {
      if (isHeavyE2ePackage(pkg, c)) {
        if (pkg.dirRel && !e2ePackages.includes(pkg.dirRel)) e2ePackages.push(pkg.dirRel)
        for (const cmd of [c.quickTest, c.fullTest]) {
          if (cmd && !e2eCommands.includes(cmd)) {
            e2eCommands.push(cmd)
            detectionEvidence.push({ layer: 'manifest-e2e', kind: 'e2e', file: mFile, line: 1, command: cmd })
          }
        }
        continue
      }
      if (c.quickTest && !pkgQuick.includes(c.quickTest)) { pkgQuick.push(c.quickTest); detectionEvidence.push({ layer: 'manifest', kind: 'test', file: mFile, line: 1, command: c.quickTest }) }
      if (c.fullTest && !pkgFull.includes(c.fullTest)) { pkgFull.push(c.fullTest); detectionEvidence.push({ layer: 'manifest', kind: 'verify', file: mFile, line: 1, command: c.fullTest }) }
      if (c.lint && !pkgLint.includes(c.lint)) { pkgLint.push(c.lint); detectionEvidence.push({ layer: 'manifest', kind: 'lint', file: mFile, line: 1, command: c.lint }) }
      if (c.build && !pkgBuild.includes(c.build)) { pkgBuild.push(c.build); detectionEvidence.push({ layer: 'manifest', kind: 'build', file: mFile, line: 1, command: c.build }) }
    }
  }
  if (pkgQuick.length === 0 && existsSync(join(repoRoot, 'test'))) {
    try {
      if (readdirSync(join(repoRoot, 'test')).some((n) => /\.(?:m?js|cjs|ts)$/i.test(n))) {
        pkgQuick.push('node --test')
        detectionEvidence.push({ layer: 'manifest', kind: 'test', file: 'test/', line: 1, command: 'node --test' })
      }
    } catch { /* ignore */ }
  }
  if (profile) {
    const aLines = (readTextSafe(join(repoRoot, 'AGENTS.md')) ?? '').split('\n')
    for (const [key, prop] of [['quick-test', 'quickTest'], ['full-test', 'fullTest'], ['smoke-verify', 'smokeVerify'], ['merge-gate', 'mergeGate']]) {
      if (profile[prop]) {
        const idx = aLines.findIndex((l) => new RegExp(`^\\s*(?:[-*]\\s+)?\`?${key}\`?\\s*:`, 'i').test(l))
        detectionEvidence.unshift({ layer: 'dev-profile', kind: key, file: 'AGENTS.md', line: idx >= 0 ? idx + 1 : 1, command: profile[prop] })
      }
    }
  }

  return {
    quickTest: ciCommands.test ?? (pkgQuick.length > 0 ? pkgQuick.join(' && ') : undefined),
    fullTest: (pkgFull.length > 0 ? pkgFull.join(' && ') : undefined) ?? ciCommands.test,
    lint: ciCommands.lint ?? (pkgLint.length > 0 ? pkgLint.join(' && ') : undefined),
    build: ciCommands.build ?? (pkgBuild.length > 0 ? pkgBuild.join(' && ') : undefined),
    install: ciCommands.install,
    e2eTest: e2eCommands.length > 0 ? e2eCommands.join(' && ') : undefined,
    e2eCommands, e2ePackages, ciVerifyCommands, ciCommandsByKind,
    kinds: discovery.ecosystems, packages: discovery.packages,
    ciCommands, ciSources, taskRunners, detectionEvidence,
  }
}

const E2E_FILE_SUFFIX_RE = /\.(?:e2e|browser)\.(?:test|spec)\.[^/]+$|\.(?:e2e|cy)\.[^/]+$/i
const INT_FILE_SUFFIX_RE = /\.(?:integration|int)\.(?:test|spec)\.[^/]+$/i

function extractPathArgsFromScript(scriptStr) {
  const dirs = []
  for (const tok of String(scriptStr ?? '').split(/\s+/)) {
    const clean = posixPath(tok.replace(/^['"`]|['"`]$/g, '')).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!clean || clean.startsWith('-') || /^(?:node|npx|npm|pnpm|yarn|bun|vitest|jest|mocha|pytest|playwright|cypress|cargo|go|run|test|exec|uv|poetry)$/i.test(clean)) continue
    if (clean.includes('/') || /^(?:test|tests|e2e|integration|unit|spec|specs|cypress)$/i.test(clean)) dirs.push(clean.replace(/\/\*+$/, ''))
  }
  return [...new Set(dirs)]
}

/** 探测目标仓实际已配置的原生静态/类型校验工具，并生成 `.agents/` 忽略隔离建议（绝不自动改写第三方配置）。 */
export function detectOptionalNativeCheckers(repoRoot) {
  const configured = []
  const agentIgnoreAdvice = []
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  const scripts = (pkg && typeof pkg.scripts === 'object' && pkg.scripts) ? pkg.scripts : {}
  const pm = resolveNodePackageManager(repoRoot, pkg)
  const runScript = (name) => (pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`)
  const hasFile = (...names) => names.find((n) => existsSync(join(repoRoot, n)))
  const mentionsAgents = (rel) => Boolean(rel && /\.agents\b/.test(readTextSafe(join(repoRoot, rel)) ?? ''))

  const addAdvice = (id, tool, configFile, alreadyIgnored, suggestion) => {
    agentIgnoreAdvice.push({ id, tool, configFile, alreadyIgnored, suggestion })
  }

  const oxlintCfg = hasFile('.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts', 'oxlint.config.mts', 'oxlint.config.js', 'oxlint.config.mjs')
    || (pkg?.oxlint ? 'package.json' : null)
  if (oxlintCfg) {
    configured.push({ id: 'oxlint', tool: 'oxlint', configFile: oxlintCfg, command: scripts.lint ? runScript('lint') : null, declared: Boolean(scripts.lint) })
    addAdvice('oxlint', 'oxlint', oxlintCfg, mentionsAgents(oxlintCfg), `在 \`${oxlintCfg}\` 的 \`ignorePatterns\` 中添加 \`".agents/**"\``)
  }

  const oxfmtCfg = hasFile('.oxfmtrc.json', '.oxfmtrc.jsonc', '.oxfmtrc', 'oxfmt.config.ts', 'oxfmt.config.js', 'oxfmt.config.mjs')
  if (oxfmtCfg) {
    configured.push({ id: 'oxfmt', tool: 'oxfmt', configFile: oxfmtCfg, command: scripts.fmt ? runScript('fmt') : null, declared: Boolean(scripts.fmt) })
    addAdvice('oxfmt', 'oxfmt', oxfmtCfg, mentionsAgents(oxfmtCfg), `在 \`${oxfmtCfg}\` 的 \`ignorePatterns\` 中添加 \`".agents/**"\``)
  }

  const eslintCfg = hasFile('eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml')
  const eslintIgnore = hasFile('.eslintignore')
  if (eslintCfg || eslintIgnore || scripts.lint) {
    const cfg = eslintCfg ?? eslintIgnore ?? 'package.json'
    configured.push({ id: 'eslint', tool: 'eslint', configFile: cfg, command: scripts.lint ? runScript('lint') : null, declared: Boolean(scripts.lint) })
    addAdvice('eslint', 'eslint', cfg, mentionsAgents(eslintCfg) || mentionsAgents(eslintIgnore),
      eslintIgnore ? '在 `.eslintignore` 添加 `.agents/`' : `在 \`${cfg}\` 的 \`ignores\` 中添加 \`".agents/**"\``)
  }

  const biomeCfg = hasFile('biome.json', 'biome.jsonc')
  if (biomeCfg) {
    configured.push({ id: 'biome', tool: 'biome', configFile: biomeCfg, command: scripts.lint ? runScript('lint') : null, declared: Boolean(scripts.lint) })
    addAdvice('biome', 'biome', biomeCfg, mentionsAgents(biomeCfg), `在 \`${biomeCfg}\` 的 \`files.ignore\`（或 \`!/.agents\`）中添加 \`".agents/**"\``)
  }

  const dprintCfg = hasFile('dprint.json', 'dprint.jsonc')
  if (dprintCfg) {
    configured.push({ id: 'dprint', tool: 'dprint', configFile: dprintCfg, command: scripts.fmt ? runScript('fmt') : null, declared: Boolean(scripts.fmt) })
    addAdvice('dprint', 'dprint', dprintCfg, mentionsAgents(dprintCfg), `在 \`${dprintCfg}\` 的 \`excludes\` 中添加 \`"**/.agents/**"\``)
  }

  const tsCfg = hasFile('tsconfig.json')
  if (tsCfg) {
    const tcKey = ['typecheck', 'type-check', 'check-types'].find((k) => scripts[k])
    configured.push({ id: 'typescript', tool: 'tsc', configFile: tsCfg, command: tcKey ? runScript(tcKey) : null, declared: Boolean(tcKey) })
    addAdvice('typescript', 'tsc', tsCfg, mentionsAgents(tsCfg), `若 \`${tsCfg}\` 未限定 \`include\`，建议在 \`exclude\` 中添加 \`".agents"\``)
  }

  const pyProj = readTextSafe(join(repoRoot, 'pyproject.toml')) ?? ''
  const setupCfg = readTextSafe(join(repoRoot, 'setup.cfg')) ?? ''
  const ruffCfg = hasFile('ruff.toml', '.ruff.toml') || (/\[tool\.ruff\b/.test(pyProj) ? 'pyproject.toml' : null)
  if (ruffCfg) {
    configured.push({ id: 'ruff', tool: 'ruff', configFile: ruffCfg, command: 'ruff check .', declared: true })
    addAdvice('ruff', 'ruff', ruffCfg, mentionsAgents(ruffCfg), `在 \`${ruffCfg}\` 的 \`extend-exclude\` 中添加 \`".agents"\``)
  }
  const mypyCfg = hasFile('mypy.ini', '.mypy.ini') || (/\[tool\.mypy\b/.test(pyProj) ? 'pyproject.toml' : (/\[mypy\b/.test(setupCfg) ? 'setup.cfg' : null))
  if (mypyCfg) {
    configured.push({ id: 'mypy', tool: 'mypy', configFile: mypyCfg, command: 'mypy .', declared: true })
    addAdvice('mypy', 'mypy', mypyCfg, mentionsAgents(mypyCfg), `在 \`${mypyCfg}\` 的 \`exclude\` 中添加 \`".agents"\``)
  }
  const pyrightCfg = hasFile('pyrightconfig.json') || (/\[tool\.pyright\b/.test(pyProj) ? 'pyproject.toml' : null)
  if (pyrightCfg) {
    configured.push({ id: 'pyright', tool: 'pyright', configFile: pyrightCfg, command: 'pyright', declared: true })
    addAdvice('pyright', 'pyright', pyrightCfg, mentionsAgents(pyrightCfg), `在 \`${pyrightCfg}\` 的 \`exclude\` 中添加 \`".agents"\``)
  }
  const preCommitCfg = hasFile('.pre-commit-config.yaml', '.pre-commit-config.yml')
  if (preCommitCfg) {
    configured.push({ id: 'pre-commit', tool: 'pre-commit', configFile: preCommitCfg, command: 'pre-commit run --all-files', declared: true })
    addAdvice('pre-commit', 'pre-commit', preCommitCfg, mentionsAgents(preCommitCfg), `在 \`${preCommitCfg}\` 的 \`exclude\` 中添加 \`^\\.agents/\``)
  }
  const mdLintCfg = hasFile('.markdownlint.json', '.markdownlint.jsonc', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlintrc')
  const mdLintIgnore = hasFile('.markdownlintignore')
  if (mdLintCfg || mdLintIgnore) {
    const targetMdCfg = mdLintCfg ?? mdLintIgnore
    configured.push({ id: 'markdownlint', tool: 'markdownlint', configFile: targetMdCfg, command: null, declared: true })
    addAdvice('markdownlint', 'markdownlint', targetMdCfg, mentionsAgents(mdLintCfg) || mentionsAgents(mdLintIgnore), '在 `.markdownlintignore` 中添加 `.agents/`')
  }
  const prettierCfg = hasFile(
    '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5',
    '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.ts',
    'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts',
  ) || (pkg?.prettier ? 'package.json' : null)
  const prettierIgnore = hasFile('.prettierignore')
  if (prettierCfg || prettierIgnore) {
    const targetPrettierCfg = prettierCfg ?? prettierIgnore
    const fmtKey = scripts.format ? 'format' : (scripts.fmt ? 'fmt' : null)
    const ignoresAgents = mentionsAgents(prettierIgnore) || mentionsAgents(prettierCfg)
    const ignoresWorktrees = Boolean(
      (prettierIgnore && /\.worktrees\b/.test(readTextSafe(join(repoRoot, prettierIgnore)) ?? ''))
      || (prettierCfg && /\.worktrees\b/.test(readTextSafe(join(repoRoot, prettierCfg)) ?? '')),
    )
    const missingIgnore = [
      ...(!ignoresAgents ? ['.agents/'] : []),
      ...(!ignoresWorktrees ? ['.worktrees/'] : []),
    ]
    configured.push({ id: 'prettier', tool: 'prettier', configFile: targetPrettierCfg, command: fmtKey ? runScript(fmtKey) : null, declared: Boolean(fmtKey) })
    addAdvice(
      'prettier',
      'prettier',
      prettierIgnore ?? targetPrettierCfg,
      ignoresAgents && ignoresWorktrees,
      `在 \`.prettierignore\` 中添加 ${(missingIgnore.length > 0 ? missingIgnore : ['.agents/', '.worktrees/']).map((p) => `\`${p}\``).join(' 与 ')}`,
    )
  }
  if (existsSync(join(repoRoot, 'Cargo.toml'))) configured.push({ id: 'clippy', tool: 'cargo-clippy', configFile: 'Cargo.toml', command: 'cargo clippy --all-targets', declared: true })
  if (existsSync(join(repoRoot, 'go.mod'))) configured.push({ id: 'go-vet', tool: 'go-vet', configFile: 'go.mod', command: 'go vet ./...', declared: true })
  return { configured, hasNativeConfig: configured.length > 0, agentIgnoreAdvice }
}

/** 探测目标仓测试分层元数据（package.json 脚本、测试框架配置、Pytest markers、Cargo/Go 结构）。 */
export function detectTestTierMetadata(repoRoot, fileRelList = null) {
  const unitDirs = new Set()
  const integrationDirs = new Set()
  const e2eDirs = new Set()
  const scriptsByTier = { unit: [], integration: [], e2e: [] }
  const pytestMarkers = new Set()
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  const scripts = (pkg && typeof pkg.scripts === 'object' && pkg.scripts) ? pkg.scripts : {}
  for (const [name, cmd] of Object.entries(scripts)) {
    const low = name.toLowerCase()
    const val = String(cmd ?? '')
    if (/^(?:test:)?e2e$|^test:(?:browser|ui|playwright|cypress)$/i.test(low) || HEAVY_E2E_CMD_RE.test(val)) {
      scriptsByTier.e2e.push({ name, cmd: val })
      for (const d of extractPathArgsFromScript(val)) e2eDirs.add(d)
    } else if (/^test:(?:int|integration|it|api|db)$|^integration$/i.test(low)) {
      scriptsByTier.integration.push({ name, cmd: val })
      for (const d of extractPathArgsFromScript(val)) integrationDirs.add(d)
    } else if (/^test:unit$|^unit$/i.test(low)) {
      scriptsByTier.unit.push({ name, cmd: val })
      for (const d of extractPathArgsFromScript(val)) unitDirs.add(d)
    }
  }
  for (const cfgName of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs']) {
    const txt = readTextSafe(join(repoRoot, cfgName))
    if (!txt) continue
    const td = /\btestDir\s*:\s*['"]([^'"]+)['"]/.exec(txt)?.[1]
    if (td) e2eDirs.add(posixPath(td).replace(/^\.\//, '').replace(/\/+$/, ''))
    const spec = /\bspecPattern\s*:\s*['"]([^'"]+)['"]/.exec(txt)?.[1]
    if (spec) e2eDirs.add(posixPath(spec).replace(/^\.\//, '').split('/')[0])
  }
  for (const cfgName of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts']) {
    const txt = readTextSafe(join(repoRoot, cfgName))
    if (!txt) continue
    for (const m of txt.matchAll(/name\s*:\s*['"](unit|integration|e2e)['"][\s\S]{0,200}?(?:include|testMatch|roots)\s*:\s*\[\s*['"]([^'"]+)['"]/gi)) {
      const base = posixPath(m[2]).replace(/^\.\//, '').replace(/^<rootDir>\//, '').split(/[*?]/)[0].replace(/\/+$/, '')
      if (!base) continue
      const t = m[1].toLowerCase()
      if (t === 'e2e') e2eDirs.add(base)
      else if (t === 'integration') integrationDirs.add(base)
      else unitDirs.add(base)
    }
  }
  for (const pyCfg of ['pytest.ini', 'pyproject.toml', 'setup.cfg']) {
    const txt = readTextSafe(join(repoRoot, pyCfg))
    if (txt) for (const m of txt.matchAll(/^\s*(e2e|integration|unit|slow|browser)\s*:/gim)) pytestMarkers.add(m[1].toLowerCase())
  }
  const hasCargo = existsSync(join(repoRoot, 'Cargo.toml'))
  const hasGoMod = existsSync(join(repoRoot, 'go.mod'))
  const hasMultiTierConfig = scriptsByTier.e2e.length > 0 || scriptsByTier.integration.length > 0
    || e2eDirs.size > 0 || integrationDirs.size > 0 || pytestMarkers.has('e2e') || pytestMarkers.has('integration')
  return {
    unitDirs: [...unitDirs], integrationDirs: [...integrationDirs], e2eDirs: [...e2eDirs],
    scriptsByTier, pytestMarkers: [...pytestMarkers], hasCargo, hasGoMod, hasMultiTierConfig,
    fileCountHint: Array.isArray(fileRelList) ? fileRelList.length : null,
  }
}

/** 结合仓库测试分层元数据与文件级标记精准判定单个测试文件层级（unit / integration / e2e）。 */
export function classifyTestFileTier(relFile, fileText = '', tierMeta = null) {
  const rel = posixPath(relFile).replace(/^\.\//, '')
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const txt = String(fileText ?? '')
  const dirMatches = (dirs) => (dirs ?? []).some((d) => rel === d || rel.startsWith(`${d}/`))
  if (ext === 'go') {
    const tagM = /^\/\/(?:go:build|\s*\+build)\s+(.+)$/m.exec(txt.split('\n').slice(0, 12).join('\n'))
    if (tagM) {
      if (/\be2e\b/i.test(tagM[1])) return { tier: 'e2e', reason: 'go-build-tag' }
      if (/\b(?:integration|functional|acceptance)\b/i.test(tagM[1])) return { tier: 'integration', reason: 'go-build-tag' }
    }
  }
  if (ext === 'py') {
    if (/@pytest\.mark\.(?:e2e|browser|playwright|selenium)\b/.test(txt)) return { tier: 'e2e', reason: 'pytest-marker' }
    if (/@pytest\.mark\.(?:integration|slow|db)\b/.test(txt)) return { tier: 'integration', reason: 'pytest-marker' }
  }
  if (dirMatches(tierMeta?.e2eDirs)) return { tier: 'e2e', reason: 'config-e2e-dir' }
  if (dirMatches(tierMeta?.integrationDirs)) return { tier: 'integration', reason: 'config-integration-dir' }
  if (dirMatches(tierMeta?.unitDirs)) return { tier: 'unit', reason: 'config-unit-dir' }
  if (ext === 'rs' && tierMeta?.hasCargo) {
    return (rel.startsWith('tests/') || rel.includes('/tests/')) ? { tier: 'integration', reason: 'cargo-tests-dir' } : { tier: 'unit', reason: 'cargo-lib-unit' }
  }
  if (E2E_FILE_SUFFIX_RE.test(rel)) return { tier: 'e2e', reason: 'explicit-e2e-suffix' }
  if (INT_FILE_SUFFIX_RE.test(rel)) return { tier: 'integration', reason: 'explicit-integration-suffix' }
  return { tier: 'unit', reason: 'default-unit' }
}
