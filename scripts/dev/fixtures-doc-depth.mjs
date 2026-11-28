/**
 * fixtures-doc-depth.mjs —— 规划文档深度裁剪、实质性与互链闭环双向行为断言（--domain doc-depth）：
 *   C1: init 骨架保留（pruneUnfilled=false）、--no-prune、spec 自洽与 pruneUnfilled=true 向后兼容
 *   C2: doc-shape 工作区实时形态探测、可复核跳过说明与主干/required_sections 硬保护
 *   C3: 核心实质性（零字数下限）、INLINE_FORMS 防占位与跨轮防退化（DOC_REGRESSION_* + delta）
 *   C4: --spec/--prd 互链继承、clarify 澄清落盘、历史归档隔离与总控 PRD 归档覆盖率
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SKILL_ROOT, gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject,
} from './fixtures-helpers.mjs'

function fillAngleHints(text, replacement = '已核实真实内容') {
  return String(text ?? '')
    .replace(/<two-way \| one-way>/g, 'two-way')
    .replace(/<[^<>\n]{1,120}>/g, replacement)
}

export function registerDocDepthCases(cases) {
  cases.push(['C1: 3 文件 Go CLI init 保留可选骨架、--no-prune 与 spec 渲染自洽（向后兼容 pruneUnfilled=true）', async () => {
    const { renderDocTemplate } = await import('../../kit/skills/lib/doc-template-render.mjs')
    const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

    const goDir = tmpProject({
      'README.md': '# go-cli\n\nA tiny 3-file Go CLI.\n',
      'go.mod': 'module example.com/gocli\n\ngo 1.22\n',
      'main.go': 'package main\nimport "flag"\nfunc main() { flag.Parse() }\n',
      'cmd/root.go': 'package cmd\nfunc Run() error { return nil }\n',
    })
    const tddDir = tmpProject({
      'README.md': '# go-tdd\n',
      'go.mod': 'module example.com/gotdd\n\ngo 1.22\n',
      'main.go': 'package main\nfunc main() {}\n',
      'docs/TDD.md': '# TDD\n\n## 文档信息\n- 基线：源码\n## 背景与非目标\n- 非目标：不做 GUI\n## 系统架构\n| 模块 | 职责 |\n| --- | --- |\n| main | 入口 |\n## 主链路\n- 解析参数\n## 不变量\n- 退出码清晰\n',
    })

    try {
      const initAll = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'all', '--slug', 'go-cli', '--title', 'Go CLI 增强', '--owner', 'arch-1', '--json',
      ], { cwd: goDir })
      if (initAll.status !== 0) return `3 文件 Go CLI init 保留可选骨架失败：${initAll.stderr}`
      const created = JSON.parse(initAll.stdout).files
      const prdRel = created.find((f) => f.endsWith('-prd.md'))
      const specRel = created.find((f) => f.endsWith('-spec.md'))
      const todoRel = created.find((f) => f.endsWith('-todo.md'))
      const prdText = readFileSync(join(goDir, prdRel), 'utf8')
      const specText = readFileSync(join(goDir, specRel), 'utf8')
      const todoText = readFileSync(join(goDir, todoRel), 'utf8')

      for (const h of ['关键业务流程', '复用既有模块', '待拍板问题', '门型与回滚路径', '澄清与补充记录']) {
        if (!prdText.includes(h)) return `3 文件 Go CLI init 保留可选骨架：PRD 缺少 ${h}`
      }
      for (const h of ['设计方案与契约变更', '备选方案与否决理由', '改动清单与影响面', '高风险点', '实现说明', '澄清与补充记录']) {
        if (!specText.includes(h)) return `3 文件 Go CLI init 保留可选骨架：SPEC 缺少 ${h}`
      }
      for (const h of ['执行步骤', '风险与应对', '回滚预案', '断点与遗留决策', '澄清与补充记录']) {
        if (!todoText.includes(h)) return `3 文件 Go CLI init 保留可选骨架：Todo 缺少 ${h}`
      }

      if (specText.includes('待补齐')) return 'SPEC 初始化产物中残留「待补齐」'
      if (!/^\|\s*`<真实文件路径，新建文件标 \(new\)>`\s*\|\s*改造\s*\/\s*新增\s*\|/m.test(specText)) {
        return `SPEC MODULES 行未渲染为合法尖括号 Markdown 表格行：\n${specText}`
      }
      if (/^- <真实文件路径/m.test(specText)) return 'SPEC MODULES 仍以 `- ` 开头破坏表格'
      if (specText.includes('docs/TDD.md')) return '无 TDD 仓库的 SPEC 竟硬编码引用 docs/TDD.md'
      if (!specText.includes('项目架构基线')) return '无 TDD 仓库的 SPEC 未渲染条件化 TDD_REF 说明'

      const rawAudit = auditDoc({ repoRoot: goDir, file: specRel })
      const rawCodes = new Set(rawAudit.errors.map((e) => e.code))
      if (rawCodes.has('HALLUCINATED_PATH')) {
        return `无 TDD 仓库初始 SPEC 竟触发 HALLUCINATED_PATH：${JSON.stringify(rawAudit.errors)}`
      }
      if (rawCodes.has('UNRESOLVED_PLACEHOLDER')) {
        return `初始 SPEC 竟触发 UNRESOLVED_PLACEHOLDER：${JSON.stringify(rawAudit.errors)}`
      }
      if (!rawCodes.has('UNRESOLVED_ANGLE_PLACEHOLDER')) {
        return '初始 SPEC 未保留尖括号填写提示（预期由作者补齐后过 audit）'
      }

      // 有 docs/TDD.md 的仓库应保留真实 `docs/TDD.md` 路径
      const initTddSpec = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'with-tdd', '--title', 'With TDD', '--owner', 'arch-1', '--json',
      ], { cwd: tddDir })
      if (initTddSpec.status !== 0) return `有 TDD 仓库 init spec 失败：${initTddSpec.stderr}`
      const tddSpecText = readFileSync(join(tddDir, JSON.parse(initTddSpec.stdout).file), 'utf8')
      if (!tddSpecText.includes('`docs/TDD.md`')) {
        return '有 docs/TDD.md 的仓库未渲染有效 `docs/TDD.md` 路径'
      }

      // --no-prune 保留模板全部可选节且不写 doc-shape-skipped
      const initNoPrune = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'prd', '--slug', 'full-skel', '--title', 'Full Skel', '--owner', 'arch-1', '--no-prune', '--json',
      ], { cwd: goDir })
      if (initNoPrune.status !== 0) return `--no-prune init 失败：${initNoPrune.stderr}`
      const noPruneText = readFileSync(join(goDir, JSON.parse(initNoPrune.stdout).file), 'utf8')
      for (const h of ['用户身份与权限', '状态与业务规则', '非功能要求', '上线、灰度与运营方案', '成功度量', '依赖与前置条件', '风险与开放问题']) {
        if (!noPruneText.includes(h)) return `--no-prune 未全量保留可选节「${h}」`
      }
      if (/<!--\s*doc-shape-skipped:/.test(noPruneText)) return '--no-prune 不应生成 doc-shape-skipped 注释'

      // 向后兼容：直接调用 renderDocTemplate 与 govern-docs --write-todo 保持 pruneUnfilled: true
      const directPrd = renderDocTemplate('prd', { vars: { TITLE: 'Direct', TODAY: '2026-01-01' } })
      if (directPrd.includes('用户身份与权限') || directPrd.includes('非功能要求')) {
        return '直接调用 renderDocTemplate 未保持 pruneUnfilled: true 兼容'
      }
      const govDir = tmpProject({
        'README.md': '# gov\n',
        'AGENTS.md': '# gov\n\n```yaml\nquick-test: exit 0\n```\n',
        'src/app.mjs': 'export const ok = 1\n',
      })
      try {
        gitInit(govDir, { branch: 'main', name: 't', email: 't@t.t' })
        const govRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['plan', '--write-todo', '--allow-main', '--json'], { cwd: govDir })
        if (govRes.status !== 0) return `govern --write-todo 失败：${govRes.stderr}`
        const gTodoRel = JSON.parse(govRes.stdout).plan?.todoRel
        const gTodoText = readFileSync(join(govDir, gTodoRel), 'utf8')
        if (gTodoText.includes('风险与应对') || gTodoText.includes('协作与依赖')) {
          return 'govern --write-todo 未按 pruneUnfilled: true 剪掉未填可选节'
        }
      } finally { rmTree(govDir) }

      return true
    } finally {
      rmTree(goDir)
      rmTree(tddDir)
    }
  }])

  cases.push(['C2: doc-shape 实时工作区探测、可复核跳过说明与主干/required_sections 硬保护', async () => {
    const { analyzeDocShapeFromPaths, probeWorkspaceDocShape } = await import('../../kit/skills/lib/doc-shape.mjs')
    const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

    const goDir = tmpProject({
      'README.md': '# go-cli\n',
      'go.mod': 'module example.com/gocli\n\ngo 1.22\n',
      'main.go': 'package main\nfunc main() {}\n',
      'cmd/root.go': 'package cmd\nfunc Run() {}\n',
    })
    const richDir = tmpProject({
      'README.md': '# rich-app\n',
      'package.json': '{"name":"rich","version":"1.0.0","dependencies":{"react":"18.0.0"}}\n',
      'src/auth/jwt.ts': 'export const verifyJwt = () => true\n',
      'prisma/schema.prisma': 'model User { id Int @id }\n',
      'src/App.tsx': 'export function App() { return null }\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\n',
      'Dockerfile': 'FROM node:20-alpine\n',
      'CODEOWNERS': '* @team\n',
    })
    const reqDir = tmpProject({
      'README.md': '# go-req\n',
      'go.mod': 'module example.com/goreq\n\ngo 1.22\n',
      'main.go': 'package main\nfunc main() {}\n',
      'docs/templates/prd.md': '---\nkind: prd\nrequired_sections: [users]\n---\n\n# 自定义 PRD 模板\n',
    })

    try {
      const goShape = await probeWorkspaceDocShape(goDir)
      if (!goShape.signals.cliEntry || goShape.signals.authRoles || goShape.signals.stateRules || goShape.signals.uiFrontend || goShape.signals.ciRollout || goShape.signals.multiCollab) {
        return `3 文件 Go CLI 探测信号失真：${JSON.stringify(goShape.signals)}`
      }

      const initGo = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'all', '--slug', 'shape-go', '--title', 'Shape Go', '--owner', 'arch-1', '--json',
      ], { cwd: goDir })
      if (initGo.status !== 0) return `Go 仓 init 失败：${initGo.stderr}`
      const goFiles = JSON.parse(initGo.stdout).files
      const goPrd = goFiles.find((f) => f.endsWith('-prd.md'))
      const goSpec = goFiles.find((f) => f.endsWith('-spec.md'))
      const goTodo = goFiles.find((f) => f.endsWith('-todo.md'))
      const goPrdText = readFileSync(join(goDir, goPrd), 'utf8')
      const goSpecText = readFileSync(join(goDir, goSpec), 'utf8')
      const goTodoText = readFileSync(join(goDir, goTodo), 'utf8')

      if (!/<!--\s*doc-shape-skipped:[^>]*users\(roles\)[^>]*rules[^>]*rollout/i.test(goPrdText)
        || !goPrdText.includes('形态裁剪说明（doc-shape）')) {
        return `Go 仓 PRD 缺少可读跳过注释或摘要：\n${goPrdText.slice(0, 800)}`
      }
      if (goPrdText.includes('用户身份与权限') || goPrdText.includes('状态与业务规则')) {
        return 'Go 仓 PRD 未裁剪不适用的 users/rules'
      }
      if (!/<!--\s*doc-shape-skipped:[^>]*rollout/i.test(goSpecText) || goSpecText.includes('上线与兼容策略')) {
        return 'Go 仓 SPEC 未裁剪不适用的 rollout'
      }
      if (!/<!--\s*doc-shape-skipped:[^>]*coordination/i.test(goTodoText) || goTodoText.includes('协作与依赖')) {
        return 'Go 仓 Todo 未裁剪不适用的 coordination'
      }

      // 填充占位后 audit 应放行合法跳过说明并输出 skippedSections
      writeFileSync(join(goDir, goPrd), fillAngleHints(goPrdText, '不动 `main.go` 入口')
        .replace('- [ ] C1: 不动 `main.go` 入口', '- [ ] C1: `go test ./...` 退出码为 0')
        .replace('- [ ] C2: 不动 `main.go` 入口', '- [ ] C2: `go run .` 返回 0'))
      const goAud = auditDoc({ repoRoot: goDir, file: goPrd })
      if (!goAud.ok || !Array.isArray(goAud.skippedSections) || !goAud.skippedSections.includes('users')) {
        return `合法 doc-shape 跳过未通过 audit 或未返回 skippedSections：${JSON.stringify(goAud)}`
      }

      // 含鉴权/状态机/前端/CI 发布的多面仓自动保留对应可选节
      const richShape = await probeWorkspaceDocShape(richDir)
      for (const sig of ['authRoles', 'stateRules', 'uiFrontend', 'ciRollout', 'multiCollab']) {
        if (!richShape.signals[sig]) return `多面仓漏探信号 ${sig}：${JSON.stringify(richShape.signals)}`
      }
      // 回归校验：k8s/、helm/、deploy/ 目录应独立触发 ciRollout
      for (const deployPath of ['k8s/app.yaml', 'deploy/prod.sh', 'helm/Chart.yaml']) {
        const dShape = analyzeDocShapeFromPaths(null, ['package.json', deployPath])
        if (!dShape.signals.ciRollout) return `${deployPath} 未触发 ciRollout：${JSON.stringify(dShape.signals)}`
      }
      const initRich = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'all', '--slug', 'rich-app', '--title', 'Rich App', '--owner', 'arch-1', '--json',
      ], { cwd: richDir })
      if (initRich.status !== 0) return `多面仓 init 失败：${initRich.stderr}`
      const richFiles = JSON.parse(initRich.stdout).files
      const richPrd = readFileSync(join(richDir, richFiles.find((f) => f.endsWith('-prd.md'))), 'utf8')
      const richTodo = readFileSync(join(richDir, richFiles.find((f) => f.endsWith('-todo.md'))), 'utf8')
      for (const kept of ['用户身份与权限', '状态与业务规则', '非功能要求', '上线、灰度与运营方案', '成功度量']) {
        if (!richPrd.includes(kept)) return `多面仓 PRD 未保留 ${kept}`
      }
      if (!richTodo.includes('协作与依赖')) return '多面仓 Todo 未保留 协作与依赖'

      // 反向保护 1：custom required_sections 在 3 文件 Go 仓仍保留 users
      const initReq = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'prd', '--slug', 'req-users', '--title', 'Req Users', '--owner', 'arch-1', '--json',
      ], { cwd: reqDir })
      if (initReq.status !== 0) return `自定义 required_sections init 失败：${initReq.stderr}`
      const reqPrdRel = JSON.parse(initReq.stdout).file
      const reqPrdText = readFileSync(join(reqDir, reqPrdRel), 'utf8')
      if (!reqPrdText.includes('用户身份与权限')) return '自定义 required_sections: [users] 被 doc-shape 误剪'

      // 反向保护 2：强行写入跳过核心节或 required_sections -> DOC_SKIP_INVALID_SECTION
      writeFileSync(join(reqDir, reqPrdRel), `${reqPrdText}\n<!-- doc-shape-skipped: goal, users -->\n`)
      const badSkip = auditDoc({ repoRoot: reqDir, file: reqPrdRel })
      const skipCodes = badSkip.errors.filter((e) => e.code === 'DOC_SKIP_INVALID_SECTION')
      if (skipCodes.length < 2) {
        return `强行跳过核心节或 required_sections 未报 DOC_SKIP_INVALID_SECTION：${JSON.stringify(badSkip.errors)}`
      }

      return true
    } finally {
      rmTree(goDir)
      rmTree(richDir)
      rmTree(reqDir)
    }
  }])

  cases.push(['C3: 核心实质性与跨轮退化拦截（零字数下限、INLINE_FORMS 堵漏与 delta 统计）', async () => {
    const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# sub\n',
      'scripts/survey.mjs': 'export const ok = 1\n',
      'src/app.mjs': 'export function runCli() { return 0 }\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      // 1. 拦截 `- **本期不做**：待补齐`、暂无、暂缺、裸 `无` 与纯套话
      const stubSpec = [
        '---', 'kind: spec', 'title: Stub', 'status: draft', 'tier: L3',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: null', 'owner: planner',
        '---', '', '# Stub', '',
        '## 一、背景与边界声明',
        '- **要改什么**：提升体验、优化功能、确保稳定。',
        '- **本期不做**：待补齐',
        '- **复用既有模块**：暂无',
        '',
        '## 二、设计方案与契约变更',
        '- 完善功能，合理设计，按需处理。',
        '',
        '## 三、冻结的验收标准',
        '- [ ] C1: `scripts/survey.mjs` 退出码 0',
      ].join('\n')
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      writeFileSync(join(dir, 'docs/specs/261118-stub-spec.md'), stubSpec)
      const stubAud = auditDoc({ repoRoot: dir, file: 'docs/specs/261118-stub-spec.md' })
      const stubCodes = new Set(stubAud.errors.map((e) => e.code))
      for (const expected of ['DOC_STUB_PLACEHOLDER', 'DOC_VAGUE_CORE_SECTION', 'MISSING_SECTION_NON_GOALS']) {
        if (!stubCodes.has(expected)) {
          return `核心实质性与跨轮退化拦截：未报 ${expected}，实得 ${JSON.stringify(stubAud.errors)}`
        }
      }

      // 拦截核心节裸 `- 无`
      writeFileSync(join(dir, 'docs/specs/261118-bare-no-spec.md'), [
        '---', 'kind: spec', 'title: BareNo', 'status: draft', 'tier: L3',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: null', 'owner: planner',
        '---', '', '# BareNo', '',
        '## 要解决的问题', '- 修复 `src/app.mjs` 异常退出。', '',
        '## 本期不做', '- 无', '',
        '## 验收标准', '- [ ] C1: `src/app.mjs` 退出码 0',
      ].join('\n'))
      const bareAud = auditDoc({ repoRoot: dir, file: 'docs/specs/261118-bare-no-spec.md' })
      if (!bareAud.errors.some((e) => e.code === 'DOC_STUB_PLACEHOLDER')) {
        return `核心实质性与跨轮退化拦截：核心节裸「- 无」未被拦截：${JSON.stringify(bareAud.errors)}`
      }

      // 2. 反向：无字数门槛——极短但含真实锚点/排除对象 + 合法豁免位置写「无」必须通过
      const conciseRel = 'docs/specs/261118-concise-spec.md'
      const baselineConcise = [
        '---', 'kind: spec', 'title: Concise', 'status: draft', 'tier: L3',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: null', 'owner: planner',
        'plan_critique: pending',
        '---', '', '# Concise', '',
        '## 一、背景与边界声明',
        '- **要改什么**：修改 `src/app.mjs` 的 `runCli` 返回退出码 0，待机功耗 <= 5uA。',
        '- **本期不做**：不动 `scripts/survey.mjs`',
        '- **复用既有模块**：沿用 `src/app.mjs`',
        '',
        '## 二、设计方案与契约变更',
        '- 调整 `runCli` 参数 `--strict`，保证 `src/app.mjs` 退出码 0。',
        '',
        '## 三、改动清单与影响面',
        '- **对外可见的变化**：无',
        '',
        '## 四、冻结的验收标准',
        '- [ ] C1: `src/app.mjs` 退出码 0',
        '- [ ] C2: `scripts/survey.mjs` 保持不变',
        '',
        '## 待拍板问题',
        '- 无',
        '',
        '## 实现说明',
        '- 已确认范围。',
      ].join('\n')
      writeFileSync(join(dir, conciseRel), baselineConcise)
      const conciseAud = auditDoc({ repoRoot: dir, file: conciseRel })
      if (!conciseAud.ok) {
        return `短内容含真实锚点或合法「无」位置被误伤：${JSON.stringify(conciseAud.errors)}`
      }

      // 3. critique-pass 不再向 Frontmatter 写入 critique_anchors，而是写入账本/sidecar，link --issue 不触发 BLOCKED_CRITIQUE_STALE
      const cp = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', conciseRel, '--reviewer', 'critic-1', '--json',
      ], { cwd: dir })
      if (cp.status !== 0) return `critique-pass 失败：${cp.stderr}`
      const postCpText = readFileSync(join(dir, conciseRel), 'utf8')
      if (postCpText.includes('critique_anchors:') || postCpText.includes('critique_rounds:')) {
        return 'critique-pass 不应再向 Frontmatter 写入 critique_anchors/critique_rounds'
      }
      const { readPlanCritiqueEntrySync } = await import('../../kit/skills/lib/critique-rounds.mjs')
      const { entry: cpEntry } = readPlanCritiqueEntrySync({ repoRoot: dir, relDoc: conciseRel })
      if (!cpEntry?.anchors || !Array.isArray(cpEntry?.rounds) || cpEntry.rounds.length !== 1) {
        return `critique-pass 未将 anchors/rounds 写入持久化存储：${JSON.stringify(cpEntry)}`
      }
      const lk = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'link', conciseRel, '--issue', '88', '--json',
      ], { cwd: dir })
      if (lk.status !== 0) return `link --issue 88 失败：${lk.stderr}`
      const renamedConciseRel = JSON.parse(lk.stdout).byKind.spec
      const ap = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'approve', '--file', renamedConciseRel, '--json',
      ], { cwd: dir })
      if (ap.status !== 0) return `link 后 approve 误触发 stale：${ap.stderr}`

      // 4. 跨轮退化检测：精简改写删锚点不再报 DOC_REGRESSION_ANCHOR_LOST，仍校验核心节清空与 delta 统计
      const anchorLost = baselineConcise
        .replace('、修改 `src/app.mjs` 的 `runCli` 返回退出码 0，待机功耗 <= 5uA', '')
        .replace('修改 `src/app.mjs` 的 `runCli` 返回退出码 0，待机功耗 <= 5uA', '修改 `src/app.mjs` 逻辑')
        .replace('- 调整 `runCli` 参数 `--strict`，保证 `src/app.mjs` 退出码 0。', '- 调整 `src/app.mjs` 逻辑。')
      writeFileSync(join(dir, conciseRel), anchorLost)
      const regAnchor = auditDoc({ repoRoot: dir, file: conciseRel, baselineText: baselineConcise })
      if (!regAnchor.ok || regAnchor.errors.some((e) => e.code === 'DOC_REGRESSION_ANCHOR_LOST') || (regAnchor.delta?.anchorsRemoved?.length ?? 0) === 0) {
        return `精简改写应放行且仍统计 anchorsRemoved delta：${JSON.stringify(regAnchor)}`
      }

      const coreEmptied = baselineConcise.replace(
        '- 调整 `runCli` 参数 `--strict`，保证 `src/app.mjs` 退出码 0。',
        '',
      )
      writeFileSync(join(dir, conciseRel), coreEmptied)
      const regEmpty = auditDoc({ repoRoot: dir, file: conciseRel, baselineText: baselineConcise })
      if (regEmpty.ok || !regEmpty.errors.some((e) => e.code === 'DOC_REGRESSION_CORE_EMPTIED') || !regEmpty.delta?.coreSectionsLost?.includes('design')) {
        return `核心实质性与跨轮退化拦截：清空已填设计节未报 DOC_REGRESSION_CORE_EMPTIED：${JSON.stringify(regEmpty)}`
      }

      // Git HEAD 基线回退与正向增量（新增锚点 + 解决待拍板）
      const headPendingDoc = baselineConcise.replace('## 待拍板问题\n- 无', '## 待拍板问题\n- 是否启用 `--strict` 模式')
      writeFileSync(join(dir, conciseRel), headPendingDoc)
      gitCommitFast(dir, 'commit baseline concise spec', { files: [conciseRel], name: 'alice', email: 'alice@example.com' })
      const enriched = headPendingDoc
        .replace('保证 `src/app.mjs` 退出码 0。', '保证 `src/app.mjs` 与 `scripts/survey.mjs` 退出码 0（新增 `--dry-run`）。')
        .replace('- 是否启用 `--strict` 模式', '- 是否启用 `--strict` 模式（已定：默认启用 `--strict` 模式）')
      writeFileSync(join(dir, conciseRel), enriched)
      const posDelta = auditDoc({ repoRoot: dir, file: conciseRel })
      if (!posDelta.ok || posDelta.delta?.baselineSource !== 'git-head' || (posDelta.delta?.anchorsAdded?.length ?? 0) === 0 || (posDelta.delta?.pendingResolved ?? 0) < 1) {
        return `正向增量更新被误拦或 delta 统计错误：${JSON.stringify(posDelta)}`
      }

      // 5. PRD `## 二、范围与非目标` + `### 本次要做` / `### 明确不做（Non-Goals）` 双向检查与跨轮退化拦截
      const { extractDocSnapshot } = await import('../../kit/skills/lib/doc-substantive.mjs')
      mkdirSync(join(dir, 'docs/prd'), { recursive: true })
      const prdBase = [
        '---', 'kind: prd', 'title: PrdScope', 'status: draft',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: null', 'owner: planner',
        '---', '', '# PrdScope', '',
        '## 一、要解决的问题', '- 修复 `src/app.mjs` CLI 返回码。', '',
        '## 二、范围与非目标',
        '### 本次要做（In Scope）', '- 改造 `src/app.mjs`',
        '### 明确不做（Non-Goals）', '- 不修改 `scripts/survey.mjs`', '',
        '## 三、验收标准', '- [ ] C1: `src/app.mjs` 退出码 0',
      ].join('\n')
      const prdRel = 'docs/prd/261118-prdscope-prd.md'
      writeFileSync(join(dir, prdRel), prdBase)
      const prdGoodAud = auditDoc({ repoRoot: dir, file: prdRel })
      const prdSnap = extractDocSnapshot(prdBase)
      if (!prdGoodAud.ok || !prdSnap.sections['non-goals']?.substantive) {
        return `合法 PRD 范围与非目标未过审或未写入 sections.non-goals：${JSON.stringify({ prdGoodAud, prdSnap })}`
      }
      // 占位桩 / 套话（heading 本身绝不冒充 !（Non-Goals） 锚点）/ 本次要做占位均须拦截
      writeFileSync(join(dir, prdRel), prdBase.replace('- 不修改 `scripts/survey.mjs`', '- 暂无'))
      const prdStubAud = auditDoc({ repoRoot: dir, file: prdRel })
      if (!prdStubAud.errors.some((e) => e.code === 'DOC_STUB_PLACEHOLDER' && e.section === 'non-goals')) {
        return `PRD Non-Goals 占位桩未被拦截：${JSON.stringify(prdStubAud.errors)}`
      }
      writeFileSync(join(dir, prdRel), prdBase.replace('- 不修改 `scripts/survey.mjs`', '- 提升体验、优化功能、确保稳定'))
      const prdFluffAud = auditDoc({ repoRoot: dir, file: prdRel })
      if (!prdFluffAud.errors.some((e) => e.code === 'DOC_VAGUE_CORE_SECTION' && e.section === 'non-goals')) {
        return `PRD Non-Goals 套话未被拦截（疑似标题被误算为排除锚点）：${JSON.stringify(prdFluffAud.errors)}`
      }
      writeFileSync(join(dir, prdRel), prdBase.replace('- 改造 `src/app.mjs`', '- 暂无'))
      const prdInScopeStubAud = auditDoc({ repoRoot: dir, file: prdRel })
      if (!prdInScopeStubAud.errors.some((e) => e.code === 'DOC_STUB_PLACEHOLDER' && e.section === 'goal')) {
        return `PRD 本次要做占位桩未被拦截：${JSON.stringify(prdInScopeStubAud.errors)}`
      }
      writeFileSync(join(dir, prdRel), prdBase.replace('- 不修改 `scripts/survey.mjs`', '- 无'))
      const prdRegAud = auditDoc({ repoRoot: dir, file: prdRel, baselineText: prdBase })
      if (!prdRegAud.errors.some((e) => e.code === 'DOC_REGRESSION_CORE_DEGRADED' && e.section === 'non-goals')) {
        return `PRD Non-Goals 退化回「- 无」未触发 DOC_REGRESSION_CORE_DEGRADED：${JSON.stringify(prdRegAud)}`
      }

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4: --spec/--prd 互链继承、clarify 澄清落盘、历史同 slug 归档隔离与 checkMasterPrdCoverage 扫描已归档关联 SPEC', async () => {
    const { archiveCompletedDocsGroup, parseDocFrontmatter, syncDocsLifecycle } = await import('../../kit/skills/lib/docs.mjs')
    const { checkMasterPrdCoverage } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# c4\n',
      'src/core.mjs': 'export const core = 1\n',
      'docs/prd/261117-master-prd.md': [
        '---', 'kind: prd', 'title: "Master"', 'status: active',
        'created: 2026-11-17', 'updated: 2026-11-17', 'issue: null', 'pr: null',
        'owner: lead', 'plan_critique: passed', 'related_spec: null', 'related_todo: null',
        'multi_spec: true',
        '---', '', '# Master PRD', '',
        '## 一、要解决的问题', '- 解决 `src/core.mjs` 的分层收敛问题。', '',
        '## 二、范围与非目标', '### 明确不做（Non-Goals）', '- 不改外部构建产物格式。', '',
        '## 八、验收标准',
        '- [ ] C1: `src/core.mjs` 第一切片能力就位',
        '- [ ] C2: `src/core.mjs` 第二切片能力就位',
        '- [ ] C3: `src/core.mjs` 第三切片能力就位',
      ].join('\n'),
      'docs/specs/261118-issue91-slice-a-spec.md': [
        '---', 'kind: spec', 'title: "Slice A"', 'status: draft', 'tier: L3',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 91', 'pr: null',
        'branch: feat/slice-a', 'owner: planner', 'approved: false', 'implemented: false',
        'plan_critique: passed', 'related_prd: ../prd/261117-master-prd.md', 'related_todo: null',
        '---', '', '# Slice A', '',
        '## 一、背景与边界声明',
        '- **要改什么**：增强 `src/core.mjs` 第一切片能力。',
        '- **本期不做**：不动 `README.md`。',
        '',
        '## 二、冻结的验收标准',
        '- [ ] C1: 认领总控 C1',
        '',
        '## 待拍板问题',
        '- 待确认：无',
      ].join('\n'),
      'docs/archive/specs/261114-issue10-feat-spec.md': '---\nkind: spec\ntitle: "Old 10"\nstatus: implemented\nissue: 10\nrelated_prd: null\n---\n\n# Old 10\n- [x] C3: 历史误导条目\n',
      'docs/archive/todo/261115-feat-todo.md': '---\nkind: todo\ntitle: "Old Null"\nstatus: done\nissue: null\n---\n\n# Old Null\n- [x] C1: old\n',
      'docs/archive/specs/261118-feat-spec.md': '---\nkind: spec\ntitle: "Same Date Null"\nstatus: implemented\nissue: null\nrelated_prd: null\n---\n\n# Same Date Null\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      const masterPrdBefore = readFileSync(join(dir, 'docs/prd/261117-master-prd.md'), 'utf8')

      // 1. init --kind todo --spec 自动继承 related_prd 并回写父 SPEC related_todo，且不写脏 1:N PRD
      const initTodo = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'slice-a', '--title', 'Slice A Todo', '--owner', 'planner',
        '--spec', 'docs/specs/261118-issue91-slice-a-spec.md', '--in-place', '--json',
      ], { cwd: dir })
      if (initTodo.status !== 0) return `init --kind todo --spec 失败：${initTodo.stderr}`
      const todoRel = JSON.parse(initTodo.stdout).file
      const todoFm = parseDocFrontmatter(readFileSync(join(dir, todoRel), 'utf8')).data
      const specFm = parseDocFrontmatter(readFileSync(join(dir, 'docs/specs/261118-issue91-slice-a-spec.md'), 'utf8')).data
      if (todoFm.related_prd !== '../prd/261117-master-prd.md' || todoFm.related_spec !== '../specs/261118-issue91-slice-a-spec.md') {
        return `Todo 未继承 related_prd 或 related_spec：${JSON.stringify(todoFm)}`
      }
      if (!String(specFm.related_todo ?? '').endsWith(todoRel.split('/').pop())) {
        return `父 SPEC 未回写 related_todo：${JSON.stringify(specFm)}`
      }
      if (readFileSync(join(dir, 'docs/prd/261117-master-prd.md'), 'utf8') !== masterPrdBefore) {
        return '1:N 共享总控 PRD 元信息被 init 覆写'
      }

      // init --kind spec --prd 直接绑定已有 PRD
      const initSpecWithPrd = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'slice-b', '--title', 'Slice B', '--owner', 'arch-1',
        '--prd', 'docs/prd/261117-master-prd.md', '--in-place', '--json',
      ], { cwd: dir })
      if (initSpecWithPrd.status !== 0) return `init --kind spec --prd 失败：${initSpecWithPrd.stderr}`
      const specBRel = JSON.parse(initSpecWithPrd.stdout).file
      const specBFm = parseDocFrontmatter(readFileSync(join(dir, specBRel), 'utf8')).data
      if (specBFm.related_prd !== '../prd/261117-master-prd.md') {
        return `init --kind spec --prd 未写入 related_prd：${JSON.stringify(specBFm)}`
      }
      // 剥除模板自带的默认 C2 占位条目，确保 C2 仅由后文归档切片 S0 认领，避免掩盖对 docs/archive/specs/ 的覆盖率检测
      writeFileSync(join(dir, specBRel), readFileSync(join(dir, specBRel), 'utf8').replace(/^- \[ \] C2:.*\r?\n?/m, ''))

      // 2. doc-plan clarify 向 ## 澄清与补充记录 写入后 audit 退出 0 且不触发 BLOCKED_PENDING_DECISIONS
      const clar = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'clarify', '--file', 'docs/specs/261118-issue91-slice-a-spec.md',
        '--question', '是否支持增量输出', '--decision', '默认输出 delta 到 audit --json', '--by', 'user', '--json',
      ], { cwd: dir })
      if (clar.status !== 0) return `doc-plan clarify 失败：${clar.stderr}`
      const audClar = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'audit', '--file', 'docs/specs/261118-issue91-slice-a-spec.md', '--json',
      ], { cwd: dir })
      if (audClar.status !== 0 || /BLOCKED_PENDING_DECISIONS/.test(audClar.stdout)) {
        return `clarify 后 audit 失败或误触发 BLOCKED_PENDING_DECISIONS：${audClar.stdout} ${audClar.stderr}`
      }

      // 3. 历史同 slug 归档隔离（含不同 issue / 同日 / issue: null）
      const hist1Path = join(dir, 'docs/archive/specs/261114-issue10-feat-spec.md')
      const hist2Path = join(dir, 'docs/archive/todo/261115-feat-todo.md')
      const hist3Path = join(dir, 'docs/archive/specs/261118-feat-spec.md')
      const hist1Before = readFileSync(hist1Path, 'utf8')
      const hist2Before = readFileSync(hist2Path, 'utf8')
      const hist3Before = readFileSync(hist3Path, 'utf8')

      writeFileSync(join(dir, 'docs/specs/261118-issue56-feat-spec.md'), [
        '---', 'kind: spec', 'title: "Feat 56"', 'status: approved', 'tier: L3',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 56', 'pr: null',
        'owner: planner', 'approved: true', 'implemented: false', 'related_prd: null', 'related_todo: ../todo/261118-issue56-feat-todo.md',
        '---', '', '# Feat 56', '', '## 要解决的问题', '- 修复 `src/core.mjs`', '', '## 本期不做', '- 不改外部 API', '', '## 验收标准', '- [x] C1: ok',
      ].join('\n'))
      writeFileSync(join(dir, 'docs/todo/261118-issue56-feat-todo.md'), [
        '---', 'kind: todo', 'title: "Feat 56"', 'status: active',
        'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 56', 'pr: null',
        'owner: planner', 'approved: true', 'done_at: null', 'related_prd: null', 'related_spec: ../specs/261118-issue56-feat-spec.md',
        '---', '', '# Feat 56 Todo', '', '## 本期不做', '- 不改外部 API', '', '## 验收标准', '- [x] C1: ok',
      ].join('\n'))

      const syncRes = await syncDocsLifecycle(dir, { slugOrPath: 'docs/specs/261118-issue56-feat-spec.md', issue: 56, pr: 99 })
      if (syncRes.byKind.spec !== 'docs/specs/261118-issue56-feat-spec.md' || syncRes.byKind.todo !== 'docs/todo/261118-issue56-feat-todo.md') {
        return `历史同 slug 归档隔离：syncDocsLifecycle byKind 被历史归档污染：${JSON.stringify(syncRes.byKind)}`
      }
      const archRes = await archiveCompletedDocsGroup(dir, {
        specFile: 'docs/specs/261118-issue56-feat-spec.md',
        todoFile: 'docs/todo/261118-issue56-feat-todo.md',
        issue: 56, pr: 99,
      })
      if (archRes.byKind.spec !== 'docs/archive/specs/261118-issue56-feat-spec.md' || archRes.byKind.todo !== 'docs/archive/todo/261118-issue56-feat-todo.md') {
        return `历史同 slug 归档隔离：archiveCompletedDocsGroup byKind 返回了历史旧路径：${JSON.stringify(archRes.byKind)}`
      }
      if (readFileSync(hist1Path, 'utf8') !== hist1Before || readFileSync(hist2Path, 'utf8') !== hist2Before || readFileSync(hist3Path, 'utf8') !== hist3Before) {
        return '历史同 slug 归档隔离：docs/archive/ 下的历史同 slug 文档被改写'
      }

      // 4. checkMasterPrdCoverage 扫描指向当前总控 PRD 的已归档切片 SPEC，并排除无关历史归档
      writeFileSync(join(dir, 'docs/archive/specs/261117-issue90-s0-spec.md'), [
        '---', 'kind: spec', 'title: "S0"', 'status: implemented', 'issue: 90',
        'related_prd: ../../prd/261117-master-prd.md',
        '---', '', '# S0', '', '- [x] C2: 已归档认领 C2',
      ].join('\n'))
      // C3 仅在 related_prd: null 的旧归档里出现 -> 必须依然报 C3 缺失（防假绿）
      const covWithGap = checkMasterPrdCoverage(dir, { prdRel: 'docs/prd/261117-master-prd.md' })
      if (covWithGap.length !== 1 || covWithGap[0].missing.includes('C1') || covWithGap[0].missing.includes('C2') || !covWithGap[0].missing.includes('C3')) {
        return `checkMasterPrdCoverage 扫描已归档关联 SPEC 失败或被无关旧归档假绿：${JSON.stringify(covWithGap)}`
      }
      // 补齐 C3 到关联 SPEC 后覆盖率恢复 0 错误
      const sbPath = join(dir, specBRel)
      writeFileSync(sbPath, readFileSync(sbPath, 'utf8').replace('- [ ] C1:', '- [ ] C3:'))
      const covFull = checkMasterPrdCoverage(dir, { prdRel: 'docs/prd/261117-master-prd.md' })
      if (covFull.length !== 0) return `checkMasterPrdCoverage 全覆盖后仍误报：${JSON.stringify(covFull)}`

      // 本仓真实总控 PRD 覆盖率（含已归档切片）必须 0 漏项；分波次多切片且尚处 hold-staged 的总控 PRD 除外
      const { evaluateMasterPrdClosureState } = await import('../../kit/skills/lib/doc-substantive.mjs')
      const selfCov = checkMasterPrdCoverage(SKILL_ROOT).filter((item) => {
        const closure = evaluateMasterPrdClosureState(SKILL_ROOT, item.file)
        return !(closure.isMasterPrd && (closure.state === 'hold-staged' || closure.state === 'hold-manual-or-active'))
      })
      if (selfCov.length !== 0) {
        return `checkMasterPrdCoverage 扫描已归档关联 SPEC：本仓真实总控 PRD 仍有漏项：${JSON.stringify(selfCov)}`
      }

      return true
    } finally { rmTree(dir) }
  }])
}
