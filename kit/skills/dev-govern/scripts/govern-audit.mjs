#!/usr/bin/env node
/**
 * govern-audit.mjs -- Repository code audit, tech-debt planning, baseline/incremental
 * governance loop tracking, GitHub issue payloads, harness reconcile, and release-prep.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 *
 * 子命令：
 *   audit | reconcile | plan | issues | record | cluster | sample | retro | release-prep
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli } from '../../lib/cli.mjs'
import { subcommandNamesFor } from '../../lib/subcommand-meta.mjs'
import {
  canonicalPath, gitRun, gitRunBuffer, isMacOsJunkPath, isMainModule,
  posixPath, readTextSafe, resolveDefaultBranch, resolveRepoRoots, samePath, writeAtomic,
} from '../../lib/git.mjs'
import { readGitIndexPathsFast, readHeadFast } from '../../lib/git-fast.mjs'
import { parseDevProfile, readDecisions } from '../../lib/profile.mjs'
import { FEATURE_MAP_REL, readFeatureMapSafe } from '../../lib/suite-inventory.mjs'
import {
  addFinding, auditDeadcode, auditHygiene, auditPerf, auditSecurity,
  createFileContentCache, readTextStrictInfo, setActiveFileCache, walkFiles,
} from './govern-checks.mjs'
import { runReconcileVerifyToolsAudit } from './govern-checks-hygiene.mjs'
import {
  buildClusterReport, buildGovernNextSteps, buildIssues, applyIssuesToBackend,
  collectChangedFilesSet, countBySeverity, filterFindingsByBaselineAndChanged,
  formatTextReport, handleRecordSignal, handleSampleCommits, loadBaseline,
  readSignalsJsonl, recordGovernAuditCheckpoint, recordGovernSkip,
  resolveGovernStateDir, saveBaseline, updateLoopState,
} from './govern-state.mjs'
import { auditDocs, buildPlan, discoverEvergreenAuthorityDocs } from './govern-docs.mjs'
import { handleRetro } from './govern-retro.mjs'
import { auditTests } from './govern-tests.mjs'
import { handleReleasePrep } from './release-prep-lib.mjs'

const ALL_CATEGORIES = ['security', 'deadcode', 'tests', 'docs', 'hygiene', 'perf']
const VALID_CATEGORIES = new Set(ALL_CATEGORIES)
const SUBCOMMANDS = subcommandNamesFor('govern-audit')

function printHelp() {
  process.stdout.write([
    '用法：node govern-audit.mjs [audit|reconcile|plan|issues|record|cluster|sample|retro|release-prep] [targetDir] [options]',
    '',
    'Subcommands & Modes:',
    '  audit | --audit-only         Read-only audit outputting findings + [GAP_SCAN] (default)',
    '  reconcile | --reconcile      Check AGENTS.md 24KB/30KB cap & refs, TDD/Mermaid, 4-state .worktrees/, manifest v3',
    '  plan | --plan-only           Generate phased remediation batches + standard `-todo.md` preview',
    '  issues | --issues            Generate UTF-8 Issue payloads via TaskBackend (dry-run by default)',
    '  record                       Append governance signal into <gitCommonDir>/project-forge-govern/signals.jsonl',
    '  cluster                      Group signals & findings by module+pattern, flagging >= 2 repeat sink candidates',
    '  sample [--commits 30]        Inspect git Revert rate, 48h same-file rework hotspots, and rule-sinking actions',
    '  retro [--task <id>]          Aggregate signals.jsonl & task ledgers to emit rule/gate/fixture patches (--apply-patches)',
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
    '  --apply-issues               Create issues via TaskBackend (GitHub: gh / local-only & generic-git: local-issues)',
    '  --write-todo                 Write standard Frontmatter `-todo.md` to docs/todo/ (with `plan` / `--plan-only`)',
    '  --commits <N>                Commit window size for `sample` (default: 30)',
    '  --from <tag|rev>             Base tag/commit for `release-prep`',
    '  --to <rev>                   Target revision for `release-prep` (default: HEAD)',
    '  --version <ver>              Target release version override for `release-prep`',
    '  --strict                     Exit 1 if critical/high findings remain after filtering',
    '  --quiet                      Concise lightweight output for automated lifecycle hooks',
    '  --auto                       Automatic post-merge/cleanup retro mode with checkpoint persistence',
    '  --allow-tier3-fallback       Explicit opt-in for `[TIER-3-FALLBACK]` prompt note (requires --reason)',
    '  --skip-govern                Skip audit/retro with mandatory auditable `--reason "<text>"`',
    '  --reason <text>              Audit rationale for `--skip-govern` or `--allow-tier3-fallback`',
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
    applyPatches: Boolean(opts['apply-patches']),
    writeTodo: Boolean(opts['write-todo']),
    strict: Boolean(opts.strict),
    quiet: Boolean(opts.quiet),
    auto: Boolean(opts.auto),
    allowTier3Fallback: Boolean(opts['allow-tier3-fallback']),
    skipGovern: Boolean(opts['skip-govern']),
    escalate: Boolean(opts.escalate),
    reason: opts.reason,
    json: Boolean(opts.json),
    task: opts.task,
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

async function main(argv = process.argv.slice(2), runtimeOpts = {}) {
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
        'signals-only', 'loop', 'issues', 'apply-issues', 'apply-patches', 'write-todo',
        'strict', 'quiet', 'auto', 'allow-tier3-fallback', 'skip-govern', 'escalate',
        'save-baseline', 'changed', 'all',
      ],
      valueFlags: [
        'scope', 'categories', 'commits', 'from', 'to', 'version',
        'category', 'pattern', 'rule', 'module', 'file', 'severity',
        'source', 'message', 'title', 'note', 'task', 'reason',
      ],
      aliases: { rule: 'pattern', title: 'message' },
      usageHint: `govern-audit.mjs [${SUBCOMMANDS.join('|')}] [dir]`,
    })
    opts = normalizeParsedArgs(cli)
    if (runtimeOpts && typeof runtimeOpts === 'object') {
      if (runtimeOpts._ghProbe !== undefined) opts._ghProbe = runtimeOpts._ghProbe
      if (runtimeOpts._ghClient !== undefined) opts._ghClient = runtimeOpts._ghClient
    }
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

  if (opts.sub === 'record') return await handleRecordSignal(mainRoot, gitDir, isGit, opts)
  if (opts.sub === 'sample') return await handleSampleCommits(workTreeRoot, mainRoot, gitDir, isGit, opts)
  if (opts.sub === 'retro') return await handleRetro(workTreeRoot, mainRoot, gitDir, isGit, opts)
  if (opts.sub === 'release-prep') return await handleReleasePrep(workTreeRoot, mainRoot, gitDir, isGit, opts)

  if (opts.skipGovern) {
    const skipRes = await recordGovernSkip({
      mainRoot, gitDir, isGit, taskId: opts.task ?? null, stage: opts.sub || 'audit', reason: opts.reason ?? '',
    })
    if (!skipRes.ok) {
      process.stderr.write(`Error: ${skipRes.error}\n`)
      return 2
    }
    const payload = { ok: true, mode: opts.sub || 'audit', skipped: true, recorded: true, ...skipRes }
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else process.stdout.write(`DEV-GOVERN AUDIT SKIPPED (RECORDED): ${skipRes.record.reason}\n`)
    return 0
  }

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
    const fastHeadOid = readHeadFast(roots.workTreeGitDir, gitDir)?.oid ?? null
    const fastTrackedSet = runLiveAudit ? readGitIndexPathsFast(workTreeRoot) : null
    const [ls, defBr, hr] = await Promise.all([
      runLiveAudit && !fastTrackedSet ? gitRunBuffer(workTreeRoot, ['ls-files', '-z']) : Promise.resolve(null),
      resolveDefaultBranch(workTreeRoot),
      fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(workTreeRoot, ['rev-parse', 'HEAD']),
    ])
    if (fastTrackedSet) {
      for (const p of fastTrackedSet) {
        const clean = posixPath(p)
        if (clean && !isMacOsJunkPath(clean)) trackedSet.add(clean)
      }
    } else if (ls?.ok) {
      for (const p of ls.stdout.toString('utf8').split('\0')) {
        const clean = posixPath(p)
        if (clean && !isMacOsJunkPath(clean)) trackedSet.add(clean)
      }
    }
    defaultBranch = defBr
    if (hr.ok && hr.stdout.trim()) headSha = hr.stdout.trim()
  }

  const fastChangedMode = Boolean(runLiveAudit && opts.changed && !opts.all && !opts.saveBaseline && !opts.reconcile)
  const preChangedSet = fastChangedMode ? await collectChangedFilesSet(workTreeRoot, isGit, defaultBranch) : null
  const scopedFiles = (fastChangedMode && opts.quiet && preChangedSet)
    ? files.filter((f) => preChangedSet.has(f.rel) || f.rel === 'AGENTS.md' || f.rel === 'docs/TDD.md')
    : files

  const fileCache = createFileContentCache()
  setActiveFileCache(fileCache)
  try {
    const devProfile = parseDevProfile(workTreeRoot)
    const rawAgentsMeta = parseRawAgentsMeta(workTreeRoot)
    const agentsRootForDecisions = existsSync(join(workTreeRoot, 'AGENTS.md')) ? workTreeRoot : mainRoot
    const agentsDecisions = readDecisions(readTextSafe(join(agentsRootForDecisions, 'AGENTS.md')) ?? '')
    const secretsArePlaceholders = agentsDecisions.has('secrets-are-placeholders')
    const rawFindings = []
    let testsMeta = { ciRunSteps: [], testInventory: null }

    const skipFullForEmptyChanged = fastChangedMode && opts.quiet && preChangedSet && preChangedSet.size === 0
    if (runLiveAudit && !skipFullForEmptyChanged) {
      if (catSet.has('security')) auditSecurity(scopedFiles, trackedSet, rawFindings, { secretsArePlaceholders })
      if (catSet.has('deadcode')) auditDeadcode(scopedFiles, rawFindings)
      if (catSet.has('tests') && (!opts.quiet || opts.saveBaseline)) testsMeta = auditTests(workTreeRoot, files, devProfile, rawAgentsMeta, rawFindings)
      if (catSet.has('perf') && (!opts.quiet || opts.saveBaseline)) auditPerf(workTreeRoot, scopedFiles, rawFindings)
    }
    let hygieneMeta = { worktrees: { total: 0, counts: {}, entries: [], stale: [] }, manifest: { present: false, status: 'not-checked', issues: [] }, archViolations: [] }
    if (runLiveAudit && !skipFullForEmptyChanged) {
      const [, hygRes] = await Promise.all([
        catSet.has('docs')
          ? auditDocs(workTreeRoot, isGit, opts.quiet ? scopedFiles : files, devProfile, defaultBranch, scopeRel, rawAgentsMeta, rawFindings)
          : Promise.resolve(),
        catSet.has('hygiene')
          ? auditHygiene(workTreeRoot, mainRoot, isGit, scopedFiles, defaultBranch, devProfile, rawFindings, {
            changedFilesSet: preChangedSet ?? (opts.changed && isGit ? await collectChangedFilesSet(workTreeRoot, isGit, defaultBranch) : null),
          })
          : Promise.resolve(hygieneMeta),
      ])
      hygieneMeta = hygRes
    }

    let verifyToolsAudit = null
    if (opts.reconcile) {
      verifyToolsAudit = await runReconcileVerifyToolsAudit(workTreeRoot, mainRoot, gitDir, rawFindings, addFinding)
    }

    return await finishAudit({
      opts, roots, workTreeRoot, mainRoot, gitDir, isGit, defaultBranch, headSha,
      scopeRel, categories, runLiveAudit, devProfile, rawFindings, testsMeta, hygieneMeta, verifyToolsAudit, preChangedSet, files,
    })
  } finally {
    setActiveFileCache(null)
    fileCache.clear()
  }
}

async function finishAudit({
  opts, roots, workTreeRoot, mainRoot, gitDir, isGit, defaultBranch, headSha,
  scopeRel, categories, runLiveAudit, devProfile, rawFindings, testsMeta, hygieneMeta, verifyToolsAudit = null, preChangedSet = null, files = [],
}) {

  let baselineSavedInfo = null
  if (opts.saveBaseline && runLiveAudit) {
    baselineSavedInfo = await saveBaseline(mainRoot, gitDir, isGit, rawFindings, headSha)
  }

  const existingBaseline = (!opts.saveBaseline && runLiveAudit) ? loadBaseline(mainRoot) : null
  const changedSet = (!opts.all && opts.changed && runLiveAudit)
    ? (preChangedSet ?? await collectChangedFilesSet(workTreeRoot, isGit, defaultBranch))
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
    const evDiscovery = discoverEvergreenAuthorityDocs(workTreeRoot, files, agentsInfo?.text ?? '')
    const evergreenDocs = evDiscovery.docs
    const duplicateGroups = evDiscovery.duplicateGroups
    const fm = readFeatureMapSafe(workTreeRoot)
    const staleFeatures = [...new Set([
      ...(fm.valid ? fm.features.filter((f) => f.stale === true).map((f) => f.id ?? f.name).filter(Boolean) : []),
      ...((verifyToolsAudit?.staleTools ?? []).map((s) => s.featureId).filter(Boolean)),
    ])]
    const missingEntryPaths = []
    const mappedPaths = new Set()
    const mappedPrefixes = []
    if (fm.valid) {
      for (const feat of fm.features) {
        for (const p of [
          ...(Array.isArray(feat.entrypoints) ? feat.entrypoints : []),
          ...(Array.isArray(feat.modules) ? feat.modules : []),
          ...(Array.isArray(feat.entryFiles) ? feat.entryFiles : []),
          ...(Array.isArray(feat.files) ? feat.files : []),
        ]) {
          const normP = posixPath(p).replace(/^\.\//, '')
          if (!normP) continue
          mappedPaths.add(normP)
          const cleanPrefix = normP.replace(/\/+$/, '')
          if (cleanPrefix) mappedPrefixes.push(cleanPrefix)
          if (!existsSync(join(workTreeRoot, normP))) missingEntryPaths.push({ feature: feat.id ?? feat.name, path: normP })
        }
      }
    }
    const isMappedSource = (rel) => mappedPaths.has(rel) || mappedPrefixes.some((cp) => rel === cp || rel.startsWith(`${cp}/`))
    const unmappedSourceModules = fm.valid
      ? files
          .map((f) => posixPath(f.rel ?? f))
          .filter((rel) => /^(?:src|lib|kit|app|apps|packages|pkg|cmd|internal|services|scripts)\//.test(rel)
            && /\.(?:mjs|cjs|js|ts|tsx|py|go|rs|java|rb|php|cs)$/.test(rel)
            && !/(?:^|\/)(?:test|tests|__tests__|fixtures|dev)\//i.test(rel)
            && !isMappedSource(rel))
          .slice(0, 20)
      : []
    const emptyDocAnchors = fm.valid
      ? fm.features.filter((f) => !Array.isArray(f.docAnchors) || f.docAnchors.length === 0).map((f) => f.id ?? f.name).filter(Boolean)
      : []
    const emptyToolDomains = fm.valid
      ? fm.features.filter((f) => !Array.isArray(f.verificationTools) || f.verificationTools.length === 0).map((f) => f.id ?? f.name).filter(Boolean)
      : []
    const emptyTestRefDomains = fm.valid
      ? fm.features.filter((f) => !Array.isArray(f.testRefs) || f.testRefs.length === 0).map((f) => f.id ?? f.name).filter(Boolean)
      : []
    const hotDocSkewModules = findings
      .filter((f) => String(f.id ?? '').startsWith('docs.stale-vs-churn'))
      .map((f) => f.file || f.title)
      .slice(0, 10)
    const docGapOrDrift = findings.some((f) => f.category === 'docs')
      || duplicateGroups.length > 0
      || missingEntryPaths.length > 0
      || staleFeatures.length > 0
      || (verifyToolsAudit?.zombies?.length ?? 0) > 0
      || (verifyToolsAudit?.staleTools?.length ?? 0) > 0
      || (verifyToolsAudit?.schemaOk === false)
      || unmappedSourceModules.length > 0
      || emptyDocAnchors.length > 0
      || emptyToolDomains.length > 0
      || emptyTestRefDomains.length > 0
      || hotDocSkewModules.length > 0
      || Boolean(docGraphSummary && (docGraphSummary.unaccountedCount > 0 || docGraphSummary.brokenAnchorsCount > 0 || docGraphSummary.cyclesCount > 0))
      || (verifyToolsAudit?.architectureMap && !verifyToolsAudit.architectureMap.ok && !verifyToolsAudit.architectureMap.optedOut)
    const nextCommands = docGapOrDrift
      ? [
          'node ".agents/skills/dev-explore/scripts/repo-map.mjs"',
          ...((verifyToolsAudit?.zombies?.length || verifyToolsAudit?.staleTools?.length || verifyToolsAudit?.schemaOk === false)
            ? ['node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" audit']
            : []),
          ...((verifyToolsAudit?.architectureMap && !verifyToolsAudit.architectureMap.ok && !verifyToolsAudit.architectureMap.optedOut)
            ? ['node ".agents/skills/dev-verify-tools/scripts/verify-tools.mjs" render']
            : []),
          ...evDiscovery.markdownDocs.slice(0, 6).map((d) => `node ".agents/skills/dev-explore/scripts/doc-locate.mjs" --file "${d.path}"`),
        ]
      : []
    const dg = evDiscovery.docGraph
    const docGraphSummary = dg ? {
      entryCount: dg.accounted.entry.length,
      registeredAuthorityCount: dg.accounted.registeredAuthority.length,
      unaccountedCount: dg.accounted.unaccounted.length,
      unaccountedDocs: dg.unaccountedDocs.map((d) => d.path),
      nonMarkdownAuthorities: dg.nonMarkdownDocs.map((d) => d.path),
      brokenLinksCount: dg.brokenLinks.length,
      brokenAnchorsCount: dg.brokenAnchors.length,
      anchorWarningsCount: dg.anchorWarnings.length,
      cyclesCount: dg.cycles.length,
      redirectChainsCount: dg.redirectChains.length,
      orphansCount: dg.orphans.length,
      entryDivergenceCount: dg.entryDivergence.length,
    } : null
    reconcileSummary = {
      agentsBytes: agentsInfo?.text ? Buffer.byteLength(agentsInfo.text, 'utf8') : null,
      tddPresent: existsSync(join(workTreeRoot, 'docs', 'TDD.md')),
      evergreenDocs,
      duplicateGroups,
      docGraph: docGraphSummary,
      emptyDocAnchors,
      emptyToolDomains,
      emptyTestRefDomains,
      verifyToolsAudit,
      featureMap: {
        path: FEATURE_MAP_REL,
        present: fm.present,
        valid: fm.valid,
        featureCount: fm.features.length,
        businessFlowCount: fm.businessFlows.length,
        staleFeatures,
        missingEntryPaths,
      },
      featureMapDrift: {
        missingEntryPaths,
        unmappedSourceModules,
        emptyDocAnchors,
        emptyToolDomains,
        emptyTestRefDomains,
        staleFeatures,
        hotDocSkewModules,
      },
      nextCommands,
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

  const needPlan = opts.planOnly || opts.execute || opts.writeTodo
  const plan = needPlan ? await buildPlan(findings, workTreeRoot, devProfile, isGit) : undefined
  if (opts.writeTodo && plan) {
    mkdirSync(dirname(join(workTreeRoot, plan.todoRel)), { recursive: true })
    writeAtomic(join(workTreeRoot, plan.todoRel), plan.todoDraft)
  }

  const issues = opts.issues ? buildIssues(findings, { repoRoot: workTreeRoot }) : undefined
  let applyResult
  if (opts.issues && opts.applyIssues && issues) {
    applyResult = await applyIssuesToBackend(workTreeRoot, issues, {
      _ghProbe: opts._ghProbe,
      _ghClient: opts._ghClient,
    })
    if (applyResult.error) {
      const failCode = applyResult.exitCode ?? 1
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({
          ok: false,
          blocked: Boolean(applyResult.blocked || applyResult.code),
          code: applyResult.code ?? 'BLOCKED_APPLY_ISSUES_FAILED',
          exitCode: failCode,
          error: applyResult.error,
          missing: applyResult.missing ?? [],
          reasons: applyResult.reasons ?? [],
          applyResult,
        }, null, 2)}\n`)
      }
      process.stderr.write(`Error: ${applyResult.error}\n`)
      return failCode
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
    findings,
    plan,
    reconcileSummary,
    findingsCount: findings.length,
  })

  const blockingCount = (counts.critical ?? 0) + (counts.high ?? 0)
  const exitCode = (opts.strict && blockingCount > 0) ? 1 : 0
  if (opts.auto || opts.task) {
    await recordGovernAuditCheckpoint(mainRoot, gitDir, isGit, {
      headSha, changed: Boolean(opts.changed), taskId: opts.task ?? null, counts, findingsCount: findings.length,
    })
  }

  if (opts.quiet) {
    const quietResult = {
      ok: blockingCount === 0,
      blocked: Boolean(opts.strict && blockingCount > 0),
      exitCode,
      mode,
      repoRoot: posixPath(workTreeRoot),
      changedApplied: filtered.changedApplied,
      changedCount: changedSet ? changedSet.size : null,
      counts,
      findings,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(quietResult, null, 2)}\n`)
    else if (findings.length === 0) process.stdout.write(`DEV-GOVERN (${opts.changed ? 'CHANGED' : mode.toUpperCase()}): PASS (0 findings)\n`)
    else {
      const lines = [`DEV-GOVERN (${opts.changed ? 'CHANGED' : mode.toUpperCase()}): ${findings.length} finding(s) [critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}]`]
      for (const f of findings.slice(0, 20)) lines.push(`  - [${f.severity.toUpperCase()}] ${f.id}: ${f.title}`)
      process.stdout.write(`${lines.join('\n')}\n`)
    }
    return exitCode
  }

  const result = {
    ok: blockingCount === 0,
    exitCode,
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

  return exitCode
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`govern-audit 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
