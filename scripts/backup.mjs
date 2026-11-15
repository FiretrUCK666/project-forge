/**
 * 写前自动 `.zip` 快照与可逆恢复（纯 `node:zlib` zip，并向下兼容 `.tar.gz` / POSIX USTAR 恢复）。
 *
 * - 零第三方依赖、零外部命令行依赖，跨平台可运行。
 * - 存储位置绝对不污染工作区 `git status`：
 *   1) `PF_BACKUP_DIR/<slug>-<hash8>/`
 *   2) `<gitCommonDir>/project-forge-backups/`（兼容 worktree `.git` 文件解析）
 *   3) `~/.project-forge/backups/<slug>-<hash8>/`
 * - 统一复用 `COMMON_SKIP_DIRS`，自动跳过版本库、依赖缓存、构建产物目录与超 20MB 单文件。
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { tempPathFor, writeAtomic } from './lib/fs-atomic.mjs'
import { COMMON_SKIP_DIRS, isMacOsMetadata } from './lib/protocol.mjs'
import { flushAndExit, isMainModule, posixPath, readJsonSafe } from './lib/text.mjs'
import { readZip, writeZip } from './zip.mjs'

export const DEFAULT_MAX_KEEP = 5
export const MAX_BACKUP_FILE_BYTES = 20 * 1024 * 1024
export const MAX_RESTORE_TOTAL_BYTES = 512 * 1024 * 1024
export const BACKUP_SKIP_DIRS = COMMON_SKIP_DIRS

const BLOCK_SIZE = 512
const IN_MEM_CACHE_LIMIT_BYTES = 24 * 1024 * 1024

function writeAtomicBinary(filePath, buf) {
  const tmp = tempPathFor(filePath)
  writeFileSync(tmp, buf)
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

/** 按 UTF-8 字节长度安全截断字符串，绝不在多字节字符中间劈裂。 */
export function truncateUtf8Bytes(str, maxBytes) {
  const buf = Buffer.from(String(str ?? ''), 'utf8')
  if (buf.length <= maxBytes) return buf
  let end = Math.max(0, maxBytes)
  if (end < buf.length && (buf[end] & 0xC0) === 0x80) {
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end -= 1
  }
  return buf.subarray(0, end)
}

/** 解析目标目录对应的 Git common directory（兼容常规仓库与 worktree `.git` 文件）。 */
export function findGitCommonDir(startDir) {
  let cur = resolve(startDir)
  while (true) {
    const dotGit = join(cur, '.git')
    if (existsSync(dotGit)) {
      try {
        const st = statSync(dotGit)
        if (st.isDirectory()) return dotGit
        if (st.isFile()) {
          const text = readFileSync(dotGit, 'utf8')
          const m = /^gitdir:\s*(.+)$/im.exec(text)
          if (!m) return undefined
          const rawDir = m[1].trim()
          const gitDir = isAbsolute(rawDir) ? rawDir : resolve(cur, rawDir)
          const commondirFile = join(gitDir, 'commondir')
          if (existsSync(commondirFile)) {
            const relCommon = readFileSync(commondirFile, 'utf8').trim()
            return isAbsolute(relCommon) ? resolve(relCommon) : resolve(gitDir, relCommon)
          }
          return gitDir
        }
      } catch {
        return undefined
      }
    }
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
}

/** 对目标路径按最深存在祖先 realpathSync.native + NFC 归一，消除软链与大小写/编码差异。 */
export function canonicalBackupPath(p) {
  const abs = resolve(String(p ?? ''))
  let head = abs
  const tail = []
  for (;;) {
    try {
      const real = realpathSync.native(head)
      return (tail.length > 0 ? join(real, ...tail.reverse()) : real).normalize('NFC')
    } catch {
      const up = dirname(head)
      if (up === head) return abs.normalize('NFC')
      tail.push(basename(head))
      head = up
    }
  }
}

/** 计算目标项目的零污染快照目录路径。 */
export function resolveBackupDir(targetDir, { env = process.env } = {}) {
  const root = canonicalBackupPath(targetDir)
  const hashInput = process.platform === 'win32' ? root.toLowerCase() : root
  const hash8 = createHash('sha256').update(hashInput).digest('hex').slice(0, 8)
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'
  const bucket = `${slug}-${hash8}`

  const envBase = typeof env?.PF_BACKUP_DIR === 'string' ? env.PF_BACKUP_DIR.trim() : ''
  if (envBase) {
    return join(resolve(envBase), bucket)
  }

  const gitCommon = findGitCommonDir(root)
  if (gitCommon) {
    return join(gitCommon, 'project-forge-backups')
  }

  return join(homedir(), '.project-forge', 'backups', bucket)
}

function assertSafeRelPath(rel) {
  const clean = posixPath(rel).replace(/^(?:\.\/)+/, '')
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\0')) {
    throw new Error(`快照条目路径不安全：${rel}`)
  }
  const parts = clean.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`快照条目包含越界路径段：${rel}`)
  }
  if (parts.slice(0, -1).some((p) => BACKUP_SKIP_DIRS.has(p))) {
    throw new Error(`快照条目命中保留跳过目录：${rel}`)
  }
  return clean
}

function writeOctal(buf, offset, length, value) {
  const oct = Math.max(0, Math.floor(value)).toString(8)
  const maxDigits = length - 1
  if (oct.length > maxDigits) {
    throw new Error(`数值超出 USTAR 八进制字段上限：${value}`)
  }
  const padded = `${oct.padStart(maxDigits, '0')}\0`
  buf.write(padded, offset, length, 'ascii')
}

function splitUstarPath(relPath) {
  const full = Buffer.from(relPath, 'utf8')
  if (full.length <= 100) {
    return { nameBuf: full, prefixBuf: Buffer.alloc(0), needsPax: false }
  }
  let searchFrom = relPath.indexOf('/')
  while (searchFrom !== -1) {
    const candidatePrefix = relPath.slice(0, searchFrom)
    const candidateName = relPath.slice(searchFrom + 1)
    const prefixBuf = Buffer.from(candidatePrefix, 'utf8')
    const nameBuf = Buffer.from(candidateName, 'utf8')
    if (prefixBuf.length <= 155 && nameBuf.length > 0 && nameBuf.length <= 100) {
      return { nameBuf, prefixBuf, needsPax: false }
    }
    searchFrom = relPath.indexOf('/', searchFrom + 1)
  }
  return {
    nameBuf: truncateUtf8Bytes(relPath, 100),
    prefixBuf: Buffer.alloc(0),
    needsPax: true,
  }
}

function buildPaxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  let total = String(bodyBytes).length + bodyBytes
  while (String(total).length + bodyBytes !== total) {
    total = String(total).length + bodyBytes
  }
  return Buffer.from(`${total}${body}`, 'utf8')
}

function buildUstarHeader({ nameBuf, prefixBuf, mode, size, mtimeSec, typeflag }) {
  const hdr = Buffer.alloc(BLOCK_SIZE, 0)
  nameBuf.copy(hdr, 0, 0, Math.min(nameBuf.length, 100))
  writeOctal(hdr, 100, 8, mode & 0o7777)
  writeOctal(hdr, 108, 8, 0)
  writeOctal(hdr, 116, 8, 0)
  writeOctal(hdr, 124, 12, size)
  writeOctal(hdr, 136, 12, mtimeSec)
  hdr.fill(0x20, 148, 156)
  hdr.write(typeflag, 156, 1, 'ascii')
  hdr.write('ustar\0', 257, 6, 'ascii')
  hdr.write('00', 263, 2, 'ascii')
  writeOctal(hdr, 329, 8, 0)
  writeOctal(hdr, 337, 8, 0)
  if (prefixBuf.length > 0) {
    prefixBuf.copy(hdr, 345, 0, Math.min(prefixBuf.length, 155))
  }

  let checksum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += hdr[i]
  const chkStr = `${checksum.toString(8).padStart(6, '0')}\0 `
  hdr.write(chkStr, 148, 8, 'ascii')
  return hdr
}

function padBlockChunk(buf) {
  const rem = buf.length % BLOCK_SIZE
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - rem, 0)])
}

/** 将文件数组编码为标准 POSIX USTAR tar Buffer（兼容 `--format tar.gz` 与恢复）。 */
export function packTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const rel = assertSafeRelPath(entry.relPath)
    const data = typeof entry.readData === 'function'
      ? entry.readData()
      : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ''))
    const mode = typeof entry.mode === 'number' ? (entry.mode & 0o777) : 0o644
    const mtimeSec = typeof entry.mtimeMs === 'number' ? Math.floor(entry.mtimeMs / 1000) : Math.floor(Date.now() / 1000)

    const split = splitUstarPath(rel)
    if (split.needsPax) {
      const paxPayload = buildPaxRecord('path', rel)
      const paxName = truncateUtf8Bytes(`PaxHeaders/${basename(rel)}`, 95)
      chunks.push(buildUstarHeader({
        nameBuf: paxName,
        prefixBuf: Buffer.alloc(0),
        mode: 0o644,
        size: paxPayload.length,
        mtimeSec,
        typeflag: 'x',
      }))
      chunks.push(padBlockChunk(paxPayload))
    }

    chunks.push(buildUstarHeader({
      nameBuf: split.nameBuf,
      prefixBuf: split.prefixBuf,
      mode,
      size: data.length,
      mtimeSec,
      typeflag: '0',
    }))
    if (data.length > 0) {
      chunks.push(padBlockChunk(data))
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0))
  return Buffer.concat(chunks)
}

function readZeroTermAscii(buf, start, length) {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

function verifyHeaderChecksum(hdr) {
  const expectedStr = readZeroTermAscii(hdr, 148, 8).trim()
  const expected = Number.parseInt(expectedStr, 8)
  if (!Number.isFinite(expected)) return false
  let actual = 0
  for (let i = 0; i < BLOCK_SIZE; i++) {
    actual += i >= 148 && i < 156 ? 0x20 : hdr[i]
  }
  return actual === expected
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false
  }
  return true
}

function parsePaxRecords(buf) {
  const attrs = {}
  const text = buf.toString('utf8')
  let idx = 0
  while (idx < text.length) {
    const sp = text.indexOf(' ', idx)
    const nl = text.indexOf('\n', idx)
    if (sp === -1 || nl === -1) break
    const line = text.slice(sp + 1, nl)
    const eq = line.indexOf('=')
    if (eq > 0) {
      attrs[line.slice(0, eq)] = line.slice(eq + 1)
    }
    idx = nl + 1
  }
  return attrs
}

/** 解析标准 POSIX USTAR tar Buffer 为文件列表，校验校验和与路径安全性。 */
export function unpackTar(tarBuf) {
  if (!Buffer.isBuffer(tarBuf) || tarBuf.length % BLOCK_SIZE !== 0) {
    throw new Error('tar 归档格式无效（非 512 字节对齐）')
  }
  const files = []
  let offset = 0
  let nextPax = {}

  while (offset + BLOCK_SIZE <= tarBuf.length) {
    const hdr = tarBuf.subarray(offset, offset + BLOCK_SIZE)
    offset += BLOCK_SIZE
    if (isZeroBlock(hdr)) break
    if (!verifyHeaderChecksum(hdr)) {
      throw new Error('tar 归档校验和失败，快照文件可能已损坏')
    }

    const name = readZeroTermAscii(hdr, 0, 100)
    const prefix = readZeroTermAscii(hdr, 345, 155)
    const rawMode = Number.parseInt(readZeroTermAscii(hdr, 100, 8).trim(), 8)
    const size = Number.parseInt(readZeroTermAscii(hdr, 124, 12).trim(), 8) || 0
    const mtimeSec = Number.parseInt(readZeroTermAscii(hdr, 136, 12).trim(), 8) || 0
    const typeflag = String.fromCharCode(hdr[156])

    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (offset + paddedSize > tarBuf.length) {
      throw new Error('tar 归档提前截断')
    }
    const data = Buffer.from(tarBuf.subarray(offset, offset + size))
    offset += paddedSize

    if (typeflag === 'x') {
      nextPax = { ...nextPax, ...parsePaxRecords(data) }
      continue
    }
    if (typeflag === '5') {
      nextPax = {}
      continue
    }
    if (typeflag === '0' || typeflag === '\0') {
      const combined = nextPax.path || (prefix ? `${prefix}/${name}` : name)
      nextPax = {}
      files.push({
        relPath: assertSafeRelPath(combined),
        data,
        mode: Number.isFinite(rawMode) ? (rawMode & 0o777) : 0o644,
        mtimeMs: mtimeSec * 1000,
      })
    } else {
      nextPax = {}
    }
  }

  return files
}

function isInsideRelPrefix(relPath, backupRelPrefix) {
  if (!backupRelPrefix) return false
  return relPath === backupRelPrefix || relPath.startsWith(`${backupRelPrefix}/`)
}

function collectEligibleWorkspaceFiles(canonRoot, canonBackupDir) {
  const entries = []
  const skippedLarge = []
  if (!existsSync(canonRoot)) return { entries, skippedLarge }

  let backupRelPrefix = ''
  if (canonBackupDir && canonBackupDir.startsWith(canonRoot + sep)) {
    backupRelPrefix = posixPath(relative(canonRoot, canonBackupDir))
  }

  function visit(dir, relPrefix) {
    let dirEntries = []
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirEntries) {
      if (d.isSymbolicLink()) continue
      if (d.name === '.git' || isMacOsMetadata(d.name)) continue
      const relPath = relPrefix ? `${relPrefix}/${d.name}` : d.name
      if (isInsideRelPrefix(relPath, backupRelPrefix)) continue
      const abs = join(dir, d.name)
      if (d.isDirectory()) {
        if (BACKUP_SKIP_DIRS.has(d.name)) continue
        visit(abs, relPath)
        continue
      }
      if (!d.isFile()) continue
      if (/\.tmp-\d+(?:-\d+)*$/.test(d.name)) continue
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.size > MAX_BACKUP_FILE_BYTES) {
        skippedLarge.push(relPath)
        continue
      }
      entries.push({
        relPath,
        absPath: abs,
        size: st.size,
        mode: st.mode & 0o777,
        mtimeMs: st.mtimeMs,
      })
    }
  }

  visit(canonRoot, '')
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { entries, skippedLarge }
}

function readIndex(indexPath, root) {
  const existing = readJsonSafe(indexPath)
  if (existing && typeof existing === 'object' && Array.isArray(existing.backups)) {
    return {
      schemaVersion: 1,
      target: existing.target || root,
      backups: existing.backups.filter((b) => b && typeof b.id === 'string' && typeof b.archive === 'string'),
    }
  }
  return { schemaVersion: 1, target: root, backups: [] }
}

function makeSnapshotId(label) {
  const iso = new Date().toISOString().replace(/[-:.]/g, '')
  const rand = randomBytes(2).toString('hex')
  const safeLabel = String(label || 'write')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'write'
  return `${iso}-${rand}-${safeLabel}`
}

function pruneEmptyParentsWithin(filePath, rootDir) {
  let cur = dirname(filePath)
  const stop = resolve(rootDir)
  while (cur.length > stop.length && cur.startsWith(stop + sep)) {
    try {
      if (readdirSync(cur).length > 0) break
      rmdirSync(cur)
      cur = dirname(cur)
    } catch {
      break
    }
  }
}

function computeTreeShaAndPrepareReaders(entries, totalBytes, { dryRun }) {
  const retainCache = !dryRun && totalBytes <= IN_MEM_CACHE_LIMIT_BYTES
  const cache = retainCache ? new Array(entries.length) : null
  const h = createHash('sha256')
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const data = readFileSync(entry.absPath)
    const dataSha = createHash('sha256').update(data).digest('hex')
    h.update(`${entry.relPath}\0${entry.size}\0${dataSha}\0`)
    if (cache) cache[i] = data
  }
  const readers = entries.map((entry, i) => ({
    ...entry,
    readData: () => {
      if (cache && cache[i] !== undefined) {
        const buf = cache[i]
        cache[i] = undefined
        return buf
      }
      return readFileSync(entry.absPath)
    },
  }))
  return { treeSha256: h.digest('hex'), readers }
}

/**
 * 为 `<targetDir>` 创建一份滚动 `.zip`（或 `--format tar.gz`）快照并更新 `index.json`。
 */
export function createBackup(targetDir, {
  label = 'write',
  format = 'zip',
  maxKeep = DEFAULT_MAX_KEEP,
  dryRun = false,
  hasPendingChanges = true,
  force = false,
  env = process.env,
} = {}) {
  if (format !== 'zip' && format !== 'tar.gz') {
    throw new Error(`不支持的快照格式：${format}（仅支持 zip 或 tar.gz）`)
  }
  const root = canonicalBackupPath(targetDir)
  const backupDir = resolveBackupDir(root, { env })
  const canonBackupDir = canonicalBackupPath(backupDir)

  if (hasPendingChanges === false) {
    return { created: false, skippedReason: 'no-pending-changes', backupDir }
  }
  if (!existsSync(root)) {
    return { created: false, skippedReason: 'empty-target', backupDir }
  }

  const indexPath = join(backupDir, 'index.json')
  const index = readIndex(indexPath, root)
  const latest = index.backups.length > 0 ? index.backups[index.backups.length - 1] : undefined
  const needHashes = !dryRun || (!force && Boolean(latest?.treeSha256))

  const { entries, skippedLarge } = collectEligibleWorkspaceFiles(root, canonBackupDir)
  if (entries.length === 0) {
    return { created: false, skippedReason: 'empty-target', backupDir }
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
  let treeSha256
  let packedEntries = entries
  if (needHashes) {
    const prep = computeTreeShaAndPrepareReaders(entries, totalBytes, { dryRun })
    treeSha256 = prep.treeSha256
    packedEntries = prep.readers
  }

  if (!force && latest && latest.treeSha256 && treeSha256 && latest.treeSha256 === treeSha256) {
    const latestArchivePath = join(backupDir, latest.archive)
    if (existsSync(latestArchivePath)) {
      return {
        created: false,
        skippedReason: 'unchanged-since-latest',
        id: latest.id,
        backupDir,
        archivePath: latestArchivePath,
      }
    }
  }

  const existingPaths = entries.map((e) => e.relPath)
  const id = makeSnapshotId(label)
  const archiveName = format === 'zip' ? `${id}.zip` : `${id}.tar.gz`
  const archivePath = join(backupDir, archiveName)

  if (dryRun) {
    return {
      created: false,
      dryRun: true,
      skippedReason: 'dry-run',
      id,
      label,
      format,
      backupDir,
      archivePath,
      count: entries.length,
      totalBytes,
      skippedLarge,
    }
  }

  mkdirSync(backupDir, { recursive: true })
  let archiveBuf = format === 'zip'
    ? writeZip(packedEntries, { level: 6 })
    : gzipSync(packTar(packedEntries), { level: 6 })
  writeAtomicBinary(archivePath, archiveBuf)
  archiveBuf = null

  index.backups.push({
    id,
    label,
    format,
    createdAt: new Date().toISOString(),
    archive: archiveName,
    fileCount: entries.length,
    totalBytes,
    treeSha256,
    existingPaths,
    ...(skippedLarge.length > 0 ? { skippedLarge } : {}),
  })

  const pruned = []
  const keepLimit = Number.isInteger(maxKeep) && maxKeep > 0 ? maxKeep : DEFAULT_MAX_KEEP
  while (index.backups.length > keepLimit) {
    let pinnedIdx = -1
    for (let i = index.backups.length - 1; i >= 0; i -= 1) {
      if (index.backups[i]?.label === 'pre-forge') {
        pinnedIdx = i
        break
      }
    }
    let evictIdx = -1
    for (let i = 0; i < index.backups.length - 1; i += 1) {
      if (i === pinnedIdx) continue
      evictIdx = i
      break
    }
    if (evictIdx === -1) break
    const [oldest] = index.backups.splice(evictIdx, 1)
    if (!oldest) break
    pruned.push(oldest.id)
    const oldArchive = join(backupDir, oldest.archive)
    if (existsSync(oldArchive)) {
      try { unlinkSync(oldArchive) } catch { /* ignore */ }
    }
  }

  writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`)

  return {
    created: true,
    id,
    label,
    format,
    backupDir,
    archivePath,
    count: entries.length,
    totalBytes,
    treeSha256,
    pruned,
    skippedLarge,
  }
}

/** 写前防呆快照封装：无待写变动或空目录时静默跳过，绝不写冗余空包。 */
export function ensurePreWriteBackup(targetDir, opts = {}) {
  const {
    label = 'write', format = 'zip', maxKeep = DEFAULT_MAX_KEEP,
    hasPendingChanges = true, dryRun = false, force = false, env = process.env,
  } = opts
  if (hasPendingChanges === false) {
    return { created: false, skippedReason: 'no-pending-changes', backupDir: resolveBackupDir(targetDir, { env }) }
  }
  return createBackup(targetDir, { label, format, maxKeep, dryRun, hasPendingChanges, force, env })
}

/** 列出指定工作区已有快照（按最新在前顺序）。 */
export function listBackups(targetDir, { env = process.env } = {}) {
  const root = canonicalBackupPath(targetDir)
  const backupDir = resolveBackupDir(root, { env })
  const index = readIndex(join(backupDir, 'index.json'), root)
  const backups = [...index.backups].reverse().map((b) => ({
    ...b,
    format: b.format || (b.archive.endsWith('.tar.gz') ? 'tar.gz' : 'zip'),
    archivePath: join(backupDir, b.archive),
    exists: existsSync(join(backupDir, b.archive)),
  }))
  return { target: root, backupDir, backups }
}

function decodeArchiveEntries(archiveBuf, archiveName, declaredFormat) {
  const isZipMagic = archiveBuf.length >= 2 && archiveBuf[0] === 0x50 && archiveBuf[1] === 0x4b
  const isGzipMagic = archiveBuf.length >= 2 && archiveBuf[0] === 0x1f && archiveBuf[1] === 0x8b
  const useZip = isZipMagic || (!isGzipMagic && (declaredFormat === 'zip' || archiveName.endsWith('.zip')))
  if (useZip) {
    return readZip(archiveBuf, {
      maxTotalBytes: MAX_RESTORE_TOTAL_BYTES,
      maxEntryBytes: MAX_BACKUP_FILE_BYTES,
    }).map((e) => ({
      relPath: assertSafeRelPath(e.name),
      data: e.data,
      mode: e.mode ?? 0o644,
      mtimeMs: e.mtimeMs ?? 0,
    }))
  }
  const tarBuf = gunzipSync(archiveBuf)
  return unpackTar(tarBuf)
}

/** 恢复指定快照（默认 `latest`，兼容 `.zip` 与历史 `.tar.gz`），写回历史文件并清理无主文件。 */
export function restoreBackup(targetDir, {
  id = 'latest',
  dryRun = false,
  env = process.env,
} = {}) {
  const root = canonicalBackupPath(targetDir)
  const backupDir = resolveBackupDir(root, { env })
  const canonBackupDir = canonicalBackupPath(backupDir)
  const index = readIndex(join(backupDir, 'index.json'), root)

  if (index.backups.length === 0) {
    throw new Error(`找不到任何可恢复快照：${backupDir}`)
  }

  const chosen = (!id || id === 'latest')
    ? index.backups[index.backups.length - 1]
    : index.backups.find((b) => b.id === id)
  if (!chosen) {
    throw new Error(`找不到指定快照 ID：${id}`)
  }

  const archivePath = join(backupDir, chosen.archive)
  if (!existsSync(archivePath)) {
    throw new Error(`快照归档文件缺失：${archivePath}`)
  }

  let rawArchive = readFileSync(archivePath)
  const archivedFiles = decodeArchiveEntries(rawArchive, chosen.archive, chosen.format)
  rawArchive = null

  const existingSet = new Set(
    Array.isArray(chosen.existingPaths) && chosen.existingPaths.length > 0
      ? chosen.existingPaths.map((p) => assertSafeRelPath(p))
      : archivedFiles.map((f) => f.relPath),
  )

  const current = collectEligibleWorkspaceFiles(root, canonBackupDir)
  const removedOrphans = []
  for (const cur of current.entries) {
    if (!existingSet.has(cur.relPath)) {
      removedOrphans.push(cur.relPath)
    }
  }

  const restoredNames = archivedFiles.map((f) => f.relPath)
  if (!dryRun) {
    mkdirSync(root, { recursive: true })
    for (const file of archivedFiles) {
      const dest = join(root, file.relPath)
      mkdirSync(dirname(dest), { recursive: true })
      writeAtomicBinary(dest, file.data)
      file.data = null
      if (process.platform !== 'win32' && typeof file.mode === 'number') {
        try { chmodSync(dest, file.mode) } catch { /* ignore */ }
      }
    }
    for (const orphanRel of removedOrphans) {
      const orphanAbs = join(root, orphanRel)
      try {
        unlinkSync(orphanAbs)
        pruneEmptyParentsWithin(orphanAbs, root)
      } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    target: root,
    id: chosen.id,
    label: chosen.label,
    dryRun,
    backupDir,
    restored: restoredNames,
    removedOrphans,
  }
}

function usage() {
  return [
    '用法：node scripts/backup.mjs <create|list|restore> [目标目录] [选项]',
    '',
    '  create                   创建当前工作区写前快照（默认 .zip + index.json，兼容 .tar.gz）',
    '  list                     列出可用快照',
    '  restore                  恢复快照并清理快照之后新增的无主文件（自动识别 .zip / .tar.gz）',
    '',
    '  --label <op>             快照标签（默认 manual）',
    '  --format <zip|tar.gz>    快照格式（默认 zip）',
    '  --id <id|latest>         要恢复的快照 ID（默认 latest）',
    `  --max-keep <n>           最多保留快照份数（默认 ${DEFAULT_MAX_KEEP}）`,
    '  --force                  即使工作区内容与最新快照一致也强制写入新快照',
    '  --dry-run                仅模拟不写盘',
    '  --json                   输出 JSON 格式结果',
    '',
  ].join('\n')
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage())
    return 0
  }

  const command = argv[0]
  if (!command || command.startsWith('-') || !['create', 'list', 'restore'].includes(command)) {
    process.stderr.write('请指定子命令 create | list | restore（用 --help 看用法）\n')
    return 2
  }

  let target = process.cwd()
  let targetSet = false
  let label = 'manual'
  let format = 'zip'
  let id = 'latest'
  let maxKeep = DEFAULT_MAX_KEEP
  let dryRun = false
  let force = false
  let asJson = false

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--force') force = true
    else if (arg === '--json') asJson = true
    else if (arg === '--label') label = argv[++i] ?? label
    else if (arg.startsWith('--label=')) label = arg.slice('--label='.length)
    else if (arg === '--format') format = argv[++i] ?? format
    else if (arg.startsWith('--format=')) format = arg.slice('--format='.length)
    else if (arg === '--id') id = argv[++i] ?? id
    else if (arg.startsWith('--id=')) id = arg.slice('--id='.length)
    else if (arg === '--max-keep') maxKeep = Number(argv[++i])
    else if (arg.startsWith('--max-keep=')) maxKeep = Number(arg.slice('--max-keep='.length))
    else if (!arg.startsWith('-') && !targetSet) {
      target = arg
      targetSet = true
    } else {
      process.stderr.write(`未知参数：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    if (command === 'create') {
      const res = createBackup(target, { label, format, maxKeep, dryRun, force })
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else if (res.created) {
        process.stdout.write(`已创建快照 ${res.id}（${res.count} 个文件）→ ${res.archivePath}\n`)
      } else {
        process.stdout.write(`未创建快照（${res.skippedReason}）：${res.backupDir}\n`)
      }
      return 0
    }

    if (command === 'list') {
      const res = listBackups(target)
      if (asJson) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else if (res.backups.length === 0) {
        process.stdout.write(`暂无快照：${res.backupDir}\n`)
      } else {
        process.stdout.write(`快照目录：${res.backupDir}\n`)
        for (const b of res.backups) {
          process.stdout.write(`- ${b.id} [${b.label}] (${b.fileCount} 文件, ${b.createdAt})${b.exists ? '' : ' [归档缺失]'}\n`)
        }
      }
      return 0
    }

    const res = restoreBackup(target, { id, dryRun })
    if (asJson) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    } else {
      const prefix = dryRun ? '[dry-run] 计划恢复' : '已恢复'
      process.stdout.write(`${prefix}快照 ${res.id}：写回 ${res.restored.length} 个文件，清理新增无主文件 ${res.removedOrphans.length} 个。\n`)
    }
    return 0
  } catch (err) {
    process.stderr.write(`backup 失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`backup 失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
