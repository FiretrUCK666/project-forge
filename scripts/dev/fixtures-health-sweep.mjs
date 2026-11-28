/**
 * fixtures-health-sweep.mjs —— 全仓体检四项根因修复与热点盲区正反双向夹具。
 *
 * 覆盖：
 *   [HS-1] evaluateMasterIssueCloseGuard：multi_spec 总控缺 issue 不误锁子切片工单，真总控仍保护
 *   [HS-2] verify-state / review-context / flow-merge / flow-cleanup：worktree 继承 main 基线、
 *          unbaselined 不误入 healthyTools、合入同步晋升 main 与双槽回收
 *   [HS-3] 热点模块集成边界：exec.mjs、pr-template-hydrate.mjs、doc-slice-graph.mjs、
 *          critique-rounds.mjs、flow-cleanup.mjs（零 >=1s sleep、零 mock 自证）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { checkDistinctRoundReviewer, evaluateThreeRoundStopLoss } from '../../kit/skills/lib/critique-rounds.mjs'
import {
  DERIVED_MANIFEST_PATHS, buildSliceGraph, checkSliceGraphCycles,
  checkWaveScopeOverlap, compileScopePattern, scopesOverlap,
} from '../../kit/skills/lib/doc-slice-graph.mjs'
import { computeWorktreeEnv, execShellCommand, withFileLock, withFileLockSync } from '../../kit/skills/lib/exec.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { assertWellFormedMarkdownBody, hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import {
  evaluateToolStaleness, readVerifyCache, reclaimVerifySlotCache,
  syncVerifyCacheOnMerge, writeVerifyCacheEntry,
} from '../../kit/skills/lib/verify-state.mjs'
import { handleCleanup } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { evaluateMasterIssueCloseGuard } from '../../kit/skills/dev-flow/scripts/flow-merge-claim.mjs'
import { assembleReviewContext } from '../../kit/skills/dev-review/scripts/review-context.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const VT_SCRIPT = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'

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

export function registerHealthSweepCases(cases) {
  cases.push(['[HS-1] evaluateMasterIssueCloseGuard：总控缺 issue 时不误锁子切片工单，真总控未完兄弟仍保护', async () => {
    const dir = tmpProject({
      'docs/prd/261124-master-prd.md': [
        '---', 'kind: prd', 'title: "Master PRD"', 'status: active', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-24', 'issue: null', 'owner: planner',
        'multi_spec: true', 'plan_critique: passed', '---',
        '# Master PRD', '', '- [ ] C1: slice 1', '- [ ] C2: slice 2', '',
      ].join('\n'),
      'docs/specs/261124-issue176-s1-spec.md': [
        '---', 'kind: spec', 'title: "Slice 1"', 'status: implemented', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-25', 'issue: 176', 'task_id: s1',
        'owner: planner', 'approved: true', 'implemented: true',
        'related_prd: ../prd/261124-master-prd.md', 'scope_files: [src/a.mjs]', '---',
        '# S1', '- [x] C1: done', '',
      ].join('\n'),
      'docs/specs/261124-s2-spec.md': [
        '---', 'kind: spec', 'title: "Slice 2"', 'status: draft', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-25', 'issue: 178', 'task_id: s2',
        'owner: planner', 'approved: false', 'implemented: false',
        'related_prd: ../prd/261124-master-prd.md', 'scope_files: [src/b.mjs]', '---',
        '# S2', '- [ ] C2: todo', '',
      ].join('\n'),
    })
    try {
      gitInit(dir, { branch: 'main' })
      // 1. 正面：总控 PRD issue: null 时，合入子切片 #176 绝不能误触发关单保护
      const sliceGuard = evaluateMasterIssueCloseGuard({
        mainRoot: dir,
        issueNumber: 176,
        taskId: 's1',
        ledger: {
          taskId: 's1',
          prdFile: 'docs/prd/261124-master-prd.md',
          specFile: 'docs/specs/261124-issue176-s1-spec.md',
          planBootstrap: false,
        },
      })
      if (sliceGuard.shouldClose !== true || sliceGuard.isMasterPrd !== false) {
        return `总控缺 issue 时子切片 #176 误触发关单保护：${JSON.stringify(sliceGuard)}`
      }

      // 2. 即使子 SPEC 未填 issue（仅 ledger 绑定 specFile 且非 planBootstrap），也不得误认作总控 Issue
      const unnamedSliceGuard = evaluateMasterIssueCloseGuard({
        mainRoot: dir,
        issueNumber: 199,
        taskId: 's1',
        ledger: {
          taskId: 's1',
          prdFile: 'docs/prd/261124-master-prd.md',
          specFile: 'docs/specs/261124-issue176-s1-spec.md',
          planBootstrap: false,
        },
      })
      if (unnamedSliceGuard.shouldClose !== true || unnamedSliceGuard.isMasterPrd !== false) {
        return `切片任务自带工单 #199 误触发总控关单保护：${JSON.stringify(unnamedSliceGuard)}`
      }

      // 3. 总控 PRD issue: null 且为 planBootstrap 时，仍保护总控 Issue #169 开启
      const bootGuard = evaluateMasterIssueCloseGuard({
        mainRoot: dir,
        issueNumber: 169,
        taskId: 'boot',
        ledger: {
          taskId: 'boot',
          prdFile: 'docs/prd/261124-master-prd.md',
          specFile: 'docs/specs/261124-s2-spec.md',
          planBootstrap: true,
        },
      })
      if (bootGuard.shouldClose !== false || bootGuard.isMasterPrd !== true) {
        return `总控缺 issue 的 planBootstrap 未触发保护：${JSON.stringify(bootGuard)}`
      }

      // 4. 反面：总控 PRD 明确填了 issue: 169 且存在未完成兄弟切片 s2 时，#169 仍必须保持开启
      const prdWithIssue = [
        '---', 'kind: prd', 'title: "Master PRD"', 'status: active', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-24', 'issue: 169', 'owner: planner',
        'multi_spec: true', 'plan_critique: passed', '---',
        '# Master PRD', '', '- [ ] C1: slice 1', '- [ ] C2: slice 2', '',
      ].join('\n')
      writeFileSync(join(dir, 'docs/prd/261124-master-prd.md'), prdWithIssue, 'utf8')
      const masterGuard = evaluateMasterIssueCloseGuard({
        mainRoot: dir,
        issueNumber: 169,
        taskId: 's1',
        ledger: {
          taskId: 's1',
          prdFile: 'docs/prd/261124-master-prd.md',
          specFile: 'docs/specs/261124-issue176-s1-spec.md',
          planBootstrap: false,
        },
      })
      if (masterGuard.shouldClose !== false || !masterGuard.isMasterPrd || masterGuard.remainingSiblings.length !== 1) {
        return `真总控 #169 有未完兄弟切片时未保护开启：${JSON.stringify(masterGuard)}`
      }

      // 5. 全部切片达终态后，真总控 #169 允许关闭
      writeFileSync(join(dir, 'docs/specs/261124-s2-spec.md'), [
        '---', 'kind: spec', 'title: "Slice 2"', 'status: implemented', 'tier: L3',
        'created: 2026-11-24', 'updated: 2026-11-25', 'issue: 178', 'task_id: s2',
        'owner: planner', 'approved: true', 'implemented: true',
        'related_prd: ../prd/261124-master-prd.md', 'scope_files: [src/b.mjs]', '---',
        '# S2', '- [x] C2: done', '',
      ].join('\n'), 'utf8')
      const closedMaster = evaluateMasterIssueCloseGuard({
        mainRoot: dir,
        issueNumber: 169,
        taskId: 's2',
        ledger: { taskId: 's2', prdFile: 'docs/prd/261124-master-prd.md', specFile: 'docs/specs/261124-s2-spec.md' },
      })
      if (closedMaster.shouldClose !== true || closedMaster.reason !== 'all-slices-terminal') {
        return `全部切片终态后总控 #169 未放行关单：${JSON.stringify(closedMaster)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[HS-2] verify-state worktree 继承 main 基线、review-context 不误放 unbaselined 与合入同步晋升', async () => {
    const fmObj = {
      version: 1,
      features: [{
        id: 'core',
        name: 'Core',
        entrypoints: ['src/core.mjs'],
        modules: ['src/core.mjs'],
        businessFlows: ['core flow'],
        verificationTools: [{
          id: 'verify-core',
          kind: 'command',
          command: 'node -e "console.log(\'CORE_OK\')"',
          scriptPath: null,
          riskLevel: 'high',
          triggerHints: ['core'],
        }],
        testRefs: [],
      }],
    }
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# HS2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/core.mjs': 'export const computeCore = (x) => x + 1\n',
      'docs/feature-map.json': JSON.stringify(fmObj, null, 2),
    })
    const freshDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Fresh\n',
      'src/core.mjs': 'export const computeCore = (x) => x + 1\n',
      'docs/feature-map.json': JSON.stringify(fmObj, null, 2),
    })
    gitInit(dir, { branch: 'main' })
    gitInit(freshDir, { branch: 'main' })
    const implWt = join(dir, '.worktrees', 'impl-hs2')
    try {
      const feature = fmObj.features[0]
      const tool = feature.verificationTools[0]

      // 1. 无任何基线的新仓：evaluateToolStaleness 仍精确报 unbaselined；review-context 不误入 healthyTools
      const freshRoots = await resolveRepoRoots(freshDir)
      const freshStale = await evaluateToolStaleness({
        repoRoot: freshDir, gitCommonDir: freshRoots.gitDir, mainRoot: freshDir, feature, tool, baseRef: 'main',
      })
      if (freshStale.status !== 'unbaselined') {
        return `无基线隔离仓应报 unbaselined，实际：${JSON.stringify(freshStale)}`
      }
      writeFileSync(join(freshDir, 'src/core.mjs'), 'export const computeCoreV2 = (x) => x + 2\n', 'utf8')
      const freshRc = await assembleReviewContext({
        reviewRoot: freshDir, mainRoot: freshDir, gitDir: freshRoots.gitDir,
        diff: { files: [{ file: 'src/core.mjs' }], untracked: [] },
        effectiveProfile: {}, baseRef: 'main', task: { taskId: 'fresh-t' },
      })
      if (freshRc.healthyToolCommands.length > 0 || (freshRc.unbaselinedTools?.length ?? 0) !== 1 || freshRc.empiricalTaskOrder.strategy !== 'unbaselined-tools') {
        return `review-context 不应把 unbaselined 高风险工具误算作 healthyTools：${JSON.stringify({ healthy: freshRc.healthyToolCommands, unbaselined: freshRc.unbaselinedTools, order: freshRc.empiricalTaskOrder })}`
      }

      // 2. 有 main 基线后，派生 worktree 未改受监控符号时继承 main -> fresh；改导出符号 -> stale（不再静默 unbaselined）
      const roots = await resolveRepoRoots(dir)
      const mainInit = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 'verify-core', '--json'], { cwd: dir })
      if (mainInit.status !== 0) return `main 基线初始化失败：${mainInit.stderr}`
      gitSync(dir, ['worktree', 'add', '-b', 'feat/hs2', implWt, 'main'])

      const wtClean = await evaluateToolStaleness({
        repoRoot: implWt, gitCommonDir: roots.gitDir, mainRoot: dir, feature, tool, baseRef: 'main',
      })
      if (wtClean.status !== 'fresh') {
        return `未改动受监控模块的 worktree 未继承 main 基线返回 fresh：${JSON.stringify(wtClean)}`
      }

      writeFileSync(join(implWt, 'src/core.mjs'), 'export const computeCoreRenamed = (x) => x + 2\n', 'utf8')
      gitCommitFast(implWt, 'feat: rename exported core symbol', { updateOnly: true })
      const wtHead = gitSync(implWt, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      const wtStale = await evaluateToolStaleness({
        repoRoot: implWt, gitCommonDir: roots.gitDir, mainRoot: dir, feature, tool, baseRef: 'main',
      })
      if (wtStale.status !== 'stale' || wtStale.code !== 'BLOCKED_STALE_HIGH_RISK_TOOL') {
        return `worktree 改动受监控导出符号未继承 main 基线并拦截 stale：${JSON.stringify(wtStale)}`
      }

      const wtRc = await assembleReviewContext({
        reviewRoot: implWt, mainRoot: dir, gitDir: roots.gitDir,
        diff: { files: [{ file: 'src/core.mjs' }], untracked: [] },
        effectiveProfile: {}, baseRef: 'main', headSha: wtHead, task: { taskId: 'hs2' },
      })
      if (wtRc.staleHighRiskTools.length !== 1 || wtRc.empiricalTaskOrder.strategy !== 'stale-high-risk-blocked') {
        return `review-context 在 worktree 中未拦截高风险过期工具：${JSON.stringify(wtRc.empiricalTaskOrder)}`
      }

      // 3. 在 worktree 跑 verify-tools run --stale --refresh-baseline 刷新槽位缓存 -> 合入 main 后 syncVerifyCacheOnMerge 晋升 main 基线
      const wtRefresh = await runAbsAsync(VT_SCRIPT, ['run', '--stale', '--refresh-baseline', '--json'], { cwd: implWt })
      if (wtRefresh.status !== 0) return `worktree verify-tools run --stale --refresh-baseline 失败：${wtRefresh.stdout} ${wtRefresh.stderr}`

      // 负面校验：main 尚未合入前调用 syncVerifyCacheOnMerge 必须因指纹不一致跳过晋升，绝不假绿
      const preMergeSync = await syncVerifyCacheOnMerge({
        gitCommonDir: roots.gitDir, mainRoot: dir,
        slotKeys: ['.worktrees/impl-hs2'], verifiedSha: wtHead,
      })
      if (preMergeSync.promoted.length !== 0 || preMergeSync.skipped.length !== 1) {
        return `main 内容尚不一致时 syncVerifyCacheOnMerge 不得错误晋升：${JSON.stringify(preMergeSync)}`
      }

      // 合入 main 后再同步 -> main 晋升且 verify-tools audit 全绿
      gitSync(dir, ['merge', '--ff-only', 'feat/hs2'])
      const postMergeSync = await syncVerifyCacheOnMerge({
        gitCommonDir: roots.gitDir, mainRoot: dir,
        slotKeys: ['.worktrees/review-hs2', '.worktrees/impl-hs2'], verifiedSha: wtHead,
      })
      if (postMergeSync.promoted.length !== 1) {
        return `合入后 syncVerifyCacheOnMerge 未晋升 main 基线：${JSON.stringify(postMergeSync)}`
      }
      const mainAudit = await runAbsAsync(VT_SCRIPT, ['audit', dir, '--json'], { cwd: dir })
      const mainAuditJson = JSON.parse(mainAudit.stdout)
      if (!mainAuditJson.ok || mainAuditJson.staleTools.length > 0) {
        return `合入晋升后 main verify-tools audit 仍过期：${mainAudit.stdout}`
      }

      // 4. reclaimVerifySlotCache 同时清理 impl 与 review 槽位，不误伤 main
      writeVerifyCacheEntry(roots.gitDir, dir, 'verify-core', { featureId: 'core', symbolHash: 'x', moduleTreeHash: 'y', slotKey: '.worktrees/review-hs2' })
      reclaimVerifySlotCache(roots.gitDir, '.worktrees/impl-hs2', dir)
      reclaimVerifySlotCache(roots.gitDir, '.worktrees/review-hs2', dir)
      const cacheAfter = readVerifyCache(roots.gitDir, dir)
      if (cacheAfter.slots['.worktrees/impl-hs2'] || cacheAfter.slots['.worktrees/review-hs2'] || !cacheAfter.slots.main?.['verify-core']) {
        return `槽位回收异常或误删 main 基线：${JSON.stringify(Object.keys(cacheAfter.slots))}`
      }

      // 5. cache.json > 512KB 时 readVerifyCache / writeVerifyCacheEntry 不得因默认 512KB 截断而静默清零 main 基线
      const bigPadding = 'z'.repeat(600 * 1024)
      writeVerifyCacheEntry(roots.gitDir, dir, 'verify-big-pad', { featureId: 'pad', symbolHash: 'p', moduleTreeHash: bigPadding, slotKey: '.worktrees/pad-slot' })
      writeVerifyCacheEntry(roots.gitDir, dir, 'verify-after-big', { featureId: 'core', symbolHash: 'a', moduleTreeHash: 'b', slotKey: '.worktrees/other-slot' })
      const bigCache = readVerifyCache(roots.gitDir, dir)
      if (!bigCache.slots?.main?.['verify-core'] || !bigCache.slots?.['.worktrees/other-slot']?.['verify-after-big']) {
        return `cache.json 超 512KB 时发生静默清零：${JSON.stringify(Object.keys(bigCache.slots ?? {}))}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(freshDir)
    }
  }])

  cases.push(['[HS-3] 热点模块边界集成：exec、pr-template-hydrate、doc-slice-graph、critique-rounds 与 flow-cleanup', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.github/pull_request_template.md': [
        '<!-- 模板注释 -->',
        '## 变更摘要',
        '<!-- 填写 -->',
        '## 关联 Issue 与文档',
        '## 验证证据',
        '## 自查',
        '- [ ] 已通过本地测试验证',
        '- [ ] 已同步文档与归档',
      ].join('\n'),
      'docs/prd/261124-m-prd.md': '---\nkind: prd\ntitle: "M"\nstatus: active\nissue: 500\nmulti_spec: true\nowner: p\n---\n# M\n- [ ] C1: a\n- [ ] C2: b\n',
      'docs/specs/261124-a-spec.md': '---\nkind: spec\ntitle: "A"\nstatus: approved\ntier: L3\nissue: 501\ntask_id: slice-a\nowner: p\nrelated_prd: ../prd/261124-m-prd.md\ndepends_on: []\nscope_files: [src/lib/**, .agents/skills/.pf-manifest.json]\n---\n# A\n- [ ] C1: a\n',
      'docs/specs/261124-b-spec.md': '---\nkind: spec\ntitle: "B"\nstatus: approved\ntier: L3\nissue: 502\ntask_id: slice-b\nowner: p\nrelated_prd: ../prd/261124-m-prd.md\ndepends_on: []\nscope_files: [src/lib/sub.mjs, .agents/skills/.pf-manifest.json]\n---\n# B\n- [ ] C2: b\n',
      'docs/specs/261124-c-spec.md': '---\nkind: spec\ntitle: "C"\nstatus: approved\ntier: L3\nissue: 503\ntask_id: slice-c\nowner: p\nrelated_prd: ../prd/261124-m-prd.md\ndepends_on: [slice-c, missing-dep]\nscope_files: [src/other.mjs]\n---\n# C\n- [ ] C3: c\n',
      'src/lib/sub.mjs': 'export const sub = 1\n',
    })
    try {
      gitInit(dir, { branch: 'main' })
      const roots = await resolveRepoRoots(dir)

      // 1. exec.mjs: direct node args via execShellCommand, exit shortcut, missing cwd, withFileLock dead-PID recovery, computeWorktreeEnv
      const directExec = await execShellCommand('node -e "console.log(process.argv[1])" "hello world"', dir)
      if (!directExec.ok || directExec.stdout.trim() !== 'hello world') {
        return `execShellCommand 直通引号参数执行异常：${JSON.stringify(directExec)}`
      }
      const exitShortcut = await execShellCommand('exit 3', dir)
      if (exitShortcut.ok || exitShortcut.code !== 3) {
        return `execShellCommand exit 3 捷径返回异常：${JSON.stringify(exitShortcut)}`
      }
      const missingCwd = await execShellCommand('exit 0', join(dir, 'no-such-dir'))
      if (missingCwd.ok || missingCwd.code !== 1) {
        return `execShellCommand 缺失目录未安全返回失败：${JSON.stringify(missingCwd)}`
      }
      const lockFile = join(dir, '.git', 'hs3-dead.lock')
      writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'dead', createdAt: Date.now() - 500 }), 'utf8')
      let lockRan = false
      await withFileLock(lockFile, async () => { lockRan = true }, { timeoutMs: 300, staleMs: 20, pollMs: 10 })
      if (!lockRan || existsSync(lockFile)) {
        return `withFileLock 未回收过期死锁或未释放锁文件：lockRan=${lockRan}`
      }
      const syncVal = withFileLockSync(lockFile, () => 42, { timeoutMs: 200, staleMs: 50, pollMs: 5 })
      if (syncVal !== 42 || existsSync(lockFile)) return `withFileLockSync 执行或释放异常：${syncVal}`
      const wtEnv = computeWorktreeEnv({ mainRoot: dir, gitDir: roots.gitDir, taskId: 'a/b:c' })
      if (!wtEnv.PF_PORT || !existsSync(wtEnv.PF_CACHE_DIR)) {
        return `computeWorktreeEnv 未建立隔离缓存目录：${JSON.stringify(wtEnv)}`
      }

      // 2. pr-template-hydrate.mjs: fence heading allowed, collapsed headings blocked, backtick preservation & dedup
      assertWellFormedMarkdownBody('```md\n## a ## b\n```\n\n## 正文\n\nok\n', 'fence-ok')
      let collapseErr = null
      try {
        assertWellFormedMarkdownBody('## 摘要 ## 验证', 'collapsed')
      } catch (err) { collapseErr = err }
      if (!collapseErr || collapseErr.code !== 'BLOCKED_MALFORMED_MARKDOWN_BODY') {
        return `单行折叠标题未抛 BLOCKED_MALFORMED_MARKDOWN_BODY：${collapseErr?.code}`
      }
      const prBody = hydratePrTemplateBody({
        repoRoot: dir,
        taskId: 'slice-a',
        ledger: {
          taskId: 'slice-a', caseType: 4, branch: 'feat/slice-a',
          specFile: 'docs/specs/261124-a-spec.md', prdFile: 'docs/prd/261124-m-prd.md',
          linkedIssues: [500, 501], finalized: true, lastVerifyExitCode: 0, verifiedHead: 'deadbeef',
        },
        currentHead: 'deadbeef',
        changedFiles: ['src/lib/sub.mjs'],
        rawBody: 'Fixes #501\n保留补充说明',
      })
      if (!prBody.includes('Part of #500') || !prBody.includes('Fixes #501') || (prBody.match(/Fixes #501/g) ?? []).length !== 1 || !prBody.includes('- [x] 已通过本地测试验证')) {
        return `hydratePrTemplateBody 主控/切片引用、去重或清单勾选异常：\n${prBody}`
      }

      // 3. doc-slice-graph.mjs: glob overlap + DERIVED_MANIFEST_PATHS exemption + self-loop/dangling detection
      const patA = compileScopePattern('src/lib/**')
      const patB = compileScopePattern('src/lib/sub.mjs')
      if (!scopesOverlap(patA, patB) || DERIVED_MANIFEST_PATHS.length === 0) {
        return 'scopesOverlap 未检出 glob 与子文件重叠'
      }
      const graph = buildSliceGraph(dir)
      const cycleErrs = checkSliceGraphCycles(dir, graph)
      if (!cycleErrs.some((e) => e.cycle?.includes('slice-c')) || !cycleErrs.some((e) => e.dangling && e.dep === 'missing-dep')) {
        return `checkSliceGraphCycles 未检出自环或悬空依赖：${JSON.stringify(cycleErrs)}`
      }
      const overlapWarns = checkWaveScopeOverlap(dir, graph)
      if (!overlapWarns.some((w) => w.code === 'SLICE_SERIAL_BY_OVERLAP') || overlapWarns.some((w) => w.overlaps?.some(([x]) => x === DERIVED_MANIFEST_PATHS[0]))) {
        return `checkWaveScopeOverlap 写域相交或派生清单豁免异常：${JSON.stringify(overlapWarns)}`
      }

      // 4. critique-rounds.mjs: distinct reviewer lock + 3-round / repeated blocker stop-loss + roundBaseline
      const rounds = [{ round: 1, reviewerId: 'Critic-Alpha', verdict: 'rejected', findings: ['[major] 缺异常码'] }]
      const sameRev = checkDistinctRoundReviewer(rounds, '@critic-alpha', { minRound: 2, currentRound: 2 })
      const diffRev = checkDistinctRoundReviewer(rounds, 'critic-beta', { minRound: 2, currentRound: 2 })
      if (!sameRev.blocked || diffRev.blocked) {
        return `checkDistinctRoundReviewer 大小写/@ 归一化或放行异常：same=${sameRev.blocked} diff=${diffRev.blocked}`
      }
      const repStop = evaluateThreeRoundStopLoss({
        round: 2, verdict: 'rejected', items: ['[major] 缺异常码'], prevItems: ['[major] 缺异常码'],
      })
      const postContinueOk = evaluateThreeRoundStopLoss({
        round: 4, verdict: 'rejected', items: ['[major] 新问题'], prevItems: ['[major] 旧问题'], roundBaseline: 3,
      })
      if (!repStop.stopLoss || repStop.exitCode !== EXIT.HUMAN || postContinueOk.stopLoss) {
        return `evaluateThreeRoundStopLoss 重复阻塞或 roundBaseline 判定异常：rep=${JSON.stringify(repStop)} cont=${JSON.stringify(postContinueOk)}`
      }

      // 5. flow-cleanup.mjs: 缺少 --confirm 必须阻断 BLOCKED_CONFIRMATION_REQUIRED；错 previewHash 必须阻断
      const { writeTaskLedger } = await import('../../kit/skills/lib/ledger.mjs')
      writeTaskLedger(dir, { taskId: 'cl-t', status: 'merged', branch: 'feat/cl-t', baseBranch: 'main', role: 'local-only', linkedIssues: [] })
      const noConf = await withQuietIo(() => handleCleanup({ task: 'cl-t', json: true }, roots))
      if (noConf.res.exitCode !== EXIT.FACT || !noConf.stdout.includes('BLOCKED_CONFIRMATION_REQUIRED')) {
        return `handleCleanup 缺 --confirm 未阻断：exit=${noConf.res.exitCode} out=${noConf.stdout}`
      }
      const badHash = await withQuietIo(() => handleCleanup({ task: 'cl-t', confirm: true, 'preview-hash': '00000000', json: true }, roots))
      if (badHash.res.exitCode !== EXIT.FACT || !badHash.stdout.includes('previewHash')) {
        return `handleCleanup 错 preview-hash 未阻断：exit=${badHash.res.exitCode} out=${badHash.stdout}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
