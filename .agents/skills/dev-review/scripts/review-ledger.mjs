/**
 * review-ledger.mjs -- Review verdict recording, explicit rebutted/resolved tracking,
 * visual verification recording, stop-loss human override, and text/next-step rendering.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import { buildEscalationIssuePayload, escalateToBackend } from '../../lib/escalation.mjs'
import { posixPath } from '../../lib/git.mjs'
import {
  consumeReviewToken, createDefaultLedger, nextReviewRound,
  readTaskLedger, resolveTaskContext, sanitizeTaskId, updateTaskLedger,
} from '../../lib/ledger.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { readVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { EXIT, resolveReviewTargetSha } from './review-diff.mjs'
import { readReceipt, resolveEmpiricalReceiptPath } from './review-empirical-state.mjs'
import {
  buildReviewStopLossPacket, checkDistinctRoundReviewer, checkHistoricalStopLoss,
  checkIncrementalScopeLock, checkSameHeadRereview, collectExcludedReviewers,
  computeDispositionStats, computeReviewArtifactBaseline, evaluatePassBlockers,
  evaluateThreeRoundStopLoss, isOptionalLowRiskReview, normActorId, normalizeAdvisoryList,
  normalizeMustFixObj, parseDispositions, parseMustFixItem, sameBlockerItem,
} from './review-locks.mjs'
import { syncReviewToGitHub } from './review-sync.mjs'

function matchesItemIdSet(pm, idSet) {
  if (!pm || idSet.size === 0) return false
  return idSet.has(String(pm.id ?? '').toLowerCase())
    || idSet.has(String(pm.fingerprint ?? '').toLowerCase())
    || (pm.criterion && idSet.has(String(pm.criterion).toLowerCase()))
}

function resolveRecordNextSteps({ taskId, verdict, round, role, mainRoot, excludedReviewers = [] }) {
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
  const excl = excludedReviewers.length > 0 ? ` (Round ${round + 1} must spawn fresh reviewer excluding: ${excludedReviewers.join(', ')})` : ''
  if (skills.has('dev-flow')) {
    return [
      `Implementer: fix Must-Fix on SAME branch (rework -> verify -> submit), then run Round ${round + 1}${excl}.`,
    ]
  }
  return [`Implementer: fix Must-Fix on SAME branch, verify & commit, then run Round ${round + 1}${excl}.`]
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
  if (normActorId(reviewerId) === normActorId(implementerId) || (optImplementer && normActorId(reviewerId) === normActorId(optImplementer))) {
    const matchedImpl = normActorId(reviewerId) === normActorId(implementerId) ? implementerId : optImplementer
    const msg = `SELF_REVIEW_REJECTED: reviewerId (${reviewerId}) equals implementerId (${matchedImpl}). Independent review requires a distinct reviewer.`
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ status: 'SELF_REVIEW_REJECTED', error: msg, taskId, round, reviewerId, implementerId: matchedImpl }, null, 2)}\n`)
    } else {
      process.stdout.write(`${msg}\n`)
    }
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const distinctLock = checkDistinctRoundReviewer(prevRounds, reviewerId, {
    minRound: 2, currentRound: round, code: 'BLOCKED_SAME_REVIEWER_REREVIEW', subject: '代码审查',
  })
  if (distinctLock.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: distinctLock.code, exitCode: distinctLock.exitCode, taskId, round, reviewerId, matchedRound: distinctLock.matchedRound, excludedReviewers: distinctLock.excludedReviewers, error: distinctLock.message }, null, 2)}\n`)
    else process.stdout.write(`${distinctLock.message}\n`)
    process.stderr.write(`${distinctLock.message}\n`)
    return distinctLock.exitCode
  }

  const targetRoot = (baseLedger.worktreePath && existsSync(resolve(mainRoot, baseLedger.worktreePath)))
    ? resolve(mainRoot, baseLedger.worktreePath)
    : ((baseLedger.reviewWorktreePath && existsSync(resolve(mainRoot, baseLedger.reviewWorktreePath)))
        ? resolve(mainRoot, baseLedger.reviewWorktreePath)
        : workTreeRoot)

  const optionalLowRiskRecord = opts['review-token'] === undefined
    ? await isOptionalLowRiskReview({ mainRoot, targetRoot, baseLedger })
    : false

  if (!optionalLowRiskRecord) {
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

  const curArtifactBaseline = await computeReviewArtifactBaseline({ targetRoot, baseSha: baseLedger.baseSha, headSha })
  if (round >= 2 && prevRound?.verdict === 'changes' && prevRound?.artifact_baseline?.diffSha && curArtifactBaseline.diffSha && curArtifactBaseline.diffSha === prevRound.artifact_baseline.diffSha) {
    const msg = `BLOCKED_NO_REWORK_CHANGES: Round ${round} 相对 baseSha 的代码差异指纹未变 (${curArtifactBaseline.diffSha})，禁止提交空返工直接复审。`
    if (opts.json) process.stdout.write(`${JSON.stringify({ status: 'BLOCKED_NO_REWORK_CHANGES', exitCode: EXIT.USAGE_OR_POLICY, taskId, round, headSha, artifact_baseline: curArtifactBaseline, error: msg }, null, 2)}\n`)
    else process.stdout.write(`${msg}\n`)
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

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
    const receipt = readReceipt(resolveEmpiricalReceiptPath({ gitDir: roots.gitDir, mode: 'task', task: baseLedger, prNo: baseLedger.prNumber, reviewRoot: targetRoot, baseRef: baseLedger.baseSha || baseLedger.baseBranch }))
    const passCheck = await evaluatePassBlockers({
      mainRoot,
      targetRoot,
      gitDir: roots.gitDir,
      taskId,
      ledger: baseLedger,
      headSha,
      enforceGates: Boolean(opts['enforce-gates']),
      humanApproved: Boolean(opts['human-approved']),
      receipt,
      opts,
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

  const sl = evaluateThreeRoundStopLoss({
    round,
    verdict,
    items: mustFixList,
    prevItems: remainingFromPrev,
    humanApproved: Boolean(opts['human-approved'] || baseLedger.humanApprovedStopLoss),
    matchesSame: sameBlockerItem,
    maxRounds: 3,
  })
  const stopLoss = sl.stopLoss
  const stopReasons = sl.reasons

  const fr = baseLedger.faultRecord
  const autoFaultText = fr?.restoredAt
    ? `已通过两阶段故障注入与干净还原（round=${fr.round ?? '-'}, failed=${fr.failedCmd ?? 'injected'}, restoredAt=${fr.restoredAt}）`
    : ''
  const effectiveFaultInjection = String(opts['fault-injection'] ?? '').trim() || autoFaultText

  const e2eText = (typeof opts['e2e-evidence'] === 'string' && opts['e2e-evidence'].trim())
    || (typeof opts['visual-evidence'] === 'string' && opts['visual-evidence'].trim())
    || ''
  const visualChecked = Boolean(opts['visual-checked'] || e2eText)
  const roundEntry = {
    round,
    baseSha: baseLedger.baseSha ?? null,
    headSha,
    artifact_baseline: curArtifactBaseline,
    reviewerId,
    verdict,
    optionalLowRisk: optionalLowRiskRecord,
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
    faultInjection: effectiveFaultInjection,
    visualChecked,
    stopLossTriggered: stopLoss,
    stopLossReasons: stopReasons,
    recordedAt: new Date().toISOString(),
  }

  const filteredRounds = prevRounds.filter((r) => r.round !== round)
  filteredRounds.push(roundEntry)
  filteredRounds.sort((a, b) => a.round - b.round)
  const dispositionStats = computeDispositionStats(filteredRounds)
  const excludedReviewers = collectExcludedReviewers(filteredRounds, implementerId)
  const stopLossPacket = stopLoss
    ? buildReviewStopLossPacket({ taskId, round, headSha, reasons: stopReasons, repeatedItems: sl.repeatedItems, mustFixList, excludedReviewers })
    : null

  const prOptNum = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : null
  const issueOptNums = opts.issue !== undefined ? parseIssueNumbers(opts.issue, { strict: true }) : []
  const updated = {
    ...baseLedger,
    taskId,
    ...(prOptNum ? { prNumber: prOptNum } : {}),
    ...(issueOptNums.length > 0 ? {
      linkedIssues: [...new Set([...(baseLedger.linkedIssues ?? []), ...issueOptNums])],
    } : {}),
    implementerId: implementerId || baseLedger.implementerId,
    reviewerId,
    rounds: filteredRounds,
    dispositionStats,
    ...(stopLossPacket ? { stopLossPacket } : {}),
    lastReview: {
      round,
      verdict,
      headSha,
      reviewerId,
      stopLossTriggered: stopLoss,
      stopLossReasons: stopReasons,
      ...(stopLossPacket ? { stopLossPacket } : {}),
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
    updated.visualCheckEvidence = e2eText || (updated.visualCheckEvidence ?? '独立审查已核验真实端到端运行、交互与输出观察')
  }

  const { path: tPath } = await updateTaskLedger(mainRoot, taskId, () => updated)
  if (stopLossPacket) stopLossPacket.ledgerPath = posixPath(tPath)
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
    meta: { dispositions: roundDispositions, dispositionStats, mustFixCount: mustFixList.length, ...(stopLossPacket ? { stopLossPacket } : {}) },
  })
  const nextSteps = resolveRecordNextSteps({ taskId, verdict, round, role: updated.role, mainRoot, excludedReviewers })
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
    const escalationItem = {
      source: 'review', stopLoss: true, severity: 'high', caseType: 4, taskId,
      title: `stop-loss escalation for ${taskId} (Round ${round})`,
      summary: stopReasons.join('; '),
      rootCause: stopLossPacket.rootCauseHypothesis,
      criteria: mustFixList.length > 0 ? mustFixList.map((m, idx) => `C${idx + 1}: 根治 [${m.id}] ${m.summary}`) : ['C1: 拆解架构前提冲突并补全双向实证'],
      stopLossPacket, milestone: updated.milestone ?? undefined, labels: ['stop-loss', 'escalation'],
    }
    const escalationPayload = buildEscalationIssuePayload(escalationItem)
    const shouldWriteEscalation = Boolean(opts.escalate || updated.role === 'local-only' || opts._ghProbe || opts._ghClient)
    const escalatedIssue = shouldWriteEscalation
      ? await escalateToBackend({ repoRoot: mainRoot, item: escalationItem, _ghProbe: opts._ghProbe, _ghClient: opts._ghClient }).catch((e) => ({ ok: false, error: e?.message }))
      : null
    const payload = {
      status: 'STOP_LOSS_ESCALATE',
      exitCode: EXIT.STOP_LOSS,
      taskId, round, headSha, reasons: stopReasons,
      unresolvedMustFix: mustFixList, rebuttedItems, resolvedItems,
      excludedReviewers, stopLossPacket, escalationPayload,
      ...(escalatedIssue ? { escalatedIssue } : {}),
      ledgerPath: posixPath(tPath), githubSync,
      nextStep: stopLossPacket.recoveryCommand,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else {
      process.stdout.write([
        'STOP_LOSS_ESCALATE',
        `Task     : ${taskId} | Round ${round} | HEAD ${headSha}`,
        `Exit Code: ${EXIT.STOP_LOSS} (escalate to human maintainer)`,
        `Reasons  : ${stopReasons.join('; ')}`,
        ...(stopLossPacket.hotspotFiles.length > 0 ? [`Hotspots : ${stopLossPacket.hotspotFiles.join(', ')}`] : []),
        ...(githubSync.synced ? [`GitHub   : synced to ${githubSync.targetRepo} (${githubSync.results.map((r) => `${r.kind}#${r.number}`).join(', ')})`] : []),
        ...(escalatedIssue?.ok ? [`Escalated: Issue #${escalatedIssue.number} (${escalatedIssue.title})`] : []),
        'Remaining Must-Fix:',
        ...(mustFixList.length > 0 ? mustFixList.map((m) => `  - [${m.id}] (fp:${m.fingerprint}) ${m.summary}`) : ['  - (verdict=changes at round >= 3)']),
      ].join('\n') + '\n')
      printNextStep([stopLossPacket.recoveryCommand], { repoRoot: mainRoot })
    }
    process.stderr.write(`STOP_LOSS_ESCALATE: ${stopReasons.join('; ')} (exit ${EXIT.STOP_LOSS})\n`)
    return EXIT.STOP_LOSS
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      status: verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      taskId, round, headSha, reviewerId, excludedReviewers,
      optionalLowRisk: optionalLowRiskRecord,
      reviewPassed: updated.reviewPassed, reviewPassedHead: updated.reviewPassedHead, visualVerifiedHead: updated.visualVerifiedHead,
      mustFixCount: mustFixList.length, shouldFixCount: shouldFixList.length, preExistingCount: preExistingList.length,
      dispositionStats, rebuttedItems, resolvedItems,
      ledgerPath: posixPath(tPath), githubSync, nextSteps,
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
  const { path: tPath } = await updateTaskLedger(mainRoot, taskId, () => updated)
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
