/**
 * fixtures-flow-explore-gate.mjs —— flow start 引导 claim/explore 与 flow submit 探索门禁正反双向夹具。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { hasExploredEvidence } from '../../kit/skills/lib/ledger.mjs'
import { readTaskLedger, resolveRepoRoots } from '../../kit/skills/lib/shared.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, tmpProject } from './fixtures-helpers.mjs'

async function withCaptureIo(fn) {
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

function makeBaseRepo({ withRemote = false } = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
    'AGENTS.md': [
      '# explore-gate-demo',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const value = 1\n',
    'docs/notes.md': '# Notes\n\ninitial note.\n',
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
  if (withRemote) {
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
  }
  return dir
}

export function registerFlowExploreGateCases(cases) {
  cases.push(['flow start [NEXT STEP] 在 Tier 2（含远端/本地）与 Tier 1 均明确引导 claim 且自动记录 explored', async () => {
    const remoteDir = makeBaseRepo({ withRemote: true })
    const localDir = makeBaseRepo({ withRemote: false })
    const emptyCommitDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\n---\n',
      'AGENTS.md': '# unborn\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\n```\n',
    })
    gitSync(emptyCommitDir, ['init', '-q', '-b', 'main'])
    gitSync(emptyCommitDir, ['config', 'user.name', 'alice'])
    gitSync(emptyCommitDir, ['config', 'user.email', 'alice@example.com'])

    try {
      // 1) Tier 2 + remote + --issue
      const remoteRoots = await resolveRepoRoots(remoteDir)
      const stRemote = await withCaptureIo(() => handleStart({
        task: 't-rem', slug: 'rem-fix', case: '2', issue: '100', implementer: 'alice',
      }, remoteRoots))
      if (stRemote.res.exitCode !== 0) return `Tier 2 远端 start 失败：exit=${stRemote.res.exitCode}, err=${stRemote.err}`
      if (!stRemote.out.includes('[NEXT STEP]') || !stRemote.out.includes('claim --task t-rem')) {
        return `Tier 2 远端 start [NEXT STEP] 未引导 claim：${stRemote.out}`
      }
      if (hasExploredEvidence(readTaskLedger(remoteDir, 't-rem'))) {
        return 'Tier 2 远端 start 不应自动伪造 explored 证据'
      }

      // 2) Tier 2 local-only without --issue（W4A C1 自动认领 local-only 无 Issue 任务）
      const localRoots = await resolveRepoRoots(localDir)
      const stLocal = await withCaptureIo(() => handleStart({
        task: 't-loc', slug: 'loc-fix', case: '2', implementer: 'alice', 'no-issue': true, reason: '本地无工单自动认领验证夹具',
      }, localRoots))
      if (stLocal.res.exitCode !== 0) return `Tier 2 本地 start 失败：exit=${stLocal.res.exitCode}, err=${stLocal.err}`
      if (!readTaskLedger(localDir, 't-loc')?.claimedAt) {
        return 'Tier 2 local-only 无 Issue start 应自动记 claimedAt'
      }

      // 2b) 显式 claim 后引导 finalize（Case 2 不强卡 needs-explore）
      const clLocal = await withCaptureIo(() => handleClaim({ task: 't-loc', agent: 'alice' }, localRoots))
      if (clLocal.res.exitCode !== 0) return `claim 失败：exit=${clLocal.res.exitCode}, err=${clLocal.err}`
      if (!clLocal.out.includes('finalize --task t-loc')) {
        return `claim [NEXT STEP] 未引导 finalize：${clLocal.out}`
      }

      // 3) Tier 1 unborn repo (commits === 0)
      const emptyRoots = await resolveRepoRoots(emptyCommitDir)
      const stEmpty = await withCaptureIo(() => handleStart({
        task: 't-t1', slug: 'init-fix', case: '2', implementer: 'alice', 'no-issue': true, reason: 'Tier 1 未提交仓库引导夹具',
      }, emptyRoots))
      if (stEmpty.res.exitCode !== 0) return `Tier 1 start 失败：exit=${stEmpty.res.exitCode}, err=${stEmpty.err}`
      if (!stEmpty.out.includes('[NEXT STEP]') || !stEmpty.out.includes('claim --task t-t1')) {
        return `Tier 1 start [NEXT STEP] 未引导 claim：${stEmpty.out}`
      }
      if (hasExploredEvidence(readTaskLedger(emptyCommitDir, 't-t1'))) {
        return 'Tier 1 start 不应自动伪造 explored 证据'
      }

      return true
    } finally {
      rmTree(remoteDir)
      rmTree(localDir)
      rmTree(emptyCommitDir)
    }
  }])

  cases.push(['flow submit 前置校验：planning 规划阶段阻断 submit、转正后自动含 explored 放行、显式 flow explore 可刷新证据', async () => {
    const dir = makeBaseRepo({ withRemote: false })
    try {
      const roots = await resolveRepoRoots(dir)

      // 负向 1：--planning 态规划中任务未转正 -> submit 应以 exit 3 阻断 BLOCKED_PLAN_NOT_READY
      await withCaptureIo(() => handleStart({ task: 'c2-plan', slug: 'c2-plan', case: '2', planning: true, implementer: 'alice', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c2-plan', agent: 'alice', json: true }, roots))
      const wtPlan = join(dir, '.worktrees', 'impl-c2-plan')
      writeFileSync(join(wtPlan, 'src/app.mjs'), 'export const value = 20\n')
      gitCommitFast(wtPlan, 'fix: plan draft', { updateOnly: true })
      const verPlan = await withCaptureIo(() => handleVerify({ task: 'c2-plan', mode: 'full', json: true }, roots))
      if (verPlan.res.exitCode !== 0) return `c2-plan verify 失败：${verPlan.err}`

      const subBlockText = await withCaptureIo(() => handleSubmit({ task: 'c2-plan', agent: 'alice' }, roots))
      if (subBlockText.res.exitCode !== 3 || !subBlockText.err.includes('BLOCKED_PLAN_NOT_READY')) {
        return `planning 态 submit 未以 exit 3 BLOCKED_PLAN_NOT_READY 阻断：exit=${subBlockText.res.exitCode}, err=${subBlockText.err}`
      }
      const subBlockJson = await withCaptureIo(() => handleSubmit({ task: 'c2-plan', agent: 'alice', json: true }, roots))
      const parsedBlock = JSON.parse(subBlockJson.out)
      if (subBlockJson.res.exitCode !== 3 || parsedBlock.code !== 'BLOCKED_PLAN_NOT_READY') {
        return `planning 态 submit JSON 载荷不符预期：${subBlockJson.out}`
      }

      // 正向 1：正常 Case 2 启动，无需手工 explore 即可 submit 放行
      await withCaptureIo(() => handleStart({ task: 'c2-code', slug: 'c2-code', case: '2', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦提交探索门禁', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c2-code', agent: 'alice', json: true }, roots))
      const wtC2 = join(dir, '.worktrees', 'impl-c2-code')
      writeFileSync(join(wtC2, 'src/app.mjs'), 'export const value = 2\n')
      gitCommitFast(wtC2, 'fix: update value', { updateOnly: true })
      const verC2 = await withCaptureIo(() => handleVerify({ task: 'c2-code', mode: 'full', json: true }, roots))
      if (verC2.res.exitCode !== 0) return `c2-code verify 失败：${verC2.err}`
      const subPass = await withCaptureIo(() => handleSubmit({ task: 'c2-code', agent: 'alice', json: true }, roots))
      if (subPass.res.exitCode !== 0) {
        return `自动探索后 submit 未放行：exit=${subPass.res.exitCode}, err=${subPass.err}, out=${subPass.out}`
      }
      const ledgerPassed = readTaskLedger(dir, 'c2-code')
      if (ledgerPassed?.status !== 'local-ready') {
        return `submit 后账本状态未更新为 local-ready：status=${ledgerPassed?.status}`
      }

      // 正向 2：显式 flow explore 仍可用作刷新入口
      const expRes = await withCaptureIo(() => handleExplore({ task: 'c2-code', json: true }, roots))
      if (expRes.res.exitCode !== 0) return `显式 flow explore 刷新失败：${expRes.err}`

      return true
    } finally {
      rmTree(dir)
    }
  }])
}
