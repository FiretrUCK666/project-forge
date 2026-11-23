/**
 * fixtures-gates-retro-routing.mjs —— 门禁精准化、复盘信号联动与路由加固正反双向行为断言。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleFinalize } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs'
import { runCli as runAuditCli } from '../../kit/skills/dev-govern/scripts/govern-audit.mjs'
import { handleRetro } from '../../kit/skills/dev-govern/scripts/govern-retro.mjs'
import { auditDoc } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { approveSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { assessDoor } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { isApprovedInternalPlan } from '../../kit/skills/lib/intake-triage.mjs'
import { updateTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { evaluatePlanExitGate } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { resolveGovernStateDir } from '../../kit/skills/lib/signals.mjs'
import { ASSERTION_RE, TAUTOLOGY_ASSERT_RE, detectGateWeakeningInEntry } from '../../kit/skills/lib/static-gates.mjs'
import { GenericRemoteBackend } from '../../kit/skills/lib/task-backend-local.mjs'
import { validateVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import {
  gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor,
  rmTree, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'

async function seedLedger(dir, taskId, fields) {
  await updateTaskLedger(dir, taskId, { taskId, ...fields }, { createIfMissing: true })
}

async function captureJson(fn) {
  let out = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    return origWrite('', ...rest)
  }
  try {
    const code = await fn()
    let parsed = null
    if (out.trim()) {
      try { parsed = JSON.parse(out.trim()) } catch { /* non-json stdout */ }
    }
    return { code, stdout: out, json: parsed }
  } finally {
    process.stdout.write = origWrite
  }
}

export function registerGatesRetroRoutingCases(cases) {
  // ── C1: 静态门禁精准化 ────────────────────────────────────────────────────
  cases.push(['C1 正反双向：同义反复断言 + 批量删断言升 deterministic + camelCase 识别', async () => {
    for (const taut of ['assert True', 'assert true', 'assert(true)', 'expect(true).toBe(true)', 'assert.ok(true)', 'assertTrue(true)', 'assert.equal(3, 3)']) {
      if (!TAUTOLOGY_ASSERT_RE.test(taut)) return `TAUTOLOGY_ASSERT_RE 未命中同义反复：${taut}`
    }
    for (const real of ['assert.equal(res.code, 3)', 'expect(res.ok).toBe(true)', 'assertEqual(t, got, want)']) {
      if (TAUTOLOGY_ASSERT_RE.test(real)) return `TAUTOLOGY_ASSERT_RE 误伤非恒真断言：${real}`
    }
    for (const camel of ['assertEqual(t, a, b)', 'assertNoError(err)', 'assertError(err)', 'assertDeepEqual(got, want)', 'assertNotEqual(a, b)', 'assertContains(s, sub)']) {
      if (!ASSERTION_RE.test(camel)) return `ASSERTION_RE 未识别 camelCase 断言：${camel}`
    }

    const addedBad = ['def test_fake():', '    assert True', '    assertEqual(t, got, want)']
    const removed39 = Array.from({ length: 39 }, (_, i) => `expect(v${i}).toBe(${i})`)
    const badHits = detectGateWeakeningInEntry({
      file: 'tests/test_sample.py',
      status: 'M',
      added: addedBad,
      removed: removed39,
      hunks: [{ removed: removed39, added: addedBad }],
    })
    const tautHit = badHits.find((h) => h.type === 'tautology-assertion' && h.severity === 'deterministic')
    const delHit = badHits.find((h) => h.type === 'deleted-assertion' && h.severity === 'deterministic')
    if (!tautHit) return `新增 assert True 未触发 deterministic tautology-assertion：${JSON.stringify(badHits)}`
    if (!delHit) return `净减 >= 3 且删改比 >= 50% 未升级 deterministic deleted-assertion：${JSON.stringify(badHits)}`

    const gateBad = assessDoor({
      reviewRoot: process.cwd(),
      mainRoot: process.cwd(),
      diff: { files: [{ file: 'tests/test_sample.py', status: 'M' }], untracked: [] },
      devProfile: {},
      hrHits: [],
      parity: { ok: true, missing: [], skipped: false },
      task: { riskTier: 'medium' },
      gateWeakenedHits: badHits,
    })
    if (!gateBad.gateWeakened || gateBad.gateWeakenedReasons.length === 0) {
      return `assessDoor 未对 deterministic 门禁弱化置 gateWeakened=true：${JSON.stringify(gateBad)}`
    }

    const addedGood = Array.from({ length: 4 }, (_, i) => `assertEqual(t, got${i}, want${i})`)
    const removedSmall = Array.from({ length: 4 }, (_, i) => `assert.strictEqual(got${i}, want${i})`)
    const cleanHits = detectGateWeakeningInEntry({
      file: 'pkg/sample_test.go',
      status: 'M',
      added: addedGood,
      removed: removedSmall,
      hunks: [{ removed: removedSmall, added: addedGood }],
    })
    if (cleanHits.some((h) => h.severity === 'deterministic')) {
      return `等价 camelCase 断言替换被误判 deterministic 弱化：${JSON.stringify(cleanHits)}`
    }
    return true
  }])

  // ── C2: edit-gate 仅扫 diff 新增行 + archive 放行 + doc-audit ./ ../ 解析 ──
  cases.push(['C2 正反双向：edit-gate 仅检新增行不误拦上游 workaround；新建文件/新增行仍拦；archive 放行', async () => {
    const dir = tmpProject({
      'AGENTS.md': '# A\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'src/legacy.js': '// workaround: upstream legacy\nexport function f() { return 1 }\n',
      'docs/todo/261123-t1-todo.md': '---\nkind: todo\nstatus: done\nowner: dev-a\n---\n# T\n- [x] C1: ok\n',
    })
    try {
      gitInit(dir)
      gitCommitFast(dir, 'chore: init')

      writeFileSync(join(dir, 'src/legacy.js'), '// workaround: upstream legacy\nexport function f() { return 2 }\n')
      const passExisting = await runEditGate({ mode: 'standalone', dir, changed: true })
      if (!passExisting.ok) {
        return `edit-gate 误拦已有上游 workaround 注释：${JSON.stringify(passExisting)}`
      }

      writeFileSync(join(dir, 'src/legacy.js'), '// workaround: upstream legacy\n// workaround: newly added\nexport function f() { return 2 }\n')
      const blockAdded = await runEditGate({ mode: 'standalone', dir, changed: true })
      if (blockAdded.ok) return 'edit-gate 未拦截新增的 // workaround 注释'

      writeFileSync(join(dir, 'src/legacy.js'), '// workaround: upstream legacy\nexport function f() { return 2 }\n')
      writeFileSync(join(dir, 'src/brand-new.js'), '// workaround: fresh\nexport const x = 1\n')
      const blockNew = await runEditGate({ mode: 'standalone', dir, changed: true })
      if (blockNew.ok) return 'edit-gate 未拦截新建文件中的 // workaround 注释'

      rmTree(join(dir, 'src/brand-new.js'))
      gitCommitFast(dir, 'fix: restore clean state')
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      writeFileSync(join(dir, 'docs/specs/261123-t1-spec.md'), '---\nkind: spec\nstatus: approved\nplan_critique: passed\nowner: dev-a\n---\n# S\n- [x] C1: ok\n')
      writeFileSync(join(dir, 'docs/todo/261123-t1-todo.md'), '---\nkind: todo\nstatus: in-progress\nowner: dev-a\nrelated_spec: ../specs/261123-t1-spec.md\n---\n# T\n- [x] C1: ok\n')
      gitCommitFast(dir, 'docs: add pair')
      await seedLedger(dir, 't1', {
        taskId: 't1',
        caseType: 'Case 3',
        specFile: 'docs/specs/261123-t1-spec.md',
        todoFile: 'docs/todo/261123-t1-todo.md',
        claimedBy: 'impl-1',
        claimedAt: new Date().toISOString(),
      })
      const finRes = await handleFinalize(
        { task: 't1', json: false },
        { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git'), isGit: true },
      )
      if (finRes.exitCode !== 0) return `flow finalize 归档失败：${JSON.stringify(finRes)}`
      const gateAfterArchive = await runEditGate({ mode: 'verify', final: true, dir, changed: true, task: 't1' })
      if (!gateAfterArchive.ok) {
        return `finalize 归档并暂存后 edit-gate --final 仍误拦 docs/archive/：${JSON.stringify(gateAfterArchive)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2 正反双向：doc-audit 正确解析 ./ 与 ../ 正文相对路径并拦截越界', async () => {
    const dir = tmpProject({
      'AGENTS.md': '# A\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'src/mod.js': 'export const ok = true\n',
      'docs/specs/sibling.md': '# Sibling\n',
      'docs/specs/261123-t2-spec.md': [
        '---',
        'kind: spec',
        'status: draft',
        'plan_critique: null',
        'owner: dev-a',
        '---',
        '# S',
        '## 要做什么',
        '兄弟文档 `./sibling.md` 与父目录源码 `../../src/mod.js` 均存在，用于验证相对路径解析与边界检查行为。',
        '## 验收标准',
        '- [ ] C1: 验证相对路径 `./sibling.md` 解析正确',
        '## 不做什么',
        '不改无关模块。',
      ].join('\n'),
    })
    try {
      const okAudit = auditDoc({ repoRoot: dir, file: 'docs/specs/261123-t2-spec.md' })
      const pathErrs = okAudit.errors.filter((e) => /路径不存在|越出仓库/.test(e.message ?? ''))
      if (pathErrs.length > 0) return `合法 ./ 与 ../ 相对路径被 doc-audit 误报：${JSON.stringify(pathErrs)}`

      writeFileSync(join(dir, 'docs/specs/261123-t2-spec.md'), [
        '---',
        'kind: spec',
        'status: draft',
        'plan_critique: null',
        'owner: dev-a',
        '---',
        '# S',
        '## 要做什么',
        '越界路径 `../../../../outside-secret.js` 必须被拦截并报告。',
        '## 验收标准',
        '- [ ] C1: 拦截越界路径',
        '## 不做什么',
        '不访问仓外文件。',
      ].join('\n'))
      const badAudit = auditDoc({ repoRoot: dir, file: 'docs/specs/261123-t2-spec.md' })
      if (badAudit.ok || !badAudit.errors.some((e) => /越出仓库|不存在的路径|HALLUCINATED_PATH/.test(`${e.code} ${e.message}`))) {
        return `越界 ../ 路径未被 doc-audit 拦截：${JSON.stringify(badAudit)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // ── C3: should-fix -> signals -> retro -> flow-next & skip-critique 防自签 ──
  cases.push(['C3 正反双向：should-fix 写入 signals.jsonl -> govern-retro 聚类 -> flow-next 读取 lastRetro', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# A\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: node -e "process.exit(0)"\n```\n',
      'src/app.js': 'export const v = 1\n',
      'docs/todo/261123-t3-todo.md': '---\nkind: todo\nstatus: in-progress\nowner: planner-a\n---\n# T\n- [x] C1: done\n',
    })
    try {
      gitInit(dir)
      gitCommitFast(dir, 'chore: init')
      writeFileSync(join(dir, 'src/app.js'), 'export const v = 2\n')
      gitCommitFast(dir, 'feat: update v')
      await seedLedger(dir, 't3', {
        taskId: 't3',
        caseType: 'Case 3',
        todoFile: 'docs/todo/261123-t3-todo.md',
        implementerId: 'impl-a',
        claimedBy: 'impl-a',
        claimedAt: new Date().toISOString(),
        branch: 'feat/t3',
      })
      await seedExploredFor(dir, 't3')
      await captureJson(() => handleVerify(
        { task: 't3', mode: 'gate', json: true },
        { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git'), isGit: true },
      ))

      const tok1 = await issueTokenFor(dir, 't3', 1)
      const { code: recRes } = await captureJson(() => handleRecord({
        task: 't3',
        verdict: 'pass',
        'reviewer-id': 'rev-1',
        'review-token': tok1,
        evidence: 'node ok.mjs: all checks passed',
        'should-fix': ['src/app.js#1: 建议抽出 helper 函数'],
        json: true,
      }, { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git'), isGit: true }))
      if (recRes !== 0) return `review-ledger record --should-fix 失败：${recRes}`

      const signalsPath = join(resolveGovernStateDir(dir, join(dir, '.git'), true), 'signals.jsonl')
      if (!existsSync(signalsPath)) return `signals.jsonl 未生成：${signalsPath}`
      const sigRaw = readFileSync(signalsPath, 'utf8')
      if (!sigRaw.includes('review.should-fix') || !sigRaw.includes('should-fix')) {
        return `should-fix 未按 review.should-fix 写入 signals.jsonl：${sigRaw}`
      }

      const { code: retroCode, json: retroJson } = await captureJson(() => handleRetro(dir, dir, join(dir, '.git'), true, {
        auto: true,
        json: true,
      }))
      if (retroCode !== 0) return `govern-retro 执行失败：${retroCode}`
      if ((retroJson.shouldFixCount ?? 0) < 1) {
        return `collectLedgerStats 未统计 shouldFixCount：${JSON.stringify(retroJson)}`
      }

      const rootsArg = { workTreeRoot: dir, mainRoot: dir, gitDir: join(dir, '.git'), isGit: true }
      const { code: nextCleanCode, json: nextCleanPayload } = await captureJson(async () => (await handleNext({ task: 't3', json: true }, rootsArg)).exitCode)
      if (nextCleanCode !== 0) {
        return `flow-next 执行失败：code=${nextCleanCode}`
      }
      if ((nextCleanPayload?.warnings ?? []).some((w) => w.code === 'WARN_RETRO_PENDING')) {
        return `无未消化聚类或待办时误发 WARN_RETRO_PENDING：${JSON.stringify(nextCleanPayload)}`
      }

      const statePath = join(dir, '.worktrees', '.state', 'govern-state.json')
      const curState = JSON.parse(readFileSync(statePath, 'utf8'))
      curState.lastRetro = {
        ...(curState.lastRetro ?? {}),
        tier1Count: 1,
      }
      writeFileSync(statePath, `${JSON.stringify(curState, null, 2)}\n`)
      const { json: nextWarn } = await captureJson(async () => (await handleNext({ task: 't3', json: true }, rootsArg)).exitCode)
      if (!nextWarn?.retroHint || !(nextWarn?.warnings ?? []).some((w) => w.code === 'WARN_RETRO_PENDING')) {
        return `存在未消化复发聚类时 flow-next 未发 WARN_RETRO_PENDING/retroHint：${JSON.stringify(nextWarn)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C3 正反双向：approveSpec --skip-critique-reason 写账本留痕；裸写 YAML skipped 阻断', async () => {
    const validSpec = [
      '---',
      'kind: spec',
      'status: draft',
      'plan_critique: null',
      'owner: dev-a',
      '---',
      '# 紧急修复规范',
      '## 要做什么',
      '生产连接池泄漏需热修并补测，在事务结束后立即归还连接并增加连接计数断言。',
      '## 验收标准',
      '- [ ] C1: 连接正确释放且测试通过',
      '## 不做什么',
      '本次不改公开 API 或连接池对外配置格式。',
    ].join('\n')
    const dir = tmpProject({
      'AGENTS.md': '# A\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'docs/specs/261123-t4-spec.md': validSpec,
      'docs/specs/261123-bare-spec.md': validSpec
        .replace('plan_critique: null', 'plan_critique: skipped (reason=紧急停线修复，绕过内审仅放行本次连接释放热修)')
        .replace('status: draft', 'status: approved'),
    })
    try {
      gitInit(dir)
      gitCommitFast(dir, 'chore: init')
      await seedLedger(dir, 't4', {
        taskId: 't4',
        caseType: 'Case 4',
        specFile: 'docs/specs/261123-t4-spec.md',
        branch: 'feat/t4',
      })

      const approved = approveSpec({
        repoRoot: dir,
        mainRoot: dir,
        gitDir: join(dir, '.git'),
        file: 'docs/specs/261123-t4-spec.md',
        skipCritiqueReason: '停线生产连接泄漏紧急热修，已由人工核验范围与漏检连接池边界后放行',
        taskId: 't4',
        hostMode: 'single-session',
        humanApproved: true,
      })
      if (approved.status !== 'approved') return `approveSpec 合法跳过内审失败：${JSON.stringify(approved)}`

      const gateOk = evaluatePlanExitGate(dir, {
        caseType: 4,
        slug: 't4',
        taskId: 't4',
        docs: { spec: 'docs/specs/261123-t4-spec.md' },
      })
      if (!gateOk.ok) return `有账本授权留痕的 skipped 仍被 plan-exit-gate 阻断：${JSON.stringify(gateOk)}`

      const intakeOk = isApprovedInternalPlan(dir, { taskId: 't4' })
      if (!intakeOk.exempt) return `有账本授权留痕的 skipped 未通过 isApprovedInternalPlan：${JSON.stringify(intakeOk)}`

      await seedLedger(dir, 'bare', {
        taskId: 'bare',
        caseType: 'Case 4',
        specFile: 'docs/specs/261123-bare-spec.md',
        branch: 'feat/bare',
      })
      const gateBad = evaluatePlanExitGate(dir, {
        caseType: 4,
        slug: 'bare',
        taskId: 'bare',
        docs: { spec: 'docs/specs/261123-bare-spec.md' },
      })
      if (gateBad.ok) return '裸写 YAML plan_critique: skipped 且无账本留痕却通过了 plan-exit-gate'

      const intakeBad = isApprovedInternalPlan(dir, { taskId: 'bare' })
      if (intakeBad.exempt) return '裸写 YAML plan_critique: skipped 且无账本留痕却通过了 isApprovedInternalPlan'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // ── C4: testdata secrets 豁免 / Go bench 豁免 / cmd 报错 / pnpm env / bare FF / 浅提示路由 ──
  cases.push(['C4 正反双向：testdata 凭据豁免 + Go bench/example 测试豁免 + 真实零断言仍报', async () => {
    const dir = tmpProject({
      'README.md': '# Go Sample\n',
      'AGENTS.md': [
        '# A',
        '```yaml',
        'quick-test: none',
        'full-test: none',
        'smoke-verify: none',
        '```',
        '## 取舍',
        '```text',
        '- `no-tdd`: 夹具工程免 TDD.md',
        '- `secrets-are-placeholders`: 测试夹具仅含占位密钥',
        '```',
      ].join('\n'),
      'testdata/sample.pem': `${'-----BEGIN '}RSA PRIVATE KEY-----\nTEST_PLACEHOLDER\n${'-----END '}RSA PRIVATE KEY-----\n`,
      'pkg/math_bench_test.go': 'package pkg\nimport "testing"\nfunc BenchmarkAdd(b *testing.B) { for i := 0; i < b.N; i++ {} }\n',
      'pkg/math_example_test.go': 'package pkg\nimport "fmt"\nfunc ExampleAdd() { fmt.Println(2) }\n',
    })
    try {
      gitInit(dir)
      gitCommitFast(dir, 'chore: init')

      const { code: okCode, json: okJson } = await captureJson(() => runAuditCli(['audit', dir, '--strict', '--json']))
      if (okCode !== 0 || (okJson.findings ?? []).some((f) => f.category === 'security' || String(f.id ?? '').startsWith('tests.zero-assertion'))) {
        return `testdata/*.pem + Go bench/example 在 strict 下误阻断：findings=${JSON.stringify(okJson.findings)}`
      }

      writeFileSync(join(dir, 'pkg/real_test.go'), 'package pkg\nimport "testing"\nfunc TestEmpty(t *testing.T) { x := 1 + 1; _ = x }\n')
      const { json: badJson } = await captureJson(() => runAuditCli(['audit', dir, '--strict', '--json']))
      if (!(badJson.findings ?? []).some((f) => f.ruleId === 'tests.zero-assertion' || String(f.id ?? '').startsWith('tests.zero-assertion'))) {
        return `Go 真实无断言 TestEmpty 未触发 tests.zero-assertion：findings=${JSON.stringify(badJson.findings)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C4 正反双向：validateVerificationEvidence 自定义 --cmd 不一致报明晰原因（非误导 [none]）', () => {
    const headSha = 'abc1234567890'
    const res = validateVerificationEvidence({
      policy: { riskTier: 'medium', requiredGates: ['smoke', 'gate'], smokeRequired: true, e2eObservationRequired: true },
      profile: { quickTest: 'node test-q.mjs', fullTest: 'node test-f.mjs', smokeVerify: 'node test-smoke.mjs' },
      headSha,
      evidence: {
        headSha,
        dirty: false,
        smokeVerifiedOnHead: true,
        e2eObservation: { headSha, summary: 'ran custom command and observed 0 errors on exit' },
        gates: {
          smoke: {
            headSha,
            dirty: false,
            exitCode: 0,
            partial: false,
            executed: true,
            succeeded: true,
            customCmd: true,
            cmd: 'node something-else.mjs',
          },
        },
      },
    })
    if (res.ok) return '不一致的自定义 --cmd 被错误放行'
    if (res.reason.includes('已通过 [none]') || !res.reason.includes('不一致') || !res.reason.includes('node test-smoke.mjs')) {
      return `自定义 --cmd 被拒时报错未写明原因或仍打印误导 [none]：${res.reason}`
    }
    return true
  }])

  cases.push(['C4 正反双向：worktree + pnpm + 共享 node_modules 注入 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false', async () => {
    const mainDir = tmpProject({
      'AGENTS.md': '# A\n```yaml\nquick-test: pnpm -v\nfull-test: pnpm -v\nsmoke-verify: node ok.mjs\n```\n',
      'package.json': '{"name":"wt-pnpm-test","version":"1.0.0"}\n',
      'ok.mjs': 'console.log("ok")\n',
      'node_modules/.keep': '1\n',
    })
    const wtDir = join(mainDir, '.worktrees', 'impl-pnpm')
    try {
      gitInit(mainDir)
      writeFileSync(join(mainDir, '.gitignore'), '.worktrees/\nnode_modules/\n')
      gitCommitFast(mainDir, 'chore: init')
      gitSync(mainDir, ['worktree', 'add', '-b', 'feat/pnpm', wtDir, 'HEAD'])
      symlinkSync(join(mainDir, 'node_modules'), join(wtDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

      writeFileSync(join(wtDir, 'pnpm-probe.mjs'), 'if (process.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN !== "false") process.exit(42)\n')
      writeFileSync(join(wtDir, 'AGENTS.md'), '# A\n```yaml\nquick-test: node pnpm-probe.mjs && echo pnpm\nfull-test: none\nsmoke-verify: node ok.mjs\n```\n')
      gitCommitFast(wtDir, 'feat: pnpm wt')
      await seedLedger(mainDir, 'pnpm', {
        taskId: 'pnpm',
        caseType: 'Case 2',
        worktreePath: '.worktrees/impl-pnpm',
        branch: 'feat/pnpm',
        claimedBy: 'impl-p',
        claimedAt: new Date().toISOString(),
      })

      const res = await handleVerify(
        { task: 'pnpm', mode: 'quick', cmd: 'node pnpm-probe.mjs && echo pnpm', json: true },
        { workTreeRoot: wtDir, mainRoot: mainDir, gitDir: join(mainDir, '.git'), isGit: true },
      )
      if (res.exitCode !== 0) return `worktree + pnpm + 共享 node_modules 未自动注入 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false：${JSON.stringify(res)}`
      return true
    } finally {
      try { gitSync(mainDir, ['worktree', 'remove', '--force', wtDir]) } catch { /* ignore */ }
      rmTree(mainDir)
    }
  }])

  cases.push(['C4 正反双向：GenericRemoteBackend.mergePr 仅在本地裸仓 + reviewPassed + solo-fast-forward + 可快进时放行', async () => {
    const bare = tmpProject({})
    const work = tmpProject({
      'AGENTS.md': [
        '# A',
        '```yaml',
        'quick-test: none',
        'full-test: none',
        'smoke-verify: none',
        '```',
        '## 取舍',
        '```text',
        '- `solo-fast-forward`: 单人本地裸仓快进合入',
        '```',
      ].join('\n'),
      'a.txt': 'v1\n',
    })
    try {
      gitInitBare(bare)
      gitInit(work, { branch: 'main' })
      gitSync(work, ['remote', 'add', 'origin', bare])
      gitSync(work, ['push', '-u', 'origin', 'main'])

      gitSync(work, ['checkout', '-b', 'feat/ff'])
      writeFileSync(join(work, 'a.txt'), 'v2\n')
      gitCommitFast(work, 'feat: ff commit')
      const headSha = gitSync(work, ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
      gitSync(work, ['push', '-u', 'origin', 'feat/ff'])

      const backend = new GenericRemoteBackend({ pushRemote: 'origin', mainRoot: work, gitDir: join(work, '.git') })

      const unreviewed = await backend.mergePr({
        branch: 'feat/ff',
        baseBranch: 'main',
        ledger: { branch: 'feat/ff', baseBranch: 'main', reviewPassed: false },
      })
      if (unreviewed.merged) return `未过审时本地裸仓误放行快进：${JSON.stringify(unreviewed)}`

      const ffOk = await backend.mergePr({
        branch: 'feat/ff',
        baseBranch: 'main',
        ledger: { branch: 'feat/ff', baseBranch: 'main', reviewPassed: true, reviewPassedHead: headSha },
      })
      if (!ffOk.merged || !ffOk.localBareFastForward) return `符合条件的本地裸仓未执行快进：${JSON.stringify(ffOk)}`
      const remoteMain = gitSync(bare, ['rev-parse', 'refs/heads/main'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
      if (remoteMain !== headSha) return `本地裸仓 main 未更新到 ${headSha}：实际 ${remoteMain}`

      gitSync(work, ['checkout', '-b', 'feat/no-flag'])
      writeFileSync(join(work, 'AGENTS.md'), '# A\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\n```\n')
      gitCommitFast(work, 'docs: remove flag')
      const noFlagSha = gitSync(work, ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
      gitSync(work, ['push', '-u', 'origin', 'feat/no-flag'])
      const blocked = await backend.mergePr({
        branch: 'feat/no-flag',
        baseBranch: 'main',
        ledger: { branch: 'feat/no-flag', baseBranch: 'main', reviewPassed: true, reviewPassedHead: noFlagSha },
      })
      if (blocked.merged || blocked.code !== 'BLOCKED_REMOTE_NOT_MERGED') {
        return `缺少 solo-fast-forward 却误放行或错误码不对：${JSON.stringify(blocked)}`
      }
      return true
    } finally {
      rmTree(work)
      rmTree(bare)
    }
  }])

  cases.push(['C4 正向：AGENTS 模板与 dev-iterate/dev-govern SKILL 含只读转写隔离路由规则', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    for (const rel of [
      'templates/agents-project.md',
      'kit/skills/dev-iterate/SKILL.md',
      'kit/skills/dev-govern/SKILL.md',
    ]) {
      const txt = readFileSync(join(repoRoot, rel), 'utf8')
      if (!/flow\.mjs start/.test(txt) || !/edit-gate/.test(txt)) {
        return `${rel} 缺少从只读探索/扩展测试/治理修复转入文件写改时的 flow.mjs start / edit-gate 路由指令`
      }
    }
    return true
  }])

  // ── C5: fixtures-helpers 进程退出临时目录自清验证 ───────────────────────────
  cases.push(['C5 正反双向：fixtures-helpers 跟踪临时目录并在子进程退出时自动清理', () => {
    const r = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import { tmpProject } from './scripts/dev/fixtures-helpers.mjs';",
        "const d = tmpProject({ 'a.txt': '1' });",
        "process.stdout.write(d);",
      ].join(''),
    ], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) return `子进程执行失败：${r.stderr}`
    const created = (r.stdout || '').trim()
    if (!created) return '未输出创建的临时目录路径'
    if (existsSync(created)) {
      rmTree(created)
      return `子进程退出后临时目录未自清：${created}`
    }
    return true
  }])
}
