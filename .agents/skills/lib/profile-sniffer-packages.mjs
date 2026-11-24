/**
 * profile-sniffer-packages.mjs —— 多生态清单解析、工作区 glob 与子包命令发现辅助模块。
 *
 * 从 `profile-sniffer.mjs` 拆出以控制单文件行数 <= 800 且保持零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, posix as pathPosix, relative } from 'node:path'

import { DEFAULT_WALK_SKIP_DIRS, isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe } from './git.mjs'

export const VENDOR_OR_EXAMPLE_SKIP_DIRS = new Set([
  'vendor', 'third_party', 'examples', 'samples', 'fixtures', 'testdata', '__mocks__',
])

const MANIFEST_BASENAMES = new Set([
  'package.json', 'pnpm-workspace.yaml',
  'deno.json', 'deno.jsonc', 'jsr.json', 'jsr.jsonc',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat',
  'Cargo.toml', 'go.work', 'go.mod',
  'Package.swift', 'CMakeLists.txt', 'meson.build',
  'composer.json', 'Gemfile', 'pubspec.yaml', 'mix.exs',
  'Makefile', 'GNUmakefile', 'makefile', 'justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'Taskfile.yaml',
])

const LOCKFILE_ONLY_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'deno.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock', 'composer.lock', 'flake.lock', 'Package.resolved',
])

export function shouldSkipSegment(name) {
  return DEFAULT_WALK_SKIP_DIRS.has(name) || VENDOR_OR_EXAMPLE_SKIP_DIRS.has(name)
}

export function stripInlineYamlComment(val) {
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

export function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`')) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
}

/** 剥离 JSONC 行内/块级注释与尾逗号（保留字符串字面量内的 `//` 与 `/*`）。 */
export function stripJsonComments(text) {
  const s = String(text ?? '')
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    const next = s[i + 1]
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1 }
      else if (ch === '\n') out += '\n'
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 1; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue }
    out += ch
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function readJsoncSafe(filePath) {
  const raw = readTextSafe(filePath)
  if (raw === undefined) return undefined
  try { return JSON.parse(stripJsonComments(raw)) } catch { return undefined }
}

/** 从根目录锁文件、`pnpm-workspace.yaml` 与 `package.json#packageManager` 推断包管理器。 */
export function resolveNodePackageManager(repoRoot, pkg = null) {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml')) || existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) return 'pnpm'
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb'))) return 'bun'
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm'
  const rootPkg = pkg ?? readJsonSafe(join(repoRoot, 'package.json'))
  const pmDecl = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.trim().toLowerCase() : ''
  if (pmDecl.startsWith('pnpm@')) return 'pnpm'
  if (pmDecl.startsWith('yarn@')) return 'yarn'
  if (pmDecl.startsWith('bun@')) return 'bun'
  return 'npm'
}

/** 读取 `jsr.json` / `jsr.jsonc` / `deno.json` / `deno.jsonc` 元数据（含 name/version/exports/tasks/publishable）。 */
export function readDenoOrJsrManifest(absDir) {
  const denoCfgName = ['deno.json', 'deno.jsonc'].find((n) => existsSync(join(absDir, n)))
  const jsrCfgName = ['jsr.json', 'jsr.jsonc'].find((n) => existsSync(join(absDir, n)))
  if (!denoCfgName && !jsrCfgName) return null
  const denoCfg = denoCfgName ? readJsoncSafe(join(absDir, denoCfgName)) : null
  const jsrCfg = jsrCfgName ? readJsoncSafe(join(absDir, jsrCfgName)) : null
  if (!denoCfg && !jsrCfg) return null
  const name = (typeof jsrCfg?.name === 'string' && jsrCfg.name.trim())
    || (typeof denoCfg?.name === 'string' && denoCfg.name.trim())
    || undefined
  const version = (typeof jsrCfg?.version === 'string' && jsrCfg.version.trim())
    || (typeof denoCfg?.version === 'string' && denoCfg.version.trim())
    || undefined
  const exportsVal = jsrCfg?.exports ?? denoCfg?.exports
  const tasks = (denoCfg?.tasks && typeof denoCfg.tasks === 'object' && !Array.isArray(denoCfg.tasks))
    ? denoCfg.tasks
    : {}
  const workspace = Array.isArray(denoCfg?.workspace)
    ? denoCfg.workspace
    : (Array.isArray(jsrCfg?.workspace) ? jsrCfg.workspace : undefined)
  const manifests = [jsrCfgName, denoCfgName].filter(Boolean)
  const publishable = Boolean(name && version && exportsVal && jsrCfg?.publish !== false && denoCfg?.publish !== false)
  return {
    manifests,
    primaryManifest: jsrCfgName || denoCfgName,
    name,
    version,
    exports: exportsVal,
    tasks,
    workspace,
    publishable,
  }
}

/** 判定目录是否为明确 .NET 测试工程（排除 Benchmarks / BenchmarkDotNet 纯基准工程）。 */
export function isDotnetTestProject(absDir, dirRel = '') {
  const normDir = posixPath(dirRel)
  if (/(?:^|\/)(?:benchmarks?|perf|benches)(?:\/|$)/i.test(normDir)) return false
  let entries = []
  try { entries = readdirSync(absDir) } catch { return false }
  const projFiles = entries.filter((n) => /\.(?:cs|fs|vb)proj$/i.test(n))
  if (projFiles.length === 0) return false
  let hasTestRef = false
  let hasBenchmarkOnly = false
  for (const name of projFiles) {
    if (/(?:benchmark|benchmarks)\.(?:cs|fs|vb)proj$/i.test(name)) hasBenchmarkOnly = true
    const text = readTextSafe(join(absDir, name)) ?? ''
    if (/\b(?:Microsoft\.NET\.Test\.Sdk|xunit|nunit|mstest|TUnit)\b/i.test(text)
      || /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text)) {
      hasTestRef = true
    } else if (/\.?Tests?\.(?:cs|fs|vb)proj$/i.test(name) && !/Benchmark/i.test(name)) {
      hasTestRef = true
    }
    if (/\bBenchmarkDotNet\b/i.test(text) && !hasTestRef) hasBenchmarkOnly = true
  }
  if (hasTestRef) return true
  if (hasBenchmarkOnly) return false
  return false
}

/** 检查目录或其祖先 `Directory.Build.props` / `*.csproj` 是否使用 MinVer 版本驱动。 */
export function hasDotnetMinVer(absDir, repoRoot = absDir) {
  const checkFile = (p) => {
    const txt = readTextSafe(p)
    return Boolean(txt && /\bMinVer\b/i.test(txt))
  }
  if (checkFile(join(absDir, 'Directory.Build.props'))) return true
  if (repoRoot && repoRoot !== absDir && checkFile(join(repoRoot, 'Directory.Build.props'))) return true
  try {
    for (const name of readdirSync(absDir)) {
      if (/\.(?:cs|fs|vb)proj$/i.test(name) && checkFile(join(absDir, name))) return true
    }
  } catch { /* ignore */ }
  return false
}

/** 解析 `pnpm-workspace.yaml`、`package.json#workspaces` 与 `deno.json(c)#workspace` 中的工作区模式（完整保留 `!` 负向排除）。 */
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
          if (item) globs.push(posixPath(item).replace(/\/+$/, ''))
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
      if (clean) globs.push(clean)
    }
  }
  const denoInfo = readDenoOrJsrManifest(repoRoot)
  if (Array.isArray(denoInfo?.workspace)) {
    for (const item of denoInfo.workspace) {
      const clean = posixPath(String(item ?? '').trim()).replace(/^\.\//, '').replace(/\/+$/, '')
      if (clean) globs.push(clean)
    }
  }
  return [...new Set(globs)]
}

export function collectManifestFilesSync(repoRoot) {
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

export function isInterestingManifestRel(rel) {
  const base = pathPosix.basename(rel)
  if (MANIFEST_BASENAMES.has(base) || LOCKFILE_ONLY_NAMES.has(base)) return true
  if (/^requirements.*\.txt$/i.test(base)) return true
  if (/\.(?:sln|slnx|csproj|fsproj|vbproj|xcodeproj|xcworkspace)$/i.test(base)) return true
  return false
}

export function resolveJavaWrapper(absDir, repoRoot, dirRel, unixName, winName, fallbackBin) {
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

export function groupPackageManifests(repoRoot, fileRelList = null) {
  const rawFiles = Array.isArray(fileRelList) ? fileRelList : collectManifestFilesSync(repoRoot)
  const relevant = rawFiles.filter((raw) => {
    const rel = posixPath(raw)
    if (isMacOsJunkPath(rel)) return false
    const segs = rel.split('/')
    if (segs.slice(0, -1).some((s) => shouldSkipSegment(s))) return false
    return isInterestingManifestRel(rel)
  })

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
    else if (['deno.json', 'deno.jsonc', 'jsr.json', 'jsr.jsonc'].includes(base)) bucket.ecosystems.add('deno')
    else if (['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile', 'uv.lock', 'poetry.lock', 'Pipfile.lock'].includes(base) || /^requirements.*\.txt$/i.test(base)) {
      bucket.ecosystems.add('python')
    } else if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat', 'gradle.lockfile'].includes(base)) {
      bucket.ecosystems.add('java')
    } else if (base === 'Cargo.toml' || base === 'Cargo.lock') bucket.ecosystems.add('rust')
    else if (base === 'go.work' || base === 'go.mod' || base === 'go.sum') bucket.ecosystems.add('go')
    else if (/\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(base) || base === 'packages.lock.json') bucket.ecosystems.add('dotnet')
    else if (base === 'Package.swift' || /\.(?:xcodeproj|xcworkspace)$/i.test(base)) bucket.ecosystems.add('apple')
    else if (base === 'CMakeLists.txt' || base === 'meson.build') bucket.ecosystems.add('cpp')
    else if (base === 'composer.json' || base === 'composer.lock') bucket.ecosystems.add('php')
    else if (base === 'Gemfile' || base === 'Gemfile.lock') bucket.ecosystems.add('ruby')
    else if (base === 'pubspec.yaml') bucket.ecosystems.add('dart')
    else if (base === 'mix.exs') bucket.ecosystems.add('elixir')
  }
  return byDir
}

export function detectNonNodePackageCommands(repoRoot, bucket) {
  const dirRel = bucket.dirRel
  const absDir = dirRel ? join(repoRoot, dirRel) : repoRoot

  if (bucket.ecosystems.has('deno')) {
    const denoInfo = readDenoOrJsrManifest(absDir)
    if (denoInfo) {
      if (denoInfo.name && !bucket.name) bucket.name = denoInfo.name
      const tasks = denoInfo.tasks ?? {}
      const cmdObj = {}
      if (tasks.test) cmdObj.quickTest = dirRel ? `deno task --cwd ${dirRel} test` : 'deno task test'
      if (tasks.check) cmdObj.fullTest = dirRel ? `deno task --cwd ${dirRel} check` : 'deno task check'
      if (tasks.lint) cmdObj.lint = dirRel ? `deno task --cwd ${dirRel} lint` : 'deno task lint'
      if (tasks.build) cmdObj.build = dirRel ? `deno task --cwd ${dirRel} build` : 'deno task build'
      if (Object.keys(cmdObj).length > 0) bucket.commands.deno = cmdObj
    }
  }
  if (bucket.ecosystems.has('java')) {
    const hasMvn = existsSync(join(absDir, 'pom.xml'))
    const hasGradle = existsSync(join(absDir, 'build.gradle')) || existsSync(join(absDir, 'build.gradle.kts'))
    if (hasMvn) {
      const bin = resolveJavaWrapper(absDir, repoRoot, dirRel, 'mvnw', 'mvnw.cmd', 'mvn')
      const fileFlag = dirRel ? ` -f ${dirRel}/pom.xml` : ''
      const hasSrcTest = existsSync(join(absDir, 'src', 'test'))
      bucket.commands.java = { quickTest: `${bin}${fileFlag} test`, build: `${bin}${fileFlag} package -DskipTests`, hasSrcTest }
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
    bucket.commands.go = {
      quickTest: dirRel ? `go -C ${dirRel} test ./...` : 'go test ./...',
      build: dirRel ? `go -C ${dirRel} build ./...` : 'go build ./...',
    }
  }
  if (bucket.ecosystems.has('dotnet')) {
    const isTest = isDotnetTestProject(absDir, dirRel)
    bucket.commands.dotnet = {
      ...(isTest ? { quickTest: dirRel ? `dotnet test ${dirRel}` : 'dotnet test' } : {}),
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
}
