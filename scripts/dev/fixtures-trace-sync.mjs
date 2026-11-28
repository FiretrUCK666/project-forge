/**
 * fixtures-trace-sync.mjs —— 远端规划全节点同步、后绑回补、非破坏摘要、同轮 HEAD 更新与结构化关单正反双向夹具。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import {
  gitCommitFast, gitInit, gitInitBare, gitSync, rmTree, runAbsAsync, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'
import { startMockRemoteServer } from './mock-remote-server.mjs'

async function withQuietIo(fn) {
  const out = []
  const origOut = process.stdout.write
  const origErr = process.stderr.write
  process.stdout.write = (c, ...rest) => { out.push(String(c)); if (typeof rest[0] === 'function') rest[0](); return true }
  process.stderr.write = (_c, ...rest) => { if (typeof rest[0] === 'function') rest[0](); return true }
  try {
    const val = await fn()
    return { val, stdout: out.join('') }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerTraceSyncCases(cases) {
  cases.push(['trace-sync-C1a：doc-plan init 多文件传入与 clarify/continue/override/supersede 触发和内容指纹去重', async () => {
    const { PLAN_SYNC_PHASES, syncPlanPhaseToBackend } = await import('../../kit/skills/lib/plan-sync.mjs')
    const { createGitHubClient } = await import('../../kit/skills/lib/github-client.mjs')
    const { createTaskBackend } = await import('../../kit/skills/lib/task-backend.mjs')

    for (const p of ['init', 'clarify', 'critique-continue', 'critique-override', 'supersede', 'plan-backfill']) {
      if (!PLAN_SYNC_PHASES[p]) return `PLAN_SYNC_PHASES 缺失阶段：${p}`
    }

    const badPhase = await syncPlanPhaseToBackend({ phase: 'nonexistent-phase' })
    if (badPhase.ok || badPhase.status !== 'INVALID_PHASE') {
      return `非法同步阶段未被拦截：${JSON.stringify(badPhase)}`
    }

    const dir = tmpProject({
      'AGENTS.md': '# Demo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    const srv = await startMockRemoteServer()
    try {
      gitInit(dir, { branch: 'main', name: 'Arch', email: 'arch@example.com' })
      gitCommitFast(dir, 'init')
      const roots = await resolveRepoRoots(dir)

      // 1) local-only 下 init --kind pair 传入全部 res.files 到 planSync
      const validIssueBody = (lead) => [
        '## 背景与现象',
        lead,
        '`src/app.mjs:1` 需要同步追踪。',
        '## 影响面与严重度',
        '影响 `src/app.mjs`；severity=medium；不涉及 API 与安全边界。',
        '## 期望与方案',
        '执行 `node -e "console.log(1)"` 验证同步正常。',
        '## 验收标准',
        '- [ ] C1: 验证 `src/app.mjs` 联动完成',
        '## 不在本次范围',
        '不动 `README.md`。',
      ].join('\n')
      const localIss = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', 'Pair Sync Tracking', '--body', validIssueBody('User original body'), '--json',
      ], { cwd: dir })
      if (localIss.status !== 0) return `创建本地工单失败：${localIss.stderr}`
      const locNum = JSON.parse(localIss.stdout).issue.number

      const pairRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'pair', '--slug', 'pair-sync', '--title', 'Pair Sync',
        '--issue', String(locNum), '--task', 'pair-sync', '--owner', 'arch-1', '--in-place', '--json',
      ], { cwd: dir })
      if (pairRes.status !== 0) return `doc-plan init pair 失败：${pairRes.stderr}`
      const pairParsed = JSON.parse(pairRes.stdout)
      if (!Array.isArray(pairParsed.files) || pairParsed.files.length !== 2) {
        return `init pair 返回 files 异常：${JSON.stringify(pairParsed)}`
      }
      const locViewPair = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'view', '--issue', String(locNum), '--json',
      ], { cwd: dir })).stdout)
      const pairCmtBody = locViewPair.comments?.[0]?.body ?? ''
      if (!pairCmtBody.includes(pairParsed.files[0]) || !pairCmtBody.includes(pairParsed.files[1])) {
        return `doc-plan init pair 未向 syncPlanPhaseToBackend 传入全部 files：\n${pairCmtBody}`
      }

      const ghClient = createGitHubClient({ tier: 'node-https-token', token: 't', httpsRequest: srv.createHttpsRequest('alice') })
      const ghIss = await ghClient.createIssue({ repo: 'acme/demo', title: 'Remote Pair', body: 'Handwritten user note\n\n- Keep me' })
      const bk = createTaskBackend({ role: 'maintainer', providerId: 'github', targetRepo: 'acme/demo', client: ghClient, mainRoot: dir, gitDir: roots.gitDir })

      const initRemote = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir,
        phase: 'init', file: pairParsed.file, files: pairParsed.files,
        taskId: 'pair-sync-remote', issueNumber: ghIss.number, backend: bk, targetRepo: 'acme/demo',
        summary: '初始化 PAIR: Pair Sync',
      })
      if (!initRemote.ok || !initRemote.synced) return `远端 init 多文件同步失败：${JSON.stringify(initRemote)}`
      const stAfterInit = await srv.getState()
      const initCmt = stAfterInit.comments[ghIss.number]?.[0]?.body ?? ''
      if (!initCmt.includes(pairParsed.files[0]) || !initCmt.includes(pairParsed.files[1])) {
        return `init 多文件未全部写入评论：\n${initCmt}`
      }

      // 2) clarify：同决定去重，新决定生成新 key 同步
      const specRel = pairParsed.files.find((f) => f.includes('/specs/'))
      const c1 = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'clarify', '--file', specRel, '--decision', '采用幂等键方案 A', '--by', 'user', '--issue', String(locNum), '--json',
      ], { cwd: dir })
      if (c1.status !== 0) return `clarify 失败：${c1.stderr}`
      const c1Data = JSON.parse(c1.stdout)
      if (!c1Data.planSync || c1Data.planSync.phase !== 'clarify') {
        return `clarify 未触发 planSync：${JSON.stringify(c1Data)}`
      }
      const c1Dup = await syncPlanPhaseToBackend({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir,
        phase: 'clarify', file: specRel, reason: '采用幂等键方案 A', summary: c1Data.entry,
        taskId: 'pair-sync', issueNumber: locNum,
      })
      if (!c1Dup.deduplicated) return `相同 clarify 决定未去重：${JSON.stringify(c1Dup)}`

      const c2 = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'clarify', '--file', specRel, '--decision', '补充边界 B', '--by', 'user', '--issue', String(locNum), '--json',
      ], { cwd: dir })
      const c2Data = JSON.parse(c2.stdout)
      if (c2Data.planSync?.deduplicated || c2Data.planSync?.syncKey === c1Data.planSync?.syncKey) {
        return `不同 clarify 决定误被去重：${JSON.stringify({ c1: c1Data.planSync, c2: c2Data.planSync })}`
      }

      // 3) critique-reject x3 -> stop-loss -> critique-continue & critique-override & supersede
      const specAbs = join(dir, specRel)
      writeFileSync(specAbs, readFileSync(specAbs, 'utf8')
        .replace(/<第一条可运行或可静态判定的硬标准>/g, '所有节点必须幂等留痕')
        .replace(/<第二条>/g, '保留正文不破坏')
        .replace(/<[^>]+>/g, '已补充真实内容'))
      for (const [rnd, rev] of [[1, 'rev-1'], [2, 'rev-2'], [3, 'rev-3']]) {
        writeFileSync(specAbs, `${readFileSync(specAbs, 'utf8').trimEnd()}\n<!-- r${rnd} -->\n`)
        await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
          'critique-reject', '--file', specRel, '--reviewer', rev, '--round', String(rnd), '--summary', `reject ${rnd}`, '--json',
        ], { cwd: dir })
      }
      const contRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-continue', '--file', specRel, '--reason', '补充边界设计后继续复核', '--by', 'maintainer', '--json',
      ], { cwd: dir })
      if (contRes.status !== 0) return `critique-continue 失败：${contRes.stderr}`
      const contData = JSON.parse(contRes.stdout)
      if (contData.planSync?.phase !== 'critique-continue') return `critique-continue 未触发 planSync：${JSON.stringify(contData)}`

      const ovRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-override', '--file', specRel, '--human-approved', '--reason', '人类确认边界清晰予以放行', '--by', 'maintainer', '--json',
      ], { cwd: dir })
      if (ovRes.status !== 0) return `critique-override 失败：${ovRes.stderr}`
      const ovData = JSON.parse(ovRes.stdout)
      if (ovData.planSync?.phase !== 'critique-override') return `critique-override 未触发 planSync：${JSON.stringify(ovData)}`

      const newSpecInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'pair-sync-v2', '--title', 'Pair Sync V2',
        '--issue', String(locNum), '--owner', 'arch-1', '--in-place', '--force', '--json',
      ], { cwd: dir })
      if (newSpecInit.status !== 0) return `新 SPEC init 失败：${newSpecInit.stderr}`
      const newSpecRel = JSON.parse(newSpecInit.stdout).file

      const supRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'supersede', specRel, '--by', newSpecRel, '--json',
      ], { cwd: dir })
      if (supRes.status !== 0) return `supersede 失败：${supRes.stderr}`
      const supData = JSON.parse(supRes.stdout)
      if (supData.planSync?.phase !== 'supersede') return `supersede 未触发 planSync：${JSON.stringify(supData)}`

      const supDup = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'supersede', specRel, '--by', newSpecRel, '--json',
      ], { cwd: dir })
      const supDupData = JSON.parse(supDup.stdout)
      if (!supDupData.planSync?.deduplicated) return `重复 supersede 未去重：${JSON.stringify(supDupData)}`

      return true
    } finally {
      srv.close()
      rmTree(dir)
    }
  }])

  cases.push(['trace-sync-C1b：后绑 --issue 自动 plan-backfill 与 mergeManagedPlanSummary/updateIssueBody 非破坏保留正文', async () => {
    const { mergeManagedPlanSummary } = await import('../../kit/skills/lib/plan-sync.mjs')
    const { createGitHubClient } = await import('../../kit/skills/lib/github-client.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')

    // 1) mergeManagedPlanSummary 正反双向断言
    const userProse = '## 需求背景\n\n用户手写的关键上下文，包含 `代码` 与列表：\n- 第一点\n- 第二点'
    const userTail = '## 补充附录\n\n用户放在末尾的附加说明。'
    const merged1 = mergeManagedPlanSummary(userProse, '### 规划摘要（自动同步）\n- **当前状态**：`draft`')
    if (!merged1.includes(userProse) || !merged1.includes('<!-- pf:plan-summary:start -->') || !merged1.includes('`draft`')) {
      return `mergeManagedPlanSummary 初次插入失败：\n${merged1}`
    }
    const withTail = `${merged1}\n\n${userTail}`
    const merged2 = mergeManagedPlanSummary(withTail, '### 规划摘要（自动同步）\n- **当前状态**：`approved`')
    if (!merged2.includes(userProse) || !merged2.includes(userTail) || !merged2.includes('`approved`') || merged2.includes('`draft`')) {
      return `mergeManagedPlanSummary 替换区间时破坏外部正文：\n${merged2}`
    }
    const unchanged = mergeManagedPlanSummary(userProse, '')
    if (unchanged !== userProse) return `空摘要不应修改原正文：\n${unchanged}`

    // 2) github-client.mjs updateIssueBody 正反断言
    const badPatch = await createGitHubClient({ tier: 'node-https-token', token: 't' }).updateIssueBody({ repo: 'acme/demo', number: 0, body: 'x' })
    if (badPatch.ok || badPatch.error !== 'missing-repo-number-or-body') {
      return `updateIssueBody 非法参数未被拦截：${JSON.stringify(badPatch)}`
    }
    const delegPatch = await createGitHubClient({ tier: 'mcp-delegate' }).updateIssueBody({ repo: 'acme/demo', number: 5, body: 'hi' })
    if (!delegPatch.delegated || delegPatch.action !== 'update_issue') {
      return `updateIssueBody mcp-delegate 载荷异常：${JSON.stringify(delegPatch)}`
    }

    // 3) doc-plan link --issue 与 flow-inspect 后绑 --issue 自动 plan-backfill
    const dir = tmpProject({
      'AGENTS.md': '# Demo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    const srv = await startMockRemoteServer()
    try {
      gitInit(dir, { branch: 'main', name: 'Maintainer', email: 'm@example.com' })
      gitCommitFast(dir, 'init')
      const roots = await resolveRepoRoots(dir)

      // 3a) 本地工单 + doc-plan init (不传 --issue) -> critique-pass -> approve -> doc-plan link --issue
      const backfillBody = [
        '## 背景与现象',
        'User handwritten problem description. (`src/app.mjs:1`)',
        '## 影响面与严重度',
        '影响 `src/app.mjs`；severity=medium；无外部接口破坏。',
        '## 期望与方案',
        '通过 `node -e "console.log(1)"` 验证后绑回补。',
        '## 验收标准',
        '- [ ] C1: `src/app.mjs` 后绑回补成功',
        '## 不在本次范围',
        '不动其他目录。',
      ].join('\n')
      const locIss = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'create', '--title', 'Backfill Target', '--body', backfillBody, '--json',
      ], { cwd: dir })
      const locNum = JSON.parse(locIss.stdout).issue.number

      const specInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'late-link', '--title', 'Late Link Feature',
        '--task', 'late-link', '--owner', 'arch-1', '--in-place', '--json',
      ], { cwd: dir })
      if (specInit.status !== 0) return `late-link spec init 失败：${specInit.stderr}`
      const specRel = JSON.parse(specInit.stdout).file
      const specAbs = join(dir, specRel)
      writeFileSync(specAbs, readFileSync(specAbs, 'utf8')
        .replace(/<第一条可运行或可静态判定的硬标准>/g, '支持后绑自动回补')
        .replace(/<第二条>/g, '保留用户正文')
        .replace(/<[^>]+>/g, '修改 `src/app.mjs` 入口函数 `ok`'))

      const cpRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', specRel, '--reviewer', 'crit-1', '--round', '1', '--summary', 'looks good', '--json',
      ], { cwd: dir })
      if (cpRes.status !== 0) return `late-link critique-pass 失败：${cpRes.stderr}\n${cpRes.stdout}`
      const apRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'approve', '--file', specRel, '--task', 'late-link', '--json',
      ], { cwd: dir })
      if (apRes.status !== 0) return `late-link approve 失败：${apRes.stderr}\n${apRes.stdout}`

      const linkRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'link', 'late-link', '--issue', String(locNum), '--task', 'late-link', '--json',
      ], { cwd: dir })
      if (linkRes.status !== 0) return `doc-plan link 失败：${linkRes.stderr}`
      const linkData = JSON.parse(linkRes.stdout)
      if (linkData.planSync?.phase !== 'plan-backfill') {
        return `doc-plan link --issue 未触发 plan-backfill：${JSON.stringify(linkData)}`
      }
      const viewRes = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'issue', 'view', '--issue', String(locNum), '--json',
      ], { cwd: dir })).stdout)
      if (!viewRes.body?.includes('User handwritten problem description.')
        || !viewRes.body?.includes('<!-- pf:plan-summary:start -->')
        || !viewRes.body?.includes('approved')) {
        return `link 回补未保留手写正文或未写入摘要块：\n${viewRes.body}`
      }
      if (!viewRes.comments?.some((c) => c.body.includes('规划摘要补录'))) {
        return `link 回补未写入结构化补录评论：${JSON.stringify(viewRes.comments)}`
      }

      // 3b) flow-inspect handleStart 后绑定 --issue 对远端 GitHub mock 触发 plan-backfill
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
      const ghClient = createGitHubClient({ tier: 'node-https-token', token: 't', httpsRequest: srv.createHttpsRequest('alice') })
      const remoteIss = await ghClient.createIssue({ repo: 'acme/demo', title: 'Remote Backfill', body: 'Remote user prose line 1\nRemote user prose line 2' })
      const probeMock = { env: { trackB: { tier: 'node-https-token', login: 'alice' } }, client: ghClient }

      const startInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'late-start', '--title', 'Late Start',
        '--task', 'late-start', '--owner', 'arch-1', '--in-place', '--json',
      ], { cwd: dir })
      const lateSpecRel = JSON.parse(startInit.stdout).file
      const lateSpecAbs = join(dir, lateSpecRel)
      writeFileSync(lateSpecAbs, readFileSync(lateSpecAbs, 'utf8')
        .replace(/<第一条可运行或可静态判定的硬标准>/g, 'start 后绑自动回补')
        .replace(/<第二条>/g, '已绑定不再重复回补')
        .replace(/<[^>]+>/g, '修改 `src/app.mjs` 入口函数 `ok`'))
      const cpLate = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', lateSpecRel, '--reviewer', 'crit-2', '--round', '1', '--summary', 'ok', '--json',
      ], { cwd: dir })
      if (cpLate.status !== 0) return `late-start critique-pass 失败：${cpLate.stderr}\n${cpLate.stdout}`
      const apLate = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'approve', '--file', lateSpecRel, '--task', 'late-start', '--json',
      ], { cwd: dir })
      if (apLate.status !== 0) return `late-start approve 失败：${apLate.stderr}\n${apLate.stdout}`
      gitCommitFast(dir, 'docs: approved spec without issue')

      const stRes = await withQuietIo(() => handleStart({
        task: 'late-start', slug: 'late-start', case: '4', issue: String(remoteIss.number),
        implementer: 'impl-dev', json: true, _ghClient: ghClient, _ghProbe: probeMock,
      }, roots))
      if (stRes.val.exitCode !== 0) return `handleStart 后绑失败：exit=${stRes.val.exitCode}`
      const srvState1 = await srv.getState()
      const remCmts1 = srvState1.comments[remoteIss.number] ?? []
      const remIss1 = srvState1.issues.find((i) => i.number === remoteIss.number)
      if (!remCmts1.some((c) => c.body.includes('规划摘要补录'))
        || !remIss1?.body?.includes('Remote user prose line 1')
        || !remIss1?.body?.includes('<!-- pf:plan-summary:start -->')) {
        return `flow-inspect 后绑未回补评论或未非破坏更新 Issue 正文：${JSON.stringify({ remCmts1, remIss1 })}`
      }
      // 再次幂等重入 handleStart 不得重复刷屏
      const cmtCountBefore = remCmts1.length
      await withQuietIo(() => handleStart({
        task: 'late-start', slug: 'late-start', case: '4', issue: String(remoteIss.number),
        implementer: 'impl-dev', json: true, _ghClient: ghClient, _ghProbe: probeMock,
      }, roots))
      const srvState2 = await srv.getState()
      if ((srvState2.comments[remoteIss.number] ?? []).length !== cmtCountBefore) {
        return `flow-inspect 幂等重入竟重复回补评论`
      }

      return true
    } finally {
      srv.close()
      rmTree(dir)
    }
  }])

  cases.push(['trace-sync-C2/C3/C4：同轮 HEAD 更新提交区分、flow close 结构化关单与全 .mjs <= 800L', async () => {
    const { buildIssueCloseComment, buildSubmitComments } = await import('../../kit/skills/lib/doc-comments.mjs')
    const { createGitHubClient } = await import('../../kit/skills/lib/github-client.mjs')
    const { handleStart, handleClose, handleFinalize, handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow.mjs').catch(() => ({}))
    void handleStart; void handleClose; void handleFinalize; void handleVerify; void handleSubmit
    const { handleStart: startFn } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleClose: closeFn } = await import('../../kit/skills/dev-flow/scripts/flow-issues.mjs')
    const { handleFinalize: finFn, handleVerify: verFn, handleSubmit: subFn } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleClaim: claimFn } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')

    // 1) buildSubmitComments 三态正反断言
    const headUpdate = buildSubmitComments({
      isRework: false, isHeadUpdate: true, round: 1, shortHead: 'abc1234', actorDisplay: '@alice（`impl-w4c`）',
      branch: 'feat/demo', verifiedCmd: 'exit 0', prNumber: 77, linkedIssues: [10],
    })
    if (!headUpdate.prCommentBody.includes('### 提交更新（Round 1 · HEAD 更新 @ `abc1234`）')
      || !headUpdate.issueCommentBodyFor(10).includes('### 提交更新（Round 1 · HEAD 更新 @ `abc1234`）')
      || headUpdate.prCommentBody.includes('提交待审')
      || headUpdate.issueCommentBodyFor(10).includes('提交待审')) {
      return `isHeadUpdate=true 评论渲染异常：\n${headUpdate.prCommentBody}\n${headUpdate.issueCommentBodyFor(10)}`
    }
    const reworkWins = buildSubmitComments({
      isRework: true, isHeadUpdate: true, round: 2, shortHead: 'def5678', actorDisplay: '`impl-w4c`',
      branch: 'feat/demo', verifiedCmd: 'exit 0', prNumber: 77, linkedIssues: [10],
    })
    if (!reworkWins.prCommentBody.includes('### 返工已提交（Round 2')) {
      return `isRework=true 应优先渲染返工已提交：\n${reworkWins.prCommentBody}`
    }
    const firstSubmit = buildSubmitComments({
      isRework: false, isHeadUpdate: false, round: 1, shortHead: '1111111', actorDisplay: '`impl-w4c`',
      branch: 'feat/demo', verifiedCmd: 'exit 0', prNumber: 77, linkedIssues: [10],
    })
    if (!firstSubmit.prCommentBody.includes('### 提交待审（Round 1')) {
      return `首次提交应渲染提交待审：\n${firstSubmit.prCommentBody}`
    }

    // 2) 同轮非返工二次 submit 端到端验证
    const dir = tmpProject({
      'AGENTS.md': '# Demo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      'src/app.mjs': 'export const app = 1\n',
    })
    const bareRem = tmpProject({})
    gitInitBare(bareRem)
    const srv = await startMockRemoteServer()
    try {
      gitInit(dir, { branch: 'main', name: 'Dev', email: 'dev@example.com' })
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
      gitSync(dir, ['config', `url.${bareRem.replace(/\\/g, '/')}.pushInsteadOf`, 'https://github.com/acme/demo.git'])
      gitCommitFast(dir, 'init')
      const roots = await resolveRepoRoots(dir)

      const ghClient = createGitHubClient({ tier: 'node-https-token', token: 't', httpsRequest: srv.createHttpsRequest('alice') })
      const ghIss = await ghClient.createIssue({ repo: 'acme/demo', title: 'Head Update Issue', body: 'Track head updates' })
      const probeMock = { env: { trackB: { tier: 'gh-cli', login: 'alice' } }, client: ghClient }

      const st = await withQuietIo(() => startFn({
        task: 'head-up', slug: 'head-up', case: '2', issue: String(ghIss.number),
        implementer: 'impl-w4c', json: true, _ghClient: ghClient, _ghProbe: probeMock,
      }, roots))
      if (st.val.exitCode !== 0) return `head-up start 失败：${st.val.exitCode}`
      await withQuietIo(() => claimFn({ task: 'head-up', agent: 'impl-w4c', json: true, _ghClient: ghClient, _ghProbe: probeMock }, roots))
      await seedExploredFor(dir, 'head-up')

      const wt = join(dir, '.worktrees', 'impl-head-up')
      writeFileSync(join(wt, 'src', 'app.mjs'), 'export const app = 2\n')
      gitCommitFast(wt, 'fix: step 1')
      await withQuietIo(() => verFn({ task: 'head-up', mode: 'gate', cmd: 'exit 0', json: true }, roots))
      const sub1 = await withQuietIo(() => subFn({ task: 'head-up', agent: 'impl-w4c', json: true, _ghClient: ghClient, _ghProbe: probeMock }, roots))
      if (sub1.val.exitCode !== 0) return `首次 submit 失败：${sub1.val.exitCode}`
      const prNum = readTaskLedger(dir, 'head-up').prNumber

      // 同轮不经过 rework，直接新提交 -> verify -> submit
      writeFileSync(join(wt, 'src', 'app.mjs'), 'export const app = 3\n')
      gitCommitFast(wt, 'fix: step 2 same round')
      await withQuietIo(() => verFn({ task: 'head-up', mode: 'gate', cmd: 'exit 0', json: true }, roots))
      const sub2 = await withQuietIo(() => subFn({ task: 'head-up', agent: 'impl-w4c', json: true, _ghClient: ghClient, _ghProbe: probeMock }, roots))
      if (sub2.val.exitCode !== 0) return `同轮二次 submit 失败：${sub2.val.exitCode}`

      const srvState = await srv.getState()
      const prCmts = srvState.comments[prNum] ?? []
      const issCmts = srvState.comments[ghIss.number] ?? []
      if (prCmts.some((c) => c.body.includes('### 提交待审'))
        || !prCmts.some((c) => c.body.includes('### 提交更新（Round 1 · HEAD 更新 @'))
        || !issCmts.some((c) => c.body.includes(`已提 PR #${prNum}`))
        || !issCmts.some((c) => c.body.includes('### 提交更新（Round 1 · HEAD 更新 @'))) {
        return `首次新建 PR 应省略冗余首评且同轮二次提交应区分提交更新：${JSON.stringify({ prCmts, issCmts })}`
      }

      // 3) C3：buildIssueCloseComment 与 flow.mjs close 正反双向（GitHub + local-only）
      const closePreview = buildIssueCloseComment({
        issueNumber: 12, reason: '合并至总控追踪', intoIssue: 10, taskId: 't-close', actorDisplay: '@alice（`impl-w4c`）',
      })
      if (!closePreview.commentBody.includes('### 工单归并关闭（#12 -> #10）')
        || !closePreview.commentBody.includes('<!-- pf-state:')
        || closePreview.statePayload?.into !== 10) {
        return `buildIssueCloseComment 输出异常：\n${closePreview.commentBody}`
      }

      const ghIss2 = await ghClient.createIssue({ repo: 'acme/demo', title: 'Duplicate Issue', body: 'Close me into #1' })
      const ghCloseRes = await withQuietIo(() => closeFn({
        issue: String(ghIss2.number), into: String(ghIss.number), reason: '与主单重复，合并追踪',
        task: 'head-up', agent: 'impl-w4c', json: true, _ghClient: ghClient, _ghProbe: probeMock,
      }, roots))
      if (ghCloseRes.val.exitCode !== 0) return `GitHub flow close 失败：${ghCloseRes.val.exitCode}`
      const afterCloseState = await srv.getState()
      const closedGhIss = afterCloseState.issues.find((i) => i.number === ghIss2.number)
      const closedGhCmts = afterCloseState.comments[ghIss2.number] ?? []
      if (closedGhIss?.state !== 'CLOSED'
        || !closedGhCmts.some((c) => c.body.includes('工单归并关闭') && c.body.includes('<!-- pf-state:') && c.body.includes('与主单重复，合并追踪'))) {
        return `GitHub flow close 未关闭工单或缺少结构化 pf-state 评论：${JSON.stringify({ closedGhIss, closedGhCmts })}`
      }

      // local-only CLI 测试与反面校验
      const locDir = tmpProject({ 'README.md': '# Local Close\n' })
      try {
        gitInit(locDir, { branch: 'main', name: 'Local', email: 'l@example.com' })
        gitCommitFast(locDir, 'init')
        const closeBody = [
          '## 背景与现象',
          '`README.md:1` 本地归并测试工单。',
          '## 影响面与严重度',
          '影响 `README.md`；severity=low；不涉及代码与安全边界。',
          '## 期望与方案',
          '运行 `node -e "console.log(1)"` 后归并关闭。',
          '## 验收标准',
          '- [ ] C1: 完成 `README.md` 归并记录',
          '## 不在本次范围',
          '不修改源码文件。',
        ].join('\n')
        const iA = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['issue', 'create', '--title', 'Target', '--body', closeBody, '--json'], { cwd: locDir })).stdout).issue.number
        const iB = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['issue', 'create', '--title', 'Old', '--body', closeBody, '--json'], { cwd: locDir })).stdout).issue.number

        const badSelf = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
          'close', '--issue', String(iB), '--into', String(iB), '--reason', 'bad',
        ], { cwd: locDir })
        if (badSelf.status === 0) return 'flow close 未拦截 --into 指向自身'

        const badNoReason = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
          'close', '--issue', String(iB),
        ], { cwd: locDir })
        if (badNoReason.status === 0) return 'flow close 未拦截缺失 --reason'

        const locClose = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
          'close', '--issue', String(iB), '--into', String(iA), '--reason', '本地归并收口', '--task', 'loc-t', '--json',
        ], { cwd: locDir })
        if (locClose.status !== 0) return `local-only flow close CLI 失败：${locClose.stderr}`
        const locView = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
          'issue', 'view', '--issue', String(iB), '--json',
        ], { cwd: locDir })).stdout)
        if (locView.state !== 'CLOSED' || locView.migratedTo !== iA || !locView.comments?.some((c) => c.body.includes('<!-- pf-state:') && c.body.includes('本地归并收口'))) {
          return `local-only flow close 后状态或结构化评论异常：${JSON.stringify(locView)}`
        }
      } finally { rmTree(locDir) }

      // 4) 全受影响 .mjs 文件 <= 800 行校验
      const checkedFiles = [
        'kit/skills/lib/plan-sync.mjs',
        'kit/skills/lib/github-client.mjs',
        'kit/skills/lib/task-backend.mjs',
        'kit/skills/lib/task-backend-local.mjs',
        'kit/skills/lib/doc-comments.mjs',
        'kit/skills/dev-plan/scripts/doc-plan.mjs',
        'kit/skills/dev-flow/scripts/flow.mjs',
        'kit/skills/dev-flow/scripts/flow-context.mjs',
        'kit/skills/dev-flow/scripts/flow-inspect.mjs',
        'kit/skills/dev-flow/scripts/flow-issues.mjs',
        'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
      ]
      for (const rel of checkedFiles) {
        const lines = readFileSync(join(process.cwd(), rel), 'utf8').split('\n').length
        if (lines > 800) return `${rel} 超出 800 行预算（${lines} 行）`
      }

      return true
    } finally {
      srv.close()
      rmTree(bareRem)
      rmTree(dir)
    }
  }])
}
