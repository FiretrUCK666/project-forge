/**
 * review-gates.mjs -- Doc-code parity, Mermaid 16/12 check, Fork private criteria
 * resolution, behavioral/structural dual gates, and door/blast-radius assessment.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { checkMermaidLabelWidth } from '../../lib/docs.mjs'
import { posixPath, readTextSafe } from '../../lib/git.mjs'
import {
  CODE_EXT_RE, GATE_WORKFLOW_FILE_RE, LOCKFILE_NAMES, TEST_FILE_RE, UI_VISUAL_EXT_RE,
  classifyDoorType, detectGateWeakeningInEntry, evaluateArchRules, matchGlob,
  scanStructuralHygiene, splitDiffByFile, summarizeHunkChanges,
} from '../../lib/static-gates.mjs'

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

  const docCandidates = ['docs/TDD.md', 'README.md', 'README.en.md', 'AGENTS.md']
  const existingDocs = docCandidates.filter((d) => existsSync(join(repoRoot, d)))
  const docsTouched = [...changedFiles].filter((f) =>
    f === 'docs/TDD.md' || /^README(?:\.[^/]+)?\.md$/i.test(f) || f === 'AGENTS.md' || f.endsWith('/AGENTS.md'),
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

  readFrom(task?.privateSpecFile)
  readFrom(task?.privateTodoFile)
  readFrom(task?.privatePrdFile)
  readFrom(task?.specFile)
  readFrom(task?.todoFile)
  readFrom(task?.prdFile)

  if (task?.privateDocsDir) {
    const privDirAbs = join(mainRoot, task.privateDocsDir)
    if (existsSync(privDirAbs)) {
      try {
        for (const name of readdirSync(privDirAbs).sort()) {
          if (name.endsWith('.md')) readFrom(posixPath(join(task.privateDocsDir, name)))
        }
      } catch { /* ignore */ }
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

export function assessBehavioralGate({ diff, devProfile, task, headSha, gateWeakenedHits, parity, untrustedAdvisories = [] }) {
  const runtimeFilesTouched = [...diff.files.map((f) => f.file), ...diff.untracked]
    .filter((f) => CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f))
  const visualFilesChanged = [...new Set([...diff.files.map((f) => f.file), ...diff.untracked])]
    .map((f) => posixPath(f))
    .filter((f) => UI_VISUAL_EXT_RE.test(f))
    .sort()
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const smokeCommands = devProfile['smoke-verify'] ?? []
  const testCommands = [
    ...(devProfile['quick-test'] ?? []),
    ...(devProfile['full-test'] ?? []),
    ...(devProfile['merge-gate'] ?? []),
  ]
  const smokeRequired = runtimeFilesTouched.length > 0 && smokeCommands.length > 0
  const headMatchesVerified = task?.verifiedHead
    ? (headSha !== 'UNBORN' && task.verifiedHead === headSha)
    : null
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
  if (smokeRequired) {
    warnings.push('Runtime code touched and smoke-verify configured: run smoke-verify locally and confirm real behavior before approval.')
  } else if (runtimeFilesTouched.length > 0 && smokeCommands.length === 0 && parity.triggers.some((t) => t.type === 'cli-surface')) {
    warnings.push('CLI/entrypoint code touched without `smoke-verify:` in AGENTS.md Dev Profile; exercise real CLI path manually.')
  }
  if (empiricalVisualCheckRequired && !visualVerifiedOnHead) {
    warnings.push(
      `UI/visual files changed (${visualFilesChanged.length}: ${visualFilesChanged.slice(0, 5).join(', ')}): open actual rendered page/asset, walk through user interactions end-to-end, and check Light/Dark screenshots rather than relying on source reading alone.`,
    )
  }
  if ((parity.mermaidViolations?.length ?? 0) > 0) {
    warnings.push(`Mermaid label width/HTML violations (${parity.mermaidViolations.length}) detected in changed Markdown docs (limits: rect/subgraph<=16, diamond/edge<=12, no HTML tags).`)
  }

  let status = 'verify-required'
  if (deterministicGateHits.length > 0) status = 'gate-weakened'
  else if (headMatchesVerified === false) status = 'needs-reverify'
  else if (headMatchesVerified === true && !smokeRequired && (!empiricalVisualCheckRequired || visualVerifiedOnHead)) {
    status = 'verified-on-head'
  }

  return {
    status,
    verifiedHead: task?.verifiedHead ?? null,
    visualVerifiedHead: task?.visualVerifiedHead ?? null,
    visualVerifiedOnHead,
    headSha,
    headMatchesVerified,
    smokeVerifyCommands: smokeCommands,
    testCommands,
    runtimeFilesTouched,
    visualFilesChanged,
    empiricalVisualCheckRequired,
    smokeRequired,
    verificationHierarchy: 'Formal deterministic checks + empirical runtime/UI verification > adversarial code reading',
    antiHumanProxyNote: smokeRequired
      ? 'Execute smoke-verify locally in detached review worktree and verify stdout/exit behavior (never outsource initial runtime verification to humans).'
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

    const fullText = !TEST_FILE_RE.test(f) ? readTextSafe(join(reviewRoot, f), 2 * 1024 * 1024) : undefined
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
  const hasHumanMergeAuthority = /^\s*(?:[-*]\s*)?`?merge-authority`?\s*[:：]\s*human\b/im.test(agentsText)
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
