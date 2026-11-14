#!/usr/bin/env node
/**
 * `.agents/skills/` 工程套件装配、两档分档（lightweight / full）、manifest v2 墓碑/定制豁免、
 * 字节级校验与空白工程初始化。
 *
 * - 只使用 Node 18+ 内置模块，零第三方依赖。
 * - 文本文件统一按 LF 写入，哈希比对兼容 CRLF/LF 跨系统归一等价。
 * - 磁盘已删除的技能/文件记入 `disabledSkills` / `removedFiles` 墓碑，仅 `--restore` 恢复。
 * - `--adopt-custom` 登记定制豁免后 `--check` 返回 0，并标明上游新版是否有变化。
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensurePreWriteBackup } from './backup.mjs'
import { writeAtomic } from './lib/fs-atomic.mjs'
import {
  EQUIP_TIERS,
  KIT_SKILLS,
  LIGHTWEIGHT_KIT_SKILLS,
  PF_MANIFEST_REL,
  PF_MANIFEST_SCHEMA_VERSION,
  isMacOsMetadata,
} from './lib/protocol.mjs'
import { bootstrapEmpty, starterTemplates } from './lib/starter-templates.mjs'
import { isMainModule, posixPath, readTextSafe, skillVersion } from './lib/text.mjs'

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_KIT_SKILLS_DIR = join(SKILL_ROOT, 'kit', 'skills')
const FULL_GITKEEP_PATHS = ['docs/prd/.gitkeep', 'docs/specs/.gitkeep', 'docs/todo/.gitkeep']

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function isTextBuffer(buf) {
  if (buf.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function normalizeWriteBuffer(buf) {
  if (!isTextBuffer(buf)) return buf
  const normalized = buf.toString('utf8').replace(/\r\n/g, '\n')
  return Buffer.from(normalized, 'utf8')
}

function normalizedSha256(buf) {
  return sha256Buffer(normalizeWriteBuffer(buf))
}

function sortObjectKeys(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {}).sort()) out[k] = obj[k]
  return out
}

function walkKitFiles(kitDir) {
  const map = new Map()
  if (!existsSync(kitDir)) return map

  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.pf-manifest.json' || isMacOsMetadata(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      const rel = posixPath(relative(kitDir, abs))
      const rawBuf = readFileSync(abs)
      const buf = normalizeWriteBuffer(rawBuf)
      map.set(rel, { abs, buf, sha256: sha256Buffer(buf) })
    }
  }

  visit(kitDir)
  return map
}

function filterKitByTier(kitFiles, tier) {
  if (tier !== 'lightweight') return new Map(kitFiles)
  const allowedTops = new Set(['lib', ...LIGHTWEIGHT_KIT_SKILLS])
  const filtered = new Map()
  for (const [rel, item] of kitFiles.entries()) {
    const top = rel.split('/')[0]
    if (allowedTops.has(top)) filtered.set(rel, item)
  }
  return filtered
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return []
  return [...new Set(arr.map((x) => posixPath(String(x ?? '')).replace(/^\/+|\/+$/g, '')).filter(Boolean))].sort()
}

function normalizeRemovedFiles(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const rel = posixPath(k).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!rel) continue
    if (typeof v === 'string') out[rel] = { removedAt: v, baseSha256: null }
    else if (v && typeof v === 'object') {
      out[rel] = {
        removedAt: typeof v.removedAt === 'string' ? v.removedAt : '',
        baseSha256: typeof v.baseSha256 === 'string' ? v.baseSha256 : null,
      }
    }
  }
  return sortObjectKeys(out)
}

function normalizeCustomizedFiles(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const rel = posixPath(k).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!rel || !v || typeof v !== 'object' || typeof v.baseSha256 !== 'string' || !v.baseSha256) continue
    out[rel] = {
      adoptedAt: typeof v.adoptedAt === 'string' ? v.adoptedAt : '',
      baseSha256: v.baseSha256,
      upstreamSha256: typeof v.upstreamSha256 === 'string' ? v.upstreamSha256 : null,
    }
  }
  return sortObjectKeys(out)
}

function readExistingManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { exists: false, valid: false, data: undefined }
  const text = readTextSafe(manifestPath)
  if (!text) return { exists: true, valid: false, data: undefined }
  try {
    const parsed = JSON.parse(text)
    const valid = Boolean(
      parsed
      && typeof parsed === 'object'
      && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)
      && parsed.files
      && typeof parsed.files === 'object'
      && !Array.isArray(parsed.files),
    )
    return { exists: true, valid, data: valid ? parsed : undefined }
  } catch {
    return { exists: true, valid: false, data: undefined }
  }
}

function pruneEmptyParents(filePath, stopDir) {
  let cur = dirname(filePath)
  const stop = resolve(stopDir)
  while (cur.length > stop.length && cur.startsWith(stop)) {
    try {
      if (readdirSync(cur).length > 0) break
      rmdirSync(cur)
      cur = dirname(cur)
    } catch {
      break
    }
  }
}

function normalizePrevFiles(filesObj) {
  const map = new Map()
  if (!filesObj || typeof filesObj !== 'object') return map
  for (const [k, v] of Object.entries(filesObj)) {
    const rel = posixPath(k)
    const hash = typeof v === 'string' ? v : v?.sha256
    if (rel && typeof hash === 'string' && hash) {
      map.set(rel, hash)
    }
  }
  return map
}

function normalizeSkillFilterArg(raw) {
  return posixPath(String(raw ?? ''))
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\.agents\/skills\//, '')
    .replace(/^\/+|\/+$/g, '')
}

function buildFilterMatcher(option) {
  if (!option) return null
  if (option === true) return () => true
  const list = (Array.isArray(option) ? option : [option]).map(normalizeSkillFilterArg).filter(Boolean)
  if (list.length === 0 || list.includes('*')) return () => true
  return (relOrSkill) => {
    const norm = normalizeSkillFilterArg(relOrSkill)
    return list.some((pat) => norm === pat || norm.startsWith(`${pat}/`))
  }
}

function collectManagedDirExtras(skillsDir, kitFiles, customizedFiles = {}) {
  const extras = []
  const managedTopDirs = new Set(
    [...KIT_SKILLS, 'lib', ...[...kitFiles.keys()].map((k) => k.split('/')[0]).filter(Boolean)],
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
          if (kitFiles.has(rel)) continue
          const customEntry = customizedFiles[rel]
          if (customEntry && normalizedSha256(readFileSync(abs)) === customEntry.baseSha256) continue
          extras.push(rel)
        }
      }
    }
  }
  return extras.sort()
}

function resolveEffectiveTier(requestedTier, existing) {
  if (requestedTier !== undefined) {
    if (!EQUIP_TIERS.includes(requestedTier)) {
      throw new Error(`--tier 必须是 ${EQUIP_TIERS.join(' | ')} 之一（收到：${requestedTier}）`)
    }
    return requestedTier
  }
  const prevTier = existing.valid ? existing.data?.tier : undefined
  return EQUIP_TIERS.includes(prevTier) ? prevTier : 'full'
}

/**
 * 字节级只读校验 `<targetDir>/.agents/skills/` 与源 `kit/skills/` 的一致性（兼容 v1/v2 账本、墓碑与定制豁免）。
 */
export function checkEquip(targetDir, { kitDir = DEFAULT_KIT_SKILLS_DIR, tier } = {}) {
  const root = resolve(targetDir)
  const skillsDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, PF_MANIFEST_REL)

  if (!existsSync(kitDir)) {
    return {
      ok: false,
      reason: `找不到源套件目录：${kitDir}`,
      missing: [],
      drifted: [],
      unregistered: [],
      extraManaged: [],
      customized: [],
    }
  }

  const existing = readExistingManifest(manifestPath)
  const effectiveTier = resolveEffectiveTier(tier, existing)
  const allKitFiles = walkKitFiles(kitDir)
  const kitFiles = filterKitByTier(allKitFiles, effectiveTier)
  const prevFiles = normalizePrevFiles(existing.data?.files)
  const disabledSet = new Set(existing.valid ? normalizeStringArray(existing.data?.disabledSkills) : [])
  const removedMap = existing.valid ? normalizeRemovedFiles(existing.data?.removedFiles) : {}
  const customizedMap = existing.valid ? normalizeCustomizedFiles(existing.data?.customizedFiles) : {}

  const missing = []
  const drifted = []
  const unregistered = []
  const extraManaged = []
  const customized = []

  if (!existing.exists) {
    missing.push(PF_MANIFEST_REL)
  } else if (!existing.valid) {
    drifted.push(PF_MANIFEST_REL)
  }

  for (const [rel, src] of kitFiles.entries()) {
    const top = rel.split('/')[0]
    if (disabledSet.has(top) || removedMap[rel]) continue
    const dest = join(skillsDir, rel)
    if (!existsSync(dest)) {
      missing.push(rel)
      continue
    }
    const diskHash = normalizedSha256(readFileSync(dest))
    if (diskHash === src.sha256) {
      if (existing.valid && prevFiles.get(rel) !== src.sha256) {
        unregistered.push(rel)
      }
      continue
    }
    const customEntry = customizedMap[rel]
    if (customEntry && diskHash === customEntry.baseSha256) {
      customized.push({
        path: rel,
        adoptedAt: customEntry.adoptedAt,
        baseSha256: customEntry.baseSha256,
        upstreamSha256: customEntry.upstreamSha256,
        upstreamChanged: customEntry.upstreamSha256 !== src.sha256,
      })
      continue
    }
    drifted.push(rel)
  }

  if (existing.valid) {
    for (const rel of prevFiles.keys()) {
      const top = rel.split('/')[0]
      if (disabledSet.has(top) || removedMap[rel]) continue
      if (!kitFiles.has(rel)) extraManaged.push(rel)
    }
  }
  for (const rel of collectManagedDirExtras(skillsDir, kitFiles, customizedMap)) {
    if (!extraManaged.includes(rel)) extraManaged.push(rel)
  }
  extraManaged.sort()

  const ok = existing.exists
    && existing.valid
    && missing.length === 0
    && drifted.length === 0
    && unregistered.length === 0
    && extraManaged.length === 0

  return {
    ok,
    target: root,
    tier: effectiveTier,
    schemaVersion: existing.data?.schemaVersion,
    manifestPath: PF_MANIFEST_REL,
    missing,
    drifted,
    unregistered,
    extraManaged,
    customized,
    disabledSkills: [...disabledSet].sort(),
    removedFiles: Object.keys(removedMap).sort(),
  }
}

/**
 * 将 `kit/skills/**` 按两档策略与 manifest v2（删除墓碑 + 定制豁免）同步到 `<targetDir>/.agents/skills/**`。
 */
export function equip(targetDir, {
  kitDir = DEFAULT_KIT_SKILLS_DIR,
  tier,
  dryRun = false,
  noBackup = false,
  restore = false,
  adoptCustom = false,
  forgeVersion = skillVersion(readTextSafe(join(SKILL_ROOT, 'SKILL.md'))) || '0.0.0',
  now = new Date().toISOString(),
} = {}) {
  const root = resolve(targetDir)
  if (!existsSync(kitDir)) {
    throw new Error(`找不到源套件目录：${kitDir}`)
  }

  const skillsDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, PF_MANIFEST_REL)
  const existing = readExistingManifest(manifestPath)
  const effectiveTier = resolveEffectiveTier(tier, existing)
  const allKitFiles = walkKitFiles(kitDir)
  const kitFiles = filterKitByTier(allKitFiles, effectiveTier)

  const prevFiles = normalizePrevFiles(existing.data?.files)
  const disabledSet = new Set(existing.valid ? normalizeStringArray(existing.data?.disabledSkills) : [])
  const removedMap = existing.valid ? normalizeRemovedFiles(existing.data?.removedFiles) : {}
  const nextCustomized = existing.valid ? normalizeCustomizedFiles(existing.data?.customizedFiles) : {}

  const restoreMatcher = buildFilterMatcher(restore)
  const adoptMatcher = buildFilterMatcher(adoptCustom)

  if (restoreMatcher) {
    for (const skill of [...disabledSet]) {
      if (restoreMatcher(skill)) disabledSet.delete(skill)
    }
    for (const rel of Object.keys(removedMap)) {
      if (restoreMatcher(rel)) delete removedMap[rel]
    }
  }

  // 检测自上次记录以来被用户手动删除的整套技能与单文件，记录墓碑且绝不擅自恢复。
  if (existing.valid) {
    const trackedBySkill = new Map()
    for (const rel of prevFiles.keys()) {
      const top = rel.split('/')[0]
      if (!top || top === 'lib') continue
      if (!trackedBySkill.has(top)) trackedBySkill.set(top, [])
      trackedBySkill.get(top).push(rel)
    }
    for (const [skill, trackedRels] of trackedBySkill.entries()) {
      if (disabledSet.has(skill)) continue
      if (restoreMatcher && (restoreMatcher(skill) || trackedRels.some((r) => restoreMatcher(r)))) continue
      const skillDir = join(skillsDir, skill)
      if (!existsSync(skillDir)) {
        disabledSet.add(skill)
        for (const rel of Object.keys(removedMap)) {
          if (rel === skill || rel.startsWith(`${skill}/`)) delete removedMap[rel]
        }
        for (const rel of Object.keys(nextCustomized)) {
          if (rel === skill || rel.startsWith(`${skill}/`)) delete nextCustomized[rel]
        }
      }
    }
    for (const [rel, oldHash] of prevFiles.entries()) {
      const top = rel.split('/')[0]
      if (disabledSet.has(top)) continue
      if (!kitFiles.has(rel)) continue
      if (restoreMatcher && restoreMatcher(rel)) continue
      if (!existsSync(join(skillsDir, rel))) {
        if (!removedMap[rel]) removedMap[rel] = { removedAt: now, baseSha256: oldHash }
        delete nextCustomized[rel]
      }
    }
  }

  const added = []
  const restored = []
  const upgraded = []
  const unchanged = []
  const conflicts = []
  const retired = []
  const orphanedModified = []
  const adopted = []
  const customized = []
  const nextFiles = {}
  const pendingWrites = []
  const pendingDeletes = []
  const ensuredGitkeeps = []

  const kitKeys = [...kitFiles.keys()].sort()
  for (const rel of kitKeys) {
    const src = kitFiles.get(rel)
    const top = rel.split('/')[0]
    const dest = join(skillsDir, rel)
    const oldHash = prevFiles.get(rel)

    if (existsSync(dest)) {
      if (disabledSet.has(top)) disabledSet.delete(top)
      if (removedMap[rel]) delete removedMap[rel]
    } else {
      if (disabledSet.has(top) || removedMap[rel]) continue
      pendingWrites.push({ dest, buf: src.buf })
      nextFiles[rel] = { sha256: src.sha256 }
      if (restoreMatcher && (restoreMatcher(rel) || restoreMatcher(top))) restored.push(rel)
      else added.push(rel)
      continue
    }

    const diskHash = normalizedSha256(readFileSync(dest))
    // 磁盘内容已与新版源码归一等价（含首次修复基线漂移），直接收敛至新版 sha256。
    if (diskHash === src.sha256) {
      nextFiles[rel] = { sha256: src.sha256 }
      delete nextCustomized[rel]
      unchanged.push(rel)
      continue
    }

    if (adoptMatcher && adoptMatcher(rel)) {
      nextCustomized[rel] = {
        adoptedAt: now,
        baseSha256: diskHash,
        upstreamSha256: src.sha256,
      }
      nextFiles[rel] = { sha256: oldHash || src.sha256 }
      adopted.push(rel)
      customized.push({ path: rel, upstreamChanged: false })
      continue
    }

    const customEntry = nextCustomized[rel]
    if (customEntry && customEntry.baseSha256 === diskHash) {
      nextFiles[rel] = { sha256: oldHash || src.sha256 }
      customized.push({
        path: rel,
        upstreamChanged: customEntry.upstreamSha256 !== src.sha256,
      })
      continue
    }

    if (!oldHash) {
      conflicts.push({
        path: rel,
        reason: 'untracked-modified',
        diskSha256: diskHash,
        incomingSha256: src.sha256,
      })
      continue
    }

    if (diskHash === oldHash) {
      pendingWrites.push({ dest, buf: src.buf })
      nextFiles[rel] = { sha256: src.sha256 }
      upgraded.push(rel)
      continue
    }

    nextFiles[rel] = { sha256: oldHash }
    conflicts.push({
      path: rel,
      reason: 'modified-preserved',
      baselineSha256: oldHash,
      diskSha256: diskHash,
      incomingSha256: src.sha256,
    })
  }

  if (adoptMatcher) {
    for (const extraRel of collectManagedDirExtras(skillsDir, kitFiles, {})) {
      if (!adoptMatcher(extraRel)) continue
      const abs = join(skillsDir, extraRel)
      if (!existsSync(abs)) continue
      nextCustomized[extraRel] = {
        adoptedAt: now,
        baseSha256: normalizedSha256(readFileSync(abs)),
        upstreamSha256: null,
      }
      adopted.push(extraRel)
    }
  }

  for (const [rel, oldHash] of prevFiles.entries()) {
    if (kitFiles.has(rel)) continue
    const top = rel.split('/')[0]
    if (disabledSet.has(top)) continue
    const dest = join(skillsDir, rel)
    if (!existsSync(dest)) {
      retired.push(rel)
      delete nextCustomized[rel]
      continue
    }
    const diskHash = normalizedSha256(readFileSync(dest))
    if (diskHash === oldHash) {
      pendingDeletes.push(dest)
      retired.push(rel)
      delete nextCustomized[rel]
    } else {
      orphanedModified.push({
        path: rel,
        status: 'orphaned-modified',
        baselineSha256: oldHash,
        diskSha256: diskHash,
      })
    }
  }

  if (effectiveTier === 'full') {
    for (const relKeep of FULL_GITKEEP_PATHS) {
      const keepDest = join(root, relKeep)
      if (!existsSync(keepDest)) {
        pendingWrites.push({ dest: keepDest, buf: Buffer.alloc(0) })
        ensuredGitkeeps.push(relKeep)
      }
    }
  }

  const nextManifest = {
    schemaVersion: PF_MANIFEST_SCHEMA_VERSION,
    tier: effectiveTier,
    forgeVersion,
    installedAt: existing.data?.installedAt || now,
    files: sortObjectKeys(Object.fromEntries(Object.entries(nextFiles).map(([k, v]) => [k, v]))),
    disabledSkills: [...disabledSet].sort(),
    removedFiles: sortObjectKeys(removedMap),
    customizedFiles: sortObjectKeys(nextCustomized),
    agentsRegions: existing.data?.agentsRegions && typeof existing.data.agentsRegions === 'object'
      ? { ...existing.data.agentsRegions }
      : {},
    removedAgentsRegions: existing.valid ? normalizeStringArray(existing.data?.removedAgentsRegions) : [],
  }

  const prevNormalizedRaw = existing.valid ? JSON.stringify({
    schemaVersion: existing.data.schemaVersion,
    tier: existing.data.tier,
    forgeVersion: existing.data.forgeVersion,
    installedAt: existing.data.installedAt,
    files: sortObjectKeys(existing.data.files),
    disabledSkills: normalizeStringArray(existing.data.disabledSkills),
    removedFiles: normalizeRemovedFiles(existing.data.removedFiles),
    customizedFiles: normalizeCustomizedFiles(existing.data.customizedFiles),
    agentsRegions: existing.data.agentsRegions ?? {},
    removedAgentsRegions: normalizeStringArray(existing.data.removedAgentsRegions),
  }) : ''

  const manifestChanged = !existing.exists
    || !existing.valid
    || prevNormalizedRaw !== JSON.stringify(nextManifest)
  if (manifestChanged && existing.valid && prevNormalizedRaw !== '') {
    nextManifest.installedAt = pendingWrites.length > 0 || pendingDeletes.length > 0 ? now : nextManifest.installedAt
  }

  const hasPendingChanges = pendingWrites.length > 0 || pendingDeletes.length > 0 || manifestChanged

  let backup
  if (dryRun) {
    backup = { created: false, skippedReason: 'dry-run' }
  } else if (noBackup) {
    backup = { created: false, skippedReason: 'disabled' }
  } else if (!hasPendingChanges) {
    backup = { created: false, skippedReason: 'no-pending-changes' }
  } else {
    backup = ensurePreWriteBackup(root, { label: 'equip', hasPendingChanges: true })
  }

  if (!dryRun) {
    for (const item of pendingWrites) {
      mkdirSync(dirname(item.dest), { recursive: true })
      writeAtomic(item.dest, item.buf)
    }
    for (const dest of pendingDeletes) {
      unlinkSync(dest)
      pruneEmptyParents(dest, skillsDir)
    }
    if (manifestChanged) {
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
    }
  }

  return {
    target: root,
    tier: effectiveTier,
    schemaVersion: PF_MANIFEST_SCHEMA_VERSION,
    dryRun,
    backup,
    manifestPath: PF_MANIFEST_REL,
    manifestUpdated: manifestChanged,
    added,
    restored,
    upgraded,
    unchanged,
    conflicts,
    retired,
    orphanedModified,
    adopted,
    customized,
    disabledSkills: nextManifest.disabledSkills,
    removedFiles: Object.keys(nextManifest.removedFiles),
    ensuredGitkeeps,
  }
}

function formatCheckReport(res) {
  const lines = []
  if (res.reason) lines.push(res.reason)
  for (const p of res.missing) lines.push(`缺失：${p}`)
  for (const p of res.drifted) lines.push(`字节不一致：${p}`)
  for (const p of res.unregistered) lines.push(`未登记哈希：${p}`)
  for (const p of res.extraManaged) lines.push(`多余托管文件：${p}`)
  for (const c of res.customized ?? []) {
    lines.push(c.upstreamChanged
      ? `定制豁免：${c.path}（上游新版有变化，可供参考合并）`
      : `定制豁免：${c.path}（与上游基线一致）`)
  }
  return lines.join('\n')
}

function consumeOptionalValue(argv, idx, targetSpecified) {
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) return { value: true, consumed: false }
  const norm = normalizeSkillFilterArg(next)
  const looksLikeSkill = KIT_SKILLS.includes(norm) || norm.startsWith('lib/') || norm.includes('/')
  if (!targetSpecified && !next.startsWith('.agents/') && !looksLikeSkill && existsSync(next) && statSync(next).isDirectory()) {
    return { value: true, consumed: false }
  }
  return { value: next, consumed: true }
}

async function main(argv) {
  let target = process.cwd()
  let targetSpecified = false
  let check = false
  let dryRun = false
  let noBackup = false
  let doBootstrap = false
  let lang
  let name
  let description = ''
  let tier
  let restore = false
  let adoptCustom = false
  let kitDir = DEFAULT_KIT_SKILLS_DIR

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/equip.mjs [目标目录] [选项]',
        '',
        '  --tier <lightweight|full>  装配档位（lightweight 3 技能 / full 全套 5 技能）',
        '  --check                    只读校验，不一致退出码 1（已豁免定制文件退出 0）',
        '  --adopt-custom [path]      将手工修改的托管技能登记为定制豁免',
        '  --restore [pathOrSkill]    显式恢复此前删除记入墓碑的技能或文件',
        '  --dry-run                  仅打印将执行的操作，不写文件',
        '  --no-backup                写入前不自动创建增量保护快照',
        '  --bootstrap-empty          为空目录生成最小可运行骨架与初始 docs/TDD.md',
        '  --lang <lang>              骨架语言：node | python | go | rust | java | docs',
        '  --name <name>              项目名称（默认取目录名）',
        '  --description <text>       项目一句话简介（仅 --bootstrap-empty 时生效）',
        '',
      ].join('\n'))
      return 0
    }
    if (arg === '--check') check = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--no-backup') noBackup = true
    else if (arg === '--bootstrap-empty') doBootstrap = true
    else if (arg === '--tier') tier = argv[++i]
    else if (arg.startsWith('--tier=')) tier = arg.slice('--tier='.length)
    else if (arg === '--lang') lang = argv[++i]
    else if (arg.startsWith('--lang=')) lang = arg.slice('--lang='.length)
    else if (arg === '--name') name = argv[++i]
    else if (arg.startsWith('--name=')) name = arg.slice('--name='.length)
    else if (arg === '--description') description = argv[++i] ?? ''
    else if (arg.startsWith('--description=')) description = arg.slice('--description='.length)
    else if (arg === '--kit-dir') kitDir = resolve(argv[++i] || '')
    else if (arg.startsWith('--kit-dir=')) kitDir = resolve(arg.slice('--kit-dir='.length))
    else if (arg === '--restore') {
      const peek = consumeOptionalValue(argv, i, targetSpecified)
      if (peek.consumed) i += 1
      restore = peek.value === true ? true : [...(Array.isArray(restore) ? restore : []), peek.value]
    } else if (arg.startsWith('--restore=')) {
      const val = arg.slice('--restore='.length)
      restore = [...(Array.isArray(restore) ? restore : []), val || '*']
    } else if (arg === '--adopt-custom') {
      const peek = consumeOptionalValue(argv, i, targetSpecified)
      if (peek.consumed) i += 1
      adoptCustom = peek.value === true ? true : [...(Array.isArray(adoptCustom) ? adoptCustom : []), peek.value]
    } else if (arg.startsWith('--adopt-custom=')) {
      const val = arg.slice('--adopt-custom='.length)
      adoptCustom = [...(Array.isArray(adoptCustom) ? adoptCustom : []), val || '*']
    } else if (!arg.startsWith('-') && !targetSpecified) {
      target = arg
      targetSpecified = true
    } else {
      process.stderr.write(`未知参数：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    if (check) {
      const res = checkEquip(target, { kitDir, tier })
      if (!res.ok) {
        process.stderr.write(`${formatCheckReport(res)}\n`)
        return 1
      }
      process.stdout.write(`套件校验通过：${res.manifestPath}\n`)
      if (res.customized.length > 0) {
        process.stdout.write(`${formatCheckReport({ missing: [], drifted: [], unregistered: [], extraManaged: [], customized: res.customized })}\n`)
      }
      return 0
    }

    let bootstrapResult
    if (doBootstrap) {
      bootstrapResult = bootstrapEmpty(target, { lang, name, description, dryRun })
      if (!existsSync(kitDir)) {
        process.stdout.write(`${JSON.stringify({ bootstrap: bootstrapResult, equip: null }, null, 2)}\n`)
        return 0
      }
    }

    const equipResult = equip(target, { kitDir, tier, dryRun, noBackup, restore, adoptCustom })
    process.stdout.write(`${JSON.stringify({
      ...(bootstrapResult ? { bootstrap: bootstrapResult } : {}),
      equip: equipResult,
    }, null, 2)}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`equip 失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

export { bootstrapEmpty, starterTemplates }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
