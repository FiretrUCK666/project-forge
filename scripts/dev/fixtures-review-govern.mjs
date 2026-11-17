/**
 * fixtures-review-govern.mjs —— 审查与治理（不依赖 .git/HEAD，可跑在 verify-injections 沙盒里）：
 *   死检查（zero-assertion / mock-tautology）与断言正则的误伤边界
 *   Mermaid 标签宽度（含 sequenceDiagram / stateDiagram-v2 / erDiagram）
 *   TDD 漂移检测与 no-tdd 豁免 / signals.jsonl 回写与 retro / zip 完整性
 */


import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readZip, stripCommonPrefix, writeZip } from '../zip.mjs'
import { gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

const FIXTURES_M4_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function registerReviewGovernCases(cases) {
  cases.push(['救活 zero-assertion/mock-tautology 死检查与纯 ASSERTION_RE 大小写敏感(I70)', async () => {
    const { ASSERTION_RE, GATE_ASSERTION_RE } = await import('../../kit/skills/lib/shared.mjs')
    if (ASSERTION_RE !== GATE_ASSERTION_RE) return 'GATE_ASSERTION_RE 未与 ASSERTION_RE 保持兼容导出'

    for (const nonAssert of [
      "it('works', () => {})",
      "test('case', () => {})",
      'def test_empty():',
      '#[test]',
      '@Test',
      'func TestMain(t *testing.T)',
      "const mod = require('./mod')",
      'check_something()',
    ]) {
      if (ASSERTION_RE.test(nonAssert)) {
        return `zero-assertion/mock-tautology 死检查回退失效：ASSERTION_RE 误匹配 "${nonAssert}"`
      }
    }
    for (const realAssert of [
      'REQUIRE(x == 1)',
      'CHECK(ok)',
      'ASSERT_EQ(a, b)',
      'EXPECT_TRUE(ok)',
      'assert_eq!(a, b)',
      'assert.strictEqual(a, b)',
      'expect(a).toBe(1)',
      'assert x == 1',
    ]) {
      if (!ASSERTION_RE.test(realAssert)) return `合法断言 "${realAssert}" 未被 ASSERTION_RE 匹配`
    }

    const dir = tmpProject({
      'package.json': '{"name":"probe-govern","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'AGENTS.md': '# probe-govern\n\n```yaml\nquick-test: node --test\nfull-test: node --test\n```\n',
      'test/empty-it.test.mjs': "import { it } from 'node:test'\nconst dep = require('./x')\nit('empty', () => { void dep })\n",
      'tests/test_doc_only.py': 'def test_only_docstring():\n    """assert True"""\n    x = 1\n',
      'test/mock-it.test.mjs': "import { it } from 'node:test'\nit('mock only', () => {\n  const f1 = vi.fn(); const f2 = vi.fn(); const f3 = vi.fn(); const f4 = vi.fn(); const f5 = vi.fn();\n  f1(); expect(f1).toHaveBeenCalledWith(1)\n})\n",
      'test/valid.test.mjs': "import { it } from 'node:test'\nimport assert from 'node:assert/strict'\nit('ok', () => { const dep = require('./x'); assert.ok(dep || true) })\n",
      'test/valid_cpp.test.cpp': 'void t() { REQUIRE(1 == 1); }\n',
    })
    gitInit(dir)
    try {
      const aud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--categories', 'tests', '--json'])
      if (aud.status !== 0) return `govern-audit tests 失败：${aud.stderr}`
      const ids = (JSON.parse(aud.stdout).findings ?? []).map((f) => f.id)
      for (const want of [
        'tests.zero-assertion.test/empty-it.test.mjs',
        'tests.zero-assertion.tests/test_doc_only.py',
        'tests.mock-tautology.test/mock-it.test.mjs',
      ]) {
        if (!ids.includes(want)) return `zero-assertion/mock-tautology 死检查回退失效：未检出 ${want}（actual=${JSON.stringify(ids)}）`
      }
      if (ids.includes('tests.zero-assertion.test/valid.test.mjs') || ids.includes('tests.zero-assertion.test/valid_cpp.test.cpp')) {
        return `正常断言测试误报 zero-assertion：${JSON.stringify(ids)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Python 三引号词法、deleted-ci-step(I72) 与整块删空 test 保留 deleted-assertion', async () => {
    const { detectGateWeakeningInEntry, extractLineCommentInfo, stripCodeCommentsLines } = await import('../../kit/skills/lib/shared.mjs')

    // 1. Python triple quotes (single-line & multi-line + r""" + trailing # comment)
    const pyLines = [
      'doc = r"""TEMP hack inside docstring',
      'assert False  # not real assert or comment',
      '"""  # real trailing comment',
      'x = """single line assert True""" # after close',
    ]
    let blk = false
    const parsed = pyLines.map((l) => {
      const info = extractLineCommentInfo(l, blk, 'py')
      blk = info.nextInBlock
      return info
    })
    if (blk !== false) return `Python 三引号块未正常闭合：${blk}`
    if (parsed[1].codeText.trim() !== '' || parsed[1].commentText !== '') {
      return `Python 三引号内部泄漏进 codeText 或 commentText：${JSON.stringify(parsed[1])}`
    }
    if (parsed[2].commentText !== 'real trailing comment' || parsed[3].commentText !== 'after close' || parsed[3].codeText.includes('assert')) {
      return `Python 三引号闭合后同行注释或代码过滤异常：${JSON.stringify(parsed.slice(2))}`
    }
    const strippedPy = stripCodeCommentsLines('def f():\n    """\n    TEMP workaround\n    """\n    return 1\n', 'py')
    if (strippedPy.join('\n').includes('TEMP')) return `stripCodeCommentsLines 未剥离 Python 三引号：${strippedPy}`

    // 2. deleted-ci-step positive & negative
    const wfDeleted = detectGateWeakeningInEntry({
      file: '.github/workflows/ci.yml',
      status: 'M',
      removed: ['      - name: Run Unit Tests', '        run: npm test'],
      added: ['      - name: Skip', '        run: echo ok'],
    })
    if (!wfDeleted.some((h) => h.type === 'deleted-ci-step')) {
      return `deleted-ci-step 未拦截删除 CI 验证步骤：${JSON.stringify(wfDeleted)}`
    }

    const wfCommentedOut = detectGateWeakeningInEntry({
      file: '.github/workflows/ci.yml',
      status: 'M',
      removed: ['      - run: pytest'],
      added: ['      # - run: pytest'],
    })
    if (!wfCommentedOut.some((h) => h.type === 'deleted-ci-step')) {
      return `deleted-ci-step 未拦截将 CI 步骤注释掉：${JSON.stringify(wfCommentedOut)}`
    }

    const wfRenameOnly = detectGateWeakeningInEntry({
      file: '.github/workflows/ci.yml',
      status: 'M',
      removed: ['      # old comment', '      - name: Old Name', '        run: npm test'],
      added: ['      - name: New Check Name', '        run: npm test'],
    })
    if (wfRenameOnly.some((h) => h.type === 'deleted-ci-step')) {
      return `纯重命名步骤误报 deleted-ci-step：${JSON.stringify(wfRenameOnly)}`
    }

    const wfRunnerTemp = detectGateWeakeningInEntry({
      file: '.github/workflows/check.yml',
      status: 'M',
      removed: ['          node scripts/dev/preflight.mjs --package package-list.txt'],
      added: ['          node scripts/dev/preflight.mjs --package "${{ runner.temp }}/package-list.txt"'],
    })
    if (wfRunnerTemp.some((h) => h.type === 'deleted-ci-step')) {
      return `runner.temp 路径迁移误报 deleted-ci-step：${JSON.stringify(wfRunnerTemp)}`
    }

    // 3. Whole deleted empty test still triggers deleted-assertion
    const emptyTestDel = detectGateWeakeningInEntry({
      file: 'test/a.test.mjs',
      status: 'M',
      removed: ["test('empty', () => {})"],
      added: [],
    })
    if (!emptyTestDel.some((h) => h.type === 'deleted-assertion')) {
      return `整块删除空 test 未触发 deleted-assertion：${JSON.stringify(emptyTestDel)}`
    }

    // 4. flushAndExit re-exports & drains >128KB stdout JSON cleanly without waiting on live timer
    const sharedMod = await import('../../kit/skills/lib/shared.mjs')
    const cliMod = await import('../../kit/skills/lib/cli.mjs')
    const textMod = await import('../lib/text.mjs')
    if (sharedMod.flushAndExit !== cliMod.flushAndExit || textMod.flushAndExit !== cliMod.flushAndExit) {
      return 'flushAndExit 未在 shared.mjs 与 scripts/lib/text.mjs 单源重导出'
    }
    const cliUrl = pathToFileURL(join(FIXTURES_M4_ROOT, 'kit', 'skills', 'lib', 'cli.mjs')).href
    const flushRes = await new Promise((done) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `import { flushAndExit } from ${JSON.stringify(cliUrl)}; setTimeout(() => {}, 60000); process.stdout.write(JSON.stringify({ big: 'x'.repeat(196608) }) + '\\n'); await flushAndExit(0)`,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      let err = ''
      const wd = setTimeout(() => { try { child.kill('SIGKILL') } catch {} done({ timedOut: true, out, err }) }, 10000)
      wd.unref?.()
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { err += d })
      child.on('close', (code) => { clearTimeout(wd); done({ code, out, err, timedOut: false }) })
      child.on('error', (e) => { clearTimeout(wd); done({ code: 1, out, err: e.message, timedOut: false }) })
    })
    if (flushRes.timedOut || flushRes.code !== 0) {
      return `flushAndExit 退出失败或挂起：${JSON.stringify({ timedOut: flushRes.timedOut, code: flushRes.code, err: flushRes.err })}`
    }
    try {
      const parsedFlush = JSON.parse(flushRes.out)
      if (parsedFlush?.big?.length !== 196608) {
        return `flushAndExit 大 JSON 输出长度不一致：${parsedFlush?.big?.length}`
      }
    } catch (e) {
      return `flushAndExit 大 JSON 管道输出被截断：${e.message}`
    }

    // 5. execShellCommand & execSafe close stdin (EOF immediate), handle ENOENT/timeout safely, supportsSafeDetachedSpawn skips macOS Node <20 detached fork() deadlock, and killProcessTree(..., false) cleanly terminates
    const { execSafe, execShellCommand, killProcessTree, supportsSafeDetachedSpawn } = await import('../../kit/skills/lib/exec.mjs')
    if (supportsSafeDetachedSpawn({ platform: 'darwin', nodeVersion: '18.20.4' }) !== false
      || supportsSafeDetachedSpawn({ platform: 'darwin', nodeVersion: '19.9.0' }) !== false
      || supportsSafeDetachedSpawn({ platform: 'darwin', nodeVersion: '20.0.0' }) !== true
      || supportsSafeDetachedSpawn({ platform: 'darwin', nodeVersion: '22.11.0' }) !== true
      || supportsSafeDetachedSpawn({ platform: 'linux', nodeVersion: '18.20.4' }) !== true
      || supportsSafeDetachedSpawn({ platform: 'win32', nodeVersion: '22.0.0' }) !== false) {
      return 'supportsSafeDetachedSpawn 跨平台/版本判定异常'
    }
    const stdinCmd = `${JSON.stringify(process.execPath)} -e "const t=setTimeout(()=>process.exit(3),5000);process.stdin.resume();process.stdin.on('end',()=>{clearTimeout(t);process.stdout.write('eof');});"`
    const resZero = await execShellCommand(stdinCmd, FIXTURES_M4_ROOT, { timeout: 6000 })
    if (!resZero.ok || resZero.code !== 0 || resZero.timedOut || resZero.stdout !== 'eof') {
      return `execShellCommand stdio 关闭或正退出异常：${JSON.stringify(resZero)}`
    }
    const resFail = await execShellCommand(`${JSON.stringify(process.execPath)} -e "process.exit(2)"`, FIXTURES_M4_ROOT, { timeout: 6000 })
    if (resFail.ok || resFail.code !== 2 || resFail.timedOut) {
      return `execShellCommand 负退出码异常：${JSON.stringify(resFail)}`
    }
    const safeEof = await execSafe(process.execPath, ['-e', "const t=setTimeout(()=>process.exit(3),5000);process.stdin.resume();process.stdin.on('end',()=>{clearTimeout(t);process.stdout.write('safe-eof');});"], { cwd: FIXTURES_M4_ROOT, timeout: 6000 })
    if (!safeEof.ok || safeEof.code !== 0 || safeEof.timedOut || safeEof.stdout !== 'safe-eof') {
      return `execSafe 无 input 时未关闭 stdin 导致挂起或异常：${JSON.stringify(safeEof)}`
    }
    const safeEnoent = await execSafe('definitely-nonexistent-cmd-pf-m4-xyz', [], { cwd: FIXTURES_M4_ROOT, timeout: 3000 })
    if (safeEnoent.ok || !safeEnoent.missing || safeEnoent.timedOut) {
      return `execSafe ENOENT 未正确标记 missing=true：${JSON.stringify(safeEnoent)}`
    }
    const safeTimeout = await execSafe(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { cwd: FIXTURES_M4_ROOT, timeout: 150 })
    if (safeTimeout.ok || !safeTimeout.timedOut) {
      return `execSafe 超时强杀未正确触发 timedOut=true：${JSON.stringify(safeTimeout)}`
    }
    const directKillOk = await new Promise((done) => {
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
      const guard = setTimeout(() => { try { sleeper.kill('SIGKILL') } catch {} done(false) }, 3000)
      guard.unref?.()
      sleeper.on('close', () => { clearTimeout(guard); done(true) })
      killProcessTree(sleeper, false)
    })
    if (!directKillOk) return 'killProcessTree(child, false) 未能在 3000ms 内终止直属子进程'
    return true
  }])

  cases.push(['全图表 Mermaid 16/12 (sequenceDiagram(I71)/stateDiagram-v2/erDiagram) 零误伤', async () => {
    const { checkMermaidLabelWidth } = await import('../../kit/skills/lib/shared.mjs')

    const validMd = [
      '```mermaid',
      'sequenceDiagram',
      '  participant U as "用户"',
      '  loop 重试循环',
      '    U->>S: "发送请求"',
      '    Note right of S: 校验通过',
      '  end',
      '```',
      '',
      '```mermaid',
      'stateDiagram-v2',
      '  state "待审核" as S1',
      '  S1 --> S2: "按参数恢复"',
      '```',
      '',
      '```mermaid',
      'erDiagram',
      '  CUSTOMER ||--o{ ORDER : "下单"',
      '  CUSTOMER {',
      '    string very_long_attribute_name_inside_entity_block',
      '  }',
      '```',
    ].join('\n')
    const okRes = checkMermaidLabelWidth(validMd)
    if (!okRes.ok || okRes.checkedBlocks !== 3) {
      return `合法 sequence/state/erDiagram 被误报：${JSON.stringify(okRes)}`
    }

    const badSeq = checkMermaidLabelWidth([
      '```mermaid',
      'sequenceDiagram',
      '  participant A as 这是一个非常长的参与者名称一定超限',
      '  A->>B: 这是一条超过十二宽度的消息<br/>标签',
      '  Note right of B: 这条注释也绝对超十二宽',
      '```',
    ].join('\n'))
    if (badSeq.ok || badSeq.violations.length < 4) {
      return `sequenceDiagram 超宽或 HTML 未拦截：${JSON.stringify(badSeq)}`
    }

    const badState = checkMermaidLabelWidth([
      '```mermaid',
      'stateDiagram-v2',
      '  state "这是一个超过十六宽度的状态节点" as S1',
      '  S1 --> S2: "仅 --restore 恢复"',
      '```',
    ].join('\n'))
    if (badState.ok || badState.violations.length < 2) {
      return `stateDiagram-v2 超宽未拦截：${JSON.stringify(badState)}`
    }

    const badEr = checkMermaidLabelWidth([
      '```mermaid',
      'erDiagram',
      '  VERY_LONG_ENTITY_NAME_EXCEEDS_16 {',
      '    string id',
      '  }',
      '  A ||--o{ B : "超过十二宽度的关系边标签"',
      '```',
    ].join('\n'))
    if (badEr.ok || badEr.violations.length < 2) {
      return `erDiagram 超宽未拦截：${JSON.stringify(badEr)}`
    }
    return true
  }])

  cases.push(['tdd-parity.mjs 结构级模块/导出/CLI 漂移检测(I73)、排除 TEST_FILE_RE 与 no-tdd 豁免', async () => {
    const { checkTddSyncParity } = await import('../../kit/skills/lib/shared.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# parity\n\n```yaml\nquick-test: exit 0\n```\n',
      'docs/TDD.md': '# TDD\n\n| 项目 | 内容 |\n| --- | --- |\n| 最近更新 | 2026-01-01 |\n\n- `src/core.mjs`\n',
      'src/core.mjs': 'export function runCore() { return 1 }\n',
    })
    gitInit(dir, { branch: 'main' })
    const baseSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

    try {
      // 1. Test-only file added -> ignored by TEST_FILE_RE, no warning
      mkdirSync(join(dir, 'tests'), { recursive: true })
      writeFileSync(join(dir, 'tests/core.test.mjs'), "import assert from 'node:assert/strict'\nassert.ok(true)\n")
      const onlyTest = await checkTddSyncParity(dir, ['tests/core.test.mjs'], { baseSha })
      if (onlyTest.tddSyncWarning || onlyTest.missingModulesInTdd.length > 0) {
        return `TEST_FILE_RE 测试文件改动误触发 TDD 警告：${JSON.stringify(onlyTest)}`
      }

      // 2. New source module + new export added without updating TDD -> flagged
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src/billing.mjs'), 'export async function billUser() { return true }\n')
      writeFileSync(join(dir, 'src/core.mjs'), 'export function runCore() { return 1 }\nexport const NEW_CLI_FLAG = 1\n')
      gitCommitFast(dir, 'add billing and export', { name: 't', email: 't@t.t' })

      const drift = await checkTddSyncParity(dir, ['src/billing.mjs', 'src/core.mjs'], { baseSha })
      if (!drift.missingModulesInTdd.includes('src/billing.mjs')
        || !drift.changedExportsOrCli.some((c) => c.symbol === 'NEW_CLI_FLAG')
        || !drift.tddSyncWarning) {
        return `checkTddSyncParity 未检出新增模块与导出漂移：${JSON.stringify(drift)}`
      }

      // 3. Updating docs/TDD.md with new module & today's date clears warning
      const today = new Date().toISOString().slice(0, 10)
      writeFileSync(join(dir, 'docs/TDD.md'), `# TDD\n\n| 项目 | 内容 |\n| --- | --- |\n| 最近更新 | ${today} |\n\n- \`src/core.mjs\`\n- \`src/billing.mjs\`\n`)
      const synced = await checkTddSyncParity(dir, ['src/billing.mjs', 'src/core.mjs', 'docs/TDD.md'], { baseSha })
      if (synced.tddSyncWarning || synced.missingModulesInTdd.length > 0) {
        return `同步更新 docs/TDD.md 后仍误报：${JSON.stringify(synced)}`
      }

      // 4. no-tdd decision returns clean null/empty result
      writeFileSync(join(dir, 'AGENTS.md'), '# parity\n\n## 取舍\n\n- `no-tdd`: 纯脚本无架构文档\n')
      const noTdd = await checkTddSyncParity(dir, ['src/billing.mjs'], { baseSha })
      if (noTdd.authoritativeTddPath !== null || noTdd.tddSyncWarning !== null || noTdd.missingModulesInTdd.length !== 0) {
        return `no-tdd 豁免未返回空结构：${JSON.stringify(noTdd)}`
      }

      // 5. Detached HEAD + init.defaultbranch=master with refs/heads/main -> must resolve 'main' (and reverse 'master' when only master exists)
      gitSync(dir, ['checkout', '--detach', '-q', 'HEAD'])
      gitSync(dir, ['config', '--local', 'init.defaultbranch', 'master'])
      const detMain = await survey(dir)
      if (detMain.conventions?.defaultBranch !== 'main') {
        return `detached HEAD + init.defaultbranch=master 未优先识别真实 refs/heads/main：${detMain.conventions?.defaultBranch}`
      }
      gitSync(dir, ['branch', '-m', 'main', 'master'])
      gitSync(dir, ['config', '--local', 'init.defaultbranch', 'main'])
      const detMaster = await survey(dir)
      if (detMaster.conventions?.defaultBranch !== 'master') {
        return `detached HEAD 仅有 refs/heads/master 时被误判为 ${detMaster.conventions?.defaultBranch}`
      }
      gitSync(dir, ['branch', '-D', 'master'])
      gitSync(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      gitSync(dir, ['config', '--local', 'init.defaultbranch', 'master'])
      const detOriginMain = await survey(dir)
      if (detOriginMain.conventions?.defaultBranch !== 'main') {
        return `detached HEAD 仅有 refs/remotes/origin/main 且 init.defaultbranch=master 时被误判为 ${detOriginMain.conventions?.defaultBranch}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['signals.jsonl 自动写回(I74)+retro --apply-patches、flow-batch CI 门禁与 zip CRC32 冒烟', async () => {
    const { appendGovernSignal, readSignalsJsonl, resolveRepoRoots, writeTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify, handleRework } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const { handleBatch } = await import('../../kit/skills/dev-flow/scripts/flow-batch.mjs')

    // 1. Lightweight writeZip/readZip smoke (no .git dependency)
    const zipBuf = writeZip([
      { name: 'project-forge/SKILL.md', data: Buffer.from('---\nname: project-forge\n---\n', 'utf8') },
      { name: 'project-forge/scripts/a.mjs', data: Buffer.from('export const a = 1\n', 'utf8') },
    ])
    const unzipped = stripCommonPrefix(readZip(zipBuf))
    if (unzipped.length !== 2 || unzipped[0].name !== 'SKILL.md') {
      return `writeZip/readZip 轻量冒烟失败：${JSON.stringify(unzipped)}`
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n',
      'README.md': '# probe-signal\n',
      'src/app.mjs': 'export const app = 1\n',
    })
    gitInit(dir, { branch: 'main', origin: 'https://github.com/acme/m4c3.git', name: 'alice', email: 'alice@acme.test' })
    try {
      await runNode('compose-agents.mjs', [dir, '--no-backup'])
      const filledAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填完。')
        .replace('<填写项目快测命令>', 'node -e "process.exit(1)"')
      writeFileSync(join(dir, 'AGENTS.md'), filledAgents)
      gitCommitFast(dir, 'init agents', { files: ['AGENTS.md'], name: 'alice', email: 'alice@acme.test' })

      const roots = await resolveRepoRoots(dir)
      // Concurrent signals write safety
      await Promise.all([
        appendGovernSignal({ mainRoot: dir, gitDir: roots.gitDir, isGit: true, pattern: 'conc.sig', file: 'src/app.mjs', taskId: 'c3-t', message: 'c1' }),
        appendGovernSignal({ mainRoot: dir, gitDir: roots.gitDir, isGit: true, pattern: 'conc.sig', file: 'src/app.mjs', taskId: 'c3-t', message: 'c2' }),
      ])
      const sigInit = readSignalsJsonl(roots)
      if (sigInit.events.length < 2) {
        return `signals.jsonl 未在 verify/record/rework 时自动写入（concurrent write 缺失）：${JSON.stringify(sigInit)}`
      }

      await handleStart({ task: 'c3-t', case: '2', slug: 'c3-t', implementer: 'alice' }, roots)
      const wt = join(dir, '.worktrees', 'impl-c3-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const app = 2\n')
      gitCommitFast(wt, 'change app', { files: ['src/app.mjs'], name: 'alice', email: 'alice@acme.test' })

      // verify fail -> rework -> verify pass -> review record pass (with false-positive dispositions)
      await handleVerify({ task: 'c3-t', mode: 'full', cmd: 'exit 1' }, roots)
      await handleRework({ task: 'c3-t' }, roots)
      await handleVerify({ task: 'c3-t', mode: 'full', cmd: 'exit 0' }, roots)
      const recRes = await handleRecord({
        task: 'c3-t', round: '1', verdict: 'pass', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c3-t', 1),
        disposition: ['C1:rebutted-wrong', 'C2:intentional'],
      }, roots)
      if (recRes !== 0) return `handleRecord 失败：exit=${recRes}`

      const sigAfter = readSignalsJsonl(roots)
      const pats = new Set(sigAfter.events.map((e) => e.pattern))
      if (!pats.has('verify.full.fail') || !pats.has('flow.rework') || !pats.has('review.pass')) {
        return `signals.jsonl 未在 verify/record/rework 时自动写入：patterns=${JSON.stringify([...pats])}`
      }

      const retroRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--task', 'c3-t', '--apply-patches', '--json'])
      if (retroRes.status !== 0) return `govern-audit retro 失败：${retroRes.stderr}`
      const rj = JSON.parse(retroRes.stdout)
      if ((rj.patches?.length ?? 0) === 0 || (rj.appliedPatches?.length ?? 0) === 0) {
        return `retro 未产出建议补丁或未落盘：${retroRes.stdout}`
      }
      const chkAgents = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkAgents.status !== 0) {
        return `retro --apply-patches 破坏了 compose-agents --check：${chkAgents.stderr}`
      }

      // Test flow-batch merge-queue CI guard WITHOUT marking ledger rework
      writeTaskLedger(dir, {
        ...(JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'c3-t.json'), 'utf8'))),
        prNumber: 99,
      })
      const failClient = {
        tier: 'gh-cli',
        getCommitChecks: async () => ({ ok: true, bucket: 'fail', total: 1, passed: [], pending: [], failed: [{ name: 'check', state: 'FAILURE' }] }),
        mergePr: async () => { throw new Error('should not call mergePr when CI fails') },
      }
      const mqBlock = await handleBatch({ _: ['merge-queue'], tasks: 'c3-t', _ghClient: failClient }, roots)
      if (mqBlock.exitCode !== 3 || mqBlock.processed?.[0]?.code !== 'BLOCKED_CI_FAILED') {
        return `flow-batch merge-queue 未拦截 CI 失败：${JSON.stringify(mqBlock)}`
      }
      const ledgerAfterMq = JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'c3-t.json'), 'utf8'))
      if (ledgerAfterMq.status === 'rework' || ledgerAfterMq.queueConflict) {
        return `flow-batch CI 失败竟误改账本为 rework/queueConflict：${JSON.stringify(ledgerAfterMq)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
