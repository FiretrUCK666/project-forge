/**
 * blind-run-harness.mjs —— Stage B 多生态独立 `$TMPDIR` 盲测与零提示/弱模型防线验证器（C18 / C23）。
 *
 * 严格仅落盘在 `scripts/dev/`（不入 `.gitattributes` 分发包），全程在独立 `$TMPDIR` 沙盒执行，
 * 对外部上游仓零写操作；按 `executed / succeeded / errorOnly` 三态严格计分。
 */

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { scoreExecutionResult } from '../../kit/skills/lib/workflow-policy.mjs'
import { survey } from '../survey.mjs'
import { BLIND_MODEL_BENCHMARK, runEvolutionBlindMatrix } from './blind-run-matrix.mjs'
import { gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor, rmTree, seedExploredFor, SKILL_ROOT, tmpProject } from './fixtures-helpers.mjs'

function runNode(scriptAbs, args, cwd, envExtra = {}) {
  return spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, PF_NO_REAL_AUTH_PROBE: '1', ...envExtra },
  })
}

function findExecutable(candidates) {
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (!r.error && r.status === 0) return cmd
  }
  return null
}

function createTracker() {
  const entries = []
  return {
    record(name, ok, detail = '') {
      const score = scoreExecutionResult({ executed: true, exitCode: ok ? 0 : 1, errorOnly: false })
      entries.push({ name, executed: true, succeeded: score.ok, errorOnly: false, skipped: false, detail })
    },
    recordErrorOnly(name, detail = '') {
      const score = scoreExecutionResult({ executed: true, exitCode: EXIT.OK, errorOnly: true })
      entries.push({ name, executed: true, succeeded: score.ok, errorOnly: true, skipped: false, detail })
    },
    skipToolchain(name, reason) {
      entries.push({ name, executed: false, succeeded: false, errorOnly: false, skipped: true, detail: reason })
    },
    summarize() {
      const executed = entries.filter((e) => e.executed).length
      const succeeded = entries.filter((e) => e.executed && e.succeeded).length
      const errorOnly = entries.filter((e) => e.errorOnly).length
      const skipped = entries.filter((e) => e.skipped).length
      const failed = entries.filter((e) => e.executed && !e.succeeded)
      return {
        ok: executed > 0 && errorOnly === 0 && succeeded === executed,
        total: entries.length,
        executed,
        succeeded,
        errorOnly,
        skipped,
        failedCount: failed.length,
        entries,
      }
    },
  }
}

function assertStep(tracker, name, cond, errDetail = '') {
  if (cond) tracker.record(name, true, 'ok')
  else tracker.record(name, false, errDetail || 'assertion failed')
}

function replaceProfilePlaceholders(agentsPath, { quick = 'exit 0', full = 'exit 0', smoke = 'none', gate = 'exit 0' }) {
  let raw = readFileSync(agentsPath, 'utf8')
    .replace('<快速验证命令>', quick)
    .replace('<全量测试命令>', full)
    .replace('<运行时端到端冒烟验证命令，或 none>', smoke)
    .replace('<合并前必过门禁命令>', gate)
    .replace('<跨层禁引规则如 src/lib/** -> src/ui/**，逗号分隔或 none>', 'none')
    .replace('<高风险路径前缀或文件，逗号分隔>', 'none')
    .replace(/^项目定位：[^\r\n]*/m, '项目定位：用于端到端工程治理验证的多语言样例仓库，提供核心计算 CLI。')
  raw = raw
    .replace(/^quick-test:.*$/m, `quick-test: ${quick}`)
    .replace(/^full-test:.*$/m, `full-test: ${full}`)
    .replace(/^smoke-verify:.*$/m, `smoke-verify: ${smoke}`)
    .replace(/^merge-gate:.*$/m, `merge-gate: ${gate}`)
    .replace(/^arch-rules:.*$/m, 'arch-rules: none')
    .replace(/^high-risk:.*$/m, 'high-risk: none')
  writeFileSync(agentsPath, raw, 'utf8')
}

async function runNodeOwnSkillsDay2AndUpgrade(tracker, envExtra) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# Blind Node App\n\n## Overview\n\nDemo service.\n',
    'README.en.md': '# Blind Node App\n\n## Overview\n\nDemo service.\n',
    'package.json': JSON.stringify({
      name: 'blind-node-loopforge-sample',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node test/unit.mjs' },
    }, null, 2),
    'src/engine.mjs': 'export const compute = (x) => x * 2\n',
    'test/unit.mjs': "import { compute } from '../src/engine.mjs'\nif (compute(3) !== 6) process.exit(1)\nconsole.log('NODE_UNIT_OK')\n",
    'test/smoke.mjs': [
      "import { compute } from '../src/engine.mjs'",
      "if (compute(3) !== 6) { console.error('bad compute path=/Users/blind/app token=ghp_1234567890abcdef1234567890abcdef12'); process.exit(2) }",
      "console.log('NODE_SMOKE_OK')",
    ].join('\n'),
    'skills/custom-auditor/SKILL.md': '---\nname: custom-auditor\ndescription: Audit custom domain invariants without clobbering.\n---\n\n# Custom Auditor\n',
    'packages/web/AGENTS.md': '# web-module\n\nKeep frontend clean.\n',
    'docs/specs/260101-existing-spec.md': '# Existing Foreign Spec\n\nDo not delete.\n',
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

  try {
    const s1 = await survey(dir, { quiet: true })
    assertStep(
      tracker,
      'node:survey-detects-stack-and-own-skills',
      Boolean(s1?.kit?.customSkills?.some((s) => s.name === 'custom-auditor')),
      JSON.stringify(s1?.kit?.customSkills),
    )

    const eq1 = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    const ca1 = runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    replaceProfilePlaceholders(join(dir, 'AGENTS.md'), {
      quick: 'node test/unit.mjs',
      full: 'node test/unit.mjs',
      smoke: 'node test/smoke.mjs',
      gate: 'node test/unit.mjs',
    })
    gitCommitFast(dir, 'chore: forge init full')
    const rev1 = runNode(join(SKILL_ROOT, 'scripts', 'review.mjs'), [dir, '--json'], dir, envExtra)
    const revJson = JSON.parse(rev1.stdout || '{}')
    const hasCoreGaps = (revJson.items ?? []).some((it) => it.status === 'missing' && ['git', 'secrets', 'agents'].includes(it.area))
    const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assertStep(
      tracker,
      'node:onboard-preserves-foreign-and-injects-custom-skill',
      eq1.status === 0 && ca1.status === 0 && !hasCoreGaps
      && agentsText.includes('custom-auditor')
      && existsSync(join(dir, 'packages', 'web', 'AGENTS.md'))
      && existsSync(join(dir, 'docs', 'specs', '260101-existing-spec.md')),
      `eq=${eq1.status} ca=${ca1.status} coreGaps=${hasCoreGaps}`,
    )

    const flow = join(dir, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
    const revPack = join(dir, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')

    const stRes = runNode(flow, ['start', '--task', 'd2', '--case', '2', '--slug', 'd2', '--implementer', 'alice'], dir, envExtra)
    const exRes = runNode(flow, ['explore', '--task', 'd2'], dir, envExtra)
    const wt = join(dir, '.worktrees', 'impl-d2')
    writeFileSync(join(wt, 'src', 'engine.mjs'), 'export const compute = (x) => x * 3\n', 'utf8')
    gitCommitFast(wt, 'wip: break smoke intentionally', { updateOnly: true })
    const failSmoke = runNode(flow, ['verify', '--task', 'd2', '--mode', 'smoke', '--json'], wt, envExtra)
    let failOk = failSmoke.status !== 0
    if (failOk) {
      const fJson = JSON.parse(failSmoke.stdout || '{}')
      const dStr = JSON.stringify(fJson.diagnostic ?? {})
      failOk = Boolean(fJson.diagnostic?.Evidence?.length && fJson.escalatedIssue?.ok && !dStr.includes('ghp_1234'))
    }
    assertStep(tracker, 'node:day2-e2e-fail-redacts-and-escalates', stRes.status === 0 && exRes.status === 0 && failOk, failSmoke.stdout)

    writeFileSync(join(wt, 'src', 'engine.mjs'), 'export const compute = (x) => x * 2\nexport const fixed = true\n', 'utf8')
    gitCommitFast(wt, 'fix: restore compute', { updateOnly: true })
    const vRes = runNode(flow, ['verify', '--task', 'd2', '--mode', 'gate', '--e2e-evidence', 'NODE_SMOKE_OK compute=6'], wt, envExtra)
    const subRes = runNode(flow, ['submit', '--task', 'd2', '--agent', 'alice'], wt, envExtra)
    const empRes = runNode(revPack, ['check-empirical', '--task', 'd2', '--dir', dir, '--json'], dir, envExtra)
    const tok = await issueTokenFor(dir, 'd2', 1)
    const recRes = runNode(revPack, ['record', '--task', 'd2', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-d2', '--review-token', tok, '--evidence', 'NODE_SMOKE_OK', '--json'], join(dir, '.worktrees', 'review-d2'), envExtra)
    const mRes = runNode(flow, ['merge', '--task', 'd2'], dir, envExtra)
    const cRes = runNode(flow, ['cleanup', '--task', 'd2', '--confirm'], dir, envExtra)
    assertStep(
      tracker,
      'node:day2-fix-e2e-review-merge-cleanup',
      vRes.status === 0 && subRes.status === 0 && empRes.status === 0 && recRes.status === 0 && mRes.status === 0 && cRes.status === 0,
      `v=${vRes.status} sub=${subRes.status} emp=${empRes.status} rec=${recRes.status} m=${mRes.status} c=${cRes.status}`,
    )

    // 二次 S1-S4 升级 + 删除墓碑不回写验证
    rmTree(join(dir, '.agents', 'skills', 'dev-govern'))
    gitCommitFast(dir, 'chore: tombstone dev-govern')
    const eq2 = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    const ca2 = runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    const agentsAfter = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assertStep(
      tracker,
      'node:secondary-upgrade-respects-tombstone-and-own-skills',
      eq2.status === 0 && ca2.status === 0
      && !existsSync(join(dir, '.agents', 'skills', 'dev-govern'))
      && agentsAfter.includes('custom-auditor')
      && existsSync(join(dir, 'packages', 'web', 'AGENTS.md')),
      `eq2=${eq2.status} ca2=${ca2.status}`,
    )
  } finally {
    rmTree(dir)
  }
}

async function runPythonBlindSample(tracker, envExtra) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n__pycache__/\n',
    'README.md': '# Blind Python Service\n',
    'pyproject.toml': '[project]\nname = "blind-py"\nversion = "0.1.0"\n',
    'src/calc.py': 'def add(a, b):\n    return a + b\n',
    'tests/test_calc.py': 'import unittest\nfrom src.calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == "__main__":\n    unittest.main()\n',
    'tests/smoke.py': 'import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))\nfrom src.calc import add\nassert add(10, 5) == 15\nprint("PY_SMOKE_OK")\n',
  })
  gitInit(dir, { branch: 'main', name: 'bob', email: 'bob@example.com' })
  try {
    const s = await survey(dir, { quiet: true })
    const eq = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    const ca = runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    assertStep(tracker, 'python:survey-and-equip', Boolean(s) && eq.status === 0 && ca.status === 0, `eq=${eq.status} ca=${ca.status}`)

    const pyCmd = findExecutable(['python', 'python3'])
    if (!pyCmd) {
      tracker.skipToolchain('python:native-unittest-and-smoke', 'host lacks python/python3 binary')
      return
    }
    replaceProfilePlaceholders(join(dir, 'AGENTS.md'), {
      quick: `${pyCmd} -m unittest discover -s tests`,
      full: `${pyCmd} -m unittest discover -s tests`,
      smoke: `${pyCmd} tests/smoke.py`,
      gate: `${pyCmd} -m unittest discover -s tests`,
    })
    gitCommitFast(dir, 'chore: configure python smoke')
    const flow = join(dir, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
    runNode(flow, ['start', '--task', 'py1', '--case', '2', '--slug', 'py1', '--implementer', 'bob'], dir, envExtra)
    await seedExploredFor(dir, 'py1')
    const wt = join(dir, '.worktrees', 'impl-py1')
    writeFileSync(join(wt, 'src', 'calc.py'), 'def add(a, b):\n    return int(a) + int(b)\n', 'utf8')
    gitCommitFast(wt, 'feat: py1 int add', { updateOnly: true })
    const vSmoke = runNode(flow, ['verify', '--task', 'py1', '--mode', 'gate', '--e2e-evidence', 'PY_SMOKE_OK add(10,5)=15'], wt, envExtra)
    assertStep(tracker, 'python:native-unittest-and-smoke', vSmoke.status === 0, vSmoke.stderr || vSmoke.stdout)
  } finally {
    rmTree(dir)
  }
}

async function runPolyglotGoRustBlindSample(tracker, envExtra) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\ntarget/\n',
    'README.md': '# Polyglot Go + Rust Sample\n',
    'go.mod': 'module example.com/blindgo\n\ngo 1.22\n',
    'cmd/cli/main.go': 'package main\nfunc Value() int { return 42 }\nfunc main() {}\n',
    'cmd/cli/main_test.go': 'package main\nimport "testing"\nfunc TestValue(t *testing.T) { if Value() != 42 { t.Fatal("bad") } }\n',
    'Cargo.toml': '[package]\nname = "blind_rust"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub fn mul(a: i32, b: i32) -> i32 { a * b }\n#[cfg(test)]\nmod tests {\n  use super::*;\n  #[test]\n  fn it_works() { assert_eq!(mul(3, 4), 12); }\n}\n',
  })
  gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@example.com' })
  try {
    const s = await survey(dir, { quiet: true })
    const eq = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    const ca = runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assertStep(
      tracker,
      'polyglot:go-rust-survey-and-compose',
      Boolean(s) && eq.status === 0 && ca.status === 0 && (agents.includes('go test') || agents.includes('cargo test')),
      `eq=${eq.status} ca=${ca.status}`,
    )

    const goCmd = findExecutable(['go'])
    if (goCmd) {
      const gr = spawnSync(goCmd, ['test', './...'], { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true })
      assertStep(tracker, 'go:native-test', gr.status === 0, gr.stderr)
    } else {
      tracker.skipToolchain('go:native-test', 'host lacks go binary')
    }
    const cargoCmd = findExecutable(['cargo'])
    if (cargoCmd) {
      const cr = spawnSync(cargoCmd, ['test', '--offline'], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true })
      assertStep(tracker, 'rust:native-test', cr.status === 0, cr.stderr)
    } else {
      tracker.skipToolchain('rust:native-test', 'host lacks cargo binary')
    }
  } finally {
    rmTree(dir)
  }
}

async function runZeroHintAndWeakModelGuard(tracker, sandbox, envExtra) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# Zero Hint & Weak Model Sample\n',
    'src/app.mjs': 'export const run = () => "v1"\n',
    'test/smoke.mjs': "import { run } from '../src/app.mjs'\nif (run() !== 'v2') process.exit(2)\nconsole.log('ZH_SMOKE_OK')\n",
  })
  const bareDir = join(sandbox, 'zh-bare.git')
  gitInitBare(bareDir)
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
  gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/blind-demo.git'])
  gitSync(dir, ['config', `url.${bareDir.replace(/\\/g, '/')}.pushInsteadOf`, 'https://github.com/acme/blind-demo.git'])
  try {
    runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    replaceProfilePlaceholders(join(dir, 'AGENTS.md'), { smoke: 'node test/smoke.mjs' })
    gitCommitFast(dir, 'chore: zh init')
    gitSync(dir, ['push', '-u', 'origin', 'main'])

    const flow = join(dir, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
    const revPack = join(dir, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')

    // 1. 裸粘贴 Issue / PR / Fork external PR URL 零提示路由
    const insIss = runNode(flow, ['inspect', 'https://github.com/acme/blind-demo/issues/42', '--json'], dir, envExtra)
    const insPr = runNode(flow, ['inspect', 'https://github.com/acme/blind-demo/pull/77', '--json'], dir, envExtra)
    const insExt = runNode(flow, ['inspect', '--external-pr', '88', '--json'], dir, envExtra)
    const jIss = JSON.parse(insIss.stdout || '{}')
    const jPr = JSON.parse(insPr.stdout || '{}')
    const jExt = JSON.parse(insExt.stdout || '{}')
    assertStep(
      tracker,
      'zero-hint:bare-issue-pr-and-external-pr-routing',
      insIss.status === 0 && jIss.inputs?.issues?.[0]?.number === 42
      && insPr.status === 0 && jPr.inputs?.prs?.[0]?.number === 77
      && insExt.status === 0 && jExt.identity?.role === 'inbound-external-pr',
      `iss=${insIss.status} pr=${insPr.status} ext=${insExt.status}`,
    )

    // 2. 弱模型守卫：缺 E2E 实证时 --include-diff 与 pass 必拦，实证后解锁 diff 与实质核查焦点
    runNode(flow, ['start', '--task', 'w1', '--case', '2', '--slug', 'w1', '--implementer', 'alice'], dir, envExtra)
    await seedExploredFor(dir, 'w1')
    const wt = join(dir, '.worktrees', 'impl-w1')
    writeFileSync(join(wt, 'src', 'app.mjs'), 'export const run = () => "v2"\n', 'utf8')
    gitCommitFast(wt, 'feat: w1 v2', { updateOnly: true })
    runNode(flow, ['verify', '--task', 'w1', '--mode', 'smoke', '--json'], wt, envExtra)
    runNode(revPack, ['--task', 'w1', '--dir', dir, '--json'], dir, envExtra)
    const revWt = join(dir, '.worktrees', 'review-w1')
    runNode(revPack, ['check-empirical', '--task', 'w1', '--dir', dir, '--json'], dir, envExtra)
    const origPre = readFileSync(join(revWt, 'src', 'app.mjs'), 'utf8')
    writeFileSync(join(revWt, 'src', 'app.mjs'), 'export const run = () => "broken"\n', 'utf8')
    runNode(revPack, ['check-fault', '--phase', 'fail', '--task', 'w1', '--dir', dir, '--cmd', 'node test/smoke.mjs', '--json'], dir, envExtra)
    writeFileSync(join(revWt, 'src', 'app.mjs'), origPre, 'utf8')
    runNode(revPack, ['check-fault', '--phase', 'restore', '--task', 'w1', '--dir', dir, '--cmd', 'node test/smoke.mjs', '--json'], dir, envExtra)

    const diffBlocked = runNode(revPack, ['--task', 'w1', '--dir', dir, '--include-diff', '--json'], dir, envExtra)
    const tok = await issueTokenFor(dir, 'w1', 1)
    const passBlocked = runNode(revPack, ['record', '--task', 'w1', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-weak', '--review-token', tok, '--evidence', 'ok', '--json'], revWt, envExtra)
    assertStep(
      tracker,
      'weak-model:blocks-diff-and-pass-before-e2e',
      diffBlocked.status === 3 && diffBlocked.stdout.includes('e2e-observation')
      && passBlocked.status === 2 && passBlocked.stdout.includes('BLOCKED_PASS_WITH_OPEN_BLOCKERS'),
      `diff=${diffBlocked.status} pass=${passBlocked.status}`,
    )

    // 补全 E2E + gate + submit + empirical + fault 后，--include-diff 放行并包含业务流/验收标准实质焦点
    const vE2e = runNode(flow, ['verify', '--task', 'w1', '--mode', 'gate', '--e2e-evidence', 'ZH_SMOKE_OK v2'], wt, envExtra)
    const subOk = runNode(flow, ['submit', '--task', 'w1', '--agent', 'alice'], wt, envExtra)
    const emp = runNode(revPack, ['check-empirical', '--task', 'w1', '--dir', dir, '--json'], dir, envExtra)
    const orig = readFileSync(join(revWt, 'src', 'app.mjs'), 'utf8')
    writeFileSync(join(revWt, 'src', 'app.mjs'), 'export const run = () => "broken"\n', 'utf8')
    const f1 = runNode(revPack, ['check-fault', '--phase', 'fail', '--task', 'w1', '--dir', dir, '--cmd', 'node test/smoke.mjs', '--json'], dir, envExtra)
    writeFileSync(join(revWt, 'src', 'app.mjs'), orig, 'utf8')
    const f2 = runNode(revPack, ['check-fault', '--phase', 'restore', '--task', 'w1', '--dir', dir, '--cmd', 'node test/smoke.mjs', '--json'], dir, envExtra)
    const diffUnlocked = runNode(revPack, ['--task', 'w1', '--dir', dir, '--include-diff', '--json'], dir, envExtra)
    assertStep(
      tracker,
      'weak-model:unlocks-diff-after-e2e-with-substance-focus',
      vE2e.status === 0 && subOk.status === 0 && emp.status === 0 && f1.status === 0 && f2.status === 0
      && diffUnlocked.status === 0 && diffUnlocked.stdout.includes('behavioralGate'),
      `v=${vE2e.status} sub=${subOk.status} emp=${emp.status} f1=${f1.status} f2=${f2.status} diff=${diffUnlocked.status}`,
    )
  } finally {
    rmTree(dir)
  }
}

async function runReadOnlyCloneSample(tracker, cloneSource, sandbox, envExtra) {
  const target = join(sandbox, 'cloned-sample')
  const cl = spawnSync('git', ['clone', '--depth', '1', cloneSource, target], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (cl.status !== 0) {
    tracker.recordErrorOnly('external-clone:read-only-survey', cl.stderr || 'clone failed')
    return
  }
  gitSync(target, ['remote', 'set-url', '--push', 'origin', 'DISALLOWED_READONLY'])
  const s = await survey(target, { quiet: true })
  const eqDry = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [target, '--dry-run', '--no-backup'], target, envExtra)
  assertStep(tracker, 'external-clone:read-only-survey-and-dry-run', Boolean(s) && eqDry.status === 0, eqDry.stderr)
}

export async function runBlindHarness({ cloneSource = null } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pf-blind-run-'))
  const envExtra = { PF_BACKUP_DIR: join(sandbox, 'backups'), PF_NO_REAL_AUTH_PROBE: '1' }
  const tracker = createTracker()
  try {
    await runNodeOwnSkillsDay2AndUpgrade(tracker, envExtra)
    await runPythonBlindSample(tracker, envExtra)
    await runPolyglotGoRustBlindSample(tracker, envExtra)
    await runZeroHintAndWeakModelGuard(tracker, sandbox, envExtra)
    const matrixMetrics = await runEvolutionBlindMatrix(tracker, sandbox, envExtra)
    if (cloneSource) {
      await runReadOnlyCloneSample(tracker, cloneSource, sandbox, envExtra)
    }
    return { ...tracker.summarize(), benchmark: BLIND_MODEL_BENCHMARK, matrixMetrics }
  } finally {
    rmTree(sandbox)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const cloneIdx = args.indexOf('--clone')
  const cloneSource = cloneIdx >= 0 ? args[cloneIdx + 1] : null
  const summary = await runBlindHarness({ cloneSource })
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    for (const e of summary.entries) {
      const tag = e.errorOnly ? 'ERR_ONLY' : (e.skipped ? 'SKIP_TOOL' : (e.succeeded ? 'PASS' : 'FAIL'))
      process.stdout.write(`${tag.padEnd(10)} ${e.name}${e.detail && e.detail !== 'ok' ? ` -- ${e.detail}` : ''}\n`)
    }
    process.stdout.write(`Blind Run Summary: executed=${summary.executed}, succeeded=${summary.succeeded}, errorOnly=${summary.errorOnly}, skipped=${summary.skipped}, ok=${summary.ok}\n`)
  }
  process.exit(summary.ok ? 0 : 1)
}
