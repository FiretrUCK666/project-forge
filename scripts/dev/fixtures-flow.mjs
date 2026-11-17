/**
 * fixtures-flow.mjs —— 研发流转夹具：flow 全生命周期、审查槽推进、认领协同与远端 CI 合并门禁。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydrateGeneratedDoc } from './fixtures-doc-fill.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerFlowCases(cases) {
cases.push(['flow.mjs：smoke --target 替换与缺参阻断、门禁弱化阻断与人工豁免、干净增量测试放行', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# flow-w2',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: node scripts/smoke.mjs --file {target}',
      'merge-gate: exit 0',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'package.json': '{"name":"flow-w2","version":"1.0.0"}\n',
    'scripts/smoke.mjs': 'import { existsSync } from "node:fs"\nconst f = process.argv[process.argv.indexOf("--file") + 1]\nif (!existsSync(f)) process.exit(2)\n',
    'src/ok.mjs': 'export const ok = 1\n',
    'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\nassert.equal(2, 2)\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })

  try {
    // 1. smoke --target 缺参 / 元字符阻断 / 正常替换
    const { resolveRepoRoots, readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleMerge } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const roots = await resolveRepoRoots(dir)

    const s1 = await handleStart({ task: 't-w2', case: '1', slug: 'w2-gate' }, roots)
    if (s1.exitCode !== 0) return `start t-w2 失败：${s1.exitCode}`
    const implW2 = join(dir, '.worktrees', 'impl-t-w2')

    const missTarget = await handleVerify({ task: 't-w2', mode: 'smoke' }, roots)
    if (missTarget.exitCode === 0) return 'smoke 缺 --target 未拦截'
    const badTarget = await handleVerify({ task: 't-w2', mode: 'smoke', target: 'a;echo' }, roots)
    if (badTarget.exitCode === 0) return 'smoke 非法元字符 --target 未拦截'
    const okSmoke = await handleVerify({ task: 't-w2', mode: 'smoke', target: 'src/ok.mjs' }, roots)
    if (okSmoke.exitCode !== 0 || !readTaskLedger(dir, 't-w2')?.verifiedCmd?.includes('src/ok.mjs')) {
      return `smoke --target src/ok.mjs 失败：${JSON.stringify(readTaskLedger(dir, 't-w2'))}`
    }

    // 2. 删减测试断言（门禁弱化）-> gate verify + 独立审查后 merge 必须 exit 4 (BLOCKED_GATE_WEAKENING)

    writeFileSync(join(implW2, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\n')
    gitCommitFast(implW2, 'weaken test', { updateOnly: true })

    const vWeak = await handleVerify({ task: 't-w2', mode: 'gate' }, roots)
    if (vWeak.exitCode !== 0) return `verify 失败：${vWeak.exitCode}`
    await handleRecord({ task: 't-w2', round: '1', verdict: 'pass', 'reviewer-id': 'rev-w2', 'review-token': await issueTokenFor(dir, 't-w2', 1) }, roots)

    const mGate = await handleMerge({ task: 't-w2', json: true }, roots)
    if (mGate.exitCode !== 4) return `门禁弱化改动未被 merge 拦截：exit=${mGate.exitCode}`

    // 3. 人工豁免 --human-approved 经临时 --detach 试合并入 main
    const mApproved = await handleMerge({ task: 't-w2', 'human-approved': true, json: true }, roots)
    if (mApproved.exitCode !== 0) return `--human-approved merge 失败：exit=${mApproved.exitCode}`

    // 4. 反面证伪：新增测试断言（非弱化）无 --human-approved 直接合并放行
    const s2 = await handleStart({ task: 't-w2-clean', case: '1', slug: 'w2-clean' }, roots)
    if (s2.exitCode !== 0) return `start t-w2-clean 失败：${s2.exitCode}`
    const implClean = join(dir, '.worktrees', 'impl-t-w2-clean')
    writeFileSync(join(implClean, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\nassert.equal(3, 3)\n')
    gitCommitFast(implClean, 'add assertion', { updateOnly: true })
    const vClean = await handleVerify({ task: 't-w2-clean', mode: 'full' }, roots)
    if (vClean.exitCode !== 0) return `clean verify 失败：${vClean.exitCode}`
    await handleRecord({ task: 't-w2-clean', round: '1', verdict: 'pass', 'reviewer-id': 'rev-w2', 'review-token': await issueTokenFor(dir, 't-w2-clean', 1) }, roots)
    const mClean = await handleMerge({ task: 't-w2-clean' }, roots)
    if (mClean.exitCode !== 0) return `正常增量测试被 merge 误杀为门禁弱化：exit=${mClean.exitCode}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['Trust Gateway：createIssue/listComments、start --create-issue 联动改名、claim 互斥/--takeover、release 与 record 实时双写', async () => {
  const { createGitHubClient } = await import('../../kit/skills/lib/shared.mjs')
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { handleClaim, handleRelease } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
  const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
  const { resolveRepoRoots } = await import('../../kit/skills/lib/git.mjs')

  // 1. 内存 stateful mock GitHub runner（验证 --body-file UTF-8 临时文件、listComments、add/removeLabel）
  const issues = new Map()
  const labelsByNum = new Map()
  const commentsByNum = new Map()
  let nextNum = 77
  const runner = async (cmd, args) => {
    if (cmd !== 'gh') return { ok: false, code: 1, stdout: '', stderr: 'not gh' }
    if (args[0] === 'issue' && args[1] === 'create') {
      const title = args[args.indexOf('--title') + 1]
      const bodyFile = args[args.indexOf('--body-file') + 1]
      const body = readFileSync(bodyFile, 'utf8')
      const num = nextNum++
      issues.set(num, { number: num, title, body })
      commentsByNum.set(num, [])
      labelsByNum.set(num, new Set())
      return { ok: true, code: 0, stdout: `https://github.com/acme/demo/issues/${num}\n`, stderr: '' }
    }
    if (args[0] === 'api' && /repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.test(args[1])) {
      const num = Number(/issues\/(\d+)\/comments/.exec(args[1])[1])
      if (args.includes('POST')) {
        const fSpec = args[args.indexOf('-F') + 1]
        const body = readFileSync(fSpec.replace(/^body=@/, ''), 'utf8')
        const entry = { id: (commentsByNum.get(num)?.length ?? 0) + 1, user: { login: 'tester' }, body, html_url: `https://github.com/acme/demo/issues/${num}#c` }
        if (!commentsByNum.has(num)) commentsByNum.set(num, [])
        commentsByNum.get(num).push(entry)
        return { ok: true, code: 0, stdout: JSON.stringify(entry), stderr: '' }
      }
      return { ok: true, code: 0, stdout: JSON.stringify(commentsByNum.get(num) ?? []), stderr: '' }
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const num = Number(args[2])
      if (!labelsByNum.has(num)) labelsByNum.set(num, new Set())
      const set = labelsByNum.get(num)
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--add-label') set.add(args[i + 1])
        if (args[i] === '--remove-label') set.delete(args[i + 1])
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unsupported' }
  }

  const client = createGitHubClient({ tier: 'gh-cli', login: 'alice', runner })
  const mcpClient = createGitHubClient({ tier: 'mcp-delegate' })
  const mcpIssue = await mcpClient.createIssue({ repo: 'acme/demo', title: 'delegated', body: 'hi', labels: ['bug'] })
  if (!mcpIssue.delegated || mcpIssue.jsonPayload?.action !== 'create_issue') {
    return `mcp-delegate createIssue 载荷异常：${JSON.stringify(mcpIssue)}`
  }

  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"gw","version":"1.0.0","repository":"https://github.com/acme/demo.git"}\n',
    'README.md': '# gw\n',
    'src/app.mjs': 'export const gw = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
  gitSync(dir, ['commit', '--allow-empty', '-qm', 'alice init'])
  gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])

  try {
    // 预先建一份 Todo，测试 start --create-issue 自动建单并联动重命名 todo 文件
    await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 'gw-feat', '--title', 'Gateway 功能'], { cwd: dir })
    const roots = await resolveRepoRoots(dir)
    const stRes = await handleStart({ 'create-issue': true, title: 'Gateway 功能', slug: 'gw-feat', case: '3', json: true, _ghClient: client }, roots)
    if (stRes.exitCode !== 0) return `start --create-issue 失败：exit=${stRes.exitCode}`
    const implAbs = join(dir, '.worktrees/impl-gw-feat')
    const ledger = JSON.parse(readFileSync(join(dir, '.worktrees/.state/tasks/gw-feat.json'), 'utf8'))
    if (!ledger.linkedIssues?.includes(77) || !ledger.todoFile?.includes('-issue77-') || !existsSync(join(implAbs, ledger.todoFile))) {
      return `start --create-issue 未写账本或未重命名 Todo：${JSON.stringify(ledger)}`
    }

    // Alice 认领 Issue #77 -> Bob 无 --takeover 被阻断 -> Bob 带 --takeover --reason 在 Issue+PR 双写接管 -> release -> 新认领放行
    const cAlice = await handleClaim({ task: 'gw-feat', agent: 'alice', json: true, _ghClient: client }, roots)
    if (cAlice.exitCode !== 0 || !labelsByNum.get(77)?.has('in-progress')) return 'alice claim 失败或未加 in-progress'

    const cBobBlocked = await handleClaim({ task: 'gw-feat', agent: 'bob', json: true, _ghClient: client }, roots)
    if (cBobBlocked.exitCode !== 3) return `他人重复 claim 未阻断：exit=${cBobBlocked.exitCode}`

    const cBobTakeNoReason = await handleClaim({ task: 'gw-feat', agent: 'bob', takeover: true, json: true, _ghClient: client }, roots)
    if (cBobTakeNoReason.exitCode === 0) return '--takeover 缺 --reason 未阻断'

    const cBobTake = await handleClaim({ task: 'gw-feat', agent: 'bob', pr: '88', takeover: true, reason: '交接给 Bob 跟进', json: true, _ghClient: client }, roots)
    if (cBobTake.exitCode !== 0 || !(commentsByNum.get(88) ?? []).some((c) => c.body.includes('接管认领'))) {
      return `takeover 未双写到 PR #88：${JSON.stringify(commentsByNum.get(88))}`
    }

    const relRes = await handleRelease({ task: 'gw-feat', agent: 'bob', reason: '暂缓处理', json: true, _ghClient: client }, roots)
    if (relRes.exitCode !== 0 || labelsByNum.get(77)?.has('in-progress')) {
      return 'release 未释放或未卸除 in-progress 标签'
    }

    // 释放后 Carol 无需 --takeover 即可直接认领
    const cCarol = await handleClaim({ task: 'gw-feat', agent: 'carol', json: true, _ghClient: client }, roots)
    if (cCarol.exitCode !== 0) return `release 后重新 claim 失败：exit=${cCarol.exitCode}`

    // review-pack record 实时双写结构化评论（PR 完整核对单 + Issue 阻塞摘要）到 PR #88 与 Issue #77 并贴标签；离线不阻塞且产出 delegatedPayloads
    const recChangesCode = await handleRecord({
      task: 'gw-feat', round: '1', verdict: 'changes', 'reviewer-id': 'rev-z',
      'review-token': await issueTokenFor(dir, 'gw-feat', 1),
      'must-fix': [JSON.stringify([{ id: 'C1', file: 'src/app.mjs', line: 1, summary: 'C1: 修复空指针', rootCause: '缺少空值守卫', fixHint: '先判空再返回' }])],
      'should-fix': ['补齐边界日志'],
      'pre-existing': ['src/legacy.mjs:3 历史遗留告警'],
      'fault-injection': '注入故障后变红，还原复绿', json: true, _ghClient: client,
    }, roots)
    if (recChangesCode !== 0 || !labelsByNum.get(88)?.has('changes-requested') || !labelsByNum.get(77)?.has('changes-requested')) {
      return `record changes 未双写 PR/Issue 或未贴 changes-requested：code=${recChangesCode}, labels88=${[...(labelsByNum.get(88) ?? [])]}`
    }
    const lastPrCom = (commentsByNum.get(88) ?? []).at(-1)?.body ?? ''
    for (const kw of ['### 审核不通过（退回） · Round 1', '审查来源', '逐条标准状态', '故障注入记录', '止损记录', '"action":"review"', '#### 验收标准逐条核对', '| C1 | FAIL |', '| C2 | PASS |', 'src/app.mjs:1', '缺少空值守卫', '先判空再返回', '#### Should Fix', '#### Pre-existing', 'src/legacy.mjs:3 历史遗留告警']) {
      if (!lastPrCom.includes(kw)) return `PR 评论缺关键字段 ${kw}：\n${lastPrCom}`
    }
    const lastIssueCom = (commentsByNum.get(77) ?? []).at(-1)?.body ?? ''
    for (const kw of ['### 审核不通过（退回） · Round 1', 'PR #88', '逐条状态与标签', 'src/app.mjs:1', '缺少空值守卫', 'Pre-existing 1 项']) {
      if (!lastIssueCom.includes(kw)) return `Issue 摘要评论缺关键字段 ${kw}：\n${lastIssueCom}`
    }
    if (lastIssueCom.includes('#### 验收标准逐条核对')) {
      return `Issue 摘要与 PR 全量审查表未区分详略：\n${lastIssueCom}`
    }

    // 离线/无凭据 CLI 调用绝不阻塞，且必须输出完整 delegatedPayloads 供宿主 MCP 原样双写
    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const gw = 2\n')
    gitCommitFast(implAbs, 'fix: gw null guard', { updateOnly: true })
    const offlineRec = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 'gw-feat', '--round', '2', '--verdict', 'pass', '--reviewer-id', 'rev-z',
      '--review-token', await issueTokenFor(dir, 'gw-feat', 2), '--json',
    ], { cwd: dir })
    const offlineSync = offlineRec.status === 0 ? JSON.parse(offlineRec.stdout).githubSync : null
    const delPr = offlineSync?.delegatedPayloads?.targets?.find((t) => t.kind === 'pr' && t.number === 88)
    const delIss = offlineSync?.delegatedPayloads?.targets?.find((t) => t.kind === 'issue' && t.number === 77)
    if (offlineRec.status !== 0 || offlineSync?.delegatedPayloads?.targetRepo !== 'acme/demo'
      || offlineSync?.delegatedPayloads?.label !== 'reviewed'
      || !delPr?.body?.includes('### 审核通过 · Round 2') || !delPr?.body?.includes('#### 验收标准逐条核对')
      || !delIss?.body?.includes('### 审核通过 · Round 2') || !delIss?.body?.includes('"action":"review"')) {
      return `离线 record 阻塞或缺少规范 delegatedPayloads：status=${offlineRec.status}, out=${offlineRec.stdout}, err=${offlineRec.stderr}`
    }

    // 传内部调度代号（如 coordinator-hydrogen-xhigh）认领时必须自动解析为真实 GitHub 协作者账号
    const sanitizeClaim = await handleClaim({
      task: 'gw-feat', agent: 'coordinator-hydrogen-xhigh', takeover: true, reason: '调度代号纠偏', json: true,
      _ghClient: client, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'real-alice' } }, client },
    }, roots)
    const sanitizeBody = commentsByNum.get(77)?.at(-1)?.body ?? ''
    if (sanitizeClaim.exitCode !== 0 || !sanitizeBody.includes('@real-alice') || sanitizeBody.includes('coordinator-hydrogen-xhigh')) {
      return `handleClaim 未过滤内部子代理代号：${sanitizeBody}`
    }
    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['Tier 2 review 槽同步防空 Diff、changes 清零 reviewPassedHead、STOP_LOSS 人工解锁与子包/Workspace 防毒化', async () => {
  const { mountSharedDeps, unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
  const dir = tmpProject({
    '.gitignore': 'node_modules/\nfrontend/node_modules/\nbackend/node_modules/\n.worktrees/\n',
    'package.json': '{"name":"mono","version":"1.0.0","workspaces":["frontend","backend"]}\n',
    'pnpm-workspace.yaml': 'packages:\n  - frontend\n  - backend\n',
    'frontend/package.json': '{"name":"fe","version":"1.0.0"}\n',
    'frontend/package-lock.json': '{"lockfileVersion":3}\n',
    'backend/package.json': '{"name":"be","version":"1.0.0"}\n',
    'backend/package-lock.json': '{"lockfileVersion":3}\n',
    'AGENTS.md': '# mono\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nmerge-gate: exit 0\n```\n',
    'src/app.mjs': 'export const v = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
  mkdirSync(join(dir, 'frontend/node_modules/pkg'), { recursive: true })
  writeFileSync(join(dir, 'frontend/node_modules/pkg/i.js'), '1\n')
  mkdirSync(join(dir, 'backend/node_modules/pkg'), { recursive: true })
  writeFileSync(join(dir, 'backend/node_modules/pkg/i.js'), '1\n')
  // 在根 node_modules 放入指向主仓源码的 Workspace 软链，触发防毒化自动隔离
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(join(dir, 'frontend'), join(dir, 'node_modules/fe-ws'), linkType)

  try {
    const { resolveRepoRoots, readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const roots = await resolveRepoRoots(dir)
    const t2Init = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 't2-feat', '--title', 'T2 Feature'], { cwd: dir })
    if (t2Init.status !== 0) return `t2 doc-plan init 失败：${t2Init.stderr}`
    const stRes = await handleStart({ task: 't-t2', case: '3', slug: 't2-feat' }, roots)
    if (stRes.exitCode !== 0) return `Tier 2 start 失败：${stRes.exitCode}`
    const l = readTaskLedger(dir, 't-t2')
    const implAbs = join(dir, l.worktreePath)
    const revAbs = join(dir, l.reviewWorktreePath)
    if (!l.todoFile || !existsSync(join(implAbs, l.todoFile))) {
      return `Tier 2 start 未迁入关联 todoFile：${JSON.stringify(l)}`
    }
    if (existsSync(revAbs)) return 'Tier 2 start 不应在 baseSha 预创建陈旧 review 空槽'

    // Workspace 软链指回主仓 -> 根 node_modules 隔离；backend 与 frontend 均共享；改 frontend 锁只隔离 frontend
    if (l.depsMode !== 'partial') {
      return `未局部隔离 Workspace 软链并保留子包共享依赖：depsMode=${l.depsMode}`
    }
    if (!existsSync(join(implAbs, 'frontend/node_modules/pkg/i.js')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
      return '子包独立锁比对未挂载子包共享依赖'
    }
    const excludeTxt = readFileSync(join(dir, '.git/info/exclude'), 'utf8')
    if (!excludeTxt.split('\n').some((line) => line.trim() === '/backend/node_modules')) {
      return `mountSharedDeps 未写入无尾斜杠软链忽略规则：${excludeTxt}`
    }
    unmountSharedDeps(dir, implAbs, { mode: 'deps' })
    writeFileSync(join(implAbs, 'frontend/package-lock.json'), '{"lockfileVersion":3,"changed":1}\n')
    const mPartial = mountSharedDeps(dir, implAbs)
    if (existsSync(join(implAbs, 'frontend/node_modules')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
      return `frontend 锁变更未做到单包隔离：${JSON.stringify(mPartial)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['Tier 2 review 槽同步防空 Diff、changes 清零 reviewPassedHead 与 STOP_LOSS 人工解锁', async () => {
  const dir = tmpProject({
    '.gitignore': 'node_modules/\n.worktrees/\n',
    'package.json': '{"name":"t2-rev","version":"1.0.0"}\n',
    'AGENTS.md': '# t2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nmerge-gate: exit 0\n```\n',
    'src/app.mjs': 'export const v = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
  try {
    const { resolveRepoRoots, readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleFinalize, handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleMerge, handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleRecord, handleOverride } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const roots = await resolveRepoRoots(dir)

    const t2Init = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 't2-feat', '--title', 'T2 Feature'], { cwd: dir })
    if (t2Init.status !== 0) return `t2 doc-plan init 失败：${t2Init.stderr}`
    await handleStart({ task: 't-t2', case: '3', slug: 't2-feat' }, roots)
    const l = readTaskLedger(dir, 't-t2')
    const implAbs = join(dir, l.worktreePath)
    const revAbs = join(dir, l.reviewWorktreePath)

    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 2\n')
    writeFileSync(
      join(implAbs, l.todoFile),
      readFileSync(join(implAbs, l.todoFile), 'utf8').replace('<two-way | one-way>', 'two-way').replace(/<[^>]+>/g, '`src/app.mjs`').replace(/- \[ \]/g, '- [x]'),
    )
    gitCommitFast(implAbs, 'feat: v2')
    await handleFinalize({ task: 't-t2' }, roots)
    gitCommitFast(implAbs, 'docs: archive')
    await handleVerify({ task: 't-t2', mode: 'gate' }, roots)
    const subRes = await handleSubmit({ task: 't-t2' }, roots)
    if (subRes.exitCode !== 0) return `Tier 2 submit 失败：exit=${subRes.exitCode}`
    const ledgerAfterSub = readTaskLedger(dir, 't-t2')
    if (!existsSync(revAbs) || (ledgerAfterSub.reviewWorktreeHead ?? '') === l.baseSha) {
      return `submit 未推进 review 槽到最新 HEAD：${JSON.stringify(ledgerAfterSub)}`
    }

    const pack = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 't-t2', '--json'], { cwd: dir })
    const packJson = JSON.parse(pack.stdout)
    if ((packJson.diff?.files?.length ?? 0) === 0 || packJson.diffText !== undefined) {
      return `review-pack 空 diff 或未默认精简 diffText：${pack.stdout.slice(0, 400)}`
    }

    // Round 1 pass 后再提交新改动并 verify（未复审），merge 必须拦截陈旧 reviewPassedHead
    await handleRecord({ task: 't-t2', round: '1', verdict: 'pass', 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 't-t2', 1) }, roots)
    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 3\n')
    gitCommitFast(implAbs, 'feat: v3', { updateOnly: true })
    await handleVerify({ task: 't-t2', mode: 'gate' }, roots)
    const mStaleHead = await handleMerge({ task: 't-t2' }, roots)
    if (mStaleHead.exitCode === 0) return '新提交仅 verify 未复审却被 merge 放行了（reviewPassedHead 校验失效）'

    // Round 2 changes 必须清空 reviewPassedHead -> merge 阻断；再提交新 HEAD 触发 Round 3 stop-loss 后 override 解锁
    await handleRecord({ task: 't-t2', round: '2', verdict: 'changes', 'must-fix': ['C1: src/app.mjs:1 bug'], 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 't-t2', 2) }, roots)
    const t2AfterR2 = readTaskLedger(dir, 't-t2')
    if (t2AfterR2.reviewPassedHead !== null) return `verdict=changes 未清空 reviewPassedHead：${t2AfterR2.reviewPassedHead}`
    const mBlocked = await handleMerge({ task: 't-t2' }, roots)
    if (mBlocked.exitCode === 0) return 'verdict=changes 后 merge 竟然放行了'

    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 4\n')
    gitCommitFast(implAbs, 'feat: v4', { updateOnly: true })
    await handleVerify({ task: 't-t2', mode: 'gate' }, roots)
    const r3Stop = await handleRecord({ task: 't-t2', round: '3', verdict: 'changes', 'must-fix': ['C1: src/app.mjs:1 bug'], 'reviewer-id': 'rev-a', 'review-token': await issueTokenFor(dir, 't-t2', 3) }, roots)
    if (r3Stop !== 4) return `Round 3 未触发 STOP_LOSS_ESCALATE (exit=4)：${r3Stop}`
    const ov = await handleOverride({ task: 't-t2', 'human-approved': true, reason: 'human verified' }, roots)
    if (ov !== 0) return `override 失败：${ov}`
    const mOk = await handleMerge({ task: 't-t2', 'human-approved': true, reason: 'human verified' }, roots)
    if (mOk.exitCode !== 0) return `override 后 merge 仍阻断：${mOk.exitCode}`
    const clOk = await handleCleanup({ task: 't-t2', confirm: true }, roots)
    if (clOk.exitCode !== 0) return `cleanup 失败：${clOk.exitCode}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['远端 CI 合并硬门禁：fail/pending 阻断、汇总重跑全绿放行与无工作流跳过正反双向', async () => {
  const ciDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# ci-gate\n\n```yaml\nquick-test: exit 0\n```\n',
    'src/app.mjs': 'export const c = 1\n',
  })
  gitInit(ciDir, { branch: 'main', name: 't', email: 't@t.t', origin: 'https://github.com/acme/ci-demo.git' })
  try {
    const { readTaskLedger, writeTaskLedger, resolveRepoRoots: resRoots, summarizeCommitChecks } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleMerge } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const roots = await resRoots(ciDir)
    const st = await handleStart({ task: 'ci-t', case: '2', slug: 'ci-t', 'clone-choice': 'standalone' }, roots)
    if (st.exitCode !== 0) return `ciDir start 失败：${st.exitCode}`
    const ciImpl = join(ciDir, '.worktrees', 'impl-ci-t')
    let mergeCalls = 0
    const makeProbe = (checksRes) => ({
      env: { trackB: { tier: 'gh-cli', login: 'rev-ci' } },
      client: {
        tier: 'gh-cli',
        async getCommitChecks() { return checksRes },
        async mergePr() { mergeCalls += 1; return { ok: true, merged: true, state: 'MERGED' } },
        async postComment() { return { ok: true, id: 1, verifiedReadback: true } },
        async removeLabel() { return { ok: true } },
      },
    })
    const prepHead = async (mode = 'quick') => {
      const ver = await handleVerify({ task: 'ci-t', mode }, roots)
      if (ver.exitCode !== 0) throw new Error(`verify 失败：${ver.exitCode}`)
      const curSha = gitSync(ciImpl, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const rec = await handleRecord({ task: 'ci-t', round: '1', verdict: 'pass', 'reviewer-id': 'rev-ci', 'review-token': await issueTokenFor(ciDir, 'ci-t', 1) }, roots)
      if (rec !== 0) throw new Error(`record 失败：${rec}`)
      const led = readTaskLedger(ciDir, 'ci-t')
      writeTaskLedger(ciDir, { ...led, prNumber: 101, implementerId: 'dev-ci', lastReview: { ...(led.lastReview ?? {}), headSha: curSha } })
    }
    writeFileSync(join(ciImpl, 'src/app.mjs'), 'export const c = 2\n')
    gitCommitFast(ciImpl, 'feat: c2', { updateOnly: true })
    await prepHead('quick')
    const rNoWf = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(summarizeCommitChecks([], [])) }, roots)
    if (rNoWf.exitCode !== 0 || mergeCalls !== 1) return `无检查工作流时 bucket=none 未放行合并：code=${rNoWf.exitCode}, calls=${mergeCalls}`

    mkdirSync(join(ciImpl, '.github/workflows'), { recursive: true })
    writeFileSync(join(ciImpl, '.github/workflows/check.yml'), 'name: check\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n')
    gitCommitFast(ciImpl, 'ci: add check workflow')
    await prepHead('gate')
    const rPend = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(summarizeCommitChecks([{ id: 1, name: 'gates (18)', status: 'in_progress', conclusion: null }], [])) }, roots)
    const rFail = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(summarizeCommitChecks([{ id: 1, name: 'gates (18)', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'check', status: 'completed', conclusion: 'skipped' }], [])) }, roots)
    const rNone = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(summarizeCommitChecks([], [])) }, roots)
    if (rPend.exitCode === 0 || rFail.exitCode === 0 || rNone.exitCode === 0 || mergeCalls !== 1) {
      return `远端 CI 失败未阻断合并：pend=${rPend.exitCode}, fail=${rFail.exitCode}, none=${rNone.exitCode}, mergeCalls=${mergeCalls}`
    }
    const rerunChecks = summarizeCommitChecks([
      { id: 1, name: 'gates (18)', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'gates (18)', status: 'completed', conclusion: 'success' },
      { id: 4, name: 'check', status: 'completed', conclusion: 'success' },
    ], [{ context: 'ext/lint', state: 'success' }])
    const rPass = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(rerunChecks) }, roots)
    if (rPass.exitCode !== 0 || mergeCalls !== 2) return `远端 CI 重跑全绿后未放行合并：code=${rPass.exitCode}, calls=${mergeCalls}`
    return true
  } finally { rmTree(ciDir) }
}])

cases.push(['五套技能全场景联通：dev-govern 联动 explore/plan/flow 且产出 0 错 Todo + URL 直传正反双向', async () => {
  const { mkdirSync: mkd, rmSync: rmf } = await import('node:fs')
  // 1. dev-govern plan --write-todo 联动 dev-explore / dev-plan / dev-flow，并按需在 lightweight 降级
  const govDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# gov-link\n',
    'AGENTS.md': [
      '# Gov Link',
      '',
      '## 项目定位',
      'Gov test',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: exit 0',
      'arch-rules: src/ui/** -> src/db/**',
      '```',
      '',
      '- Old ref: `src/missing-old.mjs`',
    ].join('\n'),
    'src/db/conn.mjs': 'export const db = 1\n',
    'src/ui/app.mjs': "import { db } from '../db/conn.mjs'\n// TODO: clean me\nexport const ui = db\n",
    '.agents/skills/dev-explore/SKILL.md': '---\nname: dev-explore\ndescription: explore\n---\n',
    '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\ndescription: plan\n---\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
    '.agents/skills/dev-govern/SKILL.md': '---\nname: dev-govern\ndescription: govern\n---\n',
  })
  gitInit(govDir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    const govRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['plan', '--write-todo', '--json'], { cwd: govDir })
    if (govRes.status !== 0) return `govern-audit plan --write-todo 失败：${govRes.stderr}`
    const gj = JSON.parse(govRes.stdout)
    const todoRel = gj.plan?.todoRel
    if (!todoRel || !existsSync(join(govDir, todoRel))) {
      return `govern-audit --write-todo 未写出 Todo：${JSON.stringify(gj.plan)}`
    }
    const nsText = (gj.nextSteps ?? []).join('\n')
    if (!nsText.includes('repo-map.mjs') || !nsText.includes('doc-plan.mjs" audit') || !nsText.includes('doc-plan.mjs" triage') || !nsText.includes('flow.mjs" start')) {
      return `govern-audit nextSteps 缺少兄弟技能联动：${nsText}`
    }
    const audTodo = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', todoRel, '--json'], { cwd: govDir })
    if (audTodo.status !== 0) {
      return `govern 生成的 Todo 未通过 doc-plan audit：${audTodo.stdout} ${audTodo.stderr}`
    }

    // 缺少兄弟技能时应优雅降级为纯 Git 指引
    for (const sk of ['dev-explore', 'dev-plan', 'dev-flow']) {
      rmf(join(govDir, '.agents', 'skills', sk), { recursive: true, force: true })
    }
    const govMin = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['plan', '--json'], { cwd: govDir })
    const gmj = JSON.parse(govMin.stdout)
    const gmText = (gmj.nextSteps ?? []).join('\n')
    if (gmText.includes('repo-map.mjs') || gmText.includes('doc-plan.mjs') || gmText.includes('flow.mjs start') || !gmText.includes('git switch -c')) {
      return `缺省兄弟技能时 govern nextSteps 未降级：${gmText}`
    }
    return true
  } finally { rmTree(govDir) }
}])

cases.push(['全链路 URL 直传、finalize 实现说明拦截、submit 零脏文件回填 PR 与 cleanup 细粒度保留', async () => {
  const { mkdirSync: mkd } = await import('node:fs')
  // 2. 全链路直接粘贴 Issue/PR URL（正反双向）
  const urlDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# url-test\n',
    'src/app.mjs': 'export const u = 1\n',
  })
  gitInit(urlDir, { branch: 'main', name: 'u', email: 'u@u.u' })
  gitSync(urlDir, ['commit', '--allow-empty', '-qm', 'init'])
  gitSync(urlDir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
  mkd(join(urlDir, '.worktrees'), { recursive: true })
  try {
    const dpOk = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'todo', '--slug', 'url-test', '--title', 'URL 测试',
      '--issue', 'https://github.com/acme/demo/issues/42', '--json',
    ], { cwd: urlDir })
    if (dpOk.status !== 0 || !JSON.parse(dpOk.stdout).file?.includes('-issue42-')) {
      return `doc-plan --issue URL 失败：${dpOk.stdout} ${dpOk.stderr}`
    }
    const dpBad = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'todo', '--slug', 'bad-url', '--title', 'Bad URL',
      '--issue', 'https://github.com/acme/demo/pull/88',
    ], { cwd: urlDir })
    if (dpBad.status === 0) return 'doc-plan --issue 误放行了 PR URL'

    const stPrPos = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
      'start', 'https://github.com/acme/demo/pull/88', '--pr-ref', 'HEAD', '--json',
    ], { cwd: urlDir })
    if (stPrPos.status !== 0 || JSON.parse(stPrPos.stdout).prNumber !== 88) {
      return `flow start 位置 PR URL 失败：${stPrPos.stdout} ${stPrPos.stderr}`
    }

    const stExt = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
      'start', '--external-pr', 'https://github.com/acme/demo/pull/89', '--pr-ref', 'HEAD', '--json',
    ], { cwd: urlDir })
    if (stExt.status !== 0 || JSON.parse(stExt.stdout).role !== 'inbound-external-pr') {
      return `flow start --external-pr URL 失败：${stExt.stdout} ${stExt.stderr}`
    }

    const rpPos = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
      'https://github.com/acme/demo/pull/89', '--json',
    ], { cwd: urlDir })
    if (rpPos.status !== 0 || !JSON.parse(rpPos.stdout).worktreeRoot?.endsWith('.worktrees/review-pr-89')) {
      return `review-pack 位置 PR URL 失败：${rpPos.stdout} ${rpPos.stderr}`
    }

    const rpBad = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
      '--pr', 'https://github.com/acme/demo/issues/42',
    ], { cwd: urlDir })
    if (rpBad.status !== 2) return `review-pack --pr 未拒绝 Issue URL：status=${rpBad.status}`

    // finalize 实现说明：大写占位词阻断，合法 Todo / docs/todo/ 放行
    const { resolveRepoRoots: resUrlRoots, readTaskLedger: readUrlLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart: startUrl } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleFinalize: finUrl, handleVerify: verUrl, handleSubmit: subUrl } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleCleanup: clUrl } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const urlRoots = await resUrlRoots(urlDir)

    const spInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'spec', '--slug', 'note-case', '--title', 'Impl Note Case', '--json',
    ], { cwd: urlDir })
    const spRel = JSON.parse(spInit.stdout).file
    const placeholderTodo = `${'TO'}DO: fill later`
    hydrateGeneratedDoc(join(urlDir, spRel), { filled: '真实值' })
    const spTxt0 = readFileSync(join(urlDir, spRel), 'utf8')
    writeFileSync(join(urlDir, spRel), spTxt0
      .replace(/^- \[ \] C1: .*$/m, '- [x] C1: verified')
      .replace(/^- \[ \] C2: .*$/m, '- [x] C2: verified')
      .replace(/(- \*\*实际落地摘要\*\*)：.*$/m, `$1：- ${placeholderTodo}`))
    gitCommitFast(urlDir, 'spec todo', { files: [spRel] })
    await startUrl({ task: 'note-case', slug: 'note-case', case: '4' }, urlRoots)
    const finBad = await finUrl({ task: 'note-case' }, urlRoots)
    if (finBad.exitCode === 0) {
      return `finalize 未拦截大写 placeholder：status=${finBad.exitCode}`
    }
    const spWtAbs = join(urlDir, '.worktrees/impl-note-case', spRel)
    writeFileSync(spWtAbs, readFileSync(spWtAbs, 'utf8').replace(`- ${placeholderTodo}`, '- 已按 Todo 与 docs/todo/ 收尾验证。'))
    gitCommitFast(join(urlDir, '.worktrees/impl-note-case'), 'spec real note', { updateOnly: true })
    const finOk = await finUrl({ task: 'note-case' }, urlRoots)
    if (finOk.exitCode !== 0) return `finalize 误拦合法 Todo 实现说明：exit=${finOk.exitCode}`

    // submit 创建 PR 后回填 archived SPEC/Todo 的 pr 字段（不再抛 today is not defined）
    const bareRem = tmpProject({})
    gitInitBare(bareRem)
    const bareUrl = bareRem.replace(/\\/g, '/')
    try {
      const implNote = join(urlDir, '.worktrees/impl-note-case')
      gitSync(urlDir, ['config', `url.${bareUrl}.pushInsteadOf`, 'https://github.com/acme/demo.git'])
      gitCommitFast(implNote, 'archive spec')
      const verOk = await verUrl({ task: 'note-case', cmd: 'exit 0' }, urlRoots)
      if (verOk.exitCode !== 0) return `note-case verify 失败：exit=${verOk.exitCode}`
      const postedComments = []
      const mockSubmitClient = {
        tier: 'gh-cli',
        async createPr({ title }) { return { ok: true, number: 99, url: 'https://github.com/acme/demo/pull/99', title } },
        async postComment(p) { postedComments.push(p); return { ok: true, id: postedComments.length, verifiedReadback: true } },
      }
      const subRes = await subUrl({ task: 'note-case', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'url-dev' } }, client: mockSubmitClient } }, urlRoots)
      const noteLedger = readUrlLedger(urlDir, 'note-case')
      const noteDirtyAfterPush = gitSync(implNote, ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
      if (subRes.exitCode !== 0 || noteLedger?.prNumber !== 99 || noteDirtyAfterPush !== '' || !postedComments.some((c) => c.number === 99 && c.body.includes('@url-dev') && c.body.includes('### 提交待审'))) {
        return `handleSubmit 零脏文件/账本 prNumber 或首提 PR 评论失败：code=${subRes.exitCode}, pr=${noteLedger?.prNumber}, dirty="${noteDirtyAfterPush}"`
      }
    } finally { rmTree(bareRem) }

    // flow cleanup 细粒度保留：仅删 review worktree，保留 impl worktree 与本地分支
    if (!existsSync(join(urlDir, '.worktrees/review-note-case'))) {
      gitSync(urlDir, ['worktree', 'add', '--detach', join(urlDir, '.worktrees/review-note-case'), 'HEAD'])
    }
    const clOnlyRev = await clUrl({ task: 'note-case', confirm: true, 'only-review-worktree': true }, urlRoots)
    if (clOnlyRev.exitCode !== 0 || existsSync(join(urlDir, '.worktrees/review-note-case')) || !existsSync(join(urlDir, '.worktrees/impl-note-case'))) {
      return `cleanup --only-review-worktree 未按粒度保留：exit=${clOnlyRev.exitCode}`
    }

    return true
  } finally {
    rmTree(urlDir)
  }
}])

cases.push(['doc-plan approve 移交 flow start 与静态回归（mergeAuthority / detectGateWeakeningInEntry）', async () => {
  const apDir = tmpProject({ 'README.md': '# approve\n' })
  try {
    const apInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'spec', '--slug', 'app-next', '--title', 'Approve Next', '--issue', '55', '--json',
    ], { cwd: apDir })
    const apRel = JSON.parse(apInit.stdout).file
    writeFileSync(join(apDir, apRel), readFileSync(join(apDir, apRel), 'utf8')
      .replace('<two-way | one-way>', 'two-way')
      .replace(/<[^>]+>/g, '真实值')
      .replace('- [ ] C1: 真实值', '- [x] C1: verified')
      .replace('- [ ] C2: 真实值', '- [x] C2: verified'))
    await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', apRel, '--reviewer', 'critic-next'], { cwd: apDir })
    const apRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', apRel, '--json'], { cwd: apDir })
    const apJson = apRes.status === 0 ? JSON.parse(apRes.stdout) : null
    if (!apJson?.nextStep?.includes('flow.mjs" start') || !apJson?.nextStep?.includes('--issue 55')) {
      return `doc-plan approve 缺少移交 flow start 提示：${apRes.stdout} ${apRes.stderr}`
    }

    const { parseAgentsProfile, hasHumanMergeAuthority, detectGateWeakeningInEntry } = await import('../../kit/skills/lib/shared.mjs')
    const repoProf = parseAgentsProfile(SKILL_ROOT)
    if (repoProf.mergeAuthority !== 'reviewer') {
      return `AGENTS.md 协作说明正文误触发 mergeAuthority=${repoProf.mergeAuthority}`
    }
    if (!hasHumanMergeAuthority('## 取舍\n- `merge-authority`: human\n') || hasHumanMergeAuthority('## 协作\n保守仓写 `merge-authority: human`。\n')) {
      return 'hasHumanMergeAuthority 区间判定正反异常'
    }
    const fpStatic = detectGateWeakeningInEntry({
      file: 'kit/skills/lib/static-gates.mjs',
      status: 'A',
      added: ["  reason: '新增校验旁路标记（--no-verify / || true）'"],
    })
    const fpWorkflow = detectGateWeakeningInEntry({
      file: '.github/workflows/release.yml',
      status: 'M',
      added: ['        run: |', '          echo "::error::请检查工作流 permissions: contents: write"'],
    })
    const tpWorkflow = detectGateWeakeningInEntry({
      file: '.github/workflows/check.yml',
      status: 'M',
      added: ['    permissions:', '      contents: write'],
    })
    const tpPkg = detectGateWeakeningInEntry({
      file: 'package.json',
      status: 'M',
      added: ['    "test": "vitest --passWithNoTests"'],
    })
    if (fpStatic.length > 0 || fpWorkflow.length > 0 || tpWorkflow.length === 0 || tpPkg.length === 0) {
      return `detectGateWeakeningInEntry 正反断言异常：fpS=${fpStatic.length}, fpW=${fpWorkflow.length}, tpW=${tpWorkflow.length}, tpP=${tpPkg.length}`
    }
    return true
  } finally { rmTree(apDir) }
}])

// #51：`git worktree remove --force` 会跟随 junction 递归删除。工具早先只解绑
// node_modules / .venv / venv 三种名字，其余名字（vendor、shared、data……）一个都发现
// 不了，于是「清理 worktree」把主仓的数据删干净，退出码还是 0。
//
// 判据必须是「是不是链接」，不是「叫什么名字」——所以这里用五个不同的名字打它，
// 其中一个还是中文，另加一条反向：worktree 内部互指的链接不该被当成外链。
cases.push(['cleanup 外链保护：任意名字的 junction 都必须被检出并默认拒绝（反向：无外链照常放行）', async () => {
  const { scanOutboundLinks, unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
  const { handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { resolveRepoRoots, readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
  const names = ['vendor', 'shared', 'data', 'packages', '中文名']
  const dir = tmpProject({
    '.gitignore': `.worktrees/\n${names.map((n) => `${n}/\n`).join('')}`,
    'README.md': '# outbound\n',
  })
  gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
  for (const name of names) {
    mkdirSync(join(dir, name, 'precious'), { recursive: true })
    writeFileSync(join(dir, name, 'precious', 'SURVIVE.txt'), 'MUST SURVIVE')
  }
  gitCommitFast(dir, 'add shared dirs')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    const roots = await resolveRepoRoots(dir)
    const started = await handleStart({ task: 'outbound', case: '3', slug: 'outbound' }, roots)
    if (started.exitCode !== 0) return `start 失败：${started.exitCode}`
    const ledger = readTaskLedger(dir, 'outbound')
    const implAbs = join(dir, ledger.worktreePath)

    for (const name of names) symlinkSync(join(dir, name), join(implAbs, name), linkType)
    // 深一层的同名链接：判据是「这条路径是不是链接、指向是否在外面」，与它在第几层无关。
    // 只测根目录那一层时，把遍历改成只看根目录也能过——那不是这条判据的意思。
    mkdirSync(join(implAbs, 'nested', 'deeper'), { recursive: true })
    symlinkSync(join(dir, 'data'), join(implAbs, 'nested', 'deeper', 'data-deep'), linkType)
    // 反向：worktree 内部互指的链接不该被当成外链
    mkdirSync(join(implAbs, 'inner'), { recursive: true })
    writeFileSync(join(implAbs, 'inner', 'a.txt'), 'inner\n')
    symlinkSync(join(implAbs, 'inner'), join(implAbs, 'inner-link'), linkType)

    const scan = scanOutboundLinks(implAbs)
    const found = scan.outbound.map((o) => o.path).sort()
    const expected = [...names, 'nested/deeper/data-deep'].sort()
    if (found.length !== expected.length) {
      return `外链检出数不对：期望 ${expected.length} 个（含深一层的那个），实际 ${found.length} 个（${found.join(', ')}）——按名字筛或只看根目录都会漏`
    }
    if (!found.includes('nested/deeper/data-deep')) return `深一层的链接没被检出：${found.join(', ')}`
    if (scan.internal.length !== 1) return `worktree 内部链接被误判成外链：internal=${JSON.stringify(scan.internal.map((i) => i.path))}`

    const denied = unmountSharedDeps(dir, implAbs)
    if (denied.ok !== false) return '存在外链时 unmountSharedDeps 必须拒绝，实际放行了'
    if (denied.blocked.length !== expected.length) return `拒绝理由不全：blocked=${denied.blocked.length}（期望 ${expected.length}）`
    if (denied.unmounted.length !== 0) return '被拒绝时不得解绑任何链接'

    // 真实清理路径：带 --confirm --force 也必须被拦住
    const cl = await handleCleanup({ task: 'outbound', confirm: true, force: true, json: true }, roots)
    if (cl.exitCode === 0) return 'cleanup --confirm --force 带着外链删成功了——主仓数据会被删穿'
    for (const name of names) {
      if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `cleanup 之后主仓 ${name}/precious 没了——这就是删穿`
    }
    // 深一层的链接目标同样要完好
    if (!existsSync(join(dir, 'data', 'precious', 'SURVIVE.txt'))) return 'cleanup 之后深一层链接的目标没了'

    // 显式逐个放行才允许删；且只删链接，不碰目标
    // 同一个集合：被拦下的那些目标，事后也必须在完好校验的范围内。
    // 反证方式：先让 3 条被拦下，再逐条放行其中 1 条；两个阶段结束后，所有目标都还在。
    for (const name of names.slice(0, 3)) {
      if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `被拦下阶段目标就没了：${name}`
    }

    const allowed = unmountSharedDeps(dir, implAbs, { allowOutbound: expected })
    if (allowed.ok !== true) return `显式放行后仍被拒：${JSON.stringify(allowed.blocked)}`
    if (allowed.scanned?.outbound !== expected.length) {
      return `完好校验的集合与删除前扫描不一致：scanned.outbound=${allowed.scanned?.outbound}，扫描=${expected.length}`
    }
    if (allowed.unmounted.length !== expected.length) return `放行后解绑数不对：${allowed.unmounted.length}（期望 ${expected.length}）`
    for (const name of names) {
      if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `解绑碰了目标内容：主仓 ${name}/precious 没了`
      if (existsSync(join(implAbs, name))) return `解绑后链接还在：${name}`
    }
    return true
  } finally { rmTree(dir) }
}])

// 反向：完全没有外链的普通 worktree，清理必须照常成功。保护不能变成误伤。
cases.push(['cleanup 外链保护反向：工具自己挂的 node_modules 照常解绑放行', async () => {
  const { scanOutboundLinks, unmountSharedDeps, mountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { resolveRepoRoots, readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'package.json': '{"name":"plain","version":"1.0.0"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'README.md': '# plain\n',
  })
  gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), '1\n')
  gitCommitFast(dir, 'add deps')
  try {
    const roots = await resolveRepoRoots(dir)
    const started = await handleStart({ task: 'plain', case: '3', slug: 'plain' }, roots)
    if (started.exitCode !== 0) return `start 失败：${started.exitCode}`
    const ledger = readTaskLedger(dir, 'plain')
    const implAbs = join(dir, ledger.worktreePath)
    mountSharedDeps(dir, implAbs)

    const scan = scanOutboundLinks(implAbs)
    if (!scan.outbound.some((o) => o.path === 'node_modules')) {
      return `工具自己挂的 node_modules 没被扫出来：${JSON.stringify(scan.outbound.map((o) => o.path))}`
    }
    if (!existsSync(join(dir, 'node_modules', 'pkg', 'i.js'))) return '主仓 node_modules 被误删'

    const res = unmountSharedDeps(dir, implAbs, { allowOutbound: ['node_modules'] })
    if (res.ok !== true) return `白名单内的依赖挂载被误拦：${JSON.stringify(res.blocked)}`
    if (!existsSync(join(dir, 'node_modules', 'pkg', 'i.js'))) return '解绑 node_modules 时删了主仓内容'
    if (existsSync(join(implAbs, 'node_modules'))) return '解绑后 node_modules 链接还在'
    return true
  } finally { rmTree(dir) }
}])

}
