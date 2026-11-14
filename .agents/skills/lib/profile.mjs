/**
 * profile.mjs —— 唯一权威的 AGENTS.md Dev Profile 解析器、取舍读取与动态多生态包清单发现。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），替代全套件多份重复解析器。
 * 严格保留显式填写的 `none` 禁用态，绝不回退猜测命令或默认高风险路径覆盖用户声明。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, posix as pathPosix, relative } from 'node:path'

import { DEFAULT_WALK_SKIP_DIRS, isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe } from './git.mjs'

export const DEV_PROFILE_KEYS = Object.freeze([
  'quick-test',
  'full-test',
  'smoke-verify',
  'merge-gate',
  'arch-rules',
  'high-risk',
  'do-not-edit',
])

const EXPLICIT_NONE_RE = /^(?:none|\(none\)|null|n\/a|无|\(无\)|暂无|-)$/i

function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`'))
    || (s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
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
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trim()
    }
  }
  return s.trim()
}

function isAnglePlaceholder(val) {
  const s = stripWrapQuotes(val)
  return !s || /^<[^>\n]+>$/.test(s) || /^<!--/.test(s)
}

function isExplicitNoneValue(val) {
  const s = stripWrapQuotes(val)
  return EXPLICIT_NONE_RE.test(s)
}

function isPlaceholderVal(val) {
  return isAnglePlaceholder(val) || isExplicitNoneValue(val)
}

function parseListValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /^\[?\s*\]?$/.test(s)) return []
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  return inner.split(/[,，]/)
    .map((x) => stripWrapQuotes(x))
    .filter((x) => x && !isPlaceholderVal(x))
}

function parseArchRuleItem(rawRule) {
  if (rawRule && typeof rawRule === 'object') {
    const rawFrom = rawRule.fromGlob ?? rawRule.from
    const rawTo = rawRule.toGlob ?? rawRule.to
    if (!rawFrom || !rawTo) return null
    const from = stripWrapQuotes(rawFrom)
    const to = stripWrapQuotes(rawTo)
    if (isPlaceholderVal(from) || isPlaceholderVal(to)) return null
    return { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` }
  }
  const s = stripWrapQuotes(String(rawRule ?? ''))
  if (!s || isPlaceholderVal(s)) return null
  const m = /^(.+?)\s*(?:->|→)\s*(.+)$/.exec(s)
  if (!m) return null
  const from = stripWrapQuotes(m[1])
  const to = stripWrapQuotes(m[2])
  if (isPlaceholderVal(from) || isPlaceholderVal(to)) return null
  return { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` }
}

/** 从 AGENTS.md 的「## 取舍」节读出已表态键值映射，返回 `Map<id, value>`。 */
export function readDecisionMap(agentsText) {
  const map = new Map()
  if (typeof agentsText !== 'string') return map
  const lines = agentsText.replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  for (const line of lines) {
    if (/^##\s+取舍(?:\s|$|[（(:：])/.test(line.trim())) { inSection = true; continue }
    if (inSection && /^#{1,2}\s+/.test(line)) break
    if (!inSection) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('>') || trimmed.startsWith('```')) continue
    const m = /^\s*(?:[-*]\s*)?`?([a-z][a-z0-9._-]*)`?\s*[:：]\s*(.*)$/.exec(line)
    if (m) map.set(m[1], m[2].trim())
  }
  return map
}

/** 从 AGENTS.md 的「## 取舍」节读出已表态的决定，返回 `Set<id>`。 */
export function readDecisions(agentsText) {
  return new Set(readDecisionMap(agentsText).keys())
}

function hasDecisionKey(decisions, agentsText, key) {
  if (decisions instanceof Set) return decisions.has(key)
  if (decisions instanceof Map) return decisions.has(key)
  if (Array.isArray(decisions)) return decisions.includes(key)
  if (typeof decisions === 'string') return readDecisions(decisions).has(key)
  if (agentsText) return readDecisions(agentsText).has(key)
  return false
}

function resolveDecisionValue(decisions, agentsText, key) {
  if (decisions instanceof Map) return decisions.get(key) ?? null
  if (typeof decisions === 'string') return readDecisionMap(decisions).get(key) ?? null
  if (agentsText) return readDecisionMap(agentsText).get(key) ?? null
  return null
}

/**
 * 按项目实际优先识别权威架构文档路径：
 *   1. `AGENTS.md`「## 取舍」显式声明的 `tdd-authority`（且文件真实存在）；
 *   2. 声明 `no-tdd` 时返回 `null`（合法豁免）；
 *   3. 依次检查 `docs/TDD.md`、`*-TDD.md`、`ARCHITECTURE.md`、`docs/architecture.md`、
 *      `docs/design/README.md` 等既有架构文档。
 */
export function resolveAuthoritativeTddPath(repoRoot, decisions = null) {
  const agentsText = (decisions instanceof Map || typeof decisions === 'string')
    ? (typeof decisions === 'string' ? decisions : null)
    : readTextSafe(join(repoRoot, 'AGENTS.md'))

  if (hasDecisionKey(decisions, agentsText, 'tdd-authority')) {
    const rawVal = resolveDecisionValue(decisions, agentsText ?? readTextSafe(join(repoRoot, 'AGENTS.md')), 'tdd-authority')
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const m = /`([^`\n]+\.mdx?)`/i.exec(rawVal)
        ?? /(?:^|\s)([A-Za-z0-9_./-]+\.mdx?)(?=\s|$|[，。；,;])/i.exec(rawVal)
      if (m) {
        const rel = posixPath(m[1].trim()).replace(/^\.\//, '')
        if (rel && !rel.includes('..') && existsSync(join(repoRoot, rel))) return rel
      }
    }
  }

  if (hasDecisionKey(decisions, agentsText, 'no-tdd')) return null

  const fixedCandidates = [
    'docs/TDD.md',
    'docs/tdd.md',
    'TDD.md',
    'tdd.md',
  ]
  for (const rel of fixedCandidates) {
    if (existsSync(join(repoRoot, rel))) return rel
  }

  for (const dirRel of ['', 'docs']) {
    const absDir = dirRel ? join(repoRoot, dirRel) : repoRoot
    if (!existsSync(absDir)) continue
    let names = []
    try { names = readdirSync(absDir).filter((n) => !isMacOsJunkPath(n)).sort() } catch { continue }
    for (const name of names) {
      if (/(?:-|_)tdd\.md$/i.test(name)) {
        return dirRel ? `${dirRel}/${name}` : name
      }
    }
  }

  const archCandidates = [
    'ARCHITECTURE.md',
    'architecture.md',
    'docs/ARCHITECTURE.md',
    'docs/architecture.md',
    'DESIGN.md',
    'design.md',
    'docs/DESIGN.md',
    'docs/design.md',
    'docs/architecture/README.md',
    'docs/design/README.md',
  ]
  for (const rel of archCandidates) {
    if (existsSync(join(repoRoot, rel))) return rel
  }

  for (const subRel of ['docs/architecture', 'docs/design']) {
    const subAbs = join(repoRoot, subRel)
    if (!existsSync(subAbs)) continue
    try {
      const md = readdirSync(subAbs, { withFileTypes: true })
        .filter((e) => e.isFile() && !isMacOsJunkPath(e.name) && /\.(?:md|mdx)$/i.test(e.name))
        .map((e) => e.name)
        .sort()
      if (md.length > 0) return `${subRel}/${md[0]}`
    } catch { /* ignore */ }
  }

  return null
}

function extractDevProfileLines(agentsText) {
  const norm = String(agentsText ?? '').replace(/\r\n/g, '\n')
  const beginMarker = /<!--\s*project-forge:\s*begin\s+Dev Profile\s*-->/.exec(norm)
  const endMarker = beginMarker
    ? /<!--\s*project-forge:\s*end\s+Dev Profile\s*-->/.exec(norm.slice(beginMarker.index + beginMarker[0].length))
    : null
  if (beginMarker && endMarker) {
    const slice = norm.slice(beginMarker.index + beginMarker[0].length, beginMarker.index + beginMarker[0].length + endMarker.index)
    return slice.split('\n')
  }

  const lines = norm.split('\n')
  const secIdx = lines.findIndex((l) => /^##\s+Dev Profile\b/i.test(l.trim()))
  if (secIdx >= 0) {
    const out = []
    for (let i = secIdx + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i].trim())) break
      out.push(lines[i])
    }
    return out
  }

  // 无显式 `## Dev Profile` 标题时（如精简测试夹具），优先仅提取 yaml 代码块，否则提取非围栏行
  const yamlBlocks = [...norm.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)]
  if (yamlBlocks.length > 0) {
    return yamlBlocks.flatMap((m) => m[1].split('\n'))
  }

  const fallbackLines = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence) fallbackLines.push(line)
  }
  return fallbackLines
}

/** 查询某 Dev Profile 键是否被用户显式设为 `none`。 */
export function isProfileExplicitNone(profile, key) {
  if (!profile?.explicitNone) return false
  if (profile.explicitNone instanceof Set) return profile.explicitNone.has(key)
  if (Array.isArray(profile.explicitNone)) return profile.explicitNone.includes(key)
  return false
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
        if (!DEFAULT_WALK_SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        hits.push(rel)
      }
    }
  }
  return hits
}

const MANIFEST_BASENAMES = new Set([
  'package.json', 'pnpm-workspace.yaml',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'gradlew',
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
    ? (pm === 'npm' ? ` --prefix ${dirRel}` : pm === 'pnpm' ? ` --dir ${dirRel}` : pm === 'yarn' ? ` --cwd ${dirRel}` : '')
    : ''
  const wrapDir = (subCmd) => {
    if (!dirRel) return subCmd
    if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn') return `${pm}${prefixArg} ${subCmd}`
    return `(cd ${dirRel} && ${pm} ${subCmd})`
  }
  const scripts = pkg.scripts ?? {}
  let quickTest
  let fullTest
  let lint
  let build
  if (scripts.test && !/no test specified/i.test(String(scripts.test))) {
    quickTest = wrapDir('test')
  }
  if (scripts.check) fullTest = wrapDir(pm === 'npm' ? 'run check' : 'check')
  else if (scripts.verify) fullTest = wrapDir(pm === 'npm' ? 'run verify' : 'verify')
  else if (scripts.ci) fullTest = wrapDir(pm === 'npm' ? 'run ci' : 'ci')
  if (scripts.lint) lint = wrapDir(pm === 'npm' ? 'run lint' : 'lint')
  if (scripts.build) build = wrapDir(pm === 'npm' ? 'run build' : 'build')
  return {
    name: pkg.name ?? (dirRel || 'root'),
    scripts: Object.keys(scripts),
    pm,
    quickTest,
    fullTest,
    lint,
    build,
  }
}

/**
 * 动态发现全仓库多语言包清单与任务入口（无深度限制，支持 Java/React 前后端分离、
 * Apple `Package.swift`/`*.xcodeproj`、Python `uv`/`poetry`、Rust/Go/C#/C++/Taskfile）。
 */
export function discoverWorkspacePackages(repoRoot, fileRelList = null) {
  const files = Array.isArray(fileRelList) ? fileRelList : collectManifestFilesSync(repoRoot)
  const relevant = files.filter((rel) => !isMacOsJunkPath(rel) && isInterestingManifestRel(rel))

  const rootPm = existsSync(join(repoRoot, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(repoRoot, 'yarn.lock')) ? 'yarn'
      : existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb')) ? 'bun' : 'npm'

  const byDir = new Map()
  const ensureDir = (dirRel) => {
    const key = dirRel === '.' ? '' : dirRel
    if (!byDir.has(key)) {
      byDir.set(key, {
        dirRel: key,
        ecosystems: new Set(),
        manifests: [],
        lockfiles: [],
        commands: {},
      })
    }
    return byDir.get(key)
  }

  for (const rel of relevant) {
    const base = pathPosix.basename(rel)
    const dirRel = pathPosix.dirname(rel) === '.' ? '' : pathPosix.dirname(rel)
    const bucket = ensureDir(dirRel)
    if (LOCKFILE_ONLY_NAMES.has(base) || /^requirements.*\.txt$/i.test(base)) {
      bucket.lockfiles.push(base)
    }
    if (!LOCKFILE_ONLY_NAMES.has(base)) {
      bucket.manifests.push(base)
    }

    if (base === 'package.json') bucket.ecosystems.add('node')
    else if (['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'Pipfile', 'uv.lock', 'poetry.lock', 'Pipfile.lock'].includes(base) || /^requirements.*\.txt$/i.test(base)) {
      bucket.ecosystems.add('python')
    } else if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mvnw', 'gradlew', 'gradle.lockfile'].includes(base)) {
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
      if (nodeInfo) {
        bucket.name = nodeInfo.name
        bucket.commands.node = nodeInfo
      }
    }
    if (bucket.ecosystems.has('java')) {
      const hasMvn = existsSync(join(absDir, 'pom.xml'))
      const hasGradle = existsSync(join(absDir, 'build.gradle')) || existsSync(join(absDir, 'build.gradle.kts'))
      const hasMvnw = existsSync(join(absDir, 'mvnw')) || existsSync(join(repoRoot, 'mvnw'))
      const hasGradlew = existsSync(join(absDir, 'gradlew')) || existsSync(join(repoRoot, 'gradlew'))
      if (hasMvn) {
        const bin = hasMvnw ? (existsSync(join(absDir, 'mvnw')) ? `./${dirRel ? `${dirRel}/` : ''}mvnw` : './mvnw') : 'mvn'
        const fileFlag = dirRel ? ` -f ${dirRel}/pom.xml` : ''
        bucket.commands.java = { quickTest: `${bin}${fileFlag} test`, build: `${bin}${fileFlag} package -DskipTests` }
      } else if (hasGradle) {
        const bin = hasGradlew ? (existsSync(join(absDir, 'gradlew')) ? `./${dirRel ? `${dirRel}/` : ''}gradlew` : './gradlew') : 'gradle'
        const projFlag = dirRel ? ` -p ${dirRel}` : ''
        bucket.commands.java = { quickTest: `${bin}${projFlag} test`, build: `${bin}${projFlag} build -x test` }
      }
    }
    if (bucket.ecosystems.has('python')) {
      const pyWrap = existsSync(join(absDir, 'uv.lock')) || existsSync(join(repoRoot, 'uv.lock'))
        ? 'uv run pytest'
        : (existsSync(join(absDir, 'poetry.lock')) || existsSync(join(repoRoot, 'poetry.lock')) ? 'poetry run pytest' : 'pytest')
      const hasTests = existsSync(join(absDir, 'tests')) || existsSync(join(absDir, 'test')) || existsSync(join(absDir, 'pytest.ini'))
      if (hasTests) {
        const cmd = dirRel ? `(cd ${dirRel} && ${pyWrap})` : pyWrap
        bucket.commands.python = { quickTest: cmd }
      }
    }
    if (bucket.ecosystems.has('rust') && existsSync(join(absDir, 'Cargo.toml'))) {
      const mf = dirRel ? ` --manifest-path ${dirRel}/Cargo.toml` : ''
      bucket.commands.rust = { quickTest: `cargo test${mf}`, build: `cargo build${mf}` }
    }
    if (bucket.ecosystems.has('go') && (existsSync(join(absDir, 'go.mod')) || existsSync(join(absDir, 'go.work')))) {
      const cmd = dirRel ? `(cd ${dirRel} && go test ./...)` : 'go test ./...'
      const build = dirRel ? `(cd ${dirRel} && go build ./...)` : 'go build ./...'
      bucket.commands.go = { quickTest: cmd, build }
    }
    if (bucket.ecosystems.has('dotnet')) {
      const cmd = dirRel ? `dotnet test ${dirRel}` : 'dotnet test'
      bucket.commands.dotnet = { quickTest: cmd, build: dirRel ? `dotnet build ${dirRel}` : 'dotnet build' }
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

/** 从全仓库清单嗅探测试与门禁命令，作为 Dev Profile 缺失时的安全兜底。 */
export function detectEcosystemCommands(repoRoot) {
  const discovery = discoverWorkspacePackages(repoRoot)
  const quickList = []
  const fullList = []
  const lintList = []
  const buildList = []
  const pushUnique = (arr, v) => {
    if (v && !arr.includes(v)) arr.push(v)
  }

  for (const pkg of discovery.packages) {
    for (const c of Object.values(pkg.commands)) {
      pushUnique(quickList, c.quickTest)
      pushUnique(fullList, c.fullTest)
      pushUnique(lintList, c.lint)
      pushUnique(buildList, c.build)
    }
  }

  const makefile = readTextSafe(join(repoRoot, 'Makefile')) ?? readTextSafe(join(repoRoot, 'GNUmakefile'))
  if (makefile) {
    if (/^test:/m.test(makefile)) pushUnique(quickList, 'make test')
    if (/^check:/m.test(makefile)) pushUnique(fullList, 'make check')
  }
  const justfile = readTextSafe(join(repoRoot, 'justfile')) ?? readTextSafe(join(repoRoot, 'Justfile'))
  if (justfile) {
    if (/^test(?:\s+[^:\n]*)?:/m.test(justfile)) pushUnique(quickList, 'just test')
    if (/^check(?:\s+[^:\n]*)?:/m.test(justfile)) pushUnique(fullList, 'just check')
  }
  const taskfile = readTextSafe(join(repoRoot, 'Taskfile.yml')) ?? readTextSafe(join(repoRoot, 'Taskfile.yaml'))
  if (taskfile) {
    if (/^\s*test\s*:/m.test(taskfile)) pushUnique(quickList, 'task test')
    if (/^\s*check\s*:/m.test(taskfile)) pushUnique(fullList, 'task check')
  }

  // 仅当 test/ 目录真实包含 JS/TS 测试文件时才兜底 node --test，不误伤 Java/纯文档仓
  if (quickList.length === 0 && existsSync(join(repoRoot, 'test'))) {
    try {
      const hasJsTest = readdirSync(join(repoRoot, 'test')).some((n) => /\.(?:m?js|cjs|ts)$/i.test(n))
      if (hasJsTest) pushUnique(quickList, 'node --test')
    } catch { /* ignore */ }
  }

  return {
    quickTest: quickList.length > 0 ? quickList.join(' && ') : undefined,
    fullTest: fullList.length > 0 ? fullList.join(' && ') : undefined,
    lint: lintList.length > 0 ? lintList.join(' && ') : undefined,
    build: buildList.length > 0 ? buildList.join(' && ') : undefined,
    kinds: discovery.ecosystems,
    packages: discovery.packages,
  }
}

/**
 * 唯一权威 AGENTS.md Dev Profile 解析器：
 *   - 限定解析 `## Dev Profile` 区间（无标题时回退 yaml 围栏）；
 *   - 支持单行/多行 YAML 列表、`[a, b]`、`## 高风险路径` 表格与 `## 取舍`；
 *   - 严格将显式 `none` 记入 `explicitNone` 集合，绝不回退覆盖。
 */
export function parseAgentsProfile(repoRoot) {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  const text = readTextSafe(agentsPath)
  const explicitNone = new Set()
  const profile = {
    hasAgents: text !== undefined,
    quickTest: undefined,
    fullTest: undefined,
    smokeVerify: undefined,
    mergeGate: undefined,
    archRules: [],
    highRisk: [],
    doNotEdit: [],
    mergeAuthority: 'reviewer',
    explicitNone,
    decisions: new Set(),
  }

  if (text !== undefined) {
    profile.decisions = readDecisions(text)
    const scopedLines = extractDevProfileLines(text)
    let activeListKey = null

    for (let i = 0; i < scopedLines.length; i += 1) {
      const line = scopedLines[i]
      const trimmed = line.trim()
      if (/^(?:```|~~~)/.test(trimmed)) {
        activeListKey = null
        continue
      }

      if (activeListKey) {
        if (/^[-*]\s+/.test(trimmed) && /^\s+[-*]/.test(line)) {
          const item = stripWrapQuotes(stripInlineYamlComment(trimmed.replace(/^[-*]\s+/, '')))
          if (isExplicitNoneValue(item)) {
            explicitNone.add(activeListKey === 'highRisk' ? 'high-risk' : activeListKey === 'doNotEdit' ? 'do-not-edit' : 'arch-rules')
          } else if (item && !isAnglePlaceholder(item)) {
            if (activeListKey === 'archRules') {
              const parsed = parseArchRuleItem(item)
              if (parsed) profile.archRules.push(parsed)
            } else {
              profile[activeListKey].push(item)
            }
          }
          continue
        }
        if (trimmed !== '' && !trimmed.startsWith('#')) {
          activeListKey = null
        } else {
          continue
        }
      }

      const kv = /^(?:[-*]\s+)?`?(quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit)`?\s*:\s*(.*)$/i.exec(trimmed)
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const rawVal = stripInlineYamlComment(kv[2])

      if (key === 'quick-test' || key === 'full-test' || key === 'smoke-verify' || key === 'merge-gate') {
        const cleaned = stripWrapQuotes(rawVal)
        if (isExplicitNoneValue(cleaned)) {
          explicitNone.add(key)
          if (key === 'quick-test') profile.quickTest = undefined
          else if (key === 'full-test') profile.fullTest = undefined
          else if (key === 'smoke-verify') profile.smokeVerify = undefined
          else profile.mergeGate = undefined
        } else if (!isAnglePlaceholder(cleaned)) {
          if (key === 'quick-test') profile.quickTest = cleaned
          else if (key === 'full-test') profile.fullTest = cleaned
          else if (key === 'smoke-verify') profile.smokeVerify = cleaned
          else profile.mergeGate = cleaned
        }
        continue
      }

      const targetProp = key === 'high-risk' ? 'highRisk' : key === 'do-not-edit' ? 'doNotEdit' : 'archRules'
      if (rawVal === '') {
        activeListKey = targetProp
      } else if (isExplicitNoneValue(rawVal)) {
        explicitNone.add(key)
      } else if (targetProp === 'archRules') {
        for (const item of parseListValue(rawVal)) {
          const parsed = parseArchRuleItem(item)
          if (parsed) profile.archRules.push(parsed)
        }
      } else {
        for (const item of parseListValue(rawVal)) {
          profile[targetProp].push(item)
        }
      }
    }

    if (profile.highRisk.length === 0 && !explicitNone.has('high-risk')) {
      const fullLines = text.split('\n')
      const hrStart = fullLines.findIndex((l) => /^##\s+高风险路径/.test(l))
      if (hrStart >= 0) {
        for (let i = hrStart + 1; i < fullLines.length; i += 1) {
          if (/^##\s+/.test(fullLines[i])) break
          const row = /^\|\s*`([^`]+)`\s*\|/.exec(fullLines[i].trim())
          if (row && !isPlaceholderVal(row[1])) profile.highRisk.push(row[1].trim())
        }
      }
    }

    if (/merge-authority\s*:\s*human/i.test(text)) {
      profile.mergeAuthority = 'human'
    }
  }

  profile.highRisk = [...new Set(profile.highRisk)]
  profile.doNotEdit = [...new Set(profile.doNotEdit)]
  const seenRules = new Set()
  profile.archRules = profile.archRules.filter((r) => {
    if (seenRules.has(r.raw)) return false
    seenRules.add(r.raw)
    return true
  })
  if (profile.highRisk.length === 0 && !explicitNone.has('high-risk')) {
    profile.highRisk = ['.github/workflows/', 'AGENTS.md']
  }

  const fallback = detectEcosystemCommands(repoRoot)
  if (!profile.quickTest && !explicitNone.has('quick-test')) profile.quickTest = fallback.quickTest
  if (!profile.fullTest && !explicitNone.has('full-test')) {
    profile.fullTest = fallback.fullTest ?? (!explicitNone.has('quick-test') ? fallback.quickTest : undefined)
  }
  if (!profile.mergeGate && !explicitNone.has('merge-gate')) {
    profile.mergeGate = profile.fullTest ?? (!explicitNone.has('quick-test') ? profile.quickTest : undefined)
  }
  profile.detectedCommands = fallback
  return profile
}

/** 面向审查与审计脚本的键值对数组视图（与 parseAgentsProfile 单源同构）。 */
export function parseDevProfile(repoRoot) {
  const p = parseAgentsProfile(repoRoot)
  return {
    'quick-test': p.quickTest ? [p.quickTest] : [],
    'full-test': p.fullTest ? [p.fullTest] : [],
    'smoke-verify': p.smokeVerify ? [p.smokeVerify] : [],
    'merge-gate': p.mergeGate ? [p.mergeGate] : [],
    'arch-rules': p.archRules.map((r) => r.raw),
    'high-risk': [...p.highRisk],
    'do-not-edit': [...p.doNotEdit],
    explicitNone: p.explicitNone,
    mergeAuthority: p.mergeAuthority,
  }
}
