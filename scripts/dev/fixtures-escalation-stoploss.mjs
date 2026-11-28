/**
 * fixtures-escalation-stoploss.mjs —— 分级升级、停损闭环与总控四态收口双向断言。
 */

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { handleBatch } from '../../kit/skills/dev-flow/scripts/flow-batch.mjs'
import { handleStart, inspectWorkspace } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleIssue, handleMilestone } from '../../kit/skills/dev-flow/scripts/flow-issues.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleSync } from '../../kit/skills/dev-flow/scripts/flow-sync.mjs'
import { runTrialMerge } from '../../kit/skills/dev-flow/scripts/flow-trial-merge.mjs'
import { applyIssuesToBackend } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import { auditDoc, auditRepoDocs, runCli as runDocPlanCli } from '../../kit/skills/dev-plan/scripts/doc-plan.mjs'
import { parseAcceptanceCriteria } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { handleRecord as handleReviewRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { runCli as runReviewPackCli } from '../../kit/skills/dev-review/scripts/review-pack.mjs'
import { evaluateMasterPrdClosureState } from '../../kit/skills/lib/doc-substantive.mjs'
import { parseDocFrontmatter, syncDocsLifecycle } from '../../kit/skills/lib/docs.mjs'
import {
  buildEscalationIssuePayload, classifyEscalationTier, escalateToBackend, formatWorkTitle, workTypePrefix,
} from '../../kit/skills/lib/escalation.mjs'
import { gitRun, resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readTaskLedger, updateTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { createLocalIssue, getLocalIssue } from '../../kit/skills/lib/local-issues.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { equip } from '../equip.mjs'
import {
  gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  let out = ''
  let err = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
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

export function registerStageBLoopB4bCases(cases) {
  cases.push(['C11：纯调度扫描就绪 docs/specs、Depends on、缺写域保守串行与 parallelDispatch', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c11\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/a.mjs': 'export const a = 1\n',
      'src/b.mjs': 'export const b = 1\n',
      'src/c.mjs': 'export const c = 1\n',
      'docs/specs/261118-issue11-a-spec.md': [
        '---', 'kind: spec', 'title: "A"', 'status: approved', 'tier: L3', 'issue: 11',
        'owner: planner', 'approved: true', 'plan_critique: passed', '---', '',
        '# SPEC: A', '', '## 影响路径', '- `src/a.mjs`', '', '## 验收标准', '- [ ] C1: `src/a.mjs` ok', '',
      ].join('\n'),
      'docs/specs/261118-issue12-b-spec.md': [
        '---', 'kind: spec', 'title: "B"', 'status: approved', 'tier: L3', 'issue: 12',
        'owner: planner', 'approved: true', 'plan_critique: passed', '---', '',
        '# SPEC: B', '', '## 影响路径', '- `src/b.mjs`', '', '## 验收标准', '- [ ] C1: `src/b.mjs` ok', '',
      ].join('\n'),
      'docs/specs/261118-issue13-c-spec.md': [
        '---', 'kind: spec', 'title: "C"', 'status: approved', 'tier: L3', 'issue: 13',
        'owner: planner', 'approved: true', 'plan_critique: passed', '---', '',
        '# SPEC: C', '', 'Depends on #11', '', '## 影响路径', '- `src/c.mjs`', '', '## 验收标准', '- [ ] C1: `src/c.mjs` ok', '',
      ].join('\n'),
      'docs/specs/261118-issue14-nowrite-spec.md': [
        '---', 'kind: spec', 'title: "D"', 'status: approved', 'tier: L3', 'issue: 14',
        'owner: planner', 'approved: true', 'plan_critique: passed', '---', '',
        '# SPEC: D', '', '## 验收标准', '- [ ] C1: 无写域说明保守串行', '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const roots = await resolveRepoRoots(dir)
      const nxt = await withQuietIo(() => handleNext({ json: true }, roots))
      const payload = JSON.parse(nxt.out)
      if (payload.phase !== 'idle' || payload.parallelDispatch !== true) {
        return `idle 未识别并行就绪波次：${nxt.out}`
      }
      const w1 = payload.wavePlan?.parallelizable ?? []
      if (!w1.includes('issue-11') || !w1.includes('issue-12') || w1.includes('issue-13') || w1.includes('issue-14')) {
        return `Wave 1 依赖或保守串行过滤有误：${JSON.stringify(payload.wavePlan)}`
      }
      if (!String(payload.command ?? '').includes('batch plan')) {
        return `Wave 1 >= 2 却折叠为单任务指令：${payload.command}`
      }
      const textNxt = await withQuietIo(() => handleNext({}, roots))
      const stepHeaders = textNxt.out.match(/\[NEXT STEP\]/g) ?? []
      if (stepHeaders.length !== 1) return `next 文本模式应严格输出单一 [NEXT STEP]，实际：${stepHeaders.length}\n${textNxt.out}`

      const bat = await withQuietIo(() => handleBatch({ _: ['plan'], json: true }, roots))
      const batJson = JSON.parse(bat.out)
      if (bat.res.exitCode !== 0 || batJson.parallelDispatch !== true || batJson.readySlicesCount !== 4) {
        return `batch plan 未输出 readySlicesCount/parallelDispatch：${bat.out}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C12：escalation.mjs 统一分级建单、前缀规范与远端 probeForWrite 接入', async () => {
    const inlineDec = classifyEscalationTier({ severity: 'medium', caseType: 2, files: ['src/a.mjs'], doorType: 'two-way', recurrenceCount: 1 })
    if (inlineDec !== 'inline-todo') return `单文件非复发 medium 应归入 Todo：${inlineDec}`

    for (const [label, item] of [
      ['critical', { severity: 'critical', files: ['src/a.mjs'] }],
      ['high', { severity: 'high', files: ['src/a.mjs'] }],
      ['multi-file', { severity: 'medium', files: ['src/a.mjs', 'src/b.mjs'] }],
      ['case3', { severity: 'low', caseType: 3, files: ['src/a.mjs'] }],
      ['one-way', { severity: 'low', doorType: 'one-way', files: ['src/a.mjs'] }],
      ['recurrence', { severity: 'low', recurrenceCount: 2, files: ['src/a.mjs'] }],
      ['e2e', { severity: 'low', e2eBlocking: true, files: ['src/a.mjs'] }],
    ]) {
      const dec = classifyEscalationTier(item)
      if (dec !== 'escalated-issue') return `${label} 未升级为 escalated-issue：${dec}`
    }

    if (workTypePrefix(1) !== 'docs' || workTypePrefix(2) !== 'fix' || workTypePrefix(3) !== 'feat') {
      return `workTypePrefix 异常：${workTypePrefix(1)},${workTypePrefix(2)},${workTypePrefix(3)}`
    }
    if (formatWorkTitle('typo', 1) !== 'docs: typo' || formatWorkTitle('refactor: clean', 2) !== 'refactor: clean') {
      return `formatWorkTitle 未尊重默认或显式前缀`
    }

    const dir = tmpProject({ '.gitignore': '.worktrees/\n', 'README.md': '# c12\n' })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const escPayload = buildEscalationIssuePayload({
        title: '空值崩', caseType: 2, severity: 'high', files: ['src/a.mjs', 'src/b.mjs'],
        criteria: ['C1: 补边界检查'], rootCause: '缺少空值守卫', nextStep: 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage',
      })
      if (!escPayload.title.startsWith('fix: ') || !escPayload.body.includes('C1:') || !escPayload.body.includes('[NEXT STEP]')) {
        return `buildEscalationIssuePayload 结构缺失：${JSON.stringify(escPayload)}`
      }
      const inlineSkip = await escalateToBackend({ repoRoot: dir, item: { title: '单文件小修', caseType: 2, severity: 'low', files: ['src/a.mjs'] } })
      if (!inlineSkip.ok || !inlineSkip.skipped || inlineSkip.tier !== 'inline-todo') {
        return `单文件低风险不应建追踪单：${JSON.stringify(inlineSkip)}`
      }
      const locRes = await escalateToBackend({ repoRoot: dir, item: { title: '跨模块升级', caseType: 4, severity: 'high', files: ['src/a.mjs', 'src/b.mjs'] } })
      if (!locRes.ok || locRes.tier !== 'escalated-issue' || !locRes.local || !locRes.number) {
        return `local-only escalateToBackend 失败：${JSON.stringify(locRes)}`
      }
      const govApply = await applyIssuesToBackend(dir, [{
        title: '治理想单',
        summary: '`README.md:1` 需要同步治理想单结构',
        files: ['README.md'],
        severity: 'medium',
        reproEvidence: 'README.md:1 governance check finding',
        pocCommand: 'node -e "process.exit(0)"',
        criteria: ['C1: 修复 `README.md` 治理想单检查'],
        labels: ['governance'],
      }])
      if (!govApply.applied?.length || govApply.applied[0].local !== true) {
        return `govern-state applyIssuesToBackend 建单异常：${JSON.stringify(govApply)}`
      }

      // 远端模式经 probeForWrite 建单
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/esc-demo.git'])
      const remoteCreated = []
      const fakeProbe = {
        env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } },
        client: {
          tier: 'node-https-token',
          async createIssue(args) { remoteCreated.push(args); return { ok: true, number: 401, url: 'https://github.com/acme/esc-demo/issues/401' } },
          async postComment() { return { ok: true } },
          async addLabels() { return { ok: true } },
        },
      }
      const remRes = await escalateToBackend({
        repoRoot: dir,
        item: { title: '高危停损升级', caseType: 4, severity: 'critical', files: ['src/a.mjs'] },
        _ghProbe: fakeProbe,
        _ghClient: fakeProbe.client,
      })
      if (!remRes.ok || remRes.number !== 401 || !remoteCreated[0]?.title?.startsWith('feat: ')) {
        return `远端 escalateToBackend 建单异常：${JSON.stringify(remRes)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C13/C22：全历史换人锁、excludedReviewers、stopLossPacket、low 可选 record、切片 C* 与 faultRecord', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c13\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: exit 0\nmerge-gate: exit 0\nhigh-risk: src/app.mjs\n```\n',
      'src/app.mjs': 'export const x = 1\n',
      'docs/notes.md': '# notes\n',
      'docs/prd/261118-master-prd.md': '---\nkind: prd\ntitle: "M"\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-18\nowner: p\nrelated_spec: null\nrelated_todo: null\n---\n\n# M\n\n## 五、验收标准\n- [ ] C1: S1\n- [ ] C9: Future\n',
      'docs/specs/261118-issue21-s1-spec.md': '---\nkind: spec\ntitle: "S1"\nstatus: approved\ntier: L3\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 21\nowner: p\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261118-master-prd.md\nrelated_todo: null\n---\n\n# S1\n\n## 要解决的问题\n- a\n\n## 本期不做\n- b\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C1: slice item\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      equip(dir, { tier: 'full', noBackup: true })
      gitSync(dir, ['add', '.agents']); gitCommitFast(dir, 'chore: equip')
      const roots = await resolveRepoRoots(dir)
      const criteria = parseAcceptanceCriteria(dir, dir, {
        specFile: 'docs/specs/261118-issue21-s1-spec.md',
        prdFile: 'docs/prd/261118-master-prd.md',
      })
      if (criteria.some((c) => c.id === 'C9') || !criteria.some((c) => c.id === 'C1')) {
        return `parseAcceptanceCriteria 误拉总控 PRD C9：${JSON.stringify(criteria)}`
      }

      const st = await withQuietIo(() => handleStart({ task: 'c13-t', case: '3', slug: 'c13-t', implementer: 'alice', 'allow-plan-bootstrap': true }, roots))
      if (st.res.exitCode !== 0) return `start 失败：${st.res.exitCode}`
      await withQuietIo(() => handleClaim({ task: 'c13-t', agent: 'alice' }, roots))
      const wt = join(dir, readTaskLedger(dir, 'c13-t').worktreePath)
      writeFileSync(join(wt, 'src/app.mjs'), 'export const x = 2\n')
      gitCommitFast(wt, 'feat: v2', { updateOnly: true })
      await seedExploredFor(dir, 'c13-t')
      await withQuietIo(() => handleVerify({ task: 'c13-t', mode: 'gate' }, roots))

      const r1 = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '1', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'Rev-A',
        'review-token': undefined,
      }, roots))
      // 无令牌先拿正规 token
      const tok1 = await issueTokenFor(dir, 'c13-t', 1)
      const r1Ok = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '1', verdict: 'changes', evidence: 'ok', 'reviewer-id': '@Rev-A',
        'must-fix': ['C1: src/app.mjs:1 第一轮问题'], 'review-token': tok1,
      }, roots))
      if (r1.res !== EXIT.FACT || r1Ok.res !== 0) return `token/R1 异常：${r1.res}/${r1Ok.res}`

      writeFileSync(join(wt, 'src/app.mjs'), 'export const x = 3\n')
      gitCommitFast(wt, 'fix: v3', { updateOnly: true })
      await withQuietIo(() => handleVerify({ task: 'c13-t', mode: 'gate' }, roots))

      const sameR2 = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '2', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'rev-a',
        'must-fix': ['C2: src/app.mjs:1 新问题'], 'review-token': undefined,
      }, roots))
      if (sameR2.res !== EXIT.FACT || !sameR2.err.includes('BLOCKED_SAME_REVIEWER_REREVIEW')) {
        return `R2 复用 @Rev-A 未被拦截：exit=${sameR2.res}, err=${sameR2.err}`
      }

      const r2Ok = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '2', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'rev-b',
        'must-fix': ['C2: src/app.mjs:1 新问题'], 'review-token': '',
      }, roots))
      // 用正式 token
      void r2Ok
      const tok2 = await issueTokenFor(dir, 'c13-t', 2)
      const r2Pass = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '2', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'rev-b',
        'must-fix': ['C2: src/app.mjs:1 新问题'], 'review-token': tok2,
      }, roots))
      if (r2Pass.res !== 0) return `R2 换人 rev-b 失败：${r2Pass.err}`

      const nxt = await withQuietIo(() => handleNext({ task: 'c13-t', json: true }, roots))
      const nxtObj = JSON.parse(nxt.out)
      if (!nxtObj.excludedReviewers?.includes('@Rev-A') || !nxtObj.excludedReviewers?.includes('rev-b')) {
        return `flow next 未输出 excludedReviewers：${nxt.out}`
      }

      writeFileSync(join(wt, 'src/app.mjs'), 'export const x = 4\n')
      gitCommitFast(wt, 'fix: v4', { updateOnly: true })
      await withQuietIo(() => handleVerify({ task: 'c13-t', mode: 'gate' }, roots))

      // Round 3 复用历史 Round 1 审稿人必须被全历史换人锁拦截
      const tok3 = await issueTokenFor(dir, 'c13-t', 3)
      const reuseR1 = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '3', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'rev-a',
        'must-fix': ['C3: src/app.mjs:1 三轮问题'], 'review-token': tok3,
      }, roots))
      if (reuseR1.res !== EXIT.FACT || !reuseR1.err.includes('BLOCKED_SAME_REVIEWER_REREVIEW')) {
        return `R3 复用历史 R1 rev-a 未被全历史锁拦截：exit=${reuseR1.res}, err=${reuseR1.err}`
      }

      // check-fault --phase restore 自动写 faultRecord 到 ledger
      const faultCmd = 'node -e "const fs=require(\'fs\'); process.exit(fs.readFileSync(\'src/app.mjs\',\'utf8\').includes(\'FAULT_BREAK\')?1:0)"'
      await withQuietIo(() => runReviewPackCli(['--task', 'c13-t', '--dir', dir, '--json']))
      const revSlotAbs = join(dir, readTaskLedger(dir, 'c13-t').reviewWorktreePath)
      await withQuietIo(() => runReviewPackCli(['check-empirical', '--task', 'c13-t', '--dir', dir, '--cmd', faultCmd, '--json']))
      const origRevApp = readFileSync(join(revSlotAbs, 'src/app.mjs'), 'utf8')
      writeFileSync(join(revSlotAbs, 'src/app.mjs'), `${origRevApp}export const faultBreak = 'FAULT_BREAK'\n`)
      await withQuietIo(() => runReviewPackCli(['check-fault', '--phase', 'fail', '--task', 'c13-t', '--dir', dir, '--cmd', faultCmd, '--json']))
      writeFileSync(join(revSlotAbs, 'src/app.mjs'), origRevApp)
      await withQuietIo(() => runReviewPackCli(['check-fault', '--phase', 'restore', '--task', 'c13-t', '--dir', dir, '--cmd', faultCmd, '--json']))
      const lgWithFault = readTaskLedger(dir, 'c13-t')
      if (!lgWithFault.faultRecord?.restoredAt || !lgWithFault.faultRecord.failedExitCode) {
        return `check-fault --phase restore 未写入 faultRecord：${JSON.stringify(lgWithFault.faultRecord)}`
      }

      // R3 rev-c 触发 STOP_LOSS_ESCALATE + stopLossPacket + 自动升级建单
      const r3Stop = await withQuietIo(() => handleReviewRecord({
        task: 'c13-t', round: '3', verdict: 'changes', evidence: 'ok', 'reviewer-id': 'rev-c',
        'must-fix': ['C3: src/app.mjs:1 三轮问题'], 'review-token': tok3, json: true,
      }, roots))
      if (r3Stop.res !== 4) return `R3 rev-c 未触发 STOP_LOSS_ESCALATE：exit=${r3Stop.res}`
      const stopJson = JSON.parse(r3Stop.out)
      if (!stopJson.stopLossPacket?.hotspotFiles?.includes('src/app.mjs') || !stopJson.escalatedIssue?.ok) {
        return `停损缺少 stopLossPacket 或 escalation：${r3Stop.out}`
      }

      // C22③: low 风险可选无令牌 review-pack record 且不阻塞直合
      await withQuietIo(() => handleStart({ task: 'low-t', case: '1', slug: 'low-t', implementer: 'alice' }, roots))
      await withQuietIo(() => handleClaim({ task: 'low-t', agent: 'alice' }, roots))
      const lowLg = readTaskLedger(dir, 'low-t')
      const wtLow = lowLg.worktreePath ? join(dir, lowLg.worktreePath) : dir
      writeFileSync(join(wtLow, 'docs/notes.md'), '# notes updated\n')
      gitCommitFast(wtLow, 'docs: update notes', { updateOnly: true })
      await seedExploredFor(dir, 'low-t')
      const lowVer1 = await withQuietIo(() => handleVerify({ task: 'low-t', mode: 'gate' }, roots))
      if (lowVer1.res.exitCode !== 0) return `low-t 首次 verify 失败：${lowVer1.err}`
      const lowRec = await withQuietIo(() => handleReviewRecord({
        task: 'low-t', round: '1', verdict: 'pass', evidence: 'static ok', 'reviewer-id': 'rev-low', json: true,
      }, roots))
      if (lowRec.res !== 0) return `low 风险无令牌可选 review-pack record 失败：exit=${lowRec.res}, err=${lowRec.err}`
      // 再提交一次小改仅验证后应仍可直接 merge（可选记录不强锁 reviewPassedHead）
      writeFileSync(join(wtLow, 'docs/notes.md'), '# notes updated 2\n')
      gitCommitFast(wtLow, 'docs: tweak notes', { updateOnly: true })
      const lowVer2 = await withQuietIo(() => handleVerify({ task: 'low-t', mode: 'gate' }, roots))
      if (lowVer2.res.exitCode !== 0) return `low-t 二次 verify 失败：${lowVer2.err}`
      const lowMerge = await withQuietIo(() => handleMerge({ task: 'low-t', json: true }, roots))
      if (lowMerge.res.exitCode !== 0) return `low 风险可选 record 后直接 merge 遭误拦：${JSON.stringify(lowMerge.res)}`
      return true
    } finally { rmTree(dir) }
  }, 4000])

  cases.push(['C14：critique-reject/override、全历史换人、未改稿拦截与 3 轮硬停损（含信号落盘）', async () => {
    const specFile = 'docs/specs/261118-issue14-c14-spec.md'
    const todoFile = 'docs/todo/261118-issue14-c14-todo.md'
    const specText = (revNote) => [
      '---', 'kind: spec', 'title: "C14 Demo"', 'status: draft', 'tier: L3', 'created: 2026-11-18',
      'updated: 2026-11-18', 'issue: 14', 'owner: author-a', 'approved: false', 'implemented: false',
      'plan_critique: pending', 'related_prd: null', `related_todo: ../todo/261118-issue14-c14-todo.md`, '---', '',
      '# SPEC: C14 Demo', '', '## 要解决的问题', `- 在 \`src/app.mjs\` 补齐输入校验（${revNote}）。`, '',
      '## 本期不做', '- 不改 `src/app.mjs` 之外的外部网络契约。', '',
      '## 门型与回滚路径', '- two-way；单次 revert', '',
      '## 验收标准', '- [ ] C1: `src/app.mjs` 导出校验', '',
    ].join('\n')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'src/app.mjs': 'export const ok = 1\n',
      [specFile]: specText('第一版草案'),
      [todoFile]: [
        '---', 'kind: todo', 'title: "C14 Demo"', 'status: active', 'created: 2026-11-18',
        'updated: 2026-11-18', 'issue: 14', 'owner: author-a', 'approved: false', 'done_at: null',
        'related_prd: null', 'related_spec: ../specs/261118-issue14-c14-spec.md', '---', '',
        '# Todo: C14 Demo', '', '## 本期不做', '- 不改外部契约', '',
        '## 门型与回滚路径', '- two-way', '',
        '## 验收标准', '- [ ] C1: `src/app.mjs` 导出校验', '', '## 完成后的记录', '**在合并之前写完。**', '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      // 自审要按负责人历史判，不只按当前 owner：换过人之后，原负责人回来审自己的稿子同样要拒。
    // 只比当前 owner 时，这里会静默放行——那是最典型的一类「看起来在拦、实际没拦」。
    const rotatedSpec = 'docs/specs/261118-issue14-c14-rotated-spec.md'
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    writeFileSync(join(dir, rotatedSpec), [
      '---', 'kind: spec', 'title: "C14 Rotated"', 'status: draft', 'tier: L3', 'created: 2026-11-18',
      'updated: 2026-11-18', 'issue: 14', 'owner: author-b', 'previous_owners: [author-a]', 'approved: false', 'implemented: false',
      'plan_critique: pending', 'critique_rounds: []', 'related_prd: null', '---', '',
      '# Spec: C14 Rotated', '', '## 目标', '- 换人后旧作者不得回来自审', '', '## 方案', '- 历史负责人集合比对', '',
    ].join('\n'))
    const rotatedSelf = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', join(dir, rotatedSpec), '--reviewer', 'author-a', '--findings', 'C1: bad']))
    if (rotatedSelf.res !== EXIT.FACT || !String(rotatedSelf.err).includes('SELF_CRITIQUE_REJECTED')) {
      return `换人后原负责人回来自审未被拦截：exit=${rotatedSelf.res}, err=${rotatedSelf.err}`
    }

    const selfRej = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', specFile, '--reviewer', 'author-a', '--findings', 'C1: bad', '--dir', dir]))
      if (selfRej.res !== EXIT.FACT || !selfRej.err.includes('SELF_CRITIQUE_REJECTED')) {
        return `critique-reject 未拦同人自审：exit=${selfRej.res}, err=${selfRej.err}`
      }

      const r1Rej = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', specFile, '--reviewer', 'critic-1', '--round', '1', '--findings', 'C1: 缺异常分支', '--summary', '需补异常路径', '--dir', dir, '--json']))
      if (r1Rej.res !== EXIT.FACT) return `R1 critique-reject 失败：${r1Rej.err}`

      // 未改稿直接 critique-pass -> BLOCKED_CRITIQUE_SAME_SHA (2)
      const sameSha = await withQuietIo(() => runDocPlanCli(['critique-pass', '--file', specFile, '--reviewer', 'critic-2', '--round', '2', '--summary', 'ok', '--dir', dir]))
      if (sameSha.res !== EXIT.FACT || !sameSha.err.includes('BLOCKED_CRITIQUE_SAME_SHA')) {
        return `未改稿直接复审未被拦截：exit=${sameSha.res}, err=${sameSha.err}`
      }

      // 改稿后用 critic-1 重审 -> BLOCKED_CRITIQUE_SAME_REVIEWER (2)
      writeFileSync(join(dir, specFile), readFileSync(join(dir, specFile), 'utf8').replace('第一版草案', '第二版补异常'))
      const sameRev = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', specFile, '--reviewer', 'critic-1', '--round', '2', '--findings', 'C2: 补门型', '--dir', dir]))
      if (sameRev.res !== EXIT.FACT || !sameRev.err.includes('BLOCKED_CRITIQUE_SAME_REVIEWER')) {
        return `R2 复用 critic-1 未被拦截：exit=${sameRev.res}, err=${sameRev.err}`
      }

      // R2 critic-2 与 R1 不同意见正常放行 (0)
      const r2Diff = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', specFile, '--reviewer', 'critic-2', '--round', '2', '--findings', 'C1: 补充异常处理边界', '--dir', dir]))
      if (r2Diff.res !== EXIT.FACT) return `R2 critic-2 不同意见不应停损：exit=${r2Diff.res}, err=${r2Diff.err}`

      // R3 再改稿后即使换 critic-3 仍 reject -> 第 3 轮硬停损 (4) + 信号写入
      writeFileSync(join(dir, specFile), readFileSync(join(dir, specFile), 'utf8').replace('第二版补异常', '第三版补回滚'))
      const r3Stop = await withQuietIo(() => runDocPlanCli(['critique-reject', '--file', specFile, '--reviewer', 'critic-3', '--round', '3', '--findings', 'C1: 仍未收敛', '--dir', dir, '--json']))
      if (r3Stop.res !== 4 || !r3Stop.out.includes('STOP_LOSS_ESCALATE')) {
        return `R3 规划审稿未触发硬停损：exit=${r3Stop.res}, out=${r3Stop.out}, err=${r3Stop.err}`
      }
      const sigPath = join(dir, '.git', 'project-forge-govern', 'signals.jsonl')
      if (!existsSync(sigPath) || !readFileSync(sigPath, 'utf8').includes('plan.critique-stop-loss')) {
        return `规划停损未写入 signals.jsonl`
      }

      // 停损未解锁时 approve 必阻断；critique-override --human-approved --reason 后放行 approve
      const appBlocked = await withQuietIo(() => runDocPlanCli(['approve', '--file', specFile, '--dir', dir]))
      if (appBlocked.res !== 4) return `规划停损未解锁前 approve 应退出 4：exit=${appBlocked.res}`

      const ovRes = await withQuietIo(() => runDocPlanCli(['critique-override', '--file', specFile, '--human-approved', '--reason', '人工拍板放行', '--dir', dir, '--json']))
      if (ovRes.res !== 0) return `critique-override 失败：${ovRes.err}`
      const appOk = await withQuietIo(() => runDocPlanCli(['approve', '--file', specFile, '--dir', dir]))
      if (appOk.res !== 0) return `override 后 approve 仍失败：${appOk.err}`
      return true
    } finally { rmTree(dir) }
  }, 2500])

  cases.push(['C19：总控 PRD 四态闭环（手动/活跃、未覆盖保持 active、最后一片全勾自动归档及并行重跑幂等、未闭环拦截）', async () => {
    const masterPrd = 'docs/prd/261118-master-prd.md'
    const specA = 'docs/specs/261118-issue31-a-spec.md'
    const todoA = 'docs/todo/261118-issue31-a-todo.md'
    const specB = 'docs/specs/261118-issue32-b-spec.md'
    const todoB = 'docs/todo/261118-issue32-b-todo.md'
    const makeMaster = (extra = '') => [
      '---', 'kind: prd', 'title: "Master"', 'status: active', 'created: 2026-11-18', 'updated: 2026-11-18',
      'issue: null', 'pr: null', 'owner: p', 'plan_critique: passed', ...(extra ? [extra] : []), 'related_spec: null', 'related_todo: null', '---', '',
      '# Master', '', '## 要解决的问题', '- 分批迭代 `src/a.mjs` 与 `src/b.mjs`', '', '## 本期不做', '- 不改旧 API', '', '## 门型与回滚路径', '- two-way', '',
      '## 五、验收标准', '- [ ] C1: Slice A', '- [ ] C2: Slice B', '',
    ].join('\n')
    const makeSpec = (iss, cid, bodyDone = true) => [
      '---', 'kind: spec', `title: "S${iss}"`, 'status: approved', 'tier: L3', 'created: 2026-11-18', 'updated: 2026-11-18',
      `issue: ${iss}`, 'pr: null', 'branch: null', 'owner: p', 'approved: true', 'implemented: false', 'plan_critique: passed',
      'related_prd: ../prd/261118-master-prd.md', `related_todo: ../todo/261118-issue${iss}-${iss === 31 ? 'a' : 'b'}-todo.md`,
      'high_risk_paths: []', '---', '', `# S${iss}`, '', '## 要解决的问题', `- 改造 \`src/${iss === 31 ? 'a' : 'b'}.mjs\` (${cid})`, '',
      '## 本期不做', '- 不修改 `src/other.mjs` 范围', '', '## 门型与回滚路径', '- two-way', '',
      '## 验收标准', `- [${bodyDone ? 'x' : ' '}] ${cid}: done`, '', '## 实现说明', `- 已实现 ${cid}。`, '',
    ].join('\n')
    const makeTodo = (iss, cid, tid) => [
      '---', 'kind: todo', `title: "T${iss}"`, 'status: active', 'created: 2026-11-18', 'updated: 2026-11-18',
      `issue: ${iss}`, 'pr: null', 'branch: null', 'owner: p', 'approved: true', 'done_at: null', `task_id: ${tid}`, 'planned_at: HEAD',
      'related_prd: ../prd/261118-master-prd.md', `related_spec: ../specs/261118-issue${iss}-${iss === 31 ? 'a' : 'b'}-spec.md`,
      '---', '', `# T${iss}`, '', '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way', '',
      '## 验收标准', `- [x] ${cid}: done`, '', '## 完成后的记录', '**在合并之前写完。**', '',
    ].join('\n')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c19\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/a.mjs': 'export const a = 1\n',
      'src/b.mjs': 'export const b = 1\n',
      [masterPrd]: makeMaster(),
      [specA]: makeSpec(31, 'C1'),
      [todoA]: makeTodo(31, 'C1', 'slice-a'),
      [specB]: makeSpec(32, 'C2'),
      [todoB]: makeTodo(32, 'C2', 'slice-b'),
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      // 态② unit 检查：含未覆盖 C3 时判 hold-staged
      const stagedCheck = evaluateMasterPrdClosureState(dir, masterPrd, { currentSpecRel: specA, currentTodoRel: todoA })
      if (stagedCheck.state !== 'hold-manual-or-active') return `有活跃 B 时应为 hold-manual-or-active：${JSON.stringify(stagedCheck)}`
      writeFileSync(join(dir, masterPrd), makeMaster('archive_policy: manual'))
      const manCheck = evaluateMasterPrdClosureState(dir, masterPrd, { currentSpecRel: specA, currentTodoRel: todoA })
      if (manCheck.state !== 'hold-manual-or-active' || !manCheck.shouldHold) return `态① manual 失效：${JSON.stringify(manCheck)}`
      writeFileSync(join(dir, masterPrd), `${makeMaster()}- [ ] C3: Future wave\n`)
      writeFileSync(join(dir, specB), makeSpec(32, 'C2').replace('status: approved', 'status: superseded'))
      writeFileSync(join(dir, todoB), makeTodo(32, 'C2', 'slice-b').replace('status: active', 'status: archived'))
      const uncCheck = evaluateMasterPrdClosureState(dir, masterPrd, { currentSpecRel: specA, currentTodoRel: todoA })
      if (uncCheck.state !== 'hold-staged' || !uncCheck.uncoveredCriteria.includes('C3')) return `态② hold-staged 失效：${JSON.stringify(uncCheck)}`

      // 恢复并行双切片，测态① -> 并行归档 A 合入 main -> B sync 后重跑先态④拦截再态③自动归档并互链全通
      writeFileSync(join(dir, masterPrd), makeMaster())
      writeFileSync(join(dir, specB), makeSpec(32, 'C2'))
      writeFileSync(join(dir, todoB), makeTodo(32, 'C2', 'slice-b'))
      gitCommitFast(dir, 'docs: reset c19 slices')

      const roots = await resolveRepoRoots(dir)
      const stA = await withQuietIo(() => handleStart({ task: 'slice-a', case: '4', slug: 'a', issue: '31', spec: specA, todo: todoA, implementer: 'alice' }, roots))
      const stB = await withQuietIo(() => handleStart({ task: 'slice-b', case: '4', slug: 'b', issue: '32', spec: specB, todo: todoB, implementer: 'alice' }, roots))
      if (stA.res.exitCode !== 0 || stB.res.exitCode !== 0) return `C19 start 失败：${stA.err} / ${stB.err}`
      await withQuietIo(() => handleClaim({ task: 'slice-a', agent: 'alice' }, roots))
      await withQuietIo(() => handleClaim({ task: 'slice-b', agent: 'alice' }, roots))
      await seedExploredFor(dir, 'slice-a', 'slice-b')
      const wtA = join(dir, readTaskLedger(dir, 'slice-a').worktreePath)
      const wtB = join(dir, readTaskLedger(dir, 'slice-b').worktreePath)

      // 态①：A finalize 时 B 仍在活跃 -> 总控 PRD 保持 active 在 docs/prd/
      writeFileSync(join(wtA, 'src/a.mjs'), 'export const a = 2\n')
      gitCommitFast(wtA, 'feat: a', { updateOnly: true })
      const finA = await withQuietIo(async () => handleFinalize({ task: 'slice-a', 'no-tdd': true, json: true }, await resolveRepoRoots(wtA)))
      if (finA.res.exitCode !== 0 || !existsSync(join(wtA, masterPrd))) {
        return `态① A finalize 不应归档总控 PRD：exit=${finA.res.exitCode}`
      }
      gitSync(wtA, ['add', '-A']); gitCommitFast(wtA, 'docs: archive a')

      // 并行 B 也在 A 合前 finalize 自己（同样维持总控 PRD）
      writeFileSync(join(wtB, 'src/b.mjs'), 'export const b = 2\n')
      gitCommitFast(wtB, 'feat: b', { updateOnly: true })
      const finB1 = await withQuietIo(async () => handleFinalize({ task: 'slice-b', 'no-tdd': true, json: true }, await resolveRepoRoots(wtB)))
      if (finB1.res.exitCode !== 0 || !existsSync(join(wtB, masterPrd))) {
        return `态① 并行 B 初次 finalize 误动总控 PRD：exit=${finB1.res.exitCode}`
      }
      gitSync(wtB, ['add', '-A']); gitCommitFast(wtB, 'docs: archive b')

      // 将 A 合并到 main（模拟 A 先落地），然后 B sync
      const shaA = (await gitRun(wtA, ['rev-parse', 'HEAD'])).stdout.trim()
      gitSync(dir, ['merge', '--ff-only', shaA])
      const syncB = await withQuietIo(() => handleSync({ task: 'slice-b', json: true }, roots))
      if (syncB.res.exitCode !== 0) return `B sync 失败：${syncB.err}`

      // 态④：现在 A 已归档、B 已 sync 成最后一片，但总控 PRD 仍未勾 C1/C2 -> finalize 与 verify 必须均拦截！
      const finBBlock = await withQuietIo(async () => handleFinalize({ task: 'slice-b', 'no-tdd': true, json: true }, await resolveRepoRoots(wtB)))
      if (finBBlock.res.exitCode !== 3 || !finBBlock.err.includes('BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED')) {
        const clDbg = evaluateMasterPrdClosureState(wtB, masterPrd, { currentSpecRel: readTaskLedger(dir, 'slice-b')?.specFile, currentTodoRel: readTaskLedger(dir, 'slice-b')?.todoFile })
        return `态④ finalize 未拦截未闭环总控 PRD：exit=${finBBlock.res.exitCode}, out=${finBBlock.out}, err=${finBBlock.err}, cl=${JSON.stringify(clDbg)}`
      }
      const verBBlock = await withQuietIo(async () => handleVerify({ task: 'slice-b', mode: 'quick', json: true }, await resolveRepoRoots(wtB)))
      if (verBBlock.res.exitCode !== 3 || !verBBlock.err.includes('BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED')) {
        return `态④ verify 未拦截未闭环总控 PRD：exit=${verBBlock.res.exitCode}, err=${verBBlock.err}`
      }

      // 态③：勾选总控 PRD 后无需传 --include-master-prd 重跑 finalize -> 自动归档且互链通过
      writeFileSync(join(wtB, masterPrd), readFileSync(join(wtB, masterPrd), 'utf8').replace(/- \[ \]/g, '- [x]'))
      const finBAuto = await withQuietIo(async () => handleFinalize({ task: 'slice-b', 'no-tdd': true, json: true }, await resolveRepoRoots(wtB)))
      const archivedPrd = 'docs/archive/prd/261118-master-prd.md'
      if (finBAuto.res.exitCode !== 0 || existsSync(join(wtB, masterPrd)) || !existsSync(join(wtB, archivedPrd))) {
        return `态③ 最后一片未自动归档总控 PRD：exit=${finBAuto.res.exitCode}, err=${finBAuto.err}`
      }
      if (readTaskLedger(dir, 'slice-b')?.archivedPrdFile !== archivedPrd) {
        return `态③ 账本未写 archivedPrdFile：${JSON.stringify(readTaskLedger(dir, 'slice-b'))}`
      }
      const audAll = auditRepoDocs(wtB, '.')
      const audB = auditDoc({ repoRoot: wtB, file: 'docs/archive/specs/261118-issue32-b-spec.md' })
      if (!audAll.ok || !audB.ok) return `态③ 归档后互链审计失败：${JSON.stringify({ audAll, audB })}`
      return true
    } finally { rmTree(dir) }
  }, 5000])

  cases.push(['C22与四缺陷：A4/A5 冲突提取、四态标签、跨后端 Milestone/迁移/继承及四项修复', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c22\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/app.mjs': 'line1\nline2\nline3\n',
      'docs/specs/261118-issue41-ms-spec.md': '---\nkind: spec\ntitle: "MS"\nstatus: approved\ntier: L3\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 41\nowner: p\napproved: true\nplan_critique: passed\nrelated_prd: null\nrelated_todo: null\n---\n\n# MS\n\n## 要解决的问题\n- a\n\n## 本期不做\n- b\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C1: ok\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const roots = await resolveRepoRoots(dir)
      // 缺陷 1：scanActiveContracts (doc-audit readdirSync) 在有 docs/specs/*.md 时正常运行不抛 ReferenceError
      const audOut = auditRepoDocs(dir, '.')
      if (!audOut || typeof audOut.ok !== 'boolean') return `doc-audit 审计异常：${JSON.stringify(audOut)}`

      // C22⑤ local-only milestone + bare URL + issue migrate 带出 milestone
      const msCr = await withQuietIo(() => handleMilestone({ _: ['create'], title: 'v9-B4b', description: 'b4b ms', json: true }, roots))
      if (msCr.res.exitCode !== 0) return `local milestone create 失败：${msCr.err}`
      await createLocalIssue({ mainRoot: dir, title: '本地关联里程碑单', milestone: 'v9-B4b' })
      const msAss = await withQuietIo(() => handleMilestone({ _: ['assign'], milestone: 'v9-B4b', issue: '1', json: true }, roots))
      if (msAss.res.exitCode !== 0 || getLocalIssue({ mainRoot: dir, number: 1 }).milestone?.title !== 'v9-B4b') {
        return `milestone assign 未绑定本地单：${msAss.err}`
      }

      // 裸 Milestone URL 探测 + Case 1 in-place + Case 2 worktree + 跨 worktree listTaskLedgers(mainRoot) 修复（缺陷 3）+ updateTaskLedger（缺陷 4）
      const stC1 = await withQuietIo(() => handleStart({ _: ['https://github.com/acme/c22/milestone/7'], task: 'docs-c1', case: '1', slug: 'fix-c1', implementer: 'alice', json: true }, roots))
      if (stC1.res.exitCode !== 0) return `Case 1 start 失败：${stC1.err}`
      const lC1 = readTaskLedger(dir, 'docs-c1')
      if (lC1.branch !== 'main' || lC1.worktreePath !== null || lC1.milestone !== 7) {
        return `Case 1 原地微调或裸 Milestone URL 失败：${JSON.stringify(lC1)}`
      }
      const stDocs = await withQuietIo(() => handleStart({ _: ['https://github.com/acme/c22/milestone/7'], task: 'docs-task', case: '2', slug: 'fix-typo', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦 Milestone URL 与试合恢复', json: true }, roots))
      if (stDocs.res.exitCode !== 0) return `Case 2 start 失败：${stDocs.err}`
      const lDocs = readTaskLedger(dir, 'docs-task')
      if (lDocs.branch !== 'fix/fix-typo' || lDocs.milestone !== 7) return `Case 2 分支或裸 Milestone URL 失败：${JSON.stringify(lDocs)}`
      const wtDocs = join(dir, lDocs.worktreePath)
      await syncDocsLifecycle(wtDocs, { slugOrPath: 'docs/specs/261118-issue41-ms-spec.md', issue: 41, branch: 'feat/x' })
      await updateTaskLedger(dir, 'docs-task', (cur) => ({ ...cur, noteA: 1 }))
      await updateTaskLedger(dir, 'docs-task', (cur) => ({ ...cur, noteB: 2 }))
      const lConc = readTaskLedger(dir, 'docs-task')
      if (lConc.noteA !== 1 || lConc.noteB !== 2) return `updateTaskLedger 字段覆盖丢失：${JSON.stringify(lConc)}`

      // A5 试合有界冲突提取 + recoveryPacket
      writeFileSync(join(wtDocs, 'src/app.mjs'), 'branch-change\nline2\nline3\n')
      gitCommitFast(wtDocs, 'feat: branch conflict', { updateOnly: true })
      writeFileSync(join(dir, 'src/app.mjs'), 'main-change\nline2\nline3\n')
      gitCommitFast(dir, 'feat: main conflict', { updateOnly: true })
      const tmRes = await runTrialMerge({
        mainRoot: dir, ledger: readTaskLedger(dir, 'docs-task'), baseBranch: 'main',
        profile: { fullTest: 'exit 0', quickTest: 'exit 0' },
        evidence: { headSha: (await gitRun(wtDocs, ['rev-parse', 'HEAD'])).stdout.trim(), dirty: false, gates: { full: { exitCode: EXIT.OK } }, skipped: [] },
        policy: { riskTier: 'medium', requiredGates: ['full'] }, changedFiles: ['src/app.mjs'],
      })
      if (tmRes.code !== 'BLOCKED_TRIAL_MERGE_CONFLICT' || !tmRes.conflictHunks?.length || !tmRes.recoveryPacket?.commands?.some((c) => c.includes('GIT_EDITOR=true'))) {
        return `A5 试合冲突未提取有界块或恢复包：${JSON.stringify(tmRes)}`
      }

      // 缺陷 2：flow-batch merge-queue 门禁失败放回队头（不丢失）+ providerId === 'generic-git' 拦截
      writeTaskLedger(dir, { taskId: 'q-keep', branch: 'docs/fix-typo', baseBranch: 'main', status: 'submitted', role: 'maintainer', providerId: 'generic-git' })
      const qDir = join(dir, '.git', 'project-forge-flow')
      mkdirSync(qDir, { recursive: true })
      writeFileSync(join(qDir, 'merge-queue.json'), JSON.stringify({ queue: ['q-keep'] }, null, 2))
      const qRes = await withQuietIo(() => handleBatch({ _: ['merge-queue'], json: true }, roots))
      const qAfter = JSON.parse(readFileSync(join(qDir, 'merge-queue.json'), 'utf8')).queue
      if (qRes.res.exitCode === 0 || qAfter[0] !== 'q-keep') {
        return `merge-queue 门禁失败丢任务或未退回队头：queue=${JSON.stringify(qAfter)}`
      }

      // C22② 四态语义标签与 no-labels 豁免
      const ghLabels = new Map([[9, new Set(['in-progress', 'review'])]])
      const ghBackend = createTaskBackend({
        role: 'maintainer', providerId: 'github', targetRepo: 'acme/c22', mainRoot: dir,
        client: {
          tier: 'gh-cli',
          async listLabels() { return { ok: true, labels: ['in-progress', 'review', 'changes-requested', 'reviewed'] } },
          async addLabels({ number, labels }) { const s = ghLabels.get(number) ?? new Set(); labels.forEach((l) => s.add(l)); ghLabels.set(number, s); return { ok: true } },
          async removeLabel({ number, label }) { ghLabels.get(number)?.delete(label); return { ok: true } },
        },
      })
      await ghBackend.syncStateLabel({ repo: 'acme/c22', number: 9, state: 'in-review' })
      if (!ghLabels.get(9)?.has('review') || ghLabels.get(9)?.has('in-progress')) {
        return `四态语义标签映射与清理异常：${JSON.stringify([...(ghLabels.get(9) ?? [])])}`
      }
      writeFileSync(join(dir, 'AGENTS.md'), `${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}\n## 取舍\n- no-labels：不用标签\n`)
      const noLbl = await ghBackend.syncStateLabel({ repo: 'acme/c22', number: 9, state: 'reviewed' })
      if (!noLbl.skipped || noLbl.reason !== 'no-labels') return `no-labels 豁免失效：${JSON.stringify(noLbl)}`

      // C22⑤ issue migrate 带出 milestone + submit 继承 Issue Milestone + generic-git 清单
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/c22.git'])
      const remMs = []
      const remIss = []
      const remPrAssign = []
      const fakeGhClient = {
        tier: 'node-https-token',
        async listMilestones() { return { ok: true, milestones: remMs } },
        async createMilestone({ title }) { const m = { number: 12, title, state: 'open' }; remMs.push(m); return { ok: true, ...m } },
        async createIssue({ title, milestone }) { const it = { number: 99, title, milestone, url: 'https://github.com/acme/c22/issues/99' }; remIss.push(it); return { ok: true, ...it } },
        async postComment() { return { ok: true } },
        async getIssue() { return { ok: true, number: 99, state: 'OPEN', milestone: { number: 12, title: 'v9-B4b' } } },
        async findOpenPrForBranch() { return { ok: true, prs: [] } },
        async createPr({ title }) { return { ok: true, number: 188, url: 'https://github.com/acme/c22/pull/188', title } },
        async assignMilestone({ number, milestone }) { remPrAssign.push({ number, milestone }); return { ok: true } },
        async listLabels() { return { ok: true, labels: [] } },
        async addLabels() { return { ok: true } },
        async removeLabel() { return { ok: true } },
      }
      const mig = await withQuietIo(() => handleIssue({ _: ['migrate'], _ghClient: fakeGhClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token' } }, client: fakeGhClient }, json: true }, roots))
      if (mig.res.exitCode !== 0 || remIss[0]?.milestone !== 12) return `issue migrate 未带出 Milestone：${JSON.stringify(remIss)}`

      // submit 自动继承 linkedIssues[0] 的 Milestone 并写 docs: 前缀 PR 标题
      const bareRemote = tmpProject({})
      try {
        gitSync(bareRemote, ['init', '--bare', '--initial-branch=main'])
        const bareUrl = bareRemote.replace(/\\/g, '/')
        gitSync(dir, ['config', `url.${bareUrl}.pushInsteadOf`, 'https://github.com/acme/c22.git'])
        const stPr = await withQuietIo(() => handleStart({ task: 'pr-ms', case: '1', slug: 'readme-note', issue: '99', implementer: 'alice', _ghClient: fakeGhClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } }, client: fakeGhClient }, json: true }, roots))
        if (stPr.res.exitCode !== 0) return `pr-ms start 失败：${stPr.err}`
        const prMsLg = readTaskLedger(dir, 'pr-ms')
        const wtPr = prMsLg.worktreePath ? join(dir, prMsLg.worktreePath) : dir
        writeFileSync(join(wtPr, 'docs/note-pr.md'), '# pr\n')
        gitSync(wtPr, ['add', 'docs/note-pr.md']); gitCommitFast(wtPr, 'docs: add note')
        await seedExploredFor(dir, 'pr-ms')
        const verPr = await withQuietIo(async () => handleVerify({ task: 'pr-ms', mode: 'gate' }, await resolveRepoRoots(wtPr)))
        if (verPr.res.exitCode !== 0) return `pr-ms verify 失败：${verPr.err}`
        const createdPrTitles = []
        const subClient = {
          ...fakeGhClient,
          async createPr(args) { createdPrTitles.push(args.title); return fakeGhClient.createPr(args) },
        }
        const subPr = await withQuietIo(async () => handleSubmit({ task: 'pr-ms', agent: 'alice', _ghClient: subClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } }, client: subClient }, json: true }, await resolveRepoRoots(wtPr)))
        if (subPr.res.exitCode !== 0 || !createdPrTitles[0]?.startsWith('docs: ') || remPrAssign[0]?.number !== 188 || remPrAssign[0]?.milestone !== 12) {
          return `submit Case 1 前缀或继承 Issue Milestone 失败：titles=${JSON.stringify(createdPrTitles)} assign=${JSON.stringify(remPrAssign)} err=${subPr.err}`
        }
      } finally { rmTree(bareRemote) }

      // generic-git milestone 返回 capabilities.milestones=false 与 platformSetupChecklist
      const genBk = createTaskBackend({ role: 'generic-git', providerId: 'generic-git', mainRoot: dir })
      const genMs = await genBk.createMilestone({ title: 'gen-v1' })
      if (genBk.capabilities.milestones !== false || !genMs.platformSetupChecklist?.length) {
        return `generic-git milestone 未返回清单或能力标志错误：${JSON.stringify(genMs)}`
      }
      // 核对 inspect 识别裸 milestone URL
      const insRes = await inspectWorkspace(dir, { roots, inputs: ['https://github.com/acme/c22/milestone/12'], _ghClient: fakeGhClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token' } }, client: fakeGhClient }, lightStart: true })
      if (insRes.inputs?.milestones?.[0]?.number !== 12) return `inspect 未解析裸 Milestone URL：${JSON.stringify(insRes.inputs)}`
      return true
    } finally { rmTree(dir) }
  }, 5000])
}
