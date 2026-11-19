#!/usr/bin/env node
/**
 * fixtures-verify-tools.mjs —— 验证工具生命周期（dev-verify-tools）、docs/feature-map.json 单源、
 * 仓外 scratch 销毁与跨 >=2 PR 固化提示、免手工日期过时校验与先实证后 Diff 审查正反双向夹具。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现执行，也可直接运行 `node scripts/dev/fixtures-verify-tools.mjs`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import {
  FEATURE_MAP_REL, destroyTaskScratchDir, detectScratchSolidificationHints,
  ensureTaskScratchDir, isSafeTaskScratchPath, matchFeatureMapForPaths,
  readFeatureMap, readVerifyCache, resolveTaskScratchDir, validateE2eEvidenceText,
  validateFeatureMap, writeFeatureMap,
} from '../../kit/skills/lib/feature-map.mjs'
import { isMainModule, resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readSignalsJsonl } from '../../kit/skills/lib/signals.mjs'
import { validateVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import { handleAbort, handleCleanup } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  let out = ''
  let err = ''
  const origOut = process.stdout.write
  const origErr = process.stderr.write
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

const VT_SCRIPT = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
const RP_SCRIPT = 'kit/skills/dev-review/scripts/review-pack.mjs'
const RM_SCRIPT = 'kit/skills/dev-explore/scripts/repo-map.mjs'

export function registerVerifyToolsCases(cases) {
  cases.push(['StageC C9：feature-map 单源 Schema、增量预填、matchFeatureMapForPaths 与 Fail-Soft/Fail-Closed 正反双向', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# fm-demo\n\n## Dev Profile\n```yaml\nquick-test: node test/app.test.mjs\nsmoke-verify: node src/app.mjs\n```\n',
      'package.json': '{"name":"fm-demo","version":"1.0.0","main":"src/app.mjs"}\n',
      'src/app.mjs': 'export function greet(name) { return `hi ${name}` }\nif (process.argv[1]?.endsWith("app.mjs")) console.log(greet("ok"))\n',
      'test/app.test.mjs': 'import assert from "node:assert/strict"\nimport { greet } from "../src/app.mjs"\nassert.equal(greet("x"), "hi x")\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@fm.test' })
    try {
      // 1. 缺文件 Fail-Soft：matchFeatureMapForPaths 返回空切片不抛异常
      const missingRes = matchFeatureMapForPaths(dir, ['src/app.mjs'], ['greet'])
      if (missingRes.exists !== false || missingRes.matchedFeatures.length !== 0 || missingRes.corrupt !== false) {
        return `缺 feature-map 时 Fail-Soft 返回异常：${JSON.stringify(missingRes)}`
      }

      // 2. repo-map --write-feature-map 增量预填，再手写自定义字段重跑不得被覆盖
      const rmRes = await runAbsAsync(RM_SCRIPT, [dir, '--write-feature-map', '--json'])
      if (rmRes.status !== 0) return `repo-map --write-feature-map 失败：${rmRes.stderr}`
      const fm1 = readFeatureMap(dir)
      if (!fm1 || fm1.features.length === 0) return `未预填 docs/feature-map.json：${JSON.stringify(fm1)}`
      fm1.features[0].name = '手写保留业务名称'
      fm1.features[0].businessFlows = ['手写保留核心流程']
      writeFeatureMap(dir, fm1)

      const rmRes2 = await runAbsAsync(RM_SCRIPT, [dir, '--write-feature-map', '--json'])
      if (rmRes2.status !== 0) return `repo-map 二次增量刷新失败：${rmRes2.stderr}`
      const fm2 = readFeatureMap(dir)
      if (fm2.features[0].name !== '手写保留业务名称' || fm2.features[0].businessFlows[0] !== '手写保留核心流程') {
        return `增量刷新覆盖了用户手写条目：${JSON.stringify(fm2.features[0])}`
      }

      // 3. matchFeatureMapForPaths 按路径与关键词精准返回切片
      const slice = matchFeatureMapForPaths(dir, ['src/app.mjs'], ['手写保留'])
      if (!slice.exists || slice.matchedFeatures.length !== 1 || !slice.businessFlows.includes('手写保留核心流程')) {
        return `matchFeatureMapForPaths 切片返回异常：${JSON.stringify(slice)}`
      }

      // 4. 反面：受跟踪 feature-map 含易变哈希或手工日期必须被 validateFeatureMap 拒绝
      const badSchema = validateFeatureMap({
        version: 1,
        features: [{ id: 'app', name: 'App', entrypoints: ['src/app.mjs'], modules: ['src/app.mjs'], businessFlows: [], testRefs: [], verificationTools: [{ id: 't1', kind: 'command', command: 'node src/app.mjs', riskLevel: 'low', symbolHash: 'abc', lastVerifiedDate: '2026-01-01' }] }],
      })
      if (badSchema.ok || !badSchema.errors.some((e) => e.includes('symbolHash')) || !badSchema.errors.some((e) => e.includes('lastVerifiedDate'))) {
        return `validateFeatureMap 未拦截受跟踪哈希/日期字段：${JSON.stringify(badSchema)}`
      }

      // 5. 损坏 JSON：只读 matchFeatureMapForPaths Fail-Soft，写入 verify-tools sync Fail-Closed 拒覆盖
      const brokenRaw = '{ "version": 1, "features": [ BROKEN_JSON'
      writeFileSync(join(dir, FEATURE_MAP_REL), brokenRaw, 'utf8')
      const corruptRead = matchFeatureMapForPaths(dir, ['src/app.mjs'])
      if (!corruptRead.corrupt || !corruptRead.warning || corruptRead.matchedFeatures.length !== 0) {
        return `损坏 feature-map 时 matchFeatureMapForPaths 未 Fail-Soft：${JSON.stringify(corruptRead)}`
      }
      const syncCorrupt = await runAbsAsync(VT_SCRIPT, ['sync', dir, '--json'])
      if (syncCorrupt.status !== 3 || !`${syncCorrupt.stdout}\n${syncCorrupt.stderr}`.includes('BLOCKED_CORRUPT_FEATURE_MAP')) {
        return `损坏 feature-map 时 verify-tools sync 未 Fail-Closed：status=${syncCorrupt.status} out=${syncCorrupt.stdout}`
      }
      if (readFileSync(join(dir, FEATURE_MAP_REL), 'utf8') !== brokenRaw) {
        return 'verify-tools sync Fail-Closed 失败：损坏文件被意外覆写'
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C9：仓外 scratch 严格路径校验、cleanup/abort 销毁与跨 >=2 PR 固化提示正反双向', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# sc-demo\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\nsmoke-verify: none\n```\n',
      'src/order.mjs': 'export function createOrder() { return { ok: true } }\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{
          id: 'orders', name: '订单业务流', entrypoints: ['src/order.mjs'], modules: ['src/order.mjs'],
          businessFlows: ['创建订单'], verificationTools: [], testRefs: [],
        }],
      }, null, 2),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@sc.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 严格前缀校验：合法 scratch 放行，越界/父目录/主仓一律拒绝
      const validDir = resolveTaskScratchDir(roots.gitDir, 't-safe', roots.mainRoot)
      if (!isSafeTaskScratchPath(validDir, roots.gitDir, 't-safe', roots.mainRoot)) {
        return `合法 scratch 路径被误拒：${validDir}`
      }
      if (isSafeTaskScratchPath(roots.mainRoot, roots.gitDir, 't-safe', roots.mainRoot)
        || isSafeTaskScratchPath(dirname(validDir), roots.gitDir, 't-safe', roots.mainRoot)) {
        return 'isSafeTaskScratchPath 未拦截越界/父级路径'
      }

      // 2. 启动 task-1，通过 verify-tools create --draft-only 写仓外探针（工作区保持 0 污染）
      await withQuietIo(() => handleStart({ task: 't-sc-1', case: '2', slug: 'sc1', files: 'src/order.mjs' }, roots))
      const draft1 = await runAbsAsync(VT_SCRIPT, ['create', '--feature', 'orders', '--task', 't-sc-1', '--draft-only', '--json'], { cwd: dir })
      if (draft1.status !== 0) return `create --draft-only 失败：${draft1.stderr}`
      const d1 = JSON.parse(draft1.stdout)
      if (!existsSync(d1.draftPath) || d1.draftPath.startsWith(dir.replace(/\\/g, '/'))) {
        return `草稿未落盘仓外命名空间：${d1.draftPath}`
      }
      const stBefore = gitSync(dir, ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
      if (stBefore) return `仓外草稿污染了主仓工作区：${stBefore}`

      // 3. cleanup 销毁 t-sc-1 scratch 并写第 1 条 verify.scratch-used（1 个 task 不得触发固化提示）
      const clean1 = await withQuietIo(() => handleCleanup({ task: 't-sc-1', confirm: true, json: true }, roots))
      if (clean1.res.exitCode !== 0 || existsSync(d1.scratchDir)) {
        return `flow cleanup 未销毁仓外 scratch：exit=${clean1.res.exitCode}`
      }
      const sigs1 = readSignalsJsonl(roots).events.filter((e) => e.pattern === 'verify.scratch-used')
      if (sigs1.length !== 1 || sigs1[0].meta?.featureId !== 'orders') {
        return `cleanup 未写入 verify.scratch-used 信号：${JSON.stringify(sigs1)}`
      }
      const hintsAfterOne = detectScratchSolidificationHints({ gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot })
      if (hintsAfterOne.length !== 0) return `仅 1 个 PR 不应触发固化提示：${JSON.stringify(hintsAfterOne)}`

      // 4. 启动 task-2，再写仓外探针后走 abort 销毁 -> 累计 2 个不同 taskId -> audit 与 review-pack 均输出固化提示
      await withQuietIo(() => handleStart({ task: 't-sc-2', case: '2', slug: 'sc2', files: 'src/order.mjs' }, roots))
      const sc2 = ensureTaskScratchDir(roots.gitDir, 't-sc-2', roots.mainRoot, { featureId: 'orders', modules: ['src/order.mjs'] })
      writeFileSync(join(sc2.dir, 'probe2.mjs'), 'console.log("p2")\n', 'utf8')
      const ab2 = await withQuietIo(() => handleAbort({ task: 't-sc-2', confirm: true, json: true }, roots))
      if (ab2.res.exitCode !== 0 || existsSync(sc2.dir)) {
        return `flow abort 未销毁仓外 scratch：exit=${ab2.res.exitCode}`
      }

      const audit2 = await runAbsAsync(VT_SCRIPT, ['audit', dir, '--json'])
      const aj2 = JSON.parse(audit2.stdout)
      if (!aj2.solidificationHints?.some((h) => h.featureId === 'orders' && h.taskCount === 2 && h.code === 'SUGGEST_SOLIDIFY_SCRATCH_TOOL')) {
        return `跨 2 PR 后 verify-tools audit 未输出固化提示：${JSON.stringify(aj2.solidificationHints)}`
      }

      writeFileSync(join(dir, 'src/order.mjs'), 'export function createOrder(x) { return { ok: true, x } }\n', 'utf8')
      const rp2 = await runAbsAsync(RP_SCRIPT, ['--local', '--json'], { cwd: dir })
      const rpj2 = JSON.parse(rp2.stdout)
      if (!rpj2.reviewContext?.solidificationHints?.some((h) => h.featureId === 'orders' && h.taskCount === 2)) {
        return `跨 2 PR 后 review-pack 未输出固化提示：${JSON.stringify(rpj2.reviewContext?.solidificationHints)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C10：免手工日期过时校验（symbol-index + 树哈希）、基准分支防误判与低/中/高三级处置正反双向', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'src/low.mjs': 'export function lowFn() { return 1 }\n',
      'src/med.mjs': 'export function medFn() { return 2 }\n',
      'src/high.mjs': 'export function highFn() { return 3 }\n',
      'test/med.test.mjs': 'console.log("MED_TEST_OK")\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [
          { id: 'f-low', name: 'Low', entrypoints: ['src/low.mjs'], modules: ['src/low.mjs'], businessFlows: ['低风险流'], testRefs: [], verificationTools: [{ id: 't-low', kind: 'command', command: 'node -e "console.log(\'LOW_OK\')"', scriptPath: null, riskLevel: 'low', triggerHints: ['low'] }] },
          { id: 'f-med', name: 'Med', entrypoints: ['src/med.mjs'], modules: ['src/med.mjs'], businessFlows: ['中风险流'], testRefs: ['test/med.test.mjs'], verificationTools: [{ id: 't-med', kind: 'command', command: 'node -e "console.log(\'MED_OK\')"', scriptPath: null, riskLevel: 'medium', triggerHints: ['med'] }] },
          { id: 'f-high', name: 'High', entrypoints: ['src/high.mjs'], modules: ['src/high.mjs'], businessFlows: ['高风险核心流'], testRefs: [], verificationTools: [{ id: 't-high', kind: 'command', command: 'node -e "console.log(\'HIGH_OK\')"', scriptPath: null, riskLevel: 'high', triggerHints: ['high'] }] },
        ],
      }, null, 2),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@stale.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 首次在 main 上运行采集三项基线到仓外 cache.json（受跟踪 feature-map 不得写入任何哈希）
      for (const tid of ['t-low', 't-med', 't-high']) {
        const initRun = await runAbsAsync(VT_SCRIPT, ['run', '--tool', tid, '--json'], { cwd: dir })
        if (initRun.status !== 0) return `首次采集基线失败 (${tid})：${initRun.stderr}`
      }
      const cache = readVerifyCache(roots.gitDir, roots.mainRoot)
      if (!cache.tools['t-high']?.symbolHash || !cache.tools['t-high']?.moduleTreeHash) {
        return `cache.json 未落盘 symbolHash/moduleTreeHash：${JSON.stringify(cache)}`
      }
      const trackedText = readFileSync(join(dir, FEATURE_MAP_REL), 'utf8')
      if (trackedText.includes('symbolHash') || trackedText.includes('moduleTreeHash')) {
        return '受跟踪 docs/feature-map.json 泄露了局部哈希字段'
      }

      // 2. 切特性分支只改函数体（不改导出符号），按 --base main 运行高风险工具 -> 必须 fresh（防误判当前 PR 自身改动）
      gitSync(dir, ['checkout', '-qb', 'feat/body-only'])
      writeFileSync(join(dir, 'src/high.mjs'), 'export function highFn() { return 42 }\n', 'utf8')
      gitCommitFast(dir, 'feat: internal body change only', { updateOnly: true })
      const bodyOnlyRun = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-high', '--base', 'main', '--json'], { cwd: dir })
      if (bodyOnlyRun.status !== 0 || JSON.parse(bodyOnlyRun.stdout).results[0].staleness.status !== 'fresh') {
        return `PR 自身函数体改动被误判为 stale：exit=${bodyOnlyRun.status} out=${bodyOnlyRun.stdout}`
      }
      // 2b. 同一特性分支改导出符号名（main 树未变，treeDrift=false，仅 symbolDrift=true）-> 必须硬阻断 BLOCKED_STALE_HIGH_RISK_TOOL
      writeFileSync(join(dir, 'src/high.mjs'), 'export function highFnRenamedOnBranch() { return 42 }\n', 'utf8')
      const symOnlyRun = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-high', '--base', 'main', '--json'], { cwd: dir })
      if (symOnlyRun.status !== 3 || JSON.parse(symOnlyRun.stdout).code !== 'BLOCKED_STALE_HIGH_RISK_TOOL') {
        return `特性分支改导出符号（--base main）未触发 symbolDrift 硬阻断：exit=${symOnlyRun.status} out=${symOnlyRun.stdout}`
      }
      gitSync(dir, ['checkout', '--', 'src/high.mjs'])
      gitSync(dir, ['checkout', '-q', 'main'])

      // 3. 真实改动三个模块的导出符号 -> 触发免日期过时校验与三级风险处置
      writeFileSync(join(dir, 'src/low.mjs'), 'export function lowFnV2() { return 1 }\n', 'utf8')
      writeFileSync(join(dir, 'src/med.mjs'), 'export function medFnV2() { return 2 }\n', 'utf8')
      writeFileSync(join(dir, 'src/high.mjs'), 'export function highFnV2() { return 3 }\n', 'utf8')

      // low: STALE_WARN 告警后运行成功并自动刷新基线
      const lowStale = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-low', '--json'], { cwd: dir })
      if (lowStale.status !== 0 || JSON.parse(lowStale.stdout).results[0].warningCode !== 'STALE_WARN') {
        return `low 风险过期未输出 STALE_WARN 并放行：exit=${lowStale.status} out=${lowStale.stdout}`
      }

      // medium: 阻断盲目复用（STALE_MEDIUM_FALLBACK），返回 testRefs 并记录债信号
      const medStale = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-med', '--json'], { cwd: dir })
      if (medStale.status !== 3 || JSON.parse(medStale.stdout).code !== 'STALE_MEDIUM_FALLBACK') {
        return `medium 风险过期未返回 STALE_MEDIUM_FALLBACK：exit=${medStale.status} out=${medStale.stdout}`
      }
      if (!readSignalsJsonl(roots).events.some((e) => e.pattern === 'verify.tool-stale-medium')) {
        return 'medium 风险过期未写入 verify.tool-stale-medium 债信号'
      }

      // high: 硬阻断（BLOCKED_STALE_HIGH_RISK_TOOL，exit 3）；带 --live-e2e-cmd 或 --refresh-baseline 方可放行
      const highStale = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-high', '--json'], { cwd: dir })
      if (highStale.status !== 3 || JSON.parse(highStale.stdout).code !== 'BLOCKED_STALE_HIGH_RISK_TOOL') {
        return `high 风险过期未硬阻断：exit=${highStale.status} out=${highStale.stdout}`
      }
      const highLive = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 't-high', '--live-e2e-cmd', 'node -e "console.log(\'LIVE_E2E_OK\')"', '--refresh-baseline', '--json'], { cwd: dir })
      if (highLive.status !== 0 || !JSON.parse(highLive.stdout).results[0].baselineUpdated) {
        return `high 风险实时 E2E 替代并刷新基线失败：exit=${highLive.status} out=${highLive.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C11：无预设工具仓同样强拦 --include-diff、装配逆邻域与防敷衍 --e2e-evidence 正反双向', async () => {
    // 零预设工具仓：无 docs/feature-map.json，无 AGENTS.md Dev Profile
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# zero-tool-repo\n\nMinimal app.\n',
      'src/core.mjs': 'export function calc(n) { return n + 1 }\n',
      'src/caller.mjs': 'import { calc } from "./core.mjs"\nexport function runCalc() { return calc(5) }\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@z.test' })
    try {
      // 1. 纯文档低风险改动不误触发高门槛故障/运行阻断（先验证白名单）
      writeFileSync(join(dir, 'README.md'), '# zero-tool-repo\n\nMinimal app typo fix.\n', 'utf8')
      const docPack = await runAbsAsync(RP_SCRIPT, ['--local', '--json'], { cwd: dir })
      if (docPack.status !== 0) return `纯文档包失败：${docPack.stderr}`
      const docJ = JSON.parse(docPack.stdout)
      if (docJ.empiricalGate.faultRequired !== false || docJ.empiricalGate.steps.e2eObservation.required !== false) {
        return `纯文档改动被误要求故障注入或 E2E：${JSON.stringify(docJ.empiricalGate)}`
      }
      gitSync(dir, ['checkout', '--', 'README.md'])

      // 2. 改运行态文件：review-pack 必须注入受波及 businessFlows + 逆邻域 src/caller.mjs + zero-preset-empirical 任务单
      writeFileSync(join(dir, 'src/core.mjs'), 'export function calc(n) { return n + 2 }\n', 'utf8')
      const packRes = await runAbsAsync(RP_SCRIPT, ['--local', '--json'], { cwd: dir })
      if (packRes.status !== 0) return `无 feature-map 仓 review-pack 失败：${packRes.stderr}`
      const pj = JSON.parse(packRes.stdout)
      if (pj.reviewContext?.empiricalTaskOrder?.strategy !== 'zero-preset-empirical') {
        return `未进入 zero-preset-empirical 策略：${JSON.stringify(pj.reviewContext?.empiricalTaskOrder)}`
      }
      if (!pj.reviewContext?.adjacentModules?.incoming?.some((m) => m.file === 'src/caller.mjs')) {
        return `未注入依赖逆邻域 src/caller.mjs：${JSON.stringify(pj.reviewContext?.adjacentModules)}`
      }
      if ((pj.reviewContext?.affectedBusinessFlows?.length ?? 0) === 0) {
        return '无工具仓未自动推导出受波及 businessFlows'
      }

      // 3. 未完成实证直接 --include-diff 必须硬阻断 BLOCKED_EMPIRICAL_FIRST (exit 3)
      const diffBlock = await runAbsAsync(RP_SCRIPT, ['--local', '--include-diff', '--json'], { cwd: dir })
      if (diffBlock.status !== 3 || JSON.parse(diffBlock.stdout).code !== 'BLOCKED_EMPIRICAL_FIRST') {
        return `无预设工具仓未阻断 --include-diff：exit=${diffBlock.status} out=${diffBlock.stdout}`
      }

      // 4. 补强 #3：防敷衍 --e2e-evidence 拦截 "ok"/"pass"/"lgtm"/"done"/"looks good to me"/"已验证"/占位符，放行实质输出
      for (const fluff of ['ok', 'pass', 'lgtm', 'done', 'looks good to me', '已验证', '通过', '<运行观察实证>']) {
        const v = validateE2eEvidenceText(fluff)
        if (v.ok) return `validateE2eEvidenceText 漏放了水话："${fluff}"`
      }
      for (const real of ['a6 smoke ok', 'I_SMOKE_OK s1', 'node src/caller.mjs exit=0 output=7']) {
        const v = validateE2eEvidenceText(real)
        if (!v.ok) return `validateE2eEvidenceText 误伤了合法证据："${real}" (${v.reason})`
      }

      const fluffEmp = await runAbsAsync(RP_SCRIPT, [
        'check-empirical', '--local', '--cmd', 'node -e "console.log(7)"', '--e2e-evidence', '已验证', '--json',
      ], { cwd: dir })
      if (fluffEmp.status !== 3 || JSON.parse(fluffEmp.stdout).code !== 'BLOCKED_SHALLOW_E2E_EVIDENCE') {
        return `review check-empirical 未拦截水话 --e2e-evidence：exit=${fluffEmp.status} out=${fluffEmp.stdout}`
      }

      // 5. flow verify 同样拦截水话 --e2e-evidence
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'fluff-t', case: '2', slug: 'fluff' }, roots))
      const wtFluff = join(dir, '.worktrees', 'impl-fluff-t')
      writeFileSync(join(wtFluff, 'src/core.mjs'), 'export function calc(n) { return n + 3 }\n', 'utf8')
      gitCommitFast(wtFluff, 'feat: calc change', { updateOnly: true })
      await withQuietIo(() => handleVerify({ task: 'fluff-t', mode: 'smoke', cmd: 'node -e "console.log(8)"', 'e2e-evidence': 'lgtm', json: true }, roots))
      const evVal = validateVerificationEvidence({
        policy: { riskTier: 'medium', smokeRequired: true, requiredGates: ['smoke'] },
        evidence: JSON.parse(readFileSync(join(roots.gitDir, 'project-forge-flow', 'tasks', 'fluff-t', 'evidence.json'), 'utf8')),
        headSha: gitSync(wtFluff, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
        profile: { smokeVerify: 'node -e "console.log(8)"' },
      })
      if (evVal.ok || evVal.code !== 'BLOCKED_SHALLOW_E2E_EVIDENCE') {
        return `flow verify 复用校验未拦截水话 --e2e-evidence：${JSON.stringify(evVal)}`
      }

      // 6. 实质 --e2e-evidence + 实证通过 + 故障注入闭环解锁 --include-diff
      const goodEmp = await runAbsAsync(RP_SCRIPT, [
        'check-empirical', '--local', '--cmd', 'node -e "import(\'./src/caller.mjs\').then(m=>{if(m.runCalc()!==7)process.exit(1)})"',
        '--e2e-evidence', 'runCalc() via src/caller.mjs returned 7 exit=0', '--json',
      ], { cwd: dir })
      if (goodEmp.status !== 0) return `带实质证据 check-empirical 失败：${goodEmp.stderr}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C12：dev-verify-tools 三大场景贯通（create/run/audit/clean）与空仓/纯文档仓零死锁', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c12-demo\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\nsmoke-verify: none\n```\n',
      'src/calc.mjs': 'export function add(a, b) { return a + b }\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@c12.test' })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 场景 1（创造）：仓外草稿含压制坏味 -> edit-gate 硬拦并回滚，不得遗留脏脚本
      const badDraft = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'calc', '--task', 't-c12', '--draft-only', '--draft-file', 'bad.mjs',
        '--draft-content', '// HACK: bypass\nconsole.log(1)\n', '--json',
      ], { cwd: dir })
      if (badDraft.status !== 0) return `写坏草稿失败：${badDraft.stderr}`
      const badPromote = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'calc', '--task', 't-c12', '--from-scratch', 'bad.mjs',
        '--script', 'scripts/verify-calc.mjs', '--modules', 'src/calc.mjs', '--promote', '--json',
      ], { cwd: dir })
      if (badPromote.status !== 3 || !`${badPromote.stdout}\n${badPromote.stderr}`.includes('BLOCKED_EDIT_GATE_FAILED')) {
        return `坏草稿沉淀未被 edit-gate 拦截：exit=${badPromote.status} out=${badPromote.stdout}`
      }
      if (existsSync(join(dir, 'scripts/verify-calc.mjs'))) return 'edit-gate 拦截后未回滚已复制脚本'

      // 2. 合法草稿沉淀 -> 过 edit-gate + 实跑通过 -> 登记 docs/feature-map.json 与 cache.json
      const goodDraft = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'calc', '--name', '计算器', '--task', 't-c12', '--draft-only', '--draft-file', 'good.mjs',
        '--draft-content', 'import { add } from "../src/calc.mjs"\nif (add(2, 3) !== 5) process.exit(1)\nconsole.log("CALC_OK")\n', '--json',
      ], { cwd: dir })
      if (goodDraft.status !== 0) return `写好草稿失败：${goodDraft.stderr}`
      const goodPromote = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'calc', '--name', '计算器', '--task', 't-c12', '--from-scratch', 'good.mjs',
        '--script', 'scripts/verify-calc.mjs', '--entrypoints', 'src/calc.mjs', '--modules', 'src/calc.mjs',
        '--flows', '加法主流程', '--risk', 'medium', '--promote', '--json',
      ], { cwd: dir })
      if (goodPromote.status !== 0 || !existsSync(join(dir, 'scripts/verify-calc.mjs'))) {
        return `合法草稿沉淀失败：exit=${goodPromote.status} err=${goodPromote.stderr}`
      }

      // 3. 场景 2（自动复用）：按 --files src/calc.mjs 自动匹配执行并刷新基线
      const runRes = await runAbsAsync(VT_SCRIPT, ['run', '--files', 'src/calc.mjs', '--task', 't-c12', '--json'], { cwd: dir })
      if (runRes.status !== 0 || !JSON.parse(runRes.stdout).results[0].ok) {
        return `场景 2 自动复用失败：exit=${runRes.status} out=${runRes.stdout}`
      }

      // 4. 场景 3（体检清理）：注入僵尸路径与孤儿 scratch 目录 -> audit 检出 -> clean --confirm 彻底清除
      const fm = readFeatureMap(dir)
      fm.features[0].modules.push('src/deleted-zombie.mjs')
      writeFeatureMap(dir, fm)
      const orphanSc = ensureTaskScratchDir(roots.gitDir, 'closed-orphan', roots.mainRoot, { featureId: 'calc' })
      writeFileSync(join(orphanSc.dir, 'leftover.mjs'), 'console.log(0)\n', 'utf8')

      const aud = await runAbsAsync(VT_SCRIPT, ['audit', dir, '--json'])
      const audJ = JSON.parse(aud.stdout)
      if (aud.status !== 3 || audJ.zombies.length !== 1 || !audJ.orphanScratchDirs.some((o) => o.taskId === 'closed-orphan')) {
        return `audit 未检出僵尸路径或孤儿 scratch：exit=${aud.status} out=${aud.stdout}`
      }

      const cln = await runAbsAsync(VT_SCRIPT, ['clean', dir, '--confirm', '--json'])
      if (cln.status !== 0 || existsSync(orphanSc.dir)) {
        return `clean --confirm 清理失败：exit=${cln.status} out=${cln.stdout}`
      }
      const audClean = await runAbsAsync(VT_SCRIPT, ['audit', dir, '--json'])
      if (audClean.status !== 0) return `清理后 audit 未转绿：${audClean.stdout}`

      // 5. 纯文档仓/无远端 local-only 零死锁核验
      const docOnly = tmpProject({ 'README.md': '# docs only\n' })
      gitInit(docOnly, { branch: 'main', name: 'd', email: 'd@d.t' })
      try {
        const drp = await runAbsAsync(RP_SCRIPT, ['--local', '--json'], { cwd: docOnly })
        if (drp.status !== 0) return `纯文档仓 review-pack 异常：${drp.stderr}`
        const dvt = await runAbsAsync(VT_SCRIPT, ['run', '--changed', '--json'], { cwd: docOnly })
        if (dvt.status !== 0) return `纯文档仓 verify-tools run 异常：${dvt.stderr}`
      } finally { rmTree(docOnly) }
      return true
    } finally { rmTree(dir) }
  }])
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const cases = []
  registerVerifyToolsCases(cases)
  let failed = 0
  for (const [name, fn] of cases) {
    const out = await fn()
    if (out === true) process.stdout.write(`PASS  ${name}\n`)
    else { failed += 1; process.stderr.write(`FAIL  ${name} —— ${out}\n`) }
  }
  process.stdout.write(`\nverify-tools 断言汇总：${cases.length - failed} 通过 / ${failed} 失败。\n`)
  await flushAndExit(failed === 0 ? 0 : 1)
}
