/**
 * git-index-fast.mjs —— 零子进程解析 `.git/index` v2/v3、`.git`/commondir 路径探测与 porcelain-v2 解析。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 git-fast.mjs 重导出以保持向后兼容。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { posixPath, readTextSafe } from './git-core.mjs'

/** 快速向上探测是否存在祖先 `.git` 目录/文件（无环境覆盖且无 `.git` 时跳过 `git rev-parse` 子进程）。 */
export function hasDotGitInAncestors(startDir) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true
  const absStart = resolve(String(startDir ?? '.'))
  if (existsSync(join(absStart, 'HEAD')) && existsSync(join(absStart, 'config'))) return true
  let cur = absStart
  while (true) {
    if (existsSync(join(cur, '.git'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** 零子进程解析当前工作区 `.git` 目录（兼容普通仓与 linked worktree）。 */
export function resolveGitDirFast(repoRoot) {
  if (!repoRoot) return null
  const dotGit = join(repoRoot, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (m) return resolve(repoRoot, m[1].trim())
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 零子进程解析 Git 公共目录（`.git` 主目录）：
 * 默认接收仓库根目录（兼容普通 `.git/` 目录与 linked worktree `.git` 文件）；
 * 传入 `{ treatAsGitDir: true }` 时直接把参数视作 gitDir 并解析其 `commondir`。
 */
export function resolveCommonGitDir(repoRootOrGitDir, { treatAsGitDir = false } = {}) {
  if (!repoRootOrGitDir) return null
  const target = resolve(String(repoRootOrGitDir))
  if (!existsSync(target)) return null
  const gitDir = treatAsGitDir ? target : resolveGitDirFast(target)
  if (!gitDir || !existsSync(gitDir)) return null
  const cdFile = join(gitDir, 'commondir')
  if (existsSync(cdFile)) {
    const raw = (readTextSafe(cdFile) ?? '').trim()
    if (raw) {
      const common = isAbsolute(raw) ? resolve(raw) : resolve(gitDir, raw)
      if (existsSync(common)) return common
    }
  }
  return gitDir
}

function parseDircIndexBuffer(buf, { checkUnmergedOnly = false } = {}) {
  if (!buf || buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  const paths = checkUnmergedOnly ? null : new Set()
  let off = 12
  for (let i = 0; i < count; i += 1) {
    if (off + 62 >= buf.length) return null
    const flags = buf.readUInt16BE(off + 60)
    if ((flags & 0x3000) !== 0) return checkUnmergedOnly ? { unmerged: true } : null
    let nameOff = off + 62
    if (ver >= 3 && (flags & 0x4000) !== 0) {
      if (nameOff + 2 >= buf.length) return null
      nameOff += 2
    }
    const nul = buf.indexOf(0, nameOff)
    if (nul < 0) return null
    if (paths) paths.add(buf.toString('utf8', nameOff, nul))
    const len = nul - off + 1
    off += (len + 7) & ~7
  }
  if (off > buf.length - 20) return null
  while (off + 8 <= buf.length - 20) {
    const sig = buf.toString('ascii', off, off + 4)
    if (!/^[A-Za-z]{4}$/.test(sig) || sig === 'link' || sig === 'sdir') return null
    off += 8 + buf.readUInt32BE(off + 4)
  }
  if (off !== buf.length - 20) return null
  return checkUnmergedOnly ? { unmerged: false } : { paths }
}

/** 零子进程解析 Git index v2/v3 全部已跟踪路径集合（reftable/v4/sha256/异常返回 null）。 */
export function readGitIndexPathsFast(repoRootOrGitDir, { isGitDir = false, isSha256 = false } = {}) {
  if (!repoRootOrGitDir || isSha256) return null
  const wtGitDir = isGitDir ? resolve(String(repoRootOrGitDir)) : resolveGitDirFast(repoRootOrGitDir)
  if (!wtGitDir) return null
  const commonDir = resolveCommonGitDir(wtGitDir, { treatAsGitDir: true }) ?? wtGitDir
  if (existsSync(join(commonDir, 'reftable'))) return null
  const cfgTxt = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfgTxt)) return null
  const idxPath = join(wtGitDir, 'index')
  if (!existsSync(idxPath)) return isGitDir ? null : new Set()
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  return parseDircIndexBuffer(buf, { checkUnmergedOnly: false })?.paths ?? null
}

/** 零子进程检查相对路径是否在 Git index v2/v3 中已跟踪（reftable/v4/异常返回 null 交由 CLI 回退）。 */
export function isPathInGitIndexFast(repoRoot, relPath) {
  const paths = readGitIndexPathsFast(repoRoot)
  if (!paths) return null
  const target = posixPath(relPath).replace(/^\.\//, '').replace(/^\/+/, '')
  return paths.has(target)
}

/**
 * 零子进程检查 Git index v2/v3 是否存在未解决冲突条目（stage > 0）。
 * 确认无冲突返回 `false`，存在冲突返回 `true`，无 index 或非 v2/v3/异常格式返回 `null`（交由 git CLI 回退）。
 */
export function hasUnmergedIndexFast(wtGitDir) {
  if (!wtGitDir) return null
  const idxPath = join(wtGitDir, 'index')
  if (!existsSync(idxPath)) return false
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  const parsed = parseDircIndexBuffer(buf, { checkUnmergedOnly: true })
  return parsed ? parsed.unmerged : null
}

/** 解析 `git status --porcelain=v2 --branch -z` 输出。 */
export function parsePorcelainV2BranchZ(buf) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  let head = null
  let branch = null
  let dirty = 0
  const conflicts = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith('# branch.oid ')) {
      const val = tok.slice(13).trim()
      head = val && val !== '(initial)' ? val : null
    } else if (tok.startsWith('# branch.head ')) {
      const val = tok.slice(14).trim()
      branch = val || null
    } else if (!tok.startsWith('#')) {
      dirty += 1
      if (tok.startsWith('u ')) {
        const parts = tok.split(' ')
        const file = parts.slice(10).join(' ')
        if (file) conflicts.push(file)
      }
      if (tok.startsWith('2 ')) i += 1
    }
  }
  if (branch === '(detached)' && !head) branch = null
  return { head, branch, dirty, conflicts }
}
