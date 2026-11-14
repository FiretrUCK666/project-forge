#!/usr/bin/env node
/**
 * flow.mjs —— Git 协同流转状态机总引擎。
 *
 * 子命令：
 *   inspect  [inputs...] [--probe-auth] [--external-pr <M>] [--json]
 *   start    --task <id> [--slug <slug>] [--case <1..5>] [--files <n>] [--parallel] [--external-pr <M>] [--pr <M>] [--issue <N>] [--branch <name>] [--clone-choice <fork|standalone|local>] [--json]
 *   claim    --task <id> [--issue <N>] [--agent <id>] [--json]
 *   finalize --task <id> [--note <text>] [--json]
 *   verify   --task <id> [--mode quick|smoke|full|gate] [--target <file>] [--cmd <custom>] [--json]
 *   submit   --task <id> [--draft] [--rework] [--title <title>] [--body <text>] [--json]
 *   rework   --task <id> [--rebut "<findingId>: <reason>"] [--json]
 *   merge    --task <id> [--method merge|squash|rebase] [--human-approved] [--json]
 *   cleanup  --task <id> [--confirm] [--keep-branch] [--json]
 */

import {
  existsSync, mkdirSync, readdirSync, renameSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import {
  classifyDoorType, createDefaultLedger, detectDeclaredRepo, detectProjectConventions,
  ensureWorktreesIgnored, execShellCommand, githubRepoFull, githubRepoPath,
  gitRun, isMainModule, listTaskLedgers, matchGlob, parseAgentsProfile, parseBodyRelations, parseFlowInputs,
  posixPath, printNextStep, probeGitHubEnv, readTaskLedger, readTextSafe,
  resolveRepoRoots, resolveWorkspaceIdentity, samePath, sanitizeTaskId,
  sha256Text, slugify, writeAtomic, writeTaskLedger,
} from '../../lib/shared.mjs'
import { unmountSharedDeps, mountSharedDeps } from './worktree-deps.mjs'

const EXIT_POLICY_BLOCK = 3
const EXIT_ACTION_REQUIRED = 4

// ── 辅助函数 ──────────────────────────────────────────────────────────

function parseRemoteUrls(remoteOutput) {
  const urls = {}
  for (const line of String(remoteOutput ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (m) urls[m[1]] = m[2]
  }
  return urls
}

function parseStatusV2(text) {
  const out = { branch: null, oid: null, upstream: null, dirty: 0, lines: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) out.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) out.oid = line.slice(13).trim()
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(17).trim()
    else if (line.trim() !== '' && !line.startsWith('#')) {
      out.dirty += 1
      out.lines.push(line)
    }
  }
  return out
}

function parseWorktreeList(text) {
  const items = []
  let cur = null
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') {
      if (cur) items.push(cur)
      cur = null
      continue
    }
    if (line.startsWith('worktree ')) {
      cur = { path: resolve(line.slice(9).trim()), head: null, branch: null, detached: false }
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim()
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    } else if (cur && line.trim() === 'detached') {
      cur.detached = true
    }
  }
  if (cur) items.push(cur)
  return items
}

/** 对多个 Issue 依正文提取出的 Depends on / Blocks 关系进行拓扑排序与策略建议。 */
export function analyzeIssueDependencies(issueItems = []) {
  const byNum = new Map()
  for (const it of issueItems) {
    if (Number.isInteger(it?.number)) byNum.set(it.number, it)
  }
  const nums = [...byNum.keys()]
  if (nums.length <= 1) {
    return {
      hasDependencies: false,
      orderedIssues: nums,
      edges: [],
      hasCycle: false,
      strategy: nums.length === 1 ? 'single-issue' : 'none',
    }
  }

  const adj = new Map(nums.map((n) => [n, new Set()]))
  const indeg = new Map(nums.map((n) => [n, 0]))
  const edges = []

  const addEdge = (from, to, kind) => {
    if (!byNum.has(from) || !byNum.has(to) || from === to) return
    if (adj.get(from).has(to)) return
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
      if (indeg.get(next) === 0) {
        queue.push(next)
        queue.sort((a, b) => a - b)
      }
    }
  }

  const hasCycle = ordered.length < nums.length
  if (hasCycle) {
    for (const n of nums.sort((a, b) => a - b)) {
      if (!ordered.includes(n)) ordered.push(n)
    }
  }

  const shareParent = (() => {
    const parents = new Set()
    for (const it of byNum.values()) {
      for (const p of it.relations?.partOf ?? []) parents.add(p)
    }
    return parents.size === 1
  })()

  return {
    hasDependencies: edges.length > 0,
    orderedIssues: ordered,
    edges,
    hasCycle,
    strategy: edges.length > 0
      ? 'serial-order'
      : (shareParent ? 'same-branch-or-parallel' : 'parallel-or-combine'),
  }
}

const GATE_TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|(?:\.(?:test|spec)\.[^.]+$)|(?:^|\/)test_[^/]+\.py$|_test\.go$/i
const GATE_WORKFLOW_FILE_RE = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i
const GATE_SHELL_OR_SCRIPT_RE = /(?:^|\/)(?:\.github\/workflows\/[^/]+\.ya?ml|package\.json|Makefile|justfile)$|\.(?:sh|bash|ps1)$/i
const GATE_SKIP_RE = /(?:^|[^\w.])(?:(?:it|test|describe|context|suite)\.(?:skip|only)|(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.skip\b|@unittest\.skip\b|\bt\.Skip\s*\(|#\[ignore\])|\{\s*(?:skip|only)\s*:\s*true\b/
const GATE_ASSERTION_RE = /\b(?:assert\w*|expect|should)\s*[.(]|\bassert\s+|\bpytest\.raises\b|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\b|\bassert_(?:eq|ne|matches)?!\s*\(|\b(?:strictEqual|deepStrictEqual|equal|notEqual|throws|rejects|match)\s*\(/
const GATE_CI_PERM_WRITE_RE = /\b(?:contents|id-token|packages|security-events|actions|pull-requests|checks|deployments|issues)\s*:\s*write\b/i
const GATE_SHELL_BYPASS_RE = /(?:^|[\s;|&"'])\|\|\s*true(?:\s|$|["';&|])/

function isCommentLine(line) {
  const t = line.trim()
  return t === '' || t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*')
}

/** 扫描 diff 中可能弱化验证门禁的改动，返回精确命中列表。 */
export async function detectGateWeakening(implRoot, baseRef, baseBranch) {
  let ref = baseRef
  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const headSha = headRes.ok ? headRes.stdout.trim() : null

  if (!ref && baseBranch) {
    const brRes = await gitRun(implRoot, ['rev-parse', '--verify', baseBranch])
    if (brRes.ok && brRes.stdout.trim() !== headSha) ref = baseBranch
  }
  if (!ref) return []

  const diffRes = await gitRun(implRoot, ['diff', '--unified=3', '--no-color', `${ref}..HEAD`])
  if (!diffRes.ok || !diffRes.stdout) return []

  const findings = []
  let currentFile = ''
  let hunkRemovedAssertions = 0
  let hunkAddedAssertions = 0
  let hunkHasLines = false
  let permIndent = -1

  const flushHunk = () => {
    if (!hunkHasLines) return
    if (currentFile && GATE_TEST_FILE_RE.test(currentFile) && hunkRemovedAssertions > hunkAddedAssertions) {
      findings.push({
        type: 'deleted-assertion',
        file: currentFile,
        detail: `测试断言净减少（-${hunkRemovedAssertions} / +${hunkAddedAssertions}）`,
      })
    }
    hunkRemovedAssertions = 0
    hunkAddedAssertions = 0
    hunkHasLines = false
    permIndent = -1
  }

  for (const rawLine of diffRes.stdout.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      flushHunk()
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(rawLine)
      currentFile = m ? posixPath(m[1].trim()) : ''
      continue
    }
    if (rawLine.startsWith('+++ b/')) {
      currentFile = posixPath(rawLine.slice(6).trim())
      continue
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('index ') || rawLine.startsWith('new file ') || rawLine.startsWith('deleted file ')) {
      continue
    }
    if (rawLine.startsWith('@@')) {
      flushHunk()
      continue
    }

    const prefix = rawLine[0]
    if (prefix !== ' ' && prefix !== '-' && prefix !== '+') continue
    const body = rawLine.slice(1)
    hunkHasLines = true

    const isWorkflow = GATE_WORKFLOW_FILE_RE.test(currentFile)
    if (isWorkflow && prefix !== '-') {
      const trimmed = body.trim()
      const indent = body.length - body.trimStart().length
      if (permIndent >= 0 && trimmed !== '' && !trimmed.startsWith('#') && indent <= permIndent) {
        permIndent = -1
      }
      if (/^permissions\s*:/i.test(trimmed)) {
        permIndent = indent
      }
    }

    const isTest = GATE_TEST_FILE_RE.test(currentFile)
    if (prefix === '-') {
      if (isTest && !isCommentLine(body) && GATE_ASSERTION_RE.test(body)) {
        hunkRemovedAssertions += 1
      }
      continue
    }

    if (prefix === '+') {
      if (isTest && !isCommentLine(body)) {
        if (GATE_ASSERTION_RE.test(body)) hunkAddedAssertions += 1
        if (GATE_SKIP_RE.test(body)) {
          findings.push({ type: 'test-skip-or-only', file: currentFile, detail: body.trim().slice(0, 120) })
        }
      }
      if (isWorkflow && !isCommentLine(body)) {
        if (/\bcontinue-on-error\s*:\s*true\b/i.test(body)) {
          findings.push({ type: 'ci-continue-on-error', file: currentFile, detail: body.trim().slice(0, 120) })
        }
        if (/^\s*(?:-\s*)?if\s*:\s*(?:false\b|\$\{\{\s*false\s*\}\})/i.test(body)) {
          findings.push({ type: 'ci-disabled-step', file: currentFile, detail: body.trim().slice(0, 120) })
        }
        if (/\bpermissions\s*:\s*write-all\b/i.test(body)
          || ((/\bpermissions\s*:/i.test(body) || permIndent >= 0) && GATE_CI_PERM_WRITE_RE.test(body))) {
          findings.push({ type: 'ci-loosened-permissions', file: currentFile, detail: body.trim().slice(0, 120) })
        }
      }
      if (GATE_SHELL_OR_SCRIPT_RE.test(currentFile) && !isCommentLine(body) && GATE_SHELL_BYPASS_RE.test(body)) {
        findings.push({ type: 'shell-or-true', file: currentFile, detail: body.trim().slice(0, 120) })
      } else if (!isCommentLine(body) && /\b(?:exec|spawn|execSync|execFileSync|run)\w*\s*\([^)\n]*\|\|\s*true\b/.test(body)) {
        findings.push({ type: 'shell-or-true', file: currentFile, detail: body.trim().slice(0, 120) })
      }
    }
  }
  flushHunk()
  return findings
}

async function getChangedFiles(cwd, baseRef) {
  const set = new Set()
  if (baseRef) {
    const diffRes = await gitRun(cwd, ['diff', '--name-only', `${baseRef}..HEAD`])
    if (diffRes.ok && diffRes.stdout) {
      for (const l of diffRes.stdout.split('\n')) if (l.trim()) set.add(posixPath(l.trim()))
    }
  }
  const stRes = await gitRun(cwd, ['status', '--porcelain'])
  if (stRes.ok && stRes.stdout) {
    for (const l of stRes.stdout.split('\n')) {
      const f = l.slice(3).trim()
      if (f) set.add(posixPath(f.split(' -> ').pop()))
    }
  }
  return [...set].sort()
}

function findMatchingDoc(root, dirRel, ledger) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  try {
    const files = readdirSync(abs).filter((n) => n.endsWith('.md')).sort()
    const match = files.find((n) => n.includes(ledger.slug) || n.includes(ledger.taskId))
    return match ? `${dirRel}/${match}` : null
  } catch { return null }
}

function findUncheckedLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (/^- \[ \]/.test(line)) {
      const hasWaiver = /(?:<!--\s*waive:|\[waive:|豁免|跳过原因)/i.test(line)
      if (!hasWaiver) out.push(line.trim())
    }
  }
  return out
}

function buildTargetRepoContext(role, remoteUrls, declaredRepo) {
  const originFull = githubRepoFull(remoteUrls.origin ?? Object.values(remoteUrls)[0])
  const upstreamFull = githubRepoFull(remoteUrls.upstream)
  const originLower = originFull ? originFull.toLowerCase() : null
  const upstreamLower = upstreamFull ? upstreamFull.toLowerCase() : null
  const targetRepo = role === 'contributor-fork'
    ? (upstreamFull ?? declaredRepo ?? originFull)
    : originFull
  return { originFull, originLower, upstreamFull, upstreamLower, targetRepo }
}

// ── 子命令实现：inspect ────────────────────────────────────────────────

export async function inspectWorkspace(targetDir = process.cwd(), opts = {}) {
  const roots = await resolveRepoRoots(targetDir)
  const mainRoot = roots.mainRoot
  const workRoot = roots.workTreeRoot

  const [
    remoteRes, statusRes, headRes, logRes, userNameRes, userEmailRes, wtRes, conventions,
  ] = await Promise.all([
    roots.isGit ? gitRun(workRoot, ['remote', '-v']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['status', '--porcelain=v2', '--branch']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['rev-parse', 'HEAD']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['log', '--format=%an <%ae>', '-n', '100']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['config', '--get', 'user.name']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(workRoot, ['config', '--get', 'user.email']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? gitRun(mainRoot, ['worktree', 'list', '--porcelain']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? detectProjectConventions(mainRoot) : Promise.resolve({ defaultBranch: 'main', commitStyle: 'plain', hasDocsSystem: false }),
  ])

  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const status = parseStatusV2(statusRes.stdout)
  const head = headRes.ok && headRes.stdout ? headRes.stdout.trim() : null
  let commits = 0
  if (head && roots.isGit) {
    const cntRes = await gitRun(workRoot, ['rev-list', '--count', 'HEAD'])
    if (cntRes.ok && /^\d+$/.test(cntRes.stdout.trim())) commits = Number(cntRes.stdout.trim())
  }
  const historyAuthors = logRes.ok && logRes.stdout
    ? [...new Set(logRes.stdout.split('\n').filter(Boolean))]
    : []
  const gitIdentity = {
    name: userNameRes.ok ? userNameRes.stdout.trim() : undefined,
    email: userEmailRes.ok ? userEmailRes.stdout.trim() : undefined,
  }

  const profile = parseAgentsProfile(mainRoot)
  const declaredRepo = detectDeclaredRepo(mainRoot)
  const ghProbe = await probeGitHubEnv({
    cwd: mainRoot,
    remoteUrls,
    probeNetwork: Boolean(opts.probeAuth),
  })

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

  // 并发获取输入关联的 Issue / PR 详情及仓库 API 权限
  const shouldFetchRepoMeta = Boolean(opts.probeAuth) && originFull
    && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')

  const [repoMetaRes, fetchedIssues, fetchedPrs] = await Promise.all([
    shouldFetchRepoMeta ? ghProbe.client.getRepoMeta(originFull) : Promise.resolve(null),
    Promise.all(parsedInputs.issues.map(async (it) => {
      const targetRepo = it.repo ?? originFull
      if (targetRepo && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')) {
        const res = await ghProbe.client.getIssue(targetRepo, it.number)
        if (res.ok) return { ...it, ...res, fetched: true }
      }
      return { ...it, fetched: false, relations: { dependsOn: [], blocks: [], partOf: [], fixes: [], refs: [] } }
    })),
    Promise.all(parsedInputs.prs.map(async (pr) => {
      const targetRepo = pr.repo ?? originFull
      if (targetRepo && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')) {
        const res = await ghProbe.client.getPr(targetRepo, pr.number)
        if (res.ok) return { ...pr, ...res, fetched: true }
      }
      return { ...pr, fetched: false }
    })),
  ])

  let externalPr = opts.externalPr ? Number(opts.externalPr) : null
  if (!externalPr && fetchedPrs.length === 1 && fetchedPrs[0].fetched) {
    const p = fetchedPrs[0]
    const headRepoLower = p.headRepo ? p.headRepo.toLowerCase() : null
    const originLower = originFull ? originFull.toLowerCase() : null
    if (headRepoLower && originLower && headRepoLower !== originLower) {
      externalPr = p.number
    }
  }

  const identity = resolveWorkspaceIdentity({
    gitDir: roots.gitDir,
    remoteUrls,
    declaredRepo,
    gitIdentity,
    historyAuthors,
    commits,
    externalPr,
    apiProbe: repoMetaRes?.ok ? repoMetaRes : undefined,
  })

  // 检测 Issue + PR 同在时自动复用已有 PR 与分支
  let reuseExistingPr = null
  if (fetchedPrs.length > 0 && (fetchedIssues.length > 0 || fetchedPrs.length === 1)) {
    const pr = fetchedPrs[0]
    if (fetchedIssues.length > 0 || (pr.fetched && !externalPr)) {
      reuseExistingPr = {
        prNumber: pr.number,
        branch: pr.headBranch ?? null,
        baseBranch: pr.baseBranch ?? null,
        url: pr.url ?? pr.raw,
        linkedIssues: fetchedIssues.map((i) => i.number),
        note: '检测到已有 PR（与 Issue 关联），请直接复用该 PR 与原分支，禁止新开第二个 PR',
      }
    }
  }

  const issueGraph = analyzeIssueDependencies(fetchedIssues)

  return {
    isGit: roots.isGit,
    mainRoot,
    workTreeRoot: workRoot,
    isWorktree: roots.isWorktree,
    branch: status.branch,
    head,
    commits,
    dirty: status.dirty,
    defaultBranch: conventions.defaultBranch,
    commitStyle: conventions.commitStyle,
    hasDocsSystem: conventions.hasDocsSystem,
    declaredRepo: declaredRepo ?? null,
    remoteUrls,
    gitIdentity,
    identity,
    github: ghProbe.env,
    devProfile: {
      hasAgents: profile.hasAgents,
      quickTest: profile.quickTest ?? null,
      fullTest: profile.fullTest ?? null,
      smokeVerify: profile.smokeVerify ?? null,
      mergeGate: profile.mergeGate ?? null,
      archRules: profile.archRules,
      highRisk: profile.highRisk,
      doNotEdit: profile.doNotEdit,
      mergeAuthority: profile.mergeAuthority,
    },
    worktrees: parseWorktreeList(wtRes.stdout),
    activeTasks: listTaskLedgers(mainRoot).map((t) => ({
      taskId: t.taskId,
      slug: t.slug,
      status: t.status,
      branch: t.branch,
      worktreePath: t.worktreePath,
      prNumber: t.prNumber,
    })),
    inputs: {
      issues: fetchedIssues,
      prs: fetchedPrs,
      unknown: parsedInputs.unknown,
      reuseExistingPr,
      issueGraph,
    },
  }
}

// ── 子命令实现：start ──────────────────────────────────────────────────

async function handleStart(opts, roots) {
  if (!roots.isGit) {
    throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  }
  const taskId = sanitizeTaskId(opts.task)
  const caseType = opts.case !== undefined ? Number(opts.case) : 3
  if (caseType === 5) {
    process.stderr.write('BLOCKED_CASE_5_TDD_CONFLICT: 需求与 docs/TDD.md 或生效 SPEC 冲突，请先更新 TDD.md 并获批后再开工。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const slug = slugify(opts.slug ?? taskId)
  const externalPr = opts['external-pr'] ? Number(opts['external-pr']) : null
  const prNumber = externalPr ?? (opts.pr ? Number(opts.pr) : null)
  const linkedIssues = opts.issue || opts.issues
    ? String(opts.issues ?? opts.issue).split(',').map((s) => Number(s.replace(/^#/, '').trim())).filter(Number.isInteger)
    : []

  const state = await inspectWorkspace(roots.mainRoot, { externalPr, pr: prNumber })
  let role = state.identity.role

  // clone-readonly 必须停下给三选一或接收 --clone-choice 迁移状态
  if (role === 'clone-readonly' && !externalPr) {
    const choice = opts['clone-choice']
    if (!choice) {
      const guidance = {
        blocked: true,
        code: 'ACTION_REQUIRED_CLONE_CHOICE',
        reason: state.identity.reason,
        choices: [
          { choice: 'fork', desc: '作为贡献者 Fork 协同：配置 upstream 与个人 Fork origin，按 contributor-fork 开跨仓 PR' },
          { choice: 'standalone', desc: '作为独立个人仓库继续：写入 .git/pf-standalone-mode，按 maintainer 运作' },
          { choice: 'local', desc: '仅本地使用不推远端：写入 .git/pf-local-mode，按 local-only 运作' },
        ],
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(guidance, null, 2)}\n`)
      } else {
        process.stdout.write(`停下确认：检测到当前仓库为只读克隆（${state.identity.reason}）。请选择协作方式：\n`)
        for (const c of guidance.choices) {
          process.stdout.write(`  --clone-choice ${c.choice.padEnd(10)} : ${c.desc}\n`)
        }
        printNextStep([
          `重新运行带上选择：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskId} --clone-choice <fork|standalone|local>`,
        ])
      }
      return { exitCode: EXIT_ACTION_REQUIRED }
    }

    if (choice === 'local') {
      writeAtomic(join(roots.gitDir, 'pf-local-mode'), `enabled at ${new Date().toISOString()}\n`)
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
    } else {
      throw new Error(`--clone-choice 仅支持 fork | standalone | local，收到：${choice}`)
    }
  }

  // 检查是否已存在幂等账本
  const existing = readTaskLedger(roots.mainRoot, taskId)
  if (existing && (
    (existing.worktreePath && existsSync(join(roots.mainRoot, existing.worktreePath)))
    || (existing.reviewWorktreePath && existsSync(join(roots.mainRoot, existing.reviewWorktreePath)))
    || existing.isolation === 'branch'
  )) {
    if (opts.todo) existing.todoFile = opts.todo
    if (opts.spec) existing.specFile = opts.spec
    if (opts.prd) existing.prdFile = opts.prd
    if (linkedIssues.length > 0) existing.linkedIssues = [...new Set([...existing.linkedIssues, ...linkedIssues])]
    if (prNumber && !existing.prNumber) existing.prNumber = prNumber
    writeTaskLedger(roots.mainRoot, existing)
    if (opts.json) process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`)
    else {
      process.stdout.write(`任务 ${taskId} 已存在（幂等复用）：isolation=${existing.isolation}, branch=${existing.branch ?? 'detached'}\n`)
      printNextStep(['继续在该工作位实施，完成后运行 flow.mjs finalize 与 verify。'])
    }
    return { exitCode: 0 }
  }

  const baseBranch = state.defaultBranch || 'main'
  const baseSha = state.head
  const implementerId = opts.implementer
    ?? (state.gitIdentity.name ? `${state.gitIdentity.name}${state.gitIdentity.email ? ` <${state.gitIdentity.email}>` : ''}` : 'implementer')

  await ensureWorktreesIgnored(roots.mainRoot, roots.gitDir)

  // 第 3 档：外部 PR 只读隔离审阅
  if (externalPr) {
    const reviewRel = `.worktrees/review-pr-${externalPr}`
    const reviewAbs = join(roots.mainRoot, reviewRel)
    let targetSha = opts['pr-ref'] ?? null

    if (!targetSha) {
      const fetchRes = await gitRun(roots.mainRoot, ['fetch', 'origin', `pull/${externalPr}/head`])
      if (fetchRes.ok) {
        const fh = await gitRun(roots.mainRoot, ['rev-parse', 'FETCH_HEAD'])
        if (fh.ok) targetSha = fh.stdout.trim()
      } else {
        const localRef = await gitRun(roots.mainRoot, ['rev-parse', '--verify', `refs/pull/${externalPr}/head`])
        if (localRef.ok) targetSha = localRef.stdout.trim()
      }
    }
    if (!targetSha) {
      throw new Error(`无法拉取外部 PR #${externalPr} 的提交（请确认 origin 可访问或通过 --pr-ref 指定本地测试 ref）`)
    }

    if (!existsSync(reviewAbs)) {
      const wtAdd = await gitRun(roots.mainRoot, ['worktree', 'add', '--detach', reviewAbs, targetSha])
      if (!wtAdd.ok) throw new Error(`创建外部 PR 审查位失败：${wtAdd.stderr}`)
    }

    const ledger = createDefaultLedger({
      taskId,
      slug,
      caseType,
      tier: 3,
      isolation: 'review-pr',
      role: 'inbound-external-pr',
      branch: null,
      baseBranch,
      baseSha: baseSha ?? targetSha,
      worktreePath: null,
      reviewWorktreePath: reviewRel,
      linkedIssues,
      prNumber: externalPr,
      implementerId: `external-pr-${externalPr}`,
      status: 'review-ready',
    })
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`已建立外部 PR 审查隔离位：${reviewRel}（detached @ ${targetSha.slice(0, 7)}，未挂载任何依赖）\n`)
      printNextStep([
        `先运行静态投毒扫描后再决定是否安装或运行测试：node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${externalPr} --untrusted-scan`,
      ])
    }
    return { exitCode: 0 }
  }

  const branchPrefix = caseType === 2 ? 'fix' : caseType === 1 ? 'docs' : 'feat'
  const branch = opts.branch || `${branchPrefix}/${slug}`
  const filesCount = opts.files !== undefined ? Number(opts.files) : undefined
  const forceWorktree = Boolean(opts.parallel)
    || caseType >= 3
    || linkedIssues.length > 0
    || state.dirty > 0
    || (filesCount !== undefined && filesCount >= 4)

  // 第 1 档：L1 且主仓干净且非并行/无关联 Issue -> 原地切分支
  if (!forceWorktree || state.commits === 0) {
    if (Boolean(opts.parallel) && state.commits === 0) {
      throw new Error('仓库尚无初始提交，无法使用 worktree 并行隔离；请先提交至少一个初始化提交')
    }
    const hasBranch = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    const sw = hasBranch.ok
      ? await gitRun(roots.mainRoot, ['switch', branch])
      : await gitRun(roots.mainRoot, ['switch', '-c', branch])
    if (!sw.ok) throw new Error(`切换分支 ${branch} 失败：${sw.stderr}`)

    const ledger = createDefaultLedger({
      taskId,
      slug,
      caseType,
      tier: 1,
      isolation: 'branch',
      role,
      branch,
      baseBranch,
      baseSha,
      worktreePath: null,
      reviewWorktreePath: `.worktrees/review-${taskId}`,
      todoFile: opts.todo ?? existing?.todoFile ?? null,
      specFile: opts.spec ?? existing?.specFile ?? null,
      prdFile: opts.prd ?? existing?.prdFile ?? null,
      linkedIssues,
      prNumber,
      implementerId,
      status: 'started',
    })
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`任务 ${taskId} 已就绪（Tier 1 分支模式）：branch=${branch}, role=${role}\n`)
      printNextStep([
        caseType === 2
          ? '1. 先编写失败复现测试并运行变红，再修改实现转绿。'
          : '1. 完成修改并验证。',
        `2. 跑验证锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}`,
      ])
    }
    return { exitCode: 0 }
  }

  // 第 2 档：Worktree 隔离 + 秒挂共享依赖 + 预分配 review 复用槽
  const implRel = `.worktrees/impl-${taskId}`
  const reviewRel = `.worktrees/review-${taskId}`
  const implAbs = join(roots.mainRoot, implRel)
  const reviewAbs = join(roots.mainRoot, reviewRel)

  if (!existsSync(implAbs)) {
    const hasBranch = await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    const addArgs = hasBranch.ok
      ? ['worktree', 'add', implAbs, branch]
      : ['worktree', 'add', '-b', branch, implAbs, baseSha]
    const wtRes = await gitRun(roots.mainRoot, addArgs)
    if (!wtRes.ok) throw new Error(`创建实施 worktree 失败：${wtRes.stderr}`)
  }

  if (!existsSync(reviewAbs)) {
    const revRes = await gitRun(roots.mainRoot, ['worktree', 'add', '--detach', reviewAbs, baseSha])
    if (!revRes.ok) throw new Error(`预分配审查复用槽失败：${revRes.stderr}`)
  }

  const depMount = mountSharedDeps(roots.mainRoot, implAbs)

  const ledger = createDefaultLedger({
    taskId,
    slug,
    caseType,
    tier: 2,
    isolation: 'worktree',
    role,
    branch,
    baseBranch,
    baseSha,
    worktreePath: implRel,
    reviewWorktreePath: reviewRel,
    depsMode: depMount.mode,
    todoFile: opts.todo ?? null,
    specFile: opts.spec ?? null,
    prdFile: opts.prd ?? null,
    linkedIssues,
    prNumber,
    implementerId,
    status: 'started',
  })
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...ledger, depsMount: depMount }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已就绪（Tier 2 Worktree 模式）：\n`)
    process.stdout.write(`- 实施位: ${implRel}（分支: ${branch}，依赖模式: ${depMount.mode}）\n`)
    process.stdout.write(`- 审查槽: ${reviewRel}（已预分配复用槽）\n`)
    process.stdout.write(`- 角色: ${role} | 基线: ${baseBranch}@${(baseSha ?? '').slice(0, 7)}\n`)
    printNextStep([
      linkedIssues.length > 0 && role !== 'local-only'
        ? `先认领 Issue：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId}`
        : `在 ${implRel} 中推进实施（Case ${caseType} 如缺 Todo 请先 doc-plan.mjs init）`,
    ])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：claim ──────────────────────────────────────────────────

async function handleClaim(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}（请先运行 flow.mjs start）`)

  if (opts.issue) {
    const extra = String(opts.issue).split(',').map((s) => Number(s.replace(/^#/, '').trim())).filter(Number.isInteger)
    ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extra])]
  }
  const actor = opts.agent ?? ledger.implementerId ?? 'local-agent'
  if (!ledger.implementerId) ledger.implementerId = actor

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const claimResults = []
  if (ledger.role === 'local-only' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo) {
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    writeTaskLedger(roots.mainRoot, ledger)
    const out = { taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status }
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰远端）。\n`)
      printNextStep([`在工作区推进实现，完成后运行 flow.mjs finalize --task ${taskId}`])
    }
    return { exitCode: 0 }
  }

  const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
  for (const num of ledger.linkedIssues) {
    const body = `认领：由 ${actor} 在分支 \`${ledger.branch}\` 开始处理（task: \`${taskId}\`）。`
    const commentRes = await ghProbe.client.postComment({
      repo: targetRepo,
      number: num,
      body,
      statePayload: { taskId, action: 'claim', branch: ledger.branch },
    })
    // contributor-fork 无写权限时写标签遇 403 自动降级跳过，不抛错
    const labelRes = await ghProbe.client.addLabels({
      repo: targetRepo,
      number: num,
      labels: ['in-progress'],
    })
    claimResults.push({ issue: num, comment: commentRes, label: labelRes })
  }

  ledger.status = 'claimed'
  ledger.claimedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, targetRepo, claimResults }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已认领（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    for (const r of claimResults) {
      if (r.label?.skipped) process.stdout.write(`- Issue #${r.issue} 标签降级跳过（${r.label.reason}），已保留本地状态与评论动作。\n`)
      if (r.comment?.delegated) process.stdout.write(`- 待宿主 MCP 代理发帖载荷：${JSON.stringify(r.comment.jsonPayload)}\n`)
    }
    printNextStep([`实施完成后运行：node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：finalize ───────────────────────────────────────────────

async function handleFinalize(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null

  // contributor-fork：若上游仓库并未接入 docs/ 体系，严禁把本地私有 docs/ 草稿混入 PR diff
  if (ledger.role === 'contributor-fork') {
    const baseRef = ledger.baseSha || ledger.baseBranch || 'HEAD'
    const baseTree = await gitRun(implRoot, ['ls-tree', '-r', '--name-only', baseRef, '--', 'docs/'])
    const baseDocs = baseTree.ok ? baseTree.stdout.split('\n').filter(Boolean) : []
    const upstreamUsesDocs = baseDocs.some((p) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/)/.test(p))

    if (!upstreamUsesDocs) {
      const committedDiff = ledger.baseSha
        ? await gitRun(implRoot, ['diff', '--name-only', `${ledger.baseSha}..HEAD`])
        : { ok: false, stdout: '' }
      const committedDocs = (committedDiff.stdout || '').split('\n')
        .filter((f) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/|archive\/todo\/)/.test(f.trim()))
      if (committedDocs.length > 0) {
        process.stderr.write(`BLOCKED_FORK_PRIVATE_DOCS: 上游仓未接入 docs/ 体系，以下私有规划文件不应混入 Fork PR 提交：${committedDocs.join(', ')}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }

      // 先校验本地私有 Todo / SPEC 无未勾选条，再安全移出到 .worktrees/.state/private-docs/<taskId>/ 保留
      for (const relDoc of [ledger.todoFile, ledger.specFile].filter(Boolean)) {
        const docPath = join(implRoot, relDoc)
        if (!existsSync(docPath)) continue
        const unchecked = findUncheckedLines(readTextSafe(docPath) ?? '')
        if (unchecked.length > 0) {
          process.stderr.write(`BLOCKED_UNCHECKED_DOC: ${relDoc} 仍有未勾选验收条目：\n`)
          for (const u of unchecked) process.stderr.write(`  ${u}\n`)
          return { exitCode: 1 }
        }
      }

      const privateKeepDir = join(roots.mainRoot, '.worktrees', '.state', 'private-docs', taskId)
      const relocated = []
      for (const relDoc of [ledger.todoFile, ledger.specFile, ledger.prdFile].filter(Boolean)) {
        const src = join(implRoot, relDoc)
        if (!existsSync(src)) continue
        await gitRun(implRoot, ['reset', '--', relDoc])
        mkdirSync(privateKeepDir, { recursive: true })
        renameSync(src, join(privateKeepDir, basename(relDoc)))
        relocated.push(relDoc)
      }

      ledger.finalized = true
      ledger.finalizedHead = currentHead
      ledger.status = 'finalized'
      writeTaskLedger(roots.mainRoot, ledger)
      const res = {
        taskId,
        role: ledger.role,
        upstreamUsesDocs: false,
        privateDocsIsolated: true,
        relocatedPrivateDocs: relocated,
        finalizedHead: currentHead,
      }
      if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`Fork finalize 完成（上游未接入 docs/，已确保不污染 PR diff）。\n`)
        printNextStep([`运行验证锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}`])
      }
      return { exitCode: 0 }
    }
  }

  // 检查并归档 Todo
  let todoRel = ledger.todoFile || findMatchingDoc(implRoot, 'docs/todo', ledger)
  if (todoRel && existsSync(join(implRoot, todoRel))) {
    const todoText = readTextSafe(join(implRoot, todoRel)) ?? ''
    const unchecked = findUncheckedLines(todoText)
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_TODO: ${todoRel} 仍有未勾选验收条目，请全部勾为 [x] 或注明豁免原因后再 finalize：\n`)
      for (const u of unchecked) process.stderr.write(`  ${u}\n`)
      return { exitCode: 1 }
    }

    if (todoRel.startsWith('docs/todo/')) {
      const archiveRel = `docs/archive/todo/${basename(todoRel)}`
      mkdirSync(join(implRoot, 'docs', 'archive', 'todo'), { recursive: true })
      const tracked = await gitRun(implRoot, ['ls-files', '--error-unmatch', todoRel])
      if (tracked.ok) {
        const mv = await gitRun(implRoot, ['mv', todoRel, archiveRel])
        if (!mv.ok) throw new Error(`归档 Todo 失败：${mv.stderr}`)
      } else {
        renameSync(join(implRoot, todoRel), join(implRoot, archiveRel))
      }
      todoRel = archiveRel
      ledger.todoFile = archiveRel
      ledger.archivedTodoFile = archiveRel
    }
  }

  // 检查并更新 SPEC 为 implemented + 核验「实现说明」
  const specRel = ledger.specFile || findMatchingDoc(implRoot, 'docs/specs', ledger)
  if (specRel && existsSync(join(implRoot, specRel))) {
    const specAbs = join(implRoot, specRel)
    let specText = readTextSafe(specAbs) ?? ''
    const unchecked = findUncheckedLines(specText)
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_SPEC: ${specRel} 仍有未勾选标准，无法标记为 implemented：\n`)
      for (const u of unchecked) process.stderr.write(`  ${u}\n`)
      return { exitCode: 1 }
    }

    specText = specText.replace(/^(-\s+Status:\s*)(?:draft|approved|implemented)(\s*)$/mi, '$1implemented$2')
    if (!/^##\s+实现说明\s*$/m.test(specText)) {
      specText = `${specText.trimEnd()}\n\n## 实现说明\n\n`
    }

    // 核验「实现说明」节是否包含真实内容或未清理占位
    const secStart = specText.search(/^##\s+实现说明\s*$/m)
    const afterSec = specText.slice(secStart)
    const nextHeading = afterSec.slice(1).search(/\n##\s+/)
    const secBody = (nextHeading > 0 ? afterSec.slice(0, nextHeading + 1) : afterSec)
      .replace(/^##\s+实现说明\s*\n?/, '')
    if (/<!--\s*project-forge:\s*fill|\b(?:TBD|TODO|FIXME)\b/i.test(secBody)) {
      process.stderr.write(`BLOCKED_SPEC_IMPL_NOTE_EMPTY: ${specRel} 的「实现说明」仍含未填占位，请补齐真实说明后再 finalize。\n`)
      return { exitCode: 1 }
    }
    const meaningful = secBody.replace(/<!--[\s\S]*?-->/g, '').trim()
    if (!meaningful) {
      const autoSummary = [
        `- 实现提交基线: ${currentHead ?? 'uncommitted'}`,
        `- 关联任务: ${taskId}`,
        opts.note ? `- 说明: ${opts.note}` : null,
      ].filter(Boolean).join('\n')
      specText = specText.replace(
        /(^##\s+实现说明\s*\n(?:<!--[\s\S]*?-->\s*\n?)?)/m,
        `$1\n${autoSummary}\n`,
      )
    }
    writeAtomic(specAbs, specText)
    ledger.specFile = specRel
  }

  // 代码-文档一致性强提醒
  const changed = await getChangedFiles(implRoot, ledger.baseSha)
  const touchedCodeEntry = changed.some((f) => /^(?:src|lib|scripts|kit|bin|cmd)\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$|index\./i.test(f))
  const touchedAnyDoc = changed.some((f) => /^(?:docs\/TDD\.md|README(?:\.[a-z0-9_-]+)?\.md|AGENTS\.md)$/i.test(f))
  const docParityReminder = touchedCodeEntry && !touchedAnyDoc

  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  writeTaskLedger(roots.mainRoot, ledger)

  const out = {
    taskId,
    finalized: true,
    finalizedHead: currentHead,
    todoFile: ledger.todoFile,
    specFile: ledger.specFile,
    docParityReminder,
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  } else {
    process.stdout.write(`finalize 完成：HEAD=${currentHead ?? 'uncommitted'}，Todo=${ledger.todoFile ?? '无'}，SPEC=${ledger.specFile ?? '无'}\n`)
    if (docParityReminder) {
      process.stdout.write('[DOC PARITY REMINDER]: 本次改动涉及代码入口/导出/清单，但未见 docs/TDD.md、README.md 或 AGENTS.md 同步更新，请确认文档是否需要一起补齐。\n')
    }
    printNextStep([
      '1. 若 finalize 移动或更新了文档，先在工作区提交变更：git add -A && git commit -m "..."',
      `2. 运行实证门禁锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}`,
    ])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：verify ─────────────────────────────────────────────────

async function handleVerify(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const profile = parseAgentsProfile(implRoot)
  const mode = opts.mode ?? 'quick'
  if (!['quick', 'smoke', 'full', 'gate'].includes(mode)) {
    process.stderr.write(`INVALID_VERIFY_MODE: --mode 仅支持 quick | smoke | full | gate，收到：${mode}\n`)
    return { exitCode: 1 }
  }
  let rawTarget = opts.target !== undefined ? String(opts.target).trim() : null
  if (rawTarget !== null) {
    if (!rawTarget || /[;&|`$><\r\n]/.test(rawTarget)) {
      process.stderr.write(`INVALID_TARGET_ARG: --target 值非法或含不允许的元字符：${opts.target}\n`)
      return { exitCode: 1 }
    }
    rawTarget = posixPath(rawTarget)
  }

  let cmd = opts.cmd
  if (!cmd) {
    if (mode === 'gate') cmd = profile.mergeGate ?? profile.fullTest ?? profile.quickTest
    else if (mode === 'full') cmd = profile.fullTest ?? profile.quickTest
    else if (mode === 'smoke') cmd = profile.smokeVerify
    else cmd = profile.quickTest
  }
  if (!cmd) {
    process.stderr.write(`NO_VERIFY_COMMAND: 未从 AGENTS.md Dev Profile 或项目清单识别到 ${mode} 验证命令，请通过 --cmd "<命令>" 显式传入。\n`)
    return { exitCode: 1 }
  }
  if (cmd.includes('{target}')) {
    if (!rawTarget) {
      process.stderr.write(`MISSING_TARGET_ARG: 验证命令 "${cmd}" 含 {target} 占位符，请追加 --target <file> 指定单测文件或用例。\n`)
      return { exitCode: 1 }
    }
    cmd = cmd.replace(/\{target\}/g, rawTarget)
  }

  const runRes = await execShellCommand(cmd, implRoot)
  const [headRes, stRes] = await Promise.all([
    gitRun(implRoot, ['rev-parse', 'HEAD']),
    gitRun(implRoot, ['status', '--porcelain']),
  ])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null

  ledger.verifiedHead = runRes.ok ? currentHead : null
  ledger.verifiedCmd = cmd
  ledger.verifiedMode = mode
  ledger.verifiedTarget = rawTarget
  ledger.verifiedDirtyHash = sha256Text(stRes.stdout)
  ledger.lastVerifyExitCode = runRes.code
  ledger.status = runRes.ok ? 'verified' : 'verify-failed'
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      taskId,
      mode,
      target: rawTarget,
      cmd,
      ok: runRes.ok,
      exitCode: runRes.code,
      verifiedHead: ledger.verifiedHead,
      stdout: runRes.stdout,
      stderr: runRes.stderr,
    }, null, 2)}\n`)
  } else {
    if (runRes.stdout) process.stdout.write(`${runRes.stdout}\n`)
    if (runRes.stderr) process.stderr.write(`${runRes.stderr}\n`)
    process.stdout.write(`verify (${mode}${rawTarget ? ` target=${rawTarget}` : ''}): cmd="${cmd}" exit=${runRes.code} HEAD=${currentHead ?? 'none'}\n`)
    if (runRes.ok) {
      printNextStep([
        `证据已绑定到 HEAD ${currentHead?.slice(0, 7)}，可提交评审：node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}`,
      ])
    } else {
      printNextStep([
        `验证未通过（exit=${runRes.code}），请修复后重新运行 verify。`,
      ])
    }
  }
  return { exitCode: runRes.ok ? 0 : (runRes.code || 1) }
}

// ── 子命令实现：submit ─────────────────────────────────────────────────

async function handleSubmit(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const [headRes, stRes] = await Promise.all([
    gitRun(implRoot, ['rev-parse', 'HEAD']),
    gitRun(implRoot, ['status', '--porcelain']),
  ])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null

  if (stRes.stdout.trim() !== '') {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 存在未提交改动，请先提交后再运行 verify 与 submit。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const needsFinalize = ledger.caseType === 3 || ledger.caseType === 4 || Boolean(ledger.todoFile) || Boolean(ledger.specFile)
  if (needsFinalize) {
    if (!ledger.finalized) {
      process.stderr.write(`BLOCKED_NOT_FINALIZED: Case ${ledger.caseType} 任务必须先执行 flow.mjs finalize --task ${taskId} 完成文档同步锁。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (ledger.finalizedHead && currentHead && ledger.finalizedHead !== currentHead) {
      const postFin = await gitRun(implRoot, ['diff', '--name-only', `${ledger.finalizedHead}..${currentHead}`])
      const nonDocChanges = (postFin.stdout || '').split('\n').filter((f) => f.trim() && !/^docs\//.test(f.trim()))
      if (nonDocChanges.length > 0) {
        process.stderr.write(`BLOCKED_STALE_FINALIZE: finalize 之后又改了非文档文件（${nonDocChanges.join(', ')}），请重新运行 finalize。\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
  }

  if (!ledger.verifiedHead || ledger.lastVerifyExitCode !== 0) {
    process.stderr.write(`BLOCKED_NOT_VERIFIED: 提交前必须先运行并通过 flow.mjs verify --task ${taskId}。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (ledger.verifiedHead !== currentHead) {
    process.stderr.write(`BLOCKED_STALE_VERIFICATION: 代码已变更（verifiedHead=${ledger.verifiedHead.slice(0, 7)} !== HEAD=${currentHead?.slice(0, 7)}），必须重跑 verify。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  if (ledger.role === 'clone-readonly') {
    process.stderr.write('BLOCKED_CLONE_READONLY: 当前身份为只读克隆，禁止推送；请先走 Fork 或本地模式。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  if (ledger.role === 'local-only') {
    ledger.status = 'local-ready'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`)
    else {
      process.stdout.write(`本地模式提交校验已通过（HEAD=${currentHead?.slice(0, 7)}，未配置远端不执行 push）。\n`)
      printNextStep([
        `如需独立审查后合并到本地主干，可先运行：node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round 1`,
      ])
    }
    return { exitCode: 0 }
  }

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, originLower, upstreamLower, targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  // contributor-fork 硬锁：只允许 push 到 origin，绝不允许 push 到 upstream
  if (ledger.role === 'contributor-fork' && originLower && upstreamLower && originLower === upstreamLower) {
    process.stderr.write('BLOCKED_FORK_REMOTE_LOCK: origin 与 upstream 指向相同仓，禁止直接向正本推送。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const pushRes = await gitRun(implRoot, ['push', '-u', 'origin', ledger.branch])
  if (!pushRes.ok) {
    throw new Error(`推送到 origin/${ledger.branch} 失败：${pushRes.stderr}`)
  }

  const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
  const isRework = Boolean(opts.rework) || Boolean(ledger.prNumber)
  const shortHead = currentHead?.slice(0, 7) ?? 'unknown'
  const fixesLine = (ledger.linkedIssues ?? []).map((n) => `Fixes #${n}`).join('\n')
  const originOwner = originFull ? originFull.split('/')[0] : null
  const headSpec = ledger.role === 'contributor-fork' && originOwner
    ? `${originOwner}:${ledger.branch}`
    : ledger.branch

  let prResult = null
  const commentResults = []

  if (isRework && ledger.prNumber && targetRepo) {
    const reworkMsg = [
      `返工已提交：新 HEAD \`${shortHead}\``,
      `- 验证命令：\`${ledger.verifiedCmd}\`（退出码 0）`,
      '- 请重新审核（未修改原分支，更新同一 PR）。',
    ].join('\n')
    prResult = { reusedPr: ledger.prNumber, head: shortHead }
    commentResults.push({
      target: `PR #${ledger.prNumber}`,
      res: await ghProbe.client.postComment({
        repo: targetRepo,
        number: ledger.prNumber,
        body: reworkMsg,
        statePayload: { taskId, action: 'rework-submitted', headSha: currentHead },
      }),
    })
    for (const iss of ledger.linkedIssues ?? []) {
      commentResults.push({
        target: `Issue #${iss}`,
        res: await ghProbe.client.postComment({
          repo: targetRepo,
          number: iss,
          body: `${reworkMsg}\n- 关联 PR: #${ledger.prNumber}`,
          statePayload: { taskId, action: 'rework-submitted', prNumber: ledger.prNumber, headSha: currentHead },
        }),
      })
    }
  } else if (targetRepo) {
    const title = opts.title ?? `${ledger.caseType === 2 ? 'fix' : 'feat'}: ${ledger.slug}`
    const body = opts.body ?? [
      '## 改动说明',
      `- 任务编号：\`${taskId}\``,
      `- 验证命令：\`${ledger.verifiedCmd}\` @ \`${shortHead}\``,
      fixesLine ? `\n${fixesLine}` : null,
      '',
      '## 实现依据',
      `- role=${ledger.role}, case=${ledger.caseType}, isolation=${ledger.isolation}`,
    ].filter((x) => x !== null).join('\n')

    prResult = await ghProbe.client.createPr({
      targetRepo,
      head: headSpec,
      base: ledger.baseBranch,
      title,
      body,
      draft: Boolean(opts.draft),
    })
    if (prResult.ok && prResult.number) {
      ledger.prNumber = prResult.number
      ledger.prUrl = prResult.url ?? null
      for (const iss of ledger.linkedIssues ?? []) {
        commentResults.push({
          target: `Issue #${iss}`,
          res: await ghProbe.client.postComment({
            repo: targetRepo,
            number: iss,
            body: `已提 PR：#${prResult.number}${prResult.url ? ` (${prResult.url})` : ''}\nFixes #${iss}`,
            statePayload: { taskId, action: 'pr-created', prNumber: prResult.number },
          }),
        })
      }
    }
  }

  ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, status: ledger.status, head: currentHead, prResult, commentResults }, null, 2)}\n`)
  } else {
    process.stdout.write(`submit 完成：已推分支 origin/${ledger.branch} @ ${shortHead}，状态=${ledger.status}\n`)
    if (prResult?.oneClickPrUrl) process.stdout.write(`- 一键创建 PR 链接：${prResult.oneClickPrUrl}\n`)
    if (prResult?.delegated) process.stdout.write(`- 待宿主 MCP 代理执行 PR 载荷：${JSON.stringify(prResult.jsonPayload)}\n`)
    printNextStep([
      ledger.role === 'contributor-fork'
        ? '当前处于 awaiting-upstream-merge，请等待上游维护者合并；合并前严禁删除该 Fork 分支。'
        : `下一步派发独立审查：node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round 1`,
    ])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：rework ─────────────────────────────────────────────────

async function handleRework(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const profile = parseAgentsProfile(implRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)

  const forbiddenTouched = changed.filter((f) => profile.doNotEdit.some((pat) => matchGlob(f, pat)))
  const rebutsInput = Array.isArray(opts.rebut) ? opts.rebut : (opts.rebut ? [opts.rebut] : [])
  const addedRebuts = []

  for (const raw of rebutsInput) {
    const idx = raw.indexOf(':')
    const findingId = idx > 0 ? raw.slice(0, idx).trim() : 'general'
    const reason = idx > 0 ? raw.slice(idx + 1).trim() : raw.trim()
    const item = { findingId, reason, recordedAt: new Date().toISOString() }
    addedRebuts.push(item)
    ledger.rebuts = [...(ledger.rebuts ?? []), item]
    if ((ledger.rounds ?? []).length > 0) {
      const last = ledger.rounds[ledger.rounds.length - 1]
      last.rebuts = [...(last.rebuts ?? []), item]
    }
  }

  ledger.status = 'rework'
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, branch: ledger.branch, prNumber: ledger.prNumber, forbiddenTouched, addedRebuts }, null, 2)}\n`)
  } else {
    process.stdout.write(`进入返工模式（task=${taskId}，原分支=${ledger.branch}，原 PR=${ledger.prNumber ?? '待创建'}）：\n`)
    process.stdout.write('- 纪律：严禁顺手重排无关文件；禁止新建第二条分支或第二个 PR；仅针对未关闭 Must Fix 追加提交。\n')
    if (forbiddenTouched.length > 0) {
      process.stdout.write(`- 警告：以下变更命中 do-not-edit 列表：${forbiddenTouched.join(', ')}\n`)
    }
    if (addedRebuts.length > 0) {
      process.stdout.write(`- 已记录 ${addedRebuts.length} 条有据反驳。\n`)
    }
    printNextStep([
      `1. 追加修复提交后重新锁定验证：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}`,
      `2. 更新原 PR 与 Issue 状态：node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --rework`,
    ])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：merge ──────────────────────────────────────────────────

async function handleMerge(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  if (ledger.role === 'contributor-fork') {
    process.stderr.write('BLOCKED_FORK_CANNOT_MERGE: contributor-fork 无权合并上游仓库 PR，请等待上游维护者合并。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }
  if (ledger.role === 'clone-readonly' || ledger.role === 'undetermined') {
    process.stderr.write(`BLOCKED_ROLE_CANNOT_MERGE: 当前身份为 ${ledger.role}，不允许执行合并。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null

  if (!ledger.verifiedHead || ledger.verifiedHead !== currentHead || ledger.lastVerifyExitCode !== 0) {
    process.stderr.write('BLOCKED_NOT_VERIFIED: 合并前必须有匹配当前 HEAD 的实证通过记录。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const profile = parseAgentsProfile(roots.mainRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)
  const highRiskHits = changed.filter((f) => profile.highRisk.some((pat) => matchGlob(f, pat)))
  const rounds = ledger.rounds ?? []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const effectiveReviewer = lastRound?.reviewerId ?? ledger.reviewerId

  const gateFindings = await detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch)
  if (gateFindings.length > 0 && !opts['human-approved']) {
    const doorInfo = classifyDoorType({
      changedFiles: changed,
      highRisk: profile.highRisk,
      gateWeakened: true,
    })
    const summary = gateFindings.map((f) => `[${f.type}] ${f.file}: ${f.detail}`).join('; ')
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        blocked: true,
        code: 'BLOCKED_GATE_WEAKENING',
        doorType: doorInfo.doorType,
        findings: gateFindings,
        nextStep: `请向人类报告上述门禁弱化发现，获准后再附 --human-approved 重试 merge`,
      }, null, 2)}\n`)
    } else {
      process.stderr.write(`BLOCKED_GATE_WEAKENING (one-way door): 检测到门禁弱化改动，须人类确认：${summary}\n`)
      printNextStep([
        '请向人类说明上述每一处门禁弱化理由与风险，取得明确同意后重新运行：',
        `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId} --human-approved`,
      ])
    }
    return { exitCode: EXIT_ACTION_REQUIRED }
  }

  if (highRiskHits.length > 0 || rounds.length > 0 || ledger.caseType >= 3) {
    if (!effectiveReviewer || effectiveReviewer === ledger.implementerId) {
      process.stderr.write(
        `BLOCKED_REQUIRES_INDEPENDENT_REVIEW: 触碰高风险路径或需独立审查（hits=${highRiskHits.join(',') || 'L2/L3'}），`
        + `必须存在 reviewerId !== implementerId 的独立审查 PASS 记录。\n`,
      )
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (lastRound && (lastRound.verdict !== 'pass' || (lastRound.blockers ?? []).length > 0)) {
      process.stderr.write(`BLOCKED_REVIEW_NOT_PASSED: 最新一轮审查未通过（verdict=${lastRound.verdict}）。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (!lastRound && highRiskHits.length > 0) {
      process.stderr.write(`BLOCKED_REQUIRES_INDEPENDENT_REVIEW: 触碰高风险路径（${highRiskHits.join(', ')}），缺少审查轮次 PASS 记录。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
  }

  if (profile.mergeAuthority === 'human' && !opts['human-approved']) {
    process.stderr.write('BLOCKED_HUMAN_MERGE_AUTHORITY: 项目「取舍」声明了 merge-authority: human，请经人类确认后附加 --human-approved。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  let mergeRes = null
  const baseBranch = ledger.baseBranch || 'main'
  if (ledger.role === 'maintainer' && ledger.prNumber && originFull) {
    const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
    mergeRes = await ghProbe.client.mergePr({
      repo: originFull,
      number: ledger.prNumber,
      method: opts.method ?? 'merge',
    })
    if (mergeRes.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, mergeDelegated: mergeRes }, null, 2)}\n`)
      else {
        process.stdout.write(`无直连 GitHub 凭据，已生成合并代理载荷：${JSON.stringify(mergeRes.jsonPayload)}\n`)
        printNextStep(['请在宿主 MCP 完成合并并回读 state=MERGED 后，再向人展示待清理清单。'])
      }
      return { exitCode: 0 }
    }
    if (!mergeRes.ok || !mergeRes.merged) {
      throw new Error(`PR #${ledger.prNumber} 合并或回读确认 MERGED 失败（state=${mergeRes.state ?? mergeRes.error}）`)
    }
    for (const iss of ledger.linkedIssues ?? []) {
      await ghProbe.client.postComment({
        repo: originFull,
        number: iss,
        body: `已合并：PR #${ledger.prNumber} 已合并至 \`${baseBranch}\`。`,
        statePayload: { taskId, action: 'merged', prNumber: ledger.prNumber },
      })
    }
    // 尝试将本地基线分支前推到最新远端，便于后续安全的 git branch -d
    const mainSt = await gitRun(roots.mainRoot, ['status', '--porcelain'])
    if (mainSt.ok && mainSt.stdout.trim() === '') {
      await gitRun(roots.mainRoot, ['fetch', 'origin', baseBranch])
      const curMainBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (curMainBr.ok && curMainBr.stdout.trim() === baseBranch) {
        await gitRun(roots.mainRoot, ['merge', '--ff-only', `origin/${baseBranch}`])
      }
    }
  } else if (ledger.branch) {
    // local-only 或离线/本地裸仓验证闭环：在主工作区显式并入基线分支，确保后续 git branch -d 安全通过
    const mainSt = await gitRun(roots.mainRoot, ['status', '--porcelain'])
    if (!mainSt.ok || mainSt.stdout.trim() !== '') {
      process.stderr.write('BLOCKED_DIRTY_MAIN: 主工作区存在未提交改动，无法并入基线分支，请清理后再 merge。\n')
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    const curMainBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (!curMainBr.ok || curMainBr.stdout.trim() !== baseBranch) {
      const sw = await gitRun(roots.mainRoot, ['switch', baseBranch])
      if (!sw.ok) throw new Error(`切回基线分支 ${baseBranch} 失败：${sw.stderr}`)
    }
    const isAnc = await gitRun(roots.mainRoot, ['merge-base', '--is-ancestor', ledger.branch, 'HEAD'])
    if (!isAnc.ok) {
      const mRes = await gitRun(roots.mainRoot, ['merge', '--no-ff', ledger.branch, '-m', `Merge branch '${ledger.branch}' (${taskId})`])
      if (!mRes.ok) {
        await gitRun(roots.mainRoot, ['merge', '--abort'])
        throw new Error(`本地合并分支 ${ledger.branch} 到 ${baseBranch} 失败（已中止合并）：${mRes.stderr}`)
      }
      mergeRes = { ok: true, localMerge: true, branch: ledger.branch, into: baseBranch }
    } else {
      mergeRes = { ok: true, alreadyMerged: true, branch: ledger.branch, into: baseBranch }
    }
  }

  ledger.status = 'merged'
  ledger.mergedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)

  // 合并后绝不自动删除分支或 worktree，只输出待确认清理清单
  const checklist = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, originFull)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, status: ledger.status, mergeRes, pendingCleanupChecklist: checklist }, null, 2)}\n`)
  } else {
    process.stdout.write(`合并状态已确认（task=${taskId}, status=${ledger.status}）。未自动删除任何分支或 Worktree。\n`)
    printCleanupChecklistText(checklist)
    printNextStep([
      '请先向人类展示上述待删清单并获得明确同意，再执行：',
      `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm`,
    ])
  }
  return { exitCode: 0 }
}

// ── 子命令实现：cleanup ────────────────────────────────────────────────

async function buildCleanupChecklist(mainRoot, ledger, remoteUrls, targetRepo) {
  const worktrees = []
  for (const relWt of [ledger.reviewWorktreePath, ledger.worktreePath].filter(Boolean)) {
    const abs = resolve(mainRoot, relWt)
    if (!existsSync(abs)) continue
    const st = await gitRun(abs, ['status', '--porcelain'])
    worktrees.push({ path: relWt, abs, dirty: st.stdout.trim() !== '' })
  }

  let localBranchExists = false
  if (ledger.branch) {
    const ref = await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${ledger.branch}`])
    localBranchExists = ref.ok
  }

  let remoteBranchExists = false
  if (ledger.branch && remoteUrls.origin) {
    const ls = await gitRun(mainRoot, ['ls-remote', '--heads', 'origin', ledger.branch])
    remoteBranchExists = ls.ok && ls.stdout.trim() !== ''
  }

  const ghProbe = await probeGitHubEnv({ cwd: mainRoot, remoteUrls })
  const downstream = targetRepo && ledger.branch
    ? await ghProbe.client.listOpenPrsByBase(targetRepo, ledger.branch)
    : { ok: true, prs: [] }

  let prState = ledger.prState ?? (ledger.status === 'awaiting-upstream-merge' ? 'OPEN' : null)
  if (targetRepo && ledger.prNumber && (ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token')) {
    const pr = await ghProbe.client.getPr(targetRepo, ledger.prNumber)
    if (pr.ok) prState = pr.state
  }

  return {
    taskId: ledger.taskId,
    role: ledger.role,
    worktrees,
    localBranch: localBranchExists ? ledger.branch : null,
    remoteBranch: remoteBranchExists ? `origin/${ledger.branch}` : null,
    downstreamStackedPrs: downstream.prs ?? [],
    prNumber: ledger.prNumber,
    prState,
  }
}

function printCleanupChecklistText(cl) {
  process.stdout.write('\n待确认清理清单（未得人点头前严禁自动删除）：\n')
  process.stdout.write(`- Worktrees: ${cl.worktrees.length > 0 ? cl.worktrees.map((w) => `${w.path}${w.dirty ? ' [脏]' : ' [干净]'}`).join(', ') : '无'}\n`)
  process.stdout.write(`- 本地分支: ${cl.localBranch ?? '无'}\n`)
  process.stdout.write(`- 远端分支: ${cl.remoteBranch ?? '无'}\n`)
  process.stdout.write(`- 下游堆叠 PR: ${cl.downstreamStackedPrs.length}\n`)
  if (cl.prNumber) process.stdout.write(`- 关联 PR #${cl.prNumber} 状态: ${cl.prState ?? '未知'}\n`)
}

async function handleCleanup(opts, roots) {
  const taskId = sanitizeTaskId(opts.task)
  const ledger = readTaskLedger(roots.mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)
  const cl = await buildCleanupChecklist(roots.mainRoot, ledger, remoteUrls, targetRepo)

  // 未带 --confirm 一律硬拒绝删除，只输出清单请求确认
  if (!opts.confirm) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_CONFIRMATION_REQUIRED', checklist: cl }, null, 2)}\n`)
    } else {
      process.stdout.write('BLOCKED_CONFIRMATION_REQUIRED: 缺少 --confirm，已拒绝执行删除。\n')
      printCleanupChecklistText(cl)
      printNextStep([
        `确认以上清单无误后，由人授权执行：node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${taskId} --confirm`,
      ])
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  // contributor-fork 且上游 PR 仍为 OPEN 时，硬锁拒绝删除 Fork 分支（防误关 GitHub PR）
  if (ledger.role === 'contributor-fork' && cl.prState === 'OPEN' && !opts['keep-branch']) {
    process.stderr.write(`BLOCKED_OPEN_FORK_PR: contributor-fork 关联上游 PR #${ledger.prNumber ?? '?'} 仍为 OPEN，硬锁拒绝删除 Fork 远端或本地分支（防止误关 PR）。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  if (cl.downstreamStackedPrs.length > 0 && !opts['keep-branch']) {
    process.stderr.write(`BLOCKED_STACKED_PR: 存在以 ${ledger.branch} 为 base 的下游开放 PR，拒绝删除分支。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const dirtyWt = cl.worktrees.find((w) => w.dirty)
  if (dirtyWt && !opts.force) {
    process.stderr.write(`BLOCKED_DIRTY_WORKTREE: 工作树 ${dirtyWt.path} 存在未提交改动，拒绝自动移除。\n`)
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  // 若主仓正检出目标分支，先切回默认分支
  if (cl.localBranch) {
    const curBr = await gitRun(roots.mainRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (curBr.ok && curBr.stdout.trim() === cl.localBranch) {
      const sw = await gitRun(roots.mainRoot, ['switch', ledger.baseBranch || 'main'])
      if (!sw.ok) throw new Error(`切回默认分支失败：${sw.stderr}`)
    }
  }

  const removedWorktrees = []
  for (const wt of cl.worktrees) {
    if (samePath(process.cwd(), wt.abs) || posixPath(process.cwd()).startsWith(`${posixPath(wt.abs)}/`)) {
      throw new Error(`当前进程工作目录位于待删除 worktree (${wt.path}) 内，请先切回主仓根目录再清理`)
    }
    // 强制第一步：先解绑 junction/symlink，校验主仓依赖完好
    const unmount = unmountSharedDeps(roots.mainRoot, wt.abs)
    const rmArgs = opts.force ? ['worktree', 'remove', '--force', wt.abs] : ['worktree', 'remove', wt.abs]
    const rmRes = await gitRun(roots.mainRoot, rmArgs)
    if (!rmRes.ok) throw new Error(`移除 worktree ${wt.path} 失败：${rmRes.stderr}`)
    removedWorktrees.push({ path: wt.path, unmountedDeps: unmount.unmounted.length })
  }

  let deletedLocalBranch = false
  if (cl.localBranch && !opts['keep-branch'] && cl.localBranch !== ledger.baseBranch) {
    // 严格只用 -d，绝不使用 -D 强删
    const delBr = await gitRun(roots.mainRoot, ['branch', '-d', cl.localBranch])
    if (!delBr.ok) throw new Error(`安全删除本地分支 ${cl.localBranch} 失败（未合入时不强删 -D）：${delBr.stderr}`)
    deletedLocalBranch = true
  }

  let deletedRemoteBranch = false
  if (cl.remoteBranch && !opts['keep-branch'] && ledger.role !== 'local-only') {
    const delRemote = await gitRun(roots.mainRoot, ['push', 'origin', '--delete', ledger.branch])
    if (!delRemote.ok) throw new Error(`删除远端分支 origin/${ledger.branch} 失败：${delRemote.stderr}`)
    deletedRemoteBranch = true
  }

  ledger.status = 'cleaned'
  ledger.cleanedAt = new Date().toISOString()
  writeTaskLedger(roots.mainRoot, ledger)

  const summary = { taskId, removedWorktrees, deletedLocalBranch, deletedRemoteBranch, status: ledger.status }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    process.stdout.write(`清理完成（task=${taskId}）：移除 worktree ${removedWorktrees.length} 个，本地分支删除=${deletedLocalBranch}，远端分支删除=${deletedRemoteBranch}。\n`)
    printNextStep(['任务闭环已完成，工作区与账本均保持干净状态。'])
  }
  return { exitCode: 0 }
}

// ── CLI 解析与主入口 ──────────────────────────────────────────────────

function parseCli(argv) {
  const sub = argv[0]
  const opts = { _: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--probe-auth') opts.probeAuth = true
    else if (a === '--parallel') opts.parallel = true
    else if (a === '--draft') opts.draft = true
    else if (a === '--rework') opts.rework = true
    else if (a === '--confirm') opts.confirm = true
    else if (a === '--force') opts.force = true
    else if (a === '--keep-branch') opts['keep-branch'] = true
    else if (a === '--human-approved') opts['human-approved'] = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2)
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (k === 'rebut') {
        opts.rebut = opts.rebut ? [...(Array.isArray(opts.rebut) ? opts.rebut : [opts.rebut]), v] : [v]
      } else {
        opts[k] = v
      }
    } else {
      opts._.push(a)
    }
  }
  return { sub, opts }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/flow.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  inspect   [inputs...] [--probe-auth] [--external-pr <M>] [--json]',
    '  start     --task <id> [--slug <slug>] [--case <1..5>] [--parallel] [--external-pr <M>] [--clone-choice <fork|standalone|local>] [--json]',
    '  claim     --task <id> [--issue <N>] [--agent <id>] [--json]',
    '  finalize  --task <id> [--note <text>] [--json]',
    '  verify    --task <id> [--mode quick|smoke|full|gate] [--target <file>] [--cmd <custom>] [--json]',
    '  submit    --task <id> [--draft] [--rework] [--json]',
    '  rework    --task <id> [--rebut "<findingId>: <reason>"] [--json]',
    '  merge     --task <id> [--method merge|squash|rebase] [--human-approved] [--json]',
    '  cleanup   --task <id> [--confirm] [--keep-branch] [--json]',
  ].join('\n') + '\n')
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const { sub, opts } = parseCli(argv)
  if (opts.help) { printHelp(); return 0 }

  const targetDir = resolve(opts.dir ?? process.cwd())
  const roots = await resolveRepoRoots(targetDir)

  try {
    if (sub === 'inspect') {
      const data = await inspectWorkspace(targetDir, {
        inputs: opts._,
        probeAuth: Boolean(opts.probeAuth),
        externalPr: opts['external-pr'],
        issue: opts.issue,
        pr: opts.pr,
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      } else {
        process.stdout.write(`# 工作区探测：${basename(data.mainRoot)}\n`)
        process.stdout.write(`- 身份: ${data.identity.role} (${data.identity.reason})\n`)
        process.stdout.write(`- 分支: ${data.branch ?? 'detached'} @ ${(data.head ?? 'unborn').slice(0, 7)} | 默认基线: ${data.defaultBranch} | 脏文件: ${data.dirty}\n`)
        process.stdout.write(`- GitHub 通道: TrackB=${data.github.trackB.tier}, https=${data.github.trackA.https}, ssh=${data.github.trackA.ssh}\n`)
        if (data.github.trackA.remediationCmd) {
          process.stdout.write(`- 协议修复建议: ${data.github.trackA.remediationCmd}\n`)
        }
        if (data.inputs.reuseExistingPr) {
          process.stdout.write(`- 复用已有 PR: #${data.inputs.reuseExistingPr.prNumber} (${data.inputs.reuseExistingPr.note})\n`)
        }
        if (data.inputs.issues.length > 1) {
          process.stdout.write(`- 多 Issue 拓扑排序: ${data.inputs.issueGraph.orderedIssues.map((n) => `#${n}`).join(' -> ')} (${data.inputs.issueGraph.strategy})\n`)
        }
        printNextStep([
          data.identity.role === 'clone-readonly'
            ? '只读克隆仓，请先向用户确认 --clone-choice <fork|standalone|local> 再运行 flow.mjs start'
            : '1. 按任务规模运行 doc-plan.mjs triage；2. 执行 flow.mjs start --task <id>',
        ])
      }
      return 0
    }

    if (!opts.task && ['start', 'claim', 'finalize', 'verify', 'submit', 'rework', 'merge', 'cleanup'].includes(sub)) {
      throw new Error(`${sub} 子命令必须传 --task <taskId>`)
    }

    if (sub === 'start') return (await handleStart(opts, roots)).exitCode
    if (sub === 'claim') return (await handleClaim(opts, roots)).exitCode
    if (sub === 'finalize') return (await handleFinalize(opts, roots)).exitCode
    if (sub === 'verify') return (await handleVerify(opts, roots)).exitCode
    if (sub === 'submit') return (await handleSubmit(opts, roots)).exitCode
    if (sub === 'rework') return (await handleRework(opts, roots)).exitCode
    if (sub === 'merge') return (await handleMerge(opts, roots)).exitCode
    if (sub === 'cleanup') return (await handleCleanup(opts, roots)).exitCode

    throw new Error(`未知子命令：${sub}`)
  } catch (err) {
    process.stderr.write(`flow 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
