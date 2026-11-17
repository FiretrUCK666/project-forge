/**
 * review-empirical.mjs -- Empirical-first & two-phase fault-injection state machine
 * gating `--include-diff` across --task, --pr, --local, --staged, and --base modes.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { printNextStep } from '../../lib/cli.mjs'
import { computeWorktreeEnv, posixPath } from '../../lib/git.mjs'
import { determineWorkflowPolicy } from '../../lib/workflow-policy.mjs'
import { EXIT } from './review-diff.mjs'
import {
  buildModeTargetFlags, buildUnblockCommands, checkDirtyFaultResidueBeforeSync,
  checkUntrustedBeforeExec, computeCleanBaselineFingerprint, computeWorkspaceFingerprint,
  emitGateBlock, getEffectiveStatusEntries, hasPendingFaultInReceipt,
  isSameScopeContext, readReceipt, recordMechanicalPack, resolveEmpiricalReceiptPath,
  runCommandList, writeReceipt,
} from './review-empirical-state.mjs'

export {
  checkDirtyFaultResidueBeforeSync,
  computeWorkspaceFingerprint,
  emitGateBlock,
  getEffectiveStatusEntries,
  recordMechanicalPack,
}

function sanitizeCmdTemplate(rawCmd) {
  return String(rawCmd ?? '')
    .replace(/\s*(?:--[A-Za-z0-9_-]+(?:=|\s+)|-[A-Za-z]\s+)?\{target\}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function collectDevProfileEmpiricalCmds(devProfile = {}) {
  const auto = []
  for (const key of ['quick-test', 'smoke-verify', 'full-test']) {
    for (const raw of devProfile[key] ?? []) {
      const clean = sanitizeCmdTemplate(raw)
      if (clean && !auto.includes(clean)) auto.push(clean)
    }
  }
  const mergeCmds = []
  for (const raw of devProfile['merge-gate'] ?? []) {
    const clean = sanitizeCmdTemplate(raw)
    if (clean && !mergeCmds.includes(clean)) mergeCmds.push(clean)
  }
  const effectiveAuto = auto.length > 0 ? auto : mergeCmds
  const allTestCmds = [...new Set([...effectiveAuto, ...mergeCmds])]
  return { autoCommands: effectiveAuto, hasDevProfileTestCmds: allTestCmds.length > 0 }
}

export function computeEmpiricalRequirements({
  diff, behavioralGate, effectiveProfile, task, gateWeakenedHits = [],
}) {
  const allFiles = [...new Set([...(diff?.files ?? []).map((f) => f.file), ...(diff?.untracked ?? [])])]
  const isEmptyDiff = allFiles.length === 0
  const ownArchived = [
    task?.archivedTodoFile, task?.archivedSpecFile, task?.archivedPrdFile,
    ...(task?.todoFile?.startsWith('docs/archive/') ? [task.todoFile] : []),
    ...(task?.specFile?.startsWith('docs/archive/') ? [task.specFile] : []),
    ...(task?.prdFile?.startsWith('docs/archive/') ? [task.prdFile] : []),
  ].filter(Boolean)

  const policy = determineWorkflowPolicy({
    changedFiles: allFiles,
    ownArchived,
    caseType: task?.caseType ?? 3,
    highRiskGlobs: effectiveProfile?.['high-risk'] ?? [],
    doNotEditGlobs: effectiveProfile?.['do-not-edit'] ?? [],
    gateWeakeningHits: gateWeakenedHits,
    visualFilesChanged: behavioralGate?.visualFilesChanged ?? [],
    diffBytes: diff?.bytes ?? 0,
  })
  const { autoCommands, hasDevProfileTestCmds } = collectDevProfileEmpiricalCmds(effectiveProfile)
  const runtimeTouched = (behavioralGate?.runtimeFilesTouched?.length ?? 0) > 0
  const smokeRequired = Boolean(behavioralGate?.smokeRequired)
  const isLowRiskPureDoc = !isEmptyDiff && policy.riskTier === 'low'

  const empiricalRequired = !isEmptyDiff
  const faultRequired = !isEmptyDiff && (runtimeTouched || smokeRequired || hasDevProfileTestCmds || !isLowRiskPureDoc)
  const visualCheckRequired = !isEmptyDiff && Boolean(behavioralGate?.empiricalVisualCheckRequired)

  return {
    isEmptyDiff,
    isLowRiskPureDoc,
    riskTier: policy.riskTier,
    autoCommands,
    hasDevProfileTestCmds,
    empiricalRequired,
    faultRequired,
    visualCheckRequired,
  }
}

export function evaluateIncludeDiffGate({
  gitDir, mode, task, round, prNo, baseRef, reviewRoot, mainRoot,
  headSha, diffScope, workspaceFingerprint, dirtyEntries = [],
  requirements, behavioralGate, opts = {},
}) {
  if (requirements.isEmptyDiff) {
    return {
      required: false,
      faultRequired: false,
      visualCheckRequired: false,
      readyForDiff: true,
      dirtyFaultResidue: false,
      mode,
      round,
      targetRoot: posixPath(reviewRoot),
      headSha,
      diffScope,
      workspaceFingerprint,
      steps: {
        mechanicalPack: { done: true },
        empirical: { done: true, status: 'empty-diff' },
        faultFail: { done: true },
        faultRestore: { done: true },
        visualCheck: { required: false, done: true },
      },
      missingSteps: [],
      unblockCommands: [],
      nextSteps: [],
    }
  }

  const receiptPath = resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot, baseRef })
  const receipt = readReceipt(receiptPath)
  const sameScope = isSameScopeContext(receipt, { mode, round, headSha, diffScope })
  const matchesBaseline = Boolean(sameScope && receipt.baselineFingerprint === workspaceFingerprint)

  const dirtyFaultResidue = hasPendingFaultInReceipt(receipt, {
    mode, round, headSha, diffScope, currentFingerprint: workspaceFingerprint,
  }) || ((mode === 'task' || mode === 'pr') && dirtyEntries.length > 0)

  const mechanicalDone = Boolean(matchesBaseline && receipt.mechanicalPackSeen === true)
  const empiricalDone = Boolean(
    matchesBaseline
    && receipt.empiricalVerified
    && receipt.empiricalVerified.fingerprint === workspaceFingerprint
    && receipt.empiricalVerified.headSha === headSha
    && receipt.empiricalVerified.diffScope === diffScope
    && (mode !== 'task' || Number(receipt.empiricalVerified.round) === Number(round)),
  )
  const faultFailDone = !requirements.faultRequired || Boolean(
    matchesBaseline
    && receipt.faultInjectedAndFailed
    && receipt.faultInjectedAndFailed.baselineFingerprint === workspaceFingerprint,
  )
  const faultRestoreDone = !requirements.faultRequired || Boolean(
    matchesBaseline
    && receipt.faultRestoredClean === true
    && receipt.faultRestoredMeta?.fingerprint === workspaceFingerprint,
  )
  const visualDone = !requirements.visualCheckRequired || Boolean(
    behavioralGate?.visualVerifiedOnHead
    || opts['visual-checked']
    || (matchesBaseline && (receipt?.empiricalVerified?.visualChecked || receipt?.visualChecked)),
  )

  const missingSteps = []
  if (!mechanicalDone) missingSteps.push('mechanical-pack')
  if (!empiricalDone) missingSteps.push('check-empirical')
  if (requirements.faultRequired && !faultFailDone) missingSteps.push('check-fault:fail')
  if (requirements.faultRequired && !faultRestoreDone) missingSteps.push('check-fault:restore')
  if (requirements.visualCheckRequired && !visualDone) missingSteps.push('visual-check')

  const readyForDiff = !dirtyFaultResidue && missingSteps.length === 0
  const unblockCommands = readyForDiff
    ? []
    : buildUnblockCommands({
        missingSteps,
        dirtyFaultResidue,
        mode,
        task,
        round,
        prNo,
        baseRef,
        reviewRoot,
        mainRoot,
        autoCommands: requirements.autoCommands,
      })

  return {
    required: requirements.empiricalRequired,
    faultRequired: requirements.faultRequired,
    visualCheckRequired: requirements.visualCheckRequired,
    readyForDiff,
    dirtyFaultResidue,
    mode,
    round,
    targetRoot: posixPath(reviewRoot),
    headSha,
    diffScope,
    workspaceFingerprint,
    baselineFingerprint: matchesBaseline ? receipt.baselineFingerprint : null,
    steps: {
      mechanicalPack: { done: mechanicalDone, at: mechanicalDone ? receipt.mechanicalPackAt : null },
      empirical: {
        done: empiricalDone,
        status: empiricalDone ? (receipt.empiricalVerified.status ?? 'passed') : 'pending',
        commands: empiricalDone ? (receipt.empiricalVerified.commands ?? []) : [],
        at: empiricalDone ? receipt.empiricalVerified.verifiedAt : null,
      },
      faultFail: {
        done: faultFailDone,
        required: requirements.faultRequired,
        failedCmd: faultFailDone && receipt?.faultInjectedAndFailed ? receipt.faultInjectedAndFailed.failedCmd : null,
        exitCode: faultFailDone && receipt?.faultInjectedAndFailed ? receipt.faultInjectedAndFailed.exitCode : null,
        at: faultFailDone && receipt?.faultInjectedAndFailed ? receipt.faultInjectedAndFailed.injectedAt : null,
      },
      faultRestore: {
        done: faultRestoreDone,
        required: requirements.faultRequired,
        at: faultRestoreDone ? receipt?.faultRestoredAt : null,
      },
      visualCheck: { required: requirements.visualCheckRequired, done: visualDone },
    },
    missingSteps,
    unblockCommands,
    nextSteps: unblockCommands,
  }
}

export async function handleCheckEmpirical(ctx) {
  const {
    opts, roots, mode, task, round, prNo, reviewRoot, headSha, diffScope,
    diff, effectiveProfile, behavioralGate, gateWeakenedHits, scanUntrustedDiff,
  } = ctx
  const { mainRoot, gitDir } = roots
  const receiptPath = resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot, baseRef: opts.base })
  const prev = readReceipt(receiptPath)

  const untrusted = checkUntrustedBeforeExec({
    opts, task, mode, headSha, prNo, receipt: prev, diff, reviewRoot, scanUntrustedDiff,
  })
  if (untrusted.blocked) {
    return emitGateBlock({ opts, code: 'BLOCKED_UNTRUSTED_HAZARD', payload: untrusted.payload, textLines: untrusted.textLines })
  }

  const dirtyEntries = await getEffectiveStatusEntries(reviewRoot, mainRoot)
  const currentFingerprint = await computeWorkspaceFingerprint({
    reviewRoot, mainRoot, headSha, diff, statusEntries: dirtyEntries,
  })
  const sameCtx = isSameScopeContext(prev, { mode, round, headSha, diffScope })
  const pendingFault = hasPendingFaultInReceipt(prev, {
    mode, round, headSha, diffScope, currentFingerprint,
  }) || ((mode === 'task' || mode === 'pr') && dirtyEntries.length > 0)

  if (pendingFault) {
    const msg = `BLOCKED_DIRTY_FAULT_RESIDUE: 审查工作位 ${posixPath(reviewRoot)} 存在未还原的故障注入残留，请先还原并运行 check-fault --phase restore。`
    return emitGateBlock({
      opts,
      code: 'BLOCKED_DIRTY_FAULT_RESIDUE',
      payload: {
        status: 'BLOCKED_DIRTY_FAULT_RESIDUE',
        code: 'BLOCKED_DIRTY_FAULT_RESIDUE',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        targetRoot: posixPath(reviewRoot),
        dirtyFiles: dirtyEntries.map((e) => e.file),
        error: msg,
      },
      textLines: ['BLOCKED_DIRTY_FAULT_RESIDUE', `Worktree : ${posixPath(reviewRoot)}`, `Reason   : ${msg}`],
    })
  }

  const requirements = computeEmpiricalRequirements({ diff, behavioralGate, effectiveProfile, task, gateWeakenedHits })
  const explicitCmds = (opts.cmd ?? []).map((s) => String(s).trim()).filter(Boolean)
  const commandsToRun = explicitCmds.length > 0 ? explicitCmds : requirements.autoCommands
  const targetFlags = buildModeTargetFlags({ mode, task, round, prNo, baseRef: opts.base, reviewRoot, mainRoot })

  if (commandsToRun.length === 0 && !requirements.isEmptyDiff && !requirements.isLowRiskPureDoc) {
    const msg = 'BLOCKED_EMPIRICAL_CMD_REQUIRED: 未配置 Dev Profile 测试命令且触及非低风险变更，必须通过 --cmd "<C* 证伪命令>" 实跑验证。'
    return emitGateBlock({
      opts,
      code: 'BLOCKED_EMPIRICAL_CMD_REQUIRED',
      payload: {
        status: 'BLOCKED_EMPIRICAL_CMD_REQUIRED',
        code: 'BLOCKED_EMPIRICAL_CMD_REQUIRED',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        headSha,
        workspaceFingerprint: currentFingerprint,
        nextSteps: [`node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags} --cmd "<验证命令>"`],
        error: msg,
      },
      textLines: ['BLOCKED_EMPIRICAL_CMD_REQUIRED', msg],
    })
  }

  let cmdResults = []
  let statusLabel = 'passed'
  let lowRiskNoRuntimeChecks = false
  if (commandsToRun.length === 0) {
    lowRiskNoRuntimeChecks = true
    statusLabel = requirements.isEmptyDiff ? 'empty-diff-no-checks' : 'low-risk-no-runtime-checks'
  } else {
    const wtEnv = computeWorktreeEnv({ mainRoot, gitDir, taskId: task?.taskId ?? mode, slotIndex: task?.slotIndex })
    cmdResults = await runCommandList(commandsToRun, { cwd: reviewRoot, env: wtEnv, stopOnFail: true })
    const failed = cmdResults.find((r) => !r.ok)
    if (failed) {
      const msg = `BLOCKED_EMPIRICAL_FAILED: 实证命令失败 (exit=${failed.exitCode}): ${failed.cmd}`
      return emitGateBlock({
        opts,
        code: 'BLOCKED_EMPIRICAL_FAILED',
        payload: {
          status: 'BLOCKED_EMPIRICAL_FAILED',
          code: 'BLOCKED_EMPIRICAL_FAILED',
          exitCode: EXIT.UNTRUSTED_HAZARD,
          mode,
          round,
          headSha,
          workspaceFingerprint: currentFingerprint,
          commands: cmdResults,
          error: msg,
        },
        textLines: [
          'BLOCKED_EMPIRICAL_FAILED',
          `Command  : ${failed.cmd} (exit=${failed.exitCode})`,
          ...(failed.stdoutExcerpt ? [`Stdout   : ${failed.stdoutExcerpt}`] : []),
          ...(failed.stderrExcerpt ? [`Stderr   : ${failed.stderrExcerpt}`] : []),
        ],
      })
    }
  }

  const keepMechanical = Boolean(sameCtx && prev?.baselineFingerprint === currentFingerprint && prev?.mechanicalPackSeen)
  const keepFault = Boolean(sameCtx && prev?.baselineFingerprint === currentFingerprint)
  const verifiedAt = new Date().toISOString()
  writeReceipt(receiptPath, {
    mode,
    round,
    prNo: prNo ?? null,
    headSha,
    diffScope,
    baselineFingerprint: currentFingerprint,
    untrustedScanClean: untrusted.scanClean ?? prev?.untrustedScanClean ?? null,
    humanApprovedExec: Boolean(untrusted.approved || prev?.humanApprovedExec),
    mechanicalPackSeen: keepMechanical,
    mechanicalPackAt: keepMechanical ? prev.mechanicalPackAt : null,
    empiricalVerified: {
      status: statusLabel,
      lowRiskNoRuntimeChecks,
      fingerprint: currentFingerprint,
      headSha,
      round,
      diffScope,
      commands: cmdResults,
      visualChecked: Boolean(opts['visual-checked']),
      verifiedAt,
    },
    faultInjectedAndFailed: keepFault ? (prev?.faultInjectedAndFailed ?? null) : null,
    faultRestoredClean: keepFault ? Boolean(prev?.faultRestoredClean) : false,
    faultRestoredAt: keepFault ? (prev?.faultRestoredAt ?? null) : null,
    faultRestoredMeta: keepFault ? (prev?.faultRestoredMeta ?? null) : null,
  })

  const gate = evaluateIncludeDiffGate({
    gitDir, mode, task, round, prNo, baseRef: opts.base, reviewRoot, mainRoot,
    headSha, diffScope, workspaceFingerprint: currentFingerprint, dirtyEntries,
    requirements, behavioralGate, opts,
  })
  const payload = {
    status: 'EMPIRICAL_VERIFIED',
    ok: true,
    mode,
    round,
    targetRoot: posixPath(reviewRoot),
    headSha,
    diffScope,
    workspaceFingerprint: currentFingerprint,
    baselineFingerprint: currentFingerprint,
    lowRiskNoRuntimeChecks,
    commands: cmdResults,
    empiricalGate: gate,
    nextSteps: gate.unblockCommands,
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write([
      'EMPIRICAL_VERIFIED',
      `Worktree : ${posixPath(reviewRoot)} | HEAD ${headSha.slice(0, 8)}`,
      `Mode     : ${mode}${mode === 'task' ? ` (Round ${round})` : ''} | Status: ${statusLabel}`,
      `Commands : ${cmdResults.length === 0 ? statusLabel : cmdResults.map((c) => `${c.cmd} (exit=${c.exitCode}, ${c.durationMs}ms)`).join('; ')}`,
    ].join('\n') + '\n')
    if (gate.unblockCommands.length > 0) printNextStep(gate.unblockCommands, { repoRoot: mainRoot })
  }
  return EXIT.OK
}

export async function handleCheckFault(ctx) {
  const {
    opts, roots, mode, task, round, prNo, reviewRoot, headSha, diffScope,
    diff, effectiveProfile, behavioralGate, gateWeakenedHits, scanUntrustedDiff,
  } = ctx
  const { mainRoot, gitDir } = roots
  const phase = String(opts.phase ?? '').trim().toLowerCase()
  if (phase !== 'fail' && phase !== 'restore') {
    process.stderr.write('Error: check-fault requires --phase fail|restore\n')
    return EXIT.USAGE_OR_POLICY
  }

  const receiptPath = resolveEmpiricalReceiptPath({ gitDir, mode, task, prNo, reviewRoot, baseRef: opts.base })
  const prev = readReceipt(receiptPath)
  const untrusted = checkUntrustedBeforeExec({
    opts, task, mode, headSha, prNo, receipt: prev, diff, reviewRoot, scanUntrustedDiff,
  })
  if (untrusted.blocked) {
    return emitGateBlock({ opts, code: 'BLOCKED_UNTRUSTED_HAZARD', payload: untrusted.payload, textLines: untrusted.textLines })
  }

  const requirements = computeEmpiricalRequirements({ diff, behavioralGate, effectiveProfile, task, gateWeakenedHits })
  if (!requirements.faultRequired) {
    const out = {
      status: 'FAULT_EXEMPT_LOW_RISK_OR_EMPTY',
      ok: true,
      mode,
      round,
      headSha,
      reason: requirements.isEmptyDiff ? 'empty-diff' : 'low-risk-no-runtime-checks',
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else process.stdout.write(`FAULT_EXEMPT_LOW_RISK_OR_EMPTY: ${out.reason}\n`)
    return EXIT.OK
  }

  const dirtyEntries = await getEffectiveStatusEntries(reviewRoot, mainRoot)
  const currentFingerprint = await computeWorkspaceFingerprint({
    reviewRoot, mainRoot, headSha, diff, statusEntries: dirtyEntries,
  })

  const sameScope = isSameScopeContext(prev, { mode, round, headSha, diffScope })
  const isCleanCommitMode = mode === 'task' || mode === 'pr'
  const baselineFingerprint = (sameScope && prev?.baselineFingerprint)
    ? prev.baselineFingerprint
    : (isCleanCommitMode ? computeCleanBaselineFingerprint({ headSha, diff }) : null)

  if (!baselineFingerprint) {
    const targetFlags = buildModeTargetFlags({ mode, task, round, prNo, baseRef: opts.base, reviewRoot, mainRoot })
    const msg = 'BLOCKED_EMPIRICAL_FIRST: 尚未采集当前工作区基线指纹，请先运行机械审查包与 check-empirical。'
    return emitGateBlock({
      opts,
      code: 'BLOCKED_EMPIRICAL_FIRST',
      payload: {
        status: 'BLOCKED_EMPIRICAL_FIRST',
        code: 'BLOCKED_EMPIRICAL_FIRST',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        headSha,
        workspaceFingerprint: currentFingerprint,
        missingSteps: ['mechanical-pack', 'check-empirical'],
        nextSteps: [
          `node ".agents/skills/dev-review/scripts/review-pack.mjs" ${targetFlags}`,
          `node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical ${targetFlags}`,
        ],
        error: msg,
      },
      textLines: ['BLOCKED_EMPIRICAL_FIRST', msg],
    })
  }

  const explicitCmds = (opts.cmd ?? []).map((s) => String(s).trim()).filter(Boolean)
  const prevEmpiricalCmds = (prev?.empiricalVerified?.commands ?? []).map((c) => c.cmd).filter(Boolean)
  const commandsToRun = explicitCmds.length > 0
    ? explicitCmds
    : (prevEmpiricalCmds.length > 0 ? prevEmpiricalCmds : requirements.autoCommands)

  if (commandsToRun.length === 0) {
    process.stderr.write('Error: check-fault requires --cmd "<command>" when no verification command is configured.\n')
    return EXIT.USAGE_OR_POLICY
  }

  const wtEnv = computeWorktreeEnv({ mainRoot, gitDir, taskId: task?.taskId ?? mode, slotIndex: task?.slotIndex })
  const targetFlags = buildModeTargetFlags({ mode, task, round, prNo, baseRef: opts.base, reviewRoot, mainRoot })

  if (phase === 'fail') {
    if (currentFingerprint === baselineFingerprint) {
      const msg = 'BLOCKED_FAULT_NO_MUTATION: 工作区与基线指纹完全相同（未注入任何故障改动），禁止空跑故障注入。'
      return emitGateBlock({
        opts,
        code: 'BLOCKED_FAULT_NO_MUTATION',
        payload: {
          status: 'BLOCKED_FAULT_NO_MUTATION',
          code: 'BLOCKED_FAULT_NO_MUTATION',
          exitCode: EXIT.UNTRUSTED_HAZARD,
          mode,
          round,
          headSha,
          baselineFingerprint,
          workspaceFingerprint: currentFingerprint,
          error: msg,
        },
        textLines: ['BLOCKED_FAULT_NO_MUTATION', msg],
      })
    }

    const results = await runCommandList(commandsToRun, { cwd: reviewRoot, env: wtEnv, stopOnFail: false })
    const caught = results.find((r) => !r.ok)
    if (!caught) {
      const msg = 'BLOCKED_FAULT_NOT_CAUGHT: 工作区已注入故障，但全部验证命令依然退出 0（测试未抓住该故障）。'
      return emitGateBlock({
        opts,
        code: 'BLOCKED_FAULT_NOT_CAUGHT',
        payload: {
          status: 'BLOCKED_FAULT_NOT_CAUGHT',
          code: 'BLOCKED_FAULT_NOT_CAUGHT',
          exitCode: EXIT.UNTRUSTED_HAZARD,
          mode,
          round,
          headSha,
          baselineFingerprint,
          mutatedFingerprint: currentFingerprint,
          commands: results,
          error: msg,
        },
        textLines: ['BLOCKED_FAULT_NOT_CAUGHT', msg],
      })
    }

    const injectedAt = new Date().toISOString()
    const baseRecord = sameScope && prev ? prev : {
      mode,
      round,
      prNo: prNo ?? null,
      headSha,
      diffScope,
      baselineFingerprint,
      untrustedScanClean: untrusted.scanClean ?? null,
      humanApprovedExec: Boolean(untrusted.approved),
      mechanicalPackSeen: false,
      mechanicalPackAt: null,
      empiricalVerified: null,
    }
    writeReceipt(receiptPath, {
      ...baseRecord,
      baselineFingerprint,
      faultInjectedAndFailed: {
        baselineFingerprint,
        mutatedFingerprint: currentFingerprint,
        headSha,
        round,
        diffScope,
        failedCmd: caught.cmd,
        exitCode: caught.exitCode,
        commands: results,
        injectedAt,
      },
      faultRestoredClean: false,
      faultRestoredAt: null,
      faultRestoredMeta: null,
    })

    const restoreHint = isCleanCommitMode
      ? `git -C "${posixPath(reviewRoot)}" checkout -- .`
      : '请将注入的故障手工还原回基线改动（保留原有 --local 未提交修改）'
    const nextSteps = [
      restoreHint,
      `node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase restore ${targetFlags} --cmd "${caught.cmd}"`,
    ]
    const payload = {
      status: 'FAULT_INJECTED_FAILED',
      ok: true,
      mode,
      round,
      targetRoot: posixPath(reviewRoot),
      headSha,
      baselineFingerprint,
      mutatedFingerprint: currentFingerprint,
      failedCmd: caught.cmd,
      failedExitCode: caught.exitCode,
      commands: results,
      nextSteps,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else {
      process.stdout.write([
        'FAULT_INJECTED_FAILED',
        `Worktree : ${posixPath(reviewRoot)} | FailedCmd: ${caught.cmd} (exit=${caught.exitCode})`,
      ].join('\n') + '\n')
      printNextStep(nextSteps, { repoRoot: mainRoot })
    }
    return EXIT.OK
  }

  // phase === 'restore'
  const notCleanForMode = isCleanCommitMode && dirtyEntries.length > 0
  if (notCleanForMode || currentFingerprint !== baselineFingerprint) {
    const msg = notCleanForMode
      ? `BLOCKED_DIRTY_FAULT_RESIDUE: 工作区仍有未还原改动（${dirtyEntries.map((e) => e.file).slice(0, 5).join(', ')}），请先彻底还原再运行 --phase restore。`
      : 'BLOCKED_DIRTY_FAULT_RESIDUE: 当前工作区指纹尚未还原回注入前基线（baselineFingerprint），请彻底还原后再运行 --phase restore。'
    return emitGateBlock({
      opts,
      code: 'BLOCKED_DIRTY_FAULT_RESIDUE',
      payload: {
        status: 'BLOCKED_DIRTY_FAULT_RESIDUE',
        code: 'BLOCKED_DIRTY_FAULT_RESIDUE',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        targetRoot: posixPath(reviewRoot),
        baselineFingerprint,
        workspaceFingerprint: currentFingerprint,
        dirtyFiles: dirtyEntries.map((e) => e.file),
        error: msg,
      },
      textLines: ['BLOCKED_DIRTY_FAULT_RESIDUE', msg],
    })
  }

  if (!sameScope || prev?.faultInjectedAndFailed?.baselineFingerprint !== baselineFingerprint) {
    const msg = 'BLOCKED_EMPIRICAL_FIRST: 尚未记录对应当前基线的 check-fault --phase fail 成功证据，不能直接标记还原。'
    return emitGateBlock({
      opts,
      code: 'BLOCKED_EMPIRICAL_FIRST',
      payload: {
        status: 'BLOCKED_EMPIRICAL_FIRST',
        code: 'BLOCKED_EMPIRICAL_FIRST',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        headSha,
        workspaceFingerprint: currentFingerprint,
        missingSteps: ['check-fault:fail'],
        nextSteps: [`node ".agents/skills/dev-review/scripts/review-pack.mjs" check-fault --phase fail ${targetFlags} --cmd "${commandsToRun[0]}"`],
        error: msg,
      },
      textLines: ['BLOCKED_EMPIRICAL_FIRST', msg],
    })
  }

  const results = await runCommandList(commandsToRun, { cwd: reviewRoot, env: wtEnv, stopOnFail: true })
  const failed = results.find((r) => !r.ok)
  if (failed) {
    const msg = `BLOCKED_EMPIRICAL_FAILED: 还原后复绿命令仍然失败 (exit=${failed.exitCode}): ${failed.cmd}`
    return emitGateBlock({
      opts,
      code: 'BLOCKED_EMPIRICAL_FAILED',
      payload: {
        status: 'BLOCKED_EMPIRICAL_FAILED',
        code: 'BLOCKED_EMPIRICAL_FAILED',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        mode,
        round,
        headSha,
        workspaceFingerprint: currentFingerprint,
        commands: results,
        error: msg,
      },
      textLines: ['BLOCKED_EMPIRICAL_FAILED', msg],
    })
  }

  const restoredAt = new Date().toISOString()
  writeReceipt(receiptPath, {
    ...prev,
    faultRestoredClean: true,
    faultRestoredAt: restoredAt,
    faultRestoredMeta: { fingerprint: currentFingerprint, commands: results },
  })

  const gate = evaluateIncludeDiffGate({
    gitDir, mode, task, round, prNo, baseRef: opts.base, reviewRoot, mainRoot,
    headSha, diffScope, workspaceFingerprint: currentFingerprint, dirtyEntries,
    requirements, behavioralGate, opts,
  })
  const payload = {
    status: 'FAULT_RESTORED_CLEAN',
    ok: true,
    mode,
    round,
    targetRoot: posixPath(reviewRoot),
    headSha,
    workspaceFingerprint: currentFingerprint,
    baselineFingerprint,
    commands: results,
    empiricalGate: gate,
    nextSteps: gate.unblockCommands.length > 0
      ? gate.unblockCommands
      : [`node ".agents/skills/dev-review/scripts/review-pack.mjs" ${targetFlags} --include-diff`],
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else {
    process.stdout.write([
      'FAULT_RESTORED_CLEAN',
      `Worktree : ${posixPath(reviewRoot)} | Restored cleanly & verified (${results.length} cmd)`,
    ].join('\n') + '\n')
    printNextStep(payload.nextSteps, { repoRoot: mainRoot })
  }
  return EXIT.OK
}
