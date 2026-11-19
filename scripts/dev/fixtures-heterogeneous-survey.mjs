/**
 * fixtures-heterogeneous-survey.mjs —— 异构勘察、business-flows 与多生态盲点双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { auditDoc, auditRepoDocs } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import { checkDocCodeParity } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { evaluateCoupledSync, parseCoupledSyncRules } from '../../kit/skills/lib/doc-templates.mjs'
import { sniffLayeredCommands } from '../../kit/skills/lib/profile-sniffer.mjs'
import { collectTddFacts } from '../../kit/skills/lib/tdd-facts.mjs'
import { buildPreFilledTdd } from '../../kit/skills/lib/tdd-scaffold.mjs'
import { discoverCustomSkillsWithMirrors } from '../../kit/skills/lib/skill-discovery.mjs'
import { getKitSkills } from '../lib/protocol.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, runNode, SKILL_ROOT, survey, tmpProject } from './fixtures-helpers.mjs'

function minimalSkill(name, desc) {
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${desc}\n`
}

export function registerStageBOnboardingB4aCases(cases) {
  cases.push(['B4a C9：解除 depth > 6 硬截断且防循环软链死循环', async () => {
    const deepRel = 'a/b/c/d/e/f/g/h/i/deep-entry.mjs'
    const dir = tmpProject({
      'package.json': '{"name":"c9-deep","version":"1.0.0"}\n',
      [deepRel]: 'export const deepValue = 42\n',
    })
    try {
      let linked = false
      try {
        symlinkSync(join(dir, 'a', 'b'), join(dir, 'a', 'b', 'c', 'loop-back'), process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      } catch { /* 无符号链接权限时继续验证深度扫描 */ }

      const facts = await survey(dir)
      if (facts.risks?.scanCoverage?.truncated === true) {
        return `depth 9 目录仍被误判截断：${JSON.stringify(facts.risks.scanCoverage)}`
      }
      if ((facts.scale?.codeFiles ?? 0) < 1 || !(facts.tddShape?.filePaths ?? []).includes(deepRel)) {
        return `depth 9 源码未被完整扫入：codeFiles=${facts.scale?.codeFiles}, paths=${JSON.stringify(facts.tddShape?.filePaths)}`
      }
      if (linked && (facts.scale?.totalFiles ?? 0) > 20) {
        return `循环符号链接未被去重保护：totalFiles=${facts.scale?.totalFiles}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['B4a C9：外来 docs/specs/* 与 docs/todo/* 原样 preserve，受损受管文档仍严格报 FRONTMATTER_INVALID', async () => {
    const dir = tmpProject({
      'README.md': '# foreign-docs\n\n目标仓自带普通 specs 与 todo。\n',
      'package.json': '{"name":"c9-foreign","version":"1.0.0"}\n',
      'src/app.mjs': 'export const run = () => 1\n',
      'docs/specs/auth-protocol.md': '# Auth Protocol\n\nTarget repo native spec without forge frontmatter.\n',
      'docs/specs/v2-storage.md': '---\ntitle: Storage Spec\nauthor: Alice\n---\n\n# Storage Spec\n\nCustom metadata.\n',
      'docs/todo/backlog.md': '# Backlog\n\n- [x] Shipped feature A\n- [ ] Planned item B\n',
    })
    try {
      await gitInit(dir)
      const factsClean = await survey(dir)
      if (factsClean.reentry?.isReentry !== false) {
        return `外来原生 docs/specs 与 docs/todo 误判为重入仓：${JSON.stringify(factsClean.reentry)}`
      }
      if ((factsClean.docs?.preservedForeignPlanDocs?.length ?? 0) !== 3) {
        return `preservedForeignPlanDocs 未完整收录外来文档：${JSON.stringify(factsClean.docs?.preservedForeignPlanDocs)}`
      }
      const cleanPlanAudit = auditRepoDocs(dir, '.')
      if (!cleanPlanAudit.ok || (cleanPlanAudit.preservedForeignPlanDocs?.length ?? 0) !== 3) {
        return `auditRepoDocs 误拦截外来 docs/specs 或 docs/todo：${JSON.stringify(cleanPlanAudit)}`
      }
      const cleanGov = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
      if (cleanGov.status !== 0) return `govern-audit 运行异常：${cleanGov.stderr}`
      const cleanGovIds = (JSON.parse(cleanGov.stdout).findings ?? []).map((f) => f.id)
      if (cleanGovIds.some((id) => id.startsWith('docs.frontmatter-invalid.') || id.startsWith('docs.unarchived-completed-todo.'))) {
        return `govern-audit 误报外来文档：${JSON.stringify(cleanGovIds)}`
      }

      // 反面：带受管 kind: / plan 字段却格式受损的文档必须严格报红
      writeFileSync(join(dir, 'docs/specs/broken-managed.md'), '---\nkind: spec\ntitle: "Broken\n  bad: [yaml\n')
      writeFileSync(join(dir, 'docs/todo/broken-plan.md'), '---\nplan: broken\n  bad_indent: [\n---\n\n# Broken\n')
      const badPlanAudit = auditRepoDocs(dir, '.')
      const errCodes = badPlanAudit.results.flatMap((r) => (r.errors ?? []).map((e) => e.code))
      if (badPlanAudit.ok || !errCodes.includes('FRONTMATTER_INVALID')) {
        return `受损受管文档未拦截 FRONTMATTER_INVALID：${JSON.stringify(badPlanAudit)}`
      }
      const badGov = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
      const badGovIds = (JSON.parse(badGov.stdout).findings ?? []).map((f) => f.id)
      if (!badGovIds.includes('docs.frontmatter-invalid.docs/specs/broken-managed.md')
        || !badGovIds.includes('docs.frontmatter-invalid.docs/todo/broken-plan.md')) {
        return `govern-audit 未拦截受损受管文档：${JSON.stringify(badGovIds)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['B4a C9：非标文档目录、中性 CI 消 ci.absent、.githooks 识别与 exports/workspace glob 映射', async () => {
    const dir = tmpProject({
      'README.rst': 'Heterogeneous Repo\n==================\n\n使用 rst 说明与非标目录的存量工程。\n',
      'SECURITY.md': '# Security Policy\n\nReport issues privately.\n',
      'RUNBOOK.md': '# Runbook\n\nRestart service gracefully.\n',
      'doc/architecture.md': '# Architecture Overview\n\nCore layers.\n',
      'documentation/onboarding.md': '# Onboarding\n\nRead this first.\n',
      'rfcs/0001-events.md': '# RFC 0001\n\nEvent schema.\n',
      'api/openapi.yaml': 'openapi: 3.1.0\ninfo:\n  title: Demo\n  version: 1.0.0\n',
      'proto/orders.proto': 'syntax = "proto3";\npackage orders;\n',
      'Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\n',
      'compose.yml': 'services:\n  api:\n    build: .\n',
      '.circleci/config.yml': 'version: 2.1\njobs:\n  test:\n    steps:\n      - run: npm test\n',
      '.githooks/pre-commit': '#!/bin/sh\necho pre-commit\n',
      'pnpm-workspace.yaml': 'packages:\n  - "services/*"\n  - "apps/**"\n',
      'package.json': JSON.stringify({ name: 'hetero-ws', private: true }),
      'services/billing/package.json': JSON.stringify({
        name: '@hetero/billing',
        version: '1.0.0',
        exports: {
          '.': { import: './src/entry.mjs' },
          './client': './src/client.mjs',
        },
        scripts: { test: 'node --test' },
      }),
      'services/billing/src/entry.mjs': 'export const bill = () => 1\n',
      'services/billing/src/client.mjs': 'export const client = () => 2\n',
      'apps/web/portal/package.json': JSON.stringify({ name: '@hetero/portal', version: '1.0.0' }),
      'apps/web/portal/index.mjs': 'export const ok = true\n',
    })
    const emptyHookDir = tmpProject({
      'README.md': '# no-ci-and-empty-hook\n\n用于验证空 .githooks 与真无 CI 仓行为。\n',
      'package.json': '{"name":"no-ci","version":"1.0.0"}\n',
      '.githooks/.gitkeep': '',
      'src/index.mjs': 'export const x = 1\n',
    })
    try {
      const f = await survey(dir)
      if (f.docs?.readme !== 'README.rst' || !(f.docs?.nonMdReadmes ?? []).includes('README.rst')) {
        return `非 .md README 未识别：${JSON.stringify(f.docs?.readmes)}`
      }
      for (const expectedDoc of ['doc/architecture.md', 'documentation/onboarding.md', 'rfcs/0001-events.md', 'RUNBOOK.md', 'SECURITY.md', 'api/openapi.yaml', 'proto/orders.proto']) {
        if (!(f.docs?.nonStandardDocs ?? []).includes(expectedDoc)) {
          return `nonStandardDocs 漏检 ${expectedDoc}：${JSON.stringify(f.docs?.nonStandardDocs)}`
        }
      }
      if (!f.docs?.workflowFacts?.hasCheck || !(f.docs?.neutralCiConfigs ?? []).includes('.circleci/config.yml')) {
        return `中性 CI 未正确识别：${JSON.stringify({ wf: f.docs?.workflowFacts, neutral: f.docs?.neutralCiConfigs })}`
      }
      if (!f.git?.hooks?.hasConflict || !(f.git?.hooks?.githooksFiles ?? []).includes('pre-commit')) {
        return `自定义 .githooks/pre-commit 未识别为冲突保护：${JSON.stringify(f.git?.hooks)}`
      }
      const wsPkgs = f.workspace?.packages ?? []
      if (!wsPkgs.includes('services/billing') || !wsPkgs.includes('apps/web/portal')) {
        return `多包 glob 未展开深层工作区包：${JSON.stringify(wsPkgs)}`
      }
      if (!(f.artifacts?.containerFiles ?? []).includes('Dockerfile') || !(f.artifacts?.containerFiles ?? []).includes('compose.yml')) {
        return `容器文件未被识别：${JSON.stringify(f.artifacts?.containerFiles)}`
      }

      const revRes = await runNode('review.mjs', [dir, '--json'])
      const revIds = new Set(JSON.parse(revRes.stdout).results.map((r) => r.id))
      if (revIds.has('ci.absent') || !revIds.has('ci.present') || revIds.has('docs.readme')) {
        return `中性 CI / 非 md README 在 review.mjs 仍误报：${JSON.stringify([...revIds])}`
      }

      const map = await generateRepoMap(dir)
      if (!map.entrypoints.includes('services/billing/src/entry.mjs') || !map.entrypoints.includes('services/billing/src/client.mjs')) {
        return `repo-map 未展开 package.json#exports 对象映射：${JSON.stringify(map.entrypoints)}`
      }

      // 反面：空 .githooks/.gitkeep 不误报 hooks 冲突，真无 CI 仍报 ci.absent
      const fEmptyHook = await survey(emptyHookDir)
      if (fEmptyHook.git?.hooks?.hasConflict) {
        return `仅含 .gitkeep 的 .githooks 不应判为冲突：${JSON.stringify(fEmptyHook.git?.hooks)}`
      }
      const revEmpty = JSON.parse((await runNode('review.mjs', [emptyHookDir, '--json'])).stdout)
      if (!revEmpty.results.some((r) => r.id === 'ci.absent')) {
        return `真无 CI 仓库未报 ci.absent：${JSON.stringify(revEmpty.results)}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(emptyHookDir)
    }
  }])

  cases.push(['B4a C10：business-flows 分片、businessFlows 映射与 preForgeBaseline 落盘 docs/TDD.md', async () => {
    const dir = tmpProject({
      'README.md': '# Service Hub\n\n面向企业租户的多入口服务。\n\n详见 `src/missing-legacy.mjs`。\n',
      'package.json': JSON.stringify({
        name: 'svc-hub',
        version: '1.0.0',
        workspaces: ['packages/*'],
        bin: { 'svc-cli': './bin/cli.mjs' },
        scripts: { test: 'node --test' },
      }),
      'bin/cli.mjs': '#!/usr/bin/env node\nconsole.log("ok")\n',
      'src/routes/orders.mjs': 'export const getOrders = () => []\n',
      'src/pages/Home.tsx': 'export const Home = () => null\n',
      'src/jobs/sync.mjs': 'export const runJob = () => true\n',
      'packages/core/package.json': '{"name":"core","version":"1.0.0"}\n',
      'packages/core/index.mjs': 'export const x = 1\n',
    })
    try {
      const f = await survey(dir)
      const shards = f.explorationStrategy?.shards ?? []
      if (!shards.some((s) => s.id === 'business-flows')) {
        return `parallel-subagents 缺少 business-flows 分片：${JSON.stringify(f.explorationStrategy)}`
      }
      const map = await generateRepoMap(dir)
      const bf = map.businessFlows
      if (!bf || !bf.surfaces.routes.includes('src/routes/orders.mjs')
        || !bf.surfaces.ui.includes('src/pages/Home.tsx')
        || !bf.surfaces.jobs.includes('src/jobs/sync.mjs')
        || !bf.surfaces.cli.some((c) => c.file === 'bin/cli.mjs')) {
        return `repo-map businessFlows 入口面识别不完整：${JSON.stringify(bf)}`
      }
      if (!bf.docCodeGaps.some((g) => g.kind === 'missing-doc-path' && g.path === 'src/missing-legacy.mjs')) {
        return `businessFlows 未捕获文档源码差异：${JSON.stringify(bf.docCodeGaps)}`
      }

      const tddFacts = await collectTddFacts(dir)
      const renderedTdd = buildPreFilledTdd(tddFacts, {
        repoRoot: dir,
        projectName: 'svc-hub',
        today: '2026-11-18',
        businessFlows: bf,
        preForgeBaseline: {
          ranAt: '2026-11-18',
          headSha: 'abc1234',
          summary: '接入前只读实跑全绿',
          commands: [{ command: 'npm test', exitCode: 0, detail: '2 passed' }],
          entrypoints: [{ entry: 'node bin/cli.mjs', exitCode: 0, detail: 'stdout=ok' }],
        },
      })
      if (!renderedTdd.includes('src/routes/orders.mjs') || !renderedTdd.includes('abc1234') || !renderedTdd.includes('npm test')) {
        return `docs/TDD.md 未写入 businessFlows 或 preForgeBaseline：\n${renderedTdd}`
      }
      if (/\{\{[A-Z0-9_]+\}\}/.test(renderedTdd)) {
        return `buildPreFilledTdd 残留未替换变量：\n${renderedTdd}`
      }
      const cleanTdd = renderedTdd
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>\n]+>/g, '已完成实勘填充项')
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs/TDD.md'), cleanTdd, 'utf8')
      const aud = auditDoc({ repoRoot: dir, file: 'docs/TDD.md' })
      if (!aud.ok) return `含 preForgeBaseline 的 docs/TDD.md 未通过审计：${JSON.stringify(aud.errors)}`

      const comp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (comp.status !== 0) return `compose-agents 失败：${comp.stderr}`
      const agentsBytes = readFileSync(join(dir, 'AGENTS.md')).byteLength
      if (agentsBytes >= 24576) return `AGENTS.md 超过 24KB 推荐预算：${agentsBytes}`
      const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (!agentsText.includes('docs/TDD.md') || !agentsText.includes('business-flows') || agentsText.includes('abc1234')) {
        return `AGENTS.md 未保持薄指针（应指回 docs/TDD.md 而非塞入基线详情）：\n${agentsText}`
      }

      const skillMd = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
      const surveyRef = readFileSync(join(SKILL_ROOT, 'references/survey.md'), 'utf8')
      const docsRef = readFileSync(join(SKILL_ROOT, 'references/docs-set.md'), 'utf8')
      for (const [name, txt] of [['SKILL.md', skillMd], ['references/survey.md', surveyRef], ['references/docs-set.md', docsRef]]) {
        if (!txt.includes('preForgeBaseline') || !txt.includes('business-flows')) {
          return `${name} 缺少 S1->S3 preForgeBaseline 或 business-flows 规范`
        }
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['B4a C21 A7 盲点：嵌套 skills/* vs 宿主镜像分离、*/AGENTS.md、双语配对、pyproject/go cmd 与 e2e 隔离', async () => {
    // 1. 嵌套非隐藏 skills/* 与隐藏镜像副本区分（不双计不误删）+ */AGENTS.md / */CLAUDE.md
    const mirrorSkillText = minimalSkill('local-ops', '根目录非隐藏手写源技能，镜像副本不得重复计入。')
    const skillDir = tmpProject({
      'package.json': '{"name":"c21-skills","version":"1.0.0"}\n',
      'AGENTS.md': '# c21-skills\n\n## 取舍\n\n- `no-tdd`: ok\n',
      'skills/local-ops/SKILL.md': mirrorSkillText,
      'packages/billing/skills/invoice-ops/SKILL.md': minimalSkill('invoice-ops', '嵌套子包里的非隐藏手写技能。'),
      '.acme-host/skills/local-ops/SKILL.md': mirrorSkillText,
      '.acme-host/skills/unique-hidden/SKILL.md': minimalSkill('unique-hidden', '仅存在于隐藏目录中的独立自定义技能。'),
      'packages/billing/AGENTS.md': '# Billing Scoped Rules\n\nSee root AGENTS.md.\n',
      'packages/billing/CLAUDE.md': '# Billing Legacy Rules\n',
      'packages/billing/index.mjs': 'export const bill = 1\n',
    })
    // 2. 双语配对 (README.zh-CN / CONTRIBUTING.zh-CN / SECURITY.zh-CN) + pyproject.toml + cmd/*/main.go
    const polyDir = tmpProject({
      'README.md': '# Poly App\n\nMain doc.\n',
      'README.zh-CN.md': '# 多语应用\n\n中文说明。\n',
      'CONTRIBUTING.md': '# Contributing\n\nSee checks.\n',
      'CONTRIBUTING.zh-CN.md': '# 贡献指南\n\n见检查项。\n',
      'SECURITY.zh-CN.md': '# 安全政策\n\n漏洞上报渠道。\n',
      'AGENTS.md': [
        '# Poly App', '',
        '## 改哪看哪', '',
        '| 这次动了 | 必须一起看 |',
        '| --- | --- |',
        '| `src/app.py` | `README.md` |',
        '| `CONTRIBUTING.md` | `CONTRIBUTING.en.md` |', '',
      ].join('\n'),
      'pyproject.toml': '[project]\nname = "poly"\nversion = "0.1.0"\n\n[project.scripts]\npoly-cli = "poly.cli:main"\n',
      'src/poly/cli.py': 'def main():\n    return 0\n',
      'go.mod': 'module example.com/poly\n\ngo 1.22\n',
      'cmd/worker/main.go': 'package main\nfunc main() {}\n',
      'test/cmd/fake/main.go': 'package main\n// fixture\n',
    })
    // 3. 重型 e2e/ / webtest/ 包隔离 + 多 workflow run 聚合去重
    const e2eDir = tmpProject({
      'package.json': JSON.stringify({ name: 'mono-e2e', private: true }),
      'packages/core/package.json': JSON.stringify({ name: 'core', scripts: { test: 'vitest run' } }),
      'e2e/package.json': JSON.stringify({ name: 'e2e-suite', scripts: { test: 'playwright test' } }),
      'packages/webtest/package.json': JSON.stringify({ name: 'webtest', scripts: { test: 'cypress run' } }),
    })
    const multiCiDir = tmpProject({
      'package.json': JSON.stringify({ name: 'multi-ci', version: '1.0.0' }),
      '.github/workflows/unit.yml': 'name: unit\non: [push]\njobs:\n  u:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm run lint\n',
      '.github/workflows/py.yml': 'name: py\non: [push]\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: pytest\n',
    })

    try {
      await gitInit(skillDir)
      const eq = await runNode('equip.mjs', [skillDir, '--no-backup'])
      if (eq.status !== 0) return `C21 equip 失败：${eq.stderr}`
      // 在 .acme-host 写入一个受管 dev-flow 镜像副本
      mkdirSync(join(skillDir, '.acme-host', 'skills', 'dev-flow'), { recursive: true })
      writeFileSync(
        join(skillDir, '.acme-host', 'skills', 'dev-flow', 'SKILL.md'),
        readFileSync(join(skillDir, '.agents', 'skills', 'dev-flow', 'SKILL.md'), 'utf8'),
      )

      const sFacts = await survey(skillDir)
      const customPaths = new Set((sFacts.kit?.customSkills ?? []).map((s) => s.path))
      const mirrorPaths = new Set((sFacts.kit?.mirrorCopies ?? []).map((s) => s.path))
      if (!customPaths.has('skills/local-ops')
        || !customPaths.has('packages/billing/skills/invoice-ops')
        || !customPaths.has('.acme-host/skills/unique-hidden')) {
        return `嵌套 skills/* 或独立隐藏技能漏扫：${JSON.stringify([...customPaths])}`
      }
      if (customPaths.has('.acme-host/skills/local-ops') || customPaths.has('.acme-host/skills/dev-flow')) {
        return `宿主镜像副本误计入 customSkills：${JSON.stringify([...customPaths])}`
      }
      if (!mirrorPaths.has('.acme-host/skills/local-ops') || !mirrorPaths.has('.acme-host/skills/dev-flow')) {
        return `宿主镜像副本未识别到 mirrorCopies：${JSON.stringify([...mirrorPaths])}`
      }
      const eq2 = await runNode('equip.mjs', [skillDir, '--no-backup'])
      if (eq2.status !== 0 || !existsSync(join(skillDir, '.acme-host/skills/dev-flow/SKILL.md'))) {
        return 'equip 重跑误删了宿主镜像目录'
      }
      if (!(sFacts.docs?.subdirAgentsFiles ?? []).includes('packages/billing/AGENTS.md')) {
        return `未扫描子目录 */AGENTS.md：${JSON.stringify(sFacts.docs?.subdirAgentsFiles)}`
      }
      if (!(sFacts.docs?.otherAiConventions ?? []).includes('packages/billing/CLAUDE.md')) {
        return `未扫描子目录 */CLAUDE.md：${JSON.stringify(sFacts.docs?.otherAiConventions)}`
      }
      const directRes = discoverCustomSkillsWithMirrors(skillDir, new Set(getKitSkills()), sFacts.kit)
      if (directRes.mirrorCopies.length < 2) {
        return `discoverCustomSkillsWithMirrors 返回异常：${JSON.stringify(directRes)}`
      }

      // 2. 双语 & pyproject / cmd/*/main.go
      await gitInit(polyDir)
      gitCommitFast(polyDir, 'init poly')
      const pFacts = await survey(polyDir)
      if (!(pFacts.docs?.localizedDocs ?? []).includes('README.zh-CN.md')
        || !(pFacts.docs?.securityDocs ?? []).includes('SECURITY.zh-CN.md')
        || pFacts.docs?.contributing !== 'CONTRIBUTING.md') {
        return `双语公共文档探测不全：${JSON.stringify(pFacts.docs)}`
      }
      const pMap = await generateRepoMap(polyDir)
      if (!pMap.entrypoints.includes('src/poly/cli.py') || !pMap.entrypoints.includes('cmd/worker/main.go')) {
        return `pyproject [project.scripts] 或 Go cmd/*/main.go 漏扫：${JSON.stringify(pMap.entrypoints)}`
      }
      if (pMap.cliEntrypoints.some((c) => c.file === 'test/cmd/fake/main.go')) {
        return `test 目录下的 cmd 伪文件误进入 cliEntrypoints：${JSON.stringify(pMap.cliEntrypoints)}`
      }
      const agentsRaw = readFileSync(join(polyDir, 'AGENTS.md'), 'utf8')
      const rules = parseCoupledSyncRules(agentsRaw)
      const wReadme = evaluateCoupledSync(['README.md'], rules, polyDir)
      const wContrib = evaluateCoupledSync(['CONTRIBUTING.md'], rules, polyDir)
      const wBothContrib = evaluateCoupledSync(['CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md'], rules, polyDir)
      if (wContrib.length === 0 || !wContrib[0].expectedCompanions.includes('CONTRIBUTING.zh-CN.md') || wBothContrib.length !== 0 || wReadme.length !== 0) {
        return `双语伴随同步判定异常：wContrib=${JSON.stringify(wContrib)}, wBoth=${JSON.stringify(wBothContrib)}`
      }
      const parityOk = checkDocCodeParity(polyDir, polyDir, {
        files: [{ status: 'M', file: 'src/poly/cli.py' }, { status: 'M', file: 'README.zh-CN.md' }],
        untracked: [],
        text: '',
      }, {}, {})
      if (!parityOk.docsTouched.includes('README.zh-CN.md') || parityOk.docCodeMismatch) {
        return `review-gates checkDocCodeParity 未认可 README.zh-CN.md：${JSON.stringify(parityOk)}`
      }
      writeFileSync(join(polyDir, 'README.zh-CN.md'), '# 多语应用 v2\n\n更新。\n')
      writeFileSync(join(polyDir, 'SECURITY.zh-CN.md'), '# 安全政策 v2\n\n更新。\n')
      gitCommitFast(polyDir, 'feat: update localized docs')
      gitSync(polyDir, ['tag', 'v0.1.0'])
      writeFileSync(join(polyDir, 'README.zh-CN.md'), '# 多语应用 v3\n\n新增说明。\n')
      writeFileSync(join(polyDir, 'SECURITY.zh-CN.md'), '# 安全政策 v3\n\n新增渠道。\n')
      gitCommitFast(polyDir, 'feat: document security')
      const relPrepRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', polyDir, '--version', '0.2.0', '--from', 'v0.1.0', '--json'])
      if (relPrepRes.status !== 0) return `release-prep CLI 失败：${relPrepRes.stderr || relPrepRes.stdout}`
      const relPrep = JSON.parse(relPrepRes.stdout)
      if (!(relPrep.publicSurfaceTouched ?? []).includes('README.zh-CN.md') || !(relPrep.publicSurfaceTouched ?? []).includes('SECURITY.zh-CN.md')) {
        return `release-prep 未把双语公开文档纳入 publicSurfaceTouched：${JSON.stringify(relPrep.publicSurfaceTouched)}`
      }

      // 3. e2e / webtest 隔离 & 多 workflow 聚合去重
      const sniffE2e = sniffLayeredCommands(e2eDir, { kinds: ['node'] })
      if (sniffE2e.quickTest !== 'npm --prefix packages/core test') {
        return `quick-test 未隔离重型 e2e/webtest 包：${sniffE2e.quickTest}`
      }
      if ((sniffE2e.e2eCommands?.length ?? 0) < 2) {
        return `e2eCommands 未收集隔离的 e2e/webtest 命令：${JSON.stringify(sniffE2e.e2eCommands)}`
      }
      const sniffMulti = sniffLayeredCommands(multiCiDir, { kinds: ['node'] })
      if (sniffMulti.ciCommands.test !== 'npm test && pytest'
        || sniffMulti.ciVerifyCommands.filter((c) => c === 'npm test').length !== 1) {
        return `多 workflow 验证命令未正确聚合去重：${JSON.stringify({ ci: sniffMulti.ciCommands, verify: sniffMulti.ciVerifyCommands })}`
      }
      return true
    } finally {
      rmTree(skillDir)
      rmTree(polyDir)
      rmTree(e2eDir)
      rmTree(multiCiDir)
    }
  }])
}
