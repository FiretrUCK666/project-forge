/**
 * fixtures-w5-blind-fixes.mjs —— Wave 5 真实开源仓盲测 5 项根因修复（C1..C4）正反双向行为断言。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { auditSecurity, walkFiles } from '../../kit/skills/dev-govern/scripts/govern-checks.mjs'
import { buildIterationPlan, generateIterationTests, runIterationSuites } from '../../kit/skills/dev-iterate/scripts/iterate.mjs'
import { isHarmlessNpmrcContent, isSensitiveSecretFile } from '../../kit/skills/lib/credential-scan.mjs'
import { validateGeneratedTestQuality } from '../../kit/skills/lib/suite-inventory.mjs'
import { buildSubmitNextSteps } from '../../kit/skills/lib/workflow-helpers.mjs'
import { reviewProject } from '../review.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

function makeLines(count, prefix = 'export const v') {
  return `${Array.from({ length: count }, (_, i) => `${prefix}${i} = ${i}`).join('\n')}\n`
}

export function registerW5BlindFixesCases(cases) {
  cases.push(['W5 C1：repo-map.mjs 过滤未构建 package.json 僵尸入口并回退匹配 .ts/.tsx 源码（正反双向）', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({
        name: 'ts-mono',
        private: true,
        workspaces: ['packages/*'],
        main: './dist/index.js',
        module: './dist/esm/index.mjs',
        bin: {
          'real-cli': './dist/cli.js',
          'ghost-cli': './dist/ghost-cli.js',
        },
      }, null, 2),
      'src/index.ts': 'export const rootEntry = true\n',
      'src/cli.tsx': 'export const cli = () => null\n',
      'packages/mini/package.json': JSON.stringify({
        name: '@demo/mini',
        version: '1.0.0',
        main: './index.cjs',
        module: './index.mjs',
        exports: {
          '.': { import: './dist/entry.mjs', require: './dist/entry.cjs', types: './dist/entry.d.ts' },
          './missing': './dist/never-built.js',
          './built': './built.mjs',
        },
      }, null, 2),
      'packages/mini/index.ts': 'export const mini = 1\n',
      'packages/mini/src/entry.ts': 'export const entry = 2\n',
      'packages/mini/built.mjs': 'export const built = 3\n',
      'packages/ghost/package.json': JSON.stringify({
        name: '@demo/ghost',
        version: '1.0.0',
        main: './dist/missing.cjs',
      }, null, 2),
      'packages/ghost/readme-only.md': '# ghost\n',
    })
    try {
      const map = await generateRepoMap(dir, { writeFeatureMap: true })
      const eps = new Set(map.entrypoints)
      for (const expected of ['src/index.ts', 'src/cli.tsx', 'packages/mini/index.ts', 'packages/mini/src/entry.ts', 'packages/mini/built.mjs']) {
        if (!eps.has(expected)) return `C1 漏收有效源码或已构建入口 ${expected}：${JSON.stringify(map.entrypoints)}`
      }
      for (const zombie of [
        'dist/index.js', 'dist/esm/index.mjs', 'dist/cli.js', 'dist/ghost-cli.js',
        'packages/mini/index.cjs', 'packages/mini/index.mjs', 'packages/mini/dist/entry.mjs',
        'packages/mini/dist/entry.d.ts', 'packages/mini/dist/never-built.js', 'packages/ghost/dist/missing.cjs',
      ]) {
        if (eps.has(zombie)) return `C1 误收入不存在构建产物僵尸入口 ${zombie}：${JSON.stringify(map.entrypoints)}`
      }
      if (!map.cliEntrypoints.some((c) => c.name === 'real-cli' && c.file === 'src/cli.tsx')) {
        return `C1 bin 未映射到存在的 .tsx 源码：${JSON.stringify(map.cliEntrypoints)}`
      }
      if (map.cliEntrypoints.some((c) => c.name === 'ghost-cli')) {
        return `C1 不存在的 bin 未被过滤：${JSON.stringify(map.cliEntrypoints)}`
      }
      const fm = JSON.parse(readFileSync(join(dir, 'docs/feature-map.json'), 'utf8'))
      const fmPaths = fm.features.flatMap((f) => [...(f.entrypoints ?? []), ...(f.modules ?? [])])
      if (fmPaths.some((p) => !existsSync(join(dir, p)))) {
        return `C1 feature-map 仍残留不存在路径：${JSON.stringify(fmPaths)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['W5 C2：edit-gate.mjs 存量大文件棘轮（<=800越限/新文件/净增>80阻断 vs 存量>800净增<=80放行warning）', async () => {
    const dir = tmpProject({
      'README.md': '# ratchet\n\nBrownfield ratchet test.\n',
      'src/legacy-big.mjs': makeLines(900, 'export const oldVar'),
      'src/legacy-grow-too-much.mjs': makeLines(850, 'export const growVar'),
      'src/under-limit.mjs': makeLines(790, 'export const nearVar'),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@ratchet.test' })
    gitSync(dir, ['checkout', '-b', 'feat/ratchet'])
    try {
      // 1. 存量 >800L 净增 +10L（<= 80L）-> warning edit.existing-oversized 放行
      writeFileSync(join(dir, 'src/legacy-big.mjs'), makeLines(910, 'export const oldVar'))
      const okSmall = await runEditGate({ mode: 'verify', dir, files: ['src/legacy-big.mjs'] })
      if (!okSmall.ok || okSmall.exitCode !== 0 || okSmall.blockers.length > 0) {
        return `C2 存量大文件净增 +10L 应放行却被阻断：${JSON.stringify(okSmall.blockers)}`
      }
      if (!okSmall.warnings.some((w) => w.ruleId === 'edit.existing-oversized' && w.file === 'src/legacy-big.mjs')) {
        return `C2 存量大文件净增 +10L 缺少 edit.existing-oversized warning：${JSON.stringify(okSmall.warnings)}`
      }

      // 2. 边界：存量 >800L 净增恰好 +80L -> 仍应 warning 放行
      writeFileSync(join(dir, 'src/legacy-big.mjs'), makeLines(980, 'export const oldVar'))
      const okExact = await runEditGate({ mode: 'verify', dir, files: ['src/legacy-big.mjs'] })
      if (!okExact.ok || !okExact.warnings.some((w) => w.ruleId === 'edit.existing-oversized')) {
        return `C2 存量大文件净增 +80L 边界应放行：${JSON.stringify(okExact)}`
      }

      // 3. 存量 >800L 净增 +85L (> 80L) -> 硬阻断 edit.file-oversized-growth
      writeFileSync(join(dir, 'src/legacy-grow-too-much.mjs'), makeLines(935, 'export const growVar'))
      const blkGrowth = await runEditGate({ mode: 'verify', dir, files: ['src/legacy-grow-too-much.mjs'] })
      if (blkGrowth.ok || blkGrowth.exitCode !== 3 || !blkGrowth.blockers.some((b) => b.ruleId === 'edit.file-oversized-growth')) {
        return `C2 存量大文件净增 >80L 未触发 edit.file-oversized-growth：${JSON.stringify(blkGrowth)}`
      }

      // 4. 原 <=800L (790L) 跨过 800L (815L) -> 硬阻断 edit.file-oversized
      writeFileSync(join(dir, 'src/under-limit.mjs'), makeLines(815, 'export const nearVar'))
      const blkCross = await runEditGate({ mode: 'verify', dir, files: ['src/under-limit.mjs'] })
      if (blkCross.ok || blkCross.exitCode !== 3 || !blkCross.blockers.some((b) => b.ruleId === 'edit.file-oversized')) {
        return `C2 原 <=800L 越过 800L 未触发 edit.file-oversized：${JSON.stringify(blkCross)}`
      }

      // 5. 全新文件 >800L -> 硬阻断 edit.file-oversized
      writeFileSync(join(dir, 'src/brand-new-huge.mjs'), makeLines(820, 'export const newVar'))
      const blkNew = await runEditGate({ mode: 'verify', dir, files: ['src/brand-new-huge.mjs'] })
      if (blkNew.ok || blkNew.exitCode !== 3 || !blkNew.blockers.some((b) => b.ruleId === 'edit.file-oversized')) {
        return `C2 全新 >800L 文件未触发 edit.file-oversized：${JSON.stringify(blkNew)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['W5 C3：review.mjs 手写契约+kit 校验 Dev Profile 与 .npmrc 单源真实凭据扫描（正反双向）', async () => {
    const handNoKit = tmpProject({
      'README.md': '# hand-no-kit\n\n未装配技能套件的手写契约项目。\n',
      'package.json': '{"name":"hand-no-kit","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'AGENTS.md': '# hand-no-kit\n\n## 项目定位\n\n手写说明。\n\n## 取舍\n\n- `no-ci`: ok\n',
      '.npmrc': 'node-linker=isolated\nregistry=https://registry.npmjs.org/\n# _authToken=comment-only\n',
    })
    const handWithKitNoProfile = tmpProject({
      'README.md': '# hand-with-kit\n\n已装配技能套件但缺少 Dev Profile 的手写契约。\n',
      'package.json': '{"name":"hand-with-kit","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'AGENTS.md': '# hand-with-kit\n\n## 项目定位\n\n手写说明。\n\n## 取舍\n\n- `no-ci`: ok\n',
      '.npmrc': `//registry.npmjs.org/:_authToken=tok_${'x'.repeat(12)}\n`,
    })
    try {
      gitInit(handNoKit, { branch: 'main', name: 'dev', email: 'dev@c3.test' })
      gitInit(handWithKitNoProfile, { branch: 'main', name: 'dev', email: 'dev@c3.test' })
      await runNode('equip.mjs', [handWithKitNoProfile, '--no-backup'])

      // 1. 未装 kit + 无害 .npmrc：不报 handwritten-missing-dev-profile，不误报 .npmrc
      const rNoKit = await reviewProject(handNoKit)
      if (rNoKit.results.some((r) => r.id === 'agents.handwritten-missing-dev-profile')) {
        return 'C3 未装 .agents/skills/ 时不应报 agents.handwritten-missing-dev-profile'
      }
      if (rNoKit.results.some((r) => r.id === 'secrets.tracked' || r.id === 'secrets.exposed')) {
        return `C3 无害 .npmrc (node-linker=isolated) 被误报为凭据：${JSON.stringify(rNoKit.results.filter((r) => r.scope === 'secrets'))}`
      }
      const govCleanFindings = []
      auditSecurity(walkFiles(handNoKit), new Set(['.npmrc']), govCleanFindings)
      if (govCleanFindings.some((f) => f.id.includes('.npmrc'))) {
        return `C3 govern-checks 对无害 .npmrc 误报敏感凭据：${JSON.stringify(govCleanFindings)}`
      }

      // 2. 已装 kit + 手写 AGENTS.md 缺 Dev Profile + 真实凭据 .npmrc：双双阻断
      const rWithKit = await reviewProject(handWithKitNoProfile)
      const dpMiss = rWithKit.results.find((r) => r.id === 'agents.handwritten-missing-dev-profile')
      if (!dpMiss || dpMiss.level !== 'missing') {
        return `C3 已装 kit 且手写 AGENTS.md 缺 Dev Profile 未报 missing：${JSON.stringify(rWithKit.results.filter((r) => r.scope === 'agents'))}`
      }
      if (!rWithKit.results.some((r) => (r.id === 'secrets.tracked' || r.id === 'secrets.exposed') && r.level === 'missing')) {
        return `C3 含真实 _authToken 的 .npmrc 漏报凭据：${JSON.stringify(rWithKit.results.filter((r) => r.scope === 'secrets'))}`
      }
      const govBadFindings = []
      auditSecurity(walkFiles(handWithKitNoProfile), new Set(['.npmrc']), govBadFindings)
      if (!govBadFindings.some((f) => f.id === 'sec.secret-file..npmrc')) {
        return `C3 govern-checks 对含真实凭据 .npmrc 漏报：${JSON.stringify(govBadFindings)}`
      }

      // 3. 补齐有效 Dev Profile 后，agents.handwritten-missing-dev-profile 消解
      writeFileSync(
        join(handWithKitNoProfile, 'AGENTS.md'),
        '# hand-with-kit\n\n## Dev Profile\n\n```yaml\nquick-test: node --test\nfull-test: node --test\nsmoke-verify: none\nmerge-gate: node --test\n```\n',
      )
      const rFixed = await reviewProject(handWithKitNoProfile, { scopes: new Set(['agents']) })
      if (rFixed.results.some((r) => r.id === 'agents.handwritten-missing-dev-profile')) {
        return `C3 手写 AGENTS.md 补齐 Dev Profile 后仍报错：${JSON.stringify(rFixed.results)}`
      }

      // 4. 共享原语直接覆盖 6 类真实凭据模式与无害文本
      for (const badLine of [
        '_authToken=abc', '_auth=dXNlcjpwYXNz', '_password=secret',
        '//npm.pkg.github.com/:username=bot', 'token=abc123', 'secret=xyz123',
      ]) {
        if (isHarmlessNpmrcContent(badLine) || !isSensitiveSecretFile('.npmrc', badLine)) {
          return `C3 credential-scan 漏检 .npmrc 凭据行：${badLine}`
        }
      }
      if (!isHarmlessNpmrcContent('node-linker=isolated\nshamefully-hoist=true\n') || isSensitiveSecretFile('.npmrc', 'node-linker=isolated\n')) {
        return 'C3 credential-scan 误报无害 .npmrc 配置'
      }
      return true
    } finally {
      rmTree(handNoKit)
      rmTree(handWithKitNoProfile)
    }
  }])

  cases.push(['W5 C4：dev-iterate TypeScript 项目生成 .test.ts/TS 断言与运行处置 + 跨角色交接硬提示', async () => {
    const tsVitestDir = tmpProject({
      'package.json': JSON.stringify({ name: 'ts-vitest', devDependencies: { vitest: '^2.0.0', typescript: '^5.6.0' } }, null, 2),
      'tsconfig.json': '{"compilerOptions":{"target":"ES2022","module":"ESNext","strict":true}}\n',
      'src/core.ts': 'export const sum = (a: number, b: number): number => a + b\n',
    })
    const tsNodeDir = tmpProject({
      'package.json': JSON.stringify({ name: 'ts-node', type: 'module' }, null, 2),
      'packages/api/tsconfig.json': '{"compilerOptions":{"target":"ES2022","strict":true}}\n',
      'packages/api/src/index.ts': 'export const ping = (): string => "pong"\n',
      'tests/unit/smoke.test.ts': "import * as assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('ok', () => { assert.equal(1, 1) })\n",
    })
    const jsDir = tmpProject({
      'package.json': JSON.stringify({ name: 'plain-js', type: 'module' }, null, 2),
      'src/app.mjs': 'export const app = () => 1\n',
    })
    const planDir = tmpProject({
      'README.md': '# plan-handoff\n\n角色交接提示测试仓。\n',
      'package.json': '{"name":"plan-handoff","version":"1.0.0"}\n',
      'src/app.mjs': 'export const run = () => 1\n',
      'docs/specs/261122-issue1-handoff-spec.md': [
        '---',
        'kind: spec',
        'title: Handoff Spec',
        'status: draft',
        'tier: L3',
        'created: 2026-11-22',
        'updated: 2026-11-22',
        'issue: 1',
        'owner: planner-a',
        'approved: false',
        'plan_critique: null',
        'task_id: handoff-t1',
        'scope_files: [src/app.mjs]',
        'depends_on: []',
        '---',
        '',
        '# SPEC: Handoff Spec',
        '',
        '## 要解决的问题',
        '- 核验 `src/app.mjs` 角色交接硬提示。',
        '',
        '## 本期不做',
        '- 不改动其他模块。',
        '',
        '## 验收标准',
        '',
        '- [ ] C1: `node src/app.mjs` 运行通过',
        '',
      ].join('\n'),
    })
    try {
      // 1a. TS + vitest 项目生成 .test.ts + vitest import，并调度本地 vitest 执行通过
      const genVitest = await generateIterationTests(tsVitestDir, { tier: 'integration', write: true, limit: 1 })
      if (!genVitest.ok || genVitest.writtenPaths.length === 0) {
        return `C4 TS+vitest 生成失败：${JSON.stringify(genVitest)}`
      }
      const vitestFile = genVitest.writtenPaths[0]
      if (!vitestFile.endsWith('.test.ts') || vitestFile.endsWith('.test.mjs')) {
        return `C4 TS 仓未生成 .test.ts：${vitestFile}`
      }
      const vitestCode = readFileSync(join(tsVitestDir, vitestFile), 'utf8')
      if (!vitestCode.includes("from 'vitest'") || !vitestCode.includes(': string')) {
        return `C4 TS+vitest 生成断言不符合 TS/Vitest 习惯：\n${vitestCode}`
      }
      const binDir = join(tsVitestDir, 'node_modules', '.bin')
      mkdirSync(binDir, { recursive: true })
      if (process.platform === 'win32') {
        writeFileSync(join(binDir, 'vitest.cmd'), '@echo off\r\necho VITEST_OK %*\r\n', 'utf8')
      } else {
        const posixBin = join(binDir, 'vitest')
        writeFileSync(posixBin, '#!/bin/sh\necho "VITEST_OK $*"\n', 'utf8')
        chmodSync(posixBin, 0o755)
      }
      const vitestRun = await runIterationSuites(tsVitestDir, { targets: [vitestFile], writeSignals: false })
      if (!vitestRun.ok || vitestRun.passed !== 1 || !String(vitestRun.results[0]?.stdout ?? '').includes('VITEST_OK')) {
        return `C4 TS+vitest 本地 runner 调度失败：${JSON.stringify(vitestRun)}`
      }

      // 1b. 子包 tsconfig + *.test.ts 项目生成 .test.ts；Node >= 22.6 原生跑绿，Node < 22 给出明确诊断而非误跑 .ts 崩溃
      const genNodeTs = await generateIterationTests(tsNodeDir, { tier: 'integration', write: true, limit: 1 })
      if (!genNodeTs.ok || !genNodeTs.writtenPaths[0]?.endsWith('.test.ts')) {
        return `C4 子包 TS 仓未生成 .test.ts：${JSON.stringify(genNodeTs)}`
      }
      const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((n) => Number(n) || 0)
      const supportsNativeTs = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
      const tsRun = await runIterationSuites(tsNodeDir, { targets: genNodeTs.writtenPaths, writeSignals: false })
      if (supportsNativeTs) {
        if (!tsRun.ok || tsRun.passed !== 1) {
          return `C4 生成的纯 TS 测试运行失败：${JSON.stringify(tsRun)}`
        }
      } else if (tsRun.ok || tsRun.results[0]?.failureKind !== 'unsupported-ts-runtime') {
        return `C4 Node ${process.versions.node} 缺 TS runner 时应返回 unsupported-ts-runtime 诊断：${JSON.stringify(tsRun)}`
      }

      // 1c. 反面：普通 JS/ESM 仓继续生成 .test.mjs
      const jsPlan = await buildIterationPlan(jsDir, { tier: 'integration', limit: 1 })
      if (!jsPlan.candidates[0]?.plannedTestFile.endsWith('.test.mjs')) {
        return `C4 普通 JS 仓被误判为 TS：${JSON.stringify(jsPlan.candidates)}`
      }

      // 2a. buildSubmitNextSteps 角色交接硬提示
      const subSteps = buildSubmitNextSteps({ taskId: 't-role', role: 'maintainer', policy: { independentReviewRequired: true }, nextRound: 1, hasDevReview: true })
      const subText = String(subSteps[0]?.text ?? '')
      if (!subText.includes('review-pack.mjs') || !/独立.*子代理|严禁在当前/.test(subText)) {
        return `C4 buildSubmitNextSteps 缺少角色交接硬提示：${subText}`
      }
      const forkSteps = buildSubmitNextSteps({ taskId: 't-role', role: 'contributor-fork', policy: { independentReviewRequired: true }, nextRound: 1, hasDevReview: true })
      if (String(forkSteps[0] ?? '').includes('review-pack.mjs')) {
        return `C4 contributor-fork 不应引导自审：${JSON.stringify(forkSteps)}`
      }

      // 2b. doc-plan audit / approve 角色交接硬提示
      await runNode('equip.mjs', [planDir, '--no-backup'])
      const audRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/261122-issue1-handoff-spec.md'], { cwd: planDir })
      if (audRes.status !== 0 || !audRes.stdout.includes('critique-pass') || !/独立.*子代理|严禁在当前/.test(audRes.stdout)) {
        return `C4 doc-plan audit 指向 critique-pass 缺少角色交接硬提示：${audRes.stdout}`
      }
      const cpRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/261122-issue1-handoff-spec.md', '--reviewer', 'critic-x', '--round', '1'], { cwd: planDir })
      if (cpRes.status !== 0) return `C4 critique-pass 失败：${cpRes.stderr}`
      const appRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/261122-issue1-handoff-spec.md'], { cwd: planDir })
      if (appRes.status !== 0 || !appRes.stdout.includes('flow.mjs" start') || !/独立.*子代理|严禁/.test(appRes.stdout)) {
        return `C4 doc-plan approve 缺少角色交接硬提示：${appRes.stdout}`
      }
      return true
    } finally {
      rmTree(tsVitestDir)
      rmTree(tsNodeDir)
      rmTree(jsDir)
      rmTree(planDir)
    }
  }])
}
