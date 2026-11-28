/**
 * fixtures-conv-s1.mjs —— Slice 1 (`core-state-integrity`) C1..C4 正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { approveSpec, clarifyDoc, initDoc } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { auditDoc } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { evaluateRound2CritiqueScope } from '../../kit/skills/lib/critique-diff.mjs'
import {
  critiqueContinueDoc, critiquePassDoc, critiqueRejectDoc, critiqueTextFingerprint, readPlanCritiqueEntrySync,
} from '../../kit/skills/lib/critique-rounds.mjs'
import { persistPlanCritiqueEntry } from '../../kit/skills/lib/critique-store.mjs'
import { evaluatePlanNextState } from '../../kit/skills/lib/plan-next.mjs'
import { checkFrozenCriteria } from '../../kit/skills/lib/criteria-lock.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { assertWellFormedMarkdownBody, hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { buildReviewComments } from '../../kit/skills/lib/review-comment-render.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import { handleAbort } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { checkFeatureMapSyncOnFinalize } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { evaluateMasterIssueCloseGuard, handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge-claim.mjs'
import { handleSync } from '../../kit/skills/dev-flow/scripts/flow-sync.mjs'
import { extractPlanDocContext } from '../../kit/skills/lib/issue-quality.mjs'
import { syncPlanPhaseToBackend } from '../../kit/skills/lib/plan-sync.mjs'
import { resolveReviewTargetSha } from '../../kit/skills/dev-review/scripts/review-diff.mjs'
import { evaluateIncludeDiffGate } from '../../kit/skills/dev-review/scripts/review-empirical.mjs'
import { parseAcceptanceCriteria } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { syncReviewToGitHub } from '../../kit/skills/dev-review/scripts/review-sync.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

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

export function registerConvS1Cases(cases) {
  cases.push(['Conv-S1 C1：clarify 清空待拍板、commondir 边车合并、critique-continue 撤销已批准并保持激活至下轮复核', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# ConvS1\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/app.mjs': 'export const app = () => 1\n',
      'docs/TDD.md': '# TDD\n\n- `src/app.mjs`\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test' })
    try {
      const roots = await resolveRepoRoots(dir)
      const initRes = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        kind: 'spec', slug: 's1-clarify', title: 'S1 Clarify', taskId: 's1-c1',
        owner: 'planner', worktree: true,
      })
      const wt = join(dir, initRes.worktreePath)
      const specRel = initRes.file
      const baseSpec = readFileSync(join(wt, specRel), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '`src/app.mjs`')
        .replace(/^- \[ \] C1:.*$/m, '- [ ] C1: `src/app.mjs` 行为正常，测试 `exit 0`')
        .replace(/^- \*\*待拍板事项\*\*\s*[:：].*$/m, '')
      const specWithPending = `${baseSpec.trimEnd()}\n\n## 待拍板问题\n\n- 待确认：采用策略 A 还是 B（待拍板）\n\n## 实现说明\n\n- 预留\n`
      writeFileSync(join(wt, specRel), specWithPending, 'utf8')

      // 1. 待拍板存在时 audit/approve 拦截 BLOCKED_PENDING_DECISIONS；clarifyDoc 后立即清空
      const preClarifyAudit = auditDoc({ repoRoot: wt, file: specRel })
      if (!preClarifyAudit.errors.some((e) => e.code === 'BLOCKED_PENDING_DECISIONS')) {
        return `clarify 前未检测出 BLOCKED_PENDING_DECISIONS：${JSON.stringify(preClarifyAudit.errors)}`
      }
      clarifyDoc({ repoRoot: wt, file: specRel, question: '采用策略 A 还是 B', decision: '确定采用策略 A', by: 'user', explicitBy: 'user' })
      const postClarifyAudit = auditDoc({ repoRoot: wt, file: specRel })
      if (postClarifyAudit.errors.some((e) => e.code === 'BLOCKED_PENDING_DECISIONS')) {
        return `clarify 后仍残留 BLOCKED_PENDING_DECISIONS：${JSON.stringify(postClarifyAudit.errors)}`
      }

      // 2. commondir sidecar 合并与任务账本共存回退
      await persistPlanCritiqueEntry({
        repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, taskId: null, fmData: {}, relDoc: specRel,
        entry: { rounds: [{ round: 1, verdict: 'rejected', reviewerId: 'crit-sidecar', sha: '0'.repeat(40), stopLossTriggered: false }] },
      })
      writeTaskLedger(dir, { taskId: 's1-c1', slug: 's1-clarify', branch: 'feat/s1-c1', baseBranch: 'main', planCritique: {} })
      const mergedSidecar = readPlanCritiqueEntrySync({ repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, taskId: 's1-c1', relDoc: specRel })
      if (!mergedSidecar.entry?.rounds?.some((r) => r.reviewerId === 'crit-sidecar')) {
        return `task ledger 存在时未能合并 sidecar 历史：${JSON.stringify(mergedSidecar)}`
      }

      // 3. pass -> approve -> critiqueContinueDoc 必须撤销 approved: false 并退回 draft
      const pass1 = await critiquePassDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reviewer: 'crit-a', round: 2, summary: 'pass r2', taskId: 's1-c1' })
      if (!pass1.ok) return `critiquePassDoc r2 失败：${JSON.stringify(pass1)}`
      const app1 = approveSpec({ repoRoot: wt, mainRoot: dir, file: specRel, taskId: 's1-c1' })
      if (app1.status !== 'approved') return `approveSpec 失败：${JSON.stringify(app1)}`
      const contRes = await critiqueContinueDoc({
        repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, file: specRel,
        reason: '补充边界条件后再复审', taskId: 's1-c1',
      })
      if (!contRes.ok) return `critiqueContinueDoc 失败：${JSON.stringify(contRes)}`
      const afterContText = readFileSync(join(wt, specRel), 'utf8')
      if (/^approved:\s*true$/m.test(afterContText) || !/^status:\s*draft$/m.test(afterContText)) {
        return `critique-continue 未撤销 approved 状态：\n${afterContText.slice(0, 400)}`
      }

      // 4. 编辑期间 evaluatePlanNextState 保持 continueActive 且阶段由 needs-revision 转为 needs-critique；R2 scope 接纳 continued.reason
      const nextBeforeEdit = await evaluatePlanNextState({ repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, isGit: true, file: specRel, taskId: 's1-c1', auditDocFn: auditDoc })
      if (!nextBeforeEdit.critique.continueActive || nextBeforeEdit.phase !== 'needs-revision') {
        return `编辑前 evaluatePlanNextState 状态异常：${JSON.stringify(nextBeforeEdit)}`
      }
      writeFileSync(join(wt, specRel), afterContText.replace('`src/app.mjs` 行为正常，测试 `exit 0`', '`src/app.mjs` 行为正常（补充边界说明），测试 `exit 0`'), 'utf8')
      const nextAfterEdit = await evaluatePlanNextState({ repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, isGit: true, file: specRel, taskId: 's1-c1', auditDocFn: auditDoc })
      if (!nextAfterEdit.critique.continueActive || nextAfterEdit.phase !== 'needs-critique') {
        return `编辑后 evaluatePlanNextState 未保持 continueActive=true 且转 needs-critique：${JSON.stringify(nextAfterEdit)}`
      }
      const r2Scope = evaluateRound2CritiqueScope({
        prevLines: afterContText.split('\n'),
        currLines: readFileSync(join(wt, specRel), 'utf8').split('\n'),
        round: 3,
        findings: [],
        continuedReason: '补充边界说明',
      })
      if (r2Scope.blocked) return `R2 scope 未将 continued.reason 纳入合法区间：${JSON.stringify(r2Scope)}`

      // 5. 3 轮停损 + critique-continue + 新 critique-pass 清除 active 并恢复 approve
      for (const rnd of [3, 4, 5]) {
        const cur = readFileSync(join(wt, specRel), 'utf8')
        writeFileSync(join(wt, specRel), cur.replace('`exit 0`', `\`exit 0\` \`iterRule${rnd}\``), 'utf8')
        await critiqueRejectDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reviewer: `crit-sl-${rnd}`, round: rnd, findings: [`[B1] \`iterRule${rnd}\` 仍缺边界`], taskId: 's1-c1' })
      }
      await critiqueContinueDoc({ repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, file: specRel, reason: '重建边界说明', taskId: 's1-c1' })
      const curSl = readFileSync(join(wt, specRel), 'utf8')
      writeFileSync(join(wt, specRel), curSl.replace('`iterRule5`', '`iterRule5` 重建边界说明完成'), 'utf8')
      await critiquePassDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reviewer: 'crit-sl-6', round: 6, summary: 'pass after continue', taskId: 's1-c1' })
      const entryFinal = readPlanCritiqueEntrySync({ repoRoot: wt, mainRoot: dir, gitDir: roots.gitDir, taskId: 's1-c1', relDoc: specRel })
      if (entryFinal.entry?.continued?.active !== false) {
        return `critique-pass 后 continued.active 未重置为 false：${JSON.stringify(entryFinal.entry?.continued)}`
      }
      const appFinal = approveSpec({ repoRoot: wt, mainRoot: dir, file: specRel, taskId: 's1-c1' })
      if (appFinal.status !== 'approved') return `critique-continue 后经新 pass 仍未解锁 approve：${JSON.stringify(appFinal)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Conv-S1 C2a：flow sync 清冲突状态、merge --reviewer-id 自合拦截、abort 清理与 in-place/repo-map 原子落账', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# FlowC2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/app.mjs': 'export const x = 1\n',
    })
    const bare = tmpProject({})
    gitInit(bare, { bare: true })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test', origin: bare.replace(/\\/g, '/') })
    gitSync(dir, ['push', '-u', 'origin', 'main'])
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. Case 1 in-place 幂等复用 + repo-map --task 原子更新
      const c1A = await withQuietIo(() => handleStart({ task: 'c1-in', case: '1', slug: 'c1-in', agent: 'impl-a', json: true }, roots))
      const c1B = await withQuietIo(() => handleStart({ task: 'c1-in', case: '1', slug: 'c1-in', agent: 'impl-a', json: true }, roots))
      if (c1A.res.exitCode !== 0 || c1B.res.exitCode !== 0 || readTaskLedger(dir, 'c1-in')?.isolation !== 'in-place') {
        return `Case 1 in-place 幂等复用失败：a=${c1A.res.exitCode} b=${c1B.res.exitCode}`
      }
      const rmRes = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', ['--task', 'c1-in', '--by', 'exp-1', '--json'], { cwd: dir })
      if (rmRes.status !== 0 || readTaskLedger(dir, 'c1-in')?.explored?.by !== 'exp-1') {
        return `repo-map --task 未原子写入 explored：status=${rmRes.status} err=${rmRes.stderr}`
      }
      await withQuietIo(() => handleVerify({ task: 'c1-in', mode: 'full', cmd: 'exit 0', json: true }, roots))
      const locSub = await withQuietIo(() => handleSubmit({ task: 'c1-in', agent: 'impl-a', json: true }, roots))
      if (locSub.res.exitCode !== 0 || !readTaskLedger(dir, 'c1-in')?.lastSubmittedHead) {
        return `local-only/generic-git submit 未写入 lastSubmittedHead：${locSub.stderr} ${locSub.stdout}`
      }

      // 2. flow sync 清空 queueConflict / rework 并刷新 finalizedHead
      await withQuietIo(() => handleStart({
        task: 't-sync', case: '2', slug: 't-sync', agent: 'impl-a', 'no-issue': true, reason: '测试 sync', json: true,
      }, roots))
      const wtSync = join(dir, '.worktrees/impl-t-sync')
      writeFileSync(join(wtSync, 'src/app.mjs'), 'export const x = 2\n', 'utf8')
      gitCommitFast(wtSync, 'feat: sync branch', { updateOnly: true })
      writeFileSync(join(dir, 'README-main.md'), '# main advance\n', 'utf8')
      gitCommitFast(dir, 'docs: advance main')
      gitSync(dir, ['push', 'origin', 'main'])

      const lSync = readTaskLedger(dir, 't-sync')
      lSync.queueConflict = true
      lSync.queueConflictReason = 'merge-queue-conflict'
      lSync.status = 'rework'
      lSync.finalized = true
      lSync.finalizedHead = 'stale-sha'
      writeTaskLedger(dir, lSync)

      const syncOut = await withQuietIo(() => handleSync({ task: 't-sync', onto: 'main', json: true }, roots))
      const lAfterSync = readTaskLedger(dir, 't-sync')
      if (syncOut.res.exitCode !== 0 || lAfterSync.queueConflict !== false || lAfterSync.status === 'rework' || lAfterSync.finalizedHead === 'stale-sha') {
        return `flow sync 未清除 queueConflict/rework 或未刷新 finalizedHead：${JSON.stringify(lAfterSync)}`
      }

      // 3. flow merge --reviewer-id 阻断 BLOCKED_SELF_MERGE
      await withQuietIo(() => handleClaim({ task: 't-sync', agent: 'impl-a', json: true }, roots))
      const vSync = await withQuietIo(() => handleVerify({ task: 't-sync', mode: 'full', cmd: 'exit 0', 'e2e-evidence': 'run: exit 0 => exit 0', json: true }, roots))
      if (vSync.res.exitCode !== 0) return `t-sync verify 失败：exit=${vSync.res.exitCode} err=${vSync.stderr} out=${vSync.stdout}`
      const selfMerge = await withQuietIo(() => handleMerge({ task: 't-sync', 'reviewer-id': 'impl-a', json: true }, roots))
      if (selfMerge.res.exitCode === 0 || !`${selfMerge.stdout}${selfMerge.stderr}`.includes('BLOCKED_SELF_MERGE')) {
        return `flow merge --reviewer-id 未拦截自合：exit=${selfMerge.res.exitCode} out=${selfMerge.stdout} err=${selfMerge.stderr}`
      }

      // 4. flow abort 校验 branch -d 退出码（未合并分支无 --force 拦截，带 --force 清理 private-docs / evidence.json / review-empirical.json）
      const privDir = join(dir, '.worktrees', '.state', 'private-docs', 't-sync')
      const stateTaskDir = join(roots.gitDir, 'project-forge-flow', 'tasks', 't-sync')
      mkdirSync(privDir, { recursive: true })
      mkdirSync(stateTaskDir, { recursive: true })
      writeFileSync(join(privDir, 'draft.md'), '# priv\n', 'utf8')
      writeFileSync(join(stateTaskDir, 'evidence.json'), '{"headSha":"abc"}\n', 'utf8')
      writeFileSync(join(stateTaskDir, 'review-empirical.json'), '{"version":1}\n', 'utf8')

      const abUnmerged = await withQuietIo(() => handleAbort({ task: 't-sync', confirm: true, json: true }, roots))
      if (abUnmerged.res.exitCode === 0 || !`${abUnmerged.stdout}${abUnmerged.stderr}`.includes('BLOCKED_BRANCH_DELETE_FAILED')) {
        return `abort 未合并分支无 --force 未拦截：exit=${abUnmerged.res.exitCode} err=${abUnmerged.stderr}`
      }
      const abForced = await withQuietIo(() => handleAbort({ task: 't-sync', confirm: true, force: true, json: true }, roots))
      if (abForced.res.exitCode !== 0 || existsSync(privDir) || existsSync(join(stateTaskDir, 'evidence.json')) || existsSync(join(stateTaskDir, 'review-empirical.json'))) {
        return `abort --force 未完整清理产物：exit=${abForced.res.exitCode}`
      }
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['Conv-S1 C2b：planBootstrap 一等流与不关单、Markdown 折叠阻断、claim --agent 与 feature-map 双向默认阻断/Case 2 守卫', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# BootC2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'docs/TDD.md': '# TDD\n\n- `src/core.mjs`\n',
      'docs/feature-map.json': JSON.stringify({
        schemaVersion: 1,
        features: [
          { id: 'core', entryFiles: ['src/core.mjs'], testRefs: [] },
          { id: 'legacy', entryFiles: ['src/legacy.mjs'], testRefs: [] },
        ],
      }, null, 2),
      'src/core.mjs': 'export const c = 1\n',
      'src/legacy.mjs': 'export const old = 1\n',
      'docs/prd/261124-master-prd.md': [
        '---', 'kind: prd', 'title: "Master PRD"', 'status: active', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 169', 'pr: null', 'branch: null',
        'owner: planner', 'plan_mode: autonomous', 'approved: true', 'multi_spec: true',
        '---', '', '# Master PRD', '', '- [ ] C1: 切片 1', '- [ ] C2: 切片 2', '',
      ].join('\n'),
      'docs/specs/261124-s1-spec.md': [
        '---', 'kind: spec', 'title: "Slice 1"', 'status: draft', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 169', 'pr: null', 'branch: null',
        'owner: planner', 'plan_mode: autonomous', 'approved: false', 'implemented: false',
        'related_prd: ../prd/261124-master-prd.md', 'task_id: boot-p', 'scope_files: []',
        '---', '', '# SPEC: Slice 1', '', '## 验收标准', '', '- [ ] C1: 实现核心能力', '',
      ].join('\n'),
    })
    const bare = tmpProject({})
    gitInit(bare, { bare: true })
    const mockIssues = new Map([[169, { title: 'Master Epic', body: 'Initial placeholder body', state: 'OPEN' }]])
    const mockComments = []
    const mockPrs = []
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@boot.test', origin: 'https://github.com/acme/boot-demo.git' })
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.replace(/\\/g, '/')])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
    const ghCli = {
      tier: 'gh-cli', login: 'alice',
      getIssue: async (_repo, num) => ({ ok: true, number: num, title: 'Master Epic', body: mockIssues.get(num)?.body ?? '', state: 'OPEN' }),
      updateIssueBody: async ({ number, body }) => { mockIssues.set(number, { ...mockIssues.get(number), body }); return { ok: true, number, body } },
      listComments: async () => ({ ok: true, comments: [] }),
      postComment: async ({ number, body }) => { mockComments.push({ number, body }); return { ok: true, id: mockComments.length } },
      syncStateLabel: async () => ({ ok: true }),
      addLabels: async () => ({ ok: true }),
      createPr: async ({ title, body }) => { mockPrs.push({ number: 10, title, body }); return { ok: true, number: 10, url: 'https://github.com/acme/boot-demo/pull/10' } },
      findOpenPrForBranch: async () => ({ ok: true, prs: [] }),
    }
    const ghProbe = { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'alice' } }, client: ghCli }
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. assertWellFormedMarkdownBody 拦截单行/双行折叠多节，放行正常多行
      let malCode = null
      try { assertWellFormedMarkdownBody('## 变更摘要 - foo ## 关联 Issue Fixes #169', '测试') } catch (e) { malCode = e.code }
      if (malCode !== 'BLOCKED_MALFORMED_MARKDOWN_BODY') return `单行折叠 Markdown 未阻断：${malCode}`
      assertWellFormedMarkdownBody('## 变更摘要\n\n- 正常换行\n\n## 关联 Issue\n\nPart of #169\n', '测试')

      // 2. planBootstrap 启动 -> claim --agent 双层归属 -> finalize 不归档 -> PR 正文含 Part of #169 且不关单
      const st = await withQuietIo(() => handleStart({
        task: 'boot-p', case: '4', slug: 'boot-p', issue: '169',
        prd: 'docs/prd/261124-master-prd.md', spec: 'docs/specs/261124-s1-spec.md',
        'allow-plan-bootstrap': true, _ghClient: ghCli, _ghProbe: ghProbe, json: true,
      }, roots))
      if (st.res.exitCode !== 0 || readTaskLedger(dir, 'boot-p')?.planBootstrap !== true) {
        return `planBootstrap 未写入 ledger：exit=${st.res.exitCode} err=${st.stderr}`
      }
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['explore', '--task', 'boot-p', '--json'], { cwd: dir })
      await withQuietIo(() => handleClaim({ task: 'boot-p', agent: 'impl-conv', _ghClient: ghCli, _ghProbe: ghProbe, json: true }, roots))
      const claimMsg = mockComments.at(-1)?.body ?? ''
      if (!claimMsg.includes('@alice') || !claimMsg.includes('impl-conv')) {
        return `claim --agent 未输出双层归属 @alice (impl-conv)：${claimMsg}`
      }

      const finBoot = await withQuietIo(() => handleFinalize({ task: 'boot-p', json: true }, roots))
      const lAfterFinBoot = readTaskLedger(dir, 'boot-p')
      if (finBoot.res.exitCode !== 0 || String(lAfterFinBoot?.specFile ?? '').startsWith('docs/archive/') || !existsSync(join(dir, '.worktrees/impl-boot-p', lAfterFinBoot.specFile))) {
        return `planBootstrap finalize 失败或误归档活跃文档：exit=${finBoot.res.exitCode} spec=${lAfterFinBoot?.specFile} err=${finBoot.stderr}`
      }
      const prBody = hydratePrTemplateBody({
        repoRoot: join(dir, '.worktrees/impl-boot-p'), taskId: 'boot-p',
        ledger: lAfterFinBoot, currentHead: 'abc1234', changedFiles: [lAfterFinBoot.specFile],
      })
      if (!prBody.includes('Part of #169') || prBody.includes('Fixes #169')) {
        return `planBootstrap PR 正文应输出 Part of #169 而非 Fixes #169：\n${prBody}`
      }
      const closeGuard = evaluateMasterIssueCloseGuard({ mainRoot: dir, implRoot: join(dir, '.worktrees/impl-boot-p'), issueNumber: 169, ledger: lAfterFinBoot, taskId: 'boot-p' })
      if (closeGuard.shouldClose !== false) {
        return `planBootstrap 合并守卫竟允许关闭 Master Issue：${JSON.stringify(closeGuard)}`
      }
      gitCommitFast(join(dir, '.worktrees/impl-boot-p'), 'docs: bootstrap plan')
      await withQuietIo(() => handleVerify({ task: 'boot-p', mode: 'gate', cmd: 'exit 0', json: true }, roots))
      const subBoot = await withQuietIo(() => handleSubmit({ task: 'boot-p', agent: 'impl-conv', _ghClient: ghCli, _ghProbe: ghProbe, json: true }, roots))
      if (subBoot.res.exitCode !== 0 || !String(mockIssues.get(169)?.body ?? '').includes(lAfterFinBoot.specFile)) {
        return `planBootstrap submit 未将产出文档列表写回 Master Issue：exit=${subBoot.res.exitCode} err=${subBoot.stderr} body=${mockIssues.get(169)?.body}`
      }

      // 3. feature-map 双向同步（先测 Case 2 原地修复/新增核心模块守卫，再测删除 src/legacy.mjs 残留阻断）
      await withQuietIo(() => handleStart({
        task: 'c2-drift', case: '2', slug: 'c2-drift', agent: 'impl-c2', 'no-issue': true, reason: 'Case2 漂移测试', json: true,
      }, roots))
      await withQuietIo(() => handleClaim({ task: 'c2-drift', agent: 'impl-c2', json: true }, roots))
      const wtC2 = join(dir, '.worktrees/impl-c2-drift')
      writeFileSync(join(wtC2, 'src/core.mjs'), 'export const c = 2\n', 'utf8')
      gitCommitFast(wtC2, 'fix: modify existing core only', { updateOnly: true })
      const vCleanC2 = await withQuietIo(() => handleVerify({ task: 'c2-drift', cmd: 'exit 0', json: true }, roots))
      if (vCleanC2.res.exitCode !== 0) return `Case 2 原地修复不应被结构漂移误拦：${vCleanC2.stderr}`

      writeFileSync(join(wtC2, 'src/unmapped.mjs'), 'export const u = 1\n', 'utf8')
      gitCommitFast(wtC2, 'feat: sneak new core module in Case 2')
      const vDriftC2 = await withQuietIo(() => handleVerify({ task: 'c2-drift', cmd: 'exit 0', json: true }, roots))
      if (vDriftC2.res.exitCode === 0 || !`${vDriftC2.stdout}${vDriftC2.stderr}`.includes('BLOCKED_FEATURE_MAP_SYNC')) {
        return `Case 2 新增未登记核心模块未触发结构漂移守卫：exit=${vDriftC2.res.exitCode} err=${vDriftC2.stderr}`
      }
      rmSync(join(dir, 'src/legacy.mjs'))
      const delEntryRes = await checkFeatureMapSyncOnFinalize({
        implRoot: dir, mainRoot: dir, opts: {},
        changedEntries: [{ status: 'D', file: 'src/legacy.mjs' }],
      })
      if (delEntryRes.ok || delEntryRes.code !== 'BLOCKED_FEATURE_MAP_SYNC' || !delEntryRes.staleEntries?.includes('src/legacy.mjs')) {
        return `删除核心模块未检测出 feature-map 失效残留：${JSON.stringify(delEntryRes)}`
      }
      const modOnlyRes = await checkFeatureMapSyncOnFinalize({
        implRoot: dir, mainRoot: dir, opts: {},
        changedEntries: [{ status: 'M', file: 'src/core.mjs' }],
      })
      if (!modOnlyRes.ok) return `常规内部 M 修改误触发 feature-map 阻断：${JSON.stringify(modOnlyRes)}`
      return true
    } finally { rmTree(dir); rmTree(bare) }
  }])

  cases.push(['Conv-S1 C3 & C4：review 槽位钉住、fault 门禁、--summary 渲染、criteria-lock 归档/回填/阻断与 handoff Case 2 动态定位', async () => {
    const revSpecTemplate = [
      '---', 'kind: spec', 'title: "Approved PreStart"', 'status: approved', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: null', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true', 'implemented: false',
      'plan_critique: passed (reviewer=crit-1, round=1, sha=12345678)',
      'scope_files: [src/app.mjs]',
      '---', '', '# SPEC: Approved PreStart', '', '## 要解决的问题', '- 稳定验证', '',
      '## 本期不做', '- 不改 UI', '', '## 二、设计方案与契约详情', '',
      ...Array.from({ length: 28 }, (_, i) => `- 设计条款 ${i + 1}：约束 \`src/app.mjs\` 细节`),
      '', '## 门型与回滚路径', '- two-way', '', '## 验收标准', '',
      '- [x] C1: `src/app.mjs` 返回 1', '', '## 实现说明', '', '- 已就绪', '',
    ].join('\n')
    const revSpecSha = critiqueTextFingerprint(revSpecTemplate)
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# RevC34\n\n```yaml\nquick-test: node test.mjs\nfull-test: node test.mjs\nsmoke-verify: node smoke.mjs\nmerge-gate: node test.mjs\narch-rules: none\nhigh-risk: src/\ndo-not-edit: docs/archive/\n```\n',
      'src/app.mjs': 'export const val = () => 1\n',
      'test.mjs': "import assert from 'node:assert/strict'\nimport { val } from './src/app.mjs'\nassert.equal(val(), 1)\n",
      'smoke.mjs': "console.log('smoke ok')\n",
      'docs/TDD.md': '# TDD\n\n- `src/app.mjs`\n',
      'docs/feature-map.json': JSON.stringify({ schemaVersion: 1, features: [{ id: 'app', entryFiles: ['src/app.mjs'], testRefs: ['test.mjs'] }] }, null, 2),
      'docs/specs/261124-s1-rev-spec.md': revSpecTemplate.replace('sha=12345678', `sha=${revSpecSha}`),
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@rev.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. pre-approved SPEC 启动时自动回填 criteriaFingerprint；buildHandoff 动态 --section 与 smoke-verify
      const st = await withQuietIo(() => handleStart({
        task: 't-rev', case: '4', slug: 's1-rev', spec: 'docs/specs/261124-s1-rev-spec.md',
        agent: 'impl-a', 'no-issue': true, reason: 'C3/C4 验证', json: true,
      }, roots))
      if (st.res.exitCode !== 0) return `start 失败：${st.stderr} ${st.stdout}`
      const lInit = readTaskLedger(dir, 't-rev')
      if (!lInit.criteriaFingerprint || lInit.criteriaFrozenFrom !== 'docs/specs/261124-s1-rev-spec.md') {
        return `start 未回填 pre-approved SPEC criteriaFingerprint：${JSON.stringify(lInit)}`
      }
      const hp = buildHandoff({
        mainRoot: dir, role: 'implementer',
        ledger: {
          ...lInit,
          issueContext: [{ number: 88, fetched: true, title: 'Case2 Bug', state: 'OPEN', summary: '- [ ] C1: Issue 标准条款' }],
          prContext: { fetched: true, number: 99, state: 'OPEN', title: 'Draft PR', summary: 'PR 上下文摘要' },
        },
      })
      if (!hp.prompt.includes('--section "二、设计方案与契约详情"') || !hp.prompt.includes('smoke.mjs') || !hp.prompt.includes('Issue #88') || !hp.prompt.includes('PR #99')) {
        return `buildHandoff 缺少动态 --section / smoke-verify / issueContext：\n${hp.prompt}`
      }
      const hpCase2 = buildHandoff({
        mainRoot: dir, role: 'implementer',
        ledger: {
          taskId: 'c2-hp', caseType: 2, branch: 'fix/c2', baseBranch: 'main',
          issueContext: [{ number: 77, fetched: true, title: 'Fix', state: 'OPEN', summary: '- [ ] C1: 修复边界\n- [ ] C2: 补单测' }],
        },
      })
      if (hpCase2.fields.criteriaCount !== 2 || hpCase2.fields.sourceDoc !== 'issue#77') {
        return `buildHandoff Case 2 未从 issueContext 抽取出 C1..Cn：${JSON.stringify(hpCase2.fields)}`
      }

      // 2. finalize 归档 SPEC 时同步更新 criteriaFrozenFrom 至 docs/archive/specs/
      const wtImpl = join(dir, '.worktrees/impl-t-rev')
      writeFileSync(join(wtImpl, 'src/app.mjs'), 'export const val = () => 2\n', 'utf8')
      writeFileSync(join(wtImpl, 'test.mjs'), "import assert from 'node:assert/strict'\nimport { val } from './src/app.mjs'\nassert.equal(val(), 2)\n", 'utf8')
      gitCommitFast(wtImpl, 'feat: val 2', { updateOnly: true })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['explore', '--task', 't-rev', '--json'], { cwd: dir })
      const fin = await withQuietIo(() => handleFinalize({ task: 't-rev', json: true }, roots))
      if (fin.res.exitCode !== 0 || !String(readTaskLedger(dir, 't-rev').criteriaFrozenFrom).startsWith('docs/archive/specs/')) {
        return `finalize 未同步更新 criteriaFrozenFrom 到归档路径：${JSON.stringify(readTaskLedger(dir, 't-rev'))}`
      }
      gitCommitFast(wtImpl, 'docs: archive spec')
      const archiveCommitSha = gitSync(wtImpl, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      await withQuietIo(() => handleVerify({ task: 't-rev', mode: 'gate', cmd: 'node test.mjs', 'e2e-evidence': 'run: node test.mjs => exit 0', json: true }, roots))
      await withQuietIo(() => handleSubmit({ task: 't-rev', agent: 'impl-a', json: true }, roots))

      // 3. review-<id> 槽位钉住：提交 impl 新改动后，--include-diff 与 resolveReviewTargetSha 仍钉住 review-<id> 旧 HEAD
      const lSub = readTaskLedger(dir, 't-rev')
      const pinnedRevHead = lSub.reviewWorktreeHead
      writeFileSync(join(wtImpl, 'src/app.mjs'), 'export const val = () => 999\n', 'utf8')
      gitCommitFast(wtImpl, 'feat: impl-ahead commit', { updateOnly: true })
      const resolvedPin = await resolveReviewTargetSha(dir, dir, lSub, 'HEAD', { preferReviewSlot: true })
      if (resolvedPin !== pinnedRevHead) {
        return `preferReviewSlot 未钉住 reviewWorktreeHead：got=${resolvedPin} want=${pinnedRevHead}`
      }

      // 4. evaluateIncludeDiffGate 在 faultRequired 时要求 check-fault:fail 与 check-fault:restore
      const gateNoFault = evaluateIncludeDiffGate({
        gitDir: roots.gitDir, mode: 'task', task: lSub, round: 1, baseRef: lSub.baseSha,
        reviewRoot: join(dir, lSub.reviewWorktreePath), mainRoot: dir, headSha: pinnedRevHead,
        diffScope: 'x', workspaceFingerprint: 'fp1',
        requirements: { isEmptyDiff: false, isLowRiskPureDoc: false, empiricalRequired: true, faultRequired: true, visualCheckRequired: false, e2eObservationRequired: false, autoCommands: [] },
        behavioralGate: {},
      })
      if (gateNoFault.readyForDiff || !gateNoFault.missingSteps.includes('check-fault:fail') || !gateNoFault.missingSteps.includes('check-fault:restore')) {
        return `evaluateIncludeDiffGate 未列出缺失 check-fault 步骤：${JSON.stringify(gateNoFault.missingSteps)}`
      }

      // 5. buildReviewComments / syncReviewToGitHub 透传 --summary 且 parseAcceptanceCriteria 统一优先序
      const renderedRev = buildReviewComments({
        round: 1, verdict: 'pass', headSha: pinnedRevHead, sourceLine: 'review wt',
        reviewerDisplay: '`rev-1`', implementerDisplay: '`impl-a`', summary: '全部标准通过实证核验',
        criteriaStatusText: 'fail: 无 / pass: C1', faultInjectionText: 'ok',
        criteria: parseAcceptanceCriteria(wtImpl, dir, readTaskLedger(dir, 't-rev')),
      })
      if (!renderedRev.prCommentBody.includes('- **审查结论**：全部标准通过实证核验') || !renderedRev.prCommentBody.includes('#### 验收标准逐条核对')) {
        return `review 评论缺失 --summary 或逐条核对表：\n${renderedRev.prCommentBody}`
      }

      // 6. 篡改归档后 SPEC 验收标准 -> submit 与 review record 均阻断 BLOCKED_CRITERIA_DRIFT
      const lNow = readTaskLedger(dir, 't-rev')
      gitSync(wtImpl, ['reset', '--hard', archiveCommitSha])
      const archSpecAbs = join(wtImpl, lNow.criteriaFrozenFrom)
      writeFileSync(archSpecAbs, readFileSync(archSpecAbs, 'utf8').replace('- [x] C1: `src/app.mjs` 返回 1', '- [x] C1: `src/app.mjs` 放宽为任意值'), 'utf8')
      gitCommitFast(wtImpl, 'chore: tamper criteria', { updateOnly: true })
      await withQuietIo(() => handleVerify({ task: 't-rev', mode: 'gate', cmd: 'node test.mjs', 'e2e-evidence': 'run: node test.mjs => exit 0', json: true }, roots))
      const subDrift = await withQuietIo(() => handleSubmit({ task: 't-rev', agent: 'impl-a', json: true }, roots))
      if (subDrift.res.exitCode === 0 || !`${subDrift.stdout}${subDrift.stderr}`.includes('BLOCKED_CRITERIA_DRIFT')) {
        return `submit 未拦截篡改后验收标准：exit=${subDrift.res.exitCode} err=${subDrift.stderr}`
      }
      const revWtAbs = join(dir, lNow.reviewWorktreePath)
      const revSpecAbs = join(revWtAbs, lNow.criteriaFrozenFrom)
      writeFileSync(revSpecAbs, readFileSync(archSpecAbs, 'utf8'), 'utf8')
      const recDrift = await withQuietIo(() => handleRecord({
        task: 't-rev', round: '1', verdict: 'pass', 'reviewer-id': 'rev-1', 'review-token': 'tok',
        evidence: 'run: node test.mjs => exit 0', json: true,
      }, roots))
      if (recDrift.res === 0 || !`${recDrift.stdout}${recDrift.stderr}`.includes('BLOCKED_CRITERIA_DRIFT')) {
        return `review-pack record 未拦截篡改后验收标准：exit=${recDrift.res} err=${recDrift.stderr}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Conv-S1 #826：extractPlanDocContext C<N> 去重、plan-sync 总控 PRD 隔离与 doc-renumber 同步回 Issue 正文', async () => {
    const masterPrd = [
      '---', 'kind: prd', 'title: "Master"', 'status: active', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 169', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true', 'multi_spec: true',
      'plan_critique: passed (reviewer=crit-master, round=1, sha=11111111)',
      '---', '', '# Master PRD', '',
      ...Array.from({ length: 12 }, (_, i) => `- [ ] C${i + 1}: 总控条款 ${i + 1}`), '',
    ].join('\n')
    const specRaw = [
      '---', 'kind: spec', 'title: "Slice Spec"', 'status: approved', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: null', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true', 'implemented: false',
      'plan_critique: passed (reviewer=crit-slice, round=2, sha=11111111)',
      'related_prd: ../prd/261124-master-prd.md', 'scope_files: [src/core.mjs]',
      '---', '', '# SPEC: Slice', '', '## 要解决的问题', '- 修复核心状态一致性', '',
      '## 本期不做', '- 不引入多主题状态', '',
      '## 门型与回滚路径', '- two-way，按 git revert 回滚', '',
      '## 验收标准', '',
      '- [ ] C1: SPEC 详细标准 1', '- [ ] C2: SPEC 详细标准 2', '- [ ] C3: SPEC 详细标准 3', '- [ ] C4: SPEC 详细标准 4', '',
    ].join('\n')
    const todoRaw = [
      '---', 'kind: todo', 'title: "Slice Todo"', 'status: active', 'tier: L3',
      'created: 2026-11-24', 'updated: 2026-11-24', 'issue: null', 'pr: null', 'branch: null',
      'owner: planner', 'plan_mode: autonomous', 'approved: true',
      'related_prd: ../prd/261124-master-prd.md', 'related_spec: ../specs/261124-slice-spec.md',
      '---', '', '# Todo: Slice', '', '## 本期不做', '- 不引入多主题状态（Todo 重复）', '',
      '## 验收标准', '',
      '- [ ] C1: Todo 缩略 1', '- [ ] C2: Todo 缩略 2', '- [ ] C5: Todo 新增标准 5', '',
    ].join('\n')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': '{"name":"demo-826","version":"1.0.0","repository":"https://github.com/acme/demo-826.git"}\n',
      'AGENTS.md': '# Fix826\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/core.mjs': 'export const c = 1\n',
      'docs/prd/261124-master-prd.md': masterPrd.replace('sha=11111111', `sha=${critiqueTextFingerprint(masterPrd)}`),
      'docs/specs/261124-slice-spec.md': specRaw.replace('sha=11111111', `sha=${critiqueTextFingerprint(specRaw)}`),
      'docs/todo/261124-slice-todo.md': todoRaw,
    })
    const issueStore = new Map([[169, { number: 169, title: 'Master', body: '# Master\n', state: 'OPEN' }]])
    const comments = []
    let nextIssueNo = 174
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@826.test', origin: 'https://github.com/acme/demo-826.git' })
    const ghCli = {
      tier: 'gh-cli', login: 'alice',
      createIssue: async ({ title, body }) => {
        const number = nextIssueNo++
        issueStore.set(number, { number, title, body, state: 'OPEN' })
        return { ok: true, number, title, url: `https://github.com/acme/demo-826/issues/${number}` }
      },
      getIssue: async (_repo, num) => {
        const found = issueStore.get(Number(num))
        return found ? { ok: true, ...found } : { ok: false, status: 404 }
      },
      updateIssueBody: async ({ number, body }) => {
        const cur = issueStore.get(Number(number)) ?? { number: Number(number), title: 'T', state: 'OPEN' }
        issueStore.set(Number(number), { ...cur, body })
        return { ok: true, number: Number(number), body }
      },
      listComments: async () => ({ ok: true, comments: [] }),
      postComment: async ({ number, body }) => { comments.push({ number, body }); return { ok: true, id: comments.length } },
      syncStateLabel: async () => ({ ok: true }),
      addLabels: async () => ({ ok: true }),
      removeLabel: async () => ({ ok: true }),
    }
    const ghProbe = { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'alice' } }, client: ghCli }
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. extractPlanDocContext 按 C<N> 去重且保留新增 C5，outOfScope 只采纳 SPEC
      const ctx = extractPlanDocContext(dir, ['docs/specs/261124-slice-spec.md', 'docs/todo/261124-slice-todo.md'])
      if (ctx.criteria.length !== 5 || !ctx.criteria[0].includes('SPEC 详细标准 1') || !ctx.criteria[4].includes('Todo 新增标准 5')) {
        return `extractPlanDocContext C<N> 去重失败：${JSON.stringify(ctx.criteria)}`
      }
      if (ctx.outOfScope.includes('Todo 重复') || !ctx.outOfScope.includes('不引入多主题状态')) {
        return `extractPlanDocContext outOfScope 去重失败：${ctx.outOfScope}`
      }

      // 2. flow start --create-issue 触发 doc-renumber 后，同步更新 Issue #174 正文顶部关联设计与底部规划摘要
      const st = await withQuietIo(() => handleStart({
        task: 'slice-826', case: '4', slug: 'slice', agent: 'impl-a',
        spec: 'docs/specs/261124-slice-spec.md', todo: 'docs/todo/261124-slice-todo.md',
        'create-issue': true, _ghClient: ghCli, _ghProbe: ghProbe, json: true,
      }, roots))
      if (st.res.exitCode !== 0 || !issueStore.has(174)) {
        return `slice-826 start 失败或未命中 mock createIssue：exit=${st.res.exitCode} keys=${JSON.stringify([...issueStore.keys()])} err=${st.stderr} out=${st.stdout}`
      }
      const iss174Body = issueStore.get(174)?.body ?? ''
      if (iss174Body.includes('261124-slice-spec.md') || !iss174Body.includes('261124-issue174-slice-spec.md')) {
        return `doc-renumber 后 Issue #174 正文仍残留旧路径：\n${iss174Body}`
      }
      if (iss174Body.includes('0/12') || iss174Body.includes('crit-master') || !iss174Body.includes('0/5 已完成') || !iss174Body.includes('crit-slice')) {
        return `切片子单 #174 被总控 PRD 0/12 或 crit-master 污染：\n${iss174Body}`
      }

      // 3. 反向验证：同步总控工单 #169 时仍聚合总控 PRD 0/12 与 crit-master（且数字排序 C1..C12）
      const masterSync = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'plan-backfill',
        file: 'docs/prd/261124-master-prd.md', files: ['docs/prd/261124-master-prd.md'],
        issueNumbers: [169], _ghClient: ghCli, _ghProbe: ghProbe,
      })
      const iss169Body = issueStore.get(169)?.body ?? ''
      if (!masterSync.ok || !iss169Body.includes('0/12 已完成') || !iss169Body.includes('[ ] C2、[ ] C3') || !iss169Body.includes('C10、[ ] C11')) {
        return `总控工单 #169 未聚合 C1..C12 或排序异常：${iss169Body}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
