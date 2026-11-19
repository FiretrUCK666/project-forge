/**
 * fixtures-flow-explore-gate.mjs —— flow start 引导 claim/explore 与 flow submit 探索门禁正反双向夹具。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  cases.push(['flow start [NEXT STEP] 在 Tier 2（含远端/本地）与 Tier 1 均明确引导 claim 与 explore', async () => {
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
      if (!stRemote.out.includes('[NEXT STEP]') || !stRemote.out.includes('claim --task t-rem') || !stRemote.out.includes('explore --task t-rem')) {
        return `Tier 2 远端 start [NEXT STEP] 未同时引导 claim 与 explore：${stRemote.out}`
      }

      // 2) Tier 2 local-only without --issue
      const localRoots = await resolveRepoRoots(localDir)
      const stLocal = await withCaptureIo(() => handleStart({
        task: 't-loc', slug: 'loc-fix', case: '2', implementer: 'alice',
      }, localRoots))
      if (stLocal.res.exitCode !== 0) return `Tier 2 本地 start 失败：exit=${stLocal.res.exitCode}, err=${stLocal.err}`
      if (!stLocal.out.includes('[NEXT STEP]') || !stLocal.out.includes('claim --task t-loc') || !stLocal.out.includes('explore --task t-loc')) {
        return `Tier 2 本地 start [NEXT STEP] 未同时引导 claim 与 explore：${stLocal.out}`
      }

      // 2b) claim 在未探索前应引导 explore
      const clLocal = await withCaptureIo(() => handleClaim({ task: 't-loc', agent: 'alice' }, localRoots))
      if (clLocal.res.exitCode !== 0) return `claim 失败：exit=${clLocal.res.exitCode}, err=${clLocal.err}`
      if (!clLocal.out.includes('explore --task t-loc')) {
        return `未探索时 claim [NEXT STEP] 未引导 explore：${clLocal.out}`
      }

      // 3) Tier 1 unborn repo (commits === 0)
      const emptyRoots = await resolveRepoRoots(emptyCommitDir)
      const stEmpty = await withCaptureIo(() => handleStart({
        task: 't-t1', slug: 'init-fix', case: '2', implementer: 'alice',
      }, emptyRoots))
      if (stEmpty.res.exitCode !== 0) return `Tier 1 start 失败：exit=${stEmpty.res.exitCode}, err=${stEmpty.err}`
      if (!stEmpty.out.includes('[NEXT STEP]') || !stEmpty.out.includes('claim --task t-t1') || !stEmpty.out.includes('explore --task t-t1')) {
        return `Tier 1 start [NEXT STEP] 未同时引导 claim 与 explore：${stEmpty.out}`
      }

      return true
    } finally {
      rmTree(remoteDir)
      rmTree(localDir)
      rmTree(emptyCommitDir)
    }
  }])

  cases.push(['flow submit 前置校验 hasExploredEvidence：缺探索 exit 3 阻断、补 explore 放行、Case 1 低风险纯文档豁免与反绕过', async () => {
    const dir = makeBaseRepo({ withRemote: false })
    try {
      const roots = await resolveRepoRoots(dir)

      // 负向 1：Case 2 改动源码未跑 explore -> submit 应以 exit 3 阻断 BLOCKED_NOT_EXPLORED 并给精确解锁命令
      await withCaptureIo(() => handleStart({ task: 'c2-code', slug: 'c2-code', case: '2', implementer: 'alice', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c2-code', agent: 'alice', json: true }, roots))
      const wtC2 = join(dir, '.worktrees', 'impl-c2-code')
      writeFileSync(join(wtC2, 'src/app.mjs'), 'export const value = 2\n')
      gitCommitFast(wtC2, 'fix: update value', { updateOnly: true })
      const verC2 = await withCaptureIo(() => handleVerify({ task: 'c2-code', mode: 'full', json: true }, roots))
      if (verC2.res.exitCode !== 0) return `c2-code verify 失败：${verC2.err}`

      const subBlockText = await withCaptureIo(() => handleSubmit({ task: 'c2-code' }, roots))
      if (subBlockText.res.exitCode !== 3) {
        return `缺 explored 时 submit 文本模式未以 exit 3 阻断：exit=${subBlockText.res.exitCode}, out=${subBlockText.out}, err=${subBlockText.err}`
      }
      if (!subBlockText.err.includes('BLOCKED_NOT_EXPLORED') || !subBlockText.err.includes('flow.mjs explore --task c2-code')) {
        return `缺 explored 时 submit stderr 未含 BLOCKED_NOT_EXPLORED 或精确解锁命令：${subBlockText.err}`
      }
      if (!subBlockText.out.includes('[NEXT STEP]') || !subBlockText.out.includes('explore --task c2-code')) {
        return `缺 explored 时 submit 文本模式未输出 explore 解锁 [NEXT STEP]：${subBlockText.out}`
      }

      const subBlockJson = await withCaptureIo(() => handleSubmit({ task: 'c2-code', json: true }, roots))
      if (subBlockJson.res.exitCode !== 3) {
        return `缺 explored 时 submit JSON 模式未以 exit 3 阻断：exit=${subBlockJson.res.exitCode}`
      }
      const parsedBlock = JSON.parse(subBlockJson.out)
      if (parsedBlock.code !== 'BLOCKED_NOT_EXPLORED' || !String(parsedBlock.nextStep ?? '').includes('explore --task c2-code')) {
        return `缺 explored 时 submit JSON 载荷不符预期：${subBlockJson.out}`
      }
      const ledgerBlocked = readTaskLedger(dir, 'c2-code')
      if (ledgerBlocked?.status === 'local-ready' || ledgerBlocked?.status === 'submitted') {
        return `被阻断后账本不应变为已提交态：status=${ledgerBlocked?.status}`
      }

      // 正向 1：补跑 explore 后 submit 放行
      const expRes = await withCaptureIo(() => handleExplore({ task: 'c2-code', json: true }, roots))
      if (expRes.res.exitCode !== 0) return `explore 失败：${expRes.err}`
      const subPass = await withCaptureIo(() => handleSubmit({ task: 'c2-code', json: true }, roots))
      if (subPass.res.exitCode !== 0) {
        return `补跑 explore 后 submit 仍未放行：exit=${subPass.res.exitCode}, err=${subPass.err}, out=${subPass.out}`
      }
      const ledgerPassed = readTaskLedger(dir, 'c2-code')
      if (ledgerPassed?.status !== 'local-ready') {
        return `补跑 explore 后 submit 账本状态未更新为 local-ready：status=${ledgerPassed?.status}`
      }

      // 正向 2：Case 1 低风险纯文档改动未跑 explore -> 豁免放行不误拦
      await withCaptureIo(() => handleStart({ task: 'c1-doc', slug: 'c1-doc', case: '1', implementer: 'alice', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c1-doc', agent: 'alice', json: true }, roots))
      const wtC1Doc = join(dir, '.worktrees', 'impl-c1-doc')
      mkdirSync(dirname(join(wtC1Doc, 'docs/notes.md')), { recursive: true })
      writeFileSync(join(wtC1Doc, 'docs/notes.md'), '# Notes\n\nupdated typo.\n')
      gitCommitFast(wtC1Doc, 'docs: fix typo', { updateOnly: true })
      const verC1Doc = await withCaptureIo(() => handleVerify({ task: 'c1-doc', mode: 'quick', json: true }, roots))
      if (verC1Doc.res.exitCode !== 0) return `c1-doc verify 失败：${verC1Doc.err}`
      const subC1Doc = await withCaptureIo(() => handleSubmit({ task: 'c1-doc', json: true }, roots))
      if (subC1Doc.res.exitCode !== 0) {
        return `Case 1 低风险纯文档被误拦：exit=${subC1Doc.res.exitCode}, err=${subC1Doc.err}, out=${subC1Doc.out}`
      }

      // 负向 2（反绕过）：Case 1 伪装但实际改了源码（非 low risk）-> 不可豁免，必须 exit 3 阻断
      await withCaptureIo(() => handleStart({ task: 'c1-code', slug: 'c1-code', case: '1', implementer: 'alice', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c1-code', agent: 'alice', json: true }, roots))
      const wtC1Code = join(dir, '.worktrees', 'impl-c1-code')
      writeFileSync(join(wtC1Code, 'src/app.mjs'), 'export const value = 3\n')
      gitCommitFast(wtC1Code, 'fix: code under case 1', { updateOnly: true })
      const verC1Code = await withCaptureIo(() => handleVerify({ task: 'c1-code', mode: 'full', json: true }, roots))
      if (verC1Code.res.exitCode !== 0) return `c1-code verify 失败：${verC1Code.err}`
      const subC1Code = await withCaptureIo(() => handleSubmit({ task: 'c1-code', json: true }, roots))
      if (subC1Code.res.exitCode !== 3 || !subC1Code.err.includes('BLOCKED_NOT_EXPLORED')) {
        return `Case 1 改源码绕过了 BLOCKED_NOT_EXPLORED：exit=${subC1Code.res.exitCode}, err=${subC1Code.err}`
      }

      // 负向 3（反绕过）：Case 2 仅改普通 .md 文档未探索 -> 非 Case 1，不可豁免，必须 exit 3 阻断
      await withCaptureIo(() => handleStart({ task: 'c2-doc', slug: 'c2-doc', case: '2', implementer: 'alice', json: true }, roots))
      await withCaptureIo(() => handleClaim({ task: 'c2-doc', agent: 'alice', json: true }, roots))
      const wtC2Doc = join(dir, '.worktrees', 'impl-c2-doc')
      writeFileSync(join(wtC2Doc, 'docs/notes.md'), '# Notes\n\ncase 2 doc edit.\n')
      gitCommitFast(wtC2Doc, 'fix: doc under case 2', { updateOnly: true })
      const verC2Doc = await withCaptureIo(() => handleVerify({ task: 'c2-doc', mode: 'full', json: true }, roots))
      if (verC2Doc.res.exitCode !== 0) return `c2-doc verify 失败：${verC2Doc.err}`
      const subC2Doc = await withCaptureIo(() => handleSubmit({ task: 'c2-doc', json: true }, roots))
      if (subC2Doc.res.exitCode !== 3 || !subC2Doc.err.includes('BLOCKED_NOT_EXPLORED')) {
        return `Case 2 改文档绕过了 BLOCKED_NOT_EXPLORED：exit=${subC2Doc.res.exitCode}, err=${subC2Doc.err}`
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])
}
