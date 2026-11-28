/**
 * fixtures-issue-checklist-sync.mjs —— Issue 验收清单勾选同步（plan-sync / merge / batch merge-queue / 1:N / 升级单）正反双向行为断言。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { critiqueTextFingerprint } from '../../kit/skills/lib/critique-rounds.mjs'
import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { createLocalIssue, getLocalIssue } from '../../kit/skills/lib/local-issues.mjs'
import { PLAN_SUMMARY_END, PLAN_SUMMARY_START, syncIssueCriteriaCheckboxes, syncIssueSummaryBody, syncPlanPhaseToBackend } from '../../kit/skills/lib/plan-sync.mjs'
import { createGitHubClient } from '../../kit/skills/lib/github-client.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import { handleBatch } from '../../kit/skills/dev-flow/scripts/flow-batch.mjs'
import { handleIntake } from '../../kit/skills/dev-flow/scripts/flow-intake.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleClose } from '../../kit/skills/dev-flow/scripts/flow-issues.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

async function passReview(dir, roots, taskId, reviewerId) {
  const tok = await issueTokenFor(dir, taskId, 1)
  const rc = await withQuietIo(() => handleRecord({
    task: taskId, round: '1', verdict: 'pass', 'reviewer-id': reviewerId,
    'review-token': tok, evidence: 'run: exit 0 => exit 0', json: true,
  }, roots))
  if (rc.res !== 0) throw new Error(`record failed for ${taskId}: ${rc.stderr} ${rc.stdout}`)
}

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  process.stdout.write = (c) => { stdout += String(c); return true }
  process.stderr.write = (c) => { stderr += String(c); return true }
  try {
    const res = await fn()
    return { res, stdout, stderr }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

function makeMockGh(issuesMap, labelsMap = new Map(), prMeta = { number: 20, headRefName: 'feat/demo', baseRefName: 'main' }) {
  const closedNums = []
  const comments = []
  const client = {
    tier: 'gh-cli',
    login: 'rev-sync',
    getIssue: async (repoOrObj, num) => {
      const n = Number(typeof repoOrObj === 'object' ? repoOrObj?.number : num)
      const found = issuesMap.get(n)
      return found ? { ok: true, ...found } : { ok: false, status: 404 }
    },
    listIssues: async () => ({ ok: true, issues: [...issuesMap.values()] }),
    updateIssueBody: async ({ number, body }) => {
      const n = Number(number)
      const cur = issuesMap.get(n) ?? { number: n, state: 'OPEN' }
      issuesMap.set(n, { ...cur, body })
      return { ok: true, number: n, body }
    },
    closeIssue: async ({ number }) => {
      const n = Number(number)
      closedNums.push(n)
      const cur = issuesMap.get(n)
      if (cur) issuesMap.set(n, { ...cur, state: 'CLOSED' })
      return { ok: true, number: n }
    },
    removeLabel: async ({ number, label }) => {
      labelsMap.get(Number(number))?.delete(label)
      return { ok: true }
    },
    addLabels: async ({ number, labels = [] }) => {
      const n = Number(number)
      if (!labelsMap.has(n)) labelsMap.set(n, new Set())
      for (const l of labels) labelsMap.get(n).add(l)
      return { ok: true }
    },
    syncStateLabel: async () => ({ ok: true }),
    listComments: async () => ({ ok: true, comments: [] }),
    postComment: async ({ number, body }) => {
      comments.push({ number: Number(number), body })
      return { ok: true, id: comments.length }
    },
    getCommitChecks: async () => ({ ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [] }),
    getPr: async () => ({ ok: true, state: 'OPEN', ...prMeta }),
    mergePr: async () => ({ ok: true, merged: true, state: 'MERGED', sha: 'merged-sha-1' }),
  }
  return {
    client,
    probe: { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'rev-sync' } }, client },
    closedNums,
    comments,
  }
}

function makeBaseRepo({ withOrigin = true } = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"ics-demo","version":"1.0.0","repository":"https://github.com/acme/ics.git"}\n',
    'AGENTS.md': '# Demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
    'src/app.mjs': 'export const v = 1\n',
  })
  const bare = withOrigin ? tmpProject({}) : null
  if (bare) gitInit(bare, { bare: true })
  gitInit(dir, {
    branch: 'main',
    name: 'alice',
    email: 'alice@ics.test',
    ...(withOrigin ? { origin: 'https://github.com/acme/ics.git' } : {}),
  })
  if (bare) {
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.replace(/\\/g, '/')])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
  }
  return { dir, bare }
}

function buildSpecDoc({ taskId, issue, relatedPrd = null, scope = ['src/app.mjs'], criteriaLines = ['- [ ] C1: `src/app.mjs` 导出 2'], status = 'approved', approved = true }) {
  const raw = [
    '---', 'kind: spec', `title: "Spec ${taskId}"`, `status: ${status}`, 'tier: L3',
    'created: 2026-11-25', 'updated: 2026-11-25', `task_id: ${taskId}`,
    ...(issue ? [`issue: ${issue}`] : []),
    'owner: planner', 'plan_mode: autonomous', `approved: ${approved}`, 'implemented: false',
    ...(approved ? ['plan_critique: passed (reviewer=crit-1, round=1, sha=11111111)'] : []),
    ...(relatedPrd ? [`related_prd: ${relatedPrd}`] : []),
    `scope_files: [${scope.join(', ')}]`, 'depends_on: []', '---', '',
    `# SPEC: ${taskId}`, '', '## 要解决的问题', '- 验证 Issue 勾选同步', '',
    '## 门型与回滚路径', '- two-way，git revert', '',
    '## 验收标准', '', ...criteriaLines, '',
    '## 实现说明', '', '待填写。', '',
  ].join('\n')
  return approved ? raw.replace('sha=11111111', `sha=${critiqueTextFingerprint(raw)}`) : raw
}

function buildTodoDoc({ taskId, issue, specRel, criteriaLines = ['- [ ] C1: `src/app.mjs` 导出 2'] }) {
  return [
    '---', 'kind: todo', `title: "Todo ${taskId}"`, 'status: active', 'tier: L3',
    'created: 2026-11-25', 'updated: 2026-11-25', `task_id: ${taskId}`,
    ...(issue ? [`issue: ${issue}`] : []),
    'owner: planner', 'plan_mode: autonomous', 'approved: true',
    `related_spec: ${specRel}`, '---', '',
    `# Todo: ${taskId}`, '', '## 验收标准', '', ...criteriaLines, '',
    '## 完成后的记录', '', '待填写。', '',
  ].join('\n')
}

export function registerIssueChecklistSyncCases(cases) {
  cases.push(['IssueChecklistSync-1：syncIssueCriteriaCheckboxes 正反双向断言（匹配 C*、回退反选、跳过代码块与摘要区、不误勾 Out of Scope）', async () => {
    const sample = [
      '## 验收标准',
      '- [ ] C1: 支持配置热加载',
      '* [x] **C2**: 旧版已勾选条目（应按真源回退为未勾）',
      '- [ ] 未编号验收检查项',
      '',
      '```markdown',
      '- [ ] C1: 代码块里的示例绝不能修改',
      '- [ ] 代码块里未编号条目也不改',
      '```',
      '',
      '~~~text',
      '- [ ] C3: 波浪线代码块跳过',
      '~~~',
      '',
      PLAN_SUMMARY_START,
      '### 规划摘要（自动同步）',
      '- [ ] C1: 托管摘要区内的文本绝不能动',
      PLAN_SUMMARY_END,
      '',
      '## Out of Scope',
      '- [ ] 非范围条目永不自动勾选',
      '- [ ] C99: 未传 criteria 时仅 markAllCriteriaDone 才改 C*',
      '',
      '## 不在本次范围',
      '- [ ] 中文非范围未编号条目永不勾选',
    ].join('\n')

    const partial = syncIssueCriteriaCheckboxes(sample, {
      criteria: [{ id: 'C1', checked: true }, { id: 'C2', checked: false }],
      markAllCriteriaDone: false,
    })
    if (!partial.changed
      || !partial.checkedIds.includes('C1')
      || !partial.uncheckedIds.includes('C2')
      || !partial.body.includes('- [x] C1: 支持配置热加载')
      || !partial.body.includes('* [ ] **C2**: 旧版已勾选条目')
      || !partial.body.includes('- [ ] 未编号验收检查项')
      || !partial.body.includes('```markdown\n- [ ] C1: 代码块里的示例绝不能修改')
      || !partial.body.includes('~~~text\n- [ ] C3: 波浪线代码块跳过')
      || !partial.body.includes(`${PLAN_SUMMARY_START}\n### 规划摘要（自动同步）\n- [ ] C1: 托管摘要区内的文本绝不能动`)
      || !partial.body.includes('- [ ] 非范围条目永不自动勾选')
      || !partial.body.includes('- [ ] 中文非范围未编号条目永不勾选')) {
      return `partial sync 断言失败：\n${partial.body}`
    }

    const doneAll = syncIssueCriteriaCheckboxes(sample, {
      criteria: [{ id: 'C1', checked: true }, { id: 'C2', checked: false }],
      markAllCriteriaDone: true,
    })
    if (!doneAll.body.includes('- [x] 未编号验收检查项')
      || !doneAll.body.includes('* [ ] **C2**: 旧版已勾选条目')
      || !doneAll.body.includes('- [ ] 非范围条目永不自动勾选')
      || !doneAll.body.includes('- [ ] 中文非范围未编号条目永不勾选')
      || !doneAll.body.includes('- [ ] C1: 代码块里的示例绝不能修改')) {
      return `markAllCriteriaDone 边界断言失败：\n${doneAll.body}`
    }
    return true
  }])

  cases.push(['IssueChecklistSync-2：Case 4 merge（GitHub mock + local-only）同步勾选 Issue C1 且刷新 1/1 已完成摘要', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    const localRepo = makeBaseRepo({ withOrigin: false })
    try {
      const specRel = 'docs/specs/261125-issue10-ics-spec.md'
      const todoRel = 'docs/todo/261125-issue10-ics-todo.md'
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      mkdirSync(join(dir, 'docs/todo'), { recursive: true })
      writeFileSync(join(dir, specRel), buildSpecDoc({ taskId: 'ics-c4', issue: 10 }))
      writeFileSync(join(dir, todoRel), buildTodoDoc({ taskId: 'ics-c4', issue: 10, specRel: '../specs/261125-issue10-ics-spec.md' }))
      gitCommitFast(dir, 'docs: add c4 plan', { files: [specRel, todoRel], name: 'alice', email: 'alice@ics.test' })
      gitSync(dir, ['push', 'origin', 'main'])

      const issuesMap = new Map([[10, {
        number: 10, title: 'C4 Issue', state: 'OPEN',
        body: `## 验收标准\n- [ ] C1: \`src/app.mjs\` 导出 2\n\n${PLAN_SUMMARY_START}\n### 规划摘要（自动同步）\n- **验收进度**：0/1 已完成\n${PLAN_SUMMARY_END}\n`,
      }]])
      const { client, probe } = makeMockGh(issuesMap, new Map([[10, new Set(['planning', 'in-review', 'keep'])]]), { number: 20, headRefName: 'feat/ics-c4', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'ics-c4', slug: 'ics-c4', case: '4', issue: '10', spec: specRel, todo: todoRel, implementer: 'impl-a', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'ics-c4', agent: 'impl-a', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 'ics-c4')

      const wt = join(dir, '.worktrees/impl-ics-c4')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 2\n')
      writeFileSync(join(wt, specRel), readFileSync(join(wt, specRel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', '已导出 2'))
      writeFileSync(join(wt, todoRel), readFileSync(join(wt, todoRel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', '完成验证'))
      gitCommitFast(wt, 'feat: complete c4')
      await withQuietIo(() => handleFinalize({ task: 'ics-c4', json: true }, roots))
      gitCommitFast(wt, 'docs: finalize c4')
      const vC4 = await withQuietIo(() => handleVerify({ task: 'ics-c4', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vC4.res.exitCode !== 0) return `c4 verify 失败：${vC4.stderr} ${vC4.stdout}`
      await passReview(dir, roots, 'ics-c4', 'rev-a')
      const lPre = readTaskLedger(dir, 'ics-c4')
      writeTaskLedger(dir, { ...lPre, prNumber: 20 })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mRes = await withQuietIo(() => handleMerge({ task: 'ics-c4', 'reviewer-id': 'rev-a', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `GitHub Case 4 merge 失败：${mRes.stderr}`
      const body10 = issuesMap.get(10)?.body ?? ''
      if (!body10.includes('- [x] C1: `src/app.mjs` 导出 2') || !body10.includes('1/1 已完成')) {
        return `GitHub Case 4 merge 未同步勾选 C1 或刷新摘要：\n${body10}`
      }

      // local-only backend 同步验证
      const lDir = localRepo.dir
      const lRoots = await resolveRepoRoots(lDir)
      const locIss = await createLocalIssue({
        mainRoot: lDir, gitDir: lRoots.gitDir, title: 'Local C4 Issue',
        body: '## 验收标准\n- [ ] C1: `src/app.mjs` 导出 2',
      })
      const lSpec = `docs/specs/261125-issue${locIss.number}-loc-spec.md`
      const lTodo = `docs/todo/261125-issue${locIss.number}-loc-todo.md`
      mkdirSync(join(lDir, 'docs/specs'), { recursive: true })
      mkdirSync(join(lDir, 'docs/todo'), { recursive: true })
      writeFileSync(join(lDir, lSpec), buildSpecDoc({ taskId: 'loc-c4', issue: locIss.number }))
      writeFileSync(join(lDir, lTodo), buildTodoDoc({ taskId: 'loc-c4', issue: locIss.number, specRel: `../specs/261125-issue${locIss.number}-loc-spec.md` }))
      gitCommitFast(lDir, 'docs: local c4 plan', { files: [lSpec, lTodo], name: 'alice', email: 'alice@ics.test' })

      await withQuietIo(() => handleStart({ task: 'loc-c4', slug: 'loc-c4', case: '4', issue: String(locIss.number), spec: lSpec, todo: lTodo, implementer: 'impl-a', json: true }, lRoots))
      await withQuietIo(() => handleClaim({ task: 'loc-c4', agent: 'impl-a', json: true }, lRoots))
      await seedExploredFor(lDir, 'loc-c4')
      const lWt = join(lDir, '.worktrees/impl-loc-c4')
      writeFileSync(join(lWt, 'src/app.mjs'), 'export const v = 2\n')
      writeFileSync(join(lWt, lSpec), readFileSync(join(lWt, lSpec), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 'ok'))
      writeFileSync(join(lWt, lTodo), readFileSync(join(lWt, lTodo), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 'ok'))
      gitCommitFast(lWt, 'feat: local c4')
      await withQuietIo(() => handleFinalize({ task: 'loc-c4', json: true }, lRoots))
      gitCommitFast(lWt, 'docs: finalize local c4')
      const vlC4 = await withQuietIo(() => handleVerify({ task: 'loc-c4', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, lRoots))
      if (vlC4.res.exitCode !== 0) return `local c4 verify 失败：${vlC4.stderr} ${vlC4.stdout}`
      await passReview(lDir, lRoots, 'loc-c4', 'rev-a')
      const lmRes = await withQuietIo(() => handleMerge({ task: 'loc-c4', 'reviewer-id': 'rev-a', json: true }, lRoots))
      if (lmRes.res.exitCode !== 0) return `local-only Case 4 merge 失败：${lmRes.stderr}`
      const locAfter = getLocalIssue({ mainRoot: lDir, gitDir: lRoots.gitDir, number: locIss.number })
      if (!locAfter.body.includes('- [x] C1: `src/app.mjs` 导出 2') || !locAfter.body.includes('1/1 已完成') || locAfter.state !== 'CLOSED') {
        return `local-only Case 4 merge 未同步勾选 C1 或关单：\n${JSON.stringify(locAfter)}`
      }
      return true
    } finally {
      rmTree(dir); if (bare) rmTree(bare); rmTree(localRepo.dir)
    }
  }])

  cases.push(['IssueChecklistSync-3：Case 2 merge（无 SPEC/Todo）勾选 C1..C2 且不注入 plan-summary 与不误勾 Out of Scope', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const issuesMap = new Map([[30, {
        number: 30, title: 'Case 2 Bug', state: 'OPEN',
        body: '## 验收标准\n- [ ] C1: 修复空指针\n- [ ] C2: 单测通过\n\n## Out of Scope\n- [ ] 不改外部接口',
      }]])
      const { client, probe } = makeMockGh(issuesMap, new Map(), { number: 31, headRefName: 'fix/ics-c2', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'ics-c2', slug: 'ics-c2', case: '2', issue: '30', implementer: 'impl-2', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'ics-c2', agent: 'impl-2', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 'ics-c2')

      const wt = join(dir, '.worktrees/impl-ics-c2')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 3\n')
      gitCommitFast(wt, 'fix: c2')
      const vC2 = await withQuietIo(() => handleVerify({ task: 'ics-c2', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vC2.res.exitCode !== 0) return `c2 verify 失败：${vC2.stderr} ${vC2.stdout}`
      await passReview(dir, roots, 'ics-c2', 'rev-2')
      const lPre = readTaskLedger(dir, 'ics-c2')
      writeTaskLedger(dir, { ...lPre, prNumber: 31 })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mRes = await withQuietIo(() => handleMerge({ task: 'ics-c2', 'reviewer-id': 'rev-2', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `Case 2 merge 失败：${mRes.stderr}`
      const body30 = issuesMap.get(30)?.body ?? ''
      if (!body30.includes('- [x] C1: 修复空指针')
        || !body30.includes('- [x] C2: 单测通过')
        || body30.includes(PLAN_SUMMARY_START)
        || !body30.includes('- [ ] 不改外部接口')) {
        return `Case 2 merge 勾选或摘要注入违规：\n${body30}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['IssueChecklistSync-4：1:N 总控 PRD 部分切片合并只勾选已完成切片 C1、保留未完成 C2 且维持 Master Issue OPEN', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const prdRaw = [
        '---', 'kind: prd', 'title: "Master PRD"', 'status: active', 'tier: L3',
        'created: 2026-11-25', 'updated: 2026-11-25', 'issue: 169', 'owner: planner',
        'approved: true', 'multi_spec: true', 'plan_critique: passed (reviewer=crit-m, round=1, sha=11111111)', '---', '',
        '# Master PRD', '', '## 验收标准', '- [ ] C1: 切片一完成', '- [ ] C2: 切片二待完成', '',
      ].join('\n')
      const prdRel = 'docs/prd/261125-master-prd.md'
      const s1Rel = 'docs/specs/261125-issue170-s1-spec.md'
      const s2Rel = 'docs/specs/261125-issue171-s2-spec.md'
      const t1Rel = 'docs/todo/261125-issue170-s1-todo.md'
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      mkdirSync(join(dir, 'docs/todo'), { recursive: true })
      writeFileSync(join(dir, prdRel), prdRaw.replace('sha=11111111', `sha=${critiqueTextFingerprint(prdRaw)}`))
      writeFileSync(join(dir, s1Rel), buildSpecDoc({ taskId: 's1', issue: 170, relatedPrd: '../prd/261125-master-prd.md', criteriaLines: ['- [ ] C1: 切片一完成'] }))
      writeFileSync(join(dir, s2Rel), buildSpecDoc({ taskId: 's2', issue: 171, relatedPrd: '../prd/261125-master-prd.md', criteriaLines: ['- [ ] C2: 切片二待完成'], status: 'draft', approved: false }))
      writeFileSync(join(dir, t1Rel), buildTodoDoc({ taskId: 's1', issue: 170, specRel: '../specs/261125-issue170-s1-spec.md', criteriaLines: ['- [ ] C1: 切片一完成'] }))
      gitCommitFast(dir, 'docs: 1:N plans', { files: [prdRel, s1Rel, s2Rel, t1Rel], name: 'alice', email: 'alice@ics.test' })
      gitSync(dir, ['push', 'origin', 'main'])

      const issuesMap = new Map([
        [170, { number: 170, title: 'S1', state: 'OPEN', body: '- [ ] C1: 切片一完成' }],
        [169, { number: 169, title: 'Master', state: 'OPEN', body: '## 验收标准\n- [ ] C1: 切片一完成\n- [ ] C2: 切片二待完成' }],
      ])
      const { client, probe } = makeMockGh(issuesMap, new Map(), { number: 40, headRefName: 'feat/s1', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 's1', slug: 's1', case: '4', issue: '170', spec: s1Rel, todo: t1Rel, implementer: 'impl-s1', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 's1', agent: 'impl-s1', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 's1')

      const wt = join(dir, '.worktrees/impl-s1')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 4\n')
      writeFileSync(join(wt, s1Rel), readFileSync(join(wt, s1Rel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 's1 done'))
      writeFileSync(join(wt, t1Rel), readFileSync(join(wt, t1Rel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 's1 done'))
      gitCommitFast(wt, 'feat: s1')
      await withQuietIo(() => handleFinalize({ task: 's1', json: true }, roots))
      gitCommitFast(wt, 'docs: finalize s1')
      const vS1 = await withQuietIo(() => handleVerify({ task: 's1', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vS1.res.exitCode !== 0) return `s1 verify 失败：${vS1.stderr} ${vS1.stdout}`
      await passReview(dir, roots, 's1', 'rev-s1')
      const lPre = readTaskLedger(dir, 's1')
      writeTaskLedger(dir, { ...lPre, prNumber: 40, linkedIssues: [170, 169] })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mRes = await withQuietIo(() => handleMerge({ task: 's1', 'reviewer-id': 'rev-s1', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `1:N s1 merge 失败：${mRes.stderr}`
      const m169 = issuesMap.get(169)
      if (m169?.state !== 'OPEN'
        || !m169.body.includes('- [x] C1: 切片一完成')
        || !m169.body.includes('- [ ] C2: 切片二待完成')
        || !m169.body.includes('1/2 已完成')) {
        return `1:N Master Issue #169 部分切片合并同步异常：\n${JSON.stringify(m169)}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['IssueChecklistSync-5：planBootstrap 合并绝不勾选任何 C1..Cn 并保留 Master Issue OPEN', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const prdRaw = [
        '---', 'kind: prd', 'title: "Bootstrap PRD"', 'status: active', 'tier: L3',
        'created: 2026-11-25', 'updated: 2026-11-25', 'issue: 190', 'owner: planner',
        'approved: true', 'multi_spec: true', 'plan_critique: passed (reviewer=crit-b, round=1, sha=11111111)', '---', '',
        '# Bootstrap PRD', '', '## 验收标准', '- [ ] C1: 规划引导项 1', '- [ ] C2: 规划引导项 2', '',
      ].join('\n')
      const prdRel = 'docs/prd/261125-boot-prd.md'
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      writeFileSync(join(dir, prdRel), prdRaw.replace('sha=11111111', `sha=${critiqueTextFingerprint(prdRaw)}`))
      gitCommitFast(dir, 'docs: bootstrap seed', { files: [prdRel], name: 'alice', email: 'alice@ics.test' })
      gitSync(dir, ['push', 'origin', 'main'])

      const issuesMap = new Map([[190, {
        number: 190, title: 'Bootstrap Master', state: 'OPEN',
        body: '## 验收标准\n- [ ] C1: 规划引导项 1\n- [ ] C2: 规划引导项 2',
      }]])
      const { client, probe } = makeMockGh(issuesMap, new Map(), { number: 50, headRefName: 'docs/boot', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'boot-t', slug: 'boot-t', case: '4', issue: '190', prd: prdRel, 'allow-plan-bootstrap': true, implementer: 'impl-b', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'boot-t', agent: 'impl-b', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 'boot-t')

      const wt = join(dir, '.worktrees/impl-boot-t')
      writeFileSync(join(wt, prdRel), `${readFileSync(join(wt, prdRel), 'utf8')}\n<!-- bootstrap note -->\n`)
      gitCommitFast(wt, 'docs: bootstrap plan')
      const vBoot = await withQuietIo(() => handleVerify({ task: 'boot-t', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vBoot.res.exitCode !== 0) return `boot-t verify 失败：${vBoot.stderr} ${vBoot.stdout}`
      await passReview(dir, roots, 'boot-t', 'rev-b')
      const lPre = readTaskLedger(dir, 'boot-t')
      writeTaskLedger(dir, { ...lPre, prNumber: 50, planBootstrap: true })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mRes = await withQuietIo(() => handleMerge({ task: 'boot-t', 'reviewer-id': 'rev-b', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `planBootstrap merge 失败：${mRes.stderr}`
      const m190 = issuesMap.get(190)
      if (m190?.state !== 'OPEN'
        || !m190.body.includes('- [ ] C1: 规划引导项 1')
        || !m190.body.includes('- [ ] C2: 规划引导项 2')) {
        return `planBootstrap merge 不应勾选或关闭 Issue #190：\n${JSON.stringify(m190)}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['IssueChecklistSync-6：合并关闭关联 escalatedIssues(#180) 并勾选其 C1，已 CLOSED #181 保持原样不误触', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const issuesMap = new Map([
        [180, { number: 180, title: 'Open E2E', state: 'OPEN', body: '## 验收标准\n- [ ] C1: 修复 E2E 回归' }],
        [181, { number: 181, title: 'Closed E2E', state: 'CLOSED', body: '## 验收标准\n- [ ] C1: 已历史关闭不重改' }],
      ])
      const { client, probe, closedNums } = makeMockGh(issuesMap, new Map(), { number: 60, headRefName: 'fix/esc', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'esc-t', slug: 'esc-t', case: '2', 'no-issue': true, reason: '仅测 escalatedIssues 闭环', implementer: 'impl-e', json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'esc-t', agent: 'impl-e', json: true }, roots))
      await seedExploredFor(dir, 'esc-t')

      const wt = join(dir, '.worktrees/impl-esc-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 6\n')
      gitCommitFast(wt, 'fix: resolve e2e')
      const vEsc = await withQuietIo(() => handleVerify({ task: 'esc-t', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vEsc.res.exitCode !== 0) return `esc-t verify 失败：${vEsc.stderr} ${vEsc.stdout}`
      await passReview(dir, roots, 'esc-t', 'rev-e')
      const lPre = readTaskLedger(dir, 'esc-t')
      writeTaskLedger(dir, { ...lPre, role: 'maintainer', providerId: 'github', prNumber: 60, escalatedIssues: [180, 181] })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mRes = await withQuietIo(() => handleMerge({ task: 'esc-t', 'reviewer-id': 'rev-e', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `escalatedIssues merge 失败：${mRes.stderr}`
      const i180 = issuesMap.get(180)
      const i181 = issuesMap.get(181)
      if (!closedNums.includes(180) || closedNums.includes(181)
        || !i180?.body.includes('- [x] C1: 修复 E2E 回归')
        || i180?.body.includes(PLAN_SUMMARY_START)
        || !i181?.body.includes('- [ ] C1: 已历史关闭不重改')) {
        return `escalatedIssues 勾选或关单异常：i180=${JSON.stringify(i180)} i181=${JSON.stringify(i181)}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['IssueChecklistSync-7：flow batch merge-queue 同步勾选 Issue C1..Cn、刷新摘要、清理标签并关闭工单', async () => {
    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const specRel = 'docs/specs/261125-issue70-mq-spec.md'
      const todoRel = 'docs/todo/261125-issue70-mq-todo.md'
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      mkdirSync(join(dir, 'docs/todo'), { recursive: true })
      writeFileSync(join(dir, specRel), buildSpecDoc({ taskId: 'mq-t', issue: 70 }))
      writeFileSync(join(dir, todoRel), buildTodoDoc({ taskId: 'mq-t', issue: 70, specRel: '../specs/261125-issue70-mq-spec.md' }))
      gitCommitFast(dir, 'docs: mq plan', { files: [specRel, todoRel], name: 'alice', email: 'alice@ics.test' })
      gitSync(dir, ['push', 'origin', 'main'])

      const labelsMap = new Map([
        [70, new Set(['planning', 'in-review', 'keep-label'])],
        [71, new Set(['in-review', 'feature'])],
      ])
      const issuesMap = new Map([[70, {
        number: 70, title: 'MQ Issue', state: 'OPEN',
        body: `## 验收标准\n- [ ] C1: \`src/app.mjs\` 导出 2\n\n${PLAN_SUMMARY_START}\n### 规划摘要（自动同步）\n- **验收进度**：0/1 已完成\n${PLAN_SUMMARY_END}`,
      }]])
      const { client, probe, closedNums } = makeMockGh(issuesMap, labelsMap, { number: 71, headRefName: 'feat/mq-t', baseRefName: 'main' })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'mq-t', slug: 'mq-t', case: '4', issue: '70', spec: specRel, todo: todoRel, implementer: 'impl-q', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'mq-t', agent: 'impl-q', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 'mq-t')

      const wt = join(dir, '.worktrees/impl-mq-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 7\n')
      writeFileSync(join(wt, specRel), readFileSync(join(wt, specRel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 'mq done'))
      writeFileSync(join(wt, todoRel), readFileSync(join(wt, todoRel), 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', 'mq done'))
      gitCommitFast(wt, 'feat: mq')
      await withQuietIo(() => handleFinalize({ task: 'mq-t', json: true }, roots))
      gitCommitFast(wt, 'docs: finalize mq')
      const vMq = await withQuietIo(() => handleVerify({ task: 'mq-t', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vMq.res.exitCode !== 0) return `mq-t verify 失败：${vMq.stderr} ${vMq.stdout}`
      await passReview(dir, roots, 'mq-t', 'rev-q')
      const lPre = readTaskLedger(dir, 'mq-t')
      writeTaskLedger(dir, { ...lPre, prNumber: 71 })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])

      const mqOut = await withQuietIo(() => handleBatch({
        _: ['merge-queue'], tasks: 'mq-t', 'reviewer-id': 'rev-q', _ghClient: client, _ghProbe: probe, json: true,
      }, roots))
      if (mqOut.res.exitCode !== 0 || mqOut.res.processed?.[0]?.status !== 'merged') {
        return `merge-queue 执行失败：${JSON.stringify(mqOut.res)}`
      }
      const iss70 = issuesMap.get(70)
      if (!closedNums.includes(70)
        || !iss70?.body.includes('- [x] C1: `src/app.mjs` 导出 2')
        || !iss70?.body.includes('1/1 已完成')
        || labelsMap.get(70).has('in-review')
        || !labelsMap.get(70).has('keep-label')
        || labelsMap.get(71).has('in-review')
        || !labelsMap.get(71).has('feature')) {
        return `merge-queue 合并后 Issue 同步或标签清理异常：iss70=${JSON.stringify(iss70)} labels70=${JSON.stringify([...labelsMap.get(70)])}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['IssueChecklistSync-8：反向检查 flow close 与 flow intake 不得勾选验收清单', async () => {
    const { dir } = makeBaseRepo({ withOrigin: false })
    try {
      const roots = await resolveRepoRoots(dir)
      const iss1 = await createLocalIssue({
        mainRoot: dir, gitDir: roots.gitDir, title: 'Duplicate Issue',
        body: '## 验收标准\n- [ ] C1: 保持未勾选',
      })
      const iss2 = await createLocalIssue({
        mainRoot: dir, gitDir: roots.gitDir, title: 'Intake Reject Issue',
        body: '## 验收标准\n- [ ] C1: 分诊拒绝也不勾选',
      })

      const closeRes = await withQuietIo(() => handleClose({
        issue: String(iss1.number), reason: 'duplicate', json: true,
      }, roots))
      if (closeRes.res.exitCode !== 0) return `flow close 失败：${closeRes.stderr}`
      const afterClose = getLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, number: iss1.number })
      if (afterClose.state !== 'CLOSED' || !afterClose.body.includes('- [ ] C1: 保持未勾选')) {
        return `flow close 不应勾选验收标准：\n${JSON.stringify(afterClose)}`
      }

      const intakeRes = await withQuietIo(() => handleIntake({
        issue: String(iss2.number), decision: 'reject', rationale: '不在项目定位范围内，不予采纳', apply: true, json: true,
      }, roots))
      if (intakeRes.res.exitCode !== 0) return `flow intake 失败：${intakeRes.stderr}`
      const afterIntake = getLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, number: iss2.number })
      if (!afterIntake.body.includes('- [ ] C1: 分诊拒绝也不勾选')) {
        return `flow intake 不应勾选验收标准：\n${JSON.stringify(afterIntake)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['IssueChecklistSync-9：local-only 与 generic-git 经 flow merge 与 batch merge-queue 实写本地工单 JSON 勾选 C*', async () => {
    const { dir: locDir } = makeBaseRepo({ withOrigin: false })
    const genDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Gen\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
      'src/app.mjs': 'export const v = 1\n',
    })
    const genBare = tmpProject({})
    gitInit(genBare, { bare: true })
    gitInit(genDir, { branch: 'main', name: 'alice', email: 'alice@gen.local', origin: 'https://git.internal.example/org/repo.git' })
    gitSync(genDir, ['remote', 'set-url', '--push', 'origin', genBare.replace(/\\/g, '/')])
    gitSync(genDir, ['remote', 'set-url', 'origin', genBare.replace(/\\/g, '/')])
    gitSync(genDir, ['push', '-u', 'origin', 'main'])
    try {
      // 1) local-only + flow batch merge-queue 更新 .git/project-forge-flow/issues/items/<N>.json
      const lRoots = await resolveRepoRoots(locDir)
      const locIss = await createLocalIssue({ mainRoot: locDir, gitDir: lRoots.gitDir, title: 'Local MQ', body: '## 验收标准\n- [ ] C1: 本地队列勾选' })
      await withQuietIo(() => handleStart({ task: 'lmq', slug: 'lmq', case: '2', issue: String(locIss.number), implementer: 'impl-l', json: true }, lRoots))
      await withQuietIo(() => handleClaim({ task: 'lmq', agent: 'impl-l', json: true }, lRoots))
      await seedExploredFor(locDir, 'lmq')
      const lWt = join(locDir, '.worktrees/impl-lmq')
      writeFileSync(join(lWt, 'src/app.mjs'), 'export const v = 9\n')
      gitCommitFast(lWt, 'fix: local mq')
      const vl = await withQuietIo(() => handleVerify({ task: 'lmq', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, lRoots))
      if (vl.res.exitCode !== 0) return `local mq verify 失败：${vl.stderr}`
      await passReview(locDir, lRoots, 'lmq', 'rev-l')
      const lMqOut = await withQuietIo(() => handleBatch({ _: ['merge-queue'], tasks: 'lmq', 'reviewer-id': 'rev-l', json: true }, lRoots))
      if (lMqOut.res.exitCode !== 0) return `local-only merge-queue 失败：${JSON.stringify(lMqOut.res)}`
      const locJson = JSON.parse(readFileSync(join(lRoots.gitDir, 'project-forge-flow/issues/items', `${locIss.number}.json`), 'utf8'))
      if (locJson.state !== 'CLOSED' || !locJson.body.includes('- [x] C1: 本地队列勾选')) {
        return `local-only merge-queue 未持久化勾选本地工单 JSON：\n${JSON.stringify(locJson)}`
      }

      // 2) generic-git + flow merge 更新 .git/project-forge-flow/issues/items/<N>.json
      const gRoots = await resolveRepoRoots(genDir)
      const genIss = await createLocalIssue({ mainRoot: genDir, gitDir: gRoots.gitDir, title: 'Generic Issue', body: '## 验收标准\n- [ ] C1: generic-git 勾选' })
      await withQuietIo(() => handleStart({ task: 'gen-t', slug: 'gen-t', case: '2', issue: String(genIss.number), implementer: 'impl-g', json: true }, gRoots))
      await withQuietIo(() => handleClaim({ task: 'gen-t', agent: 'impl-g', json: true }, gRoots))
      await seedExploredFor(genDir, 'gen-t')
      const gWt = join(genDir, '.worktrees/impl-gen-t')
      writeFileSync(join(gWt, 'src/app.mjs'), 'export const v = 10\n')
      gitCommitFast(gWt, 'fix: generic change')
      const vg = await withQuietIo(() => handleVerify({ task: 'gen-t', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, gRoots))
      if (vg.res.exitCode !== 0) return `generic-git verify 失败：${vg.stderr}`
      await passReview(genDir, gRoots, 'gen-t', 'rev-g')
      const gPre = readTaskLedger(genDir, 'gen-t')
      gitSync(gWt, ['push', '-u', 'origin', gPre.branch])
      // 模拟自建托管远端已完成合并：推进 bare main
      gitSync(genDir, ['merge', '--no-ff', gPre.branch, '-m', 'merge remote MR'])
      gitSync(genDir, ['push', 'origin', 'main'])
      const gmOut = await withQuietIo(() => handleMerge({ task: 'gen-t', 'reviewer-id': 'rev-g', json: true }, gRoots))
      if (gmOut.res.exitCode !== 0) return `generic-git merge 失败：${gmOut.stderr} ${gmOut.stdout}`
      const genJson = JSON.parse(readFileSync(join(gRoots.gitDir, 'project-forge-flow/issues/items', `${genIss.number}.json`), 'utf8'))
      if (genJson.state !== 'CLOSED' || !genJson.body.includes('- [x] C1: generic-git 勾选')) {
        return `generic-git merge 未持久化勾选本地工单 JSON：\n${JSON.stringify(genJson)}`
      }
      return true
    } finally { rmTree(locDir); rmTree(genDir); rmTree(genBare) }
  }])

  cases.push(['IssueChecklistSync-10：plan-sync(!hasApi) 多 Issue 全部同步与清标，且 planBootstrap 在 local-only submit 回写产出目录但不勾 C*', async () => {
    const { dir } = makeBaseRepo({ withOrigin: false })
    try {
      const roots = await resolveRepoRoots(dir)
      const i1 = await createLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, title: 'Multi 1', body: '- [ ] C1: 第一条', labels: ['planning'] })
      const i2 = await createLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, title: 'Multi 2', body: '- [ ] C1: 第一条\n- [ ] C2: 第二条', labels: ['planning'] })
      const prdRel = 'docs/prd/261125-boot-local-prd.md'
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      const prdRaw = [
        '---', 'kind: prd', 'title: "Local Boot"', 'status: approved', 'tier: L3',
        'created: 2026-11-25', 'updated: 2026-11-25', `issue: ${i1.number}`, 'owner: planner',
        'approved: true', 'multi_spec: true', 'plan_critique: passed (reviewer=crit-1, round=1, sha=11111111)', '---', '',
        '# PRD', '', '## 验收标准', '- [x] C1: 第一条', '- [ ] C2: 第二条', '',
      ].join('\n')
      writeFileSync(join(dir, prdRel), prdRaw.replace('sha=11111111', `sha=${critiqueTextFingerprint(prdRaw)}`))

      const ps = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'approve', file: prdRel,
        issueNumbers: [i1.number, i2.number], role: 'local-only', providerId: 'none',
      })
      if (!ps.ok || !ps.notApplicable) return `local-only plan-sync 返回异常：${JSON.stringify(ps)}`
      const after1 = getLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, number: i1.number })
      const after2 = getLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, number: i2.number })
      if (!after1.body.includes('- [x] C1:') || !after2.body.includes('- [x] C1:') || !after2.body.includes('- [ ] C2:')
        || after1.labels.includes('planning') || after2.labels.includes('planning')
        || !after1.labels.includes('approved') || !after2.labels.includes('approved')
        || after1.comments.length === 0 || after2.comments.length === 0) {
        return `!hasApi 多 Issue 同步/清标遗漏：i1=${JSON.stringify(after1)} i2=${JSON.stringify(after2)}`
      }

      // planBootstrap 在 local-only submit 回写 ## 规划产出文档 且保持 C* 未勾
      const bootPrdRel = 'docs/prd/261125-boot-only-prd.md'
      const bootPrdRaw = [
        '---', 'kind: prd', 'title: "Boot Only"', 'status: approved', 'tier: L3',
        'created: 2026-11-25', 'updated: 2026-11-25', 'owner: planner',
        'approved: true', 'multi_spec: true', 'plan_critique: passed (reviewer=crit-1, round=1, sha=11111111)', '---', '',
        '# Boot Only', '', '## 验收标准', '- [ ] C1: 引导项', '',
      ].join('\n')
      writeFileSync(join(dir, bootPrdRel), bootPrdRaw.replace('sha=11111111', `sha=${critiqueTextFingerprint(bootPrdRaw)}`))
      const bootIss = await createLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, title: 'Boot Local', body: '## 验收标准\n- [ ] C1: 引导项' })
      gitCommitFast(dir, 'docs: seed boot prd')
      await withQuietIo(() => handleStart({ task: 'boot-loc', slug: 'boot-loc', case: '4', issue: String(bootIss.number), prd: bootPrdRel, 'allow-plan-bootstrap': true, implementer: 'impl-bl', json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'boot-loc', agent: 'impl-bl', json: true }, roots))
      await seedExploredFor(dir, 'boot-loc')
      const bWt = join(dir, '.worktrees/impl-boot-loc')
      writeFileSync(join(bWt, bootPrdRel), `${readFileSync(join(bWt, bootPrdRel), 'utf8')}\n<!-- local boot -->\n`)
      gitCommitFast(bWt, 'docs: boot local')
      await withQuietIo(() => handleFinalize({ task: 'boot-loc', json: true }, roots))
      gitCommitFast(bWt, 'docs: finalize boot local')
      const vb = await withQuietIo(() => handleVerify({ task: 'boot-loc', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vb.res.exitCode !== 0) return `boot-loc verify 失败：${vb.stderr}`
      writeTaskLedger(dir, { ...readTaskLedger(dir, 'boot-loc'), planBootstrap: true })
      const subRes = await withQuietIo(() => handleSubmit({ task: 'boot-loc', agent: 'impl-bl', json: true }, roots))
      if (subRes.res.exitCode !== 0) return `boot-loc submit 失败：${subRes.stderr}`
      const bootAfter = getLocalIssue({ mainRoot: dir, gitDir: roots.gitDir, number: bootIss.number })
      if (!bootAfter.body.includes('## 规划产出文档') || !bootAfter.body.includes(bootPrdRel) || !bootAfter.body.includes('- [ ] C1: 引导项')) {
        return `local-only planBootstrap submit 未回写规划产出文档或误勾 C1：\n${JSON.stringify(bootAfter)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['IssueChecklistSync-11：mcp-delegate / updateIssueBody 失败从 syncIssueSummaryBody 返回 false 并记入 syncFailures', async () => {
    const ghDeleg = createGitHubClient({ tier: 'mcp-delegate' })
    const delegBackend = createTaskBackend({ role: 'maintainer', providerId: 'github', targetRepo: 'acme/ics', client: {
      ...ghDeleg,
      getIssue: async () => ({ ok: true, number: 88, state: 'OPEN', body: '- [ ] C1: 需更新' }),
    } })
    const bodyRes = await syncIssueSummaryBody(delegBackend, { repo: 'acme/ics', number: 88, summaryBlock: null, markAllCriteriaDone: true })
    if (bodyRes !== false) return `mcp-delegate updateIssueBody 应返回 false 却返回：${String(bodyRes)}`
    const nullRes = await syncIssueSummaryBody({
      getIssue: async () => ({ ok: true, number: 88, state: 'OPEN', body: '- [ ] C1: 需更新' }),
      updateIssueBody: async () => ({ delegated: true }),
    }, { repo: 'acme/ics', number: 88, summaryBlock: null, markAllCriteriaDone: true })
    if (nullRes !== false) return `缺 ok:true 的 delegated 响应应返回 false 却返回：${String(nullRes)}`

    const { dir, bare } = makeBaseRepo({ withOrigin: true })
    try {
      const issuesMap = new Map([[88, { number: 88, title: 'Fail Update', state: 'OPEN', body: '## 验收标准\n- [ ] C1: 失败记账' }]])
      const { client, probe } = makeMockGh(issuesMap, new Map(), { number: 89, headRefName: 'fix/fail-upd', baseRefName: 'main' })
      client.updateIssueBody = async () => ({ ok: false, delegated: true })
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'fail-upd', slug: 'fail-upd', case: '2', issue: '88', implementer: 'impl-f', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await withQuietIo(() => handleClaim({ task: 'fail-upd', agent: 'impl-f', _ghClient: client, _ghProbe: probe, json: true }, roots))
      await seedExploredFor(dir, 'fail-upd')
      const wt = join(dir, '.worktrees/impl-fail-upd')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 88\n')
      gitCommitFast(wt, 'fix: fail upd')
      const vf = await withQuietIo(() => handleVerify({ task: 'fail-upd', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vf.res.exitCode !== 0) return `fail-upd verify 失败：${vf.stderr}`
      await passReview(dir, roots, 'fail-upd', 'rev-f')
      const lPre = readTaskLedger(dir, 'fail-upd')
      writeTaskLedger(dir, { ...lPre, prNumber: 89 })
      gitSync(wt, ['push', '-u', 'origin', lPre.branch])
      const mRes = await withQuietIo(() => handleMerge({ task: 'fail-upd', 'reviewer-id': 'rev-f', _ghClient: client, _ghProbe: probe, json: true }, roots))
      if (mRes.res.exitCode !== 0) return `fail-upd merge 失败：${mRes.stderr}`
      const lAfter = readTaskLedger(dir, 'fail-upd')
      if (!lAfter.syncFailures?.some((f) => f.target === 'Issue #88' && f.error === 'issue_body_sync_failed')) {
        return `updateIssueBody 失败未记入 ledger.syncFailures：${JSON.stringify(lAfter.syncFailures)}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])
}
