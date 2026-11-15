/**
 * fixtures-flow.mjs —— 研发流转夹具：flow 全生命周期、审查槽推进、认领协同与远端 CI 合并门禁。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_ROOT, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerFlowCases(cases) {
cases.push(['flow.mjs：smoke --target 替换与缺参阻断、门禁弱化阻断与人工豁免、干净增量测试放行', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# flow-w2',
      '',
      '```yaml',
      'quick-test: node -e "process.exit(0)"',
      'smoke-verify: node scripts/smoke.mjs --file {target}',
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
    const s1 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2', '--case', '1', '--slug', 'w2-gate', '--json'], { cwd: dir })
    if (s1.status !== 0) return `start t-w2 失败：${s1.stderr}`
    const implW2 = join(dir, JSON.parse(s1.stdout).worktreePath)

    const missTarget = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke'], { cwd: dir })
    if (missTarget.status === 0 || !/MISSING_TARGET_ARG/.test(missTarget.stderr)) {
      return `smoke 缺 --target 未拦截：${missTarget.stderr}`
    }
    const badTarget = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'a;echo'], { cwd: dir })
    if (badTarget.status === 0 || !/INVALID_TARGET_ARG/.test(badTarget.stderr)) {
      return `smoke 非法元字符 --target 未拦截：${badTarget.stderr}`
    }
    const okSmoke = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'src/ok.mjs', '--json'], { cwd: dir })
    if (okSmoke.status !== 0) return `smoke --target src/ok.mjs 失败：${okSmoke.stderr}`
    if (!JSON.parse(okSmoke.stdout).cmd.includes('src/ok.mjs')) return `smoke 未替换 {target}：${okSmoke.stdout}`

    // 2. 删减测试断言（门禁弱化）-> gate verify + 独立审查后 merge 必须 exit 4 (BLOCKED_GATE_WEAKENING)
    writeFileSync(join(implW2, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\n')
    gitSync(implW2, ['add', '-A'])
    gitSync(implW2, ['commit', '-qm', 'weaken test'])

    const vWeak = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'gate'], { cwd: implW2 })
    if (vWeak.status !== 0) return `verify 失败：${vWeak.stderr}`
    await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-w2', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-w2'], { cwd: dir })

    const mGate = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--json'], { cwd: dir })
    if (mGate.status !== 4) return `门禁弱化改动未被 merge 拦截：exit=${mGate.status} out=${mGate.stdout} err=${mGate.stderr}`
    if (JSON.parse(mGate.stdout).code !== 'BLOCKED_GATE_WEAKENING') return `缺少 BLOCKED_GATE_WEAKENING：${mGate.stdout}`

    // 3. 人工豁免 --human-approved 经临时 --detach 试合并入 main
    const mApproved = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--human-approved', '--json'], { cwd: dir })
    if (mApproved.status !== 0 || JSON.parse(mApproved.stdout).status !== 'merged') {
      return `--human-approved merge 失败：exit=${mApproved.status} out=${mApproved.stdout} err=${mApproved.stderr}`
    }

    // 4. 反面证伪：新增测试断言（非弱化）无 --human-approved 直接合并放行
    const s2 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2-clean', '--case', '1', '--slug', 'w2-clean', '--json'], { cwd: dir })
    if (s2.status !== 0) return `start t-w2-clean 失败：${s2.stderr}`
    const implClean = join(dir, JSON.parse(s2.stdout).worktreePath)
    writeFileSync(join(implClean, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\nassert.equal(3, 3)\n')
    gitSync(implClean, ['add', '-A'])
    gitSync(implClean, ['commit', '-qm', 'add assertion'])
    const vClean = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2-clean', '--mode', 'full'], { cwd: implClean })
    if (vClean.status !== 0) return `clean verify 失败：${vClean.stderr}`
    await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-w2-clean', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-w2'], { cwd: dir })
    const mClean = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2-clean', '--json'], { cwd: dir })
    if (mClean.status !== 0) return `正常增量测试被 merge 误杀为门禁弱化：exit=${mClean.status} out=${mClean.stdout} err=${mClean.stderr}`
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

    // review-pack record 实时双写四字段评论到 PR #88 与 Issue #77 并贴标签；离线绝不阻塞
    const recChangesCode = await handleRecord({
      task: 'gw-feat', round: '1', verdict: 'changes', 'reviewer-id': 'rev-z',
      'must-fix': ['C1: 修复空指针'], 'fault-injection': '注入故障后变红，还原复绿', json: true, _ghClient: client,
    }, roots)
    if (recChangesCode !== 0 || !labelsByNum.get(88)?.has('changes-requested') || !labelsByNum.get(77)?.has('changes-requested')) {
      return `record changes 未双写 PR/Issue 或未贴 changes-requested：code=${recChangesCode}, labels88=${[...(labelsByNum.get(88) ?? [])]}`
    }
    const prComs = commentsByNum.get(88) ?? []
    const lastPrCom = prComs[prComs.length - 1]?.body ?? ''
    for (const kw of ['审查来源', '逐条标准状态', '故障注入记录', '止损记录', '"action":"review"']) {
      if (!lastPrCom.includes(kw)) return `PR 评论缺关键字段 ${kw}：\n${lastPrCom}`
    }

    // 离线/无凭据 CLI 调用绝不阻塞（exit 0；需提交新 HEAD 后再触发 Round 2 复审）
    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const gw = 2\n')
    gitSync(implAbs, ['add', '-A'])
    gitSync(implAbs, ['commit', '-qm', 'fix: gw null guard'])
    const offlineRec = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 'gw-feat', '--round', '2', '--verdict', 'pass', '--reviewer-id', 'rev-z', '--json',
    ], { cwd: dir })
    if (offlineRec.status !== 0 || !JSON.parse(offlineRec.stdout).githubSync) {
      return `离线 record 阻塞或缺少 githubSync 提示：status=${offlineRec.status}, out=${offlineRec.stdout}, err=${offlineRec.stderr}`
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
    const wtAbs = join(dir, '.worktrees/impl-gw-feat')
    gitSync(dir, ['worktree', 'remove', '--force', wtAbs])
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
    'AGENTS.md': '# mono\n\n```yaml\nquick-test: node -e "process.exit(0)"\nfull-test: node -e "process.exit(0)"\nmerge-gate: node -e "process.exit(0)"\n```\n',
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
    const t2Init = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 't2-feat', '--title', 'T2 Feature'], { cwd: dir })
    if (t2Init.status !== 0) return `t2 doc-plan init 失败：${t2Init.stderr}`
    const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-t2', '--case', '3', '--slug', 't2-feat', '--json'], { cwd: dir })
    if (st.status !== 0) return `Tier 2 start 失败：${st.stderr}`
    const l = JSON.parse(st.stdout)
    const implAbs = join(dir, l.worktreePath)
    const revAbs = join(dir, l.reviewWorktreePath)
    if (!l.todoFile || !existsSync(join(implAbs, l.todoFile))) {
      return `Tier 2 start 未迁入关联 todoFile：${JSON.stringify(l)}`
    }
    if (existsSync(revAbs)) return 'Tier 2 start 不应在 baseSha 预创建陈旧 review 空槽'

    // Workspace 软链指回主仓 -> 根 node_modules 隔离；backend 与 frontend 均共享；改 frontend 锁只隔离 frontend
    if (!l.depsMount?.isolatedUnits?.some((u) => u.reason === 'workspace-symlink-poisoning')) {
      return `未隔离指回主仓的 Workspace 软链：${JSON.stringify(l.depsMount)}`
    }
    if (!existsSync(join(implAbs, 'frontend/node_modules/pkg/i.js')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
      return '子包独立锁比对未挂载子包共享依赖'
    }
    const excludeTxt = readFileSync(join(dir, '.git/info/exclude'), 'utf8')
    if (!excludeTxt.split('\n').some((line) => line.trim() === '/backend/node_modules')) {
      return `mountSharedDeps 未写入无尾斜杠软链忽略规则：${excludeTxt}`
    }
    unmountSharedDeps(dir, implAbs)
    writeFileSync(join(implAbs, 'frontend/package-lock.json'), '{"lockfileVersion":3,"changed":1}\n')
    const mPartial = mountSharedDeps(dir, implAbs)
    if (existsSync(join(implAbs, 'frontend/node_modules')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
      return `frontend 锁变更未做到单包隔离：${JSON.stringify(mPartial)}`
    }

    // 提交业务代码 -> verify -> submit 自动同步 review 槽至最新 HEAD（不再是空 diff）
    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 2\n')
    writeFileSync(
      join(implAbs, l.todoFile),
      readFileSync(join(implAbs, l.todoFile), 'utf8').replace('<two-way | one-way>', 'two-way').replace(/<[^>]+>/g, '`src/app.mjs`').replace(/- \[ \]/g, '- [x]'),
    )
    gitSync(implAbs, ['add', '-A'])
    const stagedDeps = gitSync(implAbs, ['ls-files', '--', 'backend/node_modules'], { encoding: 'utf8' })
    if ((stagedDeps.stdout ?? '').trim()) return `挂载软链误被 git 跟踪：${stagedDeps.stdout}`
    gitSync(implAbs, ['commit', '-qm', 'feat: v2'])
    await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-t2'], { cwd: implAbs })
    gitSync(implAbs, ['add', '-A'])
    gitSync(implAbs, ['commit', '-qm', 'docs: archive'])
    await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-t2', '--mode', 'gate'], { cwd: implAbs })
    const sub = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-t2', '--json'], { cwd: implAbs })
    if (sub.status !== 0) return `Tier 2 submit 失败：${sub.stderr}`
    const subJson = JSON.parse(sub.stdout)
    if (!existsSync(revAbs) || (subJson.reviewSlotSync?.headSha ?? '') === l.baseSha) {
      return `submit 未推进 review 槽到最新 HEAD：${sub.stdout}`
    }

    const pack = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 't-t2', '--json'], { cwd: dir })
    const packJson = JSON.parse(pack.stdout)
    if ((packJson.diff?.files?.length ?? 0) === 0 || packJson.diffText !== undefined) {
      return `review-pack 空 diff 或未默认精简 diffText：${pack.stdout.slice(0, 400)}`
    }

    // Round 1 pass 后再提交新改动并 verify（未复审），merge 必须拦截陈旧 reviewPassedHead
    await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-a'], { cwd: dir })
    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 3\n')
    gitSync(implAbs, ['add', '-A'])
    gitSync(implAbs, ['commit', '-qm', 'feat: v3'])
    await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-t2', '--mode', 'gate'], { cwd: implAbs })
    const mStaleHead = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2'], { cwd: dir })
    if (mStaleHead.status === 0) return '新提交仅 verify 未复审却被 merge 放行了（reviewPassedHead 校验失效）'

    // Round 2 changes 必须清空 reviewPassedHead -> merge 阻断；再提交新 HEAD 触发 Round 3 stop-loss 后 override 解锁
    await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '2', '--verdict', 'changes', '--must-fix', 'C1: src/app.mjs:1 bug', '--reviewer-id', 'rev-a'], { cwd: dir })
    const t2AfterR2 = JSON.parse(readFileSync(join(dir, '.worktrees/.state/tasks/t-t2.json'), 'utf8'))
    if (t2AfterR2.reviewPassedHead !== null) return `verdict=changes 未清空 reviewPassedHead：${t2AfterR2.reviewPassedHead}`
    const mBlocked = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2'], { cwd: dir })
    if (mBlocked.status === 0) return 'verdict=changes 后 merge 竟然放行了'

    writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 4\n')
    gitSync(implAbs, ['add', '-A'])
    gitSync(implAbs, ['commit', '-qm', 'feat: v4'])
    await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-t2', '--mode', 'gate'], { cwd: implAbs })
    const r3Stop = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '3', '--verdict', 'changes', '--must-fix', 'C1: src/app.mjs:1 bug', '--reviewer-id', 'rev-a'], { cwd: dir })
    if (r3Stop.status !== 4) return `Round 3 未触发 STOP_LOSS_ESCALATE (exit=4)：${r3Stop.status}`
    const ov = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['override', '--task', 't-t2', '--human-approved', '--reason', 'human verified'], { cwd: dir })
    if (ov.status !== 0) return `override 失败：${ov.stderr}`
    const mOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2', '--human-approved', '--reason', 'human verified'], { cwd: dir })
    if (mOk.status !== 0) return `override 后 merge 仍阻断：${mOk.stderr}`
    const clOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-t2', '--confirm', '--json'], { cwd: dir })
    if (clOk.status !== 0) return `cleanup 失败：${clOk.stderr}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['远端 CI 合并硬门禁：fail/pending 阻断、汇总重跑全绿放行与无工作流跳过正反双向', async () => {
  const ciDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# ci-gate\n\n```yaml\nquick-test: node -e "process.exit(0)"\n```\n',
    'src/app.mjs': 'export const c = 1\n',
  })
  gitInit(ciDir, { branch: 'main', name: 't', email: 't@t.t', origin: 'https://github.com/acme/ci-demo.git' })
  try {
    const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'ci-t', '--case', '2', '--slug', 'ci-t', '--clone-choice', 'standalone', '--json'], { cwd: ciDir })
    if (st.status !== 0) return `ciDir start 失败：${st.stderr}`
    const ciImpl = join(ciDir, JSON.parse(st.stdout).worktreePath)
    const { readTaskLedger, writeTaskLedger, resolveRepoRoots: resRoots, summarizeCommitChecks } = await import('../../kit/skills/lib/shared.mjs')
    const { handleMerge } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
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
      const ver = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'ci-t', '--mode', mode], { cwd: ciImpl })
      if (ver.status !== 0) throw new Error(`verify 失败：${ver.stderr}`)
      const curSha = gitSync(ciImpl, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const rec = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 'ci-t', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-ci'], { cwd: ciDir })
      if (rec.status !== 0) throw new Error(`record 失败：${rec.stderr}`)
      const led = readTaskLedger(ciDir, 'ci-t')
      writeTaskLedger(ciDir, { ...led, prNumber: 101, implementerId: 'dev-ci', lastReview: { ...(led.lastReview ?? {}), headSha: curSha } })
    }
    writeFileSync(join(ciImpl, 'src/app.mjs'), 'export const c = 2\n')
    gitSync(ciImpl, ['add', '-A'])
    gitSync(ciImpl, ['commit', '-qm', 'feat: c2'])
    await prepHead('quick')
    const roots = await resRoots(ciDir)
    const rNoWf = await handleMerge({ task: 'ci-t', json: true, _ghProbe: makeProbe(summarizeCommitChecks([], [])) }, roots)
    if (rNoWf.exitCode !== 0 || mergeCalls !== 1) return `无检查工作流时 bucket=none 未放行合并：code=${rNoWf.exitCode}, calls=${mergeCalls}`

    mkdirSync(join(ciImpl, '.github/workflows'), { recursive: true })
    writeFileSync(join(ciImpl, '.github/workflows/check.yml'), 'name: check\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n')
    gitSync(ciImpl, ['add', '-A'])
    gitSync(ciImpl, ['commit', '-qm', 'ci: add check workflow'])
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
      'quick-test: node -e "process.exit(0)"',
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
  } finally { rmTree(govDir) }

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
    const spInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'spec', '--slug', 'note-case', '--title', 'Impl Note Case', '--json',
    ], { cwd: urlDir })
    const spRel = JSON.parse(spInit.stdout).file
    const placeholderTodo = `${'TO'}DO: fill later`
    let spTxt = readFileSync(join(urlDir, spRel), 'utf8')
      .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', `- ${placeholderTodo}`)
      .replace('<two-way | one-way>', 'two-way')
      .replace(/<[^>]+>/g, '真实值')
      .replace('- [ ] C1: 真实值', '- [x] C1: verified')
      .replace('- [ ] C2: 真实值', '- [x] C2: verified')
    writeFileSync(join(urlDir, spRel), spTxt)
    gitSync(urlDir, ['add', spRel])
    gitSync(urlDir, ['commit', '-qm', 'spec todo'])
    await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'note-case', '--slug', 'note-case', '--case', '4'], { cwd: urlDir })
    const finBad = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'note-case'], { cwd: urlDir })
    if (finBad.status === 0 || !finBad.stderr.includes('BLOCKED_SPEC_IMPL_NOTE_EMPTY')) {
      return `finalize 未拦截大写 placeholder：status=${finBad.status}, err=${finBad.stderr}`
    }
    const spWtAbs = join(urlDir, '.worktrees/impl-note-case', spRel)
    writeFileSync(spWtAbs, readFileSync(spWtAbs, 'utf8').replace(`- ${placeholderTodo}`, '- 已按 Todo 与 docs/todo/ 收尾验证。'))
    gitSync(join(urlDir, '.worktrees/impl-note-case'), ['add', '-A'])
    gitSync(join(urlDir, '.worktrees/impl-note-case'), ['commit', '-qm', 'spec real note'])
    const finOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'note-case'], { cwd: urlDir })
    if (finOk.status !== 0) return `finalize 误拦合法 Todo 实现说明：${finOk.stderr}`

    // submit 创建 PR 后回填 archived SPEC/Todo 的 pr 字段（不再抛 today is not defined）
    const bareRem = tmpProject({})
    gitSync(undefined, ['init', '--bare', bareRem])
    const bareUrl = bareRem.replace(/\\/g, '/')
    try {
      const implNote = join(urlDir, '.worktrees/impl-note-case')
      gitSync(urlDir, ['config', `url.${bareUrl}.pushInsteadOf`, 'https://github.com/acme/demo.git'])
      gitSync(implNote, ['add', '-A'])
      gitSync(implNote, ['commit', '-qm', 'archive spec'])
      const verOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'note-case', '--cmd', 'node -e "process.exit(0)"'], { cwd: implNote })
      if (verOk.status !== 0) return `note-case verify 失败：${verOk.stderr}`
      const { handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { resolveRepoRoots: resRoots } = await import('../../kit/skills/lib/shared.mjs')
      const postedComments = []
      const mockSubmitClient = {
        tier: 'gh-cli',
        async createPr({ title }) { return { ok: true, number: 99, url: 'https://github.com/acme/demo/pull/99', title } },
        async postComment(p) { postedComments.push(p); return { ok: true, id: postedComments.length, verifiedReadback: true } },
      }
      const subRes = await handleSubmit({ task: 'note-case', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'url-dev' } }, client: mockSubmitClient } }, await resRoots(urlDir))
      const { readTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
      const noteLedger = readTaskLedger(urlDir, 'note-case')
      const noteDirtyAfterPush = gitSync(implNote, ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
      if (subRes.exitCode !== 0 || noteLedger?.prNumber !== 99 || noteDirtyAfterPush !== '' || !postedComments.some((c) => c.number === 99 && c.body.includes('@url-dev'))) {
        return `handleSubmit 零脏文件/账本 prNumber 或首提 PR 评论失败：code=${subRes.exitCode}, pr=${noteLedger?.prNumber}, dirty="${noteDirtyAfterPush}"`
      }
    } finally { rmTree(bareRem) }

    // doc-plan approve 自动提示移交 dev-flow start
    const apInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'spec', '--slug', 'app-next', '--title', 'Approve Next', '--issue', '55', '--json',
    ], { cwd: urlDir })
    const apRel = JSON.parse(apInit.stdout).file
    writeFileSync(join(urlDir, apRel), readFileSync(join(urlDir, apRel), 'utf8')
      .replace('<two-way | one-way>', 'two-way')
      .replace(/<[^>]+>/g, '真实值')
      .replace('- [ ] C1: 真实值', '- [x] C1: verified')
      .replace('- [ ] C2: 真实值', '- [x] C2: verified'))
    await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', apRel, '--reviewer', 'critic-next'], { cwd: urlDir })
    const apRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', apRel, '--json'], { cwd: urlDir })
    const apJson = apRes.status === 0 ? JSON.parse(apRes.stdout) : null
    if (!apJson?.nextStep?.includes('flow.mjs" start') || !apJson?.nextStep?.includes('--issue 55')) {
      return `doc-plan approve 缺少移交 flow start 提示：${apRes.stdout} ${apRes.stderr}`
    }

    // flow cleanup 细粒度保留：仅删 review worktree，保留 impl worktree 与本地分支
    gitSync(urlDir, ['worktree', 'add', '--detach', join(urlDir, '.worktrees/review-note-case'), 'HEAD'])
    const clOnlyRev = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
      'cleanup', '--task', 'note-case', '--confirm', '--only-review-worktree', '--json',
    ], { cwd: urlDir })
    const clj = clOnlyRev.status === 0 ? JSON.parse(clOnlyRev.stdout) : null
    if (!clj || existsSync(join(urlDir, '.worktrees/review-note-case')) || !existsSync(join(urlDir, '.worktrees/impl-note-case')) || clj.deletedLocalBranch) {
      return `cleanup --only-review-worktree 未按粒度保留：${clOnlyRev.stdout} ${clOnlyRev.stderr}`
    }

    // Round 1 审查发现的正反双向回归：AGENTS.md 正文提及 merge-authority 不误判、static-gates 不自误报、workflow run: echo 不误触发权限放宽
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
  } finally {
    for (const wt of ['.worktrees/impl-pr-88', '.worktrees/review-pr-89', '.worktrees/impl-note-case', '.worktrees/review-note-case']) {
      gitSync(urlDir, ['worktree', 'remove', '--force', join(urlDir, wt)])
    }
    rmTree(urlDir)
  }
}])

}
