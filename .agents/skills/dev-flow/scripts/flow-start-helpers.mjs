/**
 * flow-start-helpers.mjs —— `flow start` 的作者分离、槽位隔离、脏主仓检查与 planning 晋升辅助模块。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-inspect.mjs 以控制文件行数。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { extractDocBriefSeeds } from '../../lib/context-brief.mjs'
import { parseDocFrontmatter } from '../../lib/docs.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { gitRun, gitStatusPorcelainZ, readTextSafe, resolveDefaultBranch } from '../../lib/git.mjs'
import {
  enforceSlotBoundary,
  isValidActorName,
  resolveHostMode,
} from '../../lib/harness-context.mjs'
import { createExploredEvidence, recordMountedDepsInLedger } from '../../lib/ledger.mjs'
import { resolveIdentityLayers } from '../../lib/platform.mjs'
import { findBlockingTriageDowngrade, markTriageConsumed, readSessionState } from '../../lib/session-state.mjs'
import { validateStartProvenanceAndRole } from './flow-start-provenance.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

export function resolveStartIdentity({ isPlanning = false, state = {}, opts = {} } = {}) {
  if (isPlanning) {
    const startIdentity = resolveIdentityLayers({
      explicitAgent: opts.agent ?? opts.implementer,
    })
    return {
      startIdentity,
      implementerId: startIdentity.agent || null,
    }
  }
  const startIdentity = resolveIdentityLayers({
    ghLogin: state.github?.trackB?.login,
    ghTier: state.github?.trackB?.tier,
    gitName: state.gitIdentity?.name,
    explicitAgent: opts.agent ?? opts.implementer,
  })
  return {
    startIdentity,
    implementerId: startIdentity.agent || startIdentity.account || 'local-agent',
  }
}

export function checkStartTriageDowngrade(mainRoot, { taskId = null, slug = null, caseType, summary = '', reason = '' } = {}) {
  const sess = readSessionState(mainRoot)
  return findBlockingTriageDowngrade(sess, { taskId, slug, summary, nextCase: caseType, reason })
}

export { markTriageConsumed as markStartTriageConsumed }

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

export async function calibrateLedgerBaseBranch(mainRoot, ledger, resolvedDefault = null) {
  if (!ledger || typeof ledger !== 'object') return null
  const current = String(ledger.baseBranch ?? '').trim()
  if (current) {
    const hasLocal = (await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${current}`])).ok
    const hasOrigin = hasLocal || (await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${current}`])).ok
    if (hasLocal || hasOrigin) return current
  }
  const realDefault = resolvedDefault || await resolveDefaultBranch(mainRoot, { strict: true })
  if (realDefault) ledger.baseBranch = realDefault
  return ledger.baseBranch ?? null
}

/**
 * 若 `flow start` 绑定的 SPEC/Todo 已过审/就绪且包含真实仓内路径或复用模块，
 * 或 `session-state.json` 已记录有效探索，则自动继承写入 `ledger.explored` 凭据。
 */
export function inheritExploredCredentials({
  mainRoot,
  docRoot = mainRoot,
  ledger,
  specFile = ledger?.specFile,
  todoFile = ledger?.todoFile,
  prdFile = ledger?.prdFile,
  implementerId = null,
} = {}) {
  if (!ledger || ledger.planning || ledger.status === 'planning' || Number(ledger.caseType ?? 3) < 3 || ledger.explored?.at) {
    return ledger?.explored ?? null
  }
  const sess = readSessionState(mainRoot)
  if (sess?.explored?.at || sess?.steps?.EXPLORE?.ok) {
    const ev = createExploredEvidence({
      at: sess.explored?.at ?? sess.steps?.EXPLORE?.at ?? new Date().toISOString(),
      tier: sess.explored?.tier ?? 'session-state',
      symbolCount: Number(sess.explored?.symbolCount ?? 0),
      by: implementerId || ledger.implementerId || 'session-state',
      source: 'session-state',
    })
    ledger.explored = ev
    return ev
  }
  const docRels = [specFile, todoFile, prdFile].filter(Boolean)
  if (!specFile && !todoFile) return null
  const readPlan = (rel) => {
    for (const base of [docRoot, mainRoot].filter(Boolean)) {
      const abs = join(base, rel)
      if (existsSync(abs)) return readTextSafe(abs) ?? ''
    }
    return ''
  }
  let planReady = false
  if (specFile) {
    const raw = readPlan(specFile)
    const fm = raw ? parseDocFrontmatter(raw) : null
    const st = String(fm?.data?.status ?? '').trim().toLowerCase()
    const crit = String(fm?.data?.plan_critique ?? '').trim().toLowerCase()
    planReady = Boolean(
      fm?.data?.approved === true
      || ['approved', 'implementing', 'in_review', 'implemented'].includes(st)
      || crit.startsWith('passed')
      || crit.startsWith('skipped'),
    )
  } else if (todoFile) {
    const raw = readPlan(todoFile)
    const fm = raw ? parseDocFrontmatter(raw) : null
    const st = String(fm?.data?.status ?? '').trim().toLowerCase()
    planReady = (st === 'active' || st === 'done') && !/\b(?:TBD|FIXME)\b/.test(raw)
  }
  if (!planReady) return null
  const seeds = extractDocBriefSeeds([docRoot, mainRoot].filter(Boolean), docRels)
  const existingPaths = seeds.paths.filter((p) => existsSync(join(docRoot, p)) || existsSync(join(mainRoot, p)))
  if (existingPaths.length === 0) return null
  const ev = createExploredEvidence({
    at: new Date().toISOString(),
    tier: 'inherited-plan-audit',
    symbolCount: existingPaths.length,
    by: implementerId || ledger.implementerId || 'plan-audit',
    source: 'plan-audit',
  })
  ledger.explored = ev
  return ev
}

export async function promotePlanningToStarted({
  roots, existing, existingWorkRootPre, slug, taskId, opts, runStartPlanGate,
  role = null, providerId = null, baseBranch = null, baseSha = null,
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

  const hostMode = resolveHostMode(opts)
  const candidateImpl = opts.agent ?? opts.implementer
    ?? (existing.implementerId && existing.implementerId !== 'local-agent' ? existing.implementerId : null)
    ?? existing.claimedBy
    ?? existing.agent
  if (nextCase >= 2 && hostMode !== 'single-session' && !isValidActorName(candidateImpl)) {
    return {
      blocked: true,
      ...emitBlockedStart(opts, {
        code: 'BLOCKED_MISSING_ACTOR',
        exitCode: EXIT.USAGE,
        reason: `Case ${nextCase} 多代理模式下，从 planning 晋升至实施态必须显式传入 --agent/--implementer <实施代理名>（或存在已记录的独立实施者）；仅 --host-mode single-session 可豁免。`,
      }),
    }
  }
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

  if (role && (existing.role === 'local-only' || !existing.role)) existing.role = role
  if (providerId && (existing.providerId === 'none' || !existing.providerId)) existing.providerId = providerId
  if (baseBranch) existing.baseBranch = baseBranch
  await calibrateLedgerBaseBranch(roots.mainRoot, existing, baseBranch)
  if (baseSha && !existing.baseSha) existing.baseSha = baseSha
  existing.caseType = nextCase
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
  inheritExploredCredentials({
    mainRoot: roots.mainRoot,
    docRoot: gateRoot,
    ledger: existing,
    implementerId: existing.implementerId,
  })
  return { blocked: false }
}
