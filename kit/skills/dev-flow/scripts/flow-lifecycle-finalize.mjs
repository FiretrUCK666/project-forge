/**
 * flow-lifecycle-finalize.mjs —— `flow.mjs finalize` 成对归档、SPEC 正文状态表同步与 TDD 日期校验。
 *
 * 从 `flow-lifecycle.mjs` 拆出以严守单文件 <= 800 行红线，严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { ARCHITECTURE_MAP_REL, renderArchitectureMapFromRepo } from '../../lib/architecture-map.mjs'
import { FEATURE_MAP_REL } from '../../lib/feature-map.mjs'
import { checkFrozenCriteria } from '../../lib/criteria-lock.mjs'
import { parseDocFrontmatter } from '../../lib/doc-frontmatter.mjs'
import { archiveCompletedDocsGroup, docIsoDate, syncPlanDocBodyMeta } from '../../lib/docs.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import {
  detectInProgressGitOp, gitRun, gitStatusPorcelainZ, posixPath, readTextSafe, writeAtomic,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { readDecisions } from '../../lib/profile.mjs'
import { gitDiffRawEntriesAndText } from '../../lib/static-gates.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import { resolveEffectiveBaseSha } from '../../lib/workflow-policy.mjs'
import {
  collectFinalizeChangedFiles,
  computeFlowCoupledSync,
  ensureSpecImplNoteReady,
  evaluateFlowMasterPrdGate,
  findStrictDocBySlug,
  findUncheckedLines,
  handleForkFinalize,
  promotePlanningInLedgerOnFinalize,
  validatePlanningReadyForFinalize,
} from './flow-lifecycle-helpers.mjs'
import { checkLifecyclePreconditions, checkTaskSlotBoundaryOrEmit, runLifecycleGovernHook } from './flow-lifecycle-hooks.mjs'
import { guardSandboxPreSubmitOrFinalize } from './flow-sandbox.mjs'

/**
 * 同步 SPEC 正文 `## 文档信息与变更概览` 状态表（当前状态 / 更新日期 / 内审状态 / 关联归档路径），
 * 统一委托给 `docs.mjs` 的单源 `syncPlanDocBodyMeta`。
 */
export function syncSpecBodyStatusTable(specText, {
  status = 'implemented',
  today,
  prdRel = null,
  todoRel = null,
  critiquePassed = false,
} = {}) {
  return syncPlanDocBodyMeta(specText, {}, { status, today, prdRel, todoRel, critiquePassed })
}

function syncSpecStatusTableOnDisk(implRoot, specRel, { today, prdRel, todoRel }) {
  if (!specRel) return false
  const abs = join(implRoot, specRel)
  if (!existsSync(abs)) return false
  const text = readTextSafe(abs)
  if (!text) return false
  const fm = parseDocFrontmatter(text)
  const critiquePassed = Boolean(fm.data?.approved === true || /^passed/i.test(String(fm.data?.plan_critique ?? '')))
  const synced = syncPlanDocBodyMeta(text, fm.data ?? {}, {
    status: String(fm.data?.status ?? 'implemented'),
    today,
    prdRel,
    todoRel,
    critiquePassed,
  })
  if (synced === text) return false
  writeAtomic(abs, synced)
  return true
}

export async function handleFinalize(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)
  const slotOk = checkTaskSlotBoundaryOrEmit(roots.mainRoot, implRoot, ledger, opts)
  if (!slotOk.ok) return { exitCode: slotOk.exitCode }
  const sbGuard = guardSandboxPreSubmitOrFinalize(ledger, opts, 'finalize')
  if (!sbGuard.ok) return { exitCode: sbGuard.exitCode }

  const preCheck = checkLifecyclePreconditions(ledger, opts)
  if (!preCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: preCheck.code, reason: preCheck.message }, null, 2)}\n`)
    process.stderr.write(`${preCheck.message}\n`)
    return { exitCode: preCheck.exitCode ?? EXIT.FACT }
  }

  const fastFinHead = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
  const [stZ, headRes] = await Promise.all([
    gitStatusPorcelainZ(implRoot),
    fastFinHead ? Promise.resolve({ ok: true, stdout: fastFinHead }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
  ])
  const op = await detectInProgressGitOp(implRoot, { statusEntries: stZ.entries })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突后再 finalize`)

  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  const today = docIsoDate()

  // contributor-fork：若上游仓库并未接入 docs/ 体系，严禁把本地私有 docs/ 混入 PR diff
  if (ledger.role === 'contributor-fork') {
    const forkOut = await handleForkFinalize({ implRoot, roots, ledger, taskId, stZ, currentHead, opts })
    if (forkOut) return forkOut
  }

  const todoRel = ledger.todoFile ?? ledger.archivedTodoFile ?? findStrictDocBySlug(implRoot, 'docs/todo', ledger)
  const specRel = ledger.specFile ?? ledger.archivedSpecFile ?? findStrictDocBySlug(implRoot, 'docs/specs', ledger)
  const prdRel = ledger.prdFile ?? ledger.archivedPrdFile ?? findStrictDocBySlug(implRoot, 'docs/prd', ledger)
  const includeMasterPrd = Boolean(opts['include-master-prd'])
  const prdGate = evaluateFlowMasterPrdGate(implRoot, {
    prdRel, specRel, todoRel, includeMasterPrd, ledger, isVerify: false, taskId,
  })
  if (prdGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(prdGate, [prdGate.nextStep], { repoRoot: roots.mainRoot }), null, 2)}\n`)
    process.stderr.write(`${prdGate.message}\n`)
    printNextStep([prdGate.nextStep], { repoRoot: roots.mainRoot })
    return { exitCode: prdGate.exitCode }
  }

  const planningCheck = validatePlanningReadyForFinalize({ implRoot, ledger, taskId, specRel, todoRel, prdRel })
  if (planningCheck.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(planningCheck, null, 2)}\n`)
    process.stderr.write(`${planningCheck.message}\n`)
    return { exitCode: planningCheck.exitCode ?? EXIT.FACT }
  }

  const isPlanBootstrapDocs = Boolean(
    ledger.planBootstrap === true
    && (prdRel || specRel || stZ.entries.some((e) => /^docs\/(?:prd|specs)\//.test(posixPath(e.file ?? '')))),
  )

  if (!isPlanBootstrapDocs) {
    for (const [label, relDoc] of [['TODO', todoRel], ['SPEC', specRel], ['PRD', prdGate.checkPrdInFinalize ? prdRel : null]]) {
      if (!relDoc) continue
      const absDoc = join(implRoot, relDoc)
      if (!existsSync(absDoc)) continue
      const unchecked = findUncheckedLines(readTextSafe(absDoc) ?? '')
      if (unchecked.length > 0) {
        process.stderr.write(`BLOCKED_UNCHECKED_${label}: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
        return { exitCode: EXIT.ACTION }
      }
    }
  }

  const criteriaDrift = checkFrozenCriteria(ledger, implRoot)
  if (criteriaDrift.blocked) { process.stderr.write(criteriaDrift.message); return { exitCode: EXIT.ACTION } }
  if (!isPlanBootstrapDocs) {
    const specNoteCheck = ensureSpecImplNoteReady(implRoot, specRel, { currentHead, taskId, note: opts.note })
    if (!specNoteCheck.ok) { process.stderr.write(specNoteCheck.message); return { exitCode: EXIT.ACTION } }
  }

  const effectiveBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: roots.gitDir })
  const finDiff = effectiveBase
    ? (currentHead && currentHead === effectiveBase ? { ok: true, entries: [], diffText: '' } : await gitDiffRawEntriesAndText(implRoot, `${effectiveBase}..HEAD`))
    : null
  const finDiffEntries = finDiff?.ok ? finDiff.entries : undefined
  const changed = await collectFinalizeChangedFiles(implRoot, ledger, stZ.entries, roots.gitDir, currentHead, finDiffEntries)
  const parity = await checkTddSyncParity(implRoot, changed, ledger, {
    statusEntries: stZ.entries, diffEntries: finDiffEntries, diffText: finDiff?.diffText,
  })
  const coupledSyncWarnings = computeFlowCoupledSync(implRoot, roots.mainRoot, changed)
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : roots.mainRoot
  const agentsDecisions = readDecisions(readTextSafe(join(agentsRoot, 'AGENTS.md')) ?? '')
  if (parity.tddSyncWarning && !opts['no-tdd'] && !agentsDecisions.has('no-tdd')) {
    const blockedOut = {
      ok: false,
      blocked: true,
      code: 'BLOCKED_TDD_SYNC',
      taskId,
      coupledSyncWarnings,
      ...parity,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(blockedOut, null, 2)}\n`)
    process.stderr.write(`BLOCKED_TDD_SYNC: ${parity.tddSyncWarning}\n`)
    return { exitCode: EXIT.ACTION }
  }

  let archivedGroup = { moved: [], byKind: { prd: prdRel, spec: specRel, todo: todoRel }, archivedMasterPrd: null }
  if (isPlanBootstrapDocs) {
    // 规划引导 PR 阶段保留活跃 PRD/SPEC/Todo 在原目录，供后续各切片实施时逐步推进与归档
    if (specRel && existsSync(join(implRoot, specRel))) {
      syncSpecStatusTableOnDisk(implRoot, specRel, { today, prdRel, todoRel })
    }
  } else if (prdRel || specRel || todoRel) {
    const existingSpecOwner = specRel && existsSync(join(implRoot, specRel))
      ? parseDocFrontmatter(readTextSafe(join(implRoot, specRel)) ?? '').data?.owner
      : null
    const existingTodoOwner = todoRel && existsSync(join(implRoot, todoRel))
      ? parseDocFrontmatter(readTextSafe(join(implRoot, todoRel)) ?? '').data?.owner
      : null
    archivedGroup = await archiveCompletedDocsGroup(implRoot, {
      prdFile: prdRel, specFile: specRel, todoFile: todoRel, slugOrPath: specRel ?? todoRel ?? prdRel ?? ledger.slug,
      issue: ledger.linkedIssues?.[0], pr: ledger.prNumber ?? undefined, branch: ledger.branch,
      owner: (existingSpecOwner || existingTodoOwner) ? undefined : (ledger.implementerId ?? undefined),
      doneAt: today,
      includeMasterPrd, ledgerRoot: roots.mainRoot,
    })
    if (archivedGroup.byKind.prd) {
      ledger.prdFile = archivedGroup.byKind.prd
      ledger.archivedPrdFile = archivedGroup.byKind.prd.startsWith('docs/archive/')
        ? archivedGroup.byKind.prd
        : null
    }
    if (archivedGroup.byKind.spec) {
      ledger.specFile = archivedGroup.byKind.spec
      ledger.archivedSpecFile = archivedGroup.byKind.spec
      if (ledger.criteriaFingerprint && archivedGroup.byKind.spec.startsWith('docs/archive/')) {
        ledger.criteriaFrozenFrom = archivedGroup.byKind.spec
      }
    }
    if (archivedGroup.byKind.todo) { ledger.todoFile = archivedGroup.byKind.todo; ledger.archivedTodoFile = archivedGroup.byKind.todo }
    syncSpecStatusTableOnDisk(implRoot, archivedGroup.byKind.spec ?? specRel, {
      today,
      prdRel: archivedGroup.byKind.prd ?? prdRel,
      todoRel: archivedGroup.byKind.todo ?? todoRel,
    })
    const pathsToStage = [
      ...archivedGroup.moved.flatMap((m) => [m.from, m.to]),
      archivedGroup.byKind.prd,
      archivedGroup.byKind.spec,
      archivedGroup.byKind.todo,
    ].filter(Boolean)
    if (existsSync(join(implRoot, FEATURE_MAP_REL))) {
      const statusEntries = roots.isGit ? ((await gitStatusPorcelainZ(implRoot))?.entries ?? []) : []
      const diffEntries = roots.isGit && ledger?.baseSha ? ((await gitDiffRawEntriesAndText(implRoot, ledger.baseSha))?.entries ?? []) : []
      const fmChanged = existsSync(join(implRoot, ARCHITECTURE_MAP_REL))
        || statusEntries.some((e) => e.file === FEATURE_MAP_REL)
        || diffEntries.some((e) => e.file === FEATURE_MAP_REL)
      if (fmChanged) {
        const archRes = renderArchitectureMapFromRepo(implRoot)
        if (archRes.ok && !archRes.optedOut && !archRes.skipped) pathsToStage.push(ARCHITECTURE_MAP_REL)
      }
    }
    if (pathsToStage.length > 0 && roots.isGit) {
      await gitRun(implRoot, ['add', '-A', '--', ...new Set(pathsToStage)])
    }
  } else if (!isPlanBootstrapDocs && existsSync(join(implRoot, FEATURE_MAP_REL))) {
    const statusEntries = roots.isGit ? ((await gitStatusPorcelainZ(implRoot))?.entries ?? []) : []
    const diffEntries = roots.isGit && ledger?.baseSha ? ((await gitDiffRawEntriesAndText(implRoot, ledger.baseSha))?.entries ?? []) : []
    const fmChanged = existsSync(join(implRoot, ARCHITECTURE_MAP_REL))
      || statusEntries.some((e) => e.file === FEATURE_MAP_REL)
      || diffEntries.some((e) => e.file === FEATURE_MAP_REL)
    if (fmChanged) {
      const archRes = renderArchitectureMapFromRepo(implRoot)
      if (archRes.ok && !archRes.optedOut && !archRes.skipped && roots.isGit) {
        await gitRun(implRoot, ['add', '-A', '--', ARCHITECTURE_MAP_REL])
      }
    }
  }

  const governHook = await runLifecycleGovernHook({ stage: 'finalize', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  if (!governHook.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify(governHook, null, 2)}\n`)
    process.stderr.write(`${governHook.message}\n`)
    return { exitCode: governHook.exitCode ?? EXIT.FACT }
  }

  if (planningCheck.shouldPromotePlanning) promotePlanningInLedgerOnFinalize(ledger, opts)
  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const out = {
    taskId, finalized: true, finalizedHead: currentHead,
    prdFile: ledger.prdFile, archivedPrdFile: ledger.archivedPrdFile, archivedMasterPrd: archivedGroup.archivedMasterPrd ?? null,
    specFile: ledger.specFile, todoFile: ledger.todoFile,
    archivedDocs: archivedGroup.moved, coupledSyncWarnings, ...(preCheck.warnings.length ? { lifecycleWarnings: preCheck.warnings } : {}), ...parity,
  }
  const finalizeNext = [
    '1. 若 finalize 移动或更新了文档，先在工作区提交变更：git add -A && git commit -m "..."',
    { skill: 'dev-flow', text: `2. 运行实证门禁锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
  ]
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(out, finalizeNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write(`finalize 完成：HEAD=${currentHead ?? 'uncommitted'}，Todo=${ledger.todoFile ?? '无'}，SPEC=${ledger.specFile ?? '无'}\n`)
    if (parity.tddSyncWarning) process.stdout.write(`[TDD SYNC REMINDER]: ${parity.tddSyncWarning}\n`)
    for (const w of coupledSyncWarnings) {
      process.stdout.write(`[COUPLED SYNC]: 触及 ${w.touchedTriggers.join(', ')} -> 需检查伴随更新 ${w.expectedCompanions.join(', ')}\n`)
    }
    printNextStep(finalizeNext, { repoRoot: roots.mainRoot })
  }
  if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
    process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则且未更新伴随文件（共 ${coupledSyncWarnings.length} 组）。\n`)
    return { exitCode: EXIT.ACTION }
  }
  return { exitCode: EXIT.OK }
}
