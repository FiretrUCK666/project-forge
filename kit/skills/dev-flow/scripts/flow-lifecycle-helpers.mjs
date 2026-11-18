/**
 * flow-lifecycle-helpers.mjs —— finalize/rework 辅助函数与返工命令实现，供 flow-lifecycle.mjs 复用。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { evaluateMasterPrdClosureState } from '../../lib/doc-substantive.mjs'
import { evaluateCoupledSync, isSharedMasterPrd, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { gitRun, posixPath, readTextSafe } from '../../lib/git.mjs'
import { resolveRefShaFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { getLocalIssue } from '../../lib/local-issues.mjs'
import { parseMilestoneNumber } from '../../lib/platform.mjs'
import { readVerificationEvidence, writeVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { matchGlob } from '../../lib/static-gates.mjs'
import { getChangedFiles } from './flow-inspect.mjs'

export function computeFlowCoupledSync(implRoot, mainRoot, changedFiles) {
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : mainRoot
  const agentsText = readTextSafe(join(agentsRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(changedFiles, rules, agentsRoot) : []
}

export async function collectFinalizeChangedFiles(implRoot, ledger, statusEntries, gitCommonDir = null, headSha = null, preDiffEntries = undefined) {
  const baseDiffEntries = Array.isArray(preDiffEntries)
    ? preDiffEntries
    : (ledger.baseSha && headSha && headSha === ledger.baseSha ? [] : undefined)
  const merged = new Set(await getChangedFiles(implRoot, ledger.baseSha, { statusEntries, diffEntries: baseDiffEntries }))
  for (const baseRef of [...new Set([ledger.baseBranch, 'main', 'master'].filter(Boolean))]) {
    const fastRefSha = gitCommonDir ? resolveRefShaFast(gitCommonDir, `refs/heads/${baseRef}`) : null
    if (fastRefSha && ledger.baseSha && fastRefSha === ledger.baseSha) break
    const mb = await gitRun(implRoot, ['--no-optional-locks', 'merge-base', baseRef, 'HEAD'])
    const mbSha = mb.ok ? mb.stdout?.trim() : ''
    if (mbSha) {
      if (mbSha !== ledger.baseSha) {
        for (const f of await getChangedFiles(implRoot, mbSha, { statusEntries })) merged.add(f)
      }
      break
    }
  }
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
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
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
    const findingId = idx > 0 ? raw.slice(0, idx).trim() : 'general'
    const reason = idx > 0 ? raw.slice(idx + 1).trim() : raw.trim()
    const item = { findingId, reason, recordedAt: new Date().toISOString() }
    addedRebuts.push(item)
    ledger.rebuts = [...(ledger.rebuts ?? []), item]
    if ((ledger.rounds ?? []).length > 0) {
      const last = ledger.rounds[ledger.rounds.length - 1]
      last.rebuts = [...(last.rebuts ?? []), item]
    }
  }

  ledger.status = 'rework'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  await emitFlowSignal(roots, { category: 'hygiene', module: 'workflow', pattern: 'flow.rework', severity: 'medium', source: 'flow-rework', file: changed[0] ?? '', taskId, message: `rework entered (rebuts=${addedRebuts.length}, forbidden=${forbiddenTouched.length})`, meta: { forbiddenTouched, rebutCount: addedRebuts.length } })
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, branch: ledger.branch, prNumber: ledger.prNumber, forbiddenTouched, addedRebuts }, null, 2)}\n`)
  else {
    process.stdout.write(`进入返工模式（task=${taskId}，原分支=${ledger.branch}，原 PR=${ledger.prNumber ?? '待创建'}）：\n`)
    if (forbiddenTouched.length > 0) process.stdout.write(`- 警告：以下变更命中 do-not-edit 列表：${forbiddenTouched.join(', ')}\n`)
    if (addedRebuts.length > 0) process.stdout.write(`- 已记录 ${addedRebuts.length} 条有据反驳。\n`)
    printNextStep([{ skill: 'dev-flow', text: `1. node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }, { skill: 'dev-flow', text: `2. node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --rework` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
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
    return { exitCode: 3 }
  }
  const sharedForkPrd = Boolean(ledger.prdFile && isSharedMasterPrd(implRoot, ledger.prdFile, ledger.specFile))
  for (const relDoc of [ledger.todoFile, ledger.specFile, sharedForkPrd ? null : ledger.prdFile].filter(Boolean)) {
    const docPath = join(implRoot, relDoc)
    if (!existsSync(docPath)) continue
    const unchecked = findUncheckedLines(readTextSafe(docPath) ?? '')
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_DOC: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
      return { exitCode: 1 }
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
  if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
  else {
    process.stdout.write('Fork finalize 完成（上游未接入 docs/，私有规划已安全隔离到 .worktrees/.state/private-docs/）。\n')
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
    process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则（共 ${coupledSyncWarnings.length} 组）。\n`)
    return { exitCode: 1 }
  }
  return { exitCode: 0 }
}

export function evaluateFlowMasterPrdGate(implRoot, {
  prdRel, specRel, todoRel, includeMasterPrd = false, ledger = null, isVerify = false, taskId = '',
} = {}) {
  if (!prdRel) return { blocked: false, checkPrdInFinalize: false, closure: null }
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
        exitCode: 3,
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

export function recordVerifyEvidenceForFlow({
  roots, taskId, ledger, profileKey, currentHead, dirty, policy, modeName, targetVal,
  cmdStr, customCmd, exitCode, explicitNoneSkipped, docStaticRes,
}) {
  const prev = readVerificationEvidence(roots.gitDir, taskId)
  const sameClean = Boolean(prev && prev.headSha === currentHead && !dirty && !prev.dirty)
  const gates = sameClean ? { ...(prev.gates ?? {}) } : {}
  const skipped = new Set(sameClean && Array.isArray(prev.skipped) ? prev.skipped : [])
  const now = new Date().toISOString()
  gates[modeName] = {
    headSha: currentHead, dirty, mode: modeName, target: targetVal,
    partial: modeName === 'quick' && Boolean(targetVal),
    exitCode, cmd: cmdStr, customCmd,
    status: explicitNoneSkipped ? 'skipped-explicit-none' : (exitCode === 0 ? 'passed' : 'failed'),
    recordedAt: now,
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
  const overallExit = docStaticRes && !docStaticRes.ok ? 3 : exitCode
  writeVerificationEvidence(roots.gitDir, taskId, {
    taskId, baseSha: ledger.baseSha, headSha: currentHead, dirty,
    riskTier: policy.riskTier, mode: modeName, target: targetVal, exitCode: overallExit,
    gates, skipped: [...skipped],
  })
  return overallExit
}
