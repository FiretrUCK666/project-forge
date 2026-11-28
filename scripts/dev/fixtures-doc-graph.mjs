/**
 * fixtures-doc-graph.mjs —— 通用文档图谱内核（doc-graph.mjs）、五分法核账、前缀匹配与 Case 5/3/TDD Brief UX 正反双向夹具。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildDocGraph, resolveDocAnchor } from '../../kit/skills/lib/doc-graph.mjs'
import { extractHeadingSlugs, slugifyHeading } from '../../kit/skills/lib/markdown-scan.mjs'
import { discoverEvergreenDocs, parseAgentsProfile } from '../../kit/skills/lib/profile.mjs'
import { checkEvergreenAuthorityDocs } from '../../kit/skills/dev-govern/scripts/govern-evergreen.mjs'
import { assembleReviewContext, formatReviewContextLines } from '../../kit/skills/dev-review/scripts/review-context.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, survey, tmpProject } from './fixtures-helpers.mjs'
import { equip } from '../equip.mjs'

const DOC_PLAN = 'kit/skills/dev-plan/scripts/doc-plan.mjs'
const VERIFY_TOOLS = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
const GOVERN_AUDIT = 'kit/skills/dev-govern/scripts/govern-audit.mjs'

export function registerDocGraphCases(cases) {
  cases.push(['DocGraph C1：五分法核账、非 Markdown 权威对象、profile:378 修复与任意文件名未纳管/豁免', async () => {
    const dir = tmpProject({
      'AGENTS.md': [
        '# Demo',
        '',
        '## Dev Profile',
        '',
        '```yaml',
        'quick-test: node --test',
        'arch-rules: none',
        'evergreen-docs:',
        '  - openapi.yaml',
        '  - prisma/schema.prisma',
        '  - src/index.ts',
        'non-governed-docs:',
        '  - docs/scratch-notes.md',
        '```',
        '',
      ].join('\n'),
      'README.md': '# Demo\n\nSee [Guide](docs/GUIDE.md#valid-section).\n',
      'openapi.yaml': 'openapi: 3.1.0\n',
      'prisma/schema.prisma': 'model User { id Int @id }\n',
      'src/index.ts': 'export const ok = true\n',
      'docs/GUIDE.md': '# Guide\n\n## Valid Section\n\nContent here.\n',
      'docs/CUSTOM_UNLINKED.md': '# Custom Unlinked\n\nNot linked from anywhere.\n',
      'docs/scratch-notes.md': '# Scratch Notes\n\nExplicitly non-governed via AGENTS.md.\n',
      'docs/fm-optout.md': '---\ngoverned: false\n---\n\n# Opted Out\n',
      'docs/specs/261126-demo-spec.md': '# Spec\n\nTransient spec.\n',
    })
    try {
      const graph = buildDocGraph(dir)
      const authPaths = new Set(graph.accounted.registeredAuthority.map((d) => d.path))
      for (const req of ['openapi.yaml', 'prisma/schema.prisma', 'src/index.ts', 'docs/GUIDE.md']) {
        if (!authPaths.has(req)) return `registeredAuthority 遗漏 ${req}：${JSON.stringify([...authPaths])}`
      }
      const unaccPaths = graph.accounted.unaccounted.map((d) => d.path)
      if (!unaccPaths.includes('docs/CUSTOM_UNLINKED.md')) {
        return `unaccounted 漏检任意文件名 docs/CUSTOM_UNLINKED.md：${JSON.stringify(unaccPaths)}`
      }
      if (unaccPaths.includes('docs/scratch-notes.md') || unaccPaths.includes('docs/fm-optout.md')) {
        return `explicitNonGoverned 文档误入 unaccounted：${JSON.stringify(unaccPaths)}`
      }
      if (unaccPaths.includes('docs/specs/261126-demo-spec.md')) {
        return `瞬态 docs/specs/ 误入 unaccounted：${JSON.stringify(unaccPaths)}`
      }
      // govern-evergreen 报出未纳管活跃文档，加 frontmatter governed:false 后消解
      const findings1 = []
      checkEvergreenAuthorityDocs(dir, [], readFileSync(join(dir, 'AGENTS.md'), 'utf8'), null, findings1)
      if (!findings1.some((f) => f.id === 'docs.unaccounted-active-doc.docs/CUSTOM_UNLINKED.md')) {
        return `checkEvergreenAuthorityDocs 未检出未纳管文档：${JSON.stringify(findings1)}`
      }
      writeFileSync(join(dir, 'docs/CUSTOM_UNLINKED.md'), '---\ngoverned: false\n---\n\n# Opted Out\n', 'utf8')
      const findings2 = []
      checkEvergreenAuthorityDocs(dir, [], readFileSync(join(dir, 'AGENTS.md'), 'utf8'), null, findings2)
      if (findings2.some((f) => f.id === 'docs.unaccounted-active-doc.docs/CUSTOM_UNLINKED.md')) {
        return `governed: false 豁免后仍误报 unaccounted：${JSON.stringify(findings2)}`
      }

      // profile.mjs:378 修复：多行 evergreen-docs: - none 写入 explicitNone('evergreen-docs') 而非误落 arch-rules
      const dirNone = tmpProject({
        'AGENTS.md': [
          '# None Test',
          '',
          '## Dev Profile',
          '',
          '```yaml',
          'quick-test: node --test',
          'evergreen-docs:',
          '  - none',
          '```',
          '',
        ].join('\n'),
        'README.md': '# None Test\n',
      })
      try {
        const prof = parseAgentsProfile(dirNone)
        if (!prof.explicitNone.has('evergreen-docs') || prof.explicitNone.has('arch-rules')) {
          return `multiline evergreen-docs: none 误写入 explicitNone：${JSON.stringify([...prof.explicitNone])}`
        }
      } finally { rmTree(dirNone) }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['DocGraph C1/C2：4 项纯图谱校验（断链/断锚点与围栏隔离、环与双语豁免、多跳链、孤立/分歧）', async () => {
    const dir = tmpProject({
      'README.md': '# Home\n\n- [EN](README.en.md)\n- [Guide](docs/GUIDE.md#valid-heading)\n- [BadAnchor](docs/GUIDE.md#missing-heading)\n- [Dead](docs/NO_SUCH_DOC.md)\n- [Tdd](docs/TDD.md)\n\n```md\n[ignored](docs/FENCED_DEAD.md#nope)\n```\n',
      'README.en.md': '# Home EN\n\n- [ZH](README.md)\n- [Tdd](TDD.md)\n',
      'docs/GUIDE.md': '# Guide\n\n## Valid Heading\n\nReal content line 1.\nReal content line 2.\nReal content line 3.\nReal content line 4.\nReal content line 5.\nReal content line 6.\nReal content line 7.\n',
      'docs/TDD.md': '# TDD\n\nCore architecture.\n',
      'TDD.md': '# Root TDD\n\nRoot copy.\n',
      'docs/ORPHAN.md': '---\nevergreen: true\n---\n\n# Orphan\n\nUnreachable from entry.\n',
      'docs/hop1.md': '# Hop 1\n\nSee [Hop 2](hop2.md).\n',
      'docs/hop2.md': '# Hop 2\n\nSee [Guide](GUIDE.md).\n',
      'docs/cyc-a.md': '# Cyc A\n\nSee [Cyc B](cyc-b.md).\n',
      'docs/cyc-b.md': '# Cyc B\n\nSee [Cyc A](cyc-a.md).\n',
      'docs/dup.md': '# Dup\n\nSee [Root Dup](../dup.md).\n',
      'dup.md': '# Root Dup\n\nSee [Docs Dup](docs/dup.md).\n',
    })
    try {
      const slugs = extractHeadingSlugs('# Title\n\n## Valid Heading\n\n```md\n## Fenced Heading\n```\n')
      if (!slugs.has(slugifyHeading('Valid Heading')) || slugs.has('fenced-heading')) {
        return `extractHeadingSlugs 围栏隔离异常：${JSON.stringify([...slugs])}`
      }
      const graph = buildDocGraph(dir)
      if (!graph.brokenLinks.some((b) => b.target === 'docs/NO_SUCH_DOC.md') || graph.brokenLinks.some((b) => b.target.includes('FENCED_DEAD.md'))) {
        return `brokenLinks 检出异常：${JSON.stringify(graph.brokenLinks)}`
      }
      if (!graph.brokenAnchors.some((b) => b.fragment === 'missing-heading') || graph.brokenAnchors.some((b) => b.fragment === 'valid-heading')) {
        return `brokenAnchors 检出异常：${JSON.stringify(graph.brokenAnchors)}`
      }
      if (!graph.cycles.some((c) => c.nodes.includes('docs/cyc-a.md') && c.nodes.includes('docs/cyc-b.md'))) {
        return `cycles 未检出 cyc-a <-> cyc-b：${JSON.stringify(graph.cycles)}`
      }
      if (graph.cycles.some((c) => c.nodes.includes('README.md') || c.nodes.includes('README.en.md'))) {
        return `cycles 误报入口双语互链：${JSON.stringify(graph.cycles)}`
      }
      if (!graph.redirectChains.some((r) => r.from === 'docs/hop1.md' && r.to === 'docs/GUIDE.md' && r.hops === 2)) {
        return `redirectChains 未检出 2 跳链：${JSON.stringify(graph.redirectChains)}`
      }
      if (!graph.orphans.some((o) => o.path === 'docs/ORPHAN.md')) {
        return `orphans 未检出不可达权威文档 docs/ORPHAN.md：${JSON.stringify(graph.orphans)}`
      }
      if (!graph.entryDivergence.some((d) => d.stem === 'tdd')) {
        return `entryDivergence 未检出双语入口分歧：${JSON.stringify(graph.entryDivergence)}`
      }
      if (!graph.duplicateGroups.some((g) => g.stem === 'dup')) {
        return `循环互指同词干副本 dup 应保留在 duplicateGroups：${JSON.stringify(graph.duplicateGroups)}`
      }
      // review-context 注入图谱结构告警
      const rc = await assembleReviewContext({
        reviewRoot: dir, mainRoot: dir, gitDir: null,
        diff: { files: [{ file: 'docs/GUIDE.md', status: 'M' }], untracked: [] },
        effectiveProfile: {}, baseRef: null, task: { taskId: 'dg-rev' },
      })
      const rcLines = formatReviewContextLines(rc).join('\n')
      if ((rc.docGraphWarnings?.length ?? 0) === 0 || !rcLines.includes('Doc Graph Alerts')) {
        return `review-context 未注入 docGraph 结构告警：${JSON.stringify(rc.docGraphWarnings)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['DocGraph C2：目录前缀匹配对齐（govern-audit / verify-tools-audit）、anchorWarnings 与 survey S1 注入', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'prefix-demo', version: '1.0.0', type: 'module' }, null, 2),
      'AGENTS.md': '# Prefix Demo\n\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'README.md': '# Prefix Demo\n\nSee [TDD](docs/TDD.md).\n',
      'docs/TDD.md': '# TDD\n\n## Core\n\nCovers `src/auth/`.\n',
      'docs/UNACCOUNTED.md': '# Unaccounted\n\nFloating active doc.\n',
      'src/auth/login.mjs': 'export function login(u) { return Boolean(u) }\n',
      'src/auth/token.mjs': 'export function issueToken() { return "tok" }\n',
      'src/billing/pay.mjs': 'export function pay() { return 1 }\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        features: [{
          id: 'auth', name: 'Auth',
          entrypoints: ['src/auth/'], modules: ['src/auth/'],
          businessFlows: ['login flow'],
          verificationTools: [{ id: 'vt-auth', kind: 'command', command: 'exit 0', riskLevel: 'medium' }],
          testRefs: [],
          docAnchors: ['docs/TDD.md#core', 'docs/TDD.md#non-existent-heading'],
        }],
      }, null, 2),
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      gitCommitFast(dir, 'chore: init')

      // 1. resolveDocAnchor 与 verify-tools audit anchorWarnings（不阻塞退出码）+ 目录前缀匹配
      const anchorOk = resolveDocAnchor(dir, 'docs/TDD.md#core')
      const anchorWarn = resolveDocAnchor(dir, 'docs/TDD.md#non-existent-heading')
      if (!anchorOk.exists || !anchorOk.headingFound || !anchorWarn.exists || anchorWarn.headingFound) {
        return `resolveDocAnchor 判定异常：ok=${JSON.stringify(anchorOk)} warn=${JSON.stringify(anchorWarn)}`
      }
      const vtRes = await runAbsAsync(VERIFY_TOOLS, ['audit', dir, '--json'])
      if (vtRes.status !== 0) return `仅缺 #heading 时 verify-tools audit 不应硬阻断：exit=${vtRes.status} out=${vtRes.stdout}`
      const vtJson = JSON.parse(vtRes.stdout || '{}')
      if (!vtJson.anchorWarnings?.some((w) => w.kind === 'missing-doc-anchor-heading' && w.fragment === 'non-existent-heading')) {
        return `verify-tools audit 未输出 anchorWarnings：${vtRes.stdout}`
      }
      if (vtJson.blindSpots?.some((b) => b.kind === 'unmapped-entrypoint' && String(b.path).startsWith('src/auth/'))) {
        return `verify-tools audit 目录前缀未覆盖 src/auth/：${JSON.stringify(vtJson.blindSpots)}`
      }

      // 2. govern-audit reconcile 目录前缀匹配 + docGraph 摘要
      const recRes = await runAbsAsync(GOVERN_AUDIT, ['reconcile', dir, '--json'])
      if (recRes.status !== 0) return `govern-audit reconcile 失败：${recRes.stderr}`
      const recJson = JSON.parse(recRes.stdout || '{}')
      const unmapped = recJson.reconcileSummary?.featureMapDrift?.unmappedSourceModules ?? []
      if (unmapped.some((p) => p.startsWith('src/auth/')) || !unmapped.includes('src/billing/pay.mjs')) {
        return `govern-audit 目录前缀匹配异常：unmapped=${JSON.stringify(unmapped)}`
      }
      if (!recJson.reconcileSummary?.docGraph?.unaccountedDocs?.includes('docs/UNACCOUNTED.md')) {
        return `reconcileSummary.docGraph 漏掉未纳管文档：${JSON.stringify(recJson.reconcileSummary?.docGraph)}`
      }

      // 3. survey 暴露 docGraph 并在 parallel-subagents 时注入 S1 分片（且不含 AGENTS.md）
      const bigBody = Array.from({ length: 420 }, (_, i) => `export const c${i} = ${i}`).join('\n')
      mkdirSync(join(dir, 'src/heavy'), { recursive: true })
      for (let i = 0; i < 12; i += 1) writeFileSync(join(dir, `src/heavy/h${i}.mjs`), bigBody, 'utf8')
      const sv = await survey(dir)
      if (!sv.docGraph?.unaccountedDocs?.some((d) => d.path === 'docs/UNACCOUNTED.md')) {
        return `survey.docGraph 未暴露 docs/UNACCOUNTED.md：${JSON.stringify(sv.docGraph)}`
      }
      const convShard = sv.explorationStrategy?.shards?.find((s) => s.id === 'conventions-and-skills')
      if (!convShard || !convShard.targets.includes('docs/UNACCOUNTED.md') || convShard.targets.includes('AGENTS.md')) {
        return `S1 explorationStrategy 分片注入异常或泄漏 AGENTS.md：${JSON.stringify(convShard)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['DocGraph C3：Case 5/3 triage 路由、Case 5 & init --kind tdd 简报生成、init htmlUri 与 approve --agent', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'brief-ux-demo', version: '1.0.0', type: 'module' }, null, 2),
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: node --test\n```\n',
      'README.md': '# Demo\n',
      'docs/TDD.md': '# TDD\n\n## Core\n\nArchitecture.\n',
      'src/app.mjs': 'export const app = () => 1\n',
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      gitCommitFast(dir, 'chore: init')
      equip(dir, { noBackup: true })
      gitCommitFast(dir, 'chore: equip skills')

      // 1. Case 5 triage 生成 visualBrief 且经 withNextSteps 输出含 init --kind tdd 指引
      const c5 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', '推翻 TDD 重新设计核心架构', '--conflicts-tdd', '--json'], { cwd: dir })
      if (c5.status !== 0) return `Case 5 triage 失败：${c5.stderr}`
      const j5 = JSON.parse(c5.stdout || '{}')
      if (j5.caseType !== 5 || !j5.visualBrief?.htmlUri || !existsSync(j5.visualBrief.htmlPath)) {
        return `Case 5 未生成 Living Visual Brief：${c5.stdout}`
      }
      if (!Array.isArray(j5.nextSteps) || !j5.nextSteps.some((s) => String(s ?? '').includes('init --kind tdd'))) {
        return `Case 5 nextSteps 缺少 init --kind tdd 指引：${JSON.stringify(j5.nextSteps)}`
      }

      // 2. 局部可逆 Case 3 triage 确定性路由至 sandbox（flow.mjs start --sandbox）
      const c3 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', '新增 CSV 导出参数', '--files', '2', '--json'], { cwd: dir })
      if (c3.status !== 0) return `Case 3 triage 失败：${c3.stderr}`
      const j3 = JSON.parse(c3.stdout || '{}')
      if (j3.caseType !== 3 || j3.recommendedEntry !== 'sandbox' || !j3.nextSteps?.some((s) => String(s?.text ?? s).includes('flow.mjs" start --sandbox'))) {
        return `局部可逆 Case 3 triage 未路由至 flow.mjs start --sandbox：${JSON.stringify({ recommendedEntry: j3.recommendedEntry, nextSteps: j3.nextSteps })}`
      }

      // 3. init --kind tdd 刷新 visualBrief 且 init 文本输出打印 Living Visual Brief htmlUri
      const initTdd = await runAbsAsync(DOC_PLAN, ['init', '--kind', 'tdd', '--slug', 'tdd', '--title', 'Brief UX Demo', '--force'], { cwd: dir })
      if (initTdd.status !== 0 || !initTdd.stdout.includes('Living Visual Brief') || !initTdd.stdout.includes('file://')) {
        return `init --kind tdd 未输出 Living Visual Brief htmlUri：status=${initTdd.status} out=${initTdd.stdout}`
      }

      // 4. Case 4 approve nextStep 携带 --agent
      const initPair = await runAbsAsync(DOC_PLAN, ['init', '--kind', 'pair', '--slug', 'ux-case4', '--title', 'UX Case 4', '--scope', 'src/app.mjs', '--criteria', '运行 node src/app.mjs 返回 1 (exit 0)', '--plan-mode', 'autonomous', '--agent', 'planner-demo', '--in-place', '--json'], { cwd: dir })
      if (initPair.status !== 0) return `init pair 失败：${initPair.stderr}`
      const jPair = JSON.parse(initPair.stdout || '{}')
      const specFile = jPair.files.find((f) => f.endsWith('-spec.md'))
      const rawSpec = readFileSync(join(dir, specFile), 'utf8')
        .replace(/<[^>]+>/g, 'src/app.mjs')
        .replace(/待确认：[^\n]*/g, '无')
      writeFileSync(join(dir, specFile), rawSpec, 'utf8')
      const audRes = await runAbsAsync(DOC_PLAN, ['audit', '--file', specFile, '--json'], { cwd: dir })
      if (audRes.status !== 0) return `spec audit 失败：${audRes.stdout} ${audRes.stderr}`
      const passRes = await runAbsAsync(DOC_PLAN, ['critique-pass', '--file', specFile, '--reviewer', 'critic-1', '--round', '1', '--summary', 'ok', '--json'], { cwd: dir })
      if (passRes.status !== 0) return `critique-pass 失败：${passRes.stderr || passRes.stdout}`
      const appRes = await runAbsAsync(DOC_PLAN, ['approve', '--file', specFile, '--json'], { cwd: dir })
      if (appRes.status !== 0) return `approve 失败：${appRes.stderr || appRes.stdout}`
      const jApp = JSON.parse(appRes.stdout || '{}')
      if (!String(jApp.nextStep ?? '').includes('--agent')) {
        return `Case 4 approve nextStep 缺少 --agent：${JSON.stringify(jApp.nextStep)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['DocGraph C2 回归：洁净仓库 govern-audit reconcile 无 docGraphSummary TDZ 崩溃', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'clean-reconcile-demo', version: '1.0.0', type: 'module' }, null, 2),
      'AGENTS.md': [
        '# Clean Demo',
        '',
        '## Dev Profile',
        '',
        '```yaml',
        'quick-test: node --test',
        'full-test: node --test',
        'smoke-verify: none',
        'merge-gate: none',
        'arch-rules: none',
        'high-risk: none',
        'do-not-edit: none',
        '```',
        '',
        '## 取舍',
        '',
        '- `no-tdd`: 最小单域示例',
        '- `no-architecture-html`: 无离线地图',
        '',
      ].join('\n'),
      'README.md': '# Clean Demo\n\nSee [Guide](docs/guide.md#overview).\n',
      'docs/guide.md': '# Guide\n\n## Overview\n\nMain module: `src/app.mjs`.\n',
      'src/app.mjs': 'export const run = () => 1\n',
      'tests/app.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [{ id: 'core', name: 'Core', docAnchors: ['docs/guide.md#overview'] }],
        features: [{
          id: 'app',
          name: 'App',
          domain: 'core',
          entrypoints: ['src/app.mjs'],
          modules: ['src/app.mjs'],
          businessFlows: ['run app'],
          docAnchors: ['docs/guide.md#overview'],
          verificationTools: [{
            id: 'verify-app',
            kind: 'command',
            command: 'node --test',
            scriptPath: null,
            riskLevel: 'low',
          }],
          testRefs: ['tests/app.test.mjs'],
        }],
      }, null, 2),
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      gitCommitFast(dir, 'chore: init clean repo')
      const rec = await runAbsAsync(GOVERN_AUDIT, ['reconcile', dir, '--json'], { cwd: dir })
      if (rec.status !== 0) {
        return `洁净仓库 govern-audit reconcile 崩溃：exit=${rec.status} stderr=${rec.stderr} stdout=${rec.stdout}`
      }
      const parsed = JSON.parse(rec.stdout || '{}')
      const summary = parsed.reconcileSummary
      if (!Array.isArray(parsed.findings) || parsed.findings.length !== 0) {
        return `洁净仓库应无 findings（避免 docGapOrDrift 短路）：${JSON.stringify(parsed.findings)}`
      }
      if (!summary || summary.verifyToolsAudit?.schemaOk !== true) {
        return `verifyToolsAudit.schemaOk 应为 true：${JSON.stringify(summary?.verifyToolsAudit)}`
      }
      if (!Array.isArray(summary.featureMapDrift?.unmappedSourceModules) || summary.featureMapDrift.unmappedSourceModules.length !== 0) {
        return `featureMapDrift.unmappedSourceModules 应为空：${JSON.stringify(summary.featureMapDrift)}`
      }
      if (!Array.isArray(summary.nextCommands) || summary.nextCommands.length !== 0) {
        return `洁净仓库 nextCommands 应为空：${JSON.stringify(summary.nextCommands)}`
      }
      if (!summary.docGraph || summary.docGraph.unaccountedCount !== 0 || summary.docGraph.brokenAnchorsCount !== 0 || summary.docGraph.cyclesCount !== 0) {
        return `reconcileSummary.docGraph 异常：${JSON.stringify(summary.docGraph)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
