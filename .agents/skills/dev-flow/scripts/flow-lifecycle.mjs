/**
 * flow-lifecycle.mjs —— finalize（成对归档 + TDD 日期校验）、verify（尊重 none）、submit（同步 review 槽）与 rework。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  archiveCompletedDocsGroup, buildSubmitComments, docIsoDate, evaluateCoupledSync, isSharedMasterPrd,
  parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  computeWorktreeEnv, detectInProgressGitOp, execShellCommand, gitDiffNameStatusZ, gitRun,
  gitStatusPorcelainZ, posixPath, readTextSafe, sha256Text, syncDetachedWorktree, writeAtomic,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, isInternalAgentSlug, parseRemotesTopology, parseRemoteUrls,
  probeGitHubEnv, resolveContributorIdentity,
} from '../../lib/platform.mjs'
import { isProfileExplicitNone, parseAgentsProfile } from '../../lib/profile.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText, matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { assertNoDuplicatePrForTask, checkUntrustedPrGate } from '../../lib/task-graph.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import {
  determineWorkflowPolicy, hasRepoCiWorkflow, hydratePrTemplateBody,
  readVerificationEvidence, runLowRiskDocStaticCheck, validateVerificationEvidence,
  writeVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import { mountSharedDeps, unmountSharedDeps } from './worktree-deps.mjs'

function computeFlowCoupledSync(implRoot, mainRoot, changedFiles) {
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : mainRoot
  const agentsText = readTextSafe(join(agentsRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(changedFiles, rules, agentsRoot) : []
}

async function collectFinalizeChangedFiles(implRoot, ledger, statusEntries, gitCommonDir = null, headSha = null, preDiffEntries = undefined) {
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

function findUncheckedLines(text) {
  const out = []
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence && /^- \[ \]/.test(line) && !/(?:<!--\s*waive:|\[waive:|豁免|跳过原因)/i.test(line)) out.push(line.trim())
  }
  return out
}

function findStrictDocBySlug(root, dirRel, ledger) {
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

async function emitFlowSignal(roots, payload) {
  await appendGovernSignal({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, isGit: roots.isGit, ...payload })
}

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
    const baseRef = ledger.baseSha || ledger.baseBranch || 'HEAD'
    const baseTree = await gitRun(implRoot, ['ls-tree', '-r', '--name-only', baseRef, '--', 'docs/'])
    const baseDocs = baseTree.ok ? baseTree.stdout.split('\n').filter(Boolean) : []
    const upstreamUsesDocs = baseDocs.some((p) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/)/.test(p))
    if (!upstreamUsesDocs) {
      const committedDiff = ledger.baseSha ? await gitRun(implRoot, ['diff', '--name-only', `${ledger.baseSha}..HEAD`]) : { ok: false, stdout: '' }
      const committedDocs = (committedDiff.stdout || '').split('\n').filter((f) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/|archive\/)/.test(f.trim()))
      if (committedDocs.length > 0) {
        process.stderr.write(`BLOCKED_FORK_PRIVATE_DOCS: 上游仓未接入 docs/ 体系，私有规划文件不应混入 Fork PR 提交：${committedDocs.join(', ')}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
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
      writeTaskLedger(roots.mainRoot, ledger)
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
  }

  const todoRel = ledger.todoFile ?? ledger.archivedTodoFile ?? findStrictDocBySlug(implRoot, 'docs/todo', ledger)
  const specRel = ledger.specFile ?? ledger.archivedSpecFile ?? findStrictDocBySlug(implRoot, 'docs/specs', ledger)
  const prdRel = ledger.prdFile ?? ledger.archivedPrdFile ?? findStrictDocBySlug(implRoot, 'docs/prd', ledger)
  const includeMasterPrd = Boolean(opts['include-master-prd'])
  const sharedMasterPrd = Boolean(prdRel && isSharedMasterPrd(implRoot, prdRel, specRel))

  for (const [label, relDoc] of [['TODO', todoRel], ['SPEC', specRel], ['PRD', (sharedMasterPrd && !includeMasterPrd) ? null : prdRel]]) {
    if (!relDoc) continue
    const absDoc = join(implRoot, relDoc)
    if (!existsSync(absDoc)) continue
    const unchecked = findUncheckedLines(readTextSafe(absDoc) ?? '')
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_${label}: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
      return { exitCode: 1 }
    }
  }

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

  let archivedGroup = { moved: [], byKind: { prd: prdRel, spec: specRel, todo: todoRel }, archivedMasterPrd: null }
  if (prdRel || specRel || todoRel) {
    archivedGroup = await archiveCompletedDocsGroup(implRoot, {
      prdFile: prdRel, specFile: specRel, todoFile: todoRel, slugOrPath: specRel ?? todoRel ?? prdRel ?? ledger.slug,
      issue: ledger.linkedIssues?.[0], pr: ledger.prNumber ?? undefined, branch: ledger.branch, owner: ledger.implementerId ?? undefined, doneAt: today,
      includeMasterPrd,
    })
    if (archivedGroup.byKind.prd) {
      ledger.prdFile = archivedGroup.byKind.prd
      ledger.archivedPrdFile = ((!includeMasterPrd && sharedMasterPrd) || !archivedGroup.byKind.prd.startsWith('docs/archive/'))
        ? null
        : archivedGroup.byKind.prd
    }
    if (archivedGroup.byKind.spec) { ledger.specFile = archivedGroup.byKind.spec; ledger.archivedSpecFile = archivedGroup.byKind.spec }
    if (archivedGroup.byKind.todo) { ledger.todoFile = archivedGroup.byKind.todo; ledger.archivedTodoFile = archivedGroup.byKind.todo }
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

  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  writeTaskLedger(roots.mainRoot, ledger)

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

  const untrustedGate = checkUntrustedPrGate(ledger, { humanApproved: Boolean(opts['human-approved'] || opts['human-approved-exec']) })
  if (untrustedGate.blocked) {
    await emitFlowSignal(roots, { category: 'security', module: 'workflow', pattern: 'verify.untrusted-blocked', severity: 'high', source: 'flow-verify', message: untrustedGate.message, taskId })
    if (opts.json) process.stdout.write(`${JSON.stringify(untrustedGate, null, 2)}\n`)
    process.stderr.write(`${untrustedGate.message}\n`)
    return { exitCode: untrustedGate.exitCode ?? EXIT_POLICY_BLOCK }
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
      gateWeakeningHits: gateHits, hasRemote: Boolean(remoteRes.ok && remoteRes.stdout.trim()),
      hasCiWorkflow: hasCi, visualFilesChanged: changedFiles.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile,
    })
    return { currentHead, dirty, stStdout, changedFiles, policy }
  }

  const recordEvidence = ({ currentHead, dirty, policy, modeName, targetVal, cmdStr, customCmd, exitCode, explicitNoneSkipped, docStaticRes }) => {
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
    const overallExit = docStaticRes && !docStaticRes.ok ? EXIT_POLICY_BLOCK : exitCode
    writeVerificationEvidence(roots.gitDir, taskId, {
      taskId, baseSha: ledger.baseSha, headSha: currentHead, dirty,
      riskTier: policy.riskTier, mode: modeName, target: targetVal, exitCode: overallExit,
      gates, skipped: [...skipped],
    })
    return overallExit
  }

  if (!cmd && isExplicitNone) {
    const { currentHead, dirty, stStdout, changedFiles, policy } = await computeVerifyPolicy()
    const docStaticRes = policy.staticDocCheckRequired ? runLowRiskDocStaticCheck(implRoot, changedFiles) : null
    const docOk = !docStaticRes || docStaticRes.ok
    recordEvidence({
      currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
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
    writeTaskLedger(roots.mainRoot, ledger)
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
    await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: `verify.${mode}.no-cmd`, severity: 'medium', source: 'flow-verify', message: `no verify command for ${mode}`, taskId })
    process.stderr.write(`NO_VERIFY_COMMAND: 未从 AGENTS.md Dev Profile 或项目清单识别到 ${mode} 验证命令，请通过 --cmd "<命令>" 显式传入（纯文档仓请配 \`${profileKey}: none\`）。\n`)
    return { exitCode: 1 }
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
  const docStaticRes = runRes.ok && policy.staticDocCheckRequired ? runLowRiskDocStaticCheck(implRoot, changedFiles) : null
  const allOk = runRes.ok && (!docStaticRes || docStaticRes.ok)
  const finalExit = recordEvidence({
    currentHead, dirty, policy, modeName: mode, targetVal: rawTarget,
    cmdStr: cmd, customCmd: Boolean(opts.cmd), exitCode: runRes.code,
    explicitNoneSkipped: false, docStaticRes,
  })
  const visualFilesChanged = policy.visualFilesChanged
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const hasVisualCheckFlag = Boolean(opts['visual-checked'] || opts['visual-evidence'])

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
    ledger.visualCheckEvidence = typeof opts['visual-evidence'] === 'string'
      ? opts['visual-evidence']
      : (ledger.visualCheckEvidence ?? '实际渲染、端到端交互与浅深色截图核验已确认')
  }
  ledger.status = allOk ? 'verified' : 'verify-failed'
  writeTaskLedger(roots.mainRoot, ledger)
  await emitFlowSignal(roots, { category: 'tests', module: 'workflow', pattern: allOk ? `verify.${mode}.pass` : `verify.${mode}.fail`, severity: allOk ? 'info' : 'high', source: 'flow-verify', file: docStaticRes?.errors?.[0]?.file ?? changedFiles[0] ?? '', taskId, message: `verify (${mode}) exit=${finalExit}: ${cmd}`, meta: { riskTier: policy.riskTier, target: rawTarget } })
  if (docStaticRes && !docStaticRes.ok) {
    process.stderr.write(`BLOCKED_STATIC_DOC_CHECK_FAILED: 无 CI 低风险静态必检未通过：${docStaticRes.errors.map((e) => e.message).slice(0, 3).join('；')}\n`)
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      taskId, mode, target: rawTarget, cmd, ...(targetTip ? { targetTip } : {}),
      ok: allOk, exitCode: finalExit, verifiedHead: ledger.verifiedHead, riskTier: policy.riskTier,
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
      if (empiricalVisualCheckRequired && ledger.visualVerifiedHead !== currentHead) {
        next.unshift(`检测到 UI/视觉改动（${visualFilesChanged.slice(0, 5).join(', ')}）：请核验实际渲染、交互与浅深色截图后补 --visual-checked。`)
      }
      printNextStep(next, { repoRoot: roots.mainRoot })
    } else {
      printNextStep([`验证未通过（exit=${finalExit}），请修复后重新运行 verify。`], { repoRoot: roots.mainRoot })
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
  const policy = determineWorkflowPolicy({
    changedFiles: changedForVisual, ownArchived, caseType: ledger.caseType,
    highRiskGlobs: profile.highRisk, doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateFindings, hasRemote: ledger.role !== 'local-only',
    hasCiWorkflow: hasRepoCiWorkflow(implRoot),
    visualFilesChanged: changedForVisual.filter((f) => UI_VISUAL_EXT_RE.test(f)), profile,
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
    if (existsSync(reviewAbs)) unmountSharedDeps(roots.mainRoot, reviewAbs)
    reviewSlotSync = await syncDetachedWorktree(roots.mainRoot, reviewAbs, currentHead, { resetDirty: Boolean(opts['reset-review-slot']) })
    const revDeps = mountSharedDeps(roots.mainRoot, reviewAbs)
    ledger.reviewWorktreeHead = currentHead
    reviewSlotSync.depsMode = revDeps.mode
  }

  const nextRound = (ledger.rounds ?? []).length > 0
    ? Math.max(...ledger.rounds.map((r) => Number(r.round) || 1)) + 1
    : 1

  if (ledger.role === 'local-only') {
    ledger.status = 'local-ready'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...ledger, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`本地模式提交校验已通过（HEAD=${currentHead?.slice(0, 7)}，未配置远端不执行 push）。\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` }], { repoRoot: roots.mainRoot })
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
    ledger.status = 'submitted'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, providerId: ledger.providerId, status: ledger.status, head: currentHead, pushRemote, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`submit 完成：已推送至 ${pushRemote}/${ledger.branch} @ ${currentHead?.slice(0, 7)}（generic-git 模式跳过平台 API）。\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls }))
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
  } else {
    const title = opts.title ?? `${ledger.caseType === 2 ? 'fix' : 'feat'}: ${ledger.slug}`
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
    }
  }

  ledger.lastSubmittedHead = currentHead
  ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, status: ledger.status, head: currentHead, prResult, commentResults, reviewSlotSync }, null, 2)}\n`)
  else {
    process.stdout.write(`submit 完成：已推分支 ${pushRemote}/${ledger.branch} @ ${shortHead}，状态=${ledger.status}\n`)
    if (prResult?.oneClickPrUrl) process.stdout.write(`- 一键创建 PR 链接：${prResult.oneClickPrUrl}\n`)
    if (prResult?.delegated) process.stdout.write(`- 待宿主 MCP 代理执行 PR 载荷：${JSON.stringify(prResult.jsonPayload)}\n`)
    printNextStep([
      ledger.role === 'contributor-fork'
        ? '当前处于 awaiting-upstream-merge，请等待上游维护者合并；合并前严禁删除该 Fork 分支。'
        : { skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
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
  writeTaskLedger(roots.mainRoot, ledger)
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
