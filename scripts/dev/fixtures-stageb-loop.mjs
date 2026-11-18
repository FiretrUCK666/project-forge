/**
 * fixtures-stageb-loop.mjs —— Stage B 自迭代闭环双向行为夹具（C7–C8、C20）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleStart, inspectWorkspace } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleIssue } from '../../kit/skills/dev-flow/scripts/flow-issues.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge, handleRelease } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { findMatchingDocStrict } from '../../kit/skills/dev-flow/scripts/flow-context.mjs'
import { applyIssuesToBackend } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import { handleRecord as handleReviewRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { buildNonInteractiveEnv } from '../../kit/skills/lib/exec.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import {
  createGitHubClient,
  parseFlowInputs,
  parseIssueNumbers,
  parsePrNumber,
} from '../../kit/skills/lib/github-client.mjs'
import { readTaskLedger, updateTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { createLocalIssue, getLocalIssue, listLocalIssues, updateLocalIssue } from '../../kit/skills/lib/local-issues.mjs'
import { detectGitModeMarkers } from '../../kit/skills/lib/platform.mjs'
import { extractHostAndPath } from '../../kit/skills/lib/platform-probe.mjs'
import { buildSessionOrientation } from '../../kit/skills/lib/session-orient.mjs'
import { createTaskBackend, TASK_BACKEND_METHODS } from '../../kit/skills/lib/task-backend.mjs'
import { buildConditions } from '../compose-agents.mjs'
import { equip } from '../equip.mjs'
import { FORBIDDEN_PLATFORM_RE } from '../lib/protocol.mjs'
import { toMarkdown } from '../lib/render.mjs'
import {
  gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor,
  rmTree, runAbsAsync, seedExploredFor, SKILL_ROOT, survey, tmpProject,
} from './fixtures-helpers.mjs'
import { collectKitWriteProbeTargets, scanKitWriteProbeViolations } from './write-probe-audit.mjs'
import { registerStageBLoopB4bCases } from './fixtures-stageb-loop-b4b.mjs'

export function registerStageBLoopCases(cases) {
  cases.push(['C7：LocalOnlyBackend 16 接口、跨 Worktree 原子持久化与零 git status 污染', async () => {
    if (TASK_BACKEND_METHODS.length !== 16) return `TASK_BACKEND_METHODS 数量应为 16，实际 ${TASK_BACKEND_METHODS.length}`
    for (const m of ['getIssue', 'listIssues', 'closeIssue']) {
      if (!TASK_BACKEND_METHODS.includes(m)) return `TASK_BACKEND_METHODS 缺失 ${m}`
    }
    const dir = tmpProject({ 'README.md': '# c7\n', '.gitignore': '.worktrees/\n' })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      for (const cfg of [
        { role: 'maintainer', providerId: 'github', targetRepo: 'acme/demo' },
        { role: 'generic-git', providerId: 'generic-git', targetRepo: null },
        { role: 'local-only', providerId: 'none', targetRepo: null },
      ]) {
        const bk = createTaskBackend({ ...cfg, mainRoot: dir })
        for (const m of TASK_BACKEND_METHODS) {
          if (typeof bk[m] !== 'function') return `后端 ${cfg.role} 缺少方法 ${m}`
        }
      }
      const localBk = createTaskBackend({ role: 'local-only', providerId: 'none', mainRoot: dir })
      if (!localBk.capabilities.issues || !localBk.capabilities.labels || localBk.capabilities.pr || localBk.capabilities.releases) {
        return `LocalOnlyBackend capabilities 异常：${JSON.stringify(localBk.capabilities)}`
      }
      const cr = await localBk.createIssue({ title: '本地特性单', body: '初始正文', labels: ['feat'] })
      if (!cr.ok || cr.number !== 1) return `createIssue 失败：${JSON.stringify(cr)}`
      await localBk.addLabels({ number: 1, labels: ['triaged'] })
      await localBk.postComment({ taskId: 'c7-task', number: 1, body: '进度评论', statePayload: { taskId: 'c7-task', action: 'progress' } })
      const cListByNum = await localBk.listComments(1)
      const cListByTask = await localBk.listComments({ number: 1, taskId: 'other-key' })
      if (!cListByNum.ok || cListByNum.comments.length !== 1 || cListByTask.comments.length !== 1) {
        return `postComment/listComments 键值未对齐：byNum=${JSON.stringify(cListByNum)} byTask=${JSON.stringify(cListByTask)}`
      }
      await localBk.removeLabel({ number: 1, label: 'triaged' })
      const wtDir = join(dir, '.worktrees/impl-c7')
      gitSync(dir, ['worktree', 'add', '-b', 'feat/c7', wtDir, 'HEAD'])
      const fromWt = getLocalIssue({ mainRoot: wtDir, number: 1 })
      if (!fromWt.ok || fromWt.title !== '本地特性单' || fromWt.labels.includes('triaged') || !fromWt.labels.includes('feat')) {
        return `worktree 跨仓读取本地工单失败：${JSON.stringify(fromWt)}`
      }
      const cl1 = await localBk.closeIssue(1)
      const cl2 = await localBk.closeIssue(1)
      if (!cl1.ok || cl1.alreadyClosed || !cl2.ok || !cl2.alreadyClosed) {
        return `closeIssue 幂等语义异常：cl1=${JSON.stringify(cl1)} cl2=${JSON.stringify(cl2)}`
      }
      const st = gitSync(dir, ['status', '--porcelain'], { encoding: 'utf8' })
      if (st.stdout.trim() !== '') return `本地工单污染了 git status：${st.stdout}`

      // [MF-1] 正反双向：损坏 index.json / items/*.json 必须显式报错且绝不覆盖，ENOENT 才返回 404 或重建索引
      const missingRes = getLocalIssue({ mainRoot: dir, number: 999 })
      if (missingRes.ok || missingRes.status !== 404) return `不存在的本地工单未按 ENOENT 返回 404：${JSON.stringify(missingRes)}`
      const issuesDir = join(dir, '.git', 'project-forge-flow', 'issues')
      const idxFile = join(issuesDir, 'index.json')
      const item1File = join(issuesDir, 'items', '1.json')
      const origIdx = readFileSync(idxFile, 'utf8')
      const origItem1 = readFileSync(item1File, 'utf8')
      writeFileSync(idxFile, '{corrupted-index')
      writeFileSync(item1File, '{corrupted-item-1')
      let errCreateBoth = null
      try { await createLocalIssue({ mainRoot: dir, title: '不应覆盖损坏数据' }) } catch (e) { errCreateBoth = e }
      if (!errCreateBoth || !String(errCreateBoth.message).includes('LOCAL_ISSUE_CORRUPTED')) {
        return `损坏 index+item 时 createLocalIssue 未显式阻断：${errCreateBoth?.message}`
      }
      if (readFileSync(idxFile, 'utf8') !== '{corrupted-index' || readFileSync(item1File, 'utf8') !== '{corrupted-item-1') {
        return '损坏文件在 createLocalIssue 失败后仍被覆盖'
      }
      writeFileSync(idxFile, origIdx)
      let errView = null
      let errList = null
      let errUpdate = null
      try { getLocalIssue({ mainRoot: dir, number: 1 }) } catch (e) { errView = e }
      try { listLocalIssues({ mainRoot: dir, state: 'all' }) } catch (e) { errList = e }
      try { await updateLocalIssue({ mainRoot: dir, number: 1, patch: { title: 'x' } }) } catch (e) { errUpdate = e }
      if (!errView || !String(errView.message).includes('LOCAL_ISSUE_CORRUPTED')
        || !errList || !String(errList.message).includes('LOCAL_ISSUE_CORRUPTED')
        || !errUpdate || !String(errUpdate.message).includes('LOCAL_ISSUE_CORRUPTED')) {
        return `损坏 items/1.json 时 view/list/update 静默误判或吞错：view=${errView?.message}, list=${errList?.message}, upd=${errUpdate?.message}`
      }
      writeFileSync(item1File, origItem1)
      unlinkSync(idxFile)
      const rebuilt = await createLocalIssue({ mainRoot: dir, title: '无 index 重建' })
      if (!rebuilt.ok || rebuilt.number !== 2) return `index.json ENOENT 重建自增编号异常：${JSON.stringify(rebuilt)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C7：pf-local-mode 区分 no-remote 与 readonly-override、非粘滞清理及渲染指引', async () => {
    const dir = tmpProject({ 'README.md': '# sticky\n', '.gitignore': '.worktrees/\n' })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const svBefore = await survey(dir)
      const qSetup = svBefore.questions?.find((q) => q.id === 'q.remote-setup')
      if (!qSetup || /写入\s*`\.git\/pf-local-mode`/.test(qSetup.text)) {
        return `survey-questions q.remote-setup 仍指引写入 .git/pf-local-mode：${qSetup?.text}`
      }
      const markerPath = join(dir, '.git', 'pf-local-mode')
      writeFileSync(markerPath, JSON.stringify({ mode: 'no-remote', updatedAt: '2026-01-01T00:00:00Z' }))
      if (!detectGitModeMarkers(dir).localMode) return '无远端时 no-remote 标记未生效'

      const svLocal = await survey(dir)
      const md = toMarkdown(svLocal)
      if (/在\s*`\.git\/`\s*创建\s*`pf-local-mode`|写入\s*`\.git\/pf-local-mode`/.test(md)) {
        return 'render.mjs 仍误指引无远端仓写裸 .git/pf-local-mode'
      }

      appendFileSync(
        join(dir, '.git', 'config'),
        '\n[remote "origin"]\n\turl = https://github.com/acme/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
        'utf8',
      )
      const afterRemote = detectGitModeMarkers(dir)
      if (afterRemote.localMode || !afterRemote.staleNoRemote) {
        return `绑远端后 stale no-remote 未失效：${JSON.stringify(afterRemote)}`
      }
      const condHasRemote = buildConditions({ git: { remote: ['https://github.com/acme/demo.git'], isRepoRoot: true, localMode: afterRemote.localMode }, ecosystem: { kinds: [] } })
      if (!condHasRemote['has-remote']) return 'compose-agents buildConditions 在 stale no-remote 下未判 has-remote'

      const eqRes = equip(dir, { noBackup: true })
      if (!eqRes.cleanedStaleLocalMode?.length || existsSync(markerPath)) {
        return `equip.mjs 未清理陈旧 no-remote 标记：${JSON.stringify(eqRes)}`
      }

      // 反向护栏：readonly-override 与空文件在有远端时必须继续锁定 localMode=true
      writeFileSync(markerPath, JSON.stringify({ mode: 'readonly-override' }))
      if (!detectGitModeMarkers(dir).localMode) return 'readonly-override 在有远端时丢失 localMode 锁定'
      const condLocked = buildConditions({ git: { remote: ['https://github.com/acme/demo.git'], isRepoRoot: true, localMode: true }, ecosystem: { kinds: [] } })
      if (condLocked['has-remote']) return 'compose-agents buildConditions 未尊重有效 localMode=true'
      writeFileSync(markerPath, '')
      if (!detectGitModeMarkers(dir).localMode) return '空 pf-local-mode 文件向后兼容锁定失效'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C8：local-only 全生命周期、--issue 匹配与依赖阻断、迁回远端及非交互 Git 护栏', async () => {
    const env = buildNonInteractiveEnv({})
    if (env.GIT_EDITOR !== 'true' || env.GIT_SEQUENCE_EDITOR !== 'true') {
      return `buildNonInteractiveEnv 缺失非交互编辑器保护：${JSON.stringify(env)}`
    }
    const wpErrors = scanKitWriteProbeViolations(collectKitWriteProbeTargets(SKILL_ROOT))
    if (wpErrors.length > 0) return `write-probe-audit 检出违规：${JSON.stringify(wpErrors)}`

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# c8-loop\n',
      'AGENTS.md': '# demo\n\n这个项目还没有远端，只有本地提交并经临时 `--detach` 试合推进主干。\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      equip(dir, { tier: 'full', noBackup: true })
      const spInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'custom-slug', '--title', '本地单绑定', '--issue', '1', '--owner', 'spec-writer',
      ], { cwd: dir })
      const tdInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'custom-slug', '--title', '本地单绑定', '--issue', '1', '--owner', 'spec-writer',
      ], { cwd: dir })
      if (spInit.status !== 0 || tdInit.status !== 0) {
        return `doc-plan init 失败：sp=${spInit.stderr}, td=${tdInit.stderr}`
      }
      gitCommitFast(dir, 'docs: add pre-created issue 1 spec and todo')

      const roots = await resolveRepoRoots(dir)
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = process.stderr.write.bind(process.stderr)
      let startRes, conflictClaim, takeoverRes, depBlock
      let errBuf = ''
      process.stdout.write = () => true
      try {
        startRes = await handleStart({ 'create-issue': true, title: '主功能工单', case: '3', implementer: 'alice', json: true }, roots)
        if (startRes.exitCode !== 0) return `local-only start --create-issue 失败：${startRes.exitCode}`
        const matchedSpec = findMatchingDocStrict(dir, 'docs/specs', 'issue-1', 'issue-1', [1])
        if (!matchedSpec || !matchedSpec.includes('custom-slug')) {
          return `findMatchingDocStrict 未按 frontmatter issue: 1 兜底匹配：${matchedSpec}`
        }

        process.stderr.write = (c) => { errBuf += String(c); return true }
        await handleClaim({ task: 'issue-1', agent: 'alice', json: true }, roots)
        conflictClaim = await handleClaim({ task: 'issue-1', agent: 'bob', json: true }, roots)
        process.stderr.write = origErr
        if (conflictClaim.exitCode !== 3 || !errBuf.includes('BLOCKED_ISSUE_ALREADY_CLAIMED')) {
          return `他人重复认领本地工单未拦截：exit=${conflictClaim.exitCode}, err=${errBuf}`
        }
        takeoverRes = await handleClaim({ task: 'issue-1', agent: 'bob', takeover: true, reason: '接力处理', json: true }, roots)
        if (takeoverRes.exitCode !== 0) return `合法 --takeover 失败：${takeoverRes.exitCode}`

        await handleIssue({ _: ['create'], title: '上游未完成', body: 'Depends on #1', json: true }, roots)
        await handleIssue({ _: ['comment'], issue: '2', body: '补充详情', json: true }, roots)
        await handleIssue({ _: ['view'], issue: '2', json: true }, roots)
        await handleIssue({ _: ['list'], state: 'open', json: true }, roots)
        process.stderr.write = () => true
        depBlock = await handleStart({ issue: '2', slug: 'dep-child', json: true }, roots)
        if (depBlock.exitCode !== 3) return `local-only 依赖未闭环未阻断 start：${depBlock.exitCode}`
      } finally {
        process.stdout.write = origOut
        process.stderr.write = origErr
      }
      const ledgerAfterStart = readTaskLedger(dir, 'issue-1')
      if (!ledgerAfterStart?.specFile?.includes('custom-slug') || ledgerAfterStart.issueContextUnavailable?.length > 0) {
        return `裸 --issue 绑文档或本地上下文水合异常：${JSON.stringify(ledgerAfterStart)}`
      }

      // 跑通 explore -> 代码改动 -> finalize -> commit -> verify -> submit -> review -> merge 并自动关闭本地工单 #1
      await seedExploredFor(dir, 'issue-1')
      const wtAbs = join(dir, ledgerAfterStart.worktreePath)
      writeFileSync(join(wtAbs, 'src/app.mjs'), 'export const ok = 2\n')
      gitSync(wtAbs, ['add', 'src/app.mjs'])
      gitSync(wtAbs, ['commit', '-qm', 'feat: implement local issue 1'])
      for (const relDoc of [ledgerAfterStart.todoFile, ledgerAfterStart.specFile].filter(Boolean)) {
        const p = join(wtAbs, relDoc)
        writeFileSync(p, readFileSync(p, 'utf8').replace(/- \[ \]/g, '- [x]'))
      }
      process.stdout.write = () => true
      let finRes, vRes, subRes, revCode, mergeRes
      try {
        finRes = await handleFinalize({ task: 'issue-1', 'no-tdd': true, json: true }, await resolveRepoRoots(wtAbs))
        if (finRes.exitCode !== 0) return `finalize 失败：${finRes.exitCode}`
        gitSync(wtAbs, ['add', '-A'])
        gitSync(wtAbs, ['commit', '-qm', 'docs: finalize issue 1'])
        vRes = await handleVerify({ task: 'issue-1', mode: 'smoke', cmd: 'node -e "process.exit(0)"', json: true }, await resolveRepoRoots(wtAbs))
        if (vRes.exitCode !== 0) return `verify 失败：${vRes.exitCode}`
        subRes = await handleSubmit({ task: 'issue-1', agent: 'bob', json: true }, await resolveRepoRoots(wtAbs))
        if (subRes.exitCode !== 0) return `local-only submit 失败：${subRes.exitCode}`
        const issueAfterSub = getLocalIssue({ mainRoot: dir, number: 1 })
        if (!(issueAfterSub.comments ?? []).some((c) => c.pfState?.action === 'local-ready')) {
          return `local-only submit 未回写本地工单评论：${JSON.stringify(issueAfterSub.comments)}`
        }

        const revToken = await issueTokenFor(dir, 'issue-1', 1)
        const revWt = join(dir, ledgerAfterStart.reviewWorktreePath)
        revCode = await handleReviewRecord({
          task: 'issue-1', verdict: 'pass', 'reviewer-id': 'rev-b3', 'review-token': revToken,
          evidence: 'node -e ok', json: true,
        }, await resolveRepoRoots(revWt))
        if (revCode !== 0) return `review record 失败：${revCode}`

        mergeRes = await handleMerge({ task: 'issue-1', json: true }, roots)
        if (mergeRes.exitCode !== 0) return `local-only merge 失败：${mergeRes.exitCode}`
      } finally {
        process.stdout.write = origOut
      }
      const closedIssue1 = getLocalIssue({ mainRoot: dir, number: 1 })
      if (closedIssue1.state !== 'CLOSED' || !(closedIssue1.comments ?? []).some((c) => c.body?.includes('合并') || c.pfState?.action === 'merged')) {
        return `merge 后未先评后关本地工单 #1：${JSON.stringify(closedIssue1)}`
      }

      // 治理想单直写 + 冷启动 + 绑定远端迁回
      const govApply = await applyIssuesToBackend(dir, [{ title: '治理遗留项', body: '待修', labels: ['governance'] }])
      if (!govApply.applied?.length || govApply.applied[0].local !== true) {
        return `local-only applyIssuesToBackend 建单失败：${JSON.stringify(govApply)}`
      }
      const orientBefore = buildSessionOrientation(dir)
      if (!orientBefore.text.includes('未闭环本地工单') || orientBefore.localIssues.length < 2) {
        return `冷启动未展示未闭环本地工单：${orientBefore.text}`
      }

      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/c8-migrated.git'])
      process.stdout.write = () => true
      let nextOut, migRes
      const migratedRemote = []
      const fakeRemoteClient = {
        tier: 'node-https-token',
        async createIssue({ title, body, labels }) {
          const n = 100 + migratedRemote.length
          migratedRemote.push({ number: n, title, body, labels, comments: [] })
          return { ok: true, number: n, url: `https://github.com/acme/c8-migrated/issues/${n}` }
        },
        async postComment({ number, body }) {
          const target = migratedRemote.find((x) => x.number === number)
          if (target) target.comments.push(body)
          return { ok: true, id: 1, verifiedReadback: true }
        },
      }
      let migDelegatedOut = ''
      let migDelegatedErr = ''
      let migDelegatedRes
      try {
        process.stdout.write = (c) => { migDelegatedOut += String(c); return true }
        process.stderr.write = (c) => { migDelegatedErr += String(c); return true }
        const delegatedClient = { tier: 'none', async createIssue({ title }) { return { ok: false, delegated: true, jsonPayload: { title } } } }
        migDelegatedRes = await handleIssue({
          _: ['migrate'], _ghClient: delegatedClient,
          _ghProbe: { env: { providerId: 'github', trackB: { tier: 'none' } }, client: delegatedClient },
        }, roots)
        process.stdout.write = () => true
        process.stderr.write = origErr
        nextOut = await handleNext({ json: true }, roots)
        migRes = await handleIssue({
          _: ['migrate'], _ghClient: fakeRemoteClient,
          _ghProbe: { env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } }, client: fakeRemoteClient },
          json: true,
        }, roots)
      } finally {
        process.stdout.write = origOut
        process.stderr.write = origErr
      }
      if (migDelegatedRes.exitCode !== 4 || !migDelegatedErr.includes('ACTION_REQUIRED_MIGRATE_DELEGATED') || !migDelegatedOut.includes('"title"')) {
        return `migrate delegated 非 JSON 控制台提示异常：exit=${migDelegatedRes.exitCode}, err=${migDelegatedErr}, out=${migDelegatedOut}`
      }
      const warnCodes = (nextOut.payload?.warnings ?? []).map((w) => w.code)
      if (!warnCodes.includes('WARN_REMOTE_DRIFT_AGENTS') || !warnCodes.includes('WARN_UNMIGRATED_LOCAL_ISSUES')) {
        return `切回远端后未打印漂移与未迁移提醒：${JSON.stringify(warnCodes)}`
      }
      if (migRes.exitCode !== 0 || migratedRemote.length < 2 || listLocalIssues({ mainRoot: dir, state: 'open' }).issues.length !== 0) {
        return `issue migrate 未完成迁单并关停全部开放本地单：exit=${migRes.exitCode}, rem=${migratedRemote.length}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }, 4000])

  cases.push(['C20：A1-A3 HTTP 退避禁重试禁重定向、幂等恢复、Checks 不假绿与通用 URL 解析', async () => {
    // 1. 协议路径 URL 泛化与 Windows 正斜杠排除（零平台品牌词）
    for (const bad of ['C:/repos/demo', 'D:/work/app.git', 'Z:\\local\\repo']) {
      if (extractHostAndPath(bad) !== null) return `Windows 本地路径被误判为远程主机：${bad}`
    }
    if (parsePrNumber('!42') !== 42) return '!42 短记号解析失败'
    if (parsePrNumber('https://git.corp.local/team/app/-/merge_requests/19') !== 19) return '自建站点 MR URL 解析失败'
    if (parsePrNumber('https://code.corp.local/org/app/pulls/23') !== 23) return '自建站点 /pulls/ URL 解析失败'
    const parsedFlow = parseFlowInputs([
      'https://git.corp.local/org/app/issues/88',
      'https://git.corp.local/org/app/-/merge_requests/19',
      '!7',
    ])
    if (parsedFlow.issues[0]?.number !== 88 || parsedFlow.prs.length !== 2) {
      return `parseFlowInputs 自建站点泛化失败：${JSON.stringify(parsedFlow)}`
    }
    const gpSrc = readFileSync(join(process.cwd(), 'kit', 'skills', 'lib', 'github-parse.mjs'), 'utf8')
    if (FORBIDDEN_PLATFORM_RE.test(gpSrc)) return 'github-parse.mjs 出现违禁平台字面量'

    // 2. HTTP 退避（429 Retry-After 上限 60s / 5xx / ERR_TLS）、禁重试（400/401/403/405/409/413）、禁 3xx 重定向
    const waits = []
    let seq = 0
    const retryClient = createGitHubClient({
      tier: 'node-https-token',
      token: 'tok',
      maxRetries: 2,
      retryBaseDelayMs: 10,
      sleep: async (ms) => { waits.push(ms) },
      httpsRequest: async (_m, _p, _t, _b, opts) => {
        if (opts?.redirect !== 'manual') throw new Error(`缺少 redirect: 'manual'（收到 ${opts?.redirect}）`)
        seq += 1
        if (seq === 1) return { ok: false, status: 429, headers: { 'retry-after': '120' }, data: { message: 'rate limit' } }
        if (seq === 2) return { ok: false, status: 0, code: 'ERR_TLS_CERT_ALTNAME_INVALID', headers: {}, data: { message: 'tls' } }
        return { ok: true, status: 200, headers: {}, data: { number: 5, title: 'ok', state: 'open', labels: [] } }
      },
    })
    const retried = await retryClient.getIssue('a/b', 5)
    if (!retried.ok || seq !== 3 || waits[0] !== 60000) {
      return `429/TLS 退避与 Retry-After 上限 60s 失败：ok=${retried.ok}, seq=${seq}, waits=${JSON.stringify(waits)}`
    }
    for (const status of [302, 400, 401, 403, 405, 409, 413]) {
      let calls = 0
      const noRetry = createGitHubClient({
        tier: 'node-https-token',
        token: 'tok',
        maxRetries: 2,
        sleep: async () => {},
        httpsRequest: async () => { calls += 1; return { ok: false, status, headers: status === 302 ? { location: 'https://evil.test' } : {}, data: { message: `http-${status}` } } },
      })
      const r = await noRetry.getIssue('a/b', 9)
      if (r.ok || calls !== 1) return `HTTP ${status} 禁止重试/禁止跟随重定向失败：calls=${calls}`
    }

    // 3. createPr 并发查重、mergePr sha/409/405/alreadyMerged、getCommitChecks unknown、postComment 去重、closeIssue 幂等
    const commentPosts = []
    let storedComments = []
    const idemClient = createGitHubClient({
      tier: 'node-https-token',
      token: 'tok',
      maxRetries: 0,
      httpsRequest: async (method, path, _t, body) => {
        if (method === 'POST' && path === '/repos/a/b/pulls') return { ok: false, status: 422, data: { message: 'A pull request already exists' } }
        if (method === 'GET' && path.startsWith('/repos/a/b/pulls?state=open')) return { ok: true, status: 200, data: [{ number: 77, html_url: 'https://github.com/a/b/pull/77', head: { ref: 'feat/x' }, base: { ref: 'main' }, state: 'open' }] }
        if (method === 'PUT' && path === '/repos/a/b/pulls/77/merge') {
          if (body?.sha === 'bad-sha') return { ok: false, status: 409, data: { message: 'head modified' } }
          if (body?.sha === 'blocked-sha') return { ok: false, status: 405, data: { message: 'blocked' } }
          return { ok: false, status: 504, data: { message: 'gateway timeout' } }
        }
        if (method === 'GET' && path === '/repos/a/b/pulls/77') {
          const isMerged = storedComments.length > 0 || path.endsWith('77')
          return { ok: true, status: 200, data: { number: 77, state: 'closed', merged: storedComments.length === 0 ? true : false, head: { sha: 'good-sha' }, base: { sha: 'b0' } } }
        }
        if (method === 'GET' && path.includes('/check-runs')) return { ok: true, status: 200, data: { check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }] } }
        if (method === 'GET' && path.includes('/status')) return { ok: false, status: 500, data: { message: 'status endpoint down' } }
        if (method === 'GET' && path.includes('/comments')) return { ok: true, status: 200, data: storedComments }
        if (method === 'POST' && path.includes('/comments')) {
          commentPosts.push(body.body)
          storedComments = [...storedComments, { id: commentPosts.length, body: body.body, html_url: 'u' }]
          return { ok: true, status: 201, data: { id: commentPosts.length, body: body.body, html_url: 'u' } }
        }
        if (method === 'GET' && path === '/repos/a/b/issues/10') return { ok: true, status: 200, data: { number: 10, state: 'closed', title: 't', labels: [] } }
        return { ok: false, status: 404, data: {} }
      },
    })
    const dupPr = await idemClient.createPr({ targetRepo: 'a/b', head: 'feat/x', base: 'main', title: 't', body: 'b' })
    if (!dupPr.ok || dupPr.number !== 77 || !dupPr.reusedConcurrentPr) return `createPr 并发查重失效：${JSON.stringify(dupPr)}`
    storedComments = [{ id: 99, body: 'seed' }] // 让上面 getPr 在 409/405 校验阶段返回 merged:false，在 alreadyMerged 阶段返回 merged:true
    const m409 = await idemClient.mergePr({ repo: 'a/b', number: 77, sha: 'bad-sha' })
    const m405 = await idemClient.mergePr({ repo: 'a/b', number: 77, sha: 'blocked-sha' })
    if (m409.ok || !m409.headMismatch || m405.ok || !m405.mergeBlocked) {
      return `mergePr 409/405 区分失败：m409=${JSON.stringify(m409)} m405=${JSON.stringify(m405)}`
    }
    storedComments = []
    const mAlready = await idemClient.mergePr({ repo: 'a/b', number: 77, sha: 'good-sha' })
    if (!mAlready.ok || !mAlready.alreadyMerged) return `mergePr alreadyMerged 续尾失败：${JSON.stringify(mAlready)}`

    const chkUnknown = await idemClient.getCommitChecks({ repo: 'a/b', ref: 'good-sha' })
    if (chkUnknown.bucket !== 'unknown' || !chkUnknown.warnings?.length) {
      return `status 接口失败时 getCommitChecks 仍假绿：${JSON.stringify(chkUnknown)}`
    }
    const clAlready = await idemClient.closeIssue({ repo: 'a/b', number: 10 })
    if (!clAlready.ok || !clAlready.alreadyClosed) return `closeIssue 已关闭未幂等返回 alreadyClosed：${JSON.stringify(clAlready)}`

    // postComment WriteBackFingerprint 跨实例去重
    const p1 = await idemClient.postComment({ repo: 'a/b', number: 5, body: '完成汇报', statePayload: { taskId: 't1', action: 'merged', round: 1 } })
    const secondClient = createGitHubClient({
      tier: 'node-https-token',
      token: 'tok',
      httpsRequest: async (method, path) => {
        if (method === 'GET' && path.includes('/comments')) return { ok: true, status: 200, data: storedComments }
        throw new Error(`重复评论不应再次 POST：${method} ${path}`)
      },
    })
    const p2 = await secondClient.postComment({ repo: 'a/b', number: 5, body: '完成汇报', statePayload: { taskId: 't1', action: 'merged', round: 1 } })
    if (!p1.ok || !p1.writeBackFingerprint || !p2.ok || !p2.deduplicated) {
      return `WriteBackFingerprint 评论去重失效：p1=${JSON.stringify(p1)} p2=${JSON.stringify(p2)}`
    }

    // 4. ledger 禁止从 merged 回退 unknown、GenericRemoteBackend 本地兼容追踪与 flow-merge 先评后关/alreadyMerged 续尾
    const ledgerDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
      'README.md': '# l\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(ledgerDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    gitSync(ledgerDir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    try {
      writeTaskLedger(ledgerDir, { taskId: 'm1', status: 'merged', prState: 'MERGED' })
      await updateTaskLedger(ledgerDir, 'm1', (cur) => ({ ...cur, status: 'unknown', prState: 'UNKNOWN' }))
      const reread = readTaskLedger(ledgerDir, 'm1')
      if (reread.status !== 'merged' || reread.prState !== 'MERGED') {
        return `ledger 违背单调性从 merged 回退：${JSON.stringify(reread)}`
      }
      const genBk = createTaskBackend({ role: 'generic-git', providerId: 'generic-git', mainRoot: ledgerDir })
      const gi = await genBk.createIssue({ title: '通用托管本地单', labels: ['bug'] })
      if (!gi.ok || gi.skipped || !gi.number) return `GenericRemoteBackend createIssue 仍静默 skipped：${JSON.stringify(gi)}`
      const mrBlock = await genBk.mergePr({ remoteMerged: false, humanApproved: false })
      if (mrBlock.ok || mrBlock.code !== 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED') return `GenericRemoteBackend.mergePr 护栏被破坏：${JSON.stringify(mrBlock)}`

      // flow-merge checks=unknown 阻断 & timeout -> getPr(merged=true) 幂等续尾先评后关 Issue
      const lRoots = await resolveRepoRoots(ledgerDir)
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = process.stderr.write.bind(process.stderr)
      process.stdout.write = () => true
      process.stderr.write = () => true
      try {
        const seqCalls = []
        const makeProbe = (checksBucket, mergeThrows) => ({
          env: { providerId: 'github', trackB: { tier: 'node-https-token', login: 'alice' } },
          client: {
            tier: 'node-https-token',
            async getCommitChecks() {
              return checksBucket === 'unknown'
                ? { ok: true, bucket: 'unknown', total: 1, passed: [], pending: [], failed: [], warnings: ['status-down'] }
                : { ok: true, bucket: 'pass', total: 1, passed: [{ name: 'ci' }], pending: [], failed: [], warnings: [] }
            },
            async mergePr() { if (mergeThrows) throw new Error('ETIMEDOUT'); return { ok: true, merged: true, state: 'MERGED' } },
            async getPr() { return { ok: true, number: 77, merged: true, state: 'MERGED' } },
            async postComment({ number }) { seqCalls.push(`comment:${number}`); return { ok: true, id: seqCalls.length, verifiedReadback: true } },
            async removeLabel({ number, label }) { seqCalls.push(`unlabel:${number}:${label}`); return { ok: true } },
            async closeIssue({ number }) { seqCalls.push(`close:${number}`); return { ok: true, state: 'CLOSED', alreadyClosed: false } },
          },
        })
        await handleStart({ task: 'm2', slug: 'm2', issue: '15', case: '3', implementer: 'alice', json: true, _ghClient: idemClient, _ghProbe: makeProbe('pass', false) }, lRoots)
        await seedExploredFor(ledgerDir, 'm2')
        const wtM2 = join(ledgerDir, '.worktrees/impl-m2')
        writeFileSync(join(wtM2, 'src/app.mjs'), 'export const ok = 2\n')
        gitSync(wtM2, ['add', 'src/app.mjs'])
        gitSync(wtM2, ['commit', '-qm', 'feat: m2'])
        await handleFinalize({ task: 'm2', 'no-tdd': true, json: true }, await resolveRepoRoots(wtM2))
        await handleVerify({ task: 'm2', mode: 'smoke', cmd: 'node -e "process.exit(0)"', json: true }, await resolveRepoRoots(wtM2))
        const m2 = readTaskLedger(ledgerDir, 'm2')
        m2.prNumber = 77
        writeTaskLedger(ledgerDir, m2)
        const tok = await issueTokenFor(ledgerDir, 'm2', 1)
        const revWtM2 = join(ledgerDir, '.worktrees/review-m2')
        gitSync(ledgerDir, ['worktree', 'add', '--detach', revWtM2, m2.verifiedHead])
        await handleReviewRecord({ task: 'm2', verdict: 'pass', 'reviewer-id': 'rev-m2', 'review-token': tok, evidence: 'ok', json: true }, await resolveRepoRoots(revWtM2))

        const blkUnknown = await handleMerge({ task: 'm2', json: true, _ghProbe: makeProbe('unknown', false), _ghClient: makeProbe('unknown', false).client }, lRoots)
        if (blkUnknown.exitCode !== 3) return `checks.bucket=unknown 未阻断 merge：${blkUnknown.exitCode}`
        const okAlready = await handleMerge({ task: 'm2', json: true, _ghProbe: makeProbe('pass', true), _ghClient: makeProbe('pass', true).client }, lRoots)
        if (okAlready.exitCode !== 0) return `mergePr 超时重跑 alreadyMerged 续尾失败：${okAlready.exitCode}`
        const cIdx = seqCalls.indexOf('comment:15')
        const xIdx = seqCalls.indexOf('close:15')
        if (cIdx === -1 || xIdx === -1 || cIdx > xIdx) return `merge 未按先评后关顺序执行：${JSON.stringify(seqCalls)}`
      } finally {
        process.stdout.write = origOut
        process.stderr.write = origErr
      }
      return true
    } finally {
      rmTree(ledgerDir)
    }
  }, 2000])

  cases.push(['C8：generic-git bare remote 未传 --remote-merged 阻断与传入 --remote-merged 放行并先评后关', async () => {
    const bareDir = tmpProject({})
    const workDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# bare-generic\n',
      'src/app.mjs': 'export const v = 1\n',
    })
    gitInitBare(bareDir)
    gitInit(workDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    gitSync(workDir, ['remote', 'add', 'origin', bareDir])
    gitSync(workDir, ['push', '-u', 'origin', 'main'])
    try {
      equip(workDir, { tier: 'full', noBackup: true })
      const roots = await resolveRepoRoots(workDir)
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = process.stderr.write.bind(process.stderr)
      process.stdout.write = () => true
      process.stderr.write = () => true
      try {
        const cr = await createLocalIssue({ mainRoot: workDir, title: '通用裸仓工单' })
        if (!cr.ok || cr.number !== 1) return `创建本地工单失败：${JSON.stringify(cr)}`
        const st = await handleStart({ task: 'bare-merge', issue: '1', slug: 'bare-merge', case: '3', implementer: 'alice', json: true }, roots)
        if (st.exitCode !== 0) return `generic-git bare start 失败：${st.exitCode}`
        const lg0 = readTaskLedger(workDir, 'bare-merge')
        if (!lg0 || lg0.providerId !== 'generic-git') return `bare remote 未判 providerId=generic-git：${JSON.stringify(lg0)}`
        await seedExploredFor(workDir, 'bare-merge')
        const wtAbs = join(workDir, lg0.worktreePath)
        writeFileSync(join(wtAbs, 'src/app.mjs'), 'export const v = 2\n')
        gitSync(wtAbs, ['add', 'src/app.mjs'])
        gitSync(wtAbs, ['commit', '-qm', 'feat: bare work'])
        await handleFinalize({ task: 'bare-merge', 'no-tdd': true, json: true }, await resolveRepoRoots(wtAbs))
        await handleVerify({ task: 'bare-merge', mode: 'smoke', cmd: 'node -e "process.exit(0)"', json: true }, await resolveRepoRoots(wtAbs))
        await handleSubmit({ task: 'bare-merge', agent: 'alice', json: true }, await resolveRepoRoots(wtAbs))
        const revTok = await issueTokenFor(workDir, 'bare-merge', 1)
        const revWt = join(workDir, lg0.reviewWorktreePath)
        const revCode = await handleReviewRecord({
          task: 'bare-merge', verdict: 'pass', 'reviewer-id': 'rev-bare', 'review-token': revTok, evidence: 'ok', json: true,
        }, await resolveRepoRoots(revWt))
        if (revCode !== 0) return `review record 失败：${revCode}`

        const blk = await handleMerge({ task: 'bare-merge', json: true }, roots)
        if (blk.exitCode !== 3 || blk.code !== 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED') {
          return `generic-git 未传 --remote-merged 未按 3 阻断：${JSON.stringify(blk)}`
        }
        const okMerge = await handleMerge({ task: 'bare-merge', 'remote-merged': true, json: true }, roots)
        if (okMerge.exitCode !== 0) return `generic-git 传入 --remote-merged 仍死锁：${JSON.stringify(okMerge)}`
        const lgAfter = readTaskLedger(workDir, 'bare-merge')
        const closedIss = getLocalIssue({ mainRoot: workDir, number: 1 })
        if (lgAfter.status !== 'merged' || closedIss.state !== 'CLOSED') {
          return `generic-git --remote-merged 后账本或本地单未闭环：status=${lgAfter.status}, state=${closedIss.state}`
        }
        return true
      } finally {
        process.stdout.write = origOut
        process.stderr.write = origErr
      }
    } finally {
      rmTree(workDir)
      rmTree(bareDir)
    }
  }, 4000])

  registerStageBLoopB4bCases(cases)
}
