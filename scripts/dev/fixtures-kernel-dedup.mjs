#!/usr/bin/env node
/**
 * fixtures-kernel-dedup.mjs —— Phase 3B (PR-B #115) C1-C6 正反双向行为夹具（含 I370-I385 故障注入覆盖）。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现执行，也可直接运行 `node scripts/dev/fixtures-kernel-dedup.mjs`。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { computeFeatureFingerprint, writeFeatureMap } from '../../kit/skills/lib/feature-map.mjs'
import { isInsideDir, isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { readGitConfigFast, readLooseCommitLogFast } from '../../kit/skills/lib/git-fast.mjs'
import { inspectSurveyStatusFast, isCleanWorktreeFast } from '../../kit/skills/lib/git-status-fast.mjs'
import { hydrateIssueBody } from '../../kit/skills/lib/issue-template-hydrate.mjs'
import { getHostingProvider, registerHostingProvider } from '../../kit/skills/lib/platform.mjs'
import { countTextLines } from '../../kit/skills/lib/static-gates.mjs'
import { scanBrokenCommentPaths } from '../../kit/skills/lib/static-gates-comment-hygiene.mjs'
import { GenericRemoteBackend, LocalOnlyBackend, createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { pickSignalBlameFile } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'
import { handleRun as handleVerifyRun } from '../../kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

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
        'status: draft',
        'related_issues: ["#42"]',
        '---',
        '',
        '# Demo Spec',
        '',
        '## 目标',
        '- 透传 Issue 编号到远端同步层。',
        '',
        '## 不做什么',
        '- 不改动 unrelated 模块。',
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

  cases.push(['C6：bench.mjs --strict-budget 禁用 CI 2.5x 放宽严格按 1x 校验', () => {
    const benchSrc = readFileSync(join(SKILL_ROOT, 'scripts', 'dev', 'bench.mjs'), 'utf8')
    if (/\bbudgetScale\b|\*\s*2\.5\b|process\.env\.CI\s*\?/.test(benchSrc)) {
      return 'bench.mjs 仍残留 CI 2.5x budgetScale 放宽逻辑'
    }
    if (!benchSrc.includes('--strict-budget') || !benchSrc.includes('const effectiveBudget = c.budget')) {
      return 'bench.mjs 缺少 1x strict-budget 硬预算校验'
    }
    return true
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
