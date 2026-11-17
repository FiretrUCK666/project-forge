/**
 * fixtures-govern.mjs —— 治理夹具：govern-audit 巡检与发布筹备、审查结构门、测试分层治理与契约回查落点。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerGovernCases(cases) {
cases.push(['review-pack.mjs：双轨门禁、arch-rules、tombstone/excuse 检出与 two-way/one-way 误伤防线', async () => {
  const dir = tmpProject({
    'AGENTS.md': [
      '# rev-w2',
      '',
      '```yaml',
      'smoke-verify: node -e "process.exit(0)"',
      'arch-rules: src/ui/** -> src/db/**',
      '```',
      '',
    ].join('\n'),
    'src/db/conn.mjs': 'export const query = () => []\n',
    'src/shared/fmt.mjs': 'export const fmt = (v) => String(v)\n',
    'src/ui/good.mjs': 'import { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n',
  })
  gitInit(dir, { branch: 'main' })

  try {
    // 1. 正向干净改动（正常注释 + 合法跨模块引用）-> structural clean & two-way & behavioral smokeRequired
    writeFileSync(join(dir, 'src/ui/good.mjs'), '// Format user value safely\nimport { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n')
    const pClean = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pClean.status !== 0) return `review-pack --local 干净改动失败：${pClean.stderr}`
    const cj = JSON.parse(pClean.stdout)
    if (!cj.behavioralGate?.smokeRequired || !cj.behavioralGate.runtimeFilesTouched.includes('src/ui/good.mjs')) {
      return `behavioralGate 未识别运行时改动与 smoke-verify：${JSON.stringify(cj.behavioralGate)}`
    }
    if ((cj.structuralGate?.archViolations?.length ?? 0) !== 0 || (cj.structuralGate?.excuseSuppressions?.length ?? 0) !== 0 || (cj.structuralGate?.tombstoneComments?.length ?? 0) !== 0) {
      return `干净改动被 structuralGate 误报：${JSON.stringify(cj.structuralGate)}`
    }
    if (cj.doorAssessment?.doorType !== 'two-way' || cj.doorAssessment?.mergeAuthority !== 'reviewer-direct') {
      return `普通改动门型误判：${JSON.stringify(cj.doorAssessment)}`
    }

    // 2. 越界依赖 + 墓碑注释 + excuse suppression + workflow 改动 -> attention-required + one-way
    writeFileSync(join(dir, 'src/ui/bad.mjs'), [
      '// 以前是同步调用，后来改成异步查询',
      '// eslint-disable-next-line no-unused-vars',
      'import { query } from "../db/conn.mjs"',
      'export const load = () => query()',
    ].join('\n'))
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n')

    const pBad = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pBad.status !== 0) return `review-pack --local 坏改动运行失败：${pBad.stderr}`
    const bj = JSON.parse(pBad.stdout)
    if ((bj.structuralGate?.archViolations?.length ?? 0) < 1) return `未检出 arch-rules 违例：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.tombstoneComments?.length ?? 0) < 1) return `未检出墓碑注释：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.excuseSuppressions?.length ?? 0) < 1) return `未检出 excuse suppression：${JSON.stringify(bj.structuralGate)}`
    if (bj.structuralGate?.status !== 'attention-required') return `structuralGate 状态不对：${bj.structuralGate?.status}`
    if (bj.doorAssessment?.doorType !== 'one-way' || bj.doorAssessment?.mergeAuthority !== 'human-required') {
      return `CI workflow 改动未判为 one-way + human-required：${JSON.stringify(bj.doorAssessment)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['govern-audit.mjs：fence-aware 死链接、注释死代码、上帝文件、arch-rules、4 态 worktree 与 record/cluster/sample', async () => {
  const godLines = Array.from({ length: 820 }, (_, i) => `export const k${i} = ${i}`).join('\n') + '\n'
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# gov-w2\n\n```yaml\narch-rules: src/ui/** -> src/db/**\n```\n',
    'README.md': '# gov-w2\n',
    'docs/TDD.md': '# TDD\n',
    'docs/guide.md': [
      '# Guide',
      '',
      '```markdown',
      '[in-fence](docs/nonexistent-in-fence.md)',
      '```',
      '',
      'Inline code `[in-code](docs/nonexistent-inline.md)` should pass.',
      '',
      'Real broken [real-dead](docs/actually-missing.md).',
    ].join('\n'),
    'src/db/db.mjs': 'export const db = 1\n',
    'src/ui/view.mjs': [
      '// normal header note line 1',
      '// normal header note line 2',
      '// normal header note line 3',
      '// normal header note line 4',
      '// normal prose comment without code',
      '// line two prose comment',
      '// line three prose comment',
      '// line four prose comment',
      'import { db } from "../db/db.mjs"',
      'export const view = () => db',
      '// const deadA = 1;',
      '// if (deadA > 0) {',
      '//   return deadA;',
      '// }',
    ].join('\n'),
    'src/big.mjs': godLines,
    'src/hot.mjs': 'export const h = 0\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })

  const wtMerged = join(dir, '.worktrees', 'wt-merged')
  const wtSquash = join(dir, '.worktrees', 'wt-squash')
  const wtNoOwn = join(dir, '.worktrees', 'wt-no-own')
  const wtUnmerged = join(dir, '.worktrees', 'wt-unmerged')

  try {
    // 构造 4 态 worktree + 1 个 Revert 与 3 次高频修改提交给 sample
    gitSync(dir, ['checkout', '-qb', 'wt-merged'])
    writeFileSync(join(dir, 'src/merged.mjs'), 'export const m = 1\n')
    gitCommitFast(dir, 'merged commit')
    gitSync(dir, ['checkout', '-q', 'main'])
    gitSync(dir, ['merge', '--no-ff', 'wt-merged', '-qm', 'merge wt-merged'])

    gitSync(dir, ['checkout', '-qb', 'wt-squash'])
    writeFileSync(join(dir, 'src/sq.mjs'), 'export const sq = 1\n')
    gitCommitFast(dir, 'squash feat')
    gitSync(dir, ['checkout', '-q', 'main'])
    gitSync(dir, ['merge', '--squash', '-q', 'wt-squash'])
    gitSync(dir, ['commit', '-qm', 'squash feat onto main'])

    gitSync(dir, ['worktree', 'add', '-q', wtMerged, 'wt-merged'])
    gitSync(dir, ['worktree', 'add', '-q', wtSquash, 'wt-squash'])
    gitSync(dir, ['worktree', 'add', '-q', '-b', 'wt-no-own', wtNoOwn, 'main'])
    writeFileSync(join(wtNoOwn, 'wip.txt'), 'uncommitted note\n')
    gitSync(dir, ['worktree', 'add', '-q', '-b', 'wt-unmerged', wtUnmerged, 'main'])
    writeFileSync(join(wtUnmerged, 'src/unmerged.mjs'), 'export const u = 1\n')
    gitCommitFast(wtUnmerged, 'unique unmerged commit')

    // 1. reconcile（4 态 worktree）+ audit 全类别扫描验证
    const rec = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', dir, '--json'])
    if (rec.status !== 0) return `govern-audit reconcile 失败：${rec.stderr}`
    const rj = JSON.parse(rec.stdout)

    const aud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
    if (aud.status !== 0) return `govern-audit audit 失败：${aud.stderr}`
    const aj = JSON.parse(aud.stdout)
    const ids = aj.findings.map((f) => f.id)
    if (ids.some((id) => id.includes('nonexistent-in-fence') || id.includes('nonexistent-inline'))) {
      return `围栏代码块内相对链接被误判为死链接：${JSON.stringify(ids)}`
    }
    if (!ids.some((id) => id.includes('actually-missing.md'))) return `真实死链接未被检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:11'))) {
      return `注释死代码块未检出或把普通注释误报了：${JSON.stringify(ids)}`
    }
    if (ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:5'))) {
      return `普通自然语言注释块被误判为死代码：${JSON.stringify(ids)}`
    }
    if (!ids.includes('hygiene.god-file.src/big.mjs')) return `上帝文件未检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('hygiene.arch-boundary.src/ui/view.mjs:'))) {
      return `arch-rules 边界违例未检出：${JSON.stringify(ids)}`
    }

    const wc = rj.reconcileSummary?.worktrees?.counts ?? {}
    if (wc.merged !== 1 || wc.squash_or_rebase_merged !== 1 || wc.no_own_commits !== 1 || wc.unmerged !== 1) {
      return `worktree 四态识别数量有误：${JSON.stringify(rj.reconcileSummary?.worktrees)}`
    }
    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['govern-audit.mjs：record -> cluster 规则下沉候选与 sample 高频返工热点', async () => {
  const dir = tmpProject({ '.gitignore': '.worktrees/\n', 'src/hot.mjs': 'export const h = 0\n' })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(join(dir, 'src/hot.mjs'), `export const h = ${i}\n`)
      gitCommitFast(dir, `touch hot ${i}`, { updateOnly: true, name: 't', email: 't@t.t' })
    }
    writeFileSync(join(dir, 'src/rev.mjs'), 'export const r = 1\n')
    gitCommitFast(dir, 'add rev', { files: ['src/rev.mjs'], name: 't', email: 't@t.t' })
    gitSync(dir, ['revert', '--no-edit', 'HEAD'])

    const r1 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'direct db import', '--json'])
    if (r1.status !== 0 || JSON.parse(r1.stdout).ruleSinkCandidate !== false) return `首次 record 判据有误：${r1.stdout}`
    const r2 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'second db import', '--json'])
    if (r2.status !== 0 || JSON.parse(r2.stdout).ruleSinkCandidate !== true || JSON.parse(r2.stdout).modulePatternCount !== 2) {
      return `二次 record 未触发下沉候选：${r2.stdout}`
    }

    const cl = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['cluster', dir, '--signals-only', '--json'])
    const smp = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['sample', dir, '--commits', '20', '--json'])
    if (cl.status !== 0) return `cluster 失败：${cl.stderr}`
    if ((JSON.parse(cl.stdout).cluster?.sinkCandidateCount ?? 0) < 1) return `cluster 未识别下沉候选：${cl.stdout}`
    if (smp.status !== 0) return `sample 失败：${smp.stderr}`
    const sj = JSON.parse(smp.stdout)
    if (sj.revertCount < 1 || !sj.reworkHotspots?.some((h) => h.file === 'src/hot.mjs')) {
      return `sample 未识别 Revert 与 48h 高频返工热点：${smp.stdout}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['govern-audit.mjs release-prep：多版本跳号采集、噪音过滤、unaccountedPublicFiles 与单提交冷启动', async () => {
  const multiDir = tmpProject({
    '.gitignore': 'node_modules/\n',
    'package.json': `${JSON.stringify({
      name: 'demo-cli',
      version: '1.0.0',
      bin: { demo: 'bin/cli.mjs' },
      engines: { node: '>=16' },
    }, null, 2)}\n`,
    'SKILL.md': '---\nname: demo-cli\nmetadata:\n  version: "1.0.0"\n---\n# demo-cli\n',
    'README.md': '# demo-cli\n',
    'bin/cli.mjs': 'export function runCli() { return 1 }\n',
    'src/core.mjs': 'export const core = 1\n',
    'test/core.test.mjs': 'export const t = 1\n',
  })
  gitInit(multiDir)
  const tagRes = gitSync(multiDir, ['tag', 'v1.0.0'], { encoding: 'utf8' })
  if (tagRes.status !== 0) throw new Error(`git tag failed: ${tagRes.stderr}`)

  const commitIn = (dir, files, msg, hasNew = false) => {
    for (const [r, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, r)), { recursive: true })
      writeFileSync(join(dir, r), c)
    }
    gitCommitFast(dir, msg, { updateOnly: !hasNew, name: 't', email: 't@t.t' })
  }

  commitIn(multiDir, { 'src/core.mjs': 'export const core = 2\n' }, 'feat: C9 Wave 4 support streaming exports')
  commitIn(multiDir, {
    'package.json': `${JSON.stringify({
      name: 'demo-cli',
      version: '1.0.0',
      bin: { demo: 'bin/cli.mjs' },
      engines: { node: '>=18' },
    }, null, 2)}\n`,
  }, 'feat!: raise minimum Node version to 18')
  commitIn(multiDir, {
    'docs/specs/261114-stream.md': '# 流式导出规范\n\nStatus: implemented\n\n支持大文件流式导出输出。\n',
    'docs/archive/todo/261114-stream.md': '# 任务单：流式导出\n\n## 完成后的记录\n\n已完成流式导出并同步文档。\n',
  }, 'docs: record stream spec and archive todo', true)
  commitIn(multiDir, { 'test/core.test.mjs': 'export const t = 2\n' }, 'feat: add test assertions for streaming')
  commitIn(multiDir, { '.gitignore': 'node_modules/\ntmp/\n' }, 'chore: ignore tmp files')
  commitIn(multiDir, { 'bin/cli.mjs': 'export function runCli() { return 2 }\n' }, 'update')

  try {
    const prepJsonRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', multiDir, '--version', '3.0.0', '--json'])
    if (prepJsonRes.status !== 0) return `release-prep 多标签跳版本失败：${prepJsonRes.stderr}`
    const parsed = JSON.parse(prepJsonRes.stdout)
    if (parsed.range?.from !== 'v1.0.0' || parsed.version?.targetTag !== 'v3.0.0') {
      return `release-prep 区间或跳版本解析错误：${JSON.stringify({ range: parsed.range, version: parsed.version })}`
    }
    if ((parsed.stats?.filteredInternalCount ?? 0) < 2) {
      return `release-prep 未过滤纯测试或配置噪音提交：${JSON.stringify(parsed.stats)}`
    }
    if (!parsed.userFacingCandidates?.some((c) => c.summary === 'support streaming exports')) {
      return `release-prep 未清洗内部前缀或漏掉功能提交：${JSON.stringify(parsed.userFacingCandidates)}`
    }
    if (!parsed.breakingSignals?.some((b) => b.field === 'engines.node')) {
      return `release-prep 未探测 engines.node 下限变化：${JSON.stringify(parsed.breakingSignals)}`
    }
    if ((parsed.implementedSpecs?.length ?? 0) !== 1 || (parsed.archivedOutcomes?.length ?? 0) !== 1) {
      return `release-prep 未采集已实现规格或归档任务摘要：${JSON.stringify({ specs: parsed.implementedSpecs, todos: parsed.archivedOutcomes })}`
    }
    if (!parsed.unaccountedPublicFiles?.some((u) => u.file === 'bin/cli.mjs')) {
      return `unaccountedPublicFiles 未检出含糊公开入口 bin/cli.mjs：${JSON.stringify(parsed.unaccountedPublicFiles)}`
    }

    const prepTextRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', multiDir, '--version', '3.0.0'])
    if (prepTextRes.status !== 0 || !prepTextRes.stdout.includes('v3.0.0') || !prepTextRes.stdout.includes('[AUDIT_ALERT]') || !prepTextRes.stdout.includes('[NEXT STEP]')) {
      return `release-prep 文本输出缺失关键字段：exit=${prepTextRes.status}\n${prepTextRes.stdout}`
    }
    return true
  } finally { rmTree(multiDir) }
}])

cases.push(['govern-audit.mjs release-prep：无标签 CHANGELOG 冷启动与非 Git 拦截', async () => {
  const changelogDir = tmpProject({
    'pyproject.toml': '[project]\nname = "py-app"\nversion = "0.2.0"\nrequires-python = ">=3.11"\n',
    'CHANGELOG.md': '# Changelog\n',
    'README.md': '# py-app\n',
  })
  gitInit(changelogDir)
  const nonGitDir = tmpProject({ 'README.md': '# plain\n' })
  try {
    const chgRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', changelogDir, '--version', '1.0.0', '--json'])
    if (chgRes.status !== 0) return `release-prep 无标签 CHANGELOG 仓失败：${chgRes.stderr}`
    const chgJson = JSON.parse(chgRes.stdout)
    if (!chgJson.range?.isInitialRelease || chgJson.notesMode?.mode !== 'changelog' || !chgJson.breakingSignals?.some((b) => b.field === 'requires-python')) {
      return `无标签 CHANGELOG 仓结果异常：${JSON.stringify({ range: chgJson.range, notesMode: chgJson.notesMode, breaking: chgJson.breakingSignals })}`
    }

    const nonGitRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', nonGitDir])
    if (nonGitRes.status === 0) return '非 Git 目录运行 release-prep 未拦截'

    return true
  } finally {
    rmTree(changelogDir)
    rmTree(nonGitDir)
  }
}])

cases.push(['测试分层控频与反膨胀治理：tests.* 正反双向检出、high-risk 核对与 flow verify {target} 替换', async () => {
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
    gitInit(posDir, { origin: 'https://github.com/acme/c31-pos.git', name: 'acme', email: 'acme@acme.test' })
    const posRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', posDir, '--json'])
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
    gitCommitFast(posDir, 'add quick-test target', { files: ['AGENTS.md'], name: 't', email: 't@t.t' })
    const startVerify = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c31-v1', '--case', '1', '--slug', 'verify-target', '--dir', posDir])
    if (startVerify.status !== 0) return `flow start c31-v1 失败：${startVerify.stderr}`
    const verTargetRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'c31-v1', '--tier', 'quick', '--target', 'test/sub.test.mjs', '--dir', posDir])
    if (verTargetRes.status !== 0 || !verTargetRes.stdout.includes('TARGET_INTERPOLATED_OK')) {
      return `flow verify --tier quick --target 未替换执行 {target}：exit=${verTargetRes.status}, out=${verTargetRes.stdout}, err=${verTargetRes.stderr}`
    }

    // 反面：干净分层仓应零 tests.* 与零 high-risk 误报
    gitInit(negDir)
    const negRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', negDir, '--json'])
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

cases.push(['异构项目四处误报根除：权威架构文档识别、Dev Profile 测试入口、TDD 命令串与 .exec/TEMP 零误报', async () => {
  const { resolveAuthoritativeTddPath } = await import('../../kit/skills/lib/shared.mjs')
  const { extractLineCommentInfo } = await import('../../kit/skills/lib/static-gates.mjs')

  // 1. 词法剥离器：Rust 'a 生命周期、C 宏常量定义、注释内跳过标记不误报
  const rustInfo = extractLineCommentInfo("fn f<'a>(x: &'a str) -> &'a str { x } // 'a", false, 'rs')
  if (rustInfo.commentText.trim() !== "'a") return `Rust lifetime 误解析：${JSON.stringify(rustInfo)}`
  const cInfo = extractLineCommentInfo('#define TEMP 64 // ok', false, 'c')
  if (/\bTEMP\b/.test(cInfo.commentText)) return `C #define TEMP 被当成注释：${JSON.stringify(cInfo)}`

  // 2. 异构仓库：ARCHITECTURE.md + Dev Profile 测试入口 + TDD CLI 命令串 + .exec() + govern-audit --save-baseline/--changed
  const archDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# arch-demo\n',
    'ARCHITECTURE.md': '# Arch\n\n运行命令 `node scripts/run-tests.mjs`。\n',
    'AGENTS.md': [
      '# arch-demo',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: node scripts/run-tests.mjs',
      'full-test: node scripts/run-tests.mjs',
      '```',
    ].join('\n'),
    'scripts/run-tests.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
    'src/parser.mjs': "const s = 'x'; export const r = /a/.exec(`\\n${s}`)\n",
  })
  gitInit(archDir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    if (resolveAuthoritativeTddPath(archDir) !== 'ARCHITECTURE.md') {
      return `未识别 ARCHITECTURE.md：${resolveAuthoritativeTddPath(archDir)}`
    }
    const noTddAgents = '# x\n\n## 取舍\n\n- `no-tdd`: 纯脚本无架构文档\n'
    if (resolveAuthoritativeTddPath(archDir, noTddAgents) !== null) {
      return '声明 no-tdd 时未返回 null'
    }

    const aud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', archDir, '--all', '--json'])
    if (aud.status !== 0) return `govern-audit 失败：${aud.stderr}`
    const aj = JSON.parse(aud.stdout)
    const ids = aj.findings.map((f) => f.id)
    for (const forbidden of ['docs.missing-tdd', 'tests.missing-suite']) {
      if (ids.includes(forbidden)) return `异构项目出现误报 ${forbidden}：${JSON.stringify(ids)}`
    }
    if (ids.some((id) => id.startsWith('docs.tdd-stale-path.node ') || id.startsWith('sec.dynamic-exec.'))) {
      return `CLI 命令串或 RegExp.exec 仍被误报：${JSON.stringify(ids)}`
    }

    // 反面：真正不存在的命令脚本路径必须报 docs.tdd-stale-path.scripts/ghost.mjs；真无测试入口必须报 tests.missing-suite
    writeFileSync(join(archDir, 'ARCHITECTURE.md'), '# Arch\n\n`node scripts/ghost.mjs` 与 `src/missing.mjs`。\n')
    writeFileSync(join(archDir, 'AGENTS.md'), '# arch-demo\n\n## Dev Profile\n```yaml\nquick-test: none\n```\n')
    const audBad = JSON.parse((await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', archDir, '--all', '--json'])).stdout)
    const badIds = audBad.findings.map((f) => f.id)
    if (!badIds.includes('docs.tdd-stale-path.scripts/ghost.mjs') || !badIds.includes('tests.missing-suite')) {
      return `反面校验漏报真实缺陷：${JSON.stringify(badIds)}`
    }
    return true
  } finally { rmTree(archDir) }
}])

cases.push(['claims.mjs + review.mjs：dirs 并入 claim.path、claim.script 核对与零误报防线', async () => {
  const { claimsOf, verifyClaims } = await import('../lib/claims.mjs')
  const { reviewProject } = await import('../review.mjs')

  const dir = tmpProject({
    'package.json': JSON.stringify({
      name: 'claims-w3',
      version: '1.0.0',
      scripts: { test: 'node --test', lint: 'echo ok' },
    }),
    'README.md': '# claims-w3\n\n测试契约脚本与目录前缀核对的仓库说明。\n',
    'docs/TDD.md': '# TDD\n',
    'src/core/app.mjs': 'export const app = 1\n',
    'AGENTS.md': [
      '# claims-w3',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run nonexistent-full',
      'high-risk: src/core/, src/payments/, src/legacy/**, .github/workflows/, none',
      'do-not-edit: docs/missing-archive/, .worktrees/',
      '```',
      '',
      '## 环境与构建验证',
      '',
      '```sh',
      'npm run lint',
      'pnpm run nonexistent-check',
      'npm test # 注释里带 npm run <placeholder> 不应提取',
      '```',
      '',
      '## 高风险路径',
      '',
      '| 路径 | 原因 |',
      '| --- | --- |',
      '| `src/core/` | 核心目录存在 |',
      '| `src/removed-dir/` | 已删除目录 |',
      '',
    ].join('\n'),
  })
  gitInit(dir)

  try {
    const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const c = claimsOf(agentsText)
    for (const expectedDir of ['src/core/', 'src/payments/', 'src/removed-dir/', 'docs/missing-archive/']) {
      if (!c.dirs.includes(expectedDir)) return `claimsOf 未提取目录前缀 ${expectedDir}：${JSON.stringify(c.dirs)}`
    }
    if (c.dirs.some((d) => d.includes('legacy') || d.includes('.github') || d.includes('.worktrees'))) {
      return `claimsOf 误把通配符或可选设施列入 dirs：${JSON.stringify(c.dirs)}`
    }
    for (const expectedScript of ['test', 'lint', 'nonexistent-full', 'nonexistent-check']) {
      if (!c.scripts.includes(expectedScript)) return `claimsOf 未提取脚本 ${expectedScript}：${JSON.stringify(c.scripts)}`
    }
    if (c.scripts.some((s) => s.includes('placeholder'))) return `claimsOf 误从注释提取脚本：${JSON.stringify(c.scripts)}`

    const rev = await reviewProject(dir)
    const missingIds = new Set(rev.missing.map((f) => f.id))
    if (!missingIds.has('claim.path')) return `review.mjs 未把失效目录前缀报进 claim.path：${JSON.stringify([...missingIds])}`
    if (!missingIds.has('claim.script')) return `review.mjs 未拦截失效 package.json 脚本：${JSON.stringify([...missingIds])}`

    // 反面防误报：无 packageScripts 时不输出假绿也不误报；本仓自身 0 缺失项
    const noPkgClaims = verifyClaims(agentsText, { conventions: { defaultBranch: 'main' }, ecosystem: {} }, () => true)
    if (noPkgClaims.some((x) => x.id === 'claim.script')) {
      return `无 package.json 脚本清单时不应产生 claim.script 条目：${JSON.stringify(noPkgClaims)}`
    }
    const selfRev = await reviewProject(SKILL_ROOT)
    if (selfRev.missing.length > 0) return `本仓库自身 review 存在误报缺失项：${JSON.stringify(selfRev.missing)}`
    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['govern-docs.mjs：跳过 docs/archive/ 历史归档死链并持续拦截活跃目录死链（include-master-prd 协同）', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# archive-deadlink-demo\n',
    'AGENTS.md': '# archive-deadlink-demo\n',
    'docs/TDD.md': '# TDD\n',
    'docs/archive/specs/261115-issue11-m1-spec.md': '# Archived M1\n\n- [总控 PRD](../../prd/261115-master-prd.md)\n',
    'docs/specs/261116-issue12-m2-spec.md': '# Active M2\n\n- [坏掉的活跃链接](../../prd/missing-active.md)\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    const res = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
    if (res.status !== 0) return `govern-audit 失败：${res.stderr}`
    const ids = (JSON.parse(res.stdout).findings ?? []).map((f) => f.id)
    if (ids.some((id) => id.startsWith('docs.dead-link.docs/archive/'))) {
      return `govern-docs 未跳过 docs/archive/ 历史归档死链：${JSON.stringify(ids)}`
    }
    if (!ids.some((id) => id.startsWith('docs.dead-link.docs/specs/261116-issue12-m2-spec.md:'))) {
      return `govern-docs 漏报活跃目录死链：${JSON.stringify(ids)}`
    }
    return true
  } finally {
    rmTree(dir)
  }
}])

// ── 空壳 TDD 比没有更糟：它看起来像有 ────────────────────────────────
//
// 四种形状各自能骗过一道检查：模板原样（占位符还在）、只有骨架（只列模块名）、
// 短到不可能（三五行）、以及文件完全不存在。第四种由 docs.missing-tdd 管，
// 前三种必须由 docs.tdd-shell 判红，且档位是 high——medium 的条目 --strict 看不见。
cases.push(['空壳 TDD 判红（high，--strict 阻断），只有注释里出现的符号不算已定义', async () => {
  const MODULE = 'export function runCore() { return 1 }\n'
  const shapes = [
    ['只列模块名', '# TDD\n\n## 模块与目录职责\n\n- src/app.mjs\n'],
    ['四行', '# TDD\n\n本仓是一个小工具。\n\n它做一件事。\n'],
    ['模板原样', '# TDD\n\n## 一、文档信息\n\n| 项 | 值 |\n| --- | --- |\n| 版本 | {{VERSION}} |\n\n## 二、背景\n\n{{BACKGROUND}}\n'],
  ]
  for (const [label, body] of shapes) {
    const dir = tmpProject({
      'README.md': '# shell\n\n空壳 TDD 判据测试仓。\n',
      'AGENTS.md': '# shell\n\n## 取舍\n\n- `no-ci`：不配\n',
      'src/app.mjs': MODULE,
      'docs/TDD.md': body,
    })
    try {
      const r = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--all', '--json'])
      let parsed
      try { parsed = JSON.parse(r.stdout) } catch { return `${label}：govern-audit --json 解析失败（顶层字段应为 findings）：${(r.stdout || r.stderr || '').slice(0, 160)}` }
      const shell = (parsed.findings ?? []).find((f) => f.id === 'docs.tdd-shell')
      if (!shell) return `${label}：没有产出 docs.tdd-shell`
      if (shell.severity !== 'high') return `${label}：docs.tdd-shell 的 severity 是 ${shell.severity}，medium 的条目 --strict 看不见`
      const strict = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--all', '--strict'])
      if (strict.status === 0) return `${label}：--strict 放行了 high 档的空壳 TDD`
    } finally { rmTree(dir) }
  }

  // 反向一：真的写了架构的 TDD 不许被判成空壳。
  const good = tmpProject({
    'README.md': '# good\n\n完整 TDD 不该被误判成空壳。\n',
    'AGENTS.md': '# good\n\n## 取舍\n\n- `no-ci`：不配\n',
    'src/app.mjs': MODULE,
    'docs/TDD.md': [
      '# TDD', '',
      '## 文档信息', '', '| 项 | 内容 |', '| --- | --- |', '| 文档版本 | 1.0 |', '| 最近更新 | 2026-01-01 |', '| 关联工程契约 | AGENTS.md |', '',
      '## 背景与范围', '', '- 核心定位：一个只做一件事的小工具。', '- 非目标：不做插件体系。', '- 服务对象：维护者本人。', '',
      '## 架构全景', '', '- `src/app.mjs`：唯一入口，负责跑核心逻辑。', '',
      '## 核心流程', '', '- 调用 `runCore()` -> 返回结果。', '',
      '## 不变量', '', '- 破坏即事故：改动接口必须同步 AGENTS.md 的 Dev Profile。', '',
    ].join('\n'),
  })
  try {
    const r = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', good, '--all', '--json'])
    const parsed = JSON.parse(r.stdout)
    if ((parsed.findings ?? []).some((f) => f.id === 'docs.tdd-shell')) {
      return '内容完整的 TDD 被判成了空壳——判据在惩罚写得好的仓'
    }
  } finally { rmTree(good) }

  // 反向二：只在注释里出现的符号名，不得被当成「已定义」。
  const { extractSymbols } = await import('../../kit/skills/lib/symbol-index.mjs')
  const commented = [
    '// 这类东西以前写成 export function LegacyHelper() {}',
    '/* export const OLD = 1 */',
    'export function Live() { return 1 }',
  ].join('\n')
  const got = extractSymbols(commented, 'mjs')
  if (got.symbols.includes('LegacyHelper') || got.symbols.includes('OLD')) {
    return `注释里的符号被当成了已定义：${JSON.stringify(got.symbols)}`
  }
  if (!got.symbols.includes('Live')) return `真定义没被抽出来：${JSON.stringify(got.symbols)}`
  // 反面：没有规则的语言返回 unsupported，不是空数组冒充「没符号」。
  const unsupported = extractSymbols('main = pure ()', 'hs')
  if (unsupported.status !== 'unsupported' || unsupported.supported !== false) {
    return `没有符号规则的语言没有返回 unsupported：${JSON.stringify(unsupported)}`
  }
  return true
}])

}
