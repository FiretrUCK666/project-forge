/**
 * flow-lifecycle.mjs —— finalize（成对归档 + TDD 日期校验）、verify（尊重 none）、submit（同步 review 槽）与 rework。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep } from '../../lib/cli.mjs'
import { archiveCompletedDocsGroup, buildSubmitComments, docIsoDate, formatAttribution } from '../../lib/docs.mjs'
import {
  computeWorktreeEnv, detectInProgressGitOp, execShellCommand, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, posixPath, readTextSafe, sha256Text,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { hasExploredEvidence, nextReviewRound, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeForWrite, resolveIdentityLayers,
} from '../../lib/platform.mjs'
import { isProfileExplicitNone, parseAgentsProfile, readDecisions } from '../../lib/profile.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { assertNoDuplicatePrForTask, checkUntrustedPrGate } from '../../lib/task-graph.mjs'
import { checkFrozenCriteria } from '../../lib/criteria-lock.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import {
  buildSubmitNextSteps, determineWorkflowPolicy, hasRepoCiWorkflow, hydratePrTemplateBody,
  readVerificationEvidence, redactDiagnosticText, resolveEffectiveBaseSha, resolveReadablePrTitle,
  runLowRiskDocStaticCheck, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import {
  assertSubmitOwnership, checkLifecyclePreconditions, runLifecycleGovernHook, runPreVerifyEditGateHook,
} from './flow-lifecycle-hooks.mjs'
import {
  applySubmitPostActions,
  cmdContainsSubcommand,
  collectFinalizeChangedFiles,
  computeFlowCoupledSync,
  emitFlowSignal,
  emitVerifyOutcomeOutput,
  ensureSpecImplNoteReady,
  evaluateFlowMasterPrdGate,
  findStrictDocBySlug,
  findUncheckedLines,
  handleForkFinalize,
  handleRework,
  handleVerifyE2eFailure,
  recordVerifyEvidenceForFlow,
  syncReviewSlotForSubmit,
} from './flow-lifecycle-helpers.mjs'

export { handleRework }

/**
 * `--artifact` 可重复，值可能是路径也可能是说明；统一成去空、去重的字符串数组。
 * 空数组和「没传」语义不同，所以不把两者压成一个值。
 */
function normalizeArtifactList(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw])
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))]
}

export async function handleFinalize(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const preCheck = checkLifecyclePreconditions(ledger, opts)
  if (!preCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: preCheck.code, reason: preCheck.message }, null, 2)}\n`)
    process.stderr.write(`${preCheck.message}\n`)
    return { exitCode: preCheck.exitCode ?? EXIT_POLICY_BLOCK }
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
    if (opts.json) process.stdout.write(`${JSON.stringify(prdGate, null, 2)}\n`)
    process.stderr.write(`${prdGate.message}\n`)
    printNextStep([prdGate.nextStep], { repoRoot: roots.mainRoot })
    return { exitCode: prdGate.exitCode }
  }

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

  const criteriaDrift = checkFrozenCriteria(ledger, implRoot)
  if (criteriaDrift.blocked) { process.stderr.write(criteriaDrift.message); return { exitCode: EXIT.ACTION } }
  const specNoteCheck = ensureSpecImplNoteReady(implRoot, specRel, { currentHead, taskId, note: opts.note })
  if (!specNoteCheck.ok) { process.stderr.write(specNoteCheck.message); return { exitCode: EXIT.ACTION } }

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
  if (prdRel || specRel || todoRel) {
    archivedGroup = await archiveCompletedDocsGroup(implRoot, {
      prdFile: prdRel, specFile: specRel, todoFile: todoRel, slugOrPath: specRel ?? todoRel ?? prdRel ?? ledger.slug,
      issue: ledger.linkedIssues?.[0], pr: ledger.prNumber ?? undefined, branch: ledger.branch, owner: ledger.implementerId ?? undefined, doneAt: today,
      includeMasterPrd, ledgerRoot: roots.mainRoot,
    })
    if (archivedGroup.byKind.prd) {
      ledger.prdFile = archivedGroup.byKind.prd
      ledger.archivedPrdFile = archivedGroup.byKind.prd.startsWith('docs/archive/')
        ? archivedGroup.byKind.prd
        : null
    }
    if (archivedGroup.byKind.spec) { ledger.specFile = archivedGroup.byKind.spec; ledger.archivedSpecFile = archivedGroup.byKind.spec }
    if (archivedGroup.byKind.todo) { ledger.todoFile = archivedGroup.byKind.todo; ledger.archivedTodoFile = archivedGroup.byKind.todo }
  }

  const governHook = await runLifecycleGovernHook({ stage: 'finalize', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  if (!governHook.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify(governHook, null, 2)}\n`)
    process.stderr.write(`${governHook.message}\n`)
    return { exitCode: governHook.exitCode ?? EXIT_POLICY_BLOCK }
  }

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
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(`finalize 完成：HEAD=${currentHead ?? 'uncommitted'}，Todo=${ledger.todoFile ?? '无'}，SPEC=${ledger.specFile ?? '无'}\n`)
    if (parity.tddSyncWarning) process.stdout.write(`[TDD SYNC REMINDER]: ${parity.tddSyncWarning}\n`)
    for (const w of coupledSyncWarnings) {
      process.stdout.write(`[COUPLED SYNC]: 触及 ${w.touchedTriggers.join(', ')} -> 需检查伴随更新 ${w.expectedCompanions.join(', ')}\n`)
    }
    printNextStep([
      '1. 若 finalize 移动或更新了文档，先在工作区提交变更：git add -A && git commit -m "..."',
      { skill: 'dev-flow', text: `2. 运行实证门禁锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
    ], { repoRoot: roots.mainRoot })
  }
  if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
    process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则且未更新伴随文件（共 ${coupledSyncWarnings.length} 组）。\n`)
    return { exitCode: EXIT.ACTION }
  }
  return { exitCode: EXIT.OK }
}

export async function handleVerify(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const workRel = ledger.worktreePath || (ledger.role === 'inbound-external-pr' ? ledger.reviewWorktreePath : null)
  const implRoot = workRel ? resolve(roots.mainRoot, workRel) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const verifyPreCheck = checkLifecyclePreconditions(ledger, opts)
  if (!verifyPreCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: verifyPreCheck.code, reason: verifyPreCheck.message }, null, 2)}\n`)
    process.stderr.write(`${verifyPreCheck.message}\n`)
    return { exitCode: verifyPreCheck.exitCode ?? EXIT_POLICY_BLOCK }
  }

  const editGateRes = await runPreVerifyEditGateHook({ mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  if (!editGateRes.ok) {
    await emitFlowSignal(roots, { category: 'hygiene', module: 'workflow', pattern: 'verify.edit-gate.fail', severity: 'high', source: 'flow-verify', message: editGateRes.message, taskId })
    if (opts.json) process.stdout.write(`${JSON.stringify(editGateRes, null, 2)}\n`)
    process.stderr.write(`${editGateRes.message}\n`)
    return { exitCode: editGateRes.exitCode ?? EXIT_POLICY_BLOCK }
  }

  const hasDevReview = hasSkillSupport(roots.mainRoot, 'dev-review')
  const untrustedGate = checkUntrustedPrGate(ledger, { humanApproved: Boolean(opts['human-approved'] || opts['human-approved-exec']), hasDevReview })
  if (untrustedGate.blocked) {
    await emitFlowSignal(roots, { category: 'security', module: 'workflow', pattern: 'verify.untrusted-blocked', severity: 'high', source: 'flow-verify', message: untrustedGate.message, taskId })
    if (opts.json) process.stdout.write(`${JSON.stringify(untrustedGate, null, 2)}\n`)
    process.stderr.write(`${untrustedGate.message}\n`)
    return { exitCode: untrustedGate.exitCode ?? EXIT_POLICY_BLOCK }
  }

  const vPrdRel = ledger.prdFile ?? ledger.archivedPrdFile ?? findStrictDocBySlug(implRoot, 'docs/prd', ledger)
  if (vPrdRel) {
    const vSpecRel = ledger.specFile ?? ledger.archivedSpecFile ?? findStrictDocBySlug(implRoot, 'docs/specs', ledger)
    const vTodoRel = ledger.todoFile ?? ledger.archivedTodoFile ?? findStrictDocBySlug(implRoot, 'docs/todo', ledger)
    const prdGateV = evaluateFlowMasterPrdGate(implRoot, {
      prdRel: vPrdRel, specRel: vSpecRel, todoRel: vTodoRel, ledger, isVerify: true, taskId,
    })
    if (prdGateV.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(prdGateV, null, 2)}\n`)
      process.stderr.write(`${prdGateV.message}\n`)
      printNextStep([prdGateV.nextStep], { repoRoot: roots.mainRoot })
      return { exitCode: prdGateV.exitCode }
    }
  }

  const profile = parseAgentsProfile(implRoot)
  const mode = opts.tier ?? opts.mode ?? 'quick'
  if (!['quick', 'smoke', 'full', 'gate'].includes(mode)) {
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: 'verify.invalid-mode', severity: 'low', source: 'flow-verify', message: `invalid verify mode: ${mode}`, taskId })
    process.stderr.write(`INVALID_VERIFY_MODE: --mode / --tier 仅支持 quick | smoke | full | gate，收到：${mode}\n`)
    return { exitCode: EXIT.ACTION }
  }
  let rawTarget = opts.target !== undefined ? String(opts.target).trim() : null
  if (rawTarget !== null) {
    if (!rawTarget || /[;&|`$><\r\n]/.test(rawTarget)) {
      await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: 'verify.invalid-target', severity: 'low', source: 'flow-verify', message: `invalid target: ${opts.target}`, taskId })
      process.stderr.write(`INVALID_TARGET_ARG: --target 值非法或含不允许的元字符：${opts.target}\n`)
      return { exitCode: EXIT.ACTION }
    }
    rawTarget = posixPath(rawTarget)
  }

  const op = await detectInProgressGitOp(implRoot, { wtGitDir: resolveGitDirFast(implRoot) })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突再执行 verify`)

  const keyByMode = { quick: 'quick-test', smoke: 'smoke-verify', full: 'full-test', gate: 'merge-gate' }
  const profileKey = keyByMode[mode]
  const isExplicitNone = !opts.cmd && isProfileExplicitNone(profile, profileKey)

  let cmd = opts.cmd
  if (!cmd && !isExplicitNone) {
    if (mode === 'gate') cmd = profile.mergeGate ?? profile.fullTest ?? profile.quickTest
    else if (mode === 'full') cmd = profile.fullTest ?? profile.quickTest
    else if (mode === 'smoke') cmd = profile.smokeVerify
    else cmd = profile.quickTest
  }

  const computeVerifyPolicy = async (stZReuse = null) => {
    const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
    const fastHeadOid = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
    const effectiveBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: roots.gitDir })
    const [stZ, headRes, diffNsRes, remoteRes] = await Promise.all([
      stZReuse ? Promise.resolve(stZReuse) : gitStatusPorcelainZ(implRoot),
      fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
      !effectiveBase
        ? Promise.resolve(null)
        : (fastHeadOid && fastHeadOid === effectiveBase ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${effectiveBase}..HEAD`)),
      fastCfg ? Promise.resolve({ ok: true, stdout: fastCfg.remoteText }) : gitRun(roots.mainRoot, ['remote', '-v']),
    ])
    const currentHead = headRes.ok ? headRes.stdout.trim() : null
    const sharedDiffEntries = diffNsRes?.ok ? diffNsRes.entries : undefined
    const [changedFiles, gateHits] = await Promise.all([
      getChangedFiles(implRoot, effectiveBase, { statusEntries: stZ.entries, diffEntries: sharedDiffEntries }),
      detectGateWeakening(implRoot, effectiveBase, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: sharedDiffEntries }),
    ])
    const dirty = stZ.entries.length > 0
    const stStdout = stZ.entries.map((e) => `${e.xy} ${e.file}`).join('\n')
    const ownArchived = [ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean)
    const hasCi = hasRepoCiWorkflow(implRoot)
    const policy = determineWorkflowPolicy({
      changedFiles, ownArchived, caseType: ledger.caseType,
      highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
      gateWeakeningHits: gateHits, hasRemote: ledger.role !== 'local-only' && Boolean(remoteRes.ok && remoteRes.stdout.trim()),
      hasCiWorkflow: hasCi, visualFilesChanged: changedFiles.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile, hasDevReview,
    })
    return { currentHead, dirty, stStdout, changedFiles, policy }
  }

  if (!cmd && isExplicitNone) {
    const { currentHead, dirty, stStdout, changedFiles, policy } = await computeVerifyPolicy()
    const docStaticRes = policy.staticDocCheckRequired ? runLowRiskDocStaticCheck(implRoot, changedFiles) : null
    const docOk = !docStaticRes || docStaticRes.ok
    recordVerifyEvidenceForFlow({
      roots, taskId, ledger, profileKey, currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
      cmdStr: 'none (explicitly disabled)', customCmd: false, exitCode: EXIT.OK,
      explicitNoneSkipped: true, docStaticRes,
    })
    ledger.verifiedHead = docOk ? currentHead : null
    ledger.verifiedCmd = 'none (explicitly disabled)'
    ledger.verifiedMode = mode
    ledger.verifiedTarget = rawTarget
    ledger.verifiedDirtyHash = sha256Text(stStdout)
    ledger.lastVerifyExitCode = docOk ? 0 : EXIT_POLICY_BLOCK
    ledger.visualFilesChanged = policy.visualFilesChanged
    ledger.empiricalVisualCheckRequired = policy.visualFilesChanged.length > 0
    ledger.status = docOk ? 'verified' : 'verify-failed'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    await emitFlowSignal(roots, { category: docOk ? 'tests' : 'docs', module: 'workflow', pattern: docOk ? `verify.${mode}.pass` : `verify.${mode}.doc-static-fail`, severity: docOk ? 'info' : 'medium', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? '', taskId, message: docOk ? `verify (${mode}) explicit-none pass` : `verify (${mode}) static doc check failed` })
    if (!docOk) {
      const msg = `BLOCKED_STATIC_DOC_CHECK_FAILED: 无 CI 低风险静态必检未通过：${docStaticRes.errors.map((e) => e.message).slice(0, 3).join('；')}`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'BLOCKED_STATIC_DOC_CHECK_FAILED', errors: docStaticRes.errors }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ taskId, mode, cmd: ledger.verifiedCmd, skippedReason: 'explicit-none', ok: true, exitCode: EXIT.OK, verifiedHead: currentHead, riskTier: policy.riskTier, docStatic: docStaticRes }, null, 2)}\n`)
    } else {
      process.stdout.write(`verify (${mode}): AGENTS.md Dev Profile 显式配置 \`${profileKey}: none\`，已放行并绑定 HEAD=${currentHead ?? 'unborn'}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  if (!cmd) {
    if (mode === 'smoke' && !isExplicitNone) {
      const { policy } = await computeVerifyPolicy()
      if (policy.smokeRequired) {
        await emitFlowSignal(roots, { category: 'e2e', module: 'workflow', pattern: 'verify.smoke.unconfigured', severity: 'medium', source: 'flow-verify', message: 'unconfigured smoke-verify for runtime changes', taskId })
        process.stderr.write('BLOCKED_SMOKE_VERIFY_UNCONFIGURED: 运行时改动且 Dev Profile 未配置真实 smoke-verify 命令也未显式写 smoke-verify: none（Q3）；请在 AGENTS.md 补齐 smoke-verify，或通过 --cmd "<命令>" --e2e-evidence "<运行观察>" 传入。\n')
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.no-cmd`, severity: 'medium', source: 'flow-verify', message: `no verify command for ${mode}`, taskId })
    process.stderr.write(`NO_VERIFY_COMMAND: 未从 AGENTS.md Dev Profile 或项目清单识别到 ${mode} 验证命令，请通过 --cmd "<命令>" 显式传入（纯文档仓请配 \`${profileKey}: none\`）。\n`)
    return { exitCode: EXIT.ACTION }
  }

  // 证据只取人说过的：`--e2e-evidence` / `--visual-evidence` 的原文。
  //
  // 裸 `--visual-checked` 是「我核验过了」的口头声明，它自身**不带观察内容**。
  // 这里不替它编一句「observed and verified」——编出来的句子会被当成观察证据写进
  // evidence.json，然后一路通过后面的门禁，而实际上谁也没说看到了什么。
  // 缺什么就让它缺着，交给校验入口去要求补齐。
  const e2eEvidenceInput = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || ''
  if ((mode === 'full' || mode === 'gate') && !profile.smokeVerify && !isProfileExplicitNone(profile, 'smoke-verify') && !opts.cmd && !e2eEvidenceInput) {
    const pre = await computeVerifyPolicy()
    const prevEv = readVerificationEvidence(roots.gitDir, taskId)
    const alreadySmokeOk = Boolean(prevEv && prevEv.headSha === pre.currentHead && !pre.dirty && prevEv.gates?.smoke?.exitCode === 0 && prevEv.smokeVerifiedOnHead)
    if (pre.policy.smokeRequired && !alreadySmokeOk) {
      await emitFlowSignal(roots, { category: 'e2e', module: 'workflow', pattern: 'verify.smoke.unconfigured', severity: 'medium', source: 'flow-verify', message: `blocked ${mode}: unconfigured smoke-verify`, taskId })
      process.stderr.write(`BLOCKED_SMOKE_VERIFY_UNCONFIGURED: 运行时改动禁止在既无 smoke-verify 命令又未声明 smoke-verify: none 且无 --cmd/--e2e-evidence 时以 ${mode} 放行（Q3）；请在 AGENTS.md 补齐 smoke-verify，或传 --cmd "<命令>" --e2e-evidence "<运行观察>"。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
  }

  let targetTip = null
  if (cmd.includes('{target}')) {
    if (rawTarget) {
      const safeTarget = /\s/.test(rawTarget) ? `"${rawTarget}"` : rawTarget
      cmd = cmd.replace(/\{target\}/g, safeTarget)
    } else if (mode === 'quick') {
      cmd = cmd.replace(/\s*(?:--[A-Za-z0-9_-]+(?:=|\s+)|-[A-Za-z]\s+)?\{target\}\s*/g, ' ').replace(/\s+/g, ' ').trim()
      targetTip = '提示：quick 分层未传入 --target <path>，已省略 {target} 执行；单测迭代建议传 --target <path> 缩窄范围。'
    } else {
      await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.missing-target`, severity: 'low', source: 'flow-verify', message: `missing --target for ${mode}`, taskId })
      process.stderr.write(`MISSING_TARGET_ARG: 验证命令 "${cmd}" 含 {target} 占位符，请追加 --target <file> 指定单测文件或用例。\n`)
      return { exitCode: EXIT.ACTION }
    }
  }

  const defaultTimeout = mode === 'gate' ? 600000 : mode === 'full' ? 300000 : 120000
  const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) : defaultTimeout
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.invalid-timeout`, severity: 'low', source: 'flow-verify', message: `invalid timeout: ${opts.timeout}`, taskId })
    process.stderr.write(`INVALID_TIMEOUT_ARG: --timeout 须为 >= 1000 的毫秒数，收到：${opts.timeout}\n`)
    return { exitCode: EXIT.ACTION }
  }
  const wtEnv = computeWorktreeEnv({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, taskId, slotIndex: ledger.slotIndex })
  const tRunStart = Date.now()
  const runRes = await execShellCommand(cmd, implRoot, { timeout: timeoutMs, env: wtEnv })
  const runDurationMs = Date.now() - tRunStart
  const { currentHead, dirty, stStdout, changedFiles, policy } = await computeVerifyPolicy()
  let smokeCmdUsed = mode === 'smoke' ? cmd : null
  let smokeRunRes = mode === 'smoke' ? runRes : null
  let smokeExecuted = mode === 'smoke'
  let smokeDurationMs = mode === 'smoke' ? runDurationMs : null
  if (mode === 'gate' && policy.smokeRequired && profile.smokeVerify && !isProfileExplicitNone(profile, 'smoke-verify') && !profile.smokeVerify.includes('{target}')) {
    const prevEv = readVerificationEvidence(roots.gitDir, taskId)
    const alreadySmokeOk = Boolean(prevEv && prevEv.headSha === currentHead && !dirty && !prevEv.dirty && prevEv.gates?.smoke?.exitCode === 0 && prevEv.smokeVerifiedOnHead)
    if (!alreadySmokeOk) {
      if (cmdContainsSubcommand(cmd, profile.smokeVerify)) {
        smokeCmdUsed = profile.smokeVerify
        smokeRunRes = runRes
        smokeExecuted = true
        smokeDurationMs = runDurationMs
      } else if (runRes.ok) {
        smokeCmdUsed = profile.smokeVerify
        const tSmokeStart = Date.now()
        smokeRunRes = await execShellCommand(profile.smokeVerify, implRoot, { timeout: timeoutMs, env: wtEnv })
        smokeDurationMs = Date.now() - tSmokeStart
        smokeExecuted = true
      }
    }
  }
  const docStaticRes = runRes.ok && (!smokeRunRes || smokeRunRes.ok) && policy.staticDocCheckRequired
    ? runLowRiskDocStaticCheck(implRoot, changedFiles)
    : null
  const execOk = runRes.ok && (!smokeRunRes || smokeRunRes.ok)
  const allOk = execOk && (!docStaticRes || docStaticRes.ok)
  const evRec = recordVerifyEvidenceForFlow({
    roots, taskId, ledger, profileKey, currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
    cmdStr: cmd, customCmd: Boolean(opts.cmd), exitCode: runRes.code,
    explicitNoneSkipped: false, docStaticRes, executed: true, errorOnly: false,
    e2eObservationText: e2eEvidenceInput, durationMs: runDurationMs, smokeDurationMs,
    smokeCmd: smokeCmdUsed, smokeExitCode: smokeRunRes?.code ?? null, smokeExecuted, smokeErrorOnly: false,
    artifacts: normalizeArtifactList(opts.artifact),
    visualCheckedRaw: Boolean(opts['visual-checked']),
    visualBlockedReason: typeof opts['visual-blocked-reason'] === 'string' ? opts['visual-blocked-reason'].trim() : '',
  })
  const finalExit = !execOk && runRes.ok && smokeRunRes && !smokeRunRes.ok ? (smokeRunRes.code || 1) : evRec.overallExit
  // 前置预检拦下时，实证已经写不进去，剩下的 ledger 收尾与输出都按「未通过」走。
  if (evRec.precheck?.blocked) {
    ledger.lastVerifyExitCode = finalExit
    ledger.verifiedHead = null
    ledger.status = 'verify-failed'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, taskId, mode, code: evRec.precheck.code ?? 'BLOCKED_VERIFY_PRECHECK', exitCode: finalExit, reasons: evRec.precheck.reasons ?? null }, null, 2)}\n`)
    return { exitCode: finalExit || EXIT_POLICY_BLOCK }
  }
  let e2eFailureReport = null
  if ((mode === 'smoke' || smokeExecuted) && smokeRunRes && !smokeRunRes.ok) {
    e2eFailureReport = await handleVerifyE2eFailure({
      roots, implRoot, taskId, ledger, mode: smokeExecuted ? 'smoke' : mode,
      cmd: smokeCmdUsed ?? cmd, runRes: smokeRunRes, currentHead, changedFiles, opts,
    })
  }
  const visualFilesChanged = policy.visualFilesChanged
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const hasVisualCheckFlag = Boolean(opts['visual-checked'] || opts['visual-evidence'] || opts['e2e-evidence'])

  ledger.verifiedHead = allOk ? currentHead : null
  ledger.verifiedCmd = cmd
  ledger.verifiedMode = mode
  ledger.verifiedTarget = rawTarget
  ledger.verifiedDirtyHash = sha256Text(stStdout)
  ledger.lastVerifyExitCode = finalExit
  ledger.visualFilesChanged = visualFilesChanged
  ledger.empiricalVisualCheckRequired = empiricalVisualCheckRequired
  if (allOk && hasVisualCheckFlag) {
    ledger.visualVerifiedHead = currentHead
    // 有原文就存原文；只有裸 --visual-checked 时记「声明」本身，不编造观察内容。
    // 两者必须分得开——后面判定「有没有真观察」靠的是 evidence.json 里的 e2eObservation，
    // 而那条只有真传了 --e2e-evidence / --visual-evidence 才会有。
    ledger.visualCheckEvidence = e2eEvidenceInput
      || (opts['visual-checked'] ? '已声明核验（--visual-checked，未附观察原文）' : (ledger.visualCheckEvidence ?? null))
  }
  ledger.status = allOk ? 'verified' : 'verify-failed'
  await runLifecycleGovernHook({ stage: 'verify', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: allOk ? `verify.${mode}.pass` : `verify.${mode}.fail`, severity: allOk ? 'info' : 'high', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? changedFiles[0] ?? '', taskId, message: `verify (${mode}) exit=${finalExit}: ${redactDiagnosticText(cmd, 240)}`, meta: { riskTier: policy.riskTier, target: rawTarget } })
  emitVerifyOutcomeOutput({
    opts, roots, taskId, mode, rawTarget, cmd, targetTip, allOk, finalExit, ledger, policy,
    evRec, e2eFailureReport, docStaticRes, visualFilesChanged, empiricalVisualCheckRequired, runRes, currentHead,
  })
  return { exitCode: allOk ? 0 : (finalExit || 1) }
}

export async function handleSubmit(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot, { wtGitDir: resolveGitDirFast(implRoot) })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)

  const ownRes = assertSubmitOwnership(ledger, opts)
  if (!ownRes.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: ownRes.code, reason: ownRes.message }, null, 2)}\n`)
    process.stderr.write(`${ownRes.message}\n`)
    return { exitCode: ownRes.exitCode ?? EXIT_POLICY_BLOCK }
  }

  const fastHeadOid = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
  const [headRes, stZ] = await Promise.all([
    fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
    gitStatusPorcelainZ(implRoot),
  ])

  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 存在未提交改动，请先提交后再运行 verify 与 submit。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const needsFinalize = ledger.caseType === 3 || ledger.caseType === 4 || Boolean(ledger.todoFile) || Boolean(ledger.specFile)
  if (needsFinalize) {
    if (!ledger.finalized) {
      process.stderr.write(`BLOCKED_NOT_FINALIZED: Case ${ledger.caseType} 任务必须先执行 flow.mjs finalize --task ${taskId} 完成文档同步锁。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (ledger.finalizedHead && currentHead && ledger.finalizedHead !== currentHead) {
      const postFin = await gitDiffNameStatusZ(implRoot, [`${ledger.finalizedHead}..${currentHead}`])
      const nonDocChanges = postFin.entries.map((e) => e.file).filter((f) => f && !/^docs\//.test(f))
      if (nonDocChanges.length > 0) {
        process.stderr.write(`BLOCKED_STALE_FINALIZE: finalize 之后又改了非文档文件（${nonDocChanges.join(', ')}），请重新运行 finalize。\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
  }

  if (ledger.lastVerifyExitCode !== 0 || (currentHead && ledger.verifiedHead !== currentHead)) {
    if (!ledger.verifiedHead) {
      process.stderr.write(`BLOCKED_NOT_VERIFIED: 提交前必须先运行并通过 flow.mjs verify --task ${taskId}。\n`)
    } else {
      process.stderr.write(`BLOCKED_STALE_VERIFICATION: 代码已变更（verifiedHead=${String(ledger.verifiedHead).slice(0, 7)} !== HEAD=${currentHead?.slice(0, 7)}），必须重跑 verify。\n`)
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const profile = parseAgentsProfile(implRoot)
  const effectiveBase = await resolveEffectiveBaseSha(implRoot, ledger, { gitCommonDir: roots.gitDir })
  const submitDiffRes = !effectiveBase
    ? null
    : (fastHeadOid && fastHeadOid === effectiveBase ? { ok: true, entries: [] } : await gitDiffRawEntriesAndText(implRoot, `${effectiveBase}..HEAD`))
  const submitDiffEntries = submitDiffRes?.ok ? submitDiffRes.entries : undefined
  const [changedForVisual, gateFindings] = await Promise.all([
    getChangedFiles(implRoot, effectiveBase, { statusEntries: stZ.entries, diffEntries: submitDiffEntries }),
    detectGateWeakening(implRoot, effectiveBase, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: submitDiffEntries }),
  ])
  const ownArchived = [ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean)
  const hasDevReview = hasSkillSupport(roots.mainRoot, 'dev-review')
  const policy = determineWorkflowPolicy({
    changedFiles: changedForVisual, ownArchived, caseType: ledger.caseType,
    highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateFindings, hasRemote: ledger.role !== 'local-only',
    hasCiWorkflow: hasRepoCiWorkflow(implRoot),
    visualFilesChanged: changedForVisual.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile, hasDevReview,
  })
  const isCase1LowRiskDoc = Number(ledger.caseType) === 1 && policy.riskTier === 'low'
  if (ledger.role !== 'inbound-external-pr' && !isCase1LowRiskDoc && !hasExploredEvidence(ledger)) {
    const unlockCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" explore --task ${taskId}`
    const msg = `BLOCKED_NOT_EXPLORED: 任务 ${taskId} 缺少只读探索证据（ledger.explored），请先运行 flow.mjs explore --task ${taskId} 记录后再提交。`
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_NOT_EXPLORED', taskId, reason: msg, nextStep: unlockCmd }, null, 2)}\n`)
    }
    process.stderr.write(`${msg}\n`)
    if (!opts.json) printNextStep([{ skill: 'dev-flow', text: unlockCmd }], { repoRoot: roots.mainRoot })
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  const evidence = readVerificationEvidence(roots.gitDir, taskId)
  const evCheck = validateVerificationEvidence({ policy, evidence, headSha: currentHead, profile })
  if (!evCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: evCheck.code, reason: evCheck.reason, policy }, null, 2)}\n`)
    process.stderr.write(`${evCheck.code}: ${evCheck.reason}\n`)
    return { exitCode: evCheck.exitCode ?? EXIT_POLICY_BLOCK }
  }

  const visualFilesChanged = policy.visualFilesChanged
  ledger.visualFilesChanged = visualFilesChanged
  ledger.empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const visualVerifiedOnHead = ledger.empiricalVisualCheckRequired && ledger.visualVerifiedHead === currentHead

  if (ledger.role === 'clone-readonly') {
    process.stderr.write('BLOCKED_CLONE_READONLY: 当前身份为只读克隆，禁止推送；请先走 Fork 或本地模式。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const reviewSlotSync = await syncReviewSlotForSubmit(roots, ledger, taskId, currentHead, { resetDirty: Boolean(opts['reset-review-slot']) })
  const nextRound = (ledger.rounds ?? []).length > 0 ? nextReviewRound(ledger) : 1
  const postLocalLifecycleComments = async ({ targetRepo = null, pushRemote = null, actionFallback }) => {
    if ((ledger.linkedIssues ?? []).length === 0) return
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId ?? 'none', targetRepo, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const submitLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const submitDisplay = formatAttribution({ ...submitLayers, capabilities: localBackend.capabilities })
    const submitActorId = submitLayers.agent || submitLayers.account || undefined
    const isReworkLocal = Boolean(opts.rework) || (ledger.rounds ?? []).length > 0
    const recentRebuts = (ledger.rebuts ?? []).slice(-3).map((r) => `${r.findingId}: ${r.reason}`).join('；')
    const { issueCommentBodyFor } = buildSubmitComments({
      isRework: isReworkLocal, round: nextRound, shortHead: currentHead?.slice(0, 7) ?? 'unknown', actorDisplay: submitDisplay,
      branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: null, linkedIssues: ledger.linkedIssues ?? [], recentRebuts,
    })
    for (const iss of ledger.linkedIssues ?? []) {
      await localBackend.postComment({
        taskId,
        number: iss,
        body: issueCommentBodyFor(iss),
        author: submitActorId,
        statePayload: {
          taskId,
          action: isReworkLocal ? 'rework-submitted' : actionFallback,
          round: nextRound,
          ...(submitLayers.account ? { account: submitLayers.account, verifiedPlatformLogin: submitLayers.verifiedPlatformLogin } : {}),
          ...(submitLayers.agent ? { agent: submitLayers.agent } : {}),
          headSha: currentHead,
        },
      })
      if (typeof localBackend.syncStateLabel === 'function') await Promise.resolve(localBackend.syncStateLabel({ taskId, number: iss, state: 'in-review' })).catch(() => null)
    }
  }

  if (ledger.role === 'local-only') {
    const shortHead = currentHead?.slice(0, 7) ?? 'unknown'
    await postLocalLifecycleComments({ actionFallback: 'local-ready' })
    ledger.status = 'local-ready'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...ledger, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`本地模式提交校验已通过（HEAD=${shortHead}，未配置远端不执行 push）。\n`)
      printNextStep(buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview }), { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const fastRemoteCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastRemoteCfg ? { ok: true, stdout: fastRemoteCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, originLower, upstreamLower, targetRepo, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)

  if (ledger.role === 'contributor-fork' && originLower && upstreamLower && originLower === upstreamLower) {
    process.stderr.write('BLOCKED_FORK_REMOTE_LOCK: origin 与 upstream 指向相同仓，禁止直接向正本推送。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const pushRes = await gitRun(implRoot, ['push', '-u', pushRemote, ledger.branch])
  if (!pushRes.ok) throw new Error(`推送到 ${pushRemote}/${ledger.branch} 失败：${pushRes.stderr}`)

  if (ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || !targetRepo) {
    await postLocalLifecycleComments({ targetRepo, pushRemote, actionFallback: 'submitted' })
    ledger.status = 'submitted'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, providerId: ledger.providerId, status: ledger.status, head: currentHead, pushRemote, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`submit 完成：已推送至 ${pushRemote}/${ledger.branch} @ ${currentHead?.slice(0, 7)}（generic-git 模式跳过平台 API）。\n`)
      printNextStep(buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview }), { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  // 提审要开 PR——那是平台写操作。用「不联网」的探测结果判断「能不能写」，
  // 必然得到「不能」，然后安静地只记账本，看起来像成功。
  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const backend = createTaskBackend({
    role: ledger.role, providerId: ledger.providerId, targetRepo,
    client: opts._ghClient ?? ghProbe.client, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })
  const submitLayers = resolveIdentityLayers({
    ghLogin: ghProbe.env?.trackB?.login,
    ghTier: ghProbe.env?.trackB?.tier,
    explicitAgent: opts.agent,
    ledgerAccount: ledger.account,
    ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
    ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
  })
  const submitDisplay = formatAttribution({ ...submitLayers, capabilities: backend.capabilities })
  const submitStateIdentity = {
    ...(submitLayers.account ? { account: submitLayers.account, verifiedPlatformLogin: submitLayers.verifiedPlatformLogin } : {}),
    ...(submitLayers.agent ? { agent: submitLayers.agent } : {}),
  }
  const shortHead = currentHead?.slice(0, 7) ?? 'unknown'
  const originOwner = originFull ? originFull.split('/')[0] : null
  const headSpec = ledger.role === 'contributor-fork' && originOwner ? `${originOwner}:${ledger.branch}` : ledger.branch

  if (opts['new-pr']) {
    const dup = assertNoDuplicatePrForTask({ ledger: { ...ledger, reworkMode: false } })
    if (dup.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(dup, null, 2)}\n`)
      process.stderr.write(`${dup.message}\n`)
      return { exitCode: dup.exitCode ?? EXIT_POLICY_BLOCK }
    }
  }
  if (!ledger.prNumber && !opts.rework) {
    const openPrRes = await backend.findOpenPrForBranch({ repo: targetRepo, branch: ledger.branch, headOwner: ledger.role === 'contributor-fork' ? originOwner : undefined, base: ledger.baseBranch })
    if (openPrRes?.ok && Array.isArray(openPrRes.prs) && openPrRes.prs.length > 0) {
      const found = openPrRes.prs[0]
      ledger.prNumber = found.number
      ledger.prUrl = found.url ?? ledger.prUrl
      ledger.prState = found.state ?? 'OPEN'
    }
  }
  const isRework = Boolean(opts.rework) || Boolean(ledger.prNumber)

  let prResult = null
  const commentResults = []
  if (isRework && ledger.prNumber) {
    const recentRebuts = (ledger.rebuts ?? []).slice(-3).map((r) => `${r.findingId}: ${r.reason}`).join('；')
    const { prCommentBody, issueCommentBodyFor } = buildSubmitComments({ isRework: true, round: nextRound, shortHead, actorDisplay: submitDisplay, branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: ledger.prNumber, linkedIssues: ledger.linkedIssues ?? [], recentRebuts })
    prResult = { reusedPr: ledger.prNumber, head: shortHead }
    commentResults.push({ target: `PR #${ledger.prNumber}`, res: await backend.postComment({ repo: targetRepo, number: ledger.prNumber, body: prCommentBody, statePayload: { taskId, action: 'rework-submitted', round: nextRound, ...submitStateIdentity, headSha: currentHead } }) })
    for (const iss of ledger.linkedIssues ?? []) {
      commentResults.push({ target: `Issue #${iss}`, res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: 'rework-submitted', round: nextRound, ...submitStateIdentity, prNumber: ledger.prNumber, headSha: currentHead } }) })
    }
    await applySubmitPostActions({ backend, targetRepo, prNumber: ledger.prNumber, linkedIssues: ledger.linkedIssues ?? [], ledger, roots, isRework: true })
  } else {
    const title = resolveReadablePrTitle(implRoot, ledger, opts.title)
    // 提案正文由账本与模板确定性生成，不接受整段替换。
    //
    // 正文里排着实证上下文（验证绑定哪个 HEAD、门禁跑过什么、界面核验观测到什么），
    // 而这些都能从账本与实证记录读出来。一旦允许调用方传 `--body`，人（或模型）就会
    // 传一段自己写的进去，实证栏随即变成自由发挥——它显示的是「他说的」，不是「记录里的」。
    const body = hydratePrTemplateBody({ repoRoot: implRoot, taskId, ledger, policy, evidence, actorDisplay: submitDisplay, implementerDisplay: submitDisplay, visualFilesChanged, visualVerifiedOnHead, currentHead, changedFiles: changedForVisual })
    prResult = await backend.createPr({ targetRepo, head: headSpec, base: ledger.baseBranch, title, body, draft: Boolean(opts.draft) })
    if (prResult.ok && prResult.number) {
      ledger.prNumber = prResult.number
      ledger.prUrl = prResult.url ?? null
      ledger.prState = 'OPEN'
      const { prCommentBody, issueCommentBodyFor } = buildSubmitComments({ isRework: false, round: 1, shortHead, actorDisplay: submitDisplay, branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: prResult.number, prUrl: prResult.url, linkedIssues: ledger.linkedIssues ?? [] })
      commentResults.push({ target: `PR #${prResult.number}`, res: await backend.postComment({ repo: targetRepo, number: prResult.number, body: prCommentBody, statePayload: { taskId, action: 'pr-submitted', round: 1, ...submitStateIdentity, prNumber: prResult.number, headSha: currentHead } }) })
      for (const iss of ledger.linkedIssues ?? []) {
        commentResults.push({ target: `Issue #${iss}`, res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: 'pr-created', ...submitStateIdentity, prNumber: prResult.number, headSha: currentHead } }) })
      }
      await applySubmitPostActions({ backend, targetRepo, prNumber: prResult.number, linkedIssues: ledger.linkedIssues ?? [], ledger, roots, isRework: false })
    }
  }

  ledger.lastSubmittedHead = currentHead
  ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, status: ledger.status, head: currentHead, prResult, commentResults, reviewSlotSync }, null, 2)}\n`)
  else {
    process.stdout.write(`submit 完成：已推分支 ${pushRemote}/${ledger.branch} @ ${shortHead}，状态=${ledger.status}\n`)
    if (prResult?.oneClickPrUrl) process.stdout.write(`- 一键创建 PR 链接：${prResult.oneClickPrUrl}\n`)
    if (prResult?.delegated) process.stdout.write(`- 待宿主 MCP 代理执行 PR 载荷：${JSON.stringify(prResult.jsonPayload)}\n`)
    printNextStep(buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview }), { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
