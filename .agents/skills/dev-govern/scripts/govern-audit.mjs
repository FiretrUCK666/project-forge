#!/usr/bin/env node
/**
 * govern-audit.mjs -- Repository code audit, tech-debt planning, baseline/incremental
 * governance loop tracking, GitHub issue payloads, harness reconcile, and release-prep.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parseStandardCli } from '../../lib/cli.mjs'
import {
  canonicalPath, gitRun, gitRunBuffer, isMacOsJunkPath, isMainModule,
  posixPath, resolveDefaultBranch, resolveRepoRoots, samePath, writeAtomic,
} from '../../lib/git.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import {
  auditDeadcode, auditHygiene, auditPerf, auditSecurity, readTextStrictInfo, walkFiles,
} from './govern-checks.mjs'
import {
  buildClusterReport, buildGovernNextSteps, buildIssues, applyGitHubIssues,
  collectChangedFilesSet, countBySeverity, filterFindingsByBaselineAndChanged,
  formatTextReport, handleRecordSignal, handleSampleCommits, loadBaseline,
  readSignalsJsonl, resolveGovernStateDir, saveBaseline, updateLoopState,
} from './govern-state.mjs'
import { auditDocs, buildPlan } from './govern-docs.mjs'
import { auditTests } from './govern-tests.mjs'
import { handleReleasePrep } from './release-prep-lib.mjs'

const ALL_CATEGORIES = ['security', 'deadcode', 'tests', 'docs', 'hygiene', 'perf']
const VALID_CATEGORIES = new Set(ALL_CATEGORIES)
const SUBCOMMANDS = ['audit', 'reconcile', 'plan', 'issues', 'record', 'cluster', 'sample', 'release-prep']

function printHelp() {
  process.stdout.write([
    '用法：node govern-audit.mjs [audit|reconcile|plan|issues|record|cluster|sample|release-prep] [targetDir] [options]',
    '',
    'Subcommands & Modes:',
    '  audit | --audit-only         Read-only audit outputting findings + [GAP_SCAN] (default)',
    '  reconcile | --reconcile      Check AGENTS.md 24KB/30KB cap & refs, TDD/Mermaid, 4-state .worktrees/, manifest v2',
    '  plan | --plan-only           Generate phased remediation batches + standard `-todo.md` preview',
    '  issues | --issues            Generate UTF-8 GitHub Issue payloads (dry-run by default)',
    '  record                       Append governance signal into <gitCommonDir>/project-forge-govern/signals.jsonl',
    '  cluster                      Group signals & findings by module+pattern, flagging >= 2 repeat sink candidates',
    '  sample [--commits 30]        Inspect git Revert rate, 48h same-file rework hotspots, and rule-sinking actions',
    '  release-prep                 Collect noise-filtered multi-version release-prep brief (shallow-aware)',
    '',
    'Options:',
    '  --dir <path>                 Repository directory (or pass positional targetDir)',
    '  --scope <dir>                Restrict scan to subdirectory inside repository',
    '  --categories <list>          Comma-separated subset of: security,deadcode,tests,docs,hygiene,perf',
    '  --save-baseline              Save full findings snapshot to <mainRoot>/.worktrees/.state/govern-baseline.json',
    '  --changed                    Incremental audit limited to branch/uncommitted changed files',
    '  --all                        Ignore baseline & --changed filters and output all findings',
    '  --cluster                    Attach module+pattern deduplicated clusters to audit output',
    '  --signals-only               For `cluster`, read signals.jsonl only without running full live audit',
    '  --execute                    Guided closed-loop execution plan + verification checklist',
    '  --loop                       Include/track multi-round governance state in <mainRoot>/.worktrees/.state/',
    '  --apply-issues               Actually create GitHub issues via `gh issue create --body-file`',
    '  --write-todo                 Write standard Frontmatter `-todo.md` to docs/todo/ (with `plan` / `--plan-only`)',
    '  --commits <N>                Commit window size for `sample` (default: 30)',
    '  --from <tag|rev>             Base tag/commit for `release-prep`',
    '  --to <rev>                   Target revision for `release-prep` (default: HEAD)',
    '  --version <ver>              Target release version override for `release-prep`',
    '  --strict                     Exit 1 if critical/high findings remain after filtering',
    '  --json                       Emit machine-readable JSON',
    '',
    'Record Options:',
    '  --pattern <key> --message <text> [--module <dir>] [--file <path>] [--category <cat>] [--severity <sev>] [--source <src>]',
    '',
  ].join('\n'))
}

function parseRawAgentsMeta(workRoot) {
  const info = readTextStrictInfo(join(workRoot, 'AGENTS.md'))
  if (!info?.text) return { hasQuickKey: false, hasFullKey: false, hasHighRiskKey: false }
  const txt = info.text
  return {
    hasQuickKey: /^\s*(?:[-*]\s*)?`?quick-test`?\s*:/m.test(txt),
    hasFullKey: /^\s*(?:[-*]\s*)?`?full-test`?\s*:/m.test(txt),
    hasHighRiskKey: /^\s*(?:[-*]\s*)?`?high-risk`?\s*:/m.test(txt),
  }
}

function normalizeParsedArgs(cli) {
  const { opts } = cli
  let sub = cli.sub
  if (!sub && opts._.length === 1 && SUBCOMMANDS.includes(opts._[0])) {
    sub = opts._[0]
  } else if (opts._.length > 1) {
    throw new Error(`多余的位置参数：${opts._.slice(1).join(' ')}`)
  } else if (opts._.length === 1 && opts.dir !== undefined && !SUBCOMMANDS.includes(opts._[0])) {
    throw new Error(`未知子命令或多余参数：${opts._[0]}`)
  } else if (!sub && opts._.length === 1 && opts.dir === undefined) {
    const cand = resolve(String(opts._[0]))
    if (!existsSync(cand) || !statSync(cand).isDirectory()) {
      const msg = String(opts._[0]).includes('/') || String(opts._[0]).includes('\\') || String(opts._[0]).startsWith('.')
        ? `Error: directory does not exist: ${cand}`
        : `未知子命令或不存在的目录：${opts._[0]}`
      const err = new Error(msg)
      err.exitCode = msg.startsWith('Error: directory') ? 1 : 2
      throw err
    }
  }

  let categories = null
  if (opts.categories !== undefined) {
    const list = String(opts.categories).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    for (const c of list) {
      if (!VALID_CATEGORIES.has(c)) throw new Error(`Unknown category "${c}". Valid: ${ALL_CATEGORIES.join(', ')}`)
    }
    categories = list
  }

  const commits = opts.commits !== undefined ? Number(opts.commits) : 30
  if (sub === 'sample' && (!Number.isInteger(commits) || commits < 1)) {
    throw new Error('--commits must be a positive integer.')
  }

  return {
    sub,
    targetDir: cli.targetDir,
    reconcile: Boolean(opts.reconcile || sub === 'reconcile'),
    auditOnly: Boolean(opts['audit-only'] || sub === 'audit'),
    planOnly: Boolean(opts['plan-only'] || sub === 'plan'),
    execute: Boolean(opts.execute),
    cluster: Boolean(opts.cluster || sub === 'cluster'),
    signalsOnly: Boolean(opts['signals-only']),
    saveBaseline: Boolean(opts['save-baseline']),
    changed: Boolean(opts.changed),
    all: Boolean(opts.all),
    commits,
    from: opts.from,
    to: opts.to ?? 'HEAD',
    version: opts.version,
    scope: opts.scope ?? '',
    categories,
    loop: Boolean(opts.loop),
    issues: Boolean(opts.issues || sub === 'issues'),
    applyIssues: Boolean(opts['apply-issues']),
    writeTodo: Boolean(opts['write-todo']),
    strict: Boolean(opts.strict),
    json: Boolean(opts.json),
    category: opts.category,
    pattern: opts.pattern,
    module: opts.module,
    file: opts.file,
    severity: opts.severity,
    source: opts.source,
    message: opts.message,
    note: opts.note,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return 0
  }

  let opts
  try {
    const cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      allowPositionalWithoutSubcommand: true,
      positionalDir: 'auto',
      booleanFlags: [
        'audit-only', 'plan-only', 'execute', 'reconcile', 'cluster',
        'signals-only', 'loop', 'issues', 'apply-issues', 'write-todo',
        'strict', 'save-baseline', 'changed', 'all',
      ],
      valueFlags: [
        'scope', 'categories', 'commits', 'from', 'to', 'version',
        'category', 'pattern', 'rule', 'module', 'file', 'severity',
        'source', 'message', 'title', 'note',
      ],
      aliases: { rule: 'pattern', title: 'message' },
      usageHint: 'govern-audit.mjs [audit|reconcile|plan|issues|record|cluster|sample|release-prep] [dir]',
    })
    opts = normalizeParsedArgs(cli)
  } catch (err) {
    process.stderr.write(`${err.message.startsWith('Error:') ? err.message : `Error: ${err.message}`}\n`)
    return err.exitCode ?? 2
  }

  if (!existsSync(opts.targetDir)) {
    process.stderr.write(`Error: directory does not exist: ${opts.targetDir}\n`)
    return 1
  }

  const roots = await resolveRepoRoots(opts.targetDir)
  const { isGit, mainRoot, workTreeRoot, gitDir } = roots

  if (opts.sub === 'record') return handleRecordSignal(mainRoot, gitDir, isGit, opts)
  if (opts.sub === 'sample') return await handleSampleCommits(workTreeRoot, mainRoot, gitDir, isGit, opts)
  if (opts.sub === 'release-prep') return await handleReleasePrep(workTreeRoot, mainRoot, gitDir, isGit, opts)

  let scopeRel = ''
  if (opts.scope) {
    const scopeAbs = canonicalPath(resolve(workTreeRoot, opts.scope))
    const rootCanon = canonicalPath(workTreeRoot)
    const rel = posixPath(relative(rootCanon, scopeAbs))
    const isInside = samePath(scopeAbs, rootCanon)
      || (Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel) && !/^[A-Za-z]:/.test(rel))
    if (!existsSync(scopeAbs) || !isInside) {
      process.stderr.write(`Error: invalid --scope "${opts.scope}" inside ${workTreeRoot}\n`)
      return 1
    }
    scopeRel = samePath(scopeAbs, rootCanon) ? '' : rel
  }

  const categories = opts.reconcile
    ? (opts.categories ?? ['docs', 'hygiene', 'security'])
    : (opts.categories ?? ALL_CATEGORIES)
  const catSet = new Set(categories)
  const runLiveAudit = !(opts.sub === 'cluster' && opts.signalsOnly)
  const files = runLiveAudit ? walkFiles(workTreeRoot, scopeRel) : []

  const trackedSet = new Set()
  let defaultBranch = null
  let headSha = null
  if (isGit) {
    if (runLiveAudit) {
      const ls = await gitRunBuffer(workTreeRoot, ['ls-files', '-z'])
      if (ls.ok) {
        for (const p of ls.stdout.toString('utf8').split('\0')) {
          const clean = posixPath(p)
          if (clean && !isMacOsJunkPath(clean)) trackedSet.add(clean)
        }
      }
    }
    defaultBranch = await resolveDefaultBranch(workTreeRoot)
    const hr = await gitRun(workTreeRoot, ['rev-parse', 'HEAD'])
    if (hr.ok && hr.stdout.trim()) headSha = hr.stdout.trim()
  }

  const devProfile = parseDevProfile(workTreeRoot)
  const rawAgentsMeta = parseRawAgentsMeta(workTreeRoot)
  const rawFindings = []
  let testsMeta = { ciRunSteps: [], testInventory: null }

  if (runLiveAudit) {
    if (catSet.has('security')) auditSecurity(files, trackedSet, rawFindings)
    if (catSet.has('deadcode')) auditDeadcode(files, rawFindings)
    if (catSet.has('tests')) testsMeta = auditTests(workTreeRoot, files, devProfile, rawAgentsMeta, rawFindings)
    if (catSet.has('docs')) await auditDocs(workTreeRoot, isGit, files, devProfile, defaultBranch, scopeRel, rawAgentsMeta, rawFindings)
  }
  let hygieneMeta = { worktrees: { total: 0, counts: {}, entries: [], stale: [] }, manifest: { present: false, status: 'not-checked', issues: [] }, archViolations: [] }
  if (runLiveAudit && catSet.has('hygiene')) {
    hygieneMeta = await auditHygiene(workTreeRoot, mainRoot, isGit, files, defaultBranch, devProfile, rawFindings)
  }
  if (runLiveAudit && catSet.has('perf')) auditPerf(workTreeRoot, files, rawFindings)

  let baselineSavedInfo = null
  if (opts.saveBaseline && runLiveAudit) {
    baselineSavedInfo = await saveBaseline(mainRoot, gitDir, isGit, rawFindings, headSha)
  }

  const existingBaseline = (!opts.saveBaseline && runLiveAudit) ? loadBaseline(mainRoot) : null
  const changedSet = (!opts.all && opts.changed && runLiveAudit)
    ? await collectChangedFilesSet(workTreeRoot, isGit, defaultBranch)
    : null
  const filtered = filterFindingsByBaselineAndChanged({
    findings: rawFindings,
    baseline: existingBaseline,
    changedSet,
    isAll: opts.all,
    isChanged: opts.changed,
  })
  const findings = filtered.findings

  let reconcileSummary
  if (opts.reconcile) {
    const agentsInfo = readTextStrictInfo(join(workTreeRoot, 'AGENTS.md'))
    reconcileSummary = {
      agentsBytes: agentsInfo?.text ? Buffer.byteLength(agentsInfo.text, 'utf8') : null,
      tddPresent: existsSync(join(workTreeRoot, 'docs', 'TDD.md')),
      worktrees: hygieneMeta.worktrees,
      manifest: hygieneMeta.manifest,
    }
  }

  let cluster
  let signalsPath
  if (opts.cluster) {
    const stateDir = resolveGovernStateDir(mainRoot, gitDir, isGit)
    const loaded = readSignalsJsonl(stateDir)
    signalsPath = posixPath(loaded.signalsPath)
    cluster = buildClusterReport(loaded.events, findings)
  }

  const mode = opts.sub === 'cluster' ? 'cluster'
    : opts.reconcile ? 'reconcile'
      : opts.execute ? 'execute'
        : opts.planOnly ? 'plan-only'
          : opts.issues ? 'issues' : 'audit-only'

  const plan = (opts.planOnly || opts.execute) ? await buildPlan(findings, workTreeRoot, devProfile, isGit) : undefined
  if (opts.planOnly && opts.writeTodo && plan) {
    writeAtomic(join(workTreeRoot, plan.todoRel), plan.todoDraft)
  }

  const issues = opts.issues ? buildIssues(findings) : undefined
  let applyResult
  if (opts.issues && opts.applyIssues && issues) {
    applyResult = await applyGitHubIssues(workTreeRoot, issues)
    if (applyResult.error) {
      process.stderr.write(`Error: ${applyResult.error}\n`)
      return 1
    }
  }

  const loop = opts.loop ? await updateLoopState(mainRoot, gitDir, isGit, findings, opts.execute) : undefined
  const counts = countBySeverity(findings)
  const nextSteps = buildGovernNextSteps({
    mode,
    opts: { ...opts, baselineApplied: filtered.baselineApplied, baselineSaved: Boolean(baselineSavedInfo) },
    mainRoot,
    cluster,
    devProfile,
    findingsCount: findings.length,
  })

  const result = {
    mode,
    repoRoot: posixPath(workTreeRoot),
    mainRoot: posixPath(mainRoot),
    scope: scopeRel,
    categories,
    counts,
    findings,
    baselineApplied: filtered.baselineApplied,
    changedApplied: filtered.changedApplied,
    totalRawFindings: filtered.totalRawFindings,
    suppressedByBaseline: filtered.suppressedByBaseline,
    suppressedByChanged: filtered.suppressedByChanged,
    ...(baselineSavedInfo ? { baselineSaved: true, baselinePath: baselineSavedInfo.path, baselineCount: baselineSavedInfo.count } : {}),
    testInventory: testsMeta.testInventory,
    ciRunSteps: testsMeta.ciRunSteps,
    cluster,
    signalsPath,
    reconcileSummary,
    plan,
    issues,
    applyResult,
    loop,
    nextSteps,
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${formatTextReport(result)}\n`)

  if (opts.strict && (counts.critical > 0 || counts.high > 0)) return 1
  return 0
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().then((code) => process.exit(code))
}
