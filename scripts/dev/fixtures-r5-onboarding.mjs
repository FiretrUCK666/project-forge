/**
 * fixtures-r5-onboarding.mjs —— R5 治理接入卫生（PR 3）正反双向行为断言：
 *   1. `.gitignore` 遮蔽关键治理路径检测与锚定建议；
 *   2. `docs/feature-map.json` 纯路径提取与空白/符号后缀拦截；
 *   3. `handoff.mjs --verify` 深层 Java/Maven 目录树与统一 `.tmp-*` 清理；
 *   4. 新建 `docs/TDD.md` 自动继承仓库 Markdown 许可证头注释；
 *   5. 受跟踪 `dist/`/`build/` 归入 `high-risk`、`## 取舍` 自相矛盾检测与 ESLint `.agents/**` 忽略提示。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import {
  findAffectedFeatures, prefillFeatureMapFromRepoMap, sanitizeFeatureEntry, validateFeatureMap,
} from '../../kit/skills/lib/feature-map.mjs'
import { buildPreFilledTdd, detectRepoLicenseHeader } from '../../kit/skills/lib/tdd-scaffold.mjs'
import { checkEquip, equip } from '../equip.mjs'
import { scan as handoffScan } from '../handoff.mjs'
import { buildDevProfileVars } from '../lib/agents-defaults.mjs'
import { clearStaleTemps } from '../lib/fs-atomic.mjs'
import { detectIgnoredGovernancePaths } from '../lib/survey-workspace.mjs'
import { reviewProject } from '../review.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerR5OnboardingCases(cases) {
  cases.push(['R5-PR3 C1：.gitignore 遮蔽关键治理路径检测（survey / equip / review 正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': 'node_modules/\nlib\ntemplates/\n',
      'README.md': '# shadow-demo\n\nGitignore shadowing test project.\n',
      'src/index.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r5.test' })
    try {
      const hits = detectIgnoredGovernancePaths(dir)
      const hitPaths = new Set(hits.map((h) => h.path))
      if (!hitPaths.has('.agents/skills/lib/shared.mjs') || !hitPaths.has('.agents/skills/templates/docs-todo.md')) {
        return `detectIgnoredGovernancePaths 漏报未锚定规则遮蔽：${JSON.stringify(hits)}`
      }
      const libHit = hits.find((h) => h.path === '.agents/skills/lib/shared.mjs')
      if (!libHit?.advice?.includes('/lib')) {
        return `锚定建议缺少 /lib 指引：${JSON.stringify(libHit)}`
      }

      const facts = await survey(dir)
      if ((facts.ignores?.ignoredGovernancePaths?.length ?? 0) < 2) {
        return `survey 未透出 ignoredGovernancePaths：${JSON.stringify(facts.ignores)}`
      }
      if (!facts.gaps.some((g) => g.id === 'ignores.governance-shadowed')) {
        return `survey gaps 未报 ignores.governance-shadowed：${JSON.stringify(facts.gaps)}`
      }

      const eq = equip(dir, { noBackup: true })
      if ((eq.warnings?.length ?? 0) === 0 || !eq.warnings.some((w) => w.includes('/lib'))) {
        return `equip 未输出 .gitignore 遮蔽告警：${JSON.stringify(eq.warnings)}`
      }

      const revBad = await reviewProject(dir)
      const govMissing = revBad.missing.find((f) => f.id === 'git.ignored-governance')
      if (!govMissing || !govMissing.title.includes('/lib')) {
        return `review 未报阻塞级 git.ignored-governance 或缺 /lib 建议：${JSON.stringify(revBad.missing)}`
      }

      // 反面：锚定为 /lib 与 /templates/ 后全部清零
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n/lib\n/templates/\n', 'utf8')
      const cleanHits = detectIgnoredGovernancePaths(dir)
      if (cleanHits.length > 0) return `锚定 /lib 后仍误报遮蔽：${JSON.stringify(cleanHits)}`
      const revClean = await reviewProject(dir)
      if (revClean.missing.some((f) => f.id === 'git.ignored-governance')) {
        return `锚定 /lib 后 review 仍误报 git.ignored-governance：${JSON.stringify(revClean.missing)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['R5-PR3 C2：feature-map 纯路径提取、空白符号后缀剥离与零僵尸校验（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# fm-pure-path\n\nFeature map pure path extraction test.\n',
      'AGENTS.md': '# fm-pure-path\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\nfull-test: node -e "process.exit(0)"\nsmoke-verify: none\nmerge-gate: node -e "process.exit(0)"\narch-rules: none\nhigh-risk: AGENTS.md\ndo-not-edit: docs/archive/\n```\n',
      'src/pkg/a.py': 'class Cls:\n  def fn(self):\n    return 1\n',
      'tests/test_a.py': 'def test_fn():\n  assert True\n',
      'docs/TDD.md': [
        '# TDD',
        '',
        '## 功能与入口地图（Feature Map）',
        '',
        '| 功能 | 入口 | 验证 |',
        '| --- | --- | --- |',
        '| 认证逻辑 | `src/pkg/a.py` Cls.fn | node -e "process.exit(0)" |',
        '| 已删除模块 | src/deleted_ghost.py | node -e "process.exit(0)" |',
        '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r5.test' })
    try {
      const rm = await generateRepoMap(dir, { writeFeatureMap: true })
      const fm = rm.featureMapIndex
      const auth = fm.features.find((f) => f.entrypoints.includes('src/pkg/a.py'))
      if (!auth) return `buildFeatureMap 未从含符号后缀列提取纯路径 src/pkg/a.py：${JSON.stringify(fm.features)}`
      if (auth.entrypoints.some((p) => /\s/.test(p)) || auth.modules.some((p) => /\s/.test(p))) {
        return `entrypoints/modules 仍残留空白符号后缀：${JSON.stringify(auth)}`
      }
      if (!auth.businessFlows.some((b) => b.includes('Cls.fn'))) {
        return `符号上下文未保留至 businessFlows：${JSON.stringify(auth.businessFlows)}`
      }
      if (fm.features.some((f) => f.entrypoints.includes('src/deleted_ghost.py'))) {
        return `已删除僵尸路径被写入 feature-map：${JSON.stringify(fm.features)}`
      }

      const aff = findAffectedFeatures(fm, ['src/pkg/a.py'])
      if (aff.matchedFeatures.length !== 1) {
        return `findAffectedFeatures 未匹配纯路径 src/pkg/a.py：${JSON.stringify(aff)}`
      }

      const auditRes = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['audit', dir, '--json'])
      if (auditRes.status !== 0) return `verify-tools audit 失败：${auditRes.stdout}${auditRes.stderr}`
      const auditJson = JSON.parse(auditRes.stdout)
      if ((auditJson.zombies?.length ?? 0) > 0) {
        return `verify-tools audit 仍报僵尸路径：${JSON.stringify(auditJson.zombies)}`
      }

      // 清洗与校验正反双向
      const cleaned = sanitizeFeatureEntry({
        id: 'auth',
        name: 'Auth',
        entrypoints: ['src/pkg/a.py Cls.fn', 'just plain prose'],
        modules: ['src/pkg/a.py (Cls.fn)'],
        verificationTools: [],
        testRefs: [],
      })
      if (cleaned.entrypoints.length !== 1 || cleaned.entrypoints[0] !== 'src/pkg/a.py') {
        return `sanitizeFeatureEntry 剥离/过滤异常：${JSON.stringify(cleaned)}`
      }

      const prefilled = prefillFeatureMapFromRepoMap(dir, {
        featureMap: [{ feature: 'Auth', source: 'src/pkg/a.py Cls.fn', verifyCmd: 'node -e "process.exit(0)"' }],
      })
      const pfAuth = prefilled.featureMap.features[0]
      if (!pfAuth || pfAuth.entrypoints[0] !== 'src/pkg/a.py') {
        return `prefillFeatureMapFromRepoMap 未剥离源路径后缀：${JSON.stringify(pfAuth)}`
      }

      const badRaw = validateFeatureMap({
        version: 1,
        features: [{
          id: 'auth',
          name: 'Auth',
          entrypoints: ['src/pkg/a.py Cls.fn'],
          modules: ['src/pkg/a.py'],
          verificationTools: [],
          testRefs: [],
        }],
      })
      if (badRaw.ok) return 'validateFeatureMap 竟放行含空白符号后缀的 entrypoints'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['R5-PR3 C3：handoff 深层 Java/Maven 树放行与统一 .tmp-pid-ts-seq 清理（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\ntarget/\n',
      'README.md': '# maven-deep\n\nDeep Java tree and atomic temp cleanup test.\n',
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
      'src/main/java/com/acme/platform/module/service/impl/v1/DeepService.java': 'package com.acme;\nclass DeepService {}\n',
      'src/main/java/com/acme/a/b/c/d/e/f/g/h/i/j/k/l/m/n/UltraDeep.java': 'package com.acme;\nclass UltraDeep {}\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r5.test' })
    const liveProc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      // 1. 深度 > 6 且含深度 > 14 纯代码子树（无标记文件）时 handoff --verify 应返回 0
      const verifyOk = await runNode('handoff.mjs', [dir, '--verify'])
      if (verifyOk.status !== 0) {
        return `深层 Java/Maven 树被 handoff --verify 误阻断：status=${verifyOk.status} out=${verifyOk.stdout}`
      }

      // 2. equip 装配后模拟崩溃残留 3 段式 .tmp-pid-ts-seq：checkEquip 清理死进程残留并通过，活进程残留保留
      const eq = equip(dir, { noBackup: true })
      if (!eq.manifestUpdated) return '测试前置条件：equip 未成功装配'
      const deadTmp = join(dir, '.agents/skills/lib/shared.mjs.tmp-999999-1700000000-1')
      const liveTmp = join(dir, `.agents/skills/lib/shared.mjs.tmp-${liveProc.pid}-1700000000-2`)
      writeFileSync(deadTmp, 'stale crash leftover\n', 'utf8')
      const handoffWithDeadTmp = handoffScan(dir)
      if (!handoffWithDeadTmp.staleTemps.some((t) => t.file.endsWith('.tmp-999999-1700000000-1') && !t.alive)) {
        return `handoff 未识别三段式临时文件：${JSON.stringify(handoffWithDeadTmp.staleTemps)}`
      }
      const chk = checkEquip(dir)
      if (!chk.ok || existsSync(deadTmp)) {
        return `checkEquip 未清理死进程三段式残留或误判失败：ok=${chk.ok} extra=${JSON.stringify(chk.extraManaged)}`
      }
      writeFileSync(liveTmp, 'active sibling\n', 'utf8')
      const cleared = clearStaleTemps(join(dir, '.agents/skills'), { recursive: true })
      if (!existsSync(liveTmp) || !cleared.kept.some((p) => p.endsWith(`tmp-${liveProc.pid}-1700000000-2`))) {
        return `clearStaleTemps 误删了活进程三段式临时文件：${JSON.stringify(cleared)}`
      }

      // 3. 反面：深度 > 14 且包含未扫描的标记能力文件（.md）时仍触发 truncated（退出码 3）
      const deepMarker = join(dir, 'src/main/java/com/acme/a/b/c/d/e/f/g/h/i/j/k/l/m/n/extra-note.md')
      writeFileSync(deepMarker, '# untracked deep note\n', 'utf8')
      const verifyTrunc = await runNode('handoff.mjs', [dir, '--verify'])
      if (verifyTrunc.status !== 3) {
        return `深层未跟踪 .md 未触发 truncated 退出码 3：status=${verifyTrunc.status} out=${verifyTrunc.stdout}`
      }
      return true
    } finally {
      liveProc.kill()
      rmTree(dir)
    }
  }])

  cases.push(['R5-PR3 C4：新建 docs/TDD.md 自动继承 Apache/SPDX 许可证头并跳过 project-forge 标记', async () => {
    const apacheHeader = [
      '<!---',
      ' Licensed to the Apache Software Foundation (ASF) under one or more',
      ' contributor license agreements.  See the NOTICE file distributed with',
      ' this work for additional information regarding copyright ownership.',
      '-->',
    ].join('\n')
    const asfDir = tmpProject({
      'SECURITY.md': `${apacheHeader}\n\n# Security\n`,
      'README.md': '# asf-demo\n\nApache demo.\n',
      'src/main.mjs': 'export const ok = 1\n',
    })
    const nonLicDir = tmpProject({
      'AGENTS.md': '<!-- project-forge: generated -->\n# Demo\n',
      'README.md': '<!-- plain editorial note -->\n# Demo\n',
      'src/main.mjs': 'export const ok = 1\n',
    })
    try {
      const detected = detectRepoLicenseHeader(asfDir)
      if (detected !== apacheHeader) {
        return `detectRepoLicenseHeader 未正确提取 Apache ASF 注释头：${JSON.stringify(detected)}`
      }
      const asfTdd = buildPreFilledTdd({ ecosystem: { kinds: ['node'], manifests: [] }, commands: {} }, {
        repoRoot: asfDir, projectName: 'asf-demo', today: '2026-11-23', topLevelDirs: ['src'],
      })
      if (!asfTdd.startsWith(`${apacheHeader}\n\n# `)) {
        return `buildPreFilledTdd 未将 Apache 许可证头置顶：\n${asfTdd.slice(0, 300)}`
      }

      // 反面：project-forge 标记或普通非许可证 HTML 注释不得被当成许可证头
      if (detectRepoLicenseHeader(nonLicDir) !== null) {
        return `detectRepoLicenseHeader 误提取了非许可证注释：${detectRepoLicenseHeader(nonLicDir)}`
      }
      const plainTdd = buildPreFilledTdd({ ecosystem: { kinds: ['node'], manifests: [] }, commands: {} }, {
        repoRoot: nonLicDir, projectName: 'plain-demo', today: '2026-11-23', topLevelDirs: ['src'],
      })
      if (!plainTdd.startsWith('# ')) {
        return `非许可证注释被误前置到 TDD 顶部：\n${plainTdd.slice(0, 200)}`
      }
      return true
    } finally {
      rmTree(asfDir)
      rmTree(nonLicDir)
    }
  }])

  cases.push(['R5-PR3 C5：受跟踪 dist/ 归入 high-risk、## 取舍矛盾告警与 ESLint .agents/** 忽略检查', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': JSON.stringify({ name: 'r5-c5', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n',
      'README.md': '# r5-c5\n\nTracked dist, tradeoff contradiction, and eslint ignore test.\n',
      'LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...\n',
      '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
      'eslint.config.mjs': 'export default [{ rules: { "no-console": "warn" } }]\n',
      'dist/index.js': 'console.log("bundled")\n',
      'src/index.mjs': 'export const ok = 1\n',
      'AGENTS.md': [
        '# r5-c5',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: npm test',
        'full-test: npm test',
        'smoke-verify: none',
        'merge-gate: npm test',
        'arch-rules: none',
        'high-risk: AGENTS.md',
        'do-not-edit: docs/archive/, dist/',
        '```',
        '',
        '## 取舍',
        '',
        '```text',
        '- `no-ci`: 本地手跑不配 CI',
        '- `license`: 不放，内部工具',
        '```',
        '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r5.test' })
    try {
      const vars = buildDevProfileVars({
        ecosystem: { kinds: ['node'], manifests: ['package.json'], packageScripts: ['test'] },
        commands: { test: 'npm test' },
        scale: { codeFiles: 2 },
      }, dir)
      if (!vars.PROFILE_HIGH_RISK.includes('dist/') || vars.PROFILE_DO_NOT_EDIT.includes('dist/')) {
        return `受跟踪 dist/ 应列入 high-risk 而非 do-not-edit：${JSON.stringify(vars)}`
      }

      const revBad = await reviewProject(dir)
      const allIds = new Set(revBad.results.map((r) => r.id))
      if (!allIds.has('agents.do-not-edit-tracked-build')) {
        return `未检出 do-not-edit 与受跟踪 dist/ 重叠：${JSON.stringify([...allIds])}`
      }
      if (!revBad.notice.some((f) => f.id === 'agents.tradeoff-contradiction')) {
        return `未告警 ## 取舍与 LICENSE/workflow 矛盾：${JSON.stringify(revBad.notice)}`
      }
      if (!revBad.notice.some((f) => f.id === 'kit.eslint-agents-ignore')) {
        return `未发出 ESLint 缺少 .agents/** 忽略警告：${JSON.stringify(revBad.notice)}`
      }

      // 反面：移出 do-not-edit、修正取舍为不适用/MIT、添加 .agents/** 到 eslint.config.mjs 后全部消解
      writeFileSync(join(dir, 'eslint.config.mjs'), 'export default [{ ignores: [".agents/**"] }]\n', 'utf8')
      writeFileSync(join(dir, 'AGENTS.md'), [
        '# r5-c5',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: npm test',
        'full-test: npm test',
        'smoke-verify: none',
        'merge-gate: npm test',
        'arch-rules: none',
        'high-risk: AGENTS.md, dist/',
        'do-not-edit: docs/archive/',
        '```',
        '',
        '## 取舍',
        '',
        '```text',
        '- `no-ci`: 不适用，本仓已配 CI',
        '- `license`: MIT',
        '```',
        '',
      ].join('\n'), 'utf8')
      gitCommitFast(dir, 'fix: resolve review contradictions and eslint ignore')
      const revGood = await reviewProject(dir)
      for (const unexpectedId of ['agents.do-not-edit-tracked-build', 'agents.tradeoff-contradiction', 'kit.eslint-agents-ignore']) {
        if (revGood.results.some((r) => r.id === unexpectedId)) {
          return `修正后仍误报 ${unexpectedId}：${JSON.stringify(revGood.results.filter((r) => r.id === unexpectedId))}`
        }
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C5 onboarding：纯库/CLI 仓库无 smoke 入口时 smoke-verify 默认 none，有 smoke 文件时保留占位', async () => {
    const libDir = tmpProject({
      'package.json': '{"name":"pure-lib","version":"1.0.0","scripts":{"test":"node test.mjs"}}\n',
      'src/index.mjs': 'export const add = (a, b) => a + b\n',
      'test.mjs': 'process.exit(0)\n',
    })
    const appDir = tmpProject({
      'package.json': '{"name":"app-smoke","version":"1.0.0","scripts":{"test":"node test.mjs"}}\n',
      'src/index.mjs': 'export const main = () => 1\n',
      'test/smoke.mjs': 'process.exit(0)\n',
    })
    try {
      const libVars = buildDevProfileVars({
        ecosystem: { kinds: ['node'], manifests: ['package.json'], packageScripts: ['test'] },
        commands: { test: 'npm test' },
        scale: { codeFiles: 2 },
      }, libDir)
      if (libVars.PROFILE_SMOKE_VERIFY !== 'none') {
        return `纯库无 smoke 入口时 smoke-verify 应默认 none，实际：${libVars.PROFILE_SMOKE_VERIFY}`
      }
      const appVars = buildDevProfileVars({
        ecosystem: { kinds: ['node'], manifests: ['package.json'], packageScripts: ['test'] },
        commands: { test: 'npm test' },
        scale: { codeFiles: 2 },
      }, appDir)
      if (appVars.PROFILE_SMOKE_VERIFY === 'none') {
        return `存在 test/smoke.mjs 时 smoke-verify 不得降成 none：${appVars.PROFILE_SMOKE_VERIFY}`
      }
      return true
    } finally {
      rmTree(libDir)
      rmTree(appDir)
    }
  }])
}
