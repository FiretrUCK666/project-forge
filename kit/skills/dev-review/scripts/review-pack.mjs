#!/usr/bin/env node
/**
 * review-pack.mjs -- Context-isolated review pack builder, untrusted PR scanner,
 * doc-code parity checker, and 6-lock convergence ledger recorder.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { parseStandardCli } from '../../lib/cli.mjs'
import { evaluateCoupledSync, parseCoupledSyncRules } from '../../lib/docs.mjs'
import {
  gitRun, isMainModule, posixPath, readTextSafe, resolveDefaultBranch, resolveRepoRoots,
} from '../../lib/git.mjs'
import { listTaskLedgers, readTaskLedger, resolveTaskContext, sanitizeTaskId } from '../../lib/ledger.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import { parsePrNumber } from '../../lib/platform.mjs'
import {
  EXIT, collectDiff, computeDiffRange, hasCommits, resolveReviewWorktree,
  scanUntrustedDiff, syncTier2ReviewSlotIfNeeded,
} from './review-diff.mjs'
import {
  assessBehavioralGate, assessDoor, assessStructuralGate, checkDocCodeParity,
  collectGateWeakeningHits, collectHighRiskHits, parseAcceptanceCriteria,
} from './review-gates.mjs'
import { buildPackNextSteps, formatPackText, handleOverride, handleRecord } from './review-ledger.mjs'

const SUBCOMMANDS = ['pack', 'record', 'override']

function printHelp() {
  process.stdout.write([
    '用法：node review-pack.mjs [pack|record|override] [dir] [options]',
    '',
    'Modes:',
    '  --local                       Review working tree + staged uncommitted changes',
    '  --staged                      Review staged changes only',
    '  --base <ref>                  Review HEAD against <ref> (base...HEAD)',
    '  --task <id|auto> [--round N]  Build flow review pack (auto-syncs Tier 2 review-{id})',
    '  --pr <M>                      Build external/internal PR review pack (auto-runs untrusted scan)',
    '  record                        Record round verdict & track rebutted/resolved/stop-loss',
    '  override                      Unlock STOP_LOSS_ESCALATE with --human-approved --reason',
    '',
    'Options:',
    '  --worktree <path>             Explicit review worktree path',
    '  --dir <path>                  Repository directory (or pass positional <dir>)',
    '  --head <ref>                  Override head ref (default HEAD)',
    '  --untrusted-scan              Run static supply-chain & gate-weakening scan before execution',
    '  --human-approved-exec         Allow continuing past untrusted hazard gate (use --ignore-scripts)',
    '  --include-diff                Embed full diffText inside --json output (default: hunk summary only)',
    '  --json                        Emit machine-readable JSON',
    '',
    'Record / Override Options:',
    '  --task <id> --round <N> --verdict pass|changes --reviewer-id <id>',
    '  [--implementer-id <id>] [--must-fix <textOrJson>...] [--should-fix <text>...]',
    '  [--rebut-accepted <idOrFp>...] [--resolved <idOrFp>...] [--fault-injection <text>]',
    '  [--visual-checked] [--visual-evidence <text>] [--human-approved] [--reason <text>]',
    '',
    `Exit Codes: 0=ok, 1=error, 2=usage/self-review, ${EXIT.UNTRUSTED_HAZARD}=BLOCKED_UNTRUSTED_HAZARD, ${EXIT.STOP_LOSS}=STOP_LOSS_ESCALATE`,
    '',
  ].join('\n'))
}

async function resolveDefaultBaseRef(repoRoot, headRef) {
  const sym = await gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (sym.ok && sym.stdout.trim()) {
    const ref = sym.stdout.trim()
    if ((await gitRun(repoRoot, ['rev-parse', '--verify', ref])).ok) return ref
  }
  const def = await resolveDefaultBranch(repoRoot)
  for (const cand of [def, 'main', 'master', `origin/${def}`, 'origin/main', 'origin/master', 'trunk'].filter(Boolean)) {
    if ((await gitRun(repoRoot, ['rev-parse', '--verify', cand])).ok) return cand
  }
  if ((await gitRun(repoRoot, ['rev-parse', '--verify', `${headRef}~1`])).ok) return `${headRef}~1`
  return undefined
}

function validateCliArgs(cli) {
  const { sub, opts } = cli
  if (!sub && opts._.length === 1) {
    const posPr = parsePrNumber(String(opts._[0]).trim())
    if (posPr !== null && opts.pr === undefined && opts['external-pr'] === undefined) {
      opts.pr = String(posPr)
      opts._.shift()
    }
  }
  if (opts.pr !== undefined) {
    const prNum = parsePrNumber(opts.pr, { strict: true })
    if (prNum !== null) opts.pr = String(prNum)
  }
  if (opts['external-pr'] !== undefined) {
    const extNum = parsePrNumber(opts['external-pr'], { strict: true })
    if (extNum !== null) opts['external-pr'] = String(extNum)
  }
  if (opts._.length > 1) {
    throw new Error(`多余的位置参数：${opts._.slice(1).join(' ')}`)
  }
  if (opts._.length === 1) {
    const cand = resolve(String(opts._[0]))
    if (opts.dir !== undefined) {
      throw new Error(`未知参数或重复目录：${opts._[0]}`)
    }
    if (!existsSync(cand) || !statSync(cand).isDirectory()) {
      throw new Error(`未知子命令或不存在的目录：${opts._[0]}`)
    }
  }
  if (sub && !SUBCOMMANDS.includes(sub)) {
    throw new Error(`未知子命令：${sub}`)
  }

  const hasLocal = Boolean(opts.local)
  const hasStaged = Boolean(opts.staged)
  const hasTask = opts.task !== undefined
  const hasPr = opts.pr !== undefined || opts['external-pr'] !== undefined
  const hasBase = opts.base !== undefined

  if (hasLocal && (hasStaged || hasTask || hasPr || hasBase)) {
    throw new Error('--local 与 --staged/--task/--pr/--base 互斥，不能同时指定')
  }
  if (hasStaged && (hasTask || hasPr || hasBase)) {
    throw new Error('--staged 与 --task/--pr/--base 互斥，不能同时指定')
  }
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

async function main() {
  const argv = process.argv.slice(2)
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
        'local', 'staged', 'untrusted-scan', 'human-approved-exec',
        'human-approved', 'include-diff', 'visual-checked',
      ],
      valueFlags: [
        'worktree', 'base', 'head', 'task', 'pr', 'external-pr', 'issue', 'round',
        'verdict', 'reviewer-id', 'implementer-id', 'fault-injection', 'criteria-status',
        'reason', 'visual-evidence', 'agent',
      ],
      multiFlags: ['must-fix', 'should-fix', 'rebut-accepted', 'resolved'],
      usageHint: 'review-pack.mjs [pack|record|override] [dir] [options]',
    })
    validateCliArgs(cli)
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const { sub, opts } = cli
  opts.humanApprovedExec = Boolean(opts['human-approved-exec'])
  const startDir = opts.worktree ? resolve(String(opts.worktree)) : cli.targetDir
  const roots = await resolveRepoRoots(startDir)
  if (!roots.isGit) {
    process.stderr.write(`Error: not inside a git repository: ${startDir}\n`)
    return EXIT.ERROR
  }

  try {
    if (sub === 'record') return await handleRecord(opts, roots)
    if (sub === 'override') return await handleOverride(opts, roots)

    const { mainRoot } = roots
    const resolvedTask = await resolveTaskForPack(roots, opts)
    const task = resolvedTask.task
    const mode = opts.staged ? 'staged'
      : opts.local ? 'local'
        : resolvedTask.mode ? resolvedTask.mode
          : opts.base ? 'base' : 'local'
    const isFlowMode = Boolean(mode === 'task' || mode === 'pr')

    const slotSyncRes = await syncTier2ReviewSlotIfNeeded({
      mainRoot,
      worktreeRoot: roots.workTreeRoot,
      opts,
      task,
      mode,
    })

    const reviewRoot = await resolveReviewWorktree(mainRoot, roots.workTreeRoot, opts, task)

    let round = opts.round ? Number(opts.round) : 1
    if (!opts.round && task?.rounds?.length) {
      round = Math.max(...task.rounds.map((r) => Number(r.round) || 1)) + 1
    }
    if (!Number.isInteger(round) || round < 1) round = 1

    const headRef = opts.head ?? 'HEAD'
    const commitsExist = await hasCommits(reviewRoot)
    const headRes = commitsExist ? await gitRun(reviewRoot, ['rev-parse', headRef]) : { ok: false, stdout: 'UNBORN' }
    if (commitsExist && opts.head && !headRes.ok) {
      process.stderr.write(`Error: cannot resolve --head "${headRef}": ${headRes.stderr}\n`)
      return EXIT.ERROR
    }
    const headSha = headRes.ok ? headRes.stdout.trim() : 'UNBORN'

    let diffSpec
    let diffScope
    let roundLockNote = ''
    let priorOpenMustFix = []
    let rebuts = []

    if (mode === 'local' || mode === 'staged') {
      diffSpec = { mode }
      diffScope = mode === 'staged' ? 'staged index' : 'working tree + staged index'
    } else {
      const baseRef = opts.base ?? task?.baseSha ?? task?.baseBranch ?? (await resolveDefaultBaseRef(reviewRoot, headRef))
      if (mode === 'task' && round >= 2 && Array.isArray(task?.rounds) && task.rounds.length > 0) {
        const targetPrevRound = round === 2 ? 1 : round - 1
        const prev = task.rounds.find((r) => r.round === targetPrevRound) ?? task.rounds[task.rounds.length - 1]
        priorOpenMustFix = prev ? (prev.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved') : []
        rebuts = [...(Array.isArray(task.rebuts) ? task.rebuts : []), ...(Array.isArray(prev?.rebuts) ? prev.rebuts : [])]
        const prevHead = prev?.headSha
        if (prevHead && (await gitRun(reviewRoot, ['rev-parse', '--verify', prevHead])).ok) {
          diffSpec = { mode: 'range', range: `${prevHead}..${headRef}` }
          diffScope = `${prevHead.slice(0, 8)}..${headSha.slice(0, 8)} (Round ${round} incremental)`
          roundLockNote = round === 2
            ? 'R1 unchanged hunks LOCKED; review open Must-Fix + R1_HEAD..HEAD + rebuts only'
            : `R${targetPrevRound}_HEAD..HEAD binary Pass/Fail verification only; no new findings`
        } else if (baseRef) {
          diffSpec = { mode: 'range', range: await computeDiffRange(reviewRoot, baseRef, headRef) }
          diffScope = `${baseRef}...${headRef}`
          roundLockNote = `Round ${round} (prior head unavailable; fell back to base diff)`
        }
      }
      if (!diffSpec) {
        if (!baseRef) {
          process.stderr.write('Error: cannot resolve base ref (unborn or single-commit repo); pass --base <ref>.\n')
          return EXIT.ERROR
        }
        diffSpec = { mode: 'range', range: await computeDiffRange(reviewRoot, baseRef, headRef) }
        diffScope = `${baseRef}...${headRef}`
        if (mode === 'task') roundLockNote = 'Round 1 full diff'
      }
    }

    const diff = await collectDiff(reviewRoot, diffSpec)
    const reviewProfile = parseDevProfile(reviewRoot)
    const effectiveProfile = existsSync(join(reviewRoot, 'AGENTS.md')) ? reviewProfile : parseDevProfile(mainRoot)

    const shouldScanUntrusted = Boolean(opts['untrusted-scan'] || opts.pr !== undefined || opts['external-pr'] !== undefined || task?.role === 'inbound-external-pr')
    let untrustedWarnings = []
    let untrustedAdvisories = []
    if (shouldScanUntrusted) {
      const scanRes = scanUntrustedDiff(diff, reviewRoot)
      const hazards = scanRes.hazards
      untrustedAdvisories = scanRes.advisories
      if (hazards.length > 0 && !opts.humanApprovedExec) {
        const payload = {
          status: 'BLOCKED_UNTRUSTED_HAZARD',
          exitCode: EXIT.UNTRUSTED_HAZARD,
          diffScope,
          headSha,
          hazards,
          advisories: untrustedAdvisories,
          nextStep: 'Do NOT mount dependencies or run tests. Show these hazards to a human maintainer; only re-run with --human-approved-exec (and use --ignore-scripts) after explicit approval.',
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        } else {
          const lines = [
            'BLOCKED_UNTRUSTED_HAZARD',
            `Scope    : ${diffScope} (HEAD ${headSha})`,
            `Exit Code: ${EXIT.UNTRUSTED_HAZARD}`,
            'High-risk / supply-chain or gate-weakening changes detected before execution:',
            ...hazards.flatMap((h) => [
              `  - [${h.category}] ${h.file}: ${h.reason}`,
              ...h.excerpt.map((e) => `      ${e}`),
            ]),
            '',
            '[NEXT STEP]',
            '  1. Read-only inspect the flagged diff above; DO NOT mount deps or execute tests/scripts.',
            '  2. Ask a human maintainer for explicit sign-off.',
            '  3. Only if approved, re-run with `--human-approved-exec` and isolate installs using `--ignore-scripts`.',
          ]
          process.stdout.write(`${lines.join('\n')}\n`)
        }
        process.stderr.write(`BLOCKED_UNTRUSTED_HAZARD: ${hazards.length} high-risk change(s) detected (exit ${EXIT.UNTRUSTED_HAZARD})\n`)
        return EXIT.UNTRUSTED_HAZARD
      }
      untrustedWarnings = hazards
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

    const behavioralGate = assessBehavioralGate({
      diff, devProfile: effectiveProfile, task, headSha, gateWeakenedHits, parity, untrustedAdvisories,
    })
    const structuralGate = assessStructuralGate({ reviewRoot, diff, devProfile: effectiveProfile, parity })
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

    const nextSteps = buildPackNextSteps({
      opts, mode, task, round, mainRoot, untrustedWarnings, doorAssessment, structuralGate,
    })

    const includeDiff = Boolean(opts['include-diff'])
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
        ...(!includeDiff ? { includeDiffHint: 'Pass --include-diff to embed full diffText in JSON' } : {}),
      },
      task: task ?? null,
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
    return EXIT.ERROR
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().then((code) => process.exit(code))
}
