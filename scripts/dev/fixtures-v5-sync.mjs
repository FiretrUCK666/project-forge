import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerV5SyncCases(cases) {
cases.push(['耦合文件自同步门禁 Wave 7 (C29)：AGENTS 改哪看哪解析、单边触发告警、--strict-sync 阻断与全同步放行', async () => {
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
    const startRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c29-t1', '--case', '2', '--slug', 'api-sync', '--dir', dir])
    if (startRes.status !== 0) return `flow.mjs start 失败：${startRes.stderr}`

    writeFileSync(join(dir, 'src/api.mjs'), 'export const version = 2\n')
    spawnSync('git', ['add', 'src/api.mjs'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'update api only'], { cwd: dir, stdio: 'ignore' })

    const triageOne = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['triage', '--dir', dir, '--summary', 'update api', '--paths', 'src/api.mjs', '--json'])
    if (triageOne.status !== 0) return `doc-plan.mjs triage 失败：${triageOne.stderr}`
    const triageOneJson = JSON.parse(triageOne.stdout)
    if ((triageOneJson.coupledSyncWarnings?.length ?? 0) !== 1 || !triageOneJson.coupledSyncWarnings[0].expectedCompanions.includes('docs/api.md')) {
      return `doc-plan.mjs triage 单边未输出 coupledSyncWarnings：${JSON.stringify(triageOneJson)}`
    }

    const packJsonRes = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', dir, '--base', 'master', '--json'])
    if (packJsonRes.status !== 0) return `review-pack.mjs --json 失败：${packJsonRes.stderr}`
    const packJson = JSON.parse(packJsonRes.stdout)
    if ((packJson.coupledSyncWarnings?.length ?? 0) !== 1) {
      return `review-pack.mjs --json 未输出 coupledSyncWarnings：${JSON.stringify(packJson.coupledSyncWarnings)}`
    }
    const packMdRes = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', dir, '--base', 'master'])
    if (packMdRes.status !== 0 || !packMdRes.stdout.includes('## 联动同步核对（改哪看哪）') || !packMdRes.stdout.includes('docs/api.md')) {
      return `review-pack.mjs Markdown 缺少联动同步核对节：\n${packMdRes.stdout}`
    }

    const finJsonRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--dir', dir, '--json'])
    if (finJsonRes.status !== 0) return `flow.mjs finalize --json 失败：${finJsonRes.stderr}`
    const finJson = JSON.parse(finJsonRes.stdout)
    if ((finJson.coupledSyncWarnings?.length ?? 0) !== 1) {
      return `flow.mjs finalize --json 未输出 coupledSyncWarnings：${JSON.stringify(finJson)}`
    }

    const strictFail = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--strict-sync', '--dir', dir])
    if (strictFail.status === 0 || !strictFail.stderr.includes('BLOCKED_COUPLED_SYNC')) {
      return `flow.mjs finalize --strict-sync 未阻断单边改动：exit=${strictFail.status}, err=${strictFail.stderr}`
    }

    // 反面：补齐伴随文件 docs/api.md 后，三处工具均应 0 告警且 --strict-sync 放行
    writeFileSync(join(dir, 'docs/api.md'), '# API\n\nUpdated version 2.\n')
    spawnSync('git', ['add', 'docs/api.md'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'sync api docs'], { cwd: dir, stdio: 'ignore' })

    const triageSynced = JSON.parse(runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['triage', '--dir', dir, '--summary', 'update api', '--paths', 'src/api.mjs,docs/api.md', '--json']).stdout)
    if ((triageSynced.coupledSyncWarnings?.length ?? 0) !== 0) {
      return `doc-plan.mjs triage 配对同步后仍误报：${JSON.stringify(triageSynced.coupledSyncWarnings)}`
    }
    const packSynced = JSON.parse(runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--dir', dir, '--base', 'master', '--json']).stdout)
    if ((packSynced.coupledSyncWarnings?.length ?? 0) !== 0) {
      return `review-pack.mjs 配对同步后仍误报：${JSON.stringify(packSynced.coupledSyncWarnings)}`
    }
    const strictPass = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'c29-t1', '--strict-sync', '--dir', dir, '--json'])
    if (strictPass.status !== 0 || (JSON.parse(strictPass.stdout).coupledSyncWarnings?.length ?? 0) !== 0) {
      return `flow.mjs finalize 配对同步后未放行：exit=${strictPass.status}, out=${strictPass.stdout}, err=${strictPass.stderr}`
    }

    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['统一 YAML Frontmatter 与文档命名生命周期 Wave 7 (C30)：init/link/flow start 自动重命名、audit 拦截与旧格式兼容', async () => {
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
    const initAuth = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--dir', dir, '--kind', 'pair', '--slug', 'auth', '--title', 'Auth Flow', '--json'])
    if (initAuth.status !== 0) return `doc-plan init pair 失败：${initAuth.stderr}`
    const authJson = JSON.parse(initAuth.stdout)
    const authSpec = authJson.files.find((f) => f.endsWith('-auth-spec.md'))
    const authTodo = authJson.files.find((f) => f.endsWith('-auth-todo.md'))
    if (!authSpec || !authTodo) return `init --kind pair 命名不符合标准：${JSON.stringify(authJson.files)}`
    fillGeneratedDoc(join(dir, authSpec))
    fillGeneratedDoc(join(dir, authTodo))

    const linkAuth = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['link', 'auth', '--issue', '42', '--dir', dir, '--json'])
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
    const auditAuth = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--dir', dir])
    if (auditAuth.status !== 0) return `link 后 doc-plan audit . 失败：\n${auditAuth.stdout}\n${auditAuth.stderr}`

    // 第二组文档提交后，由 flow.mjs start --issue 77 在工作位触发协同重命名
    const initBill = JSON.parse(runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--dir', dir, '--kind', 'pair', '--slug', 'billing', '--title', 'Billing Flow', '--json']).stdout)
    const billSpec = initBill.files.find((f) => f.endsWith('-billing-spec.md'))
    const billTodo = initBill.files.find((f) => f.endsWith('-billing-todo.md'))
    fillGeneratedDoc(join(dir, billSpec))
    fillGeneratedDoc(join(dir, billTodo))
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'add auth42 and billing docs'], { cwd: dir, stdio: 'ignore' })

    const flowStart = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c30-bill', '--case', '3', '--slug', 'billing', '--issue', '77', '--spec', billSpec, '--todo', billTodo, '--dir', dir, '--json'])
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
    const badPlanAudit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', 'docs/specs/261114-bad-status-spec.md', '--dir', badDir, '--json'])
    if (badPlanAudit.status === 0) return `doc-plan.mjs audit 未拦截非法 status/悬空 link/issue 脱节`
    const badPlanJson = JSON.parse(badPlanAudit.stdout)
    const codes = new Set((badPlanJson.errors ?? []).map((e) => e.code))
    if (!codes.has('INVALID_STATUS')) {
      return `doc-plan.mjs audit 未报 INVALID_STATUS：${JSON.stringify(badPlanJson.errors)}`
    }

    const badGovRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', badDir, '--json'])
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

cases.push(['测试分层控频与反膨胀治理 Wave 7 (C31)：tests.* 正反双向检出、high-risk 核对与 flow verify {target} 替换', async () => {
  const posDir = tmpProject({
    'package.json': '{"name":"c31-pos","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'AGENTS.md': [
      '# c31-pos 契约',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: node --test',
      'full-test: node --test',
      'smoke-verify: node {target}',
      'merge-gate: node --test',
      'arch-rules: none',
      'high-risk: nonexistent/ghost-dir/',
      'do-not-edit: none',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const ok = true\n',
    'test/sleep.test.mjs': "import assert from 'node:assert/strict'\nawait new Promise((r) => setTimeout(r, 1500))\nassert.ok(true)\n",
    'test/heavy.test.mjs': "import '@playwright/test'\nimport assert from 'node:assert/strict'\nassert.ok(true)\n",
    'test/mockonly.test.mjs': "const f1 = vi.fn(); const f2 = vi.fn(); const f3 = vi.fn(); const f4 = vi.fn(); const f5 = vi.fn();\nexpect(f1).toHaveBeenCalled()\n",
    'tests/e2e/ui.e2e.test.mjs': "import { chromium } from '@playwright/test'\nimport assert from 'node:assert/strict'\nawait chromium.launch({ headless: false })\nassert.ok(true)\n",
    'test/sub.test.mjs': "console.log('TARGET_INTERPOLATED_OK')\n",
  })

  const negDir = tmpProject({
    'package.json': '{"name":"c31-neg","version":"1.0.0","scripts":{"test":"node --test","gate":"node --test"}}\n',
    '.github/workflows/ci.yml': [
      'name: ci',
      'on: [push]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm test',
      '',
    ].join('\n'),
    'AGENTS.md': [
      '# c31-neg 契约',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: node --test {target}',
      'full-test: node --test',
      'smoke-verify: node --test',
      'merge-gate: npm run gate',
      'arch-rules: none',
      'high-risk: src/core.mjs',
      'do-not-edit: none',
      '```',
      '',
    ].join('\n'),
    'src/core.mjs': 'export function add(a, b) { return a + b }\n',
    'test/clean-unit.test.mjs': [
      "import assert from 'node:assert/strict'",
      "import { add } from '../src/core.mjs'",
      'await new Promise((r) => setTimeout(r, 20))',
      'const f1 = vi.fn(); const f2 = vi.fn(); const f3 = vi.fn(); const f4 = vi.fn(); const f5 = vi.fn();',
      'f1()',
      'expect(f1).toHaveBeenCalled()',
      'assert.strictEqual(add(1, 2), 3)',
      '',
    ].join('\n'),
    'tests/e2e/clean.e2e.test.mjs': [
      "import { chromium } from '@playwright/test'",
      "import assert from 'node:assert/strict'",
      'await chromium.launch({ headless: true })',
      'assert.ok(true)',
      '',
    ].join('\n'),
  })

  try {
    gitInit(posDir)
    const posRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', posDir, '--json'])
    if (posRes.status !== 0) return `govern-audit posDir 失败：${posRes.stderr}`
    const posJson = JSON.parse(posRes.stdout)
    const posIds = (posJson.findings ?? []).map((f) => f.id)

    for (const exactId of [
      'tests.no-ci-config',
      'tests.collapsed-tiers',
      'tests.hard-sleep.test/sleep.test.mjs',
      'tests.heavy-in-unit.test/heavy.test.mjs',
      'tests.mock-tautology.test/mockonly.test.mjs',
      'tests.non-headless.tests/e2e/ui.e2e.test.mjs',
      'docs.devprofile-unmatched-high-risk.nonexistent/ghost-dir/',
    ]) {
      if (!posIds.includes(exactId)) {
        return `未检出 ${exactId}：${JSON.stringify(posIds)}`
      }
    }

    // 测试 flow verify --tier quick --target <path> 替换 {target}
    writeFileSync(join(posDir, 'AGENTS.md'), [
      '# c31-pos',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: node {target}',
      'full-test: node --test',
      'smoke-verify: node {target}',
      'merge-gate: node --test',
      '```',
      '',
    ].join('\n'))
    spawnSync('git', ['add', 'AGENTS.md'], { cwd: posDir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'add quick-test target'], { cwd: posDir, stdio: 'ignore' })
    const startVerify = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c31-v1', '--case', '1', '--slug', 'verify-target', '--dir', posDir])
    if (startVerify.status !== 0) return `flow start c31-v1 失败：${startVerify.stderr}`
    const verTargetRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'c31-v1', '--tier', 'quick', '--target', 'test/sub.test.mjs', '--dir', posDir])
    if (verTargetRes.status !== 0 || !verTargetRes.stdout.includes('TARGET_INTERPOLATED_OK')) {
      return `flow verify --tier quick --target 未替换执行 {target}：exit=${verTargetRes.status}, out=${verTargetRes.stdout}, err=${verTargetRes.stderr}`
    }

    // 反面：干净分层仓应零 tests.* 与零 high-risk 误报
    gitInit(negDir)
    const negRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', negDir, '--json'])
    if (negRes.status !== 0) return `govern-audit negDir 失败：${negRes.stderr}`
    const negIds = (JSON.parse(negRes.stdout).findings ?? []).map((f) => f.id)
    const badNeg = negIds.filter((id) => id.startsWith('tests.') || id.startsWith('docs.devprofile-unmatched-high-risk.'))
    if (badNeg.length > 0) {
      return `干净分层仓出现误报：${JSON.stringify(badNeg)}`
    }

    return true
  } finally {
    rmTree(posDir)
    rmTree(negDir)
  }
}])

}
