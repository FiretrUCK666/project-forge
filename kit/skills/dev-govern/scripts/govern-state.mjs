/**
 * govern-state.mjs -- Baseline snapshots, --changed incremental filter,
 * loop state at mainRoot, gardening signals buffer, 48h sample, GitHub issues,
 * and report/next-step rendering for dev-govern.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import {
  ensureWorktreesIgnored, gitDiffNameStatusZ,
  gitRun, gitStatusPorcelainZ, isMacOsJunkPath, posixPath, readJsonSafe,
  writeAtomic, writeJsonAtomic,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { applyIssuesToBackend, buildIssues } from '../../lib/escalation.mjs'
import { appendGovernSignal, inferSignalModule, readSignalsJsonl, resolveGovernStateDir } from '../../lib/signals.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES, readTextStrictInfo } from './govern-checks.mjs'

export { applyIssuesToBackend, buildIssues, readSignalsJsonl, resolveGovernStateDir }
export const applyGitHubIssues = applyIssuesToBackend

const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 })

export function baselinePath(mainRoot) {
  return join(mainRoot, '.worktrees', '.state', 'govern-baseline.json')
}

export function loopStatePath(mainRoot) {
  return join(mainRoot, '.worktrees', '.state', 'govern-loop.json')
}

export function findingFingerprint(f) {
  const idBase = String(f.id ?? '').replace(/:\d+(?=(?:\.|$))/g, '')
  const normTitle = String(f.title ?? '').replace(/:\d+\b/g, '').trim()
  return `${f.category ?? ''}|${idBase}|${posixPath(f.file ?? '')}|${normTitle}`
}

export function loadBaseline(mainRoot) {
  return readJsonSafe(baselinePath(mainRoot)) ?? null
}

export async function saveBaseline(mainRoot, gitDir, isGit, findings, headSha) {
  if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
  const path = baselinePath(mainRoot)
  const payload = {
    schemaVersion: 1, savedAt: new Date().toISOString(), headSha: headSha ?? null, count: findings.length,
    findings: findings.map((f) => ({ id: f.id, category: f.category, severity: f.severity, file: f.file ?? '', fingerprint: findingFingerprint(f) })),
  }
  writeJsonAtomic(path, payload)
  return { path: posixPath(path), count: findings.length, savedAt: payload.savedAt }
}

export async function collectChangedFilesSet(workRoot, isGit, defaultBranch) {
  const changed = new Set()
  if (!isGit) return changed

  const st = await gitStatusPorcelainZ(workRoot)
  if (st.ok) {
    for (const e of st.entries) {
      if (e.file && !isMacOsJunkPath(e.file)) changed.add(e.file)
    }
  }

  const fastGitDir = resolveGitDirFast(workRoot)
  const fastHead = readHeadFast(fastGitDir)
  const hasHead = fastHead ? Boolean(fastHead.oid) : (await gitRun(workRoot, ['rev-parse', '--verify', 'HEAD'])).ok
  if (!hasHead) return changed

  const baseCandidates = [...new Set([defaultBranch, 'main', 'master', 'HEAD~1'].filter(Boolean))]
  for (const baseRef of baseCandidates) {
    const fastBaseSha = baseRef === 'HEAD~1' ? null : (resolveRefShaFast(fastGitDir, `refs/heads/${baseRef}`) ?? resolveRefShaFast(fastGitDir, `refs/remotes/origin/${baseRef}`))
    const verify = fastBaseSha
      ? { ok: true }
      : await gitRun(workRoot, ['rev-parse', '--verify', '--quiet', baseRef])
    if (!verify.ok) continue
    let range = null
    if (baseRef === 'HEAD~1') {
      range = 'HEAD~1..HEAD'
    } else {
      const mb = await gitRun(workRoot, ['--no-optional-locks', 'merge-base', baseRef, 'HEAD'])
      const headSha = fastHead?.oid ?? (await gitRun(workRoot, ['rev-parse', 'HEAD'])).stdout.trim()
      if (mb.ok && mb.stdout.trim() && mb.stdout.trim() !== headSha) {
        range = `${mb.stdout.trim()}..HEAD`
      }
    }
    if (range) {
      const diff = await gitDiffNameStatusZ(workRoot, [range])
      if (diff.ok) {
        for (const e of diff.entries) {
          if (e.file && !isMacOsJunkPath(e.file)) changed.add(e.file)
        }
      }
      break
    }
  }

  return changed
}

export function filterFindingsByBaselineAndChanged({ findings, baseline, changedSet, isAll, isChanged }) {
  if (isAll) {
    return {
      findings,
      baselineApplied: false,
      changedApplied: false,
      totalRawFindings: findings.length,
      suppressedByBaseline: 0,
      suppressedByChanged: 0,
    }
  }

  let current = findings
  let suppressedByChanged = 0
  if (isChanged && changedSet) {
    const filtered = []
    for (const f of current) {
      const file = posixPath(f.file ?? '')
      if (file) {
        if (changedSet.has(file)) filtered.push(f)
        else suppressedByChanged += 1
      } else if (changedSet.size > 0 && (f.id === 'tests.missing-suite' || f.id === 'tests.no-ci-config')) {
        filtered.push(f)
      } else {
        suppressedByChanged += 1
      }
    }
    current = filtered
  }

  let suppressedByBaseline = 0
  const baselineApplied = Boolean(baseline && Array.isArray(baseline.findings))
  if (baselineApplied) {
    const exactRank = new Map()
    const fpRank = new Map()
    for (const b of baseline.findings) {
      const r = SEVERITY_RANK[b.severity] ?? 1
      if (b.id) exactRank.set(b.id, Math.max(exactRank.get(b.id) ?? -1, r))
      if (b.fingerprint) fpRank.set(b.fingerprint, Math.max(fpRank.get(b.fingerprint) ?? -1, r))
    }

    const next = []
    for (const f of current) {
      const curRank = SEVERITY_RANK[f.severity] ?? 1
      const matchedRank = exactRank.has(f.id)
        ? exactRank.get(f.id)
        : (fpRank.get(findingFingerprint(f)) ?? -1)
      if (matchedRank >= 0 && curRank <= matchedRank) {
        suppressedByBaseline += 1
      } else {
        next.push({
          ...f,
          baselineStatus: matchedRank >= 0 ? 'worsened' : 'new',
        })
      }
    }
    current = next
  }

  return {
    findings: current,
    baselineApplied,
    changedApplied: Boolean(isChanged),
    totalRawFindings: findings.length,
    suppressedByBaseline,
    suppressedByChanged,
  }
}

export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  return counts
}

export async function updateLoopState(mainRoot, gitDir, isGit, findings, writeState) {
  const statePath = loopStatePath(mainRoot)
  const prev = readJsonSafe(statePath) ?? { rounds: [] }
  const nextRound = (Array.isArray(prev.rounds) ? prev.rounds.length : 0) + 1
  const counts = countBySeverity(findings)
  const snapshot = {
    round: nextRound,
    timestamp: new Date().toISOString(),
    totalFindings: findings.length,
    counts,
    topIds: findings.slice(0, 10).map((f) => f.id),
  }
  const state = {
    updatedAt: snapshot.timestamp,
    currentRound: nextRound,
    rounds: [...(Array.isArray(prev.rounds) ? prev.rounds : []), snapshot],
  }
  if (writeState) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
  return { statePath: posixPath(statePath), state, snapshot }
}

function normalizePatternFromFindingId(id) {
  const parts = String(id ?? '').split('.')
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`
  return parts[0] || 'unknown'
}

function suggestClusterRootFix(pattern, moduleName) {
  if (/arch-boundary/.test(pattern)) {
    return `Define/enforce interface boundary outside forbidden target for ${moduleName} and register in AGENTS.md arch-rules:.`
  }
  if (/excuse-suppression/.test(pattern)) {
    return `Remove suppression comments in ${moduleName}; fix root types/lint checks and fail CI on new suppression pragmas.`
  }
  if (/tombstone-comment/.test(pattern)) {
    return `Strip chronicle comments in ${moduleName} and state current invariants cleanly in AGENTS.md / docs/TDD.md.`
  }
  if (/god-file/.test(pattern)) {
    return `Decompose oversized source file(s) in ${moduleName} into cohesive single-responsibility modules.`
  }
  if (/orphan-suite|zero-assertion|skip/.test(pattern)) {
    return `Wire missing/empty tests in ${moduleName} into CI workflows and Dev Profile merge-gate/quick-test.`
  }
  return `Promote recurring root cause (${pattern} in ${moduleName}) to static check, Dev Profile script, or smoke-verify command.`
}

export function buildClusterReport(signals, findings) {
  const map = new Map()
  const upsert = ({ module, pattern, category, sourceKind, file, line, message }) => {
    const mod = module || 'repo'
    const pat = pattern || 'general'
    const key = `${mod}::${pat}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        module: mod,
        pattern: pat,
        category: category || 'hygiene',
        count: 0,
        signalCount: 0,
        auditCount: 0,
        sinkCandidate: false,
        recommendedTier: 'L1-observe',
        rootCauseFix: suggestClusterRootFix(pat, mod),
        examples: [],
      })
    }
    const entry = map.get(key)
    entry.count += 1
    if (sourceKind === 'signal') entry.signalCount += 1
    else entry.auditCount += 1
    entry.sinkCandidate = entry.count >= 2
    entry.recommendedTier = entry.count >= 3
      ? 'L3-static-gate-or-script'
      : entry.count >= 2 ? 'L2-dev-profile-or-arch-rule' : 'L1-observe'
    if (entry.examples.length < 5) {
      entry.examples.push({
        source: sourceKind,
        file: file || '',
        line: line || undefined,
        message: String(message || '').slice(0, 140),
      })
    }
  }

  for (const ev of signals) {
    upsert({
      module: ev.module || inferSignalModule(ev.file), pattern: ev.pattern || 'manual-signal', category: ev.category || 'hygiene',
      sourceKind: 'signal', file: ev.file || '', line: ev.line, message: ev.message || ev.note || ev.pattern,
    })
  }
  for (const f of findings) {
    upsert({
      module: inferSignalModule(f.file), pattern: normalizePatternFromFindingId(f.id), category: f.category,
      sourceKind: 'audit', file: f.file, line: f.line, message: f.title,
    })
  }

  const clusters = [...map.values()].sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
  const sinkCandidates = clusters.filter((c) => c.sinkCandidate)
  return {
    totalEvents: signals.length + findings.length, signalEvents: signals.length, auditFindings: findings.length,
    totalClusters: clusters.length, sinkCandidateCount: sinkCandidates.length, clusters, sinkCandidates,
  }
}

export async function handleRecordSignal(mainRoot, gitDir, isGit, opts) {
  const message = String(opts.message || opts.note || '').trim()
  const rawPattern = String(opts.pattern || '').trim()
  if (!rawPattern && !message) {
    process.stderr.write('Error: `record` requires --pattern <key> or --message <text>.\n')
    return 2
  }
  const res = await appendGovernSignal({
    mainRoot, gitDir, isGit, category: opts.category || 'hygiene', module: opts.module,
    pattern: rawPattern, severity: opts.severity || 'medium', source: opts.source || 'manual',
    file: opts.file, message, taskId: opts.task, silent: false,
  })
  const { stateDir, signalsPath, event } = res
  const { events } = readSignalsJsonl(stateDir)
  const clusterReport = buildClusterReport(events, [])
  const matched = clusterReport.clusters.find((c) => c.key === `${event.module}::${event.pattern}`)
  const repeatCount = matched?.count ?? 1
  const payload = {
    status: 'RECORDED', repoRoot: posixPath(mainRoot), signalsPath: posixPath(signalsPath),
    event, modulePatternCount: repeatCount, ruleSinkCandidate: repeatCount >= 2,
    recommendation: repeatCount >= 2
      ? `[RULE_SINK_CANDIDATE] Pattern "${event.pattern}" in "${event.module}" occurred ${repeatCount} times; sink into static check or Dev Profile.`
      : 'Signal recorded in gardening buffer; run `cluster` to identify patterns reaching >= 2 repeats.',
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write([
      '=== DEV-GOVERN SIGNAL RECORDED ===',
      `Signals File : ${payload.signalsPath}`,
      `Key          : ${event.module}::${event.pattern} (category=${event.category}, severity=${event.severity}, count=${repeatCount})`,
      `Sink Ready?  : ${payload.ruleSinkCandidate}`,
    ].join('\n') + '\n')
    printNextStep([payload.recommendation], { repoRoot: mainRoot })
  }
  return 0
}

export async function handleSampleCommits(workRoot, mainRoot, gitDir, isGit, opts) {
  const limit = Number(opts.commits ?? 30)
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write('Error: --commits must be a positive integer.\n')
    return 2
  }
  const stateDir = resolveGovernStateDir(mainRoot, gitDir, isGit)
  const { signalsPath, events } = readSignalsJsonl(stateDir)
  const signalClusters = buildClusterReport(events, [])

  const commits = []
  const fastSampleHead = isGit ? readHeadFast(resolveGitDirFast(workRoot)) : null
  if (isGit && (fastSampleHead ? Boolean(fastSampleHead.oid) : (await gitRun(workRoot, ['rev-parse', '--verify', 'HEAD'])).ok)) {
    const logRes = await gitRun(workRoot, ['log', '-n', String(limit), '--name-only', '--format=__COMMIT__%H\t%ct\t%s'])
    if (logRes.ok && logRes.stdout) {
      let cur = null
      for (const line of logRes.stdout.split('\n')) {
        if (line.startsWith('__COMMIT__')) {
          if (cur) commits.push(cur)
          const [hash, tsStr, ...rest] = line.slice(10).split('\t')
          cur = { hash, ts: Number(tsStr) || 0, subject: rest.join('\t').trim(), files: [] }
        } else if (cur && line.trim()) {
          const rel = posixPath(line.trim())
          if (!rel.startsWith('.worktrees/') && !isMacOsJunkPath(rel)) cur.files.push(rel)
        }
      }
      if (cur) commits.push(cur)
    }
  }

  const revertedCommits = []
  const fileTouches = new Map()
  for (const c of commits) {
    const isRevert = /^Revert\b|\brevert(?:ed|ing)?\s+(?:"|'|#|\bpr\b|\bcommit\b)|^回滚/i.test(c.subject)
    if (isRevert) revertedCommits.push({ hash: c.hash.slice(0, 8), ts: c.ts, subject: c.subject })
    for (const f of new Set(c.files)) {
      if (!fileTouches.has(f)) fileTouches.set(f, [])
      fileTouches.get(f).push({ hash: c.hash.slice(0, 8), ts: c.ts, subject: c.subject, isRevert })
    }
  }

  const WINDOW_48H = 48 * 3600
  const reworkHotspots = []
  for (const [file, list] of fileTouches.entries()) {
    const asc = [...list].sort((a, b) => a.ts - b.ts)
    let left = 0
    let maxIn48h = 0
    for (let right = 0; right < asc.length; right += 1) {
      while (asc[right].ts - asc[left].ts > WINDOW_48H) left += 1
      if (right - left + 1 > maxIn48h) maxIn48h = right - left + 1
    }
    const hasRevert = asc.some((x) => x.isRevert)
    if (maxIn48h >= 3 || (maxIn48h >= 2 && hasRevert)) {
      reworkHotspots.push({
        file, maxEditsIn48h: maxIn48h, totalTouches: asc.length, hasRevert,
        commitHashes: list.map((x) => x.hash).slice(0, 6),
        recentSubjects: list.map((x) => x.subject).slice(0, 4),
      })
    }
  }
  reworkHotspots.sort((a, b) => (b.maxEditsIn48h - a.maxEditsIn48h) || (b.totalTouches - a.totalTouches) || a.file.localeCompare(b.file))

  const totalCommits = commits.length
  const revertCount = revertedCommits.length
  const revertRate = totalCommits > 0 ? Number((revertCount / totalCommits).toFixed(4)) : 0
  const revertRatePct = `${(revertRate * 100).toFixed(1)}%`

  const recommendations = []
  if (revertCount > 0) {
    recommendations.push({
      priority: revertRate >= 0.1 || revertCount >= 2 ? 'high' : 'medium',
      reason: `${revertCount}/${totalCommits} recent commits (${revertRatePct}) are reverts`,
      action: 'Add missing regression tests or `smoke-verify:` command to AGENTS.md before resuming feature work.',
    })
  }
  for (const hs of reworkHotspots.slice(0, 5)) {
    recommendations.push({
      priority: hs.hasRevert || hs.maxEditsIn48h >= 4 ? 'high' : 'medium',
      reason: `Hotspot "${hs.file}" reworked ${hs.maxEditsIn48h}x within 48h`,
      action: hs.maxEditsIn48h >= 3
        ? `Apply 3-strike stop-loss on "${hs.file}": pause edits, add unit + smoke tests, and review module boundaries.`
        : `Add regression guard and test coverage for "${hs.file}".`,
    })
  }
  for (const sc of signalClusters.sinkCandidates.slice(0, 5)) {
    recommendations.push({
      priority: sc.count >= 3 ? 'high' : 'medium',
      reason: `Repeated governance signal "${sc.module}::${sc.pattern}" (${sc.count}x)`,
      action: sc.rootCauseFix,
    })
  }

  const nextSteps = recommendations.length > 0
    ? ['Sink top recommendations into static checks, `arch-rules`, or `smoke-verify` commands, then verify with `govern-audit.mjs cluster`.']
    : ['Recent history sample is healthy (low revert rate, no 48h churn hotspots).']

  const payload = {
    mode: 'sample', repoRoot: posixPath(workRoot), sampleWindow: limit, totalCommits,
    revertCount, revertRate, revertRatePct, revertedCommits, reworkHotspots,
    signalsPath: posixPath(signalsPath), signalSinkCandidates: signalClusters.sinkCandidates,
    recommendations, nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    const lines = [
      '=== DEV-GOVERN (SAMPLE) ===',
      `Repo Root     : ${payload.repoRoot}`,
      `Sample Window : last ${limit} commit(s) (observed=${totalCommits})`,
      `Revert Rate   : ${revertCount} / ${totalCommits} (${revertRatePct})`,
      `48h Hotspots  : ${reworkHotspots.length} file(s)`,
      `Signal Sinks  : ${signalClusters.sinkCandidates.length} repeated cluster(s)`,
    ]
    if (revertedCommits.length > 0) lines.push('', '--- Reverted Commits ---', ...revertedCommits.map((rc) => `  - ${rc.hash}: ${rc.subject}`))
    if (reworkHotspots.length > 0) lines.push('', '--- 48h Same-File Rework Hotspots ---', ...reworkHotspots.map((hs) => `  - ${hs.file}: maxIn48h=${hs.maxEditsIn48h}, total=${hs.totalTouches}, hasRevert=${hs.hasRevert} [${hs.commitHashes.join(', ')}]`))
    if (recommendations.length > 0) {
      lines.push('', '--- Rule-Sinking Recommendations ---')
      for (const rec of recommendations) lines.push(`  - [${rec.priority.toUpperCase()}] ${rec.reason}`, `      Action: ${rec.action}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return 0
}

export function buildGovernNextSteps({ mode, opts, mainRoot, cluster, devProfile, findings = [], plan, reconcileSummary, findingsCount }) {
  const skills = resolveAvailableSkills(mainRoot)
  const nextSteps = []
  const count = findingsCount ?? findings.length
  const hasExploreDebt = (Array.isArray(findings) && findings.some((f) =>
    /^(?:docs\.(?:missing-tdd|tdd-module-drift|tdd-stale-path|stale-vs-churn)|hygiene\.(?:god-file|arch-boundary))/.test(String(f.id ?? ''))))
    || Boolean(reconcileSummary && !reconcileSummary.tddPresent)
    || Boolean(plan?.hasExploreTargets)

  if (hasExploreDebt && skills.has('dev-explore')) {
    nextSteps.push('Explore module entrypoints & reusable infra before editing: `node ".agents/skills/dev-explore/scripts/repo-map.mjs"`')
  }

  if (mode === 'cluster') {
    nextSteps.push(cluster.sinkCandidateCount > 0
      ? `Promote ${cluster.sinkCandidateCount} repeated cluster(s) (>=2) into static rules, arch-rules, or Dev Profile commands.`
      : 'No pattern has reached >=2 repeats yet; keep recording governance signals via `record`.')
  } else if (mode === 'reconcile') {
    if ((reconcileSummary?.worktrees?.stale?.length ?? 0) > 0 && skills.has('dev-flow')) {
      nextSteps.push('List stale worktrees and ask user before cleanup: `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task <taskId>`')
    }
    nextSteps.push('Review [RECONCILE] findings: keep AGENTS.md <= 30720 bytes, update docs/TDD.md drift, and ask user before cleaning stale worktrees.')
  } else if (opts.planOnly || mode === 'plan' || mode === 'plan-only' || opts.writeTodo) {
    if (opts.writeTodo && plan?.todoRel && skills.has('dev-plan')) {
      nextSteps.push(`Audit generated remediation Todo: \`node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${plan.todoRel}"\``)
    }
    if (plan?.hasL3Debt && skills.has('dev-plan')) {
      nextSteps.push('L3 cross-module/boundary debt detected: run `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --touches-contract --summary "Governance L3 refactor"` before structural split.')
    }
    if (skills.has('dev-flow')) {
      const todoFlag = opts.writeTodo && plan?.todoRel ? ` --todo "${plan.todoRel}"` : ''
      nextSteps.push(`Review remediation batches above; run \`--execute\` or start an isolated flow task: \`node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${plan?.taskId ?? 'govern-remediation'} --case ${plan?.hasL3Debt ? 4 : 3} --slug govern-remediation${todoFlag}\``)
    } else {
      nextSteps.push('Review remediation batches above; create a feature branch (`git switch -c fix/govern`) and resolve batch by batch.')
    }
  } else if (opts.execute) {
    const cmds = [...(devProfile['quick-test'] ?? []), ...(devProfile['full-test'] ?? [])]
    if (skills.has('dev-review')) {
      nextSteps.push('Fix Batch 1 items first, then run verification commands before `node ".agents/skills/dev-review/scripts/review-pack.mjs" --local`:')
    } else {
      nextSteps.push('Fix Batch 1 items first, then run verification commands and inspect `git diff`:')
    }
    for (const c of cmds) nextSteps.push(`  $ ${c}`)
  } else if (opts.issues || mode === 'issues') {
    nextSteps.push(opts.applyIssues ? 'GitHub issues created safely via UTF-8 --body-file.' : 'Review generated payloads; pass `--apply-issues` after confirming with user to create on GitHub.')
  } else {
    nextSteps.push('Run `plan` (`--plan-only`), `reconcile`, `audit --cluster`, or `sample` for rule-sinking.')
    if (count > 0 && !opts.baselineApplied && !opts.baselineSaved) {
      nextSteps.push('Legacy repo tip: run with `--save-baseline` to snapshot existing gaps, then use default/incremental `--changed` mode to focus on new regressions.')
    }
  }
  return nextSteps
}

export function formatTextReport(result) {
  const lines = []
  const counts = result.counts
  lines.push(`=== DEV-GOVERN (${result.mode.toUpperCase()}) ===`)
  lines.push(`Repo Root  : ${posixPath(result.repoRoot)}`)
  if (result.mainRoot && result.mainRoot !== result.repoRoot) lines.push(`Main Root  : ${posixPath(result.mainRoot)}`)
  lines.push(`Scope      : ${result.scope || '(entire repository)'}`)
  lines.push(`Categories : ${result.categories.join(', ')}`)
  lines.push(`Summary    : ${result.findings.length} finding(s) [critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, info=${counts.info}]`)
  if (result.baselineApplied || result.changedApplied || result.baselineSaved) {
    lines.push(`Filter     : baselineApplied=${Boolean(result.baselineApplied)} (suppressed=${result.suppressedByBaseline ?? 0}), changedOnly=${Boolean(result.changedApplied)} (suppressed=${result.suppressedByChanged ?? 0})${result.baselineSaved ? ', baselineSaved=true' : ''}`)
  }

  if (result.reconcileSummary) {
    const r = result.reconcileSummary
    const wc = r.worktrees.counts ?? {}
    lines.push('', '[RECONCILE]')
    lines.push(`  AGENTS.md Bytes : ${r.agentsBytes ?? 'missing'} / ${AGENTS_MAX_BYTES} (warn >= ${AGENTS_WARN_BYTES})`)
    lines.push(`  docs/TDD.md     : ${r.tddPresent ? 'present' : 'missing'}`)
    if (Array.isArray(r.evergreenDocs) && r.evergreenDocs.length > 0) {
      lines.push(`  Evergreen Docs  : ${r.evergreenDocs.map((d) => `${d.path}(${d.family})`).join(', ')}`)
    }
    if (r.featureMapDrift) {
      const fd = r.featureMapDrift
      lines.push(`  FeatureMap Drift: unmapped=${fd.unmappedSourceModules?.length ?? 0}, missing=${fd.missingEntryPaths?.length ?? 0}, stale=${fd.staleFeatures?.length ?? 0}, hotSkew=${fd.hotDocSkewModules?.length ?? 0}`)
    }
    if (Array.isArray(r.nextCommands) && r.nextCommands.length > 0) {
      lines.push(`  Next Commands   : ${r.nextCommands.join(' ; ')}`)
    }
    lines.push(`  Worktrees       : ${r.worktrees.total} registered [merged=${wc.merged ?? 0}, squash_or_rebase=${wc.squash_or_rebase_merged ?? 0}, no_own_commits=${wc.no_own_commits ?? 0}, unmerged=${wc.unmerged ?? 0}] | ${r.worktrees.stale.length} candidate(s)`)
    lines.push(`  Skill Manifest  : ${r.manifest.status}${r.manifest.checkedFiles !== undefined ? ` (${r.manifest.checkedFiles} managed files, ${r.manifest.customizedCount ?? 0} customized)` : ''}`)
  }

  if (result.testInventory) {
    const ti = result.testInventory
    const dirs = (ti.testDirectories ?? []).slice(0, 6).map((d) => `${d.dir}(${d.files})`).join(', ') || 'none'
    const scriptBuckets = Object.keys(ti.definedScripts ?? {}).join(', ') || 'none'
    lines.push('', '[TEST_INVENTORY]')
    lines.push(`  Test Files      : ${ti.totalTestFiles} | Dirs: ${dirs}`)
    lines.push(`  CI Config       : ${ti.hasCiConfig ? `present (${(ti.ciConfigFiles ?? []).join(', ') || 'workflows'})` : 'none (local-only profile/scripts)'}`)
    lines.push(`  Defined Scripts : ${scriptBuckets}`)
  }

  lines.push('', '[GAP_SCAN]')
  lines.push(`  total=${result.findings.length} critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} info=${counts.info}`)
  if (result.findings.length === 0) {
    lines.push('  No new/unbaselined governance gaps found in selected scope/categories.')
  } else {
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
      const tag = f.baselineStatus ? `[${f.baselineStatus.toUpperCase()}]` : ''
      lines.push(`  - [${f.severity.toUpperCase()}][${f.category}]${tag} ${f.id}: ${f.title}${loc}`)
      if (f.action) lines.push(`      Action: ${f.action}`)
    }
  }

  if (result.cluster) {
    lines.push('', '--- Governance Buffer Clusters (Module + Pattern, >=2 => Rule Sinking) ---')
    lines.push(`  Events=${result.cluster.totalEvents} (signals=${result.cluster.signalEvents}, audit=${result.cluster.auditFindings}) | Clusters=${result.cluster.totalClusters} | Sink Candidates=${result.cluster.sinkCandidateCount}`)
    for (const c of result.cluster.clusters.slice(0, 15)) {
      const tag = c.sinkCandidate ? `[RULE_SINK:${c.recommendedTier}]` : '[OBSERVE]'
      lines.push(`  - ${tag} ${c.key} x${c.count} (signals=${c.signalCount}, audit=${c.auditCount})`)
      if (c.sinkCandidate) lines.push(`      Action: ${c.rootCauseFix}`)
    }
  }

  if (result.plan) {
    lines.push('', '--- Remediation Plan ---')
    for (const b of result.plan.batches) {
      lines.push(`  Batch ${b.batch}: ${b.name} (${b.items.length} item(s))`)
      for (const item of b.items.slice(0, 8)) lines.push(`    - [${item.severity}] ${item.title}`)
      if (b.items.length > 8) lines.push(`    ... +${b.items.length - 8} more`)
    }
    lines.push(`  Todo Draft Path: ${result.plan.todoRel}`)
  }

  if (result.issues) {
    lines.push('', '--- GitHub Issue Payloads (UTF-8 --body-file safe) ---')
    if (result.issues.length === 0) lines.push('  No actionable findings to convert into issues.')
    else {
      for (let i = 0; i < result.issues.length; i += 1) {
        const iss = result.issues[i]
        lines.push(`  Issue #${i + 1}: ${iss.title}`, `    Labels: ${iss.labels.join(', ')}`)
        lines.push(`    Safe Command: write UTF-8 temp file, then run \`gh issue create --title "${iss.title.replace(/"/g, '\\"')}" --body-file <tmp.md>\``)
      }
    }
  }

  if (result.loop) {
    lines.push('', '--- Multi-Round Convergence Loop ---')
    lines.push(`  Round ${result.loop.snapshot.round} | Tracker: ${result.loop.statePath}`)
    lines.push(`  Remaining: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}`)
  }

  lines.push('', '[NEXT STEP]')
  for (const s of result.nextSteps) lines.push(`  ${s}`)
  return lines.join('\n')
}

export function governStatePath(mainRoot) {
  return join(mainRoot, '.worktrees', '.state', 'govern-state.json')
}

export function loadGovernState(mainRoot) {
  const raw = readJsonSafe(governStatePath(mainRoot))
  return {
    schemaVersion: 1,
    lastAudit: raw?.lastAudit ?? null,
    lastRetro: raw?.lastRetro ?? null,
    tier1Escalations: (raw?.tier1Escalations && typeof raw.tier1Escalations === 'object') ? raw.tier1Escalations : {},
    tier3Fallbacks: Array.isArray(raw?.tier3Fallbacks) ? raw.tier3Fallbacks : [],
    skips: Array.isArray(raw?.skips) ? raw.skips : [],
  }
}

async function saveGovernState(mainRoot, gitDir, isGit, state) {
  if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
  const path = governStatePath(mainRoot)
  writeJsonAtomic(path, { ...state, updatedAt: new Date().toISOString() })
  return posixPath(path)
}

export async function recordGovernAuditCheckpoint(mainRoot, gitDir, isGit, entry = {}) {
  const state = loadGovernState(mainRoot)
  state.lastAudit = {
    at: new Date().toISOString(),
    headSha: entry.headSha ?? null,
    changed: Boolean(entry.changed),
    taskId: entry.taskId ?? null,
    counts: entry.counts ?? {},
    findingsCount: Number(entry.findingsCount ?? 0),
  }
  const statePath = await saveGovernState(mainRoot, gitDir, isGit, state)
  return { statePath, lastAudit: state.lastAudit }
}

export async function recordGovernRetroCheckpoint(mainRoot, gitDir, isGit, entry = {}) {
  const state = loadGovernState(mainRoot)
  state.lastRetro = {
    at: new Date().toISOString(),
    taskId: entry.taskId ?? null,
    auto: Boolean(entry.auto),
    signalCount: Number(entry.signalCount ?? 0),
    tier1Count: Number(entry.tier1Count ?? 0),
    tier2Count: Number(entry.tier2Count ?? 0),
    tier3Count: Number(entry.tier3Count ?? 0),
  }
  if (entry.tier1Escalations && typeof entry.tier1Escalations === 'object') {
    state.tier1Escalations = { ...state.tier1Escalations, ...entry.tier1Escalations }
  }
  if (Array.isArray(entry.tier3Fallbacks)) {
    const byFp = new Map(state.tier3Fallbacks.map((x) => [x.fingerprint || x.text, x]))
    for (const item of entry.tier3Fallbacks) byFp.set(item.fingerprint || item.text, item)
    state.tier3Fallbacks = [...byFp.values()].slice(-50)
  }
  const statePath = await saveGovernState(mainRoot, gitDir, isGit, state)
  return { statePath, lastRetro: state.lastRetro, tier1Escalations: state.tier1Escalations }
}

export async function recordGovernSkip({ mainRoot, gitDir, isGit, taskId = null, stage = 'audit', reason = '', by = 'workflow' } = {}) {
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) return { ok: false, error: '--skip-govern requires non-empty --reason "<text>"' }
  const state = loadGovernState(mainRoot)
  const record = { at: new Date().toISOString(), taskId, stage, reason: cleanReason, by }
  state.skips = [...state.skips, record].slice(-100)
  const statePath = await saveGovernState(mainRoot, gitDir, isGit, state)
  const sig = await appendGovernSignal({
    mainRoot, gitDir, isGit, category: 'hygiene', module: 'dev-govern',
    pattern: 'govern.skipped', ruleId: `govern.skip.${stage}`, defectClass: 'suppression-bypass',
    severity: 'medium', source: 'govern-skip', message: `dev-govern skipped (${stage}): ${cleanReason}`,
    taskId, meta: { stage, reason: cleanReason, by },
  })
  return { ok: true, statePath, record, signalsPath: sig.signalsPath }
}
