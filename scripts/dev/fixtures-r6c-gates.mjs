/**
 * fixtures-r6c-gates.mjs —— R6C 切片双向回归断言夹具（覆盖 C9..C12 + A2）：
 *   1. dev-iterate：printNextStep 导出、extractSymbols(txt, ext) 字符串数组消费、slugTestToken \b 边界、
 *      resolveNativeTestDir Python test/tests、signals.jsonl 非代码/归档/已删过滤、多栈 resolveTestRunner、
 *      递归发现与 configuredTestEntries、generate --write 主分支隔离（exit 3）、run 默认 --escalate:true/+--no-escalate、
 *      cycle 持久化累加与停损自动建单；
 *   2. 跨门禁单源统一与提速：countTextLines 800 vs 801、review-gates .gitattributes linguist-generated & 豁免、
 *      govern-checks --changed 存量 <=80 棘轮、isLegalArchiveMove & reviewWorktreePath & 兄弟归档放行、
 *      check-empirical 先于 --include-diff 而 check-fault 收敛至 record --verdict pass、
 *      JSON 单源 contextBrief、evaluateToolStaleness 快速跳过与批量预过滤、verify-tools create 豁免 scratch/ 零断言；
 *   3. review-ledger：Round 3 停损解锁需非空 --reason、rebuts 透传合并、低风险单会话免 SELF_REVIEW_REJECTED、generic-git awaiting-remote-mr。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { appendGovernSignal, isActionableSignalCodeTarget, readSignalsJsonl, resolveGovernStateDir } from '../../kit/skills/lib/signals.mjs'
import { TEST_FILE_RE, isLegalArchiveMove } from '../../kit/skills/lib/static-gates.mjs'
import { collectTestInventory, resolveNativeTestDir, resolveTestRunner, slugTestToken } from '../../kit/skills/lib/suite-inventory.mjs'
import { evaluateToolStaleness } from '../../kit/skills/lib/verify-state.mjs'
import { createFakeGhEnv, gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

const ITER_SCRIPT = 'kit/skills/dev-iterate/scripts/iterate.mjs'
const RP_SCRIPT = 'kit/skills/dev-review/scripts/review-pack.mjs'
const EDIT_SCRIPT = 'kit/skills/dev-edit/scripts/edit-gate.mjs'
const GOV_SCRIPT = 'kit/skills/dev-govern/scripts/govern-audit.mjs'
const VT_SCRIPT = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
const FLOW_SCRIPT = 'kit/skills/dev-flow/scripts/flow.mjs'

export function registerR6cGatesCases(cases) {
  cases.push(['[C9] iterate plan/run 非JSON printNextStep、symbols[]、slugTestToken \\b、Python test/ 与多栈 resolveTestRunner', async () => {
    const emptyBin = tmpProject({})
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'multi-c9', version: '1.0.0', type: 'module' }, null, 2),
      'src/prd-sync.mjs': 'export function syncPrdState(x) { return x }\nexport const prdReady = true\n',
      'src/process-auth.mjs': 'export function verifySessionToken(t) { return Boolean(t) }\n',
      'tests/integration/nested/ok.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('nested pass', () => { assert.equal(1 + 1, 2) })\n",
      'tests/integration/nested/fail.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('nested fail', () => { assert.equal(1, 2) })\n",
    })
    const pyTestRepo = tmpProject({
      'pyproject.toml': '[project]\nname = "pydemo"\n',
      'test/unit/sample_test.py': 'def test_ok(): assert True\n',
    })
    const venvDir = tmpProject({
      'pyproject.toml': '[project]\nname = "pyvenv"\n',
      '.venv/bin/pytest': '#!/bin/sh\nexit 0\n',
      '.venv/Scripts/pytest.exe': 'stub',
      'tests/test_app.py': 'def test_app(): assert True\n',
      'pom.xml': '<project/>',
      'mvnw': '#!/bin/sh\n',
      'mvnw.cmd': '@echo off\r\n',
      'src/test/java/AppTest.java': 'class AppTest {}\n',
      'main_test.go': 'package main\n',
      'Cargo.toml': '[package]\nname="rs"\n',
      'tests/int_test.rs': '#[test]\nfn t(){}\n',
      'vitest.test.ts': "import { expect, test } from 'vitest'\ntest('v', () => expect(1).toBe(1))\n",
      'tap.test.mjs': "import t from 'tap'\nt.pass('ok')\n",
      'mocha.test.mjs': "import { describe, it } from 'mocha'\n",
      'ava.test.mjs': "import test from 'ava'\ntest('a', (t) => t.pass())\n",
      'node_plain.test.ts': "import test from 'node:test'\n",
    })
    try {
      // 1. slugTestToken word boundary
      if (slugTestToken('prd') !== 'prd' || slugTestToken('prd-sync') !== 'prd-sync') {
        return `slugTestToken 误伤 prd 前缀：prd=${slugTestToken('prd')} prd-sync=${slugTestToken('prd-sync')}`
      }
      if (slugTestToken('process-auth') !== 'process-auth') return `slugTestToken 误伤 process：${slugTestToken('process-auth')}`
      if (slugTestToken('issue-42-auth') !== 'flow-auth' || slugTestToken('wave-1') !== 'flow') {
        return `slugTestToken 未清洗真实过程编号：${slugTestToken('issue-42-auth')} / ${slugTestToken('wave-1')}`
      }

      // 2. Python test/ vs tests/
      const pyNative = resolveNativeTestDir(pyTestRepo, { tier: 'integration' })
      if (pyNative.dirRel !== 'test/integration') return `Python test/ 目录未识别：${pyNative.dirRel}`

      // 3. plan --focus exportedSymbols string[] & run non-json printNextStep (pass + fail)
      const planRes = await runAbsAsync(ITER_SCRIPT, ['plan', dir, '--focus', 'syncPrdState', '--json'])
      if (planRes.status !== 0) return `iterate plan --focus 失败：${planRes.stderr}`
      const planJson = JSON.parse(planRes.stdout)
      const syms = planJson.focusContext?.matchedModules?.[0]?.symbols ?? []
      if (!syms.includes('syncPrdState')) return `focus exportedSymbols 未消费 string[]：${JSON.stringify(syms)}`

      const passText = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--targets', 'tests/integration/nested/ok.test.mjs'])
      if (passText.status !== 0 || !passText.stdout.includes('[NEXT STEP]')) {
        return `iterate run 非 JSON 成功路径缺 [NEXT STEP] 或崩溃：exit=${passText.status} out=${passText.stdout} err=${passText.stderr}`
      }
      const failText = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--targets', 'tests/integration/nested/fail.test.mjs', '--no-escalate'])
      if (failText.status === 0 || !failText.stdout.includes('[NEXT STEP]')) {
        return `iterate run 非 JSON 失败路径缺 [NEXT STEP] 或未非零退出：exit=${failText.status} out=${failText.stdout} err=${failText.stderr}`
      }

      // 4. resolveTestRunner multi-stack positive & missing-runner negative
      const pyRes = resolveTestRunner(venvDir, 'tests/test_app.py', { env: { PATH: emptyBin } })
      const javaRes = resolveTestRunner(venvDir, 'src/test/java/AppTest.java', { env: { PATH: emptyBin } })
      if (!pyRes.ok || pyRes.runner !== 'pytest') return `Python .venv pytest 未命中：${JSON.stringify(pyRes)}`
      if (!javaRes.ok || javaRes.runner !== 'mvn' || !javaRes.args.includes('-Dtest=AppTest')) {
        return `Java mvnw 未命中：${JSON.stringify(javaRes)}`
      }
      for (const [rel, msg] of [
        ['vitest.test.ts', 'vitest'],
        ['tap.test.mjs', 'tap'],
        ['mocha.test.mjs', 'mocha'],
        ['ava.test.mjs', 'ava'],
        ['main_test.go', 'go'],
        ['tests/int_test.rs', 'cargo'],
      ]) {
        const miss = resolveTestRunner(venvDir, rel, { env: { PATH: emptyBin } })
        if (miss.ok || miss.failureKind !== 'missing-runner') return `${msg} 缺 runner 未返回 missing-runner：${JSON.stringify(miss)}`
      }
      const legacyTs = resolveTestRunner(venvDir, 'node_plain.test.ts', { env: { PATH: emptyBin }, nodeVersion: '20.11.0' })
      if (legacyTs.ok || legacyTs.failureKind !== 'unsupported-ts-runtime') {
        return `Node <22.6 TS 回退码异常：${JSON.stringify(legacyTs)}`
      }

      // 5. recursive discovery when --targets omitted
      const recRun = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--targets', '', '--no-escalate', '--no-signals', '--json'])
      if (recRun.status === 0) return `递归发现应跑通 ok 且捕获 nested fail：${recRun.stdout}`
      const recJson = JSON.parse(recRun.stdout)
      if (recJson.total !== 2 || recJson.passed !== 1 || recJson.failed !== 1) {
        return `递归扫描测试目录计数异常：${JSON.stringify(recJson)}`
      }
      return true
    } finally { rmTree(emptyBin); rmTree(dir); rmTree(pyTestRepo); rmTree(venvDir) }
  }])

  cases.push(['[C10+A2] signals 过滤、configuredTestEntries 零误报、generate --write 主分支隔离、run 默认升级与 cycle 持久化停损', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': JSON.stringify({ name: 'c10-demo', version: '1.0.0', type: 'module', scripts: { test: 'node scripts/smoke.mjs' } }, null, 2),
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: node scripts/smoke.mjs\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'src/core.mjs': 'export const runCore = (n) => n + 1\n',
      'scripts/smoke.mjs': "import assert from 'node:assert/strict'\nassert.equal(1, 1)\n",
      'docs/guide.md': '# Guide\n',
      'docs/archive/old.md': '# Archived\n',
      'tests/integration/broken.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('fail', () => { assert.equal(1, 2) })\n",
    })
    const nonGit = tmpProject({ 'src/app.mjs': 'export const x = 1\n' })
    const unborn = tmpProject({ 'src/app.mjs': 'export const x = 1\n' })
    gitSync(unborn, ['init', '-b', 'main'])
    gitInit(dir, { branch: 'main' })
    const wtDir = join(tmpProject({}), 'wt-feat')
    rmTree(wtDir)
    gitSync(dir, ['worktree', 'add', '-b', 'feat/c10-iter', wtDir, 'main'])
    try {
      // 1. signals filtering: docs/archive/deleted skipped; existing code kept
      const stateDir = resolveGovernStateDir(dir, join(dir, '.git'), true)
      for (const f of ['docs/guide.md', 'docs/archive/old.md', 'src/deleted.mjs', 'src/core.mjs']) {
        await appendGovernSignal({ mainRoot: dir, gitDir: join(dir, '.git'), isGit: true, category: 'review', file: f, message: 'hit', severity: 'high' })
        await appendGovernSignal({ mainRoot: dir, gitDir: join(dir, '.git'), isGit: true, category: 'review', file: f, message: 'hit2', severity: 'high' })
      }
      const { events: codeSignals } = readSignalsJsonl(stateDir, { codeOnly: true, repoRoot: dir })
      if (codeSignals.some((e) => e.file !== 'src/core.mjs') || codeSignals.length !== 2) {
        return `signals codeOnly 未过滤非代码/归档/已删文件：${JSON.stringify(codeSignals.map((e) => e.file))}`
      }
      if (isActionableSignalCodeTarget('docs/guide.md', dir) || isActionableSignalCodeTarget('docs/archive/old.md', dir)) {
        return 'isActionableSignalCodeTarget 未拦截文档/归档'
      }

      // 2. collectTestInventory recognizes configuredTestEntries while TEST_FILE_RE keeps fixtures-govern false
      if (TEST_FILE_RE.test('scripts/dev/fixtures-govern.mjs')) return 'TEST_FILE_RE 不应匹配 scripts/dev/fixtures-govern.mjs'
      const inv = collectTestInventory(dir, [{ rel: 'src/core.mjs', name: 'core.mjs' }], [], [], [], {}, null, ['scripts/smoke.mjs'])
      if (inv.totalTestFiles !== 1 || inv.testDirectories[0]?.dir !== 'scripts') {
        return `configuredTestEntries 未计入 Test Files：${JSON.stringify(inv)}`
      }
      const gov = await runAbsAsync(GOV_SCRIPT, ['audit', dir])
      if (gov.status !== 0 || gov.stdout.includes('Test Files      : 0')) {
        return `govern-audit 仍误报 Test Files: 0：\n${gov.stdout}`
      }

      // 3. generate --write isolation guard (main committed blocked exit 3; non-git, unborn, worktree allowed)
      const mainBlk = await runAbsAsync(ITER_SCRIPT, ['generate', dir, '--focus', 'core', '--write', '--json'])
      if (mainBlk.status !== 3 || !mainBlk.stdout.includes('BLOCKED_MAIN_SLOT_VIOLATION')) {
        return `有提交主分支 generate --write 未阻断 exit 3：exit=${mainBlk.status} out=${mainBlk.stdout}`
      }
      const nonGitOk = await runAbsAsync(ITER_SCRIPT, ['generate', nonGit, '--focus', 'app', '--write', '--json'])
      const unbornOk = await runAbsAsync(ITER_SCRIPT, ['generate', unborn, '--focus', 'app', '--write', '--json'])
      const wtOk = await runAbsAsync(ITER_SCRIPT, ['generate', wtDir, '--focus', 'core', '--write', '--json'])
      if (nonGitOk.status !== 0 || unbornOk.status !== 0 || wtOk.status !== 0) {
        return `放行场景被误拦：nonGit=${nonGitOk.status} unborn=${unbornOk.status} wt=${wtOk.status}`
      }

      // 4. A2 run default escalate=true & --no-escalate opt-out
      const noEsc = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--targets', 'tests/integration/broken.test.mjs', '--no-escalate', '--no-signals', '--json'])
      const noEscJson = JSON.parse(noEsc.stdout)
      if (noEsc.status === 0 || noEscJson.escalations.length !== 0) {
        return `--no-escalate 未关闭建单：${noEsc.stdout}`
      }
      const defEsc = await runAbsAsync(ITER_SCRIPT, ['run', dir, '--targets', 'tests/integration/broken.test.mjs', '--no-signals', '--json'])
      const defEscJson = JSON.parse(defEsc.stdout)
      if (defEsc.status === 0 || defEscJson.escalations.length !== 1 || !defEscJson.escalations[0]?.ok) {
        return `run 默认未自动建单：${defEsc.stdout}`
      }

      // 5. cycle accumulates across calls, hits NO_PROGRESS_STALL -> exit 4 + escalation, resets with --reset
      const c1 = await runAbsAsync(ITER_SCRIPT, ['cycle', dir, '--goal', 'fix-c10', '--max-rounds', '5', '--progress-history', '[{"observed":2}]', '--no-escalate', '--json'])
      const c2 = await runAbsAsync(ITER_SCRIPT, ['cycle', dir, '--progress-history', '[{"observed":2}]', '--no-escalate', '--json'])
      const c3 = await runAbsAsync(ITER_SCRIPT, ['cycle', dir, '--progress-history', '[{"observed":2}]', '--json'])
      if (c1.status !== 0 || c2.status !== 0 || c3.status !== 4) {
        return `cycle 多轮累加或停损退出码异常：c1=${c1.status} c2=${c2.status} c3=${c3.status} out3=${c3.stdout}`
      }
      const c3Json = JSON.parse(c3.stdout)
      if (!c3Json.stopped || c3Json.stopReason !== 'NO_PROGRESS_STALL' || !c3Json.escalated?.ok) {
        return `cycle 停损建单载荷异常：${c3.stdout}`
      }
      const cReset = await runAbsAsync(ITER_SCRIPT, ['cycle', dir, '--reset', '--goal', 'fresh', '--json'])
      if (cReset.status !== 0 || JSON.parse(cReset.stdout).roundsCompleted !== 0) {
        return `cycle --reset 未清空历史：${cReset.stdout}`
      }
      return true
    } finally { rmTree(wtDir); rmTree(dir); rmTree(nonGit); rmTree(unborn) }
  }])

  cases.push(['[C11] 800vs801、linguist-generated、存量<=80棘轮、reviewWorktreePath/归档放行、实证先于diff、故障注入收敛至pass、单源contextBrief、staleness提速与scratch探针', async () => {
    const line800 = `${Array.from({ length: 800 }, (_, i) => `export function v${i}(x) { if (x > 0) return x + ${i}; return 0 }`).join('\n')}\n`
    const line801 = `${Array.from({ length: 801 }, (_, i) => `export function w${i}(x) { if (x > 0) return x + ${i}; return 0 }`).join('\n')}\n`
    const line850 = `${Array.from({ length: 850 }, (_, i) => `export function b${i}(x) { if (x > 0) return x + ${i}; return 0 }`).join('\n')}\n`
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.gitattributes': 'src/gen.mjs linguist-generated=true\n',
      'AGENTS.md': '# P\n\n```yaml\nquick-test: node test/ok.test.mjs\nfull-test: node test/ok.test.mjs\nsmoke-verify: node test/ok.test.mjs\nmerge-gate: exit 0\nhigh-risk: src/crit.mjs\ndo-not-edit: docs/archive/\n```\n',
      'docs/TDD.md': '# TDD\n\n## Core\nApp logic.\n',
      'docs/prd/sibling.md': '# PRD\n',
      'docs/todo/sibling.md': '# Sibling Todo\n- [x] C1: ok\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: Array.from({ length: 12 }, (_, idx) => ({
          id: `feat-${idx}`,
          name: `Feat ${idx}`,
          entrypoints: ['src/app.mjs'],
          modules: ['src/app.mjs'],
          businessFlows: ['app-flow'],
          verificationTools: [{ id: `tool-${idx}`, kind: 'command', command: 'node test/ok.test.mjs', riskLevel: 'medium' }],
        })),
      }, null, 2),
      'src/app.mjs': 'export const app = () => 1\n',
      'src/crit.mjs': 'export const crit = (x) => x + 1\n',
      'src/exact800.mjs': line800,
      'src/gen.mjs': line850,
      'src/brown.mjs': line850,
      'test/ok.test.mjs': "import assert from 'node:assert/strict'\nimport { crit } from '../src/crit.mjs'\nassert.equal(crit(1), 2)\n",
    })
    gitInit(dir, { branch: 'main' })
    const revWt = join(dir, '.worktrees/review-c11-t')
    try {
      // 1. 800 lines with trailing newline is NOT godFile; linguist-generated is exempt in both govern & review-gates; 801 IS godFile
      const govClean = await runAbsAsync(GOV_SCRIPT, ['audit', dir])
      if (govClean.stdout.includes('hygiene.god-file.src/exact800.mjs') || govClean.stdout.includes('hygiene.god-file.src/gen.mjs')) {
        return `800 行边界或 linguist-generated 在 govern 仍误报：\n${govClean.stdout}`
      }
      writeFileSync(join(dir, 'src/exact800b.mjs'), line800, 'utf8')
      writeFileSync(join(dir, 'src/over801.mjs'), line801, 'utf8')
      const rp801 = await runAbsAsync(RP_SCRIPT, ['--local', '--json'], { cwd: dir })
      if (rp801.status !== 0) return `review-pack --local 失败：${rp801.stderr}`
      const rp801Json = JSON.parse(rp801.stdout)
      const godFiles = rp801Json.structuralGate?.godFiles?.map((g) => g.file) ?? []
      if (!godFiles.includes('src/over801.mjs') || godFiles.includes('src/exact800b.mjs') || godFiles.includes('src/gen.mjs')) {
        return `review-gates 800/801 或 linguist-generated 判定异常：${JSON.stringify(godFiles)}`
      }
      // Single-source contextBrief check in JSON & speed test with 12 unbaselined tools
      if (!rp801Json.contextBrief || 'evergreenContext' in (rp801Json.reviewContext ?? {}) || 'contextBrief' in (rp801Json.reviewContext ?? {})) {
        return `review-pack JSON 未实现全局单源 contextBrief：${JSON.stringify(Object.keys(rp801Json.reviewContext ?? {}))}`
      }
      const fastMs = await evaluateToolStaleness({
        repoRoot: dir, gitCommonDir: join(dir, '.git'), mainRoot: dir, baseRef: 'main',
        feature: { id: 'f0', modules: ['src/app.mjs'] }, tool: { id: 'unseen', riskLevel: 'medium' },
        skipFingerprintOnUnbaselined: true,
      })
      if (fastMs.status !== 'unbaselined' || fastMs.current !== null) {
        return `evaluateToolStaleness 未跳过 !baseline 指纹计算：${JSON.stringify(fastMs)}`
      }

      // 2. govern-audit --changed brownfield <= 80 ratchet vs > 80 blocked
      writeFileSync(join(dir, 'src/brown.mjs'), `${line850}export const extra1 = 1\n`, 'utf8')
      const govWithin = await runAbsAsync(GOV_SCRIPT, ['audit', dir, '--changed'])
      if (govWithin.stdout.includes('hygiene.god-file.src/brown.mjs')) {
        return `govern --changed 存量净增 <= 80 未放行：\n${govWithin.stdout}`
      }
      writeFileSync(join(dir, 'src/brown.mjs'), `${line850}${Array.from({ length: 85 }, (_, i) => `export const ex${i} = ${i}`).join('\n')}\n`, 'utf8')
      const govOver = await runAbsAsync(GOV_SCRIPT, ['audit', dir, '--changed'])
      if (!govOver.stdout.includes('hygiene.god-file.src/brown.mjs')) {
        return `govern --changed 存量净增 > 80 未拦截：\n${govOver.stdout}`
      }
      gitSync(dir, ['checkout', '--', 'src/brown.mjs'])
      rmTree(join(dir, 'src/over801.mjs'))
      rmTree(join(dir, 'src/exact800b.mjs'))

      // 3. reviewWorktreePath lookup + sibling archived doc allowed in edit-gate & isLegalArchiveMove
      const sibOk = isLegalArchiveMove({ file: 'docs/archive/todo/sibling.md', status: 'M' }, new Set(), new Set(['docs/archive/todo/sibling.md']))
      const sibBad = isLegalArchiveMove({ file: 'docs/archive/other.md', status: 'M' }, new Set(), new Set(['docs/archive/todo/sibling.md']))
      if (!sibOk || sibBad) return `isLegalArchiveMove 判定异常：ok=${sibOk} bad=${sibBad}`

      const s11 = await runAbsAsync(FLOW_SCRIPT, ['start', '--task', 'c11-t', '--case', '4', '--allow-plan-bootstrap', '--dir', dir])
      if (s11.status !== 0) return `c11-t flow start 失败：${s11.stdout} ${s11.stderr}`
      await seedExploredFor(dir, 'c11-t')
      await runAbsAsync(FLOW_SCRIPT, ['claim', '--task', 'c11-t', '--agent', 'impl-a', '--dir', dir])
      // Sibling terminal ledger sharing same PRD + archive modification
      writeTaskLedger(dir, {
        taskId: 'sib-t', status: 'merged', prdFile: 'docs/prd/sibling.md', archivedTodoFile: 'docs/archive/todo/sib-old.md',
      })
      const mLedger = readTaskLedger(dir, 'c11-t')
      mLedger.prdFile = 'docs/prd/sibling.md'
      mLedger.reviewWorktreePath = '.worktrees/review-c11-t'
      writeTaskLedger(dir, mLedger)

      const implWt = join(dir, '.worktrees/impl-c11-t')
      mkdirSync(join(implWt, 'docs/archive/todo'), { recursive: true })
      writeFileSync(join(implWt, 'docs/archive/todo/sib-old.md'), '# Archived sibling\n', 'utf8')
      writeFileSync(join(implWt, 'src/crit.mjs'), 'export const crit = (x) => x + 2\n', 'utf8')
      writeFileSync(join(implWt, 'test/ok.test.mjs'), "import assert from 'node:assert/strict'\nimport { crit } from '../src/crit.mjs'\nassert.equal(crit(1), 3)\n", 'utf8')
      gitCommitFast(implWt, 'feat: crit + sibling archive')
      await runAbsAsync(FLOW_SCRIPT, ['verify', '--task', 'c11-t', '--dir', dir])

      // Edit-gate invoked inside reviewWorktreePath resolves ledger & allows sibling archived file
      gitSync(dir, ['worktree', 'add', '--detach', revWt, 'HEAD'])
      gitSync(revWt, ['checkout', '--detach', mLedger.branch])
      const egRev = await runAbsAsync(EDIT_SCRIPT, ['--changed', '--dir', revWt, '--files', 'docs/archive/todo/sib-old.md', '--json'])
      if (egRev.status !== 0) return `edit-gate 未识别 reviewWorktreePath 或误拦兄弟归档更新：${egRev.stdout} ${egRev.stderr}`

      // 4. 仅完成 check-empirical 尚未过 check-fault 时，--include-diff 与 pass 均须阻断（exit=3）；完成 check-fault fail+restore 后解锁
      const packMech = await runAbsAsync(RP_SCRIPT, ['--task', 'c11-t', '--dir', dir, '--json'])
      if (packMech.status !== 0) return `mechanical pack 失败：${packMech.stdout} ${packMech.stderr}`
      const empOk = await runAbsAsync(RP_SCRIPT, ['check-empirical', '--task', 'c11-t', '--dir', dir, '--cmd', 'node test/ok.test.mjs', '--e2e-evidence', 'run: node test/ok.test.mjs => exit 0', '--json'])
      if (empOk.status !== 0) return `check-empirical 失败：${empOk.stdout} ${empOk.stderr}`
      const diffBlockedNoFault = await runAbsAsync(RP_SCRIPT, ['--task', 'c11-t', '--dir', dir, '--include-diff', '--json'])
      const diffBlockedJson = JSON.parse(diffBlockedNoFault.stdout)
      if (diffBlockedNoFault.status !== 3 || !diffBlockedJson.empiricalGate?.missingSteps?.includes('check-fault:fail')) {
        return `缺 check-fault 时 --include-diff 应阻断并列出 check-fault:fail：exit=${diffBlockedNoFault.status} out=${diffBlockedNoFault.stdout}`
      }

      const tok = await issueTokenFor(dir, 'c11-t', 1)
      const passWithoutFault = await runAbsAsync(RP_SCRIPT, [
        'record', '--task', 'c11-t', '--dir', dir, '--round', '1', '--verdict', 'pass',
        '--reviewer-id', 'rev-a', '--review-token', tok, '--evidence', 'ran ok',
        '--e2e-evidence', 'run: node test/ok.test.mjs => exit 0', '--json',
      ])
      if (passWithoutFault.status !== 3 || !passWithoutFault.stdout.includes('故障注入')) {
        return `高风险未过 check-fault 时 record --verdict pass 未按预期阻断：exit=${passWithoutFault.status} out=${passWithoutFault.stdout}`
      }
      writeFileSync(join(revWt, 'src/crit.mjs'), 'export const crit = (x) => x + 99\n', 'utf8')
      const fFail = await runAbsAsync(RP_SCRIPT, ['check-fault', '--phase', 'fail', '--task', 'c11-t', '--dir', dir, '--cmd', 'node test/ok.test.mjs', '--json'])
      if (fFail.status !== 0) return `check-fault fail 失败：${fFail.stdout} ${fFail.stderr}`
      gitSync(revWt, ['checkout', '--', 'src/crit.mjs'])
      const fRest = await runAbsAsync(RP_SCRIPT, ['check-fault', '--phase', 'restore', '--task', 'c11-t', '--dir', dir, '--cmd', 'node test/ok.test.mjs', '--json'])
      if (fRest.status !== 0) return `check-fault restore 失败：${fRest.stdout} ${fRest.stderr}`
      const diffUnlocked = await runAbsAsync(RP_SCRIPT, ['--task', 'c11-t', '--dir', dir, '--include-diff', '--json'])
      if (diffUnlocked.status !== 0) return `完成 check-empirical + check-fault 后 --include-diff 应放行：exit=${diffUnlocked.status} out=${diffUnlocked.stdout}`

      // 5. verify-tools create exempts scratch/ probes from ZERO_ASSERTION_TEST
      const draftProbe = await runAbsAsync(VT_SCRIPT, ['create', '--dir', implWt, '--feature', 'crit', '--task', 'c11-t', '--modules', 'src/crit.mjs', '--draft-only', '--draft-file', 'probe.mjs', '--draft-content', 'import { crit } from "../../src/crit.mjs"\nif (crit(1) !== 3) process.exit(1)\n', '--json'])
      if (draftProbe.status !== 0) return `verify-tools draft 失败：${draftProbe.stderr}`
      const promoProbe = await runAbsAsync(VT_SCRIPT, ['create', '--dir', implWt, '--feature', 'crit', '--task', 'c11-t', '--modules', 'src/crit.mjs', '--promote', '--from-scratch', 'probe.mjs', '--script', 'scripts/verify/probe.test.mjs', '--json'])
      if (promoProbe.status !== 0) {
        return `verify-tools create 沉淀 scratch 探针被 ZERO_ASSERTION_TEST 误拦：exit=${promoProbe.status} out=${promoProbe.stdout} err=${promoProbe.stderr}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[C12] Round 3 --reason 校验、rebuts 透传、低风险单会话免 SELF_REVIEW_REJECTED 与 generic-git awaiting-remote-mr', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# P\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
      'README.md': '# Hello\n',
      'src/app.mjs': 'export const app = 1\n',
      'src/other.mjs': 'export const other = 1\n',
      'src/third.mjs': 'export const third = 1\n',
    })
    gitInit(dir, { branch: 'main' })
    const fakeGh = createFakeGhEnv({})
    try {
      // 1. Low-risk pure non-executable doc single-session: same actor record without token succeeds
      const sDoc = await runAbsAsync(FLOW_SCRIPT, ['start', '--task', 'doc-c12', '--case', '2', '--no-issue', '--reason', '回归夹具测试低风险单会话免审', '--dir', dir])
      if (sDoc.status !== 0) return `doc-c12 flow start 失败：${sDoc.stdout} ${sDoc.stderr}`
      await seedExploredFor(dir, 'doc-c12')
      await runAbsAsync(FLOW_SCRIPT, ['claim', '--task', 'doc-c12', '--agent', 'alice', '--dir', dir])
      const docWt = join(dir, '.worktrees/impl-doc-c12')
      writeFileSync(join(docWt, 'README.md'), '# Hello C12\n', 'utf8')
      gitCommitFast(docWt, 'docs: update readme')
      await runAbsAsync(FLOW_SCRIPT, ['verify', '--task', 'doc-c12', '--dir', dir])
      const lowRec = await runAbsAsync(RP_SCRIPT, [
        'record', '--task', 'doc-c12', '--dir', dir, '--round', '1', '--verdict', 'pass',
        '--reviewer-id', 'alice', '--evidence', 'checked doc links', '--json',
      ])
      if (lowRec.status !== 0) return `低风险单会话免审冲突 SELF_REVIEW_REJECTED：exit=${lowRec.status} out=${lowRec.stdout} err=${lowRec.stderr}`

      // 2. Round 3 stop-loss --human-approved requires non-empty --reason; rebuts inherited from baseLedger
      const sSl = await runAbsAsync(FLOW_SCRIPT, ['start', '--task', 'sl-c12', '--case', '3', '--allow-plan-bootstrap', '--dir', dir])
      if (sSl.status !== 0) return `sl-c12 flow start 失败：${sSl.stdout} ${sSl.stderr}`
      await seedExploredFor(dir, 'sl-c12')
      await runAbsAsync(FLOW_SCRIPT, ['claim', '--task', 'sl-c12', '--agent', 'impl-b', '--dir', dir])
      const slWt = join(dir, '.worktrees/impl-sl-c12')
      writeFileSync(join(slWt, 'src/app.mjs'), 'export const app = 2\n', 'utf8')
      gitCommitFast(slWt, 'feat: v2')

      // Seed baseLedger.rebuts
      const slLdg = readTaskLedger(dir, 'sl-c12')
      slLdg.rebuts = [{ id: 'R1', reason: 'intended behavior' }]
      slLdg.role = 'generic-git'
      slLdg.providerId = 'generic-git'
      writeTaskLedger(dir, slLdg)

      for (const [r, rev, fTarget, mf, disp] of [
        [1, 'rev-1', 'src/app.mjs', JSON.stringify([{ file: 'src/app.mjs', line: 1, summary: 'M1: round1 blocker' }]), null],
        [2, 'rev-2', 'src/other.mjs', JSON.stringify([{ file: 'src/other.mjs', line: 1, summary: 'M2: round2 blocker' }]), 'MF-1:fixed'],
      ]) {
        writeFileSync(join(slWt, fTarget), `export const x = ${r + 2}\n`, 'utf8')
        gitCommitFast(slWt, `fix: r${r}`)
        const t = await issueTokenFor(dir, 'sl-c12', r)
        const rr = await runAbsAsync(RP_SCRIPT, [
          'record', '--task', 'sl-c12', '--dir', dir, '--round', String(r), '--verdict', 'changes',
          '--reviewer-id', rev, '--review-token', t, '--evidence', 'ran check',
          '--must-fix', mf, ...(disp ? ['--disposition', disp] : []), '--json',
        ])
        if (rr.status !== 0) return `Round ${r} record 失败：${rr.stdout} ${rr.stderr}`
      }
      const savedAfterR2 = readTaskLedger(dir, 'sl-c12')
      if (!(savedAfterR2.rounds[0]?.rebuts ?? []).some((x) => x.id === 'R1')) {
        return `roundEntry.rebuts 未继承 baseLedger.rebuts：${JSON.stringify(savedAfterR2.rounds[0]?.rebuts)}`
      }

      // Round 3 --human-approved without --reason -> BLOCKED_STOP_LOSS_REASON_REQUIRED (exit 4)
      writeFileSync(join(slWt, 'src/third.mjs'), 'export const third = 5\n', 'utf8')
      gitCommitFast(slWt, 'fix: r3')
      await runAbsAsync(FLOW_SCRIPT, ['verify', '--task', 'sl-c12', '--dir', dir])
      const t3 = await issueTokenFor(dir, 'sl-c12', 3)
      const r3NoReason = await runAbsAsync(RP_SCRIPT, [
        'record', '--task', 'sl-c12', '--dir', dir, '--round', '3', '--verdict', 'changes',
        '--reviewer-id', 'rev-3', '--review-token', t3, '--evidence', 'ran check',
        '--must-fix', JSON.stringify([{ file: 'src/third.mjs', line: 1, summary: 'M3: round3 blocker' }]), '--resolved', 'MF-1', '--human-approved', '--json',
      ])
      if (r3NoReason.status !== 4 || !r3NoReason.stdout.includes('BLOCKED_STOP_LOSS_REASON_REQUIRED')) {
        return `Round 3 缺 --reason 竟解锁停损：exit=${r3NoReason.status} out=${r3NoReason.stdout}`
      }
      const r3WithReason = await runAbsAsync(RP_SCRIPT, [
        'record', '--task', 'sl-c12', '--dir', dir, '--round', '3', '--verdict', 'pass',
        '--reviewer-id', 'rev-3', '--review-token', t3, '--evidence', 'ran check',
        '--resolved', 'MF-1', '--human-approved', '--reason', 'verified architectural fix', '--json',
      ])
      if (r3WithReason.status !== 0) return `Round 3 有效 pass 失败：exit=${r3WithReason.status} out=${r3WithReason.stdout} err=${r3WithReason.stderr}`
      const passJson = JSON.parse(r3WithReason.stdout)
      if (!JSON.stringify(passJson.nextSteps).includes('awaiting-remote-mr')) {
        return `generic-git pass nextSteps 未提示 awaiting-remote-mr：${JSON.stringify(passJson.nextSteps)}`
      }
      return true
    } finally { fakeGh?.cleanup?.(); rmTree(dir) }
  }])
}
