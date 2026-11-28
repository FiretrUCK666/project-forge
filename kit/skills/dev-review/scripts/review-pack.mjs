#!/usr/bin/env node
/**
 * review-pack.mjs -- Context-isolated review pack builder, untrusted PR scanner,
 * doc-code parity checker, and 6-lock convergence ledger recorder.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 *
 * 子命令：
 *   pack | record | override | check-empirical | check-fault
 */

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, withNextSteps } from '../../lib/cli.mjs'
import { projectConcurrencyRadar } from '../../lib/concurrency-radar.mjs'
import { subcommandNamesFor } from '../../lib/subcommand-meta.mjs'
import { evaluateCoupledSync, parseCoupledSyncRules } from '../../lib/docs.mjs'
import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { gitRun, isMainModule, posixPath, readTextSafe, resolveRepoRoots } from '../../lib/git.mjs'
import {
  getCachedRangeDiffCommits, isAncestorLinearFast, readHeadFast, resolveGitDirFast, setCachedRangeDiffCommits,
} from '../../lib/git-fast.mjs'
import { listTaskLedgers, readTaskLedger, resolveTaskContext, sanitizeTaskId, updateTaskLedger, nextReviewRound } from '../../lib/ledger.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import { readPreInitState } from '../../lib/session-state.mjs'
import { readVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { assembleReviewContext, resolveDefaultBaseRef, validatePackCliArgs } from './review-context.mjs'
import {
  EXIT, collectDiff, computeDiffRange, hasCommits, resolveReviewWorktree,
  scanUntrustedDiff, syncTier2ReviewSlotIfNeeded,
} from './review-diff.mjs'
import {
  assessBehavioralGate, assessDoor, assessStructuralGate, buildPackNextSteps, checkDocCodeParity,
  collectGateWeakeningHits, collectHighRiskHits, formatPackText, parseAcceptanceCriteria,
} from './review-gates.mjs'
import {
  checkDirtyFaultResidueBeforeSync, computeEmpiricalRequirements, computeWorkspaceFingerprint,
  emitGateBlock, evaluateIncludeDiffGate, getEffectiveStatusEntries, handleCheckEmpirical,
  handleCheckFault, recordMechanicalPack,
} from './review-empirical.mjs'
import { readReceipt, resolveEmpiricalReceiptPath } from './review-empirical-state.mjs'
import { handleOverride, handleRecord } from './review-ledger.mjs'
import { parseRangeDiffNewCommits } from './review-locks.mjs'
import {
  emitIntakeRejectedBlock, emitPrUnresolvedBlock, ensurePrShasLocallyResolvable,
  evaluatePrIntakeGuard, isExternalPrTaskLedger, resolvePrForReviewPack,
} from './review-pr.mjs'

const SUBCOMMANDS = subcommandNamesFor('review-pack')

function printHelp() {
  process.stdout.write([
    '用法：node review-pack.mjs [pack|record|override|check-empirical|check-fault] [dir] [options]',
    '',
    'Modes:',
    '  pack                          Build context-isolated review pack (default mode)',
    '  --local                       Review working tree + staged uncommitted changes',
    '  --staged                      Review staged changes only',
    '  --base <ref>                  Review HEAD against <ref> (base...HEAD)',
    '  --task <id|auto> [--round N]  Build flow review pack (auto-syncs Tier 2 review-{id})',
    '  --pr <M>                      Build external/internal PR review pack (auto-runs untrusted scan)',
    '  check-empirical               Execute empirical / C* commands inside target review slot/worktree',
    '  check-fault                   Two-phase fault injection (--phase fail|restore --cmd "<command>")',
    '  record                        Record round verdict & track rebutted/resolved/stop-loss',
    '  override                      Unlock STOP_LOSS_ESCALATE with --human-approved --reason',
    '',
    'Options:',
    '  --worktree <path>             Explicit review worktree path',
    '  --dir <path>                  Repository directory (or pass positional <dir>)',
    '  --head <ref>                  Override head ref (default HEAD)',
    '  --untrusted-scan              Run static supply-chain & gate-weakening scan before execution',
    '  --human-approved-exec         Allow continuing past untrusted hazard gate (use --ignore-scripts)',
    '  --override-intake             Override BLOCKED_INTAKE_REJECTED for rejected/duplicate PRs (audited)',
    '  --include-diff                Embed full diffText/patch after empirical + fault-injection closure',
    '  --phase <fail|restore>        Phase for check-fault (fail = injected red test; restore = clean green check)',
    '  --cmd <command>               Repeatable verification command for check-empirical / check-fault',
    '  --reset-review-slot           Clean dirty Tier 2 review worktree before syncing HEAD (without --include-diff)',
    '  --json                        Emit machine-readable JSON',
    '',
    'Record / Override Options:',
    '  --task <id> --round <N> --verdict pass|changes --reviewer-id <id> --review-token <token>',
    '  [--implementer-id <id>] [--must-fix <textOrJson>...] [--should-fix <text>...]',
    '  [--pre-existing <text>...] [--disposition "<idOrFp>:<outcome>"...]',
    '  [--rebut-accepted <idOrFp>...] [--resolved <idOrFp>...] [--fault-injection <text>] [--summary <text>]',
    '  [--enforce-gates] [--no-enforce-gates] [--evidence <text>] [--artifact <path>]... [--e2e-evidence <text>] [--visual-blocked-reason <text>] [--visual-checked] [--visual-evidence <text>] [--no-escalate --reason <text>] [--human-approved] [--reason <text>]',
    '',
    `Exit Codes: 0=ok, 1=error, 2=usage/self-review, ${EXIT.FACT}=BLOCKED_EMPIRICAL_FIRST/DIRTY_RESIDUE/UNTRUSTED_HAZARD, ${EXIT.HUMAN}=STOP_LOSS_ESCALATE`,
    '',
  ].join('\n'))
}

async function resolveTaskForPack(roots, opts) {
  const { mainRoot } = roots
  const prVal = opts.pr ?? opts['external-pr']
  if (opts.task === 'auto' || (!opts.task && !opts.local && !opts.staged && !opts.base && !prVal && basename(roots.workTreeRoot).startsWith('review-'))) {
    try {
      const ctx = await resolveTaskContext(roots, { ...opts, task: undefined }, { requireExisting: true })
      return { taskId: ctx.taskId, task: ctx.ledger, mode: 'task' }
    } catch (err) {
      if (opts.task === 'auto') throw err
      return { taskId: null, task: null, mode: null }
    }
  }
  if (opts.task) {
    const taskId = sanitizeTaskId(opts.task)
    const ledger = readTaskLedger(mainRoot, taskId)
    if (!ledger) {
      throw new Error(`task ledger not found for "${taskId}" in ${posixPath(mainRoot)}/.worktrees/.state/tasks/`)
    }
    return { taskId, task: ledger, mode: 'task' }
  }
  if (prVal !== undefined) {
    const cleanPr = String(prVal).replace(/^#/, '').trim()
    const match = listTaskLedgers(mainRoot, { includeTerminal: true }).find((t) => String(t.prNumber) === cleanPr)
    return { taskId: match?.taskId ?? null, task: match ?? null, mode: 'pr' }
  }
  return { taskId: null, task: null, mode: null }
}

async function prepareReviewTargetContext(roots, opts, { syncSlot = true } = {}) {
  const { mainRoot } = roots
  const resolvedTask = await resolveTaskForPack(roots, opts)
  const task = resolvedTask.task
  const mode = opts.staged ? 'staged'
    : opts.local ? 'local'
      : resolvedTask.mode ? resolvedTask.mode
        : opts.base ? 'base' : 'local'
  const isFlowMode = Boolean(mode === 'task' || mode === 'pr')
  const taskExtPrNum = Number.isInteger(Number(task?.externalPr)) && Number(task?.externalPr) > 0 ? Number(task.externalPr) : null
  const prNo = opts.pr ?? opts['external-pr'] ?? task?.prNumber ?? taskExtPrNum ?? null
  const isExternalPrTask = isExternalPrTaskLedger(task)
  const requiresPrResolution = mode === 'pr' || isExternalPrTask

  let intakeGuard = prNo !== null && prNo !== undefined
    ? evaluatePrIntakeGuard({ mainRoot, gitDir: roots.gitDir, prNumber: prNo, opts })
    : null
  if (intakeGuard?.blocked) {
    return { earlyExitCode: emitIntakeRejectedBlock({ opts, exitCode: EXIT.FACT, guard: intakeGuard }) }
  }

  let prResolution = null
  if (requiresPrResolution) {
    const prArg = opts.pr ?? opts['external-pr'] ?? task?.prNumber ?? taskExtPrNum ?? null
    const prRes = await resolvePrForReviewPack({ mainRoot, roots, prNo: prArg, task, opts })
    if (!prRes.ok) {
      return {
        earlyExitCode: emitPrUnresolvedBlock({
          opts, exitCode: EXIT.FACT, prArg, reason: prRes.reason, message: prRes.message,
        }),
      }
    }
    prResolution = prRes
    intakeGuard = evaluatePrIntakeGuard({ mainRoot, gitDir: roots.gitDir, prNumber: prResolution.prNumber, prResolution, opts })
    if (intakeGuard.blocked) {
      return { earlyExitCode: emitIntakeRejectedBlock({ opts, exitCode: EXIT.FACT, guard: intakeGuard }) }
    }
  }

  let slotSyncRes = null
  const hasExistingReviewSlot = Boolean(
    mode === 'task' && task && (
      (task.reviewWorktreePath && existsSync(resolve(mainRoot, task.reviewWorktreePath)))
      || (task.taskId && existsSync(join(mainRoot, '.worktrees', `review-${task.taskId}`)))
    ),
  )
  const shouldPinExistingSlot = Boolean(opts['include-diff'] && hasExistingReviewSlot && !opts['reset-review-slot'])
  if (syncSlot && !shouldPinExistingSlot) {
    const dirtyCheck = await checkDirtyFaultResidueBeforeSync({ mainRoot, gitDir: roots.gitDir, opts, task, mode, prNo })
    if (dirtyCheck.blocked) {
      return {
        earlyExitCode: emitGateBlock({
          opts,
          code: dirtyCheck.code,
          payload: {
            status: dirtyCheck.code, code: dirtyCheck.code, exitCode: dirtyCheck.exitCode,
            mode: dirtyCheck.mode, round: dirtyCheck.round, targetRoot: dirtyCheck.targetRoot,
            dirtyFiles: dirtyCheck.dirtyFiles, unrestoredFault: dirtyCheck.unrestoredFault,
            nextSteps: dirtyCheck.nextSteps, error: dirtyCheck.message,
          },
          textLines: [
            dirtyCheck.code, `Worktree : ${dirtyCheck.targetRoot}`, `Reason   : ${dirtyCheck.message}`, '',
            '[NEXT STEP]', ...dirtyCheck.nextSteps.map((s) => `  - ${s}`),
          ],
        }),
      }
    }
    slotSyncRes = await syncTier2ReviewSlotIfNeeded({ mainRoot, worktreeRoot: roots.workTreeRoot, opts, task, mode })
  }

  const reviewRoot = await resolveReviewWorktree(mainRoot, roots.workTreeRoot, opts, task)

  let round = opts.round ? Number(opts.round) : 1
  if (!opts.round && task?.rounds?.length) {
    round = nextReviewRound(task)
  }
  if (!Number.isInteger(round) || round < 1) round = 1

  let headRef = opts.head ?? 'HEAD'
  let headSha
  if (prResolution && !opts.head) {
    const shaCheck = await ensurePrShasLocallyResolvable({ reviewRoot, mainRoot, prResolution, opts })
    if (!shaCheck.ok) {
      return {
        earlyExitCode: emitPrUnresolvedBlock({
          opts,
          exitCode: EXIT.FACT,
          prArg: prResolution.prNumber,
          reason: shaCheck.reason,
          message: shaCheck.message,
        }),
      }
    }
    headRef = prResolution.headRefOid
    headSha = prResolution.headRefOid
  } else {
    const fastHeadSha = headRef === 'HEAD' ? readHeadFast(resolveGitDirFast(reviewRoot), roots.gitDir)?.oid : null
    headSha = fastHeadSha
    if (!headSha) {
      const commitsExist = await hasCommits(reviewRoot)
      const headRes = commitsExist ? await gitRun(reviewRoot, ['rev-parse', headRef]) : { ok: false, stdout: 'UNBORN' }
      if (commitsExist && opts.head && !headRes.ok) {
        process.stderr.write(`Error: cannot resolve --head "${headRef}": ${headRes.stderr}\n`)
        return { earlyExitCode: EXIT.ACTION }
      }
      headSha = headRes.ok ? headRes.stdout.trim() : 'UNBORN'
    }
  }

  let baseRef = opts.base ?? null
  let diffSpec
  let diffScope
  let roundLockNote = ''
  let priorOpenMustFix = []
  let rebuts = []

  if (mode === 'local' || mode === 'staged') {
    diffSpec = { mode }
    diffScope = mode === 'staged' ? 'staged index' : 'working tree + staged index'
  } else if (prResolution) {
    baseRef = prResolution.baseRefOid
    diffSpec = { mode: 'range', range: await computeDiffRange(reviewRoot, prResolution.baseRefOid, headRef) }
    diffScope = `${prResolution.baseRefOid}...${headSha}`
    roundLockNote = `PR #${prResolution.prNumber} exact SHA diff (${prResolution.baseRefOid.slice(0, 8)}...${headSha.slice(0, 8)})`
  } else {
    baseRef = opts.base ?? task?.baseSha ?? task?.baseBranch ?? (await resolveDefaultBaseRef(reviewRoot, headRef))
    if (mode === 'task' && round >= 2 && Array.isArray(task?.rounds) && task.rounds.length > 0) {
      const targetPrevRound = round === 2 ? 1 : round - 1
      const prev = task.rounds.find((r) => r.round === targetPrevRound) ?? task.rounds[task.rounds.length - 1]
      priorOpenMustFix = prev ? (prev.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved') : []
      rebuts = [...(Array.isArray(task.rebuts) ? task.rebuts : []), ...(Array.isArray(prev?.rebuts) ? prev.rebuts : [])]
      const prevHead = prev?.headSha
      const hasPrevLoose = Boolean(
        prevHead && /^[0-9a-f]{40}$/i.test(prevHead) && roots.gitDir
        && existsSync(join(roots.gitDir, 'objects', prevHead.slice(0, 2).toLowerCase(), prevHead.slice(2).toLowerCase())),
      )
      if (prevHead && (hasPrevLoose || (await gitRun(reviewRoot, ['rev-parse', '--verify', prevHead])).ok)) {
        const fastAnc = headSha && headSha !== 'UNBORN' && roots.gitDir
          ? isAncestorLinearFast(roots.gitDir, prevHead, headSha)
          : null
        const isAnc = fastAnc !== null
          ? { ok: fastAnc }
          : await gitRun(reviewRoot, ['merge-base', '--is-ancestor', prevHead, headRef])
        const oldBase = prev?.baseSha ?? task?.roundBaseSha?.prevBaseSha
        const newBase = task?.baseSha ?? task?.roundBaseSha?.newBaseSha ?? baseRef
        if (!isAnc.ok && oldBase && newBase) {
          if (oldBase === prevHead) {
            diffSpec = { mode: 'range', range: `${newBase}..${headRef}` }
            diffScope = `${newBase.slice(0, 8)}..${headSha.slice(0, 8)} (Round ${round} rebased)`
            roundLockNote = `Round ${round} rebased via sync`
          } else {
            const oldR = `${oldBase}..${prevHead}`
            const newR = `${newBase}..${headSha}`
            const cachedShas = /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(oldR) && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(newR) && roots.gitDir
              ? getCachedRangeDiffCommits(roots.gitDir, oldR, newR)
              : null
            let shas = cachedShas
            if (!shas) {
              const rd = await gitRun(reviewRoot, ['range-diff', '--no-color', oldR, newR])
              if (rd.ok) {
                shas = parseRangeDiffNewCommits(rd.stdout)
                if (roots.gitDir && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(oldR) && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(newR)) {
                  setCachedRangeDiffCommits(roots.gitDir, oldR, newR, shas)
                }
              }
            }
            if (shas) {
              diffSpec = { mode: 'commits', commits: shas }
              diffScope = `range-diff (${shas.length} changed/new commit(s))`
              roundLockNote = `Round ${round} rebased via sync (range-diff incremental lock)`
            }
          }
        }
        if (!diffSpec) {
          diffSpec = { mode: 'range', range: `${prevHead}..${headRef}` }
          diffScope = `${prevHead.slice(0, 8)}..${headSha.slice(0, 8)} (Round ${round} incremental)`
          roundLockNote = round === 2
            ? 'R1 unchanged hunks LOCKED; review open Must-Fix + R1_HEAD..HEAD + rebuts only'
            : `R${targetPrevRound}_HEAD..HEAD binary Pass/Fail verification only; no new findings`
        }
      } else if (baseRef) {
        diffSpec = { mode: 'range', range: await computeDiffRange(reviewRoot, baseRef, headRef) }
        diffScope = `${baseRef}...${headRef}`
        roundLockNote = `Round ${round} (prior head unavailable; fell back to base diff)`
      }
    }
    if (!diffSpec) {
      if (!baseRef) {
        process.stderr.write('Error: cannot resolve base ref (unborn or single-commit repo); pass --base <ref>.\n')
        return { earlyExitCode: EXIT.ACTION }
      }
      diffSpec = { mode: 'range', range: await computeDiffRange(reviewRoot, baseRef, headRef) }
      diffScope = `${baseRef}...${headRef}`
      if (mode === 'task') roundLockNote = 'Round 1 full diff'
    }
  }

  const diff = await collectDiff(reviewRoot, diffSpec)
  const reviewProfile = parseDevProfile(reviewRoot)
  const effectiveProfile = existsSync(join(reviewRoot, 'AGENTS.md')) ? reviewProfile : parseDevProfile(mainRoot)

  return {
    task, mode, isFlowMode, prNo, prResolution, intakeGuard, baseRef, slotSyncRes, reviewRoot, round, headSha,
    diffSpec, diffScope, roundLockNote, priorOpenMustFix, rebuts, diff, effectiveProfile,
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return EXIT.OK
  }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      allowPositionalWithoutSubcommand: true,
      positionalDir: 'auto',
      booleanFlags: [
        'local', 'staged', 'untrusted-scan', 'human-approved-exec', 'override-intake',
        'human-approved', 'include-diff', 'visual-checked',
        'reset-review-slot', 'enforce-gates', 'no-enforce-gates', 'escalate', 'no-escalate',
      ],
      valueFlags: [
        'worktree', 'base', 'head', 'task', 'pr', 'external-pr', 'issue', 'round',
        'review-token', 'phase',
        'verdict', 'reviewer-id', 'implementer-id', 'fault-injection', 'criteria-status',
        'summary', 'reason', 'e2e-evidence', 'visual-evidence', 'visual-blocked-reason', 'agent', 'evidence',
      ],
      multiFlags: ['cmd', 'artifact', 'must-fix', 'should-fix', 'pre-existing', 'disposition', 'rebut-accepted', 'resolved'],
      usageHint: `review-pack.mjs [${SUBCOMMANDS.join('|')}] [dir] [options]`,
    })
    validatePackCliArgs(cli, SUBCOMMANDS)
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    return EXIT.USAGE
  }

  const { sub, opts } = cli
  opts.humanApprovedExec = Boolean(opts['human-approved-exec'])
  const startDir = opts.worktree ? resolve(String(opts.worktree)) : cli.targetDir
  const roots = await resolveRepoRoots(startDir)
  if (!roots.isGit) {
    process.stderr.write(`Error: not inside a git repository: ${startDir}\n`)
    return EXIT.ACTION
  }

  try {
    if (sub === 'record') return await handleRecord(opts, roots)
    if (sub === 'override') return await handleOverride(opts, roots)

    const { mainRoot } = roots
    if (sub === 'check-empirical' || sub === 'check-fault') {
      const ctx = await prepareReviewTargetContext(roots, opts, { syncSlot: false })
      if (ctx.earlyExitCode !== undefined) return ctx.earlyExitCode
      const parity = checkDocCodeParity(ctx.reviewRoot, mainRoot, ctx.diff, ctx.effectiveProfile, ctx.task)
      const gateWeakenedHits = collectGateWeakeningHits(ctx.reviewRoot, ctx.diff)
      const evidence = ctx.task?.taskId ? readVerificationEvidence(roots.gitDir, ctx.task.taskId) : null
      const receipt = readReceipt(resolveEmpiricalReceiptPath({ gitDir: roots.gitDir, mode: ctx.mode, task: ctx.task, prNo: ctx.prNo, reviewRoot: ctx.reviewRoot, baseRef: ctx.baseRef }))
      const behavioralGate = assessBehavioralGate({
        diff: ctx.diff,
        devProfile: ctx.effectiveProfile,
        task: ctx.task,
        headSha: ctx.headSha,
        gateWeakenedHits,
        parity,
        untrustedAdvisories: [],
        evidence,
        receipt,
        reviewRoot: ctx.reviewRoot,
      })
      const reviewContext = await assembleReviewContext({
        reviewRoot: ctx.reviewRoot, mainRoot, gitDir: roots.gitDir, diff: ctx.diff,
        effectiveProfile: ctx.effectiveProfile, baseRef: ctx.baseRef, task: ctx.task,
      })
      const empCtx = { ...ctx, opts, roots, behavioralGate, gateWeakenedHits, scanUntrustedDiff, reviewContext }
      return sub === 'check-empirical'
        ? await handleCheckEmpirical(empCtx)
        : await handleCheckFault(empCtx)
    }

    const ctx = await prepareReviewTargetContext(roots, opts, { syncSlot: true })
    if (ctx.earlyExitCode !== undefined) return ctx.earlyExitCode
    const {
      task, mode, isFlowMode, prNo, prResolution, intakeGuard, baseRef, slotSyncRes, reviewRoot, round, headSha,
      diffScope, roundLockNote, priorOpenMustFix, rebuts, diff, effectiveProfile,
    } = ctx

    const shouldScanUntrusted = Boolean(
      opts['untrusted-scan'] || opts.pr !== undefined || opts['external-pr'] !== undefined || isExternalPrTaskLedger(task),
    )
    let untrustedWarnings = []
    let untrustedAdvisories = []
    if (shouldScanUntrusted) {
      const scanRes = scanUntrustedDiff(diff, reviewRoot)
      const hazards = scanRes.hazards
      untrustedAdvisories = scanRes.advisories
      // 放行点统一判据：绕过不可信高危扫描是「弱化门禁」里最重的一个，
  // 所以理由必须实质——说清看过哪些高危项、为什么仍可执行、怎么隔离。
  // 只查非空等于给一句占位词留门，而这道门后面直接是「在不可信代码上跑脚本」。
  //
  // 两条旁路都要过这一关，一条都不能漏：
  // - `--human-approved-exec`：允许在不可信代码上执行；
  // - `--human-approved`：允许把这次扫描记为「已批准」，之后不再拦。
  // 后者更隐蔽——它当场不执行任何东西，却让账本从此对这段 diff 放行。
  if (opts.humanApprovedExec || opts['human-approved']) {
    // 两个开关的语义不同，理由要问的东西也不同：
    // 执行侧要「怎么隔离」，记账侧要「凭什么判定这批改动可信」。混成一句会让人写套话。
    const subject = opts.humanApprovedExec
      ? '在不可信代码上执行的理由'
      : '把不可信扫描记为已批准的理由'
    const reasonCheck = evaluateReleaseReason(opts.reason, { subject })
    if (!reasonCheck.ok) {
      const flags = opts.humanApprovedExec ? '--human-approved-exec' : '--human-approved'
      const msg = `${reasonCheck.code}: ${reasonCheck.reason} ${flags} 必须写清：看过哪些高危项、为什么判定可接受、怎么隔离或复核。\n`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: reasonCheck.code, status: reasonCheck.code, message: msg.trim() }, null, 2)}\n`)
      process.stderr.write(msg)
      return EXIT.USAGE
    }
    opts.releaseReason = reasonCheck.cleaned
  }
  if (hazards.length > 0 && !opts.humanApprovedExec) {
        const hazardNext = 'Do NOT mount dependencies or run tests. Show these hazards to a human maintainer; only re-run with --human-approved-exec --reason "<原因>" (and use --ignore-scripts) after explicit approval.'
        const payload = withNextSteps({
          status: 'BLOCKED_UNTRUSTED_HAZARD',
          exitCode: EXIT.FACT,
          diffScope,
          headSha,
          hazards,
          advisories: untrustedAdvisories,
          nextStep: hazardNext,
        }, [hazardNext])
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        } else {
          const lines = [
            'BLOCKED_UNTRUSTED_HAZARD',
            `Scope    : ${diffScope} (HEAD ${headSha})`,
            `Exit Code: ${EXIT.FACT}`,
            'High-risk / supply-chain or gate-weakening changes detected before execution:',
            ...hazards.flatMap((h) => [
              `  - [${h.category}] ${h.file}: ${h.reason}`,
              ...h.excerpt.map((e) => `      ${e}`),
            ]),
            '',
            '[NEXT STEP]',
            '  1. Read-only inspect the flagged diff above; DO NOT mount deps or execute tests/scripts.',
            '  2. Ask a human maintainer for explicit sign-off.',
            '  3. Only if approved, re-run with `--human-approved-exec --reason "<原因>"` and isolate installs using `--ignore-scripts`.',
          ]
          process.stdout.write(`${lines.join('\n')}\n`)
        }
        process.stderr.write(`BLOCKED_UNTRUSTED_HAZARD: ${hazards.length} high-risk change(s) detected (exit ${EXIT.FACT})\n`)
        return EXIT.FACT
      }
      untrustedWarnings = hazards
      if (task && isExternalPrTaskLedger(task)) {
        const { ledger: nextTask } = await updateTaskLedger(mainRoot, task.taskId, (cur) => ({
          ...cur,
          untrustedScanPassed: true,
          // 账本里记一笔「这次为什么放行」：只写 untrustedApproved 而不留理由，
    // 后来读账本的人只能看到「批准过」，看不到「凭什么」——那正是本片要治的失真。
    ...(opts['human-approved'] || opts.humanApprovedExec
      ? { untrustedApproved: true, humanApprovedExec: Boolean(opts.humanApprovedExec), untrustedApprovedReason: opts.releaseReason ?? null }
      : {}),
        }))
        Object.assign(task, nextTask)
      }
    }

    const parity = checkDocCodeParity(reviewRoot, mainRoot, diff, effectiveProfile, task)
    const agentsForSync = readTextSafe(join(reviewRoot, 'AGENTS.md')) ?? readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
    const syncRoot = existsSync(join(reviewRoot, 'AGENTS.md')) ? reviewRoot : mainRoot
    const coupledSyncWarnings = agentsForSync
      ? evaluateCoupledSync([...diff.files.map((f) => f.file), ...diff.untracked], parseCoupledSyncRules(agentsForSync), syncRoot)
      : []
    const criteria = parseAcceptanceCriteria(reviewRoot, mainRoot, task)
    const hrHits = collectHighRiskHits(diff, effectiveProfile)
    const gateWeakenedHits = collectGateWeakeningHits(reviewRoot, diff)

    const evidence = task?.taskId ? readVerificationEvidence(roots.gitDir, task.taskId) : null
    const receipt = readReceipt(resolveEmpiricalReceiptPath({ gitDir: roots.gitDir, mode, task, prNo, reviewRoot, baseRef }))
    const behavioralGate = assessBehavioralGate({
      diff, devProfile: effectiveProfile, task, headSha, gateWeakenedHits, parity, untrustedAdvisories, evidence, receipt, reviewRoot,
    })
    const structuralGate = assessStructuralGate({ reviewRoot, mainRoot, diff, devProfile: effectiveProfile, parity })
    const doorAssessment = assessDoor({
      reviewRoot, mainRoot, diff, devProfile: effectiveProfile, hrHits, parity, task, gateWeakenedHits,
    })

    let headMismatchWarning = ''
    if (task) {
      if (task.verifiedHead && headSha !== 'UNBORN' && task.verifiedHead !== headSha) {
        headMismatchWarning = `verifiedHead (${task.verifiedHead.slice(0, 8)}) != review HEAD (${headSha.slice(0, 8)}); re-verify required!`
      }
      if (mode === 'task' && round >= 2 && task.rounds?.length) {
        const prev = task.rounds[task.rounds.length - 1]
        if (prev?.headSha && prev.headSha === headSha) {
          headMismatchWarning = `HEAD (${headSha.slice(0, 8)}) has not advanced since Round ${prev.round}; reject re-review until implementer adds a fix commit.`
        }
      }
    }

    const reviewContext = await assembleReviewContext({
      reviewRoot, mainRoot, gitDir: roots.gitDir, diff, effectiveProfile, baseRef, headSha, task,
    })

    const includeDiff = Boolean(opts['include-diff'])
    const dirtyEntries = await getEffectiveStatusEntries(reviewRoot, mainRoot)
    const workspaceFingerprint = await computeWorkspaceFingerprint({
      reviewRoot, mainRoot, headSha, diff, statusEntries: dirtyEntries,
    })
    const empiricalRequirements = computeEmpiricalRequirements({
      diff, behavioralGate, effectiveProfile, task, gateWeakenedHits, reviewContext, repoRoot: reviewRoot,
    })
    const evalGateArgs = {
      gitDir: roots.gitDir, mode, task, round, prNo, baseRef, reviewRoot, mainRoot, headSha,
      diffScope, workspaceFingerprint, dirtyEntries, requirements: empiricalRequirements, behavioralGate, opts,
      diffText: diff?.text ?? null,
    }
    let empiricalGate = evaluateIncludeDiffGate(evalGateArgs)

    if (includeDiff && !empiricalGate.readyForDiff) {
      const onlyVisualMissing = !empiricalGate.dirtyFaultResidue
        && !empiricalGate.shallowE2eEvidence
        && !empiricalGate.artifactBlock
        && empiricalGate.missingSteps.length > 0
        && empiricalGate.missingSteps.includes('visual-check')
        && empiricalGate.missingSteps.every((s) => s === 'visual-check' || s === 'e2e-observation')
      const blockCode = empiricalGate.dirtyFaultResidue
        ? 'BLOCKED_DIRTY_FAULT_RESIDUE'
        : (empiricalGate.staticDocBlock
            ? empiricalGate.staticDocBlock.code
            : (empiricalGate.shallowE2eEvidence
                ? 'BLOCKED_SHALLOW_E2E_EVIDENCE'
                : (empiricalGate.artifactBlock
                    ? empiricalGate.artifactBlock.code
                    : (onlyVisualMissing ? 'BLOCKED_VISUAL_EVIDENCE_REQUIRED' : 'BLOCKED_EMPIRICAL_FIRST'))))
      const msg = blockCode === 'BLOCKED_DIRTY_FAULT_RESIDUE'
        ? 'BLOCKED_DIRTY_FAULT_RESIDUE: 当前工作位存在未还原复绿的故障注入残留，禁止输出 --include-diff。'
        : (blockCode === 'BLOCKED_STATIC_DOC_CHECK_FAILED'
            ? empiricalGate.staticDocBlock.reason
            : (blockCode === 'BLOCKED_SHALLOW_E2E_EVIDENCE'
                ? `${empiricalGate.shallowE2eEvidence.code}: ${empiricalGate.shallowE2eEvidence.reason}`
                : (empiricalGate.artifactBlock
                    ? empiricalGate.artifactBlock.reason
                    : (onlyVisualMissing && empiricalGate.visualBlock
                        ? empiricalGate.visualBlock.reason
                        : `BLOCKED_EMPIRICAL_FIRST: 尚未完成当前轮次/指纹的业务流实证与故障注入闭环（缺失：${empiricalGate.missingSteps.join(', ')}），禁止输出 --include-diff。`))))
      const payload = {
        status: blockCode, code: blockCode, exitCode: EXIT.FACT, mode, round, headSha,
        diffScope, workspaceFingerprint, missingSteps: empiricalGate.missingSteps,
        ...(empiricalGate.artifactBlock
          ? { artifactErrors: empiricalGate.artifactBlock.errors, uiFiles: empiricalGate.artifactBlock.uiFiles }
          : {}),
        unblockCommands: empiricalGate.unblockCommands, nextSteps: empiricalGate.unblockCommands,
        affectedBusinessFlows: reviewContext.affectedBusinessFlows,
        adjacentModules: reviewContext.adjacentModules,
        empiricalTaskOrder: reviewContext.empiricalTaskOrder,
        solidificationHints: reviewContext.solidificationHints,
        empiricalGate, error: msg,
      }
      const textLines = [
        blockCode,
        `Scope    : ${diffScope} (HEAD ${headSha === 'UNBORN' ? 'UNBORN' : headSha.slice(0, 8)})`,
        `Target   : ${posixPath(reviewRoot)} | Fingerprint: ${workspaceFingerprint.slice(0, 12)}`,
        `Missing  : ${empiricalGate.missingSteps.length > 0 ? empiricalGate.missingSteps.join(', ') : (empiricalGate.artifactBlock ? empiricalGate.artifactBlock.code : 'restore verification required')}`,
        ...(reviewContext.affectedBusinessFlows.length > 0 ? [`Flows    : ${reviewContext.affectedBusinessFlows.slice(0, 4).join(' ; ')}`] : []),
        `Strategy : ${reviewContext.empiricalTaskOrder.strategy}`,
        `Exit Code: ${EXIT.FACT}`, '', '[NEXT STEP]',
        ...empiricalGate.unblockCommands.map((c, idx) => `  ${idx + 1}. ${c}`),
      ]
      return emitGateBlock({ opts, code: blockCode, payload, textLines })
    }

    if (!includeDiff) {
      recordMechanicalPack({
        gitDir: roots.gitDir, mode, task, round, prNo, baseRef, reviewRoot, headSha, diffScope, workspaceFingerprint,
        untrustedScanClean: shouldScanUntrusted ? untrustedWarnings.length === 0 : undefined,
        humanApprovedExec: opts.humanApprovedExec,
      })
      empiricalGate = evaluateIncludeDiffGate(evalGateArgs)
    }

    const nextSteps = buildPackNextSteps({
      opts, mode, task, round, mainRoot, untrustedWarnings, doorAssessment, structuralGate, empiricalGate, reviewContext,
    })

    const { contextBrief, ...reviewContextRest } = reviewContext ?? {}
    const concurrencyRadar = projectConcurrencyRadar(mainRoot, {
      currentTaskId: task?.taskId ?? null,
      currentWorkRoot: reviewRoot,
      currentFiles: diff.files.map((f) => f.file),
      baseBranch: task?.baseBranch ?? null,
      baseSha: task?.baseSha ?? null,
    })
    const activeTopicRaw = readPreInitState(mainRoot, {
      taskId: task?.taskId ?? null,
      slug: task?.slug ?? null,
      branch: task?.branch ?? null,
      worktreePath: task?.worktreePath ?? null,
    })
    const activeTopic = activeTopicRaw ? { topicId: activeTopicRaw.topicId, decisions: activeTopicRaw.decisions ?? [], deadEnds: activeTopicRaw.deadEnds ?? [] } : null
    const pack = {
      status: opts['untrusted-scan'] && untrustedWarnings.length === 0 ? 'UNTRUSTED_SCAN_PASS' : 'PACK_READY',
      mode,
      isFlowMode,
      worktreeRoot: posixPath(reviewRoot),
      mainRoot: posixPath(mainRoot),
      round,
      roundLockNote,
      diffScope,
      headSha,
      ...(prResolution ? {
        pr: {
          number: prResolution.prNumber, baseRefOid: prResolution.baseRefOid, headRefOid: prResolution.headRefOid,
          baseBranch: prResolution.baseBranch, headBranch: prResolution.headBranch, url: prResolution.url,
          state: prResolution.state, labels: prResolution.labels ?? [],
        },
      } : {}),
      ...(intakeGuard && (intakeGuard.overridden || intakeGuard.decision || intakeGuard.sources?.length > 0) ? { intakeGuard } : {}),
      ...(slotSyncRes ? { reviewSlotSync: slotSyncRes } : {}),
      ...(includeDiff ? { diffText: diff.text } : {}),
      diff: {
        sha256: diff.sha256,
        bytes: diff.bytes,
        files: diff.files,
        untracked: diff.untracked,
        hunkIndex: diff.hunkIndex,
        summary: diff.summary,
        diffIncluded: includeDiff,
        ...(!includeDiff ? { includeDiffHint: 'Pass --include-diff after empirical & fault-injection closure to embed full diffText in JSON' } : {}),
      },
      task: task ?? null,
      explored: task?.explored ?? null,
      criteria,
      priorOpenMustFix,
      rebuts,
      parity,
      coupledSyncWarnings,
      devProfile: effectiveProfile,
      highRiskHits: hrHits,
      behavioralGate,
      structuralGate,
      doorAssessment,
      reviewContext: reviewContextRest,
      contextBrief: contextBrief ?? null,
      concurrencyRadar,
      activeTopic,
      empiricalGate,
      untrustedWarnings,
      untrustedAdvisories,
      headMismatchWarning,
      nextSteps,
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`)
    } else {
      process.stdout.write(`${formatPackText(pack, diff.text, includeDiff)}\n`)
    }
    return EXIT.OK
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.ACTION
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
