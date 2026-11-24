/**
 * fixtures-w6c-harness-gates.mjs —— Wave 6 Slice 6C (C13..C18 + 根治 A/B/C) 正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateCrossRepoTarget, validateNoAsciiControlChars } from '../../kit/skills/lib/cli.mjs'
import { computeEscalationFingerprint, escalateToBackend } from '../../kit/skills/lib/escalation.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { hydrateIssueBody } from '../../kit/skills/lib/issue-template-hydrate.mjs'
import { readPlanningProvenanceIndex, readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { buildMultiTaskWavePlan } from '../../kit/skills/lib/doc-slice-graph.mjs'
import {
  determineWorkflowPolicy, evaluateNextState, isEquivalentConcurrentCommand,
  normalizeConcurrentVerifyCommand, resolveScopedVerificationGate, runLowRiskDocStaticCheck,
} from '../../kit/skills/lib/workflow-policy.mjs'
import { syncSpecBodyStatusTable } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs'
import { handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleFinalize } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs'
import { handleVerify, handleSubmit } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge-claim.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { collectDevProfileEmpiricalCmds, computeEmpiricalRequirements } from '../../kit/skills/dev-review/scripts/review-empirical.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'
import { evaluateSubcommandParity } from './subcommand-parity.mjs'
import { registerW6cContextBriefCases } from './fixtures-w6c-context-brief.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (c) => { out += String(c); return true }
  process.stderr.write = (c) => { err += String(c); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerW6cHarnessGatesCases(cases) {
  cases.push(['W6C C13：跨仓 CWD 错位 fail-closed 拦截、--dir 显式放行与 6/6 SUBCOMMAND_META 全量对拍', async () => {
    const parity = evaluateSubcommandParity()
    if (!parity.ok || parity.notes.filter((n) => n.includes('full:')).length !== 6) {
      return `SUBCOMMAND_META 6/6 全量对拍未全部走 full：${JSON.stringify(parity)}`
    }

    const repoA = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# Repo A\n',
      '.agents/skills/dev-flow/scripts/flow.mjs': '// stub installed skill entry\n',
    })
    const repoB = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# Repo B\n',
    })
    gitInit(repoA, { branch: 'main', name: 'dev', email: 'dev@a.test' })
    gitInit(repoB, { branch: 'main', name: 'dev', email: 'dev@b.test' })
    gitSync(repoA, ['remote', 'add', 'origin', 'https://github.com/acme/repo-a.git'])
    gitSync(repoB, ['remote', 'add', 'origin', 'https://github.com/acme/repo-b.git'])
    try {
      const installedFlow = join(repoA, '.agents/skills/dev-flow/scripts/flow.mjs')

      // 反例 1：在 repoB 的 CWD 下跑 repoA/.agents/skills/flow.mjs 且未传 --dir -> BLOCKED_CROSS_REPO_CWD_MISMATCH
      const mismatchCwd = await validateCrossRepoTarget({
        cwd: repoB,
        scriptPath: installedFlow,
        argv: ['issue', 'list'],
      })
      if (mismatchCwd.ok || mismatchCwd.code !== 'BLOCKED_CROSS_REPO_CWD_MISMATCH' || mismatchCwd.exitCode !== EXIT.FACT) {
        return `跨仓 CWD 未被 fail-closed 拦截：${JSON.stringify(mismatchCwd)}`
      }

      // 反例 2：当前仓远端为 acme/repo-a，但传入指向 other/repo-x 的 URL -> BLOCKED_CROSS_REPO_CWD_MISMATCH
      const mismatchUrl = await validateCrossRepoTarget({
        cwd: repoA,
        scriptPath: installedFlow,
        argv: ['https://github.com/other/repo-x/issues/9'],
      })
      if (mismatchUrl.ok || mismatchUrl.code !== 'BLOCKED_CROSS_REPO_CWD_MISMATCH') {
        return `跨仓 Issue URL 未被拦截：${JSON.stringify(mismatchUrl)}`
      }

      // 正例 1：同仓 CWD 与同仓 URL 放行
      const sameOk = await validateCrossRepoTarget({
        cwd: repoA,
        scriptPath: installedFlow,
        argv: ['https://github.com/acme/repo-a/issues/9'],
      })
      if (!sameOk.ok) return `同仓校验被误拦：${JSON.stringify(sameOk)}`

      // 正例 2：显式传入 --dir repoB 允许跨仓精准操作且匹配 repoB 远端
      const explicitDirOk = await validateCrossRepoTarget({
        cwd: repoA,
        explicitDir: repoB,
        targetDir: repoB,
        scriptPath: installedFlow,
        argv: ['https://github.com/acme/repo-b/issues/12'],
      })
      if (!explicitDirOk.ok) return `显式 --dir 指向 repoB 被误拦：${JSON.stringify(explicitDirOk)}`

      return true
    } finally {
      rmTree(repoA)
      rmTree(repoB)
    }
  }])

  cases.push(['W6C C14：**Bold** 模板水合保留 --body 与 finalize 同步 SPEC 正文状态表', async () => {
    const dir = tmpProject({
      '.github/ISSUE_TEMPLATE/bug_report.md': [
        '<!-- comment hint -->',
        '**Describe the bug**',
        'A clear description of what the bug is.',
        '',
        '**To Reproduce**',
        'Steps to reproduce.',
        '',
        '**Expected Behavior**',
        'What should happen.',
      ].join('\n'),
      '.github/pull_request_template.md': [
        '**Summary**',
        'Describe changes.',
        '',
        '**Verification**',
        'Verify info.',
        '',
        '## Checklist',
        '- [ ] tests passed',
      ].join('\n'),
    })
    try {
      const hydratedBold = hydrateIssueBody(dir, 'bug', {
        title: 'Null pointer in parser',
        summary: 'Parser throws when payload is empty.',
        repro: '1. Pass empty string.',
        expected: 'Return empty list cleanly.',
      })
      if (!hydratedBold.includes('**Describe the bug**') || !hydratedBold.includes('Parser throws when payload is empty.') || !hydratedBold.includes('Return empty list cleanly.')) {
        return `**Bold** Issue 模板水合失效：\n${hydratedBold}`
      }
      if (hydratedBold.includes('A clear description')) {
        return `**Bold** 模板占位正文未被替换：\n${hydratedBold}`
      }

      // 0 匹配模板保底：保留用户 rawBody 原文不丢失
      writeFileSync(join(dir, '.github/ISSUE_TEMPLATE/bug_report.md'), '<!-- strip me -->\n## Custom Prompt Box\nPlease write anything.\n', 'utf8')
      const preserved = hydrateIssueBody(dir, 'bug', { rawBody: 'KEEP_USER_RAW_BODY_EXACT_999' })
      if (!preserved.includes('KEEP_USER_RAW_BODY_EXACT_999') || preserved.includes('<!-- strip me -->')) {
        return `0 匹配模板时丢弃了用户 rawBody：\n${preserved}`
      }

      // PR **Bold** 模板 + 0 匹配保留 rawBody
      const prBold = hydratePrTemplateBody({
        repoRoot: dir,
        taskId: 't-bold',
        ledger: { taskId: 't-bold', branch: 'feat/bold', linkedIssues: [88], lastVerifyExitCode: 0, verifiedHead: 'abcdef1234567', finalized: true },
        currentHead: 'abcdef1234567',
        changedFiles: ['src/a.mjs'],
        rawBody: 'PR_EXTRA_NOTE_KEEP_123',
      })
      if (!prBold.includes('**Summary**') || !prBold.includes('**Verification**') || !prBold.includes('| verify | PASS |') || !prBold.includes('- [x] tests passed') || !prBold.includes('PR_EXTRA_NOTE_KEEP_123')) {
        return `**Bold** PR 模板水合异常：\n${prBold}`
      }

      // SPEC 正文状态表同步
      const rawSpec = [
        '---', 'kind: spec', 'status: implemented', 'approved: true', 'implemented: true', 'plan_critique: passed', '---', '',
        '## 文档信息与变更概览', '',
        '| 项目 | 内容 |',
        '| --- | --- |',
        '| 当前状态 | `draft`（`draft \\| approved \\| implemented`） |',
        '| 创建 / 更新 | `2026-11-20` / `2026-11-20` |',
        '| 负责人 / 内审状态 | plan-w6 / `pending` |',
        '| 关联 PRD / Todo | `docs/prd/m.md` / `docs/todo/t.md` |',
      ].join('\n')
      const synced = syncSpecBodyStatusTable(rawSpec, {
        status: 'implemented',
        today: '2026-11-22',
        prdRel: 'docs/archive/prd/m.md',
        todoRel: 'docs/archive/todo/t.md',
        critiquePassed: true,
      })
      if (!synced.includes('| 当前状态 | `implemented`') || !synced.includes('`2026-11-20` / `2026-11-22`') || !synced.includes('`passed`') || !synced.includes('`docs/archive/todo/t.md`')) {
        return `syncSpecBodyStatusTable 未正确同步正文状态表：\n${synced}`
      }
      // 幂等性校验：仅传入 prdRel（todoRel: null）且原始单元格含路径斜杠时，二次运行不得发生漂移
      const prdOnly1 = syncSpecBodyStatusTable(rawSpec.replace('`docs/prd/m.md` / `docs/todo/t.md`', '未关联'), {
        status: 'implemented', today: '2026-11-22', prdRel: 'docs/prd/m.md', todoRel: null, critiquePassed: true,
      })
      const prdOnly2 = syncSpecBodyStatusTable(prdOnly1, {
        status: 'implemented', today: '2026-11-22', prdRel: 'docs/prd/m.md', todoRel: null, critiquePassed: true,
      })
      if (prdOnly1 !== prdOnly2 || prdOnly1.includes('/ prd')) {
        return `syncSpecBodyStatusTable 含路径斜杠时二次运行非幂等：\n1:\n${prdOnly1}\n2:\n${prdOnly2}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['W6C C15：low 纯文档免 runtime 实证/保留静态检查，与 escalation 错误签名去重', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c15\n\n```yaml\nquick-test: node -e "process.exit(1)"\nfull-test: node -e "process.exit(1)"\nsmoke-verify: none\nmerge-gate: node -e "process.exit(1)"\n```\n',
      'docs/guide.md': '# Guide\n\nSafe doc.\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@c15.test' })
    try {
      // 1a. low 纯文档（尽管 Dev Profile 配了命令）直放 --include-diff
      writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n\nClean doc update.\n', 'utf8')
      const cleanRes = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--include-diff', '--json'], { cwd: dir })
      if (cleanRes.status !== 0 || JSON.parse(cleanRes.stdout).diff?.diffIncluded !== true) {
        return `low 纯文档在有 Dev Profile 测试仓应直放 --include-diff：exit=${cleanRes.status} out=${cleanRes.stdout} err=${cleanRes.stderr}`
      }

      // 1b. 反例：纯文档含坏链或秘密字面量 -> 仍被静态检查 BLOCKED_STATIC_DOC_CHECK_FAILED 拦截
      writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n\nSee [broken](missing-target.md)\n', 'utf8')
      const badDoc = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--include-diff', '--json'], { cwd: dir })
      if (badDoc.status !== 3 || !badDoc.stdout.includes('BLOCKED_STATIC_DOC_CHECK_FAILED')) {
        return `含秘密字面量的纯文档未被静态检查拦住：exit=${badDoc.status} out=${badDoc.stdout}`
      }
      gitSync(dir, ['checkout', '--', 'docs/guide.md'])

      // 2. escalation 签名指纹去重：行号与临时路径不同但错误核心相同 -> 同一 pf-sig 且不重复建单
      const fp1 = computeEscalationFingerprint({
        category: 'e2e',
        code: 'E2E_FAIL',
        files: ['.worktrees/impl-a/src/app.mjs'],
        summary: 'FAIL at C:\\Users\\dev\\.worktrees\\impl-a\\src\\app.mjs:42:10 TypeError: boom (abc1234)',
      })
      const fp2 = computeEscalationFingerprint({
        category: 'e2e',
        code: 'E2E_FAIL',
        files: ['src/app.mjs'],
        summary: 'FAIL at /tmp/sandbox/src/app.mjs:99:3 TypeError: boom (deadbeef)',
      })
      if (!/^pf-sig:[0-9a-f]{12}$/.test(fp1) || fp1 !== fp2) {
        return `规范化签名指纹应一致且格式为 pf-sig:<12hex>：fp1=${fp1} fp2=${fp2}`
      }

      const openIssues = []
      let nextNum = 100
      const mockBackend = {
        kind: 'local',
        async listIssues({ state }) {
          return { ok: true, issues: openIssues.filter((x) => !state || x.state === state) }
        },
        async createIssue({ title, body }) {
          const item = { number: ++nextNum, title, body, state: 'open', url: `local://#${nextNum}`, comments: [] }
          openIssues.push(item)
          return { ok: true, number: item.number, url: item.url }
        },
        async postComment({ number, body }) {
          const found = openIssues.find((x) => x.number === number)
          if (found) found.comments.push(body)
          return { ok: true }
        },
      }
      const firstEsc = await escalateToBackend({
        backend: mockBackend,
        item: { title: 'src/app.mjs:42 boom', category: 'e2e', code: 'E2E_FAIL', severity: 'high', caseType: 4, files: ['src/app.mjs'], summary: 'src/app.mjs:42 boom' },
      })
      const secondEsc = await escalateToBackend({
        backend: mockBackend,
        item: { title: 'src/app.mjs:88 boom', category: 'e2e', code: 'E2E_FAIL', severity: 'high', caseType: 4, files: ['.worktrees/impl-x/src/app.mjs'], summary: 'src/app.mjs:88 boom' },
      })
      if (!firstEsc.ok || secondEsc.ok !== true || secondEsc.deduplicated !== true || secondEsc.number !== firstEsc.number || openIssues.length !== 1) {
        return `escalation 同签名去重失败：first=${JSON.stringify(firstEsc)} second=${JSON.stringify(secondEsc)} count=${openIssues.length}`
      }
      // 已关闭旧单不阻断真实回归重新建单
      openIssues[0].state = 'closed'
      const reopenedEsc = await escalateToBackend({
        backend: mockBackend,
        item: { title: 'src/app.mjs:105 boom', category: 'e2e', code: 'E2E_FAIL', severity: 'high', caseType: 4, files: ['src/app.mjs'], summary: 'src/app.mjs:105 boom' },
      })
      if (!reopenedEsc.ok || reopenedEsc.deduplicated || openIssues.length !== 2) {
        return `已关闭旧单误阻止真实回归建单：${JSON.stringify(reopenedEsc)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['W6C C16 + 根治 A：并发 flags 等价、多语言单栈过滤与波次图真相源回填/保守串行', async () => {
    // 1. 并发 flags 等价正反
    const normA = normalizeConcurrentVerifyCommand('pnpm --config.verify-deps-before-run=false vitest --bail --maxWorkers=4 --workers 2 --jobs=6')
    if (normA !== 'vitest' && normA !== 'pnpm vitest') {
      return `normalizeConcurrentVerifyCommand 未剥离并发参数：${normA}`
    }
    if (!isEquivalentConcurrentCommand('pnpm --config.verify-deps-before-run=false test -- --maxWorkers=4 --bail', 'pnpm test --')) {
      return '并发/pnpm skip verify-deps 参数应被判为等价命令'
    }
    if (isEquivalentConcurrentCommand('pnpm test --skip-lint', 'pnpm test')) {
      return '非白名单自定义参数不应被误判为等价'
    }

    // 2. 多语言单栈作用域过滤
    const polyDir = tmpProject({
      'package.json': '{"name":"mono","private":true}\n',
      'frontend/package.json': '{"name":"web","scripts":{"test":"vitest run"}}\n',
      'frontend/src/App.tsx': 'export const App = () => 1\n',
      'backend/go.mod': 'module example.com/api\ngo 1.22\n',
      'backend/main.go': 'package main\nfunc main() {}\n',
    })
    try {
      const profile = {
        'quick-test': ['pnpm --filter web test', 'go test ./...'],
        'full-test': ['pnpm --filter web test && cargo test'],
        'smoke-verify': [],
        'merge-gate': [],
      }
      const singleStack = resolveScopedVerificationGate({
        repoRoot: polyDir,
        changedFiles: ['frontend/src/App.tsx'],
        profile,
      })
      if (!singleStack.scoped || singleStack.affectedStacks.join(',') !== 'node') {
        return `单栈局部改动未被识别为 scoped=true：${JSON.stringify(singleStack)}`
      }
      const cmds = collectDevProfileEmpiricalCmds(profile, { scopedGate: singleStack })
      if (cmds.autoCommands.some((c) => /\bgo\b|\bcargo\b/.test(c)) || cmds.skippedCommands.length < 2) {
        return `未过滤未改动栈命令：${JSON.stringify(cmds)}`
      }
      // 反例：改动全局 CI 时关闭单栈过滤
      const globalScope = resolveScopedVerificationGate({
        repoRoot: polyDir,
        changedFiles: ['frontend/src/App.tsx', '.github/workflows/ci.yml'],
        profile,
      })
      if (globalScope.scoped) return `改动 .github/workflows 时不应跳过全栈命令：${JSON.stringify(globalScope)}`
    } finally { rmTree(polyDir) }

    // 3. 根治 A：evaluateNextState 从 docs/specs 回填 depends_on 与 scope_files，且空写域默认保守串行
    const emptyScopeWave = buildMultiTaskWavePlan([
      { taskId: 't-unknown-1' },
      { taskId: 't-unknown-2' },
    ])
    if (emptyScopeWave.parallelDispatch || emptyScopeWave.waves.some((w) => w.canParallel)) {
      return `空写域活跃任务被误放进并行 Wave：${JSON.stringify(emptyScopeWave)}`
    }

    const waveDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'docs/prd/261122-issue50-m-prd.md': '---\nkind: prd\ntitle: "M"\nstatus: active\nmulti_spec: true\nowner: arch\n---\n# M\n',
      'docs/specs/261122-issue50-s1-spec.md': '---\nkind: spec\ntitle: "S1"\nstatus: approved\ntier: L3\nissue: 50\ntask_id: s1\nowner: arch\napproved: true\nplan_critique: passed\nrelated_prd: ../prd/261122-issue50-m-prd.md\nscope_files: [src/a.mjs]\n---\n# S1\n\n## 验收标准\n- [ ] C1: a\n',
      'docs/specs/261122-issue50-s2-spec.md': '---\nkind: spec\ntitle: "S2"\nstatus: approved\ntier: L3\nissue: 50\ntask_id: s2\nowner: arch\napproved: true\nplan_critique: passed\nrelated_prd: ../prd/261122-issue50-m-prd.md\ndepends_on: [s1]\nscope_files: [src/b.mjs]\n---\n# S2\n\n## 验收标准\n- [ ] C2: b\n',
      'docs/specs/261122-issue50-s3-spec.md': '---\nkind: spec\ntitle: "S3"\nstatus: approved\ntier: L3\nissue: 50\ntask_id: s3\nowner: arch\napproved: true\nplan_critique: passed\nrelated_prd: ../prd/261122-issue50-m-prd.md\nscope_files: [src/c.mjs]\n---\n# S3\n\n## 验收标准\n- [ ] C3: c\n',
    })
    gitInit(waveDir, { branch: 'main', name: 'dev', email: 'dev@w.test' })
    try {
      // s1 与 s2 账本故意不传 dependsOn/files，验证 evaluateNextState 自动从 docs/specs 回填并严格分波（s2 绝不能进入 Wave 1）
      const evDep = evaluateNextState({
        repoRoot: waveDir,
        activeTasks: [
          { taskId: 's1', status: 'claimed', specFile: 'docs/specs/261122-issue50-s1-spec.md' },
          { taskId: 's2', status: 'claimed', specFile: 'docs/specs/261122-issue50-s2-spec.md' },
        ],
      })
      const w1Ids = (evDep.waves[0]?.tasks ?? []).map((t) => t.taskId)
      const w2Ids = (evDep.waves[1]?.tasks ?? []).map((t) => t.taskId)
      if (!w1Ids.includes('s1') || w1Ids.includes('s2') || !w2Ids.includes('s2')) {
        return `depends_on 未回填导致 s2 未严格排在 s1 之后波次：${JSON.stringify(evDep.waves)}`
      }
      // 仅含依赖链 [s1, s2]（移除 s3 后）时 parallelDispatch 必须为 false
      writeFileSync(join(waveDir, 'docs/specs/261122-issue50-s3-spec.md'), '---\nkind: spec\ntitle: "S3"\nstatus: implemented\ntier: L3\nissue: 50\ntask_id: s3\nowner: arch\n---\n# S3\n', 'utf8')
      const evSerialOnly = evaluateNextState({
        repoRoot: waveDir,
        activeTasks: [
          { taskId: 's1', status: 'claimed', specFile: 'docs/specs/261122-issue50-s1-spec.md' },
          { taskId: 's2', status: 'claimed', specFile: 'docs/specs/261122-issue50-s2-spec.md' },
        ],
      })
      if (evSerialOnly.parallelDispatch) {
        return `仅存 s1->s2 依赖链时不应 parallelDispatch=true：${JSON.stringify(evSerialOnly.waves)}`
      }
      // 恢复 s3 为 approved，验证 s1 与 s3 真无依赖且写域零重叠 -> parallelDispatch: true
      writeFileSync(join(waveDir, 'docs/specs/261122-issue50-s3-spec.md'), '---\nkind: spec\ntitle: "S3"\nstatus: approved\ntier: L3\nissue: 50\ntask_id: s3\nowner: arch\napproved: true\nplan_critique: passed\nrelated_prd: ../prd/261122-issue50-m-prd.md\nscope_files: [src/c.mjs]\n---\n# S3\n\n## 验收标准\n- [ ] C3: c\n', 'utf8')
      const evPar = evaluateNextState({
        repoRoot: waveDir,
        activeTasks: [
          { taskId: 's1', status: 'claimed', specFile: 'docs/specs/261122-issue50-s1-spec.md' },
          { taskId: 's3', status: 'claimed', specFile: 'docs/specs/261122-issue50-s3-spec.md' },
        ],
      })
      if (!evPar.parallelDispatch || evPar.waves[0].tasks.length !== 2) {
        return `真无依赖且写域不重叠的 s1/s3 未判为并行：${JSON.stringify(evPar.waves)}`
      }
      return true
    } finally { rmTree(waveDir) }
  }])

  cases.push(['W6C C17 + 根治 B：worktree-deps pnpm/Vite 与账本回写、游离 edit-gate 与 1:N 总控 Issue 关单保护', async () => {
    // 1. worktree-deps mount 回写账本 + pnpm/Vite 提示
    const pnpmDir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"vite-app","devDependencies":{"vite":"^5.0.0"}}\n',
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
      'vite.config.ts': 'export default {}\n',
    })
    gitInit(pnpmDir, { branch: 'main', name: 'dev', email: 'dev@p.test' })
    mkdirSync(join(pnpmDir, 'node_modules', '.pnpm', 'vite'), { recursive: true })
    writeFileSync(join(pnpmDir, 'node_modules', '.pnpm', 'vite', 'index.js'), '// mock vite\n', 'utf8')
    try {
      const wtRel = '.worktrees/impl-w-pnpm'
      const wtAbs = join(pnpmDir, wtRel)
      gitSync(pnpmDir, ['worktree', 'add', '-b', 'feat/w-pnpm', wtAbs, 'HEAD'])
      await writeTaskLedger(pnpmDir, { taskId: 'w-pnpm', slug: 'w-pnpm', worktreePath: wtRel, branch: 'feat/w-pnpm', baseBranch: 'main' })

      const mRes = await runAbsAsync('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', pnpmDir, '--worktree', wtAbs, '--json'], { cwd: pnpmDir })
      if (mRes.status !== 0) return `worktree-deps mount 失败：${mRes.stderr || mRes.stdout}`
      const mj = JSON.parse(mRes.stdout)
      if (mj.envHints?.npm_config_verify_deps_before_run !== 'false' || !mj.hints?.some((h) => h.includes('server.fs.allow'))) {
        return `pnpm/Vite 提示缺失：${mRes.stdout}`
      }
      const afterLedger = readTaskLedger(pnpmDir, 'w-pnpm')
      if (!afterLedger?.mountedDepsByWorktree?.[wtRel]?.includes('node_modules')) {
        return `worktree-deps mount 未同步回写 mountedDepsByWorktree：${JSON.stringify(afterLedger)}`
      }

      // 游离 HEAD 下的 edit-gate --base main 消费验证
      writeFileSync(join(wtAbs, 'src-ok.mjs'), 'export const ok = 1\n', 'utf8')
      gitCommitFast(wtAbs, 'feat: add ok')
      const headSha = gitSync(wtAbs, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const revAbs = join(pnpmDir, '.worktrees/review-w-pnpm')
      gitSync(pnpmDir, ['worktree', 'add', '--detach', revAbs, headSha])
      const egRes = await runAbsAsync('kit/skills/dev-edit/scripts/edit-gate.mjs', ['--mode', 'standalone', '--changed', '--base', 'main', '--json'], { cwd: revAbs })
      if (egRes.status !== 0) return `游离 HEAD 下 edit-gate --base main 失败：${egRes.stdout} ${egRes.stderr}`
    } finally { rmTree(pnpmDir) }

    // 2. 根治 B：1:N 总控 PRD 关单保护（首片合入保活 #143，末片合入才自动关闭 #143）
    const masterDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# m\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'docs/prd/261122-issue143-m-prd.md': '---\nkind: prd\ntitle: "M143"\nstatus: active\nissue: 143\nmulti_spec: true\nowner: plan-w6\nplan_critique: passed\n---\n# M143\n\n## 一、要解决的问题\n- master\n\n## 五、验收标准\n- [ ] C1: s1\n- [ ] C2: s2\n',
      'docs/specs/261122-issue143-s1-spec.md': '---\nkind: spec\ntitle: "S1"\nstatus: approved\ntier: L3\nissue: 143\ntask_id: s1\nowner: plan-w6\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_todo: ../todo/261122-issue143-s1-todo.md\n---\n# S1\n\n## 要解决的问题\n- s1\n\n## 本期不做\n- none\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C1: s1\n',
      'docs/todo/261122-issue143-s1-todo.md': '---\nkind: todo\nstatus: active\ntask_id: s1\nissue: 143\nowner: plan-w6\napproved: true\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_spec: ../specs/261122-issue143-s1-spec.md\n---\n# T1\n- [x] C1: s1\n',
      'docs/specs/261122-issue143-s2-spec.md': '---\nkind: spec\ntitle: "S2"\nstatus: approved\ntier: L3\nissue: 143\ntask_id: s2\nowner: plan-w6\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_todo: ../todo/261122-issue143-s2-todo.md\n---\n# S2\n\n## 要解决的问题\n- s2\n\n## 本期不做\n- none\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C2: s2\n',
      'docs/todo/261122-issue143-s2-todo.md': '---\nkind: todo\nstatus: active\ntask_id: s2\nissue: 143\nowner: plan-w6\napproved: true\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_spec: ../specs/261122-issue143-s2-spec.md\n---\n# T2\n- [x] C2: s2\n',
      'src/a.mjs': 'export const a = 1\n',
    })
    gitInit(masterDir, { branch: 'main', name: 'dev', email: 'dev@m.test' })
    gitSync(masterDir, ['remote', 'add', 'origin', 'https://github.com/acme/m143.git'])
    try {
      const mRoots = await resolveRepoRoots(masterDir)
      const closedIssues = []
      const postedComments = []
      const makeFakeProbe = (prNum, branchName) => ({
        env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'rev-bot' } },
        client: {
          tier: 'gh-cli',
          async getCommitChecks() { return { ok: true, state: 'SUCCESS', total: 1, checks: [{ name: 'ci', state: 'COMPLETED', conclusion: 'SUCCESS' }] } },
          async mergePr() { return { ok: true, merged: true, state: 'MERGED', mergeCommit: 'deadbeef' } },
          async postComment(args) { postedComments.push(args); return { ok: true } },
          async removeLabel() { return { ok: true } },
          async closeIssue(args) { closedIssues.push(args.number); return { ok: true } },
          async getPr() { return { ok: true, number: prNum, state: 'OPEN', headRefName: branchName } },
          async getIssue() { return { ok: true, number: 143, state: 'OPEN', title: 'M143' } },
          async listComments() { return { ok: true, comments: [] } },
          async createPr() { return { ok: true, number: prNum, url: `https://github.com/acme/m143/pull/${prNum}` } },
        },
      })

      // 启动 & 合入第一个切片 s1（此时 s2 仍未完成）
      const p1 = makeFakeProbe(201, 'feat/s1')
      const st1 = await withQuietIo(() => handleStart({ task: 's1', slug: 's1', case: '4', issue: '143', spec: 'docs/specs/261122-issue143-s1-spec.md', todo: 'docs/todo/261122-issue143-s1-todo.md', prd: 'docs/prd/261122-issue143-m-prd.md', agent: 'impl-s1', _ghProbe: p1, _ghClient: p1.client }, mRoots))
      if (st1.res.exitCode !== 0) return `s1 start 失败：exit=${st1.res.exitCode} ${st1.err} ${st1.out}`
      await withQuietIo(() => handleClaim({ task: 's1', agent: 'impl-s1', _ghProbe: p1, _ghClient: p1.client }, mRoots))
      await withQuietIo(() => handleExplore({ task: 's1', by: 'impl-s1' }, mRoots))
      const wt1 = join(masterDir, '.worktrees/impl-s1')
      writeFileSync(join(wt1, 'src/a.mjs'), 'export const a = 2\n', 'utf8')
      writeFileSync(join(wt1, 'docs/specs/261122-issue143-s1-spec.md'), '---\nkind: spec\ntitle: "S1"\nstatus: approved\ntier: L3\nissue: 143\ntask_id: s1\nowner: plan-w6\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_todo: ../todo/261122-issue143-s1-todo.md\n---\n# S1\n\n## 要解决的问题\n- s1\n\n## 本期不做\n- none\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C1: s1\n\n## 实现说明\n- done s1\n', 'utf8')
      const fn1 = await withQuietIo(() => handleFinalize({ task: 's1', 'no-tdd': true, json: true }, mRoots))
      if (fn1.res.exitCode !== 0) return `s1 finalize 失败：exit=${fn1.res.exitCode} ${fn1.err} ${fn1.out}`
      gitCommitFast(wt1, 'feat: s1')
      await withQuietIo(() => handleVerify({ task: 's1', mode: 'gate' }, mRoots))
      await withQuietIo(() => handleSubmit({ task: 's1', agent: 'impl-s1', _ghProbe: p1, _ghClient: p1.client }, mRoots))
      const tok1 = await issueTokenFor(masterDir, 's1', 1)
      const rec1 = await withQuietIo(() => handleRecord({ task: 's1', round: '1', verdict: 'pass', 'reviewer-id': 'rev-1', 'review-token': tok1, evidence: '夹具实测：命令已跑，输出符合预期' }, mRoots))
      if (rec1.res !== 0) return `s1 record 失败：exit=${rec1.res} ${rec1.err} ${rec1.out}`
      const mg1 = await withQuietIo(() => handleMerge({ task: 's1', json: true, 'reviewer-id': 'rev-1', _ghProbe: p1, _ghClient: p1.client }, mRoots))
      if (mg1.res.exitCode !== 0 || closedIssues.includes(143) || !postedComments.some((c) => String(c.body).includes('尚有 1 个未完成兄弟切片'))) {
        return `1:N 首片 s1 合入时错误关闭了总控 #143 或未附进展：exit=${mg1.res.exitCode} err=${mg1.err} closed=${JSON.stringify(closedIssues)} out=${mg1.out}`
      }

      // 模拟 s1 在 main 上已归档且总控 PRD 全部验收条目已勾选，仅剩末片 s2 完成合入 -> 自动关闭 #143
      writeFileSync(join(masterDir, 'docs/specs/261122-issue143-s1-spec.md'), '---\nkind: spec\ntitle: "S1"\nstatus: implemented\ntier: L3\nissue: 143\ntask_id: s1\nowner: plan-w6\napproved: true\nimplemented: true\nrelated_prd: ../prd/261122-issue143-m-prd.md\n---\n# S1\n', 'utf8')
      writeFileSync(join(masterDir, 'docs/prd/261122-issue143-m-prd.md'), '---\nkind: prd\ntitle: "M143"\nstatus: active\nissue: 143\nmulti_spec: true\nowner: plan-w6\nplan_critique: passed\n---\n# M143\n\n## 一、要解决的问题\n- master\n\n## 五、验收标准\n- [x] C1: s1\n- [x] C2: s2\n', 'utf8')
      gitCommitFast(masterDir, 'chore: mark s1 implemented on main', { updateOnly: true })

      const p2 = makeFakeProbe(202, 'feat/s2')
      const st2 = await withQuietIo(() => handleStart({ task: 's2', slug: 's2', case: '4', issue: '143', spec: 'docs/specs/261122-issue143-s2-spec.md', todo: 'docs/todo/261122-issue143-s2-todo.md', prd: 'docs/prd/261122-issue143-m-prd.md', agent: 'impl-s2', _ghProbe: p2, _ghClient: p2.client }, mRoots))
      if (st2.res.exitCode !== 0) return `s2 start 失败：exit=${st2.res.exitCode} ${st2.err} ${st2.out}`
      await withQuietIo(() => handleClaim({ task: 's2', agent: 'impl-s2', _ghProbe: p2, _ghClient: p2.client }, mRoots))
      await withQuietIo(() => handleExplore({ task: 's2', by: 'impl-s2' }, mRoots))
      const wt2 = join(masterDir, '.worktrees/impl-s2')
      writeFileSync(join(wt2, 'src/a.mjs'), 'export const a = 3\n', 'utf8')
      writeFileSync(join(wt2, 'docs/specs/261122-issue143-s2-spec.md'), '---\nkind: spec\ntitle: "S2"\nstatus: approved\ntier: L3\nissue: 143\ntask_id: s2\nowner: plan-w6\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261122-issue143-m-prd.md\nrelated_todo: ../todo/261122-issue143-s2-todo.md\n---\n# S2\n\n## 要解决的问题\n- s2\n\n## 本期不做\n- none\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C2: s2\n\n## 实现说明\n- done s2\n', 'utf8')
      const fn2 = await withQuietIo(() => handleFinalize({ task: 's2', 'no-tdd': true, json: true }, mRoots))
      if (fn2.res.exitCode !== 0) return `s2 finalize 失败：exit=${fn2.res.exitCode} ${fn2.err} ${fn2.out}`
      gitCommitFast(wt2, 'feat: s2')
      await withQuietIo(() => handleVerify({ task: 's2', mode: 'gate' }, mRoots))
      await withQuietIo(() => handleSubmit({ task: 's2', agent: 'impl-s2', _ghProbe: p2, _ghClient: p2.client }, mRoots))
      const tok2 = await issueTokenFor(masterDir, 's2', 1)
      const rec2 = await withQuietIo(() => handleRecord({ task: 's2', round: '1', verdict: 'pass', 'reviewer-id': 'rev-2', 'review-token': tok2, evidence: '夹具实测：命令已跑，输出符合预期' }, mRoots))
      if (rec2.res !== 0) return `s2 record 失败：exit=${rec2.res} ${rec2.err} ${rec2.out}`
      const mg2 = await withQuietIo(() => handleMerge({ task: 's2', json: true, 'reviewer-id': 'rev-2', _ghProbe: p2, _ghClient: p2.client }, mRoots))
      if (mg2.res.exitCode !== 0 || !closedIssues.includes(143)) {
        return `1:N 末片 s2 合入后未自动关闭 #143：exit=${mg2.res.exitCode} err=${mg2.err} closed=${JSON.stringify(closedIssues)} out=${mg2.out}`
      }
      return true
    } finally { rmTree(masterDir) }
  }])

  cases.push(['W6C C18 + 根治 C：planningProvenance 防篡改、git user.name 不误杀、证明边界与 C0 控制字符拦截', async () => {
    // 1. 根治 C：ASCII C0 控制字符门禁正反双向
    const badCtrl = validateNoAsciiControlChars('hello \x07 world', '--body')
    if (badCtrl.ok || badCtrl.code !== 'BLOCKED_ASCII_CONTROL_CHAR' || badCtrl.exitCode !== EXIT.USAGE) {
      return `\\x07 控制字符未被拦截：${JSON.stringify(badCtrl)}`
    }
    const okUtf8 = validateNoAsciiControlChars('第一行\t制表\n第二行 中文 Markdown `code`', '--body')
    if (!okUtf8.ok) return `合法 UTF-8/制表/换行被误拦：${JSON.stringify(okUtf8)}`

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c18\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/mod.mjs': 'export const mod = 1\n',
    })
    // 故意让宿主 git config user.name === 规划 owner ('plan-w6')，验证不会误杀隔离 --agent impl-b
    gitInit(dir, { branch: 'main', name: 'plan-w6', email: 'plan@local.test' })
    try {
      const cliCtrl = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['issue', 'create', '--title', 'Bad', '--body', 'has \x07 bell'], { cwd: dir })
      if (cliCtrl.status !== 2 || !cliCtrl.stderr.includes('BLOCKED_ASCII_CONTROL_CHAR')) {
        return `flow CLI 未拦截 C0 控制字符：exit=${cliCtrl.status} err=${cliCtrl.stderr}`
      }

      const initRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'prov-demo', '--title', 'Prov Demo', '--task', 'prov-t', '--owner', 'plan-w6', '--in-place', '--json',
      ], { cwd: dir })
      if (initRes.status !== 0) return `doc-plan init 失败：${initRes.stderr || initRes.stdout}`
      const initJson = JSON.parse(initRes.stdout)
      const idx = readPlanningProvenanceIndex(dir)
      if (!idx.byDoc[initJson.file]?.ownerHeaderHash || idx.byDoc[initJson.file].planningOwner !== 'plan-w6') {
        return `doc-plan init 未写入仓外 planningProvenance：${JSON.stringify(idx)}`
      }

      // 篡改工作区 Todo `owner:` 而未走 `doc-plan link --owner-reason` -> BLOCKED_PROVENANCE_TAMPERED
      const todoAbs = join(dir, initJson.file)
      const origTodo = readFileSync(todoAbs, 'utf8')
      writeFileSync(todoAbs, origTodo.replace('owner: plan-w6', 'owner: forged-other'), 'utf8')
      const tamperedStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'prov-t', '--case', '2', '--agent', 'impl-b', '--todo', initJson.file, '--no-issue', '--reason', '测试来源防篡改校验', '--json',
      ], { cwd: dir })
      if (tamperedStart.status !== 3 || !`${tamperedStart.stdout}${tamperedStart.stderr}`.includes('BLOCKED_PROVENANCE_TAMPERED')) {
        return `手工篡改 owner 未被 start 拦截 BLOCKED_PROVENANCE_TAMPERED：exit=${tamperedStart.status} out=${tamperedStart.stdout} err=${tamperedStart.stderr}`
      }
      // 篡改后即使执行普通 doc-plan link（未带 --owner-reason）也不得洗白仓外 ownerHeaderHash 基线
      const plainLink = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'link', initJson.file, '--task', 'prov-t', '--json',
      ], { cwd: dir })
      const postLinkStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'prov-t', '--case', '2', '--agent', 'impl-b', '--todo', initJson.file, '--no-issue', '--reason', '测试来源防篡改校验', '--json',
      ], { cwd: dir })
      if (postLinkStart.status !== 3 || !`${postLinkStart.stdout}${postLinkStart.stderr}`.includes('BLOCKED_PROVENANCE_TAMPERED')) {
        return `普通 link 洗白了已篡改基线：link=${plainLink.status} start=${postLinkStart.status} out=${postLinkStart.stdout}`
      }

      // 还原并通过合规通道交接 owner -> 原作者 plan-w6 仍被记录在 previousOwners 中，不可伪装实施者；但 --agent impl-b 即使 git user.name=plan-w6 仍可合法启动！
      writeFileSync(todoAbs, origTodo, 'utf8')
      const linkTransfer = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'link', initJson.file, '--owner', 'lead-x', '--owner-reason', '交接给 lead-x 维护', '--json',
      ], { cwd: dir })
      if (linkTransfer.status !== 0) return `合规交接 link 失败：${linkTransfer.stderr || linkTransfer.stdout}`

      gitCommitFast(dir, 'docs: add prov todo')

      // 原作者 plan-w6 尝试以 --agent plan-w6 启动 -> BLOCKED_AUTHOR_IS_IMPLEMENTER
      const selfAuthStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'prov-t', '--case', '2', '--agent', 'plan-w6', '--todo', initJson.file, '--no-issue', '--reason', '测试作者分离校验', '--json',
      ], { cwd: dir })
      if (selfAuthStart.status !== 3 || !`${selfAuthStart.stdout}${selfAuthStart.stderr}`.includes('BLOCKED_AUTHOR_IS_IMPLEMENTER')) {
        return `交接后原规划作者未被拦截 BLOCKED_AUTHOR_IS_IMPLEMENTER：exit=${selfAuthStart.status} out=${selfAuthStart.stdout}`
      }

      // 正向：隔离实施子代理 --agent impl-b（尽管宿主 git user.name === plan-w6）合法通过 start 与 claim
      const okStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'prov-t', '--case', '2', '--agent', 'impl-b', '--todo', initJson.file, '--no-issue', '--reason', '测试隔离代理正常启动', '--json',
      ], { cwd: dir })
      if (okStart.status !== 0) return `git user.name 与 owner 同名时误杀了隔离代理 impl-b：exit=${okStart.status} out=${okStart.stdout} err=${okStart.stderr}`

      // handoff-package 诚实区分 CLI 可机械实证边界与协调器调度前提
      const hp = buildHandoff({
        repoRoot: dir,
        role: 'implementer',
        ledger: { taskId: 'prov-t', branch: 'fix/prov-demo', baseBranch: 'main', todoFile: initJson.file },
      })
      if (!hp.prompt.includes('CLI 可机械实证边界') || !hp.prompt.includes('协调器调度前提')) {
        return `handoff-package 缺少证明边界诚实声明：\n${hp.prompt}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['low-risk 纯文档 check-empirical 禁跑 Dev Profile、diff hunk 静态作用域与 record pass 门禁对齐', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# low-risk-gate\n\n```yaml\nquick-test: node -e "console.error(\'SHOULD_NOT_RUN_QUICK_TEST\'); process.exit(1)"\nfull-test: node -e "process.exit(1)"\nsmoke-verify: none\nmerge-gate: node -e "process.exit(1)"\n```\n',
      'docs/guide.md': '# Guide\n\nSafe doc.\n',
      'docs/legacy.md': '# Legacy\n\nIntro line.\n\n[legacy-dead](missing-legacy.md)\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@low.test' })
    try {
      // 1a. low 纯文档 check-empirical --cmd 仅跑显式 --cmd，禁止前置强跑 Dev Profile quick-test
      writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n\nUpdated safe doc.\n', 'utf8')
      const empWithCmd = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'check-empirical', '--local', '--cmd', 'node -e "console.log(\'DOC_CMD_OK\')"', '--json',
      ], { cwd: dir })
      if (empWithCmd.status !== 0) {
        return `low 纯文档 check-empirical --cmd 误跑了 Dev Profile quick-test：exit=${empWithCmd.status} out=${empWithCmd.stdout} err=${empWithCmd.stderr}`
      }
      const empCmdJson = JSON.parse(empWithCmd.stdout)
      if (empCmdJson.commands?.length !== 1 || empCmdJson.commands[0]?.cmd?.includes('process.exit(1)')) {
        return `low 纯文档 check-empirical --cmd 收集了非预期命令：${empWithCmd.stdout}`
      }

      // 1b. low 纯文档不传 --cmd -> low-risk-no-runtime-checks 安全豁免且不写入 signals/issues
      const empNoCmd = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'check-empirical', '--local', '--json',
      ], { cwd: dir })
      if (empNoCmd.status !== 0) {
        return `low 纯文档无 --cmd check-empirical 未安全豁免：exit=${empNoCmd.status} out=${empNoCmd.stdout}`
      }
      const empNoCmdJson = JSON.parse(empNoCmd.stdout)
      if (!empNoCmdJson.lowRiskNoRuntimeChecks || empNoCmdJson.commands?.length !== 0) {
        return `low 纯文档无 --cmd 返回载荷异常：${empNoCmd.stdout}`
      }
      if (existsSync(join(dir, '.git/project-forge-flow/signals.jsonl'))) {
        return 'low 纯文档 check-empirical 不应写入 signals.jsonl'
      }

      // 1c. 反例：触及运行时代码 src/app.mjs 仍必收集并执行 Dev Profile quick-test（传过关 --cmd 仍因 quick-test exit 1 被拦）
      gitSync(dir, ['checkout', '--', 'docs/guide.md'])
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n', 'utf8')
      const empRuntime = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'check-empirical', '--local', '--cmd', 'node -e "process.exit(0)"', '--json',
      ], { cwd: dir })
      if (empRuntime.status !== 3 || !empRuntime.stdout.includes('BLOCKED_EMPIRICAL_FAILED')) {
        return `运行时代码变更未继续强制运行 Dev Profile quick-test：exit=${empRuntime.status} out=${empRuntime.stdout}`
      }
      gitSync(dir, ['checkout', '--', 'src/app.mjs'])

      // 2. runLowRiskDocStaticCheck({ diffText })：未改行历史死链与历史凭据放行，新增行死链/凭据阻断，未传 diffText 保持全文件兼容
      const fakeTok = `${'ghp'}_${'z'.repeat(36)}`
      writeFileSync(join(dir, 'docs/secret-legacy.md'), `# Sec\n\nClean intro.\n\nold=${fakeTok}\n`, 'utf8')
      gitCommitFast(dir, 'docs: seed secret legacy')
      writeFileSync(join(dir, 'docs/legacy.md'), '# Legacy\n\nIntro line v2.\n\n[legacy-dead](missing-legacy.md)\n', 'utf8')
      writeFileSync(join(dir, 'docs/secret-legacy.md'), `# Sec\n\nClean intro v2.\n\nold=${fakeTok}\n`, 'utf8')
      const diffOnlyLine3 = gitSync(dir, ['diff', '--unified=3', '--', 'docs/legacy.md', 'docs/secret-legacy.md'], { encoding: 'utf8' }).stdout
      const scopedPass = runLowRiskDocStaticCheck(dir, ['docs/legacy.md', 'docs/secret-legacy.md'], { diffText: diffOnlyLine3 })
      const fullFallback = runLowRiskDocStaticCheck(dir, ['docs/legacy.md', 'docs/secret-legacy.md'])
      if (!scopedPass.ok || fullFallback.ok || fullFallback.errors.length < 2) {
        return `runLowRiskDocStaticCheck diff hunk 作用域或兼容全文件回退异常：scoped=${JSON.stringify(scopedPass)} full=${JSON.stringify(fullFallback)}`
      }
      gitSync(dir, ['checkout', '--', 'docs/legacy.md', 'docs/secret-legacy.md'])

      // 3. --task 全链一致性：修改含历史死链老文档的无关第 3 行 -> --include-diff 与 record --verdict pass 同时通过
      writeFileSync(join(dir, 'AGENTS.md'), '# low-risk-gate\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n', 'utf8')
      gitCommitFast(dir, 'chore: green profile for task flow', { updateOnly: true })
      const roots = await resolveRepoRoots(dir)

      await withQuietIo(() => handleStart({ task: 'doc-ok', case: '2', slug: 'doc-ok', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦文档静态检查' }, roots))
      await withQuietIo(() => handleClaim({ task: 'doc-ok', agent: 'alice' }, roots))
      const wtOk = join(dir, '.worktrees/impl-doc-ok')
      writeFileSync(join(wtOk, 'docs/legacy.md'), '# Legacy\n\nIntro line v2.\n\n[legacy-dead](missing-legacy.md)\n', 'utf8')
      gitCommitFast(wtOk, 'docs: update unrelated line in legacy doc', { updateOnly: true })
      const vOk = await withQuietIo(() => handleVerify({ task: 'doc-ok', mode: 'gate' }, roots))
      if (vOk.res.exitCode !== 0) return `修改含历史死链老文档无关行 verify 失败：exit=${vOk.res.exitCode} err=${vOk.err}`
      await withQuietIo(() => handleSubmit({ task: 'doc-ok', agent: 'alice' }, roots))

      const incOk = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'doc-ok', '--include-diff', '--json'], { cwd: dir })
      if (incOk.status !== 0 || JSON.parse(incOk.stdout).diff?.diffIncluded !== true) {
        return `修改含历史死链老文档无关行被 --include-diff 误拦：exit=${incOk.status} out=${incOk.stdout}`
      }
      const tokOk = await issueTokenFor(dir, 'doc-ok', 1)
      const recOk = await withQuietIo(() => handleRecord({
        task: 'doc-ok', round: '1', verdict: 'pass', 'reviewer-id': 'rev-doc-1', 'review-token': tokOk,
        evidence: '实测：仅修改第3行无关文本，未新增死链',
      }, roots))
      if (recOk.res !== 0) return `修改含历史死链老文档无关行 record pass 被误拦：exit=${recOk.res} err=${recOk.err} out=${recOk.out}`

      // 4. 反例：在老文档第 3 行新增死链 -> --include-diff 与 record --verdict pass 必须同时拦截 BLOCKED_STATIC_DOC_CHECK_FAILED
      await withQuietIo(() => handleStart({ task: 'doc-bad', case: '2', slug: 'doc-bad', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦死链拦截' }, roots))
      await withQuietIo(() => handleClaim({ task: 'doc-bad', agent: 'alice' }, roots))
      const wtBad = join(dir, '.worktrees/impl-doc-bad')
      writeFileSync(join(wtBad, 'docs/legacy.md'), '# Legacy\n\n[added-dead](added-missing.md)\n\n[legacy-dead](missing-legacy.md)\n', 'utf8')
      gitCommitFast(wtBad, 'docs: introduce new dead link', { updateOnly: true })
      await withQuietIo(() => handleSubmit({ task: 'doc-bad', agent: 'alice' }, roots))

      const incBad = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'doc-bad', '--include-diff', '--json'], { cwd: dir })
      if (incBad.status !== 3 || !incBad.stdout.includes('BLOCKED_STATIC_DOC_CHECK_FAILED')) {
        return `新增死链未被 --include-diff 拦截：exit=${incBad.status} out=${incBad.stdout}`
      }
      const tokBad = await issueTokenFor(dir, 'doc-bad', 1)
      const recBad = await withQuietIo(() => handleRecord({
        task: 'doc-bad', round: '1', verdict: 'pass', 'reviewer-id': 'rev-doc-1', 'review-token': tokBad,
        'no-enforce-gates': true, evidence: '试图绕过静态检查直接放行',
      }, roots))
      if (recBad.res !== 3 || !`${recBad.out}\n${recBad.err}`.includes('BLOCKED_STATIC_DOC_CHECK_FAILED')) {
        return `新增死链未被 record --verdict pass 拦截 BLOCKED_STATIC_DOC_CHECK_FAILED（存在门禁分裂）：exit=${recBad.res} out=${recBad.out} err=${recBad.err}`
      }

      return true
    } finally { rmTree(dir) }
  }])

  registerW6cContextBriefCases(cases)
}
