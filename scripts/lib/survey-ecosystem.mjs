/**
 * survey-ecosystem.mjs —— 生态清单识别、通用任务入口与工作区多包/产物探测。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { githubRepoPath, isMacMetadataName, isMacMetadataPath, readJsonSafe, readTextSafe } from './text.mjs'

export const SKIP_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.tox', '.gradle', '.cache', '.next', '.nuxt', '.svelte-kit', '.turbo',
  'target', 'dist', 'build', 'out', 'coverage', '.idea', '.vs',
  'DerivedData', '.build', '.swiftpm',
  '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd',
])

export const OUTPUT_DIRS = new Set([
  'node_modules', '.venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage',
])

export const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rs|go|java|kt|kts|scala|c|cc|cpp|h|hpp|m|mm|cs|rb|php|sh|bash|zsh|ps1|lua|r|swift|dart|ex|exs|clj|hs|erl|jl|zig|sol|sql|proto)$/i

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
      if (repo) s.declaredRepo = githubRepoPath(repo)
      s.packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(root, 'yarn.lock')) ? 'yarn'
          : (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) ? 'bun'
            : 'npm'
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
            const repo = githubRepoPath(value)
            if (repo) { s.declaredRepo = repo; break }
          }
        }
      }
      if (!s.declaredRepo && existsSync(join(root, 'setup.py'))) {
        const text = readTextSafe(join(root, 'setup.py')) ?? ''
        s.declaredRepo = githubRepoPath(/url\s*=\s*["']([^"']+)["']/.exec(text)?.[1])
      }
      if (existsSync(join(root, 'uv.lock'))) s.commands.install ??= 'uv sync'
      else if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
        s.commands.install ??= 'pip install -e .'
      } else if (existsSync(join(root, 'requirements.txt'))) {
        s.commands.install ??= 'pip install -r requirements.txt'
      }
      if (hasPytestEvidence(root)) s.commands.test ??= 'pytest'
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
      if (!s.declaredRepo) s.declaredRepo = githubRepoPath(tomlString(text, 'repository'))
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
        s.declaredRepo ??= githubRepoPath(mod)
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
        s.commands.build ??= 'mvn -B package'
        if (hasSuffix(root, '.java')) s.commands.test ??= 'mvn -B test'
        s.publishable = true
        return
      }
      const wrapper = existsSync(join(root, 'gradlew')) || existsSync(join(root, 'gradlew.bat'))
      const gradle = wrapper ? './gradlew' : 'gradle'
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
          const repo = githubRepoPath(candidate)
          if (repo) { s.declaredRepo = repo; break }
        }
      }
    },
  },
  {
    kind: 'dotnet',
    manifest: () => '*.csproj',
    detect: (root) => hasSuffix(root, '.csproj') || hasSuffix(root, '.sln'),
    read: (root, s) => {
      s.commands.build ??= 'dotnet build'
      if (hasSuffix(root, 'Tests.csproj') || hasSuffix(root, '.Tests.csproj')) {
        s.commands.test ??= 'dotnet test'
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
  { kind: 'dsh-plugin', marker: 'package.json', test: (root) => {
    const p = readJsonSafe(join(root, 'package.json'))
    return Boolean(p?.dsh || p?.dependencies?.cordis || p?.peerDependencies?.cordis)
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

function summarizeSkillDescription(desc) {
  if (!desc) return undefined
  const collapsed = String(desc).replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const sentence = collapsed.split(/[。！？!?]|(?<=\.)\s+/)[0].trim() || collapsed
  if (sentence.length <= 80) return sentence
  return `${sentence.slice(0, 77).trimEnd()}...`
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

const SUBDIR_CANDIDATES = [
  'frontend', 'backend', 'client', 'server', 'web', 'api', 'app', 'apps',
  'packages', 'services', 'libs', 'ios', 'macos',
]

function newEcosystemState() {
  return {
    projectName: undefined,
    kinds: [],
    manifests: [],
    commands: {},
    commandsByEcosystem: {},
    runtimeRequirements: [],
    publishable: false,
    private: false,
    registryFree: false,
    declaredVersion: undefined,
    declaredRepo: undefined,
    packageManager: undefined,
    packageScripts: undefined,
    skillMeta: undefined,
    subdirs: [],
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

function scanSubdirectories(root, s) {
  if (s.kinds.length > 0) return
  for (const dir of SUBDIR_CANDIDATES) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    const sub = newEcosystemState()
    scanEcosystemAt(full, sub, { name: dir })
    if (sub.kinds.length === 0) continue
    for (const kind of sub.kinds) if (!s.kinds.includes(kind)) s.kinds.push(kind)
    for (const name of sub.manifests) if (!s.manifests.includes(name)) s.manifests.push(name)
    if (sub.publishable) s.publishable = true
    if (sub.private) s.private = true
    if (Array.isArray(sub.packageScripts)) {
      s.packageScripts = [...new Set([...(s.packageScripts ?? []), ...sub.packageScripts])]
    }
    for (const req of sub.runtimeRequirements) {
      if (!s.runtimeRequirements.includes(req)) s.runtimeRequirements.push(req)
    }
    s.subdirs.push({ dir, kinds: sub.kinds, commands: sub.commands })
    for (const [key, value] of Object.entries(sub.commands)) {
      if (s.commands[key] === undefined) s.commands[key] = value
    }
    if (Object.keys(sub.commands).length > 0) s.commandsByEcosystem[dir] = sub.commands
  }
}

export function detectEcosystem(root) {
  const s = newEcosystemState()
  scanEcosystemAt(root, s)
  scanSubdirectories(root, s)
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
    if (skill.skillMeta.source && !s.declaredRepo) {
      s.declaredRepo = githubRepoPath(skill.skillMeta.source)
    }
    s.registryFree = true
  }

  return s
}

export function detectTaskEntriesDetailed(root) {
  const commands = {}
  const makeTargets = new Set()
  const justRecipes = new Set()
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((n) => existsSync(join(root, n)))
  if (makefile) {
    const text = readTextSafe(join(root, makefile)) ?? ''
    for (const m of text.matchAll(/^([A-Za-z0-9_.-]+):/gm)) makeTargets.add(m[1])
    if (makeTargets.has('test')) commands.test ??= 'make test'
    if (makeTargets.has('build')) commands.build ??= 'make build'
    if (makeTargets.has('lint')) commands.lint ??= 'make lint'
  }
  const justfile = ['justfile', 'Justfile'].find((n) => existsSync(join(root, n)))
  if (justfile) {
    const text = readTextSafe(join(root, justfile)) ?? ''
    for (const m of text.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:/gm)) justRecipes.add(m[1])
    if (justRecipes.has('test')) commands.test ??= 'just test'
    if (justRecipes.has('build')) commands.build ??= 'just build'
  }
  return { commands, makeTargets, justRecipes }
}

export function detectTaskEntries(root) {
  return detectTaskEntriesDetailed(root).commands
}

export function detectWorkspace(root) {
  const cargo = readTextSafe(join(root, 'Cargo.toml')) ?? ''
  const declared = existsSync(join(root, 'pnpm-workspace.yaml'))
    || existsSync(join(root, 'lerna.json'))
    || Boolean(readJsonSafe(join(root, 'package.json'))?.workspaces)
    || (/^\s*\[workspace\]/m.test(cargo))
    || existsSync(join(root, 'go.work'))
  const packages = []
  if (declared) {
    for (const dir of ['packages', 'apps', 'crates', 'workspaces']) {
      const p = join(root, dir)
      if (!existsSync(p)) continue
      try {
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          if (isMacMetadataName(entry.name)) continue
          if (entry.isDirectory()) packages.push(`${dir}/${entry.name}`)
        }
      } catch { /* 读不到 */ }
    }
  }
  return { declared, packages: packages.slice(0, 50) }
}

export function detectArtifacts(root, ecosystem) {
  const hooks = []
  const pkg = readJsonSafe(join(root, 'package.json'))
  if (pkg?.scripts) {
    for (const key of ['preinstall', 'postinstall', 'prepare']) {
      if (typeof pkg.scripts[key] === 'string') hooks.push(`${key}: ${pkg.scripts[key]}`)
    }
  }
  return {
    heavyDirsPresent: ['dist', 'build', 'out', 'target'].filter((d) => existsSync(join(root, d))),
    installHooks: hooks,
    hasNpmIgnore: existsSync(join(root, '.npmignore')),
    runtimeRequirements: ecosystem.runtimeRequirements,
    publishableManifest: ecosystem.publishable
      ? { ecosystem: ecosystem.kinds[0], file: ecosystem.manifests[0] }
      : undefined,
  }
}
