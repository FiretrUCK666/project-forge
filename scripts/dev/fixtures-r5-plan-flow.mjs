/**
 * fixtures-r5-plan-flow.mjs —— Round-5 Phase 4 PR 1 正反双向行为断言：
 *   1. `doc-plan next --handoff` 与 `flow next` 共享 `evaluatePlanNextState`（抗压缩 / 1:N / Plan-Only / 写手续聊 / 中断接管）
 *   2. `doc-plan init` 默认 `--worktree` 与 `--in-place`
 *   3. `pending-decisions` 变体与正文待拍板拦截、`stripCritiqueMeta` 归档指纹一致、`done` 归档抑制 `flow start`
 *   4. `contributor-fork` 独立 `dev-review` 优先于 `awaiting-upstream-merge`
 *   5. `session-state` 按任务隔离 `BLOCKED_TRIAGE_DOWNGRADE`（同任务拦、跨任务放行）
 *   6. `generic-git` `--offline` / 不可达远端 `submit` 延迟推送降级
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerR5PlanFlowCases(cases) {
  cases.push(['[R5-PR1] doc-plan init commits > 0 默认分支落隔离 worktree；显式 --in-place 原地落盘', async () => {
    const dir = tmpProject({ 'README.md': '# demo\n' })
    try {
      gitInit(dir)
      const autoRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'auto-wt', '--title', 'Auto WT', '--owner', 'planner-a', '--json',
      ], { cwd: dir })
      if (autoRes.status !== 0) return `默认规划 worktree init 失败：${autoRes.stderr}`
      const autoJson = JSON.parse(autoRes.stdout)
      if (!autoJson.worktreePath || !autoJson.worktreePath.includes('impl-auto-wt')) {
        return `commits > 0 默认分支未落隔离 worktree：${JSON.stringify(autoJson)}`
      }
      if (existsSync(join(dir, autoJson.file))) return '默认 worktree 模式不应把规划文件直接写进主仓'
      if (!existsSync(join(dir, autoJson.worktreePath, autoJson.file))) return '隔离 worktree 内缺少生成的规划文件'

      const inPlaceRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'in-place-demo', '--title', 'In Place', '--owner', 'planner-a', '--in-place', '--json',
      ], { cwd: dir })
      if (inPlaceRes.status !== 0) return `--in-place 失败：${inPlaceRes.stderr}`
      const inPlaceJson = JSON.parse(inPlaceRes.stdout)
      if (!existsSync(join(dir, inPlaceJson.file))) return '--in-place 未在当前工作区落盘'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R5-PR1] pending-decisions 拦截变体标题与正文未消解文本；stripCritiqueMeta 兼容归档概览表', async () => {
    const { pendingDecisionErrors } = await import('../../kit/skills/lib/pending-decisions.mjs')
    const { stripCritiqueMeta } = await import('../../kit/skills/lib/doc-frontmatter.mjs')
    const { critiqueTextFingerprint } = await import('../../kit/skills/lib/critique-rounds.mjs')

    const unresolvedDoc = [
      '---', 'kind: spec', 'title: Heading Slug', 'status: draft', '---', '',
      '## 一、方案', '- **默认开关**：选项名与默认值仍待定。', '',
      '| 候选 | 命名候选（待拍板，推荐第一项） |', '| --- | --- |',
      '', '## 仍待你拍板', '- 请定前缀参数名。',
    ].join('\n')
    const errs = pendingDecisionErrors(unresolvedDoc)
    if (errs.length === 0 || errs[0].code !== 'BLOCKED_PENDING_DECISIONS') {
      return `未拦住隐式待拍板与标题变体：${JSON.stringify(errs)}`
    }

    const resolvedDoc = [
      '---', 'kind: spec', 'title: Clean Spec', 'status: approved', '---', '',
      '| 当前状态 | `approved` |', '| 分支 / 基线 | `feat/x` @ `abc` |',
      '', '## 一、待拍板问题', '- 前缀名：已定：slugPrefix，默认空字符串。',
      '', '## 二、验收标准',
      '', '相关 PRD：`../prd/261123-demo-prd.md`', '- [ ] C1: `npm test` 通过。',
    ].join('\n')
    if (pendingDecisionErrors(resolvedDoc).length > 0) return '已消解文档被误拦'

    const archivedDoc = resolvedDoc
      .replace('status: approved', 'status: implemented\ndone_at: 2026-11-23')
      .replace('| 当前状态 | `approved` |', '| 当前状态 | `implemented` |\n| 归档时间 | `2026-11-23` |')
      .replace('`../prd/261123-demo-prd.md`', '`../archive/prd/261123-demo-prd.md`')
      .replace('- [ ] C1:', '- [x] C1:')
    if (critiqueTextFingerprint(resolvedDoc) !== critiqueTextFingerprint(archivedDoc)) {
      return `归档元信息表与改链不应改变正文指纹：\n${stripCritiqueMeta(resolvedDoc)}\nVS\n${stripCritiqueMeta(archivedDoc)}`
    }
    return true
  }])

  cases.push(['[R5-PR1] evaluatePlanNextState 路由 1:N PRD/切片、Dismiss 退回续聊、中断接管与 --plan-only', async () => {
    const { evaluatePlanNextState, buildPlanHandoff } = await import('../../kit/skills/lib/plan-next.mjs')
    const { critiqueRejectDoc, critiquePassDoc, critiqueContinueDoc, critiqueTextFingerprint } = await import('../../kit/skills/lib/critique-rounds.mjs')
    const dir = tmpProject({
      'AGENTS.md': '# A\n',
      'src/app.mjs': 'export const ok = 1\n',
      'docs/prd/261123-master-prd.md': '---\nkind: prd\ntitle: Master\nstatus: active\nmulti_spec: true\nowner: planner-1\nplan_critique: passed\n---\n\n# Master\n- [ ] C1: done\n',
      'docs/specs/261123-slice-a-spec.md': '---\nkind: spec\ntitle: Slice A\nstatus: draft\nowner: planner-1\napproved: false\nrelated_prd: ../prd/261123-master-prd.md\ntask_id: slice-a\n---\n\n# Slice A\n- [ ] C1: done\n',
    })
    try {
      gitInit(dir)
      const s1 = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true })
      if (s1.phase !== 'needs-critique' || s1.doc?.file !== 'docs/specs/261123-slice-a-spec.md') {
        return `1:N active Master PRD 应路由到未过审切片 needs-critique：${JSON.stringify(s1)}`
      }

      await critiqueRejectDoc({ repoRoot: dir, mainRoot: dir, isGit: true, file: 'docs/specs/261123-slice-a-spec.md', reviewer: 'critic-1', round: 1, findings: ['缺少边界用例'], taskId: 'slice-a' })
      const sRev = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true })
      if (sRev.phase !== 'needs-revision' || sRev.ownerRole !== 'planner') {
        return `critique-reject 后应进入 needs-revision：${JSON.stringify(sRev)}`
      }
      const hRev = buildPlanHandoff({ state: sRev })
      if (!hRev.prompt.includes('优先向当前仍活跃或休眠的原') || !hRev.prompt.includes('缺少边界用例')) {
        return `交接包缺少写手续聊优先提示或 findings：\n${hRev.prompt}`
      }

      // 模拟修订后过审 -> 进入 needs-human-review 3 态拍板 -> Dismiss 打回
      const specAbs = join(dir, 'docs/specs/261123-slice-a-spec.md')
      writeFileSync(specAbs, '---\nkind: spec\ntitle: Slice A\nstatus: draft\nowner: planner-1\napproved: false\nrelated_prd: ../prd/261123-master-prd.md\ntask_id: slice-a\n---\n\n# Slice A\n- [ ] C1: done\n- [ ] C2: edge\n')
      await critiquePassDoc({ repoRoot: dir, mainRoot: dir, isGit: true, file: 'docs/specs/261123-slice-a-spec.md', reviewer: 'critic-2', round: 2, summary: 'ok', taskId: 'slice-a' })
      const sHuman = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true })
      if (sHuman.phase !== 'needs-human-review' || (sHuman.reviewChoices ?? []).length < 3) {
        return `critique-pass 后未进入 3 态人工拍板：${JSON.stringify(sHuman)}`
      }

      await critiqueContinueDoc({ repoRoot: dir, mainRoot: dir, file: 'docs/specs/261123-slice-a-spec.md', reason: '补充 Plan-Only 团队接口说明', taskId: 'slice-a' })
      const sDismiss = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true })
      if (sDismiss.phase !== 'needs-revision' || !sDismiss.critique.findings.some((f) => f.includes('补充 Plan-Only'))) {
        return `critique-continue 后应回到 needs-revision 并保留意见：${JSON.stringify(sDismiss)}`
      }

      const approvedBody = '---\nkind: spec\ntitle: Slice A\nstatus: approved\nowner: planner-1\napproved: true\nrelated_prd: ../prd/261123-master-prd.md\ntask_id: slice-a\nplan_critique: passed\n---\n\n# Slice A\n- [ ] C1: done\n- [ ] C2: edge\n- [ ] C3: plan-only\n'
      writeFileSync(specAbs, approvedBody)
      await critiquePassDoc({ repoRoot: dir, mainRoot: dir, isGit: true, file: 'docs/specs/261123-slice-a-spec.md', reviewer: 'critic-3', round: 3, summary: 'ok', taskId: 'slice-a' })
      // 写入 approved + 匹配 sha 确保 readiness 通过
      const curSha = critiqueTextFingerprint(approvedBody)
      writeFileSync(specAbs, approvedBody.replace('plan_critique: passed', `plan_critique: passed (reviewer=critic-3, round=3, sha=${curSha}, summary=ok)`))
      const sPlanOnly = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true, planOnly: true })
      if (sPlanOnly.phase !== 'plan-only-handoff') return `--plan-only 已过审应输出 plan-only-handoff：${JSON.stringify(sPlanOnly)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R5-PR1] contributor-fork 先走 needs-review 再进 awaiting-upstream-merge', async () => {
    const { evaluateNextState } = await import('../../kit/skills/lib/workflow-policy-next.mjs')
    const { buildSubmitNextSteps } = await import('../../kit/skills/lib/workflow-helpers.mjs')
    const forkTask = {
      taskId: 'fork-ui', slug: 'fork-ui', caseType: 2, role: 'contributor-fork', status: 'submitted',
      claimedAt: '2026-11-23T00:00:00Z', implementerId: 'dev-1', finalVerifyPassed: true,
      verifiedHead: 'abc1234', lastSubmittedHead: 'abc1234', reviewPassed: false, rounds: [],
    }
    const rtBefore = {
      headSha: 'abc1234', dirty: 0, mainDirtyCount: 0, hasDevReview: true,
      policy: { riskTier: 'high', independentReviewRequired: true, requiredGates: ['full'] },
      evidenceValidation: { ok: true },
    }
    const beforeRev = evaluateNextState({ activeTasks: [forkTask], selectedTask: forkTask, taskRuntime: rtBefore })
    if (beforeRev.phase !== 'needs-review') return `contributor-fork 未审应停在 needs-review：${beforeRev.phase}`

    const submitSteps = buildSubmitNextSteps({ taskId: 'fork-ui', role: 'contributor-fork', policy: rtBefore.policy, nextRound: 1, hasDevReview: true })
    if (!JSON.stringify(submitSteps).includes('review-pack.mjs')) return `contributor-fork submit 下一步应先审后等合并：${JSON.stringify(submitSteps)}`

    const reviewedTask = { ...forkTask, reviewPassed: true, reviewPassedHead: 'abc1234', rounds: [{ round: 1, verdict: 'pass', headSha: 'abc1234', reviewerId: 'rev-1', blockers: [] }] }
    const afterRev = evaluateNextState({ activeTasks: [reviewedTask], selectedTask: reviewedTask, taskRuntime: rtBefore })
    if (afterRev.phase !== 'awaiting-upstream-merge') return `contributor-fork 审过应进 awaiting-upstream-merge：${afterRev.phase}`
    return true
  }])

  cases.push(['[R5-PR1] session-state 按任务消费隔离 BLOCKED_TRIAGE_DOWNGRADE；已归档 Todo 抑制 flow start', async () => {
    const { recordTriageDecision, markTriageConsumed, readSessionState, findBlockingTriageDowngrade } = await import('../../kit/skills/lib/session-state.mjs')
    const dir = tmpProject({
      'AGENTS.md': '# A\n',
      'docs/archive/todo/261123-old-todo.md': '---\nkind: todo\ntitle: Done\nstatus: done\ncreated: 2026-11-23\nupdated: 2026-11-23\nowner: p1\ntask_id: old\n---\n\n# Done\n## 验收标准与执行清单\n- [x] C1: `echo ok`\n',
    })
    try {
      gitInit(dir)
      recordTriageDecision(dir, { caseType: 4, summary: 'heading slug feature' })
      // 未被消费的新 triage，若未指名任务直接降档仍阻断
      const unconsumedDown = findBlockingTriageDowngrade(readSessionState(dir), { nextCase: 2, reason: '' })
      if (unconsumedDown.ok || unconsumedDown.code !== 'BLOCKED_TRIAGE_DOWNGRADE') return '未消费的高档 triage 静默降档应仍被拦'

      // 被 task-a 消费后，全新无关 task-b (Case 2) 不再误撞降档；同一 task-a 降档仍拦
      markTriageConsumed(dir, { taskId: 'heading-slug', slug: 'heading-slug' })
      const crossTask = findBlockingTriageDowngrade(readSessionState(dir), { taskId: 'table-edge-tests', slug: 'table-edge-tests', summary: 'table tests', nextCase: 2, reason: '' })
      if (!crossTask.ok) return `跨无关新任务被误报 BLOCKED_TRIAGE_DOWNGRADE：${JSON.stringify(crossTask)}`
      const sameTask = findBlockingTriageDowngrade(readSessionState(dir), { taskId: 'heading-slug', slug: 'heading-slug', nextCase: 2, reason: '' })
      if (sameTask.ok) return '同一任务降档未拦'

      const archAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/archive/todo/261123-old-todo.md'], { cwd: dir })
      if (archAudit.stdout.includes('flow.mjs start')) return `已归档 done Todo audit 误输出 flow start：\n${archAudit.stdout}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R5-PR1] generic-git --offline submit 延迟推送并解锁本地独立审查工作位', async () => {
    const dir = tmpProject({
      'AGENTS.md': '```yaml\nquick-test: node -e "console.log(1)"\nfull-test: node -e "console.log(1)"\nsmoke-verify: none\nmerge-gate: node -e "console.log(1)"\n```\n',
      'src/app.mjs': 'export const a = 1\n',
    })
    try {
      gitInit(dir)
      gitSync(dir, ['remote', 'add', 'origin', 'https://git.example.org/org/demo.git'])
      const stRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'off-task', '--slug', 'off-task', '--case', '2', '--no-issue', '--reason', '回归夹具测试 generic-git 离线提交', '--json'], { cwd: dir })
      if (stRes.status !== 0) return `generic-git start 失败：${stRes.stderr}`
      const wt = join(dir, '.worktrees', 'impl-off-task')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const a = 2\n')
      gitSync(wt, ['add', 'src/app.mjs'])
      gitCommitFast(wt, 'fix: update app')
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['claim', '--task', 'off-task', '--agent', 'worker-off'], { cwd: wt })
      const verRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'off-task', '--tier', 'full', '--json'], { cwd: wt })
      if (verRes.status !== 0) return `verify 失败：${verRes.stderr}\n${verRes.stdout}`
      const subRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 'off-task', '--agent', 'worker-off', '--offline', '--json'], { cwd: wt })
      if (subRes.status !== 0) return `generic-git --offline submit 失败：${subRes.stderr}\n${subRes.stdout}`
      const subJson = JSON.parse(subRes.stdout)
      if (!subJson.deferredPush || subJson.status !== 'submitted') return `offline submit 状态异常：${JSON.stringify(subJson)}`
      if (!existsSync(join(dir, '.worktrees', 'review-off-task'))) return 'offline submit 未同步本地 review worktree'
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
