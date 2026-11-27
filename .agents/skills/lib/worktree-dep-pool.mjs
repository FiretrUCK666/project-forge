/**
 * worktree-dep-pool.mjs —— 多 Worktree 三类并发依赖分层引擎（Class R / S / I）、
 * 仓外只读 dep-pool、Windows NTFS 递归撤只读位安全销毁、毒化探测与引用计数 GC。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），严禁反向导入 dev-flow 脚本。
 */

import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { withFileLockSync } from './exec.mjs'
import {
  canonicalPath, isInsideDir, posixPath, readJsonSafe, readTextSafe,
  samePath, sha256File, sha256Text, writeAtomic, writeJsonAtomic,
} from './git.mjs'
import { discoverWorkspacePackages, parseAgentsProfile } from './profile.mjs'

export const NODE_LOCKFILES = Object.freeze(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'])
export const PY_LOCKFILES = Object.freeze(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'requirements-dev.txt'])
export const PYTHON_DEP_DIRS = Object.freeze(['.venv', 'venv'])
export const VITE_CONFIG_NAMES = Object.freeze(['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'])

export const CLASS_S_EXTRA_SPECS = Object.freeze([
  { ecosystem: 'php', depDirs: ['vendor'], lockfiles: ['composer.lock'], manifests: ['composer.json'] },
  { ecosystem: 'ruby', depDirs: ['vendor/bundle'], lockfiles: ['Gemfile.lock'], manifests: ['Gemfile'] },
  { ecosystem: 'cocoapods', depDirs: ['Pods'], lockfiles: ['Podfile.lock'], manifests: ['Podfile'] },
  { ecosystem: 'elixir', depDirs: ['deps'], lockfiles: ['mix.lock'], manifests: ['mix.exs'] },
])

export const CLASS_I_DIR_NAMES = Object.freeze(new Set([
  'dist', 'build', 'target', '.next', '.nuxt', '.svelte-kit', '.dart_tool', '.turbo',
  'pg_data', 'postgres_data', 'redis_data', 'mongo_data', 'mysql_data',
  'volumes', '.qdrant', '.chroma',
]))
export const CLASS_I_FILE_RE = /\.(?:sqlite|sqlite3|db|db-wal|db-shm)$/i

export function lstatSafe(p) {
  try { return lstatSync(p) } catch { return null }
}

export function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

export function isClassIPath(relPath) {
  const norm = posixPath(String(relPath ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
  if (!norm) return false
  const parts = norm.split('/')
  if (parts.some((seg) => CLASS_I_DIR_NAMES.has(seg.toLowerCase()))) return true
  return CLASS_I_FILE_RE.test(parts[parts.length - 1] ?? '')
}

export function classifyHeavyDir(relPath) {
  const norm = posixPath(String(relPath ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
  if (!norm) return 'unknown'
  if (isClassIPath(norm)) return 'I'
  const base = (norm.split('/').pop() ?? '').toLowerCase()
  if (['node_modules', '.venv', 'venv', 'vendor', 'pods', 'deps'].includes(base) || norm.endsWith('/vendor/bundle') || norm === 'vendor/bundle') {
    return 'S'
  }
  return 'unknown'
}

export function resolveCommonGitDir(mainAbs) {
  const dotGit = join(mainAbs, '.git')
  const st = statSafe(dotGit)
  if (!st) return null
  if (st.isDirectory()) return dotGit
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/mi.exec(readTextSafe(dotGit) ?? '')
    if (!m) return null
    const actualGitDir = resolve(mainAbs, m[1].trim())
    const commonRef = readTextSafe(join(actualGitDir, 'commondir'))
    return commonRef?.trim() ? resolve(actualGitDir, commonRef.trim()) : actualGitDir
  }
  return null
}

export function resolveDepPoolRoot(mainAbs) {
  const common = resolveCommonGitDir(mainAbs)
  return canonicalPath(common
    ? join(common, 'project-forge-flow', 'dep-pool')
    : join(mainAbs, '.worktrees', '.state', 'dep-pool'))
}

/** 卸载单个符号链接/Windows junction（遇 EPERM/EISDIR 回退非递归 rmdirSync，绝不递归删除目标内容）。 */
export function unlinkLinkSafe(absPath) {
  try {
    unlinkSync(absPath)
    return true
  } catch (err) {
    if (err?.code === 'ENOENT') return true
    if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EISDIR')) {
      const st = lstatSafe(absPath)
      if (st && st.isSymbolicLink()) {
        rmdirSync(absPath)
        return true
      }
    }
    throw err
  }
}

/** 自底向上为仓外 dep-pool 条目置只读位（跳过软链以防穿透外部目标）。 */
export function setReadOnlyTreeSync(dirPath) {
  const walk = (cur) => {
    const st = lstatSafe(cur)
    if (!st || st.isSymbolicLink()) return
    if (st.isDirectory()) {
      let entries = []
      try { entries = readdirSync(cur) } catch { entries = [] }
      for (const name of entries) walk(join(cur, name))
      if (process.platform !== 'win32') {
        try { chmodSync(cur, 0o555) } catch { /* ignore */ }
      }
    } else if (st.isFile()) {
      try { chmodSync(cur, 0o444) } catch { /* ignore */ }
    }
  }
  walk(dirPath)
}

/**
 * Windows NTFS / POSIX 只读目录树安全销毁原语：
 * 自顶向下递归解除只读位（目录 0o777、文件 0o666），不跟随软链，随后 rmSync 彻底清除防 EPERM。
 */
export function removeReadOnlyTreeSync(dirPath, { dryRunRm = false } = {}) {
  if (!dirPath || !lstatSafe(dirPath)) return { removed: false, unprotectedDirs: 0, unprotectedFiles: 0 }
  let unprotectedDirs = 0
  let unprotectedFiles = 0
  const unprotect = (cur) => {
    const st = lstatSafe(cur)
    if (!st) return
    if (st.isSymbolicLink()) {
      if (!dryRunRm) try { unlinkLinkSafe(cur) } catch { /* ignore */ }
      return
    }
    if (st.isDirectory()) {
      try { chmodSync(cur, 0o777); unprotectedDirs += 1 } catch { /* ignore */ }
      let entries = []
      try { entries = readdirSync(cur) } catch { entries = [] }
      for (const name of entries) unprotect(join(cur, name))
      return
    }
    try { chmodSync(cur, 0o666); unprotectedFiles += 1 } catch { /* ignore */ }
  }
  unprotect(dirPath)
  if (!dryRunRm) rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  return { removed: !dryRunRm, unprotectedDirs, unprotectedFiles }
}

export function hashLockfile(filePath) {
  const st = statSafe(filePath)
  if (!st || !st.isFile()) return null
  if (filePath.toLowerCase().endsWith('.lockb')) return sha256File(filePath)
  try {
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return sha256File(filePath)
    return sha256Text(buf.toString('utf8').replace(/\r\n/g, '\n'))
  } catch {
    return null
  }
}

function readManifestDepSlice(rootAbs, dirRel, ecosystem) {
  const baseDir = dirRel ? join(rootAbs, dirRel) : rootAbs
  if (ecosystem === 'node') {
    const pkg = readJsonSafe(join(baseDir, 'package.json'))
    if (!pkg || typeof pkg !== 'object') return ''
    return JSON.stringify({
      dependencies: pkg.dependencies ?? null,
      devDependencies: pkg.devDependencies ?? null,
      peerDependencies: pkg.peerDependencies ?? null,
      optionalDependencies: pkg.optionalDependencies ?? null,
      overrides: pkg.overrides ?? null,
      resolutions: pkg.resolutions ?? null,
      packageManager: pkg.packageManager ?? null,
    })
  }
  if (ecosystem === 'php') {
    const comp = readJsonSafe(join(baseDir, 'composer.json'))
    if (!comp || typeof comp !== 'object') return ''
    return JSON.stringify({ require: comp.require ?? null, 'require-dev': comp['require-dev'] ?? null })
  }
  const names = ecosystem === 'python'
    ? ['pyproject.toml', 'setup.cfg', 'Pipfile']
    : ecosystem === 'ruby'
      ? ['Gemfile']
      : ecosystem === 'cocoapods'
        ? ['Podfile']
        : ecosystem === 'elixir'
          ? ['mix.exs']
          : []
  const parts = []
  for (const fn of names) {
    const txt = readTextSafe(join(baseDir, fn), 256 * 1024)
    if (txt !== undefined) parts.push(`${fn}:${sha256Text(txt.replace(/\r\n/g, '\n'))}`)
  }
  return parts.join('|')
}

export function computeUnitDepFingerprint(rootAbs, dirRel, ecosystem, lockNames = []) {
  const lockParts = []
  for (const name of lockNames) {
    const rel = dirRel ? `${dirRel}/${name}` : name
    const h = hashLockfile(join(rootAbs, rel))
    if (h) lockParts.push(`${name}=${h}`)
  }
  const manifestSlice = readManifestDepSlice(rootAbs, dirRel, ecosystem)
  return sha256Text(JSON.stringify({ eco: ecosystem, dir: dirRel || '.', locks: lockParts, manifest: manifestSlice }))
}

export function compareUnitLocks(mainAbs, wtAbs, dirRel, lockNames) {
  const lockfiles = []
  const mismatches = []
  for (const name of lockNames) {
    const rel = dirRel ? `${dirRel}/${name}` : name
    const mainHash = hashLockfile(join(mainAbs, rel))
    const wtHash = hashLockfile(join(wtAbs, rel))
    if (mainHash === null && wtHash === null) continue
    lockfiles.push({ file: rel, mainHash, wtHash })
    if (mainHash !== wtHash) {
      mismatches.push({
        file: rel,
        mainHash,
        wtHash,
        reason: mainHash === null ? 'added-in-worktree' : wtHash === null ? 'removed-in-worktree' : 'hash-mismatch',
      })
    }
  }
  return { match: mismatches.length === 0, lockfiles, mismatches }
}

export function collectCandidatePackageDirs(root) {
  const dirs = new Set([''])
  const disc = discoverWorkspacePackages(root)
  for (const pkg of disc.packages) dirs.add(pkg.dirRel)
  for (const depName of ['node_modules', ...PYTHON_DEP_DIRS, 'vendor', 'Pods', 'deps']) {
    if (existsSync(join(root, depName))) dirs.add('')
  }
  const queue = ['']
  let seen = 0
  while (queue.length > 0 && seen < 1500) {
    const rel = queue.shift()
    const abs = rel ? join(root, rel) : root
    let entries = []
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (['.git', '.worktrees', 'dist', 'build', 'target', 'coverage', '.cache'].includes(entry.name)) continue
      if (entry.name === 'node_modules' || PYTHON_DEP_DIRS.includes(entry.name)) {
        dirs.add(rel)
        continue
      }
      if (!entry.name.startsWith('.')) {
        seen += 1
        queue.push(rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  return [...dirs].sort()
}

export function detectNodeWorkspacePoisoning(mainAbs, nodeModulesAbs) {
  if (!existsSync(nodeModulesAbs)) return null
  if (existsSync(join(nodeModulesAbs, '.prisma')) || existsSync(join(nodeModulesAbs, '@prisma', 'client', '.prisma'))) {
    return 'node_modules/.prisma 包含库内生成代码，禁止跨 Worktree 共享'
  }
  const inspectEntry = (entryPath) => {
    const st = lstatSafe(entryPath)
    if (!st || !st.isSymbolicLink()) return null
    try {
      const targetReal = realpathSync.native(entryPath)
      if (isInsideDir(targetReal, mainAbs) && !isInsideDir(targetReal, nodeModulesAbs)) {
        return `Workspace 软链指回主仓源码 (${posixPath(relative(mainAbs, targetReal))})`
      }
    } catch { /* ignore broken link */ }
    return null
  }
  try {
    for (const e of readdirSync(nodeModulesAbs, { withFileTypes: true })) {
      const full = join(nodeModulesAbs, e.name)
      const direct = inspectEntry(full)
      if (direct) return direct
      if (e.name.startsWith('@') && e.isDirectory()) {
        for (const sub of readdirSync(full, { withFileTypes: true })) {
          const scoped = inspectEntry(join(full, sub.name))
          if (scoped) return scoped
        }
      }
      if (e.name === '.pnpm' && e.isDirectory()) {
        for (const sub of readdirSync(full, { withFileTypes: true }).slice(0, 200)) {
          const nmInPnpm = join(full, sub.name, 'node_modules')
          if (!existsSync(nmInPnpm)) continue
          for (const inner of readdirSync(nmInPnpm, { withFileTypes: true }).slice(0, 60)) {
            const hit = inspectEntry(join(nmInPnpm, inner.name))
            if (hit) return `.pnpm 传递 link: 指回主仓源码 (${hit})`
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null
}

function readFirstLineSafe(filePath, maxBytes = 256) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    const slice = n > 0 ? buf.subarray(0, n) : null
    return (slice && !slice.includes(0)) ? (slice.toString('utf8').split(/\r?\n/, 1)[0] ?? '') : ''
  } catch { return '' } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
}

export function detectPythonEditablePoisoning(mainAbs, venvAbs) {
  if (!existsSync(venvAbs)) return null
  const mainReal = canonicalPath(mainAbs)
  const mainNormPosix = posixPath(mainReal).toLowerCase()
  const mainNormNative = mainReal.toLowerCase()
  for (const binDirName of ['bin', 'Scripts']) {
    const binDir = join(venvAbs, binDirName)
    if (!existsSync(binDir)) continue
    let entries = []
    try { entries = readdirSync(binDir, { withFileTypes: true }).slice(0, 120) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const firstLine = readFirstLineSafe(join(binDir, entry.name))
      if (!firstLine.startsWith('#!')) continue
      const rawShebang = firstLine.slice(2).trim()
      const shebangExec = rawShebang.startsWith('"')
        ? rawShebang.slice(1).split('"', 1)[0]
        : (rawShebang.startsWith("'") ? rawShebang.slice(1).split("'", 1)[0] : rawShebang.split(/\s+/, 1)[0])
      const low = firstLine.toLowerCase()
      const byCanonical = Boolean(
        (shebangExec && isInsideDir(canonicalPath(shebangExec), mainReal))
        || (rawShebang && rawShebang !== shebangExec && isInsideDir(canonicalPath(rawShebang), mainReal)),
      )
      if (byCanonical || low.includes(mainNormPosix) || low.includes(mainNormNative)) {
        return `POSIX ${binDirName}/${entry.name} shebang 硬编码主仓绝对路径`
      }
    }
  }

  const siteCandidates = []
  for (const libBase of ['lib', 'lib64', 'Lib']) {
    const p = join(venvAbs, libBase)
    if (!existsSync(p)) continue
    if (libBase === 'Lib') {
      const sp = join(p, 'site-packages')
      if (existsSync(sp)) siteCandidates.push(sp)
      continue
    }
    try {
      for (const pyDir of readdirSync(p)) {
        if (!/^python/i.test(pyDir)) continue
        const sp = join(p, pyDir, 'site-packages')
        if (existsSync(sp)) siteCandidates.push(sp)
      }
    } catch { /* ignore */ }
  }

  for (const sp of siteCandidates) {
    let entries = []
    try { entries = readdirSync(sp, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(sp, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.pth') || entry.name.endsWith('.egg-link'))) {
        const txt = readTextSafe(full, 128 * 1024) ?? ''
        for (const line of txt.split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('#') || t.startsWith('import ')) continue
          const targetAbs = resolve(sp, t)
          if (isInsideDir(targetAbs, mainAbs) && !isInsideDir(targetAbs, venvAbs)) {
            return `Python editable 安装指回主仓（${entry.name} -> ${posixPath(relative(mainAbs, targetAbs))}）`
          }
        }
      } else if (entry.isDirectory() && entry.name.endsWith('.dist-info')) {
        const directUrl = readJsonSafe(join(full, 'direct_url.json'))
        const isEditable = directUrl?.dir_info?.editable === true
        const rawUrl = String(directUrl?.url ?? '')
        if (isEditable && /^file:\/\//i.test(rawUrl)) {
          try {
            const urlPath = decodeURIComponent(new URL(rawUrl).pathname).replace(/^\/([A-Za-z]:)/, '$1')
            if (isInsideDir(urlPath, mainAbs) && !isInsideDir(urlPath, venvAbs)) {
              return `Python editable direct_url 指回主仓（${posixPath(relative(mainAbs, urlPath))}）`
            }
          } catch { /* ignore */ }
        }
      }
    }
  }
  return null
}

/** 识别单元属于 Class R（原生全局并发仓）还是 Class S（仓外只读池）。 */
export function detectUnitDepClass(mainAbs, dirRel, ecosystem, lockfiles = []) {
  const baseDir = dirRel ? join(mainAbs, dirRel) : mainAbs
  const names = new Set(lockfiles.map((l) => basename(typeof l === 'string' ? l : l?.file ?? '')))
  if (ecosystem === 'node') {
    if (names.has('pnpm-lock.yaml')) {
      return { depClass: 'R', manager: 'pnpm', offlineCmd: 'pnpm install --offline --frozen-lockfile' }
    }
    if (names.has('bun.lock') || names.has('bun.lockb')) {
      return { depClass: 'R', manager: 'bun', offlineCmd: 'bun install --frozen-lockfile' }
    }
    if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) {
      return { depClass: 'S', manager: 'npm' }
    }
    if (names.has('yarn.lock')) {
      return { depClass: 'S', manager: 'yarn' }
    }
    const pkg = readJsonSafe(join(baseDir, 'package.json'))
    const pm = String(pkg?.packageManager ?? '').toLowerCase()
    if (pm.startsWith('pnpm@') || (!dirRel && existsSync(join(baseDir, 'node_modules', '.pnpm')))) {
      return { depClass: 'R', manager: 'pnpm', offlineCmd: 'pnpm install --offline --frozen-lockfile' }
    }
    if (pm.startsWith('bun@')) {
      return { depClass: 'R', manager: 'bun', offlineCmd: 'bun install --frozen-lockfile' }
    }
    return { depClass: 'S', manager: 'npm' }
  }
  if (ecosystem === 'python') {
    if (names.has('uv.lock')) return { depClass: 'R', manager: 'uv', offlineCmd: 'uv sync --offline' }
    return { depClass: 'S', manager: names.has('poetry.lock') ? 'poetry' : 'pip' }
  }
  return { depClass: 'S', manager: ecosystem }
}

/** 扫描原生全局并发仓生态（Go/Rust/JVM/.NET/Dart/Swift），永不软链工作树目录。 */
export function detectGlobalStoreClassRUnits(mainAbs, wtAbs) {
  const found = []
  const seen = new Set()
  const common = resolveCommonGitDir(mainAbs)
  const wtTag = basename(wtAbs).replace(/[^a-zA-Z0-9._-]/g, '_') || 'wt'
  const cargoTargetDir = join(common || join(mainAbs, '.git'), 'project-forge-flow', 'cache', wtTag, 'cargo-target')
  const check = (key, manager, files, offlineCmd, envHints = {}) => {
    if (seen.has(key)) return
    if (files.some((f) => existsSync(join(wtAbs, f)) || existsSync(join(mainAbs, f)))) {
      seen.add(key)
      found.push({ dirRel: '.', ecosystem: key, depClass: 'R', manager, offlineCmd, envHints })
    }
  }
  check('rust', 'cargo', ['Cargo.toml', 'Cargo.lock'], 'cargo fetch --offline', { CARGO_TARGET_DIR: cargoTargetDir })
  check('go', 'go', ['go.mod', 'go.work'], 'go mod download')
  check('jvm', 'maven-gradle', ['pom.xml', 'build.gradle', 'build.gradle.kts'], 'mvn -o test-compile / gradle --offline')
  check('dotnet', 'dotnet', ['packages.lock.json'], 'dotnet restore --no-cache')
  check('dart', 'dart-pub', ['pubspec.yaml'], 'dart pub get --offline')
  check('swift', 'swiftpm', ['Package.swift', 'Package.resolved'], 'swift package resolve')
  try {
    const rootNames = readdirSync(wtAbs)
    if (!seen.has('dotnet') && rootNames.some((n) => /\.(?:csproj|fsproj|sln)$/i.test(n))) {
      seen.add('dotnet')
      found.push({ dirRel: '.', ecosystem: 'dotnet', depClass: 'R', manager: 'dotnet', offlineCmd: 'dotnet restore', envHints: {} })
    }
  } catch { /* ignore */ }
  return found
}

export function detectPnpmWorkspace(mainAbs, cmpUnits = []) {
  if (existsSync(join(mainAbs, 'pnpm-lock.yaml')) || existsSync(join(mainAbs, 'pnpm-workspace.yaml')) || existsSync(join(mainAbs, 'node_modules', '.pnpm'))) {
    return true
  }
  return cmpUnits.some((u) => (u.lockfiles ?? []).some((lf) => (typeof lf === 'string' ? lf : lf?.file ?? lf?.path ?? '').endsWith('pnpm-lock.yaml')))
}

export function detectViteConfigDirs(mainAbs, wtAbs, cmpUnits = []) {
  const dirs = new Set([''])
  for (const u of cmpUnits) if (u?.dirRel) dirs.add(u.dirRel)
  for (const d of dirs) {
    for (const root of [wtAbs, mainAbs]) {
      if (VITE_CONFIG_NAMES.some((fn) => existsSync(d ? join(root, d, fn) : join(root, fn)))) return true
      const pkg = readJsonSafe(d ? join(root, d, 'package.json') : join(root, 'package.json'))
      if (pkg?.dependencies?.vite || pkg?.devDependencies?.vite) return true
    }
  }
  return false
}

export function buildWorktreeMountHints(mainAbs, wtAbs, cmpUnits = [], mountedItems = [], classRUnits = []) {
  const hasNodeMount = mountedItems.some((m) => /(?:^|\/)node_modules$/.test(String(m?.path ?? '')))
  const isPnpm = detectPnpmWorkspace(mainAbs, cmpUnits) || classRUnits.some((u) => u.manager === 'pnpm')
  const hasVite = detectViteConfigDirs(mainAbs, wtAbs, cmpUnits)
  const envHints = {}
  const hints = []
  for (const u of classRUnits) {
    if (u.envHints) Object.assign(envHints, u.envHints)
    if (u.offlineCmd) hints.push(`Class R (${u.manager}) 并发全局仓隔离：建议直接执行 \`${u.offlineCmd}\`（绝不软链主仓目录）。`)
  }
  if (isPnpm || (hasNodeMount && mountedItems.some((m) => m.linkType === 'junction'))) {
    envHints.npm_config_verify_deps_before_run = 'false'
    envHints.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
    hints.push('pnpm 共享/全局仓检测：已导出 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false 与 npm_config_verify_deps_before_run=false。')
  }
  if ((hasNodeMount || isPnpm) && hasVite) {
    const allowPaths = [...new Set([canonicalPath(mainAbs), ...mountedItems.map((m) => m.target).filter(Boolean).map(canonicalPath)])]
    hints.push(`Vite 跨路径放行提示：请在 vite.config.* 的 server.fs.allow 中加入 ${JSON.stringify(allowPaths)} 以放行共享/池化依赖真实路径。`)
  }
  return { envHints, hints, isPnpm, hasVite }
}

export function ensureMountedDepsExcluded(mainAbs, relPaths) {
  if (!relPaths || relPaths.length === 0) return
  const commonGitDir = resolveCommonGitDir(mainAbs)
  if (!commonGitDir) return
  const excludeFile = join(commonGitDir, 'info', 'exclude')
  try {
    mkdirSync(dirname(excludeFile), { recursive: true })
    const cur = readTextSafe(excludeFile) ?? ''
    const existing = new Set(cur.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
    const toAdd = []
    for (const rel of relPaths) {
      const rule = `/${posixPath(rel).replace(/^\/+|\/+$/g, '')}`
      if (rule.length > 1 && !existing.has(rule) && !toAdd.includes(rule)) toAdd.push(rule)
    }
    if (toAdd.length === 0) return
    const prefix = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n` : cur
    writeAtomic(excludeFile, `${prefix}${toAdd.join('\n')}\n`)
  } catch { /* ignore non-writable exclude */ }
}

function readPoolRefsStrict(refsPath) {
  const empty = { version: 1, entries: {} }
  if (!existsSync(refsPath)) return { data: empty, corrupt: false, missing: true }
  try {
    const parsed = JSON.parse(readFileSync(refsPath, 'utf8'))
    const ok = Boolean(parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries))
    return { data: ok ? parsed : empty, corrupt: !ok, missing: false }
  } catch {
    return { data: empty, corrupt: true, missing: false }
  }
}

export function ensureDepPoolEntry({ mainAbs, wtAbs, rel, eco, dirRel, fingerprint, srcReal }) {
  const poolRoot = resolveDepPoolRoot(mainAbs)
  const unitHash = sha256Text(`${dirRel || '.'}:${posixPath(rel)}`).slice(0, 8)
  const fp16 = String(fingerprint).slice(0, 16)
  const poolKey = `${eco}-${unitHash}-${fp16}`
  const poolDir = join(poolRoot, poolKey)
  const lockPath = join(poolRoot, 'pool-refs.lock')
  const refsPath = join(poolRoot, 'pool-refs.json')
  const wtKey = posixPath(canonicalPath(wtAbs))

  return withFileLockSync(lockPath, () => {
    mkdirSync(poolRoot, { recursive: true })
    let created = false
    if (!existsSync(poolDir)) {
      const stageDir = join(poolRoot, `.stage-${poolKey}-${process.pid}-${Date.now()}`)
      try {
        cpSync(srcReal, stageDir, { recursive: true, verbatimSymlinks: true })
        renameSync(stageDir, poolDir)
        setReadOnlyTreeSync(poolDir)
        created = true
      } catch (err) {
        try { removeReadOnlyTreeSync(stageDir) } catch { /* ignore */ }
        throw err
      }
    }
    const { data } = readPoolRefsStrict(refsPath)
    const entry = data.entries[poolKey] ?? { path: posixPath(poolDir), eco, dirRel: dirRel || '.', rel: posixPath(rel), fingerprint: fp16, worktrees: [] }
    const wtSet = new Set(Array.isArray(entry.worktrees) ? entry.worktrees : [])
    wtSet.add(wtKey)
    entry.worktrees = [...wtSet].sort()
    entry.updatedAt = new Date().toISOString()
    data.entries[poolKey] = entry
    writeJsonAtomic(refsPath, data)
    return { poolKey, poolDir, fp16, created }
  })
}

export function unregisterWorktreeFromPoolRefs(mainAbs, wtAbs, targetPools = null) {
  const poolRoot = resolveDepPoolRoot(mainAbs)
  const refsPath = join(poolRoot, 'pool-refs.json')
  if (!existsSync(poolRoot) || !existsSync(refsPath)) return
  const lockPath = join(poolRoot, 'pool-refs.lock')
  const wtKey = posixPath(canonicalPath(wtAbs))
  const filterSet = Array.isArray(targetPools) ? new Set(targetPools) : null
  withFileLockSync(lockPath, () => {
    const { data, corrupt } = readPoolRefsStrict(refsPath)
    if (corrupt) return
    let changed = false
    for (const [key, entry] of Object.entries(data.entries)) {
      if (filterSet && !filterSet.has(key)) continue
      const list = Array.isArray(entry?.worktrees) ? entry.worktrees : []
      const next = list.filter((w) => w !== wtKey)
      if (next.length !== list.length) {
        entry.worktrees = next
        entry.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) writeJsonAtomic(refsPath, data)
  })
}

function scanActivePoolRefsOnDisk(mainAbs, poolRoot, extraWorktrees = []) {
  const activeByPool = new Map()
  const wtDirs = new Set()
  const wtBase = join(mainAbs, '.worktrees')
  if (existsSync(wtBase)) {
    try {
      for (const ent of readdirSync(wtBase, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue
        wtDirs.add(canonicalPath(join(wtBase, ent.name)))
      }
    } catch { /* ignore */ }
  }
  for (const w of extraWorktrees) {
    if (w && existsSync(w)) wtDirs.add(canonicalPath(w))
  }
  const poolNorm = canonicalPath(poolRoot)
  const walkWt = (wtAbs, dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name === '.git') continue
      const abs = join(dir, ent.name)
      const st = lstatSafe(abs)
      if (!st) continue
      if (st.isSymbolicLink()) {
        try {
          const real = realpathSync.native(abs)
          if (isInsideDir(real, poolNorm)) {
            const relPool = posixPath(relative(poolNorm, real))
            const poolKey = relPool.split('/')[0]
            if (poolKey && !poolKey.startsWith('.')) {
              if (!activeByPool.has(poolKey)) activeByPool.set(poolKey, new Set())
              activeByPool.get(poolKey).add(posixPath(wtAbs))
            }
          }
        } catch { /* ignore */ }
        continue
      }
      if (ent.isDirectory() && !CLASS_I_DIR_NAMES.has(ent.name.toLowerCase()) && ent.name !== 'node_modules') {
        walkWt(wtAbs, abs, depth + 1)
      }
    }
  }
  for (const wtAbs of wtDirs) walkWt(wtAbs, wtAbs, 0)
  return activeByPool
}

/** 引用计数 GC：仅回收 refcount === 0 的只读池条目；索引缺失或损坏时先全盘扫描活跃 worktree 重建计数防误删。 */
export function gcUnusedDepPools(mainRoot, { activeWorktrees = [] } = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const poolRoot = resolveDepPoolRoot(mainAbs)
  if (!existsSync(poolRoot)) return { ok: true, removed: [], kept: [], rebuilt: false }
  const lockPath = join(poolRoot, 'pool-refs.lock')
  const refsPath = join(poolRoot, 'pool-refs.json')

  return withFileLockSync(lockPath, () => {
    const { data, corrupt, missing } = readPoolRefsStrict(refsPath)
    const rebuilt = Boolean(corrupt || missing)
    const liveRefs = scanActivePoolRefsOnDisk(mainAbs, poolRoot, activeWorktrees)
    const removed = []
    const kept = []

    let poolDirs = []
    try {
      poolDirs = readdirSync(poolRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    } catch { poolDirs = [] }

    const nextEntries = {}
    for (const poolKey of poolDirs) {
      const liveSet = liveRefs.get(poolKey) ?? new Set()
      if (liveSet.size === 0) {
        removeReadOnlyTreeSync(join(poolRoot, poolKey))
        removed.push(poolKey)
      } else {
        const prev = data.entries[poolKey] ?? {}
        nextEntries[poolKey] = {
          ...prev,
          path: posixPath(join(poolRoot, poolKey)),
          worktrees: [...liveSet].sort(),
          updatedAt: new Date().toISOString(),
        }
        kept.push({ poolKey, refcount: liveSet.size })
      }
    }
    writeJsonAtomic(refsPath, { version: 1, entries: nextEntries })
    return { ok: true, removed, kept, rebuilt }
  })
}

export function listCustomSharedReadonlyDirs(mainAbs) {
  const prof = parseAgentsProfile(mainAbs)
  const raw = Array.isArray(prof.worktreeSharedReadonly) ? prof.worktreeSharedReadonly : []
  const accepted = []
  const rejected = []
  for (const item of raw) {
    const norm = posixPath(String(item ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
    if (!norm || norm === '.' || isAbsolute(item) || norm.split('/').includes('..')) {
      rejected.push({ path: String(item ?? ''), reason: 'invalid-path' })
      continue
    }
    if (isClassIPath(norm)) {
      rejected.push({ path: norm, reason: 'class-i-strictly-isolated' })
      continue
    }
    accepted.push(norm)
  }
  return { accepted: [...new Set(accepted)], rejected }
}

/** 原子脱钩指定 worktree 依赖单元链接（仅删指向 dep-pool 或主仓的软链，绝不碰真实目录）。 */
export function detachWorktreeUnit(mainRoot, wtRoot, { unit = '' } = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (samePath(mainAbs, wtAbs)) throw new Error('拒绝在主仓执行 detach')
  const normUnit = posixPath(String(unit ?? '').trim()).replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '')
  if (!normUnit) throw new Error('detach 需要指定 --unit <相对路径>')
  const abs = join(wtAbs, normUnit)
  const st = lstatSafe(abs)
  if (!st || !st.isSymbolicLink()) return { ok: true, detached: [], skipped: [{ path: normUnit, reason: st ? 'not-a-symlink' : 'absent' }] }
  const poolRoot = resolveDepPoolRoot(mainAbs)
  let real = null
  try { real = realpathSync.native(abs) } catch { /* broken link */ }
  if (real && !isInsideDir(real, mainAbs) && !isInsideDir(real, poolRoot)) {
    throw new Error(`拒绝脱钩非工具托管外链：${normUnit} -> ${real}`)
  }
  const poolKey = real && isInsideDir(real, poolRoot) ? posixPath(relative(poolRoot, real)).split('/')[0] : null
  unlinkLinkSafe(abs)
  if (poolKey) unregisterWorktreeFromPoolRefs(mainAbs, wtAbs, [poolKey])
  return { ok: true, detached: [normUnit], poolKey }
}

/** 漂移自愈钩子：检测已挂载 Class S 链接对应锁文件/清单依赖段是否漂移，漂移即自动原子脱钩。 */
export function reconcileWorktreeDeps(mainRoot, wtRoot, { ledger = null } = {}) {
  const mainAbs = canonicalPath(mainRoot)
  const wtAbs = canonicalPath(wtRoot)
  if (samePath(mainAbs, wtAbs) || !existsSync(wtAbs)) return { ok: true, drifted: [], detached: [], unchanged: [] }
  const poolRoot = resolveDepPoolRoot(mainAbs)
  const wtRel = posixPath(relative(mainAbs, wtAbs))
  const candidates = new Set([
    ...(Array.isArray(ledger?.mountedDepsByWorktree?.[wtRel]) ? ledger.mountedDepsByWorktree[wtRel] : []),
    ...(Array.isArray(ledger?.mountedDeps) ? ledger.mountedDeps : []),
  ])
  for (const dirRel of collectCandidatePackageDirs(wtAbs)) {
    for (const d of ['node_modules', ...PYTHON_DEP_DIRS, 'vendor', 'vendor/bundle', 'Pods', 'deps']) {
      const rel = dirRel ? `${dirRel}/${d}` : d
      if (lstatSafe(join(wtAbs, rel))?.isSymbolicLink()) candidates.add(posixPath(rel))
    }
  }
  for (const custom of listCustomSharedReadonlyDirs(mainAbs).accepted) {
    if (lstatSafe(join(wtAbs, custom))?.isSymbolicLink()) candidates.add(custom)
  }

  const drifted = []
  const detached = []
  const unchanged = []
  for (const rel of [...candidates].sort()) {
    const abs = join(wtAbs, rel)
    const st = lstatSafe(abs)
    if (!st || !st.isSymbolicLink()) continue
    let real = null
    try { real = realpathSync.native(abs) } catch { /* broken */ }
    if (real && !isInsideDir(real, poolRoot) && !isInsideDir(real, mainAbs)) continue

    let isDrifted = !real
    let poolKey = null
    if (real && isInsideDir(real, poolRoot)) {
      poolKey = posixPath(relative(poolRoot, real)).split('/')[0]
      const m = /^([a-z0-9]+)-([0-9a-f]{8})-([0-9a-f]{16})$/.exec(poolKey)
      if (m) {
        const [, eco, , mountedFp16] = m
        const dirRel = rel.includes('/') && !rel.endsWith('vendor/bundle') ? posixPath(dirname(rel)) : (rel === 'vendor/bundle' ? '' : (rel.endsWith('/vendor/bundle') ? rel.slice(0, -'/vendor/bundle'.length) : ''))
        const lockNames = eco === 'node' ? NODE_LOCKFILES : eco === 'python' ? PY_LOCKFILES : (CLASS_S_EXTRA_SPECS.find((s) => s.ecosystem === eco)?.lockfiles ?? [])
        if (eco !== 'custom') {
          const curFp16 = computeUnitDepFingerprint(wtAbs, dirRel, eco, lockNames).slice(0, 16)
          if (curFp16 !== mountedFp16) isDrifted = true
        }
      }
    } else if (real && isInsideDir(real, mainAbs)) {
      const dirRel = rel.includes('/') ? posixPath(dirname(rel)) : ''
      const lockNames = rel.endsWith('node_modules') ? NODE_LOCKFILES : PY_LOCKFILES
      if (!compareUnitLocks(mainAbs, wtAbs, dirRel, lockNames).match) isDrifted = true
    }

    if (isDrifted) {
      unlinkLinkSafe(abs)
      if (poolKey) unregisterWorktreeFromPoolRefs(mainAbs, wtAbs, [poolKey])
      drifted.push({ path: rel, poolKey, reason: real ? 'fingerprint-drifted' : 'broken-pool-link' })
      detached.push(rel)
    } else {
      unchanged.push(rel)
    }
  }
  return { ok: true, drifted, detached, unchanged }
}
