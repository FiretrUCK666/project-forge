/**
 * flow-inspect.mjs —— 工作区探测（inspect）、任务启动（start）、认领（claim）与多 Issue 依赖拓扑。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { parseDocFilename, parseDocFrontmatter, slugify, syncDocsLifecycle } from '../../lib/docs.mjs'
import {
  LIKELY_DEFAULT_BRANCHES, canonicalPath, detectInProgressGitOp, ensureWorktreesIgnored,
  gitDiffNameStatusZ, gitRun, gitRunBuffer, gitStatusPorcelainZ, parseWorktreeListPorcelain, posixPath,
  readTextSafe, resolveRepoRoots, writeAtomic,
} from '../../lib/git.mjs'
import { createDefaultLedger, listTaskLedgers, readTaskLedger, sanitizeTaskId, writeTaskLedger } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, githubRepoFull, parseFlowInputs,
  parseIssueNumbers, parsePrNumber, parseRemotesTopology,
  parseRemoteUrls, probeGitHubEnv, resolveContributorIdentity, resolveWorkspaceIdentity,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { analyzeIssueDependencies } from '../../lib/workflow-policy.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

export { analyzeIssueDependencies }
export const EXIT_POLICY_BLOCK = 3
export const EXIT_ACTION_REQUIRED = 4

/** 使用 `-z` 安全收集相对于 baseRef 的全部变更文件（含无 baseSha 首提交 `ls-tree HEAD` 与未提交变动）。 */
export async function getChangedFiles(cwd, baseRef) {
  const [diff, tree, st] = await Promise.all([
    baseRef ? gitDiffNameStatusZ(cwd, [`${baseRef}..HEAD`]) : Promise.resolve(null),
    baseRef ? Promise.resolve(null) : gitRunBuffer(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']),
    gitStatusPorcelainZ(cwd),
  ])
  const set = new Set()
  if (diff?.ok) for (const e of diff.entries) if (e.file) set.add(e.file)
  if (tree?.ok) for (const f of tree.stdout.toString('utf8').split('\0')) if (f) set.add(posixPath(f))
  if (st.ok) for (const e of st.entries) if (e.file) set.add(e.file)
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

function parsePorcelainV2BranchZ(buf) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  let head = null
  let branch = null
  let dirty = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith('# branch.oid ')) {
      const val = tok.slice(13).trim()
      head = val && val !== '(initial)' ? val : null
    } else if (tok.startsWith('# branch.head ')) {
      const val = tok.slice(14).trim()
      branch = val || null
    } else if (!tok.startsWith('#')) {
      dirty += 1
      if (tok.startsWith('2 ')) i += 1
    }
  }
  if (branch === '(detached)' && !head) branch = null
  return { head, branch, dirty }
}

function resolveDefaultBranchFromRefs(refsStdout, curBranch, initDefaultBranch) {
  const localHeads = new Set()
  const originHeads = new Set()
  let originHeadTarget
  for (const rawLine of String(refsStdout ?? '').split('\n')) {
    if (!rawLine) continue
    const [refName, symTarget = ''] = rawLine.split('\t')
    if (refName === 'refs/remotes/origin/HEAD' && symTarget.trim()) {
      originHeadTarget = symTarget.trim().replace(/^origin\//, '')
    } else if (refName.startsWith('refs/heads/')) {
      localHeads.add(refName.slice(11))
    } else if (refName.startsWith('refs/remotes/origin/')) {
      const name = refName.slice(20)
      if (name !== 'HEAD') originHeads.add(name)
    }
  }
  if (originHeadTarget) return originHeadTarget
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
}

function readGitConfigFast(gitCommonDir) {
  if (!gitCommonDir) return null
  if (process.env.GIT_CONFIG_GLOBAL || process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const localCfg = readTextSafe(join(gitCommonDir, 'config'))
  if (localCfg === undefined) return null
  const xdgHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalPaths = [join(homedir(), '.gitconfig'), join(xdgHome, 'git', 'config')]
  let globalCfg = ''
  for (const gp of globalPaths) {
    const txt = readTextSafe(gp)
    if (txt) { globalCfg = txt; break }
  }
  const combined = `${globalCfg}\n${localCfg}`
  if (/^\s*\[(?:url\b|include\b|includeif\b)/im.test(combined)) return null

  const remoteLines = []
  let curSection = ''
  let curRemote = null
  const remotes = new Map()
  let userName
  let userEmail
  let initDefaultBranch

  for (const rawCfg of [globalCfg, localCfg]) {
    curSection = ''
    curRemote = null
    for (const rawLine of rawCfg.split('\n')) {
      const line = rawLine.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"([^"]*)")?\]$/i.exec(line)
      if (sec) {
        curSection = sec[1].toLowerCase()
        curRemote = curSection === 'remote' ? (sec[2] ?? '') : null
        if (curSection === 'remote' && curRemote && !remotes.has(curRemote)) {
          remotes.set(curRemote, { urls: [], pushUrls: [] })
        }
        continue
      }
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (curSection === 'user') {
        if (k === 'name') userName = v
        else if (k === 'email') userEmail = v
      } else if (curSection === 'init' && k === 'defaultbranch') {
        initDefaultBranch = v
      } else if (curSection === 'remote' && curRemote) {
        const entry = remotes.get(curRemote)
        if (k === 'url' && v) entry.urls.push(v)
        else if (k === 'pushurl' && v) entry.pushUrls.push(v)
      }
    }
  }

  for (const [name, entry] of remotes.entries()) {
    const fetchUrl = entry.urls[0]
    const pushUrl = entry.pushUrls[0] ?? fetchUrl
    if (fetchUrl) remoteLines.push(`${name}\t${fetchUrl} (fetch)`)
    if (pushUrl) remoteLines.push(`${name}\t${pushUrl} (push)`)
  }
  return {
    userName,
    userEmail,
    initDefaultBranch,
    remoteText: remoteLines.join('\n'),
    hasIdentity: Boolean(userName && userEmail),
  }
}

function readRefsFast(gitCommonDir, curBranch, initDefaultBranch) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  let originHeadTarget
  const origHeadPath = join(gitCommonDir, 'refs', 'remotes', 'origin', 'HEAD')
  const origHeadText = readTextSafe(origHeadPath)
  if (origHeadText) {
    const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/im.exec(origHeadText.trim())
    if (m) return m[1].trim()
  }
  const localHeads = new Set()
  const originHeads = new Set()
  const scanLoose = (dirAbs, prefix, bucket) => {
    if (!existsSync(dirAbs)) return
    const stack = [{ abs: dirAbs, rel: '' }]
    while (stack.length > 0) {
      const cur = stack.pop()
      let entries = []
      try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const name = cur.rel ? `${cur.rel}/${e.name}` : e.name
        if (e.isDirectory()) stack.push({ abs: join(cur.abs, e.name), rel: name })
        else if (e.isFile() && name !== 'HEAD') bucket.add(name)
      }
    }
    void prefix
  }
  scanLoose(join(gitCommonDir, 'refs', 'heads'), '', localHeads)
  scanLoose(join(gitCommonDir, 'refs', 'remotes', 'origin'), '', originHeads)
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const refName = line.slice(sp + 1).trim()
      if (refName.startsWith('refs/heads/')) localHeads.add(refName.slice(11))
      else if (refName.startsWith('refs/remotes/origin/')) {
        const n = refName.slice(20)
        if (n !== 'HEAD') originHeads.add(n)
      }
    }
  }
  if (originHeadTarget) return originHeadTarget
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
}

export async function inspectWorkspace(targetDir = process.cwd(), opts = {}) {
  const roots = opts.roots ?? await resolveRepoRoots(targetDir)
  const mainRoot = roots.mainRoot
  const workRoot = roots.workTreeRoot
  const hasLinkedWorktrees = Boolean(roots.isGit && roots.gitDir && (roots.isWorktree || existsSync(join(roots.gitDir, 'worktrees'))))
  const fastCfg = roots.isGit ? readGitConfigFast(roots.gitDir) : null
  const needGitConfig = Boolean(roots.isGit && (!fastCfg || !fastCfg.hasIdentity))
  const needRefsExec = Boolean(roots.isGit && existsSync(join(roots.gitDir ?? '', 'reftable')))

  const [statusRes, remoteRes, configRes, logRes, refsRes, wtRes] = roots.isGit
    ? await Promise.all([
        gitRunBuffer(workRoot, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
        fastCfg ? Promise.resolve({ ok: true, stdout: fastCfg.remoteText }) : gitRun(workRoot, ['remote', '-v']),
        needGitConfig ? gitRun(workRoot, ['config', '--get-regexp', '^(user\\.name|user\\.email|init\\.defaultbranch)$']) : Promise.resolve(null),
        gitRun(workRoot, ['--no-optional-locks', 'log', '-n', '500', '--format=%an <%ae>\x1f%s']),
        needRefsExec ? gitRun(mainRoot, ['for-each-ref', '--format=%(refname)\t%(symref:short)', 'refs/heads', 'refs/remotes/origin']) : Promise.resolve(null),
        hasLinkedWorktrees ? gitRun(mainRoot, ['--no-optional-locks', 'worktree', 'list', '--porcelain']) : Promise.resolve(null),
      ])
    : [{ ok: false, stdout: '' }, { ok: false, stdout: '' }, null, { ok: false, stdout: '' }, null, null]

  const stParsed = parsePorcelainV2BranchZ(statusRes.ok ? statusRes.stdout : '')
  const head = stParsed.head
  const branch = stParsed.branch ?? (head ? '(detached)' : null)
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)

  let userName = fastCfg?.userName
  let userEmail = fastCfg?.userEmail
  let initDefaultBranch = fastCfg?.initDefaultBranch
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
  const convRe = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
  const convCount = subjects.filter((s) => convRe.test(s)).length
  const commitStyle = subjects.length > 0 && convCount > subjects.length / 2 ? 'conventional' : 'plain'
  let commits = 0
  if (head) {
    if (logLines.length < 500) commits = logLines.length
    else {
      const revRes = await gitRun(workRoot, ['--no-optional-locks', 'rev-list', '--count', 'HEAD'])
      commits = revRes.ok && /^\d+$/.test(revRes.stdout?.trim()) ? Number(revRes.stdout.trim()) : logLines.length
    }
  }

  const defaultBranch = !roots.isGit
    ? 'main'
    : (needRefsExec
        ? resolveDefaultBranchFromRefs(refsRes?.stdout, branch, initDefaultBranch)
        : (readRefsFast(roots.gitDir, branch, initDefaultBranch) ?? resolveDefaultBranchFromRefs('', branch, initDefaultBranch)))
  const hasDocsSystem = existsSync(join(mainRoot, 'docs', 'TDD.md'))
    || existsSync(join(mainRoot, 'docs', 'specs'))
    || existsSync(join(mainRoot, 'docs', 'todo'))
    || existsSync(join(mainRoot, 'docs', 'prd'))
  const worktrees = !roots.isGit
    ? []
    : (wtRes?.ok && wtRes.stdout
        ? parseWorktreeListPorcelain(wtRes.stdout)
        : [{ path: canonicalPath(mainRoot), head, branch: branch === '(detached)' ? null : branch, detached: branch === '(detached)', bare: false, prunable: null }])

  const profile = parseAgentsProfile(mainRoot)
  const declaredRepo = detectDeclaredRepo(mainRoot)
  const ghProbe = await probeGitHubEnv({ cwd: mainRoot, remoteUrls, probeNetwork: Boolean(opts.probeAuth) })
  const originFull = githubRepoFull(remoteUrls.origin ?? Object.values(remoteUrls)[0])
  const parsedInputs = parseFlowInputs(opts.inputs ?? [], originFull)
  const addUnique = (bucket, item) => {
    if (item && Number.isInteger(item.number) && !bucket.some((x) => x.number === item.number && (x.repo ?? originFull) === (item.repo ?? originFull))) {
      bucket.push(item)
    }
  }
  if (opts.issue) {
    for (const it of parseFlowInputs(String(opts.issue).split(/[\s,]+/), originFull).issues) addUnique(parsedInputs.issues, it)
    for (const num of parseIssueNumbers(opts.issue)) addUnique(parsedInputs.issues, { repo: originFull, number: num, raw: `#${num}` })
  }
  const prRawFlag = opts.pr ?? opts.externalPr
  if (prRawFlag) {
    const rawPr = parseFlowInputs([String(prRawFlag)], originFull)
    if (rawPr.prs.length > 0) rawPr.prs.forEach((it) => addUnique(parsedInputs.prs, it))
    else {
      const num = parsePrNumber(prRawFlag)
      if (num) addUnique(parsedInputs.prs, { repo: originFull, number: num, raw: `pr#${num}` })
    }
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

  let externalPr = opts.externalPr ? parsePrNumber(opts.externalPr) : null
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
    dirty: stParsed.dirty,
    defaultBranch,
    commitStyle,
    hasDocsSystem,
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
    worktrees,
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
async function migrateUncommittedPlanDocs(mainRoot, implAbs, ledger, mainDirty = undefined) {
  if (mainDirty === 0) return []
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

  const parsedPos = parseFlowInputs(opts._ ?? [])
  const linkedIssues = [...new Set([
    ...parseIssueNumbers([opts.issues, opts.issue], { strict: true }),
    ...parsedPos.issues.map((i) => i.number),
  ])]
  const externalPr = opts['external-pr'] !== undefined ? parsePrNumber(opts['external-pr'], { strict: true }) : null
  const prFromFlag = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : (parsedPos.prs[0]?.number ?? null)
  let prNumber = externalPr ?? prFromFlag
  const wantCreateIssue = Boolean(opts['create-issue'])
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
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const state = await inspectWorkspace(roots.mainRoot, {
    roots, inputs: opts._, externalPr: opts['external-pr'] ?? externalPr, pr: opts.pr ?? prFromFlag,
    issue: linkedIssues.join(','), probeAuth: Boolean(opts['probe-auth']),
  })
  const effectiveExternalPr = externalPr
    ?? (state.identity.role === 'inbound-external-pr' ? (prNumber ?? state.inputs.prs[0]?.number ?? null) : null)
  if (effectiveExternalPr && !prNumber) prNumber = effectiveExternalPr
  if (!effectiveExternalPr && state.inputs.reuseExistingPr) {
    for (const iss of [...(state.inputs.reuseExistingPr.linkedIssues ?? []), ...(state.inputs.prs[0]?.relations?.fixes ?? [])]) {
      if (Number.isInteger(iss) && !linkedIssues.includes(iss)) linkedIssues.push(iss)
    }
  }
  let role = state.identity.role
  const providerId = state.identity.providerId ?? 'github'

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
      if (opts.json) process.stdout.write(`${JSON.stringify(guidance, null, 2)}\n`)
      else {
        process.stdout.write(`停下确认：检测到当前仓库为只读克隆（${state.identity.reason}）。请选择协作方式：\n`)
        for (const c of guidance.choices) process.stdout.write(`  --clone-choice ${c.choice.padEnd(10)} : ${c.desc}\n`)
        printNextStep([`重新运行带上选择：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${hintTask} --clone-choice <fork|standalone|local>`], { repoRoot: roots.mainRoot })
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

  let createdIssue = null
  if (wantCreateIssue && linkedIssues.length === 0) {
    if (role !== 'maintainer') {
      process.stderr.write(`BLOCKED_CREATE_ISSUE_ROLE: --create-issue 仅支持 maintainer 在 GitHub 仓创建新 Issue（当前 role=${role}）。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls, state.declaredRepo)
    if (!targetRepo || providerId !== 'github') {
      throw new Error('--create-issue 需要配置有效的 GitHub 远端仓库')
    }
    const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    const issueTitle = String(opts.title ?? opts.slug ?? prelimTaskId).trim()
    const issueBody = String(opts.body ?? [
      `## 任务追踪`,
      `- Slug: \`${slugify(opts.slug ?? issueTitle)}\``,
      `- Case: Case ${caseType}`,
      opts.task ? `- Task ID: \`${opts.task}\`` : null,
    ].filter(Boolean).join('\n')).trim()
    const issueLabels = opts.labels
      ? String(opts.labels).split(',').map((s) => s.trim()).filter(Boolean)
      : []
    const createRes = await ghClient.createIssue({
      repo: targetRepo,
      title: issueTitle,
      body: issueBody,
      labels: issueLabels,
    })
    if (createRes.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CREATE_ISSUE_DELEGATED', ...createRes }, null, 2)}\n`)
      else process.stdout.write(`无直连 GitHub 凭据，已生成创建 Issue 代理载荷：${JSON.stringify(createRes.jsonPayload)}\n`)
      return { exitCode: EXIT_ACTION_REQUIRED }
    }
    if (!createRes.ok || !createRes.number) {
      throw new Error(`创建 GitHub Issue 失败：${createRes.error ?? '未返回有效 Issue 编号'}`)
    }
    createdIssue = createRes
    linkedIssues.push(createRes.number)
  }

  const defaultPrTask = effectiveExternalPr ? `review-pr-${effectiveExternalPr}` : (prNumber ? `pr-${prNumber}` : null)
  const rawTaskId = opts.task ?? (opts.slug ? slugify(opts.slug) : (linkedIssues[0] ? `issue-${linkedIssues[0]}` : (defaultPrTask ?? (opts.title ? slugify(opts.title) : prelimTaskId))))
  const taskId = sanitizeTaskId(rawTaskId)
  const slug = slugify(opts.slug ?? (opts.title ? opts.title : taskId))

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
    const existingWorkRoot = existing.worktreePath ? resolve(roots.mainRoot, existing.worktreePath) : roots.mainRoot
    if ((existing.linkedIssues ?? []).length > 0 && existsSync(existingWorkRoot)) {
      await syncTaskDocsSafe(existingWorkRoot, existing)
    }
    writeTaskLedger(roots.mainRoot, existing)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...existing, ...(createdIssue ? { createdIssue } : {}) }, null, 2)}\n`)
    else {
      if (createdIssue) process.stdout.write(`已创建 GitHub Issue #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
      process.stdout.write(`任务 ${taskId} 已存在（幂等复用）：isolation=${existing.isolation}, branch=${existing.branch ?? 'detached'}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" status --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const baseBranch = state.defaultBranch || 'main'
  let baseSha = state.head
  if (state.commits > 0) {
    for (const candRef of [`refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`]) {
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', candRef])
      if (r.ok && r.stdout.trim()) { baseSha = r.stdout.trim(); break }
    }
  }
  const implementerId = resolveContributorIdentity({
    explicitActor: opts.implementer, ghLogin: state.github?.trackB?.login, gitName: state.gitIdentity?.name,
  }).actor
  await ensureWorktreesIgnored(roots.mainRoot, roots.gitDir)

  if (effectiveExternalPr) {
    const reviewRel = `.worktrees/review-pr-${effectiveExternalPr}`
    const reviewAbs = join(roots.mainRoot, reviewRel)
    let targetSha = opts['pr-ref'] ?? null
    if (!targetSha) {
      const fetchRemote = state.remotesTopology?.find((r) => r.providerId === 'github')?.name ?? 'origin'
      const fetchRes = await gitRun(roots.mainRoot, ['fetch', fetchRemote, `pull/${effectiveExternalPr}/head`])
      if (fetchRes.ok) {
        const fh = await gitRun(roots.mainRoot, ['rev-parse', 'FETCH_HEAD'])
        if (fh.ok) targetSha = fh.stdout.trim()
      } else {
        const localRef = await gitRun(roots.mainRoot, ['rev-parse', '--verify', `refs/pull/${effectiveExternalPr}/head`])
        if (localRef.ok) targetSha = localRef.stdout.trim()
      }
    }
    if (!targetSha) throw new Error(`无法拉取外部 PR #${effectiveExternalPr} 的提交（可传入 --pr-ref 指定本地测试 ref）`)
    if (!existsSync(reviewAbs)) {
      const wtAdd = await gitRun(roots.mainRoot, ['worktree', 'add', '--detach', reviewAbs, targetSha])
      if (!wtAdd.ok) throw new Error(`创建外部 PR 审查位失败：${wtAdd.stderr}`)
    }
    const ledger = createDefaultLedger({
      taskId, slug, caseType, tier: 3, isolation: 'review-pr', role: 'inbound-external-pr', providerId: 'github',
      branch: null, baseBranch, baseSha: baseSha ?? targetSha, worktreePath: null, reviewWorktreePath: reviewRel,
      linkedIssues, prNumber: effectiveExternalPr, implementerId: `external-pr-${effectiveExternalPr}`, status: 'review-ready',
    })
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`已建立外部 PR 审查隔离位：${reviewRel}（detached @ ${targetSha.slice(0, 7)}，未挂载依赖）\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${effectiveExternalPr} --untrusted-scan` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const branchPrefix = caseType === 2 ? 'fix' : caseType === 1 ? 'docs' : 'feat'
  const reusedPrBranch = state.inputs.reuseExistingPr?.branch ?? null
  const branch = opts.branch || reusedPrBranch || `${branchPrefix}/${slug}`

  const resolveLocalBranchRef = async () => {
    const has = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    if (has.ok || !reusedPrBranch || branch !== reusedPrBranch || !state.remoteUrls.origin) return has
    await gitRun(roots.mainRoot, ['fetch', 'origin', `${branch}:${branch}`])
    return await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  }

  const initialTodo = opts.todo ?? existing?.todoFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/todo', slug, taskId)
  const initialSpec = opts.spec ?? existing?.specFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/specs', slug, taskId)
  const initialPrd = opts.prd ?? existing?.prdFile ?? findMatchingDocStrict(roots.mainRoot, 'docs/prd', slug, taskId)

  if (state.commits === 0) {
    if (Boolean(opts.parallel)) throw new Error('仓库尚无初始提交，无法使用 worktree 并行隔离')
    const hasBranch = await resolveLocalBranchRef()
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
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...ledger, ...(createdIssue ? { createdIssue } : {}) }, null, 2)}\n`)
    else {
      if (createdIssue) process.stdout.write(`已创建 GitHub Issue #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
      process.stdout.write(`任务 ${taskId} 已就绪（Tier 1 初始无提交分支模式）：branch=${branch}, role=${role}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  // commits > 0 全量进入 Tier 2 Worktree 隔离，不再允许在主仓原地切换分支
  const implRel = `.worktrees/impl-${taskId}`
  const reviewRel = `.worktrees/review-${taskId}`
  const implAbs = join(roots.mainRoot, implRel)

  if (!existsSync(implAbs)) {
    const checkedOutAt = (state.worktrees ?? []).find((w) => w.branch === branch)
    if (checkedOutAt) {
      const msg = `BLOCKED_BRANCH_IN_USE: 分支 ${branch} 已在工作树 ${checkedOutAt.path} 检出，请传入 --branch <新分支名> 或清理原工作树。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_BRANCH_IN_USE', branch, checkedOutAt: checkedOutAt.path }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const hasBranch = await resolveLocalBranchRef()
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

  const migratedDocs = await migrateUncommittedPlanDocs(roots.mainRoot, implAbs, ledger, state.dirty)
  if (!ledger.todoFile) ledger.todoFile = findMatchingDocStrict(implAbs, 'docs/todo', slug, taskId)
  if (!ledger.specFile) ledger.specFile = findMatchingDocStrict(implAbs, 'docs/specs', slug, taskId)
  if (!ledger.prdFile) ledger.prdFile = findMatchingDocStrict(implAbs, 'docs/prd', slug, taskId)
  if (linkedIssues.length > 0) await syncTaskDocsSafe(implAbs, ledger)
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...ledger, depsMount: depMount, migratedDocs, ...(createdIssue ? { createdIssue } : {}) }, null, 2)}\n`)
  } else {
    if (createdIssue) process.stdout.write(`已创建 GitHub Issue #${createdIssue.number}${createdIssue.url ? ` (${createdIssue.url})` : ''}。\n`)
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
