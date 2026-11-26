/**
 * fixtures-visual-engine.mjs —— Slice 2 (`visual-engine-arch-map`) C5–C8 正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Script } from 'node:vm'

import {
  ARCHITECTURE_MAP_REL,
  renderArchitectureMapFromRepo,
  verifyArchitectureMapSync,
} from '../../kit/skills/lib/architecture-map.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { buildVisualModel, DIFF_STATES } from '../../kit/skills/lib/visual-layout.mjs'
import { renderVisualHtml } from '../../kit/skills/lib/visual-render.mjs'
import { isUiVisualFile, UI_VISUAL_EXT_RE } from '../../kit/skills/lib/static-gates.mjs'
import { determineWorkflowPolicy } from '../../kit/skills/lib/workflow-policy.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { checkArchitectureMapSyncOnVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { runReconcileVerifyToolsAudit } from '../../kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs'
import { assessBehavioralGate } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { survey } from '../survey.mjs'
import { reviewProject } from '../review.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

function findUndefinedCssVars(html) {
  const styleMatch = /<style>([\s\S]*?)<\/style>/i.exec(html)
  const css = styleMatch ? styleMatch[1] : ''
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const missing = new Set()
  for (const m of markup.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!defined.has(m[1])) missing.add(m[1])
  }
  return [...missing]
}

function parseFlatCssRules(css) {
  const rules = []
  let i = 0
  const n = css.length
  while (i < n) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const sel = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < n && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    const body = css.slice(open + 1, j - 1)
    if (sel.startsWith('@')) rules.push(...parseFlatCssRules(body))
    else if (sel) rules.push({ sel, body })
    i = j
  }
  return rules
}

function hasSegBtnHoverOverridingActive(html) {
  const styleMatch = /<style>([\s\S]*?)<\/style>/i.exec(html)
  const rules = parseFlatCssRules(styleMatch ? styleMatch[1] : '')
  let lastActiveIdx = -1
  const unguardedHoverIdxs = []
  rules.forEach((r, idx) => {
    const parts = r.sel.split(',').map((s) => s.trim())
    if (!/(?:^|;)\s*(?:background(?:-color)?|color)\s*:/i.test(r.body)) return
    if (parts.some((p) => /(?:^|[\s>+~])\.pf-seg-btn\.is-active(?::hover)?$/.test(p))) lastActiveIdx = idx
    if (parts.some((p) => /\.pf-seg-btn:hover(?![\w-])/.test(p) && !/:not\(\.is-active\)/.test(p) && !/\.pf-seg-btn:hover[^\s]*\s/.test(p))) {
      unguardedHoverIdxs.push(idx)
    }
  })
  return lastActiveIdx < 0 || unguardedHoverIdxs.some((idx) => idx > lastActiveIdx)
}

export function registerVisualEngineCases(cases) {
  cases.push(['Visual Engine C5：布局/单文件 HTML 渲染、25-60KB 预算、幂等重写、XSS/URL 防护与 file:// 离线韧性（正反双向）', async () => {
    const xssPayload = '<script>alert("xss")</script>'
    const v1Map = {
      version: 1,
      repoName: `Demo ${xssPayload}`,
      features: [
        {
          id: 'auth',
          title: `Auth ${xssPayload}`,
          description: 'Authentication and token handling',
          entrypoints: ['C:\\Users\\alice\\repo\\src\\auth.mjs'],
          modules: ['src/auth.mjs'],
          tests: ['test/auth.test.mjs'],
          dependsOn: [],
        },
        {
          id: 'billing',
          title: 'Billing',
          description: 'Invoice generation',
          modules: ['src/billing.mjs'],
          tests: ['test/billing.test.mjs'],
          dependsOn: ['auth'],
        },
        {
          id: 'reports',
          title: 'Reports',
          description: 'Export CSV reports',
          modules: ['src/reports.mjs'],
          tests: ['test/reports.test.mjs'],
          dependsOn: ['billing'],
        },
        {
          id: 'cli',
          title: 'CLI Entry',
          modules: ['src/cli.mjs'],
          tests: ['test/cli.test.mjs'],
          dependsOn: ['auth'],
        },
      ],
    }

    const model = buildVisualModel({
      featureMap: v1Map,
      diffOverlay: { modified: ['auth'] },
      briefSpec: {
        prototypes: [
          { title: 'Safe Frame', kind: 'iframe', srcdoc: '<div>Safe Preview</div>' },
          { title: 'Oversized Frame', kind: 'iframe', srcdoc: 'x'.repeat(520 * 1024) },
          { title: 'Unsafe JS Link', kind: 'url', url: 'javascript:alert(1)' },
          { title: 'Safe HTTPS Link', kind: 'url', url: 'https://example.com/spec' },
        ],
      },
    })
    if (model.tree.domains.length === 0) return 'v1 feature-map 应通过 buildFallbackDomains 自动合成 domain 分组'
    if (model.overlayCounts.modified !== 1 || model.overlayCounts.impacted < 2) {
      return `diffOverlay 下游 impacted 扩散异常：${JSON.stringify(model.overlayCounts)}`
    }

    const sha = 'a'.repeat(64)
    const r1 = renderVisualHtml({ visualModel: model, featureMapSha256: sha })
    const r2 = renderVisualHtml({ visualModel: model, featureMapSha256: sha })
    if (r1.html !== r2.html) return '同一输入重复渲染未产出字节级一致 HTML'
    if (r1.bytes < 25 * 1024 || r1.bytes > 60 * 1024) {
      return `典型 4 功能仓库 HTML 体积超出 25-60KB 目标区间：${r1.bytes} bytes`
    }
    const line1 = r1.html.split('\n')[0]
    if (!line1.startsWith('<!-- @generated by project-forge architecture-map; DO NOT EDIT') || !line1.includes(`feature-map-sha256=${sha}`)) {
      return `Line-1 声明头格式异常：${line1}`
    }
    const briefRender = renderVisualHtml({ visualModel: model, featureMapSha256: sha, mode: 'visual-brief' })
    if (!briefRender.html.split('\n')[0].includes('project-forge visual-brief; DO NOT EDIT')) {
      return `visual-brief 模式头未切换：${briefRender.html.split('\n')[0]}`
    }
    for (const [label, doc] of [['arch', r1.html], ['brief', briefRender.html]]) {
      const undefVars = findUndefinedCssVars(doc)
      if (undefVars.length > 0) return `${label} 渲染产物引用未定义 CSS 变量：${undefVars.join(', ')}`
      if (hasSegBtnHoverOverridingActive(doc)) return `${label} 渲染产物中 .pf-seg-btn:hover 覆写了更早的 .pf-seg-btn.is-active`
    }
    // 反向自证：注入失效 CSS 变量或无防护的延后 :hover 规则必须被断言拦截
    if (!findUndefinedCssVars(`${briefRender.html}<span style="--dc:var(--added)"></span>`).includes('--added')) {
      return 'CSS 变量完整性探针未拦截未定义 token --added'
    }
    if (!hasSegBtnHoverOverridingActive('<style>.pf-seg-btn.is-active{background:var(--accent-solid)}.pf-seg-btn:hover{background:var(--sf)}</style>')) {
      return '.pf-seg-btn:hover 覆写探针未拦截同权重后置覆写'
    }
    if (/<script[^>]+src=/i.test(r1.html) || /<link[^>]+href=["']https?:/i.test(r1.html)) {
      return '自包含 HTML 不得引用外部 script/CSS CDN'
    }
    if (r1.html.includes(xssPayload)) return 'HTML 渲染未对 XSS payload 进行转义'
    if (r1.html.includes('C:\\Users\\alice')) return 'Anchor 路径未剥离机器绝对路径前缀'
    if (!r1.html.includes('execCommand') || !r1.html.includes('clipboard-fallback') || !r1.html.includes('walk-bar')) {
      return '渲染产物缺少三级剪贴板降级或 walk-bar 键盘交互'
    }
    if (!r1.html.includes('ArrowRight') || !r1.html.includes('localStorage')) {
      return '渲染产物缺少 ArrowRight 步进或 localStorage 主题切换'
    }
    if (r1.html.includes('href="javascript:alert(1)"')) return 'Prototype URL 未阻断 javascript: 协议'
    if (!r1.html.includes('原型内容超出 512 KB 上限，已阻止内联渲染') || !r1.html.includes('sandbox="allow-scripts"')) {
      return 'Prototype slot 未正确执行 srcdoc 512KB 上限或 sandbox 隔离'
    }
    if (!r1.html.includes('https://example.com/spec')) return '合法 https 原型链接被误杀'
    return true
  }])

  cases.push(['Visual Engine C6：isUiVisualFile 单源豁免校验（有效图豁免 vs 篡改图与业务 HTML 拦截）', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"vis-c6","version":"1.0.0"}\n',
      'src/index.mjs': 'export const ok = true\n',
      'src/widget.html': '<div>Hello</div>\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{ id: 'core', title: 'Core', modules: ['src/index.mjs'], entrypoints: ['src/index.mjs'], tests: [] }],
      }, null, 2),
    })
    gitInit(dir)
    try {
      const gen = renderArchitectureMapFromRepo(dir)
      if (!gen.ok || !gen.written) return `首次渲染失败：${JSON.stringify(gen)}`
      const again = renderArchitectureMapFromRepo(dir)
      if (!again.ok || again.written || again.changed) return `幂等重渲不应触发磁盘重写：${JSON.stringify(again)}`
      const homeMarker = homedir().replace(/\\/g, '/')
      if (homeMarker.length >= 4 && readFileSync(join(dir, ARCHITECTURE_MAP_REL), 'utf8').includes(homeMarker)) {
        return '生成的 docs/architecture-map.html 泄露了宿主机 homedir'
      }

      // 正向：合法生成的 docs/architecture-map.html 在传入 repoRoot 时必须豁免 UI 实证门禁
      if (isUiVisualFile(ARCHITECTURE_MAP_REL, { repoRoot: dir }) !== false) {
        return '合法同步的 docs/architecture-map.html 应被 isUiVisualFile 豁免'
      }
      const polExempt = determineWorkflowPolicy({ changedFiles: [ARCHITECTURE_MAP_REL], repoRoot: dir })
      if (polExempt.visualFilesChanged.length !== 0) {
        return `determineWorkflowPolicy 未豁免有效架构图：${JSON.stringify(polExempt.visualFilesChanged)}`
      }
      const behExempt = assessBehavioralGate({
        diff: { files: [{ file: ARCHITECTURE_MAP_REL }], untracked: [] },
        devProfile: {},
        task: { caseType: 3 },
        headSha: 'abc1234',
        gateWeakenedHits: [],
        parity: { ok: true, missing: [] },
        reviewRoot: dir,
      })
      if (behExempt.visualFilesChanged.length !== 0) {
        return `assessBehavioralGate 未豁免有效架构图：${JSON.stringify(behExempt.visualFilesChanged)}`
      }

      // 反向 1：未传 repoRoot 不得豁免；任意业务 HTML 始终为 true；UI_VISUAL_EXT_RE 保持不变
      if (isUiVisualFile(ARCHITECTURE_MAP_REL) !== true) return '缺 repoRoot 时 isUiVisualFile 不得豁免架构图'
      if (isUiVisualFile('src/widget.html', { repoRoot: dir }) !== true) return '业务 HTML src/widget.html 必须命中 UI 门禁'
      if (!UI_VISUAL_EXT_RE.test(ARCHITECTURE_MAP_REL)) return 'UI_VISUAL_EXT_RE 不得被改弱'

      // 反向 2：篡改 Line-1 SHA256 后必须重新触发 UI 门禁
      const archPath = join(dir, ARCHITECTURE_MAP_REL)
      const original = readFileSync(archPath, 'utf8')
      writeFileSync(archPath, original.replace(/[0-9a-f]{64}/i, '0'.repeat(64)), 'utf8')
      if (isUiVisualFile(ARCHITECTURE_MAP_REL, { repoRoot: dir }) !== true) {
        return '篡改 Line-1 SHA256 的架构图不得继续豁免 UI 门禁'
      }
      const polTampered = determineWorkflowPolicy({ changedFiles: [ARCHITECTURE_MAP_REL], repoRoot: dir })
      if (!polTampered.visualFilesChanged.includes(ARCHITECTURE_MAP_REL)) {
        return 'determineWorkflowPolicy 未拦截篡改后的 docs/architecture-map.html'
      }

      // edit-gate 对 >800 行 @generated 架构图应豁免行数上限
      writeFileSync(archPath, `${original}\n<!-- ${'\nline'.repeat(850)} -->\n`, 'utf8')
      const eg = await runEditGate({ dir, mode: 'standalone', files: ARCHITECTURE_MAP_REL })
      if (!eg.ok) return `edit-gate 对 >800 行 @generated HTML 不应阻断：${JSON.stringify(eg.blockers)}`
      writeFileSync(archPath, original, 'utf8')
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['Visual Engine C7：verify-tools render / --check、no-architecture-html 豁免、只读 verify/edit-gate 阻断与 finalize 自动重渲', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"vis-c7","version":"1.0.0"}\n',
      'src/app.mjs': 'export function run() { return 1 }\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{ id: 'app', title: 'App', modules: ['src/app.mjs'], entrypoints: ['src/app.mjs'], tests: [] }],
      }, null, 2),
    })
    gitInit(dir)
    gitCommitFast(dir, 'init')
    try {
      // 1. render --check 在缺失 HTML 时退出码为 3 (EXIT.FACT)
      const chkMissing = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['render', dir, '--check', '--json'])
      if (chkMissing.status !== EXIT.FACT) return `缺失 HTML 时 render --check 应返回 EXIT.FACT(3)，实得 ${chkMissing.status}`

      // 2. render 生成并支持 --out，随后 --check 通过
      const renderRes = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['render', dir, '--json'])
      if (renderRes.status !== 0 || !existsSync(join(dir, ARCHITECTURE_MAP_REL))) {
        return `verify-tools render 失败：${renderRes.stderr}\n${renderRes.stdout}`
      }
      const chkOk = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['render', dir, '--check', '--json'])
      if (chkOk.status !== 0) return `同步后 render --check 应返回 0，实得 ${chkOk.stdout}`
      const outCustom = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['render', dir, '--out', 'docs/custom-arch.html', '--json'])
      if (outCustom.status !== 0 || !existsSync(join(dir, 'docs/custom-arch.html'))) return 'render --out 自定义路径失败'

      // 3. 篡改 feature-map.json 后：edit-gate --final 与 verify hook 均应只读阻断 BLOCKED_ARCHITECTURE_MAP_DRIFT (exit 3) 且不得自动重写 HTML
      const htmlBefore = readFileSync(join(dir, ARCHITECTURE_MAP_REL), 'utf8')
      writeFileSync(join(dir, 'docs/feature-map.json'), JSON.stringify({
        version: 2,
        features: [
          { id: 'app', title: 'App', modules: ['src/app.mjs'], entrypoints: ['src/app.mjs'], tests: [] },
          { id: 'extra', title: 'Extra', modules: ['src/app.mjs'], entrypoints: [], tests: [] },
        ],
      }, null, 2), 'utf8')

      const egDrift = await runEditGate({ dir, mode: 'verify', final: true, changed: true })
      if (egDrift.ok || egDrift.exitCode !== EXIT.FACT || !egDrift.blockers.some((b) => b.ruleId === 'BLOCKED_ARCHITECTURE_MAP_DRIFT')) {
        return `edit-gate --final 未阻断架构图漂移：${JSON.stringify(egDrift)}`
      }
      const hookDrift = await checkArchitectureMapSyncOnVerify({ implRoot: dir, mainRoot: dir, changedFiles: ['docs/feature-map.json'] })
      if (hookDrift.ok || hookDrift.code !== 'BLOCKED_ARCHITECTURE_MAP_DRIFT' || hookDrift.exitCode !== EXIT.FACT) {
        return `verify hook 未阻断架构图漂移：${JSON.stringify(hookDrift)}`
      }
      if (readFileSync(join(dir, ARCHITECTURE_MAP_REL), 'utf8') !== htmlBefore) {
        return '只读 verify/edit-gate 阶段不得自动改写 docs/architecture-map.html'
      }

      // 4. govern reconcile 保持只读，报告 docs.architecture-map-drift
      const findings = []
      const rec = await runReconcileVerifyToolsAudit(dir, dir, join(dir, '.git'), findings, (arr, item) => arr.push(item))
      if (rec.architectureMap?.ok !== false || !findings.some((f) => f.id === 'docs.architecture-map-drift')) {
        return `govern reconcile 未只读报出架构图漂移：${JSON.stringify({ rec, findings })}`
      }
      if (readFileSync(join(dir, ARCHITECTURE_MAP_REL), 'utf8') !== htmlBefore) {
        return '只读 govern reconcile 不得修改 docs/architecture-map.html'
      }

      // 5. AGENTS.md 声明 no-architecture-html 后跳过渲染与校验
      writeFileSync(join(dir, 'AGENTS.md'), '# Demo\n\n## 取舍\n\n```text\n- `no-architecture-html`：不生成 HTML\n```\n', 'utf8')
      const optCheck = verifyArchitectureMapSync(dir)
      if (!optCheck.ok || !optCheck.optedOut) return `no-architecture-html 豁免失败：${JSON.stringify(optCheck)}`
      const optRender = renderArchitectureMapFromRepo(dir)
      if (!optRender.ok || !optRender.optedOut || optRender.written) return `no-architecture-html 仍执行了写入：${JSON.stringify(optRender)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['Visual Engine C8：S1-S4 新建空目录跳过与存量代码仓 artifactPlan / review 对齐（正反双向）', async () => {
    const emptyDir = tmpProject({})
    const codeDir = tmpProject({
      'package.json': '{"name":"s3-code","version":"1.0.0"}\n',
      'src/main.mjs': 'export const main = () => 1\n',
      'README.md': '# S3 Code\n',
    })
    try {
      const sEmpty = await survey(emptyDir)
      const emptyPlan = Object.fromEntries((sEmpty.artifactPlan ?? []).map((x) => [x.id, x]))
      if (emptyPlan['feature-map']?.action !== 'skip' || emptyPlan['architecture-map']?.action !== 'skip') {
        return `空目录未跳过 feature-map / architecture-map：${JSON.stringify([emptyPlan['feature-map'], emptyPlan['architecture-map']])}`
      }

      const sCode = await survey(codeDir)
      const codePlan = Object.fromEntries((sCode.artifactPlan ?? []).map((x) => [x.id, x]))
      if (codePlan['feature-map']?.action !== 'create' || codePlan['architecture-map']?.action !== 'create') {
        return `存量代码仓未规划 create feature-map / architecture-map：${JSON.stringify([codePlan['feature-map'], codePlan['architecture-map']])}`
      }

      // 补齐并漂移后 survey 与 review 必须识别出 calibrate / missing
      mkdirSync(join(codeDir, 'docs'), { recursive: true })
      writeFileSync(join(codeDir, 'docs/feature-map.json'), JSON.stringify({
        version: 1,
        features: [{ id: 'main', title: 'Main', modules: ['src/main.mjs'], entrypoints: ['src/main.mjs'], tests: [] }],
      }, null, 2), 'utf8')
      writeFileSync(join(codeDir, ARCHITECTURE_MAP_REL), '<!-- tampered -->\n<html></html>\n', 'utf8')

      const sDrifted = await survey(codeDir)
      const driftPlan = Object.fromEntries((sDrifted.artifactPlan ?? []).map((x) => [x.id, x]))
      if (driftPlan['architecture-map']?.action !== 'calibrate') {
        return `漂移架构图未触发 calibrate：${JSON.stringify(driftPlan['architecture-map'])}`
      }
      if (!sDrifted.gaps.some((g) => (typeof g === 'string' ? g : `${g?.id ?? ''} ${g?.text ?? ''}`).includes('docs/architecture-map.html'))) {
        return `survey 未检出 docs.architecture-map-drift 缺口：${JSON.stringify(sDrifted.gaps)}`
      }
      const rev = await reviewProject(codeDir, { scopes: new Set(['docs']) })
      if (!rev.missing.some((m) => m.id === 'docs.architecture-map')) {
        return `review.mjs 未把漂移架构图列为 missing：${JSON.stringify(rev.missing)}`
      }
      return true
    } finally {
      rmTree(emptyDir)
      rmTree(codeDir)
    }
  }])

  cases.push(['Visual Blueprint v2 C1/C3/C4：5态 DIFF_STATES、拓扑域排序与固定调色板、虚拟节点与 BFS impactReasons、精简顶栏与 Script 解析（正反双向）', async () => {
    for (const s of ['added', 'modified', 'removed', 'impacted', 'context']) {
      if (!DIFF_STATES.includes(s)) return `DIFF_STATES 缺少状态：${s}`
    }
    if (DIFF_STATES.length !== 5) return `DIFF_STATES 长度应为 5，实得 ${DIFF_STATES.length}`

    // 域字母序 a-ui < b-service < c-core，但依赖方向 a-ui -> b-service -> c-core，拓扑序必须为 c-core -> b-service -> a-ui
    const layeredMap = {
      version: 2,
      repoName: 'Layered Demo',
      domains: [
        { id: 'a-ui', name: 'UI Presentation' },
        { id: 'b-service', name: 'Domain Service' },
        { id: 'c-core', name: 'Core Storage' },
      ],
      features: [
        { id: 'ui-page', name: 'UI Page', domain: 'a-ui', dependsOn: ['svc-api'], entrypoints: ['src/ui.mjs'], modules: ['src/ui.mjs'], tests: [] },
        { id: 'svc-api', name: 'Service API', domain: 'b-service', dependsOn: ['core-db'], entrypoints: ['src/svc.mjs'], modules: ['src/svc.mjs'], tests: [] },
        { id: 'core-db', name: 'Core DB', domain: 'c-core', dependsOn: [], entrypoints: ['src/db.mjs'], modules: ['src/db.mjs'], tests: [] },
        { id: 'legacy-hook', name: 'Legacy Hook', domain: 'b-service', dependsOn: ['core-db'], entrypoints: ['src/legacy.mjs'], modules: ['src/legacy.mjs'], tests: [] },
      ],
      flows: [
        {
          id: 'main-flow',
          name: '主业务流',
          actors: ['user', 'system'],
          features: ['core-db', 'svc-api', 'ui-page'],
          steps: [
            { feature: 'core-db', actor: 'system', action: '读取存储' },
            { feature: 'svc-api', actor: 'system', action: '聚合服务' },
            { feature: 'ui-page', actor: 'user', action: '渲染视图' },
          ],
        },
      ],
    }

    const baseModel = buildVisualModel({ featureMap: layeredMap, mode: 'architecture-map' })
    const baseOrder = baseModel.tree.domains.map((d) => d.id)
    if (baseOrder[0] !== 'c-core' || baseOrder[1] !== 'b-service' || baseOrder[2] !== 'a-ui') {
      return `领域未按依赖拓扑序分层排序（反退化为字母序）：${JSON.stringify(baseOrder)}`
    }
    const basePalettes = Object.fromEntries(baseModel.tree.domains.map((d) => [d.id, d.palette.id]))

    // 显式 layer 覆盖与新增独立规划域 z-gateway + 4 态叠加 + 多源 BFS impactReasons
    const diffModel = buildVisualModel({
      featureMap: layeredMap,
      mode: 'visual-brief',
      diffOverlay: {
        addedNodes: [
          { id: 'gw-edge', domain: 'z-gateway', title: 'New Gateway', summary: '统一网关路由', dependsOn: ['core-db'] },
        ],
        removed: [{ id: 'legacy-hook', reason: '已合并进 Service API', replacementId: 'svc-api' }],
        featureChanges: {
          'core-db': { state: 'modified', before: '同步单连接', after: '连接池 + 只读副本' },
        },
      },
      briefSpec: {
        briefData: {
          goals: ['消除网格毛线团', '实现四态蓝图可读详情'],
          nonGoals: ['不引入第三方图表库'],
          mergedDecisions: ['单行顶栏仅保留 1 个追问按钮'],
          mergedOpen: [],
          pendingDecisions: [],
          childSlices: [],
          activeWorktrees: [],
          flowDeltas: ['增加网关前置鉴权'],
        },
      },
    })

    const gwDom = diffModel.tree.domains.find((d) => d.id === 'z-gateway')
    if (!gwDom) return 'addedNodes 声明的新域 z-gateway 未合成为独立域分组'
    for (const [domId, palId] of Object.entries(basePalettes)) {
      const d = diffModel.tree.domains.find((x) => x.id === domId)
      if (!d || d.palette.id !== palId) return `域 ${domId} 调色板在叠加变更后发生漂移：${palId} -> ${d?.palette?.id}`
    }
    const gwNode = diffModel.tree.nodes.find((n) => n.id === 'gw-edge')
    if (!gwNode || !gwNode.isVirtual || gwNode.diffState !== 'added') return `新增虚拟节点异常：${JSON.stringify(gwNode)}`
    if (gwNode.w !== 284 || gwNode.h !== 114) return `卡片几何应为 284x114，实得 ${gwNode.w}x${gwNode.h}`
    const gwEdge = diffModel.tree.edges.find((e) => e.toId === 'gw-edge')
    if (!gwEdge || !gwEdge.isVirtual || gwEdge.edgeState !== 'added') return `虚拟新增连线异常：${JSON.stringify(gwEdge)}`
    const svcNode = diffModel.tree.nodes.find((n) => n.id === 'svc-api')
    if (!svcNode || svcNode.diffState !== 'impacted' || !Array.isArray(svcNode.impactReasons) || svcNode.impactReasons.length === 0) {
      return `下游受波及节点缺少 impactReasons：${JSON.stringify(svcNode)}`
    }
    const remNode = diffModel.tree.nodes.find((n) => n.id === 'legacy-hook')
    if (!remNode || remNode.diffState !== 'removed') return `拟移除节点状态异常：${JSON.stringify(remNode)}`
    if (diffModel.overlayCounts.added !== 1 || diffModel.overlayCounts.modified !== 1 || diffModel.overlayCounts.removed !== 1 || diffModel.overlayCounts.impacted < 2) {
      return `四态统计异常：${JSON.stringify(diffModel.overlayCounts)}`
    }

    // 渲染校验：单行顶栏仅 1 个追问按钮、无左竖条、默认页签模式感知、首流默认激活、Script 解析通过
    const briefHtml = renderVisualHtml({ visualModel: diffModel, featureMapSha256: 'b'.repeat(64), mode: 'visual-brief' }).html
    const archHtml = renderVisualHtml({ visualModel: baseModel, featureMapSha256: 'b'.repeat(64), mode: 'architecture-map' }).html

    const followupCount = (briefHtml.match(/data-followup-panel=/g) || []).length
    if (followupCount !== 1) return `顶栏追问按钮应去重为恰好 1 个，实得 ${followupCount}`
    if (briefHtml.includes('pf-sidebar') || archHtml.includes('pf-sidebar')) return '严禁渲染右侧抽屉 pf-sidebar'
    if (briefHtml.includes('pf-left-stripe') || briefHtml.includes('border-top:2px solid') || briefHtml.includes('border-left:3px solid')) {
      return '严禁渲染彩色边框竖条/顶条样式'
    }
    if (!/\.pf-node\{[^}]*text-align:\s*center/i.test(archHtml)) {
      return '缺少居中单色卡片样式（text-align:center in .pf-node）'
    }
    if (!archHtml.includes('pf-quicklook') || !briefHtml.includes('pf-quicklook')) {
      return '缺少居中 Quick-Look 详情窗（pf-quicklook）'
    }
    if (!archHtml.includes('pf-focus-card') || !briefHtml.includes('pf-focus-card')) {
      return '缺少底部焦点聚光条（pf-focus-card）'
    }
    if (!archHtml.includes('pf-cmdk') || !briefHtml.includes('pf-cmdk')) {
      return '缺少 Cmd/Ctrl+K 命令与目录面板（pf-cmdk）'
    }
    if (!/d="M [^"]* Q [^"]*"/.test(archHtml)) {
      return '全景架构缺少带圆角 Q 的正交侧道 SVG 连线'
    }
    if (!archHtml.includes('id="vp-tree"') || !archHtml.includes('id="vp-flow"') || !archHtml.includes('pf-stage')) {
      return '缺少 vp-tree 与 vp-flow 双交互画布（pf-stage）'
    }
    if (!briefHtml.includes('pf-edge-added') || !briefHtml.includes('pf-diff-removed')) return 'SVG 缺少新增虚线边或拟移除节点样式'
    if (!briefHtml.includes('pf-zoom-float') || !briefHtml.includes('pf-focus-bar') || !briefHtml.includes('btn-only-diff')) {
      return '缺少左下角浮动缩放胶囊或域聚焦/仅看变更条'
    }
    if (!/<button[^>]*data-tab-target="brief"[^>]*is-active/.test(briefHtml) && !/<button[^>]*is-active[^>]*data-tab-target="brief"/.test(briefHtml)) {
      return 'visual-brief 模式未默认激活变更蓝图页签'
    }
    if (!/<button[^>]*data-tab-target="tree"[^>]*is-active/.test(archHtml) && !/<button[^>]*is-active[^>]*data-tab-target="tree"/.test(archHtml)) {
      return 'architecture-map 模式未默认激活全景架构页签'
    }
    if (archHtml.includes('data-tab-panel="brief"')) return 'architecture-map 模式应省略 brief 专属 DOM 以控体积'
    const flowBtns = [...archHtml.matchAll(/data-flow-select="([^"]*)"/g)].map((m) => m[1])
    if (flowBtns[0] !== '' || flowBtns[1] !== 'main-flow') {
      return `业务流转应默认全部泳道总图在最左、主流程随后，实得 ${JSON.stringify(flowBtns)}`
    }
    if (!archHtml.includes('--dc:#') || !archHtml.includes('pf-dot')) {
      return '缺少基于 --dc 的领域色点与淡色分区样式'
    }
    if (!archHtml.includes('id="btn-flow-ribbon-toggle"')) {
      return '缺少泳道步骤折叠按钮 #btn-flow-ribbon-toggle'
    }
    if (!/\.pf-node\.is-selected\{[^}]*opacity:\s*1!important/i.test(archHtml)) {
      return '缺少泳道跨流选中强制取消淡化规则 (.pf-node.is-selected opacity:1!important)'
    }
    if (!briefHtml.includes('data-diff-filter="added"') || !briefHtml.includes('data-diff-filter="impacted"')) {
      return '变更蓝图缺少可点击的四态统计筛选按钮 data-diff-filter'
    }
    if (!briefHtml.includes('id="fc-ask"') || !archHtml.includes('搜索模块 ⌘K')) {
      return '缺少焦点卡问 AI 按钮或平实命令搜索按钮文案'
    }

    // 多尺度无 NaN / 无重叠冒烟：极简 2 节点 0 流程 + 36 节点 8 域超大仓
    const tinyMap = {
      version: 2,
      repoName: 'Tiny',
      domains: [{ id: 'core', name: 'Core' }],
      features: [
        { id: 't1', name: 'Entry', domain: 'core', modules: ['src/a.mjs'], tests: [] },
        { id: 't2', name: 'Worker', domain: 'core', dependsOn: ['t1'], modules: ['src/b.mjs'], tests: [] },
      ],
      flows: [],
    }
    const bigDomains = Array.from({ length: 8 }, (_, i) => ({ id: `dom-${i}`, name: `Domain ${i}` }))
    const bigFeatures = Array.from({ length: 36 }, (_, i) => ({
      id: `f-${i}`,
      name: `Feature ${i}`,
      domain: `dom-${i % 8}`,
      dependsOn: i > 0 ? [`f-${i - 1}`] : [],
      modules: [`src/m${i}.mjs`],
      tests: [`test/m${i}.test.mjs`],
    }))
    for (const [tag, fmap] of [['tiny', tinyMap], ['large', { version: 2, repoName: 'Large', domains: bigDomains, features: bigFeatures, flows: [] }]]) {
      const m = buildVisualModel({ featureMap: fmap, mode: 'architecture-map' })
      for (const box of [...m.tree.domains, ...m.tree.nodes, ...m.flow.lanes, ...m.flow.nodes]) {
        if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return `${tag} 尺度出现非有限坐标：${JSON.stringify(box)}`
      }
      for (let i = 0; i < m.tree.domains.length; i++) {
        for (let j = i + 1; j < m.tree.domains.length; j++) {
          const a = m.tree.domains[i], b = m.tree.domains[j]
          if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
            return `${tag} 尺度域框发生重叠：${a.id} vs ${b.id}`
          }
        }
      }
      for (let i = 0; i < m.flow.lanes.length; i++) {
        for (let j = i + 1; j < m.flow.lanes.length; j++) {
          const a = m.flow.lanes[i], b = m.flow.lanes[j]
          if (a.y < b.y + b.h && a.y + a.h > b.y) return `${tag} 尺度泳道发生重叠：${a.id} vs ${b.id}`
        }
      }
      const rendered = renderVisualHtml({ visualModel: m, featureMapSha256: 'c'.repeat(64) })
      if (!rendered.html.includes('btn-only-diff') || !rendered.html.includes('hidden')) {
        return `${tag} 尺度渲染异常`
      }
    }
    const dataMatch = /<script id="pf-visual-data" type="application\/json">([\s\S]*?)<\/script>/i.exec(briefHtml)
    const clientJson = dataMatch ? JSON.parse(dataMatch[1]) : null
    const clientSvc = clientJson?.tree?.nodes?.find((n) => n.id === 'svc-api')
    const clientCore = clientJson?.tree?.nodes?.find((n) => n.id === 'core-db')
    if (!clientSvc?.impactReasons?.length || !clientCore?.changeDetail?.after) {
      return 'compactClientModel 未透传 impactReasons 与 changeDetail'
    }
    for (const [label, doc] of [['brief', briefHtml], ['arch', archHtml]]) {
      const blocks = [...doc.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
      for (const m of blocks) {
        if (/type=["']application\/json["']/i.test(m[0])) continue
        try { new Script(m[1]) } catch (err) { return `${label} 内联 <script> 解析失败：${err.message}` }
      }
    }
    return true
  }])

  cases.push(['Visual UX v5 C1-C3：60fps GPU 拖拽、去边框墙蓝图、空泳道省略、repoName 回退与焦点/遮罩交互（正反双向）', async () => {
    const flowMap = {
      version: 2,
      domains: [{ id: 'core', name: 'Core' }],
      features: [
        { id: 'f1', name: 'Planner', domain: 'core', actors: ['planner'], modules: ['src/p.mjs'], tests: [] },
        { id: 'f2', name: 'Runner', domain: 'core', actors: ['implementer'], dependsOn: ['f1'], modules: ['src/r.mjs'], tests: [] },
        { id: 'f3', name: 'Downstream', domain: 'core', actors: ['implementer'], dependsOn: ['f2'], modules: ['src/d.mjs'], tests: [] },
      ],
      flows: [
        {
          id: 'fl1',
          name: '主流程',
          steps: [
            { feature: 'f1', actor: 'planner', action: '规划' },
            { feature: 'f2', actor: 'implementer', action: '实施' },
            { feature: 'f2', actor: 'critic', action: '评审' },
          ],
        },
      ],
    }
    const model = buildVisualModel({
      featureMap: flowMap,
      mode: 'visual-brief',
      diffOverlay: {
        featureChanges: { f1: { state: 'modified', before: '旧方案', after: '新方案' } },
      },
      briefSpec: {
        briefData: {
          verdict: '单行结论摘要',
          goals: ['目标 1', '目标 2', '目标 3', '目标 4'],
          nonGoals: ['不做项 1'],
          flowDeltas: ['流程变化 1'],
          mergedDecisions: ['决策 1'],
          mergedOpen: [],
          pendingDecisions: [],
          childSlices: [],
          activeWorktrees: [],
        },
      },
    })

    // 正反双向：空泳道 critic 必须被省略，非空泳道 planner/implementer 必须保留
    const laneIds = model.flow.lanes.map((l) => l.id)
    if (laneIds.includes('critic')) return `空泳道 critic 未被省略：${JSON.stringify(laneIds)}`
    if (!laneIds.includes('planner') || !laneIds.includes('implementer')) {
      return `非空泳道 planner/implementer 被误删：${JSON.stringify(laneIds)}`
    }

    const briefHtml = renderVisualHtml({ visualModel: model, featureMapSha256: 'd'.repeat(64), mode: 'visual-brief' }).html
    const archHtml = renderVisualHtml({ visualModel: model, featureMapSha256: 'd'.repeat(64), mode: 'architecture-map' }).html

    // C1 正反：.pf-node 严禁全属性 transition:.14s；须含属性级 transition、is-dragging-node、touch-action:none、translate3d、requestAnimationFrame、edgesByNode、setPointerCapture、reset-layout
    if (/\.pf-node\{[^}]*transition:\s*\.14s(?=[;}])/i.test(archHtml)) {
      return '.pf-node 仍残留全属性 transition:.14s 导致拖拽滞后'
    }
    if (!/\.pf-node\{[^}]*transition:border-color/i.test(archHtml) || !/\.pf-node\.is-dragging-node\{[^}]*transition:none!important;will-change:transform/i.test(archHtml)) {
      return '缺少属性级 .pf-node transition 或 .is-dragging-node 零过渡 GPU 加速规则'
    }
    if (!archHtml.includes('touch-action:none') || !archHtml.includes('content-visibility:auto') || !archHtml.includes('@supports not (content-visibility:auto)')) {
      return '缺少 touch-action:none 或带 @supports 降级的 content-visibility:auto'
    }
    if (/\.pf-node[^{]*content-visibility/i.test(archHtml)) {
      return '严禁对绝对定位的 .pf-node 施加 content-visibility:auto'
    }
    for (const token of ['translate3d(', 'requestAnimationFrame', 'edgesByNode', 'setPointerCapture', 'data-zoom-action="reset-layout"', '重置布局']) {
      if (!archHtml.includes(token)) return `客户端拖拽脚本缺少关键机制：${token}`
    }
    const rrtMatch = /rrt=\(vId,nid\)=>\{[^}]*\}/.exec(archHtml)
    if (!rrtMatch || rrtMatch[0].includes('querySelectorAll')) {
      return '拖拽热路径 rrt() 不得执行 querySelectorAll 扫描'
    }

    // C2 正反：无重复 verdict-pill、有 #btn-jump-diff-tree、有 .pf-impact-fold、超 3 项折叠 .pf-more-fold、title 全称属性
    const heroMatch = /<div class="pf-verdict-hero">[\s\S]*?<\/div><section class="pf-bp-sec">/.exec(briefHtml)
    if (heroMatch && heroMatch[0].includes('pf-verdict-pill')) {
      return '.pf-verdict-hero 内仍存在与顶栏重复的 pf-verdict-pill'
    }
    if (!briefHtml.includes('id="btn-jump-diff-tree"') || !briefHtml.includes('class="pf-impact-fold"') || !briefHtml.includes('class="pf-more-fold"')) {
      return '变更蓝图缺少快捷跳转按钮、下游波及折叠或超 3 条台账折叠'
    }
    if (!/<h1 class="pf-title" title="/.test(briefHtml)) {
      return '.pf-title 缺少完整标题 title 属性'
    }

    // C3 正反：暗色 WCAG 对比度色值、禁 .pf-node.is-dimmed opacity:.55、焦点卡互斥与遮罩点击关闭
    if (!archHtml.includes('--accent-solid:#4F46E5') || !archHtml.includes('--muted:#A8B8CD')) {
      return '暗色模式对比度 token 未更新为 #4F46E5 / #A8B8CD'
    }
    if (/\.pf-node\.is-dimmed[^{]*\{[^}]*opacity:\s*\.55/i.test(archHtml)) {
      return '.pf-node.is-dimmed 仍使用 opacity:.55 导致文字对比度低于 4.5:1'
    }
    if (!archHtml.includes('syncFc') || !archHtml.includes('ev.target===m')) {
      return '缺少弹窗打开时隐藏焦点卡（syncFc）或点击遮罩背景关闭弹窗逻辑'
    }

    // C3 architecture-map.mjs repoName 回退 basename(root)（正反双向）
    const dirFallback = tmpProject({
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        features: [{ id: 'core', title: 'Core', modules: ['src/a.mjs'], entrypoints: ['src/a.mjs'], tests: [] }],
      }, null, 2),
    })
    const dirExplicit = tmpProject({
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        repoName: 'CustomExplicitRepo',
        features: [{ id: 'core', title: 'Core', modules: ['src/a.mjs'], entrypoints: ['src/a.mjs'], tests: [] }],
      }, null, 2),
    })
    try {
      const rFb = renderArchitectureMapFromRepo(dirFallback, { write: false })
      const expectedName = basename(dirFallback)
      if (!rFb.ok || !rFb.html.includes(`${expectedName} — 架构全景图`) || rFb.html.includes('项目仓库 — 架构全景图')) {
        return `缺省 repoName 未回退至 basename(root) (${expectedName})`
      }
      const rEx = renderArchitectureMapFromRepo(dirExplicit, { write: false })
      if (!rEx.ok || !rEx.html.includes('CustomExplicitRepo — 架构全景图')) {
        return '显式 repoName 被 basename(root) 错误覆盖'
      }
    } finally {
      rmTree(dirFallback)
      rmTree(dirExplicit)
    }
    return true
  }])
}
