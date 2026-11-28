/**
 * flow-lifecycle.mjs —— finalize（成对归档 + TDD 日期校验）、verify（尊重 none）、submit（同步 review 槽）与 rework。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { checkFrozenCriteria } from '../../lib/criteria-lock.mjs'
import { buildSubmitComments, docIsoDate, formatAttribution } from '../../lib/docs.mjs'
import {
  computeWorktreeEnv, detectInProgressGitOp, execShellCommand, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, posixPath, readTextSafe, sha256Text,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { deriveReworkState, nextReviewRound, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeForWrite, resolveIdentityLayers,
} from '../../lib/platform.mjs'
import { isProfileExplicitNone, parseAgentsProfile, resolveTierCommand, TIER_PROFILE_KEYS } from '../../lib/profile.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText, isUiVisualFile } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { assertNoDuplicatePrForTask, checkUntrustedPrGate } from '../../lib/task-graph.mjs'
import { stageAndSyncTaskArtifacts } from '../../lib/empirical-artifacts.mjs'
import {
  buildSubmitNextSteps, determineWorkflowPolicy, hasRepoCiWorkflow, hydratePrTemplateBody,
  readVerificationEvidence, redactDiagnosticText, resolveEffectiveBaseSha, resolveReadablePrTitleWithSource,
  runLowRiskDocStaticCheck, validateVerificationEvidence, verificationEvidencePath,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'
import { handleFinalize } from './flow-lifecycle-finalize.mjs'
import { guardSandboxPreSubmitOrFinalize, resolveSandboxVerifyMode } from './flow-sandbox.mjs'
import {
  assertSubmitOwnership, checkCase2StructuralDriftOnVerify, checkLifecyclePreconditions,
  checkTaskSlotBoundaryOrEmit, runLifecycleGovernHook, runPreVerifyEditGateHook, runVerifyPrecheck,
} from './flow-lifecycle-hooks.mjs'
import {
  applySubmitPostActions,
  cmdContainsSubcommand,
  collectTaskRuntimeSnapshot,
  emitFlowSignal,
  emitVerifyOutcomeOutput,
  evaluateFlowMasterPrdGate,
  findStrictDocBySlug,
  formatAgentCliArg,
  handleRework,
  handleVerifyE2eFailure,
  pickSignalBlameFile,
  recordVerifyEvidenceForFlow,
  syncBootstrapMasterIssueArtifacts,
  syncReviewSlotForSubmit,
} from './flow-lifecycle-helpers.mjs'

export { handleFinalize, handleRework }

/**
 * `--artifact` 可重复，值可能是路径也可能是说明；统一成去空、去重的字符串数组。
 * 空数组和「没传」语义不同，所以不把两者压成一个值。
 */
function normalizeArtifactList(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw])
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))]
}

async function handleVerifyPrecheckBlock({ opts, roots, taskId, mode, ledger, evRec, finalExit }) {
  ledger.lastVerifyExitCode = finalExit
  ledger.verifiedHead = null
  ledger.status = 'verify-failed'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  if (opts.json) {
    const reason = evRec.precheck?.reason ?? evRec.precheck?.message ?? null
    const errors = Array.isArray(evRec.precheck?.errors) ? evRec.precheck.errors : []
    process.stdout.write(`${JSON.stringify({ ok: false, taskId, mode, code: evRec.precheck?.code ?? 'BLOCKED_VERIFY_PRECHECK', exitCode: finalExit, reason, errors }, null, 2)}\n`)
  }
  return { exitCode: finalExit || EXIT.FACT }
}

export async function handleVerify(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const workRel = ledger.worktreePath || (ledger.role === 'inbound-external-pr' ? ledger.reviewWorktreePath : null)
  const implRoot = workRel ? resolve(roots.mainRoot, workRel) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)
  const verifySlotOk = checkTaskSlotBoundaryOrEmit(roots.mainRoot, implRoot, ledger, opts)
  if (!verifySlotOk.ok) return { exitCode: verifySlotOk.exitCode }

  const verifyPreCheck = checkLifecyclePreconditions(ledger, { ...opts, _stage: 'verify' })
  if (!verifyPreCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: verifyPreCheck.code, reason: verifyPreCheck.message }, null, 2)}\n`)
    process.stderr.write(`${verifyPreCheck.message}\n`)
    return { exitCode: verifyPreCheck.exitCode ?? EXIT.FACT }
  }
  const sbVerify = resolveSandboxVerifyMode(ledger, opts)

  const mode = opts.mode ?? opts.tier ?? 'quick'
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
  const isQuickTargetIter = mode === 'quick' && Boolean(rawTarget)

  const editGateRes = isQuickTargetIter
    ? { ok: true, skipped: true, reason: 'quick-target-iter' }
    : await runPreVerifyEditGateHook({ mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  if (!editGateRes.ok) {
    await emitFlowSignal(roots, { category: 'hygiene', module: 'workflow', pattern: 'verify.edit-gate.fail', severity: 'high', source: 'flow-verify', message: editGateRes.message, taskId })
    if (opts.json) process.stdout.write(`${JSON.stringify(editGateRes, null, 2)}\n`)
    process.stderr.write(`${editGateRes.message}\n`)
    return { exitCode: editGateRes.exitCode ?? EXIT.FACT }
  }

  const hasDevReview = hasSkillSupport(roots.mainRoot, 'dev-review')
  const untrustedGate = checkUntrustedPrGate(ledger, { humanApproved: Boolean(opts['human-approved'] || opts['human-approved-exec']), hasDevReview })
  if (untrustedGate.blocked) {
    await emitFlowSignal(roots, { category: 'security', module: 'workflow', pattern: 'verify.untrusted-blocked', severity: 'high', source: 'flow-verify', message: untrustedGate.message, taskId })
    if (opts.json) process.stdout.write(`${JSON.stringify(untrustedGate, null, 2)}\n`)
    process.stderr.write(`${untrustedGate.message}\n`)
    return { exitCode: untrustedGate.exitCode ?? EXIT.FACT }
  }

  const vPrdRel = ledger.prdFile ?? ledger.archivedPrdFile ?? findStrictDocBySlug(implRoot, 'docs/prd', ledger)
  if (vPrdRel) {
    const vSpecRel = ledger.specFile ?? ledger.archivedSpecFile ?? findStrictDocBySlug(implRoot, 'docs/specs', ledger)
    const vTodoRel = ledger.todoFile ?? ledger.archivedTodoFile ?? findStrictDocBySlug(implRoot, 'docs/todo', ledger)
    const prdGateV = evaluateFlowMasterPrdGate(implRoot, {
      prdRel: vPrdRel, specRel: vSpecRel, todoRel: vTodoRel, ledger, isVerify: true, taskId,
    })
    if (prdGateV.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(prdGateV, [prdGateV.nextStep], { repoRoot: roots.mainRoot }), null, 2)}\n`)
      process.stderr.write(`${prdGateV.message}\n`)
      printNextStep([prdGateV.nextStep], { repoRoot: roots.mainRoot })
      return { exitCode: prdGateV.exitCode }
    }
  }

  const profile = parseAgentsProfile(implRoot)

  const op = await detectInProgressGitOp(implRoot, { wtGitDir: resolveGitDirFast(implRoot) })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突再执行 verify`)

  if (Number(ledger.caseType) === 2) {
    const snapC2 = await collectTaskRuntimeSnapshot({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, ledger, profile, hasDevReview, evaluateNext: false })
    const c2Drift = await checkCase2StructuralDriftOnVerify({
      mainRoot: roots.mainRoot, implRoot, ledger, opts,
      effectiveBase: snapC2.effectiveBaseSha, changedFiles: snapC2.changedFiles, statusEntries: snapC2.statusEntries, diffText: snapC2.diffText,
    })
    if (!c2Drift.ok) {
      if (opts.json) process.stdout.write(`${JSON.stringify(c2Drift, null, 2)}\n`)
      process.stderr.write(`${c2Drift.message}\n`)
      return { exitCode: c2Drift.exitCode ?? EXIT.ACTION }
    }
  }

  const keyByMode = { quick: 'quick-test', smoke: 'smoke-verify', full: 'full-test', gate: 'merge-gate' }
  const profileKey = keyByMode[mode]
  const isExplicitNone = !opts.cmd && isProfileExplicitNone(profile, profileKey)

  let cmd = opts.cmd
  if (!cmd && !isExplicitNone) cmd = resolveTierCommand(profile, mode, { fallback: true })

  const computeVerifyPolicy = async () => {
    const snap = await collectTaskRuntimeSnapshot({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, ledger, profile, hasDevReview, evaluateNext: false })
    const dirty = snap.dirty > 0
    return {
      currentHead: snap.headSha, dirty,
      stStdout: (snap.statusEntries ?? []).map((e) => `${e.xy} ${e.file}`).join('\n'),
      changedFiles: snap.changedFiles, policy: snap.policy, diffText: !dirty ? snap.diffText : undefined,
    }
  }

  const e2eEvidenceInput = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || ''
  const artifactsInput = normalizeArtifactList(opts.artifact)
  const visualCheckedRawInput = Boolean(opts['visual-checked'])
  const visualBlockedReasonInput = typeof opts['visual-blocked-reason'] === 'string' ? opts['visual-blocked-reason'].trim() : ''
  const hasVisualCheckFlag = Boolean(visualCheckedRawInput || opts['visual-evidence'] || opts['e2e-evidence'] || artifactsInput.length > 0 || visualBlockedReasonInput)

  if (!cmd && isExplicitNone) {
    const { currentHead, dirty, stStdout, changedFiles, policy, diffText } = await computeVerifyPolicy()
    const docStaticRes = policy.staticDocCheckRequired ? runLowRiskDocStaticCheck(implRoot, changedFiles, { diffText }) : null
    const docOk = !docStaticRes || docStaticRes.ok
    const evRec = recordVerifyEvidenceForFlow({
      roots, implRoot, taskId, ledger, profileKey, currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
      cmdStr: 'none (explicitly disabled)', customCmd: false, exitCode: EXIT.OK,
      explicitNoneSkipped: true, docStaticRes, inner: sbVerify.inner,
      e2eObservationText: e2eEvidenceInput,
      artifacts: artifactsInput,
      visualCheckedRaw: visualCheckedRawInput,
      visualBlockedReason: visualBlockedReasonInput,
    })
    if (evRec.precheck?.blocked) {
      return handleVerifyPrecheckBlock({ opts, roots, taskId, mode, ledger, evRec, finalExit: evRec.overallExit || EXIT.FACT })
    }
    const allOk = docOk && evRec.overallExit === 0
    ledger.verifiedHead = allOk ? currentHead : null
    ledger.verifiedCmd = 'none (explicitly disabled)'
    ledger.verifiedMode = mode
    ledger.verifiedTarget = rawTarget
    ledger.verifiedDirtyHash = sha256Text(stStdout)
    ledger.lastVerifyExitCode = allOk ? 0 : (evRec.overallExit || EXIT.FACT)
    ledger.visualFilesChanged = policy.visualFilesChanged
    ledger.empiricalVisualCheckRequired = policy.visualFilesChanged.length > 0
    if (allOk && hasVisualCheckFlag) {
      ledger.visualVerifiedHead = currentHead
      const priorEvidence = typeof ledger.visualCheckEvidence === 'string' ? ledger.visualCheckEvidence.trim() : ''
      ledger.visualCheckEvidence = e2eEvidenceInput || priorEvidence || null
    }
    ledger.status = sbVerify.nextStatus(allOk, dirty)
    const governRes = await runLifecycleGovernHook({ stage: 'verify', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
    if (!governRes.ok) {
      ledger.verifiedHead = null
      ledger.status = 'verify-failed'
      await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
      if (opts.json) process.stdout.write(`${JSON.stringify(governRes, null, 2)}\n`)
      process.stderr.write(`${governRes.message}\n`)
      return { exitCode: governRes.exitCode ?? EXIT.FACT }
    }
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    await emitFlowSignal(roots, { category: allOk ? 'tests' : 'docs', module: 'workflow', pattern: allOk ? `verify.${mode}.pass` : `verify.${mode}.doc-static-fail`, severity: docOk ? 'info' : 'medium', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? '', taskId, message: allOk ? `verify (${mode}) explicit-none pass` : `verify (${mode}) explicit-none failed` })
    if (!docOk) {
      const msg = `BLOCKED_STATIC_DOC_CHECK_FAILED: 无 CI 低风险静态必检未通过：${docStaticRes.errors.map((e) => e.message).slice(0, 3).join('；')}`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'BLOCKED_STATIC_DOC_CHECK_FAILED', errors: docStaticRes.errors }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    if (!allOk) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, taskId, mode, code: evRec.shallowE2eEvidence?.code ?? 'BLOCKED_VERIFY_EVIDENCE', exitCode: evRec.overallExit || EXIT.FACT, reason: evRec.shallowE2eEvidence?.reason ?? null }, null, 2)}\n`)
      return { exitCode: evRec.overallExit || EXIT.FACT }
    }
    const submitAgent = formatAgentCliArg(ledger.claimedBy ?? ledger.implementerId ?? '<id>')
    const explicitNoneNext = [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --agent ${submitAgent}` }]
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, mode, cmd: ledger.verifiedCmd, skippedReason: 'explicit-none', ok: true, exitCode: EXIT.OK, verifiedHead: currentHead, riskTier: policy.riskTier, docStatic: docStaticRes }, explicitNoneNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    } else {
      process.stdout.write(`verify (${mode}): AGENTS.md Dev Profile 显式配置 \`${profileKey}: none\`，已放行并绑定 HEAD=${currentHead ?? 'unborn'}\n`)
      printNextStep(explicitNoneNext, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  let reusedSmokeGate = null
  let preRunSnap = null
  if (mode === 'smoke' && !opts.cmd && !rawTarget && hasVisualCheckFlag) {
    preRunSnap = await computeVerifyPolicy()
    const prevEv = readVerificationEvidence(roots.gitDir, taskId)
    if (prevEv && prevEv.headSha === preRunSnap.currentHead && !preRunSnap.dirty && !prevEv.dirty && prevEv.gates?.smoke?.exitCode === 0 && prevEv.smokeVerifiedOnHead) {
      reusedSmokeGate = prevEv.gates.smoke
    }
  }

  if (!cmd && !reusedSmokeGate) {
    if (mode === 'smoke' && !isExplicitNone) {
      const { policy } = preRunSnap ?? await computeVerifyPolicy()
      if (policy.smokeRequired) {
        await emitFlowSignal(roots, { category: 'e2e', module: 'workflow', pattern: 'verify.smoke.unconfigured', severity: 'medium', source: 'flow-verify', message: 'unconfigured smoke-verify for runtime changes', taskId })
        process.stderr.write('BLOCKED_SMOKE_VERIFY_UNCONFIGURED: 运行时改动且 Dev Profile 未配置真实 smoke-verify 命令也未显式写 smoke-verify: none（Q3）；请在 AGENTS.md 补齐 smoke-verify，或通过 --cmd "<命令>" --e2e-evidence "<运行观察>" 传入。\n')
        return { exitCode: EXIT.FACT }
      }
    }
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.no-cmd`, severity: 'medium', source: 'flow-verify', message: `no verify command for ${mode}`, taskId })
    process.stderr.write(`NO_VERIFY_COMMAND: 未从 AGENTS.md Dev Profile 或项目清单识别到 ${mode} 验证命令，请通过 --cmd "<命令>" 显式传入（纯文档仓请配 \`${profileKey}: none\`）。\n`)
    return { exitCode: EXIT.ACTION }
  }
  if (!reusedSmokeGate && (mode === 'full' || mode === 'gate') && !profile.smokeVerify && !isProfileExplicitNone(profile, 'smoke-verify') && !opts.cmd && !e2eEvidenceInput) {
    const pre = preRunSnap ?? await computeVerifyPolicy()
    preRunSnap = pre
    const prevEv = readVerificationEvidence(roots.gitDir, taskId)
    const alreadySmokeOk = Boolean(prevEv && prevEv.headSha === pre.currentHead && !pre.dirty && prevEv.gates?.smoke?.exitCode === 0 && prevEv.smokeVerifiedOnHead)
    if (pre.policy.smokeRequired && !alreadySmokeOk) {
      await emitFlowSignal(roots, { category: 'e2e', module: 'workflow', pattern: 'verify.smoke.unconfigured', severity: 'medium', source: 'flow-verify', message: `blocked ${mode}: unconfigured smoke-verify`, taskId })
      process.stderr.write(`BLOCKED_SMOKE_VERIFY_UNCONFIGURED: 运行时改动禁止在既无 smoke-verify 命令又未声明 smoke-verify: none 且无 --cmd/--e2e-evidence 时以 ${mode} 放行（Q3）；请在 AGENTS.md 补齐 smoke-verify，或传 --cmd "<命令>" --e2e-evidence "<运行观察>"。\n`)
      return { exitCode: EXIT.FACT }
    }
  }

  let targetTip = null
  if (reusedSmokeGate) {
    cmd = reusedSmokeGate.cmd ?? (cmd || 'smoke (reused-on-head)')
  } else if (cmd.includes('{target}')) {
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
  const hasSharedNodeModules = roots.mainRoot !== implRoot && (
    ledger.depsMode === 'shared'
    || (Array.isArray(ledger.mountedDeps) && ledger.mountedDeps.some((p) => /(?:^|\/)node_modules$/.test(String(p))))
    || (() => { try { return lstatSync(join(implRoot, 'node_modules')).isSymbolicLink() } catch { return false } })()
  )
  const envForCmd = (cmdStr) => (hasSharedNodeModules && /\bpnpm\b/i.test(String(cmdStr ?? ''))
    ? { ...wtEnv, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' }
    : wtEnv)
  const prePolicySnap = preRunSnap ?? await computeVerifyPolicy()
  const preRunPrecheck = runVerifyPrecheck({
    repoRoot: implRoot, gitCommonDir: roots.gitDir, headSha: prePolicySnap.currentHead, policy: prePolicySnap.policy,
    taskId, dirty: prePolicySnap.dirty, mode, exitCode: 0,
    artifacts: artifactsInput, visualCheckedRaw: visualCheckedRawInput, visualBlockedReason: visualBlockedReasonInput, observationSummary: e2eEvidenceInput,
  })
  if (preRunPrecheck?.blocked) {
    const preMsg = `${preRunPrecheck.code ?? 'BLOCKED_VERIFY_PRECHECK'}: ${preRunPrecheck.reason ?? preRunPrecheck.message ?? '实证前置校验未通过'}`
    process.stderr.write(`${preMsg}\n`)
    return handleVerifyPrecheckBlock({ opts, roots, taskId, mode, ledger, evRec: { precheck: preRunPrecheck }, finalExit: preRunPrecheck.exitCode ?? EXIT.FACT })
  }
  const tRunStart = Date.now()
  const runRes = reusedSmokeGate
    ? { ok: true, code: 0, stdout: '', stderr: '' }
    : await execShellCommand(cmd, implRoot, { timeout: timeoutMs, env: envForCmd(cmd) })
  const runDurationMs = reusedSmokeGate ? (reusedSmokeGate.durationMs ?? 0) : (Date.now() - tRunStart)
  const { currentHead, dirty, stStdout, changedFiles, policy, diffText } = reusedSmokeGate
    ? prePolicySnap
    : await computeVerifyPolicy()
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
        smokeRunRes = await execShellCommand(profile.smokeVerify, implRoot, { timeout: timeoutMs, env: envForCmd(profile.smokeVerify) })
        smokeDurationMs = Date.now() - tSmokeStart
        smokeExecuted = true
      }
    }
  }
  const docStaticRes = runRes.ok && (!smokeRunRes || smokeRunRes.ok) && policy.staticDocCheckRequired
    ? runLowRiskDocStaticCheck(implRoot, changedFiles, { diffText })
    : null
  const execOk = runRes.ok && (!smokeRunRes || smokeRunRes.ok)
  const allOk = execOk && (!docStaticRes || docStaticRes.ok)
  const evRec = recordVerifyEvidenceForFlow({
    roots, implRoot, taskId, ledger, profileKey, currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
    cmdStr: cmd, customCmd: reusedSmokeGate ? Boolean(reusedSmokeGate.customCmd) : Boolean(opts.cmd), exitCode: runRes.code,
    explicitNoneSkipped: false, docStaticRes, executed: true, errorOnly: false, inner: sbVerify.inner,
    e2eObservationText: e2eEvidenceInput, durationMs: runDurationMs, smokeDurationMs,
    smokeCmd: smokeCmdUsed, smokeExitCode: smokeRunRes?.code ?? null, smokeExecuted, smokeErrorOnly: false,
    artifacts: artifactsInput,
    visualCheckedRaw: visualCheckedRawInput,
    visualBlockedReason: visualBlockedReasonInput,
    precheckResult: preRunPrecheck,
  })
  const finalExit = !execOk && runRes.ok && smokeRunRes && !smokeRunRes.ok ? (smokeRunRes.code || 1) : evRec.overallExit
  // 前置预检拦下时，实证已经写不进去，剩下的 ledger 收尾与输出都按「未通过」走。
  if (evRec.precheck?.blocked) {
    return handleVerifyPrecheckBlock({ opts, roots, taskId, mode, ledger, evRec, finalExit })
  }
  let e2eFailureReport = null
  if ((mode === 'smoke' || smokeExecuted) && smokeRunRes && !smokeRunRes.ok) {
    e2eFailureReport = await handleVerifyE2eFailure({
      roots, implRoot, taskId, ledger, mode: smokeExecuted ? 'smoke' : mode,
      cmd: smokeCmdUsed ?? cmd, runRes: smokeRunRes, currentHead, changedFiles, opts,
    })
  }
  if (allOk && roots.gitDir && artifactsInput.length > 0) {
    await stageAndSyncTaskArtifacts({
      repoRoot: implRoot, gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot, taskId,
      evidencePath: verificationEvidencePath(roots.gitDir, taskId),
      records: readVerificationEvidence(roots.gitDir, taskId)?.artifacts ?? [],
      artifacts: artifactsInput, backend: null, observationSummary: e2eEvidenceInput,
    }).catch(() => null)
  }
  const visualFilesChanged = policy.visualFilesChanged
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0

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
    const priorEvidence = typeof ledger.visualCheckEvidence === 'string' ? ledger.visualCheckEvidence.trim() : ''
    ledger.visualCheckEvidence = e2eEvidenceInput || priorEvidence || null
  }
  ledger.status = sbVerify.nextStatus(allOk, dirty)
  const governRes = isQuickTargetIter
    ? { ok: true, skipped: true, reason: 'quick-target-iter' }
    : await runLifecycleGovernHook({ stage: 'verify', mainRoot: roots.mainRoot, implRoot, taskId, ledger, opts })
  if (!governRes.ok) {
    ledger.verifiedHead = null
    ledger.status = 'verify-failed'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify(governRes, null, 2)}\n`)
    process.stderr.write(`${governRes.message}\n`)
    return { exitCode: governRes.exitCode ?? EXIT.FACT }
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: allOk ? `verify.${mode}.pass` : `verify.${mode}.fail`, severity: allOk ? 'info' : 'high', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? pickSignalBlameFile(changedFiles, ''), taskId, message: `verify (${mode}) exit=${finalExit}: ${redactDiagnosticText(cmd, 240)}`, meta: { riskTier: policy.riskTier, target: rawTarget } })
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
  const slotOk = checkTaskSlotBoundaryOrEmit(roots.mainRoot, implRoot, ledger, opts)
  if (!slotOk.ok) return { exitCode: slotOk.exitCode }
  const sbGuard = guardSandboxPreSubmitOrFinalize(ledger, opts, 'submit')
  if (!sbGuard.ok) return { exitCode: sbGuard.exitCode }

  const op = await detectInProgressGitOp(implRoot, { wtGitDir: resolveGitDirFast(implRoot) })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)

  const ownRes = assertSubmitOwnership(ledger, opts, { mainRoot: roots.mainRoot, docRoot: implRoot })
  if (!ownRes.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: ownRes.code, reason: ownRes.message }, null, 2)}\n`)
    process.stderr.write(`${ownRes.message}\n`)
    return { exitCode: ownRes.exitCode ?? EXIT.FACT }
  }

  const fastHeadOid = readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null
  const [headRes, stZ] = await Promise.all([
    fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
    gitStatusPorcelainZ(implRoot),
  ])

  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 存在未提交改动，请先提交后再运行 verify 与 submit。\n')
    return { exitCode: EXIT.FACT }
  }

  const needsFinalize = ledger.caseType === 3 || ledger.caseType === 4 || Boolean(ledger.todoFile) || Boolean(ledger.specFile)
  if (needsFinalize) {
    if (!ledger.finalized) {
      process.stderr.write(`BLOCKED_NOT_FINALIZED: Case ${ledger.caseType} 任务必须先执行 flow.mjs finalize --task ${taskId} 完成文档同步锁。\n`)
      return { exitCode: EXIT.FACT }
    }
    if (ledger.finalizedHead && currentHead && ledger.finalizedHead !== currentHead) {
      const postFin = await gitDiffNameStatusZ(implRoot, [`${ledger.finalizedHead}..${currentHead}`])
      const nonDocChanges = postFin.entries.map((e) => e.file).filter((f) => f && !/^docs\//.test(f))
      if (nonDocChanges.length > 0) {
        process.stderr.write(`BLOCKED_STALE_FINALIZE: finalize 之后又改了非文档文件（${nonDocChanges.join(', ')}），请重新运行 finalize。\n`)
        return { exitCode: EXIT.FACT }
      }
    }
  }

  const criteriaDrift = checkFrozenCriteria(ledger, implRoot)
  if (criteriaDrift.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_CRITERIA_DRIFT', reason: criteriaDrift.message }, null, 2)}\n`)
    process.stderr.write(criteriaDrift.message)
    return { exitCode: EXIT.ACTION }
  }

  if (ledger.lastVerifyExitCode !== 0 || (currentHead && ledger.verifiedHead !== currentHead)) {
    if (!ledger.verifiedHead) {
      process.stderr.write(`BLOCKED_NOT_VERIFIED: 提交前必须先运行并通过 flow.mjs verify --task ${taskId}。\n`)
    } else {
      process.stderr.write(`BLOCKED_STALE_VERIFICATION: 代码已变更（verifiedHead=${String(ledger.verifiedHead).slice(0, 7)} !== HEAD=${currentHead?.slice(0, 7)}），必须重跑 verify。\n`)
    }
    return { exitCode: EXIT.FACT }
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
    visualFilesChanged: changedForVisual.filter((f) => isUiVisualFile(f, { repoRoot: implRoot })), profile, hasDevReview, repoRoot: implRoot,
  })
  if (ledger.planning === true || ledger.status === 'planning') {
    const unlockCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskId}`
    const msg = `BLOCKED_PLAN_NOT_READY: 任务 ${taskId} 仍处于规划阶段（planning），请先批准规划并运行 flow.mjs start --task ${taskId} 转入实施后再提交。`
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(withNextSteps({ ok: false, blocked: true, code: 'BLOCKED_PLAN_NOT_READY', taskId, reason: msg, nextStep: unlockCmd }, [{ skill: 'dev-flow', text: unlockCmd }], { repoRoot: roots.mainRoot }), null, 2)}\n`)
    }
    process.stderr.write(`${msg}\n`)
    if (!opts.json) printNextStep([{ skill: 'dev-flow', text: unlockCmd }], { repoRoot: roots.mainRoot })
    return { exitCode: EXIT.FACT }
  }
  const evidence = readVerificationEvidence(roots.gitDir, taskId)
  const evCheck = validateVerificationEvidence({ policy, evidence, headSha: currentHead, profile })
  if (!evCheck.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: evCheck.code, reason: evCheck.reason, policy }, null, 2)}\n`)
    process.stderr.write(`${evCheck.code}: ${evCheck.reason}\n`)
    return { exitCode: evCheck.exitCode ?? EXIT.FACT }
  }

  const visualFilesChanged = policy.visualFilesChanged
  ledger.visualFilesChanged = visualFilesChanged
  ledger.empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const visualVerifiedOnHead = ledger.empiricalVisualCheckRequired && ledger.visualVerifiedHead === currentHead

  if (ledger.role === 'clone-readonly') {
    process.stderr.write('BLOCKED_CLONE_READONLY: 当前身份为只读克隆，禁止推送；请先走 Fork 或本地模式。\n')
    return { exitCode: EXIT.FACT }
  }

  const reviewSlotSync = await syncReviewSlotForSubmit(roots, ledger, taskId, currentHead, { resetDirty: Boolean(opts['reset-review-slot']) })
  const nextRound = (ledger.rounds ?? []).length > 0 ? nextReviewRound(ledger) : 1
  const postLocalLifecycleComments = async ({ targetRepo = null, pushRemote = null, actionFallback }) => {
    if ((ledger.linkedIssues ?? []).length === 0) return
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId ?? 'none', targetRepo, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const submitLayers = resolveIdentityLayers({
      explicitAgent: opts.agent, ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId, ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const submitDisplay = formatAttribution({ ...submitLayers, capabilities: localBackend.capabilities })
    const submitActorId = submitLayers.agent || submitLayers.account || undefined
    const isReworkLocal = deriveReworkState(ledger).isRework
    const recentRebuts = (ledger.rebuts ?? []).slice(-3).map((r) => `${r.findingId}: ${r.reason}`).join('；')
    const { issueCommentBodyFor } = buildSubmitComments({
      isRework: isReworkLocal, round: nextRound, shortHead: currentHead?.slice(0, 7) ?? 'unknown', actorDisplay: submitDisplay,
      branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: null, linkedIssues: ledger.linkedIssues ?? [], recentRebuts,
    })
    const baseState = {
      taskId, action: isReworkLocal ? 'rework-submitted' : actionFallback, round: nextRound, headSha: currentHead,
      ...(submitLayers.account ? { account: submitLayers.account, verifiedPlatformLogin: submitLayers.verifiedPlatformLogin } : {}),
      ...(submitLayers.agent ? { agent: submitLayers.agent } : {}),
    }
    for (const iss of ledger.linkedIssues ?? []) {
      await localBackend.postComment({ taskId, number: iss, body: issueCommentBodyFor(iss), author: submitActorId, statePayload: baseState })
      if (typeof localBackend.syncStateLabel === 'function') await Promise.resolve(localBackend.syncStateLabel({ taskId, number: iss, state: 'in-review' })).catch(() => null)
    }
  }

  if (ledger.role === 'local-only') {
    const shortHead = currentHead?.slice(0, 7) ?? 'unknown'
    await postLocalLifecycleComments({ actionFallback: 'local-ready' })
    if (ledger.planBootstrap === true && (ledger.linkedIssues ?? []).length > 0) {
      const localBackend = createTaskBackend({
        role: ledger.role, providerId: ledger.providerId ?? 'none', targetRepo: null, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
      })
      await syncBootstrapMasterIssueArtifacts({
        backend: localBackend, targetRepo: null, linkedIssues: ledger.linkedIssues ?? [], ledger, changedFiles: changedForVisual,
      })
    }
    ledger.lastSubmittedHead = currentHead
    ledger.status = 'local-ready'
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const submitNext = buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview })
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ ...ledger, reviewSlotSync }, submitNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      process.stdout.write(`本地模式提交校验已通过（HEAD=${shortHead}，未配置远端不执行 push）。\n`)
      printNextStep(submitNext, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const fastRemoteCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastRemoteCfg ? { ok: true, stdout: fastRemoteCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const targetCtx = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology, { cwd: roots.mainRoot, providerHint: ledger.providerId })
  const { originFull, originLower, upstreamLower, targetRepo, pushRemote } = targetCtx

  if (ledger.role === 'contributor-fork' && originLower && upstreamLower && originLower === upstreamLower) {
    process.stderr.write('BLOCKED_FORK_REMOTE_LOCK: origin 与 upstream 指向相同仓，禁止直接向正本推送。\n')
    return { exitCode: EXIT.FACT }
  }

  const isGenericGit = ledger.role === 'generic-git' || targetCtx.capabilities?.api !== true || !targetRepo
  let deferredPush = Boolean(opts.offline && isGenericGit)
  let deferredPushReason = opts.offline ? '显式指定 --offline 离线审校' : null
  if (!deferredPush) {
    const pushRes = await gitRun(implRoot, ['push', '-u', pushRemote, ledger.branch])
    if (!pushRes.ok) {
      const errTxt = String(pushRes.stderr ?? '')
      const isNetworkDown = /(?:unable to access|could not resolve host|timed out|connection refused|handshake|ssl|tls|failed to connect|network is unreachable|repository .* not found)/i.test(errTxt)
      if (isGenericGit && isNetworkDown) {
        deferredPush = true
        deferredPushReason = errTxt.trim().split(/\r?\n/)[0].slice(0, 180)
      } else {
        throw new Error(`推送到 ${pushRemote}/${ledger.branch} 失败：${pushRes.stderr}`)
      }
    }
  }

  if (isGenericGit) {
    await postLocalLifecycleComments({ targetRepo, pushRemote, actionFallback: 'submitted' })
    if (ledger.planBootstrap === true && (ledger.linkedIssues ?? []).length > 0) {
      const genericBackend = createTaskBackend({
        role: ledger.role, providerId: ledger.providerId ?? 'none', targetRepo, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
      })
      await syncBootstrapMasterIssueArtifacts({
        backend: genericBackend, targetRepo, linkedIssues: ledger.linkedIssues ?? [], ledger, changedFiles: changedForVisual,
      })
    }
    ledger.lastSubmittedHead = currentHead
    ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
    ledger.deferredPush = deferredPush
    ledger.deferredPushReason = deferredPushReason
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const submitNext = buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview })
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, role: ledger.role, providerId: ledger.providerId, status: ledger.status, deferredPush, deferredPushReason, head: currentHead, pushRemote, reviewSlotSync }, submitNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      process.stdout.write(deferredPush
        ? `submit 完成（generic-git 离线/延迟推送模式：${deferredPushReason}，本地已就绪 @ ${currentHead?.slice(0, 7)}，合前须手工推送并在远端托管完成合并，随后执行 flow.mjs merge 现场取回核验）。\n`
        : `submit 完成：已推送至 ${pushRemote}/${ledger.branch} @ ${currentHead?.slice(0, 7)}（generic-git 模式跳过平台 API）。\n`)
      printNextStep(submitNext, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const effectiveProviderId = ledger.providerId && ledger.providerId !== 'none' ? ledger.providerId : targetCtx.providerId
  const backend = createTaskBackend({
    role: ledger.role, providerId: effectiveProviderId, targetRepo,
    client: opts._ghClient ?? ghProbe.client, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })
  let submitEvidence = evidence
  if (Array.isArray(submitEvidence?.artifacts) && submitEvidence.artifacts.length > 0) {
    const syncArt = await stageAndSyncTaskArtifacts({
      repoRoot: implRoot, gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot, taskId,
      evidencePath: roots.gitDir ? verificationEvidencePath(roots.gitDir, taskId) : null,
      records: submitEvidence.artifacts, backend, targetRepo,
      observationSummary: submitEvidence?.e2eObservation?.summary ?? submitEvidence?.visual?.observation ?? '',
    }).catch(() => null)
    if (syncArt?.records) submitEvidence = { ...submitEvidence, artifacts: syncArt.records }
  }
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
      return { exitCode: dup.exitCode ?? EXIT.FACT }
    }
  }
  if (!ledger.prNumber) {
    const openPrRes = await backend.findOpenPrForBranch({ repo: targetRepo, branch: ledger.branch, headOwner: ledger.role === 'contributor-fork' ? originOwner : undefined, base: ledger.baseBranch })
    if (openPrRes?.ok && Array.isArray(openPrRes.prs) && openPrRes.prs.length > 0) {
      const found = openPrRes.prs[0]
      ledger.prNumber = found.number
      ledger.prUrl = found.url ?? ledger.prUrl
      ledger.prState = found.state ?? 'OPEN'
    }
  }
  // 返工与否由账本推导：末轮退回且令牌已消费。不收开关，也不靠「有没有 PR 号」猜。
  const reworkState = deriveReworkState(ledger)
  // 「是不是返工」与「PR 在不在」是两件事：前者决定措辞，后者决定复用还是新建。混用一个变量就会出现「PR 明明在，却又建了一个」。
  const hasExistingPr = Boolean(ledger.prNumber)

  let prResult = null
  const commentResults = []
  const isRework = reworkState.isRework
  if (hasExistingPr) {
    const recentRebuts = (ledger.rebuts ?? []).slice(-3).map((r) => `${r.findingId}: ${r.reason}`).join('；')
    const { prCommentBody, issueCommentBodyFor } = buildSubmitComments({ isRework, isHeadUpdate: !isRework && hasExistingPr, round: nextRound, shortHead, actorDisplay: submitDisplay, branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: ledger.prNumber, linkedIssues: ledger.linkedIssues ?? [], recentRebuts })
    prResult = { reusedPr: ledger.prNumber, head: shortHead }
    const reuseAction = isRework ? 'rework-submitted' : 'submitted-existing-pr'
    commentResults.push({ target: `PR #${ledger.prNumber}`, res: await backend.postComment({ repo: targetRepo, number: ledger.prNumber, isPr: true, body: prCommentBody, statePayload: { taskId, action: reuseAction, round: nextRound, ...submitStateIdentity, headSha: currentHead } }) })
    for (const iss of ledger.linkedIssues ?? []) {
      commentResults.push({ target: `Issue #${iss}`, res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: reuseAction, round: nextRound, ...submitStateIdentity, prNumber: ledger.prNumber, headSha: currentHead } }) })
    }
    await applySubmitPostActions({ backend, targetRepo, prNumber: ledger.prNumber, linkedIssues: ledger.linkedIssues ?? [], ledger, roots, isRework })
  } else {
    const { title, titleSource } = resolveReadablePrTitleWithSource(implRoot, ledger, opts.title)
    ledger.prTitleSource = titleSource
    const body = hydratePrTemplateBody({ repoRoot: implRoot, taskId, ledger, policy, evidence: submitEvidence, actorDisplay: submitDisplay, implementerDisplay: submitDisplay, visualFilesChanged, visualVerifiedOnHead, currentHead, changedFiles: changedForVisual })
    prResult = await backend.createPr({ targetRepo, head: headSpec, base: ledger.baseBranch, title, body, draft: Boolean(opts.draft) })
    if (prResult.ok && prResult.number) {
      ledger.prNumber = prResult.number
      ledger.prUrl = prResult.url ?? null
      ledger.prState = 'OPEN'
      const { issueCommentBodyFor } = buildSubmitComments({ isRework: false, round: 1, shortHead, actorDisplay: submitDisplay, branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: prResult.number, prUrl: prResult.url, linkedIssues: ledger.linkedIssues ?? [] })
      for (const iss of ledger.linkedIssues ?? []) {
        commentResults.push({ target: `Issue #${iss}`, res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: 'pr-created', ...submitStateIdentity, prNumber: prResult.number, headSha: currentHead } }) })
      }
      await applySubmitPostActions({ backend, targetRepo, prNumber: prResult.number, linkedIssues: ledger.linkedIssues ?? [], ledger, roots, isRework: false })
    }
  }

  if (ledger.planBootstrap === true && (ledger.linkedIssues ?? []).length > 0) {
    await syncBootstrapMasterIssueArtifacts({
      backend, targetRepo, linkedIssues: ledger.linkedIssues ?? [], ledger, changedFiles: changedForVisual,
    })
  }

  ledger.lastSubmittedHead = currentHead
  ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  const submitNext = buildSubmitNextSteps({ taskId, role: ledger.role, policy, nextRound, hasDevReview })
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, role: ledger.role, status: ledger.status, head: currentHead, prResult, commentResults, reviewSlotSync }, submitNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write(`submit 完成：已推分支 ${pushRemote}/${ledger.branch} @ ${shortHead}，状态=${ledger.status}\n`)
    if (prResult?.oneClickPrUrl) process.stdout.write(`- 一键创建 PR 链接：${prResult.oneClickPrUrl}\n`)
    if (prResult?.delegated) process.stdout.write(`- 待宿主 MCP 代理执行 PR 载荷：${JSON.stringify(prResult.jsonPayload)}\n`)
    printNextStep(submitNext, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
