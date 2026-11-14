/**
 * update-ops.mjs —— 自更新暂存校验、状态节流与退役递归清理辅助模块。
 *
 * 仅依赖 node:* 内置模块与同层 lib/。供 scripts/update.mjs 调用，
 * 保证主脚本维持精简可读，并实现「同盘 staging 校验 -> 先备后写 ->
 * 最后原子替换 SKILL.md -> 异常原地回滚」的原子语义。
 */

import { createHash } from 'node:crypto'
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { writeAtomic } from './fs-atomic.mjs'
import { isMacOsMetadata, isMacOsMetadataPath, isRepoOnlyPath } from './protocol.mjs'
import { frontmatterBlock, posixPath, skillVersion } from './text.mjs'

/** 离线或核对失败后的短冷却时间：防止离线环境每次启动重复等满网络超时。 */
export const FAILURE_COOLDOWN_MS = 15 * 60 * 1000

/** 对路径按最深存在祖先做 realpathSync.native + NFC 归一，避免软链/NFD 导致键分裂。 */
export function canonicalRealPath(p) {
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

function deepestExistingDir(dirPath) {
  let cur = resolve(dirPath)
  for (;;) {
    if (existsSync(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

function isWritableDirCandidate(dirPath) {
  try {
    const existing = deepestExistingDir(dirPath)
    if (!statSync(existing).isDirectory()) return false
    accessSync(existing, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 优先解析当前用户专属缓存目录（避免共享 /tmp 碰撞与权限污染），不可写时回退 os.tmpdir()。
 */
export function resolveCacheDir() {
  const candidates = []
  if (process.platform === 'win32') {
    const localAppData = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA.trim() : ''
    if (localAppData) candidates.push(join(localAppData, 'project-forge', 'cache'))
    candidates.push(join(homedir(), 'AppData', 'Local', 'project-forge', 'cache'))
  } else if (process.platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Caches', 'project-forge'))
  } else {
    const xdg = typeof process.env.XDG_CACHE_HOME === 'string' ? process.env.XDG_CACHE_HOME.trim() : ''
    if (xdg) candidates.push(join(xdg, 'project-forge'))
    candidates.push(join(homedir(), '.cache', 'project-forge'))
  }

  for (const dir of candidates) {
    if (isWritableDirCandidate(dir)) return dir
  }
  return tmpdir()
}

/** 按归一化后的副本真实路径生成唯一状态文件路径。 */
export function resolveStatePath(skillRoot) {
  const key = canonicalRealPath(skillRoot)
  const hashInput = process.platform === 'win32' ? key.toLowerCase() : key
  const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 12)
  return join(resolveCacheDir(), `project-forge-update-${hash}.json`)
}

function sanitizeTimestamp(value, now) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > now) return 0
  return n
}

/** 读更新状态；对负数、NaN 与超过当前墙钟的未来时间戳自动清零自愈。 */
export function readStateFrom(statePath, now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    return {
      lastUpdateAt: sanitizeTimestamp(raw?.lastUpdateAt, now),
      lastOkAt: sanitizeTimestamp(raw?.lastOkAt, now),
      lastNoticeAt: sanitizeTimestamp(raw?.lastNoticeAt, now),
      lastFailAt: sanitizeTimestamp(raw?.lastFailAt, now),
    }
  } catch {
    return { lastUpdateAt: 0, lastOkAt: 0, lastNoticeAt: 0, lastFailAt: 0 }
  }
}

/** 读-改-写状态文件；若用户缓存目录写入失败则回退到 os.tmpdir()。 */
export function rememberStateAt(statePath, patch, now = Date.now()) {
  const next = { ...readStateFrom(statePath, now), ...patch }
  const payload = `${JSON.stringify(next)}\n`
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeAtomic(statePath, payload)
    return statePath
  } catch {
    try {
      const fallback = join(tmpdir(), basename(statePath))
      writeAtomic(fallback, payload)
      return fallback
    } catch {
      return undefined
    }
  }
}

/** 在指定根目录下创建临时 staging 目录（优先同盘父目录，不可写时回退根内隐蔽临时目录）。 */
export function createSameDiskStageDir(skillRoot) {
  const parent = dirname(resolve(skillRoot))
  try {
    return mkdtempSync(join(parent, '.project-forge-stage-'))
  } catch {
    return mkdtempSync(join(resolve(skillRoot), '.pf-update-stage-'))
  }
}

function isSafeRelativeEntry(rel) {
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) return false
  const parts = rel.split('/')
  return !parts.some((seg) => seg === '' || seg === '.' || seg === '..')
}

function isInsideDir(baseDir, candidate) {
  const root = canonicalRealPath(baseDir)
  const full = canonicalRealPath(candidate)
  if (full === root) return true
  return full.startsWith(root.endsWith(sep) ? root : root + sep)
}

function hasAnyRegularFile(dirPath) {
  if (!existsSync(dirPath)) return false
  try {
    if (!statSync(dirPath).isDirectory()) return false
    const stack = [dirPath]
    while (stack.length > 0) {
      const cur = stack.pop()
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        if (isMacOsMetadata(entry.name)) continue
        const full = join(cur, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) return true
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * 在同盘 staging 目录解包并验证全部条目安全性、核心目录结构与 SKILL.md 版本号。
 */
export function stageAndValidatePackage(entries, skillRoot, {
  expectedVersion,
  insideSkillFn,
  requireFullStructure = true,
} = {}) {
  const stageDir = createSameDiskStageDir(skillRoot)
  const skipped = []
  const stagedEntries = []
  const seenRels = new Set()

  try {
    for (const e of entries ?? []) {
      const rawName = posixPath(e?.name ?? '')
      if (!rawName || rawName.endsWith('/')) continue
      if (isMacOsMetadataPath(rawName)) continue
      const rel = rawName.replace(/^\/+/, '')
      if (!isSafeRelativeEntry(rel)) {
        skipped.push(e.name)
        continue
      }
      const targetDest = join(skillRoot, rel)
      if (typeof insideSkillFn === 'function' && !insideSkillFn(targetDest)) {
        skipped.push(e.name)
        continue
      }
      const stagedPath = join(stageDir, rel)
      if (!isInsideDir(stageDir, stagedPath)) {
        skipped.push(e.name)
        continue
      }
      mkdirSync(dirname(stagedPath), { recursive: true })
      const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
      writeFileSync(stagedPath, data)
      const writtenStat = statSync(stagedPath)
      if (!writtenStat.isFile() || writtenStat.size !== data.length) {
        return { ok: false, why: `staging 写入长度校验失败：${rel}`, stageDir, skipped }
      }
      if (!seenRels.has(rel)) {
        seenRels.add(rel)
        stagedEntries.push({ rel, data, stagedPath })
      }
    }

    if (stagedEntries.length === 0) {
      return { ok: false, why: '包内没有任何可落盘的有效文件', stageDir, skipped }
    }

    const skillEntry = stagedEntries.find((e) => e.rel === 'SKILL.md')
    if (!skillEntry) {
      return { ok: false, why: '包里缺少 SKILL.md', stageDir, skipped }
    }
    const skillText = skillEntry.data.toString('utf8')
    const fm = frontmatterBlock(skillText)
    const pkgName = fm ? /^name:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(fm)?.[1]?.trim() : undefined
    const pkgVersion = skillVersion(skillText)
    if (!pkgName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkgName)) {
      return { ok: false, why: '包内 SKILL.md 缺少合法 name 声明', stageDir, skipped }
    }
    if (!pkgVersion) {
      return { ok: false, why: '包内 SKILL.md 缺少 metadata.version 声明', stageDir, skipped }
    }
    if (expectedVersion !== undefined && pkgVersion !== expectedVersion) {
      return {
        ok: false,
        why: `staging 校验版本号不符（期望 ${expectedVersion}，包内为 ${pkgVersion}）`,
        stageDir,
        skipped,
      }
    }

    if (requireFullStructure) {
      for (const reqDir of ['references', 'templates', 'scripts', 'kit']) {
        if (!hasAnyRegularFile(join(stageDir, reqDir))) {
          return { ok: false, why: `包内目录结构不完整：缺少 ${reqDir}/`, stageDir, skipped }
        }
      }
      const hasMjs = stagedEntries.some((e) => /^scripts\/[^/]+\.mjs$/.test(e.rel))
      if (!hasMjs) {
        return { ok: false, why: '包内 scripts/ 缺少核心脚本', stageDir, skipped }
      }
    }

    return { ok: true, stageDir, stagedEntries, skipped, version: pkgVersion }
  } catch (err) {
    return {
      ok: false,
      why: err instanceof Error ? err.message : String(err),
      stageDir,
      skipped,
    }
  }
}

/** 写前读取现有目标字节，以便中途异常时原地恢复。 */
export function snapshotTargetBackups(stagedEntries, skillRoot) {
  const backups = new Map()
  for (const item of stagedEntries) {
    const dest = join(skillRoot, item.rel)
    if (existsSync(dest)) {
      try {
        const st = statSync(dest)
        if (st.isFile()) {
          backups.set(dest, { dest, existed: true, data: readFileSync(dest) })
        }
      } catch {
        // 无法读取时交由写入阶段暴露错误
      }
    } else {
      backups.set(dest, { dest, existed: false })
    }
  }
  return backups
}

/** 回滚已写入文件并清理因本次更新新建的空目录。 */
export function rollbackAppliedWrites(appliedDests, backups, pruneDirFn) {
  for (let i = appliedDests.length - 1; i >= 0; i -= 1) {
    const dest = appliedDests[i]
    const rec = backups.get(dest)
    if (!rec) continue
    try {
      if (rec.existed) {
        try {
          writeAtomic(dest, rec.data)
        } catch {
          writeFileSync(dest, rec.data)
        }
      } else {
        if (existsSync(dest)) unlinkSync(dest)
        if (typeof pruneDirFn === 'function') pruneDirFn(dirname(dest))
      }
    } catch {
      // 尽力恢复其余文件
    }
  }
}

function walkFilesRecursive(dir) {
  const out = []
  if (!existsSync(dir)) return out
  try {
    if (!statSync(dir).isDirectory()) return out
  } catch {
    return out
  }
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (isMacOsMetadata(entry.name)) continue
      const full = join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  return out.sort()
}

/**
 * 全深度递归比对退役文件：
 * - `kit/skills/**` 与 `scripts/lib/**` 在包副本下物理删除并上报 `retiredFiles`；
 * - 其余托管根目录下未在包内出现的文件仅上报 `staleFiles` 不擅删（保护用户手记）。
 */
export function collectDeepStaleAndRetired(skillRoot, nowSet, {
  isPackageCopy,
  insideSkillFn,
  pruneDirFn,
} = {}) {
  const retiredFiles = []
  const staleFiles = []

  if (isPackageCopy) {
    for (const managedDir of ['kit/skills', 'scripts/lib']) {
      for (const full of walkFilesRecursive(join(skillRoot, managedDir))) {
        const rel = posixPath(relative(skillRoot, full))
        if (isRepoOnlyPath(rel) || nowSet.has(rel)) continue
        if (typeof insideSkillFn === 'function' && !insideSkillFn(full)) continue
        try {
          rmSync(full, { force: true, maxRetries: 5, retryDelay: 50 })
          if (!existsSync(full)) {
            retiredFiles.push(rel)
            if (typeof pruneDirFn === 'function') pruneDirFn(dirname(full))
          }
        } catch {
          staleFiles.push(rel)
        }
      }
    }
  }

  for (const dir of ['scripts', 'references', 'templates', 'kit']) {
    for (const full of walkFilesRecursive(join(skillRoot, dir))) {
      const rel = posixPath(relative(skillRoot, full))
      if (isRepoOnlyPath(rel) || nowSet.has(rel)) continue
      if (rel.startsWith('kit/skills/') || rel.startsWith('scripts/lib/')) continue
      staleFiles.push(rel)
    }
  }

  return { retiredFiles, staleFiles }
}

/** 版本号归一化（去掉前导 `v`）。 */
export function plainVersion(value) {
  return String(value ?? '').trim().replace(/^v(?=\d)/i, '')
}

/** 安全解码 URL 标签段；编码残缺时不抛 URIError。 */
export function decodeTagSegment(segment) {
  try {
    return plainVersion(decodeURIComponent(segment))
  } catch {
    return ''
  }
}

/** 按 SemVer 语义比大小（含预发布后缀），不可解析时返回 undefined。 */
export function isNewer(candidate, current) {
  const parse = (v) => {
    const s = plainVersion(v)
    const noBuild = s.split('+')[0]
    const dash = noBuild.indexOf('-')
    const core = (dash >= 0 ? noBuild.slice(0, dash) : noBuild).split('.')
      .map((x) => (/^\d+$/.test(x) ? Number(x) : undefined))
    if (core.length === 0 || core.some((x) => x === undefined)) return undefined
    const pre = dash >= 0 ? noBuild.slice(dash + 1).split('.') : []
    return { core, pre }
  }

  const a = parse(candidate)
  const b = parse(current)
  if (a === undefined || b === undefined) return undefined

  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const x = a.core[i] ?? 0
    const y = b.core[i] ?? 0
    if (x !== y) return x > y
  }

  if (a.pre.length === 0 && b.pre.length === 0) return false
  if (a.pre.length === 0) return true
  if (b.pre.length === 0) return false

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return false
    if (y === undefined) return true
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0
    } else if (xn !== yn) {
      return yn
    } else if (x !== y) {
      return x > y
    }
  }
  return false
}

/** 格式化人类可读冷却与提醒时长。 */
export function durationText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  return hours < 24 ? `${hours} 小时` : `${Math.ceil(hours / 24)} 天`
}

