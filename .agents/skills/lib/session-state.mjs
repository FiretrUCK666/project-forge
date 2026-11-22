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

export function recordTriageDecision(mainRoot, { caseType, summary = '', paths = [], doorType = null, planMode = null } = {}) {
  const statePath = resolveSessionStatePath(mainRoot)
  const prev = readJsonSafe(statePath, null) ?? { schemaVersion: 1, steps: {}, triage: null }
  const fingerprint = computeTriageFingerprint({ summary, paths })
  const next = {
    schemaVersion: 1,
    steps: prev.steps ?? {},
    triage: {
      caseType: Number(caseType),
      fingerprint,
      summary: String(summary ?? '').trim().slice(0, 240),
      doorType: doorType ?? null,
      planMode: planMode ?? null,
      at: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(statePath, next)
  return next
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
