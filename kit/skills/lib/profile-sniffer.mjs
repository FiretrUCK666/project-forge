/**
 * profile-sniffer.mjs —— 唯一单源三层命令嗅探与全深度非 vendor 子包探测器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零平台禁词（使用中性 CI 配置清单）：
 *   Layer 1: AGENTS.md `## Dev Profile`
 *   Layer 2: 中性 CI 配置（2/4 空格 YAML、Jenkinsfile）+ Taskfile / Makefile / justfile
 *   Layer 3: 全深度递归包清单探测（跳过 COMMON_SKIP_DIRS 与 vendor/examples 等参考目录，Windows 安全）
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, posix as pathPosix, relative } from 'node:path'

import { DEFAULT_WALK_SKIP_DIRS, isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe } from './git.mjs'

export const VENDOR_OR_EXAMPLE_SKIP_DIRS = new Set([
  'vendor', 'third_party', 'examples', 'samples', 'fixtures', 'testdata', '__mocks__',
])

export const NEUTRAL_CI_CONFIGS = Object.freeze([
  '.circleci/config.yml',
  '.circleci/config.yaml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'Jenkinsfile',
  '.travis.yml',
  '.drone.yml',
  '.buildkite/pipeline.yml',
  '.buildkite/pipeline.yaml',
  '.woodpecker.yml',
])

const MANIFEST_BASENAMES = new Set([
  'package.json', 'pnpm-workspace.yaml',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat',
  'Cargo.toml', 'go.work', 'go.mod',
  'Package.swift', 'CMakeLists.txt', 'meson.build',
  'composer.json', 'Gemfile', 'pubspec.yaml', 'mix.exs',
  'Makefile', 'GNUmakefile', 'makefile', 'justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml',
])

const LOCKFILE_ONLY_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock', 'composer.lock', 'flake.lock', 'Package.resolved',
])

const CI_COMMAND_KINDS = [
  { key: 'test', re: /\b(?:test|tests|runtest|spec|specs|check|verify|validate|preflight|pytest|unittest|vitest|jest|mocha|rspec|ctest|phpunit)\b/i },
  { key: 'lint', re: /\b(?:lint|clippy|rubocop|eslint|flake8|pylint|ruff|mypy|pyright|biome|format|fmt|hlint|vet)\b/i },
  { key: 'build', re: /\b(?:build|compile|bundle|package|make|assemble)\b/i },
  { key: 'install', re: /\b(?:install|deps|dependencies|setup|bootstrap|restore)\b/i },
]

const TASKFILE_ALIASES = {
  test: ['test', 'tests', 'check', 'verify', 'spec', 'specs', 'runtest', 'unittest'],
  lint: ['lint', 'vet', 'fmt-check', 'format-check', 'style'],
  build: ['build', 'all', 'compile', 'dist'],
  install: ['install', 'deps', 'dependencies', 'setup', 'bootstrap'],
}

function shouldSkipSegment(name) {
  return DEFAULT_WALK_SKIP_DIRS.has(name) || VENDOR_OR_EXAMPLE_SKIP_DIRS.has(name)
}

function stripInlineYamlComment(val) {
  const s = String(val ?? '')
  let quote = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim()
  }
  return s.trim()
}

function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`')) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
}

/**
 * 兼容 2 空格 / 4 空格 / 混合缩进 YAML 的 `run:` / `script:` / `commands:` / `command:` 提取器（支持 CircleCI mapping 步）。
 */
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
        if (!tail && stepMappingKeyRe.test(raw.trim())) {
          isYamlStepObject = true
          break
        }
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
      if (clean && !/^(?:true|false|null)$/i.test(clean)) {
        steps.push({ file: relFile, line: startLine, cmd: clean })
      }
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
      const lines = text.split('\n')
      lines.forEach((ln, idx) => {
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
    const lines = text.split('\n')
    for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) {
      if (!m[1].startsWith('.')) makeTargets.add(m[1])
    }
    runners.push({ runner: 'make', file: makefile, names: makeTargets, lines })
  }
  const justfile = ['justfile', 'Justfile', '.justfile'].find((n) => existsSync(join(repoRoot, n)))
  if (justfile) {
    const text = readTextSafe(join(repoRoot, justfile)) ?? ''
    const lines = text.split('\n')
    for (const m of text.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s+[^:\n]*)?:(?!=)/gm)) justRecipes.add(m[1])
    runners.push({ runner: 'just', file: justfile, names: justRecipes, lines })
  }
  const taskfile = ['Taskfile.yml', 'Taskfile.yaml'].find((n) => existsSync(join(repoRoot, n)))
  if (taskfile) {
    const text = readTextSafe(join(repoRoot, taskfile)) ?? ''
    const lines = text.split('\n')
    const padded = `\n${text}`
    const tasksSec = /\ntasks:\s*\n([\s\S]*?)(?:\n[a-z]+:|\s*$)/.exec(padded)
    if (tasksSec) {
      for (const m of tasksSec[1].matchAll(/^ {2,4}([A-Za-z0-9_.-]+)\s*:/gm)) taskNames.add(m[1])
    }
    runners.push({ runner: 'task', file: taskfile, names: taskNames, lines })
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

/** 解析 `pnpm-workspace.yaml` 或 `package.json#workspaces` 中的工作区目录模式。 */
export function parseYamlWorkspaceGlobs(repoRoot) {
  const globs = []
  const pnpmWs = readTextSafe(join(repoRoot, 'pnpm-workspace.yaml'))
  if (pnpmWs) {
    let inPkgs = false
    for (const line of pnpmWs.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (/^packages\s*:/.test(t)) { inPkgs = true; continue }
      if (inPkgs) {
        if (/^-\s+/.test(t)) {
          const item = stripWrapQuotes(stripInlineYamlComment(t.replace(/^-\s+/, '')))
          if (item && !item.startsWith('!')) globs.push(posixPath(item).replace(/\/+$/, ''))
        } else if (!/^\s/.test(line)) {
          inPkgs = false
        }
      }
    }
  }
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
  if (Array.isArray(ws)) {
    for (const item of ws) {
      const clean = posixPath(String(item ?? '').trim()).replace(/\/+$/, '')
      if (clean && !clean.startsWith('!')) globs.push(clean)
    }
  }
  return [...new Set(globs)]
}

function collectManifestFilesSync(repoRoot) {
  const hits = []
  const queue = [repoRoot]
  let visitedDirs = 0
  while (queue.length > 0 && visitedDirs < 8000) {
    const dir = queue.shift()
    visitedDirs += 1
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(repoRoot, full))
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')) {
          hits.push(rel)
          continue
        }
        if (!shouldSkipSegment(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        hits.push(rel)
      }
    }
  }
  return hits
}

function isInterestingManifestRel(rel) {
  const base = pathPosix.basename(rel)
  if (MANIFEST_BASENAMES.has(base) || LOCKFILE_ONLY_NAMES.has(base)) return true
  if (/^requirements.*\.txt$/i.test(base)) return true
  if (/\.(?:sln|csproj|fsproj|vbproj|xcodeproj|xcworkspace)$/i.test(base)) return true
  return false
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

function resolveJavaWrapper(absDir, repoRoot, dirRel, unixName, winName, fallbackBin) {
  const localUnix = existsSync(join(absDir, unixName))
  const localWin = existsSync(join(absDir, winName))
  const rootUnix = existsSync(join(repoRoot, unixName))
  const rootWin = existsSync(join(repoRoot, winName))
  if (process.platform === 'win32') {
    if (localWin && !localUnix) return dirRel ? `${dirRel}\\${winName}` : winName
    if (localUnix) return `./${dirRel ? `${dirRel}/` : ''}${unixName}`
    if (rootWin && !rootUnix) return winName
    if (rootUnix) return `./${unixName}`
    return fallbackBin
  }
  if (localUnix) return `./${dirRel ? `${dirRel}/` : ''}${unixName}`
  if (rootUnix) return `./${unixName}`
  return fallbackBin
}

/**
 * 动态发现全仓库多语言包清单与任务入口（全深度、跳过 vendor/examples 等参考目录，Windows 安全无 subshell cd）。
 */
export function discoverWorkspacePackages(repoRoot, fileRelList = null) {
  const rawFiles = Array.isArray(fileRelList) ? fileRelList : collectManifestFilesSync(repoRoot)
  const relevant = rawFiles.filter((raw) => {
    const rel = posixPath(raw)
    if (isMacOsJunkPath(rel)) return false
    const segs = rel.split('/')
    if (segs.slice(0, -1).some((s) => shouldSkipSegment(s))) return false
    return isInterestingManifestRel(rel)
  })

  const rootPm = existsSync(join(repoRoot, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(repoRoot, 'yarn.lock')) ? 'yarn'
      : existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb')) ? 'bun' : 'npm'

  const byDir = new Map()
  const ensureDir = (dirRel) => {
    const key = dirRel === '.' ? '' : dirRel
    if (!byDir.has(key)) {
      byDir.set(key, { dirRel: key, ecosystems: new Set(), manifests: [], lockfiles: [], commands: {} })
    }
    return byDir.get(key)
  }

  for (const rel of relevant) {
    const base = pathPosix.basename(rel)
    const dirRel = pathPosix.dirname(rel) === '.' ? '' : pathPosix.dirname(rel)
    const bucket = ensureDir(dirRel)
    if (LOCKFILE_ONLY_NAMES.has(base) || /^requirements.*\.txt$/i.test(base)) bucket.lockfiles.push(base)
    if (!LOCKFILE_ONLY_NAMES.has(base)) bucket.manifests.push(base)

    if (base === 'package.json') bucket.ecosystems.add('node')
    else if (['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile', 'uv.lock', 'poetry.lock', 'Pipfile.lock'].includes(base) || /^requirements.*\.txt$/i.test(base)) {
      bucket.ecosystems.add('python')
    } else if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat', 'gradle.lockfile'].includes(base)) {
      bucket.ecosystems.add('java')
    } else if (base === 'Cargo.toml' || base === 'Cargo.lock') bucket.ecosystems.add('rust')
    else if (base === 'go.work' || base === 'go.mod' || base === 'go.sum') bucket.ecosystems.add('go')
    else if (/\.(?:sln|csproj|fsproj|vbproj)$/i.test(base) || base === 'packages.lock.json') bucket.ecosystems.add('dotnet')
    else if (base === 'Package.swift' || /\.(?:xcodeproj|xcworkspace)$/i.test(base)) bucket.ecosystems.add('apple')
    else if (base === 'CMakeLists.txt' || base === 'meson.build') bucket.ecosystems.add('cpp')
    else if (base === 'composer.json' || base === 'composer.lock') bucket.ecosystems.add('php')
    else if (base === 'Gemfile' || base === 'Gemfile.lock') bucket.ecosystems.add('ruby')
    else if (base === 'pubspec.yaml') bucket.ecosystems.add('dart')
    else if (base === 'mix.exs') bucket.ecosystems.add('elixir')
  }

  const packages = []
  const allEcosystems = new Set()

  for (const bucket of [...byDir.values()].sort((a, b) => a.dirRel.localeCompare(b.dirRel))) {
    const dirRel = bucket.dirRel
    const absDir = dirRel ? join(repoRoot, dirRel) : repoRoot
    for (const eco of bucket.ecosystems) allEcosystems.add(eco)

    if (bucket.ecosystems.has('node')) {
      const nodeInfo = detectNodePackageCommands(repoRoot, dirRel, rootPm)
      if (nodeInfo) { bucket.name = nodeInfo.name; bucket.commands.node = nodeInfo }
    }
    if (bucket.ecosystems.has('java')) {
      const hasMvn = existsSync(join(absDir, 'pom.xml'))
      const hasGradle = existsSync(join(absDir, 'build.gradle')) || existsSync(join(absDir, 'build.gradle.kts'))
      if (hasMvn) {
        const bin = resolveJavaWrapper(absDir, repoRoot, dirRel, 'mvnw', 'mvnw.cmd', 'mvn')
        const fileFlag = dirRel ? ` -f ${dirRel}/pom.xml` : ''
        const hasSrcTest = existsSync(join(absDir, 'src', 'test'))
        bucket.commands.java = {
          quickTest: `${bin}${fileFlag} test`,
          build: `${bin}${fileFlag} package -DskipTests`,
          hasSrcTest,
        }
      } else if (hasGradle) {
        const bin = resolveJavaWrapper(absDir, repoRoot, dirRel, 'gradlew', 'gradlew.bat', 'gradle')
        const projFlag = dirRel ? ` -p ${dirRel}` : ''
        const hasSrcTest = existsSync(join(absDir, 'src', 'test'))
        bucket.commands.java = { quickTest: `${bin}${projFlag} test`, build: `${bin}${projFlag} build -x test`, hasSrcTest }
      }
    }
    if (bucket.ecosystems.has('python')) {
      const hasTests = existsSync(join(absDir, 'tests')) || existsSync(join(absDir, 'test')) || existsSync(join(absDir, 'pytest.ini'))
      if (hasTests) {
        const isUv = existsSync(join(absDir, 'uv.lock')) || existsSync(join(repoRoot, 'uv.lock'))
        const isPoetry = existsSync(join(absDir, 'poetry.lock')) || existsSync(join(repoRoot, 'poetry.lock'))
        const cmd = dirRel
          ? (isUv ? `uv run --directory ${dirRel} pytest` : isPoetry ? `poetry -C ${dirRel} run pytest` : `pytest ${dirRel}`)
          : (isUv ? 'uv run pytest' : isPoetry ? 'poetry run pytest' : 'pytest')
        bucket.commands.python = { quickTest: cmd }
      }
    }
    if (bucket.ecosystems.has('rust') && existsSync(join(absDir, 'Cargo.toml'))) {
      const mf = dirRel ? ` --manifest-path ${dirRel}/Cargo.toml` : ''
      bucket.commands.rust = { quickTest: `cargo test${mf}`, build: `cargo build${mf}` }
    }
    if (bucket.ecosystems.has('go') && (existsSync(join(absDir, 'go.mod')) || existsSync(join(absDir, 'go.work')))) {
      const cmd = dirRel ? `go -C ${dirRel} test ./...` : 'go test ./...'
      const build = dirRel ? `go -C ${dirRel} build ./...` : 'go build ./...'
      bucket.commands.go = { quickTest: cmd, build }
    }
    if (bucket.ecosystems.has('dotnet')) {
      bucket.commands.dotnet = {
        quickTest: dirRel ? `dotnet test ${dirRel}` : 'dotnet test',
        build: dirRel ? `dotnet build ${dirRel}` : 'dotnet build',
      }
    }
    if (bucket.ecosystems.has('apple') && existsSync(join(absDir, 'Package.swift'))) {
      const pkgFlag = dirRel ? ` --package-path ${dirRel}` : ''
      bucket.commands.apple = { quickTest: `swift test${pkgFlag}`, build: `swift build${pkgFlag}` }
    }
    if (bucket.ecosystems.has('cpp') && existsSync(join(absDir, 'CMakeLists.txt'))) {
      const bdir = dirRel ? `${dirRel}/build` : 'build'
      bucket.commands.cpp = { quickTest: `ctest --test-dir ${bdir} --output-on-failure`, build: `cmake --build ${bdir}` }
    }

    packages.push({
      dirRel,
      name: bucket.name ?? (dirRel || basename(repoRoot)),
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

/**
 * 统一三层优先级命令嗅探：
 *   Layer 1: Dev Profile (AGENTS.md)
 *   Layer 2: 中立 CI 配置 + Taskfile/Makefile/justfile
 *   Layer 3: 递归多语言子包清单
 * 附带每条命令的 `detectionEvidence` (`layer`, `file`, `line`, `command`)。
 */
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
    if (HEAVY_E2E_CMD_RE.test(normCmd)) {
      if (!ciE2eCommands.includes(normCmd)) ciE2eCommands.push(normCmd)
      continue
    }
    const kind = classifyCiCommand(normCmd)
    if (!kind) continue
    if (!ciCommandsByKind[kind].includes(normCmd)) {
      ciCommandsByKind[kind].push(normCmd)
      detectionEvidence.push({ layer: 'ci-or-taskfile', kind, file: step.file, line: step.line, command: normCmd })
    }
    if (ciSources[kind] === undefined) ciSources[kind] = step.file
    if (kind !== 'install' && !seenVerify.has(normCmd)) {
      seenVerify.add(normCmd)
      ciVerifyCommands.push(normCmd)
    }
  }
  for (const [kind, cmds] of Object.entries(ciCommandsByKind)) {
    if (cmds.length === 0) continue
    ciCommands[kind] = kind === 'test' && cmds.length > 1 ? cmds.join(' && ') : cmds[0]
  }
  for (const ev of taskRunners.evidence) {
    if (ciCommands[ev.kind] === undefined) {
      ciCommands[ev.kind] = ev.command
      ciSources[ev.kind] = ev.file
      if (!ciCommandsByKind[ev.kind].includes(ev.command)) ciCommandsByKind[ev.kind].push(ev.command)
      if (ev.kind !== 'install' && !seenVerify.has(ev.command)) {
        seenVerify.add(ev.command)
        ciVerifyCommands.push(ev.command)
      }
      detectionEvidence.push(ev)
    }
  }

  const pkgQuick = []
  const pkgFull = []
  const pkgLint = []
  const pkgBuild = []
  const e2eCommands = [...ciE2eCommands]
  const e2ePackages = []
  const pushUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v) }
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
      if (c.quickTest && !pkgQuick.includes(c.quickTest)) {
        pkgQuick.push(c.quickTest)
        detectionEvidence.push({ layer: 'manifest', kind: 'test', file: mFile, line: 1, command: c.quickTest })
      }
      if (c.fullTest && !pkgFull.includes(c.fullTest)) {
        pkgFull.push(c.fullTest)
        detectionEvidence.push({ layer: 'manifest', kind: 'verify', file: mFile, line: 1, command: c.fullTest })
      }
      if (c.lint && !pkgLint.includes(c.lint)) {
        pkgLint.push(c.lint)
        detectionEvidence.push({ layer: 'manifest', kind: 'lint', file: mFile, line: 1, command: c.lint })
      }
      if (c.build && !pkgBuild.includes(c.build)) {
        pkgBuild.push(c.build)
        detectionEvidence.push({ layer: 'manifest', kind: 'build', file: mFile, line: 1, command: c.build })
      }
    }
  }
  if (pkgQuick.length === 0 && existsSync(join(repoRoot, 'test'))) {
    try {
      if (readdirSync(join(repoRoot, 'test')).some((n) => /\.(?:m?js|cjs|ts)$/i.test(n))) {
        pushUnique(pkgQuick, 'node --test')
        detectionEvidence.push({ layer: 'manifest', kind: 'test', file: 'test/', line: 1, command: 'node --test' })
      }
    } catch { /* ignore */ }
  }

  if (profile) {
    const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md')) ?? ''
    const aLines = agentsText.split('\n')
    for (const [key, prop] of [['quick-test', 'quickTest'], ['full-test', 'fullTest'], ['smoke-verify', 'smokeVerify'], ['merge-gate', 'mergeGate']]) {
      if (profile[prop]) {
        const idx = aLines.findIndex((l) => new RegExp(`^\\s*(?:[-*]\\s+)?\`?${key}\`?\\s*:`, 'i').test(l))
        detectionEvidence.unshift({
          layer: 'dev-profile', kind: key, file: 'AGENTS.md', line: idx >= 0 ? idx + 1 : 1, command: profile[prop],
        })
      }
    }
  }

  const quickTest = ciCommands.test ?? (pkgQuick.length > 0 ? pkgQuick.join(' && ') : undefined)
  const fullTest = (pkgFull.length > 0 ? pkgFull.join(' && ') : undefined) ?? ciCommands.test
  const lint = ciCommands.lint ?? (pkgLint.length > 0 ? pkgLint.join(' && ') : undefined)
  const build = ciCommands.build ?? (pkgBuild.length > 0 ? pkgBuild.join(' && ') : undefined)

  return {
    quickTest,
    fullTest,
    lint,
    build,
    install: ciCommands.install,
    e2eTest: e2eCommands.length > 0 ? e2eCommands.join(' && ') : undefined,
    e2eCommands,
    e2ePackages,
    ciVerifyCommands,
    ciCommandsByKind,
    kinds: discovery.ecosystems,
    packages: discovery.packages,
    ciCommands,
    ciSources,
    taskRunners,
    detectionEvidence,
  }
}
