/**
 * review-ledger.mjs -- Review verdict recording, explicit rebutted/resolved tracking,
 * visual verification recording, stop-loss human override, and text/next-step rendering.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import { posixPath } from '../../lib/git.mjs'
import {
  createDefaultLedger, readTaskLedger, resolveTaskContext, sanitizeTaskId,
  taskLedgerPath, writeTaskLedger,
} from '../../lib/ledger.mjs'
import { EXIT, resolveReviewTargetSha } from './review-diff.mjs'

function computeFingerprint(criterion, file, summary) {
  const normSummary = String(summary ?? '')
    .toLowerCase()
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
  const key = [criterion ? criterion.toUpperCase() : '', posixPath(file).toLowerCase(), normSummary]
    .filter(Boolean)
    .join('|')
  return createHash('sha1').update(key || 'empty').digest('hex').slice(0, 12)
}

function normalizeMustFixObj(obj, idx) {
  const criterion = obj.criterion || (/^C\d+$/i.test(String(obj.id ?? '')) ? String(obj.id).toUpperCase() : undefined)
  const file = posixPath(obj.file ?? '')
  const summary = String(obj.summary ?? obj.message ?? obj.text ?? obj.id ?? '').trim()
  const fp = obj.fingerprint ? String(obj.fingerprint).trim() : computeFingerprint(criterion, file, summary)
  return {
    id: String(obj.id ?? criterion ?? `MF-${idx + 1}`),
    criterion,
    file,
    summary,
    fingerprint: fp,
    status: obj.status ?? 'open',
  }
}

function parseMustFixItem(raw, idx) {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(raw)
      return normalizeMustFixObj(obj, idx)
    } catch { /* fall back to text */ }
  }
  const text = String(raw ?? '').trim()
  const cMatch = /^(C\d+)\s*[:：-]\s*(.+)$/i.exec(text)
  const criterion = cMatch ? cMatch[1].toUpperCase() : undefined
  const body = cMatch ? cMatch[2].trim() : text
  const fp = computeFingerprint(criterion, '', body)
  return {
    id: criterion ?? `MF-${idx + 1}`,
    criterion,
    file: '',
    summary: text,
    fingerprint: fp,
    status: 'open',
  }
}

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

  const shouldFixList = (opts['should-fix'] ?? []).map((s) => String(s).trim()).filter(Boolean)
  const rebutAccepted = new Set((opts['rebut-accepted'] ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  const resolvedAccepted = new Set((opts.resolved ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))

  const prevRound = prevRounds.find((r) => r.round === round - 1) ?? prevRounds[prevRounds.length - 1]
  const prevOpen = prevRound
    ? (prevRound.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved')
    : []

  const newFpSet = new Set(mustFixList.map((m) => m.fingerprint))
  const newCriteriaSet = new Set(mustFixList.map((m) => m.criterion).filter(Boolean))
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
      const stillOpen = newFpSet.has(pm.fingerprint) || (pm.criterion && newCriteriaSet.has(pm.criterion))
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

  const prevFps = new Set(remainingFromPrev.map((m) => m.fingerprint))
  const prevCriteria = new Set(remainingFromPrev.map((m) => m.criterion).filter(Boolean))
  const repeatedItems = mustFixList.filter((m) =>
    prevFps.has(m.fingerprint) || (m.criterion && prevCriteria.has(m.criterion)),
  )

  const headSha = opts.head
    ? await resolveReviewTargetSha(mainRoot, workTreeRoot, baseLedger, opts.head)
    : await resolveReviewTargetSha(mainRoot, workTreeRoot, baseLedger, 'HEAD')

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
    headSha,
    reviewerId,
    verdict,
    blockers: mustFixList.map((m) => m.summary),
    mustFix: mustFixList,
    shouldFix: shouldFixList,
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

  const updated = {
    ...baseLedger,
    taskId,
    implementerId: implementerId || baseLedger.implementerId,
    reviewerId,
    rounds: filteredRounds,
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
      rebuttedItems,
      resolvedItems,
      ledgerPath: posixPath(tPath),
      nextSteps,
    }, null, 2)}\n`)
  } else {
    const lines = [
      verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      `Task     : ${taskId} | Round ${round} | HEAD ${headSha}`,
      `Reviewer : ${reviewerId}`,
      `Ledger   : ${posixPath(tPath)}`,
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

export function buildPackNextSteps({ opts, mode, task, round, mainRoot, untrustedWarnings, doorAssessment, structuralGate }) {
  const skills = resolveAvailableSkills(mainRoot)
  const nextSteps = []
  if (opts['untrusted-scan'] && untrustedWarnings.length === 0) {
    nextSteps.push('Untrusted static scan clean (UNTRUSTED_SCAN_PASS). Safe to proceed with isolated review worktree checks.')
  }
  if (doorAssessment.gateWeakened) {
    nextSteps.push('GATE_WEAKENED detected: escalate to human maintainer for explicit sign-off (mergeAuthority=human-required).')
  }
  if (structuralGate.archViolations.length > 0) {
    nextSteps.push(`Fix ${structuralGate.archViolations.length} architecture boundary violation(s) at root cause before passing review.`)
  }
  if (mode === 'local' || mode === 'staged' || mode === 'base') {
    nextSteps.push('Fix any [PARITY_WARN] / structural / test issues locally before creating a commit or opening a PR.')
  } else if (mode === 'task' && task) {
    nextSteps.push('Review independently against criteria C1..Cn, run tests + fault injection, then record verdict:')
    nextSteps.push(`  node ".agents/skills/dev-review/scripts/review-pack.mjs" record --task ${task.taskId} --round ${round} --verdict pass|changes --reviewer-id <reviewer-id>`)
    if (task.role === 'contributor-fork') {
      nextSteps.push('Contributor-fork note: after PASS, wait for upstream maintainer merge; do NOT run `flow.mjs merge` or delete fork branch.')
    } else if (!skills.has('dev-flow')) {
      nextSteps.push('Note: dev-flow is not installed in .agents/skills/; handle branch merge manually after PASS.')
    }
  } else if (opts.pr) {
    nextSteps.push('Complete independent review using the diff hash, dual gates, and empirical tests above before posting PR review.')
  }
  return nextSteps
}

export function formatPackText(pack, fullDiffText = '', includeFullDiff = false) {
  const lines = []
  lines.push(`=== DEV-REVIEW PACK (${pack.mode.toUpperCase()}) ===`)
  lines.push(`Worktree : ${pack.worktreeRoot}`)
  lines.push(`Round    : ${pack.round}${pack.roundLockNote ? ` (${pack.roundLockNote})` : ''}`)
  lines.push(`Scope    : ${pack.diffScope}`)
  lines.push(`Head SHA : ${pack.headSha}`)
  lines.push(`Diff Hash: sha256:${pack.diff.sha256} (${pack.diff.bytes} bytes, ${pack.diff.files.length} changed, ${pack.diff.untracked.length} untracked)`)
  if (pack.reviewSlotSync) {
    lines.push(`SlotSync : ${pack.reviewSlotSync.action} -> ${pack.reviewSlotSync.reviewWorktreePath} @ ${String(pack.reviewSlotSync.headSha).slice(0, 7)} (deps=${pack.reviewSlotSync.depsMode})`)
  }
  if (pack.task) {
    lines.push(`Task     : ${pack.task.taskId} | role=${pack.task.role ?? 'unknown'} | finalized=${Boolean(pack.task.finalized)} | verifiedHead=${pack.task.verifiedHead ?? 'none'}`)
    if (pack.headMismatchWarning) lines.push(`WARNING  : ${pack.headMismatchWarning}`)
  }

  if (pack.criteria.length > 0) {
    lines.push('', '--- Frozen Acceptance Criteria ---')
    for (const c of pack.criteria) lines.push(`  [${c.checked ? 'x' : ' '}] ${c.id}: ${c.text} (${c.source})`)
  }

  if (pack.priorOpenMustFix.length > 0 || pack.rebuts.length > 0) {
    lines.push('', '--- Prior Round Open Must-Fix & Rebuts ---')
    for (const mf of pack.priorOpenMustFix) lines.push(`  - [${mf.id}] (fp:${mf.fingerprint}) ${mf.summary}`)
    for (const rb of pack.rebuts) lines.push(`  * Rebut: ${typeof rb === 'string' ? rb : JSON.stringify(rb)}`)
  }

  lines.push('', '--- Changed Files & Hunk Index ---')
  if (pack.diff.hunkIndex.length === 0) {
    lines.push('  (no changes in scope)')
  } else {
    for (const item of pack.diff.hunkIndex) {
      lines.push(`  ${item.status}\t${item.file} (+${item.addedLines}/-${item.removedLines}, ${item.hunks.length} hunk(s))`)
    }
  }

  lines.push('', '--- Doc-Code Parity Gate ---')
  if (pack.parity.triggers.length === 0 && pack.parity.todoIssues.length === 0 && (pack.parity.mermaidViolations?.length ?? 0) === 0) {
    lines.push('  OK: No unaddressed API/CLI/module doc parity drift, Mermaid truncation, or open Todo detected.')
  } else {
    if (pack.parity.parityMissingDocs) {
      lines.push(`  ${pack.isFlowMode ? '[MUST_FIX_CANDIDATE]' : '[PARITY_WARN]'} Code surface changed without updating docs (${pack.parity.existingDocs.join(', ')}):`)
    } else if (pack.parity.triggers.length > 0) {
      lines.push('  Parity triggers (docs also touched in diff — verify accuracy):')
    }
    for (const t of pack.parity.triggers.slice(0, 12)) lines.push(`    - [${t.type}] ${t.file}: ${t.detail}`)
    for (const td of pack.parity.todoIssues) lines.push(`    - ${pack.isFlowMode ? '[MUST_FIX_CANDIDATE]' : '[TODO_WARN]'} ${td.file}: unchecked=${td.unchecked}, unarchived=${td.unarchived}`)
    for (const mv of pack.parity.mermaidViolations ?? []) lines.push(`    - [MERMAID_TRUNCATION_RISK] ${mv.file}:${mv.line}: ${mv.message}`)
  }

  lines.push('', '## 联动同步核对（改哪看哪）')
  const syncWarnings = pack.coupledSyncWarnings ?? []
  if (syncWarnings.length === 0) lines.push('  OK: 未触发 AGENTS.md「改哪看哪」缺漏项。')
  else {
    for (const sw of syncWarnings) lines.push(`  - [COUPLED_SYNC_WARN] 触及 ${sw.touchedTriggers.join(', ')} -> 需检查伴随更新: ${sw.expectedCompanions.join(', ')}`)
  }

  lines.push('', '--- Behavioral Gate (Empirical & Smoke-Verify) ---')
  const bg = pack.behavioralGate
  lines.push(`  Status     : ${bg.status} | verifiedHead=${bg.verifiedHead ?? 'none'} | smokeRequired=${bg.smokeRequired} | empiricalVisualCheckRequired=${bg.empiricalVisualCheckRequired}`)
  if (bg.visualFilesChanged.length > 0) lines.push(`  Visual/UI Files (${bg.visualFilesChanged.length}): ${bg.visualFilesChanged.slice(0, 12).join(', ')}`)
  if (bg.smokeVerifyCommands.length > 0) {
    lines.push('  Smoke-Verify Commands (anti-human-proxy: run locally and observe real runtime):')
    for (const sc of bg.smokeVerifyCommands) lines.push(`    $ ${sc}`)
  }
  for (const w of bg.warnings) lines.push(`  - WARN: ${w}`)

  lines.push('', '--- Structural Gate (Comments, Suppressions, Arch Rules, Size) ---')
  const sg = pack.structuralGate
  lines.push(`  Status     : ${sg.status} | tombstones=${sg.tombstoneComments.length}, excuses=${sg.excuseSuppressions.length}, archViolations=${sg.archViolations.length}, godFiles=${sg.godFiles.length}, mermaid=${sg.mermaidViolations?.length ?? 0}`)
  for (const tc of sg.tombstoneComments.slice(0, 8)) lines.push(`  - [TOMBSTONE] ${tc.file}: ${tc.excerpt}`)
  for (const ex of sg.excuseSuppressions.slice(0, 8)) lines.push(`  - [EXCUSE_SUPPRESS] ${ex.file}: ${ex.excerpt}`)
  for (const av of sg.archViolations.slice(0, 8)) lines.push(`  - [ARCH_VIOLATION] ${av.file}:${av.line} (${av.rule}) -> "${av.specifier}" | ${av.fixHint}`)
  for (const gf of sg.godFiles) lines.push(`  - [GOD_FILE:${gf.severity.toUpperCase()}] ${gf.file} (${gf.lines} lines): ${gf.hint}`)

  lines.push('', '--- Door & Blast Radius Assessment ---')
  const da = pack.doorAssessment
  lines.push(`  Door Type  : ${da.doorType} | gateWeakened=${da.gateWeakened} | blastRadius=${da.blastRadius} | mergeAuthority=${da.mergeAuthority}`)
  for (const r of da.reasons) lines.push(`  - Reason   : ${r}`)
  lines.push(`  - Rollback : ${da.rollbackPath}`)

  lines.push('', '--- Empirical Test & Fault Injection Checklist ---')
  const cmds = [
    ...(pack.devProfile['quick-test'] ?? []),
    ...(pack.devProfile['smoke-verify'] ?? []),
    ...(pack.devProfile['full-test'] ?? []),
    ...(pack.devProfile['merge-gate'] ?? []),
  ]
  if (cmds.length > 0) {
    lines.push('  Run project verification commands (do not guess pass/fail):')
    for (const cmd of cmds) lines.push(`    $ ${cmd}`)
  } else {
    lines.push('  No Dev Profile test commands in AGENTS.md; run repository test suite manually.')
  }
  if (pack.highRiskHits.length > 0) {
    lines.push('  HIGH-RISK PATHS TOUCHED (mandatory fault injection in detached review worktree):')
    for (const h of pack.highRiskHits) lines.push(`    - ${h.file} (rule: ${h.rule})`)
  }
  lines.push('  Verification Precedence: Formal static gates + empirical execution/render checks > adversarial code reading.')
  if (bg.empiricalVisualCheckRequired) {
    lines.push('  Visual / UI Empirical Checklist (actual render + interaction + screenshots; never judge from reading code alone):')
    lines.push('    - [ ] Open the actual rendered page, component, or SVG in a live browser/renderer (confirm clean render, no 404 or console errors)')
    lines.push('    - [ ] Walk through interactive user flows end-to-end (clicks, form inputs, state transitions, error/empty states)')
    lines.push('    - [ ] Capture and inspect Light & Dark theme screenshots for contrast, clipping, text overlap, and legibility')
  }
  lines.push('  Fault Injection Protocol (Must Fix requires violated frozen C*, failed formal gate, or reproducible empirical failure; NO subjective code-reading nitpicks):')
  lines.push('    1. Temporarily break 1 core branch/guard in the review worktree and run test -> MUST FAIL.')
  lines.push('    2. Restore cleanly (`git checkout -- .`) and re-run test -> MUST PASS.')
  lines.push('    3. Classify findings strictly: Must Fix / Should Fix / Pre-existing (list all R1 locations at once).')

  if (pack.untrustedWarnings.length > 0) {
    lines.push('', '--- [APPROVED_EXEC_WITH_WARNINGS] ---')
    lines.push('  Human execution approval active. Use `--ignore-scripts` for dependency install.')
    for (const h of pack.untrustedWarnings) lines.push(`  - [${h.category}] ${h.file}: ${h.reason}`)
  }

  if (fullDiffText) {
    const diffLines = fullDiffText.split('\n')
    const maxLines = includeFullDiff ? diffLines.length : 240
    lines.push('', '--- Diff Patch (Context-Isolated) ---')
    lines.push(...diffLines.slice(0, maxLines))
    if (diffLines.length > maxLines) {
      lines.push(`... (truncated ${diffLines.length - maxLines} more lines; pass --include-diff or run git diff ${pack.diffScope} to inspect full patch)`)
    }
  }

  lines.push('', '[NEXT STEP]')
  for (const step of pack.nextSteps) lines.push(`  ${step}`)
  return lines.join('\n')
}
