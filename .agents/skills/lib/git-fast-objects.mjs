/**
 * git-fast-objects.mjs —— 零子进程松散 Git 对象、Tag/Reflog 读取、Immutable 缓存与 DAG 祖先遍历。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

import { readTextSafe } from './git-core.mjs'

/** 零子进程读取松散 Git 对象（自动解析 worktree commondir；仅 SHA-1 40 hex，packed/缺失返回 null）。 */
export function readGitObjectFast(gitDirOrCommonDir, sha) {
  if (!gitDirOrCommonDir || !sha || !/^[0-9a-f]{40}$/i.test(sha)) return null
  const cdTxt = readTextSafe(join(gitDirOrCommonDir, 'commondir'))
  const commonDir = cdTxt ? resolve(gitDirOrCommonDir, cdTxt.trim()) : gitDirOrCommonDir
  const low = sha.toLowerCase()
  const objPath = join(commonDir, 'objects', low.slice(0, 2), low.slice(2))
  if (!existsSync(objPath)) return null
  try {
    const raw = inflateSync(readFileSync(objPath))
    const nul = raw.indexOf(0)
    if (nul <= 0) return null
    const hdr = raw.subarray(0, nul).toString('ascii')
    const sp = hdr.indexOf(' ')
    if (sp <= 0) return null
    const type = hdr.slice(0, sp)
    const size = Number(hdr.slice(sp + 1))
    const bodyBuf = raw.subarray(nul + 1)
    if (!Number.isFinite(size) || bodyBuf.length !== size) return null
    return { type, bodyBuf }
  } catch {
    return null
  }
}

/** 零子进程读取松散 blob 文本内容（packed 或缺失返回 null）。 */
export function readGitBlobTextFast(gitCommonDir, sha) {
  const obj = readGitObjectFast(gitCommonDir, sha)
  if (!obj || obj.type !== 'blob') return null
  return obj.bodyBuf.toString('utf8').replace(/\r\n/g, '\n')
}

/** 零子进程检查仓库是否存在任意 tag（reftable 或异常返回 null 交由 CLI 回退）。 */
export function hasAnyTagFast(gitCommonDir) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp > 0 && line.slice(sp + 1).trim().startsWith('refs/tags/')) return true
    }
  }
  const tagsRoot = join(gitCommonDir, 'refs', 'tags')
  if (!existsSync(tagsRoot)) return false
  const stack = [tagsRoot]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name))
      else if (e.isFile()) return true
    }
  }
  return false
}

/** 零子进程读取 loose reflog 条目列表（最新在先，缺失或 reftable 返回 null）。 */
export function readReflogFast(gitCommonDir, fullRef) {
  if (!gitCommonDir || !fullRef || existsSync(join(gitCommonDir, 'reftable'))) return null
  const logPath = join(gitCommonDir, 'logs', ...String(fullRef).replace(/^\/+/, '').split('/'))
  const txt = readTextSafe(logPath)
  if (txt === undefined) return null
  const subjects = []
  for (const line of txt.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab >= 0) subjects.push(line.slice(tab + 1))
  }
  subjects.reverse()
  return subjects
}

/** 计算 `git diff --raw` 补丁主体从 `diff --git ` 起的 SHA-256 与字节长（与 `collectDiff` 字节一致）。 */
export function computePatchRawDigest(fullBuf) {
  const buf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.alloc(0)
  const at = buf.subarray(0, 11).toString('ascii') === 'diff --git '
    ? 0
    : (() => {
        const nlIdx = buf.indexOf('\ndiff --git ')
        return nlIdx >= 0 ? nlIdx + 1 : -1
      })()
  const rawBuf = at >= 0 ? buf.subarray(at) : Buffer.alloc(0)
  return {
    sha256: createHash('sha256').update(rawBuf).digest('hex'),
    bytes: rawBuf.length,
  }
}

/**
 * 零子进程沿有限 DAG 祖先探测 `ancestorSha` 是否为 `descendantSha` 祖先；
 * 仅在严格确认命中或穷尽全部祖先到达根时返回 boolean，遇到 packed/超深/reftable 返回 `null` 交由 CLI 回退。
 */
export function isAncestorLinearFast(gitCommonDir, ancestorSha, descendantSha, maxDepth = 40) {
  if (!gitCommonDir || !ancestorSha || !descendantSha) return null
  if (!/^[0-9a-f]{40}$/i.test(ancestorSha) || !/^[0-9a-f]{40}$/i.test(descendantSha)) return null
  const ancLow = ancestorSha.toLowerCase()
  const descLow = descendantSha.toLowerCase()
  if (ancLow === descLow) return true
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null

  const seen = new Set()
  const queue = [descLow]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur)) continue
    if (seen.size >= maxDepth) return null
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    seen.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    for (const m of hdr.matchAll(/^parent ([0-9a-f]{40})$/gm)) {
      const p = m[1].toLowerCase()
      if (p === ancLow) return true
      if (!seen.has(p)) queue.push(p)
    }
  }
  return false
}

/** 零子进程收集不超过 `maxCommits` 个提交的完整可达祖先 SHA 集合（超限/packed/shallow 返回 null）。 */
export function collectAncestorsDagFast(gitCommonDir, tipSha, maxCommits = 60) {
  if (!gitCommonDir || !tipSha || !/^[0-9a-f]{40}$/i.test(tipSha)) return null
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null
  const seen = new Set()
  const queue = [tipSha.toLowerCase()]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur)) continue
    if (seen.size >= maxCommits) return null
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    seen.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    for (const m of hdr.matchAll(/^parent ([0-9a-f]{40})$/gm)) {
      const p = m[1].toLowerCase()
      if (!seen.has(p)) queue.push(p)
    }
  }
  return seen
}

/** 零子进程等价计算 `git rev-list --count baseSha..targetSha`（仅当两端祖先 DAG 均 <= maxCommits 且全松散时命中）。 */
export function countCommitsAheadDagFast(gitCommonDir, baseSha, targetSha, maxCommits = 60) {
  const targetAnc = collectAncestorsDagFast(gitCommonDir, targetSha, maxCommits)
  if (!targetAnc) return null
  const baseAnc = collectAncestorsDagFast(gitCommonDir, baseSha, maxCommits)
  if (!baseAnc) return null
  let count = 0
  for (const s of targetAnc) if (!baseAnc.has(s)) count += 1
  return count
}

/** 零子进程沿 first-parent 链读取前 `limit` 个提交 SHA（等同 `git rev-list --first-parent -n limit`）。 */
export function readFirstParentsFast(gitCommonDir, tipSha, limit = 200) {
  if (!gitCommonDir || !tipSha || !/^[0-9a-f]{40}$/i.test(tipSha)) return null
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null
  const set = new Set()
  let cur = tipSha.toLowerCase()
  for (let i = 0; i < limit && cur; i += 1) {
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    set.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    const pm = /^parent ([0-9a-f]{40})$/m.exec(hdr)
    cur = pm ? pm[1].toLowerCase() : null
  }
  return set
}
