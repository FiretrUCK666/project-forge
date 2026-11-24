/**
 * fixtures-w4-harness.mjs —— Wave 4A Harness Core（C1-C4）正反双向行为断言（Red-Green 驱动）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EXIT, gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree,
  runAbsAsync, runNode, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'

function makeCleanAgentsMd() {
  return [
    '# Project',
    '',
    '<!-- project-forge: begin Dev Profile -->',
    '```yaml',
    'quick-test: node -e "process.exit(0)"',
    'full-test: node -e "process.exit(0)"',
    'smoke-verify: node -e "process.exit(0)"',
    'merge-gate: none',
    'arch-rules: none',
    'high-risk: none',
    'do-not-edit: docs/archive/',
    '```',
    '<!-- project-forge: end Dev Profile -->',
    '',
  ].join('\n')
}

function writeValidSpec(dir, rel, {
  issue = 'null',
  owner = 'arch-1',
  status = 'approved',
  critique = 'passed (round=1)',
  relatedPrd = '无',
  extraFm = '',
  goalText = '在 `src/core.mjs` 实现校验函数 `validateInput()`。',
  criteria = '- [ ] C1: `node -e "process.exit(0)"` 返回 exit 0',
} = {}) {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  const text = [
    '---',
    'kind: spec',
    'title: Test Spec',
    `status: ${status}`,
    `issue: ${issue}`,
    `owner: ${owner}`,
    `related_prd: ${relatedPrd}`,
    `plan_critique: ${critique}`,
    ...(extraFm ? [extraFm] : []),
    'created: 2026-11-22',
    'updated: 2026-11-22',
    '---',
    '',
    '# SPEC: Test Spec',
    '',
    '## 目标与背景',
    goalText,
    '',
    '## 非目标',
    '- 不改动 `src/other.mjs` 的公共导出签名。',
    '',
    '## 方案设计',
    '- 修改 `src/core.mjs` 导出 `validateInput()`，异常返回 `EXIT.FACT`（exit 3）。',
    '',
    '## 验收标准',
    criteria,
    '',
  ].join('\n')
  writeFileSync(full, text, 'utf8')
}

export function registerW4HarnessCases(cases) {
  // === C1: harness-context / owner / slot / claim / token ===

  cases.push(['[C1] harness-context: resolveHostMode / resolveNonEmptyActor / enforceSlotBoundary / checkAuthorIsNotImplementer 正反双向', async () => {
    const hc = await import('../../kit/skills/lib/harness-context.mjs')
    if (hc.resolveHostMode({}) !== 'multi-agent') return '默认应为 multi-agent'
    if (hc.resolveHostMode({ 'host-mode': 'single-session' }) !== 'single-session') return '--host-mode single-session 识别失败'
    if (hc.resolveHostMode({ 'single-session': true }) !== 'single-session') return '--single-session 识别失败'

    const badActor = hc.resolveNonEmptyActor(['', 'null', '<agent>'])
    if (badActor.ok || badActor.code !== 'BLOCKED_MISSING_ACTOR') return `空/占位 actor 应阻断，收到：${JSON.stringify(badActor)}`
    const coordBad = hc.resolveNonEmptyActor(['coordinator-1'], { allowCoordinator: false })
    if (coordBad.ok || coordBad.code !== 'BLOCKED_MISSING_ACTOR') return `coordinator actor 应阻断，收到：${JSON.stringify(coordBad)}`
    const goodActor = hc.resolveNonEmptyActor(['', 'impl-a'])
    if (!goodActor.ok || goodActor.actor !== 'impl-a') return `合法 actor 应通过，收到：${JSON.stringify(goodActor)}`

    const case1InPlace = hc.enforceSlotBoundary({ mainRoot: '/repo', implRoot: '/repo', caseType: 1, isDirtyMain: false })
    if (!case1InPlace.ok) return `Case 1 原地应放行：${JSON.stringify(case1InPlace)}`
    const case2InPlace = hc.enforceSlotBoundary({ mainRoot: '/repo', implRoot: '/repo', caseType: 2, isDirtyMain: false, commits: 1 })
    if (case2InPlace.ok || case2InPlace.code !== 'BLOCKED_MAIN_SLOT_VIOLATION') return `Case >= 2 原地应阻断：${JSON.stringify(case2InPlace)}`
    const dirtyMain = hc.enforceSlotBoundary({ mainRoot: '/repo', implRoot: '/repo/.worktrees/impl-x', caseType: 2, isDirtyMain: true, commits: 1 })
    if (dirtyMain.ok || dirtyMain.code !== 'BLOCKED_DIRTY_MAIN') return `脏 main 应阻断：${JSON.stringify(dirtyMain)}`

    const sameAuthor = hc.checkAuthorIsNotImplementer('dev-a', 'dev-a', { hostMode: 'multi-agent', humanApproved: false })
    if (sameAuthor.ok || sameAuthor.code !== 'BLOCKED_AUTHOR_IS_IMPLEMENTER') return `多代理同人规划实现应阻断：${JSON.stringify(sameAuthor)}`
    const singleOk = hc.checkAuthorIsNotImplementer('dev-a', 'dev-a', { hostMode: 'single-session', humanApproved: true })
    if (!singleOk.ok) return `single-session + humanApproved 应放行：${JSON.stringify(singleOk)}`
    const diffAuthor = hc.checkAuthorIsNotImplementer('arch-1', 'impl-1', { hostMode: 'multi-agent' })
    if (!diffAuthor.ok) return `不同人规划实现应放行：${JSON.stringify(diffAuthor)}`
    return true
  }])

  cases.push(['[C1] doc-plan init/audit 禁 owner: null 与合法 --owner 放行', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      const rBad = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'bad-owner', '--title', 'Bad Owner', '--owner', 'null', '--dir', dir, '--json',
      ], { cwd: dir })
      if (rBad.status === 0) return `owner: null 应阻断，实际 exit=${rBad.status}`

      const rGood = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'good-owner', '--title', 'Good Owner', '--owner', 'arch-1', '--dir', dir, '--in-place', '--json',
      ], { cwd: dir })
      if (rGood.status !== 0) return `合法 --owner init 失败：${rGood.stderr || rGood.stdout}`
      const parsed = JSON.parse(rGood.stdout)
      const content = readFileSync(join(dir, parsed.file), 'utf8')
      if (!/owner:\s*arch-1/.test(content)) return `未写入 owner: arch-1：\n${content}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C1] flow start 脏 main 阻断、Case 1 原地放行与 author===implementer 阻断', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
    })
    try {
      gitInit(dir)
      // 1) Case 1 原地微调放行
      const c1 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'typo-fix', '--case', '1', '--agent', 'impl-1', '--dir', dir, '--json',
      ], { cwd: dir })
      if (c1.status !== 0) return `Case 1 start 应放行：${c1.stderr || c1.stdout}`
      const c1Out = JSON.parse(c1.stdout)
      if (c1Out.tier !== 1) return `Case 1 应原地执行（tier=1），收到：${JSON.stringify(c1Out)}`

      // 2) 脏 main 对 Case 2 阻断
      writeFileSync(join(dir, 'src/core.mjs'), 'export const ok = 2\n', 'utf8')
      const dirtyStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'dirty-case2', '--case', '2', '--agent', 'impl-1', '--dir', dir, '--json',
      ], { cwd: dir })
      if (dirtyStart.status !== EXIT.FACT || !`${dirtyStart.stdout}${dirtyStart.stderr}`.includes('BLOCKED_DIRTY_MAIN')) {
        return `脏 main 对 Case 2 应阻断 BLOCKED_DIRTY_MAIN，收到 status=${dirtyStart.status} out=${dirtyStart.stdout} err=${dirtyStart.stderr}`
      }
      gitSync(dir, ['checkout', '--', 'src/core.mjs'])

      // 3) author === implementer 在 planning->started 晋升时阻断
      writeValidSpec(dir, 'docs/specs/261122-same-owner-spec.md', { owner: 'same-dev', status: 'approved' })
      gitCommitFast(dir, 'docs: add approved spec')
      const planStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'same-owner', '--case', '4', '--planning', '--dir', dir, '--json',
      ], { cwd: dir })
      if (planStart.status !== 0) return `planning start 失败：${planStart.stderr || planStart.stdout}`
      const promoteBad = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'same-owner', '--agent', 'same-dev', '--dir', dir, '--json',
      ], { cwd: dir })
      if (promoteBad.status !== EXIT.FACT || !`${promoteBad.stdout}${promoteBad.stderr}`.includes('BLOCKED_AUTHOR_IS_IMPLEMENTER')) {
        return `同人规划实现应阻断 BLOCKED_AUTHOR_IS_IMPLEMENTER，收到 status=${promoteBad.status} out=${promoteBad.stdout} err=${promoteBad.stderr}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C1] submit 强校 --agent、Case >= 2 强校 claimedAt 与 local-only 自动认领', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
    })
    try {
      gitInit(dir)
      const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'local-c2', '--case', '2', '--agent', 'impl-local', '--no-issue', '--reason', '回归夹具聚焦 local-only claimedAt 校验', '--dir', dir, '--json',
      ], { cwd: dir })
      if (st.status !== 0) return `local-only start 失败：${st.stderr || st.stdout}`
      const { readTaskLedger, writeTaskLedger } = await import('../../kit/skills/lib/ledger.mjs')
      const ledger = readTaskLedger(dir, 'local-c2')
      if (!ledger?.claimedAt) return 'local-only 带 --agent 启动后应自动设置 claimedAt'

      // 抹去 claimedAt 测试 finalize 硬阻断 BLOCKED_UNCLAIMED_TASK
      const savedClaimedAt = ledger.claimedAt
      delete ledger.claimedAt
      writeTaskLedger(dir, ledger)
      const finUnclaimed = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'finalize', '--task', 'local-c2', '--dir', dir, '--json',
      ], { cwd: dir })
      if (finUnclaimed.status !== EXIT.FACT || !`${finUnclaimed.stdout}${finUnclaimed.stderr}`.includes('BLOCKED_UNCLAIMED_TASK')) {
        return `未认领 Case 2 finalize 应阻断 BLOCKED_UNCLAIMED_TASK，收到 status=${finUnclaimed.status} out=${finUnclaimed.stdout} err=${finUnclaimed.stderr}`
      }
      ledger.claimedAt = savedClaimedAt
      writeTaskLedger(dir, ledger)

      // submit 缺 --agent 在 multi-agent 下应被 USAGE 拦截
      const hooks = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs')
      const subBad = hooks.assertSubmitOwnership(ledger, {})
      if (subBad.ok || subBad.code !== 'BLOCKED_MISSING_ACTOR') return `缺 --agent 应阻断，收到：${JSON.stringify(subBad)}`
      const subSingle = hooks.assertSubmitOwnership(ledger, { 'host-mode': 'single-session', 'human-approved': true })
      if (!subSingle.ok) return `single-session + human-approved submit 应放行：${JSON.stringify(subSingle)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C1] reviewToken 绑定 (round, reviewerId, headSha) 防串轮/漂移/冒用', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      const { createDefaultLedger, ensureReviewToken, consumeReviewToken, writeTaskLedger } = await import('../../kit/skills/lib/ledger.mjs')
      const ledger = createDefaultLedger({ taskId: 'tok-bind', slug: 'tok-bind', baseSha: 'a'.repeat(40), status: 'started' })
      writeTaskLedger(dir, ledger)
      const sha1 = '1'.repeat(40)
      const sha2 = '2'.repeat(40)
      const { token } = ensureReviewToken(dir, ledger, 1, { reviewerId: 'rev-1', headSha: sha1 })

      const badHead = consumeReviewToken(ledger, token, 1, { reviewerId: 'rev-1', headSha: sha2 })
      if (badHead.ok || badHead.code !== 'BLOCKED_REVIEW_TOKEN_BINDING') return `headSha 漂移应阻断：${JSON.stringify(badHead)}`

      const badRev = consumeReviewToken(ledger, token, 1, { reviewerId: 'rev-2', headSha: sha1 })
      if (badRev.ok || badRev.code !== 'BLOCKED_REVIEW_TOKEN_BINDING') return `reviewerId 不匹配应阻断：${JSON.stringify(badRev)}`

      const good = consumeReviewToken(ledger, token, 1, { reviewerId: 'rev-1', headSha: sha1 })
      if (!good.ok) return `精确匹配应放行：${JSON.stringify(good)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // === C2: session-state / handoff / explore / plan-exit-gate / multi_spec / audit ===

  cases.push(['[C2] session-state S1-S4 账本、triage 降档阻断与 5 角色 handoff-package', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      const ss = await import('../../kit/skills/lib/session-state.mjs')
      ss.recordStepState(dir, { step: 'S1', ok: true, summary: 'surveyed' })
      const loaded = ss.readSessionState(dir)
      if (!loaded?.steps?.S1?.ok) return 'S1 状态未持久化'

      const downCheck = ss.checkTriageDowngrade({ previousCase: 4, nextCase: 2, reason: '' })
      if (downCheck.ok || downCheck.code !== 'BLOCKED_TRIAGE_DOWNGRADE') return `无理由降档应阻断：${JSON.stringify(downCheck)}`
      const downOk = ss.checkTriageDowngrade({ previousCase: 4, nextCase: 2, reason: '经核实仅为文档错字，不涉及源码变更' })
      if (!downOk.ok) return `有理由降档应放行：${JSON.stringify(downOk)}`

      const hp = await import('../../kit/skills/lib/handoff-package.mjs')
      for (const role of ['explore', 'plan', 'critique', 'implementer', 'reviewer']) {
        const pkg = hp.buildHandoff({ role, taskId: 'demo', summary: `${role} task` })
        if (!pkg || pkg.role !== role) return `5 角色 handoff 缺少角色支持：${role}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C2] 移除 autoPopulateExplored：Case >= 3 缺真实探索阻断 finalize，跑 explore 后放行', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
    })
    try {
      gitInit(dir)
      const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c3-exp', '--case', '3', '--agent', 'impl-1', '--allow-plan-bootstrap', '--dir', dir, '--json',
      ], { cwd: dir })
      if (st.status !== 0) return `start 失败：${st.stderr || st.stdout}`
      const { readTaskLedger } = await import('../../kit/skills/lib/ledger.mjs')
      const ledger = readTaskLedger(dir, 'c3-exp')
      if (ledger.explored) return `flow start 不应自动伪造 explored：${JSON.stringify(ledger.explored)}`

      const finBad = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'finalize', '--task', 'c3-exp', '--dir', dir, '--json',
      ], { cwd: dir })
      if (finBad.status !== EXIT.FACT || !`${finBad.stdout}${finBad.stderr}`.includes('BLOCKED_UNEXPLORED_TASK')) {
        return `缺真实探索证据应阻断 BLOCKED_UNEXPLORED_TASK，收到 status=${finBad.status} out=${finBad.stdout} err=${finBad.stderr}`
      }

      const exp = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'explore', '--task', 'c3-exp', '--dir', dir, '--json',
      ], { cwd: dir })
      if (exp.status !== 0) return `flow explore 失败：${exp.stderr || exp.stdout}`
      const after = readTaskLedger(dir, 'c3-exp')
      if (!after?.explored?.at) return 'flow explore 后应写入真实 explored 证据'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C2] plan-exit-gate bound.length===0 硬阻断，--multi-spec 与 related_prd 自动识别总控 PRD，flow batch 保留依赖', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
    })
    try {
      gitInit(dir)
      const { evaluatePlanExitGate } = await import('../../kit/skills/lib/plan-exit-gate.mjs')
      const emptyGate = evaluatePlanExitGate(dir, { caseType: 4, slug: 'ghost-task', docs: {} })
      if (!emptyGate.blocked || emptyGate.code !== 'BLOCKED_PLAN_NOT_READY') {
        return `bound.length===0 应阻断 BLOCKED_PLAN_NOT_READY：${JSON.stringify(emptyGate)}`
      }

      // init --multi-spec 创建总控 PRD
      const prdInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'prd', '--slug', 'master-x', '--title', 'Master X', '--owner', 'arch-1', '--multi-spec', '--dir', dir, '--in-place', '--json',
      ], { cwd: dir })
      if (prdInit.status !== 0) return `init --multi-spec 失败：${prdInit.stderr || prdInit.stdout}`
      const prdFile = JSON.parse(prdInit.stdout).file
      const prdText = readFileSync(join(dir, prdFile), 'utf8')
      if (!/multi_spec:\s*true/.test(prdText)) return `PRD 应含 multi_spec: true：\n${prdText}`

      // 即使 PRD 没有 multi_spec: true，只要被切片 spec 的 related_prd 引用，也应被 buildSliceGraph 自动识别为总控 PRD
      writeFileSync(join(dir, prdFile), prdText.replace(/multi_spec:\s*true\n?/, ''), 'utf8')
      const relatedPrdRel = `../prd/${prdFile.split('/').pop()}`
      writeValidSpec(dir, 'docs/specs/261122-slice-a-spec.md', {
        relatedPrd: relatedPrdRel,
        extraFm: 'depends_on: []\nscope_files: src/a.mjs',
      })
      writeValidSpec(dir, 'docs/specs/261122-slice-b-spec.md', {
        relatedPrd: relatedPrdRel,
        extraFm: 'depends_on: slice-a\nscope_files: src/b.mjs',
      })
      const { buildSliceGraph } = await import('../../kit/skills/lib/doc-slice-graph.mjs')
      const graph = buildSliceGraph(dir)
      if (!graph.masters.some((p) => p.rel === prdFile)) return `被多切片 spec 引用的 PRD 应自动识别为总控 PRD：${JSON.stringify(graph.masters)}`

      const batchOut = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'batch', 'plan', '--dir', dir, '--json',
      ], { cwd: dir })
      if (batchOut.status !== 0) return `flow batch plan 失败：${batchOut.stderr || batchOut.stdout}`
      const batch = JSON.parse(batchOut.stdout)
      const sliceB = (batch.slices ?? []).find((s) => s.slug === 'slice-b')
      if (!sliceB || !sliceB.dependsOn?.includes('slice-a')) return `batch plan 丢失 depends_on：${JSON.stringify(batch)}`
      if ((batch.slices ?? []).some((s) => s.rel === prdFile)) return `PRD 容器不应混入可调度 slices：${JSON.stringify(batch.slices)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C2] --skip-critique-reason 限 single-session+human-approved、PENDING_WORDS 全扫描、substantive 锚点、PATH_PREFIX_RE', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
      'src/other.mjs': 'export const o = 1\n',
      'pkg/core/mod.go': 'package core\n',
      'cmd/app/main.go': 'package main\n',
    })
    try {
      gitInit(dir)
      writeValidSpec(dir, 'docs/specs/261122-skip-gate-spec.md', { status: 'draft', critique: 'pending' })
      // multi-agent 禁止 --skip-critique-reason
      const rBad = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'approve', '--file', 'docs/specs/261122-skip-gate-spec.md',
        '--skip-critique-reason', '本次紧急跳过但实际应当在多代理模式被拦截以防绕过评审', '--dir', dir, '--json',
      ], { cwd: dir })
      if (rBad.status === 0) return `multi-agent 下 --skip-critique-reason 应阻断，实际 exit=${rBad.status}`

      // single-session + --human-approved 放行
      const rGood = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'approve', '--file', 'docs/specs/261122-skip-gate-spec.md',
        '--host-mode', 'single-session', '--human-approved',
        '--skip-critique-reason', '单人会话经人类确认跳过 Critique，已核对改动仅涉及 pkg/core/mod.go', '--dir', dir, '--json',
      ], { cwd: dir })
      if (rGood.status !== 0) return `single-session + --human-approved 应放行：${rGood.stderr || rGood.stdout}`

      // PENDING_WORDS 多节全扫
      const { analyzePendingDecisions } = await import('../../kit/skills/lib/pending-decisions.mjs')
      const pendingDoc = [
        '## 待拍板',
        '- [x] 已决：采用方案 A',
        '## 开放问题',
        '- [ ] 还没定：端口选 8080 还是 9090？',
      ].join('\n')
      const pd = analyzePendingDecisions(pendingDoc)
      if (!pd.unresolved || pd.unresolved.length === 0) return `多节 PENDING_WORDS 应扫出第二段未决项：${JSON.stringify(pd)}`

      // doc-substantive 无套话但无任何技术锚点应被拦截
      const { checkCoreSubstantiveness } = await import('../../kit/skills/lib/doc-substantive.mjs')
      const subBad = checkCoreSubstantiveness('## 目标与背景\n我们需要改善整体的架构可维护性并提升团队研发效能。\n\n## 非目标\n不改变现有用户体验。\n\n## 方案设计\n采用模块化思路进行合理重构。', 'spec')
      if (!Array.isArray(subBad) || subBad.length === 0) return `纯空话无技术锚点应拦截（即使不含 VAGUE_FLUFF_RE）：${JSON.stringify(subBad)}`

      // PATH_PREFIX_RE 包含 pkg/ 与 cmd/
      const { extractLinePathCandidates } = await import('../../kit/skills/dev-plan/scripts/doc-audit-helpers.mjs')
      const paths = extractLinePathCandidates('更新 `pkg/core/mod.go` 与 cmd/app/main.go。')
      if (!paths.includes('pkg/core/mod.go') || !paths.includes('cmd/app/main.go')) {
        return `PATH_PREFIX_RE 应识别 pkg/ 与 cmd/，收到：${JSON.stringify(paths)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C2] survey 零写入与 compose-agents --check 占位拦截', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"demo","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      'src/index.mjs': 'export const x = 1\n',
    })
    try {
      gitInit(dir)
      const sv = await runNode('survey.mjs', [dir, '--json'], { cwd: dir })
      if (sv.status !== 0) return `survey 失败：${sv.stderr || sv.stdout}`
      const ss = await import('../../kit/skills/lib/session-state.mjs')
      const st1 = ss.readSessionState(dir)
      if (st1?.steps?.S1) return `survey() 不得写入 session-state.json（S1 零写）：${JSON.stringify(st1)}`

      // 占位符 AGENTS.md 应被 compose-agents --check 拦截
      writeFileSync(join(dir, 'AGENTS.md'), [
        '# Demo',
        '<!-- project-forge: begin Dev Profile -->',
        '```yaml',
        'quick-test: <待填>',
        '```',
        '<!-- project-forge: end Dev Profile -->',
      ].join('\n'), 'utf8')
      const chk = await runNode('compose-agents.mjs', [dir, '--check'], { cwd: dir })
      if (chk.status === 0) return 'compose-agents --check 应拦截含占位符的 Dev Profile'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // === C3: gate-enforcement / empirical / edit-gate / merge / cleanup / iterate / retro ===

  cases.push(['[C3] evaluatePassBlockers 默认 enforceGates=true 与 Round 2+ 未逐条回复 Must-Fix 阻断 pass', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    const noSmokeDir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd({ smokeVerify: 'none' }), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      gitInit(noSmokeDir)
      const { evaluatePassBlockers } = await import('../../kit/skills/dev-review/scripts/review-locks.mjs')
      const res = await evaluatePassBlockers({
        mainRoot: noSmokeDir, targetRoot: noSmokeDir, gitDir: join(noSmokeDir, '.git'),
        taskId: 't-enf', ledger: { taskId: 't-enf', caseType: 3, changedFiles: ['src/core.mjs'] },
        headSha: 'a'.repeat(40),
      })
      if (!res.blocked || !res.blockers?.some((b) => b.includes('--enforce-gates'))) {
        return `evaluatePassBlockers 默认应开启 enforceGates=true 并阻断未实证任务：${JSON.stringify(res)}`
      }

      const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'r2-open', '--case', '2', '--agent', 'impl-1', '--no-issue', '--reason', '回归夹具聚焦 Round 2 未闭合项阻断', '--dir', dir, '--json',
      ], { cwd: dir })
      if (st.status !== 0) return `start 失败：${st.stderr}`
      await seedExploredFor(dir, 'r2-open')
      const wt = join(dir, '.worktrees', 'impl-r2-open')
      writeFileSync(join(wt, 'src/core.mjs'), 'export const ok = 2\n', 'utf8')
      gitCommitFast(wt, 'feat: change core')

      // R1 changes with must-fix M1
      const tok1 = await issueTokenFor(dir, 'r2-open', 1)
      const r1 = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'r2-open', '--round', '1', '--verdict', 'changes',
        '--reviewer-id', 'rev-1', '--review-token', tok1,
        '--evidence', 'node -e check ran and detected missing boundary check',
        '--e2e-evidence', '运行 node -e 检查边界后发现缺失校验',
        '--must-fix', 'M1: 缺少边界校验', '--dir', dir, '--json',
      ], { cwd: dir })
      if (r1.status !== 0) return `R1 record changes 失败：${r1.stderr || r1.stdout}`

      // R2 pass 但未提及 M1 -> 应阻断（Round 2 未逐条消解/反驳 M1 或未过门禁）
      writeFileSync(join(wt, 'src/core.mjs'), 'export const ok = 3\n', 'utf8')
      gitCommitFast(wt, 'fix: address rework')
      const tok2 = await issueTokenFor(dir, 'r2-open', 2)
      const r2Bad = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'r2-open', '--round', '2', '--verdict', 'pass',
        '--reviewer-id', 'rev-2', '--review-token', tok2,
        '--evidence', 'node -e retest ok',
        '--e2e-evidence', '已运行 node -e 验证通过', '--dir', dir, '--json',
      ], { cwd: dir })
      if (r2Bad.status !== EXIT.FACT || !`${r2Bad.stdout}${r2Bad.stderr}`.includes('BLOCKED_PASS_WITH_OPEN_BLOCKERS')) {
        return `R2 pass 未逐条处理 M1 应阻断 BLOCKED_PASS_WITH_OPEN_BLOCKERS，收到 status=${r2Bad.status} out=${r2Bad.stdout} err=${r2Bad.stderr}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(noSmokeDir)
    }
  }])

  cases.push(['[C3] UI 改动强制 --artifact/--visual-blocked-reason、--cmd 追加与 check-fault 注释 diff 拦截', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/app.tsx': 'export const App = () => null\n' })
    try {
      gitInit(dir)
      const { validateArtifactsAndVisual } = await import('../../kit/skills/lib/empirical-artifacts.mjs')
      const uiNoArt = validateArtifactsAndVisual({
        repoRoot: dir,
        artifacts: [],
        visualFilesChanged: ['src/app.tsx'],
        visualCheckedRaw: true,
        observationSummary: '已在浏览器渲染并核验浅深色布局无溢出',
        visualBlockedReason: '',
      })
      if (uiNoArt.ok || uiNoArt.code !== 'BLOCKED_UI_ARTIFACT_REQUIRED') {
        return `UI 改动无真实截图或阻塞说明应阻断 BLOCKED_UI_ARTIFACT_REQUIRED：${JSON.stringify(uiNoArt)}`
      }

      const shot = join(dir, 'shot.png')
      writeFileSync(shot, 'PNG_DATA', 'utf8')
      const uiWithArt = validateArtifactsAndVisual({
        repoRoot: dir,
        artifacts: [shot],
        visualFilesChanged: ['src/app.tsx'],
        visualCheckedRaw: true,
        observationSummary: '已附截图并在 Chromium 核验浅深色与交互',
      })
      if (!uiWithArt.ok) return `附真实附件后 UI 校验应通过：${JSON.stringify(uiWithArt)}`

      // check-fault 仅注释修改在 phase=fail 应拦截 BLOCKED_FAULT_INJECTION_NOOP
      writeFileSync(join(dir, 'src/app.tsx'), 'export const App = () => <div>v2</div>\n', 'utf8')
      gitCommitFast(dir, 'feat: update app ui')
      writeFileSync(join(dir, 'src/app.tsx'), '// baseline comment\nexport const App = () => <div>v2</div>\n', 'utf8')
      const pk = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        '--local', '--dir', dir, '--json',
      ], { cwd: dir })
      if (pk.status !== 0) return `local pack 失败：${pk.stderr || pk.stdout}`
      const emp = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'check-empirical', '--local', '--cmd', 'node -e "process.exit(0)"',
        '--artifact', shot, '--visual-checked', '--e2e-evidence', '已在本地运行并核对 shot.png 渲染界面', '--dir', dir, '--json',
      ], { cwd: dir })
      if (emp.status !== 0) return `local check-empirical 失败：${emp.stderr || emp.stdout}`
      writeFileSync(join(dir, 'src/app.tsx'), '// only a comment fault\nexport const App = () => <div>v2</div>\n', 'utf8')
      const cfBad = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'check-fault', '--local', '--phase', 'fail', '--cmd', 'node -e "process.exit(0)"', '--dir', dir, '--json',
      ], { cwd: dir })
      if (cfBad.status !== EXIT.FACT || !`${cfBad.stdout}${cfBad.stderr}`.includes('BLOCKED_FAULT_INJECTION_NOOP')) {
        return `仅注释修改的 fault fail 应阻断 BLOCKED_FAULT_INJECTION_NOOP，收到 status=${cfBad.status} out=${cfBad.stdout} err=${cfBad.stderr}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C3] edit-gate 禁降级 edit.do-not-edit，cleanup --preview-hash 与 isSafeBranchDelete', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'src/core.mjs': 'export const ok = 1\n',
      'docs/archive/old.md': '# Old\n',
    })
    try {
      gitInit(dir)
      writeFileSync(join(dir, 'docs/archive/old.md'), '# Modified\n', 'utf8')
      const { runEditGate } = await import('../../kit/skills/dev-edit/scripts/edit-gate.mjs')
      const eg = await runEditGate({ dir, task: 't-dne', mode: 'verify', final: true })
      if (eg.ok || !eg.blockers.some((b) => b.ruleId === 'edit.do-not-edit')) {
        return `verify 模式 edit.do-not-edit 不得降级为 warning：${JSON.stringify(eg)}`
      }
      gitSync(dir, ['checkout', '--', 'docs/archive/old.md'])

      // gate-enforcement cleanup previewHash & isSafeBranchDelete
      const ge = await import('../../kit/skills/lib/gate-enforcement.mjs')
      const hash = ge.computeCleanupPreviewHash({ taskId: 'x', worktrees: ['.worktrees/impl-x'], localBranch: 'feat/x', remoteBranch: 'feat/x' })
      if (!hash || hash.length < 8) return 'computeCleanupPreviewHash 应返回非空哈希'
      const emptyHash = ge.verifyCleanupPreviewHash(hash, '')
      if (emptyHash.ok || emptyHash.code !== 'BLOCKED_CLEANUP_PREVIEW_MISMATCH') return `空 previewHash 应阻断：${JSON.stringify(emptyHash)}`
      const mismatch = ge.verifyCleanupPreviewHash(hash, 'deadbeef')
      if (mismatch.ok || mismatch.code !== 'BLOCKED_CLEANUP_PREVIEW_MISMATCH') return `previewHash 不一致应阻断：${JSON.stringify(mismatch)}`

      gitSync(dir, ['checkout', '-b', 'feat/unmerged'])
      writeFileSync(join(dir, 'src/core.mjs'), 'export const ok = 2\n', 'utf8')
      gitCommitFast(dir, 'feat: unmerged commit')
      gitSync(dir, ['checkout', 'main'])
      const unmerged = await ge.isSafeBranchDelete(dir, 'feat/unmerged', 'main', {})
      if (unmerged.safe || unmerged.code !== 'BLOCKED_UNMERGED_BRANCH_DELETE') {
        return `未合分支删除应阻断 BLOCKED_UNMERGED_BRANCH_DELETE：${JSON.stringify(unmerged)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C3] stop-loss 解锁后仍强校 verifiedHead & iterate-cycle 持久化 & retro 进 session-orient', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      const { validatePreMergeShaAndWorktree } = await import('../../kit/skills/lib/workflow-helpers.mjs')
      const gate = validatePreMergeShaAndWorktree({
        currentHead: 'b'.repeat(40),
        evidence: { headSha: 'a'.repeat(40), dirty: false, exitCode: 0, gates: { quick: { headSha: 'a'.repeat(40), exitCode: 0 } } },
        ledger: { verifiedHead: 'a'.repeat(40) },
        lastRound: { headSha: 'b'.repeat(40), stopLossTriggered: true },
        dirtyCount: 0,
        requiresReview: true,
        stopLossActive: true,
      })
      if (gate.ok) return 'stopLossActive 时仍不得跳过 verifiedHead === currentHead 校验'

      // iterate-cycle 持久化
      const { saveCycleState, loadCycleState } = await import('../../kit/skills/dev-iterate/scripts/iterate-cycle.mjs')
      saveCycleState(dir, { round: 2, progressHistory: [{ round: 1, delta: 1 }] })
      const loaded = loadCycleState(dir)
      if (!loaded || loaded.round !== 2) return `iterate-cycle 状态未持久化：${JSON.stringify(loaded)}`

      // retro remediation Todo 进入 session-orient 池
      mkdirSync(join(dir, 'docs/todo'), { recursive: true })
      writeFileSync(join(dir, 'docs/todo/261122-retro-fix-todo.md'), [
        '---',
        'kind: todo',
        'title: Retro Fix',
        'status: active',
        'source: retro',
        'owner: arch-1',
        'created: 2026-11-22',
        'updated: 2026-11-22',
        '---',
        '',
        '# Todo: Retro Fix',
        '- [ ] C1: fix signal',
      ].join('\n'), 'utf8')
      const { buildSessionOrientation } = await import('../../kit/skills/lib/session-orient.mjs')
      const orient = buildSessionOrientation(dir)
      if (!orient.remediationTodos?.some((t) => t.includes('retro-fix'))) {
        return `session-orient 应收录 retro 治理 todo：${JSON.stringify(orient)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // === C4: per-slot verify cache / reconcile kit+go / checkDocChurnStaleness ===

  cases.push(['[C4] verify-state per-slot 缓存隔离与 cleanup 回收', async () => {
    const dir = tmpProject({ 'AGENTS.md': makeCleanAgentsMd(), 'src/core.mjs': 'export const ok = 1\n' })
    try {
      gitInit(dir)
      const vs = await import('../../kit/skills/lib/verify-state.mjs')
      const gitDir = join(dir, '.git')
      vs.writeVerifyCacheEntry(gitDir, 't-slot-1', { treeHash: 'aaa', passed: true, slotKey: 'impl-slot-a' })
      vs.writeVerifyCacheEntry(gitDir, 't-slot-1', { treeHash: 'bbb', passed: false, slotKey: 'impl-slot-b' })
      const c = vs.readVerifyCache(gitDir)
      if (!c.slots?.['impl-slot-a']?.['t-slot-1'] || !c.slots?.['impl-slot-b']?.['t-slot-1']) {
        return `per-slot 缓存未按 slotKey 隔离：${JSON.stringify(c)}`
      }
      if (c.slots['impl-slot-a']['t-slot-1'].treeHash !== 'aaa' || c.slots['impl-slot-b']['t-slot-1'].treeHash !== 'bbb') {
        return `slotA 与 slotB 缓存互相覆盖：${JSON.stringify(c.slots)}`
      }
      vs.reclaimVerifySlotCache(gitDir, 'impl-slot-a')
      const c2 = vs.readVerifyCache(gitDir)
      if (c2.slots?.['impl-slot-a']) return 'reclaimVerifySlotCache 应回收指定 slotKey 缓存'
      if (!c2.slots?.['impl-slot-b']) return 'reclaimVerifySlotCache 不应误删其他 slotKey'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[C4] reconcile 扫描 kit/ 与 Go 目录、空映射报警及 checkDocChurnStaleness 不被新建 SPEC 重置', async () => {
    const dir = tmpProject({
      'AGENTS.md': makeCleanAgentsMd(),
      'kit/skills/lib/foo.mjs': 'export const f = 1\n',
      'cmd/srv/main.go': 'package main\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{ id: 'empty-feat', name: 'Empty', modules: ['src/x.mjs'], docAnchors: [], verificationTools: [], testRefs: [] }],
      }, null, 2),
    })
    try {
      gitInit(dir)
      const rec = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', [
        'reconcile', dir, '--json',
      ], { cwd: dir })
      const parsed = JSON.parse(rec.stdout || '{}')
      const recSum = parsed.reconcileSummary ?? {}
      const unmapped = recSum.featureMapDrift?.unmappedSourceModules ?? []
      if (!unmapped.some((m) => m.startsWith('kit/')) || !unmapped.some((m) => m.startsWith('cmd/'))) {
        return `reconcile 应扫描 kit/ 与 cmd/：${JSON.stringify(unmapped)}`
      }
      if (!recSum.emptyDocAnchors?.length || !recSum.emptyToolDomains?.length || !recSum.emptyTestRefDomains?.length) {
        return `reconcile 应报告空映射域：${JSON.stringify(recSum)}`
      }

      const { isAuthoritativeEvergreenDoc } = await import('../../kit/skills/dev-govern/scripts/govern-docs.mjs')
      if (isAuthoritativeEvergreenDoc('docs/specs/261122-new-spec.md')) return '新建 SPEC 不应重置文档陈旧 churn 计数'
      if (isAuthoritativeEvergreenDoc('docs/prd/261122-new-prd.md')) return '新建 PRD 不应重置文档陈旧 churn 计数'
      if (!isAuthoritativeEvergreenDoc('docs/TDD.md') || !isAuthoritativeEvergreenDoc('AGENTS.md')) {
        return 'docs/TDD.md 与 AGENTS.md 应作为权威常青文档重置 churn'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
