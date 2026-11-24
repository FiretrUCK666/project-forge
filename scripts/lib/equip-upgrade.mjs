/**
 * equip-upgrade.mjs —— `equip.mjs` 仓外基线缓存、三层 `baseText` 自动回溯与仓外冲突旁路目录解析。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 `scripts/equip.mjs` 与测试夹具复用。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  MAX_BACKUP_FILE_BYTES,
  MAX_RESTORE_TOTAL_BYTES,
  canonicalBackupPath,
  findGitCommonDir,
  resolveBackupDir,
} from '../backup.mjs'
import { isAllowedExtensionPath } from '../../kit/skills/lib/overlay.mjs'
import { writeAtomic } from './fs-atomic.mjs'
import { normalizedSha256 } from './equip-bootstrap.mjs'
import { getKitSkills, isMacOsMetadata } from './protocol.mjs'
import { detectSkillKind } from './survey-ecosystem.mjs'
import { posixPath, readTextSafe } from './text.mjs'
import { readZip } from '../zip.mjs'

const SHA256_RE = /^[0-9a-f]{64}$/i
const GIT_LOG_LIMIT = 30

function envHomeDir(env = process.env) {
  return String(env?.HOME || env?.USERPROFILE || homedir()).trim() || homedir()
}

function projectBucket(canonRoot) {
  const hashInput = process.platform === 'win32' ? canonRoot.toLowerCase() : canonRoot
  const hash8 = createHash('sha256').update(hashInput).digest('hex').slice(0, 8)
  const slug = basename(canonRoot)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'
  return `${slug}-${hash8}`
}

function isTextBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function decodeNormalizedText(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n')
}

/**
 * 解析仓外受管状态目录（支持基线缓存 `'baselines'` 与冲突旁路 `'conflicts'`）。
 * - Git 仓（含多 worktree）：置于 `<gitCommonDir>/project-forge-{cache,conflicts}/...`
 * - 非 Git 仓：置于测试覆写目录（`PF_STATE_DIR`/`PF_BACKUP_DIR`）或 `~/.project-forge/`
 */
export function resolveOutOfTreeStateDir(targetDir, kind = 'baselines', { env = process.env } = {}) {
  const canonRoot = canonicalBackupPath(targetDir)
  const bucket = projectBucket(canonRoot)
  const gitCommon = findGitCommonDir(canonRoot)
  const homeBase = envHomeDir(env)
  const envState = typeof env?.PF_STATE_DIR === 'string' ? env.PF_STATE_DIR.trim() : ''
  const envBackup = typeof env?.PF_BACKUP_DIR === 'string' ? env.PF_BACKUP_DIR.trim() : ''

  if (kind === 'conflicts') {
    const envConflict = typeof env?.PF_CONFLICT_DIR === 'string' ? env.PF_CONFLICT_DIR.trim() : ''
    if (envConflict) return join(resolve(envConflict), bucket)
    if (envState) return join(resolve(envState), 'conflicts', bucket)
    if (gitCommon) return join(gitCommon, 'project-forge-conflicts', bucket)
    if (envBackup) return join(resolve(envBackup), '_state', 'conflicts', bucket)
    return join(homeBase, '.project-forge', 'conflicts', bucket)
  }

  const envBaseline = typeof env?.PF_BASELINE_CACHE_DIR === 'string' ? env.PF_BASELINE_CACHE_DIR.trim() : ''
  if (envBaseline) return resolve(envBaseline)
  const envCache = typeof env?.PF_CACHE_DIR === 'string' ? env.PF_CACHE_DIR.trim() : ''
  if (envCache) return join(resolve(envCache), 'baselines')
  if (envState) return join(resolve(envState), 'cache', 'baselines')
  if (gitCommon) return join(gitCommon, 'project-forge-cache', 'baselines')
  if (envBackup) return join(resolve(envBackup), '_state', 'cache', 'baselines')
  return join(homeBase, '.project-forge', 'cache', 'baselines')
}

export function resolveBaselineCacheDir(targetDir, opts = {}) {
  return resolveOutOfTreeStateDir(targetDir, 'baselines', opts)
}

export function resolveConflictDir(targetDir, opts = {}) {
  return resolveOutOfTreeStateDir(targetDir, 'conflicts', opts)
}

/** 按内容 sha256 幂等写入仓外基线缓存（Fail-Soft）。 */
export function cacheBaselineBuffer(cacheDir, sha256, buf) {
  try {
    const hash = String(sha256 ?? '').trim().toLowerCase()
    if (!cacheDir || !SHA256_RE.test(hash) || !Buffer.isBuffer(buf)) return false
    const dest = join(cacheDir, hash)
    if (existsSync(dest)) return false
    if (normalizedSha256(buf) !== hash) return false
    mkdirSync(cacheDir, { recursive: true })
    writeAtomic(dest, buf)
    return true
  } catch {
    return false
  }
}

function readFromCache(cacheDir, targetHash) {
  try {
    const file = join(cacheDir, targetHash)
    if (!existsSync(file)) return null
    const buf = readFileSync(file)
    if (!isTextBuffer(buf) || normalizedSha256(buf) !== targetHash) return null
    return decodeNormalizedText(buf)
  } catch {
    return null
  }
}

function listZipCandidates(backupDirs) {
  const zips = []
  for (const dir of backupDirs) {
    if (!dir || !existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.zip')) {
          zips.push({ name: entry.name, abs: join(dir, entry.name) })
        }
      }
    } catch { /* ignore unreadable backup dir */ }
  }
  return zips.sort((a, b) => b.name.localeCompare(a.name))
}

function runGitBuf(cwd, args, env) {
  return spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', ...args], {
    cwd,
    encoding: null,
    maxBuffer: MAX_BACKUP_FILE_BYTES,
    timeout: 15000,
    windowsHide: true,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never',
    },
  })
}

/**
 * 构建单次 `equip()` 共用的三层确定性 `baseText` 检索器（缓存 -> `.zip` 备份 -> Git 历史）。
 * 每轮升级仅解析一次 zip 与仓库前缀，全部读失败均 Fail-Soft 返回 `null`。
 */
export function createBaselineResolver(targetDir, { env = process.env } = {}) {
  const root = canonicalBackupPath(targetDir)
  const gitCommon = findGitCommonDir(root)
  const cacheDir = resolveBaselineCacheDir(root, { env })
  const conflictDir = resolveConflictDir(root, { env })
  const backupDirs = [...new Set([
    resolveBackupDir(root, { env }),
    ...(gitCommon ? [join(gitCommon, 'project-forge-backups')] : []),
  ].map((d) => resolve(d)))]

  const zipEntryCache = new Map()
  let cachedZipList = null
  let cachedGitPrefix = undefined

  const getZipEntries = (zipAbs) => {
    if (zipEntryCache.has(zipAbs)) return zipEntryCache.get(zipAbs)
    let map = null
    try {
      const entries = readZip(readFileSync(zipAbs), {
        maxTotalBytes: MAX_RESTORE_TOTAL_BYTES,
        maxEntryBytes: MAX_BACKUP_FILE_BYTES,
      })
      map = new Map()
      for (const e of entries) {
        const key = posixPath(e.name).replace(/^\.\//, '').replace(/^\/+/, '')
        map.set(key, e.data)
      }
    } catch {
      map = null
    }
    zipEntryCache.set(zipAbs, map)
    return map
  }

  const readFromBackups = (normRel, targetHash) => {
    if (!cachedZipList) cachedZipList = listZipCandidates(backupDirs)
    const zipKey = `.agents/skills/${normRel}`
    for (const item of cachedZipList) {
      const entries = getZipEntries(item.abs)
      const buf = entries?.get(zipKey)
      if (!buf || !isTextBuffer(buf)) continue
      if (normalizedSha256(buf) === targetHash) return decodeNormalizedText(buf)
    }
    return null
  }

  const getGitPrefix = () => {
    if (cachedGitPrefix !== undefined) return cachedGitPrefix
    try {
      const res = runGitBuf(root, ['rev-parse', '--show-prefix'], env)
      cachedGitPrefix = res.status === 0
        ? posixPath(Buffer.from(res.stdout ?? '').toString('utf8').trim()).replace(/^\/+/, '')
        : ''
    } catch {
      cachedGitPrefix = ''
    }
    return cachedGitPrefix
  }

  const readFromGitHistory = (normRel, targetHash) => {
    if (!gitCommon) return null
    try {
      const relFromCwd = `.agents/skills/${normRel}`
      const logRes = runGitBuf(root, ['log', '--format=%H', '-n', String(GIT_LOG_LIMIT), '--', relFromCwd], env)
      if (logRes.status !== 0 || !logRes.stdout) return null
      const commits = Buffer.from(logRes.stdout).toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      if (commits.length === 0) return null
      const prefix = getGitPrefix()
      const gitObjPath = prefix ? `${prefix}${relFromCwd}` : relFromCwd
      for (const sha of commits) {
        const showRes = runGitBuf(root, ['show', `${sha}:${gitObjPath}`], env)
        if (showRes.status !== 0 || !showRes.stdout) continue
        const buf = Buffer.from(showRes.stdout)
        if (isTextBuffer(buf) && normalizedSha256(buf) === targetHash) {
          return decodeNormalizedText(buf)
        }
      }
    } catch {
      return null
    }
    return null
  }

  const resolveBaseText = (rel, targetHash) => {
    const hash = String(targetHash ?? '').trim().toLowerCase()
    if (!SHA256_RE.test(hash)) return null
    const normRel = posixPath(rel).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!normRel) return null
    return readFromCache(cacheDir, hash)
      ?? readFromBackups(normRel, hash)
      ?? readFromGitHistory(normRel, hash)
  }

  return { cacheDir, conflictDir, resolveBaseText }
}

/** 生成待裁决冲突的仓外对照路径、diff 命令与一键处置指令。 */
export function buildPendingConflictDetails(pendingConflictsMap, skillsDir, conflictDir) {
  return Object.keys(pendingConflictsMap ?? {}).sort().map((rel) => {
    const info = pendingConflictsMap[rel] ?? {}
    const upRel = info.upstreamFile || `${rel}.upstream`
    const cfRel = info.conflictFile || `${rel}.pf-conflict`
    const useOut = info.outOfTree === true
    const upstreamPath = useOut ? join(conflictDir, upRel) : join(skillsDir, upRel)
    const conflictPath = useOut ? join(conflictDir, cfRel) : join(skillsDir, cfRel)
    const localPath = join(skillsDir, rel)
    return {
      path: rel,
      outOfTree: useOut,
      upstreamPath,
      conflictPath,
      diffCommand: `diff -u "${localPath}" "${upstreamPath}"`,
      adoptCommand: `node scripts/equip.mjs . --adopt-custom ${rel}`,
      restoreCommand: `node scripts/equip.mjs . --restore ${rel}`,
    }
  })
}

/** 收集 `.agents/skills/` 受管目录中未登记且非扩展槽的多余文件（仅非 outOfTree 时放行历史仓内 sidecar）。 */
export function collectManagedDirExtras(
  skillsDir,
  kitFiles,
  customizedFiles = {},
  extraAllowed = null,
  kitSkills = getKitSkills(),
  pendingConflicts = {},
) {
  const extras = []
  const sidecarAllowed = new Set()
  for (const [k, info] of Object.entries(pendingConflicts ?? {})) {
    if (info?.outOfTree === true) continue
    sidecarAllowed.add(info?.upstreamFile || `${k}.upstream`)
    sidecarAllowed.add(info?.conflictFile || `${k}.pf-conflict`)
  }
  const managedTopDirs = new Set(
    [...kitSkills, 'lib', ...[...kitFiles.keys()].map((k) => k.split('/')[0]).filter(Boolean)],
  )
  for (const top of managedTopDirs) {
    const topPath = join(skillsDir, top)
    if (!existsSync(topPath)) continue
    let st
    try { st = statSync(topPath) } catch { continue }
    if (!st.isDirectory()) continue
    const stack = [topPath]
    while (stack.length > 0) {
      const cur = stack.pop()
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        if (isMacOsMetadata(entry.name)) continue
        const abs = join(cur, entry.name)
        if (entry.isDirectory()) {
          stack.push(abs)
        } else if (entry.isFile()) {
          const rel = posixPath(relative(skillsDir, abs))
          if (kitFiles.has(rel) || extraAllowed?.has(rel) || sidecarAllowed.has(rel)) continue
          if (isAllowedExtensionPath(rel) || isAllowedExtensionPath(`.agents/${rel}`)) continue
          const customEntry = customizedFiles[rel]
          if (customEntry && normalizedSha256(readFileSync(abs)) === customEntry.baseSha256) continue
          extras.push(rel)
        }
      }
    }
  }
  return extras.sort()
}

function walkInstalledMjsFiles(skillsDir) {
  const out = []
  if (!existsSync(skillsDir)) return out
  const visit = (dir, relBase) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isMacOsMetadata(entry.name) || entry.name === '.pf-manifest.json') continue
      const full = join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(full, rel)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push({ full, rel })
    }
  }
  visit(skillsDir, '')
  return out
}

/** 校验已安装技能的核心完整性、跨目录导入断链与 YAML frontmatter 合法性。 */
export function inspectInstalledIntegrity(
  skillsDir,
  disabledSet,
  removedMap,
  existingExists,
  kitSkills = getKitSkills(),
) {
  const disabledCoreSkills = []
  const brokenImports = []
  const invalidFrontmatters = []

  for (const skill of kitSkills) {
    const skillEntry = `${skill}/SKILL.md`
    if (disabledSet.has(skill) || Boolean(removedMap[skillEntry]) || (existingExists && !existsSync(join(skillsDir, skillEntry)))) {
      disabledCoreSkills.push(skill)
    }
  }

  if (existsSync(skillsDir)) {
    const relImportRe = /(?:^\s*(?:import|export)[\s\S]*?from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/gm
    for (const { full, rel } of walkInstalledMjsFiles(skillsDir)) {
      const code = readTextSafe(full) ?? ''
      for (const m of code.matchAll(relImportRe)) {
        const spec = m[1].trim()
        if (!existsSync(resolve(dirname(full), spec))) brokenImports.push(`${rel} -> ${spec}`)
      }
    }
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || isMacOsMetadata(entry.name) || entry.name === 'lib' || entry.name.startsWith('.')) continue
      if (disabledSet.has(entry.name)) continue
      const skillDir = join(skillsDir, entry.name)
      if (!existsSync(join(skillDir, 'SKILL.md'))) continue
      const detected = detectSkillKind(skillDir)
      if (!detected?.skillMeta?.hasValidFrontmatter) invalidFrontmatters.push(`${entry.name}/SKILL.md`)
    }
  }

  return { disabledCoreSkills, brokenImports, invalidFrontmatters }
}

