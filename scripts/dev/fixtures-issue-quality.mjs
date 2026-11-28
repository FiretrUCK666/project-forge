/**
 * fixtures-issue-quality.mjs —— 单一平台中性 Issue 质量契约、富证据建单、入口拦截与 verify-tools --stale 排序断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT, blockedExitOf } from '../../kit/skills/lib/exit-codes.mjs'
import { applyIssuesToBackend, buildEscalationIssuePayload, buildIssues, escalateToBackend } from '../../kit/skills/lib/escalation.mjs'
import { hydrateIssueBody } from '../../kit/skills/lib/issue-template-hydrate.mjs'
import { equip } from '../equip.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerIssueQualityCases(cases) {
  cases.push(['C1：validateIssueBodyQuality 拦截 2 段空壳、空洞套话、空白占位与长度无关性（正反双向）', async () => {
    const { validateIssueBodyQuality, ISSUE_QUALITY_RULES } = await import('../../kit/skills/lib/issue-quality.mjs')
    if (blockedExitOf('BLOCKED_ISSUE_QUALITY_INCOMPLETE') !== EXIT.FACT) {
      return `BLOCKED_ISSUE_QUALITY_INCOMPLETE 退出码档位应为 EXIT.FACT (3)，实为 ${blockedExitOf('BLOCKED_ISSUE_QUALITY_INCOMPLETE')}`
    }
    if (!ISSUE_QUALITY_RULES || !Array.isArray(ISSUE_QUALITY_RULES.baselineItems) || ISSUE_QUALITY_RULES.baselineItems.length !== 5) {
      return `ISSUE_QUALITY_RULES 应定义 5 项结构底线：${JSON.stringify(ISSUE_QUALITY_RULES)}`
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'kit/skills/lib/cli.mjs': 'export function ok() { return true }\n',
      'templates/issue-bug-report.md': '# bug\n',
      '.github/ISSUE_TEMPLATE/bug_report.md': readFileSync(join(SKILL_ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'utf8'),
      '.github/ISSUE_TEMPLATE/feature_request.md': readFileSync(join(SKILL_ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.md'), 'utf8'),
    })
    try {
      // 反例 1：2 段空壳（仅现状 + 验收）
      const twoSec = validateIssueBodyQuality('## 现状\n登录有问题\n\n## 验收\n修复完成', { repoRoot: dir })
      if (twoSec.ok || twoSec.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE' || twoSec.exitCode !== EXIT.FACT) {
        return `2 段空壳未被 BLOCKED_ISSUE_QUALITY_INCOMPLETE (3) 拦截：${JSON.stringify(twoSec)}`
      }
      for (const req of ['impact', 'criteria', 'outOfScope']) {
        if (!twoSec.missing.includes(req)) return `2 段空壳 missing 缺少 ${req}：${JSON.stringify(twoSec)}`
      }

      // 反例 2：长篇空洞套话（>500 字符但无真实技术锚点与结构底线）
      const fluffBody = [
        '## 背景与现象',
        '当前系统需要全面优化、整体提升、改善性能、增强健壮性、优化体验、完善功能、确保稳定并做好测试。'.repeat(6),
        '## 影响面与严重度',
        '影响整体使用体验，建议合理规划、按需处理。',
        '## 期望与方案',
        '提升质量，保持正常运行。',
        '## 验收标准',
        '- [ ] C1: 体验更好，功能正常运行',
        '## 不在本次范围',
        '待补充',
      ].join('\n\n')
      const fluffRes = validateIssueBodyQuality(fluffBody, { repoRoot: dir })
      if (fluffRes.ok || fluffRes.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE') {
        return `长篇空洞套话未被拦截：${JSON.stringify(fluffRes)}`
      }

      // 反例 3：空白占位与模板未填项
      const stubBody = [
        '## 实际发生什么',
        '待补充',
        '## 影响面与严重度',
        '- 模块：TBD',
        '## 怎么复现',
        '1.\n2.\n3.',
        '## 验收标准',
        '- [ ] C1: ',
        '## 不在本次范围',
        '无',
      ].join('\n\n')
      const stubRes = validateIssueBodyQuality(stubBody, { repoRoot: dir })
      if (stubRes.ok || stubRes.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE') {
        return `空白占位未被拦截：${JSON.stringify(stubRes)}`
      }

      // 正例 1：精简短小但 5 项底线齐全的独立详单（证明无字数/字节死线）
      const conciseValid = [
        '## 背景与现象',
        '`kit/skills/lib/cli.mjs:1` 参数解析遗漏短参数边界校验。',
        '## 影响面与严重度',
        '影响模块：`kit/skills/lib/cli.mjs`；severity=medium；仅解析层，不触及数据模型、API 协议与安全边界。',
        '## 期望与方案',
        '期望复跑 `node scripts/dev/preflight.mjs` 时严格按退出码 2 阻断。',
        '## 验收标准',
        '- [ ] C1: 运行 `node scripts/dev/preflight.mjs` 返回退出码 0',
        '## 不在本次范围',
        '不动 `templates/` 目录下的骨架文件。',
      ].join('\n')
      const validRes = validateIssueBodyQuality(conciseValid, { repoRoot: dir })
      if (!validRes.ok || validRes.exitCode !== 0 || validRes.hasRealLinkedPlanDoc !== false) {
        return `精简合规独立详单应通过且无长度死线：${JSON.stringify(validRes)}`
      }

      // 正例 2 + 反例 4：hydrateIssueBody 移除空洞套话默认填充、剥离空列表，纯注释模板保底保留 rawBody
      const hydMinimal = hydrateIssueBody(dir, 'bug', {
        title: '边界崩',
        summary: '传入空值时 `kit/skills/lib/cli.mjs:1` 抛出异常。',
      })
      const hydMinimalFeat = hydrateIssueBody(dir, 'feature', {
        title: '功能扩展',
        summary: '为 `kit/skills/lib/cli.mjs:1` 增加参数校验。',
      })
      for (const banned of [
        '运行时与仓内环境见复现/验证记录',
        '按根因收敛方案实施',
        '未列入本单验收标准的无关改动',
        '见仓内关联设计文档',
        '行为与既有契约、测试门禁及工程不变量保持一致',
        '待补充说明',
      ]) {
        if (hydMinimal.includes(banned) || hydMinimalFeat.includes(banned)) {
          return `hydrateIssueBody 仍残留空洞套话「${banned}」：\n${hydMinimal}\n---\n${hydMinimalFeat}`
        }
      }
      if (/^1\.\s*$/m.test(hydMinimal) || /^- 操作系统与版本：\s*$/m.test(hydMinimal) || /^- \[ \] C1:\s*$/m.test(hydMinimal)) {
        return `hydrateIssueBody 残留空白占位行：\n${hydMinimal}`
      }
      if (validateIssueBodyQuality(hydMinimal, { repoRoot: dir }).ok) {
        return `缺影响面/验收标准/Out of Scope 的水合结果不应通过质量门禁：\n${hydMinimal}`
      }

      // 纯 HTML 注释模板保底保留 rawBody
      const commentDir = tmpProject({
        '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: Bug\n---\n<!-- only html comment -->\n',
      })
      try {
        const preserved = hydrateIssueBody(commentDir, 'bug', { rawBody: 'RAW_EXPLICIT_CONTEXT_KEEP\n`kit/a.mjs:10`' })
        if (!preserved.includes('RAW_EXPLICIT_CONTEXT_KEEP') || preserved.includes('only html comment')) {
          return `纯 HTML 注释模板保底丢失 rawBody 或未剥注释：\n${preserved}`
        }
      } finally {
        rmTree(commentDir)
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C1/C3：validateIssueBodyQuality 与 flow issue create 绑定真实 SPEC/Todo 免抄全文并阻断伪造路径（正反双向）', async () => {
    const { validateIssueBodyQuality } = await import('../../kit/skills/lib/issue-quality.mjs')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# demo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/core.mjs': 'export const run = () => 1\n',
      'docs/specs/261124-real-spec.md': [
        '---',
        'kind: spec',
        'title: 真实设计规范',
        'status: approved',
        'scope_files: [src/core.mjs]',
        '---',
        '# 真实设计规范',
        '## 一、背景与边界声明',
        '- **要改什么**：修改 `src/core.mjs` 的 `run` 逻辑。',
        '- **本期不做**：不动 `src/legacy.mjs` 与 UI 层。',
        '## 五、冻结的验收标准',
        '- [ ] C1: 运行 `node -e "console.log(1)"` 返回退出码 0',
      ].join('\n'),
      'docs/archive/specs/261120-arch-spec.md': '---\nkind: spec\nstatus: implemented\n---\n# 归档规范\n',
      '.worktrees/impl-wt-demo/docs/specs/261124-wt-spec.md': '---\nkind: spec\nstatus: draft\n---\n# Worktree 规范\n',
    })
    gitInit(dir, { branch: 'main', name: 'Alice', email: 'alice@example.com' })
    gitCommitFast(dir, 'init real spec')
    try {
      // 正例 1：正文引用真实在盘 SPEC（含主仓、归档、worktree），免抄 SPEC 全文即可通过
      for (const specRef of [
        'docs/specs/261124-real-spec.md',
        'docs/archive/specs/261120-arch-spec.md',
        'docs/specs/261124-wt-spec.md',
      ]) {
        const linkedBody = [
          '## 背景与现象',
          `按 \`${specRef}\` 推进 \`src/core.mjs\` 改造。`,
          '## 影响面与严重度',
          '影响 `src/core.mjs`；severity=medium；不触及数据持久化、认证与安全边界。',
          '## 验收标准',
          '- [ ] C1: 运行 `node -e "console.log(1)"` 退出码 0',
          '## 不在本次范围',
          '不动 `src/legacy.mjs`。',
          '## 关联的设计产物',
          `- \`${specRef}\``,
        ].join('\n')
        const check = validateIssueBodyQuality(linkedBody, { repoRoot: dir })
        if (!check.ok || !check.hasRealLinkedPlanDoc || !check.verifiedDocRefs.includes(specRef)) {
          return `引用真实在盘文档 ${specRef} 应自动识别并通过：${JSON.stringify(check)}`
        }
      }

      // 正例 2：代码块围栏内的示例 docs/specs/example.md 不算虚假路径
      const fencedBody = [
        '## 背景与现象',
        '修复 `src/core.mjs:1` 校验逻辑。',
        '```markdown',
        '示例：docs/specs/example-in-fence.md',
        '```',
        '## 影响面与严重度',
        '影响 `src/core.mjs`；severity=low；无 API 与安全破坏。',
        '## 期望与方案',
        '运行 `node -e "console.log(1)"` 验证。',
        '## 验收标准',
        '- [ ] C1: `src/core.mjs` 单元测试通过',
        '## 不在本次范围',
        '不动文档目录 `docs/`。',
      ].join('\n')
      const fencedCheck = validateIssueBodyQuality(fencedBody, { repoRoot: dir })
      if (!fencedCheck.ok || fencedCheck.invalidDocRefs.length > 0) {
        return `代码围栏内示例路径不应被判为虚假路径：${JSON.stringify(fencedCheck)}`
      }

      // 反例 1：正文中伪造不存在的 docs/specs/fake-spec.md
      const fakeInBody = [
        '## 背景与现象',
        '依据 `docs/specs/fake-spec.md` 实施改造。',
        '## 影响面与严重度',
        '影响 `src/core.mjs`；severity=medium；不改安全权限。',
        '## 验收标准',
        '- [ ] C1: `src/core.mjs` 退出码 0',
        '## 不在本次范围',
        '不动 `README.md`。',
      ].join('\n')
      const fakeCheck = validateIssueBodyQuality(fakeInBody, { repoRoot: dir })
      if (fakeCheck.ok || fakeCheck.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE' || !fakeCheck.invalidDocRefs.includes('docs/specs/fake-spec.md')) {
        return `伪造 SPEC 路径未在 validateIssueBodyQuality 中被拦截：${JSON.stringify(fakeCheck)}`
      }

      // 正例 3：flow issue create --spec <real> 不手写 --body，自动从 SPEC 水合并成功建单
      const cliCreateOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', 'feat: 绑定真实规范建单', '--spec', 'docs/specs/261124-real-spec.md', '--json',
      ], { cwd: dir })
      if (cliCreateOk.status !== 0) {
        return `flow issue create 绑定真实 --spec 建单失败：status=${cliCreateOk.status}\n${cliCreateOk.stdout}\n${cliCreateOk.stderr}`
      }
      const createdJson = JSON.parse(cliCreateOk.stdout)
      if (!createdJson.issue?.number || !String(createdJson.issue?.body ?? '').includes('docs/specs/261124-real-spec.md')) {
        return `flow issue create --spec 建单产物异常：${cliCreateOk.stdout}`
      }

      // 反例 2：flow issue create --spec <fake> 退出码 3 且包含 BLOCKED_ISSUE_QUALITY_INCOMPLETE
      const cliCreateFake = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', 'feat: 假规范拦截', '--spec', 'docs/specs/fake-spec.md', '--json',
      ], { cwd: dir })
      if (cliCreateFake.status !== EXIT.FACT || !`${cliCreateFake.stdout}\n${cliCreateFake.stderr}`.includes('BLOCKED_ISSUE_QUALITY_INCOMPLETE')) {
        return `flow issue create 假 --spec 未返回 exit 3 BLOCKED_ISSUE_QUALITY_INCOMPLETE：status=${cliCreateFake.status}, out=${cliCreateFake.stdout}, err=${cliCreateFake.stderr}`
      }

      // 反例 3：绝不接受 --mode 双轨开关
      const cliModeFlag = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', 'test', '--mode', 'standalone', '--json',
      ], { cwd: dir })
      if (cliModeFlag.status === 0) {
        return 'flow issue create 不应接受 --mode 参数或允许模式绕过'
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2/C3：escalation 富证据建单、govern-audit issues 与全托管入口统一拦截（正反双向）', async () => {
    const { validateIssueBodyQuality } = await import('../../kit/skills/lib/issue-quality.mjs')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# demo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/leak.mjs': `const tok = '${'ghp_' + 'x'.repeat(36)}'\n`,
    })
    gitInit(dir, { branch: 'main', name: 'Alice', email: 'alice@example.com' })
    gitCommitFast(dir, 'add sample leak')
    try {
      // 正例 1：buildIssues 产出自包含富证据（含 file:line、影响面与严重度、已核实基线与局限、C1 命令、Out of Scope、零 emoji）
      const built = buildIssues([
        {
          id: 'security.hardcoded-token',
          category: 'security',
          severity: 'critical',
          file: 'src/leak.mjs',
          line: 1,
          title: 'Potential hardcoded token in src/leak.mjs:1',
          action: 'Move token to environment variable or secret store.',
        },
      ], { repoRoot: dir })
      if (built.length !== 1) return `buildIssues 数量异常：${built.length}`
      const issBody = built[0].body
      if (!issBody.includes('src/leak.mjs:1') || !issBody.includes('critical') || !issBody.includes('Out of Scope') && !issBody.includes('不在本次范围')) {
        return `buildIssues 缺少 file:line/严重度/Out of Scope 富证据：\n${issBody}`
      }
      if (!issBody.includes('govern-audit.mjs') || !issBody.includes('C1:')) {
        return `buildIssues 缺少可执行验证命令或 C1：\n${issBody}`
      }
      const qBuilt = validateIssueBodyQuality(issBody, { repoRoot: dir })
      if (!qBuilt.ok) {
        return `buildIssues 产物未通过质量门禁：${JSON.stringify(qBuilt)}\n${issBody}`
      }

      // 正例 2：govern-audit issues --json 产出合规富证据
      const govDry = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['issues', dir, '--json'], { cwd: dir })
      if (govDry.status !== 0) return `govern-audit issues 失败：${govDry.stderr}`
      const govJson = JSON.parse(govDry.stdout)
      if (!Array.isArray(govJson.issues) || govJson.issues.length === 0) {
        return `govern-audit issues 未产出工单：${govDry.stdout}`
      }
      for (const gi of govJson.issues) {
        const gq = validateIssueBodyQuality(gi.body, { repoRoot: dir })
        if (!gq.ok) return `govern-audit issues 产物不合规：${JSON.stringify(gq)}\n${gi.body}`
      }

      // 正例 3：buildEscalationIssuePayload 兼容 Evidence/Unknowns/NextSteps 结构化正文
      const escPayload = buildEscalationIssuePayload({
        source: 'flow-verify',
        category: 'e2e',
        severity: 'high',
        caseType: 3,
        e2eBlocking: true,
        title: 'E2E verification failed (demo)',
        summary: 'smoke cmd exited 1 on src/leak.mjs:1',
        body: '## Evidence\n- cmd `node src/leak.mjs` failed exit=1\n\n## Unknowns\n- unknown runtime flag\n\n## NextSteps\n- fix and re-run `node src/leak.mjs`',
        files: ['src/leak.mjs'],
        taskId: 'demo',
      }, { repoRoot: dir })
      const qEsc = validateIssueBodyQuality(escPayload.body, { repoRoot: dir })
      if (!qEsc.ok) {
        return `buildEscalationIssuePayload (Evidence/Unknowns/NextSteps) 未自动补齐 5 项底线：${JSON.stringify(qEsc)}\n${escPayload.body}`
      }

      // 反例 1：escalateToBackend 拦截低质量 raw body（绝不调用 backend.createIssue，验证 local/github/mcp-delegate 一致性）
      let createCalls = 0
      const spyBackend = {
        kind: 'github',
        async listIssues() { return { ok: true, issues: [] } },
        async createIssue() { createCalls += 1; return { ok: true, number: 99 } },
      }
      const escBlocked = await escalateToBackend({
        backend: spyBackend,
        repoRoot: dir,
        force: true,
        item: { title: '空壳升级', body: '## 现状\n坏了\n\n## 验收\n修好' },
      })
      if (escBlocked.ok !== false || escBlocked.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE' || escBlocked.exitCode !== EXIT.FACT || createCalls !== 0) {
        return `escalateToBackend 未阻断低质量工单或仍调用了 createIssue：createCalls=${createCalls}, res=${JSON.stringify(escBlocked)}`
      }

      // 反例 2：applyIssuesToBackend 拦截低质量工单并返回 BLOCKED_ISSUE_QUALITY_INCOMPLETE + exitCode 3
      const applyBlocked = await applyIssuesToBackend(dir, [{ title: '空壳批量', body: '待补充' }])
      if (applyBlocked.code !== 'BLOCKED_ISSUE_QUALITY_INCOMPLETE' || applyBlocked.exitCode !== EXIT.FACT) {
        return `applyIssuesToBackend 未返回 BLOCKED_ISSUE_QUALITY_INCOMPLETE (3)：${JSON.stringify(applyBlocked)}`
      }

      // 反例 3：flow issue create 拦截低质量正文（exit 3）
      const flowBadCreate = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', '坏工单', '--body', '## 现状\n坏了\n\n## 验收\n修好', '--json',
      ], { cwd: dir })
      if (flowBadCreate.status !== EXIT.FACT || !`${flowBadCreate.stdout}\n${flowBadCreate.stderr}`.includes('BLOCKED_ISSUE_QUALITY_INCOMPLETE')) {
        return `flow issue create 未拦截 2 段空壳：status=${flowBadCreate.status}, out=${flowBadCreate.stdout}, err=${flowBadCreate.stderr}`
      }

      // 反例 4：flow start --create-issue 无设计文档直接裸建单被质量门禁拦截（exit 3）
      const startBadCreate = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'bad-iss', '--slug', 'bad-iss', '--case', '3', '--create-issue',
        '--title', '坏启动单', '--allow-plan-bootstrap', '--json',
      ], { cwd: dir })
      if (startBadCreate.status !== EXIT.FACT || !`${startBadCreate.stdout}\n${startBadCreate.stderr}`.includes('BLOCKED_ISSUE_QUALITY_INCOMPLETE')) {
        return `flow start --create-issue 未拦截裸建单：status=${startBadCreate.status}, out=${startBadCreate.stdout}, err=${startBadCreate.stderr}`
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C3/C5：verify-tools run --stale 将自检工具排在最后刷新并一次性通过', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# A\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'Tester', email: 't@example.com' })
    equip(dir, { tier: 'full', noBackup: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    // 故意把 verify-tools-self-audit 放在 features[0]，把 verify-app 放在 features[1]
    writeFileSync(join(dir, 'docs/feature-map.json'), JSON.stringify({
      version: 1,
      features: [
        {
          id: 'dev-verify-tools',
          name: 'Self Audit First',
          entrypoints: ['.agents/skills/dev-verify-tools/scripts/verify-tools.mjs'],
          modules: ['.agents/skills/dev-verify-tools/scripts/verify-tools.mjs'],
          businessFlows: ['self audit'],
          verificationTools: [{
            id: 'verify-tools-self-audit',
            kind: 'static',
            command: 'node .agents/skills/dev-verify-tools/scripts/verify-tools.mjs audit --json',
            riskLevel: 'high',
          }],
          testRefs: [],
        },
        {
          id: 'app-feature',
          name: 'App Feature',
          entrypoints: ['src/app.mjs'],
          modules: ['src/app.mjs'],
          businessFlows: ['app flow'],
          verificationTools: [{
            id: 'verify-app',
            kind: 'smoke',
            command: 'node -e "console.log(1)"',
            riskLevel: 'medium',
          }],
          testRefs: [],
        },
      ],
    }, null, 2), 'utf8')
    gitSync(dir, ['add', '.'])
    gitCommitFast(dir, 'init verify-tools sort test')
    try {
      const runStale = await runAbsAsync('.agents/skills/dev-verify-tools/scripts/verify-tools.mjs', [
        'run', dir, '--stale', '--json',
      ], { cwd: dir })
      if (runStale.status !== 0) {
        return `verify-tools run --stale 一次性执行失败：status=${runStale.status}\n${runStale.stdout}\n${runStale.stderr}`
      }
      const resJson = JSON.parse(runStale.stdout)
      if (!resJson.ok || resJson.results?.length !== 2) {
        return `verify-tools run --stale 结果数量或状态异常：${runStale.stdout}`
      }
      const ids = resJson.results.map((r) => r.toolId)
      if (ids[0] !== 'verify-app' || ids[1] !== 'verify-tools-self-audit') {
        return `verify-tools-self-audit 未排在最后执行：order=${JSON.stringify(ids)}`
      }
      // 二次模拟两者同时 stale（修改模块导出符号），单条 run --stale 仍必须先刷新 verify-app 再跑 self-audit 一次性全绿
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\nexport const nextOk = 3\n', 'utf8')
      const vtFile = join(dir, '.agents/skills/dev-verify-tools/scripts/verify-tools.mjs')
      writeFileSync(vtFile, `${readFileSync(vtFile, 'utf8')}\nexport const staleMarker = 1\n`, 'utf8')
      const runStale2 = await runAbsAsync('.agents/skills/dev-verify-tools/scripts/verify-tools.mjs', [
        'run', dir, '--stale', '--json',
      ], { cwd: dir })
      if (runStale2.status !== 0) {
        return `双工具同时 stale 时 run --stale 一次性执行失败：status=${runStale2.status}\n${runStale2.stdout}\n${runStale2.stderr}`
      }
      const res2 = JSON.parse(runStale2.stdout)
      const ids2 = res2.results.map((r) => r.toolId)
      if (ids2[0] !== 'verify-app' || ids2[1] !== 'verify-tools-self-audit') {
        return `双工具同时 stale 时 verify-tools-self-audit 未排在最后执行：order=${JSON.stringify(ids2)}`
      }
      const auditAfter = await runAbsAsync('.agents/skills/dev-verify-tools/scripts/verify-tools.mjs', [
        'audit', dir, '--json',
      ], { cwd: dir })
      const auditJson = JSON.parse(auditAfter.stdout)
      if (!auditJson.ok || (auditJson.staleTools?.length ?? 0) > 0) {
        return `run --stale 一次跑完后 audit 仍有过期项：${auditAfter.stdout}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
