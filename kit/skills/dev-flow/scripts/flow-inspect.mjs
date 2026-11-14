/**
 * flow-inspect.mjs —— 工作区探测（inspect）、任务启动（start）、认领（claim）与多 Issue 依赖拓扑。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { parseDocFilename, parseDocFrontmatter, slugify, syncDocsLifecycle } from '../../lib/docs.mjs'
import {
  canonicalPath, detectInProgressGitOp, detectProjectConventions, ensureWorktreesIgnored,
  gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, parseWorktreeListPorcelain, posixPath,
  readTextSafe, writeAtomic,
} from '../../lib/git.mjs'
import { createDefaultLedger, listTaskLedgers, readTaskLedger, resolveTaskContext, sanitizeTaskId, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, githubRepoFull, parseBodyRelations, parseFlowInputs,
  parseRemotesTopology, parseRemoteUrls, probeGitHubEnv, resolveWorkspaceIdentity,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

export const EXIT_POLICY_BLOCK = 3
export const EXIT_ACTION_REQUIRED = 4

/** 使用 `-z` 安全收集相对于 baseRef 的全部变更文件（含工作区未提交变动）。 */
export async function getChangedFiles(cwd, baseRef) {
  const set = new Set()
  if (baseRef) {
    const diff = await gitDiffNameStatusZ(cwd, [`${baseRef}..HEAD`])
    if (diff.ok) {
      for (const e of diff.entries) if (e.file) set.add(e.file)
    }
  }
  const st = await gitStatusPorcelainZ(cwd)
  if (st.ok) {
    for (const e of st.entries) if (e.file) set.add(e.file)
  }
  return [...set].sort()
}

export function buildTargetRepoContext(role, remoteUrls, declaredRepo, topology = null) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const upstreamRaw = remoteUrls.upstream
  const originFull = githubRepoFull(originRaw)
  const upstreamFull = githubRepoFull(upstreamRaw)
  const originLower = originFull ? originFull.toLowerCase() : null
  const upstreamLower = upstreamFull ? upstreamFull.toLowerCase() : null
  const targetRepo = role === 'contributor-fork' ? (upstreamFull ?? declaredRepo ?? originFull) : originFull
  const pushRemote = topology?.origin?.name ?? (remoteUrls.origin ? 'origin' : Object.keys(remoteUrls)[0] ?? 'origin')
  return { originFull, originLower, upstreamFull, upstreamLower, targetRepo, pushRemote }
}

export async function syncTaskDocsSafe(workRoot, ledger, overrides = {}) {
  const seed = ledger.specFile ?? ledger.todoFile ?? ledger.prdFile ?? ledger.slug
  if (!seed) return null
  try {
    const res = await syncDocsLifecycle(workRoot, {
      slugOrPath: seed,
      issue: ledger.linkedIssues?.[0],
      pr: ledger.prNumber ?? undefined,
      branch: ledger.branch,
      owner: ledger.implementerId ?? undefined,
      ...overrides,
    })
    if (res.byKind?.prd) ledger.prdFile = res.byKind.prd
    if (res.byKind?.spec) ledger.specFile = res.byKind.spec
    if (res.byKind?.todo) ledger.todoFile = res.byKind.todo
    return res
  } catch {
    return null
  }
}

/** 对多个 Issue 依正文提取出的 Depends on / Blocks 关系进行拓扑排序与策略建议。 */
export function analyzeIssueDependencies(issueItems = []) {
  const byNum = new Map()
  for (const it of issueItems) if (Number.isInteger(it?.number)) byNum.set(it.number, it)
  const nums = [...byNum.keys()]
  if (nums.length <= 1) {
    return { hasDependencies: false, orderedIssues: nums, edges: [], hasCycle: false, strategy: nums.length === 1 ? 'single-issue' : 'none' }
  }
  const adj = new Map(nums.map((n) => [n, new Set()]))
  const indeg = new Map(nums.map((n) => [n, 0]))
  const edges = []
  const addEdge = (from, to, kind) => {
    if (!byNum.has(from) || !byNum.has(to) || from === to || adj.get(from).has(to)) return
    adj.get(from).add(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
    edges.push({ from, to, kind })
  }
  for (const item of byNum.values()) {
    const rel = item.relations ?? parseBodyRelations(item.body ?? '')
    for (const dep of rel.dependsOn ?? []) addEdge(dep, item.number, 'depends-on')
    for (const blk of rel.blocks ?? []) addEdge(item.number, blk, 'blocks')
  }
  const queue = nums.filter((n) => indeg.get(n) === 0).sort((a, b) => a - b)
  const ordered = []
  while (queue.length > 0) {
    const cur = queue.shift()
    ordered.push(cur)
    for (const next of adj.get(cur)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) { queue.push(next); queue.sort((a, b) => a - b) }
    }
  }
  const hasCycle = ordered.length < nums.length
  if (hasCycle) for (const n of nums.sort((a, b) => a - b)) if (!ordered.includes(n)) ordered.push(n)
  const parents = new Set()
  for (const it of byNum.values()) for (const p of it.relations?.partOf ?? []) parents.add(p)
  return {
    hasDependencies: edges.length > 0, orderedIssues: ordered, edges, hasCycle,
    strategy: edges.length > 0 ? 'serial-order' : (parents.size === 1 ? 'same-branch-or-parallel' : 'parallel-or-combine'),
  }
}

export async function inspectWorkspace(targetDir = process.cwd(), opts = {}) {
  const roots = await import('../../lib/git.mjs').then((m) => m.resolveRepoRoots(targetDir))
  const mainRoot = roots.mainRoot
  const workRoot = roots.workTreeRoot

  const [remoteRes, headRes, branchRes, logRes, userNameRes, userEmailRes, wtRes, conventions, stZ] = await Promise.all([
    roots.isGit ? gitRun(workRoot, ['remote', '-v']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['rev-parse', 'HEAD']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['symbolic-ref', '--short', 'HEAD']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['log', '--format=%an <%ae>', '-n', '100']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['config', '--get', 'user.name']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['config', '--get', 'user.email']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(mainRoot, ['worktree', 'list', '--porcelain']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? detectProjectConventions(mainRoot) : Promise.resolve({ defaultBranch: 'main', commitStyle: 'plain', hasDocsSystem: false }),
    roots.isGit ? gitStatusPorcelainZ(workRoot) : Promise.resolve({ ok: true, entries: [] }),
  ])

  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const head = headRes.ok && headRes.stdout ? headRes.stdout.trim() : null
  const branch = branchRes.ok && branchRes.stdout ? branchRes.stdout.trim() : (head ? '(detached)' : null)
  let commits = 0
  if (head && roots.isGit) {
    const cntRes = await gitRun(workRoot, ['rev-list', '--count', 'HEAD'])
    if (cntRes.ok && /^\d+$/.test(cntRes.stdout.trim())) commits = Number(cntRes.stdout.trim())
  }
  const historyAuthors = logRes.ok && logRes.stdout ? [...new Set(logRes.stdout.split('\n').filter(Boolean))] : []
  const gitIdentity = {
    name: userNameRes.ok ? userNameRes.stdout.trim() : undefined,
    email: userEmailRes.ok ? userEmailRes.stdout.trim() : undefined,
  }

  const profile = parseAgentsProfile(mainRoot)
  const declaredRepo = detectDeclaredRepo(mainRoot)
  const ghProbe = await probeGitHubEnv({ cwd: mainRoot, remoteUrls, probeNetwork: Boolean(opts.probeAuth) })
  const originFull = githubRepoFull(remoteUrls.origin ?? Object.values(remoteUrls)[0])
  const parsedInputs = parseFlowInputs(opts.inputs ?? [], originFull)
  if (opts.issue) {
    for (const n of String(opts.issue).split(',').filter(Boolean)) {
      const num = Number(n.replace(/^#/, ''))
      if (Number.isInteger(num)) parsedInputs.issues.push({ repo: originFull, number: num, raw: `#${num}` })
    }
  }
  if (opts.pr) {
    const num = Number(String(opts.pr).replace(/^#/, ''))
    if (Number.isInteger(num)) parsedInputs.prs.push({ repo: originFull, number: num, raw: `pr#${num}` })
  }

  const shouldFetchRepoMeta = Boolean(opts.probeAuth) && originFull && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')
  const canQueryApi = ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token'
  const [repoMetaRes, fetchedIssues, fetchedPrs] = await Promise.all([
    shouldFetchRepoMeta ? ghProbe.client.getRepoMeta(originFull) : Promise.resolve(null),
    Promise.all(parsedInputs.issues.map(async (it) => {
      const targetRepo = it.repo ?? originFull
      if (targetRepo && canQueryApi) {
        const res = await ghProbe.client.getIssue(targetRepo, it.number)
        if (res.ok) return { ...it, ...res, fetched: true }
      }
      return { ...it, fetched: false, relations: { dependsOn: [], blocks: [], partOf: [], fixes: [], refs: [] } }
    })),
    Promise.all(parsedInputs.prs.map(async (pr) => {
      const targetRepo = pr.repo ?? originFull
      if (targetRepo && canQueryApi) {
        const res = await ghProbe.client.getPr(targetRepo, pr.number)
        if (res.ok) return { ...pr, ...res, fetched: true }
      }
      return { ...pr, fetched: false }
    })),
  ])

  let externalPr = opts.externalPr ? Number(opts.externalPr) : null
  if (!externalPr && fetchedPrs.length === 1 && fetchedPrs[0].fetched) {
    const p = fetchedPrs[0]
    if (p.headRepo && originFull && p.headRepo.toLowerCase() !== originFull.toLowerCase()) externalPr = p.number
  }

  const identity = resolveWorkspaceIdentity({
    gitDir: roots.gitDir, remoteUrls, declaredRepo, gitIdentity, historyAuthors, commits, externalPr,
    apiProbe: repoMetaRes?.ok ? repoMetaRes : undefined,
  })

  let reuseExistingPr = null
  if (fetchedPrs.length > 0 && (fetchedIssues.length > 0 || fetchedPrs.length === 1)) {
    const pr = fetchedPrs[0]
    if (fetchedIssues.length > 0 || (pr.fetched && !externalPr)) {
      reuseExistingPr = {
        prNumber: pr.number, branch: pr.headBranch ?? null, baseBranch: pr.baseBranch ?? null, url: pr.url ?? pr.raw,
        linkedIssues: fetchedIssues.map((i) => i.number),
        note: '检测到已有 PR（与 Issue 关联），请直接复用该 PR 与原分支，禁止新开第二个 PR',
      }
    }
  }

  return {
    isGit: roots.isGit,
    mainRoot,
    workTreeRoot: workRoot,
    isWorktree: roots.isWorktree,
    branch,
    head,
    commits,
    dirty: stZ.entries.length,
    defaultBranch: conventions.defaultBranch,
    commitStyle: conventions.commitStyle,
    hasDocsSystem: conventions.hasDocsSystem,
    declaredRepo: declaredRepo ?? null,
    remoteUrls,
    remotesTopology: topology.remotes,
    gitIdentity,
    identity,
    github: ghProbe.env,
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
    worktrees: parseWorktreeListPorcelain(wtRes.stdout),
    activeTasks: listTaskLedgers(mainRoot, { includeTerminal: false }).map((t) => ({
      taskId: t.taskId, slug: t.slug, status: t.status, branch: t.branch, worktreePath: t.worktreePath, prNumber: t.prNumber,
    })),
    inputs: { issues: fetchedIssues, prs: fetchedPrs, unknown: parsedInputs.unknown, reuseExistingPr, issueGraph: analyzeIssueDependencies(fetchedIssues) },
  }
}

function findMatchingDocStrict(root, dirRel, slug, taskId) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  try {
    for (const n of readdirSync(abs).filter((x) => x.endsWith('.md')).sort()) {
      const fn = parseDocFilename(n)
      if (fn && fn.slug === slug) return `${dirRel}/${n}`
      const fm = parseDocFrontmatter(readTextSafe(join(abs, n)) ?? '')
      if (fm.data?.task_id === taskId) return `${dirRel}/${n}`
    }
  } catch { /* ignore */ }
  return null
}

/** 将主仓中尚未提交的关联规划文档同步迁入新创建的 Tier 2 实施 worktree，防止断链。 */
async function migrateUncommittedPlanDocs(mainRoot, implAbs, ledger) {
  const st = await gitStatusPorcelainZ(mainRoot)
  if (!st.ok) return []
  const dirtyMap = new Map(st.entries.map((e) => [e.file, e.xy]))
  const migrated = []

  const candidates = new Set([ledger.prdFile, ledger.specFile, ledger.todoFile].filter(Boolean))
  for (const [rel, xy] of dirtyMap.entries()) {
    if (!/^docs\/(?:prd|specs|todo)\/[^/]+\.md$/.test(rel)) continue
    const fn = parseDocFilename(rel)
    if (fn && fn.slug === ledger.slug) candidates.add(rel)
    else {
      const fm = parseDocFrontmatter(readTextSafe(join(mainRoot, rel)) ?? '')
      if (fm.data?.task_id === ledger.taskId) candidates.add(rel)
    }
    void xy
  }

  for (const rel of candidates) {
    const srcAbs = join(mainRoot, rel)
    const dstAbs = join(implAbs, rel)
    if (!existsSync(srcAbs)) continue
    const xy = dirtyMap.get(rel)
    if (!xy && existsSync(dstAbs)) continue
    mkdirSync(dirname(dstAbs), { recursive: true })
    copyFileSync(srcAbs, dstAbs)
    migrated.push(rel)
    if (xy === '??') {
      try { unlinkSync(srcAbs) } catch { /* ignore */ }
    }
  }
  return migrated
}

export async function handleStart(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const op = await detectInProgressGitOp(roots.mainRoot)
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 仓库正处于 ${op.op} 状态，请先解决冲突再执行 start`)

  const linkedIssues = opts.issue || opts.issues
    ? String(opts.issues ?? opts.issue).split(',').map((s) => Number(s.replace(/^#/, '').trim())).filter(Number.isInteger)
    : []
  const rawTaskId = opts.task ?? (opts.slug ? slugify(opts.slug) : (linkedIssues[0] ? `issue-${linkedIssues[0]}` : null))
  if (!rawTaskId) throw new Error('start 需要传 --task <taskId>（或提供 --slug / --issue）')
  const taskId = sanitizeTaskId(rawTaskId)

  const caseType = opts.case !== undefined ? Number(opts.case) : 3
  if (caseType === 5) {
    process.stderr.write('BLOCKED_CASE_5_TDD_CONFLICT: 需求与 docs/TDD.md 或生效 SPEC 冲突，请先更新 TDD.md 并获批后再开工。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const slug = slugify(opts.slug ?? taskId)
  const externalPr = opts['external-pr'] ? Number(opts['external-pr']) : null
  const prNumber = externalPr ?? (opts.pr ? Number(opts.pr) : null)
  const state = await inspectWorkspace(roots.mainRoot, { externalPr, pr: prNumber, probeAuth: Boolean(opts['probe-auth']) })
  let role = state.identity.role
  const providerId = state.identity.providerId ?? 'github'

  if (role === 'clone-readonly' && !externalPr) {
    const choice = opts['clone-choice']
    if (!choice) {
      const guidance = {
        blocked: true, code: 'ACTION_REQUIRED_CLONE_CHOICE', reason: state.identity.reason,
        ...(state.identity.teamProbeHint ? { teamProbeHint: state.identity.teamProbeHint } : {}),
        choices: [
          { choice: 'fork', desc: '作为贡献者 Fork 协同：写入 .git/pf-fork-mode' },
          { choice: 'standalone', desc: '作为独立个人仓库继续：写入 .git/pf-standalone-mode' },
          { choice: 'local', desc: '仅本地使用不推远端：写入 .git/pf-local-mode' },
        ],
      }
      if (opts.json) process.stdout.write(`${JSON.stringify(guidance, null, 2)}\n`)
      else {
        process.stdout.write(`停下确认：检测到当前仓库为只读克隆（${state.identity.reason}）。请选择协作方式：\n`)
        for (const c of guidance.choices) process.stdout.write(`  --clone-choice ${c.choice.padEnd(10)} : ${c.desc}\n`)
        printNextStep([`重新运行带上选择：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskId} --clone-choice <fork|standalone|local>`], { repoRoot: roots.mainRoot })
      }
      return { exitCode: EXIT_ACTION_REQUIRED }
    }
    if (choice === 'local') { writeAtomic(join(roots.gitDir, 'pf-local-mode'), `enabled at ${new Date().toISOString()}\n`); role = 'local-only' }
    else if (choice === 'standalone') { writeAtomic(join(roots.gitDir, 'pf-standalone-mode'), `enabled at ${new Date().toISOString()}\n`); role = 'maintainer' }
    else if (choice === 'fork') {
      writeAtomic(join(roots.gitDir, 'pf-fork-mode'), `enabled at ${new Date().toISOString()}\n`)
      if (opts['fork-url'] && state.remoteUrls.origin && !state.remoteUrls.upstream) {
        await gitRun(roots.mainRoot, ['remote', 'rename', 'origin', 'upstream'])
        await gitRun(roots.mainRoot, ['remote', 'add', 'origin', opts['fork-url']])
      }
      role = 'contributor-fork'
    } else throw new Error(`--clone-choice 仅支持 fork | standalone | local，收到：${choice}`)
  }

  const existing = readTaskLedger(roots.mainRoot, taskId)
  if (existing && existing.status !== 'cleaned' && existing.status !== 'aborted' && (
    (existing.worktreePath && existsSync(join(roots.mainRoot, existing.worktreePath)))
    || existing.isolation === 'branch'
  )) {
    if (opts.todo) existing.todoFile = opts.todo
    if (opts.spec) existing.specFile = opts.spec
    if (opts.prd) existing.prdFile = opts.prd
    if (linkedIssues.length > 0) existing.linkedIssues = [...new Set([...(existing.linkedIssues ?? []), ...linkedIssues])]
    if (prNumber && !existing.prNumber) existing.prNumber = prNumber
    writeTaskLedger(roots.mainRoot, existing)
    if (opts.json) process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`)
    else {
      process.stdout.write(`任务 ${taskId} 已存在（幂等复用）：isolation=${existing.isolation}, branch=${existing.branch ?? 'detached'}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" status --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const baseBranch = state.defaultBranch || 'main'
  const baseSha = state.head
  const implementerId = opts.implementer
    ?? (state.gitIdentity.name ? `${state.gitIdentity.name}${state.gitIdentity.email ? ` <${state.gitIdentity.email}>` : ''}` : 'implementer')
  await ensureWorktreesIgnored(roots.mainRoot, roots.gitDir)

  if (externalPr) {
    const reviewRel = `.worktrees/review-pr-${externalPr}`
    const reviewAbs = join(roots.mainRoot, reviewRel)
    let targetSha = opts['pr-ref'] ?? null
    if (!targetSha) {
      const fetchRemote = state.remotesTopology?.find((r) => r.providerId === 'github')?.name ?? 'origin'
      const fetchRes = await gitRun(roots.mainRoot, ['fetch', fetchRemote, `pull/${externalPr}/head`])
      if (fetchRes.ok) {
        const fh = await gitRun(roots.mainRoot, ['rev-parse', 'FETCH_HEAD'])
        if (fh.ok) targetSha = fh.stdout.trim()
      } else {
        const localRef = await gitRun(roots.mainRoot, ['rev-parse', '--verify', `refs/pull/${externalPr}/head`])
        if (localRef.ok) targetSha = localRef.stdout.trim()
      }
    }
    if (!targetSha) throw new Error(`无法拉取外部 PR #${externalPr} 的提交（可传入 --pr-ref 指定本地测试 ref）`)
    if (!existsSync(reviewAbs)) {
      const wtAdd = await gitRun(roots.mainRoot, ['worktree', 'add', '--detach', reviewAbs, targetSha])
      if (!wtAdd.ok) throw new Error(`创建外部 PR 审查位失败：${wtAdd.stderr}`)
    }
    const ledger = createDefaultLedger({
      taskId, slug, caseType, tier: 3, isolation: 'review-pr', role: 'inbound-external-pr', providerId: 'github',
      branch: null, baseBranch, baseSha: baseSha ?? targetSha, worktreePath: null, reviewWorktreePath: reviewRel,
      linkedIssues, prNumber: externalPr, implementerId: `external-pr-${externalPr}`, status: 'review-ready',
    })
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`已建立外部 PR 审查隔离位：${reviewRel}（detached @ ${targetSha.slice(0, 7)}，未挂载依赖）\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${externalPr} --untrusted-scan` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const branchPrefix = caseType === 2 ? 'fix' : caseType === 1 ? 'docs' : 'feat'
  const branch = opts.branch || `${branchPrefix}/${slug}`
  const filesCount = opts.files !== undefined ? Number(opts.files) : undefined
  const forceWorktree = Boolean(opts.parallel) || caseType >= 3 || linkedIssues.length > 0 || state.dirty > 0 || (filesCount !== undefined && filesCount >= 4)

  const initialTodo = opts.todo ?? existing?.todoFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/todo', slug, taskId)
  const initialSpec = opts.spec ?? existing?.specFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/specs', slug, taskId)
  const initialPrd = opts.prd ?? existing?.prdFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/prd', slug, taskId)

  if (!forceWorktree || state.commits === 0) {
    if (Boolean(opts.parallel) && state.commits === 0) throw new Error('仓库尚无初始提交，无法使用 worktree 并行隔离')
    const hasBranch = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    const sw = hasBranch.ok ? await gitRun(roots.mainRoot, ['switch', branch]) : await gitRun(roots.mainRoot, ['switch', '-c', branch])
    if (!sw.ok) throw new Error(`切换分支 ${branch} 失败：${sw.stderr}`)
    const ledger = createDefaultLedger({
      taskId, slug, caseType, tier: 1, isolation: 'branch', role, providerId, branch, baseBranch, baseSha,
      worktreePath: null, reviewWorktreePath: `.worktrees/review-${taskId}`,
      todoFile: initialTodo ?? null, specFile: initialSpec ?? null, prdFile: initialPrd ?? null,
      linkedIssues, prNumber, implementerId, status: 'started',
    })
    if (linkedIssues.length > 0) await syncTaskDocsSafe(roots.mainRoot, ledger)
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`任务 ${taskId} 已就绪（Tier 1 分支模式）：branch=${branch}, role=${role}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  // Tier 2: 实施工作树 + 挂载依赖（不在 start 阶段预分配过时的 baseSha 审查空槽，改由 submit/review 同步推进至最新 HEAD）
  const implRel = `.worktrees/impl-${taskId}`
  const reviewRel = `.worktrees/review-${taskId}`
  const implAbs = join(roots.mainRoot, implRel)

  if (!existsSync(implAbs)) {
    const hasBranch = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    const addArgs = hasBranch.ok ? ['worktree', 'add', implAbs, branch] : ['worktree', 'add', '-b', branch, implAbs, baseSha]
    const wtRes = await gitRun(roots.mainRoot, addArgs)
    if (!wtRes.ok) throw new Error(`创建实施 worktree 失败：${wtRes.stderr}`)
  }

  const depMount = mountSharedDeps(roots.mainRoot, implAbs)
  const ledger = createDefaultLedger({
    taskId, slug, caseType, tier: 2, isolation: 'worktree', role, providerId, branch, baseBranch, baseSha,
    worktreePath: implRel, reviewWorktreePath: reviewRel, depsMode: depMount.mode,
    todoFile: initialTodo ?? null, specFile: initialSpec ?? null, prdFile: initialPrd ?? null,
    linkedIssues, prNumber, implementerId, status: 'started',
  })

  const migratedDocs = await migrateUncommittedPlanDocs(roots.mainRoot, implAbs, ledger)
  if (!ledger.todoFile) ledger.todoFile = findMatchingDocStrict(implAbs, 'docs/todo', slug, taskId)
  if (!ledger.specFile) ledger.specFile = findMatchingDocStrict(implAbs, 'docs/specs', slug, taskId)
  if (!ledger.prdFile) ledger.prdFile = findMatchingDocStrict(implAbs, 'docs/prd', slug, taskId)
  if (linkedIssues.length > 0) await syncTaskDocsSafe(implAbs, ledger)
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...ledger, depsMount: depMount, migratedDocs }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已就绪（Tier 2 Worktree 模式）：\n`)
    process.stdout.write(`- 实施位: ${implRel}（分支: ${branch}，依赖模式: ${depMount.mode}）\n`)
    if (migratedDocs.length > 0) process.stdout.write(`- 已迁入规划文档: ${migratedDocs.join(', ')}\n`)
    process.stdout.write(`- 角色: ${role} | 基线: ${baseBranch}@${(baseSha ?? '').slice(0, 7)}\n`)
    printNextStep([
      linkedIssues.length > 0 && role !== 'local-only' && role !== 'generic-git'
        ? { skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId}` }
        : `在 ${implRel} 中推进实施；提交评审时将自动同步创建 ${reviewRel} 审查工作树。`,
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleClaim(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  if (opts.issue) {
    const extra = String(opts.issue).split(',').map((s) => Number(s.replace(/^#/, '').trim())).filter(Number.isInteger)
    ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extra])]
  }
  const actor = opts.agent ?? ledger.implementerId ?? 'local-agent'
  if (!ledger.implementerId) ledger.implementerId = actor
  const claimRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) await syncTaskDocsSafe(claimRoot, ledger)

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  if (skipApi) {
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status }, null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰平台 API）。\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
  const claimResults = []
  for (const num of ledger.linkedIssues) {
    const commentRes = await ghProbe.client.postComment({
      repo: targetRepo, number: num,
      body: `认领：由 ${actor} 在分支 \`${ledger.branch}\` 开始处理（task: \`${taskId}\`）。`,
      statePayload: { taskId, action: 'claim', branch: ledger.branch },
    })
    const labelRes = await ghProbe.client.addLabels({ repo: targetRepo, number: num, labels: ['in-progress'] })
    claimResults.push({ issue: num, comment: commentRes, label: labelRes })
  }

  ledger.status = 'claimed'
  ledger.claimedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, targetRepo, claimResults }, null, 2)}\n`)
  else {
    process.stdout.write(`任务 ${taskId} 已认领（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}
