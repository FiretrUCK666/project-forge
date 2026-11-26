/**
 * fixtures-e2e-gate.mjs —— 通用 E2E 硬门禁、合前三方 SHA 校验、三态计分与脱敏建单双向夹具。
 */

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getLocalIssue } from '../../kit/skills/lib/local-issues.mjs'
import { readSignalsJsonl, readTaskLedger, resolveRepoRoots } from '../../kit/skills/lib/shared.mjs'
import {
  readVerificationEvidence,
  scoreExecutionResult,
  validatePreMergeShaAndWorktree,
  validateVerificationEvidence,
  writeVerificationEvidence,
} from '../../kit/skills/lib/workflow-policy.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleVerify, handleSubmit } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { runCli as runReviewPackCli } from '../../kit/skills/dev-review/scripts/review-pack.mjs'
import {
  gitCommitFast, gitInit, gitSync, issueTokenFor, rmTree, runAbsAsync, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (chunk) => { out += String(chunk); return true }
  process.stderr.write = (chunk) => { err += String(chunk); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerStageBLoopB5Cases(cases) {
  cases.push(['C15：通用运行+观察 E2E 硬门禁、Q3 未配置阻断、!smokeRequired 修复与失败脱敏信号建单', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': [
        '# c15-demo',
        '',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: node test/smoke.mjs',
        'merge-gate: exit 0',
        'high-risk: none',
        '```',
        '',
      ].join('\n'),
      'src/app.mjs': 'export const run = () => "ok-v1"\n',
      'test/smoke.mjs': [
        "import { run } from '../src/app.mjs'",
        "if (run() !== 'ok-v2') process.exit(2)",
        "console.log('SMOKE_BANNER_OK')",
        '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    const noSmokeDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# q3-missing\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/app.mjs': 'export const q = 1\n',
    })
    gitInit(noSmokeDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    const noneDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# none-ok\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const n = 1\n',
    })
    gitInit(noneDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      // Q3 负向：既无 smoke-verify 也未写 none 时禁止以 full 放行
      const q3Roots = await resolveRepoRoots(noSmokeDir)
      await withQuietIo(() => handleStart({ task: 'q3-t', case: '2', slug: 'q3-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦 smoke-verify 未配置阻断', json: true }, q3Roots))
      await seedExploredFor(noSmokeDir, 'q3-t')
      const q3Wt = join(noSmokeDir, '.worktrees', 'impl-q3-t')
      writeFileSync(join(q3Wt, 'src/app.mjs'), 'export const q = 2\n')
      gitCommitFast(q3Wt, 'feat: q3', { updateOnly: true })
      const q3Block = await withQuietIo(() => handleVerify({ task: 'q3-t', mode: 'full', json: true }, q3Roots))
      if (q3Block.res.exitCode !== 3 || !`${q3Block.err}${q3Block.out}`.includes('BLOCKED_SMOKE_VERIFY_UNCONFIGURED')) {
        return `Q3 未配置 smoke-verify 时未阻断 full：exit=${q3Block.res.exitCode}, err=${q3Block.err}`
      }

      // 正向豁免：显式 smoke-verify: none 免除 E2E 门禁
      const noneRoots = await resolveRepoRoots(noneDir)
      await withQuietIo(() => handleStart({ task: 'none-t', case: '2', slug: 'none-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦 smoke-verify none 豁免', json: true }, noneRoots))
      await seedExploredFor(noneDir, 'none-t')
      const noneWt = join(noneDir, '.worktrees', 'impl-none-t')
      writeFileSync(join(noneWt, 'src/app.mjs'), 'export const n = 2\n')
      gitCommitFast(noneWt, 'feat: none', { updateOnly: true })
      const noneVer = await withQuietIo(() => handleVerify({ task: 'none-t', mode: 'full', json: true }, noneRoots))
      const noneSub = await withQuietIo(() => handleSubmit({ task: 'none-t', agent: 'alice', json: true }, noneRoots))
      if (noneVer.res.exitCode !== 0 || noneSub.res.exitCode !== 0) {
        return `显式 smoke-verify: none 被误拦：ver=${noneVer.res.exitCode}, sub=${noneSub.res.exitCode}`
      }

      // 主场景：full 不可顶替 smoke；仅跑 smoke 不给 --e2e-evidence 亦阻断；review 未观察禁止 --include-diff 与 pass
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'c15-t', case: '2', slug: 'c15-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦 E2E 观察硬门禁', json: true }, roots))
      await seedExploredFor(dir, 'c15-t')
      const wt = join(dir, '.worktrees', 'impl-c15-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const run = () => "ok-v2"\n')
      gitCommitFast(wt, 'feat: c15 ok-v2', { updateOnly: true })

      const fullOnly = await withQuietIo(() => handleVerify({ task: 'c15-t', mode: 'full', json: true }, roots))
      if (fullOnly.res.exitCode !== 0) return `c15 full verify 本身失败：${fullOnly.err}`
      const subTierBlock = await withQuietIo(() => handleSubmit({ task: 'c15-t', agent: 'alice', json: true }, roots))
      if (subTierBlock.res.exitCode !== 3 || !`${subTierBlock.out}${subTierBlock.err}`.includes('BLOCKED_INSUFFICIENT_VERIFICATION_TIER')) {
        return `full 竟绕过了 smoke-verify：exit=${subTierBlock.res.exitCode}, out=${subTierBlock.out}`
      }

      const smokeNoObs = await withQuietIo(() => handleVerify({ task: 'c15-t', mode: 'smoke', json: true }, roots))
      if (smokeNoObs.res.exitCode !== 0) return `smoke verify 执行失败：${smokeNoObs.err}`
      const subObsBlock = await withQuietIo(() => handleSubmit({ task: 'c15-t', agent: 'alice', json: true }, roots))
      if (subObsBlock.res.exitCode !== 3 || !`${subObsBlock.out}${subObsBlock.err}`.includes('BLOCKED_E2E_OBSERVATION_REQUIRED')) {
        return `缺 --e2e-evidence 时 submit 未拦截：exit=${subObsBlock.res.exitCode}, out=${subObsBlock.out}`
      }

      // 正向传 --e2e-evidence 后先检查审查侧：先测故意不写观察的 --include-diff / pass 拦截
      await withQuietIo(() => runReviewPackCli(['--task', 'c15-t', '--dir', dir, '--json']))
      const empUnitOnly = await withQuietIo(() => runReviewPackCli([
        'check-empirical', '--task', 'c15-t', '--dir', dir, '--cmd', 'exit 0', '--json',
      ]))
      if (empUnitOnly.res !== 0) return `review check-empirical 失败：${empUnitOnly.err}`
      const revSlot = join(dir, readTaskLedger(dir, 'c15-t').reviewWorktreePath ?? '.worktrees/review-c15-t')
      // 若此时还没 sync review slot，先给 submit 解锁以便创建/同步 review slot 后测 --include-diff
      const smokeWithObs = await withQuietIo(() => handleVerify({
        task: 'c15-t', mode: 'smoke', 'e2e-evidence': 'observed SMOKE_BANNER_OK exit=0', json: true,
      }, roots))
      if (smokeWithObs.res.exitCode !== 0) return `smoke --e2e-evidence 失败：${smokeWithObs.err}`
      const subOk = await withQuietIo(() => handleSubmit({ task: 'c15-t', agent: 'alice', json: true }, roots))
      if (subOk.res.exitCode !== 0) return `带 --e2e-evidence 后 submit 失败：${subOk.err}`

      // 构造无观察记录的独立评审上下文，验证缺 E2E 观察拦截 --include-diff 与 pass
      const empDir = tmpProject({
        '.gitignore': '.worktrees/\n',
        'AGENTS.md': '# emp-e2e\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: node test/smoke.mjs\nmerge-gate: exit 0\n```\n',
        'src/app.mjs': 'export const run = () => "v1"\n',
        'test/smoke.mjs': "import { run } from '../src/app.mjs'\nif (run() !== 'v2') process.exit(2)\n",
      })
      gitInit(empDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      try {
        const eRoots = await resolveRepoRoots(empDir)
        await withQuietIo(() => handleStart({ task: 'e-t', case: '2', slug: 'e-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦审查侧 E2E 观察阻断', json: true }, eRoots))
        await seedExploredFor(empDir, 'e-t')
        const eWt = join(empDir, '.worktrees', 'impl-e-t')
        writeFileSync(join(eWt, 'src/app.mjs'), 'export const run = () => "v2"\n')
        gitCommitFast(eWt, 'feat: e-t', { updateOnly: true })
        await withQuietIo(() => handleVerify({ task: 'e-t', mode: 'smoke', json: true }, eRoots))
        // 在未给 --e2e-evidence 时先做 check-empirical + check-fault，此时 --include-diff 与 pass 均须拦截
        await withQuietIo(() => runReviewPackCli(['--task', 'e-t', '--dir', empDir, '--json']))
        await withQuietIo(() => runReviewPackCli(['check-empirical', '--task', 'e-t', '--dir', empDir, '--json']))
        const eRev = join(empDir, '.worktrees', 'review-e-t')
        const origApp = readFileSync(join(eRev, 'src/app.mjs'), 'utf8')
        writeFileSync(join(eRev, 'src/app.mjs'), 'export const run = () => "bad"\n')
        await withQuietIo(() => runReviewPackCli(['check-fault', '--phase', 'fail', '--task', 'e-t', '--dir', empDir, '--cmd', 'node test/smoke.mjs', '--json']))
        writeFileSync(join(eRev, 'src/app.mjs'), origApp)
        await withQuietIo(() => runReviewPackCli(['check-fault', '--phase', 'restore', '--task', 'e-t', '--dir', empDir, '--cmd', 'node test/smoke.mjs', '--json']))

        const diffBlocked = await withQuietIo(() => runReviewPackCli(['--task', 'e-t', '--dir', empDir, '--include-diff', '--json']))
        if (diffBlocked.res !== 3 || !diffBlocked.out.includes('e2e-observation')) {
          return `缺 E2E 观察时 --include-diff 竟放行：exit=${diffBlocked.res}, out=${diffBlocked.out}`
        }
        const tokE = await issueTokenFor(empDir, 'e-t', 1)
        const passBlocked = await withQuietIo(async () => handleRecord({
          task: 'e-t', round: '1', verdict: 'pass', 'reviewer-id': 'rev-e', 'review-token': tokE, evidence: 'ok', json: true,
        }, await resolveRepoRoots(eRev)))
        if (passBlocked.res !== EXIT.FACT || !passBlocked.out.includes('BLOCKED_PASS_WITH_OPEN_BLOCKERS')) {
          return `缺 E2E 观察时 pass 竟未被 BLOCKED_PASS_WITH_OPEN_BLOCKERS 拦截：exit=${passBlocked.res}, out=${passBlocked.out}`
        }
      } finally {
        rmTree(empDir)
      }

      // 校验 assessBehavioralGate !smokeRequired 修复：已完成 smoke + e2eObservation 后应返回 verified-on-head
      const packAfter = await withQuietIo(() => runReviewPackCli(['--task', 'c15-t', '--dir', dir, '--json']))
      if (packAfter.res !== 0) return `review-pack c15-t 失败：${packAfter.err}`
      const pj = JSON.parse(packAfter.out)
      if (pj.behavioralGate?.status !== 'verified-on-head' || !pj.behavioralGate?.smokeVerifiedOnHead || !pj.behavioralGate?.e2eObservedOnHead) {
        return `assessBehavioralGate !smokeRequired 缺陷未修复：${JSON.stringify(pj.behavioralGate)}`
      }
      if (!existsSync(revSlot)) return `submit 未创建 reviewWorktree：${revSlot}`
      const tokC15 = await issueTokenFor(dir, 'c15-t', 1)
      const passOk = await withQuietIo(async () => handleRecord({
        task: 'c15-t', round: '1', verdict: 'pass', 'reviewer-id': 'rev-c15', 'review-token': tokC15, evidence: 'E2E observed OK', json: true,
      }, await resolveRepoRoots(revSlot)))
      if (passOk.res !== 0) return `有完整 E2E 观察后 pass 失败：${passOk.out} ${passOk.err}`
      const mergeOk = await withQuietIo(() => handleMerge({ task: 'c15-t', json: true }, roots))
      if (mergeOk.res.exitCode !== 0) return `c15-t merge 失败：${mergeOk.err}`

      // E2E 失败自动写入 signals.jsonl(e2e.runtime-fail)、脱敏 Evidence/Unknowns/NextSteps 与 escalation 建单
      await withQuietIo(() => handleStart({ task: 'c15-fail', case: '2', slug: 'c15-fail', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦 E2E 失败脱敏建单', json: true }, roots))
      const failWt = join(dir, '.worktrees', 'impl-c15-fail')
      writeFileSync(join(failWt, 'test/smoke.mjs'), "console.error('leak token=ghp_1234567890abcdef1234567890abcdef12 path=/Users/secretdev/proj'); process.exit(4)\n")
      gitCommitFast(failWt, 'test: failing smoke with secret path', { updateOnly: true })
      const failVer = await withQuietIo(() => handleVerify({ task: 'c15-fail', mode: 'smoke', json: true }, roots))
      if (failVer.res.exitCode === 0) return '失败 smoke 命令意外返回 0'
      const fj = JSON.parse(failVer.out)
      const diagStr = JSON.stringify(fj.diagnostic ?? {})
      if (!fj.diagnostic?.Evidence?.length || !fj.diagnostic?.Unknowns?.length || !fj.diagnostic?.NextSteps?.length) {
        return `E2E 失败缺少结构化诊断包：${failVer.out}`
      }
      if (diagStr.includes('ghp_123456') || diagStr.includes('secretdev')) {
        return `E2E 失败诊断包未脱敏敏感令牌或本机路径：${diagStr}`
      }
      if (!fj.escalatedIssue?.ok || !fj.escalatedIssue?.number) {
        return `E2E 失败未自动桥接 escalation.mjs 建单：${failVer.out}`
      }
      const iss = getLocalIssue({ mainRoot: dir, number: fj.escalatedIssue.number })
      if (!iss?.ok || !iss.labels?.includes('e2e-fail')) {
        return `escalation 工单缺少 e2e-fail 标签：${JSON.stringify(iss)}`
      }
      const sigs = readSignalsJsonl(roots)
      if (!sigs.events.some((e) => e.pattern === 'e2e.runtime-fail')) {
        return `signals.jsonl 未写入 e2e.runtime-fail：${JSON.stringify(sigs.events)}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(noSmokeDir)
      rmTree(noneDir)
    }
  }])

  cases.push(['A6：合前三方 headSha/干净工作区校核、三态计分与确定性零 LLM CLI 故障注入 Stub', async () => {
    // 1. 三态计分：executed / succeeded / errorOnly
    if (scoreExecutionResult({ executed: false, exitCode: EXIT.OK, errorOnly: false }).ok !== false) {
      return 'scoreExecutionResult 未拦截 executed=false 的伪绿'
    }
    if (scoreExecutionResult({ executed: true, exitCode: EXIT.OK, errorOnly: true }).ok !== false) {
      return 'scoreExecutionResult 未拦截 errorOnly=true 的伪绿'
    }
    if (scoreExecutionResult({ executed: true, exitCode: EXIT.OK, errorOnly: false }).ok !== true) {
      return 'scoreExecutionResult 正向通过失败'
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# a6-demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: node test/smoke.mjs\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const a = 1\n',
      'test/smoke.mjs': "console.log('a6 ok')\n",
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'a6-t', case: '2', slug: 'a6-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦三方 headSha 校验', json: true }, roots))
      await seedExploredFor(dir, 'a6-t')
      const wt = join(dir, '.worktrees', 'impl-a6-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const a = 2\n')
      gitCommitFast(wt, 'feat: a6', { updateOnly: true })
      const a6Smoke = await withQuietIo(() => handleVerify({ task: 'a6-t', mode: 'smoke', 'e2e-evidence': 'a6 smoke ok', json: true }, roots))
      const a6Full = await withQuietIo(() => handleVerify({ task: 'a6-t', mode: 'full', json: true }, roots))
      const a6Sub = await withQuietIo(() => handleSubmit({ task: 'a6-t', agent: 'alice', json: true }, roots))
      if (a6Smoke.res.exitCode !== 0 || a6Full.res.exitCode !== 0 || a6Sub.res.exitCode !== 0) {
        return `A6 verify/submit 失败：smoke=${a6Smoke.res.exitCode}, full=${a6Full.res.exitCode}, sub=${a6Sub.res.exitCode}`
      }
      const revWt = join(dir, '.worktrees', 'review-a6-t')
      const tok = await issueTokenFor(dir, 'a6-t', 1)
      await withQuietIo(async () => handleRecord({
        task: 'a6-t', round: '1', verdict: 'pass', 'reviewer-id': 'rev-a6', 'review-token': tok, evidence: 'a6 pass', json: true,
      }, await resolveRepoRoots(revWt)))

      const evOrig = readVerificationEvidence(roots.gitDir, 'a6-t')
      const fakeSha = '0'.repeat(40)

      // 2. evidence.gates.smoke.errorOnly=true 必须被 validateVerificationEvidence 拦截
      writeVerificationEvidence(roots.gitDir, 'a6-t', {
        ...evOrig,
        gates: { ...evOrig.gates, smoke: { ...evOrig.gates.smoke, errorOnly: true } },
      })
      const badScore = validateVerificationEvidence({
        policy: { riskTier: 'medium', requiredGates: ['full'], smokeRequired: true },
        evidence: readVerificationEvidence(roots.gitDir, 'a6-t'),
        headSha: evOrig.headSha,
      })
      if (badScore.ok) return 'evidence.gates.smoke.errorOnly=true 竟通过了 validateVerificationEvidence'

      // 3. evidence.headSha 篡改必须阻断 merge (即使 ledger.verifiedHead 仍匹配)
      const shaGateDirect = validatePreMergeShaAndWorktree({
        currentHead: evOrig.headSha,
        evidence: { ...evOrig, headSha: fakeSha },
        requiresReview: false,
      })
      if (shaGateDirect.ok || shaGateDirect.code !== 'BLOCKED_PRE_MERGE_SHA_MISMATCH') {
        return `validatePreMergeShaAndWorktree 未拦截 evidence.headSha 篡改：${JSON.stringify(shaGateDirect)}`
      }
      writeVerificationEvidence(roots.gitDir, 'a6-t', { ...evOrig, headSha: fakeSha })
      const mShaBad = await withQuietIo(() => handleMerge({ task: 'a6-t', json: true }, roots))
      if (mShaBad.res.exitCode !== 3) return `A6 未拦截 evidence.headSha 不匹配：exit=${mShaBad.res.exitCode}`

      // 还原 evidence.json 后测试脏工作区阻断
      writeVerificationEvidence(roots.gitDir, 'a6-t', evOrig)
      writeFileSync(join(wt, 'dirty-untracked.tmp'), 'dirty')
      const mDirty = await withQuietIo(() => handleMerge({ task: 'a6-t', json: true }, roots))
      if (mDirty.res.exitCode !== 3 || mDirty.res.code !== 'BLOCKED_DIRTY_WORKTREE') {
        return `A6 合并前未拦截脏工作区：${JSON.stringify(mDirty.res)}`
      }
      rmTree(join(wt, 'dirty-untracked.tmp'))

      // 4. 确定性零 LLM Node CLI 故障注入 Stub（覆盖非法参数、缺令牌与失败退避分支）
      const stubInvalidMode = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'a6-t', '--mode', 'bogus'], { cwd: dir })
      const stubBadFlag = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--nonexistent-flag'], { cwd: dir })
      const stubNoToken = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 'a6-t', '--verdict', 'pass', '--reviewer-id', 'rev-z', '--evidence', 'ok', '--json'], { cwd: dir })
      if (stubInvalidMode.status === 0 || stubBadFlag.status === 0 || stubNoToken.status !== EXIT.FACT) {
        return `零 LLM CLI Stub 未按预期阻断异常参数/令牌：${JSON.stringify({ stubInvalidMode: stubInvalidMode.status, stubBadFlag: stubBadFlag.status, stubNoToken: stubNoToken.status })}`
      }

      // 正向收尾合入
      const mOk = await withQuietIo(() => handleMerge({ task: 'a6-t', json: true }, roots))
      if (mOk.res.exitCode !== 0) return `A6 恢复合法态后 merge 失败：${mOk.err}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C7+C8：precheck 先于命令执行、quick --target 跳过门禁钩子、mcp-delegate/离线理由拦截、HUMAN_MERGE_AUTHORITY 退出 4 与 verify-tools 收敛', async () => {
    const { GenericRemoteBackend } = await import('../../kit/skills/lib/task-backend-local.mjs')
    const { updateTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
    const { VALID_TOOL_KINDS } = await import('../../kit/skills/lib/feature-map.mjs')
    void VALID_TOOL_KINDS

    // 1. C7 precheck 先于命令执行 + quick --target 跳过 edit-gate/govern + smoke 已过仅补 --e2e-evidence 不重跑
    const c7Dir = tmpProject({
      '.gitignore': '.worktrees/\nsmoke.count\n',
      'AGENTS.md': [
        '# c7-repo',
        '',
        '```yaml',
        'quick-test: node test.mjs {target}',
        'full-test: node test.mjs',
        'smoke-verify: node smoke.mjs',
        'merge-gate: node test.mjs',
        '```',
        '',
      ].join('\n'),
      'test.mjs': 'process.exit(0)\n',
      'smoke.mjs': 'import fs from "node:fs"; const n = (fs.existsSync("smoke.count") ? Number(fs.readFileSync("smoke.count","utf8")) : 0) + 1; fs.writeFileSync("smoke.count", String(n));\n',
      'src/App.tsx': 'export const App = () => "v1"\n',
      'shots/ui.png': 'png\n',
    })
    gitInit(c7Dir, { branch: 'main' })
    try {
      const roots = await resolveRepoRoots(c7Dir)
      await handleStart({ task: 'c7-t', case: '2', slug: 'c7-t', implementer: 'alice', 'no-issue': true, reason: 'C7 verify 顺序与 quick --target 夹具' }, roots)
      const wt = join(c7Dir, '.worktrees', 'impl-c7-t')
      writeFileSync(join(wt, 'src/App.tsx'), 'export const App = () => "v2"\n')
      gitCommitFast(wt, 'feat: c7 ui', { updateOnly: true })

      // 反面：传缺失附件 + 创建标记文件的命令，precheck 必须在命令执行前拦下，标记文件不得出现
      const markerPath = join(wt, 'ran-despite-precheck.flag')
      const preBlock = await withQuietIo(() => handleVerify({
        task: 'c7-t', mode: 'gate', cmd: 'node -e "require(\'fs\').writeFileSync(\'ran-despite-precheck.flag\', \'1\')"',
        artifact: [join(wt, 'no-such-art.png')], json: true,
      }, roots))
      if (preBlock.res.exitCode === 0) return '缺失附件未阻断 verify'
      if (existsSync(markerPath)) return 'precheck 未在命令执行前拦截：命令仍然被执行并生成了文件'

      // 正向：quick --target 即使改了 src/App.tsx（含 suppression 注释也不触发 --final edit-gate）且不走 precheck? Wait: quick --target passes if clean
      const quickRes = await withQuietIo(() => handleVerify({ task: 'c7-t', mode: 'quick', target: 'test.mjs', artifact: [join(wt, 'shots/ui.png')] }, roots))
      if (quickRes.res.exitCode !== 0) return `quick --target 合法路径失败：${quickRes.err}`

      // 正向：smoke 执行 1 次后，同 HEAD 传 --e2e-evidence 补录观察不再重跑 smoke.mjs
      const sm1 = await withQuietIo(() => handleVerify({ task: 'c7-t', mode: 'smoke', artifact: [join(wt, 'shots/ui.png')] }, roots))
      if (sm1.res.exitCode !== 0) return `第一次 smoke verify 失败：${sm1.err}`
      const countAfter1 = readFileSync(join(wt, 'smoke.count'), 'utf8').trim()
      const sm2 = await withQuietIo(() => handleVerify({
        task: 'c7-t', mode: 'smoke', artifact: [join(wt, 'shots/ui.png')],
        'e2e-evidence': '执行 node smoke.mjs 观察 smoke.count 成功写入 1 且进程退出码 0',
      }, roots))
      if (sm2.res.exitCode !== 0) return `仅补 --e2e-evidence smoke verify 失败：${sm2.err}`
      const countAfter2 = readFileSync(join(wt, 'smoke.count'), 'utf8').trim()
      if (countAfter1 !== '1' || countAfter2 !== '1') {
        return `同 HEAD 仅补 --e2e-evidence 重跑了 smoke 命令（count=${countAfter1}->${countAfter2}）`
      }
    } finally { rmTree(c7Dir) }

    // 2. C8：generic-git 离线 --human-approved 缺/空洞理由返回 USAGE，真实理由通过；BLOCKED_HUMAN_MERGE_AUTHORITY 退出 4；verify-tools --kind 非法退出 2
    const c8Dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c8\n\n```yaml\nquick-test: node -e "process.exit(0)"\nfull-test: node -e "process.exit(0)"\nsmoke-verify: none\nmerge-gate: node -e "process.exit(0)"\n```\n\n## 取舍\n\n```text\n- `merge-authority`: human\n```\n',
      'src/a.mjs': 'export const a = 1\n',
    })
    gitInit(c8Dir, { branch: 'main' })
    try {
      const roots = await resolveRepoRoots(c8Dir)
      const gb = new GenericRemoteBackend({ mainRoot: c8Dir, gitDir: roots.gitDir, pushRemote: 'missing-remote', baseBranch: 'main' })
      const badOffline = await gb.mergePr({ humanApproved: true, reason: 'ok', branch: 'feat/x', baseBranch: 'main' })
      if (badOffline.ok || badOffline.exitCode !== EXIT.USAGE || !badOffline.blocked) {
        return `generic-git 离线空洞理由未按 USAGE 拦截：${JSON.stringify(badOffline)}`
      }
      const okOffline = await gb.mergePr({
        humanApproved: true, reason: '远端临时维护中，已由管理员在 Git 网页端确认分支合入 main 且提交记录一致',
        branch: 'feat/x', baseBranch: 'main',
      })
      if (!okOffline.ok || !okOffline.merged) return `generic-git 离线合法理由未放行：${JSON.stringify(okOffline)}`

      await handleStart({ task: 'c8-h', case: '2', slug: 'c8-h', implementer: 'alice', 'no-issue': true, reason: '测试 merge-authority human 退出码 4' }, roots)
      await seedExploredFor(c8Dir, 'c8-h')
      const wt8 = join(c8Dir, '.worktrees', 'impl-c8-h')
      writeFileSync(join(wt8, 'src/a.mjs'), 'export const a = 2\n')
      gitCommitFast(wt8, 'feat: c8', { updateOnly: true })
      const v8 = await withQuietIo(() => handleVerify({ task: 'c8-h', mode: 'gate' }, roots))
      if (v8.res.exitCode !== 0) return `c8-h verify 失败：${v8.err}`
      const s8 = await withQuietIo(() => handleSubmit({ task: 'c8-h', agent: 'alice' }, roots))
      if (s8.res.exitCode !== 0) return `c8-h submit 失败：${s8.err}`
      const tok8 = await issueTokenFor(c8Dir, 'c8-h', 1)
      const revRoots8 = await resolveRepoRoots(join(c8Dir, '.worktrees', 'review-c8-h'))
      const r8 = await withQuietIo(() => handleRecord({
        task: 'c8-h', round: '1', verdict: 'pass', 'reviewer-id': 'rev-8', 'review-token': tok8,
        evidence: '运行 node -e "process.exit(0)" 实测 src/a.mjs 导出 2 退出 0', json: true,
      }, revRoots8))
      if (r8.res !== 0) return `c8-h record 失败：${r8.err} ${r8.out}`
      const mHuman = await withQuietIo(() => handleMerge({ task: 'c8-h', json: true }, roots))
      if (mHuman.res.exitCode !== EXIT.HUMAN || mHuman.res.code !== 'BLOCKED_HUMAN_MERGE_AUTHORITY') {
        return `BLOCKED_HUMAN_MERGE_AUTHORITY 未返回 EXIT.HUMAN (4)：${JSON.stringify(mHuman.res)}`
      }

      // 缺少远端 PR 且无分支的 maintainer 场景不得静默落盘 merged（防止 null mergeRes 穿透）
      gitSync(c8Dir, ['remote', 'add', 'origin', 'https://github.com/acme/c8-demo.git'])
      await updateTaskLedger(c8Dir, 'c8-h', (cur) => ({ ...cur, role: 'maintainer', providerId: 'github', prNumber: null, branch: null }))
      const mNoPr = await withQuietIo(() => handleMerge({
        task: 'c8-h', 'human-approved': true,
        _ghProbe: { client: { getCommitChecks: async () => ({ ok: true }) }, env: { trackB: { ok: true, tier: 'track-b', login: 'alice' } } },
        json: true,
      }, roots))
      const ldgAfterNoPr = readTaskLedger(c8Dir, 'c8-h')
      if (mNoPr.res.exitCode === 0 || ldgAfterNoPr.status === 'merged') {
        return `空 mergeRes 静默穿透将账本标成了 merged：${JSON.stringify({ res: mNoPr.res, status: ldgAfterNoPr.status })}`
      }

      const badKind = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', [
        'create', c8Dir, '--feature', 'f1', '--kind', 'bogus-kind', '--command', 'node -e "process.exit(0)"',
      ], { cwd: c8Dir })
      if (badKind.status !== EXIT.USAGE) {
        return `verify-tools --kind 非法未退出 USAGE(2)：exit=${badKind.status} out=${badKind.stdout} err=${badKind.stderr}`
      }
      return true
    } finally { rmTree(c8Dir) }
  }])
}
