/**
 * fixtures-issue52.mjs —— Issue #52（C1..C4 独立审查令牌、Issue/PR 上下文持久化、PR SHA Diff 与契约一致性）双向夹具。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { createGitHubClient } from '../../kit/skills/lib/github-client.mjs'
import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import {
  createFakeGhEnv, gitCommitFast, gitInit, gitSync,
  rmTree, runAbsAsync, runNode, tmpProject,
} from './fixtures-helpers.mjs'

function makeIssue52Repo(extraFiles = {}, gitOpts = {}) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'package.json': '{"name":"i52-demo","version":"1.0.0","private":true}\n',
    'README.md': '# i52-demo\n\nIssue 52 verification repository.\n',
    'AGENTS.md': [
      '# i52-demo',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      'high-risk: none',
      'do-not-edit: docs/archive/',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const value = 1\n',
    ...extraFiles,
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com', ...gitOpts })
  return dir
}

export function registerIssue52Cases(cases) {
  cases.push(['C1：nextReviewRound 单一派生(rounds=[1,3])、flow next 令牌幂等、缺失/伪造 implementerId 阻断与一次性消费', async () => {
    const dir = makeIssue52Repo()
    try {
      const startRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 't52', '--slug', 'c1-slug', '--case', '2', '--implementer', 'alice', '--json',
      ], { cwd: dir })
      if (startRes.status !== 0) return `start t52 失败：${startRes.stderr}`

      const claimRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'claim', '--task', 't52', '--agent', 'alice', '--json',
      ], { cwd: dir })
      if (claimRes.status !== 0) return `claim t52 失败：${claimRes.stderr}`

      const expRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'explore', '--task', 't52', '--json',
      ], { cwd: dir })
      if (expRes.status !== 0) return `explore t52 失败：${expRes.stderr}`

      const wt = join(dir, '.worktrees', 'impl-t52')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const value = 2\n')
      gitCommitFast(wt, 'feat: update value', { updateOnly: true, name: 'alice', email: 'alice@example.com' })
      const curHead = gitSync(wt, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      const verRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'verify', '--task', 't52', '--mode', 'full', '--json',
      ], { cwd: dir })
      if (verRes.status !== 0) return `verify t52 失败：${verRes.stderr}`

      const subRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'submit', '--task', 't52', '--json',
      ], { cwd: dir })
      if (subRes.status !== 0) return `submit t52 失败：${subRes.stderr}`

      // 构造轮次空档 rounds=[1, 3]，确保签发与 record 用同一派生式得到 Round 4
      const ledger = readTaskLedger(dir, 't52')
      ledger.rounds = [
        { round: 1, verdict: 'changes', headSha: '1111111111111111111111111111111111111111', reviewerId: 'rev-a', mustFix: [] },
        { round: 3, verdict: 'changes', headSha: '2222222222222222222222222222222222222222', reviewerId: 'rev-b', mustFix: [] },
      ]
      writeTaskLedger(dir, ledger)

      const n1 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['next', '--task', 't52', '--handoff', '--json'], { cwd: dir })
      const n2 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['next', '--task', 't52', '--handoff', '--json'], { cwd: dir })
      if (n1.status !== 0 || n2.status !== 0) return `flow next 失败：${n1.stderr} ${n2.stderr}`
      const j1 = JSON.parse(n1.stdout)
      const j2 = JSON.parse(n2.stdout)
      const tok = j1.reviewToken
      if (!tok || tok !== j2.reviewToken) return `flow next 连跑两次未复用同一未消费令牌：${tok} vs ${j2.reviewToken}`
      if (!j1.command?.includes('--round 4') || !j1.command?.includes(`--review-token ${tok}`) || !j1.handoffPrompt?.includes('--round 4')) {
        return `next command 未正确计算 --round 4 或附带令牌：${JSON.stringify({ handoff: j1.handoff, cmd: j1.command })}`
      }

      // 反面 1：缺令牌 / 假令牌 / 错误轮次令牌均须 exit 2 BLOCKED_REVIEW_TOKEN
      const noTok = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--verdict', 'pass', '--reviewer-id', 'rev-c', '--evidence', 'ok', '--json',
      ], { cwd: dir })
      if (noTok.status !== 2 || !noTok.stdout.includes('BLOCKED_REVIEW_TOKEN')) {
        return `缺 --review-token 未阻断：exit=${noTok.status} out=${noTok.stdout}`
      }

      const badTok = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--verdict', 'pass', '--reviewer-id', 'rev-c', '--review-token', 'pf-rv-deadbeef', '--evidence', 'ok', '--json',
      ], { cwd: dir })
      if (badTok.status !== 2 || !badTok.stdout.includes('UNKNOWN_REVIEW_TOKEN')) {
        return `假令牌未报 UNKNOWN_REVIEW_TOKEN：exit=${badTok.status} out=${badTok.stdout}`
      }

      const wrongRound = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--round', '3', '--verdict', 'pass', '--reviewer-id', 'rev-c', '--review-token', tok, '--evidence', 'ok', '--json',
      ], { cwd: dir })
      if (wrongRound.status !== 2 || !wrongRound.stdout.includes('REVIEW_TOKEN_ROUND_MISMATCH')) {
        return `错轮次令牌未阻断：exit=${wrongRound.status} out=${wrongRound.stdout}`
      }

      // 反面 2：传不同 --implementer-id 企图绕过账本里的 alice 自审仍须拦截 SELF_REVIEW_REJECTED
      const spoofSelf = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--verdict', 'pass', '--reviewer-id', 'alice', '--implementer-id', 'bob', '--review-token', tok, '--evidence', 'ok', '--json',
      ], { cwd: dir })
      if (spoofSelf.status !== 2 || !spoofSelf.stdout.includes('SELF_REVIEW_REJECTED')) {
        return `伪造 --implementer-id 绕过了自审检查：exit=${spoofSelf.status} out=${spoofSelf.stdout}`
      }

      // 反面 3：无 implementerId 时直接 BLOCKED_MISSING_IMPLEMENTER
      writeTaskLedger(dir, {
        taskId: 'no-impl',
        slug: 'no-impl',
        caseType: 2,
        role: 'local-only',
        branch: 'main',
        baseBranch: 'main',
        baseSha: curHead,
        implementerId: null,
        reviewTokens: [{ token: 'pf-rv-noimpl1', round: 1, issuedAt: '2026-01-01T00:00:00Z', consumedAt: null }],
      })
      const missImpl = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'no-impl', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-c', '--review-token', 'pf-rv-noimpl1', '--evidence', 'ok', '--json',
      ], { cwd: dir })
      if (missImpl.status !== 2 || !missImpl.stdout.includes('BLOCKED_MISSING_IMPLEMENTER')) {
        return `缺失 implementerId 未报 BLOCKED_MISSING_IMPLEMENTER：exit=${missImpl.status} out=${missImpl.stdout}`
      }

      // 正向：不传 --round（直测已修复的 nextReviewRound(baseLedger)）完成 Round 4 记录
      const recOk = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--verdict', 'pass', '--reviewer-id', 'rev-c', '--review-token', tok, '--evidence', 'node --test: pass', '--json',
      ], { cwd: dir })
      if (recOk.status !== 0) return `不传 --round 记录 Round 4 失败：exit=${recOk.status} err=${recOk.stderr} out=${recOk.stdout}`
      const recJson = JSON.parse(recOk.stdout)
      if (recJson.round !== 4 || !recJson.reviewPassed) return `record 结果非 Round 4 pass：${recOk.stdout}`

      // 反面 4：复用已消费令牌必须被 REVIEW_TOKEN_ALREADY_CONSUMED 拦截
      const reuse = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 't52', '--round', '4', '--verdict', 'pass', '--reviewer-id', 'rev-d', '--review-token', tok, '--evidence', 'replay', '--json',
      ], { cwd: dir })
      if (reuse.status !== 2 || !reuse.stdout.includes('REVIEW_TOKEN_ALREADY_CONSUMED')) {
        return `重复消费令牌未阻断：exit=${reuse.status} out=${reuse.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C2：Issue/PR 上下文持久化与错误归一、重跑 start 补全清零、compactContext 与 --ack-no-issue-context', async () => {
    const dir = makeIssue52Repo({}, { origin: 'https://github.com/acme/c2-demo.git' })
    const fakeGh = createFakeGhEnv({})
    try {
      // 1. 离线 start --issue 52 写入 no-api-channel，next 卡在 needs-issue-context
      const sOff = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-t', '--issue', '52', '--case', '3', '--implementer', 'alice', '--json',
      ], { cwd: dir })
      if (sOff.status !== 0) return `离线 start --issue 52 失败：${sOff.stderr}`
      const lOff = readTaskLedger(dir, 'c2-t')
      if (lOff.issueContext?.[0]?.reason !== 'no-api-channel' || lOff.issueContextUnavailable?.[0] !== 52) {
        return `离线 issueContext 记录异常：${JSON.stringify(lOff)}`
      }
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['claim', '--task', 'c2-t', '--agent', 'alice', '--json'], { cwd: dir })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['explore', '--task', 'c2-t', '--json'], { cwd: dir })

      const nBlocked = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['next', '--task', 'c2-t', '--json'], { cwd: dir })
      const nbJson = JSON.parse(nBlocked.stdout)
      if (nbJson.phase !== 'needs-issue-context' || nbJson.compactContext?.issueContextUnavailable?.[0] !== 52) {
        return `离线缺 Issue 上下文未进 needs-issue-context 或 compactContext 缺失：${nBlocked.stdout}`
      }

      // 2. HTTP 404 / 403 失败原因归一（not-found / forbidden）
      const roots = await resolveRepoRoots(dir)
      const errRes = await handleStart({
        task: 'c2-err',
        issue: '98,99',
        case: '2',
        implementer: 'alice',
        _ghProbe: { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'alice' } }, client: {} },
        _ghClient: {
          tier: 'gh-cli',
          async getIssue(_repo, num) {
            if (num === 99) return { ok: false, status: 404, error: 'HTTP 404 Not Found' }
            return { ok: false, status: 403, error: 'Resource not accessible by integration' }
          },
        },
        knownIssueStates: { 98: { number: 98, state: 'OPEN' }, 99: { number: 99, state: 'OPEN' } },
      }, roots)
      if (errRes.exitCode !== 0) return `handleStart c2-err 失败：${errRes.exitCode}`
      const lErr = readTaskLedger(dir, 'c2-err')
      const r98 = lErr.issueContext.find((x) => x.number === 98)?.reason
      const r99 = lErr.issueContext.find((x) => x.number === 99)?.reason
      if (r98 !== 'forbidden' || r99 !== 'not-found') {
        return `错误原因未归一为 forbidden/not-found：r98=${r98}, r99=${r99}`
      }

      // 3. --ack-no-issue-context 缺 --reason 报错；带有效 --reason 放行
      const ackNoReason = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'next', '--task', 'c2-t', '--ack-no-issue-context', '--json',
      ], { cwd: dir })
      if (ackNoReason.status !== 2 || !ackNoReason.stdout.includes('BLOCKED_ACK_MISSING_REASON')) {
        return `--ack-no-issue-context 缺 --reason 未阻断：exit=${ackNoReason.status} out=${ackNoReason.stdout}`
      }
      const ackOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'next', '--task', 'c2-t', '--ack-no-issue-context', '--reason', 'Offline mirror confirmed', '--json',
      ], { cwd: dir })
      if (ackOk.status !== 0) return `--ack-no-issue-context 放行失败：${ackOk.stderr}`
      const ackJson = JSON.parse(ackOk.stdout)
      if (ackJson.phase === 'needs-issue-context' || ackJson.compactContext?.issueContextAck?.reason !== 'Offline mirror confirmed') {
        return `确认继续后阶段或 compactContext 未更新：${ackOk.stdout}`
      }

      // 4. 恢复通道重跑 flow start（含 PR 上下文），必须补全正文、清零 unavailable/ack 并写入 PR SHA
      const mainSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      fakeGh.update({
        login: 'alice',
        issues: {
          52: { number: 52, title: 'Review Independence', state: 'OPEN', body: 'Need single-use token and SHA diff.', url: 'https://github.com/acme/c2-demo/issues/52', labels: [] },
        },
        prs: {
          77: {
            number: 77, title: 'PR 77', state: 'OPEN', body: 'Fixes #52', url: 'https://github.com/acme/c2-demo/pull/77',
            baseRefName: 'main', headRefName: 'feat/c2-t', baseRefOid: mainSha, headRefOid: mainSha, author: { login: 'alice' },
          },
        },
      })
      const reStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'c2-t', '--issue', '52', '--pr', '77', '--case', '3', '--json',
      ], { cwd: dir, env: fakeGh.env })
      if (reStart.status !== 0) return `恢复通道重跑 start 失败：${reStart.stderr}`
      const lFixed = readTaskLedger(dir, 'c2-t')
      if (!lFixed.issueContext?.[0]?.fetched || (lFixed.issueContextUnavailable ?? []).length !== 0 || lFixed.issueContextAck !== null) {
        return `重跑 start 未补全 Issue 或清零 unavailable/ack：${JSON.stringify(lFixed)}`
      }
      if (!lFixed.prContext?.fetched || lFixed.prContextUnavailable !== null || lFixed.prBaseSha !== mainSha || lFixed.prHeadSha !== mainSha) {
        return `重跑 start 未落盘 prContext/prBaseSha/prHeadSha：${JSON.stringify(lFixed)}`
      }

      const nReady = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['next', '--task', 'c2-t', '--json'], { cwd: dir })
      const cc = JSON.parse(nReady.stdout).compactContext
      if (!cc?.issueContext?.[0]?.fetched || !cc?.prContext?.fetched || cc?.prBaseSha !== mainSha || cc?.prHeadSha !== mainSha) {
        return `compactContext 未携带完整 Issue/PR 上下文：${JSON.stringify(cc)}`
      }
      return true
    } finally { fakeGh.cleanup(); rmTree(dir) }
  }])

  cases.push(['C3：node-https-token getPr 返回 baseRefOid/headRefOid、PR 精确 SHA Diff 与禁止 --task 绕过', async () => {
    // 1. node-https-token getPr 返回 base.sha / head.sha 与 tier='none' 保持
    const client = createGitHubClient({
      tier: 'node-https-token',
      token: 'tok',
      httpsRequest: async () => ({
        ok: true,
        status: 200,
        data: {
          number: 66,
          title: 'PR 66',
          state: 'open',
          merged: false,
          body: 'Fixes #52',
          html_url: 'https://github.com/acme/c3-demo/pull/66',
          base: { ref: 'main', sha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' },
          head: { ref: 'feat/x', sha: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222', repo: { full_name: 'fork/c3-demo' } },
          user: { login: 'ext' },
        },
      }),
    })
    const prObj = await client.getPr('acme/c3-demo', 66)
    if (prObj.baseRefOid !== 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' || prObj.headRefOid !== 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222') {
      return `node-https-token getPr 未返回 baseRefOid/headRefOid：${JSON.stringify(prObj)}`
    }
    const noneClient = createGitHubClient({ tier: 'none' })
    const noneRes = await noneClient.getIssue('acme/c3-demo', 1)
    if (noneRes.tier !== 'none') return `tier='none' 委托客户端被误改写为 ${noneRes.tier}`

    // 2. CLI 审查：离线阻断、--task 禁绕过、缺 SHA 阻断、高危门禁禁绕过、合法精确 SHA Diff
    const dir = makeIssue52Repo({}, { origin: 'https://github.com/acme/c3-demo.git' })
    const fakeGh = createFakeGhEnv({})
    try {
      const mainSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(dir, ['checkout', '-qb', 'ext-66'])
      writeFileSync(join(dir, 'src/app.mjs'), 'export const value = 66\n')
      gitCommitFast(dir, 'pr 66 commit', { updateOnly: true, name: 'ext', email: 'ext@example.com' })
      const prSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      gitSync(dir, ['checkout', '-q', 'main'])
      gitSync(dir, ['checkout', '-qb', 'ext-67'])
      const wfDir = join(dir, '.github', 'workflows')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(wfDir, { recursive: true })
      writeFileSync(join(wfDir, 'evil.yml'), 'name: evil\non: pull_request_target\njobs: {}\n')
      gitCommitFast(dir, 'pr 67 hazard')
      const evilSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(dir, ['checkout', '-q', 'main'])

      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--external-pr', '66', '--pr-ref', prSha, '--json'], { cwd: dir })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--external-pr', '67', '--pr-ref', evilSha, '--json'], { cwd: dir })

      // 离线 --pr 66 即使有本地账本与 worktree 仍须 BLOCKED_PR_UNRESOLVED
      const offPr = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--pr', '66', '--json'], { cwd: dir })
      if (offPr.status !== 3 || !offPr.stdout.includes('BLOCKED_PR_UNRESOLVED')) {
        return `离线 --pr 66 未报 BLOCKED_PR_UNRESOLVED：exit=${offPr.status} out=${offPr.stdout}`
      }
      // --task review-pr-66 离线也必须被阻断（不可绕过 PR 检查）
      const offTaskBypass = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'review-pr-66', '--json'], { cwd: dir })
      if (offTaskBypass.status !== 3 || !offTaskBypass.stdout.includes('BLOCKED_PR_UNRESOLVED')) {
        return `--task review-pr-66 绕过了离线 PR 检查：exit=${offTaskBypass.status} out=${offTaskBypass.stdout}`
      }

      // API 返回缺少 SHA -> BLOCKED_PR_UNRESOLVED
      fakeGh.update({
        login: 'rev',
        prs: {
          66: { number: 66, title: 'No SHAs', state: 'OPEN', baseRefName: 'main', headRefName: 'ext-66' },
        },
      })
      const noSha = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--pr', '66', '--json'], { cwd: dir, env: fakeGh.env })
      if (noSha.status !== 3 || !noSha.stdout.includes('missing-pr-shas')) {
        return `缺 baseRefOid/headRefOid 未报 missing-pr-shas：exit=${noSha.status} out=${noSha.stdout}`
      }

      // 有效 PR #66 与高危 PR #67
      fakeGh.update({
        login: 'rev',
        prs: {
          66: { number: 66, title: 'PR 66', state: 'OPEN', baseRefName: 'main', headRefName: 'ext-66', baseRefOid: mainSha, headRefOid: prSha, url: 'https://github.com/acme/c3-demo/pull/66' },
          67: { number: 67, title: 'PR 67', state: 'OPEN', baseRefName: 'main', headRefName: 'ext-67', baseRefOid: mainSha, headRefOid: evilSha, url: 'https://github.com/acme/c3-demo/pull/67' },
        },
      })
      const okPr = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--pr', '66', '--untrusted-scan', '--json'], { cwd: dir, env: fakeGh.env })
      if (okPr.status !== 0) return `PR #66 SHA 审查失败：${okPr.stderr} ${okPr.stdout}`
      const okJson = JSON.parse(okPr.stdout)
      if (okJson.diffScope !== `${mainSha}...${prSha}`) {
        return `PR diffScope 未严格使用 SHA...SHA：got=${okJson.diffScope}`
      }
      const l66 = readTaskLedger(dir, 'review-pr-66')
      if (l66.prBaseSha !== mainSha || l66.prHeadSha !== prSha) {
        return `账本未更新 prBaseSha/prHeadSha：${JSON.stringify(l66)}`
      }

      // --task review-pr-67（不传 --untrusted-scan）仍强制不可信扫描并阻断高危改动
      const hazTask = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'review-pr-67', '--json'], { cwd: dir, env: fakeGh.env })
      if (hazTask.status !== 3 || !hazTask.stdout.includes('BLOCKED_UNTRUSTED_HAZARD')) {
        return `--task review-pr-67 绕过了不可信高危扫描：exit=${hazTask.status} out=${hazTask.stdout}`
      }
      return true
    } finally { fakeGh.cleanup(); rmTree(dir) }
  }])

  cases.push(['C4：compose-agents --tier 冲突拦截与意图路由缺技能 SKILL.md 死链检测', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"c4-demo","version":"1.0.0","private":true,"scripts":{"test":"exit 0"}}\n',
      'README.md': '# c4-demo\n\nC4 verification repo.\n',
      'src/app.mjs': 'export const value = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const eq = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (eq.status !== 0) return `equip full 失败：${eq.stderr}`
      const comp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (comp.status !== 0) return `compose-agents 失败：${comp.stderr}`
      writeFileSync(join(dir, 'AGENTS.md'), readFileSync(join(dir, 'AGENTS.md'), 'utf8').replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。'))
      const chkOk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkOk.status !== 0) return `一致仓 compose-agents --check 失败：${chkOk.stderr}`

      // 1. --tier 与 .pf-manifest.json tier 冲突
      const mismatch = await runNode('compose-agents.mjs', [dir, '--check', '--tier', 'lightweight'])
      if (mismatch.status === 0 || !mismatch.stderr.includes('TIER_CONFLICT')) {
        return `--tier 与 manifest 冲突未阻断：exit=${mismatch.status} err=${mismatch.stderr}`
      }
      const mismatchWrite = await runNode('compose-agents.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
      if (mismatchWrite.status === 0 || !mismatchWrite.stderr.includes('TIER_CONFLICT')) {
        return `生成阶段 --tier 与 manifest 冲突未阻断：exit=${mismatchWrite.status} err=${mismatchWrite.stderr}`
      }

      // 2. 删除 .agents/skills/dev-review 但未更新 manifest -> --check 检出死链并失败
      rmTree(join(dir, '.agents', 'skills', 'dev-review'))
      const deadChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (deadChk.status === 0 || !deadChk.stderr.includes('.agents/skills/dev-review/SKILL.md')) {
        return `删除技能目录后 --check 未拦截死链：exit=${deadChk.status} err=${deadChk.stderr}`
      }

      // 3. 即便标了 customized，意图路由指向磁盘缺失文件也须失败
      const agentsCust = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        .replace('<!-- project-forge: begin 意图路由 -->', '<!-- project-forge: begin 意图路由 customized -->')
      writeFileSync(join(dir, 'AGENTS.md'), agentsCust)
      const custDeadChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (custDeadChk.status === 0 || !custDeadChk.stderr.includes('.agents/skills/dev-review/SKILL.md')) {
        return `customized 意图路由残留死链时 --check 竟退出 0：exit=${custDeadChk.status}`
      }

      // 4. 还原技能并取消 customized 后恢复通过
      const restore = await runNode('equip.mjs', [dir, '--restore', 'dev-review', '--no-backup'])
      if (restore.status !== 0 || !existsSync(join(dir, '.agents/skills/dev-review/SKILL.md'))) {
        return `restore dev-review 失败：${restore.stderr}`
      }
      writeFileSync(join(dir, 'AGENTS.md'), agentsCust.replace('<!-- project-forge: begin 意图路由 customized -->', '<!-- project-forge: begin 意图路由 -->'))
      const finalChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (finalChk.status !== 0) return `恢复后 compose-agents --check 未复绿：${finalChk.stderr}`
      return true
    } finally { rmTree(dir) }
  }])
}
