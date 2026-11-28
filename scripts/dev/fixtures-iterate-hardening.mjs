/**
 * fixtures-iterate-hardening.mjs —— dev-iterate 测试发现与执行加固双向回归断言：
 *   1. 反面：CI `run:` 命令带必需参数（如 `node scripts/check-foo.mjs a.md --check`）完整保留参数直跑，
 *      严禁被剥参成裸 `node --test scripts/check-foo.mjs`；同时跳过写盘/发布/元聚合门禁且保持工作区干净。
 *   2. 正面：含标准原生 `*.test.mjs` 的仓库仍通过 `node --test` 并发分片执行，不混入裸 CI 脚本，
 *      真失败测试仍稳定返回 `ok: false` 并触发信号写入与 `--escalate` 建单。
 *   3. 串行/重型调度与超时：基准/重型命令标 `serial: true` 与默认放宽超时，同时严格尊重显式 `--timeout-ms`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runIterationSuites } from '../../kit/skills/dev-iterate/scripts/iterate.mjs'
import { collectConfiguredVerificationCommands } from '../../kit/skills/lib/suite-inventory.mjs'
import { gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const ITER_SCRIPT = 'kit/skills/dev-iterate/scripts/iterate.mjs'

export function registerIterateHardeningCases(cases) {
  cases.push(['iterate-hardening：CI 带参验证命令完整保参、跳过写盘/发布/元聚合、零工作区污染与失败捕获', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'cfg-only-repo', type: 'module' }, null, 2),
      'README.md': '# Demo\n',
      'a.md': '# Doc A\n',
      'AGENTS.md': [
        '# cfg-only-repo',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: node scripts/check-foo.mjs a.md --check',
        'full-test: node scripts/check-foo.mjs a.md --check',
        'smoke-verify: none',
        'merge-gate: node scripts/merge-gate.mjs',
        '```',
        '',
      ].join('\n'),
      '.github/workflows/check.yml': [
        'name: check',
        'on:',
        '  push:',
        '    branches: [main]',
        '  pull_request:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  gates:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: check foo with required args',
        '        run: node scripts/check-foo.mjs a.md --check',
        '      - name: review with bash fallback',
        '        run: |',
        '          node scripts/review-check.mjs . || {',
        '            echo "::error::review failed"',
        '            exit 1',
        '          }',
        '      - name: mutator without check flag must be skipped',
        '        run: node scripts/compose-mutator.mjs .',
        '      - name: fixtures runner must not be mistaken for fix mutator',
        '        run: node scripts/fixtures.mjs',
        '      - name: benchmark runs serially',
        '        run: node scripts/bench-sample.mjs',
      ].join('\n'),
      '.github/workflows/release.yml': [
        'name: release',
        'on:',
        '  push:',
        '    tags: ["v*"]',
        'permissions:',
        '  contents: write',
        'jobs:',
        '  rel:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: forbidden release step',
        '        run: node scripts/release-boom.mjs',
      ].join('\n'),
      'scripts/check-foo.mjs': [
        "import { existsSync } from 'node:fs'",
        'const args = process.argv.slice(2)',
        "if (args[0] !== 'a.md' || !args.includes('--check') || !existsSync(args[0])) {",
        "  process.stderr.write(`missing required args: ${JSON.stringify(args)}\\n`)",
        '  process.exit(1)',
        '}',
        "process.stdout.write('CHECK_FOO_ARGS_OK\\n')",
      ].join('\n'),
      'scripts/review-check.mjs': [
        "if (process.argv[2] !== '.') { process.stderr.write('missing dot arg\\n'); process.exit(1) }",
        "process.stdout.write('REVIEW_CHECK_OK\\n')",
      ].join('\n'),
      'scripts/compose-mutator.mjs': [
        "import { writeFileSync } from 'node:fs'",
        "writeFileSync('MUTATED.txt', 'should never run\\n', 'utf8')",
        'process.exit(1)',
      ].join('\n'),
      'scripts/merge-gate.mjs': [
        "process.stderr.write('merge-gate must not run recursively when individual steps exist\\n')",
        'process.exit(1)',
      ].join('\n'),
      'scripts/release-boom.mjs': [
        "process.stderr.write('release workflow must be excluded\\n')",
        'process.exit(1)',
      ].join('\n'),
      'scripts/bench-sample.mjs': [
        "process.stdout.write('BENCH_SERIAL_OK\\n')",
      ].join('\n'),
      'scripts/fixtures.mjs': [
        "process.stdout.write('FIXTURES_RUNNER_OK\\n')",
      ].join('\n'),
    })
    const failDir = tmpProject({
      'package.json': JSON.stringify({ name: 'cfg-fail-repo', type: 'module' }, null, 2),
      'AGENTS.md': '# cfg-fail-repo\n\n```yaml\nquick-test: node scripts/check-fail.mjs --strict\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'scripts/check-fail.mjs': "process.stderr.write('STRICT_CHECK_FAILED\\n'); process.exit(1)\n",
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      gitInit(failDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

      const discovered = collectConfiguredVerificationCommands(dir)
      const cmds = discovered.map((d) => d.cmd)
      if (!cmds.includes('node scripts/check-foo.mjs a.md --check')) {
        return `未完整保留带参 CI 命令: ${JSON.stringify(discovered)}`
      }
      if (!cmds.includes('node scripts/review-check.mjs .')) {
        return `未清洗 bash || { ... } 错误包装块: ${JSON.stringify(discovered)}`
      }
      if (cmds.some((c) => c.includes('compose-mutator') || c.includes('merge-gate') || c.includes('release-boom'))) {
        return `未排除写盘/元聚合/发布命令: ${JSON.stringify(cmds)}`
      }
      const benchEntry = discovered.find((d) => d.cmd.includes('bench-sample.mjs'))
      if (!benchEntry?.serial || !benchEntry?.heavy) {
        return `基准命令未标记为 serial/heavy: ${JSON.stringify(benchEntry)}`
      }

      // 真实 CLI 执行 iterate run --concurrency 4 --no-signals --json
      const runRes = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--concurrency', '4', '--no-signals', '--json'])
      if (runRes.status !== 0) {
        return `带参 CI 验证命令被剥参或执行失败: exit=${runRes.status} out=${runRes.stdout} err=${runRes.stderr}`
      }
      const runJson = JSON.parse(runRes.stdout)
      if (!runJson.ok || runJson.failed !== 0 || runJson.passed !== 4) {
        return `执行汇总异常: ${JSON.stringify(runJson)}`
      }
      const fooItem = runJson.results.find((r) => r.command === 'node scripts/check-foo.mjs a.md --check')
      const fixItem = runJson.results.find((r) => r.command === 'node scripts/fixtures.mjs')
      const benchItem = runJson.results.find((r) => r.command === 'node scripts/bench-sample.mjs')
      if (!fooItem?.ok || !fooItem.stdout.includes('CHECK_FOO_ARGS_OK') || fooItem.kind !== 'configured-command') {
        return `check-foo 未保留完整参数执行: ${JSON.stringify(fooItem)}`
      }
      if (!fixItem?.ok || !fixItem.stdout.includes('FIXTURES_RUNNER_OK') || fixItem.executionMode !== 'serial') {
        return `fixtures.mjs 被误判过滤或未串行执行: ${JSON.stringify(fixItem)}`
      }
      if (!benchItem?.ok || benchItem.executionMode !== 'serial') {
        return `bench-sample 未按 serial 模式执行: ${JSON.stringify(benchItem)}`
      }
      if (existsSync(join(dir, 'MUTATED.txt'))) {
        return '写盘脚本 compose-mutator.mjs 被误执行导致工作区污染'
      }
      const gitSt = gitSync(dir, ['status', '--porcelain'], { encoding: 'utf8' })
      if (String(gitSt.stdout ?? '').trim() !== '') {
        return `iterate run 污染了工作区 git status: ${gitSt.stdout}`
      }

      // 反面：真实失败的配置验证命令仍被捕获（ok: false + 写信号 + 显式 --escalate 建单）
      const failRun = await runIterationSuites(failDir, {
        concurrency: 2,
        escalate: true,
        writeSignals: true,
      })
      if (failRun.ok || failRun.failed !== 1 || failRun.signalsWritten < 1 || failRun.escalations.length !== 1) {
        return `失败配置命令未返回 ok:false 或未写信号/升级: ${JSON.stringify(failRun)}`
      }
      if (!String(failRun.results[0]?.stderr ?? '').includes('STRICT_CHECK_FAILED')) {
        return `失败 stderr 未透传: ${JSON.stringify(failRun.results[0])}`
      }
      return true
    } finally { rmTree(dir); rmTree(failDir) }
  }])

  cases.push(['iterate-hardening：原生 *.test.mjs 仓并发分片运行、不混入 CI 脚本且保留显式 --timeout-ms 语义', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'native-tests-repo', type: 'module' }, null, 2),
      'src/math.mjs': 'export const mul = (a, b) => a * b\n',
      '.github/workflows/check.yml': [
        'name: check',
        'on: [push]',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  t:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: node scripts/ci-only-boom.mjs --flag',
      ].join('\n'),
      'scripts/ci-only-boom.mjs': "process.stderr.write('should not mix CI script when native tests exist\\n'); process.exit(1)\n",
      'tests/integration/a.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { mul } from '../../src/math.mjs'\ntest('a', () => { assert.equal(mul(3, 4), 12) })\n",
      'tests/integration/b.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { mul } from '../../src/math.mjs'\ntest('b', () => { assert.equal(mul(5, 6), 30) })\n",
      'tests/integration/c-fail.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { mul } from '../../src/math.mjs'\ntest('c fail', () => { assert.equal(mul(2, 2), 999) })\n",
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      // 1. 仅传通过的原生测试 targets -> 并发分片跑绿
      const passRes = await runIterationSuites(dir, {
        targets: ['tests/integration/a.test.mjs', 'tests/integration/b.test.mjs'],
        concurrency: 2,
        writeSignals: false,
      })
      if (!passRes.ok || passRes.passed !== 2 || passRes.failed !== 0 || passRes.concurrency !== 2) {
        return `原生测试并发分片失败: ${JSON.stringify(passRes)}`
      }
      if (passRes.results.some((r) => r.kind !== 'native-test' || r.runner !== 'node')) {
        return `原生测试运行器元数据异常: ${JSON.stringify(passRes.results)}`
      }

      // 2. 自动发现模式（不传 targets）：只跑 3 个原生 *.test.mjs，绝不混入 ci-only-boom.mjs
      const autoRes = await runIterationSuites(dir, {
        concurrency: 3,
        escalate: true,
        writeSignals: true,
      })
      if (autoRes.ok || autoRes.total !== 3 || autoRes.passed !== 2 || autoRes.failed !== 1) {
        return `原生测试自动发现计数或隔离异常: ${JSON.stringify(autoRes)}`
      }
      if (autoRes.results.some((r) => r.file.includes('ci-only-boom'))) {
        return `存在原生测试时错误混入了 CI 脚本: ${JSON.stringify(autoRes.results)}`
      }
      if (autoRes.signalsWritten !== 1 || autoRes.escalations.length !== 1) {
        return `原生失败测试未触发信号/升级: signals=${autoRes.signalsWritten} esc=${autoRes.escalations.length}`
      }
      const mathAfter = readFileSync(join(dir, 'src/math.mjs'), 'utf8')
      if (!mathAfter.includes('a * b')) return 'runIterationSuites 意外修改了业务源码'
      return true
    } finally { rmTree(dir) }
  }])
}
