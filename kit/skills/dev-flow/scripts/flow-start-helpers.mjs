/**
 * flow-start-helpers.mjs —— `flow start` 的作者分离、槽位隔离、脏主仓检查与 planning 晋升辅助模块。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-inspect.mjs 以控制文件行数。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT } from '../../lib/exit-codes.mjs'
import { gitStatusPorcelainZ } from '../../lib/git.mjs'
import {
  enforceSlotBoundary,
  isValidActorName,
  resolveHostMode,
} from '../../lib/harness-context.mjs'
import { recordMountedDepsInLedger } from '../../lib/ledger.mjs'
import { validateStartProvenanceAndRole } from './flow-start-provenance.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

export function checkStartAuthorSeparation(rootDir, docRels = [], implementerId, opts = {}) {
  const res = validateStartProvenanceAndRole({
    mainRoot: opts.mainRoot ?? rootDir,
    docRoot: rootDir,
    docRels,
    taskId: opts.taskId ?? null,
    ledger: opts.ledger ?? null,
    caseType: opts.caseType ?? 3,
    explicitImplementer: implementerId,
    opts,
  })
  if (res.blocked) return { blocked: true, ...res }
  return { blocked: false }
}

export async function checkStartMainCleanAndSlot(mainRoot, { caseType, commits }) {
  if (Number(caseType) < 2 || Number(commits) <= 0) {
    return enforceSlotBoundary({ mainRoot, implRoot: mainRoot, caseType, isDirtyMain: false, commits })
  }
  const st = await gitStatusPorcelainZ(mainRoot)
  const dirtyEntries = st.ok
    ? (st.entries ?? []).filter((e) => {
        if (!e.file || e.file.startsWith('.worktrees/')) return false
        if (e.xy === '??' && /^docs\/(?:prd|specs|todo)\/[^/]+\.md$/.test(e.file)) return false
        return true
      })
    : []
  const isDirtyMain = dirtyEntries.length > 0
  return enforceSlotBoundary({
    mainRoot,
    implRoot: join(mainRoot, '.worktrees', 'impl-slot-check'),
    caseType,
    isDirtyMain,
    commits,
  })
}

export function applyLocalAutoClaim(ledger, { role, isPlanning, implementerId, opts = {} }) {
  if (!ledger || role !== 'local-only' || isPlanning || ledger.claimedAt) return
  const hostMode = resolveHostMode(opts)
  const explicit = opts.agent ?? opts.implementer ?? (hostMode === 'single-session' ? implementerId : null)
  if (!isValidActorName(explicit)) return
  const actor = String(explicit).trim()
  ledger.claimedAt = new Date().toISOString()
  ledger.claimedBy = actor
  if (!ledger.agent) ledger.agent = actor
  if (!ledger.implementerId || ledger.implementerId === 'local-agent') ledger.implementerId = actor
}

export function emitBlockedStart(opts, payload) {
  const msg = `${payload.code}: ${payload.reason ?? payload.message}`
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, ...payload }, null, 2)}\n`)
  else process.stdout.write(`${msg}\n`)
  process.stderr.write(`${msg}\n`)
  return { exitCode: payload.exitCode ?? EXIT.FACT }
}

export async function promotePlanningToStarted({
  roots, existing, existingWorkRootPre, slug, taskId, opts, runStartPlanGate,
}) {
  const gateRoot = existsSync(existingWorkRootPre) ? existingWorkRootPre : roots.mainRoot
  const nextCase = opts.case !== undefined ? Number(opts.case) : existing.caseType
  const gateRes = runStartPlanGate(gateRoot, {
    caseType: nextCase,
    slug: existing.slug ?? slug,
    taskId,
    issue: existing.linkedIssues?.[0] ?? null,
    docs: { spec: existing.specFile, todo: existing.todoFile, prd: existing.prdFile },
    opts,
    planCritique: existing.planCritique ?? null,
  })
  if (gateRes.blocked) return { blocked: true, exitCode: gateRes.exitCode }

  const candidateImpl = opts.agent ?? opts.implementer
    ?? (existing.implementerId && existing.implementerId !== 'local-agent' ? existing.implementerId : null)
    ?? existing.claimedBy
    ?? existing.agent
  const authRes = checkStartAuthorSeparation(gateRoot, [existing.specFile, existing.todoFile, existing.prdFile], candidateImpl, {
    ...opts, mainRoot: roots.mainRoot, taskId, ledger: existing, caseType: nextCase,
  })
  if (authRes.blocked) {
    return { blocked: true, ...emitBlockedStart(opts, authRes) }
  }
  if (isValidActorName(candidateImpl)) {
    existing.implementerId = String(candidateImpl).trim()
    existing.agent = String(candidateImpl).trim()
  }

  existing.status = 'started'
  existing.planning = false
  if (existing.worktreePath && !existing.depsMode && existsSync(existingWorkRootPre)) {
    const depMount = mountSharedDeps(roots.mainRoot, existingWorkRootPre)
    existing.depsMode = depMount.mode
    recordMountedDepsInLedger(existing, existing.worktreePath, depMount)
  }
  applyLocalAutoClaim(existing, {
    role: existing.role,
    isPlanning: false,
    implementerId: existing.implementerId,
    opts,
  })
  return { blocked: false }
}
