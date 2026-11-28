/**
 * fixtures-issue-binding.mjs —— Case 2/3/4 开工确定性 Issue 绑定闭环正反双向行为断言（C1/C4）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { critiqueTextFingerprint } from '../../kit/skills/lib/critique-rounds.mjs'
import { EXIT, blockedExitOf } from '../../kit/skills/lib/exit-codes.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { getLocalIssue } from '../../kit/skills/lib/local-issues.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

async function withCaptureIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (chunk) => { out += String(chunk); return true }
  process.stderr.write = (chunk) => { err += String(chunk); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

function makeMockGh(initialNum = 200) {
  let seq = initialNum
  const created = []
  const issues = new Map()
  const comments = new Map()
  const client = {
    tier: 'node-https-token',
    async getIssue(_repo, num) {
      const hit = issues.get(Number(num))
      if (hit) return { ok: true, ...hit }
      return { ok: true, number: Number(num), title: `Existing #${num}`, body: 'existing issue body', state: 'OPEN', labels: [], url: `https://github.com/acme/demo/issues/${num}` }
    },
    async createIssue({ title, body, labels = [] }) {
      seq += 1
      const rec = { number: seq, title, body, labels, state: 'OPEN', url: `https://github.com/acme/demo/issues/${seq}` }
      created.push(rec)
      issues.set(seq, rec)
      return { ok: true, ...rec }
    },
    async listComments(_repo, num) {
      return { ok: true, comments: comments.get(Number(num)) ?? [] }
    },
    async postComment({ number, body }) {
      const list = comments.get(Number(number)) ?? []
      list.push({ id: list.length + 1, body })
      comments.set(Number(number), list)
      return { ok: true, id: list.length, verifiedReadback: true }
    },
    async addLabels() { return { ok: true } },
    async listMilestones() { return { ok: true, milestones: [] } },
  }
  return {
    created,
    client,
    ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } }, client },
  }
}

function validSpecAndTodo(slug, { issue = null, owner = 'planner', approved = true } = {}) {
  const issueVal = issue === null ? 'null' : String(issue)
  const specBase = [
    '---',
    'kind: spec',
    `title: "Binding Spec ${slug}"`,
    `status: ${approved ? 'approved' : 'draft'}`,
    'tier: L3',
    'created: 2026-11-24',
    'updated: 2026-11-24',
    `issue: ${issueVal}`,
    'pr: null',
    `branch: feat/${slug}`,
    `owner: ${owner}`,
    'plan_mode: interactive',
    `approved: ${approved ? 'true' : 'false'}`,
    'implemented: false',
    'plan_critique: "pending"',
    'scope_files: [src/app.mjs]',
    '---',
    '',
    `# Binding Spec ${slug}`,
    '',
    '- **变更一句话**：为 `src/app.mjs` 落地确定性绑定。',
    '',
    '## 一、背景与边界声明',
    '- **要改什么**：改造 `src/app.mjs:1` 绑定逻辑。',
    '- **本期不做**：不动 `README.md` 与第三方依赖。',
    '- **复用既有模块**：`src/app.mjs`',
    '',
    '## 五、冻结的验收标准',
    `- [ ] C1: 运行 \`node -e "process.exit(0)"\` 验证 \`src/app.mjs\` 绑定通过`,
  ].join('\n')
  const sha = approved ? critiqueTextFingerprint(specBase) : ''
  const spec = approved
    ? specBase.replace('plan_critique: "pending"', `plan_critique: "passed (reviewer=critic-1, round=1, sha=${sha})"`)
    : specBase
  const todo = [
    '---',
    'kind: todo',
    `title: "Binding Todo ${slug}"`,
    'status: active',
    'created: 2026-11-24',
    'updated: 2026-11-24',
    `issue: ${issueVal}`,
    'pr: null',
    `branch: feat/${slug}`,
    `owner: ${owner}`,
    `task_id: ${slug}`,
    '---',
    '',
    `# Binding Todo ${slug}`,
    '',
    '## 任务范围与验证基准',
    '- **影响路径**：`src/app.mjs`',
    '- **本期不做**：不动 `README.md`',
    '',
    '## 验收标准与执行清单',
    `- [ ] C1: 运行 \`node -e "process.exit(0)"\` 验证 \`src/app.mjs\` 绑定通过`,
  ].join('\n')
  return { spec, todo }
}

const VALID_CASE2_BODY = [
  '## 背景与现象',
  '`src/app.mjs:1` 在无规划文档启动时缺少故障边界处理。',
  '## 影响面与严重度',
  '影响路径：`src/app.mjs`；severity=medium；仅限启动校验，不涉及数据模型、API 协议或安全边界。',
  '## 期望与方案',
  '修复 `src/app.mjs` 并确保 `node -e "process.exit(0)"` 返回 exit=0。',
  '## 验收标准',
  '- [ ] C1: 运行 `node -e "process.exit(0)"` 验证 `src/app.mjs` 返回退出码 0',
  '## 不在本次范围',
  '不动 `README.md` 与外部配置。',
].join('\n')

export function registerIssueBindingCases(cases) {
  cases.push(['C1/C4：BLOCKED_MISSING_ISSUE_BINDING 登记、CLI 互斥与 --no-issue 理由强度校验', async () => {
    if (blockedExitOf('BLOCKED_MISSING_ISSUE_BINDING') !== EXIT.FACT) {
      return `BLOCKED_MISSING_ISSUE_BINDING 退出码档位应为 EXIT.FACT (3)，实为 ${blockedExitOf('BLOCKED_MISSING_ISSUE_BINDING')}`
    }
    if (blockedExitOf('BLOCKED_CONFLICTING_ISSUE_FLAGS') !== EXIT.USAGE) {
      return `BLOCKED_CONFLICTING_ISSUE_FLAGS 退出码档位应为 EXIT.USAGE (2)，实为 ${blockedExitOf('BLOCKED_CONFLICTING_ISSUE_FLAGS')}`
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# ib-cli\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const noReason = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-nr', '--case', '2', '--no-issue', '--agent', 'impl-a', '--json',
      ], { cwd: dir })
      if (noReason.status !== EXIT.USAGE || !`${noReason.stdout}\n${noReason.stderr}`.includes('MISSING_OVERRIDE_REASON')) {
        return `--no-issue 缺 --reason 未返回 2/MISSING_OVERRIDE_REASON：status=${noReason.status}, out=${noReason.stdout}, err=${noReason.stderr}`
      }

      const shallowReason = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-sr', '--case', '2', '--no-issue', '--reason', 'ok', '--agent', 'impl-a', '--json',
      ], { cwd: dir })
      if (shallowReason.status !== EXIT.USAGE || !`${shallowReason.stdout}\n${shallowReason.stderr}`.includes('BLOCKED_SHALLOW_OVERRIDE_REASON')) {
        return `--no-issue 水话理由未返回 2/BLOCKED_SHALLOW_OVERRIDE_REASON：status=${shallowReason.status}, out=${shallowReason.stdout}, err=${shallowReason.stderr}`
      }

      const conflict = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-cf', '--case', '2', '--no-issue', '--issue', '12', '--reason', '本地紧急修复无远端依赖', '--agent', 'impl-a', '--json',
      ], { cwd: dir })
      if (conflict.status !== EXIT.USAGE || !`${conflict.stdout}\n${conflict.stderr}`.includes('BLOCKED_CONFLICTING_ISSUE_FLAGS')) {
        return `--no-issue 与 --issue 互斥未返回 2/BLOCKED_CONFLICTING_ISSUE_FLAGS：status=${conflict.status}, out=${conflict.stdout}, err=${conflict.stderr}`
      }

      const missingBind = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-miss', '--case', '2', '--agent', 'impl-a', '--json',
      ], { cwd: dir })
      if (missingBind.status !== EXIT.FACT || !`${missingBind.stdout}\n${missingBind.stderr}`.includes('BLOCKED_MISSING_ISSUE_BINDING')) {
        return `Case 2 无绑定信息未返回 3/BLOCKED_MISSING_ISSUE_BINDING：status=${missingBind.status}, out=${missingBind.stdout}, err=${missingBind.stderr}`
      }

      const bodyDir = tmpProject({ 'issue-body.md': VALID_CASE2_BODY })
      const bodyFile = join(bodyDir, 'issue-body.md')
      try {
        const bodyStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
          'start', '--task', 'c2-body', '--case', '2', '--body-file', bodyFile, '--agent', 'impl-a', '--json',
        ], { cwd: dir })
        if (bodyStart.status !== 0) {
          return `Case 2 传合规 --body-file 应通过并本地建单：status=${bodyStart.status}, out=${bodyStart.stdout}, err=${bodyStart.stderr}`
        }
      } finally {
        rmTree(bodyDir)
      }
      const ledgerBody = readTaskLedger(dir, 'c2-body')
      if (ledgerBody?.issueBinding?.mode !== 'created' || !ledgerBody.linkedIssues?.length) {
        return `Case 2 --body-file 建单未写入 ledger.issueBinding：${JSON.stringify(ledgerBody)}`
      }
      const localIss = getLocalIssue({ mainRoot: dir, number: ledgerBody.linkedIssues[0] })
      if (!localIss.ok || !localIss.body.includes('src/app.mjs:1')) {
        return `Case 2 --body-file 未落地本地工单：${JSON.stringify(localIss)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C1/C4：先门禁后建单防孤儿单、先复用不重复、Case 3/4 自动建单回链与 --planning 晋升绑定', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# ib-core\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    try {
      const gh = makeMockGh(300)
      const roots = await resolveRepoRoots(dir)

      // 1. 门禁前置：未过审 SPEC 阻断时绝不产生孤儿工单
      const unapproved = validSpecAndTodo('unapp', { owner: 'planner', approved: false })
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      mkdirSync(join(dir, 'docs/todo'), { recursive: true })
      writeFileSync(join(dir, 'docs/specs/261124-unapp-spec.md'), unapproved.spec, 'utf8')
      writeFileSync(join(dir, 'docs/todo/261124-unapp-todo.md'), unapproved.todo, 'utf8')
      gitCommitFast(dir, 'docs: unapproved spec')
      const blockPlan = await withCaptureIo(() => handleStart({
        task: 'unapp', slug: 'unapp', case: '4',
        spec: 'docs/specs/261124-unapp-spec.md', todo: 'docs/todo/261124-unapp-todo.md',
        agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (blockPlan.res.exitCode !== EXIT.FACT || gh.created.length !== 0) {
        return `未过审 SPEC 阻断或防孤儿单失败：exit=${blockPlan.res.exitCode}, created=${gh.created.length}`
      }

      // 2. 门禁前置：作者与实施者同人阻断时绝不产生孤儿工单
      const app1 = validSpecAndTodo('same-auth', { owner: 'alice', approved: true })
      writeFileSync(join(dir, 'docs/specs/261124-same-auth-spec.md'), app1.spec, 'utf8')
      writeFileSync(join(dir, 'docs/todo/261124-same-auth-todo.md'), app1.todo, 'utf8')
      gitCommitFast(dir, 'docs: same-auth approved')
      const blockAuth = await withCaptureIo(() => handleStart({
        task: 'same-auth', slug: 'same-auth', case: '4',
        spec: 'docs/specs/261124-same-auth-spec.md', todo: 'docs/todo/261124-same-auth-todo.md',
        agent: 'alice', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (blockAuth.res.exitCode !== EXIT.FACT || gh.created.length !== 0) {
        return `作者分离阻断前误建孤儿单：exit=${blockAuth.res.exitCode}, created=${gh.created.length}`
      }

      // 3. 隔离 worktree 精准边界：脏主仓新开隔离 worktree 降级预警放行（不再误阻断并行会话），清理后再验正向建单
      const app2 = validSpecAndTodo('auto-c4', { owner: 'planner', approved: true })
      writeFileSync(join(dir, 'docs/specs/261124-auto-c4-spec.md'), app2.spec, 'utf8')
      writeFileSync(join(dir, 'docs/todo/261124-auto-c4-todo.md'), app2.todo, 'utf8')
      gitCommitFast(dir, 'docs: auto-c4 approved')
      const appDirtyIso = validSpecAndTodo('dirty-iso', { owner: 'planner', approved: true })
      writeFileSync(join(dir, 'docs/specs/261124-dirty-iso-spec.md'), appDirtyIso.spec, 'utf8')
      writeFileSync(join(dir, 'docs/todo/261124-dirty-iso-todo.md'), appDirtyIso.todo, 'utf8')
      gitCommitFast(dir, 'docs: dirty-iso approved')
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = false\n', 'utf8')
      const isoOnDirty = await withCaptureIo(() => handleStart({
        task: 'dirty-iso', slug: 'dirty-iso', case: '4',
        spec: 'docs/specs/261124-dirty-iso-spec.md', todo: 'docs/todo/261124-dirty-iso-todo.md',
        'no-issue': true, reason: '验证脏主仓新开隔离 worktree 降级预警不误阻断',
        agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (isoOnDirty.res.exitCode !== 0 || gh.created.length !== 0) {
        return `脏主仓新开隔离 worktree 应降级预警放行且豁免不建单：exit=${isoOnDirty.res.exitCode}, created=${gh.created.length}`
      }
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = true\n', 'utf8')

      // 4. Case 4 正向自动建单、质量门禁提取上下文、账本记录与文档回链
      const okC4 = await withCaptureIo(() => handleStart({
        task: 'auto-c4', slug: 'auto-c4', case: '4',
        spec: 'docs/specs/261124-auto-c4-spec.md', todo: 'docs/todo/261124-auto-c4-todo.md',
        agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (okC4.res.exitCode !== 0 || gh.created.length !== 1) {
        return `Case 4 自动建单失败：exit=${okC4.res.exitCode}, created=${gh.created.length}, err=${okC4.err}`
      }
      const issNum = gh.created[0].number
      if (!gh.created[0].body.includes('src/app.mjs') || !gh.created[0].body.includes('docs/specs/261124-auto-c4-spec.md')) {
        return `自动建单未从 SPEC/Todo 提取上下文：\n${gh.created[0].body}`
      }
      const lgC4 = readTaskLedger(dir, 'auto-c4')
      if (lgC4?.issueBinding?.mode !== 'created' || !lgC4.linkedIssues?.includes(issNum) || lgC4.issueContext?.[0]?.number !== issNum) {
        return `Case 4 建单后账本 issueBinding / issueContext 未闭环：${JSON.stringify(lgC4)}`
      }
      const wtC4 = join(dir, lgC4.worktreePath)
      if (!lgC4.specFile?.includes(`-issue${issNum}-`) || !existsSync(join(wtC4, lgC4.specFile))) {
        return `Case 4 自动建单未回链重命名工作树 SPEC：${JSON.stringify(lgC4)}`
      }

      // 5. 先复用不重复：文档 Frontmatter 已有 issue: 88 时，不再创建新单
      const reusedDocs = validSpecAndTodo('reuse-doc', { issue: 88, owner: 'planner', approved: true })
      writeFileSync(join(dir, 'docs/specs/261124-issue88-reuse-doc-spec.md'), reusedDocs.spec, 'utf8')
      writeFileSync(join(dir, 'docs/todo/261124-issue88-reuse-doc-todo.md'), reusedDocs.todo, 'utf8')
      gitCommitFast(dir, 'docs: reuse-doc issue 88')
      const beforeCount = gh.created.length
      const okReuse = await withCaptureIo(() => handleStart({
        task: 'reuse-doc', slug: 'reuse-doc', case: '4',
        spec: 'docs/specs/261124-issue88-reuse-doc-spec.md', todo: 'docs/todo/261124-issue88-reuse-doc-todo.md',
        agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      const lgReuse = readTaskLedger(dir, 'reuse-doc')
      if (okReuse.res.exitCode !== 0 || gh.created.length !== beforeCount || lgReuse?.issueBinding?.mode !== 'reused' || lgReuse?.issueBinding?.source !== 'plan-doc' || !lgReuse.linkedIssues?.includes(88)) {
        return `文档已有 issue:88 未按先复用不重复处理：exit=${okReuse.res.exitCode}, createdDelta=${gh.created.length - beforeCount}, ledger=${JSON.stringify(lgReuse?.issueBinding)}`
      }

      // 6. --planning 阶段豁免，转入实施态时不再沿用 planning 豁免而是触发绑定建单
      const stPlan = await withCaptureIo(() => handleStart({
        task: 'plan-promo', slug: 'plan-promo', case: '4', planning: true, json: true,
        _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      const lgPlan = readTaskLedger(dir, 'plan-promo')
      if (stPlan.res.exitCode !== 0 || lgPlan?.issueBinding?.exemptKind !== 'planning' || gh.created.length !== beforeCount) {
        return `--planning 豁免或误建单异常：exit=${stPlan.res.exitCode}, binding=${JSON.stringify(lgPlan?.issueBinding)}`
      }
      const promoWt = join(dir, lgPlan.worktreePath)
      const promoDocs = validSpecAndTodo('plan-promo', { owner: 'planner', approved: true })
      mkdirSync(join(promoWt, 'docs/specs'), { recursive: true })
      mkdirSync(join(promoWt, 'docs/todo'), { recursive: true })
      writeFileSync(join(promoWt, 'docs/specs/261124-plan-promo-spec.md'), promoDocs.spec, 'utf8')
      writeFileSync(join(promoWt, 'docs/todo/261124-plan-promo-todo.md'), promoDocs.todo, 'utf8')
      const stPromo = await withCaptureIo(() => handleStart({
        task: 'plan-promo', case: '4',
        spec: 'docs/specs/261124-plan-promo-spec.md', todo: 'docs/todo/261124-plan-promo-todo.md',
        agent: 'impl-b', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      const lgPromo = readTaskLedger(dir, 'plan-promo')
      if (stPromo.res.exitCode !== 0 || gh.created.length !== beforeCount + 1 || lgPromo?.issueBinding?.mode !== 'created') {
        return `--planning 晋升实施态未触发绑定建单：exit=${stPromo.res.exitCode}, binding=${JSON.stringify(lgPromo?.issueBinding)}, err=${stPromo.err}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C1/C4：八类豁免全覆盖、no-auto-issue 取舍、delegated exit 4 与浅正文透传 BLOCKED_ISSUE_QUALITY_INCOMPLETE', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# ib-ex\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    try {
      const gh = makeMockGh(400)
      const roots = await resolveRepoRoots(dir)

      // 1. Case 1 豁免
      const stC1 = await withCaptureIo(() => handleStart({
        task: 'ex-c1', slug: 'ex-c1', case: '1', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stC1.res.exitCode !== 0 || readTaskLedger(dir, 'ex-c1')?.issueBinding?.exemptKind !== 'case-1') {
        return `Case 1 豁免记录异常：exit=${stC1.res.exitCode}, binding=${JSON.stringify(readTaskLedger(dir, 'ex-c1')?.issueBinding)}`
      }

      // 2. --allow-plan-bootstrap 豁免（不带 --create-issue）
      const stBoot = await withCaptureIo(() => handleStart({
        task: 'ex-boot', slug: 'ex-boot', case: '3', 'allow-plan-bootstrap': true, agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stBoot.res.exitCode !== 0 || readTaskLedger(dir, 'ex-boot')?.issueBinding?.exemptKind !== 'allow-plan-bootstrap' || gh.created.length !== 0) {
        return `--allow-plan-bootstrap 豁免失败：exit=${stBoot.res.exitCode}, created=${gh.created.length}`
      }

      // 3. --no-issue --reason 豁免且幂等重入保持记录
      const stNoIss = await withCaptureIo(() => handleStart({
        task: 'ex-noiss', slug: 'ex-noiss', case: '2', 'no-issue': true, reason: '紧急修复单行配置无需外部工单', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      const lgNoIss1 = readTaskLedger(dir, 'ex-noiss')
      if (stNoIss.res.exitCode !== 0 || lgNoIss1?.issueBinding?.exemptKind !== 'no-issue-flag' || !lgNoIss1?.issueBinding?.reason) {
        return `--no-issue --reason 豁免失败：exit=${stNoIss.res.exitCode}, binding=${JSON.stringify(lgNoIss1?.issueBinding)}`
      }
      const stNoIssAgain = await withCaptureIo(() => handleStart({
        task: 'ex-noiss', slug: 'ex-noiss', case: '2', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stNoIssAgain.res.exitCode !== 0 || readTaskLedger(dir, 'ex-noiss')?.issueBinding?.exemptKind !== 'no-issue-flag') {
        return `--no-issue 幂等重入未保留豁免审计：exit=${stNoIssAgain.res.exitCode}`
      }

      // 4. Case 2 传浅正文 --body 时透传 BLOCKED_ISSUE_QUALITY_INCOMPLETE (3) 而非静默放行
      const stShallowBody = await withCaptureIo(() => handleStart({
        task: 'bad-body', slug: 'bad-body', case: '2', body: '修一下 bug', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stShallowBody.res.exitCode !== EXIT.FACT || !`${stShallowBody.out}\n${stShallowBody.err}`.includes('BLOCKED_ISSUE_QUALITY_INCOMPLETE') || gh.created.length !== 0) {
        return `Case 2 浅正文未透传 BLOCKED_ISSUE_QUALITY_INCOMPLETE：exit=${stShallowBody.res.exitCode}, out=${stShallowBody.out}, err=${stShallowBody.err}`
      }

      // 5. delegated (无直连 API 凭据的 maintainer) 返回 EXIT.HUMAN (4)
      const delClient = { tier: 'none', async createIssue({ title }) { return { ok: false, delegated: true, jsonPayload: { action: 'create_issue', title } } } }
      const stDel = await withCaptureIo(() => handleStart({
        task: 'del-c2', slug: 'del-c2', case: '2', title: 'Delegated bug', body: VALID_CASE2_BODY, agent: 'impl-a', json: true,
        _ghClient: delClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'none' } }, client: delClient },
      }, roots))
      if (stDel.res.exitCode !== EXIT.HUMAN || !stDel.out.includes('ACTION_REQUIRED_CREATE_ISSUE_DELEGATED')) {
        return `delegated 建单未透传 EXIT.HUMAN (4)：exit=${stDel.res.exitCode}, out=${stDel.out}`
      }

      // 6. contributor-fork 豁免自动向上游建单
      gitSync(dir, ['remote', 'add', 'upstream', 'https://github.com/upstream-org/demo.git'])
      const stFork = await withCaptureIo(() => handleStart({
        task: 'ex-fork', slug: 'ex-fork', case: '2', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stFork.res.exitCode !== 0 || readTaskLedger(dir, 'ex-fork')?.issueBinding?.exemptKind !== 'contributor-fork' || gh.created.length !== 0) {
        return `contributor-fork 豁免失败：exit=${stFork.res.exitCode}, binding=${JSON.stringify(readTaskLedger(dir, 'ex-fork')?.issueBinding)}`
      }
      gitSync(dir, ['remote', 'remove', 'upstream'])

      // 7. AGENTS.md 取舍声明 no-auto-issue 豁免 Case 2 自动建单
      writeFileSync(join(dir, 'AGENTS.md'), '# demo\n\n## 取舍\n\n- `no-auto-issue`: 局部修复按单提交，不自动建工单\n', 'utf8')
      gitCommitFast(dir, 'docs: add no-auto-issue decision')
      const stDecision = await withCaptureIo(() => handleStart({
        task: 'ex-dec', slug: 'ex-dec', case: '2', agent: 'impl-a', json: true, _ghClient: gh.client, _ghProbe: gh.ghProbe,
      }, roots))
      if (stDecision.res.exitCode !== 0 || readTaskLedger(dir, 'ex-dec')?.issueBinding?.exemptKind !== 'no-auto-issue-decision' || gh.created.length !== 0) {
        return `AGENTS.md no-auto-issue 取舍豁免失败：exit=${stDecision.res.exitCode}, binding=${JSON.stringify(readTaskLedger(dir, 'ex-dec')?.issueBinding)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
