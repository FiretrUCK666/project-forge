/**
 * critique-store.mjs —— 规划内审条目（ledger.planCritique / sidecar）同步与异步原子持久化原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 critique-rounds.mjs 与 doc-plan-ops.mjs 共用。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path, { resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { resolveCommonGitDir, resolveGitDirFast } from './git-fast.mjs'
import {
  posixPath, readJsonSafe, readTextSafe, sha256Text, withFileLock, withFileLockSync, writeJsonAtomic,
} from './git.mjs'
import { readTaskLedger, sanitizeTaskId, updateTaskLedger, writeTaskLedger } from './ledger.mjs'

function makeStoreError(code, exitCode, message) {
  return Object.assign(new Error(message), { code, exitCode })
}

export function resolveEffectiveRoots(repoRoot, mainRoot, gitDir) {
  const rawGitDir = gitDir && existsSync(resolve(gitDir))
    ? resolve(gitDir)
    : (resolveGitDirFast(repoRoot) ?? (mainRoot && mainRoot !== repoRoot ? resolveGitDirFast(mainRoot) : null))
  const effGitDir = resolveCommonGitDir(rawGitDir, { treatAsGitDir: true })
  let effMainRoot = mainRoot && mainRoot !== repoRoot ? resolve(mainRoot) : resolve(repoRoot)
  if ((!mainRoot || mainRoot === repoRoot) && effGitDir && path.basename(effGitDir) === '.git') {
    effMainRoot = path.dirname(effGitDir)
  }
  return { effMainRoot, effGitDir }
}

export function sidecarCritiqueFile(repoRoot, effectiveGitDir) {
  const commonGitDir = resolveCommonGitDir(effectiveGitDir, { treatAsGitDir: true }) ?? effectiveGitDir
  if (commonGitDir) return path.join(commonGitDir, 'project-forge-flow', 'plan-critique-state.json')
  return path.join(os.tmpdir(), 'pf-plan-critique', `${sha256Text(resolve(repoRoot)).slice(0, 16)}.json`)
}

function mergeCritiqueEntries(sidecarEntry, ledgerEntry) {
  if (!sidecarEntry) return ledgerEntry ?? null
  if (!ledgerEntry) return sidecarEntry
  const roundsMap = new Map()
  for (const r of Array.isArray(sidecarEntry.rounds) ? sidecarEntry.rounds : []) {
    if (r && typeof r === 'object') roundsMap.set(Number(r.round) || 0, r)
  }
  for (const r of Array.isArray(ledgerEntry.rounds) ? ledgerEntry.rounds : []) {
    if (r && typeof r === 'object') roundsMap.set(Number(r.round) || 0, r)
  }
  const rounds = [...roundsMap.values()].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))
  const findingsSeen = new Set()
  const findings = []
  for (const f of [...(sidecarEntry.findings ?? []), ...(ledgerEntry.findings ?? [])]) {
    if (!f || typeof f !== 'object') continue
    const k = `${f.round ?? ''}:${f.verdict ?? ''}:${(Array.isArray(f.items) ? f.items : [f.text]).join('|')}`
    if (!findingsSeen.has(k)) { findingsSeen.add(k); findings.push(f) }
  }
  const structMap = new Map()
  for (const sf of Array.isArray(sidecarEntry.structuredFindings) ? sidecarEntry.structuredFindings : []) {
    if (sf?.id) structMap.set(sf.id, sf)
  }
  for (const sf of Array.isArray(ledgerEntry.structuredFindings) ? ledgerEntry.structuredFindings : []) {
    if (sf?.id) structMap.set(sf.id, sf)
  }
  const sideContAt = Date.parse(sidecarEntry.continued?.at ?? '') || 0
  const ledContAt = Date.parse(ledgerEntry.continued?.at ?? '') || 0
  const continued = sideContAt > ledContAt
    ? sidecarEntry.continued
    : (ledgerEntry.continued ?? sidecarEntry.continued)
  const sideUp = Date.parse(sidecarEntry.updatedAt ?? '') || 0
  const ledUp = Date.parse(ledgerEntry.updatedAt ?? '') || 0
  return {
    ...sidecarEntry,
    ...ledgerEntry,
    rounds,
    findings,
    structuredFindings: [...structMap.values()],
    roundSnapshots: { ...(sidecarEntry.roundSnapshots ?? {}), ...(ledgerEntry.roundSnapshots ?? {}) },
    ...(continued ? { continued } : {}),
    override: ledgerEntry.override ?? sidecarEntry.override ?? null,
    skipApproved: ledgerEntry.skipApproved ?? sidecarEntry.skipApproved ?? null,
    anchors: ledgerEntry.anchors ?? sidecarEntry.anchors ?? null,
    updatedAt: sideUp > ledUp ? sidecarEntry.updatedAt : (ledgerEntry.updatedAt ?? sidecarEntry.updatedAt),
  }
}

export function findCritiqueEntryInMap(map, relDoc) {
  if (!map || typeof map !== 'object' || !relDoc) return null
  if (map[relDoc]) return map[relDoc]
  const norm = posixPath(String(relDoc))
  if (map[norm]) return map[norm]
  const archM = /^docs\/archive\/(prd|specs|todo)\/([^/]+)$/.exec(norm)
  if (archM) {
    const activeRel = `docs/${archM[1]}/${archM[2]}`
    if (map[activeRel]) return map[activeRel]
  }
  const noIssue = norm.replace(/-issue\d+-/, '-')
  if (noIssue !== norm && map[noIssue]) return map[noIssue]
  return null
}

/** 同步读取规划内审条目（合并任务账本 `ledger.planCritique` 与共享 Git commondir sidecar 历史）。 */
export function readPlanCritiqueEntrySync({ repoRoot, mainRoot = repoRoot, gitDir = null, taskId = null, fmData = {}, relDoc }) {
  const { effMainRoot, effGitDir } = resolveEffectiveRoots(repoRoot, mainRoot, gitDir)
  const rawTaskId = taskId ?? fmData?.task_id ?? null
  const effTaskId = rawTaskId ? sanitizeTaskId(rawTaskId) : null
  const sidecar = sidecarCritiqueFile(repoRoot, effGitDir)
  const sidecarData = readJsonSafe(sidecar, null)
  const sidecarHit = findCritiqueEntryInMap(sidecarData, relDoc)
  let ledger = null
  let ledgerHit = null
  if (effMainRoot && effTaskId) {
    ledger = readTaskLedger(effMainRoot, effTaskId)
    ledgerHit = findCritiqueEntryInMap(ledger?.planCritique, relDoc)
  }
  const merged = mergeCritiqueEntries(sidecarHit, ledgerHit)
  return { entry: merged, ledger, gitDir: effGitDir, mainRoot: effMainRoot, taskId: effTaskId }
}

/** 按 task_id 从任务账本读取规划内审条目；无账本时回退到隔离 sidecar。 */
export async function readPlanCritiqueEntry(opts) {
  return readPlanCritiqueEntrySync(opts)
}

/** 同步持久化规划内审条目（供同步 `approveSpec` 写入 `--skip-critique-reason` 授权留痕）。 */
export function persistPlanCritiqueEntrySync({ repoRoot, mainRoot = repoRoot, gitDir = null, taskId = null, fmData = {}, relDoc, entry }) {
  const { effMainRoot, effGitDir } = resolveEffectiveRoots(repoRoot, mainRoot, gitDir)
  const rawTaskId = taskId ?? fmData?.task_id ?? null
  const effTaskId = rawTaskId ? sanitizeTaskId(rawTaskId) : null
  if (effMainRoot && effTaskId) {
    const existing = readTaskLedger(effMainRoot, effTaskId)
    if (existing) {
      writeTaskLedger(effMainRoot, {
        ...existing,
        planCritique: { ...(existing.planCritique ?? {}), [relDoc]: entry },
      })
      const readBack = readTaskLedger(effMainRoot, effTaskId)
      const verified = readBack?.planCritique?.[relDoc]
      if (!verified || verified.updatedAt !== entry.updatedAt) {
        throw makeStoreError('PLAN_CRITIQUE_PERSIST_FAILED', EXIT.ACTION, `账本 planCritique[${relDoc}] 回读校验失败`)
      }
      return { storedIn: 'ledger', entry: verified }
    }
  }
  const sidecar = sidecarCritiqueFile(repoRoot, effGitDir)
  return withFileLockSync(`${sidecar}.lock`, () => {
    const cur = readJsonSafe(sidecar, {}) ?? {}
    writeJsonAtomic(sidecar, { ...cur, [relDoc]: entry })
    const readBack = readJsonSafe(sidecar, null)
    if (!readBack?.[relDoc] || readBack[relDoc].updatedAt !== entry.updatedAt) {
      throw makeStoreError('PLAN_CRITIQUE_PERSIST_FAILED', EXIT.ACTION, `规划内审 sidecar (${relDoc}) 回读校验失败`)
    }
    return { storedIn: 'sidecar', entry: readBack[relDoc] }
  })
}

export async function persistPlanCritiqueEntry({ repoRoot, mainRoot = repoRoot, gitDir = null, taskId = null, fmData = {}, relDoc, entry }) {
  const { effMainRoot, effGitDir } = resolveEffectiveRoots(repoRoot, mainRoot, gitDir)
  const rawTaskId = taskId ?? fmData?.task_id ?? null
  const effTaskId = rawTaskId ? sanitizeTaskId(rawTaskId) : null
  if (effMainRoot && effTaskId) {
    const existing = readTaskLedger(effMainRoot, effTaskId)
    if (existing) {
      await updateTaskLedger(effMainRoot, effTaskId, (cur) => ({
        ...cur,
        planCritique: { ...(cur.planCritique ?? {}), [relDoc]: entry },
      }))
      const readBack = readTaskLedger(effMainRoot, effTaskId)
      const verified = readBack?.planCritique?.[relDoc]
      if (!verified || verified.updatedAt !== entry.updatedAt) {
        throw makeStoreError('PLAN_CRITIQUE_PERSIST_FAILED', EXIT.ACTION, `账本 planCritique[${relDoc}] 回读校验失败`)
      }
      return { storedIn: 'ledger', entry: verified }
    }
  }
  const sidecar = sidecarCritiqueFile(repoRoot, effGitDir)
  return withFileLock(`${sidecar}.lock`, async () => {
    const cur = readJsonSafe(sidecar, {}) ?? {}
    writeJsonAtomic(sidecar, { ...cur, [relDoc]: entry })
    const readBack = readJsonSafe(sidecar, null)
    if (!readBack?.[relDoc] || readBack[relDoc].updatedAt !== entry.updatedAt) {
      throw makeStoreError('PLAN_CRITIQUE_PERSIST_FAILED', EXIT.ACTION, `规划内审 sidecar (${relDoc}) 回读校验失败`)
    }
    return { storedIn: 'sidecar', entry: readBack[relDoc] }
  })
}
