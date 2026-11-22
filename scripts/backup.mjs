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
import { assertSafeRelPath, packTar, truncateUtf8Bytes, unpackTar } from './lib/tar.mjs'
import { flushAndExit, isMainModule, posixPath, readJsonSafe } from './lib/text.mjs'
import { recordStepStateSafe } from '../kit/skills/lib/session-state.mjs'
import { readZip, writeZip } from './zip.mjs'

export { packTar, truncateUtf8Bytes, unpackTar }

export const DEFAULT_MAX_KEEP = 5
export const MAX_BACKUP_FILE_BYTES = 20 * 1024 * 1024
export const MAX_RESTORE_TOTAL_BYTES = 512 * 1024 * 1024
export const BACKUP_SKIP_DIRS = COMMON_SKIP_DIRS

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
  if (!dryRun) recordStepStateSafe(root, { step: 'S2', ok: true, summary: `backup:${id}` })

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
