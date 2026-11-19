/**
 * release-prep-lib.mjs -- Multi-version release-prep orchestrator, public surface
 * cross-check, and noise filter for dev-govern `release-prep`.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { posix } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { gitRun, posixPath } from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import {
  BREAKING_SUBJECT_RE,
  collectCommitsAndFiles,
  collectSpecsAndArchivedTodos,
  detectNotesMode,
  detectTagPrefix,
  detectVersionSources,
  extractBreakingSignals,
  resolveBaseAndRange,
} from './release-prep-collect.mjs'

const TEST_OR_FIXTURE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs)$/i
const CI_OR_INTERNAL_CONFIG_RE = /^(?:\.github\/|\.circleci\/|\.husky\/|\.vscode\/|\.idea\/|\.(?:eslint|prettier|stylelint|editorconfig|gitattributes|gitignore|travis\.yml|drone\.yml)|Jenkinsfile|azure-pipelines\.ya?ml)/i
const INTERNAL_PREFIX_RE = /^(?:test|tests|chore|ci|build|style|refactor)(?:\([^)]*\))?:\s*/i
const TYPO_OR_FORMAT_RE = /^(?:(?:docs|style|chore)(?:\([^)]*\))?:\s*)?(?:fix\s+typos?|typos?|formatting|format\s+code|lint(?:\s+fix)?|whitespace|prettier|eslint|错别字|错字|排版|格式(?:整理|微调)?)\b/i
const VAGUE_SUBJECT_RE = /^(?:update|updates|updated|wip|misc|cleanup|clean\s*up|tweak|tweaks|fixup|squash|sync|temp|tmp|minor|adjust|changes|patch|fix|fix\s+bug|minor\s+changes|update\s+(?:code|files?|docs?|readme|cli|index|config)|修改|改动|更新|调整|微调|清理|同步|提交|临时|修复)$/i

function classifyPublicSurface(relPosix, pkgPublicPaths) {
  const f = posixPath(relPosix)
  if (TEST_OR_FIXTURE_RE.test(f)) return null
  if (pkgPublicPaths.has(f)) return 'package-entrypoint'
  if (/^SKILL\.md$/i.test(f) || /^kit\/skills\/[^/]+\/SKILL\.md$/i.test(f)) return 'skill-entry'
  if (/^README(?:\.[A-Za-z0-9_.-]+)?\.(?:md|mdx|rst|txt|adoc)$/i.test(f) || /^README$/i.test(f)) return 'readme'
  if (/^(?:RELEASING|CHANGELOG|CONTRIBUTING|SECURITY)(?:\.[A-Za-z0-9_.-]+)?\.md$/i.test(f)) return 'project-guide'
  if (/(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|manifest\.json|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(f) || /\.csproj$/i.test(f)) return 'manifest'
  if (/^(?:templates|kit)\//i.test(f)) return 'distributed-asset'
  if (/^(?:bin|cmd|cli)\//i.test(f)) return 'cli-entrypoint'
  if (/^(?:(?:packages|apps)\/[^/]+\/)?(?:src\/)?(?:index|main|cli|app|server|mod|lib)\.[^/]+$/i.test(f)) return 'top-level-entry'
  if (/^src\/[^/]+\/__init__\.py$/i.test(f)) return 'python-package-entry'
  if (/^[^/]+\.(?:mjs|cjs|js|ts|py|go|rs)$/i.test(f)) return 'root-module'
  if (/^scripts\/[^/]+\.(?:mjs|js|ts|py|sh)$/i.test(f)) return 'top-level-script'
  return null
}

function isContractDocFile(relPosix) {
  return /^(?:README(?:\.[A-Za-z0-9_.-]+)?\.(?:md|mdx|rst|txt|adoc)|README|SKILL\.md|(?:CHANGELOG|CONTRIBUTING|SECURITY|RELEASING)(?:\.[A-Za-z0-9_.-]+)?\.md|docs\/specs\/.+\.md|docs\/TDD\.md)$/i.test(posixPath(relPosix))
}

function cleanCommitSubject(subject) {
  let s = String(subject ?? '').trim()
  s = s.replace(/^(?:feat|feature|fix|bugfix|perf|security|docs|enh|enhancement|refactor|chore|style|test|build|ci)(?:\([^)]*\))?!?:\s*/i, '')
  s = s.replace(/(?:^|\s)\[?(?:Wave|Sprint|Task)\s*[-#]?\s*[A-Za-z0-9-]+\]?(?:\s*[:：\-|]+)?/gi, ' ')
  s = s.replace(/(?:^|\s)\[?C\d{1,3}(?:[-–]\d{1,3})?\]?(?:\s*[:：\-]+|(?=\s))/g, ' ')
  s = s.replace(/^[\s:：\-/|]+/, '').replace(/\s{2,}/g, ' ').trim()
  return s || String(subject ?? '').trim()
}

function inferCommitCategory(subject, body) {
  const s = String(subject ?? '')
  if (BREAKING_SUBJECT_RE.test(s) || /\bBREAKING\s+CHANGE\b/i.test(body || '')) return 'breaking'
  const m = /^(feat|feature|fix|bugfix|perf|security|docs|revert|enh|enhancement)\b/i.exec(s)
  if (m) {
    const t = m[1].toLowerCase()
    if (t === 'feat' || t === 'feature' || t === 'enh' || t === 'enhancement') return 'feature'
    if (t === 'fix' || t === 'bugfix') return 'fix'
    return t
  }
  if (/^(?:add|support|implement|introduce|enable|allow|create|新增|支持|实现|引入)/i.test(s)) return 'feature'
  if (/^(?:fix|resolve|prevent|handle|patch|repair|修复|解决|避免|拦截)/i.test(s)) return 'fix'
  return 'change'
}

function isAmbiguousCommitSubject(subject) {
  const raw = String(subject ?? '').trim()
  if (!raw) return true
  if (INTERNAL_PREFIX_RE.test(raw) && !BREAKING_SUBJECT_RE.test(raw)) return true
  if (VAGUE_SUBJECT_RE.test(raw)) return true
  const cleaned = cleanCommitSubject(raw)
  if (!cleaned || VAGUE_SUBJECT_RE.test(cleaned)) return true
  if (/^(?:update|tweak|adjust|modify|change|cleanup|clean|refactor|patch|bump|sync|misc)\s+\S+$/i.test(cleaned)) return true
  if (/^(?:feat|feature|fix|bugfix|perf|security|docs)(?:\([^)]*\))?!?:/i.test(raw) && cleaned.length >= 6) return false
  if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned.length < 6
  return cleaned.split(/\s+/).filter(Boolean).length <= 2 && cleaned.length <= 16
}

function isInternalNoiseCommit(commit, pkgPublicPaths) {
  const files = commit.files || []
  const s = commit.subject || ''
  if (BREAKING_SUBJECT_RE.test(s) || /\bBREAKING\s+CHANGE\b/i.test(commit.body || '')) return { filtered: false }
  if (/^(?:Merge\s+(?:branch|pull\s+request|remote-tracking)|Revert\b.*\[skip ci\])/i.test(s) && files.length === 0) {
    return { filtered: true, reason: 'merge-housekeeping' }
  }
  const allInternalFiles = files.length > 0 && files.every((f) => (
    f.startsWith('.worktrees/') || TEST_OR_FIXTURE_RE.test(f) || CI_OR_INTERNAL_CONFIG_RE.test(f)
  ))
  if (allInternalFiles) return { filtered: true, reason: 'tests-ci-or-worktree-only' }
  const touchesPublicOrContract = files.some((f) => classifyPublicSurface(f, pkgPublicPaths) !== null || isContractDocFile(f))
  if (TYPO_OR_FORMAT_RE.test(s) && !/^(?:feat|fix)(?:\([^)]*\))?:/i.test(s)) return { filtered: true, reason: 'typo-or-formatting' }
  if (INTERNAL_PREFIX_RE.test(s) && !touchesPublicOrContract) return { filtered: true, reason: 'internal-prefix-non-public' }
  return { filtered: false }
}

function buildTextBrief(payload) {
  const lines = [
    '=== DEV-GOVERN (RELEASE-PREP) ===',
    `Repo Root      : ${payload.repoRoot}`,
    `Range          : ${payload.range.rangeSpec} (mode=${payload.range.fromMode}, from=${payload.range.from || 'root'}, to=${payload.range.to}, shallow=${payload.range.isShallow})`,
    `Current Version: ${payload.version.currentVersion || '(not declared)'} | Target: ${payload.version.targetTag || payload.version.normalized || '(unset; pass --version X.Y.Z)'}`,
    `Notes Mode     : ${payload.notesMode.mode} -> ${payload.notesMode.targetFile}${payload.notesMode.existingNotePresent ? ' (already exists)' : ''}`,
    `Stats          : commits=${payload.stats.totalCommits}, userFacing=${payload.stats.userFacingCount}, filteredInternal=${payload.stats.filteredInternalCount}, publicTouched=${payload.stats.publicSurfaceCount}, unaccountedPublic=${payload.stats.unaccountedPublicCount}, breaking=${payload.stats.breakingSignalsCount}`,
  ]
  if (payload.shallowCloneWarning) lines.push(`WARNING        : ${payload.shallowCloneWarning}`)

  if (payload.version.versionSources.length > 0 || (payload.version.workspacePackages?.length ?? 0) > 0) {
    lines.push('', '--- Version Sources ---')
    for (const s of payload.version.versionSources) lines.push(`  - ${s.file} (${s.field}): ${s.version}`)
    for (const ws of payload.version.workspacePackages ?? []) {
      if (!payload.version.versionSources.some((r) => r.file === ws.file)) {
        lines.push(`  - [workspace:${ws.package}] ${ws.file} (${ws.field}): ${ws.version}`)
      }
    }
    if (payload.version.mismatchWarning) lines.push(`  Warning: ${payload.version.mismatchWarning}`)
  }

  if (payload.breakingSignals.length > 0) {
    lines.push('', '--- Breaking & Runtime Floor Signals ---')
    for (const b of payload.breakingSignals) lines.push(`  - [${b.type}] ${b.detail}`)
  }

  lines.push('', '--- User-Facing Release Note Candidates (Noise-Filtered) ---')
  if (payload.userFacingCandidates.length === 0) {
    lines.push('  No explicit user-facing commit candidates extracted; inspect unaccountedPublicFiles or specs below.')
  } else {
    for (const c of payload.userFacingCandidates) lines.push(`  - [${c.category.toUpperCase()}] ${c.summary} (${c.shortHash})`)
  }

  if (payload.implementedSpecs.length > 0 || payload.archivedOutcomes.length > 0) {
    lines.push('', '--- Implemented Specs & Archived Task Outcomes ---')
    for (const sp of payload.implementedSpecs) lines.push(`  - [SPEC] ${sp.title} (${sp.file})${sp.summary ? `: ${sp.summary}` : ''}`)
    for (const td of payload.archivedOutcomes) lines.push(`  - [OUTCOME] ${td.title} (${td.file})${td.summary ? `: ${td.summary}` : ''}`)
  }

  if (payload.publicSurfaceTouched.length > 0 || payload.unaccountedPublicFiles.length > 0) {
    lines.push('', '--- Public Surface Cross-Check ---', `  Touched (${payload.publicSurfaceTouched.length}): ${payload.publicSurfaceTouched.join(', ')}`)
    if (payload.unaccountedPublicFiles.length > 0) {
      lines.push(`  [AUDIT_ALERT] Unaccounted Public Files (${payload.unaccountedPublicFiles.length}) -- verify each for user-visible notes:`)
      for (const u of payload.unaccountedPublicFiles) {
        lines.push(`    - ${u.file} [${u.kind}]: ${u.reason} (${u.commits.map((c) => `${c.shortHash} "${c.subject}"`).join('; ')})`)
      }
    }
  }
  return lines.join('\n')
}

export async function handleReleasePrep(repoRoot, mainRoot, gitDir, isGit, opts) {
  if (!isGit) {
    process.stderr.write('Error: `release-prep` requires a git repository.\n')
    return 1
  }
  const fastHeadOid = readHeadFast(resolveGitDirFast(repoRoot), gitDir)?.oid ?? null
  if (!fastHeadOid && !(await gitRun(repoRoot, ['rev-parse', '--verify', 'HEAD'])).ok) {
    process.stderr.write('Error: repository has no commits yet.\n')
    return 1
  }

  const range = await resolveBaseAndRange(repoRoot, gitDir, opts)
  if (range.error) {
    process.stderr.write(`Error: ${range.error}\n`)
    return range.code || 2
  }

  let requestedVersion = null
  let normalizedVersion = null
  const effectiveGitDir = gitDir ?? resolveGitDirFast(repoRoot)
  const [tagPrefix, versionData, commitData] = await Promise.all([
    detectTagPrefix(repoRoot, range.from, effectiveGitDir),
    detectVersionSources(repoRoot, range.toSha, effectiveGitDir),
    collectCommitsAndFiles(repoRoot, range),
  ])
  let targetTag = null
  if (opts.version !== undefined) {
    requestedVersion = String(opts.version).trim()
    if (!requestedVersion || !/\d/.test(requestedVersion) || /\s/.test(requestedVersion)) {
      process.stderr.write(`Error: invalid --version "${opts.version}"\n`)
      return 2
    }
    normalizedVersion = requestedVersion.replace(/^v/i, '')
    targetTag = /^v/i.test(requestedVersion) ? `v${normalizedVersion}` : `${tagPrefix}${normalizedVersion}`
  }

  const { rootSources, workspacePackages, sources, pkgPublicPaths, blobMap } = versionData
  const { commits, netChangedFiles } = commitData
  const currentVersion = sources[0]?.version ?? null
  const parityCheckSet = rootSources.length > 0 ? rootSources : sources
  const distinctVers = [...new Set(parityCheckSet.map((s) => s.version.replace(/^v/i, '')))]
  let mismatchWarning = null
  if (distinctVers.length > 1) {
    mismatchWarning = `Multiple version sources disagree: ${parityCheckSet.map((s) => `${s.file}=${s.version}`).join(', ')}`
  } else if (normalizedVersion && currentVersion && currentVersion.replace(/^v/i, '') === normalizedVersion) {
    mismatchWarning = null
  } else if (normalizedVersion && currentVersion) {
    mismatchWarning = `Sync authoritative manifest(s) from ${currentVersion} to ${normalizedVersion} in the release prep commit before tagging.`
  }

  const notesMode = detectNotesMode(repoRoot, targetTag)
  const shallowCloneWarning = range.isShallow
    ? 'Shallow clone detected (.git/shallow); git describe/log history is truncated — run `git fetch --unshallow --tags` before relying on release range or unaccountedPublicFiles.'
    : null

  const filteredCommits = []
  const userFacingCandidates = []
  const ambiguousCommits = []

  for (const c of commits) {
    const noise = isInternalNoiseCommit(c, pkgPublicPaths)
    if (noise.filtered) {
      filteredCommits.push({ hash: c.shortHash, reason: noise.reason, subject: c.subject })
      continue
    }
    const category = inferCommitCategory(c.subject, c.body)
    const ambiguous = isAmbiguousCommitSubject(c.subject)
    const entry = {
      hash: c.hash, shortHash: c.shortHash, category,
      summary: cleanCommitSubject(c.subject), rawSubject: c.subject, files: c.files, ambiguous,
    }
    if (ambiguous) ambiguousCommits.push(entry)
    else userFacingCandidates.push(entry)
  }

  const [breakingSignals, docOutcomes] = await Promise.all([
    extractBreakingSignals(repoRoot, range, netChangedFiles, commits, cleanCommitSubject),
    collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles, effectiveGitDir, blobMap),
  ])
  const { implementedSpecs, archivedOutcomes } = docOutcomes

  const publicSurfaceTouched = []
  const unaccountedPublicFiles = []
  const seenPublic = new Set()
  const describedTexts = [
    ...implementedSpecs.map((s) => `${s.title} ${s.summary}`),
    ...archivedOutcomes.map((a) => `${a.title} ${a.summary}`),
  ].join('\n')

  for (const item of netChangedFiles) {
    const kind = classifyPublicSurface(item.file, pkgPublicPaths)
    if (!kind || seenPublic.has(item.file)) continue
    seenPublic.add(item.file)
    publicSurfaceTouched.push(item.file)

    const touchingCommits = commits.filter((c) => c.files.includes(item.file))
    const hasClearUserCommit = touchingCommits.some((c) => (
      !isInternalNoiseCommit(c, pkgPublicPaths).filtered && !isAmbiguousCommitSubject(c.subject)
    ))
    const baseName = posix.basename(item.file)
    const mentionedInSpecOrTodo = describedTexts.includes(item.file) || (baseName.length > 4 && describedTexts.includes(baseName))
    const hasMinRuntimeDiff = breakingSignals.some((b) => b.file === item.file)

    if (!hasClearUserCommit && !mentionedInSpecOrTodo && !hasMinRuntimeDiff) {
      const reason = touchingCommits.length === 0
        ? 'Changed in net range diff without descriptive commit attribution'
        : touchingCommits.some((c) => isAmbiguousCommitSubject(c.subject))
          ? 'Touched only by ambiguous or non-standard commit subject(s)'
          : 'Touched only by internal-prefix commit(s) (chore/refactor/style/test/ci)'
      unaccountedPublicFiles.push({
        file: item.file, kind, reason,
        commits: touchingCommits.map((c) => ({ shortHash: c.shortHash, subject: c.subject })),
      })
    }
  }

  publicSurfaceTouched.sort()
  unaccountedPublicFiles.sort((a, b) => a.file.localeCompare(b.file))

  const nextSteps = [
    `Write user-facing release notes in ${notesMode.targetFile} focusing strictly on observable changes, upgrade actions, and resolved user issues.`,
    'Feel free to adapt sections or use CHANGELOG.md; omit empty sections rather than keeping blank headings.',
    'Do NOT create git tags, edit published releases, or rewrite pushed history unless a human maintainer explicitly orders a release.',
  ]
  if (unaccountedPublicFiles.length > 0) {
    nextSteps.unshift(`Inspect ${unaccountedPublicFiles.length} unaccounted public file(s) listed above to confirm whether any user-visible change was missed.`)
  }
  if (shallowCloneWarning) nextSteps.unshift(shallowCloneWarning)

  const payload = {
    mode: 'release-prep',
    repoRoot: posixPath(repoRoot),
    range: {
      from: range.from, fromSha: range.fromSha, fromMode: range.fromMode,
      to: range.to, toSha: range.toSha, rangeSpec: range.rangeSpec,
      isInitialRelease: range.isInitialRelease, isShallow: range.isShallow,
    },
    ...(shallowCloneWarning ? { shallowCloneWarning } : {}),
    version: {
      requested: requestedVersion, normalized: normalizedVersion, tagPrefix, targetTag,
      currentVersion, versionSources: sources, workspacePackages, mismatchWarning,
    },
    notesMode,
    stats: {
      totalCommits: commits.length, filteredInternalCount: filteredCommits.length,
      userFacingCount: userFacingCandidates.length, ambiguousCommitsCount: ambiguousCommits.length,
      netChangedFilesCount: netChangedFiles.length, publicSurfaceCount: publicSurfaceTouched.length,
      unaccountedPublicCount: unaccountedPublicFiles.length, breakingSignalsCount: breakingSignals.length,
    },
    breakingSignals, userFacingCandidates, ambiguousCommits, implementedSpecs,
    archivedOutcomes, publicSurfaceTouched, unaccountedPublicFiles, filteredCommits, nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${buildTextBrief(payload)}\n`)
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return 0
}
