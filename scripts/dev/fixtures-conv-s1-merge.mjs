/**
 * fixtures-conv-s1-merge.mjs —— #827 PR 去重、E2E 升级工单自动闭环与合并后标签/摘要终态同步正反双向行为断言。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { critiqueTextFingerprint } from '../../kit/skills/lib/critique-rounds.mjs'
import { escalateToBackend } from '../../kit/skills/lib/escalation.mjs'
import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

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

export function registerConvS1MergeCases(cases) {
  cases.push(['Conv-S1Merge #827：PR Issue 引用去重、escalatedIssues 自动闭环与 merge 标签/摘要终态同步', async () => {
    const masterPrd = [
      '---', 'kind: prd', 'title: "Master"', 'status: active', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 169', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true', 'multi_spec: true',
      'plan_critique: passed (reviewer=crit-m, round=1, sha=11111111)',
      '---', '', '# Master PRD', '', '- [ ] C1: 切片 1', '- [ ] C2: 切片 2', '',
    ].join('\n')
    const spec1 = [
      '---', 'kind: spec', 'title: "M827 Spec"', 'status: approved', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 174', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true', 'implemented: false',
      'plan_critique: passed (reviewer=crit-1, round=1, sha=11111111)',
      'related_prd: ../prd/261124-master-prd.md', 'scope_files: [src/app.mjs]',
      '---', '', '# SPEC: M827', '', '## 要解决的问题', '- 验证合并后收尾一致性', '',
      '## 门型与回滚路径', '- two-way，git revert', '',
      '## 验收标准', '', '- [ ] C1: `src/app.mjs` 导出 2', '',
      '## 实现说明', '', '待填写。', '',
    ].join('\n')
    const spec2 = [
      '---', 'kind: spec', 'title: "Sibling Spec"', 'status: draft', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: null', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: false', 'implemented: false',
      'related_prd: ../prd/261124-master-prd.md', 'scope_files: []',
      '---', '', '# SPEC: Sibling', '', '## 验收标准', '', '- [ ] C1: 未完成兄弟切片', '',
    ].join('\n')
    const todo1 = [
      '---', 'kind: todo', 'title: "M827 Todo"', 'status: active', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 174', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true',
      'related_prd: ../prd/261124-master-prd.md', 'related_spec: ../specs/261124-issue174-m-spec.md',
      '---', '', '# Todo: M827', '', '## 验收标准', '', '- [ ] C1: `src/app.mjs` 导出 2', '',
      '## 完成后的记录', '', '待填写。', '',
    ].join('\n')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.github/pull_request_template.md': '## 变更摘要\n\n## 关联 Issue\n\n## 验证证据\n',
      'package.json': '{"name":"m827","version":"1.0.0","repository":"https://github.com/acme/m827.git"}\n',
      'AGENTS.md': '# M827\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/app.mjs': 'export const val = 1\n',
      'docs/prd/261124-master-prd.md': masterPrd.replace('sha=11111111', `sha=${critiqueTextFingerprint(masterPrd)}`),
      'docs/specs/261124-issue174-m-spec.md': spec1.replace('sha=11111111', `sha=${critiqueTextFingerprint(spec1)}`),
      'docs/specs/261124-s2-spec.md': spec2,
      'docs/todo/261124-issue174-m-todo.md': todo1,
    })
    const bare = tmpProject({})
    gitInit(bare, { bare: true })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@m827.test', origin: 'https://github.com/acme/m827.git' })
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.replace(/\\/g, '/')])
    gitSync(dir, ['push', '-u', 'origin', 'main'])

    const labels = new Map([
      [20, new Set(['planning', 'in-progress', 'in-review', 'changes-requested', 'needs-human-decision', 'feature'])],
      [174, new Set(['planning', 'in-progress', 'in-review', 'changes-requested', 'needs-human-decision', 'enhancement'])],
      [169, new Set(['planning', 'in-progress', 'in-review'])],
      [180, new Set(['e2e-fail', 'in-progress'])],
      [181, new Set(['e2e-fail'])],
    ])
    const issues = new Map([
      [174, {
        number: 174, title: 'M827', state: 'OPEN',
        body: '## 关联的设计产物\n- SPEC：`docs/specs/261124-issue174-m-spec.md`\n\n<!-- pf:plan-summary:start -->\n### 规划摘要（自动同步）\n- **验收进度**：0/1 已完成\n<!-- pf:plan-summary:end -->\n',
      }],
      [169, { number: 169, title: 'Master', state: 'OPEN', body: '# Master\n' }],
      [181, { number: 181, title: 'Already closed E2E', state: 'CLOSED', body: '# Closed E2E\n' }],
    ])
    const comments = []
    const closedNums = []
    let nextEscNo = 180
    const ghCli = {
      tier: 'gh-cli', login: 'rev-m',
      createIssue: async ({ title, body }) => {
        const number = nextEscNo
        nextEscNo = 182
        issues.set(number, { number, title, body, state: 'OPEN' })
        return { ok: true, number, title, url: `https://github.com/acme/m827/issues/${number}` }
      },
      listIssues: async () => ({ ok: true, issues: [...issues.values()] }),
      getIssue: async (repoOrObj, num) => {
        const n = Number(typeof repoOrObj === 'object' ? repoOrObj?.number : num)
        const found = issues.get(n)
        return found ? { ok: true, ...found } : { ok: false, status: 404 }
      },
      updateIssueBody: async ({ number, body }) => {
        const cur = issues.get(Number(number)) ?? { number: Number(number), state: 'OPEN' }
        issues.set(Number(number), { ...cur, body })
        return { ok: true, number: Number(number), body }
      },
      closeIssue: async ({ number }) => {
        const n = Number(number)
        closedNums.push(n)
        const cur = issues.get(n)
        if (cur) issues.set(n, { ...cur, state: 'CLOSED' })
        return { ok: true, number: n }
      },
      removeLabel: async ({ number, label }) => {
        labels.get(Number(number))?.delete(label)
        return { ok: true }
      },
      addLabels: async () => ({ ok: true }),
      syncStateLabel: async () => ({ ok: true }),
      listComments: async () => ({ ok: true, comments: [] }),
      postComment: async ({ number, body }) => { comments.push({ number: Number(number), body }); return { ok: true, id: comments.length } },
      getCommitChecks: async () => ({ ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [] }),
      getPr: async () => ({
        ok: true, number: 20, state: 'OPEN',
        headRefName: 'feat/m827', baseRefName: 'main',
      }),
      mergePr: async () => ({ ok: true, merged: true, state: 'MERGED', sha: 'merged-sha' }),
    }
    const ghProbe = { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'rev-m' } }, client: ghCli }

    try {
      const roots = await resolveRepoRoots(dir)

      // 1. #827(a) hydratePrTemplateBody 对 linkedIssues 与 rawBody 中的重复 #N 去重
      const prBody = hydratePrTemplateBody({
        repoRoot: dir,
        taskId: 'm827',
        ledger: {
          caseType: 4, branch: 'feat/m827', baseBranch: 'main',
          specFile: 'docs/specs/261124-issue174-m-spec.md',
          todoFile: 'docs/todo/261124-issue174-m-todo.md',
          prdFile: 'docs/prd/261124-master-prd.md',
          linkedIssues: [174, 174, 169, 169],
        },
        currentHead: 'abc1234',
        rawBody: 'Part of #169\nFixes #174\nPart of #200\nPart of #200\n补充描述',
      })
      const matches174 = prBody.match(/Fixes #174\b/g) ?? []
      const matches169 = prBody.match(/Part of #169\b/g) ?? []
      const matches200 = prBody.match(/Part of #200\b/g) ?? []
      if (matches174.length !== 1 || matches169.length !== 1 || matches200.length !== 1 || /Fixes #169\b/.test(prBody) || !prBody.includes('补充描述')) {
        return `PR 正文未正确去重 Issue 引用：\n${prBody}`
      }

      // 2. 启动、认领、探索、记录 e2e-fail 升级工单（#180 入 ledger.escalatedIssues；普通非 e2e 单不入）
      await withQuietIo(() => handleStart({
        task: 'm827', case: '4', slug: 'm827', agent: 'impl-m', issue: '174',
        spec: 'docs/specs/261124-issue174-m-spec.md', todo: 'docs/todo/261124-issue174-m-todo.md',
        _ghClient: ghCli, _ghProbe: ghProbe, json: true,
      }, roots))
      await withQuietIo(() => handleClaim({ task: 'm827', agent: 'impl-m', _ghClient: ghCli, _ghProbe: ghProbe, json: true }, roots))
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['explore', '--task', 'm827', '--json'], { cwd: dir })

      const wt = join(dir, '.worktrees/impl-m827')
      const backend = createTaskBackend({ role: 'maintainer', providerId: 'github', targetRepo: 'acme/m827', mainRoot: dir, gitDir: roots.gitDir, client: ghCli })
      const escOpen = await escalateToBackend({
        backend, targetRepo: 'acme/m827', repoRoot: wt,
        item: {
          kind: 'e2e-fail', title: 'm827 E2E 失败', taskId: 'm827', e2eBlocking: true, labels: ['e2e-fail'],
          summary: 'E2E 报错', evidence: ['node test => 1'], unknowns: ['root'], nextSteps: ['fix'],
          docRefs: ['docs/specs/261124-issue174-m-spec.md'],
        },
      })
      const escNonE2e = await escalateToBackend({
        backend, targetRepo: 'acme/m827', repoRoot: wt,
        item: {
          kind: 'tech-debt', title: '普通债务单', taskId: 'm827', labels: ['tech-debt'], forceIssue: true,
          summary: '债务', evidence: ['audit => warn'], unknowns: ['scope'], nextSteps: ['clean'],
          docRefs: ['docs/specs/261124-issue174-m-spec.md'],
        },
      })
      const lEsc = readTaskLedger(dir, 'm827')
      if (!escOpen.ok || escOpen.number !== 180 || !escNonE2e.ok || escNonE2e.number !== 182
        || !lEsc.escalatedIssues?.includes(180) || lEsc.escalatedIssues?.includes(182)) {
        return `escalatedIssues 追踪异常：open=${JSON.stringify(escOpen)} nonE2e=${JSON.stringify(escNonE2e)} ledger=${JSON.stringify(lEsc.escalatedIssues)}`
      }

      // 3. 实施、完成勾选、finalize、verify、review pass 后执行 flow merge
      writeFileSync(join(wt, 'src/app.mjs'), 'export const val = 2\n', 'utf8')
      const todoPath = join(wt, 'docs/todo/261124-issue174-m-todo.md')
      const specPath = join(wt, 'docs/specs/261124-issue174-m-spec.md')
      writeFileSync(todoPath, readFileSync(todoPath, 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', '完成 M827 验证。'), 'utf8')
      writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('- [ ] C1:', '- [x] C1:').replace('待填写。', '已更新 app.mjs 导出 2。'), 'utf8')
      gitCommitFast(wt, 'feat: complete m827')
      const fin = await withQuietIo(() => handleFinalize({ task: 'm827', json: true }, roots))
      if (fin.res.exitCode !== 0) return `finalize 失败：${fin.stderr} ${fin.stdout}`
      gitCommitFast(wt, 'docs: finalize m827')
      const ver = await withQuietIo(() => handleVerify({ task: 'm827', mode: 'gate', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (ver.res.exitCode !== 0) return `verify 失败：${ver.stderr}`
      await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'm827', '--round', '1', '--reviewer-id', 'rev-m', '--json'], { cwd: dir })
      await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['check-empirical', '--task', 'm827', '--round', '1', '--json'], { cwd: dir })
      await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['check-fault', '--phase', 'fail', '--task', 'm827', '--round', '1', '--cmd', 'node -e "process.exit(1)"', '--json'], { cwd: dir })
      await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['check-fault', '--phase', 'restore', '--task', 'm827', '--round', '1', '--cmd', 'exit 0', '--json'], { cwd: dir })
      const revTok = await issueTokenFor(dir, 'm827', 1)
      const rec = await withQuietIo(() => handleRecord({
        task: 'm827', round: '1', verdict: 'pass', 'reviewer-id': 'rev-m', 'review-token': revTok,
        evidence: 'run: exit 0 => exit 0', json: true,
      }, roots))
      if (rec.res !== 0) return `record 失败：exit=${rec.res} err=${rec.stderr}`

      const lPreMerge = readTaskLedger(dir, 'm827')
      writeTaskLedger(dir, {
        ...lPreMerge,
        prNumber: 20,
        linkedIssues: [174, 169],
        escalatedIssues: [180, 181],
      })
      gitSync(wt, ['push', '-u', 'origin', lPreMerge.branch])

      const mergeOut = await withQuietIo(() => handleMerge({
        task: 'm827', 'reviewer-id': 'rev-m', _ghClient: ghCli, _ghProbe: ghProbe, json: true,
      }, roots))
      if (mergeOut.res.exitCode !== 0) return `merge 失败：exit=${mergeOut.res.exitCode} err=${mergeOut.stderr} out=${mergeOut.stdout}`

      // 验证 #827(b): #180 已评论提及 PR #20 并关闭，已 CLOSED 的 #181 未重复关闭
      if (!closedNums.includes(174) || !closedNums.includes(180) || closedNums.includes(169) || closedNums.includes(181)) {
        return `merge 关闭决策错误：closedNums=${JSON.stringify(closedNums)}`
      }
      if (!comments.some((c) => c.number === 180 && c.body.includes('PR #20')) || comments.some((c) => c.number === 181)) {
        return `升级工单评论错误：${JSON.stringify(comments)}`
      }
      // 验证 #827(c): PR #20 与子单 #174 清除 5 个过渡标签但保留其他标签；总控 #169 保留 planning
      const prL = labels.get(20)
      const iss174L = labels.get(174)
      const iss169L = labels.get(169)
      if (!prL.has('feature') || prL.has('in-review') || prL.has('planning') || !iss174L.has('enhancement') || iss174L.has('planning') || iss174L.has('in-progress')) {
        return `PR/子单标签清理异常：pr=${JSON.stringify([...prL])} iss174=${JSON.stringify([...iss174L])}`
      }
      if (!iss169L.has('planning') || iss169L.has('in-progress') || iss169L.has('in-review')) {
        return `未闭环总控 PRD #169 未保留 planning 或未清过程标签：${JSON.stringify([...iss169L])}`
      }
      // 验证 #827(c): 关闭子单 #174 的 <!-- pf:plan-summary --> 已刷新为归档路径与 1/1 已完成
      const final174Body = issues.get(174)?.body ?? ''
      if (!final174Body.includes('1/1 已完成') || !final174Body.includes('docs/archive/specs/') || final174Body.includes('0/1 已完成')) {
        return `关闭工单 #174 规划摘要未刷新为终态归档：\n${final174Body}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])
}
