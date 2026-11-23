/**
 * session-state.mjs —— 治理流水线 S1–S4 步骤账本与分流指纹防降档守卫。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/）。
 * 在 Git 仓库内优先存于 `<gitCommonDir>/project-forge-flow/session-state.json`（不污染工作区 `git status`），
 * 非 Git 目录回退 `<mainRoot>/.worktrees/.state/session-state.json`。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { posixPath, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'

function resolveCommonGitDir(mainRoot) {
  const gd = resolveGitDirFast(mainRoot)
  if (!gd || !existsSync(gd)) return null
  const cdFile = join(gd, 'commondir')
  if (existsSync(cdFile)) {
    const raw = (readTextSafe(cdFile) ?? '').trim()
    if (raw) return isAbsolute(raw) ? resolve(raw) : resolve(gd, raw)
  }
  return gd
}

export function resolveSessionStatePath(mainRoot) {
  const root = resolve(String(mainRoot || process.cwd()))
  const gitCommonDir = resolveCommonGitDir(root)
  if (gitCommonDir) return join(gitCommonDir, 'project-forge-flow', 'session-state.json')
  return join(root, '.worktrees', '.state', 'session-state.json')
}

export function readSessionState(mainRoot) {
  const primary = resolveSessionStatePath(mainRoot)
  const hit = readJsonSafe(primary, null)
  if (hit && typeof hit === 'object') return hit
  const fallback = join(resolve(String(mainRoot || process.cwd())), '.worktrees', '.state', 'session-state.json')
  if (fallback !== primary) {
    const fb = readJsonSafe(fallback, null)
    if (fb && typeof fb === 'object') return fb
  }
  return null
}

export function recordStepState(mainRoot, { step, ok = true, summary = '', meta = {} } = {}) {
  const stepKey = String(step ?? '').trim().toUpperCase()
  if (!stepKey) return null
  const statePath = resolveSessionStatePath(mainRoot)
  const prev = readJsonSafe(statePath, null) ?? { schemaVersion: 1, steps: {}, triage: null }
  const next = {
    schemaVersion: 1,
    steps: {
      ...(prev.steps ?? {}),
      [stepKey]: {
        ok: Boolean(ok),
        summary: String(summary ?? '').trim(),
        at: new Date().toISOString(),
        ...(meta && typeof meta === 'object' ? meta : {}),
      },
    },
    triage: prev.triage ?? null,
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(statePath, next)
  return next
}

export function recordStepStateSafe(mainRoot, payload) {
  try {
    return recordStepState(mainRoot, payload)
  } catch {
    return null
  }
}

export function computeTriageFingerprint({ summary = '', paths = [] } = {}) {
  const normSummary = String(summary ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const normPaths = [...new Set((Array.isArray(paths) ? paths : []).map((p) => posixPath(p).trim()).filter(Boolean))].sort()
  return createHash('sha256').update(`${normSummary}\n${normPaths.join('\n')}`, 'utf8').digest('hex').slice(0, 16)
}

export function recordTriageDecision(mainRoot, { caseType, summary = '', paths = [], doorType = null, planMode = null, taskId = null, slug = null } = {}) {
  const statePath = resolveSessionStatePath(mainRoot)
  const prev = readJsonSafe(statePath, null) ?? { schemaVersion: 1, steps: {}, triage: null, triageByTask: {} }
  const fingerprint = computeTriageFingerprint({ summary, paths })
  const entry = {
    caseType: Number(caseType),
    fingerprint,
    taskId: taskId ? String(taskId).trim() : null,
    slug: slug ? String(slug).trim() : null,
    summary: String(summary ?? '').trim().slice(0, 240),
    doorType: doorType ?? null,
    planMode: planMode ?? null,
    consumedByTaskId: null,
    terminal: false,
    at: new Date().toISOString(),
  }
  const mapKey = entry.taskId || entry.slug || `fp:${fingerprint}`
  const next = {
    schemaVersion: 1,
    steps: prev.steps ?? {},
    triage: entry,
    triageByTask: { ...(prev.triageByTask ?? {}), [mapKey]: entry },
    updatedAt: entry.at,
  }
  writeJsonAtomic(statePath, next)
  return next
}

/** 标记已建档的 triage 记录已被某个任务认领消费，防止后续无关新任务误撞降档门禁。 */
export function markTriageConsumed(mainRoot, { taskId = null, slug = null, terminal = false } = {}) {
  try {
    const statePath = resolveSessionStatePath(mainRoot)
    const prev = readJsonSafe(statePath, null)
    if (!prev || typeof prev !== 'object') return null
    const cleanTask = taskId ? String(taskId).trim() : null
    const cleanSlug = slug ? String(slug).trim() : null
    if (!cleanTask && !cleanSlug) return prev
    const byTask = { ...(prev.triageByTask ?? {}) }
    const touch = (rec) => {
      if (!rec || typeof rec !== 'object') return rec
      const rTask = rec.taskId ? String(rec.taskId).trim().toLowerCase() : ''
      const rSlug = rec.slug ? String(rec.slug).trim().toLowerCase() : ''
      const matchesSame = (cleanTask && rTask === cleanTask.toLowerCase()) || (cleanSlug && rSlug === cleanSlug.toLowerCase())
      if (matchesSame || (!rec.consumedByTaskId && !rTask && !rSlug)) {
        return {
          ...rec,
          consumedByTaskId: cleanTask || cleanSlug || rec.consumedByTaskId,
          ...(terminal ? { terminal: true } : {}),
        }
      }
      return rec
    }
    for (const [k, v] of Object.entries(byTask)) byTask[k] = touch(v)
    const next = {
      ...prev,
      triage: prev.triage ? touch(prev.triage) : null,
      triageByTask: byTask,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(statePath, next)
    return next
  } catch {
    return null
  }
}

export function checkTriageDowngrade({ previousCase, nextCase, reason = '' } = {}) {
  const prevNum = Number(previousCase)
  const nextNum = Number(nextCase)
  if (!Number.isInteger(prevNum) || !Number.isInteger(nextNum)) return { ok: true }
  if (nextNum < prevNum && !String(reason ?? '').trim()) {
    return {
      ok: false,
      code: 'BLOCKED_TRIAGE_DOWNGRADE',
      exitCode: EXIT.FACT,
      reason: `禁止静默将分流档位从 Case ${prevNum} 降档为 Case ${nextNum}；如确需降档请显式附 --reason "<降档依据>"。`,
    }
  }
  return { ok: true }
}

/** 按任务标识、消费归属与指纹隔离判别是否真正属于同一任务的降档，避免跨任务或已完任务误拦新任务。 */
export function findBlockingTriageDowngrade(sess, { taskId = null, slug = null, summary = '', paths = [], nextCase, reason = '' } = {}) {
  if (!sess) return { ok: true }
  const byTask = sess.triageByTask && typeof sess.triageByTask === 'object' ? sess.triageByTask : {}
  const cleanTask = taskId ? String(taskId).trim().toLowerCase() : ''
  const cleanSlug = slug ? String(slug).trim().toLowerCase() : ''
  const fp = summary ? computeTriageFingerprint({ summary, paths }) : null

  const candidates = []
  for (const rec of Object.values(byTask)) {
    if (rec && typeof rec === 'object' && !rec.terminal) candidates.push(rec)
  }
  if (sess.triage && !sess.triage.terminal && candidates.length === 0) candidates.push(sess.triage)

  for (const rec of candidates) {
    const recTask = rec.taskId ? String(rec.taskId).trim().toLowerCase() : ''
    const recSlug = rec.slug ? String(rec.slug).trim().toLowerCase() : ''
    const recConsumed = rec.consumedByTaskId ? String(rec.consumedByTaskId).trim().toLowerCase() : ''
    const idMatched = (cleanTask && (recTask === cleanTask || recConsumed === cleanTask))
      || (cleanSlug && (recSlug === cleanSlug || recConsumed === cleanSlug))
      || (cleanTask && recSlug && cleanTask === recSlug)
    const fpMatched = Boolean(fp && rec.fingerprint && fp === rec.fingerprint)
    const unconsumedFresh = !recConsumed && !recTask && !recSlug
    if (!idMatched && !fpMatched && !unconsumedFresh) continue
    const chk = checkTriageDowngrade({ previousCase: rec.caseType, nextCase, reason })
    if (!chk.ok) return chk
  }
  return { ok: true }
}
