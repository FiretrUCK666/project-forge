/**
 * git-core.mjs —— 跨平台路径归一、原子安全读写、SHA256 哈希、路径解码与 Git 重试执行基础原语。
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execSafe } from './exec.mjs'

export const LIKELY_DEFAULT_BRANCHES = Object.freeze([
  'main', 'master', 'trunk', 'develop', 'default', 'development',
])

export const MIN_COMMIT_STYLE_SAMPLES = 5

const MERGE_OR_AUTO_COMMIT_RE = /^(?:Merge\b|Revert\s+"|Initial commit$|chore\((?:release|deps(?:-dev)?)\):|build\(deps(?:-dev)?\):|release:\s|bump\b|auto[- ]?merge\b|.*\[bot\])/i
const CONVENTIONAL_SUBJECT_RE = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
const GITMOJI_SUBJECT_RE = /^(?::[a-z_]+:|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u

/**
 * 过滤合并提交与自动化提交后判定提交风格（`conventional` | `gitmoji` | `plain`）。
 * 有效样本不足 5 条时返回中性 `'plain'`，防止浅克隆或初期少数提交触发风格漂移。
 */
export function detectCommitStyle(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return 'plain'
  const effective = subjects
    .map((s) => String(s ?? '').trim())
    .filter((s) => s && !MERGE_OR_AUTO_COMMIT_RE.test(s))
  if (effective.length < MIN_COMMIT_STYLE_SAMPLES) return 'plain'
  let conv = 0
  let emoji = 0
  for (const s of effective) {
    if (CONVENTIONAL_SUBJECT_RE.test(s)) conv += 1
    else if (GITMOJI_SUBJECT_RE.test(s)) emoji += 1
  }
  const half = effective.length / 2
  if (conv > half) return 'conventional'
  if (emoji > half) return 'gitmoji'
  return 'plain'
}

export const COMMON_SKIP_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.tox', '.gradle', '.idea', '.vs', 'Pods', 'DerivedData', '.build', '.swiftpm',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd',
])

export const COMMON_OUTPUT_DIRS = Object.freeze([
  'node_modules', '.venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage',
])

export const DEFAULT_WALK_SKIP_DIRS = COMMON_SKIP_DIRS

const MACOS_JUNK_NAMES = new Set([
  '.DS_Store', '__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd', '.AppleDouble', '.TemporaryItems',
])

let atomicCounter = 0

/** 路径统一归一化为正斜杠，避免跨平台集合比对失配。 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

function getHomeMarkers() {
  const raw = String(homedir() || '').trim()
  if (raw.length < 4) return []
  const fwd = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  const bwd = raw.replace(/\//g, '\\').replace(/\\+$/, '')
  return [...new Set([fwd, bwd].filter((s) => s.length >= 4))]
}

/** 检测文本是否包含宿主机用户主目录绝对路径泄露。 */
export function containsHomedirLeak(text) {
  const body = String(text ?? '')
  if (!body) return false
  for (const marker of getHomeMarkers()) {
    if (body.includes(marker)) return true
  }
  return false
}

/** 剥离文本中的宿主机用户主目录绝对路径前缀，统一替换为 `~`。 */
export function stripHomedirLeaks(text) {
  let out = String(text ?? '')
  for (const marker of getHomeMarkers()) {
    if (out.includes(marker)) out = out.split(marker).join('~')
  }
  return out
}

/**
 * 规范化任意路径（含尚不存在的子路径）：
 * 对最深已存在祖先调用 realpathSync.native 并执行 Unicode NFC 归一，
 * 修复 macOS `/var` vs `/private/var`、APFS NFD 以及 Windows 盘符大小写差异。
 */
export function canonicalPath(p) {
  if (p === undefined || p === null) return ''
  const raw = String(p)
  if (raw.trim() === '') return ''
  let cur = resolve(raw)
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
  if (a === undefined || a === null || b === undefined || b === null) return false
  if (String(a).trim() === '' || String(b).trim() === '') return false
  const ca = canonicalPath(a)
  const cb = canonicalPath(b)
  if (!ca || !cb) return false
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

/** 检测单个路径段是否属于 macOS Finder / AppleDouble 元数据条目。 */
export function isMacMetadataName(name) {
  const seg = String(name ?? '')
  if (!seg) return false
  return MACOS_JUNK_NAMES.has(seg) || seg.startsWith('._')
}

/** 检测路径是否属于 macOS Finder / 索引垃圾文件（._*、.DS_Store、__MACOSX 等）。 */
export function isMacOsJunkPath(relOrName) {
  const norm = posixPath(relOrName)
  if (!norm) return false
  return norm.split('/').some((seg) => isMacMetadataName(seg))
}

/** 判断候选路径是否位于目标父目录之内（含相等；严防 `/tmp/repo2` 误判在 `/tmp/repo` 内）。 */
export function isInsideDir(candidateAbs, parentAbs) {
  const c = canonicalPath(candidateAbs)
  const p = canonicalPath(parentAbs)
  const ca = process.platform === 'win32' ? c.toLowerCase() : c
  const pa = process.platform === 'win32' ? p.toLowerCase() : p
  if (ca === pa) return true
  const prefix = pa.endsWith(sep) ? pa : `${pa}${sep}`
  return ca.startsWith(prefix)
}

/** 安全读取 UTF-8 文本文件（去掉 BOM、统一换行）；不可读或二进制返回 undefined。 */
export function readTextSafe(filePath, maxBytes = 512 * 1024) {
  try {
    const st = statSync(filePath)
    const limit = maxBytes == null ? Infinity : maxBytes
    if (!st.isFile() || st.size > limit) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

/** 安全读取 JSON 文件；失败返回 undefined。 */
export function readJsonSafe(filePath, maxBytes = 512 * 1024) {
  const text = readTextSafe(filePath, maxBytes)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

const WRITE_ATOMIC_RETRY_BUF = new Int32Array(new SharedArrayBuffer(4))
const WRITE_ATOMIC_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const WRITE_ATOMIC_BACKOFF_MS = Object.freeze([10, 20, 40, 60])

/** 原子写入文本或二进制 Buffer：先写同目录临时文件再改名，自增计数器防同毫秒碰撞；Windows 瞬态锁短退避重试。 */
export function writeAtomic(filePath, content) {
  const abs = resolve(filePath)
  mkdirSync(dirname(abs), { recursive: true })
  atomicCounter += 1
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${atomicCounter}`
  const data = Buffer.isBuffer(content) ? content : String(content ?? '')
  writeFileSync(tmp, data, 'utf8')
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, abs)
        return
      } catch (error) {
        if (!WRITE_ATOMIC_RETRY_CODES.has(error?.code) || attempt >= WRITE_ATOMIC_BACKOFF_MS.length) {
          throw error
        }
        Atomics.wait(WRITE_ATOMIC_RETRY_BUF, 0, 0, WRITE_ATOMIC_BACKOFF_MS[attempt])
      }
    }
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

export const CODE_EXT_RE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|kts|rb|php|cs|fs|c|cc|cpp|h|hpp|swift|dart|sh|bash|ps1)$/i
export const BROAD_CODE_EXT_RE = /\.(?:js|mjs|cjs|mts|cts|ts|tsx|jsx|vue|svelte|astro|py|rs|go|java|kt|kts|scala|groovy|c|cc|cpp|cxx|h|hpp|m|mm|cs|fs|rb|php|sh|bash|zsh|ps1|psm1|lua|r|swift|dart|ex|exs|clj|hs|erl|jl|zig|nim|sol|sql|proto)$/i

export function matchGlob(filePath, pattern) {
  const f = posixPath(filePath).replace(/^\.\//, '').replace(/^\/+/, '')
  const p = posixPath(pattern).trim().replace(/^`+|`+$/g, '').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!f || !p) return false
  if (p.endsWith('/')) return f.startsWith(p)
  if (p.endsWith('/**') && !p.slice(0, -3).includes('*') && !p.slice(0, -3).includes('?')) {
    const base = p.slice(0, -3)
    return f === base || f.startsWith(`${base}/`)
  }
  if (!/[*?]/.test(p)) return f === p || f.startsWith(`${p}/`)

  let reStr = '^'
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          reStr += '(?:.*/)?'
          i += 2
        } else {
          reStr += '.*'
          i += 1
        }
      } else {
        reStr += '[^/]*'
      }
    } else if (p[i] === '?') {
      reStr += '[^/]'
    } else {
      reStr += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  reStr += '$'
  return new RegExp(reStr).test(f)
}

/**
 * 求值包含 `!` 负向排除模式的 glob 列表：
 * 需至少命中一条正向模式，且不被任何 `!` 负向模式排除。
 */
export function matchGlobList(filePath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const f = posixPath(filePath).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!f) return false
  const positives = []
  const negatives = []
  for (const raw of patterns) {
    const p = posixPath(raw).trim().replace(/^`+|`+$/g, '').replace(/\/+$/, '')
    if (!p) continue
    if (p.startsWith('!')) {
      const neg = p.slice(1).replace(/^\.\//, '').replace(/^\/+/, '')
      if (neg) negatives.push(neg)
    } else {
      positives.push(p)
    }
  }
  if (positives.length === 0) return false
  if (!positives.some((p) => matchGlob(f, p))) return false
  for (const neg of negatives) {
    if (matchGlob(f, neg)) return false
    if (neg.endsWith('/**') && matchGlob(f, neg.slice(0, -3))) return false
  }
  return true
}

const SCOPE_WILDCARD_RE = /[*?[]/
const FULL_REPO_SCOPE_SET = new Set(['.', '*', '**', './**', '**/*'])

/** 把 glob 与目录前缀统一编译为 `{ test, prefix, raw }` 判定器。 */
export function compileScopePattern(pattern) {
  const raw = posixPath(String(pattern ?? '')).replace(/^\.\//, '').trim()
  if (!raw) return null
  if (raw.endsWith('/**')) {
    const base = raw.slice(0, -3)
    return { test: (p) => p === base || p.startsWith(`${base}/`), prefix: base, raw }
  }
  if (raw.endsWith('/*')) {
    const base = raw.slice(0, -2)
    return { test: (p) => dirname(p) === base || (p.startsWith(`${base}/`) && !p.slice(base.length + 1).includes('/')), prefix: base, raw }
  }
  if (!raw.includes('*')) {
    const trimmed = raw.replace(/\/+$/, '')
    return { test: (p) => p === trimmed, prefix: trimmed, raw }
  }
  const escaped = raw
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return { test: (p) => re.test(p), prefix: null, raw }
}

function* scopeRangeProbe(prefix) {
  yield prefix
  yield `${prefix}/x`
  yield `${prefix}/x/y.ext`
  yield `${prefix}/x.ext`
}

function staticScopePrefixOf(pattern) {
  const segs = String(pattern ?? '').split('/')
  const kept = []
  for (const seg of segs) {
    if (!seg || SCOPE_WILDCARD_RE.test(seg)) break
    kept.push(seg)
  }
  return kept.join('/')
}

function concreteExtTailOf(pattern, prefix) {
  const rest = prefix ? pattern.slice(prefix.length + 1) : pattern
  const m = /^\*\.([a-z0-9]+)$/i.exec(rest)
  return m ? m[1].toLowerCase() : null
}

/**
 * 单源保守判定两个路径/通配 scope 条目（支持已编译匹配器对象或原始模式串）是否可能覆盖同一路径。
 */
export function scopePatternPairOverlaps(aIn, bIn) {
  const a = typeof aIn === 'string' ? compileScopePattern(aIn) : aIn
  const b = typeof bIn === 'string' ? compileScopePattern(bIn) : bIn
  if (!a || !b) return false
  if (a.raw === b.raw) return true
  if (FULL_REPO_SCOPE_SET.has(a.raw) || FULL_REPO_SCOPE_SET.has(b.raw)) return true
  const pa = a.prefix
  const pb = b.prefix
  if (pa && !pb) return b.test(pa) || [...scopeRangeProbe(pa)].some((p) => b.test(p))
  if (!pa && pb) return a.test(pb) || [...scopeRangeProbe(pb)].some((p) => a.test(p))
  if (pa && pb) {
    return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)
  }
  const preA = staticScopePrefixOf(a.raw)
  const preB = staticScopePrefixOf(b.raw)
  if (!preA || !preB) return true
  if (preA === preB) {
    const extA = concreteExtTailOf(a.raw, preA)
    const extB = concreteExtTailOf(b.raw, preB)
    if (extA && extB && extA !== extB) return false
    return true
  }
  return preA.startsWith(`${preB}/`) || preB.startsWith(`${preA}/`)
}



