#!/usr/bin/env node
/**
 * fixtures-kernel-dedup.mjs —— 内核单源去重与 CLI/门禁对拍正反双向行为夹具（含 I370-I385 故障注入覆盖）。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现执行，也可直接运行 `node scripts/dev/fixtures-kernel-dedup.mjs`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { critiquePassDoc } from '../../kit/skills/lib/critique-rounds.mjs'
import { computeFeatureFingerprint, writeFeatureMap } from '../../kit/skills/lib/feature-map.mjs'
import { isInsideDir, isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readGitConfigFast, readLooseCommitLogFast } from '../../kit/skills/lib/git-fast.mjs'
import { inspectSurveyStatusFast, isCleanWorktreeFast } from '../../kit/skills/lib/git-status-fast.mjs'
import { hydrateIssueBody } from '../../kit/skills/lib/issue-template-hydrate.mjs'
import { readTaskLedger, updateTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { evaluatePlanExitGate } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { getHostingProvider, registerHostingProvider } from '../../kit/skills/lib/platform.mjs'
import { countTextLines } from '../../kit/skills/lib/static-gates.mjs'
import { scanBrokenCommentPaths } from '../../kit/skills/lib/static-gates-comment-hygiene.mjs'
import { GenericRemoteBackend, LocalOnlyBackend, createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { approveSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { pickSignalBlameFile } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleRun as handleVerifyRun } from '../../kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
import { BENCH_CHECKS, computeCheckBudget } from './bench.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

export function registerKernelDedupCases(cases) {
  cases.push(['C1：isInsideDir 路径前缀边界正反双向', () => {
    const base = tmpProject({ 'a.txt': 'ok' })
    const sibling = `${base}2`
    try {
      if (!isInsideDir(base, base)) return '相等路径应判定在目录内'
      if (!isInsideDir(join(base, 'sub', 'x.mjs'), base)) return '合法子路径应判定在目录内'
      if (isInsideDir(sibling, base)) return `兄弟前缀路径 ${sibling} 不得误判在 ${base} 内`
      if (isInsideDir(join(sibling, 'sub.mjs'), base)) return '兄弟目录子路径不得误判在父目录内'
      return true
    } finally {
      rmTree(base)
    }
  }])

  cases.push(['C1：countTextLines 799/800 行边界语义对等', () => {
    if (countTextLines('') !== 0) return '空文本应为 0 行'
    const lines799 = `${'x\n'.repeat(799)}`
    const lines800 = `${'x\n'.repeat(800)}`
    const lines800Crlf = `${'x\r\n'.repeat(800)}`
    if (countTextLines(lines799) !== 799) return `799 行末尾换行误判为 ${countTextLines(lines799)}`
    if (countTextLines(lines800) !== 800) return `800 行末尾换行误判为 ${countTextLines(lines800)}`
    if (countTextLines(lines800Crlf) !== 800) return `800 行 CRLF 误判为 ${countTextLines(lines800Crlf)}`
    if (countTextLines('a\nb') !== 2) return '无末尾换行两行文本应返回 2'
    return true
  }])

  cases.push(['C2：registerHostingProvider 强校验适配器方法契约', () => {
    let threwMissing = false
    try {
      registerHostingProvider({ id: 'broken-host-test', matchRemote: () => false })
    } catch (err) {
      if (String(err?.message ?? '').includes('缺少必备方法契约')) threwMissing = true
    }
    if (!threwMissing) return '缺少必备方法的 HostingProvider 未被 Fail-Closed 拦截'

    const reg = registerHostingProvider({
      id: 'c2-valid-host',
      label: 'C2 Valid',
      capabilities: { api: false, pr: false, issues: false },
      matchRemote: (url) => String(url).includes('c2host.invalid'),
      normalizeRepo: () => 'org/repo',
      parseRelations: () => ({ fixes: [], closes: [], refs: [] }),
      formatIssueRef: (repo, n) => `${repo}#${n}`,
    })
    if (reg.id !== 'c2-valid-host' || getHostingProvider('c2-valid-host')?.id !== 'c2-valid-host') {
      return '合法适配器注册失败'
    }
    return true
  }])

  cases.push(['C2：createTaskBackend 注册表分发与 generic-git 后端', () => {
    const dir = tmpProject({ 'README.md': '# demo\n' })
    try {
      const localBe = createTaskBackend({ role: 'local-only', providerId: 'none', mainRoot: dir })
      if (!(localBe instanceof LocalOnlyBackend)) return 'local-only 应返回 LocalOnlyBackend'

      const genBe = createTaskBackend({ role: 'maintainer', providerId: 'generic-git', targetRepo: 'org/repo', mainRoot: dir })
      if (!(genBe instanceof GenericRemoteBackend)) return 'generic-git 应返回 GenericRemoteBackend'

      let customCalled = false
      registerHostingProvider({
        id: 'c2-custom-be-host',
        label: 'Custom',
        capabilities: { api: true, pr: true, issues: true },
        matchRemote: () => false,
        normalizeRepo: () => 'org/custom',
        parseRelations: () => ({ fixes: [], closes: [], refs: [] }),
        formatIssueRef: (r, n) => `${r}#${n}`,
        createTaskBackend: ({ targetRepo }) => {
          customCalled = true
          return { kind: 'c2-custom', targetRepo }
        },
      })
      const customBe = createTaskBackend({ role: 'maintainer', providerId: 'c2-custom-be-host', targetRepo: 'org/custom', mainRoot: dir })
      if (!customCalled || customBe.kind !== 'c2-custom') {
        return 'createTaskBackend 未按注册表适配器 createTaskBackend 分发'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2：equip-ci 直接消费 artifactPlan 而非特判 providerId', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"ci-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      'README.md': '# ci-demo\n\n用于验证 equip-ci 消费 artifactPlan 而不特判 providerId 的测试仓库。\n',
      'AGENTS.md': '# ci-demo\n\n## 取舍\n\n- `no-ci`：由测试显式豁免\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/example/ci-demo.git'])
    try {
      const skipRes = await runAbsAsync('scripts/equip-ci.mjs', [dir, '--kind', 'check', '--json'])
      if (skipRes.status !== 0) return `equip-ci 失败：${skipRes.stderr}`
      const skipJson = JSON.parse(skipRes.stdout)
      if (skipJson.status !== 'SKIPPED_BY_ARTIFACT_PLAN') {
        return `no-ci 豁免的 GitHub 仓库应按 artifactPlan 跳过，实际：${skipRes.stdout}`
      }

      writeFileSync(join(dir, 'AGENTS.md'), '# ci-demo\n\n无豁免。\n')
      gitSync(dir, ['remote', 'set-url', 'origin', 'https://git.example.invalid/example/ci-demo.git'])
      gitSync(dir, ['remote', 'add', 'mirror', 'https://github.com/example/ci-demo.git'])
      const dryRes = await runAbsAsync('scripts/equip-ci.mjs', [dir, '--kind', 'check', '--dry-run', '--json'])
      if (dryRes.status !== 0) return `多远端 equip-ci dry-run 失败：${dryRes.stderr}`
      const dryJson = JSON.parse(dryRes.stdout)
      if (dryJson.status !== 'DRY_RUN') {
        return `多远端含 GitHub 时 artifactPlan 允许生成，应返回 DRY_RUN，实际：${dryRes.stdout}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C3：hydrateIssueBody 模板水合注释剥离与字面量换行归一化', () => {
    const dir = tmpProject({
      '.github/ISSUE_TEMPLATE/bug_report.md': [
        '---',
        'name: Bug',
        'about: defect',
        '---',
        '<!-- hidden template guide -->',
        '## 实际发生什么',
        '',
        '<!-- fill here -->',
        '旧占位',
        '',
        '## 验收标准',
        '',
        '- [ ] placeholder',
      ].join('\n'),
    })
    try {
      const body = hydrateIssueBody(dir, 'bug', {
        title: '修复边界',
        summary: '第一行\\n第二行',
        criteria: ['通过全部测试'],
      })
      if (body.includes('hidden template guide') || body.includes('fill here')) {
        return `未剥离模板注释：\n${body}`
      }
      if (body.includes('\\n')) return `未归一化字面量 \\n：\n${body}`
      if (!body.includes('第一行\n第二行')) return `换行内容缺失：\n${body}`
      if (!body.includes('- [ ] C1: 通过全部测试')) return `验收标准未水合：\n${body}`

      const fallback = hydrateIssueBody(dir, 'feature', { title: '降级测试', summary: 'A\\nB' }, { noTemplate: true })
      if (!fallback.includes('## 背景与现象') || !fallback.includes('A\nB')) {
        return `无模板降级输出异常：\n${fallback}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2/C3：doc-plan critique-pass/reject 透传 issueNumber 给远端同步', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# plan-sync-demo\n',
      'docs/specs/261120-issue42-demo-spec.md': [
        '---',
        'kind: spec',
        'id: demo-spec',
        'title: Demo Spec',
        'slug: demo',
        'issue: 42',
        'owner: arch-1',
        'status: draft',
        'related_issues: ["#42"]',
        '---',
        '',
        '# Demo Spec',
        '',
        '## 目标',
        '- 透传 `issueNumber` 到 `planSync` 远端同步层。',
        '',
        '## 不做什么',
        '- 不改动 `review/` 与无关模块。',
        '',
        '## 怎么算做完',
        '- [ ] C1: `critique-pass` 与 `critique-reject` 透传 `issueNumber` 且通过验证。',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/example/plan-sync-demo.git'])
    gitCommitFast(dir, 'docs: add spec')
    try {
      const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass',
        '--file', 'docs/specs/261120-issue42-demo-spec.md',
        '--reviewer', 'reviewer-a',
        '--summary', 'ok',
        '--json',
      ], { cwd: dir })
      if (res.status !== 0) return `doc-plan critique-pass 失败：${res.stderr}\n${res.stdout}`
      const parsed = JSON.parse(res.stdout)
      if (parsed.planSync?.status === 'NOT_APPLICABLE') {
        return `critique-pass 未从文档提取/透传 issueNumber #42，错误跳过为 NOT_APPLICABLE：${JSON.stringify(parsed.planSync)}`
      }
      const touched42 = parsed.planSync?.status === 'OFFLINE'
        || parsed.planSync?.syncFailures?.some((f) => f.number === 42)
        || parsed.planSync?.targets?.some((t) => t.number === 42)
      if (!touched42) {
        return `透传 issueNumber #42 后 sync 结果异常：${JSON.stringify(parsed.planSync)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2/C6：readGitConfigFast 在 linked worktree 正确解析 commondir', () => {
    const dir = tmpProject({ 'README.md': '# wt-cfg\n' })
    const wtDir = `${dir}-wt`
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/example/wt-cfg.git'])
    gitSync(dir, ['worktree', 'add', '-b', 'feat/wt', wtDir])
    try {
      const dotGitTxt = readFileSync(join(wtDir, '.git'), 'utf8')
      const gitDirLine = /^gitdir:\s*(.+)$/m.exec(dotGitTxt)?.[1]?.trim()
      const wtGitDir = resolve(wtDir, gitDirLine)
      const cfg = readGitConfigFast(wtGitDir)
      if (!cfg || !cfg.remoteText.includes('https://github.com/example/wt-cfg.git')) {
        return `linked worktree 下 readGitConfigFast 未读到共享远端配置：${JSON.stringify(cfg)}`
      }
      return true
    } finally {
      gitSync(dir, ['worktree', 'remove', '--force', wtDir])
      rmTree(wtDir)
      rmTree(dir)
    }
  }])

  cases.push(['C4：computeFeatureFingerprint 纳入 scriptPath 内容哈希并检出篡改', async () => {
    const dir = tmpProject({
      'src/app.mjs': 'export function run() { return 1 }\n',
      'scripts/verify-app.mjs': 'console.log("v1")\n',
    })
    try {
      const feature = {
        id: 'app',
        entrypoints: ['src/app.mjs'],
        modules: ['src/app.mjs'],
      }
      const tool = { id: 'verify-app', scriptPath: 'scripts/verify-app.mjs' }
      const fp1 = await computeFeatureFingerprint(dir, feature, { tool })
      writeFileSync(join(dir, 'scripts/verify-app.mjs'), 'console.log("v2-tampered")\n')
      const fp2 = await computeFeatureFingerprint(dir, feature, { tool })
      if (!fp1.scriptHash || !fp2.scriptHash || fp1.scriptHash === fp2.scriptHash) {
        return `scriptPath 内容篡改未被纳入 scriptHash：${fp1.scriptHash} vs ${fp2.scriptHash}`
      }
      if (fp1.moduleTreeHash === fp2.moduleTreeHash) {
        return 'scriptPath 内容篡改后 moduleTreeHash 未发生变化'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C4：verify-tools run 零匹配工具时 Fail-Closed 非零退出', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'src/app.mjs': 'export const ok = true\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{
          id: 'app',
          name: 'app',
          entrypoints: ['src/app.mjs'],
          modules: ['src/app.mjs'],
          businessFlows: ['run'],
          verificationTools: [{
            id: 'verify-app',
            kind: 'command',
            command: 'node -e "process.exit(0)"',
            scriptPath: null,
            riskLevel: 'medium',
            triggerHints: ['app'],
          }],
          testRefs: [],
        }],
      }, null, 2),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    const origCwd = process.cwd()
    let failRes
    let emptyRes
    const origOut = process.stdout.write
    const origErr = process.stderr.write
    process.stdout.write = () => true
    process.stderr.write = () => true
    try {
      process.chdir(dir)
      failRes = await handleVerifyRun({ tool: 'nonexistent-tool', json: true }, { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git') })
      writeFeatureMap(dir, { version: 1, features: [] })
      emptyRes = await handleVerifyRun({ json: true }, { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git') })
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
      process.chdir(origCwd)
      rmTree(dir)
    }
    if (failRes.exitCode === 0 || failRes.code !== 'NO_TOOLS_MATCHED') {
      return `非空 feature-map 零匹配工具应 Fail-Closed 非零退出，实际：${JSON.stringify(failRes)}`
    }
    if (emptyRes.exitCode !== 0 || emptyRes.status !== 'NOT_APPLICABLE') {
      return `首次接入空 feature-map 应降级 NOT_APPLICABLE，实际：${JSON.stringify(emptyRes)}`
    }
    return true
  }])

  cases.push(['C5：pickSignalBlameFile 过滤 .pf-manifest.json 防止信号归因污染', () => {
    const f1 = pickSignalBlameFile(['.agents/skills/.pf-manifest.json', 'scripts/survey.mjs'])
    if (f1 !== 'scripts/survey.mjs') return `应跳过 .pf-manifest.json 选取真实业务文件，实际：${f1}`
    const f2 = pickSignalBlameFile(['.agents/skills/.pf-manifest.json', '.worktrees/x/a.mjs'], '')
    if (f2 !== '') return `仅含噪声路径时应返回 fallback，实际：${f2}`
    return true
  }])

  cases.push(['C5：注释反引号路径检测与 --changed 基线棘轮正反双向', () => {
    const dir = tmpProject({
      'scripts/real.mjs': 'export const ok = 1\n',
    })
    try {
      const text = [
        '// 参考 `scripts/real.mjs` 与 `https://example.com/a/b.mjs` 与 `path/to/demo.mjs`',
        '// 错误路径 `scripts/nonexistent-broken.mjs`',
        '// ```md',
        '// `scripts/inside-fence-ignored.mjs`',
        '// ```',
      ].join('\n')
      const found = scanBrokenCommentPaths({ repoRoot: dir, fileRel: 'scripts/sample.mjs', text })
      if (found.length !== 1 || found[0].path !== 'scripts/nonexistent-broken.mjs') {
        return `应仅检出 1 个新增失效反引号路径，实际：${JSON.stringify(found)}`
      }
      const ratcheted = scanBrokenCommentPaths({ repoRoot: dir, fileRel: 'scripts/sample.mjs', text, headText: text })
      if (ratcheted.length !== 0) {
        return `基线棘轮应豁免 HEAD 存量失效路径，实际：${JSON.stringify(ratcheted)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C5：evidence.mjs 使用 git ls-files 对齐打包清单且不虚高', async () => {
    const evRes = await runAbsAsync('scripts/dev/evidence.mjs', ['--json'], { cwd: SKILL_ROOT })
    if (evRes.status !== 0) return `evidence.mjs 运行失败：${evRes.stderr}`
    const parsed = JSON.parse(evRes.stdout)
    const lsOut = gitSync(SKILL_ROOT, ['ls-files'], { stdio: 'pipe', encoding: 'utf8' }).stdout ?? ''
    const trackedCount = lsOut.split(/\r?\n/).filter(Boolean).length
    if (!parsed.shippedCount || parsed.shippedCount <= 1 || parsed.shippedCount > trackedCount) {
      return `evidence.mjs shippedCount 异常：shipped=${parsed.shippedCount}, tracked=${trackedCount}`
    }
    if (parsed.shipped.some((p) => p.startsWith('scripts/dev/') || p.startsWith('.agents/'))) {
      return 'evidence.mjs 产物清单漏排自用层路径'
    }
    return true
  }])

  cases.push(['C6：git-status-fast 对 eol=crlf 命中文件回退原生 git status 等价性', () => {
    const dir = tmpProject({
      '.gitattributes': '*.txt eol=crlf\n',
      'a.txt': 'hello\r\nworld\r\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    gitSync(dir, ['config', 'core.autocrlf', 'false'])
    gitCommitFast(dir, 'init')
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n')
      const cleanFast = isCleanWorktreeFast(dir)
      const surveyFast = inspectSurveyStatusFast(dir)
      const rawPorcelain = (gitSync(dir, ['status', '--porcelain=v2'], { stdio: 'pipe', encoding: 'utf8' }).stdout ?? '').trim()
      if (cleanFast !== null) return `命中 eol=crlf 的仓 isCleanWorktreeFast 应返回 null 回退原生 git，实际：${JSON.stringify(cleanFast)}`
      if (surveyFast !== null) return `命中 eol=crlf 的仓 inspectSurveyStatusFast 应返回 null 回退原生 git，实际：${JSON.stringify(surveyFast)}`
      if (rawPorcelain === '' && cleanFast?.clean === true) return '等价性异常'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C6：readLooseCommitLogFast 遇多父合并提交返回 incomplete 而非 null', () => {
    const dir = tmpProject({ 'a.txt': 'v1\n' })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@test.local' })
    gitSync(dir, ['checkout', '-b', 'feat'])
    writeFileSync(join(dir, 'b.txt'), 'feat\n')
    gitCommitFast(dir, 'feat commit')
    gitSync(dir, ['checkout', 'main'])
    writeFileSync(join(dir, 'c.txt'), 'main\n')
    gitCommitFast(dir, 'main commit')
    gitSync(dir, ['merge', '--no-ff', 'feat', '-m', 'merge feat'])
    writeFileSync(join(dir, 'd.txt'), 'after merge\n')
    gitCommitFast(dir, 'after merge')
    try {
      const headSha = (gitSync(dir, ['rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).stdout ?? '').trim()
      const logFast = readLooseCommitLogFast(dir, join(dir, '.git'), headSha, 20)
      if (!logFast || logFast.complete !== false || !Array.isArray(logFast.entries)) {
        return `遇多父合并提交应返回 { complete: false, entries } 而非 null，实际：${JSON.stringify(logFast)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C6：bench.mjs 零 CI 分支同轮校准预算与 --strict-budget 1x 严格上限正反双向', () => {
    const benchSrc = readFileSync(join(SKILL_ROOT, 'scripts', 'dev', 'bench.mjs'), 'utf8')
    if (/\bbudgetScale\b|\*\s*2\.5\b|process\.env\.CI|GITHUB_ACTIONS/.test(benchSrc)) {
      return 'bench.mjs 仍残留 CI / GITHUB_ACTIONS 环境变量放宽逻辑'
    }
    if (!benchSrc.includes('--strict-budget') || !benchSrc.includes('measureCalibrationUnit')) {
      return 'bench.mjs 缺少同轮校准或 --strict-budget 1x 严格校验'
    }
    const prevCi = process.env.CI
    try {
      process.env.CI = 'true'
      const withCi = BENCH_CHECKS.map((c) => computeCheckBudget(c, { unitMs: 100, strictBudget: false }))
      delete process.env.CI
      const withoutCi = BENCH_CHECKS.map((c) => computeCheckBudget(c, { unitMs: 100, strictBudget: false }))
      if (JSON.stringify(withCi) !== JSON.stringify(withoutCi)) {
        return `CI=true 与无 CI 变量预算推导不等价：withCi=${JSON.stringify(withCi)} vs withoutCi=${JSON.stringify(withoutCi)}`
      }
      const strictMap = Object.fromEntries(
        BENCH_CHECKS.map((c) => [c.label, computeCheckBudget(c, { unitMs: 500, strictBudget: true })]),
      )
      if (strictMap['survey(self)'] !== 250 || strictMap['flow inspect(self)'] !== 300 || strictMap['preflight(self)'] !== 2500) {
        return `--strict-budget 未强制 1x 绝对毫秒上限：${JSON.stringify(strictMap)}`
      }
      return true
    } finally {
      if (prevCi === undefined) delete process.env.CI
      else process.env.CI = prevCi
    }
  }])

  cases.push(['C7：planning=true 任务 finalize 规划退出门禁正反双向（未过审拦 BLOCKED_PLAN_NOT_READY；已过审直接 finalize 解除 planning 并放行 submit）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# demo\n',
      'AGENTS.md': [
        '# demo',
        '',
        '```yaml',
        'quick-test: node test/ok.test.mjs',
        'full-test: node test/ok.test.mjs',
        'smoke-verify: none',
        'merge-gate: node test/ok.test.mjs',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        '```',
        '',
        '## 取舍',
        '',
        '- `no-tdd`: yes',
        '',
      ].join('\n'),
      'src/app.mjs': 'export const ok = true\n',
      'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const roots = await resolveRepoRoots(dir)
      const st = await handleStart({ task: 'p-fin', slug: 'p-fin', case: '4', planning: true, implementer: 'plan-x', json: true }, roots)
      if (st.exitCode !== 0) return `start --planning 失败：${st.exitCode}`
      const wt = join(dir, '.worktrees', 'impl-p-fin')
      const specRel = 'docs/specs/261120-p-fin-spec.md'
      const todoRel = 'docs/todo/261120-p-fin-todo.md'
      mkdirSync(dirname(join(wt, specRel)), { recursive: true })
      mkdirSync(dirname(join(wt, todoRel)), { recursive: true })
      const makeSpecText = (checked) => [
        '---',
        'kind: spec',
        'title: "Plan Finalize"',
        'status: draft',
        'tier: L3',
        'created: 2026-11-20',
        'updated: 2026-11-22',
        'owner: plan-x',
        'plan_mode: interactive',
        'approved: false',
        'implemented: false',
        'plan_critique: pending',
        'related_prd: null',
        `related_todo: ../todo/261120-p-fin-todo.md`,
        'task_id: p-fin',
        '---',
        '',
        '# Plan Finalize',
        '',
        '## 要解决的问题',
        '- planning 任务在 `src/app.mjs` 过审后直接 finalize 并 submit',
        '',
        '## 本期不做',
        '- 不修改无关模块，不跳过 `src/app.mjs` 未批准拦截',
        '',
        '## 门型与回滚路径',
        '- two-way',
        '',
        '## 验收标准',
        `- [${checked ? 'x' : ' '}] C1: 完成后可解除 planning 态`,
        '',
      ].join('\n')
      writeFileSync(join(wt, specRel), makeSpecText(true), 'utf8')
      writeFileSync(join(wt, todoRel), [
        '---',
        'kind: todo',
        'title: "Plan Finalize Todo"',
        'status: active',
        'created: 2026-11-20',
        'updated: 2026-11-22',
        'owner: plan-x',
        'approved: false',
        'implemented: false',
        'related_prd: null',
        'related_spec: ../specs/261120-p-fin-spec.md',
        'task_id: p-fin',
        '---',
        '',
        '# Todo',
        '',
        '## 验收标准',
        '- [x] C1: ok',
        '',
        '## 完成后的记录',
        '- done',
        '',
      ].join('\n'), 'utf8')
      await updateTaskLedger(dir, 'p-fin', (cur) => ({ ...cur, specFile: specRel, todoFile: todoRel }))

      // 反面：未过审/未 approve 的 planning=true 任务调用 finalize 与 submit 均必须阻断 BLOCKED_PLAN_NOT_READY
      const finUnapproved = await handleFinalize({ task: 'p-fin', 'no-tdd': true, json: true }, roots)
      if (finUnapproved.exitCode !== 3) return `未过审 planning=true finalize 未阻断 exit 3：${JSON.stringify(finUnapproved)}`
      const subUnapproved = await handleSubmit({ task: 'p-fin', agent: 'plan-x', json: true }, roots)
      if (subUnapproved.exitCode !== 3) return `未过审 planning=true submit 未阻断 exit 3：${JSON.stringify(subUnapproved)}`
      if (readTaskLedger(dir, 'p-fin')?.planning !== true) return '未过审 finalize 阻断后不得清除 planning 标记'

      // 正面：独立 Critique 过审并 approve 后，接管认领并直接 finalize -> verify -> submit 解除 planning
      await critiquePassDoc({ repoRoot: wt, mainRoot: dir, file: specRel, reviewer: 'critic-x', summary: 'pass', taskId: 'p-fin' })
      approveSpec({ repoRoot: wt, mainRoot: dir, file: specRel, taskId: 'p-fin' })
      gitSync(wt, ['add', '-A'])
      gitCommitFast(wt, 'docs: approve p-fin')
      const clRes = await handleClaim({ task: 'p-fin', agent: 'impl-x', takeover: true, reason: 'handoff', json: true }, roots)
      if (clRes.exitCode !== 0) return `claim --takeover 失败：${clRes.exitCode}`
      await seedExploredFor(dir, 'p-fin')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const ok = true\nexport const v = 2\n', 'utf8')
      gitSync(wt, ['add', '-A'])
      gitCommitFast(wt, 'feat: impl p-fin')

      const finOk = await handleFinalize({ task: 'p-fin', agent: 'impl-x', 'no-tdd': true, json: true }, roots)
      if (finOk.exitCode !== 0) return `已过审 planning=true 直接 finalize 失败：${JSON.stringify(finOk)}`
      gitSync(wt, ['add', '-A'])
      gitCommitFast(wt, 'docs: finalize p-fin')
      const lAfterFin = readTaskLedger(dir, 'p-fin')
      if (lAfterFin?.planning !== false || lAfterFin?.status !== 'finalized') {
        return `finalize 后未解除 planning 态：${JSON.stringify({ planning: lAfterFin?.planning, status: lAfterFin?.status })}`
      }
      if (!(lAfterFin?.previousImplementers ?? []).includes('plan-x')) {
        return `finalize 接管未保留前序规划者 plan-x：${JSON.stringify(lAfterFin?.previousImplementers)}`
      }
      // 已归档 implemented SPEC 虽因 finalize 添加实现说明导致 SHA 变化，仍不应再报未过审
      const archGate = evaluatePlanExitGate(wt, {
        caseType: 4, taskId: 'p-fin',
        docs: { spec: lAfterFin.archivedSpecFile, todo: lAfterFin.archivedTodoFile },
        planCritique: lAfterFin.planCritique,
      })
      if (archGate.blocked) return `已归档 finalized SPEC 误报 BLOCKED_PLAN_NOT_READY：${JSON.stringify(archGate)}`

      const vOk = await handleVerify({ task: 'p-fin', mode: 'gate', json: true }, roots)
      if (vOk.exitCode !== 0) return `finalize 后 verify 失败：${vOk.exitCode}`
      const subOk = await handleSubmit({ task: 'p-fin', agent: 'impl-x', json: true }, roots)
      if (subOk.exitCode !== 0) return `finalize 解除 planning 后 submit 失败：${JSON.stringify(subOk)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const localCases = []
  registerKernelDedupCases(localCases)
  let failed = 0
  for (const [title, fn] of localCases) {
    try {
      const msg = await fn()
      if (msg !== true) {
        failed += 1
        process.stderr.write(`FAIL  ${title}\n      ${msg}\n`)
      } else {
        process.stdout.write(`PASS  ${title}\n`)
      }
    } catch (err) {
      failed += 1
      process.stderr.write(`FAIL  ${title}\n      ${err instanceof Error ? err.stack : String(err)}\n`)
    }
  }
  await flushAndExit(failed === 0 ? 0 : 1)
}
