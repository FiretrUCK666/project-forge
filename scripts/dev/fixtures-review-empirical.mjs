/**
 * fixtures-review-empirical.mjs —— Issue #57 审查「先跑实证与故障注入再允许 --include-diff」双向断言夹具。
 *
 * 覆盖 C1–C3 全部正反双向断言：
 *   1. formatPackText 纯文本旁路封堵（不带 --include-diff 不打印 240 行补丁）
 *   2. --task / --pr / --local / --staged / --base 全模式 --include-diff 前置阻断（exit 3 BLOCKED_EMPIRICAL_FIRST）
 *   3. 实证 + 两阶段故障注入闭环解锁，并拦截空突变/假通过/脏残留
 *   4. Slot 保护（不洗掉故障、不破坏 --local 原未提交改动）、多轮/sync 变基/--local 改文件失效、纯文档豁免、外部 PR 未扫阻断
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createFakeGhEnv, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const RP_SCRIPT = 'kit/skills/dev-review/scripts/review-pack.mjs'

async function runRp(args, cwd, env) {
  return runAbsAsync(RP_SCRIPT, args, { cwd, ...(env ? { env } : {}) })
}

function makeTestRepo({ extraFiles = {}, agentsYaml } = {}) {
  const defaultYaml = [
    'quick-test: node test.mjs',
    'full-test: node test.mjs',
    'smoke-verify: none',
    'merge-gate: node test.mjs',
  ].join('\n')
  const yamlBody = agentsYaml !== undefined ? agentsYaml : defaultYaml
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'AGENTS.md': `# emp-demo\n\n## Dev Profile\n\`\`\`yaml\n${yamlBody}\n\`\`\`\n`,
    'src/app.mjs': 'export const computeVal = () => 1\n',
    'test.mjs': [
      "import assert from 'node:assert/strict'",
      "import { computeVal } from './src/app.mjs'",
      'assert.equal(computeVal(), 2)',
      '',
    ].join('\n'),
    ...extraFiles,
  })
  gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@emp.test' })
  return dir
}

export function registerReviewEmpiricalCases(cases) {
  cases.push(['纯文本旁路封堵：未传 --include-diff 时 formatPackText 不得泄露原始 diff 补丁', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i}`).join('\n')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# plain-leak\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/mod.mjs': 'export const base = 0\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@emp.test' })
    try {
      writeFileSync(join(dir, 'src/mod.mjs'), `export const secret = 'SECRET_DIFF_LINE_BYPASS_999'\n${filler}\n`)

      // 正向：不传 --include-diff 的纯文本输出只能有 hunkIndex 摘要，不得泄露补丁正文行
      const plain = await runRp(['--local'], dir)
      if (plain.status !== 0) return `不传 --include-diff 纯文本 pack 失败：exit=${plain.status} err=${plain.stderr}`
      if (!plain.stdout.includes('Changed Files & Hunk Index') || !plain.stdout.includes('src/mod.mjs')) {
        return `纯文本包缺少 hunkIndex 文件摘要：\n${plain.stdout}`
      }
      if (plain.stdout.includes('SECRET_DIFF_LINE_BYPASS_999') || plain.stdout.includes('+export const line1') || plain.stdout.includes('@@ -')) {
        return `纯文本旁路泄露了原始 diff 补丁行：\n${plain.stdout.slice(0, 800)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['--include-diff 前置阻断：未过实证闭环前全模式返回 BLOCKED_EMPIRICAL_FIRST (exit 3)', async () => {
    const dir = makeTestRepo({
      extraFiles: {
        'package.json': '{"name":"emp","version":"1.0.0"}\n',
        'package-lock.json': '{"name":"emp","lockfileVersion":3}\n',
      },
    })
    gitCommitFast(dir, 'add manifest')
    const sentinel = 'SENTINEL_SECRET_PATCH_C1_777'

    try {
      // 1. --local (json & text)
      writeFileSync(join(dir, 'src/app.mjs'), `// ${sentinel}\nexport const computeVal = () => 2\n`)
      for (const extra of [['--json'], []]) {
        const res = await runRp(['--local', '--include-diff', ...extra], dir)
        if (res.status !== 3) return `--local --include-diff 未阻断（extra=${extra.join(',')}）：exit=${res.status} out=${res.stdout}`
        const combined = `${res.stdout}\n${res.stderr}`
        if (!combined.includes('BLOCKED_EMPIRICAL_FIRST')) return `--local 未返回 BLOCKED_EMPIRICAL_FIRST：${combined}`
        if (res.stdout.includes(sentinel) || res.stdout.includes('@@ -')) return `--local 阻断时仍泄露了 diffText/补丁：${res.stdout}`
        if (extra.includes('--json')) {
          const j = JSON.parse(res.stdout)
          if (j.status !== 'BLOCKED_EMPIRICAL_FIRST' || j.diffText !== undefined || !(j.missingSteps?.length > 0) || !(j.unblockCommands?.length > 0)) {
            return `--local --json 阻断载荷字段不完整：${res.stdout}`
          }
        }
      }

      // 2. --staged (json & text)
      gitSync(dir, ['add', 'src/app.mjs'])
      for (const extra of [['--json'], []]) {
        const res = await runRp(['--staged', '--include-diff', ...extra], dir)
        if (res.status !== 3 || !`${res.stdout}\n${res.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
          return `--staged --include-diff 未阻断：exit=${res.status} out=${res.stdout}`
        }
        if (res.stdout.includes(sentinel)) return `--staged 阻断时泄露了 diff`
      }

      // 3. --base main (json & text)
      gitSync(dir, ['checkout', '-qb', 'feat/base-check'])
      gitCommitFast(dir, 'feat: base check', { updateOnly: true })
      for (const extra of [['--json'], []]) {
        const res = await runRp(['--base', 'main', '--include-diff', ...extra], dir)
        if (res.status !== 3 || !`${res.stdout}\n${res.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
          return `--base --include-diff 未阻断：exit=${res.status} out=${res.stdout}`
        }
        if (res.stdout.includes(sentinel)) return `--base 阻断时泄露了 diff`
      }
      gitSync(dir, ['checkout', '-q', 'main'])

      // 4. --task (Tier 2 flow)
      const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
      const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
      const roots = await resolveRepoRoots(dir)
      await handleStart({ task: 'c1-t', case: '2', slug: 'c1-t', implementer: 'alice' }, roots)
      const implWt = join(dir, '.worktrees', 'impl-c1-t')
      writeFileSync(join(implWt, 'src/app.mjs'), `// ${sentinel}\nexport const computeVal = () => 2\n`)
      gitCommitFast(implWt, 'feat: c1-t', { updateOnly: true })
      const vRes = await handleVerify({ task: 'c1-t', mode: 'full' }, roots)
      if (vRes.exitCode !== 0) return `c1-t verify 失败：${vRes.exitCode}`
      await handleSubmit({ task: 'c1-t', agent: 'alice' }, roots)

      for (const extra of [['--json'], []]) {
        const res = await runRp(['--task', 'c1-t', '--include-diff', ...extra], dir)
        if (res.status !== 3 || !`${res.stdout}\n${res.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
          return `--task --include-diff 未阻断：exit=${res.status} out=${res.stdout}`
        }
        if (res.stdout.includes(sentinel) || res.stdout.includes('@@ -')) return `--task 阻断时泄露了 diff`
      }

      // 5. --pr (clean external PR after --untrusted-scan)
      const baseSha501 = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/emp-demo.git'])
      gitSync(dir, ['checkout', '-qb', 'ext-c1-pr'])
      writeFileSync(join(dir, 'src/app.mjs'), `// ${sentinel}\nexport const computeVal = () => 2\n`)
      gitCommitFast(dir, 'ext pr change', { updateOnly: true })
      const extSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(dir, ['checkout', '-q', 'main'])
      await handleStart({ task: 'review-pr-501', 'external-pr': '501', 'pr-ref': extSha }, roots)
      const fakeGh501 = createFakeGhEnv({
        prs: {
          501: {
            number: 501, title: 'Ext 501', state: 'OPEN', body: 'test', url: 'https://github.com/acme/emp-demo/pull/501',
            baseRefName: 'main', headRefName: 'ext-c1-pr', baseRefOid: baseSha501, headRefOid: extSha, author: { login: 'ext' },
          },
        },
      })
      try {
        const scanRes = await runRp(['--pr', '501', '--untrusted-scan', '--json'], dir, fakeGh501.env)
        if (scanRes.status !== 0) return `干净外部 PR --untrusted-scan 失败：${scanRes.stderr}`

        for (const extra of [['--json'], []]) {
          const res = await runRp(['--pr', '501', '--include-diff', ...extra], dir, fakeGh501.env)
          if (res.status !== 3 || !`${res.stdout}\n${res.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
            return `--pr --include-diff 未阻断：exit=${res.status} out=${res.stdout}`
          }
          if (res.stdout.includes(sentinel)) return `--pr 阻断时泄露了 diff`
        }
      } finally { fakeGh501.cleanup() }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['实证与故障注入解锁闭环：拦截空突变、套话命令、脏残留并完整解锁 --include-diff', async () => {
    const dir = makeTestRepo({
      extraFiles: {
        'package.json': '{"name":"c2-app","version":"1.0.0"}\n',
        'package-lock.json': '{"name":"c2-app","lockfileVersion":3}\n',
      },
    })
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'export const d = 1\n')
    gitCommitFast(dir, 'add dep lock')

    const sentinel = 'UNIQUE_PATCH_C2_888'
    try {
      const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
      const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
      const roots = await resolveRepoRoots(dir)

      await handleStart({ task: 'c2-t', case: '2', slug: 'c2-t', implementer: 'alice' }, roots)
      const implWt = join(dir, '.worktrees', 'impl-c2-t')
      const revWt = join(dir, '.worktrees', 'review-c2-t')
      writeFileSync(join(implWt, 'src/app.mjs'), `// ${sentinel}\nexport const computeVal = () => 2\n`)
      gitCommitFast(implWt, 'feat: c2', { updateOnly: true })
      if ((await handleVerify({ task: 'c2-t', mode: 'full' }, roots)).exitCode !== 0) return 'c2-t verify 失败'
      await handleSubmit({ task: 'c2-t', agent: 'alice' }, roots)

      // Step 1: 机械包 -> exit 0, readyForDiff=false, 无 diffText
      const p1 = await runRp(['--task', 'c2-t', '--json'], dir)
      if (p1.status !== 0) return `Step 1 pack 失败：${p1.stderr}`
      const p1Json = JSON.parse(p1.stdout)
      if (p1Json.diffText !== undefined || p1Json.empiricalGate?.readyForDiff !== false || !p1Json.empiricalGate?.steps?.mechanicalPack?.done) {
        return `Step 1 pack empiricalGate 异常：${JSON.stringify(p1Json.empiricalGate)}`
      }

      // Step 2: check-empirical（省略 --cmd，自动从 Dev Profile 提取执行）
      const empOk = await runRp(['check-empirical', '--task', 'c2-t', '--json'], dir)
      if (empOk.status !== 0 || JSON.parse(empOk.stdout).status !== 'EMPIRICAL_VERIFIED') {
        return `Step 2 check-empirical 失败：exit=${empOk.status} out=${empOk.stdout} err=${empOk.stderr}`
      }

      // 反向 1：未改工作区直接 check-fault --phase fail -> BLOCKED_FAULT_NO_MUTATION (exit 3)
      const noMut = await runRp(['check-fault', '--phase', 'fail', '--task', 'c2-t', '--cmd', 'node test.mjs', '--json'], dir)
      if (noMut.status !== 3 || !`${noMut.stdout}\n${noMut.stderr}`.includes('BLOCKED_FAULT_NO_MUTATION')) {
        return `未改工作区做故障注入未被拦截 BLOCKED_FAULT_NO_MUTATION：exit=${noMut.status} out=${noMut.stdout}`
      }

      // 注入故障到 review worktree
      writeFileSync(join(revWt, 'src/app.mjs'), `// ${sentinel}\nexport const computeVal = () => 999\n`)

      // 反向 2：故障存在时套话命令依然返回 0 -> BLOCKED_FAULT_NOT_CAUGHT (exit 3)
      const notCaught = await runRp(['check-fault', '--phase', 'fail', '--task', 'c2-t', '--cmd', 'exit 0', '--json'], dir)
      if (notCaught.status !== 3 || !`${notCaught.stdout}\n${notCaught.stderr}`.includes('BLOCKED_FAULT_NOT_CAUGHT')) {
        return `故障下退出 0 未拦截 BLOCKED_FAULT_NOT_CAUGHT：exit=${notCaught.status} out=${notCaught.stdout}`
      }

      // Step 3a 正向：故障下真实测试变红 -> exit 0 FAULT_INJECTED_FAILED
      const faultFail = await runRp(['check-fault', '--phase', 'fail', '--task', 'c2-t', '--cmd', 'node test.mjs', '--json'], dir)
      if (faultFail.status !== 0 || JSON.parse(faultFail.stdout).status !== 'FAULT_INJECTED_FAILED') {
        return `Step 3a check-fault --phase fail 失败：exit=${faultFail.status} out=${faultFail.stdout} err=${faultFail.stderr}`
      }

      // 反向 3：未还原时 --phase restore 与 --task --include-diff 必须报 BLOCKED_DIRTY_FAULT_RESIDUE (exit 3)
      const dirtyRestore = await runRp(['check-fault', '--phase', 'restore', '--task', 'c2-t', '--cmd', 'node test.mjs', '--json'], dir)
      if (dirtyRestore.status !== 3 || !`${dirtyRestore.stdout}\n${dirtyRestore.stderr}`.includes('BLOCKED_DIRTY_FAULT_RESIDUE')) {
        return `未还原时 --phase restore 未报 BLOCKED_DIRTY_FAULT_RESIDUE：exit=${dirtyRestore.status} out=${dirtyRestore.stdout}`
      }
      const dirtyDiff = await runRp(['--task', 'c2-t', '--include-diff', '--json'], dir)
      if (dirtyDiff.status !== 3 || !`${dirtyDiff.stdout}\n${dirtyDiff.stderr}`.includes('BLOCKED_DIRTY_FAULT_RESIDUE')) {
        return `未还原时 --task --include-diff 未在 sync 前拦截 BLOCKED_DIRTY_FAULT_RESIDUE：exit=${dirtyDiff.status} out=${dirtyDiff.stdout} err=${dirtyDiff.stderr}`
      }
      const dirtyResetDiff = await runRp(['--task', 'c2-t', '--reset-review-slot', '--include-diff', '--json'], dir)
      if (dirtyResetDiff.status !== 3 || !`${dirtyResetDiff.stdout}\n${dirtyResetDiff.stderr}`.includes('BLOCKED_DIRTY_FAULT_RESIDUE')) {
        return `携带 --reset-review-slot --include-diff 竟绕过了脏故障残留检查：exit=${dirtyResetDiff.status}`
      }

      // 还原文件但尚未跑 --phase restore -> 仍报 BLOCKED_DIRTY_FAULT_RESIDUE (exit 3)
      gitSync(revWt, ['checkout', '--', 'src/app.mjs'])
      const unverifiedRestoreDiff = await runRp(['--task', 'c2-t', '--include-diff', '--json'], dir)
      if (unverifiedRestoreDiff.status !== 3 || !`${unverifiedRestoreDiff.stdout}\n${unverifiedRestoreDiff.stderr}`.includes('BLOCKED_DIRTY_FAULT_RESIDUE')) {
        return `未执行 --phase restore 复绿前不应放行 --include-diff：exit=${unverifiedRestoreDiff.status} out=${unverifiedRestoreDiff.stdout}`
      }

      // Step 3b 正向：还原复绿 -> exit 0 FAULT_RESTORED_CLEAN
      const faultRest = await runRp(['check-fault', '--phase', 'restore', '--task', 'c2-t', '--cmd', 'node test.mjs', '--json'], dir)
      if (faultRest.status !== 0 || JSON.parse(faultRest.stdout).status !== 'FAULT_RESTORED_CLEAN') {
        return `Step 3b check-fault --phase restore 失败：exit=${faultRest.status} out=${faultRest.stdout} err=${faultRest.stderr}`
      }

      // Step 4 正向：--include-diff 放行（JSON + 纯文本）
      const unlockedJson = await runRp(['--task', 'c2-t', '--include-diff', '--json'], dir)
      if (unlockedJson.status !== 0) return `Step 4 --include-diff JSON 被拒：exit=${unlockedJson.status} out=${unlockedJson.stdout} err=${unlockedJson.stderr}`
      const uj = JSON.parse(unlockedJson.stdout)
      if (uj.diff?.diffIncluded !== true || !uj.diffText?.includes(sentinel)) {
        return `解锁后 JSON 缺少 diffText：${unlockedJson.stdout.slice(0, 400)}`
      }
      const unlockedText = await runRp(['--task', 'c2-t', '--include-diff'], dir)
      if (unlockedText.status !== 0 || !unlockedText.stdout.includes(sentinel)) {
        return `解锁后纯文本未输出完整 diffText：exit=${unlockedText.status}`
      }

      // 同步验证 --local 闭环不破坏原有未提交修改 E0
      const localDir = makeTestRepo({ extraFiles: { 'notes.txt': 'keep my uncommitted note\n' } })
      try {
        // 先保留一个原有未提交改动 E0
        writeFileSync(join(localDir, 'src/app.mjs'), '// E0_ORIGINAL_UNCOMMITTED\nexport const computeVal = () => 2\n')
        const lp1 = await runRp(['--local', '--json'], localDir)
        if (lp1.status !== 0) return `--local Step 1 失败：${lp1.stderr}`
        const lemp = await runRp(['check-empirical', '--local', '--cmd', 'node test.mjs', '--json'], localDir)
        if (lemp.status !== 0) return `--local check-empirical 失败：${lemp.stderr}`

        // 注入故障 E1
        writeFileSync(join(localDir, 'src/app.mjs'), '// E1_FAULT\nexport const computeVal = () => 0\n')
        const lfail = await runRp(['check-fault', '--phase', 'fail', '--local', '--cmd', 'node test.mjs', '--json'], localDir)
        if (lfail.status !== 0) return `--local check-fault fail 失败：${lfail.stdout} ${lfail.stderr}`

        // 未恢复到 E0 时 --phase restore 阻断
        const lbadRest = await runRp(['check-fault', '--phase', 'restore', '--local', '--cmd', 'node test.mjs', '--json'], localDir)
        if (lbadRest.status !== 3 || !`${lbadRest.stdout}\n${lbadRest.stderr}`.includes('BLOCKED_DIRTY_FAULT_RESIDUE')) {
          return `--local 未还原时 --phase restore 未阻断：exit=${lbadRest.status}`
        }

        // 恢复回 E0（而非整库 git checkout）
        writeFileSync(join(localDir, 'src/app.mjs'), '// E0_ORIGINAL_UNCOMMITTED\nexport const computeVal = () => 2\n')
        const lrest = await runRp(['check-fault', '--phase', 'restore', '--local', '--cmd', 'node test.mjs', '--json'], localDir)
        if (lrest.status !== 0) return `--local check-fault restore 失败：${lrest.stdout} ${lrest.stderr}`
        const lunlock = await runRp(['--local', '--include-diff', '--json'], localDir)
        if (lunlock.status !== 0 || !JSON.parse(lunlock.stdout).diffText?.includes('E0_ORIGINAL_UNCOMMITTED')) {
          return `--local 解锁 --include-diff 失败或丢失 E0：${lunlock.stdout} ${lunlock.stderr}`
        }
      } finally { rmTree(localDir) }

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['多轮失效、Slot 保护、纯文档免死锁与外部 PR 未扫阻断', async () => {
    // 1. 多轮失效 + sync range-diff 失效 + Slot 保护
    const dir = makeTestRepo({
      extraFiles: {
        'src/other.mjs': 'export const other = 1\n',
      },
    })
    try {
      const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
      const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { handleSync } = await import('../../kit/skills/dev-flow/scripts/flow-sync.mjs')
      const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
      const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
      const { issueTokenFor } = await import('./fixtures-helpers.mjs')
      const roots = await resolveRepoRoots(dir)

      await handleStart({ task: 'r-t', case: '2', slug: 'r-t', implementer: 'alice' }, roots)
      const implWt = join(dir, '.worktrees', 'impl-r-t')
      const revWt = join(dir, '.worktrees', 'review-r-t')
      writeFileSync(join(implWt, 'src/app.mjs'), 'export const computeVal = () => 2\n')
      gitCommitFast(implWt, 'feat: r1', { updateOnly: true })
      await handleVerify({ task: 'r-t', mode: 'full' }, roots)
      await handleSubmit({ task: 'r-t', agent: 'alice' }, roots)

      // Complete R1 empirical + fault
      if ((await runRp(['--task', 'r-t', '--json'], dir)).status !== 0) return 'r-t R1 pack 失败'
      if ((await runRp(['check-empirical', '--task', 'r-t', '--json'], dir)).status !== 0) return 'r-t R1 empirical 失败'
      writeFileSync(join(revWt, 'src/app.mjs'), 'export const computeVal = () => 99\n')
      // Slot 保护：check-empirical / check-fault 不应调用 syncTier2ReviewSlotIfNeeded（即使传入 --reset-review-slot 也不洗掉故障）
      const faultWithReset = await runRp(['check-fault', '--phase', 'fail', '--task', 'r-t', '--reset-review-slot', '--cmd', 'node test.mjs', '--json'], dir)
      if (faultWithReset.status !== 0 || !readFileSync(join(revWt, 'src/app.mjs'), 'utf8').includes('99')) {
        return `check-fault 触发了 slot 重置洗掉了故障：status=${faultWithReset.status}`
      }
      gitSync(revWt, ['checkout', '--', 'src/app.mjs'])
      if ((await runRp(['check-fault', '--phase', 'restore', '--task', 'r-t', '--cmd', 'node test.mjs', '--json'], dir)).status !== 0) return 'r-t R1 restore 失败'
      if ((await runRp(['--task', 'r-t', '--include-diff', '--json'], dir)).status !== 0) return 'r-t R1 --include-diff 失败'

      // Round 2 new commit -> 旧实证凭证立即失效并重新阻断 --include-diff
      await handleRecord({ task: 'r-t', round: '1', verdict: 'changes', evidence: 'R1 tested', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'r-t', 1), 'must-fix': ['C1: src/app.mjs:1 tweak'] }, roots)
      writeFileSync(join(implWt, 'src/app.mjs'), '// R2 commit\nexport const computeVal = () => 2\n')
      gitCommitFast(implWt, 'fix: r2', { updateOnly: true })
      await handleVerify({ task: 'r-t', mode: 'full' }, roots)
      await handleSubmit({ task: 'r-t', agent: 'alice', rework: true }, roots)

      const r2Blocked = await runRp(['--task', 'r-t', '--round', '2', '--include-diff', '--json'], dir)
      if (r2Blocked.status !== 3 || !`${r2Blocked.stdout}\n${r2Blocked.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
        return `Round 2 新提交后旧凭证未失效：exit=${r2Blocked.status} out=${r2Blocked.stdout}`
      }

      // Complete R2, then main advances & flow sync rebases -> range-diff 变基后旧凭证也必须失效
      await runRp(['--task', 'r-t', '--round', '2', '--json'], dir)
      await runRp(['check-empirical', '--task', 'r-t', '--round', '2', '--json'], dir)
      writeFileSync(join(revWt, 'src/app.mjs'), 'export const computeVal = () => 88\n')
      await runRp(['check-fault', '--phase', 'fail', '--task', 'r-t', '--round', '2', '--cmd', 'node test.mjs', '--json'], dir)
      gitSync(revWt, ['checkout', '--', 'src/app.mjs'])
      await runRp(['check-fault', '--phase', 'restore', '--task', 'r-t', '--round', '2', '--cmd', 'node test.mjs', '--json'], dir)
      if ((await runRp(['--task', 'r-t', '--round', '2', '--include-diff', '--json'], dir)).status !== 0) return 'R2 解锁失败'

      writeFileSync(join(dir, 'src/other.mjs'), 'export const other = 2\n')
      gitCommitFast(dir, 'chore: main advance', { files: ['src/other.mjs'] })
      const syncRes = await handleSync({ task: 'r-t' }, roots)
      if (syncRes.exitCode !== 0) return `flow sync 失败：${JSON.stringify(syncRes)}`
      const afterSyncBlocked = await runRp(['--task', 'r-t', '--round', '2', '--include-diff', '--json'], dir)
      if (afterSyncBlocked.status !== 3 || !`${afterSyncBlocked.stdout}\n${afterSyncBlocked.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
        return `flow sync 变基后旧实证凭证未失效：exit=${afterSyncBlocked.status} out=${afterSyncBlocked.stdout}`
      }

      // --local 继续改文件后旧凭证失效
      const locRe = makeTestRepo()
      try {
        writeFileSync(join(locRe, 'src/app.mjs'), 'export const computeVal = () => 2\n')
        await runRp(['--local', '--json'], locRe)
        await runRp(['check-empirical', '--local', '--cmd', 'node test.mjs', '--json'], locRe)
        writeFileSync(join(locRe, 'src/app.mjs'), 'export const computeVal = () => 5\n')
        await runRp(['check-fault', '--phase', 'fail', '--local', '--cmd', 'node test.mjs', '--json'], locRe)
        writeFileSync(join(locRe, 'src/app.mjs'), 'export const computeVal = () => 2\n')
        await runRp(['check-fault', '--phase', 'restore', '--local', '--cmd', 'node test.mjs', '--json'], locRe)
        if ((await runRp(['--local', '--include-diff', '--json'], locRe)).status !== 0) return '--local 解锁失败'

        // 继续改文件 -> 立刻重新阻断
        writeFileSync(join(locRe, 'src/app.mjs'), '// edited again\nexport const computeVal = () => 2\n')
        const locBlockedAgain = await runRp(['--local', '--include-diff', '--json'], locRe)
        if (locBlockedAgain.status !== 3 || !`${locBlockedAgain.stdout}\n${locBlockedAgain.stderr}`.includes('BLOCKED_EMPIRICAL_FIRST')) {
          return `--local 继续改文件后旧实证凭证未失效：exit=${locBlockedAgain.status} out=${locBlockedAgain.stdout}`
        }
      } finally { rmTree(locRe) }

      // 2. 空 diff 与 low 级纯文档改动不被故障注入死锁
      const docOnly = tmpProject({
        '.gitignore': '.worktrees/\n',
        'AGENTS.md': '# doc-only\n\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
        'docs/guide.md': '# Guide\n\nInitial.\n',
      })
      gitInit(docOnly, { branch: 'main', name: 'dev', email: 'dev@emp.test' })
      try {
        // 空 diff 放行不死锁
        const emptyDiffRes = await runRp(['--local', '--include-diff', '--json'], docOnly)
        if (emptyDiffRes.status !== 0) return `空 diff 不应死锁：exit=${emptyDiffRes.status} out=${emptyDiffRes.stdout}`

        // low 级纯文档改动：先阻断 -> check-empirical（免 fault）-> 解锁
        writeFileSync(join(docOnly, 'docs/guide.md'), '# Guide\n\nUpdated docs.\n')
        const docPre = await runRp(['--local', '--include-diff', '--json'], docOnly)
        if (docPre.status !== 3) return `纯文档未跑 check-empirical 前也应先阻断：exit=${docPre.status}`
        const docPack = await runRp(['--local', '--json'], docOnly)
        if (docPack.status !== 0 || JSON.parse(docPack.stdout).empiricalGate?.faultRequired !== false) {
          return `low 级纯文档 faultRequired 应为 false：${docPack.stdout}`
        }
        const docEmp = await runRp(['check-empirical', '--local', '--json'], docOnly)
        if (docEmp.status !== 0) return `纯文档 check-empirical 失败：${docEmp.stdout} ${docEmp.stderr}`
        const docUnlock = await runRp(['--local', '--include-diff', '--json'], docOnly)
        if (docUnlock.status !== 0 || JSON.parse(docUnlock.stdout).diff?.diffIncluded !== true) {
          return `low 级纯文档被故障注入死锁：exit=${docUnlock.status} out=${docUnlock.stdout}`
        }
      } finally { rmTree(docOnly) }

      // 3. 外部 PR 未过 --untrusted-scan 或未批准高危项时，check-empirical / check-fault 返回 exit 3 BLOCKED_UNTRUSTED_HAZARD
      const extDir = makeTestRepo({
        extraFiles: { 'src/app.mjs': 'export const computeVal = () => 2\n' },
      })
      gitSync(extDir, ['remote', 'add', 'origin', 'https://github.com/acme/emp-ext.git'])
      const mainExtSha = gitSync(extDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const fakeGhExt = createFakeGhEnv({})
      try {
        // 3a. 干净外部 PR 但未先跑 --untrusted-scan
        gitSync(extDir, ['checkout', '-qb', 'ext-clean'])
        writeFileSync(join(extDir, 'src/app.mjs'), '// clean ext\nexport const computeVal = () => 2\n')
        gitCommitFast(extDir, 'clean ext', { updateOnly: true })
        const cleanSha = gitSync(extDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
        gitSync(extDir, ['checkout', '-q', 'main'])
        await handleStart({ task: 'review-pr-71', 'external-pr': '71', 'pr-ref': cleanSha }, await resolveRepoRoots(extDir))

        // 3b. 含高危 workflow 的外部 PR 未经人类批准 -> check-empirical / check-fault 返回 exit 3 BLOCKED_UNTRUSTED_HAZARD
        gitSync(extDir, ['checkout', '-qb', 'ext-evil'])
        mkdirSync(join(extDir, '.github', 'workflows'), { recursive: true })
        writeFileSync(join(extDir, '.github', 'workflows', 'evil.yml'), 'name: evil\non: pull_request_target\njobs: {}\n')
        gitCommitFast(extDir, 'evil wf')
        const evilSha = gitSync(extDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
        gitSync(extDir, ['checkout', '-q', 'main'])
        await handleStart({ task: 'review-pr-72', 'external-pr': '72', 'pr-ref': evilSha }, await resolveRepoRoots(extDir))

        fakeGhExt.update({
          login: 'fake-dev',
          prs: {
            71: {
              number: 71, title: 'PR 71', state: 'OPEN', body: 'clean', url: 'https://github.com/acme/emp-ext/pull/71',
              baseRefName: 'main', headRefName: 'ext-clean', baseRefOid: mainExtSha, headRefOid: cleanSha, author: { login: 'ext' },
            },
            72: {
              number: 72, title: 'PR 72', state: 'OPEN', body: 'evil', url: 'https://github.com/acme/emp-ext/pull/72',
              baseRefName: 'main', headRefName: 'ext-evil', baseRefOid: mainExtSha, headRefOid: evilSha, author: { login: 'ext' },
            },
          },
        })

        const markerA = join(extDir, '.marker-unscanned')
        const cmdA = `node -e "require('fs').writeFileSync(${JSON.stringify(markerA)},'1')"`
        const unscannedEmp = await runRp(['check-empirical', '--pr', '71', '--cmd', cmdA, '--json'], extDir, fakeGhExt.env)
        if (unscannedEmp.status !== 3 || !`${unscannedEmp.stdout}\n${unscannedEmp.stderr}`.includes('BLOCKED_UNTRUSTED_HAZARD') || existsSync(markerA)) {
          return `未过 --untrusted-scan 的外部 PR 竟允许执行 check-empirical：exit=${unscannedEmp.status} marker=${existsSync(markerA)} out=${unscannedEmp.stdout}`
        }
        const unscannedFault = await runRp(['check-fault', '--phase', 'fail', '--pr', '71', '--cmd', cmdA, '--json'], extDir, fakeGhExt.env)
        if (unscannedFault.status !== 3 || !`${unscannedFault.stdout}\n${unscannedFault.stderr}`.includes('BLOCKED_UNTRUSTED_HAZARD') || existsSync(markerA)) {
          return `未过 --untrusted-scan 的外部 PR 竟允许执行 check-fault：exit=${unscannedFault.status} out=${unscannedFault.stdout}`
        }

        const hazEmp = await runRp(['check-empirical', '--pr', '72', '--cmd', cmdA, '--json'], extDir, fakeGhExt.env)
        if (hazEmp.status !== 3 || !`${hazEmp.stdout}\n${hazEmp.stderr}`.includes('BLOCKED_UNTRUSTED_HAZARD') || existsSync(markerA)) {
          return `未批准高危外部 PR 竟执行了 check-empirical：exit=${hazEmp.status} out=${hazEmp.stdout}`
        }
        // 人类明确批准后放行
        const aprEmp = await runRp(['check-empirical', '--pr', '72', '--human-approved-exec', '--cmd', 'node test.mjs', '--json'], extDir, fakeGhExt.env)
        if (aprEmp.status !== 0) {
          return `人类批准高危外部 PR 后 check-empirical 失败：exit=${aprEmp.status} out=${aprEmp.stdout} err=${aprEmp.stderr}`
        }
      } finally { fakeGhExt.cleanup(); rmTree(extDir) }

      return true
    } finally { rmTree(dir) }
  }])
}
