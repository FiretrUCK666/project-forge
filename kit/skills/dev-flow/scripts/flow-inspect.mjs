/**
 * flow-inspect.mjs —— 工作区探测（inspect）、任务启动（start）与多 Issue 依赖拓扑。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { formatConcurrencyRadarLines, projectConcurrencyRadar } from '../../lib/concurrency-radar.mjs'
import { parseDocFrontmatter, slugify } from '../../lib/docs.mjs'
import {
  ackInboundExternalPr, applyLocalAutoClaim, backfillCriteriaFingerprint, buildStartReuseNextSteps, calibrateLedgerBaseBranch, checkStartAuthorSeparation,
  checkStartMainCleanAndSlot, checkStartTriageDowngrade, collectDocIssueNumbers, emitBlockedStart,
  inheritExploredCredentials, markStartTriageConsumed, promotePlanningToStarted,
  resolveOrBindStartIssue, resolveStartIdentity, runStartPlanGate, validateStartIssueFlags,
} from './flow-start-helpers.mjs'
import { fetchGitClaimRefs } from './flow-merge-claim.mjs'
import { workTypePrefix } from '../../lib/escalation.mjs'
import {
  canonicalPath, detectCommitStyle, detectInProgressGitOp, ensureWorktreesIgnored,
  gitRun, gitRunBuffer, gitStatusPorcelainZ, parseWorktreeListPorcelain, posixPath,
  readTextSafe, resolveRepoRoots, writeAtomic,
} from '../../lib/git.mjs'
import {
  hasUnmergedIndexFast, parsePorcelainV2BranchZ, readGitConfigFast, readHeadFast,
  readLooseCommitLogFast, readRefsFast, readSystemGitConfigMapAsync,
  resolveDefaultBranchFromRefs, resolveGitDirFast, resolveRefShaFast,
} from '../../lib/git-fast.mjs'
import { readWorktreeListFast } from '../../lib/git-status-fast.mjs'
import {
  createDefaultLedger, createExploredEvidence, listTaskLedgers, readTaskLedger,
  recordMountedDepsInLedger, sanitizeTaskId, updateTaskLedger,
} from '../../lib/ledger.mjs'
import { getLocalIssue } from '../../lib/local-issues.mjs'
import { filterBootstrapAutoAttachDocs, resolveBootstrapStartDocs } from '../../lib/master-criteria-sync.mjs'
import {
  cleanStaleLocalModeMarker, detectDeclaredRepo, detectGitModeMarkers, isVerifiedTier, parseFlowInputs,
  parseIssueNumbers, parseMilestoneNumber, parsePrNumber, parseRemotesTopology,
  parseRemoteUrls, probePlatformEnv, resolveRemoteTarget, resolveWorkspaceIdentity,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import {
  assertNoDuplicatePrForTask, checkUnresolvedDependencies, resolveExternalCollaborationGraph,
} from '../../lib/task-graph.mjs'
import { analyzeIssueDependencies } from '../../lib/workflow-policy.mjs'
import {
  buildTargetRepoContext, detectRemoteDriftWarnings, findMatchingDocStrict,
  getChangedFiles, migrateUncommittedPlanDocs, resolveAndHydrateTaskContexts,
  resolvePreferredRemoteName, resolveStartBaseAndStack, syncTaskDocsSafe,
} from './flow-context.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

export { analyzeIssueDependencies, buildTargetRepoContext, getChangedFiles, syncTaskDocsSafe }

export async function inspectWorkspace(targetDir = process.cwd(), opts = {}) {
  const roots = opts.roots ?? await resolveRepoRoots(targetDir)
  const mainRoot = roots.mainRoot
  const workRoot = roots.workTreeRoot
  const hasLinkedWorktrees = Boolean(roots.isGit && roots.gitDir && (roots.isWorktree || existsSync(join(roots.gitDir, 'worktrees'))))
  const fastCfg = roots.isGit ? readGitConfigFast(roots.gitDir, { systemMap: false }) : null
  const needGitConfig = Boolean(roots.isGit && !fastCfg)
  const needSysCfg = Boolean(fastCfg && (!fastCfg.userName || !fastCfg.userEmail || !fastCfg.initDefaultBranch))
  const needRefsExec = Boolean(roots.isGit && existsSync(join(roots.gitDir ?? '', 'reftable')))
  const fastHead = (roots.isGit && !needRefsExec) ? readHeadFast(roots.workTreeGitDir, roots.gitDir) : null
  const fastHeadUnborn = Boolean(fastHead && !fastHead.oid)
  const canFastStatus = Boolean(opts.lightStart && fastHead && hasUnmergedIndexFast(roots.workTreeGitDir) === false)
  const hasOriginRemote = !fastCfg || Boolean(fastCfg.remoteText && /^origin\t/m.test(fastCfg.remoteText))
  const markersEarly = roots.gitDir ? detectGitModeMarkers(roots.gitDir, { hasRemote: hasOriginRemote }) : { localMode: false, forkMode: false, standaloneMode: false }
  const hasExplicitModeMarker = Boolean(markersEarly.localMode || markersEarly.forkMode || markersEarly.standaloneMode)
  const needHistoryForStart = !opts.lightStart || (hasOriginRemote && !hasExplicitModeMarker && !opts.externalPr && !opts['external-pr'])
  const skipLog = fastHeadUnborn || !needHistoryForStart
  const fastLog = (!skipLog && fastHead?.oid)
    ? readLooseCommitLogFast(workRoot, roots.gitDir, fastHead.oid, 500)
    : null
  const fastWtList = hasLinkedWorktrees ? readWorktreeListFast(mainRoot, roots.gitDir) : null

  const [statusRes, remoteRes, configRes, sysCfgMap, logRes, refsRes, wtRes] = roots.isGit
    ? await Promise.all([
        canFastStatus
          ? Promise.resolve(null)
          : gitRunBuffer(workRoot, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
        fastCfg ? Promise.resolve({ ok: true, stdout: fastCfg.remoteText }) : gitRun(workRoot, ['remote', '-v']),
        needGitConfig ? gitRun(workRoot, ['config', '--get-regexp', '^(user\\.name|user\\.email|init\\.defaultbranch)$']) : Promise.resolve(null),
        needSysCfg ? readSystemGitConfigMapAsync() : Promise.resolve(null),
        skipLog
          ? Promise.resolve({ ok: true, stdout: '' })
          : (fastLog?.complete
              ? Promise.resolve({ ok: true, stdout: fastLog.entries.map((e) => `${e.author}\x1f${e.subject}`).join('\n') })
              : gitRun(workRoot, ['--no-optional-locks', 'log', '-n', '500', '--format=%an <%ae>\x1f%s'])),
        needRefsExec ? gitRun(mainRoot, ['for-each-ref', '--format=%(refname)\t%(symref:short)', 'refs/heads', 'refs/remotes/origin']) : Promise.resolve(null),
        hasLinkedWorktrees && !fastWtList ? gitRun(mainRoot, ['--no-optional-locks', 'worktree', 'list', '--porcelain']) : Promise.resolve(null),
      ])
    : [{ ok: false, stdout: '' }, { ok: false, stdout: '' }, null, null, { ok: false, stdout: '' }, null, null]

  const stParsed = canFastStatus
    ? { head: fastHead.oid, branch: fastHead.detached ? '(detached)' : fastHead.branch, dirty: null, conflicts: [] }
    : parsePorcelainV2BranchZ(statusRes?.ok ? statusRes.stdout : '')
  const head = stParsed.head
  const branch = stParsed.branch ?? (head ? '(detached)' : null)
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  if (roots.gitDir && Object.keys(remoteUrls).length > 0) {
    cleanStaleLocalModeMarker(roots.gitDir, { hasRemote: true })
  }

  let userName = fastCfg?.userName ?? sysCfgMap?.get('user.name')
  let userEmail = fastCfg?.userEmail ?? sysCfgMap?.get('user.email')
  let initDefaultBranch = fastCfg?.initDefaultBranch ?? sysCfgMap?.get('init.defaultbranch')
  if (configRes?.ok && configRes.stdout) {
    for (const line of configRes.stdout.split('\n')) {
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const k = line.slice(0, sp).trim().toLowerCase()
      const v = line.slice(sp + 1).trim()
      if (k === 'user.name') userName = v
      else if (k === 'user.email') userEmail = v
      else if (k === 'init.defaultbranch') initDefaultBranch = v
    }
  }
  const gitIdentity = { name: userName, email: userEmail }

  const logLines = logRes.ok && logRes.stdout ? logRes.stdout.split('\n').filter(Boolean) : []
  const authorSet = new Set()
  const subjects = []
  for (const line of logLines) {
    const sepIdx = line.indexOf('\x1f')
    const author = sepIdx >= 0 ? line.slice(0, sepIdx) : line
    const subj = sepIdx >= 0 ? line.slice(sepIdx + 1) : ''
    if (author) authorSet.add(author)
    if (subj && subjects.length < 20) subjects.push(subj)
  }
  const historyAuthors = [...authorSet]
  const commitStyle = detectCommitStyle(subjects)
  let commits = 0
  if (head) {
    if (skipLog && !fastHeadUnborn) commits = 1
    else if (logLines.length < 500) commits = logLines.length
    else {
      const revRes = await gitRun(workRoot, ['--no-optional-locks', 'rev-list', '--count', 'HEAD'])
      commits = revRes.ok && /^\d+$/.test(revRes.stdout?.trim()) ? Number(revRes.stdout.trim()) : logLines.length
    }
  }

  const defaultBranch = !roots.isGit
    ? null
    : (needRefsExec
        ? resolveDefaultBranchFromRefs(refsRes?.stdout, branch, initDefaultBranch, { strict: true })
        : (readRefsFast(roots.gitDir, branch, initDefaultBranch, { strict: true }) ?? resolveDefaultBranchFromRefs('', branch, initDefaultBranch, { strict: true })))
  const hasDocsSystem = ['TDD.md', 'specs', 'todo', 'prd'].some((d) => existsSync(join(mainRoot, 'docs', d)))
  const worktrees = !roots.isGit
    ? []
    : (fastWtList
        ?? (wtRes?.ok && wtRes.stdout
          ? parseWorktreeListPorcelain(wtRes.stdout)
          : [{ path: canonicalPath(mainRoot), head, branch: branch === '(detached)' ? null : branch, detached: branch === '(detached)', bare: false, prunable: null }]))

  const profile = parseAgentsProfile(mainRoot)
  const declaredRepo = detectDeclaredRepo(mainRoot)
  const remoteTarget = resolveRemoteTarget(remoteUrls, { declaredRepo, cwd: mainRoot })
  const topoProviderHint = remoteTarget.providerId !== 'none' && remoteTarget.providerId !== 'generic-git' ? remoteTarget.providerId : null
  const topology = parseRemotesTopology(remoteRes.stdout, { providerHint: topoProviderHint })
  const ghProbe = opts._ghProbe ?? (await probePlatformEnv({ cwd: mainRoot, remoteUrls, probeNetwork: Boolean(opts.probeAuth) }))
  const originFull = remoteTarget.repoSlug ?? null
  const canQueryApi = Boolean(opts._ghClient || isVerifiedTier(ghProbe.env?.trackB?.tier))
  const shouldFetchRepoMeta = Boolean(opts.probeAuth) && originFull && canQueryApi && remoteTarget.capabilities?.api === true
  const apiClient = opts._ghClient ?? (canQueryApi ? ghProbe.client : null)
  const localIssueClient = apiClient ?? {
    getIssue: async (_repo, num) => getLocalIssue({ mainRoot, gitDir: roots.gitDir, number: num }),
  }

  const [repoMetaRes, graph] = await Promise.all([
    shouldFetchRepoMeta && typeof apiClient?.getRepoMeta === 'function' ? apiClient.getRepoMeta(originFull) : Promise.resolve(null),
    resolveExternalCollaborationGraph({
      inputs: opts.inputs ?? [],
      issueInput: opts.issue ?? null,
      prInput: opts.pr ?? null,
      externalPrInput: opts.externalPr ?? null,
      defaultRepo: originFull ?? 'local',
      originRepo: originFull,
      client: localIssueClient,
      knownIssueStates: opts.knownIssueStates ?? null,
      knownPrs: opts.knownPrs ?? null,
    }),
  ])

  const fetchedIssues = graph.issues
  const fetchedPrs = graph.prs
  const externalPr = graph.externalPr
  const reuseExistingPr = graph.reuseExistingPr

  const identity = resolveWorkspaceIdentity({
    gitDir: roots.gitDir, cwd: mainRoot, remoteUrls, declaredRepo, gitIdentity, historyAuthors, commits, externalPr,
    apiProbe: repoMetaRes?.ok ? repoMetaRes : undefined,
  })
  const driftWarnings = detectRemoteDriftWarnings({
    mainRoot,
    gitDir: roots.gitDir,
    role: identity.role,
    providerId: identity.providerId ?? 'none',
  })

  return {
    isGit: roots.isGit,
    mainRoot,
    workTreeRoot: workRoot,
    isWorktree: roots.isWorktree,
    branch,
    head,
    commits,
    dirty: stParsed.dirty,
    defaultBranch,
    commitStyle,
    conflicts: stParsed.conflicts ?? [],
    hasDocsSystem,
    declaredRepo: declaredRepo ?? null,
    remoteUrls,
    remotesTopology: topology.remotes,
    gitIdentity,
    identity,
    github: ghProbe.env,
    driftWarnings,
    devProfile: {
      hasAgents: profile.hasAgents,
      quickTest: profile.quickTest ?? null,
      fullTest: profile.fullTest ?? null,
      smokeVerify: profile.smokeVerify ?? null,
      mergeGate: profile.mergeGate ?? null,
      explicitNone: [...(profile.explicitNone ?? [])],
      archRules: profile.archRules,
      highRisk: profile.highRisk,
      doNotEdit: profile.doNotEdit,
      mergeAuthority: profile.mergeAuthority,
    },
    worktrees,
    activeTasks: listTaskLedgers(mainRoot, { includeTerminal: false }).map((t) => ({
      taskId: t.taskId, slug: t.slug, status: t.status, branch: t.branch, worktreePath: t.worktreePath, prNumber: t.prNumber,
    })),
    concurrencyRadar: projectConcurrencyRadar(mainRoot, { currentWorkRoot: workRoot }),
    inputs: { issues: fetchedIssues, prs: fetchedPrs, milestones: graph.milestones ?? [], unknown: graph.unknown, reuseExistingPr, issueGraph: analyzeIssueDependencies(fetchedIssues), graph },
  }
}

export async function handleStart(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const op = await detectInProgressGitOp(roots.mainRoot, { wtGitDir: resolveGitDirFast(roots.mainRoot), statusEntries: [] })
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 仓库正处于 ${op.op} 状态，请先解决冲突再执行 start`)

  const parsedPos = parseFlowInputs(opts._ ?? [])
  const linkedIssues = [...new Set([
    ...parseIssueNumbers([opts.issues, opts.issue], { strict: true }),
    ...parsedPos.issues.map((i) => i.number),
  ])]
  const externalPr = opts['external-pr'] !== undefined ? parsePrNumber(opts['external-pr'], { strict: true }) : null
  const prFromFlag = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : (parsedPos.prs[0]?.number ?? null)
  let prNumber = externalPr ?? prFromFlag
  const wantCreateIssue = Boolean(opts['create-issue'])
  const flagErr = validateStartIssueFlags(opts, linkedIssues)
  if (flagErr.blocked) return emitBlockedStart(opts, flagErr)
  const prelimTaskId = opts.task ?? (opts.slug ? slugify(opts.slug) : (linkedIssues[0] ? `issue-${linkedIssues[0]}` : (prNumber ? `pr-${prNumber}` : null)))
  if (!prelimTaskId && !wantCreateIssue) {
    throw new Error('start 需要传 --task <taskId>（或提供 --slug / --issue / --pr / --external-pr / --create-issue）')
  }
  if (wantCreateIssue && !opts.task && !opts.slug && !opts.title) {
    throw new Error('start --create-issue 需要至少提供 --title "<标题>"、--slug <slug> 或 --task <taskId>')
  }

  const caseType = opts.case !== undefined ? Number(opts.case) : 3
  if (caseType === 5) {
    process.stderr.write('BLOCKED_CASE_5_TDD_CONFLICT: 需求与 docs/TDD.md 或生效 SPEC 冲突，请先更新 TDD.md 并获批后再开工。\n')
    return { exitCode: EXIT.FACT }
  }
  if (opts.case !== undefined) {
    const down = checkStartTriageDowngrade(roots.mainRoot, { taskId: prelimTaskId, slug: opts.slug, caseType, summary: opts.title ?? '', reason: opts.reason })
    if (!down.ok) return emitBlockedStart(opts, down)
  }

  const state = await inspectWorkspace(roots.mainRoot, {
    roots, inputs: opts._, externalPr: opts['external-pr'] ?? externalPr, pr: opts.pr ?? prFromFlag,
    issue: linkedIssues.join(','), probeAuth: Boolean(opts['probe-auth']),
    knownIssueStates: opts.knownIssueStates, knownPrs: opts.knownPrs,
    _ghClient: opts._ghClient, _ghProbe: opts._ghProbe, lightStart: true,
  })
  if ((state.conflicts?.length ?? 0) > 0) {
    throw new Error('BLOCKED_GIT_CONFLICT_IN_PROGRESS: 仓库正处于 conflict 状态，请先解决冲突再执行 start')
  }
  const effectiveExternalPr = externalPr
    ?? (state.identity.role === 'inbound-external-pr' ? (prNumber ?? state.inputs.prs[0]?.number ?? null) : null)
  if (effectiveExternalPr && !prNumber) prNumber = effectiveExternalPr
  if (effectiveExternalPr && !hasSkillSupport(roots.mainRoot, 'dev-review')) {
    const msg = `BLOCKED_REQUIRES_DEV_REVIEW: 外部 PR #${effectiveExternalPr} 的不可信扫描与隔离审查需要 dev-review 技能，当前仓库未装配该技能；请通过 project-forge 运行 equip 补齐工具包后重试。`
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_REQUIRES_DEV_REVIEW', prNumber: effectiveExternalPr, message: msg }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { exitCode: EXIT.FACT }
  }
  if (!effectiveExternalPr && state.inputs.reuseExistingPr) {
    if (!prNumber && state.inputs.reuseExistingPr.prNumber) prNumber = state.inputs.reuseExistingPr.prNumber
    for (const iss of [...(state.inputs.reuseExistingPr.linkedIssues ?? []), ...(state.inputs.prs[0]?.relations?.fixes ?? [])]) {
      if (Number.isInteger(iss) && !linkedIssues.includes(iss)) linkedIssues.push(iss)
    }
  }
  let role = state.identity.role
  const providerId = state.identity.providerId ?? (role === 'local-only' ? 'none' : 'generic-git')

  if (role === 'clone-readonly' && !effectiveExternalPr) {
    const choice = opts['clone-choice']
    if (!choice) {
      const hintTask = sanitizeTaskId(prelimTaskId ?? slugify(opts.title))
      const guidance = {
        blocked: true, code: 'ACTION_REQUIRED_CLONE_CHOICE', reason: state.identity.reason,
        ...(state.identity.teamProbeHint ? { teamProbeHint: state.identity.teamProbeHint } : {}),
        choices: [
          { choice: 'fork', desc: '作为贡献者 Fork 协同：写入 .git/pf-fork-mode' },
          { choice: 'standalone', desc: '作为独立个人仓库继续：写入 .git/pf-standalone-mode' },
          { choice: 'local', desc: '仅本地使用不推远端：写入 .git/pf-local-mode' },
        ],
      }
      const cloneNextSteps = [`重新运行带上选择：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${hintTask} --clone-choice <fork|standalone|local>`]
      if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(guidance, cloneNextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
      else {
        process.stdout.write(`停下确认：检测到当前仓库为只读克隆（${state.identity.reason}）。请选择协作方式：\n`)
        for (const c of guidance.choices) process.stdout.write(`  --clone-choice ${c.choice.padEnd(10)} : ${c.desc}\n`)
        printNextStep(cloneNextSteps, { repoRoot: roots.mainRoot })
      }
      return { exitCode: EXIT.HUMAN }
    }
    if (choice === 'local') {
      writeAtomic(join(roots.gitDir, 'pf-local-mode'), `${JSON.stringify({ mode: 'readonly-override', updatedAt: new Date().toISOString() }, null, 2)}\n`)
      role = 'local-only'
    } else if (choice === 'standalone') {
      writeAtomic(join(roots.gitDir, 'pf-standalone-mode'), `enabled at ${new Date().toISOString()}\n`)
      role = 'maintainer'
    } else if (choice === 'fork') {
      writeAtomic(join(roots.gitDir, 'pf-fork-mode'), `enabled at ${new Date().toISOString()}\n`)
      if (opts['fork-url'] && state.remoteUrls.origin && !state.remoteUrls.upstream) {
        await gitRun(roots.mainRoot, ['remote', 'rename', 'origin', 'upstream'])
        await gitRun(roots.mainRoot, ['remote', 'add', 'origin', opts['fork-url']])
      }
      role = 'contributor-fork'
    } else throw new Error(`--clone-choice 仅支持 fork | standalone | local，收到：${choice}`)
  }

  const depCheck = checkUnresolvedDependencies(state.inputs?.graph, {
    force: Boolean(opts.force),
    strictDeps: Boolean(opts['strict-deps']),
  })
  if (depCheck.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify(depCheck, null, 2)}\n`)
    process.stderr.write(`${depCheck.message}\n`)
    return { exitCode: depCheck.exitCode ?? EXIT.FACT }
  }
  if (!effectiveExternalPr && state.inputs.reuseExistingPr) {
    const reqBranch = opts.branch ? String(opts.branch).trim() : null
    const reuseBr = state.inputs.reuseExistingPr.branch
    if (opts['new-pr'] || (reqBranch && reuseBr && reqBranch !== reuseBr)) {
      const dup = assertNoDuplicatePrForTask({
        ledger: { prNumber: state.inputs.reuseExistingPr.prNumber },
        graph: state.inputs.graph,
      })
      if (dup.blocked) {
        if (opts.json) process.stdout.write(`${JSON.stringify(dup, null, 2)}\n`)
        process.stderr.write(`${dup.message}\n`)
        return { exitCode: dup.exitCode ?? EXIT.FACT }
      }
    }
  }

  let createdIssue = null
  const hasExplicitTaskOrSlug = Boolean(opts.task || opts.slug || linkedIssues.length > 0 || effectiveExternalPr || prNumber)

  const defaultPrTask = effectiveExternalPr ? `review-pr-${effectiveExternalPr}` : (prNumber ? `pr-${prNumber}` : null)
  const milestoneVal = opts.milestone !== undefined
    ? (parseMilestoneNumber(opts.milestone) ?? String(opts.milestone).trim())
    : (parsedPos.milestones?.[0]?.number ?? state.inputs.milestones?.[0]?.number ?? null)
  const rawTaskId = opts.task ?? (opts.slug ? slugify(opts.slug) : (linkedIssues[0] ? `issue-${linkedIssues[0]}` : (defaultPrTask ?? (opts.title ? slugify(opts.title) : prelimTaskId))))
  let taskId = sanitizeTaskId(rawTaskId)
  let slug = slugify(opts.slug ?? (opts.title ? opts.title : taskId))
  if (opts.sandbox && !effectiveExternalPr) {
    const { handleSandboxStart } = await import('./flow-sandbox.mjs')
    return handleSandboxStart({ opts, roots, state, taskId, slug, role, providerId, linkedIssues })
  }

  const isPlanning = Boolean(opts.planning)
  await fetchGitClaimRefs(roots.mainRoot, { remoteUrls: state.remoteUrls ?? {}, role, opts })
  const existing = readTaskLedger(roots.mainRoot, taskId)
  if (existing && existing.status !== 'cleaned' && existing.status !== 'aborted' && (
    (existing.worktreePath && existsSync(join(roots.mainRoot, existing.worktreePath)))
    || (existing.isolation === 'review-pr' && existing.reviewWorktreePath && existsSync(join(roots.mainRoot, existing.reviewWorktreePath)))
    || existing.isolation === 'branch'
    || (existing.isolation === 'in-place' && Number(existing.caseType) === 1)
  )) {
    if (opts.todo) existing.todoFile = opts.todo
    if (opts.spec) existing.specFile = opts.spec
    if (opts.prd) existing.prdFile = opts.prd
    if (opts['allow-plan-bootstrap']) existing.planBootstrap = true
    const existingWorkRootPre = existing.worktreePath ? resolve(roots.mainRoot, existing.worktreePath) : roots.mainRoot
    const specIssuePre = collectDocIssueNumbers(roots, [existing.specFile], existingWorkRootPre)[0] ?? null
    if (specIssuePre && !linkedIssues.includes(specIssuePre)) linkedIssues.push(specIssuePre)
    const newlyBoundIssues = linkedIssues.filter((n) => !(existing.linkedIssues ?? []).includes(n))
    if (linkedIssues.length > 0) existing.linkedIssues = [...new Set([...(existing.linkedIssues ?? []), ...linkedIssues])]
    const nextPrNo = effectiveExternalPr ?? prNumber ?? null
    if (nextPrNo && existing.prNumber !== nextPrNo) {
      existing.prNumber = nextPrNo
      existing.prContext = null
      existing.prContextUnavailable = null
      existing.prBaseSha = null
      existing.prHeadSha = null
    }
    if ((existing.status === 'planning' || existing.planning === true) && !isPlanning) {
      const promo = await promotePlanningToStarted({
        roots, existing, existingWorkRootPre, slug, taskId, opts, runStartPlanGate,
        state, linkedIssues, role, providerId, baseBranch: state.defaultBranch ?? null, baseSha: state.head,
      })
      if (promo.blocked) return { exitCode: promo.exitCode }
      createdIssue = promo.createdIssue ?? null
    } else if (isPlanning && (existing.status === 'planning' || existing.status === 'planned')) {
      existing.status = 'planning'
      existing.planning = true
      if (!existing.issueBinding) existing.issueBinding = { mode: 'exempt', exemptKind: 'planning', reason: '--planning 隔离规划阶段暂不绑定工单', at: new Date().toISOString() }
    } else if (!isPlanning && existing.isolation !== 'review-pr' && (!(existing.linkedIssues ?? []).length || opts['create-issue'] || opts['no-issue'] || !existing.issueBinding)) {
      const rebind = await resolveOrBindStartIssue({
        roots, docRoot: existsSync(existingWorkRootPre) ? existingWorkRootPre : roots.mainRoot,
        state, role: existing.role || role, providerId: existing.providerId || providerId,
        prelimTaskId: taskId, caseType: opts.case !== undefined ? Number(opts.case) : existing.caseType,
        isPlanning: false, externalPr: effectiveExternalPr, linkedIssues,
        docs: { spec: existing.specFile, todo: existing.todoFile, prd: existing.prdFile },
        ledger: existing, opts, implementerId: existing.implementerId ?? null,
      })
      if (rebind.blocked) {
        if (!rebind.alreadyEmitted) emitBlockedStart(opts, rebind)
        return { exitCode: rebind.exitCode }
      }
      existing.issueBinding = rebind.issueBinding
      if (rebind.linkedIssues.length > 0) existing.linkedIssues = [...new Set([...(existing.linkedIssues ?? []), ...rebind.linkedIssues])]
      createdIssue = rebind.createdIssue ?? null
    }
    if (!isPlanning && existing.role === 'local-only' && role !== 'local-only') { existing.role = role; existing.providerId = providerId }
    if (!existing.baseSha && state.head) existing.baseSha = state.head
    const existingFetchedCount = (existing.issueContext ?? []).filter((x) => x?.fetched).length
    const needIssueRefresh = (existing.linkedIssues ?? []).length > 0 && (
      (existing.issueContextUnavailable ?? []).length > 0
      || existingFetchedCount < (existing.linkedIssues ?? []).length
    )
    const needPrRefresh = Boolean(existing.prNumber) && (
      !existing.prContext?.fetched
      || Number(existing.prContext?.number) !== Number(existing.prNumber)
      || Boolean(existing.prContextUnavailable)
    )
    if (needIssueRefresh || needPrRefresh) {
      const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot })
      const hydrated = await resolveAndHydrateTaskContexts({
        mainRoot: roots.mainRoot, gitDir: roots.gitDir, remoteUrls: state.remoteUrls ?? {},
        providerId, role, targetRepo,
        issueNumbers: needIssueRefresh ? existing.linkedIssues : [],
        existingIssueContext: existing.issueContext,
        prNumber: needPrRefresh ? existing.prNumber : null,
        existingPrContext: existing.prContext,
        existingAck: existing.issueContextAck ?? null,
        opts,
      })
      if (needIssueRefresh) {
        existing.issueContext = hydrated.issueContext
        existing.issueContextUnavailable = hydrated.issueContextUnavailable
        existing.issueContextAck = hydrated.issueContextAck
      }
      if (needPrRefresh) {
        existing.prContext = hydrated.prContext
        existing.prContextUnavailable = hydrated.prContextUnavailable
        Object.assign(existing, hydrated.prPatch)
      }
    }
    const existingWorkRoot = existing.worktreePath ? resolve(roots.mainRoot, existing.worktreePath) : roots.mainRoot
    if ((existing.linkedIssues ?? []).length > 0 && existsSync(existingWorkRoot)) {
      await syncTaskDocsSafe(existingWorkRoot, existing, { mainRoot: roots.mainRoot, gitDir: roots.gitDir, newlyBoundIssues, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe, skipPlanBackfill: Boolean(opts.knownIssueStates && !opts._ghClient && !opts._ghProbe) })
    }
    if (milestoneVal && !existing.milestone) existing.milestone = milestoneVal
    await calibrateLedgerBaseBranch(roots.mainRoot, existing, state.defaultBranch)
    if (!isPlanning) inheritExploredCredentials({ mainRoot: roots.mainRoot, docRoot: existingWorkRoot, ledger: existing })
    backfillCriteriaFingerprint(existingWorkRoot, existing)
    await updateTaskLedger(roots.mainRoot, existing.taskId, (cur) => ({ ...(cur ?? existing), ...existing }), { createIfMissing: true })
    const reuseNextSteps = buildStartReuseNextSteps(existing, taskId)
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ ...existing, ...(createdIssue ? { createdIssue } : {}) }, reuseNextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      if (createdIssue) process.stdout.write(`已创建工单 #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
      process.stdout.write(`任务 ${taskId} 已存在（幂等复用）：isolation=${existing.isolation}, branch=${existing.branch ?? 'detached'}\n`)
      printNextStep(reuseNextSteps, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const baseResolved = await resolveStartBaseAndStack(roots, state, opts, { effectiveExternalPr })
  if (baseResolved.blocked) {
    return emitBlockedStart(opts, { code: baseResolved.code, exitCode: EXIT.FACT, reason: baseResolved.reason })
  }
  const { baseBranch, baseSha, stackFields } = baseResolved
  const filesList = opts.files ? String(opts.files).split(/[\s,]+/).map((s) => posixPath(s).replace(/^\.\//, '').trim()).filter(Boolean) : []
  const depMeta = state.inputs?.graph?.externalDependencies?.length ? { dependsOn: state.inputs.graph.externalDependencies } : {}
  const { startIdentity, implementerId } = resolveStartIdentity({ isPlanning, state, opts })

  await ensureWorktreesIgnored(roots.mainRoot, roots.gitDir)

  if (effectiveExternalPr) {
    const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, state.remotesTopology ? { origin: state.remotesTopology[0] } : null, { cwd: roots.mainRoot })
    const { targetRepo } = targetCtx
    const {
      issueContext, issueContextUnavailable, prContext, prContextUnavailable, prPatch,
    } = await resolveAndHydrateTaskContexts({
      mainRoot: roots.mainRoot, gitDir: roots.gitDir, remoteUrls: state.remoteUrls ?? {},
      providerId, role, targetRepo, issueNumbers: linkedIssues, prNumber: effectiveExternalPr, opts,
    })
    const reviewRel = `.worktrees/review-pr-${effectiveExternalPr}`
    const reviewAbs = join(roots.mainRoot, reviewRel)
    let targetSha = opts['pr-ref'] ?? null
    if (!targetSha) {
      const fetchRemote = resolvePreferredRemoteName(state.remotesTopology, state.identity.providerId ?? targetCtx.providerId ?? 'github')
      const fullRef = (targetCtx.mrRefPattern ?? 'refs/pull/{id}/head').replace(/\{id\}/g, String(effectiveExternalPr))
      const fetchSpec = fullRef.replace(/^refs\//, '')
      const fetchRes = await gitRun(roots.mainRoot, ['fetch', fetchRemote, fetchSpec])
      if (fetchRes.ok) {
        const fh = await gitRun(roots.mainRoot, ['rev-parse', 'FETCH_HEAD'])
        if (fh.ok) targetSha = fh.stdout.trim()
      } else {
        const localRef = await gitRun(roots.mainRoot, ['rev-parse', '--verify', fullRef])
        if (localRef.ok) targetSha = localRef.stdout.trim()
      }
    }
    if (!targetSha) throw new Error(`无法拉取外部 PR #${effectiveExternalPr} 的提交（可传入 --pr-ref 指定本地测试 ref）`)
    if (!existsSync(reviewAbs)) {
      const wtAdd = await gitRun(roots.mainRoot, ['worktree', 'add', '--detach', reviewAbs, targetSha])
      if (!wtAdd.ok) throw new Error(`创建外部 PR 审查位失败：${wtAdd.stderr}`)
    }
    const inboundAck = await ackInboundExternalPr(roots, state, effectiveExternalPr, opts)
    const ledger = createDefaultLedger({
      taskId, slug, caseType, tier: 3, isolation: 'review-pr', role: 'inbound-external-pr', providerId: state.identity.providerId ?? 'none',
      branch: null, baseBranch, baseSha: baseSha ?? targetSha, worktreePath: null, reviewWorktreePath: reviewRel,
      linkedIssues, prNumber: effectiveExternalPr, implementerId: `external-pr-${effectiveExternalPr}`,
      issueContext, issueContextUnavailable, prContext, prContextUnavailable, ...prPatch,
      status: 'review-ready', untrustedScanPassed: false, untrustedApproved: false, humanApprovedExec: false,
      inboundAck,
    })
    await updateTaskLedger(roots.mainRoot, ledger.taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const extNextSteps = [{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${effectiveExternalPr} --untrusted-scan` }]
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(ledger, extNextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      process.stdout.write(`已建立外部 PR 审查隔离位：${reviewRel}（detached @ ${targetSha.slice(0, 7)}，未挂载依赖）\n`)
      printNextStep(extNextSteps, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const branchPrefix = workTypePrefix(caseType)
  const reusedPrBranch = state.inputs.reuseExistingPr?.branch ?? null
  const branch = opts.branch || reusedPrBranch || `${branchPrefix}/${slug}`

  const resolveLocalBranchRef = async () => {
    const canFastRefs = Boolean(roots.gitDir && !existsSync(join(roots.gitDir, 'reftable')))
    const originUrl = state.remoteUrls.origin ?? ''
    const isNetOrigin = /^(?:https?:\/\/|ssh:\/\/|[^/@:\s]+@)/i.test(originUrl)
    const skipNetworkFetch = Boolean(isNetOrigin && (opts._ghProbe || opts._ghClient || opts.knownPrs || opts.knownIssueStates || process.env.PF_NO_REAL_AUTH_PROBE === '1'))
    if (canFastRefs) {
      if (resolveRefShaFast(roots.gitDir, `refs/heads/${branch}`)) return { ok: true }
      if (skipNetworkFetch || !reusedPrBranch || branch !== reusedPrBranch || !originUrl) return { ok: false }
    }
    const has = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    if (has.ok || skipNetworkFetch || !reusedPrBranch || branch !== reusedPrBranch || !originUrl) return has
    await gitRun(roots.mainRoot, ['fetch', 'origin', `${branch}:${branch}`])
    return await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  }

  const isBootstrap = Boolean(opts['allow-plan-bootstrap'])
  const dirtyDocs = isBootstrap
    ? filterBootstrapAutoAttachDocs((state.dirty ?? []).map((e) => posixPath(e.file ?? '')), { isBootstrap, explicitSpec: opts.spec, explicitTodo: opts.todo })
    : []
  const initDocs = resolveBootstrapStartDocs({
    root: roots.mainRoot, slug, taskId, linkedIssues, extraDocs: dirtyDocs,
    current: { prdFile: existing?.prdFile, specFile: existing?.specFile, todoFile: existing?.todoFile },
    explicit: { prd: opts.prd, spec: opts.spec, todo: opts.todo },
    isBootstrap, findStrict: findMatchingDocStrict,
  })
  const { prdFile: initialPrd, specFile: initialSpec, todoFile: initialTodo } = initDocs

  const specIssueNew = collectDocIssueNumbers(roots, [initialSpec], roots.mainRoot)[0] ?? null

  if (!isPlanning) {
    const gateRes = runStartPlanGate(roots.mainRoot, {
      caseType, slug, taskId, issue: linkedIssues[0] ?? specIssueNew ?? null,
      docs: { spec: initialSpec, todo: initialTodo, prd: initialPrd },
      opts,
      planCritique: existing?.planCritique ?? null,
    })
    if (gateRes.blocked) return { exitCode: gateRes.exitCode }
  }

  const explicitStartImpl = opts.agent ?? opts.implementer ?? null
  const authCheck = checkStartAuthorSeparation(roots.mainRoot, [initialSpec, initialTodo, initialPrd], explicitStartImpl, {
    ...opts, mainRoot: roots.mainRoot, taskId, caseType,
  })
  if (authCheck.blocked) {
    return emitBlockedStart(opts, authCheck)
  }

  const slotChk = await checkStartMainCleanAndSlot(roots.mainRoot, {
    caseType, commits: state.commits, creatingIsolatedWorktree: state.commits > 0 && caseType >= 2,
  })
  if (!slotChk.ok) {
    return emitBlockedStart(opts, slotChk)
  }

  const bindRes = await resolveOrBindStartIssue({
    roots, docRoot: roots.mainRoot, state, role, providerId, prelimTaskId: taskId,
    caseType, isPlanning, externalPr: effectiveExternalPr, linkedIssues,
    docs: { spec: initialSpec, todo: initialTodo, prd: initialPrd },
    ledger: existing, opts, implementerId,
  })
  if (bindRes.blocked) {
    if (!bindRes.alreadyEmitted) emitBlockedStart(opts, bindRes)
    return { exitCode: bindRes.exitCode }
  }
  createdIssue = bindRes.createdIssue ?? null
  if (!hasExplicitTaskOrSlug && linkedIssues[0]) {
    taskId = sanitizeTaskId(`issue-${linkedIssues[0]}`)
    if (!opts.slug && !opts.title) slug = slugify(taskId)
  }

  const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot })
  const {
    issueContext, issueContextUnavailable, prContext, prContextUnavailable, prPatch,
  } = await resolveAndHydrateTaskContexts({
    mainRoot: roots.mainRoot, gitDir: roots.gitDir, remoteUrls: state.remoteUrls ?? {},
    providerId, role, targetRepo, issueNumbers: linkedIssues, prNumber: prNumber ?? null, opts,
  })

  if (state.commits === 0 || (caseType === 1 && !Boolean(opts.parallel) && !Boolean(opts.worktree))) {
    const inPlaceOnExisting = state.commits > 0 && caseType === 1
    if (!inPlaceOnExisting) {
      if (Boolean(opts.parallel)) throw new Error('仓库尚无初始提交，无法使用 worktree 并行隔离')
      const hasBranch = await resolveLocalBranchRef()
      const sw = hasBranch.ok ? await gitRun(roots.mainRoot, ['switch', branch]) : await gitRun(roots.mainRoot, ['switch', '-c', branch])
      if (!sw.ok) throw new Error(`切换分支 ${branch} 失败：${sw.stderr}`)
    }
    const ledger = createDefaultLedger({
      taskId, slug, caseType, tier: 1, isolation: inPlaceOnExisting ? 'in-place' : 'branch', role, providerId,
      branch: inPlaceOnExisting ? (state.branch && state.branch !== '(detached)' ? state.branch : branch) : branch,
      baseBranch, baseSha,
      worktreePath: null, reviewWorktreePath: inPlaceOnExisting ? null : `.worktrees/review-${taskId}`,
      todoFile: initialTodo ?? null, specFile: initialSpec ?? null, prdFile: initialPrd ?? null,
      linkedIssues, issueBinding: bindRes.issueBinding, prNumber, implementerId,
      account: startIdentity.account, verifiedPlatformLogin: startIdentity.verifiedPlatformLogin, agent: startIdentity.agent,
      issueContext, issueContextUnavailable,
      prContext, prContextUnavailable, ...prPatch,
      status: isPlanning ? 'planning' : 'started',
      planning: isPlanning,
      planBootstrap: isBootstrap,
      explored: null,
      ...stackFields, ...depMeta, ...(milestoneVal ? { milestone: milestoneVal } : {}), ...(filesList.length > 0 ? { files: filesList } : {}),
    })
    applyLocalAutoClaim(ledger, { role, isPlanning, implementerId, opts })
    if (!isPlanning) inheritExploredCredentials({ mainRoot: roots.mainRoot, docRoot: roots.mainRoot, ledger })
    backfillCriteriaFingerprint(roots.mainRoot, ledger)
    if (linkedIssues.length > 0) await syncTaskDocsSafe(roots.mainRoot, ledger, { mainRoot: roots.mainRoot, gitDir: roots.gitDir, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe, skipPlanBackfill: Boolean(opts.knownIssueStates && !opts._ghClient && !opts._ghProbe) })
    await updateTaskLedger(roots.mainRoot, ledger.taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    markStartTriageConsumed(roots.mainRoot, { taskId: ledger.taskId, slug: ledger.slug })
    const nextTier1 = isPlanning
      ? [
          { skill: 'dev-plan', text: `1. 在分支 ${ledger.branch} 起草规划文档并经 critique-pass 与 approve` },
          { skill: 'dev-flow', text: `2. 过审后执行 flow.mjs start --task ${taskId} 转入实施` },
        ]
      : [
          { skill: 'dev-flow', text: `1. 执行 flow.mjs claim 认领任务：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId}` },
          { skill: 'dev-flow', text: `2. 完成实施并提交后运行：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
        ]
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ ...ledger, ...(createdIssue ? { createdIssue } : {}) }, nextTier1, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      if (createdIssue) process.stdout.write(`已创建工单 #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
      process.stdout.write(`任务 ${taskId} 已就绪（Tier 1 ${inPlaceOnExisting ? 'Case 1 原地微调' : '初始无提交分支'}模式${isPlanning ? '·规划阶段' : ''}）：branch=${ledger.branch}, role=${role}\n`)
      printNextStep(nextTier1, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  // commits > 0 且 Case >= 2 全量进入 Tier 2 Worktree 隔离，不再允许在主仓原地切换分支
  const implRel = `.worktrees/impl-${taskId}`
  const reviewRel = `.worktrees/review-${taskId}`
  const implAbs = join(roots.mainRoot, implRel)

  if (!existsSync(implAbs)) {
    const checkedOutAt = (state.worktrees ?? []).find((w) => w.branch === branch)
    if (checkedOutAt) {
      const msg = `BLOCKED_BRANCH_IN_USE: 分支 ${branch} 已在工作树 ${checkedOutAt.path} 检出，请传入 --branch <新分支名> 或清理原工作树。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_BRANCH_IN_USE', branch, checkedOutAt: checkedOutAt.path }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    const hasBranch = await resolveLocalBranchRef()
    const addArgs = hasBranch.ok ? ['worktree', 'add', implAbs, branch] : ['worktree', 'add', '-b', branch, implAbs, baseSha]
    const wtRes = await gitRun(roots.mainRoot, addArgs)
    if (!wtRes.ok) throw new Error(`创建实施 worktree 失败：${wtRes.stderr}`)
  }

  const depMount = isPlanning ? { mode: 'deferred-planning', mounted: [], mountedPaths: [] } : mountSharedDeps(roots.mainRoot, implAbs)
  const ledger = createDefaultLedger({
    taskId, slug, caseType, tier: 2, isolation: 'worktree', role, providerId, branch, baseBranch, baseSha,
    worktreePath: implRel, reviewWorktreePath: reviewRel, depsMode: depMount.mode,
    todoFile: initialTodo ?? null, specFile: initialSpec ?? null, prdFile: initialPrd ?? null,
    linkedIssues, issueBinding: bindRes.issueBinding, prNumber, implementerId,
    account: startIdentity.account, verifiedPlatformLogin: startIdentity.verifiedPlatformLogin, agent: startIdentity.agent,
    issueContext, issueContextUnavailable,
    prContext, prContextUnavailable, ...prPatch,
    status: isPlanning ? 'planning' : 'started',
    planning: isPlanning,
    planBootstrap: isBootstrap,
    explored: null,
    ...stackFields, ...depMeta, ...(milestoneVal ? { milestone: milestoneVal } : {}), ...(filesList.length > 0 ? { files: filesList } : {}),
  })
  applyLocalAutoClaim(ledger, { role, isPlanning, implementerId, opts })
  recordMountedDepsInLedger(ledger, implRel, depMount)

  const migratedDocs = await migrateUncommittedPlanDocs(roots.mainRoot, implAbs, ledger, state.dirty)
  const wtExtraDocs = isBootstrap && !ledger.prdFile
    ? filterBootstrapAutoAttachDocs(((await gitStatusPorcelainZ(implAbs)).entries ?? []).map((e) => posixPath(e.file ?? '')), { isBootstrap, explicitSpec: opts.spec, explicitTodo: opts.todo })
    : []
  const wtResolved = resolveBootstrapStartDocs({
    root: implAbs, slug, taskId, linkedIssues, extraDocs: [...dirtyDocs, ...wtExtraDocs],
    current: { prdFile: ledger.prdFile, specFile: ledger.specFile, todoFile: ledger.todoFile },
    explicit: { prd: opts.prd, spec: opts.spec, todo: opts.todo },
    isBootstrap, findStrict: findMatchingDocStrict,
  })
  ledger.prdFile = wtResolved.prdFile
  ledger.specFile = wtResolved.specFile
  ledger.todoFile = wtResolved.todoFile
  const specIssueWt = collectDocIssueNumbers(roots, [ledger.specFile], implAbs)[0] ?? null
  if (specIssueWt && !ledger.linkedIssues.includes(specIssueWt)) {
    ledger.linkedIssues = [...ledger.linkedIssues, specIssueWt]
  }
  if (!isPlanning) inheritExploredCredentials({ mainRoot: roots.mainRoot, docRoot: implAbs, ledger })
  backfillCriteriaFingerprint(implAbs, ledger)
  if (ledger.linkedIssues.length > 0) await syncTaskDocsSafe(implAbs, ledger, { mainRoot: roots.mainRoot, gitDir: roots.gitDir, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe, skipPlanBackfill: Boolean(opts.knownIssueStates && !opts._ghClient && !opts._ghProbe) })
  await updateTaskLedger(roots.mainRoot, ledger.taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  markStartTriageConsumed(roots.mainRoot, { taskId: ledger.taskId, slug: ledger.slug })

  const nextTier2 = isPlanning
    ? [
        { skill: 'dev-plan', text: `1. 在 ${implRel} 内编写/完善 SPEC 与 Todo 并完成 critique-pass 与 approve` },
        { skill: 'dev-flow', text: `2. 过审后在同工作区执行 flow.mjs start --task ${taskId} 转入实施阶段` },
      ]
    : [
        { skill: 'dev-flow', text: `1. 先执行 flow.mjs claim 认领任务：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId}` },
        `2. 在 ${implRel} 中推进实施、验证与提审（提交评审时将自动同步创建 ${reviewRel} 审查工作树）。`,
      ]
  const startRadar = projectConcurrencyRadar(roots.mainRoot, { currentTaskId: taskId, currentWorkRoot: implAbs, currentFiles: filesList, baseBranch, baseSha })
  const startWarnings = [
    ...(slotChk.dirtyMainWarning ? [slotChk.dirtyMainWarning] : []),
    ...(startRadar.warnings ?? []),
  ]
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({ ...ledger, depsMount: depMount, migratedDocs, concurrencyRadar: startRadar, ...(startWarnings.length > 0 ? { warnings: startWarnings } : {}), ...(createdIssue ? { createdIssue } : {}) }, nextTier2, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    if (createdIssue) process.stdout.write(`已创建工单 #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
    process.stdout.write(`任务 ${taskId} 已就绪（Tier 2 Worktree 模式${isPlanning ? '·规划隔离' : ''}）：\n`)
    process.stdout.write(`- 实施位: ${implRel}（分支: ${branch}，依赖模式: ${depMount.mode}）\n`)
    if (migratedDocs.length > 0) process.stdout.write(`- 已迁入规划文档: ${migratedDocs.join(', ')}\n`)
    process.stdout.write(`- 角色: ${role} | 基线: ${baseBranch}@${(baseSha ?? '').slice(0, 7)}\n`)
    for (const w of startWarnings) process.stdout.write(`- [提醒] ${w.message}\n`)
    for (const rl of formatConcurrencyRadarLines(startRadar)) process.stdout.write(`${rl}\n`)
    if (Array.isArray(state.driftWarnings)) {
      for (const w of state.driftWarnings) process.stdout.write(`- [提醒] ${w.message}\n`)
    }
    printNextStep(nextTier2, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
