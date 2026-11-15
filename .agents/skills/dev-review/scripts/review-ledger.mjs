/**
 * review-ledger.mjs -- Review verdict recording, explicit rebutted/resolved tracking,
 * visual verification recording, stop-loss human override, and text/next-step rendering.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import { gitRun, posixPath } from '../../lib/git.mjs'
import {
  createDefaultLedger, readTaskLedger, resolveTaskContext, sanitizeTaskId,
  writeTaskLedger,
} from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, githubRepoFull, isInternalAgentSlug, parseIssueNumbers,
  parsePrNumber, parseRemoteUrls, probeGitHubEnv, resolveContributorIdentity,
} from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { readVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { EXIT, resolveReviewTargetSha } from './review-diff.mjs'
import { parseAcceptanceCriteria } from './review-gates.mjs'
import {
  checkHistoricalStopLoss, checkIncrementalScopeLock, checkSameHeadRereview,
  computeDispositionStats, evaluatePassBlockers, normalizeAdvisoryList,
  normalizeMustFixObj, parseDispositions, parseMustFixItem, sameBlockerItem,
} from './review-locks.mjs'

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

function buildCriteriaStatusSummary({ workTreeRoot, mainRoot, ledger, verdict, headSha, mustFixList, explicitStatus }) {
  if (explicitStatus && String(explicitStatus).trim()) return String(explicitStatus).trim()
  const criteria = parseAcceptanceCriteria(workTreeRoot, mainRoot, ledger)
  const allIds = criteria.map((c) => c.id)
  if (verdict === 'pass') {
    return allIds.length > 0
      ? `fail: 无 / pass: ${allIds.join(', ')}`
      : `fail: 无 / pass: 全部已核验项 (HEAD ${String(headSha ?? '').slice(0, 7)})`
  }
  const failIds = new Set()
  for (const m of mustFixList) {
    if (m.criterion) failIds.add(m.criterion.toUpperCase())
    else {
      for (const cm of String(m.summary ?? '').matchAll(/\b(C\d+)\b/gi)) {
        failIds.add(cm[1].toUpperCase())
      }
    }
  }
  const passIds = allIds.filter((id) => !failIds.has(id))
  const failList = failIds.size > 0
    ? [...failIds]
    : (mustFixList.length > 0 ? mustFixList.map((m) => m.id) : ['未满足全部验收条件'])
  return `fail: ${failList.join(', ')}${passIds.length > 0 ? ` / pass: ${passIds.join(', ')}` : ''}`
}

async function syncReviewToGitHub({
  mainRoot, workTreeRoot, ledger, round, verdict, headSha, reviewerId, implementerId,
  stopLoss, stopReasons, mustFixList, shouldFixList, opts,
}) {
  const prNum = Number.isInteger(Number(ledger.prNumber)) && Number(ledger.prNumber) > 0 ? Number(ledger.prNumber) : null
  const issueNums = Array.isArray(ledger.linkedIssues)
    ? [...new Set(ledger.linkedIssues.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
    : []

  if (!prNum && issueNums.length === 0) {
    return { synced: false, skipped: true, reason: 'no-linked-pr-or-issue' }
  }
  if (ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || ledger.providerId === 'none') {
    return { synced: false, skipped: true, reason: `role-${ledger.role ?? 'local'}` }
  }

  try {
    const remoteRes = await gitRun(mainRoot, ['remote', '-v'])
    if (!remoteRes.ok || !remoteRes.stdout.trim()) {
      return { synced: false, offlineOrNoCreds: true, reason: 'no-remote', hint: '未配置远端，审查结论已安全保存至本地账本（不阻塞离线使用）。' }
    }
    const remoteUrls = parseRemoteUrls(remoteRes.stdout)
    const declaredRepo = detectDeclaredRepo(mainRoot)
    const originFull = githubRepoFull(remoteUrls.origin ?? Object.values(remoteUrls)[0])
    const upstreamFull = githubRepoFull(remoteUrls.upstream)
    const targetRepo = ledger.role === 'contributor-fork' ? (upstreamFull ?? declaredRepo ?? originFull) : originFull
    if (!targetRepo) {
      return { synced: false, skipped: true, reason: 'no-github-repo', hint: '非 GitHub 远端，审查结论已写入本地账本。' }
    }

    const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: mainRoot, remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    const tier = ghClient?.tier ?? ghProbe.env?.trackB?.tier ?? 'offline'
    if ((!opts._ghClient && ghProbe.env?.providerId !== 'github') || (tier !== 'gh-cli' && tier !== 'node-https-token')) {
      return {
        synced: false,
        offlineOrNoCreds: true,
        tier,
        targetRepo,
        reason: `offline-or-no-credentials(${tier})`,
        hint: `离线或无可用 GitHub 凭据（tier=${tier}），已静默写入本地账本，未阻塞评审流程。`,
      }
    }

    const criteriaStatusText = buildCriteriaStatusSummary({
      workTreeRoot,
      mainRoot,
      ledger,
      verdict,
      headSha,
      mustFixList,
      explicitStatus: opts['criteria-status'],
    })
    const faultInjectionText = String(opts['fault-injection'] ?? '').trim() || '未触及高风险路径或未附额外故障注入摘要'
    const stopLossText = stopLoss ? `已触发（${stopReasons.join('；')}）` : '未触发'

    const ghLogin = ghProbe.env?.trackB?.login
    const implDisplay = resolveContributorIdentity({ ghLogin, ledgerActor: implementerId }).display
    const sourceLine = isInternalAgentSlug(reviewerId) && ghLogin
      ? `@${ghLogin}（独立审查子代理 \`${reviewerId}\`，隔离 worktree 复核，实施人：${implDisplay}）`
      : `\`${reviewerId}\`（独立上下文，implementer=\`${implementerId || 'unknown'}\`）`

    const bodyLines = [
      `### 独立审查 Round ${round}（${verdict === 'pass' ? 'PASS' : 'CHANGES_REQUESTED'} @ \`${String(headSha ?? '').slice(0, 7)}\`）`,
      '',
      `- **审查来源**：${sourceLine}`,
      `- **逐条标准状态**：${criteriaStatusText}`,
      `- **故障注入记录**：${faultInjectionText}`,
      `- **止损记录**：${stopLossText}`,
    ]
    if (mustFixList.length > 0) {
      bodyLines.push('', '**Must Fix**：', ...mustFixList.map((m) => `- [${m.id}] ${m.summary}`))
    }
    if (shouldFixList.length > 0) {
      bodyLines.push('', '**Should Fix**：', ...shouldFixList.map((s) => `- ${s}`))
    }
    const commentBody = bodyLines.join('\n')
    const statePayload = {
      taskId: ledger.taskId,
      action: 'review',
      round,
      verdict,
      headSha,
      reviewerId,
      stopLossTriggered: stopLoss,
    }

    const labelName = verdict === 'changes' ? 'changes-requested' : 'reviewed'
    const staleLabel = verdict === 'changes' ? 'reviewed' : 'changes-requested'
    const targets = [
      ...(prNum ? [{ kind: 'pr', number: prNum }] : []),
      ...issueNums.filter((n) => n !== prNum).map((n) => ({ kind: 'issue', number: n })),
    ]
    const backend = createTaskBackend({
      role: ledger.role,
      providerId: ledger.providerId,
      targetRepo,
      client: ghClient,
      mainRoot,
      gitDir: opts.gitDir,
    })
    const results = []
    for (const t of targets) {
      const commentRes = await backend.postComment({
        repo: targetRepo,
        number: t.number,
        body: commentBody,
        statePayload,
      })
      const labelRes = await backend.addLabels({
        repo: targetRepo,
        number: t.number,
        labels: [labelName],
      })
      await backend.removeLabel({ repo: targetRepo, number: t.number, label: staleLabel })
      results.push({ kind: t.kind, number: t.number, comment: commentRes, label: labelRes })
    }

    const synced = results.some((r) => r.comment?.ok)
    return {
      synced,
      targetRepo,
      label: labelName,
      results,
      ...(!synced ? {
        offlineOrNoCreds: true,
        hint: '远端评论同步未成功（可能处于离线或无写权限环境），审查结论已写入本地账本。',
      } : {}),
    }
  } catch (err) {
    return {
      synced: false,
      offlineOrNoCreds: true,
      error: err instanceof Error ? err.message : String(err),
      hint: '远端同步异常（可能离线），已安全写入本地账本，绝不阻塞审查流转。',
    }
  }
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
    const maxPrev = prevRounds.length > 0 ? Math.max(...prevRounds.map((r) => Number(r.round) || 0)) : 0
    round = maxPrev + 1
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

  const implementerId = String(opts['implementer-id'] ?? baseLedger.implementerId ?? '').trim()
  if (implementerId && reviewerId === implementerId) {
    const msg = `SELF_REVIEW_REJECTED: reviewerId (${reviewerId}) equals implementerId (${implementerId}). Independent review requires a distinct reviewer.`
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ status: 'SELF_REVIEW_REJECTED', error: msg, taskId, round, reviewerId, implementerId }, null, 2)}\n`)
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
  const githubSync = await syncReviewToGitHub({
    mainRoot,
    workTreeRoot,
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
    opts,
  })
  const nextSteps = resolveRecordNextSteps({ taskId, verdict, round, role: updated.role, mainRoot })

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
