/**
 * fixtures-r6a-state.mjs —— R6A 默认分支单一来源、任务活性分类、generic-git 合流、
 * A3 合并权、探索凭据继承与 Git-Ref CAS 认领租约的正反双向回归夹具。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { hasSkillSupport } from '../../kit/skills/lib/cli.mjs'
import { critiqueTextFingerprint } from '../../kit/skills/lib/critique-rounds.mjs'
import { detectCommitStyle } from '../../kit/skills/lib/git-core.mjs'
import { isDefaultBranch, resolveDefaultBranch } from '../../kit/skills/lib/git.mjs'
import {
  classifyTaskLiveness, createDefaultLedger, createExploredEvidence,
  hasExploredEvidence, listTaskLedgers, readTaskLedger, writeTaskLedger,
} from '../../kit/skills/lib/ledger.mjs'
import { evaluatePlanExitGate } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { GenericRemoteBackend } from '../../kit/skills/lib/task-backend-local.mjs'
import { evaluateNextState } from '../../kit/skills/lib/workflow-policy-next.mjs'
import { buildCleanupChecklist, handleStatus } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge, handleRelease } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { runTrialMerge } from '../../kit/skills/dev-flow/scripts/flow-trial-merge.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import {
  EXIT, gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor, rmTree, runAbsAsync, tmpProject,
} from './fixtures-helpers.mjs'

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

function makeMasterOnlyRepo({ role = 'local-only', withBareRemote = false } = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
    '.agents/skills/dev-review/SKILL.md': '---\nname: dev-review\n---\n',
    'AGENTS.md': [
      '# r6a-demo',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'src/core.mjs': 'export const r6a = 1\n',
  })
  let bareDir = null
  if (withBareRemote) {
    bareDir = tmpProject({})
    gitInitBare(bareDir)
    gitInit(dir, { branch: 'master', name: 'alice', email: 'alice@example.com', origin: role === 'generic-git' ? 'ssh://git@git.example.com/acme/demo.git' : bareDir })
    if (role === 'generic-git') {
      gitSync(dir, ['remote', 'set-url', 'origin', bareDir])
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git', 'pf-provider.json'), JSON.stringify({ providerId: 'generic-git' }), 'utf8')
    }
    gitSync(dir, ['push', '-u', 'origin', 'master'])
    gitSync(bareDir, ['symbolic-ref', 'HEAD', 'refs/heads/master'])
  } else {
    gitInit(dir, { branch: 'master', name: 'alice', email: 'alice@example.com' })
  }
  return { dir, bareDir }
}

function seedAuditedSpecAndTodo(dir, { taskId = 'slice-demo', slug = 'slice-demo', audited = true, validRefs = true, status = 'approved', critique = 'passed' } = {}) {
  const specRel = `docs/specs/261124-${slug}-spec.md`
  const todoRel = `docs/todo/261124-${slug}-todo.md`
  const refPath = validRefs ? 'src/core.mjs' : 'src/nonexistent-phantom.mjs'
  mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
  mkdirSync(join(dir, 'docs', 'todo'), { recursive: true })
  const buildSpec = (critLine) => [
    '---',
    `task_id: ${taskId}`,
    `slug: ${slug}`,
    'kind: spec',
    `status: ${status}`,
    `plan_critique: "${critLine}"`,
    `audit_passed: ${audited}`,
    `scope_files: ["${refPath}"]`,
    '---',
    '',
    `# ${slug}`,
    '',
    '## 改动清单',
    `- ${refPath}`,
    '- `hasSkillSupport`',
    '- **本期不做**：不动 `README.md`',
    '',
  ].join('\n')
  const specInitial = buildSpec(critique)
  const specSha = critiqueTextFingerprint(specInitial)
  writeFileSync(join(dir, specRel), critique === 'passed' ? buildSpec(`passed sha=${specSha}`) : specInitial, 'utf8')
  const todoStatus = status === 'approved' ? 'active' : status
  const buildTodo = (critLine) => [
    '---',
    `task_id: ${taskId}`,
    `slug: ${slug}`,
    'kind: todo',
    `status: ${todoStatus}`,
    `plan_critique: "${critLine}"`,
    `audit_passed: ${audited}`,
    '---',
    '',
    `# ${slug} Todo`,
    '',
    `- **影响路径**：\`${refPath}\``,
    '- **本期不做**：不动 `README.md`',
    `- [ ] C1: edit \`${refPath}\``,
    '',
  ].join('\n')
  const todoInitial = buildTodo(critique)
  const todoSha = critiqueTextFingerprint(todoInitial)
  writeFileSync(join(dir, todoRel), critique === 'passed' ? buildTodo(`passed sha=${todoSha}`) : todoInitial, 'utf8')
  return { specRel, todoRel }
}

export function registerR6aStateCases(cases) {
  cases.push(['R6A-C1: master-only 严格解析默认分支且不误建 main，缺失分支阻断 BLOCKED_MISSING_DEFAULT_BRANCH，detectCommitStyle 过滤合并/自动提交与 <5 样本', async () => {
    const { dir } = makeMasterOnlyRepo()
    try {
      assert.equal(await resolveDefaultBranch(dir, { strict: true }), 'master')
      assert.equal(await isDefaultBranch(dir, 'master'), true)
      assert.equal(await isDefaultBranch(dir, 'main'), false)
      assert.equal(createDefaultLedger({ taskId: 'x' }).baseBranch, null)

      assert.equal(detectCommitStyle([
        'feat: a', 'fix: b', 'docs: c',
        'Merge branch "main"', 'Merge pull request #12 from acme/feat', 'chore: release v1.0.0', 'chore(release): 1.0.1',
      ]), 'plain', '有效样本 < 5 条时不得在浅历史反转成 conventional')
      assert.equal(detectCommitStyle([
        'feat: a', 'fix: b', 'feat(core): c', 'refactor: d', 'test: e', 'Merge branch "x"',
      ]), 'conventional', '有效样本 >= 5 条且超半数应识别为 conventional')

      const roots = await resolveRepoRoots(dir)
      const { specRel, todoRel } = seedAuditedSpecAndTodo(dir, { taskId: 'c1-master', slug: 'c1-master', status: 'draft', critique: 'pending' })
      gitCommitFast(dir, 'docs: add slice plan')
      const startOut = await withCaptureIo(() => handleStart({
        task: 'c1-master', case: '3', spec: specRel, todo: todoRel, json: true, agent: 'impl-a',
      }, roots))
      assert.equal(startOut.res.exitCode, EXIT.OK)
      const ledger = readTaskLedger(dir, 'c1-master')
      assert.equal(ledger.baseBranch, 'master', 'master-only 仓 baseBranch 应校准为 master')
      const mainRefCheck = gitSync(dir, ['show-ref', '--verify', '--quiet', 'refs/heads/main'])
      assert.notEqual(mainRefCheck.status, 0, 'master-only 仓流转后绝不许新建 refs/heads/main')

      // 反面：无默认分支的游离 HEAD 仓 strict 返回 null 且 trialMerge / start 阻断 BLOCKED_MISSING_DEFAULT_BRANCH (exit 3)
      const noBranchDir = tmpProject({ 'README.md': '# empty\n' })
      try {
        gitInit(noBranchDir, { branch: 'topic-custom', name: 'bob', email: 'bob@example.com' })
        const sha = gitSync(noBranchDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
        gitSync(noBranchDir, ['checkout', '--detach', sha])
        gitSync(noBranchDir, ['branch', '-D', 'topic-custom'])
        assert.equal(await resolveDefaultBranch(noBranchDir, { strict: true }), null, '无任何分支的游离 HEAD 严格解析必须返回 null')
        const trialFail = await runTrialMerge(noBranchDir, { taskId: 'missing-base', baseBranch: null, branch: 'topic-missing' })
        assert.equal(trialFail.blocked, true)
        assert.equal(trialFail.code, 'BLOCKED_MISSING_DEFAULT_BRANCH')
        assert.equal(trialFail.exitCode, EXIT.FACT)
        assert.notEqual(gitSync(noBranchDir, ['show-ref', '--verify', '--quiet', 'refs/heads/main']).status, 0, 'runTrialMerge 严禁私造 refs/heads/main')

        const noBrRoots = await resolveRepoRoots(noBranchDir)
        const startFail = await withCaptureIo(() => handleStart({ task: 'missing-base', case: '2', json: true }, noBrRoots))
        assert.equal(startFail.res.exitCode, EXIT.FACT)
        assert.match(startFail.out + startFail.err, /BLOCKED_MISSING_DEFAULT_BRANCH/)
      } finally {
        rmTree(noBranchDir)
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['R6A-C2: classifyTaskLiveness 屏蔽遗留 merged/孤儿/陈旧原地台账污染，status --all 与 status --task 同源', async () => {
    const { dir } = makeMasterOnlyRepo()
    try {
      gitCommitFast(dir, 'feat: advance master head')
      const headSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const parentSha = gitSync(dir, ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim()

      const mergedLedger = createDefaultLedger({ taskId: 'old-merged', status: 'merged', branch: 'feat/old', baseBranch: 'master', worktreePath: '.worktrees/impl-old-merged' })
      const orphanPlanLedger = createDefaultLedger({ taskId: 'old-orphan-plan', status: 'planning', planning: true, branch: 'docs/old', baseBranch: 'master', worktreePath: '.worktrees/plan-old' })
      const staleInPlaceLedger = createDefaultLedger({ taskId: 'old-stale-inplace', status: 'started', isolation: 'in-place', branch: 'master', baseBranch: 'master', baseSha: parentSha, worktreePath: null, claimedAt: null })
      const activeLedger = createDefaultLedger({ taskId: 'real-active', status: 'claimed', isolation: 'worktree', branch: 'feat/real-active', baseBranch: 'master', baseSha: headSha, worktreePath: '.worktrees/impl-real-active', claimedAt: new Date().toISOString(), claimedBy: 'impl-a' })
      mkdirSync(join(dir, '.worktrees', 'impl-real-active'), { recursive: true })
      for (const l of [mergedLedger, orphanPlanLedger, staleInPlaceLedger, activeLedger]) {
        writeTaskLedger(dir, l)
      }

      assert.equal(classifyTaskLiveness(mergedLedger, { repoRoot: dir }), 'terminal-pending-cleanup')
      assert.equal(classifyTaskLiveness(orphanPlanLedger, { repoRoot: dir }), 'terminal-pending-cleanup')
      assert.equal(classifyTaskLiveness(staleInPlaceLedger, { repoRoot: dir }), 'terminal-pending-cleanup')
      assert.equal(classifyTaskLiveness(activeLedger, { repoRoot: dir }), 'active')

      const listed = listTaskLedgers(dir, { includeTerminal: false })
      assert.deepEqual(listed.map((t) => t.taskId), ['real-active'], 'includeTerminal=false 只保留真实活跃任务')

      const roots = await resolveRepoRoots(dir)
      const nextOut = await withCaptureIo(() => handleNext({ json: true }, roots))
      assert.equal(nextOut.res.exitCode, EXIT.OK)
      const nextJson = JSON.parse(nextOut.out)
      assert.equal(nextJson.taskId, 'real-active')
      assert.equal(nextJson.pendingCleanupTasks.length, 3)

      const allStatus = await withCaptureIo(() => handleStatus({ all: true, json: true }, roots))
      const oneStatus = await withCaptureIo(() => handleStatus({ task: 'real-active', json: true }, roots))
      const allJson = JSON.parse(allStatus.out)
      const oneJson = JSON.parse(oneStatus.out)
      assert.equal(allJson.activeTasks.length, 1)
      assert.equal(allJson.activeTasks[0].phase, oneJson.phase, 'status --all 与 status --task 对同一任务的 phase 必须完全同源')
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['R6A-C3: generic-git 解除 flow-merge 短路走远端四态核验，A3 拦截实施者自合放行审查者/协调者，start 继承已审探索凭据', async () => {
    const { dir, bareDir } = makeMasterOnlyRepo({ role: 'generic-git', withBareRemote: true })
    try {
      const { specRel, todoRel } = seedAuditedSpecAndTodo(dir, { taskId: 'c3-generic', slug: 'c3-generic', audited: true, validRefs: true })
      gitCommitFast(dir, 'docs: add audited plan')
      const roots = await resolveRepoRoots(dir)
      const startRes = await withCaptureIo(() => handleStart({
        task: 'c3-generic', case: '4', spec: specRel, todo: todoRel, json: true, agent: 'impl-a',
      }, roots))
      assert.equal(startRes.res.exitCode, EXIT.OK, `startRes failed: ${startRes.out}\n${startRes.err}`)
      const startedLedger = readTaskLedger(dir, 'c3-generic')
      assert.equal(hasExploredEvidence(startedLedger), true, '绑定已过 audit 真实路径的 SPEC/Todo 时 start 应自动继承 explored 凭据')

      // 反面：未过 audit 且无 session-state 的规划不得自动继承 explored
      const { specRel: unSpec, todoRel: unTodo } = seedAuditedSpecAndTodo(dir, { taskId: 'c3-unaudited', slug: 'c3-unaudited', audited: false, validRefs: false, status: 'draft', critique: 'pending' })
      gitCommitFast(dir, 'docs: add unaudited plan')
      const unStart = await withCaptureIo(() => handleStart({
        task: 'c3-unaudited', case: '4', spec: unSpec, todo: unTodo, json: true, agent: 'impl-b', 'allow-plan-bootstrap': true,
      }, roots))
      assert.equal(unStart.res.exitCode, EXIT.OK, `unStart failed: ${unStart.out}\n${unStart.err}`)
      assert.equal(hasExploredEvidence(readTaskLedger(dir, 'c3-unaudited')), false, '未过 audit 且无真实路径时不得伪造 explored 凭据')

      // 推进 c3-generic：worktree 提交变更并推送、写实证与独立审查 PASS
      const wtDir = join(dir, '.worktrees', 'impl-c3-generic')
      writeFileSync(join(wtDir, 'src', 'core.mjs'), 'export const r6a = 2\n', 'utf8')
      gitCommitFast(wtDir, 'feat: update core')
      const headSha = gitSync(wtDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(wtDir, ['push', '-u', 'origin', startedLedger.branch])

      const claimC3 = await withCaptureIo(() => handleClaim({ task: 'c3-generic', agent: 'impl-a', json: true }, roots))
      assert.equal(claimC3.res.exitCode, EXIT.OK, claimC3.out + claimC3.err)
      const verRes = await withCaptureIo(() => handleVerify({ task: 'c3-generic', mode: 'gate' }, roots))
      assert.equal(verRes.res.exitCode, EXIT.OK, verRes.out + verRes.err)
      assert.ok(headSha)
      const rvTok = await issueTokenFor(dir, 'c3-generic', 1)
      const rvRec = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'c3-generic', '--round', '1', '--verdict', 'pass',
        '--reviewer-id', 'reviewer-b', '--review-token', rvTok, '--evidence', 'verified cleanly', '--json',
      ], { cwd: dir })
      assert.equal(rvRec.status, EXIT.OK, `review-pack record failed: ${rvRec.stdout}\n${rvRec.stderr}`)

      // A3 反面：实施者自己调 merge 必须报 BLOCKED_SELF_MERGE (exit 3)
      const selfMerge = await withCaptureIo(() => handleMerge({ task: 'c3-generic', agent: 'impl-a', json: true }, roots))
      assert.equal(selfMerge.res.exitCode, EXIT.FACT)
      assert.equal(selfMerge.res.code, 'BLOCKED_SELF_MERGE')

      // generic-git 远端未合入时，允许协调者进入后端并由 GenericRemoteBackend.mergePr 核验报 BLOCKED_REMOTE_NOT_MERGED（而非老旧 BLOCKED_GENERIC_REMOTE_MR_REQUIRED）
      const unmergedRemote = await withCaptureIo(() => handleMerge({ task: 'c3-generic', agent: 'coordinator', json: true }, roots))
      assert.equal(unmergedRemote.res.exitCode, EXIT.FACT)
      assert.doesNotMatch(unmergedRemote.out + unmergedRemote.err, /BLOCKED_GENERIC_REMOTE_MR_REQUIRED/)
      assert.match(unmergedRemote.out + unmergedRemote.err, /BLOCKED_REMOTE_NOT_MERGED/)

      // 将特性分支并入裸远端 master（模拟远端平台完成合并并删去远端特性分支）
      const tmpMerger = tmpProject({})
      try {
        gitSync(tmpMerger, ['clone', '-q', bareDir, 'repo'])
        const cloned = join(tmpMerger, 'repo')
        gitSync(cloned, ['config', 'user.name', 'maintainer'])
        gitSync(cloned, ['config', 'user.email', 'm@example.com'])
        gitSync(cloned, ['checkout', '-q', 'master'])
        gitSync(cloned, ['merge', '--no-ff', '-q', `origin/${startedLedger.branch}`, '-m', 'merge feat'])
        gitSync(cloned, ['push', '-q', 'origin', 'master'])
        gitSync(cloned, ['push', '-q', 'origin', '--delete', startedLedger.branch])
      } finally {
        rmTree(tmpMerger)
      }

      // A3 正面 + generic-git 远端删分支后四态核验通过
      const passMerge = await withCaptureIo(() => handleMerge({ task: 'c3-generic', agent: 'coordinator', json: true }, roots))
      assert.equal(passMerge.res.exitCode, EXIT.OK, `coordinator 应获放行并完成 generic-git 四态合流: ${passMerge.err}`)
      assert.equal(readTaskLedger(dir, 'c3-generic').status, 'merged')
      const cleanupCl = await buildCleanupChecklist(dir, readTaskLedger(dir, 'c3-generic'), { origin: bareDir }, null, 'origin', { gitDir: roots.gitDir })
      assert.equal(cleanupCl.remoteBranch, null, 'generic-git 经 ls-remote --heads 核查已删远端分支应置 remoteBranch=null')

      // verify GenericRemoteBackend direct unit guard on non-merged remote
      const backend = new GenericRemoteBackend({ mainRoot: dir, gitDir: roots.gitDir, pushRemote: 'origin', baseBranch: 'master' })
      assert.ok(backend)
      return true
    } finally {
      rmTree(dir)
      if (bareDir) rmTree(bareDir)
    }
  }])

  cases.push(['R6A-C4: plan-exit-gate 反作弊保留与提示优化、Case 3 路由不硬编码 --case 4、Git-Ref CAS 并发互斥与 contributor-fork 状态', async () => {
    const { dir, bareDir } = makeMasterOnlyRepo({ role: 'generic-git', withBareRemote: true })
    try {
      // 1. plan-exit-gate: ledgerEntry: null 时在非单会话模式下仍拦 skipped 并给出清晰双模式提示
      const { specRel, todoRel } = seedAuditedSpecAndTodo(dir, { taskId: 'c4-gate', slug: 'c4-gate', critique: 'skipped: manual bypass reason with sufficient length', status: 'approved' })
      const gateBlocked = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'c4-gate', docs: { spec: specRel, todo: todoRel } })
      assert.equal(gateBlocked.blocked, true, '非 single-session 裸写 plan_critique: skipped 即使 ledgerEntry=null 也必须阻断')
      assert.match(gateBlocked.reasons.map((r) => r.fixHint).join('\n'), /critique-pass|critique-override/)

      // 2. workflow-policy-next: Case 3 独立 Todo 必须引导 --case 3 而非 --case 4；缺本地 .git/issues 不死循环；in-flight draft 路由至 doc-plan next
      const case3Dir = tmpProject({
        'docs/todo/261124-case3-solo-todo.md': [
          '---',
          'task_id: case3-solo',
          'slug: case3-solo',
          'case: 3',
          'kind: todo',
          'status: active',
          '---',
          '',
          '# Solo Todo',
          '',
          '## 改动清单',
          '- `src/core.mjs`',
          '',
          '## 验收标准',
          '- [ ] C1: something',
          '',
        ].join('\n'),
      })
      try {
        const nextCase3 = evaluateNextState({ activeTasks: [], repoRoot: case3Dir })
        assert.match(nextCase3.command, /--case 3\b/, 'Case 3 独立 Todo 严禁硬编码 --case 4')
      } finally {
        rmTree(case3Dir)
      }

      // in-flight draft SPEC when no ready tasks
      const draftDir = tmpProject({ 'docs/specs/261124-draft-plan-spec.md': '---\nslug: draft-plan\nkind: spec\nstatus: draft\n---\n# Draft\n' })
      try {
        const nextDraft = evaluateNextState({ activeTasks: [], repoRoot: draftDir })
        assert.equal(nextDraft.phase, 'planning')
        assert.match(nextDraft.command, /doc-plan\.mjs" next\b.*--handoff/)
      } finally {
        rmTree(draftDir)
      }

      // cross-machine missing .git/issues on local-only task must NOT emit ISSUE_CONTEXT_UNAVAILABLE
      const xmLedger = createDefaultLedger({
        taskId: 'xm-task', status: 'started', role: 'local-only', linkedIssues: [999],
        issueContextUnavailable: [], baseBranch: 'master',
      })
      const xmNext = evaluateNextState({ activeTasks: [xmLedger], selectedTask: xmLedger, repoRoot: dir })
      assert.ok(!xmNext.blockingReasons.includes('ISSUE_CONTEXT_UNAVAILABLE'), '跨机缺失本地 .git/issues 不得阻断进入 ISSUE_CONTEXT_UNAVAILABLE 死循环')

      // 3. Git-Ref CAS 原子认领租约：claim 并发互斥 + takeover 缺 --agent 阻断 + release 删租约
      const roots = await resolveRepoRoots(dir)
      const { specRel: s2, todoRel: t2 } = seedAuditedSpecAndTodo(dir, { taskId: 'c4-cas', slug: 'c4-cas', audited: true, validRefs: true })
      gitCommitFast(dir, 'docs: add cas plan')
      await withCaptureIo(() => handleStart({ task: 'c4-cas', case: '3', spec: s2, todo: t2, json: true, agent: 'agent-a', 'no-issue': true, reason: 'Git-Ref CAS 原子认领租约并发互斥夹具' }, roots))
      const claimA = await withCaptureIo(() => handleClaim({ task: 'c4-cas', agent: 'agent-a', json: true }, roots))
      assert.equal(claimA.res.exitCode, EXIT.OK)
      const refExists = gitSync(dir, ['show-ref', '--verify', '--quiet', 'refs/pf/claims/c4-cas'])
      assert.equal(refExists.status, 0, 'claim 必须写入 refs/pf/claims/<taskId> 租约引用')

      const claimConflict = await withCaptureIo(() => handleClaim({ task: 'c4-cas', agent: 'agent-b', json: true }, roots))
      assert.equal(claimConflict.res.exitCode, EXIT.FACT, '未带 --takeover 并发认领他人租约必报 BLOCKED_ISSUE_ALREADY_CLAIMED')
      assert.match(claimConflict.out + claimConflict.err, /BLOCKED_ISSUE_ALREADY_CLAIMED/)

      const anonTakeover = await withCaptureIo(() => handleClaim({ task: 'c4-cas', takeover: true, reason: 'takeover without agent', json: true }, roots))
      assert.equal(anonTakeover.res.exitCode, EXIT.USAGE, '--takeover 缺失 --agent 必须硬阻断而非回退旧作者')
      assert.match(anonTakeover.out + anonTakeover.err, /BLOCKED_MISSING_ACTOR/)

      const validTakeover = await withCaptureIo(() => handleClaim({ task: 'c4-cas', takeover: true, agent: 'agent-b', reason: 'agent-a handoff', json: true }, roots))
      assert.equal(validTakeover.res.exitCode, EXIT.OK)

      const relOut = await withCaptureIo(() => handleRelease({ task: 'c4-cas', agent: 'agent-b', reason: 'done', json: true }, roots))
      assert.equal(relOut.res.exitCode, EXIT.OK)
      assert.notEqual(gitSync(dir, ['show-ref', '--verify', '--quiet', 'refs/pf/claims/c4-cas']).status, 0, 'release 后必须删除 refs/pf/claims/<taskId>')

      // 4. generic-git + contributor-fork submit -> awaiting-upstream-merge，且提示零 --remote-merged 幽灵参数
      const wtCas = join(dir, '.worktrees', 'impl-c4-cas')
      writeFileSync(join(wtCas, 'src', 'core.mjs'), 'export const r6a = 3\n', 'utf8')
      gitCommitFast(wtCas, 'feat: cas change')
      const casHead = gitSync(wtCas, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const reclaimC4 = await withCaptureIo(() => handleClaim({ task: 'c4-cas', agent: 'agent-b', json: true }, roots))
      assert.equal(reclaimC4.res.exitCode, EXIT.OK, reclaimC4.out + reclaimC4.err)
      const casVer = await withCaptureIo(() => handleVerify({ task: 'c4-cas', mode: 'gate' }, roots))
      assert.equal(casVer.res.exitCode, EXIT.OK, casVer.out+casVer.err)
      await writeTaskLedger(dir, {
        ...readTaskLedger(dir, 'c4-cas'),
        role: 'contributor-fork',
        providerId: 'generic-git',
        status: 'claimed',
        claimedAt: new Date().toISOString(),
        claimedBy: 'agent-b',
        agent: 'agent-b',
        implementerId: 'agent-b',
        verifiedHead: casHead,
        lastVerifyExitCode: 0,
        finalized: true,
        finalizedHead: casHead,
      })
      const subOut = await withCaptureIo(() => handleSubmit({ task: 'c4-cas', agent: 'agent-b', offline: true }, roots))
      assert.equal(subOut.res.exitCode, EXIT.OK, `submit failed: ${subOut.out}\n${subOut.err}`)
      assert.equal(readTaskLedger(dir, 'c4-cas').status, 'awaiting-upstream-merge')
      assert.doesNotMatch(subOut.out, /--remote-merged/, 'submit 提示不得包含不存在的 --remote-merged 参数')
      assert.ok(hasSkillSupport(dir, 'dev-flow'))
      return true
    } finally {
      rmTree(dir)
      if (bareDir) rmTree(bareDir)
    }
  }])
}
