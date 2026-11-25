/**
 * fixtures-r6b-plan.mjs —— R6B（C5..C8 + A1）单源规划索引、双向正文投影、指针简报与永恒客观底线正反回归夹具。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildContextBrief } from '../../kit/skills/lib/context-brief.mjs'
import { buildCritiqueScope } from '../../kit/skills/lib/critique-rounds.mjs'
import { persistPlanCritiqueEntrySync } from '../../kit/skills/lib/critique-store.mjs'
import { checkCoreSubstantiveness, checkDocRegression, extractDocSnapshot, resolveBaselineSnapshotSync } from '../../kit/skills/lib/doc-substantive.mjs'
import { collectPlanDocs } from '../../kit/skills/lib/doc-slice-graph.mjs'
import { syncDocsLifecycle } from '../../kit/skills/lib/docs.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { evaluatePlanNextState } from '../../kit/skills/lib/plan-next.mjs'
import { buildSessionOrientation } from '../../kit/skills/lib/session-orient.mjs'
import { PRE_INIT_MAX_BYTES, appendPreInitNote, readPreInitState } from '../../kit/skills/lib/session-state.mjs'
import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import { approveSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { listDocs } from '../../kit/skills/dev-plan/scripts/doc-audit-repo.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

function makeSubstantiveSpec({
  title = 'Demo Spec', status = 'draft', owner = 'plan-a', taskId = 't-demo',
  issue = null, relatedTodo = null, extraDesignLines = [], extraCriteria = [],
} = {}) {
  const designLines = extraDesignLines.length > 0
    ? extraDesignLines
    : ['- 在 `src/app.mjs` 实现核心逻辑并导出 `runApp`。']
  const criteria = [
    '- [ ] C1: 运行 `node src/app.mjs` 退出码为 0',
    '- [ ] C2: 异常输入返回明确错误码',
    ...extraCriteria,
  ]
  return [
    '---',
    'kind: spec',
    `title: "${title}"`,
    `status: ${status}`,
    'tier: L3',
    'created: 2026-11-20',
    'updated: 2026-11-20',
    `issue: ${issue ?? 'null'}`,
    'pr: null',
    `branch: feat/${taskId}`,
    `owner: ${owner}`,
    'plan_mode: interactive',
    `approved: ${status === 'approved' || status === 'implemented'}`,
    `implemented: ${status === 'implemented'}`,
    'plan_critique: pending',
    'related_prd: null',
    `related_todo: ${relatedTodo ?? 'null'}`,
    `task_id: ${taskId}`,
    'scope_files: [src/app.mjs]',
    'depends_on: []',
    '---',
    '',
    `# ${title} — 功能设计规范（SPEC）`,
    '',
    '## 文档信息与变更概览',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 当前状态 | \`${status}\`（\`draft \\| approved \\| implemented\`） |`,
    '| 创建 / 更新 | `2026-11-20` / `2026-11-20` |',
    `| 分支 / Issue / PR | \`feat/${taskId}\` / ${issue ? `#${issue}` : '未关联'} / 未关联 |`,
    `| 负责人 / 内审状态 | ${owner} / \`pending\` |`,
    `| 关联 PRD / Todo | 未关联 / ${relatedTodo ? `\`${relatedTodo}\`` : '未关联'} |`,
    '',
    '## 一、背景与边界声明',
    '',
    '- **要改什么**：修改 `src/app.mjs` 处理入口逻辑。',
    '- **本期不做**：不修改 `README.md`。',
    '- **复用既有模块**：复用 `src/helper.mjs`。',
    '',
    '## 二、设计方案与契约变更',
    '',
    ...designLines,
    '',
    '## 三、冻结的验收标准',
    '',
    ...criteria,
    '',
    '## 四、门型与回滚路径',
    '',
    '- **门型与回滚路径**：two-way；使用 `git revert` 回退。',
    '',
  ].join('\n')
}

function makeTodo({
  title = 'Demo Todo', status = 'draft', owner = 'plan-a', taskId = 't-demo',
  issue = null, relatedSpec = null,
} = {}) {
  return [
    '---',
    'kind: todo',
    `title: "${title}"`,
    `status: ${status}`,
    'created: 2026-11-20',
    'updated: 2026-11-20',
    `issue: ${issue ?? 'null'}`,
    'pr: null',
    `branch: feat/${taskId}`,
    `owner: ${owner}`,
    'plan_mode: interactive',
    'approved: false',
    'done_at: null',
    `task_id: ${taskId}`,
    'planned_at: "abc1234"',
    'related_prd: null',
    `related_spec: ${relatedSpec ?? 'null'}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## 文档信息与范围概览',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 当前状态 | \`${status}\` |`,
    '| 建单 / 更新 | `2026-11-20` / `2026-11-20` |',
    `| 分支 / 基线 | \`feat/${taskId}\` @ \`abc1234\` |`,
    `| 任务编号 | \`${taskId}\` |`,
    `| 负责人 / 审批 | ${owner} / \`false\` |`,
    `| 关联 Issue / PR / SPEC | ${issue ? `#${issue}` : '未关联'} / 未关联 / ${relatedSpec ? `\`${relatedSpec}\`` : '按需关联'} |`,
    '',
    '## 任务范围与验证基准',
    '',
    '- **影响路径**：`src/app.mjs`、`src/helper.mjs`、`src/extra.mjs`',
    '- **本期不做**：不修改 `README.md`',
    '- **门型与回滚路径**：two-way；使用 `git revert` 回退',
    '- **快测命令**：`node --version`',
    '',
    '## 验收标准与执行清单',
    '',
    '- [ ] C1: 运行 `node src/app.mjs` 退出码 0',
    '- [ ] C2: 校验 `src/helper.mjs` 边界分支',
    '- [ ] C3: 校验 `src/extra.mjs` 负向错误返回',
    '',
    '## 断点与遗留决策',
    '',
    '- **当前状态**：`进行中`（接手人先查本行与关联分支最新提交）',
    '- **待拍板事项**：无',
    '',
  ].join('\n')
}

export function registerR6bPlanCases(cases) {
  cases.push(['R6B C5：唯一 plan-index 消除反向依赖、跨天异名拦截 BLOCKED_DUPLICATE_PLAN_DOC 及 session-orient 状态识别', async () => {
    // 1. 静态架构边界：kit/skills/lib/ 不得静态导入 dev-*/scripts/
    const libDir = join(SKILL_ROOT, 'kit/skills/lib')
    for (const file of readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
      const txt = readFileSync(join(libDir, file), 'utf8')
      if (/from\s+['"][^'"]*\/dev-[^/'"]+\/scripts\//.test(txt)) {
        return `kit/skills/lib/${file} 仍存在反向导入技能入口`
      }
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: node --version\nfull-test: node --version\nsmoke-verify: none\nmerge-gate: node --version\n```\n',
      'src/app.mjs': 'export const runApp = () => 0\n',
      'src/helper.mjs': 'export const h = () => 1\n',
      'src/extra.mjs': 'export const e = () => 2\n',
      'docs/specs/261120-issue999-alpha-spec.md': makeSubstantiveSpec({ title: 'Alpha', status: 'draft', issue: 999, taskId: 'alpha-t' }),
      'docs/prd/261120-review-prd.md': [
        '---', 'kind: prd', 'title: InReviewPRD', 'status: in_review', 'created: 2026-11-20', 'updated: 2026-11-20', 'owner: p', '---',
        '# PRD: InReview', '', '## 一、要解决的问题', '- 覆盖 `src/app.mjs`', '', '## 二、本期不做', '- 不动 `README.md`', '', '- [ ] C1: `node src/app.mjs`',
      ].join('\n'),
      'docs/archive/specs/261110-done-spec.md': makeSubstantiveSpec({ title: 'DoneSpec', status: 'done', taskId: 'done-t' }),
      'docs/specs/261115-archived-spec.md': makeSubstantiveSpec({ title: 'ArchSpec', status: 'archived', taskId: 'arch-t' }),
      'docs/specs/261118-inert-issue-spec.md': makeSubstantiveSpec({ title: 'InertIssue', status: 'superseded', issue: 888, taskId: 'inert-t' }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r6b.test' })
    try {
      // 2. collectPlanDocs 与 listDocs 均由 plan-index.mjs 单源输出
      const collected = collectPlanDocs(dir)
      const listed = listDocs(dir)
      if (!collected.some((d) => d.rel.endsWith('261120-issue999-alpha-spec.md')) || !collected.some((d) => d.archived)) {
        return `collectPlanDocs 未索引活跃与归档文档：${JSON.stringify(collected.map((d) => d.rel))}`
      }
      if (listed.specs.length < 2 || listed.archived.length < 1) {
        return `listDocs 摘要结果异常：${JSON.stringify(listed)}`
      }

      // 3. session-orient 正确识别 in_review PRD 与 done/archived SPEC，不误标未批准；draft SPEC 仍标未批准
      const orient = buildSessionOrientation(dir)
      if (orient.stuck.some((s) => (s.file.includes('review-prd') || s.file.includes('archived-spec')) && s.why.includes('未批准'))) {
        return `session-orient 误把 in_review PRD 或 archived SPEC 判成未批准：${JSON.stringify(orient.stuck)}`
      }
      if (!orient.stuck.some((s) => s.file.includes('alpha-spec') && s.why.includes('未批准'))) {
        return `session-orient 漏报 draft SPEC 未批准：${JSON.stringify(orient.stuck)}`
      }

      // 4. 反向拦截：跨天且换 --slug 重复建同 issue 999 SPEC 必须报 BLOCKED_DUPLICATE_PLAN_DOC (exit 3)
      const dupIssueRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'beta-renamed', '--issue', '999', '--title', 'Dup Issue', '--owner', 'plan-a', '--in-place', '--json',
      ], { cwd: dir })
      if (dupIssueRun.status !== 3 || !dupIssueRun.stdout.includes('BLOCKED_DUPLICATE_PLAN_DOC')) {
        return `跨天换 slug 重复建 issue 999 未阻断 BLOCKED_DUPLICATE_PLAN_DOC：exit=${dupIssueRun.status} out=${dupIssueRun.stdout}`
      }
      const dupJson = JSON.parse(dupIssueRun.stdout)
      if (!String(dupJson.takeoverCommand ?? '').includes('flow.mjs')) {
        return `BLOCKED_DUPLICATE_PLAN_DOC 缺少 flow.mjs start 接手指令：${dupIssueRun.stdout}`
      }

      // 5. 反向拦截：同 slug 跨天重复建同 kind SPEC 必阻断
      const dupSlugRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'alpha', '--title', 'Dup Slug', '--owner', 'plan-a', '--in-place', '--json',
      ], { cwd: dir })
      if (dupSlugRun.status !== 3 || !dupSlugRun.stdout.includes('BLOCKED_DUPLICATE_PLAN_DOC')) {
        return `同 slug 跨天重复建 SPEC 未阻断：exit=${dupSlugRun.status} out=${dupSlugRun.stdout}`
      }

      // 6. 正向放行：a) 为同一 issue/slug 补建配套 Todo 允许；b) inert(superseded) issue 888 允许；c) --force 允许
      const companionTodo = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'alpha', '--issue', '999', '--title', 'Alpha Todo', '--owner', 'plan-a', '--in-place', '--json',
      ], { cwd: dir })
      if (companionTodo.status !== 0) return `配套 todo 建档被误杀：${companionTodo.stdout}${companionTodo.stderr}`
      const inertReuse = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'new-888', '--issue', '888', '--title', 'Reuse 888', '--owner', 'plan-a', '--in-place', '--json',
      ], { cwd: dir })
      if (inertReuse.status !== 0) return `已取代 superseded 文档的 issue 888 仍被误拦截：${inertReuse.stdout}`
      const forceRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'beta-force', '--issue', '999', '--title', 'Force 999', '--owner', 'plan-a', '--in-place', '--force', '--json',
      ], { cwd: dir })
      if (forceRun.status !== 0) return `--force 显式重建未放行：${forceRun.stdout}`

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['R6B C6 + A1：approveSpec 原子联动 Todo active、syncPlanDocBodyMeta 双向投影与 Case 3 自检直通', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\n---\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: node --version\nfull-test: node --version\nsmoke-verify: none\nmerge-gate: node --version\n```\n',
      'src/app.mjs': 'export const runApp = () => 0\n',
      'src/helper.mjs': 'export const h = () => 1\n',
      'src/extra.mjs': 'export const e = () => 2\n',
      'docs/specs/261120-link-spec.md': makeSubstantiveSpec({
        title: 'LinkSpec', status: 'draft', taskId: 'link-t', relatedTodo: '../todo/261120-link-todo.md',
      }),
      'docs/todo/261120-link-todo.md': makeTodo({
        title: 'LinkTodo', status: 'draft', taskId: 'link-t', relatedSpec: '../specs/261120-link-spec.md',
      }),
      'docs/todo/261120-unrelated-todo.md': makeTodo({
        title: 'UnrelatedTodo', status: 'draft', taskId: 'other-t',
      }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r6b-c6.test' })
    try {
      // 1. A1: 非平凡 Case 3 Todo 审核通过后直通 dev-flow start，提示 Critique 仅建议不强制
      const todoAud = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'audit', '--file', 'docs/todo/261120-unrelated-todo.md',
      ], { cwd: dir })
      if (todoAud.status !== 0 || !todoAud.stdout.includes('自检直通') || !todoAud.stdout.includes('flow.mjs" start')) {
        return `A1 非平凡 Case 3 Todo 未输出自检直通指引：exit=${todoAud.status} out=${todoAud.stdout}`
      }

      // 2. SPEC critique-pass 后 approveSpec：SPEC 变 approved，配套 Todo 原子变 active 且正文表同步
      const cp = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', 'docs/specs/261120-link-spec.md', '--reviewer', 'critic-b', '--round', '1', '--json',
      ], { cwd: dir })
      if (cp.status !== 0) return `critique-pass 失败：${cp.stdout}${cp.stderr}`

      const appRes = approveSpec({ repoRoot: dir, file: 'docs/specs/261120-link-spec.md' })
      if (appRes.status !== 'approved' || !appRes.activatedTodos?.includes('docs/todo/261120-link-todo.md')) {
        return `approveSpec 未原子激活配套 Todo：${JSON.stringify(appRes)}`
      }
      const specAfter = readFileSync(join(dir, 'docs/specs/261120-link-spec.md'), 'utf8')
      const todoAfter = readFileSync(join(dir, 'docs/todo/261120-link-todo.md'), 'utf8')
      const unrelatedAfter = readFileSync(join(dir, 'docs/todo/261120-unrelated-todo.md'), 'utf8')
      if (!/status:\s*active/.test(todoAfter) || !todoAfter.includes('| 当前状态 | `active`')) {
        return `配套 Todo Frontmatter 或正文表未同步为 active：\n${todoAfter}`
      }
      if (!specAfter.includes('| 当前状态 | `approved`') || !specAfter.includes('`passed`')) {
        return `SPEC 正文表未同步为 approved / passed：\n${specAfter}`
      }
      if (!/status:\s*draft/.test(unrelatedAfter)) {
        return `无关 Todo 被误激活：\n${unrelatedAfter}`
      }

      // 3. syncDocsLifecycle 同步更新正文表（Issue 77 + branch）
      await syncDocsLifecycle(dir, { slugOrPath: 'docs/specs/261120-link-spec.md', issue: 77, branch: 'feat/link-77' })
      const todoLinked = readFileSync(join(dir, 'docs/todo/261120-issue77-link-todo.md'), 'utf8')
      if (!todoLinked.includes('#77') || !todoLinked.includes('`feat/link-77`')) {
        return `syncDocsLifecycle 未把 issue/branch 投影到 Todo 正文表：\n${todoLinked}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['R6B C7：单源指针简报置顶 TDD、按角色裁剪、repo-map 去倾倒与 critique-scope 静态毫秒消费 findings', async () => {
    const longDesignLines = Array.from({ length: 30 }, (_, i) => `- 设计细节第 ${i + 1} 步：校验 \`src/app.mjs\`。`)
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Root\n\n```yaml\nquick-test: node -e "process.exit(1)"\nfull-test: node -e "process.exit(1)"\nsmoke-verify: none\nmerge-gate: node --version\n```\n',
      'docs/TDD.md': '# TDD\n\n## 1. 核心架构\n模块边界在 `src/app.mjs`。\n',
      'packages/p1/AGENTS.md': '# P1\n\n## P1 约定\n仅读。\n',
      'packages/p2/AGENTS.md': '# P2\n\n## P2 约定\n仅读。\n',
      'packages/p3/AGENTS.md': '# P3\n\n## P3 约定\n仅读。\n',
      'packages/p4/AGENTS.md': '# P4\n\n## P4 约定\n仅读。\n',
      'packages/p5/AGENTS.md': '# P5\n\n## P5 约定\n仅读。\n',
      'src/app.mjs': 'export const runApp = () => 0\n',
      'src/helper.mjs': 'export const h = () => 1\n',
      'docs/specs/261120-c7-spec.md': makeSubstantiveSpec({
        title: 'C7Spec', status: 'draft', taskId: 'c7-t', extraDesignLines: longDesignLines,
        extraCriteria: ['- [ ] C3: 验证 `node -e "process.exit(1)"` 在静态模式不被执行'],
      }),
      '.worktrees/.state/private-docs/c7-fork/todo.md': makeTodo({
        title: 'PrivateForkTodo', status: 'active', taskId: 'c7-fork',
      }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r6b-c7.test' })
    try {
      // 1. context-brief: TDD 置顶豁免淘汰、排除 AGENTS.md、去 per-heading locateCommand
      const brief = buildContextBrief(dir, {
        paths: ['packages/p1/src/a.mjs', 'packages/p2/src/b.mjs', 'packages/p3/src/c.mjs', 'packages/p4/src/d.mjs', 'packages/p5/src/e.mjs'],
        excludeFiles: ['docs/specs/261120-c7-spec.md'],
        maxEvergreenDocs: 4,
      })
      if (brief.evergreenToc[0]?.path !== 'docs/TDD.md') {
        return `evergreenToc 未将 docs/TDD.md 置顶豁免淘汰：${JSON.stringify(brief.evergreenToc.map((d) => d.path))}`
      }
      if (brief.evergreenToc.some((d) => d.path === 'AGENTS.md') || brief.relatedSlices.some((s) => s.relPath === 'AGENTS.md')) {
        return `contextBrief 未排除根 AGENTS.md：${JSON.stringify(brief)}`
      }
      if (brief.evergreenToc[0].headings.some((h) => 'locateCommand' in h) || !brief.evergreenToc[0].locateCommand) {
        return `evergreenToc heading 仍残留重复 locateCommand 或缺少文档级命令：${JSON.stringify(brief.evergreenToc[0])}`
      }

      // 2. repo-map --json 不含 featureMapIndex，JS 属性仍可用
      const rmObj = await generateRepoMap(dir)
      if (!rmObj.featureMapIndex || 'featureMapIndex' in JSON.parse(JSON.stringify(rmObj))) {
        return 'repo-map JSON 序列化仍泄漏 featureMapIndex 或 JS 属性缺失'
      }
      const rmCli = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', ['--json'], { cwd: dir })
      if (rmCli.status !== 0 || 'featureMapIndex' in JSON.parse(rmCli.stdout)) {
        return `repo-map --json 输出仍含 featureMapIndex：status=${rmCli.status}`
      }

      // 3. handoff-package 按角色裁剪 + Fork 私有文档 + 全局单份 contextBrief
      const exploreHp = buildHandoff({
        mainRoot: dir,
        role: 'explore',
        ledger: { taskId: 'c7-t', specFile: 'docs/specs/261120-c7-spec.md', branch: 'feat/c7-t', baseBranch: 'main' },
      })
      if (exploreHp.fields.design || exploreHp.prompt.includes('## 怎么做')) {
        return `explore 角色交接包误注入了 SPEC 设计正文：\n${exploreHp.prompt}`
      }
      const criticHp = buildHandoff({
        mainRoot: dir,
        role: 'critic',
        ledger: { taskId: 'c7-t', specFile: 'docs/specs/261120-c7-spec.md', branch: 'feat/c7-t', baseBranch: 'main' },
      })
      if (criticHp.fields.design || criticHp.prompt.includes('## 怎么做')) {
        return `critic 角色交接包误注入了 SPEC 设计正文：\n${criticHp.prompt}`
      }
      const implHp = buildHandoff({
        mainRoot: dir,
        role: 'implementer',
        ledger: { taskId: 'c7-t', specFile: 'docs/specs/261120-c7-spec.md', branch: 'feat/c7-t', baseBranch: 'main' },
      })
      if (!implHp.prompt.includes('doc-locate.mjs --file "docs/specs/261120-c7-spec.md" --section "二、设计方案与契约变更"')
        || implHp.prompt.includes('设计细节第 25 步')) {
        return `implementer 长设计节未转为 doc-locate 指针：\n${implHp.prompt}`
      }
      const serialized = JSON.stringify(implHp)
      if ((serialized.match(/"contextBrief"/g) ?? []).length !== 1) {
        return `handoff JSON 中 contextBrief 出现次数不为 1：${serialized.slice(0, 300)}`
      }
      const forkHp = buildHandoff({
        mainRoot: dir,
        role: 'implementer',
        ledger: { taskId: 'c7-fork', privateTodoFile: '.worktrees/.state/private-docs/c7-fork/todo.md', branch: 'feat/c7-fork', baseBranch: 'main' },
      })
      if (forkHp.fields.sourceDoc !== '.worktrees/.state/private-docs/c7-fork/todo.md' || forkHp.fields.criteriaCount < 3) {
        return `handoff 未纳入 Fork privateTodoFile：${JSON.stringify(forkHp.fields)}`
      }

      // 4. critique-scope：静态默认不跑重命令（即使文档含失败命令也毫秒返回），原生回显 ledger findings & previousSha
      const rejRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-reject', '--file', 'docs/specs/261120-c7-spec.md', '--reviewer', 'critic-1', '--round', '1',
        '--findings', '缺异常边界处理', '--summary', 'R1 驳回', '--json',
      ], { cwd: dir })
      if (rejRun.status !== 3) return `critique-reject 异常：${rejRun.stdout}${rejRun.stderr}`

      const scopeRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-scope', '--file', 'docs/specs/261120-c7-spec.md', '--reviewer', 'critic-2', '--round', '2', '--json',
      ], { cwd: dir })
      if (scopeRun.status !== 0) return `critique-scope 失败：${scopeRun.stderr}`
      const scopeJson = JSON.parse(scopeRun.stdout)
      if (!scopeJson.facts?.staticOnly || scopeJson.facts?.commands?.some((c) => c.ran)) {
        return `critique-scope 默认未走静态模式或偷跑了命令：${JSON.stringify(scopeJson.facts)}`
      }
      if (!scopeJson.mustRecheck?.includes('缺异常边界处理') || !scopeJson.previousSha) {
        return `critique-scope 未原生回显 findings 或 previousSha：${JSON.stringify(scopeJson)}`
      }
      if (!scopeJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')) {
        return `critique-scope 缺少 contextBrief：${scopeRun.stdout}`
      }

      // 5. plan-next --handoff 带出 contextBrief
      const nextRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'next', '--file', 'docs/specs/261120-c7-spec.md', '--handoff', '--json',
      ], { cwd: dir })
      const nextJson = JSON.parse(nextRun.stdout)
      if (!nextJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')
        || !nextJson.handoffPrompt?.includes('docs/TDD.md')) {
        return `plan-next --handoff 缺少 contextBrief：${nextRun.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['R6B C8：preInit 有界缓冲与自动吸收、triage 继承与 --kind all、audit 跳 critique-scope 及永恒客观底线', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\n---\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: node --version\nfull-test: node --version\nsmoke-verify: none\nmerge-gate: node --version\n```\n',
      'src/app.mjs': 'export const runApp = () => 0\n',
      'src/helper.mjs': 'export const h = () => 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@r6b-c8.test' })
    try {
      // 1. preInit 有界验证（超 8KB 自动淘汰最老条目）
      for (let i = 0; i < 40; i += 1) {
        appendPreInitNote(dir, { decision: `第 ${i} 条长讨论结论：${'x'.repeat(240)}` })
      }
      const bounded = readPreInitState(dir)
      if (!bounded || Buffer.byteLength(JSON.stringify(bounded), 'utf8') > PRE_INIT_MAX_BYTES) {
        return `preInit 未控制在 ${PRE_INIT_MAX_BYTES} 字节内`
      }

      // 2. doc-plan note 追加 + triage 继承 planMode + Case 4 prdRequired 输出 --kind all + initDoc 自动吸收清空
      const noteRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'note', '--topic', '对账重构', '--decision', '幂等键保留', '--exclude', '不改老表', '--anchor', 'src/app.mjs', '--open', '重试几次?', '--json',
      ], { cwd: dir })
      if (noteRun.status !== 0) return `doc-plan note 失败：${noteRun.stderr}`

      const triPrd = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '拆成两批改造跨模块接口、CI流水线、文档与配置结构', '--files', '14', '--plan-mode', 'interactive',
      ], { cwd: dir })
      if (triPrd.status !== 0 || !triPrd.stdout.includes('--kind all')) {
        return `Case 4 prdRequired 未提示 --kind all：${triPrd.stdout}`
      }

      const nextPre = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir })
      if (!nextPre.preInit?.decisions?.includes('幂等键保留')) {
        return `plan-next 未恢复 preInit：${JSON.stringify(nextPre.preInit)}`
      }

      const initRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'pre-abs', '--title', 'PreAbsorb', '--owner', 'plan-a', '--in-place', '--json',
      ], { cwd: dir })
      if (initRes.status !== 0) return `init 失败：${initRes.stderr}`
      const initJson = JSON.parse(initRes.stdout)
      if (initJson.planMode !== 'interactive' || !initJson.absorbedPreInit?.decisions?.includes('幂等键保留')) {
        return `initDoc 未继承 planMode 或吸收 preInit：${initRes.stdout}`
      }
      const createdSpec = readFileSync(join(dir, initJson.files.find((f) => f.endsWith('-spec.md'))), 'utf8')
      if (!createdSpec.includes('幂等键保留') || !createdSpec.includes('不改老表') || !createdSpec.includes('重试几次?')) {
        return `SPEC 正文未写入 absorbed preInit 内容：\n${createdSpec}`
      }
      if (readPreInitState(dir) !== null) {
        return 'initDoc 吸收后未清空 preInit 缓冲'
      }

      // 3. audit 草稿 SPEC 后提示 critique-scope
      const specPath = 'docs/specs/261120-c8-spec.md'
      writeFileSync(join(dir, specPath), makeSubstantiveSpec({ title: 'C8Spec', status: 'draft', taskId: 'c8-t' }), 'utf8')
      const audOut = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', specPath], { cwd: dir })
      if (audOut.status !== 0 || !audOut.stdout.includes('critique-scope') || !audOut.stdout.includes('critique-pass')) {
        return `SPEC audit 后未提示 critique-scope 与 critique-pass：${audOut.stdout}`
      }

      // 4. resolveBaselineSnapshotSync 读取 plan-critique-state.json + DOC_REGRESSION_CRITERIA_DROPPED + 长自然语言零误杀
      const baseText = readFileSync(join(dir, specPath), 'utf8')
      const baseSnap = extractDocSnapshot(baseText)
      persistPlanCritiqueEntrySync({
        repoRoot: dir, mainRoot: dir, relDoc: specPath,
        entry: { rounds: [], anchors: baseSnap, updatedAt: new Date().toISOString() },
      })
      const resolvedBase = resolveBaselineSnapshotSync({ repoRoot: dir, relDoc: specPath, fmData: {} })
      if (resolvedBase.source !== 'plan-critique-state' || resolvedBase.snap?.criteriaCount !== 2) {
        return `resolveBaselineSnapshotSync 未读取 plan-critique-state.json：${JSON.stringify(resolvedBase)}`
      }

      const droppedText = baseText.replace('- [ ] C2: 异常输入返回明确错误码\n', '')
      const regDropped = checkDocRegression(resolvedBase.snap, extractDocSnapshot(droppedText), resolvedBase.source)
      if (!regDropped.errors.some((e) => e.code === 'DOC_REGRESSION_CRITERIA_DROPPED')) {
        return `删减 C* 条目未拦截 DOC_REGRESSION_CRITERIA_DROPPED：${JSON.stringify(regDropped)}`
      }

      // 反向（强模型长自然语言分析无反引号）：只带 1 个锚点但有 50 行中文推理，绝不误杀
      const longProseBody = [
        '## 一、背景与边界声明',
        '- **要改什么**：调整 `src/app.mjs` 执行流。',
        '- **本期不做**：不修改配置。',
        '## 二、设计方案与契约变更',
        '在 `src/app.mjs` 入口按三段顺序检查状态并保持向后兼容：',
        ...Array.from({ length: 50 }, (_, i) => `${i + 1}. 第 ${i + 1} 段架构推理：当上游请求进入时优先校验参数完备性，若存在未定边界则立即阻断并返回明确诊断信息。`),
      ].join('\n')
      const proseErrors = checkCoreSubstantiveness(longProseBody, 'spec')
      if (proseErrors.length > 0) {
        return `长自然语言分析被误杀：${JSON.stringify(proseErrors)}`
      }

      // 5. buildCritiqueScope 直接兼容数组型 findings
      const directScope = buildCritiqueScope({
        round: 2, currentSha: 'bbbbbbbbbbbb', previousSha: 'aaaaaaaaaaaa',
        findings: [{ round: 1, verdict: 'rejected', items: ['补充边界校验'] }],
      })
      if (!directScope.mustRecheck.includes('补充边界校验')) {
        return `buildCritiqueScope 未直接消费 findings 数组：${JSON.stringify(directScope)}`
      }

      return true
    } finally { rmTree(dir) }
  }])
}
