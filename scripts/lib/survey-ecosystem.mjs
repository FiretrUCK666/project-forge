/**
 * survey-ecosystem.mjs —— 生态清单识别、通用任务入口与工作区多包/产物探测。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  discoverWorkspacePackages,
  hasDotnetMinVer,
  isDotnetTestProject,
  parseYamlWorkspaceGlobs,
  readDenoOrJsrManifest,
  resolveNodePackageManager,
  scanDeclaredTaskRunners,
  scanNeutralCiSteps,
} from '../../kit/skills/lib/profile-sniffer.mjs'
import { BROAD_CODE_EXT_RE, COMMON_OUTPUT_DIRS, matchGlobList } from '../../kit/skills/lib/git-core.mjs'
import { summarizeSkillDescription } from '../../kit/skills/lib/skill-discovery.mjs'
import { classifyCommandText, COMMAND_DISPLAY_MAX_BYTES, truncateCommandForDisplay } from '../../kit/skills/lib/command-lex.mjs'
import { COMMON_SKIP_DIRS } from './protocol.mjs'
import { isMacMetadataName, isMacMetadataPath, readJsonSafe, readTextSafe } from './text.mjs'
import { normalizeDeclaredRepo } from '../../kit/skills/lib/platform.mjs'

export const SKIP_DIRS = COMMON_SKIP_DIRS

export function isVendoredOrEmbeddedPackageDir(dirRel) {
  const norm = String(dirRel ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!norm) return false
  return norm.split('/').some((seg) => seg === 'vendor' || seg === 'third_party')
    || /(?:^|\/)vscode-web\/extensions(?:\/|$)/i.test(norm)
}

export const OUTPUT_DIRS = new Set([...COMMON_OUTPUT_DIRS, 'bin'])

export const CODE_EXT = BROAD_CODE_EXT_RE

export const TEXT_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rs|go|java|kt|kts|scala|c|cc|cpp|h|hpp|m|mm|cs|rb|php|sh|bash|zsh|ps1|lua|r|swift|dart|ex|exs|clj|hs|erl|jl|zig|sol|sql|proto|md|mdx|txt|rst|ya?ml|json|toml|html|css|scss|svg)$/i

export const DOC_EXT = /\.(?:md|mdx|txt|rst)$/i

function tomlString(text, key) {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)?.[1]
}

function cleanReaddir(dir) {
  try {
    return readdirSync(dir).filter((name) => !isMacMetadataName(name))
  } catch {
    return []
  }
}

export function hasSuffix(root, suffix) {
  return cleanReaddir(root).some((name) => name.endsWith(suffix))
}

export function findSuffix(root, suffix) {
  return cleanReaddir(root).sort().find((name) => name.endsWith(suffix))
}

export function hasPrefix(root, prefix, suffix) {
  return cleanReaddir(root).some((name) => name.startsWith(prefix) && name.endsWith(suffix))
}

function gradleTestEvidence(root) {
  if (existsSync(join(root, 'src', 'test'))) return true
  for (const rel of ['build.gradle', 'build.gradle.kts']) {
    const text = readTextSafe(join(root, rel)) ?? ''
    if (/useJUnit|useTestNG|enableTest|tasks\.test|test\s*\{/.test(text)) return true
  }
  return false
}

function cmakeHasTests(root) {
  const text = readTextSafe(join(root, 'CMakeLists.txt')) ?? ''
  if (/enable_testing\s*\(|add_test\s*\(|include\s*\(\s*CTest/.test(text)) return true
  return existsSync(join(root, 'tests')) || existsSync(join(root, 'test'))
}

function hasRakeTestTarget(root) {
  const text = readTextSafe(join(root, 'Rakefile')) ?? ''
  return /^\s*task\s+:test\b|^\s*desc\s+.{0,80}\btest\b/m.test(text) || /^\s*task\s+default:/m.test(text)
}

function hasPytestEvidence(root) {
  for (const rel of ['pytest.ini', 'tox.ini', 'conftest.py']) {
    if (existsSync(join(root, rel))) return true
  }
  for (const rel of ['pyproject.toml', 'setup.cfg']) {
    const text = readTextSafe(join(root, rel)) ?? ''
    if (/\[tool\.pytest|\[tool:pytest\]/.test(text)) return true
  }
  for (const dir of ['tests', 'test']) {
    if (existsSync(join(root, dir))) return true
  }
  return hasSuffix(root, '_test.py') || hasPrefix(root, 'test_', '.py')
}

function listXcodeSchemes(containerPath) {
  const schemesDir = join(containerPath, 'xcshareddata', 'xcschemes')
  if (!existsSync(schemesDir)) return []
  return cleanReaddir(schemesDir)
    .filter((f) => f.endsWith('.xcscheme'))
    .map((f) => f.replace(/\.xcscheme$/, ''))
}

export const ECOSYSTEMS = [
  {
    kind: 'node',
    manifest: () => 'package.json',
    detect: (root) => existsSync(join(root, 'package.json')),
    read: (root, s) => {
      const pkg = readJsonSafe(join(root, 'package.json'))
      if (!pkg) return
      if (typeof pkg.name === 'string' && pkg.name.trim()) s.projectName = pkg.name.trim().replace(/^@[^/]+\//, '')
      if (typeof pkg.version === 'string') s.declaredVersion = pkg.version.trim()
      if (pkg.private === true) s.private = true
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      if (repo) s.declaredRepo = normalizeDeclaredRepo(repo)
      s.packageManager = s._inheritedPackageManager
        && !existsSync(join(root, 'pnpm-lock.yaml'))
        && !existsSync(join(root, 'yarn.lock'))
        && !existsSync(join(root, 'bun.lock'))
        && !existsSync(join(root, 'bun.lockb'))
        && !existsSync(join(root, 'package-lock.json'))
        ? s._inheritedPackageManager
        : resolveNodePackageManager(root, pkg)
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
      s.packageScripts = [...new Set([...(s.packageScripts ?? []), ...Object.keys(scripts)])]
      const runPrefix = s.packageManager === 'npm' ? 'npm run' : s.packageManager
      s.commands.install = s.packageManager === 'npm' && existsSync(join(root, 'package-lock.json'))
        ? 'npm ci' : `${s.packageManager} install`
      if (scripts.build) s.commands.build = `${runPrefix} build`
      if (scripts.typecheck) s.commands.typecheck = `${runPrefix} typecheck`
      if (scripts.lint) s.commands.lint = `${runPrefix} lint`
      if (scripts.test && !/no test specified/.test(String(scripts.test))) {
        s.commands.test = s.packageManager === 'npm' ? 'npm test' : `${s.packageManager} test`
      }
      if (scripts.check) s.commands.verify = `${runPrefix} check`
      else if (scripts.verify) s.commands.verify = `${runPrefix} verify`
      if (!s.private && typeof pkg.name === 'string' && typeof pkg.version === 'string') s.publishable = true
      if (pkg.engines?.node) s.runtimeRequirements.push(`Node ${pkg.engines.node}`)
    },
  },
  {
    kind: 'python',
    manifest: (root) => (existsSync(join(root, 'pyproject.toml')) ? 'pyproject.toml'
      : existsSync(join(root, 'requirements.txt')) ? 'requirements.txt' : 'setup.py'),
    detect: (root) => existsSync(join(root, 'pyproject.toml'))
      || existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'setup.py')),
    read: (root, s) => {
      const pyproject = join(root, 'pyproject.toml')
      if (existsSync(pyproject)) {
        const text = readTextSafe(pyproject) ?? ''
        const name = tomlString(text, 'name')
        const version = tomlString(text, 'version')
        if (name) s.projectName = name
        if (version && !s.declaredVersion) s.declaredVersion = version
        if (/\[build-system\]/.test(text) && name) s.publishable = true
        const requires = tomlString(text, 'requires-python')
        if (requires) s.runtimeRequirements.push(`Python ${requires}`)
        const urls = /\[project\.urls\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? ''
        if (!s.declaredRepo) {
          for (const key of ['Repository', 'Source', 'Homepage', 'Home']) {
            const value = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mi').exec(urls)?.[1]
            const repo = normalizeDeclaredRepo(value)
            if (repo) { s.declaredRepo = repo; break }
          }
        }
      }
      if (!s.declaredRepo && existsSync(join(root, 'setup.py'))) {
        const text = readTextSafe(join(root, 'setup.py')) ?? ''
        s.declaredRepo = normalizeDeclaredRepo(/url\s*=\s*["']([^"']+)["']/.exec(text)?.[1])
      }
      if (existsSync(join(root, 'uv.lock'))) s.commands.install ??= 'uv sync'
      else if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
        s.commands.install ??= 'pip install -e .'
      } else if (existsSync(join(root, 'requirements.txt'))) {
        s.commands.install ??= 'pip install -r requirements.txt'
      }
      if (hasPytestEvidence(root)) {
        const venvSub = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python']
        const venvPy = existsSync(join(root, ...venvSub)) ? venvSub.join(process.platform === 'win32' ? '\\' : '/') : null
        s.commands.test ??= venvPy ? `${venvPy} -m pytest` : 'pytest'
      }
    },
  },
  {
    kind: 'rust',
    manifest: () => 'Cargo.toml',
    detect: (root) => existsSync(join(root, 'Cargo.toml')),
    read: (root, s) => {
      const text = readTextSafe(join(root, 'Cargo.toml')) ?? ''
      const name = tomlString(text, 'name')
      const version = tomlString(text, 'version')
      if (name) s.projectName = name
      if (version && !s.declaredVersion) s.declaredVersion = version
      if (/publish\s*=\s*false/.test(text)) s.private = true
      else if (name && version) s.publishable = true
      const rustVersion = tomlString(text, 'rust-version')
      if (rustVersion) s.runtimeRequirements.push(`Rust ${rustVersion}`)
      if (!s.declaredRepo) s.declaredRepo = normalizeDeclaredRepo(tomlString(text, 'repository'))
      s.commands.build ??= 'cargo build'
      s.commands.test ??= 'cargo test'
      s.commands.lint ??= 'cargo clippy -- -D warnings'
    },
  },
  {
    kind: 'go',
    manifest: () => 'go.mod',
    detect: (root) => existsSync(join(root, 'go.mod')),
    read: (root, s) => {
      const text = readTextSafe(join(root, 'go.mod')) ?? ''
      const mod = /^module\s+(\S+)/m.exec(text)?.[1]
      if (mod) {
        s.projectName = mod.split('/').pop() || s.projectName
        s.declaredRepo ??= normalizeDeclaredRepo(mod)
        s.registryFree = true
      }
      const goVer = /^go\s+(\S+)/m.exec(text)?.[1]
      if (goVer) s.runtimeRequirements.push(`Go ${goVer}`)
      s.commands.build ??= 'go build ./...'
      s.commands.test ??= 'go test ./...'
    },
  },
  {
    kind: 'java',
    manifest: (root) => (existsSync(join(root, 'pom.xml')) ? 'pom.xml' : 'build.gradle'),
    detect: (root) => existsSync(join(root, 'pom.xml')) || existsSync(join(root, 'build.gradle'))
      || existsSync(join(root, 'build.gradle.kts')),
    read: (root, s) => {
      if (existsSync(join(root, 'pom.xml'))) {
        const hasMvnw = existsSync(join(root, 'mvnw')) || existsSync(join(root, 'mvnw.cmd'))
        const mvn = hasMvnw ? (process.platform === 'win32' && existsSync(join(root, 'mvnw.cmd')) && !existsSync(join(root, 'mvnw')) ? 'mvnw.cmd' : './mvnw') : 'mvn'
        s.commands.build ??= `${mvn} -B package`
        if (existsSync(join(root, 'src', 'test')) || hasSuffix(root, '.java')) s.commands.test ??= `${mvn} -B test`
        s.publishable = true
        return
      }
      const hasUnixW = existsSync(join(root, 'gradlew'))
      const hasWinW = existsSync(join(root, 'gradlew.bat'))
      const gradle = hasUnixW || hasWinW
        ? (process.platform === 'win32' && hasWinW && !hasUnixW ? 'gradlew.bat' : './gradlew')
        : 'gradle'
      s.commands.build ??= `${gradle} build`
      if (gradleTestEvidence(root)) s.commands.test ??= `${gradle} test`
    },
  },
  {
    kind: 'ruby',
    manifest: () => 'Gemfile',
    detect: (root) => existsSync(join(root, 'Gemfile')) || hasSuffix(root, '.gemspec'),
    read: (root, s) => {
      s.commands.install ??= 'bundle install'
      if (existsSync(join(root, 'Rakefile')) && hasRakeTestTarget(root)) {
        s.commands.test ??= 'bundle exec rake test'
      } else if (existsSync(join(root, 'spec')) || hasSuffix(root, '_spec.rb')) {
        s.commands.test ??= 'bundle exec rspec'
      }
      if (hasSuffix(root, '.gemspec')) s.publishable = true
    },
  },
  {
    kind: 'php',
    manifest: () => 'composer.json',
    detect: (root) => existsSync(join(root, 'composer.json')),
    read: (root, s) => {
      const c = readJsonSafe(join(root, 'composer.json'))
      if (c?.name) s.projectName = c.name
      s.commands.install ??= 'composer install'
      if (c?.name) s.publishable = true
      const candidates = [
        typeof c?.repository === 'string' ? c.repository : c?.repository?.url,
        typeof c?.homepage === 'string' ? c.homepage : undefined,
      ]
      if (!s.declaredRepo) {
        for (const candidate of candidates) {
          const repo = normalizeDeclaredRepo(candidate)
          if (repo) { s.declaredRepo = repo; break }
        }
      }
    },
  },
  {
    kind: 'deno',
    manifest: (root) => readDenoOrJsrManifest(root)?.primaryManifest ?? 'deno.json',
    detect: (root) => Boolean(readDenoOrJsrManifest(root)),
    read: (root, s) => {
      const info = readDenoOrJsrManifest(root)
      if (!info) return
      for (const mf of info.manifests) if (!s.manifests.includes(mf)) s.manifests.push(mf)
      if (info.name) s.projectName = info.name.replace(/^@[^/]+\//, '')
      if (info.version && !s.declaredVersion) s.declaredVersion = info.version
      if (info.exports !== undefined) s.exports = info.exports
      if (info.publishable) { s.publishable = true; s.private = false }
      const tasks = info.tasks ?? {}
      if (tasks.test) s.commands.test ??= 'deno task test'
      else if (hasSuffix(root, '_test.ts') || hasSuffix(root, '.test.ts')) s.commands.test ??= 'deno test'
      if (tasks.check) s.commands.verify ??= 'deno task check'
      if (tasks.lint) s.commands.lint ??= 'deno task lint'
      if (tasks.build) s.commands.build ??= 'deno task build'
    },
  },
  {
    kind: 'dotnet',
    manifest: (root) => findSuffix(root, '.slnx') || findSuffix(root, '.sln') || '*.csproj',
    detect: (root) => hasSuffix(root, '.csproj') || hasSuffix(root, '.fsproj') || hasSuffix(root, '.vbproj')
      || hasSuffix(root, '.sln') || hasSuffix(root, '.slnx'),
    read: (root, s) => {
      s.commands.build ??= 'dotnet build'
      if (isDotnetTestProject(root, s._dirRel ?? '')) {
        s.commands.test ??= 'dotnet test'
      }
      if (hasDotnetMinVer(root, s._repoRoot ?? root)) {
        s.versionSource = 'MinVer (Git tag)'
      }
    },
  },
  {
    kind: 'cpp',
    manifest: (root) => (existsSync(join(root, 'CMakeLists.txt')) ? 'CMakeLists.txt' : 'meson.build'),
    detect: (root) => existsSync(join(root, 'CMakeLists.txt')) || existsSync(join(root, 'meson.build')),
    read: (root, s) => {
      if (existsSync(join(root, 'CMakeLists.txt'))) {
        s.commands.build ??= 'cmake -B build && cmake --build build'
        if (cmakeHasTests(root)) s.commands.test ??= 'ctest --test-dir build --output-on-failure'
      } else {
        s.commands.build ??= 'meson compile -C build'
        if (existsSync(join(root, 'test')) || existsSync(join(root, 'tests'))) {
          s.commands.test ??= 'meson test -C build'
        }
      }
    },
  },
  {
    kind: 'dart',
    manifest: () => 'pubspec.yaml',
    detect: (root) => existsSync(join(root, 'pubspec.yaml')),
    read: (root, s) => {
      s.commands.install ??= 'dart pub get'
      if (existsSync(join(root, 'test'))) s.commands.test ??= 'dart test'
      s.publishable = true
    },
  },
  {
    kind: 'swift',
    manifest: (root) => {
      if (existsSync(join(root, 'Package.swift'))) return 'Package.swift'
      return findSuffix(root, '.xcworkspace') || findSuffix(root, '.xcodeproj') || 'Package.swift'
    },
    detect: (root) => existsSync(join(root, 'Package.swift'))
      || hasSuffix(root, '.xcodeproj')
      || hasSuffix(root, '.xcworkspace'),
    read: (root, s) => {
      const hasPkg = existsSync(join(root, 'Package.swift'))
      const xcws = findSuffix(root, '.xcworkspace')
      const xcp = findSuffix(root, '.xcodeproj')
      if (xcws && !s.manifests.includes(xcws)) s.manifests.push(xcws)
      if (xcp && !s.manifests.includes(xcp)) s.manifests.push(xcp)

      if (hasPkg) {
        const text = readTextSafe(join(root, 'Package.swift')) ?? ''
        const ver = /swift-tools-version:\s*([0-9]+(?:\.[0-9]+)*)/i.exec(text)?.[1]
        if (ver) s.runtimeRequirements.push(`Swift ${ver}`)
        const pkgName = /name:\s*["']([^"']+)["']/.exec(text)?.[1]
        if (pkgName && !s.projectName) s.projectName = pkgName
        s.commands.build ??= 'swift build'
        if (existsSync(join(root, 'Tests')) || existsSync(join(root, 'Tests.swift'))) {
          s.commands.test ??= 'swift test'
        }
        return
      }

      const container = xcws || xcp
      if (container) {
        const schemes = listXcodeSchemes(join(root, container))
        if (schemes.length === 1) {
          const flag = xcws ? `-workspace "${xcws}"` : `-project "${xcp}"`
          s.commands.build ??= `xcodebuild ${flag} -scheme "${schemes[0]}" build`
        }
      }
    },
  },
  {
    kind: 'elixir',
    manifest: () => 'mix.exs',
    detect: (root) => existsSync(join(root, 'mix.exs')),
    read: (root, s) => {
      s.commands.install ??= 'mix deps.get'
      if (existsSync(join(root, 'test'))) s.commands.test ??= 'mix test'
    },
  },
]

export function isJunkFile(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  if (isMacMetadataPath(p)) return true
  if (/(^|\/)Thumbs\.db$/i.test(p)) return true
  if (/(^|\/)desktop\.ini$/i.test(p)) return true
  if (/(^|\/)\.(vscode|idea|fleet)\//.test(p)) return true
  return false
}

const PLUGIN_HINTS = [
  { kind: 'vscode-extension', marker: 'package.json', test: (root) => {
    const p = readJsonSafe(join(root, 'package.json'))
    return Boolean(p?.engines?.vscode || p?.contributes)
  } },
  { kind: 'obsidian-plugin', marker: 'manifest.json', test: (root) => {
    const m = readJsonSafe(join(root, 'manifest.json'))
    return Boolean(m && typeof m.id === 'string' && typeof m.minAppVersion === 'string')
  } },
  { kind: 'config-patch-plugin', marker: 'package.json', test: (root) => {
    const p = readJsonSafe(join(root, 'package.json'))
    return Boolean(
      p?.configPatch || p?.patchManifest || p?.pluginConfig
      || existsSync(join(root, 'plugin.patch.yml')) || existsSync(join(root, 'plugin.patch.yaml')),
    )
  } },
]

function extractSkillDescription(fmBody) {
  const lines = String(fmBody ?? '').replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const rest = m[1].trim()
    if (/^[|>][+-]?$/.test(rest) || rest === '') {
      const collected = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z0-9_-]+:\s*/.test(lines[j])) break
        if (!/^\s+/.test(lines[j]) && lines[j].trim() !== '') break
        const t = lines[j].trim()
        if (t) collected.push(t)
      }
      return collected.join(' ').trim() || undefined
    }
    return rest.replace(/^['"]|['"]$/g, '').trim() || undefined
  }
  return undefined
}

export function detectSkillKind(root) {
  for (const name of ['SKILL.md', 'skill.md']) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    const text = readTextSafe(p) ?? ''
    const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
    if (!fm) return { skillMeta: { hasValidFrontmatter: false, entry: name } }
    const nameValue = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
    const descValue = extractSkillDescription(fm[1])
    const summary = summarizeSkillDescription(descValue)
    const verValue = /^[ \t]+version:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(fm[1])?.[1]?.trim()
    const srcValue = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(fm[1])?.[1]?.trim()
    return {
      skillMeta: {
        hasValidFrontmatter: Boolean(nameValue && descValue),
        entry: name,
        name: nameValue,
        summary,
        version: verValue,
        source: srcValue,
      },
    }
  }
  return undefined
}

function scanSubdirectories(root, s, fileRelList = null) {
  const filteredFiles = Array.isArray(fileRelList) ? fileRelList.filter((rel) => !isVendoredOrEmbeddedPackageDir(rel)) : null
  const discovery = discoverWorkspacePackages(root, filteredFiles)
  for (const pkg of discovery.packages) {
    const dir = pkg.dirRel
    if (!dir || pkg.ecosystems.length === 0 || isVendoredOrEmbeddedPackageDir(dir)) continue
    const full = join(root, dir)
    if (!existsSync(full)) continue
    const sub = newEcosystemState()
    sub._inheritedPackageManager = s.packageManager
    sub._repoRoot = root
    sub._dirRel = dir
    scanEcosystemAt(full, sub, { name: dir })
    if (sub.kinds.length === 0) continue
    for (const kind of sub.kinds) if (!s.kinds.includes(kind)) s.kinds.push(kind)
    for (const name of sub.manifests) if (!s.manifests.includes(name)) s.manifests.push(name)
    if (sub.publishable) s.publishable = true
    if (sub.private) s.private = true
    if (sub.versionSource && !s.versionSource) s.versionSource = sub.versionSource
    if (Array.isArray(sub.packageScripts)) {
      s.packageScripts = [...new Set([...(s.packageScripts ?? []), ...sub.packageScripts])]
    }
    for (const req of sub.runtimeRequirements) {
      if (!s.runtimeRequirements.includes(req)) s.runtimeRequirements.push(req)
    }
    const mergedSubCmds = { ...sub.commands }
    for (const ecoCmd of Object.values(pkg.commands ?? {})) {
      if (ecoCmd.quickTest) mergedSubCmds.test = ecoCmd.quickTest
      if (ecoCmd.fullTest) mergedSubCmds.verify = ecoCmd.fullTest
      if (ecoCmd.lint) mergedSubCmds.lint = ecoCmd.lint
      if (ecoCmd.build) mergedSubCmds.build = ecoCmd.build
    }
    s.subdirs.push({ dir, kinds: sub.kinds, commands: mergedSubCmds })
    for (const [key, value] of Object.entries(mergedSubCmds)) {
      if (s.commands[key] === undefined) s.commands[key] = value
    }
    if (Object.keys(mergedSubCmds).length > 0) s.commandsByEcosystem[dir] = mergedSubCmds
  }
}

function newEcosystemState() {
  return {
    projectName: undefined, kinds: [], manifests: [], commands: {}, commandsByEcosystem: {},
    runtimeRequirements: [], publishable: false, private: false, registryFree: false,
    declaredVersion: undefined, versionSource: undefined, exports: undefined,
    declaredRepo: undefined, packageManager: undefined, packageScripts: undefined,
    skillMeta: undefined, subdirs: [],
  }
}

function scanEcosystemAt(root, s, { name } = {}) {
  if (s.projectName === undefined) s.projectName = name ?? basename(root)
  for (const row of ECOSYSTEMS) {
    if (!row.detect(root)) continue
    s.kinds.push(row.kind)
    if (row.manifest) {
      const manifest = row.manifest(root)
      if (manifest && !s.manifests.includes(manifest)) s.manifests.push(manifest)
    }
    const scoped = {}
    const merged = s.commands
    s.commands = scoped
    try {
      row.read(root, s)
    } finally {
      s.commands = merged
    }
    for (const [key, value] of Object.entries(scoped)) {
      if (merged[key] === undefined) merged[key] = value
    }
    if (Object.keys(scoped).length > 0) s.commandsByEcosystem[row.kind] = scoped
  }
}

export function detectEcosystem(root, fileRelList = null) {
  const s = newEcosystemState()
  scanEcosystemAt(root, s)
  scanSubdirectories(root, s, fileRelList)
  for (const hint of PLUGIN_HINTS) {
    if (!hint.test(root)) continue
    if (!s.kinds.includes(hint.kind)) s.kinds.push(hint.kind)
    if (!s.manifests.includes(hint.marker)) s.manifests.push(hint.marker)
  }
  const skill = detectSkillKind(root)
  if (skill) {
    s.kinds.push('skill')
    s.skillMeta = skill.skillMeta
    if (!s.manifests.includes(skill.skillMeta.entry)) s.manifests.push(skill.skillMeta.entry)
    if (skill.skillMeta.version && !s.declaredVersion) s.declaredVersion = skill.skillMeta.version
    if (skill.skillMeta.source && !s.declaredRepo) s.declaredRepo = normalizeDeclaredRepo(skill.skillMeta.source)
    s.registryFree = true
  }
  delete s._inheritedPackageManager
  delete s._repoRoot
  delete s._dirRel
  return s
}

/** 从 CI 配置与任务文件读取语言无关命令。 */
const COMMAND_KINDS = [
  { key: 'test', re: /\b(?:test|tests|runtest|spec|specs|check|verify|validate|preflight|pytest|unittest|vitest|jest|mocha|rspec|ctest|phpunit)\b/i },
  { key: 'lint', re: /\b(?:lint|clippy|rubocop|eslint|flake8|pylint|ruff|mypy|pyright|biome|format|fmt|hlint|vet)\b/i },
  { key: 'build', re: /\b(?:build|compile|bundle|package|make|assemble)\b/i },
  { key: 'install', re: /\b(?:install|deps|dependencies|setup|bootstrap|restore)\b/i },
]

function classifyCommand(cmd) {
  return classifyCommandText(cmd, COMMAND_KINDS)
}

export function detectCiCommands(root, neutralCi = null) {
  const commands = {}
  const sources = {}
  const evidence = []
  const testCmds = []
  const { steps } = neutralCi ?? scanNeutralCiSteps(root)
  for (const step of steps) {
    const cleanCmd = String(step.cmd ?? '').trim().replace(/\s+/g, ' ')
    if (!cleanCmd) continue
    const kind = classifyCommand(cleanCmd)
    if (!kind) continue
    if (kind === 'test') {
      if (!testCmds.includes(cleanCmd)) {
        testCmds.push(cleanCmd)
        sources[kind] ??= step.file
        evidence.push({ layer: 'ci-or-taskfile', kind, file: step.file, line: step.line, command: cleanCmd })
      }
    } else if (commands[kind] === undefined) {
      commands[kind] = cleanCmd
      sources[kind] = step.file
      evidence.push({ layer: 'ci-or-taskfile', kind, file: step.file, line: step.line, command: cleanCmd })
    }
  }
  if (testCmds.length > 0) commands.test = testCmds.join(' && ')
  return { commands, sources, evidence }
}

/** 从 Makefile / justfile / Taskfile 里读已经定义好的 target，作为无 CI 时的第二道兜底。 */
export function detectDeclaredTaskCommands(root, preRunners = null) {
  const runners = preRunners ?? scanDeclaredTaskRunners(root)
  return { commands: runners.commands, sources: runners.sources, evidence: runners.evidence }
}

/**
 * 语言无关的命令兜底：CI 优先，其次 Makefile / justfile / Taskfile。
 */
export function detectUniversalCommands(root, opts = {}) {
  const ci = detectCiCommands(root, opts.neutralCi ?? null)
  const declared = detectDeclaredTaskCommands(root, opts.runners ?? null)
  const commands = {}
  const sources = {}
  const detectionEvidence = []
  for (const key of ['test', 'lint', 'build', 'install']) {
    const from = ci.commands[key] !== undefined ? ci : (declared.commands[key] !== undefined ? declared : null)
    if (!from) continue
    commands[key] = from.commands[key]
    sources[key] = from.sources[key]
    const ev = (from.evidence ?? []).find((e) => e.kind === key)
    if (ev) detectionEvidence.push(ev)
  }
  return { commands, sources, detectionEvidence }
}

export function detectTaskEntriesDetailed(root, preRunners = null) {
  const runners = preRunners ?? scanDeclaredTaskRunners(root)
  const commands = {}
  if (runners.makeTargets.has('test')) commands.test ??= 'make test'
  if (runners.makeTargets.has('build')) commands.build ??= 'make build'
  if (runners.makeTargets.has('lint')) commands.lint ??= 'make lint'
  if (runners.justRecipes.has('test')) commands.test ??= 'just test'
  if (runners.justRecipes.has('build')) commands.build ??= 'just build'
  if (runners.taskNames.has('test')) commands.test ??= 'task test'
  if (runners.taskNames.has('build')) commands.build ??= 'task build'
  return { commands, makeTargets: runners.makeTargets, justRecipes: runners.justRecipes, taskNames: runners.taskNames, runners }
}

const WORKSPACE_MANIFEST_NAMES = new Set([
  'package.json', 'deno.json', 'deno.jsonc', 'jsr.json', 'jsr.jsonc',
  'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile',
])

function isWorkspaceManifestFile(name) {
  return WORKSPACE_MANIFEST_NAMES.has(name) || /\.(?:csproj|fsproj|vbproj|sln|slnx)$/i.test(name)
}

function collectWorkspaceDeclaredGlobs(root) {
  const globs = [...parseYamlWorkspaceGlobs(root)]
  const lerna = readJsonSafe(join(root, 'lerna.json'))
  if (Array.isArray(lerna?.packages)) {
    for (const p of lerna.packages) {
      const clean = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (clean) globs.push(clean)
    }
  }
  const cargo = readTextSafe(join(root, 'Cargo.toml')) ?? ''
  const wsSec = /\[workspace\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? ''
  const memMatch = /\bmembers\s*=\s*\[([\s\S]*?)\]/.exec(wsSec)
  if (memMatch) {
    for (const m of memMatch[1].matchAll(/["']([^"']+)["']/g)) {
      const clean = m[1].trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (clean) globs.push(clean)
    }
  }
  const goWork = readTextSafe(join(root, 'go.work')) ?? ''
  for (const m of goWork.matchAll(/^\s*use\s+([^\s()]+)\s*$/gm)) {
    const clean = m[1].trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean && clean !== '.') globs.push(clean)
  }
  const useBlock = /\buse\s*\(([\s\S]*?)\)/.exec(goWork)?.[1] ?? ''
  for (const rawLine of useBlock.split('\n')) {
    const clean = rawLine.replace(/\/\/.*$/, '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean && clean !== '.') globs.push(clean)
  }
  return [...new Set(globs)]
}

function listWorkspaceCandidateDirs(root, relFiles = null) {
  const dirs = new Map()
  const addDir = (dirRel, hasManifest) => {
    if (!dirRel) return
    dirs.set(dirRel, (dirs.get(dirRel) ?? false) || hasManifest)
  }
  if (Array.isArray(relFiles) && relFiles.length > 0) {
    for (const raw of relFiles) {
      const rel = String(raw ?? '').replace(/\\/g, '/')
      const slash = rel.lastIndexOf('/')
      if (slash <= 0) continue
      const dirRel = rel.slice(0, slash)
      const base = rel.slice(slash + 1)
      if (isVendoredOrEmbeddedPackageDir(dirRel) || dirRel.split('/').some((seg) => SKIP_DIRS.has(seg) || seg === '.git' || seg === '.worktrees' || seg === 'fixtures')) continue
      addDir(dirRel, isWorkspaceManifestFile(base))
      const parts = dirRel.split('/')
      for (let i = 1; i < parts.length; i += 1) addDir(parts.slice(0, i).join('/'), false)
    }
    return dirs
  }
  const walk = (absDir, relPrefix, depth) => {
    if (depth > 5) return
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { return }
    const hasManifest = entries.some((e) => e.isFile() && isWorkspaceManifestFile(e.name))
    if (relPrefix) addDir(relPrefix, hasManifest)
    for (const entry of entries) {
      if (!entry.isDirectory() || isMacMetadataName(entry.name) || entry.isSymbolicLink()) continue
      if (SKIP_DIRS.has(entry.name) || entry.name === 'vendor' || entry.name === 'third_party' || entry.name === '.git' || entry.name === '.worktrees' || entry.name === 'fixtures') continue
      const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (isVendoredOrEmbeddedPackageDir(nextRel)) continue
      walk(join(absDir, entry.name), nextRel, depth + 1)
    }
  }
  walk(root, '', 0)
  return dirs
}

export function detectWorkspace(root, relFiles = null) {
  const cargo = readTextSafe(join(root, 'Cargo.toml')) ?? ''
  const declaredGlobs = collectWorkspaceDeclaredGlobs(root)
  const declared = existsSync(join(root, 'pnpm-workspace.yaml'))
    || existsSync(join(root, 'lerna.json'))
    || Boolean(readJsonSafe(join(root, 'package.json'))?.workspaces)
    || Boolean(readDenoOrJsrManifest(root)?.workspace)
    || (/^\s*\[workspace\]/m.test(cargo))
    || existsSync(join(root, 'go.work'))
  const packages = []
  if (declared) {
    const patterns = declaredGlobs.length > 0 ? declaredGlobs : ['packages/*', 'apps/*', 'crates/*', 'workspaces/*']
    const candidateDirs = listWorkspaceCandidateDirs(root, relFiles)
    for (const [dirRel, hasManifest] of candidateDirs.entries()) {
      if (!hasManifest || isVendoredOrEmbeddedPackageDir(dirRel)) continue
      if (matchGlobList(dirRel, patterns)) packages.push(dirRel)
    }
    if (packages.length === 0 && declaredGlobs.length === 0) {
      for (const dir of ['packages', 'apps', 'crates', 'workspaces']) {
        const p = join(root, dir)
        if (!existsSync(p)) continue
        try {
          for (const entry of readdirSync(p, { withFileTypes: true })) {
            if (isMacMetadataName(entry.name)) continue
            if (entry.isDirectory() && candidateDirs.get(`${dir}/${entry.name}`)) packages.push(`${dir}/${entry.name}`)
          }
        } catch { /* 读不到 */ }
      }
    }
  }
  return { declared, globs: declaredGlobs, packages: [...new Set(packages)].sort().slice(0, 80) }
}

const CONTAINER_FILE_RE = /^(?:Dockerfile(?:\.[^/]+)?|Containerfile(?:\.[^/]+)?|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml|Earthfile|Tiltfile|\.devcontainer\/devcontainer\.json)$/i
const AUTOMATION_SCRIPT_RE = /^(?:Makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml|Procfile|scripts\/[^/]+\.(?:sh|bash|zsh|ps1|py|mjs|ts))$/i

export function detectArtifacts(root, ecosystem, relFiles = null) {
  const hooks = []
  const pkg = readJsonSafe(join(root, 'package.json'))
  if (pkg?.scripts) {
    for (const key of ['preinstall', 'postinstall', 'prepare']) {
      if (typeof pkg.scripts[key] === 'string') hooks.push(`${key}: ${pkg.scripts[key]}`)
    }
  }
  const filesToInspect = Array.isArray(relFiles) && relFiles.length > 0
    ? relFiles.map((r) => String(r ?? '').replace(/\\/g, '/'))
    : [
        ...cleanReaddir(root),
        ...cleanReaddir(join(root, 'scripts')).map((n) => `scripts/${n}`),
        ...(existsSync(join(root, '.devcontainer', 'devcontainer.json')) ? ['.devcontainer/devcontainer.json'] : []),
      ]
  const containerFiles = [...new Set(filesToInspect.filter((rel) => CONTAINER_FILE_RE.test(rel) || CONTAINER_FILE_RE.test(basename(rel))))].sort()
  const automationScripts = [...new Set(filesToInspect.filter((rel) => AUTOMATION_SCRIPT_RE.test(rel)))].sort()
  return {
    heavyDirsPresent: ['dist', 'build', 'out', 'target'].filter((d) => existsSync(join(root, d))),
    installHooks: hooks,
    hasNpmIgnore: existsSync(join(root, '.npmignore')),
    containerFiles,
    automationScripts,
    runtimeRequirements: ecosystem.runtimeRequirements,
    publishableManifest: ecosystem.publishable
      ? { ecosystem: ecosystem.kinds[0], file: ecosystem.manifests[0] }
      : undefined,
  }
}
