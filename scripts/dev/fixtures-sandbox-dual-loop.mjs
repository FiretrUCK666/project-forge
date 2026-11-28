/**
 * fixtures-sandbox-dual-loop.mjs —— Wave 2 (`sandbox-dual-loop-flow`) C5..C8 正反双向行为断言：
 *   - C5: 隔离沙箱工作树创建、共享依赖挂载、脏主仓拦截、双向 Issue 优先级、未晋升硬拒 finalize/submit 与 CLI 对拍
 *   - C6: 账本 implementers[]、单常驻续写、互不重叠 writeScope 并行登记、冲突硬拒与全员改审分离/防自合
 *   - C7: flow.mjs promote 真实 git diff 确定性路由（Case 5 TDD 冲突、Case 2/3 原地晋升与三态 Issue 绑定、Case 4 PoC 零预建单）
 *   - C8: flow next 沙箱三态、内环 verify 前置豁免不放宽外环、inner:true 硬隔离与晋升后完整外环闭环（含 evergreen 架构图无脏 diff 叠层）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { ARCHITECTURE_MAP_REL, renderArchitectureMapFromRepo } from '../../kit/skills/lib/architecture-map.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { checkAuthorIsNotImplementer } from '../../kit/skills/lib/harness-context.mjs'
import { collectImplementerHistory, ensureReviewToken, readTaskLedger, updateTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { evaluateMutability } from '../../kit/skills/lib/mutability.mjs'
import { determineWorkflowPolicy, evaluateNextState, readVerificationEvidence, validateVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import { handleCleanup } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { checkLifecyclePreconditions } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { resolveOrBindStartIssue } from '../../kit/skills/dev-flow/scripts/flow-start-helpers.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { evaluateSubcommandParity } from './subcommand-parity.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

function makeMockGh() {
  let createIssueCalls = 0
  const createdIssues = []
  const comments = []
  const client = {
    tier: 'node-https-token',
    getIssue: async (_repo, num) => ({
      ok: true,
      number: Number(num),
      state: 'OPEN',
      title: `feat: issue #${num}`,
      body: '## 背景与现象\n\nExisting tracked issue.\n\n## 验收标准\n\n- [ ] C1: complete task\n',
      url: `https://github.com/acme/demo/issues/${num}`,
    }),
    createIssue: async (payload) => {
      createIssueCalls += 1
      const num = 500 + createIssueCalls
      createdIssues.push({ number: num, ...payload })
      return { ok: true, number: num, title: payload.title, url: `https://github.com/acme/demo/issues/${num}` }
    },
    postComment: async (payload) => {
      comments.push(payload)
      return { ok: true }
    },
    addLabels: async () => ({ ok: true }),
    removeLabel: async () => ({ ok: true }),
    ensureLabel: async () => ({ ok: true }),
    syncStateLabel: async () => ({ ok: true }),
    listIssues: async () => ({ ok: true, issues: [] }),
    listComments: async () => ({ ok: true, comments: [] }),
    findOpenPrForBranch: async () => ({ ok: true, prs: [] }),
    createPr: async (payload) => ({
      ok: true,
      number: 88,
      state: 'OPEN',
      url: 'https://github.com/acme/demo/pull/88',
      ...payload,
    }),
    getPr: async () => ({ ok: true, number: 88, state: 'MERGED', merged: true }),
    mergePr: async () => ({ ok: true, merged: true, state: 'MERGED', sha: 'mergedsha' }),
    getCommitChecks: async () => ({ ok: true, total: 0, checks: [] }),
    listOpenPrsByBase: async () => ({ ok: true, prs: [] }),
    closeIssue: async () => ({ ok: true }),
    updateIssueBody: async () => ({ ok: true }),
  }
  const probe = {
    client,
    env: {
      providerId: 'github',
      trackA: { https: true, ssh: false },
      trackB: { ok: true, tier: 'node-https-token', login: 'acme-dev' },
    },
  }
  return {
    get createCalls() { return createIssueCalls },
    createdIssues,
    comments,
    client,
    probe,
  }
}

function captureOutput(fn) {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write
  const origErr = process.stderr.write
  process.stdout.write = (chunk) => { stdout += String(chunk); return true }
  process.stderr.write = (chunk) => { stderr += String(chunk); return true }
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origOut
      process.stderr.write = origErr
    })
}

function makeSandboxRepo(extraFiles = {}, { origin = null } = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'package.json': JSON.stringify({ name: 'sb-demo', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
    'AGENTS.md': [
      '# sb-demo',
      '',
      '```yaml',
      'quick-test: node -e "process.exit(0)"',
      'full-test: node -e "process.exit(0)"',
      'smoke-verify: none',
      'merge-gate: node -e "process.exit(0)"',
      'high-risk: src/security/, src/core/auth.mjs',
      'do-not-edit: docs/archive/',
      '```',
      '',
    ].join('\n'),
    'src/ui/button.tsx': 'export function Button() { return "ok" }\n',
    'src/ui/theme.css': '.btn { color: #111; }\n',
    'src/api/client.mjs': 'export function fetchUser() { return { id: 1 } }\n',
    'src/security/guard.mjs': 'export function verifyToken(t) { return Boolean(t) }\n',
    '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\ndescription: plan\n---\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
    '.agents/skills/dev-review/SKILL.md': '---\nname: dev-review\ndescription: review\n---\n',
    ...extraFiles,
  })
  gitInit(dir, { branch: 'main', ...(origin ? { origin } : {}) })
  gitSync(dir, ['config', 'user.name', 'Test User'])
  gitSync(dir, ['config', 'user.email', 'test@example.com'])
  return dir
}

export function registerSandboxDualLoopCases(cases) {
  cases.push(['[Sandbox-C5] 沙箱隔离工作树、双向 Issue 优先级、脏主仓拦截、未晋升禁 finalize/submit 与 CLI 对拍', async () => {
    const dir = makeSandboxRepo({
      'node_modules/pkg/index.js': 'module.exports = 1\n',
      'docs/todo/261127-sb-demo-todo.md': [
        '---',
        'kind: todo',
        'title: sandbox demo',
        'status: active',
        'owner: planner-1',
        '---',
        '# sandbox demo',
        '',
        '- [x] C1: demo item',
        '',
      ].join('\n'),
    })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 脏主仓从干净 HEAD 新开隔离沙箱降级为非阻断预警（原地主仓/合主干仍由 enforceSlotBoundary 硬阻断 BLOCKED_DIRTY_MAIN）
      writeFileSync(join(dir, 'src/ui/theme.css'), '.btn { color: #222; }\n', 'utf8')
      const dirtyStart = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-dirty', slug: 'sb-dirty', agent: 'impl-a', json: true,
      }, roots))
      if (dirtyStart.result.exitCode !== EXIT.OK || !dirtyStart.stdout.includes('WARN_DIRTY_MAIN_ISOLATED_WORKTREE')) {
        return `脏主仓新开隔离沙箱应降级预警 WARN_DIRTY_MAIN_ISOLATED_WORKTREE：exit=${dirtyStart.result.exitCode} out=${dirtyStart.stdout} err=${dirtyStart.stderr}`
      }
      gitSync(dir, ['checkout', '--', 'src/ui/theme.css'])

      // 2. 无 Issue 启动沙箱 -> .worktrees/sandbox-<id>/ + 共享依赖挂载 + exempt(sandbox)
      const gh = makeMockGh()
      const okStart = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-exempt', slug: 'sb-exempt', agent: 'impl-a',
        todo: 'docs/todo/261127-sb-demo-todo.md', json: true, _ghProbe: gh.probe, _ghClient: gh.client,
      }, roots))
      if (okStart.result.exitCode !== EXIT.OK) {
        return `干净主仓启动沙箱失败：exit=${okStart.result.exitCode} err=${okStart.stderr}`
      }
      const sbDir = join(dir, '.worktrees', 'sandbox-sb-exempt')
      if (!existsSync(sbDir)) return `未创建 .worktrees/sandbox-sb-exempt`
      const ledgerExempt = readTaskLedger(dir, 'sb-exempt')
      if (ledgerExempt?.sandboxMode !== true || ledgerExempt?.status !== 'sandbox-iterating') {
        return `沙箱账本状态错误：${JSON.stringify(ledgerExempt)}`
      }
      if (ledgerExempt.issueBinding?.mode !== 'exempt' || ledgerExempt.issueBinding?.exemptKind !== 'sandbox' || gh.createCalls !== 0) {
        return `无 Issue 沙箱应记 exempt(sandbox) 且零建单：binding=${JSON.stringify(ledgerExempt.issueBinding)} calls=${gh.createCalls}`
      }
      if (!existsSync(join(sbDir, 'node_modules'))) {
        return '沙箱工作树未挂载共享依赖 node_modules'
      }

      // 3. 显式传入 --issue 42 -> 保留 linkedIssues=[42] 且 issueBinding.mode==='reused'
      const issueStart = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-reused', slug: 'sb-reused', agent: 'impl-a',
        issue: '42', json: true, _ghProbe: gh.probe, _ghClient: gh.client,
      }, roots))
      if (issueStart.result.exitCode !== EXIT.OK) {
        return `带 --issue 启动沙箱失败：exit=${issueStart.result.exitCode} err=${issueStart.stderr}`
      }
      const ledgerReused = readTaskLedger(dir, 'sb-reused')
      if (!ledgerReused.linkedIssues?.includes(42) || ledgerReused.issueBinding?.mode !== 'reused') {
        return `显式 --issue 42 未被原样保留为 reused：${JSON.stringify({ linkedIssues: ledgerReused.linkedIssues, issueBinding: ledgerReused.issueBinding })}`
      }

      // 4. 未晋升沙箱调用 finalize 与 submit 均硬拒 BLOCKED_SANDBOX_PROMOTE_REQUIRED (exit 3) 且零 git mv 副作用
      const finBlock = await captureOutput(() => handleFinalize({ task: 'sb-exempt', json: true }, roots))
      if (finBlock.result.exitCode !== EXIT.FACT || !finBlock.stderr.includes('BLOCKED_SANDBOX_PROMOTE_REQUIRED')) {
        return `未晋升沙箱 finalize 未硬拒：exit=${finBlock.result.exitCode} err=${finBlock.stderr}`
      }
      if (!existsSync(join(sbDir, 'docs/todo/261127-sb-demo-todo.md'))) {
        return '未晋升沙箱 finalize 竟发生了 git mv 归档副作用'
      }
      const subBlock = await captureOutput(() => handleSubmit({ task: 'sb-exempt', agent: 'impl-a', json: true }, roots))
      if (subBlock.result.exitCode !== EXIT.FACT || !subBlock.stderr.includes('BLOCKED_SANDBOX_PROMOTE_REQUIRED')) {
        return `未晋升沙箱 submit 未硬拒：exit=${subBlock.result.exitCode} err=${subBlock.stderr}`
      }

      // 5. CLI / 子命令对拍校验
      const subPar = evaluateSubcommandParity()
      if (!subPar.ok) return `subcommand-parity 失败：${subPar.failures.join('；')}`
      const helpRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['--help'], { cwd: dir })
      if (helpRes.status !== 0 || !helpRes.stdout.includes('promote') || !helpRes.stdout.includes('--sandbox') || !helpRes.stdout.includes('--conflicts-tdd')) {
        return `flow.mjs --help 缺少 promote / --sandbox / --conflicts-tdd：\n${helpRes.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Sandbox-C6] 写域防碰撞、多子代理登记与全员改审分离/防自合', async () => {
    const { registerImplementer, checkWriteScopeOverlap } = await import('../../kit/skills/lib/sandbox-scope.mjs')
    const { handlePromote } = await import('../../kit/skills/dev-flow/scripts/flow-sandbox.mjs')
    const dir = makeSandboxRepo()
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 纯函数单测：常驻续写 + 互不重叠并行 + 重叠/全仓碰撞拦截 + 非实施者拒收
      const mockLedger = { implementers: [] }
      const r1 = registerImplementer(mockLedger, { actor: 'impl-ui', writeScope: ['src/ui/**'] })
      if (!r1.ok) return `impl-ui 登记失败：${JSON.stringify(r1)}`
      const r1Cont = registerImplementer(mockLedger, { actor: 'impl-ui', writeScope: ['src/ui/theme.css'] })
      if (!r1Cont.ok) return `同常驻代理续写应幂等放行：${JSON.stringify(r1Cont)}`
      const r2 = registerImplementer(mockLedger, { actor: 'impl-api', writeScope: ['src/api/**'] })
      if (!r2.ok) return `互不重叠 writeScope 应放行：${JSON.stringify(r2)}`
      const rOverlap = registerImplementer(mockLedger, { actor: 'impl-c', writeScope: ['src/ui/button.tsx'] })
      if (rOverlap.ok || rOverlap.code !== 'BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP' || rOverlap.exitCode !== EXIT.FACT) {
        return `重叠 writeScope 未被拦下：${JSON.stringify(rOverlap)}`
      }
      const rWild = checkWriteScopeOverlap(mockLedger.implementers, { actor: 'impl-d', writeScope: [] })
      if (rWild.ok || rWild.code !== 'BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP') {
        return `空全仓 writeScope 与既有并行代理共存应被拦下：${JSON.stringify(rWild)}`
      }
      const rCoord = registerImplementer(mockLedger, { actor: 'coordinator', writeScope: ['src/other/**'] })
      if (rCoord.ok || rCoord.code !== 'BLOCKED_MISSING_ACTOR') {
        return `coordinator 角色应被拒绝登记为实施者：${JSON.stringify(rCoord)}`
      }

      // 2. CLI 实跑：多代理并行登记 + 冲突拦下 + 晋升后全员改审分离与防自合
      const s1 = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-multi', slug: 'sb-multi', agent: 'impl-ui', 'write-scope': 'src/ui/**', json: true,
      }, roots))
      if (s1.result.exitCode !== EXIT.OK) return `主沙箱启动失败：${s1.stderr}`
      const s2 = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-multi', slug: 'sb-multi', agent: 'impl-api', 'write-scope': 'src/api/**', json: true,
      }, roots))
      if (s2.result.exitCode !== EXIT.OK) return `第二并行代理登记失败：${s2.stderr}`
      const sBad = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-multi', slug: 'sb-multi', agent: 'impl-clash', 'write-scope': 'src/ui/button.tsx', json: true,
      }, roots))
      if (sBad.result.exitCode !== EXIT.FACT || !sBad.stderr.includes('BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP')) {
        return `CLI 重叠 writeScope 未拦下：exit=${sBad.result.exitCode} err=${sBad.stderr}`
      }

      const ledgerBefore = readTaskLedger(dir, 'sb-multi')
      const hist = collectImplementerHistory(ledgerBefore)
      if (!hist.includes('impl-ui') || !hist.includes('impl-api')) {
        return `collectImplementerHistory 未聚合 implementers[]：${JSON.stringify(hist)}`
      }

      // 提交改动并晋升 -> 外环 verify -> submit -> 测试 impl-api 自审与自合均被硬拒
      const sbDir = join(dir, '.worktrees', 'sandbox-sb-multi')
      writeFileSync(join(sbDir, 'src/ui/theme.css'), '.btn { color: #333; }\n', 'utf8')
      gitCommitFast(sbDir, 'style: tweak button color')
      const pro = await captureOutput(() => handlePromote({ task: 'sb-multi', 'no-issue': true, reason: 'local test promotion', json: true }, roots))
      if (pro.result.exitCode !== EXIT.OK) return `多代理沙箱 promote 失败：${pro.stderr}`

      const headSha = gitSync(sbDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const vOut = await captureOutput(() => handleVerify({
        task: 'sb-multi', mode: 'full', 'visual-blocked-reason': 'headless test env without browser display', json: true,
      }, roots))
      if (vOut.result.exitCode !== EXIT.OK) return `晋升后外环 verify 失败：${vOut.stderr}`
      const subOut = await captureOutput(() => handleSubmit({ task: 'sb-multi', agent: 'impl-ui', json: true }, roots))
      if (subOut.result.exitCode !== EXIT.OK) return `晋升后 submit 失败：${subOut.stderr}`

      const ledgerAfter = readTaskLedger(dir, 'sb-multi')
      const { token } = ensureReviewToken(dir, ledgerAfter, 1, { headSha })
      const selfRev = await captureOutput(() => handleRecord({
        task: 'sb-multi', round: '1', verdict: 'pass', 'reviewer-id': 'impl-api',
        'review-token': token, evidence: 'ran node -e "process.exit(0)" -> exit 0, verified src/ui/theme.css',
        'enforce-gates': false, json: true,
      }, roots))
      if (selfRev.result !== EXIT.FACT || !selfRev.stderr.includes('SELF_REVIEW_REJECTED')) {
        return `并行子代理 impl-api 尝试审查应报 SELF_REVIEW_REJECTED：exit=${selfRev.result} err=${selfRev.stderr}`
      }

      // 独立审查者通过审查后，impl-api 尝试执行 merge 仍报 BLOCKED_SELF_MERGE
      const indRev = await captureOutput(() => handleRecord({
        task: 'sb-multi', round: '1', verdict: 'pass', 'reviewer-id': 'rev-independent',
        'review-token': token, evidence: 'ran node -e "process.exit(0)" -> exit 0, verified src/ui/theme.css',
        'enforce-gates': false, json: true,
      }, roots))
      if (indRev.result !== EXIT.OK) return `独立审查者应通过：exit=${indRev.result} err=${indRev.stderr}`
      const selfMerge = await captureOutput(() => handleMerge({ task: 'sb-multi', 'reviewer-id': 'impl-api', json: true }, roots))
      if (selfMerge.result.exitCode !== EXIT.FACT || !selfMerge.stderr.includes('BLOCKED_SELF_MERGE')) {
        return `并行子代理 impl-api 尝试 merge 应报 BLOCKED_SELF_MERGE：exit=${selfMerge.result.exitCode} err=${selfMerge.stderr}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Sandbox-C7] promote 真实 diff 分类：Case 5 TDD 冲突、Case 2/3 三态 Issue 绑定与 Case 4 零预建单', async () => {
    const { handlePromote } = await import('../../kit/skills/dev-flow/scripts/flow-sandbox.mjs')
    const dir = makeSandboxRepo({
      'docs/TDD.md': [
        '# sb-demo 技术设计',
        '',
        '最近更新日期：`2026-11-27`',
        '',
        '## 模块列表',
        '',
        '- `src/api/client.mjs`',
        '- `src/ui/theme.css`',
        '',
      ].join('\n'),
    }, { origin: 'https://github.com/acme/demo.git' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 0. 非沙箱任务 promote -> BLOCKED_NOT_SANDBOX_TASK (exit 3)
      await updateTaskLedger(dir, 'outer-only', {
        taskId: 'outer-only', slug: 'outer-only', caseType: 2, sandboxMode: false, status: 'started',
      }, { createIfMissing: true })
      const notSb = await captureOutput(() => handlePromote({ task: 'outer-only', json: true }, roots))
      if (notSb.result.exitCode !== EXIT.FACT || !notSb.stderr.includes('BLOCKED_NOT_SANDBOX_TASK')) {
        return `非沙箱任务 promote 应报 BLOCKED_NOT_SANDBOX_TASK：exit=${notSb.result.exitCode} err=${notSb.stderr}`
      }
      // 设定 standalone 维护者模式以便 mock GitHub 远端触发 maintainer 建单路径
      writeFileSync(join(roots.gitDir, 'pf-standalone-mode'), 'enabled\n', 'utf8')

      // 1. resolveOrBindStartIssue commandName='promote' 提示准确指向 flow.mjs promote
      const bindPrompt = await resolveOrBindStartIssue({
        roots, docRoot: dir, state: {}, role: 'maintainer', providerId: 'github',
        prelimTaskId: 'sb-hint', caseType: 2, isPlanning: false, linkedIssues: [],
        docs: {}, ledger: null, opts: {}, commandName: 'promote',
      })
      if (!bindPrompt.blocked || bindPrompt.code !== 'BLOCKED_MISSING_ISSUE_BINDING' || !bindPrompt.reason.includes('flow.mjs promote')) {
        return `commandName='promote' 指引未指向 flow.mjs promote：${JSON.stringify(bindPrompt)}`
      }

      // 2. 启动带 --issue 77 的沙箱 -> 修改 UI -> promote 原样复用 #77 且 createIssue === 0
      const ghA = makeMockGh()
      await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-a', slug: 'sb-a', agent: 'impl-a', issue: '77',
        json: true, _ghProbe: ghA.probe, _ghClient: ghA.client,
      }, roots))
      const sbA = join(dir, '.worktrees', 'sandbox-sb-a')
      // 空 diff 拦截
      const emptyPro = await captureOutput(() => handlePromote({ task: 'sb-a', json: true, _ghProbe: ghA.probe, _ghClient: ghA.client }, roots))
      if (emptyPro.result.exitCode !== EXIT.FACT || !emptyPro.stderr.includes('BLOCKED_SANDBOX_EMPTY_DIFF')) {
        return `空 diff promote 应报 BLOCKED_SANDBOX_EMPTY_DIFF：exit=${emptyPro.result.exitCode} err=${emptyPro.stderr}`
      }
      // 脏树拦截
      writeFileSync(join(sbA, 'src/ui/theme.css'), '.btn { color: #444; }\n', 'utf8')
      const dirtyPro = await captureOutput(() => handlePromote({ task: 'sb-a', json: true, _ghProbe: ghA.probe, _ghClient: ghA.client }, roots))
      if (dirtyPro.result.exitCode !== EXIT.FACT || !dirtyPro.stderr.includes('BLOCKED_DIRTY_WORKTREE')) {
        return `脏沙箱 promote 应报 BLOCKED_DIRTY_WORKTREE：exit=${dirtyPro.result.exitCode} err=${dirtyPro.stderr}`
      }
      gitCommitFast(sbA, 'style: update button palette')
      const proA = await captureOutput(() => handlePromote({ task: 'sb-a', json: true, _ghProbe: ghA.probe, _ghClient: ghA.client }, roots))
      if (proA.result.exitCode !== EXIT.OK) return `带 --issue 77 沙箱 promote 失败：${proA.stderr}`
      const lA = readTaskLedger(dir, 'sb-a')
      if (lA.sandboxMode !== false || lA.promotedFromSandbox !== true || !lA.linkedIssues.includes(77) || ghA.createCalls !== 0 || !lA.claimedAt) {
        return `场景 (a) 复用 #77 或状态切换异常：calls=${ghA.createCalls} ledger=${JSON.stringify({ sandboxMode: lA.sandboxMode, promotedFromSandbox: lA.promotedFromSandbox, linkedIssues: lA.linkedIssues, claimedAt: lA.claimedAt })}`
      }

      // 3. 场景 (b)：无 Issue 启动 + 新增普通源码文件（missingModulesInTdd 不误触发 Case 5！）+ promote 无 --body/--todo -> 自动合成合规正文建 1 单 + Case 3 补 explored + 非实施者 Todo 指引
      const ghB = makeMockGh()
      await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-b', slug: 'sb-b', agent: 'impl-b',
        json: true, _ghProbe: ghB.probe, _ghClient: ghB.client,
      }, roots))
      const sbB = join(dir, '.worktrees', 'sandbox-sb-b')
      writeFileSync(join(sbB, 'src/ui/badge.tsx'), 'export function Badge() { return "new" }\n', 'utf8')
      gitCommitFast(sbB, 'feat(ui): add badge component')
      const proB = await captureOutput(() => handlePromote({ task: 'sb-b', json: true, _ghProbe: ghB.probe, _ghClient: ghB.client }, roots))
      if (proB.result.exitCode !== EXIT.OK) {
        return `场景 (b) 新增普通模块（missingModulesInTdd）不应误触 Case 5 且应自动合成正文建单：exit=${proB.result.exitCode} err=${proB.stderr}`
      }
      const lB = readTaskLedger(dir, 'sb-b')
      if (ghB.createCalls !== 1 || lB.linkedIssues.length !== 1 || lB.caseType !== 3 || !lB.claimedAt || !lB.explored?.at) {
        return `场景 (b) 应自动建 1 单并衔接 Case 3 claimedAt/explored：calls=${ghB.createCalls} ledger=${JSON.stringify({ linkedIssues: lB.linkedIssues, caseType: lB.caseType, claimedAt: lB.claimedAt, explored: lB.explored })}`
      }
      if (!proB.stdout.includes('doc-plan.mjs') || !proB.stdout.includes('--issue')) {
        return `Case 3 promote 应输出复用单一 Issue 的非实施者 Todo 下一步指引：\n${proB.stdout}`
      }
      const sepOk = checkAuthorIsNotImplementer('planner-b', 'impl-b', { file: 'docs/todo/261127-sb-b-todo.md' })
      const sepBad = checkAuthorIsNotImplementer('impl-b', 'impl-b', { file: 'docs/todo/261127-sb-b-todo.md' })
      if (!sepOk.ok || sepBad.ok || sepBad.code !== 'BLOCKED_AUTHOR_IS_IMPLEMENTER') {
        return `Case 3 非实施者作者分离校验异常：sepOk=${JSON.stringify(sepOk)} sepBad=${JSON.stringify(sepBad)}`
      }

      // 4. 场景 (c)：触及 high-risk / migration -> SANDBOX_PROMOTE_NEEDS_SPEC + status='sandbox-needs-spec' + 严禁提前新建 Issue
      const ghC = makeMockGh()
      await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-c', slug: 'sb-c', agent: 'impl-c',
        json: true, _ghProbe: ghC.probe, _ghClient: ghC.client,
      }, roots))
      const sbC = join(dir, '.worktrees', 'sandbox-sb-c')
      writeFileSync(join(sbC, 'src/security/guard.mjs'), 'export function verifyToken(t) { return t === "strict" }\n', 'utf8')
      gitCommitFast(sbC, 'feat(security): tighten guard')
      const proC = await captureOutput(() => handlePromote({ task: 'sb-c', json: true, _ghProbe: ghC.probe, _ghClient: ghC.client }, roots))
      if (proC.result.exitCode !== EXIT.OK || !proC.stdout.includes('SANDBOX_PROMOTE_NEEDS_SPEC')) {
        return `场景 (c) high-risk 改动应返回 SANDBOX_PROMOTE_NEEDS_SPEC：exit=${proC.result.exitCode} out=${proC.stdout} err=${proC.stderr}`
      }
      const lC = readTaskLedger(dir, 'sb-c')
      if (lC.status !== 'sandbox-needs-spec' || lC.pocStatus !== 'needs-spec' || lC.sandboxMode !== true || ghC.createCalls !== 0 || lC.linkedIssues.length !== 0) {
        return `场景 (c) Case 4 PoC 状态异常或提前建单：calls=${ghC.createCalls} ledger=${JSON.stringify({ status: lC.status, pocStatus: lC.pocStatus, sandboxMode: lC.sandboxMode, linkedIssues: lC.linkedIssues })}`
      }

      // 5. Case 5 TDD 冲突：删除 TDD 已登记模块 (staleModulesInTdd) 或 --conflicts-tdd -> BLOCKED_CASE_5_TDD_CONFLICT 且零建单
      const ghD = makeMockGh()
      await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-tdd', slug: 'sb-tdd', agent: 'impl-d',
        json: true, _ghProbe: ghD.probe, _ghClient: ghD.client,
      }, roots))
      const sbD = join(dir, '.worktrees', 'sandbox-sb-tdd')
      gitSync(sbD, ['rm', 'src/api/client.mjs'])
      gitCommitFast(sbD, 'refactor: drop api client module')
      const proD = await captureOutput(() => handlePromote({ task: 'sb-tdd', json: true, _ghProbe: ghD.probe, _ghClient: ghD.client }, roots))
      if (proD.result.exitCode !== EXIT.FACT || !proD.stderr.includes('BLOCKED_CASE_5_TDD_CONFLICT') || ghD.createCalls !== 0) {
        return `删除 TDD 已登记模块应阻断 BLOCKED_CASE_5_TDD_CONFLICT 且零建单：exit=${proD.result.exitCode} calls=${ghD.createCalls} err=${proD.stderr}`
      }
      const lD = readTaskLedger(dir, 'sb-tdd')
      if (lD.status !== 'sandbox-needs-spec' || lD.pocStatus !== 'needs-tdd') {
        return `Case 5 账本状态应为 sandbox-needs-spec / needs-tdd：${JSON.stringify({ status: lD.status, pocStatus: lD.pocStatus })}`
      }

      // 6. 显式 --conflicts-tdd 同样阻断 Case 5
      const ghE = makeMockGh()
      await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-tdd-flag', slug: 'sb-tdd-flag', agent: 'impl-e',
        json: true, _ghProbe: ghE.probe, _ghClient: ghE.client,
      }, roots))
      const sbE = join(dir, '.worktrees', 'sandbox-sb-tdd-flag')
      writeFileSync(join(sbE, 'src/ui/theme.css'), '.btn { color: #555; }\n', 'utf8')
      gitCommitFast(sbE, 'style: color tweak')
      const proE = await captureOutput(() => handlePromote({ task: 'sb-tdd-flag', 'conflicts-tdd': true, json: true, _ghProbe: ghE.probe, _ghClient: ghE.client }, roots))
      if (proE.result.exitCode !== EXIT.FACT || !proE.stderr.includes('BLOCKED_CASE_5_TDD_CONFLICT') || ghE.createCalls !== 0) {
        return `--conflicts-tdd 未阻断 Case 5：exit=${proE.result.exitCode} calls=${ghE.createCalls} err=${proE.stderr}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Sandbox-C8] flow next 沙箱三态、内环豁免不放宽外环、完整外环闭环与 evergreen 架构图洁净校验', async () => {
    const { handlePromote } = await import('../../kit/skills/dev-flow/scripts/flow-sandbox.mjs')
    const dir = makeSandboxRepo({
      'node_modules/shared-lib/index.js': 'module.exports = "intact"\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [{ id: 'ui', name: 'UI', entrypoints: ['src/ui/theme.css'] }],
        features: [{
          id: 'ui-theme', name: 'UI Theme', domain: 'ui',
          entrypoints: ['src/ui/theme.css'], modules: ['src/ui/theme.css', 'src/ui/button.tsx'],
          businessFlows: ['render theme'], verificationTools: [], testRefs: [],
        }],
      }, null, 2),
      'docs/todo/261127-sb-e2e-todo.md': [
        '---',
        'kind: todo',
        'title: sandbox e2e',
        'status: active',
        'owner: planner-e2e',
        '---',
        '# sandbox e2e',
        '',
        '- [x] C1: complete style fix',
        '',
      ].join('\n'),
    })
    const initArch = renderArchitectureMapFromRepo(dir)
    if (!initArch.ok) return `初始化架构图失败：${JSON.stringify(initArch)}`
    gitCommitFast(dir, 'chore: add baseline architecture map')
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. mutability 与 evaluateNextState 沙箱三态校验
      for (const st of ['sandbox-iterating', 'sandbox-ready-to-promote', 'sandbox-needs-spec']) {
        const mut = evaluateMutability({ ledger: { taskId: 't1', status: st, sandboxMode: true }, phase: st })
        if (mut.mutability !== 'OPEN' || !mut.mutable) {
          return `沙箱态 ${st} 应为 OPEN 可编辑态：${JSON.stringify(mut)}`
        }
      }
      const nxIter = evaluateNextState({
        selectedTask: { taskId: 't-sb', slug: 't-sb', sandboxMode: true, status: 'sandbox-iterating', worktreePath: '.worktrees/sandbox-t-sb' },
        taskRuntime: { dirty: 1, commitsAheadOfBase: 0 },
      })
      const nxReady = evaluateNextState({
        selectedTask: { taskId: 't-sb', slug: 't-sb', sandboxMode: true, status: 'sandbox-iterating', worktreePath: '.worktrees/sandbox-t-sb' },
        taskRuntime: { dirty: 0, commitsAheadOfBase: 1 },
      })
      const nxSpec = evaluateNextState({
        selectedTask: { taskId: 't-sb', slug: 't-sb', sandboxMode: true, status: 'sandbox-needs-spec', pocStatus: 'needs-spec', worktreePath: '.worktrees/sandbox-t-sb' },
        taskRuntime: { dirty: 0, commitsAheadOfBase: 1 },
      })
      if (nxIter.phase !== 'sandbox-iterating' || !nxIter.command.includes('verify')) {
        return `sandbox-iterating 路由错误：${JSON.stringify(nxIter)}`
      }
      if (nxReady.phase !== 'sandbox-ready-to-promote' || !nxReady.command.includes('promote')) {
        return `sandbox-ready-to-promote 路由错误：${JSON.stringify(nxReady)}`
      }
      if (nxSpec.phase !== 'sandbox-needs-spec' || !nxSpec.command.includes('doc-plan.mjs')) {
        return `sandbox-needs-spec 路由错误：${JSON.stringify(nxSpec)}`
      }

      // 2. checkLifecyclePreconditions：内环豁免，但外环（sandboxMode=false）绝不放宽 claimedAt 与 explored
      const innerOk = checkLifecyclePreconditions({ taskId: 't1', caseType: 3, baseSha: 'abc', sandboxMode: true }, { _stage: 'verify' })
      if (!innerOk.ok) return `沙箱内环 verify 应豁免 claimedAt/explored：${JSON.stringify(innerOk)}`
      const outerUnclaimed = checkLifecyclePreconditions({ taskId: 't1', caseType: 2, baseSha: 'abc', sandboxMode: false }, { _stage: 'verify' })
      if (outerUnclaimed.ok || outerUnclaimed.code !== 'BLOCKED_UNCLAIMED_TASK') {
        return `外环 verify 缺少 claimedAt 必须仍拦截 BLOCKED_UNCLAIMED_TASK：${JSON.stringify(outerUnclaimed)}`
      }
      const outerUnexplored = checkLifecyclePreconditions({ taskId: 't1', caseType: 3, baseSha: 'abc', claimedAt: '2026-11-27T00:00:00Z', sandboxMode: false }, { _stage: 'verify' })
      if (outerUnexplored.ok || outerUnexplored.code !== 'BLOCKED_UNEXPLORED_TASK') {
        return `外环 verify Case 3 缺少 explored 必须仍拦截 BLOCKED_UNEXPLORED_TASK：${JSON.stringify(outerUnexplored)}`
      }

      // 3. 全链路 E2E：start --sandbox -> inner verify -> commit -> promote -> finalize（含 evergreen 架构图 0 modified/impacted）-> outer verify -> submit -> review -> merge -> cleanup
      const stOut = await captureOutput(() => handleStart({
        sandbox: true, task: 'sb-e2e', slug: 'sb-e2e', agent: 'impl-e2e',
        todo: 'docs/todo/261127-sb-e2e-todo.md', json: true,
      }, roots))
      if (stOut.result.exitCode !== EXIT.OK) return `E2E start --sandbox 失败：${stOut.stderr}`
      const sbDir = join(dir, '.worktrees', 'sandbox-sb-e2e')

      writeFileSync(join(sbDir, 'src/ui/theme.css'), '.btn { color: #09f; }\n', 'utf8')
      gitCommitFast(sbDir, 'style: update primary button blue')

      // 沙箱内环 verify（免 claimedAt/explored，写 inner: true）
      const innerVer = await captureOutput(() => handleVerify({
        task: 'sb-e2e', mode: 'full', inner: true, 'visual-blocked-reason': 'headless test env', json: true,
      }, roots))
      if (innerVer.result.exitCode !== EXIT.OK) return `沙箱内环 verify 失败：exit=${innerVer.result.exitCode} err=${innerVer.stderr}`
      const innerEv = readVerificationEvidence(roots.gitDir, 'sb-e2e')
      if (innerEv?.inner !== true) return `沙箱内环 verify 未记录 inner:true：${JSON.stringify(innerEv)}`

      // 晋升
      const pro = await captureOutput(() => handlePromote({
        task: 'sb-e2e', todo: 'docs/todo/261127-sb-e2e-todo.md', 'no-issue': true, reason: 'local e2e test', json: true,
      }, roots))
      if (pro.result.exitCode !== EXIT.OK) return `E2E promote 失败：${pro.stderr}`
      const afterPro = readTaskLedger(dir, 'sb-e2e')
      if (afterPro.verifiedHead !== null) return `promote 必须清零内环 verifiedHead：${afterPro.verifiedHead}`

      // 外环 finalize + 验证 evergreen architecture-map.html 含 0 个 modified/impacted 节点
      const fin = await captureOutput(() => handleFinalize({ task: 'sb-e2e', json: true }, roots))
      if (fin.result.exitCode !== EXIT.OK) return `E2E finalize 失败：exit=${fin.result.exitCode} err=${fin.stderr}`
      const archHtml = readFileSync(join(sbDir, ARCHITECTURE_MAP_REL), 'utf8')
      const dataMatch = /<script id="pf-visual-data" type="application\/json">([\s\S]*?)<\/script>/.exec(archHtml)
      if (!dataMatch) return 'docs/architecture-map.html 缺少 pf-visual-data 负载'
      const visualData = JSON.parse(dataMatch[1])
      const dirtyDiffNodes = (visualData.tree?.nodes ?? []).filter((n) => n.diffState === 'modified' || n.diffState === 'impacted')
      if (dirtyDiffNodes.length > 0 || archHtml.includes('class="pf-node pf-diff-modified') || archHtml.includes('class="pf-node pf-diff-impacted')) {
        return `finalize 渲染的常青 docs/architecture-map.html 混入了 PR 局部 modified/impacted 叠层：${JSON.stringify(dirtyDiffNodes.map((n) => ({ id: n.id, diffState: n.diffState })))}`
      }
      gitCommitFast(sbDir, 'docs: finalize sandbox e2e todo')

      // 验证内环 evidence 在外环被硬拒，重跑外环 verify 覆写 inner:false 后通过
      const headSha = gitSync(sbDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const outerPol = determineWorkflowPolicy({ changedFiles: ['src/ui/theme.css'], caseType: 3, profile: { fullTest: 'node -e "process.exit(0)"', explicitNone: new Set(['smoke-verify']) } })
      const innerRej = validateVerificationEvidence({ policy: outerPol, evidence: innerEv, headSha, profile: { fullTest: 'node -e "process.exit(0)"', explicitNone: new Set(['smoke-verify']) } })
      if (innerRej.ok || innerRej.code !== 'BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER') {
        return `内环实证未在外环被拒收：${JSON.stringify(innerRej)}`
      }

      const outerVer = await captureOutput(() => handleVerify({
        task: 'sb-e2e', mode: 'full', 'visual-blocked-reason': 'headless test env', json: true,
      }, roots))
      if (outerVer.result.exitCode !== EXIT.OK) return `外环 verify 失败：exit=${outerVer.result.exitCode} err=${outerVer.stderr}`
      const outerEv = readVerificationEvidence(roots.gitDir, 'sb-e2e')
      if (outerEv?.inner !== false) return `外环 verify 后 inner 应为 false：${JSON.stringify(outerEv)}`

      const sub = await captureOutput(() => handleSubmit({ task: 'sb-e2e', agent: 'impl-e2e', json: true }, roots))
      if (sub.result.exitCode !== EXIT.OK) return `外环 submit 失败：exit=${sub.result.exitCode} err=${sub.stderr}`

      const lSub = readTaskLedger(dir, 'sb-e2e')
      const { token } = ensureReviewToken(dir, lSub, 1, { headSha })
      const rev = await captureOutput(() => handleRecord({
        task: 'sb-e2e', round: '1', verdict: 'pass', 'reviewer-id': 'rev-e2e',
        'review-token': token, evidence: 'ran node -e "process.exit(0)" -> exit 0, verified src/ui/theme.css',
        'enforce-gates': false, json: true,
      }, roots))
      if (rev.result !== EXIT.OK) return `外环 review 失败：exit=${rev.result} err=${rev.stderr}`

      const mrg = await captureOutput(() => handleMerge({ task: 'sb-e2e', 'reviewer-id': 'rev-e2e', json: true }, roots))
      if (mrg.result.exitCode !== EXIT.OK) return `外环 merge 失败：exit=${mrg.result.exitCode} err=${mrg.stderr}`

      // cleanup 两阶段（先取 previewHash，再带 --confirm --preview-hash）且主仓共享依赖完好
      const clPreview = await captureOutput(() => handleCleanup({ task: 'sb-e2e', json: true }, roots))
      const previewJson = JSON.parse(clPreview.stdout)
      if (!previewJson.previewHash) return `cleanup 预览缺少 previewHash：${clPreview.stdout}`
      const clDo = await captureOutput(() => handleCleanup({
        task: 'sb-e2e', confirm: true, 'preview-hash': previewJson.previewHash, json: true,
      }, roots))
      if (clDo.result.exitCode !== EXIT.OK) return `cleanup --confirm 失败：exit=${clDo.result.exitCode} err=${clDo.stderr}`
      if (existsSync(sbDir)) return 'cleanup 后沙箱工作树仍残留'
      if (!existsSync(join(dir, 'node_modules/shared-lib/index.js'))) {
        return 'cleanup 卸沙箱工作树时误损了主仓共享依赖 node_modules'
      }
      return true
    } finally { rmTree(dir) }
  }])
}
