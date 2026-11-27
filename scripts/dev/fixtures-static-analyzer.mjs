/**
 * fixtures-static-analyzer.mjs —— Milestone B Slice 1 (`zero-token-static-analyzer`, C1..C4)
 * 覆盖 7 类异构仓库栈（空仓、Node/TS 单仓与 Monorepo、Python/Go/Rust、Prisma/SQL、前端 UI、
 * CI 密集、非 JS 无清单）的正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT, gitCommitFast, gitInit, gitSync, rmTree, tmpProject } from './fixtures-helpers.mjs'
import { renderArchitectureMapFromRepo, verifyArchitectureMapSync } from '../../kit/skills/lib/architecture-map.mjs'
import { findSccs } from '../../kit/skills/lib/doc-graph.mjs'
import { extractImportsForArch, resolveGoModules, resolveLocalImportTarget } from '../../kit/skills/lib/import-graph.mjs'

async function loadAnalyzerMods() {
  const analyzer = await import('../../kit/skills/lib/static-analyzer.mjs')
  const evidence = await import('../../kit/skills/lib/static-evidence.mjs')
  const materiality = await import('../../kit/skills/lib/diff-materiality.mjs')
  return { analyzer, evidence, materiality }
}

export function registerStaticAnalyzerCases(cases) {
  cases.push(['[StaticAnalyzer-C1] import-graph 复用与 doc-graph findSccs 导出保持正反语义一致', async () => {
    const dir = tmpProject({
      'go.mod': 'module example.com/acme\n\ngo 1.22\n',
      'internal/a/a.go': 'package a\nimport "example.com/acme/internal/b"\nfunc A() { _ = b.B }\n',
      'internal/b/b.go': 'package b\nfunc B() {}\n',
      'src/app.ts': 'import { run } from "./svc.js"\n// import { ghost } from "./ghost.js"\nexport const x = run()\n',
      'src/svc.ts': 'export function run() { return 1 }\n',
    })
    try {
      const goMods = resolveGoModules(dir)
      if (goMods.length !== 1 || goMods[0].mod !== 'example.com/acme') {
        return `resolveGoModules 结果异常: ${JSON.stringify(goMods)}`
      }
      const goImps = extractImportsForArch('internal/a/a.go', readFileSync(join(dir, 'internal/a/a.go'), 'utf8'), goMods)
      const fileSet = new Set(['internal/a/a.go', 'internal/b/b.go', 'src/app.ts', 'src/svc.ts'])
      const goTarget = resolveLocalImportTarget(goImps[0]?.candidates ?? [], fileSet)
      if (goTarget !== 'internal/b/b.go') return `Go 本地包映射失败: ${goTarget}`

      const tsImps = extractImportsForArch('src/app.ts', readFileSync(join(dir, 'src/app.ts'), 'utf8'), goMods)
      if (tsImps.length !== 1) return `注释中伪 import 未被剥离: ${JSON.stringify(tsImps)}`
      const tsTarget = resolveLocalImportTarget(tsImps[0].candidates, fileSet)
      if (tsTarget !== 'src/svc.ts') return `TS .js -> .ts 解析失败: ${tsTarget}`

      const sccs = findSccs(new Set(['a', 'b', 'c']), new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['c', new Set()]]))
      if (sccs.length !== 1 || sccs[0].join(',') !== 'a,b') return `findSccs 异常: ${JSON.stringify(sccs)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StaticAnalyzer-C1] 栈1空仓与非Git降级：0文件不崩溃且仅激活Tier1零空Tab', async () => {
    const dir = tmpProject({})
    try {
      const { analyzer, evidence } = await loadAnalyzerMods()
      const res = await analyzer.analyzeRepoStatic(dir)
      if (res.isGit !== false || res.nodes.length !== 0 || res.edges.length !== 0) {
        return `空仓分析结果异常: ${JSON.stringify({ isGit: res.isGit, nodes: res.nodes.length, edges: res.edges.length })}`
      }
      if (!res.degradedReason) return '非 Git 空仓应给出显式 degradedReason'
      const ev = await evidence.extractMultiDiagramEvidence(dir, { analysis: res })
      const activeIds = ev.activeTabs.map((t) => t.id).sort().join(',')
      if (activeIds !== 'architecture,tree,workflow') return `空仓 Tier 1 激活集异常: ${activeIds}`
      if (ev.skippedTabs.length !== 7) return `空仓应跳过全部 7 个 Tier2/3 图表，实际 ${ev.skippedTabs.length}`
      if (ev.skippedTabs.some((t) => !t.reason)) return 'skippedTabs 必须附带 reason'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StaticAnalyzer-C1] 栈2 Node/TS Monorepo：耦合/SCC环/Git热度/仓外增量缓存命中失效与损坏自愈且工作区零污染', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }, null, 2),
      'packages/core/a.ts': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
      'packages/core/b.ts': 'import { a } from "./a.js"\nexport function b() { return a() }\n',
      'packages/api/routes.ts': 'import { handle } from "./controller.js"\nexport const route = () => handle()\n',
      'packages/api/controller.ts': 'import { runService } from "./service.js"\nexport const handle = () => runService()\n',
      'packages/api/service.ts': 'import { queryRepo } from "./repo.js"\nexport const runService = () => queryRepo()\n',
      'packages/api/repo.ts': 'import { a } from "../core/a.js"\nexport const queryRepo = () => a()\n',
    })
    try {
      gitInit(dir, { branch: 'main', message: 'feat: initial monorepo' })
      writeFileSync(join(dir, 'packages/api/service.ts'), 'import { queryRepo } from "./repo.js"\nexport const runService = () => queryRepo() + 1\n')
      gitCommitFast(dir, 'fix: bump service')

      const { analyzer } = await loadAnalyzerMods()
      const cachePath = analyzer.resolveAnalysisCachePath(dir)
      if (!cachePath.replace(/\\/g, '/').includes('/.git/project-forge-flow/analysis-cache.json')) {
        return `Git 仓缓存路径未落在 gitCommonDir 仓外目录: ${cachePath}`
      }

      const first = await analyzer.analyzeRepoStatic(dir)
      if (first.cycles.length !== 1 || first.cycles[0].nodes.length !== 2) {
        return `应识别 packages/core 双向环，实际: ${JSON.stringify(first.cycles)}`
      }
      if (!first.coupling['packages/core/a.ts']?.inCycle || first.coupling['packages/core/a.ts'].fanIn < 2) {
        return `耦合指标异常: ${JSON.stringify(first.coupling['packages/core/a.ts'])}`
      }
      if ((first.churn['packages/api/service.ts']?.commits ?? 0) < 2) {
        return `Git 热度统计异常: ${JSON.stringify(first.churn['packages/api/service.ts'])}`
      }
      if (first.cacheStats.misses < 6 || first.cacheStats.hits !== 0 || !existsSync(cachePath)) {
        return `首次分析缓存统计异常: ${JSON.stringify(first.cacheStats)}`
      }

      const second = await analyzer.analyzeRepoStatic(dir)
      if (second.cacheStats.misses !== 0 || second.cacheStats.hits < 6) {
        return `二次分析应全量命中缓存，实际: ${JSON.stringify(second.cacheStats)}`
      }

      // 修改单个文件触发局部失效（blobSha/mtime 变更）
      writeFileSync(join(dir, 'packages/api/repo.ts'), 'import { a } from "../core/a.js"\nexport const queryRepo = () => a() + 2\nexport const extraSym = 42\n')
      const third = await analyzer.analyzeRepoStatic(dir)
      if (third.cacheStats.misses !== 1 || third.cacheStats.hits < 5) {
        return `单文件修改应精确触发 1 次局部失效，实际: ${JSON.stringify(third.cacheStats)}`
      }
      const repoNode = third.nodes.find((n) => n.id === 'packages/api/repo.ts')
      if (!repoNode?.symbols?.includes('extraSym')) return '缓存失效后未重新解析新增符号 extraSym'

      // 恢复工作区后验证损坏缓存自愈 + 工作区 git status 为空
      gitSync(dir, ['checkout', '--', 'packages/api/repo.ts'])
      writeFileSync(cachePath, '{corrupt json', 'utf8')
      const healed = await analyzer.analyzeRepoStatic(dir)
      if (!healed.cacheStats.recovered || healed.cacheStats.misses < 6) {
        return `损坏缓存未自动忽略并重建: ${JSON.stringify(healed.cacheStats)}`
      }
      const st = gitSync(dir, ['status', '--porcelain'], { encoding: 'utf8' })
      if ((st.stdout ?? '').trim() !== '') return `仓外缓存污染了工作区: ${st.stdout}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StaticAnalyzer-C2] 栈3 Python/Go/Rust：跨语言 class>=3 激活、导入图解析与低于阈值反例', async () => {
    const dir = tmpProject({
      'go.mod': 'module example.com/poly\n\ngo 1.22\n',
      'pkg/core/base.go': 'package core\ntype Base struct { ID string }\ntype Derived struct {\n  Base\n  Name string\n}\n',
      'pkg/svc/run.go': 'package svc\nimport "example.com/poly/pkg/core"\nfunc Run() core.Derived { return core.Derived{} }\n',
      'pyapp/models.py': 'class Entity:\n    pass\n\nclass User(Entity):\n    pass\n',
      'pyapp/service.py': 'from .models import User\ndef load():\n    return User()\n',
      'src/lib.rs': 'pub trait Store { fn get(&self); }\npub struct MemStore;\nimpl Store for MemStore { fn get(&self) {} }\n',
    })
    const smallDir = tmpProject({
      'src/only_two.ts': 'export class Base {}\nexport class ChildA extends Base {}\nexport class ChildB extends Base {}\n',
    })
    try {
      const { analyzer, evidence } = await loadAnalyzerMods()
      const res = await analyzer.analyzeRepoStatic(dir)
      const edgePairs = res.edges.map((e) => `${e.from}->${e.to}`)
      if (!edgePairs.includes('pkg/svc/run.go->pkg/core/base.go')) return `Go 跨包边缺失: ${edgePairs.join(', ')}`
      if (!edgePairs.includes('pyapp/service.py->pyapp/models.py')) return `Python 相对导入边缺失: ${edgePairs.join(', ')}`

      const ev = await evidence.extractMultiDiagramEvidence(dir, { analysis: res })
      if (!ev.diagrams.class || ev.diagrams.class.edges.length < 3) {
        return `跨 Go/Python/Rust 应提取 >=3 条类/接口边激活 class 图，实际: ${JSON.stringify(ev.diagrams.class)}`
      }
      if (!ev.activeTabs.some((t) => t.id === 'class')) return 'class 未进入 activeTabs'

      const negEv = await evidence.extractMultiDiagramEvidence(smallDir)
      if (negEv.activeTabs.some((t) => t.id === 'class') || negEv.diagrams.class) {
        return '仅 2 条继承边不应激活 class 图表（严格 >=3）'
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(smallDir)
    }
  }])

  cases.push(['[StaticAnalyzer-C2] 栈4 Prisma/SQL：erd 正例激活与注释伪 SQL 反例静默拦截', async () => {
    const posDir = tmpProject({
      'prisma/schema.prisma': 'model User {\n  id Int @id\n  email String\n  orders Order[]\n}\nmodel Order {\n  id Int @id\n  userId Int\n  user User @relation(fields: [userId], references: [id])\n}\n',
      'migrations/001_audit.sql': 'CREATE TABLE audit_logs (\n  id INT PRIMARY KEY,\n  user_id INT REFERENCES users(id)\n);\n',
    })
    const negDir = tmpProject({
      'src/readme_sql.sql': '-- CREATE TABLE fake_table (id INT);\n/* CREATE TABLE also_fake (id INT); */\n',
      'src/index.ts': 'export const ok = true\n',
    })
    try {
      const { evidence } = await loadAnalyzerMods()
      const posEv = await evidence.extractMultiDiagramEvidence(posDir)
      if (!posEv.diagrams.erd || posEv.diagrams.erd.entities.length < 3 || posEv.diagrams.erd.relations.length < 1) {
        return `Prisma/SQL 应激活 erd 且解析实体与关系，实际: ${JSON.stringify(posEv.diagrams.erd)}`
      }
      const negEv = await evidence.extractMultiDiagramEvidence(negDir)
      if (negEv.diagrams.erd || negEv.activeTabs.some((t) => t.id === 'erd')) {
        return `注释中的 SQL 不应激活 erd，实际: ${JSON.stringify(negEv.diagrams.erd)}`
      }
      return true
    } finally {
      rmTree(posDir)
      rmTree(negDir)
    }
  }])

  cases.push(['[StaticAnalyzer-C2] 栈5 前端UI：sequence>=3跳、lifecycle状态机正反双向门控', async () => {
    const posDir = tmpProject({
      'src/ui/CheckoutPage.tsx': 'import { useCart } from "../hooks/useCart.js"\nexport function CheckoutPage() { return useCart() }\n',
      'src/hooks/useCart.ts': 'import { submitOrder } from "../services/orderService.js"\nexport function useCart() { return submitOrder() }\n',
      'src/services/orderService.ts': 'import { postApi } from "../api/client.js"\nexport type OrderStatus = "draft" | "paid" | "shipped"\nexport const ORDER_TRANSITIONS = { draft: ["paid"], paid: ["shipped"] }\nexport function submitOrder() { return postApi() }\n',
      'src/api/client.ts': 'export function postApi() { return { ok: true } }\n',
    })
    const negDir = tmpProject({
      'src/a.ts': 'import { b } from "./b.js"\nexport const a = () => b()\n',
      'src/b.ts': 'import { c } from "./c.js"\nexport const b = () => c()\n',
      'src/c.ts': 'export type LoneStatus = "idle" | "busy"\nexport const c = () => 1\n',
    })
    try {
      const { evidence } = await loadAnalyzerMods()
      const posEv = await evidence.extractMultiDiagramEvidence(posDir)
      if (!posEv.diagrams.sequence || posEv.diagrams.sequence.maxHops < 3) {
        return `4 节点 3 跳调用链应激活 sequence，实际: ${JSON.stringify(posEv.diagrams.sequence)}`
      }
      if (!posEv.diagrams.lifecycle || posEv.diagrams.lifecycle.states.length < 3 || posEv.diagrams.lifecycle.transitions.length < 2) {
        return `状态枚举与迁移表应激活 lifecycle，实际: ${JSON.stringify(posEv.diagrams.lifecycle)}`
      }

      const negEv = await evidence.extractMultiDiagramEvidence(negDir)
      if (negEv.diagrams.sequence) return `仅 2 跳链不应激活 sequence: ${JSON.stringify(negEv.diagrams.sequence)}`
      if (negEv.diagrams.lifecycle) return `有状态枚举但无迁移边不应激活 lifecycle: ${JSON.stringify(negEv.diagrams.lifecycle)}`
      return true
    } finally {
      rmTree(posDir)
      rmTree(negDir)
    }
  }])

  cases.push(['[StaticAnalyzer-C2] 栈6 CI密集：dataflow/timeline>=2/Tier3 waterfall 实测遥测正反门控', async () => {
    const dir = tmpProject({
      '.github/workflows/ci.yml': [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  lint:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run lint',
        '  test:',
        '    needs: [lint]',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '  build:',
        '    needs: test',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run build',
      ].join('\n'),
      'src/index.js': 'export const ok = 1\n',
    })
    const singleJobDir = tmpProject({
      '.github/workflows/ping.yml': 'name: Ping\non: [push]\njobs:\n  ping:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
      'src/index.js': 'export const ok = 1\n',
    })
    try {
      gitInit(dir, { branch: 'main', message: 'chore: init' })
      gitSync(dir, ['tag', 'v0.1.0'])
      writeFileSync(join(dir, 'src/index.js'), 'export const ok = 2\n')
      gitCommitFast(dir, 'feat: bump')
      gitSync(dir, ['tag', 'v0.2.0'])

      gitInit(singleJobDir, { branch: 'main', message: 'chore: init' })
      gitSync(singleJobDir, ['tag', 'v0.1.0'])

      const { evidence } = await loadAnalyzerMods()
      const posEv = await evidence.extractMultiDiagramEvidence(dir, {
        telemetrySpans: [
          { id: 's1', label: 'parse', startMs: 0, durationMs: 12 },
          { id: 's2', label: 'graph', startMs: 12, durationMs: 18 },
        ],
      })
      if (!posEv.diagrams.dataflow || posEv.diagrams.dataflow.edges.length < 2) {
        return `CI jobs.needs 应激活 dataflow，实际: ${JSON.stringify(posEv.diagrams.dataflow)}`
      }
      if (!posEv.diagrams.timeline || posEv.diagrams.timeline.events.length < 2) {
        return `>=2 个 tag/merge 应激活 timeline，实际: ${JSON.stringify(posEv.diagrams.timeline)}`
      }
      if (!posEv.diagrams.waterfall || posEv.diagrams.waterfall.spans.length !== 2) {
        return `传入真实实测 telemetrySpans 应激活 waterfall，实际: ${JSON.stringify(posEv.diagrams.waterfall)}`
      }

      const noSpanEv = await evidence.extractMultiDiagramEvidence(dir, { telemetrySpans: [{ id: 'bad', label: 'nan', startMs: -1, durationMs: NaN }] })
      if (noSpanEv.diagrams.waterfall) return '非法/负数 telemetrySpans 不应激活 waterfall'

      const negEv = await evidence.extractMultiDiagramEvidence(singleJobDir)
      if (negEv.diagrams.dataflow) return '单 job 无 needs 工作流不应激活 dataflow'
      if (negEv.diagrams.timeline) return '仅 1 个 tag 且 0 merge 不应激活 timeline（严格 >=2）'
      if (negEv.diagrams.waterfall) return '未提供 telemetrySpans 不应激活 waterfall'
      return true
    } finally {
      rmTree(dir)
      rmTree(singleJobDir)
    }
  }])

  cases.push(['[StaticAnalyzer-C3] 栈7 非JS无清单与3-dot Materiality：Schema必触发、文档/锁/R100跳过、1-hop邻域与有界hunk', async () => {
    const nonJsDir = tmpProject({
      'Makefile': 'build:\n\t@echo ok\n',
      'bin/run.sh': '#!/bin/sh\necho hi\n',
    })
    const gitDir = tmpProject({
      'src/core.js': 'export const core = () => 1\n',
      'src/caller.js': 'import { core } from "./core.js"\nexport const call = () => core()\n',
      'src/unrelated.js': 'export const u = 0\n',
      'src/move_me.js': 'export const stable = "exact-same-content-for-r100"\n',
      'README.md': '# Hello\n',
      'package-lock.json': '{"lockfileVersion": 3}\n',
      'prisma/schema.prisma': 'model Item { id Int @id }\n',
    })
    try {
      const { analyzer, materiality } = await loadAnalyzerMods()
      const nonJsCache = analyzer.resolveAnalysisCachePath(nonJsDir)
      if (!nonJsCache.replace(/\\/g, '/').endsWith('/.worktrees/.state/analysis-cache.json')) {
        return `非 Git 仓缓存回退路径异常: ${nonJsCache}`
      }
      const nonJsDiff = await materiality.computePrDiffContext(nonJsDir)
      if (!nonJsDiff.degraded || nonJsDiff.hasMaterialChanges) {
        return `非 Git 仓 3-dot 差异应优雅降级: ${JSON.stringify(nonJsDiff)}`
      }

      gitInit(gitDir, { branch: 'main', message: 'init' })
      gitSync(gitDir, ['checkout', '-b', 'feat/pr-check'])
      // 先仅做非实质改动（文档 + 锁文件 + R100 纯重命名）
      writeFileSync(join(gitDir, 'README.md'), '# Updated docs\n')
      writeFileSync(join(gitDir, 'package-lock.json'), '{"lockfileVersion": 3, "name": "x"}\n')
      gitSync(gitDir, ['mv', 'src/move_me.js', 'src/moved_exact.js'])
      gitCommitFast(gitDir, 'docs: non-material edits')

      // 在 main 上新增无关提交，验证 3-dot merge-base...HEAD 不误把 main 改动算进来
      gitSync(gitDir, ['checkout', 'main'])
      writeFileSync(join(gitDir, 'src/unrelated.js'), 'export const u = 999\n')
      gitCommitFast(gitDir, 'chore: main moved ahead')
      gitSync(gitDir, ['checkout', 'feat/pr-check'])

      const skipCtx = await materiality.computePrDiffContext(gitDir, { baseRef: 'main', headRef: 'HEAD' })
      if (skipCtx.hasMaterialChanges || skipCtx.materialFiles.length !== 0) {
        return `纯文档/锁文件/R100 且 main 独立提交不应触发实质变更: ${JSON.stringify(skipCtx)}`
      }
      if (skipCtx.skippedFiles.length < 3) {
        return `应记录 3 个被跳过非实质文件，实际: ${JSON.stringify(skipCtx.skippedFiles)}`
      }

      // 追加 Schema 迁移与核心模块变更 -> 验证 Schema 必触发 + 1-hop 邻域 + 有界 hunk
      const bigBody = ['export const core = () => 2', ...Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i}`)].join('\n') + '\n'
      writeFileSync(join(gitDir, 'src/core.js'), bigBody)
      writeFileSync(join(gitDir, 'prisma/schema.prisma'), 'model Item { id Int @id\n name String }\n')
      gitCommitFast(gitDir, 'feat: schema and core update')

      const analysis = await analyzer.analyzeRepoStatic(gitDir)
      const matCtx = await materiality.computePrDiffContext(gitDir, {
        baseRef: 'main', headRef: 'HEAD', analysis, maxLinesPerFile: 12, maxTotalLines: 20,
      })
      if (!matCtx.hasMaterialChanges || !matCtx.mandatoryFiles.includes('prisma/schema.prisma')) {
        return `Schema 文件应作为 mandatory 必触发: ${JSON.stringify(matCtx)}`
      }
      if (matCtx.materialFiles.includes('src/unrelated.js')) {
        return '3-dot merge-base...HEAD 误包含了 main 分支独立提交的文件'
      }
      if (!matCtx.impactedOneHop.includes('src/caller.js')) {
        return `1-hop 邻域应包含引用方 src/caller.js，实际: ${JSON.stringify(matCtx.impactedOneHop)}`
      }
      if (matCtx.hunks.totalLines > 20 || !matCtx.hunks.truncated) {
        return `有界 hunk 截断未生效: ${JSON.stringify(matCtx.hunks)}`
      }
      return true
    } finally {
      rmTree(nonJsDir)
      rmTree(gitDir)
    }
  }])

  cases.push(['[StaticAnalyzer-C3] 常青 architecture-map.html 零脏态门禁：静态CSS不误报、脏JSON与脏DOM均以BLOCKED_ARCHITECTURE_MAP_DRIFT拦截', async () => {
    const dir = tmpProject({
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [{ id: 'core', name: '核心域' }],
        features: [{ id: 'alpha', name: 'Alpha', domain: 'core', entrypoints: ['src/alpha.js'], modules: ['src/alpha.js'], verificationTools: [], testRefs: [] }],
      }, null, 2),
      'src/alpha.js': 'export const alpha = 1\n',
    })
    try {
      // 1. 干净渲染：HTML 内 <style> 含 .pf-diff-modified 定义但 DOM 与 pf-visual-data 全为 context -> 必须放行
      const cleanRender = renderArchitectureMapFromRepo(dir)
      if (!cleanRender.ok) return `干净渲染失败: ${JSON.stringify(cleanRender)}`
      const cleanVerify = verifyArchitectureMapSync(dir)
      if (!cleanVerify.ok) return `干净常青图被误拦: ${JSON.stringify(cleanVerify)}`

      // 2. 显式传 changedFiles 渲染：renderArchitectureMapFromRepo 仍保留契约，但 verifyArchitectureMapSync 必拦脏图
      const dirtyRender = renderArchitectureMapFromRepo(dir, { changedFiles: ['src/alpha.js'] })
      if (!dirtyRender.ok) return `renderArchitectureMapFromRepo 应保留 changedFiles 契约: ${JSON.stringify(dirtyRender)}`
      const dirtyVerify = verifyArchitectureMapSync(dir)
      if (dirtyVerify.ok || dirtyVerify.code !== 'BLOCKED_ARCHITECTURE_MAP_DRIFT' || dirtyVerify.exitCode !== EXIT.FACT || dirtyVerify.reason !== 'dirty-diff-overlay') {
        return `脏 diff 常青图未被精准拦截: ${JSON.stringify(dirtyVerify)}`
      }

      // 3. 恢复干净后，仅向 DOM 注入 data-diff-state="impacted"（pf-visual-data 仍干净）-> 剥离 style/script 后仍必拦
      renderArchitectureMapFromRepo(dir)
      const htmlPath = join(dir, 'docs/architecture-map.html')
      const cleanHtml = readFileSync(htmlPath, 'utf8')
      const tamperedDom = cleanHtml.replace('<div class="pf-node pf-diff-context"', '<div class="pf-node pf-diff-context" data-diff-state="impacted"')
      writeFileSync(htmlPath, tamperedDom, 'utf8')
      const domVerify = verifyArchitectureMapSync(dir)
      if (domVerify.ok || domVerify.code !== 'BLOCKED_ARCHITECTURE_MAP_DRIFT' || domVerify.reason !== 'dirty-diff-overlay') {
        return `DOM data-diff-state 脏态未被拦截: ${JSON.stringify(domVerify)}`
      }

      // 4. 验证 mtime 变更在非 Git 仓同样触发缓存失效
      const nonGit = tmpProject({ 'src/a.js': 'export const v = 1\n' })
      try {
        const { analyzer } = await loadAnalyzerMods()
        const r1 = await analyzer.analyzeRepoStatic(nonGit)
        const r2 = await analyzer.analyzeRepoStatic(nonGit)
        if (r1.cacheStats.misses !== 1 || r2.cacheStats.hits !== 1) {
          return `非 Git 仓缓存命中异常: r1=${JSON.stringify(r1.cacheStats)}, r2=${JSON.stringify(r2.cacheStats)}`
        }
        const fPath = join(nonGit, 'src/a.js')
        writeFileSync(fPath, 'export const v = 2\n')
        const future = new Date(Date.now() + 5000)
        utimesSync(fPath, future, future)
        const r3 = await analyzer.analyzeRepoStatic(nonGit)
        if (r3.cacheStats.misses !== 1) return `非 Git 仓 mtime 变化未失效缓存: ${JSON.stringify(r3.cacheStats)}`
      } finally {
        rmTree(nonGit)
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
