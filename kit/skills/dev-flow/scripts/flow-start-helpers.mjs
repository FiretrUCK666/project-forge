/**
 * flow-start-helpers.mjs —— `flow start` 的作者分离、槽位隔离、脏主仓检查与 planning 晋升辅助模块。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-inspect.mjs 以控制文件行数。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { extractDocBriefSeeds } from '../../lib/context-brief.mjs'
import { criteriaFingerprint, extractCriteria } from '../../lib/criteria-lock.mjs'
import { parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { validateOverrideReason } from '../../lib/evidence-substance.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { gitRun, gitStatusPorcelainZ, readTextSafe, resolveDefaultBranch } from '../../lib/git.mjs'
import {
  enforceSlotBoundary,
  isValidActorName,
  resolveHostMode,
} from '../../lib/harness-context.mjs'
import { createExploredEvidence, recordMountedDepsInLedger } from '../../lib/ledger.mjs'
import { evaluatePlanExitGate, formatPlanExitGate, PLAN_BOOTSTRAP_FLAG } from '../../lib/plan-exit-gate.mjs'
import { indexPlanDocs } from '../../lib/plan-index.mjs'
import { probeForWrite, resolveIdentityLayers, resolveRemoteTarget } from '../../lib/platform.mjs'
import { readDecisions } from '../../lib/profile.mjs'
import { findBlockingTriageDowngrade, markTriageConsumed, readSessionState } from '../../lib/session-state.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
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

export function validateStartIssueFlags(opts = {}, linkedIssues = []) {
  if (!opts['no-issue']) return { blocked: false, reason: null }
  const hasIssueArg = Array.isArray(linkedIssues) && linkedIssues.length > 0
  const hasConflict = hasIssueArg
    || Boolean(opts['create-issue'])
    || opts.body !== undefined
    || opts['body-file'] !== undefined
  if (hasConflict) {
    return {
      blocked: true,
      code: 'BLOCKED_CONFLICTING_ISSUE_FLAGS',
      exitCode: EXIT.USAGE,
      reason: '--no-issue 与 --issue / --issues / --create-issue / --body / --body-file 互斥，请仅保留一种工单绑定方式。',
    }
  }
  const chk = validateOverrideReason(opts.reason, { subject: '豁免建单理由', minChars: 4 })
  if (!chk.ok) {
    return {
      blocked: true,
      code: chk.code,
      exitCode: EXIT.USAGE,
      reason: chk.reason,
    }
  }
  return { blocked: false, reason: chk.cleaned }
}

export function collectDocIssueNumbers(roots, docRels = [], docRoot = null) {
  const out = []
  const seen = new Set()
  const addNum = (val) => {
    const n = Number(val)
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  const searchBases = [docRoot, roots?.mainRoot].filter(Boolean)
  for (const rel of docRels) {
    if (!rel) continue
    addNum(parseDocFilename(rel)?.issue)
    for (const base of searchBases) {
      const abs = join(base, rel)
      if (!existsSync(abs)) continue
      const raw = readTextSafe(abs)
      if (raw) addNum(parseDocFrontmatter(raw)?.data?.issue)
    }
  }
  return out
}

/**
 * 判定 `flow start` 是否命中八类自动豁免边界。
 * 显式传入 `--create-issue` 时直接放行进质量建单，不走隐式豁免。
 */
export function evaluateIssueBindingExemption({
  mainRoot,
  caseType = 3,
  isPlanning = false,
  role = 'local-only',
  externalPr = null,
  ledger = null,
  opts = {},
  implementerId = null,
} = {}) {
  if (opts['create-issue']) return { blocked: false, exempt: false }
  const now = new Date().toISOString()
  if (Number(caseType) === 1) {
    return { blocked: false, exempt: true, exemptKind: 'case-1', reason: 'Case 1 无需强制绑定工单', at: now }
  }
  if (Boolean(isPlanning)) {
    return { blocked: false, exempt: true, exemptKind: 'planning', reason: '--planning 隔离规划阶段暂不绑定工单', at: now }
  }
  if (Boolean(opts.sandbox)) {
    return { blocked: false, exempt: true, exemptKind: 'sandbox', reason: '沙箱探索阶段暂不强制建单', at: now }
  }
  if (opts['allow-plan-bootstrap'] === true) {
    return { blocked: false, exempt: true, exemptKind: 'allow-plan-bootstrap', reason: '携带 --allow-plan-bootstrap 规划引导豁免建单', at: now }
  }
  if (Boolean(externalPr)) {
    return { blocked: false, exempt: true, exemptKind: 'external-pr', reason: '外部贡献 PR 隔离审查无需建单', at: now }
  }
  if (role === 'contributor-fork') {
    return { blocked: false, exempt: true, exemptKind: 'contributor-fork', reason: 'contributor-fork 不向上游自动建单', at: now }
  }
  if (role === 'clone-readonly') {
    return { blocked: false, exempt: true, exemptKind: 'clone-readonly', reason: 'clone-readonly 只读克隆不自动建单', at: now }
  }
  const agentsText = mainRoot ? (readTextSafe(join(mainRoot, 'AGENTS.md')) ?? '') : ''
  if (agentsText && readDecisions(agentsText).has('no-auto-issue')) {
    return { blocked: false, exempt: true, exemptKind: 'no-auto-issue-decision', reason: 'AGENTS.md「取舍」声明了 no-auto-issue', at: now }
  }
  if (opts['no-issue']) {
    const flagChk = validateStartIssueFlags(opts, [])
    if (flagChk.blocked) return flagChk
    return {
      blocked: false,
      exempt: true,
      exemptKind: 'no-issue-flag',
      reason: flagChk.reason,
      by: implementerId || opts.agent || opts.implementer || null,
      at: now,
    }
  }
  const prev = ledger?.issueBinding
  if (prev?.mode === 'exempt' && prev?.exemptKind === 'no-issue-flag' && opts.body === undefined && opts['body-file'] === undefined) {
    return {
      blocked: false,
      exempt: true,
      exemptKind: 'no-issue-flag',
      reason: prev.reason ?? '沿用先前 --no-issue 豁免记录',
      by: prev.by ?? null,
      at: prev.at ?? now,
    }
  }
  return { blocked: false, exempt: false }
}

/**
 * `flow start` 确定性 Issue 绑定状态机：
 *   1. 先复用不重复（参数 -> ledger -> 关联 SPEC/Todo/PRD）；
 *   2. 再判八类豁免边界（含 `--no-issue --reason`）；
 *   3. 最后对 Case 3/4 真实设计文档或显式 `--create-issue`/`--body`/`--body-file` 走质量门禁建单，
 *      否则对无文档且无正文的 Case 2 阻断为 `BLOCKED_MISSING_ISSUE_BINDING`。
 */
export async function resolveOrBindStartIssue({
  roots,
  docRoot = null,
  state = {},
  role = 'local-only',
  providerId = 'none',
  prelimTaskId = null,
  caseType = 3,
  isPlanning = false,
  externalPr = null,
  linkedIssues = [],
  docs = {},
  ledger = null,
  opts = {},
  implementerId = null,
  commandName = 'start',
} = {}) {
  const flagChk = validateStartIssueFlags(opts, linkedIssues)
  if (flagChk.blocked) return flagChk

  const activeDocRoot = docRoot ?? roots.mainRoot
  const argIssues = [...new Set((linkedIssues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  const ledgerIssues = [...new Set([
    Number(ledger?.issue),
    ...(Array.isArray(ledger?.linkedIssues) ? ledger.linkedIssues : []).map(Number),
  ].filter((n) => Number.isInteger(n) && n > 0))]
  const docIssues = collectDocIssueNumbers(roots, [docs.spec, docs.todo, docs.prd], activeDocRoot)

  const merged = [...new Set([...argIssues, ...ledgerIssues, ...docIssues])]
  if (merged.length > 0) {
    for (const n of merged) {
      if (!linkedIssues.includes(n)) linkedIssues.push(n)
    }
    const source = argIssues.length > 0 ? 'args' : (ledgerIssues.length > 0 ? 'ledger' : 'plan-doc')
    return {
      blocked: false,
      linkedIssues,
      createdIssue: null,
      issueBinding: { mode: 'reused', source, issues: merged, at: new Date().toISOString() },
    }
  }

  const ex = evaluateIssueBindingExemption({
    mainRoot: roots.mainRoot,
    caseType,
    isPlanning,
    role,
    externalPr,
    ledger,
    opts,
    implementerId,
  })
  if (ex.blocked) return ex
  if (ex.exempt) {
    return {
      blocked: false,
      linkedIssues,
      createdIssue: null,
      issueBinding: {
        mode: 'exempt',
        exemptKind: ex.exemptKind,
        reason: ex.reason,
        ...(ex.by ? { by: ex.by } : {}),
        at: ex.at,
      },
    }
  }

  const boundPlanSet = new Set([docs.spec, docs.todo].filter(Boolean).map((p) => String(p).replace(/^\.\//, '')))
  const indexed = boundPlanSet.size > 0
    ? indexPlanDocs({
        repoRoot: activeDocRoot,
        mainRoot: roots.mainRoot,
        includeArchive: false,
        includeWorktrees: Boolean(prelimTaskId || ledger?.taskId),
        taskId: prelimTaskId ?? ledger?.taskId ?? null,
        ledger,
      })
    : []
  const verifiedPlanDocs = indexed.filter((d) => !d.inert && (d.kind === 'spec' || d.kind === 'todo') && boundPlanSet.has(d.rel))
  const hasExplicitBody = opts.body !== undefined || opts['body-file'] !== undefined
  const wantCreateFlag = Boolean(opts['create-issue'])

  if (!wantCreateFlag && !hasExplicitBody && verifiedPlanDocs.length === 0) {
    const cmdName = commandName === 'promote' ? 'promote' : 'start'
    const stageWord = cmdName === 'promote' ? '晋升' : '开工'
    return {
      blocked: true,
      code: 'BLOCKED_MISSING_ISSUE_BINDING',
      exitCode: EXIT.FACT,
      reason: [
        `Case ${caseType} 无关联规划文档时，${stageWord}必须绑定已有工单或提供合规工单正文。`,
        '可选修复方式：',
        `  1) 绑定已有工单：flow.mjs ${cmdName} ... --issue <N>`,
        `  2) 附带合规正文建单：flow.mjs ${cmdName} ... --body-file <path>（或 --body "<符合 5 项结构底线的正文>"）`,
        '  3) 先独立建单再开工：flow.mjs issue create --title "<标题>" --case 2 --body-file <path>',
        `  4) 确需豁免建单：flow.mjs ${cmdName} ... --no-issue --reason "<可核对理由>"（或在 AGENTS.md「## 取舍」声明 no-auto-issue）`,
      ].join('\n'),
    }
  }

  const { createIssueForStart } = await import('./flow-issues.mjs')
  const cr = await createIssueForStart({
    roots,
    state,
    role,
    providerId,
    prelimTaskId: prelimTaskId ?? ledger?.taskId ?? 'task',
    caseType,
    opts: {
      ...opts,
      workTreeRoot: activeDocRoot,
      spec: docs.spec ?? opts.spec,
      todo: docs.todo ?? opts.todo,
      prd: docs.prd ?? opts.prd,
    },
  })
  if (cr.exitCode !== 0) {
    return { blocked: true, exitCode: cr.exitCode, code: cr.code ?? null, alreadyEmitted: true }
  }
  const createdIssue = cr.createdIssue
  if (!linkedIssues.includes(createdIssue.number)) linkedIssues.push(createdIssue.number)
  const source = verifiedPlanDocs.length > 0 ? 'plan-doc' : (hasExplicitBody ? 'explicit-body' : 'create-issue-flag')
  return {
    blocked: false,
    linkedIssues,
    createdIssue,
    issueBinding: {
      mode: 'created',
      source,
      issues: [createdIssue.number],
      title: createdIssue.title ?? null,
      url: createdIssue.url ?? null,
      at: new Date().toISOString(),
    },
  }
}

export function runStartPlanGate(gateRoot, { caseType, slug, taskId, issue, docs, opts, planCritique = null }) {
  const planGate = evaluatePlanExitGate(gateRoot, {
    caseType, slug, taskId, issue, docs,
    allowBootstrap: Boolean(opts[PLAN_BOOTSTRAP_FLAG]),
    reusePrRef: Boolean(opts['pr-ref']),
    planCritique,
  })
  const lines = formatPlanExitGate(planGate)
  if (planGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(planGate, null, 2)}\n`)
    else for (const line of lines) process.stderr.write(`${line}\n`)
    return { blocked: true, exitCode: planGate.exitCode ?? EXIT.FACT }
  }
  if (!opts.json) for (const line of lines) process.stderr.write(`${line}\n`)
  return { blocked: false }
}

export async function ackInboundExternalPr(roots, state, prNumber, opts = {}) {
  const target = resolveRemoteTarget(state.remoteUrls ?? {}, { role: 'contributor-fork', declaredRepo: state.declaredRepo, cwd: roots.mainRoot })
  const targetRepo = target.repoSlug ?? state.declaredRepo ?? null
  let client = opts._ghClient ?? opts._ghProbe?.client ?? null
  if (!client && !opts._backend && targetRepo && target.capabilities?.api === true) {
    const probe = await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} }).catch(() => null)
    client = probe?.client ?? null
  }
  const backend = opts._backend ?? createTaskBackend({
    role: 'maintainer', providerId: state.identity?.providerId ?? target.providerId ?? 'none', targetRepo, client, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })
  if (!backend?.capabilities?.api || (!client && !opts._backend)) {
    return { synced: false, labelSynced: false, skipped: true, reason: 'offline-or-no-client' }
  }
  const body = `<!-- pf:inbound-external-pr pr=${prNumber} -->\n已受理外部贡献 PR #${prNumber}，正在隔离审查工作树执行不可信安全扫描与规范评审。`
  try {
    const commentRes = await backend.postComment({ repo: targetRepo, number: prNumber, isPr: true, body, deduplicate: true })
    const labelRes = await backend.addLabels({ repo: targetRepo, number: prNumber, labels: ['external-contribution'], isPr: true })
    return { synced: commentRes?.ok !== false, labelSynced: labelRes?.ok !== false, error: null }
  } catch (err) {
    return { synced: false, labelSynced: false, error: err?.message ?? String(err) }
  }
}

/**
 * 若 `flow start` 绑定的 SPEC/Todo/PRD 在建账前已获批准（`approved: true` 或 `status: approved`），
 * 补齐账本的 `criteriaFingerprint` / `criteriaFrozenFrom` / `criteriaFrozenAt`，
 * 使后续 `submit` / `review-pack record` 仍可强制校验标准防篡改。
 */
export function backfillCriteriaFingerprint(docRoot, ledger) {
  if (!docRoot || !ledger || ledger.criteriaFingerprint) return null
  const candidates = [ledger.specFile, ledger.archivedSpecFile, ledger.todoFile, ledger.archivedTodoFile, ledger.prdFile, ledger.archivedPrdFile].filter(Boolean)
  for (const rel of candidates) {
    const abs = join(docRoot, rel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs) ?? ''
    const fm = parseDocFrontmatter(text)
    const status = String(fm.data?.status ?? '').toLowerCase()
    const isApproved = fm.data?.approved === true || status === 'approved' || status === 'implemented'
    if (!isApproved) continue
    const criteria = extractCriteria(text)
    if (criteria.length === 0) continue
    ledger.criteriaFingerprint = criteriaFingerprint(criteria)
    ledger.criteriaFrozenFrom = rel
    ledger.criteriaFrozenAt = ledger.criteriaFrozenAt ?? new Date().toISOString()
    return ledger.criteriaFingerprint
  }
  return null
}

export async function promotePlanningToStarted({
  roots, existing, existingWorkRootPre, slug, taskId, opts, runStartPlanGate,
  state = {}, linkedIssues = [],
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

  const bindRes = await resolveOrBindStartIssue({
    roots,
    docRoot: gateRoot,
    state,
    role: existing.role || role || 'local-only',
    providerId: existing.providerId || providerId || 'none',
    prelimTaskId: taskId,
    caseType: nextCase,
    isPlanning: false,
    externalPr: null,
    linkedIssues,
    docs: { spec: existing.specFile, todo: existing.todoFile, prd: existing.prdFile },
    ledger: existing,
    opts,
    implementerId: existing.implementerId,
  })
  if (bindRes.blocked) {
    if (!bindRes.alreadyEmitted) emitBlockedStart(opts, bindRes)
    return { blocked: true, exitCode: bindRes.exitCode }
  }
  existing.issueBinding = bindRes.issueBinding
  if (bindRes.linkedIssues.length > 0) {
    existing.linkedIssues = [...new Set([...(existing.linkedIssues ?? []), ...bindRes.linkedIssues])]
  }

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
  backfillCriteriaFingerprint(gateRoot, existing)
  return { blocked: false, createdIssue: bindRes.createdIssue ?? null }
}

export function buildStartReuseNextSteps(existing, taskId) {
  if (existing.status === 'planning' || existing.planning === true) {
    return [
      { skill: 'dev-plan', text: `1. 在 ${existing.worktreePath ?? '.'} 内编写/完善 SPEC 与 Todo 并完成 critique-pass 与 approve` },
      { skill: 'dev-flow', text: `2. 过审后执行 node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskId} 转入实施阶段` },
    ]
  }
  if (existing.isolation === 'review-pr') {
    return [{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${existing.prNumber ?? ''} --untrusted-scan` }]
  }
  if (!existing.claimedAt) {
    return [
      { skill: 'dev-flow', text: `1. 先执行 flow.mjs claim 认领任务：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <id>` },
      { skill: 'dev-flow', text: `2. 推进任务状态：node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${taskId}` },
    ]
  }
  return [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${taskId}` }]
}
