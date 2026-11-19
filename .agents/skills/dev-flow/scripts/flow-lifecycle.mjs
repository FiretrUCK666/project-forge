/**
 * flow-lifecycle.mjs —— finalize（成对归档 + TDD 日期校验）、verify（尊重 none）、submit（同步 review 槽）与 rework。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep } from '../../lib/cli.mjs'
import {
  archiveCompletedDocsGroup, buildSubmitComments, docIsoDate, } from '../../lib/docs.mjs'
import { formatWorkTitle } from '../../lib/escalation.mjs'
import {
  computeWorktreeEnv, detectInProgressGitOp, execShellCommand, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, posixPath, readTextSafe, sha256Text, syncDetachedWorktree, writeAtomic, } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { nextReviewRound, recordMountedDepsInLedger, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, isInternalAgentSlug, parseRemotesTopology, parseRemoteUrls, probeGitHubEnv, resolveContributorIdentity, probeForWrite } from '../../lib/platform.mjs'
import { isProfileExplicitNone, parseAgentsProfile, readDecisions } from '../../lib/profile.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText, matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { assertNoDuplicatePrForTask, checkUntrustedPrGate } from '../../lib/task-graph.mjs'
import { checkFrozenCriteria } from '../../lib/criteria-lock.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import {
  buildSubmitNextSteps, determineWorkflowPolicy, hasRepoCiWorkflow, hydratePrTemplateBody,
  readVerificationEvidence, runLowRiskDocStaticCheck, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import { mountSharedDeps, unmountSharedDeps } from './worktree-deps.mjs'
import {
  applySubmitPostActions,
  cmdContainsSubcommand,
  collectFinalizeChangedFiles,
  computeFlowCoupledSync,
  emitFlowSignal,
  evaluateFlowMasterPrdGate,
  findStrictDocBySlug,
  findUncheckedLines,
  handleForkFinalize,
  handleRework,
  handleVerifyE2eFailure,
  recordVerifyEvidenceForFlow,
} from './flow-lifecycle-helpers.mjs'

export { handleRework }

export async function handleFinalize(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

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
      return { exitCode: 1 }
    }
  }

  const criteriaDrift = checkFrozenCriteria(ledger, implRoot)
  if (criteriaDrift.blocked) { process.stderr.write(criteriaDrift.message); return { exitCode: 1 } }
  if (specRel && existsSync(join(implRoot, specRel))) {
    const specAbs = join(implRoot, specRel)
    let specText = readTextSafe(specAbs) ?? ''
    if (!/^##\s+实现说明\s*$/m.test(specText)) specText = `${specText.trimEnd()}\n\n## 实现说明\n\n`
    const secStart = specText.search(/^##\s+实现说明\s*$/m)
    const afterSec = specText.slice(secStart)
    const nextH2 = afterSec.slice(1).search(/\n##\s+/)
    const secBody = (nextH2 > 0 ? afterSec.slice(0, nextH2 + 1) : afterSec).replace(/^##\s+实现说明\s*\n?/, '')
    if (/<!--\s*project-forge:\s*fill|\b(?:TBD|FIXME)\b/i.test(secBody) || /\bTODO\b/.test(secBody)) {
      process.stderr.write(`BLOCKED_SPEC_IMPL_NOTE_EMPTY: ${specRel} 的「实现说明」仍含未填占位，请补齐真实说明后再 finalize。\n`)
      return { exitCode: 1 }
    }
    if (!secBody.replace(/<!--[\s\S]*?-->/g, '').trim()) {
      const autoSummary = [`- 实现提交基线: ${currentHead ?? 'uncommitted'}`, `- 关联任务: ${taskId}`, opts.note ? `- 说明: ${opts.note}` : null].filter(Boolean).join('\n')
      specText = specText.replace(/(^##\s+实现说明\s*\n(?:<!--[\s\S]*?-->\s*\n?)?)/m, `$1\n${autoSummary}\n`)
    }
    writeAtomic(specAbs, specText)
  }

  const finDiff = ledger.baseSha
    ? (currentHead && currentHead === ledger.baseSha ? { ok: true, entries: [], diffText: '' } : await gitDiffRawEntriesAndText(implRoot, `${ledger.baseSha}..HEAD`))
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
    return { exitCode: 1 }
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

  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const out = {
    taskId, finalized: true, finalizedHead: currentHead,
    prdFile: ledger.prdFile, archivedPrdFile: ledger.archivedPrdFile, archivedMasterPrd: archivedGroup.archivedMasterPrd ?? null,
    specFile: ledger.specFile, todoFile: ledger.todoFile,
    archivedDocs: archivedGroup.moved, coupledSyncWarnings, ...parity,
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
    return { exitCode: 1 }
  }
  return { exitCode: 0 }
}

export async function handleVerify(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const workRel = ledger.worktreePath || (ledger.role === 'inbound-external-pr' ? ledger.reviewWorktreePath : null)
  const implRoot = workRel ? resolve(roots.mainRoot, workRel) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

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
    return { exitCode: 1 }
  }
  let rawTarget = opts.target !== undefined ? String(opts.target).trim() : null
  if (rawTarget !== null) {
    if (!rawTarget || /[;&|`$><\r\n]/.test(rawTarget)) {
      await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: 'verify.invalid-target', severity: 'low', source: 'flow-verify', message: `invalid target: ${opts.target}`, taskId })
      process.stderr.write(`INVALID_TARGET_ARG: --target 值非法或含不允许的元字符：${opts.target}\n`)
      return { exitCode: 1 }
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
    const [stZ, headRes, diffNsRes, remoteRes] = await Promise.all([
      stZReuse ? Promise.resolve(stZReuse) : gitStatusPorcelainZ(implRoot),
      fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
      !ledger.baseSha
        ? Promise.resolve(null)
        : (fastHeadOid && fastHeadOid === ledger.baseSha ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${ledger.baseSha}..HEAD`)),
      fastCfg ? Promise.resolve({ ok: true, stdout: fastCfg.remoteText }) : gitRun(roots.mainRoot, ['remote', '-v']),
    ])
    const currentHead = headRes.ok ? headRes.stdout.trim() : null
    const sharedDiffEntries = diffNsRes?.ok ? diffNsRes.entries : undefined
    const [changedFiles, gateHits] = await Promise.all([
      getChangedFiles(implRoot, ledger.baseSha, { statusEntries: stZ.entries, diffEntries: sharedDiffEntries }),
      detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: sharedDiffEntries }),
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
      cmdStr: 'none (explicitly disabled)', customCmd: false, exitCode: 0,
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
      process.stdout.write(`${JSON.stringify({ taskId, mode, cmd: ledger.verifiedCmd, skippedReason: 'explicit-none', ok: true, exitCode: 0, verifiedHead: currentHead, riskTier: policy.riskTier, docStatic: docStaticRes }, null, 2)}\n`)
    } else {
      process.stdout.write(`verify (${mode}): AGENTS.md Dev Profile 显式配置 \`${profileKey}: none\`，已放行并绑定 HEAD=${currentHead ?? 'unborn'}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
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
    return { exitCode: 1 }
  }

  const e2eEvidenceInput = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || (opts['visual-checked'] ? 'e2e/visual runtime behavior observed and verified' : '')
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
      return { exitCode: 1 }
    }
  }

  const defaultTimeout = mode === 'gate' ? 600000 : mode === 'full' ? 300000 : 120000
  const timeoutMs = opts.timeout !== undefined ? Number(opts.timeout) : defaultTimeout
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.invalid-timeout`, severity: 'low', source: 'flow-verify', message: `invalid timeout: ${opts.timeout}`, taskId })
    process.stderr.write(`INVALID_TIMEOUT_ARG: --timeout 须为 >= 1000 的毫秒数，收到：${opts.timeout}\n`)
    return { exitCode: 1 }
  }
  const wtEnv = computeWorktreeEnv({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, taskId, slotIndex: ledger.slotIndex })
  const runRes = await execShellCommand(cmd, implRoot, { timeout: timeoutMs, env: wtEnv })
  const { currentHead, dirty, stStdout, changedFiles, policy } = await computeVerifyPolicy()
  let smokeCmdUsed = mode === 'smoke' ? cmd : null
  let smokeRunRes = mode === 'smoke' ? runRes : null
  let smokeExecuted = mode === 'smoke'
  if (mode === 'gate' && policy.smokeRequired && profile.smokeVerify && !isProfileExplicitNone(profile, 'smoke-verify') && !profile.smokeVerify.includes('{target}')) {
    const prevEv = readVerificationEvidence(roots.gitDir, taskId)
    const alreadySmokeOk = Boolean(prevEv && prevEv.headSha === currentHead && !dirty && !prevEv.dirty && prevEv.gates?.smoke?.exitCode === 0 && prevEv.smokeVerifiedOnHead)
    if (!alreadySmokeOk) {
      if (cmdContainsSubcommand(cmd, profile.smokeVerify)) {
        smokeCmdUsed = profile.smokeVerify
        smokeRunRes = runRes
        smokeExecuted = true
      } else if (runRes.ok) {
        smokeCmdUsed = profile.smokeVerify
        smokeRunRes = await execShellCommand(profile.smokeVerify, implRoot, { timeout: timeoutMs, env: wtEnv })
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
    e2eObservationText: e2eEvidenceInput,
    smokeCmd: smokeCmdUsed, smokeExitCode: smokeRunRes?.code ?? null, smokeExecuted, smokeErrorOnly: false,
  })
  const finalExit = !execOk && runRes.ok && smokeRunRes && !smokeRunRes.ok ? (smokeRunRes.code || 1) : evRec.overallExit
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
    ledger.visualCheckEvidence = e2eEvidenceInput || (ledger.visualCheckEvidence ?? '实际运行、端到端交互与输出观察核验已确认')
  }
  ledger.status = allOk ? 'verified' : 'verify-failed'
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: allOk ? `verify.${mode}.pass` : `verify.${mode}.fail`, severity: allOk ? 'info' : 'high', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? changedFiles[0] ?? '', taskId, message: `verify (${mode}) exit=${finalExit}: ${cmd}`, meta: { riskTier: policy.riskTier, target: rawTarget } })
  if (docStaticRes && !docStaticRes.ok) {
    process.stderr.write(`BLOCKED_STATIC_DOC_CHECK_FAILED: 无 CI 低风险静态必检未通过：${docStaticRes.errors.map((e) => e.message).slice(0, 3).join('；')}\n`)
  }
  if (e2eFailureReport?.diagnostic && !opts.json) {
    process.stderr.write(`E2E_RUNTIME_FAILED:\nEvidence:\n  - ${e2eFailureReport.diagnostic.Evidence.join('\n  - ')}\nUnknowns:\n  - ${e2eFailureReport.diagnostic.Unknowns.join('\n  - ')}\nNextSteps:\n  - ${e2eFailureReport.diagnostic.NextSteps.join('\n  - ')}\n`)
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      taskId, mode, target: rawTarget, cmd, ...(targetTip ? { targetTip } : {}),
      ok: allOk, exitCode: finalExit, verifiedHead: ledger.verifiedHead, riskTier: policy.riskTier,
      smokeVerifiedOnHead: evRec.smokeVerifiedOnHead, e2eObservation: evRec.e2eObservation,
      ...(e2eFailureReport ? { diagnostic: e2eFailureReport.diagnostic, escalatedIssue: e2eFailureReport.escalation } : {}),
      docStatic: docStaticRes, visualFilesChanged, empiricalVisualCheckRequired,
      visualVerifiedHead: ledger.visualVerifiedHead, visualCheckEvidence: ledger.visualCheckEvidence,
      stdout: runRes.stdout, stderr: runRes.stderr,
    }, null, 2)}\n`)
  } else {
    if (runRes.stdout) process.stdout.write(`${runRes.stdout}\n`)
    if (runRes.stderr) process.stderr.write(`${runRes.stderr}\n`)
    if (targetTip) process.stdout.write(`${targetTip}\n`)
    process.stdout.write(`verify (${mode}${rawTarget ? ` target=${rawTarget}` : ''}): cmd="${cmd}" exit=${finalExit} HEAD=${currentHead ?? 'unborn'} risk=${policy.riskTier}\n`)
    if (allOk) {
      const next = [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}` }]
      if (policy.smokeRequired && !evRec.e2eObservation) {
        next.unshift(`检测到运行时改动（smokeRequired=true）：请核验实际运行输出/状态并补充 --e2e-evidence "<观察结论>"：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId} --mode smoke --e2e-evidence "<运行观察>"`)
      } else if (empiricalVisualCheckRequired && ledger.visualVerifiedHead !== currentHead) {
        next.unshift(`检测到 UI/视觉改动（${visualFilesChanged.slice(0, 5).join(', ')}）：请核验实际渲染、交互与浅深色截图后补 --visual-checked。`)
      }
      printNextStep(next, { repoRoot: roots.mainRoot })
    } else {
      printNextStep(
        e2eFailureReport?.diagnostic?.NextSteps?.length
          ? e2eFailureReport.diagnostic.NextSteps
          : [`验证未通过（exit=${finalExit}），请修复后重新运行 verify。`],
        { repoRoot: roots.mainRoot },
      )
    }
  }
  return { exitCode: allOk ? 0 : (finalExit || 1) }
}

export async function handleSubmit(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot, { wtGitDir: resolveGitDirFast(implRoot) })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)

  const rawExplicitAgent = String(opts.agent ?? '').trim()
  if (rawExplicitAgent) {
    const lowExplicit = rawExplicitAgent.toLowerCase()
    const nonImplRole = /(?:^|[-_.])(?:coordinator|orchestrator|dispatcher|reviewer|critic)(?:$|[-_.])/i.test(lowExplicit)
    if (opts.takeover) {
      if (!String(opts.reason ?? '').trim()) {
        process.stderr.write('BLOCKED_TAKEOVER_REASON_REQUIRED: --takeover 必须同时传入 --reason "<接管原因>"。\n')
        return { exitCode: EXIT_POLICY_BLOCK }
      }
      if (nonImplRole) {
        const msg = `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者角色 (${rawExplicitAgent}) 不得借 --takeover 代实施者 submit。`
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH', reason: msg }, null, 2)}\n`)
        process.stderr.write(`${msg}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
      const nextContrib = resolveContributorIdentity({ explicitActor: rawExplicitAgent, ledgerActor: ledger.implementerId })
      ledger.implementerId = nextContrib.actor
    } else if (nonImplRole) {
      const msg = `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 协调者/审查者身份 (${rawExplicitAgent}) 禁止代实施者 submit；谁改代码谁认领并负责提交与 PR 评论。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH', reason: msg }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    } else if (ledger.implementerId && !isInternalAgentSlug(ledger.implementerId)) {
      const resolvedExplicit = resolveContributorIdentity({ explicitActor: rawExplicitAgent, ledgerActor: ledger.implementerId })
      if (resolvedExplicit.actor.toLowerCase() !== String(ledger.implementerId).toLowerCase()) {
        const msg = `BLOCKED_SUBMIT_OWNERSHIP_MISMATCH: 提交者 (${resolvedExplicit.actor}) 与已认领实施者 (${ledger.implementerId}) 不一致；请由原实施者提交或带 --takeover --reason "..." 接管。`
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH', reason: msg }, null, 2)}\n`)
        process.stderr.write(`${msg}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
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
  const submitDiffRes = !ledger.baseSha
    ? null
    : (fastHeadOid && fastHeadOid === ledger.baseSha ? { ok: true, entries: [] } : await gitDiffRawEntriesAndText(implRoot, `${ledger.baseSha}..HEAD`))
  const submitDiffEntries = submitDiffRes?.ok ? submitDiffRes.entries : undefined
  const [changedForVisual, gateFindings] = await Promise.all([
    getChangedFiles(implRoot, ledger.baseSha, { statusEntries: stZ.entries, diffEntries: submitDiffEntries }),
    detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: submitDiffEntries }),
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

  // Tier 2 在提交独立审查前先安全解绑旧 Junction，按需 --reset-review-slot 清理脏审查位，同步最新 HEAD 后重挂载依赖
  let reviewSlotSync = null
  if (ledger.tier === 2 && currentHead && ledger.reviewWorktreePath) {
    const reviewAbs = resolve(roots.mainRoot, ledger.reviewWorktreePath)
    if (existsSync(reviewAbs) && !unmountSharedDeps(roots.mainRoot, reviewAbs, { mode: 'deps' })?.ok) throw new Error(`审查槽解绑共享依赖失败：${ledger.reviewWorktreePath}`)
    reviewSlotSync = await syncDetachedWorktree(roots.mainRoot, reviewAbs, currentHead, { resetDirty: Boolean(opts['reset-review-slot']) })
    const revDeps = mountSharedDeps(roots.mainRoot, reviewAbs)
    recordMountedDepsInLedger(ledger, ledger.reviewWorktreePath, revDeps)
    ledger.reviewWorktreeHead = currentHead
    reviewSlotSync.depsMode = revDeps.mode
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  }

  const nextRound = (ledger.rounds ?? []).length > 0
    ? nextReviewRound(ledger)
    : 1

  const postLocalLifecycleComments = async ({ targetRepo = null, pushRemote = null, actionFallback }) => {
    if ((ledger.linkedIssues ?? []).length === 0) return
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId ?? 'none', targetRepo, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const submitActor = resolveContributorIdentity({ explicitActor: opts.agent, ledgerActor: ledger.implementerId })
    const isReworkLocal = Boolean(opts.rework) || (ledger.rounds ?? []).length > 0
    const recentRebuts = (ledger.rebuts ?? []).slice(-3).map((r) => `${r.findingId}: ${r.reason}`).join('；')
    const { issueCommentBodyFor } = buildSubmitComments({
      isRework: isReworkLocal, round: nextRound, shortHead: currentHead?.slice(0, 7) ?? 'unknown', actorDisplay: submitActor.display,
      branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: null,
      linkedIssues: ledger.linkedIssues ?? [], recentRebuts,
    })
    for (const iss of ledger.linkedIssues ?? []) {
      await localBackend.postComment({
        taskId, number: iss, body: issueCommentBodyFor(iss), author: submitActor.actor,
        statePayload: { taskId, action: isReworkLocal ? 'rework-submitted' : actionFallback, round: nextRound, agent: submitActor.actor, headSha: currentHead },
      })
      if (typeof localBackend.syncStateLabel === 'function') {
        await Promise.resolve(localBackend.syncStateLabel({ taskId, number: iss, state: 'in-review' })).catch(() => null)
      }
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
    return { exitCode: 0 }
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
    return { exitCode: 0 }
  }

  // 提审要开 PR——那是平台写操作。用「不联网」的探测结果判断「能不能写」，
  // 必然得到「不能」，然后安静地只记账本，看起来像成功。
  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const backend = createTaskBackend({
    role: ledger.role, providerId: ledger.providerId, targetRepo,
    client: opts._ghClient ?? ghProbe.client, pushRemote, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })
  const submitActor = resolveContributorIdentity({ explicitActor: opts.agent, ghLogin: ghProbe.env?.trackB?.login, ledgerActor: ledger.implementerId })
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
    const { prCommentBody, issueCommentBodyFor } = buildSubmitComments({
      isRework: true, round: nextRound, shortHead, actorDisplay: submitActor.display,
      branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: ledger.prNumber,
      linkedIssues: ledger.linkedIssues ?? [], recentRebuts,
    })
    prResult = { reusedPr: ledger.prNumber, head: shortHead }
    commentResults.push({
      target: `PR #${ledger.prNumber}`,
      res: await backend.postComment({ repo: targetRepo, number: ledger.prNumber, body: prCommentBody, statePayload: { taskId, action: 'rework-submitted', round: nextRound, agent: submitActor.actor, headSha: currentHead } }),
    })
    for (const iss of ledger.linkedIssues ?? []) {
      commentResults.push({
        target: `Issue #${iss}`,
        res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: 'rework-submitted', round: nextRound, agent: submitActor.actor, prNumber: ledger.prNumber, headSha: currentHead } }),
      })
    }
    await applySubmitPostActions({ backend, targetRepo, prNumber: ledger.prNumber, linkedIssues: ledger.linkedIssues ?? [], ledger, roots, isRework: true })
  } else {
    const title = formatWorkTitle(opts.title ?? ledger.slug, ledger.caseType)
    const body = opts.body ?? hydratePrTemplateBody({
      repoRoot: implRoot, taskId, ledger, policy, actorDisplay: submitActor.display,
      visualFilesChanged, visualVerifiedOnHead, currentHead, changedFiles: changedForVisual,
    })

    prResult = await backend.createPr({ targetRepo, head: headSpec, base: ledger.baseBranch, title, body, draft: Boolean(opts.draft) })
    if (prResult.ok && prResult.number) {
      ledger.prNumber = prResult.number
      ledger.prUrl = prResult.url ?? null
      ledger.prState = 'OPEN'
      const { prCommentBody, issueCommentBodyFor } = buildSubmitComments({
        isRework: false, round: 1, shortHead, actorDisplay: submitActor.display,
        branch: ledger.branch, verifiedCmd: ledger.verifiedCmd, prNumber: prResult.number,
        prUrl: prResult.url, linkedIssues: ledger.linkedIssues ?? [],
      })
      commentResults.push({
        target: `PR #${prResult.number}`,
        res: await backend.postComment({ repo: targetRepo, number: prResult.number, body: prCommentBody, statePayload: { taskId, action: 'pr-submitted', round: 1, agent: submitActor.actor, prNumber: prResult.number, headSha: currentHead } }),
      })
      for (const iss of ledger.linkedIssues ?? []) {
        commentResults.push({
          target: `Issue #${iss}`,
          res: await backend.postComment({ repo: targetRepo, number: iss, body: issueCommentBodyFor(iss), statePayload: { taskId, action: 'pr-created', agent: submitActor.actor, prNumber: prResult.number, headSha: currentHead } }),
        })
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
  return { exitCode: 0 }
}
