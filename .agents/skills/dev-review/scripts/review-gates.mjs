/**
 * review-gates.mjs -- Doc-code parity, Mermaid 16/12 check, Fork private criteria
 * resolution, behavioral/structural dual gates, and door/blast-radius assessment.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { printNextStep, resolveAvailableSkills } from '../../lib/cli.mjs'
import { checkMermaidLabelWidth, isSharedMasterPrd } from '../../lib/docs.mjs'
import { posixPath, readTextSafe } from '../../lib/git.mjs'
import { hasHumanMergeAuthority as checkHumanMergeAuthority } from '../../lib/profile.mjs'
import {
  CODE_EXT_RE, GATE_WORKFLOW_FILE_RE, LOCKFILE_NAMES, TEST_FILE_RE, UI_VISUAL_EXT_RE,
  classifyDoorType, detectGateWeakeningInEntry, evaluateArchRules, isTestOrFixtureFile, matchGlob,
  scanStructuralHygiene, splitDiffByFile, summarizeHunkChanges,
} from '../../lib/static-gates.mjs'
import { hasValidE2eObservationOnHead } from '../../lib/workflow-policy.mjs'
import { formatReviewContextLines } from './review-context.mjs'

const EXPORT_API_RE = /^\s*(?:export\s+(?:default\s+|async\s+)?(?:function|const|let|var|class|type|interface|enum|\{)|module\.exports\b|exports\.[A-Za-z0-9_]+\s*=|pub\s+(?:fn|struct|enum|trait|mod|type)\s+|func\s+[A-Z]|def\s+[a-zA-Z][a-zA-Z0-9_]*\s*\()/
const CLI_FLAG_RE = /(?:--[a-z][a-z0-9-]{1,}\b|\bprocess\.argv\b|\bargparse\b|\bcommander\b|\byargs\b|\bclap\b|\bflag\.)/
const EXTRA_CI_FILE_RE = /(?:^|\/)(?:\.travis\.ya?ml|\.drone\.ya?ml|\.buildkite\/pipeline\.ya?ml|\.woodpecker(?:\.ya?ml|\/[^/]+\.ya?ml))$/i

/**
 * Checks code-to-doc parity, Mermaid 16/12 diagram truncation safety,
 * and open/unarchived Todo items (supporting contributor-fork private docs).
 */
export function checkDocCodeParity(repoRoot, mainRoot, diff, devProfile, task) {
  const changedFiles = new Set(diff.files.map((f) => f.file))
  for (const u of diff.untracked) changedFiles.add(u)
  const chunks = diff.chunks ?? splitDiffByFile(diff.text)

  const rootReadmes = []
  try {
    for (const name of readdirSync(repoRoot)) {
      if (/^readme$/i.test(name) || /^readme(?:\.[A-Za-z0-9_.-]+)?\.(?:md|mdx|rst|txt|adoc)$/i.test(name)) rootReadmes.push(name)
      else if (/^(?:contributing|security)(?:\.[A-Za-z0-9_.-]+)?\.md$/i.test(name)) rootReadmes.push(name)
    }
  } catch { /* ignore */ }
  const docCandidates = [...new Set(['docs/TDD.md', 'README.md', 'README.en.md', 'AGENTS.md', ...rootReadmes])]
  const existingDocs = docCandidates.filter((d) => existsSync(join(repoRoot, d)))
  const docsTouched = [...changedFiles].filter((f) =>
    f === 'docs/TDD.md'
    || /^README$/i.test(f)
    || /^README(?:\.[^/]+)?\.(?:md|mdx|rst|txt|adoc)$/i.test(f)
    || /^(?:CONTRIBUTING|SECURITY)(?:\.[^/]+)?\.md$/i.test(f)
    || f === 'AGENTS.md'
    || f.endsWith('/AGENTS.md'),
  )

  const triggers = []
  const inspectParityFile = (f, status, lines) => {
    if (f.startsWith('docs/') || f.endsWith('.md')) return
    if (status.startsWith('A') || status.startsWith('D') || status.startsWith('R') || status === '?') {
      if (CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f)) {
        triggers.push({ type: 'module-structure', file: f, detail: `File ${status} changes module layout` })
      }
    }
    if (CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f)) {
      if (lines.some((l) => EXPORT_API_RE.test(l))) {
        triggers.push({ type: 'exported-api', file: f, detail: 'Exported API signature touched' })
      }
      if (lines.some((l) => CLI_FLAG_RE.test(l))) {
        triggers.push({ type: 'cli-surface', file: f, detail: 'CLI option/argument handling touched' })
      }
    }
    const base = f.split('/').pop()
    if (['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', '.nvmrc', '.python-version'].includes(base)) {
      if (lines.some((l) => /engines|requires-python|rust-version|^go\s+/i.test(l)) || base === '.nvmrc' || base === '.python-version') {
        triggers.push({ type: 'runtime-req', file: f, detail: 'Environment/runtime requirements touched' })
      }
    }
    for (const hr of devProfile['high-risk'] ?? []) {
      if (matchGlob(f, hr)) {
        triggers.push({ type: 'high-risk-path', file: f, detail: `Matches high-risk rule "${hr}"` })
      }
    }
  }

  for (const entry of diff.files) {
    const fileDiff = chunks.get(entry.file) ?? ''
    const { added, removed } = summarizeHunkChanges(fileDiff)
    inspectParityFile(entry.file, entry.status, [...added, ...removed])
  }
  for (const u of diff.untracked) {
    const raw = readTextSafe(join(repoRoot, u))
    inspectParityFile(u, '?', raw ? raw.split('\n') : [])
  }

  const mermaidViolations = []
  const deletedFiles = new Set(diff.files.filter((f) => f.status === 'D').map((f) => f.file))
  for (const f of [...changedFiles].sort()) {
    if (deletedFiles.has(f) || !/\.mdx?$/i.test(f)) continue
    const txt = readTextSafe(join(repoRoot, f))
    if (!txt || !/```+\s*mermaid/i.test(txt)) continue
    const mRes = checkMermaidLabelWidth(txt)
    for (const v of mRes.violations) {
      mermaidViolations.push({ file: f, ...v })
    }
  }

  const todoIssues = []
  const todoDir = join(repoRoot, 'docs', 'todo')
  const checkTodoFile = (relPath, { isPrivate = false } = {}) => {
    let normRel = posixPath(relPath)
    let abs = isPrivate ? join(mainRoot, normRel) : join(repoRoot, normRel)
    if (!existsSync(abs) && !isPrivate && normRel.startsWith('docs/todo/')) {
      const archivedRel = `docs/archive/todo/${normRel.slice('docs/todo/'.length)}`
      const archivedAbs = join(repoRoot, archivedRel)
      if (existsSync(archivedAbs)) {
        normRel = archivedRel
        abs = archivedAbs
      }
    }
    const txt = readTextSafe(abs)
    if (!txt) return
    const unchecked = (txt.match(/^- \[ \]\s+.+$/gm) ?? []).length
    const isArchived = isPrivate || normRel.startsWith('docs/archive/todo/')
    if (unchecked > 0 || !isArchived) {
      todoIssues.push({
        file: normRel,
        unchecked,
        unarchived: !isArchived,
        ...(isPrivate ? { privateIsolated: true } : {}),
      })
    }
  }

  if (task?.privateTodoFile) checkTodoFile(task.privateTodoFile, { isPrivate: true })
  else if (task?.todoFile) checkTodoFile(task.todoFile)

  for (const f of changedFiles) {
    if (f.startsWith('docs/todo/') && f.endsWith('.md')) {
      if (!todoIssues.some((t) => t.file === f)) checkTodoFile(f)
    }
  }
  if (task && !task.privateDocsDir && existsSync(todoDir)) {
    try {
      for (const name of readdirSync(todoDir)) {
        if (!name.endsWith('.md')) continue
        const rel = `docs/todo/${name}`
        if (!todoIssues.some((t) => t.file === rel) && (!task.slug || name.includes(task.slug))) {
          checkTodoFile(rel)
        }
      }
    } catch { /* ignore */ }
  }

  const parityMissingDocs = triggers.length > 0 && existingDocs.length > 0 && docsTouched.length === 0
  return {
    triggers,
    existingDocs,
    docsTouched,
    parityMissingDocs,
    todoIssues,
    mermaidViolations,
  }
}

/**
 * Reads frozen acceptance criteria C1..Cn from task docs, including
 * `.worktrees/.state/private-docs/<taskId>/` for contributor-fork mode.
 */
export function parseAcceptanceCriteria(repoRoot, mainRoot, task) {
  const criteria = []
  const seen = new Set()
  const appendCriteriaFromText = (txt, sourceLabel) => {
    if (!txt) return
    let inFence = false
    let nextAuto = 1
    for (const rawLine of String(txt).replace(/\r\n/g, '\n').split('\n')) {
      if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
      if (inFence) continue
      const m = /^- \[([ xX])\]\s+(?:(C\d+)\s*:\s*)?(.+)$/.exec(rawLine.trim())
      if (!m) continue
      let id = m[2] ? m[2].toUpperCase() : null
      if (!id) {
        while (seen.has(`C${nextAuto}`)) nextAuto += 1
        id = `C${nextAuto}`
        nextAuto += 1
      }
      if (seen.has(id)) continue
      seen.add(id)
      criteria.push({ id, checked: m[1].toLowerCase() === 'x', text: m[3].trim(), source: sourceLabel })
    }
  }

  const readFrom = (relPath) => {
    if (!relPath) return
    const p1 = join(repoRoot, relPath)
    const p2 = join(mainRoot, relPath)
    const txt = readTextSafe(p1) ?? readTextSafe(p2)
    if (!txt) return
    for (const line of txt.split('\n')) {
      const m = /^- \[([ xX])\]\s+(C\d+)\s*:\s*(.+)$/.exec(line.trim())
      if (!m) continue
      const id = m[2]
      if (seen.has(id)) continue
      seen.add(id)
      criteria.push({ id, checked: m[1].toLowerCase() === 'x', text: m[3].trim(), source: posixPath(relPath) })
    }
  }

  const sliceSpecRel = task?.privateSpecFile ?? task?.specFile ?? task?.archivedSpecFile ?? null
  readFrom(task?.privateSpecFile)
  readFrom(task?.privateTodoFile)
  readFrom(task?.specFile)
  readFrom(task?.todoFile)
  readFrom(task?.archivedSpecFile)
  readFrom(task?.archivedTodoFile)

  if (task?.privateDocsDir) {
    const privDirAbs = join(mainRoot, task.privateDocsDir)
    if (existsSync(privDirAbs)) {
      try {
        for (const name of readdirSync(privDirAbs).sort()) {
          if (name.endsWith('.md') && !name.endsWith('-prd.md')) readFrom(posixPath(join(task.privateDocsDir, name)))
        }
      } catch { /* ignore */ }
    }
  }

  // C22: 1:N 总控 PRD 不将全波未领条款注入当前切片审查包；仅当非共享 1:1 PRD 或无切片 SPEC/Todo 时读取 PRD 条款
  for (const prdRel of [task?.privatePrdFile, task?.prdFile, task?.archivedPrdFile].filter(Boolean)) {
    const sharedInRepo = isSharedMasterPrd(repoRoot, prdRel, sliceSpecRel) || isSharedMasterPrd(mainRoot, prdRel, sliceSpecRel)
    if (criteria.length > 0 && sharedInRepo) continue
    readFrom(prdRel)
  }

  // Case 2 或外部 PR 无本地规划文件时，回退解析账本 issueContext 与 prContext 复选框
  if (criteria.length === 0) {
    for (const iss of Array.isArray(task?.issueContext) ? task.issueContext : []) {
      const issLabel = iss?.number ? `issue#${iss.number}` : 'issue'
      appendCriteriaFromText(iss?.body || iss?.summary || '', issLabel)
    }
    if (task?.prContext && typeof task.prContext === 'object') {
      const prNum = task.prNumber ?? task.prContext.number ?? null
      const prLabel = prNum ? `pr#${prNum}` : 'pr'
      appendCriteriaFromText(task.prContext.body || task.prContext.summary || '', prLabel)
    }
  }
  return criteria
}

export function collectHighRiskHits(diff, devProfile) {
  const hits = []
  const rules = devProfile['high-risk'] ?? []
  const allEntries = [...diff.files, ...diff.untracked.map((file) => ({ status: '?', file }))]
  for (const entry of allEntries) {
    for (const rule of rules) {
      if (matchGlob(entry.file, rule)) {
        hits.push({ file: entry.file, rule })
      }
    }
  }
  return hits
}

export function collectGateWeakeningHits(reviewRoot, diff) {
  const chunks = diff.chunks ?? splitDiffByFile(diff.text)
  const hits = []
  for (const entry of [...diff.files, ...diff.untracked.map((file) => ({ status: '?', file }))]) {
    const chunk = chunks.get(entry.file) ?? ''
    const parsed = summarizeHunkChanges(chunk)
    let { added } = parsed
    const { removed, hunks } = parsed
    if (entry.status === '?' && added.length === 0) {
      const raw = readTextSafe(join(reviewRoot, entry.file))
      if (raw) added = raw.split('\n')
    }
    const found = detectGateWeakeningInEntry({ file: entry.file, status: entry.status, added, removed, hunks })
    for (const item of found) hits.push(item)
  }
  return hits
}

export function assessBehavioralGate({
  diff, devProfile, task, headSha, gateWeakenedHits, parity, untrustedAdvisories = [], evidence = null, receipt = null,
}) {
  const runtimeFilesTouched = [...diff.files.map((f) => f.file), ...diff.untracked]
    .filter((f) => CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f))
  const visualFilesChanged = [...new Set([...diff.files.map((f) => f.file), ...diff.untracked])]
    .map((f) => posixPath(f))
    .filter((f) => UI_VISUAL_EXT_RE.test(f))
    .sort()
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const smokeCommands = devProfile['smoke-verify'] ?? []
  const smokeExplicitNone = Boolean(devProfile?.explicitNone instanceof Set ? devProfile.explicitNone.has('smoke-verify') : false)
  const hasProfileConfig = Boolean(
    smokeCommands.length > 0
    || (devProfile?.['quick-test']?.length ?? 0) > 0
    || (devProfile?.['full-test']?.length ?? 0) > 0
    || (devProfile?.['merge-gate']?.length ?? 0) > 0
    || (devProfile?.explicitNone?.size ?? 0) > 0,
  )
  const testCommands = [
    ...(devProfile['quick-test'] ?? []),
    ...(devProfile['full-test'] ?? []),
    ...(devProfile['merge-gate'] ?? []),
  ]
  const smokeRequired = runtimeFilesTouched.length > 0 && !smokeExplicitNone && (smokeCommands.length > 0 || hasProfileConfig)
  const headMatchesVerified = task?.verifiedHead
    ? (headSha !== 'UNBORN' && task.verifiedHead === headSha)
    : null
  const smokeVerifiedOnHead = Boolean(
    headSha && headSha !== 'UNBORN' && (
      (evidence?.smokeVerifiedOnHead && evidence?.headSha === headSha && !evidence?.dirty && evidence?.gates?.smoke?.exitCode === 0)
      || (receipt?.empiricalVerified?.headSha === headSha && receipt?.empiricalVerified?.executed !== false && !receipt?.empiricalVerified?.errorOnly && (smokeCommands.length === 0 || receipt?.empiricalVerified?.smokeExecuted !== false))
    ),
  )
  const e2eObservedOnHead = Boolean(
    headSha && headSha !== 'UNBORN' && (
      hasValidE2eObservationOnHead(evidence, headSha)
      || hasValidE2eObservationOnHead(receipt?.empiricalVerified, headSha)
      || (evidence?.visualCheckEvidence && evidence?.visualVerifiedHead === headSha)
    ),
  )
  const visualVerifiedOnHead = Boolean(
    empiricalVisualCheckRequired
    && task?.visualVerifiedHead
    && headSha !== 'UNBORN'
    && task.visualVerifiedHead === headSha,
  )

  const deterministicGateHits = gateWeakenedHits.filter((h) => h.severity !== 'advisory')
  const advisoryGateHits = gateWeakenedHits.filter((h) => h.severity === 'advisory')
  const warnings = []
  if (headMatchesVerified === false) {
    warnings.push(`verifiedHead (${task.verifiedHead.slice(0, 8)}) != HEAD (${headSha.slice(0, 8)}); re-verify required`)
  }
  for (const h of deterministicGateHits) {
    warnings.push(`Gate weakening in ${h.file}: ${h.reason}`)
  }
  for (const h of [...advisoryGateHits, ...untrustedAdvisories]) {
    warnings.push(`Assertion-change advisory in ${h.file}: ${h.reason}`)
  }
  if (smokeRequired && smokeCommands.length > 0 && (!smokeVerifiedOnHead || !e2eObservedOnHead)) {
    warnings.push('Runtime code touched with smoke-verify configured: execute end-to-end verification and observe real behavior (--e2e-evidence) before approval.')
  } else if (smokeRequired && smokeCommands.length === 0 && !e2eObservedOnHead) {
    warnings.push('Runtime code touched without `smoke-verify:` or `smoke-verify: none` in Dev Profile; configure `smoke-verify:` or supply real runtime E2E observation (--e2e-evidence).')
  }
  if (empiricalVisualCheckRequired && !visualVerifiedOnHead) {
    warnings.push(
      `UI/visual files changed (${visualFilesChanged.length}: ${visualFilesChanged.slice(0, 5).join(', ')}): inspect rendered output, interactive flows, and Light/Dark contrast rather than relying on source reading alone.`,
    )
  }
  if ((parity.mermaidViolations?.length ?? 0) > 0) {
    warnings.push(`Mermaid label width/HTML violations (${parity.mermaidViolations.length}) detected in changed Markdown docs (limits: rect/subgraph<=16, diamond/edge<=12, no HTML tags).`)
  }

  let status = 'verify-required'
  if (deterministicGateHits.length > 0) status = 'gate-weakened'
  else if (headMatchesVerified === false) status = 'needs-reverify'
  else if (
    headMatchesVerified === true
    && (!smokeRequired || (smokeVerifiedOnHead && e2eObservedOnHead))
    && (!empiricalVisualCheckRequired || visualVerifiedOnHead)
  ) {
    status = 'verified-on-head'
  }

  return {
    status,
    verifiedHead: task?.verifiedHead ?? null,
    visualVerifiedHead: task?.visualVerifiedHead ?? null,
    visualVerifiedOnHead,
    smokeVerifiedOnHead,
    e2eObservedOnHead,
    smokeExplicitNone,
    e2eObservation: evidence?.e2eObservation ?? receipt?.empiricalVerified?.e2eObservation ?? null,
    headSha,
    headMatchesVerified,
    smokeVerifyCommands: smokeCommands,
    testCommands,
    runtimeFilesTouched,
    visualFilesChanged,
    empiricalVisualCheckRequired,
    smokeRequired,
    verificationHierarchy: 'Formal deterministic checks + empirical runtime/E2E verification > adversarial code reading',
    antiHumanProxyNote: smokeRequired
      ? 'Execute end-to-end runtime verification locally in detached review worktree and observe real exit/output/state behavior (never substitute unit tests alone or outsource to humans).'
      : 'Run formal & empirical checks locally before judging; Must Fix requires a violated frozen C*, failed formal gate, or reproducible empirical failure.',
    warnings,
  }
}

export function assessStructuralGate({ reviewRoot, diff, devProfile, parity }) {
  const chunks = diff.chunks ?? splitDiffByFile(diff.text)
  const tombstoneComments = []
  const excuseSuppressions = []
  const godFiles = []
  const codeFilesOnDisk = []

  const allEntries = [...diff.files, ...diff.untracked.map((file) => ({ status: '?', file }))]
  if (allEntries.length === 0) {
    return {
      status: 'nothing-to-review',
      tombstoneComments: [],
      excuseSuppressions: [],
      archViolations: [],
      godFiles: [],
      mermaidViolations: [],
    }
  }
  for (const entry of allEntries) {
    const f = entry.file
    if (entry.status === 'D') continue
    if (!CODE_EXT_RE.test(f)) continue
    codeFilesOnDisk.push(f)

    let added = []
    if (entry.status === '?') {
      const raw = readTextSafe(join(reviewRoot, f))
      if (raw) added = raw.split('\n')
    } else {
      added = summarizeHunkChanges(chunks.get(f) ?? '').added
    }

    const fullText = !isTestOrFixtureFile(f) ? readTextSafe(join(reviewRoot, f), 2 * 1024 * 1024) : undefined
    const fullLineCount = fullText ? fullText.split('\n').length : 0
    const hy = scanStructuralHygiene({ fileRel: f, lines: added, fullLineCount, warnLines: 800, highLines: 1500 })

    for (const tc of hy.tombstoneComments) {
      tombstoneComments.push({
        file: f,
        excerpt: tc.excerpt,
        hint: 'Remove historical evolution commentary; comments should describe current invariants only.',
      })
    }
    for (const ex of hy.excuseSuppressions) {
      excuseSuppressions.push({
        file: f,
        excerpt: ex.excerpt,
        hint: 'Fix the underlying type/lint/architecture issue rather than silencing checks with suppression pragmas or workaround markers.',
      })
    }
    if (hy.godFile) {
      godFiles.push({
        file: f,
        lines: hy.godFile.lines,
        severity: hy.godFile.severity,
        hint: `File exceeds 800 lines (${hy.godFile.lines}); extract cohesive modules instead of expanding a god file.`,
      })
    }
  }

  const archRes = evaluateArchRules(reviewRoot, codeFilesOnDisk, devProfile['arch-rules'])
  const archViolations = archRes.violations
  const mermaidViolations = parity?.mermaidViolations ?? []
  const issueCount = tombstoneComments.length + excuseSuppressions.length + archViolations.length + godFiles.length + mermaidViolations.length
  return {
    status: archViolations.length > 0 || excuseSuppressions.length > 0 ? 'attention-required' : issueCount > 0 ? 'warn' : 'clean',
    tombstoneComments,
    excuseSuppressions,
    archViolations,
    godFiles,
    mermaidViolations,
  }
}

export function assessDoor({ reviewRoot, mainRoot, diff, devProfile, hrHits, parity, task, gateWeakenedHits }) {
  const deterministicHits = gateWeakenedHits.filter((h) => h.severity !== 'advisory')
  const gateWeakened = deterministicHits.length > 0
  const agentsText = readTextSafe(join(reviewRoot, 'AGENTS.md')) ?? readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
  const hasHumanMergeAuthority = checkHumanMergeAuthority(agentsText)
  const allFiles = [...diff.files.map((f) => f.file), ...diff.untracked]
  const totalFiles = allFiles.length
  const doNotEdit = devProfile['do-not-edit'] ?? []

  // Exempt docs moved into docs/archive/ by `flow finalize` for THIS task so paired archiving does not self-conflict
  const ownArchived = new Set([
    task?.archivedTodoFile,
    task?.archivedSpecFile,
    task?.archivedPrdFile,
    ...(task?.todoFile?.startsWith('docs/archive/') ? [task.todoFile] : []),
    ...(task?.specFile?.startsWith('docs/archive/') ? [task.specFile] : []),
    ...(task?.prdFile?.startsWith('docs/archive/') ? [task.prdFile] : []),
  ].filter(Boolean))

  const nonExemptDoNotEdit = allFiles.some(
    (f) => !ownArchived.has(f) && doNotEdit.some((pat) => matchGlob(f, pat)),
  )

  const oneWayReasons = []
  let untrustedSurface = false
  if (gateWeakened) oneWayReasons.push('Weakens test assertions, skips tests, or loosens CI/lint/type gates')
  if (hasHumanMergeAuthority) oneWayReasons.push('AGENTS.md specifies merge-authority: human')
  if (task?.doorType === 'one-way') oneWayReasons.push('Task metadata declares doorType=one-way')

  for (const f of allFiles) {
    const base = f.split('/').pop()?.toLowerCase() ?? ''
    if (GATE_WORKFLOW_FILE_RE.test(f) || EXTRA_CI_FILE_RE.test(f) || f.startsWith('.husky/') || f.startsWith('.githooks/') || f.startsWith('.agents/skills/')) {
      untrustedSurface = true
      if (!oneWayReasons.includes('Modifies CI workflow, git hook, or agent skill entrypoint')) {
        oneWayReasons.push('Modifies CI workflow, git hook, or agent skill entrypoint')
      }
    }
    if (base === 'package.json' || base === '.gitattributes' || LOCKFILE_NAMES.has(base) || base === 'releasing.md') {
      if (!oneWayReasons.includes('Modifies packaging, lockfile, or release contract boundary')) {
        oneWayReasons.push('Modifies packaging, lockfile, or release contract boundary')
      }
    }
    if (/(?:^|\/)(?:migrations?|schema|auth|rbac|acl|security|secrets?)(?:\/|\.)/i.test(f)) {
      if (!oneWayReasons.includes('Modifies schema/migration or security/auth boundary')) {
        oneWayReasons.push('Modifies schema/migration or security/auth boundary')
      }
    }
    if (!ownArchived.has(f) && doNotEdit.some((pat) => matchGlob(f, pat))) {
      if (!oneWayReasons.includes('Modifies path listed in do-not-edit')) {
        oneWayReasons.push('Modifies path listed in do-not-edit')
      }
    }
  }

  const baseDoor = classifyDoorType({
    changedFiles: allFiles,
    highRisk: [],
    gateWeakened,
    doNotEdit: nonExemptDoNotEdit ? doNotEdit : [],
    agentsText,
    task,
    diffBytes: diff.bytes,
  })

  const isOneWay = oneWayReasons.length > 0 || (baseDoor.doorType === 'one-way' && !allFiles.every((f) => ownArchived.has(f)))
  const doorType = isOneWay ? 'one-way' : 'two-way'
  let blastRadius = 'low'
  if (gateWeakened || hrHits.length >= 2 || oneWayReasons.length >= 2 || totalFiles >= 10 || diff.bytes >= 40000) {
    blastRadius = 'high'
  } else if (oneWayReasons.length === 1 || hrHits.length === 1 || parity.triggers.length > 0 || totalFiles >= 4) {
    blastRadius = 'medium'
  }

  let mergeAuthority = 'reviewer-direct'
  if (gateWeakened || hasHumanMergeAuthority || untrustedSurface || doorType === 'one-way') {
    mergeAuthority = 'human-required'
  } else if (hrHits.length > 0) {
    mergeAuthority = 'reviewer-with-fault-injection'
  }

  return {
    doorType,
    gateWeakened,
    gateWeakenedReasons: deterministicHits.map((h) => `${h.file}: ${h.reason}`),
    advisoryGateHints: gateWeakenedHits.filter((h) => h.severity === 'advisory').map((h) => `${h.file}: ${h.reason}`),
    blastRadius,
    mergeAuthority,
    reasons: oneWayReasons.length > 0 ? oneWayReasons : baseDoor.reasons,
    rollbackPath: doorType === 'one-way'
      ? 'Irreversible or high-cost rollback; require explicit human sign-off and staged rollback plan before merge.'
      : 'Two-way door: cleanly reversible via `git revert <merge-commit>`.',
  }
}

export function buildPackNextSteps({ opts, mode, task, round, mainRoot, untrustedWarnings, doorAssessment, structuralGate, empiricalGate, reviewContext = null }) {
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
  if ((reviewContext?.staleHighRiskTools?.length ?? 0) > 0) {
    nextSteps.push(`高风险验证工具已过期（${reviewContext.staleHighRiskTools.map((t) => t.toolId).join(', ')}）：禁止直接复用，须先升级工具或执行等效实时 E2E 实证。`)
  }
  for (const h of (reviewContext?.solidificationHints ?? []).slice(0, 2)) {
    nextSteps.push(`[${h.code}] ${h.suggestion}`)
  }
  if (empiricalGate?.required && !empiricalGate.readyForDiff) {
    nextSteps.push('先跑实证与故障注入，再 --include-diff 取全文（未完成前 --include-diff 将退出码 3 阻断 BLOCKED_EMPIRICAL_FIRST）：')
    for (const cmd of empiricalGate.unblockCommands ?? []) {
      nextSteps.push(`  ${cmd}`)
    }
  }
  if (mode === 'local' || mode === 'staged' || mode === 'base') {
    nextSteps.push('Fix any [PARITY_WARN] / structural / test issues locally before creating a commit or opening a PR.')
  } else if (mode === 'task' && task) {
    if (!empiricalGate?.required || empiricalGate.readyForDiff) {
      nextSteps.push('实证与故障注入已就绪（或当前无需额外阻断），可按需传 `--include-diff` 取全文并核对：')
    }
    nextSteps.push('')
    nextSteps.push('记结论（--evidence 必填，写你实际跑的命令与输出摘要）：')
    nextSteps.push(`  node ".agents/skills/dev-review/scripts/review-pack.mjs" record --task ${task.taskId} --round ${round} --verdict pass|changes --reviewer-id <reviewer-id> --review-token <flow next 输出的令牌> --evidence "<跑了什么、结果如何>"`)
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
    const exp = pack.explored ?? pack.task.explored
    lines.push(`Explored : ${exp ? `${exp.tier} (symbols=${exp.symbolCount}, at=${exp.at}${exp.by ? `, by=${exp.by}` : ''})` : 'MISSING (BLOCKED_NOT_EXPLORED)'}`)
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

  if (pack.reviewContext) lines.push(...formatReviewContextLines(pack.reviewContext))

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
  lines.push('  Verification Precedence: Formal static gates + empirical E2E execution/observation > adversarial code reading.')
  if (bg.smokeRequired) {
    lines.push('  Generic E2E Run + Observe Checklist (unit tests do NOT replace end-to-end runtime proof):')
    lines.push('    - [ ] Execute real end-to-end command (`smoke-verify:` or explicit runtime entrypoint) against the review target')
    lines.push('    - [ ] Observe real exit code, output, state transitions, and pass `--e2e-evidence "<observation>"`')
  }
  if (bg.empiricalVisualCheckRequired) {
    lines.push('  Visual / UI Empirical Checklist (actual render + interaction + screenshots; never judge from reading code alone):')
    lines.push('    - [ ] Inspect the actual rendered page, component, or SVG in a live runtime/renderer (confirm clean render and zero console/load errors)')
    lines.push('    - [ ] Walk through interactive user flows end-to-end (inputs, state transitions, error/empty states)')
    lines.push('    - [ ] Capture and inspect Light & Dark theme screenshots for contrast, clipping, text overlap, and legibility')
    lines.push('    - [ ] Pass each real output with `--artifact <path>` (non-empty regular file) or record the render observation; `--visual-checked` alone is not accepted')
    lines.push('    - [ ] No render environment here? Declare `--visual-blocked-reason "<reason>"` so the gap is disclosed instead of faked')
  }
  lines.push('  Post-Unlock Substance & Fault Injection Protocol (after --include-diff, judge C* & business-flows substance/root cause; NO subjective nitpicks):')
  lines.push('    1. Temporarily break 1 core branch/guard in the review worktree and run test -> MUST FAIL.')
  lines.push('    2. Restore cleanly (`git checkout -- .`) and re-run test -> MUST PASS.')
  lines.push('    3. Classify findings strictly: Must Fix / Should Fix / Pre-existing (list all R1 locations at once).')

  if (pack.empiricalGate) {
    const eg = pack.empiricalGate
    lines.push('', '--- Empirical-First Gate ---')
    lines.push(`  Required   : ${eg.required} | FaultRequired=${eg.faultRequired} | ReadyForDiff=${eg.readyForDiff}`)
    lines.push(`  Fingerprint: ${eg.workspaceFingerprint ?? 'none'}`)
    if ((eg.missingSteps ?? []).length > 0) {
      lines.push(`  Missing    : ${eg.missingSteps.join(', ')}`)
      lines.push('  Unblock    :')
      for (const cmd of eg.unblockCommands ?? []) lines.push(`    - ${cmd}`)
    } else {
      lines.push('  Status     : empirical & fault-injection gate ready for --include-diff.')
    }
  }

  if (pack.untrustedWarnings.length > 0) {
    lines.push('', '--- [APPROVED_EXEC_WITH_WARNINGS] ---')
    lines.push('  Human execution approval active. Use `--ignore-scripts` for dependency install.')
    for (const h of pack.untrustedWarnings) lines.push(`  - [${h.category}] ${h.file}: ${h.reason}`)
  }

  if (includeFullDiff && fullDiffText) {
    const diffLines = fullDiffText.split('\n')
    lines.push('', '--- Diff Patch (Context-Isolated) ---')
    lines.push(...diffLines)
  } else if (fullDiffText) {
    lines.push('', '--- Diff Patch (Suppressed Until Empirical Gate Passes) ---')
    lines.push('  Raw patch suppressed (hunkIndex/summary only). Complete empirical & fault-injection steps, then pass --include-diff.')
  }

  lines.push('', '[NEXT STEP]')
  for (const step of pack.nextSteps) lines.push(`  ${step}`)
  return lines.join('\n')
}
