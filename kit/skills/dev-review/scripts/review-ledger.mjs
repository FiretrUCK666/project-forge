/**
 * review-ledger.mjs -- Review verdict recording, explicit rebutted/resolved tracking,
 * visual verification recording, stop-loss human override, and text/next-step rendering.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import { posixPath } from '../../lib/git.mjs'
import {
  consumeReviewToken, createDefaultLedger, readTaskLedger, resolveTaskContext, sanitizeTaskId, writeTaskLedger, nextReviewRound } from '../../lib/ledger.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { readVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { EXIT, resolveReviewTargetSha } from './review-diff.mjs'
import {
  checkHistoricalStopLoss, checkIncrementalScopeLock, checkSameHeadRereview,
  computeDispositionStats, evaluatePassBlockers, normalizeAdvisoryList,
  normalizeMustFixObj, parseDispositions, parseMustFixItem, sameBlockerItem,
} from './review-locks.mjs'
import { syncReviewToGitHub } from './review-sync.mjs'

function matchesItemIdSet(pm, idSet) {
  if (!pm || idSet.size === 0) return false
  return idSet.has(String(pm.id ?? '').toLowerCase())
    || idSet.has(String(pm.fingerprint ?? '').toLowerCase())
    || (pm.criterion && idSet.has(String(pm.criterion).toLowerCase()))
}

function resolveRecordNextSteps({ taskId, verdict, round, role, mainRoot }) {
  const skills = resolveAvailableSkills(mainRoot)
  if (verdict === 'pass') {
    if (role === 'contributor-fork') {
      return ['Review PASSED (contributor-fork): wait for upstream maintainer merge; do NOT delete your fork branch before PR is merged.']
    }
    if (skills.has('dev-flow')) {
      return [`node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId} (respecting repo mergeAuthority)`]
    }
    return ['Review PASSED: merge via GitHub PR or `git merge --no-ff` after verifying merge authority rules.']
  }
  if (skills.has('dev-flow')) {
    return [
      `Implementer: fix Must-Fix items on the SAME branch (node ".agents/skills/dev-flow/scripts/flow.mjs" rework --task ${taskId}), re-run verify, update PR, then run Round ${round + 1}.`,
    ]
  }
  return [
    `Implementer: fix Must-Fix items on the SAME branch, re-run tests and commit, then invoke review Round ${round + 1}.`,
  ]
}

export async function handleRecord(opts, roots) {
  const { mainRoot, workTreeRoot } = roots
  let taskId
  let existing = null

  if (opts.task && String(opts.task).trim() !== '' && opts.task !== 'auto') {
    taskId = sanitizeTaskId(opts.task)
    existing = readTaskLedger(mainRoot, taskId)
  } else {
    const ctx = await resolveTaskContext(roots, { ...opts, task: undefined }, { requireExisting: true })
    taskId = ctx.taskId
    existing = ctx.ledger
  }

  const baseLedger = existing ? createDefaultLedger(existing) : createDefaultLedger({
    taskId,
    implementerId: opts['implementer-id'] ?? null,
    rounds: [],
  })

  const prevRounds = Array.isArray(baseLedger.rounds) ? structuredClone(baseLedger.rounds) : []
  let round
  if (opts.round !== undefined && String(opts.round).trim() !== '') {
    round = Number(opts.round)
    if (!Number.isInteger(round) || round < 1) {
      process.stderr.write('Error: record requires integer --round <1|2|3...>\n')
      return EXIT.USAGE_OR_POLICY
    }
  } else {
    // 与签发侧用同一个派生式——两处各算一次，轮次有空档时必然对不上。
    round = nextReviewRound(baseLedger)
  }

  const verdict = String(opts.verdict ?? '').toLowerCase()
  if (verdict !== 'pass' && verdict !== 'changes') {
    process.stderr.write('Error: record requires --verdict pass|changes\n')
    return EXIT.USAGE_OR_POLICY
  }
  const reviewerId = String(opts['reviewer-id'] ?? '').trim()
  if (!reviewerId) {
    process.stderr.write('Error: record requires non-empty --reviewer-id <id>\n')
    return EXIT.USAGE_OR_POLICY
  }

  // 实证佐证：没有它，'我跑过' 与 '我觉得' 在账本里分不出来。
  const evidenceRaw = String(opts.evidence ?? '').trim()
  if (!evidenceRaw) {
    const msg = 'BLOCKED_MISSING_REVIEW_EVIDENCE: 记审查结论必须传 --evidence "<你实际跑过的命令与输出摘要>"。'
      + '判据是「跑过什么」，不是「觉得怎样」——没有佐证的通过和没有通过是一回事。'
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: 'BLOCKED_MISSING_REVIEW_EVIDENCE', error: msg, taskId, round }, null, 2)}\n`)
    else process.stdout.write(`${msg}\n`)
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const ledgerImplementer = String(baseLedger.implementerId ?? '').trim()
  const optImplementer = String(opts['implementer-id'] ?? '').trim()
  const implementerId = ledgerImplementer || optImplementer
  if (!implementerId) {
    const msg = 'BLOCKED_MISSING_IMPLEMENTER: 账本里没有 implementerId，无法判断这是不是自审——'
      + '缺少实施者标识不等于不需要独立审查。请用 flow.mjs start 建立任务（会记下实施者），或显式传 --implementer-id。'
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: 'BLOCKED_MISSING_IMPLEMENTER', error: msg, taskId, round }, null, 2)}\n`)
    else process.stdout.write(`${msg}\n`)
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }
  if (reviewerId === implementerId || (optImplementer && reviewerId === optImplementer)) {
    const matchedImpl = reviewerId === implementerId ? implementerId : optImplementer
    const msg = `SELF_REVIEW_REJECTED: reviewerId (${reviewerId}) equals implementerId (${matchedImpl}). Independent review requires a distinct reviewer.`
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ status: 'SELF_REVIEW_REJECTED', error: msg, taskId, round, reviewerId, implementerId: matchedImpl }, null, 2)}\n`)
    } else {
      process.stdout.write(`${msg}\n`)
    }
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const tokenCheck = consumeReviewToken(baseLedger, opts['review-token'], round)
  if (!tokenCheck.ok) {
    const msg = `BLOCKED_REVIEW_TOKEN: ${tokenCheck.reason}。`
      + '独立审查要凭 flow.mjs next 在待审查阶段签发的一次性令牌，--reviewer-id 一个字符串不再是凭据。'
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ status: 'BLOCKED_REVIEW_TOKEN', code: tokenCheck.reason, error: msg, taskId, round, reviewerId }, null, 2)}\n`)
    } else {
      process.stdout.write(`${msg}\n`)
    }
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const histLock = checkHistoricalStopLoss(prevRounds, baseLedger, opts)
  if (histLock.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: histLock.code, exitCode: histLock.exitCode, taskId, round, error: histLock.message }, null, 2)}\n`)
    else process.stdout.write(`${histLock.message}\n`)
    process.stderr.write(`${histLock.message}\n`)
    return histLock.exitCode
  }
  if (histLock.unlockedNow) {
    baseLedger.humanApprovedStopLoss = true
    baseLedger.humanApprovedReason = histLock.reason
  }

  const mustFixList = []
  for (let i = 0; i < (opts['must-fix'] ?? []).length; i += 1) {
    const raw = opts['must-fix'][i]
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          arr.forEach((item, j) => mustFixList.push(normalizeMustFixObj(item, mustFixList.length + j)))
          continue
        }
      } catch { /* fallback */ }
    }
    mustFixList.push(parseMustFixItem(raw, i))
  }

  if (verdict === 'pass' && mustFixList.length > 0) {
    process.stderr.write('Error: cannot record --verdict pass when --must-fix items are present.\n')
    return EXIT.USAGE_OR_POLICY
  }

  const dispParsed = parseDispositions(opts.disposition ?? [])
  if (!dispParsed.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: 'INVALID_DISPOSITION', error: dispParsed.error, taskId, round }, null, 2)}\n`)
    process.stderr.write(`${dispParsed.error}\n`)
    return EXIT.USAGE_OR_POLICY
  }
  const roundDispositionsMap = new Map()
  for (const d of dispParsed.items) roundDispositionsMap.set(d.idOrFp.toLowerCase(), d)
  const roundDispositions = [...roundDispositionsMap.values()]

  const shouldFixList = normalizeAdvisoryList(opts['should-fix'] ?? [])
  const preExistingList = normalizeAdvisoryList(opts['pre-existing'] ?? [])
  const rebutAccepted = new Set((opts['rebut-accepted'] ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  const resolvedAccepted = new Set((opts.resolved ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))

  const prevRound = prevRounds.filter((r) => Number(r.round) < round).sort((a, b) => a.round - b.round).at(-1) ?? null
  const prevOpen = prevRound
    ? (prevRound.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved')
    : []

  const headSha = opts.head
    ? await resolveReviewTargetSha(mainRoot, workTreeRoot, baseLedger, opts.head)
    : await resolveReviewTargetSha(mainRoot, workTreeRoot, baseLedger, 'HEAD')

  const sameHeadLock = checkSameHeadRereview({ round, prevRound, headSha })
  if (sameHeadLock.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: sameHeadLock.code, exitCode: sameHeadLock.exitCode, taskId, round, headSha, error: sameHeadLock.message }, null, 2)}\n`)
    else process.stdout.write(`${sameHeadLock.message}\n`)
    process.stderr.write(`${sameHeadLock.message}\n`)
    return sameHeadLock.exitCode
  }

  const targetRoot = (baseLedger.worktreePath && existsSync(resolve(mainRoot, baseLedger.worktreePath)))
    ? resolve(mainRoot, baseLedger.worktreePath)
    : ((baseLedger.reviewWorktreePath && existsSync(resolve(mainRoot, baseLedger.reviewWorktreePath)))
        ? resolve(mainRoot, baseLedger.reviewWorktreePath)
        : workTreeRoot)

  const rebutsAll = [...(Array.isArray(baseLedger.rebuts) ? baseLedger.rebuts : []), ...(Array.isArray(prevRound?.rebuts) ? prevRound.rebuts : [])]
  const evidence = readVerificationEvidence(roots.gitDir, taskId)
  const scopeLock = await checkIncrementalScopeLock({
    round,
    verdict,
    mustFixList,
    prevOpen,
    rebuts: rebutsAll,
    targetRoot,
    prevHead: prevRound?.headSha,
    headSha,
    baseSha: baseLedger.baseSha,
    baseBranch: baseLedger.baseBranch,
    prevRoundBaseSha: prevRound?.baseSha ?? baseLedger.roundBaseSha?.prevBaseSha,
    currentBaseSha: baseLedger.baseSha ?? baseLedger.roundBaseSha?.newBaseSha,
    roundBaseSha: baseLedger.roundBaseSha,
    evidence,
    lastVerifyExitCode: baseLedger.lastVerifyExitCode,
  })
  if (scopeLock.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: scopeLock.code, exitCode: scopeLock.exitCode, taskId, round, headSha, range: scopeLock.range, outOfScope: scopeLock.outOfScope, error: scopeLock.message }, null, 2)}\n`)
    else process.stdout.write(`${scopeLock.message}\n`)
    process.stderr.write(`${scopeLock.message}\n`)
    return scopeLock.exitCode
  }

  if (verdict === 'pass') {
    const passCheck = await evaluatePassBlockers({
      mainRoot,
      targetRoot,
      gitDir: roots.gitDir,
      taskId,
      ledger: baseLedger,
      headSha,
      enforceGates: Boolean(opts['enforce-gates']),
      humanApproved: Boolean(opts['human-approved']),
    })
    if (passCheck.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ status: passCheck.code, exitCode: passCheck.exitCode, taskId, round, headSha, blockers: passCheck.blockers, error: passCheck.message }, null, 2)}\n`)
      else process.stdout.write(`${passCheck.message}\n`)
      process.stderr.write(`${passCheck.message}\n`)
      return passCheck.exitCode
    }
  }

  const rebuttedItems = []
  const resolvedItems = []
  const remainingFromPrev = []

  for (const pm of prevOpen) {
    if (matchesItemIdSet(pm, rebutAccepted)) {
      pm.status = 'rebutted'
      pm.rebuttedInRound = round
      rebuttedItems.push(pm.id)
    } else if (matchesItemIdSet(pm, resolvedAccepted) || verdict === 'pass') {
      pm.status = 'resolved'
      pm.resolvedInRound = round
      resolvedItems.push(pm.id)
    } else {
      const stillOpen = mustFixList.some((nm) => sameBlockerItem(pm, nm))
      if (!stillOpen) {
        pm.status = 'resolved'
        pm.resolvedInRound = round
        resolvedItems.push(pm.id)
      } else {
        remainingFromPrev.push(pm)
      }
    }
  }

  if (verdict === 'pass') {
    for (const r of prevRounds) {
      for (const m of r.mustFix ?? []) {
        if (m.status !== 'rebutted' && m.status !== 'resolved') {
          m.status = 'resolved'
          m.resolvedInRound = round
        }
      }
    }
  }

  const repeatedItems = mustFixList.filter((m) => remainingFromPrev.some((rm) => sameBlockerItem(m, rm)))

  const openCount = mustFixList.length
  const maxRoundsExceeded = round >= 3 && (verdict === 'changes' || openCount > 0)
  const repeatedTrigger = round >= 2 && repeatedItems.length > 0
  const stopLoss = maxRoundsExceeded || repeatedTrigger

  const stopReasons = []
  if (maxRoundsExceeded) stopReasons.push(`round ${round} >= 3 with unresolved verdict/blockers`)
  if (repeatedTrigger) stopReasons.push(`repeated blocker fingerprint across consecutive rounds: ${repeatedItems.map((i) => `${i.id}(${i.fingerprint})`).join(', ')}`)

  const visualChecked = Boolean(opts['visual-checked'] || opts['visual-evidence'])
  const roundEntry = {
    round,
    baseSha: baseLedger.baseSha ?? null,
    headSha,
    reviewerId,
    verdict,
    // 跑过什么。没有它，'我跑过' 和 '我觉得' 在账本里分不出来。
    reviewEvidence: evidenceRaw,
    blockers: mustFixList.map((m) => m.summary),
    mustFix: mustFixList,
    shouldFix: shouldFixList,
    preExisting: preExistingList,
    dispositions: roundDispositions,
    rebuts: prevRound?.rebuts ?? [],
    rebutAccepted: [...rebutAccepted],
    rebuttedItems,
    resolvedItems,
    faultInjection: opts['fault-injection'] ?? '',
    visualChecked,
    stopLossTriggered: stopLoss,
    stopLossReasons: stopReasons,
    recordedAt: new Date().toISOString(),
  }

  const filteredRounds = prevRounds.filter((r) => r.round !== round)
  filteredRounds.push(roundEntry)
  filteredRounds.sort((a, b) => a.round - b.round)
  const dispositionStats = computeDispositionStats(filteredRounds)

  const prOptNum = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : null
  const issueOptNums = opts.issue !== undefined ? parseIssueNumbers(opts.issue, { strict: true }) : []
  const updated = {
    ...baseLedger,
    taskId,
    ...(prOptNum ? { prNumber: prOptNum } : {}),
    ...(issueOptNums.length > 0 ? {
      linkedIssues: [...new Set([
        ...(baseLedger.linkedIssues ?? []),
        ...issueOptNums,
      ])],
    } : {}),
    implementerId: implementerId || baseLedger.implementerId,
    reviewerId,
    rounds: filteredRounds,
    dispositionStats,
    lastReview: {
      round,
      verdict,
      headSha,
      reviewerId,
      stopLossTriggered: stopLoss,
      stopLossReasons: stopReasons,
    },
  }

  if (verdict === 'pass' && !stopLoss) {
    updated.reviewPassed = true
    updated.reviewPassedHead = headSha
  } else {
    updated.reviewPassed = false
    updated.reviewPassedHead = null
  }

  if (visualChecked) {
    updated.visualVerifiedHead = headSha
    updated.visualCheckEvidence = typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim()
      ? opts['visual-evidence'].trim()
      : (updated.visualCheckEvidence ?? '独立审查已核验实际渲染、交互与浅深色截图')
  }

  const tPath = writeTaskLedger(mainRoot, updated)
  await appendGovernSignal({
    mainRoot,
    gitDir: roots.gitDir,
    isGit: roots.isGit,
    category: 'review',
    module: mustFixList[0]?.file ? undefined : 'review',
    pattern: stopLoss ? 'review.stop-loss' : (verdict === 'pass' ? 'review.pass' : 'review.changes'),
    severity: stopLoss ? 'high' : (verdict === 'pass' ? 'info' : 'medium'),
    source: 'review-record',
    file: mustFixList[0]?.file ?? '',
    message: `review round ${round} verdict=${verdict}${stopLoss ? ' [STOP_LOSS]' : ''} (mustFix=${mustFixList.length}, rebutted=${rebuttedItems.length})`,
    taskId,
    round,
    verdict,
    meta: { dispositions: roundDispositions, dispositionStats, mustFixCount: mustFixList.length },
  })
  const nextSteps = resolveRecordNextSteps({ taskId, verdict, round, role: updated.role, mainRoot })
  const githubSync = await syncReviewToGitHub({
    mainRoot,
    workTreeRoot: targetRoot,
    ledger: updated,
    round,
    verdict,
    headSha,
    reviewerId,
    implementerId,
    stopLoss,
    stopReasons,
    mustFixList,
    shouldFixList,
    preExistingList,
    rebuttedItems,
    resolvedItems,
    nextSteps,
    opts,
  })

  if (stopLoss) {
    const payload = {
      status: 'STOP_LOSS_ESCALATE',
      exitCode: EXIT.STOP_LOSS,
      taskId,
      round,
      headSha,
      reasons: stopReasons,
      unresolvedMustFix: mustFixList,
      rebuttedItems,
      resolvedItems,
      ledgerPath: posixPath(tPath),
      githubSync,
      nextStep: `Halt automated review loop. Escalate to human maintainer; unlock only via \`review-pack.mjs override --task ${taskId} --human-approved --reason "..."\`.`,
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else {
      const out = [
        'STOP_LOSS_ESCALATE',
        `Task     : ${taskId}`,
        `Round    : ${round} | HEAD ${headSha}`,
        `Exit Code: ${EXIT.STOP_LOSS} (escalate to human maintainer)`,
        `Reasons  : ${stopReasons.join('; ')}`,
        ...(githubSync.synced ? [`GitHub   : synced to ${githubSync.targetRepo} (${githubSync.results.map((r) => `${r.kind}#${r.number}`).join(', ')})`] : []),
        ...(githubSync.hint ? [`Hint     : ${githubSync.hint}`] : []),
        'Remaining Must-Fix:',
        ...(mustFixList.length > 0 ? mustFixList.map((m) => `  - [${m.id}] (fp:${m.fingerprint}) ${m.summary}`) : ['  - (verdict=changes at round >= 3)']),
      ].join('\n')
      process.stdout.write(`${out}\n`)
      printNextStep([
        'Stop the automated review loop and escalate to the human maintainer.',
        `Human override: node ".agents/skills/dev-review/scripts/review-pack.mjs" override --task ${taskId} --human-approved --reason "<decision>"`,
      ], { repoRoot: mainRoot })
    }
    process.stderr.write(`STOP_LOSS_ESCALATE: ${stopReasons.join('; ')} (exit ${EXIT.STOP_LOSS})\n`)
    return EXIT.STOP_LOSS
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      status: verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      taskId,
      round,
      headSha,
      reviewerId,
      reviewPassed: updated.reviewPassed,
      reviewPassedHead: updated.reviewPassedHead,
      visualVerifiedHead: updated.visualVerifiedHead,
      mustFixCount: mustFixList.length,
      shouldFixCount: shouldFixList.length,
      preExistingCount: preExistingList.length,
      dispositionStats,
      rebuttedItems,
      resolvedItems,
      ledgerPath: posixPath(tPath),
      githubSync,
      nextSteps,
    }, null, 2)}\n`)
  } else {
    const lines = [
      verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      `Task     : ${taskId} | Round ${round} | HEAD ${headSha}`,
      `Reviewer : ${reviewerId}`,
      `Ledger   : ${posixPath(tPath)}`,
      ...(githubSync.synced ? [`GitHub   : synced to ${githubSync.targetRepo} (${githubSync.results.map((r) => `${r.kind}#${r.number}`).join(', ')})`] : []),
      ...(githubSync.hint ? [`Hint     : ${githubSync.hint}`] : []),
      ...(rebuttedItems.length > 0 ? [`Rebutted : ${rebuttedItems.join(', ')}`] : []),
      ...(resolvedItems.length > 0 ? [`Resolved : ${resolvedItems.join(', ')}`] : []),
      ...(mustFixList.length > 0 ? ['Open Must-Fix:', ...mustFixList.map((m) => `  - [${m.id}] (fp:${m.fingerprint}) ${m.summary}`)] : []),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return EXIT.OK
}

export async function handleOverride(opts, roots) {
  const { mainRoot, workTreeRoot } = roots
  const ctx = await resolveTaskContext(roots, opts, { requireExisting: true })
  const { taskId, ledger } = ctx

  if (!opts['human-approved']) {
    process.stderr.write('Error: `override` requires explicit `--human-approved --reason "<text>"`.\n')
    return EXIT.USAGE_OR_POLICY
  }
  const reason = String(opts.reason ?? '').trim()
  if (!reason) {
    process.stderr.write('Error: `override` requires non-empty `--reason "<text>"` documenting human rationale.\n')
    return EXIT.USAGE_OR_POLICY
  }

  const headSha = await resolveReviewTargetSha(mainRoot, workTreeRoot, ledger, opts.head ?? 'HEAD')
  const updated = {
    ...createDefaultLedger(ledger),
    humanApprovedStopLoss: true,
    humanApprovedReason: reason,
    humanApprovedAt: new Date().toISOString(),
    humanApprovedHead: headSha,
    humanApprovedBy: String(opts['reviewer-id'] ?? opts.agent ?? 'human-maintainer').trim(),
    lastReview: ledger.lastReview
      ? { ...ledger.lastReview, stopLossOverridden: true }
      : ledger.lastReview,
  }
  const tPath = writeTaskLedger(mainRoot, updated)
  const skills = resolveAvailableSkills(mainRoot)
  const nextSteps = updated.role === 'contributor-fork'
    ? ['Stop-loss human override recorded (contributor-fork): wait for upstream maintainer merge.']
    : skills.has('dev-flow')
      ? [`node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId} --human-approved --reason "${reason.replace(/"/g, '\\"')}"`]
      : [`Proceed to merge approved branch at HEAD ${headSha.slice(0, 7)} per human decision.`]

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      status: 'STOP_LOSS_OVERRIDDEN',
      taskId,
      headSha,
      humanApprovedStopLoss: true,
      humanApprovedReason: reason,
      ledgerPath: posixPath(tPath),
      nextSteps,
    }, null, 2)}\n`)
  } else {
    process.stdout.write([
      'STOP_LOSS_OVERRIDDEN',
      `Task     : ${taskId} | HEAD ${headSha}`,
      `Reason   : ${reason}`,
      `Ledger   : ${posixPath(tPath)}`,
    ].join('\n') + '\n')
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return EXIT.OK
}
