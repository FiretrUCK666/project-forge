/**
 * fixtures-docs.mjs —— 文档夹具：doc-plan 的评审分级与命名生命周期、文档模板口径、TDD 结构、耦合联动同步。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_ROOT, gitCommitFast, gitInit, rmTree, runAbsAsync, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerDocsCases(cases) {
cases.push(['doc-plan.mjs：critiqueTier 分级、audit 防幻觉与占位拦截、critique-pass 防篡改、approve 与豁免', async () => {
  const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
  const t3 = triageTask({ summary: 'add export flag', files: 2 })
  const t4 = triageTask({ summary: 'alter contract schema', touchesContract: true })
  if (t3.critiqueTier !== 'self-audit') return `Case 3 critiqueTier 错误：${t3.critiqueTier}`
  if (t4.critiqueTier !== 'independent-critique') return `Case 4 critiqueTier 错误：${t4.critiqueTier}`

  const dir = tmpProject({
    'src/real.mjs': 'export const ok = 1\n',
    'docs/specs/bad.md': [
      '# Bad Spec',
      '- Status: draft',
      '',
      '修改 `src/ghost.mjs` 与 `<target>`。',
    ].join('\n'),
    'docs/specs/good.md': [
      '# Good Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '改动 `src/real.mjs` 与 `src/planned.mjs` (new)。',
      '',
      '## 要解决的问题',
      '',
      '- 当前缺一份可校准的实现方案。',
      '',
      '## 本期不做',
      '',
      '- 不修改外部公共 CLI。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，直接 `git revert` 即可回滚。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: `node src/real.mjs` 退出码为 0。',
      '',
    ].join('\n'),
    'docs/specs/exempt.md': [
      '# Exempt Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '修改 `src/real.mjs`。',
      '',
      '## 要解决的问题',
      '',
      '- 走紧急豁免，补一份最小方案。',
      '',
      '## 本期不做',
      '',
      '- 不改其他模块。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，可回退。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: 验证通过。',
      '',
    ].join('\n'),
  })

  try {
    // 1. 坏 SPEC audit 与 approve 必须阻断
    const badAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/bad.md', '--json'], { cwd: dir })
    if (badAudit.status === 0) return '缺陷 SPEC 的 audit 竟通过了'
    const badJson = JSON.parse(badAudit.stdout)
    const codes = new Set(badJson.errors.map((e) => e.code))
    for (const req of ['UNRESOLVED_ANGLE_PLACEHOLDER', 'HALLUCINATED_PATH', 'MISSING_SECTION_NON_GOALS', 'MISSING_SECTION_DOOR', 'MISSING_ACCEPTANCE_CRITERIA']) {
      if (!codes.has(req)) return `坏 SPEC audit 漏报 ${req}：${badAudit.stdout}`
    }
    const badApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/bad.md'], { cwd: dir })
    if (badApprove.status === 0 || !/BLOCKED_AUDIT_FAILED/.test(badApprove.stderr)) {
      return `未通过 audit 的 SPEC 竟被 approve 放行：${badApprove.stderr}`
    }

    // 2. 好 SPEC audit 放行，但未 critique-pass 不允许直接 approve
    const goodAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (goodAudit.status !== 0) return `合规 SPEC audit 误杀：${goodAudit.stdout}\n${goodAudit.stderr}`

    const noCritApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (noCritApprove.status === 0 || !/BLOCKED_CRITIQUE_REQUIRED/.test(noCritApprove.stderr)) {
      return `未 critique-pass 的 SPEC 竟被 approve 放行：exit=${noCritApprove.status} stderr=${noCritApprove.stderr}`
    }

    // 3. critique-pass 后篡改正文 -> BLOCKED_CRITIQUE_STALE
    const crit1 = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '1', '--json'], { cwd: dir })
    if (crit1.status !== 0) return `critique-pass 失败：${crit1.stderr}`

    const goodAbs = join(dir, 'docs/specs/good.md')
    writeFileSync(goodAbs, readFileSync(goodAbs, 'utf8') + '\n- 事后偷偷追加的范围\n')
    const staleApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (staleApprove.status === 0 || !/BLOCKED_CRITIQUE_STALE/.test(staleApprove.stderr)) {
      return `critique-pass 后篡改正文未拦截：exit=${staleApprove.status} stderr=${staleApprove.stderr}`
    }

    // 4. 重审并 approve 成功；另测 --skip-critique-reason 豁免
    //    注意：Round 2 必须换复核人——同一个上下文审核完自己提的意见不算独立审。
    const sameReviewerAgain = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '2', '--json'], { cwd: dir })
    if (sameReviewerAgain.status === 0 || !/BLOCKED_CRITIQUE_SAME_REVIEWER/.test(sameReviewerAgain.stderr)) {
      return `Round 2 复用同一复核人未被拦截：exit=${sameReviewerAgain.status} stderr=${sameReviewerAgain.stderr}`
    }
    const crit2 = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r2', '--round', '2', '--json'], { cwd: dir })
    if (crit2.status !== 0) return `二次 critique-pass（换人）失败：${crit2.stderr}`
    const okApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (okApprove.status !== 0 || JSON.parse(okApprove.stdout).status !== 'approved') {
      return `复核后 approve 失败：${okApprove.stderr}`
    }

    const exApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/exempt.md', '--skip-critique-reason', 'emergency-fix', '--json'], { cwd: dir })
    if (exApprove.status !== 0 || !JSON.parse(exApprove.stdout).critiqueSkipped) {
      return `--skip-critique-reason 豁免失败：${exApprove.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['四层统一模板、中文 slug 成对归档、approve 不写非法枚举与 Mermaid 16/12 门禁', async () => {
  const { checkMermaidLabelWidth } = await import('../../kit/skills/lib/shared.mjs')
  const { syncDocsLifecycle } = await import('../../kit/skills/lib/docs.mjs')

  // 1. 常驻 .gitkeep 与 Mermaid 宽度正反双向
  for (const kp of ['docs/prd/.gitkeep', 'docs/specs/.gitkeep', 'docs/todo/.gitkeep']) {
    if (!existsSync(join(SKILL_ROOT, kp))) return `缺少常驻占位文件：${kp}`
  }
  const okMmd = checkMermaidLabelWidth('```mermaid\nflowchart LR\n  A["短节点"] -->|确认| B{"是否放行"}\n```')
  if (!okMmd.ok) return `合法短标签 Mermaid 被误报：${JSON.stringify(okMmd.violations)}`
  const badMmd = checkMermaidLabelWidth('```mermaid\nflowchart LR\n  A["这是一个非常长而且一定截断的矩形节点<br/>换行"] --> B{"超长菱形判断节点文本"}\n```')
  if (badMmd.ok || badMmd.violations.length < 3) {
    return `Mermaid 超宽/HTML 门禁未拦截：${JSON.stringify(badMmd)}`
  }

  // 2. 中文 slug + approveSpec + stripCritiqueMeta(link --issue) + 成对归档
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# doc-v6\n',
    'docs/TDD.md': '# TDD\n\n## 文档信息\n\n| 项目 | 内容 |\n| --- | --- |\n| 最近更新 | 2026-01-01 |\n',
    'src/app.mjs': 'export const a = 1\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    const initRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'init', '--kind', 'all', '--slug', '中文特性', '--title', '中文特性方案', '--json',
    ], { cwd: dir })
    if (initRes.status !== 0) return `doc-plan init all 失败：${initRes.stderr}`
    const initJson = JSON.parse(initRes.stdout)
    const specRel = initJson.files.find((f) => f.endsWith('-spec.md'))
    const todoRel = initJson.files.find((f) => f.endsWith('-todo.md'))
    const prdRel = initJson.files.find((f) => f.endsWith('-prd.md'))

    for (const rel of [specRel, todoRel, prdRel]) {
      const p = join(dir, rel)
      let txt = readFileSync(p, 'utf8')
      txt = txt.replace('<two-way | one-way>', 'two-way')
        .replace(/<[^>]+>/g, '实际值')
        .replace('- [ ] C1: 实际值', '- [x] C1: 验证 `src/app.mjs` 返回退出码 0')
        .replace('- [ ] C2: 实际值', '- [x] C2: `src/app.mjs` 导出 `a` 成立')
        .replace('<!-- 一两段说清真实用户痛点与预期可观测收益 -->', '真实用户背景。')
        .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '- 已在 src/app.mjs 实现并验证通过。')
      writeFileSync(p, txt)
    }

    const cp = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', specRel, '--reviewer', 'critic-1'], { cwd: dir })
    if (cp.status !== 0) return `critique-pass 失败：${cp.stderr}`

    // link --issue 后不应触发 BLOCKED_CRITIQUE_STALE 且中文 slug 不嵌套重复日期
    const lk = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['link', specRel, '--issue', '42', '--json'], { cwd: dir })
    if (lk.status !== 0) return `link --issue 失败：${lk.stderr}`
    const lkJson = JSON.parse(lk.stdout)
    const renamedSpec = lkJson.byKind?.spec
    if (!renamedSpec || /-26\d{4}-/.test(renamedSpec)) {
      return `中文 slug 重命名重复损坏：${renamedSpec}`
    }
    const renamedTodo = lkJson.byKind?.todo
    const apTodo = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', renamedTodo], { cwd: dir })
    if (apTodo.status !== 0) return `Todo approve 失败：${apTodo.stderr}`
    if (/^status:\s*approved/m.test(readFileSync(join(dir, renamedTodo), 'utf8'))) {
      return 'approveSpec 向 Todo 写了非法 status: approved'
    }
    const apSpec = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', renamedSpec], { cwd: dir })
    if (apSpec.status !== 0) return `link --issue 后 approveSpec 失败（误触 critique stale）：${apSpec.stderr}`

    // 成对归档：PRD / SPEC / Todo 一并移入 docs/archive/{prd,specs,todo}/ 并重算 related_* 零断链
    const arch = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['archive', renamedSpec, '--json'], { cwd: dir })
    if (arch.status !== 0) return `doc-plan archive 失败：${arch.stderr}`
    const archJson = JSON.parse(arch.stdout)
    for (const k of ['prd', 'spec', 'todo']) {
      if (!archJson.byKind?.[k]?.startsWith('docs/archive/')) return `${k} 未成对归档：${JSON.stringify(archJson.byKind)}`
    }
    const audAfter = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--json'], { cwd: dir })
    if (audAfter.status !== 0) return `归档后 doc-plan audit 断链：${audAfter.stdout} ${audAfter.stderr}`

    // syncDocsLifecycle 单遍替换防嵌套测试
    await syncDocsLifecycle(dir, { slugOrPath: archJson.byKind.spec })
    return true
  } finally { rmTree(dir) }
}])

cases.push(['统一 YAML Frontmatter 与文档命名生命周期：init/link/flow start 自动重命名、audit 拦截与旧格式兼容', async () => {
  const { parseDocFrontmatter } = await import('../../kit/skills/lib/shared.mjs')

  const fillGeneratedDoc = (absPath) => {
    let txt = readFileSync(absPath, 'utf8')
    txt = txt
      .replace(/<受影响的模块、协议或对外契约>/g, 'src/index.mjs 入口模块')
      .replace(/<明确保持兼容或本次不触碰的模块>/g, '保持对外导出兼容')
      .replace(/<先经 `dev-explore` 核实的可复用现有函数、协议或脚本入口；禁止另起炉灶>/g, '复用 src/index.mjs')
      .replace(/<对齐既有不变量与 `arch-rules`；若冲突，须先退回更新 `docs\/TDD\.md`>/g, '对齐现有架构约束')
      .replace(/<新增或调整的接口、参数、文件结构、退出码或状态流转>/g, '新增鉴权入口函数')
      .replace(/<失败时如何降级或阻断、权限校验、并发\/状态持久化保护>/g, '校验失败时返回非零错误')
      .replace(/<two-way \| one-way>/g, 'two-way')
      .replace(/<说明回退命令或反向修补方式>/g, '直接 git revert 回退')
      .replace(/<待核实填写：复用项目中已有的工具\/协议\/脚本路径，不重复造轮子>/g, '复用 src/index.mjs 既有导出')
      .replace(/<明确本期保持不动或故意延后的范围>/g, '本期不改造构建工具链')
      .replace(/<真实文件路径，新建文件标 \(new\)>/g, 'src/index.mjs')
      .replace(/<第一条可判定的标准>/g, '执行 node --test 全部通过')
      .replace(/<第二条>/g, '异常输入返回明确错误码')
      .replace(/<待核实真实路径，新建文件标 \(new\)>/g, 'src/index.mjs')
      .replace(/<待核实填写：准备复用的现成函数、库或脚本>/g, '复用 src/index.mjs')
      .replace(/<明确排除本次不顺手重构的无关事项>/g, '不调整无关构建脚本')
    writeFileSync(absPath, txt)
  }

  const dir = tmpProject({
    'package.json': '{"name":"c30-demo","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'AGENTS.md': [
      '# c30-demo 契约',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: node --test {target}',
      'full-test: node --test',
      'smoke-verify: node --test',
      'merge-gate: node --test',
      'arch-rules: none',
      'high-risk: none',
      'do-not-edit: none',
      '```',
      '',
    ].join('\n'),
    'src/index.mjs': 'export const ok = true\n',
  })

  const badDir = tmpProject({
    'package.json': '{"name":"c30-bad","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'AGENTS.md': '# c30-bad\n\n```yaml\nquick-test: node --test\nfull-test: node --test\n```\n',
    'src/index.mjs': 'export const ok = true\n',
    'test/smoke.test.mjs': "import assert from 'node:assert/strict'\nimport { ok } from '../src/index.mjs'\nassert.equal(ok, true)\n",
    'docs/specs/261114-bad-status-spec.md': [
      '---',
      'kind: spec',
      'title: "Bad Status"',
      'status: bogus_enum',
      'created: 2026-11-14',
      'updated: 2026-11-14',
      'issue: 42',
      'pr: null',
      'related_todo: ../todo/261114-missing-todo.md',
      '---',
      '',
      '# Bad Status',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: 测试',
      '',
    ].join('\n'),
    'docs/todo/261114-legacy-bullet.md': [
      '# Legacy Bullet Todo',
      '',
      '> **状态**：`active`（owner: tdd-tester）',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: 兼容旧格式',
      '',
    ].join('\n'),
  })

  try {
    gitInit(dir)
    const initAuth = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--dir', dir, '--kind', 'pair', '--slug', 'auth', '--title', 'Auth Flow', '--json'])
    if (initAuth.status !== 0) return `doc-plan init pair 失败：${initAuth.stderr}`
    const authJson = JSON.parse(initAuth.stdout)
    const authSpec = authJson.files.find((f) => f.endsWith('-auth-spec.md'))
    const authTodo = authJson.files.find((f) => f.endsWith('-auth-todo.md'))
    if (!authSpec || !authTodo) return `init --kind pair 命名不符合标准：${JSON.stringify(authJson.files)}`
    fillGeneratedDoc(join(dir, authSpec))
    fillGeneratedDoc(join(dir, authTodo))

    const linkAuth = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['link', 'auth', '--issue', '42', '--dir', dir, '--json'])
    if (linkAuth.status !== 0) return `doc-plan link 失败：${linkAuth.stderr}`
    const linkJson = JSON.parse(linkAuth.stdout)
    const renamedSpec = linkJson.byKind?.spec
    const renamedTodo = linkJson.byKind?.todo
    if (!renamedSpec?.includes('-issue42-auth-spec.md') || !renamedTodo?.includes('-issue42-auth-todo.md')) {
      return `doc-plan link 未自动重命名为 issue42 格式：${JSON.stringify(linkJson)}`
    }
    if (!existsSync(join(dir, renamedSpec)) || !existsSync(join(dir, renamedTodo)) || existsSync(join(dir, authSpec))) {
      return `doc-plan link 重命名后磁盘状态异常：${renamedSpec}, ${renamedTodo}`
    }
    const fmSpec42 = parseDocFrontmatter(readFileSync(join(dir, renamedSpec), 'utf8'))
    const fmTodo42 = parseDocFrontmatter(readFileSync(join(dir, renamedTodo), 'utf8'))
    if (fmSpec42.data.issue !== 42 || !String(fmSpec42.data.related_todo).includes('-issue42-auth-todo.md') || !String(fmTodo42.data.related_spec).includes('-issue42-auth-spec.md')) {
      return `link 后 frontmatter 或 related_* 未同步：spec=${JSON.stringify(fmSpec42.data)}, todo=${JSON.stringify(fmTodo42.data)}`
    }
    const auditAuth = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--dir', dir])
    if (auditAuth.status !== 0) return `link 后 doc-plan audit . 失败：\n${auditAuth.stdout}\n${auditAuth.stderr}`

    // 第二组文档提交后，由 flow.mjs start --issue 77 在工作位触发协同重命名
    const initBill = JSON.parse((await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--dir', dir, '--kind', 'pair', '--slug', 'billing', '--title', 'Billing Flow', '--json'])).stdout)
    const billSpec = initBill.files.find((f) => f.endsWith('-billing-spec.md'))
    const billTodo = initBill.files.find((f) => f.endsWith('-billing-todo.md'))
    fillGeneratedDoc(join(dir, billSpec))
    fillGeneratedDoc(join(dir, billTodo))
    gitCommitFast(dir, 'add auth42 and billing docs', { name: 't', email: 't@t.t' })

    const flowStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c30-bill', '--case', '3', '--slug', 'billing', '--issue', '77', '--spec', billSpec, '--todo', billTodo, '--dir', dir, '--json'])
    if (flowStart.status !== 0) return `flow.mjs start --issue 77 失败：${flowStart.stderr}`
    const ledger = JSON.parse(flowStart.stdout)
    const wtRoot = ledger.worktreePath ? join(dir, ledger.worktreePath) : dir
    if (!ledger.specFile?.includes('-issue77-billing-spec.md') || !ledger.todoFile?.includes('-issue77-billing-todo.md') || !existsSync(join(wtRoot, ledger.specFile)) || !existsSync(join(wtRoot, ledger.todoFile))) {
      return `flow.mjs start --issue 77 未同步重命名兄弟文档：${JSON.stringify(ledger)}`
    }

    // 反面：非法 status、悬空 related_spec、issue 与文件名脱节、以及旧版 bullet-header 兼容
    const legacyFm = parseDocFrontmatter(readFileSync(join(badDir, 'docs/todo/261114-legacy-bullet.md'), 'utf8'))
    if (legacyFm.hasFrontmatter || legacyFm.malformedFrontmatter || legacyFm.data.status !== 'active') {
      return `parseDocFrontmatter 未平滑兼容旧版 bullet-header：${JSON.stringify(legacyFm)}`
    }
    const badPlanAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', 'docs/specs/261114-bad-status-spec.md', '--dir', badDir, '--json'])
    if (badPlanAudit.status === 0) return `doc-plan.mjs audit 未拦截非法 status/悬空 link/issue 脱节`
    const badPlanJson = JSON.parse(badPlanAudit.stdout)
    const codes = new Set((badPlanJson.errors ?? []).map((e) => e.code))
    if (!codes.has('INVALID_STATUS')) {
      return `doc-plan.mjs audit 未报 INVALID_STATUS：${JSON.stringify(badPlanJson.errors)}`
    }

    const badGovRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', badDir, '--json'])
    if (badGovRes.status !== 0) return `govern-audit 坏文档仓运行异常：${badGovRes.stderr}`
    const badGovIds = (JSON.parse(badGovRes.stdout).findings ?? []).map((f) => f.id)
    for (const prefix of ['docs.frontmatter-invalid.', 'docs.filename-issue-mismatch.', 'docs.broken-related-link.']) {
      if (!badGovIds.some((id) => id.startsWith(prefix))) {
        return `govern-audit 未检出 ${prefix}：${JSON.stringify(badGovIds)}`
      }
    }

    return true
  } finally {
    rmTree(dir)
    rmTree(badDir)
  }
}])

cases.push(['耦合文件自同步门禁：AGENTS 改哪看哪解析、单边触发告警、--strict-sync 阻断与全同步放行', async () => {
  const { parseCoupledSyncRules, evaluateCoupledSync } = await import('../../kit/skills/lib/shared.mjs')

  const dir = tmpProject({
    'package.json': '{"name":"c29-demo","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'AGENTS.md': [
      '# c29-demo 工程契约',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: node --test {target}',
      'full-test: node --test',
      'smoke-verify: node --test',
      'merge-gate: node --test',
      'arch-rules: none',
      'high-risk: src/api.mjs',
      'do-not-edit: none',
      '```',
      '',
      '## 改哪看哪',
      '',
      '| 这次动了 | 必须一起看 |',
      '| --- | --- |',
      '| `src/api.mjs` | `docs/api.md` |',
      '| `templates/core.md` | `AGENTS.md`、`docs/optional-absent.md` |',
      '',
    ].join('\n'),
    'src/api.mjs': 'export const version = 1\n',
    'src/other.mjs': 'export const ok = true\n',
    'docs/api.md': '# API\n\nInitial version 1.\n',
    'templates/core.md': '# Core Template\n',
  })

  try {
    gitInit(dir)
    const agentsRaw = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const rules = parseCoupledSyncRules(agentsRaw)
    if (rules.length !== 2) return `parseCoupledSyncRules 解析行数异常：${JSON.stringify(rules)}`

    // 直接调用共享库：单边修改 src/api.mjs 必须告警；仅改 templates/core.md 不应误报不存在的可选伴随文件
    const wApi = evaluateCoupledSync(['src/api.mjs'], rules, dir)
    if (wApi.length !== 1 || !wApi[0].expectedCompanions.includes('docs/api.md')) {
      return `evaluateCoupledSync 单边修改未命中 docs/api.md：${JSON.stringify(wApi)}`
    }
    const wOpt = evaluateCoupledSync(['templates/core.md'], rules, dir)
    if (wOpt.length !== 1 || wOpt[0].expectedCompanions.includes('docs/optional-absent.md') || !wOpt[0].expectedCompanions.includes('AGENTS.md')) {
      return `evaluateCoupledSync 可选不存在伴随文件过滤异常：${JSON.stringify(wOpt)}`
    }
    const wBoth = evaluateCoupledSync(['src/api.mjs', 'docs/api.md'], rules, dir)
    const wUnrelated = evaluateCoupledSync(['src/other.mjs'], rules, dir)
    if (wBoth.length !== 0 || wUnrelated.length !== 0) {
      return `evaluateCoupledSync 反面全同步/无关文件误报：both=${JSON.stringify(wBoth)}, other=${JSON.stringify(wUnrelated)}`
    }

    // 启动流转分支后只修改 src/api.mjs 并提交，检验 doc-plan triage / review-pack / flow finalize
    const startRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c29-t1', '--case', '2', '--slug', 'api-sync', '--dir', dir, '--json'])
    if (startRes.status !== 0) return `flow.mjs start 失败：${startRes.stderr}`
    const c29Wt = join(dir, JSON.parse(startRes.stdout).worktreePath)

    writeFileSync(join(c29Wt, 'src/api.mjs'), 'export const version = 2\n')
    gitCommitFast(c29Wt, 'update api only', { files: ['src/api.mjs'], name: 't', email: 't@t.t' })

    const triageOne = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['triage', '--dir', c29Wt, '--summary', 'update api', '--paths', 'src/api.mjs', '--json'])
    const packJsonRes = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', c29Wt, '--base', 'master', '--json'])
    const packMdRes = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', c29Wt, '--base', 'master'])
    const finJsonRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--dir', c29Wt, '--json'])
    if (triageOne.status !== 0) return `doc-plan.mjs triage 失败：${triageOne.stderr}`
    const triageOneJson = JSON.parse(triageOne.stdout)
    if ((triageOneJson.coupledSyncWarnings?.length ?? 0) !== 1 || !triageOneJson.coupledSyncWarnings[0].expectedCompanions.includes('docs/api.md')) {
      return `doc-plan.mjs triage 单边未输出 coupledSyncWarnings：${JSON.stringify(triageOneJson)}`
    }
    if (packJsonRes.status !== 0) return `review-pack.mjs --json 失败：${packJsonRes.stderr}`
    const packJson = JSON.parse(packJsonRes.stdout)
    if ((packJson.coupledSyncWarnings?.length ?? 0) !== 1) {
      return `review-pack.mjs --json 未输出 coupledSyncWarnings：${JSON.stringify(packJson.coupledSyncWarnings)}`
    }
    if (packMdRes.status !== 0 || !packMdRes.stdout.includes('## 联动同步核对（改哪看哪）') || !packMdRes.stdout.includes('docs/api.md')) {
      return `review-pack.mjs Markdown 缺少联动同步核对节：\n${packMdRes.stdout}`
    }
    if (finJsonRes.status !== 0) return `flow.mjs finalize --json 失败：${finJsonRes.stderr}`
    const finJson = JSON.parse(finJsonRes.stdout)
    if ((finJson.coupledSyncWarnings?.length ?? 0) !== 1) {
      return `flow.mjs finalize --json 未输出 coupledSyncWarnings：${JSON.stringify(finJson)}`
    }

    const strictFail = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--strict-sync', '--dir', c29Wt])
    if (strictFail.status === 0 || !strictFail.stderr.includes('BLOCKED_COUPLED_SYNC')) {
      return `flow.mjs finalize --strict-sync 未阻断单边改动：exit=${strictFail.status}, err=${strictFail.stderr}`
    }

    // 反面：补齐伴随文件 docs/api.md 后，三处工具均应 0 告警且 --strict-sync 放行
    writeFileSync(join(c29Wt, 'docs/api.md'), '# API\n\nUpdated version 2.\n')
    gitCommitFast(c29Wt, 'sync api docs', { files: ['docs/api.md'], name: 't', email: 't@t.t' })

    const triageSynced = JSON.parse((await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['triage', '--dir', c29Wt, '--summary', 'update api', '--paths', 'src/api.mjs,docs/api.md', '--json'])).stdout)
    if ((triageSynced.coupledSyncWarnings?.length ?? 0) !== 0) {
      return `doc-plan.mjs triage 配对同步后仍误报：${JSON.stringify(triageSynced.coupledSyncWarnings)}`
    }
    const packSynced = JSON.parse((await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', c29Wt, '--base', 'master', '--json'])).stdout)
    if ((packSynced.coupledSyncWarnings?.length ?? 0) !== 0) {
      return `review-pack.mjs 配对同步后仍误报：${JSON.stringify(packSynced.coupledSyncWarnings)}`
    }
    const strictPass = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--strict-sync', '--dir', c29Wt, '--json'])
    if (strictPass.status !== 0 || (JSON.parse(strictPass.stdout).coupledSyncWarnings?.length ?? 0) !== 0) {
      return `flow.mjs finalize 配对同步后未放行：exit=${strictPass.status}, out=${strictPass.stdout}, err=${strictPass.stderr}`
    }

    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['templates/readme.md 与文档口径：HTML 注释配对、零残留占位与 tier 对齐', async () => {
  const { residualConditionMarkers } = await import('../lib/template.mjs')
  for (const relPath of ['templates/readme.md', 'templates/releasing.md', 'templates/release-notes.md']) {
    const raw = readFileSync(join(SKILL_ROOT, relPath), 'utf8')
    const opens = (raw.match(/<!--/g) ?? []).length
    const closes = (raw.match(/-->/g) ?? []).length
    if (opens === 0 || opens !== closes) return `${relPath} HTML 注释未成对闭合（open=${opens}, close=${closes}）`
  }
  const readmeTpl = readFileSync(join(SKILL_ROOT, 'templates/readme.md'), 'utf8')
  const residual = residualConditionMarkers(readmeTpl)
  const vars = [...new Set([...readmeTpl.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]))]
  if (residual.length > 0 || vars.length > 0) {
    return `templates/readme.md 残留条件或未求值变量：${JSON.stringify({ residual, vars })}`
  }
  if (!readmeTpl.includes('存量仓库严禁重写覆盖')) return 'templates/readme.md 缺少存量防覆盖约束'

  const skillMd = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
  const surveyMd = readFileSync(join(SKILL_ROOT, 'references/survey.md'), 'utf8')
  if (/\bexplorationStrategy\.mode\b/.test(skillMd) || /\bexplorationStrategy\.mode\b/.test(surveyMd)) {
    return 'SKILL.md 或 references/survey.md 仍残留过期字段 explorationStrategy.mode'
  }
  if (!skillMd.includes('explorationStrategy.tier') || !surveyMd.includes('explorationStrategy.tier')) {
    return 'SKILL.md 或 references/survey.md 缺少 explorationStrategy.tier'
  }
  return true
}])

cases.push(['通用自适应 TDD 与本仓 docs/TDD.md：目录锚点、Mermaid/arch-rules/FeatureMap 与漂移拦截', async () => {
  const { validateDocTocAnchors } = await import('./preflight.mjs')
  const { templateVarsOf } = await import('../lib/protocol.mjs')

  const tddRaw = readFileSync(join(SKILL_ROOT, 'docs/TDD.md'), 'utf8')
  const tddErrors = validateDocTocAnchors(tddRaw)
  if (tddErrors.length > 0) return `docs/TDD.md 目录锚点有误：${tddErrors.join('；')}`

  const mermaidCount = (tddRaw.match(/```mermaid\b/g) ?? []).length
  if (mermaidCount < 2 || !tddRaw.includes('flowchart') || !tddRaw.includes('stateDiagram-v2')) {
    return `docs/TDD.md Mermaid 架构/状态图缺失（count=${mermaidCount}）`
  }
  if (!/```yaml[\s\S]*?\barch-rules:[\s\S]*?->[\s\S]*?```/.test(tddRaw)) {
    return 'docs/TDD.md 缺少可执行 arch-rules yaml 块'
  }

  const mapRes = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', [SKILL_ROOT, '--json'])
  if (mapRes.status !== 0) return `repo-map.mjs --json 失败：${mapRes.stderr}`
  const mapJson = JSON.parse(mapRes.stdout)
  const tddFeatures = (mapJson.featureMap ?? []).filter((x) => x.origin === 'docs/TDD.md')
  if (tddFeatures.length < 10 || !tddFeatures.every((x) => Boolean(x.source))) {
    return `repo-map.mjs 未从 docs/TDD.md 解析出完整 Feature Map：${JSON.stringify(mapJson.featureMap)}`
  }

  const sSelf = await survey(SKILL_ROOT)
  if ((sSelf.reentry?.staleTddPaths?.length ?? 0) > 0) {
    return `本仓 docs/TDD.md 存在失效路径：${JSON.stringify(sSelf.reentry.staleTddPaths)}`
  }

  const tplRaw = readFileSync(join(SKILL_ROOT, 'templates/docs-tdd.md'), 'utf8')
  const tplErrors = validateDocTocAnchors(tplRaw)
  if (tplErrors.length > 0) return `templates/docs-tdd.md 目录锚点有误：${tplErrors.join('；')}`
  if (!tplRaw.includes('[按需保留，不适用整节删除]') || tplRaw.includes('references/') || templateVarsOf(tplRaw).length > 0) {
    return 'templates/docs-tdd.md 未满足自适应按需标记或纯净度要求'
  }

  // 反面 1：validateDocTocAnchors 必须抓出悬空锚点
  const brokenErrors = validateDocTocAnchors('## 目录\n\n- [幽灵章节](#missing-anchor)\n\n## 真实章节\n')
  if (brokenErrors.length === 0) return 'validateDocTocAnchors 未拦截失效目录锚点'

  // 反面 2：docs/TDD.md 注入幽灵路径后，survey 与 govern-audit 必须共同抓出
  const ghostDir = tmpProject({
    'package.json': '{"name":"tdd-ghost","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'README.md': '# tdd-ghost\n',
    'src/ok.mjs': 'export const ok = true\n',
    'docs/TDD.md': '# tdd-ghost TDD\n\n## 目录\n\n- [模块](#模块)\n\n## 模块\n\n正常入口：`src/ok.mjs`，幽灵路径：`src/ghost-nonexistent-module.mjs`。\n',
  })
  try {
    gitInit(ghostDir)
    const sGhost = await survey(ghostDir)
    if (!sGhost.reentry?.drifted || !sGhost.reentry?.staleTddPaths?.includes('src/ghost-nonexistent-module.mjs') || sGhost.reentry?.staleTddPaths?.includes('src/ok.mjs')) {
      return `survey 未准确识别 TDD 幽灵路径：${JSON.stringify(sGhost.reentry)}`
    }
    const auditRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', ghostDir, '--json'])
    if (auditRes.status !== 0) return `govern-audit 失败：${auditRes.stderr}`
    const auditJson = JSON.parse(auditRes.stdout)
    const hit = (auditJson.findings ?? []).some((f) => f.id === 'docs.tdd-stale-path.src/ghost-nonexistent-module.mjs')
    if (!hit) return `govern-audit 未报出 docs.tdd-stale-path：${JSON.stringify(auditJson.findings?.map((f) => f.id))}`
    return true
  } finally {
    rmTree(ghostDir)
  }
}])

cases.push(['--include-master-prd：默认仍保护 1:N 共享 PRD，显式传入检查勾选、保原元信息并写入 archivedPrdFile 放行 do-not-edit', async () => {
  const { parseDocFrontmatter, readTaskLedger, resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
  const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
  const { handleFinalize, handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
  const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')

  const makeMasterRepo = (issueNum) => tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# master-prd-test',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: exit 0',
      'merge-gate: exit 0',
      'do-not-edit: docs/archive/',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const v = 1\n',
    'docs/archive/specs/261116-issue10-m1-spec.md': [
      '---', 'kind: spec', 'title: "M1"', 'status: implemented', 'tier: L3',
      'created: 2026-11-16', 'updated: 2026-11-16', 'issue: 10', 'pr: null',
      'owner: alice', 'approved: true', 'implemented: true',
      'related_prd: ../../prd/261116-master-plan-prd.md',
      '---', '', '# SPEC: M1', '', '## 要解决的问题', '- 拆出第一个切片', '', '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way；revert', '', '## 验收标准', '- [x] C1: `src/app.mjs` ok', '',
    ].join('\n'),
    'docs/prd/261116-master-plan-prd.md': [
      '---', 'kind: prd', 'title: "Master Plan"', 'status: active',
      'created: 2026-11-16', 'updated: 2026-11-16', 'issue: null', 'pr: null',
      'owner: alice', 'plan_critique: passed', 'related_spec: null', 'related_todo: null',
      '---', '', '# PRD: Master Plan', '', '## 要解决的问题', '- 统一规划总纲', '', '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way；revert', '',
      '## 五、验收标准', '- [x] C1: `src/app.mjs` M1', '- [ ] C2: `src/app.mjs` M2', '',
    ].join('\n'),
    [`docs/specs/261116-issue${issueNum}-m2-spec.md`]: [
      '---', 'kind: spec', 'title: "M2"', 'status: approved', 'tier: L3',
      'created: 2026-11-16', 'updated: 2026-11-16', `issue: ${issueNum}`, 'pr: null',
      'branch: null', 'owner: alice', 'approved: true', 'implemented: false', 'plan_critique: passed',
      'related_prd: ../prd/261116-master-plan-prd.md',
      `related_todo: ../todo/261116-issue${issueNum}-m2-todo.md`,
      'high_risk_paths: []', '---', '', '# SPEC: M2', '', '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way；revert', '',
      '## 验收标准', '- [x] C1: `src/app.mjs` ok', '', '## 实现说明', '- 已在 `src/app.mjs` 完成。', '',
    ].join('\n'),
    [`docs/todo/261116-issue${issueNum}-m2-todo.md`]: [
      '---', 'kind: todo', 'title: "M2"', 'status: active',
      'created: 2026-11-16', 'updated: 2026-11-16', `issue: ${issueNum}`, 'pr: null',
      'branch: null', 'owner: alice', 'approved: true', 'done_at: null', 'task_id: m2',
      'planned_at: HEAD', 'related_prd: ../prd/261116-master-plan-prd.md',
      `related_spec: ../specs/261116-issue${issueNum}-m2-spec.md`,
      '---', '', '# Todo: M2', '', '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way；revert', '',
      '## 验收标准', '- [x] C1: `src/app.mjs` ok', '', '## 完成后的记录', '**在合并之前写完。**', '',
    ].join('\n'),
  })

  const dir = makeMasterRepo(11)
  const directDir = makeMasterRepo(21)

  try {
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    const roots = await resolveRepoRoots(dir)
    await handleStart({
      task: 'm2', case: '4', slug: 'm2', issue: '11',
      spec: 'docs/specs/261116-issue11-m2-spec.md', todo: 'docs/todo/261116-issue11-m2-todo.md',
      implementer: 'alice',
    }, roots)
    const wt = join(dir, readTaskLedger(dir, 'm2').worktreePath)

    // 1. 默认不传 --include-master-prd：仍守 1:N 共享 PRD，不归档且 archivedPrdFile 为 null
    const finDefault = await handleFinalize({ task: 'm2', json: true }, roots)
    if (finDefault.exitCode !== 0) return `默认 finalize 失败：${finDefault.exitCode}`
    if (!existsSync(join(wt, 'docs/prd/261116-master-plan-prd.md')) || existsSync(join(wt, 'docs/archive/prd/261116-master-plan-prd.md'))) {
      return '未传 --include-master-prd 时不应归档共享总控 PRD'
    }
    if (readTaskLedger(dir, 'm2')?.archivedPrdFile !== null) {
      return `默认归档时 archivedPrdFile 应为 null：${readTaskLedger(dir, 'm2')?.archivedPrdFile}`
    }

    // 2. 传 --include-master-prd 但主 PRD 仍有未勾选 C2 -> 必须阻断
    const finBlocked = await handleFinalize({ task: 'm2', 'include-master-prd': true }, roots)
    if (finBlocked.exitCode !== 1) {
      return `主 PRD 有未勾选条目前 --include-master-prd 未阻断：exit=${finBlocked.exitCode}`
    }

    // 3. 勾选主 PRD C2 后传 --include-master-prd（实测 CLI 透传）-> 归档总控 PRD，保原元信息，写入 archivedPrdFile 并放行 verify
    const prdPath = join(wt, 'docs/prd/261116-master-plan-prd.md')
    writeFileSync(prdPath, readFileSync(prdPath, 'utf8').replace('- [ ] C2:', '- [x] C2:'))
    const finInc = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'm2', '--include-master-prd', '--dir', wt, '--json'])
    if (finInc.status !== 0) return `--include-master-prd finalize 失败：${finInc.stderr}`
    const archivedPrdRel = 'docs/archive/prd/261116-master-plan-prd.md'
    if (existsSync(prdPath) || !existsSync(join(wt, archivedPrdRel))) {
      return '传入 --include-master-prd 后总控 PRD 未移入 docs/archive/prd/'
    }
    const prdFm = parseDocFrontmatter(readFileSync(join(wt, archivedPrdRel), 'utf8')).data
    if (prdFm.status !== 'done' || prdFm.issue !== null || prdFm.pr !== null || prdFm.branch !== undefined || prdFm.related_spec !== null || prdFm.related_todo !== null || prdFm.owner !== 'alice') {
      return `总控 PRD 归档后元信息被子切片覆盖写脏：${JSON.stringify(prdFm)}`
    }
    const ledgerAfter = readTaskLedger(dir, 'm2')
    if (ledgerAfter?.archivedPrdFile !== archivedPrdRel) {
      return `ledger.archivedPrdFile 未记录归档主 PRD：${JSON.stringify(ledgerAfter)}`
    }
    const audPrd = auditDoc({ repoRoot: wt, file: archivedPrdRel })
    if (!audPrd.ok) return `归档后总控 PRD audit 失败：${JSON.stringify(audPrd.errors)}`

    gitCommitFast(wt, 'finalize with master prd', { name: 'alice', email: 'alice@example.com' })
    const verRes = await handleVerify({ task: 'm2', mode: 'gate' }, roots)
    if (verRes.exitCode !== 0) return `archivedPrdFile 未放行 do-not-edit 拦截：exit=${verRes.exitCode}`

    // 4. 返工再次 finalize 幂等保持元信息与 archivedPrdFile
    writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 2\n')
    gitCommitFast(wt, 'rework v2', { updateOnly: true, name: 'alice', email: 'alice@example.com' })
    const finRework = await handleFinalize({ task: 'm2', 'include-master-prd': true, json: true }, roots)
    if (finRework.exitCode !== 0) return `返工重复 finalize --include-master-prd 失败：${finRework.exitCode}`
    const prdFm2 = parseDocFrontmatter(readFileSync(join(wt, archivedPrdRel), 'utf8')).data
    if (prdFm2.issue !== null || prdFm2.related_spec !== null || readTaskLedger(dir, 'm2')?.archivedPrdFile !== archivedPrdRel) {
      return `返工重复 finalize 破坏了总控 PRD 元信息或账本：fm=${JSON.stringify(prdFm2)}`
    }

    // 5. 验证 doc-plan.mjs archive --include-master-prd 独立入口
    const directPrd = join(directDir, 'docs/prd/261116-master-plan-prd.md')
    writeFileSync(directPrd, readFileSync(directPrd, 'utf8').replace('- [ ] C2:', '- [x] C2:'))
    const dpArch = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['archive', 'docs/specs/261116-issue21-m2-spec.md', '--include-master-prd', '--dir', directDir, '--json'])
    if (dpArch.status !== 0) return `doc-plan archive --include-master-prd 失败：${dpArch.stderr}`
    const dpJson = JSON.parse(dpArch.stdout)
    if (dpJson.archivedMasterPrd !== archivedPrdRel || !existsSync(join(directDir, archivedPrdRel))) {
      return `doc-plan archive --include-master-prd 返回或移动异常：${JSON.stringify(dpJson)}`
    }
    return true
  } finally {
    rmTree(dir)
    rmTree(directDir)
  }
}])

}
