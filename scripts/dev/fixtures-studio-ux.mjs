/**
 * fixtures-studio-ux.mjs —— Milestone B Wave 3 (`studio-ux-lazy-renderer`, C9..C12)
 * 正反双向行为断言：纯 SVG viewBox 相机、零模糊、无左侧彩条、点击反选隐藏抽屉、
 * 响应式多视口防护、点阵背景、单源懒渲染 < 180 KB、模块化 Change Blueprint、
 * 6 项 Studio 交互、?from= 安全校验、多步导览独立目标、CLI 三重对拍与 Critique 自动刷新。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'

import { detectDirtyDiffOverlay, renderArchitectureMapAsync, renderArchitectureMapFromRepo } from '../../kit/skills/lib/architecture-map.mjs'
import { extractMultiDiagramEvidence } from '../../kit/skills/lib/static-evidence.mjs'
import { analyzeRepoStatic } from '../../kit/skills/lib/static-analyzer.mjs'
import { buildVisualModel } from '../../kit/skills/lib/visual-layout.mjs'
import { renderVisualHtml } from '../../kit/skills/lib/visual-render.mjs'
import { projectVisualBriefViewModel, resolveBriefPaths, upsertVisualBrief } from '../../kit/skills/lib/visual-brief.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const DOC_PLAN = 'kit/skills/dev-plan/scripts/doc-plan.mjs'
const VERIFY_TOOLS = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'

function extractStyleCss(html) {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(html)
  return m ? m[1] : ''
}

function extractInlineScripts(html) {
  return [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type=["']application\/json["']/i.test(m[0]))
    .map((m) => m[1])
}

function parseVisualDataJson(html) {
  const m = /<script id="pf-visual-data" type="application\/json">([\s\S]*?)<\/script>/i.exec(html)
  return m ? JSON.parse(m[1]) : null
}

function makeRichMultiDiagramRepo() {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name: 'studio-ux-demo', version: '1.0.0' }, null, 2) + '\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
    'src/db/schema.sql': [
      'CREATE TABLE users (id INT PRIMARY KEY, email TEXT);',
      'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id), status TEXT);',
    ].join('\n') + '\n',
    'src/core/base.mjs': 'export class BaseService {}\nexport class AuthService extends BaseService {}\nexport class OrderService extends BaseService {}\nexport class AuditService extends BaseService {}\n',
    'src/core/state.mjs': [
      "export const TRANSITIONS = { draft: ['active'], active: ['review', 'done'], review: ['active', 'done'] }",
      "export function nextState(cur) { if (cur === 'draft') return 'active'; return 'done' }",
    ].join('\n') + '\n',
    'src/core/a.mjs': "import { bFn } from './b.mjs'\nexport function aFn() { return bFn() }\n",
    'src/core/b.mjs': "import { cFn } from './c.mjs'\nexport function bFn() { return cFn() }\n",
    'src/core/c.mjs': "import { aFn } from './a.mjs'\nexport function cFn() { return typeof aFn }\n",
    '.github/workflows/ci.yml': [
      'name: CI',
      'jobs:',
      '  lint:',
      '    steps: [{ run: echo lint }]',
      '  test:',
      '    needs: lint',
      '    steps: [{ run: echo test }]',
    ].join('\n') + '\n',
    'docs/feature-map.json': JSON.stringify({
      version: 2,
      repoName: 'studio-ux-demo',
      domains: [
        { id: 'core', name: '核心服务', description: '状态机与循环检测底座' },
        { id: 'commerce', name: '业务域', description: '订单与数据持久化' },
      ],
      features: [
        { id: 'auth', name: '认证模块', domain: 'core', entrypoints: ['src/core/base.mjs'], modules: ['src/core/base.mjs', 'src/core/a.mjs'], tests: ['test/auth.test.mjs'], dependsOn: [], docAnchors: ['docs/TDD.md#auth'] },
        { id: 'state-engine', name: '状态引擎', domain: 'core', entrypoints: ['src/core/state.mjs'], modules: ['src/core/state.mjs', 'src/core/b.mjs', 'src/core/c.mjs'], tests: ['test/state.test.mjs'], dependsOn: ['auth'], docAnchors: ['docs/TDD.md#state'] },
        { id: 'orders', name: '订单处理', domain: 'commerce', entrypoints: ['src/db/schema.sql'], modules: ['src/db/schema.sql'], tests: [], dependsOn: ['state-engine'], docAnchors: ['docs/TDD.md#orders'] },
      ],
      flows: [
        {
          id: 'order-flow',
          name: '下单主链路',
          actors: ['user', 'system'],
          features: ['auth', 'state-engine', 'orders'],
          steps: [
            { feature: 'auth', actor: 'user', action: '登录鉴权' },
            { feature: 'state-engine', actor: 'system', action: '推进状态' },
            { feature: 'orders', actor: 'system', action: '落库订单' },
          ],
        },
      ],
    }, null, 2) + '\n',
  })
  gitInit(dir)
  gitCommitFast(dir, 'feat: initial studio demo')
  return dir
}

export function registerStudioUxCases(cases) {
  cases.push(['[StudioUX-C9] 纯矢量 SVG viewBox 相机、零 will-change:transform、零左侧彩条、默认隐藏语义护照、点阵背景与响应式防护', async () => {
    const dir = makeRichMultiDiagramRepo()
    try {
      const analysis = await analyzeRepoStatic(dir, { useCache: false })
      const evidence = await extractMultiDiagramEvidence(dir, { analysis })
      const fm = JSON.parse(readFileSync(join(dir, 'docs/feature-map.json'), 'utf8'))
      const model = buildVisualModel({ featureMap: fm, mode: 'architecture-map', analysis, evidence })
      const archRes = renderVisualHtml({ visualModel: model, featureMapSha256: 'e'.repeat(64), mode: 'architecture-map' })
      const html = archRes.html
      const css = extractStyleCss(html)
      const js = extractInlineScripts(html).join('\n')

      // 1. 纯矢量 SVG viewBox 相机，彻底禁用 will-change: transform 与 CSS scale() DOM 舞台
      if (!html.includes('id="svg-architecture"') || !html.includes('viewBox=')) {
        return 'architecture-map 未渲染首屏纯矢量 <svg id="svg-architecture" viewBox=...>'
      }
      if (/will-change\s*:\s*transform/i.test(html)) {
        return '源码违规包含 will-change: transform，将导致缩放拖拽文字模糊'
      }
      if (html.includes('class="pf-stage"') || html.includes('id="stage-tree"')) {
        return '仍残留旧版 CSS scale() HTML .pf-stage 舞台'
      }
      if (!js.includes('Math.round(') || !/dpr|devicePixelRatio/.test(js)) {
        return '客户端浮层定位缺少 Math.round(v * dpr) / dpr 物理像素对齐'
      }

      // 2. 严格禁止左侧彩条（无 border-left 粗色条、无 svg-node-bar-*）
      if (/border-left\s*:\s*[2-9](?:\.\d+)?px\s+solid/i.test(css)) {
        return 'CSS 违规包含左侧彩色装饰条（border-left >= 2px solid）'
      }
      if (html.includes('svg-node-bar-') || html.includes('pf-left-stripe')) {
        return 'SVG 节点违规包含左侧彩色装饰竖条 svg-node-bar-*'
      }

      // 3. 默认无选中节点时右侧 Semantic Passport 必须折叠隐藏，且支持点击已选节点反选收起
      const inspectorTag = /<aside[^>]*id="pf-inspector"[^>]*>/i.exec(html)
      if (!inspectorTag || (!inspectorTag[0].includes('hidden') && !inspectorTag[0].includes('is-collapsed'))) {
        return `右侧语义护照 #pf-inspector 默认必须隐藏：${inspectorTag ? inspectorTag[0] : '未找到元素'}`
      }
      if (!js.includes('selectNode') || !js.includes('clearSelection') || !js.includes('Escape')) {
        return '客户端脚本缺少统一选中模型、点击反选与 Escape 隐藏语义护照逻辑'
      }

      // 4. 单层 CSS 点阵画布背景（禁止 SVG 叠影双点阵）+ 参数化浅/深色 3 层表面对比度 + 三级按钮权重 + 响应式多视口规则
      if (!css.includes('radial-gradient')) {
        return '缺少点阵空间画布背景（radial-gradient）'
      }
      if (html.includes('svg-bg-grid') || html.includes('pf-dot-grid')) {
        return 'SVG 违规残留双层点阵 svg-bg-grid/pf-dot-grid，缩放平移会产生摩尔纹叠影'
      }
      if (html.includes('data-act="walk-next"')) {
        return '底栏违规残留与顶栏重复的无文字导览按钮 walk-next'
      }
      for (const tok of ['--pf-bg:', '--pf-surface:', '--pf-ink:', '--pf-accent:', '--pf-btn-primary-bg:', '[data-theme="dark"]', '--pf-svg-zone-fill:', '--pf-svg-zone-head:', '--pf-svg-node-fill:']) {
        if (!css.includes(tok)) return `缺少参数化主题 Token：${tok}`
      }
      const extractVar = (block, name) => {
        const m = new RegExp(`${name}:([^;}\\s]+)`).exec(block)
        return m ? m[1].toLowerCase() : ''
      }
      const rootBlock = /:root\{([^}]+)\}/.exec(css)?.[1] || ''
      const darkBlock = /:root\[data-theme="dark"\]\{([^}]+)\}/.exec(css)?.[1] || ''
      if (!rootBlock || !darkBlock) return '缺少 :root 浅色或 [data-theme="dark"] 深色变量块'
      if (extractVar(rootBlock, '--pf-svg-node-fill') === extractVar(rootBlock, '--pf-svg-zone-fill')) {
        return '浅色模式卡片与域容器底色未分离（cardFill === domainFill）'
      }
      if (extractVar(darkBlock, '--pf-svg-node-fill') === extractVar(darkBlock, '--pf-svg-zone-fill')) {
        return '深色模式卡片与域容器底色未分离（cardFill === domainFill）'
      }
      for (const cls of ['.pf-btn-primary', '.pf-btn-emph', '.pf-btn-sec', '.pf-btn-icon', '.walk-bar-inner', '.walk-badge']) {
        if (!css.includes(cls)) return `缺少三级按钮层级或导览定锚样式：${cls}`
      }
      if (!css.includes('@media') || (!css.includes('overflow-x:clip') && !css.includes('overflow-x: clip'))) {
        return '缺少响应式媒体查询或 overflow-x: clip 横向溢出防护'
      }

      // 5. 统一 10 图选中/拓扑拖拽/按图能力底栏/统一 6 段右侧抽屉与一键复制提示词/路径
      for (const marker of ['DRAG_TABS', 'dragOffsetsByTab', 'edgesByTabNode', 'requestAnimationFrame', 'reset-layout', 'zoom-node', 'dblclick', 'syncDockCapabilities', 'getInspectorSpec', 'buildDiagramContext', 'copy-intent', 'copy-path']) {
        if (!js.includes(marker)) return `客户端脚本缺少统一交互能力锚点：${marker}`
      }
      for (const uiText of ['追踪波及', '路径探测', '连线：标准', '放大选中', '重置布局', '适配全图', 'walk-step-badge']) {
        if (!html.includes(uiText)) return `画布工具栏或导览条缺少可读交互控件：${uiText}`
      }
      for (const inspText of ['居中放大', '一键复制提示词', '编辑后提问', '上游依赖', '下游波及']) {
        if (!js.includes(inspText)) return `统一右侧详情抽屉缺少核心控件：${inspText}`
      }
      if (/<textarea[^>]*id="prompt-dialog-text"[^>]*readonly/i.test(html)) {
        return '#prompt-dialog-text 违规带有 readonly 属性，导致「编辑后提问」无法输入编辑'
      }

      // 6. 所有内联脚本必须通过 vm.Script 合法性解析
      for (const code of extractInlineScripts(html)) {
        try { new Script(code) } catch (err) { return `内联 <script> 语法错误：${err.message}` }
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StudioUX-C10] 单源索引压缩 JSON、非首屏 Tab 客户端懒渲染、< 180 KB 预算、零空 Tab 与模块化 Change Blueprint', async () => {
    const dir = makeRichMultiDiagramRepo()
    try {
      const analysis = await analyzeRepoStatic(dir, { useCache: false })
      const evidence = await extractMultiDiagramEvidence(dir, { analysis })
      const fm = JSON.parse(readFileSync(join(dir, 'docs/feature-map.json'), 'utf8'))

      const archModel = buildVisualModel({ featureMap: fm, mode: 'architecture-map', analysis, evidence })
      const archRes = renderVisualHtml({ visualModel: archModel, featureMapSha256: 'f'.repeat(64), mode: 'architecture-map' })
      if (archRes.bytes >= 180 * 1024) {
        return `多图 architecture-map HTML 超出 180 KB 预算：${archRes.bytes} bytes`
      }

      const payload = parseVisualDataJson(archRes.html)
      if (!payload || payload.schemaVersion !== 3) {
        return `pf-visual-data 应为单源 schemaVersion=3，实得：${payload?.schemaVersion}`
      }
      if (!Array.isArray(payload.tree?.nodes) || payload.tree.nodes.length !== 3 || !payload.tree.nodes.every((n) => n.diffState === 'context')) {
        return `pf-visual-data 必须保留向后兼容的 tree.nodes[].diffState（常青图全为 context）：${JSON.stringify(payload.tree?.nodes?.map((n) => [n.id, n.diffState]))}`
      }

      // 懒渲染校验：architecture-map 首屏仅服务端渲染 svg-architecture，非首屏 Tab（workflow/tree/erd/class 等）严禁服务端预渲 <svg id="svg-...">
      if (!archRes.html.includes('id="svg-architecture"')) return '首屏 architecture 未服务端预渲染'
      for (const lazyId of ['workflow', 'tree', 'erd', 'class', 'sequence', 'lifecycle', 'dataflow', 'timeline']) {
        if (archRes.html.includes(`id="svg-${lazyId}"`)) {
          return `非首屏 Tab "${lazyId}" 不应服务端重复预渲染 <svg id="svg-${lazyId}">，必须走客户端懒渲染`
        }
      }
      // 零空 Tab 校验：未提供 telemetrySpans 时 waterfall 严禁出现按钮或数据
      if (archRes.html.includes('data-diagram-tab="waterfall"') || payload.diagrams?.waterfall) {
        return '无 telemetrySpans 证据时 waterfall 不得出现空 Tab'
      }

      // 模块化 Change Blueprint（非文字墙）：顶部决策条、分域变更卡、改前->改后对比、独立下游波及链、双向悬浮属性
      const briefModel = buildVisualModel({
        featureMap: fm,
        mode: 'visual-brief',
        analysis,
        evidence,
        diffOverlay: {
          featureChanges: { auth: { state: 'modified', before: '同步单线程校验', after: '无状态令牌 + 缓存验证' } },
          addedNodes: [{ id: 'rate-limit', domain: 'core', title: '限流器', summary: '令牌桶防刷', dependsOn: ['auth'] }],
        },
        briefSpec: {
          briefData: {
            kind: 'master-prd',
            verdict: '重构认证与订单状态引擎',
            goals: ['消除拖拽模糊', '升级模块化蓝图'],
            nonGoals: ['不引入前端框架'],
            mergedDecisions: ['采用纯矢量 SVG viewBox 相机'],
            mergedOpen: [],
            pendingDecisions: [],
            childSlices: [{ key: 'slice-auth', rel: 'docs/specs/slice-auth.md', status: 'approved', done: false }],
            childBriefLinks: [{ key: 'slice-auth', title: 'slice-auth', href: './slice-auth.html?from=master-demo' }],
            prDiff: {
              range: 'abc123...HEAD',
              materialFiles: ['src/core/base.mjs'],
              hunks: { files: [{ file: 'src/core/base.mjs', addedCount: 2, removedCount: 1, lines: ['@@ -1 +1,2 @@', '-old', '+new'] }] },
            },
          },
        },
      })
      const briefRes = renderVisualHtml({ visualModel: briefModel, featureMapSha256: 'f'.repeat(64), mode: 'visual-brief' })
      if (briefRes.bytes >= 180 * 1024) return `visual-brief HTML 超出 180 KB 预算：${briefRes.bytes} bytes`
      for (const marker of ['pf-hero-strip', 'pf-slice-grid', 'pf-before', 'pf-after', 'pf-chain-panel', 'data-hover-node="auth"', 'pf-hunk-fold', './slice-auth.html?from=master-demo']) {
        if (!briefRes.html.includes(marker)) return `模块化 Change Blueprint 缺少关键结构：${marker}`
      }
      // brief 模式首屏为 brief，不预渲 svg-architecture（点击切画布时客户端懒渲染）
      if (briefRes.html.includes('id="svg-architecture"')) {
        return 'visual-brief 首屏为变更蓝图，不应服务端预渲染 svg-architecture 造成双份体积'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StudioUX-C11] 6 项 Studio 交互、?from= 安全校验、导览独立真实目标、CLI 新选项与 Critique 自动刷新 Brief', async () => {
    const dir = makeRichMultiDiagramRepo()
    try {
      // 1. 验证 visual-brief.mjs 导览修复：每步必须解析独立真实 targetId（不再全绑 modifiedFeatureIds[0]）
      const sc = upsertVisualBrief(dir, {
        briefKey: 'walk-test',
        kind: 'task',
        parentBriefKey: 'master-demo',
        title: '多步导览独立目标验证',
        verdict: '验证 auth、state-engine 与 orders 各自绑定独立节点',
        affectedFeatures: ['auth', 'state-engine', 'orders'],
        goals: ['升级 auth 令牌签名', '重构 state-engine 状态机', '扩展 orders 持久化'],
        decisions: ['state-engine 保持向后兼容'],
        flowDeltas: ['orders 接入异步审计'],
      })
      const proj = projectVisualBriefViewModel({ mainRoot: dir, workRoot: dir, sidecar: sc.sidecar })
      const walkTargets = (proj.visualModel.walkthrough || []).map((w) => w.targetId).filter(Boolean)
      const uniqueTargets = new Set(walkTargets)
      if (uniqueTargets.size < 2) {
        return `导览步骤仍退化为全部绑定同一节点：${JSON.stringify(proj.visualModel.walkthrough)}`
      }
      if (!proj.visualModel.walkthrough.some((w) => w.targetId === 'state-engine') || !proj.visualModel.walkthrough.some((w) => w.targetId === 'orders')) {
        return `导览步骤未按上下文解析真实目标节点 state-engine/orders：${JSON.stringify(walkTargets)}`
      }

      const briefHtml = readFileSync(resolveBriefPaths(dir, 'walk-test').htmlPath, 'utf8')
      const js = extractInlineScripts(briefHtml).join('\n')

      // 2. 6 项交互核心机制静态验证
      for (const token of [
        'popstate', 'altKey', 'pf-parent-bar', 'fanIn', 'fanOut', 'inCycle',
        'computeReach', 'findShortestRoute', 'intent-chip', 'exportSvg', 'exportPng',
        '解释边界', '查波及面', '补测试', '拆分方案',
      ]) {
        if (!briefHtml.includes(token)) return `Studio HTML/JS 缺少核心交互能力标识：${token}`
      }
      // 3. ?from= 严格安全白名单校验（与 sanitizeBriefKey 对齐，拒收 javascript: 与 ../）
      if (!js.includes('[a-z0-9\\u4e00-\\u9fa5._-]{1,80}') && !js.includes('[a-z0-9\\u4e00-\\u9fa5._-]+')) {
        return '客户端 ?from= 参数缺少与 sanitizeBriefKey 对齐的安全白名单正则'
      }
      if (!briefHtml.includes('./master-demo.html')) {
        return 'parentBriefKey 未生成纯相对路径父简报链接 ./master-demo.html'
      }

      // 4. verify-tools render --telemetry-spans 真实激活 Tier 3 waterfall
      const spansPath = join(dir, '.tmp-spans.json')
      writeFileSync(spansPath, JSON.stringify([
        { id: 'sp-1', label: 'analyze', startMs: 0, durationMs: 42 },
        { id: 'sp-2', label: 'layout', startMs: 42, durationMs: 18 },
      ]), 'utf8')
      const vtRes = await runAbsAsync(VERIFY_TOOLS, ['render', dir, '--telemetry-spans', spansPath, '--json'], { cwd: dir })
      if (vtRes.status !== 0) return `verify-tools render --telemetry-spans 失败：${vtRes.stderr || vtRes.stdout}`
      const renderedArch = readFileSync(join(dir, 'docs/architecture-map.html'), 'utf8')
      const archData = parseVisualDataJson(renderedArch)
      if (!archData?.diagrams?.waterfall || !renderedArch.includes('data-diagram-tab="waterfall"')) {
        return '传入 --telemetry-spans 后未激活 Tier 3 waterfall 标签页'
      }

      // 5. doc-plan brief --parent-brief & --pr-diff-base + sandbox 推荐入口 UX 连续性
      const triSb = await runAbsAsync(DOC_PLAN, ['triage', '--summary', '调整按钮样式', '--topic', 'sb-ui-polish', '--files', '2', '--json'], { cwd: dir })
      if (triSb.status !== 0) return `sandbox triage 失败：${triSb.stderr}`
      const sbBrief = await runAbsAsync(DOC_PLAN, [
        'brief', '--topic', 'sb-ui-polish', '--title', 'UI 微调', '--parent-brief', 'master-demo',
        '--pr-diff-base', 'HEAD', '--confirm', '--json',
      ], { cwd: dir })
      if (sbBrief.status !== 0) return `doc-plan brief --parent-brief/--pr-diff-base 失败：${sbBrief.stderr || sbBrief.stdout}`
      const sbJson = JSON.parse(sbBrief.stdout)
      if (sbJson.visualBrief?.parentBriefKey !== 'master-demo') {
        return `--parent-brief 未持久化至 sidecar：${JSON.stringify(sbJson.visualBrief)}`
      }
      const nextTexts = (sbJson.nextSteps || []).map((s) => (typeof s === 'string' ? s : s.text)).join(' ')
      if (!nextTexts.includes('--sandbox')) {
        return `sandbox 主题 brief --confirm 后的 [NEXT STEP] 应建议 flow.mjs start --sandbox，实得：${nextTexts}`
      }

      // 6. doc-plan critique-pass & critique-reject 自动刷新 Living Visual Brief 并输出 htmlUri
      upsertVisualBrief(dir, { briefKey: 'crit-demo', taskId: 'crit-demo', title: 'Crit Demo', verdict: 'Draft' })
      const specRel = 'docs/specs/261127-crit-demo-spec.md'
      mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
      writeFileSync(join(dir, specRel), [
        '---',
        'kind: spec',
        'title: Crit Demo Spec',
        'status: draft',
        'tier: L3',
        'created: 2026-11-27',
        'updated: 2026-11-27',
        'owner: planner-crit',
        'plan_mode: autonomous',
        'approved: false',
        'implemented: false',
        'task_id: crit-demo',
        'scope_files: [src/core/base.mjs]',
        '---',
        '',
        '# Crit Demo Spec',
        '',
        '## 一、背景与边界声明',
        '- **要改什么**：更新 `src/core/base.mjs` 导出方法。',
        '- **不改什么**：不修改 `src/core/state.mjs` 契约。',
        '- **本期不做**：不新增第三方依赖。',
        '- **复用既有模块**：复用 `src/core/base.mjs`。',
        '',
        '## 二、设计方案与契约变更',
        '- 在 `src/core/base.mjs` 保持 `BaseService` 导出向后兼容，不修改 `src/core/state.mjs`。',
        '',
        '## 三、备选方案与否决理由',
        '| 方案 | 怎么做的 | 为什么没选 | 什么情况下该改回它 |',
        '| --- | --- | --- | --- |',
        '| 直接重写 | 删除原类 | 破坏兼容 | 下个大版本 |',
        '',
        '## 四、改动清单与影响面',
        '| 文件 / 目录 | 改动性质 | 改什么 | 谁会被影响 |',
        '| --- | --- | --- | --- |',
        '| `src/core/base.mjs` | 修改 | 扩展基类能力 | `src/core/a.mjs` |',
        '',
        '## 五、冻结的验收标准',
        '<!-- criteria:start -->',
        '- [ ] C1: `src/core/base.mjs` 导出 `BaseService` 且语法校验通过。',
        '<!-- criteria:end -->',
        '',
        '## 六、高风险点、门型与回滚路径',
        '- **门型与回滚路径**：`two-way`，直接回退提交即可恢复。',
        '- **高风险路径**：无。',
        '',
      ].join('\n'), 'utf8')
      const crRes = await runAbsAsync(DOC_PLAN, [
        'critique-reject', '--file', specRel, '--reviewer', 'critic-indep-0', '--round', '1',
        '--summary', 'Minor wording check', '--findings', 'Clarify rollback note', '--json',
      ], { cwd: dir })
      if (crRes.status !== 3 && crRes.status !== 0) return `critique-reject 失败：${crRes.stderr || crRes.stdout}`
      const crJson = JSON.parse(crRes.stdout)
      if (!crJson.visualBrief?.htmlUri) {
        return `critique-reject 未自动刷新 Living Visual Brief：${crRes.stdout}`
      }
      writeFileSync(join(dir, specRel), readFileSync(join(dir, specRel), 'utf8').replace('直接回退提交即可恢复', '单提交反向回退即可无损恢复'), 'utf8')
      const cpRes = await runAbsAsync(DOC_PLAN, [
        'critique-pass', '--file', specRel, '--reviewer', 'critic-indep-1', '--round', '2',
        '--resolved', 'F1', '--summary', 'Verified cleanly against repo', '--json',
      ], { cwd: dir })
      if (cpRes.status !== 0) return `critique-pass 失败：${cpRes.stderr}\n${cpRes.stdout}`
      const cpJson = JSON.parse(cpRes.stdout)
      if (!cpJson.visualBrief?.htmlUri) {
        return `critique-pass 未自动刷新 Living Visual Brief 并返回 visualBrief.htmlUri：${cpRes.stdout}`
      }

      // 7. 异步常青渲染 helper 零脏标验证
      const asyncArch = await renderArchitectureMapAsync(dir, { write: false })
      if (!asyncArch.ok || asyncArch.bytes >= 180 * 1024) {
        return `renderArchitectureMapAsync 异常：ok=${asyncArch.ok} bytes=${asyncArch.bytes}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[StudioUX-BriefParity] Brief 多图证据对齐、右侧抽屉变更说明与双向回跳、干净 architecture-map 反例', async () => {
    const dir = makeRichMultiDiagramRepo()
    try {
      // 1. 正向：Brief 未显式传 analysis/evidence 时自动对齐多图静态证据，并具备双向跳转与抽屉变更说明
      const res = upsertVisualBrief(dir, {
        briefKey: 'parity-check',
        kind: 'task',
        taskId: 'parity-check',
        title: '多图对齐与抽屉回跳实证',
        affectedFeatures: ['auth'],
        featureChanges: {
          auth: { state: 'modified', before: '旧鉴权基线', after: '无状态双轨令牌' },
        },
      })
      const briefHtml = readFileSync(res.htmlPath, 'utf8')
      if (res.bytes >= 180 * 1024) return `自动注入多图证据后的 Brief HTML 超出 180 KB：${res.bytes} bytes`

      const briefData = parseVisualDataJson(briefHtml)
      if (!briefData || !Array.isArray(briefData.activeTabs) || briefData.activeTabs.length < 4) {
        return `Brief 未自动对齐多图证据 Tab（期望 >=4）：${JSON.stringify(briefData?.activeTabs)}`
      }
      const tabIds = briefData.activeTabs.map((t) => t.id)
      for (const expectedTab of ['architecture', 'workflow', 'tree', 'erd']) {
        if (!tabIds.includes(expectedTab)) return `Brief 缺少对齐证据 Tab "${expectedTab}"：${JSON.stringify(tabIds)}`
      }
      const authNode = briefData.tree?.nodes?.find((n) => n.id === 'auth')
      const stateNode = briefData.tree?.nodes?.find((n) => n.id === 'state-engine')
      if (!authNode?.changeDetail?.before || !authNode?.changeDetail?.after) {
        return `pf-visual-data 缺少修改节点 changeDetail：${JSON.stringify(authNode)}`
      }
      if (stateNode?.diffState !== 'impacted' || !(stateNode?.impactReasons?.length > 0)) {
        return `pf-visual-data 缺少受波及节点 impactReasons：${JSON.stringify(stateNode)}`
      }
      if (!briefHtml.includes('data-slice-id="auth"') || !briefHtml.includes('data-slice-id="state-engine"')) {
        return '变更蓝图切片卡片缺少 data-slice-id 双向跳转锚点'
      }
      const briefJs = extractInlineScripts(briefHtml).join('\n')
      for (const token of ['本次变更与波及说明', 'data-jump-blueprint', '查看变更蓝图', 'is-flash-focus', 'data-slice-id']) {
        if (!briefJs.includes(token)) return `Brief 客户端脚本缺少抽屉变更说明或双向回跳逻辑：${token}`
      }
      for (const code of extractInlineScripts(briefHtml)) {
        try { new Script(code) } catch (err) { return `Brief 内联 <script> 语法错误：${err.message}` }
      }

      // 2. 反例：常青 architecture-map 必须保持 0 脏标、无虚假变更说明且无 Brief 专属回跳按钮
      const cleanArch = await renderArchitectureMapAsync(dir, { write: false })
      if (!cleanArch.ok || !cleanArch.html) return '常青 architecture-map 渲染失败'
      const dirty = detectDirtyDiffOverlay(cleanArch.html)
      if (dirty.dirty) return `常青 architecture-map 存在脏 diff 覆盖：${dirty.detail}`
      const cleanData = parseVisualDataJson(cleanArch.html)
      if (cleanData.tree.nodes.some((n) => n.diffState !== 'context' || n.changeDetail || (n.impactReasons && n.impactReasons.length > 0))) {
        return '常青 architecture-map 节点不应出现非 context 或 changeDetail/impactReasons'
      }
      const cleanJs = extractInlineScripts(cleanArch.html).join('\n')
      if (cleanJs.includes('data-jump-blueprint') || cleanJs.includes('查看变更蓝图')) {
        return '常青 architecture-map 不应泄露 Brief 专属「查看变更蓝图」回跳按钮'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
