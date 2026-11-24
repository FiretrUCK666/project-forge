/**
 * critique-store.mjs —— 规划内审条目（ledger.planCritique / sidecar）同步与异步原子持久化原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 critique-rounds.mjs 与 doc-plan-ops.mjs 共用。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path, { resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { resolveGitDirFast } from './git-fast.mjs'
import {
  posixPath, readJsonSafe, readTextSafe, sha256Text, withFileLockSync, writeJsonAtomic,
} from './git.mjs'
import { readTaskLedger, sanitizeTaskId, updateTaskLedger, writeTaskLedger } from './ledger.mjs'

function makeStoreError(code, exitCode, message) {
  return Object.assign(new Error(message), { code, exitCode })
}

export function resolveEffectiveRoots(repoRoot, mainRoot, gitDir) {
  const rawGitDir = gitDir && existsSync(resolve(gitDir))
    ? resolve(gitDir)
    : (resolveGitDirFast(repoRoot) ?? (mainRoot && mainRoot !== repoRoot ? resolveGitDirFast(mainRoot) : null))
  const effGitDir = rawGitDir && existsSync(rawGitDir) ? rawGitDir : null
  let effMainRoot = mainRoot && mainRoot !== repoRoot ? resolve(mainRoot) : resolve(repoRoot)
  if ((!mainRoot || mainRoot === repoRoot) && effGitDir) {
    const cdFile = path.join(effGitDir, 'commondir')
    const common = existsSync(cdFile) ? resolve(effGitDir, (readTextSafe(cdFile) ?? '').trim()) : effGitDir
    if (path.basename(common) === '.git') effMainRoot = path.dirname(common)
  }
  return { effMainRoot, effGitDir }
}

export function sidecarCritiqueFile(repoRoot, effectiveGitDir) {
  if (effectiveGitDir) return path.join(effectiveGitDir, 'project-forge-flow', 'plan-critique-state.json')
  return path.join(os.tmpdir(), 'pf-plan-critique', `${sha256Text(resolve(repoRoot)).slice(0, 16)}.json`)
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

/** 同步读取规划内审条目（优先任务账本 `ledger.planCritique`，无账本时回退 sidecar）。 */
export function readPlanCritiqueEntrySync({ repoRoot, mainRoot = repoRoot, gitDir = null, taskId = null, fmData = {}, relDoc }) {
  const { effMainRoot, effGitDir } = resolveEffectiveRoots(repoRoot, mainRoot, gitDir)
  const rawTaskId = taskId ?? fmData?.task_id ?? null
  const effTaskId = rawTaskId ? sanitizeTaskId(rawTaskId) : null
  if (effMainRoot && effTaskId) {
    const ledger = readTaskLedger(effMainRoot, effTaskId)
    const hit = findCritiqueEntryInMap(ledger?.planCritique, relDoc)
    if (hit) {
      return { entry: hit, ledger, gitDir: effGitDir, mainRoot: effMainRoot, taskId: effTaskId }
    }
    if (ledger) return { entry: null, ledger, gitDir: effGitDir, mainRoot: effMainRoot, taskId: effTaskId }
  }
  const sidecar = sidecarCritiqueFile(repoRoot, effGitDir)
  const data = readJsonSafe(sidecar, null)
  return { entry: findCritiqueEntryInMap(data, relDoc), ledger: null, gitDir: effGitDir, mainRoot: effMainRoot, taskId: effTaskId }
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
  const cur = (await readJsonSafe(sidecar, {})) ?? {}
  await writeJsonAtomic(sidecar, { ...cur, [relDoc]: entry })
  const readBack = await readJsonSafe(sidecar, null)
  if (!readBack?.[relDoc] || readBack[relDoc].updatedAt !== entry.updatedAt) {
    throw makeStoreError('PLAN_CRITIQUE_PERSIST_FAILED', EXIT.ACTION, `规划内审 sidecar (${relDoc}) 回读校验失败`)
  }
  return { storedIn: 'sidecar', entry: readBack[relDoc] }
}
