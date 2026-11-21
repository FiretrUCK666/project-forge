/**
 * git-fast-objects.mjs —— 零子进程松散 Git 对象、Tag/Reflog 读取、Immutable 缓存与 DAG 祖先遍历。
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

import { readTextSafe } from './git-core.mjs'

const PACK_TYPE_NAMES = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' })
const packIdxCache = new Map()

function loadPackIndexes(commonDir) {
  const packDir = join(commonDir, 'objects', 'pack')
  if (!existsSync(packDir)) return []
  let files
  try { files = readdirSync(packDir) } catch { return [] }
  const out = []
  for (const name of files) {
    if (!name.endsWith('.idx')) continue
    const idxPath = join(packDir, name)
    const packPath = `${idxPath.slice(0, -4)}.pack`
    if (!existsSync(packPath)) continue
    let cached = packIdxCache.get(idxPath)
    if (!cached) {
      try {
        const idxBuf = readFileSync(idxPath)
        if (idxBuf.length < 1032 || idxBuf.readUInt32BE(0) !== 0xff744f63 || idxBuf.readUInt32BE(4) !== 2) continue
        const total = idxBuf.readUInt32BE(8 + 255 * 4)
        const packSize = statSync(packPath).size
        cached = { idxPath, packPath, idxBuf, total, packSize, packBuf: null, fd: null }
        packIdxCache.set(idxPath, cached)
      } catch { continue }
    }
    out.push(cached)
  }
  return out
}

function findOffsetInPackIdx(entry, shaBuf) {
  const { idxBuf, total } = entry
  if (total === 0) return -1
  const b0 = shaBuf[0]
  let lo = b0 === 0 ? 0 : idxBuf.readUInt32BE(8 + (b0 - 1) * 4)
  let hi = idxBuf.readUInt32BE(8 + b0 * 4) - 1
  const shaTableOff = 1032
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const cmp = shaBuf.compare(idxBuf, shaTableOff + mid * 20, shaTableOff + (mid + 1) * 20)
    if (cmp === 0) {
      const offPos = shaTableOff + total * 24 + mid * 4
      const rawOff = idxBuf.readUInt32BE(offPos)
      if ((rawOff & 0x80000000) === 0) return rawOff
      const largeIdx = rawOff & 0x7fffffff
      const bigPos = shaTableOff + total * 28 + largeIdx * 8
      if (bigPos + 8 > idxBuf.length) return -1
      return Number(idxBuf.readBigUInt64BE(bigPos))
    }
    if (cmp < 0) hi = mid - 1
    else lo = mid + 1
  }
  return -1
}

function readDeltaSizeVarint(buf, pos) {
  let size = 0
  let shift = 0
  let p = pos
  while (p < buf.length) {
    const b = buf[p++]
    size |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return { size, next: p }
}

function applyGitDelta(baseBuf, deltaBuf) {
  const src = readDeltaSizeVarint(deltaBuf, 0)
  const dst = readDeltaSizeVarint(deltaBuf, src.next)
  if (baseBuf.length !== src.size) return null
  const out = Buffer.allocUnsafe(dst.size)
  let p = dst.next
  let outPos = 0
  while (p < deltaBuf.length) {
    const cmd = deltaBuf[p++]
    if (cmd & 0x80) {
      let cpOff = 0
      let cpSize = 0
      if (cmd & 0x01) cpOff = deltaBuf[p++]
      if (cmd & 0x02) cpOff |= deltaBuf[p++] << 8
      if (cmd & 0x04) cpOff |= deltaBuf[p++] << 16
      if (cmd & 0x08) cpOff |= (deltaBuf[p++] << 24) >>> 0
      if (cmd & 0x10) cpSize = deltaBuf[p++]
      if (cmd & 0x20) cpSize |= deltaBuf[p++] << 8
      if (cmd & 0x40) cpSize |= deltaBuf[p++] << 16
      if (cpSize === 0) cpSize = 0x10000
      baseBuf.copy(out, outPos, cpOff, cpOff + cpSize)
      outPos += cpSize
    } else if (cmd > 0) {
      deltaBuf.copy(out, outPos, p, p + cmd)
      p += cmd
      outPos += cmd
    } else {
      return null
    }
  }
  return outPos === dst.size ? out : null
}

function readPackSlice(packEntry, offset, len) {
  if (packEntry.packBuf) {
    const end = Math.min(packEntry.packSize, offset + len)
    return packEntry.packBuf.subarray(offset, end)
  }
  if (packEntry.fd === null) {
    packEntry.fd = openSync(packEntry.packPath, 'r')
    process.once('exit', () => {
      try { if (packEntry.fd !== null) closeSync(packEntry.fd) } catch { /* ignore */ }
      packEntry.fd = null
    })
  }
  const nToRead = Math.min(len, packEntry.packSize - offset)
  if (nToRead <= 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(nToRead)
  const n = readSync(packEntry.fd, buf, 0, nToRead, offset)
  return buf.subarray(0, n)
}

function readPackObjectAt(commonDir, packEntry, offset, depth = 0) {
  if (depth > 32 || offset < 12 || offset >= packEntry.packSize) return null
  const hdrBuf = readPackSlice(packEntry, offset, Math.min(64, packEntry.packSize - offset))
  if (hdrBuf.length < 2) return null
  let p = 0
  let c = hdrBuf[p++]
  const objType = (c >> 4) & 7
  let expectedSize = c & 0x0f
  let shift = 4
  while ((c & 0x80) !== 0 && p < hdrBuf.length) {
    c = hdrBuf[p++]
    expectedSize += (c & 0x7f) * (2 ** shift)
    shift += 7
  }
  let baseObj = null
  if (objType === 6) {
    let b = hdrBuf[p++]
    let negOff = b & 0x7f
    while ((b & 0x80) !== 0 && p < hdrBuf.length) {
      b = hdrBuf[p++]
      negOff = ((negOff + 1) << 7) | (b & 0x7f)
    }
    baseObj = readPackObjectAt(commonDir, packEntry, offset - negOff, depth + 1)
    if (!baseObj) return null
  } else if (objType === 7) {
    if (p + 20 > hdrBuf.length) return null
    const baseSha = hdrBuf.subarray(p, p + 20).toString('hex')
    p += 20
    baseObj = readGitObjectFast(commonDir, baseSha)
    if (!baseObj) return null
  } else if (!PACK_TYPE_NAMES[objType]) {
    return null
  }
  const compStart = offset + p
  let winSize = Math.min(packEntry.packSize - compStart, Math.max(4096, expectedSize * 2 + 256))
  while (winSize > 0) {
    const compSlice = readPackSlice(packEntry, compStart, winSize)
    if (compSlice.length <= 0) return null
    try {
      const inflated = inflateSync(compSlice)
      if (inflated.length !== expectedSize) return null
      if (baseObj) {
        const patched = applyGitDelta(baseObj.bodyBuf, inflated)
        return patched ? { type: baseObj.type, bodyBuf: patched } : null
      }
      return { type: PACK_TYPE_NAMES[objType], bodyBuf: inflated }
    } catch {
      if (compStart + winSize >= packEntry.packSize) return null
      winSize = Math.min(packEntry.packSize - compStart, winSize * 2)
    }
  }
  return null
}

function readGitPackedObjectFast(commonDir, lowHex) {
  const packs = loadPackIndexes(commonDir)
  if (packs.length === 0) return null
  const shaBuf = Buffer.from(lowHex, 'hex')
  for (const p of packs) {
    const offset = findOffsetInPackIdx(p, shaBuf)
    if (offset >= 0) {
      const obj = readPackObjectAt(commonDir, p, offset, 0)
      if (obj) return obj
    }
  }
  return null
}

/** 零子进程读取 Git 对象（先查松散对象，缺失时自动回退 pack/idx v2；自动解析 worktree commondir）。 */
export function readGitObjectFast(gitDirOrCommonDir, sha) {
  if (!gitDirOrCommonDir || !sha || !/^[0-9a-f]{40}$/i.test(sha)) return null
  const cdTxt = readTextSafe(join(gitDirOrCommonDir, 'commondir'))
  const commonDir = cdTxt ? resolve(gitDirOrCommonDir, cdTxt.trim()) : gitDirOrCommonDir
  const low = sha.toLowerCase()
  const objPath = join(commonDir, 'objects', low.slice(0, 2), low.slice(2))
  if (!existsSync(objPath)) return readGitPackedObjectFast(commonDir, low)
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
