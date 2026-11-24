/**
 * fixtures-parallel-dispatch.mjs —— 并行波次调度、归因路由与跨端对齐正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  critiqueContinueDoc, critiqueOverrideDoc, critiquePassDoc, critiqueRejectDoc,
  critiqueTextFingerprint, readPlanCritiqueEntrySync,
} from '../../kit/skills/lib/critique-rounds.mjs'
import { buildMultiTaskWavePlan, evaluateSliceGraph, scanUnstartedReadySlices } from '../../kit/skills/lib/doc-slice-graph.mjs'
import { checkDocRegression, extractDocSnapshot } from '../../kit/skills/lib/doc-substantive.mjs'
import { autoEscalateBlockingFindings } from '../../kit/skills/lib/escalation.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { readTaskLedger, resolveRepoRoots, updateTaskLedger } from '../../kit/skills/lib/shared.mjs'
import { formatPlanExitGate, resolveApprovalBasis } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { syncPlanPhaseToBackend } from '../../kit/skills/lib/plan-sync.mjs'
import { appendGovernSignal, readSignalsJsonl } from '../../kit/skills/lib/signals.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { determineWorkflowPolicy, evaluateNextState, validateReviewRecordClosure } from '../../kit/skills/lib/workflow-policy.mjs'
import { auditDoc, VALID_STATUS_BY_TYPE } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { approveSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { handleStatus } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { buildClusterReport } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import { syncReviewToGitHub } from '../../kit/skills/dev-review/scripts/review-sync.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

async function captureIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (c) => { out += String(c); return true }
  process.stderr.write = (c) => { err += String(c); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

function makeRichGitRepo(extraFiles = {}, { withRemote = false } = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
    '.agents/skills/dev-review/SKILL.md': '---\nname: dev-review\n---\n',
    'AGENTS.md': [
      '# demo',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      'high-risk: src/core/',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const ok = 1\n',
    ...extraFiles,
  })
  gitInit(dir, { branch: 'main', name: 'planner', email: 'planner@example.com' })
  if (withRemote) gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
  return dir
}

function makeSubstantiveSpec({
  title = 'Sample Spec', status = 'draft', approved = false, critique = 'pending',
  taskId = 'p1', issue = null, scope = ['src/a.mjs'], deps = [], relatedPrd = null,
  criteria = ['- [ ] C1: `node src/app.mjs` exits 0'], extraLines = [],
} = {}) {
  return [
    '---',
    'kind: spec',
    `title: ${title}`,
    `status: ${status}`,
    'tier: L3',
    'created: 2026-11-20',
    'updated: 2026-11-20',
    `task_id: ${taskId}`,
    ...(issue ? [`issue: ${issue}`] : []),
    'owner: planner',
    `approved: ${approved}`,
    `plan_critique: ${critique}`,
    ...(relatedPrd ? [`related_prd: ${relatedPrd}`] : []),
    ...(scope.length > 0 ? [`scope_files: [${scope.join(', ')}]`] : []),
    ...(deps.length > 0 ? [`depends_on: [${deps.join(', ')}]`] : []),
    '---',
    '',
    `# SPEC: ${title}`,
    '',
    '## 要解决的问题',
    '- 在隔离分支完成 `src/app.mjs` 功能交付并通过实证检查。',
    '',
    '## 设计方案',
    '- 修改 `src/app.mjs` 导出接口，保证 `node src/app.mjs` 退出码 0。',
    ...extraLines,
    '',
    '## 本期不做',
    '- 不引入外部第三方依赖。',
    '',
    '## 验收标准',
    '',
    ...criteria,
    '',
    '## 待拍板问题',
    '- 无',
    '',
  ].join('\n')
}

export function registerParallelDispatchCases(cases) {
  cases.push(['C1：规划隔离 --planning 与 doc-plan init --worktree 落于独立工作树，过审后同 worktree 转正且未过审常规 start 阻断', async () => {
    const dir = makeRichGitRepo()
    try {
      const roots = await resolveRepoRoots(dir)
      // 1) flow start --planning 允许在无 SPEC 时建规划工作树
      const stPlan = await captureIo(() => handleStart({
        task: 'p1', slug: 'p1', case: '4', planning: true, implementer: 'dev-a', json: true,
      }, roots))
      if (stPlan.res.exitCode !== 0) return `flow start --planning 失败：${stPlan.err}`
      const lPlan = readTaskLedger(dir, 'p1')
      if (lPlan?.status !== 'planning' || lPlan?.planning !== true) {
        return `planning 账本状态不正确：${JSON.stringify(lPlan)}`
      }
      const wtAbs = join(dir, '.worktrees', 'impl-p1')
      if (!existsSync(wtAbs)) return 'planning 模式未创建 .worktrees/impl-p1'

      // 2) 全新未过审 SPEC 常规 start（不带 --planning）必须被 exit 3 阻断
      const freshSpecRel = 'docs/specs/261120-p1-fresh-spec.md'
      mkdirSync(dirname(join(dir, freshSpecRel)), { recursive: true })
      writeFileSync(join(dir, freshSpecRel), makeSubstantiveSpec({ taskId: 'p1-fresh', status: 'draft', approved: false, critique: 'pending' }))
      const stFreshBlock = await captureIo(() => handleStart({
        task: 'p1-fresh', slug: 'p1-fresh', case: '4', spec: freshSpecRel, implementer: 'dev-a', json: true,
      }, roots))
      if (stFreshBlock.res.exitCode !== 3 || !stFreshBlock.out.includes('BLOCKED_PLAN_NOT_READY')) {
        return `未过审常规新建 start 未以 exit 3 BLOCKED_PLAN_NOT_READY 阻断：exit=${stFreshBlock.res.exitCode}, out=${stFreshBlock.out}`
      }

      // 2b) 在规划 worktree 内写入未过审 SPEC，常规 start（不带 --planning）必须被 exit 3 阻断
      const specRel = 'docs/specs/261120-p1-spec.md'
      mkdirSync(dirname(join(wtAbs, specRel)), { recursive: true })
      writeFileSync(join(wtAbs, specRel), makeSubstantiveSpec({ taskId: 'p1', status: 'draft', approved: false, critique: 'pending' }))
      await updateTaskLedger(dir, 'p1', (cur) => ({ ...cur, specFile: specRel }))
      const stBlock = await captureIo(() => handleStart({
        task: 'p1', slug: 'p1', case: '4', implementer: 'dev-a', json: true,
      }, roots))
      if (stBlock.res.exitCode !== 3 || !stBlock.out.includes('BLOCKED_PLAN_NOT_READY')) {
        return `未过审常规 start 未以 exit 3 BLOCKED_PLAN_NOT_READY 阻断：exit=${stBlock.res.exitCode}, out=${stBlock.out}`
      }

      // 3) 独立复核过审并 approve 后，再跑 flow start 同 worktree 平滑转实施态
      await critiquePassDoc({ repoRoot: wtAbs, mainRoot: dir, file: specRel, reviewer: 'critic-1', summary: 'ok', taskId: 'p1' })
      approveSpec({ repoRoot: wtAbs, mainRoot: dir, file: specRel, taskId: 'p1' })
      const stPromote = await captureIo(() => handleStart({
        task: 'p1', slug: 'p1', case: '4', implementer: 'dev-a', json: true,
      }, roots))
      if (stPromote.res.exitCode !== 0) return `过审后同 worktree 转正失败：exit=${stPromote.res.exitCode}, err=${stPromote.err}`
      const lPromoted = readTaskLedger(dir, 'p1')
      if (lPromoted?.status !== 'started' || lPromoted?.planning !== false) {
        return `转正后账本未切换为 started：${JSON.stringify(lPromoted)}`
      }

      // 4) doc-plan init --worktree 独立建隔离规划工作树，main 保持干净
      const initWt = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'p2', '--title', 'Plan P2', '--owner', 'arch-1', '--worktree', '--json',
      ], { cwd: dir })
      if (initWt.status !== 0) return `doc-plan init --worktree 失败：${initWt.stderr}`
      const initJson = JSON.parse(initWt.stdout)
      if (!initJson.worktreePath || !existsSync(join(dir, initJson.worktreePath, initJson.file))) {
        return `doc-plan init --worktree 未落盘到隔离工作树：${initWt.stdout}`
      }
      if (existsSync(join(dir, initJson.file))) return 'doc-plan init --worktree 污染了主仓 main 工作区'
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C2：plan-sync 经 TaskBackend 幂等同步不刷屏，local-only/generic-git 显式报 NOT_APPLICABLE', async () => {
    const dir = makeRichGitRepo()
    try {
      const roots = await resolveRepoRoots(dir)
      await captureIo(() => handleStart({ task: 'sync-t', slug: 'sync-t', case: '2', implementer: 'dev-a', 'no-issue': true, reason: '回归夹具聚焦 plan-sync 幂等性', json: true }, roots))

      // 1) local-only 写入本地事件日志并显式报 NOT_APPLICABLE（绝不伪造 synced: true）
      const localRes = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'init', file: 'docs/specs/x.md', taskId: 'sync-t', issueNumber: 120,
      })
      if (!localRes.ok || localRes.synced !== false || localRes.status !== 'NOT_APPLICABLE' || !localRes.notApplicable) {
        return `local-only plan-sync 未显式返回 NOT_APPLICABLE：${JSON.stringify(localRes)}`
      }
      // 2) 同 key 重复调用幂等跳过
      const dupLocal = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'init', file: 'docs/specs/x.md', taskId: 'sync-t', issueNumber: 120,
      })
      if (!dupLocal.skipped || !dupLocal.deduplicated) {
        return `重复 syncKey 未幂等跳过：${JSON.stringify(dupLocal)}`
      }

      // 3) 模拟 GitHub backend 校验评论、标签与重复键防重
      const calls = []
      const fakeGh = {
        kind: 'github',
        capabilities: { api: true, issues: true, labels: true, pr: true },
        postComment: async (args) => { calls.push(['comment', args]); return { ok: true } },
        addLabels: async (args) => { calls.push(['addLabels', args]); return { ok: true } },
        removeLabel: async (args) => { calls.push(['removeLabel', args]); return { ok: true } },
      }
      const gh1 = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'critique-reject', file: 'docs/specs/x.md',
        taskId: 'sync-t', issueNumber: 120, round: 1, backend: fakeGh, targetRepo: 'acme/demo',
      })
      if (!gh1.ok || gh1.synced !== true || !calls.some((c) => c[0] === 'addLabels' && c[1].labels.includes('changes-requested'))) {
        return `GitHub backend plan-sync 未写评论/标签：${JSON.stringify({ gh1, calls })}`
      }
      const callsBeforeDup = calls.length
      const gh2 = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, phase: 'critique-reject', file: 'docs/specs/x.md',
        taskId: 'sync-t', issueNumber: 120, round: 1, backend: fakeGh, targetRepo: 'acme/demo',
      })
      if (!gh2.skipped || calls.length !== callsBeforeDup) {
        return `GitHub backend 重复 syncKey 未拦截刷屏：${JSON.stringify(gh2)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C3：账本态 planCritique、严格白名单 SHA 校验、warnings 输出与停损后允许继续重写复核', async () => {
    const dir = makeRichGitRepo()
    try {
      const roots = await resolveRepoRoots(dir)
      await captureIo(() => handleStart({ task: 'c3-t', slug: 'c3-t', case: '4', planning: true, implementer: 'dev-a', json: true }, roots))
      const wt = join(dir, '.worktrees', 'impl-c3-t')
      const specRel = 'docs/specs/261120-c3-spec.md'
      mkdirSync(dirname(join(wt, specRel)), { recursive: true })
      const baseDoc = makeSubstantiveSpec({ taskId: 'c3-t', status: 'draft', approved: false, critique: 'pending' })
      writeFileSync(join(wt, specRel), baseDoc)

      // 1) 白名单：伪造 passed sha=aaaaaaaa 必须阻断；篡改正文后带旧真实 sha 也阻断；无 sha 历史 passed 兼容放行并带警告
      const fakeShaBasis = resolveApprovalBasis({ rel: specRel, docType: 'spec', text: baseDoc.replace('plan_critique: pending', 'plan_critique: passed (reviewer=r1, round=1, sha=aaaaaaaa)'), data: { plan_critique: 'passed (reviewer=r1, round=1, sha=aaaaaaaa)' } })
      if (fakeShaBasis.hasBasis) return `伪造 sha 竟被白名单放行：${JSON.stringify(fakeShaBasis)}`

      const legacyBasis = resolveApprovalBasis({ rel: specRel, docType: 'spec', text: baseDoc.replace('plan_critique: pending', 'plan_critique: passed'), data: { plan_critique: 'passed' } })
      if (!legacyBasis.hasBasis || legacyBasis.warning?.code !== 'WARN_CRITIQUE_LEGACY_NO_SHA') {
        return `无 sha 历史 passed 未兼容放行或缺少 WARN_CRITIQUE_LEGACY_NO_SHA：${JSON.stringify(legacyBasis)}`
      }
      const warnLines = formatPlanExitGate({ ok: true, blocked: false, warnings: [legacyBasis.warning] })
      if (!warnLines.some((l) => l.includes('WARN_CRITIQUE_LEGACY_NO_SHA'))) {
        return `formatPlanExitGate 未格式化输出 gate.warnings：${JSON.stringify(warnLines)}`
      }

      // 2) 账本写入与停损后仍可写 R4 意见，仅锁定 approve
      for (const [rnd, rev, suffix] of [[1, 'crit-1', 'v1'], [2, 'crit-2', 'v2'], [3, 'crit-3', 'v3']]) {
        const curText = baseDoc.replace('- 不引入外部第三方依赖。', `- 不引入外部第三方依赖（${suffix}）。`)
        writeFileSync(join(wt, specRel), curText)
        const rej = await critiqueRejectDoc({
          repoRoot: wt, mainRoot: dir, file: specRel, reviewer: rev, round: rnd,
          findings: ['接口签名未对齐'], summary: `r${rnd}`, taskId: 'c3-t',
        })
        if (rnd === 3 && !rej.stopLossTriggered) return `Round 3 未触发停损：${JSON.stringify(rej)}`
      }
      const fmAfterRej = readFileSync(join(wt, specRel), 'utf8')
      if (fmAfterRej.includes('critique_anchors:') || fmAfterRej.includes('critique_rounds:')) {
        return 'Frontmatter 不应再序列化 critique_anchors/critique_rounds'
      }
      const { entry } = readPlanCritiqueEntrySync({ repoRoot: wt, mainRoot: dir, taskId: 'c3-t', relDoc: specRel })
      if (!entry || entry.rounds?.length !== 3) return `ledger.planCritique 未保存 3 轮记录：${JSON.stringify(entry)}`

      // 停损后执行 critique-continue（不解锁 approve），并继续写 Round 4 critique-pass
      const cont = await critiqueContinueDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reason: '补充契约拆分后再复核', taskId: 'c3-t' })
      if (!cont.ok || cont.unlockApprove !== false) return `critique-continue 返回异常：${JSON.stringify(cont)}`

      writeFileSync(join(wt, specRel), baseDoc.replace('- 不引入外部第三方依赖。', '- 不引入外部第三方依赖（v4-revised）。'))
      const r4 = await critiquePassDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reviewer: 'crit-4', round: 4, summary: 'r4 pass', taskId: 'c3-t' })
      if (!r4.ok) return `停损后应允许继续提交 Round 4 复核：${JSON.stringify(r4)}`

      // 篡改正文 1 行 -> SHA 校验必须阻断 approve（或 resolveApprovalBasis）
      const passText = readFileSync(join(wt, specRel), 'utf8')
      const realSha = critiqueTextFingerprint(passText)
      const tampered = `${passText}\n- 额外改动未重审\n`
      const tamperedBasis = resolveApprovalBasis({ rel: specRel, docType: 'spec', text: tampered, data: { plan_critique: `passed (reviewer=crit-4, round=4, sha=${realSha})` } })
      if (tamperedBasis.hasBasis) return `篡改正文后旧 SHA 竟未阻断：${JSON.stringify(tamperedBasis)}`

      // critique-continue 不解锁 approve -> 仍触发 STOP_LOSS_ESCALATE
      let lockedByStopLoss = false
      try {
        approveSpec({ repoRoot: wt, mainRoot: dir, file: specRel, taskId: 'c3-t' })
      } catch (e) {
        lockedByStopLoss = e.code === 'STOP_LOSS_ESCALATE'
      }
      if (!lockedByStopLoss) return '停损且仅运行 critique-continue 后竟放行了 approve'

      // 无 frontmatter 文档执行 critique-override 不再静默空操作
      const noFmPath = join(wt, 'docs/specs/261120-nofm-spec.md')
      writeFileSync(noFmPath, '# No Frontmatter Spec\n\n- Status: draft\n')
      await critiqueOverrideDoc({ repoRoot: wt, mainRoot: dir, file: 'docs/specs/261120-nofm-spec.md', humanApproved: true, reason: '人工放行', taskId: 'c3-t' })
      if (!readFileSync(noFmPath, 'utf8').includes('Critique Override:')) {
        return '无 frontmatter 文档执行 critique-override 未更新文档头'
      }
      if (!VALID_STATUS_BY_TYPE.prd.has('superseded')) return 'VALID_STATUS_BY_TYPE.prd 缺少 superseded'
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4：删除 DOC_REGRESSION_ANCHOR_LOST、SPEC 超 380 行仅软警告、PRD 不限行并保留核心节删空阻断', async () => {
    const dir = makeRichGitRepo()
    try {
      const longBody = Array.from({ length: 390 }, (_, i) => `- 设计补充条目 ${i + 1}：约束 \`src/app.mjs\` 行为。`)
      const longSpecRel = 'docs/specs/261120-long-spec.md'
      mkdirSync(dirname(join(dir, longSpecRel)), { recursive: true })
      writeFileSync(join(dir, longSpecRel), makeSubstantiveSpec({ title: 'Long Spec', extraLines: longBody }))
      const audLong = auditDoc({ repoRoot: dir, file: longSpecRel })
      if (!audLong.ok) return `SPEC 超 380 行不应阻塞 audit errors：${JSON.stringify(audLong.errors)}`
      if (!audLong.warnings.some((w) => w.code === 'WARN_SPEC_BODY_LONG')) {
        return `SPEC 超 380 行缺少软警告 WARN_SPEC_BODY_LONG：${JSON.stringify(audLong.warnings)}`
      }

      const longPrdRel = 'docs/prd/261120-long-prd.md'
      mkdirSync(dirname(join(dir, longPrdRel)), { recursive: true })
      writeFileSync(join(dir, longPrdRel), [
        '---', 'kind: prd', 'title: Long PRD', 'status: active', 'plan_critique: passed', 'created: 2026-11-20', 'updated: 2026-11-20', 'owner: p', '---',
        '# PRD: Long', '', '## 要解决的问题', '- 统一主干能力 `src/app.mjs`。', '',
        '## 本期不做', '- 不改外部接口。', '', '## 验收标准', '- [ ] C1: `node src/app.mjs` 退出 0', '',
        ...longBody,
      ].join('\n'))
      const audPrd = auditDoc({ repoRoot: dir, file: longPrdRel })
      if (!audPrd.ok || audPrd.warnings.some((w) => w.code === 'WARN_SPEC_BODY_LONG')) {
        return `PRD 不应触发行数限制或警告：${JSON.stringify(audPrd)}`
      }

      // 跨轮防退化：删空核心节仍阻断 DOC_REGRESSION_CORE_EMPTIED，精简锚点不报 DOC_REGRESSION_ANCHOR_LOST
      const baseText = makeSubstantiveSpec({ title: 'Base' })
      const emptiedText = baseText.replace(/## 设计方案[\s\S]*?(?=## 本期不做)/, '')
      const emptiedRes = checkDocRegression(extractDocSnapshot(baseText), extractDocSnapshot(emptiedText))
      if (emptiedRes.errors.length === 0 || !emptiedRes.errors.some((e) => e.code === 'DOC_REGRESSION_CORE_EMPTIED')) {
        return `核心节删空未报 DOC_REGRESSION_CORE_EMPTIED：${JSON.stringify(emptiedRes)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C5：flow status --all 聚合看板与 handoff-package 注入 mustFix/blockers、scope_files 与 5 行回执骨架', async () => {
    const dir = makeRichGitRepo()
    try {
      const roots = await resolveRepoRoots(dir)
      const specRel = 'docs/specs/261120-c5-spec.md'
      mkdirSync(dirname(join(dir, specRel)), { recursive: true })
      const specDoc = [
        '---', 'kind: spec', 'title: Handoff Demo', 'status: approved', 'tier: L3',
        'created: 2026-11-20', 'updated: 2026-11-20', 'task_id: c5-t', 'owner: planner',
        'approved: true', 'plan_critique: passed', 'scope_files: [src/custom-scope.mjs]', '---', '',
        '# SPEC: Handoff Demo', '',
        '## 一、目标与非目标', '', '- **目标**：实现核心分发逻辑。', '- **非目标**：不引入数据库服务。', '',
        '## 接口契约', '', '- 修改 `src/app.mjs` 导出 `run()`。', '',
        '## 验收标准', '', '- [ ] C1: `node src/app.mjs` exits 0', '',
      ].join('\n')
      writeFileSync(join(dir, specRel), specDoc)
      gitCommitFast(dir, 'docs: add c5 spec', { files: [specRel], name: 'planner', email: 'planner@example.com' })

      const stAll = await captureIo(() => handleStatus({ all: true, json: true }, roots))
      if (stAll.res.exitCode !== 0 || !stAll.res.payload?.all || !stAll.res.payload?.capabilities) {
        return `flow status --all 输出异常：${JSON.stringify(stAll)}`
      }

      const ledger = {
        taskId: 'c5-t', specFile: specRel, ownerRole: 'implementer',
        rounds: [{ round: 1, verdict: 'changes', mustFix: [{ id: 'MF-1', summary: '修复边界空指针' }], blockers: ['缺少单测'] }],
      }
      const ho = buildHandoff({ mainRoot: dir, ledger, ownerRole: 'implementer' })
      if (!ho.fields.paths.includes('src/custom-scope.mjs')) return `未合并 scope_files：${JSON.stringify(ho.fields.paths)}`
      if (!ho.fields.design.includes('src/app.mjs')) return `未抽取「接口契约」章节：${ho.fields.design}`
      if (ho.fields.nonGoals.some((g) => g.includes('实现核心分发逻辑')) || !ho.fields.nonGoals.some((g) => g.includes('数据库'))) {
        return `extractNonGoals 误吞了目标或漏了非目标：${JSON.stringify(ho.fields.nonGoals)}`
      }
      if (!ho.prompt.includes('修复边界空指针') || !ho.prompt.includes('缺少单测') || (ho.fields.reworkFeedback?.totalCount ?? 0) < 2) {
        return `返工意见未注入 mustFix/blockers：${ho.prompt}`
      }
      if (!ho.fields.receiptTemplate?.includes('conclusion:') || !ho.prompt.includes('<= 15 行')) {
        return `缺少 5 行回执模板或 15 行约束：${ho.prompt}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C6：doc-slice-graph 单源调度禁止未就绪 draft 前置进 Wave 1，写域重叠按 serial-by-overlap 拆波且 needs-* 暴露并行计划', async () => {
    const dir = makeRichGitRepo({ 'src/a.mjs': 'export const a = 1\n', 'src/b.mjs': 'export const b = 1\n' })
    try {
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      writeFileSync(join(dir, 'docs/prd/261120-m-prd.md'), [
        '---', 'kind: prd', 'title: Master', 'status: active', 'created: 2026-11-20', 'updated: 2026-11-20',
        'owner: p', 'plan_critique: passed', 'multi_spec: true', '---', '', '# PRD', '',
        '## 要解决的问题', '- 多切片。', '', '## 本期不做', '- 无。', '',
        '## 验收标准', '- [ ] C1: a', '- [ ] C2: b', '- [ ] C3: c', '',
      ].join('\n'))
      // s1 与 s2 均已 approved 且写域重叠（serial-by-overlap）；s3 为 approved 但依赖未就绪的 s0(draft)
      writeFileSync(join(dir, 'docs/specs/261120-issue1-s0-spec.md'), makeSubstantiveSpec({
        taskId: 's0', issue: 1, status: 'draft', approved: false, critique: 'pending',
        relatedPrd: '../prd/261120-m-prd.md', scope: ['src/b.mjs'], criteria: ['- [ ] C3: c'],
      }))
      writeFileSync(join(dir, 'docs/specs/261120-issue2-s1-spec.md'), makeSubstantiveSpec({
        taskId: 's1', issue: 2, status: 'approved', approved: true, critique: 'passed',
        relatedPrd: '../prd/261120-m-prd.md', scope: ['src/a.mjs'], criteria: ['- [ ] C1: a'],
      }))
      writeFileSync(join(dir, 'docs/specs/261120-issue3-s2-spec.md'), makeSubstantiveSpec({
        taskId: 's2', issue: 3, status: 'approved', approved: true, critique: 'passed',
        relatedPrd: '../prd/261120-m-prd.md', scope: ['src/a.mjs'], criteria: ['- [ ] C2: b'],
      }))
      writeFileSync(join(dir, 'docs/specs/261120-issue4-s3-spec.md'), makeSubstantiveSpec({
        taskId: 's3', issue: 4, status: 'approved', approved: true, critique: 'passed',
        relatedPrd: '../prd/261120-m-prd.md', scope: ['src/b.mjs'], deps: ['s0'], criteria: ['- [ ] C3: c'],
      }))

      const graphEval = evaluateSliceGraph(dir)
      if (graphEval.errors.some((e) => e.code === 'BLOCKED_SLICE_OVERLAP')) {
        return `写域重叠仍误抛 BLOCKED_SLICE_OVERLAP：${JSON.stringify(graphEval.errors)}`
      }
      if (!graphEval.warnings.some((w) => w.code === 'SLICE_SERIAL_BY_OVERLAP' && w.serialReason === 'serial-by-overlap')) {
        return `缺少 SLICE_SERIAL_BY_OVERLAP 告警：${JSON.stringify(graphEval.warnings)}`
      }

      const readySlices = scanUnstartedReadySlices(dir, [])
      const wavePlan = buildMultiTaskWavePlan([...readySlices])
      const wave1Ids = (wavePlan.waves[0]?.tasks ?? []).map((t) => t.taskId)
      if (wave1Ids.includes('s3')) {
        return `依赖未就绪 draft(s0) 的 s3 竟混入 Wave 1：${JSON.stringify(wavePlan)}`
      }
      if (!wavePlan.waves.some((w) => w.tasks.some((t) => t.taskId === 's2' && t.serialReason === 'serial-by-overlap'))) {
        return `重叠切片 s2 未按 serial-by-overlap 拆波：${JSON.stringify(wavePlan.waves)}`
      }
      // needs-* 阶段仍暴露多切片并行可见性
      const ev = evaluateNextState({
        activeTasks: [{ taskId: 's1', status: 'claimed', claimedAt: '2026-11-20T00:00:00Z', worktreePath: '.worktrees/impl-s1' }],
        selectedTask: { taskId: 's1', status: 'claimed', claimedAt: '2026-11-20T00:00:00Z', finalized: true, finalizedHead: 'abc', worktreePath: '.worktrees/impl-s1' },
        taskRuntime: { dirty: 0, headSha: 'abc', commitsAheadOfBase: 1, evidenceValidation: { ok: false }, policy: determineWorkflowPolicy({ changedFiles: [], caseType: 2 }), profile: {} },
        repoRoot: dir,
      })
      if (!ev.readySlices || !ev.waves) return `needs-* 状态未暴露 readySlices/waves：${JSON.stringify(ev)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C7a：外部 PR 受理、SPEC issue 继承、merge/review-sync 逐条 try/catch 记账本与 review-pack record 强校', async () => {
    const dir = makeRichGitRepo({ 'src/x.mjs': 'export const x = 1\n' }, { withRemote: true })
    try {
      // 1) validateReviewRecordClosure 拦截缺 recordedAt/reviewEvidence 的伪造 PASS
      const badClosure = validateReviewRecordClosure({
        ledger: { rounds: [{ round: 1, verdict: 'pass', blockers: [] }], reviewTokens: [{ round: 1, token: 'tok-bad', consumedAt: '2026-11-20T00:00:00Z' }] },
        lastRound: { round: 1, verdict: 'pass', blockers: [] },
        policy: { independentReviewRequired: true, riskTier: 'high' },
      })
      if (badClosure.ok || badClosure.code !== 'BLOCKED_REVIEW_NOT_PASSED') {
        return `缺少 review-pack record 实证记录的 PASS 竟通过闭包强校：${JSON.stringify(badClosure)}`
      }
      const goodClosure = validateReviewRecordClosure({
        ledger: {
          rounds: [{ round: 1, verdict: 'pass', blockers: [], reviewEvidence: 'ok', recordedAt: '2026-11-20T00:00:00Z' }],
          reviewTokens: [{ round: 1, token: 'tok-1', consumedAt: '2026-11-20T00:00:00Z' }],
        },
        lastRound: { round: 1, verdict: 'pass', blockers: [], reviewEvidence: 'ok', recordedAt: '2026-11-20T00:00:00Z' },
        policy: { independentReviewRequired: true, riskTier: 'high' },
      })
      if (!goodClosure.ok) return `合规 record 却未通过 closure：${JSON.stringify(goodClosure)}`

      // 2) review-sync 部分目标失败不能再用 .some() 吞掉
      const partialSync = await syncReviewToGitHub({
        mainRoot: dir, workTreeRoot: dir,
        ledger: { taskId: 'r-sync', role: 'local-only', linkedIssues: [1, 2], reviewPassed: true, status: 'in-review', rounds: [] },
        round: 1, verdict: 'pass', headSha: 'abc1234', reviewerId: 'rev-1', implementerId: 'dev-1',
        empiricalSummary: 'ok', stopLoss: false, stopReasons: [], mustFixList: [], shouldFixList: [],
        preExistingList: [], rebuttedItems: [], resolvedItems: [], nextSteps: [], opts: {},
      })
      if (!Array.isArray(partialSync.syncFailures)) return `review-sync 缺少 syncFailures 数组：${JSON.stringify(partialSync)}`

      // 3) SPEC issue: 继承到 ledger.linkedIssues，且 merge 部分写回失败写入 ledger.syncFailures
      const specRel = 'docs/specs/261120-c7-spec.md'
      mkdirSync(dirname(join(dir, specRel)), { recursive: true })
      writeFileSync(join(dir, specRel), makeSubstantiveSpec({
        taskId: 'c7-t', issue: 120, status: 'approved', approved: true, critique: 'passed',
      }))
      gitCommitFast(dir, 'docs: add c7 spec', { files: [specRel], name: 'p', email: 'p@example.com' })
      const roots = await resolveRepoRoots(dir)
      const st = await captureIo(() => handleStart({
        task: 'c7-t', slug: 'c7-t', case: '4', spec: specRel, implementer: 'dev-a', json: true,
        _ghClient: { tier: 'direct', getIssue: async () => ({ ok: true, issue: { number: 120, title: 'x', body: '', state: 'OPEN' } }) },
      }, roots))
      if (st.res.exitCode !== 0) return `start 失败：${st.err}`
      const lStart = readTaskLedger(dir, 'c7-t')
      if (!lStart?.linkedIssues?.includes(120)) return `未继承 SPEC issue 120：${JSON.stringify(lStart?.linkedIssues)}`

      // 模拟 merge 时 Issue #101 失败、Issue #102 成功：try/catch 不中断，且 ledger.syncFailures 记入失败项
      const wtC7 = join(dir, '.worktrees', 'impl-c7-t')
      writeFileSync(join(wtC7, 'src/x.mjs'), 'export const x = 2\n')
      gitSync(wtC7, ['add', '-A'])
      gitSync(wtC7, ['commit', '-qm', 'feat: c7 change'])
      const wtHeadC7 = gitSync(wtC7, ['rev-parse', 'HEAD'], { stdio: 'pipe' }).stdout.trim()
      await captureIo(() => handleClaim({ task: 'c7-t', agent: 'dev-a' }, roots))
      await seedExploredFor(dir, 'c7-t')
      await captureIo(() => handleVerify({ task: 'c7-t', mode: 'gate', 'e2e-evidence': 'e2e pass' }, roots))
      await updateTaskLedger(dir, 'c7-t', (cur) => ({
        ...cur,
        role: 'maintainer',
        providerId: 'github',
        linkedIssues: [101, 102],
        prNumber: 55,
        finalized: true,
        finalizedHead: wtHeadC7,
        verifiedHead: wtHeadC7,
        lastVerifyExitCode: 0,
        reviewTokens: [{ round: 1, token: 'tok-c7', consumedAt: '2026-11-20T00:00:00Z' }],
        rounds: [{ round: 1, verdict: 'pass', reviewerId: 'rev-c7', headSha: wtHeadC7, blockers: [], recordedAt: '2026-11-20T00:00:00Z', reviewEvidence: 'pass' }],
        reviewPassed: true,
        reviewPassedHead: wtHeadC7,
      }))
      const mockClient = {
        tier: 'direct',
        postComment: async ({ number }) => {
          if (number === 101) throw new Error('issue 101 forbidden')
          return { ok: true }
        },
        removeLabel: async () => ({ ok: true }),
        listComments: async () => ({ ok: true, comments: [] }),
        closeIssue: async () => ({ ok: true }),
        getPr: async () => ({ ok: true, pr: { number: 55, state: 'MERGED', merged: true, headRefOid: wtHeadC7, mergeCommit: { oid: wtHeadC7 }, baseRefName: 'main', headRefName: lStart.branch } }),
        getCommitChecks: async () => ({ ok: true, bucket: 'pass', failed: [], pending: [] }),
        mergePr: async () => ({ ok: true, merged: true, sha: wtHeadC7 }),
      }
      const mRes = await captureIo(() => handleMerge({ task: 'c7-t', _ghClient: mockClient, _ghProbe: { client: mockClient, env: { trackB: { tier: 'direct' } } }, json: true }, roots))
      const lAfterMerge = readTaskLedger(dir, 'c7-t')
      if (!Array.isArray(lAfterMerge?.syncFailures) || lAfterMerge.syncFailures.length === 0 || !lAfterMerge.mergeComments?.some((c) => c.target === 'Issue #102' && c.ok)) {
        return `merge 多目标 try/catch 未持久化 syncFailures 或中断了后续 Issue #102：exit=${mRes.res.exitCode}, err=${mRes.err}, res=${mRes.out}, syncFailures=${JSON.stringify(lAfterMerge?.syncFailures)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C7b：escalation 默认建单与 --no-escalate --reason 校验、signals 工作位隔离与 buildClusterReport 仅聚 severity >= medium 真实故障', async () => {
    const dir = makeRichGitRepo()
    try {
      // 1) --no-escalate 缺 --reason 拒绝，带 --reason 放行；默认 local-only 自动写入本地工单
      const badSkip = await autoEscalateBlockingFindings({ repoRoot: dir, noEscalate: true, noEscalateReason: '', item: { title: 'x' } })
      if (badSkip.ok || badSkip.code !== 'MISSING_NO_ESCALATE_REASON') return `缺原因竟放行 --no-escalate：${JSON.stringify(badSkip)}`
      const okSkip = await autoEscalateBlockingFindings({ repoRoot: dir, noEscalate: true, noEscalateReason: '误报已手动追踪', item: { title: 'x' } })
      if (!okSkip.ok || !okSkip.skipped) return `合法 --no-escalate 未跳过：${JSON.stringify(okSkip)}`
      const autoLocal = await autoEscalateBlockingFindings({
        repoRoot: dir,
        item: {
          source: 'review',
          outOfScope: true,
          severity: 'high',
          title: 'out-of-scope defect',
          summary: 'fix elsewhere',
          files: ['src/core/a.mjs'],
          reproEvidence: 'src/core/a.mjs:12 out-of-scope high finding',
          pocCommand: 'node -e "process.exit(1)"',
          taskId: 'c7b',
        },
      })
      if (!autoLocal.ok || !autoLocal.local || !autoLocal.number) return `local-only 默认自动建单失败：${JSON.stringify(autoLocal)}`

      // 2) signals.jsonl 按 branch/worktree 隔离 + buildClusterReport 过滤 info/*.pass/.md
      const roots = await resolveRepoRoots(dir)
      await appendGovernSignal({
        mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        category: 'verify', pattern: 'verify.pass', severity: 'medium',
        file: 'src/core/a.mjs', taskId: 't-a', branch: 'feat/a', worktree: '.worktrees/impl-a', message: 'ok',
      })
      await appendGovernSignal({
        mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        category: 'verify', pattern: 'verify.fail', severity: 'high',
        file: 'src/core/a.mjs', taskId: 't-a', branch: 'feat/a', worktree: '.worktrees/impl-a', message: 'boom',
      })
      await appendGovernSignal({
        mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        category: 'verify', pattern: 'verify.fail', severity: 'medium',
        file: 'src/core/b.mjs', taskId: 't-b', branch: 'feat/b', worktree: '.worktrees/impl-b', message: 'boom-b',
      })

      const scopedA = readSignalsJsonl(roots, { branch: 'feat/a', worktree: '.worktrees/impl-a' })
      if (scopedA.events.length !== 2 || scopedA.events.some((e) => e.taskId === 't-b')) {
        return `signals 工作位隔离过滤失败：${JSON.stringify(scopedA.events)}`
      }
      const allSig = readSignalsJsonl(roots)
      const report = buildClusterReport(allSig.events, [])
      if (report.signalEvents !== 2 || report.clusters.some((c) => c.pattern === 'verify.pass' || c.key.includes('.md'))) {
        return `buildClusterReport 未过滤 info/*.pass/.md 噪音：${JSON.stringify(report)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
