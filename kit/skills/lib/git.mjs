/**
 * git.mjs —— 跨平台路径归一、无弹窗安全子进程、进程树超时清理与 Git `-z` 核心原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），统一处理 macOS /private/var 与 APFS NFD、
 * Windows 盘符大小写与 junction、submodule / --separate-git-dir、unborn HEAD 与冲突态。
 */

import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildNonInteractiveEnv, computeWorktreeEnv, execSafe, execShellCommand,
  killProcessTree, resolveExecutable, withFileLock,
} from './exec.mjs'

export {
  buildNonInteractiveEnv,
  computeWorktreeEnv,
  execSafe,
  execShellCommand,
  killProcessTree,
  resolveExecutable,
  withFileLock,
}

export const LIKELY_DEFAULT_BRANCHES = Object.freeze([
  'main', 'master', 'trunk', 'develop', 'default', 'development',
])

export const COMMON_SKIP_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.tox', '.gradle', '.idea', '.vs', 'Pods', 'DerivedData', '.build', '.swiftpm',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd',
])

export const DEFAULT_WALK_SKIP_DIRS = COMMON_SKIP_DIRS

const MACOS_JUNK_NAMES = new Set(['.DS_Store', '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd'])

let atomicCounter = 0

/** 路径统一归一化为正斜杠，避免跨平台集合比对失配。 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/**
 * 规范化任意路径（含尚不存在的子路径）：
 * 对最深已存在祖先调用 realpathSync.native 并执行 Unicode NFC 归一，
 * 修复 macOS `/var` vs `/private/var`、APFS NFD 以及 Windows 盘符大小写差异。
 */
export function canonicalPath(p) {
  let cur = resolve(String(p ?? '.'))
  const tail = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    tail.unshift(basename(cur))
    cur = parent
  }
  let base = cur
  try {
    base = realpathSync.native(cur)
  } catch { /* 祖先不可解析时回退 resolve 结果 */ }
  let out = tail.length > 0 ? join(base, ...tail) : base
  out = out.normalize('NFC')
  if (process.platform === 'win32' && /^[a-z]:/.test(out)) {
    out = out[0].toUpperCase() + out.slice(1)
  }
  return out
}

/** 比较两个路径是否指向同一位置（兼容 macOS 祖先 symlink、APFS NFD 与 Win32 大小写）。 */
export function samePath(a, b) {
  const ca = canonicalPath(a)
  const cb = canonicalPath(b)
  if (process.platform === 'win32') {
    return ca.toLowerCase() === cb.toLowerCase()
  }
  return ca === cb
}

/** 判断当前模块是否作为 CLI 入口直接执行（兼容 symlink 与 junction）。 */
export function isMainModule(metaUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  return samePath(argv1, fileURLToPath(metaUrl))
}

/** 检测路径是否属于 macOS Finder / 索引垃圾文件（._*、.DS_Store、__MACOSX 等）。 */
export function isMacOsJunkPath(relOrName) {
  const norm = posixPath(relOrName)
  if (!norm) return false
  const parts = norm.split('/')
  for (const seg of parts) {
    if (!seg) continue
    if (MACOS_JUNK_NAMES.has(seg) || seg.startsWith('._')) return true
  }
  return false
}

/** 安全读取 UTF-8 文本文件（去掉 BOM、统一换行）；不可读或二进制返回 undefined。 */
export function readTextSafe(filePath, maxBytes = 512 * 1024) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

/** 安全读取 JSON 文件；失败返回 undefined。 */
export function readJsonSafe(filePath) {
  const text = readTextSafe(filePath)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/** 原子写入文本文件：先写同目录临时文件再改名，自增计数器防同毫秒碰撞。 */
export function writeAtomic(filePath, content) {
  const abs = resolve(filePath)
  mkdirSync(dirname(abs), { recursive: true })
  atomicCounter += 1
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${atomicCounter}`
  writeFileSync(tmp, String(content ?? ''), 'utf8')
  try {
    renameSync(tmp, abs)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清理失败不影响抛出原始异常 */ }
    throw error
  }
}

/** 原子写入格式化 JSON 文件。 */
export function writeJsonAtomic(filePath, data) {
  writeAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

/** 计算文本 SHA256（hex）。 */
export function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 计算文件 SHA256（hex）；不存在或不可读返回 null。 */
export function sha256File(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return null
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

const GIT_LOCK_ERROR_RE = /Unable to create '[^']*\.lock'|Another git process seems to be running|index\.lock|\.lock['":\s]+(?:File exists|Permission denied|Resource temporarily unavailable)/i
const DEFAULT_GIT_LOCK_BACKOFF_MS = Object.freeze([50, 100, 200, 400, 800])

/** 安全执行 git 命令（保留 UTF-8 输出并统一 NFC 路径，遇 `.git/*.lock` 自动指数退避重试）。 */
export async function gitRun(cwd, args, opts = {}) {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'core.precomposeunicode=true', ...args]
  const execOpts = { ...opts, cwd }
  const runner = opts.runner ?? execSafe
  const backoff = Array.isArray(opts.lockBackoffMs) ? opts.lockBackoffMs : DEFAULT_GIT_LOCK_BACKOFF_MS
  let res = await runner('git', fullArgs, execOpts)
  for (let i = 0; i < backoff.length && !res.ok && GIT_LOCK_ERROR_RE.test(res.stderr ?? ''); i += 1) {
    if (backoff[i] > 0) await new Promise((r) => setTimeout(r, backoff[i]))
    res = await runner('git', fullArgs, execOpts)
  }
  return res
}

/** 执行 git 命令并返回原始 Buffer stdout（供 `-z` NUL 分隔解析与精确 SHA256 使用）。 */
export function gitRunBuffer(cwd, args, opts = {}) {
  return gitRun(cwd, args, { ...opts, buffer: true })
}

/** 解析 `git worktree list --porcelain` 输出，路径统一 canonicalPath。 */
export function parseWorktreeListPorcelain(text) {
  const items = []
  let cur = null
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') {
      if (cur) items.push(cur)
      cur = null
      continue
    }
    if (line.startsWith('worktree ')) {
      cur = { path: canonicalPath(line.slice(9).trim()), head: null, branch: null, detached: false, bare: false, prunable: null }
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim()
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    } else if (cur && line.trim() === 'detached') {
      cur.detached = true
    } else if (cur && line.trim() === 'bare') {
      cur.bare = true
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = line.slice(8).trim() || 'missing directory'
    }
  }
  if (cur) items.push(cur)
  return items
}

function tryResolveRepoRootsFast(absCwd) {
  const dotGit = join(absCwd, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) {
      if (!existsSync(join(dotGit, 'HEAD'))) return null
      const cfg = readTextSafe(join(dotGit, 'config')) ?? ''
      if (/^\s*bare\s*=\s*true\b/im.test(cfg)) return null
      return {
        isGit: true,
        cwd: absCwd,
        mainRoot: absCwd,
        workTreeRoot: absCwd,
        gitDir: dotGit,
        workTreeGitDir: dotGit,
        isWorktree: false,
        isBare: false,
      }
    }
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return null
      const perWtGitDir = canonicalPath(resolve(absCwd, m[1].trim()))
      if (!existsSync(join(perWtGitDir, 'HEAD'))) return null
      const commondirFile = join(perWtGitDir, 'commondir')
      if (!existsSync(commondirFile)) return null
      const relCommon = readFileSync(commondirFile, 'utf8').trim()
      const commonDir = canonicalPath(resolve(perWtGitDir, relCommon))
      if (basename(commonDir).toLowerCase() !== '.git') return null
      if (!samePath(dirname(dirname(perWtGitDir)), commonDir)) return null
      const mainRoot = canonicalPath(dirname(commonDir))
      return {
        isGit: true,
        cwd: absCwd,
        mainRoot,
        workTreeRoot: absCwd,
        gitDir: commonDir,
        workTreeGitDir: perWtGitDir,
        isWorktree: !samePath(mainRoot, absCwd),
        isBare: false,
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 解析当前目录所属的 Git 仓库边界。
 * 常规仓与 `.worktrees/` 链接工作树通过本地 `.git` 元信息直接零开销解析；
 * 子目录、子模块或 `--separate-git-dir` 自动回退 `git rev-parse`。
 */
export async function resolveRepoRoots(cwd = process.cwd()) {
  const absCwd = canonicalPath(cwd)
  const fast = tryResolveRepoRootsFast(absCwd)
  if (fast) return fast

  const res = await gitRun(absCwd, [
    'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--is-bare-repository', '--git-dir',
  ])
  if (!res.ok || !res.stdout) {
    return {
      isGit: false,
      cwd: absCwd,
      mainRoot: absCwd,
      workTreeRoot: absCwd,
      gitDir: null,
      workTreeGitDir: null,
      isWorktree: false,
      isBare: false,
    }
  }
  const lines = res.stdout.split('\n').map((l) => l.trim())
  const inside = lines[0] === 'true'
  const topLevel = lines[1] ? canonicalPath(lines[1]) : absCwd
  const commonDir = lines[2] ? canonicalPath(resolve(absCwd, lines[2])) : join(topLevel, '.git')
  const isBare = lines[3] === 'true'
  const perWtGitDir = lines[4] ? canonicalPath(resolve(absCwd, lines[4])) : commonDir

  if (!inside || isBare) {
    return {
      isGit: isBare,
      cwd: absCwd,
      mainRoot: absCwd,
      workTreeRoot: absCwd,
      gitDir: commonDir,
      workTreeGitDir: perWtGitDir,
      isWorktree: false,
      isBare,
    }
  }

  let mainRoot = null
  const isStandardDotGit = basename(commonDir).toLowerCase() === '.git'
  if (isStandardDotGit && samePath(commonDir, perWtGitDir) && samePath(dirname(commonDir), topLevel)) {
    mainRoot = topLevel
  } else if (isStandardDotGit && !samePath(commonDir, perWtGitDir) && samePath(dirname(dirname(perWtGitDir)), commonDir)) {
    mainRoot = canonicalPath(dirname(commonDir))
  } else {
    const wtRes = await gitRun(topLevel, ['worktree', 'list', '--porcelain'])
    if (wtRes.ok && wtRes.stdout) {
      const list = parseWorktreeListPorcelain(wtRes.stdout)
      const primary = list.find((item) => !item.bare)
      if (primary?.path) mainRoot = primary.path
    }
    if (!mainRoot) {
      mainRoot = isStandardDotGit ? canonicalPath(dirname(commonDir)) : topLevel
    }
  }

  return {
    isGit: true,
    cwd: absCwd,
    mainRoot,
    workTreeRoot: topLevel,
    gitDir: commonDir,
    workTreeGitDir: perWtGitDir,
    isWorktree: !samePath(mainRoot, topLevel),
    isBare: false,
  }
}

function hasWorktreesRuleInFile(filePath) {
  const txt = readTextSafe(filePath)
  if (!txt) return false
  return txt.split('\n').some((l) => {
    const t = l.trim()
    return t === '.worktrees' || t === '.worktrees/' || t === '/.worktrees' || t === '/.worktrees/'
  })
}

/** 确保 .worktrees/ 已被 Git 忽略（优先零进程本地核对，写 `.git/info/exclude` 加文件锁）。 */
export async function ensureWorktreesIgnored(mainRoot, gitDir) {
  const actualGitDir = gitDir ?? join(mainRoot, '.git')
  const excludeFile = join(actualGitDir, 'info', 'exclude')
  if (hasWorktreesRuleInFile(join(mainRoot, '.gitignore')) || hasWorktreesRuleInFile(excludeFile)) {
    return { ok: true, method: 'existing' }
  }
  const check = await gitRun(mainRoot, ['check-ignore', '-q', '.worktrees'])
  if (check.ok) return { ok: true, method: 'existing' }
  const lockPath = join(actualGitDir, 'project-forge-flow', 'locks', 'info-exclude.lock')
  try {
    return await withFileLock(lockPath, () => {
      mkdirSync(dirname(excludeFile), { recursive: true })
      const cur = readTextSafe(excludeFile) ?? ''
      const hasRule = cur.split('\n').some((l) => {
        const t = l.trim()
        return t === '.worktrees' || t === '.worktrees/' || t === '/.worktrees' || t === '/.worktrees/'
      })
      if (!hasRule) {
        const next = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n.worktrees/\n` : `${cur}.worktrees/\n`
        writeAtomic(excludeFile, next)
      }
      return { ok: true, method: 'git-info-exclude' }
    })
  } catch {
    return { ok: false, method: 'unignored' }
  }
}

/** 解码 Git C 引号转义路径（含 UTF-8 八进制序列）。 */
export function unescapeGitPath(rawPath) {
  const s = String(rawPath ?? '')
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return posixPath(s)
  const inner = s.slice(1, -1)
  const bytes = []
  const pushStr = (str) => {
    for (const b of Buffer.from(str, 'utf8')) bytes.push(b)
  }
  const simpleMap = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' }
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const next = inner.slice(i + 1, i + 4)
      if (/^[0-7]{3}/.test(next)) {
        bytes.push(parseInt(next.slice(0, 3), 8))
        i += 3
        continue
      }
      const esc = inner[i + 1]
      if (Object.prototype.hasOwnProperty.call(simpleMap, esc)) {
        pushStr(simpleMap[esc])
      } else {
        pushStr(esc)
      }
      i += 1
    } else {
      pushStr(inner[i])
    }
  }
  return posixPath(Buffer.from(bytes).toString('utf8'))
}

/** 使用 `git status --porcelain=v1 -z -u` 零截断解析工作区改动与冲突条目。 */
export async function gitStatusPorcelainZ(cwd) {
  const res = await gitRunBuffer(cwd, ['status', '--porcelain=v1', '-z', '-u'])
  if (!res.ok) return { ok: false, entries: [], stderr: res.stderr }
  const text = res.stdout.toString('utf8')
  const tokens = text.split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok || tok.length < 4) continue
    const xy = tok.slice(0, 2)
    const file = posixPath(tok.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const oldFile = posixPath(tokens[i + 1] ?? '')
      i += 1
      entries.push({ xy, status: xy.trim() || 'R', file, oldFile })
    } else {
      entries.push({ xy, status: xy.trim() || '??', file })
    }
  }
  return { ok: true, entries, stderr: '' }
}

/** 使用 `git diff --name-status -z` 零截断解析变更文件清单。 */
export async function gitDiffNameStatusZ(cwd, diffArgs = []) {
  const res = await gitRunBuffer(cwd, ['diff', '--name-status', '-z', ...diffArgs])
  if (!res.ok) return { ok: false, entries: [], stderr: res.stderr }
  const tokens = res.stdout.toString('utf8').split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i]
    if (!status) continue
    if (/^[RC]/.test(status)) {
      const oldFile = posixPath(tokens[i + 1] ?? '')
      const file = posixPath(tokens[i + 2] ?? '')
      i += 2
      if (file) entries.push({ status, file, oldFile })
    } else {
      const file = posixPath(tokens[i + 1] ?? '')
      i += 1
      if (file) entries.push({ status, file })
    }
  }
  return { ok: true, entries, stderr: '' }
}

function resolveWtGitDirLocal(repoRoot) {
  const dotGit = join(repoRoot, '.git')
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/im.exec(readFileSync(dotGit, 'utf8'))
      if (m) return resolve(repoRoot, m[1].trim())
    }
  } catch { /* fall back to git rev-parse */ }
  return null
}

/** 检测仓库是否处于进行中的 Merge / Rebase / Cherry-pick / Revert / 冲突态（复用已知 wtGitDir 与 statusEntries）。 */
export async function detectInProgressGitOp(repoRoot, opts = {}) {
  const ops = []
  let wtGitDir = opts.wtGitDir ?? resolveWtGitDirLocal(repoRoot)
  if (!wtGitDir) {
    const gdRes = await gitRun(repoRoot, ['rev-parse', '--git-dir'])
    wtGitDir = gdRes.ok && gdRes.stdout.trim() ? resolve(repoRoot, gdRes.stdout.trim()) : join(repoRoot, '.git')
  }
  if (existsSync(join(wtGitDir, 'MERGE_HEAD'))) ops.push('merge')
  if (existsSync(join(wtGitDir, 'REBASE_HEAD')) || existsSync(join(wtGitDir, 'rebase-merge')) || existsSync(join(wtGitDir, 'rebase-apply'))) {
    ops.push('rebase')
  }
  if (existsSync(join(wtGitDir, 'CHERRY_PICK_HEAD'))) ops.push('cherry-pick')
  if (existsSync(join(wtGitDir, 'REVERT_HEAD'))) ops.push('revert')
  if (existsSync(join(wtGitDir, 'BISECT_LOG'))) ops.push('bisect')

  const entries = Array.isArray(opts.statusEntries)
    ? opts.statusEntries
    : ((await gitStatusPorcelainZ(repoRoot)).entries ?? [])
  const conflicts = entries
    .filter((e) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(e.xy))
    .map((e) => e.file)

  return {
    inProgress: ops.length > 0 || conflicts.length > 0,
    op: ops[0] ?? (conflicts.length > 0 ? 'conflict' : null),
    ops,
    conflicts,
  }
}

function isBinaryProbe(absPath) {
  let fd
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return { exists: false, isBinary: false, size: 0 }
    if (st.size === 0) return { exists: true, isBinary: false, size: 0 }
    fd = openSync(absPath, 'r')
    const probeLen = Math.min(st.size, 4096)
    const buf = Buffer.allocUnsafe(probeLen)
    const n = readSync(fd, buf, 0, probeLen, 0)
    return { exists: true, isBinary: buf.subarray(0, n).includes(0), size: st.size }
  } catch {
    return { exists: false, isBinary: false, size: 0 }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/**
 * 无深度限制全仓库文件枚举（Git 仓走 `ls-files -z`，非 Git 仓走无深度上限流式遍历），
 * 通过前 4KB NUL 探测识别文本/二进制文件并过滤 macOS 元数据（`._*` / `__MACOSX` / `.DS_Store`）。
 */
export async function gitLsFilesTextAndCode(root, { isGit = true, focus, probeBinary = true, maxFiles = 50000 } = {}) {
  const absRoot = canonicalPath(root)
  const focusParts = focus
    ? posixPath(focus).replace(/^\/+|\/+$/g, '').split('/').filter((s) => s && s !== '.')
    : []
  const focusRel = focusParts.length > 0 ? focusParts.join('/') : undefined
  const files = []
  const dirSummary = new Map()
  let truncated = false

  const pushFile = (relPath) => {
    const rel = posixPath(relPath).replace(/^(?:\.\/)+/, '')
    if (!rel || isMacOsJunkPath(rel)) return
    if (focusRel && rel !== focusRel && !rel.startsWith(`${focusRel}/`)) return
    const segs = rel.split('/')
    const firstSeg = segs[0]
    if (segs.slice(0, -1).some((s) => COMMON_SKIP_DIRS.has(s))) return
    const full = join(absRoot, rel)
    const probe = probeBinary ? isBinaryProbe(full) : { exists: existsSync(full), isBinary: false, size: 0 }
    if (!probe.exists) return
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    const top = rel.includes('/') ? firstSeg : '.'
    dirSummary.set(top, (dirSummary.get(top) ?? 0) + 1)
    files.push({
      rel,
      name: basename(rel),
      full,
      size: probe.size,
      isBinary: probe.isBinary,
      isText: !probe.isBinary,
    })
  }

  if (isGit) {
    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    if (focusRel) args.push('--', focusRel)
    const res = await gitRunBuffer(absRoot, args)
    if (res.ok) {
      const paths = res.stdout.toString('utf8').split('\0').filter(Boolean).sort()
      for (const p of paths) {
        if (truncated) break
        pushFile(p)
      }
      return { files, dirSummary, truncated, source: 'git-ls-files-z' }
    }
  }

  const queue = [focusRel ? join(absRoot, focusRel) : absRoot]
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(absRoot, full))
      if (entry.isDirectory()) {
        if (!COMMON_SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        pushFile(rel)
        if (truncated) break
      }
    }
  }
  return { files, dirSummary, truncated, source: 'fs-walk' }
}

/** 现场解析仓库真实默认分支（兼容 unborn HEAD、shallow clone 与非 main 主干）。 */
export async function resolveDefaultBranch(repoRoot) {
  const [originHeadRes, branchRes, initDefRes] = await Promise.all([
    gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    gitRun(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
    gitRun(repoRoot, ['config', '--get', 'init.defaultbranch']),
  ])
  if (originHeadRes.ok && originHeadRes.stdout.trim()) {
    return originHeadRes.stdout.trim().replace(/^origin\//, '')
  }
  const curBranch = branchRes.ok ? branchRes.stdout.trim() : undefined
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch

  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    const local = await gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${cand}`])
    if (local.ok) return cand
    const remote = await gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${cand}`])
    if (remote.ok) return cand
  }
  if (curBranch && curBranch !== 'HEAD') return curBranch
  const initDef = initDefRes.ok ? initDefRes.stdout.trim() : undefined
  return initDef || 'main'
}

/** 探测项目格式、默认分支、提交风格与是否启用了四层 docs/ 体系。 */
export async function detectProjectConventions(repoRoot) {
  const [defaultBranch, logRes] = await Promise.all([
    resolveDefaultBranch(repoRoot),
    gitRun(repoRoot, ['log', '--format=%s', '-n', '20']),
  ])

  const subjects = logRes.ok && logRes.stdout
    ? logRes.stdout.split('\n').filter(Boolean)
    : []
  const convRe = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
  const convCount = subjects.filter((s) => convRe.test(s)).length
  const commitStyle = subjects.length > 0 && convCount > subjects.length / 2 ? 'conventional' : 'plain'

  const hasDocsSystem = existsSync(join(repoRoot, 'docs', 'TDD.md'))
    || existsSync(join(repoRoot, 'docs', 'specs'))
    || existsSync(join(repoRoot, 'docs', 'todo'))
    || existsSync(join(repoRoot, 'docs', 'prd'))

  return { defaultBranch, commitStyle, hasDocsSystem }
}

/**
 * 使用 `git cherry` + `git patch-id` 判定分支相对于默认主干的四态合流状态：
 * `'merged' | 'squash_or_rebase_merged' | 'no_own_commits' | 'unmerged'`。
 */
export async function inspectBranchMergeState(mainRoot, { branch, headSha, defaultBranch = 'main', gitDir = null } = {}) {
  const targetRef = branch || headSha
  const resolvedGitDir = gitDir ?? resolveWtGitDirLocal(mainRoot)
  const canFastShallow = Boolean(resolvedGitDir && !existsSync(join(resolvedGitDir, 'reftable')))
  const [shallowRes, baseCheck, ownRes, isAncRes] = await Promise.all([
    canFastShallow
      ? Promise.resolve({ ok: true, stdout: existsSync(join(resolvedGitDir, 'shallow')) ? 'true' : 'false' })
      : gitRun(mainRoot, ['rev-parse', '--is-shallow-repository']),
    targetRef ? gitRun(mainRoot, ['rev-parse', '--verify', '--quiet', defaultBranch]) : Promise.resolve({ ok: false }),
    targetRef ? gitRun(mainRoot, ['rev-list', '--count', `${defaultBranch}..${targetRef}`]) : Promise.resolve({ ok: false, stdout: '0' }),
    targetRef ? gitRun(mainRoot, ['merge-base', '--is-ancestor', targetRef, defaultBranch]) : Promise.resolve({ ok: false }),
  ])
  const isShallow = shallowRes.ok && shallowRes.stdout.trim() === 'true'
  if (!targetRef) {
    return { state: 'unmerged', ownCommits: 0, isShallow, reason: '缺少目标分支或提交引用' }
  }
  if (!baseCheck.ok) {
    return { state: 'unmerged', ownCommits: 0, isShallow, reason: `基线分支 ${defaultBranch} 不存在` }
  }

  const ownCommits = ownRes.ok ? (Number(ownRes.stdout.trim()) || 0) : 1
  const isAncestor = isAncRes.ok

  if (isAncestor && ownCommits === 0) {
    const [targetShaRes, fpRes, reflog] = await Promise.all([
      headSha ? Promise.resolve({ ok: true, stdout: headSha }) : gitRun(mainRoot, ['rev-parse', targetRef]),
      gitRun(mainRoot, ['rev-list', '--first-parent', '-n', '200', defaultBranch]),
      branch ? gitRun(mainRoot, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`]) : Promise.resolve({ ok: false, stdout: '' }),
    ])
    const targetSha = targetShaRes.ok ? targetShaRes.stdout.trim() : ''
    const firstParentSet = new Set(fpRes.ok ? fpRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])
    const hasCommitReflog = Boolean(reflog.ok && reflog.stdout
      && reflog.stdout.split('\n').some((l) => /^(?:commit(?:\s|\(|:)|cherry-pick)/.test(l.trim())))
    if ((targetSha && !firstParentSet.has(targetSha)) || hasCommitReflog) {
      return { state: 'merged', ownCommits: 0, isShallow, reason: `已合入 ${defaultBranch}` }
    }
    return { state: 'no_own_commits', ownCommits: 0, isShallow, reason: `无领先 ${defaultBranch} 的独立提交` }
  }

  const [cherryRes, mbRes] = await Promise.all([
    gitRun(mainRoot, ['cherry', defaultBranch, targetRef]),
    gitRun(mainRoot, ['merge-base', defaultBranch, targetRef]),
  ])
  const cherryLines = cherryRes.ok && cherryRes.stdout
    ? cherryRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    : []
  if (cherryLines.length > 0 && cherryLines.every((l) => l.startsWith('- '))) {
    return {
      state: 'squash_or_rebase_merged',
      ownCommits,
      isShallow,
      reason: `全部 ${cherryLines.length} 个提交均已通过 rebase/cherry-pick 落地 ${defaultBranch}`,
    }
  }

  if (mbRes.ok && mbRes.stdout.trim()) {
    const diffRes = await gitRun(mainRoot, ['diff', mbRes.stdout.trim(), targetRef])
    if (diffRes.ok && diffRes.stdout) {
      const [branchPidRes, logRes] = await Promise.all([
        gitRun(mainRoot, ['patch-id', '--stable'], { input: diffRes.stdout }),
        gitRun(mainRoot, ['log', '-n', '60', '--no-merges', '-p', defaultBranch], { timeout: 30000 }),
      ])
      const branchPid = branchPidRes.ok ? branchPidRes.stdout.trim().split(/\s+/)[0] : ''
      if (branchPid && logRes.ok && logRes.stdout) {
        const defPidRes = await gitRun(mainRoot, ['patch-id', '--stable'], { input: logRes.stdout })
        if (defPidRes.ok && defPidRes.stdout) {
          const set = new Set(defPidRes.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))
          if (set.has(branchPid)) {
            return {
              state: 'squash_or_rebase_merged',
              ownCommits,
              isShallow,
              reason: `合并补丁 patch-id 与 ${defaultBranch} 提交完全一致（Squash 合并）`,
            }
          }
        }
      }
    }
  }

  return { state: 'unmerged', ownCommits, isShallow, reason: `存在 ${ownCommits} 个未合并提交` }
}

/** 同步或按需创建干净的 detached 审查隔离工作树至 targetSha，脏工作树直接阻断（支持 resetDirty）。 */
export async function syncDetachedWorktree(mainRoot, wtAbs, targetSha, { resetDirty = false } = {}) {
  if (!targetSha || targetSha === 'UNBORN') {
    throw new Error('目标工作区尚无有效提交（UNBORN HEAD），无法同步审查隔离工作树')
  }
  if (existsSync(wtAbs)) {
    if (resetDirty) {
      await gitRun(wtAbs, ['reset', '--hard'])
      await gitRun(wtAbs, ['clean', '-fd'])
    }
    const st = await gitStatusPorcelainZ(wtAbs)
    if (!st.ok) throw new Error(`读取审查工作树状态失败（${wtAbs}）：${st.stderr}`)
    if (st.entries.length > 0) {
      throw new Error(`BLOCKED_DIRTY_REVIEW_WORKTREE: 审查工作树 ${wtAbs} 存在未提交改动，请先清理后再推进审查`)
    }
    const curHead = await gitRun(wtAbs, ['rev-parse', 'HEAD'])
    if (curHead.ok && curHead.stdout.trim() === targetSha) {
      return { ok: true, action: resetDirty ? 'reset-synced' : 'already-synced', headSha: targetSha, path: wtAbs }
    }
    const co = await gitRun(wtAbs, ['checkout', '--detach', targetSha])
    if (!co.ok) throw new Error(`推进审查工作树至 ${targetSha.slice(0, 7)} 失败：${co.stderr}`)
    return { ok: true, action: resetDirty ? 'reset-updated' : 'updated', headSha: targetSha, path: wtAbs }
  }
  const addRes = await gitRun(mainRoot, ['worktree', 'add', '--detach', wtAbs, targetSha])
  if (!addRes.ok) throw new Error(`创建审查隔离工作树失败：${addRes.stderr}`)
  return { ok: true, action: 'created', headSha: targetSha, path: wtAbs }
}
