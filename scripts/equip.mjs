#!/usr/bin/env node
/**
 * `.agents/skills/` 工程套件统一装配、manifest v3 墓碑/定制豁免、
 * 字节级校验与通用空白工程初始化。
 *
 * - 只使用 Node 18+ 内置模块，零第三方依赖。
 * - 按 `kit/skills/` 已落盘技能执行统一全量装配，支持 `--adopt-custom` 定制豁免与 `--restore` 恢复。
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensurePreWriteBackup } from './backup.mjs'
import { clearStaleTemps, writeAtomic } from './lib/fs-atomic.mjs'
import { detectIgnoredGovernancePaths } from './lib/survey-workspace.mjs'
import { cleanStaleLocalModeMarker } from '../kit/skills/lib/platform.mjs'
import { detectOptionalNativeCheckers } from '../kit/skills/lib/profile-sniffer.mjs'
import {
  generateInitialBootstrappedAgents,
  installGitHooks,
  normalizeCustomizedFiles,
  normalizedSha256,
  normalizePendingConflicts,
  normalizePrevFiles,
  normalizeRemovedFiles,
  normalizeStringArray,
  pruneEmptyParents,
  readExistingManifest,
  sortObjectKeys,
  walkKitFiles,
} from './lib/equip-bootstrap.mjs'
import { captureMemoryRollbackSnapshot, verifyEquippedIntegrityOrRollback } from './lib/equip-integrity.mjs'
import {
  buildPendingConflictDetails,
  cacheBaselineBuffer,
  collectManagedDirExtras,
  createBaselineResolver,
  inspectInstalledIntegrity,
  resolveConflictDir,
} from './lib/equip-upgrade.mjs'
import { computeFileStates, EQUIP_FILE_STATES, formatEquipCheckReport, isCodeLikePath, judgeManagedFile, resolveThreeWayEquipFile } from './lib/merge3.mjs'
import { bootstrapEmpty, starterTemplates } from './lib/starter-templates.mjs'
import { DEFAULT_KIT_SKILLS_DIR } from '../kit/skills/lib/skill-discovery.mjs'
import { recordStepStateSafe } from '../kit/skills/lib/session-state.mjs'
import {
  PF_MANIFEST_REL,
  PF_MANIFEST_SCHEMA_VERSION,
  getKitSkills,
} from './lib/protocol.mjs'
import { flushAndExit, isMainModule, posixPath, readTextSafe, skillVersion } from './lib/text.mjs'

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_GITKEEP_PATHS = ['docs/prd/.gitkeep', 'docs/specs/.gitkeep', 'docs/todo/.gitkeep']

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

/**
 * 字节级与结构一致性只读校验 `<targetDir>/.agents/skills/`（含核心技能、跨目录导入断链与 YAML frontmatter 校验）。
 */
export function checkEquip(targetDir, { kitDir = DEFAULT_KIT_SKILLS_DIR, env = process.env } = {}) {
  const root = resolve(targetDir)
  const skillsDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, PF_MANIFEST_REL)
  const conflictDir = resolveConflictDir(root, { env })

  if (!existsSync(kitDir)) {
    return { ok: false, reason: `找不到源套件目录：${kitDir}`, missing: [], drifted: [], unregistered: [], extraManaged: [], customized: [] }
  }
  if (existsSync(skillsDir)) clearStaleTemps(skillsDir, { recursive: true })

  const existing = readExistingManifest(manifestPath)
  const kitSkills = getKitSkills(kitDir)
  const kitFiles = walkKitFiles(kitDir)
  const prevFiles = normalizePrevFiles(existing.data?.files)
  const disabledSet = new Set(existing.valid ? normalizeStringArray(existing.data?.disabledSkills) : [])
  const removedMap = existing.valid ? normalizeRemovedFiles(existing.data?.removedFiles) : {}
  const customizedMap = existing.valid ? normalizeCustomizedFiles(existing.data?.customizedFiles) : {}
  const pendingConflictsMap = existing.valid ? normalizePendingConflicts(existing.data?.pendingConflicts) : {}
  const pendingConflicts = Object.keys(pendingConflictsMap).sort()
  const pendingConflictDetails = buildPendingConflictDetails(pendingConflictsMap, skillsDir, conflictDir)

  const missing = []
  const drifted = []
  const unregistered = []
  const extraManaged = []
  const customized = []

  if (!existing.exists) missing.push(PF_MANIFEST_REL)
  else if (!existing.valid) drifted.push(PF_MANIFEST_REL)

  const inspectManagedEntry = (rel, src) => {
    const dest = join(skillsDir, rel)
    if (!existsSync(dest)) { missing.push(rel); return }
    const diskHash = normalizedSha256(readFileSync(dest))
    // 逐文件判定只算一次：校验路径与写入路径读它，状态与修法不会分叉。
    const verdict = judgeManagedFile({
      rel,
      upstreamSha: src.sha256,
      diskSha: diskHash,
      baselineSha: prevFiles.get(rel) ?? null,
      customEntry: customizedMap[rel] ?? null,
      pendingEntry: pendingConflictsMap[rel] ?? null,
      conflictDir,
      skillsDir,
    })
    if (verdict.state === EQUIP_FILE_STATES.SYNCED) {
      if (existing.valid && prevFiles.get(rel) !== src.sha256) unregistered.push(rel)
      return
    }
    if (verdict.state === EQUIP_FILE_STATES.EXEMPT_CUSTOM) {
      const customEntry = customizedMap[rel]
      customized.push({
        path: rel, adoptedAt: customEntry.adoptedAt, baseSha256: customEntry.baseSha256,
        upstreamSha256: customEntry.upstreamSha256, upstreamChanged: customEntry.upstreamSha256 !== src.sha256,
      })
      return
    }
    drifted.push(verdict.fixHint ? { path: rel, state: verdict.state, fixHint: verdict.fixHint } : rel)
  }

  for (const [rel, src] of kitFiles.entries()) {
    const top = rel.split('/')[0]
    if (disabledSet.has(top) || removedMap[rel]) continue
    inspectManagedEntry(rel, src)
  }

  if (existing.valid) {
    for (const rel of prevFiles.keys()) {
      const top = rel.split('/')[0]
      if (disabledSet.has(top) || removedMap[rel] || kitFiles.has(rel)) continue
      extraManaged.push(rel)
    }
  }
  for (const rel of collectManagedDirExtras(skillsDir, kitFiles, customizedMap, null, kitSkills, pendingConflictsMap)) {
    if (!extraManaged.includes(rel)) extraManaged.push(rel)
  }
  extraManaged.sort()
  const integrity = inspectInstalledIntegrity(skillsDir, disabledSet, removedMap, existing.exists, kitSkills)

  const ok = existing.exists && existing.valid
    && missing.length === 0 && drifted.length === 0
    && unregistered.length === 0 && extraManaged.length === 0
    && pendingConflicts.length === 0
    && integrity.brokenImports.length === 0
    && integrity.invalidFrontmatters.length === 0

  return {
    ok, target: root, schemaVersion: existing.data?.schemaVersion,
    manifestPath: PF_MANIFEST_REL, missing, drifted, unregistered, extraManaged, customized,
    pendingConflicts,
    ...(pendingConflictDetails.length > 0 ? { conflictDir, pendingConflictDetails } : {}),
    disabledCoreSkills: integrity.disabledCoreSkills,
    brokenImports: integrity.brokenImports,
    invalidFrontmatters: integrity.invalidFrontmatters,
    disabledSkills: [...disabledSet].sort(), removedFiles: Object.keys(removedMap).sort(),
  }
}

/**
 * 将 `kit/skills/**` 按统一全量装配策略与 manifest v3（删除墓碑 + 定制豁免 + 三方合并冲突记录）同步到 `<targetDir>/.agents/skills/**`。
 */
export function equip(targetDir, {
  kitDir = DEFAULT_KIT_SKILLS_DIR,
  baseDir = null,
  baseContents = null,
  dryRun = false,
  noBackup = false,
  restore = false,
  adoptCustom = false,
  skipIntegrityCheck = false,
  env = process.env,
  forgeVersion = skillVersion(readTextSafe(join(SKILL_ROOT, 'SKILL.md'))) || '0.0.0',
  now = new Date().toISOString(),
} = {}) {
  const root = resolve(targetDir)
  if (!existsSync(kitDir)) throw new Error(`找不到源套件目录：${kitDir}`)

  const skillsDir = join(root, '.agents', 'skills')
  if (existsSync(skillsDir)) clearStaleTemps(skillsDir, { dryRun, recursive: true })
  const ignoredGovernancePaths = detectIgnoredGovernancePaths(root)
  const manifestPath = join(root, PF_MANIFEST_REL)
  const existing = readExistingManifest(manifestPath)
  const kitSkills = getKitSkills(kitDir)
  const kitFiles = walkKitFiles(kitDir)
  const resolver = createBaselineResolver(root, { env })
  const conflictDir = resolver.conflictDir

  const prevFiles = normalizePrevFiles(existing.data?.files)
  const disabledSet = new Set(existing.valid ? normalizeStringArray(existing.data?.disabledSkills) : [])
  const removedMap = existing.valid ? normalizeRemovedFiles(existing.data?.removedFiles) : {}
  const nextCustomized = existing.valid ? normalizeCustomizedFiles(existing.data?.customizedFiles) : {}
  const nextPendingConflicts = existing.valid ? normalizePendingConflicts(existing.data?.pendingConflicts) : {}

  const restoreMatcher = buildFilterMatcher(restore)
  const adoptMatcher = buildFilterMatcher(adoptCustom)

  const untrackedCustomSkills = new Set()
  for (const skill of kitSkills) {
    if (disabledSet.has(skill)) continue
    const skillMdRel = `${skill}/SKILL.md`
    const skillMdAbs = join(skillsDir, skillMdRel)
    if (!existsSync(skillMdAbs)) continue
    const hasAnyTracked = [...prevFiles.keys()].some((r) => r === skillMdRel || r.startsWith(`${skill}/`))
    const upSkillMd = kitFiles.get(skillMdRel)
    if (!hasAnyTracked && upSkillMd && normalizedSha256(readFileSync(skillMdAbs)) !== upSkillMd.sha256) {
      untrackedCustomSkills.add(skill)
    }
  }

  if (restoreMatcher) {
    for (const skill of [...disabledSet]) if (restoreMatcher(skill)) disabledSet.delete(skill)
    for (const rel of Object.keys(removedMap)) if (restoreMatcher(rel)) delete removedMap[rel]
  }

  const tombstonedNew = []
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
      if (!existsSync(join(skillsDir, skill))) {
        disabledSet.add(skill)
        tombstonedNew.push(skill)
        for (const rel of Object.keys(removedMap)) if (rel === skill || rel.startsWith(`${skill}/`)) delete removedMap[rel]
        for (const rel of Object.keys(nextCustomized)) if (rel === skill || rel.startsWith(`${skill}/`)) delete nextCustomized[rel]
      }
    }
    for (const [rel, oldHash] of prevFiles.entries()) {
      const top = rel.split('/')[0]
      if (disabledSet.has(top) || !kitFiles.has(rel)) continue
      if (restoreMatcher && restoreMatcher(rel)) continue
      if (!existsSync(join(skillsDir, rel))) {
        if (!removedMap[rel]) {
          removedMap[rel] = { removedAt: now, baseSha256: oldHash }
          tombstonedNew.push(rel)
        }
        delete nextCustomized[rel]
      }
    }
  }

  const added = []
  const restored = []
  const upgraded = []
  const merged = []
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
  const queueDelete = (filePath, stopDir = skillsDir) => {
    if (existsSync(filePath) && !pendingDeletes.some((d) => d.dest === filePath)) {
      pendingDeletes.push({ dest: filePath, stopDir })
    }
  }
  const clearConflictSidecars = (rel, dest) => {
    const prevEntry = nextPendingConflicts[rel]
    delete nextPendingConflicts[rel]
    const inTreeCandidates = [`${dest}.upstream`, `${dest}.pf-conflict`]
    if (prevEntry && prevEntry.outOfTree !== true) {
      if (prevEntry.upstreamFile) inTreeCandidates.push(join(skillsDir, prevEntry.upstreamFile))
      if (prevEntry.conflictFile) inTreeCandidates.push(join(skillsDir, prevEntry.conflictFile))
    }
    for (const side of inTreeCandidates) queueDelete(side, skillsDir)
    const outCandidates = [
      join(conflictDir, `${rel}.upstream`),
      join(conflictDir, `${rel}.pf-conflict`),
      ...(prevEntry?.upstreamFile ? [join(conflictDir, prevEntry.upstreamFile)] : []),
      ...(prevEntry?.conflictFile ? [join(conflictDir, prevEntry.conflictFile)] : []),
    ]
    for (const side of outCandidates) queueDelete(side, conflictDir)
  }
  const lookupBaseText = (rel, targetHash) => {
    if (baseContents && Object.prototype.hasOwnProperty.call(baseContents, rel)) return baseContents[rel]
    if (baseDir && existsSync(join(baseDir, rel))) return readTextSafe(join(baseDir, rel))
    return targetHash ? resolver.resolveBaseText(rel, targetHash) : null
  }
  const applyThreeWayPlan = (rel, dest, src, oldHash, diskHash, baseText, fallbackOldHash) => {
    const plan = resolveThreeWayEquipFile({
      rel, dest, srcBuf: src.buf, srcSha: src.sha256, oldHash: fallbackOldHash, diskHash,
      currentText: readFileSync(dest, 'utf8'), baseText, now, conflictDir, outOfTree: true,
    })
    if (plan.kind === 'merged') {
      const mergedSha = normalizedSha256(plan.buf)
      pendingWrites.push({ dest, buf: plan.buf })
      nextFiles[rel] = { sha256: src.sha256 }
      if (mergedSha === src.sha256) delete nextCustomized[rel]
      else nextCustomized[rel] = { adoptedAt: now, baseSha256: mergedSha, upstreamSha256: src.sha256 }
      clearConflictSidecars(rel, dest)
      merged.push(rel)
      return
    }
    pendingWrites.push(...plan.writes)
    nextPendingConflicts[rel] = plan.pendingEntry
    nextFiles[rel] = { sha256: oldHash || fallbackOldHash || src.sha256 }
    conflicts.push(plan.conflictRecord)
  }

  const kitKeys = [...kitFiles.keys()].sort()
  for (const rel of kitKeys) {
    const src = kitFiles.get(rel)
    const top = rel.split('/')[0]
    if (untrackedCustomSkills.has(top)) {
      if (rel === `${top}/SKILL.md`) {
        const dest = join(skillsDir, rel)
        const diskHash = normalizedSha256(readFileSync(dest))
        conflicts.push({ path: rel, reason: 'untracked-modified', diskSha256: diskHash, incomingSha256: src.sha256 })
      }
      continue
    }
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
    if (diskHash === src.sha256) {
      nextFiles[rel] = { sha256: src.sha256 }
      delete nextCustomized[rel]
      clearConflictSidecars(rel, dest)
      unchanged.push(rel)
      continue
    }

    if (restoreMatcher && (restoreMatcher(rel) || restoreMatcher(top))) {
      pendingWrites.push({ dest, buf: src.buf })
      nextFiles[rel] = { sha256: src.sha256 }
      delete nextCustomized[rel]
      clearConflictSidecars(rel, dest)
      restored.push(rel)
      continue
    }

    if (adoptMatcher && adoptMatcher(rel)) {
      nextCustomized[rel] = { adoptedAt: now, baseSha256: diskHash, upstreamSha256: src.sha256 }
      nextFiles[rel] = { sha256: oldHash || src.sha256 }
      clearConflictSidecars(rel, dest)
      adopted.push(rel)
      customized.push({ path: rel, upstreamChanged: false })
      continue
    }

    const customEntry = nextCustomized[rel]
    if (customEntry && customEntry.baseSha256 === diskHash) {
      if (customEntry.upstreamSha256 === src.sha256) {
        nextFiles[rel] = { sha256: oldHash || src.sha256 }
        customized.push({ path: rel, upstreamChanged: false })
        continue
      }
      const targetBaseHash = customEntry.upstreamSha256 || oldHash
      const baseText = lookupBaseText(rel, targetBaseHash)
      applyThreeWayPlan(rel, dest, src, oldHash, diskHash, baseText, targetBaseHash)
      continue
    }

    if (!oldHash) {
      conflicts.push({ path: rel, reason: 'untracked-modified', diskSha256: diskHash, incomingSha256: src.sha256 })
      continue
    }

    if (diskHash === oldHash) {
      pendingWrites.push({ dest, buf: src.buf })
      nextFiles[rel] = { sha256: src.sha256 }
      clearConflictSidecars(rel, dest)
      upgraded.push(rel)
      continue
    }

    const baseText = oldHash !== src.sha256 ? lookupBaseText(rel, oldHash) : null
    if (oldHash !== src.sha256 && (baseText != null || isCodeLikePath(rel))) {
      applyThreeWayPlan(rel, dest, src, oldHash, diskHash, baseText, oldHash)
      continue
    }

    nextFiles[rel] = { sha256: oldHash }
    conflicts.push({
      path: rel,
      reason: customEntry ? 're-edited-custom' : 'modified-preserved',
      baselineSha256: oldHash,
      diskSha256: diskHash,
      incomingSha256: src.sha256,
    })
  }

  if (adoptMatcher) {
    for (const extraRel of collectManagedDirExtras(skillsDir, kitFiles, {}, null, kitSkills)) {
      if (!adoptMatcher(extraRel)) continue
      const abs = join(skillsDir, extraRel)
      if (!existsSync(abs)) continue
      const up = kitFiles.get(extraRel)
      nextCustomized[extraRel] = {
        adoptedAt: now,
        baseSha256: normalizedSha256(readFileSync(abs)),
        upstreamSha256: up ? up.sha256 : null,
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
      queueDelete(dest, skillsDir)
      retired.push(rel)
      delete nextCustomized[rel]
    } else {
      orphanedModified.push({ path: rel, status: 'orphaned-modified', baselineSha256: oldHash, diskSha256: diskHash })
    }
  }

  for (const relKeep of DOCS_GITKEEP_PATHS) {
    const keepDest = join(root, relKeep)
    if (!existsSync(keepDest)) {
      pendingWrites.push({ dest: keepDest, buf: Buffer.alloc(0) })
      ensuredGitkeeps.push(relKeep)
    }
  }

  const nextManifest = {
    schemaVersion: PF_MANIFEST_SCHEMA_VERSION,
    forgeVersion,
    installedAt: existing.data?.installedAt || now,
    files: sortObjectKeys(Object.fromEntries(Object.entries(nextFiles).map(([k, v]) => [k, v]))),
    disabledSkills: [...disabledSet].sort(),
    removedFiles: sortObjectKeys(removedMap),
    customizedFiles: sortObjectKeys(nextCustomized),
    pendingConflicts: sortObjectKeys(nextPendingConflicts),
    agentsRegions: existing.data?.agentsRegions && typeof existing.data.agentsRegions === 'object' ? { ...existing.data.agentsRegions } : {},
    removedAgentsRegions: existing.valid ? normalizeStringArray(existing.data?.removedAgentsRegions) : [],
  }

  const prevNormalizedRaw = existing.valid ? JSON.stringify({
    schemaVersion: existing.data.schemaVersion, forgeVersion: existing.data.forgeVersion,
    installedAt: existing.data.installedAt, files: sortObjectKeys(existing.data.files),
    disabledSkills: normalizeStringArray(existing.data.disabledSkills),
    removedFiles: normalizeRemovedFiles(existing.data.removedFiles),
    customizedFiles: normalizeCustomizedFiles(existing.data.customizedFiles),
    pendingConflicts: normalizePendingConflicts(existing.data.pendingConflicts),
    agentsRegions: existing.data.agentsRegions ?? {},
    removedAgentsRegions: normalizeStringArray(existing.data.removedAgentsRegions),
  }) : ''

  const manifestChanged = !existing.exists || !existing.valid || prevNormalizedRaw !== JSON.stringify(nextManifest)
  if (manifestChanged && existing.valid && prevNormalizedRaw !== '') {
    nextManifest.installedAt = pendingWrites.length > 0 || pendingDeletes.length > 0 ? now : nextManifest.installedAt
  }

  const hasPendingChanges = pendingWrites.length > 0 || pendingDeletes.length > 0 || manifestChanged
  const backup = dryRun
    ? { created: false, skippedReason: 'dry-run' }
    : (noBackup
        ? { created: false, skippedReason: 'disabled' }
        : (!hasPendingChanges
            ? { created: false, skippedReason: 'no-pending-changes' }
            : ensurePreWriteBackup(root, { label: 'equip', hasPendingChanges: true })))

  let cleanedStaleLocalMode = []
  let integrityCheck = null
  if (!dryRun) {
    const memorySnapshot = captureMemoryRollbackSnapshot([
      ...pendingWrites.map((item) => item.dest),
      ...pendingDeletes.map((item) => item.dest),
      manifestPath,
    ])
    for (const item of pendingWrites) {
      mkdirSync(dirname(item.dest), { recursive: true })
      writeAtomic(item.dest, item.buf)
    }
    for (const item of pendingDeletes) {
      if (existsSync(item.dest)) {
        unlinkSync(item.dest)
        pruneEmptyParents(item.dest, item.stopDir)
      }
    }
    if (manifestChanged) {
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
    }
    if (!skipIntegrityCheck && (pendingWrites.length > 0 || pendingDeletes.length > 0)) {
      const writtenMjsFiles = pendingWrites
        .map((item) => item.dest)
        .filter((p) => p.endsWith('.mjs') && p.startsWith(skillsDir))
      const isFreshBuiltInCopy = resolve(kitDir) === resolve(DEFAULT_KIT_SKILLS_DIR)
        && merged.length === 0 && upgraded.length === 0 && restored.length === 0
      integrityCheck = verifyEquippedIntegrityOrRollback({
        root, skillsDir, backupInfo: backup, memorySnapshot,
        targetFiles: writtenMjsFiles,
        skipPristineSyntaxCheck: isFreshBuiltInCopy,
      })
      if (!integrityCheck.ok) {
        const syn = integrityCheck.syntaxErrors.map((e) => `${e.file}: ${e.message}`)
        const abi = integrityCheck.abiErrors.map((e) => e.message)
        throw new Error(`EQUIP_INTEGRITY_ROLLBACK: 语法/ESM ABI 校验失败并已自动回滚（${integrityCheck.rollbackMethod}）：${[...syn, ...abi].slice(0, 4).join('；')}`)
      }
    }
    for (const src of kitFiles.values()) {
      cacheBaselineBuffer(resolver.cacheDir, src.sha256, src.buf)
    }
    const cleaned = cleanStaleLocalModeMarker(root)
    if (cleaned.cleaned) cleanedStaleLocalMode = cleaned.removed
  }

  const pendingConflictDetails = buildPendingConflictDetails(nextManifest.pendingConflicts, skillsDir, conflictDir)
  return {
    target: root, schemaVersion: PF_MANIFEST_SCHEMA_VERSION, dryRun, backup,
    manifestPath: PF_MANIFEST_REL, manifestUpdated: manifestChanged,
    added, restored, upgraded, merged, unchanged, conflicts, retired,
    orphanedModified, adopted, customized,
    tombstonedNew: tombstonedNew.sort(),
    ...(tombstonedNew.length > 0 ? { tombstoneNotice: '已登记 v3 用户删除墓碑，未经人点头严禁 --restore' } : {}),
    pendingConflicts: nextManifest.pendingConflicts,
    ...(pendingConflictDetails.length > 0 ? { conflictDir, pendingConflictDetails } : {}),
    // 写完之后再判一次：动作能解决的都解决了，剩下什么才是结论。
    // 校验路径拿同一个判定算，两条路径对同一份工作区因此给出同一个状态序列。
    endingStates: (() => {
      const diskHashes = new Map()
      for (const rel of kitFiles.keys()) {
        const dest = join(skillsDir, rel)
        diskHashes.set(rel, existsSync(dest) ? normalizedSha256(readFileSync(dest)) : null)
      }
      const files = new Map([...kitFiles].map(([rel, src]) => [rel, { sha256: src.sha256 }]))
      return computeFileStates({
        files, diskHashes,
        baseline: new Map(Object.entries(nextFiles).map(([rel, info]) => [rel, info.sha256])),
        customized: nextCustomized, pendingConflicts: nextPendingConflicts,
      })
    })(),
    ...(integrityCheck ? { integrityCheck } : {}),
    disabledSkills: nextManifest.disabledSkills, removedFiles: Object.keys(nextManifest.removedFiles), ensuredGitkeeps,
    ...(ignoredGovernancePaths.length > 0 ? {
      ignoredGovernancePaths,
      warnings: ignoredGovernancePaths.map((x) => `关键治理路径被 ${x.source} (${x.pattern}) 遮蔽：${x.path}——${x.advice}`),
    } : {}),
    ...(cleanedStaleLocalMode.length > 0 ? { cleanedStaleLocalMode } : {}),
  }
}

function formatCheckReport(res) {
  return formatEquipCheckReport(res)
}

function consumeOptionalValue(argv, idx, targetSpecified, kitDir = DEFAULT_KIT_SKILLS_DIR) {
  const next = argv[idx + 1]
  if (!next || next.startsWith('-')) return { value: true, consumed: false }
  const norm = normalizeSkillFilterArg(next)
  const knownSkills = getKitSkills(kitDir)
  const looksLikeSkill = knownSkills.includes(norm) || norm.startsWith('lib/') || norm.includes('/')
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
  let withHooks = false
  let stack
  let lang
  let name
  let description = ''
  let restore = false
  let adoptCustom = false
  let kitDir = DEFAULT_KIT_SKILLS_DIR
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--kit-dir' && argv[k + 1]) kitDir = resolve(argv[k + 1])
    else if (argv[k].startsWith('--kit-dir=')) kitDir = resolve(argv[k].slice('--kit-dir='.length))
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      const skillCount = getKitSkills(kitDir).length
      process.stdout.write([
        '用法：node scripts/equip.mjs [目标目录] [选项]',
        '',
        `  （默认）                   统一完整装配全部已落盘研发技能（当前 ${skillCount} 套）并写入 .pf-manifest.json`,
        '  --check                    只读校验，不一致退出码 3（已豁免定制文件退出 0）',
        '  --adopt-custom [path]      将手工修改或二次编辑的托管技能登记为定制豁免',
        '  --restore [pathOrSkill]    显式恢复此前删除记入墓碑的技能或文件',
        '  --dry-run                  仅打印将执行的操作，不写文件',
        '  --no-backup                写入前不自动创建增量保护快照',
        '  --bootstrap-empty          为空目录（或仅含 README/LICENSE/.github/.agents）生成通用基线、TDD 与自洽 AGENTS.md',
        '  --with-hooks               安装跨宿主 .githooks/pre-push 防直推护栏并配局部 core.hooksPath（遇既有钩子 preserve）',
        '  --stack <stack>            基线栈提示（默认 universal；--lang 为兼容别名）',
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
    else if (arg === '--with-hooks') withHooks = true
    else if (arg === '--stack') stack = argv[++i]
    else if (arg.startsWith('--stack=')) stack = arg.slice('--stack='.length)
    else if (arg === '--lang') lang = argv[++i]
    else if (arg.startsWith('--lang=')) lang = arg.slice('--lang='.length)
    else if (arg === '--name') name = argv[++i]
    else if (arg.startsWith('--name=')) name = arg.slice('--name='.length)
    else if (arg === '--description') description = argv[++i] ?? ''
    else if (arg.startsWith('--description=')) description = arg.slice('--description='.length)
    else if (arg === '--kit-dir') kitDir = resolve(argv[++i] || '')
    else if (arg.startsWith('--kit-dir=')) kitDir = resolve(arg.slice('--kit-dir='.length))
    else if (arg === '--base-dir') i += 1
    else if (arg.startsWith('--base-dir=')) continue
    else if (arg === '--restore') {
      const peek = consumeOptionalValue(argv, i, targetSpecified, kitDir)
      if (peek.consumed) i += 1
      restore = peek.value === true ? true : [...(Array.isArray(restore) ? restore : []), peek.value]
    } else if (arg.startsWith('--restore=')) {
      const val = arg.slice('--restore='.length)
      restore = [...(Array.isArray(restore) ? restore : []), val || '*']
    } else if (arg === '--adopt-custom') {
      const peek = consumeOptionalValue(argv, i, targetSpecified, kitDir)
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
      const res = checkEquip(target, { kitDir })
      if (!res.ok) {
        process.stderr.write(`${formatCheckReport(res)}\n`)
        // 和写入路径同一个非零码：「待处置」这件事不该有两个编号。
        return 3
      }
      process.stdout.write(`套件校验通过：${res.manifestPath}\n`)
      if (res.customized.length > 0) {
        process.stdout.write(`${formatCheckReport({ missing: [], drifted: [], unregistered: [], extraManaged: [], customized: res.customized })}\n`)
      }
      return 0
    }

    let bootstrapResult
    if (doBootstrap) {
      bootstrapResult = bootstrapEmpty(target, { stack, lang, name, description, dryRun })
      if (!existsSync(kitDir)) {
        process.stdout.write(`${JSON.stringify({ bootstrap: bootstrapResult, equip: null }, null, 2)}\n`)
        return 0
      }
    }

    let baseDir = null
    for (let k = 0; k < argv.length; k++) {
      if (argv[k] === '--base-dir' && argv[k + 1]) baseDir = resolve(argv[k + 1])
      else if (argv[k].startsWith('--base-dir=')) baseDir = resolve(argv[k].slice('--base-dir='.length))
    }
    const equipResult = equip(target, { kitDir, baseDir, dryRun, noBackup, restore, adoptCustom })
    if ((equipResult.warnings?.length ?? 0) > 0) {
      for (const w of equipResult.warnings) process.stderr.write(`[WARN] ${w}\n`)
    }
    if (!dryRun) recordStepStateSafe(target, { step: 'S3', ok: true, summary: 'equipped' })
    let hooksResult
    if (withHooks) {
      hooksResult = installGitHooks(target, { dryRun })
    }
    let agentsResult
    if (doBootstrap && !dryRun) {
      agentsResult = await generateInitialBootstrappedAgents(target, { stack: stack ?? lang ?? 'universal', name, noBackup })
    }
    const nativeCheckers = detectOptionalNativeCheckers(target)
    const pendingIgnoreAdvice = (nativeCheckers.agentIgnoreAdvice ?? []).filter((a) => !a.alreadyIgnored)
    process.stdout.write(`${JSON.stringify({
      ...(bootstrapResult ? { bootstrap: bootstrapResult } : {}),
      equip: equipResult,
      ...(hooksResult ? { hooks: hooksResult } : {}),
      ...(agentsResult ? { agents: agentsResult } : {}),
      ...(pendingIgnoreAdvice.length > 0 ? { agentIgnoreAdvice: pendingIgnoreAdvice } : {}),
    }, null, 2)}\n`)
    // 退出码只看逐文件判定：写入路径能解决的都解决了，结束状态里还有需要处置的，
    // 就和校验路径一样退 3。「本地改动被保留」在过去只进运行报告，写路径因此永远退 0，
    // 而校验路径退 1——同一个动作两个相反结论，根因是两条路径读的不是同一个判定。
    const endingBlocking = equipResult.endingStates?.blocking ?? []
    if (!dryRun && endingBlocking.length > 0) return 3
    return 0
  } catch (err) {
    process.stderr.write(`equip 失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

export { main as runCli, bootstrapEmpty, starterTemplates }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`equip 失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(2)
    })
}
