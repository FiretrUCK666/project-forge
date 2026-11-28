/**
 * fixtures-flow-parallel.mjs —— 并行调度与外部协作：
 *   外部图谱未关闭依赖拦截 / 堆叠分支父未合阻断 / Issue+PR 互链防重
 *   文件锁并发互斥 / 并行 scheduler 的 plan、disjoint、merge-queue
 *   统一 TaskBackend / 无远端仓零泄漏 / 三层 profile 嗅探
 */


import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { hydrateGeneratedDoc } from './fixtures-doc-fill.mjs'
import { createFakeGhEnv, EXIT, gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, runNode, seedExploredFor, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerFlowParallelCases(cases) {
cases.push(['外部图谱单 Issue 未关闭依赖拦截(I66)、外部 PR 扫前阻断挂载/verify、Issue+PR 互链防重', async () => {
  const { resolveExternalCollaborationGraph, checkUnresolvedDependencies } = await import('../../kit/skills/lib/task-graph.mjs')
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
  const { mountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
  const { resolveRepoRoots, writeTaskLedger } = await import('../../kit/skills/lib/shared.mjs')

  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'package.json': '{"name":"g-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'package-lock.json': '{"name":"g-demo","lockfileVersion":3}\n',
    'AGENTS.md': '# g\n\n## Dev Profile\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
    'src/app.mjs': 'export const ok = 1\n',
  })
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'export const d = 1\n')
  gitInit(dir, { branch: 'main', origin: 'https://github.com/acme/g-demo.git', name: 'acme', email: 'acme@acme.test' })

  try {
    const roots = await resolveRepoRoots(dir)
    const knownIssueStates = { 11: { number: 11, state: 'OPEN', title: 'Base task' }, 12: { number: 12, state: 'OPEN', body: 'Depends on #11\n' } }
    const g = await resolveExternalCollaborationGraph({ issueInput: '12', defaultRepo: 'acme/g-demo', originRepo: 'acme/g-demo', knownIssueStates })
    if (g.unresolvedBlockers.length !== 1 || g.unresolvedBlockers[0].number !== 11) return `未提取未关闭前置依赖：${JSON.stringify(g)}`
    if (!checkUnresolvedDependencies(g).blocked) return 'BLOCKED_UNRESOLVED_DEPENDENCY 未拦截开放前置依赖'

    const stBlocked = await handleStart({ issue: '12', task: 'iss-12', _ghProbe: { env: { providerId: 'github', trackB: { tier: 'offline' } }, client: {} }, knownIssueStates }, roots)
    if (stBlocked.exitCode !== 3) return `BLOCKED_UNRESOLVED_DEPENDENCY 未拦截 flow start：exit=${stBlocked.exitCode}`

    // 外部 PR：未扫描与未审批前阻断 worktree-deps 挂载与 flow verify
    const mainSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    gitSync(dir, ['checkout', '-qb', 'ext-branch'])
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n')
    gitCommitFast(dir, 'ext fix', { updateOnly: true, name: 'ext', email: 'ext@x.test' })
    const extSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    gitSync(dir, ['checkout', '-q', 'main'])

    const extStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--external-pr', '42', '--pr-ref', extSha, '--json'], { cwd: dir })
    if (extStart.status !== 0) return `外部 PR start 失败：${extStart.stderr}`
    let mountThrew = false
    try { mountSharedDeps(dir, join(dir, '.worktrees', 'review-pr-42')) } catch (e) { mountThrew = /BLOCKED_UNTRUSTED_PR_UNSCANNED/.test(e.message) }
    if (!mountThrew) return '未过 --untrusted-scan 与审批前竟允许挂载外部 PR 依赖'
    const vPre = await handleVerify({ task: 'review-pr-42', tier: 'quick' }, roots)
    if (vPre.exitCode !== 3) return `未扫未批外部 PR verify 未返回 exit 3：${vPre.exitCode}`

    const fakeGh42 = createFakeGhEnv({
      prs: {
        42: {
          number: 42, title: 'Ext PR 42', state: 'OPEN', body: 'ext', url: 'https://github.com/acme/g-demo/pull/42',
          baseRefName: 'main', headRefName: 'ext-branch', baseRefOid: mainSha, headRefOid: extSha, author: { login: 'ext' },
        },
      },
    })
    let scanOk
    try {
      scanOk = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--pr', '42', '--untrusted-scan', '--json'], { cwd: dir, env: fakeGh42.env })
    } finally { fakeGh42.cleanup() }
    if (scanOk.status !== 0) return `干净外部 PR 扫描失败：${scanOk.stderr}`
    const vNoApr = await handleVerify({ task: 'review-pr-42', tier: 'quick' }, roots)
    if (vNoApr.exitCode !== 3) return `扫描后未人类批准的外部 PR verify 未阻断：${vNoApr.exitCode}`
    const ledger42 = JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'review-pr-42.json'), 'utf8'))
    ledger42.untrustedApproved = true
    writeTaskLedger(dir, ledger42)
    mountSharedDeps(dir, join(dir, '.worktrees', 'review-pr-42'))
    const vApr = await handleVerify({ task: 'review-pr-42', tier: 'quick' }, roots)
    if (vApr.exitCode !== 0) return `人类授权后外部 PR verify 未放行：${vApr.exitCode}`

    // Issue + PR 互链合一且拦截重复新开 PR
    const linkedStart = await handleStart({
      task: 'linked-34', issue: '12', pr: '34', branch: 'feat/other-branch', force: true,
      knownIssueStates, knownPrs: [{ number: 34, state: 'OPEN', headBranch: 'feat/fix-34', baseBranch: 'main', body: 'Fixes #12' }],
    }, roots)
    if (linkedStart.exitCode !== 3) return `Issue+PR 冲突新分支未拦截 BLOCKED_DUPLICATE_PR_FOR_LINKED_ISSUE：${linkedStart.exitCode}`
    const linkedOk = await handleStart({
      task: 'linked-ok', issue: '12', pr: '34', branch: 'feat/fix-34', case: '1', force: true,
      knownIssueStates, knownPrs: [{ number: 34, state: 'OPEN', headBranch: 'feat/fix-34', baseBranch: 'main', body: 'Fixes #12' }],
    }, roots)
    if (linkedOk.exitCode !== 0) return `Issue+PR 合法复用分支 start 失败：${linkedOk.exitCode}`
    void handleSubmit
    return true
  } finally { rmTree(dir) }
}])

cases.push(['--after 堆叠分支、父未合阻断(I67)、flow sync 变基/冲突保护与 range-diff Round 2 增量视野', async () => {
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { handleSync } = await import('../../kit/skills/dev-flow/scripts/flow-sync.mjs')
  const { handleMerge } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
  const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')

  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# stack\n\n## Dev Profile\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
    'base.mjs': 'export const base = 1\n',
    'other.mjs': 'export const other = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@stack.test' })

  try {
    const roots = await resolveRepoRoots(dir)
    const pStart = await handleStart({ task: 'parent-t', slug: 'parent', case: '2', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦父子堆叠分支' }, roots)
    if (pStart.exitCode !== 0) return `父任务 start 失败：${pStart.exitCode}`
    const pRoot = join(dir, '.worktrees', 'impl-parent-t')
    writeFileSync(join(pRoot, 'parent-file.mjs'), 'export const p = 1\n')
    gitCommitFast(pRoot, 'feat: parent work', { files: ['parent-file.mjs'] })

    const cStart = await handleStart({ task: 'child-t', slug: 'child', after: 'parent-t', case: '2', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦堆叠子分支同步' }, roots)
    if (cStart.exitCode !== 0) return `子任务 --after start 失败：${cStart.exitCode}`
    await seedExploredFor(dir, 'child-t')
    const cRoot = join(dir, '.worktrees', 'impl-child-t')
    writeFileSync(join(cRoot, 'child-file.mjs'), 'export const c = 1\n')
    gitCommitFast(cRoot, 'feat: child work', { files: ['child-file.mjs'] })

    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const vChild = await handleVerify({ task: 'child-t', tier: 'quick' }, roots)
    if (vChild.exitCode !== 0) return `子任务 verify 失败：${vChild.exitCode}`
    const mBlocked = await handleMerge({ task: 'child-t' }, roots)
    if (mBlocked.exitCode !== 3 || mBlocked.code !== 'BLOCKED_STACK_PARENT_UNMERGED') {
      return `BLOCKED_STACK_PARENT_UNMERGED 未拦截父未合子分支合并：${JSON.stringify(mBlocked)}`
    }

    // Round 1 review-pack changes，然后父分支合并 + main 前进 -> flow sync rebase -> Round 2 range-diff
    const r1 = await handleRecord({ task: 'child-t', round: '1', verdict: 'changes', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 'child-t', 1), 'must-fix': ['C1: child-file.mjs:1 fix'] }, roots)
    if (r1 !== 0) return `Round 1 record 失败：${r1}`

    writeFileSync(join(cRoot, 'child-file.mjs'), 'export const c = 2\n')
    gitCommitFast(cRoot, 'fix: address R1', { updateOnly: true })

    // 模拟父分支已合入 main，main 同时有无关提交 upstream-only.mjs
    const mergeP = gitSync(dir, ['merge', '--no-ff', 'fix/parent', '-qm', 'merge parent'])
    if (mergeP.status !== 0) return `合并父分支失败：${mergeP.stderr}`
    writeFileSync(join(dir, 'upstream-only.mjs'), 'export const u = 1\n')
    gitCommitFast(dir, 'chore: upstream change', { files: ['upstream-only.mjs'] })

    const ledgerPath = join(dir, '.worktrees', '.state', 'tasks', 'child-t.json')
    const lObj = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    lObj.prNumber = 88
    writeFileSync(ledgerPath, JSON.stringify(lObj, null, 2))

    let baseUpdatedTo = null
    const mockClient = { tier: 'gh-cli', updatePrBase: async ({ base }) => { baseUpdatedTo = base; return { ok: true, base } } }
    const syncRes = await handleSync({ task: 'child-t', _ghClient: mockClient }, roots)
    if (syncRes.exitCode !== 0 || syncRes.syncCount !== 1 || baseUpdatedTo !== 'main') {
      return `flow sync 结果异常：${JSON.stringify(syncRes)} baseUpdatedTo=${baseUpdatedTo}`
    }
    const afterSyncLedger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    if ((afterSyncLedger.rounds?.length ?? 0) !== 1 || afterSyncLedger.syncCount !== 1) {
      return `sync 不应消耗停损 rounds 计数：${JSON.stringify(afterSyncLedger)}`
    }

    const r2Pack = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'child-t', '--round', '2', '--json'], { cwd: dir })
    if (r2Pack.status !== 0) return `sync 后 Round 2 review-pack 失败：${r2Pack.stderr}`
    const packJson = JSON.parse(r2Pack.stdout)
    const diffFiles = (packJson.diff?.files ?? []).map((f) => f.file)
    if (!diffFiles.includes('child-file.mjs') || diffFiles.includes('upstream-only.mjs')) {
      return `sync 后 Round 2 range-diff 文件集合异常：${JSON.stringify(diffFiles)} scope=${packJson.diffScope}`
    }

    // 变基后 Round 2 增量锁：挑刺未改动旧文件 other.mjs 必须拦截，挑刺 child-file.mjs 放行
    const oos = await handleRecord({ task: 'child-t', round: '2', verdict: 'changes', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 'child-t', 2), 'must-fix': ['C1: other.mjs:1 unrelated'] }, roots)
    if (oos !== EXIT.FACT) {
      return `sync 后增量视野硬锁未拦截越界文件：exit=${oos}`
    }

    // sync 冲突恢复测试：再往 main 与 child 同行制造冲突后 sync 必须干净中止并回到非冲突状态
    writeFileSync(join(dir, 'conflict.mjs'), 'export const x = "main"\n')
    gitCommitFast(dir, 'main conflict', { files: ['conflict.mjs'] })
    writeFileSync(join(cRoot, 'conflict.mjs'), 'export const x = "child"\n')
    gitCommitFast(cRoot, 'child conflict', { files: ['conflict.mjs'] })
    const syncConflict = await handleSync({ task: 'child-t', onto: 'main' }, roots)
    if (syncConflict.exitCode !== 3 || syncConflict.code !== 'BLOCKED_SYNC_REBASE_CONFLICT') {
      return `sync 冲突未返回 BLOCKED_SYNC_REBASE_CONFLICT：${JSON.stringify(syncConflict)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['L1 withFileLock 并发互斥、gitRun .git/*.lock 退避与 computeWorktreeEnv 隔离', async () => {
  const { computeWorktreeEnv, gitRun, withFileLock } = await import('../../kit/skills/lib/shared.mjs')
  const dir = tmpProject({})
  try {
    const lockFile = join(dir, '.git', 'project-forge-flow', 'locks', 'test.lock')
    let active = 0
    let maxActive = 0
    await Promise.all([1, 2, 3].map(() => withFileLock(lockFile, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
    })))
    if (maxActive !== 1) return `withFileLock 未实现并发互斥：maxActive=${maxActive}`

    let tries = 0
    const retryRes = await gitRun(dir, ['status'], {
      lockBackoffMs: [1, 1, 1],
      runner: async () => {
        tries += 1
        if (tries < 3) return { ok: false, code: 128, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists." }
        return { ok: true, code: 0, stdout: 'clean', stderr: '' }
      },
    })
    if (!retryRes.ok || tries !== 3) return `gitRun 锁冲突退避重试失败：tries=${tries}`

    const env0 = computeWorktreeEnv({ mainRoot: dir, gitDir: join(dir, '.git'), taskId: 'a', slotIndex: 0 })
    const env1 = computeWorktreeEnv({ mainRoot: dir, gitDir: join(dir, '.git'), taskId: 'b', slotIndex: 1 })
    if (env0.PF_PORT === env1.PF_PORT || !existsSync(env0.PF_CACHE_DIR) || !existsSync(env1.PF_CACHE_DIR)) {
      return `computeWorktreeEnv 隔离失败：${JSON.stringify({ env0, env1 })}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['flow batch plan/disjoint(I68)/merge-queue/resume-session 并行调度闭环', async () => {
  const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# batch',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      '```',
      '',
    ].join('\n'),
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@batch.test' })

  try {
    // batch check-disjoint (重叠阻断) + plan + merge-queue (成功与基线冲突回 rework) + resume-session
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleBatch } = await import('../../kit/skills/dev-flow/scripts/flow-batch.mjs')
    const { handleNext } = await import('../../kit/skills/dev-flow/scripts/flow-next.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const roots = await resolveRepoRoots(dir)

    await handleStart({ task: 'ta', slug: 'ta', case: '2', files: 'src/a.mjs', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦并行波次调度' }, roots)
    await handleStart({ task: 'tb', slug: 'tb', case: '2', files: 'src/b.mjs', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦并行波次调度' }, roots)
    await handleStart({ task: 'tc', slug: 'tc', case: '2', files: 'src/a.mjs', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦并行波次调度' }, roots)
    await seedExploredFor(dir, 'ta', 'tb', 'tc')

    const disjBad = await handleBatch({ _: ['check-disjoint'], tasks: 'ta,tc' }, roots)
    if (disjBad.exitCode !== 3 || disjBad.code !== 'BLOCKED_OVERLAPPING_SLICE_FILES') {
      return `BLOCKED_OVERLAPPING_SLICE_FILES 未拦截重叠切片：${JSON.stringify(disjBad)}`
    }
    const disjOk = await handleBatch({ _: ['check-disjoint'], tasks: 'ta,tb' }, roots)
    if (disjOk.exitCode !== 0) return `不重叠切片校验误拦：${JSON.stringify(disjOk)}`

    const planRes = await handleBatch({ _: ['plan'], tasks: 'ta,tb,tc' }, roots)
    if (planRes.exitCode !== 0 || (planRes.waves?.length ?? 0) < 2) {
      return `batch plan 冲突任务未拆波：${JSON.stringify(planRes)}`
    }

    // 实施 ta (干净)、tb (随后制造与 main 冲突)
    const wa = join(dir, '.worktrees', 'impl-ta')
    writeFileSync(join(wa, 'src/a.mjs'), 'export const a = 2\n')
    gitCommitFast(wa, 'feat: a', { updateOnly: true })
    const va = await handleVerify({ task: 'ta', tier: 'gate' }, roots)
    if (va.exitCode !== 0) return `ta verify --tier gate 失败：${va.exitCode}`
    const ra = await handleRecord({ task: 'ta', round: '1', verdict: 'pass', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 'ta', 1) }, roots)
    if (ra !== 0) return `ta review record 失败：${ra}`

    const wb = join(dir, '.worktrees', 'impl-tb')
    writeFileSync(join(wb, 'src/b.mjs'), 'export const b = "tb"\n')
    gitCommitFast(wb, 'feat: b', { updateOnly: true })
    const vb = await handleVerify({ task: 'tb', tier: 'gate' }, roots)
    if (vb.exitCode !== 0) return `tb verify --tier gate 失败：${vb.exitCode}`
    const rb = await handleRecord({ task: 'tb', round: '1', verdict: 'pass', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 'tb', 1) }, roots)
    if (rb !== 0) return `tb review record 失败：${rb}`

    // main 上改写 src/b.mjs 制造基线漂移冲突
    writeFileSync(join(dir, 'src/b.mjs'), 'export const b = "main-drift"\n')
    gitCommitFast(dir, 'main drift on b', { updateOnly: true })

    const mq = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['batch', 'merge-queue', '--tasks', 'ta,tb', '--json'], { cwd: dir })
    if (mq.status === 0) return `存在冲突任务 tb 的合并队列不应全绿：${mq.stdout}`
    const mqJson = JSON.parse(mq.stdout)
    if (mqJson.processed?.[0]?.status !== 'merged' || mqJson.processed?.[1]?.status !== 'rework' || !mqJson.processed?.[1]?.baseDrifted) {
      return `merge-queue 处理结果不符合预期：${mq.stdout}`
    }

    const nxtB = (await handleNext({ task: 'tb', json: true }, roots)).payload
    if (nxtB.phase !== 'needs-rework' || nxtB.ownerRole !== 'implementer') {
      return `merge-queue 冲突回 rework 后 flow next 路由错误：${JSON.stringify(nxtB)}`
    }

    const res1 = await handleBatch({ _: ['resume-session'], task: 'tb' }, roots)
    const res2 = await handleBatch({ _: ['resume-session'], task: 'tb' }, roots)
    if (res1.sessionHandle?.epoch !== 1 || res2.sessionHandle?.epoch !== 2 || res1.sessionHandle.handoffToken === res2.sessionHandle.handoffToken) {
      return `resume-session 句柄轮换错误：${JSON.stringify({ res1, res2 })}`
    }
    void resolveRepoRoots
    return true
  } finally { rmTree(dir) }
}])

cases.push(['13 方法统一 TaskBackend、no-remote AGENTS 零 PR/origin/push 泄漏、govern-tests 本地仓豁免', async () => {
  const { createTaskBackend, TASK_BACKEND_METHODS } = await import('../../kit/skills/lib/task-backend.mjs')
  const { renderAgentsTemplate } = await import('../compose-agents.mjs')
  const tpl = readFileSync(join(process.cwd(), 'templates', 'agents-project.md'), 'utf8').replace(/\r\n/g, '\n')

  // 1. 13 方法契约三端对齐 + generic-git 拦截本地 merge
  for (const kind of ['github', 'generic-git', 'local-only']) {
    const b = createTaskBackend({ role: kind === 'github' ? 'maintainer' : kind, providerId: kind === 'generic-git' ? 'generic-git' : 'github', targetRepo: 'a/b' })
    for (const m of TASK_BACKEND_METHODS) {
      if (typeof b[m] !== 'function') return `TaskBackend(${kind}) 缺少统一方法 ${m}`
    }
  }
  const gen = createTaskBackend({ role: 'generic-git', providerId: 'generic-git' })
  // 护栏：核不到远端事实时不许假装合并。两类阻断码都可接受——
  // 「取不回远端」与「远端还没合」是两种不同的不知道，都阻断，都不算通过。
  const genBlock = await gen.mergePr({ humanApproved: false })
  if (genBlock.ok || !/BLOCKED_(MERGE_STATE_UNVERIFIED|REMOTE_NOT_MERGED)/.test(String(genBlock.code)) || genBlock.exitCode !== 3) {
    return `GenericRemoteBackend 未阻断越权合入：${JSON.stringify(genBlock)}`
  }

  // 2. no-remote 渲染零 PR/origin/push/pull_request 且保留核心边界关键词
  const noRemoteFacts = {
    target: { name: 'local-app', path: process.cwd() },
    git: { present: true, remote: null, tags: [], isRepoRoot: true },
    ecosystem: { kinds: ['node'], publishable: true, manifests: ['package.json'] },
    commands: { test: 'npm test' },
    docs: { readme: 'README.md', readmes: ['README.md'] },
    conventions: { defaultBranch: 'main', commitStyle: 'plain' },
  }
  const out = renderAgentsTemplate(noRemoteFacts, tpl, process.cwd(), {})
  for (const badRe of [/\bPR\b/, /\borigin\b/i, /\bpush\b/i, /\bpull_request\b/i]) {
    const m = badRe.exec(out)
    if (m) return `no-remote 仍泄漏远端词 ${m[0]}`
  }
  for (const reqWord of ['日常', '不打标签', '发版', '明确说', '不自己判断', '日常到此为止']) {
    if (!out.includes(reqWord)) return `no-remote 丢失必要边界词：${reqWord}`
  }

  // 3. 纯本地仓免报 tests.no-ci-config
  const localDir = tmpProject({
    'package.json': '{"name":"pure-local","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'README.md': '# pure-local\n',
    'docs/TDD.md': '# TDD\n',
    'test/a.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
  })
  gitInit(localDir)
  try {
    const aud = JSON.parse((await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', localDir, '--json'])).stdout)
    if ((aud.findings ?? []).some((f) => f.id === 'tests.no-ci-config')) {
      return `纯本地无远端仓库被误报 tests.no-ci-config：${JSON.stringify(aud.findings)}`
    }
    return true
  } finally { rmTree(localDir) }
}])

cases.push(['profile-sniffer 三层嗅探(4空格中立CI/Taskfile/非vendor深层Java子包+Windows安全+detectionEvidence)', async () => {
  const { sniffLayeredCommands } = await import('../../kit/skills/lib/shared.mjs')
  const dir = tmpProject({
    'package.json': '{"name":"mono-root","version":"1.0.0","scripts":{"lint":"eslint ."}}\n',
    '.circleci/config.yml': [
      'version: 2.1',
      'jobs:',
      '    build:',
      '        docker:',
      '            - image: cimg/node:20.0',
      '        steps:',
      '            - run:',
      '                name: Verify Project',
      '                command: |',
      '                    npm run check',
      '                    npm test',
      '',
    ].join('\n'),
    'services/billing/pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
    'services/billing/src/test/java/BillingTest.java': 'class BillingTest {}\n',
    'vendor/legacy/package.json': '{"name":"vendor-pkg","scripts":{"test":"exit 1"}}\n',
    'Taskfile.yml': 'version: "3"\ntasks:\n  lint:\n    cmds:\n      - eslint .\n',
  })

  try {
    const s = await survey(dir)
    const mavenEco = s.ecosystem.kinds.includes('java') && (s.commandsByEcosystem?.['services/billing']?.test || s.commandsByEcosystem?.java?.test || '')
    if (!mavenEco || /\(cd\s/.test(mavenEco) || /vendor/.test(JSON.stringify(s.commandsByEcosystem))) {
      return `深层 Maven 嗅探或 vendor 隔离失败：${JSON.stringify({ kinds: s.ecosystem.kinds, byEco: s.commandsByEcosystem })}`
    }
    const layered = sniffLayeredCommands(dir, { ecosystemKinds: s.ecosystem.kinds, ecosystemCommands: s.commands })
    if (!layered.detectionEvidence?.some((e) => e.layer === 'ci-or-taskfile' && e.file === '.circleci/config.yml')
      || !layered.quickTest
      || /name:\s*Verify/i.test(layered.quickTest)) {
      return `4 空格 YAML 中立 CI 或 detectionEvidence 异常：${JSON.stringify(layered)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['零教学泄漏(CONVENTIONS_HINT 清除)、maskVolatile(I65)、--adopt-custom/oversize、equip 二次编辑再采用与 doc-plan 防自审(I64)/自定模板', async () => {
  const { maskVolatile } = await import('../lib/agents-sections.mjs')
  if (maskVolatile('node main.mjs domain maintainer git switch main', ['main']) !== 'node main.mjs domain maintainer git switch \u0000VOLATILE\u0000') {
    return 'maskVolatile 词边界失效：破坏了 main.mjs/domain/maintainer 标识符'
  }

  const dir = tmpProject({
    'README.md': '# c5-demo\n\n测试契约共存、equip 降档与 doc-plan 内审加固的仓库说明。\n',
    'CLAUDE.md': '# legacy ai rule\n',
    'docs/templates/spec.md': '## 安全与合规核验\n- [ ] 核对输入边界与降级路径\n',
  })
  gitInit(dir, { branch: 'main' })

  try {
    // 1. --adopt-custom 解除手改冲突与超限 managedBytes/customBytes 拆分
    await runNode('equip.mjs', [dir, '--no-backup'])
    await runNode('compose-agents.mjs', [dir, '--no-backup'])
    let agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填完。')
      .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
    writeFileSync(join(dir, 'AGENTS.md'), agents)
    for (const leak of ['CONVENTIONS_HINT', '逐条读一遍', '合完问用户', '暂未追加', '目录结尾带']) {
      if (agents.includes(leak)) return `AGENTS.md 仍残留教学泄漏文本：${leak}`
    }
    const cleanInit = await runNode('compose-agents.mjs', [dir, '--check'])
    if (cleanInit.status !== 0) return `清除教学泄漏填完后 --check 应为 0：${cleanInit.stderr}`

    agents = agents.replace('**提交纪律**：', '**提交纪律（定制规则）**：')
    writeFileSync(join(dir, 'AGENTS.md'), agents)
    if ((await runNode('compose-agents.mjs', [dir, '--check'])).status === 0) return '手改受管区后 --check 应为 1'

    const adoptRes = await runNode('compose-agents.mjs', [dir, '--adopt-custom', '--no-backup'])
    if (adoptRes.status !== 0 || (await runNode('compose-agents.mjs', [dir, '--check'])).status !== 0) {
      return `--adopt-custom 后 --check 未恢复通过：${adoptRes.stdout} ${adoptRes.stderr}`
    }

    writeFileSync(join(dir, 'AGENTS.md'), `${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}\n\n## 项目超长细节\n\n${'a'.repeat(32000)}\n`)
    const overDeny = await runNode('compose-agents.mjs', [dir, '--check'])
    if (overDeny.status === 0 || !/managed=/.test(overDeny.stderr) || !/custom=/.test(overDeny.stderr)) {
      return `超限未报告 managed/custom 拆解或误放行：${overDeny.stderr}`
    }
    const overAllow = await runNode('compose-agents.mjs', [dir, '--check', '--allow-custom-oversize'])
    if (overAllow.status !== 0) return `--allow-custom-oversize 未放行自定义长文：${overAllow.stderr}`

    // 2. equip 重复幂等保留全部技能 + 二次编辑再采用
    const dg = await runNode('equip.mjs', [dir, '--no-backup'])
    if (dg.status !== 0) return `equip 幂等重跑失败：${dg.stderr}`
    if (!existsSync(join(dir, '.agents', 'skills', 'dev-review', 'SKILL.md'))) {
      return 'equip 重跑误删技能 dev-review'
    }
    const eqChk = await runNode('equip.mjs', [dir, '--check'])
    if (eqChk.status !== 0) return `equip --check 失败：${eqChk.stderr}`

    const flowSkill = join(dir, '.agents', 'skills', 'dev-flow', 'SKILL.md')
    writeFileSync(flowSkill, `${readFileSync(flowSkill, 'utf8')}\n<!-- custom v1 -->\n`)
    await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
    writeFileSync(flowSkill, `${readFileSync(flowSkill, 'utf8')}<!-- custom v2 -->\n`)
    const reEditRes = JSON.parse((await runNode('equip.mjs', [dir, '--no-backup'])).stdout).equip
    if (!reEditRes.conflicts?.some((c) => c.path === 'dev-flow/SKILL.md' && c.reason === 're-edited-custom')) {
      return `二次定制修改未标 re-edited-custom：${JSON.stringify(reEditRes)}`
    }
    await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
    if ((await runNode('equip.mjs', [dir, '--check'])).status !== 0) return '二次定制重采用后 --check 未通过'

    // 3. doc-plan 自定义模板 + SELF_CRITIQUE_REJECTED + PRD/TDD 内审指引
    const initSpec = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'spec', '--slug', 'custom-sec', '--title', 'Custom Sec Spec', '--owner', 'alice', '--in-place', '--json'], { cwd: dir })
    if (initSpec.status !== 0) return `doc-plan init 失败：${initSpec.stderr}`
    const specFile = JSON.parse(initSpec.stdout).file
    const specText = readFileSync(join(dir, specFile), 'utf8').replace('<第一条可判定的标准>', '真实可执行标准')
    writeFileSync(join(dir, specFile), specText)
    if (!specText.includes('安全与合规核验')) return `doc-plan init 未合并仓库自有模板节：${specText}`

    const selfCrit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', specFile, '--reviewer', '@Alice', '--round', '1'], { cwd: dir })
    if (selfCrit.status === 0 || !/SELF_CRITIQUE_REJECTED/.test(selfCrit.stderr)) {
      return `critique-pass 未触发 SELF_CRITIQUE_REJECTED 拦截 owner===reviewer 自审：exit=${selfCrit.status} err=${selfCrit.stderr}`
    }

    const initPrd = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'prd', '--slug', 'p1', '--title', 'PRD 1', '--owner', 'alice', '--in-place', '--json'], { cwd: dir })
    const prdFile = JSON.parse(initPrd.stdout).file
    hydrateGeneratedDoc(join(dir, prdFile), {
      criteria: ['命令退出码为 0', '输出里含预期字段'],
      filled: '当前 `README.md` 缺一份可执行的治理配置（退出码为 0）',
      extra: [
        ['<two-way | one-way>', 'two-way（可通过 `git revert` 回退）'],
        ['不做跨仓调度', '不修改 `CLAUDE.md` 之外的跨仓调度路径'],
      ],
    })
    const prdAud = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', prdFile], { cwd: dir })
    if (prdAud.status !== 0 || !/critique-pass/.test(prdAud.stdout)) {
      return `PRD audit 未输出独立 Critique 指引：${prdAud.stdout}\n${prdAud.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])
}
