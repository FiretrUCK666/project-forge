/**
 * fixtures-conv-s2.mjs —— Slice 2 (`conversational-lifecycle-model`) C5..C8 正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { evaluateMutability } from '../../kit/skills/lib/mutability.mjs'
import { checkDocRegression, extractDocSnapshot } from '../../kit/skills/lib/doc-substantive.mjs'
import { checkMasterCriteriaCoverage, evaluateSliceGraph } from '../../kit/skills/lib/doc-slice-graph.mjs'
import { consumeReviewToken, ensureReviewToken, readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { evaluatePlanNextState } from '../../kit/skills/lib/plan-next.mjs'
import { buildSessionOrientation } from '../../kit/skills/lib/session-orient.mjs'
import {
  TOPIC_MAX_BYTES, appendPreInitNote, readAllActiveTopics, readPreInitState, resolveSessionStatePath,
} from '../../kit/skills/lib/session-state.mjs'
import { evaluateNextState } from '../../kit/skills/lib/workflow-policy-next.mjs'
import { resolveRepoRoots, writeJsonAtomic } from './test-shared.mjs'
import { approveSpec, clarifyDoc, initDoc, sliceSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { auditDoc, checkOrphanSlices } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { handleBatch } from '../../kit/skills/dev-flow/scripts/flow-batch.mjs'
import { handleAbort } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleRework } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

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

export function registerConvS2Cases(cases) {
  cases.push(['Conv-S2 C5：v2 多主题 Working Brief、v1 无损迁移、open 门禁、orient 零截断与 explore 按需锚点', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# ConvS2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/auth.mjs': 'export const login = () => true\n',
      'src/dirty-unrelated.mjs': 'export const dirty = 1\n',
      'docs/TDD.md': '# TDD\n\n- `src/auth.mjs`\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test' })
    try {
      const roots = await resolveRepoRoots(dir)
      const statePath = resolveSessionStatePath(dir)

      // 1. v1 自动无损迁移到 v2
      writeJsonAtomic(statePath, {
        schemaVersion: 1,
        preInit: { topic: 'legacy-topic', decisions: ['D-v1'], exclusions: ['E-v1'], anchors: ['src/auth.mjs'], openQuestions: ['是否保留老接口'] },
      })
      const migrated = readPreInitState(dir, { topic: 'legacy-topic' })
      if (!migrated || !migrated.decisions.includes('D-v1') || migrated.unresolvedOpen?.length !== 1) {
        return `v1 无损迁移失败：${JSON.stringify(migrated)}`
      }

      // 2. 多主题隔离 + facts 覆写/裁剪 + 非法格式 + 预算超限禁止静默丢弃 facts
      appendPreInitNote(dir, { topic: 'topic-a', fact: 'auth=jwt', decision: '双令牌', openQuestions: ['Q-a1', 'Q-a2', 'Q-a3', 'Q-a4', 'Q-a5'] })
      appendPreInitNote(dir, { topic: 'topic-a', fact: 'auth=oauth2', facts: ['f2=v2', 'f3=v3', 'f4=v4', 'f5=v5'] })
      appendPreInitNote(dir, { topic: 'topic-b', fact: 'cache=redis', decision: 'TTL 60s' })
      const topicA = readPreInitState(dir, { topic: 'topic-a' })
      if (topicA?.facts?.auth !== 'oauth2') return `facts 同键未覆写：${JSON.stringify(topicA)}`

      let badFactHit = false
      try { appendPreInitNote(dir, { topic: 'topic-a', fact: 'missing-equals' }) } catch (e) { badFactHit = e.code === 'INVALID_FACT_FORMAT' }
      if (!badFactHit) return '非法 --fact 未抛 INVALID_FACT_FORMAT'

      let budgetErrHit = false
      try {
        appendPreInitNote(dir, { topic: 'topic-big', fact: `huge=${'k'.repeat(TOPIC_MAX_BYTES + 200)}` })
      } catch (e) { budgetErrHit = e.code === 'BLOCKED_TOPIC_BUDGET_EXCEEDED' }
      if (!budgetErrHit) return 'facts 超 TOPIC_MAX_BYTES 未报 BLOCKED_TOPIC_BUDGET_EXCEEDED（疑似静默丢弃）'

      // 3. orient 完整渲染 active facts & open（无 .slice(-4) 截断）
      const orient = buildSessionOrientation(dir)
      if (!orient.text.includes('Q-a1') || !orient.text.includes('Q-a5') || !orient.text.includes('f5=v5')) {
        return `session-orient 发生截断或漏渲染：\n${orient.text}`
      }

      // 4. doc-locate / repo-map 不传 --topic 零写入；传 --topic 仅写仓外锚点
      const beforeAnchorStat = readFileSync(statePath, 'utf8')
      const beforeTopicsSnap = JSON.stringify(readAllActiveTopics(dir))
      const locNoTopic = await runAbsAsync('kit/skills/dev-explore/scripts/doc-locate.mjs', ['--query', 'login', '--scope', 'src', '--json'], { cwd: dir })
      if (locNoTopic.status !== 0 || readFileSync(statePath, 'utf8') !== beforeAnchorStat || JSON.stringify(readAllActiveTopics(dir)) !== beforeTopicsSnap) {
        return `doc-locate 无 --topic 发生状态写入：status=${locNoTopic.status}`
      }
      const mapNoTopic = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', ['--json'], { cwd: dir })
      if (mapNoTopic.status !== 0 || readFileSync(statePath, 'utf8') !== beforeAnchorStat || JSON.stringify(readAllActiveTopics(dir)) !== beforeTopicsSnap) {
        return `repo-map 无 --topic 发生状态写入：status=${mapNoTopic.status}`
      }
      const locWithTopic = await runAbsAsync('kit/skills/dev-explore/scripts/doc-locate.mjs', ['--file', 'src/auth.mjs', '--topic', 'topic-b', '--json'], { cwd: dir })
      if (locWithTopic.status !== 0 || !readPreInitState(dir, { topic: 'topic-b' })?.anchors?.includes('src/auth.mjs')) {
        return `doc-locate --topic 未写入 anchors：${JSON.stringify(readPreInitState(dir, { topic: 'topic-b' }))}`
      }

      // 5. triage --topic 不拉取脏工作区文件；init 在 open > 0 阻断且 --resolve 后仅消费目标 topic
      writeFileSync(join(dir, 'src/untracked-dirty.mjs'), 'export const u = 1\n', 'utf8')
      const triTopic = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--topic', 'topic-a', '--summary', '认证改造', '--json',
      ], { cwd: dir })
      const triJson = JSON.parse(triTopic.stdout)
      if (triJson.files > 0 && JSON.stringify(triJson).includes('untracked-dirty.mjs')) {
        return `triage --topic 串味拉取脏文件：${triTopic.stdout}`
      }
      const blockedInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'auth-v2', '--title', 'Auth V2', '--owner', 'p1', '--topic', 'topic-a', '--in-place', '--json',
      ], { cwd: dir })
      if (blockedInit.status !== 3 || !blockedInit.stdout.includes('BLOCKED_OPEN_QUESTIONS_UNRESOLVED')) {
        return `open > 0 未触发 BLOCKED_OPEN_QUESTIONS_UNRESOLVED：status=${blockedInit.status} out=${blockedInit.stdout}`
      }

      const allowInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'auth-draft', '--title', 'Auth Draft', '--owner', 'p1', '--topic', 'topic-a', '--allow-open-draft', '--in-place', '--json',
      ], { cwd: dir })
      if (allowInit.status !== 0) return `--allow-open-draft 放行失败：${allowInit.stderr} ${allowInit.stdout}`
      const allowOut = JSON.parse(allowInit.stdout)
      const todoTxt = readFileSync(join(dir, allowOut.files.find((f) => f.endsWith('-todo.md'))), 'utf8')
      const specTxt = readFileSync(join(dir, allowOut.files.find((f) => f.endsWith('-spec.md'))), 'utf8')
      if (!specTxt.includes('Q-a1') || todoTxt.includes('Q-a1')) {
        return `open 问题未隔离至单一主文档 spec：specHas=${specTxt.includes('Q-a1')} todoHas=${todoTxt.includes('Q-a1')}`
      }
      if (!readPreInitState(dir, { topic: 'topic-b' })) {
        return 'init --topic topic-a 误消费了并行 topic-b'
      }
      if (readAllActiveTopics(dir).some((t) => t.topicId === 'topic-a')) {
        return 'topic-a 在 init 后仍未标记消费'
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Conv-S2 C6：mutability 两态、clarify 冻结守卫与 --drop-criterion、dropped 终态、1:N 切片与独立 SPEC 并行', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# ConvS2C6\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/mod-a.mjs': 'export const a = 1\n',
      'src/mod-b.mjs': 'export const b = 2\n',
      'docs/TDD.md': '# TDD\n\n- `src/mod-a.mjs`\n- `src/mod-b.mjs`\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. evaluateMutability 两态枚举核验
      if (evaluateMutability({ kind: 'spec', status: 'draft', approved: false }).mutability !== 'OPEN') return 'draft spec 应为 OPEN'
      if (evaluateMutability({ kind: 'spec', status: 'approved', approved: true }).mutability !== 'LOCKED') return 'approved spec 应为 LOCKED'
      if (evaluateMutability({ ledger: { status: 'verify-failed' } }).mutability !== 'OPEN') return 'verify-failed 应为 OPEN'
      if (evaluateMutability({ ledger: { status: 'merged' } }).terminal !== true) return 'merged 应为 terminal=true'

      // 2. init --kind prd --multi-spec 在默认分支不建无账本孤儿 worktree，且 doc-plan slice 正常工作
      const masterRes = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        kind: 'prd', slug: 'master-p', title: 'Master P', owner: 'arch', multiSpec: true,
        criteria: ['切片 A 完成', '切片 B 完成'],
      })
      if (masterRes.worktreePath || !existsSync(join(dir, masterRes.file))) {
        return `init --kind prd --multi-spec 误建孤儿工作树或未落盘主仓：${JSON.stringify(masterRes)}`
      }
      const sliceRes = await sliceSpec({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        relatedPrd: masterRes.file, specSlug: 'slice-one', title: 'Slice One', owner: 'arch',
        scopePaths: ['src/mod-a.mjs'], criteria: ['完成 C1 (`src/mod-a.mjs` exit 0)'], dependsOn: [], inPlace: true,
      })
      if (!existsSync(join(dir, sliceRes.file))) return `sliceSpec 失败：${JSON.stringify(sliceRes)}`

      // 3. 独立 SPEC 并行共存（显式互不相交 scope_files -> checkOrphanSlices=0；缺 scope_files -> 仍报）
      const isoDir = tmpProject({
        'docs/specs/261125-issue1-a-spec.md': '---\nkind: spec\ntitle: "A"\nstatus: draft\ntier: L3\nscope_files: [src/mod-a.mjs]\ndepends_on: []\n---\n# A\n- [ ] C1: `src/mod-a.mjs` 独立完成\n',
        'docs/specs/261125-issue2-b-spec.md': '---\nkind: spec\ntitle: "B"\nstatus: draft\ntier: L3\nscope_files: [src/mod-b.mjs]\ndepends_on: []\n---\n# B\n- [ ] C1: `src/mod-b.mjs` 独立完成\n',
      })
      try {
        const indep = checkOrphanSlices(isoDir)
        if (indep.length !== 0) return `互不相交独立 SPEC 被误报孤立：${JSON.stringify(indep)}`
        writeFileSync(join(isoDir, 'docs/specs/261125-issue2-b-spec.md'), '---\nkind: spec\ntitle: "B"\nstatus: draft\ntier: L3\n---\n# B\n- [ ] C1: `src/mod-b.mjs` 缺写域\n', 'utf8')
        const missingScope = checkOrphanSlices(isoDir)
        if (!missingScope.some((e) => e.code === 'ORPHAN_SLICES_NO_MASTER_PRD')) {
          return `缺 scope_files 的无主 SPEC 未触发 ORPHAN_SLICES_NO_MASTER_PRD：${JSON.stringify(missingScope)}`
        }
      } finally { rmTree(isoDir) }

      // 4. clarify 冻结守卫 (BLOCKED_DOC_FROZEN) + --drop-criterion 授权删减与防静默删减退化
      const prdAbs = join(dir, masterRes.file)
      writeFileSync(prdAbs, readFileSync(prdAbs, 'utf8').replace(/<[^>]+>/g, '`src/mod-a.mjs`'), 'utf8')
      await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', masterRes.file, '--reviewer', 'crit-prd', '--round', '1', '--summary', 'prd ok', '--json',
      ], { cwd: dir })
      approveSpec({ repoRoot: dir, mainRoot: dir, file: masterRes.file })

      const specAbs = join(dir, sliceRes.file)
      const cleanedSpec = readFileSync(specAbs, 'utf8')
        .replace(/<[^>]+>/g, '`src/mod-a.mjs`')
        .replace(/^- \[ \] C1:.*$/m, '- [ ] C1: `src/mod-a.mjs` 测试 `exit 0`\n- [ ] C2: `src/mod-b.mjs` 辅助校验 `exit 0`')
      writeFileSync(specAbs, cleanedSpec, 'utf8')
      const baseSnap = extractDocSnapshot(cleanedSpec)
      await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', sliceRes.file, '--reviewer', 'crit-s2', '--round', '1', '--summary', 'ok', '--json',
      ], { cwd: dir })
      approveSpec({ repoRoot: dir, mainRoot: dir, file: sliceRes.file })

      let frozenErr = null
      try {
        clarifyDoc({ repoRoot: dir, file: sliceRes.file, decision: '偷偷改规范', by: 'user', explicitBy: 'user' })
      } catch (e) { frozenErr = e }
      if (!frozenErr || frozenErr.code !== 'BLOCKED_DOC_FROZEN' || (frozenErr.details?.safeExits?.length ?? 0) < 3) {
        return `LOCKED 文档未触发 BLOCKED_DOC_FROZEN 或缺少 3 条安全出口：${JSON.stringify(frozenErr)}`
      }

      const dropRes = clarifyDoc({
        repoRoot: dir, file: sliceRes.file, dropCriterion: 'C2', reason: 'C2 拆至后续切片', by: 'user', explicitBy: 'user',
      })
      if (dropRes.droppedCriterion?.id !== 'C2') return `drop-criterion 未生效：${JSON.stringify(dropRes)}`
      const regOk = checkDocRegression(baseSnap, extractDocSnapshot(readFileSync(specAbs, 'utf8')), 'test')
      if (regOk.errors.some((e) => e.code === 'DOC_REGRESSION_CRITERIA_DROPPED')) {
        return `授权 --drop-criterion 仍被误判为静默退化：${JSON.stringify(regOk.errors)}`
      }
      // 反向：再静默删除 C1（未授权）必须拦截 DOC_REGRESSION_CRITERIA_DROPPED
      const silentCut = readFileSync(specAbs, 'utf8').replace(/^- \[ \] C1:.*\n?/m, '')
      const regSilent = checkDocRegression(baseSnap, extractDocSnapshot(silentCut), 'test')
      if (!regSilent.errors.some((e) => e.code === 'DOC_REGRESSION_CRITERIA_DROPPED')) {
        return `未授权静默删减 C1 未拦截：${JSON.stringify({ baseSnap, regSilent })}`
      }

      // 5. doc-plan archive --drop --reason 落入 dropped 终态，flow abort 同步标记非共享文档 dropped
      const archDrop = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'archive', sliceRes.file, '--drop', '--reason', '需求取消', '--json',
      ], { cwd: dir })
      if (archDrop.status !== 0) return `archive --drop 失败：${archDrop.stderr} ${archDrop.stdout}`
      const archSpecRel = JSON.parse(archDrop.stdout).archived?.[0]
      if (!archSpecRel || !/status:\s*dropped/.test(readFileSync(join(dir, archSpecRel), 'utf8'))) {
        return `archive --drop 未写入 status: dropped：${archDrop.stdout}`
      }

      const abortSpecRes = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        kind: 'spec', slug: 'abort-drop', title: 'Abort Drop', taskId: 'ab-drop', owner: 'arch', inPlace: true,
      })
      writeTaskLedger(dir, { taskId: 'ab-drop', slug: 'abort-drop', branch: 'main', baseBranch: 'main', specFile: abortSpecRes.file, status: 'started' })
      const abRes = await withQuietIo(() => handleAbort({ task: 'ab-drop', confirm: true, reason: '测试终止', json: true }, roots))
      if (abRes.res.exitCode !== 0 || !/status:\s*dropped/.test(readFileSync(join(dir, abortSpecRes.file), 'utf8'))) {
        return `flow abort 未将绑定活跃文档标为 dropped：${abRes.stdout} ${abRes.stderr}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Conv-S2 C7 & C8：rework --reopen 解锁与令牌撤销、ambiguous phase/mutability、batch 过滤冻结与 plan-next 防饿死', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# ConvS2C7\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/a.mjs': 'export const a = 1\n',
      'src/b.mjs': 'export const b = 2\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. LOCKED 任务未传 --reopen 拦截 BLOCKED_REWORK_REQUIRES_REOPEN；带 --reopen --reason 原子撤销未消费 reviewToken
      writeTaskLedger(dir, {
        taskId: 't-locked', slug: 't-locked', branch: 'feat/t-locked', baseBranch: 'main',
        status: 'submitted', submitted: true, reviewPassed: true, reviewPassedHead: 'a'.repeat(40),
        files: ['src/a.mjs'],
      })
      const lLocked = readTaskLedger(dir, 't-locked')
      const { token } = ensureReviewToken(dir, lLocked, 1, { reviewerId: 'rev-1', headSha: 'a'.repeat(40) })

      const blkRework = await withQuietIo(() => handleRework({ task: 't-locked', json: true }, roots))
      if (blkRework.res.exitCode !== 3 || !blkRework.stdout.includes('BLOCKED_REWORK_REQUIRES_REOPEN')) {
        return `LOCKED 任务未拦截直接 rework：exit=${blkRework.res.exitCode} out=${blkRework.stdout}`
      }
      const noReasonReopen = await withQuietIo(() => handleRework({ task: 't-locked', reopen: true, json: true }, roots))
      if (noReasonReopen.res.exitCode !== 2 || !noReasonReopen.stdout.includes('MISSING_REOPEN_REASON')) {
        return `reopen 缺 --reason 未拦截：exit=${noReasonReopen.res.exitCode} out=${noReasonReopen.stdout}`
      }
      const okReopen = await withQuietIo(() => handleRework({ task: 't-locked', reopen: true, reason: '补充边界测试', json: true }, roots))
      if (okReopen.res.exitCode !== 0) return `rework --reopen 失败：${okReopen.stderr} ${okReopen.stdout}`
      const lAfter = readTaskLedger(dir, 't-locked')
      if (lAfter.status !== 'rework' || lAfter.reviewPassed !== false || lAfter.submitted !== false) {
        return `rework --reopen 未清零冻结状态：${JSON.stringify(lAfter)}`
      }
      const tokTry = consumeReviewToken(lAfter, token, 1, { reviewerId: 'rev-1', headSha: 'a'.repeat(40) })
      if (tokTry.ok || !String(tokTry.reason).includes('REVIEW_TOKEN_REVOKED')) {
        return `reopen 后旧 reviewToken 仍可被消费：${JSON.stringify(tokTry)}`
      }

      // 2. ambiguous 暴露各任务精确 phase/mutability，并排除 LOCKED 任务进 wavePlan / batch plan
      writeTaskLedger(dir, {
        taskId: 't-open', slug: 't-open', branch: 'feat/t-open', baseBranch: 'main',
        status: 'verify-failed', files: ['src/b.mjs'], explored: { at: '2026-11-25T00:00:00Z' },
      })
      writeTaskLedger(dir, {
        taskId: 't-frozen', slug: 't-frozen', branch: 'feat/t-frozen', baseBranch: 'main',
        status: 'submitted', submitted: true, reviewPassed: true, files: ['src/a.mjs'],
      })
      const nextAmb = evaluateNextState({
        activeTasks: [readTaskLedger(dir, 't-open'), readTaskLedger(dir, 't-frozen')],
        repoRoot: dir,
      })
      const openCand = nextAmb.candidates.find((c) => c.taskId === 't-open')
      const frozenCand = nextAmb.candidates.find((c) => c.taskId === 't-frozen')
      if (openCand?.phase !== 'needs-verify' || openCand?.mutability !== 'OPEN'
        || frozenCand?.phase !== 'ready-to-merge' || frozenCand?.mutability !== 'LOCKED') {
        return `ambiguous candidates 缺精确 phase/mutability：${JSON.stringify(nextAmb.candidates)}`
      }
      if (nextAmb.wavePlan?.order?.includes('t-frozen')) {
        return `ambiguous wavePlan 未排除 LOCKED 任务：${JSON.stringify(nextAmb.wavePlan)}`
      }
      const batchOut = await withQuietIo(() => handleBatch({ _: ['plan'], tasks: 't-open,t-frozen', json: true }, roots))
      const batchJson = JSON.parse(batchOut.stdout)
      if (batchJson.order.includes('t-frozen') || !batchJson.excludedLockedTasks?.some((x) => x.taskId === 't-frozen')) {
        return `batch plan 未排除冻结任务：${batchOut.stdout}`
      }

      // 3. plan-next 在 --task 同命中 PRD+SPEC 时优先未就绪 PRD，且不饿死次级活跃规划
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      writeFileSync(join(dir, 'docs/prd/261125-master-prd.md'), '---\nkind: prd\ntitle: "M"\nstatus: draft\ntask_id: combo-t\nmulti_spec: true\nowner: p\n---\n# M\n- [ ] C1: x\n', 'utf8')
      writeFileSync(join(dir, 'docs/specs/261125-combo-spec.md'), '---\nkind: spec\ntitle: "S"\nstatus: draft\ntier: L3\ntask_id: combo-t\nrelated_prd: ../prd/261125-master-prd.md\nowner: p\n---\n# S\n- [ ] C1: y\n', 'utf8')
      const pNext1 = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, taskId: 'combo-t', auditDocFn: auditDoc })
      if (!pNext1.doc?.file?.endsWith('-master-prd.md')) {
        return `--task 同命中未就绪 PRD+SPEC 时未优先 PRD：${JSON.stringify(pNext1.doc)}`
      }
      // 批准 master PRD 与 combo-spec 后，新增次级 draft SPEC 不应被已过审 SPEC 饿死
      writeFileSync(join(dir, 'docs/prd/261125-master-prd.md'), '---\nkind: prd\ntitle: "M"\nstatus: active\nplan_critique: passed\nmulti_spec: true\nowner: p\n---\n# M\n- [ ] C1: x\n', 'utf8')
      writeFileSync(join(dir, 'docs/specs/261125-combo-spec.md'), '---\nkind: spec\ntitle: "S"\nstatus: approved\napproved: true\nplan_critique: passed\ntier: L3\nrelated_prd: ../prd/261125-master-prd.md\nowner: p\n---\n# S\n- [ ] C1: y\n', 'utf8')
      writeFileSync(join(dir, 'docs/specs/261125-secondary-spec.md'), '---\nkind: spec\ntitle: "Sec"\nstatus: draft\ntier: L3\nscope_files: [src/b.mjs]\ndepends_on: []\nowner: p\n---\n# Sec\n- [ ] C1: z\n', 'utf8')
      const pNext2 = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, auditDocFn: auditDoc })
      if (!pNext2.doc?.file?.endsWith('-secondary-spec.md')) {
        return `次级活跃规划被已过审切片饿死：${JSON.stringify(pNext2.doc)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
