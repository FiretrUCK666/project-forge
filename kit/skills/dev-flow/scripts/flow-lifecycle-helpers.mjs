/**
 * flow-lifecycle-helpers.mjs —— finalize/rework 辅助函数与返工命令实现，供 flow-lifecycle.mjs 复用。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { evaluateMasterPrdClosureState } from '../../lib/doc-substantive.mjs'
import { evaluateCoupledSync, isSharedMasterPrd, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { escalateToBackend } from '../../lib/escalation.mjs'
import { mergeArtifactRecords } from '../../lib/empirical-artifacts.mjs'
import {
  detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitRunBuffer, gitStatusPorcelainZ,
  inspectBranchMergeState, posixPath, readTextSafe, resolveDefaultBranch, syncDetachedWorktree, writeAtomic,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { recordMountedDepsInLedger, rememberPreviousImplementer, resolveTaskContext, revokeUnconsumedReviewTokens, updateTaskLedger } from '../../lib/ledger.mjs'
import { evaluateMutability } from '../../lib/mutability.mjs'
import { getLocalIssue } from '../../lib/local-issues.mjs'
import { evaluatePlanExitGate, PLAN_EXIT_BLOCK_CODE } from '../../lib/plan-exit-gate.mjs'
import { parseMilestoneNumber } from '../../lib/platform.mjs'
import {
  buildE2eDiagnosticPacket,
  buildE2eObservation,
  determineWorkflowPolicy,
  evaluateNextState,
  hasRepoCiWorkflow,
  hasValidE2eObservationOnHead,
  validateE2eEvidenceText,
  readVerificationEvidence,
  resolveEffectiveBaseSha,
  scoreExecutionResult,
  validateVerificationEvidence,
  writeVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText, isUiVisualFile, matchGlob } from '../../lib/static-gates.mjs'
import * as workflowPolicy from '../../lib/workflow-policy.mjs'
import { getChangedFiles } from './flow-inspect.mjs'
import { mountSharedDeps, unmountSharedDeps } from './worktree-deps.mjs'

export function computeFlowCoupledSync(implRoot, mainRoot, changedFiles) {
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : mainRoot
  const agentsText = readTextSafe(join(agentsRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(changedFiles, rules, agentsRoot) : []
}

export async function collectFinalizeChangedFiles(implRoot, ledger, statusEntries, gitCommonDir = null, headSha = null, preDiffEntries = undefined) {
  const effectiveBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir })
  const baseDiffEntries = Array.isArray(preDiffEntries)
    ? preDiffEntries
    : (effectiveBase && headSha && headSha === effectiveBase ? [] : undefined)
  const merged = new Set(await getChangedFiles(implRoot, effectiveBase, { statusEntries, diffEntries: baseDiffEntries }))
  return [...merged].sort()
}

export function findUncheckedLines(text) {
  const out = []
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence && /^- \[ \]/.test(line) && !/(?:<!--\s*waive:|\[waive:|豁免|跳过原因)/i.test(line)) out.push(line.trim())
  }
  return out
}

export function findStrictDocBySlug(root, dirRel, ledger) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  try {
    for (const n of readdirSync(abs).filter((x) => x.endsWith('.md')).sort()) {
      const fn = parseDocFilename(n)
      if (fn && fn.slug === ledger.slug) return `${dirRel}/${n}`
      const fm = parseDocFrontmatter(readTextSafe(join(abs, n)) ?? '')
      if (fm.data?.task_id === ledger.taskId) return `${dirRel}/${n}`
    }
  } catch { /* ignore */ }
  return null
}

export async function emitFlowSignal(roots, payload) {
  await appendGovernSignal({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, isGit: roots.isGit, ...payload })
}

export async function handleRework(opts, roots) {
  const { taskId, ledger } = await resolveTaskContext(roots, opts)
  const mut = evaluateMutability({ ledger, taskId })
  if (!mut.mutable) {
    if (mut.terminal || !opts.reopen) {
      const reason = `BLOCKED_REWORK_REQUIRES_REOPEN: 任务 ${taskId} ${mut.reason}，${mut.terminal ? '终态不可返工。' : '请传 --reopen --reason "<原因>" 解锁并撤销未消费令牌。'}`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_REWORK_REQUIRES_REOPEN', exitCode: EXIT.FACT, taskId, mutability: mut.mutability, terminal: mut.terminal, reason, safeExits: mut.safeExits }, null, 2)}\n`)
      process.stderr.write(`${reason}\n`)
      return { exitCode: EXIT.FACT }
    }
    if (!String(opts.reason ?? '').trim()) {
      const reason = 'MISSING_REOPEN_REASON: flow rework --reopen 必须附带非空 --reason "<解锁原因>"'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'MISSING_REOPEN_REASON', exitCode: EXIT.USAGE, taskId, reason }, null, 2)}\n`)
      process.stderr.write(`${reason}\n`)
      return { exitCode: EXIT.USAGE }
    }
  }
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const profile = parseAgentsProfile(implRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)

  // 豁免由 finalize 成对自动归档移入 docs/archive/ 的关联文档，避免与 do-not-edit: docs/archive/ 自相冲突
  const ownArchived = new Set([ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean))
  const forbiddenTouched = changed.filter((f) => !ownArchived.has(f) && profile.doNotEdit.some((pat) => matchGlob(f, pat)))
  const rebutsInput = Array.isArray(opts.rebut) ? opts.rebut : (opts.rebut ? [opts.rebut] : [])
  const addedRebuts = []

  for (const raw of rebutsInput) {
    const idx = raw.indexOf(':')
    const item = { findingId: idx > 0 ? raw.slice(0, idx).trim() : 'general', reason: idx > 0 ? raw.slice(idx + 1).trim() : raw.trim(), recordedAt: new Date().toISOString() }
    addedRebuts.push(item)
    ledger.rebuts = [...(ledger.rebuts ?? []), item]
    if ((ledger.rounds ?? []).length > 0) ledger.rounds[ledger.rounds.length - 1].rebuts = [...(ledger.rounds[ledger.rounds.length - 1].rebuts ?? []), item]
  }

  const revokedTokensCount = opts.reopen ? revokeUnconsumedReviewTokens(ledger, opts.reason) : 0
  ledger.status = 'rework'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  await emitFlowSignal(roots, { category: 'hygiene', module: 'workflow', pattern: 'flow.rework', severity: 'medium', source: 'flow-rework', file: changed[0] ?? '', taskId, message: `rework entered (reopen=${Boolean(opts.reopen)}, revokedTokens=${revokedTokensCount}, rebuts=${addedRebuts.length}, forbidden=${forbiddenTouched.length})`, meta: { forbiddenTouched, rebutCount: addedRebuts.length, reopened: Boolean(opts.reopen), revokedTokensCount } })
  const submitAgent = ledger.claimedBy ?? ledger.implementerId ?? '<id>'
  const reworkNextSteps = [
    { skill: 'dev-flow', text: `1. node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
    { skill: 'dev-flow', text: `2. node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --agent ${submitAgent}` },
  ]
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, status: ledger.status, mutability: 'OPEN', reopened: Boolean(opts.reopen), revokedTokensCount, branch: ledger.branch, prNumber: ledger.prNumber, forbiddenTouched, addedRebuts }, reworkNextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write(`进入返工模式（task=${taskId}，原分支=${ledger.branch}，原 PR=${ledger.prNumber ?? '待创建'}${opts.reopen ? `，已解锁并撤销 ${revokedTokensCount} 枚未消费令牌` : ''}）：\n`)
    if (forbiddenTouched.length > 0) process.stdout.write(`- 警告：以下变更命中 do-not-edit 列表：${forbiddenTouched.join(', ')}\n`)
    if (addedRebuts.length > 0) process.stdout.write(`- 已记录 ${addedRebuts.length} 条有据反驳。\n`)
    printNextStep(reworkNextSteps, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}

export async function handleForkFinalize({ implRoot, roots, ledger, taskId, stZ, currentHead, opts }) {
  const baseRef = ledger.baseSha || ledger.baseBranch || 'HEAD'
  const baseTree = await gitRun(implRoot, ['ls-tree', '-r', '--name-only', baseRef, '--', 'docs/'])
  const baseDocs = baseTree.ok ? baseTree.stdout.split('\n').filter(Boolean) : []
  const upstreamUsesDocs = baseDocs.some((p) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/)/.test(p))
  if (upstreamUsesDocs) return null

  const committedDiff = ledger.baseSha ? await gitRun(implRoot, ['diff', '--name-only', `${ledger.baseSha}..HEAD`]) : { ok: false, stdout: '' }
  const committedDocs = (committedDiff.stdout || '').split('\n').filter((f) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/|archive\/)/.test(f.trim()))
  if (committedDocs.length > 0) {
    process.stderr.write(`BLOCKED_FORK_PRIVATE_DOCS: 上游仓未接入 docs/ 体系，私有规划文件不应混入 Fork PR 提交：${committedDocs.join(', ')}\n`)
    return { exitCode: EXIT.FACT }
  }
  const sharedForkPrd = Boolean(ledger.prdFile && isSharedMasterPrd(implRoot, ledger.prdFile, ledger.specFile))
  for (const relDoc of [ledger.todoFile, ledger.specFile, sharedForkPrd ? null : ledger.prdFile].filter(Boolean)) {
    const docPath = join(implRoot, relDoc)
    if (!existsSync(docPath)) continue
    const unchecked = findUncheckedLines(readTextSafe(docPath) ?? '')
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_DOC: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
      return { exitCode: EXIT.ACTION }
    }
  }
  const privateKeepDir = join(roots.mainRoot, '.worktrees', '.state', 'private-docs', taskId)
  const relocated = []
  for (const [kind, relDoc] of [['todo', ledger.todoFile], ['spec', ledger.specFile], ['prd', sharedForkPrd ? null : ledger.prdFile]]) {
    if (!relDoc) continue
    const src = join(implRoot, relDoc)
    if (!existsSync(src)) continue
    await gitRun(implRoot, ['reset', '--', relDoc])
    mkdirSync(privateKeepDir, { recursive: true })
    const dst = join(privateKeepDir, basename(relDoc))
    try { renameSync(src, dst) } catch { copyFileSync(src, dst) }
    relocated.push(relDoc)
    const privRel = posixPath(`.worktrees/.state/private-docs/${taskId}/${basename(relDoc)}`)
    if (kind === 'todo') ledger.privateTodoFile = privRel
    if (kind === 'spec') ledger.privateSpecFile = privRel
    if (kind === 'prd') ledger.privatePrdFile = privRel
  }
  ledger.privateDocsDir = `.worktrees/.state/private-docs/${taskId}`
  const changedFork = await collectFinalizeChangedFiles(implRoot, ledger, stZ.entries)
  const coupledSyncWarnings = computeFlowCoupledSync(implRoot, roots.mainRoot, changedFork)
  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  const res = { taskId, role: ledger.role, upstreamUsesDocs: false, privateDocsIsolated: true, relocatedPrivateDocs: relocated, finalizedHead: currentHead, coupledSyncWarnings }
  const forkFinalizeNext = [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }]
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(res, forkFinalizeNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write('Fork finalize 完成（上游未接入 docs/，私有规划已安全隔离到 .worktrees/.state/private-docs/）。\n')
    printNextStep(forkFinalizeNext, { repoRoot: roots.mainRoot })
  }
  if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
    process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则（共 ${coupledSyncWarnings.length} 组）。\n`)
    return { exitCode: EXIT.ACTION }
  }
  return { exitCode: EXIT.OK }
}

export function evaluateFlowMasterPrdGate(implRoot, {
  prdRel, specRel, todoRel, includeMasterPrd = false, ledger = null, isVerify = false, taskId = '',
} = {}) {
  if (!prdRel || ledger?.planBootstrap === true) return { blocked: false, checkPrdInFinalize: false, closure: null }
  const closure = evaluateMasterPrdClosureState(implRoot, prdRel, {
    currentSpecRel: specRel, currentTodoRel: todoRel, includeMasterPrd,
  })
  const sharedMasterPrd = isSharedMasterPrd(implRoot, prdRel, specRel)
  if (!closure.isMasterPrd) {
    return { blocked: false, closure, sharedMasterPrd, checkPrdInFinalize: true }
  }
  if (closure.state === 'blocked-unclosed') {
    if (includeMasterPrd && !isVerify) {
      return { blocked: false, closure, sharedMasterPrd, checkPrdInFinalize: true }
    }
    const sliceHasUnchecked = (rel) => Boolean(rel && existsSync(join(implRoot, rel)) && findUncheckedLines(readTextSafe(join(implRoot, rel)) ?? '').length > 0)
    const shouldBlockVerify = !isVerify || ledger?.finalized === true || (!sliceHasUnchecked(todoRel) && !sliceHasUnchecked(specRel))
    if (shouldBlockVerify) {
      return {
        blocked: true,
        exitCode: EXIT.FACT,
        code: 'BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED',
        closure,
        sharedMasterPrd,
        checkPrdInFinalize: false,
        message: `BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED: 总控 PRD (${prdRel}) 已无其他活跃切片且条款已全覆盖，但仍有未勾选条目（${closure.uncheckedCriteria.slice(0, 3).join('；')}）；最后一片须收口勾选总控 PRD 后才可归档/提审。`,
        nextStep: `请核对并勾选 ${prdRel} 的剩余验收条款，提交后重跑 ${isVerify ? 'verify' : 'finalize'}（task=${taskId || ledger?.taskId || ''}）。`,
      }
    }
  }
  return {
    blocked: false,
    closure,
    sharedMasterPrd,
    checkPrdInFinalize: Boolean(includeMasterPrd || closure.state === 'ready-auto-close'),
  }
}

export async function applySubmitPostActions({ backend, targetRepo, prNumber, linkedIssues = [], ledger, roots, isRework = false }) {
  if (backend && typeof backend.syncStateLabel === 'function') {
    if (prNumber) await Promise.resolve(backend.syncStateLabel({ repo: targetRepo, number: prNumber, state: 'in-review' })).catch(() => null)
    for (const iss of linkedIssues) {
      await Promise.resolve(backend.syncStateLabel({ repo: targetRepo, number: iss, state: 'in-review' })).catch(() => null)
    }
  }
  let ms = ledger?.milestone ?? null
  if (!ms && !isRework && prNumber && linkedIssues.length > 0) {
    for (const iss of linkedIssues) {
      if (typeof backend?.getIssue === 'function') {
        const res = await Promise.resolve(backend.getIssue(targetRepo, iss)).catch(() => null)
        const cand = res?.milestone?.number ?? res?.milestone ?? null
        if (cand) { ms = cand; break }
      }
      if (!ms) {
        const loc = getLocalIssue({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, number: iss })
        const cand = loc?.ok ? (loc.milestone?.number ?? loc.milestone?.title ?? loc.milestone ?? null) : null
        if (cand) { ms = cand; break }
      }
    }
  }
  const msId = parseMilestoneNumber(ms?.number ?? ms) ?? (ms?.title ?? (typeof ms === 'string' ? ms : null))
  if (msId && !isRework && prNumber && backend && typeof backend.assignMilestone === 'function') {
    return Promise.resolve(backend.assignMilestone({ repo: targetRepo, number: prNumber, milestone: msId })).catch(() => null)
  }
  return null
}

export function cmdContainsSubcommand(fullCmd, subCmd) {
  const target = String(subCmd ?? '').replace(/\s+/g, ' ').trim()
  const full = String(fullCmd ?? '').replace(/\s+/g, ' ').trim()
  if (!target || !full) return false
  if (full === target) return true
  return full.split(/\s*(?:&&|;|\n)\s*/).map((s) => s.trim()).includes(target)
}

const SIGNAL_BLAME_NOISE_RE = /(?:^|\/)\.pf-manifest\.json$|^\.worktrees\//

export function pickSignalBlameFile(changedFiles = [], fallback = '') {
  const real = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((f) => posixPath(f))
    .filter((f) => f && !SIGNAL_BLAME_NOISE_RE.test(f))
  return real[0] ?? fallback
}

export async function handleVerifyE2eFailure({
  roots, taskId, ledger, mode, cmd, runRes, currentHead, changedFiles = [], opts = {},
}) {
  const blameFile = pickSignalBlameFile(changedFiles, '')
  const filteredChanged = blameFile ? [blameFile, ...changedFiles.filter((f) => f !== blameFile && !SIGNAL_BLAME_NOISE_RE.test(posixPath(f)))] : []
  const diagnostic = buildE2eDiagnosticPacket({
    cmd,
    exitCode: runRes?.code ?? 1,
    stdout: runRes?.stdout ?? '',
    stderr: runRes?.stderr ?? '',
    headSha: currentHead,
    taskId,
    mode,
    changedFiles: filteredChanged,
  })
  await emitFlowSignal(roots, {
    category: 'e2e',
    module: blameFile ? undefined : 'e2e',
    pattern: 'e2e.runtime-fail',
    severity: 'high',
    source: 'flow-verify',
    file: blameFile,
    taskId,
    message: diagnostic.Evidence.slice(0, 2).join(' | '),
    meta: { exitCode: runRes?.code ?? 1, headSha: currentHead ?? null, mode },
  })
  const body = [
    '## Evidence',
    ...diagnostic.Evidence.map((l) => `- ${l}`),
    '',
    '## Unknowns',
    ...diagnostic.Unknowns.map((l) => `- ${l}`),
    '',
    '## NextSteps',
    ...diagnostic.NextSteps.map((l) => `- ${l}`),
  ].join('\n')
  let escalation = null
  try {
    escalation = await escalateToBackend({
      repoRoot: roots.mainRoot,
      item: {
        source: 'flow-verify',
        category: 'e2e',
        severity: 'high',
        caseType: ledger?.caseType ?? 3,
        e2eBlocking: true,
        title: `E2E verification failed (${taskId ?? mode})`,
        summary: diagnostic.Evidence.slice(0, 2).join(' | '),
        body,
        rootCause: diagnostic.Unknowns.join('；'),
        nextStep: diagnostic.NextSteps[0] ?? 'Fix runtime failure and re-run smoke verify with --e2e-evidence',
        files: changedFiles.slice(0, 10),
        taskId,
        labels: ['e2e-fail'],
      },
      _ghProbe: opts._ghProbe ?? null,
      _ghClient: opts._ghClient ?? null,
    })
  } catch (err) {
    escalation = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { diagnostic, escalation }
}

/**
 * verify 前置预检的 Fail-Soft 调用口。
 *
 * `workflow-policy.mjs` 的实证校验入口由另一条并行切片负责扩展（`validateVerifyPrecheck`）。
 * 本文件按名字探测它，**不按版本探测**：
 *
 * - 还没实现 → 直接放行。没这道预检时，后面的 `writeVerificationEvidence` 仍照旧工作，
 *   这里硬失败等于为「一个还没写的函数」把整条 verify 拦死；
 * - 已经实现 → 完全按它返回的 `{ ok, code, exitCode }` 办。判据只有一个来源，不在这里重写一份。
 *
 * 用命名空间导入而不是具名导入，是因为具名导入不存在的导出会让整个模块在链接期就抛错——
 * 那样 Fail-Soft 无从谈起，两侧谁先合入都会把对方打断。
 *
 * ## 参数名必须与对方读的一字不差
 *
 * 它读的是 `repoRoot` / `gitCommonDir` / `headSha`。名字对不上时它内部的实证路径与根全是
 * `null`，于是「校验通过、什么都没落账」——门禁看着在工作，附件实证链条其实是断的。
 *
 * ## 传 `record: false`，落账只写一次
 *
 * 默认它自己会往 `evidence.json` 写一份。紧随其后的 `writeVerificationEvidence` 写的是
 * 整份新对象，会把刚写进去的 `artifacts` / `visual` 整个抹掉。与其让两处抢着写再合并，
 * 不如让它只校验、把结果交回来，由本文件一次性写全——写一次就没有覆盖窗口。
 */
function runVerifyPrecheck(payload) {
  const fn = workflowPolicy?.validateVerifyPrecheck
  if (typeof fn !== 'function') return null
  try {
    const res = fn({ ...payload, record: false })
    if (!res) return null
    if (res.ok === false) return { ...res, blocked: true, exitCode: Number(res.exitCode) || 3 }
    return { ...res, blocked: false }
  } catch (err) {
    process.stderr.write(`前置换算异常，按 Fail-Soft 放行：${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
}

export function recordVerifyEvidenceForFlow({
  roots, taskId, ledger, profileKey, currentHead, dirty, policy, modeName, targetVal,
  cmdStr, customCmd, exitCode, explicitNoneSkipped, docStaticRes,
  executed = !explicitNoneSkipped, errorOnly = false, e2eObservationText = '',
  durationMs = null, smokeDurationMs = null,
  smokeCmd = null, smokeExitCode = null, smokeExecuted = false, smokeErrorOnly = false,
  artifacts = [], visualCheckedRaw = false, visualBlockedReason = '',
}) {
  const precheck = runVerifyPrecheck({
    repoRoot: roots.workTreeRoot,
    gitCommonDir: roots.gitDir,
    headSha: currentHead,
    policy, taskId, dirty, mode: modeName, exitCode,
    artifacts, visualCheckedRaw, visualBlockedReason,
    observationSummary: String(e2eObservationText ?? '').trim(),
  })
  if (precheck?.blocked) {
    const msg = `${precheck.code ?? 'BLOCKED_VERIFY_PRECHECK'}: ${precheck.reason ?? precheck.message ?? '实证前置校验未通过'}`
    process.stderr.write(`${msg}\n`)
    return { overallExit: precheck.exitCode ?? 3, smokeVerifiedOnHead: false, e2eObservation: null, shallowE2eEvidence: null, precheck }
  }
  const prev = readVerificationEvidence(roots.gitDir, taskId)
  const sameClean = Boolean(prev && prev.headSha === currentHead && !dirty && !prev.dirty)
  const gates = sameClean ? { ...(prev.gates ?? {}) } : {}
  const skipped = new Set(sameClean && Array.isArray(prev.skipped) ? prev.skipped : [])
  const now = new Date().toISOString()
  const mainScore = explicitNoneSkipped
    ? { executed: false, succeeded: true, errorOnly: false }
    : scoreExecutionResult({ executed, exitCode, errorOnly })
  gates[modeName] = {
    headSha: currentHead, dirty, mode: modeName, target: targetVal,
    partial: modeName === 'quick' && Boolean(targetVal),
    exitCode, cmd: cmdStr, customCmd,
    ...(Number.isFinite(Number(durationMs)) ? { durationMs: Math.max(0, Math.round(Number(durationMs))) } : {}),
    executed: mainScore.executed,
    succeeded: mainScore.succeeded,
    errorOnly: mainScore.errorOnly,
    status: explicitNoneSkipped ? 'skipped-explicit-none' : (mainScore.succeeded ? 'passed' : 'failed'),
    recordedAt: now,
  }
  if (smokeCmd !== null && smokeExitCode !== null && modeName !== 'smoke') {
    const sScore = scoreExecutionResult({ executed: smokeExecuted, exitCode: smokeExitCode, errorOnly: smokeErrorOnly })
    gates.smoke = {
      headSha: currentHead, dirty, mode: 'smoke', target: null, partial: false,
      exitCode: smokeExitCode, cmd: smokeCmd, customCmd: false,
      ...(Number.isFinite(Number(smokeDurationMs)) ? { durationMs: Math.max(0, Math.round(Number(smokeDurationMs))) } : {}),
      executed: sScore.executed, succeeded: sScore.succeeded, errorOnly: sScore.errorOnly,
      status: sScore.succeeded ? 'passed' : 'failed',
      recordedAt: now,
    }
  }
  if (explicitNoneSkipped) {
    skipped.add('skipped-explicit-none')
    skipped.add(`${profileKey}:skipped-explicit-none`)
  }
  if (docStaticRes) {
    gates.docStatic = {
      headSha: currentHead, dirty, ok: docStaticRes.ok,
      exitCode: docStaticRes.ok ? 0 : 1, checkedFiles: docStaticRes.checkedFiles,
      errors: docStaticRes.errors, recordedAt: now,
    }
  }
  const smokeGate = gates.smoke
  const smokeVerifiedOnHead = Boolean(
    smokeGate
    && smokeGate.headSha === currentHead
    && !smokeGate.dirty
    && smokeGate.exitCode === 0
    && smokeGate.executed !== false
    && smokeGate.succeeded !== false
    && smokeGate.errorOnly !== true,
  )
  const docFailed = Boolean(docStaticRes && !docStaticRes.ok)
  const overallExit = docFailed ? 3 : (errorOnly ? 1 : exitCode)
  let e2eObservation = sameClean && hasValidE2eObservationOnHead(prev, currentHead) ? prev.e2eObservation : null
  let shallowE2eEvidence = null
  if (String(e2eObservationText ?? '').trim()) {
    const evCheck = validateE2eEvidenceText(e2eObservationText)
    if (!evCheck.ok) {
      shallowE2eEvidence = evCheck
      e2eObservation = {
        summary: String(e2eObservationText).trim(),
        headSha: currentHead,
        source: 'flow-verify',
        cmd: smokeCmd ?? cmdStr,
        executed: !explicitNoneSkipped && !errorOnly,
        succeeded: false,
        errorOnly: false,
        shallowRejected: true,
        reason: evCheck.reason,
        observedAt: new Date().toISOString(),
      }
      process.stderr.write(`${evCheck.code}: ${evCheck.reason}\n`)
    } else {
      e2eObservation = buildE2eObservation({
        summary: e2eObservationText,
        headSha: currentHead,
        source: 'flow-verify',
        cmd: smokeCmd ?? cmdStr,
        executed: !explicitNoneSkipped && !errorOnly,
        succeeded: overallExit === 0 && (!smokeGate || smokeVerifiedOnHead),
        errorOnly,
      })
    }
  }
  const finalOverallExit = shallowE2eEvidence ? 3 : overallExit
  // 预检算出的附件记录与界面核验结论，并进这一次写入。
  // 先前的做法是预检自己写一份、这里再整份覆盖，附件落账被后写的抹掉；
  // 现在预检只算不写，由这里一次写全，没有覆盖窗口，且按 sameClean 过滤跨 HEAD 陈旧附件。
  const precheckRecords = Array.isArray(precheck?.records) ? precheck.records : []
  const precheckVisual = precheck?.visual && precheck.visual.required
    ? { ...precheck.visual, headSha: precheck.visual.headSha ?? currentHead ?? null }
    : null
  const baseArtifacts = sameClean && Array.isArray(prev?.artifacts) ? prev.artifacts : []
  const carriedArtifacts = mergeArtifactRecords(baseArtifacts, precheckRecords)
  const carriedVisual = precheckVisual ?? (sameClean ? (prev?.visual ?? null) : null)
  writeVerificationEvidence(roots.gitDir, taskId, {
    taskId, baseSha: ledger.baseSha, headSha: currentHead, dirty,
    riskTier: policy.riskTier, mode: modeName, target: targetVal, exitCode: finalOverallExit,
    executed: !explicitNoneSkipped,
    succeeded: finalOverallExit === 0 && !errorOnly,
    errorOnly: Boolean(errorOnly),
    smokeVerifiedOnHead,
    e2eObservation,
    ...(shallowE2eEvidence ? { shallowE2eEvidence } : {}),
    ...(carriedArtifacts.length > 0 ? { artifacts: carriedArtifacts } : {}),
    ...(carriedVisual ? { visual: carriedVisual } : {}),
    gates, skipped: [...skipped],
  })
  return { overallExit: finalOverallExit, smokeVerifiedOnHead, e2eObservation, shallowE2eEvidence, precheck }
}

export function validatePlanningReadyForFinalize({ implRoot, ledger, taskId, specRel, todoRel, prdRel }) {
  if (ledger?.planning !== true && ledger?.status !== 'planning') {
    return { ok: true, blocked: false, shouldPromotePlanning: false }
  }
  if (Number(ledger?.caseType) >= 4 && !specRel) {
    return {
      ok: false,
      blocked: true,
      code: PLAN_EXIT_BLOCK_CODE,
      exitCode: EXIT.FACT,
      message: `${PLAN_EXIT_BLOCK_CODE}: Case 4 任务 ${taskId} 处于 planning 态且尚未绑定 SPEC，禁止 finalize；请先生成 SPEC、过 Critique 并 approve。`,
    }
  }
  const planGate = evaluatePlanExitGate(implRoot, {
    caseType: ledger?.caseType,
    slug: ledger?.slug,
    taskId,
    issue: ledger?.linkedIssues?.[0] ?? null,
    docs: { spec: specRel, todo: todoRel, prd: prdRel },
    allowBootstrap: Boolean(ledger?.planBootstrap),
    planCritique: ledger?.planCritique ?? null,
  })
  if (planGate.blocked) return planGate
  return { ok: true, blocked: false, shouldPromotePlanning: true }
}

export function promotePlanningInLedgerOnFinalize(ledger, opts = {}) {
  if (!ledger || typeof ledger !== 'object') return
  ledger.planning = false
  const actor = String(opts.agent ?? '').trim()
  if (actor && !/(?:^|[-_.])(?:coordinator|orchestrator|dispatcher|reviewer|critic)(?:$|[-_.])/i.test(actor)) {
    ledger.previousImplementers = rememberPreviousImplementer(ledger, actor)
    ledger.agent = actor
    ledger.implementerId = actor
    if (!ledger.claimedBy) ledger.claimedBy = actor
  }
}

export function ensureSpecImplNoteReady(implRoot, specRel, { currentHead, taskId, note }) {
  if (!specRel || !existsSync(join(implRoot, specRel))) return { ok: true }
  const specAbs = join(implRoot, specRel)
  let specText = readTextSafe(specAbs) ?? ''
  if (!/^##\s+实现说明\s*$/m.test(specText)) specText = `${specText.trimEnd()}\n\n## 实现说明\n\n`
  const secStart = specText.search(/^##\s+实现说明\s*$/m)
  const afterSec = specText.slice(secStart)
  const nextH2 = afterSec.slice(1).search(/\n##\s+/)
  const secBody = (nextH2 > 0 ? afterSec.slice(0, nextH2 + 1) : afterSec).replace(/^##\s+实现说明\s*\n?/, '')
  if (/<!--\s*project-forge:\s*fill|\b(?:TBD|FIXME)\b/i.test(secBody) || /\bTODO\b/.test(secBody)) {
    return { ok: false, message: `BLOCKED_SPEC_IMPL_NOTE_EMPTY: ${specRel} 的「实现说明」仍含未填占位，请补齐真实说明后再 finalize。\n` }
  }
  if (!secBody.replace(/<!--[\s\S]*?-->/g, '').trim()) {
    const autoSummary = [`- 实现提交基线: ${currentHead ?? 'uncommitted'}`, `- 关联任务: ${taskId}`, note ? `- 说明: ${note}` : null].filter(Boolean).join('\n')
    specText = specText.replace(/(^##\s+实现说明\s*\n(?:<!--[\s\S]*?-->\s*\n?)?)/m, `$1\n${autoSummary}\n`)
  }
  writeAtomic(specAbs, specText)
  return { ok: true }
}

export async function syncReviewSlotForSubmit(roots, ledger, taskId, currentHead, { resetDirty = false } = {}) {
  if (ledger.tier !== 2 || !currentHead || !ledger.reviewWorktreePath) return null
  const reviewAbs = resolve(roots.mainRoot, ledger.reviewWorktreePath)
  const mountedForReview = ledger.mountedDepsByWorktree?.[ledger.reviewWorktreePath] ?? ledger.mountedDeps ?? []
  if (existsSync(reviewAbs) && !unmountSharedDeps(roots.mainRoot, reviewAbs, { mode: 'deps', mountedPaths: mountedForReview })?.ok) {
    throw new Error(`审查槽解绑共享依赖失败：${ledger.reviewWorktreePath}`)
  }
  const reviewSlotSync = await syncDetachedWorktree(roots.mainRoot, reviewAbs, currentHead, { resetDirty })
  const revDeps = mountSharedDeps(roots.mainRoot, reviewAbs)
  recordMountedDepsInLedger(ledger, ledger.reviewWorktreePath, revDeps)
  ledger.reviewWorktreeHead = currentHead
  reviewSlotSync.depsMode = revDeps.mode
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  return reviewSlotSync
}

export function emitVerifyOutcomeOutput({
  opts, roots, taskId, mode, rawTarget, cmd, targetTip, allOk, finalExit, ledger, policy,
  evRec, e2eFailureReport, docStaticRes, visualFilesChanged, empiricalVisualCheckRequired, runRes, currentHead,
}) {
  if (docStaticRes && !docStaticRes.ok) {
    process.stderr.write(`BLOCKED_STATIC_DOC_CHECK_FAILED: 无 CI 低风险静态必检未通过：${docStaticRes.errors.map((e) => e.message).slice(0, 3).join('；')}\n`)
  }
  if (e2eFailureReport?.diagnostic && !opts.json) {
    process.stderr.write(`E2E_RUNTIME_FAILED:\nEvidence:\n  - ${e2eFailureReport.diagnostic.Evidence.join('\n  - ')}\nUnknowns:\n  - ${e2eFailureReport.diagnostic.Unknowns.join('\n  - ')}\nNextSteps:\n  - ${e2eFailureReport.diagnostic.NextSteps.join('\n  - ')}\n`)
  }
  let verifyNextSteps = []
  if (allOk) {
    const submitAgent = ledger.claimedBy ?? ledger.implementerId ?? '<id>'
    verifyNextSteps = [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --agent ${submitAgent}` }]
    if (policy.smokeRequired && !evRec.e2eObservation) {
      verifyNextSteps.unshift(`检测到运行时改动（smokeRequired=true）：请核验实际运行输出/状态并补充 --e2e-evidence "<观察结论>"：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId} --mode smoke --e2e-evidence "<运行观察>"`)
    } else if (empiricalVisualCheckRequired && ledger.visualVerifiedHead !== currentHead) {
      verifyNextSteps.unshift(`检测到 UI/视觉改动（${visualFilesChanged.slice(0, 5).join(', ')}）：请核验实际渲染、交互与浅深色截图后补 --visual-checked。`)
    }
  } else {
    verifyNextSteps = e2eFailureReport?.diagnostic?.NextSteps?.length
      ? e2eFailureReport.diagnostic.NextSteps
      : [`验证未通过（exit=${finalExit}），请修复后重新运行 verify。`]
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({
      taskId, mode, target: rawTarget, cmd, ...(targetTip ? { targetTip } : {}),
      ok: allOk, exitCode: finalExit, verifiedHead: ledger.verifiedHead, riskTier: policy.riskTier,
      smokeVerifiedOnHead: evRec.smokeVerifiedOnHead, e2eObservation: evRec.e2eObservation,
      ...(e2eFailureReport ? { diagnostic: e2eFailureReport.diagnostic, escalatedIssue: e2eFailureReport.escalation } : {}),
      docStatic: docStaticRes, visualFilesChanged, empiricalVisualCheckRequired,
      visualVerifiedHead: ledger.visualVerifiedHead, visualCheckEvidence: ledger.visualCheckEvidence,
      stdout: runRes.stdout, stderr: runRes.stderr,
    }, verifyNextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    return
  }
  if (runRes.stdout) process.stdout.write(`${runRes.stdout}\n`)
  if (runRes.stderr) process.stdout.write(`${runRes.stderr}\n`)
  if (targetTip) process.stdout.write(`${targetTip}\n`)
  process.stdout.write(`verify (${mode}${rawTarget ? ` target=${rawTarget}` : ''}): cmd="${cmd}" exit=${finalExit} HEAD=${currentHead ?? 'unborn'} risk=${policy.riskTier}\n`)
  printNextStep(verifyNextSteps, { repoRoot: roots.mainRoot })
}

async function collectSnapshotChangedFiles(cwd, baseRef, statusEntries = [], diffEntries = null) {
  const set = new Set()
  if (Array.isArray(diffEntries)) {
    for (const e of diffEntries) if (e?.file) set.add(e.file)
  } else if (baseRef) {
    if (readHeadFast(resolveGitDirFast(cwd))?.oid !== baseRef) {
      const diff = await gitDiffNameStatusZ(cwd, [`${baseRef}..HEAD`])
      if (diff?.ok) for (const e of diff.entries) if (e.file) set.add(e.file)
    }
  } else {
    const tree = await gitRunBuffer(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    if (tree?.ok) for (const f of tree.stdout.toString('utf8').split('\0')) if (f) set.add(posixPath(f))
  }
  for (const e of Array.isArray(statusEntries) ? statusEntries : []) if (e?.file) set.add(e.file)
  return [...set].sort()
}

/** 单源任务运行时快照采集：供 `flow-next`、`flow-cleanup`、`flow-merge`、`flow-lifecycle` 共用。 */
export async function collectTaskRuntimeSnapshot({
  mainRoot, gitDir = null, ledger, activeTasks = [], allLedgers = activeTasks,
  pendingCleanupTasks = [], hasDevReview = undefined, profile: preProfile = null,
  includeMainDirty = false, includeMergeState = false, evaluateNext = true,
  multiTaskFiles = null, repoRoot = mainRoot, gateFindingsOverride = null,
} = {}) {
  const implRel = ledger?.worktreePath || (ledger?.role === 'inbound-external-pr' ? ledger?.reviewWorktreePath : null)
  const implRoot = implRel ? resolve(mainRoot, implRel) : mainRoot
  const exists = existsSync(implRoot)
  const profile = preProfile ?? parseAgentsProfile(mainRoot)
  const effectiveHasDevReview = hasDevReview !== undefined ? hasDevReview : hasSkillSupport(mainRoot, 'dev-review')
  const effectiveGitDir = gitDir ?? resolveGitDirFast(mainRoot)
  const fastHeadOid = exists ? (readHeadFast(resolveGitDirFast(implRoot), effectiveGitDir)?.oid ?? null) : null
  const effectiveBaseSha = exists ? await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: effectiveGitDir }) : (ledger?.baseSha ?? null)
  const [stZ, headRes, diffRawRes] = exists
    ? await Promise.all([
        gitStatusPorcelainZ(implRoot),
        fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
        !effectiveBaseSha
          ? Promise.resolve(null)
          : (fastHeadOid && fastHeadOid === effectiveBaseSha ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${effectiveBaseSha}..HEAD`)),
      ])
    : [{ ok: true, entries: [] }, { ok: false, stdout: '' }, null]
  const headSha = headRes.ok ? headRes.stdout.trim() : null
  const sharedEntries = diffRawRes?.ok ? diffRawRes.entries : undefined
  const [op, changedFiles, gateHits] = exists
    ? await Promise.all([
        detectInProgressGitOp(implRoot, { statusEntries: stZ.entries }),
        collectSnapshotChangedFiles(implRoot, effectiveBaseSha, stZ.entries, sharedEntries),
        Array.isArray(gateFindingsOverride) ? Promise.resolve(gateFindingsOverride) : detectGateWeakening(implRoot, effectiveBaseSha, ledger?.baseBranch, { headSha, nameStatusEntries: sharedEntries }),
      ])
    : [{ inProgress: false, op: null }, [], []]
  const ownArchived = [ledger?.archivedTodoFile, ledger?.archivedSpecFile, ledger?.archivedPrdFile].filter(Boolean)
  const policyRoot = exists ? implRoot : mainRoot
  const policy = determineWorkflowPolicy({
    changedFiles, ownArchived, caseType: ledger?.caseType, highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateHits, hasRemote: ledger?.role !== 'local-only', hasCiWorkflow: hasRepoCiWorkflow(policyRoot),
    visualFilesChanged: changedFiles.filter((f) => isUiVisualFile(f, { repoRoot: policyRoot })), profile, hasDevReview: effectiveHasDevReview, repoRoot: policyRoot,
  })
  const evidence = readVerificationEvidence(effectiveGitDir, ledger?.taskId)
  const evidenceValidation = validateVerificationEvidence({ policy, evidence, headSha, profile })
  let nonDocChangesAfterFinalize = false
  if (ledger?.finalized && ledger?.finalizedHead && headSha && ledger.finalizedHead !== headSha && exists) {
    const postFin = await gitDiffNameStatusZ(implRoot, [`${ledger.finalizedHead}..${headSha}`])
    nonDocChangesAfterFinalize = postFin.entries.some((e) => e.file && !/^docs\//.test(e.file))
  }
  let mainDirtyCount = 0
  if (includeMainDirty && ledger?.worktreePath && mainRoot !== implRoot) {
    const mainStatus = await gitStatusPorcelainZ(mainRoot)
    mainDirtyCount = mainStatus?.ok ? mainStatus.entries.length : 0
  }
  let commitsAheadOfBase = 0
  if (exists) {
    const countBase = effectiveBaseSha || ledger?.baseBranch || ledger?.baseSha
    if (countBase) {
      const countRes = await gitRun(implRoot, ['rev-list', '--count', `${countBase}..HEAD`])
      if (countRes.ok) commitsAheadOfBase = Number(countRes.stdout.trim()) || 0
    }
  }
  let mergeState = null
  if (includeMergeState && ledger?.branch) {
    const targetDefault = ledger?.baseBranch || await resolveDefaultBranch(mainRoot, { strict: true })
    if (targetDefault) {
      mergeState = await inspectBranchMergeState(mainRoot, { branch: ledger.branch, headSha: headSha ?? undefined, defaultBranch: targetDefault, gitDir: effectiveGitDir })
    }
  }
  const taskRuntime = {
    opInProgress: Boolean(op.inProgress), opName: op.op ?? null, headSha, dirty: stZ.entries.length,
    mainDirtyCount, policy, evidenceValidation, nonDocChangesAfterFinalize, profile, commitsAheadOfBase, hasDevReview: effectiveHasDevReview,
  }
  const evaluated = evaluateNext
    ? evaluateNextState({ activeTasks, allLedgers, pendingCleanupTasks, selectedTask: ledger, taskRuntime, multiTaskFiles, repoRoot })
    : null
  return {
    implRoot, exists, headSha, dirty: stZ.entries.length, statusEntries: stZ.entries, diffEntries: sharedEntries,
    diffText: diffRawRes?.ok && typeof diffRawRes.diffText === 'string' ? diffRawRes.diffText : undefined,
    mainDirtyCount, effectiveBaseSha, changedFiles, gateHits, policy, evidence, evidenceValidation,
    nonDocChangesAfterFinalize, commitsAheadOfBase, opInProgress: Boolean(op.inProgress), opName: op.op ?? null,
    mergeState, taskRuntime, evaluated, phase: evaluated?.phase ?? null, profile, hasDevReview: effectiveHasDevReview,
  }
}

/**
 * `planBootstrap` 提审时，将实际生成的 PRD 与切片 SPEC/Todo 列表同步写回关联总控 Issue，
 * 替换占位产物描述并保留人类手写的其余正文。
 */
export async function syncBootstrapMasterIssueArtifacts({
  backend, targetRepo, linkedIssues = [], ledger, changedFiles = [],
} = {}) {
  if (!ledger?.planBootstrap || !backend || !targetRepo || linkedIssues.length === 0) return []
  const docs = [...new Set([
    ledger.prdFile,
    ledger.specFile,
    ledger.todoFile,
    ...(Array.isArray(changedFiles) ? changedFiles.map((f) => posixPath(f)).filter((f) => /^docs\/(?:prd|specs|todo)\/.*\.md$/.test(f)) : []),
  ].filter(Boolean))].sort()
  if (docs.length === 0) return []

  const section = [
    '## 规划产出文档',
    '',
    '<!-- pf:bootstrap-artifacts:begin -->',
    ...docs.map((d) => `- \`${d}\``),
    '<!-- pf:bootstrap-artifacts:end -->',
  ].join('\n')

  const out = []
  for (const iss of linkedIssues) {
    if (typeof backend.getIssue !== 'function' || typeof backend.updateIssueBody !== 'function') break
    const got = await Promise.resolve(backend.getIssue(targetRepo, iss)).catch(() => null)
    if (!got?.ok) continue
    const curBody = String(got.body ?? '').replace(/\r\n/g, '\n')
    let nextBody = curBody
    if (/<!--\s*pf:bootstrap-artifacts:begin\s*-->[\s\S]*?<!--\s*pf:bootstrap-artifacts:end\s*-->/.test(curBody)) {
      nextBody = curBody.replace(
        /<!--\s*pf:bootstrap-artifacts:begin\s*-->[\s\S]*?<!--\s*pf:bootstrap-artifacts:end\s*-->/,
        ['<!-- pf:bootstrap-artifacts:begin -->', ...docs.map((d) => `- \`${d}\``), '<!-- pf:bootstrap-artifacts:end -->'].join('\n'),
      )
    } else if (/^##\s+规划产出文档\s*$/m.test(curBody)) {
      nextBody = curBody.replace(/^##\s+规划产出文档\s*\n[\s\S]*?(?=\n##\s+|$)/m, `${section}\n`)
    } else {
      nextBody = curBody.trim() ? `${curBody.trimEnd()}\n\n${section}\n` : `${section}\n`
    }
    if (nextBody !== curBody) {
      const up = await Promise.resolve(backend.updateIssueBody({ repo: targetRepo, number: iss, body: nextBody })).catch((err) => ({ ok: false, error: err?.message }))
      out.push({ issue: iss, updated: Boolean(up?.ok), docs })
    }
  }
  return out
}
